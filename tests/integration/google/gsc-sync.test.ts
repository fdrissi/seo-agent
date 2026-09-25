import { afterEach, describe, expect, it } from 'vitest';
import { syncGsc } from '../../../src/integrations/google/gsc-sync.js';
import { gscCoverage } from '../../../src/seo/coverage.js';
import { GoogleApiError } from '../../../src/integrations/google/errors.js';
import { AppError } from '../../../src/core/errors.js';
import { FAST_RETRY, ScriptedClient, SYNTHETIC_PROPERTY, count, googleConfig, googleTestContext, providerFor, sitesList, type ScriptedReply } from './_helpers.js';
import type { TestContext } from '../../helpers/context.js';

/**
 * Recorded-shape (synthetic) Search Console responses. Clock: 2026-09-24T09:00Z
 * = 2026-09-24 in America/Los_Angeles, so a 5-day window ends 2026-09-23.
 */
const NOW = '2026-09-24T09:00:00.000Z';
const PAGE_A = 'https://www.example.test/a';
const PAGE_B = 'https://www.example.test/b';

interface Day {
  date: string;
  clicks: number;
  impressions: number;
}

function gscHandler(state: { totals: Day[]; firstIncomplete: string | null; casing?: 'snake' | 'camel'; pageRows?: (date: string) => unknown[]; queryRows?: (page: string) => unknown[] }) {
  return (req: { method: string; path: string; body: any }): ScriptedReply => {
    if (req.method === 'GET' && req.path === '/webmasters/v3/sites') return sitesList([[SYNTHETIC_PROPERTY, 'siteRestrictedUser'], ['https://www.example.test/', 'siteFullUser']]);
    const b = req.body;
    const start = b.startRow ?? 0;
    const limit = b.rowLimit ?? 1000;
    let rows: unknown[] = [];
    const dims: string[] = b.dimensions ?? [];
    if (dims.join() === 'date') rows = state.totals.filter((d) => d.date >= b.startDate && d.date <= b.endDate).map((d) => ({ keys: [d.date], clicks: d.clicks, impressions: d.impressions, ctr: d.impressions ? d.clicks / d.impressions : 0, position: 4.2 }));
    else if (dims.join() === 'date,page') rows = state.pageRows ? state.pageRows(b.startDate) : [];
    else if (dims.join() === 'date,page,query') rows = state.queryRows ? state.queryRows(b.dimensionFilterGroups[0].filters[0].expression) : [];
    const page = rows.slice(start, start + limit);
    const metadata = state.firstIncomplete && b.dataState === 'all' && dims.includes('date') ? (state.casing === 'camel' ? { firstIncompleteDate: state.firstIncomplete } : { first_incomplete_date: state.firstIncomplete }) : undefined;
    return { body: { ...(page.length ? { rows: page } : {}), responseAggregationType: dims.includes('page') ? 'byPage' : 'byProperty', ...(metadata ? { metadata } : {}) } };
  };
}

const TOTALS: Day[] = [
  { date: '2026-09-19', clicks: 10, impressions: 100 },
  { date: '2026-09-20', clicks: 0, impressions: 40 }, // observed zero clicks
  // 2026-09-21 omitted by the API: missing, not zero
  { date: '2026-09-22', clicks: 5, impressions: 60 },
  { date: '2026-09-23', clicks: 2, impressions: 20 },
];

function pageRows(date: string) {
  if (date === '2026-09-21') return [];
  return [
    { keys: [date, PAGE_A], clicks: 3, impressions: 30, ctr: 0.1, position: 3 },
    { keys: [date, PAGE_B], clicks: 1, impressions: 25, ctr: 0.04, position: 8 },
  ];
}

function queryRows(page: string) {
  return page === PAGE_A
    ? [
        { keys: ['2026-09-19', PAGE_A, 'widgets'], clicks: 2, impressions: 12, ctr: 0.1667, position: 2.5 },
        { keys: ['2026-09-20', PAGE_A, 'widgets'], clicks: 0, impressions: 5, ctr: 0, position: 3.1 },
      ]
    : [{ keys: ['2026-09-19', PAGE_B, 'gadgets'], clicks: 1, impressions: 7, ctr: 0.14, position: 6 }];
}

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

