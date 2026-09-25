import { z } from 'zod';
import type { AppContext } from '../../app/context.js';
import { AppError, errorMessage } from '../../core/errors.js';
import { formatUsd } from '../../core/money.js';
import { NO_RETRY } from '../../core/retry.js';
import { crawlCompetitorPages } from '../../crawler/competitor.js';
import { researchShortlist, type ShortlistCandidate } from '../../integrations/dataforseo/research.js';
import { createMemoryService } from '../../memory/service.js';
import { normalizeQuery } from '../../router/intent.js';
import { createLlmIntentClassifier } from '../../router/llm-intent.js';
import { buildComparisonInputs, persistComparison, synthesizeComparison, type ComparisonSynthesisRecord, type SerpScope } from '../../seo/competitive.js';
import { loadPriorContext, type ComparisonForRecommendation } from '../../seo/recommend.js';
import { comparisonForRecommendationSchema, createSeoStages } from '../../seo/stages.js';
import { configuredGscScope, type ConfiguredGscScope } from '../../seo/coverage.js';
import { resolveGscProperty } from '../../seo/period.js';
import { exhaustedLimits } from '../budget-guard.js';
import { siteStructureStage } from './site-structure.js';
import { defineStage, type EngineStage } from '../stage.js';
import type { CostAllowance, StageContext } from '../types.js';
import {
  acquireLockStage,
  checkAccessStage,
  crawlSiteStage,
  indexMemoryStage,
  measurementStage,
  performanceStage,
  note,
  noteSchema,
  paramsOf,
  planPeriodStage,
  reconcileCostsStage,
  reportStage,
  resumePendingStage,
  reviewExperimentsStage,
  syncGa4Stage,
  syncGscStage,
  withNext,
  type PipelineEnv,
} from './common.js';

/**
 * WEEKLY (spec section 27):
 *   acquire site lock -> sync fresh complete data (GSC, GA4, bounded own-site
 *   crawl + technical checks, priority-page performance) -> validate joins -> review
 *   existing experiments -> route cases -> shortlist opportunities -> perform
 *   justified budgeted research (RESEARCH mode or higher only) -> retrieve
 *   memory -> one primary recommendation or an explicit no-action decision
 *   (+ at most three secondary observations) -> update reports/dashboard ->
 *   reconcile costs.
 *
 * Research: GSC shortlist -> local filtering -> 3-5 serious queries ->
 * DataForSEO SERP (cache and open tasks first, budget reserved per request)
 * -> relevant competitor pages crawled (robots/login/access denials are
 * recorded, never bypassed).
 *
 * Compare (spec section 19, deep analysis): for the top (<= 3) researched
 * candidates with usable competitor pages, our page is compared with the
 * competitors of that ONE query in the localized SERP (configured location,
 * language, device): intent, page type, useful information, examples, tools,
 * original data, evidence, freshness, buyer concerns; what our page does
 * better is recorded, not only gaps. The optional model synthesis runs only
 * with a configured reasoning model and within a small LLM allowance.
 * Results are stored in competitive_comparisons and attached to the primary
 * recommendation.
 *
 * Memory: index_memory ingests new/changed records (and deletions) into the
 * full-text index before retrieve_memory, without any paid call.
 *
 * Site structure (after recommend): internal-link suggestions for this run's
 * candidate pages, potential orphans relative to the known crawl coverage,
 * and page-level heuristic AEO checks of the latest own-site crawl are handed
 * to the report (free, read-only; src/workflows/pipelines/site-structure.ts).
 */

export const WEEKLY_WORKFLOW = 'weekly';

export const WEEKLY_STAGE_ORDER = [
  'acquire_lock',
  'check_access',
  'resume_pending',
  'sync_gsc',
  'plan_period',
  'sync_ga4',
  'crawl_site',
  'performance',
  'validate_joins',
  'review_experiments',
  'reconcile_urls',
  'route_and_score',
  'research',
  'compare',
  'index_memory',
  'retrieve_memory',
  'recommend',
  'site_structure',
  'report',
  'reconcile_costs',
] as const;

/** Maximum researched candidates compared in depth per weekly run. */
export const COMPARE_MAX_CANDIDATES = 3;
/** Share of budgets.llmGateway.perRun the optional SERP synthesis may commit per weekly run. */
export const COMPARE_SYNTHESIS_BUDGET_SHARE = 0.1;

/** Routes whose candidates justify SERP research (never measurement/technical prerequisites). */
export const RESEARCH_ROUTES = new Set(['RANKING_OPPORTUNITY', 'CTR_OPPORTUNITY', 'DECLINE', 'CONTENT_OPPORTUNITY', 'CONVERSION_OPPORTUNITY']);

interface RouteCandidate {
  id: string | null;
  route: string;
  pageId?: string | null;
  url: string | null;
  query: string | null;
  score: number | null;
  rawCounts: Record<string, unknown>;
}

