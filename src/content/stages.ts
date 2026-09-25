import { z } from 'zod';
import type { RuntimeSettings } from '../config/load.js';
import type { RuntimeMode } from '../core/modes.js';
import { DEFAULT_RETRY, NO_RETRY, type RetryPolicy } from '../core/retry.js';
import type { Micros } from '../core/money.js';
import { paidWorkSkippedReason, stageMayPay } from '../workflows/stage.js';
import type { CostAllowance, StageContext, StageDefinition } from '../workflows/types.js';
import { createBrief } from './brief.js';
import { classifyCandidates } from './classify.js';
import { clusterCandidates, type ClusterOptions } from './cluster.js';
import { dedupeSignals } from './dedup.js';
import { depsFor, type ContentDepsSource } from './deps.js';
import { validateDemand } from './demand.js';
import { DraftNeedsReviewError, generateDraft } from './draft.js';
import { checkExistingAndDecide } from './existing.js';
import { prioritizeItems } from './prioritize.js';
import { reviewWithRevisions } from './review.js';
import { discoverSignals, type DiscoverOptions } from './signals.js';
import { getItem, listItems, listSignals } from './store.js';
import {
  candidateSchema,
  catalogAttributeSchema,
  classificationSchema,
  classifyOutputSchema,
  clusterOutputSchema,
  demandOutputSchema,
  dedupeOutputSchema,
  discoverOutputSchema,
  existingOutputSchema,
  INTENTS,
  OPEN_RESEARCH_STAGES,
  prioritizeOutputSchema,
  type ClassifyOutput,
  type ClusterOutput,
  type ContentStage,
  type DedupeOutput,
  type DiscoverOutput,
  type Intent,
} from './types.js';

/**
 * Workflow stage definitions for the content pipeline (SEQUENTIAL pattern).
 * Each stage has validated input/output schemas, prerequisites, evidence
 * requirements, a timeout, a retry policy (paid calls are never retried),
 * a cost allowance, stopping conditions, and next valid states. Stage outputs
 * carry ids and computed summaries; the durable state lives in SQLite, so an
 * interrupted workflow resumes from the last successful checkpoint.
 */

export const CONTENT_WORKFLOW = 'content_pipeline';

/**
 * Optional engine extensions (structurally compatible with the workflow
 * engine's stage extensions): idempotent non-paid stages may be retried,
 * `requiredMode` gates a stage by runtime mode, `providers` names external
 * providers for circuit breakers.
 */
export type ContentStageDefinition<I = unknown, O = unknown> = StageDefinition<I, O> & { idempotent?: boolean; requiredMode?: RuntimeMode; providers?: string[]; optional?: boolean; optionalPrerequisites?: string[]; paidWorkOptional?: boolean };
export const CONTENT_STAGE_VERSION = 'content-stages@1';

const IDEMPOTENT_RETRY: RetryPolicy = { ...DEFAULT_RETRY, maxAttempts: 2 };

/** Per-stage LLM cost allowances as fractions of the configured per-run LLM budget (never hardcoded amounts). */
export function contentStageAllowances(settings: Pick<RuntimeSettings, 'budgets'>): Record<'discover' | 'classify' | 'cluster' | 'brief' | 'draft' | 'review', Micros> {
  const perRun = settings.budgets.llmGateway.perRun;
  const frac = (f: number) => Math.floor(perRun * f);
  return { discover: frac(0.05), classify: frac(0.1), cluster: frac(0.1), brief: frac(0.3), draft: frac(0.4), review: frac(0.2) };
}

/**
 * Per-stage LLM allowances. For the research stages (discover, classify,
 * cluster) a null, missing, or $0 entry means the stage can make no paid call
 * in this run: it declares no allowance and no LLM provider, so an exhausted
 * or $0 LLM budget (or an open LLM circuit breaker) never blocks it.
 */
export type ContentStageAllowances = { [K in keyof ReturnType<typeof contentStageAllowances>]: Micros } | ({ [K in 'discover' | 'classify' | 'cluster']?: Micros | null } & { [K in 'brief' | 'draft' | 'review']: Micros });

/** Why requested model use of a research stage cannot happen in this run (decided when the stages are built). */
export interface ModelUnavailableNote {
  /** Engine-style code, e.g. BUDGET_EXCEEDED (a $0 share of the per-run LLM budget), CONFIG_MISSING, INTEGRATION_DISABLED, DRY_RUN. */
  code: string;
  detail: string;
  nextStep: string | null;
}

