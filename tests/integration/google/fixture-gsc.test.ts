import { afterEach, describe, expect, it } from 'vitest';
import { createFixtureGoogleAuthProvider } from '../../../src/integrations/google/fixture-provider.js';
import { syncGsc } from '../../../src/integrations/google/gsc-sync.js';
import { inspectUrls, selectPriorityUrls, describeInspection } from '../../../src/integrations/google/url-inspection.js';
import { createGoogleAuthProvider } from '../../../src/auth/providers.js';
import { FAST_RETRY, GOOGLE_FIXTURES, SYNTHETIC_GA4, SYNTHETIC_PROPERTY, count, googleConfig, googleTestContext } from './_helpers.js';
import type { TestContext } from '../../helpers/context.js';

const NOW = '2026-09-24T09:00:00.000Z';
let ctx: TestContext;
afterEach(() => ctx?.cleanup());

function fixtureProvider(c: TestContext, extra: Parameters<typeof createFixtureGoogleAuthProvider>[1] = {}) {
  return createFixtureGoogleAuthProvider(GOOGLE_FIXTURES, { gscProperty: SYNTHETIC_PROPERTY, ga4PropertyId: SYNTHETIC_GA4, clock: c.clock, ...extra });
}

describe('fixture provider: Search Console end to end (synthetic)', () => {
  it('ingests all three datasets as synthetic rows with honest coverage', async () => {
    ctx = googleTestContext({ now: NOW });
    const provider = fixtureProvider(ctx);
    const r = await syncGsc(ctx, { provider, days: 14, topPages: 3, retry: FAST_RETRY });
    expect(r.status).toBe('succeeded');
    expect(r.synthetic).toBe(true);
    expect(r.availability[0]).toMatchObject({ firstIncompleteDate: '2026-09-22', firstIncompleteSource: 'api' });
    for (const t of ['gsc_property_daily', 'gsc_page_daily', 'gsc_page_query_daily']) {
      expect(count(ctx, `SELECT COUNT(*) AS n FROM ${t} WHERE site_id = ?`, [ctx.siteId])).toBeGreaterThan(0);
      expect(count(ctx, `SELECT COUNT(*) AS n FROM ${t} WHERE site_id = ? AND is_synthetic = 0`, [ctx.siteId])).toBe(0);
    }
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM ingestion_batches WHERE site_id = ? AND is_synthetic = 0', [ctx.siteId])).toBe(0);
    // Property totals (byProperty) are NOT the sum of page totals (byPage).
    const prop = ctx.db.get<{ i: number }>("SELECT SUM(impressions) AS i FROM gsc_property_daily_current WHERE site_id = ? AND date = '2026-09-15'", [ctx.siteId])!.i;
    const pages = ctx.db.get<{ i: number }>("SELECT SUM(impressions) AS i FROM gsc_page_daily_current WHERE site_id = ? AND date = '2026-09-15' AND segment_key = ''", [ctx.siteId])!.i;
    expect(prop).toBeLessThan(pages);
    // Anonymized queries: visible query rows are below page totals and the gap is labelled an estimate.
    const cov = JSON.parse(ctx.db.get<{ c: string }>("SELECT coverage_json AS c FROM ingestion_batches WHERE site_id = ? AND dataset = 'gsc_page_query_daily'", [ctx.siteId])!.c);
    expect(cov.pages).toHaveLength(3);
    for (const p of cov.pages) expect(p.unattributedImpressionsEstimate).toBeGreaterThan(0);
    expect(cov.unattributedEstimate).toMatch(/ESTIMATE/);
    // Case-sensitive paths are preserved exactly as reported.
    expect(count(ctx, "SELECT COUNT(*) AS n FROM gsc_page_daily WHERE site_id = ? AND page = 'https://www.example.test/docs/Getting-Started'", [ctx.siteId])).toBeGreaterThan(0);
  });

  it('records delayed revisions when partial recent days mature, without double counting', async () => {
    ctx = googleTestContext({ now: NOW });
    const provider = fixtureProvider(ctx);
    await syncGsc(ctx, { provider, days: 10, includePageQuery: false, retry: FAST_RETRY });
    const before = ctx.db.get<{ clicks: number; impressions: number; is_final: number }>("SELECT clicks, impressions, is_final FROM gsc_property_daily_current WHERE site_id = ? AND date = '2026-09-22'", [ctx.siteId])!;
    const currentBefore = count(ctx, 'SELECT COUNT(*) AS n FROM gsc_property_daily_current WHERE site_id = ?', [ctx.siteId]);
    ctx.clock.advanceMs(86_400_000);
    const r = await syncGsc(ctx, { provider, days: 10, includePageQuery: false, retry: FAST_RETRY });
    const totals = r.datasets.find((d) => d.dataset === 'gsc_property_daily')!;
    expect(totals.rowsRevised).toBeGreaterThan(0);
    const after = ctx.db.get<{ impressions: number; is_final: number; revision: number }>("SELECT impressions, is_final, revision FROM gsc_property_daily_current WHERE site_id = ? AND date = '2026-09-22'", [ctx.siteId])!;
    expect(before.is_final).toBe(0);
    expect(after.is_final).toBe(1); // first incomplete date moved to 2026-09-23, so 09-22 is now final
    expect(after.revision).toBe(2);
    expect(after.impressions).toBeGreaterThan(before.impressions);
    // Older, final days are unchanged.
    expect(ctx.db.get<{ revision: number }>("SELECT revision FROM gsc_property_daily_current WHERE site_id = ? AND date = '2026-09-16'", [ctx.siteId])!.revision).toBe(1);
    // One current row per date: the window moved by one day.
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM gsc_property_daily_current WHERE site_id = ?', [ctx.siteId])).toBe(currentBefore + 1);
  });

  it('segments are fetched only when requested and use canonical segment keys', async () => {
    ctx = googleTestContext({ now: NOW });
    const provider = fixtureProvider(ctx);
    await syncGsc(ctx, { provider, days: 3, includePageQuery: false, retry: FAST_RETRY });
    expect(count(ctx, "SELECT COUNT(*) AS n FROM gsc_page_daily WHERE site_id = ? AND segment_key != ''", [ctx.siteId])).toBe(0);
    await syncGsc(ctx, { provider, days: 3, includePageQuery: false, segments: ['country', 'device', 'searchAppearance'], retry: FAST_RETRY });
    const keys = ctx.db.all<{ segment_key: string }>("SELECT DISTINCT segment_key FROM gsc_page_daily WHERE site_id = ? AND segment_key != '' ORDER BY segment_key", [ctx.siteId]).map((r) => r.segment_key);
    expect(keys).toContain('country=usa;device=MOBILE');
    expect(keys).toContain('searchAppearance=VIDEO');
    const sa = ctx.db.get<{ search_appearance: string; page: string }>("SELECT search_appearance, page FROM gsc_page_daily WHERE site_id = ? AND segment_key = 'searchAppearance=VIDEO' LIMIT 1", [ctx.siteId])!;
    expect(sa).toMatchObject({ search_appearance: 'VIDEO', page: 'https://www.example.test/blog/how-to-choose-a-widget' });
  });

  it('createGoogleAuthProvider returns the fixture provider only for the demo profile', async () => {
    ctx = googleTestContext({ now: NOW, config: googleConfig({ profile: 'demo' }) });
    const p = createGoogleAuthProvider(ctx);
    expect(p.mode).toBe('fixture');
    ctx.cleanup();
    ctx = googleTestContext({ now: NOW, secrets: { GOOGLE_AUTH_MODE: 'fixture' } });
    expect(() => createGoogleAuthProvider(ctx)).toThrow(/only allowed with the demo profile/);
  });

  it('refuses fixture files that are not labelled synthetic', () => {
    expect(() => createFixtureGoogleAuthProvider(GOOGLE_FIXTURES, { gscDatasetFile: '../google/README.md' })).toThrow();
  });
});

