/**
 * Deletion propagation when a document changes more than once between two
 * syncs (SYNTHETIC documents, fake Qdrant + fake embedder, offline).
 *
 * Invariant checked after every final sync: the Qdrant points whose payload
 * names the document are exactly the points of its current chunks (none when
 * it was deleted/purged), there is nothing left for reconcile to delete, and
 * no tombstone is pending.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ingestDocument, markDocumentDeleted, purgeDocument, withOccurrences, type DocumentInput } from '../../../src/memory/documents.js';
import { pointIdFor } from '../../../src/memory/uuid.js';
import { memoryHarness, type MemoryHarness } from '../../fixtures/memory/setup.js';

let h: MemoryHarness;
afterEach(() => h?.ctx.cleanup());

/** One section large enough to be its own chunk (default chunkMinTokens 400). */
const section = (name: string) => `## ${name}\n\n${`${name} section about modular desk trays and how they are packed (synthetic). `.repeat(30)}`;
const guide = (...names: string[]) => `# Guide\n\n${names.map(section).join('\n\n')}`;
const base: Omit<DocumentInput, 'text'> = { sourceType: 'decision', sourceRef: 'manual:guide', title: 'Guide (synthetic)', trustClass: 'owner_approved', language: 'en' };

function collection(): string {
  return h.ctx.db.get<{ collection_name: string }>('SELECT collection_name FROM embedding_versions')!.collection_name;
}

function pointsOf(docId: string): string[] {
  return h.qdrant
    .pointsFor(collection())
    .filter((p) => p.payload.document_id === docId)
    .map((p) => String(p.id).toLowerCase())
    .sort();
}

function expectedPoints(docId: string): string[] {
  const rows = h.ctx.db.all<{ content_hash: string }>(
    `SELECT c.content_hash FROM memory_chunks c JOIN memory_documents d ON d.id = c.document_id
     WHERE c.document_id = ? AND c.site_id = ? AND c.superseded = 0 AND c.document_version = d.version AND d.status IN ('active', 'rejected')
     ORDER BY c.chunk_index`,
    [docId, h.ctx.siteId],
  );
  return withOccurrences(rows)
    .map((c) => pointIdFor(h.ctx.siteId, docId, c.content_hash, c.occurrence))
    .sort();
}

function pendingTombstones(): number {
  return h.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memory_tombstones WHERE propagated_at IS NULL')!.n;
}

async function syncedDoc(...names: string[]): Promise<string> {
  const d = ingestDocument(h.ctx, { ...base, text: guide(...names) });
  expect(d.chunks).toBe(names.length); // one chunk per section
  const r = await h.service.sync({ allowPaid: true, skipIngest: true });
  expect(r.index.status).toBe('ok');
  expect(pointsOf(d.documentId!)).toEqual(expectedPoints(d.documentId!));
  expect(pointsOf(d.documentId!)).toHaveLength(names.length);
  return d.documentId!;
}

async function expectConverged(docId: string, sync: { index: { status: string } }): Promise<void> {
  expect(sync.index.status).toBe('ok');
  expect(pointsOf(docId)).toEqual(expectedPoints(docId));
  expect(pendingTombstones()).toBe(0);
  const rec = await h.service.reconcile({ dryRun: true });
  expect(rec.orphanIds).toEqual([]);
  expect(rec.missingIds).toEqual([]);
}

