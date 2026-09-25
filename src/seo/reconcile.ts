import { systemClock, type Clock } from '../core/clock.js';
import { newId } from '../core/ids.js';
import type { SiteConfig } from '../config/site-schema.js';
import { parseJson, type Db } from '../database/db.js';
import { commercialPageTypesFromConfig } from '../router/rules.js';
import { describeUrlDifference, matchesPathPattern, normalizePercentEncoding, normalizeUrl, tryParseUrl, type NormalizedUrl, type UrlDifference } from './url.js';

/**
 * URL reconciliation layer.
 *
 * - Every observed RAW URL is preserved in `url_aliases.alias_url` exactly as
 *   observed (GA4 host+path pairs are recorded scheme-relative, `//host/path`,
 *   because GA4 does not report a scheme).
 * - A page (`pages.url`) is the conservative normalized identity (see url.ts).
 * - Distinct identities are merged ONLY with recorded evidence:
 *     redirect  (observed in crawl_results.redirect_chain_json; every hop
 *                301/308 and the final URL's own response 2xx. The crawler
 *                stores the FIRST status on the redirecting row and the final
 *                response on the final URL's own row, so the target is judged
 *                by that row, never by the redirecting row's 3xx)
 *     canonical (rel=canonical agreeing both ways; Google-selected canonical,
 *                when inspected, must not disagree)
 *     configured (site.urlAliases in the site config; `prefix*` wildcard rules
 *                are owner assertions that apply whenever the mapped page
 *                exists, and outrank identity/crawl evidence)
 *     manual    (owner-recorded; never overwritten by automation)
 *   Only `established` merge evidence is followed during resolution.
 *   `probable`/`unverified` evidence is recorded for review, never merged.
 * - www/non-www, http/https, trailing slash, path case, locale paths, and
 *   meaningful query parameters stay distinct without such evidence.
 * - Identities stored under an older normalization (before percent-encoding
 *   was normalized: "/%d0%bf" vs "/%D0%BF", "/%7Ea" vs "/~a") still join:
 *   lookups fall back to the page whose stored URL re-normalizes to the
 *   identity, and each run first rewrites such a page's URL in place (same
 *   page id, so nothing splits; the old string is kept as an identity alias).
 *   When another page already holds the new identity, the page seen first
 *   keeps it and the other resolves to it (reported in `identities`).
 * - Page types: site.pageTypes (path glob -> type) is applied to every page on
 *   each run (pages.page_type_source 'config'); a type set by the owner
 *   (`pages set-type`, source 'owner') always wins, and a config type whose
 *   rule was removed is cleared. Inferred types ('inferred') are replaced by
 *   a matching config rule, never the other way round.
 */

export const RECONCILE_VERSION = 'reconcile@1.2.0';

export type AliasRelation =
  | 'identical'
  | 'tracking_params_removed'
  | 'host_case'
  | 'default_port'
  | 'fragment_removed'
  | 'redirect'
  | 'canonical'
  | 'configured'
  | 'manual'
  | 'ga4_path'
  | 'gsc_url';
export type AliasConfidence = 'established' | 'probable' | 'unverified';
export type PageSource = 'crawl' | 'sitemap' | 'gsc' | 'ga4' | 'config' | 'manual' | 'fixture';

const IDENTITY_RELATIONS: ReadonlySet<AliasRelation> = new Set(['identical', 'tracking_params_removed', 'host_case', 'default_port', 'fragment_removed', 'gsc_url', 'ga4_path']);
const MERGE_RELATIONS: ReadonlySet<AliasRelation> = new Set(['redirect', 'canonical', 'configured', 'manual']);
const PERMANENT_REDIRECTS: ReadonlySet<number> = new Set([301, 308]);
const TEMPORARY_REDIRECTS: ReadonlySet<number> = new Set([302, 303, 307]);
const MAX_ALIAS_HOPS = 10;

export interface PageRow {
  id: string;
  site_id: string;
  url: string;
  host: string;
  path: string;
  first_source: string;
  page_type: string | null;
  /** Provenance of page_type: 'owner' | 'config' | 'inferred' | NULL (unknown/none). Present after migration 0211. */
  page_type_source?: string | null;
  language: string | null;
  is_protected: number;
  is_excluded: number;
  lifecycle: string;
  first_seen_at: string;
  last_seen_at: string;
}

export interface AliasRow {
  id: string;
  page_id: string;
  alias_url: string;
  relation: AliasRelation;
  confidence: AliasConfidence;
  evidence_json: string | null;
  source: string;
}

export type UnresolvedReason = 'invalid_url' | 'host_not_allowed' | 'not_set' | 'missing_host' | 'unknown_page' | 'ambiguous_scheme' | 'alias_cycle';

export interface ResolutionStep {
  from: string;
  to: string;
  relation: AliasRelation | 'normalized';
  confidence: AliasConfidence;
}

export type Resolution =
  | { status: 'resolved'; raw: string; normalizedUrl: string; pageId: string; pageUrl: string; steps: ResolutionStep[] }
  | { status: 'unresolved'; raw: string; normalizedUrl: string | null; reason: UnresolvedReason; detail: string };

export interface EvidenceCounts {
  established: number;
  probable: number;
  unverified: number;
}

export interface ReconcileReport {
  version: string;
  siteId: string;
  ranAt: string;
  pagesCreated: number;
  aliasesWritten: number;
  configured: { applied: number; wildcardRules: number; skipped: Array<{ alias: string; reason: string }> };
  redirects: EvidenceCounts & { stale: number };
  canonicals: EvidenceCounts & { stale: number };
  metricRows: Record<'gscPage' | 'gscPageQuery' | 'ga4Landing', { distinctRaw: number; resolved: number; unresolved: number; rowsUpdated: number }>;
  crawlRowsFilled: { crawlResults: number; internalLinkTargets: number; internalLinkSources: number };
  unresolved: Array<{ dataset: 'gsc_page_daily' | 'gsc_page_query_daily' | 'ga4_landing_daily'; raw: string; reason: UnresolvedReason; detail: string; rows: number }>;
  conflicts: Array<{ aliasUrl: string; kept: { pageId: string; relation: string; confidence: string }; rejected: { pageId: string; relation: string; confidence: string }; reason: string }>;
  /** Pages that look similar (scheme, www, trailing slash, case, query order) but have no merge evidence; kept distinct. */
  distinctVariants: Array<{ urls: string[]; differences: UrlDifference[]; note: string }>;
  /** Page types from site.pageTypes: applied/cleared config types, owner types kept over config, pages typed commercial (router.commercialPageTypes). */
  pageTypes?: { rules: number; applied: number; cleared: number; ownerKept: number; commercialPages: number };
  /**
   * Stored identities re-normalized to the current URL normalization
   * (percent-encoding, RFC 3986 6.2.2): `renormalized` pages had their URL
   * rewritten in place (same page id); `duplicates` are pages whose identity
   * another page already holds; they resolve to `pageId` and are listed for
   * review (their own history stays on `duplicatePageId`).
   */
  identities?: { renormalized: number; duplicates: Array<{ duplicatePageId: string; duplicateUrl: string; pageId: string; pageUrl: string; note: string }> };
}

export interface ReconcilerConfig {
  /** `pageTypes` (optional): path glob -> page type, as the schema's list `[{ match, type }]` (or a map `{ "/pricing": "offer" }`). */
  site: Pick<SiteConfig['site'], 'url' | 'allowedHostnames' | 'urlAliases'> & { pageTypes?: unknown };
  crawl: Pick<SiteConfig['crawl'], 'protectedPaths' | 'excludedPaths'>;
  /** `router.commercialPageTypes` (optional) is read to count commercial pages. */
  router?: unknown;
}

