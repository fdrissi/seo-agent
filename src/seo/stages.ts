import { z } from 'zod';
import type { AppContext } from '../app/context.js';
import { AppError } from '../core/errors.js';
import { NO_RETRY } from '../core/retry.js';
import { dateInZone } from '../core/time.js';
import type { MemoryRetriever } from '../memory/types.js';
import type { IntentClassifierHook } from '../router/intent.js';
import { ROUTES, type RouteDecision } from '../router/types.js';
import { paidWorkSkippedReason, stageMayPay } from '../workflows/stage.js';
import type { CostAllowance, StageContext, StageDefinition } from '../workflows/types.js';
import { prepareSiteAnalysis, routeAllPages } from './page-analysis.js';
import { UrlReconciler } from './reconcile.js';
import { assembleRecommendation, candidateFromAnalysis, DEFAULT_PRIOR_MEMORY_QUERY, loadPriorContext, persistRecommendationSet, type CandidateOpportunity, type ComparisonForRecommendation } from './recommend.js';

/**
 * Workflow stage definitions for this slice (for the weekly/baseline
 * pipelines): reconcile_urls -> route_and_score -> recommend.
 * Dependencies that may cost money (the optional model intent hook) or reach
 * other services (memory retrieval) are injected by the caller.
 *
 * Dry runs never write: reconciliation runs inside a rolled-back transaction,
 * routing does not persist, and the recommendation is assembled from the
 * current run's in-memory candidates without being saved.
 */

interface SeoStageOptionsBase {
  memory?: MemoryRetriever;
  days?: number;
  /**
   * Why the optional cheap-model intent hook is NOT attached in this run
   * although a model is configured (for example an exhausted LLM budget,
   * decided when the stages were built). Recorded as a route_and_score note.
   */
  intentHookUnavailable?: { code: string; detail: string; nextStep?: string | null };
}

/** Stage note carried in route/recommend outputs (same shape as the pipelines' stage notes). */
const stageNoteSchema = z
  .object({ status: z.enum(['succeeded', 'degraded', 'skipped']), code: z.string().nullable(), detail: z.string(), nextStep: z.string().nullable() })
  .nullable()
  .optional();
type StageNote = NonNullable<z.infer<typeof stageNoteSchema>>;

/** One note from several (degraded wins over skipped; details are joined). */
function mergeNotes(notes: StageNote[]): StageNote | null {
  if (!notes.length) return null;
  const degraded = notes.filter((n) => n.status === 'degraded');
  const lead = degraded[0] ?? notes[0]!;
  return { status: lead.status, code: lead.code, detail: notes.map((n) => n.detail).join(' '), nextStep: notes.map((n) => n.nextStep).find((x) => !!x) ?? null };
}

/** The report period fixed by an earlier `plan_period` stage (weekly/monthly pipelines), when present. */
const planPeriodSchema = z.object({ start: z.string(), end: z.string(), explicit: z.boolean().optional(), latestCompleteDate: z.string().nullable().optional() });
function planPeriodOf(sctx: StageContext): z.infer<typeof planPeriodSchema> | null {
  const r = planPeriodSchema.safeParse((sctx.prior.plan_period as { period?: unknown } | undefined)?.period);
  return r.success ? r.data : null;
}

/**
 * Options. An intent hook may call a paid model, so it requires a non-empty
 * cost allowance (the workflow engine rejects an empty list and the stage
 * budget guard needs a positive cap for the LLM reservations).
 */
export type SeoStageOptions =
  | (SeoStageOptionsBase & { intentHook?: undefined; intentCostAllowance?: undefined })
  | (SeoStageOptionsBase & {
      /** Build the optional cheap-model intent hook for this run (return undefined to stay rule-only). */
      intentHook: (app: AppContext) => IntentClassifierHook | undefined;
      /** Declared LLM allowance for the route stage (required with an intent hook; non-empty). */
      intentCostAllowance: CostAllowance[];
    });

