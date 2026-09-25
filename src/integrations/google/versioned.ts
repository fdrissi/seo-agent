import type { AppContext } from '../../app/context.js';
import { hashObject } from '../../core/hash.js';
import { newId } from '../../core/ids.js';
import { redact } from '../../security/redact.js';
import type { Db } from '../../database/db.js';

/**
 * Versioned ingestion (migrations/0004_search_analytics.sql, 0100).
 *
 * A metric row is inserted as a NEW revision only when its row hash changed;
 * the previous revision is flipped to is_current = 0 first so the partial
 * unique "current" index holds. Unchanged rows are left alone, so re-running a
 * sync never double counts.
 *
 * Keys that an earlier batch returned but a later COMPLETE request over the
 * same exact scope no longer returns are RETIRED (is_current = 0,
 * superseded_by_batch_id = the later batch). They are never deleted and never
 * rewritten as zero. Callers skip retirement when the later response was
 * truncated, sampled, thresholded, or bucketed, because then an absent key
 * proves nothing.
 */

export type VersionedTable = 'gsc_property_daily' | 'gsc_page_daily' | 'gsc_page_query_daily' | 'ga4_landing_daily' | 'ga4_event_daily' | 'ga4_period_metrics';

/** Unique "current" key columns per table (excluding site_id). Fixed identifiers, never user input. */
export const VERSIONED_KEYS: Record<VersionedTable, readonly string[]> = {
  gsc_property_daily: ['property', 'search_type', 'date'],
  gsc_page_daily: ['property', 'search_type', 'date', 'page', 'segment_key'],
  gsc_page_query_daily: ['property', 'search_type', 'date', 'page', 'query', 'segment_key'],
  ga4_landing_daily: ['property_id', 'date', 'channel_view', 'landing_page', 'host_name', 'segment_key'],
  ga4_event_daily: ['property_id', 'date', 'channel_view', 'event_name', 'landing_page'],
  ga4_period_metrics: ['property_id', 'period_start', 'period_end', 'channel_view', 'landing_page', 'metric'],
};

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

export type SqlValue = string | number | null;

export interface RevisionMeta {
  batchId: string;
  collectedAt: string;
  transformationVersion: string;
  isSynthetic: boolean;
}

export type UpsertOutcome = 'new' | 'revised' | 'unchanged';

function assertIdent(c: string): void {
  if (!IDENT_RE.test(c)) throw new Error(`Invalid column name: ${c}`);
}

/** Canonical string for a table's current key (used to track which keys a request returned). */
export function revisionKey(table: VersionedTable, key: Record<string, SqlValue | undefined>): string {
  return JSON.stringify(VERSIONED_KEYS[table].map((c) => {
    const v = key[c];
    return v === undefined || v === null ? null : String(v);
  }));
}

/**
 * Insert-or-revise one observation. `values` are the non-key columns
 * (metrics, statuses, metadata columns). The row hash covers key + values.
 * Must be called inside a transaction for batch atomicity.
 *
 * A key that was retired earlier and is returned again gets a new revision
 * (numbered after the highest existing one) and counts as 'revised'.
 *
 * 'unchanged' needs the same row hash AND the same synthetic label: a live
 * observation with the values of a synthetic current row (or the reverse)
 * becomes a new revision, so a row never keeps the wrong label. The label is
 * compared separately and is not part of the row hash, so rows stored before
 * this rule keep their hashes (a sync does not rewrite them).
 */
