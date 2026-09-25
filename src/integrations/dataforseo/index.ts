/**
 * DataForSEO adapter (spec section 14). See docs/modules/dataforseo.md.
 *
 * Public surface:
 *   createDataForSeoClient(ctx, opts)              client (auth, host, allowlist, free GETs)
 *   researchShortlist(ctx, candidates, opts)       default process: GSC shortlist -> filter -> serious queries -> SERP -> competitor URLs
 *   researchSerps(ctx, queries, opts)              targeted SERP research for explicit queries
 *   researchKeywordVolumes(ctx, keywords, opts)    Google Ads search-volume ESTIMATES
 *   pollPendingTasks(ctx, opts)                    resume queued/ambiguous tasks (free GETs, never resubmits)
 *   dataforseoStatus(ctx, { network })             honest status; network check uses the free user_data endpoint
 *   callGatedEndpoint(ctx, client, input)          backlinks/Labs/AI-visibility: feature flag + approval
 *   query helpers (queries.ts)                     read paths that exclude sandbox data from real recommendations
 */
export {
  DATAFORSEO_HOSTS,
  DataForSeoClient,
  createDataForSeoClient,
  inspectDataForSeoSetup,
  type DataForSeoClientOptions,
  type DataForSeoMode,
  type DataForSeoSetup,
} from './client.js';
export { ENDPOINTS, GATED_PREFIXES, requireEndpoint, type EndpointSpec, type EndpointFamily } from './endpoints.js';
export { DataForSeoApiError, envelopeCost, mapStatusCode, parseEnvelope, type DfsEnvelope, type DfsTask } from './envelope.js';
export {
  DOCUMENTED_PRICES,
  DOCUMENTED_PRICE_MAX_AGE_DAYS,
  PRICE_KEYS,
  PRICE_KEY_ALIASES,
  PROVISIONAL_PRICES,
  PROVISIONAL_SAFETY_FACTOR,
  estimateSerpTask,
  estimateVolumeTask,
  pricingOverrideWarnings,
  pricingSummary,
  resolvePrice,
  type DfsCostEstimate,
  type PriceKey,
} from './pricing.js';
export { researchCacheKey } from './cache.js';
export { listLanguages, listLocations, resolveSearchSettings, type ResolvedSearchSettings } from './locations.js';
export {
  assertResearchRan,
  researchSerps,
  researchShortlist,
  type FilterReason,
  type QueryOutcome,
  type SerpResearchOptions,
  type SerpResearchResult,
  type ShortlistCandidate,
  type ShortlistOptions,
  type ShortlistResearchResult,
} from './research.js';
export { researchKeywordVolumes, VOLUME_LABEL, type KeywordVolumeOutcome, type VolumeOptions, type VolumeResearchResult } from './volume.js';
export { abandonAmbiguousTask, listTasks, pollPendingTasks, waitForTasks, type PollOptions, type PollSummary, type TaskListing } from './tasks.js';
export { dataforseoStatus, DATAFORSEO_SENDS_EXTERNALLY, type DataForSeoStatus } from './status.js';
export { callGatedEndpoint, type GatedCallInput, type GatedCallResult } from './gated.js';
export {
  assertUsableForRecommendations,
  competitorUrlsForQuery,
  keywordVolumeEstimates,
  latestOwnRank,
  latestSerpSnapshot,
  serpResultsForRecommendation,
  type SerpResultRow,
  type SerpSnapshotRow,
  type VolumeEstimate,
} from './queries.js';
export { createSyntheticDataForSeoFetch } from './synthetic.js';
export type { CompetitorUrl, CostPlan, PlanItem, TaskStatus } from './types.js';
