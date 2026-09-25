/**
 * Optional AI-citation monitoring (spec 17): explicit manual import, stored
 * observations, and summaries that keep mention, citation, click, and
 * conversion apart. See docs/modules/ai-citations.md.
 */
export {
  AI_CITATION_MATCHING_VERSION,
  brandMentionsIn,
  brandTerms,
  classifyObservation,
  normalizeHostname,
  ownCitedUrls,
  ownHostnames,
  parseCitedUrls,
  type BrandTerms,
  type CitedUrlParse,
  type ObservationClassification,
} from './matching.js';
export {
  AI_CITATION_IMPORT_VERSION,
  MAX_AI_CITATION_IMPORT_BYTES,
  MAX_AI_CITATION_IMPORT_ROWS,
  MAX_RESPONSE_CHARS,
  assertAiCitationsEnabled,
  importAiCitations,
  noonInZone,
  type AiCitationImportOptions,
  type AiCitationImportResult,
  type AiCitationImportRowError,
} from './import.js';
export {
  AI_CITATION_SEMANTICS,
  aiCitationSummary,
  listAiCitationChecks,
  resolveAiCitationPeriod,
  type AiCitationCheckView,
  type AiCitationEngineBreakdown,
  type AiCitationPeriod,
  type AiCitationSummary,
  type ListAiCitationOptions,
} from './summary.js';
export { AI_CITATION_API_NOT_IMPLEMENTED, aiCitationStatus, type AiCitationCollectorStatus, type AiCitationStatus } from './status.js';
