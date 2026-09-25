/**
 * Apify integration: generic API v2 client + typed adapter for the Reddit
 * Scraper actor `9sHOY9RzPYGjmTHo8`. See docs/modules/apify.md.
 */
export { ApifyClient, ApifyApiError, ApifyTransportError, APIFY_API_BASE, createApifyClient, type ApifyClientOptions } from './client.js';
export {
  inspectActor,
  importActorSchema,
  resolveRunnableSchema,
  storeActorSchema,
  findSchemaForBuild,
  listStoredSchemas,
  isBuildNumber,
  readmeProvenance,
  diffReadmeProvenance,
  missingRequiredOutputFields,
  README_PASSAGES,
  REQUIRED_OUTPUT_FIELDS,
  type BuildProvenance,
  type ReadmeProvenance,
  type ReadmeDrift,
  type InspectResult,
  type ImportResult,
  type RunnableSchema,
  type StoredActorSchema,
} from './schema.js';
export { parseInputSchema, inputSchemaHash, diffInputSchemas, validateInputAgainstSchema, detectSchemaDocument, type ActorInputSchema } from './input-schema.js';
export {
  REDDIT_SCRAPER_ACTOR_ID,
  buildRedditInput,
  analyzeSchemaForAdapter,
  scanInputForSecrets,
  collectSensitiveValues,
  type RedditResearchRequest,
  type BuiltRedditInput,
} from './reddit-adapter.js';
export { estimateRunCost, selectCurrentPricing, chargeFromEventCounts, chargeRangeFromEventCounts, type PricingRecord, type RunCostEstimate } from './pricing.js';
export {
  normalizeDatasetItems,
  classifySignal,
  heuristicClassify,
  llmSignalClassifier,
  verifiedCustomerPhrase,
  persistSignals,
  signalOccurrences,
  minimizePersonalData,
  REDDIT_LIMITATIONS,
  SIGNAL_TYPES,
  type SignalType,
  type SignalClassifier,
  type NormalizedRedditItem,
  type LlmClassifierOutcome,
} from './normalize.js';
export {
  runContentResearch,
  resumeApifyRuns,
  confirmNotAccepted,
  listApifyRuns,
  summarizeRun,
  ingestSyntheticDataset,
  planContentResearchBatch,
  runContentResearchBatch,
  outputSchemaDrift,
  KNOWN_DATA_TYPES,
  COMMUNITY_NAME_RE,
  earliestDateFor,
  TIME_RANGE_ORDER,
  type CapPolicy,
  type ConfirmNotAcceptedResult,
  type ContentResearchOptions,
  type ContentResearchResult,
  type ApifyRuntimeOptions,
  type RunPlan,
  type ResumeReport,
  type ResearchBatchOptions,
  type ResearchBatchResult,
  type ResearchBatchRun,
  type ResearchStatus,
} from './runs.js';
export { apifyStatus, APIFY_SENDS_EXTERNALLY } from './status.js';
