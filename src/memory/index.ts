/** Public surface of the memory module (vector memory + hybrid retrieval). */
export * from './types.js';
export * from './memory-types.js';
export { CHUNKER_VERSION, chunkMarkdown, chunkerOptionsFromConfig, embeddingInput, type Chunk, type ChunkerOptions } from './chunker.js';
export { estimateTokens, truncateToTokens, TOKEN_ESTIMATOR_VERSION } from './tokens.js';
export { sanitizeForMemory, detectSecrets, containsSecret, redactPersonalIdentifiers, looksLikeRawMetrics } from './sanitize.js';
export { ingestDocument, markDocumentDeleted, purgeDocument, propagateMissing, type DocumentInput, type IngestOutcome, type MemoryCtx } from './documents.js';
export { ingestAll, type IngestSummary, type CollectOptions } from './collectors.js';
export { EmbeddingService, EmbeddingSpaceMismatchError, EmbeddingDimensionMismatchError, EmbeddingModelMismatchError, compareEmbeddingModels, collectionNameFor, type EmbeddingOptions, type EmbeddingTarget, type EmbedPartial } from './embeddings.js';
export { QdrantClient, QdrantError, MEMORY_PAYLOAD_INDEXES, QDRANT_VERIFIED_API_VERSION, type QdrantFilter, type MemoryPointPayload } from './qdrant.js';
export { Indexer, type IndexPlan, type IndexRunReport } from './indexer.js';
export { HybridRetriever, reciprocalRankFusion, buildFtsQuery, RRF_K, DEFAULT_TRUST_FACTORS, type MemorySearchResult, type RetrievalOptions } from './retrieval.js';
export { getOriginalEvidence, type OriginalEvidence } from './evidence.js';
export { createMemoryService, memoryStatus, createQdrantClient, MEMORY_SENDS_EXTERNALLY, type MemoryService, type MemoryServiceDeps, type MemoryStatusReport, type MemorySyncReport } from './service.js';
export { toEvidenceItems } from './evidence-items.js';
export { registerMemoryLlmFactory, resolveMemoryLlm } from './wiring.js';
