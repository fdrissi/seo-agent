import type { AppContext } from '../../app/context.js';
import { hashObject } from '../../core/hash.js';
import { newId } from '../../core/ids.js';
import { parseJson } from '../../database/db.js';
import { isAllowedHost, normalizeUrl, tryParseUrl } from '../../seo/url.js';
import { dbRef, putCached } from './cache.js';
import type { DfsTask } from './envelope.js';
import type { CompetitorUrl, TaskMeta, TaskParams, TaskRow } from './types.js';

/**
 * Persistence of DataForSEO observations into the fixed schema (migration
 * 0005). Provider text (titles, snippets) is untrusted data and stored as-is,
 * never interpreted. Sandbox/fixture results are stored with is_sandbox = 1 and
 * are NOT written to rankings, competitors, or competitor_pages (those tables
 * have no sandbox flag), so they cannot leak into real recommendations.
 *
 * `keywords` has no sandbox flag either. A sandbox/fixture observation only
 * upserts the keyword the OWNER requested (the SERP query, or a keyword from
 * the volume request), never a keyword that appears only in the provider's
 * dummy response. Such rows carry the origin `dataforseo_sandbox` /
 * `dataforseo_fixture` in origins_json; the keyword text is real (the owner
 * asked for it), only its metrics are synthetic, and those stay flagged in
 * serp_snapshots / keyword_metrics.is_sandbox.
 *
 * One keyword row per query: an existing row with the same normalized text
 * is reused (exact language first, then the language-less row Search Console
 * queries create); a new row gets language NULL when the request language is
 * the site's only/primary market language. The request language is always
 * kept on serp_snapshots.language_code / keyword_metrics.language_code.
 *
 * Provenance (migration 0201): serp_snapshots and keyword_metrics record
 * their transformation_version. Idempotency (migration 0200): a task yields
 * one snapshot (re-processing returns the stored one), and one volume row per
 * (keyword, provider, location, language, collected_at).
 */

export const SERP_TRANSFORMATION_VERSION = 'dataforseo-serp@1';
export const VOLUME_TRANSFORMATION_VERSION = 'dataforseo-volume@1';
export const SERP_CACHE_ENDPOINT = 'serp/google/organic/advanced';
export const VOLUME_CACHE_ENDPOINT = 'keywords_data/google_ads/search_volume';

