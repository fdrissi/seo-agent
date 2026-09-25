import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../../src/core/errors.js';
import { openDatabase, type Db } from '../../../src/database/db.js';
import { JobRegistry } from '../../../src/jobs/registry.js';
import { JobRunner, enqueueAndRun } from '../../../src/jobs/runner.js';
import { acquireSiteLock, getSiteLock } from '../../../src/jobs/locks.js';
import { enqueue, getJob, listJobRuns, requestCancel } from '../../../src/jobs/store.js';
import { jobFailed, jobSucceeded, jobWaiting, type JobHandler } from '../../../src/jobs/types.js';
import { workflowJobHandler } from '../../../src/jobs/workflow-handler.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { chain, deferred, stage } from '../../unit/workflows/_stages.js';

const noJitter = { maxAttempts: 3, baseDelayMs: 60_000, maxDelayMs: 600_000, jitter: 0 };

function handler(type: string, run: JobHandler['run'], extra: Partial<JobHandler> = {}): JobHandler {
  return { type, description: `synthetic ${type}`, run, ...extra };
}

describe('durable job runner', () => {
  let ctx: TestContext;
  let registry: JobRegistry;
  const extraDbs: Db[] = [];
  beforeEach(() => {
    ctx = createTestContext({ now: '2026-09-24T09:00:00.000Z' });
    registry = new JobRegistry();
  });
  afterEach(() => {
    for (const d of extraDbs.splice(0)) d.close();
    ctx.cleanup();
  });
  const secondProcess = () => {
    const db2 = openDatabase(ctx.db.file);
    extraDbs.push(db2);
    return { ...ctx, db: db2 };
  };

  it('enqueue validates the type and params against the registered handler', () => {
    registry.register(handler('sync', async () => jobSucceeded(), { paramsSchema: z.object({ days: z.number().int().positive() }) }));
    expect(() => enqueue(ctx, 'Bad Type!', {})).toThrow(/Invalid job type/);
    expect(() => enqueue(ctx, 'unknown', {}, { registry })).toThrow(/No job handler/);
    expect(() => enqueue(ctx, 'sync', { days: -1 }, { registry })).toThrow(/Invalid params/);
    const job = enqueue(ctx, 'sync', { days: 7 }, { registry });
    expect(job).toMatchObject({ siteId: 'test-site', type: 'sync', status: 'queued', mode: 'ANALYZE', attempt: 0, maxAttempts: 3, params: { days: 7 } });
  });

  it('runs a job, records a job_run with pid/hostname, stores a redacted result, and releases the lock', async () => {
    registry.register(handler('sync', async (c) => jobSucceeded({ rows: 3, apiKey: 'sk-live-should-never-be-stored-1234567890', runId: c.app.runId })));
    const runner = new JobRunner({ registry, hostname: 'host-a.test', pid: 4242 });
    const job = enqueue(ctx, 'sync', {});
    const r = await runner.runJob(ctx, job.id);
    expect(r.outcome).toBe('succeeded');
    const stored = getJob(ctx.db, ctx.siteId, job.id)!;
    expect(stored).toMatchObject({ status: 'succeeded', attempt: 1, lockOwner: null, error: null });
    expect(stored.result).toEqual({ rows: 3, apiKey: '[REDACTED]', runId: job.id });
    expect(listJobRuns(ctx.db, ctx.siteId, job.id)).toEqual([expect.objectContaining({ attempt: 1, status: 'succeeded', pid: 4242, hostname: 'host-a.test' })]);
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeUndefined();
  });

  it('per-site lock prevents two runners from overlapping', async () => {
    const gate = deferred();
    const started = deferred();
    registry.register(handler('weekly', async () => (started.resolve(), await gate.promise, jobSucceeded())));
    registry.register(handler('monthly', async () => jobSucceeded()));
    const a = new JobRunner({ registry, owner: 'runner-a' });
    const b = new JobRunner({ registry, owner: 'runner-b' });
    const ctxB = secondProcess();
    const weekly = enqueue(ctx, 'weekly', {});
    const monthly = enqueue(ctx, 'monthly', {});

    const runA = a.runJob(ctx, weekly.id);
    await started.promise;
    const rb = await b.runJob(ctxB, monthly.id);
    expect(rb.outcome).toBe('locked');
    if (rb.outcome === 'locked') expect(rb.heldBy).toMatchObject({ owner: 'runner-a', jobId: weekly.id });
    // B did not consume an attempt or change the job.
    expect(getJob(ctx.db, ctx.siteId, monthly.id)).toMatchObject({ status: 'queued', attempt: 0 });
    // B also cannot run A's job while it runs.
    expect((await b.runJob(ctxB, weekly.id)).outcome).toBe('not_runnable');

    gate.resolve();
    expect((await runA).outcome).toBe('succeeded');
    expect((await b.runJob(ctxB, monthly.id)).outcome).toBe('succeeded');
  });

  it('takes over a lock whose lease expired (crashed holder) and audits the takeover', async () => {
    registry.register(handler('weekly', async () => jobSucceeded()));
    const now = ctx.clock.now();
    acquireSiteLock(ctx.db, { siteId: ctx.siteId, owner: 'dead-host:999:x', jobId: null, leaseMs: 60_000, now: new Date(now.getTime() - 120_000) });
    const job = enqueue(ctx, 'weekly', {});
    const runner = new JobRunner({ registry, owner: 'fresh-runner' });
    expect((await runner.runJob(ctx, job.id)).outcome).toBe('succeeded');
    const audit = ctx.db.get<{ details_json: string }>("SELECT details_json FROM audit_events WHERE event_type = 'lock.takeover'");
    expect(JSON.parse(audit!.details_json)).toMatchObject({ previousOwner: 'dead-host:999:x', newOwner: 'fresh-runner' });

    // An unexpired lock of another owner is respected.
    acquireSiteLock(ctx.db, { siteId: ctx.siteId, owner: 'live-runner', jobId: null, leaseMs: 60_000, now });
    const job2 = enqueue(ctx, 'weekly', {});
    expect((await runner.runJob(ctx, job2.id)).outcome).toBe('locked');
  });

  it('a runner that loses its lock mid-run stops and leaves the job interrupted', async () => {
    const started = deferred();
    registry.register(
      handler('weekly', async (c) => {
        started.resolve();
        await new Promise((resolve) => c.signal.addEventListener('abort', resolve));
        return jobSucceeded();
      }),
    );
    const runner = new JobRunner({ registry, owner: 'runner-a', heartbeatMs: 10, leaseMs: 1_000, cancelPollMs: 1_000 });
    const job = enqueue(ctx, 'weekly', {});
    const p = runner.runJob(ctx, job.id);
    await started.promise;
    ctx.db.run("UPDATE site_locks SET owner = 'runner-b' WHERE site_id = ?", [ctx.siteId]); // simulated takeover
    const r = await p;
    expect(r.outcome).toBe('interrupted');
    if (r.outcome === 'interrupted') expect(r.error.code).toBe('LOCKED');
    expect(getSiteLock(ctx.db, ctx.siteId)?.owner).toBe('runner-b'); // not released by the loser
  });

  it('retries transient failures of idempotent handlers with backoff up to max_attempts', async () => {
    let calls = 0;
    registry.register(handler('sync', async () => {
      calls++;
      throw new AppError('PROVIDER_ERROR', `HTTP 503 (${calls})`);
    }, { idempotent: true }));
    const runner = new JobRunner({ registry, backoff: noJitter });
    const job = enqueue(ctx, 'sync', {}, { maxAttempts: 3 });

    const r1 = await runner.runJob(ctx, job.id);
    expect(r1).toMatchObject({ outcome: 'retry_scheduled', nextAttemptAt: '2026-09-24T09:01:00.000Z' });
    expect(getJob(ctx.db, ctx.siteId, job.id)).toMatchObject({ status: 'queued', attempt: 1, nextAttemptAt: '2026-09-24T09:01:00.000Z' });
    expect((await runner.runJob(ctx, job.id)).outcome).toBe('not_runnable'); // backoff not elapsed
    ctx.clock.advanceMs(60_000);
    const r2 = await runner.runJob(ctx, job.id);
    expect(r2).toMatchObject({ outcome: 'retry_scheduled', nextAttemptAt: '2026-09-24T09:03:00.000Z' });
    ctx.clock.advanceMs(120_000);
    const r3 = await runner.runJob(ctx, job.id);
    expect(r3.outcome).toBe('failed');
    expect(calls).toBe(3);
    const final = getJob(ctx.db, ctx.siteId, job.id)!;
    expect(final.status).toBe('failed');
    expect(final.error?.hint).toMatch(/Gave up after 3 failed attempt/);
    expect(listJobRuns(ctx.db, ctx.siteId, job.id).map((x) => x.status)).toEqual(['failed', 'failed', 'failed']);
  });

  it('retryInline waits out the backoff in-process', async () => {
    let calls = 0;
    const slept: number[] = [];
    registry.register(handler('sync', async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return jobSucceeded({ calls });
    }, { idempotent: true }));
    const runner = new JobRunner({ registry, backoff: noJitter, sleep: async (ms) => void slept.push(ms) });
    const job = enqueue(ctx, 'sync', {});
    const r = await runner.runJob(ctx, job.id, { retryInline: true });
    expect(r.outcome).toBe('succeeded');
    expect(slept).toEqual([60_000, 120_000]);
  });

  it('never retries thrown errors of non-idempotent handlers or non-retryable outcomes', async () => {
    let calls = 0;
    registry.register(handler('paid', async () => {
      calls++;
      throw new AppError('TIMEOUT', 'POST timed out; provider may have accepted the task');
    }));
    registry.register(handler('explicit', async () => jobFailed({ code: 'AMBIGUOUS_SUBMISSION', message: 'reconcile first' }, false)));
    const runner = new JobRunner({ registry, backoff: noJitter });
    expect((await runner.runJob(ctx, enqueue(ctx, 'paid', {}).id)).outcome).toBe('failed');
    expect(calls).toBe(1);
    const r = await runner.runJob(ctx, enqueue(ctx, 'explicit', {}).id);
    expect(r).toMatchObject({ outcome: 'failed', error: { code: 'AMBIGUOUS_SUBMISSION' } });
  });

  it('cancels queued jobs immediately and running jobs cooperatively', async () => {
    registry.register(handler('weekly', async (c) => {
      await new Promise((resolve) => c.signal.addEventListener('abort', resolve));
      return jobSucceeded();
    }));
    const queued = enqueue(ctx, 'weekly', {});
    expect(requestCancel(ctx, queued.id)).toMatchObject({ outcome: 'cancelled', previousStatus: 'queued' });
    expect(getJob(ctx.db, ctx.siteId, queued.id)?.status).toBe('cancelled');

    const runner = new JobRunner({ registry, cancelPollMs: 5 });
    const running = enqueue(ctx, 'weekly', {});
    const p = runner.runJob(ctx, running.id);
    await new Promise((r) => setTimeout(r, 20));
    const other = secondProcess();
    expect(requestCancel(other, running.id)).toMatchObject({ outcome: 'cancel_requested' });
    const r = await p;
    expect(r.outcome).toBe('cancelled');
    expect(getJob(ctx.db, ctx.siteId, running.id)).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
    expect(listJobRuns(ctx.db, ctx.siteId, running.id)[0]!.status).toBe('cancelled');
    expect(requestCancel(ctx, running.id)).toMatchObject({ outcome: 'already_finished' });
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeUndefined();
  });

  it('cancellation reaches a workflow at the next stage boundary via heartbeat()', async () => {
    let stage2Ran = false;
    const stages = chain([
      stage('one', {
        run: async (_i, c) => {
          requestCancel({ db: c.app.db, siteId: c.app.siteId, clock: c.app.clock }, c.jobId);
          return { value: 1 };
        },
      }),
      stage('two', { run: async () => ((stage2Ran = true), { value: 2 }) }),
    ]);
    registry.register(workflowJobHandler({ type: 'weekly', description: 'synthetic', workflow: 'weekly', stages }));
    const runner = new JobRunner({ registry, cancelPollMs: 60_000 });
    const job = enqueue(ctx, 'weekly', {});
    expect((await runner.runJob(ctx, job.id)).outcome).toBe('cancelled');
    expect(stage2Ran).toBe(false);
  });

  it('detects interrupted jobs: stale heartbeat, or a dead process on this host', async () => {
    registry.register(handler('weekly', async () => jobSucceeded()));
    const runner = new JobRunner({ registry, hostname: 'this-host', leaseMs: 90_000, isPidAlive: (pid) => pid !== 111 });
    const mkRunning = (heartbeat: string, host: string, pid: number, owner: string) => {
      const j = enqueue(ctx, 'weekly', {});
      ctx.db.run("UPDATE jobs SET status = 'running', attempt = 1, heartbeat_at = ?, lock_owner = ? WHERE id = ?", [heartbeat, owner, j.id]);
      ctx.db.run("INSERT INTO job_runs (id, job_id, site_id, attempt, status, pid, hostname, started_at) VALUES (?, ?, ?, 1, 'running', ?, ?, ?)", [`jrun_${j.id}`, j.id, ctx.siteId, pid, host, heartbeat]);
      return j.id;
    };
    const stale = mkRunning('2026-09-24T08:50:00.000Z', 'other-host', 222, 'other-host:222:a');
    const deadLocal = mkRunning('2026-09-24T08:59:50.000Z', 'this-host', 111, 'this-host:111:b');
    const alive = mkRunning('2026-09-24T08:59:50.000Z', 'other-host', 333, 'other-host:333:c');
    ctx.db.run('INSERT INTO site_locks (site_id, lock_name, owner, job_id, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      ctx.siteId, 'site', 'this-host:111:b', deadLocal, '2026-09-24T08:59:00.000Z', '2026-09-24T08:59:50.000Z', '2026-09-24T09:01:20.000Z',
    ]);

    const recovered = runner.recoverInterrupted(ctx);
    expect(recovered.map((r) => r.jobId).sort()).toEqual([stale, deadLocal].sort());
    expect(recovered.find((r) => r.jobId === stale)!.reason).toMatch(/heartbeat is stale/);
    expect(recovered.find((r) => r.jobId === deadLocal)!.reason).toMatch(/process 111 on this-host is no longer running/);
    expect(getJob(ctx.db, ctx.siteId, alive)?.status).toBe('running');
    expect(getJob(ctx.db, ctx.siteId, stale)).toMatchObject({ status: 'interrupted', error: { code: 'INTERRUPTED' } });
    expect(listJobRuns(ctx.db, ctx.siteId, stale)[0]!.status).toBe('interrupted');
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeUndefined(); // the dead process's lock was released

    // Resume runs the interrupted jobs (a new attempt each); the live one stays untouched.
    const res = await runner.resume(ctx);
    expect(res.results.map((r) => r.outcome)).toEqual(['succeeded', 'succeeded']);
    expect(getJob(ctx.db, ctx.siteId, stale)).toMatchObject({ status: 'succeeded', attempt: 2 });
  });

  it('resume by id: refuses finished/cancelled/running jobs, extends attempts for an exhausted failed job', async () => {
    let fail = true;
    registry.register(handler('sync', async () => (fail ? jobFailed({ code: 'PROVIDER_ERROR', message: 'down' }, true) : jobSucceeded()), { maxAttempts: 1 }));
    const runner = new JobRunner({ registry, backoff: noJitter });
    const job = enqueue(ctx, 'sync', {}, { registry });
    expect((await runner.runJob(ctx, job.id)).outcome).toBe('failed');
    fail = false;
    const r = await runner.resume(ctx, job.id);
    expect(r.results[0]!.outcome).toBe('succeeded');
    expect(getJob(ctx.db, ctx.siteId, job.id)).toMatchObject({ status: 'succeeded', maxAttempts: 2, attempt: 2 });
    await expect(runner.resume(ctx, job.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    const cancelled = enqueue(ctx, 'sync', {});
    requestCancel(ctx, cancelled.id);
    await expect(runner.resume(ctx, cancelled.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('respects the runner mode ceiling, reports missing handlers honestly, and supports waiting outcomes', async () => {
    registry.register(handler('research', async () => jobSucceeded()));
    registry.register(handler('review', async () => jobWaiting('draft needs human review', { draft: 'd1' })));
    const analyzeOnly = new JobRunner({ registry, maxMode: 'ANALYZE' });
    const researchJob = enqueue(ctx, 'research', {}, { mode: 'RESEARCH' });
    const r = await analyzeOnly.runJob(ctx, researchJob.id);
    expect(r).toMatchObject({ outcome: 'not_runnable' });
    if (r.outcome === 'not_runnable') expect(r.reason).toMatch(/--mode RESEARCH/);
    expect((await new JobRunner({ registry, maxMode: 'RESEARCH' }).runJob(ctx, researchJob.id)).outcome).toBe('succeeded');

    const orphan = enqueue(ctx, 'weekly', {});
    const o = await analyzeOnly.runJob(ctx, orphan.id);
    expect(o).toMatchObject({ outcome: 'failed', error: { code: 'NOT_FOUND' } });
    expect(getJob(ctx.db, ctx.siteId, orphan.id)?.error?.hint).toMatch(/jobs resume/);

    const w = await analyzeOnly.runJob(ctx, enqueue(ctx, 'review', {}).id);
    expect(w).toMatchObject({ outcome: 'waiting', reason: 'draft needs human review' });
    expect(w.job.result).toEqual({ draft: 'd1', waitingReason: 'draft needs human review' });
  });

  it('an external shutdown signal leaves the job interrupted and resumable', async () => {
    const ctl = new AbortController();
    registry.register(handler('weekly', async (c) => {
      setTimeout(() => ctl.abort(), 5);
      await new Promise((resolve) => c.signal.addEventListener('abort', resolve));
      return jobSucceeded();
    }));
    const runner = new JobRunner({ registry });
    const job = enqueue(ctx, 'weekly', {});
    const r = await runner.runJob(ctx, job.id, { signal: ctl.signal });
    expect(r).toMatchObject({ outcome: 'interrupted', error: { code: 'INTERRUPTED' } });
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeUndefined();
  });

  it('enqueueAndRun runs a foreground job with the same durability rules', async () => {
    registry.register(handler('baseline', async (c) => jobSucceeded({ mode: c.app.mode, dryRun: c.app.dryRun })));
    const runner = new JobRunner({ registry });
    const r = await enqueueAndRun(ctx, runner, 'baseline', {}, { mode: 'RESEARCH', dryRun: true });
    expect(r.outcome).toBe('succeeded');
    expect(r.job.result).toEqual({ mode: 'RESEARCH', dryRun: true });
    await expect(enqueueAndRun(ctx, runner, 'not-registered')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('drain runs due jobs oldest first and skips future retries', async () => {
    const order: string[] = [];
    registry.register(handler('a', async (c) => (order.push(c.job.id), jobSucceeded())));
    const runner = new JobRunner({ registry });
    const j1 = enqueue(ctx, 'a', {});
    ctx.clock.advanceMs(1);
    const j2 = enqueue(ctx, 'a', {});
    const later = enqueue(ctx, 'a', {}, { runAt: '2026-09-25T00:00:00.000Z' });
    const r = await runner.drain(ctx);
    expect(order).toEqual([j1.id, j2.id]);
    expect(r.results).toHaveLength(2);
    expect(getJob(ctx.db, ctx.siteId, later.id)?.status).toBe('queued');
  });
});

describe('workflow jobs: degradation and circuit breakers', () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestContext({ now: '2026-09-24T09:00:00.000Z' });
  });
  afterEach(() => ctx.cleanup());

  it('a failing optional provider degrades only its stage; repeated failures open the breaker and later runs skip it', async () => {
    let providerCalls = 0;
    const stages = chain([
      stage('crawl'),
      stage('reddit', {
        optional: true,
        providers: ['apify'],
        run: async (_i, c) => {
          const { toolsOf } = await import('../../../src/workflows/stage.js');
          return toolsOf(c).breakers!.execute('apify', async () => {
            providerCalls++;
            throw new AppError('PROVIDER_ERROR', 'synthetic actor run failed');
          });
        },
      }),
      stage('report', { prerequisites: ['crawl'] }),
    ]);
    const registry = new JobRegistry().register(workflowJobHandler({ type: 'weekly', description: 'synthetic weekly', workflow: 'weekly', stages }));
    const runner = new JobRunner({ registry, breakers: { failureThreshold: 2, cooldownMs: 3_600_000 } });
    // Online run (network allowed): offline runs never change breaker state.
    const online = { ...ctx, offline: false };
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await runner.runJob(online, enqueue(ctx, 'weekly', {}).id));
    expect(results.map((r) => r.outcome)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(providerCalls).toBe(2); // third run skipped the provider: circuit open
    const third = results[2]!.job.result as { degraded: Array<{ stage: string; code: string }>; stages: Array<{ stage: string; status: string }> };
    expect(third.degraded).toEqual([expect.objectContaining({ stage: 'reddit', code: 'INTEGRATION_UNAVAILABLE' })]);
    expect(third.stages.find((s) => s.stage === 'report')!.status).toBe('succeeded');
  });

  it('after the cooldown the stage itself performs the half-open probe, and success closes the breaker', async () => {
    let providerCalls = 0;
    let fail = true;
    const stages = chain([
      stage('reddit', {
        optional: true,
        providers: ['apify'],
        run: async (_i, c) => {
          const { toolsOf } = await import('../../../src/workflows/stage.js');
          return toolsOf(c).breakers!.execute('apify', async () => {
            providerCalls++;
            if (fail) throw new AppError('PROVIDER_ERROR', 'synthetic failure');
            return { value: 7 };
          });
        },
      }),
    ]);
    const registry = new JobRegistry().register(workflowJobHandler({ type: 'weekly', description: 'synthetic weekly', workflow: 'weekly', stages }));
    const runner = new JobRunner({ registry, breakers: { failureThreshold: 1, cooldownMs: 60_000 } });
    const online = { ...ctx, offline: false };
    const { CircuitBreakers } = await import('../../../src/jobs/circuit-breaker.js');
    await runner.runJob(online, enqueue(ctx, 'weekly', {}).id); // opens the breaker
    expect(new CircuitBreakers(ctx.db, ctx.siteId, ctx.clock).get('apify').state).toBe('open');
    ctx.clock.advanceMs(60_000);
    fail = false;
    const r = await runner.runJob(online, enqueue(ctx, 'weekly', {}).id);
    expect(providerCalls).toBe(2);
    expect((r.job.result as { degraded: unknown[] }).degraded).toEqual([]);
    expect(new CircuitBreakers(ctx.db, ctx.siteId, ctx.clock).get('apify').state).toBe('closed');
  });

  it('maps workflow outcomes to job statuses without fabricating success', async () => {
    const mk = (type: string, s: ReturnType<typeof stage>[], extra: string[] = []) => workflowJobHandler({ type, description: type, workflow: type, stages: chain(s, extra) });
    const registry = new JobRegistry()
      .register(mk('review', [stage('draft', { stoppingConditions: ['always'], shouldStop: () => ({ stop: true, reason: 'needs human review', status: 'needs_review' }) })], ['needs_review']))
      .register(mk('noop', [stage('decide', { stoppingConditions: ['nothing'], shouldStop: () => ({ stop: true, reason: 'no action this week', status: 'no_action' }) })], ['no_action']))
      .register(mk('paid', [stage('serp', { costAllowance: [{ provider: 'dataforseo', maxMicros: 50_000 }], idempotent: true, run: async () => { throw new AppError('TIMEOUT', 'POST timed out'); } })]))
      .register(mk('flaky', [stage('read', { idempotent: true, run: async () => { throw new AppError('PROVIDER_ERROR', 'HTTP 502'); } })]));
    const runner = new JobRunner({ registry, backoff: noJitter });
    expect((await runner.runJob(ctx, enqueue(ctx, 'review', {}).id)).outcome).toBe('waiting');
    expect((await runner.runJob(ctx, enqueue(ctx, 'noop', {}).id)).outcome).toBe('succeeded');
    const paid = await runner.runJob(ctx, enqueue(ctx, 'paid', {}).id);
    expect(paid).toMatchObject({ outcome: 'failed', error: { code: 'TIMEOUT' } }); // paid stage: never retried at job level
    expect((await runner.runJob(ctx, enqueue(ctx, 'flaky', {}).id)).outcome).toBe('retry_scheduled');
  });
});
