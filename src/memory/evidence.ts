import { existsSync, readFileSync } from 'node:fs';
import type { AppContext } from '../app/context.js';
import { normalizedContentHash } from '../core/hash.js';
import type { TrustClass } from '../core/modes.js';
import { siteVaultDir } from '../config/paths.js';
import { redact, redactString } from '../security/redact.js';
import { safeResolve } from '../security/paths.js';
import type { DocumentStatus } from './memory-types.js';
import { parseMarkdown, stripComments, stripGeneratedRegions } from './markdown.js';
import { sanitizeForMemory } from './sanitize.js';
import type { MemorySourceType, RetrievedChunk } from './types.js';

/**
 * Fetch the original supporting source behind a retrieved chunk, so a
 * consequential claim is re-checked against its authoritative record (vault
 * note, evidence row + source, experiment, decision, ...) instead of being
 * reused from memory text alone.
 *
 * Status:
 * - found:     the original exists (vault notes: and its content matches the
 *              indexed version; database records: the record is attached so
 *              the caller compares it with the chunk).
 * - changed:   the original differs from the indexed version, or the chunk
 *              belongs to an older document version (re-verify the claim;
 *              run `memory sync`).
 * - missing:   the original record/note no longer exists.
 * - not_found: the chunk id is unknown for this site.
 *
 * All returned text/records pass through secret redaction. Retrieved text is
 * untrusted data, never instructions.
 */

export type EvidenceCtx = Pick<AppContext, 'db' | 'siteId' | 'paths'>;

export interface OriginalEvidence {
  status: 'found' | 'changed' | 'missing' | 'not_found';
  chunkId: string;
  documentId: string | null;
  sourceType: MemorySourceType | null;
  sourceRef: string | null;
  trustClass: TrustClass | null;
  documentStatus: DocumentStatus | null;
  recordStatus: string | null;
  indexedVersion: number | null;
  original: {
    kind: 'vault_note' | 'evidence' | 'competitor_change' | 'competitor' | 'content_brief' | 'experiment' | 'recommendation' | 'content_item' | 'learning' | 'decision' | 'memory_only';
    ref: string;
    url: string | null;
    retrievedAt: string | null;
    text: string | null;
    record: Record<string, unknown> | null;
  } | null;
  note: string;
}

function splitRef(ref: string): [string, string] {
  const i = ref.indexOf(':');
  return i < 0 ? ['', ref] : [ref.slice(0, i), ref.slice(i + 1)];
}

