/**
 * SYNTHETIC TEST FIXTURE: a three-stage workflow shared by the crash worker
 * (child process) and the crash-recovery test (parent process). Stage
 * versions and inputs are identical in both, so checkpoints written by the
 * crashed child are reusable by the resuming parent.
 */
import { z } from 'zod';
import { NO_RETRY } from '../../../src/core/retry.js';
import type { EngineStage } from '../../../src/workflows/stage.js';

export function crashStages(opts: { onStage: (name: string) => void; crashIn?: string; crash?: () => void; paidStage?: string }): EngineStage[] {
  const mk = (name: string, next: string, prerequisites: string[], compute: (prior: Record<string, unknown>) => number): EngineStage => ({
    name,
    version: '1',
    description: `synthetic ${name}`,
    input: z.object({ topic: z.string() }),
    output: z.object({ value: z.number() }),
    prerequisites,
    evidence: { requirement: 'none (synthetic)' },
    timeoutMs: 10_000,
    retry: NO_RETRY,
    // Synthetic allowance only; the fixture never reserves or spends anything.
    costAllowance: opts.paidStage === name ? [{ provider: 'dataforseo', maxMicros: 50_000 }] : 'none',
    stoppingConditions: [],
    next: [next],
    buildInput: (_ctx, params) => ({ topic: String(params.topic ?? 'synthetic') }),
    run: async (_input, ctx) => {
      opts.onStage(name);
      if (opts.crashIn === name) {
        opts.crash?.();
        await new Promise((r) => setTimeout(r, 5_000)); // never reached after SIGKILL
      }
      return { value: compute(ctx.prior) };
    },
  });
  return [
    mk('research', 'analysis', [], () => 5),
    mk('analysis', 'brief', ['research'], (p) => (p.research as { value: number }).value * 2),
    mk('brief', 'done', ['analysis'], (p) => (p.analysis as { value: number }).value + 1),
  ];
}
