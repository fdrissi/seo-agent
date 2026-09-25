import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { analyzePage, coverageStatus, importOnlyTruncatedDates, measurementDisplayStatus, prepareSiteAnalysis, routeAllPages, type AnalysisDeps } from '../../../src/seo/page-analysis.js';
import { fullCoverage } from '../../../src/seo/coverage.js';
import { importDataset } from '../../../src/data/import.js';
import { GSC_PROPERTY, SITE_URL, reportsTestConfig, seedBatch } from '../../fixtures/reports/seed.js';
import { UrlReconciler } from '../../../src/seo/reconcile.js';
import { SCORING_VERSION } from '../../../src/seo/scoring.js';
import { createLlmIntentClassifier } from '../../../src/router/llm-intent.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import { FakeLlm } from '../../fixtures/seo/fake-llm.js';
import { daily, GA4_PROPERTY as SEO_GA4_PROPERTY, PROPERTY, SeoSeeder } from '../../fixtures/seo/seed.js';
import { confirmRateScale } from '../../../src/integrations/google/ga4-metadata.js';
import { HOST, scenarioConfig, seedScenario } from '../../fixtures/seo/scenario.js';

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

function setup(config = scenarioConfig()) {
  ctx = createTestContext({ config });
  const seed = new SeoSeeder(ctx.db, ctx.siteId);
  return seed;
}

function deps(extra: Partial<AnalysisDeps> = {}): AnalysisDeps {
  return { db: ctx.db, siteId: ctx.siteId, config: ctx.config, clock: ctx.clock, ...extra };
}

function pageId(url: string): string {
  const r = new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).resolve(url);
  if (r.status !== 'resolved') throw new Error(`unresolved ${url}`);
  return r.pageId;
}

