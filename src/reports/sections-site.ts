import { AEO_LABEL, AEO_VERSION, assessAeoForSite, type AeoCheckStatus, type AeoSiteAssessment } from '../crawler/aeo.js';
import { findPotentialOrphans, suggestInternalLinks, type CrawlInfo, type DestinationSpec, type OrphanReport, type SuggestResult } from '../seo/internal-links.js';
import type { SiteStructureSummary } from '../seo/site-structure.js';
import type { BuildEnv, InternalLinksReportInput } from './env.js';
import { markSynthetic } from './env.js';
import { dbQueryLink, inferred, observed, recommendation, recordLink, section, unavailable, type Claim, type EvidenceLink, type ReportSection, type ReportTable } from './model.js';

/**
 * Site-structure sections computed from the latest own-site crawl:
 *
 * - `internal_links` (weekly): internal-link suggestions {source, destination,
 *   passage, proposed anchor, reason} for a few priority destination pages,
 *   and potential orphans relative to the crawl's coverage
 *   (src/seo/internal-links.ts). Link counts are observations from one crawl,
 *   never an authority score.
 * - `aeo` (monthly; weekly too when the run's `site_structure` stage supplied
 *   it): the page-level AEO assessment (spec 17: clear answers, descriptive
 *   headings, self-contained sections, factual consistency, useful evidence,
 *   crawl/index/snippet eligibility) from src/crawler/aeo.ts. The checks are
 *   deterministic heuristics; factual consistency is not assessed for
 *   published pages and is reported as DATA UNAVAILABLE.
 *
 * Sources, in order: explicit report input (`internalLinks` / `aeo`), the
 * weekly pipeline's `siteStructure` summary (src/seo/site-structure.ts), or
 * the database (read-only). `null` input means "not collected" and is
 * reported as DATA UNAVAILABLE. Nothing is inferred from missing data.
 */

const NO_CRAWL_REASON = 'no completed or partial own-site crawl is recorded; run `npm run cli -- crawl` first';
const NOT_COLLECTED_REASON = 'the run that produced this report did not collect this data';
const MAX_SUGGESTIONS_PER_DESTINATION = 3;
const MAX_DESTINATIONS = 10;
const AEO_PAGE_LIMIT = 50;

type Crawl = CrawlInfo & { synthetic?: boolean };

function crawlAt(c: CrawlInfo): string {
  return c.finishedAt ?? c.startedAt;
}

function crawlSynthetic(env: BuildEnv, crawlId: string | null | undefined, known?: boolean): boolean {
  if (!crawlId) return false;
  const s = known === true || env.ctx.db.get<{ s: number }>('SELECT is_synthetic AS s FROM crawls WHERE site_id = ? AND id = ?', [env.ctx.siteId, crawlId])?.s === 1;
  markSynthetic(env, 'crawls', s);
  return s;
}

function crawlEvidence(env: BuildEnv, crawlId: string): EvidenceLink[] {
  return [recordLink('crawls', crawlId, `own-site crawl ${crawlId}`), dbQueryLink('internal_links', { site_id: env.ctx.siteId, crawl_id: crawlId })];
}

function crawlLabel(c: CrawlInfo): string {
  return `own-site crawl ${c.id} (${c.status}; ${c.pagesFetched} of ${c.pagesAttempted} attempted page(s) fetched${c.stopReason ? `; stopped: ${c.stopReason}` : ''})`;
}

// ---------------------------------------------------------------- internal links (weekly)

export interface LinkDestinations {
  destinations: DestinationSpec[];
  /** How the destinations were chosen, for the report text. */
  basis: string;
}

/**
 * Priority destination pages for link suggestions (bounded): the primary
 * action's page, pages with open opportunities (highest score first), then
 * the top Search Console pages of the report period (one property and search
 * type, unsegmented, complete days). Gone, redirected, and excluded pages are
 * never destinations.
 */
