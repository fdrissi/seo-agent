/**
 * Unknown-price approvals, reasoning bounds, and paid-request timeouts for the
 * LLM Gateway client (spec sections 25 and 31). SYNTHETIC fake gateway and an
 * in-memory approval gate; no real network, credentials, or model ids.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TestContext } from '../../helpers/context.js';
import { jsonResponse } from '../../helpers/fake-fetch.js';
import { AppError } from '../../../src/core/errors.js';
import type { ApprovalActionType, ApprovalCheck, ApprovalGate, ApprovalRecord, ApprovalRequestInput } from '../../../src/approvals/types.js';
import { ApprovalService } from '../../../src/approvals/service.js';
import { requestPaidRequestApproval } from '../../../src/approvals/budget-approvals.js';
import { DEFAULT_PAID_REQUEST_TIMEOUT_MS, GATEWAY_NON_STREAMING_TIMEOUT_MS } from '../../../src/integrations/llm/gateway.js';
import { VALID_CLASSIFICATION, catalogJson, chatCompletion, classifyRequest, fakeGateway, llmTestContext, rows, testClient } from './harness.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
  vi.restoreAllMocks();
});

/** In-memory ApprovalGate with the same semantics as the approvals contract (bound, single-use). */
class MemoryApprovalGate implements ApprovalGate {
  readonly records: Array<ApprovalRecord & { payload?: Record<string, unknown> }> = [];
  readonly consumed: string[] = [];
  private n = 0;

  request(input: ApprovalRequestInput): ApprovalRecord {
    const live = this.records.find((r) => this.sameBinding(r, input) && r.artifactHash === input.artifactHash && (r.status === 'pending' || r.status === 'approved'));
    if (live) return live;
    const rec: ApprovalRecord & { payload?: Record<string, unknown> } = {
      id: `appr_mem_${++this.n}`,
      siteId: input.siteId,
      actionType: input.actionType,
      target: input.target,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      artifactHash: input.artifactHash,
      sourceRevision: null,
      summary: input.summary,
      status: 'pending',
      requestedBy: input.requestedBy,
      requestedAt: '2026-09-24T09:00:00.000Z',
      approver: null,
      decidedAt: null,
      expiresAt: '2026-09-25T09:00:00.000Z',
      executedAt: null,
      ...(input.payload ? { payload: input.payload } : {}),
    };
    this.records.push(rec);
    return rec;
  }

  private sameBinding(r: ApprovalRecord, i: { siteId: string; actionType: ApprovalActionType; subjectType: string; subjectId: string }): boolean {
    return r.siteId === i.siteId && r.actionType === i.actionType && r.subjectType === i.subjectType && r.subjectId === i.subjectId;
  }

  check(input: { siteId: string; actionType: ApprovalActionType; subjectType: string; subjectId: string; artifactHash: string }): ApprovalCheck {
    const same = this.records.filter((r) => this.sameBinding(r, input));
    if (!same.length) return { ok: false, reason: 'none' };
    const exact = same.filter((r) => r.artifactHash === input.artifactHash);
    if (!exact.length) return { ok: false, reason: 'hash_mismatch' };
    const approved = exact.find((r) => r.status === 'approved');
    if (approved) return { ok: true, approval: approved };
    const latest = exact[exact.length - 1]!;
    return { ok: false, reason: latest.status === 'executed' ? 'already_executed' : latest.status === 'pending' ? 'pending' : 'rejected', approval: latest };
  }

  consume(approvalId: string): ApprovalRecord {
    const r = this.records.find((x) => x.id === approvalId);
    if (!r || r.status !== 'approved') throw new AppError('APPROVAL_INVALID', `Approval ${approvalId} cannot be executed`);
    r.status = 'executed';
    r.executedAt = '2026-09-24T09:00:00.000Z';
    this.consumed.push(approvalId);
    return r;
  }

  approve(id: string): void {
    const r = this.records.find((x) => x.id === id)!;
    r.status = 'approved';
    r.approver = 'Pat Example (synthetic)';
    r.decidedAt = '2026-09-24T09:00:00.000Z';
  }
}

