import { z } from 'zod';
import type { AppContext } from '../../app/context.js';
import { NO_RETRY } from '../../core/retry.js';
import type { ContentDeps, ContentDepsSource } from '../../content/deps.js';
import { contentStageAllowances, createContentResearchStages, type ContentStageAllowances, type ModelUnavailableNote } from '../../content/stages.js';
import { resumeApifyRuns } from '../../integrations/apify/runs.js';
import { llmSignalClassifier } from '../../integrations/apify/normalize.js';
import { renderAll } from '../../obsidian/notes.js';
import { defineStage, type EngineStage } from '../stage.js';
import { indexMemoryStage, note, noteSchema, type PipelineEnv } from './common.js';

/**
 * CONTENT QUEUE (spec sections 20 and 27): an explicitly enabled, separate
 * discovery/research queue (features.contentDiscovery). It resumes pending
 * Apify runs (free GETs; no new paid actor run is started here), then runs
 * DISCOVER -> DEDUPLICATE -> CLASSIFY -> CLUSTER -> VALIDATE DEMAND -> CHECK
 * EXISTING CONTENT -> PRIORITIZE from the content module, and writes the
 * content notes to the vault. It never drafts or publishes: briefs and drafts
 * stay separate, approval-gated commands (`content brief`, `content draft`).
 * It runs under its own lock ("content") so it never blocks the weekly job.
 * Right after the enable gate, index_memory ingests new/changed records (and
 * deletions) into the full-text memory index (no paid call), so overlap checks
 * and brief evidence search current memory.
 */

export const CONTENT_QUEUE_WORKFLOW = 'content_queue';
export const CONTENT_QUEUE_LOCK = 'content';

/** Stage order of the content queue (the enable gate, memory ingestion, then the research stages). */
export const CONTENT_QUEUE_STAGE_ORDER = ['queue_gate', 'index_memory', 'apify_signals', 'discover', 'dedupe', 'classify', 'cluster', 'validate_demand', 'check_existing', 'prioritize', 'queue_notes'] as const;

export const contentQueueParamsSchema = z.object({
  trigger: z.string().max(40).optional(),
  scheduleId: z.string().max(100).optional(),
  scheduledFor: z.string().max(60).optional(),
  timezone: z.string().max(100).optional(),
  gscDays: z.number().int().min(1).max(486).default(28),
  maxGscQueries: z.number().int().min(1).max(5000).default(200),
  /** Allow the cheap model for ambiguous intent (spends within the stage allowances). Default false. */
  useModel: z.boolean().default(false),
  semantic: z.boolean().default(false),
});
export type ContentQueueParams = z.input<typeof contentQueueParamsSchema>;

/** Content dependencies from the concrete services of a (stage) context: full-text memory, never implicit embeddings. */
export function contentDepsFrom(env: PipelineEnv): ContentDepsSource {
  return (app: AppContext): ContentDeps => {
    const svc = env.services(app);
    return { llm: svc.llm, memory: svc.memory, approvals: svc.approvals, vault: svc.vault, proposals: null };
  };
}

function gateStage(): EngineStage {
  return defineStage({
    name: 'queue_gate',
    version: 'queue_gate@1',
    description: 'The content queue runs only when explicitly enabled (features.contentDiscovery).',
    input: z.object({ enabled: z.boolean() }),
    output: z.object({ enabled: z.boolean(), reason: z.string() }),
    prerequisites: [],
    evidence: { requirement: 'The site configuration feature flag.' },
    timeoutMs: 10_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    idempotent: true,
    stoppingConditions: ['features.contentDiscovery is off: no_action (nothing is discovered, drafted, or published).'],
    shouldStop: (o) => (o.enabled ? { stop: false } : { stop: true, status: 'no_action', reason: o.reason }),
    next: ['index_memory', 'no_action'],
    buildInput: (sctx) => ({ enabled: sctx.app.settings.features.contentDiscovery }),
    run: async (input) => ({ enabled: input.enabled, reason: input.enabled ? 'features.contentDiscovery is on' : 'The content discovery queue is disabled (features.contentDiscovery: false); enable it in the site config to run it.' }),
  });
}