export interface ContentStageOptions {
  discover?: DiscoverOptions;
  cluster?: ClusterOptions;
  /** Use models where configured (default true). */
  useModel?: boolean;
  /** LLM cost allowances per stage (use contentStageAllowances(ctx.settings)). */
  allowances: ContentStageAllowances;
  /**
   * Requested model use (classify: --use-model; cluster: --semantic) that cannot happen in this run, with
   * the reason. The stage then reports "skipped: <CODE>: <detail>" in its model status (never a silent
   * rules-only run); the job summary counts it as degraded.
   */
  modelUnavailable?: { classify?: ModelUnavailableNote | null; cluster?: ModelUnavailableNote | null };
}

/**
 * The model use of the research stages is optional (rules, lexical clustering,
 * and full-text memory work without it): a research stage declares an LLM
 * allowance only when it has a positive one, and the engine runs it without
 * its paid work when the LLM budget is exhausted (`paidWorkOptional`).
 */
function researchLlm(maxMicros: Micros | null | undefined): { costAllowance: CostAllowance[] | 'none'; providers?: string[]; paidWorkOptional?: boolean } {
  return typeof maxMicros === 'number' && maxMicros > 0 ? { costAllowance: [{ provider: 'llm_gateway', maxMicros }], providers: ['llm_gateway'], paidWorkOptional: true } : { costAllowance: 'none' };
}

/**
 * Status text for a model step skipped because the stage holds no LLM allowance in this attempt: the
 * engine dropped it (budget exhausted at run time, provider unavailable), or the stage was built without
 * one for a stated reason (`unavailable`, e.g. a $0 share of the per-run LLM budget).
 */
function noAllowanceStatus(sctx: StageContext, unavailable?: ModelUnavailableNote | null): string {
  const dropped = paidWorkSkippedReason(sctx);
  if (dropped) return `skipped: ${dropped.code === 'BUDGET_EXCEEDED' ? 'LLM budget exhausted' : 'LLM provider unavailable'} (${dropped.reason}); rules only`;
  if (unavailable) return `skipped: ${unavailable.code}: ${unavailable.detail.replace(/\.$/, '')}${unavailable.nextStep ? ` (next step: ${unavailable.nextStep.replace(/\.$/, '')})` : ''}`;
  return 'skipped: no LLM allowance for this stage in this run';
}

const discoverInput = z.object({
  gscDays: z.number().int().min(1).max(486).default(28),
  maxGscQueries: z.number().int().min(1).max(5000).default(200),
  includeSynthetic: z.boolean().nullable().default(null),
});
const dedupeInput = z.object({ signalIds: z.array(z.string()) });
const classifyInput = z.object({ candidates: z.array(candidateSchema) });
const clusterInput = z.object({ candidates: z.array(candidateSchema), classifications: z.array(classificationSchema) });
const sourceStatusSchema = z.array(z.object({ origin: z.string(), status: z.enum(['collected', 'empty', 'unavailable', 'disabled', 'skipped']), detail: z.string() }));
const demandInput = z.object({
  itemIds: z.array(z.string()),
  sandboxExcluded: z.number().int().min(0),
  sourceStatus: sourceStatusSchema.default([]),
  classificationByItem: z.record(z.string(), z.object({ intents: z.array(z.string()), sources: z.array(z.string()), rationale: z.array(z.string()), formatHints: z.array(z.string()) })),
});
const itemsInput = z.object({ itemIds: z.array(z.string()) });

/**
 * Items that discovery may re-evaluate: open research stages, plus items
 * rejected by the decision RULES (new evidence may change a rule outcome).
 * Items rejected by a quality gate, a bootstrap/human decision, or later
 * stages are never re-decided automatically.
 */
function openItemIds(sctx: StageContext, fromCluster: string[]): string[] {
  const stages: ContentStage[] = [...OPEN_RESEARCH_STAGES, 'rejected'];
  const ids = new Set(fromCluster);
  return listItems(sctx.app.db, sctx.app.siteId, { stages })
    .filter((i) => ids.has(i.id))
    .filter((i) => i.stage !== 'rejected' || (/^\[content-decision@\d+\]/.test(i.decisionReason ?? '') && !(i.decisionReason ?? '').includes('[quality gate]')))
    .filter((i) => !(i.decisionReason ?? '').startsWith('[bootstrap]'))
    .map((i) => i.id);
}

/**
 * `deps` may be a provider: the durable engine then builds dependencies from
 * each stage's context, so the LLM client reserves budget through the stage's
 * guarded budget service (enforcing the stage cost allowance) with the job id
 * as run id.
 */
