/**
 * One-time approvals (consumed BEFORE the paid POST), provider-side row
 * limits for row-priced gated endpoints, and conservative budget holds for
 * approved unknown-price requests. All data is SYNTHETIC.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createDataForSeoClient } from '../../../src/integrations/dataforseo/client.js';
import { callGatedEndpoint, type GatedCallInput } from '../../../src/integrations/dataforseo/gated.js';
import { researchSerps, unknownPriceApproval } from '../../../src/integrations/dataforseo/research.js';
import { submitPaidTasks } from '../../../src/integrations/dataforseo/tasks.js';
import { researchKeywordVolumes } from '../../../src/integrations/dataforseo/volume.js';
import { fakeFetch, jsonResponse, match, type RecordedRequest } from '../../helpers/fake-fetch.js';
import type { TestContext } from '../../helpers/context.js';
import { dfsConfig, dfsContext, fakeApprovals, fakeDataForSeo } from './helpers.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const reservations = (c: TestContext) =>
  c.db.all<{ status: string; estimated_usd_micros: number; actual_usd_micros: number | null; note: string | null }>('SELECT status, estimated_usd_micros, actual_usd_micros, note FROM budget_reservations WHERE site_id = ?', [c.siteId]);
const auditTypes = (c: TestContext) => c.db.all<{ event_type: string }>('SELECT event_type FROM audit_events WHERE site_id = ?', [c.siteId]).map((r) => r.event_type);

function liveOk(path: RegExp, cost: number, onPost?: (req: RecordedRequest) => void) {
  return match('POST', path, (req) => {
    onPost?.(req);
    return jsonResponse({ _synthetic: true, status_code: 20000, status_message: 'Ok.', cost, tasks: [{ id: '00000000-0000-4000-8000-0000000g0001', status_code: 20000, status_message: 'Ok.', cost, result: [{ synthetic: true }] }] });
  });
}

describe('approvals are consumed once, BEFORE the paid request is sent', () => {
  const backlinks = (approvals: ReturnType<typeof fakeApprovals>): GatedCallInput => ({ endpointKey: 'backlinks/summary/live', task: { target: 'example.test' }, maxRows: 1, purpose: 'synthetic test', approvals, allowPaid: true });

  it('the approval is already executed when the POST goes out', async () => {
    const approvals = fakeApprovals({ autoApprove: true });
    const seen: string[] = [];
    const f = fakeFetch([liveOk(/\/v3\/backlinks\/summary\/live$/, 0.024, () => seen.push(approvals.records[0]!.status))]);
    ctx = dfsContext({ fetch: f, config: dfsConfig({ features: { dataforseoBacklinks: true } }) });
    const client = createDataForSeoClient(ctx);
    expect((await callGatedEndpoint(ctx, client, backlinks(approvals))).status).toBe('approval_required');
    expect((await callGatedEndpoint(ctx, client, backlinks(approvals))).status).toBe('completed');
    expect(seen).toEqual(['executed']);
  });

  it('two concurrent calls holding the same approval send ONE paid request', async () => {
    const approvals = fakeApprovals({ autoApprove: true });
    const f = fakeFetch([liveOk(/\/v3\/backlinks\/summary\/live$/, 0.024)]);
    ctx = dfsContext({ fetch: f, config: dfsConfig({ features: { dataforseoBacklinks: true } }) });
    const client = createDataForSeoClient(ctx);
    await callGatedEndpoint(ctx, client, backlinks(approvals)); // creates the (auto-approved) approval
    const [a, b] = await Promise.all([callGatedEndpoint(ctx, client, backlinks(approvals)), callGatedEndpoint(ctx, client, backlinks(approvals))]);
    expect([a.status, b.status].sort()).toEqual(['approval_required', 'completed']);
    expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(approvals.consumed).toHaveLength(1);
    expect(reservations(ctx).filter((r) => r.status !== 'released')).toHaveLength(1);
  });

  it('when the approval cannot be consumed, nothing is sent and the reservation is released', async () => {
    const approvals = fakeApprovals({ autoApprove: true });
    const racing = {
      ...approvals,
      consume: () => {
        throw new Error('approval is no longer approved (synthetic race)');
      },
    };
    const f = fakeFetch([liveOk(/\/v3\/backlinks\/summary\/live$/, 0.024)]);
    ctx = dfsContext({ fetch: f, config: dfsConfig({ features: { dataforseoBacklinks: true } }) });
    const client = createDataForSeoClient(ctx);
    await callGatedEndpoint(ctx, client, backlinks(approvals));
    const err = await callGatedEndpoint(ctx, client, { ...backlinks(approvals), approvals: racing }).catch((e) => e);
    expect(err.code).toBe('APPROVAL_INVALID');
    expect(err.hint).toMatch(/new approval request/);
    expect(f.calls).toHaveLength(0);
    expect(reservations(ctx).map((r) => r.status)).toEqual(['released']);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM dataforseo_tasks')!.n).toBe(0);
    expect(ctx.db.get<{ status: string }>('SELECT status FROM provider_requests')!.status).toBe('failed');
    expect(auditTypes(ctx)).toContain('dataforseo.approval_consume_failed');
  });

  it('a request that provably was not sent records that the consumed approval was not executed; a re-run asks for a new approval', async () => {
    const approvals = fakeApprovals({ autoApprove: true });
    const f = fakeFetch([
      () => {
        throw Object.assign(new Error('connect ECONNREFUSED (synthetic)'), { code: 'ECONNREFUSED' });
      },
    ]);
    ctx = dfsContext({ fetch: f, config: dfsConfig({ features: { dataforseoBacklinks: true } }) });
    const client = createDataForSeoClient(ctx);
    await callGatedEndpoint(ctx, client, backlinks(approvals));
    const r = await callGatedEndpoint(ctx, client, backlinks(approvals));
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') throw new Error('unreachable');
    expect(r.submission.state).toBe('not_sent');
    expect(r.submission.error?.hint).toMatch(/was consumed for this attempt/);
    expect(auditTypes(ctx)).toContain('dataforseo.approval_consumed_without_execution');
    expect(reservations(ctx).map((x) => x.status)).toEqual(['released']);
    const again = await callGatedEndpoint(ctx, client, backlinks(approvals));
    expect(again.status).toBe('approval_required');
    expect(approvals.records).toHaveLength(2);
  });

  it('unknown-price SERP approvals are consumed before the POST as well', async () => {
    const approvals = fakeApprovals({ autoApprove: true });
    let statusAtPost: string | undefined;
    const fake = fakeDataForSeo({ onPost: () => (statusAtPost = approvals.records[0]!.status) });
    ctx = dfsContext({ fetch: fake.fetch, now: '2027-06-01T09:00:00.000Z' }); // documented prices are stale
    await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true, approvals });
    await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true, approvals });
    expect(fake.state.posts).toBe(1);
    expect(statusAtPost).toBe('executed');
  });
});

describe('row-priced gated endpoints: the provider enforces the row bound used for the estimate', () => {
  it('adds limit = maxRows to a Labs request that omits it (hashed, approved, and sent)', async () => {
    const bodies: string[] = [];
    const f = fakeFetch([liveOk(/\/v3\/dataforseo_labs\/google\/ranked_keywords\/live$/, 0.0126, (req) => bodies.push(req.body ?? ''))]);
    ctx = dfsContext({ fetch: f, config: dfsConfig({ features: { dataforseoLabsExports: true } }) });
    const client = createDataForSeoClient(ctx);
    const approvals = fakeApprovals({ autoApprove: true });
    const input: GatedCallInput = { endpointKey: 'dataforseo_labs/google/ranked_keywords/live', task: { target: 'example.test' }, maxRows: 5, purpose: 'synthetic', approvals, allowPaid: true };
    expect((await callGatedEndpoint(ctx, client, input)).status).toBe('approval_required');
    expect((await callGatedEndpoint(ctx, client, input)).status).toBe('completed');
    expect(JSON.parse(bodies[0]!)).toEqual([{ target: 'example.test', limit: 5 }]);
    expect(reservations(ctx)[0]!.estimated_usd_micros).toBe(12_000 + 5 * 120);
    // The caller's own task object is not mutated.
    expect(input.task).toEqual({ target: 'example.test' });
  });

  it('keeps an explicit limit within maxRows, and sends no limit to the single-row backlinks summary', async () => {
    const bodies: string[] = [];
    const f = fakeFetch([
      liveOk(/\/v3\/dataforseo_labs\/google\/ranked_keywords\/live$/, 0.0122, (req) => bodies.push(req.body ?? '')),
      liveOk(/\/v3\/backlinks\/summary\/live$/, 0.024, (req) => bodies.push(req.body ?? '')),
    ]);
    ctx = dfsContext({ fetch: f, config: dfsConfig({ features: { dataforseoLabsExports: true, dataforseoBacklinks: true } }) });
    const client = createDataForSeoClient(ctx);
    const approvals = fakeApprovals({ autoApprove: true });
    const labs: GatedCallInput = { endpointKey: 'dataforseo_labs/google/ranked_keywords/live', task: { target: 'example.test', limit: 2 }, maxRows: 5, purpose: 's', approvals, allowPaid: true };
    const summary: GatedCallInput = { endpointKey: 'backlinks/summary/live', task: { target: 'example.test' }, maxRows: 1, purpose: 's', approvals, allowPaid: true };
    for (const i of [labs, summary]) {
      await callGatedEndpoint(ctx, client, i);
      expect((await callGatedEndpoint(ctx, client, i)).status).toBe('completed');
    }
    expect(bodies.map((b) => JSON.parse(b))).toEqual([[{ target: 'example.test', limit: 2 }], [{ target: 'example.test' }]]);
  });

  it('rejects invalid row bounds before anything is requested', async () => {
    const f = fakeFetch([]);
    ctx = dfsContext({ fetch: f, config: dfsConfig({ features: { dataforseoLabsExports: true } }) });
    const client = createDataForSeoClient(ctx);
    const approvals = fakeApprovals({ autoApprove: true });
    const base = { endpointKey: 'dataforseo_labs/google/ranked_keywords/live', purpose: 's', approvals, allowPaid: true };
    for (const bad of [
      { task: { target: 'example.test' }, maxRows: 0 },
      { task: { target: 'example.test' }, maxRows: 2.5 },
      { task: { target: 'example.test' }, maxRows: Number.NaN },
      { task: { target: 'example.test', limit: 2.5 }, maxRows: 5 },
      { task: { target: 'example.test', limit: 0 }, maxRows: 5 },
      { task: { target: 'example.test', limit: '5' }, maxRows: 5 },
    ]) {
      const err = await callGatedEndpoint(ctx, client, { ...base, ...bad }).catch((e) => e);
      expect(err.code, JSON.stringify(bad)).toBe('VALIDATION_FAILED');
    }
    expect(f.calls).toHaveLength(0);
    expect(approvals.records).toHaveLength(0);
  });
});

describe('approved unknown prices still hold a conservative bound (never $0)', () => {
  it('a timed-out approved SERP request at a stale price stays reserved at the provisional bound', async () => {
    const fake = fakeDataForSeo({ postBehavior: 'timeout' });
    ctx = dfsContext({ fetch: fake.fetch, now: '2027-06-01T09:00:00.000Z' });
    const approvals = fakeApprovals({ autoApprove: true });
    const r1 = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true, approvals, requestTimeoutMs: 30 });
    expect(r1.queries[0]!.error?.code).toBe('BUDGET_UNKNOWN_PRICE');
    expect(approvals.records[0]!.summary).toMatch(/UNKNOWN price \(budget hold \$0\.0012 until reconciled\)/);
    const r2 = await researchSerps(ctx, ['synthetic widget pricing'], { allowPaid: true, approvals, requestTimeoutMs: 30 });
    expect(r2.queries[0]!.status).toBe('ambiguous');
    expect(r2.submissions[0]).toMatchObject({ state: 'ambiguous', estimatedMicros: null, reservedMicros: 1200 });
    // Last documented price $0.0006 x 1 page x2 safety factor.
    expect(reservations(ctx)).toEqual([expect.objectContaining({ status: 'unresolved', estimated_usd_micros: 1200 })]);
    const spend = ctx.budgets.report(ctx.siteId).providers.find((p) => p.provider === 'dataforseo')!;
    expect(spend.unknownCount).toBe(1);
    expect(spend.committedMicros).toBe(1200);
    expect(spend.weekly?.committedMicros).toBe(1200);
  });

  it('an approved unknown-price volume task holds its provisional bound too', async () => {
    const fake = fakeDataForSeo({ postBehavior: 'timeout' });
    ctx = dfsContext({ fetch: fake.fetch, now: '2027-06-01T09:00:00.000Z' });
    const approvals = fakeApprovals({ autoApprove: true });
    await researchKeywordVolumes(ctx, ['synthetic widget pricing'], { allowPaid: true, approvals, requestTimeoutMs: 30 });
    const r = await researchKeywordVolumes(ctx, ['synthetic widget pricing'], { allowPaid: true, approvals, requestTimeoutMs: 30 });
    expect(r.keywords[0]!.status).toBe('ambiguous');
    expect(reservations(ctx)).toEqual([expect.objectContaining({ status: 'unresolved', estimated_usd_micros: 120_000 })]);
  });

  it('LLM mentions (no verified price) hold the unverified static figures x2 until reconciled', async () => {
    const f = fakeFetch([liveOk(/\/v3\/ai_optimization\/llm_mentions\/search_mentions\/live$/, 0.05)]);
    ctx = dfsContext({ fetch: f, config: dfsConfig({ features: { dataforseoAiVisibility: true } }) });
    const client = createDataForSeoClient(ctx);
    const approvals = fakeApprovals({ autoApprove: true });
    const input: GatedCallInput = { endpointKey: 'ai_optimization/llm_mentions/search_mentions/live', task: { target: [{ domain: 'example.test' }] }, maxRows: 10, purpose: 's', approvals, allowPaid: true };
    const first = await callGatedEndpoint(ctx, client, input);
    expect(first).toMatchObject({ status: 'approval_required', estimateMicros: null });
    expect(approvals.records[0]!.summary).toMatch(/UNKNOWN price; budget hold \$0\.22 until reconciled/);
    expect((await callGatedEndpoint(ctx, client, input)).status).toBe('completed');
    expect(reservations(ctx)).toEqual([expect.objectContaining({ status: 'reconciled', estimated_usd_micros: 220_000, actual_usd_micros: 50_000 })]);
  });

  it('refuses an unknown price with no conservative bound, even when approved, and requests no approval for it', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch });
    const approvals = fakeApprovals({ autoApprove: true });
    const noBound = unknownPriceApproval(ctx, approvals, { endpoint: 'serp/google/organic/task_post', payloads: [{ keyword: 'q' }], purpose: 's', reason: 'Price unknown.', holdMicros: null });
    expect(noBound).toMatchObject({ pendingApprovalId: null });
    expect(approvals.records).toHaveLength(0);

    const client = createDataForSeoClient(ctx);
    const rec = approvals.request({ siteId: ctx.siteId, actionType: 'paid_request', target: 't', subjectType: 's', subjectId: 'x', artifactHash: 'h', summary: 's', requestedBy: 'test' });
    const err = await submitPaidTasks(ctx, client, {
      endpointKey: 'serp/google/organic/task_post',
      tasks: [{ payload: { keyword: 'q', location_code: 9990001, language_code: 'en' }, meta: { kind: 'serp', mode: 'live', queue: 'standard', purpose: 's', runId: ctx.runId }, parameterHash: 'p' }],
      estimate: { upperBoundMicros: null, basis: { source: 'unknown', detail: 'synthetic: no price' }, provisionalMicros: null },
      purpose: 's',
      allowPaid: true,
      unknownPriceApprovalId: rec.id,
      approvals,
    }).catch((e) => e);
    expect(err.code).toBe('BUDGET_UNKNOWN_PRICE');
    expect(fake.state.posts).toBe(0);
    expect(reservations(ctx)).toHaveLength(0);
    expect(approvals.consumed).toHaveLength(0);
    expect(auditTypes(ctx)).toContain('dataforseo.request_denied');
  });
});
