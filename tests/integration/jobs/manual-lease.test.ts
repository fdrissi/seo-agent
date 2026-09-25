import { spawn, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../../src/database/db.js';
import { acquireSiteLock, getSiteLock } from '../../../src/jobs/locks.js';
import {
  MANUAL_HEARTBEAT_MS,
  MANUAL_LOCAL_STALE_AFTER_MS,
  ManualSiteLease,
  currentProcessStartedAt,
  defaultIsPidAlive,
  defaultProcessStartedAt,
  describeLeaseHolder,
  leaseHolderAliveReason,
  leaseHolderLiveness,
  manualLeaseOwner,
  parseElapsedTime,
  parseManualLeaseOwner,
  releaseDeadLease,
  unrenewedLeaseSeenAt,
} from '../../../src/jobs/manual-lease.js';
import { JobRegistry } from '../../../src/jobs/registry.js';
import { JobRunner } from '../../../src/jobs/runner.js';
import { enqueue, getJob } from '../../../src/jobs/store.js';
import { jobSucceeded } from '../../../src/jobs/types.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

/**
 * The manual-command lease (src/jobs/manual-lease.ts) is a `site_locks` lease
 * like a job's: atomic acquisition, heartbeats, release, and no takeover of an
 * expired lease while its holder process is alive on this host.
 */

const HOST = 'host-a.test';

describe('manual site lease (jobs lock API)', () => {
  let ctx: TestContext;
  const extraDbs: Db[] = [];
  beforeEach(() => {
    ctx = createTestContext({ now: '2026-09-24T09:00:00.000Z' });
  });
  afterEach(() => {
    for (const d of extraDbs.splice(0)) d.close();
    ctx.cleanup();
  });
  const secondConnection = () => {
    const db2 = openDatabase(ctx.db.file);
    extraDbs.push(db2);
    return db2;
  };
  const acquire = (db: Db, extra: Partial<Parameters<typeof ManualSiteLease.acquire>[1]> = {}) =>
    ManualSiteLease.acquire(db, { siteId: ctx.siteId, command: 'crawl', clock: ctx.clock, hostname: HOST, pid: 101, isPidAlive: () => true, heartbeatMs: 0, ...extra });

  it('owner strings name the command and process and round-trip', () => {
    const owner = manualLeaseOwner('sync gsc', { hostname: HOST, pid: 42 }, 'abc123');
    expect(owner).toBe('manual(sync gsc)@host-a.test:42:abc123');
    expect(parseManualLeaseOwner(owner)).toEqual({ command: 'sync gsc', hostname: HOST, pid: 42, nonce: 'abc123' });
    expect(parseManualLeaseOwner('host-a.test:42:runner01')).toBeNull();
  });

  it('acquires the site lease without a job id, renews it, and releases it on the last connection', () => {
    const r = acquire(ctx.db);
    expect(r.acquired).toBe(true);
    if (!r.acquired) return;
    const lock = getSiteLock(ctx.db, ctx.siteId)!;
    expect(lock).toMatchObject({ lockName: 'site', jobId: null, owner: r.lease.owner, expiresAt: '2026-09-24T09:01:30.000Z' });

    ctx.clock.advanceMs(30_000);
    expect(r.lease.renew()).toBe(true);
    expect(getSiteLock(ctx.db, ctx.siteId)!.expiresAt).toBe('2026-09-24T09:02:00.000Z');

    // A second connection of the same invocation shares the lease.
    const db2 = secondConnection();
    expect(r.lease.join(db2)).toBe(true);
    expect(r.lease.connections).toBe(2);
    r.lease.leave(ctx.db);
    expect(getSiteLock(ctx.db, ctx.siteId)?.owner).toBe(r.lease.owner);
    r.lease.leave(db2);
    expect(r.lease.held).toBe(false);
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeUndefined();
    expect(r.lease.release()).toBe(false); // idempotent
  });

  it('is refused while a job holds a live lease, naming the job', () => {
    const job = enqueue(ctx, 'weekly', {});
    expect(acquireSiteLock(ctx.db, { siteId: ctx.siteId, owner: 'runner:synthetic', jobId: job.id, leaseMs: 90_000, now: ctx.clock.now() }).acquired).toBe(true);
    const r = acquire(secondConnection());
    expect(r.acquired).toBe(false);
    if (r.acquired) return;
    expect(r.holder).toBe(`job ${job.id}`);
    expect(r.heldBy.jobId).toBe(job.id);
    expect(r.aliveReason).toBeNull();
  });

  it('two manual commands never hold the lease at once', () => {
    const a = acquire(ctx.db, { command: 'crawl', pid: 101 });
    expect(a.acquired).toBe(true);
    const b = acquire(secondConnection(), { command: 'sync gsc', pid: 102 });
    expect(b.acquired).toBe(false);
    if (b.acquired) return;
    expect(b.holder).toBe('manual command "crawl"');
    expect(describeLeaseHolder(b.heldBy)).toBe('manual command "crawl"');
  });

  it('a JobRunner does not take over an expired manual lease while the command process is alive on this host', async () => {
    const r = acquire(ctx.db, { pid: 555 });
    expect(r.acquired).toBe(true);
    let ran = 0;
    const registry = new JobRegistry().register({ type: 'synthetic_site_job', description: 'synthetic', run: async () => (ran++, jobSucceeded()) });
    const job = enqueue(ctx, 'synthetic_site_job', {});
    ctx.clock.advanceMs(10 * 60_000); // lease expired (e.g. the laptop slept through the heartbeats)

    const alive = new JobRunner({ registry, hostname: HOST, pid: 777, isPidAlive: (pid) => pid === 555 });
    const locked = await alive.runJob(ctx, job.id);
    expect(locked.outcome).toBe('locked');
    expect(ran).toBe(0);
    expect(alive.lockHolderAliveReason(ctx, getSiteLock(ctx.db, ctx.siteId)!)).toMatch(/manual command "crawl" \(process 555 on host-a\.test\) is alive/);

    // Once the command process is gone, the expired lease is taken over (and audited).
    const dead = new JobRunner({ registry, hostname: HOST, pid: 778, isPidAlive: () => false });
    expect((await dead.runJob(ctx, job.id)).outcome).toBe('succeeded');
    expect(ran).toBe(1);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE site_id = ? AND event_type = 'lock.takeover'", [ctx.siteId])?.n).toBe(1);

    // The manual holder notices on its next heartbeat and reports the loss once.
    const lost: string[] = [];
    const again = acquire(ctx.db, { pid: 556, onLost: (m) => lost.push(m) });
    expect(again.acquired).toBe(true);
    if (!again.acquired) return;
    ctx.db.run('UPDATE site_locks SET owner = ? WHERE site_id = ?', ['other-runner:1', ctx.siteId]);
    expect(again.lease.renew()).toBe(false);
    expect(again.lease.renew()).toBe(false);
    expect(again.lease.lost).toBe(true);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatch(/was lost/);
  });

  it('an expired manual lease on another host, or a stale local one, may be taken over', () => {
    const lock = { siteId: ctx.siteId, lockName: 'site', owner: manualLeaseOwner('crawl', { hostname: 'other-host.test', pid: 9 }), jobId: null, acquiredAt: '2026-09-24T08:00:00.000Z', heartbeatAt: '2026-09-24T08:00:00.000Z', expiresAt: '2026-09-24T08:01:30.000Z' };
    const check = { hostname: HOST, isPidAlive: () => true, now: ctx.clock.now(), localStaleAfterMs: 6 * 3_600_000 };
    expect(leaseHolderAliveReason(ctx.db, ctx.siteId, lock, check)).toBeNull();
    const local = { ...lock, owner: manualLeaseOwner('crawl', { hostname: HOST, pid: 9 }) };
    expect(leaseHolderAliveReason(ctx.db, ctx.siteId, local, check)).toMatch(/is alive/);
    expect(leaseHolderAliveReason(ctx.db, ctx.siteId, local, { ...check, localStaleAfterMs: 30 * 60_000 })).toBeNull(); // heartbeat 1 h old: hung
  });

  it('a manual command does not take over the expired lease of a job still running in a live local process', () => {
    const job = enqueue(ctx, 'weekly', {});
    const heartbeat = ctx.clock.now().toISOString();
    expect(acquireSiteLock(ctx.db, { siteId: ctx.siteId, owner: `${HOST}:4242:runner01`, jobId: job.id, leaseMs: 90_000, now: ctx.clock.now() }).acquired).toBe(true);
    ctx.db.run("UPDATE jobs SET status = 'running', attempt = 1, heartbeat_at = ?, lock_owner = ? WHERE id = ?", [heartbeat, `${HOST}:4242:runner01`, job.id]);
    ctx.db.run("INSERT INTO job_runs (id, job_id, site_id, attempt, status, pid, hostname, started_at) VALUES (?, ?, ?, 1, 'running', ?, ?, ?)", [`jrun_${job.id}`, job.id, ctx.siteId, 4242, HOST, heartbeat]);
    ctx.clock.advanceMs(5 * 60_000);

    const refused = acquire(ctx.db, { isPidAlive: (pid) => pid === 4242 });
    expect(refused.acquired).toBe(false);
    if (refused.acquired) return;
    expect(refused.aliveReason).toMatch(/holder process 4242 on host-a\.test is alive/);
    expect(getJob(ctx.db, ctx.siteId, job.id)?.status).toBe('running');

    const taken = acquire(ctx.db, { isPidAlive: () => false });
    expect(taken.acquired).toBe(true);
    if (!taken.acquired) return;
    expect(taken.takenOverFrom?.jobId).toBe(job.id);
  });

  // C4-07: the owner records the holder process's start time; old owner strings still parse.
  it('records the holder process start time in the owner and still parses owners written before', () => {
    const owner = manualLeaseOwner('crawl', { hostname: HOST, pid: 42, startedAt: 1_790_000_000_123 }, '01K5ABCD');
    expect(owner).toBe('manual(crawl)@host-a.test:42:01K5ABCD;start=1790000000123');
    expect(parseManualLeaseOwner(owner)).toEqual({ command: 'crawl', hostname: HOST, pid: 42, nonce: '01K5ABCD', startedAt: 1_790_000_000_123 });
    // Legacy (no start) and all-digit nonces stay unambiguous.
    expect(parseManualLeaseOwner('manual(sync gsc)@host-a.test:42:abc123')).toEqual({ command: 'sync gsc', hostname: HOST, pid: 42, nonce: 'abc123' });
    expect(parseManualLeaseOwner('manual(crawl)@host-a.test:42:123456;start=99')).toEqual({ command: 'crawl', hostname: HOST, pid: 42, nonce: '123456', startedAt: 99 });
    // A lease taken by this process records this process's start.
    const r = acquire(ctx.db, { pid: process.pid });
    expect(r.acquired).toBe(true);
    if (!r.acquired) return;
    expect(parseManualLeaseOwner(r.lease.owner)?.startedAt).toBe(currentProcessStartedAt());
    r.lease.release();
  });

  it('an expired manual lease whose pid now belongs to another process (pid reused after a crash) is taken over at once', () => {
    const holderStart = Date.parse('2026-09-24T08:00:00.000Z');
    const r = acquire(ctx.db, { pid: 555, startedAt: holderStart });
    expect(r.acquired).toBe(true);
    ctx.clock.advanceMs(5 * 60_000); // the holder crashed; its lease expired 3.5 minutes ago
    const lock = getSiteLock(ctx.db, ctx.siteId)!;
    const reused = { hostname: HOST, isPidAlive: () => true, now: ctx.clock.now(), localStaleAfterMs: 6 * 3_600_000, processStartedAt: () => Date.parse('2026-09-24T09:03:00.000Z') };
    expect(leaseHolderLiveness(ctx.db, ctx.siteId, lock, reused)).toMatchObject({ state: 'dead', pid: 555, detail: expect.stringMatching(/pid now belongs to another process/) });
    expect(leaseHolderAliveReason(ctx.db, ctx.siteId, lock, reused)).toBeNull();
    // The same pid with the recorded start time is the holder itself: still refused.
    const same = { ...reused, processStartedAt: () => holderStart + 800 };
    expect(leaseHolderLiveness(ctx.db, ctx.siteId, lock, same)).toMatchObject({ state: 'alive' });
    expect(leaseHolderAliveReason(ctx.db, ctx.siteId, lock, same)).toMatch(/manual command "crawl" \(process 555 on host-a\.test\) is alive/);

    const contender = acquire(secondConnection(), { command: 'sync gsc', pid: 777, isPidAlive: () => true, processStartedAt: reused.processStartedAt });
    expect(contender.acquired).toBe(true);
    if (!contender.acquired) return;
    expect(contender.takenOverFrom?.owner).toBe(lock.owner);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE site_id = ? AND event_type = 'lock.takeover'", [ctx.siteId])?.n).toBe(1);
  });

  it('a live holder that stays unrenewed a few heartbeats after a contender saw its lease expired counts as hung (a sleeping laptop does not)', () => {
    expect(MANUAL_LOCAL_STALE_AFTER_MS).toBe(4 * MANUAL_HEARTBEAT_MS);
    const holder = acquire(ctx.db, { pid: 555 });
    expect(holder.acquired).toBe(true);
    if (!holder.acquired) return;
    // The laptop slept for two hours: the heartbeat is old, the holder process is alive.
    ctx.clock.advanceMs(2 * 3_600_000);
    const first = acquire(secondConnection(), { command: 'sync gsc', pid: 777, isPidAlive: (pid) => pid === 555 });
    expect(first.acquired).toBe(false);
    if (first.acquired) return;
    expect(first.aliveReason).toMatch(/is alive .*seen unrenewed since 2026-09-24T11:00:00\.000Z, treated as hung 60s after that/);
    expect(first.holderLiveness).toMatchObject({ state: 'alive', pid: 555 });
    const lock = getSiteLock(ctx.db, ctx.siteId)!;
    expect(unrenewedLeaseSeenAt(ctx.db, ctx.siteId, lock)).toBe(Date.parse('2026-09-24T11:00:00.000Z'));

    // The woken holder renews within one heartbeat: the sighting no longer applies to its lease.
    ctx.clock.advanceMs(10_000);
    expect(holder.lease.renew()).toBe(true);
    ctx.clock.advanceMs(MANUAL_LOCAL_STALE_AFTER_MS);
    const whileRenewing = acquire(secondConnection(), { command: 'sync gsc', pid: 777, isPidAlive: (pid) => pid === 555 });
    expect(whileRenewing.acquired).toBe(false);

    // Now it hangs (stopped process): the lease expires, a contender sees it, and a few heartbeats later it is taken over.
    ctx.clock.advanceMs(5 * 60_000);
    const seen = acquire(secondConnection(), { command: 'sync gsc', pid: 777, isPidAlive: (pid) => pid === 555 });
    expect(seen.acquired).toBe(false);
    ctx.clock.advanceMs(MANUAL_LOCAL_STALE_AFTER_MS - 1_000);
    expect(acquire(secondConnection(), { command: 'sync gsc', pid: 777, isPidAlive: (pid) => pid === 555 }).acquired).toBe(false);
    ctx.clock.advanceMs(1_000);
    const taken = acquire(secondConnection(), { command: 'sync gsc', pid: 777, isPidAlive: (pid) => pid === 555 });
    expect(taken.acquired).toBe(true);
    // One sighting per lease heartbeat, audited.
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE site_id = ? AND event_type = 'lock.unrenewed_seen'", [ctx.siteId])?.n).toBe(2);
  });

  it('a JobRunner records the sighting too, and takes over a hung manual holder on a later attempt', async () => {
    const r = acquire(ctx.db, { pid: 555 });
    expect(r.acquired).toBe(true);
    let ran = 0;
    const registry = new JobRegistry().register({ type: 'synthetic_site_job', description: 'synthetic', run: async () => (ran++, jobSucceeded()) });
    const job = enqueue(ctx, 'synthetic_site_job', {});
    ctx.clock.advanceMs(10 * 60_000);
    const runner = new JobRunner({ registry, hostname: HOST, pid: 777, isPidAlive: (pid) => pid === 555 });
    expect((await runner.runJob(ctx, job.id)).outcome).toBe('locked');
    ctx.clock.advanceMs(MANUAL_LOCAL_STALE_AFTER_MS);
    expect((await runner.runJob(ctx, job.id)).outcome).toBe('succeeded');
    expect(ran).toBe(1);
  });

  it('releaseDeadLease removes only a lease whose holder is verified dead, audited as the named human', () => {
    const job = enqueue(ctx, 'weekly', {});
    const check = { hostname: HOST, isPidAlive: (pid: number) => pid === 555, now: ctx.clock.now() };
    expect(releaseDeadLease(ctx.db, ctx.siteId, 'site', check, 'owner:Jane Doe')).toMatchObject({ outcome: 'not_found' });

    expect(acquire(ctx.db, { pid: 555 }).acquired).toBe(true);
    expect(releaseDeadLease(ctx.db, ctx.siteId, 'site', check, 'owner:Jane Doe')).toMatchObject({ outcome: 'holder_alive', liveness: { state: 'alive', pid: 555 } });
    expect(releaseDeadLease(ctx.db, ctx.siteId, 'site', { ...check, hostname: 'other-host.test' }, 'owner:Jane Doe')).toMatchObject({ outcome: 'unverifiable' });
    const dead = { ...check, isPidAlive: () => false };
    expect(releaseDeadLease(ctx.db, ctx.siteId, 'site', dead, 'owner:Jane Doe', { dryRun: true })).toMatchObject({ outcome: 'would_release' });
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeDefined();
    const released = releaseDeadLease(ctx.db, ctx.siteId, 'site', dead, 'owner:Jane Doe');
    expect(released).toMatchObject({ outcome: 'released', liveness: { state: 'dead', detail: 'process 555 on host-a.test is no longer running' } });
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeUndefined();
    expect(ctx.db.get<{ actor: string; subject_id: string }>("SELECT actor, subject_id FROM audit_events WHERE site_id = ? AND event_type = 'lock.released_dead_holder'", [ctx.siteId])).toEqual({
      actor: 'owner:Jane Doe',
      subject_id: 'site',
    });

    // A lease of a job still recorded as running is left to `jobs cancel` / `jobs resume`.
    ctx.db.run("UPDATE jobs SET status = 'running', attempt = 1, heartbeat_at = ? WHERE id = ?", [ctx.clock.now().toISOString(), job.id]);
    ctx.db.run("INSERT INTO job_runs (id, job_id, site_id, attempt, status, pid, hostname, started_at) VALUES (?, ?, ?, 1, 'running', 999, ?, ?)", [`jrun_${job.id}`, job.id, ctx.siteId, HOST, ctx.clock.now().toISOString()]);
    expect(acquireSiteLock(ctx.db, { siteId: ctx.siteId, owner: `${HOST}:999:runner01`, jobId: job.id, leaseMs: 90_000, now: ctx.clock.now() }).acquired).toBe(true);
    expect(releaseDeadLease(ctx.db, ctx.siteId, 'site', dead, 'owner:Jane Doe')).toMatchObject({ outcome: 'job_running' });
    expect(getSiteLock(ctx.db, ctx.siteId)?.jobId).toBe(job.id);
  });

  it('reads process start times from the process table (ps), and reports unknown for a pid that does not exist', async () => {
    expect(parseElapsedTime('00:07')).toBe(7);
    expect(parseElapsedTime('01:02:03')).toBe(3_723);
    expect(parseElapsedTime('2-01:02:03')).toBe(2 * 86_400 + 3_723);
    expect(parseElapsedTime('garbage')).toBeNull();
    expect(defaultProcessStartedAt(process.pid)).toBe(currentProcessStartedAt());
    const gone = spawnSync(process.execPath, ['-e', '']).pid!;
    expect(defaultIsPidAlive(gone)).toBe(false);
    expect(defaultProcessStartedAt(gone)).toBeNull();
    if (process.platform === 'win32') return;
    const spawnedAt = Date.now();
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 1_200));
      const started = defaultProcessStartedAt(child.pid!);
      expect(started).not.toBeNull();
      expect(Math.abs(started! - spawnedAt)).toBeLessThan(3_000);
    } finally {
      child.kill();
    }
  });

  it('rejects a heartbeat interval that is not shorter than the lease', () => {
    expect(() => acquire(ctx.db, { leaseMs: 1_000, heartbeatMs: 1_000 })).toThrow(RangeError);
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeUndefined();
  });
});