describe('deletion propagation across several changes between syncs', () => {
  it('edit, sync: surviving content keeps its point (payload refreshed from the cache, no re-embedding)', async () => {
    h = memoryHarness();
    const doc = await syncedDoc('Alpha', 'Beta');
    const alphaPoint = h.qdrant.pointsFor(collection()).find((p) => p.payload.document_id === doc && p.payload.document_version === 1)!;
    const embeddedBefore = h.embedder.textsEmbedded.length;
    ingestDocument(h.ctx, { ...base, text: guide('Alpha', 'Gamma') });
    const r = await h.service.sync({ allowPaid: true, skipIngest: true });
    await expectConverged(doc, r);
    const newlyEmbedded = h.embedder.textsEmbedded.slice(embeddedBefore);
    expect(newlyEmbedded).toHaveLength(1);
    expect(newlyEmbedded[0]).toMatch(/Gamma/);
    const pts = h.qdrant.pointsFor(collection()).filter((p) => p.payload.document_id === doc);
    expect(pts.every((p) => p.payload.document_version === 2)).toBe(true);
    expect(pts.some((p) => String(p.id) === String(alphaPoint.id))).toBe(true);
  });

  it('edit, edit, sync: content present only in the intermediate version never lingers', async () => {
    h = memoryHarness();
    const doc = await syncedDoc('Alpha', 'Beta');
    ingestDocument(h.ctx, { ...base, text: guide('Alpha', 'Gamma') });
    ingestDocument(h.ctx, { ...base, text: guide('Gamma', 'Delta') });
    const r = await h.service.sync({ allowPaid: true, skipIngest: true });
    await expectConverged(doc, r);
    expect(pointsOf(doc)).toHaveLength(2);
    expect(r.index.tombstonesPropagated).toBeGreaterThanOrEqual(2); // Beta (v1->v2) and Alpha (v2->v3)
  });

  it('edit, delete, sync: every point of the document is removed', async () => {
    h = memoryHarness();
    const doc = await syncedDoc('Alpha', 'Beta');
    ingestDocument(h.ctx, { ...base, text: guide('Alpha', 'Gamma') });
    const del = markDocumentDeleted(h.ctx, doc, 'test');
    expect(del.tombstones).toBe(1); // Alpha's surviving point (Beta was tombstoned by the edit)
    const r = await h.service.sync({ allowPaid: true, skipIngest: true });
    await expectConverged(doc, r);
    expect(pointsOf(doc)).toEqual([]);
  });

  it('metadata change, delete, sync: every point of the document is removed', async () => {
    h = memoryHarness();
    const doc = await syncedDoc('Alpha', 'Beta');
    const meta = ingestDocument(h.ctx, { ...base, text: guide('Alpha', 'Beta'), trustClass: 'user_reported' });
    expect(meta.action).toBe('metadata_updated');
    expect(markDocumentDeleted(h.ctx, doc, 'test', { dryRun: true }).tombstones).toBe(2);
    expect(markDocumentDeleted(h.ctx, doc, 'test').tombstones).toBe(2);
    const r = await h.service.sync({ allowPaid: true, skipIngest: true });
    await expectConverged(doc, r);
    expect(pointsOf(doc)).toEqual([]);
  });

  it('purge after an unsynced edit removes every point of the document', async () => {
    h = memoryHarness();
    const doc = await syncedDoc('Alpha', 'Beta');
    ingestDocument(h.ctx, { ...base, text: guide('Alpha', 'Gamma') });
    const p = purgeDocument(h.ctx, doc, 'retention');
    expect(p).toEqual({ purged: true, tombstones: 1 });
    const r = await h.service.sync({ allowPaid: true, skipIngest: true });
    expect(r.index.status).toBe('ok');
    expect(pointsOf(doc)).toEqual([]);
    expect(pendingTombstones()).toBe(0);
    expect((await h.service.reconcile({ dryRun: true })).orphanIds).toEqual([]);
  });

  it('content that moves back is never deleted by a stale tombstone', async () => {
    h = memoryHarness();
    const doc = await syncedDoc('Alpha', 'Beta');
    ingestDocument(h.ctx, { ...base, text: guide('Alpha', 'Gamma') }); // tombstones Beta
    ingestDocument(h.ctx, { ...base, text: guide('Alpha', 'Beta') }); // Beta is back before the sync
    const r = await h.service.sync({ allowPaid: true, skipIngest: true });
    await expectConverged(doc, r);
    expect(pointsOf(doc)).toHaveLength(2);
  });
});
