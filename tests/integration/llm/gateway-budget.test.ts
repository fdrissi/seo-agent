import { afterEach, describe, expect, it } from 'vitest';
import type { TestContext } from '../../helpers/context.js';
import { listLlmCalls } from '../../../src/integrations/llm/records.js';
import type { FetchLike } from '../../../src/integrations/types.js';
import { BASE, VALID_CLASSIFICATION, chatCompletion, classifyRequest, fakeGateway, gatewayError, llmTestContext, rows, testClient } from './harness.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

describe('LLM budget enforcement', () => {
  it('reserves a conservative upper bound before the call and reconciles to the reported cost', async () => {
    let reservedDuringCall: Array<{ status: string; estimated_usd_micros: number }> = [];
    const gw = fakeGateway({
      chat: [
        () => {
          reservedDuringCall = ctx!.db.all('SELECT status, estimated_usd_micros FROM budget_reservations');
          return chatCompletion(VALID_CLASSIFICATION);
        },
      ],
    });
    ctx = llmTestContext({ fetch: gw.fetch });
    const r = await testClient(ctx, gw).structured(classifyRequest(ctx));
    expect(r.ok).toBe(true);
    // The reservation existed (status reserved) while the request was in flight.
    expect(reservedDuringCall).toHaveLength(1);
    expect(reservedDuringCall[0]!.status).toBe('reserved');
    // Upper bound includes max_tokens (1500) x $0.60/1M = 900 micros of output alone.
    expect(reservedDuringCall[0]!.estimated_usd_micros).toBeGreaterThan(900);
    const after = rows<{ status: string; actual_usd_micros: number; price_basis_json: string }>(ctx, 'SELECT * FROM budget_reservations');
    expect(after[0]!.status).toBe('reconciled');
    expect(after[0]!.actual_usd_micros).toBe(228);
    const basis = JSON.parse(after[0]!.price_basis_json);
    expect(basis.source).toBe('provider_api');
    expect(basis.detail).toContain('1500 max output tok');
    const report = ctx.budgets.report(ctx.siteId).providers.find((p) => p.provider === 'llm_gateway')!;
    expect(report.actualMicros).toBe(228);
    expect(report.reservedMicros).toBe(0);
  });

  it('returns budget_exceeded (no request sent) when the per-run cap would be exceeded', async () => {
    const gw = fakeGateway();
    ctx = llmTestContext({ fetch: gw.fetch, budgets: { llmGateway: { monthlyUsd: '5.00', perRunUsd: '0.0001' } } });
    const r = await testClient(ctx, gw).structured(classifyRequest(ctx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('budget_exceeded');
    expect(r.reason).toContain('No request was sent');
    expect(r.nextStep).toMatch(/No automatic budget increases/);
    expect(gw.chatBodies).toHaveLength(0);
    expect(rows(ctx, 'SELECT * FROM budget_reservations')).toHaveLength(0);
    // Note: BudgetService writes 'budget.denied' inside the transaction that then throws (rolled back; reported
    // as a foundation change request), so the LLM client records its own 'llm.skipped' audit event outside it.
    expect(rows(ctx, "SELECT * FROM audit_events WHERE event_type = 'llm.skipped'")).toHaveLength(1);
    expect(listLlmCalls(ctx.db, ctx.siteId)).toHaveLength(0);
  });

  it('stops a repair loop honestly when the budget runs out mid-way', async () => {
    const gw = fakeGateway({ chat: [() => chatCompletion('not json', { usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0.003 } })] });
    // Each upper bound is ~0.0013; the per-run cap fits one reservation (reconciled at 0.003) but not a second.
    ctx = llmTestContext({ fetch: gw.fetch, budgets: { llmGateway: { monthlyUsd: '5.00', perRunUsd: '0.004' } } });
    const r = await testClient(ctx, gw).structured(classifyRequest(ctx));
    expect(r.ok === false && r.status).toBe('budget_exceeded');
    expect(gw.chatBodies).toHaveLength(1);
  });

  it('parallel requests reserve atomically against the per-run cap and share one catalog lookup', async () => {
    const gw = fakeGateway({ chat: Array.from({ length: 4 }, () => () => chatCompletion(VALID_CLASSIFICATION, { usage: null })) });
    ctx = llmTestContext({ fetch: gw.fetch, budgets: { llmGateway: { monthlyUsd: '5.00', perRunUsd: '0.0025' } } });
    const client = testClient(ctx, gw);
    const results = await Promise.all([1, 2, 3, 4].map(() => client.structured(classifyRequest(ctx!))));
    const ok = results.filter((r) => r.ok).length;
    const exceeded = results.filter((r) => !r.ok && r.status === 'budget_exceeded').length;
    expect(ok + exceeded).toBe(4);
    expect(exceeded).toBeGreaterThan(0);
    expect(ok).toBeGreaterThan(0);
    expect(gw.chatBodies).toHaveLength(ok); // skipped requests were never sent
    // Unknown actual cost keeps each estimate reserved; the committed total never exceeds the cap.
    const committed = rows<{ total: number }>(ctx, "SELECT SUM(estimated_usd_micros) AS total FROM budget_reservations WHERE status IN ('reserved', 'unresolved')")[0]!.total;
    expect(committed).toBeLessThanOrEqual(2_500);
    expect(gw.modelsRequests).toHaveLength(1);
  });

  it('skips a model without a verified price as budget_unknown_price', async () => {
    const gw = fakeGateway();
    ctx = llmTestContext({ fetch: gw.fetch, models: { cheap: 'synthetic-unpriced' } });
    const r = await testClient(ctx, gw).structured(classifyRequest(ctx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('budget_unknown_price');
    expect(r.reason).toContain('cannot establish a safe cost upper bound');
    expect(gw.chatBodies).toHaveLength(0);
    expect(rows(ctx, 'SELECT * FROM budget_reservations')).toHaveLength(0);
  });

  it('an unverified approval id does not unlock an unknown-price request (see gateway-approvals.test.ts)', async () => {
    const gw = fakeGateway({ chat: [() => chatCompletion(VALID_CLASSIFICATION, { model: 'synthetic-unpriced' })] });
    ctx = llmTestContext({ fetch: gw.fetch, models: { cheap: 'synthetic-unpriced' } });
    const r = await testClient(ctx, gw).structured(classifyRequest(ctx, { unknownPriceApprovalId: 'appr_synthetic_1' }));
    expect(r.ok === false && r.status).toBe('budget_unknown_price');
    expect(gw.chatBodies).toHaveLength(0);
    expect(rows(ctx, 'SELECT * FROM budget_reservations')).toHaveLength(0);
  });

  it('uses llm.pricingOverrides as the verified price when the catalog has none', async () => {
    const gw = fakeGateway({ chat: [() => chatCompletion(VALID_CLASSIFICATION, { model: 'synthetic-unpriced', usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } })] });
    ctx = llmTestContext({ fetch: gw.fetch, models: { cheap: 'synthetic-unpriced' }, llm: { pricingOverrides: { 'synthetic-unpriced': { inputPerMillionUsd: '1.00', outputPerMillionUsd: '2.00' } } } });
    const r = await testClient(ctx, gw).structured(classifyRequest(ctx));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.costMicros).toBe(1000 + 200);
    const basis = JSON.parse(rows<{ price_basis_json: string }>(ctx, 'SELECT price_basis_json FROM budget_reservations')[0]!.price_basis_json);
    expect(basis.source).toBe('verified_config');
  });

  it('a timeout after submission marks the reservation unresolved, the request ambiguous, and is never retried', async () => {
    const gw = fakeGateway();
    let chatPosts = 0;
    const hanging: FetchLike = (input, init) => {
      if (String(input) === `${BASE}/chat/completions`) {
        chatPosts++;
        return new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new Error('aborted')), { once: true });
        });
      }
      return gw.fetch(input, init);
    };
    ctx = llmTestContext({ fetch: hanging });
    const r = await testClient(ctx, gw, { fetch: hanging, timeoutMs: 50 }).structured(classifyRequest(ctx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('provider_error');
    expect(r.ambiguous).toBe(true);
    expect(r.reason).toMatch(/timed out/);
    // The next step is the audited reconcile command for THIS reservation (not just a listing).
    expect(r.reservationId).toBeTruthy();
    expect(r.nextStep).toContain(`npm run cli -- costs reconcile ${r.reservationId} --actual-usd <amount from the usage log> --evidence`);
    expect(r.nextStep).toContain('--not-charged');
    expect(r.nextStep).toMatch(/do not resubmit blindly/);
    expect(chatPosts).toBe(1);
    const res = rows<{ status: string; cost_status: string; estimated_usd_micros: number }>(ctx, 'SELECT status, cost_status, estimated_usd_micros FROM budget_reservations');
    expect(res).toHaveLength(1);
    expect(res[0]!.status).toBe('unresolved');
    expect(res[0]!.cost_status).toBe('unknown');
    const preq = rows<{ status: string }>(ctx, "SELECT status FROM provider_requests WHERE endpoint = 'chat.completions'");
    expect(preq).toEqual([{ status: 'ambiguous' }]);
    const c = listLlmCalls(ctx.db, ctx.siteId)[0]!;
    expect(c.status).toBe('ambiguous');
    expect(c.cost_usd_micros).toBeNull();
    expect(c.cost_status).toBe('unknown');
    // Unresolved charges stay reserved at their estimate until reconciled.
    const report = ctx.budgets.report(ctx.siteId).providers.find((p) => p.provider === 'llm_gateway')!;
    expect(report.reservedMicros).toBe(res[0]!.estimated_usd_micros);
    expect(report.unknownCount).toBe(1);
    expect(ctx.budgets.listUnresolved(ctx.siteId)).toHaveLength(1);
    // The suggested command applies to this reservation: a named human settles it from the usage log.
    expect(ctx.budgets.listUnresolved(ctx.siteId)[0]!.id).toBe(r.reservationId);
    expect(ctx.budgets.reconcileManual(r.reservationId!, { actualMicros: 1200, evidence: 'Synthetic usage log line for this request', by: 'Test Owner' })).toMatchObject({ status: 'reconciled', previousStatus: 'unresolved' });
  });

  it('treats a TimeoutError thrown by fetch as ambiguous too', async () => {
    const gw = fakeGateway({ chat: [() => Promise.reject(Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }))] });
    ctx = llmTestContext({ fetch: gw.fetch });
    const r = await testClient(ctx, gw).structured(classifyRequest(ctx));
    expect(r.ok === false && r.ambiguous).toBe(true);
    expect(rows<{ status: string }>(ctx, 'SELECT status FROM budget_reservations')).toEqual([{ status: 'unresolved' }]);
  });

  it('releases the reservation when the request provably never reached the gateway', async () => {
    const gw = fakeGateway({ chat: [() => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))] });
    ctx = llmTestContext({ fetch: gw.fetch });
    const r = await testClient(ctx, gw).structured(classifyRequest(ctx));
    expect(r.ok === false && r.status).toBe('provider_error');
    expect(r.ok === false && r.ambiguous).toBeFalsy();
    expect(rows<{ status: string }>(ctx, 'SELECT status FROM budget_reservations')).toEqual([{ status: 'released' }]);
    expect(rows<{ status: string }>(ctx, "SELECT status FROM provider_requests WHERE endpoint = 'chat.completions'")).toEqual([{ status: 'failed' }]);
  });

  it('keeps 5xx/504 outcomes unresolved and releases 429 rate limits (both without retry)', async () => {
    const gw = fakeGateway({
      chat: [
        () => gatewayError(504, 'Upstream timed out', 'timeout_error', 'timeout'),
        () => gatewayError(502, 'All providers failed', 'upstream_error', 'all_providers_failed'),
        () => gatewayError(429, 'Rate limit exceeded', 'rate_limit_error', 'rate_limit_exceeded', { 'retry-after': '7' }),
      ],
    });
    ctx = llmTestContext({ fetch: gw.fetch });
    const client = testClient(ctx, gw);
    const a = await client.structured(classifyRequest(ctx));
    const b = await client.structured(classifyRequest(ctx));
    const c = await client.structured(classifyRequest(ctx));
    expect([a, b, c].map((x) => (x.ok ? 'ok' : x.status))).toEqual(['provider_error', 'provider_error', 'provider_error']);
    expect(a.ok === false && a.ambiguous).toBe(true);
    expect(b.ok === false && b.ambiguous).toBe(true);
    expect(c.ok === false && c.ambiguous).toBeFalsy();
    expect(c.ok === false && c.nextStep).toContain('7s');
    // 5xx/504 (billing not guaranteed) name the reconcile command for their own reservation.
    for (const x of [a, b]) {
      if (x.ok) continue;
      expect(x.nextStep).toContain(`npm run cli -- costs reconcile ${x.reservationId} `);
      expect(x.nextStep).toContain('Billing state is not guaranteed');
    }
    expect(c.ok === false && c.nextStep).not.toContain('costs reconcile');
    expect(rows<{ status: string }>(ctx, 'SELECT status FROM budget_reservations ORDER BY created_at, rowid').map((x) => x.status)).toEqual(['unresolved', 'unresolved', 'released']);
    expect(gw.chatBodies).toHaveLength(3);
  });

  it('dry run sends nothing and reserves nothing', async () => {
    const gw = fakeGateway();
    ctx = llmTestContext({ fetch: gw.fetch, dryRun: true });
    const r = await testClient(ctx, gw).structured(classifyRequest(ctx));
    expect(r.ok === false && r.status).toBe('disabled');
    expect(r.ok === false && r.reason).toMatch(/Dry run: would call synthetic-cheap-structured/);
    expect(gw.chatBodies).toHaveLength(0);
    expect(rows(ctx, 'SELECT * FROM budget_reservations')).toHaveLength(0);
  });

  it('enforces an explicit per-request cap before reserving', async () => {
    const gw = fakeGateway();
    ctx = llmTestContext({ fetch: gw.fetch });
    const r = await testClient(ctx, gw, { maxCostPerRequestMicros: 10 }).structured(classifyRequest(ctx));
    expect(r.ok === false && r.status).toBe('budget_exceeded');
    expect(r.ok === false && r.reason).toContain('exceeds the explicit cap of $0.00001');
    expect(gw.chatBodies).toHaveLength(0);
  });

  it('reports missing credentials, missing model ids, disabled features, and offline mode honestly without network', async () => {
    const gw = fakeGateway();
    ctx = llmTestContext({ fetch: gw.fetch, secrets: { LLM_GATEWAY_API_KEY: '' } });
    const noKey = await testClient(ctx, gw).structured(classifyRequest(ctx));
    expect(noKey.ok === false && noKey.status).toBe('not_configured');
    expect(noKey.ok === false && noKey.nextStep).toContain('secrets.env');
    ctx.cleanup();

    ctx = llmTestContext({ fetch: gw.fetch, models: { cheap: null } });
    const noModel = await testClient(ctx, gw).structured(classifyRequest(ctx));
    expect(noModel.ok === false && noModel.status).toBe('not_configured');
    expect(noModel.ok === false && noModel.reason).toContain('CHEAP_MODEL');
    ctx.cleanup();

    ctx = llmTestContext({ fetch: gw.fetch, features: { llm: false } });
    const disabled = await testClient(ctx, gw).structured(classifyRequest(ctx));
    expect(disabled.ok === false && disabled.status).toBe('disabled');
    ctx.cleanup();

    ctx = llmTestContext();
    const offline = await testClient(ctx, gw).structured(classifyRequest(ctx));
    expect(offline.ok === false && offline.status).toBe('disabled');
    expect(offline.ok === false && offline.reason).toContain('offline');
    expect(gw.fetch.calls).toHaveLength(0);
  });
});