describe('routing pages from the database', () => {
  it('routes healthy, experiment, blocker, ambiguous, and unindexed pages; persists explainable decisions', async () => {
    const seed = setup();
    seedScenario(seed);
    new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    seed.experiment({ pageId: pageId(`${HOST}/pricing`), status: 'observing', type: 'title_meta', observationEnd: '2026-10-15' });
    const site = prepareSiteAnalysis(deps());
    expect(site.period.period).toEqual({ start: '2026-08-24', end: '2026-09-20' });
    expect(site.gsc.status).toBe('complete');
    expect(site.ga4.status).toBe('complete');
    expect(site.lowData).toBe(false);
    expect(site.siteDecision).toBeNull();

    const run = await routeAllPages(deps(), site, { persist: true });
    const byUrl = Object.fromEntries(run.analyses.map((a) => [a.page.url.replace(HOST, ''), a]));
    expect(byUrl['/guide']!.decision.route).toBe('HEALTHY');
    expect(byUrl['/pricing']!.decision.route).toBe('EXPERIMENT_ACTIVE');
    expect(byUrl['/broken']!.decision.route).toBe('TECHNICAL_BLOCKER');
    expect(byUrl['/blue']!.decision.route).toBe('UNSURE');
    expect(byUrl['/blue']!.decision.reasons.map((r) => r.code)).toContain('AMBIGUOUS_INTENT');
    expect(byUrl['/new']!.decision.route).toBe('INDEXING_UNKNOWN');

    const rows = ctx.db.all<{ route: string; reason_codes_json: string; decided_by: string; rules_version: string; period_start: string; subject_type: string }>('SELECT route, reason_codes_json, decided_by, rules_version, period_start, subject_type FROM route_decisions WHERE site_id = ?', [ctx.siteId]);
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.decided_by).toBe('rule');
      expect(r.rules_version).toMatch(/^router-rules@/);
      expect(r.period_start).toBe('2026-08-24');
      expect(JSON.parse(r.reason_codes_json).length).toBeGreaterThan(0);
    }
    // Opportunities for scored routes; raw counts are kept next to the score.
    const opps = ctx.db.all<{ route: string; kind: string; raw_counts_json: string; scoring_version: string; status: string }>('SELECT route, kind, raw_counts_json, scoring_version, status FROM opportunities WHERE site_id = ? ORDER BY route', [ctx.siteId]);
    expect(opps.map((o) => o.route)).toEqual(['INDEXING_UNKNOWN', 'TECHNICAL_BLOCKER']);
    expect(opps.every((o) => o.kind === 'technical' && o.scoring_version === SCORING_VERSION && o.status === 'candidate')).toBe(true);
    expect(JSON.parse(opps[1]!.raw_counts_json)).toMatchObject({ impressions: 1400, sessions: 56 });
    // Query intents recorded with their source.
    const kw = ctx.db.all<{ normalized: string; intent: string; intent_source: string; is_branded: number }>('SELECT normalized, intent, intent_source, is_branded FROM keywords WHERE site_id = ? ORDER BY normalized', [ctx.siteId]);
    expect(kw.find((k) => k.normalized === 'acme widgets pricing')).toMatchObject({ is_branded: 1, intent_source: 'rule' });
    expect(kw.find((k) => k.normalized === 'blue widgets')).toMatchObject({ intent: 'unsure' });

    // Re-running does not duplicate opportunities for the same period.
    await routeAllPages(deps(), prepareSiteAnalysis(deps()), { persist: true });
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM opportunities WHERE site_id = ?', [ctx.siteId])!.n).toBe(2);
  });

  it('uses the model classifier only for ambiguous queries and records decided_by = model', async () => {
    const seed = setup();
    seedScenario(seed, { withBrokenIssue: false });
    new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    const llm = new FakeLlm((req) => ({ classifications: req.evidence.map((e) => ({ query: JSON.parse(e.text).query, intent: 'commercial', rationale: 'synthetic' })) }));
    const d = deps({ intentHook: createLlmIntentClassifier(llm, { siteId: ctx.siteId, runId: 'run_t' }) });
    const site = prepareSiteAnalysis(d);
    const rec = new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock);
    const blue = rec.pageById(pageId(`${HOST}/blue`))!;
    const a = await analyzePage(d, site, blue);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.evidence.map((e) => JSON.parse(e.text).query)).toEqual(['blue widgets']);
    expect(a.decision.route).toBe('RANKING_OPPORTUNITY');
    expect(a.decision.decidedBy).toBe('model');
    expect(a.score).not.toBeNull();
  });

  it('routes a low-data site to LOW_DATA with a site-level bootstrap decision', async () => {
    const seed = setup(scenarioConfig());
    const s = '2026-08-24';
    const e = '2026-09-20';
    seed.gscProperty(daily(s, e, (date) => ({ date, clicks: 0, impressions: 6, position: 12 })));
    seed.gscPage(daily(s, e, (date) => ({ date, page: `${HOST}/`, clicks: 0, impressions: 3, position: 12 })));
    seed.ga4Landing(daily(s, e, (date) => ({ date, landingPage: '/', sessions: 1, rate: 0, rateStatus: 'observed' as const })));
    new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    const site = prepareSiteAnalysis(deps());
    expect(site.lowData).toBe(true);
    expect(site.siteDecision?.route).toBe('LOW_DATA');
    const run = await routeAllPages(deps(), site, { persist: true });
    expect(run.analyses[0]!.decision.route).toBe('LOW_DATA');
    expect(run.analyses[0]!.decision.reasons[0]!.code).toBe('SITE_LOW_DATA');
    expect(run.siteDecisionId).not.toBeNull();
  });

  it('routes missing measurement to INVALID_OR_INCOMPLETE_DATA instead of optimizing', async () => {
    const seed = setup(testSiteConfig({ google: { searchConsoleProperty: PROPERTY } as never }));
    seed.gscPage(daily('2026-08-24', '2026-09-20', (date) => ({ date, page: `${HOST}/guide`, clicks: 40, impressions: 700, position: 6 })));
    new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    const site = prepareSiteAnalysis(deps());
    expect(site.siteDecision?.route).toBe('INVALID_OR_INCOMPLETE_DATA');
    expect(site.siteDecision?.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['GA4_PROPERTY_UNRESOLVED', 'MISSING_CONVERSION_DEFINITION']));
    const run = await routeAllPages(deps(), site, { persist: false });
    expect(run.analyses[0]!.decision.route).toBe('INVALID_OR_INCOMPLETE_DATA');
    expect(run.analyses[0]!.score).toBeNull(); // one site-level decision, not a measurement opportunity per page
  });
});

