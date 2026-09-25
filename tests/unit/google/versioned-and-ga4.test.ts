import { afterEach, describe, expect, it } from 'vitest';
import { upsertRevision, startBatch, finishBatch, emptyCounts, tally, retireUnreturned, revisionKey, settleScope } from '../../../src/integrations/google/versioned.js';
import { decideRateScale } from '../../../src/integrations/google/ga4-sync.js';
import { ga4DateToIso, ga4PropertyName, parseReportRows, quotaLow, summarizeMetadata } from '../../../src/integrations/google/ga4-client.js';
import { compactMetadata, integerConsistencyScale, planGa4Metrics } from '../../../src/integrations/google/ga4-metadata.js';
import { ga4ConversionChecklist } from '../../../src/integrations/google/ga4-checklist.js';
import { evalGa4Filter } from '../../../src/integrations/google/fixture-provider.js';
import { CHANNEL_VIEWS } from '../../../src/integrations/google/ga4-sync.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { googleConfig } from '../../integration/google/_helpers.js';

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

describe('versioned upsert', () => {
  it('inserts, skips unchanged, revises changed, and keeps one current row', () => {
    ctx = createTestContext();
    const batch = startBatch(ctx, { source: 'gsc', dataset: 'gsc_property_daily', property: 'sc-domain:example.test', dateStart: '2026-09-01', dateEnd: '2026-09-01', request: {}, transformationVersion: 't@1', synthetic: true });
    const meta = { batchId: batch, collectedAt: '2026-09-24T00:00:00Z', transformationVersion: 't@1', isSynthetic: true };
    const key = { property: 'sc-domain:example.test', search_type: 'web', date: '2026-09-01' };
    const vals = (clicks: number) => ({ date_tz: 'America/Los_Angeles', clicks, impressions: 10, ctr: clicks / 10, position: 3, aggregation_type: 'byProperty', is_final: 1 });
    const counts = emptyCounts();
    const run = (c: number) => ctx.db.transaction(() => upsertRevision(ctx.db, 'gsc_property_daily', ctx.siteId, key, vals(c), meta));
    tally(counts, run(1));
    tally(counts, run(1));
    tally(counts, run(2));
    tally(counts, run(2));
    expect(counts).toEqual({ received: 4, newRevisions: 2, unchanged: 2, revised: 1, retired: 0, staleRetained: 0 });
    const rows = ctx.db.all<{ revision: number; is_current: number; clicks: number }>('SELECT revision, is_current, clicks FROM gsc_property_daily ORDER BY revision');
    expect(rows).toEqual([
      { revision: 1, is_current: 0, clicks: 1 },
      { revision: 2, is_current: 1, clicks: 2 },
    ]);
    finishBatch(ctx, batch, { status: 'succeeded', counts, apiPages: 1, truncated: false, coverage: { note: 'x' } });
    expect(ctx.db.get('SELECT status, rows_received, rows_new_revision, rows_unchanged FROM ingestion_batches WHERE id = ?', [batch])).toEqual({ status: 'succeeded', rows_received: 4, rows_new_revision: 2, rows_unchanged: 2 });
  });

  it('a changed synthetic label is a new revision, never "unchanged"; the row hash formula is unchanged (D1-R01)', () => {
    ctx = createTestContext();
    const batch = startBatch(ctx, { source: 'import', dataset: 'gsc_property_daily', property: 'sc-domain:example.test', dateStart: '2026-09-01', dateEnd: '2026-09-01', request: {}, transformationVersion: 't@1', synthetic: false });
    const meta = (isSynthetic: boolean) => ({ batchId: batch, collectedAt: '2026-09-24T00:00:00Z', transformationVersion: 't@1', isSynthetic });
    const key = { property: 'sc-domain:example.test', search_type: 'web', date: '2026-09-01' };
    const vals = { date_tz: 'America/Los_Angeles', clicks: 1, impressions: 10, ctr: 0.1, position: 3, aggregation_type: 'byProperty', is_final: 1 };
    const run = (synthetic: boolean) => ctx.db.transaction(() => upsertRevision(ctx.db, 'gsc_property_daily', ctx.siteId, key, vals, meta(synthetic)));
    expect([run(true), run(true), run(false), run(false), run(true)]).toEqual(['new', 'unchanged', 'revised', 'unchanged', 'revised']);
    const rows = ctx.db.all<{ revision: number; is_current: number; is_synthetic: number; row_hash: string }>('SELECT revision, is_current, is_synthetic, row_hash FROM gsc_property_daily ORDER BY revision');
    expect(rows.map((r) => [r.revision, r.is_current, r.is_synthetic])).toEqual([
      [1, 0, 1],
      [2, 0, 0],
      [3, 1, 1],
    ]);
    // The label is compared separately: every revision of the same key and values has the same row hash as before this rule.
    expect(new Set(rows.map((r) => r.row_hash)).size).toBe(1);
  });

  it('retires only unreturned keys inside the exact scope, records the retiring batch, and revives a returning key', () => {
    ctx = createTestContext();
    const b1 = startBatch(ctx, { source: 'gsc', dataset: 'gsc_page_daily', property: 'sc-domain:example.test', dateStart: '2026-09-01', dateEnd: '2026-09-02', request: {}, transformationVersion: 't@1', synthetic: true });
    const meta = (batchId: string) => ({ batchId, collectedAt: '2026-09-24T00:00:00Z', transformationVersion: 't@1', isSynthetic: true });
    const key = (date: string, page: string, segment_key = '') => ({ property: 'sc-domain:example.test', search_type: 'web', date, page, segment_key });
    const vals = (clicks: number) => ({ date_tz: 'America/Los_Angeles', clicks, impressions: 10, ctr: null, position: null, aggregation_type: 'byPage', is_final: 1 });
    ctx.db.transaction(() => {
      for (const k of [key('2026-09-01', '/a'), key('2026-09-01', '/b'), key('2026-09-02', '/b'), key('2026-09-01', '/b', 'device=MOBILE'), key('2026-09-03', '/b')]) upsertRevision(ctx.db, 'gsc_page_daily', ctx.siteId, k, vals(1), meta(b1));
    });
    const b2 = startBatch(ctx, { source: 'gsc', dataset: 'gsc_page_daily', property: 'sc-domain:example.test', dateStart: '2026-09-01', dateEnd: '2026-09-02', request: {}, transformationVersion: 't@1', synthetic: true });
    const returned = new Set([revisionKey('gsc_page_daily', key('2026-09-01', '/a')), revisionKey('gsc_page_daily', key('2026-09-02', '/b'))]);
    const scope = { equals: { property: 'sc-domain:example.test', search_type: 'web', segment_key: '' }, range: { column: 'date', start: '2026-09-01', end: '2026-09-02' } };
    // Dry count first (incomplete response): nothing changes.
    const counts = emptyCounts();
    ctx.db.transaction(() => settleScope(ctx.db, 'gsc_page_daily', ctx.siteId, scope, returned, b2, ['subjectToThresholding'], counts));
    expect(counts).toMatchObject({ retired: 0, staleRetained: 1 });
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM gsc_page_daily_current')!.n).toBe(5);
    // Complete response: only /b on 2026-09-01 (segment '' , inside the date range) is retired.
    expect(ctx.db.transaction(() => retireUnreturned(ctx.db, 'gsc_page_daily', ctx.siteId, scope, returned, b2, true))).toBe(1);
    const retired = ctx.db.all<{ date: string; page: string; segment_key: string; superseded_by_batch_id: string }>('SELECT date, page, segment_key, superseded_by_batch_id FROM gsc_page_daily WHERE is_current = 0');
    expect(retired).toEqual([{ date: '2026-09-01', page: '/b', segment_key: '', superseded_by_batch_id: b2 }]);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM gsc_page_daily_current')!.n).toBe(4);
    // The key comes back later: a new revision after the retired one (no UNIQUE clash), counted as revised.
    const b3 = startBatch(ctx, { source: 'gsc', dataset: 'gsc_page_daily', property: 'sc-domain:example.test', dateStart: '2026-09-01', dateEnd: '2026-09-01', request: {}, transformationVersion: 't@1', synthetic: true });
    expect(ctx.db.transaction(() => upsertRevision(ctx.db, 'gsc_page_daily', ctx.siteId, key('2026-09-01', '/b'), vals(1), meta(b3)))).toBe('revised');
    expect(ctx.db.all<{ revision: number; is_current: number }>("SELECT revision, is_current FROM gsc_page_daily WHERE page = '/b' AND date = '2026-09-01' AND segment_key = '' ORDER BY revision")).toEqual([
      { revision: 1, is_current: 0 },
      { revision: 2, is_current: 1 },
    ]);
    // A revision supersedes the old row with the new batch as well.
    expect(ctx.db.transaction(() => upsertRevision(ctx.db, 'gsc_page_daily', ctx.siteId, key('2026-09-01', '/a'), vals(9), meta(b3)))).toBe('revised');
    expect(ctx.db.get("SELECT superseded_by_batch_id AS s FROM gsc_page_daily WHERE page = '/a' AND revision = 1")).toEqual({ s: b3 });
    finishBatch(ctx, b2, { status: 'succeeded', counts: { ...emptyCounts(), retired: 1 }, apiPages: 1, truncated: false });
    expect(ctx.db.get('SELECT rows_retired FROM ingestion_batches WHERE id = ?', [b2])).toEqual({ rows_retired: 1 });
  });

  it('decides the key-event rate scale from every value and a stored finding', () => {
    expect(decideRateScale(null, [0.1, 0.5])).toMatchObject({ detected: 'undetermined', normalized: false, source: 'none', maxObserved: 0.5 });
    expect(decideRateScale(null, [0.4, 12.5])).toMatchObject({ detected: 'percent_0_100', normalized: true, source: 'this_sync', maxObserved: 12.5 });
    // A later sync where every value is <= 1 keeps the proven 0-100 scale.
    expect(decideRateScale({ scale: 'percent_0_100', maxObserved: 12.5, detectedAt: '2026-09-20T00:00:00Z' }, [0.4])).toMatchObject({ detected: 'percent_0_100', normalized: true, source: 'stored', maxObserved: 12.5 });
    expect(decideRateScale({ scale: 'undetermined', maxObserved: 0.9, detectedAt: null }, [])).toMatchObject({ detected: 'undetermined', maxObserved: 0.9 });
  });

  it('uses a recorded confirmation when values do not decide the scale, but a value above 1 always wins (B3-01)', () => {
    const conf = (scale: 'fraction' | 'percent') => ({ id: 'ga4rs_1', scale, basis: 'owner_assertion' as const, confirmedAt: '2026-09-20T00:00:00Z', actor: 'owner' });
    expect(decideRateScale(null, [0.1, 0.5], conf('fraction'))).toMatchObject({ detected: 'fraction_0_1', normalized: false, source: 'confirmed', confirmation: { id: 'ga4rs_1' } });
    expect(decideRateScale(null, [0.1, 0.5], conf('percent'))).toMatchObject({ detected: 'percent_0_100', normalized: true, source: 'confirmed' });
    const contradicted = decideRateScale(null, [0.4, 12.5], conf('fraction'));
    expect(contradicted).toMatchObject({ detected: 'percent_0_100', source: 'this_sync' });
    expect(contradicted.contradiction).toMatch(/recorded 0-1 confirmation \(owner, 2026-09-20T00:00:00Z\) is contradicted/);
    expect(decideRateScale({ scale: 'percent_0_100', maxObserved: 12.5, detectedAt: null }, [0.4], conf('fraction'))).toMatchObject({ detected: 'percent_0_100', source: 'stored' });
  });

  it('proves 0-1 only from integer-consistent small rows, never from values alone (B3-01)', () => {
    // 1 of 25, 2 of 40, 3 of 12 ... converting sessions: whole numbers on a 0-1 scale; fractions of one session on 0-100.
    const rows = [
      { sessions: 25, rate: 0.04 },
      { sessions: 40, rate: 0.05 },
      { sessions: 12, rate: 0.25 },
      { sessions: 7, rate: 1 / 7 },
      { sessions: 99, rate: 0.030303 },
      { sessions: 18, rate: 0 }, // says nothing about the scale
      { sessions: 400, rate: 0.0125 }, // too many sessions to decide
    ];
    expect(integerConsistencyScale(rows)).toMatchObject({ decided: 'fraction', consistentRows: 5, inconsistentRows: 0 });
    // One small row that is not a whole number of converting sessions: nothing is decided.
    expect(integerConsistencyScale([...rows, { sessions: 10, rate: 0.037 }])).toMatchObject({ decided: null, inconsistentRows: 1 });
    // Too few rows to decide.
    expect(integerConsistencyScale(rows.slice(0, 4))).toMatchObject({ decided: null, consistentRows: 4 });
    // A value above 1 proves 0-100 elsewhere: this check does not decide.
    expect(integerConsistencyScale([...rows, { sessions: 50, rate: 2 }]).decided).toBeNull();
    // Values that are not converting-session ratios on most rows (rate x sessions far from whole numbers): never "proven".
    expect(integerConsistencyScale([{ sessions: 30, rate: 0.5 }, { sessions: 20, rate: 0.9 }, { sessions: 45, rate: 0.7 }, { sessions: 11, rate: 0.3 }, { sessions: 60, rate: 0.21 }])).toMatchObject({ decided: null, inconsistentRows: 3 });
  });

  it('rejects unknown column identifiers', () => {
    ctx = createTestContext();
    expect(() => upsertRevision(ctx.db, 'gsc_property_daily', ctx.siteId, { property: 'p', search_type: 'web', date: '2026-09-01' }, { 'clicks; DROP TABLE x': 1 }, { batchId: 'b', collectedAt: 'x', transformationVersion: 't', isSynthetic: true })).toThrow(/Invalid column/);
  });
});