export function linkDestinations(env: BuildEnv, max = Math.min(env.topN, MAX_DESTINATIONS)): LinkDestinations {
  const { ctx } = env;
  const out = new Map<string, DestinationSpec>();
  const counts = { primary: 0, opportunities: 0, gsc: 0 };
  const eligible = (pageId: string | null): { id: string; url: string } | undefined =>
    pageId ? ctx.db.get<{ id: string; url: string }>("SELECT id, url FROM pages WHERE site_id = ? AND id = ? AND is_excluded = 0 AND lifecycle NOT IN ('redirected', 'gone')", [ctx.siteId, pageId]) : undefined;
  const add = (pageId: string | null, source: keyof typeof counts) => {
    if (out.size >= max || !pageId || out.has(pageId)) return;
    const p = eligible(pageId);
    if (!p) return;
    out.set(p.id, { pageId: p.id, url: p.url });
    counts[source]++;
  };
  const recId = env.data.primaryAction?.recommendationId;
  if (recId) add(ctx.db.get<{ page_id: string | null }>('SELECT page_id FROM recommendations WHERE site_id = ? AND id = ?', [ctx.siteId, recId])?.page_id ?? null, 'primary');
  for (const o of ctx.db.all<{ page_id: string }>(
    `SELECT page_id, MAX(COALESCE(score, -1e9)) AS s, MAX(updated_at) AS u FROM opportunities
      WHERE site_id = ? AND page_id IS NOT NULL AND status IN ('candidate', 'shortlisted', 'recommended')
      GROUP BY page_id ORDER BY s DESC, u DESC, page_id LIMIT ?`,
    [ctx.siteId, max * 3],
  )) add(o.page_id, 'opportunities');
  if (out.size < max && env.gsc.property) {
    for (const r of ctx.db.all<{ page_id: string }>(
      `SELECT page_id, SUM(clicks) AS c, SUM(impressions) AS i FROM gsc_page_daily_current
        WHERE site_id = ? AND property = ? AND search_type = ? AND segment_key = '' AND is_final = 1 AND page_id IS NOT NULL AND date BETWEEN ? AND ?
        GROUP BY page_id ORDER BY c DESC, i DESC, page_id LIMIT ?`,
      [ctx.siteId, env.gsc.property, env.gsc.searchType, env.period.start, env.period.end, max * 3],
    )) add(r.page_id, 'gsc');
  }
  const parts = [counts.primary ? "the primary action's page" : '', counts.opportunities ? `${counts.opportunities} page(s) with open opportunities` : '', counts.gsc ? `${counts.gsc} top Search Console page(s) of the period` : ''].filter(Boolean);
  return { destinations: [...out.values()], basis: parts.join(', ') };
}

/** Internal-link data from any source, normalized (counts are totals; lists may be bounded). */
interface LinksView {
  crawl: Crawl | null;
  destinationCount: number;
  basis: string;
  /** Suggestions were searched (a crawl and at least one destination). */
  searched: boolean;
  /** No crawled page had stored text to search (known only when computed here). */
  noSearchableText: boolean;
  suggestions: Array<{ sourceUrl: string; destinationUrl: string; anchor: string; passage: string; reason: string }>;
  totalSuggestions: number;
  notes: string[];
  orphans: {
    crawl: Crawl | null;
    coverageComplete: boolean;
    list: Array<{ url: string; crawledInThisCrawl: boolean; firstSource: string; note: string }>;
    total: number;
    notAssessable: number;
    coverageNote: string;
  };
}

