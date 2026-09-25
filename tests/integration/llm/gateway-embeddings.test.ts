import { afterEach, describe, expect, it } from 'vitest';
import type { TestContext } from '../../helpers/context.js';
import { jsonResponse } from '../../helpers/fake-fetch.js';
import { listLlmCalls } from '../../../src/integrations/llm/records.js';
import { fakeGateway, gatewayError, llmTestContext, rows, testClient } from './harness.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

function vec(seed: number, dims = 4): number[] {
  return Array.from({ length: dims }, (_, i) => (seed + 1) * 0.1 + i * 0.01);
}

function base64Vec(values: number[]): string {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf.toString('base64');
}

describe('LLM Gateway embeddings (synthetic fake gateway)', () => {
  it('embeds in budgeted batches, sorts by index, decodes base64, and computes cost from usage x verified price', async () => {
    const gw = fakeGateway({
      embeddings: [
        (body) => {
          expect(body.model).toBe('synthetic-embed-small');
          expect(body.encoding_format).toBe('float');
          expect(body.dimensions).toBeUndefined();
          // Out-of-order indices and one base64-encoded vector.
          return jsonResponse({ object: 'list', data: [{ object: 'embedding', index: 1, embedding: base64Vec(vec(1)) }, { object: 'embedding', index: 0, embedding: vec(0) }], model: 'synthetic-embed-small', usage: { prompt_tokens: 1_000_000, total_tokens: 1_000_000 } });
        },
        () => jsonResponse({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: vec(2) }], model: 'synthetic-embed-small', usage: { prompt_tokens: 50, total_tokens: 50 } }),
      ],
    });
    ctx = llmTestContext({ fetch: gw.fetch });
    const r = await testClient(ctx, gw, { embedBatchSize: 2 }).embed({ siteId: ctx.siteId, runId: ctx.runId, texts: ['alpha (synthetic)', 'beta (synthetic)', 'gamma (synthetic)'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vectors).toHaveLength(3);
    expect(r.dimensions).toBe(4);
    expect(Array.from(r.vectors[0]!)[0]).toBeCloseTo(0.1);
    expect(Array.from(r.vectors[1]!)[0]).toBeCloseTo(0.2);
    expect(Array.from(r.vectors[2]!)[0]).toBeCloseTo(0.3);
    // 1,000,000 tokens x $0.02/1M = 20,000 micros; 50 tokens x $0.02/1M -> ceil = 1 micro.
    expect(r.costMicros).toBe(20_001);
    expect(r.usage.inputTokens).toBe(1_000_050);
    expect(gw.embedBodies).toHaveLength(2);
    const calls = listLlmCalls(ctx.db, ctx.siteId);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.tier === 'embedding' && c.role === 'embedder' && c.cost_status === 'estimated')).toBe(true);
    const res = rows<{ status: string }>(ctx, 'SELECT status FROM budget_reservations');
    expect(res.map((x) => x.status)).toEqual(['reconciled', 'reconciled']);
    const ledger = rows<{ source: string }>(ctx, 'SELECT source FROM cost_ledger');
    expect(ledger.every((l) => l.source === 'computed_from_usage')).toBe(true);
  });

  it('missing embeddings usage leaves the cost unknown (null) and the reservation unresolved', async () => {
    const gw = fakeGateway({ embeddings: [() => jsonResponse({ object: 'list', data: [{ index: 0, embedding: vec(0) }], model: 'synthetic-embed-small' })] });
    ctx = llmTestContext({ fetch: gw.fetch });
    const r = await testClient(ctx, gw).embed({ siteId: ctx.siteId, runId: ctx.runId, texts: ['alpha'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.costMicros).toBeNull();
    expect(rows<{ status: string }>(ctx, 'SELECT status FROM budget_reservations')).toEqual([{ status: 'unresolved' }]);
  });

  it('rejects vectors whose dimensions differ from the configured dimensions (never mixes incompatible vectors) without sending `dimensions`', async () => {
    const gw = fakeGateway({ embeddings: [(body) => {
      // models.embeddingDimensions verifies responses; it is not a shortening request.
      if ('dimensions' in body) throw new Error('dimensions must not be sent unless shortening is explicitly requested');
      return jsonResponse({ data: [{ index: 0, embedding: vec(0, 4) }], model: 'synthetic-embed-small', usage: { prompt_tokens: 3, total_tokens: 3 } });
    }] });
    ctx = llmTestContext({ fetch: gw.fetch, models: { embeddingDimensions: 8 } });
    const r = await testClient(ctx, gw).embed({ siteId: ctx.siteId, runId: ctx.runId, texts: ['alpha'] });
    expect(r.ok === false && r.status).toBe('provider_error');
    expect(r.ok === false && r.reason).toContain('models.embeddingDimensions is 8');
  });

  it('sends `dimensions` only on an explicit shortening request, and verifies the result', async () => {
    const gw = fakeGateway({ embeddings: [(body) => {
      expect(body.dimensions).toBe(8);
      return jsonResponse({ data: [{ index: 0, embedding: vec(0, 8) }], model: 'synthetic-embed-small', usage: { prompt_tokens: 3, total_tokens: 3 } });
    }] });
    ctx = llmTestContext({ fetch: gw.fetch, models: { embeddingDimensions: 8 } });
    const r = await testClient(ctx, gw, { embeddingRequestDimensions: 8 }).embed({ siteId: ctx.siteId, runId: ctx.runId, texts: ['alpha'] });
    expect(r.ok).toBe(true);
    expect(r.ok && r.dimensions).toBe(8);
    const mismatch = await testClient(ctx, gw, { embeddingRequestDimensions: 16 }).embed({ siteId: ctx.siteId, runId: ctx.runId, texts: ['alpha'] });
    expect(mismatch.ok === false && mismatch.status).toBe('unsupported');
    expect(gw.embedBodies).toHaveLength(1);
  });

  it('refuses a chat model as the embedding model (invalid_model) and oversized inputs before any spend', async () => {
    const gw = fakeGateway();
    ctx = llmTestContext({ fetch: gw.fetch, models: { embedding: 'synthetic-cheap-structured' } });
    const a = await testClient(ctx, gw).embed({ siteId: ctx.siteId, runId: ctx.runId, texts: ['alpha'] });
    expect(a.ok === false && a.status).toBe('invalid_model');
    ctx.cleanup();
    ctx = llmTestContext({ fetch: gw.fetch });
    const b = await testClient(ctx, gw).embed({ siteId: ctx.siteId, runId: ctx.runId, texts: ['x'.repeat(40_000)] });
    expect(b.ok === false && b.status).toBe('unsupported');
    expect(gw.embedBodies).toHaveLength(0);
    expect(rows(ctx, 'SELECT * FROM budget_reservations')).toHaveLength(0);
  });

  it('maps a 403 (e.g. embeddings on a Dev plan) to provider_error and releases the reservation', async () => {
    const gw = fakeGateway({ embeddings: [() => gatewayError(403, 'Embeddings are not available on this plan', 'permission_denied', null)] });
    ctx = llmTestContext({ fetch: gw.fetch });
    const r = await testClient(ctx, gw).embed({ siteId: ctx.siteId, runId: ctx.runId, texts: ['alpha'] });
    expect(r.ok === false && r.status).toBe('provider_error');
    expect(r.ok === false && r.nextStep).toContain('Dev plans');
    expect(rows<{ status: string }>(ctx, 'SELECT status FROM budget_reservations')).toEqual([{ status: 'released' }]);
  });

  it('is disabled when the embeddings feature is off', async () => {
    const gw = fakeGateway();
    ctx = llmTestContext({ fetch: gw.fetch, profile: 'core' });
    const client = testClient(ctx, gw);
    expect(client.isConfigured('embedding')).toBe(false);
    expect(client.isConfigured('cheap')).toBe(true);
    const r = await client.embed({ siteId: ctx.siteId, runId: ctx.runId, texts: ['alpha'] });
    expect(r.ok === false && r.status).toBe('disabled');
    expect(gw.fetch.calls).toHaveLength(0);
  });
});