describe('capability-driven parameters', () => {
  it('uses JSON mode plus the schema in the system prompt for a model without native structured outputs', async () => {
    const gw = fakeGateway({ chat: [() => chatCompletion(VALID_CLASSIFICATION, { model: 'synthetic-json-only' })] });
    ctx = llmTestContext({ fetch: gw.fetch, models: { cheap: 'synthetic-json-only' } });
    const r = await testClient(ctx, gw).structured(classifyRequest(ctx));
    expect(r.ok).toBe(true);
    const body = gw.chatBodies[0];
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.temperature).toBe(0);
    expect(body.messages[0].content).toContain('JSON Schema "Classification"');
    expect(body.messages[0].content).toContain('"evidence_ids"');
    expect(listLlmCalls(ctx.db, ctx.siteId)[0]!.response_format).toBe('json_object');
  });

  it('uses prompt-constrained JSON and omits temperature for a model that supports neither', async () => {
    const gw = fakeGateway({ chat: [() => chatCompletion('Here you go:\n' + VALID_CLASSIFICATION, { model: 'synthetic-plain' })] });
    ctx = llmTestContext({ fetch: gw.fetch, models: { cheap: 'synthetic-plain' } });
    const r = await testClient(ctx, gw).structured(classifyRequest(ctx));
    expect(r.ok).toBe(true);
    const body = gw.chatBodies[0];
    expect(body.response_format).toBeUndefined();
    expect('temperature' in body).toBe(false);
    expect(body.messages[0].content).toContain('OUTPUT FORMAT');
    const params = JSON.parse(listLlmCalls(ctx.db, ctx.siteId)[0]!.params_json!);
    expect(params.omitted).toEqual(expect.arrayContaining([expect.objectContaining({ param: 'temperature' })]));
    expect(params.responseFormat).toBe('prompt');
  });

  it('never sends temperature to a reasoning model that does not list it, budgets reasoning tokens, and sends reasoning_effort only when accepted', async () => {
    const gw = fakeGateway({
      chat: [
        () => chatCompletion(VALID_CLASSIFICATION, { model: 'synthetic-reasoner', usage: { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1200, completion_tokens_details: { reasoning_tokens: 200 }, cost: 0.0042 } }),
        () => chatCompletion(VALID_CLASSIFICATION, { model: 'synthetic-reasoner' }),
      ],
    });
    ctx = llmTestContext({ fetch: gw.fetch });
    const client = testClient(ctx, gw, { temperature: { reasoning: 0.2 }, reasoningEffort: { reasoning: 'medium' } });
    const r = await client.structured(classifyRequest(ctx, { tier: 'reasoning' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.usage.reasoningTokens).toBe(200);
    const body = gw.chatBodies[0];
    expect('temperature' in body).toBe(false);
    expect(body.reasoning_effort).toBe('medium');
    expect(body.max_tokens).toBe(6000);
    const res = rows<{ estimated_usd_micros: number }>(ctx, 'SELECT estimated_usd_micros FROM budget_reservations ORDER BY created_at, rowid');
    // Output 6000 + reasoning allowance 6000 tokens at $8/1M = 96,000 micros before input.
    expect(res[0]!.estimated_usd_micros).toBeGreaterThan(96_000);

    const client2 = testClient(ctx, gw, { reasoningEffort: { reasoning: 'xhigh' } });
    await client2.structured(classifyRequest(ctx, { tier: 'reasoning' }));
    expect(gw.chatBodies[1].reasoning_effort).toBeUndefined();
    const params = JSON.parse(listLlmCalls(ctx.db, ctx.siteId).find((c) => c.provider_request_id && JSON.parse(c.params_json!).omitted.length)!.params_json!);
    expect(params.omitted).toEqual(expect.arrayContaining([expect.objectContaining({ param: 'reasoning_effort' })]));
  });

  it('clamps max_tokens to the model max_output and never sends reasoning_effort to a non-reasoning model', async () => {
    const gw = fakeGateway({ chat: [() => chatCompletion('Summary text.', { model: 'synthetic-plain' })] });
    ctx = llmTestContext({ fetch: gw.fetch, models: { reasoning: 'synthetic-plain' } });
    const r = await testClient(ctx, gw, { reasoningEffort: { reasoning: 'high' } }).text({ siteId: ctx.siteId, runId: ctx.runId, role: 'synthesizer', tier: 'reasoning', promptId: 'test.summarize', variables: { site_name: 'x' }, evidence: [] });
    expect(r.ok).toBe(true);
    expect(gw.chatBodies[0].max_tokens).toBe(2048);
    expect(gw.chatBodies[0].reasoning_effort).toBeUndefined();
  });
});
