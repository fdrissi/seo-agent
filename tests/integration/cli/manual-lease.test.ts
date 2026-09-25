import { spawnSync } from 'node:child_process';
import os from 'node:os';
import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../../src/cli/main.js';
import { CliExit, CliRuntime, type CliRuntimeOptions } from '../../../src/cli/runtime.js';
import { JobRegistry } from '../../../src/jobs/registry.js';
import { JobRunner } from '../../../src/jobs/runner.js';
import { acquireSiteLock, getSiteLock } from '../../../src/jobs/locks.js';
import { currentProcessStartedAt, manualLeaseOwner, parseManualLeaseOwner } from '../../../src/jobs/manual-lease.js';
import { enqueue, getJob } from '../../../src/jobs/store.js';
import { jobSucceeded } from '../../../src/jobs/types.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

/**
 * Spec 27 (non-overlapping per-site runs): a manual command that changes data
 * or spends money HOLDS the per-site lease while it runs (not just checks it),
 * so a scheduled/foreground job cannot start in the middle of a long manual
 * crawl. Two "runners" share one workspace database here: the CLI runtime
 * (manual command, its own connection) and a JobRunner (another connection).
 * --dry-run previews never take the lease.
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

interface Cli {
  runtime: CliRuntime;
  program: Command;
  out: string[];
  err: string[];
}

async function makeCli(options: CliRuntimeOptions = {}): Promise<Cli> {
  const out: string[] = [];
  const err: string[] = [];
  const runtime = new CliRuntime({ out: (t) => void out.push(t), err: (t) => void err.push(t) }, { ...process.env, SEO_AGENT_LOG_LEVEL: 'error' }, options);
  const program = await buildProgram(runtime);
  program.exitOverride();
  return { runtime, program, out, err };
}

function subcommand(program: Command, path: string[]): Command {
  let c: Command = program;
  for (const name of path) c = c.commands.find((x) => x.name() === name)!;
  return c;
}

/**
 * Replace the body of a registered MUTATING command (`pages set-type`) with one
 * that builds its context through the runtime (exactly as every command does)
 * and then waits, standing in for a long crawl. The lease logic under test is
 * the runtime's; the command body is irrelevant to it.
 */
function makeLong(cli: Cli, opts: { fail?: boolean; closeDb?: boolean } = {}): { entered: Deferred<void>; gate: Deferred<void> } {
  const entered = deferred();
  const gate = deferred();
  subcommand(cli.program, ['pages', 'set-type']).action(
    cli.runtime.action(async (...args: unknown[]) => {
      const cmd = args[args.length - 1] as Command;
      const ctx = cli.runtime.context(cli.runtime.globals(cmd));
      try {
        entered.resolve();
        await gate.promise;
        if (opts.fail) throw new Error('synthetic failure in the middle of a manual command');
      } finally {
        if (opts.closeDb !== false) ctx.db.close();
      }
    }),
  );
  return { entered, gate };
}