export function normalizeQuery(q: string): string {
  return q.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Branded when a configured brand alias appears in the query; null when no aliases are configured (unknown). */
export function isBrandedQuery(ctx: AppContext, query: string): 0 | 1 | null {
  const aliases = ctx.config.brand.aliases.map((a) => normalizeQuery(a)).filter(Boolean);
  if (aliases.length === 0) return null;
  const q = normalizeQuery(query);
  return aliases.some((a) => q.includes(a)) ? 1 : 0;
}

/** Primary subtag of a BCP 47 language code, lower-cased ('en-US' -> 'en'). */
function baseLanguage(code: string): string {
  return code.trim().toLowerCase().replace(/_/g, '-').split('-')[0] ?? '';
}

/**
 * The site's primary market language (market.languages[0], else the language
 * of its only search location), or null when the configuration does not say.
 */
export function primaryMarketLanguage(ctx: Pick<AppContext, 'config'>): string | null {
  const langs = ctx.config.market.languages;
  if (langs.length) return baseLanguage(langs[0]!);
  const locs = [...new Set(ctx.config.market.searchLocations.map((l) => baseLanguage(l.languageCode)))];
  return locs.length === 1 ? locs[0]! : null;
}

/**
 * Keyword row for a query. Reuses an existing row with the same normalized
 * text: the exact language first, then the language-less (NULL) row (whose
 * language is left alone), then, for a language-less request, any row. A new
 * row stores NULL when the language is the site's only/primary market
 * language, so Search Console (no language) and research (request language)
 * share one keyword instead of two.
 */
export function upsertKeyword(ctx: AppContext, input: { keyword: string; language: string | null; origin: string }): string {
  const normalized = normalizeQuery(input.keyword);
  const now = ctx.clock.now().toISOString();
  return ctx.db.transaction(() => {
    const rows = ctx.db.all<{ id: string; language: string | null; origins_json: string | null }>(
      'SELECT id, language, origins_json FROM keywords WHERE site_id = ? AND normalized = ? ORDER BY first_seen_at, id',
      [ctx.siteId, normalized],
    );
    const exact = input.language === null ? rows.find((r) => r.language === null) : rows.find((r) => r.language !== null && r.language.toLowerCase() === input.language!.toLowerCase());
    const existing = exact ?? rows.find((r) => r.language === null) ?? (input.language === null ? rows[0] : undefined);
    if (existing) {
      const origins = parseJson<string[]>(existing.origins_json, []);
      if (!origins.includes(input.origin)) {
        origins.push(input.origin);
        ctx.db.run('UPDATE keywords SET origins_json = ? WHERE id = ? AND site_id = ?', [JSON.stringify(origins), existing.id, ctx.siteId]);
      }
      return existing.id;
    }
    const id = newId('kw');
    const primary = primaryMarketLanguage(ctx);
    const language = input.language !== null && primary !== null && baseLanguage(input.language) === primary ? null : input.language;
    ctx.db.run(
      `INSERT INTO keywords (id, site_id, keyword, normalized, language, is_branded, first_seen_at, origins_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ctx.siteId, input.keyword.replace(/\s+/g, ' ').trim(), normalized, language, isBrandedQuery(ctx, input.keyword), now, JSON.stringify([input.origin])],
    );
    return id;
  });
}

export function taskParams(row: Pick<TaskRow, 'params_json'>): TaskParams {
  return parseJson<TaskParams>(row.params_json, { task: {}, meta: { kind: 'gated', mode: 'live', queue: 'live', purpose: 'unknown', runId: 'unknown' } });
}

// ---------------------------------------------------------------------------
// SERP
// ---------------------------------------------------------------------------

export interface ParsedSerpItem {
  type: string;
  rankGroup: number | null;
  rankAbsolute: number | null;
  url: string | null;
  domain: string | null;
  title: string | null;
  description: string | null;
}

export interface ParsedSerp {
  keyword: string | null;
  locationCode: number | null;
  languageCode: string | null;
  checkUrl: string | null;
  datetime: string | null;
  itemTypes: string[];
  seResultsCount: number | null;
  itemsCount: number | null;
  items: ParsedSerpItem[];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Parse a task_get/advanced (or live/advanced) result object tolerantly (DF7). */
export function parseSerpResult(result: unknown): ParsedSerp {
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
  const items = Array.isArray(r.items) ? r.items : [];
  return {
    keyword: str(r.keyword),
    locationCode: num(r.location_code),
    languageCode: str(r.language_code),
    checkUrl: str(r.check_url),
    datetime: str(r.datetime),
    itemTypes: Array.isArray(r.item_types) ? r.item_types.filter((x): x is string => typeof x === 'string') : [],
    seResultsCount: num(r.se_results_count),
    itemsCount: num(r.items_count),
    items: items
      .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
      .map((i) => ({
        type: str(i.type) ?? 'unknown',
        rankGroup: num(i.rank_group),
        rankAbsolute: num(i.rank_absolute),
        url: str(i.url),
        domain: str(i.domain)?.toLowerCase() ?? null,
        title: str(i.title),
        description: str(i.description),
      })),
  };
}

/** "2019-11-15 12:57:46 +00:00" -> ISO-8601 UTC, or null when unparseable. */
export function parseDfsDatetime(v: string | null): string | null {
  if (!v) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*([+-]\d{2}:?\d{2}|Z)?$/.exec(v.trim());
  if (!m) return null;
  const tz = m[3] ? (m[3] === 'Z' ? 'Z' : m[3].includes(':') ? m[3] : `${m[3].slice(0, 3)}:${m[3].slice(3)}`) : 'Z';
  const t = Date.parse(`${m[1]}T${m[2]}${tz}`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function isOwn(ctx: AppContext, item: ParsedSerpItem): boolean {
  if (item.url) return isAllowedHost(item.url, ctx.config.site.allowedHostnames);
  if (item.domain) return ctx.config.site.allowedHostnames.some((h) => h.toLowerCase() === item.domain);
  return false;
}

function itemDomain(item: ParsedSerpItem): string | null {
  if (item.domain) return item.domain;
  const u = item.url ? tryParseUrl(item.url) : null;
  return u ? u.hostname.toLowerCase() : null;
}

export interface StoredSerp {
  snapshotId: string;
  keywordId: string;
  sourceId: string;
  ownRank: number | null | undefined;
  itemsStored: number;
}

/**
 * Store one SERP observation: keyword, snapshot, results (is_own_site via
 * allowed hostnames), a point-in-time ranking (not the GSC average position),
 * serp-discovered competitors, and a provenance source row. Sandbox results
 * stop after the snapshot/results (flagged is_sandbox = 1).
 */
export function storeSerpObservation(
  ctx: AppContext,
  input: { taskRow: TaskRow; meta: TaskMeta; task: DfsTask; rawRef: string; partial: boolean; noResults: boolean },
): StoredSerp {
  const { meta, taskRow } = input;
  const isSandbox = taskRow.is_sandbox === 1;
  const first = input.task.result && input.task.result.length ? input.task.result[0] : null;
  const serp = parseSerpResult(first);
  const now = ctx.clock.now();
  const collectedAt = parseDfsDatetime(serp.datetime) ?? now.toISOString();
  const query = meta.query ?? serp.keyword ?? '';
  const language = meta.languageCode ?? serp.languageCode ?? null;
  const locationCode = meta.locationCode ?? serp.locationCode ?? null;
  const device = meta.device ?? 'desktop';
  const origin = isSandbox ? `dataforseo_${meta.mode}` : 'dataforseo_serp';

  return ctx.db.transaction(() => {
    // One snapshot per task (migration 0200): re-processing a stored task returns it instead of double counting.
    const prior = ctx.db.get<{ id: string; keyword_id: string | null }>('SELECT id, keyword_id FROM serp_snapshots WHERE site_id = ? AND dataforseo_task_id = ?', [ctx.siteId, taskRow.id]);
    if (prior) {
      const src = ctx.db.get<{ id: string }>("SELECT id FROM sources WHERE site_id = ? AND source_type = 'dataforseo' AND json_extract(metadata_json, '$.snapshotId') = ? LIMIT 1", [ctx.siteId, prior.id]);
      const result: StoredSerp = { snapshotId: prior.id, keywordId: prior.keyword_id ?? upsertKeyword(ctx, { keyword: query, language, origin }), sourceId: src?.id ?? '', ownRank: ownRankForSnapshot(ctx, prior.id), itemsStored: 0 };
      return result;
    }
    const keywordId = upsertKeyword(ctx, { keyword: query, language, origin });
    const counts: Record<string, number> = {};
    for (const it of serp.items) counts[it.type] = (counts[it.type] ?? 0) + 1;
    const snapshotId = newId('serp');
    ctx.db.run(
      `INSERT INTO serp_snapshots (id, site_id, keyword_id, query, provider, location_code, language_code, device, depth, parameter_hash, features_json, items_count, is_sandbox, raw_ref, dataforseo_task_id, collected_at, transformation_version)
       VALUES (?, ?, ?, ?, 'dataforseo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshotId,
        ctx.siteId,
        keywordId,
        query,
        locationCode,
        language,
        device,
        meta.depth ?? null,
        taskRow.parameter_hash,
        JSON.stringify({
          item_types: serp.itemTypes,
          counts,
          se_results_count: serp.seResultsCount,
          check_url: serp.checkUrl,
          partial: input.partial,
          no_results: input.noResults,
          mode: meta.mode,
          synthetic: isSandbox,
          transformation_version: SERP_TRANSFORMATION_VERSION,
        }),
        serp.items.length,
        isSandbox ? 1 : 0,
        input.rawRef,
        taskRow.id,
        collectedAt,
        SERP_TRANSFORMATION_VERSION,
      ],
    );
    let stored = 0;
    for (const it of serp.items) {
      const r = ctx.db.run(
        `INSERT OR IGNORE INTO serp_results (snapshot_id, site_id, result_type, rank_group, rank_absolute, url, domain, title, description, is_own_site)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [snapshotId, ctx.siteId, it.type, it.rankGroup, it.rankAbsolute, it.url, itemDomain(it), it.title, it.description, isOwn(ctx, it) ? 1 : 0],
      );
      stored += r.changes;
    }

    const own = serp.items.filter((i) => i.type === 'organic' && isOwn(ctx, i) && i.rankAbsolute !== null).sort((a, b) => a.rankAbsolute! - b.rankAbsolute!)[0];
    // Not found within a PARTIAL result is unknown, not "absent".
    const ownRank: number | null | undefined = own ? own.rankAbsolute : input.partial ? undefined : null;

    const sourceHash = hashObject({ task: taskRow.id, raw: input.rawRef });
    ctx.db.run(
      `INSERT OR IGNORE INTO sources (id, site_id, source_type, trust_class, url, title, retrieved_at, raw_ref, content_hash, metadata_json)
       VALUES (?, ?, 'dataforseo', ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId('src'),
        ctx.siteId,
        isSandbox ? 'synthetic' : 'third_party_data',
        serp.checkUrl,
        `${isSandbox ? `[${meta.mode.toUpperCase()} - SYNTHETIC] ` : ''}Google organic SERP: "${query}" (${locationCode ?? '?'} / ${language ?? '?'} / ${device})`,
        collectedAt,
        input.rawRef,
        sourceHash,
        JSON.stringify({ snapshotId, taskId: taskRow.id, remoteTaskId: taskRow.remote_task_id, transformation_version: SERP_TRANSFORMATION_VERSION, is_sandbox: isSandbox }),
      ],
    );
    const sourceId = ctx.db.get<{ id: string }>('SELECT id FROM sources WHERE site_id = ? AND source_type = ? AND content_hash = ?', [ctx.siteId, 'dataforseo', sourceHash])!.id;

    if (!isSandbox) {
      if (ownRank !== undefined) {
        const pageId = own?.url ? pageIdFor(ctx, own.url) : null;
        ctx.db.run('INSERT INTO rankings (id, site_id, keyword_id, page_id, snapshot_id, rank_absolute, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
          newId('rank'),
          ctx.siteId,
          keywordId,
          pageId,
          snapshotId,
          ownRank,
          collectedAt,
        ]);
      }
      for (const it of serp.items) {
        if (it.type !== 'organic' || isOwn(ctx, it)) continue;
        const domain = itemDomain(it);
        if (!domain) continue;
        ctx.db.run(`INSERT OR IGNORE INTO competitors (id, site_id, domain, name, origin, first_seen_at, notes) VALUES (?, ?, ?, NULL, 'serp_discovered', ?, ?)`, [
          newId('comp'),
          ctx.siteId,
          domain,
          now.toISOString(),
          `First seen in DataForSEO SERP for "${query}"`,
        ]);
      }
    }

    const ttl = ctx.config.research.dataforseo.cacheDays.serp;
    putCached(ctx, {
      siteId: ctx.siteId,
      endpoint: SERP_CACHE_ENDPOINT,
      locationCode,
      languageCode: language,
      device,
      parameterHash: taskRow.parameter_hash,
      mode: meta.mode,
      payloadRef: dbRef('serp_snapshots', snapshotId),
      ttlDays: ttl,
      isSandbox,
      createdAt: new Date(collectedAt),
    });
    return { snapshotId, keywordId, sourceId, ownRank, itemsStored: stored };
  });
}

function pageIdFor(ctx: AppContext, url: string): string | null {
  const n = normalizeUrl(url);
  if (!n) return null;
  return ctx.db.get<{ id: string }>('SELECT id FROM pages WHERE site_id = ? AND url = ?', [ctx.siteId, n.url])?.id ?? null;
}

export function snapshotForTask(ctx: AppContext, taskId: string): { id: string; is_sandbox: number } | undefined {
  return ctx.db.get<{ id: string; is_sandbox: number }>('SELECT id, is_sandbox FROM serp_snapshots WHERE site_id = ? AND dataforseo_task_id = ? ORDER BY collected_at DESC LIMIT 1', [ctx.siteId, taskId]);
}

export function ownRankForSnapshot(ctx: AppContext, snapshotId: string): number | null | undefined {
  const snap = ctx.db.get<{ features_json: string | null }>('SELECT features_json FROM serp_snapshots WHERE id = ? AND site_id = ?', [snapshotId, ctx.siteId]);
  if (!snap) return undefined;
  const row = ctx.db.get<{ r: number | null }>(`SELECT MIN(rank_absolute) AS r FROM serp_results WHERE snapshot_id = ? AND site_id = ? AND is_own_site = 1 AND result_type = 'organic'`, [snapshotId, ctx.siteId]);
  if (row?.r !== null && row?.r !== undefined) return row.r;
  return parseJson<{ partial?: boolean }>(snap.features_json, {}).partial ? undefined : null;
}

/**
 * Top organic competitor pages for a snapshot (own site excluded, first
 * occurrence per URL, ordered by absolute rank). Also registers them in
 * competitor_pages for crawling when the snapshot is real (not sandbox).
 */
export function competitorUrlsForSnapshot(ctx: AppContext, snapshotId: string, limit: number, opts: { register?: boolean } = {}): CompetitorUrl[] {
  const snap = ctx.db.get<{ query: string; is_sandbox: number }>('SELECT query, is_sandbox FROM serp_snapshots WHERE id = ? AND site_id = ?', [snapshotId, ctx.siteId]);
  // A non-finite limit (e.g. NaN from bad input) returns nothing rather than every result.
  if (!snap || !Number.isFinite(limit) || limit <= 0) return [];
  const rows = ctx.db.all<{ url: string; domain: string | null; rank_absolute: number | null; title: string | null }>(
    `SELECT url, domain, rank_absolute, title FROM serp_results
     WHERE snapshot_id = ? AND site_id = ? AND result_type = 'organic' AND is_own_site = 0 AND url IS NOT NULL
     ORDER BY CASE WHEN rank_absolute IS NULL THEN 1 ELSE 0 END, rank_absolute, id`,
    [snapshotId, ctx.siteId],
  );
  const seen = new Set<string>();
  const out: CompetitorUrl[] = [];
  const isSandbox = snap.is_sandbox === 1;
  for (const r of rows) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({
      query: snap.query,
      url: r.url,
      domain: r.domain,
      rankAbsolute: r.rank_absolute,
      title: r.title,
      snapshotId,
      isSandbox,
      usableForRecommendations: !isSandbox || ctx.synthetic,
    });
    if (out.length >= limit) break;
  }
  if (opts.register !== false && !isSandbox) {
    const now = ctx.clock.now().toISOString();
    ctx.db.transaction(() => {
      for (const c of out) {
        if (!c.domain) continue;
        const comp = ctx.db.get<{ id: string }>('SELECT id FROM competitors WHERE site_id = ? AND domain = ?', [ctx.siteId, c.domain]);
        if (!comp) continue;
        ctx.db.run('INSERT OR IGNORE INTO competitor_pages (id, site_id, competitor_id, url, first_seen_at) VALUES (?, ?, ?, ?, ?)', [newId('cpage'), ctx.siteId, comp.id, c.url, now]);
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Keyword volume (Google Ads via DataForSEO): ESTIMATES, not exact demand
// ---------------------------------------------------------------------------

export interface StoredVolume {
  keyword: string;
  keywordId: string;
  metricId: string;
  searchVolume: number | null;
}

/**
 * Store search-volume estimates. search_volume stays NULL when the provider
 * returns none (missing is never 0). competition is stored as
 * competition_index / 100 (0..1). CPC is not persisted: its currency is not
 * verified in docs/integration-contracts.md (it remains in the raw response).
 */
export function storeVolumeObservations(ctx: AppContext, input: { taskRow: TaskRow; meta: TaskMeta; task: DfsTask; rawRef: string }): StoredVolume[] {
  const isSandbox = input.taskRow.is_sandbox === 1;
  const now = ctx.clock.now();
  const ttl = ctx.config.research.dataforseo.cacheDays.keywordVolume;
  const expires = new Date(now.getTime() + Math.max(ttl, 0) * 86_400_000).toISOString();
  const origin = isSandbox ? `dataforseo_${input.meta.mode}` : 'dataforseo_volume';
  const results = (input.task.result ?? []).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
  // Sandbox dummy data may name keywords nobody asked for: keep those out of `keywords` (no sandbox flag there).
  const requested = isSandbox ? new Set((input.meta.keywords ?? []).map((k) => normalizeQuery(k))) : null;
  return ctx.db.transaction(() => {
    const out: StoredVolume[] = [];
    // Volume rows already stored from this exact raw response (re-processing): reuse, never double count.
    const prior = new Map(
      ctx.db
        .all<{ id: string; keyword_id: string; location_code: number | null; language_code: string | null; search_volume: number | null }>(
          "SELECT id, keyword_id, location_code, language_code, search_volume FROM keyword_metrics WHERE site_id = ? AND provider = 'dataforseo' AND raw_ref = ?",
          [ctx.siteId, input.rawRef],
        )
        .map((m) => [`${m.keyword_id}|${m.location_code ?? ''}|${m.language_code ?? ''}`, m]),
    );
    const seen = new Set<string>();
    for (const r of results) {
      const keyword = str(r.keyword);
      if (!keyword) continue;
      if (requested && !requested.has(normalizeQuery(keyword))) continue;
      // The requested location/language (not the echoed values) key the cache, so lookups match.
      const language = input.meta.languageCode ?? str(r.language_code) ?? null;
      const locationCode = input.meta.locationCode ?? num(r.location_code) ?? null;
      const keywordId = upsertKeyword(ctx, { keyword, language, origin });
      const grainKey = `${keywordId}|${locationCode ?? ''}|${language ?? ''}`;
      // The same keyword twice in one response (e.g. differing only in case) is one observation.
      if (seen.has(grainKey)) continue;
      seen.add(grainKey);
      const already = prior.get(grainKey);
      if (already) {
        out.push({ keyword: normalizeQuery(keyword), keywordId, metricId: already.id, searchVolume: already.search_volume });
        continue;
      }
      const ci = num(r.competition_index);
      const monthly = Array.isArray(r.monthly_searches) ? r.monthly_searches : null;
      const metricId = newId('kwm');
      const searchVolume = num(r.search_volume);
      ctx.db.run(
        `INSERT INTO keyword_metrics (id, site_id, keyword_id, provider, location_code, language_code, search_volume, competition, cpc_micros, cpc_currency, monthly_json, is_sandbox, raw_ref, collected_at, expires_at, transformation_version)
         VALUES (?, ?, ?, 'dataforseo', ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
        [
          metricId,
          ctx.siteId,
          keywordId,
          locationCode,
          language,
          searchVolume === null ? null : Math.round(searchVolume),
          ci === null ? null : ci / 100,
          monthly ? JSON.stringify(monthly) : null,
          isSandbox ? 1 : 0,
          input.rawRef,
          now.toISOString(),
          expires,
          VOLUME_TRANSFORMATION_VERSION,
        ],
      );
      putCached(ctx, {
        siteId: ctx.siteId,
        endpoint: VOLUME_CACHE_ENDPOINT,
        locationCode,
        languageCode: language,
        device: null,
        parameterHash: volumeParameterHash(keyword, locationCode, language),
        mode: input.meta.mode,
        payloadRef: dbRef('keyword_metrics', metricId),
        ttlDays: ttl,
        isSandbox,
        createdAt: now,
      });
      out.push({ keyword: normalizeQuery(keyword), keywordId, metricId, searchVolume: searchVolume === null ? null : Math.round(searchVolume) });
    }
    return out;
  });
}

/** Per-keyword parameter hash used for the volume cache (search partners off, default 12-month window). */
export function volumeParameterHash(keyword: string, locationCode: number | null, languageCode: string | null): string {
  return hashObject({ family: 'google_ads_search_volume', keyword: normalizeQuery(keyword), location_code: locationCode, language_code: languageCode?.toLowerCase() ?? null, search_partners: false, window: 'default_12_months' });
}

export function serpParameterHash(input: { keyword: string; locationCode: number; languageCode: string; device: string; depth: number }): string {
  return hashObject({ family: 'google_organic_serp_advanced', keyword: normalizeQuery(input.keyword), location_code: input.locationCode, language_code: input.languageCode.toLowerCase(), device: input.device, depth: input.depth });
}
