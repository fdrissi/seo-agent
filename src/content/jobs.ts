import { z } from 'zod';
import type { AppContext } from '../app/context.js';
import { addDefaultHandler } from '../jobs/handlers.js';
import { JobRegistry } from '../jobs/registry.js';
import { enqueueAndRun, JobRunner, type RunJobResult } from '../jobs/runner.js';
import type { JobHandler } from '../jobs/types.js';
import { workflowJobHandler } from '../jobs/workflow-handler.js';
import { NO_RETRY } from '../core/retry.js';
import { CheckpointStore } from '../workflows/checkpoints.js';
import { runBatchDrafts } from './batch.js';
import { depsFor, resolveContentDeps, type ContentDepsSource } from './deps.js';
import { CONTENT_STAGE_VERSION, CONTENT_WORKFLOW, contentStageAllowances, createContentProductionStages, createContentResearchStages, PRODUCTION_STAGE_NAMES, type ContentStageDefinition } from './stages.js';
import { catalogAttributeSchema } from './types.js';

/**
 * Content workflows as DURABLE jobs (src/workflows/engine.ts via the job
 * runner): every stage result is checkpointed, an interrupted run resumes
 * from the last successful stage (`jobs resume <id>`), and each stage's LLM
 * cost allowance is enforced because dependencies are built from the stage's
 * context (its budget service is the engine's per-stage guard).
 *
 * The research workflow uses its own lock ("content") so an optional content
 * discovery never blocks the site's scheduled pipelines.
 */

export const CONTENT_RESEARCH_JOB = 'content.research';
export const CONTENT_PRODUCTION_JOB = 'content.production';
export const CONTENT_PRODUCTION_WORKFLOW = 'content_production';
export const CONTENT_BATCH_JOB = 'content.batch';
export const CONTENT_BATCH_WORKFLOW = 'content_batch';

const researchParams = z.object({
  gscDays: z.number().int().min(1).max(486).default(28),
  maxGscQueries: z.number().int().min(1).max(5000).default(200),
  includeSynthetic: z.boolean().nullable().default(null),
  useModel: z.boolean().default(false),
  semantic: z.boolean().default(false),
});
export type ContentResearchParams = z.input<typeof researchParams>;

const productionParams = z
  .object({
    itemId: z.string().min(1).optional(),
    /** Review-only runs (`content review <draft-id>`) name the draft instead of the item. */
    draftId: z.string().min(1).optional(),
    useModel: z.boolean().default(false),
    /** Stage subset (default: brief, draft, quality_review). */
    stages: z.array(z.enum(PRODUCTION_STAGE_NAMES)).min(1).optional(),
    brief: z
      .object({
        requestApproval: z.boolean().optional(),
        force: z.boolean().optional(),
        catalogAttributes: z.array(catalogAttributeSchema).max(200).optional(),
        programmatic: z.object({ isProgrammatic: z.boolean(), templateId: z.string().nullable(), differentiatingData: z.array(z.object({ field: z.string(), value: z.string(), evidenceIds: z.array(z.string()) })) }).optional(),
      })
      .optional(),
    review: z.object({ useModel: z.boolean().nullable().optional(), revise: z.boolean().optional() }).optional(),
  })
  .refine((p) => !!p.itemId || !!p.draftId, { message: 'itemId (or draftId for a review-only run) is required' })
  .refine((p) => !!p.itemId || (p.stages?.length === 1 && p.stages[0] === 'quality_review'), { message: 'itemId is required unless the run is review-only (stages: ["quality_review"])' });
export type ContentProductionParams = z.input<typeof productionParams>;

const batchParams = z.object({ itemIds: z.array(z.string().min(1)).min(1).max(200), workers: z.number().int().min(1).max(3).default(3), requestedBy: z.string().min(1).default('seo-agent') });
export type ContentBatchParams = z.input<typeof batchParams>;

/** Default dependency source for jobs: built per stage from the stage's context. */
const defaultSource: ContentDepsSource = async (app) => (await resolveContentDeps(app)).deps;

export function contentResearchJobHandler(source: ContentDepsSource = defaultSource): JobHandler<z.infer<typeof researchParams>> {
  return workflowJobHandler({
    type: CONTENT_RESEARCH_JOB,
    description: 'Content research: discover -> dedupe -> classify -> cluster -> validate demand -> check existing -> prioritize',
    workflow: CONTENT_WORKFLOW,
    lockName: 'content',
    maxAttempts: 2,
    paramsSchema: researchParams as unknown as z.ZodType<z.infer<typeof researchParams>>,
    stages: (params, jctx) =>
      createContentResearchStages(source, {
        allowances: contentStageAllowances(jctx.app.settings),
        useModel: params.useModel,
        cluster: { semantic: params.semantic },
      }),
  });
}

