import { readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../../src/cli/main.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { enqueue } from '../../../src/jobs/store.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';

// `plans list | write` and `notify test` (src/cli/commands/plans.ts, notify.ts). Offline; synthetic site.

interface Run {
  out: string;
  err: string;
  exitCode: number;
}

async function runCli(root: string, args: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const runtime = new CliRuntime({ out: (t) => void out.push(t), err: (t) => void err.push(t) }, { ...process.env, SEO_AGENT_LOG_LEVEL: 'error' });
  const program = await buildProgram(runtime);
  program.exitOverride();
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'seo-agent', '--workspace', root, '--site', 'test-site', '--offline', ...args]);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { out: out.join('\n'), err: err.join('\n'), exitCode };
}

let ctx: TestContext | undefined;
afterEach(() => {
  process.exitCode = undefined;
  ctx?.cleanup();
  ctx = undefined;
});

/** A finished weekly job that failed at check_access (no report), as the runner records it. */
function failedWeeklyJob(c: TestContext): string {
  const id = enqueue(c, 'weekly', {}).id;
  c.db.run(`UPDATE jobs SET status = 'failed', attempt = 1, started_at = ?, finished_at = ?, error_json = ?, result_json = ? WHERE id = ? AND site_id = ?`, [
    '2026-09-24T08:00:00.000Z',
    '2026-09-24T08:01:00.000Z',
    JSON.stringify({ code: 'CREDENTIALS_MISSING', message: 'Google access is not configured (synthetic).', hint: 'Run `npm run cli -- auth google`.' }),
    JSON.stringify({ failure: { stage: 'check_access', code: 'CREDENTIALS_MISSING', message: 'x' } }),
    id,
    c.siteId,
  ]);
  return id;
}

describe('plans list and plans write', () => {
  it('lists nothing before the first plan, writes a plan for the latest weekly job, and never overwrites', async () => {
    ctx = createTestContext();
    const dir = path.join(ctx.paths.root, 'plans', 'test-site');
    const empty = JSON.parse((await runCli(ctx.paths.root, ['--json', 'plans', 'list'])).out) as { dir: string; folder: string; plans: unknown[] };
    expect(empty).toMatchObject({ dir, folder: 'missing', plans: [] });

    const jobId = failedWeeklyJob(ctx);
    const preview = await runCli(ctx.paths.root, ['--dry-run', 'plans', 'write']);
    expect(preview.exitCode).toBe(0);
    expect(preview.out).toContain('status: blocked');
    expect(preview.out).toContain('Dry run: nothing was written');
    expect(() => readdirSync(dir)).toThrow();

    const w = await runCli(ctx.paths.root, ['--json', 'plans', 'write']);
    expect(w.exitCode).toBe(0);
    const written = JSON.parse(w.out) as { jobId: string; week: string; plan: { status: string; planStatus: string; path: string }; telegram: null };
    expect(written).toMatchObject({ jobId, week: '2026-W39', plan: { status: 'written', planStatus: 'blocked', path: path.join(dir, '2026-W39.md') }, telegram: null });

    const again = JSON.parse((await runCli(ctx.paths.root, ['--json', 'plans', 'write', '--job', jobId])).out) as { plan: { path: string } };
    expect(again.plan.path).toBe(path.join(dir, '2026-W39-2.md'));

    const listed = JSON.parse((await runCli(ctx.paths.root, ['--json', 'plans', 'list'])).out) as { folder: string; plans: Array<{ file: string; status: string; job: string }> };
    expect(listed.folder).toBe('managed');
    expect(listed.plans.map((p) => [p.file, p.status, p.job])).toEqual([
      ['2026-W39-2.md', 'blocked', jobId],
      ['2026-W39.md', 'blocked', jobId],
    ]);
  });

  it('refuses a job that is not a finished weekly job', async () => {
    ctx = createTestContext();
    const queued = enqueue(ctx, 'weekly', {}).id;
    const r = await runCli(ctx.paths.root, ['plans', 'write', '--job', queued]);
    expect(r.exitCode).toBe(1);
    expect(r.err).toMatch(/Error \[VALIDATION_FAILED\]: Job .* is queued/);
    const fresh = createTestContext();
    try {
      const none = await runCli(fresh.paths.root, ['plans', 'write']);
      expect(none.err).toMatch(/NOT_FOUND.*no finished weekly job/);
    } finally {
      fresh.cleanup();
    }
  });
});

describe('notify test', () => {
  it('is refused with a next step when Telegram is not configured', async () => {
    ctx = createTestContext();
    const r = await runCli(ctx.paths.root, ['notify', 'test']);
    expect(r.exitCode).toBe(3);
    expect(r.err).toMatch(/INTEGRATION_DISABLED/);
    expect(r.err).toMatch(/notifications\.telegram\.enabled/);
  });

  it('--dry-run shows the message; offline mode sends nothing', async () => {
    ctx = createTestContext({ config: testSiteConfig({ notifications: { telegram: { enabled: true, chatId: '123456789' } } }) });
    const dry = await runCli(ctx.paths.root, ['--json', '--dry-run', 'notify', 'test']);
    expect(JSON.parse(dry.out)).toMatchObject({ dryRun: true, sent: false, chatId: '123456789', text: expect.stringContaining('test message for site test-site') });
    const offline = await runCli(ctx.paths.root, ['notify', 'test']);
    expect(offline.exitCode).not.toBe(0);
    expect(offline.err).toMatch(/OFFLINE/);
  });
});