/**
 * The Search Console slice the page-level query fallback reads: the configured
 * property and its primary search type (configuredGscScope). Without a
 * configured property, the only property with data (the page-analysis rule,
 * resolveGscProperty); when several properties have data, no slice (null) and
 * the reason, so rows of different properties or search types are never summed.
 */
export function researchGscScope(app: Pick<AppContext, 'db' | 'siteId' | 'config'>): { scope: ConfiguredGscScope | null; skipped: string | null } {
  const configured = configuredGscScope(app.config);
  if (configured) return { scope: configured, skipped: null };
  const resolved = resolveGscProperty(app.db, app.siteId, null);
  if ('reason' in resolved) {
    const several = /several Search Console properties/.test(resolved.reason);
    return {
      scope: null,
      skipped: several ? `The Search Console query fallback for page-level candidates was skipped: no google.searchConsoleProperty is configured and ${resolved.reason.replace(/; set google\.searchConsoleProperty$/, '')}, so their rows are never summed together. Set google.searchConsoleProperty.` : null,
    };
  }
  const types = app.config.google?.gsc?.searchTypes ?? [];
  return { scope: { property: resolved.property, searchType: types.includes('web') ? 'web' : (types[0] ?? 'web') }, skipped: null };
}

/**
 * Research candidates and why the GSC-query fallback was skipped (null when it
 * was not): query-level candidates first, then the top Search Console queries
 * of shortlisted pages, read from ONE property and search type only.
 */
export function researchCandidatePlan(app: AppContext, candidates: RouteCandidate[], period: { start: string; end: string }, max = 10): { candidates: ShortlistCandidate[]; fallbackSkipped: string | null } {
  const ranked = candidates.filter((c) => RESEARCH_ROUTES.has(c.route)).sort((a, b) => (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY));
  const out: ShortlistCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: ShortlistCandidate) => {
    const k = c.query.trim().toLowerCase();
    if (!k || seen.has(k) || out.length >= max) return;
    seen.add(k);
    out.push(c);
  };
  for (const c of ranked) {
    if (c.query) push({ query: c.query, origin: 'gsc', score: c.score, impressions: typeof c.rawCounts.impressions === 'number' ? c.rawCounts.impressions : null, page: c.url, opportunityId: c.id });
  }
  const pageLevel = ranked.filter((c) => !c.query && !!c.url);
  if (!pageLevel.length || out.length >= max) return { candidates: out, fallbackSkipped: null };
  const { scope, skipped } = researchGscScope(app);
  if (!scope) return { candidates: out, fallbackSkipped: skipped };
  for (const c of pageLevel) {
    if (out.length >= max) break;
    const rows = app.db.all<{ query: string; impressions: number }>(
      `SELECT query, SUM(impressions) AS impressions FROM gsc_page_query_daily
       WHERE site_id = ? AND is_current = 1 AND property = ? AND search_type = ? AND segment_key = '' AND page = ? AND date BETWEEN ? AND ?
       GROUP BY query ORDER BY impressions DESC, query LIMIT 3`,
      [app.siteId, scope.property, scope.searchType, c.url, period.start, period.end],
    );
    for (const r of rows) push({ query: r.query, origin: 'gsc', score: c.score, impressions: r.impressions, page: c.url, opportunityId: c.id });
  }
  return { candidates: out, fallbackSkipped: null };
}

/** Research candidates: query-level candidates first, then the top GSC queries of shortlisted pages (one property and search type). */
export function researchCandidates(app: AppContext, candidates: RouteCandidate[], period: { start: string; end: string }, max = 10): ShortlistCandidate[] {
  return researchCandidatePlan(app, candidates, period, max).candidates;
}

const researchOutput = z.object({
  status: z.string(),
  isSandbox: z.boolean(),
  candidates: z.number(),
  queries: z.array(z.object({ query: z.string(), status: z.string(), usable: z.boolean(), competitorUrls: z.number(), error: z.object({ code: z.string(), message: z.string() }).nullable() })),
  filtered: z.array(z.object({ query: z.string(), reason: z.string() })),
  competitorPages: z.array(z.object({ url: z.string(), query: z.string().nullable(), status: z.string(), blockedReason: z.string().nullable(), reason: z.string().nullable() })),
  competitorCrawlStatus: z.string().nullable(),
  /** Localized SERP settings the research used (configured location, language, device); absent in older checkpoints. */
  settings: z.object({ locationCode: z.number().nullable(), languageCode: z.string().nullable(), device: z.string().nullable() }).nullable().optional(),
  blockers: z.array(z.object({ code: z.string(), message: z.string() })),
  warnings: z.array(z.string()),
  note: noteSchema,
});
export type ResearchOutput = z.infer<typeof researchOutput>;

