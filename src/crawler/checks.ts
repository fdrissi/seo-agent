import type { AppContext } from '../app/context.js';
import { newId } from '../core/ids.js';
import { parseJson } from '../database/db.js';
import { normalizeUrl } from '../seo/url.js';
import type { ExtractedImage, HreflangEntry, RobotsDirectives, StructuredDataBlock } from './extract.js';
import { hammingDistance } from './similarity.js';
import { matchesAnyPath } from './traps.js';

/**
 * Technical checks over one crawl -> technical_issues.
 *
 * Interpretation rules (spec section 16):
 * - HTTP 200 does not prove indexing; nothing here claims a page is indexed.
 * - Low word count does not prove low quality; it is never reported as such.
 * - A duplicate title alone never justifies deleting a page.
 * - Title/description length thresholds are EDITORIAL HEURISTICS
 *   (is_heuristic = 1), not Google ranking rules.
 * - Duplication findings are SUSPECTED (confirmed = 0).
 * - confirmed = 1 only for directly verified access/indexability failures
 *   (404/410 including at the end of a redirect chain, redirect loops,
 *   401/403/407/451 barriers, noindex/robots blocks observed on the page).
 *   Heuristic detections (login redirects by URL pattern, sign-in forms) and
 *   chains that merely exceeded this crawler's own redirect cap are NOT
 *   confirmed. "Verified" means the blocker was observed, not that it is a
 *   mistake.
 * - Resolution is conservative: an open issue is resolved only when its URL
 *   was actually observed again (never after a timeout, network error, rate
 *   limit, 5xx, skip, or barrier), and cross-page issues only after a
 *   complete crawl from site.url with sitemaps.
 * - Missing/empty alt text is reported with context: decorative images
 *   should have alt="".
 */

/**
 * Version of the checks that derive technical_issues rows (recorded in
 * technical_issues.transformation_version, migration 0201). Bump it when an
 * issue type, severity, confirmation rule, or detail shape changes meaning, so
 * every finding stays tied to the logic that produced it. Rows written before
 * the column existed keep NULL ("unknown"), never a guessed version.
 */
export const CHECKS_VERSION = 'technical-checks@1';

export const TITLE_MIN_CHARS = 10;
export const TITLE_MAX_CHARS = 60;
export const DESCRIPTION_MIN_CHARS = 50;
export const DESCRIPTION_MAX_CHARS = 160;
export const NEAR_DUPLICATE_MAX_DISTANCE = 3;
export const DUPLICATE_MIN_WORDS = 20;

const HEURISTIC_LABEL = 'EDITORIAL HEURISTIC: not a Google ranking rule.';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface IssueInput {
  url: string;
  pageId: string | null;
  type: string;
  severity: Severity;
  heuristic: boolean;
  confirmed: boolean;
  detail: Record<string, unknown>;
}

export interface TechnicalCheckSummary {
  crawlId: string;
  kind: string;
  evaluatedUrls: number;
  opened: number;
  updated: number;
  resolved: number;
  byType: Record<string, number>;
  confirmedCount: number;
  notes: string[];
}

/** Issue types that depend only on the page itself (resolvable after a single-page crawl). */
const PER_PAGE_TYPES = new Set([
  'redirect_chain',
  'redirect_loop',
  'redirect_chain_too_long',
  'canonical_multiple',
  'canonical_header_conflict',
  'canonical_noindex_conflict',
  'canonical_cross_domain',
  'snippet_restricted',
  'missing_title',
  'multiple_titles',
  'title_length',
  'missing_meta_description',
  'meta_description_length',
  'missing_h1',
  'image_missing_alt',
  'linked_image_without_text',
  'hreflang_invalid_code',
  'hreflang_missing_self',
  'server_error',
  'content_requires_javascript_suspected',
  'content_requires_javascript',
  'structured_data_invalid_json',
  'meta_refresh',
  'access_blocked',
]);

/** Issue types that need the whole crawl's link graph / other pages. */
const CROSS_PAGE_TYPES = new Set([
  'broken_internal_link',
  'internal_link_unreachable',
  'internal_link_to_redirect',
  'canonical_target_not_ok',
  'accidental_noindex',
  'robots_blocked_in_sitemap',
  'robots_blocked_protected',
  'sitemap_url_not_ok',
  'duplicate_title',
  'duplicate_meta_description',
  'suspected_duplicate_content',
  'suspected_near_duplicate',
  'hreflang_missing_return',
  'hreflang_target_not_ok',
]);

