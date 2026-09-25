import { sleep } from './concurrency.js';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Multiplicative jitter fraction in [0, 1]. */
  jitter: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 30_000, jitter: 0.2 };

/**
 * Paid POST submissions are NEVER retried blindly: a timeout may mean the
 * provider accepted the job. Callers mark such requests "ambiguous" and
 * reconcile against provider history instead.
 */
export const NO_RETRY: RetryPolicy = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 };

export function backoffDelay(attempt: number, policy: RetryPolicy, rand: () => number = Math.random): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const j = exp * policy.jitter * (rand() * 2 - 1);
  return Math.max(0, Math.round(exp + j));
}

/** Parse Retry-After (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now: Date = new Date()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  // delay-seconds (RFC 9110: 1*DIGIT; fractional values tolerated).
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  // HTTP-date, e.g. "Wed, 21 Oct 2015 07:28:00 GMT". Require letters so that
  // junk such as "-5" or "120abc" (which V8's lenient parser accepts as years)
  // is not mistaken for a date.
  if (!/[A-Za-z]{3}/.test(v)) return undefined;
  const at = Date.parse(v);
  if (!Number.isNaN(at)) return Math.max(0, at - now.getTime());
  return undefined;
}

export interface RetryContext {
  attempt: number;
  lastError?: unknown;
}

/**
 * Retry an idempotent operation. `shouldRetry` decides per error; return a
 * number to override the delay (e.g. from Retry-After).
 */
export async function retry<T>(
  fn: (ctx: RetryContext) => Promise<T>,
  opts: {
    policy?: RetryPolicy;
    shouldRetry?: (err: unknown, attempt: number) => boolean | number;
    signal?: AbortSignal;
    onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  } = {},
): Promise<T> {
  const policy = opts.policy ?? DEFAULT_RETRY;
  let lastError: unknown;
  // At least one attempt is always made (a zero/NaN maxAttempts must not throw `undefined`).
  const maxAttempts = Number.isFinite(policy.maxAttempts) ? Math.max(1, Math.floor(policy.maxAttempts)) : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
    try {
      return await fn(lastError === undefined ? { attempt } : { attempt, lastError });
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) break;
      const decision = opts.shouldRetry ? opts.shouldRetry(err, attempt) : true;
      if (decision === false) break;
      const delay = typeof decision === 'number' ? decision : backoffDelay(attempt, policy);
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay, opts.signal);
    }
  }
  throw lastError;
}
