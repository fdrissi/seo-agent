/**
 * LLM integration entry point. Import from here when wiring the application:
 *
 *   createLlmClient(ctx, { fetch?, approvals? })  live LLM Gateway client (LlmClient); pass the
 *                                         ApprovalGate so unknown-price approvals can be verified
 *   createFixtureLlmClient(handlers)      deterministic SYNTHETIC client (demo/tests)
 *   discoverModels(ctx)                   free, cached GET /v1/models capability discovery
 *   llmStatus(ctx, { network })           honest IntegrationStatus (never chargeable)
 */
export * from './types.js';
export {
  createLlmClient,
  GatewayLlmClient,
  extractJson,
  validateOutput,
  decodeEmbeddings,
  approvalRequestHash,
  paidRequestArtifactHash,
  DEFAULT_PAID_REQUEST_TIMEOUT_MS,
  GATEWAY_NON_STREAMING_TIMEOUT_MS,
  type GatewayClientOptions,
  type LlmPaidEndpoint,
} from './gateway.js';
export { createFixtureLlmClient, FixtureLlmClient, hashEmbedding, FIXTURE_MODEL, FIXTURE_EMBEDDING_MODEL, type FixtureHandler, type FixtureRequestView } from './fixture-client.js';
export {
  discoverModels,
  loadCachedCatalog,
  findModel,
  checkConfiguredModels,
  getKeyInfo,
  parseModelsResponse,
  deriveCapabilities,
  type ModelCapabilities,
  type ModelCatalog,
  type DiscoveryResult,
  type ConfiguredModelCheck,
  type KeyInfo,
} from './models.js';
export { llmStatus, LLM_SENDS_EXTERNALLY, type LlmStatusDetail } from './status.js';
export { PromptRegistry, parsePromptTemplate, renderPrompt, promptVersionString, type PromptTemplate } from './prompts.js';
export { buildChatBody, decideResponseFormat, zodToJsonSchema, type ResponseFormatMode, type ReasoningEffort } from './params.js';
export { resolvePrices, estimateChatCost, estimateEmbeddingCost, actualChatCost, perTokenPriceToMicrosPerMillion } from './pricing.js';
export { listLlmCalls, type LlmCallRow } from './records.js';
export { planLlmCost, type LlmCostPlan, type LlmCostPlanItem } from './plan.js';
export { estimateTokens, renderEvidenceBundle, describeReviewCoverage } from '../../security/untrusted.js';
