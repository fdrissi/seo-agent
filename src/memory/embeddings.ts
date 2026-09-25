import type { AppContext } from '../app/context.js';
import { AppError } from '../core/errors.js';
import { newId, slugify } from '../core/ids.js';
import { formatUsd, type Micros } from '../core/money.js';
import type { LlmClient, LlmFailureStatus } from '../integrations/llm/types.js';
import { CHUNKER_VERSION } from './chunker.js';
import type { EmbeddingVersionRow } from './memory-types.js';
import { containsSecret, redactPersonalIdentifiers } from './sanitize.js';
import { estimateTokens } from './tokens.js';

/**
 * Embeddings with a dedup cache.
 *
 * - Calls go through the injected LlmClient.embed (the client owns budget
 *   reservation, the provider-request log, and cost reconciliation). This
 *   module only bounds batch sizes and never calls embed unless `allowPaid`.
 * - Embedding space identity = embedding_versions (provider, model,
 *   dimensions, chunker version). Each version has its own Qdrant collection.
 * - embedding_cache (version, normalized content hash) guarantees identical
 *   text is never embedded twice for a version; full rebuilds reuse it.
 * - Dimension mismatch (configured dims vs returned dims, or an existing
 *   version vs returned dims, or ragged vectors) is refused: nothing is
 *   stored and a new embedding version/collection is required. Vectors of
 *   different spaces are never mixed.
 * - Model mismatch (the response names a different embedding model than the
 *   configured one, e.g. a gateway fallback to another model with the same
 *   output size) is refused the same way. Only an exact id match is accepted,
 *   or a returned id that only adds a provider prefix ("openai/") to a
 *   configured id without one. Alias and version suffixes ("-latest",
 *   "-preview", dates, "@001", "-v2") are different models: a moving alias can
 *   change the vector space silently.
 * - The returned model id is stored per cached vector and on the embedding
 *   version (migration 0221). A batch whose returned id differs from the id
 *   that created the version is refused, so a gateway that re-routes to
 *   another provider cannot mix spaces under one collection.
 * - Cost honesty: a call that may have been billed is always accounted for.
 *   An ambiguous failure (the request may have reached the provider) or a
 *   failure whose charge is unknown (chargeUnknown, or an unresolved budget
 *   reservation) makes the run's cost unknown (null), never $0; a failure
 *   that carries a known charge (billed, e.g. a dimension check after a 2xx)
 *   adds it; a billed response that is then refused (dimension/model
 *   mismatch, invalid vectors) still adds its cost.
 * - Defense in depth: any text that looks like it contains a secret is
 *   refused here even if it slipped past ingestion, and personal
 *   identifiers are redacted again before text leaves the process.
 */

export type EmbeddingCtx = Pick<AppContext, 'db' | 'siteId' | 'clock' | 'config' | 'settings' | 'logger' | 'runId'>;

export interface EmbeddingOptions {
  /** Provider label stored in embedding_versions. Default: 'fixture' for synthetic clients, else 'llm_gateway'. */
  provider?: string;
  /** Max texts per embeddings request. Default 64 (no documented per-request item cap; bounded conservatively). */
  maxBatchItems?: number;
  /** Max summed token estimate per request. Default 16,000. */
  maxBatchTokens?: number;
  /** Max token estimate per input. Default 8,192 (documented limit for text-embedding-3 / ada-002; some models allow only 2,048). */
  maxInputTokens?: number;
  /** Status text used when no LLM client was provided (lets status callers give an accurate next step). */
  noClient?: { reason: string; nextStep: string };
  /**
   * Returned model ids accepted as the configured model in addition to an
   * exact match (explicit allowlist, e.g. a provider-pinned alias the owner
   * verified). Default none.
   */
  acceptedModelAliases?: readonly string[];
}

/**
 * Where embeddings go for this site and process. 'disabled': features.embeddings
 * is off (full-text only by policy). 'not_configured': no model, no key, or no
 * client wired. 'unavailable': the LLM client cannot make any call in this run
 * for a reason that is not configuration (e.g. --offline, features.llm off);
 * the reason and next step come from the client. 'ambiguous': several versions.
 */
export type EmbeddingTarget =
  | { state: 'ready'; provider: string; model: string; configuredDims: number | null; version: EmbeddingVersionRow | null }
  | { state: 'disabled' | 'not_configured' | 'unavailable' | 'ambiguous'; reason: string; nextStep: string };

