import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderPipelineRun } from '../../../src/cli/commands/pipelines.js';
import { openDatabase, type Db } from '../../../src/database/db.js';
import { acquireSiteLock, releaseSiteLock } from '../../../src/jobs/locks.js';
import { JobRegistry } from '../../../src/jobs/registry.js';
import { JobRunner, enqueueAndRun } from '../../../src/jobs/runner.js';
import { describeSchedules, disableSchedule, enableSchedule, getSchedule, planSchedule, runSchedulerDaemon, schedulerTick } from '../../../src/jobs/scheduler.js';
import { enqueue, getJob, listJobs } from '../../../src/jobs/store.js';
import { jobSucceeded } from '../../../src/jobs/types.js';
import { runPipeline } from '../../../src/workflows/pipelines/handlers.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import { count, pipelineContext, testEnv } from '../pipelines/helpers.js';

describe('opt-in scheduler (schedules table, IANA zone, DST-aware ticks)', () => {
  let ctx: TestContext;
  let registry: JobRegistry;
  let ran: string[];
  const extraDbs: Db[] = [];
  beforeEach(() => {
    // Thursday 2026-09-24 09:00 UTC = 12:00 in Europe/Tallinn (EEST).
    ctx = createTestContext({ now: '2026-09-24T09:00:00.000Z' });
    ran = [];
    registry = new JobRegistry()
      .register({ type: 'weekly', description: 'synthetic weekly', run: async (c) => (ran.push(c.job.id), jobSucceeded({ params: c.job.params })) })
      .register({ type: 'monthly', description: 'synthetic monthly', run: async () => jobSucceeded() });
  });
  afterEach(() => {
    for (const d of extraDbs.splice(0)) d.close();
    ctx.cleanup();
  });

  it('nothing is scheduled until explicitly enabled', async () => {
    const overview = describeSchedules(ctx, registry);
    expect(overview.configTimezone).toBe('Europe/Tallinn');
    expect(overview.schedules.map((s) => [s.jobType, s.enabled])).toEqual([
      ['weekly', false],
      ['monthly', false],
    ]);
    ctx.clock.advanceMs(40 * 24 * 3_600_000);
    const tick = await schedulerTick(ctx, { registry, runner: new JobRunner({ registry }) });
    expect(tick.items).toEqual([]);
    expect(listJobs(ctx.db, ctx.siteId)).toEqual([]);
  });

  it('enable uses the site config cron and IANA zone and computes the next run in that zone', () => {
    const { schedule, plan } = enableSchedule(ctx, 'weekly');
    expect(schedule).toMatchObject({ jobType: 'weekly', cron: '0 7 * * 1', timezone: 'Europe/Tallinn', enabled: true, mode: 'ANALYZE', catchUp: 'once', nextRunAt: '2026-09-28T04:00:00.000Z' });
    expect(plan.nextRunLocal).toBe('Mon 2026-09-28 07:00 GMT+3 (Europe/Tallinn)');
    expect(plan.sources).toEqual({ cron: 'site-config', timezone: 'site-config' });
    expect(plan.spendingCaps.join('\n')).toMatch(/ANALYZE mode: no paid external research/);
    const audit = ctx.db.get<{ event_type: string }>("SELECT event_type FROM audit_events WHERE event_type = 'schedule.enabled'");
    expect(audit).toBeTruthy();
  });

  it('a schedule enabled before the October DST change keeps 07:00 local time after it', () => {
    ctx.clock.set('2026-10-20T12:00:00.000Z');
    const { schedule } = enableSchedule(ctx, 'weekly');
    expect(schedule.nextRunAt).toBe('2026-10-26T05:00:00.000Z'); // 07:00 EET (winter time)
    const monthly = enableSchedule(ctx, 'monthly').schedule;
    expect(monthly.nextRunAt).toBe('2026-11-02T06:00:00.000Z'); // 08:00 EET
  });

  it('validates schedule input: job type, unattended modes, cron, and zone', () => {
    expect(() => enableSchedule(ctx, 'baseline')).toThrow(/Only weekly and monthly/);
    expect(() => enableSchedule(ctx, 'weekly', { mode: 'DRAFT' })).toThrow(/ANALYZE or RESEARCH/);
    expect(() => enableSchedule(ctx, 'weekly', { mode: 'EXECUTE' })).toThrow(/never|ANALYZE or RESEARCH/);
    expect(() => enableSchedule(ctx, 'weekly', { cron: '61 7 * * 1' })).toThrow(/Invalid cron/);
    expect(() => enableSchedule(ctx, 'weekly', { timezone: 'UTC+3' })).toThrow(/IANA/);
    expect(() => enableSchedule(ctx, 'weekly', { catchUp: 'always' })).toThrow(/catch-up/);
    expect(getSchedule(ctx.db, ctx.siteId, 'weekly')).toBeUndefined();
    expect(planSchedule(ctx, 'weekly', { mode: 'research', cron: '15 6 * * 2', timezone: 'America/New_York' })).toMatchObject({ mode: 'RESEARCH', cron: '15 6 * * 2', timezone: 'America/New_York', sources: { cron: 'flag', timezone: 'flag' } });
  });

  it('a due tick enqueues exactly once, runs the job, and advances to the next slot', async () => {
    enableSchedule(ctx, 'weekly', { mode: 'RESEARCH' });
    const runner = new JobRunner({ registry, maxMode: 'RESEARCH' });
    expect((await schedulerTick(ctx, { registry, runner })).items).toEqual([]); // not due yet

    ctx.clock.set('2026-09-28T04:00:30.000Z');
    const t1 = await schedulerTick(ctx, { registry, runner });
    expect(t1.items).toEqual([expect.objectContaining({ jobType: 'weekly', action: 'enqueued', scheduledFor: '2026-09-28T04:00:00.000Z', missedSlots: 0, nextRunAt: '2026-10-05T04:00:00.000Z' })]);
    expect(t1.ran.map((r) => r.outcome)).toEqual(['succeeded']);
    const job = listJobs(ctx.db, ctx.siteId)[0]!;
    expect(job).toMatchObject({ type: 'weekly', mode: 'RESEARCH', status: 'succeeded', params: { trigger: 'schedule', scheduledFor: '2026-09-28T04:00:00.000Z', timezone: 'Europe/Tallinn' } });
    expect(getSchedule(ctx.db, ctx.siteId, 'weekly')).toMatchObject({ lastJobId: job.id, nextRunAt: '2026-10-05T04:00:00.000Z' });

    const t2 = await schedulerTick(ctx, { registry, runner });
    expect(t2.items).toEqual([]);
    expect(ran).toHaveLength(1);
  });

  it('after the machine slept through several slots, catch-up "once" runs one job; "skip" runs none', async () => {
    enableSchedule(ctx, 'weekly');
    ctx.clock.set('2026-10-20T10:00:00.000Z'); // slots 09-28, 10-05, 10-12, 10-19 were missed
    const t = await schedulerTick(ctx, { registry, runner: new JobRunner({ registry }) });
    expect(t.items).toEqual([expect.objectContaining({ action: 'enqueued', scheduledFor: '2026-09-28T04:00:00.000Z', missedSlots: 3, nextRunAt: '2026-10-26T05:00:00.000Z' })]);
    expect(listJobs(ctx.db, ctx.siteId)).toHaveLength(1);

    enableSchedule(ctx, 'monthly', { catchUp: 'skip' });
    ctx.clock.set('2026-11-05T10:00:00.000Z');
    const t2 = await schedulerTick(ctx, { registry });
    const monthly = t2.items.find((i) => i.jobType === 'monthly')!;
    expect(monthly).toMatchObject({ action: 'skipped', reason: expect.stringMatching(/catch-up policy "skip"/), nextRunAt: '2026-12-02T06:00:00.000Z' });
  });

  it('skips honestly when no handler is registered or a previous run is still active', async () => {
    const empty = new JobRegistry();
    enableSchedule(ctx, 'weekly');
    ctx.clock.set('2026-09-28T04:05:00.000Z');
    const t = await schedulerTick(ctx, { registry: empty });
    expect(t.items[0]).toMatchObject({ action: 'skipped', reason: expect.stringMatching(/no job handler is registered for "weekly"/) });
    expect(listJobs(ctx.db, ctx.siteId)).toEqual([]);
    expect(getSchedule(ctx.db, ctx.siteId, 'weekly')!.lastNote).toMatch(/no job handler/);

    // A job the scheduler queued earlier (not yet run) blocks the next slot.
    const stuck = enqueue(ctx, 'weekly', { trigger: 'schedule' });
    ctx.clock.set('2026-10-05T04:05:00.000Z');
    const t2 = await schedulerTick(ctx, { registry });
    expect(t2.items[0]).toMatchObject({ action: 'skipped', reason: expect.stringContaining(stuck.id) });
  });

  // B5-03 (spec 27: scheduling is opt-in, runs never overlap; spec 24/25: RESEARCH spend only when the operator runs it).
  it('a foreground run refused with LOCKED leaves no runnable job; a later tick neither runs it nor skips its slot', async () => {
    enableSchedule(ctx, 'weekly', { mode: 'RESEARCH' });
    // Another process holds the site lock (e.g. a long manual command).
    const other = { siteId: ctx.siteId, owner: 'manual(crawl)@other-host.test:4242:synth001', jobId: null };
    expect(acquireSiteLock(ctx.db, { ...other, leaseMs: 60_000, now: ctx.clock.now() }).acquired).toBe(true);

    const refused = await enqueueAndRun(ctx, new JobRunner({ registry }), 'weekly', {}, { mode: 'RESEARCH', actor: 'cli', retryInline: false });
    expect(refused.outcome).toBe('locked');
    expect(refused.job).toMatchObject({ status: 'cancelled', attempt: 0, error: { code: 'LOCKED', message: expect.stringMatching(/manual command "crawl".*did not run and was closed as cancelled, so nothing was left queued/) } });
    expect(listJobs(ctx.db, ctx.siteId, { status: ['queued', 'running', 'interrupted', 'waiting'] })).toEqual([]);
    expect(ctx.db.get<{ actor: string }>("SELECT actor FROM audit_events WHERE event_type = 'job.cancelled' AND subject_id = ?", [refused.job.id])?.actor).toBe('cli');
    expect(ran).toEqual([]);

    releaseSiteLock(ctx.db, { ...other });
    ctx.clock.set('2026-09-28T04:00:30.000Z');
    const t = await schedulerTick(ctx, { registry, runner: new JobRunner({ registry, maxMode: 'RESEARCH' }) });
    expect(t.items).toEqual([expect.objectContaining({ jobType: 'weekly', action: 'enqueued' })]);
    const scheduled = t.items[0]!.jobId!;
    expect(t.ran.map((r) => [r.job.id, r.outcome])).toEqual([[scheduled, 'succeeded']]);
    expect(ran).toEqual([scheduled]);
    expect(getJob(ctx.db, ctx.siteId, refused.job.id)?.status).toBe('cancelled');
  });

  it('a queued job a human started is never run by a tick, never skips a slot, and is reported for attention', async () => {
    enableSchedule(ctx, 'weekly');
    // e.g. a retry a foreground `weekly` left queued, or a job enqueued by an older version.
    const manual = enqueue(ctx, 'weekly', { trigger: 'cli' });
    expect(describeSchedules(ctx, registry).schedules.find((v) => v.jobType === 'weekly')!.blockedBy).toBeNull();
    ctx.clock.set('2026-09-28T04:00:30.000Z');
    const t = await schedulerTick(ctx, { registry, runner: new JobRunner({ registry }) });
    expect(t.items).toEqual([expect.objectContaining({ action: 'enqueued' })]);
    expect(ran).toEqual([t.items[0]!.jobId]);
    expect(getJob(ctx.db, ctx.siteId, manual.id)?.status).toBe('queued');
    expect(t.needsAttention).toEqual([expect.objectContaining({ jobId: manual.id, status: 'queued', reason: expect.stringMatching(/not started by the scheduler.*jobs resume .*jobs cancel/) })]);
    // A human still runs it explicitly.
    const resumed = await new JobRunner({ registry }).resume(ctx, manual.id);
    expect(resumed.results[0]!.outcome).toBe('succeeded');
  });

  it('two tick processes never enqueue the same slot twice (compare-and-set)', async () => {
    enableSchedule(ctx, 'weekly');
    ctx.clock.set('2026-09-28T04:01:00.000Z');
    const db2 = openDatabase(ctx.db.file);
    extraDbs.push(db2);
    const [a, b] = await Promise.all([schedulerTick(ctx, { registry }), schedulerTick({ ...ctx, db: db2 }, { registry })]);
    expect([...a.items, ...b.items].filter((i) => i.action === 'enqueued')).toHaveLength(1);
    expect(listJobs(ctx.db, ctx.siteId)).toHaveLength(1);
  });

  it('dry-run ticks report without writing; disable stops future slots', async () => {
    enableSchedule(ctx, 'weekly');
    ctx.clock.set('2026-09-28T04:01:00.000Z');
    const dry = await schedulerTick(ctx, { registry, dryRun: true });
    expect(dry.items).toEqual([expect.objectContaining({ action: 'would_enqueue' })]);
    expect(listJobs(ctx.db, ctx.siteId)).toEqual([]);
    expect(getSchedule(ctx.db, ctx.siteId, 'weekly')!.nextRunAt).toBe('2026-09-28T04:00:00.000Z');

    expect(disableSchedule(ctx, 'weekly').changed).toBe(true);
    expect(disableSchedule(ctx, 'weekly').changed).toBe(false);
    expect((await schedulerTick(ctx, { registry })).items).toEqual([]);
  });

  it('describeSchedules reports upcoming local runs, handler availability, and config drift', () => {
    const cfg = testSiteConfig({ scheduler: { timezone: 'Europe/Tallinn', weekly: { enabled: true, cron: '0 7 * * 1' }, monthly: { enabled: false, cron: '0 8 2 * *' } } });
    const c2 = createTestContext({ config: cfg, now: '2026-10-20T12:00:00.000Z' });
    try {
      const before = describeSchedules(c2, new JobRegistry());
      expect(before.schedules[0]!.drift.join()).toMatch(/prefers weekly scheduling, but it is not enabled/);
      enableSchedule(c2, 'weekly', { cron: '30 7 * * 1' });
      const after = describeSchedules(c2, new JobRegistry(), { upcoming: 2 });
      const weekly = after.schedules[0]!;
      expect(weekly.enabled).toBe(true);
      expect(weekly.handlerRegistered).toBe(false);
      expect(weekly.upcoming).toEqual(['Mon 2026-10-26 07:30 GMT+2 (Europe/Tallinn)', 'Mon 2026-11-02 07:30 GMT+2 (Europe/Tallinn)']);
      expect(weekly.drift.join()).toMatch(/cron is "0 7 \* \* 1" but the enabled schedule uses "30 7 \* \* 1"/);
      expect(after.notes.join()).toMatch(/sleeping, powered-off, or offline machine cannot run jobs/);
    } finally {
      c2.cleanup();
    }
  });

  it('the foreground daemon ticks until stopped', async () => {
    enableSchedule(ctx, 'weekly');
    ctx.clock.set('2026-09-28T04:01:00.000Z');
    const ticks: number[] = [];
    const r = await runSchedulerDaemon({ contexts: [ctx], registry, runner: new JobRunner({ registry }), tickMs: 1, maxTicks: 3, onTick: (res) => ticks.push(res[0]!.items.length) });
    expect(r.ticks).toBe(3);
    expect(ticks).toEqual([1, 0, 0]);
    expect(ran).toHaveLength(1);

    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 20);
    const stopped = await runSchedulerDaemon({ contexts: [ctx], registry, runner: new JobRunner({ registry }), tickMs: 5, signal: ctl.signal });
    expect(stopped.ticks).toBeGreaterThanOrEqual(1);
  });
});

