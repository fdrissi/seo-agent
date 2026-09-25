import type { AppContext } from '../../app/context.js';
import { PolicyDeniedError } from '../../core/errors.js';
import type { Measured } from '../../core/measured.js';
import { competitorUrlsForSnapshot, normalizeQuery, ownRankForSnapshot } from './store.js';
import type { CompetitorUrl } from './types.js';
import { VOLUME_LABEL } from './volume.js';

/**
 * Read helpers for OTHER modules (recommendations, reports, crawling).
 * They EXCLUDE sandbox/fixture data (is_sandbox = 1) unless the context is a
 * synthetic demo workspace, where every row is synthetic and labeled anyway.
 * Use these instead of querying serp_snapshots / keyword_metrics directly.
 */

function includeSynthetic(ctx: AppContext): number {
  return ctx.synthetic ? 1 : 0;
}

export interface SerpSnapshotRow {
  id: string;
  query: string;
  location_code: number | null;
  language_code: string | null;
  device: string;
  depth: number | null;
  items_count: number | null;
  is_sandbox: number;
  raw_ref: string | null;
  collected_at: string;
}

/** Throw when a row is sandbox/fixture data and the context is a real (non-demo) workspace. */
export function assertUsableForRecommendations(ctx: AppContext, row: { is_sandbox: number }, what = 'DataForSEO data'): void {
  if (row.is_sandbox === 1 && !ctx.synthetic) {
    throw new PolicyDeniedError(`${what} comes from the DataForSEO sandbox/fixtures (synthetic) and cannot be used in real recommendations.`);
  }
}

/** Latest real SERP snapshot for a query (optionally filtered by locale/device and maximum age). */
export function latestSerpSnapshot(
  ctx: AppContext,
  query: string,
  opts: { locationCode?: number; languageCode?: string; device?: string; maxAgeDays?: number } = {},
): SerpSnapshotRow | null {
  // Match on the normalized keyword (Unicode-aware), not SQLite's ASCII-only lower().
  const where: string[] = ['s.site_id = ?', 'kw.normalized = ?', '(s.is_sandbox = 0 OR ? = 1)'];
  const params: unknown[] = [ctx.siteId, normalizeQuery(query), includeSynthetic(ctx)];
  if (opts.locationCode !== undefined) {
    where.push('s.location_code = ?');
    params.push(opts.locationCode);
  }
  if (opts.languageCode !== undefined) {
    where.push('lower(s.language_code) = lower(?)');
    params.push(opts.languageCode);
  }
  if (opts.device !== undefined) {
    where.push('s.device = ?');
    params.push(opts.device);
  }
  if (opts.maxAgeDays !== undefined) {
    where.push('s.collected_at >= ?');
    params.push(new Date(ctx.clock.now().getTime() - opts.maxAgeDays * 86_400_000).toISOString());
  }
  return (
    ctx.db.get<SerpSnapshotRow>(
      `SELECT s.id, s.query, s.location_code, s.language_code, s.device, s.depth, s.items_count, s.is_sandbox, s.raw_ref, s.collected_at
       FROM serp_snapshots s JOIN keywords kw ON kw.id = s.keyword_id
       WHERE ${where.join(' AND ')} ORDER BY s.collected_at DESC LIMIT 1`,
      params,
    ) ?? null
  );
}

export interface SerpResultRow {
  result_type: string;
  rank_group: number | null;
  rank_absolute: number | null;
  url: string | null;
  domain: string | null;
  title: string | null;
  description: string | null;
  is_own_site: number;
}

