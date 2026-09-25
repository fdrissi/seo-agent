import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError, isAppError } from '../../../src/core/errors.js';
import { toMicros } from '../../../src/core/money.js';
import { CircuitBreakers } from '../../../src/jobs/circuit-breaker.js';
import { enqueue } from '../../../src/jobs/store.js';
import { narrowAllowance, runSequential, validateWorkflow } from '../../../src/workflows/engine.js';
import { paidWorkSkippedReason, stageMayPay, toolsOf, type PaidWorkSkipped } from '../../../src/workflows/stage.js';
import type { StageContext } from '../../../src/workflows/types.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import { chain, stage } from './_stages.js';

/**
 * B5-02: a stage whose paid work is optional (a cheap-model hook, a model
 * summary, embeddings) must never be blocked by an exhausted budget or an
 * unavailable paid provider: the engine runs it WITHOUT an allowance and
 * records a degraded entry. `effectiveAllowance` narrows the declared
 * allowance to what the run can actually use. Everything is synthetic.
 */

const LLM_CAP = toMicros('0.10');
const estimate = (usd: string) => ({ upperBoundMicros: toMicros(usd), basis: { source: 'verified_config' as const, detail: 'synthetic test price' } });

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

/** A context whose LLM Gateway month is already fully committed (synthetic prior spend). */
function exhaustedLlmContext(): TestContext {
  const c = createTestContext({ config: testSiteConfig({ budgets: { llmGateway: { monthlyUsd: '0.20', perRunUsd: '0.20' } } } as never) });
  const r = c.budgets.reserve({ siteId: c.siteId, provider: 'llm_gateway', runId: 'synthetic-earlier-run', purpose: 'synthetic prior spend (test)', estimate: estimate('0.20') });
  c.budgets.reconcile(r.id, { actualMicros: toMicros('0.20'), source: 'manual' });
  return c;
}

interface Seen {
  mayPay: boolean;
  skipped: PaidWorkSkipped | null;
  caps: Record<string, number>;
  reserveError: string | null;
}

/** A stage with an optional paid LLM hook: it pays only when it holds an allowance. */
function hookStage(seen: Seen[], overrides: Parameters<typeof stage>[1] = {}) {
  return stage('route', {
    costAllowance: [{ provider: 'llm_gateway', maxMicros: LLM_CAP }],
    paidWorkOptional: true,
    run: async (_i, c: StageContext) => {
      let reserveError: string | null = null;
      try {
        // A stage that ignores stageMayPay is still refused by the guard: no paid call is possible.
        toolsOf(c).budget.reserve({ provider: 'llm_gateway', purpose: 'synthetic hook call', estimate: estimate('0.01') });
      } catch (err) {
        reserveError = isAppError(err) ? err.code : String(err);
      }
      seen.push({ mayPay: stageMayPay(c, 'llm_gateway'), skipped: paidWorkSkippedReason(c), caps: { ...toolsOf(c).budget.caps }, reserveError });
      return { value: 7 };
    },
    ...overrides,
  });
}

