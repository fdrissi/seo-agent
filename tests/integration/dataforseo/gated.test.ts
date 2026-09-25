import { afterEach, describe, expect, it } from 'vitest';
import { createDataForSeoClient } from '../../../src/integrations/dataforseo/client.js';
import { callGatedEndpoint } from '../../../src/integrations/dataforseo/gated.js';
import { fakeFetch, jsonResponse, match } from '../../helpers/fake-fetch.js';
import type { TestContext } from '../../helpers/context.js';
import { dfsConfig, dfsContext, fakeApprovals } from './helpers.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

function backlinksFetch() {
  return fakeFetch([
    match('POST', /\/v3\/backlinks\/summary\/live$/, () =>
      jsonResponse({ _synthetic: true, status_code: 20000, status_message: 'Ok.', cost: 0.024, tasks: [{ id: '00000000-0000-4000-8000-0000000bl001', status_code: 20000, status_message: 'Ok.', cost: 0.024, result: [{ target: 'example.test', backlinks: null }] }] }),
    ),
  ]);
}

describe('disabled-by-default endpoint families (backlinks, Labs, AI visibility)', () => {
  it('refuses while the feature flag is off, even with an approval gate', async () => {
    const f = backlinksFetch();
    ctx = dfsContext({ fetch: f });
    const client = createDataForSeoClient(ctx);
    const err = await callGatedEndpoint(ctx, client, { endpointKey: 'backlinks/summary/live', task: { target: 'example.test' }, maxRows: 1, purpose: 'test', approvals: fakeApprovals({ autoApprove: true }), allowPaid: true }).catch((e) => e);
    expect(err.code).toBe('INTEGRATION_DISABLED');
    expect(f.calls).toHaveLength(0);
  });

  it('with the flag on, requires an approval bound to the exact request: creates a pending request and sends nothing', async () => {
    const f = backlinksFetch();
    ctx = dfsContext({ fetch: f, config: dfsConfig({ features: { dataforseoBacklinks: true } }) });
    const client = createDataForSeoClient(ctx);
    const noGate = await callGatedEndpoint(ctx, client, { endpointKey: 'backlinks/summary/live', task: { target: 'example.test' }, maxRows: 1, purpose: 'test', approvals: undefined, allowPaid: true }).catch((e) => e);
    expect(noGate.code).toBe('APPROVAL_REQUIRED');
    const approvals = fakeApprovals();
    const r = await callGatedEndpoint(ctx, client, { endpointKey: 'backlinks/summary/live', task: { target: 'example.test' }, maxRows: 1, purpose: 'test', approvals, allowPaid: true });
    expect(r.status).toBe('approval_required');
    expect(approvals.records[0]).toMatchObject({ actionType: 'paid_request', subjectId: 'backlinks/summary/live', status: 'pending' });
    expect(f.calls).toHaveLength(0);

    // Approving the exact request lets it run once; a different request body needs its own approval.
    approvals.approve(approvals.records[0]!.id);
    const other = await callGatedEndpoint(ctx, client, { endpointKey: 'backlinks/summary/live', task: { target: 'other.test' }, maxRows: 1, purpose: 'test', approvals, allowPaid: true });
    expect(other.status).toBe('approval_required');
    const ok = await callGatedEndpoint(ctx, client, { endpointKey: 'backlinks/summary/live', task: { target: 'example.test' }, maxRows: 1, purpose: 'test', approvals, allowPaid: true });
    expect(ok.status).toBe('completed');
    expect(f.calls).toHaveLength(1);
    expect(approvals.consumed).toEqual([approvals.records[0]!.id]);
    const res = ctx.db.get<{ estimated_usd_micros: number; actual_usd_micros: number; note: string | null }>('SELECT * FROM budget_reservations')!;
    expect(res).toMatchObject({ estimated_usd_micros: 24_036, actual_usd_micros: 24_000, note: null });
    // A repeat within research.dataforseo.cacheDays.competitor reuses the stored response (no spend).
    const cached = await callGatedEndpoint(ctx, client, { endpointKey: 'backlinks/summary/live', task: { target: 'example.test' }, maxRows: 1, purpose: 'test', approvals, allowPaid: true });
    expect(cached.status).toBe('cached');
    expect(f.calls).toHaveLength(1);
    // After expiry, the executed approval cannot be reused: a new approval is required.
    ctx.clock.advanceMs(15 * 86_400_000);
    const again = await callGatedEndpoint(ctx, client, { endpointKey: 'backlinks/summary/live', task: { target: 'example.test' }, maxRows: 1, purpose: 'test', approvals, allowPaid: true });
    expect(again.status).toBe('approval_required');
    expect(f.calls).toHaveLength(1);
  });

  it('LLM mentions has no verified price: even approved, the reservation records the unknown-price approval', async () => {
    const f = fakeFetch([
      match('POST', /\/v3\/ai_optimization\/llm_mentions\/search_mentions\/live$/, () =>
        jsonResponse({ _synthetic: true, status_code: 20000, status_message: 'Ok.', cost: 0.1, tasks: [{ id: '00000000-0000-4000-8000-0000000llm01', status_code: 20000, status_message: 'Ok.', cost: 0.1, result: [] }] }),
      ),
    ]);
    ctx = dfsContext({ fetch: f, config: dfsConfig({ features: { dataforseoAiVisibility: true } }) });
    const client = createDataForSeoClient(ctx);
    const approvals = fakeApprovals({ autoApprove: true });
    const input = { endpointKey: 'ai_optimization/llm_mentions/search_mentions/live', task: { target: [{ domain: 'example.test' }], limit: 10 }, maxRows: 10, purpose: 'AI visibility pilot', approvals, allowPaid: true };
    const first = await callGatedEndpoint(ctx, client, input);
    expect(first).toMatchObject({ status: 'approval_required', estimateMicros: null });
    expect(f.calls).toHaveLength(0);
    const r = await callGatedEndpoint(ctx, client, input);
    expect(r.status).toBe('completed');
    const res = ctx.db.get<{ estimated_usd_micros: number; actual_usd_micros: number; note: string }>('SELECT * FROM budget_reservations')!;
    expect(res.note).toMatch(/unknown price approved/);
    expect(res.actual_usd_micros).toBe(100_000);
  });

  it('rejects a task limit above the approved row bound', async () => {
    ctx = dfsContext({ fetch: fakeFetch([]), config: dfsConfig({ features: { dataforseoLabsExports: true } }) });
    const client = createDataForSeoClient(ctx);
    const err = await callGatedEndpoint(ctx, client, { endpointKey: 'dataforseo_labs/google/ranked_keywords/live', task: { target: 'example.test', limit: 1000 }, maxRows: 100, purpose: 't', approvals: fakeApprovals(), allowPaid: true }).catch((e) => e);
    expect(err.code).toBe('VALIDATION_FAILED');
  });
});