describe('syncGsc (recorded-shape synthetic responses)', () => {
  it('ingests separate datasets, keeps missing days missing, and is idempotent on re-sync', async () => {
    ctx = googleTestContext({ now: NOW });
    const state = { totals: TOTALS.map((d) => ({ ...d })), firstIncomplete: '2026-09-22', pageRows, queryRows };
    const client = new ScriptedClient(gscHandler(state));
    const opts = { provider: providerFor(client), days: 5, retry: FAST_RETRY, topPages: 2 };
    const r1 = await syncGsc(ctx, opts);
    expect(r1.status).toBe('succeeded');
    expect(r1.ranges[0]).toMatchObject({ start: '2026-09-19', end: '2026-09-23', mode: 'explicit' });

    const totals = ctx.db.all<{ date: string; clicks: number; is_final: number; revision: number; date_tz: string; aggregation_type: string; is_synthetic: number }>(
      'SELECT date, clicks, is_final, revision, date_tz, aggregation_type, is_synthetic FROM gsc_property_daily_current WHERE site_id = ? ORDER BY date',
      [ctx.siteId],
    );
    expect(totals.map((t) => t.date)).toEqual(['2026-09-19', '2026-09-20', '2026-09-22', '2026-09-23']);
    // Missing day is not stored as zero; the observed zero-click day is stored as 0.
    expect(totals.find((t) => t.date === '2026-09-21')).toBeUndefined();
    expect(totals.find((t) => t.date === '2026-09-20')!.clicks).toBe(0);
    // Finality from first_incomplete_date.
    expect(totals.map((t) => t.is_final)).toEqual([1, 1, 0, 0]);
    expect(totals.every((t) => t.date_tz === 'America/Los_Angeles' && t.aggregation_type === 'byProperty' && t.is_synthetic === 0)).toBe(true);

    const batch = ctx.db.get<{ coverage_json: string; metadata_json: string; status: string; raw_refs_json: string }>(
      "SELECT coverage_json, metadata_json, status, raw_refs_json FROM ingestion_batches WHERE site_id = ? AND dataset = 'gsc_property_daily'",
      [ctx.siteId],
    )!;
    expect(JSON.parse(batch.coverage_json).datesWithoutRows).toEqual(['2026-09-21']);
    expect(JSON.parse(batch.metadata_json).firstIncompleteSource).toBe('api');
    expect(JSON.parse(batch.raw_refs_json).length).toBeGreaterThan(0);

    const pagesBefore = count(ctx, 'SELECT COUNT(*) AS n FROM gsc_page_daily WHERE site_id = ?', [ctx.siteId]);
    const pqBefore = count(ctx, 'SELECT COUNT(*) AS n FROM gsc_page_query_daily WHERE site_id = ?', [ctx.siteId]);
    expect(pagesBefore).toBe(8); // 4 days x 2 pages
    expect(pqBefore).toBe(3);

    // Page/query coverage reports the unattributed (anonymized + row limit) estimate, never a total.
    const pqBatch = ctx.db.get<{ coverage_json: string }>("SELECT coverage_json FROM ingestion_batches WHERE site_id = ? AND dataset = 'gsc_page_query_daily'", [ctx.siteId])!;
    const pqCov = JSON.parse(pqBatch.coverage_json);
    const a = pqCov.pages.find((p: { page: string }) => p.page === PAGE_A);
    expect(a.pageTotalClicks).toBe(12);
    expect(a.visibleQueryClicks).toBe(2);
    expect(a.unattributedClicksEstimate).toBe(10);

    // Availability record.
    const av = ctx.db.get<{ first_incomplete_date: string; latest_final_date: string; latest_any_date: string }>('SELECT * FROM gsc_data_availability WHERE site_id = ?', [ctx.siteId])!;
    expect(av).toMatchObject({ first_incomplete_date: '2026-09-22', latest_final_date: '2026-09-20', latest_any_date: '2026-09-23' });

    // Provider requests are logged and never paid.
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM provider_requests WHERE site_id = ? AND is_paid = 1', [ctx.siteId])).toBe(0);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM provider_requests WHERE site_id = ? AND provider = 'google_gsc' AND status = 'succeeded'", [ctx.siteId])).toBe(client.calls.length);

    // Re-sync with identical data: nothing new, nothing double counted.
    const r2 = await syncGsc(ctx, opts);
    expect(r2.datasets.every((d) => d.rowsNewRevision === 0)).toBe(true);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM gsc_property_daily WHERE site_id = ?', [ctx.siteId])).toBe(4);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM gsc_page_daily WHERE site_id = ?', [ctx.siteId])).toBe(pagesBefore);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM gsc_page_query_daily WHERE site_id = ?', [ctx.siteId])).toBe(pqBefore);
    expect(ctx.db.get<{ s: number }>('SELECT SUM(clicks) AS s FROM gsc_property_daily_current WHERE site_id = ?', [ctx.siteId])!.s).toBe(17);
  });

  it('creates revision 2 and flips is_current when a delayed value changes', async () => {
    ctx = googleTestContext({ now: NOW });
    const state = { totals: TOTALS.map((d) => ({ ...d })), firstIncomplete: '2026-09-22' as string | null };
    const opts = { provider: providerFor(new ScriptedClient(gscHandler(state))), days: 5, retry: FAST_RETRY, includePageQuery: false };
    await syncGsc(ctx, opts);
    // Google revises 2026-09-22 (now final) and 2026-09-23 stays incomplete.
    state.totals = state.totals.map((d) => (d.date === '2026-09-22' ? { ...d, clicks: 7, impressions: 66 } : d));
    state.firstIncomplete = '2026-09-23';
    const r = await syncGsc(ctx, opts);
    const totals = r.datasets.find((d) => d.dataset === 'gsc_property_daily')!;
    expect(totals.rowsRevised).toBe(1);
    expect(totals.rowsUnchanged).toBe(3);
    const revs = ctx.db.all<{ revision: number; is_current: number; clicks: number; is_final: number; batch_id: string }>(
      "SELECT revision, is_current, clicks, is_final, batch_id FROM gsc_property_daily WHERE site_id = ? AND date = '2026-09-22' ORDER BY revision",
      [ctx.siteId],
    );
    expect(revs).toHaveLength(2);
    expect(revs[0]).toMatchObject({ revision: 1, is_current: 0, clicks: 5, is_final: 0 });
    expect(revs[1]).toMatchObject({ revision: 2, is_current: 1, clicks: 7, is_final: 1 });
    expect(revs[0]!.batch_id).not.toBe(revs[1]!.batch_id);
    // Current view never double counts.
    expect(ctx.db.get<{ s: number }>('SELECT SUM(clicks) AS s FROM gsc_property_daily_current WHERE site_id = ?', [ctx.siteId])!.s).toBe(19);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM gsc_property_daily_current WHERE site_id = ? AND date = '2026-09-22'", [ctx.siteId])).toBe(1);
  });

  it('paginates with startRow until an empty page', async () => {
    ctx = googleTestContext({ now: NOW });
    const client = new ScriptedClient(gscHandler({ totals: TOTALS, firstIncomplete: null }));
    const r = await syncGsc(ctx, { provider: providerFor(client), days: 5, retry: FAST_RETRY, rowLimit: 2, includePageQuery: false });
    const totals = r.datasets.find((d) => d.dataset === 'gsc_property_daily')!;
    expect(totals.apiPages).toBe(3); // rows 0-1, 2-3, then an empty page
    expect(totals.rowsReceived).toBe(4);
    const startRows = client.calls.filter((c) => c.body?.dimensions?.join() === 'date').map((c) => c.body.startRow);
    expect(startRows).toEqual([0, 2, 4]);
    // No first_incomplete_date reported: recent days are conservatively not final.
    expect(r.availability[0]!.firstIncompleteSource).toBe('assumed');
    expect(r.warnings.some((w) => /conservatively treated as not final/.test(w))).toBe(true);
  });

  it('accepts camelCase metadata (wire casing unverified)', async () => {
    ctx = googleTestContext({ now: NOW });
    const client = new ScriptedClient(gscHandler({ totals: TOTALS, firstIncomplete: '2026-09-22', casing: 'camel' }));
    const r = await syncGsc(ctx, { provider: providerFor(client), days: 5, retry: FAST_RETRY, includePageQuery: false });
    expect(r.availability[0]).toMatchObject({ firstIncompleteDate: '2026-09-22', firstIncompleteSource: 'api' });
  });

  it('backs off on 429 and 5xx, then succeeds; logs one provider request per logical call', async () => {
    ctx = googleTestContext({ now: NOW });
    const inner = gscHandler({ totals: TOTALS, firstIncomplete: '2026-09-22' });
    let failures = 0;
    const client = new ScriptedClient((req, n) => {
      if (req.path.endsWith('/searchAnalytics/query') && failures < 2) {
        failures++;
        return failures === 1 ? { status: 429, body: { error: { code: 429, message: 'Rate limit', errors: [{ reason: 'rateLimitExceeded' }] } }, headers: { 'retry-after': '0' } } : { status: 503, body: { error: { code: 503, message: 'backendError' } } };
      }
      return inner(req);
    });
    const r = await syncGsc(ctx, { provider: providerFor(client), days: 5, retry: FAST_RETRY, includePageQuery: false });
    expect(r.status).toBe('succeeded');
    expect(failures).toBe(2);
    const logged = ctx.db.all<{ status: string }>("SELECT status FROM provider_requests WHERE site_id = ? AND endpoint = 'searchanalytics.query'", [ctx.siteId]);
    expect(logged.every((l) => l.status === 'succeeded')).toBe(true);
  });

  it('stops with a partial status when the quota stays exhausted', async () => {
    ctx = googleTestContext({ now: NOW });
    let queries = 0;
    const client = new ScriptedClient((req) => {
      if (req.method === 'GET') return sitesList([[SYNTHETIC_PROPERTY, 'siteFullUser']]);
      queries++;
      return { status: 403, body: { error: { code: 403, message: 'Search Analytics load quota exceeded.', errors: [{ reason: 'quotaExceeded' }] } } };
    });
    const r = await syncGsc(ctx, { provider: providerFor(client), days: 3, retry: FAST_RETRY, pacingMs: 0 });
    expect(r.status).toBe('partial');
    // The load quota needs >= 15 minutes: it is not retried within seconds (contract section 2).
    expect(queries).toBe(1);
    expect(r.datasets[0]).toMatchObject({ dataset: 'gsc_property_daily', status: 'failed' });
    expect(r.warnings.join(' ')).toMatch(/at least 15 minutes/);
  });

  it('does not retry permission errors and records a failed batch', async () => {
    ctx = googleTestContext({ now: NOW });
    let queries = 0;
    const client = new ScriptedClient((req) => {
      if (req.method === 'GET') return sitesList([[SYNTHETIC_PROPERTY, 'siteFullUser']]);
      queries++;
      return { status: 403, body: { error: { code: 403, message: "User does not have sufficient permission for site 'sc-domain:example.test'.", errors: [{ reason: 'forbidden' }] } } };
    });
    await expect(syncGsc(ctx, { provider: providerFor(client), days: 5, retry: FAST_RETRY })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', kind: 'permission_denied' });
    expect(queries).toBe(1);
    expect(ctx.db.get<{ status: string }>("SELECT status FROM ingestion_batches WHERE site_id = ? AND dataset = 'gsc_property_daily'", [ctx.siteId])!.status).toBe('failed');
    expect(count(ctx, "SELECT COUNT(*) AS n FROM provider_requests WHERE site_id = ? AND status = 'failed'", [ctx.siteId])).toBe(1);
  });

  it('never guesses a property: an inaccessible configured property fails with exact suggestions', async () => {
    ctx = googleTestContext({ now: NOW, config: googleConfig({ google: { searchConsoleProperty: 'https://example.test/' } }) });
    const client = new ScriptedClient(() => sitesList([[SYNTHETIC_PROPERTY, 'siteFullUser'], ['https://www.example.test/', 'siteRestrictedUser'], ['https://other.example.net/', 'siteOwner']]));
    const err = await syncGsc(ctx, { provider: providerFor(client), days: 5, retry: FAST_RETRY }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.details.suggestions).toEqual(expect.arrayContaining([SYNTHETIC_PROPERTY, 'https://www.example.test/']));
    expect(err.details.suggestions).not.toContain('https://other.example.net/');
    expect(client.calls).toHaveLength(1); // only sites.list; no data queries against a guessed property
    expect(ctx.db.all('SELECT property FROM gsc_properties WHERE site_id = ? ORDER BY property', [ctx.siteId])).toHaveLength(3);
  });

  it('rejects an unverified-user property', async () => {
    ctx = googleTestContext({ now: NOW });
    const client = new ScriptedClient(() => sitesList([[SYNTHETIC_PROPERTY, 'SITE_UNVERIFIED_USER']]));
    await expect(syncGsc(ctx, { provider: providerFor(client), days: 5 })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('dry run makes no request and writes nothing', async () => {
    ctx = googleTestContext({ now: NOW });
    const client = new ScriptedClient(() => {
      throw new Error('must not be called');
    });
    const r = await syncGsc(ctx, { provider: providerFor(client), dryRun: true });
    expect(r.status).toBe('dry_run');
    expect(r.ranges[0]).toMatchObject({ mode: 'initial', start: '2026-06-26', end: '2026-09-23' }); // 90 days inclusive
    expect(r.plan!.estimatedMinRequests).toBeGreaterThan(0);
    expect(client.calls).toHaveLength(0);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM ingestion_batches WHERE site_id = ?', [ctx.siteId])).toBe(0);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM provider_requests WHERE site_id = ?', [ctx.siteId])).toBe(0);
  });

  it('refuses to run offline with a live provider and reports disabled features honestly', async () => {
    ctx = googleTestContext({ now: NOW, offline: true });
    const client = new ScriptedClient(() => ({ body: {} }));
    // Offline Google errors carry their own code (errors.ts maps kind 'offline' to OFFLINE).
    await expect(syncGsc(ctx, { provider: providerFor(client), days: 3 })).rejects.toMatchObject({ kind: 'offline', code: 'OFFLINE' });
    expect(client.calls).toHaveLength(0);
    ctx.cleanup();
    ctx = googleTestContext({ now: NOW, config: googleConfig({ features: { gsc: false } }) });
    const r = await syncGsc(ctx, { provider: providerFor(client) });
    expect(r.status).toBe('disabled');
  });

  it('requires a configured property', async () => {
    ctx = googleTestContext({ now: NOW, config: googleConfig({ google: { searchConsoleProperty: null } }) });
    await expect(syncGsc(ctx, { provider: providerFor(new ScriptedClient(() => ({ body: {} }))) })).rejects.toMatchObject({ code: 'CONFIG_MISSING' });
  });

  it('computes an incremental range after the initial sync', async () => {
    ctx = googleTestContext({ now: NOW });
    const totals: Day[] = [];
    for (let i = 0; i < 90; i++) {
      const d = new Date(Date.parse('2026-06-25T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10);
      totals.push({ date: d, clicks: 1, impressions: 10 });
    }
    const client = new ScriptedClient(gscHandler({ totals, firstIncomplete: '2026-09-22' }));
    const r1 = await syncGsc(ctx, { provider: providerFor(client), retry: FAST_RETRY, includePageQuery: false, pageChunkDays: 30 });
    expect(r1.ranges[0]!.mode).toBe('initial');
    const r2 = await syncGsc(ctx, { provider: providerFor(client), retry: FAST_RETRY, includePageQuery: false, pageChunkDays: 30 });
    // refreshRecentDays = 10 (default) and last final date 2026-09-21 -> refresh 2026-09-14..2026-09-23
    expect(r2.ranges[0]).toMatchObject({ mode: 'incremental', start: '2026-09-14', end: '2026-09-23' });
    expect(r2.datasets.find((d) => d.dataset === 'gsc_property_daily')!.rowsNewRevision).toBe(0);
  });

  it('classifies a disabled API distinctly from missing access', async () => {
    ctx = googleTestContext({ now: NOW });
    const client = new ScriptedClient(() => ({
      status: 403,
      body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Google Search Console API has not been used in project 123 before or it is disabled.', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', metadata: { activationUrl: 'https://console.developers.google.com/apis/api/searchconsole.googleapis.com/overview?project=123' } }] } },
    }));
    const err = await syncGsc(ctx, { provider: providerFor(client), days: 2, retry: FAST_RETRY }).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.kind).toBe('api_not_enabled');
    expect(err.hint).toMatch(/Enable the Google Search Console API/);
  });
  it('retires rows Google stops returning on a complete re-sync, never double counts, and revives them if they return', async () => {
    ctx = googleTestContext({ now: NOW });
    const drop = { date: false, page: false, query: false };
    const state = {
      totals: TOTALS.map((d) => ({ ...d })),
      firstIncomplete: '2026-09-22' as string | null,
      pageRows: (date: string) => pageRows(date).filter((r) => !(drop.page && date === '2026-09-22' && r.keys[1] === PAGE_B)),
      queryRows: (page: string) => queryRows(page).filter((r) => !(drop.query && r.keys[2] === 'gadgets')),
    };
    const opts = { provider: providerFor(new ScriptedClient(gscHandler(state))), days: 5, retry: FAST_RETRY, topPages: 2 };
    await syncGsc(ctx, opts);
    const sumClicks = (table: string, extra = '') => ctx.db.get<{ s: number | null }>(`SELECT SUM(clicks) AS s FROM ${table} WHERE site_id = ? ${extra}`, [ctx.siteId])!.s;
    expect(sumClicks('gsc_page_daily_current', "AND date = '2026-09-22'")).toBe(4);
    expect(sumClicks('gsc_property_daily_current')).toBe(17);

    // Google revises: /b disappears on 2026-09-22, the "gadgets" query row disappears, and 2026-09-19 is no longer reported.
    drop.page = true;
    drop.query = true;
    state.totals = state.totals.filter((d) => d.date !== '2026-09-19');
    const r2 = await syncGsc(ctx, opts);
    expect(r2.status).toBe('succeeded');
    const pageDs = r2.datasets.find((d) => d.dataset === 'gsc_page_daily')!;
    const totalsDs = r2.datasets.find((d) => d.dataset === 'gsc_property_daily')!;
    const pqDs = r2.datasets.find((d) => d.dataset === 'gsc_page_query_daily')!;
    expect(pageDs.rowsRetired).toBe(1);
    expect(totalsDs.rowsRetired).toBe(1);
    expect(pqDs.rowsRetired).toBe(1);
    // Current views now match what Google reports: no stale rows are added to fresh ones.
    expect(sumClicks('gsc_page_daily_current', "AND date = '2026-09-22'")).toBe(3);
    expect(sumClicks('gsc_property_daily_current')).toBe(7);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM gsc_page_query_daily_current WHERE site_id = ? AND query = 'gadgets'", [ctx.siteId])).toBe(0);
    // Retired rows are kept (not deleted, not zeroed) and point at the batch that retired them.
    const retired = ctx.db.get<{ clicks: number; is_current: number; superseded_by_batch_id: string }>(
      "SELECT clicks, is_current, superseded_by_batch_id FROM gsc_page_daily WHERE site_id = ? AND page = ? AND date = '2026-09-22'",
      [ctx.siteId, PAGE_B],
    )!;
    expect(retired).toMatchObject({ clicks: 1, is_current: 0, superseded_by_batch_id: pageDs.batchId });
    expect(ctx.db.get('SELECT rows_retired FROM ingestion_batches WHERE id = ?', [pageDs.batchId])).toEqual({ rows_retired: 1 });
    expect(JSON.parse(ctx.db.get<{ c: string }>('SELECT coverage_json AS c FROM ingestion_batches WHERE id = ?', [pageDs.batchId])!.c).retirement).toMatchObject({ retiredRows: 1, retirementSkippedBecause: [] });
    expect(r2.warnings.join('\n')).toMatch(/no longer reported by Google; they were retired/);

    // Re-running with the same data retires nothing more.
    const r3 = await syncGsc(ctx, opts);
    expect(r3.datasets.every((d) => d.rowsRetired === 0 && d.rowsNewRevision === 0)).toBe(true);

    // The page row comes back: a new revision after the retired one.
    drop.page = false;
    await syncGsc(ctx, opts);
    expect(ctx.db.all<{ revision: number; is_current: number }>("SELECT revision, is_current FROM gsc_page_daily WHERE site_id = ? AND page = ? AND date = '2026-09-22' ORDER BY revision", [ctx.siteId, PAGE_B])).toEqual([
      { revision: 1, is_current: 0 },
      { revision: 2, is_current: 1 },
    ]);
    expect(sumClicks('gsc_page_daily_current', "AND date = '2026-09-22'")).toBe(4);
  });

  it('keeps absent rows current when the re-sync response was truncated (absence proves nothing)', async () => {
    ctx = googleTestContext({ now: NOW });
    const drop = { page: false };
    const state = { totals: TOTALS.map((d) => ({ ...d })), firstIncomplete: '2026-09-22' as string | null, pageRows: (date: string) => pageRows(date).filter((r) => !(drop.page && r.keys[1] === PAGE_B)) };
    await syncGsc(ctx, { provider: providerFor(new ScriptedClient(gscHandler(state))), days: 5, retry: FAST_RETRY, includePageQuery: false });
    const before = count(ctx, 'SELECT COUNT(*) AS n FROM gsc_page_daily_current WHERE site_id = ?', [ctx.siteId]);
    drop.page = true;
    // One row per page and a one-page guard: every request stops while rows remain.
    const r = await syncGsc(ctx, { provider: providerFor(new ScriptedClient(gscHandler(state))), days: 5, retry: FAST_RETRY, includePageQuery: false, rowLimit: 1, maxPagesPerQuery: 1 });
    expect(r.status).toBe('partial');
    const pageDs = r.datasets.find((d) => d.dataset === 'gsc_page_daily')!;
    expect(pageDs.rowsRetired).toBe(0);
    expect(pageDs.rowsStaleRetained).toBeGreaterThan(0);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM gsc_page_daily_current WHERE site_id = ?', [ctx.siteId])).toBe(before);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM gsc_property_daily_current WHERE site_id = ?', [ctx.siteId])).toBe(4);
    const cov = JSON.parse(ctx.db.get<{ c: string }>('SELECT coverage_json AS c FROM ingestion_batches WHERE id = ?', [pageDs.batchId])!.c);
    expect(cov.retirement.retirementSkippedBecause).toContain('pagination stopped at the page guard');
    expect(r.warnings.join('\n')).toMatch(/not returned by an incomplete request; they stay current/);
  });

  it('retries a short-term rate limit but not an exhausted quota', async () => {
    ctx = googleTestContext({ now: NOW });
    const inner = gscHandler({ totals: TOTALS, firstIncomplete: '2026-09-22' });
    let shortTerm = 0;
    const client = new ScriptedClient((req) => {
      if (req.path.endsWith('/searchAnalytics/query') && shortTerm < 2) {
        shortTerm++;
        return { status: 403, body: { error: { code: 403, message: 'User Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } } };
      }
      return inner(req);
    });
    const r = await syncGsc(ctx, { provider: providerFor(client), days: 2, retry: FAST_RETRY, includePageQuery: false, pacingMs: 0 });
    expect(r.status).toBe('succeeded');
    expect(shortTerm).toBe(2);
  });

  it('backfills page totals and page/query history left incomplete by a quota stop, and stays partial until then', async () => {
    ctx = googleTestContext({ now: NOW });
    const totals: Day[] = [];
    for (let i = 0; i < 90; i++) {
      const d = new Date(Date.parse('2026-06-26T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10);
      totals.push({ date: d, clicks: 1, impressions: 10 });
    }
    const inner = gscHandler({
      totals,
      firstIncomplete: '2026-09-22',
      pageRows: (date) => [{ keys: [date, PAGE_A], clicks: 1, impressions: 9, ctr: 0.11, position: 3 }],
      queryRows: (page) => [{ keys: ['2026-06-26', page, 'widgets'], clicks: 1, impressions: 4, ctr: 0.25, position: 2 }],
    });
    const quota = { exhausted: true, pageRequests: 0 };
    const client = new ScriptedClient((req) => {
      const dims: string[] = req.body?.dimensions ?? [];
      if (req.method === 'POST' && dims.join() === 'date,page') {
        quota.pageRequests++;
        // Two chunks (2 requests each: rows, then an empty page) succeed; the third chunk hits the load quota.
        if (quota.exhausted && quota.pageRequests > 4) return { status: 403, body: { error: { code: 403, message: 'Search Analytics load quota exceeded.', errors: [{ reason: 'quotaExceeded' }] } } };
      }
      return inner(req);
    });
    const opts = { provider: providerFor(client), retry: FAST_RETRY, pageChunkDays: 10, topPages: 1, pacingMs: 0 };
    const r1 = await syncGsc(ctx, opts);
    expect(r1.ranges[0]).toMatchObject({ mode: 'initial', start: '2026-06-26', end: '2026-09-23' });
    expect(r1.status).toBe('partial');
    const pages1 = r1.datasets.find((d) => d.dataset === 'gsc_page_daily')!;
    expect(pages1.status).toBe('partial');
    const cov1 = JSON.parse(ctx.db.get<{ c: string }>('SELECT coverage_json AS c FROM ingestion_batches WHERE id = ?', [pages1.batchId])!.c);
    expect(cov1).toMatchObject({ interrupted: true, collectedRanges: [{ start: '2026-06-26', end: '2026-07-05' }, { start: '2026-07-06', end: '2026-07-15' }] });
    // Coverage: the collected chunks are final, the rest of the window is missing (not zero).
    const pageCov = gscCoverage(ctx.db, ctx.siteId, { dataset: 'gsc_page_daily', property: SYNTHETIC_PROPERTY, searchType: 'web', start: '2026-06-26', end: '2026-09-23' });
    expect(pageCov.missing[0]).toBe('2026-07-16');
    expect(pageCov.missing).toHaveLength(70);
    expect(pageCov.byDate['2026-07-10']!.state).toBe('final');
    expect(r1.gaps!.map((g) => [g.dataset, g.firstDate])).toEqual([
      ['gsc_page_daily', '2026-07-16'],
      ['gsc_page_query_daily', '2026-06-26'],
    ]);

    // The quota refreshes. The incremental sync refreshes recent property totals only, but re-requests the missing history per dataset.
    quota.exhausted = false;
    const before = client.calls.length;
    const r2 = await syncGsc(ctx, opts);
    expect(r2.ranges[0]!.mode).toBe('incremental');
    expect(r2.ranges[0]!.datasets!.map((d) => [d.dataset, d.start, d.backfillFrom])).toEqual([
      ['gsc_property_daily', '2026-09-14', null],
      ['gsc_page_daily', '2026-07-16', '2026-07-16'],
      ['gsc_page_query_daily', '2026-06-26', '2026-06-26'],
    ]);
    const calls = client.calls.slice(before).filter((c) => c.method === 'POST');
    const firstStart = (dims: string) => calls.filter((c) => c.body.dimensions.join() === dims).map((c) => c.body.startDate).sort()[0];
    expect(firstStart('date')).toBe('2026-09-14');
    expect(firstStart('date,page')).toBe('2026-07-16');
    expect(firstStart('date,page,query')).toBe('2026-06-26');
    expect(r2.warnings.join('\n')).toMatch(/Backfill: gsc_page_daily \(web\) is re-requested from 2026-07-16/);
    expect(r2.gaps).toBeUndefined();
    expect(r2.status).toBe('succeeded');
    expect(gscCoverage(ctx.db, ctx.siteId, { dataset: 'gsc_page_daily', property: SYNTHETIC_PROPERTY, searchType: 'web', start: '2026-06-26', end: '2026-09-23' }).missing).toEqual([]);

    // Once complete, later syncs are plain incremental refreshes again.
    const r3 = await syncGsc(ctx, opts);
    expect(r3.ranges[0]!.datasets!.every((d) => d.start === '2026-09-14' && d.backfillFrom === null)).toBe(true);
    expect(r3.status).toBe('succeeded');
  });
});

describe('page/query rows of pages that leave the top N (B3-03)', () => {
  // SYNTHETIC Search Console: every date up to yesterday (Pacific) has data; the last 3 days are
  // incomplete. The "leader" page has the most clicks; page/query detail answers only the requested dates.
  const PAGE_C = 'https://www.example.test/c';
  const PAGES = [PAGE_A, PAGE_B, PAGE_C];
  const addDay = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const datesBetween = (s: string, e: string) => {
    const out: string[] = [];
    for (let d = s; d <= e; d = addDay(d, 1)) out.push(d);
    return out;
  };

  function scenario(state: { today: string; leader: string }) {
    return (req: { method: string; path: string; body: any }): ScriptedReply => {
      if (req.method === 'GET') return sitesList([[SYNTHETIC_PROPERTY, 'siteFullUser']]);
      const b = req.body;
      const dims: string[] = b.dimensions ?? [];
      const last = b.endDate < addDay(state.today, -1) ? b.endDate : addDay(state.today, -1);
      const dates = datesBetween(b.startDate, last);
      let rows: unknown[] = [];
      if (dims.join() === 'date') rows = dates.map((d) => ({ keys: [d], clicks: 12, impressions: 120, ctr: 0.1, position: 4 }));
      else if (dims.join() === 'date,page') rows = dates.flatMap((d) => PAGES.map((p) => ({ keys: [d, p], clicks: p === state.leader ? 10 : 1, impressions: 50, ctr: 0.1, position: 5 })));
      else if (dims.join() === 'date,page,query') {
        const page = b.dimensionFilterGroups[0].filters[0].expression as string;
        rows = dates.map((d) => ({ keys: [d, page, `query-${page.slice(-1)}`], clicks: 1, impressions: 10, ctr: 0.1, position: 3 }));
      }
      const start = b.startRow ?? 0;
      const page = rows.slice(start, start + (b.rowLimit ?? 25000));
      return { body: { ...(page.length ? { rows: page } : {}), responseAggregationType: dims.includes('page') ? 'byPage' : 'byProperty', metadata: { first_incomplete_date: addDay(state.today, -3) } } };
    };
  }

  /** Current page/query rows still not final for dates the source already reports as final. */
  const staleRows = (today: string, page?: string) =>
    ctx.db.all<{ page: string; date: string }>(
      `SELECT page, date FROM gsc_page_query_daily WHERE site_id = ? AND is_current = 1 AND is_final = 0 AND date < ?${page ? ' AND page = ?' : ''} ORDER BY page, date`,
      page ? [ctx.siteId, addDay(today, -3), page] : [ctx.siteId, addDay(today, -3)],
    );

  async function syncAt(state: { today: string; leader: string }, client: ScriptedClient, topPages: number) {
    ctx.clock.set(`${state.today}T12:00:00.000Z`);
    return syncGsc(ctx, { provider: providerFor(client), retry: FAST_RETRY, pacingMs: 0, pageChunkDays: 30, topPages });
  }

  it('settles the not-final rows of a page that drops out of the top N, and it comes back cleanly', async () => {
    ctx = googleTestContext({ now: '2026-09-24T12:00:00.000Z' });
    const state = { today: '2026-09-24', leader: PAGE_A };
    const client = new ScriptedClient(scenario(state));
    const r1 = await syncAt(state, client, 1);
    expect(r1.status).toBe('succeeded');
    // A is the top page: its rows for 2026-09-21..23 are not final yet (first incomplete date 2026-09-21).
    expect(ctx.db.all<{ date: string }>("SELECT date FROM gsc_page_query_daily_current WHERE site_id = ? AND page = ? AND is_final = 0 ORDER BY date", [ctx.siteId, PAGE_A]).map((r) => r.date)).toEqual(['2026-09-21', '2026-09-22', '2026-09-23']);

    // A week later B leads: A leaves the top 1, but its not-final rows are re-requested for exactly those dates.
    state.today = '2026-10-01';
    state.leader = PAGE_B;
    const before = client.calls.length;
    const r2 = await syncAt(state, client, 1);
    const pqCalls = client.calls.slice(before).filter((c) => c.body?.dimensions?.join() === 'date,page,query');
    const aCall = pqCalls.find((c) => c.body.dimensionFilterGroups[0].filters[0].expression === PAGE_A)!;
    expect(aCall.body).toMatchObject({ startDate: '2026-09-21', endDate: '2026-09-23' });
    expect(staleRows(state.today)).toEqual([]);
    expect(ctx.db.all<{ is_final: number }>("SELECT is_final FROM gsc_page_query_daily_current WHERE site_id = ? AND page = ? AND date BETWEEN '2026-09-21' AND '2026-09-23'", [ctx.siteId, PAGE_A]).map((r) => r.is_final)).toEqual([1, 1, 1]);
    const pq2 = r2.datasets.find((d) => d.dataset === 'gsc_page_query_daily')!;
    expect(pq2.notFinalRows).toBeUndefined();
    expect(r2.warnings.join('\n')).toMatch(/1 page\(s\) outside the top 1 were re-requested/);
    expect(r2.status).toBe('succeeded');
    const cov = JSON.parse(ctx.db.get<{ c: string }>('SELECT coverage_json AS c FROM ingestion_batches WHERE id = ?', [pq2.batchId])!.c);
    expect(cov.pages.find((p: { page: string }) => p.page === PAGE_A)).toMatchObject({ reason: 'settle_not_final', requested: { start: '2026-09-21', end: '2026-09-23' } });

    // B stays on top, then A comes back after the refresh window has moved on.
    state.today = '2026-10-08';
    const r3 = await syncAt(state, client, 1);
    expect(r3.status).toBe('succeeded');
    state.today = '2026-10-15';
    state.leader = PAGE_A;
    const r4 = await syncAt(state, client, 1);
    expect(r4.status).toBe('succeeded');
    expect(staleRows(state.today)).toEqual([]);
    // Queries of A on 2026-09-21..23 are final observations (not "incomplete"): one current, final row per date.
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM gsc_page_query_daily_current WHERE site_id = ? AND page = ? AND date BETWEEN '2026-09-21' AND '2026-09-23' AND is_final = 1", [ctx.siteId, PAGE_A])!.n).toBe(3);
    expect([r1, r2, r3, r4].flatMap((r) => r.warnings).join('\n')).not.toMatch(/still stored as not final/);
  });

  it('warns and stays partial when not-final rows exceed the re-request limit; a page that comes back later is requested from its earliest not-final date', async () => {
    ctx = googleTestContext({ now: '2026-09-24T12:00:00.000Z' });
    const state = { today: '2026-09-24', leader: PAGE_A };
    const client = new ScriptedClient(scenario(state));
    // Two top pages get page/query detail first (A leads, the others tie; B sorts before C).
    await syncAt(state, client, 2);
    expect(new Set(ctx.db.all<{ page: string }>('SELECT DISTINCT page FROM gsc_page_query_daily WHERE site_id = ?', [ctx.siteId]).map((r) => r.page))).toEqual(new Set([PAGE_A, PAGE_B]));

    // C leads and only 1 page is detailed: A and B both left the top N, but only 1 page is re-requested per sync.
    state.today = '2026-10-01';
    state.leader = PAGE_C;
    const r2 = await syncAt(state, client, 1);
    const pq2 = r2.datasets.find((d) => d.dataset === 'gsc_page_query_daily')!;
    expect(pq2.notFinalRows).toEqual({ pages: 1, rows: 3, firstDate: '2026-09-21', lastDate: '2026-09-23' });
    expect(staleRows(state.today).map((r) => r.page)).toEqual([PAGE_B, PAGE_B, PAGE_B]);
    expect(r2.status).toBe('partial');
    expect(r2.warnings.join('\n')).toMatch(/3 page\/query row\(s\) on 1 page\(s\) between 2026-09-21 and 2026-09-23 are still stored as not final/);

    // B comes back on top after the refresh window moved past 2026-09-23: it is requested from 2026-09-21.
    state.today = '2026-10-08';
    state.leader = PAGE_B;
    const before = client.calls.length;
    const r3 = await syncAt(state, client, 1);
    const bCall = client.calls.slice(before).find((c) => c.body?.dimensions?.join() === 'date,page,query' && c.body.dimensionFilterGroups[0].filters[0].expression === PAGE_B)!;
    expect(r3.ranges[0]!.datasets!.find((d) => d.dataset === 'gsc_page_query_daily')!.start).toBe('2026-09-28');
    expect(bCall.body).toMatchObject({ startDate: '2026-09-21', endDate: '2026-10-07' });
    expect(staleRows(state.today)).toEqual([]);
    expect(r3.datasets.find((d) => d.dataset === 'gsc_page_query_daily')!.notFinalRows).toBeUndefined();
    expect(r3.status).toBe('succeeded');
  });
});
