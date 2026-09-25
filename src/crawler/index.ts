/**
 * Public crawler API. See docs/modules/crawler.md.
 */
export { crawlSite, crawlPage, NON_HTML_EXTENSIONS, networkRetryStep, isDnsFailure, type CrawlSiteOptions, type CrawlSiteResult, type CrawlRunStatus, type CrawlPlan } from './crawl.js';
export {
  crawlCompetitorPages,
  loadCompetitorText,
  competitorDomain,
  approvedResearchDomains,
  isApprovedHost,
  normalizeDomainEntry,
  competitorVolatilityTtl,
  type CompetitorTarget,
  type CrawlCompetitorOptions,
  type CrawlCompetitorResult,
  type CompetitorPageOutcome,
  type CompetitorPageStatus,
  type CompetitorBlockedReason,
  type CompetitorFailureReason,
  type CompetitorCacheInfo,
} from './competitor.js';
export { runTechnicalChecks, resolvability, type TechnicalCheckSummary, TITLE_MIN_CHARS, TITLE_MAX_CHARS } from './checks.js';
export { fetchSafely, SafeFetcher, isLoginUrl, type FetchSafelyOptions, type SafeFetcherOptions, type HopDecision } from './fetch.js';
export { extractPage, isLoginBarrier, loginBarrierAssessment, parseRobotsDirectives, parseLinkHeader, parseJsonLd, countWords, type PageExtraction, type ExtractedLink, type ExtractedImage } from './extract.js';
export { fetchRobots, parseRobots, RobotsCache, RobotsPolicy, userAgentToken, originOf, isTransientRobotsFailure, TRANSIENT_ROBOTS_ERROR_CODES, type RobotsInfo } from './robots.js';
export { discoverSitemaps, parseSitemapXml, type SitemapDiscovery, type SitemapFileRecord } from './sitemaps.js';
export { TrapDetector, DEFAULT_TRAP_LIMITS, isCalendarLike, matchesPathPattern, type TrapLimits } from './traps.js';
export { renderPage, compareRawRendered, playwrightAvailability, defaultPlaywrightLoader, RENDER_DISCLAIMER, RENDER_LAUNCH_ARGS, type RenderResult, type RenderDiscrepancies, type PlaywrightLoader } from './render.js';
export { startGuardedProxy, type GuardedProxy, type GuardedProxyOptions, type GuardedProxyFactory } from './render-proxy.js';
export { createPinnedTransport, fetchLikeTransport, fixtureTransport, fixtureSiteTransport, type HttpTransport, type FixtureResponse } from './transport.js';
export { buildFetcher, buildGuard, type CrawlerDeps } from './deps.js';
export { crawlerStatus, type CrawlerStatusReport, type CrawlerIntegrationStatus } from './status.js';
export { scanForInjection, UNTRUSTED_NOTICE } from './untrusted.js';
export { simhash64, hammingDistance } from './similarity.js';
export type { BlockedReason, ContentKind, SafeFetchResult, RedirectHop, CrawlCounts } from './types.js';
export { assessSearchEligibility, searchEligibilityForResult, ELIGIBILITY_CAVEAT, type SearchEligibility } from './eligibility.js';
export {
  assessAeoPage,
  assessAeoForResult,
  assessAeoForUrl,
  assessAeoForSite,
  splitSections,
  AEO_LABEL,
  AEO_VERSION,
  type AeoAssessment,
  type AeoTextAssessment,
  type AeoPageInput,
  type AeoSiteAssessment,
  type AeoCheckStatus,
} from './aeo.js';
