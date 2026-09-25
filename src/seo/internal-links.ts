import type { Db } from '../database/db.js';
import { activeGscScope, type ConfiguredGscScope } from './coverage.js';
import { loadCrawlText, parseHeadings, type TextStore } from './crawl-data.js';
import { normalizeUrl } from './url.js';

/**
 * Internal-link suggestions and potential orphan detection from the latest
 * own-site crawl.
 *
 * A suggestion is {sourcePage, destination, passage, proposedAnchor, reason}:
 * the source page's own text already mentions a phrase that describes the
 * destination (its top Search Console queries or its title/H1), and the
 * source does not link to the destination in that crawl.
 *
 * Orphans are only "potential" and only relative to known crawl coverage:
 * a page with no inbound internal link among the pages a COMPLETED crawl
 * fetched (frontier exhausted within limits). When the crawl was partial
 * (page/depth caps, transient failures), the pages that could link to a page
 * may never have been fetched, so no page is called a potential orphan:
 * zero-inbound pages (fetched or not) are listed as not assessable instead.
 * Pages whose lifecycle is 'gone' (404/410) or 'redirected' are not assessed.
 * Orphans and link suggestions are shown by `analyze links`, and the weekly
 * pipeline's `site_structure` stage hands them (with page-level AEO checks)
 * to the report builder input (src/seo/site-structure.ts).
 * Internal-link counts are observations from one crawl, never an authority
 * score.
 */

export const INTERNAL_LINKS_VERSION = 'internal-links@1.0.0';

