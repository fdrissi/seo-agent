import { z } from 'zod';
import type { AppContext } from '../../app/context.js';
import { errorMessage } from '../../core/errors.js';
import { newId } from '../../core/ids.js';
import { toMicros, type Micros } from '../../core/money.js';
import { redactString } from '../../security/redact.js';
import type { FetchLike } from '../types.js';
import { authHeaders, checkGatewayBaseUrl, classifyTransportError, fetchWithTimeout, gatewayUrl, normalizeBaseUrl, parseErrorEnvelope } from './http.js';
import { perTokenPriceToMicrosPerMillion, usdAmountToMicrosCeil } from './pricing.js';
import type { ModelTier } from './types.js';

/**
 * Model discovery via the verified `GET /v1/models` endpoint
 * (docs/integration-contracts.md §1). It is free (no completion is made);
 * with a key the list is filtered by the key's compliance/IAM/project access.
 *
 * Capabilities are cached in SQLite with their retrieval time. Configured
 * CHEAP_MODEL / REASONING_MODEL / EMBEDDING_MODEL ids are checked against the
 * catalog before use; an unknown id is reported as `invalid_model` and no
 * substitute is ever chosen automatically.
 */

export const DEFAULT_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A stale cache may still be used (flagged) when a refresh fails, up to this age. */
export const MAX_STALE_CATALOG_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SNAPSHOTS_KEPT = 30;

export interface ModelPricingStrings {
  prompt: string | null;
  completion: string | null;
  request: string | null;
  internalReasoning: string | null;
  inputCacheRead: string | null;
}

export interface ProviderMapping {
  providerId: string;
  tools: boolean | null;
  parallelToolCalls: boolean | null;
  reasoning: boolean | null;
  reasoningEfforts: string[] | null;
  maxOutput: number | null;
  streaming: boolean | 'only' | null;
  pricing: ModelPricingStrings | null;
}

/** Model facts as listed by the catalog (before provider aggregation). */
export interface BaseModelInfo {
  id: string;
  name: string | null;
  aliases: string[];
  family: string | null;
  contextLength: number | null;
  /** The model entry's own max_output. */
  modelMaxOutput: number | null;
  structuredOutputs: boolean | null;
  jsonOutput: boolean | null;
  supportedParameters: string[] | null;
  inputModalities: string[];
  outputModalities: string[];
  /** architecture.output_modalities includes "embedding" (the documented test). */
  isEmbedding: boolean;
  deprecatedAt: string | null;
  deactivatedAt: string | null;
  stability: string | null;
  free: boolean | null;
  providers: ProviderMapping[];
  /** Verbatim top-level catalog price strings. */
  pricing: ModelPricingStrings;
}

export interface ModelCapabilities extends BaseModelInfo {
  /** Conservative: minimum of the model's and its (applicable) provider mappings' max_output. */
  maxOutput: number | null;
  /** True only when every applicable provider mapping supports tools (routing may pick any mapping). */
  tools: boolean | null;
  parallelToolCalls: boolean | null;
  /** True only when every applicable mapping supports reasoning (reasoning params are safe to send). */
  reasoning: boolean | null;
  /** True when any applicable mapping can reason (reasoning tokens must be budgeted). */
  reasoningPossible: boolean;
  /** reasoning_effort values accepted by every applicable mapping. */
  reasoningEfforts: string[] | null;
  /** Conservative prices (max over applicable mappings) in micros per 1M tokens; null = unknown. */
  prices: { inputPerMillion: Micros | null; outputPerMillion: Micros | null; reasoningPerMillion: Micros | null; requestFeeMicros: Micros | null };
  /** Set when the configured id pinned a provider (`provider/model`). */
  pinnedProvider: string | null;
}

// --- tolerant parsing (unknown fields are allowed; the API adds fields without versioning) ---

const optBool = z.boolean().nullable().optional();
const optNum = z.number().nullable().optional();
const optStr = z.string().nullable().optional();

const providerSchema = z.looseObject({
  providerId: z.string().min(1),
  tools: optBool,
  parallelToolCalls: optBool,
  reasoning: optBool,
  reasoning_efforts: z.array(z.string()).nullable().optional(),
  max_output: optNum,
  streaming: z.union([z.boolean(), z.literal('only')]).nullable().optional(),
  pricing: z.unknown().optional(),
});

