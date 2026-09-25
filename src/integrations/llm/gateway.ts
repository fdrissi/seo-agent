import type { z } from 'zod';
import type { AppContext } from '../../app/context.js';
import type { ApprovalGate } from '../../approvals/types.js';
import type { CostEstimate } from '../../budgets/types.js';
import { PolicyDeniedError, ValidationError, errorMessage, isAppError } from '../../core/errors.js';
import { hashObject } from '../../core/hash.js';
import { newId, newTraceId } from '../../core/ids.js';
import { formatUsd, type Micros } from '../../core/money.js';
import { recordAudit } from '../../database/audit.js';
import { redactPersonalIdentifiers } from '../../memory/sanitize.js';
import { redactString } from '../../security/redact.js';
import { createDefaultToolRegistry, createReadOnlyQuery, type ToolContext, type ToolExecution, type ToolRegistry, type ToolSiteProfile } from '../../security/tools.js';
import { detectInjectionSignals, estimateTokens, newBoundaryToken, renderEvidenceBundle, sanitizeModelData, truncateToTokens, wrapDataBlock, type DataBlockMeta, type RenderedEvidence } from '../../security/untrusted.js';
import type { FetchLike } from '../types.js';
import { authHeaders, checkGatewayBaseUrl, classifyHttpFailure, fetchWithTimeout, gatewayUrl, parseErrorEnvelope, reconcileNextStep, TransportError } from './http.js';
import { baseInfo, deriveCapabilities, discoverModels, findModel, DEFAULT_CATALOG_MAX_AGE_MS, type DiscoveryResult, type ModelCapabilities, type ModelCatalog, type ProviderMapping } from './models.js';
import { buildChatBody, clampMaxTokens, decideResponseFormat, sanitizeSchemaName, zodToJsonSchema, type BuiltChatBody, type ChatMessage, type JsonSchemaInfo, type ReasoningEffort, type ResponseFormatMode } from './params.js';
import { actualChatCost, actualEmbeddingCost, estimateChatCost, estimateEmbeddingCost, parseUsage, resolvePrices, type ActualCost, type ResolvedPrices } from './pricing.js';
import { EVIDENCE_SLOT, PromptRegistry, renderPrompt, type PromptTemplate } from './prompts.js';
import { insertLlmCall, updateLlmCallOutcome, type LlmCallRecord } from './records.js';
import {
  OUTPUT_TRUNCATION_ID,
  type EmbedFailureBilling,
  type EmbedRequest,
  type EmbedResult,
  type LlmClient,
  type LlmFailureDetails,
  type LlmFailureStatus,
  type LlmUsage,
  type ModelTier,
  type StructuredRequest,
  type StructuredResult,
  type TextRequest,
  type TextResult,
  type TruncationInfo,
} from './types.js';

/**
 * LLM Gateway client (OpenAI-compatible; contract in
 * docs/integration-contracts.md §1).
 *
 * Every chat request:
 *   feature/credential/model preflight (no network) -> verify the configured
 *   model in the (cached, free) /v1/models catalog -> render the versioned
 *   prompt + evidence inside untrusted-data blocks within llm.maxInputTokens
 *   -> capability-driven parameters (never sending unsupported params) ->
 *   conservative cost upper bound -> budgets.reserve -> requests.prepare ->
 *   POST (client timeout, no automatic retry) -> reconcile with
 *   gateway-reported cost, else cost computed from usage with verified
 *   prices, else unknown (never $0) -> llm_calls row -> client-side schema
 *   validation with at most llm.maxRepairAttempts (<= 2) budgeted repairs ->
 *   `needs_review`.
 *
 * Remote content can only ever appear inside the user message's data blocks
 * (or tool results, also wrapped as data). System prompts, the tool list,
 * budgets, permissions, configuration, and approvals are built from code.
 */

export interface GatewayClientOptions {
  fetch?: FetchLike;
  /** Task prompt templates (default: the application's prompts/ directory). */
  prompts?: PromptRegistry;
  /** Base system.* prompts (default: the application's prompts/ directory). */
  systemPrompts?: PromptRegistry;
  /** Allowlisted read-only tools (default: built-in read-only tools). */
  tools?: ToolRegistry;
  /**
   * Client-side timeout for the free GET calls (default: llm.requestTimeoutMs
   * from the site config). Also used for paid POSTs when
   * `paidRequestTimeoutMs` is not set.
   */
  timeoutMs?: number;
  /**
   * Client-side timeout for paid POSTs (chat completions, embeddings). Default
   * DEFAULT_PAID_REQUEST_TIMEOUT_MS: a little above the gateway's documented
   * 10-minute non-streaming limit, so the client does not abort a request the
   * gateway is still processing (and billing), which would turn it into an
   * ambiguous submission.
   */
  paidRequestTimeoutMs?: number;
  catalogMaxAgeMs?: number;
  /** Temperature per tier; sent only when the model lists `temperature` (default: cheap 0, reasoning unset). */
  temperature?: Partial<Record<ModelTier, number>>;
  /** reasoning_effort per tier; sent only when every provider mapping accepts the value (default: unset). */
  reasoningEffort?: Partial<Record<ModelTier, ReasoningEffort>>;
  /**
   * Extra tokens budgeted for hidden reasoning on models that can reason
   * (default: equal to the request's max output tokens). Whether max_tokens
   * bounds reasoning tokens differs by provider and is unverified, so the
   * upper bound adds this allowance.
   */
  reasoningTokenAllowance?: number;
  /**
   * Provider ids (as listed in `providers[].providerId` by `models list`) for
   * which the allowance is also sent as `reasoning.max_tokens`. The contract
   * documents that field for Anthropic and Google thinking models; whether it
   * bounds billed reasoning tokens is UNVERIFIED, so nothing is assumed:
   * default none. It is sent only when every applicable provider mapping of
   * the model is listed here and supports reasoning.
   */
  reasoningMaxTokensProviders?: string[];
  /**
   * What to do when a model can reason but no request field bounds its hidden
   * reasoning tokens: 'assume_allowance' (default) reserves the assumed
   * allowance and labels the estimate as an assumption; 'require_approval'
   * treats the price as unknown (skip unless an unknown-price approval is
   * verified), as spec section 25 asks when no safe bound exists.
   */
  unboundedReasoning?: 'assume_allowance' | 'require_approval';
  /**
   * Approval gate used to request, verify, and consume one-time approvals for
   * requests whose price is unknown. Without it such requests are always
   * skipped (an approval id alone authorizes nothing).
   */
  approvals?: ApprovalGate;
  /**
   * Explicit request to shorten embeddings to this many dimensions (sent as
   * `dimensions`). The contract says `dimensions` works only on models that
   * support shortening, so it is never sent otherwise. `models.embeddingDimensions`
   * is only used to verify returned vectors.
   */
  embeddingRequestDimensions?: number;
  /** Maximum rounds of tool calls per logical request (default 3). */
  maxToolRounds?: number;
  /** Maximum inputs per embeddings request (no documented cap; default 64). */
  embedBatchSize?: number;
  /** Random boundary token factory (tests may pin it). */
  boundaryToken?: () => string;
  /** Opt into the gateway's response-healing plugin for JSON modes (default off). */
  responseHealing?: boolean;
  /** Optional X-Source attribution header (validated; a malformed value fails requests with 400). */
  xSource?: string;
  /**
   * Hard cap for any single request's cost upper bound (USD micros), checked
   * before reserving. Used by explicit paid checks (`models test --max-usd`).
   * A request whose upper bound is unknown or above the cap is not sent.
   */
  maxCostPerRequestMicros?: number;
}

type Failure = { ok: false; status: LlmFailureStatus; reason: string; callId?: string; lastRawOutput?: string } & LlmFailureDetails;

const MESSAGE_OVERHEAD_TOKENS = 8;
const REPAIR_RESERVE_TOKENS = 1_000;
const TOOL_RESERVE_TOKENS = 1_500;
const MIN_EVIDENCE_TOKENS = 64;
const MIN_TOOL_RESULT_TOKENS = 32;
const MAX_RAW_OUTPUT_CHARS = 4_000;
/** Gateway hard timeout for non-streaming requests (docs/integration-contracts.md §1, LG18). */
export const GATEWAY_NON_STREAMING_TIMEOUT_MS = 600_000;
/** Default client timeout for paid POSTs: a little above the gateway's own limit. */
export const DEFAULT_PAID_REQUEST_TIMEOUT_MS = GATEWAY_NON_STREAMING_TIMEOUT_MS + 10_000;
const BOUNDARY_PLACEHOLDER = '<BOUNDARY>';

export type LlmPaidEndpoint = 'chat.completions' | 'embeddings';

/**
 * Hash of the exact request body an unknown-price approval is bound to. The
 * per-request random boundary token is replaced by a fixed placeholder so the
 * same logical request (same model, prompt, evidence, limits, schema, tools)
 * hashes identically when it is re-run after approval.
 */
export function approvalRequestHash(endpoint: LlmPaidEndpoint, body: Record<string, unknown>, boundary?: string): string {
  const json = JSON.stringify(body);
  const normalized = boundary ? json.split(boundary).join(BOUNDARY_PLACEHOLDER) : json;
  return hashObject({ endpoint, body: JSON.parse(normalized) as unknown });
}

/**
 * Approval artifact hash for a paid request with unknown price. Mirrors the
 * `paid_request` binding used by src/approvals/budget-approvals.ts (provider,
 * endpoint, request hash, maximum charge), so approvals created there for LLM
 * Gateway requests verify here too.
 */
export function paidRequestArtifactHash(endpoint: LlmPaidEndpoint, requestHash: string, maxChargeMicros: Micros): string {
  return hashObject({ kind: 'paid_request', provider: 'llm_gateway', endpoint, requestHash, maxChargeMicros });
}
const X_SOURCE_RE = /^[A-Za-z0-9.\/-]{1,200}$/;

function fail(status: LlmFailureStatus, reason: string, details: LlmFailureDetails & { callId?: string; lastRawOutput?: string } = {}): Failure {
  return { ok: false, status, reason: redactString(reason), ...details };
}

function tierEnv(tier: ModelTier | 'embedding'): string {
  return tier === 'cheap' ? 'CHEAP_MODEL' : tier === 'reasoning' ? 'REASONING_MODEL' : 'EMBEDDING_MODEL';
}

