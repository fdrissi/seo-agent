import { AEO_LABEL, AEO_VERSION, assessAeoForResult, type AeoAssessment, type AeoCheckStatus } from '../crawler/aeo.js';
import { ELIGIBILITY_CAVEAT } from '../crawler/eligibility.js';
import { crawlResultsForCrawl, latestOwnCrawlId } from '../seo/crawl-data.js';
import { findPotentialOrphans, suggestInternalLinks, type CrawlInfo, type DestinationSpec, type LinkSuggestion, type OrphanReport, type SuggestResult } from '../seo/internal-links.js';
import { normalizeUrl } from '../seo/url.js';
import { bulletList, cell, code, fmtDate, inline, rawCell, table } from './markdown.js';
import { all, one, str, type RenderContext } from './render-context.js';

/**
 * Site-structure presentation for vault notes, read from the database and
 * the crawler/seo modules (read-only):
 *
 * - page-level AEO assessment (spec 17) on page notes and the 09 AI Search
 *   index note (src/crawler/aeo.ts; deterministic heuristics; factual
 *   consistency is not assessed and says so);
 * - internal-link suggestions {source, destination, passage, anchor, reason}
 *   and potential orphans relative to the latest own-site crawl's coverage
 *   (src/seo/internal-links.ts) on page notes. Link counts are observations
 *   from one crawl, never an authority score.
 *
 * Derived data is computed once per render (RenderContext.cache). Missing
 * data is written as DATA UNAVAILABLE, never as zero or "ok".
 */

/** Priority destination pages per render for link suggestions (bounded, like `analyze links`). */
export const LINK_DESTINATIONS_PER_RENDER = 10;
export const LINK_SUGGESTIONS_PER_DESTINATION = 5;
/** Pages listed on the 09 AI Search note (the latest own-site crawl's assessable pages). */
export const AEO_INDEX_PAGE_LIMIT = 50;

function memo<T>(rc: RenderContext, key: string, compute: () => T): T {
  const cache = rc.cache ?? (rc.cache = new Map());
  if (cache.has(key)) return cache.get(key) as T;
  const v = compute();
  cache.set(key, v);
  return v;
}

function crawlIsSynthetic(rc: RenderContext, crawlId: string | null | undefined): boolean {
  if (!crawlId) return false;
  return memo(rc, `crawl-synthetic:${crawlId}`, () => one(rc, 'SELECT is_synthetic AS s FROM crawls WHERE site_id = ? AND id = ?', [rc.ctx.siteId, crawlId])?.s === 1);
}

// ---------------------------------------------------------------- AEO

export function aeoForResult(rc: RenderContext, resultId: string): AeoAssessment | null {
  return memo(rc, `aeo:${resultId}`, () => assessAeoForResult(rc.ctx, resultId));
}

/** Latest own-site (or single-page) crawl result for a page; null when the page was never crawled. */
function latestPageResultId(rc: RenderContext, pageId: string): string | null {
  return str(
    one(
      rc,
      `SELECT cr.id FROM crawl_results cr JOIN crawls c ON c.id = cr.crawl_id AND c.site_id = cr.site_id
        WHERE cr.site_id = ? AND cr.page_id = ? AND c.kind IN ('own_site', 'single_page') ORDER BY cr.fetched_at DESC, cr.rowid DESC LIMIT 1`,
      [rc.ctx.siteId, pageId],
    )?.id,
  );
}

const STATUS_TEXT: Record<AeoCheckStatus, string> = { ok: 'ok', review: '**review**', unknown: 'unknown' };

const FACTUAL_CONSISTENCY = 'DATA UNAVAILABLE: not assessed. The AEO checks are heuristics over crawl text and do not verify facts; new drafts are checked by the content quality gates.';

function eligibilityCells(a: AeoAssessment): [string, string] {
  const e = a.eligibility;
  if (!e) return ['unknown', cell('DATA UNAVAILABLE: no stored crawl signals for this result.', 300)];
  return [cell(`crawl ${e.crawl} · indexing ${e.indexing} · snippet ${e.snippet} · AI features ${e.aiFeatures}`, 300), cell(e.reasons.length ? e.reasons.join(' ') : 'No blocking directive observed.', 400)];
}