async function parse(cli: Cli, root: string, args: string[]): Promise<number> {
  process.exitCode = undefined;
  try {
    await cli.program.parseAsync(['node', 'seo-agent', '--workspace', root, '--site', 'test-site', '--offline', ...args]);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return code;
}

describe('manual mutating commands hold the per-site lease while they run', () => {
  let ctx: TestContext;
  let registry: JobRegistry;
  let ran: number;
  beforeEach(() => {
    process.env.SEO_AGENT_LOG_LEVEL = 'error';
    // The CLI uses the real clock; so does this context, so both runners agree on lease expiry.
    ctx = createTestContext({ now: new Date().toISOString() });
    ran = 0;
    registry = new JobRegistry().register({
      type: 'synthetic_site_job',
      description: 'synthetic job that needs the site lock',
      run: async () => {
        ran++;
        return jobSucceeded({ synthetic: true });
      },
    });
  });
  afterEach(() => {
    delete process.env.SEO_AGENT_LOG_LEVEL;
    process.exitCode = undefined;
    ctx.cleanup();
  });

  it('a job cannot start during a long manual command; it runs once the command released the lease', async () => {
    const cli = await makeCli();
    const { entered, gate } = makeLong(cli);
    const running = parse(cli, ctx.paths.root, ['pages', 'set-type', 'https://www.example.test/pricing/', 'offer']);
    await entered.promise;

    const lock = getSiteLock(ctx.db, ctx.siteId)!;
    expect(lock).toBeDefined();
    expect(lock.jobId).toBeNull();
    expect(parseManualLeaseOwner(lock.owner)).toMatchObject({ command: 'pages set-type', pid: process.pid });

    // Second runner: the scheduler's drain / a foreground job on another connection.
    const runner = new JobRunner({ registry, hostname: 'runner-host.test', pid: 999_001 });
    const job = enqueue(ctx, 'synthetic_site_job', {});
    const drained = await runner.drain(ctx);
    expect(drained.results.map((r) => r.outcome)).toEqual(['locked']);
    expect(ran).toBe(0);
    expect(getJob(ctx.db, ctx.siteId, job.id)?.status).toBe('queued');

    gate.resolve();
    expect(await running).toBe(0);
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeUndefined();

    const after = await runner.runJob(ctx, job.id);
    expect(after.outcome).toBe('succeeded');
    expect(ran).toBe(1);
  });

  it('a second manual mutating command is refused with LOCKED while the first holds the lease', async () => {
    const first = await makeCli();
    const { entered, gate } = makeLong(first);
    const running = parse(first, ctx.paths.root, ['pages', 'set-type', 'https://www.example.test/pricing/', 'offer']);
    await entered.promise;

    const second = await makeCli();
    const code = await parse(second, ctx.paths.root, ['--json', 'export', 'recommendation', 'rec_synthetic_missing']);
    expect(code).toBe(1);
    const body = JSON.parse(second.out.join('\n')) as { ok: boolean; error: { code: string; message: string; details: { jobId: string | null; command: string } } };
    expect(body.error.code).toBe('LOCKED');
    expect(body.error.message).toMatch(/locked by manual command "pages set-type"/);
    expect(body.error.details).toMatchObject({ jobId: null, command: 'export' });

    gate.resolve();
    expect(await running).toBe(0);
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeUndefined();
  });

  it('--dry-run neither takes nor checks the lease', async () => {
    const cli = await makeCli();
    const { entered, gate } = makeLong(cli);
    const running = parse(cli, ctx.paths.root, ['--dry-run', 'pages', 'set-type', 'https://www.example.test/pricing/', 'offer']);
    await entered.promise;
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeUndefined();
    const runner = new JobRunner({ registry, hostname: 'runner-host.test', pid: 999_002 });
    const job = enqueue(ctx, 'synthetic_site_job', {});
    expect((await runner.runJob(ctx, job.id)).outcome).toBe('succeeded');
    gate.resolve();
    expect(await running).toBe(0);
  });

  it('releases the lease when the command fails, and when it forgot to close its connection', async () => {
    const failing = await makeCli();
    const f = makeLong(failing, { fail: true });
    const r1 = parse(failing, ctx.paths.root, ['pages', 'set-type', 'https://www.example.test/pricing/', 'offer']);
    await f.entered.promise;
    expect(getSiteLock(ctx.db, ctx.siteId)?.owner).toMatch(/^manual\(pages set-type\)@/);
    f.gate.resolve();
    expect(await r1).toBe(1);
    expect(failing.err.join('\n')).toMatch(/synthetic failure/);
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeUndefined();

    const leaky = await makeCli();
    const l = makeLong(leaky, { closeDb: false });
    const r2 = parse(leaky, ctx.paths.root, ['pages', 'set-type', 'https://www.example.test/pricing/', 'offer']);
    await l.entered.promise;
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeDefined();
    l.gate.resolve();
    expect(await r2).toBe(0);
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeUndefined();
  });

  it('renews the lease with heartbeats while a long command runs', async () => {
    const cli = await makeCli({ lease: { leaseMs: 2_000, heartbeatMs: 20 } });
    const { entered, gate } = makeLong(cli);
    const running = parse(cli, ctx.paths.root, ['pages', 'set-type', 'https://www.example.test/pricing/', 'offer']);
    await entered.promise;
    const first = getSiteLock(ctx.db, ctx.siteId)!;
    await new Promise((r) => setTimeout(r, 120));
    const later = getSiteLock(ctx.db, ctx.siteId)!;
    expect(later.owner).toBe(first.owner);
    expect(Date.parse(later.heartbeatAt)).toBeGreaterThan(Date.parse(first.heartbeatAt));
    expect(Date.parse(later.expiresAt)).toBeGreaterThan(Date.parse(first.expiresAt));
    gate.resolve();
    expect(await running).toBe(0);
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeUndefined();
  });

  it('a real mutating command (pages set-type) gives the lease back when it ends', async () => {
    const cli = await makeCli();
    await parse(cli, ctx.paths.root, ['pages', 'set-type', 'https://www.example.test/pricing/', 'offer']);
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeUndefined();
    const runner = new JobRunner({ registry, hostname: 'runner-host.test', pid: 999_003 });
    const job = enqueue(ctx, 'synthetic_site_job', {});
    expect((await runner.runJob(ctx, job.id)).outcome).toBe('succeeded');
  });
});

/**
 * C4-07: a manual lease whose holder crashed must not block the site for
 * hours. The LOCKED message says what this machine knows about the holder's
 * process, and `jobs locks --release <lock> --as <name>` (a validated human,
 * audited) removes a lease only when its holder is verified dead.
 */
describe('jobs locks: inspecting and releasing a manual lease whose holder is gone', () => {
  let ctx: TestContext;
  beforeEach(() => {
    process.env.SEO_AGENT_LOG_LEVEL = 'error';
    ctx = createTestContext({ now: new Date().toISOString() });
  });
  afterEach(() => {
    delete process.env.SEO_AGENT_LOG_LEVEL;
    process.exitCode = undefined;
    ctx.cleanup();
  });

  const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!;
  /** A live (unexpired) manual lease, as a command that just crashed leaves it. */
  const seedManualLease = (pid: number, startedAt: number) => {
    const owner = manualLeaseOwner('crawl', { hostname: os.hostname(), pid, startedAt });
    expect(acquireSiteLock(ctx.db, { siteId: ctx.siteId, owner, jobId: null, leaseMs: 90_000, now: new Date() }).acquired).toBe(true);
    return owner;
  };
  const auditCount = (type: string) => ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_events WHERE site_id = ? AND event_type = ?', [ctx.siteId, type])!.n;

  it('names the dead holder in LOCKED, and releases its lease only for a validated human (audited)', async () => {
    const pid = deadPid();
    const owner = seedManualLease(pid, Date.now() - 30_000);

    const refused = await makeCli();
    expect(await parse(refused, ctx.paths.root, ['pages', 'set-type', 'https://www.example.test/pricing/', 'offer'])).toBe(1);
    const err = refused.err.join('\n');
    expect(err).toMatch(/Error \[LOCKED\]: Site test-site is locked by manual command "crawl"/);
    expect(err).toMatch(new RegExp(`Next step: The process of manual command "crawl" is gone \\(process ${pid} on .* is no longer running\\)\\. Its lease is taken over once it expires .*release it now with \`npm run cli -- jobs locks --release site --as "<your name>"\``));
    expect(err).not.toMatch(/expires on its own/);

    const list = await makeCli();
    expect(await parse(list, ctx.paths.root, ['jobs', 'locks'])).toBe(0);
    expect(list.out.join('\n')).toMatch(new RegExp(`site {5}manual command "crawl"; owner ${owner.replace(/[().]/g, '\\$&')}`));
    expect(list.out.join('\n')).toMatch(new RegExp(`holder process: GONE: process ${pid} on .* is no longer running`));
    expect(list.out.join('\n')).toContain('release it with: npm run cli -- jobs locks --release site --as "<your name>"');

    const noName = await makeCli();
    expect(await parse(noName, ctx.paths.root, ['jobs', 'locks', '--release', 'site'])).toBe(1);
    expect(noName.err.join('\n')).toMatch(/Error \[VALIDATION_FAILED\]: Releasing a lease is a human decision: pass --as "<your name>"/);
    const automation = await makeCli();
    expect(await parse(automation, ctx.paths.root, ['jobs', 'locks', '--release', 'site', '--as', 'scheduler'])).toBe(1);
    expect(automation.err.join('\n')).toMatch(/"scheduler" is reserved for automation/);
    const dry = await makeCli();
    expect(await parse(dry, ctx.paths.root, ['--dry-run', 'jobs', 'locks', '--release', 'site', '--as', 'Jane Doe'])).toBe(0);
    expect(dry.out.join('\n')).toMatch(/Dry run: would release the "site" lease of manual command "crawl" \(process \d+ on .* is no longer running\); nothing was changed\./);
    expect(getSiteLock(ctx.db, ctx.siteId)?.owner).toBe(owner);
    expect(auditCount('lock.released_dead_holder')).toBe(0);

    // `--release <site id>` names that site's "site" lock.
    const release = await makeCli();
    expect(await parse(release, ctx.paths.root, ['--json', 'jobs', 'locks', '--release', 'test-site', '--as', 'Jane Doe'])).toBe(0);
    const body = JSON.parse(release.out.join('\n')) as { locks: unknown[]; release: { lockName: string; outcome: string; by: string; previous: { owner: string } } };
    expect(body.release).toMatchObject({ lockName: 'site', outcome: 'released', by: 'owner:Jane Doe', previous: { owner } });
    expect(body.locks).toEqual([]);
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeUndefined();
    expect(ctx.db.get<{ actor: string; details_json: string }>("SELECT actor, details_json FROM audit_events WHERE site_id = ? AND event_type = 'lock.released_dead_holder'", [ctx.siteId])).toMatchObject({
      actor: 'owner:Jane Doe',
      details_json: expect.stringContaining(`"owner":"${owner}"`),
    });

    // The command runs again (it then fails for its own reason: the synthetic page does not exist).
    const retry = await makeCli();
    await parse(retry, ctx.paths.root, ['pages', 'set-type', 'https://www.example.test/pricing/', 'offer']);
    expect(retry.err.join('\n')).not.toMatch(/LOCKED/);
  });

  it('treats a pid reused by another process as gone: the lease can be released', async () => {
    // The lease recorded a holder that started 10 minutes before the process that now has this pid.
    const owner = seedManualLease(process.pid, currentProcessStartedAt() - 10 * 60_000);
    const list = await makeCli();
    expect(await parse(list, ctx.paths.root, ['--json', 'jobs', 'locks'])).toBe(0);
    const body = JSON.parse(list.out.join('\n')) as { locks: Array<{ owner: string; expired: boolean; liveness: { state: string; detail: string } }> };
    expect(body.locks).toEqual([expect.objectContaining({ owner, expired: false, liveness: expect.objectContaining({ state: 'dead', detail: expect.stringMatching(/that pid now belongs to another process/) }) })]);
    const release = await makeCli();
    expect(await parse(release, ctx.paths.root, ['jobs', 'locks', '--release', 'site', '--as', 'Jane Doe'])).toBe(0);
    expect(release.out.join('\n')).toMatch(/Released the "site" lease of manual command "crawl" \(process \d+ on .* is gone: that pid now belongs to another process .*\); recorded in the audit log as owner:Jane Doe\./);
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeUndefined();
  });

  it('refuses to release a lease whose holder process is alive, and says how to proceed', async () => {
    const live = manualLeaseOwner('crawl', { hostname: os.hostname(), pid: process.pid, startedAt: currentProcessStartedAt() });
    expect(acquireSiteLock(ctx.db, { siteId: ctx.siteId, owner: live, jobId: null, leaseMs: 90_000, now: new Date() }).acquired).toBe(true);
    const again = await makeCli();
    expect(await parse(again, ctx.paths.root, ['jobs', 'locks', '--release', 'site', '--as', 'Jane Doe'])).toBe(1);
    expect(again.err.join('\n')).toMatch(new RegExp(`Error \\[LOCKED\\]: Not releasing the "site" lease: manual command "crawl" still holds it: process ${process.pid} on .* is alive\\. Nothing was changed\\.`));
    expect(again.err.join('\n')).toMatch(new RegExp(`Next step: Wait for it to finish\\. If that process is hung, stop it \\(process ${process.pid}\\), then run this again\\.`));
    expect(getSiteLock(ctx.db, ctx.siteId)?.owner).toBe(live);

    const locked = await makeCli();
    expect(await parse(locked, ctx.paths.root, ['pages', 'set-type', 'https://www.example.test/pricing/', 'offer'])).toBe(1);
    expect(locked.err.join('\n')).toMatch(new RegExp(`Next step: Wait for manual command "crawl" \\(process ${process.pid}\\) to finish \\(\`npm run cli -- jobs locks\` shows the lease and whether its process is alive\\)`));
  });
});
