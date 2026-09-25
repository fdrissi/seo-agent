import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../../src/integrations/types.js';
import { researchSerps, researchShortlist } from '../../../src/integrations/dataforseo/research.js';
import { researchKeywordVolumes } from '../../../src/integrations/dataforseo/volume.js';
import { sandboxCostEstimate } from '../../../src/integrations/dataforseo/pricing.js';
import { createSyntheticDataForSeoFetch } from '../../../src/integrations/dataforseo/synthetic.js';
import { exportDataset } from '../../../src/data/export.js';
import type { TestContext } from '../../helpers/context.js';
import { clockSleep, dfsConfig, dfsContext, fakeDataForSeo, insertGscQuery } from './helpers.js';

/**
 * Sandbox and fixture research are free, but they still go through the
 * budget path a paid request takes: a verified-zero reservation (basis
 * 'fixed_zero') BEFORE the request, then reconciliation at an actual $0.
 * The ledger entry is $0 actual and flagged synthetic; the provider request
 * is is_synthetic = 1, is_paid = 0. SYNTHETIC data only, no network.
 */

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

interface ResRow {
  id: string;
  status: string;
  cost_status: string;
  estimated_usd_micros: number;
  actual_usd_micros: number | null;
  purpose: string;
  price_basis_json: string;
  provider_request_id: string | null;
}
interface LedgerRow {
  amount_usd_micros: number | null;
  amount_status: string;
  source: string;
  usage_json: string;
  provider_request_id: string | null;
  reservation_id: string | null;
}

const reservations = (c: TestContext) => c.db.all<ResRow>("SELECT * FROM budget_reservations WHERE site_id = ? AND provider = 'dataforseo' ORDER BY created_at", [c.siteId]);
const ledger = (c: TestContext) => c.db.all<LedgerRow>("SELECT * FROM cost_ledger WHERE site_id = ? AND provider = 'dataforseo' ORDER BY recorded_at", [c.siteId]);
const auditTypes = (c: TestContext) => c.db.all<{ event_type: string }>("SELECT event_type FROM audit_events WHERE site_id = ? AND event_type LIKE 'budget.%' ORDER BY id", [c.siteId]).map((r) => r.event_type);