/** "AI search readiness" section of a page note. */
export function aeoPageSection(rc: RenderContext, pageId: string): string[] {
  const lines = ['## AI search readiness (AEO, heuristic)', ''];
  const resultId = latestPageResultId(rc, pageId);
  const a = resultId ? aeoForResult(rc, resultId) : null;
  if (!a) {
    lines.push('DATA UNAVAILABLE: this page has no own-site crawl result, so the AEO checks have not run (`npm run cli -- crawl`).');
    return lines;
  }
  const [eligStatus, eligDetail] = eligibilityCells(a);
  lines.push(
    `Assessed from crawl result ${code(a.resultId, 60)} (crawl ${code(a.crawlId, 60)}, fetched ${fmtDate(a.fetchedAt)}) with ${inline(AEO_VERSION)} (${inline(AEO_LABEL)}).${a.isSynthetic ? ' SYNTHETIC crawl: fixture/demo pages, not an observation of a real site.' : ''}`,
    '',
    table(
      ['Criterion', 'Status', 'Finding'],
      [
        ['Clear answers', STATUS_TEXT[a.answer.status], cell(a.answer.summary, 400)],
        ['Descriptive headings', STATUS_TEXT[a.headings.status], cell(a.headings.summary, 400)],
        ['Self-contained sections', STATUS_TEXT[a.sections.status], cell(a.sections.summary, 400)],
        ['Factual consistency', 'DATA UNAVAILABLE', cell(FACTUAL_CONSISTENCY, 400)],
        ['Useful evidence', STATUS_TEXT[a.evidence.status], cell(a.evidence.summary, 400)],
        ['Crawl / index / snippet eligibility', eligStatus, eligDetail],
      ],
    ),
    '',
    bulletList([...a.caveats.map((c) => inline(c, 400)), inline(a.eligibility?.caveat ?? ELIGIBILITY_CAVEAT, 400)]),
  );
  return lines;
}

export interface SiteAeo {
  crawlId: string | null;
  pages: Array<{ pageId: string | null; assessment: AeoAssessment }>;
  notAssessed: number;
}

/** AEO assessments of the latest own-site crawl's successfully fetched pages with stored text (bounded). */
export function siteAeo(rc: RenderContext, limit = AEO_INDEX_PAGE_LIMIT): SiteAeo {
  return memo(rc, `site-aeo:${limit}`, () => {
    const crawlId = latestOwnCrawlId(rc.ctx.db, rc.ctx.siteId);
    if (!crawlId) return { crawlId: null, pages: [], notAssessed: 0 };
    const rows = crawlResultsForCrawl(rc.ctx.db, rc.ctx.siteId, crawlId).filter((r) => r.status_code !== null && r.status_code >= 200 && r.status_code < 300 && !r.blocked_reason && r.text_ref);
    const pages = rows
      .slice(0, limit)
      .map((r) => ({ pageId: r.page_id, assessment: aeoForResult(rc, r.id) }))
      .filter((p): p is { pageId: string | null; assessment: AeoAssessment } => !!p.assessment)
      .sort((x, y) => y.assessment.counts.review - x.assessment.counts.review || x.assessment.url.localeCompare(y.assessment.url));
    return { crawlId, pages, notAssessed: Math.max(0, rows.length - limit) };
  });
}

