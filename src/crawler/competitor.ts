import type { AppContext } from '../app/context.js';
import { DEFAULT_WORKERS, mapBounded } from '../core/concurrency.js';
import { newId } from '../core/ids.js';
import { recordAudit } from '../database/audit.js';
import { json } from '../database/db.js';
import { normalizeQuery } from '../integrations/dataforseo/store.js';
import { normalizeUrl } from '../seo/url.js';
import { buildFetcher, offlineBlock, type CrawlerDeps } from './deps.js';
import { extractPage, loginBarrierAssessment } from './extract.js';
import type { HopDecision } from './fetch.js';
import { RobotsCache } from './robots.js';
import { createCrawl, finishCrawl, insertResult, recordRobots, saveText } from './store.js';
import type { BlockedReason, CrawlCounts, SafeFetchResult } from './types.js';
import { UNTRUSTED_NOTICE } from './untrusted.js';

/**
 * Competitor page crawl for shortlisted ("serious") queries.
 *
 * - Default `crawl.competitorPagesPerQuery` (5) pages per query, expandable up
 *   to `crawl.competitorPagesPerQueryMax` (10). Requests above the cap are
 *   clamped and reported.
 * - Respects robots.txt, stops at login barriers / access denials / bot
 *   challenges, never tries to defeat protections. A blocked page yields an
 *   honest `blocked` outcome with the reason; no content is invented.
 * - Page text is stored verbatim in the raw store as UNTRUSTED data
 *   (sources.trust_class = 'scraped_untrusted'); instruction-like text is
 *   flagged, never followed.
 * - competitor_pages tracks the latest content hash; competitor_changes gets
 *   'new_page' | 'content_changed' | 'title_changed' | 'status_changed' rows.
 * - Scope (research.approvedDomains): a URL WITHOUT a query (manual) is only
 *   crawled when its host is a configured competitor (research.competitors)
 *   or an approved domain (research.approvedDomains), or when the stored page
 *   was discovered in a SERP. Anything else is refused ('not_approved') and
 *   never fetched; a stored page that is no longer approved is skipped.
 *   A URL WITH a query is crawled only when it appears in a stored SERP
 *   snapshot for that (normalized) query (a live snapshot; sandbox snapshots
 *   only in synthetic contexts) or its host is approved. A query is a claim,
 *   not evidence: any text can be passed as a query. The owner may vouch for
 *   query URLs they checked by hand with `manualUrls` (CLI `--manual-urls`):
 *   such pages are recorded as manual (never as SERP-discovered), each
 *   outcome and crawl result carries scope 'manual_urls', and an audit event
 *   lists them before anything is fetched.
 * - Volatility cache (spec section 14): a page whose last successful snapshot
 *   is within a TTL is reused ('cached') instead of re-fetched. The TTL is
 *   research.dataforseo.cacheDays.competitor, halved for pages that changed
 *   within the last TTL window and doubled for pages unchanged over 3+
 *   consecutive successful checks. `refresh: true` bypasses it.
 * - Transient failures (DNS resolution, connection errors) are 'failed' with
 *   failureReason 'dns' | 'connection' and stay eligible for retry; 'blocked'
 *   with 'unsafe_url' is kept for real SSRF policy blocks.
 * - The SSRF guard runs BEFORE a URL becomes a tracked competitor: a
 *   destination refused by policy (loopback, private, link-local, metadata,
 *   blocked port, ...) is recorded only as a crawl result (blocked
 *   'unsafe_url'), never as a competitors / competitor_pages row, so no later
 *   re-check retries it. Each crawl result records `pageRequested` (whether a
 *   request for the page itself was sent) in its details.
 */

export interface CompetitorTarget {
  url: string;
  query?: string | null;
}

export interface CrawlCompetitorOptions extends CrawlerDeps {
  maxPerQuery?: number;
  jobId?: string | null;
  signal?: AbortSignal;
  /** How these URLs were found; 'configured' is used automatically for config competitors. */
  origin?: 'serp_discovered' | 'manual';
  workers?: number;
  /** Re-fetch even when a fresh snapshot is within the volatility TTL (default false: reuse it as 'cached'). */
  refresh?: boolean;
  /**
   * The owner vouches for query URLs that are not in a stored SERP snapshot for
   * their query (CLI `--manual-urls`). Applies only to targets WITH a query;
   * recorded as scope 'manual_urls' on outcomes and crawl results and in the
   * audit log ('crawl.competitor_manual_urls'). Default false: refused as
   * 'not_approved'.
   */
  manualUrls?: boolean;
}

/**
 * Why a competitor URL was in scope: an approved host (research.competitors /
 * research.approvedDomains), a stored SERP snapshot for the target's query, a
 * stored page discovered in a SERP (no query), or the owner's explicit
 * `manualUrls` flag.
 */
export type CompetitorScope = 'approved_domain' | 'serp_snapshot' | 'stored_serp_page' | 'manual_urls';

export type CompetitorPageStatus = 'fetched' | 'blocked' | 'failed' | 'skipped' | 'cached';

/** Crawl blocked reasons plus 'not_approved' (outside research.competitors / research.approvedDomains; never fetched, no crawl row). */
export type CompetitorBlockedReason = BlockedReason | 'not_approved';

/** Why a page is 'failed' when the cause is transient (the page stays eligible for retry). */
export type CompetitorFailureReason = 'dns' | 'connection';