function researchStage(env: PipelineEnv, app: AppContext): EngineStage {
  const allowance: CostAllowance[] = [{ provider: 'dataforseo', maxMicros: app.settings.budgets.dataforseo.perRun }];
  return defineStage({
    name: 'research',
    version: 'research@1',
    description: 'Justified, budgeted research for the shortlist only: DataForSEO SERPs for 3-5 serious queries (cache and open tasks first) and the relevant competitor pages.',
    input: z.object({
      candidates: z.array(z.object({ query: z.string(), origin: z.enum(['gsc', 'owner']).optional(), score: z.number().nullable().optional(), impressions: z.number().nullable().optional(), page: z.string().nullable().optional(), opportunityId: z.string().nullable().optional() })),
      maxQueries: z.number().int().nullable(),
      waitMs: z.number().int(),
      /** Why the Search Console query fallback for page-level candidates was skipped (ambiguous property), or null. */
      fallbackSkipped: z.string().nullable().optional(),
    }),
    output: researchOutput,
    prerequisites: ['route_and_score', 'plan_period'],
    evidence: {
      requirement: 'Shortlisted opportunities with Search Console query evidence (queries must exist in this site\'s GSC data).',
      check: (input) => (input.candidates.length ? [] : [`no shortlisted opportunity has query-level Search Console evidence; research is not justified this week${input.fallbackSkipped ? ` (${input.fallbackSkipped})` : ''}`]),
    },
    timeoutMs: 20 * 60_000,
    retry: NO_RETRY,
    costAllowance: allowance,
    requiredMode: 'RESEARCH',
    optional: true,
    providers: ['dataforseo'],
    stoppingConditions: [
      'Runtime mode below RESEARCH: skipped (MODE_NOT_PERMITTED).',
      'Budget exhausted or price unknown: no paid request; the status is recorded and the report is still produced.',
      'Competitor pages behind robots.txt, logins, or access denials are recorded as blocked, never bypassed.',
    ],
    next: ['compare'],
    buildInput: (sctx, params) => {
      const route = sctx.prior.route_and_score as { candidates: RouteCandidate[] };
      const plan = sctx.prior.plan_period as { period: { start: string; end: string } };
      const p = paramsOf(params);
      const shortlist = researchCandidatePlan(sctx.app, route.candidates, plan.period);
      return { candidates: shortlist.candidates, maxQueries: p.researchMaxQueries ?? null, waitMs: p.researchWaitMs ?? 90_000, fallbackSkipped: shortlist.fallbackSkipped };
    },
    run: async (input, sctx) => runResearch(env, input, sctx),
  });
}

async function runResearch(env: PipelineEnv, input: { candidates: ShortlistCandidate[]; maxQueries: number | null; waitMs: number; fallbackSkipped?: string | null | undefined }, sctx: StageContext): Promise<ResearchOutput> {
  const app = sctx.app;
  const svc = env.services(app);
  const r = await researchShortlist(app, input.candidates, { ...svc.dataforseo, allowPaid: true, waitMs: input.waitMs, ...(input.maxQueries ? { maxQueries: input.maxQueries } : {}) });
  if (r.status === 'skipped' && r.blockers[0] && !r.queries.some((q) => q.status === 'cached' || q.status === 'fetched')) {
    const b = r.blockers[0];
    throw new AppError(b.code as ConstructorParameters<typeof AppError>[0], `Research could not run: ${b.message}`, b.hint ? { hint: b.hint } : {});
  }
  const targets = r.competitorUrls.filter((u) => u.usableForRecommendations || app.synthetic).map((u) => ({ url: u.url, query: u.query }));
  let crawl: Awaited<ReturnType<typeof crawlCompetitorPages>> | null = null;
  const warnings = [...(input.fallbackSkipped ? [input.fallbackSkipped] : []), ...r.warnings];
  if (targets.length) {
    try {
      crawl = await crawlCompetitorPages(app, targets, { ...svc.competitorCrawler, jobId: sctx.jobId, signal: sctx.signal, origin: 'serp_discovered' });
    } catch (err) {
      warnings.push(`Competitor crawl failed: ${errorMessage(err)}`);
    }
  } else if (r.competitorUrls.length) warnings.push('Competitor URLs came from sandbox/fixture data and are not usable for real recommendations; they were not crawled.');
  const pages = (crawl?.pages ?? []).map((p) => ({ url: p.url, query: p.query, status: p.status, blockedReason: p.blockedReason, reason: p.reason }));
  const blocked = pages.filter((p) => p.status === 'blocked');
  const failedQueries = r.queries.filter((q) => q.status === 'failed' || q.status === 'skipped' || q.status === 'ambiguous');
  const problems: string[] = [];
  if (failedQueries.length) problems.push(`${failedQueries.length} of ${r.queries.length} quer${r.queries.length === 1 ? 'y was' : 'ies were'} not researched (${[...new Set(failedQueries.map((q) => q.error?.code ?? q.status))].join(', ')})`);
  if (r.queries.some((q) => q.status === 'pending')) problems.push('some SERP tasks are still queued; results are collected by the next run (never resubmitted)');
  if (blocked.length) problems.push(`${blocked.length} competitor page(s) blocked (${[...new Set(blocked.map((b) => b.blockedReason ?? 'blocked'))].join(', ')}); not bypassed`);
  if (crawl && crawl.status !== 'completed') problems.push(`competitor crawl ${crawl.status}${crawl.notes[0] ? `: ${crawl.notes[0]}` : ''}`);
  if (input.fallbackSkipped) problems.push(input.fallbackSkipped.replace(/\.$/, ''));
  const budgetCode = failedQueries.find((q) => q.error?.code === 'BUDGET_EXCEEDED' || q.error?.code === 'BUDGET_UNKNOWN_PRICE')?.error?.code ?? null;
  return {
    status: r.status,
    isSandbox: r.isSandbox,
    candidates: input.candidates.length,
    queries: r.queries.map((q) => ({ query: q.query, status: q.status, usable: q.usableForRecommendations, competitorUrls: q.competitorUrls.length, error: q.error ? { code: q.error.code, message: q.error.message } : null })),
    filtered: r.filtered.map((f) => ({ query: f.query, reason: f.reason })),
    competitorPages: pages,
    competitorCrawlStatus: crawl?.status ?? null,
    settings: r.settings ? { locationCode: r.settings.locationCode, languageCode: r.settings.languageCode, device: r.settings.device } : null,
    blockers: r.blockers.map((b) => ({ code: b.code, message: b.message })),
    warnings: warnings.slice(0, 20),
    note: problems.length
      ? note('degraded', `Research: ${problems.join('; ')}.`, budgetCode ?? (blocked.length ? 'COMPETITOR_BLOCKED' : 'RESEARCH_PARTIAL'), budgetCode === 'BUDGET_EXCEEDED' ? 'The DataForSEO budget is exhausted for this period; wait for the next period or raise budgets.dataforseo (never automatic).' : blocked.length ? 'Blocked competitor pages are excluded from comparisons; choose other competitors or rely on SERP data.' : null)
      : null,
  };
}

