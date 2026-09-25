import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ingestDocument } from '../../../src/memory/documents.js';
import { pointIdFor } from '../../../src/memory/uuid.js';
import { FakeEmbedder } from '../../fixtures/memory/fake-embedder.js';
import { DIMS, installFixtureVault, memoryConfig, memoryHarness, type MemoryHarness } from '../../fixtures/memory/setup.js';

let h: MemoryHarness;
afterEach(() => h?.ctx.cleanup());

function collectionOf(): string {
  return h.ctx.db.get<{ collection_name: string }>('SELECT collection_name FROM embedding_versions')!.collection_name;
}

describe('memory indexer (fake Qdrant + fake embedder, offline)', () => {
  it('dry run plans without network, embedding, or writes', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    const r = await h.service.sync({ dryRun: true, allowPaid: true });
    expect(r.ingest!.dryRun).toBe(true);
    expect(r.ingest!.bySourceType.business_note!.created).toBe(3);
    expect(r.index.dryRun).toBe(true);
    expect(h.qdrant.requests).toHaveLength(0);
    expect(h.embedder.calls).toHaveLength(0);
    expect(h.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memory_documents')!.n).toBe(0);
    expect(r.index.plan.paid.caps.perRunMicros).toBe(500_000);
  });

  it('without --allow-paid it ingests but never calls the embedder; shows the paid plan with caps', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    const r = await h.service.sync({ allowPaid: false });
    expect(h.embedder.calls).toHaveLength(0);
    expect(r.index.status).toBe('partial');
    expect(r.index.skippedPaid).toBeGreaterThan(0);
    expect(r.index.plan.paid.required).toBe(true);
    expect(r.index.plan.paid.estimatedCostMicros).toBeNull(); // no verified price configured: unknown, never 0
    expect(r.index.messages.join(' ')).toMatch(/--allow-paid/);
  });

  it('indexes chunks into a per-version cosine collection with site-scoped payloads; re-sync never re-embeds', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    const r = await h.service.sync({ allowPaid: true });
    expect(r.index.status).toBe('ok');
    expect(r.index.upserted).toBeGreaterThan(0);
    const v = h.ctx.db.get<{ id: string; provider: string; model_id: string; dimensions: number; chunker_version: string; collection_name: string }>('SELECT * FROM embedding_versions')!;
    expect(v).toMatchObject({ provider: 'fixture', model_id: 'fake-embed-model', dimensions: DIMS });
    expect(v.collection_name).toMatch(/^seo_agent__fixture__fake_embed_model__d32__md_heading_v\d+$/);
    const col = h.qdrant.collections.get(v.collection_name)!;
    expect(col.size).toBe(DIMS);
    expect(col.distance).toBe('Cosine');
    expect([...col.indexes.keys()]).toEqual(expect.arrayContaining(['site_id', 'source_type', 'trust_class', 'status', 'language', 'superseded']));
    const pts = h.qdrant.pointsFor(v.collection_name);
    expect(pts.length).toBe(r.index.upserted);
    for (const p of pts) {
      expect(p.payload).toMatchObject({ site_id: 'test-site', superseded: false, status: 'active', language: 'en', source_type: 'business_note', embedding_version_id: v.id });
      expect(p.payload).not.toHaveProperty('text'); // chunk text is never stored in Qdrant
      expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
    }
    const idx = h.ctx.db.get<{ degraded: number; last_sync_at: string }>('SELECT degraded, last_sync_at FROM memory_index_state')!;
    expect(idx.degraded).toBe(0);
    expect(idx.last_sync_at).toBeTruthy();

    const callsBefore = h.embedder.calls.length;
    const again = await h.service.sync({ allowPaid: true });
    expect(h.embedder.calls.length).toBe(callsBefore);
    expect(again.index.upserted).toBe(0);
    expect(again.index.plan.chunks.pending).toBe(0);
  });

  it('dedup cache: identical text in two documents is embedded once; edits embed only changed chunks', async () => {
    h = memoryHarness();
    const same = '# Shared\n\nIdentical paragraph about modular trays (synthetic).';
    ingestDocument(h.ctx, { sourceType: 'decision', sourceRef: 'decision:a', title: 'A', text: same, trustClass: 'owner_approved' });
    ingestDocument(h.ctx, { sourceType: 'decision', sourceRef: 'decision:b', title: 'B', text: same, trustClass: 'owner_approved' });
    await h.service.sync({ allowPaid: true, skipIngest: true });
    expect(h.embedder.textsEmbedded).toHaveLength(1);
    expect(h.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM embedding_cache')!.n).toBe(1);
    expect(h.qdrant.pointsFor(collectionOf())).toHaveLength(2); // one point per document chunk

    const long = '# Guide\n\n' + Array.from({ length: 5 }, (_, i) => `## Step ${i}\n\n${`Step ${i} explains folding trays. `.repeat(60)}`).join('\n\n');
    ingestDocument(h.ctx, { sourceType: 'brief', sourceRef: 'content_brief:x', title: 'Guide', text: long, trustClass: 'model_generated' });
    await h.service.sync({ allowPaid: true, skipIngest: true });
    const afterFirst = h.embedder.textsEmbedded.length;
    const edited = long.replace(/Step 4 explains folding trays\. /g, 'Step four now explains stacking. ');
    ingestDocument(h.ctx, { sourceType: 'brief', sourceRef: 'content_brief:x', title: 'Guide', text: edited, trustClass: 'model_generated' });
    const r = await h.service.sync({ allowPaid: true, skipIngest: true });
    const newlyEmbedded = h.embedder.textsEmbedded.slice(afterFirst);
    expect(newlyEmbedded.length).toBeGreaterThan(0);
    expect(newlyEmbedded.every((t) => /stacking/.test(t))).toBe(true);
    expect(r.index.cacheHits).toBeGreaterThan(0);
    expect(r.index.tombstonesPropagated).toBeGreaterThan(0);
  });

  it('deletion propagation: removed notes and removed chunks disappear from Qdrant', async () => {
    h = memoryHarness();
    const vault = installFixtureVault(h.ctx);
    await h.service.sync({ allowPaid: true });
    const col = collectionOf();
    const audienceDoc = h.ctx.db.get<{ id: string }>(`SELECT id FROM memory_documents WHERE source_ref = '01 Business/Audience.md'`)!.id;
    expect(h.qdrant.pointsFor(col).some((p) => p.payload.document_id === audienceDoc)).toBe(true);
    rmSync(path.join(vault, '01 Business', 'Audience.md'));
    writeFileSync(path.join(vault, '01 Business', 'Pricing.md'), '# Pricing\n\nAll prices were withdrawn (synthetic).\n');
    const r = await h.service.sync({ allowPaid: true });
    expect(r.ingest!.bySourceType.business_note).toMatchObject({ deleted: 1, newVersion: 1 });
    const pts = h.qdrant.pointsFor(col);
    expect(pts.some((p) => p.payload.document_id === audienceDoc)).toBe(false);
    const pricingDoc = h.ctx.db.get<{ id: string }>(`SELECT id FROM memory_documents WHERE source_ref = '01 Business/Pricing.md'`)!.id;
    const pricingPts = pts.filter((p) => p.payload.document_id === pricingDoc);
    expect(pricingPts).toHaveLength(1);
    expect(pricingPts[0]!.payload.document_version).toBe(2);
    expect(h.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memory_tombstones WHERE propagated_at IS NULL')!.n).toBe(0);
    expect(h.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memory_tombstones WHERE propagated_at IS NOT NULL')!.n).toBeGreaterThan(0);
  });

  it('full rebuild from SQLite + cache makes no paid calls when the cache is complete', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    await h.service.sync({ allowPaid: true });
    const col = collectionOf();
    const expected = h.qdrant.pointsFor(col).map((p) => p.id).sort();
    const calls = h.embedder.calls.length;
    h.qdrant.collections.get(col)!.points.clear(); // simulate lost Qdrant storage

    const plan = await h.service.rebuild({ dryRun: true });
    expect(plan.plan.cache.misses).toBe(0);
    expect(plan.plan.paid.required).toBe(false);
    expect(plan.messages.join(' ')).toMatch(/no paid calls/);

    const r = await h.service.rebuild({ allowPaid: false });
    expect(r.status).toBe('ok');
    expect(h.embedder.calls.length).toBe(calls);
    expect(h.qdrant.pointsFor(col).map((p) => p.id).sort()).toEqual(expected);
  });

  it('reconcile deletes orphans, restores missing points from cache, and never touches other sites', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    await h.service.sync({ allowPaid: true });
    const col = collectionOf();
    const c = h.qdrant.collections.get(col)!;
    const [first] = h.qdrant.pointsFor(col);
    c.points.delete(first!.id);
    const orphan = pointIdFor('test-site', 'mdoc_gone', 'h', 0);
    c.points.set(orphan, { vector: Array(DIMS).fill(0.1), payload: { site_id: 'test-site', document_id: 'mdoc_gone', content_hash: 'h' } });
    const foreign = pointIdFor('other-site', 'mdoc_x', 'h', 0);
    c.points.set(foreign, { vector: Array(DIMS).fill(0.1), payload: { site_id: 'other-site', document_id: 'mdoc_x', content_hash: 'h' } });
    const calls = h.embedder.calls.length;

    const dry = await h.service.reconcile({ dryRun: true });
    expect(dry.orphanIds).toEqual([orphan]);
    expect(dry.missingIds).toEqual([first!.id]);
    expect(c.points.has(orphan)).toBe(true);

    const r = await h.service.reconcile();
    expect(r.orphansDeleted).toBe(1);
    expect(r.missingRestored).toBe(1);
    expect(c.points.has(orphan)).toBe(false);
    expect(c.points.has(first!.id)).toBe(true);
    expect(c.points.has(foreign)).toBe(true);
    expect(h.embedder.calls.length).toBe(calls);
    expect(h.ctx.db.get<{ last_reconcile_at: string | null }>('SELECT last_reconcile_at FROM memory_index_state')!.last_reconcile_at).toBeTruthy();
  });

  it('refuses an embedding dimension mismatch: nothing cached, no collection, no points', async () => {
    const embedder = new FakeEmbedder(16); // config says 32
    h = memoryHarness({ embedder });
    installFixtureVault(h.ctx);
    const r = await h.service.sync({ allowPaid: true });
    expect(r.index.status).toBe('refused');
    expect(r.index.messages.join(' ')).toMatch(/returned 16 dimensions but the site config says 32/);
    expect(h.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM embedding_cache')!.n).toBe(0);
    expect(h.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM embedding_versions')!.n).toBe(0);
    expect(h.qdrant.collections.size).toBe(0);
  });

  it('refuses when an established version gets vectors of another size (dimensions discovered, not configured)', async () => {
    const embedder = new FakeEmbedder(DIMS);
    h = memoryHarness({ embedder, config: memoryConfig({ models: { embedding: 'fake-embed-model', embeddingDimensions: null } }) });
    installFixtureVault(h.ctx);
    await h.service.sync({ allowPaid: true });
    expect(h.ctx.db.get<{ dimensions: number }>('SELECT dimensions FROM embedding_versions')!.dimensions).toBe(DIMS);
    const cached = h.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM embedding_cache')!.n;
    embedder.returnDims = 8; // provider silently changed output size
    ingestDocument(h.ctx, { sourceType: 'decision', sourceRef: 'decision:new', title: 'New', text: 'A brand new decision text (synthetic).', trustClass: 'owner_approved' });
    const r = await h.service.sync({ allowPaid: true, skipIngest: true });
    expect(r.index.status).toBe('refused');
    expect(r.index.messages.join(' ')).toMatch(/Refusing to mix vectors/);
    expect(h.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM embedding_cache')!.n).toBe(cached);
    embedder.returnDims = DIMS;
    embedder.ragged = true;
    const r2 = await h.service.sync({ allowPaid: true, skipIngest: true });
    expect(r2.index.status).toBe('refused');
  });

  it('never sends secret-like text to the embedder even if it bypassed ingestion', async () => {
    h = memoryHarness();
    ingestDocument(h.ctx, { sourceType: 'decision', sourceRef: 'decision:ok', title: 'OK', text: 'Another clean decision about shelves (synthetic).', trustClass: 'owner_approved' });
    const d = ingestDocument(h.ctx, { sourceType: 'decision', sourceRef: 'decision:s', title: 'S', text: 'Clean text about trays (synthetic).', trustClass: 'owner_approved' });
    // Simulate a bad write that bypassed the ingestion policy.
    h.ctx.db.run(`UPDATE memory_chunks SET text = 'leaked key sk-syntheticleakedsecretvalue000111 here' WHERE document_id = ?`, [d.documentId]);
    const r = await h.service.sync({ allowPaid: true, skipIngest: true });
    expect(h.embedder.textsEmbedded.join(' ')).not.toContain('sk-synthetic');
    expect(r.index.refused).toBe(1);
    expect(r.index.failed).toBe(1);
    const failed = h.ctx.db.all<{ chunk_id: string }>(`SELECT s.chunk_id FROM chunk_index_status s JOIN memory_chunks c ON c.id = s.chunk_id WHERE s.status = 'failed' AND c.document_id = ?`, [d.documentId]);
    expect(failed).toHaveLength(1);
    expect(h.qdrant.pointsFor(collectionOf()).some((p) => p.payload.document_id === d.documentId)).toBe(false);
  });

  it('Qdrant down: sync is degraded (recorded), nothing is embedded or lost', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    await h.service.sync({ allowPaid: true });
    h.qdrant.down = true;
    ingestDocument(h.ctx, { sourceType: 'decision', sourceRef: 'decision:while-down', title: 'D', text: 'Decided during an outage (synthetic).', trustClass: 'owner_approved' });
    const calls = h.embedder.calls.length;
    const r = await h.service.sync({ allowPaid: true, skipIngest: true });
    expect(r.index.status).toBe('degraded');
    expect(r.index.degradedReason).toMatch(/Qdrant unavailable/);
    expect(h.embedder.calls.length).toBe(calls);
    const st = h.ctx.db.get<{ degraded: number; degraded_reason: string }>('SELECT degraded, degraded_reason FROM memory_index_state')!;
    expect(st.degraded).toBe(1);
    expect(h.ctx.db.get<{ degraded: number }>('SELECT degraded FROM memory_retrieval_state')!.degraded).toBe(1);
    h.qdrant.down = false;
    const ok = await h.service.sync({ allowPaid: true, skipIngest: true });
    expect(ok.index.status).toBe('ok');
    expect(h.ctx.db.get<{ degraded: number }>('SELECT degraded FROM memory_index_state')!.degraded).toBe(0);
  });

  it('skips vector indexing honestly when embeddings are not configured or Qdrant is disabled', async () => {
    h = memoryHarness({ config: memoryConfig({ models: { embedding: null, embeddingDimensions: null } }) });
    installFixtureVault(h.ctx);
    const r = await h.service.sync({ allowPaid: true });
    expect(r.index.status).toBe('skipped');
    expect(r.index.degradedReason).toMatch(/No embedding model configured/);
    expect(r.index.plan.paid.required).toBe(false);
    expect(r.ingest!.bySourceType.business_note!.created).toBe(3); // FTS memory still works
    expect(h.qdrant.requests).toHaveLength(0);
    h.ctx.cleanup();

    // Not configured (enabled but unusable) stays degraded.
    expect(r.index.degraded).toBe(true);
    expect(r.index.policy).toBe(false);
    h.ctx.cleanup();

    // C5-02: Qdrant disabled by configuration is full-text only BY POLICY: skipped, not degraded, the reason kept.
    h = memoryHarness({ config: memoryConfig({ features: { qdrant: false } }) });
    const r2 = await h.service.sync({ allowPaid: true });
    expect(r2.index.status).toBe('skipped');
    expect(r2.index.policy).toBe(true);
    expect(r2.index.degraded).toBe(false);
    expect(r2.index.degradedReason).toBeNull();
    expect(r2.index.policyReason).toMatch(/Qdrant is disabled/);
    expect(r2.index.policyFlags).toEqual(['features.qdrant']);
    expect(r2.index.messages.join(' ')).toMatch(/Full-text only by policy \(not degraded\)/);
    expect(h.embedder.calls).toHaveLength(0);
    expect(h.ctx.db.get<{ last_method: string; degraded: number }>('SELECT last_method, degraded FROM memory_retrieval_state')).toEqual({ last_method: 'fts_only', degraded: 0 });
  });

  it('embeddings disabled by configuration (or both paths, e.g. the Core profile) is policy, even when the other path is not configured (C5-02)', async () => {
    h = memoryHarness({ config: memoryConfig({ features: { embeddings: false } }) });
    const r = await h.service.sync({ allowPaid: true });
    expect(r.index).toMatchObject({ status: 'skipped', policy: true, degraded: false, degradedReason: null, policyFlags: ['features.embeddings'] });
    expect(r.index.policyReason).toMatch(/Embeddings are disabled/);
    h.ctx.cleanup();

    // Qdrant off by configuration and no embedding model: vectors need both, and one is off by policy.
    h = memoryHarness({ config: memoryConfig({ features: { qdrant: false }, models: { embedding: null, embeddingDimensions: null } }) });
    const r2 = await h.service.sync({ allowPaid: true });
    expect(r2.index).toMatchObject({ status: 'skipped', policy: true, degraded: false, policyFlags: ['features.qdrant'] });
    h.ctx.cleanup();

    h = memoryHarness({ config: memoryConfig({ features: { qdrant: false, embeddings: false } }) });
    const r3 = await h.service.sync({ allowPaid: true });
    expect(r3.index).toMatchObject({ status: 'skipped', policy: true, degraded: false, policyFlags: ['features.embeddings', 'features.qdrant'] });
    expect(r3.index.policyReason).toMatch(/Embeddings and Qdrant are disabled/);
    // Dry runs, rebuilds, and reconciles report the same policy.
    expect((await h.service.sync({ dryRun: true, allowPaid: false })).index).toMatchObject({ policy: true, degraded: false });
    expect(await h.service.rebuild({ allowPaid: false })).toMatchObject({ policy: true, degraded: false });
    expect(await h.service.reconcile()).toMatchObject({ policy: true, degraded: false });
    expect(h.ctx.db.get<{ degraded: number }>('SELECT degraded FROM memory_retrieval_state')!.degraded).toBe(0);
  });

  it('stops embedding after a budget failure and leaves the rest pending', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    h.embedder.failWith = { status: 'budget_exceeded', reason: 'per-run cap reached (synthetic)' };
    const r = await h.service.sync({ allowPaid: true });
    expect(r.index.status).toBe('partial');
    expect(r.index.messages.join(' ')).toMatch(/budget_exceeded/);
    expect(h.embedder.calls).toHaveLength(1);
    expect(h.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM embedding_cache')!.n).toBe(0);
  });
});