export function contentProductionJobHandler(source: ContentDepsSource = defaultSource): JobHandler<z.infer<typeof productionParams>> {
  return workflowJobHandler({
    type: CONTENT_PRODUCTION_JOB,
    description: 'Content production for one item: brief (reused when unchanged) -> draft (needs DRAFT mode + human approval) -> quality review',
    workflow: CONTENT_PRODUCTION_WORKFLOW,
    lockName: 'content',
    maxAttempts: 1,
    paramsSchema: productionParams as unknown as z.ZodType<z.infer<typeof productionParams>>,
    stages: (params, jctx) => createContentProductionStages(source, { allowances: contentStageAllowances(jctx.app.settings), useModel: params.useModel, ...(params.stages ? { stages: params.stages } : {}) }),
  });
}

const batchOutput = z.object({
  status: z.enum(['refused', 'pilot_complete', 'completed', 'halted_after_pilot']),
  reason: z.string(),
  batchKey: z.string(),
  artifactHash: z.string(),
  approvalRequest: z.object({ id: z.string(), status: z.string() }).passthrough().nullable(),
  items: z.array(z.object({ itemId: z.string(), status: z.enum(['drafted', 'failed', 'skipped']), draftId: z.string().optional(), verdict: z.enum(['pass', 'needs_revision', 'needs_human_review', 'reject']).optional(), revisions: z.number().optional(), error: z.string().optional(), phase: z.enum(['pilot', 'expansion']) })),
  pilot: z.object({ size: z.number().int(), passed: z.boolean().nullable() }),
  phase: z.enum(['pilot', 'expansion']).nullable(),
  workers: z.number().int(),
});

/**
 * Batch drafting (pilot, then human-reviewed expansion) as ONE durable paid
 * stage: the whole batch runs under the job's run id and cost allowance (the
 * per-run LLM cap), is checkpointed, and an interruption mid-batch is never
 * blindly re-run (the engine requires reconciliation of the in-flight paid
 * stage first). The batch's own approvals and pilot gate are unchanged.
 */
export function contentBatchJobHandler(source: ContentDepsSource = defaultSource): JobHandler<z.infer<typeof batchParams>> {
  return workflowJobHandler({
    type: CONTENT_BATCH_JOB,
    description: 'Content batch drafts: approved pilot (up to 3, bounded parallel) -> human review -> approved expansion; deterministic checks on every item',
    workflow: CONTENT_BATCH_WORKFLOW,
    lockName: 'content',
    maxAttempts: 1,
    paramsSchema: batchParams as unknown as z.ZodType<z.infer<typeof batchParams>>,
    stages: (_params, jctx) => {
      const stage: ContentStageDefinition<z.infer<typeof batchParams>, z.infer<typeof batchOutput>> = {
        name: 'batch',
        providers: ['llm_gateway'],
        version: CONTENT_STAGE_VERSION,
        description: 'Run the approved batch phase (pilot or expansion) with bounded parallel drafting and quality review.',
        input: batchParams as unknown as z.ZodType<z.infer<typeof batchParams>>,
        output: batchOutput,
        prerequisites: [],
        evidence: { requirement: 'Gate-passed briefs for every item and an approved batch_expansion request bound to exactly those briefs.' },
        timeoutMs: 3_600_000,
        retry: NO_RETRY,
        costAllowance: [{ provider: 'llm_gateway', maxMicros: jctx.app.settings.budgets.llmGateway.perRun }],
        stoppingConditions: ['Never stops: a refusal or a completed pilot is the batch result (see its status and reason).'],
        next: ['done'],
        buildInput: (_s, params) => batchParams.parse(params),
        run: async (input, sctx) => (await runBatchDrafts(sctx.app, await depsFor(source, sctx.app), { itemIds: input.itemIds, workers: input.workers, requestedBy: input.requestedBy })) as z.infer<typeof batchOutput>,
      };
      return [stage as ContentStageDefinition];
    },
  });
}

let defaultsRegistered = false;

/** Register the content job types with the default registry (so `jobs resume <id>` can continue them). Idempotent. */
export function registerContentJobHandlers(): void {
  if (defaultsRegistered) return;
  defaultsRegistered = true;
  addDefaultHandler(() => contentResearchJobHandler());
  addDefaultHandler(() => contentProductionJobHandler());
  addDefaultHandler(() => contentBatchJobHandler());
}

