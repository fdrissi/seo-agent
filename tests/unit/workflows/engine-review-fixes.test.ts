import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../../src/core/errors.js';
import { toMicros } from '../../../src/core/money.js';
import { CircuitBreakers } from '../../../src/jobs/circuit-breaker.js';
import { enqueue } from '../../../src/jobs/store.js';
import { StageBudgetGuard } from '../../../src/workflows/budget-guard.js';
import { runSequential, validateWorkflow } from '../../../src/workflows/engine.js';
import { isCheckpointReviewed, recordStageReview } from '../../../src/workflows/reviews.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { chain, stage } from './_stages.js';

/**
 * Regression tests for review findings on the workflow engine: aborted stages
 * are awaited before retries, required stages never silently "succeed" when a
 * failed prerequisite stopped them, breaker refusals carry the next probe time,
 * checkpoint errors are redacted, recorded reviews let a needs_review stop
 * continue, and unknown-price reservations are never counted as $0.
 */
describe('workflow engine: review fixes', () => {
  let ctx: TestContext;
  let jobId: string;
  beforeEach(() => {
    ctx = createTestContext();
    jobId = enqueue(ctx, 'test-workflow', {}).id;
  });
  afterEach(() => ctx.cleanup());

  it('a timed-out attempt is awaited (within the grace period) before the retry starts: attempts never overlap', async () => {
    let running = 0;
    let maxRunning = 0;
    let calls = 0;
    const slowThenOk = stage('fetch', {
      idempotent: true,
      timeoutMs: 20,
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 },
      run: async () => {
        calls++;
        running++;
        maxRunning = Math.max(maxRunning, running);
        try {
          // Attempt 1 ignores its signal and finishes 120 ms later; attempt 2 is fast.
          if (calls === 1) await new Promise((r) => setTimeout(r, 120));
          if (calls === 1) throw new AppError('PROVIDER_ERROR', 'late failure after timeout');
          return { value: calls };
        } finally {
          running--;
        }
      },
    });
    const r = await runSequential(ctx, 'wf', chain([slowThenOk]), {}, { jobId, abortGraceMs: 2_000, sleep: async () => {} });
    expect(r.status).toBe('succeeded');
    expect(calls).toBe(2);
    expect(maxRunning).toBe(1);
    expect(r.orphaned).toEqual([]);
  });

  it('a timed-out attempt that does not stop within the grace period is not retried and is handed to the lock holder', async () => {
    let calls = 0;
    const handed: Array<Promise<unknown>> = [];
    const stuck = stage('stuck', {
      idempotent: true,
      timeoutMs: 20,
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 },
      run: () => {
        calls++;
        return new Promise(() => undefined);
      },
    });
    const r = await runSequential(ctx, 'wf', chain([stuck]), {}, { jobId, abortGraceMs: 30, sleep: async () => {}, onOrphanedStage: (w) => handed.push(w) });
    expect(calls).toBe(1);
    expect(r.failure).toMatchObject({ code: 'TIMEOUT', retryable: false });
    expect(handed).toHaveLength(1);
  });

  it('a required stage whose prerequisite FAILED stops the workflow blocked instead of reporting success', async () => {
    let reportRan = false;
    const stages = chain([
      stage('crawl'),
      stage('serp', { optional: true, run: async () => Promise.reject(new AppError('PROVIDER_ERROR', 'synthetic outage')) }),
      stage('report', { prerequisites: ['crawl', 'serp'], run: async () => ((reportRan = true), { value: 3 }) }),
    ]);
    expect(validateWorkflow(stages).warnings.join()).toMatch(/required stage depends on optional stage "serp"/);
    const r = await runSequential(ctx, 'wf', stages, {}, { jobId });
    expect(reportRan).toBe(false);
    expect(r.status).toBe('stopped');
    expect(r.stoppedBy).toMatchObject({ stage: 'report', code: 'PREREQUISITE_UNSATISFIED', decision: { status: 'blocked' } });
    expect(r.stoppedBy!.decision.reason).toMatch(/serp \(PROVIDER_ERROR\)/);

    // An OPTIONAL dependent degrades instead.
    const job2 = enqueue(ctx, 'test-workflow', {}).id;
    const soft = chain([stages[0]!, stages[1]!, { ...stages[2]!, optional: true }]);
    const r2 = await runSequential(ctx, 'wf', soft, {}, { jobId: job2 });
    expect(r2.status).toBe('succeeded');
    expect(r2.degraded.map((d) => [d.stage, d.code])).toEqual([
      ['serp', 'PROVIDER_ERROR'],
      ['report', 'PREREQUISITE_UNSATISFIED'],
    ]);
    expect(r2.skippedRequired).toEqual([]);
  });

  it('a required stage refused by an open breaker fails retryable with retryAfter = the next probe time', async () => {
    const breakers = new CircuitBreakers(ctx.db, ctx.siteId, ctx.clock, { failureThreshold: 1, cooldownMs: 15 * 60_000 });
    breakers.recordFailure('apify', new AppError('PROVIDER_ERROR', 'synthetic'));
    const nextProbe = breakers.get('apify').nextProbeAt;
    expect(nextProbe).toBe('2026-09-24T09:15:00.000Z');
    const r = await runSequential(ctx, 'wf', chain([stage('reddit', { providers: ['apify'] })]), {}, { jobId, breakers });
    expect(r.failure).toMatchObject({ code: 'INTEGRATION_UNAVAILABLE', retryable: true, retryAfter: nextProbe });
  });

  it('checkpoint error records are redacted whatever built them (evidence problems, validation issues)', async () => {
    const secret = 'sk-live-THISISNOTAREALKEY1234567890';
    const stages = chain([
      stage('recommend', {
        evidence: { requirement: 'synthetic', check: () => [`upstream echoed Authorization: Bearer ${secret}`] },
      }),
    ]);
    const r = await runSequential(ctx, 'wf', stages, {}, { jobId });
    expect(r.stoppedBy?.code).toBe('EVIDENCE_INSUFFICIENT');
    const rows = ctx.db.all<{ error_json: string }>('SELECT error_json FROM checkpoints WHERE job_id = ? AND error_json IS NOT NULL', [jobId]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.error_json).not.toContain(secret);
      expect(row.error_json).toContain('[REDACTED]');
    }
  });

  it('a recorded review of the exact stopped checkpoint lets a resumed run continue past needs_review', async () => {
    let publishRuns = 0;
    const stages = chain(
      [
        stage('draft', {
          buildInput: (_c, p) => ({ topic: typeof p.topic === 'string' ? p.topic : 'synthetic default' }),
          stoppingConditions: ['always needs review'],
          shouldStop: () => ({ stop: true, reason: 'human review', status: 'needs_review' }),
        }),
        stage('publish_prep', { prerequisites: ['draft'], run: async () => ((publishRuns++), { value: 2 }) }),
      ],
      ['needs_review'],
    );
    const r1 = await runSequential(ctx, 'wf', stages, {}, { jobId });
    expect(r1.status).toBe('stopped');
    const r2 = await runSequential(ctx, 'wf', stages, {}, { jobId });
    expect(r2.status).toBe('stopped'); // a plain resume stops at the same review again
    expect(publishRuns).toBe(0);

    const review = recordStageReview(ctx.db, ctx.clock, { siteId: ctx.siteId, jobId, stage: 'draft', reviewer: 'owner:synthetic-reviewer' });
    expect(isCheckpointReviewed(ctx.db, ctx.siteId, review.checkpointId)).toBe(true);
    const r3 = await runSequential(ctx, 'wf', stages, {}, { jobId });
    expect(r3.status).toBe('succeeded');
    expect(publishRuns).toBe(1);
    expect(r3.stages.map((s) => [s.stage, s.status, s.resumedFromCheckpoint])).toEqual([
      ['draft', 'succeeded', true],
      ['publish_prep', 'succeeded', false],
    ]);
    expect(r3.warnings.join()).toMatch(/human review recorded/);

    // The review applies to that checkpoint only: a changed input produces a new output that needs its own review.
    const r4 = await runSequential(ctx, 'wf', stages, { topic: 'changed' }, { jobId });
    expect(r4.status).toBe('stopped');
    expect(() => recordStageReview(ctx.db, ctx.clock, { siteId: ctx.siteId, jobId, stage: 'nope', reviewer: 'cli' })).toThrow(/no checkpointed output/);
  });

  it('unknown-price reservations are counted separately (never $0) and make later reservations need approval', async () => {
    const guard = new StageBudgetGuard(ctx.budgets, ctx.siteId, jobId, 'serp', [{ provider: 'dataforseo', maxMicros: toMicros('0.10') }]);
    const unknown = { upperBoundMicros: null, basis: { source: 'unknown' as const, detail: 'synthetic: price not verified' } };
    const known = { upperBoundMicros: toMicros('0.02'), basis: { source: 'verified_config' as const, detail: 'synthetic price' } };
    expect(() => guard.reserve({ provider: 'dataforseo', purpose: 'no approval', estimate: unknown })).toThrow(/no safe upper bound/);
    guard.reserve({ provider: 'dataforseo', purpose: 'approved unknown', estimate: unknown, unknownPriceApprovalId: 'appr_synthetic' });
    expect(guard.unknownPriceReservations('dataforseo')).toBe(1);
    expect(guard.reservedMicros('dataforseo')).toBe(0);
    // The stage cap can no longer be verified: a further reservation needs explicit approval too.
    expect(() => guard.reserve({ provider: 'dataforseo', purpose: 'second', estimate: known })).toThrow(/can no longer be verified/);
    guard.reserve({ provider: 'dataforseo', purpose: 'second approved', estimate: known, unknownPriceApprovalId: 'appr_synthetic_2' });
    expect(guard.reservedMicros('dataforseo')).toBe(toMicros('0.02'));
    expect(guard.unknownPriceReservations('dataforseo')).toBe(1);
  });
});