function viewFromResults(env: BuildEnv, suggestions: SuggestResult | null, orphans: OrphanReport, destinationCount: number, basis: string, computedHere: boolean): LinksView {
  const notes: string[] = [];
  let noSearchableText = false;
  if (suggestions) {
    const noText = suggestions.skipped.filter((s) => s.reason === 'extracted text unavailable').length;
    if (noText) notes.push(`${noText} crawled page(s) had no stored text and were not searched for passages.`);
    if (suggestions.notes?.length) notes.push(...suggestions.notes);
    if (computedHere && suggestions.crawl) {
      const total = env.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM crawl_results WHERE site_id = ? AND crawl_id = ?', [env.ctx.siteId, suggestions.crawl.id])?.n ?? 0;
      noSearchableText = total - suggestions.skipped.length <= 0;
    }
  }
  return {
    crawl: suggestions?.crawl ?? orphans.crawl,
    destinationCount,
    basis,
    searched: !!suggestions?.crawl && destinationCount > 0,
    noSearchableText,
    suggestions: (suggestions?.suggestions ?? []).map((s) => ({ sourceUrl: s.sourcePage.url, destinationUrl: s.destination.url, anchor: s.proposedAnchor, passage: s.passage, reason: s.reason })),
    totalSuggestions: suggestions?.suggestions.length ?? 0,
    notes,
    orphans: {
      crawl: orphans.crawl,
      coverageComplete: orphans.coverageComplete,
      list: orphans.potentialOrphans.map((p) => ({ url: p.url, crawledInThisCrawl: p.crawledInThisCrawl, firstSource: p.firstSource, note: p.note })),
      total: orphans.potentialOrphans.length,
      notAssessable: orphans.notAssessable.length,
      coverageNote: orphans.coverageNote,
    },
  };
}

function viewFromSiteStructure(s: SiteStructureSummary): LinksView {
  const il = s.internalLinks;
  const origins = { candidate: 0, top_gsc_page: 0, provided: 0 };
  for (const d of il.destinations) origins[d.origin]++;
  const basis = [origins.candidate ? `${origins.candidate} candidate page(s) of this run` : '', origins.top_gsc_page ? `${origins.top_gsc_page} top Search Console page(s)` : '', origins.provided ? `${origins.provided} page(s) chosen by the caller` : ''].filter(Boolean).join(', ');
  const crawl: Crawl | null = s.crawl;
  return {
    crawl,
    destinationCount: il.destinations.length,
    basis,
    searched: il.claimLabel === 'RECOMMENDATION',
    noSearchableText: false,
    suggestions: il.suggestions.map((x) => ({ sourceUrl: x.sourcePage.url, destinationUrl: x.destination.url, anchor: x.proposedAnchor, passage: x.passage, reason: x.reason })),
    totalSuggestions: il.totalSuggestions,
    notes: il.skippedSources ? [`${il.skippedSources} crawled page(s) were skipped as link sources (non-200, excluded, noindex, or no stored text).`] : [],
    orphans: {
      crawl: s.orphans.claimLabel === 'DATA_UNAVAILABLE' ? null : crawl,
      coverageComplete: s.orphans.coverageComplete,
      list: s.orphans.potentialOrphans.map((p) => ({ url: p.url, crawledInThisCrawl: p.crawledInThisCrawl, firstSource: p.firstSource, note: p.note })),
      total: s.orphans.totalPotentialOrphans,
      notAssessable: s.orphans.notAssessable,
      coverageNote: s.orphans.coverageNote,
    },
  };
}

