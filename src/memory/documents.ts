import type { AppContext } from '../app/context.js';
import { normalizedContentHash } from '../core/hash.js';
import { newId } from '../core/ids.js';
import { TRUST_CLASSES, type TrustClass } from '../core/modes.js';
import { recordAudit } from '../database/audit.js';
import { CHUNKER_VERSION, chunkMarkdown, chunkerOptionsFromConfig, type Chunk } from './chunker.js';
import { documentLinkKeys, extractLinks } from './markdown.js';
import { MEMORY_SOURCE_TYPES, type AccessScope, type DocumentStatus, type MemoryChunkRow, type MemoryDocumentRow } from './memory-types.js';
import { sanitizeForMemory, type PiiKind, type SecretFindingKind } from './sanitize.js';
import type { MemorySourceType } from './types.js';

/**
 * Memory documents: ingestion into memory_documents / memory_chunks (the FTS5
 * index is maintained by triggers), versioning, supersession, deletion
 * propagation via tombstones, and wikilink bookkeeping.
 *
 * Versioning rules:
 * - (site_id, source_type, source_ref) identifies a document.
 * - Unchanged content -> no-op (metadata-only changes update the row and mark
 *   the chunks' vectors for a payload refresh, without re-embedding).
 * - Changed content -> version + 1. The previous version's chunks are kept
 *   (superseded = 1) for history and FTS with includeSuperseded. Chunks whose
 *   content survives keep their Qdrant point (same deterministic point id,
 *   vector reused from the cache): their index rows move to the new chunk
 *   rows as 'pending' (payload refresh from the cache, no paid call) and
 *   keep `indexed_at`, so a later edit or deletion still tombstones the
 *   point. Chunks whose content was removed get a tombstone so their vectors
 *   are deleted from Qdrant.
 * - Deleted documents: status 'deleted', all chunks superseded, tombstones for
 *   every vector that may exist.
 *
 * "A vector may exist" = an index row with status 'indexed', or any
 * non-deleted row that was indexed at least once (`indexed_at` is kept by
 * later 'pending'/'failed' updates). This keeps deletion propagation correct
 * when a document changes several times (or changes, then is deleted)
 * between two syncs. propagateTombstones never deletes a point that current
 * chunks still expect.
 *
 * Synthetic workspaces (demo profile, ctx.synthetic): every document is stored
 * with trust_class 'synthetic' whatever its source claims, so demo records
 * are never boosted or shown as owner-approved facts.
 */

export type MemoryCtx = Pick<AppContext, 'db' | 'siteId' | 'clock' | 'config' | 'logger'> & Partial<Pick<AppContext, 'synthetic'>>;

/** SQL predicate over chunk_index_status rows whose Qdrant point may exist. */
export const MAY_HAVE_POINT_SQL = `(status = 'indexed' OR (status != 'deleted' AND indexed_at IS NOT NULL))`;

export interface DocumentInput {
  sourceType: MemorySourceType;
  /** Vault-relative note path, record reference (e.g. "recommendation:rec_123"), or source id. */
  sourceRef: string;
  title: string;
  /** Markdown text without frontmatter. */
  text: string;
  sourceUrl?: string | null;
  language?: string | null;
  trustClass: TrustClass;
  status?: Exclude<DocumentStatus, 'deleted'>;
  recordStatus?: string | null;
  accessScope?: AccessScope;
  sourceDate?: string | null;
  /** Extra keys wikilinks may use to reach this document (e.g. its vault note path). */
  linkAliases?: string[];
}

export type IngestAction = 'created' | 'new_version' | 'metadata_updated' | 'unchanged' | 'rejected';

export interface IngestOutcome {
  action: IngestAction;
  sourceType: MemorySourceType;
  sourceRef: string;
  documentId: string | null;
  version: number | null;
  chunks: number;
  tombstones: number;
  piiRedactions?: Partial<Record<PiiKind, number>>;
  /** For rejected documents: why (never includes the offending value). */
  reason?: 'secret_detected' | 'raw_metrics' | 'invalid' | 'empty';
  detail?: string;
  findings?: Array<SecretFindingKind | string>;
}

