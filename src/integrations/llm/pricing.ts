import { costPerMillionCeil, formatUsd, toMicros, type Micros } from '../../core/money.js';
import type { CostEstimate, PriceBasis } from '../../budgets/types.js';
import type { SiteConfig } from '../../config/site-schema.js';
import type { ModelCapabilities } from './models.js';

/**
 * LLM pricing and cost math.
 *
 * Verified contract (docs/integration-contracts.md §1): `/v1/models`
 * `pricing.prompt` / `pricing.completion` are decimal strings in exponent
 * notation (e.g. "0.15e-6"). The unit (USD per token) is the documented
 * catalog convention but is listed as UNVERIFIED for the models endpoint
 * itself, so every basis records the verbatim string it came from.
 *
 * All amounts are integer USD micros; per-token prices are converted to
 * "micros per 1M tokens" and multiplied with `costPerMillionCeil`, which
 * rounds up (conservative upper bounds).
 */

/**
 * Convert a per-token USD price string (e.g. "0.15e-6") to integer micros per
 * 1M tokens, rounding UP. Returns null for anything that is not a finite,
 * non-negative decimal. Exact decimal arithmetic via BigInt (no float error).
 */
export function perTokenPriceToMicrosPerMillion(value: unknown): Micros | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    value = String(value);
  }
  if (typeof value !== 'string') return null;
  const m = /^\+?(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value.trim());
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return null;
  const intPart = m[1] ?? '';
  const frac = m[2] ?? '';
  const exp = Number(m[3] ?? '0');
  if (!Number.isInteger(exp) || Math.abs(exp) > 40) return null;
  const digits = BigInt((intPart + frac).replace(/^0+(?=\d)/, '') || '0');
  // value = digits * 10^(exp - frac.length); micros per million = value * 1e12
  const shift = exp - frac.length + 12;
  let out: bigint;
  if (shift >= 0) out = digits * 10n ** BigInt(shift);
  else {
    const div = 10n ** BigInt(-shift);
    out = digits / div + (digits % div === 0n ? 0n : 1n);
  }
  const n = Number(out);
  return Number.isSafeInteger(n) ? n : null;
}

/** Flat USD amount string/number (e.g. per-request fee) to micros, rounding up; null if unparseable. */
export function usdAmountToMicrosCeil(value: unknown): Micros | null {
  const perMillion = perTokenPriceToMicrosPerMillion(value);
  if (perMillion === null) return null;
  // perMillion = usd * 1e12; micros = usd * 1e6 = perMillion / 1e6 (ceil)
  return Math.ceil(perMillion / 1_000_000);
}

export interface ResolvedPrices {
  /** Micros per 1M input tokens (conservative: max over provider mappings and overrides). */
  inputPerMillion: Micros | null;
  /** Micros per 1M output tokens. */
  outputPerMillion: Micros | null;
  /** Micros per 1M reasoning tokens when priced separately; otherwise the output price. */
  reasoningPerMillion: Micros | null;
  /** Flat per-request fee in micros (0 when the catalog lists none). */
  requestFeeMicros: Micros;
  source: 'provider_api' | 'verified_config' | 'unknown';
  /** Source of the input price alone (embeddings are billed for input tokens only). */
  inputSource: 'provider_api' | 'verified_config' | 'unknown';
  detail: string;
  verifiedAt?: string;
}

function max(a: Micros | null, b: Micros | null): Micros | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/**
 * Prices for budget upper bounds: catalog (gateway `/v1/models`) prices and
 * any `llm.pricingOverrides` entry; when both exist the higher one is used so
 * the reservation stays a conservative upper bound.
 */
