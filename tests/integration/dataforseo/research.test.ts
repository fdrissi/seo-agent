import { afterEach, describe, expect, it } from 'vitest';
import { competitorLimit, researchSerps, researchShortlist } from '../../../src/integrations/dataforseo/research.js';
import { competitorUrlsForSnapshot } from '../../../src/integrations/dataforseo/store.js';
import { competitorUrlsForQuery, keywordVolumeEstimates, latestOwnRank, latestSerpSnapshot, serpResultsForRecommendation } from '../../../src/integrations/dataforseo/queries.js';
import type { TestContext } from '../../helpers/context.js';
import { LOCATION, dfsConfig, dfsContext, fakeApprovals, fakeDataForSeo, insertGscQuery } from './helpers.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const count = (c: TestContext, table: string) => c.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE site_id = ?`, [c.siteId])!.n;

describe('default process: GSC shortlist -> local filtering -> serious queries -> SERP -> competitor pages', () => {
  it('filters locally, caps serious queries, researches them, and returns top-N competitor URLs', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch, config: dfsConfig({ seriousQueriesPerRun: 2 }) });
    for (const q of ['synthetic widget pricing', 'synthetic gadget review', 'synthetic low priority', 'testco login', 'site:example.test pricing']) insertGscQuery(ctx, q);
    const r = await researchShortlist(
      ctx,
      [
        { query: 'synthetic low priority', score: 1 },
        { query: 'synthetic widget pricing', score: 9 },
        { query: 'Synthetic  Widget Pricing', score: 8 },
        { query: 'testco login', score: 10 },
        { query: 'site:example.test pricing', score: 10 },
        { query: 'not in search console', score: 10 },
        { query: 'synthetic gadget review', score: 5 },
        { query: '   ', score: 3 },
      ],
      { allowPaid: true, waitMs: 60_000, sleep: async (ms) => ctx!.clock.advanceMs(ms) },
    );
    expect(r.seriousLimit).toBe(2);
    expect(r.selected.map((s) => s.query)).toEqual(['synthetic widget pricing', 'synthetic gadget review']);
    const reasons = Object.fromEntries(r.filtered.map((f) => [f.query, f.reason]));
    expect(reasons).toMatchObject({
      'Synthetic  Widget Pricing': 'duplicate',
      'testco login': 'branded',
      'site:example.test pricing': 'search_operators',
      'not in search console': 'not_in_gsc',
      'synthetic low priority': 'over_limit',
      '   ': 'empty',
    });
    expect(fake.postCalls()).toHaveLength(1);
    expect(JSON.parse(fake.postCalls()[0]!.body!)).toHaveLength(2);
    expect(r.status).toBe('completed');
    for (const q of r.queries) {
      expect(q.status).toBe('fetched');
      expect(q.ownRank).toBe(5);
      expect(q.competitorUrls.map((c) => c.url)).toEqual(['https://alpha.example/guide', 'https://beta.example/post', 'https://gamma.example/a', 'https://delta.example/b', 'https://epsilon.example/c']);
      expect(q.usableForRecommendations).toBe(true);
    }
    expect(r.competitorUrls).toHaveLength(10);
  });

  it('stores snapshots, results (own site via allowed hostnames), point-in-time rankings, keywords, competitors, and provenance', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch });
    insertGscQuery(ctx, 'synthetic widget pricing');
    ctx.db.run(`INSERT INTO pages (id, site_id, url, host, path, first_source, first_seen_at, last_seen_at) VALUES ('page_1', ?, 'https://www.example.test/pricing', 'www.example.test', '/pricing', 'crawl', ?, ?)`, [
      ctx.siteId,
      ctx.clock.now().toISOString(),
      ctx.clock.now().toISOString(),
    ]);
    await researchShortlist(ctx, ['synthetic widget pricing'], { allowPaid: true, waitMs: 30_000, sleep: async (ms) => ctx!.clock.advanceMs(ms) });
    const snap = ctx.db.get<{ id: string; is_sandbox: number; device: string; location_code: number; language_code: string; collected_at: string; items_count: number; keyword_id: string }>('SELECT * FROM serp_snapshots')!;
    expect(snap).toMatchObject({ is_sandbox: 0, device: 'desktop', location_code: LOCATION, language_code: 'en', collected_at: '2026-09-24T08:30:00.000Z', items_count: 10 });
    const own = ctx.db.all<{ url: string; rank_absolute: number }>('SELECT url, rank_absolute FROM serp_results WHERE snapshot_id = ? AND is_own_site = 1', [snap.id]);
    expect(own).toEqual([{ url: 'https://www.example.test/pricing', rank_absolute: 5 }]);
    const rank = ctx.db.get<{ rank_absolute: number; page_id: string; keyword_id: string }>('SELECT * FROM rankings')!;
    expect(rank).toMatchObject({ rank_absolute: 5, page_id: 'page_1', keyword_id: snap.keyword_id });
    expect(ctx.db.get<{ origin: string }>("SELECT origin FROM competitors WHERE domain = 'alpha.example'")!.origin).toBe('serp_discovered');
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM competitors WHERE domain = 'www.example.test'")!.n).toBe(0);
    expect(count(ctx, 'competitor_pages')).toBe(5);
    expect(ctx.db.get<{ trust_class: string; source_type: string }>('SELECT * FROM sources')).toMatchObject({ trust_class: 'third_party_data', source_type: 'dataforseo' });
    // Untrusted provider text is stored as data only.
    expect(ctx.db.get<{ title: string }>("SELECT title FROM serp_results WHERE domain = 'epsilon.example'")!.title).toMatch(/ignore previous instructions/);
    expect(latestOwnRank(ctx, 'Synthetic Widget Pricing').rank).toEqual({ status: 'observed', value: 5 });
    expect(competitorUrlsForQuery(ctx, 'synthetic widget pricing', 3)).toHaveLength(3);
  });

  it('reuses a valid cache entry before any paid request (no POST, no reservation)', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch });
    await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true, waitMs: 30_000, sleep: async (ms) => ctx!.clock.advanceMs(ms) });
    const posts = fake.state.posts;
    const res = count(ctx, 'budget_reservations');
    const r = await researchSerps(ctx, ['Synthetic widget  pricing'], { allowPaid: true });
    expect(r.queries[0]).toMatchObject({ status: 'cached', action: 'cache_hit', ownRank: 5 });
    expect(r.plan!.cacheHits).toBe(1);
    expect(r.plan!.totalEstimateMicros).toBe(0);
    expect(fake.state.posts).toBe(posts);
    expect(count(ctx, 'budget_reservations')).toBe(res);
  });

  it('cache keys include device (and locale): a mobile request is not satisfied by a desktop SERP', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch });
    await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true, waitMs: 30_000, sleep: async (ms) => ctx!.clock.advanceMs(ms) });
    const r = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true, device: 'mobile' });
    expect(r.queries[0]!.action).toBe('submit');
    expect(fake.state.posts).toBe(2);
    expect(JSON.parse(fake.postCalls()[1]!.body!)[0].device).toBe('mobile');
  });

  it('expired cache entries lead to a new (budgeted) request', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch });
    await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true, waitMs: 30_000, sleep: async (ms) => ctx!.clock.advanceMs(ms) });
    ctx.clock.advanceMs(8 * 86_400_000);
    const r = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(r.queries[0]!.action).toBe('submit');
    expect(fake.state.posts).toBe(2);
  });

  it('sandbox: sandbox host, free, flagged is_sandbox = 1, and excluded from real recommendations', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch, config: dfsConfig({ dataforseo: { mode: 'sandbox' } }) });
    const r = await researchSerps(ctx, ['synthetic widget pricing'], { waitMs: 30_000, sleep: async (ms) => ctx!.clock.advanceMs(ms) });
    expect(fake.postCalls()[0]!.url.startsWith('https://sandbox.dataforseo.com/v3/')).toBe(true);
    expect(r.isSandbox).toBe(true);
    expect(r.queries[0]).toMatchObject({ status: 'fetched', isSandbox: true, usableForRecommendations: false });
    expect(r.competitorUrls.every((c) => c.isSandbox && !c.usableForRecommendations)).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/never used in real recommendations/);
    expect(ctx.db.get<{ is_sandbox: number }>('SELECT is_sandbox FROM serp_snapshots')!.is_sandbox).toBe(1);
    expect(ctx.db.get<{ is_sandbox: number }>('SELECT is_sandbox FROM dataforseo_tasks')!.is_sandbox).toBe(1);
    expect(ctx.db.get<{ is_synthetic: number; is_paid: number }>("SELECT is_synthetic, is_paid FROM provider_requests WHERE method = 'POST'")).toMatchObject({ is_synthetic: 1, is_paid: 0 });
    expect(ctx.db.get<{ trust_class: string }>('SELECT trust_class FROM sources')!.trust_class).toBe('synthetic');
    // Free sandbox calls still go through reserve -> reconcile with a verified-zero ($0, fixed_zero) estimate;
    // no rankings/competitors (tables without a sandbox flag).
    const res = ctx.db.all<{ estimated_usd_micros: number; actual_usd_micros: number; status: string; cost_status: string; purpose: string; basis: string }>(
      "SELECT estimated_usd_micros, actual_usd_micros, status, cost_status, purpose, json_extract(price_basis_json, '$.source') AS basis FROM budget_reservations WHERE site_id = ?",
      [ctx.siteId],
    );
    expect(res).toEqual([expect.objectContaining({ estimated_usd_micros: 0, actual_usd_micros: 0, status: 'reconciled', cost_status: 'actual', basis: 'fixed_zero' })]);
    expect(res[0]!.purpose).toMatch(/^\[SYNTHETIC sandbox\] /);
    expect(count(ctx, 'rankings')).toBe(0);
    expect(count(ctx, 'competitors')).toBe(0);
    expect(count(ctx, 'competitor_pages')).toBe(0);
    // Read helpers exclude sandbox data.
    expect(latestSerpSnapshot(ctx, 'synthetic widget pricing')).toBeNull();
    expect(competitorUrlsForQuery(ctx, 'synthetic widget pricing')).toEqual([]);
    expect(latestOwnRank(ctx, 'synthetic widget pricing').rank.status).toBe('unavailable');
    const snapId = ctx.db.get<{ id: string }>('SELECT id FROM serp_snapshots')!.id;
    expect(() => serpResultsForRecommendation(ctx!, snapId)).toThrow(/sandbox/);
    expect(keywordVolumeEstimates(ctx, ['synthetic widget pricing'])[0]!.volume.status).toBe('unavailable');
  });

  it('sandbox cache never satisfies a live request', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch });
    await researchSerps(ctx, ['synthetic widget pricing'], { mode: 'sandbox', waitMs: 30_000, sleep: async (ms) => ctx!.clock.advanceMs(ms) });
    const r = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(r.isSandbox).toBe(false);
    expect(r.queries[0]!.action).toBe('submit');
    expect(fake.postCalls()[1]!.url.startsWith('https://api.dataforseo.com/v3/')).toBe(true);
  });

  it('unknown price: skipped with BUDGET_UNKNOWN_PRICE and nothing sent; an approval for the exact request lets it run', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch, now: '2027-06-01T09:00:00.000Z' }); // documented prices are stale by then
    const r = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(r.plan!.unknownPrice).toBe(true);
    expect(r.plan!.totalEstimateMicros).toBeNull();
    expect(r.queries[0]!.status).toBe('skipped');
    expect(r.queries[0]!.error?.code).toBe('BUDGET_UNKNOWN_PRICE');
    expect(fake.state.posts).toBe(0);
    expect(count(ctx, 'budget_reservations')).toBe(0);

    const approvals = fakeApprovals();
    const r2 = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true, approvals });
    expect(r2.queries[0]!.error?.code).toBe('BUDGET_UNKNOWN_PRICE');
    expect(approvals.records).toHaveLength(1);
    expect(approvals.records[0]!.status).toBe('pending');
    expect(fake.state.posts).toBe(0);
    approvals.approve(approvals.records[0]!.id);
    const r3 = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true, approvals });
    expect(r3.queries[0]!.status).toBe('pending');
    expect(fake.state.posts).toBe(1);
    expect(approvals.consumed).toEqual([approvals.records[0]!.id]);
    const res = ctx.db.get<{ note: string; actual_usd_micros: number }>('SELECT note, actual_usd_micros FROM budget_reservations')!;
    expect(res.note).toMatch(/unknown price approved/);
    expect(res.actual_usd_micros).toBe(600);
  });

  it('budget exceeded: nothing is sent and the denial is audited', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch, config: dfsConfig({ dataforseo: { serpDepth: 100 }, budgets: { dataforseo: { weeklyUsd: '0.005', monthlyUsd: '10.00', perRunUsd: '0.50' } } }) });
    const r = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(r.plan!.budgetOk).toBe(false);
    expect(r.plan!.violated?.scope).toBe('site_service_week');
    expect(r.queries[0]!.error?.code).toBe('BUDGET_EXCEEDED');
    expect(fake.state.posts).toBe(0);
    const audit = ctx.db.get<{ details_json: string }>("SELECT details_json FROM audit_events WHERE event_type = 'dataforseo.request_denied'")!;
    expect(JSON.parse(audit.details_json).code).toBe('BUDGET_EXCEEDED');
    expect(count(ctx, 'dataforseo_tasks')).toBe(0);
  });

  it('paid requests need explicit authorization and RESEARCH mode', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch });
    const r = await researchSerps(ctx, ['synthetic widget pricing'], {});
    expect(r.queries[0]!.error?.code).toBe('POLICY_DENIED');
    ctx.cleanup();
    ctx = dfsContext({ fetch: fake.fetch, mode: 'ANALYZE' });
    const r2 = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(r2.queries[0]!.error?.message).toMatch(/ANALYZE/);
    expect(fake.state.posts).toBe(0);
  });

  it('dry run: shows the plan, cache hits, and caps without any network request or write', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch, dryRun: true });
    const r = await researchSerps(ctx, ['synthetic widget pricing', 'synthetic gadget review'], { allowPaid: true });
    expect(r.status).toBe('planned');
    expect(fake.fetch.calls).toHaveLength(0);
    expect(r.plan).toMatchObject({ submissions: 2, totalEstimateMicros: 1200, budgetOk: true });
    expect(r.plan!.caps.perRun.limitMicros).toBe(500_000);
    expect(r.plan!.caps.weekly!.limitMicros).toBe(1_000_000);
    expect(r.plan!.caps.monthly.limitMicros).toBe(10_000_000);
    expect(r.settings!.verification).toBe('unverified');
    expect(count(ctx, 'dataforseo_tasks')).toBe(0);
    expect(count(ctx, 'budget_reservations')).toBe(0);
    expect(count(ctx, 'provider_requests')).toBe(0);
  });

  it('dry run with a cached SERP reports the cache hit without writing anything', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch });
    await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true, waitMs: 30_000, sleep: async (ms) => ctx!.clock.advanceMs(ms) });
    ctx.db.run('DELETE FROM competitor_pages WHERE site_id = ?', [ctx.siteId]);
    const calls = fake.fetch.calls.length;
    const r = await researchSerps(ctx, ['synthetic widget pricing', 'synthetic gadget review'], { allowPaid: true, dryRun: true });
    expect(r.plan).toMatchObject({ cacheHits: 1, submissions: 1, totalEstimateMicros: 600 });
    expect(r.queries[0]).toMatchObject({ status: 'cached', ownRank: 5 });
    expect(r.queries[0]!.competitorUrls).toHaveLength(5);
    expect(count(ctx, 'competitor_pages')).toBe(0);
    expect(fake.fetch.calls.length).toBe(calls);
  });

  it('dry run works without credentials and reports the blocker', async () => {
    ctx = dfsContext({ fetch: fakeDataForSeo().fetch, credentials: false, dryRun: true });
    const r = await researchSerps(ctx, ['synthetic widget pricing'], {});
    expect(r.status).toBe('planned');
    expect(r.blockers[0]!.code).toBe('CREDENTIALS_MISSING');
  });

  it('a real run without credentials is skipped honestly (no fake data)', async () => {
    ctx = dfsContext({ fetch: fakeDataForSeo().fetch, credentials: false });
    const r = await researchShortlist(ctx, [{ query: 'q', origin: 'owner' }], { allowOwnerQueries: true, allowPaid: true });
    expect(r.status).toBe('skipped');
    expect(r.blockers[0]!.code).toBe('CREDENTIALS_MISSING');
    expect(r.competitorUrls).toEqual([]);
  });
});