/** Partial accounting attached to a refusal so callers can report calls/cost that already happened. */
export interface EmbedPartial {
  calls: number;
  embedded: number;
  /** Cost of the calls made so far, including the refused one; null when unknown (never 0 for unknown). */
  costMicros: Micros | null;
}

/** The provider returned vectors from another embedding space than the configured one: nothing is stored. */
export class EmbeddingSpaceMismatchError extends AppError {
  /** Calls/cost already made in this embed() run (set by EmbeddingService.embed). */
  partial: EmbedPartial | null = null;

  constructor(message: string, details: Record<string, unknown>, hint: string) {
    super('CONFLICT', message, { details, hint });
    this.name = 'EmbeddingSpaceMismatchError';
  }
}

export class EmbeddingDimensionMismatchError extends EmbeddingSpaceMismatchError {
  constructor(message: string, details: Record<string, unknown>) {
    super(
      message,
      details,
      'Vectors of different dimensions are never mixed. Set models.embeddingDimensions to the model\'s real output size (this creates a new embedding version and Qdrant collection), then run `memory sync --allow-paid` or `memory rebuild --allow-paid`.',
    );
    this.name = 'EmbeddingDimensionMismatchError';
  }
}

export class EmbeddingModelMismatchError extends EmbeddingSpaceMismatchError {
  constructor(message: string, details: Record<string, unknown>) {
    super(
      message,
      details,
      'Vectors from different embedding models are never mixed, even at equal dimensions. Set EMBEDDING_MODEL (models.embedding) to the model the gateway really serves, or pin the model in the gateway, then run `memory sync --allow-paid` (a new model id gets its own embedding version and Qdrant collection).',
    );
    this.name = 'EmbeddingModelMismatchError';
  }
}

