import type { AppContext } from '../app/context.js';
import { AppError, errorMessage } from '../core/errors.js';
import type { RetryPolicy } from '../core/retry.js';
import type { LlmClient } from '../integrations/llm/types.js';
import type { FetchLike, IntegrationState, IntegrationStatus, StatusCheckOptions } from '../integrations/types.js';
import { ingestAll, type CollectOptions, type IngestSummary } from './collectors.js';
import { ingestDocument, type DocumentInput, type IngestOutcome } from './documents.js';
import { EmbeddingService, type EmbeddingOptions } from './embeddings.js';
import { getOriginalEvidence, type OriginalEvidence } from './evidence.js';
import { Indexer, type IndexPlan, type IndexRunReport } from './indexer.js';
import type { MemorySearchQuery } from './memory-types.js';
import { QdrantClient, insecureApiKeyTransport, type QdrantHealth } from './qdrant.js';
import { HybridRetriever, type MemorySearchResult, type RetrievalOptions } from './retrieval.js';
import { readRetrievalState } from './state.js';
import type { MemoryRetriever, RetrievedChunk } from './types.js';
import { resolveMemoryLlm } from './wiring.js';

/**
 * Memory service facade: one per site context. Wires the Qdrant adapter
 * (fixed REST adapter over an injected FetchLike), the embedding service
 * (injected LlmClient), the indexer, and the hybrid retriever.
 */

export interface MemoryServiceDeps {
  /** LLM client used ONLY for embeddings. Null/undefined: full-text memory only (degraded, reported). */
  llm?: LlmClient | null;
  /** Fetch used for Qdrant only (defaults to ctx.fetch, which is offline in demo/offline mode). Never the crawler fetcher. */
  fetch?: FetchLike;
  /** Pre-built Qdrant client (tests/integration). */
  qdrant?: QdrantClient | null;
  qdrantRetryPolicy?: RetryPolicy;
  qdrantTimeoutMs?: number;
  embeddingOptions?: EmbeddingOptions;
  retrievalOptions?: RetrievalOptions;
  collectOptions?: CollectOptions;
}

export interface MemorySyncOptions {
  /** Allow paid embedding calls for chunks whose vectors are not cached. */
  allowPaid?: boolean;
  dryRun?: boolean;
  /** Skip collecting/ingesting documents; only index what is already in SQLite. */
  skipIngest?: boolean;
  /** Cap on new (paid) embeddings in this run. */
  maxEmbed?: number;
  signal?: AbortSignal;
}

export interface MemorySyncReport {
  ingest: IngestSummary | null;
  index: IndexRunReport;
}

export interface MemoryStatusReport {
  siteId: string;
  integration: IntegrationStatus;
  embeddings: {
    state: string;
    reason?: string;
    nextStep?: string;
    provider: string;
    model: string | null;
    dimensions: number | null;
    versionId: string | null;
    collection: string | null;
  };
  documents: { total: number; byStatus: Record<string, number>; bySourceType: Record<string, number> };
  chunks: { current: number; superseded: number; indexed: number; pending: number; failed: number };
  tombstones: { pending: number; propagated: number };
  cacheVectors: number;
  index: { lastSyncAt: string | null; lastReconcileAt: string | null; degraded: boolean; degradedReason: string | null } | null;
  retrieval: { lastMethod: string; degraded: boolean; degradedReason: string | null; updatedAt: string } | null;
  qdrant: {
    url: string;
    enabled: boolean;
    apiKeyConfigured: boolean;
    warnings: string[];
    health: QdrantHealth | null;
    collection: { name: string; exists: boolean; pointsCount: number | null; vectorSize: number | null } | null;
  };
  nextSteps: string[];
}

export interface MemoryService extends MemoryRetriever {
  readonly siteId: string;
  ingest(opts?: { dryRun?: boolean }): IngestSummary;
  ingestDocument(input: DocumentInput, opts?: { dryRun?: boolean }): IngestOutcome;
  plan(opts?: { full?: boolean }): IndexPlan;
  sync(opts?: MemorySyncOptions): Promise<MemorySyncReport>;
  search(q: MemorySearchQuery): Promise<MemorySearchResult>;
  rebuild(opts?: { allowPaid?: boolean; dryRun?: boolean; signal?: AbortSignal }): Promise<IndexRunReport>;
  reconcile(opts?: { dryRun?: boolean }): Promise<IndexRunReport & { orphanIds: string[]; missingIds: string[]; staleIds: string[] }>;
  status(opts: StatusCheckOptions): Promise<MemoryStatusReport>;
  getOriginalEvidence(chunk: RetrievedChunk | string): OriginalEvidence;
}

