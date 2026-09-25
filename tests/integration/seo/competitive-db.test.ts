/**
 * SYNTHETIC fixtures only (example.test / *.example.invalid): deep comparison
 * inputs from the database are scoped to ONE query and to the localized SERP
 * (location, language, device); synthetic crawls/snapshots are flagged; and
 * comparisons persist at their documented grain.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildComparisonInputs, persistComparison } from '../../../src/seo/competitive.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { SeoSeeder } from '../../fixtures/seo/seed.js';

let ctx: TestContext;
afterEach(() => ctx?.cleanup());
const HOST = 'https://www.example.test';

function setup(opts: { synthetic?: boolean } = {}): SeoSeeder {
  ctx = createTestContext();
  const seed = new SeoSeeder(ctx.db, ctx.siteId);
  const own = seed.crawl('own_site', { synthetic: opts.synthetic ?? true });
  seed.crawlResult(own, { requestedUrl: `${HOST}/guide`, headings: [{ level: 2, text: 'Widget durability tests' }] });
  return seed;
}

function snapshot(id: string, query: string, scope: { location: number | null; language: string | null; device: string; sandbox?: boolean; collectedAt?: string }, urls: string[]): void {
  ctx.db.run('INSERT INTO serp_snapshots (id, site_id, query, provider, location_code, language_code, device, parameter_hash, is_sandbox, collected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    id,
    ctx.siteId,
    query,
    'fixture',
    scope.location,
    scope.language,
    scope.device,
    `h-${id}`,
    scope.sandbox ? 1 : 0,
    scope.collectedAt ?? '2026-09-20T00:00:00.000Z',
  ]);
  urls.forEach((u, i) => ctx.db.run("INSERT INTO serp_results (snapshot_id, site_id, result_type, rank_absolute, url, is_own_site) VALUES (?, ?, 'organic', ?, ?, 0)", [id, ctx.siteId, i + 1, u]));
}

describe('buildComparisonInputs: localized SERP scope', () => {
  it('selects the snapshot of the configured location, language, and device only', () => {
    const seed = setup();
    const comp = seed.crawl('competitor');
    for (const u of ['https://a.example.invalid/w', 'https://b.example.invalid/w', 'https://c.example.invalid/w']) seed.crawlResult(comp, { requestedUrl: u, headings: [{ level: 2, text: 'Widget materials' }], query: 'widget guide' });
    snapshot('snap_ee', 'widget guide', { location: 1001, language: 'et', device: 'desktop', collectedAt: '2026-09-19T00:00:00.000Z' }, ['https://a.example.invalid/w', 'https://b.example.invalid/w']);
    // A newer snapshot for another market must not be used for the configured one.
    snapshot('snap_de', 'widget guide', { location: 2002, language: 'de', device: 'desktop', collectedAt: '2026-09-21T00:00:00.000Z' }, ['https://c.example.invalid/w']);
    const ee = buildComparisonInputs(ctx.db, ctx.raw, ctx.siteId, { ourUrl: `${HOST}/guide`, query: 'widget guide', serp: { locationCode: 1001, languageCode: 'et', device: 'desktop' } });
    expect(ee.competitors.map((c) => c.url)).toEqual(['https://a.example.invalid/w', 'https://b.example.invalid/w']);
    expect(ee.selection).toMatchObject({ method: 'serp_snapshot', serpSnapshot: { id: 'snap_ee', locationCode: 1001, languageCode: 'et', device: 'desktop', isSandbox: false } });
    const de = buildComparisonInputs(ctx.db, ctx.raw, ctx.siteId, { ourUrl: `${HOST}/guide`, query: 'widget guide', serp: { locationCode: 2002, languageCode: 'de', device: 'desktop' } });
    expect(de.competitors.map((c) => c.url)).toEqual(['https://c.example.invalid/w']);
    // No snapshot for the device: query-tagged competitor crawl results, with an honest caveat.
    const mobile = buildComparisonInputs(ctx.db, ctx.raw, ctx.siteId, { ourUrl: `${HOST}/guide`, query: 'widget guide', serp: { locationCode: 1001, languageCode: 'et', device: 'mobile' } });
    expect(mobile.selection?.method).toBe('query_tagged_crawl');
    expect(mobile.caveats.join(' ')).toMatch(/No live SERP snapshot for "widget guide" \(location 1001, language et, device mobile\)/);
    expect(mobile.caveats.join(' ')).toMatch(/SERP locality is not verified/);
  });

  it('ignores sandbox snapshots unless allowed, and then marks the comparison synthetic', () => {
    const seed = setup({ synthetic: false });
    const comp = seed.crawl('competitor', { synthetic: false });
    seed.crawlResult(comp, { requestedUrl: 'https://a.example.invalid/w', headings: [{ level: 2, text: 'Widget materials' }] });
    snapshot('snap_sb', 'widget guide', { location: 1001, language: 'et', device: 'desktop', sandbox: true }, ['https://a.example.invalid/w']);
    const live = buildComparisonInputs(ctx.db, ctx.raw, ctx.siteId, { ourUrl: `${HOST}/guide`, query: 'widget guide' });
    expect(live.selection?.serpSnapshot).toBeNull();
    expect(live.competitors).toHaveLength(0);
    expect(live.synthetic).toBe(false);
    const demo = buildComparisonInputs(ctx.db, ctx.raw, ctx.siteId, { ourUrl: `${HOST}/guide`, query: 'widget guide', allowSandbox: true });
    expect(demo.competitors).toHaveLength(1);
    expect(demo.synthetic).toBe(true);
    expect(demo.caveats.join(' ')).toMatch(/sandbox\/fixture data \(synthetic\)/);
  });
});

describe('buildComparisonInputs: one query at a time, synthetic flag', () => {
  it('never mixes competitors of different queries', () => {
    const seed = setup();
    const comp = seed.crawl('competitor');
    seed.crawlResult(comp, { requestedUrl: 'https://a.example.invalid/w', headings: [{ level: 2, text: 'Widget materials' }], query: 'widget guide', fetchedAt: '2026-09-20T00:00:00.000Z' });
    seed.crawlResult(comp, { requestedUrl: 'https://b.example.invalid/w', headings: [{ level: 2, text: 'Widget materials' }], query: 'widget guide', fetchedAt: '2026-09-20T00:00:01.000Z' });
    seed.crawlResult(comp, { requestedUrl: 'https://c.example.invalid/price', headings: [{ level: 2, text: 'Widget prices' }], query: 'widget price', fetchedAt: '2026-09-20T00:00:02.000Z' });
    seed.crawlResult(comp, { requestedUrl: 'https://d.example.invalid/any', headings: [{ level: 2, text: 'Untagged' }], fetchedAt: '2026-09-20T00:00:03.000Z' });
    const guide = buildComparisonInputs(ctx.db, ctx.raw, ctx.siteId, { ourUrl: `${HOST}/guide`, query: 'widget guide' });
    expect(guide.competitors.map((c) => c.url).sort()).toEqual(['https://a.example.invalid/w', 'https://b.example.invalid/w']);
    // Without a query: only the query of the most recent tagged result ("widget price"), never all of them.
    const noQuery = buildComparisonInputs(ctx.db, ctx.raw, ctx.siteId, { ourUrl: `${HOST}/guide` });
    expect(noQuery.query).toBe('widget price');
    expect(noQuery.competitors.map((c) => c.url)).toEqual(['https://c.example.invalid/price']);
    expect(noQuery.selection?.method).toBe('latest_query_tagged_crawl');
    expect(noQuery.caveats.join(' ')).toMatch(/never mixed/);
  });

  it('returns a synthetic flag from the crawls in scope or the context', () => {
    const seed = setup({ synthetic: false });
    const comp = seed.crawl('competitor', { synthetic: false });
    seed.crawlResult(comp, { requestedUrl: 'https://a.example.invalid/w', headings: [{ level: 2, text: 'Widget materials' }], query: 'widget guide' });
    const real = buildComparisonInputs(ctx.db, ctx.raw, ctx.siteId, { ourUrl: `${HOST}/guide`, query: 'widget guide' });
    expect(real.synthetic).toBe(false);
    expect(buildComparisonInputs(ctx.db, ctx.raw, ctx.siteId, { ourUrl: `${HOST}/guide`, query: 'widget guide', synthetic: true }).synthetic).toBe(true);
    const fixtureComp = seed.crawl('competitor');
    seed.crawlResult(fixtureComp, { requestedUrl: 'https://b.example.invalid/w', headings: [{ level: 2, text: 'Widget materials' }], query: 'widget guide' });
    const mixed = buildComparisonInputs(ctx.db, ctx.raw, ctx.siteId, { ourUrl: `${HOST}/guide`, query: 'widget guide' });
    expect(mixed.synthetic).toBe(true);
    expect(mixed.caveats.join(' ')).toMatch(/^.*SYNTHETIC: the compared pages/m);
  });
});

describe('persistComparison (competitive_comparisons)', () => {
  it('stores one row per (site, run, query, page) with advantages, gaps, caveats, synthesis status, and is_synthetic', () => {
    const seed = setup();
    const pageId = seed.page(`${HOST}/guide`);
    const comp = seed.crawl('competitor');
    seed.crawlResult(comp, { requestedUrl: 'https://a.example.invalid/w', headings: [{ level: 2, text: 'Widget materials' }], query: 'widget guide' });
    const inputs = buildComparisonInputs(ctx.db, ctx.raw, ctx.siteId, { ourUrl: `${HOST}/guide`, query: 'widget guide' });
    const now = new Date('2026-09-24T09:00:00.000Z');
    const base = { siteId: ctx.siteId, runId: 'run_1', query: 'widget guide', pageId, pageUrl: `${HOST}/guide`, inputs, now };
    persistComparison(ctx.db, { ...base, synthesis: { status: 'skipped', reason: 'synthesis skipped: no reasoning model is configured' } });
    const id = persistComparison(ctx.db, { ...base, synthesis: { status: 'skipped', reason: 'synthesis skipped: dry run' } });
    const rows = ctx.db.all<Record<string, unknown>>('SELECT * FROM competitive_comparisons WHERE site_id = ?', [ctx.siteId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, run_id: 'run_1', query: 'widget guide', page_id: pageId, competitors_compared: 1, synthesis_status: 'skipped', synthesis_reason: 'synthesis skipped: dry run', is_synthetic: 1, comparison_version: inputs.version });
    expect(JSON.parse(String(rows[0]!.our_advantages_json))).toEqual(inputs.ourAdvantages);
    expect(JSON.parse(String(rows[0]!.caveats_json)).join(' ')).toMatch(/not a ranking|no feature is claimed/);
    // Another run keeps its own row.
    persistComparison(ctx.db, { ...base, runId: 'run_2', synthesis: { status: 'skipped', reason: 'synthesis skipped: x' } });
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM competitive_comparisons WHERE site_id = ?', [ctx.siteId])!.n).toBe(2);
  });
});
