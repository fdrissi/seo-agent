import type { Micros } from '../core/money.js';

export type BudgetProvider = 'llm_gateway' | 'dataforseo' | 'apify' | 'pagespeed';
export const BUDGET_PROVIDERS: readonly BudgetProvider[] = ['llm_gateway', 'dataforseo', 'apify', 'pagespeed'];

/**
 * How a cost estimate was derived. `unknown` means no safe upper bound could
 * be established: the request must be skipped or explicitly approved.
 */
export interface PriceBasis {
  source: 'provider_api' | 'verified_config' | 'documented' | 'fixed_zero' | 'unknown';
  /** Human-readable explanation, e.g. "max_tokens 1500 x $0.60/1M output". */
  detail: string;
  unitPriceMicros?: Micros;
  units?: number;
  unitLabel?: string;
  verifiedAt?: string;
}

export interface CostEstimate {
  /** Conservative upper bound in USD micros, or null when no safe bound exists. */
  upperBoundMicros: Micros | null;
  basis: PriceBasis;
}

export interface ReserveRequest {
  siteId: string;
  provider: BudgetProvider;
  /** Job id or ad-hoc run key used for the per-run cap. */
  runId: string;
  purpose: string;
  estimate: CostEstimate;
  providerRequestId?: string;
  /**
   * Approval id authorizing a request whose price is unknown (checked by caller
   * via approvals). Put the approved maximum charge in
   * `estimate.upperBoundMicros` (with basis.source 'unknown') so it is held
   * against every limit. With `upperBoundMicros: null` the charge has no upper
   * bound: it is accepted only while every limit still has room and no other
   * unbounded charge is outstanding in the same scope, and it makes those
   * limits unverifiable until reconciled.
   */
  unknownPriceApprovalId?: string;
  /**
   * The request is synthetic (fixture, sandbox or demo): no real charge. The
   * reservation and its ledger entry are flagged is_synthetic = 1 and labeled
   * SYNTHETIC wherever spend is shown; the amount still counts toward the
   * limits. A reservation is also flagged when its site is a demo site or its
   * provider request is flagged synthetic (see BudgetService.attachRequest).
   */
  synthetic?: boolean;
}

/**
 * Where a reconciled amount came from (budget_reservations.cost_basis, the
 * reconcile source). 'computed_from_usage' means this application computed
 * it from usage at list price because the provider reported no charge: it is
 * NOT provider-reported, although it counts toward the limits.
 */
export type CostBasis = 'provider_reported' | 'gateway_reported' | 'computed_from_usage' | 'manual';
// A free sandbox/fixture request settled at a verified $0 is stored with the
// 'computed_from_usage' source (the migration 0310 CHECK has no separate value)
// but is a FIXED ZERO, not computed: see isFixedZeroAmount in budget-service.ts.

export const COMPUTED_COST_NOTE = 'computed from usage at list price, not provider-reported';

export interface LimitCheck {
  scope: 'run' | 'site_service_month' | 'site_service_week' | 'site_combined_month' | 'account_service_month';
  limitMicros: Micros;
  committedMicros: Micros;
  requestedMicros: Micros;
  /**
   * Outstanding approved charges in this scope that have NO upper bound. Their
   * amount is not in `committedMicros` (it is unknown), so while this is > 0
   * the limit cannot be verified: further reservations in the scope need their
   * own explicit approval.
   */
  unboundedUnknownCount?: number;
  /** account_service_month only: sites whose configuration declares the (smallest) shared account cap. */
  declaredBy?: string[];
}

export interface Reservation {
  id: string;
  siteId: string;
  provider: BudgetProvider;
  runId: string | null;
  estimatedMicros: Micros;
  status: 'reserved' | 'reconciled' | 'released' | 'unresolved';
  periodMonth: string;
  periodWeek: string;
}

export interface ProviderSpend {
  provider: BudgetProvider;
  /**
   * Reconciled actual spend: provider-reported (or owner-entered from the
   * provider's history) PLUS amounts computed from usage at list price. The
   * split is in SpendReport.costBasis (reportedMicros / computedMicros).
   */
  actualMicros: Micros;
  /** Outstanding reservations (estimated upper bounds not yet reconciled). */
  reservedMicros: Micros;
  /** Reconciled estimates where no actual was reported (still counted). */
  estimatedMicros: Micros;
  /**
   * Count of open charges whose amount is unknown: unresolved submissions and
   * approved unknown-price requests (held at their approved maximum, or with
   * no upper bound at all; see unboundedUnknownCount).
   */
  unknownCount: number;
  /** Of unknownCount: approved charges with NO upper bound (not included in any amount). */
  unboundedUnknownCount: number;
  committedMicros: Micros;
  limitMicros: Micros;
  /** limit - committed, floored at 0. An upper bound only when remainingVerified is false. */
  remainingMicros: Micros;
  /** False while charges without an upper bound are outstanding: the real remaining budget may be lower. */
  remainingVerified: boolean;
  weekly?: { committedMicros: Micros; limitMicros: Micros; remainingMicros: Micros };
}

/**
 * Provenance of one provider's amounts in a SpendReport. Additive: the
 * ProviderSpend amounts keep their meaning, and these split them further.
 */
export interface ProviderCostBasis {
  provider: BudgetProvider;
  /**
   * Of ProviderSpend.actualMicros: reported by the provider or gateway, or
   * entered by a named human from the provider's billing history.
   */
  reportedMicros: Micros;
  /**
   * Of ProviderSpend.actualMicros: computed by this application from usage at
   * list price because the provider reported no charge (reconcile source
   * 'computed_from_usage'). Not provider-reported; still counts toward limits.
   */
  computedMicros: Micros;
  /** Reconciled reservations whose amount was computed from usage. */
  computedCount: number;
  /**
   * Reconciled reservations settled at a verified $0 because the request was
   * a free sandbox or fixture request (price basis 'fixed_zero'). Not
   * computed from usage and not in computedCount; their amount is $0.
   */
  fixedZeroCount: number;
  /**
   * Of ProviderSpend.committedMicros: amounts of synthetic (fixture, sandbox,
   * demo) reservations. No real charge; still counted toward the limits.
   */
  syntheticMicros: Micros;
  /** Synthetic reservations counted in this month (reserved, unresolved or reconciled). */
  syntheticCount: number;
}

export interface SpendReport {
  siteId: string;
  periodMonth: string;
  periodWeek: string;
  timeZone: string;
  providers: ProviderSpend[];
  combined: { committedMicros: Micros; limitMicros: Micros; remainingMicros: Micros; unboundedUnknownCount: number; remainingVerified: boolean };
  notes: string[];
  /** Per provider (same order as `providers`): reported vs computed actual amounts, and synthetic amounts. */
  costBasis: ProviderCostBasis[];
  /**
   * True when the site is a demo site (sites.is_demo = 1): every amount is
   * SYNTHETIC DEMO DATA and no real charge was made.
   */
  synthetic: boolean;
  /** True when any amount counted in this report comes from a synthetic (fixture, sandbox, demo) reservation. */
  containsSynthetic: boolean;
}
