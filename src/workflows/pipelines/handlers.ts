import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { z } from 'zod';
import { createAppContext, type AppContext } from '../../app/context.js';
import { openDatabase } from '../../database/db.js';
import { addDefaultHandler } from '../../jobs/handlers.js';
import { JobRegistry } from '../../jobs/registry.js';
import { JobRunner, enqueueAndRun, interruptedHolderHint, interruptedHolderText, requireJob, resumeJobCommand, type InterruptedLockHolder, type RunJobResult } from '../../jobs/runner.js';
import { AppError } from '../../core/errors.js';
import type { JobHandler } from '../../jobs/types.js';
import { describeLeaseHolder } from '../../jobs/manual-lease.js';
import { combineDegradedStages, stageOutputNotes, workflowJobHandler, workflowResultNote, type DegradedStageSummary } from '../../jobs/workflow-handler.js';
import { CheckpointStore } from '../checkpoints.js';
import { BASELINE_STAGE_ORDER, BASELINE_WORKFLOW, createBaselineStages } from './baseline.js';
import { createPipelineEnv, pipelineParamsSchema, type PipelineEnv, type PipelineParams } from './common.js';
import { CONTENT_QUEUE_LOCK, CONTENT_QUEUE_STAGE_ORDER, CONTENT_QUEUE_WORKFLOW, contentQueueParamsSchema, createContentQueueStages } from './content-queue.js';
import { MONTHLY_STAGE_ORDER, MONTHLY_WORKFLOW, createMonthlyStages } from './monthly.js';
import { WEEKLY_STAGE_ORDER, WEEKLY_WORKFLOW, createWeeklyStages } from './weekly.js';

/**
 * Durable job handlers for the pipelines, registered with the default job
 * registry (so `jobs resume <id>` and the scheduler can run them), plus the
 * foreground runner used by the `baseline` / `weekly` / `monthly` / `content
 * queue` commands. Every run holds the per-site lock (the content queue uses
 * its own "content" lock), checkpoints each stage, and resumes from the last
 * successful stage.
 */

export const PIPELINE_JOB_TYPES = {
  baseline: 'baseline',
  weekly: 'weekly',
  monthly: 'monthly',
  contentQueue: 'content.queue',
} as const;
export type PipelineJobType = (typeof PIPELINE_JOB_TYPES)[keyof typeof PIPELINE_JOB_TYPES];

export const PIPELINE_STAGE_ORDER: Record<PipelineJobType, readonly string[]> = {
  baseline: BASELINE_STAGE_ORDER,
  weekly: WEEKLY_STAGE_ORDER,
  monthly: MONTHLY_STAGE_ORDER,
  'content.queue': CONTENT_QUEUE_STAGE_ORDER,
};

const paramsSchema = pipelineParamsSchema as unknown as z.ZodType<PipelineParams>;

export function baselineJobHandler(env: PipelineEnv = createPipelineEnv()): JobHandler<PipelineParams> {
  return workflowJobHandler<PipelineParams>({
    type: PIPELINE_JOB_TYPES.baseline,
    description: 'Baseline: validate access, collect 90-day GSC/GA4 history, bounded crawl, reconcile URLs, check measurement, index memory, cost plan, baseline report + dashboard (no paid research, no experiments, nothing published)',
    workflow: BASELINE_WORKFLOW,
    paramsSchema,
    maxAttempts: 2,
    stages: (params, jctx) => createBaselineStages(env, jctx.app, params.approveCostPlanMicros !== undefined ? { approveCostPlanMicros: params.approveCostPlanMicros } : {}),
  });
}

export function weeklyJobHandler(env: PipelineEnv = createPipelineEnv()): JobHandler<PipelineParams> {
  return workflowJobHandler<PipelineParams>({
    type: PIPELINE_JOB_TYPES.weekly,
    description: 'Weekly: sync fresh complete data, validate joins, review experiments, route, shortlist, budgeted research (RESEARCH mode), deep competitor comparison of the top candidates, memory ingest + retrieval, one recommendation or no-action, internal links / potential orphans / page-level AEO checks for the report, report + dashboard, reconcile costs',
    workflow: WEEKLY_WORKFLOW,
    paramsSchema,
    maxAttempts: 2,
    stages: (_params, jctx) => createWeeklyStages(env, jctx.app),
  });
}