describe('competitor page limits and config warnings', () => {
  it('a non-numeric competitor count falls back to config and never registers every organic result', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch });
    const { competitorPagesPerQuery: def, competitorPagesPerQueryMax: max } = ctx.config.crawl;
    expect(competitorLimit(ctx, Number.NaN)).toBe(def);
    expect(competitorLimit(ctx, Number('abc'))).toBe(def);
    expect(competitorLimit(ctx, Number.POSITIVE_INFINITY)).toBe(def);
    expect(competitorLimit(ctx, 2.7)).toBe(Math.min(2, max));
    expect(competitorLimit(ctx, -3)).toBe(0);
    expect(competitorLimit(ctx, 10_000)).toBe(max);

    const r = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true, competitorPagesPerQuery: Number.NaN, waitMs: 30_000, sleep: async (ms) => ctx!.clock.advanceMs(ms) });
    expect(r.queries[0]!.status).toBe('fetched');
    expect(r.queries[0]!.competitorUrls).toHaveLength(Math.min(def, 5));
    expect(count(ctx, 'competitor_pages')).toBe(Math.min(def, 5));
    // Defense in depth: the store never treats NaN as "no limit".
    expect(competitorUrlsForSnapshot(ctx, r.queries[0]!.snapshotId!, Number.NaN)).toEqual([]);
  });

  it('reports unrecognized pricingOverrides keys instead of ignoring them silently', async () => {
    ctx = dfsContext({ fetch: fakeDataForSeo().fetch, config: dfsConfig({ dataforseo: { pricingOverrides: { 'serp/google/organic/standard': '0.0006' } } }), dryRun: true });
    const r = await researchSerps(ctx, ['synthetic widget pricing'], {});
    expect(r.warnings.join(' ')).toMatch(/pricingOverrides\["serp\/google\/organic\/standard"\] is not a recognized price key/);
  });
});

