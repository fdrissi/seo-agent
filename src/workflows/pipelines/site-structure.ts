import { z } from 'zod';
import type { AppContext } from '../../app/context.js';
import { errorMessage } from '../../core/errors.js';
import { NO_RETRY } from '../../core/retry.js';
import { assessAeoForSite, type AeoSiteAssessment } from '../../crawler/aeo.js';
import { configuredGscScope } from '../../seo/coverage.js';
import { buildSiteStructureSummary, siteStructureSchema, topGscPageDestinations, type SiteStructureDestination, type SiteStructureSummary } from '../../seo/site-structure.js';
import { defineStage, type EngineStage } from '../stage.js';
import { note, noteSchema, type StageNote } from './common.js';

/**
 * Weekly `site_structure` stage (spec sections 17 and 19): internal-link
 * suggestions for this run's candidate pages, potential orphans relative to
 * the known crawl coverage, and page-level heuristic AEO checks of the latest
 * own-site crawl, handed to the report. Free and read-only: it reads stored
 * crawl results and never fetches, spends, or changes anything.
 */

/** Routes whose pages are link destinations (optimization and discovery; never measurement/technical prerequisites). */
export const LINK_DESTINATION_ROUTES: ReadonlySet<string> = new Set(['RANKING_OPPORTUNITY', 'CTR_OPPORTUNITY', 'CONVERSION_OPPORTUNITY', 'CONTENT_OPPORTUNITY', 'DECLINE', 'INDEXING_UNKNOWN']);
export const SITE_STRUCTURE_MAX_DESTINATIONS = 10;
export const SITE_STRUCTURE_AEO_LIMIT = 50;

interface Candidate {
  route: string;
  pageId?: string | null;
  url: string | null;
  score: number | null;
}

/** Link destinations: this run's candidate pages (best score first), else the top Search Console pages. */
export function linkDestinations(app: AppContext, candidates: readonly Candidate[], max = SITE_STRUCTURE_MAX_DESTINATIONS): SiteStructureDestination[] {
  const out: SiteStructureDestination[] = [];
  const seen = new Set<string>();
  const ranked = candidates.filter((c) => LINK_DESTINATION_ROUTES.has(c.route) && c.pageId && c.url).sort((a, b) => (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY));
  for (const c of ranked) {
    if (out.length >= max) break;
    if (seen.has(c.pageId!)) continue;
    seen.add(c.pageId!);
    out.push({ pageId: c.pageId!, url: c.url!, origin: 'candidate' });
  }
  if (out.length) return out;
  return topGscPageDestinations(app.db, app.siteId, configuredGscScope(app.config), max);
}

export const siteStructureOutput = z.object({ summary: siteStructureSchema, note: noteSchema });
export type SiteStructureOutput = z.infer<typeof siteStructureOutput>;

/** Honest stage note: no crawl or a partial crawl degrades the stage (with a next step); nothing is estimated. */
export function siteStructureNote(s: SiteStructureSummary, aeoError: string | null): StageNote {
  if (!s.crawl) return note('degraded', 'No completed or partial own-site crawl: internal-link suggestions, potential orphans, and page-level AEO checks are unavailable.', 'CRAWL_MISSING', 'Run the own-site crawl (`npm run cli -- crawl`, or keep the crawl_site stage enabled) and rerun the weekly job.');
  const problems: string[] = [];
  if (!s.orphans.coverageComplete) problems.push(`crawl ${s.crawl.id} was ${s.crawl.status}${s.crawl.stopReason ? ` (${s.crawl.stopReason})` : ''}: orphan status is not assessable for ${s.orphans.notAssessable} page(s) outside the known coverage`);
  if (aeoError) problems.push(`page-level AEO checks failed: ${aeoError}`);
  if (!problems.length) return null;
  return note('degraded', `Site structure: ${problems.join('; ')}.`, !s.orphans.coverageComplete ? 'CRAWL_PARTIAL' : 'AEO_UNAVAILABLE', !s.orphans.coverageComplete ? 'A complete crawl (frontier exhausted within crawl.maxPages / crawl.maxDepth) is needed to call a page a potential orphan; raise the crawl limits if the site is larger.' : null);
}

export function siteStructureStage(next: string, prerequisites: string[], optionalPrerequisites: string[] = []): EngineStage {
  return defineStage({
    name: 'site_structure',
    version: 'site_structure@1',
    description:
      'Internal-link suggestions (source page, destination, passage, proposed anchor, reason) for this run\'s candidate pages, potential orphans relative to the known crawl coverage, and page-level heuristic AEO checks of the latest own-site crawl, for the report (free; reads stored crawl results only).',
    input: z.object({ destinations: z.array(z.object({ pageId: z.string(), url: z.string(), origin: z.enum(['candidate', 'top_gsc_page', 'provided']).optional() })), aeoLimit: z.number().int().min(1).max(500) }),
    output: siteStructureOutput,
    prerequisites,
    optionalPrerequisites,
    evidence: { requirement: 'A completed or partial own-site crawl (stored results, extracted text, internal links); this run\'s scored candidates as link destinations.' },
    timeoutMs: 5 * 60_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    optional: true,
    stoppingConditions: ['Never stops the workflow: without a crawl the section is stated as unavailable (degraded), never estimated.'],
    next: [next],
    buildInput: (sctx) => {
      const route = sctx.prior.route_and_score as { candidates?: Candidate[] } | undefined;
      return { destinations: linkDestinations(sctx.app, route?.candidates ?? []), aeoLimit: SITE_STRUCTURE_AEO_LIMIT };
    },
    run: async (input, sctx): Promise<SiteStructureOutput> => {
      const app = sctx.app;
      let aeo: AeoSiteAssessment | null = null;
      let aeoError: string | null = null;
      try {
        aeo = assessAeoForSite(app, { limit: input.aeoLimit });
      } catch (err) {
        aeoError = errorMessage(err).slice(0, 300);
      }
      const summary = buildSiteStructureSummary(app.db, app.raw, app.siteId, {
        destinations: input.destinations,
        aeo,
        aeoUnavailableReason: aeoError,
        now: app.clock.now(),
        syntheticContext: app.synthetic,
      });
      return { summary, note: siteStructureNote(summary, aeoError) };
    },
  });
}