/** Page-level AEO section of the 09 AI Search index note. */
export function aeoIndexSection(rc: RenderContext): { lines: string[]; sourceIds: string[]; synthetic: boolean } {
  const lines = ['## Page-level AEO assessment (heuristic)', ''];
  const s = siteAeo(rc);
  if (!s.crawlId) {
    lines.push('DATA UNAVAILABLE: no completed own-site crawl yet, so no page has been assessed (`npm run cli -- crawl`).');
    return { lines, sourceIds: [], synthetic: false };
  }
  const synthetic = crawlIsSynthetic(rc, s.crawlId) || s.pages.some((p) => p.assessment.isSynthetic);
  if (!s.pages.length) {
    lines.push(`DATA UNAVAILABLE: own-site crawl ${code(s.crawlId, 60)} has no successfully fetched HTML page with stored text to assess.`);
    return { lines, sourceIds: [s.crawlId], synthetic };
  }
  const count = (k: 'answer' | 'headings' | 'sections' | 'evidence', st: AeoCheckStatus) => s.pages.filter((p) => p.assessment[k].status === st).length;
  const summary = (k: 'answer' | 'headings' | 'sections' | 'evidence') => `${count(k, 'ok')} ok, ${count(k, 'review')} to review, ${count(k, 'unknown')} unknown`;
  lines.push(
    `${s.pages.length} page(s) of own-site crawl ${code(s.crawlId, 60)}${synthetic ? ' (SYNTHETIC crawl)' : ''}, assessed with ${inline(AEO_VERSION)} (${inline(AEO_LABEL)}): deterministic editorial checks, not Google ranking rules and not a prediction of AI citations or rich results.`,
    '',
    bulletList([
      `Clear answers: ${summary('answer')}`,
      `Descriptive headings: ${summary('headings')}`,
      `Self-contained sections: ${summary('sections')}`,
      `Factual consistency: ${FACTUAL_CONSISTENCY}`,
      `Useful evidence: ${summary('evidence')}`,
      `Crawl / index / snippet eligibility: noindex on ${s.pages.filter((p) => p.assessment.eligibility?.indexing === 'blocked_by_noindex').length}, snippets blocked on ${s.pages.filter((p) => p.assessment.eligibility?.snippet === 'blocked').length}, not eligible for AI features on ${s.pages.filter((p) => p.assessment.eligibility?.aiFeatures === 'not_eligible').length}, unknown on ${s.pages.filter((p) => !p.assessment.eligibility || p.assessment.eligibility.indexing === 'unknown').length}. ${inline(ELIGIBILITY_CAVEAT, 300)}`,
    ]),
    '',
    table(
      ['Page', 'Clear answers', 'Headings', 'Sections', 'Evidence', 'Factual consistency', 'Indexing', 'Snippet', 'AI features'],
      s.pages.map(({ pageId, assessment: a }) => [
        pageId && rc.plan.has(`page:${pageId}`) ? rawCell(rc.plan.link(`page:${pageId}`)) : cell(a.url, 200),
        STATUS_TEXT[a.answer.status],
        STATUS_TEXT[a.headings.status],
        STATUS_TEXT[a.sections.status],
        STATUS_TEXT[a.evidence.status],
        'not assessed',
        cell(a.eligibility?.indexing ?? 'unknown'),
        cell(a.eligibility?.snippet ?? 'unknown'),
        cell(a.eligibility?.aiFeatures ?? 'unknown'),
      ]),
    ),
  );
  if (s.notAssessed) lines.push('', `${s.notAssessed} further fetched page(s) were not assessed here (limit ${AEO_INDEX_PAGE_LIMIT}); run \`npm run cli -- crawl aeo\` for the full list.`);
  lines.push('', 'Each page note has the findings behind these statuses.');
  return { lines, sourceIds: [s.crawlId], synthetic };
}

// ---------------------------------------------------------------- internal links

export interface RenderLinkInsights {
  destinations: DestinationSpec[];
  suggestions: SuggestResult | null;
  orphans: OrphanReport;
  crawl: CrawlInfo | null;
  synthetic: boolean;
}

/**
 * Priority destination pages (pages with open opportunities, else the top
 * pages by Search Console impressions for the render's property and search
 * type; never gone, redirected, or excluded pages), their link suggestions,
 * and potential orphans. Computed once per render.
 */