export const MEMORY_SENDS_EXTERNALLY = [
  'Qdrant (QDRANT_URL; localhost by default): embedding vectors plus a metadata payload (site id, document/chunk ids, source type, trust class, status, language, content hash, dates). Chunk text is NOT stored in Qdrant.',
  'Embedding provider through the LLM Gateway (only with an explicit --allow-paid flag or a budgeted workflow): chunk text after secret rejection and personal-identifier redaction, and search query text.',
];

export function createQdrantClient(ctx: Pick<AppContext, 'settings' | 'secrets' | 'fetch' | 'logger'>, deps: Pick<MemoryServiceDeps, 'fetch' | 'qdrantRetryPolicy' | 'qdrantTimeoutMs'> = {}): QdrantClient {
  return new QdrantClient({
    baseUrl: ctx.settings.qdrantUrl,
    apiKey: ctx.secrets.get('QDRANT_API_KEY') ?? null,
    fetch: deps.fetch ?? ctx.fetch,
    logger: ctx.logger,
    ...(deps.qdrantRetryPolicy ? { retryPolicy: deps.qdrantRetryPolicy } : {}),
    ...(deps.qdrantTimeoutMs ? { timeoutMs: deps.qdrantTimeoutMs } : {}),
  });
}

function tryCreateQdrant(ctx: AppContext, deps: MemoryServiceDeps): { client: QdrantClient | null; error: string | null } {
  if (deps.qdrant !== undefined) return { client: deps.qdrant, error: null };
  try {
    return { client: createQdrantClient(ctx, deps), error: null };
  } catch (err) {
    return { client: null, error: errorMessage(err) };
  }
}

export function createMemoryService(ctx: AppContext, deps: MemoryServiceDeps = {}): MemoryService {
  const llm = deps.llm ?? null;
  const embeddings = new EmbeddingService(ctx, llm, deps.embeddingOptions ?? {});
  const { client: qdrant } = tryCreateQdrant(ctx, deps);
  const indexer = new Indexer(ctx, embeddings, qdrant);
  const retriever = new HybridRetriever(ctx, embeddings, qdrant, deps.retrievalOptions ?? {});

  const service: MemoryService = {
    siteId: ctx.siteId,
    ingest: (opts = {}) => ingestAll(ctx, { ...(deps.collectOptions ?? {}), ...(opts.dryRun ? { dryRun: true } : {}) }),
    ingestDocument: (input, opts = {}) => ingestDocument(ctx, input, opts),
    plan: (opts = {}) => indexer.plan({ full: !!opts.full }).plan,
    async sync(opts = {}) {
      const dryRun = opts.dryRun ?? ctx.dryRun;
      const common = {
        allowPaid: !!opts.allowPaid,
        ...(opts.maxEmbed !== undefined ? { maxEmbed: opts.maxEmbed } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      };
      if (dryRun) {
        // The plan must cover what this run's ingest would add/change/delete, so the ingest is
        // simulated (real writes inside a transaction that is rolled back) and the plan is computed
        // against that state. Nothing is persisted, no network request and no embedding call is made.
        let ingest: IngestSummary | null = null;
        const index = await indexer.sync({
          ...common,
          dryRun: true,
          ...(opts.skipIngest
            ? {}
            : {
                simulateBeforePlan: () => {
                  ingest = { ...ingestAll(ctx, { ...(deps.collectOptions ?? {}), quiet: true }), dryRun: true };
                },
              }),
        });
        return { ingest, index };
      }
      const ingest = opts.skipIngest ? null : ingestAll(ctx, { ...(deps.collectOptions ?? {}), dryRun: false });
      const index = await indexer.sync({ ...common, dryRun: false });
      return { ingest, index };
    },
    search: (q) => retriever.search(q),
    rebuild: (opts = {}) => indexer.rebuild({ allowPaid: !!opts.allowPaid, dryRun: opts.dryRun ?? ctx.dryRun, ...(opts.signal ? { signal: opts.signal } : {}) }),
    reconcile: (opts = {}) => indexer.reconcile({ dryRun: opts.dryRun ?? ctx.dryRun }),
    status: (opts) => memoryStatus(ctx, { ...opts, llm, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.qdrant !== undefined ? { qdrant: deps.qdrant } : {}) }),
    getOriginalEvidence: (chunk) => getOriginalEvidence(ctx, chunk),
  };
  return service;
}