export function internalLinksSection(env: BuildEnv, provided?: InternalLinksReportInput | null, siteStructure?: SiteStructureSummary | null): ReportSection {
  const { ctx } = env;
  const title = 'Internal links (suggestions and potential orphans)';
  const notes = ['Internal-link counts are observations from one crawl, never an authority score. Suggestions are proposals for human review; nothing changes on the site until an approved change is implemented.'];
  if (provided === null) {
    return section('internal_links', title, {
      claims: [
        unavailable('links.suggestions', 'Internal-link suggestions: DATA UNAVAILABLE (not collected for this report).', NOT_COLLECTED_REASON),
        unavailable('links.orphans', 'Potential orphans: DATA UNAVAILABLE (not collected for this report).', NOT_COLLECTED_REASON),
      ],
      notes,
    });
  }
  let v: LinksView;
  if (provided) {
    v = viewFromResults(env, provided.suggestions, provided.orphans, provided.destinationCount ?? new Set(provided.suggestions.suggestions.map((s) => s.destination.pageId)).size, provided.destinationsBasis ?? 'destinations chosen by the caller', false);
  } else if (siteStructure) {
    v = viewFromSiteStructure(siteStructure);
  } else {
    const d = linkDestinations(env);
    const suggestions = d.destinations.length ? suggestInternalLinks(ctx.db, ctx.raw, ctx.siteId, { destinations: d.destinations, maxPerDestination: MAX_SUGGESTIONS_PER_DESTINATION }) : null;
    v = viewFromResults(env, suggestions, findPotentialOrphans(ctx.db, ctx.siteId), d.destinations.length, d.basis, true);
  }
  const claims: Claim[] = [];
  const tables: ReportTable[] = [];
  notes.push(...v.notes);
  const crawl = v.crawl;
  if (!crawl) {
    claims.push(unavailable('links.suggestions', 'Internal-link suggestions: DATA UNAVAILABLE (no own-site crawl).', NO_CRAWL_REASON));
    claims.push(unavailable('links.orphans', 'Potential orphans: DATA UNAVAILABLE (no own-site crawl).', NO_CRAWL_REASON));
    env.data.internalLinks = { crawlId: null, destinations: v.destinationCount, suggestions: null, potentialOrphans: null, coverageComplete: false };
    return section('internal_links', title, { claims, notes });
  }
  const synthetic = crawlSynthetic(env, crawl.id, crawl.synthetic);
  const sourceIds = [`crawls:${crawl.id}`];

  // Suggestions
  if (!v.searched) {
    claims.push(
      unavailable(
        'links.suggestions',
        'Internal-link suggestions: DATA UNAVAILABLE (no priority destination pages).',
        'there is no primary-action page, no candidate page or page with an open opportunity, and no Search Console page row to choose destination pages from; run `npm run cli -- analyze links --url <url>` for a specific page',
        { synthetic },
      ),
    );
  } else if (v.totalSuggestions > 0) {
    claims.push(
      recommendation(
        'links.suggestions',
        `${v.totalSuggestions} internal-link suggestion(s) for ${v.destinationCount} priority destination page(s)${v.basis ? ` (${v.basis})` : ''} from ${crawlLabel(crawl)}: each source page already mentions the proposed anchor in the quoted passage and does not link to the destination yet. Review each one before adding a link.`,
        { sourceIds, evidence: crawlEvidence(env, crawl.id), synthetic },
      ),
    );
    tables.push({
      id: 'links.suggestions',
      title: 'Internal-link suggestions (for human review)',
      columns: ['Source page', 'Destination page', 'Proposed anchor', 'Passage', 'Reason'],
      rows: v.suggestions.slice(0, env.topN).map((x) => [x.sourceUrl, x.destinationUrl, x.anchor, x.passage, x.reason]),
      totalRows: v.totalSuggestions,
      note: 'The passage is text from our own crawled page. Add a link only if it helps the reader.',
    });
  } else if (v.noSearchableText) {
    claims.push(unavailable('links.suggestions', 'Internal-link suggestions: DATA UNAVAILABLE (no crawled page text to search).', `none of the pages of ${crawlLabel(crawl)} has stored text that could be searched for passages`, { synthetic }));
  } else {
    claims.push(
      observed(
        'links.suggestions',
        `No internal-link suggestions for the ${v.destinationCount} priority destination page(s)${v.basis ? ` (${v.basis})` : ''} in ${crawlLabel(crawl)}: no other crawled page's text mentions their phrases without already linking to them.`,
        { sourceIds, retrievedAt: [crawlAt(crawl)], evidence: crawlEvidence(env, crawl.id), synthetic },
      ),
    );
  }

  // Potential orphans (only relative to a COMPLETED crawl's coverage)
  const o = v.orphans;
  if (!o.crawl) {
    claims.push(unavailable('links.orphans', 'Potential orphans: DATA UNAVAILABLE (no own-site crawl).', NO_CRAWL_REASON, { synthetic }));
  } else if (!o.coverageComplete) {
    claims.push(
      unavailable(
        'links.orphans',
        'Potential orphans: not assessable (the latest own-site crawl was partial).',
        `${crawlLabel(o.crawl)} did not exhaust its frontier, so pages that could link to a page may never have been fetched; no page is called a potential orphan, and ${o.notAssessable} page(s) without an observed inbound link are not assessable`,
        { synthetic },
      ),
    );
  } else {
    claims.push(
      inferred(
        'links.orphans',
        o.total
          ? `${o.total} potential orphan page(s) relative to ${crawlLabel(o.crawl)}: no crawled page links to them. Links from outside this crawl's coverage are unknown.`
          : `No potential orphan pages relative to ${crawlLabel(o.crawl)}: every known active page has an inbound internal link from a crawled page.`,
        {
          sourceIds: [`crawls:${o.crawl.id}`],
          retrievedAt: [crawlAt(o.crawl)],
          metricIds: ['links.inbound_internal'],
          evidence: [...crawlEvidence(env, o.crawl.id), dbQueryLink('pages', { site_id: ctx.siteId, is_excluded: 0 }, 'known pages (not redirected or gone)')],
          synthetic: crawlSynthetic(env, o.crawl.id, o.crawl.synthetic),
        },
      ),
    );
    if (o.list.length) {
      tables.push({
        id: 'links.orphans',
        title: 'Potential orphans (relative to crawl coverage)',
        columns: ['Page', 'Fetched in the crawl', 'Known from', 'Note'],
        rows: o.list.slice(0, env.topN).map((p) => [p.url, p.crawledInThisCrawl ? 'yes' : 'no', p.firstSource, p.note]),
        totalRows: o.total,
      });
    }
  }
  notes.push(o.coverageNote);
  env.data.internalLinks = {
    crawlId: crawl.id,
    destinations: v.destinationCount,
    suggestions: v.searched ? v.totalSuggestions : null,
    potentialOrphans: o.crawl && o.coverageComplete ? o.total : null,
    coverageComplete: o.coverageComplete,
  };
  return section('internal_links', title, { claims, tables, notes });
}

