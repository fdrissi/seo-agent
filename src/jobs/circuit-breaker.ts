import { AppError } from '../core/errors.js';
import { systemClock, type Clock } from '../core/clock.js';
import { recordAudit } from '../database/audit.js';
import type { Db } from '../database/db.js';
import { countsAsProviderFailure, toErrorInfo } from '../workflows/errors.js';
import type { GateDecision, ProviderGate } from '../workflows/stage.js';

/**
 * Per-site, per-provider circuit breakers (table `circuit_breakers`).
 *
 *   closed    -> requests allowed; consecutive provider failures are counted.
 *   open      -> after `failureThreshold` consecutive failures; requests are
 *                refused until `cooldownMs` has passed.
 *   half_open -> after the cooldown one probe request is allowed. Success
 *                closes the breaker; failure re-opens it for another cooldown.
 *                If the probe never reports back (crash), another probe is
 *                allowed after a further cooldown.
 *
 * Only errors that say something about provider health count (timeouts,
 * provider/network errors, rate limits). Budget, policy, validation,
 * credential, and OFFLINE errors do not open a breaker. A run with network
 * access disabled (--offline, demo mode) never changes breaker state at all
 * (`offline` option): it sends nothing, so it learns nothing about the
 * provider. State is persisted so separate CLI invocations and the scheduler
 * share it; `jobs breakers` lists it and `jobs breakers --reset <provider>`
 * clears one breaker (audited).
 *
 * An open breaker for an OPTIONAL provider degrades only the workflow stages
 * that declare that provider; unrelated stages keep running.
 */

export type BreakerStateName = 'closed' | 'open' | 'half_open';