describe('sandbox/fixture DataForSEO research goes through reserve -> reconcile at a verified $0', () => {
  it('fixture mode (offline demo transport): $0 fixed_zero reservation exists BEFORE the POST, then is reconciled at $0 actual, flagged synthetic', async () => {
    ctx = dfsContext({ credentials: false }); // offline: only the in-process synthetic transport is allowed
    insertGscQuery(ctx, 'synthetic widget pricing', { isSynthetic: false });
    const synthetic = createSyntheticDataForSeoFetch({ ownUrl: 'https://www.example.test/pricing', ownRank: 3 });
    const atPost: ResRow[][] = [];
    const fetch: FetchLike = async (input, init) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') atPost.push(reservations(ctx!));
      return synthetic(input, init);
    };
    const r = await researchShortlist(ctx, ['synthetic widget pricing'], { mode: 'fixture', fetch, waitMs: 30_000, sleep: clockSleep(ctx) });
    expect(r.status).toBe('completed');
    expect(r.plan).toMatchObject({ isSandbox: true, totalEstimateMicros: 0, unknownPrice: false, budgetOk: true });

    // Reserved before anything was sent.
    expect(atPost).toHaveLength(1);
    expect(atPost[0]).toEqual([expect.objectContaining({ status: 'reserved', cost_status: 'estimated', estimated_usd_micros: 0 })]);

    const [res] = reservations(ctx);
    expect(reservations(ctx)).toHaveLength(1);
    expect(res).toMatchObject({ status: 'reconciled', cost_status: 'actual', estimated_usd_micros: 0, actual_usd_micros: 0 });
    expect(res!.purpose).toMatch(/^\[SYNTHETIC fixture\] SERP research/);
    expect(JSON.parse(res!.price_basis_json)).toEqual(sandboxCostEstimate('fixture').basis);
    expect(JSON.parse(res!.price_basis_json).source).toBe('fixed_zero');

    const [entry] = ledger(ctx);
    expect(ledger(ctx)).toHaveLength(1);
    expect(entry).toMatchObject({ amount_usd_micros: 0, amount_status: 'actual', source: 'computed_from_usage', reservation_id: res!.id, provider_request_id: res!.provider_request_id });
    expect(JSON.parse(entry!.usage_json)).toMatchObject({ synthetic: true, mode: 'fixture', priceBasis: 'fixed_zero', outcome: 'accepted' });
    const preq = ctx.db.get<{ is_synthetic: number; is_paid: number; reservation_id: string | null }>('SELECT is_synthetic, is_paid, reservation_id FROM provider_requests WHERE id = ?', [res!.provider_request_id]);
    expect(preq).toEqual({ is_synthetic: 1, is_paid: 0, reservation_id: res!.id });
    expect(auditTypes(ctx)).toEqual(['budget.reserved', 'budget.reconciled']);

    // The spend report shows $0 actual, nothing reserved, nothing unknown.
    const dfs = ctx.budgets.report(ctx.siteId).providers.find((p) => p.provider === 'dataforseo')!;
    expect(dfs).toMatchObject({ actualMicros: 0, reservedMicros: 0, unknownCount: 0 });

    // Keyword volumes (the other paid endpoint family) take the same path.
    const v = await researchKeywordVolumes(ctx, ['synthetic widget pricing'], { mode: 'fixture', fetch, waitMs: 30_000, sleep: clockSleep(ctx) });
    expect(v.keywords[0]!.status).toBe('fetched');
    expect(reservations(ctx).map((x) => [x.status, x.estimated_usd_micros, x.actual_usd_micros])).toEqual([
      ['reconciled', 0, 0],
      ['reconciled', 0, 0],
    ]);
    expect(ledger(ctx).every((l) => l.amount_usd_micros === 0 && l.amount_status === 'actual' && JSON.parse(l.usage_json).synthetic === true)).toBe(true);

    // C5-07: the verified $0 is a fixed zero, never "computed from usage at list price" (report, notes, export).
    const rep = ctx.budgets.report(ctx.siteId);
    expect(rep.costBasis.find((b) => b.provider === 'dataforseo')).toMatchObject({ computedMicros: 0, computedCount: 0, fixedZeroCount: 2 });
    expect(rep.notes.some((n) => n.startsWith('Computed'))).toBe(false);
    expect(rep.notes.some((n) => n.startsWith('Fixed zero, not computed: dataforseo 2 request(s)'))).toBe(true);
    expect(exportDataset(ctx, 'costs').rows.map((x) => x.amount_basis)).toEqual(['fixed_zero', 'fixed_zero']);
  });

  it('sandbox host: a sample cost in the synthetic response is kept for audit only; the actual is $0', async () => {
    const fake = fakeDataForSeo({ taskCost: 0.0006 });
    ctx = dfsContext({ fetch: fake.fetch, config: dfsConfig({ dataforseo: { mode: 'sandbox' } }) });
    const r = await researchSerps(ctx, ['synthetic widget pricing'], { waitMs: 30_000, sleep: clockSleep(ctx) });
    expect(r.queries[0]).toMatchObject({ status: 'fetched', isSandbox: true, usableForRecommendations: false });
    expect(r.submissions[0]).toMatchObject({ state: 'accepted', estimatedMicros: 0, reservedMicros: 0, actualMicros: 0 });
    expect(reservations(ctx)).toEqual([expect.objectContaining({ status: 'reconciled', estimated_usd_micros: 0, actual_usd_micros: 0 })]);
    const usage = JSON.parse(ledger(ctx)[0]!.usage_json);
    expect(usage).toMatchObject({ synthetic: true, mode: 'sandbox', priceBasis: 'fixed_zero', reportedTaskCostsMicros: [600] });
    expect(ledger(ctx)[0]).toMatchObject({ amount_usd_micros: 0, amount_status: 'actual' });
  });

  it('an ambiguous sandbox submission is still $0 (a sandbox never charges): reconciled, never an unknown charge', async () => {
    const fake = fakeDataForSeo({ postBehavior: 'timeout' });
    ctx = dfsContext({ fetch: fake.fetch, config: dfsConfig({ dataforseo: { mode: 'sandbox' } }) });
    const r = await researchSerps(ctx, ['synthetic widget pricing'], { requestTimeoutMs: 30 });
    expect(r.submissions[0]!.state).toBe('ambiguous');
    expect(ctx.db.get<{ status: string }>('SELECT status FROM dataforseo_tasks')!.status).toBe('ambiguous');
    expect(reservations(ctx)).toEqual([expect.objectContaining({ status: 'reconciled', cost_status: 'actual', actual_usd_micros: 0 })]);
    expect(JSON.parse(ledger(ctx)[0]!.usage_json)).toMatchObject({ synthetic: true, outcome: 'ambiguous' });
    expect(ctx.budgets.report(ctx.siteId).providers.find((p) => p.provider === 'dataforseo')).toMatchObject({ unknownCount: 0, reservedMicros: 0, actualMicros: 0 });
  });

  it('a rejected sandbox request releases its $0 reservation (no ledger charge)', async () => {
    const fake = fakeDataForSeo({ postBehavior: 'http401' });
    ctx = dfsContext({ fetch: fake.fetch, config: dfsConfig({ dataforseo: { mode: 'sandbox' } }) });
    const r = await researchSerps(ctx, ['synthetic widget pricing'], {});
    expect(r.submissions[0]!.state).toBe('rejected');
    expect(reservations(ctx)).toEqual([expect.objectContaining({ status: 'released', estimated_usd_micros: 0 })]);
    expect(ledger(ctx)).toEqual([]);
  });

  it('the reservation is real: a sandbox request is refused like any other while a limit is already overspent', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch, config: dfsConfig({ dataforseo: { mode: 'sandbox' } }) });
    // A synthetic earlier live charge that overshot its estimate beyond the monthly limit.
    const monthly = ctx.settings.budgets.dataforseo.monthly;
    const perRun = ctx.settings.budgets.dataforseo.perRun;
    const prior = ctx.budgets.reserve({ siteId: ctx.siteId, provider: 'dataforseo', runId: 'synthetic-prior', purpose: 'synthetic prior charge (test)', estimate: { upperBoundMicros: Math.min(perRun, monthly), basis: { source: 'verified_config', detail: 'synthetic' } } });
    ctx.budgets.reconcile(prior.id, { actualMicros: monthly + 1, source: 'manual' });

    const r = await researchSerps(ctx, ['synthetic widget pricing'], {});
    expect(r.plan!.budgetOk).toBe(false);
    expect(r.queries[0]!.error?.code).toBe('BUDGET_EXCEEDED');
    expect(fake.state.posts).toBe(0);
    // Only the synthetic prior charge exists: the refused sandbox request left no reservation behind.
    expect(reservations(ctx).map((x) => x.id)).toEqual([prior.id]);
  });

  it('paid (live) requests are unchanged: documented, non-zero estimate reconciled at the provider-reported cost', async () => {
    const fake = fakeDataForSeo({ taskCost: 0.0006 });
    ctx = dfsContext({ fetch: fake.fetch });
    await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true });
    const [res] = reservations(ctx);
    expect(res).toMatchObject({ estimated_usd_micros: 600, actual_usd_micros: 600, status: 'reconciled' });
    expect(res!.purpose).not.toMatch(/SYNTHETIC/);
    expect(JSON.parse(res!.price_basis_json).source).toBe('documented');
    expect(ledger(ctx)[0]).toMatchObject({ amount_usd_micros: 600, source: 'provider_reported' });
    expect(JSON.parse(ledger(ctx)[0]!.usage_json).synthetic).toBeUndefined();
  });
});
