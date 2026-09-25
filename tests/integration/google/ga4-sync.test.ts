import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFixtureGoogleAuthProvider } from '../../../src/integrations/google/fixture-provider.js';
import { syncGa4 } from '../../../src/integrations/google/ga4-sync.js';
import { confirmRateScale, effectiveRateScale } from '../../../src/integrations/google/ga4-metadata.js';
import { ga4Coverage } from '../../../src/seo/coverage.js';
import { parseReportRows, type Ga4RunReportResponse } from '../../../src/integrations/google/ga4-client.js';
import { FAST_RETRY, GOOGLE_FIXTURES, ScriptedClient, SYNTHETIC_GA4, SYNTHETIC_PROPERTY, count, googleConfig, googleTestContext, providerFor } from './_helpers.js';
import type { GoogleApiClient } from '../../../src/integrations/google/types.js';
import type { TestContext } from '../../helpers/context.js';

const NOW = '2026-09-24T09:00:00.000Z'; // 2026-09-24 05:00 in America/New_York (fixture property time zone)
let ctx: TestContext;
let tmp: string | null = null;
afterEach(() => {
  ctx?.cleanup();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function fixtureProvider(c: TestContext, extra: Parameters<typeof createFixtureGoogleAuthProvider>[1] = {}, dir = GOOGLE_FIXTURES) {
  return createFixtureGoogleAuthProvider(dir, { gscProperty: SYNTHETIC_PROPERTY, ga4PropertyId: SYNTHETIC_GA4, clock: c.clock, ...extra });
}

type RunReportBody = { dimensions?: { name: string }[]; metrics?: { name: string }[]; dimensionFilter?: unknown };

/** Wrap the synthetic fixture client and rewrite runReport responses (to simulate revisions and scales). */
function rewriting(inner: GoogleApiClient, rewrite: (body: RunReportBody, data: Ga4RunReportResponse) => void): ScriptedClient {
  return new ScriptedClient(async (req) => {
    const res = await inner.request<Ga4RunReportResponse>({ url: req.url, method: req.method as 'GET' | 'POST', ...(req.body ? { data: req.body } : {}) });
    const data = JSON.parse(JSON.stringify(res.data)) as Ga4RunReportResponse;
    if (req.url.endsWith(':runReport')) rewrite(req.body as RunReportBody, data);
    return { body: data };
  });
}

/** Drop rows whose landing page matches (keeps rowCount consistent). */
function dropLanding(page: string) {
  return (_body: RunReportBody, data: Ga4RunReportResponse) => {
    const idx = (data.dimensionHeaders ?? []).findIndex((h) => h.name === 'landingPagePlusQueryString');
    if (idx < 0 || !data.rows) return;
    const kept = data.rows.filter((r) => r.dimensionValues?.[idx]?.value !== page);
    data.rowCount = (data.rowCount ?? kept.length) - (data.rows.length - kept.length);
    data.rows = kept;
  };
}

function scaleRate(factor: number, when: (body: RunReportBody) => boolean = () => true) {
  return (body: RunReportBody, data: Ga4RunReportResponse) => {
    if (!when(body)) return;
    (data.metricHeaders ?? []).forEach((h, i) => {
      if (!/KeyEventRate:/.test(h.name)) return;
      for (const row of data.rows ?? []) row.metricValues![i]!.value = String(Number(row.metricValues![i]!.value) * factor);
    });
  };
}

describe('syncGa4 with synthetic fixtures', () => {
  it('ingests both organic views with session-scoped filters, keeps (not set), and retains report metadata', async () => {
    ctx = googleTestContext({ now: NOW });
    const provider = fixtureProvider(ctx);
    const r = await syncGa4(ctx, { provider, days: 14, retry: FAST_RETRY });
    expect(r.status).toBe('succeeded');
    expect(r.timeZone).toBe('America/New_York');
    expect(r.currencyCode).toBe('USD');
    expect(r.range).toMatchObject({ start: '2026-09-10', end: '2026-09-23', incompleteFrom: '2026-09-23' });
    expect(r.metricPlan).toMatchObject({ primaryEvent: 'generate_lead', primaryRateMetric: 'sessionKeyEventRate:generate_lead', primaryKeyEventsMetric: 'keyEvents:generate_lead', revenueMetric: 'totalRevenue' });

    for (const view of ['google_organic', 'all_organic']) {
      expect(count(ctx, 'SELECT COUNT(*) AS n FROM ga4_landing_daily_current WHERE site_id = ? AND channel_view = ?', [ctx.siteId, view])).toBeGreaterThan(0);
    }
    // all_organic (Organic Search: google + bing) has more sessions than google_organic.
    const sum = (view: string) => ctx.db.get<{ s: number }>('SELECT SUM(sessions) AS s FROM ga4_landing_daily_current WHERE site_id = ? AND channel_view = ?', [ctx.siteId, view])!.s;
    expect(sum('all_organic')).toBeGreaterThan(sum('google_organic'));
    // "(not set)" is kept as an explicit bucket.
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_landing_daily_current WHERE site_id = ? AND landing_page = '(not set)'", [ctx.siteId])).toBeGreaterThan(0);
    // Query strings in landing pages are preserved.
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_landing_daily_current WHERE site_id = ? AND landing_page = '/pricing?plan=pro'", [ctx.siteId])).toBeGreaterThan(0);

    const row = ctx.db.get<Record<string, unknown>>("SELECT * FROM ga4_landing_daily_current WHERE site_id = ? AND channel_view = 'google_organic' AND landing_page = '/pricing' AND date = '2026-09-15'", [ctx.siteId])!;
    expect(row).toMatchObject({ date_tz: 'America/New_York', primary_event_name: 'generate_lead', primary_key_events_status: 'observed', primary_session_rate_status: 'observed', revenue_status: 'observed', revenue_currency: 'USD', is_complete: 1, is_synthetic: 1 });
    expect(Number(row.primary_session_rate)).toBeGreaterThanOrEqual(0);
    expect(Number(row.primary_session_rate)).toBeLessThanOrEqual(1);
    expect(Number.isInteger(row.revenue_micros)).toBe(true);
    expect(JSON.parse(String(row.metric_names_json))).toMatchObject({ primarySessionRate: 'sessionKeyEventRate:generate_lead', primaryKeyEvents: 'keyEvents:generate_lead' });
    // Latest date is marked incomplete.
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_landing_daily_current WHERE site_id = ? AND date = '2026-09-23' AND is_complete = 1", [ctx.siteId])).toBe(0);

    const batch = ctx.db.get<{ metadata_json: string; coverage_json: string }>("SELECT metadata_json, coverage_json FROM ingestion_batches WHERE site_id = ? AND dataset = 'ga4_landing_daily' LIMIT 1", [ctx.siteId])!;
    const meta = JSON.parse(batch.metadata_json);
    expect(meta).toMatchObject({ subjectToThresholding: true, timeZone: 'America/New_York', currencyCode: 'USD', dataLossFromOtherRow: false });
    expect(meta.propertyQuota.tokensPerHour.remaining).toBeGreaterThan(0);
    const cov = JSON.parse(batch.coverage_json);
    expect(cov.warnings.join(' ')).toMatch(/thresholding/);
    expect(cov.notSet.rows).toBeGreaterThan(0);

    // Event counts for configured events; non-key events have NULL key_event_count.
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_event_daily_current WHERE site_id = ? AND event_name = 'generate_lead' AND channel_view = 'all_traffic' AND landing_page = ''", [ctx.siteId])).toBeGreaterThan(0);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_event_daily_current WHERE site_id = ? AND event_name = 'sign_up' AND key_event_count IS NOT NULL", [ctx.siteId])).toBe(0);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_event_daily_current WHERE site_id = ? AND event_name = 'generate_lead' AND key_event_count IS NULL", [ctx.siteId])).toBe(0);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_event_daily_current WHERE site_id = ? AND landing_page = '/pricing'", [ctx.siteId])).toBeGreaterThan(0);

    // Metadata cache (time zone, currency).
    expect(ctx.db.get('SELECT time_zone, currency_code FROM ga4_property_metadata WHERE site_id = ?', [ctx.siteId])).toMatchObject({ time_zone: 'America/New_York', currency_code: 'USD' });
    expect(count(ctx, "SELECT COUNT(*) AS n FROM provider_requests WHERE site_id = ? AND provider = 'google_ga4' AND is_paid = 0 AND is_synthetic = 1", [ctx.siteId])).toBeGreaterThan(0);
  });

  it('fetches users at period grain and never sums daily users', async () => {
    ctx = googleTestContext({ now: NOW });
    const provider = fixtureProvider(ctx);
    await syncGa4(ctx, { provider, days: 30, retry: FAST_RETRY });
    const period = ctx.db.get<{ value: number; period_start: string; period_end: string; value_status: string }>(
      "SELECT value, period_start, period_end, value_status FROM ga4_period_metrics_current WHERE site_id = ? AND metric = 'totalUsers' AND channel_view = 'google_organic' AND landing_page = '' AND period_end = '2026-09-22' AND period_start = '2026-08-26'",
      [ctx.siteId],
    )!;
    expect(period.value_status).toBe('observed');
    // Ask the (synthetic) API for daily users over the same window: their sum overstates distinct users.
    const client = await provider.getClient();
    const daily = await client.request<Ga4RunReportResponse>({
      url: `https://analyticsdata.googleapis.com/v1beta/properties/${SYNTHETIC_GA4}:runReport`,
      method: 'POST',
      data: { dateRanges: [{ startDate: period.period_start, endDate: period.period_end }], dimensions: [{ name: 'date' }], metrics: [{ name: 'totalUsers' }], dimensionFilter: { andGroup: { expressions: [{ filter: { fieldName: 'sessionSource', stringFilter: { matchType: 'EXACT', value: 'google' } } }, { filter: { fieldName: 'sessionMedium', stringFilter: { matchType: 'EXACT', value: 'organic' } } }] } } },
    });
    const summedDaily = parseReportRows(daily.data).reduce((s, r) => s + (r.metrics.totalUsers ?? 0), 0);
    expect(period.value).toBeLessThan(summedDaily);
    // The daily landing table has no users column at all.
    const cols = ctx.db.all<{ name: string }>("SELECT name FROM pragma_table_info('ga4_landing_daily')").map((c) => c.name);
    expect(cols.some((c) => /user/i.test(c))).toBe(false);
    // Period-level primary rates (sessions and users that triggered the event) come from the API, not from dividing counts.
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_period_metrics_current WHERE site_id = ? AND metric = 'sessionKeyEventRate:generate_lead' AND value_status = 'observed'", [ctx.siteId])).toBeGreaterThan(0);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_period_metrics_current WHERE site_id = ? AND metric = 'userKeyEventRate:generate_lead' AND value_status = 'observed' AND landing_page = ''", [ctx.siteId])).toBeGreaterThan(0);
  });

  it('re-sync is idempotent and a maturing day creates revision 2', async () => {
    ctx = googleTestContext({ now: NOW });
    const provider = fixtureProvider(ctx);
    await syncGa4(ctx, { provider, days: 5, retry: FAST_RETRY, periodWindows: [7] });
    const total = count(ctx, 'SELECT COUNT(*) AS n FROM ga4_landing_daily WHERE site_id = ?', [ctx.siteId]);
    const r2 = await syncGa4(ctx, { provider, days: 5, retry: FAST_RETRY, periodWindows: [7] });
    expect(r2.datasets.every((d) => d.rowsNewRevision === 0)).toBe(true);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM ga4_landing_daily WHERE site_id = ?', [ctx.siteId])).toBe(total);
    ctx.clock.advanceMs(86_400_000);
    const r3 = await syncGa4(ctx, { provider, days: 5, retry: FAST_RETRY, periodWindows: [7] });
    const landing = r3.datasets.filter((d) => d.dataset === 'ga4_landing_daily');
    expect(landing.some((d) => d.rowsRevised > 0)).toBe(true);
    const revised = ctx.db.all<{ revision: number; is_current: number; is_complete: number }>(
      "SELECT revision, is_current, is_complete FROM ga4_landing_daily WHERE site_id = ? AND channel_view = 'google_organic' AND landing_page = '/' AND date = '2026-09-23' ORDER BY revision",
      [ctx.siteId],
    );
    expect(revised.map((x) => [x.revision, x.is_current, x.is_complete])).toEqual([
      [1, 0, 0],
      [2, 1, 1],
    ]);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_landing_daily_current WHERE site_id = ? AND channel_view = 'google_organic' AND landing_page = '/' AND date = '2026-09-23'", [ctx.siteId])).toBe(1);
  });

  it('paginates with offset/limit until rowCount', async () => {
    ctx = googleTestContext({ now: NOW });
    const provider = fixtureProvider(ctx);
    const r = await syncGa4(ctx, { provider, days: 3, limit: 5, retry: FAST_RETRY, periodWindows: [], includeLandingEvents: false });
    const landing = r.datasets.find((d) => d.dataset === 'ga4_landing_daily' && d.view === 'google_organic')!;
    expect(landing.apiPages).toBeGreaterThan(1);
    const offsets = provider.client.calls.filter((c) => c.url.endsWith(':runReport') && (c.body as { dimensions?: { name: string }[] }).dimensions?.length === 3).map((c) => (c.body as { offset: string }).offset);
    expect(offsets.slice(0, 3)).toEqual(['0', '5', '10']);
    const withoutPaging = count(ctx, "SELECT COUNT(*) AS n FROM ga4_landing_daily_current WHERE site_id = ? AND channel_view = 'google_organic'", [ctx.siteId]);
    expect(withoutPaging).toBe(landing.rowsReceived);
  });

  it('reports an unavailable primary-event rate explicitly and never substitutes or computes one', async () => {
    ctx = googleTestContext({ now: NOW });
    const provider = fixtureProvider(ctx, { ga4MetadataFile: 'ga4/metadata-no-primary.json' });
    const r = await syncGa4(ctx, { provider, days: 5, retry: FAST_RETRY });
    expect(r.metricPlan).toMatchObject({ primaryRateMetric: null, primaryKeyEventsMetric: null, primaryKeyEventsAlternative: null, revenueMetric: null });
    expect(r.limitations.join('\n')).toMatch(/sessionKeyEventRate:generate_lead/);
    expect(r.limitations.join('\n')).toMatch(/NOT used in its place/);
    expect(r.limitations.join('\n')).toMatch(/NO_REVENUE_METRICS/);
    expect(r.checklist).toMatch(/conversion verification checklist/i);
    const rows = ctx.db.all<{ primary_session_rate: number | null; primary_session_rate_status: string; primary_key_events: number | null; primary_key_events_status: string; revenue_micros: number | null; revenue_status: string }>(
      'SELECT primary_session_rate, primary_session_rate_status, primary_key_events, primary_key_events_status, revenue_micros, revenue_status FROM ga4_landing_daily_current WHERE site_id = ?',
      [ctx.siteId],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const x of rows) {
      expect(x).toMatchObject({ primary_session_rate: null, primary_session_rate_status: 'unavailable', primary_key_events: null, primary_key_events_status: 'unavailable', revenue_micros: null, revenue_status: 'unavailable' });
    }
    // Neither the generic key-event rate nor a count/sessions ratio was requested.
    const metricsRequested = provider.client.calls.filter((c) => c.url.endsWith(':runReport')).flatMap((c) => ((c.body as { metrics: { name: string }[] }).metrics ?? []).map((m) => m.name));
    expect(metricsRequested).not.toContain('sessionKeyEventRate');
    expect(metricsRequested).not.toContain('totalRevenue');
    const unavailable = ctx.db.get<{ value: number | null; value_status: string }>("SELECT value, value_status FROM ga4_period_metrics_current WHERE site_id = ? AND metric = 'sessionKeyEventRate:generate_lead' AND landing_page = '' LIMIT 1", [ctx.siteId])!;
    expect(unavailable).toMatchObject({ value: null, value_status: 'unavailable' });
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_period_metrics_current WHERE site_id = ? AND metric = 'userKeyEventRate:generate_lead' AND value_status = 'unavailable' AND value IS NULL", [ctx.siteId])).toBeGreaterThan(0);
    // Key-event count is NULL (not zero) for an event GA4 does not list as a key event.
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_event_daily_current WHERE site_id = ? AND event_name = 'generate_lead' AND key_event_count IS NOT NULL", [ctx.siteId])).toBe(0);
  });

  it('uses the explicitly labelled keyEvents+eventName alternative when keyEvents:<event> is not listed', async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ga4-fixtures-'));
    cpSync(GOOGLE_FIXTURES, tmp, { recursive: true });
    const meta = JSON.parse(readFileSync(path.join(tmp, 'ga4/metadata.json'), 'utf8'));
    meta.metrics = meta.metrics.filter((m: { apiName: string }) => !m.apiName.startsWith('keyEvents:'));
    writeFileSync(path.join(tmp, 'ga4/metadata-alt.json'), JSON.stringify(meta));
    ctx = googleTestContext({ now: NOW });
    const provider = fixtureProvider(ctx, { ga4MetadataFile: 'ga4/metadata-alt.json' }, tmp);
    const r = await syncGa4(ctx, { provider, days: 4, retry: FAST_RETRY, periodWindows: [] });
    expect(r.metricPlan!.primaryKeyEventsAlternative).toMatch(/keyEvents filtered by eventName/);
    const row = ctx.db.get<{ primary_key_events: number; primary_key_events_status: string; metric_names_json: string }>(
      "SELECT primary_key_events, primary_key_events_status, metric_names_json FROM ga4_landing_daily_current WHERE site_id = ? AND channel_view = 'google_organic' AND landing_page = '/pricing' AND date = '2026-09-21'",
      [ctx.siteId],
    )!;
    expect(row.primary_key_events_status).toBe('observed');
    expect(row.primary_key_events).toBeGreaterThan(0);
    expect(JSON.parse(row.metric_names_json).primaryKeyEvents).toMatch(/^ALTERNATIVE:/);
  });

  it('marks revenue unavailable (not zero) when the role restricts it', async () => {
    ctx = googleTestContext({ now: NOW });
    const provider = fixtureProvider(ctx, { ga4DatasetOverrides: { restrictedMetrics: ['totalRevenue'], dataLossFromOtherRow: true } });
    const r = await syncGa4(ctx, { provider, days: 3, retry: FAST_RETRY, periodWindows: [] });
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_landing_daily_current WHERE site_id = ? AND revenue_status = 'observed'", [ctx.siteId])).toBe(0);
    expect(r.warnings.join('\n')).toMatch(/restricted/);
    expect(r.warnings.join('\n')).toMatch(/\(other\)/);
  });

  it('stops early at the quota reserve and reports a partial sync', async () => {
    ctx = googleTestContext({ now: NOW });
    const provider = fixtureProvider(ctx, { ga4QuotaRemaining: { tokensPerHour: 100 } });
    const r = await syncGa4(ctx, { provider, days: 3, retry: FAST_RETRY });
    expect(r.status).toBe('partial');
    expect(r.datasets.every((d) => d.status === 'skipped')).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/quota reserve/);
  });

  it('stops at a 429 token-quota error without retrying, keeps committed data, and reports partial', async () => {
    ctx = googleTestContext({ now: NOW });
    const inner = await fixtureProvider(ctx).getClient();
    let reports = 0;
    const client = new ScriptedClient(async (req) => {
      if (req.url.endsWith(':runReport')) {
        reports++;
        if (reports > 3) return { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Exhausted property tokens per hour.' } } };
      }
      const res = await inner.request({ url: req.url, method: req.method as 'GET' | 'POST', ...(req.body ? { data: req.body } : {}) });
      return { body: res.data };
    });
    const r = await syncGa4(ctx, { provider: providerFor(client, 'fixture'), days: 3, retry: FAST_RETRY });
    expect(r.status).toBe('partial');
    expect(r.datasets.filter((d) => d.status === 'succeeded').map((d) => d.view)).toEqual(['google_organic', 'all_organic']);
    expect(r.datasets.find((d) => d.status === 'failed')).toMatchObject({ dataset: 'ga4_event_daily' });
    expect(r.datasets.filter((d) => d.status === 'skipped').length).toBeGreaterThan(0);
    expect(r.warnings.join('\n')).toMatch(/Hourly quotas refresh/);
    expect(reports).toBe(3 + 1); // token quotas reset hourly/daily: no retry within the run (contract section 3)
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM ga4_landing_daily_current WHERE site_id = ?', [ctx.siteId])).toBeGreaterThan(0);
  });

  it('dry run makes no request', async () => {
    ctx = googleTestContext({ now: NOW });
    const provider = fixtureProvider(ctx);
    const r = await syncGa4(ctx, { provider, dryRun: true });
    expect(r.status).toBe('dry_run');
    expect(provider.client.calls).toHaveLength(0);
    expect(r.plan!.reports.join('\n')).toMatch(/ga4_period_metrics/);
  });

  it('rejects a measurement ID and requires configuration', async () => {
    ctx = googleTestContext({ now: NOW, config: googleConfig({ google: { ga4PropertyId: null } }) });
    await expect(syncGa4(ctx, { provider: fixtureProvider(ctx) })).rejects.toMatchObject({ code: 'CONFIG_MISSING' });
  });

  it('surfaces GA4 permission errors without retrying', async () => {
    ctx = googleTestContext({ now: NOW });
    const client = new ScriptedClient(() => ({ status: 403, body: { error: { code: 403, message: 'User does not have sufficient permissions for this property.', status: 'PERMISSION_DENIED' } } }));
    await expect(syncGa4(ctx, { provider: providerFor(client), retry: FAST_RETRY })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', kind: 'permission_denied' });
    expect(client.calls).toHaveLength(1);
  });

  it('detects a 0-100 rate scale and stores fractions', async () => {
    ctx = googleTestContext({ now: NOW });
    const fixture = fixtureProvider(ctx);
    const inner = await fixture.getClient();
    // Wrap the synthetic client to report the rate on a 0-100 scale.
    const client = new ScriptedClient(async (req) => {
      const res = await inner.request<Ga4RunReportResponse>({ url: req.url, method: req.method as 'GET' | 'POST', ...(req.body ? { data: req.body } : {}) });
      const data = res.data as Ga4RunReportResponse & { metricHeaders?: { name: string }[] };
      const idx = (data.metricHeaders ?? []).findIndex((h) => h.name === 'sessionKeyEventRate:generate_lead');
      if (idx >= 0) for (const row of data.rows ?? []) row.metricValues![idx]!.value = String(Number(row.metricValues![idx]!.value) * 100);
      return { body: data };
    });
    const r = await syncGa4(ctx, { provider: providerFor(client, 'fixture'), days: 5, retry: FAST_RETRY, periodWindows: [] });
    expect(r.rateScale.detected).toBe('percent_0_100');
    const max = ctx.db.get<{ m: number }>('SELECT MAX(primary_session_rate) AS m FROM ga4_landing_daily_current WHERE site_id = ?', [ctx.siteId])!.m;
    expect(max).toBeLessThanOrEqual(1);
  });
  it('marks stored rates with an undetermined scale when nothing proves 0-100', async () => {
    ctx = googleTestContext({ now: NOW });
    const r = await syncGa4(ctx, { provider: fixtureProvider(ctx), days: 3, retry: FAST_RETRY, periodWindows: [7] });
    expect(r.rateScale).toMatchObject({ detected: 'undetermined', normalized: false, source: 'none' });
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_landing_daily_current WHERE site_id = ? AND primary_session_rate IS NOT NULL AND primary_session_rate_scale = 'undetermined'", [ctx.siteId])).toBeGreaterThan(0);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM ga4_landing_daily_current WHERE site_id = ? AND primary_session_rate IS NOT NULL AND primary_session_rate_scale IS NOT \'undetermined\'', [ctx.siteId])).toBe(0);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_period_metrics_current WHERE site_id = ? AND metric LIKE '%KeyEventRate:%' AND value IS NOT NULL AND rate_scale = 'undetermined'", [ctx.siteId])).toBeGreaterThan(0);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_period_metrics_current WHERE site_id = ? AND metric = 'totalUsers' AND rate_scale IS NOT NULL", [ctx.siteId])).toBe(0);
    expect(r.warnings.join('\n')).toMatch(/marked scale "undetermined"/);
  });

  it('decides the rate scale before writing any row and remembers it for later syncs', async () => {
    ctx = googleTestContext({ now: NOW });
    const inner = await fixtureProvider(ctx).getClient();
    // Only the all_organic landing report (fetched AFTER google_organic) reveals the 0-100 scale.
    const isAllOrganicLanding = (b: RunReportBody) => JSON.stringify(b.dimensionFilter ?? {}).includes('sessionDefaultChannelGroup') && (b.dimensions ?? []).some((d) => d.name === 'hostName');
    const r1 = await syncGa4(ctx, { provider: providerFor(rewriting(inner, scaleRate(100, isAllOrganicLanding)), 'fixture'), days: 3, retry: FAST_RETRY, periodWindows: [] });
    expect(r1.rateScale).toMatchObject({ detected: 'percent_0_100', normalized: true, source: 'this_sync' });
    // google_organic rows were written with the same scale decision (no raw values next to normalized ones).
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_landing_daily_current WHERE site_id = ? AND primary_session_rate IS NOT NULL AND primary_session_rate_scale <> 'percent_normalized'", [ctx.siteId])).toBe(0);
    expect(ctx.db.get<{ m: number }>("SELECT MAX(primary_session_rate) AS m FROM ga4_landing_daily_current WHERE site_id = ? AND channel_view = 'google_organic'", [ctx.siteId])!.m).toBeLessThanOrEqual(0.01);
    expect(ctx.db.get('SELECT key_event_rate_scale AS s FROM ga4_property_metadata WHERE site_id = ?', [ctx.siteId])).toEqual({ s: 'percent_0_100' });

    // Later sync: every value is <= 1 (e.g. an incremental refresh of pages converting under 1%): the stored finding still applies.
    const r2 = await syncGa4(ctx, { provider: providerFor(inner, 'fixture'), days: 3, retry: FAST_RETRY, periodWindows: [] });
    expect(r2.rateScale).toMatchObject({ detected: 'percent_0_100', normalized: true, source: 'stored' });
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_landing_daily_current WHERE site_id = ? AND primary_session_rate IS NOT NULL AND primary_session_rate_scale <> 'percent_normalized'", [ctx.siteId])).toBe(0);
    expect(ctx.db.get<{ m: number }>('SELECT MAX(primary_session_rate) AS m FROM ga4_landing_daily_current WHERE site_id = ?', [ctx.siteId])!.m).toBeLessThanOrEqual(0.01);
    expect(r2.warnings.join('\n')).toMatch(/stored finding/);
  });

  it('retires landing rows GA4 stops returning when the report is complete', async () => {
    ctx = googleTestContext({ now: NOW });
    const provider = fixtureProvider(ctx, { ga4DatasetOverrides: { subjectToThresholding: false } });
    await syncGa4(ctx, { provider, days: 3, retry: FAST_RETRY, periodWindows: [7] });
    const pricing = () => count(ctx, "SELECT COUNT(*) AS n FROM ga4_landing_daily_current WHERE site_id = ? AND landing_page = '/pricing'", [ctx.siteId]);
    const before = pricing();
    expect(before).toBeGreaterThan(0);
    const sessionsBefore = ctx.db.get<{ s: number }>("SELECT SUM(sessions) AS s FROM ga4_landing_daily_current WHERE site_id = ? AND channel_view = 'google_organic'", [ctx.siteId])!.s;
    const pricingSessions = ctx.db.get<{ s: number }>("SELECT SUM(sessions) AS s FROM ga4_landing_daily_current WHERE site_id = ? AND channel_view = 'google_organic' AND landing_page = '/pricing'", [ctx.siteId])!.s;

    const r = await syncGa4(ctx, { provider: providerFor(rewriting(await provider.getClient(), dropLanding('/pricing')), 'fixture'), days: 3, retry: FAST_RETRY, periodWindows: [7] });
    const landing = r.datasets.filter((d) => d.dataset === 'ga4_landing_daily');
    expect(landing.reduce((n, d) => n + d.rowsRetired, 0)).toBe(before);
    expect(pricing()).toBe(0);
    // Current totals no longer add the stale rows to the fresh ones.
    expect(ctx.db.get<{ s: number }>("SELECT SUM(sessions) AS s FROM ga4_landing_daily_current WHERE site_id = ? AND channel_view = 'google_organic'", [ctx.siteId])!.s).toBe(sessionsBefore - pricingSessions);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_landing_daily WHERE site_id = ? AND landing_page = '/pricing' AND is_current = 0 AND superseded_by_batch_id IS NOT NULL", [ctx.siteId])).toBe(before);
    // Per-landing event rows and per-landing period rows are retired in their own exact scopes.
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_event_daily_current WHERE site_id = ? AND landing_page = '/pricing'", [ctx.siteId])).toBe(0);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_period_metrics_current WHERE site_id = ? AND landing_page = '/pricing'", [ctx.siteId])).toBe(0);
    // Site-level rows are untouched by the per-landing scopes.
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_event_daily_current WHERE site_id = ? AND landing_page = ''", [ctx.siteId])).toBeGreaterThan(0);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_period_metrics_current WHERE site_id = ? AND landing_page = '' AND metric = 'totalUsers'", [ctx.siteId])).toBeGreaterThan(0);
  });

  it('keeps absent landing rows current when the report is thresholded', async () => {
    ctx = googleTestContext({ now: NOW });
    const provider = fixtureProvider(ctx); // fixture reports subjectToThresholding: true
    await syncGa4(ctx, { provider, days: 3, retry: FAST_RETRY, periodWindows: [] });
    const before = count(ctx, "SELECT COUNT(*) AS n FROM ga4_landing_daily_current WHERE site_id = ? AND landing_page = '/pricing'", [ctx.siteId]);
    const r = await syncGa4(ctx, { provider: providerFor(rewriting(await provider.getClient(), dropLanding('/pricing')), 'fixture'), days: 3, retry: FAST_RETRY, periodWindows: [] });
    const landing = r.datasets.filter((d) => d.dataset === 'ga4_landing_daily');
    expect(landing.every((d) => d.rowsRetired === 0)).toBe(true);
    expect(landing.reduce((n, d) => n + d.rowsStaleRetained, 0)).toBe(before);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_landing_daily_current WHERE site_id = ? AND landing_page = '/pricing'", [ctx.siteId])).toBe(before);
    const cov = JSON.parse(ctx.db.get<{ c: string }>('SELECT coverage_json AS c FROM ingestion_batches WHERE id = ?', [landing[0]!.batchId])!.c);
    expect(cov.retirement.retirementSkippedBecause).toContain('subjectToThresholding');
    expect(r.warnings.join('\n')).toMatch(/report is incomplete \(subjectToThresholding\); they stay current/);
  });

  it('never records an observed zero from an incomplete keyEvents+eventName alternative report', async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'ga4-fixtures-'));
    cpSync(GOOGLE_FIXTURES, tmp, { recursive: true });
    const meta = JSON.parse(readFileSync(path.join(tmp, 'ga4/metadata.json'), 'utf8'));
    meta.metrics = meta.metrics.filter((m: { apiName: string }) => !m.apiName.startsWith('keyEvents:'));
    writeFileSync(path.join(tmp, 'ga4/metadata-alt.json'), JSON.stringify(meta));
    const row = (landing: string) =>
      ctx.db.get<{ primary_key_events: number | null; primary_key_events_status: string }>(
        "SELECT primary_key_events, primary_key_events_status FROM ga4_landing_daily_current WHERE site_id = ? AND channel_view = 'google_organic' AND landing_page = ? AND date = '2026-09-21'",
        [ctx.siteId, landing],
      )!;

    // Thresholded alternative report: rows it does not return are NULL / incomplete, returned rows are observed.
    ctx = googleTestContext({ now: NOW });
    const r = await syncGa4(ctx, { provider: fixtureProvider(ctx, { ga4MetadataFile: 'ga4/metadata-alt.json' }, tmp), days: 4, retry: FAST_RETRY, periodWindows: [] });
    expect(row('/')).toEqual({ primary_key_events: null, primary_key_events_status: 'incomplete' });
    expect(row('/pricing').primary_key_events_status).toBe('observed');
    expect(row('/pricing').primary_key_events).toBeGreaterThan(0);
    const batch = r.datasets.find((d) => d.dataset === 'ga4_landing_daily' && d.view === 'google_organic')!;
    const cov = JSON.parse(ctx.db.get<{ c: string }>('SELECT coverage_json AS c FROM ingestion_batches WHERE id = ?', [batch.batchId])!.c);
    expect(cov.primaryKeyEventsAlternative).toMatchObject({ complete: false, incompleteBecause: ['subjectToThresholding'] });
    expect(cov.primaryKeyEventsAlternative.absentRowsStoredAsIncomplete).toBeGreaterThan(0);
    expect(r.warnings.join('\n')).toMatch(/alternative report is incomplete/);
    ctx.cleanup();

    // Complete alternative report: an absent row is a real zero (GA4 drops all-zero rows).
    ctx = googleTestContext({ now: NOW });
    await syncGa4(ctx, { provider: fixtureProvider(ctx, { ga4MetadataFile: 'ga4/metadata-alt.json', ga4DatasetOverrides: { subjectToThresholding: false } }, tmp), days: 4, retry: FAST_RETRY, periodWindows: [] });
    expect(row('/')).toEqual({ primary_key_events: 0, primary_key_events_status: 'observed' });
    expect(row('/pricing').primary_key_events).toBeGreaterThan(0);
  });

  it('retries a short-term concurrent-requests 429 but stops on token quotas', async () => {
    ctx = googleTestContext({ now: NOW });
    const inner = await fixtureProvider(ctx).getClient();
    let failures = 0;
    const client = new ScriptedClient(async (req) => {
      if (req.url.endsWith(':runReport') && (req.body as RunReportBody).dimensions?.length && failures < 1) {
        failures++;
        return { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Exhausted concurrent requests quota.' } } };
      }
      const res = await inner.request({ url: req.url, method: req.method as 'GET' | 'POST', ...(req.body ? { data: req.body } : {}) });
      return { body: res.data };
    });
    const r = await syncGa4(ctx, { provider: providerFor(client, 'fixture'), days: 2, retry: FAST_RETRY, periodWindows: [] });
    expect(r.status).toBe('succeeded');
    expect(failures).toBe(1);
  });

  it('backfills the all_organic landing view and events after a quota stop, and stays partial until then', async () => {
    ctx = googleTestContext({ now: NOW });
    const inner = await fixtureProvider(ctx).getClient();
    const quota = { exhausted: true };
    const isAllOrganicLanding = (b: RunReportBody) => JSON.stringify(b.dimensionFilter ?? {}).includes('sessionDefaultChannelGroup') && (b.dimensions ?? []).some((d) => d.name === 'hostName');
    const client = new ScriptedClient(async (req) => {
      if (req.url.endsWith(':runReport') && quota.exhausted && isAllOrganicLanding(req.body as RunReportBody)) {
        return { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Exhausted property tokens per hour.' } } };
      }
      const res = await inner.request({ url: req.url, method: req.method as 'GET' | 'POST', ...(req.body ? { data: req.body } : {}) });
      return { body: res.data };
    });
    const provider = providerFor(client, 'fixture');
    const r1 = await syncGa4(ctx, { provider, retry: FAST_RETRY, periodWindows: [] });
    expect(r1.range).toMatchObject({ mode: 'initial', start: '2026-06-26', end: '2026-09-23' });
    expect(r1.status).toBe('partial');
    expect(r1.datasets.find((d) => d.view === 'google_organic' && d.dataset === 'ga4_landing_daily')!.status).toBe('succeeded');
    expect(r1.gaps!.map((g) => g.slice)).toEqual(expect.arrayContaining(['landing all_organic', 'events all_traffic', 'events google_organic by landing']));
    expect(r1.gaps!.map((g) => g.slice)).not.toContain('landing google_organic');
    expect(ga4Coverage(ctx.db, ctx.siteId, { propertyId: SYNTHETIC_GA4, start: '2026-06-26', end: '2026-09-23', channelView: 'all_organic' }).missing).toHaveLength(90);

    // Next run (quota refreshed): google_organic landing refreshes only recent days; the skipped slices are fetched from the window start.
    quota.exhausted = false;
    const before = client.calls.length;
    const r2 = await syncGa4(ctx, { provider, retry: FAST_RETRY, periodWindows: [] });
    expect(r2.range!.mode).toBe('incremental');
    const starts = Object.fromEntries(r2.range!.slices!.map((sl) => [sl.key, sl.start]));
    expect(starts).toEqual({
      'landing google_organic': '2026-09-20',
      'landing all_organic': '2026-06-26',
      'events all_traffic': '2026-06-26',
      'events google_organic': '2026-06-26',
      'events all_organic': '2026-06-26',
      'events google_organic by landing': '2026-06-26',
      'events all_organic by landing': '2026-06-26',
    });
    const reports = client.calls.slice(before).filter((c) => c.url.endsWith(':runReport') && (c.body as RunReportBody).dimensions?.some((d) => d.name === 'date'));
    const startOf = (pred: (b: RunReportBody) => boolean) => reports.filter((c) => pred(c.body as RunReportBody)).map((c) => (c.body as { dateRanges: { startDate: string }[] }).dateRanges[0]!.startDate);
    expect(new Set(startOf(isAllOrganicLanding))).toEqual(new Set(['2026-06-26']));
    expect(new Set(startOf((b) => (b.dimensions ?? []).some((d) => d.name === 'eventName')))).toEqual(new Set(['2026-06-26']));
    expect(new Set(startOf((b) => !isAllOrganicLanding(b) && (b.dimensions ?? []).some((d) => d.name === 'hostName')))).toEqual(new Set(['2026-09-20']));
    expect(r2.warnings.join('\n')).toMatch(/Backfill: landing all_organic is re-requested from 2026-06-26/);
    expect(r2.gaps).toBeUndefined();
    expect(r2.status).toBe('succeeded');
    expect(ga4Coverage(ctx.db, ctx.siteId, { propertyId: SYNTHETIC_GA4, start: '2026-06-26', end: '2026-09-23', channelView: 'all_organic' }).missing).toEqual([]);
    expect(ga4Coverage(ctx.db, ctx.siteId, { propertyId: SYNTHETIC_GA4, start: '2026-06-26', end: '2026-09-23', channelView: 'all_traffic', dataset: 'ga4_event_daily', variant: 'all_landing_pages' }).missing).toEqual([]);
  });

  it('records paging stopped at the quota reserve as interrupted collection and backfills it', async () => {
    ctx = googleTestContext({ now: NOW });
    const inner = await fixtureProvider(ctx).getClient();
    let lowQuota = true;
    // Report a nearly exhausted token quota on the first page of the all_organic landing report only.
    const client = new ScriptedClient(async (req) => {
      const res = await inner.request<Ga4RunReportResponse>({ url: req.url, method: req.method as 'GET' | 'POST', ...(req.body ? { data: req.body } : {}) });
      const data = JSON.parse(JSON.stringify(res.data)) as Ga4RunReportResponse & { propertyQuota?: Record<string, { consumed?: number; remaining?: number }> };
      const b = req.body as RunReportBody & { offset?: string };
      if (lowQuota && req.url.endsWith(':runReport') && JSON.stringify(b.dimensionFilter ?? {}).includes('sessionDefaultChannelGroup') && (b.dimensions ?? []).some((d) => d.name === 'hostName') && data.propertyQuota) {
        data.propertyQuota = { ...data.propertyQuota, tokensPerHour: { consumed: 10, remaining: 1 } };
      }
      return { body: data };
    });
    const r1 = await syncGa4(ctx, { provider: providerFor(client, 'fixture'), days: 5, limit: 5, retry: FAST_RETRY, periodWindows: [], includeLandingEvents: false });
    expect(r1.status).toBe('partial');
    const allOrganic = r1.datasets.find((d) => d.dataset === 'ga4_landing_daily' && d.view === 'all_organic')!;
    expect(allOrganic.truncated).toBe(true);
    const cov = JSON.parse(ctx.db.get<{ c: string }>('SELECT coverage_json AS c FROM ingestion_batches WHERE id = ?', [allOrganic.batchId])!.c);
    expect(cov).toMatchObject({ interrupted: true, collectedRanges: [] });
    const c = ga4Coverage(ctx.db, ctx.siteId, { propertyId: SYNTHETIC_GA4, start: '2026-09-19', end: '2026-09-23', channelView: 'all_organic' });
    expect(c.interrupted!.length).toBeGreaterThan(0);
    expect(r1.gaps!.some((g) => g.slice === 'landing all_organic')).toBe(true);
    lowQuota = false;
    const r2 = await syncGa4(ctx, { provider: providerFor(client, 'fixture'), days: 5, limit: 5, retry: FAST_RETRY, periodWindows: [], includeLandingEvents: false });
    expect(r2.status).toBe('succeeded');
    expect(ga4Coverage(ctx.db, ctx.siteId, { propertyId: SYNTHETIC_GA4, start: '2026-09-19', end: '2026-09-23', channelView: 'all_organic' }).interrupted).toEqual([]);
  });
});

