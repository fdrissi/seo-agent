/**
 * Regression tests for audit findings on reports and measurement (A4-02,
 * A4-03, A4-08, A4-09, A2-07, A7-04, A7-10). All data is SYNTHETIC
 * (reserved example.test / *.invalid domains, invented numbers).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { buildMonthlyReport, buildWeeklyReport } from '../../../src/reports/build.js';
import { allClaims, type Claim, type Report } from '../../../src/reports/model.js';
import { SYNTHETIC_CLAIM_MARKER } from '../../../src/reports/render.js';
import { ga4ConversionChecklist } from '../../../src/integrations/google/ga4-checklist.js';
import { reportsTestConfig, PRIMARY_EVENT, WEEK, eachDate, insertRow, seedContent, seedGa4Landing, seedGa4Period, seedGscPageQueries, seedGscPages, seedPage, seedWeeklyScenario, sid, SITE_URL } from '../../fixtures/reports/seed.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

function find(report: Report, id: string): Claim {
  const c = allClaims(report).find((x) => x.id === id);
  if (!c) throw new Error(`claim ${id} not found; have: ${allClaims(report).map((x) => x.id).join(', ')}`);
  return c;
}

/** Markdown lines that render a claim as OBSERVED. */
function observedLines(md: string): string[] {
  return md.split('\n').filter((l) => l.startsWith('- **OBSERVED**'));
}

describe('A4-02: an undetermined key-event rate scale is never an OBSERVED percentage', () => {
  it('daily rates with scale "undetermined": no OBSERVED rate, no derived converting sessions, raw value only as INFERRED', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId, { rateScale: 'undetermined' });
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    const go = b.report.data.googleOrganic!;
    expect(go.status).toBe('observed');
    if (go.status !== 'observed') throw new Error('unreachable');
    expect(go.value.primarySessionRate.status).toBe('unavailable');
    expect(go.value.primarySessionRate.status !== 'observed' && go.value.primarySessionRate.reason).toMatch(/rate scale unverified/);
    expect(go.value.primarySessionRateUnverified).toEqual({ raw: 0.142857, basis: 'session_weighted_daily' });
    expect(go.value.sessionsWithPrimaryEvent.status).toBe('unavailable');

    const rate = find(b.report, 'ga4.google_organic.primary_rate');
    expect(rate.label).toBe('INFERRED');
    expect(rate.text).toContain('RATE SCALE UNVERIFIED');
    expect(rate.text).toContain('0.142857');
    const sessions = find(b.report, 'ga4.google_organic.primary_sessions');
    expect(sessions.label).toBe('DATA_UNAVAILABLE');
    expect(sessions.reason).toMatch(/rate scale unverified/);
    // No OBSERVED claim or line anywhere presents the primary rate or derived converting sessions as measured.
    const rateMetrics = ['ga4.primary_event.session_rate', 'ga4.primary_event.sessions'];
    expect(allClaims(b.report).filter((c) => c.label === 'OBSERVED' && c.metricIds.some((m) => rateMetrics.includes(m))).map((c) => c.id)).toEqual([]);
    for (const line of observedLines(b.markdown)) {
      expect(line).not.toMatch(/Session key-event rate for/);
      expect(line).not.toMatch(/Sessions that triggered/);
      expect(line).not.toMatch(/14\.29%/);
    }
    // The executive summary echo carries the INFERRED label too, and the scale warning is a data-quality item.
    expect(find(b.report, 'summary.conversion').label).toBe('INFERRED');
    expect(b.report.data.dataQuality?.some((d) => d.code === 'ga4_rate_scale_unverified')).toBe(true);
    // "Repair measurement" is not sent for an unverified scale (the key event itself is fine).
    expect(b.report.data.nextAction?.code).not.toBe('repair_measurement');
    expect(b.issues).toEqual([]);
  });

  it('a period-level rate with scale "undetermined" is never used; verified daily rates are used instead when they exist', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId, { rateScale: 'fraction' });
    seedGa4Period(ctx.db, ctx.siteId, { ...WEEK, channel: 'google_organic', metric: `sessionKeyEventRate:${PRIMARY_EVENT}`, value: 0.9, rateScale: 'undetermined' });
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    const rate = find(b.report, 'ga4.google_organic.primary_rate');
    expect(rate.label).toBe('OBSERVED');
    expect(rate.text).toContain('14.29% (session-weighted aggregate of complete daily values)');
    expect(rate.text).not.toContain('90.00%');
    expect(find(b.report, 'ga4.google_organic.primary_sessions').label).toBe('OBSERVED');
    const all = find(b.report, 'ga4.all_organic.primary_rate');
    expect(all.label).toBe('OBSERVED'); // all_organic daily rows: 'fraction'
    expect(all.text).toContain('10.38%'); // (9 x 0.15 + 4 x 0) / 13 sessions
  });

  it('only an undetermined period-level value: INFERRED raw value, never an OBSERVED percentage', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId, { gaRateStatus: 'unavailable' });
    seedGa4Period(ctx.db, ctx.siteId, { ...WEEK, channel: 'google_organic', metric: `sessionKeyEventRate:${PRIMARY_EVENT}`, value: 0.9, rateScale: 'undetermined' });
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    const rate = find(b.report, 'ga4.google_organic.primary_rate');
    expect(rate.label).toBe('INFERRED');
    expect(rate.text).toContain('GA4 reported 0.9 (period-level API value)');
    expect(rate.text).toContain('RATE SCALE UNVERIFIED');
    for (const line of observedLines(b.markdown)) expect(line).not.toMatch(/90\.00%/);
  });

  it('a verified 0-100 scale (percent_normalized, already divided by 100 at ingestion) renders as a percentage', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId, { rateScale: 'percent_normalized' });
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    const rate = find(b.report, 'ga4.google_organic.primary_rate');
    expect(rate.label).toBe('OBSERVED');
    expect(rate.text).toContain('14.29%');
  });
});

