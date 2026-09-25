import { describe, expect, it } from 'vitest';
import { sleep } from '../../../src/core/concurrency.js';
import { runBoundedParallel } from '../../../src/workflows/parallel.js';

function tracker() {
  let active = 0;
  let max = 0;
  const perKey = new Map<string, { active: number; max: number }>();
  return {
    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      active++;
      max = Math.max(max, active);
      const k = perKey.get(key) ?? { active: 0, max: 0 };
      k.active++;
      k.max = Math.max(k.max, k.active);
      perKey.set(key, k);
      try {
        return await fn();
      } finally {
        active--;
        k.active--;
      }
    },
    get max() {
      return max;
    },
    perKey,
  };
}

describe('runBoundedParallel', () => {
  it('never exceeds the worker count (default 3) and preserves order', async () => {
    const t = tracker();
    const items = Array.from({ length: 20 }, (_, i) => i);
    const r = await runBoundedParallel(items, undefined, (i) => t.run('all', async () => (await sleep(2 + (i % 3)), i * 2)));
    expect(t.max).toBe(3);
    expect(r.workers).toBe(3);
    expect(r.results.map((x) => (x.ok ? x.value : null))).toEqual(items.map((i) => i * 2));
    expect(r.succeeded).toBe(20);
  });

  it('applies a stricter per-key limit (e.g. per provider or host)', async () => {
    const t = tracker();
    const items = Array.from({ length: 12 }, (_, i) => ({ host: i % 2 === 0 ? 'a.example.test' : 'b.example.test', i }));
    await runBoundedParallel(items, 4, (it) => t.run(it.host, () => sleep(3)), { keyOf: (it) => it.host, perKeyLimit: 1 });
    expect(t.perKey.get('a.example.test')!.max).toBe(1);
    expect(t.perKey.get('b.example.test')!.max).toBe(1);
    expect(t.max).toBeLessThanOrEqual(4);
  });

  it('isolates failures per item', async () => {
    const r = await runBoundedParallel([1, 2, 3, 4], 2, async (i) => {
      if (i === 2) throw new Error('boom');
      return i;
    });
    expect(r.failed).toBe(1);
    expect(r.results[1]).toMatchObject({ ok: false });
    expect(r.results[3]).toEqual({ ok: true, value: 4 });
  });

  it('stops starting new items after abort', async () => {
    const ctl = new AbortController();
    let started = 0;
    const r = await runBoundedParallel(
      Array.from({ length: 10 }, (_, i) => i),
      2,
      async (i) => {
        started++;
        if (i === 1) ctl.abort(new Error('stop'));
        await sleep(2);
        return i;
      },
      { signal: ctl.signal },
    );
    expect(started).toBeLessThan(10);
    expect(r.failed).toBeGreaterThan(0);
  });

  it('rejects unbounded or invalid worker counts', async () => {
    await expect(runBoundedParallel([1], 0, async () => 1)).rejects.toThrow(RangeError);
    await expect(runBoundedParallel([1], 1000, async () => 1)).rejects.toThrow(RangeError);
    await expect(runBoundedParallel([1], 2, async () => 1, { keyOf: () => 'k', perKeyLimit: 0 })).rejects.toThrow(RangeError);
  });
});