describe('row-limit truncation is a coverage warning, not a site-wide measurement failure', () => {
  it('ignores segment batches and dates outside the window, and warns (without blocking) for truncated dates inside it', async () => {
    const seed = setup();
    seedScenario(seed);
    // Device-segment batch, truncated on a date outside the analysis window.
    const seg = seed.batch('gsc', 'gsc_page_daily', PROPERTY, '2026-08-01', '2026-09-20', { request: { type: 'web', dataState: 'all', dimensions: ['date', 'page', 'device'] }, status: 'partial', truncated: true });
    ctx.db.run('UPDATE ingestion_batches SET coverage_json = ? WHERE id = ?', [JSON.stringify({ truncatedDates: ['2026-08-01'] }), seg]);
    new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    let site = prepareSiteAnalysis(deps());
    expect(site.gsc.status).toBe('complete');
    expect(site.gsc.coverage!.truncated).toEqual([]);
    expect(site.siteDecision).toBeNull();
    // The no-segment page totals hit the row ceiling on one date inside the window.
    const base = seed.batch('gsc', 'gsc_page_daily', PROPERTY, '2026-09-10', '2026-09-10', { request: { type: 'web', dataState: 'all', dimensions: ['date', 'page'] }, status: 'partial', truncated: true });
    ctx.db.run('UPDATE ingestion_batches SET coverage_json = ? WHERE id = ?', [JSON.stringify({ truncatedDates: ['2026-09-10'] }), base]);
    ctx.db.run("UPDATE ingestion_batches SET status = 'failed' WHERE site_id = ? AND source = 'gsc' AND dataset = 'gsc_page_daily' AND id NOT IN (?, ?) AND date_start <= '2026-09-10' AND date_end >= '2026-09-10'", [ctx.siteId, base, seg]);
    site = prepareSiteAnalysis(deps());
    expect(site.gsc.coverage!.truncated).toEqual(['2026-09-10']);
    expect(site.gsc.status).toBe('complete');
    expect(site.siteDecision).toBeNull();
    expect(site.warnings.join(' ')).toMatch(/1 date\(s\) hit a documented row limit/);
    const run = await routeAllPages(deps(), site, { persist: false });
    // Pages with a row on the truncated date are unaffected; a page without one is flagged incomplete individually.
    expect(run.analyses.find((a) => a.page.url === `${HOST}/guide`)!.bundle.gsc!.completeness).toBe('complete');
    const fresh = run.analyses.find((a) => a.page.url === `${HOST}/new`)!;
    expect(fresh.bundle.gsc!.completeness).toBe('incomplete');
    expect(fresh.decision.route).not.toBe('INDEXING_UNKNOWN'); // a possibly-omitted row is never read as zero impressions
  });
});