// ---------------------------------------------------------------------------
// compare: deep SERP/competitor analysis of the top researched candidates
// ---------------------------------------------------------------------------

const compareTarget = z.object({ query: z.string(), page: z.string(), pageId: z.string().nullable(), opportunityId: z.string().nullable() });
type CompareTarget = z.infer<typeof compareTarget>;

const compareOutput = z.object({
  comparisons: z.array(comparisonForRecommendationSchema),
  skipped: z.array(z.object({ query: z.string(), reason: z.string() })),
  synthesis: z.object({ allowed: z.boolean(), reason: z.string().nullable(), maxMicros: z.number().nullable() }),
  note: noteSchema,
});
export type CompareOutput = z.infer<typeof compareOutput>;

/** The configured localized SERP (first market.searchLocations entry, first desktop/mobile device). */
export function configuredSerpScope(app: AppContext): SerpScope {
  const loc = app.config.market.searchLocations[0] ?? null;
  const device = app.config.market.devices.find((d) => d === 'desktop' || d === 'mobile') ?? null;
  return { locationCode: loc?.locationCode ?? null, languageCode: loc?.languageCode ?? null, device };
}

/**
 * Top (<= max) researched candidates with a usable SERP and at least one
 * fetched competitor page for THEIR query, in research priority order. Every
 * researched query that is not compared is listed with its reason.
 */
export function compareTargets(app: AppContext, candidates: RouteCandidate[], period: { start: string; end: string }, research: ResearchOutput, max = COMPARE_MAX_CANDIDATES): { targets: CompareTarget[]; skipped: Array<{ query: string; reason: string }> } {
  const key = (q: string) => normalizeQuery(q);
  const researched = new Map(research.queries.map((q) => [key(q.query), q]));
  const byOpp = new Map(candidates.filter((c) => c.id).map((c) => [c.id!, c]));
  const targets: CompareTarget[] = [];
  const skipped: Array<{ query: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const c of researchCandidates(app, candidates, period)) {
    const k = key(c.query);
    const q = researched.get(k);
    if (!q || seen.has(k)) continue;
    seen.add(k);
    if (targets.length >= max) {
      skipped.push({ query: q.query, reason: `over the ${max}-candidate deep-analysis limit` });
      continue;
    }
    if (q.status !== 'cached' && q.status !== 'fetched') {
      skipped.push({ query: q.query, reason: `SERP ${q.status}${q.error ? ` (${q.error.code})` : ''}` });
      continue;
    }
    if (!q.usable) {
      skipped.push({ query: q.query, reason: 'SERP data is sandbox/fixture data, not usable for real recommendations' });
      continue;
    }
    const fetched = research.competitorPages.filter((p) => p.query !== null && key(p.query) === k && p.status === 'fetched');
    if (!fetched.length) {
      skipped.push({ query: q.query, reason: 'no competitor page of this query could be fetched (blocked, failed, or not crawled); nothing to compare' });
      continue;
    }
    if (!c.page) {
      skipped.push({ query: q.query, reason: 'no page of ours is associated with this query' });
      continue;
    }
    const rc = c.opportunityId ? byOpp.get(c.opportunityId) : undefined;
    targets.push({ query: q.query, page: c.page, pageId: rc?.pageId ?? null, opportunityId: c.opportunityId ?? null });
  }
  return { targets, skipped };
}

