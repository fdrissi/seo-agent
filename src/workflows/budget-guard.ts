import { AppError, BudgetExceededError, PolicyDeniedError } from '../core/errors.js';
import { formatUsd, type Micros } from '../core/money.js';
import type { BudgetService } from '../budgets/budget-service.js';
import type { BudgetProvider, LimitCheck, Reservation, ReserveRequest } from '../budgets/types.js';
import type { CostAllowance } from './types.js';
import type { StageBudget } from './stage.js';

/**
 * Enforces a stage's declared cost allowance. Every reservation a stage makes
 * (directly through `tools.budget` or through `ctx.app.budgets`, which the
 * engine proxies) is checked against the stage cap BEFORE the budget service
 * checks run/site/service/account limits. A stage that declares
 * `costAllowance: 'none'` cannot reserve at all.
 *
 * Released reservations are not subtracted from the stage total: the stage
 * cap is a conservative ceiling on what the stage may commit.
 *
 * Unknown prices: a reservation without a safe upper bound needs an explicit
 * approval id. It is counted separately (`unknownPriceReservations`), never as
 * $0, and once a stage holds one for a provider, the stage cap for that
 * provider can no longer be verified, so every further reservation for that
 * provider in the stage also needs an explicit approval id.
 */
export class StageBudgetGuard implements StageBudget {
  readonly caps: Partial<Record<BudgetProvider, Micros>>;
  private readonly used = new Map<BudgetProvider, Micros>();
  private readonly unknown = new Map<BudgetProvider, number>();

  constructor(
    private readonly budgets: BudgetService,
    private readonly siteId: string,
    private readonly jobId: string,
    private readonly stage: string,
    allowance: CostAllowance[] | 'none',
  ) {
    const caps: Partial<Record<BudgetProvider, Micros>> = {};
    if (allowance !== 'none') for (const a of allowance) caps[a.provider] = (caps[a.provider] ?? 0) + a.maxMicros;
    this.caps = caps;
  }

  /** Sum of the KNOWN upper bounds reserved so far (unknown-price reservations are not in it). */
  reservedMicros(provider: BudgetProvider): Micros {
    return this.used.get(provider) ?? 0;
  }

  /** Number of approved reservations with an unknown price (their cost is unknown, not zero). */
  unknownPriceReservations(provider: BudgetProvider): number {
    return this.unknown.get(provider) ?? 0;
  }

  reserve(req: Omit<ReserveRequest, 'siteId' | 'runId'> & { siteId?: string; runId?: string }): Reservation {
    if (req.siteId !== undefined && req.siteId !== this.siteId) {
      throw new PolicyDeniedError(`Stage "${this.stage}" may only reserve budget for its own site`, { stage: this.stage, requestedSite: req.siteId });
    }
    const cap = this.caps[req.provider];
    if (cap === undefined) {
      throw new PolicyDeniedError(`Stage "${this.stage}" declares no cost allowance for ${req.provider}; paid requests are not permitted in this stage.`, {
        stage: this.stage,
        provider: req.provider,
      });
    }
    const amount = req.estimate.upperBoundMicros;
    // Same rule as the budget service: no bound, or a bound whose basis is unknown, is not a safe upper bound.
    const unknownPrice = amount === null || req.estimate.basis.source === 'unknown';
    if (unknownPrice) {
      if (!req.unknownPriceApprovalId) {
        throw new AppError('BUDGET_UNKNOWN_PRICE', `Stage "${this.stage}": no safe upper bound for "${req.purpose}", so it cannot be checked against the stage allowance.`, {
          details: { stage: this.stage, provider: req.provider },
          hint: 'Configure a verified price or approve this specific request explicitly.',
        });
      }
    } else {
      if (this.unknownPriceReservations(req.provider) > 0 && !req.unknownPriceApprovalId) {
        throw new AppError(
          'BUDGET_UNKNOWN_PRICE',
          `Stage "${this.stage}": an earlier ${req.provider} reservation in this stage had no safe upper bound, so the stage allowance can no longer be verified for "${req.purpose}".`,
          {
            details: { stage: this.stage, provider: req.provider, unknownPriceReservations: this.unknownPriceReservations(req.provider) },
            hint: 'Approve this request explicitly as well, or configure a verified price so the stage cap can be checked.',
          },
        );
      }
      const used = this.reservedMicros(req.provider);
      if (used + amount > cap) {
        throw new BudgetExceededError(
          `Stage "${this.stage}" cost allowance for ${req.provider} would be exceeded: ${formatUsd(used)} reserved + ${formatUsd(amount)} requested > ${formatUsd(cap)} cap`,
          { scope: 'stage_allowance', limitMicros: cap, committedMicros: used, requestedMicros: amount, stage: this.stage, provider: req.provider },
        );
      }
    }
    const reservation = this.budgets.reserve({ ...req, siteId: this.siteId, runId: this.jobId });
    if (unknownPrice) this.unknown.set(req.provider, this.unknownPriceReservations(req.provider) + 1);
    else this.used.set(req.provider, this.reservedMicros(req.provider) + (amount ?? 0));
    return reservation;
  }

  /**
   * Budget service proxy handed to stages as `ctx.app.budgets`: identical to
   * the real service except that `reserve` goes through this guard.
   */
  proxy(): BudgetService {
    const guard = this;
    return new Proxy(this.budgets, {
      get(target, prop, receiver) {
        if (prop === 'reserve') return (req: ReserveRequest) => guard.reserve(req);
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }
}

/**
 * Pre-flight: which configured limits are already exhausted for a provider
 * (committed >= limit)? A stage whose provider budget is exhausted is not
 * started; the workflow reports an honest BUDGET_EXCEEDED status instead.
 */
export function exhaustedLimits(budgets: BudgetService, siteId: string, provider: BudgetProvider, runId: string): LimitCheck[] {
  return budgets.checkLimits({ siteId, provider, runId, amountMicros: 1 }).filter((c) => c.committedMicros + c.requestedMicros > c.limitMicros);
}