describe('technical blockers from the crawler vocabulary', () => {
  const LATER = '2026-09-24T05:00:00.000Z';
  const EARLIER = '2026-09-24T03:00:00.000Z'; // after the scenario crawl (00:00)

  it('routes a page whose own latest crawl returned 410 (with a confirmed broken_internal_link) to TECHNICAL_BLOCKER', async () => {
    const seed = setup();
    seedScenario(seed, { withBrokenIssue: false });
    const crawl = seed.crawl('own_site', { startedAt: LATER });
    seed.crawlResult(crawl, { requestedUrl: `${HOST}/guide`, status: 410, fetchedAt: LATER });
    // Exactly as src/crawler/checks.ts writes it: type broken_internal_link, severity high, confirmed for 404/410.
    seed.technicalIssue({ url: `${HOST}/guide`, type: 'broken_internal_link', severity: 'high', confirmed: true, detail: { status: 410, linkCount: 1, note: 'Observed 404/410 on an internally linked URL.' } });
    // A confirmed but info-level access barrier (intentional member area) stays a note.
    seed.technicalIssue({ url: `${HOST}/pricing`, type: 'access_blocked', severity: 'info', confirmed: true, detail: { blockedReason: 'login_required', note: 'May be intentional.' } });
    new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    const run = await routeAllPages(deps(), prepareSiteAnalysis(deps()), { persist: false });
    const byUrl = Object.fromEntries(run.analyses.map((a) => [a.page.url.replace(HOST, ''), a]));
    const guide = byUrl['/guide']!;
    expect(guide.bundle.input.technical.latestCrawlStatus).toBe(410);
    expect(guide.decision.route).toBe('TECHNICAL_BLOCKER');
    expect(guide.decision.reasons.map((r) => r.code).sort()).toEqual(['CONFIRMED_TECHNICAL_ISSUE', 'CRAWL_HTTP_ERROR']);
    expect(guide.decision.reasons.find((r) => r.code === 'CONFIRMED_TECHNICAL_ISSUE')!.detail).toMatch(/^broken_internal_link \(high\): HTTP 410/);
    const pricing = byUrl['/pricing']!;
    expect(pricing.decision.route).not.toBe('TECHNICAL_BLOCKER');
    expect(pricing.decision.notes.find((n) => n.code === 'SUSPECTED_TECHNICAL_ISSUE')!.detail).toMatch(/observed, but not an access\/indexability blocker/);
  });

  it('treats 5xx as confirmed only when two consecutive own-site crawls saw it; a redirect row is never the page status', async () => {
    const seed = setup();
    seedScenario(seed, { withBrokenIssue: false });
    const c1 = seed.crawl('own_site', { startedAt: EARLIER });
    seed.crawlResult(c1, { requestedUrl: `${HOST}/guide`, status: 503, fetchedAt: EARLIER });
    const c2 = seed.crawl('own_site', { startedAt: LATER });
    seed.crawlResult(c2, { requestedUrl: `${HOST}/guide`, status: 502, fetchedAt: LATER });
    seed.crawlResult(c2, { requestedUrl: `${HOST}/blue`, status: 503, fetchedAt: LATER });
    // A redirecting row whose FINAL url is /pricing (first status 301) is not an observation of /pricing's response.
    seed.crawlerRedirect(c2, `${HOST}/pricing-old`, `${HOST}/pricing`, { fetchedAt: LATER });
    new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    const run = await routeAllPages(deps(), prepareSiteAnalysis(deps()), { persist: false });
    const byUrl = Object.fromEntries(run.analyses.map((a) => [a.page.url.replace(HOST, ''), a]));
    expect(byUrl['/guide']!.decision.route).toBe('TECHNICAL_BLOCKER');
    expect(byUrl['/guide']!.decision.reasons[0]!.detail).toMatch(/http_5xx_repeated/);
    expect(byUrl['/blue']!.decision.route).not.toBe('TECHNICAL_BLOCKER');
    expect(byUrl['/blue']!.decision.notes.some((n) => n.code === 'SUSPECTED_TECHNICAL_ISSUE' && /may be transient/.test(n.detail))).toBe(true);
    expect(byUrl['/pricing']!.bundle.input.technical.latestCrawlStatus).toBe(200);
  });
});

