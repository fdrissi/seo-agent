import { z } from 'zod';
import type { AeoSiteAssessment } from '../crawler/aeo.js';
import type { Db } from '../database/db.js';
import { activeGscScope, type ConfiguredGscScope } from './coverage.js';
import type { TextStore } from './crawl-data.js';
import { findPotentialOrphans, latestOwnCrawl, suggestInternalLinks, INTERNAL_LINKS_VERSION, type DestinationSpec } from './internal-links.js';

/**
 * Report-ready site-structure summary (spec sections 17 and 19) built from the
 * latest own-site crawl:
 * - internal-link suggestions {sourcePage, destination, passage,
 *   proposedAnchor, reason} for the given destination pages (suggestions for
 *   human review: RECOMMENDATION);
 * - potential orphan pages, only relative to known crawl coverage (a partial
 *   crawl assesses nothing: those pages are "not assessable"); inbound
 *   internal-link counts are observations from one crawl, never an authority
 *   score (INFERRED);
 * - page-level AEO checks (clear answers, descriptive headings,
 *   self-contained sections, evidence, crawl/index/snippet eligibility) as
 *   assessed by `src/crawler/aeo.ts`: deterministic editorial HEURISTICS, not
 *   ranking rules and not a prediction of AI citations or rich results.
 *
 * Everything is bounded (reports never carry full datasets). A synthetic
 * (fixture/demo) crawl or context sets `synthetic`, so nothing here is ever
 * presented as an observation of a real site. Missing inputs are stated as
 * DATA_UNAVAILABLE, never as zero.
 */

export const SITE_STRUCTURE_VERSION = 'site-structure@1';
export const SITE_STRUCTURE_LIMITS = { suggestions: 20, perDestination: 3, orphans: 20, aeoPages: 20, notAssessableExamples: 5 } as const;
export const AEO_REPORT_CAVEAT = 'Editorial heuristics over the stored crawl snapshot (English phrase patterns under-report on other languages); not Google ranking rules and not a prediction that a page will be cited by an AI feature or shown as a rich result.';

const aeoCheck = z.object({ status: z.enum(['ok', 'review', 'unknown']), summary: z.string() });

export const siteStructureSchema = z.object({
  version: z.literal(SITE_STRUCTURE_VERSION),
  generatedAt: z.string(),
  /** Rests on a synthetic (fixture/demo) crawl or context: never presented as observed. */
  synthetic: z.boolean(),
  crawl: z
    .object({ id: z.string(), status: z.string(), pagesFetched: z.number(), pagesAttempted: z.number(), stopReason: z.string().nullable(), startedAt: z.string(), finishedAt: z.string().nullable(), synthetic: z.boolean() })
    .nullable(),
  internalLinks: z.object({
    claimLabel: z.enum(['RECOMMENDATION', 'DATA_UNAVAILABLE']),
    version: z.string(),
    destinations: z.array(z.object({ pageId: z.string(), url: z.string(), origin: z.enum(['candidate', 'top_gsc_page', 'provided']) })),
    suggestions: z.array(
      z.object({
        sourcePage: z.object({ pageId: z.string().nullable(), url: z.string() }),
        destination: z.object({ pageId: z.string(), url: z.string() }),
        passage: z.string(),
        proposedAnchor: z.string(),
        reason: z.string(),
        phraseOrigin: z.string(),
        crawlId: z.string(),
      }),
    ),
    /** Suggestions found before bounding to the report limit. */
    totalSuggestions: z.number(),
    skippedSources: z.number(),
    note: z.string(),
  }),
  orphans: z.object({
    claimLabel: z.enum(['INFERRED', 'DATA_UNAVAILABLE']),
    coverageComplete: z.boolean(),
    potentialOrphans: z.array(z.object({ pageId: z.string(), url: z.string(), firstSource: z.string(), crawledInThisCrawl: z.boolean(), note: z.string() })),
    totalPotentialOrphans: z.number(),
    notAssessable: z.number(),
    notAssessableExamples: z.array(z.string()),
    coverageNote: z.string(),
    metricNote: z.string(),
  }),
  aeo: z.object({
    claimLabel: z.enum(['INFERRED', 'DATA_UNAVAILABLE']),
    label: z.literal('HEURISTIC'),
    version: z.string().nullable(),
    crawlId: z.string().nullable(),
    /** Pages of the crawl that were assessed. */
    assessed: z.number(),
    /**
     * Fetched pages of the crawl without a listed assessment: beyond the
     * assessment limit, plus assessed pages left out of `pages` by the report
     * bound (`omittedFromReport`); the crawl-limit part is
     * `notAssessed - omittedFromReport`.
     */
    notAssessed: z.number(),
    /** Assessed pages left out of `pages` by the report bound (pages needing review come first). */
    omittedFromReport: z.number(),
    pages: z.array(
      z.object({
        url: z.string(),
        title: z.string().nullable(),
        resultId: z.string(),
        fetchedAt: z.string(),
        isSynthetic: z.boolean(),
        counts: z.object({ ok: z.number(), review: z.number(), unknown: z.number() }),
        checks: z.object({ answer: aeoCheck, headings: aeoCheck, sections: aeoCheck, evidence: aeoCheck }),
        eligibility: z.object({ crawl: z.string(), indexing: z.string(), snippet: z.string(), aiFeatures: z.string(), reasons: z.array(z.string()) }).nullable(),
        caveats: z.array(z.string()),
      }),
    ),
    notes: z.array(z.string()),
    caveat: z.string(),
  }),
  /** What could not be assessed and why (stated, never hidden). */
  notes: z.array(z.string()),
});
export type SiteStructureSummary = z.infer<typeof siteStructureSchema>;