describe('selective research: serious-query band and justified live queue (A5-09)', () => {
  it('warns in the plan output when research.seriousQueriesPerRun is above five', async () => {
    ctx = dfsContext({ fetch: fakeDataForSeo().fetch, config: dfsConfig({ seriousQueriesPerRun: 7 }), dryRun: true });
    insertGscQuery(ctx, 'synthetic widget pricing');
    const r = await researchShortlist(ctx, ['synthetic widget pricing'], {});
    expect(r.seriousLimit).toBe(7);
    expect(r.warnings[0]).toMatch(/seriousQueriesPerRun is 7: the research process recommends three to five serious queries per run/);
    ctx.cleanup();
    ctx = dfsContext({ fetch: fakeDataForSeo().fetch, config: dfsConfig({ seriousQueriesPerRun: 5 }), dryRun: true });
    insertGscQuery(ctx, 'synthetic widget pricing');
    expect((await researchShortlist(ctx, ['synthetic widget pricing'], {})).warnings.join(' ')).not.toMatch(/seriousQueriesPerRun is/);
  });

  it('queue "live" without a justification uses the standard queue and says so; with one, the live queue is used, shown in the plan, and audited', async () => {
    const fake = fakeDataForSeo({ taskCost: 0.002 });
    ctx = dfsContext({ fetch: fake.fetch, config: dfsConfig({ dataforseo: { queue: 'live' } }) });
    const std = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(fake.postCalls()[0]!.url).toMatch(/\/serp\/google\/organic\/task_post$/);
    expect(std.plan).toMatchObject({ queue: 'standard', queueRequested: 'live', liveQueueJustification: null });
    expect(std.warnings.join(' ')).toMatch(/liveQueueJustification is empty: SERP requests use the standard queue/);
    ctx.cleanup();

    const fake2 = fakeDataForSeo({ taskCost: 0.002 });
    const why = 'Launch-day SERP check needed within minutes (synthetic)';
    ctx = dfsContext({ fetch: fake2.fetch, config: dfsConfig({ dataforseo: { queue: 'live', liveQueueJustification: `  ${why}  ` } }) });
    const live = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(fake2.postCalls()[0]!.url).toMatch(/\/serp\/google\/organic\/live\/advanced$/);
    expect(live.plan).toMatchObject({ queue: 'live', queueRequested: 'live', liveQueueJustification: why });
    expect(live.warnings.join(' ')).not.toMatch(/liveQueueJustification/);
    const audit = ctx.db.get<{ details_json: string }>("SELECT details_json FROM audit_events WHERE event_type = 'dataforseo.research_submitted'")!;
    expect(JSON.parse(audit.details_json)).toMatchObject({ queue: 'live', liveQueueJustification: why, endpoint: 'serp/google/organic/live/advanced', items: 1 });
    const pr = ctx.db.get<{ purpose: string | null }>("SELECT purpose FROM budget_reservations WHERE site_id = ? AND provider = 'dataforseo'", [ctx.siteId]);
    expect(pr?.purpose).toContain(why);
  });

  it('sandbox requests are free, so the live queue needs no justification there', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch, config: dfsConfig({ dataforseo: { mode: 'sandbox', queue: 'live' } }) });
    const r = await researchSerps(ctx, ['synthetic widget pricing'], {});
    expect(r.plan).toMatchObject({ queue: 'live', liveQueueJustification: null });
    expect(fake.postCalls()[0]!.url).toMatch(/^https:\/\/sandbox\.dataforseo\.com\/.*live\/advanced$/);
  });
});