describe('URL Inspection (synthetic fixtures)', () => {
  it('inspects priority URLs within the per-run cap, stores indexed state, and never infers from impressions', async () => {
    ctx = googleTestContext({ now: NOW, config: googleConfig({ google: { gsc: { urlInspectionMaxPerRun: 2 } } }) });
    const provider = fixtureProvider(ctx);
    const r = await inspectUrls(ctx, provider, ['https://www.example.test/', 'https://www.example.test/features/reporting', 'https://www.example.test/blog/old-widget-guide', 'https://outside.example.net/page'], { retry: FAST_RETRY });
    expect(r.cap).toBe(2);
    expect(r.inspected).toBe(2);
    expect(r.outcomes.find((o) => o.url === 'https://outside.example.net/page')).toMatchObject({ status: 'skipped' });
    expect(r.outcomes.find((o) => o.url.endsWith('/blog/old-widget-guide'))).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/cap/) });
    const rows = ctx.db.all<{ inspection_kind: string; verdict: string; coverage_state: string; is_synthetic: number; raw_ref: string; last_crawl_time: string }>('SELECT * FROM url_inspections WHERE site_id = ? ORDER BY url', [ctx.siteId]);
    expect(rows).toHaveLength(2);
    expect(rows.every((x) => x.inspection_kind === 'indexed_state' && x.is_synthetic === 1 && x.raw_ref.startsWith('raw:'))).toBe(true);
    expect(rows.find((x) => x.verdict === 'NEUTRAL')!.coverage_state).toBe('Crawled - currently not indexed');
    expect(r.note).toMatch(/Not a live test/);
    expect(describeInspection({ verdict: 'PASS', coverageState: 'Submitted and indexed' })).toMatch(/Not a live test/);
    // No inference: pages with no performance data are not written as "not indexed" anywhere.
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM url_inspections WHERE site_id = ?', [ctx.siteId])).toBe(2);
  });

  it('selects priority URLs from performance data and respects the disabled flag', async () => {
    ctx = googleTestContext({ now: NOW });
    const provider = fixtureProvider(ctx);
    await syncGsc(ctx, { provider, days: 7, includePageQuery: false, retry: FAST_RETRY });
    const urls = selectPriorityUrls(ctx, 3);
    expect(urls[0]).toBe('https://www.example.test/');
    expect(urls).toHaveLength(3);
    ctx.cleanup();
    ctx = googleTestContext({ now: NOW, config: googleConfig({ features: { urlInspection: false } }) });
    const r = await inspectUrls(ctx, fixtureProvider(ctx), ['https://www.example.test/']);
    expect(r.status).toBe('disabled');
  });

  it('syncGsc --inspect runs inspection after syncing', async () => {
    ctx = googleTestContext({ now: NOW });
    const r = await syncGsc(ctx, { provider: fixtureProvider(ctx), days: 5, includePageQuery: false, inspect: 2, retry: FAST_RETRY });
    expect(r.inspection?.inspected).toBe(2);
  });
});