function normalizedId(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * Compare the configured embedding model id with the id a response reports.
 * - 'same': identical (ignoring case and surrounding whitespace).
 * - 'variant': the configured id has no provider prefix and the returned id
 *   is exactly `<provider>/<configured id>` (the gateway names the provider it
 *   routed to), or the returned id is in the explicit `acceptedAliases`.
 * - 'different': everything else, including a different provider prefix than
 *   a provider-pinned configured id, and alias or version suffixes such as
 *   "-latest", "-preview", dates, "@001", or "-v2" (a moving alias or dated
 *   snapshot is another vector space until proven otherwise).
 */
export function compareEmbeddingModels(configured: string, returned: string, acceptedAliases: readonly string[] = []): 'same' | 'variant' | 'different' {
  const a = normalizedId(configured);
  const b = normalizedId(returned);
  if (!a || !b) return 'different';
  if (a === b) return 'same';
  if (acceptedAliases.some((x) => normalizedId(x) === b)) return 'variant';
  if (!a.includes('/')) {
    const slash = b.indexOf('/');
    if (slash > 0 && b.indexOf('/', slash + 1) === -1 && b.slice(slash + 1) === a) return 'variant';
  }
  return 'different';
}

/** True when two returned model ids name the same model (case-insensitive exact match). */
export function sameReturnedModel(a: string, b: string): boolean {
  return normalizedId(a) === normalizedId(b);
}

function addCost(total: Micros | null, add: Micros | null): Micros | null {
  return total === null || add === null ? null : total + add;
}

export function encodeVector(v: ArrayLike<number>): Uint8Array {
  const buf = new ArrayBuffer(v.length * 4);
  const dv = new DataView(buf);
  for (let i = 0; i < v.length; i++) dv.setFloat32(i * 4, v[i]!, true);
  return new Uint8Array(buf);
}

export function decodeVector(blob: Uint8Array): Float32Array {
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Float32Array(blob.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

export function collectionNameFor(prefix: string, provider: string, model: string, dims: number, chunkerVersion: string): string {
  const s = (x: string, n: number) => slugify(x, n).replace(/-/g, '_');
  return `${prefix}__${s(provider, 24)}__${s(model, 64)}__d${dims}__${s(chunkerVersion, 24)}`;
}

export interface EmbedItem {
  hash: string;
  text: string;
}

export interface EmbedOutcome {
  version: EmbeddingVersionRow | null;
  vectors: Map<string, Float32Array>;
  cacheHits: number;
  embedded: number;
  calls: number;
  /** Items not embedded because paid calls were not allowed. */
  skippedPaid: string[];
  /** Items refused by policy (never sent to the provider). */
  refused: Array<{ hash: string; reason: 'secret_detected' | 'input_too_long' }>;
  /** Provider/budget failure that stopped embedding (remaining items are left pending). */
  failure: { status: LlmFailureStatus | 'invalid_response'; reason: string; ambiguous?: boolean } | null;
  /** Sum of reported costs; null when any call's cost was unknown (never 0 for unknown). */
  costMicros: Micros | null;
  estimatedTokensSent: number;
}

export class EmbeddingService {
  readonly provider: string;
  private readonly maxBatchItems: number;
  private readonly maxBatchTokens: number;
  readonly maxInputTokens: number;
  private readonly noClient: { reason: string; nextStep: string } | null;
  private readonly acceptedModelAliases: readonly string[];

  constructor(
    private readonly ctx: EmbeddingCtx,
    private readonly llm: LlmClient | null,
    opts: EmbeddingOptions = {},
  ) {
    this.provider = opts.provider ?? (llm?.synthetic ? 'fixture' : 'llm_gateway');
    this.maxBatchItems = Math.max(1, opts.maxBatchItems ?? 64);
    this.maxBatchTokens = Math.max(1, opts.maxBatchTokens ?? 16_000);
    this.maxInputTokens = Math.max(1, opts.maxInputTokens ?? 8_192);
    this.noClient = opts.noClient ?? null;
    this.acceptedModelAliases = opts.acceptedModelAliases ?? [];
  }

  /**
   * False when this service was built without an LLM client: a deliberate
   * process-level policy (automated flows never spend on query embeddings
   * implicitly), not a fault of the index or the embedding provider.
   */
  get hasClient(): boolean {
    return this.llm !== null;
  }

  resolveTarget(): EmbeddingTarget {
    const { settings } = this.ctx;
    if (!settings.features.embeddings) {
      return { state: 'disabled', reason: 'Embeddings are disabled for this site (features.embeddings=false or profile default).', nextStep: 'Enable features.embeddings in the site config to use semantic memory.' };
    }
    const model = settings.models.embedding;
    if (!model) {
      return { state: 'not_configured', reason: 'No embedding model configured.', nextStep: 'Set EMBEDDING_MODEL (or models.embedding in the site config) to a verified embedding model; see docs/ACCESS_SETUP.md.' };
    }
    if (!this.llm) {
      return {
        state: 'not_configured',
        reason: this.noClient?.reason ?? 'No LLM client is wired for embeddings in this process.',
        nextStep: this.noClient?.nextStep ?? 'Configure the LLM Gateway (LLM_GATEWAY_API_KEY and EMBEDDING_MODEL); the `memory` CLI commands wire the embedding client automatically.',
      };
    }
    // A client that refuses every call says why (e.g. network disabled with --offline): report that cause,
    // never a guessed "missing key or model" that would send the owner to edit a correct configuration.
    const unavailable = this.llm.unavailable ?? null;
    if (unavailable) {
      return { state: unavailable.status === 'not_configured' ? 'not_configured' : 'unavailable', reason: unavailable.reason, nextStep: unavailable.nextStep };
    }
    if (!this.llm.isConfigured('embedding')) {
      return { state: 'not_configured', reason: 'The embedding client is not configured (missing key or model).', nextStep: 'Set LLM_GATEWAY_API_KEY in <workspace>/secrets/secrets.env and EMBEDDING_MODEL.' };
    }
    const dims = settings.models.embeddingDimensions;
    if (dims) {
      const version = this.findVersion(model, dims) ?? null;
      return { state: 'ready', provider: this.provider, model, configuredDims: dims, version };
    }
    const rows = this.ctx.db.all<EmbeddingVersionRow>(
      `SELECT * FROM embedding_versions WHERE provider = ? AND model_id = ? AND chunker_version = ? AND status = 'active' ORDER BY created_at`,
      [this.provider, model, CHUNKER_VERSION],
    );
    if (rows.length > 1) {
      return {
        state: 'ambiguous',
        reason: `Several embedding versions exist for ${model} (dimensions ${rows.map((r) => r.dimensions).join(', ')}).`,
        nextStep: 'Set models.embeddingDimensions in the site config to choose one.',
      };
    }
    return { state: 'ready', provider: this.provider, model, configuredDims: null, version: rows[0] ?? null };
  }

  findVersion(model: string, dims: number): EmbeddingVersionRow | undefined {
    return this.ctx.db.get<EmbeddingVersionRow>('SELECT * FROM embedding_versions WHERE provider = ? AND model_id = ? AND dimensions = ? AND chunker_version = ?', [
      this.provider,
      model,
      dims,
      CHUNKER_VERSION,
    ]);
  }

  /**
   * Create (or reactivate) the embedding version for verified dimensions.
   * `returnedModel` is the model id the provider reported for the batch that
   * creates the version (stored; later batches must match it).
   */
  ensureVersion(model: string, dims: number, returnedModel?: string | null): EmbeddingVersionRow {
    const existing = this.findVersion(model, dims);
    if (existing) {
      if (existing.status !== 'active') this.ctx.db.run(`UPDATE embedding_versions SET status = 'active' WHERE id = ?`, [existing.id]);
      return { ...existing, status: 'active' };
    }
    const row: EmbeddingVersionRow = {
      id: newId('emv'),
      provider: this.provider,
      model_id: model,
      dimensions: dims,
      chunker_version: CHUNKER_VERSION,
      collection_name: collectionNameFor(this.ctx.config.memory.qdrantCollectionPrefix, this.provider, model, dims, CHUNKER_VERSION),
      status: 'active',
      created_at: this.ctx.clock.now().toISOString(),
      returned_model_id: returnedModel?.trim() || null,
    };
    this.ctx.db.run(
      `INSERT INTO embedding_versions (id, provider, model_id, dimensions, chunker_version, collection_name, status, created_at, returned_model_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.provider, row.model_id, row.dimensions, row.chunker_version, row.collection_name, row.status, row.created_at, row.returned_model_id ?? null],
    );
    this.ctx.logger.info('Created embedding version', { versionId: row.id, model, returnedModel: row.returned_model_id, dims, collection: row.collection_name });
    return row;
  }

  getCached(versionId: string, hashes: string[]): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    const unique = [...new Set(hashes)];
    for (let i = 0; i < unique.length; i += 400) {
      const part = unique.slice(i, i + 400);
      const rows = this.ctx.db.all<{ content_hash: string; vector: Uint8Array }>(
        `SELECT content_hash, vector FROM embedding_cache WHERE embedding_version_id = ? AND content_hash IN (${part.map(() => '?').join(',')})`,
        [versionId, ...part],
      );
      for (const r of rows) out.set(r.content_hash, decodeVector(r.vector));
    }
    return out;
  }

  cachedCount(versionId: string, hashes: string[]): number {
    return this.getCached(versionId, hashes).size;
  }

  private checkResponse(
    texts: string[],
    r: { vectors: Float32Array[]; dimensions: number; model?: string },
    target: Extract<EmbeddingTarget, { state: 'ready' }>,
    version: EmbeddingVersionRow | null,
  ): string | null {
    if (typeof r.model === 'string' && r.model.trim()) {
      const cmp = compareEmbeddingModels(target.model, r.model, this.acceptedModelAliases);
      if (cmp === 'different') {
        throw new EmbeddingModelMismatchError(
          `Embedding response came from model "${r.model}" but the configured embedding model is "${target.model}"${version ? ` (embedding version ${version.id}, collection ${version.collection_name})` : ''}. Refusing to store or index these vectors (only an exact id, or the same id with a provider prefix when the configured id has none, is accepted; alias and version suffixes are different models).`,
          { configured: target.model, returned: r.model, ...(version ? { versionId: version.id } : {}) },
        );
      }
      const created = version?.returned_model_id ?? null;
      if (version && created && !sameReturnedModel(created, r.model)) {
        throw new EmbeddingModelMismatchError(
          `Embedding response came from model "${r.model}" but embedding version ${version.id} (collection ${version.collection_name}) was created from vectors of "${created}". Refusing to mix vectors of different models in one collection.`,
          { configured: target.model, returned: r.model, versionReturnedModel: created, versionId: version.id },
        );
      }
      if (cmp === 'variant') this.ctx.logger.info('Embedding response model id differs only by provider prefix (or is an allowlisted alias); accepted', { configured: target.model, returned: r.model });
    } else {
      this.ctx.logger.warn('Embedding response did not name its model; the configured model is assumed', { configured: target.model });
    }
    if (!Array.isArray(r.vectors) || r.vectors.length !== texts.length) return `expected ${texts.length} vectors, got ${Array.isArray(r.vectors) ? r.vectors.length : 'none'}`;
    const dims = r.dimensions;
    if (!Number.isInteger(dims) || dims <= 0) return `invalid dimensions ${String(dims)}`;
    for (const v of r.vectors) {
      if (!v || v.length !== dims) {
        throw new EmbeddingDimensionMismatchError(`Embedding response has inconsistent vector lengths (${v?.length ?? 'missing'} vs reported ${dims}); refusing to store any of them.`, {
          model: target.model,
          reported: dims,
          actual: v?.length ?? null,
        });
      }
      for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i]!)) return 'vector contains non-finite values';
    }
    if (target.configuredDims && dims !== target.configuredDims) {
      throw new EmbeddingDimensionMismatchError(`Embedding model ${target.model} returned ${dims} dimensions but the site config says ${target.configuredDims}. Refusing to store or index these vectors.`, {
        model: target.model,
        configured: target.configuredDims,
        returned: dims,
      });
    }
    if (version && dims !== version.dimensions) {
      throw new EmbeddingDimensionMismatchError(`Embedding model ${target.model} returned ${dims} dimensions but embedding version ${version.id} (collection ${version.collection_name}) has ${version.dimensions}. Refusing to mix vectors.`, {
        model: target.model,
        versionId: version.id,
        versionDims: version.dimensions,
        returned: dims,
      });
    }
    return null;
  }

  /**
   * Return vectors for the given items: cache first, then (only with
   * `allowPaid`) bounded embedding batches through the LlmClient.
   */
  async embed(items: EmbedItem[], opts: { allowPaid: boolean; runId?: string; signal?: AbortSignal; maxNewItems?: number }): Promise<EmbedOutcome> {
    const target = this.resolveTarget();
    if (target.state !== 'ready') throw new AppError('INTEGRATION_DISABLED', `Embeddings unavailable: ${target.reason}`, { hint: target.nextStep });
    let version = target.version;
    const out: EmbedOutcome = { version, vectors: new Map(), cacheHits: 0, embedded: 0, calls: 0, skippedPaid: [], refused: [], failure: null, costMicros: 0, estimatedTokensSent: 0 };

    const unique = new Map<string, string>();
    for (const it of items) if (!unique.has(it.hash)) unique.set(it.hash, it.text);

    const eligible: EmbedItem[] = [];
    for (const [hash, raw] of unique) {
      if (containsSecret(raw)) {
        out.refused.push({ hash, reason: 'secret_detected' });
        continue;
      }
      // Defense in depth: ingestion already redacts personal identifiers; never send them even if a write bypassed it.
      const text = redactPersonalIdentifiers(raw, { phones: true, handles: true }).text;
      if (estimateTokens(text) > this.maxInputTokens) {
        out.refused.push({ hash, reason: 'input_too_long' });
        continue;
      }
      eligible.push({ hash, text });
    }
    if (out.refused.length) this.ctx.logger.warn('Embedding inputs refused by policy', { refused: out.refused.length, reasons: [...new Set(out.refused.map((r) => r.reason))] });

    let misses = eligible;
    if (version) {
      const cached = this.getCached(version.id, eligible.map((e) => e.hash));
      for (const [h, v] of cached) out.vectors.set(h, v);
      out.cacheHits = cached.size;
      misses = eligible.filter((e) => !cached.has(e.hash));
    }
    if (!misses.length) return out;
    if (!opts.allowPaid) {
      out.skippedPaid = misses.map((m) => m.hash);
      return out;
    }
    if (opts.maxNewItems !== undefined && misses.length > opts.maxNewItems) {
      out.skippedPaid = misses.slice(opts.maxNewItems).map((m) => m.hash);
      misses = misses.slice(0, opts.maxNewItems);
    }

    // Bounded batches.
    const batches: EmbedItem[][] = [];
    let cur: EmbedItem[] = [];
    let curTok = 0;
    for (const m of misses) {
      const t = estimateTokens(m.text);
      if (cur.length && (cur.length >= this.maxBatchItems || curTok + t > this.maxBatchTokens)) {
        batches.push(cur);
        cur = [];
        curTok = 0;
      }
      cur.push(m);
      curTok += t;
    }
    if (cur.length) batches.push(cur);

    const snapshot = (): EmbedPartial => ({ calls: out.calls, embedded: out.embedded, costMicros: out.costMicros });
    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi]!;
      const remaining = () => batches.slice(bi + 1).flat().map((b) => b.hash);
      if (opts.signal?.aborted) {
        out.failure = { status: 'provider_error', reason: 'cancelled before the request was sent' };
        out.skippedPaid.push(...batch.map((b) => b.hash), ...remaining());
        break;
      }
      const texts = batch.map((b) => b.text);
      out.calls++;
      out.estimatedTokensSent += texts.reduce((a, t) => a + estimateTokens(t), 0);
      const r = await this.llm!.embed({ siteId: this.ctx.siteId, runId: opts.runId ?? this.ctx.runId, texts, ...(opts.signal ? { signal: opts.signal } : {}) });
      if (!r.ok) {
        if (r.ambiguous) {
          // The request may have been accepted and billed: the run's cost is unknown, never $0.
          out.costMicros = null;
          out.failure = { status: r.status, reason: `${r.reason} (charge may be unresolved: the request may have been billed; the budget reservation is kept until reconciled)`, ambiguous: true };
        } else if (r.chargeUnknown || r.reservationId || (r.billed && (r.costMicros === null || r.costMicros === undefined))) {
          // Billed (or possibly billed) with an unknown charge, or a reservation left unresolved: unknown, never $0.
          out.costMicros = null;
          out.failure = { status: r.status, reason: `${r.reason} (charge unknown: the gateway processed and billed at least one request whose cost cannot be read; the budget reservation is kept until reconciled)`, ambiguous: true };
        } else if (typeof r.costMicros === 'number') {
          // The failure carries a known charge (e.g. billed before a check failed): count it.
          out.costMicros = addCost(out.costMicros, r.costMicros);
          out.failure = { status: r.status, reason: r.costMicros > 0 || r.billed ? `${r.reason} (billed: ${formatUsd(r.costMicros)} counted in this run's cost)` : r.reason };
        } else {
          out.failure = { status: r.status, reason: r.reason };
        }
        // Stop: never keep spending after a budget/provider failure. Remaining items stay pending.
        out.skippedPaid.push(...remaining());
        break;
      }
      // The call returned a response, so it may have been billed: account for its cost before validating it.
      out.costMicros = addCost(out.costMicros, r.costMicros);
      let problem: string | null;
      try {
        problem = this.checkResponse(texts, r, target, version);
      } catch (err) {
        if (err instanceof EmbeddingSpaceMismatchError) err.partial = snapshot();
        throw err;
      }
      if (problem) {
        out.failure = { status: 'invalid_response', reason: `${problem}; the response was discarded${r.costMicros === null ? ' (its cost is unknown)' : ''}` };
        out.skippedPaid.push(...batch.map((b) => b.hash), ...remaining());
        break;
      }
      const returnedModel = typeof r.model === 'string' && r.model.trim() ? r.model.trim() : null;
      if (!version) {
        version = this.ensureVersion(target.model, r.dimensions, returnedModel);
        out.version = version;
      }
      if (returnedModel && !version.returned_model_id) {
        // A version created before migration 0221 (or from a response without a model id) adopts this id.
        this.ctx.db.run('UPDATE embedding_versions SET returned_model_id = ? WHERE id = ? AND returned_model_id IS NULL', [returnedModel, version.id]);
        version = { ...version, returned_model_id: returnedModel };
        out.version = version;
      }
      const v = version;
      const at = this.ctx.clock.now().toISOString();
      this.ctx.db.transaction(() => {
        batch.forEach((b, i) => {
          this.ctx.db.run('INSERT OR IGNORE INTO embedding_cache (embedding_version_id, content_hash, vector, created_at, returned_model_id) VALUES (?, ?, ?, ?, ?)', [v.id, b.hash, encodeVector(r.vectors[i]!), at, returnedModel]);
        });
      });
      batch.forEach((b, i) => out.vectors.set(b.hash, r.vectors[i]!));
      out.embedded += batch.length;
    }
    return out;
  }
}