describe('merged identities and join issues', () => {
  it('does not route pages merged into another page by canonical or configured evidence', async () => {
    const seed = setup(scenarioConfig({ site: { id: 'test-site', businessName: 'Test Co (synthetic)', url: 'https://www.example.test/', allowedHostnames: ['www.example.test'], urlAliases: [{ alias: `${HOST}/old-pricing`, canonical: `${HOST}/pricing`, evidence: 'owner: renamed' }] } }));
    seedScenario(seed);
    seed.page(`${HOST}/old-pricing`, { firstSource: 'crawl' });
    const crawl = seed.crawl('own_site', { startedAt: '2026-09-24T05:00:00.000Z' });
    seed.crawlResult(crawl, { requestedUrl: `${HOST}/guide`, canonical: `${HOST}/guide`, fetchedAt: '2026-09-24T05:00:00.000Z' });
    seed.crawlResult(crawl, { requestedUrl: `${HOST}/guide?print=1`, canonical: `${HOST}/guide`, fetchedAt: '2026-09-24T05:00:00.000Z' });
    seed.gscPage(daily('2026-08-24', '2026-09-20', (date) => ({ date, page: `${HOST}/guide?print=1`, clicks: 3, impressions: 90, position: 4 })));
    const report = new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    expect(report.canonicals.established).toBe(1);
    const run = await routeAllPages(deps(), prepareSiteAnalysis(deps()), { persist: false });
    const routed = run.analyses.map((a) => a.page.url);
    expect(routed).not.toContain(`${HOST}/guide?print=1`);
    expect(routed).not.toContain(`${HOST}/old-pricing`);
    expect(run.merged.map((m) => [m.url, m.mergedInto.url, m.relations])).toEqual(
      expect.arrayContaining([
        [`${HOST}/guide?print=1`, `${HOST}/guide`, ['canonical']],
        [`${HOST}/old-pricing`, `${HOST}/pricing`, ['configured']],
      ]),
    );
    // No false "no impressions" INDEXING_UNKNOWN for the merged variant; its impressions count toward /guide.
    expect(run.analyses.filter((a) => a.decision.route === 'INDEXING_UNKNOWN').map((a) => a.page.url)).toEqual([`${HOST}/new`]);
    const guide = run.analyses.find((a) => a.page.url === `${HOST}/guide`)!;
    expect(guide.bundle.gsc!.impressions).toEqual({ status: 'observed', value: (700 + 90) * 28 });
  });

  it('routes pages with unjoined GA4 sessions or split variants to INVALID_OR_INCOMPLETE_DATA (JOIN_UNRESOLVED)', async () => {
    const seed = setup();
    seedScenario(seed);
    // An http identity for /blue appears without merge evidence: GA4 "/blue" rows (no scheme) can no longer be joined.
    seed.gscPage(daily('2026-08-24', '2026-09-20', (date) => ({ date, page: 'http://www.example.test/blue', clicks: 0, impressions: 5, position: 30 })));
    // A one-way (probable) canonical variant of /pricing carries its own impressions.
    const crawl = seed.crawl('own_site', { startedAt: '2026-09-24T05:00:00.000Z' });
    seed.crawlResult(crawl, { requestedUrl: `${HOST}/pricing?ref=nav`, canonical: `${HOST}/pricing`, fetchedAt: '2026-09-24T05:00:00.000Z' });
    seed.gscPage(daily('2026-08-24', '2026-09-20', (date) => ({ date, page: `${HOST}/pricing?ref=nav`, clicks: 1, impressions: 20, position: 3 })));
    const report = new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    expect(report.unresolved.some((u) => u.dataset === 'ga4_landing_daily' && u.reason === 'ambiguous_scheme')).toBe(true);
    const run = await routeAllPages(deps(), prepareSiteAnalysis(deps()), { persist: false });
    const byUrl = Object.fromEntries(run.analyses.map((a) => [a.page.url, a]));
    const blue = byUrl[`${HOST}/blue`]!;
    expect(blue.decision.route).toBe('INVALID_OR_INCOMPLETE_DATA');
    expect(blue.bundle.input.measurement.joinIssues[0]).toMatch(/google_organic session\(s\) for www\.example\.test\/blue are not joined to any page/);
    const pricing = byUrl[`${HOST}/pricing`]!;
    expect(pricing.decision.route).toBe('INVALID_OR_INCOMPLETE_DATA');
    expect(pricing.bundle.input.measurement.joinIssues.join(' ')).toMatch(/canonical evidence from https:\/\/www\.example\.test\/pricing\?ref=nav is probable \(not merged\)/);
    // Pages without split or unjoined data are unaffected.
    expect(byUrl[`${HOST}/guide`]!.bundle.input.measurement.joinIssues).toEqual([]);
  });
});

describe('experiments beyond the page itself', () => {
  it('notes site-wide experiments and control pages on every affected page', async () => {
    const seed = setup();
    seedScenario(seed, { withBrokenIssue: false });
    new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    seed.experiment({ pageId: null, status: 'observing', type: 'title_meta', observationEnd: '2026-10-20' });
    seed.experiment({ pageId: pageId(`${HOST}/pricing`), status: 'observing', type: 'content_section', comparisonPages: [{ pageId: pageId(`${HOST}/guide`), url: `${HOST}/guide` }] });
    const run = await routeAllPages(deps(), prepareSiteAnalysis(deps()), { persist: false });
    const byUrl = Object.fromEntries(run.analyses.map((a) => [a.page.url.replace(HOST, ''), a]));
    expect(byUrl['/pricing']!.decision.route).toBe('EXPERIMENT_ACTIVE');
    const guideNotes = byUrl['/guide']!.decision.notes.map((n) => n.code);
    expect(guideNotes).toEqual(expect.arrayContaining(['EXPERIMENT_SITE_WIDE', 'EXPERIMENT_CONTROL_PAGE']));
    expect(byUrl['/blue']!.decision.notes.map((n) => n.code)).toContain('EXPERIMENT_SITE_WIDE');
  });
});