export interface PageTypeRule {
  pattern: string;
  type: string;
}

/** Page types are short slugs (e.g. offer, product, category, tool, article). */
export const PAGE_TYPE_RE = /^[a-z][a-z0-9_-]{0,39}$/;

/**
 * Read site.pageTypes: `[{ match, type }]` (the site-config schema; `path`,
 * `glob`, or `pattern` are accepted as aliases of `match`) or a map
 * `{ "<path glob>": "<type>" }`. Types are trimmed and lower-cased; empty or
 * over-long entries are ignored (config validation reports them). Order is
 * kept and the first matching rule wins.
 */
export function pageTypeRules(pageTypes: unknown): PageTypeRule[] {
  const out: PageTypeRule[] = [];
  const add = (pattern: unknown, type: unknown) => {
    if (typeof pattern !== 'string' || typeof type !== 'string') return;
    const t = type.trim().toLowerCase();
    if (pattern.trim() && t && t.length <= 40) out.push({ pattern: pattern.trim(), type: t });
  };
  if (Array.isArray(pageTypes)) {
    for (const r of pageTypes) {
      if (!r || typeof r !== 'object') continue;
      const o = r as Record<string, unknown>;
      add(o.match ?? o.path ?? o.glob ?? o.pattern, o.type);
    }
  } else if (pageTypes && typeof pageTypes === 'object') {
    for (const [pattern, type] of Object.entries(pageTypes as Record<string, unknown>)) add(pattern, type);
  }
  return out;
}

/**
 * Match a path against a page-type glob. Without interior wildcards the
 * crawl.protectedPaths semantics apply ("/blog/*" prefix, "/pricing" exact or
 * below). With interior wildcards: "*" matches within one path segment and
 * "**" across segments.
 */
export function matchesPageTypePattern(path: string, pattern: string): boolean {
  const p = pattern.trim();
  const interior = p.replace(/\*+$/, '');
  if (!interior.includes('*')) return matchesPathPattern(path, p);
  const re = new RegExp(`^${p.split('**').map((part) => part.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`);
  return re.test(path);
}

interface WildcardAlias {
  fromPrefix: string;
  toPrefix: string;
  evidence: string | null;
  raw: string;
}

interface CrawlRow {
  id: string;
  crawl_id: string;
  requested_url: string;
  final_url: string | null;
  status_code: number | null;
  redirect_chain_json: string | null;
  canonical_url: string | null;
  fetched_at: string;
  extraction_json: string | null;
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** A row that is the URL's own final response (no redirect recorded, final URL = requested URL). */
function isDirectRow(r: Pick<CrawlRow, 'requested_url' | 'final_url' | 'redirect_chain_json'>): boolean {
  if (parseRedirectChain(r.redirect_chain_json, r.requested_url).length > 0) return false;
  if (!r.final_url) return true;
  return (normalizeUrl(r.final_url)?.url ?? r.final_url) === (normalizeUrl(r.requested_url)?.url ?? r.requested_url);
}

interface ChainHop {
  url: string;
  status: number | null;
}

function precedence(relation: AliasRelation, confidence: AliasConfidence): number {
  if (relation === 'manual') return 100;
  if (relation === 'configured') return 90;
  if (relation === 'redirect') return confidence === 'established' ? 75 : confidence === 'probable' ? 45 : 30;
  if (relation === 'canonical') return confidence === 'established' ? 65 : confidence === 'probable' ? 40 : 30;
  return confidence === 'unverified' ? 5 : 10;
}

/** An alias row may be used for resolution when it is an identity alias or established merge evidence. */
function usableAlias(a: AliasRow): boolean {
  if (IDENTITY_RELATIONS.has(a.relation)) return a.confidence !== 'unverified';
  return a.confidence === 'established';
}

function relationForChanges(n: NormalizedUrl, sourceRelation: AliasRelation): AliasRelation {
  if (n.changes.includes('tracking_params_removed')) return 'tracking_params_removed';
  if (n.changes.includes('fragment_removed')) return 'fragment_removed';
  if (n.changes.includes('default_port')) return 'default_port';
  if (n.changes.includes('host_case')) return 'host_case';
  return sourceRelation;
}

function isOk(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

/**
 * The current identity of a URL stored under an older normalization, or null
 * when the stored URL is already normalized. Only percent-encoding differs
 * between the normalizations (reconcile@1.2.0), so only that change counts.
 */
export function renormalizedIdentity(storedUrl: string): NormalizedUrl | null {
  if (!storedUrl.includes('%')) return null;
  const n = normalizeUrl(storedUrl);
  if (!n || n.url === storedUrl || !n.changes.every((c) => c === 'percent_encoding')) return null;
  return n;
}

export function parseRedirectChain(json: string | null, requestedUrl: string): ChainHop[] {
  const raw = parseJson<unknown>(json, null);
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const hops: ChainHop[] = [];
  for (const item of raw) {
    if (typeof item === 'string') hops.push({ url: item, status: null });
    else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const url = [o.url, o.from, o.requestedUrl, o.requested_url].find((v): v is string => typeof v === 'string');
      const st = [o.status, o.statusCode, o.status_code].find((v): v is number => typeof v === 'number');
      if (url) hops.push({ url, status: st ?? null });
    }
  }
  if (hops.length && normalizeUrl(hops[0]!.url)?.url !== normalizeUrl(requestedUrl)?.url) hops.unshift({ url: requestedUrl, status: null });
  return hops;
}

export class UrlReconciler {
  private readonly allowed: Set<string>;
  private readonly siteScheme: 'https' | 'http';
  private readonly wildcards: WildcardAlias[] = [];
  private readonly typeRules: PageTypeRule[];
  private readonly commercialTypes: Set<string>;
  private report: ReconcileReport;
  /** True inside run() once stored identities were re-normalized: no legacy fallback lookups are needed then. */
  private identitiesSettled = false;
  /** Per host: current identity -> id of the page stored under an older normalization (built on first use). */
  private readonly legacyByHost = new Map<string, Map<string, string>>();

  constructor(
    private readonly db: Db,
    private readonly siteId: string,
    private readonly config: ReconcilerConfig,
    private readonly clock: Clock = systemClock,
  ) {
    this.allowed = new Set(config.site.allowedHostnames.map((h) => h.toLowerCase()));
    this.typeRules = pageTypeRules(config.site.pageTypes);
    this.commercialTypes = new Set(commercialPageTypesFromConfig({ router: (config.router ?? {}) as SiteConfig['router'] }));
    this.siteScheme = tryParseUrl(config.site.url)?.protocol === 'http:' ? 'http' : 'https';
    for (const a of config.site.urlAliases) {
      if (a.alias.endsWith('*') && a.canonical.endsWith('*')) {
        // Prefixes are compared with normalized URLs, so their percent-encoding is normalized too.
        this.wildcards.push({ fromPrefix: normalizePercentEncoding(a.alias.slice(0, -1)), toPrefix: normalizePercentEncoding(a.canonical.slice(0, -1)), evidence: a.evidence, raw: a.alias });
      }
    }
    this.report = this.emptyReport();
  }