export function createContentResearchStages(deps: ContentDepsSource, opts: ContentStageOptions): ContentStageDefinition[] {
  const discover: ContentStageDefinition<z.infer<typeof discoverInput>, DiscoverOutput> = {
    name: 'discover',
    ...researchLlm(opts.allowances.discover),
    version: CONTENT_STAGE_VERSION,
    description: 'Collect content signals (GSC queries, approved non-sandbox DataForSEO research, Apify questions, competitor gaps, business knowledge, manual imports).',
    input: discoverInput,
    output: discoverOutputSchema,
    prerequisites: [],
    evidence: { requirement: 'Every signal records origin, collection window, limitations, and examples; sandbox research is excluded; Reddit engagement is never search volume.' },
    timeoutMs: 120_000,
    retry: NO_RETRY,
    stoppingConditions: ['No eligible signals: nothing to research (no_action).'],
    shouldStop: (o) => (o.signalIds.length ? { stop: false } : { stop: true, status: 'no_action', reason: 'No content signals discovered. Import customer questions or sync Search Console first.' }),
    next: ['dedupe', 'no_action'],
    buildInput: (_ctx, params) => discoverInput.parse({ gscDays: params.gscDays, maxGscQueries: params.maxGscQueries, includeSynthetic: params.includeSynthetic ?? null }),
    run: async (input, sctx) => {
      const d = await depsFor(deps, sctx.app);
      const res = await discoverSignals(sctx.app, d.memory, {
        ...opts.discover,
        gscDays: input.gscDays,
        maxGscQueries: input.maxGscQueries,
        ...(input.includeSynthetic !== null ? { includeSynthetic: input.includeSynthetic } : {}),
      });
      const { signals: _signals, ...out } = res;
      void _signals;
      return out;
    },
  };

  const dedupe: ContentStageDefinition<z.infer<typeof dedupeInput>, DedupeOutput> = {
    name: 'dedupe',
    idempotent: true,
    version: CONTENT_STAGE_VERSION,
    description: 'Normalized-hash and near-duplicate merge of signals into candidates.',
    input: dedupeInput,
    output: dedupeOutputSchema,
    prerequisites: ['discover'],
    evidence: { requirement: 'Signal ids from discovery.', check: (i) => (i.signalIds.length ? [] : ['No signal ids to deduplicate.']) },
    timeoutMs: 30_000,
    retry: IDEMPOTENT_RETRY,
    costAllowance: 'none',
    stoppingConditions: ['No candidates remain after deduplication.'],
    shouldStop: (o) => (o.candidates.length ? { stop: false } : { stop: true, status: 'no_action', reason: 'No candidates after deduplication.' }),
    next: ['classify', 'no_action'],
    buildInput: (sctx) => ({ signalIds: (sctx.prior.discover as DiscoverOutput).signalIds }),
    run: async (input, sctx) => dedupeSignals(listSignals(sctx.app.db, sctx.app.siteId, { ids: input.signalIds })),
  };

  const classify: ContentStageDefinition<z.infer<typeof classifyInput>, ClassifyOutput> = {
    name: 'classify',
    ...researchLlm(opts.allowances.classify),
    version: CONTENT_STAGE_VERSION,
    description: 'Deterministic intent rules; cheap model only for ambiguous candidates (ROUTER pattern).',
    input: classifyInput,
    output: classifyOutputSchema,
    prerequisites: ['dedupe'],
    evidence: { requirement: 'Candidates with supporting signal ids; candidate text is passed to models only as untrusted evidence.' },
    timeoutMs: 300_000,
    retry: NO_RETRY,
    stoppingConditions: ['Never stops: unresolved intents become "unsure" and are deferred later.', 'No LLM allowance in this run (none declared, or the LLM budget is exhausted): rules only, never blocked.'],
    next: ['cluster'],
    buildInput: (sctx) => ({ candidates: (sctx.prior.dedupe as DedupeOutput).candidates }),
    run: async (input, sctx) => {
      const known = new Map<string, Intent>();
      for (const c of input.candidates) {
        if (!c.existingItemId) continue;
        const item = getItem(sctx.app.db, sctx.app.siteId, c.existingItemId);
        if (item?.intent && (INTENTS as readonly string[]).includes(item.intent)) known.set(c.key, item.intent);
      }
      // The cheap model is used only with an allowance in this attempt (the engine drops it when the LLM budget is exhausted).
      const mayPay = stageMayPay(sctx, 'llm_gateway');
      const out = await classifyCandidates(sctx.app, (await depsFor(deps, sctx.app)).llm, input.candidates, { knownIntents: known, ...(opts.useModel === false || !mayPay ? { useModel: false } : {}) });
      return opts.useModel !== false && !mayPay && out.modelStatus === 'skipped: model disabled for this run' ? { ...out, modelStatus: noAllowanceStatus(sctx, opts.modelUnavailable?.classify) } : out;
    },
  };

  const cluster: ContentStageDefinition<z.infer<typeof clusterInput>, ClusterOutput> = {
    name: 'cluster',
    ...researchLlm(opts.allowances.cluster),
    version: CONTENT_STAGE_VERSION,
    description: 'Cluster by intent + lexical similarity (+ embeddings when enabled, + SERP overlap when snapshots exist); one item per cluster, not per keyword.',
    input: clusterInput,
    output: clusterOutputSchema,
    prerequisites: ['classify'],
    evidence: {
      requirement: 'A classification for every candidate.',
      check: (i) => {
        const keys = new Set(i.classifications.map((c) => c.key));
        const missing = i.candidates.filter((c) => !keys.has(c.key));
        return missing.length ? [`${missing.length} candidate(s) lack a classification.`] : [];
      },
    },
    timeoutMs: 300_000,
    retry: NO_RETRY,
    stoppingConditions: ['No clusters produced (no_action).', 'No LLM allowance in this run: lexical (and SERP-overlap) clustering only, never blocked.'],
    shouldStop: (o) => (o.clusters.length ? { stop: false } : { stop: true, status: 'no_action', reason: 'No clusters produced.' }),
    next: ['validate_demand', 'no_action'],
    buildInput: (sctx) => {
      const c = sctx.prior.classify as ClassifyOutput;
      return { candidates: c.candidates, classifications: c.classifications };
    },
    run: async (input, sctx) => {
      // Embeddings cost money: requested semantic clustering runs only with an allowance in this attempt.
      const semantic = !!opts.cluster?.semantic;
      const mayPay = stageMayPay(sctx, 'llm_gateway');
      const out = await clusterCandidates(sctx.app, (await depsFor(deps, sctx.app)).llm, input.candidates, input.classifications, { ...(opts.cluster ?? {}), ...(semantic && !mayPay ? { semantic: false } : {}) });
      return semantic && !mayPay ? { ...out, semanticStatus: noAllowanceStatus(sctx, opts.modelUnavailable?.cluster) } : out;
    },
  };

  const validate: ContentStageDefinition<z.infer<typeof demandInput>, z.infer<typeof demandOutputSchema>> = {
    name: 'validate_demand',
    idempotent: true,
    version: CONTENT_STAGE_VERSION,
    description: 'Aggregate labeled demand evidence per item (observed first-party, estimates, engagement, questions); missing is never zero.',
    input: demandInput,
    output: demandOutputSchema,
    prerequisites: ['cluster'],
    // classify: per-item classification; discover: sandbox counts and per-source collection status.
    optionalPrerequisites: ['discover', 'classify'],
    evidence: { requirement: 'Items with linked signals.' },
    timeoutMs: 60_000,
    retry: IDEMPOTENT_RETRY,
    costAllowance: 'none',
    stoppingConditions: ['Never stops: weak/unvalidated demand leads to a defer decision downstream.'],
    next: ['check_existing'],
    buildInput: (sctx) => {
      const cl = sctx.prior.cluster as ClusterOutput;
      const cls = sctx.prior.classify as ClassifyOutput | undefined;
      const disc = sctx.prior.discover as DiscoverOutput | undefined;
      const byKey = new Map((cls?.classifications ?? []).map((c) => [c.key, c]));
      const classificationByItem: Record<string, { intents: string[]; sources: string[]; rationale: string[]; formatHints: string[] }> = {};
      for (const c of cl.clusters) {
        const entry = (classificationByItem[c.itemId] ??= { intents: [], sources: [], rationale: [], formatHints: [] });
        for (const k of c.memberKeys) {
          const x = byKey.get(k);
          if (!x) continue;
          entry.intents.push(x.intent);
          entry.sources.push(x.source);
          entry.rationale.push(x.rationale);
          for (const h of x.formatHints) if (!entry.formatHints.includes(h)) entry.formatHints.push(h);
        }
      }
      return {
        itemIds: openItemIds(sctx, cl.itemIds),
        sandboxExcluded: (disc?.excluded.sandboxKeywordMetrics ?? 0) + (disc?.excluded.sandboxSerpSnapshots ?? 0),
        sourceStatus: disc?.sourceStatus ?? [],
        classificationByItem,
      };
    },
    run: async (input, sctx) => {
      const items = listItems(sctx.app.db, sctx.app.siteId, { ids: input.itemIds });
      const res = validateDemand(sctx.app, items, { sandboxExcluded: input.sandboxExcluded, classificationByItem: new Map(Object.entries(input.classificationByItem)), ...(input.sourceStatus.length ? { sourceStatus: input.sourceStatus } : {}) });
      return { itemIds: input.itemIds, ...res };
    },
  };

  const checkExisting: ContentStageDefinition<z.infer<typeof itemsInput>, z.infer<typeof existingOutputSchema>> = {
    name: 'check_existing',
    idempotent: true,
    version: CONTENT_STAGE_VERSION,
    description: 'Compare with existing pages (crawl + GSC) and decide improve_existing / add_section / create_tool / create_template / create_page / defer / reject with a preserved reason.',
    input: itemsInput,
    output: existingOutputSchema,
    prerequisites: ['validate_demand'],
    evidence: {
      requirement: 'Demand evidence recorded for each item.',
      check: (i, sctx) => {
        const missing = listItems(sctx.app.db, sctx.app.siteId, { ids: i.itemIds }).filter((x) => !x.demand);
        return missing.length ? [`${missing.length} item(s) lack demand evidence.`] : [];
      },
    },
    timeoutMs: 120_000,
    retry: IDEMPOTENT_RETRY,
    costAllowance: 'none',
    stoppingConditions: ['Never stops: an unavailable existing-content check produces a defer decision.'],
    next: ['prioritize'],
    buildInput: (sctx) => ({ itemIds: (sctx.prior.validate_demand as z.infer<typeof demandOutputSchema>).itemIds }),
    run: async (input, sctx) => {
      const items = listItems(sctx.app.db, sctx.app.siteId, { ids: input.itemIds });
      const r = checkExistingAndDecide(sctx.app, items);
      return { itemIds: input.itemIds, decisions: r.decisions, existingCheckStatus: r.status };
    },
  };

  const prioritize: ContentStageDefinition<z.infer<typeof itemsInput>, z.infer<typeof prioritizeOutputSchema>> = {
    name: 'prioritize',
    idempotent: true,
    version: CONTENT_STAGE_VERSION,
    description: 'Interpretable scoring; one item in production at a time by default.',
    input: itemsInput,
    output: prioritizeOutputSchema,
    prerequisites: ['check_existing'],
    evidence: { requirement: 'Decisions recorded for each item.' },
    timeoutMs: 30_000,
    retry: IDEMPOTENT_RETRY,
    costAllowance: 'none',
    stoppingConditions: ['No selectable item (all deferred/rejected): no_action.', 'Production capacity is full: completed_early (brief later).'],
    shouldStop: (o) =>
      !o.topItemId
        ? { stop: true, status: 'no_action', reason: 'No selectable content item: all candidates were deferred or rejected (reasons preserved).' }
        : o.capacity.available <= 0
          ? { stop: true, status: 'completed_early', reason: `Production capacity full (${o.capacity.inProduction}/${o.capacity.maxInProduction}).` }
          : { stop: false },
    next: ['brief', 'done', 'no_action', 'completed_early'],
    buildInput: (sctx) => ({ itemIds: (sctx.prior.check_existing as z.infer<typeof existingOutputSchema>).itemIds }),
    run: async (input, sctx) => prioritizeItems(sctx.app, listItems(sctx.app.db, sctx.app.siteId, { ids: input.itemIds })),
  };

  return [discover, dedupe, classify, cluster, validate, checkExisting, prioritize] as ContentStageDefinition[];
}