describe('re-routing supersedes stale opportunities', () => {
  it('archives a page\'s earlier opportunity for the same period when its route changes', async () => {
    const seed = setup();
    seedScenario(seed);
    new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    await routeAllPages(deps(), prepareSiteAnalysis(deps()), { persist: true });
    const open = () => ctx.db.all<{ route: string; page_id: string }>("SELECT route, page_id FROM opportunities WHERE site_id = ? AND status IN ('candidate', 'shortlisted') ORDER BY route", [ctx.siteId]);
    expect(open().map((o) => o.route)).toEqual(['INDEXING_UNKNOWN', 'TECHNICAL_BLOCKER']);
    // /new gets an indexed URL Inspection verdict: it is no longer INDEXING_UNKNOWN.
    seed.inspection({ url: `${HOST}/new`, pageId: pageId(`${HOST}/new`), verdict: 'PASS', coverageState: 'Submitted and indexed' });
    const run2 = await routeAllPages(deps(), prepareSiteAnalysis(deps()), { persist: true });
    expect(run2.analyses.find((a) => a.page.url === `${HOST}/new`)!.decision.route).toBe('LOW_DATA');
    expect(open().map((o) => o.route)).toEqual(['TECHNICAL_BLOCKER']);
    const stale = ctx.db.get<{ status: string; status_reason: string }>("SELECT status, status_reason FROM opportunities WHERE site_id = ? AND route = 'INDEXING_UNKNOWN'", [ctx.siteId])!;
    expect(stale.status).toBe('archived');
    expect(stale.status_reason).toMatch(/^superseded: page re-routed to LOW_DATA/);
    expect(run2.persisted.find((p) => p.pageId === pageId(`${HOST}/new`))!.superseded).toBe(1);
  });
});

describe('configured router thresholds, rule order, and page types reach routing (A6-13, A6-03)', () => {
  it('passes router.ruleOrder (validated, prerequisites first) to every page decision and to the site decision version', async () => {
    const seed = setup(scenarioConfig({ router: { ruleOrder: ['ctr', 'ranking'] } }));
    seedScenario(seed);
    new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    const site = prepareSiteAnalysis(deps());
    expect(site.ruleOrder!.slice(0, 5)).toEqual(['invalid_data', 'technical_blocker', 'experiment_active', 'ctr', 'ranking']);
    const run = await routeAllPages(deps(), site, { persist: false });
    for (const a of run.analyses) expect(a.decision.trace.map((t) => t.rule)).toEqual(site.ruleOrder);
    const defaultSite = prepareSiteAnalysis(deps({ ruleOrder: [] }));
    const defaultRun = await routeAllPages(deps({ ruleOrder: [] }), defaultSite, { persist: false });
    expect(run.analyses[0]!.decision.rulesVersion).not.toBe(defaultRun.analyses[0]!.decision.rulesVersion);
    // An invalid order is refused loudly (never silently ignored).
    expect(() => prepareSiteAnalysis(deps({ ruleOrder: ['ctr', 'nonsense'] }))).toThrow(/router.ruleOrder is invalid/);
  });

  it('a configured commercial page type is business evidence for a ranking candidate', async () => {
    const seed = setup(scenarioConfig({ site: { id: 'test-site', businessName: 'Test Co (synthetic)', url: 'https://www.example.test/', allowedHostnames: ['www.example.test'], pageTypes: [{ match: '/blue', type: 'service' }] }, router: { commercialPageTypes: ['service'] } }));
    seedScenario(seed);
    new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    const site = prepareSiteAnalysis(deps());
    const run = await routeAllPages(deps(), site, { persist: false });
    const blue = run.analyses.find((a) => a.page.url === `${HOST}/blue`)!;
    expect(blue.page.pageType).toBe('service');
    expect(blue.decision.reasons.map((r) => r.code)).toContain('BUSINESS_EVIDENCE_PAGE_TYPE');
    expect(blue.decision.route).toBe('RANKING_OPPORTUNITY');
  });
});

