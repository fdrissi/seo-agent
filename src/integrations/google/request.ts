import type { AppContext } from '../../app/context.js';
import { retry, type RetryPolicy } from '../../core/retry.js';
import { GoogleApiError, googleErrorFromUnknown } from './errors.js';
import { apiNameForUrl } from './http-client.js';
import type { GoogleApiClient, GoogleRequest } from './types.js';

/**
 * One logical Google API call: provider-request log (never paid), bounded
 * retry with exponential backoff for rate limits / server errors (these are
 * free, idempotent reads), and the raw response saved to the private
 * workspace raw store. Returns the raw reference used for provenance.
 */

export type GoogleProvider = 'google_gsc' | 'google_ga4';

/**
 * Default retry policy for Google reads. Only short-term rate limits
 * (per-minute / concurrency), 5xx, and real transport failures are retried,
 * with exponential backoff and jitter. Exhausted quotas (Search Console load
 * quota "quota exceeded", quotaExceeded, dailyLimitExceeded; GA4 429
 * RESOURCE_EXHAUSTED token quotas) are never retried within a run: they need
 * 15 minutes to a day, and extra attempts add load and spend the GA4 error
 * budget. Credential and configuration errors are never retried. GA4 allows
 * only 10 server errors per project/property/hour, so attempts stay small.
 */
export const GOOGLE_READ_RETRY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 60_000, jitter: 0.2 };

export interface GoogleCallOptions {
  provider: GoogleProvider;
  /** Logical endpoint key, e.g. 'searchanalytics.query'. Never a credential-bearing URL. */
  endpoint: string;
  request: GoogleRequest;
  synthetic: boolean;
  rawKind: string;
  retry?: RetryPolicy;
  /** Attach extra, non-secret context to the raw record. */
  rawContext?: Record<string, unknown>;
}

export interface GoogleCallResult<T> {
  data: T;
  status: number;
  rawRef: string | null;
  attempts: number;
  providerRequestId: string;
}

export async function callGoogle<T>(ctx: AppContext, client: GoogleApiClient, opts: GoogleCallOptions): Promise<GoogleCallResult<T>> {
  const u = new URL(opts.request.url);
  const logged = ctx.requests.prepare({
    siteId: ctx.siteId,
    provider: opts.provider,
    endpoint: opts.endpoint,
    method: opts.request.method ?? (opts.request.data === undefined ? 'GET' : 'POST'),
    isPaid: false,
    params: { host: u.host, path: u.pathname, params: opts.request.params ?? null, body: opts.request.data ?? null },
    isSynthetic: opts.synthetic,
    traceId: ctx.runId,
  });
  ctx.requests.markSubmitted(logged.id);
  const policy = opts.retry ?? GOOGLE_READ_RETRY;
  let attempts = 0;
  try {
    const res = await retry(
      async () => {
        attempts++;
        try {
          return await client.request<T>(opts.request);
        } catch (err) {
          throw googleErrorFromUnknown(apiNameForUrl(opts.request.url), err);
        }
      },
      {
        policy,
        shouldRetry: (err) => {
          if (!(err instanceof GoogleApiError) || !err.retryable) return false;
          if (err.retryAfterMs !== undefined) return Math.min(err.retryAfterMs, policy.maxDelayMs);
          return true;
        },
        onRetry: (err, attempt, delay) =>
          ctx.logger.warn(`Google ${opts.endpoint} failed (attempt ${attempt}); retrying in ${delay}ms`, {
            kind: err instanceof GoogleApiError ? err.kind : 'unknown',
            status: err instanceof GoogleApiError ? err.status : null,
          }),
      },
    );
    const rawRef = ctx.raw.save({
      siteId: ctx.siteId,
      provider: opts.provider,
      kind: opts.rawKind,
      payload: {
        synthetic: opts.synthetic,
        request: { method: opts.request.method ?? 'GET', host: u.host, path: u.pathname, params: opts.request.params ?? null, body: opts.request.data ?? null },
        response: res.data,
        ...(opts.rawContext ? { context: opts.rawContext } : {}),
      },
      at: ctx.clock.now(),
    });
    ctx.requests.complete(logged.id, { status: 'succeeded', httpStatus: res.status, rawRef });
    return { data: res.data, status: res.status, rawRef, attempts, providerRequestId: logged.id };
  } catch (err) {
    const gerr = googleErrorFromUnknown(apiNameForUrl(opts.request.url), err);
    ctx.requests.complete(logged.id, {
      status: 'failed',
      httpStatus: gerr.status || null,
      error: { kind: gerr.kind, status: gerr.status, message: gerr.message, attempts },
    });
    throw gerr;
  }
}