const MAX = 50_000; // $0.05 proposed maximum charge (synthetic)

describe('unknown-price approvals (spec 25: require approval or skip)', () => {
  it('rejects a made-up approval id when no approval gate is wired (an id alone authorizes nothing)', async () => {
    const gw = fakeGateway({ chat: [() => chatCompletion(VALID_CLASSIFICATION)] });
    ctx = llmTestContext({ fetch: gw.fetch, models: { cheap: 'synthetic-unpriced' } });
    const r = await testClient(ctx, gw).structured(classifyRequest(ctx, { unknownPriceApprovalId: 'totally-made-up', unknownPriceMaxChargeMicros: MAX }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('budget_unknown_price');
    expect(r.reason).toContain('no approval gate is wired');
    expect(gw.chatBodies).toHaveLength(0);
    expect(rows(ctx, 'SELECT * FROM budget_reservations')).toHaveLength(0);
  });

  it('rejects a made-up approval id against the approval gate and sends nothing', async () => {
    const gw = fakeGateway({ chat: [() => chatCompletion(VALID_CLASSIFICATION)] });
    ctx = llmTestContext({ fetch: gw.fetch, models: { cheap: 'synthetic-unpriced' } });
    const gate = new MemoryApprovalGate();
    const r = await testClient(ctx, gw, { approvals: gate }).structured(classifyRequest(ctx, { unknownPriceApprovalId: 'totally-made-up', unknownPriceMaxChargeMicros: MAX }));
    expect(r.ok === false && r.status).toBe('budget_unknown_price');
    expect(r.ok === false && r.reason).toContain('does not authorize this exact request');
    expect(gw.chatBodies).toHaveLength(0);
    expect(rows(ctx, 'SELECT * FROM budget_reservations')).toHaveLength(0);
    expect(gate.consumed).toHaveLength(0);
    expect(rows(ctx, "SELECT * FROM audit_events WHERE event_type = 'llm.unknown_price_approval_refused'")).toHaveLength(1);
  });

  it('without a proposed maximum charge the request is skipped and no approval is requested', async () => {
    const gw = fakeGateway();
    ctx = llmTestContext({ fetch: gw.fetch, models: { cheap: 'synthetic-unpriced' } });
    const gate = new MemoryApprovalGate();
    const r = await testClient(ctx, gw, { approvals: gate }).structured(classifyRequest(ctx));
    expect(r.ok === false && r.status).toBe('budget_unknown_price');
    expect(r.ok === false && r.reason).toContain('explicit maximum charge');
    expect(gate.records).toHaveLength(0);
    expect(gw.chatBodies).toHaveLength(0);
  });

  it('requests an approval bound to the exact request, then uses it once for exactly one request, reserving the approved maximum', async () => {
    let n = 0;
    const randomBoundary = () => `bRANDOM${String(++n).padStart(20, '0')}`;
    const gw = fakeGateway({ chat: [() => chatCompletion(VALID_CLASSIFICATION, { model: 'synthetic-unpriced', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })] });
    ctx = llmTestContext({ fetch: gw.fetch, models: { cheap: 'synthetic-unpriced' } });
    const gate = new MemoryApprovalGate();
    const client = testClient(ctx, gw, { approvals: gate, boundaryToken: randomBoundary });

    // 1. Proposed maximum, no approval yet: a pending approval is requested; nothing is sent.
    const first = await client.structured(classifyRequest(ctx, { unknownPriceMaxChargeMicros: MAX }));
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.status).toBe('budget_unknown_price');
    expect(first.approvalId).toBe('appr_mem_1');
    expect(first.approvalRequestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.nextStep).toContain('appr_mem_1');
    expect(gate.records[0]!.status).toBe('pending');
    expect(gate.records[0]!.subjectId).toBe(first.approvalRequestHash);
    expect(gate.records[0]!.payload).toMatchObject({ provider: 'llm_gateway', endpoint: 'chat.completions', maxChargeMicros: MAX });
    expect(gw.chatBodies).toHaveLength(0);

    // 2. Still pending: refused.
    const pending = await client.structured(classifyRequest(ctx, { unknownPriceApprovalId: 'appr_mem_1', unknownPriceMaxChargeMicros: MAX }));
    expect(pending.ok === false && pending.reason).toContain('pending');
    expect(gw.chatBodies).toHaveLength(0);

    // 3. Approved by a human: the same logical request (new random boundary) is sent exactly once.
    gate.approve('appr_mem_1');
    const r = await client.structured(classifyRequest(ctx, { unknownPriceApprovalId: 'appr_mem_1', unknownPriceMaxChargeMicros: MAX }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.costMicros).toBeNull(); // unknown, never $0
    expect(gw.chatBodies).toHaveLength(1);
    expect(gate.consumed).toEqual(['appr_mem_1']);
    const res = rows<{ status: string; note: string; estimated_usd_micros: number }>(ctx, 'SELECT status, note, estimated_usd_micros FROM budget_reservations');
    expect(res).toHaveLength(1);
    expect(res[0]!.estimated_usd_micros).toBe(MAX); // the approved maximum is reserved, not $0
    expect(res[0]!.status).toBe('unresolved');
    expect(res[0]!.note).toContain('appr_mem_1');
    const report = ctx.budgets.report(ctx.siteId).providers.find((p) => p.provider === 'llm_gateway')!;
    expect(report.committedMicros).toBe(MAX);

    // 4. Single use: the same approval cannot authorize another request.
    const again = await client.structured(classifyRequest(ctx, { unknownPriceApprovalId: 'appr_mem_1', unknownPriceMaxChargeMicros: MAX }));
    expect(again.ok === false && again.status).toBe('budget_unknown_price');
    expect(again.ok === false && again.reason).toContain('already_executed');
    expect(gw.chatBodies).toHaveLength(1);

    // 5. A different maximum charge is a different proposal.
    const otherMax = await client.structured(classifyRequest(ctx, { unknownPriceApprovalId: 'appr_mem_1', unknownPriceMaxChargeMicros: MAX + 1 }));
    expect(otherMax.ok === false && otherMax.reason).toContain('hash_mismatch');
    expect(gw.chatBodies).toHaveLength(1);
  });

  it('an approval for one request does not authorize a different request (other evidence)', async () => {
    const gw = fakeGateway();
    ctx = llmTestContext({ fetch: gw.fetch, models: { cheap: 'synthetic-unpriced' } });
    const gate = new MemoryApprovalGate();
    const client = testClient(ctx, gw, { approvals: gate });
    await client.structured(classifyRequest(ctx, { unknownPriceMaxChargeMicros: MAX }));
    gate.approve('appr_mem_1');
    const other = await client.structured(
      classifyRequest(ctx, { unknownPriceApprovalId: 'appr_mem_1', unknownPriceMaxChargeMicros: MAX, evidence: [{ id: 'ev-2', label: 'other', text: 'Different synthetic evidence.', trustClass: 'first_party_measurement' }] }),
    );
    expect(other.ok === false && other.status).toBe('budget_unknown_price');
    expect(other.ok === false && other.reason).toContain('none');
    expect(gw.chatBodies).toHaveLength(0);
    expect(gate.consumed).toHaveLength(0);
  });

  it('unknown-price calls make exactly one request: no repair attempts and no tool rounds', async () => {
    const gw = fakeGateway({ chat: [() => chatCompletion('not json at all', { model: 'synthetic-unpriced' })] });
    ctx = llmTestContext({ fetch: gw.fetch, models: { cheap: 'synthetic-unpriced' } });
    const gate = new MemoryApprovalGate();
    const client = testClient(ctx, gw, { approvals: gate });
    await client.structured(classifyRequest(ctx, { unknownPriceMaxChargeMicros: MAX, tools: ['get_site_profile'] }));
    gate.approve('appr_mem_1');
    const r = await client.structured(classifyRequest(ctx, { unknownPriceApprovalId: 'appr_mem_1', unknownPriceMaxChargeMicros: MAX, tools: ['get_site_profile'] }));
    expect(r.ok === false && r.status).toBe('needs_review');
    expect(gw.chatBodies).toHaveLength(1);
    expect(gw.chatBodies[0].tools).toBeUndefined();
  });

  it('is compatible with paid_request approvals from the approvals service (src/approvals/budget-approvals.ts)', async () => {
    const gw = fakeGateway({ chat: [() => chatCompletion(VALID_CLASSIFICATION, { model: 'synthetic-unpriced', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.00001 } })] });
    ctx = llmTestContext({ fetch: gw.fetch, models: { cheap: 'synthetic-unpriced' } });
    const service = new ApprovalService(ctx.db, { clock: ctx.clock });
    const client = testClient(ctx, gw, { approvals: service });
    const first = await client.structured(classifyRequest(ctx, { unknownPriceMaxChargeMicros: MAX }));
    if (first.ok || !first.approvalId || !first.approvalRequestHash) throw new Error('expected a pending approval');
    // The approvals slice's own paid_request binding resolves to the same live approval.
    const same = requestPaidRequestApproval(service, { siteId: ctx.siteId, provider: 'llm_gateway', endpoint: 'chat.completions', requestHash: first.approvalRequestHash, purpose: 'synthetic', maxChargeMicros: MAX, requestedBy: 'system' });
    expect(same.id).toBe(first.approvalId);
    service.approve(ctx.siteId, first.approvalId, { approver: 'Pat Example', confirmHashPrefix: same.artifactHash.slice(0, 12) });
    const r = await client.structured(classifyRequest(ctx, { unknownPriceApprovalId: first.approvalId, unknownPriceMaxChargeMicros: MAX }));
    expect(r.ok).toBe(true);
    expect(rows<{ status: string }>(ctx, 'SELECT status FROM approvals WHERE id = ?', [first.approvalId])[0]!.status).toBe('executed');
    const again = await client.structured(classifyRequest(ctx, { unknownPriceApprovalId: first.approvalId, unknownPriceMaxChargeMicros: MAX }));
    expect(again.ok === false && again.status).toBe('budget_unknown_price');
    expect(gw.chatBodies).toHaveLength(1);
  });

  it('embeddings: unknown price needing several requests is refused up front; one approved request reserves the maximum', async () => {
    const catalog = catalogJson();
    const embed = catalog.data.find((m) => m.id === 'synthetic-embed-small')!;
    embed.pricing = {};
    for (const p of embed.providers as Array<Record<string, unknown>>) p.pricing = {};
    const vec = [0.1, 0.2, 0.3, 0.4];
    const gw = fakeGateway({ models: catalog, embeddings: [() => jsonResponse({ data: [{ index: 0, embedding: vec }], model: 'synthetic-embed-small', usage: { prompt_tokens: 3, total_tokens: 3 } })] });
    ctx = llmTestContext({ fetch: gw.fetch });
    const gate = new MemoryApprovalGate();
    const client = testClient(ctx, gw, { approvals: gate, embedBatchSize: 1 });
    const many = await client.embed({ siteId: ctx.siteId, runId: ctx.runId, texts: ['alpha', 'beta'], unknownPriceMaxChargeMicros: MAX });
    expect(many.ok === false && many.status).toBe('budget_unknown_price');
    expect(many.ok === false && many.reason).toContain('2 requests');
    expect(gate.records).toHaveLength(0);
    const first = await client.embed({ siteId: ctx.siteId, runId: ctx.runId, texts: ['alpha'], unknownPriceMaxChargeMicros: MAX });
    expect(first.ok === false && first.approvalId).toBe('appr_mem_1');
    gate.approve('appr_mem_1');
    const r = await client.embed({ siteId: ctx.siteId, runId: ctx.runId, texts: ['alpha'], unknownPriceApprovalId: 'appr_mem_1', unknownPriceMaxChargeMicros: MAX });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.costMicros).toBeNull();
    expect(rows<{ estimated_usd_micros: number }>(ctx, 'SELECT estimated_usd_micros FROM budget_reservations')).toEqual([{ estimated_usd_micros: MAX }]);
    expect(gate.consumed).toEqual(['appr_mem_1']);
    expect(gw.embedBodies).toHaveLength(1);
  });
});

