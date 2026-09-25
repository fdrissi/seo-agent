import { afterEach, describe, expect, it } from 'vitest';
import { valueOf } from '../../../src/core/measured.js';
import { ga4Coverage, gscCoverage } from '../../../src/seo/coverage.js';
import { joinAllPages, joinPagePeriod, queryImpactHypotheses } from '../../../src/seo/join.js';
import { ga4PageMetrics, ga4PageUsers, ga4PeriodUsers, gscPageMetrics, gscPropertyMetrics, gscQueryMetrics, type Ga4Scope, type GscScope } from '../../../src/seo/metrics.js';
import { defaultAnalysisPeriod, latestFinalGscDate } from '../../../src/seo/period.js';
import { UrlReconciler } from '../../../src/seo/reconcile.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { daily, GA4_PROPERTY, PROPERTY, SeoSeeder } from '../../fixtures/seo/seed.js';

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

const START = '2026-09-01';
const END = '2026-09-07';
const PAGE = 'https://www.example.test/widgets';
const gscScope: GscScope = { property: PROPERTY, searchType: 'web', start: START, end: END };
const ga4Scope: Ga4Scope = { propertyId: GA4_PROPERTY, channelView: 'google_organic', start: START, end: END, configuredPrimaryEvents: ['generate_lead'] };

function setup() {
  ctx = createTestContext();
  const seed = new SeoSeeder(ctx.db, ctx.siteId);
  return seed;
}

function reconcile(): UrlReconciler {
  const rec = new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock);
  rec.run();
  return rec;
}

