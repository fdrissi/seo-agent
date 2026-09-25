import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { register as registerJobs } from '../../../src/cli/commands/jobs.js';
import { register as registerSchedule } from '../../../src/cli/commands/schedule.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { databaseActivity } from '../../../src/database/backup.js';
import { acquireSiteLock, getSiteLock } from '../../../src/jobs/locks.js';
import { enqueue, getJob, listJobRuns } from '../../../src/jobs/store.js';
import type { RuntimeMode } from '../../../src/core/modes.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

/** Build only this slice's commands (other command modules are developed in parallel). */
async function runCli(root: string, args: string[]): Promise<{ out: string; err: string; exitCode: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const cli = new CliRuntime({ out: (t) => void out.push(t), err: (t) => void err.push(t) }, { ...process.env, SEO_AGENT_LOG_LEVEL: 'error' });
  const program = new Command()
    .option('-w, --workspace <dir>')
    .option('-s, --site <id>')
    .option('--dry-run')
    .option('--json')
    .option('--mode <mode>')
    .option('--offline')
    .exitOverride()
    .configureOutput({ writeErr: (s) => void err.push(s), writeOut: (s) => void out.push(s) });
  registerJobs(program, cli);
  registerSchedule(program, cli);
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'seo-agent', '--workspace', root, '--site', 'test-site', ...args]);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { out: out.join('\n'), err: err.join('\n'), exitCode };
}