export function upsertRevision(db: Db, table: VersionedTable, siteId: string, key: Record<string, SqlValue>, values: Record<string, SqlValue>, meta: RevisionMeta): UpsertOutcome {
  const keyCols = VERSIONED_KEYS[table];
  for (const c of [...Object.keys(key), ...Object.keys(values)]) assertIdent(c);
  for (const c of keyCols) if (!(c in key)) throw new Error(`Missing key column ${c} for ${table}`);
  const rowHash = hashObject({ key, values });
  const where = keyCols.map((c) => `${c} = ?`).join(' AND ');
  const keyParams = keyCols.map((c) => key[c] ?? null);
  const current = db.get<{ id: number; revision: number; row_hash: string; is_synthetic: number }>(
    `SELECT id, revision, row_hash, is_synthetic FROM ${table} WHERE site_id = ? AND ${where} AND is_current = 1`,
    [siteId, ...keyParams],
  );
  if (current && current.row_hash === rowHash && current.is_synthetic === (meta.isSynthetic ? 1 : 0)) return 'unchanged';
  let lastRevision = current?.revision ?? 0;
  if (current) {
    db.run(`UPDATE ${table} SET is_current = 0, superseded_by_batch_id = ? WHERE id = ?`, [meta.batchId, current.id]);
  } else {
    lastRevision = db.get<{ r: number | null }>(`SELECT MAX(revision) AS r FROM ${table} WHERE site_id = ? AND ${where}`, [siteId, ...keyParams])?.r ?? 0;
  }
  const cols = ['site_id', ...keyCols, ...Object.keys(values), 'revision', 'is_current', 'row_hash', 'batch_id', 'collected_at', 'transformation_version', 'is_synthetic'];
  const params: SqlValue[] = [
    siteId,
    ...keyParams,
    ...Object.values(values),
    lastRevision + 1,
    1,
    rowHash,
    meta.batchId,
    meta.collectedAt,
    meta.transformationVersion,
    meta.isSynthetic ? 1 : 0,
  ];
  db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, params);
  return lastRevision > 0 ? 'revised' : 'new';
}

/**
 * The exact scope a request could have returned. Only current rows inside it
 * are candidates for retirement. Column names are fixed identifiers.
 */
export interface RetireScope {
  /** Exact-match constraints on key columns (e.g. property, search_type, channel_view). */
  equals: Record<string, SqlValue>;
  /** Inclusive range on a date key column. */
  range?: { column: string; start: string; end: string };
  /** Restrict a key column to these values (e.g. the requested event names or metrics). */
  inList?: { column: string; values: SqlValue[] };
  /** Final predicate on the key, e.g. the segment-key shape or "landing_page <> ''". */
  where?: (key: Record<string, SqlValue>) => boolean;
}

/**
 * Retire (apply = true) or only count (apply = false) the current rows inside
 * `scope` whose key is not in `returned`. Must be called inside the same
 * transaction as the batch's upserts. Returns the number of rows affected.
 */
export function retireUnreturned(db: Db, table: VersionedTable, siteId: string, scope: RetireScope, returned: ReadonlySet<string>, batchId: string, apply: boolean): number {
  const keyCols = VERSIONED_KEYS[table];
  const clauses = ['site_id = ?', 'is_current = 1'];
  const params: SqlValue[] = [siteId];
  for (const [c, v] of Object.entries(scope.equals)) {
    assertIdent(c);
    clauses.push(`${c} = ?`);
    params.push(v);
  }
  if (scope.range) {
    assertIdent(scope.range.column);
    clauses.push(`${scope.range.column} BETWEEN ? AND ?`);
    params.push(scope.range.start, scope.range.end);
  }
  if (scope.inList) {
    assertIdent(scope.inList.column);
    if (!scope.inList.values.length) return 0;
    clauses.push(`${scope.inList.column} IN (${scope.inList.values.map(() => '?').join(', ')})`);
    params.push(...scope.inList.values);
  }
  const rows = db.all<Record<string, SqlValue> & { id: number }>(`SELECT id, ${keyCols.join(', ')} FROM ${table} WHERE ${clauses.join(' AND ')}`, params);
  let n = 0;
  for (const row of rows) {
    if (returned.has(revisionKey(table, row))) continue;
    if (scope.where && !scope.where(row)) continue;
    n++;
    if (apply) db.run(`UPDATE ${table} SET is_current = 0, superseded_by_batch_id = ? WHERE id = ? AND site_id = ?`, [batchId, row.id, siteId]);
  }
  return n;
}

