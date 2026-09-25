import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../../src/core/errors.js';
import { toMicros } from '../../../src/core/money.js';
import { openDatabase, type Db } from '../../../src/database/db.js';
import { CircuitBreakers } from '../../../src/jobs/circuit-breaker.js';
import { getSiteLock } from '../../../src/jobs/locks.js';
import { JobRegistry } from '../../../src/jobs/registry.js';
import { JobRunner } from '../../../src/jobs/runner.js';
import { describeSchedules, enableSchedule, schedulerTick } from '../../../src/jobs/scheduler.js';
import { enqueue, getJob, listJobRuns, listJobs, requestCancel } from '../../../src/jobs/store.js';
import { jobSucceeded, type JobHandler } from '../../../src/jobs/types.js';
import { workflowJobHandler } from '../../../src/jobs/workflow-handler.js';
import { CheckpointStore } from '../../../src/workflows/checkpoints.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { chain, deferred, stage } from '../../unit/workflows/_stages.js';

const noJitter = { maxAttempts: 3, baseDelayMs: 60_000, maxDelayMs: 600_000, jitter: 0 };

function handler(type: string, run: JobHandler['run'], extra: Partial<JobHandler> = {}): JobHandler {
  return { type, description: `synthetic ${type}`, run, ...extra };
}

