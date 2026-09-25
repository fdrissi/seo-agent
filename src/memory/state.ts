import type { MemoryCtx } from './documents.js';

/** Persisted degraded/health state for memory indexing and retrieval (per site). */

export function recordIndexState(
  ctx: MemoryCtx,
  versionId: string,
  patch: { degraded: boolean; reason?: string | null; syncedAt?: string; reconciledAt?: string },
): void {
  const at = ctx.clock.now().toISOString();
  ctx.db.run(
    `INSERT INTO memory_index_state (site_id, embedding_version_id, last_sync_at, last_reconcile_at, degraded, degraded_reason, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (site_id, embedding_version_id) DO UPDATE SET
       last_sync_at = COALESCE(excluded.last_sync_at, memory_index_state.last_sync_at),
       last_reconcile_at = COALESCE(excluded.last_reconcile_at, memory_index_state.last_reconcile_at),
       degraded = excluded.degraded,
       degraded_reason = excluded.degraded_reason,
       updated_at = excluded.updated_at`,
    [ctx.siteId, versionId, patch.syncedAt ?? null, patch.reconciledAt ?? null, patch.degraded ? 1 : 0, patch.degraded ? (patch.reason ?? 'unknown') : null, at],
  );
}

/**
 * Record the last retrieval method/degraded state for the site. The
 * per-version index state (memory_index_state) is only touched when the
 * outcome says something about the index itself: `indexHealthy: false` (Qdrant
 * failed) marks it degraded, `indexHealthy: true` (Qdrant answered) clears it.
 * Retrieval-only reasons (e.g. a query embedding not allowed) leave it alone.
 */
export function recordRetrievalState(
  ctx: MemoryCtx,
  s: { method: 'hybrid' | 'fts_only'; degraded: boolean; reason?: string | null; versionId?: string | null; indexHealthy?: boolean | null },
): void {
  const at = ctx.clock.now().toISOString();
  ctx.db.run(
    `INSERT INTO memory_retrieval_state (site_id, last_method, degraded, degraded_reason, embedding_version_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (site_id) DO UPDATE SET last_method = excluded.last_method, degraded = excluded.degraded,
       degraded_reason = excluded.degraded_reason, embedding_version_id = excluded.embedding_version_id, updated_at = excluded.updated_at`,
    [ctx.siteId, s.method, s.degraded ? 1 : 0, s.degraded ? (s.reason ?? 'unknown') : null, s.versionId ?? null, at],
  );
  if (!s.versionId || s.indexHealthy === undefined || s.indexHealthy === null) return;
  const existing = ctx.db.get<{ degraded: number; degraded_reason: string | null }>('SELECT degraded, degraded_reason FROM memory_index_state WHERE site_id = ? AND embedding_version_id = ?', [
    ctx.siteId,
    s.versionId,
  ]);
  if (s.indexHealthy === false) {
    if (!existing || existing.degraded !== 1 || existing.degraded_reason !== (s.reason ?? 'unknown')) recordIndexState(ctx, s.versionId, { degraded: true, reason: s.reason ?? null });
  } else if (existing?.degraded === 1) {
    recordIndexState(ctx, s.versionId, { degraded: false });
  }
}

export interface RetrievalStateRow {
  last_method: 'hybrid' | 'fts_only';
  degraded: number;
  degraded_reason: string | null;
  embedding_version_id: string | null;
  updated_at: string;
}

export function readRetrievalState(ctx: MemoryCtx): RetrievalStateRow | undefined {
  return ctx.db.get<RetrievalStateRow>('SELECT last_method, degraded, degraded_reason, embedding_version_id, updated_at FROM memory_retrieval_state WHERE site_id = ?', [ctx.siteId]);
}
