import { afterEach, describe, expect, it } from 'vitest';
import type { TestContext } from '../../helpers/context.js';
import { listLlmCalls } from '../../../src/integrations/llm/records.js';
import {
  BASE,
  TEST_KEY,
  VALID_CLASSIFICATION,
  chatCompletion,
  classifyRequest,
  fakeGateway,
  gatewayError,
  llmTestContext,
  rows,
  testClient,
} from './harness.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

describe('LLM Gateway structured outputs (synthetic fake gateway)', () => {
  it('returns a schema-valid value and records prompt version, model, usage, gateway cost, reservation and request log', async () => {
    const gw = fakeGateway({ chat: [() => chatCompletion(VALID_CLASSIFICATION)] });
    ctx = llmTestContext({ fetch: gw.fetch });
    const r = await testClient(ctx, gw).structured(classifyRequest(ctx));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ intent: 'commercial', confidence: 0.8, evidence_ids: ['ev-1'] });
    expect(r.promptVersion).toMatch(/^test\.classify@3\+[0-9a-f]{8}$/);
    expect(r.repairAttempts).toBe(0);
    expect(r.usage).toEqual({ inputTokens: 1200, outputTokens: 80, reasoningTokens: null });
    expect(r.costMicros).toBe(228); // usage.cost 0.000228 USD reported by the gateway
    expect(r.model).toBe('prov-a/synthetic-cheap-structured');

    // Request shape: bearer auth, native json_schema (model supports structured outputs), token ceiling, temperature supported.
    const chatReq = gw.fetch.calls.find((c) => c.url === `${BASE}/chat/completions`)!;
    expect(chatReq.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    const body = gw.chatBodies[0];
    expect(body.model).toBe('synthetic-cheap-structured');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.name).toBe('Classification');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.required).toEqual(['intent', 'confidence', 'evidence_ids']);
    expect(body.max_tokens).toBe(1500);
    expect(body.temperature).toBe(0);
    expect(body.tools).toBeUndefined();

    const calls = listLlmCalls(ctx.db, ctx.siteId);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.id).toBe(r.callId);
    expect(c.prompt_version).toBe(r.promptVersion);
    expect(c.model_requested).toBe('synthetic-cheap-structured');
    expect(c.model_returned).toBe('prov-a/synthetic-cheap-structured');
    expect(c.trace_id).toMatch(/^trace_/);
    expect(c.cost_usd_micros).toBe(228);
    expect(c.cost_status).toBe('actual');
    expect(c.validation_status).toBe('valid');
    expect(c.status).toBe('succeeded');
    expect(c.schema_name).toBe('Classification');
    expect(c.max_output_tokens).toBe(1500);
    expect(c.evidence_bundle_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.response_format).toBe('json_schema');
    expect(c.is_synthetic).toBe(0);
    const params = JSON.parse(c.params_json!);
    expect(params.systemPrompts[0]).toMatch(/^system\.untrusted-data@2\+[0-9a-f]{8}$/);
    expect(params.estimate.upperBoundMicros).toBeGreaterThan(0);

    const res = rows<{ status: string; estimated_usd_micros: number; actual_usd_micros: number; provider: string; run_id: string }>(ctx, 'SELECT * FROM budget_reservations WHERE site_id = ?', [ctx.siteId]);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ status: 'reconciled', actual_usd_micros: 228, provider: 'llm_gateway', run_id: ctx.runId });
    expect(res[0]!.estimated_usd_micros).toBeGreaterThanOrEqual(228);

    const preq = rows<{ status: string; is_paid: number; external_id: string; endpoint: string }>(ctx, "SELECT * FROM provider_requests WHERE site_id = ? AND endpoint = 'chat.completions'", [ctx.siteId]);
    expect(preq).toEqual([expect.objectContaining({ status: 'succeeded', is_paid: 1, external_id: 'req-synthetic-1' })]);
    const ledger = rows<{ amount_usd_micros: number; source: string }>(ctx, 'SELECT * FROM cost_ledger WHERE site_id = ?', [ctx.siteId]);
    expect(ledger).toEqual([expect.objectContaining({ amount_usd_micros: 228, source: 'gateway_reported' })]);
  });

  it('repairs malformed output within the configured attempts, budgeting every attempt', async () => {
    const gw = fakeGateway({
      chat: [
        () => chatCompletion('Sure! Here is the answer: {"intent": "commercial", "confidence": 1.7'),
        () => chatCompletion(JSON.stringify({ intent: 'buying', confidence: 0.5, evidence_ids: [] })),
        () => chatCompletion('```json\n' + VALID_CLASSIFICATION + '\n```'),
      ],
    });
    ctx = llmTestContext({ fetch: gw.fetch });
    const r = await testClient(ctx, gw).structured(classifyRequest(ctx));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.repairAttempts).toBe(2);
    expect(r.costMicros).toBe(228 * 3);
    expect(gw.chatBodies).toHaveLength(3);
    // The repair turn sends the validation errors back and keeps the same system policy.
    const repairUser = gw.chatBodies[1].messages.at(-1);
    expect(repairUser.role).toBe('user');
    expect(repairUser.content).toContain('failed validation');
    expect(repairUser.content).toContain('not valid JSON');
    const secondRepair = gw.chatBodies[2].messages.at(-1).content as string;
    expect(secondRepair).toMatch(/intent/);
    expect(secondRepair).toContain('repair attempt 2 of 2');
    expect(gw.chatBodies[1].messages[0].content.startsWith(gw.chatBodies[0].messages[0].content)).toBe(true);

    const calls = listLlmCalls(ctx.db, ctx.siteId).sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0));
    expect(calls.map((c) => [c.attempt, c.repair_attempts, c.validation_status, c.status])).toEqual([
      [1, 0, 'invalid', 'invalid_output'],
      [2, 1, 'invalid', 'invalid_output'],
      [3, 2, 'repaired', 'succeeded'],
    ]);
    expect(new Set(calls.map((c) => c.call_group_id)).size).toBe(1);
    const res = rows<{ status: string }>(ctx, 'SELECT status FROM budget_reservations WHERE site_id = ?', [ctx.siteId]);
    expect(res.map((x) => x.status)).toEqual(['reconciled', 'reconciled', 'reconciled']);
  });

  it('stops after at most 2 repair attempts and returns needs_review with the last raw output', async () => {
    const bad = () => chatCompletion('{"intent": "unknown-intent"}');
    const gw = fakeGateway({ chat: [bad, bad, bad, bad] });
    ctx = llmTestContext({ fetch: gw.fetch });
    const r = await testClient(ctx, gw).structured(classifyRequest(ctx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('needs_review');
    expect(r.lastRawOutput).toContain('unknown-intent');
    expect(gw.chatBodies).toHaveLength(3); // 1 initial + 2 repairs, never more
    const calls = listLlmCalls(ctx.db, ctx.siteId);
    expect(calls.filter((c) => c.status === 'needs_review')).toHaveLength(1);
    const audit = rows<{ event_type: string }>(ctx, "SELECT event_type FROM audit_events WHERE site_id = ? AND event_type = 'llm.needs_review'", [ctx.siteId]);
    expect(audit).toHaveLength(1);
  });

  it('respects llm.maxRepairAttempts below the hard maximum', async () => {
    const bad = () => chatCompletion('not json');
    const gw = fakeGateway({ chat: [bad, bad, bad] });
    ctx = llmTestContext({ fetch: gw.fetch, llm: { maxRepairAttempts: 1 } });
    const r = await testClient(ctx, gw).structured(classifyRequest(ctx));
    expect(r.ok).toBe(false);
    expect(gw.chatBodies).toHaveLength(2);
  });

  it('missing usage in the response gives unknown cost (null), never $0, and keeps the reservation unresolved', async () => {
    const gw = fakeGateway({ chat: [() => chatCompletion(VALID_CLASSIFICATION, { usage: null })] });
    ctx = llmTestContext({ fetch: gw.fetch });
    const r = await testClient(ctx, gw).structured(classifyRequest(ctx));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.costMicros).toBeNull();
    expect(r.usage).toEqual({ inputTokens: null, outputTokens: null, reasoningTokens: null });
    const c = listLlmCalls(ctx.db, ctx.siteId)[0]!;
    expect(c.cost_usd_micros).toBeNull();
    expect(c.cost_status).toBe('unknown');
    expect(c.input_tokens).toBeNull();
    const res = rows<{ status: string; cost_status: string; actual_usd_micros: number | null }>(ctx, 'SELECT status, cost_status, actual_usd_micros FROM budget_reservations WHERE site_id = ?', [ctx.siteId]);
    expect(res).toEqual([{ status: 'unresolved', cost_status: 'unknown', actual_usd_micros: null }]);
    const ledger = rows<{ amount_usd_micros: number | null; amount_status: string }>(ctx, 'SELECT amount_usd_micros, amount_status FROM cost_ledger WHERE site_id = ?', [ctx.siteId]);
    expect(ledger).toEqual([{ amount_usd_micros: null, amount_status: 'unknown' }]);
    const report = ctx.budgets.report(ctx.siteId).providers.find((p) => p.provider === 'llm_gateway')!;
    expect(report.unknownCount).toBe(1);
    expect(report.reservedMicros).toBeGreaterThan(0);
  });

  it('computes cost from reported token usage and verified catalog prices when usage.cost is absent', async () => {
    const gw = fakeGateway({ chat: [() => chatCompletion(VALID_CLASSIFICATION, { usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } })] });
    ctx = llmTestContext({ fetch: gw.fetch });
    const r = await testClient(ctx, gw).structured(classifyRequest(ctx));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 1000 x $0.15/1M + 100 x $0.60/1M = $0.00015 + $0.00006 = 210 micros
    expect(r.costMicros).toBe(210);
    const c = listLlmCalls(ctx.db, ctx.siteId)[0]!;
    expect(c.cost_status).toBe('estimated');
    const ledger = rows<{ source: string; amount_usd_micros: number }>(ctx, 'SELECT source, amount_usd_micros FROM cost_ledger WHERE site_id = ?', [ctx.siteId]);
    expect(ledger).toEqual([{ source: 'computed_from_usage', amount_usd_micros: 210 }]);
  });

  it('rejects an invalid model id with invalid_model and a next step, without calling chat or guessing a substitute', async () => {
    const gw = fakeGateway();
    ctx = llmTestContext({ fetch: gw.fetch, models: { cheap: 'synthetic-cheap-structurd' } });
    const r = await testClient(ctx, gw).structured(classifyRequest(ctx));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe('invalid_model');
    expect(r.reason).toContain('synthetic-cheap-structurd');
    expect(r.reason).toContain('NOT substituted automatically');
    expect(r.nextStep).toContain('models list');
    expect(gw.chatBodies).toHaveLength(0);
    expect(rows(ctx, 'SELECT * FROM budget_reservations')).toHaveLength(0);
  });

  it('rejects deactivated and embedding models for chat', async () => {
    const gw = fakeGateway();
    ctx = llmTestContext({ fetch: gw.fetch, models: { cheap: 'synthetic-deactivated', reasoning: 'synthetic-embed-small' } });
    const client = testClient(ctx, gw);
    const a = await client.structured(classifyRequest(ctx));
    expect(a.ok === false && a.status).toBe('invalid_model');
    expect(a.ok === false && a.reason).toContain('deactivated');
    const b = await client.text({ siteId: ctx.siteId, runId: ctx.runId, role: 'synthesizer', tier: 'reasoning', promptId: 'test.summarize', variables: { site_name: 'Example (synthetic)' }, evidence: [] });
    expect(b.ok === false && b.status).toBe('invalid_model');
    expect(gw.chatBodies).toHaveLength(0);
  });

  it('maps a gateway 404 model_not_found to invalid_model and releases the reservation', async () => {
    const gw = fakeGateway({ chat: [() => gatewayError(404, 'Model synthetic-cheap-structured not found', 'not_found', 'model_not_found')] });
    ctx = llmTestContext({ fetch: gw.fetch });
    const r = await testClient(ctx, gw).structured(classifyRequest(ctx));
    expect(r.ok === false && r.status).toBe('invalid_model');
    const res = rows<{ status: string }>(ctx, 'SELECT status FROM budget_reservations');
    expect(res).toEqual([{ status: 'released' }]);
    expect(gw.chatBodies).toHaveLength(1); // never retried
  });

  it('maps 401 usage-limit to budget_exceeded and 401 invalid key to not_configured', async () => {
    const gw = fakeGateway({
      chat: [
        () => gatewayError(401, 'Unauthorized: LLMGateway API key reached its usage limit.', 'invalid_request_error', 'invalid_api_key'),
        () => gatewayError(401, 'Invalid API key', 'invalid_request_error', 'invalid_api_key'),
      ],
    });
    ctx = llmTestContext({ fetch: gw.fetch });
    const client = testClient(ctx, gw);
    const a = await client.structured(classifyRequest(ctx));
    expect(a.ok === false && a.status).toBe('budget_exceeded');
    const b = await client.structured(classifyRequest(ctx));
    expect(b.ok === false && b.status).toBe('not_configured');
    expect(JSON.stringify(b)).not.toContain(TEST_KEY);
  });

  it('text() returns plain text with the evidence placed at the {{evidence}} slot', async () => {
    const gw = fakeGateway({ chat: [() => chatCompletion('Two sentences of synthetic summary. Partial review of ev-2.', { model: 'synthetic-reasoner', usage: { prompt_tokens: 500, completion_tokens: 40, total_tokens: 540, cost: 0.00132 } })] });
    ctx = llmTestContext({ fetch: gw.fetch });
    const r = await testClient(ctx, gw).text({
      siteId: ctx.siteId,
      runId: ctx.runId,
      role: 'synthesizer',
      tier: 'reasoning',
      promptId: 'test.summarize',
      variables: { site_name: 'Example Co (synthetic)' },
      evidence: [{ id: 'ev-9', label: 'note', text: 'Synthetic note text.', trustClass: 'owner_approved' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain('synthetic summary');
    expect(r.costMicros).toBe(1320);
    const user = gw.chatBodies[0].messages[1].content as string;
    expect(user.indexOf('EVIDENCE BUNDLE')).toBeGreaterThan(user.indexOf('Example Co (synthetic)'));
    expect(user.trim().endsWith('End of task.')).toBe(true);
    expect(gw.chatBodies[0].response_format).toBeUndefined();
    const c = listLlmCalls(ctx.db, ctx.siteId)[0]!;
    expect(c.validation_status).toBe('not_applicable');
    expect(c.tier).toBe('reasoning');
  });

  it('throws for programming errors (unknown variables, schema mismatch) before any spend', async () => {
    const gw = fakeGateway();
    ctx = llmTestContext({ fetch: gw.fetch });
    const client = testClient(ctx, gw);
    await expect(client.structured(classifyRequest(ctx, { variables: { query: 'x', language: 'en', extra: 'nope' } }))).rejects.toThrow(/unknown variable/);
    await expect(client.structured(classifyRequest(ctx, { variables: { query: 'x' } }))).rejects.toThrow(/missing variable/);
    await expect(client.structured(classifyRequest(ctx, { schemaName: 'Other' }))).rejects.toThrow(/output_schema/);
    await expect(client.structured(classifyRequest(ctx, { siteId: 'other-site' }))).rejects.toThrow(/site/);
    expect(gw.fetch.calls).toHaveLength(0);
  });
});
