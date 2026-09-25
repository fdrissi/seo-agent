import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError, ValidationError } from '../../../src/core/errors.js';
import { DEFAULT_RETRY, NO_RETRY } from '../../../src/core/retry.js';
import { toMicros } from '../../../src/core/money.js';
import { enqueue } from '../../../src/jobs/store.js';
import { CircuitBreakers } from '../../../src/jobs/circuit-breaker.js';
import { effectiveRetryPolicy, runSequential, validateWorkflow } from '../../../src/workflows/engine.js';
import { toolsOf } from '../../../src/workflows/stage.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import { chain, stage } from './_stages.js';

const noSleep = async () => {};

describe('workflow engine: sequential', () => {
  let ctx: TestContext;
  let jobId: string;
  beforeEach(() => {
    ctx = createTestContext();
    jobId = enqueue(ctx, 'test-workflow', {}).id;
  });
  afterEach(() => ctx.cleanup());

  it('runs stages in order, passes validated prior outputs, and checkpoints each result', async () => {
    const seen: unknown[] = [];
    const stages = chain([
      stage('collect', { run: async () => ({ value: 2 }) }),
      stage('analyze', {
        prerequisites: ['collect'],
        input: z.object({ base: z.number() }),
        buildInput: (c) => ({ base: (c.prior.collect as { value: number }).value }),
        run: async (input: { base: number }, c) => {
          seen.push(c.prior);
          return { value: input.base * 10 };
        },
      }),
    ]);
    const r = await runSequential(ctx, 'wf', stages, {}, { jobId });
    expect(r.status).toBe('succeeded');
    expect(r.outputs).toEqual({ collect: { value: 2 }, analyze: { value: 20 } });
    expect(seen).toEqual([{ collect: { value: 2 } }]);
    const rows = ctx.db.all<{ stage: string; status: string; stage_version: string; input_hash: string | null; output_json: string; site_id: string }>(
      'SELECT stage, status, stage_version, input_hash, output_json, site_id FROM checkpoints WHERE job_id = ? ORDER BY rowid',
      [jobId],
    );
    expect(rows.map((x) => [x.stage, x.status, x.stage_version])).toEqual([
      ['collect', 'succeeded', '1'],
      ['analyze', 'succeeded', '1'],
    ]);
    expect(rows.every((x) => x.input_hash && x.site_id === 'test-site')).toBe(true);
    expect(JSON.parse(rows[1]!.output_json)).toEqual({ value: 20 });
  });

  it('input schema validation failure stops the chain; later stages never run', async () => {
    let thirdRan = false;
    const stages = chain([
      stage('a'),
      stage('b', { prerequisites: ['a'], input: z.object({ url: z.url() }), buildInput: () => ({ url: 'not a url' }) }),
      stage('c', { prerequisites: ['b'], run: async () => ((thirdRan = true), { value: 3 }) }),
    ]);
    const r = await runSequential(ctx, 'wf', stages, {}, { jobId });
    expect(r.status).toBe('failed');
    expect(r.failure).toMatchObject({ stage: 'b', code: 'VALIDATION_FAILED', retryable: false });
    expect(r.stages.map((s) => [s.stage, s.status])).toEqual([
      ['a', 'succeeded'],
      ['b', 'failed'],
      ['c', 'skipped'],
    ]);
    expect(r.stages[2]!.error?.code).toBe('NOT_REACHED');
    expect(thirdRan).toBe(false);
  });

  it('output schema validation failure fails the stage without retrying, even when idempotent', async () => {
    let calls = 0;
    const stages = chain([
      stage('bad', {
        idempotent: true,
        retry: { ...DEFAULT_RETRY, maxAttempts: 3 },
        run: async () => {
          calls++;
          return { value: 'not a number' } as never;
        },
      }),
      stage('after'),
    ]);
    const r = await runSequential(ctx, 'wf', stages, {}, { jobId, sleep: noSleep });
    expect(calls).toBe(1);
    expect(r.status).toBe('failed');
    expect(r.failure?.code).toBe('VALIDATION_FAILED');
    expect(r.stages[1]!.status).toBe('skipped');
  });

  it('rejects invalid workflow definitions (next states, prerequisite order, terminal state)', async () => {
    const bad = [stage('a', { next: ['somewhere'] }), stage('b', { prerequisites: ['c'], next: ['c'] }), stage('c', { next: ['b'] })];
    const v = validateWorkflow(bad);
    expect(v.errors.join('\n')).toMatch(/does not include the following stage "b"/);
    expect(v.errors.join('\n')).toMatch(/prerequisite "c" must be an earlier stage/);
    expect(v.errors.join('\n')).toMatch(/last stage must list a terminal state/);
    await expect(runSequential(ctx, 'wf', bad, {}, { jobId })).rejects.toBeInstanceOf(ValidationError);
    expect(validateWorkflow([stage('x', { name: 'x' }), stage('x')]).errors.join()).toMatch(/duplicate stage name/);
  });

  it('refuses to run without a durable job row for the site', async () => {
    await expect(runSequential(ctx, 'wf', [stage('a')], {}, { jobId: 'job_missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('enforces the per-stage timeout with an AbortSignal', async () => {
    let signalSeen: AbortSignal | undefined;
    const stages = chain([
      stage('slow', {
        timeoutMs: 30,
        run: (_i, c) => {
          signalSeen = c.signal;
          return new Promise(() => undefined); // never settles (ignores the signal)
        },
      }),
      stage('next'),
    ]);
    const started = Date.now();
    const orphans: Array<{ stage: string; attempt: number }> = [];
    const r = await runSequential(ctx, 'wf', stages, {}, { jobId, abortGraceMs: 50, onOrphanedStage: (_w, info) => orphans.push(info) });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(r.status).toBe('failed');
    expect(r.failure?.code).toBe('TIMEOUT');
    expect(r.failure?.retryable).toBe(false); // still running in the background: a retry would overlap it
    expect(r.failure?.message).toMatch(/did not stop within 50ms/);
    expect(signalSeen?.aborted).toBe(true);
    expect(r.orphaned).toEqual([{ stage: 'slow', attempt: 1 }]);
    expect(orphans).toEqual([{ stage: 'slow', attempt: 1 }]);
    const cp = ctx.db.get<{ status: string; error_json: string }>("SELECT status, error_json FROM checkpoints WHERE job_id = ? AND stage = 'slow'", [jobId]);
    expect(cp?.status).toBe('failed');
    expect(JSON.parse(cp!.error_json).code).toBe('TIMEOUT');
  });

  it('retries only idempotent, non-paid stages and respects the attempt limit', async () => {
    let calls = 0;
    const flaky = stage('flaky', {
      idempotent: true,
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, jitter: 0 },
      run: async () => {
        calls++;
        throw new AppError('PROVIDER_ERROR', `transient ${calls}`);
      },
    });
    const r = await runSequential(ctx, 'wf', chain([flaky]), {}, { jobId, sleep: noSleep });
    expect(calls).toBe(3);
    expect(r.status).toBe('failed');
    expect(r.failure).toMatchObject({ code: 'PROVIDER_ERROR', retryable: true });
    const attempts = ctx.db.all<{ attempt: number }>("SELECT attempt FROM checkpoints WHERE job_id = ? AND stage = 'flaky' ORDER BY rowid", [jobId]);
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);

    // Non-idempotent: one attempt.
    calls = 0;
    const job2 = enqueue(ctx, 'test-workflow', {}).id;
    const r2 = await runSequential(ctx, 'wf', chain([{ ...flaky, idempotent: false }]), {}, { jobId: job2, sleep: noSleep });
    expect(calls).toBe(1);
    expect(r2.failure?.retryable).toBe(false);

    // Paid stage: NO_RETRY regardless of its declared policy.
    const paid = { ...flaky, costAllowance: [{ provider: 'dataforseo' as const, maxMicros: toMicros('0.10') }] };
    expect(effectiveRetryPolicy(paid)).toEqual(NO_RETRY);
    calls = 0;
    const job3 = enqueue(ctx, 'test-workflow', {}).id;
    const r3 = await runSequential(ctx, 'wf', chain([paid]), {}, { jobId: job3, sleep: noSleep });
    expect(calls).toBe(1);
    expect(r3.failure?.retryable).toBe(false);
    expect(validateWorkflow([paid]).warnings.join()).toMatch(/paid stages always run with NO_RETRY/);
  });

  it('succeeds on a later attempt and does not retry non-transient errors', async () => {
    let calls = 0;
    const s = stage('eventually', {
      idempotent: true,
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 },
      run: async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        return { value: calls };
      },
    });
    const r = await runSequential(ctx, 'wf', chain([s]), {}, { jobId, sleep: noSleep });
    expect(r.status).toBe('succeeded');
    expect(r.outputs.eventually).toEqual({ value: 2 });

    let calls2 = 0;
    const job2 = enqueue(ctx, 'test-workflow', {}).id;
    const denied = stage('denied', {
      idempotent: true,
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 },
      run: async () => {
        calls2++;
        throw new AppError('CREDENTIALS_MISSING', 'no key');
      },
    });
    const r2 = await runSequential(ctx, 'wf', chain([denied]), {}, { jobId: job2, sleep: noSleep });
    expect(calls2).toBe(1);
    expect(r2.failure).toMatchObject({ code: 'CREDENTIALS_MISSING', retryable: false });
  });

  it('stopping conditions stop the workflow with a declared terminal state', async () => {
    let after = false;
    const stages = chain(
      [
        stage('decide', {
          stoppingConditions: ['no page qualifies'],
          shouldStop: (o: { value: number }) => (o.value === 0 ? { stop: true, reason: 'nothing to do this week', status: 'no_action' } : { stop: false }),
          run: async () => ({ value: 0 }),
        }),
        stage('act', { run: async () => ((after = true), { value: 1 }) }),
      ],
      ['no_action'],
    );
    const r = await runSequential(ctx, 'wf', stages, {}, { jobId });
    expect(r.status).toBe('stopped');
    expect(r.stoppedBy).toMatchObject({ stage: 'decide', decision: { status: 'no_action', reason: 'nothing to do this week' } });
    expect(after).toBe(false);
    expect(ctx.db.get<{ status: string }>("SELECT status FROM checkpoints WHERE job_id = ? AND stage = 'decide'", [jobId])?.status).toBe('stopped');
  });

  it('a stop decision outside the declared next states is an invalid transition', async () => {
    const stages = chain([
      stage('decide', {
        stoppingConditions: ['x'],
        shouldStop: () => ({ stop: true, reason: 'x', status: 'needs_review' }),
      }),
      stage('act'),
    ]);
    const r = await runSequential(ctx, 'wf', stages, {}, { jobId });
    expect(r.status).toBe('failed');
    expect(r.failure?.code).toBe('INVALID_TRANSITION');
  });

  it('evidence requirements block a required stage and degrade an optional one', async () => {
    const needsEvidence = stage('recommend', {
      input: z.object({ sources: z.array(z.string()) }),
      buildInput: () => ({ sources: [] }),
      evidence: { requirement: 'at least one first-party source', check: (i: { sources: string[] }) => (i.sources.length ? [] : ['no sources']) },
    });
    const r = await runSequential(ctx, 'wf', chain([needsEvidence, stage('report')]), {}, { jobId });
    expect(r.status).toBe('stopped');
    expect(r.stoppedBy).toMatchObject({ stage: 'recommend', code: 'EVIDENCE_INSUFFICIENT', decision: { status: 'blocked' } });

    const job2 = enqueue(ctx, 'test-workflow', {}).id;
    const r2 = await runSequential(ctx, 'wf', chain([{ ...needsEvidence, optional: true }, stage('report')]), {}, { jobId: job2 });
    expect(r2.status).toBe('succeeded');
    expect(r2.degraded).toEqual([expect.objectContaining({ stage: 'recommend', code: 'EVIDENCE_INSUFFICIENT' })]);
    expect(r2.outputs.report).toEqual({ value: 1 });
  });

  it('runtime modes gate stages (spec 24) and dependents are skipped, not failed', async () => {
    let drafted = false;
    const stages = chain([
      stage('analyze'),
      stage('draft', { requiredMode: 'DRAFT', run: async () => ((drafted = true), { value: 2 }) }),
      stage('review', { prerequisites: ['draft'] }),
      stage('report', { prerequisites: ['analyze'], optionalPrerequisites: ['draft'], run: async (_i, c) => ({ value: Object.keys(c.prior).length }) }),
    ]);
    const r = await runSequential(ctx, 'wf', stages, {}, { jobId });
    expect(r.status).toBe('succeeded');
    expect(drafted).toBe(false);
    expect(r.degraded.map((d) => [d.stage, d.code])).toEqual([
      ['draft', 'MODE_NOT_PERMITTED'],
      ['review', 'PREREQUISITE_UNSATISFIED'],
    ]);
    // Required stages skipped by policy are reported separately so nobody reads this as a complete run.
    expect(r.skippedRequired.map((d) => d.stage)).toEqual(['draft', 'review']);
    expect(r.outputs.report).toEqual({ value: 1 });

    const draftCtx = { ...ctx, mode: 'DRAFT' as const };
    const job2 = enqueue(ctx, 'test-workflow', {}).id;
    const r2 = await runSequential(draftCtx, 'wf', stages, {}, { jobId: job2 });
    expect(drafted).toBe(true);
    expect(r2.degraded).toEqual([]);
    expect(r2.outputs.report).toEqual({ value: 2 });
  });

  it('dry run skips paid stages and shows their cap', async () => {
    let paidRan = false;
    const dry = { ...ctx, dryRun: true };
    const stages = chain([
      stage('free'),
      stage('serp', { costAllowance: [{ provider: 'dataforseo', maxMicros: toMicros('0.05') }], optional: true, run: async () => ((paidRan = true), { value: 1 }) }),
    ]);
    const r = await runSequential(dry, 'wf', stages, {}, { jobId });
    expect(paidRan).toBe(false);
    expect(r.degraded[0]).toMatchObject({ stage: 'serp', code: 'DRY_RUN' });
    expect(r.degraded[0]!.reason).toContain('$0.05');
    expect(r.dryRun).toBe(true);
  });

  it('enforces the declared cost allowance per stage on top of budgets', async () => {
    const estimate = (usd: string) => ({ upperBoundMicros: toMicros(usd), basis: { source: 'verified_config' as const, detail: 'synthetic test price' } });
    const within = stage('within', {
      costAllowance: [{ provider: 'llm_gateway', maxMicros: toMicros('0.10') }],
      run: async (_i, c) => {
        const res = c.app.budgets.reserve({ siteId: 'test-site', provider: 'llm_gateway', runId: 'ignored', purpose: 'synthetic', estimate: estimate('0.04') });
        toolsOf(c).budget.reserve({ provider: 'llm_gateway', purpose: 'synthetic 2', estimate: estimate('0.05') });
        return { value: res.estimatedMicros };
      },
    });
    const r = await runSequential(ctx, 'wf', chain([within]), {}, { jobId });
    expect(r.status).toBe('succeeded');
    const runIds = ctx.db.all<{ run_id: string }>('SELECT run_id FROM budget_reservations WHERE site_id = ?', ['test-site']);
    expect(runIds.map((x) => x.run_id)).toEqual([jobId, jobId]);

    const job2 = enqueue(ctx, 'test-workflow', {}).id;
    const over = stage('over', {
      costAllowance: [{ provider: 'llm_gateway', maxMicros: toMicros('0.03') }],
      run: async (_i, c) => {
        c.app.budgets.reserve({ siteId: 'test-site', provider: 'llm_gateway', runId: job2, purpose: 'too much', estimate: estimate('0.04') });
        return { value: 1 };
      },
    });
    const r2 = await runSequential(ctx, 'wf', chain([over]), {}, { jobId: job2 });
    expect(r2.failure).toMatchObject({ code: 'BUDGET_EXCEEDED', retryable: false });

    const job3 = enqueue(ctx, 'test-workflow', {}).id;
    const free = stage('free', {
      run: async (_i, c) => {
        c.app.budgets.reserve({ siteId: 'test-site', provider: 'apify', runId: job3, purpose: 'sneaky', estimate: estimate('0.01') });
        return { value: 1 };
      },
    });
    const r3 = await runSequential(ctx, 'wf', chain([free]), {}, { jobId: job3 });
    expect(r3.failure?.code).toBe('POLICY_DENIED');
  });

  it('does not start a paid stage whose budget is exhausted (honest BUDGET_EXCEEDED)', async () => {
    const tight = createTestContext({ config: testSiteConfig({ budgets: { dataforseo: { weeklyUsd: '0.10', monthlyUsd: '10.00', perRunUsd: '0.50' } } }) });
    try {
      tight.budgets.reserve({ siteId: 'test-site', provider: 'dataforseo', runId: 'earlier-run', purpose: 'earlier synthetic spend', estimate: { upperBoundMicros: toMicros('0.10'), basis: { source: 'verified_config', detail: 'test' } } });
      const job = enqueue(tight, 'test-workflow', {}).id;
      let ran = false;
      const serp = stage('serp', { costAllowance: [{ provider: 'dataforseo', maxMicros: toMicros('0.05') }], run: async () => ((ran = true), { value: 1 }) });
      const r = await runSequential(tight, 'wf', chain([serp, stage('report')]), {}, { jobId: job });
      expect(ran).toBe(false);
      expect(r.status).toBe('stopped');
      expect(r.stoppedBy).toMatchObject({ code: 'BUDGET_EXCEEDED', decision: { status: 'blocked' } });
      expect(r.stoppedBy!.decision.reason).toMatch(/site_service_week/);

      const job2 = enqueue(tight, 'test-workflow', {}).id;
      const r2 = await runSequential(tight, 'wf', chain([{ ...serp, optional: true }, stage('report')]), {}, { jobId: job2 });
      expect(r2.status).toBe('succeeded');
      expect(r2.degraded[0]).toMatchObject({ stage: 'serp', code: 'BUDGET_EXCEEDED' });
    } finally {
      tight.cleanup();
    }
  });

  it('an open circuit for an optional provider degrades only the stage that uses it', async () => {
    const breakers = new CircuitBreakers(ctx.db, ctx.siteId, ctx.clock, { failureThreshold: 1, cooldownMs: 60_000 });
    breakers.recordFailure('apify', new AppError('PROVIDER_ERROR', 'HTTP 503'));
    let called = false;
    const stages = chain([
      stage('crawl'),
      stage('reddit', { optional: true, providers: ['apify'], run: async () => ((called = true), { value: 5 }) }),
      stage('report', { prerequisites: ['crawl'] }),
    ]);
    const r = await runSequential(ctx, 'wf', stages, {}, { jobId, breakers });
    expect(called).toBe(false);
    expect(r.status).toBe('succeeded');
    expect(r.degraded).toEqual([expect.objectContaining({ stage: 'reddit', code: 'INTEGRATION_UNAVAILABLE' })]);
    expect(r.outputs.report).toEqual({ value: 1 });

    const job2 = enqueue(ctx, 'test-workflow', {}).id;
    const required = chain([stage('crawl'), stage('reddit', { providers: ['apify'] }), stage('report')]);
    const r2 = await runSequential(ctx, 'wf', required, {}, { jobId: job2, breakers });
    expect(r2.status).toBe('failed');
    expect(r2.failure).toMatchObject({ code: 'INTEGRATION_UNAVAILABLE', retryable: true });
  });

  it('an optional stage failure degrades the workflow instead of failing it', async () => {
    const stages = chain([
      stage('pagespeed', {
        optional: true,
        run: async () => {
          throw new AppError('PROVIDER_ERROR', 'HTTP 500');
        },
      }),
      stage('report'),
    ]);
    const r = await runSequential(ctx, 'wf', stages, {}, { jobId });
    expect(r.status).toBe('succeeded');
    expect(r.stages.map((s) => s.status)).toEqual(['failed', 'succeeded']);
    expect(r.degraded[0]).toMatchObject({ stage: 'pagespeed', code: 'PROVIDER_ERROR' });
  });

  it('cancellation through the parent signal stops the workflow as cancelled', async () => {
    const ctl = new AbortController();
    const stages = chain([
      stage('long', {
        run: (_i, c) =>
          new Promise((_res, rej) => {
            c.signal.addEventListener('abort', () => rej(c.signal.reason));
            setTimeout(() => ctl.abort(new AppError('CANCELLED', 'cancelled by test')), 10);
          }),
      }),
      stage('never'),
    ]);
    const r = await runSequential(ctx, 'wf', stages, {}, { jobId, signal: ctl.signal });
    expect(r.status).toBe('cancelled');
    expect(r.stages.map((s) => s.status)).toEqual(['failed', 'skipped']);
  });

  it('a heartbeat that throws stops the workflow cooperatively between stages', async () => {
    let beats = 0;
    const stages = chain([stage('one'), stage('two')]);
    const r = await runSequential(ctx, 'wf', stages, {}, {
      jobId,
      heartbeat: () => {
        beats++;
        if (beats > 2) throw new AppError('CANCELLED', 'cancel requested');
      },
    });
    expect(r.status).toBe('cancelled');
    expect(r.outputs.one).toEqual({ value: 1 });
    expect(r.outputs.two).toBeUndefined();
  });

  it('a paid stage that did not finish (timeout) is not rerun on resume without an explicit decision', async () => {
    let calls = 0;
    let hang = true;
    const paid = stage('serp', {
      timeoutMs: 20,
      costAllowance: [{ provider: 'dataforseo', maxMicros: toMicros('0.05') }],
      run: () => {
        calls++;
        return hang ? new Promise(() => undefined) : Promise.resolve({ value: 1 });
      },
    });
    const r1 = await runSequential(ctx, 'wf', chain([paid]), {}, { jobId, abortGraceMs: 20 });
    expect(r1.failure).toMatchObject({ code: 'TIMEOUT', retryable: false });
    expect(r1.warnings.join()).toMatch(/may still be running in the background/); // no lock holder registered
    hang = false;
    const r2 = await runSequential(ctx, 'wf', chain([paid]), {}, { jobId });
    expect(calls).toBe(1);
    expect(r2.status).toBe('stopped');
    expect(r2.stoppedBy).toMatchObject({ code: 'AMBIGUOUS_SUBMISSION', decision: { status: 'blocked' } });
    const r3 = await runSequential(ctx, 'wf', chain([paid]), {}, { jobId, rerunAmbiguousPaidStages: true });
    expect(r3.status).toBe('succeeded');
    expect(calls).toBe(2);
    expect(r3.warnings.join()).toMatch(/explicitly authorized/);
  });

  it('an in-flight marker from a crashed run is not masked by later gate decisions', async () => {
    const { CheckpointStore } = await import('../../../src/workflows/checkpoints.js');
    const store = new CheckpointStore(ctx.db, ctx.clock);
    store.save({ siteId: ctx.siteId, jobId, workflow: 'wf', stage: 'serp', stageVersion: '1', status: 'failed', error: { code: 'IN_FLIGHT', message: 'marker' }, attempt: 1 });
    store.save({ siteId: ctx.siteId, jobId, workflow: 'wf', stage: 'serp', stageVersion: '1', status: 'stopped', error: { code: 'BUDGET_EXCEEDED', message: 'gate' }, attempt: 0 });
    let calls = 0;
    const paid = stage('serp', { costAllowance: [{ provider: 'dataforseo', maxMicros: toMicros('0.05') }], run: async () => ((calls++), { value: 1 }) });
    const r = await runSequential(ctx, 'wf', chain([paid]), {}, { jobId });
    expect(calls).toBe(0);
    expect(r.stoppedBy?.code).toBe('AMBIGUOUS_SUBMISSION');
  });

  it('a completed paid stage is reused on resume even when its budget is now exhausted or the provider is down', async () => {
    const tight = createTestContext({ config: testSiteConfig({ budgets: { dataforseo: { weeklyUsd: '0.05', monthlyUsd: '10.00', perRunUsd: '0.50' } } }) });
    try {
      const job = enqueue(tight, 'test-workflow', {}).id;
      let calls = 0;
      const est = { upperBoundMicros: toMicros('0.05'), basis: { source: 'verified_config' as const, detail: 'synthetic' } };
      const paid = stage('serp', {
        providers: ['dataforseo'],
        costAllowance: [{ provider: 'dataforseo', maxMicros: toMicros('0.05') }],
        run: async (_i, c) => {
          calls++;
          c.app.budgets.reserve({ siteId: 'test-site', provider: 'dataforseo', runId: job, purpose: 'synthetic serp', estimate: est });
          return { value: 1 };
        },
      });
      let crash = true;
      const after = stage('analysis', { prerequisites: ['serp'], run: async () => { if (crash) throw new AppError('INTERNAL', 'crash'); return { value: 2 }; } });
      expect((await runSequential(tight, 'wf', chain([paid, after]), {}, { jobId: job })).status).toBe('failed');
      crash = false;
      const breakers = new CircuitBreakers(tight.db, tight.siteId, tight.clock, { failureThreshold: 1 });
      breakers.recordFailure('dataforseo', new AppError('PROVIDER_ERROR', 'HTTP 500'));
      const r = await runSequential(tight, 'wf', chain([paid, after]), {}, { jobId: job, breakers });
      expect(r.status).toBe('succeeded');
      expect(r.stages[0]!.resumedFromCheckpoint).toBe(true);
      expect(calls).toBe(1);
    } finally {
      tight.cleanup();
    }
  });

  it('records workflow start/finish in the append-only audit log', async () => {
    await runSequential(ctx, 'wf', chain([stage('one')]), {}, { jobId });
    const events = ctx.db.all<{ event_type: string }>("SELECT event_type FROM audit_events WHERE subject_id = ? AND event_type LIKE 'workflow.%' ORDER BY id", [jobId]);
    expect(events.map((e) => e.event_type)).toEqual(['workflow.started', 'workflow.finished']);
  });

  // D2-ACC-08: a stage whose own output note says it did no (or only part of its) work is never logged as "succeeded".
  it('logs stages whose output note is offline/skipped/degraded at warn with the status and code; clean stages keep the info line', async () => {
    const noted = z.object({ value: z.number(), note: z.object({ status: z.string(), code: z.string().nullable(), detail: z.string(), nextStep: z.string().nullable() }).nullable() });
    const withNote = (name: string, n: { status: string; code: string | null; detail: string; nextStep: string | null } | null) => stage(name, { output: noted, run: async () => ({ value: 1, note: n }) });
    const r = await runSequential(
      ctx,
      'wf',
      chain([
        withNote('crawl_site', { status: 'skipped', code: 'CRAWL_OFFLINE', detail: 'Own-site crawl offline: offline mode (synthetic)\nsecond line', nextStep: 'Run without --offline.' }),
        withNote('sync_gsc', { status: 'skipped', code: 'DRY_RUN', detail: 'Dry run: nothing was requested or written.', nextStep: null }),
        withNote('performance', { status: 'degraded', code: 'PERFORMANCE_UNAVAILABLE', detail: '1 of 3 performance check(s) did not complete', nextStep: null }),
        withNote('index_memory', { status: 'succeeded', code: 'MEMORY_FTS_ONLY_POLICY', detail: 'full-text only by policy', nextStep: null }),
        withNote('clean', null),
        stage('plain'),
      ]),
      {},
      { jobId },
    );
    expect(r.status).toBe('succeeded');
    const stageLogs = ctx.logEntries.filter((e) => e.msg.startsWith('Stage '));
    expect(stageLogs.map((e) => [e.level, e.msg])).toEqual([
      ['warn', 'Stage crawl_site offline: CRAWL_OFFLINE: Own-site crawl offline: offline mode (synthetic)'],
      ['warn', 'Stage sync_gsc skipped: DRY_RUN: Dry run: nothing was requested or written.'],
      ['warn', 'Stage performance degraded: PERFORMANCE_UNAVAILABLE: 1 of 3 performance check(s) did not complete'],
      ['info', 'Stage index_memory succeeded'],
      ['info', 'Stage clean succeeded'],
      ['info', 'Stage plain succeeded'],
    ]);
    expect(stageLogs[0]!.fields).toMatchObject({ status: 'offline', code: 'CRAWL_OFFLINE', nextStep: 'Run without --offline.', attempt: 1 });
    expect(stageLogs[1]!.fields).toMatchObject({ status: 'skipped', code: 'DRY_RUN' });
    expect(stageLogs[1]!.fields).not.toHaveProperty('nextStep');

    // A resumed run reuses the checkpoints and says what they recorded.
    ctx.logEntries.length = 0;
    await runSequential(ctx, 'wf', chain([withNote('crawl_site', { status: 'skipped', code: 'CRAWL_OFFLINE', detail: 'Own-site crawl offline: offline mode (synthetic)\nsecond line', nextStep: 'Run without --offline.' })]), {}, { jobId });
    expect(ctx.logEntries.find((e) => e.msg.startsWith('Stage crawl_site'))?.msg).toMatch(/^Stage crawl_site reused checkpoint \S+ \(recorded as offline: CRAWL_OFFLINE\)$/);
  });
});