export type SiteStructureDestination = DestinationSpec & { origin?: 'candidate' | 'top_gsc_page' | 'provided' };

/**
 * Top pages by Search Console impressions (configured property and search
 * type, unsegmented current rows; never summed across properties), as link
 * destinations when a run has no candidate pages.
 */
export function topGscPageDestinations(db: Db, siteId: string, scope: ConfiguredGscScope | null, limit = 10): SiteStructureDestination[] {
  if (!scope) return [];
  return db
    .all<{ pageId: string; url: string }>(
      "SELECT p.id AS pageId, p.url FROM gsc_page_daily g JOIN pages p ON p.id = g.page_id AND p.site_id = g.site_id WHERE g.site_id = ? AND g.is_current = 1 AND g.segment_key = '' AND g.property = ? AND g.search_type = ? GROUP BY p.id, p.url ORDER BY SUM(g.impressions) DESC, p.url ASC LIMIT ?",
      [siteId, scope.property, scope.searchType, Math.max(1, limit)],
    )
    .map((r) => ({ pageId: r.pageId, url: r.url, origin: 'top_gsc_page' as const }));
}

export interface SiteStructureOptions {
  destinations: readonly SiteStructureDestination[];
  /** Page-level AEO assessment of the latest own-site crawl (src/crawler/aeo.ts `assessAeoForSite`); null when not assessed. */
  aeo: AeoSiteAssessment | null;
  /** A reason AEO was not assessed (stated in the summary). */
  aeoUnavailableReason?: string | null;
  gscScope?: ConfiguredGscScope | null;
  now: Date;
  /** The context is synthetic (demo profile). */
  syntheticContext?: boolean;
  limits?: Partial<Record<keyof typeof SITE_STRUCTURE_LIMITS, number>>;
}