/** Extract a JSON value from model text (tolerates code fences and surrounding prose). */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'the response was empty' };
  const candidates: string[] = [trimmed];
  const fence = /```(?:json)?\s*\n?([\s\S]*?)\n?```/i.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const firstObj = trimmed.search(/[[{]/);
  if (firstObj >= 0) {
    const open = trimmed[firstObj]!;
    const close = open === '{' ? '}' : ']';
    const last = trimmed.lastIndexOf(close);
    if (last > firstObj) candidates.push(trimmed.slice(firstObj, last + 1));
  }
  let lastErr = '';
  for (const c of candidates) {
    try {
      return { ok: true, value: JSON.parse(c) };
    } catch (err) {
      lastErr = errorMessage(err);
    }
  }
  return { ok: false, error: `the response is not valid JSON (${lastErr})` };
}

/** Validate model output against the request's zod schema; errors are formatted for a repair turn. */
export function validateOutput<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; errors: string[] } {
  const parsed = extractJson(text);
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };
  const r = schema.safeParse(parsed.value);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, errors: r.error.issues.slice(0, 20).map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`) };
}

interface ChatCallOk {
  ok: true;
  callId: string;
  message: { content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; reasoning_details?: unknown };
  finishReason: string | null;
  usage: LlmUsage;
  cost: ActualCost;
  modelReturned: string | null;
}

interface ChatContext {
  runId: string;
  traceId: string;
  callGroupId: string;
  role: string;
  tier: ModelTier;
  promptId: string;
  promptVersion: string;
  systemPromptVersions: string[];
  modelId: string;
  caps: ModelCapabilities;
  catalog: ModelCatalog;
  modelWarnings: string[];
  schemaName: string | null;
  bundle: RenderedEvidence;
  /** Per-request random boundary token (normalized out of approval hashes). */
  boundary: string;
  /** Evidence truncation plus any tool-result truncation so far (recorded on every later call). */
  truncation: TruncationInfo[];
  /** Personal identifiers are sent unmasked (site config llm.allowPersonalData with a documented reason). */
  allowPersonalData: boolean;
  reasoningAllowance: number;
  /** How hidden reasoning tokens are bounded: not applicable, by a sent request field, or only by assumption. */
  reasoningBound: ReasoningBound;
  unknownPriceApprovalId?: string;
  unknownPriceMaxChargeMicros?: Micros;
  signal?: AbortSignal;
}

type ReasoningBound = 'none' | 'request_param' | 'assumed';

function sumOrNull(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

/**
 * Sum usage across the requests of one logical call. Input/output totals are
 * null (unknown) when any request did not report them; reasoning tokens stay
 * null unless at least one request reported them.
 */
function addUsage(total: LlmUsage | null, u: LlmUsage): LlmUsage {
  if (!total) return { ...u };
  return {
    inputTokens: sumOrNull(total.inputTokens, u.inputTokens),
    outputTokens: sumOrNull(total.outputTokens, u.outputTokens),
    reasoningTokens: total.reasoningTokens === null && u.reasoningTokens === null ? null : (total.reasoningTokens ?? 0) + (u.reasoningTokens ?? 0),
  };
}

export class GatewayLlmClient implements LlmClient {
  readonly synthetic = false;
  private readonly fetchFn: FetchLike;
  private readonly prompts: PromptRegistry;
  private readonly systemPrompts: PromptRegistry;
  private readonly tools: ToolRegistry;
  private refreshedForMissingModel = false;
  private discovery: Promise<DiscoveryResult> | null = null;
  private discoveryStartedAt = 0;

  constructor(
    private readonly ctx: AppContext,
    private readonly opts: GatewayClientOptions = {},
  ) {
    this.fetchFn = opts.fetch ?? ctx.fetch;
    this.prompts = opts.prompts ?? new PromptRegistry();
    this.systemPrompts = opts.systemPrompts ?? new PromptRegistry();
    this.tools = opts.tools ?? createDefaultToolRegistry();
    if (opts.xSource !== undefined && !X_SOURCE_RE.test(opts.xSource)) throw new ValidationError('xSource may contain only letters, digits, hyphens, dots, and slashes');
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  isConfigured(tier: ModelTier | 'embedding'): boolean {
    const feature = tier === 'embedding' ? 'embeddings' : 'llm';
    if (!this.ctx.settings.features[feature]) return false;
    if (!this.ctx.secrets.has('LLM_GATEWAY_API_KEY')) return false;
    const m = this.ctx.settings.models;
    return !!(tier === 'cheap' ? m.cheap : tier === 'reasoning' ? m.reasoning : m.embedding);
  }

  private preflight(tier: ModelTier | 'embedding'): { ok: true; apiKey: string; modelId: string } | Failure {
    const ctx = this.ctx;
    const feature = tier === 'embedding' ? 'embeddings' : 'llm';
    if (!ctx.settings.features[feature]) {
      return fail('disabled', `The "${feature}" feature is disabled for site ${ctx.siteId} (profile ${ctx.config.profile}); no model call was made.`, {
        nextStep: `Set features.${feature}: true in the site config to enable it.`,
      });
    }
    if (ctx.offline) {
      return fail('disabled', 'Network access is disabled (offline/demo mode); no model call was made.', { nextStep: 'Run without --offline, or use the synthetic fixture client in demo mode.' });
    }
    const base = checkGatewayBaseUrl(ctx.settings.llmBaseUrl);
    if (!base.ok) return fail('not_configured', base.reason, { nextStep: base.nextStep });
    const apiKey = ctx.secrets.get('LLM_GATEWAY_API_KEY');
    if (!apiKey) {
      return fail('not_configured', 'LLM_GATEWAY_API_KEY is not set; no model call was made.', {
        nextStep: 'Create a dedicated LLM Gateway project key (docs/ACCESS_SETUP.md) and put LLM_GATEWAY_API_KEY in <workspace>/secrets/secrets.env or your password-manager environment. Never paste it into chat.',
      });
    }
    const m = ctx.settings.models;
    const modelId = tier === 'cheap' ? m.cheap : tier === 'reasoning' ? m.reasoning : m.embedding;
    if (!modelId) {
      return fail('not_configured', `${tierEnv(tier)} is not set; no model call was made.`, {
        nextStep: `Run \`npm run cli -- models list\` and set ${tierEnv(tier)} (environment or secrets.env) or models.${tier} in the site config to a listed model id.`,
      });
    }
    return { ok: true, apiKey, modelId };
  }

  /**
   * Discovery memoized per client (bounded-parallel calls share one catalog
   * request); re-discovered when the catalog ages past the freshness window.
   */
  private discover(force = false): Promise<DiscoveryResult> {
    const maxAgeMs = this.opts.catalogMaxAgeMs ?? DEFAULT_CATALOG_MAX_AGE_MS;
    const now = this.ctx.clock.now().getTime();
    if (!force && this.discovery && now - this.discoveryStartedAt < maxAgeMs) return this.discovery;
    const p = discoverModels(this.ctx, { fetch: this.fetchFn, maxAgeMs, ...(force ? { force: true } : {}), ...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}) });
    this.discovery = p;
    this.discoveryStartedAt = now;
    p.then(
      (r) => {
        if (!r.ok || r.warning) this.discovery = null; // do not pin failures or stale fallbacks
      },
      () => {
        this.discovery = null;
      },
    );
    return p;
  }

  private async resolveModel(modelId: string, kind: 'chat' | 'embedding'): Promise<{ ok: true; caps: ModelCapabilities; catalog: ModelCatalog; warnings: string[] } | Failure> {
    const ctx = this.ctx;
    let r = await this.discover();
    if (!r.ok) {
      return fail(r.state === 'unauthorized' || r.state === 'misconfigured' ? 'not_configured' : 'provider_error', `Cannot verify model "${modelId}" before use: ${r.reason}`, { nextStep: r.nextStep });
    }
    let found = findModel(r.catalog, modelId, ctx.clock.now());
    if (!found.ok && r.catalog.source === 'cache' && !this.refreshedForMissingModel) {
      // The model may have been added since the cached catalog was retrieved.
      this.refreshedForMissingModel = true;
      const fresh = await this.discover(true);
      if (fresh.ok) {
        r = fresh;
        found = findModel(fresh.catalog, modelId, ctx.clock.now());
      }
    }
    if (!found.ok) {
      return fail('invalid_model', `${found.reason}.${found.similar.length ? ` Listed ids with similar names (NOT substituted automatically): ${found.similar.join(', ')}.` : ''}`, { nextStep: found.nextStep });
    }
    const warnings = [...found.warnings, ...(r.warning ? [r.warning] : [])];
    if (kind === 'embedding' && !found.caps.isEmbedding) {
      return fail('invalid_model', `"${modelId}" is not an embedding model (its catalog entry lacks the "embedding" output modality).`, { nextStep: 'Set EMBEDDING_MODEL to an embedding model from `models list`.' });
    }
    if (kind === 'chat' && found.caps.isEmbedding) {
      return fail('invalid_model', `"${modelId}" is an embedding model and cannot serve chat requests.`, { nextStep: 'Set CHEAP_MODEL / REASONING_MODEL to chat models from `models list`.' });
    }
    return { ok: true, caps: found.caps, catalog: r.catalog, warnings };
  }

  /**
   * Personal-identifier policy for model-bound data. Masked by default; sent
   * unmasked only when the site config sets llm.allowPersonalData: true AND
   * documents why in llm.personalDataReason (spec section 26: only with an
   * explicit configured need and authorization).
   */
  private personalDataPolicy(): { allowed: boolean; reason: string | null } {
    const llm = (this.ctx.config.llm ?? {}) as { allowPersonalData?: unknown; personalDataReason?: unknown };
    const reason = typeof llm.personalDataReason === 'string' && llm.personalDataReason.trim() ? llm.personalDataReason.trim() : null;
    return { allowed: llm.allowPersonalData === true && reason !== null, reason };
  }

  private renderSystem(id: string, values: Record<string, string>): { text: string; version: string } {
    const t = this.systemPrompts.load(id);
    const r = renderPrompt(t, {}, { systemValues: values });
    return { text: r.system, version: t.versionString };
  }

  private renderSystemUser(id: string, variables: Record<string, unknown>): { system: string; user: string; version: string } {
    const t = this.systemPrompts.load(id);
    const r = renderPrompt(t, variables);
    return { system: r.system, user: r.user, version: t.versionString };
  }

  private toolContext(runId: string, traceId: string): ToolContext {
    const c = this.ctx.config;
    const site: ToolSiteProfile = {
      id: c.site.id,
      businessName: c.site.businessName,
      url: c.site.url,
      offer: c.business.offer,
      targetCustomer: c.business.targetCustomer,
      differentiators: [...c.business.differentiators],
      productFacts: c.business.productFacts.map((f) => ({ ...f })),
      approvedClaims: [...c.business.approvedClaims],
      prohibitedClaims: [...c.business.prohibitedClaims],
      languages: [...c.market.languages],
      countries: [...c.market.countries],
    };
    const clock = this.ctx.clock;
    return Object.freeze({ siteId: this.ctx.siteId, runId, traceId, query: createReadOnlyQuery(this.ctx.db, this.ctx.siteId), site: Object.freeze(site), now: () => clock.now() });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const r = await this.runChat(req, { structured: true, schema: req.schema, schemaName: req.schemaName });
    if (!r.ok) return r;
    return {
      ok: true,
      value: r.value as T,
      callId: r.callId,
      model: r.model,
      promptVersion: r.promptVersion,
      usage: r.usage,
      costMicros: r.costMicros,
      repairAttempts: r.repairAttempts,
      truncation: r.truncation,
    };
  }

  async text(req: TextRequest): Promise<TextResult> {
    const r = await this.runChat(req, { structured: false });
    if (!r.ok) {
      const { lastRawOutput: _omit, ...rest } = r;
      return rest;
    }
    return {
      ok: true,
      text: r.value as string,
      callId: r.callId,
      model: r.model,
      promptVersion: r.promptVersion,
      usage: r.usage,
      costMicros: r.costMicros,
      truncation: r.truncation,
      ...(r.outputTruncated ? { outputTruncated: true } : {}),
    };
  }

  private async runChat(
    req: StructuredRequest<unknown> | TextRequest,
    kind: { structured: true; schema: z.ZodType<unknown>; schemaName: string } | { structured: false },
  ): Promise<
    | { ok: true; value: unknown; callId: string; model: string; promptVersion: string; usage: LlmUsage; costMicros: Micros | null; repairAttempts: number; truncation: TruncationInfo[]; outputTruncated?: boolean }
    | Failure
  > {
    const ctx = this.ctx;
    if (req.siteId !== ctx.siteId) throw new PolicyDeniedError(`LLM request for site "${req.siteId}" was issued on a context for site "${ctx.siteId}"`, { requestSite: req.siteId });
    const runId = req.runId || ctx.runId;
    const traceId = req.traceId ?? newTraceId();

    // Programming errors (unknown prompt/variables/tools, schema mismatch) throw before any spend.
    const template: PromptTemplate = this.prompts.load(req.promptId);
    if (kind.structured && template.outputSchema !== 'text' && template.outputSchema !== kind.schemaName) {
      throw new ValidationError(`Prompt "${template.id}" declares output_schema "${template.outputSchema}" but the request uses schema "${kind.schemaName}"`);
    }
    const rendered = renderPrompt(template, req.variables);
    const allowedTools = this.tools.resolveAllowlist(req.tools);

    const pre = this.preflight(req.tier);
    if (!pre.ok) return pre;
    const resolved = await this.resolveModel(pre.modelId, 'chat');
    if (!resolved.ok) return resolved;
    const { caps, catalog } = resolved;

    // Token ceilings.
    const tierMax = req.tier === 'cheap' ? ctx.config.llm.maxOutputTokensCheap : ctx.config.llm.maxOutputTokensReasoning;
    const maxOutput = clampMaxTokens(Math.min(req.maxOutputTokens ?? tierMax, tierMax), caps);
    const reasoningAllowance = caps.reasoningPossible ? Math.max(0, Math.floor(this.opts.reasoningTokenAllowance ?? maxOutput)) : 0;
    const reasoningBound = this.reasoningBound(caps, reasoningAllowance);
    const contextCeiling = caps.contextLength ? caps.contextLength - maxOutput - reasoningAllowance : Number.POSITIVE_INFINITY;
    const inputCeiling = Math.min(ctx.config.llm.maxInputTokens, contextCeiling);
    // Without a safe price bound every HTTP request needs its own verified approval, so no
    // follow-up requests (repairs, tool rounds) are planned for this call.
    const priceUnknown = resolvePrices(caps, ctx.config, pre.modelId, catalog.retrievedAt).source === 'unknown' || (reasoningBound === 'assumed' && this.opts.unboundedReasoning === 'require_approval');
    const maxRepairs = kind.structured && !priceUnknown ? Math.min(2, Math.max(0, ctx.config.llm.maxRepairAttempts)) : 0;
    const maxToolRounds = Math.max(0, this.opts.maxToolRounds ?? 3);

    // Output format.
    const jsonSchema: JsonSchemaInfo | null = kind.structured ? zodToJsonSchema(kind.schema) : null;
    const format: ResponseFormatMode = decideResponseFormat(caps, kind.structured, jsonSchema);
    const schemaName = kind.structured ? sanitizeSchemaName(kind.schemaName) : null;

    // System message: code-controlled parts only.
    const boundary = (this.opts.boundaryToken ?? newBoundaryToken)();
    const policy = this.renderSystem('system.untrusted-data', { boundary });
    const systemParts = [policy.text, rendered.system];
    const systemVersions = [policy.version];
    if (kind.structured && (format === 'json_object' || format === 'prompt')) {
      const so = this.renderSystem('system.structured-output', {
        schema_name: schemaName!,
        json_schema: jsonSchema ? JSON.stringify(jsonSchema.schema, null, 2) : '(not representable as JSON Schema; follow the output description in the task instructions exactly)',
      });
      systemParts.push(so.text);
      systemVersions.push(so.version);
    }
    const toolSpecs = allowedTools.length && caps.tools === true && maxToolRounds > 0 && !priceUnknown ? this.tools.specs(allowedTools) : [];
    const toolsOmittedReason =
      allowedTools.length && !toolSpecs.length
        ? caps.tools !== true
          ? `model "${pre.modelId}" does not verifiably support tools on every provider mapping`
          : maxToolRounds === 0
            ? 'maxToolRounds is 0'
            : 'the price is unknown, so follow-up tool rounds (each needing its own approval) are not offered'
        : null;
    if (toolSpecs.length) {
      const tp = this.renderSystem('system.tools', { tool_names: allowedTools.join(', '), max_tool_rounds: String(maxToolRounds) });
      systemParts.push(tp.text);
      systemVersions.push(tp.version);
    }
    const system = systemParts.join('\n\n');

    // Evidence within the remaining input budget. The slot is split out (never String.replace with
    // untrusted replacement text: `$'`, `$&`, `$$`... are replacement patterns).
    const slotParts = rendered.hasEvidencePlaceholder ? rendered.user.split(EVIDENCE_SLOT) : [rendered.user];
    const userWithoutEvidence = slotParts.join('');
    const toolSpecTokens = toolSpecs.length ? estimateTokens(JSON.stringify(toolSpecs)) : 0;
    const schemaTokens = format === 'json_schema' && jsonSchema ? estimateTokens(JSON.stringify(jsonSchema.schema)) : 0;
    const fixedTokens = estimateTokens(system) + estimateTokens(userWithoutEvidence) + toolSpecTokens + schemaTokens + MESSAGE_OVERHEAD_TOKENS * 4;
    const evidenceBudget = inputCeiling - fixedTokens - (maxRepairs > 0 ? REPAIR_RESERVE_TOKENS : 0) - (toolSpecs.length ? TOOL_RESERVE_TOKENS : 0);
    if (evidenceBudget < MIN_EVIDENCE_TOKENS) {
      return fail('unsupported', `The prompt (~${fixedTokens} tokens before evidence) does not fit the input ceiling of ${inputCeiling} tokens (llm.maxInputTokens=${ctx.config.llm.maxInputTokens}${Number.isFinite(contextCeiling) ? `, model context ${caps.contextLength}` : ''}); no model call was made.`, {
        nextStep: 'Raise llm.maxInputTokens in the site config, shorten the template, or use a model with a larger context window.',
      });
    }
    const personalData = this.personalDataPolicy();
    const bundle = renderEvidenceBundle(req.evidence, {
      boundary,
      maxTokens: evidenceBudget,
      ceilingLabel: `llm.maxInputTokens=${ctx.config.llm.maxInputTokens}${contextCeiling < ctx.config.llm.maxInputTokens ? `, model context ${caps.contextLength}` : ''}`,
      allowPersonalData: personalData.allowed,
    });
    if ((req.evidence.length && !bundle.includedIds.length) || bundle.estimatedTokens > evidenceBudget) {
      return fail('unsupported', `No evidence item fits within the input ceiling (${evidenceBudget} tokens left for evidence after the prompt; ${req.evidence.length} item(s) supplied); no model call was made.`, {
        truncation: bundle.truncation,
        nextStep: 'Send fewer or shorter evidence items, raise llm.maxInputTokens, or use a model with a larger context window.',
      });
    }
    const user = rendered.hasEvidencePlaceholder ? `${slotParts[0]}${bundle.text}${slotParts.slice(1).join('')}` : `${rendered.user}\n\n${bundle.text}`;
    // Defensive re-check of the final message against the real ceiling (the bundle was sized alone).
    const finalTokens = estimateTokens(system) + estimateTokens(user) + toolSpecTokens + schemaTokens + MESSAGE_OVERHEAD_TOKENS * 4;
    if (finalTokens > inputCeiling) {
      return fail('unsupported', `The rendered prompt (~${finalTokens} tokens) exceeds the input ceiling of ${inputCeiling} tokens; no model call was made.`, {
        truncation: bundle.truncation,
        nextStep: 'Send fewer or shorter evidence items, raise llm.maxInputTokens, or use a model with a larger context window.',
      });
    }
    // Template variables are meant to hold code-computed values only (externally sourced text belongs in
    // the evidence bundle), but a caller can still pass text that came from outside code. They are scanned
    // with the same heuristic detector as evidence so such a slip is audited, not silently sent.
    const variableSignals = variableInjectionSignals(req.variables);
    if (Object.keys(bundle.injectionSignals).length || Object.keys(variableSignals).length) {
      ctx.logger.warn('Possible prompt-injection text in evidence or template variables (treated as data)', { promptId: req.promptId, traceId, signals: bundle.injectionSignals, ...(Object.keys(variableSignals).length ? { variableSignals } : {}) });
      recordAudit(ctx.db, {
        siteId: ctx.siteId,
        actor: 'system',
        eventType: 'llm.injection_signals',
        subjectType: 'llm_trace',
        subjectId: traceId,
        traceId,
        details: { promptId: req.promptId, signals: bundle.injectionSignals, ...(Object.keys(variableSignals).length ? { variableSignals } : {}) },
        at: ctx.clock.now(),
      });
    }

    const cc: ChatContext = {
      runId,
      traceId,
      callGroupId: newId('llmgrp'),
      role: req.role,
      tier: req.tier,
      promptId: template.id,
      promptVersion: template.versionString,
      systemPromptVersions: systemVersions,
      modelId: pre.modelId,
      caps,
      catalog,
      modelWarnings: [...resolved.warnings, ...(toolsOmittedReason ? [`tools omitted: ${toolsOmittedReason}`] : [])],
      schemaName,
      bundle,
      boundary,
      truncation: [...bundle.truncation],
      allowPersonalData: personalData.allowed,
      reasoningAllowance,
      reasoningBound,
      ...(req.unknownPriceApprovalId ? { unknownPriceApprovalId: req.unknownPriceApprovalId } : {}),
      ...(req.unknownPriceMaxChargeMicros !== undefined ? { unknownPriceMaxChargeMicros: req.unknownPriceMaxChargeMicros } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
    };

    const exchange: ChatMessage[] = [];
    let repairMessages: ChatMessage[] = [];
    let repairSystem = '';
    let repairs = 0;
    let toolRounds = 0;
    let attempt = 0;
    let totals: LlmUsage | null = null;
    let totalCost: Micros | null = 0;
    let lastCallId: string | undefined;
    const toolCtx = toolSpecs.length ? this.toolContext(runId, traceId) : null;
    const allowedSet = new Set(toolSpecs.length ? allowedTools : []);

    while (true) {
      attempt++;
      const toolsThisRound = toolSpecs.length && toolRounds < maxToolRounds ? toolSpecs : [];
      const messages: ChatMessage[] = [{ role: 'system', content: repairSystem ? `${system}\n\n${repairSystem}` : system }, { role: 'user', content: user }, ...exchange, ...repairMessages];
      const temperature = this.opts.temperature ? this.opts.temperature[req.tier] : req.tier === 'cheap' ? 0 : undefined;
      const reasoningEffort = this.opts.reasoningEffort?.[req.tier];
      const built = buildChatBody({
        model: pre.modelId,
        caps,
        tier: req.tier,
        messages,
        maxOutputTokens: maxOutput,
        format,
        ...(schemaName ? { schemaName } : {}),
        schema: jsonSchema,
        tools: toolsThisRound,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(reasoningBound === 'request_param' ? { reasoningMaxTokens: reasoningAllowance } : {}),
        ...(this.opts.responseHealing ? { responseHealing: true } : {}),
      });
      const call = await this.chatCall(cc, pre.apiKey, built, attempt, repairs);
      if (!call.ok) return { ...call, truncation: [...cc.truncation] };
      lastCallId = call.callId;
      totals = addUsage(totals, call.usage);
      totalCost = totalCost === null || call.cost.micros === null ? null : totalCost + call.cost.micros;
      const modelName = call.modelReturned ?? pre.modelId;

      // Tool round.
      const toolCalls = call.message.tool_calls ?? [];
      if (toolCalls.length && toolsThisRound.length && toolCtx) {
        toolRounds++;
        updateLlmCallOutcome(ctx.db, ctx.siteId, call.callId, { status: 'tool_round', validationStatus: 'not_applicable' });
        const assistantMsg: ChatMessage = { role: 'assistant', content: call.message.content ?? null, tool_calls: toolCalls };
        if (call.message.reasoning_details !== undefined) assistantMsg.reasoning_details = call.message.reasoning_details;
        exchange.push(assistantMsg);
        const used = estimateTokens(messages.map((m) => m.content ?? '').join('\n')) + estimateTokens(JSON.stringify(toolCalls));
        const headroom = Math.max(0, inputCeiling - used - estimateTokens(JSON.stringify(toolSpecs)) - MESSAGE_OVERHEAD_TOKENS * (toolCalls.length + 2));
        const perResult = Math.floor(headroom / toolCalls.length);
        for (const tc of toolCalls) {
          const exec = await this.tools.execute(
            { id: tc.id, name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' },
            {
              allowed: allowedSet,
              ctx: toolCtx,
              onRejected: (rej) => this.recordToolRejection(cc, call.callId, { tool: rej.name, reason: rej.reason, argumentsPreview: rej.argumentsPreview, allowed: [...allowedSet], executed: false }),
            },
          );
          exchange.push({ role: 'tool', tool_call_id: tc.id, content: this.renderToolResult(cc, tc.id, exec, perResult) });
        }
        continue;
      }
      if (toolCalls.length) {
        // Tool calls that are not executed are rejected, logged, and audited like any other.
        const reason = !allowedTools.length
          ? 'no tools are allowlisted for this request'
          : !toolSpecs.length
            ? `tools were not offered for this request (${toolsOmittedReason ?? 'not available'})`
            : `tool rounds exhausted (maxToolRounds=${maxToolRounds}); tools were not offered this turn`;
        for (const tc of toolCalls) {
          this.recordToolRejection(cc, call.callId, {
            tool: String(tc.function?.name ?? '').slice(0, 64),
            reason,
            argumentsPreview: redactString(String(tc.function?.arguments ?? '').slice(0, 200)),
            allowed: allowedTools,
            executed: false,
          });
        }
      }

      const content = call.message.content ?? '';
      if (!kind.structured) {
        if (!content.trim()) {
          updateLlmCallOutcome(ctx.db, ctx.siteId, call.callId, { status: 'needs_review', validationStatus: 'invalid', error: { message: toolCalls.length ? 'no text; only tool calls that were not executed' : 'empty output' } });
          return fail('needs_review', toolCalls.length ? 'The model returned only tool calls, which were rejected (not executed); no text was produced.' : 'The model returned no text.', { callId: call.callId, truncation: [...cc.truncation] });
        }
        const usageTotals = totals ?? { inputTokens: null, outputTokens: null, reasoningTokens: null };
        if (call.finishReason === 'length') {
          // Cut off at max_tokens: the text is returned (it was paid for) but flagged as incomplete,
          // recorded as a truncation entry, and never described as a complete answer.
          const outTokens = call.usage.outputTokens ?? built.maxTokens;
          const truncation: TruncationInfo[] = [
            ...cc.truncation,
            {
              evidenceId: OUTPUT_TRUNCATION_ID,
              originalTokens: outTokens,
              keptTokens: outTokens,
              note: `The model output was cut off at the output token limit (max_tokens ${built.maxTokens}, finish_reason "length"): the text is incomplete and must not be presented as a complete answer.`,
            },
          ];
          updateLlmCallOutcome(ctx.db, ctx.siteId, call.callId, { status: 'succeeded', validationStatus: 'not_applicable', error: { message: 'output truncated at the output token limit (finish_reason "length")', outputTruncated: true, maxTokens: built.maxTokens } });
          ctx.logger.warn('LLM text output was cut off at the output token limit', { promptId: cc.promptId, traceId, maxTokens: built.maxTokens });
          return { ok: true, value: content, callId: call.callId, model: modelName, promptVersion: cc.promptVersion, usage: usageTotals, costMicros: totalCost, repairAttempts: 0, truncation, outputTruncated: true };
        }
        updateLlmCallOutcome(ctx.db, ctx.siteId, call.callId, { status: 'succeeded', validationStatus: 'not_applicable' });
        return { ok: true, value: content, callId: call.callId, model: modelName, promptVersion: cc.promptVersion, usage: usageTotals, costMicros: totalCost, repairAttempts: 0, truncation: [...cc.truncation] };
      }

      const errors: string[] = [];
      let value: unknown;
      const v = validateOutput(content, kind.schema);
      if (v.ok) value = v.value;
      else if (toolCalls.length) errors.push('tool calls are not available for this turn and were not executed; answer directly with the required JSON');
      else errors.push(...v.errors);
      if (call.finishReason === 'length') errors.push(`the response was cut off at the output token limit (${built.maxTokens}); produce a shorter, complete response`);
      if (!errors.length) {
        updateLlmCallOutcome(ctx.db, ctx.siteId, call.callId, { status: 'succeeded', validationStatus: repairs > 0 ? 'repaired' : 'valid' });
        return { ok: true, value, callId: call.callId, model: modelName, promptVersion: cc.promptVersion, usage: totals ?? { inputTokens: null, outputTokens: null, reasoningTokens: null }, costMicros: totalCost, repairAttempts: repairs, truncation: [...cc.truncation] };
      }
      const lastRawOutput = redactString(content).slice(0, MAX_RAW_OUTPUT_CHARS);
      if (repairs >= maxRepairs) {
        updateLlmCallOutcome(ctx.db, ctx.siteId, call.callId, { status: 'needs_review', validationStatus: 'invalid', error: { validationErrors: errors } });
        recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType: 'llm.needs_review', subjectType: 'llm_call', subjectId: call.callId, traceId, details: { promptId: cc.promptId, repairAttempts: repairs, errors: errors.slice(0, 10) }, at: ctx.clock.now() });
        return fail('needs_review', `Output failed schema "${cc.schemaName}" validation after ${repairs} repair attempt(s): ${errors.slice(0, 5).join('; ')}`, {
          callId: lastCallId,
          lastRawOutput,
          truncation: [...cc.truncation],
          nextStep: 'Review the output manually (llm_calls, raw response in the workspace); the task was sent to review instead of retrying further.',
        });
      }
      updateLlmCallOutcome(ctx.db, ctx.siteId, call.callId, { status: 'invalid_output', validationStatus: 'invalid', error: { validationErrors: errors } });
      repairs++;
      // Repair turn: previous output (truncated to fit the input ceiling) + validation errors.
      const baseUsed = estimateTokens([system, user, ...exchange.map((m) => m.content ?? '')].join('\n')) + (toolsThisRound.length ? estimateTokens(JSON.stringify(toolSpecs)) : 0);
      const errorsText = errors.map((e) => `- ${e}`).join('\n');
      const repairPreview = this.renderSystemUser('system.repair', { errors: errorsText, output_note: '', schema_name: cc.schemaName ?? 'output', attempt: repairs, max_attempts: maxRepairs });
      const room = inputCeiling - baseUsed - estimateTokens(repairPreview.system) - estimateTokens(repairPreview.user) - MESSAGE_OVERHEAD_TOKENS * 3;
      const prev = truncateToTokens(content, Math.max(0, room));
      const outputNote = prev.truncated ? (prev.keptTokens > 0 ? '(Your previous output shown above was shortened to fit the input limit.)' : '(Your previous output is not repeated because of the input limit.)') : '';
      const repair = this.renderSystemUser('system.repair', { errors: errorsText, output_note: outputNote, schema_name: cc.schemaName ?? 'output', attempt: repairs, max_attempts: maxRepairs });
      repairSystem = repair.system;
      repairMessages = [...(prev.keptTokens > 0 ? [{ role: 'assistant' as const, content: prev.text }] : []), { role: 'user', content: repair.user }];
      if (!cc.systemPromptVersions.includes(repair.version)) cc.systemPromptVersions.push(repair.version);
    }
  }

  /** One budgeted POST /chat/completions with full bookkeeping. */
  private async chatCall(cc: ChatContext, apiKey: string, built: BuiltChatBody, attempt: number, repairs: number): Promise<ChatCallOk | Failure> {
    const ctx = this.ctx;
    const inputTokensEstimate = estimateTokens(JSON.stringify(built.body));
    const prices = resolvePrices(cc.caps, ctx.config, cc.modelId, cc.catalog.retrievedAt);
    let estimate = this.labelReasoningBound(cc, estimateChatCost(prices, { inputTokens: inputTokensEstimate, maxOutputTokens: built.maxTokens, reasoningTokens: cc.reasoningAllowance }));
    const params: Record<string, unknown> = {
      request: built.sent,
      omitted: built.omitted,
      responseFormat: built.format,
      toolsSent: built.toolsSent,
      messageCount: (built.body.messages as unknown[]).length,
      inputTokensEstimate,
      reasoningTokenAllowance: cc.reasoningAllowance,
      reasoningBound: cc.reasoningBound,
      estimate: { upperBoundMicros: estimate.upperBoundMicros, basis: estimate.basis },
      systemPrompts: cc.systemPromptVersions,
      catalog: { snapshotId: cc.catalog.snapshotId, retrievedAt: cc.catalog.retrievedAt, stale: cc.catalog.stale, authenticated: cc.catalog.authenticated },
      modelWarnings: cc.modelWarnings,
      evidence: { included: cc.bundle.includedIds, omitted: cc.bundle.omittedIds, injectionSignals: cc.bundle.injectionSignals },
      personalData: cc.allowPersonalData ? { masked: false, reason: 'llm.allowPersonalData (see llm.personalDataReason in the site config)' } : { masked: true, redactions: cc.bundle.personalDataRedactions },
    };
    const record = (over: Partial<LlmCallRecord> & Pick<LlmCallRecord, 'status' | 'validationStatus'>): string =>
      insertLlmCall(ctx.db, {
        siteId: ctx.siteId,
        runId: cc.runId,
        traceId: cc.traceId,
        callGroupId: cc.callGroupId,
        attempt,
        role: cc.role,
        tier: cc.tier,
        promptId: cc.promptId,
        promptVersion: cc.promptVersion,
        modelRequested: cc.modelId,
        modelReturned: null,
        params,
        maxOutputTokens: built.maxTokens,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        costMicros: null,
        costStatus: 'unknown',
        schemaName: cc.schemaName,
        repairAttempts: repairs,
        truncation: [...cc.truncation],
        evidenceBundleHash: cc.bundle.bundleHash,
        providerRequestId: null,
        reservationId: null,
        responseFormat: built.format,
        httpStatus: null,
        error: null,
        isSynthetic: false,
        createdAt: ctx.clock.now(),
        ...over,
      });

    if (ctx.dryRun) {
      return fail('disabled', `Dry run: would call ${cc.modelId} (prompt ${cc.promptVersion}, max_tokens ${built.maxTokens}, upper bound ${estimate.upperBoundMicros === null ? 'unknown' : formatUsd(estimate.upperBoundMicros)}); no request was sent and nothing was reserved.`);
    }

    const capped = this.checkRequestCap(estimate);
    if (capped) return capped;
    const purpose = `llm.chat ${cc.promptId} ${cc.tier} attempt ${attempt}`;
    let approvalId: string | undefined;
    let requestHash: string | undefined;
    if (estimate.upperBoundMicros === null) {
      requestHash = approvalRequestHash('chat.completions', built.body, cc.boundary);
      const auth = this.authorizeUnknownPrice({
        traceId: cc.traceId,
        endpoint: 'chat.completions',
        requestHash,
        modelId: cc.modelId,
        purpose: `${purpose} (prompt ${cc.promptVersion}, max_tokens ${built.maxTokens})`,
        basisDetail: estimate.basis.detail,
        ...(cc.unknownPriceApprovalId ? { approvalId: cc.unknownPriceApprovalId } : {}),
        ...(cc.unknownPriceMaxChargeMicros !== undefined ? { maxChargeMicros: cc.unknownPriceMaxChargeMicros } : {}),
      });
      if (!auth.ok) return auth;
      estimate = auth.estimate;
      approvalId = auth.approvalId;
      params.estimate = { upperBoundMicros: estimate.upperBoundMicros, basis: estimate.basis };
      params.unknownPriceApproval = { approvalId, requestHash };
    }
    const reserved = this.reserve(cc, estimate, purpose, approvalId);
    if (!reserved.ok) return reserved;
    const reservationId = reserved.reservationId;
    if (approvalId) {
      const consumed = this.consumeApproval(approvalId, 'chat.completions', requestHash!, reservationId, cc.traceId);
      if (!consumed.ok) {
        ctx.budgets.release(reservationId, `unknown-price approval ${approvalId} could not be consumed; nothing was sent`);
        return consumed;
      }
    }

    const preq = ctx.requests.prepare({
      siteId: ctx.siteId,
      provider: 'llm_gateway',
      endpoint: 'chat.completions',
      method: 'POST',
      isPaid: true,
      params: { model: cc.modelId, promptVersion: cc.promptVersion, schemaName: cc.schemaName, maxTokens: built.maxTokens, evidenceBundleHash: cc.bundle.bundleHash, callGroupId: cc.callGroupId, attempt, body: built.body },
      reservationId,
      traceId: cc.traceId,
      isSynthetic: false,
    });
    ctx.budgets.attachRequest(reservationId, preq.id);
    ctx.requests.markSubmitted(preq.id);

    let http;
    try {
      http = await fetchWithTimeout(
        this.fetchFn,
        gatewayUrl(ctx.settings.llmBaseUrl, 'chat/completions'),
        { method: 'POST', headers: authHeaders(apiKey, { 'content-type': 'application/json', ...(this.opts.xSource ? { 'x-source': this.opts.xSource } : {}) }), body: JSON.stringify(built.body) },
        this.paidTimeoutMs(),
        cc.signal,
      );
    } catch (err) {
      const t = err instanceof TransportError ? err : new TransportError('unknown', errorMessage(err));
      if (t.kind === 'not_sent') {
        ctx.requests.complete(preq.id, { status: 'failed', error: { kind: t.kind, message: t.message } });
        ctx.budgets.release(reservationId, `not submitted: ${t.message}`);
        const callId = record({ status: 'provider_error', validationStatus: 'error', providerRequestId: preq.id, reservationId, costMicros: 0, costStatus: 'actual', error: { kind: t.kind, message: t.message, billing: 'not billed: the request never reached the gateway; reservation released' } });
        return fail('provider_error', `LLM Gateway request was not delivered: ${t.message}`, { callId, nextStep: `Check network access and LLM_GATEWAY_BASE_URL (${ctx.settings.llmBaseUrl}).` });
      }
      // Ambiguous: the gateway may have accepted (and billed) the request. Never retried blindly.
      ctx.requests.complete(preq.id, { status: 'ambiguous', error: { kind: t.kind, message: t.message } });
      ctx.budgets.markUnresolved(reservationId, `ambiguous ${t.kind}: ${t.message}; the gateway may have processed and billed this request`);
      const callId = record({ status: 'ambiguous', validationStatus: 'error', providerRequestId: preq.id, reservationId, error: { kind: t.kind, message: t.message } });
      recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType: 'llm.ambiguous_submission', subjectType: 'provider_request', subjectId: preq.id, traceId: cc.traceId, details: { kind: t.kind, reservationId, model: cc.modelId }, at: ctx.clock.now() });
      return fail('provider_error', `LLM Gateway request ${t.kind === 'timeout' ? 'timed out' : 'failed'} after submission (${t.message}); the charge is unknown and the reservation stays unresolved. Not retried automatically.`, {
        callId,
        ambiguous: true,
        reservationId,
        nextStep: reconcileNextStep(reservationId),
      });
    }

    if (http.status < 200 || http.status >= 300) {
      const env = parseErrorEnvelope(http.text);
      const cls = classifyHttpFailure(http.status, env, http.headers);
      if (cls.billing === 'not_billed') {
        ctx.requests.complete(preq.id, { status: 'failed', httpStatus: http.status, error: env });
        ctx.budgets.release(reservationId, `rejected by gateway before inference: HTTP ${http.status}`);
      } else {
        ctx.requests.complete(preq.id, { status: 'ambiguous', httpStatus: http.status, error: env });
        ctx.budgets.markUnresolved(reservationId, `HTTP ${http.status}: billing state not guaranteed`);
      }
      const callId = record({
        status: cls.billing === 'ambiguous' ? 'ambiguous' : 'provider_error',
        validationStatus: 'error',
        providerRequestId: preq.id,
        reservationId,
        httpStatus: http.status,
        ...(cls.billing === 'not_billed' ? { costMicros: 0, costStatus: 'actual' as const } : {}),
        error: { ...env, billing: cls.billing === 'not_billed' ? 'not billed: rejected by the gateway before inference; reservation released' : 'ambiguous: reservation kept unresolved' },
      });
      if (cls.status === 'invalid_model' || cls.status === 'unsupported') {
        // The catalog may be out of date: allow the next call to re-verify.
        this.refreshedForMissingModel = false;
        this.discovery = null;
      }
      return fail(cls.status, cls.reason, { callId, nextStep: cls.billing === 'ambiguous' ? `Billing state is not guaranteed. ${reconcileNextStep(reservationId)}` : cls.nextStep, ...(cls.billing === 'ambiguous' ? { ambiguous: true, reservationId } : {}) });
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(http.text) as Record<string, unknown>;
      if (!body || typeof body !== 'object') throw new Error('response is not an object');
    } catch (err) {
      // The request was processed (HTTP 2xx) but its usage cannot be read: charge unknown.
      ctx.requests.complete(preq.id, { status: 'succeeded', httpStatus: http.status, error: { message: `unparseable response: ${errorMessage(err)}` } });
      ctx.budgets.reconcile(reservationId, { actualMicros: null, source: 'gateway_reported', usage: { note: 'unparseable response body' }, providerRequestId: preq.id });
      const callId = record({ status: 'provider_error', validationStatus: 'error', providerRequestId: preq.id, reservationId, httpStatus: http.status, error: { message: 'unparseable response body' } });
      return fail('provider_error', 'LLM Gateway returned an unparseable response; the charge is unknown (reservation left unresolved).', { callId, reservationId, nextStep: reconcileNextStep(reservationId) });
    }

    const rawRef = ctx.raw.save({ siteId: ctx.siteId, provider: 'llm_gateway', kind: 'chat', payload: body, at: ctx.clock.now() });
    const meta = (body.metadata && typeof body.metadata === 'object' ? body.metadata : {}) as Record<string, unknown>;
    const usage = parseUsage(body.usage);
    const usedProvider = typeof meta.used_provider === 'string' ? meta.used_provider : null;
    const actualPrices: ResolvedPrices =
      usedProvider && cc.caps.providers.some((p) => p.providerId === usedProvider)
        ? resolvePrices(deriveCapabilities(baseInfo(cc.caps), usedProvider), ctx.config, cc.modelId, cc.catalog.retrievedAt)
        : prices;
    const cost = actualChatCost(usage, actualPrices);
    ctx.budgets.reconcile(reservationId, {
      actualMicros: cost.micros,
      source: cost.source === 'computed_from_usage' ? 'computed_from_usage' : 'gateway_reported',
      usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, reasoning_tokens: usage.reasoningTokens, cached_tokens: usage.cachedTokens, gateway_cost_usd: usage.gatewayCostUsd, detail: cost.detail },
      providerRequestId: preq.id,
    });
    const externalId = typeof meta.request_id === 'string' ? meta.request_id : typeof body.id === 'string' ? body.id : null;
    ctx.requests.complete(preq.id, { status: 'succeeded', httpStatus: http.status, rawRef, ...(externalId ? { externalId } : {}) });

    const usedModel = typeof meta.used_model === 'string' ? meta.used_model : typeof body.model === 'string' ? body.model : null;
    const modelReturned = usedModel ? (usedProvider && !usedModel.includes('/') ? `${usedProvider}/${usedModel}` : usedModel) : null;
    const llmUsage: LlmUsage = { inputTokens: usage.promptTokens, outputTokens: usage.completionTokens, reasoningTokens: usage.reasoningTokens };
    const costStatus = cost.source === 'gateway_reported' ? 'actual' : cost.source === 'computed_from_usage' ? 'estimated' : 'unknown';
    const choices = Array.isArray(body.choices) ? (body.choices as Array<Record<string, unknown>>) : [];
    const choice = choices[0];
    const message = (choice?.message && typeof choice.message === 'object' ? choice.message : null) as ChatCallOk['message'] | null;
    const paramsWithResponse = { ...params, response: { requestId: meta.request_id ?? null, usedProvider, cached: meta.cached ?? null, finishReason: choice?.finish_reason ?? null, rawRef, costDetail: cost.detail } };
    if (!message) {
      const callId = record({ status: 'provider_error', validationStatus: 'error', providerRequestId: preq.id, reservationId, httpStatus: http.status, modelReturned, params: paramsWithResponse, inputTokens: llmUsage.inputTokens, outputTokens: llmUsage.outputTokens, reasoningTokens: llmUsage.reasoningTokens, costMicros: cost.micros, costStatus, error: { message: 'response has no choices[0].message' } });
      return fail('provider_error', 'LLM Gateway response had no message.', { callId });
    }
    const callId = record({
      status: 'succeeded',
      validationStatus: 'not_applicable',
      providerRequestId: preq.id,
      reservationId,
      httpStatus: http.status,
      modelReturned,
      params: paramsWithResponse,
      inputTokens: llmUsage.inputTokens,
      outputTokens: llmUsage.outputTokens,
      reasoningTokens: llmUsage.reasoningTokens,
      costMicros: cost.micros,
      costStatus,
    });
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.filter((t) => t && typeof t === 'object') : undefined;
    return {
      ok: true,
      callId,
      message: {
        content: typeof message.content === 'string' ? message.content : null,
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
        ...(message.reasoning_details !== undefined ? { reasoning_details: message.reasoning_details } : {}),
      },
      finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
      usage: llmUsage,
      cost,
      modelReturned,
    };
  }

  private checkRequestCap(estimate: ReturnType<typeof estimateChatCost>): Failure | null {
    const cap = this.opts.maxCostPerRequestMicros;
    if (cap === undefined) return null;
    if (estimate.upperBoundMicros === null) {
      return fail('budget_unknown_price', `No verifiable price for this request, so it cannot be kept under the explicit cap of ${formatUsd(cap)}; no request was sent.`, {
        nextStep: 'Verify the model price (`models check`) or configure llm.pricingOverrides.',
      });
    }
    if (estimate.upperBoundMicros > cap) {
      return fail('budget_exceeded', `The request's cost upper bound ${formatUsd(estimate.upperBoundMicros)} exceeds the explicit cap of ${formatUsd(cap)}; no request was sent.`, {
        nextStep: `Raise the cap only if you intend to spend up to ${formatUsd(estimate.upperBoundMicros)}. Basis: ${estimate.basis.detail}`,
      });
    }
    return null;
  }

  private paidTimeoutMs(): number {
    return this.opts.paidRequestTimeoutMs ?? this.opts.timeoutMs ?? DEFAULT_PAID_REQUEST_TIMEOUT_MS;
  }

  /** Provider mappings a request may be routed to (a `provider/model` pin restricts routing to one). */
  private applicableMappings(caps: ModelCapabilities): ProviderMapping[] {
    return caps.pinnedProvider ? caps.providers.filter((p) => p.providerId === caps.pinnedProvider) : caps.providers;
  }

  /**
   * How hidden reasoning tokens are bounded for this model: 'none' (cannot
   * reason), 'request_param' (reasoning.max_tokens is sent: every applicable
   * mapping supports reasoning and is listed in reasoningMaxTokensProviders),
   * or 'assumed' (only the budgeted allowance, which nothing enforces).
   */
  private reasoningBound(caps: ModelCapabilities, allowance: number): ReasoningBound {
    if (!caps.reasoningPossible) return 'none';
    const listed = new Set(this.opts.reasoningMaxTokensProviders ?? []);
    const mappings = this.applicableMappings(caps);
    if (allowance >= 1 && caps.reasoning === true && mappings.length > 0 && mappings.every((m) => listed.has(m.providerId))) return 'request_param';
    return 'assumed';
  }

  /** Label the reasoning part of an estimate honestly; with unboundedReasoning='require_approval' an assumed bound is no bound. */
  private labelReasoningBound(cc: ChatContext, estimate: CostEstimate): CostEstimate {
    if (estimate.upperBoundMicros === null || cc.reasoningBound === 'none') return estimate;
    if (cc.reasoningBound === 'request_param') {
      return { ...estimate, basis: { ...estimate.basis, detail: `${estimate.basis.detail} Hidden reasoning is capped by the sent reasoning.max_tokens=${cc.reasoningAllowance} (documented for Anthropic/Google thinking models; enforcement by every upstream provider is unverified).` } };
    }
    const assumed = `The ${cc.reasoningAllowance}-token reasoning allowance is an ASSUMPTION: no request field verifiably bounds hidden reasoning tokens for ${cc.modelId}, so actual spend can exceed this bound (overshoot is flagged at reconciliation).`;
    if (this.opts.unboundedReasoning === 'require_approval') {
      return { upperBoundMicros: null, basis: { source: 'unknown', detail: `No safe upper bound: ${assumed} unboundedReasoning is 'require_approval', so the assumption-based estimate (${formatUsd(estimate.upperBoundMicros)}) is not used. ${estimate.basis.detail}` } };
    }
    return { ...estimate, basis: { ...estimate.basis, detail: `${estimate.basis.detail} ${assumed}` } };
  }

  /** Log and audit a model tool call that is not executed (unknown, not allowlisted, or not offered). */
  private recordToolRejection(cc: ChatContext, callId: string, r: { tool: string; reason: string; argumentsPreview: string; allowed: string[]; executed: false }): void {
    const ctx = this.ctx;
    ctx.logger.warn('Rejected a model tool call (not executed)', { traceId: cc.traceId, promptId: cc.promptId, tool: r.tool, reason: r.reason });
    recordAudit(ctx.db, {
      siteId: ctx.siteId,
      actor: 'system',
      eventType: 'llm.tool_rejected',
      subjectType: 'llm_call',
      subjectId: callId,
      traceId: cc.traceId,
      details: { tool: r.tool, reason: r.reason, argumentsPreview: r.argumentsPreview, allowed: r.allowed, executed: r.executed },
      at: ctx.clock.now(),
    });
  }

  /**
   * Wrap a tool result as an untrusted data block within the per-result token
   * budget. Content is cut BEFORE wrapping so the closing marker survives;
   * any cut (tool maxResultChars or the input ceiling) is recorded as a
   * TruncationInfo (`tool:<name>:<call id>`) and disclosed to the model.
   */
  private renderToolResult(cc: ChatContext, toolCallId: string, exec: ToolExecution, perResult: number): string {
    const name = exec.name.slice(0, 64);
    const id = `tool:${name}:${toolCallId}`.slice(0, 120);
    const meta: DataBlockMeta = { id, trustClass: exec.resultTrust, label: `result of tool ${name} (${exec.status})`, kind: 'tool_result' };
    const clean = sanitizeModelData(exec.content, cc.boundary, { allowPersonalData: cc.allowPersonalData }).text;
    const cleanTokens = estimateTokens(clean);
    const originalTokens = exec.truncated ? Math.max(exec.originalTokens ?? 0, cleanTokens) : cleanTokens;
    const whole = wrapDataBlock(cc.boundary, { ...meta, truncated: exec.truncated }, clean);
    if (estimateTokens(whole) <= perResult) {
      if (exec.truncated) {
        cc.truncation.push({
          evidenceId: id,
          originalTokens,
          keptTokens: cleanTokens,
          note: `Tool result cut at the tool's maximum result size: the model saw about ${cleanTokens} of about ${originalTokens} estimated tokens. This result was only partially reviewed.`,
        });
      }
      return whole;
    }
    const suffix = (kept: number) => `\n[TRUNCATED tool result: the input token ceiling was reached; you see only about ${kept} of about ${originalTokens} tokens. Do not describe this result as complete.]`;
    const overhead = estimateTokens(wrapDataBlock(cc.boundary, { ...meta, truncated: true }, '')) + estimateTokens(suffix(9_999_999)) + 2;
    const room = perResult - overhead;
    const cut = room >= MIN_TOOL_RESULT_TOKENS ? truncateToTokens(clean, room) : { text: '', keptTokens: 0, truncated: true };
    const ceiling = `llm.maxInputTokens=${this.ctx.config.llm.maxInputTokens}`;
    cc.truncation.push({
      evidenceId: id,
      originalTokens,
      keptTokens: cut.keptTokens,
      note:
        cut.keptTokens > 0
          ? `Tool result truncated to fit the request's input token ceiling (${ceiling}): the model saw about ${cut.keptTokens} of about ${originalTokens} estimated tokens. This result was only partially reviewed.`
          : `Tool result omitted: the request's input token ceiling (${ceiling}) was reached. The model did not see it; it was not reviewed.`,
    });
    const body = cut.keptTokens > 0 ? `${cut.text}${suffix(cut.keptTokens)}` : '[tool result omitted: the input token ceiling was reached; you have not seen this result.]';
    return wrapDataBlock(cc.boundary, { ...meta, truncated: true }, body);
  }

  /**
   * Unknown price (no safe upper bound): the request is sent only with a
   * verified, one-time `paid_request` approval bound to this site, endpoint,
   * exact request (boundary-normalized body hash), and maximum charge. The
   * maximum charge is what gets reserved. Without an approval gate, a
   * maximum charge, or a matching approval, the request is skipped. When a
   * maximum charge is proposed without an approval id, a pending approval
   * request is created for the owner.
   */
  private authorizeUnknownPrice(i: {
    traceId: string;
    endpoint: LlmPaidEndpoint;
    requestHash: string;
    modelId: string;
    purpose: string;
    basisDetail: string;
    approvalId?: string;
    maxChargeMicros?: Micros;
  }): { ok: true; approvalId: string; estimate: CostEstimate } | Failure {
    const ctx = this.ctx;
    const gate = this.opts.approvals;
    const pricingStep = `Verify the model price and set llm.pricingOverrides["${i.modelId}"] in the site config (\`npm run cli -- models check\` shows which prices are verified).`;
    const refuse = (why: string, extra: LlmFailureDetails = {}): Failure => {
      recordAudit(ctx.db, {
        siteId: ctx.siteId,
        actor: 'system',
        eventType: 'llm.skipped',
        subjectType: 'llm_trace',
        subjectId: i.traceId,
        traceId: i.traceId,
        details: { status: 'budget_unknown_price', purpose: i.purpose, reason: why, approvalId: i.approvalId ?? extra.approvalId ?? null, requestHash: i.requestHash },
        at: ctx.clock.now(),
      });
      return fail('budget_unknown_price', `${i.endpoint}: cannot establish a safe cost upper bound for ${i.modelId}; ${why} No request was sent.`, {
        approvalRequestHash: i.requestHash,
        nextStep: `${pricingStep} Or approve this exact request (a paid_request approval with a maximum charge) through the approvals workflow.`,
        ...extra,
      });
    };
    if (!gate) {
      return refuse(
        i.approvalId
          ? `approval "${i.approvalId}" cannot be verified because no approval gate is wired into this LLM client (an approval id alone authorizes nothing).`
          : 'no approval gate is wired into this LLM client, so the request cannot be approved.',
      );
    }
    const max = i.maxChargeMicros;
    if (max === undefined || !Number.isSafeInteger(max) || max <= 0) {
      return refuse('an unknown-price request can be approved only with an explicit maximum charge (unknownPriceMaxChargeMicros, positive integer USD micros) that is reserved against the budgets; none was given.', i.approvalId ? { approvalId: i.approvalId } : {});
    }
    const binding = { siteId: ctx.siteId, actionType: 'paid_request' as const, subjectType: 'provider_request', subjectId: i.requestHash, artifactHash: paidRequestArtifactHash(i.endpoint, i.requestHash, max) };
    if (!i.approvalId) {
      const rec = gate.request({
        ...binding,
        target: `llm_gateway:${i.endpoint}`,
        summary: `Paid LLM Gateway request to ${i.endpoint} (model ${i.modelId}) with no verified price, at most ${formatUsd(max)} (reserved against the budgets). Purpose: ${i.purpose}`.slice(0, 500),
        payload: { provider: 'llm_gateway', endpoint: i.endpoint, model: i.modelId, purpose: i.purpose, maxChargeMicros: max, requestHash: i.requestHash },
        requestedBy: 'system',
      });
      recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType: 'llm.unknown_price_approval_requested', subjectType: 'approval', subjectId: rec.id, traceId: i.traceId, details: { endpoint: i.endpoint, model: i.modelId, maxChargeMicros: max, requestHash: i.requestHash }, at: ctx.clock.now() });
      return refuse(`approval ${rec.id} (${rec.status}) covers exactly this request with a maximum charge of ${formatUsd(max)}.`, {
        approvalId: rec.id,
        nextStep: `Review and approve ${rec.id} through the approvals workflow, then re-run exactly the same request with unknownPriceApprovalId "${rec.id}" and unknownPriceMaxChargeMicros ${max}. Or: ${pricingStep}`,
      });
    }
    const check = gate.check(binding);
    if (!check.ok || check.approval.id !== i.approvalId) {
      const why = !check.ok ? check.reason : `the approval bound to this request is ${check.approval.id}`;
      recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType: 'llm.unknown_price_approval_refused', subjectType: 'approval', subjectId: i.approvalId, traceId: i.traceId, details: { reason: why, endpoint: i.endpoint, requestHash: i.requestHash, maxChargeMicros: max }, at: ctx.clock.now() });
      return refuse(`approval "${i.approvalId}" does not authorize this exact request (${why}); approvals bind the site, endpoint, exact request body, and maximum charge, and are single-use.`, { approvalId: i.approvalId });
    }
    return {
      ok: true,
      approvalId: check.approval.id,
      estimate: {
        upperBoundMicros: max,
        basis: {
          source: 'unknown',
          detail: `No verified price: reserved the approved maximum charge ${formatUsd(max)} (approval ${check.approval.id}, one request ${i.requestHash.slice(0, 12)}); the actual charge is reconciled from gateway-reported usage when available, else stays unknown. ${i.basisDetail}`,
        },
      },
    };
  }

  /** Consume a verified unknown-price approval (one-time) after its reservation succeeded. */
  private consumeApproval(approvalId: string, endpoint: LlmPaidEndpoint, requestHash: string, reservationId: string, traceId: string): { ok: true } | Failure {
    try {
      this.opts.approvals!.consume(approvalId, { kind: 'paid_request', actor: 'system', provider: 'llm_gateway', endpoint, requestHash, reservationId, traceId });
      return { ok: true };
    } catch (err) {
      recordAudit(this.ctx.db, { siteId: this.ctx.siteId, actor: 'system', eventType: 'llm.unknown_price_approval_refused', subjectType: 'approval', subjectId: approvalId, traceId, details: { reason: redactString(errorMessage(err)), endpoint, requestHash }, at: this.ctx.clock.now() });
      return fail('budget_unknown_price', `Unknown-price approval ${approvalId} could not be consumed (${errorMessage(err)}); the reservation was released and no request was sent.`, { approvalId, approvalRequestHash: requestHash });
    }
  }

  private reserve(
    cc: { runId: string; traceId: string; promptId?: string },
    estimate: ReturnType<typeof estimateChatCost>,
    purpose: string,
    approvalId: string | undefined,
  ): { ok: true; reservationId: string } | Failure {
    const ctx = this.ctx;
    try {
      const r = ctx.budgets.reserve({
        siteId: ctx.siteId,
        provider: 'llm_gateway',
        runId: cc.runId,
        purpose,
        estimate,
        ...(approvalId ? { unknownPriceApprovalId: approvalId } : {}),
      });
      return { ok: true, reservationId: r.id };
    } catch (err) {
      if (isAppError(err) && (err.code === 'BUDGET_EXCEEDED' || err.code === 'BUDGET_UNKNOWN_PRICE')) {
        const status: LlmFailureStatus = err.code === 'BUDGET_EXCEEDED' ? 'budget_exceeded' : 'budget_unknown_price';
        recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType: 'llm.skipped', subjectType: 'llm_trace', subjectId: cc.traceId, traceId: cc.traceId, details: { status, purpose, upperBoundMicros: estimate.upperBoundMicros, basis: estimate.basis.detail }, at: ctx.clock.now() });
        return fail(status, `${err.message} No request was sent.`, {
          nextStep:
            status === 'budget_exceeded'
              ? `${err.hint ?? 'No automatic budget increases are performed.'} Upper bound for this request: ${estimate.upperBoundMicros === null ? 'unknown' : formatUsd(estimate.upperBoundMicros)}.`
              : `${err.hint ?? ''} Run \`npm run cli -- models check\` to see which prices are verified.`.trim(),
        });
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Embeddings
  // -------------------------------------------------------------------------

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    const ctx = this.ctx;
    if (req.siteId !== ctx.siteId) throw new PolicyDeniedError(`Embedding request for site "${req.siteId}" was issued on a context for site "${ctx.siteId}"`, { requestSite: req.siteId });
    const pre = this.preflight('embedding');
    if (!pre.ok) return pre;
    const resolved = await this.resolveModel(pre.modelId, 'embedding');
    if (!resolved.ok) return resolved;
    const { caps, catalog } = resolved;
    // models.embeddingDimensions only VERIFIES returned vectors; `dimensions` (shortening) is sent
    // only on explicit request, because the contract says it works only on models that support it.
    const configuredDims = ctx.settings.models.embeddingDimensions;
    const requestDims = this.opts.embeddingRequestDimensions;
    if (requestDims !== undefined && (!Number.isSafeInteger(requestDims) || requestDims < 1)) throw new ValidationError('embeddingRequestDimensions must be a positive integer');
    if (requestDims !== undefined && configuredDims && requestDims !== configuredDims) {
      return fail('unsupported', `embeddingRequestDimensions (${requestDims}) differs from models.embeddingDimensions (${configuredDims}); no request was sent (incompatible vectors are never mixed).`, {
        nextStep: 'Make the requested and configured dimensions equal; changing dimensions requires a separate collection or a reindex.',
      });
    }
    const expectedDims = requestDims ?? configuredDims ?? null;
    if (!req.texts.length) {
      return { ok: true, vectors: [], model: pre.modelId, dimensions: expectedDims ?? 0, usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }, costMicros: 0 };
    }
    const perInputLimit = caps.contextLength;
    for (let i = 0; i < req.texts.length; i++) {
      const t = req.texts[i]!;
      if (!t.trim()) return fail('unsupported', `Embedding input ${i} is empty; no request was sent.`);
      const est = estimateTokens(t);
      if (perInputLimit && est > perInputLimit) {
        return fail('unsupported', `Embedding input ${i} (~${est} estimated tokens) exceeds the model's context length (${perInputLimit}); no request was sent.`, { nextStep: 'Chunk the text more finely (memory.chunkMaxTokens) before embedding.' });
      }
    }
    const runId = req.runId || ctx.runId;
    const traceId = newTraceId();
    const callGroupId = newId('llmgrp');
    const batchSize = Math.max(1, this.opts.embedBatchSize ?? 64);
    const personalData = this.personalDataPolicy();
    const vectors: Float32Array[] = [];
    let dims: number | null = null;
    let totalTokens: number | null = 0;
    let totalCost: Micros | null = 0;
    let modelReturned: string | null = null;
    const prices = resolvePrices(caps, ctx.config, pre.modelId, catalog.retrievedAt);
    const batchCount = Math.ceil(req.texts.length / batchSize);
    // Billing state of a failure: earlier batches of this call were billed even though their vectors
    // are discarded with the failure, and a response that was processed and then refused was billed too.
    let billedBatches = 0;
    const failureBilling = (current: 'not_billed' | 'maybe_billed' | 'billed_unknown' | { micros: Micros | null }): EmbedFailureBilling => {
      if (current === 'not_billed') {
        if (billedBatches === 0) return {};
        return totalCost === null ? { billed: true, chargeUnknown: true, costMicros: null } : { billed: true, costMicros: totalCost };
      }
      if (current === 'maybe_billed') return { chargeUnknown: true, costMicros: null, ...(billedBatches > 0 ? { billed: true } : {}) };
      if (current === 'billed_unknown') return { billed: true, chargeUnknown: true, costMicros: null };
      const c = totalCost === null || current.micros === null ? null : totalCost + current.micros;
      return c === null ? { billed: true, chargeUnknown: true, costMicros: null } : { billed: true, costMicros: c };
    };
    const failWith = (f: Failure, current: Parameters<typeof failureBilling>[0]): EmbedResult => ({ ...f, ...failureBilling(current) });
    if (prices.inputSource === 'unknown' && batchCount > 1 && !ctx.dryRun) {
      // An unknown-price approval covers exactly one request; never spend on batch 1 and then stop.
      return fail('budget_unknown_price', `No verified price for embedding model ${pre.modelId}, and the ${req.texts.length} input(s) need ${batchCount} requests (batch size ${batchSize}); an unknown-price approval covers exactly one request, so nothing was sent.`, {
        nextStep: `Verify the price and set llm.pricingOverrides["${pre.modelId}"] in the site config, or embed at most ${batchSize} input(s) per call and approve each request.`,
      });
    }
    for (let start = 0, attempt = 1; start < req.texts.length; start += batchSize, attempt++) {
      const batch = req.texts.slice(start, start + batchSize).map((t) => (personalData.allowed ? redactString(t) : sanitizeEmbeddingInput(t)));
      const inputTokens = batch.reduce((s, t) => s + estimateTokens(t), 0);
      let estimate = estimateEmbeddingCost(prices, inputTokens);
      const body: Record<string, unknown> = { model: pre.modelId, input: batch, encoding_format: 'float', ...(requestDims !== undefined ? { dimensions: requestDims } : {}) };
      const params: Record<string, unknown> = { request: { model: pre.modelId, inputs: batch.length, encoding_format: 'float', ...(requestDims !== undefined ? { dimensions: requestDims } : {}) }, inputTokensEstimate: inputTokens, estimate, expectedDimensions: expectedDims, catalog: { snapshotId: catalog.snapshotId, retrievedAt: catalog.retrievedAt, stale: catalog.stale }, modelWarnings: resolved.warnings };
      const record = (over: Partial<LlmCallRecord> & Pick<LlmCallRecord, 'status' | 'validationStatus'>) =>
        insertLlmCall(ctx.db, {
          siteId: ctx.siteId,
          runId,
          traceId,
          callGroupId,
          attempt,
          role: 'embedder',
          tier: 'embedding',
          promptId: 'embeddings',
          promptVersion: 'embeddings@none',
          modelRequested: pre.modelId,
          modelReturned: null,
          params,
          maxOutputTokens: 0,
          inputTokens: null,
          outputTokens: null,
          reasoningTokens: null,
          costMicros: null,
          costStatus: 'unknown',
          schemaName: null,
          repairAttempts: 0,
          truncation: [],
          evidenceBundleHash: null,
          providerRequestId: null,
          reservationId: null,
          responseFormat: 'embedding',
          httpStatus: null,
          error: null,
          isSynthetic: false,
          createdAt: ctx.clock.now(),
          ...over,
        });
      if (ctx.dryRun) return fail('disabled', `Dry run: would embed ${req.texts.length} input(s) with ${pre.modelId} (upper bound for the first batch ${estimate.upperBoundMicros === null ? 'unknown' : formatUsd(estimate.upperBoundMicros)}); nothing was sent or reserved.`);
      const capped = this.checkRequestCap(estimate);
      if (capped) return failWith(capped, 'not_billed');
      const purpose = `llm.embeddings ${batch.length} input(s) batch ${attempt}`;
      let approvalId: string | undefined;
      let requestHash: string | undefined;
      if (estimate.upperBoundMicros === null) {
        requestHash = approvalRequestHash('embeddings', body);
        const auth = this.authorizeUnknownPrice({
          traceId,
          endpoint: 'embeddings',
          requestHash,
          modelId: pre.modelId,
          purpose,
          basisDetail: estimate.basis.detail,
          ...(req.unknownPriceApprovalId ? { approvalId: req.unknownPriceApprovalId } : {}),
          ...(req.unknownPriceMaxChargeMicros !== undefined ? { maxChargeMicros: req.unknownPriceMaxChargeMicros } : {}),
        });
        if (!auth.ok) return failWith(auth, 'not_billed');
        estimate = auth.estimate;
        approvalId = auth.approvalId;
        params.estimate = estimate;
        params.unknownPriceApproval = { approvalId, requestHash };
      }
      const reserved = this.reserve({ runId, traceId }, estimate, purpose, approvalId);
      if (!reserved.ok) return failWith(reserved, 'not_billed');
      const reservationId = reserved.reservationId;
      if (approvalId) {
        const consumed = this.consumeApproval(approvalId, 'embeddings', requestHash!, reservationId, traceId);
        if (!consumed.ok) {
          ctx.budgets.release(reservationId, `unknown-price approval ${approvalId} could not be consumed; nothing was sent`);
          return failWith(consumed, 'not_billed');
        }
      }
      const preq = ctx.requests.prepare({ siteId: ctx.siteId, provider: 'llm_gateway', endpoint: 'embeddings', method: 'POST', isPaid: true, params: body, reservationId, traceId });
      ctx.budgets.attachRequest(reservationId, preq.id);
      ctx.requests.markSubmitted(preq.id);
      let http;
      try {
        http = await fetchWithTimeout(this.fetchFn, gatewayUrl(ctx.settings.llmBaseUrl, 'embeddings'), { method: 'POST', headers: authHeaders(pre.apiKey, { 'content-type': 'application/json' }), body: JSON.stringify(body) }, this.paidTimeoutMs(), req.signal);
      } catch (err) {
        const t = err instanceof TransportError ? err : new TransportError('unknown', errorMessage(err));
        if (t.kind === 'not_sent') {
          ctx.requests.complete(preq.id, { status: 'failed', error: { kind: t.kind, message: t.message } });
          ctx.budgets.release(reservationId, `not submitted: ${t.message}`);
          record({ status: 'provider_error', validationStatus: 'error', providerRequestId: preq.id, reservationId, costMicros: 0, costStatus: 'actual', error: { kind: t.kind, message: t.message } });
          return failWith(fail('provider_error', `Embeddings request was not delivered: ${t.message}`), 'not_billed');
        }
        ctx.requests.complete(preq.id, { status: 'ambiguous', error: { kind: t.kind, message: t.message } });
        ctx.budgets.markUnresolved(reservationId, `ambiguous ${t.kind}: ${t.message}`);
        record({ status: 'ambiguous', validationStatus: 'error', providerRequestId: preq.id, reservationId, error: { kind: t.kind, message: t.message } });
        return failWith(
          fail('provider_error', `Embeddings request ${t.kind === 'timeout' ? 'timed out' : 'failed'} after submission; charge unknown, reservation unresolved. Not retried automatically.`, {
            ambiguous: true,
            reservationId,
            nextStep: reconcileNextStep(reservationId),
          }),
          'maybe_billed',
        );
      }
      if (http.status < 200 || http.status >= 300) {
        const env = parseErrorEnvelope(http.text);
        const cls = classifyHttpFailure(http.status, env, http.headers, 'embeddings');
        if (cls.billing === 'not_billed') {
          ctx.requests.complete(preq.id, { status: 'failed', httpStatus: http.status, error: env });
          ctx.budgets.release(reservationId, `rejected by gateway: HTTP ${http.status}`);
        } else {
          ctx.requests.complete(preq.id, { status: 'ambiguous', httpStatus: http.status, error: env });
          ctx.budgets.markUnresolved(reservationId, `HTTP ${http.status}: billing state not guaranteed`);
        }
        record({ status: cls.billing === 'ambiguous' ? 'ambiguous' : 'provider_error', validationStatus: 'error', providerRequestId: preq.id, reservationId, httpStatus: http.status, ...(cls.billing === 'not_billed' ? { costMicros: 0, costStatus: 'actual' as const } : {}), error: env });
        return failWith(fail(cls.status, cls.reason, { nextStep: cls.billing === 'ambiguous' ? `Billing state is not guaranteed. ${reconcileNextStep(reservationId)}` : cls.nextStep, ...(cls.billing === 'ambiguous' ? { ambiguous: true, reservationId } : {}) }), cls.billing === 'ambiguous' ? 'maybe_billed' : 'not_billed');
      }
      let parsed: { vectors: Float32Array[]; body: Record<string, unknown> };
      try {
        const b = JSON.parse(http.text) as Record<string, unknown>;
        parsed = { vectors: decodeEmbeddings(b, batch.length), body: b };
      } catch (err) {
        ctx.requests.complete(preq.id, { status: 'succeeded', httpStatus: http.status, error: { message: errorMessage(err) } });
        ctx.budgets.reconcile(reservationId, { actualMicros: null, source: 'gateway_reported', usage: { note: `invalid embeddings response: ${errorMessage(err)}` }, providerRequestId: preq.id });
        record({ status: 'provider_error', validationStatus: 'error', providerRequestId: preq.id, reservationId, httpStatus: http.status, error: { message: errorMessage(err) } });
        // The gateway processed the request (HTTP 2xx), so it was billed, but its usage cannot be read.
        return failWith(
          fail('provider_error', `Invalid embeddings response: ${errorMessage(err)} (the request was processed, so it was billed; charge unknown; reservation ${reservationId} left unresolved).`, {
            reservationId,
            nextStep: reconcileNextStep(reservationId),
          }),
          'billed_unknown',
        );
      }
      const usage = parseUsage(parsed.body.usage);
      const cost = actualEmbeddingCost(usage, prices);
      ctx.budgets.reconcile(reservationId, { actualMicros: cost.micros, source: cost.source === 'computed_from_usage' ? 'computed_from_usage' : 'gateway_reported', usage: { prompt_tokens: usage.promptTokens, detail: cost.detail }, providerRequestId: preq.id });
      const rawRef = ctx.raw.save({ siteId: ctx.siteId, provider: 'llm_gateway', kind: 'embeddings-meta', payload: { model: parsed.body.model, usage: parsed.body.usage, count: parsed.vectors.length, dims: parsed.vectors[0]?.length ?? null }, at: ctx.clock.now() });
      ctx.requests.complete(preq.id, { status: 'succeeded', httpStatus: http.status, rawRef });
      const batchModel = typeof parsed.body.model === 'string' && parsed.body.model.trim() ? parsed.body.model.trim() : null;
      // One call returns one model id for all its vectors: batches served by different models are never mixed.
      const modelError = batchModel && modelReturned && batchModel.toLowerCase() !== modelReturned.toLowerCase() ? `batch ${attempt} came from model "${batchModel}" but earlier batches of this request came from "${modelReturned}"` : null;
      modelReturned = batchModel ?? modelReturned;
      const batchDims = parsed.vectors[0]?.length ?? 0;
      const dimsError =
        modelError ??
        (parsed.vectors.some((v) => v.length !== batchDims) || (dims !== null && batchDims !== dims)
          ? 'inconsistent vector dimensions in the response'
          : expectedDims !== null && batchDims !== expectedDims
            ? `returned ${batchDims} dimensions but ${requestDims !== undefined ? `embeddingRequestDimensions is ${requestDims}` : `models.embeddingDimensions is ${configuredDims}`}`
            : null);
      record({
        status: dimsError ? 'provider_error' : 'succeeded',
        validationStatus: dimsError ? 'invalid' : 'not_applicable',
        providerRequestId: preq.id,
        reservationId,
        httpStatus: http.status,
        modelReturned,
        inputTokens: usage.promptTokens,
        outputTokens: null,
        costMicros: cost.micros,
        costStatus: cost.source === 'gateway_reported' ? 'actual' : cost.source === 'computed_from_usage' ? 'estimated' : 'unknown',
        ...(dimsError ? { error: { message: dimsError } } : {}),
      });
      if (dimsError) {
        // Reconciled above: the charge is recorded even though the vectors are discarded.
        const billing = failureBilling({ micros: cost.micros });
        return {
          ...fail('provider_error', `Embedding ${modelError ? 'model' : 'dimension'} check failed: ${dimsError}. Vectors were discarded (incompatible vectors are never mixed); the request was billed (${billing.costMicros === null || billing.costMicros === undefined ? 'charge unknown' : formatUsd(billing.costMicros)}).`, {
            nextStep: 'Verify models.embeddingDimensions against the model documentation; changing dimensions requires a separate collection or a reindex.',
          }),
          ...billing,
        };
      }
      billedBatches++;
      dims = batchDims;
      vectors.push(...parsed.vectors);
      totalTokens = totalTokens === null || usage.promptTokens === null ? null : totalTokens + usage.promptTokens;
      totalCost = totalCost === null || cost.micros === null ? null : totalCost + cost.micros;
    }
    return { ok: true, vectors, model: modelReturned ?? pre.modelId, dimensions: dims ?? 0, usage: { inputTokens: totalTokens, outputTokens: null, reasoningTokens: null }, costMicros: totalCost };
  }
}