interface ResultRow {
  id: string;
  page_id: string | null;
  requested_url: string;
  final_url: string | null;
  status_code: number | null;
  redirect_chain_json: string | null;
  blocked_reason: string | null;
  error: string | null;
  canonical_url: string | null;
  hreflang_json: string | null;
  title: string | null;
  meta_description: string | null;
  headings_json: string | null;
  word_count: number | null;
  content_hash: string | null;
  images_json: string | null;
  structured_data_json: string | null;
  in_sitemap: number | null;
  text_simhash: string | null;
  extraction_json: string | null;
  robots_allowed: number | null;
  render_discrepancies_json: string | null;
}

interface Extra {
  titleCount?: number;
  metaDescriptionCount?: number;
  canonicals?: string[];
  headerCanonicals?: string[];
  robots?: RobotsDirectives;
  h1Count?: number;
  metaRefresh?: { delaySeconds: number; url: string | null } | null;
  jsShellSuspected?: boolean;
  fetchErrorCode?: string | null;
  loginForm?: boolean;
  /** Status of the final response when a redirect chain was followed to the end (null when it stopped early). */
  finalStatus?: number | null;
  barrierDetection?: string;
  barrierSignals?: string[];
}

function norm(url: string | null | undefined): string | null {
  if (!url) return null;
  return normalizeUrl(url)?.url ?? null;
}

function isContent(r: ResultRow): boolean {
  return r.status_code !== null && r.status_code >= 200 && r.status_code < 300 && !r.blocked_reason && r.headings_json !== null;
}

/** HTTP statuses that directly verify an access barrier (as opposed to heuristic login detection). */
const VERIFIED_BARRIER_STATUSES = new Set([401, 403, 407, 451]);
/** Not-fetched or transient outcomes: nothing about the page was (re)observed. */
const UNOBSERVED_REASONS = new Set(['timeout', 'network_error', 'rate_limited', 'excluded', 'crawl_trap', 'budget', 'unsafe_url', 'too_large', 'unsupported_content']);
/** Issue types computed from robots.txt verdicts (resolvable on robots-blocked rows). */
const ROBOTS_TYPES = new Set(['robots_blocked_in_sitemap', 'robots_blocked_protected']);

/**
 * What a row lets us conclude about issues previously open on its URL:
 * - 'all': the page was observed (2xx content, a redirect, 404/410 or another definitive 4xx);
 * - 'robots_only': robots.txt blocked it (only robots-derived issues were re-evaluated);
 * - 'none': not fetched, transient (timeout, network error, 429, 5xx), or an access
 *   barrier / heuristic block - open issues on it stay open.
 */
export function resolvability(r: { status_code: number | null; blocked_reason: string | null; headings_json: string | null }): 'all' | 'robots_only' | 'none' {
  if (r.blocked_reason === 'robots') return 'robots_only';
  if (r.blocked_reason && UNOBSERVED_REASONS.has(r.blocked_reason)) return 'none';
  const s = r.status_code;
  if (s === null) return 'none';
  if (s >= 200 && s < 300) return !r.blocked_reason && r.headings_json !== null ? 'all' : 'none';
  if (s >= 300 && s < 400) return 'all';
  if (s >= 500 || s === 429 || VERIFIED_BARRIER_STATUSES.has(s)) return 'none';
  if (s >= 400) return 'all';
  return 'none';
}

const isErrorStatus = (s: number | null | undefined): s is number => typeof s === 'number' && s >= 400 && !VERIFIED_BARRIER_STATUSES.has(s) && s !== 429;
const isGone = (s: number | null | undefined): boolean => s === 404 || s === 410;