export interface CompetitorCacheInfo {
  /** When the reused snapshot was fetched. */
  snapshotAt: string;
  lastCheckedAt: string;
  ttlDays: number;
  baseTtlDays: number;
  basis: 'base' | 'recently_changed' | 'stable';
}

export interface CompetitorPageOutcome {
  url: string;
  query: string | null;
  status: CompetitorPageStatus;
  blockedReason: CompetitorBlockedReason | null;
  /** Transient failure cause for status 'failed' ('dns' | 'connection'); absent/null otherwise. */
  failureReason?: CompetitorFailureReason | null;
  /** Present for status 'cached': the reused snapshot and the TTL that allowed it. */
  cache?: CompetitorCacheInfo;
  /** Why the URL was in the research scope (absent when it was not: skipped or refused before the scope check, or not_approved). */
  scope?: CompetitorScope;
  reason: string | null;
  httpStatus: number | null;
  finalUrl: string | null;
  resultId: string | null;
  competitorId: string | null;
  competitorPageId: string | null;
  contentHash: string | null;
  title: string | null;
  wordCount: number | null;
  changes: string[];
  injectionSuspected: boolean;
  injectionMatches: string[];
  textRef: string | null;
  sourceId: string | null;
}

export interface CrawlCompetitorResult {
  status: 'completed' | 'partial' | 'failed' | 'disabled' | 'offline' | 'dry_run' | 'empty';
  crawlId: string | null;
  maxPerQuery: number;
  maxPerQueryCap: number;
  pages: CompetitorPageOutcome[];
  counts: CrawlCounts;
  isSynthetic: boolean;
  notes: string[];
  nextStep?: string;
}

function outcome(url: string, query: string | null, status: CompetitorPageStatus, patch: Partial<CompetitorPageOutcome> = {}): CompetitorPageOutcome {
  return {
    url,
    query,
    status,
    blockedReason: null,
    reason: null,
    httpStatus: null,
    finalUrl: null,
    resultId: null,
    competitorId: null,
    competitorPageId: null,
    contentHash: null,
    title: null,
    wordCount: null,
    changes: [],
    injectionSuspected: false,
    injectionMatches: [],
    textRef: null,
    sourceId: null,
    ...patch,
  };
}

export function competitorDomain(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

/** Normalize a configured domain entry ("https://www.x.example/", "*.x.example", "x.example:443") to "x.example". */
export function normalizeDomainEntry(entry: string): string | null {
  const s = entry
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^\*\./, '')
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  return s || null;
}

/** Domains approved for research crawling: configured competitors plus research.approvedDomains. */
export function approvedResearchDomains(ctx: Pick<AppContext, 'config'>): string[] {
  const all = [...ctx.config.research.competitors.map((c) => c.domain), ...ctx.config.research.approvedDomains];
  return [...new Set(all.map(normalizeDomainEntry).filter((d): d is string => !!d))];
}