/** Text sent for embedding: secrets redacted and personal identifiers masked (same policy as evidence). */
/**
 * Heuristic injection signals found in template variables, by variable name.
 * Strings are scanned as is; objects and arrays as their JSON text. Numbers,
 * booleans, and dates cannot carry instructions and are skipped.
 */
export function variableInjectionSignals(variables: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(variables)) {
    let text: string | null = null;
    if (typeof value === 'string') text = value;
    else if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      try {
        text = JSON.stringify(value) ?? null;
      } catch {
        text = null;
      }
    }
    if (!text) continue;
    const signals = detectInjectionSignals(text);
    if (signals.length) out[name] = signals;
  }
  return out;
}

function sanitizeEmbeddingInput(text: string): string {
  return redactPersonalIdentifiers(redactString(text), { phones: true, handles: true }).text;
}

/** Decode `data[]` (float arrays or base64 float32 little-endian) sorted by index. */
export function decodeEmbeddings(body: Record<string, unknown>, expected: number): Float32Array[] {
  const data = body.data;
  if (!Array.isArray(data)) throw new Error('response has no data[] array');
  if (data.length !== expected) throw new Error(`expected ${expected} embeddings, got ${data.length}`);
  const items = data.map((d, i) => {
    const o = d as { index?: unknown; embedding?: unknown };
    const index = typeof o.index === 'number' ? o.index : i;
    let vec: Float32Array;
    if (Array.isArray(o.embedding)) {
      if (!o.embedding.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new Error(`embedding ${index} contains non-numeric values`);
      vec = Float32Array.from(o.embedding as number[]);
    } else if (typeof o.embedding === 'string') {
      const buf = Buffer.from(o.embedding, 'base64');
      if (buf.length % 4 !== 0) throw new Error(`embedding ${index} base64 length is not a multiple of 4 bytes`);
      vec = new Float32Array(buf.length / 4);
      for (let k = 0; k < vec.length; k++) vec[k] = buf.readFloatLE(k * 4);
    } else throw new Error(`embedding ${index} is missing`);
    if (!vec.length) throw new Error(`embedding ${index} is empty`);
    return { index, vec };
  });
  items.sort((a, b) => a.index - b.index);
  items.forEach((it, i) => {
    if (it.index !== i) throw new Error('embedding indices are not a complete 0..n-1 sequence');
  });
  return items.map((i) => i.vec);
}

/** Create the LLM Gateway client for a site context. */
export function createLlmClient(ctx: AppContext, opts: GatewayClientOptions = {}): GatewayLlmClient {
  return new GatewayLlmClient(ctx, opts);
}