describe('job runner: review fixes (locks, takeover, orphans, reviews, breakers)', () => {
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

  it('one runner running two jobs of the same site at once: the second is refused and the lock stays with the first', async () => {
    const gate = deferred();
    const started = deferred();
    registry.register(handler('weekly', async () => (started.resolve(), await gate.promise, jobSucceeded())));
    registry.register(handler('monthly', async () => jobSucceeded()));
    const runner = new JobRunner({ registry, owner: 'runner-a' });
    const weekly = enqueue(ctx, 'weekly', {});
    const monthly = enqueue(ctx, 'monthly', {});
    const pw = runner.runJob(ctx, weekly.id);
    await started.promise;
    const rm = await runner.runJob(ctx, monthly.id);
    expect(rm.outcome).toBe('locked');
    expect(getSiteLock(ctx.db, ctx.siteId)).toMatchObject({ owner: 'runner-a', jobId: weekly.id });
    expect(getJob(ctx.db, ctx.siteId, monthly.id)).toMatchObject({ status: 'queued', attempt: 0 });
    gate.resolve();
    expect((await pw).outcome).toBe('succeeded');
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeUndefined();
    expect((await runner.runJob(ctx, monthly.id)).outcome).toBe('succeeded');
  });

  it('a live job on this host is not declared stale on heartbeat age alone, and its expired lock is not taken over', async () => {
    const gate = deferred();
    const started = deferred();
    registry.register(handler('weekly', async (c) => (c.attempt === 1 ? (started.resolve(), await gate.promise) : undefined, jobSucceeded())));
    registry.register(handler('monthly', async () => jobSucceeded()));
    const a = new JobRunner({ registry, owner: 'runner-a', hostname: 'host-a.test', pid: 1111, isPidAlive: () => true });
    const job = enqueue(ctx, 'weekly', {});
    const pa = a.runJob(ctx, job.id);
    await started.promise;
    ctx.clock.advanceMs(120_000); // e.g. the laptop slept: the lease (90 s) expired, no heartbeat yet
    const ctx2 = secondProcess();
    const sameHost = new JobRunner({ registry, owner: 'runner-a2', hostname: 'host-a.test', pid: 2222, isPidAlive: () => true });
    expect(sameHost.staleReason(ctx2, getJob(ctx2.db, ctx2.siteId, job.id)!)).toBeNull();
    await expect(sameHost.resume(ctx2, job.id)).rejects.toMatchObject({ code: 'LOCKED' });
    const other = enqueue(ctx, 'monthly', {});
    const r = await sameHost.runJob(ctx2, other.id);
    expect(r.outcome).toBe('locked');
    expect(getJob(ctx.db, ctx.siteId, job.id)?.status).toBe('running');
    gate.resolve();
    expect((await pa).outcome).toBe('succeeded');
  });

  it('a run that was declared stale and resumed elsewhere cannot overwrite the newer result when it finishes', async () => {
    const gate = deferred();
    const started = deferred();
    registry.register(handler('weekly', async (c) => (c.attempt === 1 ? (started.resolve(), await gate.promise) : undefined, jobSucceeded({ attempt: c.attempt }))));
    const a = new JobRunner({ registry, owner: 'runner-a', hostname: 'host-a.test', pid: 1111, isPidAlive: () => true });
    const job = enqueue(ctx, 'weekly', {});
    const pa = a.runJob(ctx, job.id);
    await started.promise;
    ctx.clock.advanceMs(120_000);
    // Another host can only judge the heartbeat: 120 s > 90 s, so it takes over and finishes the job.
    const b = new JobRunner({ registry, owner: 'runner-b', hostname: 'host-b.test', pid: 2222, isPidAlive: () => true });
    const rb = await b.resume(secondProcess(), job.id);
    expect(rb.recovered.map((x) => x.jobId)).toEqual([job.id]);
    expect(rb.results[0]!.outcome).toBe('succeeded');

    gate.resolve();
    const ra = await pa;
    expect(ra).toMatchObject({ outcome: 'interrupted', error: { code: 'SUPERSEDED' } });
    const final = getJob(ctx.db, ctx.siteId, job.id)!;
    expect(final).toMatchObject({ status: 'succeeded', attempt: 2, result: { attempt: 2 } });
    const runs = listJobRuns(ctx.db, ctx.siteId, job.id);
    expect(runs.map((x) => [x.attempt, x.status])).toEqual([
      [1, 'interrupted'],
      [2, 'succeeded'],
    ]);
    expect(runs[0]!.error?.code).toBe('SUPERSEDED');
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeUndefined();
    expect(ctx.db.get("SELECT id FROM audit_events WHERE event_type = 'job.run_superseded' AND subject_id = ?", [job.id])).toBeTruthy();
  });

  it('a cancelled stage that ignores its signal keeps the site lock until it settles; no other job overlaps it', async () => {
    let running = 0;
    let maxRunning = 0;
    const started = deferred();
    const track = async (ms: number) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
    };
    registry.register(
      workflowJobHandler({
        type: 'weekly',
        description: 'synthetic',
        workflow: 'weekly',
        abortGraceMs: 30,
        stages: chain([stage('slow', { timeoutMs: 5_000, run: async () => (started.resolve(), await track(250), { value: 1 }) })]),
      }),
    );
    registry.register(workflowJobHandler({ type: 'monthly', description: 'synthetic', workflow: 'monthly', stages: chain([stage('quick', { run: async () => (await track(5), { value: 2 }) })]) }));
    const runner = new JobRunner({ registry, owner: 'runner-a', cancelPollMs: 5 });
    const job1 = enqueue(ctx, 'weekly', {});
    const job2 = enqueue(ctx, 'monthly', {});
    const p1 = runner.runJob(ctx, job1.id);
    await started.promise;
    requestCancel(secondProcess(), job1.id);
    const r1 = await p1;
    expect(r1.outcome).toBe('cancelled');
    expect(getJob(ctx.db, ctx.siteId, job1.id)!.error?.hint).toMatch(/lock stays held until it settles/);
    expect(runner.pendingLockHolds).toBe(1);
    expect(getSiteLock(ctx.db, ctx.siteId)).toMatchObject({ owner: 'runner-a', jobId: job1.id });
    expect((await runner.runJob(ctx, job2.id)).outcome).toBe('locked');

    await runner.settled();
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeUndefined();
    expect((await runner.runJob(ctx, job2.id)).outcome).toBe('succeeded');
    expect(maxRunning).toBe(1);
    const events = ctx.db.all<{ event_type: string }>("SELECT event_type FROM audit_events WHERE event_type LIKE 'lock.%orphaned%' ORDER BY id").map((e) => e.event_type);
    expect(events).toEqual(['lock.held_for_orphaned_work', 'lock.released_after_orphaned_work']);
  });

  it('an interrupted job whose orphaned stage is still running is not re-run (same runner, same job) until it settles', async () => {
    let calls = 0;
    const started = deferred();
    registry.register(
      workflowJobHandler({
        type: 'weekly',
        description: 'synthetic',
        workflow: 'weekly',
        abortGraceMs: 20,
        stages: chain([stage('slow', { run: async () => (calls++, started.resolve(), await new Promise((r) => setTimeout(r, 150)), { value: 1 }) })]),
      }),
    );
    const runner = new JobRunner({ registry });
    const job = enqueue(ctx, 'weekly', {});
    const shutdown = new AbortController();
    const p = runner.runJob(ctx, job.id, { signal: shutdown.signal });
    await started.promise;
    shutdown.abort();
    expect((await p).outcome).toBe('interrupted');
    expect((await runner.runJob(ctx, job.id)).outcome).toBe('locked');
    expect(calls).toBe(1);
    await runner.settled();
    expect((await runner.runJob(ctx, job.id)).outcome).toBe('succeeded');
    expect(calls).toBe(2);
  });

  it('a cancelled stage that stops within the grace period is awaited before the lock is released', async () => {
    const started = deferred();
    let finished = false;
    registry.register(
      workflowJobHandler({
        type: 'weekly',
        description: 'synthetic',
        workflow: 'weekly',
        abortGraceMs: 2_000,
        stages: chain([stage('slowish', { run: async () => (started.resolve(), await new Promise((r) => setTimeout(r, 80)), (finished = true), { value: 1 }) })]),
      }),
    );
    const runner = new JobRunner({ registry, cancelPollMs: 5 });
    const job = enqueue(ctx, 'weekly', {});
    const p = runner.runJob(ctx, job.id);
    await started.promise;
    requestCancel(secondProcess(), job.id);
    expect((await p).outcome).toBe('cancelled');
    expect(finished).toBe(true);
    expect(runner.pendingLockHolds).toBe(0);
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeUndefined();
  });

  it('a job waiting for review continues only after `resume --reviewed <stage>` records the review', async () => {
    let publishRuns = 0;
    registry.register(
      workflowJobHandler({
        type: 'content',
        description: 'synthetic',
        workflow: 'content',
        stages: chain(
          [
            stage('draft', { stoppingConditions: ['review'], shouldStop: () => ({ stop: true, reason: 'human review is required', status: 'needs_review' }) }),
            stage('publish_prep', { prerequisites: ['draft'], run: async () => ((publishRuns++), { value: 2 }) }),
          ],
          ['needs_review'],
        ),
      }),
    );
    const runner = new JobRunner({ registry });
    const job = enqueue(ctx, 'content', {});
    const r1 = await runner.runJob(ctx, job.id);
    expect(r1).toMatchObject({ outcome: 'waiting' });
    if (r1.outcome === 'waiting') expect(r1.reason).toMatch(/jobs resume .* --reviewed draft/);
    expect((await runner.resume(ctx, job.id)).results[0]!.outcome).toBe('waiting');
    await expect(runner.resume(ctx, job.id, { reviewedStage: 'publish_prep' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(publishRuns).toBe(0);
    // A review is a human decision: the default automation actor and automation names are refused, nothing is recorded.
    for (const actor of [undefined, 'cli', 'owner:system', 'owner:claude', 'owner:']) {
      await expect(runner.resume(ctx, job.id, { reviewedStage: 'draft', ...(actor !== undefined ? { actor } : {}) }), String(actor)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'workflow.stage_reviewed'")!.n).toBe(0);
    expect(publishRuns).toBe(0);

    const r = await runner.resume(ctx, job.id, { reviewedStage: 'draft', actor: 'owner:synthetic-reviewer' });
    expect(r.review).toMatchObject({ stage: 'draft', reviewer: 'owner:synthetic-reviewer' });
    expect(r.results[0]!.outcome).toBe('succeeded');
    expect(publishRuns).toBe(1);
    const audit = ctx.db.get<{ actor: string }>("SELECT actor FROM audit_events WHERE event_type = 'workflow.stage_reviewed'");
    expect(audit?.actor).toBe('owner:synthetic-reviewer');
    await expect(runner.resume(ctx, job.id, { reviewedStage: 'draft' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('a job refused by an open circuit breaker is not retried before the breaker allows a probe', async () => {
    registry.register(workflowJobHandler({ type: 'weekly', description: 'synthetic', workflow: 'weekly', stages: chain([stage('reddit', { providers: ['apify'] })]) }));
    const runner = new JobRunner({ registry, backoff: noJitter, breakers: { failureThreshold: 1, cooldownMs: 15 * 60_000 } });
    new CircuitBreakers(ctx.db, ctx.siteId, ctx.clock, { failureThreshold: 1, cooldownMs: 15 * 60_000 }).recordFailure('apify', new AppError('PROVIDER_ERROR', 'synthetic'));
    const r = await runner.runJob(ctx, enqueue(ctx, 'weekly', {}).id);
    // Backoff alone would say 09:01; the breaker's next probe is 09:15.
    expect(r).toMatchObject({ outcome: 'retry_scheduled', nextAttemptAt: '2026-09-24T09:15:00.000Z', error: { code: 'INTEGRATION_UNAVAILABLE' } });
  });
});

describe('scheduler: review fixes (automatic resume, blocked schedules, concurrent ticks)', () => {
  let ctx: TestContext;
  const extraDbs: Db[] = [];
  beforeEach(() => {
    ctx = createTestContext({ now: '2026-09-24T09:00:00.000Z' });
  });
  afterEach(() => {
    for (const d of extraDbs.splice(0)) d.close();
    ctx.cleanup();
  });

  /** A weekly handler that is "shut down" (external abort) while running, as often as `interruptions` says. */
  function interruptibleWeekly(interruptions: { left: number }) {
    let ctl = new AbortController();
    const registry = new JobRegistry().register(
      handler('weekly', async (c) => {
        if (interruptions.left > 0) {
          interruptions.left--;
          setTimeout(() => ctl.abort(), 5);
          await new Promise((resolve) => c.signal.addEventListener('abort', resolve));
        }
        return jobSucceeded({ attempt: c.attempt });
      }),
    );
    return {
      registry,
      /** One scheduler tick as a fresh process would run it (new runner, new shutdown signal). */
      tick: () => {
        ctl = new AbortController();
        return schedulerTick(ctx, { registry, runner: new JobRunner({ registry, maxMode: 'RESEARCH' }), signal: ctl.signal });
      },
    };
  }

  it('an interrupted scheduled job is resumed automatically by the next tick after a restart', async () => {
    const w = interruptibleWeekly({ left: 1 });
    enableSchedule(ctx, 'weekly');
    ctx.clock.set('2026-09-28T04:00:30.000Z');
    const t1 = await w.tick();
    expect(t1.items[0]).toMatchObject({ action: 'enqueued' });
    expect(t1.ran.map((r) => r.outcome)).toEqual(['interrupted']);
    const jobId = t1.items[0]!.jobId!;

    const t2 = await w.tick(); // restart: nothing due, but the interrupted job is resumed
    expect(t2.items).toEqual([]);
    expect(t2.ran.map((r) => r.outcome)).toEqual(['succeeded']);
    expect(getJob(ctx.db, ctx.siteId, jobId)).toMatchObject({ status: 'succeeded', attempt: 2 });
    expect(t2.needsAttention).toEqual([]);

    ctx.clock.set('2026-10-05T04:00:30.000Z'); // next week's slot runs normally
    const t3 = await w.tick();
    expect(t3.items[0]).toMatchObject({ action: 'enqueued' });
    expect(t3.ran.map((r) => r.outcome)).toEqual(['succeeded']);
  });

  it('automatic resume stops after repeated interruptions; the schedule is reported BLOCKED until a human acts', async () => {
    const w = interruptibleWeekly({ left: 10 });
    enableSchedule(ctx, 'weekly');
    ctx.clock.set('2026-09-28T04:00:30.000Z');
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) outcomes.push(...(await w.tick()).ran.map((r) => r.outcome));
    expect(outcomes).toEqual(['interrupted', 'interrupted', 'interrupted']);
    const jobId = listJobs(ctx.db, ctx.siteId)[0]!.id;

    const t4 = await w.tick();
    expect(t4.ran).toEqual([]);
    expect(t4.needsAttention).toEqual([expect.objectContaining({ jobId, reason: expect.stringMatching(/interrupted 3 times in a row/) })]);

    const view = describeSchedules(ctx, w.registry).schedules.find((s) => s.jobType === 'weekly')!;
    expect(view.blockedBy).toMatchObject({ jobId, autoResume: false, detail: expect.stringMatching(/^BLOCKED: .*jobs resume/) });

    ctx.clock.set('2026-10-05T04:00:30.000Z');
    const t5 = await w.tick();
    expect(t5.items[0]).toMatchObject({ action: 'skipped', reason: expect.stringMatching(/^BLOCKED: previous weekly job/) });
    expect(listJobs(ctx.db, ctx.siteId)).toHaveLength(1);
  });

  it('a job a human started (not by the scheduler) is never resumed automatically', async () => {
    const w = interruptibleWeekly({ left: 1 });
    const runner = new JobRunner({ registry: w.registry });
    const job = enqueue(ctx, 'weekly', { trigger: 'cli' });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 5);
    expect((await runner.runJob(ctx, job.id, { signal: ctl.signal })).outcome).toBe('interrupted');
    const t = await w.tick();
    expect(t.ran).toEqual([]);
    expect(t.needsAttention[0]?.reason).toMatch(/not started by the scheduler/);
    expect(getJob(ctx.db, ctx.siteId, job.id)?.status).toBe('interrupted');
  });

  it('automatic resume never reruns a paid stage that was in flight: the job stops with AMBIGUOUS_SUBMISSION', async () => {
    let paidCalls = 0;
    let ctl = new AbortController();
    const registry = new JobRegistry().register(
      workflowJobHandler({
        type: 'weekly',
        description: 'synthetic',
        workflow: 'weekly',
        abortGraceMs: 500,
        stages: chain([
          stage('collect'),
          stage('serp', {
            costAllowance: [{ provider: 'dataforseo', maxMicros: toMicros('0.05') }],
            run: (_i, c) =>
              new Promise((_res, rej) => {
                paidCalls++;
                c.signal.addEventListener('abort', () => rej(c.signal.reason));
                setTimeout(() => ctl.abort(), 5); // shutdown while the paid request is in flight
              }),
          }),
        ]),
      }),
    );
    const tick = () => {
      ctl = new AbortController();
      return schedulerTick(ctx, { registry, runner: new JobRunner({ registry }), signal: ctl.signal });
    };
    enableSchedule(ctx, 'weekly');
    ctx.clock.set('2026-09-28T04:00:30.000Z');
    expect((await tick()).ran.map((r) => r.outcome)).toEqual(['interrupted']);
    const t2 = await tick();
    expect(t2.ran).toEqual([expect.objectContaining({ outcome: 'failed', error: expect.objectContaining({ code: 'AMBIGUOUS_SUBMISSION' }) })]);
    expect(paidCalls).toBe(1);
    const jobId = listJobs(ctx.db, ctx.siteId)[0]!.id;
    expect(new CheckpointStore(ctx.db, ctx.clock).list(ctx.siteId, jobId).filter((c) => c.stage === 'collect' && c.status === 'succeeded')).toHaveLength(1);
  });

  it('two tick processes that read the same due slot concurrently: exactly one wins the compare-and-set', async () => {
    const registry = new JobRegistry().register(handler('weekly', async () => jobSucceeded()));
    enableSchedule(ctx, 'weekly');
    ctx.clock.set('2026-09-28T04:01:00.000Z');
    const db2 = openDatabase(ctx.db.file);
    extraDbs.push(db2);
    // Both ticks read `due` before either commits (forced interleaving).
    let arrived = 0;
    const both = deferred();
    const afterPlan = async () => {
      arrived++;
      if (arrived === 2) both.resolve();
      await both.promise;
    };
    const [a, b] = await Promise.all([schedulerTick(ctx, { registry, afterPlan }), schedulerTick({ ...ctx, db: db2 }, { registry, afterPlan })]);
    expect(arrived).toBe(2);
    expect([...a.items, ...b.items].filter((i) => i.action === 'enqueued')).toHaveLength(1);
    expect([...a.handledElsewhere, ...b.handledElsewhere]).toEqual([{ jobType: 'weekly', scheduledFor: '2026-09-28T04:00:00.000Z' }]);
    expect(listJobs(ctx.db, ctx.siteId)).toHaveLength(1);
  });
});