describe('location / language resolution', () => {
  it('verifies the configured location code with the free lookup and caches the lookup', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch });
    const r = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(r.settings).toMatchObject({ locationCode: LOCATION, locationName: 'Synthetic Country', languageCode: 'en', languageName: 'English', verification: 'verified' });
    const lookups = fake.fetch.calls.filter((c) => /locations|languages/.test(c.url)).length;
    await researchSerps(ctx, ['synthetic gadget review'], { allowPaid: true });
    expect(fake.fetch.calls.filter((c) => /locations|languages/.test(c.url)).length).toBe(lookups);
  });

  it('refuses an unsupported configured location code instead of guessing', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch, config: dfsConfig({ market: { searchLocations: [{ name: 'Nowhere', locationCode: 1234567, languageCode: 'en' }], devices: ['desktop'] } }) });
    const r = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(r.status).toBe('skipped');
    expect(r.blockers.at(-1)!.code).toBe('CONFIG_INVALID');
    // The next step names a command that actually parses (positional name, not --search).
    expect(r.blockers.at(-1)!.hint).toMatch(/research locations <name> --country <iso2>/);
    expect(fake.state.posts).toBe(0);
  });

  it('resolves a location by exact unique name only; ambiguous names fail with candidates', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch, config: dfsConfig({ market: { searchLocations: [{ name: 'synthetic city,synthetic country', locationCode: null, languageCode: 'en' }], devices: ['mobile'] } }) });
    const r = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(r.settings).toMatchObject({ locationCode: 9990002, device: 'mobile', verification: 'verified' });
    ctx.cleanup();
    ctx = dfsContext({ fetch: fakeDataForSeo().fetch, config: dfsConfig({ market: { searchLocations: [{ name: 'Twin Town', locationCode: null, languageCode: 'en' }] } }) });
    const r2 = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(r2.blockers.at(-1)!.message).toMatch(/ambiguous/);
  });

  it('requires a configured research location', async () => {
    ctx = dfsContext({ fetch: fakeDataForSeo().fetch, config: dfsConfig({ market: { searchLocations: [] } }) });
    const r = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(r.blockers.at(-1)!.code).toBe('CONFIG_MISSING');
  });

  it('rejects an unsupported language code', async () => {
    ctx = dfsContext({ fetch: fakeDataForSeo().fetch, config: dfsConfig({ market: { searchLocations: [{ name: null, locationCode: LOCATION, languageCode: 'zz' }] } }) });
    const r = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(r.blockers.at(-1)!.message).toMatch(/Language code "zz"/);
  });
});