const modelSchema = z.looseObject({
  id: z.string().min(1),
  name: optStr,
  aliases: z.array(z.string()).nullable().optional(),
  family: optStr,
  architecture: z
    .looseObject({ input_modalities: z.array(z.string()).nullable().optional(), output_modalities: z.array(z.string()).nullable().optional() })
    .nullable()
    .optional(),
  providers: z.array(z.unknown()).nullable().optional(),
  pricing: z.unknown().optional(),
  context_length: optNum,
  max_output: optNum,
  supported_parameters: z.array(z.string()).nullable().optional(),
  json_output: optBool,
  structured_outputs: optBool,
  free: optBool,
  deprecated_at: optStr,
  deactivated_at: optStr,
  stability: optStr,
});

function priceStrings(p: unknown): ModelPricingStrings | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : null);
  return { prompt: s(o.prompt), completion: s(o.completion), request: s(o.request), internalReasoning: s(o.internal_reasoning), inputCacheRead: s(o.input_cache_read) };
}

const EMPTY_PRICING: ModelPricingStrings = { prompt: null, completion: null, request: null, internalReasoning: null, inputCacheRead: null };

function parseProvider(raw: unknown): ProviderMapping | null {
  const r = providerSchema.safeParse(raw);
  if (!r.success) return null;
  const p = r.data;
  return {
    providerId: p.providerId,
    tools: p.tools ?? null,
    parallelToolCalls: p.parallelToolCalls ?? null,
    reasoning: p.reasoning ?? null,
    reasoningEfforts: p.reasoning_efforts ?? null,
    maxOutput: typeof p.max_output === 'number' && p.max_output > 0 ? p.max_output : null,
    streaming: p.streaming ?? null,
    pricing: priceStrings(p.pricing),
  };
}

function allTrue(values: Array<boolean | null>): boolean | null {
  if (!values.length) return null;
  if (values.some((v) => v === false)) return false;
  if (values.every((v) => v === true)) return true;
  return null;
}

function minPositive(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && v > 0);
  return nums.length ? Math.min(...nums) : null;
}

/** Max of prices; null (unknown) when any applicable price is unknown. */
function maxKnown(values: Array<Micros | null>): Micros | null {
  if (!values.length || values.some((v) => v === null)) return null;
  return Math.max(...(values as Micros[]));
}

function maxOptional(values: Array<Micros | null>): Micros | null {
  const known = values.filter((v): v is Micros => v !== null);
  return known.length ? Math.max(...known) : null;
}

/**
 * Derive capabilities for a model, optionally restricted to one pinned
 * provider mapping (`provider/model`). A plain id may be routed to any of its
 * mappings (with fallback), so flags require every mapping and prices take
 * the maximum; a mapping without its own price falls back to the top-level
 * catalog price. Any unknown applicable price makes the result unknown.
 */
export function deriveCapabilities(base: BaseModelInfo, pinnedProvider: string | null = null): ModelCapabilities {
  const mappings = pinnedProvider ? base.providers.filter((p) => p.providerId === pinnedProvider) : base.providers;
  const efforts = mappings.map((m) => m.reasoningEfforts);
  const reasoningEfforts =
    mappings.length > 0 && efforts.every((e): e is string[] => Array.isArray(e)) ? (efforts as string[][]).reduce((acc, e) => acc.filter((x) => e.includes(x))) : null;
  const effective = (m: ProviderMapping | null, key: keyof ModelPricingStrings) => (m?.pricing?.[key] ?? null) || base.pricing[key];
  const applicable: Array<ProviderMapping | null> = mappings.length ? mappings : [null];
  const inputs = applicable.map((m) => perTokenPriceToMicrosPerMillion(effective(m, 'prompt')));
  const outputs = applicable.map((m) => perTokenPriceToMicrosPerMillion(effective(m, 'completion')));
  const reasoningPrices = applicable.map((m) => perTokenPriceToMicrosPerMillion(effective(m, 'internalReasoning')));
  const requestFees = applicable.map((m) => {
    const fee = effective(m, 'request');
    return fee ? usdAmountToMicrosCeil(fee) : null;
  });
  const pricing = pinnedProvider && mappings[0]?.pricing ? { ...base.pricing, ...Object.fromEntries(Object.entries(mappings[0].pricing).filter(([, v]) => v !== null)) } : base.pricing;
  return {
    ...base,
    pricing: pricing as ModelPricingStrings,
    maxOutput: minPositive([base.modelMaxOutput, ...mappings.map((m) => m.maxOutput)]),
    tools: allTrue(mappings.map((m) => m.tools)),
    parallelToolCalls: allTrue(mappings.map((m) => m.parallelToolCalls)),
    reasoning: allTrue(mappings.map((m) => m.reasoning)),
    reasoningPossible: mappings.some((m) => m.reasoning === true),
    reasoningEfforts,
    prices: {
      inputPerMillion: maxKnown(inputs),
      outputPerMillion: maxKnown(outputs),
      reasoningPerMillion: maxOptional(reasoningPrices),
      requestFeeMicros: maxOptional(requestFees),
    },
    pinnedProvider,
  };
}

