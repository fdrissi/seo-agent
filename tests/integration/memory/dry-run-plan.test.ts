/**
 * `memory sync --dry-run` must plan what the real run will do, including the
 * documents its ingest would create or change (SYNTHETIC vault, fake Qdrant
 * + fake embedder, offline).
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installFixtureVault, memoryHarness, type MemoryHarness } from '../../fixtures/memory/setup.js';

let h: MemoryHarness;
afterEach(() => h?.ctx.cleanup());

function counts() {
  const n = (sql: string) => h.ctx.db.get<{ n: number }>(sql)!.n;
  return {
    documents: n('SELECT COUNT(*) AS n FROM memory_documents'),
    chunks: n('SELECT COUNT(*) AS n FROM memory_chunks'),
    tombstones: n('SELECT COUNT(*) AS n FROM memory_tombstones'),
    audit: n(`SELECT COUNT(*) AS n FROM audit_events WHERE event_type LIKE 'memory.%'`),
    indexRows: n('SELECT COUNT(*) AS n FROM chunk_index_status'),
  };
}

describe('memory sync --dry-run plan', () => {
  it('first run: the plan counts the chunks the ingest would create and says paid embeddings are needed', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    const before = counts();
    const dry = await h.service.sync({ dryRun: true, allowPaid: true });
    expect(counts()).toEqual(before); // nothing persisted
    expect(h.qdrant.requests).toHaveLength(0);
    expect(h.embedder.calls).toHaveLength(0);
    expect(dry.ingest!.dryRun).toBe(true);
    expect(dry.ingest!.bySourceType.business_note!.created).toBe(3);
    expect(dry.index.plan.chunks.current).toBeGreaterThan(0);
    expect(dry.index.plan.paid.required).toBe(true);
    expect(dry.index.messages.join(' ')).toMatch(/simulating this run's ingest/);

    const real = await h.service.sync({ allowPaid: false });
    expect(dry.index.plan.chunks).toEqual(real.index.plan.chunks);
    expect(dry.index.plan.cache).toEqual(real.index.plan.cache);
    expect(dry.index.plan.paid.items).toBe(real.index.plan.paid.items);
    expect(dry.index.plan.paid.estimatedTokens).toBe(real.index.plan.paid.estimatedTokens);
    expect(real.index.skippedPaid).toBe(dry.index.plan.cache.misses);
  });

  it('after an edit: the plan shows the changed chunk as a paid miss and the pending tombstone, like the real run', async () => {
    h = memoryHarness();
    const vault = installFixtureVault(h.ctx);
    await h.service.sync({ allowPaid: true });
    writeFileSync(path.join(vault, '01 Business', 'Pricing.md'), '# Pricing\n\nAll starter bundles now cost 61 EUR (synthetic).\n');

    const before = counts();
    const dry = await h.service.sync({ dryRun: true, allowPaid: true });
    expect(counts()).toEqual(before);
    expect(dry.ingest!.bySourceType.business_note).toMatchObject({ newVersion: 1, created: 0, deleted: 0 });
    expect(dry.index.plan.cache.misses).toBe(1);
    expect(dry.index.plan.paid.required).toBe(true);
    expect(dry.index.plan.tombstonesPending).toBeGreaterThan(0);

    const embeddedBefore = h.embedder.textsEmbedded.length;
    const real = await h.service.sync({ allowPaid: true });
    expect(dry.index.plan.chunks).toEqual(real.index.plan.chunks);
    expect(dry.index.plan.cache).toEqual(real.index.plan.cache);
    expect(dry.index.plan.tombstonesPending).toBe(real.index.plan.tombstonesPending);
    expect(real.index.embedded).toBe(1);
    expect(h.embedder.textsEmbedded.length - embeddedBefore).toBe(dry.index.plan.cache.misses);
  });

  it('nothing changed: the plan honestly says no paid embeddings are needed', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    await h.service.sync({ allowPaid: true });
    const dry = await h.service.sync({ dryRun: true, allowPaid: true });
    expect(dry.index.plan.chunks.pending).toBe(0);
    expect(dry.index.plan.paid.required).toBe(false);
  });
});
