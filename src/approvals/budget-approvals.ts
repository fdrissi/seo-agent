import { AppError } from '../core/errors.js';
import { hashObject } from '../core/hash.js';
import { formatUsd, type Micros } from '../core/money.js';
import type { BudgetProvider } from '../budgets/types.js';
import type { ApprovalService } from './service.js';
import type { ApprovalRecord } from './types.js';

/**
 * Approvals for spend (spec section 25).
 *
 * - `paid_request`: a single paid request whose price has no safe upper bound
 *   ("unknown price"). The approval binds provider, endpoint, the canonical
 *   request hash, and the maximum charge the owner accepts (or null when even
 *   that is unknown, which the summary states). It is consumed exactly once;
 *   the consumed approval id is what `BudgetService.reserve` accepts as
 *   `unknownPriceApprovalId`.
 * - `budget_exception`: a one-time, bounded exception to a configured cap.
 *   There are no automatic top-ups: an exception is a separate, explicit,
 *   expiring human decision bound to provider, scope, period, and amount.
 *   NOTE: BudgetService (foundation) does not yet accept an exception id when
 *   checking limits; until it does, an approved exception is recorded and
 *   checkable (`checkBudgetException`) but does not raise any limit.
 */

export interface PaidRequestApprovalInput {
  siteId: string;
  provider: BudgetProvider;
  endpoint: string;
  /** Canonical hash of the exact request parameters (e.g. ProviderRequestLog request_hash). */
  requestHash: string;
  purpose: string;
  /** Maximum charge the owner is asked to accept; null when no bound exists at all. */
  maxChargeMicros: Micros | null;
  requestedBy: string;
  ttlHours?: number;
}

function paidRequestHash(i: Pick<PaidRequestApprovalInput, 'provider' | 'endpoint' | 'requestHash' | 'maxChargeMicros'>): string {
  return hashObject({ kind: 'paid_request', provider: i.provider, endpoint: i.endpoint, requestHash: i.requestHash, maxChargeMicros: i.maxChargeMicros });
}

export function requestPaidRequestApproval(gate: ApprovalService, i: PaidRequestApprovalInput): ApprovalRecord {
  if (!i.requestHash) throw new AppError('VALIDATION_FAILED', 'requestHash is required.');
  if (i.maxChargeMicros !== null && (!Number.isSafeInteger(i.maxChargeMicros) || i.maxChargeMicros < 0)) throw new AppError('VALIDATION_FAILED', 'maxChargeMicros must be a non-negative integer or null.');
  const cap = i.maxChargeMicros === null ? 'NO KNOWN UPPER BOUND (the charge could be any amount)' : `at most ${formatUsd(i.maxChargeMicros)}`;
  return gate.request({
    siteId: i.siteId,
    actionType: 'paid_request',
    target: `${i.provider}:${i.endpoint}`,
    subjectType: 'provider_request',
    subjectId: i.requestHash,
    artifactHash: paidRequestHash(i),
    summary: `Paid ${i.provider} request to ${i.endpoint} with unknown price, ${cap}. Purpose: ${i.purpose}`.slice(0, 500),
    payload: { provider: i.provider, endpoint: i.endpoint, purpose: i.purpose, maxChargeMicros: i.maxChargeMicros },
    requestedBy: i.requestedBy,
    ...(i.ttlHours ? { ttlHours: i.ttlHours } : {}),
  });
}

/**
 * Consume the approval for exactly this request (one-time) and return its id
 * for `BudgetService.reserve({ unknownPriceApprovalId })`. Throws
 * APPROVAL_REQUIRED / APPROVAL_INVALID otherwise.
 */
export function consumePaidRequestApproval(gate: ApprovalService, i: Omit<PaidRequestApprovalInput, 'purpose' | 'requestedBy' | 'ttlHours'>, actor = 'system'): string {
  const rec = gate.consumeFor(
    { siteId: i.siteId, actionType: 'paid_request', subjectType: 'provider_request', subjectId: i.requestHash, artifactHash: paidRequestHash(i) },
    { kind: 'paid_request', actor, provider: i.provider, endpoint: i.endpoint },
  );
  return rec.id;
}

export interface BudgetExceptionInput {
  siteId: string;
  provider: BudgetProvider | 'combined';
  /** Budget period key, e.g. '2026-09' (month) or '2026-W39' (week). */
  period: string;
  /** Extra amount above the configured cap, in USD micros. */
  extraMicros: Micros;
  reason: string;
  requestedBy: string;
  ttlHours?: number;
}

function exceptionHash(i: Pick<BudgetExceptionInput, 'provider' | 'period' | 'extraMicros'>): string {
  return hashObject({ kind: 'budget_exception', provider: i.provider, period: i.period, extraMicros: i.extraMicros });
}

export function requestBudgetException(gate: ApprovalService, i: BudgetExceptionInput): ApprovalRecord {
  if (!/^\d{4}-(\d{2}|W\d{2})$/.test(i.period)) throw new AppError('VALIDATION_FAILED', 'period must be a month key (YYYY-MM) or ISO week key (YYYY-Www).');
  if (!Number.isSafeInteger(i.extraMicros) || i.extraMicros <= 0) throw new AppError('VALIDATION_FAILED', 'The exception amount must be a positive amount.');
  if (!i.reason?.trim()) throw new AppError('VALIDATION_FAILED', 'A budget exception needs a reason.');
  return gate.request({
    siteId: i.siteId,
    actionType: 'budget_exception',
    target: `budget:${i.provider}:${i.period}`,
    subjectType: 'budget',
    subjectId: `${i.provider}:${i.period}`,
    artifactHash: exceptionHash(i),
    summary: `One-time budget exception: +${formatUsd(i.extraMicros)} for ${i.provider} in ${i.period}. Reason: ${i.reason.trim()}`.slice(0, 500),
    payload: { provider: i.provider, period: i.period, extraMicros: i.extraMicros, reason: i.reason.trim() },
    requestedBy: i.requestedBy,
    ...(i.ttlHours ? { ttlHours: i.ttlHours } : {}),
  });
}

export function checkBudgetException(gate: ApprovalService, i: Pick<BudgetExceptionInput, 'siteId' | 'provider' | 'period' | 'extraMicros'>) {
  return gate.check({ siteId: i.siteId, actionType: 'budget_exception', subjectType: 'budget', subjectId: `${i.provider}:${i.period}`, artifactHash: exceptionHash(i) });
}