export function linkInsights(rc: RenderContext): RenderLinkInsights {
  return memo(rc, 'link-insights', () => {
    const { db, siteId } = rc.ctx;
    const live = "p.is_excluded = 0 AND p.lifecycle NOT IN ('redirected', 'gone')";
    let destinations = all(
      rc,
      `SELECT p.id AS pageId, p.url AS url FROM opportunities o JOIN pages p ON p.id = o.page_id AND p.site_id = o.site_id
        WHERE o.site_id = ? AND o.status IN ('candidate', 'shortlisted', 'recommended') AND ${live}
        GROUP BY p.id ORDER BY MAX(COALESCE(o.score, -1e9)) DESC, p.url LIMIT ?`,
      [siteId, LINK_DESTINATIONS_PER_RENDER],
    ).map((r) => ({ pageId: String(r.pageId), url: String(r.url) }));
    if (!destinations.length && rc.gsc) {
      destinations = all(
        rc,
        `SELECT p.id AS pageId, p.url AS url FROM gsc_page_daily_current g JOIN pages p ON p.id = g.page_id AND p.site_id = g.site_id
          WHERE g.site_id = ? AND g.property = ? AND g.search_type = ? AND g.segment_key = '' AND ${live}
          GROUP BY p.id ORDER BY SUM(g.impressions) DESC, p.url LIMIT ?`,
        [siteId, rc.gsc.property, rc.gsc.searchType, LINK_DESTINATIONS_PER_RENDER],
      ).map((r) => ({ pageId: String(r.pageId), url: String(r.url) }));
    }
    const suggestions = destinations.length ? suggestInternalLinks(db, rc.ctx.raw, siteId, { destinations, maxPerDestination: LINK_SUGGESTIONS_PER_DESTINATION }) : null;
    const orphans = findPotentialOrphans(db, siteId);
    const crawl = suggestions?.crawl ?? orphans.crawl;
    return { destinations, suggestions, orphans, crawl, synthetic: crawlIsSynthetic(rc, crawl?.id) };
  });
}

function samePage(pageId: string, url: string, ref: { pageId: string | null; url: string }): boolean {
  if (ref.pageId) return ref.pageId === pageId;
  return (normalizeUrl(ref.url)?.url ?? ref.url) === (normalizeUrl(url)?.url ?? url);
}

function suggestionRows(rc: RenderContext, list: LinkSuggestion[], other: 'source' | 'destination'): string[][] {
  return list.map((s) => {
    const p = other === 'source' ? s.sourcePage : s.destination;
    const linked = p.pageId && rc.plan.has(`page:${p.pageId}`) ? rawCell(rc.plan.link(`page:${p.pageId}`)) : cell(p.url, 200);
    return [linked, cell(s.proposedAnchor, 120), cell(s.passage, 300), cell(s.reason, 300)];
  });
}

function crawlText(c: CrawlInfo): string {
  return `crawl ${code(c.id, 60)} (${inline(c.status)}; ${c.pagesFetched} of ${c.pagesAttempted} attempted page(s) fetched${c.stopReason ? `; stopped: ${inline(c.stopReason)}` : ''})`;
}

/** "Internal links" section of a page note. */
export function internalLinksPageSection(rc: RenderContext, pageId: string, url: string): string[] {
  const lines = ['## Internal links', ''];
  const li = linkInsights(rc);
  const o = li.orphans;
  if (!li.crawl || !o.crawl) {
    lines.push('DATA UNAVAILABLE: no completed own-site crawl, so internal-link suggestions and orphan status cannot be assessed (`npm run cli -- crawl`).');
    return lines;
  }
  const synthetic = li.synthetic ? ' · SYNTHETIC crawl' : '';
  const orphan = o.potentialOrphans.find((x) => x.pageId === pageId);
  const notAssessable = o.notAssessable.find((x) => x.pageId === pageId);
  const inbound = o.inboundCounts.find((x) => x.pageId === pageId);
  let status: string;
  if (orphan) status = `**Potential orphan** relative to ${crawlText(o.crawl)}: ${inline(orphan.note, 300)} Links from outside this crawl's coverage are unknown.`;
  else if (notAssessable) status = `Orphan status not assessable: ${inline(notAssessable.reason, 300)}.`;
  else if (inbound) status = `Not an orphan in ${crawlText(o.crawl)}: ${inbound.inboundInternalLinkCount} distinct crawled page(s) link here.`;
  else status = 'Orphan status not assessed: redirected, gone, and excluded pages are not assessed.';
  lines.push(`- ${status}${synthetic}`, '- Internal-link counts are observations from one crawl, never an authority score.', '');

  const suggested = li.suggestions?.suggestions ?? [];
  const isDestination = li.destinations.some((d) => d.pageId === pageId);
  lines.push('### Suggested links to this page', '');
  const inboundSuggestions = suggested.filter((s) => s.destination.pageId === pageId);
  if (inboundSuggestions.length) {
    lines.push(table(['Source page', 'Proposed anchor', 'Passage', 'Reason'], suggestionRows(rc, inboundSuggestions, 'source')), '', 'Suggestions for human review: add a link only where it helps the reader.');
  } else if (isDestination) {
    lines.push(`None: no other page of ${crawlText(li.crawl)} mentions this page's phrases (top Search Console queries, title, H1) without already linking to it.`);
  } else {
    lines.push(`Not computed for this page: suggestions are computed for up to ${LINK_DESTINATIONS_PER_RENDER} priority pages per render (pages with open opportunities, else the top pages by Search Console impressions). Run ${code(`npm run cli -- analyze links --url ${url}`, 400)} for this page.`);
  }
  const outbound = suggested.filter((s) => samePage(pageId, url, s.sourcePage));
  lines.push('', '### Suggested links from this page', '');
  lines.push(outbound.length ? table(['Destination page', 'Proposed anchor', 'Passage', 'Reason'], suggestionRows(rc, outbound, 'destination')) : noOutboundText(rc, li, pageId, url));
  return lines;
}

