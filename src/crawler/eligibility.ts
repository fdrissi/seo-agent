import type { AppContext } from '../app/context.js';
import { parseJson } from '../database/db.js';
import type { RobotsDirectives } from './extract.js';

/**
 * Crawl / index / snippet eligibility from OBSERVED crawl signals only
 * (spec section 17, AEO). It reports blockers that were seen; the absence of
 * a blocker is reported as "no blocking directive observed", never as
 * "indexed" (HTTP 200 does not prove indexing; use URL Inspection for
 * Google's indexed state). Per Google's documentation, nosnippet and
 * max-snippet:0 also prevent use as direct input to AI Overviews / AI Mode,
 * and there are no special AI-specific files or markup requirements.
 */

export interface SearchEligibility {
  crawl: 'allowed' | 'blocked_by_robots_txt' | 'blocked_access' | 'not_fetched';
  indexing: 'blocked_by_noindex' | 'no_blocking_directive_observed' | 'unknown';
  snippet: 'blocked' | 'limited' | 'no_restriction_observed' | 'unknown';
  aiFeatures: 'not_eligible' | 'limited' | 'no_restriction_observed' | 'unknown';
  reasons: string[];
  caveat: string;
}

export const ELIGIBILITY_CAVEAT = 'Based on observed crawl signals only. No blocking directive does not mean the page is indexed or will be shown; use URL Inspection for indexed-state information.';

export function assessSearchEligibility(input: { robotsAllowed: boolean | null; statusCode: number | null; blockedReason: string | null; robots: RobotsDirectives | null }): SearchEligibility {
  const reasons: string[] = [];
  let crawl: SearchEligibility['crawl'] = 'allowed';
  if (input.robotsAllowed === false || input.blockedReason === 'robots') {
    crawl = 'blocked_by_robots_txt';
    reasons.push('robots.txt disallows crawling (page content cannot be read by compliant crawlers).');
  } else if (input.blockedReason === 'login_required' || input.blockedReason === 'access_denied') {
    crawl = 'blocked_access';
    reasons.push(`Access barrier observed (${input.blockedReason}).`);
  } else if (input.statusCode === null || input.blockedReason) {
    crawl = 'not_fetched';
    reasons.push(`Not fetched in this crawl${input.blockedReason ? ` (${input.blockedReason})` : ''}.`);
  }
  const fetchedOk = crawl === 'allowed' && input.statusCode !== null && input.statusCode >= 200 && input.statusCode < 300;
  let indexing: SearchEligibility['indexing'] = 'unknown';
  let snippet: SearchEligibility['snippet'] = 'unknown';
  let aiFeatures: SearchEligibility['aiFeatures'] = 'unknown';
  if (fetchedOk && input.robots) {
    const r = input.robots;
    indexing = r.noindex ? 'blocked_by_noindex' : 'no_blocking_directive_observed';
    if (r.noindex) reasons.push(`noindex observed (${r.sources.join(', ')}).`);
    if (r.nosnippet || r.maxSnippet === 0) {
      snippet = 'blocked';
      reasons.push('nosnippet / max-snippet:0 observed: no text snippet and no direct use in AI Overviews / AI Mode.');
    } else if (r.maxSnippet !== null && r.maxSnippet > 0) {
      snippet = 'limited';
      reasons.push(`max-snippet:${r.maxSnippet} limits snippet length (and direct input to AI features).`);
    } else snippet = 'no_restriction_observed';
    aiFeatures = r.noindex || snippet === 'blocked' ? 'not_eligible' : snippet === 'limited' ? 'limited' : 'no_restriction_observed';
  } else if (fetchedOk) {
    reasons.push('No extraction available for this result.');
  } else if (input.statusCode !== null && (input.statusCode < 200 || input.statusCode >= 300)) {
    reasons.push(`HTTP ${input.statusCode} observed.`);
  }
  return { crawl, indexing, snippet, aiFeatures, reasons, caveat: ELIGIBILITY_CAVEAT };
}

/** Eligibility for one stored crawl result of this site. */
export function searchEligibilityForResult(ctx: AppContext, resultId: string): SearchEligibility | null {
  const row = ctx.db.get<{ robots_allowed: number | null; status_code: number | null; blocked_reason: string | null; extraction_json: string | null }>(
    'SELECT robots_allowed, status_code, blocked_reason, extraction_json FROM crawl_results WHERE id = ? AND site_id = ?',
    [resultId, ctx.siteId],
  );
  if (!row) return null;
  const extra = parseJson<{ robots?: RobotsDirectives }>(row.extraction_json, {});
  return assessSearchEligibility({
    robotsAllowed: row.robots_allowed === null ? null : row.robots_allowed === 1,
    statusCode: row.status_code,
    blockedReason: row.blocked_reason,
    robots: extra.robots ?? null,
  });
}
