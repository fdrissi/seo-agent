import type { AppContext } from '../../app/context.js';
import type { ApprovalGate } from '../../approvals/types.js';
import { AppError, PolicyDeniedError } from '../../core/errors.js';
import { hashObject } from '../../core/hash.js';
import { formatUsd } from '../../core/money.js';
import type { DataForSeoClient } from './client.js';
import type { EndpointFamily } from './endpoints.js';
import { getCached, putCached, researchCacheKey } from './cache.js';
import { estimateRowPricedRequest, type PriceKey } from './pricing.js';
import { getTask, submitPaidTasks, type SubmitOutcome } from './tasks.js';

/**
 * Backlinks, DataForSEO Labs exports, and AI-visibility (LLM mentions) are
 * disabled by default. A call needs BOTH the feature flag
 * (dataforseoBacklinks / dataforseoLabsExports / dataforseoAiVisibility) AND a
 * valid approval bound to the exact endpoint + request body (including the
 * row `limit`) + row bound + price bound. Without an approval, a pending
 * approval request is created and nothing is sent. The approval is consumed
 * (one-time) BEFORE the request is sent.
 *
 * The charge is bounded on the provider side: for endpoints whose rows are
 * capped by a `limit` field, `limit = maxRows` is added when the caller omits
 * it, so the provider can never return more billable rows than the estimate
 * (request price + row price x maxRows) assumes. An unknown price holds a
 * conservative provisional bound (see pricing.ts); without one, nothing runs.
 *
 * Results are stored as raw responses only (no derived tables) and are
 * cached for `research.dataforseo.cacheDays.competitor` days, so a repeated
 * competitor-research request reuses the stored response instead of paying again.
 */

const ROW_PRICES: Partial<Record<EndpointFamily, { request: PriceKey; row: PriceKey }>> = {
  backlinks: { request: 'backlinks.request', row: 'backlinks.row' },
  labs: { request: 'labs.google.task', row: 'labs.google.item' },
  ai_optimization: { request: 'ai_optimization.llm_mentions.request', row: 'ai_optimization.llm_mentions.row' },
};

export interface GatedCallInput {
  endpointKey: string;
  /**
   * The task body to send (no credentials). For endpoints whose rows are
   * bounded by a `limit` field, `limit = maxRows` is added when absent, so the
   * provider enforces the same bound the estimate and approval use.
   */
  task: Record<string, unknown>;
  /** Hard upper bound on billable rows/items (positive integer); `task.limit`, when present, must not exceed it. */
  maxRows: number;
  purpose: string;
  approvals: ApprovalGate | undefined;
  allowPaid: boolean;
  requestedBy?: string;
}

export type GatedCallResult =
  | { status: 'approval_required'; approvalId: string; reason: string; estimateMicros: number | null }
  | { status: 'cached'; rawRef: string; isSandbox: boolean; cachedAt: string; expiresAt: string }
  | { status: 'completed' | 'failed' | 'ambiguous'; taskId: string | null; rawRef: string | null; submission: SubmitOutcome; isSandbox: boolean };