describe('GA4 client helpers', () => {
  it('parses rows by header type and keeps (not set)', () => {
    const rows = parseReportRows({
      dimensionHeaders: [{ name: 'date' }, { name: 'landingPagePlusQueryString' }],
      metricHeaders: [{ name: 'sessions', type: 'TYPE_INTEGER' }, { name: 'sessionKeyEventRate:generate_lead', type: 'TYPE_FLOAT' }, { name: 'totalRevenue', type: 'TYPE_CURRENCY' }],
      rows: [{ dimensionValues: [{ value: '20260920' }, { value: '(not set)' }], metricValues: [{ value: '12' }, { value: '0.083333' }, { value: '' }] }],
    });
    expect(rows).toEqual([{ dims: { date: '20260920', landingPagePlusQueryString: '(not set)' }, metrics: { sessions: 12, 'sessionKeyEventRate:generate_lead': 0.083333, totalRevenue: null } }]);
    expect(ga4DateToIso('20260920')).toBe('2026-09-20');
    expect(ga4DateToIso('2026-09-20')).toBeNull();
  });

  it('validates numeric property IDs', () => {
    expect(ga4PropertyName('123456789')).toBe('properties/123456789');
    expect(() => ga4PropertyName('G-ABC123')).toThrow(/measurement ID/);
    expect(() => ga4PropertyName('UA-1234-1')).toThrow(/Universal Analytics/);
  });

  it('summarizes sampling/thresholding metadata and quota reserve', () => {
    const s = summarizeMetadata([{ subjectToThresholding: true, samplingMetadatas: [{ samplesReadCount: '250', samplingSpaceSize: '1000' }], timeZone: 'America/New_York', currencyCode: 'USD' }]);
    expect(s).toMatchObject({ subjectToThresholding: true, samplingRatio: [0.25], timeZone: 'America/New_York', dataLossFromOtherRow: false });
    expect(quotaLow({ tokensPerHour: { remaining: 100 } }, { tokensPerHour: 500, tokensPerDay: 1000 })).toMatch(/tokensPerHour/);
    expect(quotaLow({ tokensPerHour: { remaining: 10_000 }, tokensPerDay: { remaining: 50_000 } }, { tokensPerHour: 500, tokensPerDay: 1000 })).toBeNull();
    expect(quotaLow(null, { tokensPerHour: 500, tokensPerDay: 1000 })).toBeNull();
  });

  it('channel views use session-scoped dimensions only', () => {
    const fields = JSON.stringify(CHANNEL_VIEWS);
    expect(fields).toMatch(/sessionSource/);
    expect(fields).toMatch(/sessionDefaultChannelGroup/);
    expect(fields).not.toMatch(/"fieldName":"(source|medium|defaultChannelGroup)"/);
    const google = { sessionSource: 'google', sessionMedium: 'organic', sessionDefaultChannelGroup: 'Organic Search' };
    const bing = { sessionSource: 'bing', sessionMedium: 'organic', sessionDefaultChannelGroup: 'Organic Search' };
    expect(evalGa4Filter(CHANNEL_VIEWS.google_organic.filter, google)).toBe(true);
    expect(evalGa4Filter(CHANNEL_VIEWS.google_organic.filter, bing)).toBe(false);
    expect(evalGa4Filter(CHANNEL_VIEWS.all_organic.filter, bing)).toBe(true);
  });
});