interface SynthesisPlan {
  allowance: CostAllowance[] | null;
  reason: string | null;
  maxMicros: number | null;
}

/**
 * Whether the optional SERP synthesis may run in this weekly run, decided
 * when the stages are built: a configured (non-fixture) reasoning model, not
 * a dry run, a positive share of the LLM per-run budget, and an LLM budget
 * that is not already exhausted. Otherwise the stage declares no LLM
 * allowance (so the deterministic comparison is never skipped for budget
 * reasons) and records "synthesis skipped: <reason>".
 */
export function synthesisPlan(env: PipelineEnv, app: AppContext): SynthesisPlan {
  if (app.dryRun) return { allowance: null, reason: 'dry run (no paid model call is made)', maxMicros: null };
  const svc = env.services(app);
  if (svc.llmKind === 'fixture') return { allowance: null, reason: 'the demo fixture LLM client has no SERP-synthesis handler; no synthesis is invented', maxMicros: null };
  if (!svc.llm.isConfigured('reasoning')) return { allowance: null, reason: 'no reasoning model is configured (llm reasoning tier); the deterministic comparison is complete without it', maxMicros: null };
  const maxMicros = Math.floor(app.settings.budgets.llmGateway.perRun * COMPARE_SYNTHESIS_BUDGET_SHARE);
  if (maxMicros <= 0) return { allowance: null, reason: `budgets.llmGateway.perRun leaves no allowance (${Math.round(COMPARE_SYNTHESIS_BUDGET_SHARE * 100)}% share is $0)`, maxMicros: null };
  try {
    const exhausted = exhaustedLimits(app.budgets, app.siteId, 'llm_gateway', app.runId);
    if (exhausted.length) return { allowance: null, reason: `LLM Gateway budget exhausted (${exhausted[0]!.scope})`, maxMicros: null };
  } catch (err) {
    return { allowance: null, reason: `LLM Gateway budget could not be checked (${errorMessage(err)})`, maxMicros: null };
  }
  return { allowance: [{ provider: 'llm_gateway', maxMicros }], reason: null, maxMicros };
}

function synthesisRecordOf(r: Awaited<ReturnType<typeof synthesizeComparison>>): ComparisonSynthesisRecord {
  if (r.ok) return { status: 'ok', reason: null, synthesis: r.synthesis, callId: r.callId, promptVersion: r.promptVersion, model: r.model };
  const failed = r.status === 'provider_error' || r.status === 'invalid_model' || r.status === 'needs_review';
  return { status: failed ? 'failed' : 'skipped', reason: `synthesis ${failed ? 'failed' : 'skipped'}: ${r.status}: ${r.reason}` };
}