function countBy(rows: Array<{ k: string; n: number }>): Record<string, number> {
  return Object.fromEntries(rows.map((r) => [r.k, r.n]));
}

/**
 * Honest memory/Qdrant status. Without `network`, no request is made. With
 * `network`, only free read-only checks are performed (GET /healthz, GET /,
 * GET /collections/{name}[/exists]); never an embedding call.
 *
 * `llm` omitted (e.g. from doctor): the LLM client is resolved the same way
 * the memory CLI resolves it (resolveMemoryLlm), so the embedding state is not
 * reported as misconfigured just because the caller did not pass a client.
 * Pass `llm: null` to report memory without embeddings explicitly.
 */
export async function memoryStatus(
  ctx: AppContext,
  opts: StatusCheckOptions & { llm?: LlmClient | null; fetch?: FetchLike; qdrant?: QdrantClient | null; embeddingOptions?: EmbeddingOptions },
): Promise<MemoryStatusReport> {
  const now = ctx.clock.now().toISOString();
  let llm = opts.llm;
  let llmNote: string | undefined;
  if (llm === undefined) {
    const resolved = await resolveMemoryLlm(ctx);
    llm = resolved.llm;
    llmNote = resolved.note;
  }
  const embeddingOptions: EmbeddingOptions = { ...(opts.embeddingOptions ?? {}) };
  if (!llm && !embeddingOptions.noClient && ctx.offline && !ctx.synthetic) {
    // --offline is a per-invocation choice: no embedding client is used, whatever the configuration.
    embeddingOptions.noClient = {
      reason: 'Network access is disabled (--offline); no embedding client is used in this run.',
      nextStep: 'Run without --offline to use embeddings (the configuration was not checked in this run).',
    };
  }
  if (!llm && !embeddingOptions.noClient) {
    const keySet = ctx.secrets.has('LLM_GATEWAY_API_KEY');
    embeddingOptions.noClient = {
      reason: llmNote ?? 'No LLM client is wired for embeddings in this process.',
      nextStep:
        keySet && ctx.settings.models.embedding
          ? 'LLM_GATEWAY_API_KEY and the embedding model are set, but no LLM client is wired into memory here (see registerMemoryLlmFactory in src/memory/wiring.ts); the `memory` CLI commands wire it automatically when this build provides one.'
          : 'Set LLM_GATEWAY_API_KEY in <workspace>/secrets/secrets.env and EMBEDDING_MODEL (see docs/ACCESS_SETUP.md).',
    };
  }
  const embeddings = new EmbeddingService(ctx, llm ?? null, embeddingOptions);
  const target = embeddings.resolveTarget();
  const version = target.state === 'ready' ? target.version : null;
  const { client, error: clientError } = tryCreateQdrant(ctx, { ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.qdrant !== undefined ? { qdrant: opts.qdrant } : {}), qdrantRetryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 } });
  const apiKey = ctx.secrets.get('QDRANT_API_KEY') ?? null;
  const warnings: string[] = [];
  const insecureKey = insecureApiKeyTransport(ctx.settings.qdrantUrl, apiKey);
  if (insecureKey) {
    warnings.push('QDRANT_API_KEY would be sent over plain HTTP to a non-loopback host, so the Qdrant client is refused (Qdrant documents this as insecure). Enable TLS or a TLS reverse proxy.');
  }

  const db = ctx.db;
  const documents = {
    total: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memory_documents WHERE site_id = ?', [ctx.siteId])!.n,
    byStatus: countBy(db.all<{ k: string; n: number }>('SELECT status AS k, COUNT(*) AS n FROM memory_documents WHERE site_id = ? GROUP BY status', [ctx.siteId])),
    bySourceType: countBy(db.all<{ k: string; n: number }>('SELECT source_type AS k, COUNT(*) AS n FROM memory_documents WHERE site_id = ? GROUP BY source_type', [ctx.siteId])),
  };
  const indexer = new Indexer(ctx, embeddings, client);
  const current = indexer.currentChunks();
  const pending = version ? indexer.pendingChunks(current, version.id) : current;
  const failed = version
    ? db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM chunk_index_status WHERE site_id = ? AND embedding_version_id = ? AND status = 'failed'`, [ctx.siteId, version.id])!.n
    : 0;
  const chunks = {
    current: current.length,
    superseded: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memory_chunks WHERE site_id = ? AND superseded = 1', [ctx.siteId])!.n,
    indexed: current.length - pending.length,
    pending: pending.length,
    failed,
  };
  const tomb = db.get<{ p: number; d: number }>(
    'SELECT SUM(CASE WHEN propagated_at IS NULL THEN 1 ELSE 0 END) AS p, SUM(CASE WHEN propagated_at IS NOT NULL THEN 1 ELSE 0 END) AS d FROM memory_tombstones WHERE site_id = ?',
    [ctx.siteId],
  );
  const cacheVectors = version ? db.get<{ n: number }>('SELECT COUNT(*) AS n FROM embedding_cache WHERE embedding_version_id = ?', [version.id])!.n : 0;
  const idx = version
    ? db.get<{ last_sync_at: string | null; last_reconcile_at: string | null; degraded: number; degraded_reason: string | null }>(
        'SELECT last_sync_at, last_reconcile_at, degraded, degraded_reason FROM memory_index_state WHERE site_id = ? AND embedding_version_id = ?',
        [ctx.siteId, version.id],
      )
    : undefined;
  const rs = readRetrievalState(ctx);

  let state: IntegrationState;
  let detail: string;
  let nextStep: string | undefined;
  let health: QdrantHealth | null = null;
  let collection: MemoryStatusReport['qdrant']['collection'] = null;
  let networkChecked = false;

  if (!ctx.settings.features.qdrant) {
    state = 'disabled';
    detail = 'Qdrant is disabled for this site; memory uses SQLite full-text search only.';
    nextStep = 'To enable semantic memory: set features.qdrant and features.embeddings to true, start Qdrant (docker compose up -d qdrant), configure EMBEDDING_MODEL, then run `memory sync --allow-paid`.';
  } else if (clientError || !client) {
    state = 'misconfigured';
    detail = `Qdrant client could not be created: ${clientError ?? 'unknown error'}`;
    nextStep = insecureKey
      ? 'Use an https QDRANT_URL (TLS on Qdrant or a TLS reverse proxy), or a loopback URL such as http://127.0.0.1:6333 for a local Qdrant; the API key is never sent in cleartext over a network.'
      : 'Set QDRANT_URL to e.g. http://127.0.0.1:6333 (no credentials in the URL; use QDRANT_API_KEY).';
  } else if (ctx.offline) {
    state = 'disabled';
    detail = 'Offline/demo mode: no Qdrant requests are made; memory uses full-text search only.';
  } else if (!opts.network) {
    // Only persisted failures count here: a Qdrant/index failure (memory_index_state) or a degraded retrieval
    // caused by the index/embedding service. Per-query policy choices (paid query embedding not allowed,
    // empty or secret-like query, offline run) are never persisted as degraded.
    const degradedReason = idx?.degraded === 1 ? `Index degraded: ${idx.degraded_reason ?? 'unknown'}` : rs?.degraded ? `Last retrieval was degraded: ${rs.degraded_reason ?? 'unknown'}` : null;
    state = degradedReason ? 'degraded' : 'configured_unverified';
    detail = degradedReason ? `${degradedReason}. No network check performed (use --network for a free health check).` : 'Configured; no network check performed (use --network for a free health check).';
  } else {
    networkChecked = true;
    health = await client.health();
    if (!health.ok) {
      state = 'unreachable';
      detail = `Qdrant health check failed at ${ctx.settings.qdrantUrl}: ${health.detail}`;
      nextStep = 'Start Qdrant: `docker compose up -d qdrant` (see docs/modules/memory.md), then re-run `memory status --network`.';
    } else {
      state = 'ready';
      detail = `Qdrant reachable${health.version ? ` (version ${health.version})` : ''}.`;
      if (health.versionWarning) warnings.push(health.versionWarning);
      try {
        if (version) {
          const exists = await client.collectionExists(version.collection_name);
          if (exists) {
            const info = await client.getCollection(version.collection_name);
            collection = { name: version.collection_name, exists, pointsCount: info.pointsCount, vectorSize: info.vectorSize };
            if (info.vectorSize !== version.dimensions) {
              state = 'misconfigured';
              detail = `Collection ${version.collection_name} has vector size ${info.vectorSize}, expected ${version.dimensions}.`;
              nextStep = 'Delete the mismatched collection or configure a new embedding version, then run `memory rebuild`.';
            }
          } else {
            collection = { name: version.collection_name, exists, pointsCount: null, vectorSize: null };
            nextStep = 'Run `memory rebuild` (free when the embedding cache is complete) to recreate the collection.';
          }
        } else {
          // Authenticated read-only probe (verifies the API key without creating anything).
          await client.collectionExists(`${ctx.config.memory.qdrantCollectionPrefix}__status_probe`);
        }
      } catch (err) {
        if (err instanceof AppError && err.code === 'PERMISSION_DENIED') {
          state = 'permission_denied';
          detail = errorMessage(err);
          nextStep = err.hint;
        } else {
          state = 'degraded';
          detail = `Qdrant healthz passed but a collection request failed: ${errorMessage(err)}`;
        }
      }
      if (state === 'ready' && target.state !== 'ready') {
        state = 'degraded';
        detail += ` Embeddings unavailable (${target.reason}); retrieval is full-text only.`;
        nextStep = target.nextStep;
      }
    }
  }

  const nextSteps: string[] = [];
  if (nextStep) nextSteps.push(nextStep);
  if (target.state !== 'ready') nextSteps.push(target.nextStep);
  if (chunks.pending > 0 && target.state === 'ready' && ctx.settings.features.qdrant) nextSteps.push(`${chunks.pending} chunk(s) are not indexed: run \`memory sync\` (add --allow-paid when new embeddings are needed; --dry-run shows the plan and cap).`);
  if ((tomb?.p ?? 0) > 0) nextSteps.push(`${tomb?.p} deletion(s) are waiting to be propagated to Qdrant: run \`memory sync\`.`);
  if (documents.total === 0) nextSteps.push('No memory documents yet: run `memory sync` to ingest business notes and records.');

  return {
    siteId: ctx.siteId,
    integration: {
      id: 'qdrant',
      state,
      detail,
      ...(nextStep ? { nextStep } : {}),
      sendsExternally: MEMORY_SENDS_EXTERNALLY,
      checkedAt: now,
      networkChecked,
      chargeable: false,
    },
    embeddings: {
      state: target.state,
      ...(target.state !== 'ready' ? { reason: target.reason, nextStep: target.nextStep } : {}),
      provider: embeddings.provider,
      model: ctx.settings.models.embedding,
      dimensions: version?.dimensions ?? ctx.settings.models.embeddingDimensions,
      versionId: version?.id ?? null,
      collection: version?.collection_name ?? null,
    },
    documents,
    chunks,
    tombstones: { pending: tomb?.p ?? 0, propagated: tomb?.d ?? 0 },
    cacheVectors,
    index: idx ? { lastSyncAt: idx.last_sync_at, lastReconcileAt: idx.last_reconcile_at, degraded: idx.degraded === 1, degradedReason: idx.degraded_reason } : null,
    retrieval: rs ? { lastMethod: rs.last_method, degraded: rs.degraded === 1, degradedReason: rs.degraded_reason, updatedAt: rs.updated_at } : null,
    qdrant: { url: ctx.settings.qdrantUrl, enabled: ctx.settings.features.qdrant, apiKeyConfigured: !!apiKey, warnings, health, collection },
    nextSteps: [...new Set(nextSteps)],
  };
}