describe('reasoning token bounds (spec 25: conservative upper bound including reasoning)', () => {
  it('labels the reasoning allowance as an assumption when no request field bounds it, and sends no reasoning object', async () => {
    const gw = fakeGateway({ chat: [() => chatCompletion(VALID_CLASSIFICATION, { model: 'synthetic-reasoner' })] });
    ctx = llmTestContext({ fetch: gw.fetch });
    const r = await testClient(ctx, gw).structured(classifyRequest(ctx, { tier: 'reasoning' }));
    expect(r.ok).toBe(true);
    expect(gw.chatBodies[0].reasoning).toBeUndefined();
    const basis = JSON.parse(rows<{ price_basis_json: string }>(ctx, 'SELECT price_basis_json FROM budget_reservations')[0]!.price_basis_json);
    expect(basis.detail).toContain('ASSUMPTION');
    expect(basis.detail).toContain('6000-token reasoning allowance');
  });

  it('sends reasoning.max_tokens (with the effort inside, never both forms) for configured providers', async () => {
    const gw = fakeGateway({ chat: [() => chatCompletion(VALID_CLASSIFICATION, { model: 'synthetic-reasoner' })] });
    ctx = llmTestContext({ fetch: gw.fetch });
    const r = await testClient(ctx, gw, { reasoningMaxTokensProviders: ['prov-a'], reasoningEffort: { reasoning: 'medium' } }).structured(classifyRequest(ctx, { tier: 'reasoning' }));
    expect(r.ok).toBe(true);
    const body = gw.chatBodies[0];
    expect(body.reasoning).toEqual({ effort: 'medium', max_tokens: 6000 });
    expect(body.reasoning_effort).toBeUndefined();
    const basis = JSON.parse(rows<{ price_basis_json: string }>(ctx, 'SELECT price_basis_json FROM budget_reservations')[0]!.price_basis_json);
    expect(basis.detail).toContain('reasoning.max_tokens=6000');
    expect(basis.detail).not.toContain('ASSUMPTION');
  });

  it("with unboundedReasoning='require_approval' an assumed reasoning bound counts as no safe bound (skipped)", async () => {
    const gw = fakeGateway();
    ctx = llmTestContext({ fetch: gw.fetch });
    const r = await testClient(ctx, gw, { unboundedReasoning: 'require_approval' }).structured(classifyRequest(ctx, { tier: 'reasoning' }));
    expect(r.ok === false && r.status).toBe('budget_unknown_price');
    expect(gw.chatBodies).toHaveLength(0);
    expect(rows(ctx, 'SELECT * FROM budget_reservations')).toHaveLength(0);
  });

  it('a non-reasoning model has no reasoning allowance and no assumption note', async () => {
    const gw = fakeGateway({ chat: [() => chatCompletion(VALID_CLASSIFICATION)] });
    ctx = llmTestContext({ fetch: gw.fetch });
    await testClient(ctx, gw, { unboundedReasoning: 'require_approval' }).structured(classifyRequest(ctx));
    expect(gw.chatBodies).toHaveLength(1);
    const basis = JSON.parse(rows<{ price_basis_json: string }>(ctx, 'SELECT price_basis_json FROM budget_reservations')[0]!.price_basis_json);
    expect(basis.detail).not.toContain('reasoning allowance');
  });
});

describe('paid request timeouts', () => {
  it('waits a little longer than the gateway 10-minute non-streaming limit on paid POSTs; free GETs use llm.requestTimeoutMs', async () => {
    expect(DEFAULT_PAID_REQUEST_TIMEOUT_MS).toBeGreaterThan(GATEWAY_NON_STREAMING_TIMEOUT_MS);
    const gw = fakeGateway({ chat: [() => chatCompletion(VALID_CLASSIFICATION)] });
    ctx = llmTestContext({ fetch: gw.fetch });
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const client = testClient(ctx, gw);
    const r = await client.structured(classifyRequest(ctx));
    expect(r.ok).toBe(true);
    const delays = spy.mock.calls.map((c) => c[1]);
    expect(delays).toContain(ctx.config.llm.requestTimeoutMs); // GET /v1/models
    expect(delays).toContain(DEFAULT_PAID_REQUEST_TIMEOUT_MS); // POST /chat/completions
  });
});