// ---------------------------------------------------------------- AEO (monthly)

type Counts = Record<AeoCheckStatus, number>;
type CheckKey = 'answer' | 'headings' | 'sections' | 'evidence';
type CheckView = { status: AeoCheckStatus; summary: string };

/** AEO data from any source, normalized (pages may be a bounded list of the assessed pages). */
interface AeoView {
  crawlId: string | null;
  pages: Array<{ url: string; resultId: string; fetchedAt: string; isSynthetic: boolean; checks: Record<CheckKey, CheckView>; eligibility: { crawl: string; indexing: string; snippet: string; aiFeatures: string } | null }>;
  /** Pages assessed in total (>= pages.length when the list is bounded). */
  assessed: number;
  /** Fetched pages of the crawl not assessed (limit). */
  notAssessed: number;
  synthetic: boolean;
  unavailableReason: string | null;
}

function viewFromAssessment(a: AeoSiteAssessment): AeoView {
  return {
    crawlId: a.crawlId,
    pages: a.pages.map((p) => ({
      url: p.url,
      resultId: p.resultId,
      fetchedAt: p.fetchedAt,
      isSynthetic: p.isSynthetic,
      checks: { answer: p.answer, headings: p.headings, sections: p.sections, evidence: p.evidence },
      eligibility: p.eligibility,
    })),
    assessed: a.pages.length,
    notAssessed: a.notAssessed,
    synthetic: a.pages.some((p) => p.isSynthetic),
    unavailableReason: null,
  };
}

function aeoViewFromSiteStructure(s: SiteStructureSummary): AeoView {
  const a = s.aeo;
  const listed = a.pages.length;
  return {
    crawlId: a.crawlId ?? s.crawl?.id ?? null,
    pages: a.pages.map((p) => ({ url: p.url, resultId: p.resultId, fetchedAt: p.fetchedAt, isSynthetic: p.isSynthetic, checks: p.checks, eligibility: p.eligibility })),
    assessed: a.assessed,
    notAssessed: Math.max(0, a.notAssessed - Math.max(0, a.assessed - listed)),
    synthetic: s.synthetic,
    // Stated by the stage when the checks were not run (for example they failed); null when they ran.
    unavailableReason: listed || a.crawlId ? null : s.notes.find((n) => /AEO/.test(n)) ?? 'the page-level AEO checks were not assessed in this run',
  };
}

