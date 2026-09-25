import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKERS, KeyedLimiter, Semaphore, mapBounded, sleep, withTimeout } from '../../../src/core/concurrency.js';

/** Resolvable promise used to hold tasks open while measuring concurrency. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('Semaphore', () => {
  it('rejects invalid capacities', () => {
    for (const c of [0, -1, 1.5, Number.NaN]) expect(() => new Semaphore(c)).toThrow(RangeError);
  });

  it('never exceeds capacity and hands permits over in FIFO order', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const gates = Array.from({ length: 5 }, () => deferred());
    const runs = gates.map((g, i) =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        order.push(i);
        await g.promise;
        active--;
      }),
    );
    await tick();
    expect(active).toBe(2);
    expect(order).toEqual([0, 1]);
    gates[1]!.resolve();
    await tick();
    expect(order).toEqual([0, 1, 2]);
    for (const g of gates) g.resolve();
    await Promise.all(runs);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it('releases the permit when the task throws, and double release is harmless', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    const release = await sem.acquire();
    release();
    release(); // idempotent: must not create a second permit
    const r1 = await sem.acquire();
    let second = false;
    void sem.acquire().then((r) => {
      second = true;
      r();
    });
    await tick();
    expect(second).toBe(false);
    r1();
    await tick();
    expect(second).toBe(true);
  });

  it('abort removes a waiter without leaking its permit', async () => {
    const sem = new Semaphore(1);
    const held = await sem.acquire();
    const ac = new AbortController();
    const waiting = sem.acquire(ac.signal);
    ac.abort(new Error('stop'));
    await expect(waiting).rejects.toThrow('stop');
    held();
    const again = await sem.acquire();
    again();
    const pre = new AbortController();
    pre.abort(new Error('already'));
    await expect(sem.acquire(pre.signal)).rejects.toThrow('already');
  });
});

describe('KeyedLimiter', () => {
  it('limits concurrency per key independently', async () => {
    const limiter = new KeyedLimiter((key) => (key === 'slow.example' ? 1 : 2));
    const active = new Map<string, number>();
    const peak = new Map<string, number>();
    const task = (key: string) =>
      limiter.run(key, async () => {
        active.set(key, (active.get(key) ?? 0) + 1);
        peak.set(key, Math.max(peak.get(key) ?? 0, active.get(key)!));
        await sleep(5);
        active.set(key, active.get(key)! - 1);
      });
    await Promise.all([...Array.from({ length: 4 }, () => task('slow.example')), ...Array.from({ length: 6 }, () => task('fast.example'))]);
    expect(peak.get('slow.example')).toBe(1);
    expect(peak.get('fast.example')).toBe(2);
  });
});

describe('mapBounded', () => {
  it('defaults to three workers per the spec', () => {
    expect(DEFAULT_WORKERS).toBe(3);
  });

  it('never exceeds the worker count and preserves input order', async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 25 }, (_, i) => i);
    const results = await mapBounded(items, 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await sleep((n * 7) % 5);
      active--;
      return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBe(3);
    expect(results).toEqual(items.map((n) => ({ ok: true, value: n * 2 })));
  });

  it('captures failures per item without aborting independent items', async () => {
    const results = await mapBounded([1, 2, 3, 4], 2, async (n) => {
      if (n % 2 === 0) throw new Error(`bad ${n}`);
      return n;
    });
    expect(results.map((r) => r.ok)).toEqual([true, false, true, false]);
    expect((results[1] as { error: Error }).error.message).toBe('bad 2');
  });

  it('stops starting new items after abort; unstarted items are reported as cancelled', async () => {
    const ac = new AbortController();
    const started: number[] = [];
    const results = await mapBounded(
      Array.from({ length: 10 }, (_, i) => i),
      2,
      async (n) => {
        started.push(n);
        if (n === 1) ac.abort(new Error('user cancelled'));
        await sleep(1);
        return n;
      },
      ac.signal,
    );
    expect(started.length).toBeLessThan(10);
    expect(results).toHaveLength(10);
    const cancelled = results.filter((r) => !r.ok);
    expect(cancelled.length).toBe(10 - started.length);
    for (const r of cancelled) expect((r as { error: Error }).error.message).toBe('user cancelled');
  });

  it('handles empty input and degenerate worker counts (never zero workers)', async () => {
    expect(await mapBounded([], 3, async () => 1)).toEqual([]);
    expect(await mapBounded([1, 2], 0, async (n) => n)).toEqual([{ ok: true, value: 1 }, { ok: true, value: 2 }]);
    expect(await mapBounded([1, 2], Number.NaN, async (n) => n)).toEqual([{ ok: true, value: 1 }, { ok: true, value: 2 }]);
    let active = 0;
    let peak = 0;
    await mapBounded([1, 2, 3, 4], 2.9, async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(2);
      active--;
    });
    expect(peak).toBe(2);
  });
});

describe('sleep / withTimeout', () => {
  it('sleep rejects promptly when aborted', async () => {
    const ac = new AbortController();
    const p = sleep(10_000, ac.signal);
    ac.abort(new Error('abort sleep'));
    await expect(p).rejects.toThrow('abort sleep');
  });

  it('withTimeout rejects with a TIMEOUT code and passes through fast results', async () => {
    await expect(withTimeout(sleep(1_000), 10, 'slow op')).rejects.toMatchObject({ code: 'TIMEOUT', message: 'slow op timed out after 10ms' });
    await expect(withTimeout(Promise.resolve(42), 1_000)).resolves.toBe(42);
  });
});