/** Strip derived fields back to the catalog facts. */
export function baseInfo(caps: ModelCapabilities | BaseModelInfo): BaseModelInfo {
  const c = caps as ModelCapabilities;
  return {
    id: c.id,
    name: c.name,
    aliases: c.aliases,
    family: c.family,
    contextLength: c.contextLength,
    modelMaxOutput: c.modelMaxOutput,
    structuredOutputs: c.structuredOutputs,
    jsonOutput: c.jsonOutput,
    supportedParameters: c.supportedParameters,
    inputModalities: c.inputModalities,
    outputModalities: c.outputModalities,
    isEmbedding: c.isEmbedding,
    deprecatedAt: c.deprecatedAt,
    deactivatedAt: c.deactivatedAt,
    stability: c.stability,
    free: c.free,
    providers: c.providers,
    pricing: c.pricing,
  };
}

type BaseModel = BaseModelInfo;

export interface ParsedCatalog {
  models: BaseModel[];
  skipped: Array<{ index: number; reason: string }>;
}

/** Parse a `/v1/models` response body. Invalid entries are skipped and counted, never guessed. */
export function parseModelsResponse(body: unknown): ParsedCatalog {
  const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) throw new Error('models response has no data[] array');
  const models: BaseModel[] = [];
  const skipped: ParsedCatalog['skipped'] = [];
  data.forEach((raw, index) => {
    const r = modelSchema.safeParse(raw);
    if (!r.success) {
      skipped.push({ index, reason: r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      return;
    }
    const m = r.data;
    const outputModalities = m.architecture?.output_modalities ?? [];
    models.push({
      id: m.id,
      name: m.name ?? null,
      aliases: m.aliases ?? [],
      family: m.family ?? null,
      contextLength: typeof m.context_length === 'number' && m.context_length > 0 ? m.context_length : null,
      modelMaxOutput: typeof m.max_output === 'number' && m.max_output > 0 ? m.max_output : null,
      structuredOutputs: m.structured_outputs ?? null,
      jsonOutput: m.json_output ?? null,
      supportedParameters: m.supported_parameters ?? null,
      inputModalities: m.architecture?.input_modalities ?? [],
      outputModalities,
      isEmbedding: outputModalities.includes('embedding'),
      deprecatedAt: m.deprecated_at ?? null,
      deactivatedAt: m.deactivated_at ?? null,
      stability: m.stability ?? null,
      free: m.free ?? null,
      providers: (m.providers ?? []).map(parseProvider).filter((p): p is ProviderMapping => !!p),
      pricing: priceStrings(m.pricing) ?? EMPTY_PRICING,
    });
  });
  return { models, skipped };
}

export interface ModelCatalog {
  snapshotId: string;
  baseUrl: string;
  retrievedAt: string;
  authenticated: boolean;
  source: 'network' | 'cache';
  /** True when the cache is older than the freshness window (used only because a refresh failed or offline). */
  stale: boolean;
  skipped: number;
  models: ModelCapabilities[];
  isSynthetic: boolean;
}

export type DiscoveryState = 'offline' | 'unreachable' | 'unauthorized' | 'permission_denied' | 'invalid_response' | 'disabled' | 'misconfigured';

export type DiscoveryResult = { ok: true; catalog: ModelCatalog; warning?: string } | { ok: false; state: DiscoveryState; reason: string; nextStep: string; httpStatus?: number };

export interface DiscoverOptions {
  fetch?: FetchLike;
  /** Ignore a fresh cache and query the gateway. */
  force?: boolean;
  maxAgeMs?: number;
  timeoutMs?: number;
}

function capsRowFromBase(b: BaseModel): ModelCapabilities {
  return deriveCapabilities(b, null);
}

function persistSnapshot(ctx: AppContext, input: { baseUrl: string; authenticated: boolean; parsed: ParsedCatalog; rawRef: string | null; providerRequestId: string | null; retrievedAt: string }): string {
  const id = newId('llmcat');
  ctx.db.transaction(() => {
    ctx.db.run(
      `INSERT INTO llm_model_catalog_snapshots (id, site_id, base_url, authenticated, model_count, skipped_count, raw_ref, provider_request_id, is_synthetic, retrieved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ctx.siteId, input.baseUrl, input.authenticated ? 1 : 0, input.parsed.models.length, input.parsed.skipped.length, input.rawRef, input.providerRequestId, ctx.synthetic ? 1 : 0, input.retrievedAt],
    );
    const seen = new Set<string>();
    for (const b of input.parsed.models) {
      if (seen.has(b.id)) continue; // duplicate ids: keep the first entry
      seen.add(b.id);
      const caps = capsRowFromBase(b);
      const tri = (v: boolean | null) => (v === null ? null : v ? 1 : 0);
      ctx.db.run(
        `INSERT INTO llm_model_capabilities (snapshot_id, site_id, model_id, is_embedding, context_length, max_output, structured_outputs, json_output, tools, reasoning,
           prompt_price, completion_price, deprecated_at, deactivated_at, capabilities_json, retrieved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          ctx.siteId,
          b.id,
          b.isEmbedding ? 1 : 0,
          b.contextLength,
          caps.maxOutput,
          tri(b.structuredOutputs),
          tri(b.jsonOutput),
          tri(caps.tools),
          tri(caps.reasoning),
          b.pricing.prompt,
          b.pricing.completion,
          b.deprecatedAt,
          b.deactivatedAt,
          JSON.stringify(b),
          input.retrievedAt,
        ],
      );
    }
    // Bounded history: keep the most recent snapshots per (site, base URL).
    const old = ctx.db.all<{ id: string }>(
      `SELECT id FROM llm_model_catalog_snapshots WHERE site_id = ? AND base_url = ? ORDER BY retrieved_at DESC, id DESC LIMIT -1 OFFSET ?`,
      [ctx.siteId, input.baseUrl, SNAPSHOTS_KEPT],
    );
    for (const o of old) ctx.db.run('DELETE FROM llm_model_catalog_snapshots WHERE id = ? AND site_id = ?', [o.id, ctx.siteId]);
  });
  return id;
}