/** Results of a snapshot for analysis. Refuses sandbox snapshots in real workspaces. Titles/snippets are untrusted text. */
export function serpResultsForRecommendation(ctx: AppContext, snapshotId: string): SerpResultRow[] {
  const snap = ctx.db.get<{ is_sandbox: number }>('SELECT is_sandbox FROM serp_snapshots WHERE id = ? AND site_id = ?', [snapshotId, ctx.siteId]);
  if (!snap) return [];
  assertUsableForRecommendations(ctx, snap, `SERP snapshot ${snapshotId}`);
  return ctx.db.all<SerpResultRow>(
    `SELECT result_type, rank_group, rank_absolute, url, domain, title, description, is_own_site FROM serp_results
     WHERE snapshot_id = ? AND site_id = ? ORDER BY CASE WHEN rank_absolute IS NULL THEN 1 ELSE 0 END, rank_absolute, id`,
    [snapshotId, ctx.siteId],
  );
}

/** Competitor pages to crawl for a query, from its latest real snapshot. */
export function competitorUrlsForQuery(ctx: AppContext, query: string, limit = ctx.config.crawl.competitorPagesPerQuery): CompetitorUrl[] {
  const snap = latestSerpSnapshot(ctx, query);
  return snap ? competitorUrlsForSnapshot(ctx, snap.id, limit, { register: false }) : [];
}

/** Own-site point-in-time rank from the latest real snapshot (NOT the GSC average position). */
export function latestOwnRank(ctx: AppContext, query: string): { rank: Measured<number>; snapshotId: string | null; observedAt: string | null } {
  const snap = latestSerpSnapshot(ctx, query);
  if (!snap) return { rank: { status: 'unavailable', reason: 'no real SERP snapshot for this query' }, snapshotId: null, observedAt: null };
  const r = ownRankForSnapshot(ctx, snap.id);
  const rank: Measured<number> =
    r === undefined ? { status: 'incomplete', reason: 'partial SERP result' } : r === null ? { status: 'missing', reason: `not found within the top ${snap.depth ?? '?'} results` } : { status: 'observed', value: r };
  return { rank, snapshotId: snap.id, observedAt: snap.collected_at };
}

export interface VolumeEstimate {
  keyword: string;
  volume: Measured<number>;
  label: string;
  locationCode: number | null;
  languageCode: string | null;
  collectedAt: string | null;
  metricId: string | null;
  expired: boolean;
}

/** Latest real search-volume ESTIMATE per keyword (sandbox excluded; missing stays missing). */
export function keywordVolumeEstimates(ctx: AppContext, keywords: string[], opts: { locationCode?: number; languageCode?: string } = {}): VolumeEstimate[] {
  const now = ctx.clock.now().toISOString();
  return keywords.map((k) => {
    const params: unknown[] = [ctx.siteId, normalizeQuery(k), includeSynthetic(ctx)];
    let extra = '';
    if (opts.locationCode !== undefined) {
      extra += ' AND m.location_code = ?';
      params.push(opts.locationCode);
    }
    if (opts.languageCode !== undefined) {
      extra += ' AND lower(m.language_code) = lower(?)';
      params.push(opts.languageCode);
    }
    const row = ctx.db.get<{ id: string; search_volume: number | null; location_code: number | null; language_code: string | null; collected_at: string; expires_at: string }>(
      `SELECT m.id, m.search_volume, m.location_code, m.language_code, m.collected_at, m.expires_at FROM keyword_metrics m JOIN keywords kw ON kw.id = m.keyword_id
       WHERE m.site_id = ? AND kw.normalized = ? AND (m.is_sandbox = 0 OR ? = 1)${extra} ORDER BY m.collected_at DESC LIMIT 1`,
      params,
    );
    if (!row) return { keyword: k, volume: { status: 'unavailable', reason: 'no real volume estimate collected' }, label: VOLUME_LABEL, locationCode: null, languageCode: null, collectedAt: null, metricId: null, expired: false };
    return {
      keyword: k,
      volume: row.search_volume === null ? { status: 'missing', reason: 'provider returned no volume' } : { status: 'observed', value: row.search_volume },
      label: VOLUME_LABEL,
      locationCode: row.location_code,
      languageCode: row.language_code,
      collectedAt: row.collected_at,
      metricId: row.id,
      expired: row.expires_at <= now,
    };
  });
}