/**
 * Why a page note shows no outbound link suggestion. "None" is written only
 * when this page was a source of the suggestion run: a fetched 2xx, not
 * noindex crawl result with stored text in the suggestion crawl that the run
 * did not skip. Otherwise the page's text was never searched, which is
 * "not assessable", never "none".
 */
function noOutboundText(rc: RenderContext, li: RenderLinkInsights, pageId: string, url: string): string {
  if (!li.destinations.length || !li.suggestions) return 'DATA UNAVAILABLE: there are no priority destination pages (no open opportunities and no Search Console page rows).';
  const crawl = li.suggestions.crawl;
  if (!crawl) return 'Not assessable: no completed own-site crawl to search for link suggestions.';
  if (!isSuggestionSource(rc, li.suggestions, crawl.id, pageId, url)) return `Not assessable: this page has no crawled text in crawl ${code(crawl.id, 60)}.`;
  const others = li.destinations.filter((d) => d.pageId !== pageId);
  if (!others.length) return 'None: this page is the only priority page of this render, and a page is never suggested to link to itself.';
  const counts = new Map<string, number>();
  for (const s of li.suggestions.suggestions) counts.set(s.destination.pageId, (counts.get(s.destination.pageId) ?? 0) + 1);
  const full = others.filter((d) => (counts.get(d.pageId) ?? 0) >= LINK_SUGGESTIONS_PER_DESTINATION).length;
  const capped = full ? ` ${full} of them already had the maximum of ${LINK_SUGGESTIONS_PER_DESTINATION} suggestions, so this page may not have been searched for them.` : '';
  return `None toward the ${others.length} other priority page(s) of this render in ${crawlText(crawl)}.${capped}`;
}

/**
 * Pages whose text the suggestion run searched in `crawlId` (computed once per
 * render): results with a 2xx status, not excluded, not noindex, and stored
 * text that could be loaded, which are the same conditions
 * suggestInternalLinks uses to pick its sources. Results without a page id are
 * kept by normalized URL.
 */
function suggestionSources(rc: RenderContext, suggestions: SuggestResult, crawlId: string): { pageIds: Set<string>; urls: Set<string> } {
  return memo(rc, `link-sources:${crawlId}`, () => {
    const norm = (u: string) => normalizeUrl(u)?.url ?? u;
    const noText = new Set(suggestions.skipped.filter((s) => s.reason === 'extracted text unavailable').map((s) => norm(s.url)));
    const out = { pageIds: new Set<string>(), urls: new Set<string>() };
    const rows = all(
      rc,
      `SELECT cr.page_id, cr.requested_url, cr.final_url, cr.status_code, cr.text_ref, cr.meta_robots, p.is_excluded
         FROM crawl_results cr LEFT JOIN pages p ON p.id = cr.page_id AND p.site_id = cr.site_id WHERE cr.site_id = ? AND cr.crawl_id = ?`,
      [rc.ctx.siteId, crawlId],
    );
    for (const r of rows) {
      const status = typeof r.status_code === 'number' ? r.status_code : null;
      const robots = str(r.meta_robots);
      const resultUrl = norm(str(r.final_url) ?? String(r.requested_url));
      if (status === null || status < 200 || status >= 300 || r.is_excluded === 1 || (robots && /noindex/i.test(robots)) || !str(r.text_ref) || noText.has(resultUrl)) continue;
      const id = str(r.page_id);
      if (id) out.pageIds.add(id);
      else out.urls.add(resultUrl);
    }
    return out;
  });
}