describe('A4-03: users who triggered the primary event (period level)', () => {
  it('derives users from userKeyEventRate x totalUsers for exactly the period (INFERRED), kept distinct from occurrences and sessions', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    seedGa4Period(ctx.db, ctx.siteId, { ...WEEK, channel: 'google_organic', metric: 'totalUsers', value: 40 });
    seedGa4Period(ctx.db, ctx.siteId, { ...WEEK, channel: 'google_organic', metric: `userKeyEventRate:${PRIMARY_EVENT}`, value: 0.1, rateScale: 'fraction' });
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    const c = find(b.report, 'ga4.google_organic.primary_users');
    expect(c.label).toBe('INFERRED');
    expect(c.text).toContain(`Users who triggered "${PRIMARY_EVENT}"`);
    expect(c.text).toContain('about 4 of 40 users (10.00%)');
    expect(c.text).toContain('Not event occurrences, not sessions that triggered it, and not the session rate');
    expect(c.metricIds).toEqual(['ga4.primary_event.users']);
    // Occurrences and converting sessions stay separate claims with their own values.
    expect(find(b.report, 'ga4.google_organic.primary_occurrences').text).toContain(': 7.');
    expect(find(b.report, 'ga4.google_organic.primary_sessions').text).toContain(': 7.');
    const go = b.report.data.googleOrganic!;
    expect(go.status === 'observed' && go.value.primaryEventUsers?.users).toEqual({ status: 'observed', value: 4 });
    expect(b.issues).toEqual([]);
  });

  it('an undetermined user rate is reported only as a raw share (INFERRED, no user count); missing is DATA UNAVAILABLE', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    seedGa4Period(ctx.db, ctx.siteId, { ...WEEK, channel: 'google_organic', metric: 'totalUsers', value: 40 });
    seedGa4Period(ctx.db, ctx.siteId, { ...WEEK, channel: 'google_organic', metric: `userKeyEventRate:${PRIMARY_EVENT}`, value: 0.1, rateScale: 'undetermined' });
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    const c = find(b.report, 'ga4.google_organic.primary_users');
    expect(c.label).toBe('INFERRED');
    expect(c.text).toContain('RATE SCALE UNVERIFIED');
    expect(c.text).toContain('no user count is derived');
    expect(c.text).not.toMatch(/about \d+ of/);
    // all_organic has no period rows at all: missing, never zero.
    const missing = find(b.report, 'ga4.all_organic.primary_users');
    expect(missing.label).toBe('DATA_UNAVAILABLE');
    expect(missing.reason).toContain('was not fetched for exactly');
  });
});

