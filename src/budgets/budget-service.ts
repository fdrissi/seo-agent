import { AppError, BudgetExceededError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { formatUsd, toMicros, type Micros } from '../core/money.js';
import { isoWeekKey, monthKey } from '../core/time.js';
import { systemClock, type Clock } from '../core/clock.js';
import type { BudgetSettings } from '../config/load.js';
import { ownerActor, validateApproverName } from '../approvals/approver.js';
import { recordAudit } from '../database/audit.js';
import type { Db } from '../database/db.js';
import {
  BUDGET_PROVIDERS,
  COMPUTED_COST_NOTE,
  type BudgetProvider,
  type CostBasis,
  type LimitCheck,
  type ProviderCostBasis,
  type ProviderSpend,
  type ReserveRequest,
  type Reservation,
  type SpendReport,
} from './types.js';

/** Banner for spend of a demo site (every amount is synthetic; nothing was charged). */
export const SYNTHETIC_DEMO_COSTS = 'SYNTHETIC DEMO DATA: no real charges';

/** Key added to price_basis_json for approved charges that have no upper bound. */
const UNBOUNDED_MARKER = 'noUpperBound';
const UNBOUNDED_SQL = `json_extract(price_basis_json, '$.${UNBOUNDED_MARKER}') = 1`;
/** Source of the reservation's estimate basis ('fixed_zero' = a free sandbox/fixture request); NULL when unreadable. */
const PRICE_SOURCE_SQL = `CASE WHEN json_valid(price_basis_json) THEN json_extract(price_basis_json, '$.source') END`;

/**
 * True for a reconciled amount that is a FIXED ZERO: a free sandbox or
 * fixture request settled at a verified $0 (estimate basis 'fixed_zero', or
 * any synthetic reservation settled at $0). Such rows carry the
 * 'computed_from_usage' reconcile source (the cost_basis CHECK of migration
 * 0310 has no separate value), but nothing was computed from usage at list
 * price: they are never counted or labeled as computed.
 */
export function isFixedZeroAmount(r: { cost_basis: string | null; actual_usd_micros: number | null; is_synthetic: number; price_source?: string | null }): boolean {
  return r.cost_basis === 'computed_from_usage' && r.actual_usd_micros === 0 && (r.price_source === 'fixed_zero' || r.is_synthetic === 1);
}

/**
 * Budget enforcement.
 *
 * Before a paid request: reuse cache (caller) -> estimate a conservative upper
 * bound -> atomically reserve against run/site/service/account limits ->
 * submit with strict provider limits -> reconcile provider-reported usage and
 * release the unused remainder.
 *
 * Committed spend per reservation:
 *   reserved / unresolved  -> estimated upper bound (unresolved charges stay reserved)
 *   reconciled             -> actual amount
 *   released               -> 0
 *
 * Unknown prices (spec 25: "If a safe bound cannot be established, require
 * approval or skip the operation"):
 *   - Without an approval id the request is refused (BUDGET_UNKNOWN_PRICE).
 *   - Approved with a numeric hold (the approved maximum charge, basis.source
 *     'unknown'): the hold is reserved against every limit and the row is
 *     recorded as cost_status 'unknown', never as an ordinary estimate.
 *   - Approved with NO upper bound (upperBoundMicros null): the amount cannot
 *     be counted, so it is never presented as $0. It is accepted only when every
 *     limit still has room and no other unbounded charge is outstanding in the
 *     same scope; while it is outstanding, those limits are unverifiable, so
 *     further reservations in the scope need their own explicit approval and
 *     the report marks the remaining budget as unverified.
 *
 * Shared account caps (budgets.accountMonthlyUsd) are workspace-wide: the
 * smallest cap declared by ANY site registered in this database applies to
 * every site, whichever site's BudgetService makes the reservation. Only real
 * (is_synthetic = 0) reservations count against an account cap: fixture,
 * sandbox and demo reservations never reach the provider account.
 *
 * Cost provenance (migration 0310): every reconciled reservation records
 * its cost_basis (the reconcile source). An amount computed from usage at
 * list price ('computed_from_usage') is not provider-reported: it counts
 * toward every limit, but the report shows it separately
 * (SpendReport.costBasis) and says so in its notes. Synthetic reservations
 * (fixture, sandbox, demo: ReserveRequest.synthetic, a synthetic provider
 * request, or a demo site) are flagged is_synthetic = 1 together with their
 * ledger entries, still count toward the per-site limits (not the shared
 * account caps), and are labeled SYNTHETIC. A synthetic reservation settled
 * at a verified $0 (the free sandbox or a fixture: price basis 'fixed_zero')
 * is a fixed zero, not an amount computed from usage at list price, so the
 * report counts it apart (ProviderCostBasis.fixedZeroCount).
 *
 * Money is integer USD micros. Unknown actual cost is never recorded as $0.
 */
export class BudgetService {
  constructor(
    private readonly db: Db,
    private readonly opts: {
      /** Limits for the site being operated on. */
      limits: BudgetSettings;
      /** Site whose configuration supplied `limits` (labels the source of a shared account cap). */
      siteId?: string;
      /** IANA zone used to compute budget periods. */
      timeZone: string;
      clock?: Clock;
      actor?: string;
    },
  ) {}

  private get clock(): Clock {
    return this.opts.clock ?? systemClock;
  }

  /** True when the site is registered as a demo site (every amount is synthetic). */
  private isDemoSite(siteId: string): boolean {
    return this.db.get<{ is_demo: number }>('SELECT is_demo FROM sites WHERE id = ?', [siteId])?.is_demo === 1;
  }

  /** True when the provider request is flagged synthetic (fixture or sandbox transport). */
  private isSyntheticRequest(providerRequestId: string | null | undefined): boolean {
    if (!providerRequestId) return false;
    return this.db.get<{ is_synthetic: number }>('SELECT is_synthetic FROM provider_requests WHERE id = ?', [providerRequestId])?.is_synthetic === 1;
  }

  periods(at: Date = this.clock.now()): { month: string; week: string } {
    return { month: monthKey(at, this.opts.timeZone), week: isoWeekKey(at, this.opts.timeZone) };
  }

  private serviceLimits(provider: BudgetProvider): { monthly: Micros; weekly?: Micros; perRun: Micros } {
    const l = this.opts.limits;
    switch (provider) {
      case 'llm_gateway':
        return { monthly: l.llmGateway.monthly, perRun: l.llmGateway.perRun };
      case 'dataforseo':
        return { monthly: l.dataforseo.monthly, weekly: l.dataforseo.weekly, perRun: l.dataforseo.perRun };
      case 'apify':
        return { monthly: l.apify.monthly, perRun: l.apify.perRun };
      case 'pagespeed':
        return { monthly: l.pagespeed.monthly, perRun: l.pagespeed.perRun };
    }
  }

  /**
   * Committed amount in a scope plus the number of outstanding approved charges
   * with no upper bound (their amount is unknown and not in `committed`).
   */
  private tally(where: string, params: unknown[]): { committed: Micros; unbounded: number } {
    const row = this.db.get<{ total: number | null; unbounded: number | null }>(
      `SELECT COALESCE(SUM(CASE
          WHEN status IN ('reserved', 'unresolved') THEN estimated_usd_micros
          WHEN status = 'reconciled' THEN COALESCE(actual_usd_micros, estimated_usd_micros)
          ELSE 0 END), 0) AS total,
        COALESCE(SUM(CASE WHEN status IN ('reserved', 'unresolved') AND ${UNBOUNDED_SQL} THEN 1 ELSE 0 END), 0) AS unbounded
       FROM budget_reservations WHERE ${where}`,
      params,
    );
    return { committed: Number(row?.total ?? 0), unbounded: Number(row?.unbounded ?? 0) };
  }

  /**
   * The shared account cap for a provider: the smallest value declared by this
   * service's own limits or by the active configuration of ANY site registered
   * in the workspace database. Account caps protect one provider account that
   * all sites share, so a site that does not declare one is still bound by it.
   */
  accountCap(provider: BudgetProvider): { limitMicros: Micros; declaredBy: string[] } | undefined {
    const declared: Array<{ source: string; micros: Micros }> = [];
    const own = this.opts.limits.accountMonthly[provider];
    if (own !== undefined) declared.push({ source: this.opts.siteId ?? 'this configuration', micros: own });
    const rows = this.db.all<{ site_id: string; v: unknown }>(
      `SELECT s.id AS site_id, json_extract(c.config_json, ?) AS v
         FROM sites s JOIN config_versions c ON c.site_id = s.id AND c.version = s.active_config_version
        ORDER BY s.id`,
      [`$.budgets.accountMonthlyUsd.${provider}`],
    );
    for (const r of rows) {
      if (r.v === null || r.v === undefined) continue;
      try {
        declared.push({ source: r.site_id, micros: toMicros(String(r.v)) });
      } catch {
        // An unparseable stored value cannot relax a cap; the validated config never produces one.
      }
    }
    if (!declared.length) return undefined;
    const min = Math.min(...declared.map((d) => d.micros));
    return { limitMicros: min, declaredBy: [...new Set(declared.filter((d) => d.micros === min).map((d) => d.source))] };
  }

  /** Evaluate all limits for a prospective amount (no writes). */
  checkLimits(req: { siteId: string; provider: BudgetProvider; runId: string; amountMicros: Micros }, at: Date = this.clock.now()): LimitCheck[] {
    const { month, week } = this.periods(at);
    const svc = this.serviceLimits(req.provider);
    const check = (scope: LimitCheck['scope'], limitMicros: Micros, where: string, params: unknown[]): LimitCheck => {
      const t = this.tally(where, params);
      return { scope, limitMicros, committedMicros: t.committed, requestedMicros: req.amountMicros, unboundedUnknownCount: t.unbounded };
    };
    const checks: LimitCheck[] = [
      check('run', svc.perRun, 'site_id = ? AND provider = ? AND run_id = ?', [req.siteId, req.provider, req.runId]),
      check('site_service_month', svc.monthly, 'site_id = ? AND provider = ? AND period_month = ?', [req.siteId, req.provider, month]),
      check('site_combined_month', this.opts.limits.combinedMonthly, 'site_id = ? AND period_month = ?', [req.siteId, month]),
    ];
    if (svc.weekly !== undefined) {
      checks.push(check('site_service_week', svc.weekly, 'site_id = ? AND provider = ? AND period_week = ?', [req.siteId, req.provider, week]));
    }
    const account = this.accountCap(req.provider);
    if (account !== undefined) {
      // The shared account cap protects the real provider account: synthetic reservations (fixture,
      // sandbox, demo; is_synthetic = 1) never reach it, so they are not counted against it. They
      // still count toward the per-site limits above, which stay conservative.
      checks.push({ ...check('account_service_month', account.limitMicros, 'provider = ? AND period_month = ? AND is_synthetic = 0', [req.provider, month]), declaredBy: account.declaredBy });
    }
    return checks;
  }

  /**
   * Atomically reserve funds. Throws BudgetExceededError when any limit would
   * be exceeded, or BUDGET_UNKNOWN_PRICE when no safe upper bound exists and
   * no approval id was supplied (or when a limit cannot be verified because an
   * approved charge without an upper bound is still outstanding).
   */
  reserve(req: ReserveRequest): Reservation {
    const upper = req.estimate.upperBoundMicros;
    // No bound, or a bound whose basis is unknown, is not a safe upper bound.
    const unknownPrice = upper === null || req.estimate.basis.source === 'unknown';
    const unbounded = upper === null;
    if (unknownPrice && !req.unknownPriceApprovalId) {
      // Every denial is audited, including this one (it never reaches the limit checks).
      recordAudit(this.db, {
        siteId: req.siteId,
        actor: this.opts.actor ?? 'system',
        eventType: 'budget.denied',
        subjectType: 'provider',
        subjectId: req.provider,
        details: { purpose: req.purpose, runId: req.runId, reason: 'unknown_price', unknownPrice: true, unbounded: upper === null, basis: req.estimate.basis },
        at: this.clock.now(),
      });
      throw new AppError('BUDGET_UNKNOWN_PRICE', `${req.provider}: cannot establish a safe cost upper bound for "${req.purpose}"; skipped.`, {
        details: { provider: req.provider, purpose: req.purpose, basis: req.estimate.basis },
        hint: 'Verify current pricing (docs/integration-contracts.md) and configure it, or approve this specific request explicitly.',
      });
    }
    const amount = upper ?? 0;
    if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError('estimate must be a non-negative integer micro amount');
    const now = this.clock.now();
    const { month, week } = this.periods(now);
    type Denial = { kind: 'exceeded'; violated: LimitCheck } | { kind: 'unverifiable'; violated: LimitCheck; message: string; hint: string };
    // BEGIN IMMEDIATE (Db.transaction) takes the write lock before the limits are
    // read, so concurrent reservations from other connections/processes serialize
    // and can never both pass the same check.
    const outcome = this.db.transaction((): { ok: true; reservation: Reservation } | { ok: false; denial: Denial } => {
      const checks = this.checkLimits({ siteId: req.siteId, provider: req.provider, runId: req.runId, amountMicros: amount }, now);
      let denial: Denial | undefined;
      const blocked = checks.find((c) => (c.unboundedUnknownCount ?? 0) > 0);
      if (blocked && unbounded) {
        denial = {
          kind: 'unverifiable',
          violated: blocked,
          message: `${req.provider}: another approved charge without an upper bound is still outstanding under the "${blocked.scope}" limit, so a second one cannot be accepted (${req.purpose}).`,
          hint: 'Reconcile the outstanding charge first from the provider history (`costs --unresolved` lists it with the `costs reconcile <reservation-id> --actual-usd <amount> | --not-charged --evidence <note> --by <name>` command), or approve this request with a maximum charge so it can be held against the limits.',
        };
      } else if (blocked && !req.unknownPriceApprovalId) {
        denial = {
          kind: 'unverifiable',
          violated: blocked,
          message: `${req.provider}: the "${blocked.scope}" limit cannot be verified while ${blocked.unboundedUnknownCount} approved charge(s) without an upper bound are outstanding (${req.purpose}).`,
          hint: 'Reconcile the outstanding unknown charge(s) first from the provider history (`costs --unresolved` lists them with the `costs reconcile <reservation-id> ...` command for each), or approve this specific request explicitly.',
        };
      } else {
        // A charge without an upper bound needs room left under every limit (a spent cap stays closed).
        const violated = checks.find((c) => (unbounded ? c.committedMicros >= c.limitMicros : c.committedMicros + c.requestedMicros > c.limitMicros));
        if (violated) denial = { kind: 'exceeded', violated };
      }
      if (denial) {
        // Committed (not rolled back) so every denial stays in the audit history.
        recordAudit(this.db, {
          siteId: req.siteId,
          actor: this.opts.actor ?? 'system',
          eventType: 'budget.denied',
          subjectType: 'provider',
          subjectId: req.provider,
          details: { purpose: req.purpose, runId: req.runId, violated: denial.violated, reason: denial.kind, ...(unknownPrice ? { unknownPrice: true, unbounded } : {}) },
          at: now,
        });
        return { ok: false, denial };
      }
      const id = newId('res');
      const iso = now.toISOString();
      const synthetic = req.synthetic === true || this.isDemoSite(req.siteId) || this.isSyntheticRequest(req.providerRequestId);
      const note = !unknownPrice
        ? null
        : unbounded
          ? `unknown price approved by ${req.unknownPriceApprovalId}; no upper bound, so the amount is not counted against limits until reconciled (limits stay unverifiable meanwhile)`
          : `unknown price approved by ${req.unknownPriceApprovalId}; holding the approved maximum until reconciled`;
      this.db.run(
        `INSERT INTO budget_reservations (id, site_id, provider, run_id, purpose, estimated_usd_micros, status, cost_status, price_basis_json,
           period_month, period_week, provider_request_id, note, is_synthetic, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          req.siteId,
          req.provider,
          req.runId,
          req.purpose,
          amount,
          // An approved unknown price is an unknown charge (never an ordinary estimate or $0),
          // whether it holds an approved maximum or has no upper bound at all.
          unknownPrice ? 'unknown' : 'estimated',
          JSON.stringify(unbounded ? { ...req.estimate.basis, [UNBOUNDED_MARKER]: true } : req.estimate.basis),
          month,
          week,
          req.providerRequestId ?? null,
          note,
          synthetic ? 1 : 0,
          iso,
          iso,
        ],
      );
      recordAudit(this.db, {
        siteId: req.siteId,
        actor: this.opts.actor ?? 'system',
        eventType: 'budget.reserved',
        subjectType: 'reservation',
        subjectId: id,
        details: {
          provider: req.provider,
          purpose: req.purpose,
          estimatedMicros: unbounded ? null : amount,
          ...(unknownPrice ? { unknownPrice: true, unbounded, approvalId: req.unknownPriceApprovalId ?? null } : {}),
          ...(synthetic ? { synthetic: true } : {}),
        },
        at: now,
      });
      return {
        ok: true,
        reservation: { id, siteId: req.siteId, provider: req.provider, runId: req.runId, estimatedMicros: amount, status: 'reserved', periodMonth: month, periodWeek: week },
      };
    });
    if (!outcome.ok) {
      const d = outcome.denial;
      if (d.kind === 'unverifiable') {
        throw new AppError('BUDGET_UNKNOWN_PRICE', d.message, { details: { ...d.violated, provider: req.provider, purpose: req.purpose }, hint: d.hint });
      }
      throw new BudgetExceededError(`${req.provider}: budget limit "${d.violated.scope}" would be exceeded (${req.purpose})`, { ...d.violated, provider: req.provider });
    }
    return outcome.reservation;
  }

  /**
   * Link a reservation to the provider request that uses it. A synthetic
   * provider request (fixture or sandbox transport) flags the reservation
   * synthetic; a flag is never cleared.
   */
  attachRequest(reservationId: string, providerRequestId: string): void {
    const synthetic = this.isSyntheticRequest(providerRequestId) ? 1 : 0;
    this.db.run('UPDATE budget_reservations SET provider_request_id = ?, is_synthetic = MAX(is_synthetic, ?), updated_at = ? WHERE id = ?', [
      providerRequestId,
      synthetic,
      this.clock.now().toISOString(),
      reservationId,
    ]);
  }

  /**
   * Reconcile with provider-reported usage. `actualMicros: null` means the
   * provider did not report a charge: the reservation becomes 'unresolved' and
   * stays counted at its estimate. Actual cost above the estimate (price
   * changes) is recorded truthfully and flagged. The source is stored as the
   * reservation's cost_basis: 'computed_from_usage' (usage x list price,
   * computed here because the provider reported no charge) counts toward the
   * limits like any actual amount but is reported separately as computed,
   * never as provider-reported.
   */
  reconcile(
    reservationId: string,
    input: {
      actualMicros: Micros | null;
      source: 'provider_reported' | 'gateway_reported' | 'computed_from_usage' | 'manual';
      usage?: Record<string, unknown>;
      providerRequestId?: string;
    },
  ): { status: 'reconciled' | 'unresolved'; overshootMicros: Micros } {
    if (input.actualMicros !== null && (!Number.isSafeInteger(input.actualMicros) || input.actualMicros < 0)) {
      throw new RangeError('actualMicros must be null (unknown) or a non-negative integer micro amount');
    }
    const now = this.clock.now();
    return this.db.transaction(() => {
      const r = this.db.get<{ site_id: string; provider: string; estimated_usd_micros: number; status: string; period_month: string; period_week: string; provider_request_id: string | null; unbounded: number | null; is_synthetic: number }>(
        `SELECT site_id, provider, estimated_usd_micros, status, period_month, period_week, provider_request_id, ${UNBOUNDED_SQL} AS unbounded, is_synthetic FROM budget_reservations WHERE id = ?`,
        [reservationId],
      );
      if (!r) throw new AppError('NOT_FOUND', `Reservation ${reservationId} not found`);
      if (r.status === 'released') throw new AppError('CONFLICT', `Reservation ${reservationId} was released and cannot be reconciled`);
      const known = input.actualMicros !== null;
      const status = known ? 'reconciled' : 'unresolved';
      // A charge approved without an upper bound had no estimate to overshoot.
      const unbounded = r.unbounded === 1;
      const overshoot = known && !unbounded ? Math.max(0, input.actualMicros! - r.estimated_usd_micros) : 0;
      const requestId = input.providerRequestId ?? r.provider_request_id;
      const synthetic = r.is_synthetic === 1 || this.isSyntheticRequest(requestId) || this.isDemoSite(r.site_id);
      const basis: CostBasis | null = known ? input.source : null;
      this.db.run(
        `UPDATE budget_reservations SET status = ?, cost_status = ?, actual_usd_micros = ?, cost_basis = ?, is_synthetic = ?, updated_at = ? WHERE id = ?`,
        [status, known ? 'actual' : 'unknown', input.actualMicros, basis, synthetic ? 1 : 0, now.toISOString(), reservationId],
      );
      if (input.providerRequestId && !r.provider_request_id) {
        this.db.run('UPDATE budget_reservations SET provider_request_id = ? WHERE id = ?', [input.providerRequestId, reservationId]);
      }
      // One ledger entry per provider request, and one per reservation when no
      // request id is known: re-reconciling updates instead of double counting.
      const existing =
        (requestId ? this.db.get<{ id: string }>('SELECT id FROM cost_ledger WHERE provider_request_id = ?', [requestId]) : undefined) ??
        this.db.get<{ id: string }>('SELECT id FROM cost_ledger WHERE reservation_id = ? ORDER BY recorded_at LIMIT 1', [reservationId]);
      const usageJson = JSON.stringify({ ...(input.usage ?? {}), ...(overshoot ? { overshootMicros: overshoot, estimatedMicros: r.estimated_usd_micros } : {}) });
      if (existing) {
        // One ledger entry per provider request: update rather than double count.
        this.db.run(
          'UPDATE cost_ledger SET amount_usd_micros = ?, amount_status = ?, source = ?, usage_json = ?, recorded_at = ?, provider_request_id = COALESCE(provider_request_id, ?), is_synthetic = MAX(is_synthetic, ?) WHERE id = ?',
          [input.actualMicros, known ? 'actual' : 'unknown', input.source, usageJson, now.toISOString(), requestId, synthetic ? 1 : 0, existing.id],
        );
      } else {
        this.db.run(
          `INSERT INTO cost_ledger (id, site_id, provider, reservation_id, provider_request_id, amount_usd_micros, amount_status, source, usage_json, period_month, period_week, is_synthetic, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [newId('cost'), r.site_id, r.provider, reservationId, requestId, input.actualMicros, known ? 'actual' : 'unknown', input.source, usageJson, r.period_month, r.period_week, synthetic ? 1 : 0, now.toISOString()],
        );
      }
      recordAudit(this.db, {
        siteId: r.site_id,
        actor: this.opts.actor ?? 'system',
        eventType: known ? 'budget.reconciled' : 'budget.unresolved',
        subjectType: 'reservation',
        subjectId: reservationId,
        details: { actualMicros: input.actualMicros, estimatedMicros: r.estimated_usd_micros, overshootMicros: overshoot, source: input.source, ...(synthetic ? { synthetic: true } : {}) },
        at: now,
      });
      return { status, overshootMicros: overshoot };
    });
  }

  /**
   * Manual reconciliation by a named human (CLI `costs reconcile`) of a charge
   * the provider did not report: an unresolved/ambiguous submission (timeout,
   * 5xx, unparseable response) or an approved unknown-price charge.
   *
   * - `actualMicros`: the amount the owner read in the provider's billing /
   *   usage history. Recorded as actual, source 'manual', with the evidence.
   * - `notCharged: true`: the provider history shows NO charge for this
   *   request. Recorded as an actual $0 only because the owner states it with
   *   provider-history evidence; unknown is never turned into $0 otherwise.
   *
   * Exactly one of the two is required, plus a non-empty evidence note. The
   * name is validated as a human (automation names are refused). Only open
   * reservations (reserved or unresolved) can be reconciled this way. Audited
   * as `budget.manually_reconciled`; an ambiguous provider request linked to
   * the reservation is marked reconciled.
   */
  reconcileManual(
    reservationId: string,
    input: { actualMicros?: Micros | null; notCharged?: boolean; evidence: string; by: string },
  ): { status: 'reconciled'; previousStatus: string; actualMicros: Micros; notCharged: boolean; overshootMicros: Micros; provider: string } {
    const by = validateApproverName(input.by);
    const actor = ownerActor(by);
    const evidence = (input.evidence ?? '').trim();
    if (!evidence) throw new AppError('VALIDATION_FAILED', 'An evidence note is required (what the provider billing/usage history shows for this request).');
    if (evidence.length > 2_000) throw new AppError('VALIDATION_FAILED', 'The evidence note is too long (at most 2000 characters).');
    const hasAmount = input.actualMicros !== undefined && input.actualMicros !== null;
    if (hasAmount === !!input.notCharged) {
      throw new AppError('VALIDATION_FAILED', 'Give exactly one of an explicit actual amount (--actual-usd) or --not-charged; an unknown charge is never recorded as $0 without one of them.');
    }
    if (hasAmount && (!Number.isSafeInteger(input.actualMicros) || input.actualMicros! < 0)) throw new RangeError('actualMicros must be a non-negative integer micro amount');
    const actual = hasAmount ? input.actualMicros! : 0;
    const now = this.clock.now();
    return this.db.transaction(() => {
      const r = this.db.get<{ site_id: string; provider: string; estimated_usd_micros: number; status: string; cost_status: string; period_month: string; period_week: string; provider_request_id: string | null; unbounded: number | null; is_synthetic: number }>(
        `SELECT site_id, provider, estimated_usd_micros, status, cost_status, period_month, period_week, provider_request_id, ${UNBOUNDED_SQL} AS unbounded, is_synthetic FROM budget_reservations WHERE id = ?`,
        [reservationId],
      );
      if (!r) throw new AppError('NOT_FOUND', `Reservation ${reservationId} not found`);
      if (this.opts.siteId && r.site_id !== this.opts.siteId) throw new AppError('NOT_FOUND', `Reservation ${reservationId} not found for site ${this.opts.siteId}`);
      if (r.status !== 'reserved' && r.status !== 'unresolved') {
        throw new AppError('CONFLICT', `Reservation ${reservationId} is ${r.status}; only open (reserved or unresolved) reservations can be reconciled manually.`);
      }
      const unbounded = r.unbounded === 1;
      const overshoot = !unbounded ? Math.max(0, actual - r.estimated_usd_micros) : 0;
      const iso = now.toISOString();
      const synthetic = r.is_synthetic === 1 ? 1 : 0;
      this.db.run(`UPDATE budget_reservations SET status = 'reconciled', cost_status = 'actual', cost_basis = 'manual', actual_usd_micros = ?, note = ?, updated_at = ? WHERE id = ?`, [
        actual,
        `${input.notCharged ? 'not charged' : 'reconciled manually'} by ${actor}: ${evidence}`.slice(0, 2_000),
        iso,
        reservationId,
      ]);
      const usageJson = JSON.stringify({
        manual: true,
        reconciledBy: actor,
        evidence,
        notCharged: !!input.notCharged,
        previousStatus: r.status,
        previousCostStatus: r.cost_status,
        ...(overshoot ? { overshootMicros: overshoot, estimatedMicros: r.estimated_usd_micros } : {}),
      });
      const existing =
        (r.provider_request_id ? this.db.get<{ id: string }>('SELECT id FROM cost_ledger WHERE provider_request_id = ?', [r.provider_request_id]) : undefined) ??
        this.db.get<{ id: string }>('SELECT id FROM cost_ledger WHERE reservation_id = ? ORDER BY recorded_at LIMIT 1', [reservationId]);
      if (existing) {
        this.db.run(`UPDATE cost_ledger SET amount_usd_micros = ?, amount_status = 'actual', source = 'manual', usage_json = ?, recorded_at = ?, is_synthetic = MAX(is_synthetic, ?) WHERE id = ?`, [
          actual,
          usageJson,
          iso,
          synthetic,
          existing.id,
        ]);
      } else {
        this.db.run(
          `INSERT INTO cost_ledger (id, site_id, provider, reservation_id, provider_request_id, amount_usd_micros, amount_status, source, usage_json, period_month, period_week, is_synthetic, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, 'actual', 'manual', ?, ?, ?, ?, ?)`,
          [newId('cost'), r.site_id, r.provider, reservationId, r.provider_request_id, actual, usageJson, r.period_month, r.period_week, synthetic, iso],
        );
      }
      if (r.provider_request_id) {
        this.db.run(`UPDATE provider_requests SET status = 'reconciled', completed_at = COALESCE(completed_at, ?) WHERE id = ? AND status = 'ambiguous'`, [iso, r.provider_request_id]);
      }
      recordAudit(this.db, {
        siteId: r.site_id,
        actor,
        eventType: 'budget.manually_reconciled',
        subjectType: 'reservation',
        subjectId: reservationId,
        details: {
          provider: r.provider,
          previousStatus: r.status,
          previousCostStatus: r.cost_status,
          actualMicros: actual,
          notCharged: !!input.notCharged,
          estimatedMicros: unbounded ? null : r.estimated_usd_micros,
          overshootMicros: overshoot,
          evidence,
        },
        at: now,
      });
      return { status: 'reconciled' as const, previousStatus: r.status, actualMicros: actual, notCharged: !!input.notCharged, overshootMicros: overshoot, provider: r.provider };
    });
  }

  /**
   * Release a reservation whose request was definitely NOT accepted by the
   * provider (e.g. cache hit, validation failure before submission). Never
   * release an ambiguous submission; use markUnresolved instead.
   */
  release(reservationId: string, reason: string): void {
    const now = this.clock.now();
    this.db.transaction(() => {
      const r = this.db.get<{ site_id: string; status: string }>('SELECT site_id, status FROM budget_reservations WHERE id = ?', [reservationId]);
      if (!r) throw new AppError('NOT_FOUND', `Reservation ${reservationId} not found`);
      if (r.status !== 'reserved') throw new AppError('CONFLICT', `Only 'reserved' reservations can be released (was ${r.status})`);
      this.db.run(`UPDATE budget_reservations SET status = 'released', note = ?, updated_at = ? WHERE id = ?`, [reason, now.toISOString(), reservationId]);
      recordAudit(this.db, {
        siteId: r.site_id,
        actor: this.opts.actor ?? 'system',
        eventType: 'budget.released',
        subjectType: 'reservation',
        subjectId: reservationId,
        details: { reason },
        at: now,
      });
    });
  }

  /**
   * Ambiguous submission (e.g. timeout after POST): keep the full estimate
   * reserved until reconciled. A no-op for reservations that are already
   * reconciled or released (their outcome is known).
   */
  markUnresolved(reservationId: string, reason: string): void {
    const now = this.clock.now();
    this.db.transaction(() => {
      const r = this.db.get<{ site_id: string; status: string }>('SELECT site_id, status FROM budget_reservations WHERE id = ?', [reservationId]);
      if (!r || (r.status !== 'reserved' && r.status !== 'unresolved')) return;
      this.db.run(`UPDATE budget_reservations SET status = 'unresolved', cost_status = 'unknown', note = ?, updated_at = ? WHERE id = ?`, [reason, now.toISOString(), reservationId]);
      if (r.status === 'reserved') {
        recordAudit(this.db, {
          siteId: r.site_id,
          actor: this.opts.actor ?? 'system',
          eventType: 'budget.unresolved',
          subjectType: 'reservation',
          subjectId: reservationId,
          details: { reason },
          at: now,
        });
      }
    });
  }

  /** Open reservations (reserved or unresolved), with whether their amount is known and bounded, and whether they are synthetic. */
  listUnresolved(siteId: string): Array<{ id: string; provider: string; purpose: string; status: string; cost_status: string; estimated_usd_micros: number; unbounded: boolean; provider_request_id: string | null; created_at: string; synthetic: boolean }> {
    return this.db
      .all<{ id: string; provider: string; purpose: string; status: string; cost_status: string; estimated_usd_micros: number; unbounded: number | null; provider_request_id: string | null; created_at: string; is_synthetic: number }>(
        `SELECT id, provider, purpose, status, cost_status, estimated_usd_micros, ${UNBOUNDED_SQL} AS unbounded, provider_request_id, created_at, is_synthetic
           FROM budget_reservations WHERE site_id = ? AND status IN ('reserved', 'unresolved') ORDER BY created_at, id`,
        [siteId],
      )
      .map(({ is_synthetic, ...r }) => ({ ...r, unbounded: r.unbounded === 1, synthetic: is_synthetic === 1 }));
  }

  /**
   * Spend report with actual, estimated, reserved, and unknown amounts kept
   * separate. `costBasis` splits the actual amounts into provider-reported and
   * computed-from-usage (list price) parts and shows the synthetic share;
   * the ProviderSpend amounts keep their meaning (computed and synthetic
   * amounts are included in them and count toward the limits).
   */
  report(siteId: string, at: Date = this.clock.now()): SpendReport {
    const { month, week } = this.periods(at);
    const costBasis: ProviderCostBasis[] = [];
    const providers: ProviderSpend[] = BUDGET_PROVIDERS.map((provider) => {
      const rows = this.db.all<{ status: string; cost_status: string; estimated_usd_micros: number; actual_usd_micros: number | null; unbounded: number | null; cost_basis: CostBasis | null; is_synthetic: number; price_source: string | null }>(
        `SELECT status, cost_status, estimated_usd_micros, actual_usd_micros, ${UNBOUNDED_SQL} AS unbounded, cost_basis, is_synthetic, ${PRICE_SOURCE_SQL} AS price_source
           FROM budget_reservations WHERE site_id = ? AND provider = ? AND period_month = ?`,
        [siteId, provider, month],
      );
      let actual = 0;
      let reserved = 0;
      let estimated = 0;
      let unknown = 0;
      let unbounded = 0;
      const basis: ProviderCostBasis = { provider, reportedMicros: 0, computedMicros: 0, computedCount: 0, fixedZeroCount: 0, syntheticMicros: 0, syntheticCount: 0 };
      for (const r of rows) {
        if (r.status === 'released') continue;
        const open = r.status === 'reserved' || r.status === 'unresolved';
        let counted = 0;
        if (r.status === 'reconciled' && r.actual_usd_micros !== null) {
          actual += r.actual_usd_micros;
          counted = r.actual_usd_micros;
          // A free sandbox/fixture request settled at a verified $0 is a fixed zero, never "computed from usage".
          if (isFixedZeroAmount(r)) basis.fixedZeroCount++;
          else if (r.cost_basis === 'computed_from_usage') {
            basis.computedMicros += r.actual_usd_micros;
            basis.computedCount++;
          } else basis.reportedMicros += r.actual_usd_micros;
        } else if (open) {
          reserved += r.estimated_usd_micros;
          counted = r.estimated_usd_micros;
        } else if (r.status === 'reconciled') {
          estimated += r.estimated_usd_micros;
          counted = r.estimated_usd_micros;
        }
        if (r.is_synthetic === 1) {
          basis.syntheticMicros += counted;
          basis.syntheticCount++;
        }
        // Open charges whose amount is not known yet: unresolved submissions and approved
        // unknown-price requests (held at their approved maximum, or without any bound).
        if (open && (r.status === 'unresolved' || r.cost_status === 'unknown')) unknown++;
        if (open && r.unbounded === 1) unbounded++;
      }
      costBasis.push(basis);
      const svc = this.serviceLimits(provider);
      const committed = actual + reserved + estimated;
      const spend: ProviderSpend = {
        provider,
        actualMicros: actual,
        reservedMicros: reserved,
        estimatedMicros: estimated,
        unknownCount: unknown,
        unboundedUnknownCount: unbounded,
        committedMicros: committed,
        limitMicros: svc.monthly,
        remainingMicros: Math.max(0, svc.monthly - committed),
        remainingVerified: unbounded === 0,
      };
      if (svc.weekly !== undefined) {
        const wk = this.tally('site_id = ? AND provider = ? AND period_week = ?', [siteId, provider, week]).committed;
        spend.weekly = { committedMicros: wk, limitMicros: svc.weekly, remainingMicros: Math.max(0, svc.weekly - wk) };
      }
      return spend;
    });
    const combinedCommitted = providers.reduce((s, p) => s + p.committedMicros, 0);
    const combinedUnbounded = providers.reduce((s, p) => s + p.unboundedUnknownCount, 0);
    const demo = this.isDemoSite(siteId);
    const containsSynthetic = costBasis.some((b) => b.syntheticCount > 0);
    const notes: string[] = [];
    // A demo site's amounts are all synthetic: say so first, before any figure is read as a charge.
    if (demo) notes.push(`${SYNTHETIC_DEMO_COSTS}. Every amount above comes from the offline demo's synthetic fixtures (demo site ${siteId}); nothing was sent to a provider or charged.`);
    notes.push(
      'Budgets are configured spending ceilings, not price quotes or guaranteed operating costs.',
      'Subscriptions, infrastructure, taxes, deposits/minimum commitments, and one-time costs are not included.',
      'Provider billing can lag; application checks cannot guarantee zero overshoot. Use provider-side caps where available.',
    );
    if (combinedUnbounded > 0) {
      notes.push(
        `${combinedUnbounded} approved charge(s) with NO upper bound are outstanding: their amount is unknown and not included above, so remaining budget is an upper bound, not a verified figure. Further paid requests need explicit approval until they are reconciled.`,
      );
    }
    const computed = costBasis.filter((b) => b.computedMicros > 0);
    if (computed.length) {
      notes.push(
        `Computed, not provider-reported: ${computed.map((b) => `${b.provider} ${formatUsd(b.computedMicros)} (${b.computedCount} request(s))`).join(', ')} of the actual amount(s) above ${computed.length === 1 && computed[0]!.computedCount === 1 ? 'was' : 'were'} ${COMPUTED_COST_NOTE}, because the provider reported no charge. Computed amounts count toward the limits; the provider's bill may differ.`,
      );
    }
    const fixedZero = costBasis.filter((b) => b.fixedZeroCount > 0);
    if (fixedZero.length) {
      notes.push(
        `Fixed zero, not computed: ${fixedZero.map((b) => `${b.provider} ${b.fixedZeroCount} request(s)`).join(', ')} ${fixedZero.length === 1 && fixedZero[0]!.fixedZeroCount === 1 ? 'was a free sandbox or fixture request' : 'were free sandbox or fixture requests'} settled at a verified $0 (price basis fixed_zero). They were not computed from usage at list price and were not charged.`,
      );
    }
    if (!demo && containsSynthetic) {
      const syn = costBasis.filter((b) => b.syntheticCount > 0);
      notes.push(
        `[SYNTHETIC] ${syn.map((b) => `${b.provider} ${formatUsd(b.syntheticMicros)} (${b.syntheticCount} reservation(s))`).join(', ')} of the committed amounts above come from synthetic fixture, sandbox or demo requests: no real charge. They are counted toward the limits so the checks stay conservative.`,
      );
    }
    return {
      siteId,
      periodMonth: month,
      periodWeek: week,
      timeZone: this.opts.timeZone,
      providers,
      combined: {
        committedMicros: combinedCommitted,
        limitMicros: this.opts.limits.combinedMonthly,
        remainingMicros: Math.max(0, this.opts.limits.combinedMonthly - combinedCommitted),
        unboundedUnknownCount: combinedUnbounded,
        remainingVerified: combinedUnbounded === 0,
      },
      notes,
      costBasis,
      synthetic: demo,
      containsSynthetic,
    };
  }
}