describe('metrics from the database', () => {
  it('reads current revisions only and keeps property totals separate from page sums', () => {
    const seed = setup();
    seed.gscProperty(daily(START, END, (date) => ({ date, clicks: 100, impressions: 5000, position: 8 })));
    seed.gscPage(daily(START, END, (date) => ({ date, page: PAGE, clicks: 10, impressions: 200, position: 6 })));
    // An older, superseded revision must not be counted.
    const b = seed.batch('gsc', 'gsc_page_daily', PROPERTY, START, START);
    seed.gscPage([{ date: START, page: PAGE, clicks: 999, impressions: 9999, position: 1, revision: 0, isCurrent: false }], b);
    const rec = reconcile();
    const pageId = (rec.resolve(PAGE) as { pageId: string }).pageId;
    const page = gscPageMetrics(ctx.db, ctx.siteId, pageId, gscScope);
    expect(valueOf(page.clicks)).toBe(70);
    expect(valueOf(page.impressions)).toBe(1400);
    const site = gscPropertyMetrics(ctx.db, ctx.siteId, gscScope);
    expect(valueOf(site.clicks)).toBe(700); // property totals, never page sums
    expect(valueOf(site.impressions)).toBe(35000);
  });

  it('derives coverage from ingestion batches: collected-without-row is zero, uncollected is missing', () => {
    const seed = setup();
    seed.batch('gsc', 'gsc_page_daily', PROPERTY, START, '2026-09-05');
    seed.gscPage([{ date: START, page: PAGE, clicks: 3, impressions: 30, position: 4 }], seed.batch('gsc', 'gsc_page_daily', PROPERTY, START, START));
    const rec = reconcile();
    const pageId = (rec.resolve(PAGE) as { pageId: string }).pageId;
    const cov = gscCoverage(ctx.db, ctx.siteId, { dataset: 'gsc_page_daily', property: PROPERTY, searchType: 'web', start: START, end: END });
    expect(cov.missing).toEqual(['2026-09-06', '2026-09-07']);
    const m = gscPageMetrics(ctx.db, ctx.siteId, pageId, gscScope);
    expect(m.clicks.status).toBe('incomplete'); // 2 uncollected dates
    expect(m.clicks.status === 'incomplete' && m.clicks.partialValue).toBe(3);
    const collected = gscPageMetrics(ctx.db, ctx.siteId, pageId, { ...gscScope, end: '2026-09-05' });
    expect(valueOf(collected.clicks)).toBe(3); // 4 collected days without rows are zeros
    expect(latestFinalGscDate(ctx.db, ctx.siteId, PROPERTY, 'web')).toBe(START);
  });

  it('users are never summed across dates or sub-periods', () => {
    const seed = setup();
    seed.ga4Landing(daily(START, END, (date) => ({ date, landingPage: '/widgets', sessions: 10 })));
    seed.ga4Period({ start: START, end: '2026-09-03', metric: 'totalUsers', value: 20, landingPage: '/widgets' });
    seed.ga4Period({ start: '2026-09-04', end: END, metric: 'totalUsers', value: 25, landingPage: '/widgets' });
    const rec = reconcile();
    const pageId = (rec.resolve(PAGE) as { pageId: string }).pageId;
    const users = ga4PageUsers(ctx.db, ctx.siteId, pageId, { propertyId: GA4_PROPERTY, channelView: 'google_organic', start: START, end: END });
    expect(users.status).toBe('unavailable');
    expect(users.status !== 'observed' && users.reason).toMatch(/not additive.*2 sub-period/);
    seed.ga4Period({ start: START, end: END, metric: 'totalUsers', value: 38, landingPage: '/widgets' });
    expect(valueOf(ga4PeriodUsers(ctx.db, ctx.siteId, { propertyId: GA4_PROPERTY, channelView: 'google_organic', start: START, end: END, landingPage: '/widgets' }))).toBe(38); // not 45
  });

  it('users for a page are unavailable when another host shares its landing path (the period report is not split by host)', () => {
    const seed = setup();
    // SYNTHETIC: the same path on www and on a staging host of the same GA4 property.
    seed.ga4Landing(daily(START, END, (date) => ({ date, landingPage: '/widgets', sessions: 10 })));
    seed.ga4Landing(daily(START, END, (date) => ({ date, landingPage: '/widgets', hostName: 'staging.example.test', sessions: 3 })));
    seed.ga4Period({ start: START, end: END, metric: 'totalUsers', value: 38, landingPage: '/widgets' });
    const rec = reconcile();
    const pageId = (rec.resolve(PAGE) as { pageId: string }).pageId;
    const users = ga4PageUsers(ctx.db, ctx.siteId, pageId, { propertyId: GA4_PROPERTY, channelView: 'google_organic', start: START, end: END });
    expect(users.status).toBe('unavailable');
    expect(users.status !== 'observed' && users.reason).toMatch(/other hosts share this landing path/);
    expect(users.status !== 'observed' && users.reason).toContain('staging.example.test');
    // One host only: the period-level figure is this page's users.
    ctx.db.run("UPDATE ga4_landing_daily SET is_current = 0 WHERE site_id = ? AND host_name = 'staging.example.test'", [ctx.siteId]);
    expect(valueOf(ga4PageUsers(ctx.db, ctx.siteId, pageId, { propertyId: GA4_PROPERTY, channelView: 'google_organic', start: START, end: END }))).toBe(38);
  });

  it('chooses an analysis window ending at the latest date final in GSC and complete in GA4', () => {
    const seed = setup();
    seed.gscPage([...daily(START, '2026-09-05', (date) => ({ date, page: PAGE, clicks: 1, impressions: 10, position: 3 })), { date: '2026-09-06', page: PAGE, clicks: 1, impressions: 10, position: 3, isFinal: false }]);
    seed.ga4Landing([...daily(START, '2026-09-04', (date) => ({ date, landingPage: '/widgets', sessions: 1 })), { date: '2026-09-05', landingPage: '/widgets', sessions: 1, isComplete: false }]);
    const ap = defaultAnalysisPeriod(ctx.db, ctx.siteId, { gscProperty: PROPERTY, searchType: 'web', ga4PropertyId: GA4_PROPERTY, days: 7, today: '2026-09-24' });
    expect(ap.period).toEqual({ start: '2026-08-29', end: '2026-09-04' });
    expect(ap.previous).toEqual({ start: '2026-08-22', end: '2026-08-28' });
    expect(ap.weekdayAligned).toBe(true);
    const cov = ga4Coverage(ctx.db, ctx.siteId, { propertyId: GA4_PROPERTY, start: START, end: '2026-09-05' });
    expect(cov.incomplete).toEqual(['2026-09-05']);
  });
});

