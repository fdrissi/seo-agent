import type { AppContext } from '../../app/context.js';
import { formatUsd, type Micros } from '../../core/money.js';
import { findModel, type ModelCatalog } from './models.js';
import { estimateChatCost, estimateEmbeddingCost, resolvePrices } from './pricing.js';
import type { ModelTier } from './types.js';

/**
 * Cost plans for optional LLM/embedding work (e.g. "show a proposed cost plan
 * before optional LLM/embedding work", spec section 27). Pure computation over
 * a model catalog: no network, no reservation. Upper bounds use the same
 * conservative formula as the live client; unknown prices stay unknown.
 */

export interface LlmCostPlanItem {
  label: string;
  tier: ModelTier | 'embedding';
  /** Number of requests (for chat, include possible repair attempts if you want them bounded too). */
  requests: number;
  /** Estimated input tokens per request (use estimateTokens() on the planned prompt + evidence). */
  inputTokensPerRequest: number;
  /** Output ceiling per request (defaults to the tier's configured maximum). */
  maxOutputTokens?: number;
}

export interface LlmCostPlanLine extends LlmCostPlanItem {
  modelId: string | null;
  upperBoundMicros: Micros | null;
  detail: string;
}

export interface LlmCostPlan {
  lines: LlmCostPlanLine[];
  /** Sum of known upper bounds; null when any line has an unknown price. */
  totalUpperBoundMicros: Micros | null;
  notes: string[];
}

export function planLlmCost(ctx: AppContext, catalog: ModelCatalog, items: LlmCostPlanItem[]): LlmCostPlan {
  const lines: LlmCostPlanLine[] = items.map((item) => {
    const m = ctx.settings.models;
    const modelId = item.tier === 'cheap' ? m.cheap : item.tier === 'reasoning' ? m.reasoning : m.embedding;
    if (!modelId) return { ...item, modelId: null, upperBoundMicros: null, detail: 'model not configured' };
    const found = findModel(catalog, modelId, ctx.clock.now());
    if (!found.ok) return { ...item, modelId, upperBoundMicros: null, detail: found.reason };
    const prices = resolvePrices(found.caps, ctx.config, modelId, catalog.retrievedAt);
    if (item.tier === 'embedding') {
      // Per-request bound (includes any flat per-request fee) times the number of requests.
      const one = estimateEmbeddingCost(prices, item.inputTokensPerRequest);
      return { ...item, modelId, upperBoundMicros: one.upperBoundMicros === null ? null : one.upperBoundMicros * item.requests, detail: `${item.requests} x (${one.basis.detail})` };
    }
    const tierMax = item.tier === 'cheap' ? ctx.config.llm.maxOutputTokensCheap : ctx.config.llm.maxOutputTokensReasoning;
    const out = Math.min(item.maxOutputTokens ?? tierMax, tierMax, found.caps.maxOutput ?? Number.POSITIVE_INFINITY);
    const reasoning = found.caps.reasoningPossible ? out : 0;
    const one = estimateChatCost(prices, { inputTokens: item.inputTokensPerRequest, maxOutputTokens: out, reasoningTokens: reasoning });
    return { ...item, modelId, upperBoundMicros: one.upperBoundMicros === null ? null : one.upperBoundMicros * item.requests, detail: `${item.requests} x (${one.basis.detail})` };
  });
  const unknown = lines.some((l) => l.upperBoundMicros === null);
  const total = unknown ? null : lines.reduce((s, l) => s + (l.upperBoundMicros ?? 0), 0);
  return {
    lines,
    totalUpperBoundMicros: total,
    notes: [
      `Upper bounds use catalog prices retrieved ${catalog.retrievedAt}${catalog.stale ? ' (STALE)' : ''} and llm.pricingOverrides; actual charges are reconciled per request.`,
      unknown ? 'At least one line has no verifiable price: those requests would be skipped (BUDGET_UNKNOWN_PRICE) unless approved.' : `Total upper bound ${formatUsd(total)}.`,
      'These are estimates for planning, not price quotes; budgets are enforced per request at run time.',
    ],
  };
}