export interface CrawlInfo {
  id: string;
  status: string;
  pagesFetched: number;
  pagesAttempted: number;
  stopReason: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface LinkSuggestion {
  sourcePage: { pageId: string | null; url: string };
  destination: { pageId: string; url: string };
  passage: string;
  proposedAnchor: string;
  reason: string;
  phraseOrigin: 'gsc_query' | 'title' | 'h1' | 'provided';
  crawlId: string;
}

export interface DestinationSpec {
  pageId: string;
  url: string;
  phrases?: Array<{ text: string; origin: LinkSuggestion['phraseOrigin']; weight?: number; detail?: string }>;
}

type CrawlRowInfo = { id: string; status: string; pages_fetched: number; pages_attempted: number; stop_reason: string | null; started_at: string; finished_at: string | null };
const toInfo = (r: CrawlRowInfo | undefined): CrawlInfo | null =>
  r ? { id: r.id, status: r.status, pagesFetched: r.pages_fetched, pagesAttempted: r.pages_attempted, stopReason: r.stop_reason, startedAt: r.started_at, finishedAt: r.finished_at } : null;

export function latestOwnCrawl(db: Db, siteId: string): CrawlInfo | null {
  return toInfo(
    db.get<CrawlRowInfo>(
      "SELECT id, status, pages_fetched, pages_attempted, stop_reason, started_at, finished_at FROM crawls WHERE site_id = ? AND kind = 'own_site' AND status IN ('completed', 'partial') ORDER BY started_at DESC LIMIT 1",
      [siteId],
    ),
  );
}

export function ownCrawlById(db: Db, siteId: string, crawlId: string): CrawlInfo | null {
  return toInfo(db.get<CrawlRowInfo>("SELECT id, status, pages_fetched, pages_attempted, stop_reason, started_at, finished_at FROM crawls WHERE site_id = ? AND id = ? AND kind = 'own_site'", [siteId, crawlId]));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Find a phrase as a whole-word, case-insensitive match; return the sentence and the exact matched text. */
export function findPassage(text: string, phrase: string, maxLen = 300): { passage: string; anchor: string } | null {
  const p = phrase.trim();
  if (p.length < 3) return null;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu');
  const m = re.exec(text);
  if (!m) return null;
  const before = text.slice(0, m.index);
  const after = text.slice(m.index + m[0].length);
  const startIdx = Math.max(before.search(/[.!?\n][^.!?\n]*$/) + 1, 0);
  const endRel = after.search(/[.!?\n]/);
  let passage = `${before.slice(startIdx)}${m[0]}${endRel === -1 ? after : after.slice(0, endRel + 1)}`.replace(/\s+/g, ' ').trim();
  if (passage.length > maxLen) {
    const at = passage.toLocaleLowerCase().indexOf(m[0].toLocaleLowerCase());
    const from = Math.max(0, at - Math.floor((maxLen - m[0].length) / 2));
    passage = `${from > 0 ? '...' : ''}${passage.slice(from, from + maxLen)}...`;
  }
  return { passage, anchor: m[0].replace(/\s+/g, ' ') };
}

/** Default destination phrases: top visible GSC queries (final, current) plus title/H1 from the crawl. */
export function defaultPhrases(db: Db, siteId: string, pageId: string, crawlId: string, maxQueries = 5, gscScope?: ConfiguredGscScope | null): NonNullable<DestinationSpec['phrases']> {
  return defaultPhrasesDetailed(db, siteId, pageId, crawlId, maxQueries, gscScope).phrases;
}

/**
 * defaultPhrases plus the reason when Search Console phrases were not used.
 * Query impressions are summed only within ONE slice: the configured property
 * and search type, unsegmented rows (segment_key = ''), so country/device
 * rows, other properties, and other search types are never added together.
 * `gscScope` undefined = the site's active recorded configuration; null = no
 * property configured (no Search Console phrases, with a reason).
 */
export function defaultPhrasesDetailed(
  db: Db,
  siteId: string,
  pageId: string,
  crawlId: string,
  maxQueries = 5,
  gscScope?: ConfiguredGscScope | null,
): { phrases: NonNullable<DestinationSpec['phrases']>; notes: string[] } {
  const out: NonNullable<DestinationSpec['phrases']> = [];
  const notes: string[] = [];
  const scope = gscScope === undefined ? activeGscScope(db, siteId) : gscScope;
  if (!scope) {
    notes.push('No Search Console property is configured (google.searchConsoleProperty): Search Console query phrases were not used; only the destination title/H1 were matched.');
  } else {
    const qs = db.all<{ query: string; impressions: number }>(
      `SELECT query, SUM(impressions) AS impressions FROM gsc_page_query_daily
        WHERE site_id = ? AND page_id = ? AND property = ? AND search_type = ? AND segment_key = '' AND is_current = 1 AND is_final = 1
        GROUP BY query ORDER BY impressions DESC, query ASC LIMIT ?`,
      [siteId, pageId, scope.property, scope.searchType, maxQueries],
    );
    for (const q of qs) out.push({ text: q.query, origin: 'gsc_query', weight: q.impressions, detail: `top Search Console query for the destination (${q.impressions} impressions, ${scope.property}, ${scope.searchType}, unsegmented)` });
  }
  const cr = db.get<{ title: string | null; headings_json: string | null }>('SELECT title, headings_json FROM crawl_results WHERE site_id = ? AND crawl_id = ? AND page_id = ? LIMIT 1', [siteId, crawlId, pageId]);
  const h1 = parseHeadings(cr?.headings_json ?? null).find((h) => h.level === 1)?.text;
  if (h1 && h1.length <= 80) out.push({ text: h1, origin: 'h1', weight: 0, detail: 'destination H1' });
  if (cr?.title && cr.title.length <= 70 && cr.title !== h1) out.push({ text: cr.title.split(/\s[|\-–]\s/)[0]!.trim(), origin: 'title', weight: 0, detail: 'destination title (brand suffix removed)' });
  return { phrases: out, notes };
}

export interface SuggestResult {
  version: string;
  crawl: CrawlInfo | null;
  suggestions: LinkSuggestion[];
  skipped: Array<{ url: string; reason: string }>;
  note: string;
  /** Why some phrase sources were not used (e.g. no Search Console property configured). */
  notes?: string[];
}

export function suggestInternalLinks(
  db: Db,
  text: TextStore | null,
  siteId: string,
  opts: { destinations: DestinationSpec[]; maxPerDestination?: number; crawlId?: string; gscScope?: ConfiguredGscScope | null },
): SuggestResult {
  const crawl = opts.crawlId ? ownCrawlById(db, siteId, opts.crawlId) : latestOwnCrawl(db, siteId);
  if (!crawl) return { version: INTERNAL_LINKS_VERSION, crawl: null, suggestions: [], skipped: [], note: 'No completed own-site crawl; run a crawl first. No suggestions were fabricated.' };
  const sources = db.all<{ id: string; page_id: string | null; requested_url: string; final_url: string | null; status_code: number | null; text_ref: string | null; meta_robots: string | null; is_excluded: number | null }>(
    `SELECT cr.id, cr.page_id, cr.requested_url, cr.final_url, cr.status_code, cr.text_ref, cr.meta_robots, p.is_excluded
       FROM crawl_results cr LEFT JOIN pages p ON p.id = cr.page_id WHERE cr.site_id = ? AND cr.crawl_id = ? ORDER BY cr.requested_url`,
    [siteId, crawl.id],
  );
  const skipped: SuggestResult['skipped'] = [];
  const texts = new Map<string, string>();
  for (const s of sources) {
    const url = s.final_url ?? s.requested_url;
    if (s.status_code === null || s.status_code < 200 || s.status_code >= 300) skipped.push({ url, reason: `status ${s.status_code ?? 'n/a'}` });
    else if (s.is_excluded === 1) skipped.push({ url, reason: 'excluded path' });
    else if (s.meta_robots && /noindex/i.test(s.meta_robots)) skipped.push({ url, reason: 'noindex page' });
    else {
      const t = loadCrawlText(text, s.text_ref);
      if (t === null) skipped.push({ url, reason: 'extracted text unavailable' });
      else texts.set(s.id, t);
    }
  }
  const linksBySource = new Map<string, Set<string>>();
  for (const l of db.all<{ source_result_id: string; target_url: string; target_page_id: string | null }>('SELECT source_result_id, target_url, target_page_id FROM internal_links WHERE site_id = ? AND crawl_id = ?', [siteId, crawl.id])) {
    const set = linksBySource.get(l.source_result_id) ?? new Set<string>();
    if (l.target_page_id) set.add(`id:${l.target_page_id}`);
    set.add(`url:${normalizeUrl(l.target_url)?.url ?? l.target_url}`);
    linksBySource.set(l.source_result_id, set);
  }
  const max = opts.maxPerDestination ?? 5;
  const suggestions: LinkSuggestion[] = [];
  const notes = new Set<string>();
  const gscScope = opts.gscScope === undefined ? activeGscScope(db, siteId) : opts.gscScope;
  for (const dest of opts.destinations) {
    const destNorm = normalizeUrl(dest.url)?.url ?? dest.url;
    let destPhrases = dest.phrases;
    if (!destPhrases) {
      const d = defaultPhrasesDetailed(db, siteId, dest.pageId, crawl.id, 5, gscScope);
      destPhrases = d.phrases;
      for (const n of d.notes) notes.add(n);
    }
    const phrases = destPhrases.slice().sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    const found: LinkSuggestion[] = [];
    for (const s of sources) {
      if (found.length >= max) break;
      const t = texts.get(s.id);
      if (!t) continue;
      const srcUrl = s.final_url ?? s.requested_url;
      if (s.page_id === dest.pageId || (normalizeUrl(srcUrl)?.url ?? srcUrl) === destNorm) continue;
      const linked = linksBySource.get(s.id);
      if (linked && (linked.has(`id:${dest.pageId}`) || linked.has(`url:${destNorm}`))) continue;
      for (const ph of phrases) {
        const hit = findPassage(t, ph.text);
        if (!hit) continue;
        found.push({
          sourcePage: { pageId: s.page_id, url: srcUrl },
          destination: { pageId: dest.pageId, url: dest.url },
          passage: hit.passage,
          proposedAnchor: hit.anchor,
          reason: `The source text already mentions "${hit.anchor}" (${ph.detail ?? ph.origin}) and does not link to the destination in crawl ${crawl.id}.`,
          phraseOrigin: ph.origin,
          crawlId: crawl.id,
        });
        break;
      }
    }
    suggestions.push(...found);
  }
  return {
    version: INTERNAL_LINKS_VERSION,
    crawl,
    suggestions,
    skipped,
    note: `Based on crawl ${crawl.id} (${crawl.status}, ${crawl.pagesFetched} page(s) fetched${crawl.stopReason ? `, stopped: ${crawl.stopReason}` : ''}). Suggestions are for human review; link counts are not authority scores.${notes.size ? ` ${[...notes].join(' ')}` : ''}`,
    ...(notes.size ? { notes: [...notes] } : {}),
  };
}

export interface OrphanReport {
  version: string;
  crawl: CrawlInfo | null;
  /** The crawl completed (frontier exhausted within limits): pages it never reached can be assessed too. */
  coverageComplete: boolean;
  potentialOrphans: Array<{ pageId: string; url: string; crawledInThisCrawl: boolean; firstSource: string; inboundInternalLinkCount: number; note: string }>;
  /**
   * Pages whose orphan status is unknown because the crawl was partial: pages
   * it never reached, and fetched pages with no inbound link among the
   * fetched pages (their inbound sources may be outside coverage).
   */
  notAssessable: Array<{ pageId: string; url: string; firstSource: string; reason: string; crawledInThisCrawl?: boolean }>;
  inboundCounts: Array<{ pageId: string; url: string; inboundInternalLinkCount: number }>;
  coverageNote: string;
  metricNote: string;
}

/** Potential orphans relative to the latest own-site crawl coverage. */
export function findPotentialOrphans(db: Db, siteId: string): OrphanReport {
  const crawl = latestOwnCrawl(db, siteId);
  const metricNote = 'inboundInternalLinkCount is the number of internal links observed in one crawl; it is not an authority score.';
  if (!crawl) return { version: INTERNAL_LINKS_VERSION, crawl: null, coverageComplete: false, potentialOrphans: [], notAssessable: [], inboundCounts: [], coverageNote: 'No completed own-site crawl: orphan status cannot be assessed.', metricNote };
  const coverageComplete = crawl.status === 'completed';
  // Gone (404/410) and redirected URLs are not pages that need inbound links.
  const pages = db.all<{ id: string; url: string; first_source: string }>("SELECT id, url, first_source FROM pages WHERE site_id = ? AND lifecycle NOT IN ('redirected', 'gone') AND is_excluded = 0 ORDER BY url", [siteId]);
  const crawled = new Set(db.all<{ page_id: string }>('SELECT DISTINCT page_id FROM crawl_results WHERE site_id = ? AND crawl_id = ? AND page_id IS NOT NULL AND status_code BETWEEN 200 AND 299', [siteId, crawl.id]).map((r) => r.page_id));
  const links = db.all<{ source_page_id: string | null; target_page_id: string | null; target_url: string }>('SELECT source_page_id, target_page_id, target_url FROM internal_links WHERE site_id = ? AND crawl_id = ?', [siteId, crawl.id]);
  const urlToId = new Map(pages.map((p) => [p.url, p.id]));
  const inbound = new Map<string, Set<string>>();
  for (const l of links) {
    const target = l.target_page_id ?? urlToId.get(normalizeUrl(l.target_url)?.url ?? l.target_url) ?? null;
    if (!target || target === l.source_page_id) continue;
    const s = inbound.get(target) ?? new Set<string>();
    s.add(l.source_page_id ?? `unknown:${l.target_url}`);
    inbound.set(target, s);
  }
  const coverage = `Relative to crawl ${crawl.id} (${crawl.status}; ${crawl.pagesFetched} of ${crawl.pagesAttempted} attempted page(s) fetched${crawl.stopReason ? `; stopped: ${crawl.stopReason}` : ''}). ${
    coverageComplete
      ? 'Pages linking from outside this coverage are unknown.'
      : 'The crawl was partial (frontier not exhausted): pages that could link to a page may never have been fetched, so no page is called a potential orphan; pages without an observed inbound link are listed as not assessable.'
  }`;
  const potentialOrphans: OrphanReport['potentialOrphans'] = [];
  const notAssessable: OrphanReport['notAssessable'] = [];
  const inboundCounts: OrphanReport['inboundCounts'] = [];
  for (const p of pages) {
    const count = inbound.get(p.id)?.size ?? 0;
    inboundCounts.push({ pageId: p.id, url: p.url, inboundInternalLinkCount: count });
    if (count > 0) continue;
    const fetched = crawled.has(p.id);
    if (!coverageComplete) {
      notAssessable.push(
        fetched
          ? { pageId: p.id, url: p.url, firstSource: p.first_source, crawledInThisCrawl: true, reason: `not assessable (inbound sources outside coverage): fetched in partial crawl ${crawl.id}, but pages that may link to it were not fetched` }
          : { pageId: p.id, url: p.url, firstSource: p.first_source, crawledInThisCrawl: false, reason: `known from ${p.first_source} but outside the coverage of partial crawl ${crawl.id}; orphan status unknown` },
      );
      continue;
    }
    potentialOrphans.push({
      pageId: p.id,
      url: p.url,
      crawledInThisCrawl: fetched,
      firstSource: p.first_source,
      inboundInternalLinkCount: 0,
      note: fetched
        ? 'Fetched in the crawl (e.g. via sitemap or seed) but no crawled page links to it.'
        : `Known from ${p.first_source}; the completed crawl never reached it through internal links (it may also be linked only via nofollow, JavaScript, or blocked pages).`,
    });
  }
  return { version: INTERNAL_LINKS_VERSION, crawl, coverageComplete, potentialOrphans, notAssessable, inboundCounts, coverageNote: coverage, metricNote };
}
