/**
 * The routing rationale of a recommendation is sourced (D2-ACC-03): the
 * `<key>.route` claim ("Routed to <ROUTE>: <reasons>") cites an evidence item
 * built from the measured inputs the router recorded on its reasons (per-query
 * rows with position and impressions, page totals, rates, crawl or URL
 * Inspection observations), their window, and the current-revision view they
 * came from. A claim with no measured input is context, never "supports"
 * without an evidence item. SYNTHETIC inputs only (example.test URLs,
 * invented numbers).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { observed, unavailable } from '../../../src/core/measured.js';
import { buildWeeklyReport } from '../../../src/reports/build.js';
import { allClaims } from '../../../src/reports/model.js';
import { routeSite } from '../../../src/router/router.js';
import { evaluateRoute } from '../../../src/router/rules.js';
import { reasonInputs, type RouteDecision } from '../../../src/router/types.js';
import { prepareSiteAnalysis, routeAllPages } from '../../../src/seo/page-analysis.js';
import { UrlReconciler } from '../../../src/seo/reconcile.js';
import { assembleRecommendation, loadCandidates, loadPriorContext, persistRecommendationSet, type CandidateOpportunity, type PriorContext, type RecommendationSet } from '../../../src/seo/recommend.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { baseInput, q, T } from '../../fixtures/seo/route-input.js';
import { SeoSeeder } from '../../fixtures/seo/seed.js';
import { HOST, scenarioConfig, seedScenario } from '../../fixtures/seo/scenario.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const OPTS = { today: '2026-09-24', reviewDays: 28, lowTrafficReviewDays: 56 };
const emptyPrior = (): PriorContext => ({ activeExperiments: [], concludedExperiments: [], decisions: [], rejectedRecommendations: [], learnings: [], memory: { status: 'not_configured', items: [] } });

/** OBSERVED/INFERRED claims stored as "supports" without an evidence item: must be none. */
function unsupported(c: TestContext): Array<{ subject_id: string; claim_key: string; claim_label: string }> {
  return c.db.all(
    "SELECT subject_id, claim_key, claim_label FROM claim_evidence WHERE site_id = ? AND subject_type = 'recommendation' AND claim_label IN ('OBSERVED', 'INFERRED') AND support = 'supports' AND evidence_id IS NULL",
    [c.siteId],
  );
}

interface RouteRow {
  claim_label: string;
  claim_text: string;
  support: string;
  evidence_id: string | null;
  kind: string | null;
  summary: string | null;
  locator_json: string | null;
  value_json: string | null;
  date_range_start: string | null;
  date_range_end: string | null;
  source_type: string | null;
  trust_class: string | null;
}

function claimRow(c: TestContext, recId: string, key: string): RouteRow {
  const r = c.db.get<RouteRow>(
    `SELECT c.claim_label, c.claim_text, c.support, c.evidence_id, e.kind, e.summary, e.locator_json, e.value_json, e.date_range_start, e.date_range_end, s.source_type, s.trust_class
       FROM claim_evidence c LEFT JOIN evidence e ON e.id = c.evidence_id LEFT JOIN sources s ON s.id = e.source_id
      WHERE c.site_id = ? AND c.subject_id = ? AND c.claim_key = ?`,
    [c.siteId, recId, key],
  );
  if (!r) throw new Error(`claim ${key} of ${recId} missing`);
  return r;
}

function candidate(d: RouteDecision, pageId: string, url: string, query: string | null): CandidateOpportunity {
  return {
    id: null,
    route: d.route,
    pageId,
    url,
    query,
    isBranded: false,
    score: 60,
    scoringVersion: 'scoring@test',
    rawCounts: { impressions: 5000, clicks: 300, position: 2.1, sessions: 280, convertingSessions: 8 },
    evidenceQuality: 0.9,
    reasons: d.reasons,
    isProtected: false,
    periodStart: d.period?.start ?? null,
    periodEnd: d.period?.end ?? null,
  };
}

function save(c: TestContext, set: RecommendationSet): string {
  return persistRecommendationSet(c.db, c.siteId, set, { now: c.clock.now(), supersedePrevious: false }).primaryId;
}