// ---------------------------------------------------------------------------
// Item-scoped production stages: brief -> draft -> quality_review
// ---------------------------------------------------------------------------

export const PRODUCTION_STAGE_NAMES = ['brief', 'draft', 'quality_review'] as const;
export type ProductionStageName = (typeof PRODUCTION_STAGE_NAMES)[number];

const programmaticSchema = z.object({ isProgrammatic: z.boolean(), templateId: z.string().nullable(), differentiatingData: z.array(z.object({ field: z.string(), value: z.string(), evidenceIds: z.array(z.string()) })) });
const briefInput = z.object({
  itemId: z.string().min(1),
  useModel: z.boolean().default(true),
  requestApproval: z.boolean().default(true),
  force: z.boolean().default(false),
  catalogAttributes: z.array(catalogAttributeSchema).max(200).nullable().default(null),
  programmatic: programmaticSchema.nullable().default(null),
});
const briefOutput = z.object({
  itemId: z.string(),
  briefId: z.string().nullable(),
  version: z.number().int().nullable(),
  gatePassed: z.boolean(),
  contentHash: z.string(),
  reused: z.boolean(),
  approvalRequestId: z.string().nullable(),
  approvalStatus: z.enum(['approved', 'pending', 'already_executed', 'rejected', 'requested', 'not_requested', 'none']).nullable(),
  issues: z.array(z.string()),
  modelStatus: z.string(),
});
/** Batch authorization passed to the draft stage (verified again inside generateDraft; never trusted as given). */
const batchAuthSchema = z.object({
  approvalId: z.string(),
  subjectId: z.string(),
  artifactHash: z.string(),
  hashInput: z.object({ siteId: z.string(), briefs: z.array(z.object({ itemId: z.string(), briefId: z.string(), briefHash: z.string() })) }).passthrough(),
  capacityReserved: z.boolean(),
});
const draftInput = z.object({ itemId: z.string().min(1), batch: batchAuthSchema.nullable().default(null) });
/** Stored for the human reviewer when the writer's output needs review (call id + bounded, redacted raw output). */
const modelReviewSchema = z.object({ status: z.literal('needs_review'), reason: z.string(), callId: z.string().nullable(), lastRawOutput: z.string().nullable(), rawOutputTruncated: z.boolean() });
const draftOutput = z.object({
  draftId: z.string().nullable(),
  version: z.number().int().nullable(),
  briefId: z.string().nullable(),
  briefHash: z.string().nullable(),
  unresolvedFacts: z.number().int().min(0),
  approvalConsumed: z.string().nullable(),
  modelReview: modelReviewSchema.nullable().default(null),
});
const reviewInput = z.object({ draftId: z.string().min(1).nullable(), useModel: z.boolean().nullable().default(null), revise: z.boolean().default(true) });
const reviewOutput = z.object({
  finalDraftId: z.string().nullable(),
  verdict: z.enum(['pass', 'needs_revision', 'needs_human_review', 'reject']).nullable(),
  revisions: z.number().int().min(0).max(2),
  reasons: z.array(z.string()),
  humanReviewRequired: z.literal(true),
  modelReview: modelReviewSchema.nullable().default(null),
});