export interface ContentJobRun {
  jobId: string;
  outcome: RunJobResult['outcome'];
  /** Workflow status from the engine summary ('succeeded' | 'stopped' | 'failed' | 'cancelled'), or null when the job did not run. */
  workflowStatus: string | null;
  stages: Array<{ stage: string; status: string; resumedFromCheckpoint: boolean; error?: { code: string; message: string }; stop?: { status: string; reason: string } }>;
  stoppedBy: { stage: string; status: string; reason: string } | null;
  failure: { stage: string; code: string; message: string } | null;
  note: string | null;
  /** Latest checkpointed output per stage (for rendering). */
  outputs: Record<string, unknown>;
}

function summarize(ctx: AppContext, r: RunJobResult, stageNames: string[]): ContentJobRun {
  const result = (r.job.result ?? null) as {
    status?: string;
    stages?: ContentJobRun['stages'];
    stoppedBy?: { stage: string; status: string; reason: string };
    failure?: { stage: string; code: string; message: string };
  } | null;
  const store = new CheckpointStore(ctx.db, ctx.clock);
  const outputs: Record<string, unknown> = {};
  for (const s of stageNames) {
    const cp = store.latestWithOutput(ctx.siteId, r.job.id, s);
    if (cp) outputs[s] = cp.output;
  }
  const note =
    r.outcome === 'waiting' || r.outcome === 'not_runnable'
      ? r.reason
      : r.outcome === 'failed' || r.outcome === 'retry_scheduled' || r.outcome === 'interrupted'
        ? `${r.error.code}: ${r.error.message}`
        : r.outcome === 'locked'
          ? `Another content job holds the lock (${r.heldBy.owner ?? 'unknown owner'}).`
          : null;
  return {
    jobId: r.job.id,
    outcome: r.outcome,
    workflowStatus: result?.status ?? null,
    stages: result?.stages ?? [],
    stoppedBy: result?.stoppedBy ?? null,
    failure: result?.failure ?? null,
    note,
    outputs,
  };
}

/** Enqueue and run the research workflow now, in this process, as a durable job. */
export async function runContentResearchJob(ctx: AppContext, params: ContentResearchParams = {}, source: ContentDepsSource = defaultSource): Promise<ContentJobRun> {
  const registry = new JobRegistry().register(contentResearchJobHandler(source));
  const runner = new JobRunner({ registry, maxMode: ctx.mode });
  const r = await enqueueAndRun(ctx, runner, CONTENT_RESEARCH_JOB, params as Record<string, unknown>, { actor: 'cli', retryInline: false });
  return summarize(ctx, r, ['discover', 'dedupe', 'classify', 'cluster', 'validate_demand', 'check_existing', 'prioritize']);
}

/**
 * Enqueue and run the production workflow for one item as a durable job.
 * `params.stages` selects a subset (the `content brief/draft/review` commands
 * use this); every run is checkpointed, resumable, and allowance-enforced.
 */
export async function runContentProductionJob(ctx: AppContext, params: ContentProductionParams, source: ContentDepsSource = defaultSource, opts: { signal?: AbortSignal } = {}): Promise<ContentJobRun> {
  const registry = new JobRegistry().register(contentProductionJobHandler(source));
  const runner = new JobRunner({ registry, maxMode: ctx.mode });
  const r = await enqueueAndRun(ctx, runner, CONTENT_PRODUCTION_JOB, params as Record<string, unknown>, { actor: 'cli', retryInline: false, ...(opts.signal ? { signal: opts.signal } : {}) });
  return summarize(ctx, r, [...PRODUCTION_STAGE_NAMES]);
}

/** Enqueue and run a batch (pilot or expansion) as a durable job. */
export async function runContentBatchJob(ctx: AppContext, params: ContentBatchParams, source: ContentDepsSource = defaultSource, opts: { signal?: AbortSignal } = {}): Promise<ContentJobRun> {
  const registry = new JobRegistry().register(contentBatchJobHandler(source));
  const runner = new JobRunner({ registry, maxMode: ctx.mode });
  const r = await enqueueAndRun(ctx, runner, CONTENT_BATCH_JOB, params as Record<string, unknown>, { actor: 'cli', retryInline: false, ...(opts.signal ? { signal: opts.signal } : {}) });
  return summarize(ctx, r, ['batch']);
}