describe('an unverified GA4 rate scale does not block routing (B3-01)', () => {
  it('routes pages with sessions on their search signals, notes the unverified scale, and uses the rate once the owner confirms it', async () => {
    const seed = setup();
    seedScenario(seed);
    new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    // GA4 reported the rates, but nothing established 0-1 vs 0-100 for this property yet.
    ctx.db.run("UPDATE ga4_landing_daily SET primary_session_rate_scale = 'undetermined' WHERE site_id = ? AND primary_session_rate IS NOT NULL", [ctx.siteId]);
    let run = await routeAllPages(deps(), prepareSiteAnalysis(deps()), { persist: false });
    let byUrl = Object.fromEntries(run.analyses.map((a) => [a.page.url.replace(HOST, ''), a]));
    for (const a of run.analyses) expect(a.decision.route).not.toBe('INVALID_OR_INCOMPLETE_DATA');
    const guide = byUrl['/guide']!;
    expect(guide.decision.route).toBe('HEALTHY');
    expect(guide.bundle.input.measurement.primaryRateGap).toBeNull();
    expect(guide.bundle.input.measurement.rateScaleUnverified).toMatch(/^rate scale unverified/);
    expect(guide.decision.reasons.find((r) => r.code === 'CONVERSIONS_NOT_ASSESSED')!.detail).toMatch(/rate scale unverified/);
    expect(guide.decision.notes.find((n) => n.code === 'RATE_SCALE_UNVERIFIED')!.detail).toContain('--confirm-rate-scale fraction|percent');
    expect(byUrl['/blue']!.decision.route).toBe('UNSURE');
    expect(byUrl['/broken']!.decision.route).toBe('TECHNICAL_BLOCKER');

    confirmRateScale(ctx, SEO_GA4_PROPERTY, { scale: 'fraction', evidence: 'GA4 UI shows 2.00% for /guide on 2026-09-01; stored 0.02', actor: 'Alice' });
    run = await routeAllPages(deps(), prepareSiteAnalysis(deps()), { persist: false });
    byUrl = Object.fromEntries(run.analyses.map((a) => [a.page.url.replace(HOST, ''), a]));
    const confirmed = byUrl['/guide']!;
    expect(confirmed.bundle.ga4!.primaryConversionRate).toEqual({ status: 'observed', value: 0.02 });
    expect(confirmed.bundle.input.measurement.rateScaleUnverified).toBeNull();
    expect(confirmed.decision.route).toBe('HEALTHY');
    expect(confirmed.decision.reasons.map((r) => r.code)).toContain('CONVERSIONS_NOT_POOR');
    expect(confirmed.decision.notes.map((n) => n.code)).not.toContain('RATE_SCALE_UNVERIFIED');
  });
});

describe('GA4 row loss: a page absent from a thresholded report is not an observed zero (B2-04)', () => {
  it('sessions become incomplete (not 0), so search clicks without sessions are not called a join gap', async () => {
    const seed = setup();
    seedScenario(seed, { withBrokenIssue: false });
    // /lost has Search Console clicks but no GA4 landing row at all.
    seed.gscPage(daily('2026-07-24', '2026-09-20', (date) => ({ date, page: `${HOST}/lost`, clicks: 30, impressions: 400, position: 3 })));
    new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    const lostOf = async () => (await routeAllPages(deps(), prepareSiteAnalysis(deps()), { persist: false })).analyses.find((a) => a.page.url === `${HOST}/lost`)!;
    // A complete GA4 report without row loss proves 0 sessions: a real join gap.
    let lost = await lostOf();
    expect(lost.bundle.ga4!.sessions).toEqual({ status: 'observed', value: 0 });
    expect(lost.decision.reasons.map((r) => r.code)).toContain('JOIN_UNRESOLVED');
    // The same report, but GA4 said it was subject to thresholding: the missing row may have been withheld.
    ctx.db.run("UPDATE ingestion_batches SET metadata_json = ? WHERE site_id = ? AND source = 'ga4' AND dataset = 'ga4_landing_daily'", [JSON.stringify({ subjectToThresholding: true }), ctx.siteId]);
    const site = prepareSiteAnalysis(deps());
    expect(site.ga4.status).toBe('complete'); // not a site-wide measurement failure
    expect(site.warnings.join(' ')).toMatch(/where GA4 reported thresholding .*flagged incomplete individually, never counted as zero sessions/);
    lost = await lostOf();
    expect(lost.bundle.ga4!.sessions.status).toBe('incomplete');
    expect(lost.bundle.ga4!.sessions.status !== 'observed' && lost.bundle.ga4!.sessions.reason).toMatch(/unknown, not zero/);
    expect(lost.decision.reasons.map((r) => r.code)).not.toContain('JOIN_UNRESOLVED');
    expect(lost.decision.route).not.toBe('INVALID_OR_INCOMPLETE_DATA');
    // Pages that have rows keep their observed sessions.
    const guide = (await routeAllPages(deps(), prepareSiteAnalysis(deps()), { persist: false })).analyses.find((a) => a.page.url === `${HOST}/guide`)!;
    expect(guide.bundle.ga4!.sessions.status).toBe('observed');
  });
});