const MAX_REF_LENGTH = 1024;
const MAX_TEXT_CHARS = 2_000_000;

function now(ctx: MemoryCtx): string {
  return ctx.clock.now().toISOString();
}

/** Assign occurrence numbers to chunks with identical content hashes (in chunk order). */
export function withOccurrences<T extends { content_hash?: string; contentHash?: string }>(chunks: T[]): Array<T & { occurrence: number }> {
  const seen = new Map<string, number>();
  return chunks.map((c) => {
    const h = (c.content_hash ?? c.contentHash)!;
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    return { ...c, occurrence: n };
  });
}

function validate(input: DocumentInput): string | null {
  if (!MEMORY_SOURCE_TYPES.includes(input.sourceType)) return `unknown source type "${input.sourceType}"`;
  if (!(TRUST_CLASSES as readonly string[]).includes(input.trustClass)) return `unknown trust class "${input.trustClass}"`;
  if (!input.sourceRef || input.sourceRef.length > MAX_REF_LENGTH) return 'sourceRef must be 1..1024 characters';
  if (!input.title?.trim()) return 'title is required';
  if (input.text.length > MAX_TEXT_CHARS) return `text exceeds ${MAX_TEXT_CHARS} characters`;
  if (input.sourceType === 'rejected_proposal' && input.status && input.status !== 'rejected' && input.status !== 'superseded') {
    return 'rejected proposals must keep status "rejected" so they are never mistaken for recommendations';
  }
  return null;
}

export function getDocument(ctx: MemoryCtx, sourceType: MemorySourceType, sourceRef: string): MemoryDocumentRow | undefined {
  return ctx.db.get<MemoryDocumentRow>('SELECT * FROM memory_documents WHERE site_id = ? AND source_type = ? AND source_ref = ?', [ctx.siteId, sourceType, sourceRef]);
}

export function getDocumentById(ctx: MemoryCtx, id: string): MemoryDocumentRow | undefined {
  return ctx.db.get<MemoryDocumentRow>('SELECT * FROM memory_documents WHERE site_id = ? AND id = ?', [ctx.siteId, id]);
}

export function currentChunks(ctx: MemoryCtx, documentId: string): MemoryChunkRow[] {
  return ctx.db.all<MemoryChunkRow>(
    `SELECT c.* FROM memory_chunks c JOIN memory_documents d ON d.id = c.document_id
     WHERE c.site_id = ? AND d.site_id = ? AND c.document_id = ? AND c.document_version = d.version
     ORDER BY c.chunk_index`,
    [ctx.siteId, ctx.siteId, documentId],
  );
}

/**
 * Tombstone every vector of the given chunks that may exist in Qdrant and drop
 * their other per-chunk index rows. Must run inside a transaction.
 */