export interface ContentProductionStageOptions extends ContentStageOptions {
  /**
   * Stage subset (in pipeline order). Default: all three. `content brief` runs ['brief'],
   * `content draft` ['draft', 'quality_review'], `content review` ['quality_review']: the
   * same durable path as `content produce` (checkpoints, per-stage allowances, resume).
   */
  stages?: readonly ProductionStageName[];
}

function modelReviewReason(where: string, r: z.infer<typeof modelReviewSchema>): string {
  return `${where}: the model output failed validation after the controlled repair attempts (${r.reason}). The call id${r.callId ? ` (${r.callId})` : ''} and the last raw output${r.rawOutputTruncated ? ' (truncated)' : ''} are stored in this checkpoint for the human reviewer; the draft approval was not used. After reviewing, either continue with \`jobs resume <job-id> --reviewed ${where} --reviewer "<your name>"\` (${where === 'draft' ? 'ends this job without a draft' : 'keeps the current draft and its latest verdict'}) or start a new \`content produce <item-id>\` run to try again.`;
}

export function createContentProductionStages(deps: ContentDepsSource, opts: ContentProductionStageOptions): ContentStageDefinition[] {
  const subset = new Set<ProductionStageName>(opts.stages?.length ? opts.stages : PRODUCTION_STAGE_NAMES);
  const withDraft = subset.has('draft');
  const brief: ContentStageDefinition<z.infer<typeof briefInput>, z.infer<typeof briefOutput>> = {
    name: 'brief',
    providers: ['llm_gateway'],
    version: CONTENT_STAGE_VERSION,
    description: 'Build the brief (deterministic + optional reasoning-model synthesis) and run the deterministic brief gate; request the draft approval on pass.',
    input: briefInput,
    output: briefOutput,
    prerequisites: [],
    evidence: {
      requirement: 'An item with an actionable decision and stored evidence; numbers computed in code.',
      check: (i, sctx) => {
        const item = getItem(sctx.app.db, sctx.app.siteId, i.itemId);
        if (!item) return [`Item ${i.itemId} not found.`];
        if (!item.decision || item.decision === 'defer' || item.decision === 'reject') return [`Item decision is ${item.decision ?? 'none'}.`];
        return [];
      },
    },
    timeoutMs: 600_000,
    retry: NO_RETRY,
    costAllowance: [{ provider: 'llm_gateway', maxMicros: opts.allowances.brief }],
    stoppingConditions: [
      'Brief gate failed: blocked until the missing fields/evidence are fixed (only when a draft stage follows).',
      'Gate passed but no valid draft_generation approval bound to this brief hash: needs_review (a human approves the pending request, then the workflow is resumed; an unchanged brief is reused, so the approval stays bound). Only when a draft stage follows.',
    ],
    // A brief-only run (`content brief`) ends after the brief: the gate result and the approval request are its output.
    shouldStop: (o) =>
      !withDraft
        ? { stop: false }
        : !o.gatePassed
          ? { stop: true, status: 'blocked', reason: `Brief gate failed: ${o.issues.join('; ')}` }
          : o.approvalStatus !== 'approved'
            ? {
                stop: true,
                status: 'needs_review',
                reason:
                  o.approvalStatus === 'already_executed'
                    ? `The draft approval for brief ${o.briefId} was already used for a draft; review that draft, or change the brief and request a new approval.`
                    : o.approvalStatus === 'rejected'
                      ? `A human rejected drafting brief ${o.briefId}; change the brief (content brief --force) before requesting again.`
                      : `Awaiting a human draft_generation approval for brief ${o.briefId} (hash ${o.contentHash.slice(0, 12)})${o.approvalRequestId ? `: npm run cli -- approvals approve ${o.approvalRequestId}` : ''}.`,
              }
            : { stop: false },
    next: withDraft ? ['draft', 'blocked', 'needs_review'] : ['done'],
    buildInput: (_s, params) => {
      const b = (params.brief ?? {}) as Record<string, unknown>;
      return briefInput.parse({
        itemId: params.itemId,
        useModel: typeof params.useModel === 'boolean' ? params.useModel : (opts.useModel ?? true),
        requestApproval: b.requestApproval ?? true,
        force: b.force ?? false,
        catalogAttributes: b.catalogAttributes ?? null,
        programmatic: b.programmatic ?? null,
      });
    },
    run: async (input, sctx) => {
      const r = await createBrief(sctx.app, await depsFor(deps, sctx.app), input.itemId, {
        useModel: input.useModel,
        requestApproval: input.requestApproval,
        force: input.force,
        ...(input.catalogAttributes ? { catalogAttributes: input.catalogAttributes } : {}),
        ...(input.programmatic ? { programmatic: input.programmatic } : {}),
      });
      return {
        itemId: input.itemId,
        briefId: r.record?.id ?? null,
        version: r.record?.version ?? null,
        gatePassed: r.gate.passed,
        contentHash: r.contentHash,
        reused: r.reused,
        approvalRequestId: r.approvalRequest?.id ?? null,
        approvalStatus: r.approvalStatus,
        issues: r.gate.issues.filter((i) => i.severity === 'error').map((i) => `${i.code}: ${i.message}`),
        modelStatus: r.modelStatus,
      };
    },
  };

  const draft: ContentStageDefinition<z.infer<typeof draftInput>, z.infer<typeof draftOutput>> = {
    name: 'draft',
    providers: ['llm_gateway'],
    requiredMode: 'DRAFT',
    version: CONTENT_STAGE_VERSION,
    description: 'Generate the draft package ONLY after brief gate pass, a draft_generation approval bound to the brief hash (or a verified batch approval), DRAFT mode, and free capacity.',
    input: draftInput,
    output: draftOutput,
    prerequisites: subset.has('brief') ? ['brief'] : [],
    evidence: { requirement: 'Gate-passed brief whose hash matches the approval; product facts and approved claims supplied as owner evidence.' },
    timeoutMs: 900_000,
    retry: NO_RETRY,
    costAllowance: [{ provider: 'llm_gateway', maxMicros: opts.allowances.draft }],
    stoppingConditions: [
      'Refused (approval missing, wrong mode, gate not passed, capacity full): the stage fails with an actionable reason and no draft.',
      'The model output failed validation after the controlled repair attempts: needs_review (call id and raw output stored for the reviewer; the approval is not consumed).',
    ],
    shouldStop: (o) => (o.modelReview ? { stop: true, status: 'needs_review', reason: modelReviewReason('draft', o.modelReview) } : { stop: false }),
    next: subset.has('quality_review') ? ['quality_review', 'blocked', 'needs_review'] : ['done', 'blocked', 'needs_review'],
    buildInput: (sctx, params) => ({ itemId: String(params.itemId ?? (sctx.prior.brief as { itemId?: string } | undefined)?.itemId ?? ''), batch: (params.batch as z.infer<typeof batchAuthSchema> | undefined) ?? null }),
    run: async (input, sctx) => {
      try {
        const r = await generateDraft(sctx.app, await depsFor(deps, sctx.app), input.itemId, input.batch ? { batch: input.batch } : {});
        return { draftId: r.draft.id, version: r.draft.version, briefId: r.draft.briefId, briefHash: r.draft.briefHash, unresolvedFacts: r.draft.unresolvedFacts, approvalConsumed: r.approvalConsumed?.id ?? null, modelReview: null };
      } catch (err) {
        // Spec §9: after at most two controlled repairs the task goes to review, not to a provider failure.
        if (err instanceof DraftNeedsReviewError) return { draftId: null, version: null, briefId: null, briefHash: null, unresolvedFacts: 0, approvalConsumed: null, modelReview: err.review };
        throw err;
      }
    },
  };

  const review: ContentStageDefinition<z.infer<typeof reviewInput>, z.infer<typeof reviewOutput>> = {
    name: 'quality_review',
    providers: ['llm_gateway'],
    version: CONTENT_STAGE_VERSION,
    description: 'Deterministic quality gates on every draft + bounded AI review; at most 2 automated revision loops; human review always required.',
    input: reviewInput,
    output: reviewOutput,
    prerequisites: withDraft ? ['draft'] : [],
    evidence: { requirement: 'Draft package with its brief hash and source ledger.' },
    timeoutMs: 900_000,
    retry: NO_RETRY,
    costAllowance: [{ provider: 'llm_gateway', maxMicros: opts.allowances.review }],
    stoppingConditions: [
      'No draft exists (the draft step sent the model output to human review): no_action.',
      'A revision\'s model output failed validation after the controlled repairs: needs_review.',
      'Verdict reject: blocked.',
      'Otherwise stops at human review (needs_review); publication needs a publish_content approval.',
    ],
    shouldStop: (o) =>
      !o.finalDraftId
        ? { stop: true, status: 'no_action', reason: 'No draft to review: the draft step produced no draft (its model output was sent to human review).' }
        : o.modelReview
          ? { stop: true, status: 'needs_review', reason: modelReviewReason('quality_review', o.modelReview) }
          : o.verdict === 'reject'
            ? { stop: true, status: 'blocked', reason: `Draft rejected: ${o.reasons.slice(0, 3).join('; ')}` }
            : { stop: true, status: 'needs_review', reason: 'Human review is required before any publication.' },
    next: ['needs_review', 'blocked', 'done', 'no_action'],
    buildInput: (sctx, params) => {
      const r = (params.review ?? {}) as { useModel?: boolean | null; revise?: boolean };
      const fromDraft = (sctx.prior.draft as z.infer<typeof draftOutput> | undefined)?.draftId ?? null;
      const draftId = withDraft ? fromDraft : typeof params.draftId === 'string' ? params.draftId : fromDraft;
      return { draftId, useModel: typeof r.useModel === 'boolean' ? r.useModel : null, revise: r.revise ?? true };
    },
    run: async (input, sctx) => {
      if (!input.draftId) return { finalDraftId: null, verdict: null, revisions: 0, reasons: [], humanReviewRequired: true as const, modelReview: null };
      const r = await reviewWithRevisions(sctx.app, await depsFor(deps, sctx.app), input.draftId, { revise: input.revise, ...(input.useModel !== null ? { useModel: input.useModel } : {}) });
      const final = r.reviews[r.reviews.length - 1]!;
      return {
        finalDraftId: r.drafts[r.drafts.length - 1]?.id ?? input.draftId,
        verdict: final.verdict,
        revisions: r.drafts.length,
        reasons: final.reasons.map((x) => `${x.code}: ${x.message}`).slice(0, 50),
        humanReviewRequired: true as const,
        modelReview: r.modelReview ?? null,
      };
    },
  };
  const all: Record<ProductionStageName, ContentStageDefinition> = { brief: brief as ContentStageDefinition, draft: draft as ContentStageDefinition, quality_review: review as ContentStageDefinition };
  return PRODUCTION_STAGE_NAMES.filter((n) => subset.has(n)).map((n) => all[n]);
}