export interface BreakerState {
  provider: string;
  state: BreakerStateName;
  consecutiveFailures: number;
  openedAt: string | null;
  nextProbeAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

export interface CircuitBreakerPolicy {
  failureThreshold: number;
  cooldownMs: number;
}

export interface CircuitBreakerOptions extends Partial<CircuitBreakerPolicy> {
  perProvider?: Record<string, Partial<CircuitBreakerPolicy>>;
  countsAsFailure?: (err: unknown) => boolean;
  /**
   * The run has network access disabled (--offline or demo mode). Its requests
   * are refused locally, so they say nothing about provider health: failures
   * and successes are not recorded and no half-open probe is consumed. Open
   * breakers are still reported (read-only).
   */
  offline?: boolean;
}

export const DEFAULT_BREAKER_POLICY: CircuitBreakerPolicy = { failureThreshold: 3, cooldownMs: 15 * 60_000 };

interface BreakerRow {
  site_id: string;
  provider: string;
  state: BreakerStateName;
  consecutive_failures: number;
  opened_at: string | null;
  next_probe_at: string | null;
  last_error: string | null;
  updated_at: string;
}

/** Next step printed with an open breaker: where to see it and how to clear it once the cause is fixed. */
export function breakerHint(provider: string, nextProbeAt: string | null): string {
  return `${nextProbeAt ? `The provider failed repeatedly; a probe request is allowed after ${nextProbeAt}. ` : 'The provider failed repeatedly. '}See the breaker state and its last error with \`npm run cli -- jobs breakers\`; once the cause is fixed, \`npm run cli -- jobs breakers --reset ${provider}\` closes it (audited).`;
}

export class CircuitOpenError extends AppError {
  constructor(provider: string, reason: string, nextProbeAt: string | null) {
    super('INTEGRATION_UNAVAILABLE', `${provider}: circuit breaker ${reason}`, {
      details: { provider, nextProbeAt },
      hint: breakerHint(provider, nextProbeAt),
    });
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreakers implements ProviderGate {
  private readonly countsAsFailure: (err: unknown) => boolean;

  constructor(
    private readonly db: Db,
    private readonly siteId: string,
    private readonly clock: Clock = systemClock,
    private readonly opts: CircuitBreakerOptions = {},
  ) {
    this.countsAsFailure = opts.countsAsFailure ?? countsAsProviderFailure;
    const toCheck: Array<[string, CircuitBreakerPolicy]> = [['default', this.policy('__default__')], ...Object.keys(opts.perProvider ?? {}).map((k): [string, CircuitBreakerPolicy] => [k, this.policy(k)])];
    for (const [k, p] of toCheck) {
      if (!Number.isInteger(p.failureThreshold) || p.failureThreshold < 1) throw new RangeError(`circuit breaker ${k}: failureThreshold must be a positive integer`);
      if (!Number.isInteger(p.cooldownMs) || p.cooldownMs < 0) throw new RangeError(`circuit breaker ${k}: cooldownMs must be a non-negative integer`);
    }
  }

  policy(provider: string): CircuitBreakerPolicy {
    const base: CircuitBreakerPolicy = {
      failureThreshold: this.opts.failureThreshold ?? DEFAULT_BREAKER_POLICY.failureThreshold,
      cooldownMs: this.opts.cooldownMs ?? DEFAULT_BREAKER_POLICY.cooldownMs,
    };
    return { ...base, ...(this.opts.perProvider?.[provider] ?? {}) };
  }

  private row(provider: string): BreakerRow | undefined {
    return this.db.get<BreakerRow>('SELECT * FROM circuit_breakers WHERE site_id = ? AND provider = ?', [this.siteId, provider]);
  }

  get(provider: string): BreakerState {
    const r = this.row(provider);
    if (!r) return { provider, state: 'closed', consecutiveFailures: 0, openedAt: null, nextProbeAt: null, lastError: null, updatedAt: null };
    return { provider, state: r.state, consecutiveFailures: r.consecutive_failures, openedAt: r.opened_at, nextProbeAt: r.next_probe_at, lastError: r.last_error, updatedAt: r.updated_at };
  }

  list(): BreakerState[] {
    return this.db
      .all<BreakerRow>('SELECT * FROM circuit_breakers WHERE site_id = ? ORDER BY provider', [this.siteId])
      .map((r) => ({ provider: r.provider, state: r.state, consecutiveFailures: r.consecutive_failures, openedAt: r.opened_at, nextProbeAt: r.next_probe_at, lastError: r.last_error, updatedAt: r.updated_at }));
  }

  private upsert(provider: string, s: Omit<BreakerState, 'provider' | 'updatedAt'>, now: Date): void {
    this.db.run(
      `INSERT INTO circuit_breakers (site_id, provider, state, consecutive_failures, opened_at, next_probe_at, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (site_id, provider) DO UPDATE SET state = excluded.state, consecutive_failures = excluded.consecutive_failures,
         opened_at = excluded.opened_at, next_probe_at = excluded.next_probe_at, last_error = excluded.last_error, updated_at = excluded.updated_at`,
      [this.siteId, provider, s.state, s.consecutiveFailures, s.openedAt, s.nextProbeAt, s.lastError, now.toISOString()],
    );
  }

  /** Read-only view of whether a request would be allowed now (never consumes the half-open probe). */
  peek(provider: string): GateDecision {
    const s = this.get(provider);
    if (s.state === 'closed') return { allowed: true, probe: false };
    const probeAt = s.nextProbeAt ? Date.parse(s.nextProbeAt) : 0;
    if (this.clock.now().getTime() < probeAt) {
      return { allowed: false, reason: s.state === 'open' ? `open after ${s.consecutiveFailures} consecutive failures` : 'half-open: a probe request is in flight', nextProbeAt: s.nextProbeAt };
    }
    return { allowed: true, probe: true };
  }

  /**
   * Whether a request to `provider` may be made now. Transitions open ->
   * half_open when the cooldown has passed (the caller is the probe).
   */
  canRequest(provider: string): GateDecision {
    // Offline runs send nothing: never consume (or start) a half-open probe.
    if (this.opts.offline) return this.peek(provider);
    const now = this.clock.now();
    return this.db.transaction((): GateDecision => {
      const s = this.get(provider);
      if (s.state === 'closed') return { allowed: true, probe: false };
      const probeAt = s.nextProbeAt ? Date.parse(s.nextProbeAt) : 0;
      if (now.getTime() < probeAt) {
        return { allowed: false, reason: s.state === 'open' ? `open after ${s.consecutiveFailures} consecutive failures` : 'half-open: a probe request is in flight', nextProbeAt: s.nextProbeAt };
      }
      // Cooldown over: this caller becomes the (single) probe until the probe lease expires.
      const lease = new Date(now.getTime() + this.policy(provider).cooldownMs).toISOString();
      this.upsert(provider, { state: 'half_open', consecutiveFailures: s.consecutiveFailures, openedAt: s.openedAt, nextProbeAt: lease, lastError: s.lastError }, now);
      if (s.state === 'open') this.audit('circuit.half_open', provider, { consecutiveFailures: s.consecutiveFailures }, now);
      return { allowed: true, probe: true };
    });
  }

  recordSuccess(provider: string): void {
    if (this.opts.offline) return;
    const now = this.clock.now();
    this.db.transaction(() => {
      const s = this.get(provider);
      if (s.state === 'closed' && s.consecutiveFailures === 0) return;
      this.upsert(provider, { state: 'closed', consecutiveFailures: 0, openedAt: null, nextProbeAt: null, lastError: s.lastError }, now);
      if (s.state !== 'closed') this.audit('circuit.closed', provider, { previous: s.state }, now);
    });
  }

  recordFailure(provider: string, error: unknown): void {
    if (this.opts.offline || !this.countsAsFailure(error)) return;
    const now = this.clock.now();
    const info = toErrorInfo(error);
    const lastError = `${info.code}: ${info.message}`.slice(0, 500);
    const policy = this.policy(provider);
    this.db.transaction(() => {
      const s = this.get(provider);
      const failures = s.consecutiveFailures + 1;
      const reopen = s.state === 'half_open' || s.state === 'open';
      if (reopen || failures >= policy.failureThreshold) {
        const next = new Date(now.getTime() + policy.cooldownMs).toISOString();
        this.upsert(provider, { state: 'open', consecutiveFailures: failures, openedAt: now.toISOString(), nextProbeAt: next, lastError }, now);
        if (s.state !== 'open') this.audit('circuit.opened', provider, { consecutiveFailures: failures, nextProbeAt: next, error: lastError, fromState: s.state }, now);
      } else {
        this.upsert(provider, { state: 'closed', consecutiveFailures: failures, openedAt: null, nextProbeAt: null, lastError }, now);
      }
    });
  }

  /** Run `fn` through the breaker: refuse when open, record success/failure. */
  async execute<T>(provider: string, fn: () => Promise<T>): Promise<T> {
    const d = this.canRequest(provider);
    if (!d.allowed) throw new CircuitOpenError(provider, d.reason, d.nextProbeAt);
    try {
      const v = await fn();
      this.recordSuccess(provider);
      return v;
    } catch (err) {
      this.recordFailure(provider, err);
      throw err;
    }
  }

  /**
   * Forget a provider's breaker state (closes it). Audited as `circuit.reset`
   * with the previous state and the actor. Returns false when no state was
   * recorded for the provider (nothing changed, nothing audited).
   */
  reset(provider: string, actor = 'system'): boolean {
    const now = this.clock.now();
    return this.db.transaction(() => {
      const prev = this.row(provider);
      if (!prev) return false;
      this.db.run('DELETE FROM circuit_breakers WHERE site_id = ? AND provider = ?', [this.siteId, provider]);
      this.audit('circuit.reset', provider, { previousState: prev.state, consecutiveFailures: prev.consecutive_failures, nextProbeAt: prev.next_probe_at, lastError: prev.last_error }, now, actor);
      return true;
    });
  }

  private audit(eventType: string, provider: string, details: Record<string, unknown>, at: Date, actor = 'system'): void {
    recordAudit(this.db, { siteId: this.siteId, actor, eventType, subjectType: 'provider', subjectId: provider, details, at });
  }
}