describe('coverage is scoped to the channel view / segment being aggregated', () => {
  it('a failed google_organic GA4 sync is missing data even when the all_organic sync succeeded', () => {
    const seed = setup();
    const allOrganic = seed.batch('ga4', 'ga4_landing_daily', GA4_PROPERTY, START, END, { request: { view: 'all_organic' } });
    seed.ga4Landing(daily(START, END, (date) => ({ date, landingPage: '/widgets', sessions: 9, channelView: 'all_organic' as const })), allOrganic);
    seed.batch('ga4', 'ga4_landing_daily', GA4_PROPERTY, START, END, { status: 'failed', request: { view: 'google_organic' } });
    seed.gscPage(daily(START, END, (date) => ({ date, page: PAGE, clicks: 5, impressions: 50, position: 4 })));
    const rec = reconcile();
    const pageId = (rec.resolve(PAGE) as { pageId: string }).pageId;
    const g = ga4PageMetrics(ctx.db, ctx.siteId, pageId, ga4Scope);
    expect(g.sessions.status).toBe('missing'); // never observed(0)
    expect(g.completeness).toBe('missing');
    expect(ga4Coverage(ctx.db, ctx.siteId, { propertyId: GA4_PROPERTY, start: START, end: END, channelView: 'google_organic' }).missing).toHaveLength(7);
    const all = ga4PageMetrics(ctx.db, ctx.siteId, pageId, { ...ga4Scope, channelView: 'all_organic' });
    expect(valueOf(all.sessions)).toBe(63);
    // The succeeded google_organic re-sync then proves collection: zero sessions become a real zero.
    seed.batch('ga4', 'ga4_landing_daily', GA4_PROPERTY, START, END, { request: { view: 'google_organic' } });
    expect(ga4PageMetrics(ctx.db, ctx.siteId, pageId, ga4Scope).sessions).toEqual({ status: 'observed', value: 0 });
  });

  it('a device-segment GSC batch never turns missing no-segment page rows into zeros', () => {
    const seed = setup();
    seed.gscPage([{ date: START, page: PAGE, clicks: 1, impressions: 10, position: 4 }], seed.batch('gsc', 'gsc_page_daily', PROPERTY, START, START, { request: { type: 'web', dataState: 'all', dimensions: ['date', 'page'] } }));
    // Segment request sets share the dataset: only the device segment was collected for the other dates.
    seed.batch('gsc', 'gsc_page_daily', PROPERTY, START, END, { request: { type: 'web', dataState: 'all', dimensions: ['date', 'page', 'device'] } });
    seed.batch('gsc', 'gsc_page_daily', PROPERTY, START, END, { request: { type: 'web', dataState: 'all', dimensions: ['date', 'page'], dimensionFilterGroups: [{ groupType: 'and', filters: [{ dimension: 'searchAppearance', operator: 'equals', expression: 'VIDEO' }] }] } });
    const rec = reconcile();
    const pageId = (rec.resolve(PAGE) as { pageId: string }).pageId;
    const cov = gscCoverage(ctx.db, ctx.siteId, { dataset: 'gsc_page_daily', property: PROPERTY, searchType: 'web', start: START, end: END });
    expect(cov.missing).toHaveLength(6);
    const m = gscPageMetrics(ctx.db, ctx.siteId, pageId, gscScope);
    expect(m.clicks.status).toBe('incomplete');
    expect(m.clicks.status === 'incomplete' && m.clicks.reason).toMatch(/6 date\(s\) not collected/);
    // The same batches do cover their own segments.
    expect(gscCoverage(ctx.db, ctx.siteId, { dataset: 'gsc_page_daily', property: PROPERTY, searchType: 'web', start: START, end: END, segmentKey: 'device=MOBILE' }).missing).toEqual([]);
    expect(gscCoverage(ctx.db, ctx.siteId, { dataset: 'gsc_page_daily', property: PROPERTY, searchType: 'web', start: START, end: END, segmentKey: 'searchAppearance=VIDEO' }).missing).toEqual([]);
    expect(gscCoverage(ctx.db, ctx.siteId, { dataset: 'gsc_page_daily', property: PROPERTY, searchType: 'web', start: START, end: END, segmentKey: 'searchAppearance=AMP' }).missing).toHaveLength(7);
  });

  it('attributes truncation per date from coverage_json and only to the scoped request set', () => {
    const seed = setup();
    const base = seed.batch('gsc', 'gsc_page_daily', PROPERTY, START, END, { request: { type: 'web', dataState: 'all', dimensions: ['date', 'page'] }, status: 'partial', truncated: true });
    ctx.db.run('UPDATE ingestion_batches SET coverage_json = ? WHERE id = ?', [JSON.stringify({ truncatedDates: ['2026-09-03'], retirement: { skippedChunks: [{ start: '2026-09-03', end: '2026-09-03', reasons: ['row ceiling reached on 2026-09-03'] }] } }), base]);
    // A truncated device-segment batch (truncated outside the window) must not affect the no-segment coverage.
    const seg = seed.batch('gsc', 'gsc_page_daily', PROPERTY, '2026-08-01', END, { request: { type: 'web', dataState: 'all', dimensions: ['date', 'page', 'device'] }, status: 'partial', truncated: true });
    ctx.db.run('UPDATE ingestion_batches SET coverage_json = ? WHERE id = ?', [JSON.stringify({ truncatedDates: ['2026-08-01'] }), seg]);
    const cov = gscCoverage(ctx.db, ctx.siteId, { dataset: 'gsc_page_daily', property: PROPERTY, searchType: 'web', start: START, end: END });
    expect(cov.truncated).toEqual(['2026-09-03']);
    expect(cov.missing).toEqual([]);
    // Pagination stopped on a chunk: every date of that chunk is truncated; a batch with no per-date detail is truncated everywhere.
    ctx.db.run('UPDATE ingestion_batches SET coverage_json = ? WHERE id = ?', [JSON.stringify({ truncatedDates: [], retirement: { skippedChunks: [{ start: '2026-09-05', end: '2026-09-06', reasons: ['pagination stopped at the page guard'] }] } }), base]);
    expect(gscCoverage(ctx.db, ctx.siteId, { dataset: 'gsc_page_daily', property: PROPERTY, searchType: 'web', start: START, end: END }).truncated).toEqual(['2026-09-05', '2026-09-06']);
    ctx.db.run('UPDATE ingestion_batches SET coverage_json = NULL WHERE id = ?', [base]);
    expect(gscCoverage(ctx.db, ctx.siteId, { dataset: 'gsc_page_daily', property: PROPERTY, searchType: 'web', start: START, end: END }).truncated).toHaveLength(7);
  });
});