describe('jobs and schedule CLI', () => {
  let ctx: TestContext;
  beforeEach(() => {
    process.env.SEO_AGENT_LOG_LEVEL = 'error';
    ctx = createTestContext();
  });
  afterEach(() => {
    delete process.env.SEO_AGENT_LOG_LEVEL;
    process.exitCode = undefined;
    ctx.cleanup();
  });

  it('schedule show / enable / disable (opt-in, IANA zone from config)', async () => {
    const show = await runCli(ctx.paths.root, ['schedule', 'show', '--json']);
    expect(show.exitCode).toBe(0);
    const overview = JSON.parse(show.out);
    expect(overview.configTimezone).toBe('Europe/Tallinn');
    expect(overview.schedules.map((s: { enabled: boolean }) => s.enabled)).toEqual([false, false]);

    const dry = await runCli(ctx.paths.root, ['--dry-run', 'schedule', 'enable', 'monthly', '--json']);
    expect(JSON.parse(dry.out)).toMatchObject({ dryRun: true, jobType: 'monthly', cron: '0 8 2 * *', timezone: 'Europe/Tallinn' });
    expect(ctx.db.get("SELECT id FROM schedules WHERE job_type = 'monthly'")).toBeUndefined();

    // Spec 30 step 8: no successful manual run is recorded yet, so enabling needs --force.
    const refused = await runCli(ctx.paths.root, ['schedule', 'enable', 'weekly', '--mode', 'RESEARCH']);
    expect(refused.exitCode).toBe(1);
    expect(refused.err).toMatch(/No successful weekly or baseline run is recorded for site test-site/);
    expect(refused.err).toMatch(/Error \[POLICY_DENIED\]: Not enabling the weekly schedule/);
    expect(refused.err).toMatch(/pass --force/);
    expect(ctx.db.get("SELECT id FROM schedules WHERE job_type = 'weekly'")).toBeUndefined();

    const en = await runCli(ctx.paths.root, ['schedule', 'enable', 'weekly', '--mode', 'RESEARCH', '--force']);
    expect(en.exitCode).toBe(0);
    expect(en.out).toMatch(/WARNING: No successful weekly or baseline run is recorded .* Enabled anyway because --force was given\./);
    expect(en.out).toMatch(/Enabled weekly schedule for test-site: cron "0 7 \* \* 1" in Europe\/Tallinn/);
    expect(en.out).toMatch(/Nothing was installed/);
    expect(en.out).toMatch(/WARNING: no "weekly" job handler is registered/);
    expect(en.out).toMatch(/Spending caps that bound each scheduled run/);
    expect(en.out).toMatch(/dataforseo: up to \$0\.50 per run, \$1\.00 per week, \$10\.00 per month/);
    expect(ctx.db.get<{ mode: string; enabled: number }>("SELECT mode, enabled FROM schedules WHERE job_type = 'weekly'")).toEqual({ mode: 'RESEARCH', enabled: 1 });

    const human = await runCli(ctx.paths.root, ['schedule', 'show']);
    expect(human.out).toMatch(/weekly: ENABLED\s+cron "0 7 \* \* 1" in Europe\/Tallinn, mode RESEARCH/);
    expect(human.out).toMatch(/Mon \d{4}-\d{2}-\d{2} 07:00 GMT\+\d \(Europe\/Tallinn\)/);

    const bad = await runCli(ctx.paths.root, ['schedule', 'enable', 'weekly', '--mode', 'DRAFT', '--force']);
    expect(bad.exitCode).toBe(1);
    expect(bad.err).toMatch(/ANALYZE or RESEARCH/);

    const dis = await runCli(ctx.paths.root, ['schedule', 'disable', 'weekly']);
    expect(dis.out).toMatch(/Disabled the weekly schedule/);
  });

  it('schedule instructions prints snippets and --write stores them for review only', async () => {
    const r = await runCli(ctx.paths.root, ['schedule', 'instructions', '--platform', 'launchd,cron', '--write', '--json']);
    expect(r.exitCode).toBe(0);
    const si = JSON.parse(r.out);
    expect(si.bundles.map((b: { platform: string }) => b.platform)).toEqual(['launchd', 'cron']);
    expect(si.tickCommand).toContain(`--workspace ${ctx.paths.root}`);
    expect(si.tickCommand).toContain('schedule run --once');
    expect(si.warnings.join()).toMatch(/No schedule is enabled yet/);
    expect(si.written).toHaveLength(3);
    for (const f of si.written as string[]) {
      expect(f.startsWith(path.join(ctx.paths.exportsDir, 'scheduling', 'test-site'))).toBe(true);
      expect(existsSync(f)).toBe(true);
    }
    expect(readFileSync(si.written[0], 'utf8')).toContain('<key>StartInterval</key>');
    const text = await runCli(ctx.paths.root, ['schedule', 'instructions', '--platform', 'systemd']);
    expect(text.out).toMatch(/sleeping, powered-off, or offline laptop cannot run jobs/);
    expect(text.out).toMatch(/OnCalendar=\*:0\/15/);
  });

  it('schedule run --once performs a single tick and exits', async () => {
    expect((await runCli(ctx.paths.root, ['schedule', 'enable', 'weekly', '--force'])).exitCode).toBe(0);
    const r = await runCli(ctx.paths.root, ['schedule', 'run', '--once', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.ticks).toHaveLength(1);
    expect(out.ticks[0].siteId).toBe('test-site');
    const dry = await runCli(ctx.paths.root, ['--dry-run', 'schedule', 'run', '--json']);
    expect(JSON.parse(dry.out)).toMatchObject({ dryRun: true });
  });

  it('jobs list / show / cancel / resume', async () => {
    const job = enqueue(ctx, 'weekly', { note: 'synthetic' });
    const list = await runCli(ctx.paths.root, ['jobs', 'list', '--json']);
    expect(JSON.parse(list.out).jobs).toEqual([expect.objectContaining({ id: job.id, type: 'weekly', status: 'queued' })]);

    const show = await runCli(ctx.paths.root, ['jobs', 'show', job.id]);
    expect(show.out).toMatch(new RegExp(`Job ${job.id}`));
    expect(show.out).toMatch(/Checkpoints \(stage results\):/);

    const dryCancel = await runCli(ctx.paths.root, ['--dry-run', 'jobs', 'cancel', job.id]);
    expect(dryCancel.out).toMatch(/Dry run: would cancel immediately/);

    const dryResume = await runCli(ctx.paths.root, ['--dry-run', 'jobs', 'resume', '--json']);
    expect(JSON.parse(dryResume.out).wouldResume).toEqual([expect.objectContaining({ id: job.id, handlerRegistered: false })]);

    const cancel = await runCli(ctx.paths.root, ['jobs', 'cancel', job.id, '--json']);
    expect(JSON.parse(cancel.out)).toMatchObject({ outcome: 'cancelled', previousStatus: 'queued' });

    const resumeCancelled = await runCli(ctx.paths.root, ['jobs', 'resume', job.id]);
    expect(resumeCancelled.exitCode).toBe(1);
    expect(resumeCancelled.err).toMatch(/was cancelled/);

    const nothing = await runCli(ctx.paths.root, ['jobs', 'resume']);
    expect(nothing.out).toMatch(/Nothing to resume/);

    const missing = await runCli(ctx.paths.root, ['jobs', 'show', 'job_does_not_exist', '--json']);
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.out).error.code).toBe('NOT_FOUND');

    const badStatus = await runCli(ctx.paths.root, ['jobs', 'list', '--status', 'exploded']);
    expect(badStatus.exitCode).toBe(1);
  });

  it('schedule enable requires a successful manual run with Google data (spec 30 step 8), or --force', async () => {
    const seed = (type: string, status: string, result: unknown, opts: { dryRun?: boolean } = {}) => {
      ctx.clock.advanceMs(60_000); // distinct creation times: "latest" is well defined
      const job = enqueue(ctx, type, { trigger: 'cli' });
      ctx.db.run('UPDATE jobs SET status = ?, result_json = ?, finished_at = ?, dry_run = ? WHERE id = ?', [status, JSON.stringify(result), '2026-09-20T08:00:00.000Z', opts.dryRun ? 1 : 0, job.id]);
      return job.id;
    };
    // A failed run and a dry run do not count.
    seed('weekly', 'failed', null);
    seed('weekly', 'succeeded', { stages: [], degraded: [] }, { dryRun: true });
    let r = await runCli(ctx.paths.root, ['schedule', 'enable', 'weekly']);
    expect(r.exitCode).toBe(1);
    expect(r.err).toMatch(/No successful weekly or baseline run/);

    // A succeeded run WITHOUT Google data (no credentials): still refused, naming the degraded stages.
    const degradedJob = seed('baseline', 'succeeded', { stages: [], degraded: [{ stage: 'sync_gsc', code: 'CREDENTIALS_MISSING', reason: 'x' }, { stage: 'sync_ga4', code: 'CREDENTIALS_MISSING', reason: 'x' }] });
    r = await runCli(ctx.paths.root, ['schedule', 'enable', 'weekly', '--json']);
    expect(r.exitCode).toBe(1);
    const err = JSON.parse(r.out) as { error: { code: string; details: { readiness: { ready: boolean; degradedStages: string[]; lastSuccessful: { jobId: string } } } } };
    expect(err.error.code).toBe('POLICY_DENIED');
    expect(err.error.details.readiness).toMatchObject({ ready: false, degradedStages: ['sync_gsc (CREDENTIALS_MISSING)', 'sync_ga4 (CREDENTIALS_MISSING)'], lastSuccessful: { jobId: degradedJob } });
    const dry = await runCli(ctx.paths.root, ['--dry-run', 'schedule', 'enable', 'weekly']);
    expect(dry.exitCode).toBe(0);
    expect(dry.out).toMatch(/had no complete Google data: sync_gsc \(CREDENTIALS_MISSING\), sync_ga4 \(CREDENTIALS_MISSING\).*A real run would refuse without --force/);
    expect(ctx.db.get("SELECT id FROM schedules WHERE job_type = 'weekly'")).toBeUndefined();

    // A later successful run with Google data (a disabled integration is not a problem): enabled without --force.
    seed('weekly', 'succeeded', { stages: [], degraded: [{ stage: 'performance', code: 'INTEGRATION_DISABLED', reason: 'x' }] });
    r = await runCli(ctx.paths.root, ['schedule', 'enable', 'weekly']);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatch(/Enabled weekly schedule for test-site/);
    expect(r.out).not.toMatch(/WARNING: No successful|had no complete Google data/);
    expect(ctx.db.get<{ enabled: number }>("SELECT enabled FROM schedules WHERE job_type = 'weekly'")).toEqual({ enabled: 1 });
  });

  // B1-01: the open-breaker hint points here; the breaker state is visible and can be reset (audited).
  it('jobs breakers lists open breakers with the next probe time and last error; --reset closes one (audited)', async () => {
    const empty = await runCli(ctx.paths.root, ['jobs', 'breakers']);
    expect(empty.exitCode).toBe(0);
    expect(empty.out).toMatch(/No circuit breaker state is recorded for site test-site: every provider is closed/);

    const insert = 'INSERT INTO circuit_breakers (site_id, provider, state, consecutive_failures, opened_at, next_probe_at, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
    ctx.db.run(insert, [ctx.siteId, 'google', 'open', 3, '2026-09-24T09:00:00.000Z', '2999-01-01T00:00:00.000Z', 'INTEGRATION_UNAVAILABLE: Google Search Console API: synthetic outage', '2026-09-24T09:00:00.000Z']);
    ctx.db.run(insert, [ctx.siteId, 'crawler', 'closed', 1, null, null, 'TIMEOUT: synthetic timeout', '2026-09-24T09:00:00.000Z']);

    const text = await runCli(ctx.paths.root, ['jobs', 'breakers']);
    expect(text.exitCode).toBe(0);
    const lines = text.out.split('\n');
    expect(lines.findIndex((l) => /^ {2}google /.test(l))).toBeLessThan(lines.findIndex((l) => /^ {2}crawler /.test(l))); // open first
    expect(text.out).toMatch(/google\s+OPEN\s+refusing requests; next probe after 2999-01-01T00:00:00\.000Z; 3 consecutive failure\(s\), opened 2026-09-24T09:00:00\.000Z/);
    expect(text.out).toMatch(/last error: INTEGRATION_UNAVAILABLE: Google Search Console API: synthetic outage/);
    expect(text.out).toMatch(/crawler\s+closed\s+requests allowed; 1 consecutive failure/);
    expect(text.out).toMatch(/1 breaker\(s\) not closed.*jobs breakers --reset <provider>/);
    const json = JSON.parse((await runCli(ctx.paths.root, ['--json', 'jobs', 'breakers'])).out);
    expect(json.breakers[0]).toMatchObject({ provider: 'google', state: 'open', refusing: true, probeAllowedNow: false, nextProbeAt: '2999-01-01T00:00:00.000Z' });

    const dry = await runCli(ctx.paths.root, ['--dry-run', 'jobs', 'breakers', '--reset', 'google']);
    expect(dry.exitCode).toBe(0);
    expect(dry.out).toMatch(/Dry run: would reset the google circuit breaker \(now open, 3 consecutive failure\(s\)\); nothing was changed/);
    expect(ctx.db.get("SELECT state FROM circuit_breakers WHERE provider = 'google'")).toMatchObject({ state: 'open' });

    const unknown = await runCli(ctx.paths.root, ['--json', 'jobs', 'breakers', '--reset', 'gogle']);
    expect(unknown.exitCode).toBe(1);
    expect(JSON.parse(unknown.out)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', hint: expect.stringContaining('google (open)') } });

    const reset = await runCli(ctx.paths.root, ['jobs', 'breakers', '--reset', 'google']);
    expect(reset.exitCode).toBe(0);
    expect(reset.out).toMatch(/Reset the google circuit breaker \(was open, 3 consecutive failure\(s\)\); recorded in the audit log/);
    expect(ctx.db.get("SELECT state FROM circuit_breakers WHERE provider = 'google'")).toBeUndefined();
    expect(ctx.db.get<{ actor: string; subject_id: string }>("SELECT actor, subject_id FROM audit_events WHERE event_type = 'circuit.reset'")).toMatchObject({ actor: 'cli', subject_id: 'google' });
    expect(reset.out).not.toMatch(/^ {2}google /m);
    expect(reset.out).toMatch(/No breaker is open or half-open/);
  });

  /** A pid that belonged to a process that has exited (spawnSync waits for it and reaps it). */
  const deadPid = (): number => {
    const r = spawnSync(process.execPath, ['-e', '']);
    expect(r.pid).toBeGreaterThan(0);
    return r.pid!;
  };
  /** Seed a job recorded as `running` by a run with this pid/host, holding the site lock (as a crashed runner leaves it). */
  const seedRunning = (pid: number, hostname: string, heartbeatAt: string, mode?: RuntimeMode) => {
    const job = enqueue(ctx, 'weekly', { note: 'synthetic' }, mode ? { mode } : {});
    const owner = `${hostname}:${pid}:synth001`;
    ctx.db.run("UPDATE jobs SET status = 'running', attempt = 1, started_at = ?, heartbeat_at = ?, lock_owner = ? WHERE id = ?", [heartbeatAt, heartbeatAt, owner, job.id]);
    ctx.db.run("INSERT INTO job_runs (id, job_id, site_id, attempt, status, pid, hostname, started_at) VALUES (?, ?, ?, 1, 'running', ?, ?, ?)", [`jrun_${job.id}`, job.id, ctx.siteId, pid, hostname, heartbeatAt]);
    expect(acquireSiteLock(ctx.db, { siteId: ctx.siteId, owner, jobId: job.id, leaseMs: 10 * 60_000, now: new Date() }).acquired).toBe(true);
    return job;
  };

  // C3-05: a crashed run never reaches a cooperative check; `jobs cancel` must not leave it blocking `restore`.
  it('jobs cancel on a running job whose process on this host is gone marks it interrupted and cancelled in one audited step', async () => {
    const pid = deadPid();
    const job = seedRunning(pid, os.hostname(), new Date().toISOString());
    expect(databaseActivity(ctx.db.raw).runningJobs.map((j) => j.id)).toEqual([job.id]);

    // `jobs list` shows the same liveness verdict the cancel acts on.
    const list = await runCli(ctx.paths.root, ['jobs', 'list', '--json']);
    expect(JSON.parse(list.out).jobs[0].appearsInterrupted).toBe(`process ${pid} on ${os.hostname()} is no longer running`);

    const dry = await runCli(ctx.paths.root, ['--dry-run', 'jobs', 'cancel', job.id]);
    expect(dry.out).toMatch(new RegExp(`Dry run: would mark it interrupted and cancel it immediately \\(process ${pid} on .* is no longer running\\), releasing its lock\\.`));
    expect(getJob(ctx.db, ctx.siteId, job.id)?.status).toBe('running');

    const text = await runCli(ctx.paths.root, ['jobs', 'cancel', job.id]);
    expect(text.exitCode, text.err).toBe(0);
    expect(text.out).toMatch(new RegExp(`Cancelled ${job.id}: it was recorded as running, but process ${pid} on .* is no longer running, so it was marked interrupted and then cancelled \\(its site lock was released\\)\\.`));
    expect(text.out).not.toMatch(/next cooperative check/);

    const after = getJob(ctx.db, ctx.siteId, job.id)!;
    expect(after).toMatchObject({ status: 'cancelled', cancelRequested: true, lockOwner: null, error: { code: 'CANCELLED' } });
    expect(after.finishedAt).not.toBeNull();
    expect(listJobRuns(ctx.db, ctx.siteId, job.id).map((r) => [r.status, r.error?.code])).toEqual([['interrupted', 'INTERRUPTED']]);
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeUndefined();
    const audit = ctx.db.all<{ event_type: string; actor: string }>("SELECT event_type, actor FROM audit_events WHERE subject_id = ? AND event_type IN ('job.interrupted', 'job.cancelled', 'job.cancel_requested') ORDER BY id", [job.id]);
    expect(audit).toEqual([
      { event_type: 'job.interrupted', actor: 'cli' },
      { event_type: 'job.cancelled', actor: 'cli' },
    ]);
    // `restore` is no longer blocked by it.
    expect(databaseActivity(ctx.db.raw)).toEqual({ activeLocks: [], runningJobs: [] });

    const again = await runCli(ctx.paths.root, ['jobs', 'cancel', job.id, '--json']);
    expect(JSON.parse(again.out)).toMatchObject({ outcome: 'already_finished', previousStatus: 'cancelled' });
  });

  // D2-ACC-09: `jobs resume` runs jobs up to the invoking --mode only, so the hint for a RESEARCH job names it.
  it('jobs list / show / locks: a crashed RESEARCH job "appears interrupted" with a resume command that names --mode RESEARCH; an ANALYZE job needs none', async () => {
    const pid = deadPid();
    const job = seedRunning(pid, os.hostname(), new Date().toISOString(), 'RESEARCH');
    const gone = `process ${pid} on ${os.hostname()} is no longer running`;
    const list = await runCli(ctx.paths.root, ['jobs', 'list']);
    expect(list.out).toContain(`  appears interrupted: ${gone} (run \`npm run cli -- --mode RESEARCH jobs resume ${job.id}\`)`);
    const show = await runCli(ctx.paths.root, ['jobs', 'show', job.id]);
    expect(show.out).toContain(`  NOTE: appears interrupted (${gone}); run \`npm run cli -- --mode RESEARCH jobs resume ${job.id}\`.`);
    const locks = await runCli(ctx.paths.root, ['jobs', 'locks']);
    expect(locks.out).toContain(`the job's process is gone: run \`jobs cancel ${job.id}\` or \`npm run cli -- --mode RESEARCH jobs resume ${job.id}\``);
    const locksJson = JSON.parse((await runCli(ctx.paths.root, ['jobs', 'locks', '--json'])).out);
    expect(locksJson.locks[0]).toMatchObject({ jobId: job.id, jobStatus: 'running', jobMode: 'RESEARCH' });

    // Without --mode the RESEARCH job is refused as not runnable (exit 1), and the reason names the flag.
    const plain = await runCli(ctx.paths.root, ['jobs', 'resume', job.id, '--json']);
    expect(plain.exitCode).toBe(1);
    expect(JSON.parse(plain.out).results[0]).toMatchObject({ outcome: 'not_runnable', detail: expect.stringMatching(/--mode RESEARCH/) });

    // An ANALYZE job's resume command carries no --mode.
    const other = enqueue(ctx, 'monthly', { note: 'synthetic' });
    ctx.db.run("UPDATE jobs SET status = 'running', attempt = 1, started_at = ?, heartbeat_at = ?, lock_owner = ? WHERE id = ?", [new Date().toISOString(), new Date().toISOString(), `${os.hostname()}:${pid}:synth002`, other.id]);
    ctx.db.run("INSERT INTO job_runs (id, job_id, site_id, attempt, status, pid, hostname, started_at) VALUES (?, ?, ?, 1, 'running', ?, ?, ?)", [`jrun_${other.id}`, other.id, ctx.siteId, pid, os.hostname(), new Date().toISOString()]);
    const list2 = await runCli(ctx.paths.root, ['jobs', 'list']);
    expect(list2.out).toContain(`  appears interrupted: ${gone} (run \`npm run cli -- jobs resume ${other.id}\`)`);
  });

  it('jobs cancel on a running job that only appears interrupted (another host, stale heartbeat) says so and names `jobs resume`, which then closes it as cancelled', async () => {
    const job = seedRunning(4242, 'other-host.test', new Date(Date.now() - 60 * 60_000).toISOString());
    const r = await runCli(ctx.paths.root, ['jobs', 'cancel', job.id, '--json']);
    const out = JSON.parse(r.out);
    expect(out).toMatchObject({ outcome: 'cancel_requested', previousStatus: 'running', appearsInterrupted: expect.stringMatching(/heartbeat is stale/) });
    expect(out.note).toMatch(new RegExp(`Its run appears interrupted .*Run \`jobs resume ${job.id}\`: it marks the job interrupted and, because cancellation is now requested, closes it as cancelled without running it\\.`));
    expect(getJob(ctx.db, ctx.siteId, job.id)).toMatchObject({ status: 'running', cancelRequested: true });

    const resumed = await runCli(ctx.paths.root, ['jobs', 'resume', job.id, '--json']);
    expect(JSON.parse(resumed.out).results).toEqual([expect.objectContaining({ jobId: job.id, outcome: 'cancelled', status: 'cancelled' })]);
    expect(getJob(ctx.db, ctx.siteId, job.id)?.status).toBe('cancelled');
    expect(databaseActivity(ctx.db.raw).runningJobs).toEqual([]);
  });

  it('jobs cancel on a running job whose process is alive only requests cancellation', async () => {
    const job = seedRunning(process.pid, os.hostname(), new Date().toISOString());
    const r = await runCli(ctx.paths.root, ['jobs', 'cancel', job.id]);
    expect(r.out).toBe(`Cancellation requested for running job ${job.id}. The running job stops at its next cooperative check (stage boundary or heartbeat).`);
    expect(getJob(ctx.db, ctx.siteId, job.id)).toMatchObject({ status: 'running', cancelRequested: true });
    expect(getSiteLock(ctx.db, ctx.siteId)?.jobId).toBe(job.id);
  });

  it('jobs resume reports an honest failure when no handler is registered for the job type', async () => {
    const job = enqueue(ctx, 'weekly', {});
    ctx.db.run("UPDATE jobs SET status = 'interrupted' WHERE id = ?", [job.id]);
    const r = await runCli(ctx.paths.root, ['jobs', 'resume', '--json']);
    const out = JSON.parse(r.out);
    expect(out.results).toEqual([expect.objectContaining({ jobId: job.id, outcome: 'failed' })]);
    expect(out.results[0].detail).toMatch(/No job handler is registered for type "weekly"/);
    expect(r.exitCode).toBe(1);
  });
});
