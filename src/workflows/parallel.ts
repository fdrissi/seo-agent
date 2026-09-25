import { DEFAULT_WORKERS, KeyedLimiter, mapBounded, type SettledResult } from '../core/concurrency.js';

/**
 * BOUNDED PARALLEL pattern (spec section 4).
 *
 * Independent crawls, classifications, and approved batch drafts may run
 * concurrently, but never as unbounded promises: at most `workers` items run
 * at once (default 3), and an optional per-key limit (per provider, per host)
 * is stricter still.
 *
 * Parallelism shortens wall-clock time only. It does NOT reduce token charges
 * or per-request provider costs: ten parallel LLM calls cost the same as ten
 * sequential ones, and every paid call still goes through budget reservation.
 */

export interface BoundedParallelOptions<I> {
  /** Key used for the per-key limit, e.g. the provider or hostname of the item. */
  keyOf?: (item: I, index: number) => string;
  /** Max concurrent items per key (number, or a function of the key). Defaults to `workers`. */
  perKeyLimit?: number | ((key: string) => number);
  signal?: AbortSignal;
  /** Called after each item settles (progress reporting, heartbeats). */
  onSettled?: (index: number, result: SettledResult<unknown>) => void;
}

export interface BoundedParallelResult<O> {
  results: SettledResult<O>[];
  succeeded: number;
  failed: number;
  workers: number;
}

export const MAX_WORKERS = 16;

export async function runBoundedParallel<I, O>(
  items: readonly I[],
  workers: number = DEFAULT_WORKERS,
  fn: (item: I, index: number, signal: AbortSignal | undefined) => Promise<O>,
  opts: BoundedParallelOptions<I> = {},
): Promise<BoundedParallelResult<O>> {
  if (!Number.isInteger(workers) || workers < 1 || workers > MAX_WORKERS) {
    throw new RangeError(`workers must be an integer between 1 and ${MAX_WORKERS} (got ${workers})`);
  }
  const perKey = opts.perKeyLimit;
  if (typeof perKey === 'number' && (!Number.isInteger(perKey) || perKey < 1)) throw new RangeError('perKeyLimit must be a positive integer');
  const limiter = opts.keyOf
    ? new KeyedLimiter((key) => {
        const n = typeof perKey === 'function' ? perKey(key) : (perKey ?? workers);
        if (!Number.isInteger(n) || n < 1) throw new RangeError(`perKeyLimit for "${key}" must be a positive integer`);
        return Math.min(n, workers);
      })
    : null;
  const results = await mapBounded(
    items,
    workers,
    async (item, index) => {
      const run = () => fn(item, index, opts.signal);
      try {
        const value = limiter ? await limiter.run(opts.keyOf!(item, index), run, opts.signal) : await run();
        opts.onSettled?.(index, { ok: true, value });
        return value;
      } catch (error) {
        opts.onSettled?.(index, { ok: false, error });
        throw error;
      }
    },
    opts.signal,
  );
  const succeeded = results.filter((r) => r.ok).length;
  return { results, succeeded, failed: results.length - succeeded, workers };
}