/** Load the latest cached catalog for this site and base URL (no network). */
export function loadCachedCatalog(ctx: AppContext, opts: { maxAgeMs?: number } = {}): ModelCatalog | null {
  // An insecure/invalid base URL has no usable catalog (and callers such as reports must not crash on it).
  const checked = checkGatewayBaseUrl(ctx.settings.llmBaseUrl);
  if (!checked.ok) return null;
  const baseUrl = checked.url;
  const snap = ctx.db.get<{ id: string; authenticated: number; skipped_count: number; retrieved_at: string; is_synthetic: number }>(
    `SELECT id, authenticated, skipped_count, retrieved_at, is_synthetic FROM llm_model_catalog_snapshots WHERE site_id = ? AND base_url = ? ORDER BY retrieved_at DESC, id DESC LIMIT 1`,
    [ctx.siteId, baseUrl],
  );
  if (!snap) return null;
  const rows = ctx.db.all<{ capabilities_json: string }>('SELECT capabilities_json FROM llm_model_capabilities WHERE snapshot_id = ? AND site_id = ? ORDER BY model_id', [snap.id, ctx.siteId]);
  const models: ModelCapabilities[] = [];
  for (const r of rows) {
    try {
      models.push(capsRowFromBase(JSON.parse(r.capabilities_json) as BaseModel));
    } catch {
      /* corrupt row: skip (never guessed) */
    }
  }
  const age = ctx.clock.now().getTime() - Date.parse(snap.retrieved_at);
  return {
    snapshotId: snap.id,
    baseUrl,
    retrievedAt: snap.retrieved_at,
    authenticated: snap.authenticated === 1,
    source: 'cache',
    stale: age > (opts.maxAgeMs ?? DEFAULT_CATALOG_MAX_AGE_MS),
    skipped: snap.skipped_count,
    models,
    isSynthetic: snap.is_synthetic === 1,
  };
}