function apifySignalsStage(env: PipelineEnv): EngineStage {
  return defineStage({
    name: 'apify_signals',
    version: 'apify_signals@1',
    description: 'Resume pending Apify runs (free polling, paginated dataset fetch, normalization; partial runs quarantined). No new paid run is started by the queue.',
    input: z.object({}),
    output: z.object({ status: z.string(), detail: z.string(), runs: z.number(), note: noteSchema }),
    prerequisites: ['queue_gate'],
    evidence: { requirement: 'apify_runs rows with persisted run ids.' },
    timeoutMs: 10 * 60_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    optional: true,
    providers: ['apify'],
    stoppingConditions: ['Offline, disabled, or missing token: recorded; discovery continues with other sources.'],
    next: ['discover'],
    buildInput: () => ({}),
    run: async (_input, sctx) => {
      const app = sctx.app;
      if (!app.settings.features.apify) return { status: 'disabled', detail: 'features.apify is off', runs: 0, note: null };
      const svc = env.services(app);
      const classifier = svc.llm.isConfigured('cheap') ? llmSignalClassifier(svc.llm, { siteId: app.siteId, runId: app.runId, promptId: 'research.reddit-signals' }) : undefined;
      // The classifier makes cheap-model calls only when a model is configured; this stage declares no LLM
      // allowance, so a paid classification is refused by the stage guard and heuristics are used instead.
      const r = await resumeApifyRuns(app, { ...(svc.apify.client ? { client: svc.apify.client } : {}), ...(classifier && svc.llm.synthetic ? { classifier } : {}) });
      return {
        status: r.status,
        detail: r.detail,
        runs: r.runs.length,
        note: r.status === 'ok' || r.status === 'disabled' ? null : note('skipped', `Apify runs not resumed: ${r.detail}`, r.status.toUpperCase(), r.nextStep ?? null),
      };
    },
  });
}

function queueNotesStage(env: PipelineEnv): EngineStage {
  return defineStage({
    name: 'queue_notes',
    version: 'queue_notes@1',
    description: 'Write the content opportunity and content-farm notes to the vault (generated regions only; human edits preserved). Nothing is drafted or published.',
    input: z.object({}),
    output: z.object({ status: z.string(), created: z.number(), updated: z.number(), unchanged: z.number(), conflicts: z.number(), errors: z.array(z.string()) }),
    prerequisites: ['prioritize'],
    evidence: { requirement: 'Content items stored by the research stages.' },
    timeoutMs: 120_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    optional: true,
    stoppingConditions: ['Final stage of the queue.'],
    next: ['done'],
    buildInput: () => ({}),
    run: async (_input, sctx) => {
      const writer = env.services(sctx.app).vault;
      if (!writer) return { status: 'disabled', created: 0, updated: 0, unchanged: 0, conflicts: 0, errors: [] };
      const s = renderAll(sctx.app, writer, { only: ['content'] });
      return { status: sctx.app.dryRun ? 'dry_run' : s.status, created: s.counts.created, updated: s.counts.updated, unchanged: s.counts.unchanged, conflicts: s.counts.conflict, errors: s.errors.slice(0, 5).map((e) => `${e.key}: ${e.error}`) };
    },
  });
}

/**
 * LLM allowances of the queue's research stages: declared only where a paid
 * call can actually happen in this run. Discovery searches full-text memory
 * (never paid); classification uses the cheap model only with --use-model and
 * a configured cheap model; clustering uses paid embeddings only with
 * --semantic and a configured embedding model. Anything else declares no
 * allowance, so an exhausted or $0 LLM budget never blocks the queue.
 */
export function contentQueueAllowances(env: PipelineEnv, app: AppContext, params: { useModel: boolean; semantic: boolean }): ContentStageAllowances {
  return contentQueueModelPlan(env, app, params).allowances;
}

export interface ContentQueueModelPlan {
  allowances: ContentStageAllowances;
  /**
   * Requested model use that cannot happen in this run, with the reason (the weekly intentHookPlan
   * pattern): --use-model (classify) or --semantic (cluster) with a dry run, features.llm or
   * features.embeddings off, no configured model, or a $0 share of the per-run LLM budget
   * (BUDGET_EXCEEDED). The stage then states it, and the job counts it as degraded, instead of
   * silently running rules only. An LLM budget exhausted at run time is handled by the engine.
   */
  unavailable: { classify: ModelUnavailableNote | null; cluster: ModelUnavailableNote | null };
}

