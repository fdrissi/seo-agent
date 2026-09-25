import { afterEach, describe, expect, it } from 'vitest';
import { ingestDocument, markDocumentDeleted, propagateMissing, purgeDocument, type DocumentInput } from '../../../src/memory/documents.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { memoryConfig } from '../../fixtures/memory/setup.js';

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

const doc = (over: Partial<DocumentInput> = {}): DocumentInput => ({
  sourceType: 'business_note',
  sourceRef: '01 Business/Offer.md',
  title: 'Offer',
  text: '# Offer\n\nWe sell modular desk organizers (synthetic).\n\n## Delivery\n\nShips in two days.',
  trustClass: 'owner_approved',
  language: 'en',
  ...over,
});

function chunks(docId: string) {
  return ctx.db.all<{ id: string; document_version: number; superseded: number; content_hash: string; site_id: string }>(
    'SELECT id, document_version, superseded, content_hash, site_id FROM memory_chunks WHERE document_id = ? ORDER BY document_version, chunk_index',
    [docId],
  );
}

describe('memory document ingestion and versioning', () => {
  it('creates, detects unchanged content, and stores chunks with site_id, heading path, version, and FTS rows', () => {
    ctx = createTestContext({ config: memoryConfig() });
    const r1 = ingestDocument(ctx, doc());
    expect(r1).toMatchObject({ action: 'created', version: 1 });
    const cs = chunks(r1.documentId!);
    expect(cs.length).toBe(r1.chunks);
    expect(cs.every((c) => c.site_id === 'test-site' && c.document_version === 1 && c.superseded === 0)).toBe(true);
    const fts = ctx.db.all("SELECT rowid FROM memory_chunks_fts WHERE memory_chunks_fts MATCH 'organizers'");
    expect(fts.length).toBe(1);
    expect(ingestDocument(ctx, doc({ text: doc().text.replace('organizers', 'organizers  ') }))).toMatchObject({ action: 'unchanged' });
  });

  it('changed content creates a new version, supersedes old chunks, and tombstones only removed indexed content', () => {
    ctx = createTestContext({ config: memoryConfig() });
    const text = '# Offer\n\n' + Array.from({ length: 6 }, (_, i) => `## Part ${i}\n\n${`Paragraph ${i} about organizers and trays. `.repeat(40)}`).join('\n\n');
    const r1 = ingestDocument(ctx, doc({ text }));
    const v1 = chunks(r1.documentId!);
    expect(v1.length).toBeGreaterThan(2);
    // Simulate a previous sync: every v1 chunk indexed in some embedding version.
    ctx.db.run(`INSERT INTO embedding_versions (id, provider, model_id, dimensions, chunker_version, collection_name, status, created_at) VALUES ('emv_t', 'fixture', 'm', 8, 'c', 'col_t', 'active', '2026-09-24T00:00:00Z')`);
    for (const c of v1) {
      ctx.db.run(`INSERT INTO chunk_index_status (chunk_id, embedding_version_id, site_id, point_id, content_hash, status, updated_at) VALUES (?, 'emv_t', 'test-site', ?, ?, 'indexed', '2026-09-24T00:00:00Z')`, [
        c.id,
        `p-${c.id}`,
        c.content_hash,
      ]);
    }
    // Change only the last part.
    const changed = text.replace(/Paragraph 5 about organizers and trays\. /g, 'Paragraph five was rewritten entirely. ');
    const r2 = ingestDocument(ctx, doc({ text: changed }));
    expect(r2).toMatchObject({ action: 'new_version', version: 2 });
    const all = chunks(r1.documentId!);
    expect(all.filter((c) => c.document_version === 1).every((c) => c.superseded === 1)).toBe(true);
    expect(all.filter((c) => c.document_version === 2).every((c) => c.superseded === 0)).toBe(true);
    const newHashes = new Set(all.filter((c) => c.document_version === 2).map((c) => c.content_hash));
    const removed = v1.filter((c) => !newHashes.has(c.content_hash));
    expect(removed.length).toBeGreaterThan(0);
    expect(removed.length).toBeLessThan(v1.length);
    const tomb = ctx.db.all<{ chunk_id: string; point_id: string; site_id: string }>('SELECT chunk_id, point_id, site_id FROM memory_tombstones');
    expect(r2.tombstones).toBe(removed.length);
    expect(tomb.map((t) => t.chunk_id).sort()).toEqual(removed.map((c) => c.id).sort());
    expect(tomb.every((t) => t.site_id === 'test-site')).toBe(true);
    // Removed chunks' rows are marked deleted; surviving chunks' rows move to the v2 chunk rows as 'pending'
    // (payload refresh from the cache) and keep indexed_at, so a later edit/delete still tombstones their point.
    const rows = ctx.db.all<{ chunk_id: string; status: string; point_id: string; indexed_at: string | null }>('SELECT chunk_id, status, point_id, indexed_at FROM chunk_index_status');
    const v1Ids = new Set(v1.map((c) => c.id));
    const deletedRows = rows.filter((r) => r.status === 'deleted');
    expect(deletedRows.map((r) => r.chunk_id).sort()).toEqual(removed.map((c) => c.id).sort());
    const moved = rows.filter((r) => r.status !== 'deleted');
    expect(moved).toHaveLength(v1.length - removed.length);
    expect(moved.every((r) => r.status === 'pending' && !v1Ids.has(r.chunk_id) && r.indexed_at !== null)).toBe(true);
    const survivorPointIds = v1.filter((c) => !removed.includes(c)).map((c) => `p-${c.id}`).sort();
    expect(moved.map((r) => r.point_id).sort()).toEqual(survivorPointIds); // same Qdrant points, no new vectors
  });

  it('metadata-only change keeps the version and marks vectors for a payload refresh', () => {
    ctx = createTestContext({ config: memoryConfig() });
    const r1 = ingestDocument(ctx, doc());
    ctx.db.run(`INSERT INTO embedding_versions (id, provider, model_id, dimensions, chunker_version, collection_name, status, created_at) VALUES ('emv_t', 'fixture', 'm', 8, 'c', 'col_t', 'active', '2026-09-24T00:00:00Z')`);
    for (const c of chunks(r1.documentId!)) {
      ctx.db.run(`INSERT INTO chunk_index_status (chunk_id, embedding_version_id, site_id, point_id, content_hash, status, updated_at) VALUES (?, 'emv_t', 'test-site', 'p', ?, 'indexed', 'x')`, [c.id, c.content_hash]);
    }
    const r2 = ingestDocument(ctx, doc({ trustClass: 'user_reported' }));
    expect(r2).toMatchObject({ action: 'metadata_updated', version: 1 });
    expect(ctx.db.all<{ status: string }>('SELECT status FROM chunk_index_status').every((s) => s.status === 'pending')).toBe(true);
  });

  it('rejects documents containing secrets: nothing stored, audited without the value', () => {
    ctx = createTestContext({ config: memoryConfig() });
    const r = ingestDocument(ctx, doc({ text: 'Gateway key: sk-thisisasyntheticsecretvalue123456 do not share' }));
    expect(r).toMatchObject({ action: 'rejected', reason: 'secret_detected' });
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memory_chunks')!.n).toBe(0);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_chunks WHERE text LIKE '%sk-this%'")!.n).toBe(0);
    const audit = ctx.db.all<{ event_type: string; details_json: string }>("SELECT event_type, details_json FROM audit_events WHERE event_type = 'memory.document_rejected'");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details_json).not.toContain('thisisasyntheticsecret');
    expect(JSON.stringify(ctx.logEntries)).not.toContain('thisisasyntheticsecret');
  });

  it('redacts personal identifiers and rejects raw metrics dumps and invalid inputs', () => {
    ctx = createTestContext({ config: memoryConfig() });
    const r = ingestDocument(ctx, doc({ text: 'Customer jane@example.test wrote from 198.51.100.7 (synthetic).' }));
    expect(r.action).toBe('created');
    expect(r.piiRedactions).toMatchObject({ email: 1, ip_address: 1 });
    const text = ctx.db.get<{ text: string }>('SELECT text FROM memory_chunks')!.text;
    expect(text).not.toContain('jane@example.test');
    expect(text).toContain('[EMAIL]');
    const rows = Array.from({ length: 40 }, (_, i) => `/p${i},${i},${i * 2},${i / 10}`).join('\n');
    expect(ingestDocument(ctx, doc({ sourceRef: 'x.md', text: rows }))).toMatchObject({ action: 'rejected', reason: 'raw_metrics' });
    expect(ingestDocument(ctx, doc({ sourceType: 'rejected_proposal', sourceRef: 'recommendation:r1', status: 'active' }))).toMatchObject({ action: 'rejected', reason: 'invalid' });
    const rej = ingestDocument(ctx, doc({ sourceType: 'rejected_proposal', sourceRef: 'recommendation:r2', trustClass: 'model_generated' }));
    expect(ctx.db.get<{ status: string; record_status: string }>('SELECT status, record_status FROM memory_documents WHERE id = ?', [rej.documentId])).toEqual({ status: 'rejected', record_status: 'rejected' });
  });

  it('stores wikilinks and link keys; deletion propagation tombstones indexed vectors; purge removes rows', () => {
    ctx = createTestContext({ config: memoryConfig() });
    const a = ingestDocument(ctx, doc({ text: '# Offer\n\nSee [[01 Business/Pricing]] and [[Audience|who]].' }));
    ingestDocument(ctx, doc({ sourceRef: '01 Business/Pricing.md', title: 'Pricing', text: '# Pricing\n\n49 EUR (synthetic).' }));
    expect(ctx.db.all<{ target_key: string }>('SELECT target_key FROM memory_links WHERE from_document_id = ? ORDER BY target_key', [a.documentId]).map((r) => r.target_key)).toEqual([
      '01 business/pricing',
      'audience',
    ]);
    expect(ctx.db.all("SELECT * FROM memory_document_keys WHERE link_key = 'pricing'")).toHaveLength(1);

    ctx.db.run(`INSERT INTO embedding_versions (id, provider, model_id, dimensions, chunker_version, collection_name, status, created_at) VALUES ('emv_t', 'fixture', 'm', 8, 'c', 'col_t', 'active', 'x')`);
    for (const c of chunks(a.documentId!)) ctx.db.run(`INSERT INTO chunk_index_status (chunk_id, embedding_version_id, site_id, point_id, content_hash, status, updated_at) VALUES (?, 'emv_t', 'test-site', 'p1', ?, 'indexed', 'x')`, [c.id, c.content_hash]);

    const dry = propagateMissing(ctx, 'business_note', new Set(['01 Business/Pricing.md']), { dryRun: true });
    expect(dry.deleted).toEqual(['01 Business/Offer.md']);
    expect(ctx.db.get<{ status: string }>('SELECT status FROM memory_documents WHERE id = ?', [a.documentId])!.status).toBe('active');

    const p = propagateMissing(ctx, 'business_note', new Set(['01 Business/Pricing.md']));
    expect(p.deleted).toEqual(['01 Business/Offer.md']);
    expect(p.tombstones).toBe(1);
    expect(ctx.db.get<{ status: string }>('SELECT status FROM memory_documents WHERE id = ?', [a.documentId])!.status).toBe('deleted');
    expect(ctx.db.all('SELECT * FROM memory_links WHERE from_document_id = ?', [a.documentId])).toHaveLength(0);
    expect(markDocumentDeleted(ctx, a.documentId!, 'again').tombstones).toBe(0);

    const purged = purgeDocument(ctx, a.documentId!, 'retention');
    expect(purged.purged).toBe(true);
    expect(ctx.db.all('SELECT * FROM memory_chunks WHERE document_id = ?', [a.documentId])).toHaveLength(0);
    expect(ctx.db.all("SELECT rowid FROM memory_chunks_fts WHERE memory_chunks_fts MATCH 'offer'")).toHaveLength(0);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memory_tombstones')!.n).toBe(1); // tombstones kept for audit
  });

  it('a document restored after deletion becomes a new active version', () => {
    ctx = createTestContext({ config: memoryConfig() });
    const a = ingestDocument(ctx, doc());
    markDocumentDeleted(ctx, a.documentId!, 'test');
    const b = ingestDocument(ctx, doc());
    expect(b).toMatchObject({ action: 'new_version', version: 2 });
    expect(ctx.db.get<{ status: string }>('SELECT status FROM memory_documents WHERE id = ?', [a.documentId])!.status).toBe('active');
  });
});
