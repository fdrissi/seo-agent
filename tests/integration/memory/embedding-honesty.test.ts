/**
 * Cost honesty, embedding-space identity, and query privacy for embeddings
 * (SYNTHETIC data, fake Qdrant + fake embedder or the real gateway client over
 * a fake fetch, offline).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EmbeddingService } from '../../../src/memory/embeddings.js';
import { ingestDocument } from '../../../src/memory/documents.js';
import type { TestContext } from '../../helpers/context.js';
import { jsonResponse } from '../../helpers/fake-fetch.js';
import { fakeGateway, gatewayError, llmTestContext, testClient } from '../llm/harness.js';
import { FakeEmbedder } from '../../fixtures/memory/fake-embedder.js';
import { installFixtureVault, memoryHarness, type MemoryHarness } from '../../fixtures/memory/setup.js';

let h: MemoryHarness;
afterEach(() => h?.ctx.cleanup());

const n = (sql: string) => h.ctx.db.get<{ n: number }>(sql)!.n;

describe('embedding cost honesty', () => {
  it('an ambiguous failure (request may have been billed) makes the run cost unknown, never $0', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    h.embedder.failWith = { status: 'provider_error', reason: 'timeout after submission (synthetic)', ambiguous: true, reservationId: 'res_synthetic' };
    const r = await h.service.sync({ allowPaid: true });
    expect(r.index.status).toBe('partial');
    expect(r.index.costMicros).toBeNull();
    expect(r.index.messages.join(' ')).toMatch(/charge may be unresolved/);
    expect(h.embedder.calls).toHaveLength(1); // never retried or continued after an ambiguous submission
  });

  it('a failure that carries a known charge (billed after a 2xx) adds it; one with an unknown charge makes the cost unknown', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    h.embedder.failWith = { status: 'provider_error', reason: 'dimension check failed after the response (synthetic)', billed: true, costMicros: 321 };
    const billed = await h.service.sync({ allowPaid: true });
    expect(billed.index.costMicros).toBe(321);
    expect(billed.index.messages.join(' ')).toMatch(/billed: \$0\.00/);
    h.ctx.cleanup();

    h = memoryHarness();
    installFixtureVault(h.ctx);
    h.embedder.failWith = { status: 'provider_error', reason: 'unparseable 2xx body (synthetic)', billed: true, chargeUnknown: true, costMicros: null, reservationId: 'res_synthetic' };
    const unknown = await h.service.sync({ allowPaid: true });
    expect(unknown.index.costMicros).toBeNull();
    expect(unknown.index.messages.join(' ')).toMatch(/charge unknown/);
    h.ctx.cleanup();

    // An unreleased reservation alone (no flags) is never counted as $0 either.
    h = memoryHarness();
    installFixtureVault(h.ctx);
    h.embedder.failWith = { status: 'provider_error', reason: 'reservation left unresolved (synthetic)', reservationId: 'res_synthetic_2' };
    const unresolved = await h.service.sync({ allowPaid: true });
    expect(unresolved.index.costMicros).toBeNull();
  });

  it('a clean (not billed) budget refusal keeps a known $0 cost', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    h.embedder.failWith = { status: 'budget_exceeded', reason: 'per-run cap reached (synthetic)' };
    const r = await h.service.sync({ allowPaid: true });
    expect(r.index.costMicros).toBe(0);
    expect(r.index.messages.join(' ')).not.toMatch(/charge may be unresolved/);
  });

  it('a billed response refused for a dimension mismatch still reports its cost', async () => {
    const embedder = new FakeEmbedder(16); // config says 32
    embedder.returnCostMicros = 1234;
    h = memoryHarness({ embedder });
    installFixtureVault(h.ctx);
    const r = await h.service.sync({ allowPaid: true });
    expect(r.index.status).toBe('refused');
    expect(r.index.costMicros).toBe(1234);
    expect(r.index.messages.join(' ')).toMatch(/1 embedding call\(s\) were made before the refusal/);
    expect(n('SELECT COUNT(*) AS n FROM embedding_cache')).toBe(0);
  });

  it('a billed response refused with an unknown cost reports the run cost as unknown', async () => {
    const embedder = new FakeEmbedder(16);
    embedder.returnCostMicros = null;
    h = memoryHarness({ embedder });
    installFixtureVault(h.ctx);
    const r = await h.service.sync({ allowPaid: true });
    expect(r.index.status).toBe('refused');
    expect(r.index.costMicros).toBeNull();
  });

  it('an invalid (non-finite) response is discarded but its cost is kept', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    h.embedder.nonFinite = true;
    h.embedder.returnCostMicros = 700;
    const r = await h.service.sync({ allowPaid: true });
    expect(r.index.status).toBe('partial');
    expect(r.index.costMicros).toBe(700);
    expect(r.index.messages.join(' ')).toMatch(/non-finite/);
    expect(r.index.upserted).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM embedding_cache')).toBe(0);
  });

  it('successful calls add their reported cost', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    h.embedder.returnCostMicros = 50;
    const r = await h.service.sync({ allowPaid: true });
    expect(r.index.status).toBe('ok');
    expect(r.index.costMicros).toBe(50 * h.embedder.calls.length);
  });
});

describe('embedding-space identity: model check', () => {
  it('refuses vectors from another model with the same dimensions (gateway fallback): nothing cached or indexed', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    h.embedder.returnModel = 'other-embed-model';
    h.embedder.returnCostMicros = 90;
    const r = await h.service.sync({ allowPaid: true });
    expect(r.index.status).toBe('refused');
    expect(r.index.messages.join(' ')).toMatch(/came from model "other-embed-model" but the configured embedding model is "fake-embed-model"/);
    expect(r.index.costMicros).toBe(90);
    expect(n('SELECT COUNT(*) AS n FROM embedding_cache')).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM embedding_versions')).toBe(0);
    expect(h.qdrant.collections.size).toBe(0);
  });

  it('refuses a model switch after an embedding version exists (never mixes spaces in one collection)', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    await h.service.sync({ allowPaid: true });
    const cached = n('SELECT COUNT(*) AS n FROM embedding_cache');
    h.embedder.returnModel = 'fake-embed-model-large';
    ingestDocument(h.ctx, { sourceType: 'decision', sourceRef: 'decision:new', title: 'New', text: 'A new decision about trays (synthetic).', trustClass: 'owner_approved' });
    const r = await h.service.sync({ allowPaid: true, skipIngest: true });
    expect(r.index.status).toBe('refused');
    expect(n('SELECT COUNT(*) AS n FROM embedding_cache')).toBe(cached);
  });

  it('accepts a provider-prefixed id of the same model and records the returned id on the version and each cached vector', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    h.embedder.returnModel = 'fixture-provider/fake-embed-model';
    const r = await h.service.sync({ allowPaid: true });
    expect(r.index.status).toBe('ok');
    expect(h.ctx.logEntries.some((e) => /differs only by provider prefix/.test(e.msg))).toBe(true);
    expect(h.ctx.db.get<{ returned_model_id: string }>('SELECT returned_model_id FROM embedding_versions')!.returned_model_id).toBe('fixture-provider/fake-embed-model');
    expect(n("SELECT COUNT(*) AS n FROM embedding_cache WHERE returned_model_id IS NOT 'fixture-provider/fake-embed-model'")).toBe(0);
    expect(n('SELECT COUNT(*) AS n FROM embedding_cache')).toBeGreaterThan(0);
  });

  it('refuses a version-suffixed or moving-alias id (a dated snapshot or -latest alias is another space)', async () => {
    for (const returned of ['fake-embed-model-2026-01-15', 'fake-embed-model-latest', 'fake-embed-model@001', 'fake-embed-model-v2']) {
      h?.ctx.cleanup();
      h = memoryHarness();
      installFixtureVault(h.ctx);
      h.embedder.returnModel = returned;
      const r = await h.service.sync({ allowPaid: true });
      expect(r.index.status, returned).toBe('refused');
      expect(n('SELECT COUNT(*) AS n FROM embedding_cache'), returned).toBe(0);
    }
  });

  it('refuses a batch whose returned model id differs from the one that created the embedding version (provider re-route)', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    h.embedder.returnModel = 'prov-a/fake-embed-model';
    await h.service.sync({ allowPaid: true });
    const cached = n('SELECT COUNT(*) AS n FROM embedding_cache');
    // The gateway now routes the same configured id to another provider: same name, same dimensions.
    h.embedder.returnModel = 'prov-b/fake-embed-model';
    h.embedder.returnCostMicros = 15;
    ingestDocument(h.ctx, { sourceType: 'decision', sourceRef: 'decision:reroute', title: 'Reroute', text: 'A decision about shipping trays (synthetic).', trustClass: 'owner_approved' });
    const r = await h.service.sync({ allowPaid: true, skipIngest: true });
    expect(r.index.status).toBe('refused');
    expect(r.index.messages.join(' ')).toMatch(/was created from vectors of "prov-a\/fake-embed-model"/);
    expect(r.index.costMicros).toBe(15); // the refused response was billed
    expect(n('SELECT COUNT(*) AS n FROM embedding_cache')).toBe(cached);
  });

  it('a version created before returned ids were stored adopts the id of its next batch, then enforces it', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    await h.service.sync({ allowPaid: true });
    h.ctx.db.run('UPDATE embedding_versions SET returned_model_id = NULL');
    ingestDocument(h.ctx, { sourceType: 'decision', sourceRef: 'decision:legacy', title: 'Legacy', text: 'A decision about legacy trays (synthetic).', trustClass: 'owner_approved' });
    const ok = await h.service.sync({ allowPaid: true, skipIngest: true });
    expect(ok.index.status).toBe('ok');
    expect(h.ctx.db.get<{ returned_model_id: string }>('SELECT returned_model_id FROM embedding_versions')!.returned_model_id).toBe('fake-embed-model');
    h.embedder.returnModel = 'prov-z/fake-embed-model';
    ingestDocument(h.ctx, { sourceType: 'decision', sourceRef: 'decision:legacy-2', title: 'Legacy 2', text: 'Another decision about legacy lids (synthetic).', trustClass: 'owner_approved' });
    const refused = await h.service.sync({ allowPaid: true, skipIngest: true });
    expect(refused.index.status).toBe('refused');
  });

  it('a refused query embedding falls back to full-text search and reports the paid call', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    await h.service.sync({ allowPaid: true });
    h.embedder.returnModel = 'other-embed-model';
    h.embedder.returnCostMicros = 20;
    const r = await h.service.search({ siteId: 'test-site', text: 'school discount email' });
    expect(r.method).toBe('fts_only');
    expect(r.degradedReason).toMatch(/query embedding failed/);
    expect(r.warnings.join(' ')).toMatch(/refused query embedding was a paid call \(cost \$0\.00/);
  });
});

describe('query privacy', () => {
  it('personal identifiers in a query are redacted before the embedding provider sees them', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    await h.service.sync({ allowPaid: true });
    const before = h.embedder.textsEmbedded.length;
    const r = await h.service.search({ siteId: 'test-site', text: 'school discount for jane.doe@example.test from 198.51.100.23' });
    expect(r.method).toBe('hybrid');
    const sent = h.embedder.textsEmbedded.slice(before).join(' ');
    expect(sent).not.toContain('jane.doe@example.test');
    expect(sent).not.toContain('198.51.100.23');
    expect(sent).toContain('[EMAIL]');
    expect(r.warnings.join(' ')).toMatch(/Personal identifiers \(email, ip_address\) were redacted/);
    // The cached query vector is keyed by the redacted text: the raw query is not stored either.
    expect(n(`SELECT COUNT(*) AS n FROM memory_retrieval_state WHERE degraded_reason LIKE '%jane.doe%'`)).toBe(0);
    expect(r.candidates.fts).toBeGreaterThan(0); // full-text search still ran locally
  });
});

// ---------------------------------------------------------------------------
// EmbeddingService on top of the REAL GatewayLlmClient with a SYNTHETIC fake
// gateway (fake fetch; no network, no real credentials, no real model ids).

describe('embedding cost honesty over the real LLM Gateway client (fake fetch)', () => {
  let lctx: TestContext | undefined;
  afterEach(() => {
    lctx?.cleanup();
    lctx = undefined;
  });

  const vec = (seed: number, dims: number) => Array.from({ length: dims }, (_, i) => (seed + 1) * 0.1 + i * 0.01);
  const items = (k: number) => Array.from({ length: k }, (_, i) => ({ hash: `h${i}`, text: `synthetic chunk ${i} about trays` }));

  it('a response refused by the gateway dimension check after reconciliation reports its known cost, never $0', async () => {
    // 1,000,000 tokens x $0.02/1M (synthetic catalog price) = 20,000 micros.
    const gw = fakeGateway({ embeddings: [() => jsonResponse({ data: [{ index: 0, embedding: vec(0, 4) }], model: 'synthetic-embed-small', usage: { prompt_tokens: 1_000_000, total_tokens: 1_000_000 } })] });
    lctx = llmTestContext({ fetch: gw.fetch, models: { embeddingDimensions: 8 } });
    const svc = new EmbeddingService(lctx, testClient(lctx, gw));
    const out = await svc.embed(items(1), { allowPaid: true });
    expect(out.failure?.status).toBe('provider_error');
    expect(out.failure?.reason).toMatch(/dimension check failed/);
    expect(out.costMicros).toBe(20_000);
    expect(out.vectors.size).toBe(0);
    // The ledger agrees with the run result.
    expect(lctx.db.all<{ status: string }>('SELECT status FROM budget_reservations')).toEqual([{ status: 'reconciled' }]);
  });

  it('an unparseable 2xx body (billed, charge unknown, reservation unresolved) makes the run cost unknown', async () => {
    const gw = fakeGateway({ embeddings: [() => new Response('{"data": [', { status: 200, headers: { 'content-type': 'application/json' } })] });
    lctx = llmTestContext({ fetch: gw.fetch });
    const svc = new EmbeddingService(lctx, testClient(lctx, gw));
    const out = await svc.embed(items(1), { allowPaid: true });
    expect(out.failure).not.toBeNull();
    expect(out.costMicros).toBeNull();
    expect(out.failure?.reason).toMatch(/charge unknown/);
    expect(lctx.db.all<{ status: string }>('SELECT status FROM budget_reservations')).toEqual([{ status: 'unresolved' }]);
  });

  it('a later batch rejected before inference keeps the known cost of the earlier billed batch', async () => {
    const gw = fakeGateway({
      embeddings: [
        () => jsonResponse({ data: [{ index: 0, embedding: vec(0, 4) }], model: 'synthetic-embed-small', usage: { prompt_tokens: 500_000, total_tokens: 500_000 } }),
        () => gatewayError(400, 'invalid input (synthetic)'),
      ],
    });
    lctx = llmTestContext({ fetch: gw.fetch });
    const svc = new EmbeddingService(lctx, testClient(lctx, gw, { embedBatchSize: 1 }));
    const out = await svc.embed(items(2), { allowPaid: true });
    expect(out.failure?.status).toBe('provider_error');
    expect(out.costMicros).toBe(10_000); // batch 1 was billed even though its vectors were discarded
    expect(out.vectors.size).toBe(0);
  });

  it('an ambiguous gateway timeout stays unknown and a clean pre-inference rejection stays a known $0', async () => {
    const gw = fakeGateway({ embeddings: [() => gatewayError(504, 'upstream timeout (synthetic)'), () => gatewayError(402, 'credits exhausted (synthetic)')] });
    lctx = llmTestContext({ fetch: gw.fetch });
    const client = testClient(lctx, gw);
    const ambiguous = await new EmbeddingService(lctx, client).embed(items(1), { allowPaid: true });
    expect(ambiguous.costMicros).toBeNull();
    expect(ambiguous.failure?.ambiguous).toBe(true);
    const clean = await new EmbeddingService(lctx, client).embed([{ hash: 'other', text: 'another synthetic chunk' }], { allowPaid: true });
    expect(clean.failure?.status).toBe('budget_exceeded');
    expect(clean.costMicros).toBe(0);
  });

  it('refuses batches of one request served by different models (never mixed under one id)', async () => {
    const gw = fakeGateway({
      embeddings: [
        () => jsonResponse({ data: [{ index: 0, embedding: vec(0, 4) }], model: 'prov-a/synthetic-embed-small', usage: { prompt_tokens: 10, total_tokens: 10 } }),
        () => jsonResponse({ data: [{ index: 0, embedding: vec(1, 4) }], model: 'prov-b/synthetic-embed-small', usage: { prompt_tokens: 10, total_tokens: 10 } }),
      ],
    });
    lctx = llmTestContext({ fetch: gw.fetch });
    const r = await testClient(lctx, gw, { embedBatchSize: 1 }).embed({ siteId: lctx.siteId, runId: lctx.runId, texts: ['a (synthetic)', 'b (synthetic)'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/came from model "prov-b\/synthetic-embed-small" but earlier batches/);
    expect(r.billed).toBe(true);
    expect(r.costMicros).toBe(2); // two billed batches at 1 micro each (rounded up)
  });
});
