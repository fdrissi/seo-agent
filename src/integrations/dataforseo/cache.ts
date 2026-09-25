import type { AppContext } from '../../app/context.js';
import { hashObject } from '../../core/hash.js';
import type { DataForSeoMode } from './client.js';

/**
 * Paid-research cache (table research_cache). Keys include the site, logical
 * endpoint, location, language, device, parameter hash, and mode, so a
 * desktop SERP never satisfies a mobile request, and sandbox/fixture data can
 * never satisfy a live request. Valid entries are reused before any paid
 * request. A TTL of 0 days disables caching for that data type.
 */

export interface CacheKeyInput {
  siteId: string;
  endpoint: string;
  locationCode: number | null;
  languageCode: string | null;
  device: string | null;
  parameterHash: string;
  mode: DataForSeoMode;
}

export function researchCacheKey(input: CacheKeyInput): string {
  return `dfs:${hashObject({
    provider: 'dataforseo',
    site: input.siteId,
    endpoint: input.endpoint,
    location: input.locationCode,
    language: input.languageCode === null ? null : input.languageCode.toLowerCase(),
    device: input.device,
    params: input.parameterHash,
    mode: input.mode,
  })}`;
}

export interface CacheEntry {
  cacheKey: string;
  payloadRef: string;
  isSandbox: boolean;
  createdAt: string;
  expiresAt: string;
}

export function getCached(ctx: AppContext, key: string): CacheEntry | null {
  const row = ctx.db.get<{ cache_key: string; payload_ref: string; is_sandbox: number; created_at: string; expires_at: string }>(
    'SELECT cache_key, payload_ref, is_sandbox, created_at, expires_at FROM research_cache WHERE cache_key = ? AND site_id = ? AND provider = ? AND expires_at > ?',
    [key, ctx.siteId, 'dataforseo', ctx.clock.now().toISOString()],
  );
  if (!row) return null;
  return { cacheKey: row.cache_key, payloadRef: row.payload_ref, isSandbox: row.is_sandbox === 1, createdAt: row.created_at, expiresAt: row.expires_at };
}

export function putCached(
  ctx: AppContext,
  input: CacheKeyInput & { payloadRef: string; ttlDays: number; isSandbox: boolean; createdAt?: Date },
): string | null {
  if (!(input.ttlDays > 0)) return null;
  const key = researchCacheKey(input);
  const created = input.createdAt ?? ctx.clock.now();
  const expires = new Date(created.getTime() + input.ttlDays * 86_400_000);
  ctx.db.run(
    `INSERT INTO research_cache (cache_key, site_id, provider, endpoint, location_code, language_code, device, parameter_hash, payload_ref, is_sandbox, created_at, expires_at)
     VALUES (?, ?, 'dataforseo', ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET payload_ref = excluded.payload_ref, is_sandbox = excluded.is_sandbox, created_at = excluded.created_at, expires_at = excluded.expires_at`,
    [key, input.siteId, input.endpoint, input.locationCode, input.languageCode, input.device, input.parameterHash, input.payloadRef, input.isSandbox ? 1 : 0, created.toISOString(), expires.toISOString()],
  );
  return key;
}

/** `db:<table>:<id>` references let cache rows point at stored observations. */
export function dbRef(table: 'serp_snapshots' | 'keyword_metrics', id: string): string {
  return `db:${table}:${id}`;
}

export function parseDbRef(ref: string): { table: string; id: string } | null {
  const m = /^db:([a-z_]+):(.+)$/.exec(ref);
  return m ? { table: m[1]!, id: m[2]! } : null;
}
