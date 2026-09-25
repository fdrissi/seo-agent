import type { AppContext } from '../app/context.js';
import { AppError, errorMessage } from '../core/errors.js';
import { costPerMillionCeil, formatUsd, toMicros, type Micros } from '../core/money.js';
import { CHUNKER_VERSION, embeddingInput } from './chunker.js';
import { withOccurrences } from './documents.js';
import { EmbeddingSpaceMismatchError, type EmbeddingService, type EmbeddingTarget, type EmbedOutcome } from './embeddings.js';
import type { EmbeddingVersionRow } from './memory-types.js';
import { MEMORY_PAYLOAD_INDEXES, type MemoryPointPayload, type QdrantClient, type QdrantPoint } from './qdrant.js';
import { recordIndexState, recordRetrievalState } from './state.js';
import { estimateTokens } from './tokens.js';
import { pointIdFor } from './uuid.js';

/**
 * Vector indexer: SQLite (authoritative) -> embeddings (cache first) -> Qdrant.
 *
 * - sync: propagate tombstones, then embed + upsert pending chunks
 *   (incremental). Paid embedding calls only with `allowPaid`.
 * - rebuild: delete this site's points in the version's collection and
 *   re-upsert every current chunk from SQLite + embedding_cache. When the
 *   cache is complete this makes no paid calls at all.
 * - reconcile: compare Qdrant point ids for the site with the expected set
 *   derived from SQLite; delete orphans, re-upsert missing/stale points from
 *   the cache.
 *
 * Every Qdrant operation is scoped with a site_id filter or with point ids
 * derived from this site's chunks. Points whose payload names another site
 * are never modified.
 */

export type IndexCtx = Pick<AppContext, 'db' | 'siteId' | 'clock' | 'config' | 'settings' | 'logger' | 'budgets' | 'offline' | 'runId'>;

export interface IndexableChunk {
  chunkId: string;
  documentId: string;
  headingPath: string;
  text: string;
  contentHash: string;
  occurrence: number;
  pointId: string;
  documentVersion: number;
  language: string;
  sourceType: string;
  trustClass: string;
  status: string;
  recordStatus: string | null;
  accessScope: string;
  sourceDate: string | null;
}

export interface PaidPlan {
  required: boolean;
  items: number;
  estimatedTokens: number;
  /** Upper-bound estimate from a verified configured price, or null when no verified price is configured (never 0 for unknown). */
  estimatedCostMicros: Micros | null;
  priceBasis: string;
  caps: { perRunMicros: Micros; monthlyMicros: Micros; monthlyRemainingMicros: Micros | null };
  note: string;
}

export interface IndexPlan {
  embedding: { state: EmbeddingTarget['state']; reason?: string; nextStep?: string; model: string | null; dimensions: number | null; versionId: string | null; collection: string | null };
  qdrant: { enabled: boolean; url: string; offline: boolean };
  chunks: { current: number; indexed: number; pending: number };
  cache: { hits: number; misses: number };
  tombstonesPending: number;
  paid: PaidPlan;
}

export type IndexRunStatus = 'ok' | 'partial' | 'degraded' | 'skipped' | 'refused';

export interface IndexRunReport {
  operation: 'sync' | 'rebuild' | 'reconcile';
  dryRun: boolean;
  status: IndexRunStatus;
  plan: IndexPlan;
  upserted: number;
  embedded: number;
  cacheHits: number;
  skippedPaid: number;
  refused: number;
  failed: number;
  tombstonesPropagated: number;
  orphansDeleted: number;
  missingRestored: number;
  foreignPointsIgnored: number;
  /**
   * Vector indexing did not run because Qdrant or embeddings are disabled by the site configuration
   * (features.qdrant / features.embeddings, e.g. the Core profile): memory is full-text only BY POLICY.
   * Then `degraded` is false and `policyReason` says why (spec 8: degraded is for enabled paths that
   * fail or are not configured). Absent in reports of older versions.
   */
  policy?: boolean;
  policyReason?: string | null;
  /** Configuration flags that are off when `policy` is true (e.g. ['features.embeddings', 'features.qdrant']). */
  policyFlags?: string[];
  degraded: boolean;
  degradedReason: string | null;
  costMicros: Micros | null;
  messages: string[];
}

const DOC_STATUSES_INDEXED = ['active', 'rejected'];