describe('A4-08: claims built from synthetic rows carry the per-claim SYNTHETIC flag', () => {
  it('brand split, unattributed-clicks estimate, and clicks-vs-sessions are flagged when contributing rows are synthetic', async () => {
    ctx = createTestContext({ config: reportsTestConfig({ profile: 'demo' }) });
    const dates = eachDate(WEEK.start, WEEK.end);
    const pricing = seedPage(ctx.db, ctx.siteId, '/pricing');
    seedGscPages(ctx.db, ctx.siteId, { dates, pages: [{ url: `${SITE_URL}/pricing`, pageId: pricing, clicks: 6, impressions: 100, position: 5 }], synthetic: 1 });
    seedGscPageQueries(ctx.db, ctx.siteId, { dates, rows: [{ url: `${SITE_URL}/pricing`, pageId: pricing, query: 'test co pricing', clicks: 2, impressions: 20, position: 1.5 }], synthetic: 1 });
    insertRow(ctx.db, 'gsc_property_daily', {
      site_id: ctx.siteId, property: 'sc-domain:example.test', search_type: 'web', date: WEEK.start, date_tz: 'America/Los_Angeles', clicks: 10, impressions: 200, ctr: 0.05, position: 8,
      aggregation_type: 'byProperty', is_final: 1, revision: 1, is_current: 1, row_hash: sid('h'), batch_id: seedGscPagesBatch(ctx), collected_at: '2026-09-22T06:00:00.000Z', transformation_version: 'test@1', is_synthetic: 1,
    });
    seedGa4Landing(ctx.db, ctx.siteId, { dates, rows: [{ channel: 'google_organic', landingPage: '/pricing', pageId: pricing, sessions: 5 }], synthetic: 1 });
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    for (const id of ['gsc.brand', 'gsc.query.unattributed', 'ga4.google_organic.vs_gsc']) {
      const c = find(b.report, id);
      expect(c.label === 'OBSERVED' || c.label === 'INFERRED', id).toBe(true);
      expect(c.synthetic, id).toBe(true);
    }
    expect(b.markdown).toContain(`**OBSERVED** ${SYNTHETIC_CLAIM_MARKER} Visible query rows only`);
    expect(b.markdown).toContain(`**INFERRED** ${SYNTHETIC_CLAIM_MARKER} Estimate:`);
  });
});

/** A synthetic batch id for directly inserted property rows. */
function seedGscPagesBatch(c: TestContext): string {
  const id = sid('batch');
  insertRow(c.db, 'ingestion_batches', { id, site_id: c.siteId, source: 'gsc', dataset: 'gsc_property_daily', property: 'sc-domain:example.test', date_start: WEEK.start, date_end: WEEK.end, request_json: '{"type":"web","synthetic":true}', status: 'succeeded', transformation_version: 'test@1', is_synthetic: 1, started_at: '2026-09-22T06:00:00.000Z', finished_at: '2026-09-22T06:00:00.000Z' });
  return id;
}

describe('A4-09: conversion verification by the owner', () => {
  it('caveats primary-event metrics and adds a data-quality item until verifiedAt is recorded', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    for (const id of ['ga4.google_organic.primary_rate', 'ga4.google_organic.primary_occurrences', 'ga4.google_organic.primary_sessions']) {
      expect(find(b.report, id).text, id).toContain('tracking not yet verified by the owner');
    }
    const dq = b.report.data.dataQuality!.find((d) => d.code === 'primary_event_unverified')!;
    expect(dq.message).toContain(PRIMARY_EVENT);
    expect(dq.nextStep).toContain('setup --update --only conversions');
    expect(dq.configField).toBe('conversions.primaryEvents');
  });

  it('a recorded verification removes the caveat; the checklist says how to record it', async () => {
    const config = reportsTestConfig({ conversions: { primaryEvents: [{ name: PRIMARY_EVENT, meaning: 'Demo form submitted (synthetic)', kind: 'lead', verifiedAt: '2026-09-01', verificationNote: 'test submission seen in DebugView (synthetic)' }] } as never });
    ctx = createTestContext({ config });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    expect(find(b.report, 'ga4.google_organic.primary_rate').text).not.toContain('tracking not yet verified');
    expect(b.report.data.dataQuality!.some((d) => d.code === 'primary_event_unverified')).toBe(false);
    expect(ga4ConversionChecklist(config)).toContain('Recorded owner verification: 2026-09-01 (test submission seen in DebugView (synthetic))');
    const unverified = ga4ConversionChecklist(reportsTestConfig());
    expect(unverified).toContain('Recorded owner verification: NONE');
    expect(unverified).toContain('setup --update --only conversions');
    expect(unverified).toContain('conversions.primaryEvents[].verifiedAt');
  });
});

describe('A2-07: unknown business time zone', () => {
  it('says the zone is unknown, warns with a next step, and records timeZoneSource in the report JSON', async () => {
    ctx = createTestContext({ config: reportsTestConfig({ reporting: { businessTimezone: null, currency: 'EUR' } }) });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    const tz = ctx.config.scheduler.timezone;
    expect(b.report.period.timeZoneSource).toBe('scheduler_fallback');
    expect(JSON.parse(b.json).period.timeZoneSource).toBe('scheduler_fallback');
    const dates = b.report.sections.find((s) => s.key === 'dates')!.tables[0]!.rows;
    expect(dates.find((r) => r[0] === 'Business time zone')?.[1]).toBe(`unknown (period boundaries use the scheduler zone ${tz})`);
    const dq = b.report.data.dataQuality!.find((d) => d.code === 'business_timezone_unknown')!;
    expect(dq.severity).toBe('warning');
    expect(dq.nextStep).toContain('setup --update --only reporting.businessTimezone');
  });

  it('a configured business zone is labeled as such', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    expect(b.report.period.timeZoneSource).toBe('business');
    const dates = b.report.sections.find((s) => s.key === 'dates')!.tables[0]!.rows;
    expect(dates.find((r) => r[0] === 'Business time zone')?.[1]).toBe('Europe/Tallinn');
    expect(b.report.data.dataQuality!.some((d) => d.code === 'business_timezone_unknown')).toBe(false);
  });
});