export function getOriginalEvidence(ctx: EvidenceCtx, chunk: RetrievedChunk | string): OriginalEvidence {
  const chunkId = typeof chunk === 'string' ? chunk : chunk.chunkId;
  const row = ctx.db.get<{
    document_id: string;
    source_type: MemorySourceType;
    source_ref: string;
    source_url: string | null;
    trust_class: TrustClass;
    status: DocumentStatus;
    record_status: string | null;
    version: number;
    content_hash: string;
    document_version: number;
  }>(
    `SELECT c.document_id, d.source_type, d.source_ref, d.source_url, d.trust_class, d.status, d.record_status, d.version, d.content_hash, c.document_version
     FROM memory_chunks c JOIN memory_documents d ON d.id = c.document_id
     WHERE c.id = ? AND c.site_id = ? AND d.site_id = ?`,
    [chunkId, ctx.siteId, ctx.siteId],
  );
  const base: OriginalEvidence = {
    status: 'not_found',
    chunkId,
    documentId: null,
    sourceType: null,
    sourceRef: null,
    trustClass: null,
    documentStatus: null,
    recordStatus: null,
    indexedVersion: null,
    original: null,
    note: 'Unknown chunk for this site.',
  };
  if (!row) return base;
  Object.assign(base, {
    documentId: row.document_id,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    trustClass: row.trust_class,
    documentStatus: row.status,
    recordStatus: row.record_status,
    indexedVersion: row.document_version,
  });
  const staleVersion = row.document_version !== row.version;
  const [prefix, id] = splitRef(row.source_ref);
  const recordLookup = (kind: NonNullable<OriginalEvidence['original']>['kind'], sql: string, params: unknown[], url: string | null = row.source_url): OriginalEvidence => {
    const rec = ctx.db.get<Record<string, unknown>>(sql, params);
    if (!rec) return { ...base, status: 'missing', note: `The original ${kind} record no longer exists; do not reuse this claim without new evidence.` };
    return {
      ...base,
      status: staleVersion ? 'changed' : 'found',
      original: { kind, ref: row.source_ref, url, retrievedAt: (rec.retrieved_at as string | undefined) ?? (rec.collected_at as string | undefined) ?? null, text: null, record: redact(rec) },
      note: staleVersion ? 'This chunk belongs to an older document version; the current record differs.' : 'Original record attached.',
    };
  };

  switch (row.source_type) {
    case 'business_note': {
      let abs: string;
      try {
        abs = safeResolve(siteVaultDir(ctx.paths, ctx.siteId), row.source_ref);
      } catch {
        return { ...base, status: 'missing', note: 'Note path is not a safe vault path.' };
      }
      if (!existsSync(abs)) return { ...base, status: 'missing', note: 'The business note no longer exists in the vault.' };
      const raw = readFileSync(abs, 'utf8');
      const body = stripComments(stripGeneratedRegions(parseMarkdown(raw).body).text);
      const san = sanitizeForMemory(body);
      const same = san.ok && normalizedContentHash(san.text) === row.content_hash && !staleVersion;
      return {
        ...base,
        status: same ? 'found' : 'changed',
        original: { kind: 'vault_note', ref: row.source_ref, url: null, retrievedAt: null, text: san.ok ? san.text : null, record: null },
        note: same
          ? 'Vault note matches the indexed version.'
          : san.ok
            ? 'The vault note changed since it was indexed: re-verify the claim and run `memory sync`.'
            : 'The vault note now contains credential-like text; its content is withheld. Clean the note and rotate the credential.',
      };
    }
    case 'source_excerpt': {
      const rec = ctx.db.get<Record<string, unknown>>(
        `SELECT e.id, e.kind, e.summary, e.excerpt, e.locator_json, e.date_range_start, e.date_range_end, e.collected_at, e.transformation_version,
                s.id AS source_id, s.source_type, s.trust_class, s.url, s.title, s.retrieved_at, s.published_at, s.raw_ref
         FROM evidence e JOIN sources s ON s.id = e.source_id AND s.site_id = e.site_id WHERE e.id = ? AND e.site_id = ?`,
        [id, ctx.siteId],
      );
      if (!rec) return { ...base, status: 'missing', note: 'The evidence row no longer exists.' };
      return {
        ...base,
        status: staleVersion ? 'changed' : 'found',
        original: {
          kind: 'evidence',
          ref: row.source_ref,
          url: (rec.url as string | null) ?? null,
          retrievedAt: (rec.retrieved_at as string | null) ?? null,
          text: typeof rec.excerpt === 'string' ? redactString(rec.excerpt) : null,
          record: redact(rec),
        },
        note: 'Evidence excerpt with its source, retrieval date, and raw-response reference.',
      };
    }
    case 'competitor_finding':
      if (prefix === 'competitor') return recordLookup('competitor', 'SELECT id, domain, name, origin, notes, first_seen_at FROM competitors WHERE id = ? AND site_id = ?', [id, ctx.siteId]);
      return recordLookup(
        'competitor_change',
        `SELECT cc.id, cc.change_type, cc.summary, cc.previous_hash, cc.new_hash, cc.detected_at, cp.url, cp.last_crawl_result_id
         FROM competitor_changes cc JOIN competitor_pages cp ON cp.id = cc.competitor_page_id AND cp.site_id = cc.site_id WHERE cc.id = ? AND cc.site_id = ?`,
        [id, ctx.siteId],
      );
    case 'brief':
      return recordLookup(
        'content_brief',
        `SELECT id, content_item_id, version, status, brief_json, content_hash, vault_path, prompt_version, model_id, created_at FROM content_briefs
         WHERE content_item_id = ? AND site_id = ? ORDER BY version DESC LIMIT 1`,
        [id, ctx.siteId],
      );
    case 'experiment_summary':
      return recordLookup(
        'experiment',
        `SELECT id, type, hypothesis, proposed_change, primary_metric, status, outcome_json, observation_start, observation_end, implemented_at, evidence_json, updated_at
         FROM experiments WHERE id = ? AND site_id = ?`,
        [id, ctx.siteId],
      );
    case 'rejected_proposal':
      if (prefix === 'content_item') return recordLookup('content_item', 'SELECT id, title, stage, decision, decision_reason, updated_at FROM content_items WHERE id = ? AND site_id = ?', [id, ctx.siteId]);
      return recordLookup(
        'recommendation',
        'SELECT id, kind, action_type, title, query, diagnosis, proposed_change, hypothesis, status, details_json, updated_at FROM recommendations WHERE id = ? AND site_id = ?',
        [id, ctx.siteId],
      );
    case 'approved_learning':
      return recordLookup('learning', 'SELECT id, statement, scope, status, evidence_json, experiment_id, approved_by, approved_at FROM learnings WHERE id = ? AND site_id = ?', [id, ctx.siteId]);
    case 'decision':
      return recordLookup('decision', 'SELECT id, subject_type, subject_id, decision, reason, decided_by, decided_at, vault_path FROM decisions WHERE id = ? AND site_id = ?', [id, ctx.siteId]);
    default: {
      const text = ctx.db
        .all<{ text: string }>('SELECT text FROM memory_chunks WHERE document_id = ? AND document_version = ? AND site_id = ? ORDER BY chunk_index', [row.document_id, row.version, ctx.siteId])
        .map((r) => r.text)
        .join('\n\n');
      return {
        ...base,
        status: 'found',
        original: { kind: 'memory_only', ref: row.source_ref, url: row.source_url, retrievedAt: null, text: redactString(text), record: null },
        note: 'No external original is linked; the memory document itself is the stored source.',
      };
    }
  }
}