export function monthlyJobHandler(env: PipelineEnv = createPipelineEnv()): JobHandler<PipelineParams> {
  return workflowJobHandler<PipelineParams>({
    type: PIPELINE_JOB_TYPES.monthly,
    description: 'Monthly: organic + conversion review, experiments, content cohorts, competitor changes, AI visibility (optional), memory ingest, API usage, data quality, learnings; observed results kept apart from attribution assumptions',
    workflow: MONTHLY_WORKFLOW,
    paramsSchema,
    maxAttempts: 2,
    stages: (_params, jctx) => createMonthlyStages(env, jctx.app),
  });
}

type ContentQueueJobParams = z.infer<typeof contentQueueParamsSchema>;

export function contentQueueJobHandler(env: PipelineEnv = createPipelineEnv()): JobHandler<ContentQueueJobParams> {
  return workflowJobHandler<ContentQueueJobParams>({
    type: PIPELINE_JOB_TYPES.contentQueue,
    description: 'Content queue (features.contentDiscovery): memory ingest, resume Apify runs, discover -> dedupe -> classify -> cluster -> validate demand -> check existing -> prioritize, vault notes. Never drafts or publishes.',
    workflow: CONTENT_QUEUE_WORKFLOW,
    lockName: CONTENT_QUEUE_LOCK,
    paramsSchema: contentQueueParamsSchema as unknown as z.ZodType<ContentQueueJobParams>,
    maxAttempts: 2,
    stages: (params, jctx) => createContentQueueStages(env, jctx.app, { useModel: params.useModel, semantic: params.semantic }),
  });
}

export function pipelineHandler(type: PipelineJobType, env: PipelineEnv = createPipelineEnv()): JobHandler<any> {
  switch (type) {
    case 'baseline':
      return baselineJobHandler(env);
    case 'weekly':
      return weeklyJobHandler(env);
    case 'monthly':
      return monthlyJobHandler(env);
    case 'content.queue':
      return contentQueueJobHandler(env);
  }
}

let registered = false;

/** Register the pipeline job types with the default registry (idempotent). */
export function registerPipelineJobHandlers(env?: PipelineEnv): void {
  if (registered) return;
  registered = true;
  for (const type of Object.values(PIPELINE_JOB_TYPES)) addDefaultHandler(() => pipelineHandler(type, env ?? createPipelineEnv()));
}

// ---------------------------------------------------------------------------
// Foreground runs (CLI)
// ---------------------------------------------------------------------------

export interface PipelineRunOptions {
  env?: PipelineEnv;
  /** Continue an existing job from its last successful checkpoint instead of enqueueing a new one. */
  resumeJobId?: string;
  /** Explicit human decision to rerun paid stages interrupted mid-flight (after reconciliation). */
  rerunPaidStages?: boolean;
  signal?: AbortSignal;
  /** Runner overrides (tests). */
  runner?: { heartbeatMs?: number; leaseMs?: number };
}

export interface PipelineRunResult {
  jobId: string;
  type: string;
  outcome: RunJobResult['outcome'];
  jobStatus: string;
  /** Effective dry run: true when the run was a dry run, whatever the job row says. */
  dryRun: boolean;
  /** True when the run used a temporary copy of the database (dry run): nothing was written to the workspace. */
  scratchDatabase: boolean;
  mode: string;
  workflow: {
    status: string | null;
    stages: Array<{ stage: string; status: string; resumedFromCheckpoint: boolean; error?: { code: string; message: string } }>;
    degraded: Array<{ stage: string; code: string; reason: string }>;
    stoppedBy: { stage: string; status: string; reason: string } | null;
    failure: { stage: string; code: string; message: string } | null;
    warnings: string[];
  };
  /**
   * Every stage that did not do all of its work: skipped/failed per the
   * engine, or recorded as succeeded while its own output note says
   * skipped/degraded/offline. The same list `jobs list` / `jobs show` count.
   */
  degradedStages: DegradedStageSummary[];
  /** One-line honest note (degraded stages, counted from `degradedStages`); null for a complete run. */
  note: string | null;
  /** Error of the job when it did not succeed. */
  error: { code: string; message: string; hint?: string } | null;
  /** Latest checkpointed outputs of the stages most useful to the owner. */
  outputs: Record<string, unknown>;
}

const SUMMARY_STAGES = ['check_access', 'cost_plan', 'optional_ai', 'research', 'compare', 'index_memory', 'recommend', 'site_structure', 'report', 'reconcile_costs', 'prioritize', 'queue_gate', 'crawl_site', 'check_measurement', 'validate_joins', 'review_experiments'];