/** True when the host is an approved domain or a subdomain of one. */
export function isApprovedHost(hostname: string, domains: readonly string[]): boolean {
  const h = competitorDomain(hostname).replace(/\.$/, '');
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Evidence that a stored URL was discovered in a SERP (its competitor is SERP-discovered, or it appears in stored SERP results). */
function storedSerpDiscovered(ctx: AppContext, urls: string[]): boolean {
  const ph = urls.map(() => '?').join(', ');
  const viaCompetitor = ctx.db.get<{ ok: number }>(
    `SELECT 1 AS ok FROM competitor_pages cp JOIN competitors c ON c.id = cp.competitor_id
      WHERE cp.site_id = ? AND c.site_id = ? AND cp.url IN (${ph}) AND c.origin = 'serp_discovered' LIMIT 1`,
    [ctx.siteId, ctx.siteId, ...urls],
  );
  if (viaCompetitor) return true;
  return !!ctx.db.get<{ ok: number }>(`SELECT 1 AS ok FROM serp_results WHERE site_id = ? AND url IN (${ph}) LIMIT 1`, [ctx.siteId, ...urls]);
}

/**
 * URLs (normalized, plus as stored) listed in stored SERP snapshots whose query
 * normalizes to `query`. Live snapshots only; sandbox/fixture snapshots count
 * only in synthetic contexts (demo), where they are the only SERP data.
 */
function serpUrlsForQuery(ctx: AppContext, query: string): Set<string> {
  const q = normalizeQuery(query);
  const snapshots = ctx.db
    .all<{ id: string; query: string; is_sandbox: number }>('SELECT id, query, is_sandbox FROM serp_snapshots WHERE site_id = ?', [ctx.siteId])
    .filter((s) => normalizeQuery(s.query) === q && (s.is_sandbox === 0 || ctx.synthetic));
  const out = new Set<string>();
  for (const s of snapshots) {
    for (const r of ctx.db.all<{ url: string }>('SELECT url FROM serp_results WHERE site_id = ? AND snapshot_id = ? AND url IS NOT NULL', [ctx.siteId, s.id])) {
      out.add(r.url);
      const n = normalizeUrl(r.url);
      if (n) out.add(n.url);
    }
  }
  return out;
}

const DAY_MS = 86_400_000;

/**
 * Volatility TTL for one stored competitor page: research.dataforseo.cacheDays.competitor,
 * halved when the page changed (other than its first snapshot) within the last
 * TTL window, doubled when the last 3+ successful checks saw no change.
 */
export function competitorVolatilityTtl(ctx: AppContext, page: { id: string; url: string }, now: Date = ctx.clock.now()): { ttlDays: number; baseTtlDays: number; basis: CompetitorCacheInfo['basis'] } {
  const base = ctx.config.research.dataforseo.cacheDays.competitor;
  if (!(base > 0)) return { ttlDays: 0, baseTtlDays: 0, basis: 'base' };
  const since = new Date(now.getTime() - base * DAY_MS).toISOString();
  const lastChange = ctx.db.get<{ at: string | null }>(
    `SELECT MAX(detected_at) AS at FROM competitor_changes WHERE site_id = ? AND competitor_page_id = ? AND change_type != 'new_page'`,
    [ctx.siteId, page.id],
  )?.at ?? null;
  if (lastChange && lastChange >= since) return { ttlDays: base / 2, baseTtlDays: base, basis: 'recently_changed' };
  const stableChecks = ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM crawl_results cr JOIN crawls c ON c.id = cr.crawl_id
      WHERE cr.site_id = ? AND c.kind = 'competitor' AND cr.requested_url = ? AND cr.status_code BETWEEN 200 AND 299 AND cr.blocked_reason IS NULL
        AND cr.content_hash IS NOT NULL AND cr.fetched_at >= ?`,
    [ctx.siteId, page.url, lastChange ?? ''],
  )!.n;
  if (stableChecks >= 3) return { ttlDays: base * 2, baseTtlDays: base, basis: 'stable' };
  return { ttlDays: base, baseTtlDays: base, basis: 'base' };
}

interface CachedSnapshot {
  page: { id: string; competitor_id: string; last_checked_at: string };
  result: { id: string; status_code: number; fetched_at: string; final_url: string | null; title: string | null; word_count: number | null; content_hash: string; text_ref: string | null };
  cache: CompetitorCacheInfo;
}

/** A fresh successful snapshot that may be reused instead of re-fetching (null when a fetch is due). */
function freshSnapshot(ctx: AppContext, url: string, now: Date): CachedSnapshot | null {
  const page = ctx.db.get<{ id: string; competitor_id: string; last_crawl_result_id: string | null; last_checked_at: string | null }>(
    'SELECT id, competitor_id, last_crawl_result_id, last_checked_at FROM competitor_pages WHERE site_id = ? AND url = ?',
    [ctx.siteId, url],
  );
  if (!page?.last_crawl_result_id || !page.last_checked_at) return null;
  const result = ctx.db.get<CachedSnapshot['result'] & { blocked_reason: string | null }>(
    'SELECT id, status_code, fetched_at, final_url, title, word_count, content_hash, text_ref, blocked_reason FROM crawl_results WHERE id = ? AND site_id = ?',
    [page.last_crawl_result_id, ctx.siteId],
  );
  if (!result || result.blocked_reason || result.status_code === null || result.status_code < 200 || result.status_code > 299 || !result.content_hash) return null;
  // The most recent check must be that successful snapshot: a later block or failure is re-checked.
  const latest = ctx.db.get<{ id: string }>(
    `SELECT cr.id FROM crawl_results cr JOIN crawls c ON c.id = cr.crawl_id WHERE cr.site_id = ? AND c.kind = 'competitor' AND cr.requested_url = ? ORDER BY cr.fetched_at DESC, cr.rowid DESC LIMIT 1`,
    [ctx.siteId, url],
  );
  if (latest && latest.id !== result.id) return null;
  const ttl = competitorVolatilityTtl(ctx, { id: page.id, url }, now);
  if (ttl.ttlDays <= 0) return null;
  const cutoff = now.getTime() - ttl.ttlDays * DAY_MS;
  if (Date.parse(page.last_checked_at) < cutoff || Date.parse(result.fetched_at) < cutoff) return null;
  return {
    page: { id: page.id, competitor_id: page.competitor_id, last_checked_at: page.last_checked_at },
    result,
    cache: { snapshotAt: result.fetched_at, lastCheckedAt: page.last_checked_at, ttlDays: ttl.ttlDays, baseTtlDays: ttl.baseTtlDays, basis: ttl.basis },
  };
}

/** Transient network failure of a fetch (DNS resolution or connection), as opposed to a policy block. */
function transientFailure(r: Pick<SafeFetchResult, 'errorCode' | 'blockedReason'>): CompetitorFailureReason | null {
  if (r.errorCode === 'unsafe_url:dns_failure') return 'dns';
  if (r.blockedReason === 'network_error' || r.errorCode === 'network_error') return 'connection';
  return null;
}

/**
 * Whether a request for the page itself was sent (stored as `pageRequested` in
 * the crawl result's details): false when the host was in a rate-limit
 * back-off (no attempt) or the first hop was refused or failed DNS resolution.
 */
function pageRequested(r: Pick<SafeFetchResult, 'attempts' | 'status' | 'firstStatus' | 'errorCode'>): boolean {
  if (r.attempts === 0) return false;
  if (r.status === null && r.firstStatus === null && (r.errorCode ?? '').startsWith('unsafe_url:')) return false;
  return true;
}

function ensureCompetitor(ctx: AppContext, host: string, origin: 'serp_discovered' | 'manual'): string {
  const domain = competitorDomain(host);
  const configured = ctx.config.research.competitors.find((c) => competitorDomain(c.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '')) === domain);
  ctx.db.run(
    `INSERT INTO competitors (id, site_id, domain, name, origin, first_seen_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (site_id, domain) DO NOTHING`,
    [newId('comp'), ctx.siteId, domain, configured?.name ?? null, configured ? 'configured' : origin, ctx.clock.now().toISOString()],
  );
  return ctx.db.get<{ id: string }>('SELECT id FROM competitors WHERE site_id = ? AND domain = ?', [ctx.siteId, domain])!.id;
}

interface PrevPage {
  id: string;
  last_content_hash: string | null;
  last_crawl_result_id: string | null;
}

export async function crawlCompetitorPages(ctx: AppContext, targets: ReadonlyArray<string | CompetitorTarget>, opts: CrawlCompetitorOptions = {}): Promise<CrawlCompetitorResult> {
  const c = ctx.config.crawl;
  const cap = c.competitorPagesPerQueryMax;
  const requested = opts.maxPerQuery ?? c.competitorPagesPerQuery;
  const maxPerQuery = Math.max(0, Math.min(requested, cap));
  const notes: string[] = [];
  if (requested > cap) notes.push(`maxPerQuery ${requested} exceeds crawl.competitorPagesPerQueryMax (${cap}); clamped to ${cap}.`);
  const counts: CrawlCounts = { attempted: 0, fetched: 0, blocked: 0, failed: 0, skipped: 0 };
  const result: CrawlCompetitorResult = { status: 'completed', crawlId: null, maxPerQuery, maxPerQueryCap: cap, pages: [], counts, isSynthetic: false, notes };

  if (!ctx.settings.features.crawl) {
    return { ...result, status: 'disabled', notes: [...notes, 'Crawling is disabled for this site (features.crawl: false).'], nextStep: 'Set features.crawl: true in the site config.' };
  }
  // Report outcomes in input order.
  const orderOf = new Map<string, number>();
  const inOrder = (r: CrawlCompetitorResult): CrawlCompetitorResult => {
    r.pages.sort((a, b) => (orderOf.get(a.url) ?? Number.MAX_SAFE_INTEGER) - (orderOf.get(b.url) ?? Number.MAX_SAFE_INTEGER));
    return r;
  };

  // Select: dedupe, drop own-site URLs, enforce the approved research scope, cap per query, reuse fresh snapshots.
  const own = new Set(ctx.config.site.allowedHostnames.map((h) => h.toLowerCase()));
  const approved = approvedResearchDomains(ctx);
  const now0 = ctx.clock.now();
  const perQuery = new Map<string, number>();
  const seen = new Set<string>();
  const selected: Array<{ url: string; query: string | null; scope: CompetitorScope }> = [];
  const serpUrlCache = new Map<string, Set<string>>();
  const serpUrls = (query: string): Set<string> => {
    const key = normalizeQuery(query);
    let set = serpUrlCache.get(key);
    if (!set) serpUrlCache.set(key, (set = serpUrlsForQuery(ctx, query)));
    return set;
  };
  for (const t of targets) {
    const target = typeof t === 'string' ? { url: t, query: null } : { url: t.url, query: t.query ?? null };
    const n = normalizeUrl(target.url);
    const key0 = n?.url ?? target.url;
    if (!orderOf.has(key0)) orderOf.set(key0, orderOf.size);
    if (!n) {
      result.pages.push(outcome(target.url, target.query, 'skipped', { reason: 'not an http(s) URL', blockedReason: 'unsafe_url' }));
      counts.skipped++;
      continue;
    }
    if (seen.has(n.url)) continue;
    seen.add(n.url);
    if (own.has(n.host.toLowerCase())) {
      result.pages.push(outcome(n.url, target.query, 'skipped', { reason: 'own-site URL (use crawl / crawl page)' }));
      counts.skipped++;
      continue;
    }
    // Scope. With a query: the URL must be in a stored SERP snapshot for that query (a query alone is
    // only a claim), or its host approved, or the owner vouches for it (manualUrls, recorded).
    // Without a query: an approved host, or a stored page that keeps its SERP provenance.
    const hostname = new URL(n.url).hostname;
    let scope: CompetitorScope | null = null;
    if (target.query) {
      const listed = serpUrls(target.query);
      if (listed.has(n.url) || listed.has(target.url)) scope = 'serp_snapshot';
      else if (isApprovedHost(hostname, approved)) scope = 'approved_domain';
      else if (opts.manualUrls === true) scope = 'manual_urls';
      if (!scope) {
        const why = `host ${competitorDomain(hostname)} is not in research.competitors or research.approvedDomains and the URL is not in a stored ${ctx.synthetic ? '' : 'live '}SERP snapshot for the query "${normalizeQuery(target.query).slice(0, 200)}"`;
        result.pages.push(
          outcome(n.url, target.query, 'blocked', {
            blockedReason: 'not_approved',
            reason: `Not approved for research crawling: ${why}. Nothing was fetched. Research the query first so its SERP is stored (then only URLs from that SERP are crawled for it), add the domain to research.approvedDomains, or, for URLs you checked yourself, pass --manual-urls (recorded in the audit log).`,
          }),
        );
        counts.blocked++;
        continue;
      }
    } else if (isApprovedHost(hostname, approved)) scope = 'approved_domain';
    else if (storedSerpDiscovered(ctx, [...new Set([n.url, target.url])])) scope = 'stored_serp_page';
    else {
      const stored = !!ctx.db.get<{ id: string }>('SELECT id FROM competitor_pages WHERE site_id = ? AND url = ?', [ctx.siteId, n.url]);
      const why = `host ${competitorDomain(hostname)} is not in research.competitors or research.approvedDomains and the URL was not discovered in a SERP`;
      if (stored) {
        result.pages.push(outcome(n.url, null, 'skipped', { blockedReason: 'not_approved', reason: `Stored competitor page no longer approved (${why}); not re-crawled.` }));
        counts.skipped++;
      } else {
        result.pages.push(
          outcome(n.url, null, 'blocked', {
            blockedReason: 'not_approved',
            reason: `Not approved for research crawling: ${why}. Nothing was fetched. Add the domain to research.approvedDomains; a URL listed in a stored SERP snapshot of a researched query can be crawled with that query (--query).`,
          }),
        );
        counts.blocked++;
      }
      continue;
    }
    const key = target.query ?? '';
    const used = perQuery.get(key) ?? 0;
    if (used >= maxPerQuery) {
      result.pages.push(outcome(n.url, target.query, 'skipped', { reason: `over the ${maxPerQuery}-pages-per-query limit` }));
      counts.skipped++;
      continue;
    }
    perQuery.set(key, used + 1);
    const fresh = opts.refresh ? null : freshSnapshot(ctx, n.url, now0);
    if (fresh) {
      const src = ctx.db.get<{ id: string }>(`SELECT id FROM sources WHERE site_id = ? AND source_type = 'competitor_page' AND url = ? AND content_hash IS ?`, [
        ctx.siteId,
        fresh.result.final_url ?? n.url,
        fresh.result.content_hash,
      ]);
      result.pages.push(
        outcome(n.url, target.query, 'cached', {
          scope,
          competitorId: fresh.page.competitor_id,
          competitorPageId: fresh.page.id,
          resultId: fresh.result.id,
          httpStatus: fresh.result.status_code,
          finalUrl: fresh.result.final_url,
          contentHash: fresh.result.content_hash,
          title: fresh.result.title,
          wordCount: fresh.result.word_count,
          textRef: fresh.result.text_ref,
          sourceId: src?.id ?? null,
          cache: fresh.cache,
          reason: `Reused the snapshot from ${fresh.cache.snapshotAt} (volatility TTL ${fresh.cache.ttlDays} day(s), ${fresh.cache.basis}); not re-fetched.`,
        }),
      );
      continue;
    }
    selected.push({ url: n.url, query: target.query, scope });
  }
  const cachedCount = result.pages.filter((p) => p.status === 'cached').length;
  if (cachedCount) notes.push(`${cachedCount} page(s) reused from the competitor volatility cache (research.dataforseo.cacheDays.competitor); use refresh to re-fetch.`);
  if (!selected.length) {
    const notApproved = result.pages.filter((p) => p.blockedReason === 'not_approved' && p.status === 'blocked').length;
    if (cachedCount) return inOrder({ ...result, status: notApproved ? 'partial' : 'completed' });
    if (notApproved) {
      return inOrder({
        ...result,
        status: 'failed',
        notes: [...notes, 'No competitor URL is within the approved research scope; nothing was fetched.'],
        nextStep:
          'Add the domains to research.approvedDomains (or research.competitors) in the site config. With --query, only URLs listed in a stored SERP snapshot of that query are crawled (research the query first); --manual-urls vouches for URLs you checked yourself and is recorded in the audit log.',
      });
    }
    return inOrder({ ...result, status: 'empty', notes: [...notes, 'No competitor URLs selected for crawling.'] });
  }
  if (ctx.dryRun) {
    for (const s of selected) result.pages.push(outcome(s.url, s.query, 'skipped', { scope: s.scope, reason: 'dry run: would fetch (robots.txt permitting)' }));
    return inOrder({ ...result, status: 'dry_run', notes: [...notes, 'Dry run: no requests were made and nothing was written.'] });
  }
  const offline = offlineBlock(ctx, opts);
  if (offline) {
    for (const s of selected) result.pages.push(outcome(s.url, s.query, 'skipped', { scope: s.scope, reason: offline }));
    return inOrder({ ...result, status: 'offline', notes: [...notes, offline] });
  }

  const fetcher = buildFetcher(ctx, opts);
  const isSynthetic = ctx.synthetic || fetcher.transport.kind === 'fixture';
  result.isSynthetic = isSynthetic;
  const manualSelected = selected.filter((s) => s.scope === 'manual_urls');
  const crawlId = createCrawl(ctx, {
    kind: 'competitor',
    config: { maxPerQuery, cap, userAgent: fetcher.userAgent, targets: selected.length, guard: fetcher.guard.describe(), transport: fetcher.transport.kind, ...(manualSelected.length ? { manualUrls: manualSelected.length } : {}) },
    jobId: opts.jobId ?? null,
    isSynthetic,
  });
  result.crawlId = crawlId;
  if (manualSelected.length) {
    // Recorded before anything is fetched: the owner vouched for query URLs that no stored SERP lists.
    recordAudit(ctx.db, {
      siteId: ctx.siteId,
      actor: 'owner',
      eventType: 'crawl.competitor_manual_urls',
      subjectType: 'crawl',
      subjectId: crawlId,
      details: { flag: 'manual_urls', pages: manualSelected.map((s) => ({ url: s.url, query: s.query })) },
      at: ctx.clock.now(),
    });
  }
  const robots = new RobotsCache(fetcher, { ...(opts.signal ? { signal: opts.signal } : {}), now: () => ctx.clock.now(), onFetched: (p) => recordRobots(ctx, crawlId, p) });
  const renderMode = fetcher.transport.kind === 'fixture' ? 'fixture' : 'http';

  const hopPolicy = async (url: URL, hop: number): Promise<HopDecision> => {
    if (hop === 0) return null;
    const d = await robots.isAllowed(url);
    return d.allowed ? null : { stop: true, blockedReason: 'robots', note: `Redirect target ${d.reason}` };
  };

  const settled = await mapBounded(
    selected,
    Math.max(1, opts.workers ?? DEFAULT_WORKERS),
    async ({ url, query, scope }): Promise<CompetitorPageOutcome> => {
      const host = new URL(url).hostname;
      // Full SSRF validation first (scheme, host, DNS answers): no request at all for unsafe destinations,
      // and a destination refused by policy is never recorded as a tracked competitor or competitor page
      // (so no later re-check retries it). The refusal is kept only as a crawl result (blocked 'unsafe_url').
      const safe = await fetcher.guard.check(url);
      if (!safe.ok && safe.error.reason !== 'dns_failure') {
        const err = safe.error;
        counts.blocked++;
        const resultId = insertResult(ctx, {
          crawlId,
          pageId: null,
          requestedUrl: url,
          fetch: null,
          renderMode,
          robotsAllowed: null,
          extraction: null,
          textRef: null,
          blockedReason: 'unsafe_url',
          error: err.message,
          depth: 0,
          discoveredVia: ['competitor'],
          inSitemap: null,
          extra: { query, scope, pageRequested: false, fetchErrorCode: `unsafe_url:${err.reason}` },
        });
        // A page tracked before this rule (or whose host now resolves to a refused address) keeps its row,
        // but its last_checked_at is not advanced: nothing was requested.
        const tracked = ctx.db.get<{ id: string; competitor_id: string }>('SELECT id, competitor_id FROM competitor_pages WHERE site_id = ? AND url = ?', [ctx.siteId, url]);
        return outcome(url, query, 'blocked', {
          scope,
          competitorId: tracked?.competitor_id ?? null,
          competitorPageId: tracked?.id ?? null,
          blockedReason: 'unsafe_url',
          reason: `Refused by the SSRF guard before any request (${err.reason}): ${err.message}. Not tracked as a competitor page.`,
          resultId,
        });
      }
      // Only a URL listed in a stored SERP for its query is SERP-discovered; a vouched-for or merely
      // approved-domain URL is manual, so it never gains SERP provenance for later re-crawls.
      const origin = scope === 'serp_snapshot' ? (opts.origin ?? 'serp_discovered') : scope === 'manual_urls' || opts.origin === 'serp_discovered' ? 'manual' : (opts.origin ?? 'manual');
      const competitorId = ensureCompetitor(ctx, host, origin);
      const prev = ctx.db.get<PrevPage>('SELECT id, last_content_hash, last_crawl_result_id FROM competitor_pages WHERE site_id = ? AND url = ?', [ctx.siteId, url]);
      const now = ctx.clock.now().toISOString();
      const pageId =
        prev?.id ??
        (() => {
          const id = newId('cpage');
          ctx.db.run('INSERT INTO competitor_pages (id, site_id, competitor_id, url, first_seen_at) VALUES (?, ?, ?, ?, ?)', [id, ctx.siteId, competitorId, url, now]);
          return id;
        })();
      const base = { competitorId, competitorPageId: pageId, scope };

      if (!safe.ok) {
        // DNS failure (NXDOMAIN, timeout, empty answer): transient, not a policy block; the page stays eligible for retry.
        const err = safe.error;
        counts.failed++;
        const resultId = insertResult(ctx, { crawlId, pageId: null, requestedUrl: url, fetch: null, renderMode, robotsAllowed: null, extraction: null, textRef: null, blockedReason: 'network_error', error: err.message, depth: 0, discoveredVia: ['competitor'], inSitemap: null, extra: { query, scope, pageRequested: false, fetchErrorCode: 'unsafe_url:dns_failure', failureReason: 'dns' } });
        ctx.db.run('UPDATE competitor_pages SET last_checked_at = ? WHERE id = ? AND site_id = ?', [now, pageId, ctx.siteId]);
        return outcome(url, query, 'failed', { ...base, failureReason: 'dns', reason: `DNS resolution failed (transient; retried on the next run): ${err.message}`, resultId });
      }
      const decision = await robots.isAllowed(url);
      if (!decision.allowed) {
        counts.blocked++;
        const resultId = insertResult(ctx, { crawlId, pageId: null, requestedUrl: url, fetch: null, renderMode, robotsAllowed: false, extraction: null, textRef: null, blockedReason: 'robots', error: decision.reason, depth: 0, discoveredVia: ['competitor'], inSitemap: null, extra: { query, scope, pageRequested: false } });
        ctx.db.run('UPDATE competitor_pages SET last_checked_at = ? WHERE id = ? AND site_id = ?', [now, pageId, ctx.siteId]);
        return outcome(url, query, 'blocked', { ...base, blockedReason: 'robots', reason: `Not crawled: ${decision.reason}. No content was fetched or inferred.`, resultId });
      }
      counts.attempted++;
      const r = await fetcher.fetch(url, { accept: ['html'], beforeHop: hopPolicy, ...(opts.signal ? { signal: opts.signal } : {}) });
      const isContent = r.status !== null && r.status >= 200 && r.status < 300 && r.text !== null && !r.blockedReason;
      const extraBase = { query, scope, fetchErrorCode: r.errorCode, note: r.note, attempts: r.attempts, pageRequested: pageRequested(r), untrusted: true, notice: UNTRUSTED_NOTICE };
      const prevResult = prev?.last_crawl_result_id
        ? ctx.db.get<{ status_code: number | null; title: string | null; word_count: number | null }>('SELECT status_code, title, word_count FROM crawl_results WHERE id = ? AND site_id = ?', [prev.last_crawl_result_id, ctx.siteId])
        : undefined;

      if (!isContent) {
        const failureReason = transientFailure(r);
        const blocked = failureReason ? null : r.blockedReason;
        if (blocked) counts.blocked++;
        else counts.failed++;
        const resultId = insertResult(ctx, {
          crawlId,
          pageId: null,
          requestedUrl: url,
          fetch: r,
          renderMode,
          robotsAllowed: true,
          extraction: null,
          textRef: null,
          blockedReason: failureReason ? 'network_error' : r.blockedReason,
          error: r.error ?? r.note,
          depth: 0,
          discoveredVia: ['competitor'],
          inSitemap: null,
          extra: { ...extraBase, ...(failureReason ? { failureReason } : {}) },
        });
        const changes: string[] = [];
        // A real HTTP status change (e.g. 200 -> 404) is a change; a block is not evidence of one.
        if (!blocked && r.status !== null && prevResult && prevResult.status_code !== null && prevResult.status_code !== r.status) {
          ctx.db.run('INSERT INTO competitor_changes (id, site_id, competitor_page_id, change_type, previous_hash, new_hash, summary, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
            newId('cchg'),
            ctx.siteId,
            pageId,
            'status_changed',
            prev?.last_content_hash ?? null,
            null,
            `HTTP status ${prevResult.status_code} -> ${r.status}`,
            now,
          ]);
          changes.push('status_changed');
          ctx.db.run('UPDATE competitor_pages SET last_crawl_result_id = ?, last_checked_at = ? WHERE id = ? AND site_id = ?', [resultId, now, pageId, ctx.siteId]);
        } else ctx.db.run('UPDATE competitor_pages SET last_checked_at = ? WHERE id = ? AND site_id = ?', [now, pageId, ctx.siteId]);
        const reason = blocked
          ? `Blocked (${blocked}): ${r.note ?? r.error ?? 'access not permitted'}. No content was fetched or inferred.`
          : failureReason
            ? `Not fetched: ${failureReason === 'dns' ? 'DNS resolution failed' : 'connection error'} (transient; retried on the next run): ${r.error ?? r.note ?? 'no response'}`
            : `Not fetched: ${r.error ?? (r.status !== null ? `HTTP ${r.status}` : 'no response')}`;
        return outcome(url, query, blocked ? 'blocked' : 'failed', { ...base, blockedReason: blocked, ...(failureReason ? { failureReason } : {}), reason, httpStatus: r.status, finalUrl: r.finalUrl, resultId, changes });
      }

      const finalUrl = r.finalUrl ?? url;
      const x = extractPage(r.text!, { url: finalUrl, headers: r.headers, internalHosts: [new URL(finalUrl).hostname] });
      const login = loginBarrierAssessment(x, new URL(finalUrl));
      if (login.barrier) {
        counts.blocked++;
        const detail = `Sign-in page detected (heuristic: ${login.signals.join(', ')})`;
        const resultId = insertResult(ctx, {
          crawlId,
          pageId: null,
          requestedUrl: url,
          fetch: r,
          renderMode,
          robotsAllowed: true,
          extraction: null,
          textRef: null,
          blockedReason: 'login_required',
          error: `${detail}; its text was not stored or analysed.`,
          depth: 0,
          discoveredVia: ['competitor'],
          inSitemap: null,
          extra: { ...extraBase, barrierDetection: 'login_form_heuristic', barrierSignals: login.signals },
        });
        ctx.db.run('UPDATE competitor_pages SET last_checked_at = ? WHERE id = ? AND site_id = ?', [now, pageId, ctx.siteId]);
        return outcome(url, query, 'blocked', {
          ...base,
          blockedReason: 'login_required',
          reason: `Login barrier (heuristic): HTTP ${r.status} returned a sign-in page (${login.signals.join(', ')}). Its text was not stored, analysed, or used to infer anything.`,
          httpStatus: r.status,
          finalUrl,
          resultId,
        });
      }
      counts.fetched++;
      const textRef = x.text ? saveText(ctx, { url: finalUrl, text: x.text, untrusted: true, kind: 'competitor_text' }) : null;
      const resultId = insertResult(ctx, {
        crawlId,
        pageId: null,
        requestedUrl: url,
        fetch: r,
        renderMode,
        robotsAllowed: true,
        extraction: x,
        textRef,
        blockedReason: null,
        error: null,
        depth: 0,
        discoveredVia: ['competitor'],
        inSitemap: null,
        extra: extraBase,
      });

      // Change detection against the previous successful snapshot.
      const changes: Array<{ type: string; summary: string }> = [];
      if (!prev || (!prev.last_content_hash && !prevResult)) changes.push({ type: 'new_page', summary: `First snapshot (${x.wordCount} words)` });
      else {
        if (prev.last_content_hash && x.contentHash && prev.last_content_hash !== x.contentHash) {
          changes.push({ type: 'content_changed', summary: `Visible-text hash changed (words ${prevResult?.word_count ?? 'unknown'} -> ${x.wordCount})` });
        }
        if (prevResult && (prevResult.title ?? '') !== (x.title ?? '')) changes.push({ type: 'title_changed', summary: `Title changed: "${(prevResult.title ?? '').slice(0, 120)}" -> "${(x.title ?? '').slice(0, 120)}"` });
        if (prevResult && prevResult.status_code !== null && prevResult.status_code !== r.firstStatus && prevResult.status_code !== r.status) {
          changes.push({ type: 'status_changed', summary: `HTTP status ${prevResult.status_code} -> ${r.status}` });
        }
      }
      ctx.db.transaction(() => {
        for (const ch of changes) {
          ctx.db.run('INSERT INTO competitor_changes (id, site_id, competitor_page_id, change_type, previous_hash, new_hash, summary, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
            newId('cchg'),
            ctx.siteId,
            pageId,
            ch.type,
            prev?.last_content_hash ?? null,
            x.contentHash,
            ch.summary,
            now,
          ]);
        }
        ctx.db.run('UPDATE competitor_pages SET last_crawl_result_id = ?, last_content_hash = ?, last_checked_at = ? WHERE id = ? AND site_id = ?', [resultId, x.contentHash, now, pageId, ctx.siteId]);
      });
      // Provenance: an untrusted scraped source (never promoted to trusted).
      ctx.db.run(
        `INSERT OR IGNORE INTO sources (id, site_id, source_type, trust_class, url, title, retrieved_at, raw_ref, content_hash, metadata_json)
         VALUES (?, ?, 'competitor_page', 'scraped_untrusted', ?, ?, ?, ?, ?, ?)`,
        [newId('src'), ctx.siteId, finalUrl, x.title, now, textRef, x.contentHash, json({ crawlResultId: resultId, query, injection: x.injection, notice: UNTRUSTED_NOTICE, isSynthetic })],
      );
      const sourceId = ctx.db.get<{ id: string }>(`SELECT id FROM sources WHERE site_id = ? AND source_type = 'competitor_page' AND url = ? AND content_hash IS ?`, [ctx.siteId, finalUrl, x.contentHash])?.id ?? null;
      return outcome(url, query, 'fetched', {
        ...base,
        httpStatus: r.status,
        finalUrl,
        resultId,
        contentHash: x.contentHash,
        title: x.title,
        wordCount: x.wordCount,
        changes: changes.map((ch) => ch.type),
        injectionSuspected: x.injection.suspected,
        injectionMatches: x.injection.matches,
        textRef,
        sourceId,
      });
    },
    opts.signal,
  );
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]!;
    if (s.ok) result.pages.push(s.value);
    else {
      counts.failed++;
      result.pages.push(outcome(selected[i]!.url, selected[i]!.query, 'failed', { scope: selected[i]!.scope, reason: `internal error: ${(s.error as Error)?.message ?? String(s.error)}` }));
    }
  }
  inOrder(result);
  const fetched = result.pages.filter((p) => p.status === 'fetched').length;
  const usable = fetched + result.pages.filter((p) => p.status === 'cached').length;
  const attemptedOrBlocked = result.pages.filter((p) => p.status !== 'skipped').length;
  result.status = usable === 0 ? 'failed' : usable < attemptedOrBlocked ? 'partial' : 'completed';
  if (manualSelected.length) {
    // Written after the fetches so it counts what actually happened, never what was merely selected.
    const manual = result.pages.filter((p) => p.scope === 'manual_urls' && p.status !== 'skipped');
    const manualFetched = manual.filter((p) => p.status === 'fetched').length;
    const manualBlocked = manual.filter((p) => p.status === 'blocked').length;
    const manualFailed = manual.filter((p) => p.status === 'failed').length;
    notes.push(
      `${manualFetched} of ${manualSelected.length} manual page(s) fetched on the owner's word (--manual-urls; not in a stored SERP snapshot for their query; recorded as manual in the audit log); ${manualBlocked} blocked${manualFailed ? `, ${manualFailed} failed` : ''}.`,
    );
  }
  const injected = result.pages.filter((p) => p.injectionSuspected).length;
  if (injected) notes.push(`${injected} page(s) contain instruction-like text; stored as untrusted data only and never followed.`);
  if (usable === 0) result.nextStep = 'All selected competitor pages were blocked or failed; see each page reason. Blocked pages are not retried around protections; transient DNS/connection failures are retried on the next run.';
  finishCrawl(ctx, crawlId, {
    status: result.status === 'completed' ? 'completed' : result.status === 'partial' ? 'partial' : 'failed',
    counts: { ...counts, blocked: counts.blocked },
    stopReason: fetched === 0 ? 'no competitor page could be fetched' : null,
  });
  recordAudit(ctx.db, {
    siteId: ctx.siteId,
    actor: 'system',
    eventType: 'crawl.competitor_finished',
    subjectType: 'crawl',
    subjectId: crawlId,
    details: {
      status: result.status,
      counts,
      maxPerQuery,
      injectedPages: injected,
      cached: result.pages.filter((p) => p.status === 'cached').length,
      notApproved: result.pages.filter((p) => p.blockedReason === 'not_approved').length,
      ...(manualSelected.length ? { manualUrls: manualSelected.length } : {}),
    },
    at: ctx.clock.now(),
  });
  return result;
}

/** Read back stored (untrusted) competitor page text by crawl result id. */
export function loadCompetitorText(ctx: AppContext, resultId: string): { text: string; untrusted: true; notice: string } | null {
  const row = ctx.db.get<{ text_ref: string | null }>('SELECT text_ref FROM crawl_results WHERE id = ? AND site_id = ?', [resultId, ctx.siteId]);
  if (!row?.text_ref) return null;
  const payload = ctx.raw.load<{ text: string }>(row.text_ref);
  if (!payload) return null;
  return { text: payload.text, untrusted: true, notice: UNTRUSTED_NOTICE };
}