/**
 * Discover models (free, read-only). Uses a fresh cache when available;
 * otherwise queries `GET /v1/models` (authenticated when a key exists) and
 * caches the parsed capabilities with the retrieval time.
 */
export async function discoverModels(ctx: AppContext, opts: DiscoverOptions = {}): Promise<DiscoveryResult> {
  // Never send the key (models listing is authenticated when a key exists) to an insecure base URL.
  const base = checkGatewayBaseUrl(ctx.settings.llmBaseUrl);
  if (!base.ok) return { ok: false, state: 'misconfigured', reason: base.reason, nextStep: base.nextStep };
  const maxAge = opts.maxAgeMs ?? DEFAULT_CATALOG_MAX_AGE_MS;
  const cached = loadCachedCatalog(ctx, { maxAgeMs: maxAge });
  // With a key, capability checks must use the key's IAM-filtered list (verified contract):
  // an unauthenticated snapshot (the unfiltered public catalogue) is never reused as if it were.
  const keyPresent = ctx.secrets.has('LLM_GATEWAY_API_KEY');
  const unfilteredForKey = !!cached && keyPresent && !cached.authenticated;
  if (cached && !cached.stale && !opts.force && !unfilteredForKey) return { ok: true, catalog: cached };

  const staleFallback = (reason: string): DiscoveryResult | null => {
    if (!cached || unfilteredForKey) return null;
    const age = ctx.clock.now().getTime() - Date.parse(cached.retrievedAt);
    if (age > MAX_STALE_CATALOG_AGE_MS) return null;
    return { ok: true, catalog: { ...cached, stale: cached.stale }, warning: `Using cached model catalog from ${cached.retrievedAt}: ${reason}` };
  };

  if (ctx.offline) {
    const warnings = [
      ...(cached?.stale ? [`Offline: model catalog from ${cached.retrievedAt} may be stale`] : []),
      ...(unfilteredForKey ? [`Offline: the cached catalog from ${cached!.retrievedAt} is the unfiltered public list (retrieved without a key); it may list models this key cannot use`] : []),
    ];
    const fb = cached ? { ok: true as const, catalog: cached, ...(warnings.length ? { warning: warnings.join('; ') } : {}) } : null;
    return fb ?? { ok: false, state: 'offline', reason: 'Network access is disabled (offline/demo mode) and no cached model catalog exists.', nextStep: 'Run `models list` without --offline once LLM Gateway access is configured.' };
  }

  const fetchFn = opts.fetch ?? ctx.fetch;
  const baseUrl = normalizeBaseUrl(ctx.settings.llmBaseUrl);
  const apiKey = ctx.secrets.get('LLM_GATEWAY_API_KEY');
  const preq = ctx.requests.prepare({ siteId: ctx.siteId, provider: 'llm_gateway', endpoint: 'models.list', method: 'GET', isPaid: false, params: { baseUrl, authenticated: !!apiKey }, isSynthetic: ctx.synthetic });
  ctx.requests.markSubmitted(preq.id);
  let res;
  try {
    res = await fetchWithTimeout(fetchFn, gatewayUrl(baseUrl, 'models'), { method: 'GET', headers: authHeaders(apiKey) }, opts.timeoutMs ?? ctx.config.llm.requestTimeoutMs);
  } catch (err) {
    const t = classifyTransportError(err, false, false);
    ctx.requests.complete(preq.id, { status: 'failed', error: { kind: t.kind, message: t.message } });
    return (
      staleFallback(`refresh failed (${t.message})`) ?? {
        ok: false,
        state: 'unreachable',
        reason: `Could not reach the LLM Gateway models endpoint: ${redactString(errorMessage(t))}`,
        nextStep: `Check network access and LLM_GATEWAY_BASE_URL (currently ${baseUrl}).`,
      }
    );
  }
  if (res.status < 200 || res.status >= 300) {
    const env = parseErrorEnvelope(res.text);
    ctx.requests.complete(preq.id, { status: 'failed', httpStatus: res.status, error: env });
    if (res.status === 401) {
      return { ok: false, state: 'unauthorized', httpStatus: 401, reason: `LLM Gateway rejected the API key when listing models${env.message ? `: ${env.message}` : ''}`, nextStep: 'Check LLM_GATEWAY_API_KEY in <workspace>/secrets/secrets.env (never paste keys into chat).' };
    }
    if (res.status === 403) {
      return { ok: false, state: 'permission_denied', httpStatus: 403, reason: `LLM Gateway denied model listing${env.message ? `: ${env.message}` : ''}`, nextStep: 'Check the key/project IAM rules in the LLM Gateway dashboard.' };
    }
    return (
      staleFallback(`refresh returned HTTP ${res.status}`) ?? {
        ok: false,
        state: 'unreachable',
        httpStatus: res.status,
        reason: `LLM Gateway models endpoint returned HTTP ${res.status}${env.message ? `: ${env.message}` : ''}`,
        nextStep: 'Retry later; check https://docs.llmgateway.io for incidents.',
      }
    );
  }
  let parsed: ParsedCatalog;
  let body: unknown;
  try {
    body = JSON.parse(res.text);
    parsed = parseModelsResponse(body);
  } catch (err) {
    ctx.requests.complete(preq.id, { status: 'failed', httpStatus: res.status, error: { message: `invalid models response: ${errorMessage(err)}` } });
    return staleFallback('refresh returned an unparseable response') ?? { ok: false, state: 'invalid_response', reason: `Unparseable models response: ${errorMessage(err)}`, nextStep: 'Check LLM_GATEWAY_BASE_URL points to an OpenAI-compatible LLM Gateway /v1 base.' };
  }
  const retrievedAt = ctx.clock.now().toISOString();
  const rawRef = ctx.raw.save({ siteId: ctx.siteId, provider: 'llm_gateway', kind: 'models', payload: body, at: ctx.clock.now() });
  ctx.requests.complete(preq.id, { status: 'succeeded', httpStatus: res.status, rawRef });
  const snapshotId = persistSnapshot(ctx, { baseUrl, authenticated: !!apiKey, parsed, rawRef, providerRequestId: preq.id, retrievedAt });
  const seen = new Set<string>();
  const models = parsed.models.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true))).map(capsRowFromBase);
  return {
    ok: true,
    catalog: { snapshotId, baseUrl, retrievedAt, authenticated: !!apiKey, source: 'network', stale: false, skipped: parsed.skipped.length, models, isSynthetic: ctx.synthetic },
  };
}