const LANG_RE = /^([a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?|x-default)$/i;

export function runTechnicalChecks(ctx: AppContext, crawlId: string): TechnicalCheckSummary {
  const crawl = ctx.db.get<{ kind: string; status: string; config_json: string | null }>('SELECT kind, status, config_json FROM crawls WHERE id = ? AND site_id = ?', [crawlId, ctx.siteId]);
  const summary: TechnicalCheckSummary = { crawlId, kind: crawl?.kind ?? 'unknown', evaluatedUrls: 0, opened: 0, updated: 0, resolved: 0, byType: {}, confirmedCount: 0, notes: [] };
  if (!crawl) {
    summary.notes.push('Crawl not found for this site.');
    return summary;
  }
  if (crawl.kind === 'competitor') {
    summary.notes.push('Technical checks apply to own-site crawls only; competitor pages are research data.');
    return summary;
  }
  const rows = ctx.db.all<ResultRow>(
    `SELECT id, page_id, requested_url, final_url, status_code, redirect_chain_json, blocked_reason, error, canonical_url, hreflang_json, title,
            meta_description, headings_json, word_count, content_hash, images_json, structured_data_json, in_sitemap, text_simhash, extraction_json,
            robots_allowed, render_discrepancies_json
       FROM crawl_results WHERE crawl_id = ? AND site_id = ?`,
    [crawlId, ctx.siteId],
  );
  const links = ctx.db.all<{ source_result_id: string; target_url: string; anchor_text: string }>(
    'SELECT source_result_id, target_url, anchor_text FROM internal_links WHERE crawl_id = ? AND site_id = ?',
    [crawlId, ctx.siteId],
  );
  const protectedPaths = ctx.config.crawl.protectedPaths;
  const pageProtected = new Map<string, boolean>();
  for (const p of ctx.db.all<{ id: string; is_protected: number }>(
    'SELECT p.id, p.is_protected FROM pages p WHERE p.site_id = ? AND p.id IN (SELECT page_id FROM crawl_results WHERE crawl_id = ? AND page_id IS NOT NULL)',
    [ctx.siteId, crawlId],
  )) pageProtected.set(p.id, p.is_protected === 1);

  const byUrl = new Map<string, ResultRow>();
  const sourceUrlOf = new Map<string, string>();
  for (const r of rows) {
    const key = norm(r.requested_url) ?? r.requested_url;
    byUrl.set(key, r);
    sourceUrlOf.set(r.id, key);
  }
  const inbound = new Map<string, Array<{ source: string; anchor: string }>>();
  for (const l of links) {
    const list = inbound.get(l.target_url) ?? [];
    const source = sourceUrlOf.get(l.source_result_id) ?? '(unknown)';
    if (source !== l.target_url) list.push({ source, anchor: l.anchor_text });
    inbound.set(l.target_url, list);
  }
  const extra = (r: ResultRow): Extra => parseJson<Extra>(r.extraction_json, {});
  const isProtected = (r: ResultRow): boolean => {
    if (r.page_id && pageProtected.get(r.page_id)) return true;
    try {
      return matchesAnyPath(new URL(r.requested_url).pathname, protectedPaths) !== null;
    } catch {
      return false;
    }
  };

  const issues: IssueInput[] = [];
  const add = (r: ResultRow | null, url: string, type: string, severity: Severity, detail: Record<string, unknown>, o: { heuristic?: boolean; confirmed?: boolean } = {}) => {
    issues.push({ url, pageId: r?.page_id ?? null, type, severity, heuristic: !!o.heuristic, confirmed: !!o.confirmed, detail });
  };
  const linkedFrom = (url: string) => {
    const l = inbound.get(url) ?? [];
    return { linkCount: l.length, linkedFrom: l.slice(0, 20) };
  };

  // ---- Per-row checks -----------------------------------------------------
  for (const r of rows) {
    const url = norm(r.requested_url) ?? r.requested_url;
    const x = extra(r);
    const chain = parseJson<Array<{ url: string; status: number; location: string }>>(r.redirect_chain_json, []);
    const inSitemap = r.in_sitemap === 1;
    const linked = (inbound.get(url)?.length ?? 0) > 0;
    const prot = isProtected(r);

    // Redirects.
    const finalStatus = chain.length ? (x.finalStatus ?? null) : null;
    if (x.fetchErrorCode === 'redirect_loop') add(r, url, 'redirect_loop', 'high', { chain, error: r.error, ...linkedFrom(url) }, { confirmed: true });
    else if (x.fetchErrorCode === 'too_many_redirects') {
      // Only this crawler's own cap was exceeded; search engines may follow longer chains. Not a verified failure.
      add(r, url, 'redirect_chain_too_long', 'medium', {
        chain,
        error: r.error,
        maxRedirects: ctx.config.crawl.maxRedirects,
        note: `The chain exceeded this crawler's limit (crawl.maxRedirects = ${ctx.config.crawl.maxRedirects}); the final destination was not checked. Long chains waste crawl budget, but this is not proof the URL is inaccessible to search engines.`,
      });
    } else if (chain.length >= 2) add(r, url, 'redirect_chain', chain.length >= 3 ? 'medium' : 'low', { hops: chain.length, chain, finalUrl: r.final_url, finalStatus, note: 'Link directly to the final URL where possible.' });
    if (chain.length >= 1 && linked && !isErrorStatus(finalStatus)) add(r, url, 'internal_link_to_redirect', 'info', { finalUrl: r.final_url, finalStatus, ...linkedFrom(url), note: 'Internal links point at a redirecting URL.' });

    // Robots.txt blocks and access barriers.
    if (r.blocked_reason === 'robots') {
      if (prot) add(r, url, 'robots_blocked_protected', 'critical', { note: 'A protected page is disallowed by robots.txt (observed).', inSitemap }, { confirmed: true });
      else if (inSitemap) add(r, url, 'robots_blocked_in_sitemap', 'high', { note: 'The sitemap lists a URL that robots.txt disallows (observed).', error: r.error }, { confirmed: true });
    }
    if (r.blocked_reason === 'login_required' || r.blocked_reason === 'access_denied') {
      // confirmed only when the HTTP status itself verifies the barrier (401/403/407/451);
      // login redirects (URL pattern) and sign-in forms (page heuristics) are suspicions.
      const verified = r.status_code !== null && VERIFIED_BARRIER_STATUSES.has(r.status_code);
      const detection = verified ? 'http_status' : r.status_code !== null && r.status_code >= 300 && r.status_code < 400 ? 'login_redirect' : (x.barrierDetection ?? 'login_form_heuristic');
      const severity: Severity = prot || inSitemap ? (verified ? 'high' : 'medium') : 'info';
      add(r, url, 'access_blocked', severity, {
        blockedReason: r.blocked_reason,
        status: r.status_code,
        detection,
        ...(x.barrierSignals ? { signals: x.barrierSignals } : {}),
        inSitemap,
        protected: prot,
        ...linkedFrom(url),
        note: verified
          ? 'Crawlers without credentials cannot access this URL (verified by the HTTP status). This may be intentional for member areas.'
          : 'Suspected barrier (detected by URL pattern or page heuristics, not by an HTTP status); verify in a browser. This may be intentional for member areas.',
      }, { confirmed: verified });
    }

    // Status codes.
    if (r.status_code !== null && r.status_code >= 500) add(r, url, 'server_error', 'medium', { status: r.status_code, note: 'May be transient; re-check before acting.' });
    if (inSitemap && r.status_code !== null && (r.status_code >= 300 || r.status_code < 200)) {
      const gone = isGone(r.status_code) || isGone(finalStatus);
      add(r, url, 'sitemap_url_not_ok', gone ? 'medium' : 'low', { status: r.status_code, finalUrl: r.final_url, finalStatus, note: gone && !isGone(r.status_code) ? 'Listed in the sitemap, redirects to a URL that returned 404/410.' : 'Sitemaps should list final, indexable 200 URLs.' }, { confirmed: gone });
    }

    if (!isContent(r)) continue;

    // Metadata.
    const title = (r.title ?? '').trim();
    if (!title) add(r, url, 'missing_title', 'medium', { note: 'No <title> (or an empty one) in the raw HTML.' });
    else if (title.length < TITLE_MIN_CHARS || title.length > TITLE_MAX_CHARS) {
      add(r, url, 'title_length', 'info', { length: title.length, title, thresholds: { min: TITLE_MIN_CHARS, max: TITLE_MAX_CHARS }, label: HEURISTIC_LABEL, note: 'Long titles may be truncated in some result displays; this is not a ranking rule.' }, { heuristic: true });
    }
    if ((x.titleCount ?? 0) > 1) add(r, url, 'multiple_titles', 'low', { count: x.titleCount });
    const desc = (r.meta_description ?? '').trim();
    if (!desc) add(r, url, 'missing_meta_description', 'low', { note: 'Search engines may generate snippets from page content; a missing description is not an error by itself.' });
    else if (desc.length < DESCRIPTION_MIN_CHARS || desc.length > DESCRIPTION_MAX_CHARS) {
      add(r, url, 'meta_description_length', 'info', { length: desc.length, thresholds: { min: DESCRIPTION_MIN_CHARS, max: DESCRIPTION_MAX_CHARS }, label: HEURISTIC_LABEL }, { heuristic: true });
    }
    if ((x.h1Count ?? 0) === 0) add(r, url, 'missing_h1', 'info', { label: HEURISTIC_LABEL, note: 'A descriptive main heading helps readers; its absence is not a ranking rule.' }, { heuristic: true });

    // Robots directives.
    const robots = x.robots;
    if (robots?.noindex && (inSitemap || linked || prot)) {
      const reasons = [prot ? 'protected page' : null, inSitemap ? 'listed in the sitemap' : null, linked ? 'linked internally' : null].filter(Boolean);
      add(r, url, 'accidental_noindex', prot ? 'critical' : inSitemap ? 'high' : 'medium', {
        directiveSources: robots.sources,
        reasons,
        ...linkedFrom(url),
        note: 'A noindex directive was observed (verified). Whether it is intentional needs owner confirmation; never change it without approval.',
      }, { confirmed: true });
    }
    if (robots && (robots.nosnippet || robots.maxSnippet === 0)) {
      add(r, url, 'snippet_restricted', 'info', { nosnippet: robots.nosnippet, maxSnippet: robots.maxSnippet, note: 'nosnippet / max-snippet:0 also prevent use as direct input to AI Overviews and AI Mode (Google documentation).' });
    }

    // Canonicals.
    const canonicals = [...new Set((x.canonicals ?? []).map((c) => norm(c) ?? c))];
    const headerCanonicals = [...new Set((x.headerCanonicals ?? []).map((c) => norm(c) ?? c))];
    if (canonicals.length > 1) add(r, url, 'canonical_multiple', 'medium', { canonicals, note: 'Multiple different rel=canonical tags; search engines may ignore all of them.' });
    if (canonicals.length && headerCanonicals.length && !headerCanonicals.includes(canonicals[0]!)) {
      add(r, url, 'canonical_header_conflict', 'medium', { html: canonicals, header: headerCanonicals });
    }
    const canonical = norm(r.canonical_url);
    if (canonical && robots?.noindex && canonical !== url) add(r, url, 'canonical_noindex_conflict', 'low', { canonical, note: 'noindex combined with a canonical to another URL sends mixed signals.' });
    if (canonical) {
      let host = '';
      try {
        host = new URL(canonical).hostname.toLowerCase();
      } catch {
        /* ignore */
      }
      if (host && !ctx.config.site.allowedHostnames.map((h) => h.toLowerCase()).includes(host)) {
        add(r, url, 'canonical_cross_domain', 'info', { canonical, note: 'Canonical points to another host; confirm this is intentional (e.g. syndication).' });
      }
      const target = byUrl.get(canonical);
      if (target && canonical !== url) {
        const tChain = parseJson<unknown[]>(target.redirect_chain_json, []);
        if (target.status_code !== null && (target.status_code !== 200 || tChain.length)) {
          const targetFinal = tChain.length ? (extra(target).finalStatus ?? null) : null;
          const gone = isGone(target.status_code) || isGone(targetFinal);
          add(r, url, 'canonical_target_not_ok', gone ? 'high' : 'medium', { canonical, targetStatus: target.status_code, targetRedirects: tChain.length, targetFinalUrl: tChain.length ? target.final_url : null, targetFinalStatus: targetFinal, note: 'The canonical target should be a final, indexable 200 URL.' }, { confirmed: gone });
        } else if (target.blocked_reason) {
          add(r, url, 'canonical_target_not_ok', 'medium', { canonical, targetBlockedReason: target.blocked_reason });
        }
      }
    }

    // Images.
    const images = parseJson<ExtractedImage[]>(r.images_json, []);
    const missingAlt = images.filter((i) => i.altStatus === 'missing');
    if (missingAlt.length) {
      const allDecorative = missingAlt.every((i) => i.decorativeHints.length > 0);
      add(r, url, 'image_missing_alt', allDecorative ? 'info' : 'low', {
        count: missingAlt.length,
        images: missingAlt.slice(0, 20).map((i) => ({ src: i.src, decorativeHints: i.decorativeHints, context: i.context })),
        note: 'Some images are decorative: those should use alt="" rather than descriptive text. Review each image in context.',
      });
    }
    const unnamedLinks = images.filter((i) => i.inLink && !i.linkHasText && i.altStatus !== 'present');
    if (unnamedLinks.length) {
      add(r, url, 'linked_image_without_text', 'low', { count: unnamedLinks.length, images: unnamedLinks.slice(0, 20).map((i) => ({ src: i.src, altStatus: i.altStatus })), note: 'An image-only link with missing/empty alt has no accessible name.' });
    }

    // Hreflang (own entries).
    const hreflang = parseJson<HreflangEntry[]>(r.hreflang_json, []);
    if (hreflang.length) {
      const invalid = hreflang.filter((h) => !LANG_RE.test(h.lang.trim()));
      if (invalid.length) add(r, url, 'hreflang_invalid_code', 'low', { invalid: invalid.map((h) => h.lang) });
      const self = hreflang.some((h) => norm(h.href) === url || norm(h.href) === norm(r.final_url));
      if (!self) add(r, url, 'hreflang_missing_self', 'low', { entries: hreflang.slice(0, 50), note: 'hreflang annotations should include the page itself.' });
    }

    // Structured data, meta refresh, JS dependence.
    const sd = parseJson<{ jsonLd?: StructuredDataBlock[] }>(r.structured_data_json, {});
    const invalidLd = (sd.jsonLd ?? []).filter((b) => !b.valid);
    if (invalidLd.length) add(r, url, 'structured_data_invalid_json', 'low', { blocks: invalidLd.map((b) => ({ index: b.index, error: b.error })) });
    if (x.metaRefresh) add(r, url, 'meta_refresh', 'low', { ...x.metaRefresh, note: 'Meta refresh redirects are less clear than HTTP redirects.' });
    const disc = parseJson<{ contentDependsOnJavascript?: boolean; wordCount?: unknown; disclaimer?: string } | null>(r.render_discrepancies_json, null);
    if (disc?.contentDependsOnJavascript) {
      add(r, url, 'content_requires_javascript', 'low', { wordCount: disc.wordCount, disclaimer: disc.disclaimer, note: 'Main content appears only after JavaScript runs.' });
    } else if (x.jsShellSuspected && !disc) {
      add(r, url, 'content_requires_javascript_suspected', 'info', { wordCount: r.word_count, label: HEURISTIC_LABEL, note: 'Little text in the raw HTML with an app shell; render the page to confirm. Low word count does not prove low quality.' }, { heuristic: true });
    }
  }

  // ---- Link-graph checks ---------------------------------------------------
  for (const [target, sources] of inbound) {
    if (!sources.length) continue;
    const r = byUrl.get(target);
    if (!r) continue; // not crawled: no verdict
    const tChain = parseJson<unknown[]>(r.redirect_chain_json, []);
    const tFinal = tChain.length ? (extra(r).finalStatus ?? null) : null;
    if (isErrorStatus(r.status_code)) {
      const gone = isGone(r.status_code);
      add(r, target, 'broken_internal_link', gone ? 'high' : 'medium', { status: r.status_code, ...linkedFrom(target), note: gone ? 'Observed 404/410 on an internally linked URL.' : 'Error status observed; may be transient.' }, { confirmed: gone });
    } else if (tChain.length && isErrorStatus(tFinal)) {
      const gone = isGone(tFinal);
      add(r, target, 'broken_internal_link', gone ? 'high' : 'medium', {
        status: r.status_code,
        viaRedirect: true,
        finalUrl: r.final_url,
        finalStatus: tFinal,
        hops: tChain.length,
        ...linkedFrom(target),
        note: gone ? 'The linked URL redirects to a URL that returned 404/410 (observed).' : 'The linked URL redirects to an error response; may be transient.',
      }, { confirmed: gone });
    } else if (r.status_code === null && (r.blocked_reason === 'timeout' || r.blocked_reason === 'network_error')) {
      add(r, target, 'internal_link_unreachable', 'low', { blockedReason: r.blocked_reason, error: r.error, ...linkedFrom(target), note: 'Could not be fetched during this crawl; re-check before acting.' });
    }
  }

  // ---- Hreflang reciprocity -------------------------------------------------
  for (const r of rows) {
    if (!isContent(r)) continue;
    const url = norm(r.requested_url) ?? r.requested_url;
    const entries = parseJson<HreflangEntry[]>(r.hreflang_json, []);
    for (const e of entries) {
      const t = norm(e.href);
      if (!t || t === url) continue;
      const target = byUrl.get(t);
      if (!target) continue; // not crawled: no verdict
      if (!isContent(target)) {
        add(r, url, 'hreflang_target_not_ok', 'medium', { target: t, lang: e.lang, targetStatus: target.status_code, targetFinalStatus: extra(target).finalStatus ?? null, targetBlockedReason: target.blocked_reason });
        continue;
      }
      const back = parseJson<HreflangEntry[]>(target.hreflang_json, []).some((b) => norm(b.href) === url);
      if (!back) add(r, url, 'hreflang_missing_return', 'medium', { target: t, lang: e.lang, note: 'The alternate page does not link back (hreflang annotations must be reciprocal).' });
    }
  }

  // ---- Duplication (suspected) ----------------------------------------------
  const content = rows.filter(isContent);
  const canonicalOf = (r: ResultRow) => norm(r.canonical_url) ?? norm(r.requested_url);
  const expectedDup = (a: ResultRow, b: ResultRow) => canonicalOf(a) === canonicalOf(b) || canonicalOf(a) === norm(b.requested_url) || canonicalOf(b) === norm(a.requested_url);
  const indexable = (r: ResultRow) => !extra(r).robots?.noindex;
  const group = <K>(items: ResultRow[], key: (r: ResultRow) => K | null) => {
    const m = new Map<K, ResultRow[]>();
    for (const r of items) {
      const k = key(r);
      if (k === null) continue;
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return m;
  };
  const reportGroup = (members: ResultRow[], type: string, severity: Severity, detail: (r: ResultRow, others: string[]) => Record<string, unknown>, o: { heuristic?: boolean } = {}) => {
    for (const r of members) {
      const others = members.filter((m) => m !== r && !expectedDup(r, m)).map((m) => norm(m.requested_url) ?? m.requested_url);
      if (!others.length) continue;
      add(r, norm(r.requested_url) ?? r.requested_url, type, severity, detail(r, others), o);
    }
  };
  for (const [, members] of group(content.filter(indexable), (r) => ((r.title ?? '').trim() ? (r.title ?? '').trim().toLowerCase() : null))) {
    if (members.length > 1)
      reportGroup(members, 'duplicate_title', 'low', (r, others) => ({ title: r.title, others: others.slice(0, 20), label: HEURISTIC_LABEL, note: 'A duplicate title alone never justifies deleting or merging a page.' }), { heuristic: true });
  }
  for (const [, members] of group(content.filter(indexable), (r) => ((r.meta_description ?? '').trim() ? (r.meta_description ?? '').trim().toLowerCase() : null))) {
    if (members.length > 1) reportGroup(members, 'duplicate_meta_description', 'info', (_r, others) => ({ others: others.slice(0, 20), label: HEURISTIC_LABEL }), { heuristic: true });
  }
  const exactDup = new Set<string>();
  for (const [, members] of group(content.filter((r) => (r.word_count ?? 0) >= DUPLICATE_MIN_WORDS), (r) => r.content_hash)) {
    if (members.length < 2) continue;
    for (const m of members) exactDup.add(m.id);
    reportGroup(members, 'suspected_duplicate_content', 'medium', (_r, others) => ({
      method: 'identical hash of extracted visible text',
      others: others.slice(0, 20),
      label: 'SUSPECTED duplication',
      note: 'Suspected only. Investigate canonicals and intent; duplication alone never justifies deleting a page.',
    }));
  }
  const withHash = content.filter((r) => r.text_simhash && !exactDup.has(r.id));
  for (let i = 0; i < withHash.length; i++) {
    for (let j = i + 1; j < withHash.length; j++) {
      const a = withHash[i]!;
      const b = withHash[j]!;
      if (expectedDup(a, b)) continue;
      const d = hammingDistance(a.text_simhash!, b.text_simhash!);
      if (d > NEAR_DUPLICATE_MAX_DISTANCE) continue;
      for (const [r, other] of [
        [a, b],
        [b, a],
      ] as const) {
        add(r, norm(r.requested_url) ?? r.requested_url, 'suspected_near_duplicate', 'low', {
          method: 'SimHash (64-bit, word 3-shingles)',
          distance: d,
          maxDistance: NEAR_DUPLICATE_MAX_DISTANCE,
          other: norm(other.requested_url) ?? other.requested_url,
          label: 'SUSPECTED near-duplication',
          note: 'Similarity is a heuristic signal, not proof; never a reason on its own to remove a page.',
        });
      }
    }
  }

  // ---- Persist ----------------------------------------------------------------
  // Merge duplicate (url, type) findings (e.g. several near-duplicate partners).
  const merged = new Map<string, IssueInput>();
  for (const i of issues) {
    const k = `${i.url}\u0000${i.type}`;
    const prev = merged.get(k);
    if (!prev) merged.set(k, i);
    else {
      const list = (prev.detail.related as unknown[] | undefined) ?? [];
      prev.detail = { ...prev.detail, related: [...list, i.detail].slice(0, 20) };
    }
  }
  const now = ctx.clock.now().toISOString();
  // Which open issues this crawl may resolve:
  // - per-page issues only on URLs whose outcome was actually observed (never on timeouts,
  //   network errors, rate limits, robots/excluded/trap skips, 5xx, or access barriers);
  // - cross-page issues (link graph, duplicates, hreflang reciprocity, sitemap/robots
  //   membership) only after a COMPLETE own-site crawl from site.url with sitemaps, since a
  //   partial crawl may simply not have reached the counterpart page.
  const evaluated = new Map<string, 'all' | 'robots_only' | 'none'>();
  for (const r of rows) evaluated.set(norm(r.requested_url) ?? r.requested_url, resolvability(r));
  summary.evaluatedUrls = [...evaluated.values()].filter((v) => v !== 'none').length;
  const plan = parseJson<{ startUrl?: string; useSitemaps?: boolean }>(crawl.config_json, {});
  const fullCrawl = crawl.kind === 'own_site' && crawl.status === 'completed' && norm(plan.startUrl ?? null) === norm(ctx.config.site.url) && plan.useSitemaps !== false;
  const canResolve = (url: string, type: string): boolean => {
    const v = evaluated.get(url);
    if (!v || v === 'none') return false;
    const cross = CROSS_PAGE_TYPES.has(type);
    if (!cross && !PER_PAGE_TYPES.has(type)) return false;
    if (cross && !fullCrawl) return false;
    if (v === 'robots_only') return ROBOTS_TYPES.has(type);
    return true;
  };
  ctx.db.transaction(() => {
    for (const i of merged.values()) {
      const exists = ctx.db.get<{ id: string }>('SELECT id FROM technical_issues WHERE site_id = ? AND url = ? AND issue_type = ?', [ctx.siteId, i.url, i.type]);
      ctx.db.run(
        `INSERT INTO technical_issues (id, site_id, crawl_id, page_id, url, issue_type, severity, is_heuristic, confirmed, detail_json, status, first_seen_at, last_seen_at, transformation_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
         ON CONFLICT (site_id, url, issue_type) DO UPDATE SET
           crawl_id = excluded.crawl_id,
           page_id = COALESCE(excluded.page_id, technical_issues.page_id),
           severity = excluded.severity,
           is_heuristic = excluded.is_heuristic,
           confirmed = excluded.confirmed,
           detail_json = excluded.detail_json,
           last_seen_at = excluded.last_seen_at,
           transformation_version = excluded.transformation_version,
           status = CASE WHEN technical_issues.status = 'ignored' THEN 'ignored' ELSE 'open' END`,
        [newId('tissue'), ctx.siteId, crawlId, i.pageId, i.url, i.type, i.severity, i.heuristic ? 1 : 0, i.confirmed ? 1 : 0, JSON.stringify(i.detail), now, now, CHECKS_VERSION],
      );
      if (exists) summary.updated++;
      else summary.opened++;
      summary.byType[i.type] = (summary.byType[i.type] ?? 0) + 1;
      if (i.confirmed) summary.confirmedCount++;
    }
    // Resolve open issues on evaluated URLs that were not observed again.
    const open = ctx.db.all<{ id: string; url: string; issue_type: string }>(`SELECT id, url, issue_type FROM technical_issues WHERE site_id = ? AND status = 'open'`, [ctx.siteId]);
    for (const o of open) {
      if (merged.has(`${o.url}\u0000${o.issue_type}`)) continue;
      if (!canResolve(o.url, o.issue_type)) continue;
      ctx.db.run(`UPDATE technical_issues SET status = 'resolved', crawl_id = ? WHERE id = ? AND site_id = ?`, [crawlId, o.id, ctx.siteId]);
      summary.resolved++;
    }
  });
  if (crawl.kind === 'single_page') summary.notes.push('Single-page crawl: link-graph, duplication, and reciprocity checks need a full crawl.');
  else if (!fullCrawl) {
    summary.notes.push(
      `Cross-page issues (broken links, duplicates, hreflang reciprocity, sitemap/robots membership) were reported but not auto-resolved: this crawl was not a complete crawl from site.url with sitemaps (status ${crawl.status}).`,
    );
  }
  const skipped = [...evaluated.values()].filter((v) => v === 'none').length;
  if (skipped) summary.notes.push(`${skipped} URL(s) were not observed this time (timeouts, rate limits, errors, barriers, or skips); their open issues were left unchanged.`);
  summary.notes.push('HTTP 200 does not prove a page is indexed; use URL Inspection for indexed-state information.');
  return summary;
}