function tombstoneChunks(ctx: MemoryCtx, documentId: string, chunkIds: string[], reason: string): number {
  let n = 0;
  const at = now(ctx);
  for (const chunkId of chunkIds) {
    const rows = ctx.db.all<{ embedding_version_id: string; point_id: string; status: string; indexed_at: string | null }>(
      'SELECT embedding_version_id, point_id, status, indexed_at FROM chunk_index_status WHERE site_id = ? AND chunk_id = ?',
      [ctx.siteId, chunkId],
    );
    for (const r of rows) {
      const mayHavePoint = r.status === 'indexed' || (r.status !== 'deleted' && r.indexed_at !== null);
      if (mayHavePoint) {
        ctx.db.run(
          `INSERT INTO memory_tombstones (id, site_id, document_id, chunk_id, point_id, embedding_version_id, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [newId('mtb'), ctx.siteId, documentId, chunkId, r.point_id, r.embedding_version_id, reason, at],
        );
        ctx.db.run(`UPDATE chunk_index_status SET status = 'deleted', updated_at = ? WHERE chunk_id = ? AND embedding_version_id = ? AND site_id = ?`, [
          at,
          chunkId,
          r.embedding_version_id,
          ctx.siteId,
        ]);
        n++;
      } else {
        // Never indexed (pending/failed without indexed_at) or already tombstoned: nothing to propagate.
        ctx.db.run('DELETE FROM chunk_index_status WHERE chunk_id = ? AND embedding_version_id = ? AND site_id = ?', [chunkId, r.embedding_version_id, ctx.siteId]);
      }
    }
  }
  return n;
}

/** Count index rows of the given chunks whose vectors may exist (dry-run tombstone estimate). */
function countMayHavePoint(ctx: MemoryCtx, chunkIds: string[]): number {
  let n = 0;
  for (let i = 0; i < chunkIds.length; i += 400) {
    const part = chunkIds.slice(i, i + 400);
    n += ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM chunk_index_status WHERE site_id = ? AND ${MAY_HAVE_POINT_SQL} AND chunk_id IN (${part.map(() => '?').join(',')})`, [
      ctx.siteId,
      ...part,
    ])!.n;
  }
  return n;
}

/**
 * Move the index rows of surviving chunks (same content + occurrence) to the
 * chunk rows of the new version. The Qdrant point id is content-addressed per
 * document, so the point is the same; the row becomes 'pending' so the next
 * sync refreshes its payload from the embedding cache, and keeps `indexed_at`
 * so the point is tombstoned if the content is later removed. Must run inside
 * a transaction, after the new chunks were inserted.
 */
function transferSurvivorIndexRows(ctx: MemoryCtx, documentId: string, newVersion: number, survivors: Array<{ id: string; content_hash: string; occurrence: number }>): void {
  if (!survivors.length) return;
  const at = now(ctx);
  const newRows = withOccurrences(
    ctx.db.all<{ id: string; content_hash: string }>('SELECT id, content_hash FROM memory_chunks WHERE document_id = ? AND site_id = ? AND document_version = ? ORDER BY chunk_index', [
      documentId,
      ctx.siteId,
      newVersion,
    ]),
  );
  const newIdByKey = new Map(newRows.map((c) => [`${c.content_hash}#${c.occurrence}`, c.id]));
  for (const old of survivors) {
    const target = newIdByKey.get(`${old.content_hash}#${old.occurrence}`);
    const rows = ctx.db.all<{ embedding_version_id: string; point_id: string; content_hash: string; status: string; indexed_at: string | null }>(
      'SELECT embedding_version_id, point_id, content_hash, status, indexed_at FROM chunk_index_status WHERE site_id = ? AND chunk_id = ?',
      [ctx.siteId, old.id],
    );
    for (const r of rows) {
      const mayHavePoint = r.status === 'indexed' || (r.status !== 'deleted' && r.indexed_at !== null);
      if (!mayHavePoint || !target) continue;
      ctx.db.run(
        `INSERT INTO chunk_index_status (chunk_id, embedding_version_id, site_id, point_id, content_hash, status, error, indexed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
         ON CONFLICT (chunk_id, embedding_version_id) DO UPDATE SET point_id = excluded.point_id, content_hash = excluded.content_hash, status = 'pending',
           error = NULL, indexed_at = COALESCE(chunk_index_status.indexed_at, excluded.indexed_at), updated_at = excluded.updated_at`,
        [target, r.embedding_version_id, ctx.siteId, r.point_id, r.content_hash, r.indexed_at ?? at, at],
      );
    }
    ctx.db.run('DELETE FROM chunk_index_status WHERE chunk_id = ? AND site_id = ?', [old.id, ctx.siteId]);
  }
}

function replaceLinks(ctx: MemoryCtx, documentId: string, text: string | null, keys: string[]): void {
  ctx.db.run('DELETE FROM memory_links WHERE from_document_id = ? AND site_id = ?', [documentId, ctx.siteId]);
  ctx.db.run('DELETE FROM memory_document_keys WHERE document_id = ? AND site_id = ?', [documentId, ctx.siteId]);
  if (text === null) return;
  for (const [target, count] of extractLinks(text)) {
    ctx.db.run('INSERT INTO memory_links (site_id, from_document_id, target_key, link_count) VALUES (?, ?, ?, ?)', [ctx.siteId, documentId, target, count]);
  }
  for (const key of keys) {
    ctx.db.run('INSERT OR IGNORE INTO memory_document_keys (site_id, document_id, link_key) VALUES (?, ?, ?)', [ctx.siteId, documentId, key]);
  }
}

function insertChunks(ctx: MemoryCtx, documentId: string, version: number, chunks: Chunk[], language: string, superseded: boolean): void {
  const at = now(ctx);
  for (const c of chunks) {
    ctx.db.run(
      `INSERT INTO memory_chunks (id, document_id, site_id, chunk_index, heading_path, text, token_estimate, content_hash, chunker_version, language, document_version, superseded, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId('mch'), documentId, ctx.siteId, c.index, c.headingPath, c.text, c.tokenEstimate, c.contentHash, CHUNKER_VERSION, language, version, superseded ? 1 : 0, at],
    );
  }
}

/**
 * Ingest one document (create, version, or no-op). With `dryRun`, computes the
 * outcome without writing anything. `quiet` suppresses policy logging (used
 * when the writes are simulated and rolled back for a dry-run plan).
 */
export function ingestDocument(ctx: MemoryCtx, input: DocumentInput, opts: { dryRun?: boolean; quiet?: boolean } = {}): IngestOutcome {
  const base = { sourceType: input.sourceType, sourceRef: input.sourceRef };
  const invalid = validate(input);
  if (invalid) return { ...base, action: 'rejected', reason: 'invalid', detail: invalid, documentId: null, version: null, chunks: 0, tombstones: 0 };

  const title = sanitizeForMemory(input.title);
  const body = sanitizeForMemory(input.text);
  const rejected = !title.ok ? title : !body.ok ? body : null;
  if (rejected && !rejected.ok) {
    const detail =
      rejected.reason === 'secret_detected'
        ? `Credential-like content detected (${rejected.findings.join(', ')}). The document was NOT stored or embedded. Remove the secret from the source and rotate it.`
        : 'Looks like a raw metrics dump. Metrics live in SQLite metric tables and are not embedded row by row.';
    if (!opts.dryRun && !opts.quiet) {
      recordAudit(ctx.db, {
        siteId: ctx.siteId,
        actor: 'system',
        eventType: 'memory.document_rejected',
        subjectType: 'memory_source',
        subjectId: `${input.sourceType}:${input.sourceRef}`,
        details: { reason: rejected.reason, findings: rejected.findings },
        at: ctx.clock.now(),
      });
      ctx.logger.warn('Memory document rejected by content policy', { sourceType: input.sourceType, sourceRef: input.sourceRef, reason: rejected.reason, findings: rejected.findings });
    }
    const existing = getDocument(ctx, input.sourceType, input.sourceRef);
    return { ...base, action: 'rejected', reason: rejected.reason, detail, findings: rejected.findings, documentId: existing?.id ?? null, version: existing?.version ?? null, chunks: 0, tombstones: 0 };
  }
  const cleanTitle = (title as { text: string }).text.trim();
  const cleanText = (body as { text: string }).text;
  const piiRedactions = { ...(title.ok ? title.piiRedactions : {}), ...(body.ok ? body.piiRedactions : {}) };
  if (!cleanText.trim()) return { ...base, action: 'rejected', reason: 'empty', detail: 'document has no text', documentId: null, version: null, chunks: 0, tombstones: 0 };

  const language = (input.language || 'und').trim() || 'und';
  const status: DocumentStatus = input.status ?? (input.sourceType === 'rejected_proposal' ? 'rejected' : 'active');
  const recordStatus = input.recordStatus ?? (input.sourceType === 'rejected_proposal' ? 'rejected' : null);
  const accessScope: AccessScope = input.accessScope ?? 'site';
  const contentHash = normalizedContentHash(cleanText);
  const keys = documentLinkKeys(input.sourceRef, input.linkAliases ?? []);
  const existing = getDocument(ctx, input.sourceType, input.sourceRef);
  const at = now(ctx);
  const chunkOpts = chunkerOptionsFromConfig(ctx.config, language);

  const meta = {
    title: cleanTitle,
    source_url: input.sourceUrl ?? null,
    language,
    // Demo/synthetic workspaces never produce owner-approved or measured facts.
    trust_class: (ctx.synthetic ? 'synthetic' : input.trustClass) as TrustClass,
    status,
    record_status: recordStatus,
    access_scope: accessScope,
    source_date: input.sourceDate ?? null,
  };

  if (!existing) {
    const chunks = chunkMarkdown(cleanText, chunkOpts);
    if (opts.dryRun) return { ...base, action: 'created', documentId: null, version: 1, chunks: chunks.length, tombstones: 0, piiRedactions };
    const id = newId('mdoc');
    ctx.db.transaction(() => {
      ctx.db.run(
        `INSERT INTO memory_documents (id, site_id, source_type, source_ref, source_url, title, language, trust_class, status, record_status, access_scope, version, content_hash, source_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        [id, ctx.siteId, input.sourceType, input.sourceRef, meta.source_url, meta.title, language, meta.trust_class, status, recordStatus, accessScope, contentHash, meta.source_date, at, at],
      );
      insertChunks(ctx, id, 1, chunks, language, status === 'superseded');
      replaceLinks(ctx, id, status === 'superseded' ? null : cleanText, keys);
    });
    return { ...base, action: 'created', documentId: id, version: 1, chunks: chunks.length, tombstones: 0, piiRedactions };
  }

  const cur = currentChunks(ctx, existing.id);
  const chunkerChanged = cur.some((c) => c.chunker_version !== CHUNKER_VERSION);
  const leavingInactive = (existing.status === 'deleted' || existing.status === 'superseded') && status !== 'superseded';
  const contentChanged = existing.content_hash !== contentHash || chunkerChanged || leavingInactive || cur.length === 0;

  if (!contentChanged) {
    const metaChanged =
      existing.title !== meta.title ||
      existing.source_url !== meta.source_url ||
      existing.language !== meta.language ||
      existing.trust_class !== meta.trust_class ||
      existing.status !== meta.status ||
      existing.record_status !== meta.record_status ||
      existing.access_scope !== meta.access_scope ||
      existing.source_date !== meta.source_date;
    if (!metaChanged) {
      if (!opts.dryRun) ctx.db.transaction(() => replaceLinks(ctx, existing.id, existing.status === 'superseded' ? null : cleanText, keys));
      return { ...base, action: 'unchanged', documentId: existing.id, version: existing.version, chunks: cur.length, tombstones: 0, piiRedactions };
    }
    const becomingSuperseded = meta.status === 'superseded' && existing.status !== 'superseded';
    if (opts.dryRun) return { ...base, action: 'metadata_updated', documentId: existing.id, version: existing.version, chunks: cur.length, tombstones: 0, piiRedactions };
    let tombstones = 0;
    ctx.db.transaction(() => {
      ctx.db.run(
        `UPDATE memory_documents SET title = ?, source_url = ?, language = ?, trust_class = ?, status = ?, record_status = ?, access_scope = ?, source_date = ?, updated_at = ?
         WHERE id = ? AND site_id = ?`,
        [meta.title, meta.source_url, meta.language, meta.trust_class, meta.status, meta.record_status, meta.access_scope, meta.source_date, at, existing.id, ctx.siteId],
      );
      if (becomingSuperseded) {
        ctx.db.run('UPDATE memory_chunks SET superseded = 1 WHERE document_id = ? AND site_id = ?', [existing.id, ctx.siteId]);
        tombstones = tombstoneChunks(ctx, existing.id, cur.map((c) => c.id), 'document_superseded');
        replaceLinks(ctx, existing.id, null, keys);
      } else {
        if (meta.language !== existing.language) ctx.db.run('UPDATE memory_chunks SET language = ? WHERE document_id = ? AND document_version = ? AND site_id = ?', [meta.language, existing.id, existing.version, ctx.siteId]);
        // Payload (status/trust/access/...) changed: re-upsert from the cache on the next sync. No re-embedding.
        // indexed_at stays set, so the point is still tombstoned if the document is deleted before that sync.
        ctx.db.run(
          `UPDATE chunk_index_status SET status = 'pending', indexed_at = COALESCE(indexed_at, ?), updated_at = ?
           WHERE site_id = ? AND status = 'indexed' AND chunk_id IN (SELECT id FROM memory_chunks WHERE document_id = ? AND document_version = ? AND site_id = ?)`,
          [at, at, ctx.siteId, existing.id, existing.version, ctx.siteId],
        );
        replaceLinks(ctx, existing.id, cleanText, keys);
      }
    });
    return { ...base, action: 'metadata_updated', documentId: existing.id, version: existing.version, chunks: cur.length, tombstones, piiRedactions };
  }

  // Content changed: new version.
  const chunks = chunkMarkdown(cleanText, chunkOpts);
  const newVersion = existing.version + 1;
  const newKeys = new Set(withOccurrences(chunks).map((c) => `${c.contentHash}#${c.occurrence}`));
  const oldWithOcc = withOccurrences(cur);
  // A superseded new version is not indexed at all, so every old vector goes.
  const removed = status === 'superseded' ? oldWithOcc : oldWithOcc.filter((c) => !newKeys.has(`${c.content_hash}#${c.occurrence}`));
  if (opts.dryRun) {
    return { ...base, action: 'new_version', documentId: existing.id, version: newVersion, chunks: chunks.length, tombstones: countMayHavePoint(ctx, removed.map((c) => c.id)), piiRedactions };
  }
  let tombstones = 0;
  ctx.db.transaction(() => {
    ctx.db.run('UPDATE memory_chunks SET superseded = 1 WHERE document_id = ? AND site_id = ? AND superseded = 0', [existing.id, ctx.siteId]);
    // Surviving content keeps its point (point ids are content-addressed per document): never tombstone those.
    const removedIds = new Set(removed.map((c) => c.id));
    const survivors = oldWithOcc.filter((c) => !removedIds.has(c.id));
    tombstones += tombstoneChunks(ctx, existing.id, removed.map((c) => c.id), 'chunk_removed_in_new_version');
    // Chunks from older superseded versions whose vectors may still exist (should not happen) are tombstoned too.
    const stale = ctx.db.all<{ id: string }>(
      `SELECT DISTINCT c.id FROM memory_chunks c JOIN chunk_index_status s ON s.chunk_id = c.id AND s.site_id = c.site_id
       WHERE c.document_id = ? AND c.site_id = ? AND c.document_version < ?
         AND (s.status = 'indexed' OR (s.status != 'deleted' AND s.indexed_at IS NOT NULL))`,
      [existing.id, ctx.siteId, existing.version],
    );
    tombstones += tombstoneChunks(ctx, existing.id, stale.map((r) => r.id), 'stale_superseded_chunk');
    ctx.db.run(
      `UPDATE memory_documents SET title = ?, source_url = ?, language = ?, trust_class = ?, status = ?, record_status = ?, access_scope = ?, source_date = ?,
         version = ?, content_hash = ?, updated_at = ? WHERE id = ? AND site_id = ?`,
      [meta.title, meta.source_url, meta.language, meta.trust_class, meta.status, meta.record_status, meta.access_scope, meta.source_date, newVersion, contentHash, at, existing.id, ctx.siteId],
    );
    insertChunks(ctx, existing.id, newVersion, chunks, language, status === 'superseded');
    // Survivors' points live on under the new chunk rows (payload refreshed from the cache on the next sync).
    transferSurvivorIndexRows(ctx, existing.id, newVersion, survivors);
    replaceLinks(ctx, existing.id, status === 'superseded' ? null : cleanText, keys);
  });
  return { ...base, action: 'new_version', documentId: existing.id, version: newVersion, chunks: chunks.length, tombstones, piiRedactions };
}

/** Mark a document deleted: chunks superseded, tombstones for every vector that may exist, links removed. */
export function markDocumentDeleted(ctx: MemoryCtx, documentId: string, reason: string, opts: { dryRun?: boolean } = {}): { tombstones: number } {
  const doc = getDocumentById(ctx, documentId);
  if (!doc || doc.status === 'deleted') return { tombstones: 0 };
  const chunkIds = ctx.db.all<{ id: string }>('SELECT id FROM memory_chunks WHERE document_id = ? AND site_id = ?', [documentId, ctx.siteId]).map((r) => r.id);
  if (opts.dryRun) return { tombstones: countMayHavePoint(ctx, chunkIds) };
  let tombstones = 0;
  ctx.db.transaction(() => {
    ctx.db.run(`UPDATE memory_documents SET status = 'deleted', updated_at = ? WHERE id = ? AND site_id = ?`, [now(ctx), documentId, ctx.siteId]);
    ctx.db.run('UPDATE memory_chunks SET superseded = 1 WHERE document_id = ? AND site_id = ?', [documentId, ctx.siteId]);
    tombstones = tombstoneChunks(ctx, documentId, chunkIds, reason);
    ctx.db.run('DELETE FROM memory_links WHERE from_document_id = ? AND site_id = ?', [documentId, ctx.siteId]);
    ctx.db.run('DELETE FROM memory_document_keys WHERE document_id = ? AND site_id = ?', [documentId, ctx.siteId]);
  });
  recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType: 'memory.document_deleted', subjectType: 'memory_document', subjectId: documentId, details: { reason, tombstones }, at: ctx.clock.now() });
  return { tombstones };
}