// C1-09: an owner import without --complete is stored truncated; it never hit an API row limit. The
// coverage detail says what it is, and the analyze headline shows the source as partial, not complete.
// SYNTHETIC CSV written by the test (reserved example.test domain, invented numbers), imported as the owner's
// live import (a live workspace refuses --synthetic, D1-R01).
describe('truncated owner imports are described as imports, not row limits (C1-09)', () => {
  const START = '2026-09-01';
  const END = '2026-09-03';
  function importPages(complete: boolean): void {
    ctx = createTestContext({ config: reportsTestConfig() });
    const file = path.join(ctx.paths.root, 'pages.csv');
    writeFileSync(
      file,
      ['Date,Page,Clicks,Impressions,CTR,Position', `2026-09-01,${SITE_URL}/pricing,6,100,6%,5.2`, `2026-09-02,${SITE_URL}/pricing,4,90,4.44%,5.8`, `2026-09-03,${SITE_URL}/pricing,5,95,5.26%,5.5`, `2026-09-01,${SITE_URL}/blog/guide,2,40,5%,12.5`].join('\n'),
    );
    expect(importDataset(ctx, 'gsc-pages', file, complete ? { complete: true } : {}).status).toBe('succeeded');
  }

  it('an import without --complete: the detail names the import, and the display status is partial', () => {
    importPages(false);
    const site = prepareSiteAnalysis(deps(), { days: 3, end: END });
    expect(site.gsc.coverage!.truncated).toEqual([START, '2026-09-02', END]);
    expect(site.gsc.status).toBe('complete'); // routing handles truncation per page
    expect(site.gsc.detail).toMatch(/3 date\(s\) come from an owner import without --complete \(e\.g\. 2026-09-01\): rows absent from the file are unknown, not zero/);
    expect(site.gsc.detail).not.toMatch(/row limit/);
    expect(site.warnings.join(' ')).not.toMatch(/documented row limit/);
    expect(measurementDisplayStatus(site.gsc.status, site.gsc.coverage)).toBe('partial');
    expect(importOnlyTruncatedDates(ctx.db, ctx.siteId, 'gsc_page_daily', site.gsc.property!, 'web', site.gsc.coverage!)).toEqual(new Set([START, '2026-09-02', END]));
    // A Search Console sync that hit the row limit on the last date: that date is a row limit, the others stay import-only.
    seedBatch(ctx.db, ctx.siteId, { source: 'gsc', dataset: 'gsc_page_daily', property: GSC_PROPERTY, start: END, end: END, status: 'partial', truncated: 1, coverage: { truncatedDates: [END] } });
    const both = prepareSiteAnalysis(deps(), { days: 3, end: END });
    expect(both.gsc.coverage!.truncated).toEqual([START, '2026-09-02', END]);
    expect(both.gsc.detail).toMatch(/1 date\(s\) hit a documented row limit \(e\.g\. 2026-09-03\).*; 2 date\(s\) come from an owner import without --complete \(e\.g\. 2026-09-01\)/);
  });

  it('an import with --complete is complete; a Search Console sync truncated on the same date is a row limit', () => {
    importPages(true);
    const site = prepareSiteAnalysis(deps(), { days: 3, end: END });
    expect(site.gsc.coverage!.truncated).toEqual([]);
    expect(measurementDisplayStatus(site.gsc.status, site.gsc.coverage)).toBe('complete');
    // Coverage-level: a truncated sync batch covering a date is described as a row limit, never as an import.
    const cov = { start: START, end: END, truncated: [END] };
    const gsc = seedBatch(ctx.db, ctx.siteId, { source: 'gsc', dataset: 'gsc_page_daily', property: GSC_PROPERTY, start: END, end: END, truncated: 1, coverage: { truncatedDates: [END] } });
    expect(gsc).toBeTruthy();
    expect(importOnlyTruncatedDates(ctx.db, ctx.siteId, 'gsc_page_daily', GSC_PROPERTY, 'web', cov).size).toBe(0);
    expect(coverageStatus({ ...fullCoverage(START, END), truncated: [END] }, 'Search Console').detail).toMatch(/1 date\(s\) hit a documented row limit/);
    expect(coverageStatus({ ...fullCoverage(START, END), truncated: [START, END] }, 'Search Console', { importTruncated: new Set([START]) }).detail).toMatch(/1 date\(s\) hit a documented row limit \(e\.g\. 2026-09-03\).*; 1 date\(s\) come from an owner import without --complete \(e\.g\. 2026-09-01\)/);
  });
});