export type ModelLookup =
  | { ok: true; caps: ModelCapabilities; resolvedVia: 'id' | 'alias' | 'provider_pin'; warnings: string[] }
  | { ok: false; reason: string; nextStep: string; similar: string[] };

function similarIds(catalog: ModelCatalog, id: string): string[] {
  const tokens = id.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  if (!tokens.length) return [];
  return catalog.models
    .map((m) => ({ id: m.id, score: tokens.filter((t) => m.id.toLowerCase().includes(t)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 5)
    .map((x) => x.id);
}

/**
 * Find a configured model id in the catalog: exact id, a documented alias, or
 * a `provider/model` pin whose provider mapping exists. Deactivated models are
 * rejected. `auto` routing is rejected because its capabilities and price
 * cannot be verified in advance.
 */
export function findModel(catalog: ModelCatalog, id: string, now: Date): ModelLookup {
  const notFound = (reason: string): ModelLookup => ({
    ok: false,
    reason,
    nextStep: 'Run `npm run cli -- models list` and set CHEAP_MODEL / REASONING_MODEL / EMBEDDING_MODEL (or models.* in the site config) to a listed id. No substitute is chosen automatically.',
    similar: similarIds(catalog, id),
  });
  if (!id.trim()) return notFound('model id is empty');
  if (id === 'auto') return notFound('"auto" routing cannot be verified for capabilities or price before use; configure an explicit model id');
  let caps: ModelCapabilities | undefined;
  let via: 'id' | 'alias' | 'provider_pin' = 'id';
  const exact = catalog.models.find((m) => m.id === id);
  if (exact) caps = exact;
  else {
    const alias = catalog.models.find((m) => m.aliases.includes(id));
    if (alias) {
      caps = alias;
      via = 'alias';
    } else if (id.includes('/')) {
      const [provider, ...rest] = id.split('/');
      const modelId = rest.join('/');
      const base = catalog.models.find((m) => m.id === modelId || m.aliases.includes(modelId));
      if (base && base.providers.some((p) => p.providerId === provider)) {
        caps = rederive(base, provider!);
        via = 'provider_pin';
      } else if (base) {
        return notFound(`model "${modelId}" exists but provider "${provider}" is not one of its mappings (${base.providers.map((p) => p.providerId).join(', ') || 'none listed'})`);
      }
    }
  }
  if (!caps) return notFound(`model "${id}" is not in the LLM Gateway catalog${catalog.authenticated ? ' available to this key' : ''} (retrieved ${catalog.retrievedAt})`);
  const warnings: string[] = [];
  if (caps.deactivatedAt) {
    const at = Date.parse(caps.deactivatedAt);
    if (!Number.isNaN(at) && at <= now.getTime()) return notFound(`model "${id}" was deactivated at ${caps.deactivatedAt}`);
    if (!Number.isNaN(at)) warnings.push(`model "${id}" is scheduled for deactivation at ${caps.deactivatedAt}; choose a replacement`);
  }
  if (caps.deprecatedAt) warnings.push(`model "${id}" is deprecated (${caps.deprecatedAt})`);
  if (via === 'alias') warnings.push(`"${id}" is a documented alias of "${caps.id}"`);
  if (catalog.stale) warnings.push(`model catalog is stale (retrieved ${catalog.retrievedAt})`);
  return { ok: true, caps, resolvedVia: via, warnings };
}

function rederive(caps: ModelCapabilities, provider: string): ModelCapabilities {
  return deriveCapabilities(baseInfo(caps), provider);
}

export interface ConfiguredModelCheck {
  tier: ModelTier | 'embedding';
  modelId: string | null;
  source: string;
  status: 'ok' | 'not_configured' | 'invalid_model' | 'wrong_kind' | 'unknown_price';
  detail: string;
  warnings: string[];
  capabilities?: {
    contextLength: number | null;
    maxOutput: number | null;
    structuredOutputs: boolean | null;
    jsonOutput: boolean | null;
    tools: boolean | null;
    reasoning: boolean | null;
    supportsTemperature: boolean | null;
    inputPricePerMillionUsd: string | null;
    outputPricePerMillionUsd: string | null;
    priceSource: 'catalog' | 'override' | 'none';
  };
  similar?: string[];
  nextStep?: string;
}

function microsPerMillionToUsd(m: Micros | null): string | null {
  if (m === null) return null;
  return (m / 1_000_000).toString();
}

/** Check every configured model id against a catalog (no network). */
export function checkConfiguredModels(ctx: AppContext, catalog: ModelCatalog): ConfiguredModelCheck[] {
  const m = ctx.settings.models;
  const tiers: Array<{ tier: ModelTier | 'embedding'; id: string | null; source: string }> = [
    { tier: 'cheap', id: m.cheap, source: m.source.cheap },
    { tier: 'reasoning', id: m.reasoning, source: m.source.reasoning },
    { tier: 'embedding', id: m.embedding, source: m.source.embedding },
  ];
  return tiers.map(({ tier, id, source }) => {
    const envName = tier === 'cheap' ? 'CHEAP_MODEL' : tier === 'reasoning' ? 'REASONING_MODEL' : 'EMBEDDING_MODEL';
    if (!id) {
      return { tier, modelId: null, source, status: 'not_configured', detail: `${envName} is not set`, warnings: [], nextStep: `Set ${envName} (environment or secrets.env) or models.${tier} in the site config to a model id from \`models list\`.` };
    }
    const found = findModel(catalog, id, ctx.clock.now());
    if (!found.ok) return { tier, modelId: id, source, status: 'invalid_model', detail: found.reason, warnings: [], similar: found.similar, nextStep: found.nextStep };
    const caps = found.caps;
    const override = ctx.config.llm.pricingOverrides[id];
    const inPrice = caps.prices.inputPerMillion ?? (override ? toMicros(override.inputPerMillionUsd) : null);
    const outPrice = caps.prices.outputPerMillion ?? (override ? toMicros(override.outputPerMillionUsd) : null);
    const capabilities: ConfiguredModelCheck['capabilities'] = {
      contextLength: caps.contextLength,
      maxOutput: caps.maxOutput,
      structuredOutputs: caps.structuredOutputs,
      jsonOutput: caps.jsonOutput,
      tools: caps.tools,
      reasoning: caps.reasoning,
      supportsTemperature: caps.supportedParameters ? caps.supportedParameters.includes('temperature') : null,
      inputPricePerMillionUsd: microsPerMillionToUsd(inPrice),
      outputPricePerMillionUsd: microsPerMillionToUsd(outPrice),
      priceSource: caps.prices.inputPerMillion !== null ? 'catalog' : override ? 'override' : 'none',
    };
    const warnings = [...found.warnings];
    if (tier === 'embedding' && !caps.isEmbedding) {
      return { tier, modelId: id, source, status: 'wrong_kind', detail: `"${id}" is not an embedding model (architecture.output_modalities lacks "embedding")`, warnings, capabilities, nextStep: 'Set EMBEDDING_MODEL to a model whose catalog entry lists the "embedding" output modality.' };
    }
    if (tier !== 'embedding' && caps.isEmbedding) {
      return { tier, modelId: id, source, status: 'wrong_kind', detail: `"${id}" is an embedding model and cannot serve chat requests`, warnings, capabilities, nextStep: `Set ${envName} to a chat model from \`models list\`.` };
    }
    if (tier !== 'embedding' && !caps.structuredOutputs && !caps.jsonOutput) warnings.push('no native structured/JSON output: prompt-constrained JSON with client-side validation will be used');
    const priceKnown = tier === 'embedding' ? inPrice !== null : inPrice !== null && outPrice !== null;
    if (!priceKnown) {
      return {
        tier,
        modelId: id,
        source,
        status: 'unknown_price',
        detail: `"${id}" exists but has no verifiable price; paid calls will be skipped (BUDGET_UNKNOWN_PRICE) unless approved`,
        warnings,
        capabilities,
        nextStep: `Verify the price in the LLM Gateway models directory and set llm.pricingOverrides["${id}"] in the site config, or choose a model with catalog pricing.`,
      };
    }
    return { tier, modelId: id, source, status: 'ok', detail: `found (${found.resolvedVia}) in catalog retrieved ${catalog.retrievedAt}`, warnings, capabilities };
  });
}

export interface KeyInfo {
  label: string | null;
  usageMicros: Micros | null;
  limitMicros: Micros | null;
  remainingMicros: Micros | null;
  devPlan: string | null;
}

function usdStringToMicros(v: unknown): Micros | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return toMicros(n);
}

/**
 * Free key budget pre-flight via verified `GET /v1/key` (bearer auth required).
 * Returns null fields when the gateway does not report them.
 */
export async function getKeyInfo(ctx: AppContext, opts: { fetch?: FetchLike; timeoutMs?: number } = {}): Promise<{ ok: true; key: KeyInfo } | { ok: false; reason: string; httpStatus?: number }> {
  if (ctx.offline) return { ok: false, reason: 'offline' };
  const apiKey = ctx.secrets.get('LLM_GATEWAY_API_KEY');
  if (!apiKey) return { ok: false, reason: 'LLM_GATEWAY_API_KEY is not set' };
  const checked = checkGatewayBaseUrl(ctx.settings.llmBaseUrl);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  const baseUrl = checked.url;
  const preq = ctx.requests.prepare({ siteId: ctx.siteId, provider: 'llm_gateway', endpoint: 'key.get', method: 'GET', isPaid: false, params: { baseUrl } });
  ctx.requests.markSubmitted(preq.id);
  try {
    const res = await fetchWithTimeout(opts.fetch ?? ctx.fetch, gatewayUrl(baseUrl, 'key'), { method: 'GET', headers: authHeaders(apiKey) }, opts.timeoutMs ?? ctx.config.llm.requestTimeoutMs);
    if (res.status < 200 || res.status >= 300) {
      const env = parseErrorEnvelope(res.text);
      ctx.requests.complete(preq.id, { status: 'failed', httpStatus: res.status, error: env });
      return { ok: false, httpStatus: res.status, reason: `GET /v1/key returned HTTP ${res.status}${env.message ? `: ${env.message}` : ''}` };
    }
    const body = JSON.parse(res.text) as { data?: Record<string, unknown> };
    const d = body.data ?? {};
    ctx.requests.complete(preq.id, { status: 'succeeded', httpStatus: res.status });
    const usage = usdStringToMicros(d.usage);
    const limit = usdStringToMicros(d.limit);
    return {
      ok: true,
      key: {
        label: typeof d.label === 'string' ? d.label : null,
        usageMicros: usage,
        limitMicros: limit,
        remainingMicros: usage !== null && limit !== null ? Math.max(0, limit - usage) : null,
        devPlan: typeof d.devPlan === 'string' ? d.devPlan : null,
      },
    };
  } catch (err) {
    ctx.requests.complete(preq.id, { status: 'failed', error: { message: errorMessage(err) } });
    return { ok: false, reason: redactString(errorMessage(err)) };
  }
}