/**
 * Permanently remove a document and its chunks from SQLite (retention/purge).
 * Tombstones are written first so the vectors are deleted from Qdrant on the
 * next sync; tombstone rows are kept for audit.
 */
export function purgeDocument(ctx: MemoryCtx, documentId: string, reason: string): { tombstones: number; purged: boolean } {
  const doc = getDocumentById(ctx, documentId);
  if (!doc) return { tombstones: 0, purged: false };
  let tombstones = 0;
  ctx.db.transaction(() => {
    const chunkIds = ctx.db.all<{ id: string }>('SELECT id FROM memory_chunks WHERE document_id = ? AND site_id = ?', [documentId, ctx.siteId]).map((r) => r.id);
    tombstones = tombstoneChunks(ctx, documentId, chunkIds, `purge: ${reason}`);
    ctx.db.run('DELETE FROM memory_documents WHERE id = ? AND site_id = ?', [documentId, ctx.siteId]);
  });
  recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType: 'memory.document_purged', subjectType: 'memory_document', subjectId: documentId, details: { reason, tombstones }, at: ctx.clock.now() });
  return { tombstones, purged: true };
}

/**
 * Deletion propagation for a collected source set: every non-deleted document
 * of `sourceType` whose ref is inside the collector-owned namespace
 * (`refPrefixes`, e.g. "decision:" or "01 Business/") and not in
 * `presentRefs` is marked deleted. Documents ingested directly under other
 * refs are owned by their caller and never deleted here.
 */
export function propagateMissing(
  ctx: MemoryCtx,
  sourceType: MemorySourceType,
  presentRefs: Set<string>,
  opts: { dryRun?: boolean; refPrefixes?: readonly string[] } = {},
): { deleted: string[]; tombstones: number } {
  const rows = ctx.db.all<{ id: string; source_ref: string }>(`SELECT id, source_ref FROM memory_documents WHERE site_id = ? AND source_type = ? AND status != 'deleted'`, [
    ctx.siteId,
    sourceType,
  ]);
  const deleted: string[] = [];
  let tombstones = 0;
  for (const r of rows) {
    if (presentRefs.has(r.source_ref)) continue;
    if (opts.refPrefixes && !opts.refPrefixes.some((p) => r.source_ref.startsWith(p))) continue;
    deleted.push(r.source_ref);
    tombstones += markDocumentDeleted(ctx, r.id, `source_removed:${sourceType}`, opts).tombstones;
  }
  return { deleted, tombstones };
}
