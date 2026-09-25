import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { ga4WindowMetrics, gscWindowMetrics, latestCompleteGa4Date, latestCompleteGscDate, pageIdentity } from '../../../src/experiments/metrics.js';
import { newId } from '../../../src/core/ids.js';
import { confirmRateScale } from '../../../src/integrations/google/ga4-metadata.js';
import { experimentsSiteConfig, GA4_PROPERTY, GSC_PROPERTY, seedGa4Landing, seedGscPage, seedGscProperty, seedPage } from '../../fixtures/experiments/seed.js';

/** A second synthetic page with rows every day, so the page-level dataset covers each date. */
function seedOtherPage(ctx: TestContext, start: string, end: string, isFinal?: (d: string) => boolean) {
  const o = seedPage(ctx.db, ctx.siteId, { path: '/other' });
  seedGscPage(ctx.db, ctx.siteId, { pageUrl: o.url, pageId: o.id, start, end, clicks: () => 5, impressions: () => 50, ...(isFinal ? { isFinal } : {}) });
  return o;
}

describe('experiment window metrics (current-revision rows only)', () => {
  let ctx: TestContext;
  afterEach(() => ctx.cleanup());

  it('aggregates CTR from sums and impression-weighted position; absent page rows on covered days are observed zeros', () => {
    ctx = createTestContext({ config: experimentsSiteConfig() });
    const p = seedPage(ctx.db, ctx.siteId, { path: '/w' });
    seedGscProperty(ctx.db, ctx.siteId, '2026-06-01', '2026-06-07');
    seedOtherPage(ctx, '2026-06-01', '2026-06-07'); // the page dataset covers 06-07 (another page has a row)
    seedGscPage(ctx.db, ctx.siteId, {
      pageUrl: p.url,
      pageId: p.id,
      start: '2026-06-01',
      end: '2026-06-07',
      clicks: (_d, i) => (i === 6 ? 0 : 10),
      impressions: (_d, i) => (i === 0 ? 300 : i === 6 ? 0 : 100),
      position: (_d, i) => (i === 0 ? 2 : 10),
    });
    const id = pageIdentity(ctx.db, ctx.siteId, [{ id: p.id, url: p.url }]);
    const m = gscWindowMetrics(ctx.db, id, { siteId: ctx.siteId, property: GSC_PROPERTY, searchType: 'web', segmentKey: '', start: '2026-06-01', end: '2026-06-07' });
    expect(m.status).toBe('observed');
    expect(m.clicks).toBe(60);
    expect(m.impressions).toBe(800);
    expect(m.ctr).toBeCloseTo(60 / 800, 10); // not the mean of daily CTRs
    expect(m.position).toBeCloseTo((2 * 300 + 10 * 500) / 800, 10);
    expect(m.rows).toBe(6);
    expect(m.anySynthetic).toBe(true);
  });

  it('distinguishes missing days and non-final days from zero (from the page-level dataset)', () => {
    ctx = createTestContext({ config: experimentsSiteConfig() });
    const p = seedPage(ctx.db, ctx.siteId, { path: '/w' });
    seedGscProperty(ctx.db, ctx.siteId, '2026-06-01', '2026-06-07'); // property totals for every day, final
    seedGscPage(ctx.db, ctx.siteId, { pageUrl: p.url, pageId: p.id, start: '2026-06-01', end: '2026-06-05', clicks: () => 1, impressions: () => 10, isFinal: (d) => d !== '2026-06-05' });
    const id = pageIdentity(ctx.db, ctx.siteId, [{ id: p.id, url: p.url }]);
    const m = gscWindowMetrics(ctx.db, id, { siteId: ctx.siteId, property: GSC_PROPERTY, searchType: 'web', segmentKey: '', start: '2026-06-01', end: '2026-06-07' });
    expect(m.status).toBe('incomplete');
    expect(m.missingDates).toEqual(['2026-06-06', '2026-06-07']);
    expect(m.nonFinalDates).toEqual(['2026-06-05']);
    const none = gscWindowMetrics(ctx.db, id, { siteId: ctx.siteId, property: GSC_PROPERTY, searchType: 'web', segmentKey: '', start: '2026-05-01', end: '2026-05-07' });
    expect(none).toMatchObject({ status: 'unavailable', clicks: null, impressions: null, ctr: null });
    // Property totals never extend the page-level window: the latest final PAGE date is 06-04.
    expect(latestCompleteGscDate(ctx.db, ctx.siteId, GSC_PROPERTY, 'web')).toBe('2026-06-04');
  });

  it('page rows missing while property totals exist are MISSING, never observed zeros', () => {
    ctx = createTestContext({ config: experimentsSiteConfig() });
    const p = seedPage(ctx.db, ctx.siteId, { path: '/w' });
    seedGscProperty(ctx.db, ctx.siteId, '2026-06-01', '2026-06-14');
    seedGscPage(ctx.db, ctx.siteId, { pageUrl: p.url, pageId: p.id, start: '2026-06-01', end: '2026-06-07', clicks: () => 10, impressions: () => 100 }); // page sync lags a week
    const id = pageIdentity(ctx.db, ctx.siteId, [{ id: p.id, url: p.url }]);
    const m = gscWindowMetrics(ctx.db, id, { siteId: ctx.siteId, property: GSC_PROPERTY, searchType: 'web', segmentKey: '', start: '2026-06-01', end: '2026-06-14' });
    expect(m.status).toBe('incomplete');
    expect(m.missingDates).toHaveLength(7);
    expect(m.missingDates[0]).toBe('2026-06-08');
    expect(m.reason).toMatch(/7 missing/);
    const later = gscWindowMetrics(ctx.db, id, { siteId: ctx.siteId, property: GSC_PROPERTY, searchType: 'web', segmentKey: '', start: '2026-06-08', end: '2026-06-14' });
    expect(later).toMatchObject({ status: 'unavailable', clicks: null, impressions: null });
    // The window can never extend into dates that only have property totals.
    expect(latestCompleteGscDate(ctx.db, ctx.siteId, GSC_PROPERTY, 'web')).toBe('2026-06-07');
    ctx.db.run(`INSERT INTO gsc_data_availability (id, site_id, property, search_type, latest_final_date, checked_at) VALUES ('av1', ?, ?, 'web', '2026-06-14', '2026-06-16T00:00:00Z')`, [ctx.siteId, GSC_PROPERTY]);
    expect(latestCompleteGscDate(ctx.db, ctx.siteId, GSC_PROPERTY, 'web')).toBe('2026-06-07');
    ctx.db.run(`INSERT INTO gsc_data_availability (id, site_id, property, search_type, latest_final_date, checked_at) VALUES ('av2', ?, ?, 'web', '2026-06-05', '2026-06-17T00:00:00Z')`, [ctx.siteId, GSC_PROPERTY]);
    expect(latestCompleteGscDate(ctx.db, ctx.siteId, GSC_PROPERTY, 'web')).toBe('2026-06-05'); // reported availability can only lower it
  });

  it('on dates of a row-limit-truncated page batch, a page without a row is uncertain (incomplete), not zero', () => {
    ctx = createTestContext({ config: experimentsSiteConfig() });
    const p = seedPage(ctx.db, ctx.siteId, { path: '/w' });
    seedOtherPage(ctx, '2026-06-01', '2026-06-07');
    seedGscPage(ctx.db, ctx.siteId, { pageUrl: p.url, pageId: p.id, start: '2026-06-01', end: '2026-06-07', clicks: (_d, i) => (i >= 5 ? 0 : 1), impressions: (_d, i) => (i >= 5 ? 0 : 10) }); // no rows on 06-06, 06-07
    const id = pageIdentity(ctx.db, ctx.siteId, [{ id: p.id, url: p.url }]);
    const q = { siteId: ctx.siteId, property: GSC_PROPERTY, searchType: 'web', segmentKey: '', start: '2026-06-01', end: '2026-06-07' };
    expect(gscWindowMetrics(ctx.db, id, q)).toMatchObject({ status: 'observed', impressions: 50 }); // untruncated: observed zeros
    // A later sync of the page dataset hit the documented row ceiling on 06-07 (and on 06-02, where the page does have a row).
    ctx.db.run(
      `INSERT INTO ingestion_batches (id, site_id, source, dataset, property, date_start, date_end, request_json, status, truncated, coverage_json, transformation_version, is_synthetic, started_at)
       VALUES (?, ?, 'gsc', 'gsc_page_daily', ?, '2026-06-01', '2026-06-07', ?, 'partial', 1, ?, 'fixture@1', 1, '2026-06-09T00:00:00.000Z')`,
      [newId('batch'), ctx.siteId, GSC_PROPERTY, JSON.stringify({ type: 'web', dimensions: ['date', 'page'], aggregationType: 'byPage' }), JSON.stringify({ truncatedDates: ['2026-06-02', '2026-06-07'] })],
    );
    const m = gscWindowMetrics(ctx.db, id, q);
    expect(m.status).toBe('incomplete');
    expect(m.truncatedDates).toEqual(['2026-06-07']);
    expect(m.reason).toMatch(/1 row-limit-truncated/);
    // A truncated SEGMENTED batch does not taint the unsegmented dataset; another search type neither.
    ctx.db.run(`UPDATE ingestion_batches SET request_json = ? WHERE truncated = 1`, [JSON.stringify({ type: 'web', dimensions: ['date', 'page', 'device'] })]);
    expect(gscWindowMetrics(ctx.db, id, q).status).toBe('observed');
    ctx.db.run(`UPDATE ingestion_batches SET request_json = ? WHERE truncated = 1`, [JSON.stringify({ type: 'image', dimensions: ['date', 'page'] })]);
    expect(gscWindowMetrics(ctx.db, id, q).status).toBe('observed');
  });

  it('matches GSC rows by page_id or, when unreconciled, by exact URL and established aliases only', () => {
    ctx = createTestContext({ config: experimentsSiteConfig() });
    const p = seedPage(ctx.db, ctx.siteId, { path: '/w' });
    ctx.db.run(`INSERT INTO url_aliases (id, site_id, page_id, alias_url, relation, confidence, source, created_at, updated_at) VALUES ('a1', ?, ?, 'https://www.example.test/w?utm_source=x', 'tracking_params_removed', 'established', 'test', 'n', 'n')`, [ctx.siteId, p.id]);
    ctx.db.run(`INSERT INTO url_aliases (id, site_id, page_id, alias_url, relation, confidence, source, created_at, updated_at) VALUES ('a2', ?, ?, 'https://www.example.test/W', 'manual', 'unverified', 'test', 'n', 'n')`, [ctx.siteId, p.id]);
    seedGscProperty(ctx.db, ctx.siteId, '2026-06-01', '2026-06-01');
    for (const url of [p.url, 'https://www.example.test/w?utm_source=x', 'https://www.example.test/W']) {
      seedGscPage(ctx.db, ctx.siteId, { pageUrl: url, pageId: null, start: '2026-06-01', end: '2026-06-01', clicks: () => 1, impressions: () => 10 });
    }
    const id = pageIdentity(ctx.db, ctx.siteId, [{ id: p.id, url: p.url }]);
    const m = gscWindowMetrics(ctx.db, id, { siteId: ctx.siteId, property: GSC_PROPERTY, searchType: 'web', segmentKey: '', start: '2026-06-01', end: '2026-06-01' });
    expect(m.impressions).toBe(20); // the unverified case variant is not merged
  });

  it('GA4: converting sessions come from the reported session key-event rate; unavailable rates are never zero', () => {
    ctx = createTestContext({ config: experimentsSiteConfig() });
    const p = seedPage(ctx.db, ctx.siteId, { path: '/w' });
    seedGa4Landing(ctx.db, ctx.siteId, { landingPage: '/w', pageId: p.id, start: '2026-06-01', end: '2026-06-02', sessions: (_d, i) => (i === 0 ? 100 : 300), rate: (_d, i) => (i === 0 ? 0.1 : 0.02) });
    const id = pageIdentity(ctx.db, ctx.siteId, [{ id: p.id, url: p.url }]);
    const q = { siteId: ctx.siteId, propertyId: GA4_PROPERTY, channelView: 'google_organic' as const, segmentKey: '', start: '2026-06-01', end: '2026-06-02' };
    const m = ga4WindowMetrics(ctx.db, id, q);
    expect(m.sessions).toBe(400);
    expect(m.convertingSessions).toBeCloseTo(10 + 6, 10);
    expect(m.primarySessionRate).toBeCloseTo(16 / 400, 10); // not the average of 10% and 2%
    expect(m.primaryKeyEvents).toBe(16); // occurrences, reported separately
    expect(m.revenueStatus).toBe('unavailable');
    expect(m.revenueMicros).toBeNull();

    const p2 = seedPage(ctx.db, ctx.siteId, { path: '/x' });
    seedGa4Landing(ctx.db, ctx.siteId, { landingPage: '/x', pageId: p2.id, start: '2026-06-01', end: '2026-06-02', sessions: () => 50, rate: () => null });
    const m2 = ga4WindowMetrics(ctx.db, pageIdentity(ctx.db, ctx.siteId, [{ id: p2.id, url: p2.url }]), q);
    expect(m2.primaryRateStatus).toBe('unavailable');
    expect(m2.primarySessionRate).toBeNull();
    expect(m2.convertingSessions).toBeNull();
    expect(latestCompleteGa4Date(ctx.db, ctx.siteId, GA4_PROPERTY, 'google_organic')).toBe('2026-06-02');
  });

  it('GA4: a session key-event rate stored with scale "undetermined" is never multiplied by sessions', () => {
    ctx = createTestContext({ config: experimentsSiteConfig() });
    const p = seedPage(ctx.db, ctx.siteId, { path: '/w' });
    seedGa4Landing(ctx.db, ctx.siteId, { landingPage: '/w', pageId: p.id, start: '2026-06-01', end: '2026-06-02', sessions: () => 100, rate: () => 0.5 });
    // SYNTHETIC: the GA4 sync could not establish 0-1 vs 0-100 for this property.
    ctx.db.run("UPDATE ga4_landing_daily SET primary_session_rate_scale = 'undetermined' WHERE site_id = ? AND primary_session_rate IS NOT NULL", [ctx.siteId]);
    const id = pageIdentity(ctx.db, ctx.siteId, [{ id: p.id, url: p.url }]);
    const q = { siteId: ctx.siteId, propertyId: GA4_PROPERTY, channelView: 'google_organic' as const, segmentKey: '', start: '2026-06-01', end: '2026-06-02' };
    const m = ga4WindowMetrics(ctx.db, id, q);
    expect(m.sessions).toBe(200);
    expect(m.primaryRateStatus).toBe('unavailable');
    expect(m.primaryRateReason).toMatch(/^rate scale unverified/);
    expect(m.convertingSessions).toBeNull();
    expect(m.primarySessionRate).toBeNull();
    // A verified 0-100 scale (already normalized at ingestion) is used as stored.
    ctx.db.run("UPDATE ga4_landing_daily SET primary_session_rate_scale = 'percent_normalized', primary_session_rate = 0.05 WHERE site_id = ? AND primary_session_rate IS NOT NULL", [ctx.siteId]);
    const v = ga4WindowMetrics(ctx.db, id, q);
    expect(v.primaryRateStatus).toBe('observed');
    expect(v.convertingSessions).toBeCloseTo(10, 10);
    expect(v.primaryRateReason).toBeNull();
  });

  it('GA4: once the owner confirms the rate scale, baseline windows (and the primarySessionRate guardrail) use it (B3-01)', () => {
    ctx = createTestContext({ config: experimentsSiteConfig() });
    const p = seedPage(ctx.db, ctx.siteId, { path: '/w' });
    seedGa4Landing(ctx.db, ctx.siteId, { landingPage: '/w', pageId: p.id, start: '2026-06-01', end: '2026-06-02', sessions: () => 100, rate: () => 0.5 });
    ctx.db.run("UPDATE ga4_landing_daily SET primary_session_rate_scale = 'undetermined' WHERE site_id = ? AND primary_session_rate IS NOT NULL", [ctx.siteId]);
    const id = pageIdentity(ctx.db, ctx.siteId, [{ id: p.id, url: p.url }]);
    const q = { siteId: ctx.siteId, propertyId: GA4_PROPERTY, channelView: 'google_organic' as const, segmentKey: '', start: '2026-06-01', end: '2026-06-02' };
    expect(ga4WindowMetrics(ctx.db, id, q).primaryRateStatus).toBe('unavailable');
    // The owner compared the GA4 interface (0.50%) with the stored 0.5: a 0-100 property.
    confirmRateScale(ctx, GA4_PROPERTY, { scale: 'percent', evidence: 'GA4 UI shows 0.50% for /w on 2026-06-01; stored 0.5', actor: 'Alice' });
    const m = ga4WindowMetrics(ctx.db, id, q);
    expect(m.primaryRateStatus).toBe('observed');
    expect(m.primarySessionRate).toBeCloseTo(0.005, 12);
    expect(m.convertingSessions).toBeCloseTo(1, 10);
  });

  it('GA4 coverage comes from the same segment and channel view; a truncated landing batch makes absent rows uncertain', () => {
    ctx = createTestContext({ config: experimentsSiteConfig() });
    const p = seedPage(ctx.db, ctx.siteId, { path: '/w' });
    seedGa4Landing(ctx.db, ctx.siteId, { landingPage: '/w', pageId: p.id, start: '2026-06-01', end: '2026-06-02', sessions: () => 10, rate: () => 0.1 });
    // Another landing page has rows through 06-04 only in a DIFFERENT segment: it does not cover 06-03/06-04 for segment ''.
    ctx.db.run(`INSERT INTO ga4_landing_daily (site_id, property_id, date, date_tz, channel_view, landing_page, host_name, page_id, segment_key, sessions, engaged_sessions, primary_event_name, primary_key_events, primary_key_events_status, primary_session_rate, primary_session_rate_status, revenue_status, metric_names_json, is_complete, revision, is_current, row_hash, batch_id, collected_at, transformation_version, is_synthetic)
      SELECT site_id, property_id, '2026-06-04', date_tz, channel_view, '/x', host_name, NULL, 'deviceCategory=mobile', 5, 3, primary_event_name, 0, 'observed', 0, 'observed', 'unavailable', metric_names_json, 1, 1, 1, 'seg-row', batch_id, collected_at, transformation_version, 1 FROM ga4_landing_daily LIMIT 1`);
    const id = pageIdentity(ctx.db, ctx.siteId, [{ id: p.id, url: p.url }]);
    const q = { siteId: ctx.siteId, propertyId: GA4_PROPERTY, channelView: 'google_organic' as const, segmentKey: '', start: '2026-06-01', end: '2026-06-04' };
    const m = ga4WindowMetrics(ctx.db, id, q);
    expect(m.status).toBe('incomplete');
    expect(m.missingDates).toEqual(['2026-06-03', '2026-06-04']);
    const other = seedPage(ctx.db, ctx.siteId, { path: '/y' });
    seedGa4Landing(ctx.db, ctx.siteId, { landingPage: '/y', pageId: other.id, start: '2026-06-01', end: '2026-06-04', sessions: () => 7, rate: () => 0.1 });
    expect(ga4WindowMetrics(ctx.db, id, q)).toMatchObject({ status: 'observed', sessions: 20 }); // 06-03/04 covered: observed zeros
    ctx.db.run(
      `INSERT INTO ingestion_batches (id, site_id, source, dataset, property, date_start, date_end, request_json, status, truncated, transformation_version, is_synthetic, started_at)
       VALUES (?, ?, 'ga4', 'ga4_landing_daily', ?, '2026-06-01', '2026-06-04', ?, 'partial', 1, 'fixture@1', 1, '2026-06-09T00:00:00.000Z')`,
      [newId('batch'), ctx.siteId, GA4_PROPERTY, JSON.stringify({ view: 'google_organic' })],
    );
    const t = ga4WindowMetrics(ctx.db, id, q);
    expect(t.status).toBe('incomplete');
    expect(t.truncatedDates).toEqual(['2026-06-03', '2026-06-04']);
    // Rows may have been dropped on those days: the rate is not an observed rate.
    expect(t.primaryRateStatus).toBe('incomplete');
    expect(t.primarySessionRate).toBeNull();
    // A page WITHOUT any row in a truncated window has unknown totals, never 0.
    const none = pageIdentity(ctx.db, ctx.siteId, [{ id: seedPage(ctx.db, ctx.siteId, { path: '/none' }).id, url: 'https://www.example.test/none' }]);
    expect(ga4WindowMetrics(ctx.db, none, q)).toMatchObject({ status: 'incomplete', sessions: null, primaryKeyEvents: null, revenueMicros: null, revenueStatus: 'incomplete', primaryRateStatus: 'incomplete' });
  });

  it('GSC: a page without any row in a row-limit-truncated window has unknown clicks/impressions, never 0', () => {
    ctx = createTestContext({ config: experimentsSiteConfig() });
    const none = seedPage(ctx.db, ctx.siteId, { path: '/none' });
    seedOtherPage(ctx, '2026-06-01', '2026-06-07');
    const id = pageIdentity(ctx.db, ctx.siteId, [{ id: none.id, url: none.url }]);
    const q = { siteId: ctx.siteId, property: GSC_PROPERTY, searchType: 'web', segmentKey: '', start: '2026-06-01', end: '2026-06-07' };
    expect(gscWindowMetrics(ctx.db, id, q)).toMatchObject({ status: 'observed', clicks: 0, impressions: 0 }); // untruncated: observed zeros
    ctx.db.run(
      `INSERT INTO ingestion_batches (id, site_id, source, dataset, property, date_start, date_end, request_json, status, truncated, coverage_json, transformation_version, is_synthetic, started_at)
       VALUES (?, ?, 'gsc', 'gsc_page_daily', ?, '2026-06-01', '2026-06-07', ?, 'partial', 1, ?, 'fixture@1', 1, '2026-06-09T00:00:00.000Z')`,
      [newId('batch'), ctx.siteId, GSC_PROPERTY, JSON.stringify({ type: 'web', dimensions: ['date', 'page'] }), JSON.stringify({ truncatedDates: ['2026-06-07'] })],
    );
    const m = gscWindowMetrics(ctx.db, id, q);
    expect(m).toMatchObject({ status: 'incomplete', clicks: null, impressions: null, ctr: null, truncatedDates: ['2026-06-07'] });
    expect(m.reason).toMatch(/unknown, not zero/);
  });

  it('GA4 row loss (thresholding, "(other)", sampling): a page without a row on such a covered date is unknown, not an observed zero (NF-03)', () => {
    ctx = createTestContext({ config: experimentsSiteConfig() });
    const p = seedPage(ctx.db, ctx.siteId, { path: '/w' });
    seedGa4Landing(ctx.db, ctx.siteId, { landingPage: '/w', pageId: p.id, start: '2026-06-01', end: '2026-06-02', sessions: () => 10, rate: () => 0.1 });
    const other = seedPage(ctx.db, ctx.siteId, { path: '/y' });
    seedGa4Landing(ctx.db, ctx.siteId, { landingPage: '/y', pageId: other.id, start: '2026-06-01', end: '2026-06-04', sessions: () => 7, rate: () => 0.1 });
    const nothing = seedPage(ctx.db, ctx.siteId, { path: '/none' }); // no GA4 row at all in the window
    const id = pageIdentity(ctx.db, ctx.siteId, [{ id: p.id, url: p.url }]);
    const noneId = pageIdentity(ctx.db, ctx.siteId, [{ id: nothing.id, url: nothing.url }]);
    const q = { siteId: ctx.siteId, propertyId: GA4_PROPERTY, channelView: 'google_organic' as const, segmentKey: '', start: '2026-06-01', end: '2026-06-04' };
    // Clean reports: 06-03/04 are covered, so the absent rows are observed zeros.
    expect(ga4WindowMetrics(ctx.db, id, q)).toMatchObject({ status: 'observed', sessions: 20, primaryRateStatus: 'observed', rowLossDates: [] });
    expect(ga4WindowMetrics(ctx.db, noneId, q)).toMatchObject({ status: 'observed', sessions: 0, primaryKeyEvents: 0, revenueStatus: 'observed' });

    // SYNTHETIC: every landing report covering the window says rows may be withheld (GA4 response metadata on the batch).
    ctx.db.run(`UPDATE ingestion_batches SET metadata_json = ? WHERE site_id = ? AND dataset = 'ga4_landing_daily'`, [JSON.stringify({ subjectToThresholding: true }), ctx.siteId]);
    const m = ga4WindowMetrics(ctx.db, id, q);
    expect(m.status).toBe('incomplete');
    expect(m.rowLossDates).toEqual(['2026-06-03', '2026-06-04']); // 06-01/02 have a row: those rows are real
    expect(m.rowLossReasons).toEqual(['thresholding']);
    expect(m.truncatedDates).toEqual([]);
    expect(m.reason).toMatch(/2 day\(s\) where GA4 reported thresholding .* the page has no row: unknown, not zero/);
    expect(m.sessions).toBe(20); // the rows that exist (a lower bound of an incomplete window)
    expect(m.primaryRateStatus).toBe('incomplete');
    expect(m.primaryRateReason).toMatch(/thresholding/);
    expect(m.primarySessionRate).toBeNull();
    expect(m.convertingSessions).toBeNull();
    expect(m.revenueStatus).not.toBe('observed');
    // No row at all: sessions, key events, and revenue are unknown (null), never 0.
    const n = ga4WindowMetrics(ctx.db, noneId, q);
    expect(n).toMatchObject({ status: 'incomplete', sessions: null, engagedSessions: null, primaryKeyEvents: null, revenueMicros: null, rowLossDates: ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04'] });
    expect(n.primaryRateStatus).not.toBe('observed');
    expect(n.revenueStatus).not.toBe('observed');
    expect(n.reason).toMatch(/unknown \(not zero\)/);

    // "(other)" bucketing and sampling are row loss too; reasons are reported.
    ctx.db.run(`UPDATE ingestion_batches SET metadata_json = ? WHERE site_id = ? AND dataset = 'ga4_landing_daily'`, [JSON.stringify({ dataLossFromOtherRow: true, samplingMetadatas: [{ samplesReadCount: '1', samplingSpaceSize: '10' }] }), ctx.siteId]);
    expect(ga4WindowMetrics(ctx.db, id, q).rowLossReasons.sort()).toEqual(['other_row', 'sampling']);

    // A clean report of ANOTHER channel view proves nothing for google_organic...
    const clean = newId('batch');
    ctx.db.run(
      `INSERT INTO ingestion_batches (id, site_id, source, dataset, property, date_start, date_end, request_json, status, truncated, transformation_version, is_synthetic, started_at)
       VALUES (?, ?, 'ga4', 'ga4_landing_daily', ?, '2026-06-03', '2026-06-04', ?, 'succeeded', 0, 'fixture@1', 1, '2026-06-09T00:00:00.000Z')`,
      [clean, ctx.siteId, GA4_PROPERTY, JSON.stringify({ view: 'all_organic' })],
    );
    expect(ga4WindowMetrics(ctx.db, id, q).rowLossDates).toEqual(['2026-06-03', '2026-06-04']);
    // ...but one covering google_organic report free of row loss proves absence: observed zeros on 06-03/04.
    ctx.db.run(`UPDATE ingestion_batches SET request_json = ? WHERE id = ?`, [JSON.stringify({ view: 'google_organic' }), clean]);
    const proven = ga4WindowMetrics(ctx.db, id, q);
    expect(proven).toMatchObject({ rowLossDates: [], sessions: 20 });
    // The rows of 06-01/02 still come only from the sampled, "(other)"-bucketed reports: estimates, not exact (D1-R02).
    expect(proven).toMatchObject({ status: 'incomplete', estimateDates: ['2026-06-01', '2026-06-02'], estimateReasons: ['other_row', 'sampling'], primaryRateStatus: 'incomplete' });
    // Thresholding alone never makes a present row an estimate: observed again.
    ctx.db.run(`UPDATE ingestion_batches SET metadata_json = ? WHERE site_id = ? AND dataset = 'ga4_landing_daily' AND id <> ?`, [JSON.stringify({ subjectToThresholding: true }), ctx.siteId, clean]);
    expect(ga4WindowMetrics(ctx.db, id, q)).toMatchObject({ status: 'observed', rowLossDates: [], estimateDates: [], sessions: 20, primaryRateStatus: 'observed' });
  });

  describe('GA4 estimates: sampled or "(other)"-bucketed reports with the page present every day (D1-R02)', () => {
    /** SYNTHETIC: a page with a GA4 landing row on every day of the window, from one clean fixture batch. */
    function presentEveryDay() {
      ctx = createTestContext({ config: experimentsSiteConfig() });
      const p = seedPage(ctx.db, ctx.siteId, { path: '/w' });
      seedGa4Landing(ctx.db, ctx.siteId, { landingPage: '/w', pageId: p.id, start: '2026-06-01', end: '2026-06-04', sessions: () => 10, rate: () => 0.1 });
      const id = pageIdentity(ctx.db, ctx.siteId, [{ id: p.id, url: p.url }]);
      const q = { siteId: ctx.siteId, propertyId: GA4_PROPERTY, channelView: 'google_organic' as const, segmentKey: '', start: '2026-06-01', end: '2026-06-04' };
      const setMetadata = (m: Record<string, unknown>) => ctx.db.run(`UPDATE ingestion_batches SET metadata_json = ? WHERE site_id = ? AND dataset = 'ga4_landing_daily'`, [JSON.stringify(m), ctx.siteId]);
      return { p, id, q, setMetadata };
    }
    const ALL = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04'];

    it('a clean report stays observed', () => {
      const { id, q } = presentEveryDay();
      const m = ga4WindowMetrics(ctx.db, id, q);
      expect(m).toMatchObject({ status: 'observed', reason: null, estimateDates: [], estimateReasons: [], rowLossDates: [], sessions: 40, primaryRateStatus: 'observed' });
      expect(m.primarySessionRate).toBeCloseTo(0.1, 12);
    });

    it('a sampled report: the rows are estimates, so the window is incomplete and the rate and revenue are not observed', () => {
      const { id, q, setMetadata } = presentEveryDay();
      setMetadata({ samplingMetadatas: [{ samplesReadCount: '1000', samplingSpaceSize: '10000' }] });
      const m = ga4WindowMetrics(ctx.db, id, q);
      expect(m.rowLossDates).toEqual([]); // the page has a row every day: nothing is missing...
      expect(m.estimateDates).toEqual(ALL); // ...but every value is a sampled estimate
      expect(m.estimateReasons).toEqual(['sampling']);
      expect(m.status).toBe('incomplete');
      expect(m.reason).toMatch(/4 collected day\(s\) where GA4 reported sampling: the landing values of the page on those days are sampled estimates, not exact/);
      expect(m.sessions).toBe(40); // the sum of the sampled rows, reported on an incomplete window
      expect(m.primaryRateStatus).toBe('incomplete');
      expect(m.primaryRateReason).toMatch(/sampling/);
      expect(m.primarySessionRate).toBeNull();
      expect(m.convertingSessions).toBeNull();
      expect(m.revenueStatus).not.toBe('observed');
      expect(m.revenueMicros).toBeNull();
    });

    it('an "(other)"-bucketed report: the page total may be partial, so the window is incomplete', () => {
      const { id, q, setMetadata } = presentEveryDay();
      setMetadata({ dataLossFromOtherRow: true });
      const m = ga4WindowMetrics(ctx.db, id, q);
      expect(m).toMatchObject({ status: 'incomplete', rowLossDates: [], estimateDates: ALL, estimateReasons: ['other_row'], primaryRateStatus: 'incomplete', primarySessionRate: null });
      expect(m.reason).toMatch(/GA4 reported rows bucketed into "\(other\)" \(dataLossFromOtherRow\): .*possibly partial \(landing-page variants may be counted in the "\(other\)" row\), not exact/);
      expect(m.revenueStatus).not.toBe('observed');
    });

    it('thresholding alone leaves present rows observed', () => {
      const { id, q, setMetadata } = presentEveryDay();
      setMetadata({ subjectToThresholding: true });
      expect(ga4WindowMetrics(ctx.db, id, q)).toMatchObject({ status: 'observed', estimateDates: [], rowLossDates: [], primaryRateStatus: 'observed' });
    });

    it('row provenance: rows from a later sampled report are estimates although an earlier clean report covers the days; a later clean re-statement makes them exact', () => {
      const { p, id, q } = presentEveryDay();
      const addBatch = (metadata: Record<string, unknown> | null, startedAt: string) => {
        const b = newId('batch');
        ctx.db.run(
          `INSERT INTO ingestion_batches (id, site_id, source, dataset, property, date_start, date_end, request_json, status, truncated, metadata_json, transformation_version, is_synthetic, started_at)
           VALUES (?, ?, 'ga4', 'ga4_landing_daily', ?, '2026-06-01', '2026-06-02', ?, 'succeeded', 0, ?, 'fixture@1', 1, ?)`,
          [b, ctx.siteId, GA4_PROPERTY, JSON.stringify({ view: 'google_organic' }), metadata ? JSON.stringify(metadata) : null, startedAt],
        );
        return b;
      };
      // SYNTHETIC: a later sampled report revised the page's 06-01/02 rows (their current revision comes from it).
      const sampled = addBatch({ samplingMetadatas: [{ samplesReadCount: '5', samplingSpaceSize: '50' }] }, '2026-06-09T00:00:00.000Z');
      ctx.db.run(`UPDATE ga4_landing_daily SET batch_id = ? WHERE site_id = ? AND page_id = ? AND date <= '2026-06-02'`, [sampled, ctx.siteId, p.id]);
      const m = ga4WindowMetrics(ctx.db, id, q);
      expect(m).toMatchObject({ status: 'incomplete', estimateDates: ['2026-06-01', '2026-06-02'], estimateReasons: ['sampling'], rowLossDates: [], primaryRateStatus: 'incomplete' });
      // A still later clean report re-stated them (new revisions from the clean batch): exact again.
      const restated = addBatch(null, '2026-06-10T00:00:00.000Z');
      ctx.db.run(`UPDATE ga4_landing_daily SET batch_id = ? WHERE site_id = ? AND page_id = ? AND date <= '2026-06-02'`, [restated, ctx.siteId, p.id]);
      expect(ga4WindowMetrics(ctx.db, id, q)).toMatchObject({ status: 'observed', estimateDates: [], primaryRateStatus: 'observed' });
    });

    it('a comparison group: a day where one page\'s row comes from a sampled report is an estimate day for the group', () => {
      ctx = createTestContext({ config: experimentsSiteConfig() });
      const a = seedPage(ctx.db, ctx.siteId, { path: '/a' });
      const b = seedPage(ctx.db, ctx.siteId, { path: '/b' });
      seedGa4Landing(ctx.db, ctx.siteId, { landingPage: '/a', pageId: a.id, start: '2026-06-01', end: '2026-06-02', sessions: () => 10, rate: () => 0.1 });
      seedGa4Landing(ctx.db, ctx.siteId, { landingPage: '/b', pageId: b.id, start: '2026-06-01', end: '2026-06-02', sessions: () => 10, rate: () => 0.1 });
      // SYNTHETIC: only /b's report was sampled; /a's report of the same days is clean.
      const bBatch = ctx.db.get<{ batch_id: string }>(`SELECT batch_id FROM ga4_landing_daily WHERE site_id = ? AND page_id = ? LIMIT 1`, [ctx.siteId, b.id])!.batch_id;
      ctx.db.run(`UPDATE ingestion_batches SET metadata_json = ? WHERE site_id = ? AND id = ?`, [JSON.stringify({ samplingMetadatas: [{ samplesReadCount: '1', samplingSpaceSize: '2' }] }), ctx.siteId, bBatch]);
      const group = pageIdentity(ctx.db, ctx.siteId, [
        { id: a.id, url: a.url },
        { id: b.id, url: b.url },
      ]);
      const m = ga4WindowMetrics(ctx.db, group, { siteId: ctx.siteId, propertyId: GA4_PROPERTY, channelView: 'google_organic', segmentKey: '', start: '2026-06-01', end: '2026-06-02' });
      expect(m).toMatchObject({ status: 'incomplete', estimateDates: ['2026-06-01', '2026-06-02'], estimateReasons: ['sampling'], rowLossDates: [] });
      expect(m.reason).toMatch(/the landing values of these pages on those days are sampled estimates/);
    });
  });

  it('GA4 row loss on a comparison group: a date where not every page has a row is uncertain', () => {
    ctx = createTestContext({ config: experimentsSiteConfig() });
    const a = seedPage(ctx.db, ctx.siteId, { path: '/a' });
    const b = seedPage(ctx.db, ctx.siteId, { path: '/b' });
    seedGa4Landing(ctx.db, ctx.siteId, { landingPage: '/a', pageId: a.id, start: '2026-06-01', end: '2026-06-03', sessions: () => 10, rate: () => 0.1 });
    seedGa4Landing(ctx.db, ctx.siteId, { landingPage: '/b', pageId: b.id, start: '2026-06-01', end: '2026-06-02', sessions: () => 10, rate: () => 0.1 });
    ctx.db.run(`UPDATE ingestion_batches SET metadata_json = ? WHERE site_id = ? AND dataset = 'ga4_landing_daily'`, [JSON.stringify({ subjectToThresholding: true }), ctx.siteId]);
    const group = pageIdentity(ctx.db, ctx.siteId, [
      { id: a.id, url: a.url },
      { id: b.id, url: b.url },
    ]);
    const m = ga4WindowMetrics(ctx.db, group, { siteId: ctx.siteId, propertyId: GA4_PROPERTY, channelView: 'google_organic', segmentKey: '', start: '2026-06-01', end: '2026-06-03' });
    expect(m.rowLossDates).toEqual(['2026-06-03']);
    expect(m.status).toBe('incomplete');
    expect(m.reason).toMatch(/not every page has/);
  });
});
