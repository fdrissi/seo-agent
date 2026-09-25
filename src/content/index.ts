/**
 * Content farming pipeline (research-to-value). See docs/modules/content.md.
 *
 * DISCOVER -> DEDUPLICATE -> CLASSIFY -> CLUSTER -> VALIDATE DEMAND ->
 * CHECK EXISTING CONTENT -> PRIORITIZE -> BRIEF -> DRAFT -> QUALITY GATES ->
 * HUMAN REVIEW -> EXPORT/PUBLISH WHEN AUTHORIZED -> MEASURE
 */
export * from './types.js';
export { depsFor, registerContentDepsFactory, resolveContentDeps, type ContentDeps, type ContentDepsFactory, type ContentDepsSource, type DependencyStatus, type PublicationBindingInfo, type PublicationProposalResolver } from './deps.js';
export { discoverSignals, type DiscoverOptions } from './signals.js';
export { normalizeWindow } from './store.js';
export { importManualQuestions, parseCsv, parseImportContent, scrubPersonalData, type ImportResult } from './import.js';
export { dedupeSignals } from './dedup.js';
export { classifyByRules, classifyCandidates, CLASSIFY_PROMPT_ID, contentBrandAnalyzer } from './classify.js';
export { clusterCandidates, pairSimilarity, agglomerate, type ClusterOptions } from './cluster.js';
export { computeDemand, validateDemand, demandSummaryLines } from './demand.js';
export { checkExistingAndDecide, computeOverlap, decide, holdForObservation, isBrandedItem, loadSitePages } from './existing.js';
export { assertNotUnderObservation, observationHint, observationHold, type ObservationHold } from './freeze.js';
export { compareForPriority, prioritizeItems, productionCapacity, scoreItem, segmentOf, SCORING_VERSION } from './prioritize.js';
export { assertBriefable, BRIEF_PROMPT_ID, briefHash, buildDeterministicBrief, createBrief, isOriginalValueEvidence, runBriefGate, type BriefOptions, type BriefResult } from './brief.js';
export { assertDraftReady, checkDraftPreconditions, DRAFT_PROMPT_ID, DraftNeedsReviewError, DraftRefusedError, generateDraft, markUnresolved, reviseDraft, verifyBatchAuthorization, writerFailure, type BatchDraftAuthorization, type DraftModelReview, type DraftOptions } from './draft.js';
export { computeVerdict, draftNumberSources, draftQuote, loadQualityInputs, redditContextTexts, REVIEW_PROMPT_ID, runAiReview, runDeterministicChecks } from './quality.js';
export { STRUCTURED_DATA_REQUIREMENTS, STRUCTURED_DATA_REQUIREMENTS_VERSION, structuredDataPromptRules, structuredDataRequirement, type StructuredDataRequirement } from './structured-data-requirements.js';
export { draftAndReview, reviewDraft, reviewRefusal, reviewSiblings, reviewWithRevisions, REVIEWABLE_DRAFT_STATUSES, storedReviewResult } from './review.js';
export { batchIdentity, expansionIdentity, PILOT_SIZE, runBatchDrafts } from './batch.js';
export { checkPublicationGate, markHumanReviewed, measurePublishedContent, publicationBinding, type PublicationBinding, type PublicationGateResult } from './publication.js';
export { detectLowData, readinessChecks, runLowDataBootstrap, NO_CONVERSION_HISTORY_STATEMENT, type BootstrapPage, type BootstrapResult } from './bootstrap.js';
export { conversionHistory, type ConversionHistory } from './conversion-history.js';
export { briefNote, contentItemNote, draftNote, pipelineNote, wikilink } from './notes.js';
export { internalLinkSuggestionLine, isInternalLinkSuggestion, NO_STRUCTURED_DATA_PROPOSAL, type PackageLineFormat } from './package-notes.js';
export { CONTENT_WORKFLOW, contentStageAllowances, createContentProductionStages, createContentResearchStages, PRODUCTION_STAGE_NAMES, type ContentProductionStageOptions, type ContentStageDefinition, type ContentStageOptions, type ProductionStageName } from './stages.js';
export { runContentResearch, runStagesSequentially } from './pipeline.js';