/**
 * The LOCKED error of a run that could not start. `holder` (JobRunner.interruptedLockHolder) is the
 * lock-holding job when its run appears interrupted: that run never finishes by itself, so the next
 * step is to resume or cancel it, never to wait for it.
 */
function lockedError(r: Extract<RunJobResult, { outcome: 'locked' }>, holder: InterruptedLockHolder | null = null): { code: string; message: string; hint?: string } {
  const job = r.job;
  // A freshly enqueued foreground job that could not start is closed as cancelled (enqueueAndRun):
  // its recorded error says so. A resumed job is left exactly as it was.
  if (job.status === 'cancelled' && job.error?.code === 'LOCKED') return { code: 'LOCKED', message: job.error.message, ...(job.error.hint ? { hint: job.error.hint } : {}) };
  const interrupted = holder && r.heldBy.jobId && holder.jobId === r.heldBy.jobId && holder.jobId !== job.id ? holder : null;
  const again = `\`${resumeJobCommand(job.id, job.mode)}\``;
  return {
    code: 'LOCKED',
    message: `The ${r.heldBy.lockName} lock of this site is held by ${describeLeaseHolder(r.heldBy)} (lease until ${r.heldBy.expiresAt})${interrupted ? `, whose run ${interruptedHolderText(interrupted)}` : ''}; runs never overlap. Job ${job.id} did not run and is unchanged (still ${job.status}).`,
    hint: interrupted
      ? interruptedHolderHint(interrupted, `then resume this job again: ${again}.`)
      : `Wait for that run to finish (check \`npm run cli -- jobs list\`), then resume it again: ${again}.`,
  };
}

/**
 * Summary of a pipeline run. `lockHolder` (optional): the lock-holding job when a `locked` run found
 * that job's run interrupted (JobRunner.interruptedLockHolder), for the LOCKED next step.
 */
export function summarizeRun(ctx: AppContext, r: RunJobResult, scratch: boolean, lockHolder: InterruptedLockHolder | null = null): PipelineRunResult {
  const job = r.job;
  const res = (job.result ?? null) as {
    status?: string;
    stages?: PipelineRunResult['workflow']['stages'];
    degraded?: PipelineRunResult['workflow']['degraded'];
    degradedStages?: DegradedStageSummary[];
    stoppedBy?: { stage: string; status: string; reason: string };
    failure?: { stage: string; code: string; message: string };
    warnings?: string[];
  } | null;
  const store = new CheckpointStore(ctx.db, ctx.clock);
  const outputs: Record<string, unknown> = {};
  for (const s of SUMMARY_STAGES) {
    const cp = store.latestWithOutput(ctx.siteId, job.id, s);
    if (cp) outputs[s] = cp.output;
  }
  const error =
    r.outcome === 'failed' || r.outcome === 'retry_scheduled' || r.outcome === 'interrupted'
      ? { code: r.error.code, message: r.error.message, ...(r.error.hint ? { hint: r.error.hint } : {}) }
      : r.outcome === 'locked'
        ? lockedError(r, lockHolder)
        : r.outcome === 'not_runnable' || r.outcome === 'waiting'
          ? { code: r.outcome === 'waiting' ? 'NEEDS_REVIEW' : 'NOT_RUNNABLE', message: r.reason }
          : job.error
            ? { code: job.error.code, message: job.error.message }
            : null;
  // The persisted combined list (all stage outputs of the run), merged with what the summarized outputs
  // say, so results stored by older versions (engine list only) are still counted honestly.
  const stages = res?.stages ?? [];
  const degraded = res?.degraded ?? [];
  const degradedStages = combineDegradedStages(stages, degraded, stageOutputNotes(outputs), Array.isArray(res?.degradedStages) ? res.degradedStages : []);
  return {
    jobId: job.id,
    type: job.type,
    outcome: r.outcome,
    jobStatus: job.status,
    dryRun: ctx.dryRun || job.dryRun,
    scratchDatabase: scratch,
    mode: job.mode,
    workflow: {
      status: res?.status ?? null,
      stages,
      degraded,
      stoppedBy: res?.stoppedBy ?? null,
      failure: res?.failure ?? null,
      warnings: res?.warnings ?? [],
    },
    degradedStages,
    note: res ? workflowResultNote({ ...res, degradedStages }) : workflowResultNote(job.result),
    error,
    outputs,
  };
}

