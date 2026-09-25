/**
 * Bounded parallelism primitives. Parallel work never creates unbounded
 * promises: callers choose a worker count (default 3 per the spec) and
 * per-key limits (e.g. per provider or per host).
 */

export const DEFAULT_WORKERS = 3;

export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
    this.available = capacity;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    if (this.available > 0) {
      this.available--;
      return this.releaser();
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(signal?.reason ?? new Error('aborted'));
      };
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve(this.releaser());
      };
      this.waiters.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.available++;
    };
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Per-key semaphores (e.g. one per hostname or provider). */
export class KeyedLimiter {
  private readonly sems = new Map<string, Semaphore>();
  constructor(private readonly capacityFor: (key: string) => number) {}

  run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let sem = this.sems.get(key);
    if (!sem) {
      sem = new Semaphore(this.capacityFor(key));
      this.sems.set(key, sem);
    }
    return sem.run(fn, signal);
  }
}

export type SettledResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Map items with at most `workers` concurrent executions. Results preserve
 * input order. Failures are captured per item (one failure does not abort
 * independent items) unless `signal` is aborted.
 */
export async function mapBounded<I, O>(
  items: readonly I[],
  workers: number,
  fn: (item: I, index: number) => Promise<O>,
  signal?: AbortSignal,
): Promise<SettledResult<O>[]> {
  const results: SettledResult<O>[] = new Array(items.length);
  let next = 0;
  // A non-finite worker count (NaN/undefined from bad config) must not silently
  // run zero workers; fall back to a single worker.
  const requested = Number.isFinite(workers) ? Math.floor(workers) : 1;
  const count = Math.max(1, Math.min(requested, items.length));
  const worker = async () => {
    while (true) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await fn(items[i]!, i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: count }, worker));
  for (let i = 0; i < items.length; i++) {
    if (!results[i]) results[i] = { ok: false, error: signal?.reason ?? new Error('cancelled before start') };
  }
  return results;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Reject if `promise` does not settle within `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { code: 'TIMEOUT' })), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