export function resolvePrices(caps: ModelCapabilities | null, config: Pick<SiteConfig, 'llm'>, modelId: string, retrievedAt?: string): ResolvedPrices {
  const override = config.llm.pricingOverrides[modelId];
  const oIn = override ? toMicros(override.inputPerMillionUsd) : null;
  const oOut = override ? toMicros(override.outputPerMillionUsd) : null;
  const cIn = caps?.prices.inputPerMillion ?? null;
  const cOut = caps?.prices.outputPerMillion ?? null;
  const cReason = caps?.prices.reasoningPerMillion ?? null;
  const inputPerMillion = max(cIn, oIn);
  const outputPerMillion = max(cOut, oOut);
  const known = inputPerMillion !== null && outputPerMillion !== null;
  const source: ResolvedPrices['source'] = !known ? 'unknown' : cIn !== null && cOut !== null ? 'provider_api' : 'verified_config';
  const parts: string[] = [];
  if (cIn !== null || cOut !== null) parts.push(`gateway catalog prompt=${caps?.pricing.prompt ?? 'n/a'} completion=${caps?.pricing.completion ?? 'n/a'} (USD/token, retrieved ${retrievedAt ?? 'unknown'})`);
  if (override) parts.push(`llm.pricingOverrides input=$${override.inputPerMillionUsd}/1M output=$${override.outputPerMillionUsd}/1M`);
  if (!parts.length) parts.push('no verified price in the gateway catalog or llm.pricingOverrides');
  return {
    inputPerMillion,
    outputPerMillion,
    reasoningPerMillion: max(cReason, outputPerMillion),
    requestFeeMicros: caps?.prices.requestFeeMicros ?? 0,
    source,
    inputSource: inputPerMillion === null ? 'unknown' : cIn !== null ? 'provider_api' : 'verified_config',
    detail: parts.join('; '),
    ...(retrievedAt ? { verifiedAt: retrievedAt } : {}),
  };
}

export interface ChatEstimateInput {
  inputTokens: number;
  maxOutputTokens: number;
  /** Additional reasoning-token allowance (0 when the model cannot reason). */
  reasoningTokens: number;
}

/**
 * Conservative upper bound for one chat request:
 *   input_estimate x input_price + max_output x output_price
 *   + reasoning_allowance x max(reasoning_price, output_price) + request_fee.
 * Returns a null upper bound (unknown) when any required price is missing.
 */
export function estimateChatCost(prices: ResolvedPrices, input: ChatEstimateInput): CostEstimate {
  if (prices.source === 'unknown' || prices.inputPerMillion === null || prices.outputPerMillion === null) {
    return { upperBoundMicros: null, basis: { source: 'unknown', detail: prices.detail } };
  }
  const inCost = costPerMillionCeil(prices.inputPerMillion, input.inputTokens);
  const outCost = costPerMillionCeil(prices.outputPerMillion, input.maxOutputTokens);
  const reasonCost = input.reasoningTokens > 0 ? costPerMillionCeil(prices.reasoningPerMillion ?? prices.outputPerMillion, input.reasoningTokens) : 0;
  const upper = inCost + outCost + reasonCost + prices.requestFeeMicros;
  const basis: PriceBasis = {
    source: prices.source,
    detail: `upper bound: ~${input.inputTokens} input tok x ${formatUsd(prices.inputPerMillion)}/1M + ${input.maxOutputTokens} max output tok x ${formatUsd(prices.outputPerMillion)}/1M${
      input.reasoningTokens > 0 ? ` + ${input.reasoningTokens} reasoning allowance tok x ${formatUsd(prices.reasoningPerMillion ?? prices.outputPerMillion)}/1M` : ''
    }${prices.requestFeeMicros ? ` + request fee ${formatUsd(prices.requestFeeMicros)}` : ''} = ${formatUsd(upper)}. Prices: ${prices.detail}`,
    unitPriceMicros: prices.outputPerMillion,
    units: input.inputTokens + input.maxOutputTokens + input.reasoningTokens,
    unitLabel: 'tokens (price per 1M)',
    ...(prices.verifiedAt ? { verifiedAt: prices.verifiedAt } : {}),
  };
  return { upperBoundMicros: upper, basis };
}

/** Conservative upper bound for an embeddings request (input tokens only). */
export function estimateEmbeddingCost(prices: ResolvedPrices, inputTokens: number): CostEstimate {
  if (prices.inputPerMillion === null || prices.inputSource === 'unknown') return { upperBoundMicros: null, basis: { source: 'unknown', detail: prices.detail } };
  const upper = costPerMillionCeil(prices.inputPerMillion, inputTokens) + prices.requestFeeMicros;
  return {
    upperBoundMicros: upper,
    basis: {
      source: prices.inputSource,
      detail: `upper bound: ~${inputTokens} input tok x ${formatUsd(prices.inputPerMillion)}/1M = ${formatUsd(upper)}. Prices: ${prices.detail}`,
      unitPriceMicros: prices.inputPerMillion,
      units: inputTokens,
      unitLabel: 'input tokens (price per 1M)',
      ...(prices.verifiedAt ? { verifiedAt: prices.verifiedAt } : {}),
    },
  };
}

