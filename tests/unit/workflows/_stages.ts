/**
 * Test helpers for building synthetic workflow stages (no real providers).
 */
import { z } from 'zod';
import { NO_RETRY } from '../../../src/core/retry.js';
import type { EngineStage } from '../../../src/workflows/stage.js';

export const valueOut = z.object({ value: z.number() });

export function stage(name: string, overrides: Partial<EngineStage> = {}): EngineStage {
  return {
    name,
    version: '1',
    description: `synthetic stage ${name}`,
    input: z.object({}).passthrough(),
    output: valueOut,
    prerequisites: [],
    evidence: { requirement: 'none' },
    timeoutMs: 2_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    stoppingConditions: [],
    next: ['done'],
    buildInput: () => ({}),
    run: async () => ({ value: 1 }),
    ...overrides,
  };
}

/** Wire `next` so each stage points at the following one and the last one at 'done' (plus extra states). */
export function chain(stages: EngineStage[], extraNext: string[] = []): EngineStage[] {
  return stages.map((s, i) => ({ ...s, next: [...(i + 1 < stages.length ? [stages[i + 1]!.name] : ['done']), ...extraNext, ...s.next.filter((n) => n !== 'done')] }));
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