describe('GA4 metric planning', () => {
  const meta = (names: string[], blocked: string[] = []) => compactMetadata({ dimensions: [{ apiName: 'eventName' }, { apiName: 'date' }], metrics: names.map((apiName) => ({ apiName, ...(blocked.includes(apiName) ? { blockedReasons: ['NO_REVENUE_METRICS'] } : {}) })) });
  const events = { primary: ['generate_lead'], secondary: ['sign_up'] };

  it('uses the event-specific session rate only when metadata lists it', () => {
    const p = planGa4Metrics(meta(['sessions', 'engagedSessions', 'keyEvents', 'sessionKeyEventRate', 'sessionKeyEventRate:generate_lead', 'userKeyEventRate:generate_lead', 'keyEvents:generate_lead', 'totalRevenue']), events);
    expect(p).toMatchObject({ primaryRateMetric: 'sessionKeyEventRate:generate_lead', primaryUserRateMetric: 'userKeyEventRate:generate_lead', primaryKeyEventsMetric: 'keyEvents:generate_lead', revenueMetric: 'totalRevenue', limitations: [] });
    expect(p.keyEventListed).toEqual({ generate_lead: true, sign_up: false });
  });

  it('never substitutes the any-key-event rate when the primary rate is missing', () => {
    const p = planGa4Metrics(meta(['sessions', 'engagedSessions', 'keyEvents', 'sessionKeyEventRate', 'totalRevenue'], ['totalRevenue']), events);
    expect(p.primaryRateMetric).toBeNull();
    expect(p.primaryKeyEventsMetric).toBeNull();
    expect(p.primaryKeyEventsAlternative).toBeNull();
    expect(p.revenueMetric).toBeNull();
    expect(p.limitations.map((l) => l.metric)).toEqual(expect.arrayContaining(['sessionKeyEventRate:generate_lead', 'keyEvents:generate_lead', 'totalRevenue']));
    expect(p.limitations.find((l) => l.metric === 'sessionKeyEventRate:generate_lead')!.reason).toMatch(/NOT used in its place/);
  });

  it('labels the keyEvents+eventName alternative and honours incompatibility', () => {
    const p = planGa4Metrics(meta(['sessions', 'engagedSessions', 'keyEvents', 'sessionKeyEventRate:generate_lead', 'purchaseRevenue']), events, new Set(['sessionKeyEventRate:generate_lead']));
    expect(p.primaryKeyEventsAlternative).toMatch(/keyEvents filtered by eventName/);
    expect(p.primaryRateMetric).toBeNull();
    expect(p.revenueMetric).toBe('purchaseRevenue');
  });

  it('reports extra primary events as not used for conversion rates (B3-04)', () => {
    const p = planGa4Metrics(meta(['sessions', 'engagedSessions', 'keyEvents', 'sessionKeyEventRate:generate_lead', 'sessionKeyEventRate:purchase', 'userKeyEventRate:generate_lead', 'keyEvents:generate_lead', 'totalRevenue']), { primary: ['generate_lead', 'purchase'], secondary: [] });
    expect(p.primaryEvent).toBe('generate_lead');
    expect(p.primaryRateMetric).toBe('sessionKeyEventRate:generate_lead');
    const l = p.limitations.find((x) => x.metric === 'sessionKeyEventRate:purchase')!;
    expect(l.reason).toMatch(/^primary event\(s\) "purchase" are not used for conversion rates: only the first configured primary event "generate_lead"/);
    // A single primary event has no such limitation.
    expect(planGa4Metrics(meta(['sessions', 'engagedSessions', 'keyEvents', 'sessionKeyEventRate:generate_lead', 'userKeyEventRate:generate_lead', 'keyEvents:generate_lead', 'totalRevenue']), events).limitations).toEqual([]);
  });

  it('reports the missing primary event configuration', () => {
    const p = planGa4Metrics(meta(['sessions']), { primary: [], secondary: [] });
    expect(p.limitations.map((l) => l.metric)).toContain('sessionKeyEventRate:<primary event>');
    expect(p.limitations.map((l) => l.metric)).toEqual(expect.arrayContaining(['engagedSessions', 'keyEvents']));
  });
});

describe('conversion verification checklist', () => {
  it('is a manual checklist that never fabricates conversions', () => {
    const text = ga4ConversionChecklist(googleConfig());
    expect(text).toMatch(/Primary event "generate_lead"/);
    expect(text).toMatch(/never submits forms, creates test leads or purchases/);
    expect(text).toMatch(/DebugView/);
    expect(text).toMatch(/system of record/);
    expect(ga4ConversionChecklist(googleConfig({ conversions: { primaryEvents: [] } }))).toMatch(/Configure the primary conversion event/);
  });
});