// ---------------------------------------------------------------- competitor page checks

interface CompetitorCheckRow {
  at: string;
  requested: boolean;
  label: string;
}

/** Why a competitor check sent no request for the page itself (crawl_results row details). */
function notRequestedLabel(blockedReason: string | null, fetchErrorCode: string | null): string {
  if (fetchErrorCode === 'unsafe_url:dns_failure') return 'not fetched: DNS resolution failed before any request';
  if (blockedReason === 'unsafe_url') return 'blocked before any request (SSRF guard)';
  if (blockedReason === 'robots') return 'not fetched: disallowed by robots.txt';
  if (blockedReason === 'rate_limited') return 'not fetched: the host asked this crawler to back off';
  return `not fetched (${blockedReason ?? 'no request was sent'})`;
}

/**
 * Competitor-crawl checks of one URL, newest first. `requested` is the stored
 * `pageRequested` flag; for rows written before it existed, a request was made
 * when a status code was received, or when the fetcher made an attempt that
 * the SSRF guard did not stop (a timeout or connection error after sending).
 */
function competitorChecks(rc: RenderContext, url: string): CompetitorCheckRow[] {
  return all(
    rc,
    `SELECT cr.fetched_at AS at, cr.status_code AS status, cr.blocked_reason AS blocked,
            json_extract(cr.extraction_json, '$.pageRequested') AS page_requested,
            json_extract(cr.extraction_json, '$.fetchErrorCode') AS error_code,
            json_extract(cr.extraction_json, '$.attempts') AS attempts
       FROM crawl_results cr JOIN crawls c ON c.id = cr.crawl_id AND c.site_id = cr.site_id
      WHERE cr.site_id = ? AND c.kind = 'competitor' AND cr.requested_url = ?
      ORDER BY cr.fetched_at DESC, cr.rowid DESC LIMIT 20`,
    [rc.ctx.siteId, url],
  ).map((r) => {
    const errorCode = str(r.error_code);
    const flag = r.page_requested;
    const requested =
      flag === 1 || flag === true
        ? true
        : flag === 0 || flag === false
          ? false
          : r.status !== null && r.status !== undefined
            ? true
            : Number(r.attempts ?? 0) > 0 && !(errorCode ?? '').startsWith('unsafe_url:');
    return { at: String(r.at), requested, label: requested ? 'checked' : notRequestedLabel(str(r.blocked), errorCode) };
  });
}

/**
 * The check status of a tracked competitor page for its vault note. "last
 * checked <date>" is written only when a request for the page was actually
 * made; a URL the SSRF guard refused (including pages tracked before the
 * guard ran first) says "blocked before any request", and DNS or robots.txt
 * outcomes say that the page was not fetched. Without any stored crawl result
 * the recorded last_checked_at is shown as before ("never" when unset).
 */
export function competitorPageCheckText(rc: RenderContext, page: { url: string; last_checked_at: string | null }): string {
  const checks = competitorChecks(rc, page.url);
  const latest = checks[0];
  if (!latest) return `last checked ${fmtDate(page.last_checked_at, 'never')}`;
  const lastRequested = checks.find((c) => c.requested);
  if (!lastRequested) return `${latest.label} (last attempt ${fmtDate(latest.at)})`;
  if (lastRequested === latest) return `last checked ${fmtDate(latest.at)}`;
  return `last checked ${fmtDate(lastRequested.at)}; latest attempt ${fmtDate(latest.at)}: ${latest.label}`;
}

/** True when the suggestion run searched this page's text (see `suggestionSources`). */
function isSuggestionSource(rc: RenderContext, suggestions: SuggestResult, crawlId: string, pageId: string, url: string): boolean {
  const sources = suggestionSources(rc, suggestions, crawlId);
  return sources.pageIds.has(pageId) || sources.urls.has(normalizeUrl(url)?.url ?? url);
}