function compareStage(env: PipelineEnv, app: AppContext): EngineStage {
  const plan = synthesisPlan(env, app);
  return defineStage({
    name: 'compare',
    version: 'compare@1',
    description:
      'Deep analysis of the top (<= 3) researched candidates: our page vs the crawled competitor pages of that query in the localized SERP (intent, page type, topics, examples, tools, original data, evidence, freshness, buyer concerns); records what our page does better, observed gaps (never ranking causes), and caveats; optional reasoning-model synthesis within a small LLM allowance.',
    input: z.object({ targets: z.array(compareTarget), skipped: z.array(z.object({ query: z.string(), reason: z.string() })), serp: z.object({ locationCode: z.number().nullable().optional(), languageCode: z.string().nullable().optional(), device: z.string().nullable().optional() }), maxCompetitors: z.number().int().min(1) }),
    output: compareOutput,
    prerequisites: ['research', 'route_and_score', 'plan_period'],
    evidence: {
      requirement: 'Researched queries with a usable localized SERP snapshot and at least one fetched competitor page, and our crawled page.',
      check: (input) => (input.targets.length ? [] : [`no researched candidate has usable competitor pages${input.skipped.length ? ` (${input.skipped.map((x) => `"${x.query}": ${x.reason}`).slice(0, 3).join('; ')})` : ''}`]),
    },
    timeoutMs: 10 * 60_000,
    retry: NO_RETRY,
    costAllowance: plan.allowance ?? 'none',
    optional: true,
    // No provider gate: an unavailable model must never skip the deterministic comparison (the synthesis failure is recorded instead).
    stoppingConditions: [
      'No researched candidate with usable competitor pages: skipped (EVIDENCE_INSUFFICIENT); the recommendation is made without a comparison.',
      'No reasoning model, a dry run, or no LLM budget: the deterministic comparison is still stored; "synthesis skipped: <reason>" is recorded.',
    ],
    next: ['index_memory'],
    buildInput: (sctx) => {
      const route = sctx.prior.route_and_score as { candidates: RouteCandidate[] };
      const period = (sctx.prior.plan_period as { period: { start: string; end: string } }).period;
      const research = sctx.prior.research as ResearchOutput;
      const { targets, skipped } = compareTargets(sctx.app, route.candidates, period, research);
      const configured = configuredSerpScope(sctx.app);
      const s = research.settings ?? null;
      const serp = { locationCode: s?.locationCode ?? configured.locationCode ?? null, languageCode: s?.languageCode ?? configured.languageCode ?? null, device: s?.device ?? configured.device ?? null };
      return { targets, skipped, serp, maxCompetitors: Math.max(1, sctx.app.config.crawl.competitorPagesPerQueryMax) };
    },
    run: async (input, sctx): Promise<CompareOutput> => {
      const app = sctx.app;
      const llm = plan.allowance ? env.services(app).llm : null;
      const comparisons: ComparisonForRecommendation[] = [];
      const skipped = [...input.skipped];
      const synthesisIssues: string[] = [];
      for (const t of input.targets) {
        const inputs = buildComparisonInputs(app.db, app.raw, app.siteId, { ourUrl: t.page, query: t.query, serp: input.serp, allowSandbox: app.synthetic, synthetic: app.synthetic, maxCompetitors: input.maxCompetitors });
        if (!inputs.competitors.length) {
          skipped.push({ query: t.query, reason: `no accessible competitor page in the localized SERP snapshot (${inputs.caveats.slice(-1)[0] ?? 'nothing to compare'})` });
          continue;
        }
        let synthesis: ComparisonSynthesisRecord;
        if (!llm) synthesis = { status: 'skipped', reason: `synthesis skipped: ${plan.reason ?? 'not allowed in this run'}` };
        else {
          try {
            synthesis = synthesisRecordOf(await synthesizeComparison(llm, inputs, { siteId: app.siteId, runId: sctx.jobId, synthetic: inputs.synthetic === true, maxOutputTokens: 1_200 }));
          } catch (err) {
            synthesis = { status: 'failed', reason: `synthesis failed: ${errorMessage(err)}` };
          }
          if (synthesis.status !== 'ok' && synthesis.reason) synthesisIssues.push(`"${t.query}": ${synthesis.reason}`);
        }
        const id = app.dryRun ? null : persistComparison(app.db, { siteId: app.siteId, runId: sctx.jobId, jobId: sctx.jobId, query: t.query, pageId: t.pageId, pageUrl: t.page, opportunityId: t.opportunityId, inputs, synthesis, now: app.clock.now() });
        const snap = inputs.selection?.serpSnapshot ?? null;
        const fetched = [inputs.ourPage?.fetchedAt, ...inputs.competitors.map((c) => c.fetchedAt)].filter((x): x is string => !!x).sort();
        comparisons.push({
          id,
          query: t.query,
          pageId: t.pageId,
          url: inputs.ourPage?.url ?? t.page,
          opportunityId: t.opportunityId,
          competitorsCompared: inputs.competitors.length,
          competitorsInaccessible: inputs.inaccessibleCompetitors.length,
          ourAdvantages: inputs.ourAdvantages,
          gaps: inputs.gaps,
          caveats: inputs.caveats,
          synthesis: { status: synthesis.status, reason: synthesis.reason, summary: synthesis.synthesis?.summary ?? null, model: synthesis.model ?? null, promptVersion: synthesis.promptVersion ?? null },
          serp: snap ? { snapshotId: snap.id, collectedAt: snap.collectedAt, locationCode: snap.locationCode, languageCode: snap.languageCode, device: snap.device } : null,
          fetchedAt: fetched.slice(-1)[0] ?? null,
          synthetic: inputs.synthetic === true,
        });
      }
      const problems: string[] = [];
      if (!comparisons.length) problems.push('no candidate could be compared');
      if (skipped.length) problems.push(`${skipped.length} researched quer${skipped.length === 1 ? 'y was' : 'ies were'} not compared (${skipped.map((x) => `"${x.query}": ${x.reason}`).slice(0, 3).join('; ')})`);
      if (synthesisIssues.length) problems.push(`SERP synthesis did not complete for ${synthesisIssues.length} comparison(s) (${synthesisIssues.slice(0, 2).join('; ')})`);
      return {
        comparisons,
        skipped,
        synthesis: { allowed: !!plan.allowance, reason: plan.reason, maxMicros: plan.maxMicros },
        note: problems.length ? note(comparisons.length ? 'degraded' : 'skipped', `Deep comparison: ${problems.join('; ')}.`, comparisons.length ? 'COMPARE_PARTIAL' : 'COMPARE_NOTHING', null) : null,
      };
    },
  });
}