/** Rewrite landing-report rates so that rate x sessions is a whole number of converting sessions (a 0-1 property). */
function integerConsistentRates() {
  return (body: RunReportBody, data: Ga4RunReportResponse) => {
    if (!(body.dimensions ?? []).some((d) => d.name === 'hostName')) return;
    const heads = data.metricHeaders ?? [];
    const si = heads.findIndex((h) => h.name === 'sessions');
    const ri = heads.findIndex((h) => /^sessionKeyEventRate:/.test(h.name));
    if (si < 0 || ri < 0) return;
    for (const row of data.rows ?? []) {
      const sessions = Number(row.metricValues![si]!.value);
      if (!(sessions > 0)) continue;
      const k = Math.min(sessions, Math.max(1, Math.round(Number(row.metricValues![ri]!.value) * sessions)));
      row.metricValues![ri]!.value = String(k / sessions);
    }
  };
}

describe('establishing the GA4 key-event rate scale (B3-01)', () => {
  const currentScales = () => ctx.db.all<{ s: string | null; n: number }>('SELECT primary_session_rate_scale AS s, COUNT(*) AS n FROM ga4_landing_daily_current WHERE site_id = ? AND primary_session_rate IS NOT NULL GROUP BY 1 ORDER BY 1', [ctx.siteId]);

  it('an owner confirmation re-marks earlier rows and later syncs store rates on the confirmed scale', async () => {
    ctx = googleTestContext({ now: NOW });
    await syncGa4(ctx, { provider: fixtureProvider(ctx), days: 5, retry: FAST_RETRY, periodWindows: [7] });
    expect(currentScales()).toEqual([{ s: 'undetermined', n: expect.any(Number) }]);
    const raw = ctx.db.get<{ r: number }>("SELECT primary_session_rate AS r FROM ga4_landing_daily_current WHERE site_id = ? AND landing_page = '/pricing' AND channel_view = 'google_organic' AND date = '2026-09-20'", [ctx.siteId])!.r;

    const c = confirmRateScale(ctx, SYNTHETIC_GA4, { scale: 'fraction', evidence: 'GA4 UI shows the same value as a percentage x 100 for /pricing on 2026-09-20', actor: 'owner:Test Owner' });
    expect(c.remarked.landingRows).toBeGreaterThan(0);
    expect(c.remarked.periodRows).toBeGreaterThan(0);
    expect(currentScales()).toEqual([{ s: 'fraction', n: expect.any(Number) }]);
    expect(ctx.db.get<{ r: number }>("SELECT primary_session_rate AS r FROM ga4_landing_daily_current WHERE site_id = ? AND landing_page = '/pricing' AND channel_view = 'google_organic' AND date = '2026-09-20'", [ctx.siteId])!.r).toBe(raw);
    const audit = ctx.db.get<{ actor: string; details_json: string }>("SELECT actor, details_json FROM audit_events WHERE site_id = ? AND event_type = 'google.ga4.rate_scale_confirmed'", [ctx.siteId])!;
    expect(audit.actor).toBe('owner:Test Owner');
    expect(JSON.parse(audit.details_json)).toMatchObject({ scale: 'fraction', basis: 'owner_assertion', evidence: expect.stringContaining('/pricing'), remarked: c.remarked });

    const r = await syncGa4(ctx, { provider: fixtureProvider(ctx), days: 5, retry: FAST_RETRY, periodWindows: [7] });
    expect(r.rateScale).toMatchObject({ detected: 'fraction_0_1', normalized: false, source: 'confirmed', confirmation: { id: c.confirmationId, basis: 'owner_assertion' } });
    expect(currentScales()).toEqual([{ s: 'fraction', n: expect.any(Number) }]);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_period_metrics_current WHERE site_id = ? AND value IS NOT NULL AND rate_scale = 'undetermined'", [ctx.siteId])).toBe(0);
    expect(r.warnings.join('\n')).toMatch(/0-1 scale \(recorded owner confirmation/);
  });

  it('a later sync that proves 0-100 re-marks the older undetermined rows it did not re-fetch', async () => {
    ctx = googleTestContext({ now: NOW });
    const inner = await fixtureProvider(ctx).getClient();
    await syncGa4(ctx, { provider: providerFor(inner, 'fixture'), days: 10, retry: FAST_RETRY, periodWindows: [] });
    const oldRaw = ctx.db.get<{ r: number }>("SELECT primary_session_rate AS r FROM ga4_landing_daily_current WHERE site_id = ? AND landing_page = '/pricing' AND channel_view = 'google_organic' AND date = '2026-09-14'", [ctx.siteId])!.r;
    // Only the last 3 days are re-fetched, now on a 0-100 scale.
    const r = await syncGa4(ctx, { provider: providerFor(rewriting(inner, scaleRate(100)), 'fixture'), days: 3, retry: FAST_RETRY, periodWindows: [] });
    expect(r.rateScale).toMatchObject({ detected: 'percent_0_100', source: 'this_sync' });
    expect(r.rateScale.remarked!.landingRows).toBeGreaterThan(0);
    expect(currentScales()).toEqual([{ s: 'percent_normalized', n: expect.any(Number) }]);
    const old = ctx.db.get<{ r: number; t: string }>("SELECT primary_session_rate AS r, transformation_version AS t FROM ga4_landing_daily_current WHERE site_id = ? AND landing_page = '/pricing' AND channel_view = 'google_organic' AND date = '2026-09-14'", [ctx.siteId])!;
    expect(old.r).toBeCloseTo(oldRaw / 100, 12);
    expect(old.t).toMatch(/\+rate-scale:percent@observed-above-1$/);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM audit_events WHERE site_id = ? AND event_type = 'google.ga4.rate_scale_remarked'", [ctx.siteId])).toBe(1);
  });

  it('a value above 1 wins over a recorded 0-1 confirmation (reported as a contradiction) and re-marks its rows', async () => {
    ctx = googleTestContext({ now: NOW });
    const inner = await fixtureProvider(ctx).getClient();
    await syncGa4(ctx, { provider: providerFor(inner, 'fixture'), days: 8, retry: FAST_RETRY, periodWindows: [] });
    confirmRateScale(ctx, SYNTHETIC_GA4, { scale: 'fraction', evidence: 'mistaken comparison with the wrong GA4 report', actor: 'Alice' });
    const r = await syncGa4(ctx, { provider: providerFor(rewriting(inner, scaleRate(100)), 'fixture'), days: 3, retry: FAST_RETRY, periodWindows: [] });
    expect(r.rateScale.detected).toBe('percent_0_100');
    expect(r.rateScale.contradiction).toMatch(/recorded 0-1 confirmation .* is contradicted/);
    expect(r.warnings.join('\n')).toMatch(/is contradicted/);
    expect(currentScales()).toEqual([{ s: 'percent_normalized', n: expect.any(Number) }]);
    expect(effectiveRateScale(ctx, SYNTHETIC_GA4)).toMatchObject({ scale: 'percent', source: 'observed_above_1', contradiction: expect.stringMatching(/owner confirmation of a 0-1 scale .* is contradicted/) });
    // A 0-1 confirmation is now refused.
    expect(() => confirmRateScale(ctx, SYNTHETIC_GA4, { scale: 'fraction', evidence: 'trying again with the same mistake', actor: 'Alice' })).toThrow(/cannot be on a 0-1 scale/);
  });

  it('proves 0-1 from integer-consistent small daily rows, records it, and re-marks the rows (never a guess)', async () => {
    ctx = googleTestContext({ now: NOW });
    const inner = await fixtureProvider(ctx).getClient();
    const r = await syncGa4(ctx, { provider: providerFor(rewriting(inner, integerConsistentRates()), 'fixture'), days: 5, retry: FAST_RETRY, periodWindows: [] });
    expect(r.rateScale).toMatchObject({ detected: 'fraction_0_1', source: 'proven', confirmation: { basis: 'integer_consistency', actor: 'system' } });
    expect(currentScales()).toEqual([{ s: 'fraction', n: expect.any(Number) }]);
    const conf = ctx.db.get<{ basis: string; actor: string; evidence: string; evidence_json: string }>('SELECT basis, actor, evidence, evidence_json FROM ga4_rate_scale_confirmations WHERE site_id = ?', [ctx.siteId])!;
    expect(conf).toMatchObject({ basis: 'integer_consistency', actor: 'system' });
    expect(conf.evidence).toMatch(/whole number of converting sessions/);
    expect(JSON.parse(conf.evidence_json)).toMatchObject({ inconsistentRows: 0, consistentRows: expect.any(Number) });
    expect(count(ctx, "SELECT COUNT(*) AS n FROM audit_events WHERE site_id = ? AND event_type = 'google.ga4.rate_scale_confirmed' AND actor = 'system'", [ctx.siteId])).toBe(1);
    // The unmodified fixture rates are not integer-consistent: nothing is decided (see the "undetermined" test above).
  });
});