export function buildSiteStructureSummary(db: Db, text: TextStore | null, siteId: string, opts: SiteStructureOptions): SiteStructureSummary {
  const limits: Record<keyof typeof SITE_STRUCTURE_LIMITS, number> = { ...SITE_STRUCTURE_LIMITS, ...(opts.limits ?? {}) };
  const notes: string[] = [];
  const crawlInfo = latestOwnCrawl(db, siteId);
  const crawlSynthetic = (id: string | null | undefined) => !!id && db.get<{ s: number }>('SELECT is_synthetic AS s FROM crawls WHERE site_id = ? AND id = ?', [siteId, id])?.s === 1;
  const crawl = crawlInfo ? { ...crawlInfo, synthetic: crawlSynthetic(crawlInfo.id) } : null;

  // Internal links: one crawl for suggestions and orphans (the latest own-site crawl).
  const seen = new Set<string>();
  const destinations = opts.destinations.filter((d) => (seen.has(d.pageId) ? false : (seen.add(d.pageId), true))).slice(0, 20);
  const gscScope = opts.gscScope === undefined ? activeGscScope(db, siteId) : opts.gscScope;
  const sugg = crawl && destinations.length ? suggestInternalLinks(db, text, siteId, { destinations: destinations.map(({ pageId, url, phrases }) => ({ pageId, url, ...(phrases ? { phrases } : {}) })), maxPerDestination: limits.perDestination, crawlId: crawl.id, gscScope }) : null;
  if (!crawl) notes.push('No completed or partial own-site crawl: internal-link suggestions, potential orphans, and AEO checks are unavailable (nothing is estimated).');
  else if (!destinations.length) notes.push('No destination pages (no candidate pages in this run and no Search Console page data): no internal-link suggestions were searched.');
  const internalLinks: SiteStructureSummary['internalLinks'] = {
    claimLabel: sugg ? 'RECOMMENDATION' : 'DATA_UNAVAILABLE',
    version: INTERNAL_LINKS_VERSION,
    destinations: destinations.map((d) => ({ pageId: d.pageId, url: d.url, origin: d.origin ?? 'provided' })),
    suggestions: (sugg?.suggestions ?? []).slice(0, limits.suggestions).map((s) => ({ sourcePage: s.sourcePage, destination: s.destination, passage: s.passage, proposedAnchor: s.proposedAnchor, reason: s.reason, phraseOrigin: s.phraseOrigin, crawlId: s.crawlId })),
    totalSuggestions: sugg?.suggestions.length ?? 0,
    skippedSources: sugg?.skipped.length ?? 0,
    note: sugg ? sugg.note : crawl ? 'No destination pages to suggest links for.' : 'No completed own-site crawl; run a crawl first. No suggestions were fabricated.',
  };

  const o = crawl ? findPotentialOrphans(db, siteId) : null;
  const orphans: SiteStructureSummary['orphans'] = {
    claimLabel: o?.crawl ? 'INFERRED' : 'DATA_UNAVAILABLE',
    coverageComplete: o?.coverageComplete ?? false,
    potentialOrphans: (o?.potentialOrphans ?? []).slice(0, limits.orphans).map((p) => ({ pageId: p.pageId, url: p.url, firstSource: p.firstSource, crawledInThisCrawl: p.crawledInThisCrawl, note: p.note })),
    totalPotentialOrphans: o?.potentialOrphans.length ?? 0,
    notAssessable: o?.notAssessable.length ?? 0,
    notAssessableExamples: (o?.notAssessable ?? []).slice(0, limits.notAssessableExamples).map((x) => x.url),
    coverageNote: o?.coverageNote ?? 'No completed own-site crawl: orphan status cannot be assessed.',
    metricNote: o?.metricNote ?? 'Internal-link counts are observations from one crawl; they are not an authority score.',
  };
  if (o?.crawl && !o.coverageComplete) notes.push(`Crawl ${o.crawl.id} was partial: no page is called a potential orphan; ${o.notAssessable.length} page(s) are not assessable (outside the known crawl coverage).`);

  const a = opts.aeo;
  if (!a) notes.push(`Page-level AEO checks were not assessed${opts.aeoUnavailableReason ? `: ${opts.aeoUnavailableReason}` : ''}.`);
  else for (const n of a.notes) notes.push(`AEO: ${n}`);
  const aeoPages = (a?.pages ?? []).slice(0, limits.aeoPages);
  const aeo: SiteStructureSummary['aeo'] = {
    claimLabel: aeoPages.length ? 'INFERRED' : 'DATA_UNAVAILABLE',
    label: 'HEURISTIC',
    version: aeoPages[0]?.version ?? null,
    crawlId: a?.crawlId ?? null,
    assessed: a?.pages.length ?? 0,
    notAssessed: (a?.notAssessed ?? 0) + Math.max(0, (a?.pages.length ?? 0) - aeoPages.length),
    omittedFromReport: Math.max(0, (a?.pages.length ?? 0) - aeoPages.length),
    pages: aeoPages.map((p) => ({
      url: p.url,
      title: p.title,
      resultId: p.resultId,
      fetchedAt: p.fetchedAt,
      isSynthetic: p.isSynthetic,
      counts: p.counts,
      checks: {
        answer: { status: p.answer.status, summary: p.answer.summary },
        headings: { status: p.headings.status, summary: p.headings.summary },
        sections: { status: p.sections.status, summary: p.sections.summary },
        evidence: { status: p.evidence.status, summary: p.evidence.summary },
      },
      eligibility: p.eligibility ? { crawl: p.eligibility.crawl, indexing: p.eligibility.indexing, snippet: p.eligibility.snippet, aiFeatures: p.eligibility.aiFeatures, reasons: p.eligibility.reasons.slice(0, 5) } : null,
      caveats: p.caveats.slice(0, 3),
    })),
    notes: a?.notes ?? [],
    caveat: AEO_REPORT_CAVEAT,
  };

  const synthetic = !!opts.syntheticContext || !!crawl?.synthetic || aeoPages.some((p) => p.isSynthetic) || (a?.crawlId ? crawlSynthetic(a.crawlId) : false);
  return siteStructureSchema.parse({ version: SITE_STRUCTURE_VERSION, generatedAt: opts.now.toISOString(), synthetic, crawl, internalLinks, orphans, aeo, notes });
}