describe('the routing claim of a recommendation is sourced (D2-ACC-03)', () => {
  it('action route (RANKING_OPPORTUNITY): the route claim cites the per-query rows (position, impressions), the window, and the gsc_page_query_daily_current locator; the report shows it as supported', async () => {
    ctx = createTestContext({ config: scenarioConfig() });
    const url = `${HOST}/widgets`;
    const pageId = new SeoSeeder(ctx.db, ctx.siteId).page(url);
    const d = evaluateRoute(baseInput({ pageId, url, queries: [q('best widgets', { clicks: 30, impressions: 2000, position: 7.5, expectedCtr: 0.015 })] }), T);
    expect(d.route).toBe('RANKING_OPPORTUNITY');
    // The router records what each reason rests on.
    expect(reasonInputs(d.reasons.find((r) => r.code === 'QUERY_POSITION_IN_RANGE')!)).toMatchObject({ source: 'gsc', table: 'gsc_page_query_daily_current', period: { start: '2026-08-25', end: '2026-09-21' }, rows: [{ query: 'best widgets', position: 7.5, impressions: 2000, clicks: 30 }] });

    const set = assembleRecommendation(ctx.siteId, { candidates: [candidate(d, pageId, url, 'best widgets')], siteDecision: null, prior: emptyPrior(), ...OPTS });
    expect(set.primary).toMatchObject({ kind: 'primary', route: 'RANKING_OPPORTUNITY' });
    const recId = save(ctx, set);
    expect(unsupported(ctx)).toEqual([]);

    const route = claimRow(ctx, recId, 'primary.route');
    expect(route).toMatchObject({ claim_label: 'INFERRED', support: 'supports', kind: 'observation', source_type: 'gsc', trust_class: 'first_party_measurement', date_range_start: '2026-08-25', date_range_end: '2026-09-21' });
    expect(route.claim_text).toMatch(/^Routed to RANKING_OPPORTUNITY: QUERY_POSITION_IN_RANGE \(positions 4-20 \(shortlist heuristic\): "best widgets" \(pos 7\.5, 2000 impr\)\)/);
    expect(JSON.parse(route.locator_json!)).toMatchObject({ table: 'gsc_page_query_daily_current', pageId, query: 'best widgets', queries: ['best widgets'] });
    const value = JSON.parse(route.value_json!) as { route: string; reasons: Array<{ code: string; source: string; rows?: unknown[]; values?: Record<string, unknown> }> };
    expect(value.route).toBe('RANKING_OPPORTUNITY');
    expect(value.reasons.find((r) => r.code === 'QUERY_POSITION_IN_RANGE')).toMatchObject({ source: 'gsc', rows: [{ query: 'best widgets', position: 7.5, impressions: 2000, clicks: 30 }] });
    expect(value.reasons.find((r) => r.code === 'BUSINESS_EVIDENCE_CONVERSIONS')).toMatchObject({ source: 'ga4', values: { convertingSessions: 8, sessions: 280 } });
    expect(route.summary).toMatch(/^Measured inputs of the RANKING_OPPORTUNITY decision \(2026-08-25\.\.2026-09-21\): QUERY_POSITION_IN_RANGE \[gsc, 1 query row\(s\)\]/);

    // The report no longer marks the central reasoning MISSING.
    const b = await buildWeeklyReport(ctx, { statuses: null, persist: false });
    const shown = allClaims(b.report).find((c) => c.id.startsWith('action.evidence.') && c.text.startsWith('Routed to RANKING_OPPORTUNITY'))!;
    expect(shown).toMatchObject({ label: 'INFERRED', evidenceStatus: 'supported' });
    expect(shown.text).not.toContain('evidence not verifiable');
    expect(shown.sourceIds.some((s) => s === `evidence:${route.evidence_id}`)).toBe(true);
  });

  it('no-action routes: HEALTHY and LOW_DATA route claims are sourced from their measured inputs', () => {
    ctx = createTestContext({ config: scenarioConfig() });
    const seed = new SeoSeeder(ctx.db, ctx.siteId);

    // HEALTHY (analyze-page preview path: the page's own route, no period passed; the window comes from the inputs).
    const healthyUrl = `${HOST}/guide`;
    const healthyId = seed.page(healthyUrl);
    const healthy = evaluateRoute(baseInput({ pageId: healthyId, url: healthyUrl }), T);
    expect(healthy.route).toBe('HEALTHY');
    const h = save(ctx, assembleRecommendation(ctx.siteId, { candidates: [], siteDecision: null, pageRoute: { route: healthy.route, reasons: healthy.reasons, pageId: healthyId, url: healthyUrl }, prior: emptyPrior(), ...OPTS }));
    const hr = claimRow(ctx, h, 'primary.route');
    expect(hr).toMatchObject({ support: 'supports', source_type: 'gsc', date_range_start: '2026-08-25', date_range_end: '2026-09-21' });
    const hv = JSON.parse(hr.value_json!) as { reasons: Array<{ code: string; values?: Record<string, unknown>; rows?: unknown[] }> };
    expect(hv.reasons.map((r) => r.code)).toEqual(['SUFFICIENT_EXPOSURE', 'STABLE', 'CTR_NOT_WEAK', 'CONVERSIONS_NOT_POOR', 'NO_RANKING_CANDIDATE_WITH_BUSINESS_EVIDENCE']);
    expect(hv.reasons[0]!.values).toEqual({ impressions: 5000, googleOrganicSessions: 280 });
    expect(hv.reasons[1]!.values).toMatchObject({ previousClicks: 310, currentClicks: 300 });

    // LOW_DATA (page below the evidence threshold, with observed but small counts).
    const lowUrl = `${HOST}/small`;
    const lowId = seed.page(lowUrl);
    const low = evaluateRoute(
      baseInput({
        pageId: lowId,
        url: lowUrl,
        search: { clicks: observed(3), impressions: observed(60), ctr: observed(0.05), position: observed(3), expectedCtr: observed(0.05), previousClicks: observed(3), previousImpressions: observed(55) },
        queries: [q('what is a widget', { clicks: 2, impressions: 40, position: 3, expectedCtr: 0.05 })],
        business: { sessions: observed(12), convertingSessions: observed(0), conversionRate: observed(0), benchmarkConversionRate: observed(0.025), previousConvertingSessions: observed(0) },
      }),
      T,
    );
    expect(low.route).toBe('LOW_DATA');
    const l = save(ctx, assembleRecommendation(ctx.siteId, { candidates: [], siteDecision: null, pageRoute: { route: low.route, reasons: low.reasons, pageId: lowId, url: lowUrl, period: low.period }, prior: emptyPrior(), ...OPTS }));
    const lr = claimRow(ctx, l, 'primary.route');
    expect(lr).toMatchObject({ support: 'supports', source_type: 'gsc', date_range_start: '2026-08-25' });
    expect(JSON.parse(lr.value_json!).reasons[0]).toMatchObject({ code: 'PAGE_BELOW_EVIDENCE_THRESHOLD', values: { impressions: 60, sessions: 12, minImpressions: 100, minSessions: 200 } });

    // Site-level LOW_DATA (bootstrap): the observation cites the property totals it rests on.
    const site = routeSite({ siteId: ctx.siteId, period: { start: '2026-08-25', end: '2026-09-21' }, gsc: 'complete', gscDetail: 'ok', ga4: 'complete', ga4Detail: 'ok', conversionDefinition: 'configured', totalImpressions: observed(80), windowDays: 28, notSetShare: observed(0) }, T)!;
    expect(site.route).toBe('LOW_DATA');
    const s = save(ctx, assembleRecommendation(ctx.siteId, { candidates: [], siteDecision: site, prior: emptyPrior(), ...OPTS }));
    expect(claimRow(ctx, s, 'primary.low_data')).toMatchObject({ claim_label: 'OBSERVED', support: 'supports', source_type: 'gsc' });
    expect(JSON.parse(claimRow(ctx, s, 'primary.low_data').locator_json!)).toMatchObject({ table: 'gsc_property_daily_current' });

    expect(unsupported(ctx)).toEqual([]);
  });

  it('a route or observation with no measured input is context (no evidence), never "supports" without an evidence item', () => {
    ctx = createTestContext({ config: scenarioConfig() });
    const seed = new SeoSeeder(ctx.db, ctx.siteId);
    const url = `${HOST}/tested`;
    const pageId = seed.page(url);
    // EXPERIMENT_ACTIVE rests on an experiment record; UNSURE (no rule matched) on nothing measured.
    const exp = evaluateRoute(baseInput({ pageId, url, experiments: [{ id: 'exp_1', status: 'observing', type: 'title_meta', observationEnd: '2026-10-20', reviewDate: null }] }), T);
    expect(exp.route).toBe('EXPERIMENT_ACTIVE');
    const e = save(ctx, assembleRecommendation(ctx.siteId, { candidates: [], siteDecision: null, pageRoute: { route: exp.route, reasons: exp.reasons, pageId, url }, prior: emptyPrior(), ...OPTS }));
    expect(claimRow(ctx, e, 'primary.route')).toMatchObject({ claim_label: 'INFERRED', support: 'context', evidence_id: null });
    const unsure = evaluateRoute(baseInput({ pageId, url, search: { ...baseInput().search, impressions: unavailable('not synced'), clicks: unavailable('not synced') }, queries: [] }), T);
    expect(unsure.route).toBe('UNSURE');
    const u = save(ctx, assembleRecommendation(ctx.siteId, { candidates: [], siteDecision: null, pageRoute: { route: unsure.route, reasons: unsure.reasons, pageId, url }, prior: emptyPrior(), ...OPTS }));
    expect(claimRow(ctx, u, 'primary.route')).toMatchObject({ support: 'context', evidence_id: null });
    // Route counts of the run and a running site-wide experiment are records, not measurements.
    const none = save(ctx, assembleRecommendation(ctx.siteId, { candidates: [], siteDecision: null, routeCounts: { HEALTHY: 4 }, prior: emptyPrior(), ...OPTS }));
    expect(claimRow(ctx, none, 'primary.routes')).toMatchObject({ claim_label: 'OBSERVED', support: 'context', evidence_id: null });
    // Reasons stored before inputs were recorded (older route decisions) are context too.
    const legacy = save(ctx, assembleRecommendation(ctx.siteId, { candidates: [{ ...candidate(exp, pageId, url, null), route: 'CTR_OPPORTUNITY', reasons: [{ code: 'CTR_BELOW_COMPARABLE', detail: 'stored without inputs (synthetic)' }] }], siteDecision: null, prior: emptyPrior(), ...OPTS }));
    expect(claimRow(ctx, legacy, 'primary.route')).toMatchObject({ support: 'context', evidence_id: null });
    expect(unsupported(ctx)).toEqual([]);
  });

  it('the routing run over the synthetic scenario: reasons read back from route_decisions keep their inputs, and every "supports" claim has an evidence item (synthetic source)', async () => {
    ctx = createTestContext({ config: scenarioConfig() });
    seedScenario(new SeoSeeder(ctx.db, ctx.siteId));
    new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    const deps = { db: ctx.db, siteId: ctx.siteId, config: ctx.config, clock: ctx.clock };
    const site = prepareSiteAnalysis(deps);
    const run = await routeAllPages(deps, site, { persist: true });
    const candidates = loadCandidates(ctx.db, ctx.siteId);
    expect(candidates.map((c) => c.route).sort()).toEqual(['INDEXING_UNKNOWN', 'TECHNICAL_BLOCKER']);
    expect(candidates.every((c) => c.reasons.some((r) => reasonInputs(r) !== null))).toBe(true);
    const set = assembleRecommendation(ctx.siteId, { candidates, siteDecision: site.siteDecision, routeCounts: run.counts, prior: await loadPriorContext(ctx.db, ctx.siteId, { today: site.today }), ...OPTS });
    const saved = persistRecommendationSet(ctx.db, ctx.siteId, set, { now: ctx.clock.now() });
    expect(unsupported(ctx)).toEqual([]);
    const primary = claimRow(ctx, saved.primaryId, 'primary.route');
    expect(primary).toMatchObject({ support: 'supports', source_type: 'fixture', trust_class: 'synthetic' });
    expect(JSON.parse(primary.value_json!).reasons[0]).toMatchObject({ code: 'CONFIRMED_TECHNICAL_ISSUE', source: 'crawl', table: 'technical_issues', values: { type: 'accidental_noindex', severity: 'critical', confirmed: true } });
    const secondaryKey = ctx.db.get<{ claim_key: string }>("SELECT claim_key FROM claim_evidence WHERE subject_id = ? AND claim_key LIKE 'secondary.%.route'", [saved.secondaryIds[0]!])!.claim_key;
    const secondary = claimRow(ctx, saved.secondaryIds[0]!, secondaryKey);
    expect(secondary).toMatchObject({ support: 'supports', source_type: 'fixture' });
    expect(JSON.parse(secondary.value_json!).reasons[0]).toMatchObject({ code: 'NO_IMPRESSIONS_NOT_INSPECTED', values: { impressions: 0 } });
    expect(JSON.parse(secondary.value_json!).notMeasured).toEqual(['NEVER_AUTO_DELETE_OR_REDIRECT']);
    // A healthy page of the same run, previewed alone (analyze page), is sourced as well.
    const guide = run.analyses.find((a) => a.page.url === `${HOST}/guide`)!;
    expect(guide.decision.route).toBe('HEALTHY');
    const preview = save(ctx, assembleRecommendation(ctx.siteId, { candidates: [], siteDecision: null, pageRoute: { route: guide.decision.route, reasons: guide.decision.reasons, pageId: guide.page.id, url: guide.page.url }, prior: emptyPrior(), synthetic: true, ...OPTS }));
    expect(claimRow(ctx, preview, 'primary.route')).toMatchObject({ support: 'supports', source_type: 'fixture', trust_class: 'synthetic' });
    expect(unsupported(ctx)).toEqual([]);
  });
});