export interface BatchCounts {
  received: number;
  newRevisions: number;
  unchanged: number;
  revised: number;
  /** Current rows of earlier batches retired because a complete request no longer returned them. */
  retired: number;
  /** Current rows not returned but KEPT current because the response was incomplete (see coverage). */
  staleRetained: number;
}

export function emptyCounts(): BatchCounts {
  return { received: 0, newRevisions: 0, unchanged: 0, revised: 0, retired: 0, staleRetained: 0 };
}

export function tally(c: BatchCounts, o: UpsertOutcome): void {
  c.received++;
  if (o === 'unchanged') c.unchanged++;
  else {
    c.newRevisions++;
    if (o === 'revised') c.revised++;
  }
}

/**
 * Retire or count unreturned keys for one complete-or-not request and record
 * the outcome in `counts`. `incompleteReasons` empty = the response was
 * complete for `scope`, so absent keys are retired; otherwise they are only
 * counted and stay current.
 */
export function settleScope(db: Db, table: VersionedTable, siteId: string, scope: RetireScope, returned: ReadonlySet<string>, batchId: string, incompleteReasons: readonly string[], counts: BatchCounts): number {
  const apply = incompleteReasons.length === 0;
  const n = retireUnreturned(db, table, siteId, scope, returned, batchId, apply);
  if (apply) counts.retired += n;
  else counts.staleRetained += n;
  return n;
}

/**
 * Batch source: a Google sync ('gsc' | 'ga4') or an owner-supplied file
 * brought in with `data import` ('import'; ingestion_batches.source allows it
 * since migration 0004). Import batches record the stored file's raw_ref and
 * the import transformation version like any other batch.
 */
export type BatchSource = 'gsc' | 'ga4' | 'import';

/** Target table of a batch: a versioned metric table, or 'keywords' for imported keyword lists (not versioned). */
export type BatchDataset = VersionedTable | 'keywords';

export interface StartBatchInput {
  source: BatchSource;
  dataset: BatchDataset;
  property: string;
  dateStart: string;
  dateEnd: string;
  request: unknown;
  transformationVersion: string;
  synthetic: boolean;
}

export function startBatch(ctx: AppContext, input: StartBatchInput): string {
  const id = newId('ingb');
  ctx.db.run(
    `INSERT INTO ingestion_batches (id, site_id, source, dataset, property, date_start, date_end, request_json, status, transformation_version, is_synthetic, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
    [id, ctx.siteId, input.source, input.dataset, input.property, input.dateStart, input.dateEnd, JSON.stringify(redact(input.request)), input.transformationVersion, input.synthetic ? 1 : 0, ctx.clock.now().toISOString()],
  );
  return id;
}

export interface FinishBatchInput {
  status: 'succeeded' | 'partial' | 'failed';
  counts: BatchCounts;
  apiPages: number;
  truncated: boolean;
  coverage?: unknown;
  metadata?: unknown;
  rawRefs?: string[];
  error?: unknown;
}

export function finishBatch(ctx: AppContext, batchId: string, input: FinishBatchInput): void {
  ctx.db.run(
    `UPDATE ingestion_batches SET status = ?, rows_received = ?, rows_new_revision = ?, rows_unchanged = ?, rows_retired = ?, api_pages = ?, truncated = ?,
       coverage_json = ?, metadata_json = ?, raw_refs_json = ?, finished_at = ?, error_json = ? WHERE id = ? AND site_id = ?`,
    [
      input.status,
      input.counts.received,
      input.counts.newRevisions,
      input.counts.unchanged,
      input.counts.retired,
      input.apiPages,
      input.truncated ? 1 : 0,
      input.coverage === undefined ? null : JSON.stringify(redact(input.coverage)),
      input.metadata === undefined ? null : JSON.stringify(redact(input.metadata)),
      input.rawRefs ? JSON.stringify(input.rawRefs) : null,
      ctx.clock.now().toISOString(),
      input.error === undefined ? null : JSON.stringify(redact(input.error instanceof Error ? { name: input.error.name, message: input.error.message, code: (input.error as { code?: unknown }).code } : input.error)),
      batchId,
      ctx.siteId,
    ],
  );
}