const reconcileOutput = z.object({
  dryRun: z.boolean(),
  pagesCreated: z.number(),
  aliasesWritten: z.number(),
  unresolved: z.number(),
  redirectsEstablished: z.number(),
  canonicalsEstablished: z.number(),
});

const reasonSchema = z.object({ code: z.string(), detail: z.string(), data: z.record(z.string(), z.unknown()).optional() });
const candidateSchema = z.object({
  id: z.string().nullable(),
  route: z.enum(ROUTES),
  pageId: z.string().nullable(),
  url: z.string().nullable(),
  query: z.string().nullable(),
  isBranded: z.boolean().nullable(),
  score: z.number().nullable(),
  scoringVersion: z.string().nullable(),
  rawCounts: z.record(z.string(), z.unknown()),
  evidenceQuality: z.number().nullable(),
  reasons: z.array(reasonSchema),
  isProtected: z.boolean(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  synthetic: z.boolean().optional(),
});

const routeInput = z.object({
  days: z.number().int().min(1).max(480),
  end: z.string().nullable(),
  /** The report period of this run (plan_period), when the pipeline has one: routing never ends after it. */
  reportPeriod: z.object({ start: z.string(), end: z.string(), explicit: z.boolean() }).nullable().optional(),
});
const routeOutput = z.object({
  dryRun: z.boolean(),
  period: z.object({ start: z.string(), end: z.string() }),
  siteDecision: z.unknown().nullable(),
  siteDecisionId: z.string().nullable(),
  counts: z.record(z.string(), z.number()),
  persisted: z.array(z.object({ pageId: z.string(), routeDecisionId: z.string(), opportunityId: z.string().nullable() })),
  /** Scored opportunities of THIS run (the only candidates the recommend stage considers). */
  candidates: z.array(candidateSchema),
  merged: z.array(z.object({ pageId: z.string(), url: z.string(), mergedInto: z.string() })),
  synthetic: z.boolean(),
  intentHookStatus: z.array(z.string()),
  /**
   * Why route decisions and the recommendation of this run are not saved
   * (an explicit historical report period), else null/absent.
   */
  notPersistedReason: z.string().nullable().optional(),
  note: stageNoteSchema,
});
/** One deep SERP/competitor comparison as passed from the weekly `compare` stage to `recommend`. */
export const comparisonForRecommendationSchema = z.object({
  id: z.string().nullable(),
  query: z.string(),
  pageId: z.string().nullable(),
  url: z.string(),
  opportunityId: z.string().nullable(),
  competitorsCompared: z.number(),
  competitorsInaccessible: z.number(),
  ourAdvantages: z.array(z.string()),
  gaps: z.array(z.string()),
  caveats: z.array(z.string()),
  synthesis: z.object({
    status: z.enum(['ok', 'skipped', 'failed']),
    reason: z.string().nullable(),
    summary: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    promptVersion: z.string().nullable().optional(),
  }),
  serp: z.object({ snapshotId: z.string().nullable(), collectedAt: z.string().nullable(), locationCode: z.number().nullable(), languageCode: z.string().nullable(), device: z.string().nullable() }).nullable(),
  fetchedAt: z.string().nullable().optional(),
  synthetic: z.boolean(),
});

/** Comparisons carried in an earlier stage's output (`{ comparisons: [...] }`), or [] when absent/invalid. */
export function comparisonsFromPrior(prior: unknown): ComparisonForRecommendation[] {
  const list = (prior as { comparisons?: unknown } | undefined)?.comparisons;
  if (!Array.isArray(list)) return [];
  const out: ComparisonForRecommendation[] = [];
  for (const c of list) {
    const r = comparisonForRecommendationSchema.safeParse(c);
    if (r.success) out.push(r.data);
  }
  return out;
}

/**
 * Memory query for the prior-context search: the default history terms plus
 * the queries and URL paths of this run's best candidates (so business notes
 * and earlier proposals about the same pages and topics rank first).
 */
export function priorMemoryQuery(candidates: readonly CandidateOpportunity[], max = 5): string {
  const top = [...candidates].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, max);
  const terms: string[] = [];
  for (const c of top) {
    if (c.query) terms.push(c.query);
    if (c.url) {
      try {
        terms.push(decodeURIComponent(new URL(c.url).pathname).replace(/[/_.-]+/g, ' ').trim());
      } catch {
        // not a URL: skipped
      }
    }
  }
  return [DEFAULT_PRIOR_MEMORY_QUERY, ...terms.filter(Boolean)].join(' ').replace(/\s+/g, ' ').slice(0, 300).trim();
}