const CHECKS: Array<{ key: CheckKey; label: string }> = [
  { key: 'answer', label: 'Clear answers' },
  { key: 'headings', label: 'Descriptive headings' },
  { key: 'sections', label: 'Self-contained sections' },
  { key: 'evidence', label: 'Useful evidence' },
];

function countStatuses(pages: AeoView['pages'], key: CheckKey): Counts {
  const c: Counts = { ok: 0, review: 0, unknown: 0 };
  for (const p of pages) c[p.checks[key].status]++;
  return c;
}

function fmtCounts(c: Counts): string {
  return `${c.ok} ok, ${c.review} to review, ${c.unknown} unknown`;
}

export function aeoSection(env: BuildEnv, provided?: AeoSiteAssessment | null, siteStructure?: SiteStructureSummary | null): ReportSection {
  const { ctx } = env;
  const title = 'AI-search readiness (page-level AEO heuristics)';
  const notes = [
    `${AEO_LABEL}: deterministic editorial checks over the stored crawl snapshot (${AEO_VERSION}); not Google ranking rules and not a prediction of AI citations, featured snippets, or rich results. Phrase patterns are English and under-report on other languages.`,
  ];
  const metricIds = ['aeo.heuristic_checks'];
  const factual = unavailable(
    'aeo.factual_consistency',
    'Factual consistency of published pages is not assessed.',
    'the page-level AEO checks are deterministic heuristics over crawl text and do not verify facts; new drafts are checked by the content quality gates before review',
    { metricIds },
  );
  if (provided === null) {
    return section('aeo', title, { claims: [unavailable('aeo.pages', 'Page-level AEO assessment: DATA UNAVAILABLE (not collected for this report).', NOT_COLLECTED_REASON, { metricIds }), factual], notes });
  }
  const v = provided ? viewFromAssessment(provided) : siteStructure ? aeoViewFromSiteStructure(siteStructure) : viewFromAssessment(assessAeoForSite(ctx, { limit: AEO_PAGE_LIMIT }));
  if (!v.crawlId) {
    env.data.aeo = { crawlId: null, version: AEO_VERSION, pagesAssessed: 0, notAssessed: 0 };
    return section('aeo', title, { claims: [unavailable('aeo.pages', 'Page-level AEO assessment: DATA UNAVAILABLE (no own-site crawl).', NO_CRAWL_REASON, { metricIds }), factual], notes });
  }
  const crawlId = v.crawlId;
  const synthetic = (v.crawlId ? crawlSynthetic(env, v.crawlId) : false) || v.synthetic || v.pages.some((p) => p.isSynthetic);
  if (v.synthetic) markSynthetic(env, 'crawls', true);
  if (!v.pages.length) {
    env.data.aeo = { crawlId, version: AEO_VERSION, pagesAssessed: 0, notAssessed: v.notAssessed };
    return section('aeo', title, {
      claims: [
        v.unavailableReason
          ? unavailable('aeo.pages', 'Page-level AEO assessment: DATA UNAVAILABLE (not assessed in this run).', v.unavailableReason, { metricIds, synthetic })
          : unavailable('aeo.pages', 'Page-level AEO assessment: DATA UNAVAILABLE (no assessable page).', `own-site crawl ${crawlId} has no successfully fetched HTML page with stored text`, { metricIds, synthetic }),
        factual,
      ],
      notes,
    });
  }
  const pages = v.pages;
  const n = pages.length;
  const counts = Object.fromEntries(CHECKS.map((c) => [c.key, countStatuses(pages, c.key)])) as Record<CheckKey, Counts>;
  const fetched = [...new Set(pages.map((p) => p.fetchedAt))].sort();
  const sourceIds = [`crawls:${crawlId}`, ...pages.slice(0, 20).map((p) => `crawl_results:${p.resultId}`)];
  const evidence = [recordLink('crawls', crawlId, `own-site crawl ${crawlId}`), dbQueryLink('crawl_results', { site_id: ctx.siteId, crawl_id: crawlId })];
  const scope = v.assessed > n ? `${n} listed of ${v.assessed} assessed page(s)` : `${n} page(s)`;
  const claims: Claim[] = [
    inferred('aeo.pages', `${scope} of own-site crawl ${crawlId} assessed with deterministic AEO heuristics (${AEO_VERSION}): ${CHECKS.map((c) => `${c.label.toLowerCase()} ${fmtCounts(counts[c.key])}`).join('; ')}.`, {
      sourceIds,
      retrievedAt: fetched.slice(-3),
      metricIds,
      evidence,
      synthetic,
    }),
    factual,
  ];
  if (counts.answer.unknown) notes.push(`Clear answers are "unknown" for ${counts.answer.unknown} page(s): they are checked against the page's top visible Search Console queries, and pages without query rows (or without stored text) cannot be checked.`);
  if (v.notAssessed) notes.push(`${v.notAssessed} further fetched page(s) of the crawl were not assessed (per-report limit); run \`npm run cli -- crawl aeo\` for the full list.`);

  const known = pages.map((p) => p.eligibility).filter((e): e is NonNullable<typeof e> => !!e);
  const noindex = known.filter((e) => e.indexing === 'blocked_by_noindex').length;
  const snipBlocked = known.filter((e) => e.snippet === 'blocked').length;
  const snipLimited = known.filter((e) => e.snippet === 'limited').length;
  const aiNot = known.filter((e) => e.aiFeatures === 'not_eligible').length;
  const eligUnknown = n - known.length + known.filter((e) => e.indexing === 'unknown').length;
  const robotsBlocked = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM crawl_results WHERE site_id = ? AND crawl_id = ? AND (robots_allowed = 0 OR blocked_reason = 'robots')", [ctx.siteId, crawlId])?.n ?? 0;
  claims.push(
    observed(
      'aeo.eligibility',
      `Crawl/index/snippet eligibility of the ${scope}, from observed crawl signals: noindex on ${noindex}; snippets blocked (nosnippet or max-snippet:0) on ${snipBlocked}; snippet length limited on ${snipLimited}; not eligible for AI features on ${aiNot}; unknown on ${eligUnknown}. ${robotsBlocked} URL(s) of this crawl were blocked by robots.txt and could not be assessed. No blocking directive does not mean a page is indexed.`,
      { sourceIds, retrievedAt: fetched.slice(-3), evidence, synthetic },
    ),
  );

  const status = (s: AeoCheckStatus) => (s === 'review' ? 'REVIEW' : s);
  const ordered = pages.slice().sort((a, b) => CHECKS.filter((c) => b.checks[c.key].status === 'review').length - CHECKS.filter((c) => a.checks[c.key].status === 'review').length || a.url.localeCompare(b.url));
  const tables: ReportTable[] = [
    {
      id: 'aeo.pages',
      title: 'Page-level AEO checks (heuristic; pages with the most review items first)',
      columns: ['Page', 'Clear answers', 'Headings', 'Sections', 'Evidence', 'Factual consistency', 'Indexing', 'Snippet', 'AI features'],
      rows: ordered.slice(0, env.topN).map((p) => [p.url, status(p.checks.answer.status), status(p.checks.headings.status), status(p.checks.sections.status), status(p.checks.evidence.status), 'not assessed', p.eligibility?.indexing ?? 'unknown', p.eligibility?.snippet ?? 'unknown', p.eligibility?.aiFeatures ?? 'unknown']),
      totalRows: n,
    },
  ];
  const findings = ordered.flatMap((p) => CHECKS.filter((c) => p.checks[c.key].status === 'review').map((c) => [p.url, c.label, p.checks[c.key].summary] as [string, string, string]));
  if (findings.length) tables.push({ id: 'aeo.review', title: 'What to review', columns: ['Page', 'Check', 'Finding (heuristic)'], rows: findings.slice(0, env.topN), totalRows: findings.length });
  env.data.aeo = {
    crawlId,
    version: AEO_VERSION,
    pagesAssessed: v.assessed,
    notAssessed: v.notAssessed,
    counts,
    eligibility: { noindex, snippetBlocked: snipBlocked, snippetLimited: snipLimited, aiFeaturesNotEligible: aiNot, unknown: eligUnknown, robotsBlocked },
  };
  return section('aeo', title, { claims, tables, notes });
}