describe('engine: paidWorkOptional', () => {
  it('an exhausted budget runs a REQUIRED stage without its paid work (degraded), instead of stopping the workflow blocked', async () => {
    ctx = exhaustedLlmContext();
    const jobId = enqueue(ctx, 'test-workflow', {}).id;
    const seen: Seen[] = [];
    const r = await runSequential(ctx, 'wf', chain([hookStage(seen), stage('report', { prerequisites: ['route'] })]), {}, { jobId });
    expect(r.status).toBe('succeeded');
    expect(r.stoppedBy).toBeUndefined();
    expect(r.outputs).toEqual({ route: { value: 7 }, report: { value: 1 } });
    expect(seen).toEqual([{ mayPay: false, skipped: { code: 'BUDGET_EXCEEDED', reason: expect.stringMatching(/llm_gateway budget exhausted \(site_service_month/) }, caps: {}, reserveError: 'POLICY_DENIED' }]);
    expect(r.degraded).toEqual([expect.objectContaining({ stage: 'route', code: 'BUDGET_EXCEEDED', reason: expect.stringMatching(/ran without its optional paid work/) })]);
    // It ran: degraded, never counted as a skipped required stage.
    expect(r.skippedRequired).toEqual([]);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM budget_reservations WHERE site_id = ? AND run_id = ?", [ctx.siteId, jobId])!.n).toBe(0);
    // No in-flight marker: a stage without an allowance cannot spend, so a resume never needs --rerun-paid-stages for it.
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM checkpoints WHERE job_id = ? AND error_json LIKE '%IN_FLIGHT%'", [jobId])!.n).toBe(0);
  });

  it('with budget available the stage keeps its allowance and may pay; without the flag an exhausted budget still blocks', async () => {
    ctx = createTestContext();
    const jobId = enqueue(ctx, 'test-workflow', {}).id;
    const seen: Seen[] = [];
    const r = await runSequential(ctx, 'wf', chain([hookStage(seen)]), {}, { jobId });
    expect(r.status).toBe('succeeded');
    expect(r.degraded).toEqual([]);
    expect(seen[0]).toMatchObject({ mayPay: true, skipped: null, caps: { llm_gateway: LLM_CAP }, reserveError: null });

    const tight = exhaustedLlmContext();
    try {
      const job2 = enqueue(tight, 'test-workflow', {}).id;
      const r2 = await runSequential(tight, 'wf', chain([hookStage([], { paidWorkOptional: false }), stage('report')]), {}, { jobId: job2 });
      expect(r2.status).toBe('stopped');
      expect(r2.stoppedBy).toMatchObject({ stage: 'route', code: 'BUDGET_EXCEEDED' });
    } finally {
      tight.cleanup();
    }
  });

  it('an optional paidWorkOptional stage runs without paid work instead of being skipped', async () => {
    ctx = exhaustedLlmContext();
    const jobId = enqueue(ctx, 'test-workflow', {}).id;
    const seen: Seen[] = [];
    const r = await runSequential(ctx, 'wf', chain([hookStage(seen, { optional: true })]), {}, { jobId });
    expect(r.outputs.route).toEqual({ value: 7 });
    expect(seen[0]!.mayPay).toBe(false);
    expect(r.degraded[0]).toMatchObject({ stage: 'route', code: 'BUDGET_EXCEEDED' });
  });

  it('an open breaker of a provider that only the paid work needs does not block the stage; other providers still do', async () => {
    ctx = createTestContext();
    const breakers = new CircuitBreakers(ctx.db, ctx.siteId, ctx.clock, { failureThreshold: 1, cooldownMs: 60_000 });
    breakers.recordFailure('llm_gateway', new AppError('PROVIDER_ERROR', 'HTTP 503 (synthetic)'));
    const jobId = enqueue(ctx, 'test-workflow', {}).id;
    const seen: Seen[] = [];
    const r = await runSequential(ctx, 'wf', chain([hookStage(seen, { providers: ['llm_gateway'] }), stage('report')]), {}, { jobId, breakers });
    expect(r.status).toBe('succeeded');
    expect(seen[0]).toMatchObject({ mayPay: false, skipped: { code: 'INTEGRATION_UNAVAILABLE' }, caps: {} });
    expect(r.degraded[0]).toMatchObject({ stage: 'route', code: 'INTEGRATION_UNAVAILABLE' });

    breakers.recordFailure('google', new AppError('PROVIDER_ERROR', 'HTTP 503 (synthetic)'));
    const job2 = enqueue(ctx, 'test-workflow', {}).id;
    const r2 = await runSequential(ctx, 'wf', chain([hookStage([], { providers: ['google', 'llm_gateway'] }), stage('report')]), {}, { jobId: job2, breakers });
    expect(r2.status).toBe('failed');
    expect(r2.failure).toMatchObject({ stage: 'route', code: 'INTEGRATION_UNAVAILABLE', retryable: true });
  });
});

describe('engine: effectiveAllowance', () => {
  it('narrows the declared allowance to what this run can use; a stage that needs none is never blocked or skipped', async () => {
    ctx = exhaustedLlmContext();
    const jobId = enqueue(ctx, 'test-workflow', {}).id;
    const seen: Seen[] = [];
    const report = hookStage(seen, {
      paidWorkOptional: false,
      input: z.object({ llmSummary: z.boolean() }),
      buildInput: () => ({ llmSummary: false }),
      effectiveAllowance: (input: { llmSummary: boolean }) => (input.llmSummary ? [{ provider: 'llm_gateway' as const, maxMicros: LLM_CAP }] : 'none'),
    });
    const r = await runSequential(ctx, 'wf', chain([report]), {}, { jobId });
    expect(r.status).toBe('succeeded');
    expect(r.degraded).toEqual([]);
    expect(seen[0]).toMatchObject({ mayPay: false, skipped: null, caps: {}, reserveError: 'POLICY_DENIED' });

    // A dry run never skips a stage whose effective allowance is none.
    const dry = createTestContext({ dryRun: true });
    try {
      const job2 = enqueue(dry, 'test-workflow', {}).id;
      const r2 = await runSequential(dry, 'wf', chain([hookStage([], { effectiveAllowance: () => 'none' })]), {}, { jobId: job2 });
      expect(r2.outputs.route).toEqual({ value: 7 });
      expect(r2.degraded).toEqual([]);
    } finally {
      dry.cleanup();
    }
  });

  it('can only reduce the declared caps', async () => {
    ctx = createTestContext();
    const jobId = enqueue(ctx, 'test-workflow', {}).id;
    const seen: Seen[] = [];
    const s = hookStage(seen, { effectiveAllowance: () => [{ provider: 'llm_gateway', maxMicros: LLM_CAP * 5 }, { provider: 'dataforseo', maxMicros: 1_000 }] });
    await runSequential(ctx, 'wf', chain([s]), {}, { jobId });
    expect(seen[0]!.caps).toEqual({ llm_gateway: LLM_CAP });

    expect(narrowAllowance([{ provider: 'llm_gateway', maxMicros: 100 }], [{ provider: 'llm_gateway', maxMicros: 40 }])).toEqual([{ provider: 'llm_gateway', maxMicros: 40 }]);
    expect(narrowAllowance([{ provider: 'llm_gateway', maxMicros: 100 }], [{ provider: 'llm_gateway', maxMicros: 0 }])).toBe('none');
    expect(narrowAllowance([{ provider: 'llm_gateway', maxMicros: 100 }], [{ provider: 'apify', maxMicros: 40 }])).toBe('none');
    expect(narrowAllowance('none', [{ provider: 'llm_gateway', maxMicros: 40 }])).toBe('none');
    expect(narrowAllowance([{ provider: 'llm_gateway', maxMicros: 100 }], 'none')).toBe('none');
    expect(validateWorkflow(chain([s])).errors).toEqual([]);
  });

  it('a failing effectiveAllowance keeps the declared allowance (every gate still applies) and warns', async () => {
    ctx = exhaustedLlmContext();
    const jobId = enqueue(ctx, 'test-workflow', {}).id;
    const s = hookStage([], {
      paidWorkOptional: false,
      effectiveAllowance: () => {
        throw new Error('synthetic failure');
      },
    });
    const r = await runSequential(ctx, 'wf', chain([s]), {}, { jobId });
    expect(r.status).toBe('stopped');
    expect(r.stoppedBy).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(r.warnings.join(' ')).toMatch(/effectiveAllowance failed \(synthetic failure\)/);
  });
});