export async function callGatedEndpoint(ctx: AppContext, client: DataForSeoClient, input: GatedCallInput): Promise<GatedCallResult> {
  const spec = client.endpoint(input.endpointKey); // throws INTEGRATION_DISABLED when the flag is off
  if (!spec.gate) throw new PolicyDeniedError(`${input.endpointKey} is not a gated endpoint; use the SERP/keyword research functions.`);
  const prices = ROW_PRICES[spec.family];
  if (!prices) throw new PolicyDeniedError(`No pricing model for family ${spec.family}`);
  if (!Number.isSafeInteger(input.maxRows) || input.maxRows < 1) {
    throw new AppError('VALIDATION_FAILED', `maxRows (${String(input.maxRows)}) must be a positive integer: it bounds the billable rows`);
  }
  // Bound the billable rows on the provider side with the same number used for the estimate.
  const task: Record<string, unknown> = { ...input.task };
  const limit = task.limit;
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > input.maxRows)) {
    throw new AppError('VALIDATION_FAILED', `task.limit (${String(limit)}) must be an integer from 1 to maxRows (${input.maxRows})`);
  }
  if (limit === undefined) {
    if (spec.rowBound === 'limit_field') task.limit = input.maxRows;
    else if (spec.rowBound !== 'single_row') {
      throw new AppError('VALIDATION_FAILED', `${input.endpointKey}: task.limit is required so the provider cannot return more billable rows than maxRows (${input.maxRows})`);
    }
  }
  if (!input.approvals) {
    throw new AppError('APPROVAL_REQUIRED', `${input.endpointKey} requires an explicit approval, and no approval gate is wired for this call.`, {
      hint: 'Request it through the approvals workflow (`approvals list` / `approvals approve`).',
    });
  }
  const estimate = estimateRowPricedRequest(ctx.config, { requestKey: prices.request, rowKey: prices.row, maxRows: input.maxRows, sandbox: client.isSandbox }, ctx.clock.now());
  // Unknown price: an approved request still holds a conservative bound; without one it can never run.
  const hold = estimate.upperBoundMicros ?? estimate.provisionalMicros ?? null;
  if (hold === null) {
    throw new AppError('BUDGET_UNKNOWN_PRICE', `${input.endpointKey}: price unknown and no conservative bound can be formed; not sent (${estimate.basis.detail}).`, {
      hint: `Verify the price and set research.dataforseo.pricingOverrides["${prices.request}"] and ["${prices.row}"].`,
    });
  }
  const artifactHash = hashObject({ endpoint: input.endpointKey, task, maxRows: input.maxRows, mode: client.mode, boundMicros: hold });
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const cacheInput = {
    siteId: ctx.siteId,
    endpoint: input.endpointKey,
    locationCode: typeof task.location_code === 'number' ? task.location_code : null,
    languageCode: str(task.language_code),
    device: null,
    // The cache key covers the request, not its price.
    parameterHash: hashObject({ endpoint: input.endpointKey, task, maxRows: input.maxRows, mode: client.mode }),
    mode: client.mode,
  };
  const cached = getCached(ctx, researchCacheKey(cacheInput));
  if (cached) return { status: 'cached', rawRef: cached.payloadRef, isSandbox: cached.isSandbox, cachedAt: cached.createdAt, expiresAt: cached.expiresAt };
  const check = input.approvals.check({ siteId: ctx.siteId, actionType: 'paid_request', subjectType: 'dataforseo_endpoint', subjectId: input.endpointKey, artifactHash });
  if (!check.ok) {
    const bound = estimate.upperBoundMicros === null ? `UNKNOWN price; budget hold ${formatUsd(hold)} until reconciled` : `estimated upper bound ${formatUsd(estimate.upperBoundMicros)}`;
    const rec = input.approvals.request({
      siteId: ctx.siteId,
      actionType: 'paid_request',
      target: `dataforseo:${input.endpointKey}`,
      subjectType: 'dataforseo_endpoint',
      subjectId: input.endpointKey,
      artifactHash,
      summary: `DataForSEO ${spec.family} request ${input.endpointKey} (${input.purpose}); ${bound}`,
      payload: { task, maxRows: input.maxRows, estimate: estimate.basis, holdMicros: hold },
      requestedBy: input.requestedBy ?? 'system',
    });
    return { status: 'approval_required', approvalId: rec.id, reason: check.reason, estimateMicros: estimate.upperBoundMicros };
  }
  const submission = await submitPaidTasks(ctx, client, {
    endpointKey: input.endpointKey,
    tasks: [{ payload: task, meta: { kind: 'gated', mode: client.mode, queue: 'live', purpose: input.purpose, runId: ctx.runId }, parameterHash: cacheInput.parameterHash }],
    estimate,
    purpose: input.purpose,
    allowPaid: input.allowPaid,
    // The approval covers both the gate and (when the price is unknown) the unknown price.
    ...(estimate.upperBoundMicros === null ? { unknownPriceApprovalId: check.approval.id } : {}),
    approvalId: check.approval.id,
    approvals: input.approvals,
  });
  const t = submission.tasks[0];
  const row = t ? getTask(ctx, t.localId) : undefined;
  if (submission.state === 'accepted' && row?.status === 'fetched' && submission.rawRef) {
    putCached(ctx, { ...cacheInput, payloadRef: submission.rawRef, ttlDays: ctx.config.research.dataforseo.cacheDays.competitor, isSandbox: client.isSandbox });
  }
  return {
    status: submission.state === 'accepted' && row?.status === 'fetched' ? 'completed' : submission.state === 'ambiguous' ? 'ambiguous' : 'failed',
    taskId: t?.localId ?? null,
    rawRef: submission.rawRef,
    submission,
    isSandbox: client.isSandbox,
  };
}
