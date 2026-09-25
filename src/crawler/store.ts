import type { AppContext } from '../app/context.js';
import { sha256 } from '../core/hash.js';
import { newId } from '../core/ids.js';
import { json } from '../database/db.js';
import { normalizeUrl } from '../seo/url.js';
import type { PageExtraction, ExtractedLink } from './extract.js';
import type { RobotsPolicy } from './robots.js';
import type { SitemapFileRecord } from './sitemaps.js';
import { matchesAnyPath } from './traps.js';
import type { BlockedReason, CrawlCounts, SafeFetchResult } from './types.js';

/**
 * Persistence for crawls. Every row carries site_id; SQL is parameterized.
 * Extracted visible text lives in the raw store (ctx.raw) and is referenced
 * by crawl_results.text_ref; the database keeps structured fields only.
 *
 * Provenance (migration 0201): every crawl_results row records the extractor
 * version that produced its structured fields (transformation_version) and,
 * when an HTTP response was received, raw_ref: a bounded, redacted copy of
 * the raw response (status, redirect chain, relevant headers, SHA-256 of the
 * full body, and the first RAW_RESPONSE_BODY_MAX_BYTES of a text body), so
 * technical findings can be re-derived and tied to the extraction logic.
 */

/** Version of the fetch-to-row extraction (src/crawler/extract.ts + insertResult). Bump when stored fields change meaning. */
export const CRAWL_EXTRACTOR_VERSION = 'crawl-extract@1';
/** Upper bound of the raw body excerpt kept per response (the full body is represented by its SHA-256). */
export const RAW_RESPONSE_BODY_MAX_BYTES = 64 * 1024;

export type CrawlKind = 'own_site' | 'competitor' | 'single_page';
export type CrawlStatus = 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';