describe('foreground pipeline refused with LOCKED (B5-03)', () => {
  let pctx: TestContext | undefined;
  afterEach(() => {
    pctx?.cleanup();
    pctx = undefined;
  });

  it('runPipeline closes the job it enqueued and says nothing was left queued', async () => {
    pctx = pipelineContext();
    const holder = { siteId: pctx.siteId, owner: 'manual(sync gsc)@other-host.test:4242:synth002', jobId: null };
    expect(acquireSiteLock(pctx.db, { ...holder, leaseMs: 60_000, now: pctx.clock.now() }).acquired).toBe(true);
    const env = testEnv();
    const r = await runPipeline(pctx, 'weekly', {}, { env });
    expect(r.outcome).toBe('locked');
    expect(r.jobStatus).toBe('cancelled');
    expect(r.error).toMatchObject({ code: 'LOCKED', message: expect.stringMatching(/manual command "sync gsc".*nothing was left queued/), hint: expect.stringMatching(/run the command again/) });
    expect(count(pctx, "SELECT COUNT(*) AS n FROM jobs WHERE site_id = ? AND status IN ('queued', 'running', 'interrupted')", [pctx.siteId])).toBe(0);
    expect(count(pctx, 'SELECT COUNT(*) AS n FROM job_runs WHERE site_id = ?', [pctx.siteId])).toBe(0);
    const text = renderPipelineRun(r);
    expect(text.split('\n')[0]).toMatch(/Weekly pipeline, job job_\w+ \(mode ANALYZE\): locked/);
    // A manual command holds the lease: the next step names `jobs locks` (C4-07), never `jobs resume`.
    expect(text).toMatch(/Error \[LOCKED\]: .*nothing was left queued\.\nNext step: Wait for that command to finish, then run the command again\. `npm run cli -- jobs locks` shows the lease/);
    expect(text).toContain('jobs locks --release site --as "<your name>"');
    expect(text).not.toMatch(/jobs resume/);
  });
});