const recommendInput = routeOutput.extend({ comparisons: z.array(comparisonForRecommendationSchema).optional() });
const recommendOutput = z.object({ primaryId: z.string(), secondaryIds: z.array(z.string()), kind: z.string(), title: z.string(), excluded: z.number(), saved: z.boolean(), note: stageNoteSchema });

/** primaryId of a recommendation assembled for an explicit historical period (never saved). */
export const HISTORICAL_PERIOD_PRIMARY_ID = 'historical-period';

export function createSeoStages(opts: SeoStageOptions = {}): [StageDefinition<Record<string, never>, z.infer<typeof reconcileOutput>>, StageDefinition<z.infer<typeof routeInput>, z.infer<typeof routeOutput>>, StageDefinition<z.infer<typeof recommendInput>, z.infer<typeof recommendOutput>>] {
  if (opts.intentHook && (!Array.isArray(opts.intentCostAllowance) || opts.intentCostAllowance.length === 0)) {
    throw new AppError('VALIDATION_FAILED', 'createSeoStages: an intent hook calls a paid model and needs a non-empty intentCostAllowance (provider + maxMicros cap).', {
      hint: 'Pass intentCostAllowance: [{ provider: <LLM budget provider>, maxMicros: <cap> }], or omit intentHook to stay rule-only.',
    });
  }
  const reconcile: StageDefinition<Record<string, never>, z.infer<typeof reconcileOutput>> = {
    name: 'reconcile_urls',
    version: 'reconcile_urls@2',
    description: 'Reconcile raw GSC/GA4/crawl URLs to page identities with alias evidence; resolve page ids on metric rows (dry run: rolled back).',
    input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
    output: reconcileOutput,
    prerequisites: [],
    evidence: { requirement: 'Ingested Search Console/GA4 rows and/or an own-site crawl.' },
    timeoutMs: 120_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    stoppingConditions: ['never stops the workflow; unresolved rows are reported'],
    next: ['route_and_score'],
    buildInput: () => ({}) as Record<string, never>,
    run: async (_input, sctx) => {
      const app = sctx.app;
      const r = new UrlReconciler(app.db, app.siteId, app.config, app.clock).run({ dryRun: app.dryRun });
      return { dryRun: app.dryRun, pagesCreated: r.pagesCreated, aliasesWritten: r.aliasesWritten, unresolved: r.unresolved.length, redirectsEstablished: r.redirects.established, canonicalsEstablished: r.canonicals.established };
    },
  };

  const route: StageDefinition<z.infer<typeof routeInput>, z.infer<typeof routeOutput>> = {
    name: 'route_and_score',
    version: 'route_and_score@3',
    description: 'Deterministic routing of every page with reason codes, then interpretable opportunity scoring. The window ends at the report period end (never after the latest date complete in Search Console and GA4); an explicit historical period is routed but not saved.',
    input: routeInput,
    output: routeOutput,
    prerequisites: ['reconcile_urls'],
    evidence: { requirement: 'Reconciled page identities; complete, final GSC/GA4 dates for the window (otherwise pages route to INVALID_OR_INCOMPLETE_DATA).' },
    timeoutMs: 300_000,
    retry: NO_RETRY,
    costAllowance: opts.intentHook ? opts.intentCostAllowance : 'none',
    stoppingConditions: [
      'site-level INVALID_OR_INCOMPLETE_DATA is recorded and passed on (recommend returns repair-measurement)',
      'an explicit historical report period (weekly --from/--to ending before the latest complete date) is routed over that window, but nothing is saved and no earlier proposal is superseded',
    ],
    next: ['recommend'],
    buildInput: (c, params) => {
      const plan = planPeriodOf(c);
      return {
        days: typeof params.days === 'number' ? params.days : (opts.days ?? 28),
        end: typeof params.end === 'string' ? params.end : null,
        reportPeriod: plan ? { start: plan.start, end: plan.end, explicit: plan.explicit === true } : null,
      };
    },
    run: async (input, sctx) => {
      const app = sctx.app;
      const notes: StageNote[] = [];
      // The optional cheap-model hook runs only with an allowance in this attempt (the engine drops it when the LLM budget is exhausted).
      let hook: IntentClassifierHook | undefined;
      if (opts.intentHook) {
        const dropped = paidWorkSkippedReason(sctx);
        if (stageMayPay(sctx, 'llm_gateway')) hook = opts.intentHook(app);
        else if (dropped) notes.push({ status: 'degraded', code: dropped.code, detail: `Ambiguous query intent was classified by rules only (UNSURE where the rules cannot decide): the optional cheap-model intent classifier was not used (${dropped.reason}).`, nextStep: dropped.code === 'BUDGET_EXCEEDED' ? 'Wait for the next budget period or raise budgets.llmGateway in the site config (never automatic); routing and the recommendation do not depend on the model.' : null });
      } else if (opts.intentHookUnavailable) {
        const u = opts.intentHookUnavailable;
        notes.push({ status: 'degraded', code: u.code, detail: `Ambiguous query intent was classified by rules only (UNSURE where the rules cannot decide): ${u.detail}`, nextStep: u.nextStep ?? null });
      }
      const deps = { db: app.db, siteId: app.siteId, config: app.config, clock: app.clock, synthetic: app.synthetic, ...(hook ? { intentHook: hook } : {}) };
      // Window: `days` ending at the explicit end, else at the latest date complete in Search Console and GA4,
      // moved back to the report period end when the report period ends earlier (routing never covers dates after the report).
      let site = prepareSiteAnalysis(deps, { days: input.days, end: input.end });
      const report = input.reportPeriod ?? null;
      let historical = false;
      if (!input.end && report && report.end < site.period.period.end) {
        site = prepareSiteAnalysis(deps, { days: input.days, end: report.end });
        historical = report.explicit;
      }
      const notPersistedReason = historical
        ? `explicit historical report period ${report!.start}..${report!.end} (it ends before the latest complete date): routed over the ${input.days} days ending ${report!.end}, but route decisions and the recommendation are not saved and no earlier proposal is superseded`
        : null;
      if (notPersistedReason) {
        notes.push({ status: 'skipped', code: 'HISTORICAL_PERIOD', detail: `Routing: ${notPersistedReason}.`, nextStep: 'Run weekly without --from/--to for a current recommendation.' });
      }
      const run = await routeAllPages(deps, site, { persist: !app.dryRun && !historical, jobId: sctx.jobId });
      const oppIds = new Map(run.persisted.map((p) => [p.pageId, p.opportunityId]));
      const candidates: CandidateOpportunity[] = run.analyses.filter((a) => a.score).map((a) => candidateFromAnalysis(a, oppIds.get(a.page.id) ?? null));
      return {
        dryRun: app.dryRun,
        period: site.period.period,
        siteDecision: site.siteDecision,
        siteDecisionId: run.siteDecisionId,
        counts: run.counts,
        persisted: run.persisted.map((p) => ({ pageId: p.pageId, routeDecisionId: p.routeDecisionId, opportunityId: p.opportunityId })),
        candidates,
        merged: run.merged.map((m) => ({ pageId: m.pageId, url: m.url, mergedInto: m.mergedInto.url })),
        synthetic: site.synthetic,
        intentHookStatus: [...new Set(run.analyses.map((a) => a.bundle.intents.hook.status))],
        notPersistedReason,
        note: mergeNotes(notes),
      };
    },
  };

  const recommend: StageDefinition<z.infer<typeof recommendInput>, z.infer<typeof recommendOutput>> = {
    name: 'recommend',
    version: 'recommend@4',
    description: 'One primary action or an explicit no-action/repair-measurement/collect-more-evidence decision, plus at most three secondary observations; a deep SERP/competitor comparison of this run (when available) is attached to the primary.',
    input: recommendInput,
    output: recommendOutput,
    prerequisites: ['route_and_score'],
    evidence: { requirement: "The routing run's scored opportunities; previous experiments, decisions, and learnings are consulted; this run's competitor comparisons when the pipeline has a compare stage." },
    timeoutMs: 60_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    stoppingConditions: ['no_action / collect_more_evidence are valid terminal outcomes'],
    next: ['report'],
    buildInput: (c) => {
      const comparisons = comparisonsFromPrior(c.prior.compare);
      // The route stage's own note is not an input of this stage.
      const { note: _note, ...route } = routeOutput.parse(c.prior.route_and_score);
      void _note;
      return { ...route, ...(comparisons.length ? { comparisons } : {}) };
    },
    run: async (input, sctx) => {
      const app = sctx.app;
      const tz = app.config.reporting.businessTimezone ?? app.config.scheduler.timezone;
      const today = dateInZone(app.clock.now(), tz);
      // Previous experiments, owner decisions, rejected proposals, learnings, and the owner's business notes are retrieved BEFORE recommending (spec 19).
      const prior = await loadPriorContext(app.db, app.siteId, { today, ...(opts.memory ? { memory: opts.memory, memoryQuery: priorMemoryQuery(input.candidates as CandidateOpportunity[]) } : {}) });
      const set = assembleRecommendation(app.siteId, {
        // Only this run's candidates: earlier runs' opportunities are never re-recommended.
        candidates: input.candidates as CandidateOpportunity[],
        siteDecision: (input.siteDecision as RouteDecision | null) ?? null,
        routeCounts: input.counts,
        today,
        reviewDays: app.config.experiments.defaultMinObservationDays,
        lowTrafficReviewDays: app.config.experiments.lowTrafficMinObservationDays,
        prior,
        synthetic: input.synthetic || app.synthetic,
        ...(input.comparisons?.length ? { comparisons: input.comparisons as ComparisonForRecommendation[] } : {}),
      });
      if (app.dryRun) return { primaryId: 'dry-run', secondaryIds: [], kind: set.primary.kind, title: set.primary.title, excluded: set.excluded.length, saved: false };
      if (input.notPersistedReason) {
        // A past period never replaces the current recommendation: nothing is saved, nothing is superseded.
        return {
          primaryId: HISTORICAL_PERIOD_PRIMARY_ID,
          secondaryIds: [],
          kind: set.primary.kind,
          title: set.primary.title,
          excluded: set.excluded.length,
          saved: false,
          note: { status: 'skipped' as const, code: 'HISTORICAL_PERIOD', detail: `Recommendation not saved (${input.notPersistedReason}). It was assembled for this review only: ${set.primary.kind}: ${set.primary.title}.`, nextStep: 'Run weekly without --from/--to for a current recommendation.' },
        };
      }
      const saved = persistRecommendationSet(app.db, app.siteId, set, { now: app.clock.now(), jobId: sctx.jobId });
      return { primaryId: saved.primaryId, secondaryIds: saved.secondaryIds, kind: set.primary.kind, title: set.primary.title, excluded: set.excluded.length, saved: true };
    },
  };

  return [reconcile, route, recommend];
}