export function createCrawl(ctx: AppContext, input: { kind: CrawlKind; config: Record<string, unknown>; jobId?: string | null; isSynthetic: boolean }): string {
  const id = newId('crawl');
  ctx.db.run(
    `INSERT INTO crawls (id, site_id, kind, status, config_json, job_id, is_synthetic, started_at)
     VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
    [id, ctx.siteId, input.kind, json(input.config), input.jobId ?? null, input.isSynthetic ? 1 : 0, ctx.clock.now().toISOString()],
  );
  return id;
}

export function finishCrawl(ctx: AppContext, crawlId: string, input: { status: Exclude<CrawlStatus, 'running'>; counts: CrawlCounts; stopReason: string | null }): void {
  ctx.db.run(
    `UPDATE crawls SET status = ?, pages_attempted = ?, pages_fetched = ?, pages_blocked = ?, pages_failed = ?, stop_reason = ?, finished_at = ?
     WHERE id = ? AND site_id = ?`,
    [input.status, input.counts.attempted, input.counts.fetched, input.counts.blocked, input.counts.failed, input.stopReason, ctx.clock.now().toISOString(), crawlId, ctx.siteId],
  );
}

export type PageLifecycle = 'active' | 'redirected' | 'gone' | 'unknown';

export function lifecycleFor(status: number | null, redirected: boolean): PageLifecycle {
  if (status === null) return 'unknown';
  if (redirected || (status >= 300 && status < 400)) return 'redirected';
  if (status === 404 || status === 410) return 'gone';
  if (status >= 200 && status < 300) return 'active';
  return 'unknown';
}

/** Upsert a page identity (normalized URL) for this site. Returns the page id, or null for non-http(s) URLs. */
export function upsertPage(
  ctx: AppContext,
  url: string,
  input: { source: 'crawl' | 'sitemap' | 'fixture'; lifecycle?: PageLifecycle | null; language?: string | null },
): string | null {
  const n = normalizeUrl(url);
  if (!n) return null;
  const now = ctx.clock.now().toISOString();
  const pathOnly = n.path;
  const isProtected = matchesAnyPath(pathOnly, ctx.config.crawl.protectedPaths) ? 1 : 0;
  const isExcluded = matchesAnyPath(pathOnly, ctx.config.crawl.excludedPaths) ? 1 : 0;
  ctx.db.run(
    `INSERT INTO pages (id, site_id, url, host, path, first_source, language, is_protected, is_excluded, lifecycle, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (site_id, url) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       language = COALESCE(excluded.language, pages.language),
       is_protected = excluded.is_protected,
       is_excluded = excluded.is_excluded,
       lifecycle = CASE WHEN ? IS NULL THEN pages.lifecycle ELSE excluded.lifecycle END`,
    [newId('page'), ctx.siteId, n.url, n.host, n.path, input.source, input.language ?? null, isProtected, isExcluded, input.lifecycle ?? 'unknown', now, now, input.lifecycle ?? null],
  );
  return ctx.db.get<{ id: string }>('SELECT id FROM pages WHERE site_id = ? AND url = ?', [ctx.siteId, n.url])?.id ?? null;
}

export interface ResultInput {
  crawlId: string;
  pageId: string | null;
  requestedUrl: string;
  fetch: SafeFetchResult | null;
  renderMode: 'http' | 'playwright' | 'fixture';
  robotsAllowed: boolean | null;
  extraction: PageExtraction | null;
  textRef: string | null;
  blockedReason: BlockedReason | null;
  error: string | null;
  depth: number | null;
  discoveredVia: string[];
  inSitemap: boolean | null;
  /** Overrides for a synthesized redirect-target row. */
  finalUrlOverride?: string | null;
  statusOverride?: number | null;
  redirectChainOverride?: unknown;
  extra?: Record<string, unknown>;
  renderDiscrepancies?: unknown;
}

function extractionDetails(x: PageExtraction, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    titleCount: x.titleCount,
    metaDescriptionCount: x.metaDescriptionCount,
    canonicals: x.canonicals,
    headerCanonicals: x.headerCanonicals,
    robots: x.robots,
    h1Count: x.h1Count,
    loginForm: x.loginForm,
    loginFormInContent: x.loginFormInContent,
    passwordInputs: x.passwordInputs,
    contentPasswordInputs: x.contentPasswordInputs,
    metaRefresh: x.metaRefresh,
    scriptCount: x.scriptCount,
    jsShellSuspected: x.jsShellSuspected,
    languageSource: x.languageSource,
    textTruncated: x.textTruncated,
    linksTruncated: x.linksTruncated,
    microdataTypes: x.microdataTypes,
    injection: x.injection,
    externalLinks: x.links.filter((l) => !l.internal).slice(0, 100).map((l) => ({ href: l.href, anchor: l.anchorText, rel: l.rel })),
    ...extra,
  };
}

const TEXT_CONTENT = /^(text\/|application\/(xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml))/i;
const savedResponses = new WeakMap<SafeFetchResult, string>();

/**
 * Save a bounded, redacted copy of a raw HTTP response to the raw store and
 * return its reference (null when nothing was received). Headers are the
 * fetcher's already-redacted relevant headers (never cookies); the raw store
 * redacts the payload again before writing. The same fetch is saved once even
 * when it produces two rows (redirect source and target).
 */
export function saveRawResponse(ctx: AppContext, f: SafeFetchResult | null): string | null {
  if (!f || (f.status === null && f.firstStatus === null && !f.body)) return null;
  const known = savedResponses.get(f);
  if (known) return known;
  const body = f.body ? Buffer.from(f.body) : null;
  const isText = !!f.contentType && TEXT_CONTENT.test(f.contentType);
  const excerpt = body && isText ? body.subarray(0, RAW_RESPONSE_BODY_MAX_BYTES).toString('utf8') : null;
  const ref = ctx.raw.save({
    siteId: ctx.siteId,
    provider: 'crawler',
    kind: 'http_response',
    payload: {
      untrusted: true,
      extractorVersion: CRAWL_EXTRACTOR_VERSION,
      requestedUrl: f.requestedUrl,
      finalUrl: f.finalUrl,
      firstStatus: f.firstStatus,
      status: f.status,
      redirectChain: f.redirectChain,
      contentType: f.contentType,
      headers: f.headers,
      bytes: f.bytes,
      bodySha256: body ? sha256(body) : null,
      body: excerpt,
      bodyStored: body === null ? 'none' : excerpt === null ? 'hash_only' : body.length > RAW_RESPONSE_BODY_MAX_BYTES ? 'truncated' : 'full',
      bodyStoredMaxBytes: RAW_RESPONSE_BODY_MAX_BYTES,
      blockedReason: f.blockedReason,
      errorCode: f.errorCode,
      error: f.error,
      fixture: f.fixture,
    },
    at: ctx.clock.now(),
  });
  savedResponses.set(f, ref);
  return ref;
}

export function insertResult(ctx: AppContext, r: ResultInput): string {
  const id = newId('cres');
  const f = r.fetch;
  const x = r.extraction;
  const rawRef = saveRawResponse(ctx, f);
  ctx.db.run(
    `INSERT INTO crawl_results (
       id, crawl_id, site_id, page_id, requested_url, final_url, status_code, redirect_chain_json, content_type, bytes, fetched_at,
       render_mode, headers_json, robots_allowed, meta_robots, x_robots_tag, canonical_url, hreflang_json, title, meta_description,
       headings_json, word_count, language, text_ref, content_hash, structured_data_json, images_json, links_internal, links_external,
       render_discrepancies_json, blocked_reason, error, depth, discovered_via_json, in_sitemap, text_simhash, extraction_json, transformation_version, raw_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      r.crawlId,
      ctx.siteId,
      r.pageId,
      r.requestedUrl,
      r.finalUrlOverride !== undefined ? r.finalUrlOverride : (f?.finalUrl ?? null),
      r.statusOverride !== undefined ? r.statusOverride : (f?.firstStatus ?? null),
      r.redirectChainOverride !== undefined ? json(r.redirectChainOverride) : f && f.redirectChain.length ? json(f.redirectChain) : null,
      f?.contentType ?? null,
      f?.bytes ?? null,
      ctx.clock.now().toISOString(),
      r.renderMode,
      f ? json(f.headers) : null,
      r.robotsAllowed === null ? null : r.robotsAllowed ? 1 : 0,
      x?.metaRobots ?? null,
      x?.xRobotsTag ?? f?.headers['x-robots-tag'] ?? null,
      x?.canonical ?? null,
      x && x.hreflang.length ? json(x.hreflang) : null,
      x?.title ?? null,
      x?.metaDescription ?? null,
      x ? json(x.headings) : null,
      x?.wordCount ?? null,
      x?.language ?? null,
      r.textRef,
      x?.contentHash ?? null,
      x ? json({ jsonLd: x.structuredData, types: x.structuredDataTypes, microdataTypes: x.microdataTypes }) : null,
      x ? json(x.images) : null,
      x?.internalLinkCount ?? null,
      x?.externalLinkCount ?? null,
      r.renderDiscrepancies === undefined ? null : json(r.renderDiscrepancies),
      r.blockedReason,
      r.error,
      r.depth,
      json(r.discoveredVia),
      r.inSitemap === null ? null : r.inSitemap ? 1 : 0,
      x?.simhash ?? null,
      x ? json(extractionDetails(x, r.extra)) : r.extra ? json(r.extra) : null,
      CRAWL_EXTRACTOR_VERSION,
      rawRef,
    ],
  );
  return id;
}

export function insertInternalLinks(ctx: AppContext, crawlId: string, resultId: string, sourcePageId: string | null, links: readonly ExtractedLink[]): number {
  let n = 0;
  ctx.db.transaction(() => {
    for (const l of links) {
      if (!l.internal) continue;
      const target = normalizeUrl(l.href)?.url ?? l.href;
      const r = ctx.db.run(
        `INSERT OR IGNORE INTO internal_links (site_id, crawl_id, source_result_id, source_page_id, target_url, anchor_text, rel, is_nofollow, context_snippet)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ctx.siteId, crawlId, resultId, sourcePageId, target, l.anchorText, l.rel, l.nofollow ? 1 : 0, l.context],
      );
      n += r.changes;
    }
  });
  return n;
}

/** After a crawl, resolve internal link targets to known page ids. */
export function linkTargetsToPages(ctx: AppContext, crawlId: string): void {
  ctx.db.run(
    `UPDATE internal_links SET target_page_id = (SELECT p.id FROM pages p WHERE p.site_id = internal_links.site_id AND p.url = internal_links.target_url)
     WHERE crawl_id = ? AND site_id = ?`,
    [crawlId, ctx.siteId],
  );
}

export function recordRobots(ctx: AppContext, crawlId: string, policy: RobotsPolicy): void {
  const i = policy.info;
  const rawRef = i.text !== null ? ctx.raw.save({ siteId: ctx.siteId, provider: 'crawler', kind: 'robots_txt', payload: { origin: i.origin, text: i.text }, at: ctx.clock.now() }) : null;
  ctx.db.run(
    `INSERT OR REPLACE INTO crawl_robots (id, site_id, crawl_id, origin, state, http_status, allow_all, disallow_all, sitemaps_json, crawl_delay_ms, note, raw_ref, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId('robots'), ctx.siteId, crawlId, i.origin, i.state, i.httpStatus, i.allowAll ? 1 : 0, i.disallowAll ? 1 : 0, json(i.sitemaps), i.crawlDelayMs, i.note, rawRef, i.fetchedAt],
  );
}

export function recordSitemaps(ctx: AppContext, crawlId: string, files: readonly SitemapFileRecord[]): void {
  const at = ctx.clock.now().toISOString();
  ctx.db.transaction(() => {
    for (const f of files) {
      ctx.db.run(
        `INSERT OR IGNORE INTO crawl_sitemaps (id, site_id, crawl_id, url, source, kind, status, http_status, is_gzip, urls_found, child_sitemaps, reason, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId('smap'), ctx.siteId, crawlId, f.url, f.source, f.kind, f.status, f.httpStatus, f.gzip ? 1 : 0, f.urlsFound, f.childSitemaps, f.reason, at],
      );
    }
  });
}

/** Save extracted visible text to the raw store (never into the DB or vault). */
export function saveText(ctx: AppContext, input: { url: string; text: string; untrusted: boolean; kind?: string }): string {
  return ctx.raw.save({
    siteId: ctx.siteId,
    provider: 'crawler',
    kind: input.kind ?? 'page_text',
    payload: { url: input.url, untrusted: input.untrusted, text: input.text },
    at: ctx.clock.now(),
  });
}