/**
 * Model plan of the queue's research stages, decided when the stages are built: an allowance only
 * where a paid call can actually happen in this run, and for requested model use that cannot happen,
 * the reason.
 */
export function contentQueueModelPlan(env: PipelineEnv, app: AppContext, params: { useModel: boolean; semantic: boolean }): ContentQueueModelPlan {
  const all = contentStageAllowances(app.settings);
  const usable = !app.dryRun && app.settings.features.llm;
  const llm = usable && (params.useModel || params.semantic) ? env.services(app).llm : null;
  const raise = 'Raise budgets.llmGateway.perRun in the site config if you want the model here (never automatic); the queue does not depend on it.';
  const why = (requested: boolean, feature: { on: boolean; flag: string }, configured: boolean, what: string, modelHint: string, share: number): ModelUnavailableNote | null => {
    if (!requested) return null;
    if (app.dryRun) return { code: 'DRY_RUN', detail: `dry run: no paid ${what} call is made`, nextStep: 'Run without --dry-run to use the model.' };
    if (!app.settings.features.llm) return { code: 'INTEGRATION_DISABLED', detail: `features.llm is off, so no ${what} call is made`, nextStep: 'Set features.llm: true in the site config.' };
    if (!feature.on) return { code: 'INTEGRATION_DISABLED', detail: `${feature.flag} is off, so no ${what} call is made`, nextStep: `Set ${feature.flag}: true in the site config.` };
    if (!configured) return { code: 'CONFIG_MISSING', detail: `no ${what} model is configured`, nextStep: modelHint };
    if (share <= 0) return { code: 'BUDGET_EXCEEDED', detail: `budgets.llmGateway.perRun leaves no allowance for the ${what} (its share of the per-run LLM budget is $0)`, nextStep: raise };
    return null;
  };
  const classifyWhy = why(params.useModel, { on: true, flag: 'features.llm' }, !!llm && llm.isConfigured('cheap'), 'cheap-model intent classification', 'Set CHEAP_MODEL (or models.cheap) and LLM_GATEWAY_API_KEY in <workspace>/secrets/secrets.env.', all.classify);
  const clusterWhy = why(params.semantic, { on: app.settings.features.embeddings, flag: 'features.embeddings' }, !!llm && llm.isConfigured('embedding'), 'embedding (semantic clustering)', 'Set EMBEDDING_MODEL and LLM_GATEWAY_API_KEY in <workspace>/secrets/secrets.env.', all.cluster);
  const model = !!llm && params.useModel && llm.isConfigured('cheap');
  const embeddings = !!llm && params.semantic && app.settings.features.embeddings && llm.isConfigured('embedding');
  return {
    allowances: { ...all, discover: null, classify: model && !classifyWhy ? all.classify : null, cluster: embeddings && !clusterWhy ? all.cluster : null },
    unavailable: { classify: classifyWhy, cluster: clusterWhy },
  };
}

export function createContentQueueStages(env: PipelineEnv, app: AppContext, params: { useModel: boolean; semantic: boolean }): EngineStage[] {
  const plan = contentQueueModelPlan(env, app, params);
  const research = createContentResearchStages(contentDepsFrom(env), { allowances: plan.allowances, modelUnavailable: plan.unavailable, useModel: params.useModel, cluster: { semantic: params.semantic } }) as unknown as EngineStage[];
  const adjusted = research.map((s) =>
    s.name === 'prioritize'
      ? {
          ...s,
          next: ['queue_notes', 'no_action'],
          stoppingConditions: ['No selectable item (all deferred/rejected): no_action. A full production capacity does not stop the queue (it never drafts).'],
          shouldStop: (o: { topItemId?: string | null }) => (o.topItemId ? { stop: false as const } : { stop: true as const, status: 'no_action' as const, reason: 'No selectable content item: all candidates were deferred or rejected (reasons preserved).' }),
        }
      : s,
  );
  return [gateStage(), indexMemoryStage(env, 'apify_signals', ['queue_gate'], { optional: true }), apifySignalsStage(env), ...adjusted, queueNotesStage(env)];
}