describe('GSC x GA4 join at page/period grain', () => {
  function seedPageWithQueries(seed: SeoSeeder) {
    const queries = ['widget price', 'best widgets', 'buy widget', 'widget sizes', 'widget colors'];
    seed.gscPage(daily(START, END, (date) => ({ date, page: PAGE, clicks: 20, impressions: 400, position: 5 })));
    seed.gscQuery(daily(START, END, (date) => queries.map((query) => ({ date, page: PAGE, query, clicks: 3, impressions: 60, position: 5 }))).flat());
    seed.ga4Landing(daily(START, END, (date) => ({ date, landingPage: '/widgets', sessions: 18, rate: 0.1, rateStatus: 'observed' as const, primaryKeyEvents: 3 })));
    seed.ga4Metadata();
  }

  it('does not multiply conversions by the number of keywords', () => {
    const seed = setup();
    seedPageWithQueries(seed);
    const rec = reconcile();
    const pageId = (rec.resolve(PAGE) as { pageId: string }).pageId;
    const row = joinPagePeriod(ctx.db, ctx.siteId, { id: pageId, url: PAGE }, gscScope, ga4Scope);
    expect(row.grain).toBe('page/period');
    expect(valueOf(row.gsc.clicks)).toBe(140);
    expect(valueOf(row.ga4!.sessions)).toBe(126);
    expect(valueOf(row.ga4!.primaryConvertingSessions)).toBeCloseTo(12.6, 6); // 7 days x 18 x 0.1, not x5 queries
    expect(valueOf(row.ga4!.primaryEventOccurrences)).toBe(21);
    const direct = ga4PageMetrics(ctx.db, ctx.siteId, pageId, ga4Scope);
    expect(valueOf(row.ga4!.primaryConvertingSessions)).toBe(valueOf(direct.primaryConvertingSessions));
    const all = joinAllPages(ctx.db, ctx.siteId, gscScope, ga4Scope);
    expect(all).toHaveLength(1);
  });

  it('keeps GSC (Pacific) and GA4 (property time zone) boundaries explicit and explains mismatches without asserting causes', () => {
    const seed = setup();
    seedPageWithQueries(seed);
    seed.ga4Landing([{ date: START, landingPage: '(not set)', sessions: 5 }], seed.batch('ga4', 'ga4_landing_daily', GA4_PROPERTY, START, START));
    const rec = reconcile();
    const pageId = (rec.resolve(PAGE) as { pageId: string }).pageId;
    const row = joinPagePeriod(ctx.db, ctx.siteId, { id: pageId, url: PAGE }, gscScope, ga4Scope);
    expect(row.dateBoundaries.gsc.timeZone).toBe('America/Los_Angeles');
    expect(row.dateBoundaries.ga4.timeZone).toBe('Europe/Tallinn');
    expect(row.dateBoundaries.sameTimeZone).toBe(false);
    expect(row.dateBoundaries.note).toMatch(/cannot be shifted/);
    const cvs = row.clicksVsSessions;
    expect(valueOf(cvs.ratio)).toBeCloseTo(0.9, 3);
    expect(cvs.direction).toBe('similar');
    expect(cvs.possibleReasons.find((r) => r.code === 'DATE_TIMEZONE_BOUNDARIES')!.status).toBe('observed_condition');
    expect(cvs.note).toMatch(/does not establish/);

    // Larger gap: every general cause is listed as possible, observed conditions flagged separately.
    ctx.db.run('UPDATE ga4_landing_daily SET sessions = 5 WHERE site_id = ? AND landing_page = ?', [ctx.siteId, '/widgets']);
    const gap = joinPagePeriod(ctx.db, ctx.siteId, { id: pageId, url: PAGE }, gscScope, ga4Scope).clicksVsSessions;
    expect(gap.direction).toBe('clicks_exceed_sessions');
    const byCode = Object.fromEntries(gap.possibleReasons.map((r) => [r.code, r.status]));
    expect(byCode).toMatchObject({ CONSENT_OR_ANALYTICS_BLOCKING: 'possible', ATTRIBUTION_DIFFERENCES: 'possible', TRACKING_GAPS: 'observed_condition', REDIRECTS_OR_URL_VARIANTS: 'possible' });
  });

  it('labels query-level business impact as a hypothesis based on page-level evidence', () => {
    const seed = setup();
    seedPageWithQueries(seed);
    const rec = reconcile();
    const pageId = (rec.resolve(PAGE) as { pageId: string }).pageId;
    const row = joinPagePeriod(ctx.db, ctx.siteId, { id: pageId, url: PAGE }, gscScope, ga4Scope);
    const hyps = queryImpactHypotheses(row, gscQueryMetrics(ctx.db, ctx.siteId, pageId, gscScope));
    expect(hyps).toHaveLength(5);
    for (const h of hyps) {
      expect(h.label).toBe('HYPOTHESIS');
      expect(valueOf(h.visibleClickShare)).toBeCloseTo(0.2, 4);
      expect(h.statement).toMatch(/not measured|hypothesis/);
      expect(h).not.toHaveProperty('conversions');
    }
  });
});
