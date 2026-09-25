import { createHash } from 'node:crypto';
import type { AppContext } from '../../app/context.js';
import { PolicyDeniedError, errorMessage } from '../../core/errors.js';
import { newId, newTraceId } from '../../core/ids.js';
import { redactString } from '../../security/redact.js';
import { evidenceBundleHash } from '../../security/untrusted.js';
import { PromptRegistry, renderPrompt } from './prompts.js';
import { insertLlmCall } from './records.js';
import type { EmbedRequest, EmbedResult, EvidenceItem, LlmClient, ModelTier, StructuredRequest, StructuredResult, TextRequest, TextResult } from './types.js';

/**
 * Deterministic, offline LlmClient for demo mode and tests.
 *
 * - `synthetic = true`: every output is a SYNTHETIC fixture, never a model
 *   answer, and callers must label it as such.
 * - Outputs come only from handlers registered per prompt id. A request whose
 *   prompt id has no handler returns `needs_review` (never an invented answer).
 * - Handler output is validated with the request's schema exactly like live
 *   output; invalid fixture output returns `needs_review`.
 * - Embeddings are hash-based pseudo-vectors (fixed dimensions, L2-normalised)
 *   with the model name `synthetic-hash-embedding-v1`. They carry no meaning
 *   beyond exact-text identity and must never be mixed with real vectors.
 * - Zero network access. Cost is exactly $0 because no provider is called.
 */

export const FIXTURE_MODEL = 'synthetic-fixture-model';
export const FIXTURE_EMBEDDING_MODEL = 'synthetic-hash-embedding-v1';
export const DEFAULT_FIXTURE_EMBEDDING_DIMENSIONS = 64;

export interface FixtureRequestView {
  promptId: string;
  role: string;
  tier: ModelTier;
  variables: Record<string, unknown>;
  evidence: EvidenceItem[];
  schemaName: string | null;
  kind: 'structured' | 'text';
}

/** Returns a value to validate against the request schema (structured) or a string (text). */
export type FixtureHandler = (req: FixtureRequestView) => unknown;

export interface FixtureClientOptions {
  /** Record llm_calls rows (is_synthetic = 1) in this context's database. */
  ctx?: AppContext;
  /** Render templates from this registry when present (checks variables like live calls). */
  prompts?: PromptRegistry;
  embeddingDimensions?: number;
  /** Tiers reported as configured (default: all). */
  configured?: Array<ModelTier | 'embedding'>;
}

/** Deterministic unit vector derived from sha256 blocks of the text. */
export function hashEmbedding(text: string, dimensions: number = DEFAULT_FIXTURE_EMBEDDING_DIMENSIONS): Float32Array {
  const vec = new Float32Array(dimensions);
  let block = 0;
  let bytes = Buffer.alloc(0);
  let offset = 0;
  for (let i = 0; i < dimensions; i++) {
    if (offset + 4 > bytes.length) {
      bytes = createHash('sha256').update(`${FIXTURE_EMBEDDING_MODEL}:${block++}:`).update(text.normalize('NFC')).digest();
      offset = 0;
    }
    vec[i] = bytes.readUInt32BE(offset) / 0xffffffff - 0.5;
    offset += 4;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dimensions; i++) vec[i] = vec[i]! / norm;
  return vec;
}

export class FixtureLlmClient implements LlmClient {
  readonly synthetic = true;
  private readonly handlers: Map<string, FixtureHandler>;

  constructor(
    handlers: Record<string, FixtureHandler> | Map<string, FixtureHandler> = {},
    private readonly opts: FixtureClientOptions = {},
  ) {
    this.handlers = handlers instanceof Map ? new Map(handlers) : new Map(Object.entries(handlers));
  }

  register(promptId: string, handler: FixtureHandler): this {
    this.handlers.set(promptId, handler);
    return this;
  }

  isConfigured(tier: ModelTier | 'embedding'): boolean {
    return this.opts.configured ? this.opts.configured.includes(tier) : true;
  }

  private promptVersion(promptId: string, variables: Record<string, unknown>): string {
    const reg = this.opts.prompts;
    if (reg && reg.has(promptId)) {
      const t = reg.load(promptId);
      renderPrompt(t, variables); // same variable checks as live calls (throws on misuse)
      return t.versionString;
    }
    return `${promptId}@fixture`;
  }