  private emptyReport(): ReconcileReport {
    const m = () => ({ distinctRaw: 0, resolved: 0, unresolved: 0, rowsUpdated: 0 });
    return {
      version: RECONCILE_VERSION,
      siteId: this.siteId,
      ranAt: this.now(),
      pagesCreated: 0,
      aliasesWritten: 0,
      configured: { applied: 0, wildcardRules: this.wildcards?.length ?? 0, skipped: [] },
      redirects: { established: 0, probable: 0, unverified: 0, stale: 0 },
      canonicals: { established: 0, probable: 0, unverified: 0, stale: 0 },
      metricRows: { gscPage: m(), gscPageQuery: m(), ga4Landing: m() },
      crawlRowsFilled: { crawlResults: 0, internalLinkTargets: 0, internalLinkSources: 0 },
      unresolved: [],
      conflicts: [],
      distinctVariants: [],
      pageTypes: { rules: this.typeRules?.length ?? 0, applied: 0, cleared: 0, ownerKept: 0, commercialPages: 0 },
      identities: { renormalized: 0, duplicates: [] },
    };
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  isAllowedHost(host: string): boolean {
    return this.allowed.has(host.toLowerCase());
  }

  /**
   * The page holding a normalized identity. Falls back to a page stored under
   * an older normalization whose URL re-normalizes to it (e.g. "/%d0%bf" for
   * "/%D0%BF"), so such pages keep joining and are never duplicated.
   */
  pageByUrl(url: string): PageRow | undefined {
    return this.exactPage(url) ?? this.legacyPage(url);
  }

  private exactPage(url: string): PageRow | undefined {
    return this.db.get<PageRow>('SELECT * FROM pages WHERE site_id = ? AND url = ?', [this.siteId, url]);
  }

  /** A page stored under an older normalization whose identity is `url` (the first seen when several). */
  private legacyPage(url: string): PageRow | undefined {
    if (this.identitiesSettled) return undefined;
    const host = tryParseUrl(url)?.hostname;
    if (!host) return undefined;
    let index = this.legacyByHost.get(host);
    if (!index) {
      // Current code never writes a page under an older normalization, so this index only shrinks (run() rebuilds it).
      index = new Map();
      for (const p of this.db.all<{ id: string; url: string }>("SELECT id, url FROM pages WHERE site_id = ? AND host = ? AND instr(url, '%') > 0 ORDER BY first_seen_at, id", [this.siteId, host])) {
        const n = renormalizedIdentity(p.url);
        if (n && !index.has(n.url)) index.set(n.url, p.id);
      }
      this.legacyByHost.set(host, index);
    }
    const id = index.get(url);
    const page = id ? this.pageById(id) : undefined;
    return page && renormalizedIdentity(page.url)?.url === url ? page : undefined;
  }

  /** For a page stored under an older normalization: the OTHER page that holds its current identity. */
  private identityHolder(page: PageRow): PageRow | undefined {
    const n = renormalizedIdentity(page.url);
    if (!n) return undefined;
    const holder = this.exactPage(n.url);
    return holder && holder.id !== page.id ? holder : undefined;
  }

  /**
   * Rewrite page URLs stored under an older normalization to their current
   * identity (percent-encoding, RFC 3986 6.2.2). The page id is kept, so
   * nothing that references the page splits; the old string is recorded as an
   * identity alias. When another page already holds the identity (for example
   * a crawl created it before this pass ran), the page seen first keeps the
   * identity (URLs are swapped when that is the stored-old page, so its
   * history stays with the identity) and the other resolves to it.
   */
  private renormalizeStoredIdentities(): void {
    const stats = this.report.identities!;
    const rows = this.db.all<PageRow>("SELECT * FROM pages WHERE site_id = ? AND instr(url, '%') > 0 ORDER BY first_seen_at, id", [this.siteId]);
    for (const page of rows) {
      const n = renormalizedIdentity(page.url);
      if (!n) continue;
      const evidence = { reason: 'stored identity re-normalized: percent-encoding (RFC 3986 6.2.2.1-6.2.2.2)', previousUrl: page.url, normalizedUrl: n.url, changes: n.changes };
      const holder = this.exactPage(n.url);
      if (!holder) {
        this.db.run('UPDATE pages SET url = ?, path = ? WHERE site_id = ? AND id = ?', [n.url, n.path, this.siteId, page.id]);
        if (!this.aliasFor(page.url)) this.recordAlias(page.url, page.id, 'identical', 'established', evidence, page.first_source);
        stats.renormalized++;
        continue;
      }
      let kept = holder;
      let duplicate = page;
      if (page.first_seen_at < holder.first_seen_at) {
        // The stored-old page came first: it keeps the identity (and its history); the newer page takes the old string.
        this.db.run('UPDATE pages SET url = ? WHERE site_id = ? AND id = ?', [`${page.url}#reconcile-swap-${page.id}`, this.siteId, page.id]);
        this.db.run('UPDATE pages SET url = ?, path = ? WHERE site_id = ? AND id = ?', [page.url, page.path, this.siteId, holder.id]);
        this.db.run('UPDATE pages SET url = ?, path = ? WHERE site_id = ? AND id = ?', [n.url, n.path, this.siteId, page.id]);
        if (!this.aliasFor(page.url)) this.recordAlias(page.url, page.id, 'identical', 'established', evidence, page.first_source);
        stats.renormalized++;
        kept = this.pageById(page.id)!;
        duplicate = this.pageById(holder.id)!;
      }
      stats.duplicates.push({
        duplicatePageId: duplicate.id,
        duplicateUrl: duplicate.url,
        pageId: kept.id,
        pageUrl: kept.url,
        note: 'Same URL by definition (percent-encoding differs only); the duplicate resolves to pageId. Records attached to the duplicate page id stay there; review them.',
      });
    }
  }

  pageById(id: string): PageRow | undefined {
    return this.db.get<PageRow>('SELECT * FROM pages WHERE site_id = ? AND id = ?', [this.siteId, id]);
  }

  aliasFor(aliasUrl: string): AliasRow | undefined {
    return this.db.get<AliasRow>('SELECT id, page_id, alias_url, relation, confidence, evidence_json, source FROM url_aliases WHERE site_id = ? AND alias_url = ?', [this.siteId, aliasUrl]);
  }

  private pageFlags(path: string): { isProtected: number; isExcluded: number; pageType: string | null } {
    return {
      isProtected: this.config.crawl.protectedPaths.some((p) => matchesPathPattern(path, p)) ? 1 : 0,
      isExcluded: this.config.crawl.excludedPaths.some((p) => matchesPathPattern(path, p)) ? 1 : 0,
      // site.pageTypes: the first matching glob decides (source 'config').
      pageType: this.typeRules.find((r) => matchesPageTypePattern(path, r.pattern))?.type ?? null,
    };
  }

  /** Create the page for a normalized identity if missing (allowed hosts only). */
  ensurePage(n: NormalizedUrl, source: PageSource): PageRow | null {
    if (!this.isAllowedHost(n.host)) return null;
    const existing = this.pageByUrl(n.url);
    const now = this.now();
    if (existing) {
      if (existing.last_seen_at < now) this.db.run('UPDATE pages SET last_seen_at = ? WHERE id = ?', [now, existing.id]);
      return existing;
    }
    const id = newId('page');
    const flags = this.pageFlags(n.path);
    this.db.run(
      `INSERT INTO pages (id, site_id, url, host, path, first_source, page_type, page_type_source, is_protected, is_excluded, lifecycle, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)`,
      [id, this.siteId, n.url, n.host, n.path, source, flags.pageType, flags.pageType ? 'config' : null, flags.isProtected, flags.isExcluded, now, now],
    );
    if (flags.pageType) this.report.pageTypes!.applied++;
    this.report.pagesCreated++;
    return this.pageById(id)!;
  }

  /**
   * Insert or update alias evidence, respecting precedence: manual > configured >
   * established redirect > established canonical > weaker evidence > identity.
   * Weaker evidence never overwrites stronger evidence; the conflict is reported.
   */
  recordAlias(aliasUrl: string, pageId: string, relation: AliasRelation, confidence: AliasConfidence, evidence: Record<string, unknown>, source: string): 'inserted' | 'updated' | 'unchanged' | 'rejected' {
    const existing = this.aliasFor(aliasUrl);
    const now = this.now();
    const ev = JSON.stringify({ ...evidence, reconcileVersion: RECONCILE_VERSION });
    if (!existing) {
      this.db.run(
        `INSERT INTO url_aliases (id, site_id, page_id, alias_url, relation, confidence, evidence_json, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId('alias'), this.siteId, pageId, aliasUrl, relation, confidence, ev, source, now, now],
      );
      this.report.aliasesWritten++;
      return 'inserted';
    }
    const oldP = precedence(existing.relation, existing.confidence);
    const newP = precedence(relation, confidence);
    if (newP < oldP) {
      if (existing.page_id !== pageId) {
        this.report.conflicts.push({
          aliasUrl,
          kept: { pageId: existing.page_id, relation: existing.relation, confidence: existing.confidence },
          rejected: { pageId, relation, confidence },
          reason: 'weaker evidence does not overwrite stronger recorded evidence',
        });
      }
      return 'rejected';
    }
    if (existing.page_id === pageId && existing.relation === relation && existing.confidence === confidence) {
      const prev = parseJson<Record<string, unknown>>(existing.evidence_json, {});
      const next = parseJson<Record<string, unknown>>(ev, {});
      if (JSON.stringify(prev) === JSON.stringify(next)) return 'unchanged';
    }
    if (existing.page_id !== pageId && MERGE_RELATIONS.has(existing.relation) && existing.confidence === 'established') {
      this.report.conflicts.push({
        aliasUrl,
        kept: { pageId, relation, confidence },
        rejected: { pageId: existing.page_id, relation: existing.relation, confidence: existing.confidence },
        reason: 'newer evidence of equal or higher precedence changed the target; latest observation kept',
      });
    }
    this.db.run('UPDATE url_aliases SET page_id = ?, relation = ?, confidence = ?, evidence_json = ?, source = ?, updated_at = ? WHERE id = ?', [
      pageId,
      relation,
      confidence,
      ev,
      source,
      now,
      existing.id,
    ]);
    this.report.aliasesWritten++;
    return 'updated';
  }

  /** Replace stale merge evidence (e.g. a redirect no longer observed) with the URL's own identity. */
  private downgradeToIdentity(existing: AliasRow, ownPage: PageRow, reason: string): void {
    const prev = parseJson<Record<string, unknown>>(existing.evidence_json, {});
    this.db.run('UPDATE url_aliases SET page_id = ?, relation = ?, confidence = ?, evidence_json = ?, source = ?, updated_at = ? WHERE id = ?', [
      ownPage.id,
      'identical',
      'established',
      JSON.stringify({ reason, supersededEvidence: { relation: existing.relation, confidence: existing.confidence, pageId: existing.page_id, evidence: prev }, reconcileVersion: RECONCILE_VERSION }),
      'reconcile',
      this.now(),
      existing.id,
    ]);
    this.report.aliasesWritten++;
  }

  private matchWildcard(rawUrl: string): string | null {
    const url = normalizePercentEncoding(rawUrl);
    for (const w of this.wildcards) {
      if (url.startsWith(w.fromPrefix)) return `${w.toPrefix}${url.slice(w.fromPrefix.length)}`;
    }
    return null;
  }

  /**
   * The next identity for a page under established merge evidence:
   * a recorded manual/configured/redirect/canonical alias, or a configured
   * wildcard rule whose mapped page exists (owner assertion, precedence of
   * `configured`). A manual alias always wins; an exact alias wins ties.
   * A page stored under an older normalization whose identity another page
   * holds resolves to that page (step 'normalized') when no merge evidence
   * applies.
   */
  private nextMerge(page: PageRow): { page: PageRow; relation: AliasRelation | 'normalized' } | null {
    const e = this.aliasFor(page.url);
    const eUsable = !!e && MERGE_RELATIONS.has(e.relation) && e.confidence === 'established';
    // Wildcard rules have `configured` precedence: they outrank identity, crawl, and weaker
    // evidence, but not an exact configured alias or a manual (owner-recorded) alias.
    if (!e || precedence(e.relation, e.confidence) < precedence('configured', 'established')) {
      const w = this.matchWildcard(page.url);
      const wn = w ? normalizeUrl(w) : null;
      const target = wn ? this.pageByUrl(wn.url) : undefined;
      if (target && target.id !== page.id) return { page: target, relation: 'configured' };
    }
    if (e && eUsable && e.page_id !== page.id) {
      const next = this.pageById(e.page_id);
      if (next) return { page: next, relation: e.relation };
    }
    const holder = this.identityHolder(page);
    return holder ? { page: holder, relation: 'normalized' } : null;
  }

  /** Follow established merge evidence from a page to its final identity. */
  private followMerges(start: PageRow, steps: ResolutionStep[]): PageRow | 'cycle' {
    let page = start;
    const seen = new Set<string>([page.id]);
    for (let i = 0; i < MAX_ALIAS_HOPS; i++) {
      const n = this.nextMerge(page);
      if (!n) return page;
      // An identity step back into a page already on the path adds nothing: stop there instead of reporting a cycle.
      if (seen.has(n.page.id)) return n.relation === 'normalized' ? page : 'cycle';
      steps.push({ from: page.url, to: n.page.url, relation: n.relation, confidence: 'established' });
      seen.add(n.page.id);
      page = n.page;
    }
    return 'cycle';
  }

  private resolvedPage(url: string): PageRow | null {
    const r = this.resolve(url);
    return r.status === 'resolved' ? (this.pageById(r.pageId) ?? null) : null;
  }

  /** Read-only resolution of a raw URL to its page identity. Never writes. */
  resolve(raw: string): Resolution {
    const n = normalizeUrl(raw);
    if (!n) return { status: 'unresolved', raw, normalizedUrl: null, reason: 'invalid_url', detail: 'not an absolute http(s) URL' };
    const steps: ResolutionStep[] = [];
    let page: PageRow | undefined;
    const alias = this.aliasFor(raw) ?? (raw !== n.url ? this.aliasFor(n.url) : undefined);
    if (alias && usableAlias(alias)) {
      page = this.pageById(alias.page_id);
      if (page) steps.push({ from: raw, to: page.url, relation: alias.relation, confidence: alias.confidence });
    }
    if (!page) {
      const w = this.matchWildcard(n.url);
      const wn = w ? normalizeUrl(w) : null;
      if (wn) {
        page = this.pageByUrl(wn.url);
        if (page) steps.push({ from: n.url, to: page.url, relation: 'configured', confidence: 'established' });
      }
    }
    if (!page) {
      page = this.pageByUrl(n.url);
      if (page) steps.push({ from: raw, to: page.url, relation: 'normalized', confidence: 'established' });
    }
    if (!page) {
      return this.isAllowedHost(n.host)
        ? { status: 'unresolved', raw, normalizedUrl: n.url, reason: 'unknown_page', detail: 'no page recorded for this identity yet' }
        : { status: 'unresolved', raw, normalizedUrl: n.url, reason: 'host_not_allowed', detail: `host ${n.host} is not in site.allowedHostnames and has no recorded alias` };
    }
    const final = this.followMerges(page, steps);
    if (final === 'cycle') return { status: 'unresolved', raw, normalizedUrl: n.url, reason: 'alias_cycle', detail: 'alias evidence forms a cycle; review url_aliases' };
    return { status: 'resolved', raw, normalizedUrl: n.url, pageId: final.id, pageUrl: final.url, steps };
  }

  /** Scheme-relative key used to record GA4 host+path observations. */
  static ga4AliasKey(landingPage: string, hostName: string): string {
    return `//${hostName.toLowerCase()}${landingPage}`;
  }

  private ga4Precheck(landingPage: string, hostName: string): Resolution | null {
    if (!landingPage || landingPage === '(not set)') return { status: 'unresolved', raw: landingPage, normalizedUrl: null, reason: 'not_set', detail: 'GA4 landing page is "(not set)" (session without a page_view); kept as an explicit bucket' };
    if (/^https?:\/\//i.test(landingPage)) return null;
    if (!hostName) return { status: 'unresolved', raw: landingPage, normalizedUrl: null, reason: 'missing_host', detail: 'GA4 row has no hostName; landing paths are resolved only with a hostName (re-sync GA4 with the hostName dimension)' };
    if (!landingPage.startsWith('/')) return { status: 'unresolved', raw: landingPage, normalizedUrl: null, reason: 'invalid_url', detail: 'GA4 landing page is not a path' };
    return null;
  }

  /** Read-only resolution of a GA4 landing path + hostName. */
  resolveGa4(landingPage: string, hostName: string): Resolution {
    const pre = this.ga4Precheck(landingPage, hostName);
    if (pre) return pre;
    if (/^https?:\/\//i.test(landingPage)) return this.resolve(landingPage);
    const key = UrlReconciler.ga4AliasKey(landingPage, hostName);
    const alias = this.aliasFor(key);
    if (alias && usableAlias(alias)) {
      const page = this.pageById(alias.page_id);
      if (page) {
        const steps: ResolutionStep[] = [{ from: key, to: page.url, relation: alias.relation, confidence: alias.confidence }];
        const final = this.followMerges(page, steps);
        if (final === 'cycle') return { status: 'unresolved', raw: key, normalizedUrl: page.url, reason: 'alias_cycle', detail: 'alias evidence forms a cycle' };
        return { status: 'resolved', raw: key, normalizedUrl: page.url, pageId: final.id, pageUrl: final.url, steps };
      }
    }
    const cands = this.ga4Candidates(landingPage, hostName);
    if (cands.kind === 'unique') return { status: 'resolved', raw: key, normalizedUrl: cands.page.url, pageId: cands.page.id, pageUrl: cands.page.url, steps: [{ from: key, to: cands.page.url, relation: 'ga4_path', confidence: 'established' }] };
    if (cands.kind === 'ambiguous') return { status: 'unresolved', raw: key, normalizedUrl: null, reason: 'ambiguous_scheme', detail: cands.detail };
    if (!this.isAllowedHost(hostName)) return { status: 'unresolved', raw: key, normalizedUrl: null, reason: 'host_not_allowed', detail: `hostName ${hostName} is not in site.allowedHostnames` };
    return { status: 'unresolved', raw: key, normalizedUrl: null, reason: 'unknown_page', detail: 'no page recorded for this host+path yet' };
  }

  private ga4Candidates(landingPage: string, hostName: string): { kind: 'unique'; page: PageRow } | { kind: 'ambiguous'; detail: string; preferred: NormalizedUrl | null } | { kind: 'none'; preferred: NormalizedUrl | null } {
    const variants = (['https', 'http'] as const)
      .map((scheme) => normalizeUrl(`${scheme}://${hostName}${landingPage}`))
      .filter((v): v is NormalizedUrl => v !== null);
    const found = new Map<string, PageRow>();
    for (const v of variants) {
      const r = this.resolve(v.url);
      if (r.status === 'resolved') found.set(r.pageId, this.pageById(r.pageId)!);
    }
    const preferred = variants.find((v) => v.url.startsWith(`${this.siteScheme}:`)) ?? variants[0] ?? null;
    if (found.size === 1) return { kind: 'unique', page: [...found.values()][0]! };
    if (found.size > 1) return { kind: 'ambiguous', detail: `both http and https pages exist for ${hostName}${landingPage} without merge evidence; GA4 does not report the scheme`, preferred };
    return { kind: 'none', preferred };
  }

  /** Record a raw URL observation: ensures its identity page (allowed hosts) and an identity alias. */
  observe(raw: string, source: PageSource, sourceRelation: AliasRelation = 'identical'): Resolution {
    const n = normalizeUrl(raw);
    if (!n) return { status: 'unresolved', raw, normalizedUrl: null, reason: 'invalid_url', detail: 'not an absolute http(s) URL' };
    const pre = this.resolve(raw);
    if (pre.status === 'resolved' || !this.isAllowedHost(n.host)) {
      if (pre.status === 'resolved' && !this.aliasFor(raw)) {
        const own = this.pageByUrl(n.url);
        if (own) this.recordAlias(raw, own.id, relationForChanges(n, sourceRelation), 'established', { source, normalizedUrl: n.url, changes: n.changes, removedParams: n.removedParams }, source);
      }
      return pre;
    }
    const page = this.ensurePage(n, source);
    if (!page) return pre;
    const existing = this.aliasFor(raw);
    if (!existing || precedence(existing.relation, existing.confidence) <= 10) {
      this.recordAlias(raw, page.id, relationForChanges(n, sourceRelation), 'established', { source, normalizedUrl: n.url, changes: n.changes, removedParams: n.removedParams }, source);
    }
    return this.resolve(raw);
  }

  private hasNonGa4Evidence(page: PageRow): boolean {
    if (page.first_source !== 'ga4') return true;
    const a = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM url_aliases WHERE site_id = ? AND page_id = ? AND source != 'ga4'", [this.siteId, page.id]);
    const c = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM crawl_results cr JOIN crawls k ON k.id = cr.crawl_id
        WHERE cr.site_id = ? AND k.kind IN ('own_site', 'single_page') AND (cr.page_id = ? OR cr.final_url = ? OR cr.requested_url = ?)`,
      [this.siteId, page.id, page.url, page.url],
    );
    return (a?.n ?? 0) > 0 || (c?.n ?? 0) > 0;
  }

  /** Record a GA4 landing observation and resolve it with its hostName. */
  observeGa4(landingPage: string, hostName: string): Resolution {
    const pre = this.ga4Precheck(landingPage, hostName);
    if (pre) return pre;
    if (/^https?:\/\//i.test(landingPage)) return this.observe(landingPage, 'ga4', 'ga4_path');
    const key = UrlReconciler.ga4AliasKey(landingPage, hostName);
    const existing = this.aliasFor(key);
    if (existing && (existing.relation === 'manual' || existing.relation === 'configured')) return this.resolveGa4(landingPage, hostName);
    const cands = this.ga4Candidates(landingPage, hostName);
    const evidence = { source: 'ga4', hostName, landingPage };
    if (cands.kind === 'unique') {
      // A page first created from this GA4 observation is not independent evidence of its scheme.
      const independent = this.hasNonGa4Evidence(cands.page);
      this.recordAlias(key, cands.page.id, 'ga4_path', independent ? 'established' : 'probable', { ...evidence, scheme: independent ? 'inferred: exactly one known page matches host+path' : `assumed "${this.siteScheme}" from site.url; the page is known only from GA4` }, 'ga4');
    } else if (cands.kind === 'ambiguous') {
      const p = cands.preferred ? this.pageByUrl(cands.preferred.url) : undefined;
      if (p) this.recordAlias(key, p.id, 'ga4_path', 'unverified', { ...evidence, scheme: 'ambiguous', detail: cands.detail }, 'ga4');
      return { status: 'unresolved', raw: key, normalizedUrl: null, reason: 'ambiguous_scheme', detail: cands.detail };
    } else {
      if (!cands.preferred || !this.isAllowedHost(hostName)) return this.resolveGa4(landingPage, hostName);
      const page = this.ensurePage(cands.preferred, 'ga4');
      if (!page) return this.resolveGa4(landingPage, hostName);
      this.recordAlias(key, page.id, 'ga4_path', 'probable', { ...evidence, scheme: `assumed "${this.siteScheme}" from site.url; no page for this host+path was known`, changes: cands.preferred.changes }, 'ga4');
    }
    return this.resolveGa4(landingPage, hostName);
  }

  /** Apply site.urlAliases from configuration (owner-asserted evidence). */
  applyConfiguredAliases(): void {
    for (const a of this.config.site.urlAliases) {
      if (a.alias.endsWith('*') || a.canonical.endsWith('*')) {
        if (!(a.alias.endsWith('*') && a.canonical.endsWith('*'))) this.report.configured.skipped.push({ alias: a.alias, reason: 'wildcard aliases need "*" on both alias and canonical' });
        continue;
      }
      const target = normalizeUrl(a.canonical);
      const from = normalizeUrl(a.alias);
      if (!target || !from) {
        this.report.configured.skipped.push({ alias: a.alias, reason: 'alias or canonical is not an absolute http(s) URL' });
        continue;
      }
      if (target.url === from.url) continue;
      const page = this.ensurePage(target, 'config');
      if (!page) {
        this.report.configured.skipped.push({ alias: a.alias, reason: `canonical host ${target.host} is not in site.allowedHostnames` });
        continue;
      }
      const ev = { source: 'site_config', canonical: a.canonical, ownerEvidence: a.evidence ?? null };
      this.recordAlias(a.alias, page.id, 'configured', 'established', ev, 'config');
      if (from.url !== a.alias) this.recordAlias(from.url, page.id, 'configured', 'established', ev, 'config');
      this.report.configured.applied++;
    }
  }

  /** Latest own-site crawl observation per normalized requested URL. */
  private latestOwnCrawlRows(): CrawlRow[] {
    const rows = this.db.all<CrawlRow>(
      `SELECT cr.id, cr.crawl_id, cr.requested_url, cr.final_url, cr.status_code, cr.redirect_chain_json, cr.canonical_url, cr.fetched_at, cr.extraction_json
         FROM crawl_results cr JOIN crawls c ON c.id = cr.crawl_id
        WHERE cr.site_id = ? AND c.site_id = ? AND c.kind IN ('own_site', 'single_page')
        ORDER BY cr.fetched_at DESC, cr.id DESC`,
      [this.siteId, this.siteId],
    );
    const seen = new Set<string>();
    const out: CrawlRow[] = [];
    for (const r of rows) {
      const key = normalizeUrl(r.requested_url)?.url ?? r.requested_url;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    return out;
  }

  /**
   * Status of the final URL of a redirect, judged by the final URL's own
   * response, never by the redirecting row's first (3xx) status:
   *   1. the latest direct crawl row of the final URL (the crawler stores the
   *      final response there), unless the redirecting row is newer and
   *      recorded the final status itself;
   *   2. `finalStatus` recorded on the redirecting row (crawler extraction_json);
   *   3. the last chain hop when it is the final URL and carries a status;
   *   4. the redirecting row's own status only when it is not a redirect
   *      status (rows that store the final status on the redirecting row).
   */
  private redirectTargetStatus(r: CrawlRow, finUrl: string, chain: ChainHop[], direct: Map<string, CrawlRow>): { status: number | null; basis: string } {
    const own = direct.get(finUrl);
    const extra = parseJson<Record<string, unknown>>(r.extraction_json, {});
    const recorded = typeof extra.finalStatus === 'number' ? extra.finalStatus : null;
    if (own && (recorded === null || own.fetched_at >= r.fetched_at)) return { status: own.status_code, basis: `final URL's own crawl row ${own.id} (${own.fetched_at})` };
    if (recorded !== null) return { status: recorded, basis: 'final status recorded with the redirect (same response)' };
    const last = chain[chain.length - 1];
    if (last && normalizeUrl(last.url)?.url === finUrl && last.status !== null) return { status: last.status, basis: 'last hop of the recorded redirect chain' };
    if (r.status_code !== null && !REDIRECT_STATUSES.has(r.status_code)) return { status: r.status_code, basis: 'status stored with the redirect' };
    return { status: null, basis: 'the final URL was not fetched (no final status recorded)' };
  }

  /** Latest direct (non-redirecting) own-site crawl row per normalized URL. */
  private latestDirectRows(rows: CrawlRow[]): Map<string, CrawlRow> {
    const out = new Map<string, CrawlRow>();
    for (const r of rows) {
      if (!isDirectRow(r)) continue;
      const k = normalizeUrl(r.final_url ?? r.requested_url)?.url;
      if (k && !out.has(k)) out.set(k, r);
    }
    return out;
  }

  /** Redirect evidence from crawl_results.redirect_chain_json (own-site crawls only). */
  applyRedirectEvidence(): void {
    const rows = this.latestOwnCrawlRows();
    const direct = this.latestDirectRows(rows);
    for (const r of rows) {
      const chain = parseRedirectChain(r.redirect_chain_json, r.requested_url);
      const req = normalizeUrl(r.requested_url);
      const fin = r.final_url ? normalizeUrl(r.final_url) : null;
      if (!req) continue;
      if (req.host && this.isAllowedHost(req.host)) this.ensurePage(req, 'crawl');
      if (chain.length === 0 || !fin || fin.url === req.url) {
        // No redirect in the latest observation: stale redirect evidence is superseded.
        if (isOk(r.status_code) && (!fin || fin.url === req.url)) {
          this.db.run("UPDATE pages SET lifecycle = 'active' WHERE site_id = ? AND url = ? AND lifecycle = 'unknown'", [this.siteId, req.url]);
          const existing = this.aliasFor(r.requested_url) ?? this.aliasFor(req.url);
          const own = this.pageByUrl(req.url);
          if (existing && existing.relation === 'redirect' && own && existing.page_id !== own.id) {
            this.downgradeToIdentity(existing, own, `redirect no longer observed (crawl ${r.crawl_id} at ${r.fetched_at} returned ${r.status_code})`);
            this.db.run("UPDATE pages SET lifecycle = 'active' WHERE id = ? AND lifecycle = 'redirected'", [own.id]);
            this.report.redirects.stale++;
          }
        }
        continue;
      }
      const statuses = chain.filter((h) => normalizeUrl(h.url)?.url !== fin.url).map((h) => h.status);
      const target0 = this.redirectTargetStatus(r, fin.url, chain, direct);
      let confidence: AliasConfidence;
      let note: string;
      if (!isOk(target0.status)) {
        confidence = 'unverified';
        note = `redirect target returned ${target0.status ?? 'no status'} (${target0.basis}); not merged`;
      } else if (!this.isAllowedHost(fin.host) && !this.aliasFor(fin.url)) {
        confidence = 'unverified';
        note = `redirect leaves site.allowedHostnames (${fin.host}); not merged`;
      } else if (statuses.length && statuses.every((s) => s !== null && PERMANENT_REDIRECTS.has(s))) {
        confidence = 'established';
        note = 'permanent redirect (301/308) observed in crawl';
      } else if (statuses.some((s) => s !== null && TEMPORARY_REDIRECTS.has(s))) {
        confidence = 'probable';
        note = 'temporary redirect (302/303/307) observed; not treated as equivalence';
      } else {
        confidence = 'probable';
        note = 'redirect observed but hop status codes were not recorded; not treated as equivalence';
      }
      const target = this.ensurePage(fin, 'crawl') ?? this.resolvedPage(fin.url);
      if (!target) {
        this.report.redirects.unverified++;
        continue;
      }
      const evidence = { source: 'crawl', crawlId: r.crawl_id, crawlResultId: r.id, fetchedAt: r.fetched_at, chain, finalUrl: r.final_url, firstStatus: r.status_code, finalStatus: target0.status, finalStatusBasis: target0.basis, note };
      for (const hop of chain) {
        const hn = normalizeUrl(hop.url);
        if (!hn || hn.url === fin.url) continue;
        this.recordAlias(hop.url, target.id, 'redirect', confidence, evidence, 'crawl');
        if (hn.url !== hop.url) this.recordAlias(hn.url, target.id, 'redirect', confidence, evidence, 'crawl');
        if (confidence === 'established') {
          const hp = this.pageByUrl(hn.url);
          if (hp && hp.id !== target.id) this.db.run("UPDATE pages SET lifecycle = 'redirected' WHERE id = ?", [hp.id]);
        }
      }
      // Only a 2xx final response makes the target active (never overwrite a crawler's 'gone').
      if (isOk(target0.status) && target.lifecycle !== 'active') this.db.run("UPDATE pages SET lifecycle = 'active' WHERE id = ?", [target.id]);
      this.report.redirects[confidence]++;
    }
  }

  /**
   * rel=canonical evidence. Established only when the declaring page's
   * canonical target is crawled, returns 2xx, and declares itself canonical
   * (agreement both ways), with no recorded canonical conflict and no
   * disagreeing Google-selected canonical from URL Inspection.
   */
  applyCanonicalEvidence(): void {
    const rows = this.latestOwnCrawlRows();
    // A URL's own final response (direct row) describes it; a redirecting row
    // (first status 3xx, no content) never does. Rows that store a 2xx final
    // status on the redirecting row are used only when no direct row exists.
    const byFinal = this.latestDirectRows(rows);
    for (const r of rows) {
      if (isDirectRow(r) || r.status_code === null || REDIRECT_STATUSES.has(r.status_code)) continue;
      const f = normalizeUrl(r.final_url ?? r.requested_url);
      if (f && !byFinal.has(f.url)) byFinal.set(f.url, r);
    }
    for (const [finalUrl, r] of byFinal) {
      if (!isOk(r.status_code)) continue;
      const f = normalizeUrl(finalUrl)!;
      const c = r.canonical_url ? normalizeUrl(r.canonical_url, r.final_url ?? r.requested_url) : null;
      const existing = this.aliasFor(f.url);
      if (!c || c.url === f.url) {
        const own = this.pageByUrl(f.url);
        if (existing && existing.relation === 'canonical' && own && existing.page_id !== own.id) {
          this.downgradeToIdentity(existing, own, `canonical to another URL no longer declared (crawl ${r.crawl_id} at ${r.fetched_at})`);
          this.report.canonicals.stale++;
        }
        continue;
      }
      const target = byFinal.get(c.url);
      const targetCanonical = target?.canonical_url ? normalizeUrl(target.canonical_url, target.final_url ?? target.requested_url) : null;
      const conflict = this.db.get<{ issue_type: string }>(
        "SELECT issue_type FROM technical_issues WHERE site_id = ? AND url IN (?, ?) AND status = 'open' AND issue_type LIKE '%canonical%' LIMIT 1",
        [this.siteId, f.url, r.requested_url],
      );
      const inspection = this.db.get<{ google_canonical: string | null; inspected_at: string }>(
        'SELECT google_canonical, inspected_at FROM url_inspections WHERE site_id = ? AND url IN (?, ?) ORDER BY inspected_at DESC LIMIT 1',
        [this.siteId, f.url, r.requested_url],
      );
      const googleCanonical = inspection?.google_canonical ? normalizeUrl(inspection.google_canonical) : null;
      let confidence: AliasConfidence = 'established';
      let note = 'rel=canonical agrees both ways (target is self-canonical and 2xx)';
      if (!this.isAllowedHost(c.host)) {
        confidence = 'unverified';
        note = `canonical points outside site.allowedHostnames (${c.host})`;
      } else if (conflict) {
        confidence = 'unverified';
        note = `open technical issue "${conflict.issue_type}" reports conflicting canonical directives`;
      } else if (!target) {
        confidence = 'unverified';
        note = 'canonical target was not crawled; agreement cannot be checked';
      } else if (!isOk(target.status_code)) {
        confidence = 'unverified';
        note = `canonical target returned ${target.status_code ?? 'no status'}`;
      } else if (targetCanonical && targetCanonical.url !== c.url) {
        confidence = 'unverified';
        note = `canonical target declares a different canonical (${targetCanonical.url}); different canonical targets are never merged`;
      } else if (!targetCanonical) {
        confidence = 'probable';
        note = 'canonical target does not declare a canonical; one-way agreement only';
      } else if (googleCanonical && googleCanonical.url !== c.url) {
        confidence = 'unverified';
        note = `Google-selected canonical (${googleCanonical.url}) differs from the declared canonical`;
      }
      const page = this.ensurePage(c, 'crawl');
      if (!page) {
        this.report.canonicals.unverified++;
        continue;
      }
      this.ensurePage(f, 'crawl');
      this.recordAlias(f.url, page.id, 'canonical', confidence, {
        source: 'crawl',
        crawlId: r.crawl_id,
        crawlResultId: r.id,
        fetchedAt: r.fetched_at,
        declaredCanonical: r.canonical_url,
        targetCrawlResultId: target?.id ?? null,
        targetCanonical: target?.canonical_url ?? null,
        googleCanonical: inspection?.google_canonical ?? null,
        note,
      }, 'crawl');
      this.report.canonicals[confidence]++;
    }
  }

  /**
   * Re-apply protected/excluded flags and site.pageTypes from the current
   * configuration. Owner-set types (page_type_source 'owner') always win; a
   * config type whose rule no longer matches is cleared; inferred or legacy
   * (source NULL) types are replaced only by a matching config rule.
   */
  refreshPageFlags(): void {
    const pages = this.db.all<{ id: string; path: string; is_protected: number; is_excluded: number; page_type: string | null; page_type_source: string | null }>(
      'SELECT id, path, is_protected, is_excluded, page_type, page_type_source FROM pages WHERE site_id = ?',
      [this.siteId],
    );
    const stats = this.report.pageTypes!;
    for (const p of pages) {
      const f = this.pageFlags(p.path);
      if (f.isProtected !== p.is_protected || f.isExcluded !== p.is_excluded) {
        this.db.run('UPDATE pages SET is_protected = ?, is_excluded = ? WHERE id = ?', [f.isProtected, f.isExcluded, p.id]);
      }
      if (p.page_type_source === 'owner') {
        if (f.pageType && f.pageType !== p.page_type) stats.ownerKept++;
      } else if (f.pageType) {
        if (p.page_type !== f.pageType || p.page_type_source !== 'config') {
          this.db.run("UPDATE pages SET page_type = ?, page_type_source = 'config' WHERE id = ?", [f.pageType, p.id]);
          stats.applied++;
        }
      } else if (p.page_type_source === 'config') {
        this.db.run('UPDATE pages SET page_type = NULL, page_type_source = NULL WHERE id = ?', [p.id]);
        stats.cleared++;
      }
    }
  }

  /** Pages whose (final) page type is commercial (router.commercialPageTypes); counted after pages were created. */
  private countCommercialPages(): void {
    const rows = this.db.all<{ page_type: string; n: number }>('SELECT page_type, COUNT(*) AS n FROM pages WHERE site_id = ? AND page_type IS NOT NULL GROUP BY page_type', [this.siteId]);
    this.report.pageTypes!.commercialPages = rows.filter((r) => this.commercialTypes.has(r.page_type)).reduce((a, r) => a + r.n, 0);
  }

  /** Resolve page_id on GSC page, GSC page/query, and GA4 landing rows (all revisions). */
  resolveMetricRows(): void {
    for (const [table, key] of [
      ['gsc_page_daily', 'gscPage'],
      ['gsc_page_query_daily', 'gscPageQuery'],
    ] as const) {
      const raws = this.db.all<{ page: string; n: number }>(`SELECT page, COUNT(*) AS n FROM ${table} WHERE site_id = ? GROUP BY page`, [this.siteId]);
      const stats = this.report.metricRows[key];
      stats.distinctRaw = raws.length;
      for (const { page: raw, n } of raws) {
        const res = this.observe(raw, 'gsc', 'gsc_url');
        const pageId = res.status === 'resolved' ? res.pageId : null;
        if (res.status === 'resolved') stats.resolved++;
        else {
          stats.unresolved++;
          this.report.unresolved.push({ dataset: table, raw, reason: res.reason, detail: res.detail, rows: n });
        }
        stats.rowsUpdated += this.db.run(`UPDATE ${table} SET page_id = ? WHERE site_id = ? AND page = ? AND page_id IS NOT ?`, [pageId, this.siteId, raw, pageId]).changes;
      }
    }
    const ga4 = this.db.all<{ landing_page: string; host_name: string; n: number }>(
      'SELECT landing_page, host_name, COUNT(*) AS n FROM ga4_landing_daily WHERE site_id = ? GROUP BY landing_page, host_name',
      [this.siteId],
    );
    const stats = this.report.metricRows.ga4Landing;
    stats.distinctRaw = ga4.length;
    for (const g of ga4) {
      const res = this.observeGa4(g.landing_page, g.host_name);
      const pageId = res.status === 'resolved' ? res.pageId : null;
      if (res.status === 'resolved') stats.resolved++;
      else {
        stats.unresolved++;
        this.report.unresolved.push({ dataset: 'ga4_landing_daily', raw: g.host_name ? `${g.host_name} ${g.landing_page}` : g.landing_page, reason: res.reason, detail: res.detail, rows: g.n });
      }
      stats.rowsUpdated += this.db.run('UPDATE ga4_landing_daily SET page_id = ? WHERE site_id = ? AND landing_page = ? AND host_name = ? AND page_id IS NOT ?', [
        pageId,
        this.siteId,
        g.landing_page,
        g.host_name,
        pageId,
      ]).changes;
    }
  }

  /** Fill missing page ids on own-site crawl rows and internal links (never overrides crawler-set ids). */
  fillCrawlPageIds(): void {
    const results = this.db.all<{ id: string; requested_url: string; final_url: string | null }>(
      `SELECT cr.id, cr.requested_url, cr.final_url FROM crawl_results cr JOIN crawls c ON c.id = cr.crawl_id
        WHERE cr.site_id = ? AND c.kind IN ('own_site', 'single_page') AND cr.page_id IS NULL`,
      [this.siteId],
    );
    for (const r of results) {
      const res = this.resolve(r.final_url ?? r.requested_url);
      if (res.status === 'resolved') this.report.crawlRowsFilled.crawlResults += this.db.run('UPDATE crawl_results SET page_id = ? WHERE id = ?', [res.pageId, r.id]).changes;
    }
    const targets = this.db.all<{ target_url: string }>('SELECT DISTINCT target_url FROM internal_links WHERE site_id = ? AND target_page_id IS NULL', [this.siteId]);
    for (const t of targets) {
      const res = this.resolve(t.target_url);
      if (res.status === 'resolved') {
        this.report.crawlRowsFilled.internalLinkTargets += this.db.run('UPDATE internal_links SET target_page_id = ? WHERE site_id = ? AND target_url = ? AND target_page_id IS NULL', [res.pageId, this.siteId, t.target_url]).changes;
      }
    }
    this.report.crawlRowsFilled.internalLinkSources += this.db.run(
      `UPDATE internal_links SET source_page_id = (SELECT cr.page_id FROM crawl_results cr WHERE cr.id = internal_links.source_result_id)
        WHERE site_id = ? AND source_page_id IS NULL AND EXISTS (SELECT 1 FROM crawl_results cr WHERE cr.id = internal_links.source_result_id AND cr.page_id IS NOT NULL)`,
      [this.siteId],
    ).changes;
  }

  /** Report page identities that look alike but have no merge evidence (kept distinct on purpose). */
  findDistinctVariants(limit = 50): void {
    const pages = this.db.all<{ id: string; url: string; host: string }>('SELECT id, url, host FROM pages WHERE site_id = ? ORDER BY url', [this.siteId]);
    const groups = new Map<string, Array<{ id: string; url: string }>>();
    for (const p of pages) {
      const u = tryParseUrl(p.url);
      if (!u) continue;
      const path = u.pathname.length > 1 ? u.pathname.replace(/\/$/, '') : u.pathname;
      const q = u.search.slice(1).split('&').filter(Boolean).sort().join('&');
      const key = `${u.hostname.replace(/^www\./, '')}|${path.toLowerCase()}|${q}`;
      const g = groups.get(key) ?? [];
      g.push({ id: p.id, url: p.url });
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      if (g.length < 2 || this.report.distinctVariants.length >= limit) continue;
      const finals = new Set(g.map((p) => {
        const r = this.resolve(p.url);
        return r.status === 'resolved' ? r.pageId : p.id;
      }));
      if (finals.size < 2) continue;
      const diffs = new Set<UrlDifference>();
      for (let i = 1; i < g.length; i++) for (const d of describeUrlDifference(g[0]!.url, g[i]!.url)) diffs.add(d);
      this.report.distinctVariants.push({
        urls: g.map((p) => p.url),
        differences: [...diffs],
        note: 'Kept as distinct pages: no redirect, agreeing canonical, or configured alias establishes equivalence.',
      });
    }
  }

  /**
   * Full reconciliation pass in one transaction. Idempotent.
   * `dryRun: true` computes the same report inside a transaction that is
   * rolled back: nothing is written.
   */
  run(opts: { dryRun?: boolean } = {}): ReconcileReport {
    this.report = this.emptyReport();
    this.legacyByHost.clear();
    const pass = () => {
      this.renormalizeStoredIdentities();
      this.identitiesSettled = true;
      this.applyConfiguredAliases();
      this.applyRedirectEvidence();
      this.applyCanonicalEvidence();
      this.refreshPageFlags();
      this.resolveMetricRows();
      this.fillCrawlPageIds();
      this.findDistinctVariants();
      this.countCommercialPages();
    };
    try {
      if (!opts.dryRun) {
        this.db.transaction(pass);
        return this.report;
      }
      try {
        this.db.transaction(() => {
          pass();
          throw DRY_RUN_ROLLBACK;
        });
      } catch (err) {
        if (err !== DRY_RUN_ROLLBACK) throw err;
      }
      return this.report;
    } finally {
      // Outside a run (and after a rolled-back dry run) stored identities may again need the fallback lookup.
      this.identitiesSettled = false;
      this.legacyByHost.clear();
    }
  }
}

const DRY_RUN_ROLLBACK = Symbol('reconcile-dry-run-rollback');

/** Convenience wrapper used by the CLI and workflows (`dryRun` rolls every write back). */
export function reconcileSite(input: { db: Db; siteId: string; config: ReconcilerConfig; clock?: Clock; dryRun?: boolean }): ReconcileReport {
  return new UrlReconciler(input.db, input.siteId, input.config, input.clock ?? systemClock).run({ dryRun: input.dryRun ?? false });
}