describe('A7-04: competitor changes need a competitor check', () => {
  const AUG = { start: '2026-08-01', end: '2026-08-31' };
  function seedCompetitorPage(c: TestContext, lastChecked: string | null): void {
    const comp = sid('comp');
    insertRow(c.db, 'competitors', { id: comp, site_id: c.siteId, domain: 'competitor.invalid', origin: 'configured', first_seen_at: '2026-07-01T00:00:00.000Z' });
    insertRow(c.db, 'competitor_pages', { id: sid('cp'), site_id: c.siteId, competitor_id: comp, url: 'https://competitor.invalid/pricing', first_seen_at: '2026-07-01T00:00:00.000Z', last_checked_at: lastChecked });
  }

  it('a skipped competitor_changes stage with no crawl in the period is DATA UNAVAILABLE, never "no changes"', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedCompetitorPage(ctx, '2026-07-15T00:00:00.000Z');
    const b = await buildMonthlyReport(ctx, {
      statuses: null,
      period: AUG,
      persist: false,
      pipeline: { workflow: 'monthly', jobId: null, stages: [{ stage: 'competitor_changes', status: 'skipped', code: 'MODE', detail: 'runtime mode ANALYZE is below RESEARCH (synthetic)' }] },
    });
    const c = find(b.report, 'competitors.changes');
    expect(c.label).toBe('DATA_UNAVAILABLE');
    expect(c.reason).toContain('competitor_changes stage skipped');
    expect(c.reason).toContain('not evidence of no change');
    expect(b.markdown).not.toContain('No competitor page changes were detected');
  });

  it('without pipeline info and without any check in the period: DATA UNAVAILABLE; a completed competitor crawl in the period supports "none"', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedCompetitorPage(ctx, null);
    const b = await buildMonthlyReport(ctx, { statuses: null, period: AUG, persist: false });
    expect(find(b.report, 'competitors.changes').label).toBe('DATA_UNAVAILABLE');

    const crawl = sid('crawl');
    insertRow(ctx.db, 'crawls', { id: crawl, site_id: ctx.siteId, kind: 'competitor', status: 'completed', pages_attempted: 1, pages_fetched: 1, is_synthetic: 0, started_at: '2026-08-12T10:00:00.000Z', finished_at: '2026-08-12T10:01:00.000Z' });
    const b2 = await buildMonthlyReport(ctx, { statuses: null, period: AUG, persist: false });
    const c = find(b2.report, 'competitors.changes');
    expect(c.label).toBe('OBSERVED');
    expect(c.text).toContain('No competitor page changes were detected this month (1 competitor crawl(s))');
    expect(c.sourceIds).toContain(`crawls:${crawl}`);
    expect(b2.issues).toEqual([]);
  });

  it("this report's own successful re-check counts as a check", async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedCompetitorPage(ctx, '2026-09-03T00:00:00.000Z');
    const b = await buildMonthlyReport(ctx, { statuses: null, period: AUG, persist: false, pipeline: { workflow: 'monthly', jobId: null, stages: [{ stage: 'competitor_changes', status: 'succeeded', detail: 'checked 1 page (synthetic)' }] } });
    const c = find(b.report, 'competitors.changes');
    expect(c.label).toBe('OBSERVED');
    expect(c.text).toContain("this report's competitor re-check");
  });
});

describe('A7-10: drafts waiting on the owner', () => {
  it('points the owner to content review / mark-reviewed before "wait"', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    seedContent(ctx.db, ctx.siteId); // latest draft: needs_human_review with 1 unresolved fact
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    const next = b.report.data.nextAction!;
    expect(next.code).toBe('review_drafts');
    expect(next.text).toContain('content review');
    expect(next.text).toContain('content mark-reviewed');
    expect(next.text).toContain('1 awaiting human review, 1 with unresolved facts');
    expect(find(b.report, 'next.action').sourceIds.some((s) => s.startsWith('content_drafts:'))).toBe(true);
  });

  it('with no draft waiting, the owner is told to wait', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    expect(b.report.data.nextAction?.code).toBe('wait');
  });
});