/**
 * Dry runs execute the workflow against a temporary COPY of the database
 * (VACUUM INTO a scratch file that is deleted afterwards): the engine still
 * needs job and checkpoint rows, but the workspace database is never written.
 * Paid stages are skipped by the engine, vault and report writers run in
 * dry-run mode, and no network request is made by status checks.
 */
export async function withScratchDatabase<T>(ctx: AppContext, fn: (scratch: AppContext) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-dryrun-'));
  const file = path.join(dir, 'scratch.sqlite');
  try {
    ctx.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const db = openDatabase(file);
    try {
      const scratch = createAppContext({
        workspaceRoot: ctx.paths.root,
        siteId: ctx.siteId,
        config: ctx.config,
        secrets: ctx.secrets,
        db,
        clock: ctx.clock,
        logger: ctx.logger,
        fetch: ctx.fetch,
        mode: ctx.mode,
        dryRun: true,
        offline: ctx.offline,
        runId: ctx.runId,
      });
      return await fn(scratch);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `--dry-run` with `--resume <jobId>` is refused (VALIDATION_FAILED) before anything runs: resuming
 * continues a REAL job, whose remaining stages would run for real (paid stages included) against a
 * throwaway copy of the database, losing the charges, report rows, and lock with the copy.
 */
export function assertNoDryRunResume(ctx: Pick<AppContext, 'dryRun'>, type: PipelineJobType, resumeJobId: string | undefined): void {
  if (!ctx.dryRun || !resumeJobId) return;
  const command = type === 'content.queue' ? 'content queue' : type;
  throw new AppError('VALIDATION_FAILED', `--dry-run cannot be combined with --resume: job ${resumeJobId} is a real job, and resuming it runs its remaining stages for real. Nothing was run or changed.`, {
    hint: `Preview a new run with \`npm run cli -- ${command} --dry-run\`, or inspect the job with \`npm run cli -- jobs show ${resumeJobId}\` and resume it for real with \`npm run cli -- ${command} --resume ${resumeJobId}\`.`,
  });
}

/**
 * Enqueue and run a pipeline now (or resume one), in this process, as a durable job.
 *
 * - `--dry-run` with `--resume` is refused (VALIDATION_FAILED): resuming continues a REAL job,
 *   which must not run against a throwaway copy of the database (its charges, reports, and
 *   lock would be lost with the copy).
 * - A new job that cannot start because another run holds the lock is closed as cancelled
 *   (LOCKED) by enqueueAndRun: nothing is left queued for an unattended scheduler tick.
 */
export async function runPipeline(ctx: AppContext, type: PipelineJobType, params: Record<string, unknown> = {}, opts: PipelineRunOptions = {}): Promise<PipelineRunResult> {
  assertNoDryRunResume(ctx, type, opts.resumeJobId);
  const exec = async (c: AppContext, scratch: boolean): Promise<PipelineRunResult> => {
    const registry = new JobRegistry().register(pipelineHandler(type, opts.env ?? createPipelineEnv()));
    const runner = new JobRunner({ registry, maxMode: c.mode, ...(opts.runner?.heartbeatMs ? { heartbeatMs: opts.runner.heartbeatMs } : {}), ...(opts.runner?.leaseMs ? { leaseMs: opts.runner.leaseMs } : {}) });
    let r: RunJobResult;
    if (opts.resumeJobId) {
      const existing = requireJob(c.db, c.siteId, opts.resumeJobId);
      if (existing.type !== type) {
        throw new AppError('VALIDATION_FAILED', `Job ${existing.id} is a ${existing.type} job, not ${type}; nothing was changed.`, { hint: `Resume it with \`npm run cli -- jobs resume ${existing.id}\`.` });
      }
      const res = await runner.resume(c, opts.resumeJobId, { actor: 'cli', ...(opts.rerunPaidStages ? { rerunAmbiguousPaidStages: true } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
      r = res.results[0]!;
    } else {
      r = await enqueueAndRun(c, runner, type, params, { actor: 'cli', retryInline: false, ...(opts.signal ? { signal: opts.signal } : {}) });
    }
    if (runner.pendingLockHolds) await runner.settled();
    return summarizeRun(c, r, scratch, r.outcome === 'locked' ? runner.interruptedLockHolder(c, r.heldBy) : null);
  };
  if (ctx.dryRun) return withScratchDatabase(ctx, (scratch) => exec(scratch, true));
  return exec(ctx, false);
}