export class Indexer {
  constructor(
    private readonly ctx: IndexCtx,
    private readonly embeddings: EmbeddingService,
    private readonly qdrant: QdrantClient | null,
  ) {}

  /** Current (indexable) chunks for this site with their deterministic point ids. */
  currentChunks(): IndexableChunk[] {
    const rows = this.ctx.db.all<{
      id: string;
      document_id: string;
      heading_path: string;
      text: string;
      content_hash: string;
      document_version: number;
      language: string;
      source_type: string;
      trust_class: string;
      doc_status: string;
      record_status: string | null;
      access_scope: string;
      source_date: string | null;
    }>(
      `SELECT c.id, c.document_id, c.heading_path, c.text, c.content_hash, c.document_version, d.language, d.source_type, d.trust_class,
              d.status AS doc_status, d.record_status, d.access_scope, d.source_date
       FROM memory_chunks c JOIN memory_documents d ON d.id = c.document_id AND d.site_id = c.site_id
       WHERE c.site_id = ? AND d.site_id = ? AND c.superseded = 0 AND c.document_version = d.version
         AND d.status IN (${DOC_STATUSES_INDEXED.map(() => '?').join(',')})
       ORDER BY c.document_id, c.chunk_index`,
      [this.ctx.siteId, this.ctx.siteId, ...DOC_STATUSES_INDEXED],
    );
    const byDoc = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byDoc.get(r.document_id) ?? [];
      list.push(r);
      byDoc.set(r.document_id, list);
    }
    const out: IndexableChunk[] = [];
    for (const [docId, list] of byDoc) {
      for (const r of withOccurrences(list)) {
        out.push({
          chunkId: r.id,
          documentId: docId,
          headingPath: r.heading_path,
          text: r.text,
          contentHash: r.content_hash,
          occurrence: r.occurrence,
          pointId: pointIdFor(this.ctx.siteId, docId, r.content_hash, r.occurrence),
          documentVersion: r.document_version,
          language: r.language,
          sourceType: r.source_type,
          trustClass: r.trust_class,
          status: r.doc_status,
          recordStatus: r.record_status,
          accessScope: r.access_scope,
          sourceDate: r.source_date,
        });
      }
    }
    return out;
  }

  private indexRows(versionId: string): Map<string, { status: string; content_hash: string; point_id: string }> {
    const rows = this.ctx.db.all<{ chunk_id: string; status: string; content_hash: string; point_id: string }>(
      'SELECT chunk_id, status, content_hash, point_id FROM chunk_index_status WHERE site_id = ? AND embedding_version_id = ?',
      [this.ctx.siteId, versionId],
    );
    return new Map(rows.map((r) => [r.chunk_id, r]));
  }

  pendingChunks(all: IndexableChunk[], versionId: string | null): IndexableChunk[] {
    if (!versionId) return all;
    const rows = this.indexRows(versionId);
    return all.filter((c) => {
      const r = rows.get(c.chunkId);
      return !r || r.status !== 'indexed' || r.content_hash !== c.contentHash || r.point_id !== c.pointId;
    });
  }

  tombstonesPending(): number {
    return this.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memory_tombstones WHERE site_id = ? AND propagated_at IS NULL', [this.ctx.siteId])!.n;
  }

  paidPlan(model: string | null, missTexts: string[]): PaidPlan {
    const tokens = missTexts.reduce((a, t) => a + estimateTokens(t), 0);
    const b = this.ctx.settings.budgets.llmGateway;
    let remaining: Micros | null = null;
    try {
      remaining = this.ctx.budgets.report(this.ctx.siteId).providers.find((p) => p.provider === 'llm_gateway')?.remainingMicros ?? null;
    } catch {
      remaining = null;
    }
    const override = model ? this.ctx.config.llm.pricingOverrides[model] : undefined;
    const estimate = override && tokens > 0 ? costPerMillionCeil(toMicros(override.inputPerMillionUsd), tokens) : tokens === 0 ? 0 : null;
    return {
      required: missTexts.length > 0,
      items: missTexts.length,
      estimatedTokens: tokens,
      estimatedCostMicros: estimate,
      priceBasis: override
        ? `verified_config: llm.pricingOverrides["${model}"].inputPerMillionUsd x ${tokens} estimated tokens (heuristic, conservative)`
        : tokens === 0
          ? 'no paid calls needed'
          : 'unknown: no verified embedding price in llm.pricingOverrides; the LLM client reserves budget with its own pricing source or refuses',
      caps: { perRunMicros: b.perRun, monthlyMicros: b.monthly, monthlyRemainingMicros: remaining },
      note: 'Embedding calls go through the LLM client, which reserves budget before each request. Nothing is embedded without --allow-paid.',
    };
  }

  plan(opts: { full: boolean }): { plan: IndexPlan; target: EmbeddingTarget; chunks: IndexableChunk[]; pending: IndexableChunk[] } {
    const target = this.embeddings.resolveTarget();
    const all = this.currentChunks();
    const version = target.state === 'ready' ? target.version : null;
    const pending = opts.full ? all : this.pendingChunks(all, version?.id ?? null);
    const inputs = pending.map((c) => ({ hash: c.contentHash, text: embeddingInput(c.headingPath, c.text) }));
    const uniqueHashes = [...new Set(inputs.map((i) => i.hash))];
    const cached = version ? this.embeddings.getCached(version.id, uniqueHashes) : new Map<string, Float32Array>();
    const missTexts: string[] = [];
    const seen = new Set<string>();
    for (const i of inputs) {
      if (cached.has(i.hash) || seen.has(i.hash)) continue;
      seen.add(i.hash);
      missTexts.push(i.text);
    }
    const indexed = version ? all.length - this.pendingChunks(all, version.id).length : 0;
    const plan: IndexPlan = {
      embedding:
        target.state === 'ready'
          ? { state: 'ready', model: target.model, dimensions: version?.dimensions ?? target.configuredDims, versionId: version?.id ?? null, collection: version?.collection_name ?? null }
          : { state: target.state, reason: target.reason, nextStep: target.nextStep, model: this.ctx.settings.models.embedding, dimensions: this.ctx.settings.models.embeddingDimensions, versionId: null, collection: null },
      qdrant: { enabled: this.ctx.settings.features.qdrant, url: this.ctx.settings.qdrantUrl, offline: this.ctx.offline },
      chunks: { current: all.length, indexed, pending: pending.length },
      cache: { hits: uniqueHashes.filter((h) => cached.has(h)).length, misses: missTexts.length },
      tombstonesPending: this.tombstonesPending(),
      paid:
        target.state === 'ready' && this.ctx.settings.features.qdrant
          ? this.paidPlan(target.model, missTexts)
          : { ...this.paidPlan(null, []), note: 'Vector indexing is not enabled/configured, so no embedding calls will be made.' },
    };
    return { plan, target, chunks: all, pending };
  }

  private emptyReport(operation: IndexRunReport['operation'], dryRun: boolean, plan: IndexPlan): IndexRunReport {
    return {
      operation,
      dryRun,
      status: 'ok',
      plan,
      upserted: 0,
      embedded: 0,
      cacheHits: 0,
      skippedPaid: 0,
      refused: 0,
      failed: 0,
      tombstonesPropagated: 0,
      orphansDeleted: 0,
      missingRestored: 0,
      foreignPointsIgnored: 0,
      policy: false,
      policyReason: null,
      policyFlags: [],
      degraded: false,
      degradedReason: null,
      costMicros: 0,
      messages: [],
    };
  }

  /**
   * Why vector indexing cannot run right now (null when it can). `policy`
   * marks a deliberate configuration (Qdrant or embeddings disabled for the
   * site), which never records retrieval as degraded.
   */
  private blocker(target: EmbeddingTarget): { status: IndexRunStatus; reason: string; policy?: boolean; flags?: string[] } | null {
    // Disabled by configuration (either path is off, e.g. the Core profile): full-text only by policy, never degraded,
    // whatever the state of the other path (vectors need both).
    const embeddingsOff = target.state === 'disabled';
    const qdrantOff = !this.ctx.settings.features.qdrant;
    if (embeddingsOff || qdrantOff) {
      const flags = [...(embeddingsOff ? ['features.embeddings'] : []), ...(qdrantOff ? ['features.qdrant'] : [])];
      const reason =
        embeddingsOff && qdrantOff
          ? 'Embeddings and Qdrant are disabled for this site (features.embeddings=false, features.qdrant=false, or the profile default); memory uses full-text search only by policy. Enable both in the site config to use semantic memory.'
          : embeddingsOff
            ? `${target.reason} ${target.nextStep}`.trim()
            : 'Qdrant is disabled for this site (features.qdrant=false); memory uses full-text search only.';
      return { status: 'skipped', reason, policy: true, flags };
    }
    if (target.state !== 'ready') return { status: 'skipped', reason: `${target.reason} ${target.nextStep}`.trim() };
    if (!this.qdrant) return { status: 'skipped', reason: 'No Qdrant client configured.' };
    if (this.ctx.offline) return { status: 'skipped', reason: 'Offline mode: Qdrant and embedding requests are not allowed; memory uses full-text search only.' };
    return null;
  }

  /** Full-text only by policy (configuration), stated in the report: never degraded. */
  private markPolicy(report: IndexRunReport, block: { reason: string; flags?: string[] }): void {
    report.policy = true;
    report.policyReason = block.reason;
    report.policyFlags = block.flags ?? [];
    report.degraded = false;
    report.degradedReason = null;
    report.messages.push(`Full-text only by policy (not degraded): ${block.reason}`);
  }

  private markDegraded(report: IndexRunReport, reason: string, versionId: string | null): IndexRunReport {
    report.status = 'degraded';
    report.degraded = true;
    report.degradedReason = reason;
    report.messages.push(`Degraded: ${reason}. Retrieval continues with full-text search.`);
    if (versionId) recordIndexState(this.ctx, versionId, { degraded: true, reason });
    recordRetrievalState(this.ctx, { method: 'fts_only', degraded: true, reason, versionId, indexHealthy: false });
    return report;
  }

  private payload(c: IndexableChunk, v: EmbeddingVersionRow): MemoryPointPayload {
    return {
      site_id: this.ctx.siteId,
      document_id: c.documentId,
      chunk_id: c.chunkId,
      source_type: c.sourceType,
      trust_class: c.trustClass,
      status: c.status,
      record_status: c.recordStatus,
      access_scope: c.accessScope,
      language: c.language,
      superseded: false,
      content_hash: c.contentHash,
      occurrence: c.occurrence,
      document_version: c.documentVersion,
      embedding_version_id: v.id,
      chunker_version: CHUNKER_VERSION,
      source_date: c.sourceDate,
    };
  }

  private setIndexStatus(chunks: IndexableChunk[], v: EmbeddingVersionRow, status: 'indexed' | 'pending' | 'failed', error: string | null): void {
    const at = this.ctx.clock.now().toISOString();
    this.ctx.db.transaction(() => {
      for (const c of chunks) {
        this.ctx.db.run(
          `INSERT INTO chunk_index_status (chunk_id, embedding_version_id, site_id, point_id, content_hash, status, error, indexed_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (chunk_id, embedding_version_id) DO UPDATE SET point_id = excluded.point_id, content_hash = excluded.content_hash,
             status = excluded.status, error = excluded.error, indexed_at = COALESCE(excluded.indexed_at, chunk_index_status.indexed_at), updated_at = excluded.updated_at`,
          [c.chunkId, v.id, this.ctx.siteId, c.pointId, c.contentHash, status, error, status === 'indexed' ? at : null, at],
        );
      }
    });
  }

  /** Delete tombstoned points from Qdrant. Points still expected by current chunks are never deleted. */
  async propagateTombstones(expectedPointIds: Set<string>, opts: { skipVersionId?: string } = {}): Promise<number> {
    const rows = this.ctx.db.all<{ id: string; point_id: string | null; embedding_version_id: string | null; collection_name: string | null }>(
      `SELECT t.id, t.point_id, t.embedding_version_id, v.collection_name FROM memory_tombstones t
       LEFT JOIN embedding_versions v ON v.id = t.embedding_version_id
       WHERE t.site_id = ? AND t.propagated_at IS NULL ORDER BY t.created_at`,
      [this.ctx.siteId],
    );
    if (!rows.length || !this.qdrant) return 0;
    const at = () => this.ctx.clock.now().toISOString();
    const markDone = (ids: string[]) => {
      this.ctx.db.transaction(() => {
        for (const id of ids) this.ctx.db.run('UPDATE memory_tombstones SET propagated_at = ? WHERE id = ? AND site_id = ?', [at(), id, this.ctx.siteId]);
      });
    };
    const byCollection = new Map<string, typeof rows>();
    const trivial: string[] = [];
    for (const r of rows) {
      if (!r.point_id || !r.collection_name || r.embedding_version_id === opts.skipVersionId) {
        trivial.push(r.id);
        continue;
      }
      const list = byCollection.get(r.collection_name) ?? [];
      list.push(r);
      byCollection.set(r.collection_name, list);
    }
    if (trivial.length) markDone(trivial);
    let n = trivial.length;
    for (const [collection, list] of byCollection) {
      if (!(await this.qdrant.collectionExists(collection))) {
        markDone(list.map((r) => r.id));
        n += list.length;
        continue;
      }
      const toDelete = [...new Set(list.map((r) => r.point_id!).filter((p) => !expectedPointIds.has(p.toLowerCase())))];
      if (toDelete.length) await this.qdrant.deletePoints(collection, toDelete);
      markDone(list.map((r) => r.id));
      n += list.length;
    }
    return n;
  }

  private async prepare(report: IndexRunReport, target: EmbeddingTarget): Promise<boolean> {
    const block = this.blocker(target);
    if (block) {
      report.status = block.status;
      const vId = target.state === 'ready' ? (target.version?.id ?? null) : null;
      if (block.policy) {
        // Qdrant/embeddings disabled by configuration is full-text only by policy: not degraded, here or in the persisted retrieval state.
        this.markPolicy(report, block);
        recordRetrievalState(this.ctx, { method: 'fts_only', degraded: false, versionId: vId });
        return false;
      }
      report.degraded = true;
      report.degradedReason = block.reason;
      // Offline is a per-invocation choice, not a health problem: do not persist it as degraded retrieval.
      if (!this.ctx.offline) recordRetrievalState(this.ctx, { method: 'fts_only', degraded: true, reason: block.reason, versionId: vId });
      return false;
    }
    const health = await this.qdrant!.health();
    if (!health.ok) {
      this.markDegraded(report, `Qdrant unavailable at ${this.ctx.settings.qdrantUrl}: ${health.detail}`, target.state === 'ready' ? (target.version?.id ?? null) : null);
      return false;
    }
    if (health.versionWarning) report.messages.push(health.versionWarning);
    // Authenticated read-only probe BEFORE any paid embedding: a wrong API key must not cost money.
    try {
      const probe = target.state === 'ready' && target.version ? target.version.collection_name : `${this.ctx.config.memory.qdrantCollectionPrefix}__access_probe`;
      await this.qdrant!.collectionExists(probe);
    } catch (err) {
      this.markDegraded(report, `Qdrant rejected an authenticated request: ${errorMessage(err)}`, target.state === 'ready' ? (target.version?.id ?? null) : null);
      return false;
    }
    return true;
  }

  private async embedAndUpsert(
    report: IndexRunReport,
    target: Extract<EmbeddingTarget, { state: 'ready' }>,
    chunks: IndexableChunk[],
    opts: { allowPaid: boolean; maxEmbed?: number; signal?: AbortSignal },
  ): Promise<EmbeddingVersionRow | null> {
    // Known embedding space: make sure the collection exists and matches BEFORE spending on embeddings.
    if (target.version && this.qdrant) await this.qdrant.ensureCollection(target.version.collection_name, target.version.dimensions, MEMORY_PAYLOAD_INDEXES);
    let outcome: EmbedOutcome;
    try {
      outcome = await this.embeddings.embed(
        chunks.map((c) => ({ hash: c.contentHash, text: embeddingInput(c.headingPath, c.text) })),
        { allowPaid: opts.allowPaid, runId: this.ctx.runId, ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.maxEmbed !== undefined ? { maxNewItems: opts.maxEmbed } : {}) },
      );
    } catch (err) {
      if (err instanceof EmbeddingSpaceMismatchError) {
        report.status = 'refused';
        // Calls already made (including the refused response) may have been billed: keep their cost, unknown stays null.
        const partial = err.partial;
        if (partial) {
          report.embedded += partial.embedded;
          report.costMicros = report.costMicros === null || partial.costMicros === null ? null : report.costMicros + partial.costMicros;
          if (partial.calls > 0) {
            report.messages.push(
              `${partial.calls} embedding call(s) were made before the refusal; reported cost ${partial.costMicros === null ? 'unknown (not reported)' : formatUsd(partial.costMicros)} is included in this run's cost.`,
            );
          }
        } else {
          report.costMicros = null;
        }
        report.messages.push(err.message);
        if (err.hint) report.messages.push(err.hint);
        return null;
      }
      throw err;
    }
    report.embedded += outcome.embedded;
    report.cacheHits += outcome.cacheHits;
    report.skippedPaid += outcome.skippedPaid.length;
    report.refused += outcome.refused.length;
    report.costMicros = report.costMicros === null || outcome.costMicros === null ? null : report.costMicros + outcome.costMicros;
    if (outcome.failure) {
      report.status = 'partial';
      report.messages.push(`Embedding stopped: ${outcome.failure.status}: ${outcome.failure.reason}`);
    }
    if (outcome.skippedPaid.length) {
      report.status = report.status === 'ok' ? 'partial' : report.status;
      report.messages.push(
        opts.allowPaid
          ? `${outcome.skippedPaid.length} chunk(s) not embedded (limit/budget/failure); they stay pending.`
          : `${outcome.skippedPaid.length} chunk(s) need new embeddings (paid). Re-run with --allow-paid to embed them (cap shown in the plan).`,
      );
    }
    const version = outcome.version;
    if (!version) {
      report.messages.push('No embedding version is established yet (dimensions unknown until the first embedding call).');
      return null;
    }
    if (!this.qdrant) return version;
    // A version established by this run (first embeddings) still needs its collection.
    if (target.version?.id !== version.id) await this.qdrant.ensureCollection(version.collection_name, version.dimensions, MEMORY_PAYLOAD_INDEXES);

    const refused = new Set(outcome.refused.map((r) => r.hash));
    const ready: IndexableChunk[] = [];
    const pendingOnes: IndexableChunk[] = [];
    const failedOnes: IndexableChunk[] = [];
    for (const c of chunks) {
      if (refused.has(c.contentHash)) failedOnes.push(c);
      else if (outcome.vectors.has(c.contentHash)) ready.push(c);
      else pendingOnes.push(c);
    }
    const points: QdrantPoint[] = ready.map((c) => ({ id: c.pointId, vector: Array.from(outcome.vectors.get(c.contentHash)!), payload: this.payload(c, version) as unknown as Record<string, unknown> }));
    for (let i = 0; i < points.length; i += this.qdrant.upsertBatchSize) {
      const batch = points.slice(i, i + this.qdrant.upsertBatchSize);
      await this.qdrant.upsertPoints(version.collection_name, batch);
      this.setIndexStatus(ready.slice(i, i + this.qdrant.upsertBatchSize), version, 'indexed', null);
      report.upserted += batch.length;
    }
    if (pendingOnes.length) this.setIndexStatus(pendingOnes, version, 'pending', null);
    if (failedOnes.length) {
      this.setIndexStatus(failedOnes, version, 'failed', 'refused by content policy (secret-like text or input too long); never sent to the embedding provider');
      report.failed += failedOnes.length;
    }
    return version;
  }

  /**
   * Compute the plan as it would be after `mutate` ran (e.g. the ingest a
   * sync would perform), then roll every write back. Used by dry runs so the
   * plan covers new and changed documents instead of only what SQLite
   * already holds. `mutate` must be synchronous.
   */
  planAfter<T>(mutate: () => T, opts: { full: boolean }): { result: T; planned: ReturnType<Indexer['plan']> } {
    const rollback = new Error('memory dry-run rollback');
    let captured: { result: T; planned: ReturnType<Indexer['plan']> } | null = null;
    try {
      this.ctx.db.transaction(() => {
        const result = mutate();
        captured = { result, planned: this.plan(opts) };
        throw rollback;
      });
    } catch (err) {
      if (err !== rollback) throw err;
    }
    return captured!;
  }

  async sync(opts: { allowPaid: boolean; dryRun?: boolean; maxEmbed?: number; signal?: AbortSignal; simulateBeforePlan?: () => void }): Promise<IndexRunReport> {
    const simulated = opts.dryRun && opts.simulateBeforePlan ? this.planAfter(opts.simulateBeforePlan, { full: false }).planned : null;
    const { plan, target, chunks, pending } = simulated ?? this.plan({ full: false });
    const report = this.emptyReport('sync', !!opts.dryRun, plan);
    if (opts.dryRun) {
      const block = this.blocker(target);
      if (block) {
        report.status = block.status;
        if (block.policy) {
          report.policy = true;
          report.policyReason = block.reason;
          report.policyFlags = block.flags ?? [];
        }
        report.messages.push(`Would skip vector indexing: ${block.reason}`);
      }
      if (simulated) report.messages.push('Plan computed after simulating this run\'s ingest (new, changed, and deleted documents included); the simulation was rolled back.');
      report.messages.push('Dry run: no network requests, no embedding calls, nothing persisted.');
      return report;
    }
    if (!(await this.prepare(report, target))) return report;
    const ready = target as Extract<EmbeddingTarget, { state: 'ready' }>;
    try {
      const expected = new Set(chunks.map((c) => c.pointId.toLowerCase()));
      report.tombstonesPropagated = await this.propagateTombstones(expected);
      const version = await this.embedAndUpsert(report, ready, pending, opts);
      if (version) {
        recordIndexState(this.ctx, version.id, { degraded: false, syncedAt: this.ctx.clock.now().toISOString() });
        recordRetrievalState(this.ctx, { method: 'hybrid', degraded: false, versionId: version.id });
      }
    } catch (err) {
      if (err instanceof AppError && (err.code === 'INTEGRATION_UNAVAILABLE' || err.code === 'PERMISSION_DENIED')) {
        return this.markDegraded(report, `Qdrant error during sync: ${errorMessage(err)}`, ready.version?.id ?? null);
      }
      throw err;
    }
    return report;
  }

  async rebuild(opts: { allowPaid: boolean; dryRun?: boolean; signal?: AbortSignal }): Promise<IndexRunReport> {
    const { plan, target, chunks } = this.plan({ full: true });
    const report = this.emptyReport('rebuild', !!opts.dryRun, plan);
    if (opts.dryRun) {
      const block = this.blocker(target);
      if (block) {
        report.status = block.status;
        if (block.policy) {
          report.policy = true;
          report.policyReason = block.reason;
          report.policyFlags = block.flags ?? [];
        }
        report.messages.push(`Would skip rebuild: ${block.reason}`);
      } else {
        report.messages.push(
          plan.cache.misses === 0
            ? `Rebuild would re-upsert ${chunks.length} chunk(s) from the embedding cache with no paid calls.`
            : `Cache incomplete: ${plan.cache.misses} unique text(s) need paid embeddings (only with --allow-paid).`,
        );
      }
      report.messages.push('Dry run: no network requests, no embedding calls, no writes.');
      return report;
    }
    if (!(await this.prepare(report, target))) return report;
    const ready = target as Extract<EmbeddingTarget, { state: 'ready' }>;
    if (!ready.version && !opts.allowPaid) {
      report.status = 'refused';
      report.messages.push('No embedding version exists yet: a rebuild needs at least one paid embedding call to establish dimensions. Re-run with --allow-paid.');
      return report;
    }
    try {
      const expected = new Set(chunks.map((c) => c.pointId.toLowerCase()));
      if (ready.version) {
        const v = ready.version;
        await this.qdrant!.ensureCollection(v.collection_name, v.dimensions, MEMORY_PAYLOAD_INDEXES);
        await this.qdrant!.deleteByFilter(v.collection_name, { must: [{ key: 'site_id', match: { value: this.ctx.siteId } }] });
        this.ctx.db.run('DELETE FROM chunk_index_status WHERE site_id = ? AND embedding_version_id = ?', [this.ctx.siteId, v.id]);
        report.messages.push(`Deleted all points for site ${this.ctx.siteId} in ${v.collection_name}; re-upserting from SQLite.`);
      }
      report.tombstonesPropagated = await this.propagateTombstones(expected, ready.version ? { skipVersionId: ready.version.id } : {});
      const version = await this.embedAndUpsert(report, ready, chunks, { allowPaid: opts.allowPaid, ...(opts.signal ? { signal: opts.signal } : {}) });
      if (version) {
        recordIndexState(this.ctx, version.id, { degraded: false, syncedAt: this.ctx.clock.now().toISOString() });
        recordRetrievalState(this.ctx, { method: 'hybrid', degraded: false, versionId: version.id });
      }
    } catch (err) {
      if (err instanceof AppError && (err.code === 'INTEGRATION_UNAVAILABLE' || err.code === 'PERMISSION_DENIED')) {
        return this.markDegraded(report, `Qdrant error during rebuild: ${errorMessage(err)}`, ready.version?.id ?? null);
      }
      throw err;
    }
    return report;
  }

  async reconcile(opts: { dryRun?: boolean } = {}): Promise<IndexRunReport & { orphanIds: string[]; missingIds: string[]; staleIds: string[] }> {
    const { plan, target, chunks } = this.plan({ full: false });
    const report = { ...this.emptyReport('reconcile', !!opts.dryRun, plan), orphanIds: [] as string[], missingIds: [] as string[], staleIds: [] as string[] };
    const block = this.blocker(target);
    if (block) {
      report.status = block.status;
      if (block.policy) {
        report.policy = true;
        report.policyReason = block.reason;
        report.policyFlags = block.flags ?? [];
      }
      report.messages.push(block.reason);
      return report;
    }
    const ready = target as Extract<EmbeddingTarget, { state: 'ready' }>;
    const version = ready.version;
    if (!version) {
      report.status = 'skipped';
      report.messages.push('Nothing to reconcile: no embedding version exists yet (run `memory sync --allow-paid`).');
      return report;
    }
    const health = await this.qdrant!.health();
    if (!health.ok) return this.markDegraded(report, `Qdrant unavailable at ${this.ctx.settings.qdrantUrl}: ${health.detail}`, version.id) as typeof report;
    try {
      if (!(await this.qdrant!.collectionExists(version.collection_name))) {
        report.missingIds = chunks.map((c) => c.pointId);
        report.messages.push(`Collection ${version.collection_name} does not exist; all ${chunks.length} point(s) are missing. Run \`memory rebuild\`.`);
        if (!opts.dryRun) this.setIndexStatus(chunks, version, 'pending', null);
        report.status = chunks.length ? 'partial' : 'ok';
        return report;
      }
      const points = await this.qdrant!.scrollAll(version.collection_name, { must: [{ key: 'site_id', match: { value: this.ctx.siteId } }] }, ['site_id', 'content_hash', 'chunk_id', 'document_id']);
      const expected = new Map(chunks.map((c) => [c.pointId.toLowerCase(), c]));
      const present = new Map<string, Record<string, unknown>>();
      for (const p of points) {
        const payload = (p.payload ?? {}) as Record<string, unknown>;
        if (payload.site_id !== this.ctx.siteId) {
          report.foreignPointsIgnored++;
          continue;
        }
        present.set(String(p.id).toLowerCase(), payload);
      }
      for (const [id, payload] of present) {
        const c = expected.get(id);
        if (!c) report.orphanIds.push(id);
        else if (payload.content_hash !== c.contentHash) report.staleIds.push(id);
      }
      for (const [id] of expected) if (!present.has(id)) report.missingIds.push(id);
      if (report.foreignPointsIgnored) report.messages.push(`${report.foreignPointsIgnored} point(s) with another site_id were returned by Qdrant and ignored (never modified).`);
      report.messages.push(`Qdrant: ${present.size} point(s) for this site; expected ${expected.size}; orphans ${report.orphanIds.length}; missing ${report.missingIds.length}; stale ${report.staleIds.length}.`);
      if (opts.dryRun) {
        report.messages.push('Dry run: nothing deleted or re-upserted.');
        return report;
      }
      if (report.orphanIds.length) {
        await this.qdrant!.deletePoints(version.collection_name, report.orphanIds);
        report.orphansDeleted = report.orphanIds.length;
      }
      const toRestore = [...report.missingIds, ...report.staleIds].map((id) => expected.get(id)!).filter(Boolean);
      if (toRestore.length) {
        await this.embedAndUpsert(report, ready, toRestore, { allowPaid: false });
        report.missingRestored = report.upserted;
      }
      // Chunks believed indexed but absent are no longer "indexed".
      recordIndexState(this.ctx, version.id, { degraded: false, reconciledAt: this.ctx.clock.now().toISOString() });
    } catch (err) {
      if (err instanceof AppError && (err.code === 'INTEGRATION_UNAVAILABLE' || err.code === 'PERMISSION_DENIED')) {
        return this.markDegraded(report, `Qdrant error during reconcile: ${errorMessage(err)}`, version.id) as typeof report;
      }
      throw err;
    }
    return report;
  }
}
