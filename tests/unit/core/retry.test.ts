import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY, NO_RETRY, backoffDelay, parseRetryAfter, retry, type RetryPolicy } from '../../../src/core/retry.js';

const fast: RetryPolicy = { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 4, jitter: 0 };

describe('retry', () => {
  it('retries until success and reports attempts', async () => {
    const seen: number[] = [];
    const delays: number[] = [];
    const out = await retry(
      async ({ attempt, lastError }) => {
        seen.push(attempt);
        if (attempt === 1) expect(lastError).toBeUndefined();
        else expect(lastError).toBeInstanceOf(Error);
        if (attempt < 3) throw new Error(`fail ${attempt}`);
        return 'ok';
      },
      { policy: fast, onRetry: (_e, _a, d) => delays.push(d) },
    );
    expect(out).toBe('ok');
    expect(seen).toEqual([1, 2, 3]);
    expect(delays).toEqual([1, 2]);
  });

  it('does not retry when shouldRetry returns false (e.g. a paid POST)', async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw Object.assign(new Error('timeout after submit'), { code: 'TIMEOUT' });
        },
        { policy: fast, shouldRetry: () => false },
      ),
    ).rejects.toThrow('timeout after submit');
    expect(calls).toBe(1);
  });

  it('NO_RETRY makes exactly one attempt', async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new Error('x');
        },
        { policy: NO_RETRY },
      ),
    ).rejects.toThrow('x');
    expect(calls).toBe(1);
  });

  it('a numeric shouldRetry overrides the delay (Retry-After)', async () => {
    const delays: number[] = [];
    let calls = 0;
    await retry(
      async () => {
        if (++calls < 2) throw new Error('429');
        return true;
      },
      { policy: { ...fast, baseDelayMs: 10_000, maxDelayMs: 10_000 }, shouldRetry: () => 0, onRetry: (_e, _a, d) => delays.push(d) },
    );
    expect(delays).toEqual([0]);
  });

  it('throws the last error after exhausting attempts', async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          throw new Error(`attempt ${++calls}`);
        },
        { policy: { ...fast, maxAttempts: 3 } },
      ),
    ).rejects.toThrow('attempt 3');
  });

  it('always makes at least one attempt, even with a zero maxAttempts policy', async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new Error('only');
        },
        { policy: { ...fast, maxAttempts: 0 } },
      ),
    ).rejects.toThrow('only');
    expect(calls).toBe(1);
  });

  it('does not start when already aborted, and aborts the backoff sleep', async () => {
    const pre = new AbortController();
    pre.abort(new Error('cancelled'));
    let calls = 0;
    await expect(retry(async () => ++calls, { signal: pre.signal })).rejects.toThrow('cancelled');
    expect(calls).toBe(0);

    const ac = new AbortController();
    const p = retry(
      async () => {
        throw new Error('fail');
      },
      { policy: { ...fast, baseDelayMs: 60_000, maxDelayMs: 60_000 }, signal: ac.signal, onRetry: () => ac.abort(new Error('stop waiting')) },
    );
    await expect(p).rejects.toThrow('stop waiting');
  });
});

describe('backoffDelay', () => {
  it('grows exponentially, caps at maxDelayMs, and applies bounded jitter', () => {
    const p: RetryPolicy = { maxAttempts: 10, baseDelayMs: 100, maxDelayMs: 1_000, jitter: 0 };
    expect([1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a, p))).toEqual([100, 200, 400, 800, 1_000, 1_000]);
    const j: RetryPolicy = { ...p, jitter: 0.2 };
    expect(backoffDelay(1, j, () => 0)).toBe(80);
    expect(backoffDelay(1, j, () => 1)).toBe(120);
    expect(backoffDelay(1, DEFAULT_RETRY, () => 0.5)).toBe(500);
  });
});

describe('parseRetryAfter', () => {
  const now = new Date('2026-09-24T09:00:00Z');

  it('parses delay-seconds', () => {
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter(' 0 ', now)).toBe(0);
    expect(parseRetryAfter('1.5', now)).toBe(1_500);
  });

  it('parses HTTP dates relative to now (past dates mean retry now)', () => {
    expect(parseRetryAfter('Thu, 24 Sep 2026 09:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Thu, 24 Sep 2026 08:00:00 GMT', now)).toBe(0);
  });

  it('returns undefined for missing or invalid values instead of guessing', () => {
    for (const v of [undefined, null, '', '-5', '120abc', 'soon', '1e3', 'NaN']) expect(parseRetryAfter(v as string | null | undefined, now)).toBeUndefined();
  });
});
