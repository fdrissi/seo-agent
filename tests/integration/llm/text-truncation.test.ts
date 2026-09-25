/**
 * Output truncation honesty (spec section 9: record truncation; never describe
 * a truncated result as complete). SYNTHETIC fake gateway, offline.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { TestContext } from '../../helpers/context.js';
import { createLlmClient } from '../../../src/integrations/llm/gateway.js';
import { OUTPUT_TRUNCATION_ID } from '../../../src/integrations/llm/types.js';
import { claim } from '../../../src/reports/model.js';
import { describeSummaryCoverage, EXECUTIVE_SUMMARY_MAX_CLAIMS, llmExecutiveSummary } from '../../../src/reports/llm-summary.js';
import { TEST_BOUNDARY, chatCompletion, fakeGateway, llmTestContext, rows, testClient } from './harness.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const syntheticClaims = (n: number) => Array.from({ length: n }, (_, i) => claim('OBSERVED', `synthetic.claim.${i}`, `Synthetic claim ${i}: 120 clicks (computed by code).`));

describe('text(): finish_reason "length"', () => {
  it('returns the paid text flagged outputTruncated with a truncation entry, and records it on the call', async () => {
    const gw = fakeGateway({ chat: [() => chatCompletion('Synthetic summary that stops mid', { model: 'synthetic-reasoner', finishReason: 'length' })] });
    ctx = llmTestContext({ fetch: gw.fetch });
    const r = await testClient(ctx, gw).text({ siteId: ctx.siteId, runId: ctx.runId, role: 'synthesizer', tier: 'reasoning', promptId: 'test.summarize', variables: { site_name: 'x' }, evidence: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.outputTruncated).toBe(true);
    const t = r.truncation.find((x) => x.evidenceId === OUTPUT_TRUNCATION_ID)!;
    expect(t.note).toMatch(/cut off at the output token limit/);
    const call = rows<{ status: string; error_json: string }>(ctx, 'SELECT status, error_json FROM llm_calls')[0]!;
    expect(call.status).toBe('succeeded');
    expect(JSON.parse(call.error_json).outputTruncated).toBe(true);
    expect(ctx.logEntries.some((e) => /cut off at the output token limit/.test(e.msg))).toBe(true);
  });

  it('a normal stop is not flagged', async () => {
    const gw = fakeGateway({ chat: [() => chatCompletion('Complete synthetic summary.', { model: 'synthetic-reasoner' })] });
    ctx = llmTestContext({ fetch: gw.fetch });
    const r = await testClient(ctx, gw).text({ siteId: ctx.siteId, runId: ctx.runId, role: 'synthesizer', tier: 'reasoning', promptId: 'test.summarize', variables: { site_name: 'x' }, evidence: [] });
    expect(r.ok && r.outputTruncated).toBeFalsy();
    expect(r.ok && r.truncation).toEqual([]);
  });
});

describe('LLM executive summary coverage', () => {
  it('states "N of M claims given to the model" and never presents a cut-off summary as complete', async () => {
    const gw = fakeGateway({ chat: [() => chatCompletion('Clicks were steady and the', { finishReason: 'length' })] });
    ctx = llmTestContext({ fetch: gw.fetch });
    const client = createLlmClient(ctx, { fetch: gw.fetch, boundaryToken: () => TEST_BOUNDARY });
    const claims = syntheticClaims(90);
    const r = await llmExecutiveSummary(ctx, { client }, { kind: 'weekly', period: { start: '2026-09-14', end: '2026-09-20' } as never, claims, synthetic: true });
    expect(r.info.status).toBe('generated');
    const c = r.claim!;
    expect(c.text).toContain(`${EXECUTIVE_SUMMARY_MAX_CLAIMS} of 90 claims of this report given to the model`);
    expect(c.text).toMatch(/50 not offered/);
    expect(c.text).toMatch(/covers only part of the report/);
    expect(c.text).toMatch(/INCOMPLETE/);
    expect(c.text).toMatch(/\[cut off: the model reached its output token limit; the summary is incomplete\]/);
    expect(c.evidence[0]!.label).toBe(`${EXECUTIVE_SUMMARY_MAX_CLAIMS} of 90 claims of this report given to the model (not verified against its output)`);
    expect(r.info.detail).toMatch(/INCOMPLETE/);
    // The model is told how many claims it saw.
    const user = gw.chatBodies[0].messages.find((m: { role: string }) => m.role === 'user').content as string;
    expect(user).toContain(`You are given ${EXECUTIVE_SUMMARY_MAX_CLAIMS} of the report's 90 computed claims`);
  });

  it('propagates evidence truncation (claims cut or omitted to fit the input ceiling) into the claim text', async () => {
    const gw = fakeGateway({ chat: [() => chatCompletion('Synthetic summary.')] });
    ctx = llmTestContext({ fetch: gw.fetch, llm: { maxInputTokens: 3_000 } });
    const client = createLlmClient(ctx, { fetch: gw.fetch, boundaryToken: () => TEST_BOUNDARY });
    const long = syntheticClaims(12).map((c) => ({ ...c, text: `${c.text} ${'Detail sentence computed by code. '.repeat(20)}` }));
    const r = await llmExecutiveSummary(ctx, { client }, { kind: 'weekly', period: { start: '2026-09-14', end: '2026-09-20' } as never, claims: long, synthetic: true });
    expect(r.info.status).toBe('generated');
    expect(r.claim!.text).toMatch(/(omitted|truncated) to fit the input limit/);
    expect(r.claim!.text).toMatch(/covers only part of the report/);
    expect(r.claim!.text).not.toMatch(/INCOMPLETE/);
  });

  it('describeSummaryCoverage: full coverage says so without claiming partial review', () => {
    const full = describeSummaryCoverage(3, ['a', 'b', 'c'], [], false);
    expect(full.statement).toBe('3 of 3 claims of this report given to the model.');
    const partial = describeSummaryCoverage(3, ['a', 'b', 'c'], [{ evidenceId: 'c', originalTokens: 100, keptTokens: 0, note: '' }, { evidenceId: 'b', originalTokens: 100, keptTokens: 40, note: '' }], false);
    expect(partial.given).toBe(2);
    expect(partial.statement).toBe('2 of 3 claims of this report given to the model; 1 omitted to fit the input limit; 1 truncated to fit the input limit; the summary covers only part of the report.');
  });
});