  private record(input: {
    siteId: string;
    runId: string;
    traceId: string;
    role: string;
    tier: ModelTier | 'embedding';
    promptId: string;
    promptVersion: string;
    schemaName: string | null;
    evidence: EvidenceItem[];
    status: 'succeeded' | 'needs_review';
    validation: 'valid' | 'invalid' | 'not_applicable';
    error?: unknown;
    responseFormat: 'json_schema' | 'text' | 'embedding';
  }): string | undefined {
    const ctx = this.opts.ctx;
    if (!ctx) return undefined;
    if (input.siteId !== ctx.siteId) throw new PolicyDeniedError(`Fixture LLM request for site "${input.siteId}" on a context for "${ctx.siteId}"`);
    return insertLlmCall(ctx.db, {
      siteId: input.siteId,
      runId: input.runId,
      traceId: input.traceId,
      callGroupId: newId('llmgrp'),
      attempt: 1,
      role: input.role,
      tier: input.tier,
      promptId: input.promptId,
      promptVersion: input.promptVersion,
      modelRequested: input.tier === 'embedding' ? FIXTURE_EMBEDDING_MODEL : FIXTURE_MODEL,
      modelReturned: input.tier === 'embedding' ? FIXTURE_EMBEDDING_MODEL : FIXTURE_MODEL,
      params: { synthetic: true, note: 'Deterministic fixture client: no provider was called.' },
      maxOutputTokens: 0,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      costMicros: 0,
      costStatus: 'actual',
      schemaName: input.schemaName,
      validationStatus: input.validation,
      repairAttempts: 0,
      truncation: [],
      evidenceBundleHash: input.evidence.length ? evidenceBundleHash(input.evidence) : null,
      providerRequestId: null,
      reservationId: null,
      status: input.status,
      responseFormat: input.responseFormat,
      httpStatus: null,
      error: input.error ?? null,
      isSynthetic: true,
      createdAt: ctx.clock.now(),
    });
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const promptVersion = this.promptVersion(req.promptId, req.variables);
    const traceId = req.traceId ?? newTraceId();
    const base = { siteId: req.siteId, runId: req.runId, traceId, role: req.role, tier: req.tier, promptId: req.promptId, promptVersion, schemaName: req.schemaName, evidence: req.evidence, responseFormat: 'json_schema' as const };
    const handler = this.handlers.get(req.promptId);
    if (!handler) {
      const callId = this.record({ ...base, status: 'needs_review', validation: 'not_applicable', error: { message: 'no fixture handler' } });
      return {
        ok: false,
        status: 'needs_review',
        reason: `SYNTHETIC fixture client has no handler for prompt "${req.promptId}"; no output was invented.`,
        nextStep: 'Register a fixture handler for this prompt id (demo/tests) or configure the live LLM Gateway.',
        ...(callId ? { callId } : {}),
      };
    }
    let raw: unknown;
    try {
      raw = await handler({ promptId: req.promptId, role: req.role, tier: req.tier, variables: req.variables, evidence: req.evidence, schemaName: req.schemaName, kind: 'structured' });
    } catch (err) {
      const callId = this.record({ ...base, status: 'needs_review', validation: 'invalid', error: { message: errorMessage(err) } });
      return { ok: false, status: 'needs_review', reason: `SYNTHETIC fixture handler for "${req.promptId}" failed: ${redactString(errorMessage(err))}`, ...(callId ? { callId } : {}) };
    }
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) {
      const errors = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      const callId = this.record({ ...base, status: 'needs_review', validation: 'invalid', error: { validationErrors: errors } });
      return { ok: false, status: 'needs_review', reason: `SYNTHETIC fixture output for "${req.promptId}" failed schema ${req.schemaName}: ${errors.join('; ')}`, lastRawOutput: JSON.stringify(raw).slice(0, 2000), ...(callId ? { callId } : {}) };
    }
    const callId = this.record({ ...base, status: 'succeeded', validation: 'valid' }) ?? newId('llmfix');
    return {
      ok: true,
      value: parsed.data,
      callId,
      model: FIXTURE_MODEL,
      promptVersion,
      usage: { inputTokens: null, outputTokens: null, reasoningTokens: null },
      costMicros: 0,
      repairAttempts: 0,
      truncation: [],
    };
  }

  async text(req: TextRequest): Promise<TextResult> {
    const promptVersion = this.promptVersion(req.promptId, req.variables);
    const traceId = req.traceId ?? newTraceId();
    const base = { siteId: req.siteId, runId: req.runId, traceId, role: req.role, tier: req.tier, promptId: req.promptId, promptVersion, schemaName: null, evidence: req.evidence, responseFormat: 'text' as const };
    const handler = this.handlers.get(req.promptId);
    if (!handler) {
      const callId = this.record({ ...base, status: 'needs_review', validation: 'not_applicable', error: { message: 'no fixture handler' } });
      return { ok: false, status: 'needs_review', reason: `SYNTHETIC fixture client has no handler for prompt "${req.promptId}"; no output was invented.`, ...(callId ? { callId } : {}) };
    }
    let out: unknown;
    try {
      out = await handler({ promptId: req.promptId, role: req.role, tier: req.tier, variables: req.variables, evidence: req.evidence, schemaName: null, kind: 'text' });
    } catch (err) {
      return { ok: false, status: 'needs_review', reason: `SYNTHETIC fixture handler for "${req.promptId}" failed: ${redactString(errorMessage(err))}` };
    }
    if (typeof out !== 'string' || !out.trim()) {
      const callId = this.record({ ...base, status: 'needs_review', validation: 'invalid', error: { message: 'fixture text output must be a non-empty string' } });
      return { ok: false, status: 'needs_review', reason: `SYNTHETIC fixture output for "${req.promptId}" is not a non-empty string.`, ...(callId ? { callId } : {}) };
    }
    const callId = this.record({ ...base, status: 'succeeded', validation: 'not_applicable' }) ?? newId('llmfix');
    return { ok: true, text: out, callId, model: FIXTURE_MODEL, promptVersion, usage: { inputTokens: null, outputTokens: null, reasoningTokens: null }, costMicros: 0, truncation: [] };
  }

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    const dims = this.opts.embeddingDimensions ?? DEFAULT_FIXTURE_EMBEDDING_DIMENSIONS;
    const vectors = req.texts.map((t) => hashEmbedding(t, dims));
    this.record({ siteId: req.siteId, runId: req.runId, traceId: newTraceId(), role: 'embedder', tier: 'embedding', promptId: 'embeddings', promptVersion: 'embeddings@fixture', schemaName: null, evidence: [], status: 'succeeded', validation: 'not_applicable', responseFormat: 'embedding' });
    return { ok: true, vectors, model: FIXTURE_EMBEDDING_MODEL, dimensions: dims, usage: { inputTokens: null, outputTokens: null, reasoningTokens: null }, costMicros: 0 };
  }
}

/** Deterministic synthetic LlmClient keyed by prompt id (demo/tests; zero network). */
export function createFixtureLlmClient(handlers: Record<string, FixtureHandler> | Map<string, FixtureHandler> = {}, opts: FixtureClientOptions = {}): FixtureLlmClient {
  return new FixtureLlmClient(handlers, opts);
}