const priorOutput = z.object({
  memory: z.object({
    status: z.string(),
    detail: z.string().nullable(),
    /** 'policy' (a deliberate retrieval mode, e.g. full-text only by policy), 'degraded', or 'error'; absent in older checkpoints. */
    detailKind: z.string().nullable().optional(),
    items: z.array(z.object({ title: z.string(), sourceType: z.string(), recordStatus: z.string().nullable(), sourceRef: z.string() })),
  }),
  activeExperiments: z.number(),
  concludedExperiments: z.number(),
  decisions: z.number(),
  rejectedRecommendations: z.number(),
  learnings: z.number(),
  note: noteSchema,
});

function retrieveMemoryStage(env: PipelineEnv): EngineStage {
  return defineStage({
    name: 'retrieve_memory',
    version: 'retrieve_memory@1',
    description: 'Retrieve previous experiments, owner decisions, rejected proposals, and approved learnings (rejected/negative items keep their status so they are never mistaken for recommendations).',
    input: z.object({ today: z.string(), query: z.string() }),
    output: priorOutput,
    prerequisites: ['plan_period', 'route_and_score'],
    optionalPrerequisites: ['research'],
    evidence: { requirement: 'SQLite experiments/decisions/recommendations/learnings and the memory index (full-text; semantic when available).' },
    timeoutMs: 120_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    stoppingConditions: ['Never stops; degraded retrieval (full-text only) is recorded.'],
    next: ['recommend'],
    buildInput: (sctx) => {
      const plan = sctx.prior.plan_period as { today: string };
      const route = sctx.prior.route_and_score as { candidates: RouteCandidate[] };
      const top = route.candidates.slice(0, 3).map((c) => c.query ?? c.url ?? '').filter(Boolean);
      return { today: plan.today, query: ['previous recommendations experiments decisions', ...top].join(' ').slice(0, 300) };
    },
    run: async (input, sctx) => {
      const app = sctx.app;
      const memory = env.services(app).memory;
      const prior = await loadPriorContext(app.db, app.siteId, { today: input.today, memory, memoryQuery: input.query });
      return {
        memory: { status: prior.memory.status, detail: prior.memory.detail ?? null, detailKind: prior.memory.detailKind ?? null, items: prior.memory.items.slice(0, 8).map((i) => ({ title: i.title, sourceType: i.sourceType, recordStatus: i.recordStatus ?? null, sourceRef: i.sourceRef })) },
        activeExperiments: prior.activeExperiments.length,
        concludedExperiments: prior.concludedExperiments.length,
        decisions: prior.decisions.length,
        rejectedRecommendations: prior.rejectedRecommendations.length,
        learnings: prior.learnings.length,
        note: prior.memory.status === 'ok' ? null : note('degraded', `Memory retrieval ${prior.memory.status}${prior.memory.detail ? `: ${prior.memory.detail}` : ''}; SQLite records were still consulted.`, 'MEMORY_DEGRADED', null),
      };
    },
  });
}

export interface WeeklyStageOptions {
  /** Attach the cheap-model intent hook to routing (only when a cheap model is configured and not a dry run). */
  intentHook?: boolean;
}

/** Share of budgets.llmGateway.perRun the optional routing intent hook may commit per weekly run. */
export const INTENT_HOOK_BUDGET_SHARE = 0.1;

export interface IntentHookPlan {
  /** LLM allowance for route_and_score, or null when the hook is not attached. */
  allowance: CostAllowance[] | null;
  /** Why a configured model is not used in this run (recorded as a route_and_score note), or null. */
  unavailable: { code: string; detail: string; nextStep: string | null } | null;
}

/**
 * Whether routing may call the cheap model for ambiguous intents in this run,
 * decided when the stages are built (the synthesisPlan pattern): requested,
 * not a dry run, a configured cheap model, a positive share of the LLM
 * per-run budget, and an LLM budget that is not already exhausted. Otherwise
 * route_and_score declares no allowance and stays rule-only, so an exhausted
 * or $0 LLM budget never blocks routing, the recommendation, or the report.
 * A budget exhausted later (resume) is handled by the engine
 * (`paidWorkOptional`).
 */