export interface ReportedUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  /** usage.reasoning_tokens or usage.completion_tokens_details.reasoning_tokens. */
  reasoningTokens: number | null;
  /** True when reasoning tokens came from completion_tokens_details (OpenAI convention: already inside completion_tokens). */
  reasoningIncludedInCompletion: boolean;
  cachedTokens: number | null;
  /** Gateway-reported total cost in USD (`usage.cost`), when present. */
  gatewayCostUsd: number | null;
}

function nonNegInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

/** Parse the verified `usage` object of a chat or embeddings response. Missing fields stay null. */
export function parseUsage(usage: unknown): ReportedUsage {
  const u = (usage && typeof usage === 'object' ? usage : {}) as Record<string, unknown>;
  const details = (u.completion_tokens_details && typeof u.completion_tokens_details === 'object' ? u.completion_tokens_details : {}) as Record<string, unknown>;
  const promptDetails = (u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object' ? u.prompt_tokens_details : {}) as Record<string, unknown>;
  const detailReasoning = nonNegInt(details.reasoning_tokens);
  const topReasoning = nonNegInt(u.reasoning_tokens);
  const cost = typeof u.cost === 'number' && Number.isFinite(u.cost) && u.cost >= 0 ? u.cost : null;
  return {
    promptTokens: nonNegInt(u.prompt_tokens),
    completionTokens: nonNegInt(u.completion_tokens),
    reasoningTokens: detailReasoning ?? topReasoning,
    reasoningIncludedInCompletion: detailReasoning !== null,
    cachedTokens: nonNegInt(promptDetails.cached_tokens),
    gatewayCostUsd: cost,
  };
}

export interface ActualCost {
  micros: Micros | null;
  source: 'gateway_reported' | 'computed_from_usage' | 'unknown';
  detail: string;
}

/**
 * Actual cost of a completed request: the gateway-reported `usage.cost`
 * (USD) when present; otherwise computed from reported token usage and
 * verified prices; otherwise unknown (null, never $0).
 *
 * When only top-level `usage.reasoning_tokens` is reported, whether those
 * tokens are already inside `completion_tokens` is unverified, so they are
 * added (over-counting rather than under-counting spend).
 */
export function actualChatCost(usage: ReportedUsage, prices: ResolvedPrices | null): ActualCost {
  if (usage.gatewayCostUsd !== null) {
    return { micros: toMicros(usage.gatewayCostUsd), source: 'gateway_reported', detail: `usage.cost=${usage.gatewayCostUsd} USD` };
  }
  if (!prices || prices.inputPerMillion === null || prices.outputPerMillion === null || usage.promptTokens === null || usage.completionTokens === null) {
    return {
      micros: null,
      source: 'unknown',
      detail: usage.promptTokens === null || usage.completionTokens === null ? 'gateway did not report usage.cost or token usage' : 'gateway did not report usage.cost and no verified price is available',
    };
  }
  const extraReasoning = !usage.reasoningIncludedInCompletion && usage.reasoningTokens ? usage.reasoningTokens : 0;
  const micros =
    costPerMillionCeil(prices.inputPerMillion, usage.promptTokens) +
    costPerMillionCeil(prices.outputPerMillion, usage.completionTokens) +
    (extraReasoning ? costPerMillionCeil(prices.reasoningPerMillion ?? prices.outputPerMillion, extraReasoning) : 0) +
    prices.requestFeeMicros;
  return {
    micros,
    source: 'computed_from_usage',
    detail: `computed: ${usage.promptTokens} prompt tok + ${usage.completionTokens} completion tok${extraReasoning ? ` + ${extraReasoning} reasoning tok (added conservatively; inclusion unverified)` : ''} at ${prices.detail}`,
  };
}

/** Actual cost of an embeddings request (no cost field in the verified schema). */
export function actualEmbeddingCost(usage: ReportedUsage, prices: ResolvedPrices | null): ActualCost {
  if (usage.gatewayCostUsd !== null) return { micros: toMicros(usage.gatewayCostUsd), source: 'gateway_reported', detail: `usage.cost=${usage.gatewayCostUsd} USD` };
  if (!prices || prices.inputPerMillion === null || usage.promptTokens === null) {
    return { micros: null, source: 'unknown', detail: usage.promptTokens === null ? 'embeddings response carried no token usage' : 'no verified embedding price' };
  }
  return {
    micros: costPerMillionCeil(prices.inputPerMillion, usage.promptTokens) + prices.requestFeeMicros,
    source: 'computed_from_usage',
    detail: `computed: ${usage.promptTokens} input tok at ${prices.detail}`,
  };
}
