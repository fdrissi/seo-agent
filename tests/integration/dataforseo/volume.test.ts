import { afterEach, describe, expect, it } from 'vitest';
import { researchKeywordVolumes, VOLUME_LABEL } from '../../../src/integrations/dataforseo/volume.js';
import { keywordVolumeEstimates } from '../../../src/integrations/dataforseo/queries.js';
import { pollPendingTasks } from '../../../src/integrations/dataforseo/tasks.js';
import type { TestContext } from '../../helpers/context.js';
import { jsonResponse, match } from '../../helpers/fake-fetch.js';
import { clockSleep, dfsConfig, dfsContext, fakeDataForSeo } from './helpers.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

describe('Google Ads search-volume estimates via DataForSEO', () => {
  it('submits one standard task for all keywords, stores estimates, keeps missing volume missing, and caches per keyword', async () => {
    const fake = fakeDataForSeo({ taskCost: 0.06, pendingUntilReady: true, ready: false });
    ctx = dfsContext({ fetch: fake.fetch });
    const r1 = await researchKeywordVolumes(ctx, ['Synthetic Widget Pricing', 'synthetic gadget review', 'synthetic widget pricing'], { allowPaid: true });
    expect(r1.status).toBe('pending');
    expect(r1.plan).toMatchObject({ submissions: 1, totalEstimateMicros: 60_000 });
    const posts = fake.postCalls();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe('https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/task_post');
    const body = JSON.parse(posts[0]!.body!);
    expect(body).toHaveLength(1);
    expect(body[0].keywords).toEqual(['synthetic widget pricing', 'synthetic gadget review']);
    expect(body[0].location_code).toBe(9990001);

    fake.setReady(true);
    ctx.clock.advanceMs(2 * 3_600_000);
    const s = await pollPendingTasks(ctx);
    expect(s.fetched).toHaveLength(1);

    const r2 = await researchKeywordVolumes(ctx, ['synthetic widget pricing', 'synthetic gadget review'], { allowPaid: true });
    expect(fake.state.posts).toBe(1);
    const byKw = Object.fromEntries(r2.keywords.map((k) => [k.keyword, k]));
    expect(byKw['synthetic widget pricing']).toMatchObject({ status: 'cached', volume: { status: 'observed', value: 1300 }, label: VOLUME_LABEL, usableForRecommendations: true });
    expect(byKw['synthetic gadget review']!.volume.status).toBe('missing');
    const row = ctx.db.get<{ search_volume: number | null; competition: number; cpc_micros: number | null; monthly_json: string; is_sandbox: number }>(
      "SELECT m.* FROM keyword_metrics m JOIN keywords k ON k.id = m.keyword_id WHERE k.normalized = 'synthetic widget pricing'",
    )!;
    expect(row).toMatchObject({ search_volume: 1300, competition: 0.42, cpc_micros: null, is_sandbox: 0 });
    expect(JSON.parse(row.monthly_json)).toHaveLength(2);
    expect(ctx.db.get<{ search_volume: number | null }>("SELECT m.search_volume FROM keyword_metrics m JOIN keywords k ON k.id = m.keyword_id WHERE k.normalized = 'synthetic gadget review'")!.search_volume).toBeNull();
    expect(keywordVolumeEstimates(ctx, ['synthetic widget pricing'])[0]).toMatchObject({ volume: { status: 'observed', value: 1300 }, label: VOLUME_LABEL });
    // Ledger: one task at $0.06, recorded once.
    expect(ctx.db.all<{ amount_usd_micros: number }>('SELECT amount_usd_micros FROM cost_ledger')).toEqual([{ amount_usd_micros: 60_000 }]);
  });

  it('waits (free polling) and returns fetched estimates in the same call when ready', async () => {
    const fake = fakeDataForSeo({ taskCost: 0.06 });
    ctx = dfsContext({ fetch: fake.fetch });
    const r = await researchKeywordVolumes(ctx, ['synthetic widget pricing'], { allowPaid: true, waitMs: 120_000, pollIntervalMs: 30_000, sleep: clockSleep(ctx) });
    expect(r.status).toBe('completed');
    expect(r.keywords[0]).toMatchObject({ status: 'fetched', volume: { status: 'observed', value: 1300 } });
  });

  it('reuses an open task that already covers a keyword instead of paying again', async () => {
    const fake = fakeDataForSeo({ taskCost: 0.06, ready: false });
    ctx = dfsContext({ fetch: fake.fetch });
    await researchKeywordVolumes(ctx, ['synthetic widget pricing'], { allowPaid: true });
    const r = await researchKeywordVolumes(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(r.plan!.openTasks).toBe(1);
    expect(r.keywords[0]!.status).toBe('pending');
    expect(fake.state.posts).toBe(1);
  });

  it('rejects keywords the endpoint cannot take before spending (80 chars / 10 words)', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch });
    const r = await researchKeywordVolumes(ctx, ['one two three four five six seven eight nine ten eleven', 'x'.repeat(81)], { allowPaid: true });
    expect(r.keywords.every((k) => k.status === 'invalid')).toBe(true);
    expect(r.status).toBe('skipped');
    expect(fake.state.posts).toBe(0);
  });

  it('live queue uses the live endpoint (one task per call) at the live price when justified', async () => {
    const fake = fakeDataForSeo({ taskCost: 0.09 });
    ctx = dfsContext({ fetch: fake.fetch, config: dfsConfig({ dataforseo: { queue: 'live', liveQueueJustification: 'Same-day SERP answers for a synthetic launch (test)' } }) });
    const r = await researchKeywordVolumes(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(fake.postCalls()[0]!.url).toMatch(/search_volume\/live$/);
    expect(r.plan!.totalEstimateMicros).toBe(90_000);
    expect(r.plan).toMatchObject({ queue: 'live', queueRequested: 'live', liveQueueJustification: 'Same-day SERP answers for a synthetic launch (test)' });
    expect(r.keywords[0]).toMatchObject({ status: 'fetched', volume: { status: 'observed', value: 1300 } });
    const audit = ctx.db.get<{ details_json: string }>("SELECT details_json FROM audit_events WHERE event_type = 'dataforseo.research_submitted'")!;
    expect(JSON.parse(audit.details_json)).toMatchObject({ queue: 'live', liveQueueJustification: 'Same-day SERP answers for a synthetic launch (test)', endpoint: 'keywords_data/google_ads/search_volume/live' });
  });

  it('live queue without a recorded justification falls back to the standard queue with a warning', async () => {
    const fake = fakeDataForSeo({ taskCost: 0.09 });
    ctx = dfsContext({ fetch: fake.fetch, config: dfsConfig({ dataforseo: { queue: 'live' } }) });
    const r = await researchKeywordVolumes(ctx, ['synthetic widget pricing'], { allowPaid: true });
    expect(fake.postCalls()[0]!.url).toMatch(/search_volume\/task_post$/);
    expect(r.plan).toMatchObject({ queue: 'standard', queueRequested: 'live', liveQueueJustification: null });
    expect(r.warnings.join(' ')).toMatch(/liveQueueJustification is empty: keyword volume requests use the standard queue/);
    const audit = ctx.db.get<{ details_json: string }>("SELECT details_json FROM audit_events WHERE event_type = 'dataforseo.research_submitted'")!;
    expect(JSON.parse(audit.details_json)).toMatchObject({ queue: 'standard', queueRequested: 'live', liveQueueJustification: null });
  });

  it('sandbox dummy keywords that were never requested are not added to the site keyword list', async () => {
    const fake = fakeDataForSeo({
      before: [
        match('POST', /\/v3\/keywords_data\/google_ads\/search_volume\/live$/, (req) => {
          const t = JSON.parse(req.body ?? '[]')[0] as { keywords: string[]; location_code: number; language_code: string };
          const result = [
            { keyword: t.keywords[0], location_code: t.location_code, language_code: t.language_code, search_volume: 10, competition_index: 5 },
            { keyword: 'dummy sandbox keyword', location_code: t.location_code, language_code: t.language_code, search_volume: 999, competition_index: 50 },
          ];
          return jsonResponse({ _synthetic: true, status_code: 20000, status_message: 'Ok.', cost: 0, tasks: [{ id: '00000000-0000-4000-8000-0000000sb001', status_code: 20000, status_message: 'Ok.', cost: 0, data: t, result }] });
        }),
      ],
    });
    ctx = dfsContext({ fetch: fake.fetch, config: dfsConfig({ dataforseo: { mode: 'sandbox', queue: 'live' } }) });
    const r = await researchKeywordVolumes(ctx, ['Synthetic Widget Pricing'], {});
    expect(r.keywords[0]).toMatchObject({ keyword: 'synthetic widget pricing', isSandbox: true, usableForRecommendations: false });
    const kws = ctx.db.all<{ normalized: string; origins_json: string }>('SELECT normalized, origins_json FROM keywords WHERE site_id = ?', [ctx.siteId]);
    expect(kws.map((k) => k.normalized)).toEqual(['synthetic widget pricing']);
    expect(JSON.parse(kws[0]!.origins_json)).toEqual(['dataforseo_sandbox']);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM keyword_metrics WHERE site_id = ?', [ctx.siteId])!.n).toBe(1);
  });

  it('sandbox volumes are flagged and excluded from real estimates', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch, config: dfsConfig({ dataforseo: { mode: 'sandbox', queue: 'live' } }) });
    const r = await researchKeywordVolumes(ctx, ['synthetic widget pricing'], {});
    expect(fake.postCalls()[0]!.url.startsWith('https://sandbox.dataforseo.com/')).toBe(true);
    expect(r.keywords[0]).toMatchObject({ isSandbox: true, usableForRecommendations: false });
    expect(ctx.db.get<{ is_sandbox: number }>('SELECT is_sandbox FROM keyword_metrics')!.is_sandbox).toBe(1);
    expect(keywordVolumeEstimates(ctx, ['synthetic widget pricing'])[0]!.volume.status).toBe('unavailable');
    // Reserved at a verified $0 (fixed_zero) and reconciled at $0, like a paid request.
    expect(ctx.db.all('SELECT estimated_usd_micros, actual_usd_micros, status FROM budget_reservations')).toEqual([{ estimated_usd_micros: 0, actual_usd_micros: 0, status: 'reconciled' }]);
    expect(ctx.db.all('SELECT amount_usd_micros, amount_status FROM cost_ledger')).toEqual([{ amount_usd_micros: 0, amount_status: 'actual' }]);
  });
});