export function intentHookPlan(env: PipelineEnv, app: AppContext, requested: boolean): IntentHookPlan {
  if (!requested || app.dryRun) return { allowance: null, unavailable: null };
  const llm = env.services(app).llm;
  if (!llm.isConfigured('cheap')) return { allowance: null, unavailable: null };
  const maxMicros = Math.floor(app.settings.budgets.llmGateway.perRun * INTENT_HOOK_BUDGET_SHARE);
  const raise = 'Raise budgets.llmGateway in the site config if you want the model for ambiguous intents (never automatic); routing and the recommendation do not depend on it.';
  if (maxMicros <= 0) return { allowance: null, unavailable: { code: 'BUDGET_EXCEEDED', detail: `budgets.llmGateway.perRun leaves no allowance for the optional intent classifier (${Math.round(INTENT_HOOK_BUDGET_SHARE * 100)}% share is $0).`, nextStep: raise } };
  try {
    const exhausted = exhaustedLimits(app.budgets, app.siteId, 'llm_gateway', app.runId);
    if (exhausted.length) {
      const e = exhausted[0]!;
      return { allowance: null, unavailable: { code: 'BUDGET_EXCEEDED', detail: `the LLM Gateway budget is exhausted (${e.scope}: ${formatUsd(e.committedMicros)} committed of ${formatUsd(e.limitMicros)}).`, nextStep: `Wait for the next budget period. ${raise}` } };
    }
  } catch (err) {
    return { allowance: null, unavailable: { code: 'BUDGET_UNKNOWN', detail: `the LLM Gateway budget could not be checked (${errorMessage(err)}).`, nextStep: 'Check `npm run cli -- costs`.' } };
  }
  return { allowance: [{ provider: 'llm_gateway', maxMicros }], unavailable: null };
}

/** The SEO slice stages (reconcile -> route -> recommend) re-pointed into the weekly/monthly order. */
export function seoStagesFor(env: PipelineEnv, app: AppContext, opts: { intentHook: boolean; routeNext: string; recommendPrereqs?: string[] }): { reconcile: EngineStage; route: EngineStage; recommend: EngineStage } {
  // Retrieval for the recommend stage is full-text only (no implicit embedding spend).
  const memory = createMemoryService(app, { llm: null });
  const plan = intentHookPlan(env, app, opts.intentHook);
  const [reconcile, route, recommend] = plan.allowance
    ? createSeoStages({
        memory,
        intentHook: (a) => createLlmIntentClassifier(env.services(a).llm, { siteId: a.siteId, runId: a.runId, synthetic: a.synthetic, businessContext: `${a.config.site.businessName}` }),
        intentCostAllowance: plan.allowance,
      })
    : createSeoStages({ memory, ...(plan.unavailable ? { intentHookUnavailable: plan.unavailable } : {}) });
  return {
    reconcile: withNext(reconcile as unknown as EngineStage, ['route_and_score']),
    // Routing is required, but its model use is optional: an exhausted LLM budget runs it rule-only (degraded), never blocks it.
    // plan_period gives the report period, so routing never covers dates after it (and a historical period is not saved).
    route: withNext(route as unknown as EngineStage, [opts.routeNext], { optional: false, optionalPrerequisites: ['plan_period'], ...(plan.allowance ? { paidWorkOptional: true } : {}) }),
    recommend: withNext(recommend as unknown as EngineStage, ['report'], opts.recommendPrereqs ? { optionalPrerequisites: opts.recommendPrereqs } : {}),
  };
}

export function createWeeklyStages(env: PipelineEnv, app: AppContext, opts: WeeklyStageOptions = {}): EngineStage[] {
  const seo = seoStagesFor(env, app, { intentHook: opts.intentHook !== false, routeNext: 'research', recommendPrereqs: ['compare'] });
  return [
    acquireLockStage('check_access'),
    checkAccessStage(env, 'resume_pending', ['acquire_lock']),
    resumePendingStage(env, 'sync_gsc', ['check_access']),
    syncGscStage(env, { next: 'plan_period', prerequisites: ['check_access'], days: () => null, reportSegments: 'weekly' }),
    planPeriodStage('weekly', 'sync_ga4', ['check_access'], ['sync_gsc']),
    syncGa4Stage(env, { next: 'crawl_site', prerequisites: ['plan_period'], days: () => null }),
    crawlSiteStage(env, 'performance', ['check_access']),
    performanceStage(env, 'validate_joins', ['check_access']),
    measurementStage('validate_joins', 'review_experiments', ['plan_period'], ['sync_gsc', 'sync_ga4']),
    reviewExperimentsStage(env, 'reconcile_urls', ['validate_joins']),
    seo.reconcile,
    seo.route,
    researchStage(env, app),
    compareStage(env, app),
    indexMemoryStage(env, 'retrieve_memory', ['check_access'], { optional: true }),
    retrieveMemoryStage(env),
    withNext(seo.recommend, ['site_structure']),
    siteStructureStage('report', ['route_and_score'], ['crawl_site']),
    reportStage(env, { kind: 'weekly', earlierStages: WEEKLY_STAGE_ORDER.filter((s) => s !== 'report' && s !== 'reconcile_costs'), prerequisites: ['check_access', 'plan_period', 'recommend'], next: 'reconcile_costs' }),
    reconcileCostsStage(env, ['report']),
  ];
}
