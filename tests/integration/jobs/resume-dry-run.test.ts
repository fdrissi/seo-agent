import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../../src/cli/main.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { JobRegistry } from '../../../src/jobs/registry.js';
import { JobRunner } from '../../../src/jobs/runner.js';
import { enqueue, getJob } from '../../../src/jobs/store.js';
import { jobSucceeded } from '../../../src/jobs/types.js';
import { pipelineHandler, runPipeline, summarizeRun } from '../../../src/workflows/pipelines/handlers.js';
import type { TestContext } from '../../helpers/context.js';
import { count, pipelineContext, testEnv } from '../pipelines/helpers.js';

/**
 * B5-01 (spec 25 paid-job safety, 27 checkpoint resume, 29 --dry-run, 32 no
 * fake success): `<pipeline> --resume <jobId> --dry-run` must never run a REAL
 * job for real against a throwaway copy of the database (spending money,
 * writing reports/vault notes into the workspace, and losing the charges with
 * the copy). The combination is refused before anything runs, and as defense
 * in depth the runner never runs a job non-dry from a dry-run context.
 * Everything is SYNTHETIC and offline (demo fixtures, counted transports).
 */

let ctx: TestContext | undefined;
beforeEach(() => {
  process.env.SEO_AGENT_LOG_LEVEL = 'error';
});
afterEach(() => {
  delete process.env.SEO_AGENT_LOG_LEVEL;
  ctx?.cleanup();
  ctx = undefined;
});

/** Content hashes of every workspace file outside the database directory (vault, reports, logs, exports, ...). */
function workspaceFiles(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full);
      if (rel === 'data' || rel.startsWith(`data${path.sep}`)) continue;
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out[rel] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return out;
}

function ledger(c: TestContext): Record<string, number> {
  const tables = ['jobs', 'job_runs', 'checkpoints', 'provider_requests', 'budget_reservations', 'reports', 'site_locks', 'recommendations'];
  return Object.fromEntries(tables.map((t) => [t, count(c, `SELECT COUNT(*) AS n FROM ${t} WHERE site_id = ?`, [c.siteId])]));
}

async function cli(c: TestContext, args: string[]): Promise<{ out: string; err: string; code: number }> {
  let out = '';
  let err = '';
  const runtime = new CliRuntime({ out: (t) => (out += `${t}\n`), err: (t) => (err += `${t}\n`) }, { ...process.env, SEO_AGENT_WORKSPACE: c.paths.root, SEO_AGENT_LOG_LEVEL: 'error' });
  const program = await buildProgram(runtime);
  program.exitOverride();
  process.exitCode = 0;
  try {
    await program.parseAsync(['node', 'seo-agent', '--workspace', c.paths.root, '--site', c.siteId, ...args]);
  } catch (e) {
    if (!(e instanceof CliExit) && !(e as { code?: string }).code?.startsWith('commander.')) throw e;
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { out, err, code };
}

/** A REAL (non-dry) RESEARCH-mode weekly job that was interrupted, as a resume candidate. */
function interruptedRealWeekly(c: TestContext, env: ReturnType<typeof testEnv>): string {
  const job = enqueue(c, 'weekly', {}, { mode: 'RESEARCH', dryRun: false, registry: new JobRegistry().register(pipelineHandler('weekly', env)), actor: 'cli' });
  c.db.run("UPDATE jobs SET status = 'interrupted', attempt = 1 WHERE id = ? AND site_id = ?", [job.id, c.siteId]);
  return job.id;
}

describe('B5-01: resuming a real job with --dry-run', () => {
  it('runPipeline refuses: no provider request, no workspace file written, the job and the ledger unchanged', async () => {
    ctx = pipelineContext({ mode: 'RESEARCH' });
    const env = testEnv();
    const jobId = interruptedRealWeekly(ctx, env);
    const filesBefore = workspaceFiles(ctx.paths.root);
    const ledgerBefore = ledger(ctx);

    const dry = { ...ctx, dryRun: true };
    await expect(runPipeline(dry, 'weekly', {}, { env, resumeJobId: jobId })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringMatching(/--dry-run cannot be combined with --resume.*Nothing was run or changed/),
      hint: expect.stringContaining(`jobs show ${jobId}`),
    });

    expect(env.dfsCalls).toEqual([]);
    expect(env.competitor.requests).toEqual([]);
    expect(workspaceFiles(ctx.paths.root)).toEqual(filesBefore);
    expect(ledger(ctx)).toEqual(ledgerBefore);
    expect(getJob(ctx.db, ctx.siteId, jobId)).toMatchObject({ status: 'interrupted', attempt: 1, dryRun: false });
  });

  it('the CLI refuses before printing spending caps or running anything', async () => {
    ctx = pipelineContext({ mode: 'RESEARCH' });
    const env = testEnv();
    const jobId = interruptedRealWeekly(ctx, env);
    const filesBefore = workspaceFiles(ctx.paths.root);
    const ledgerBefore = ledger(ctx);

    const r = await cli(ctx, ['--dry-run', '--mode', 'RESEARCH', 'weekly', '--resume', jobId, '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(r.out).toMatch(/--dry-run cannot be combined with --resume/);
    expect(r.err).not.toMatch(/Spending caps/);

    const text = await cli(ctx, ['--dry-run', '--mode', 'RESEARCH', 'weekly', '--resume', jobId]);
    expect(text.code).toBe(1);
    expect(`${text.out}\n${text.err}`).toMatch(/Error \[VALIDATION_FAILED\]: --dry-run cannot be combined with --resume/);
    expect(`${text.out}\n${text.err}`).not.toMatch(/nothing was written to the workspace/);

    expect(workspaceFiles(ctx.paths.root)).toEqual(filesBefore);
    expect(ledger(ctx)).toEqual(ledgerBefore);
    expect(getJob(ctx.db, ctx.siteId, jobId)).toMatchObject({ status: 'interrupted', attempt: 1 });
  });

  it('defense in depth: the runner never runs a job for real from a dry-run context, and the summary says dry run', async () => {
    ctx = pipelineContext();
    let sawDryRun: boolean | null = null;
    const registry = new JobRegistry().register({
      type: 'synthetic_real_job',
      description: 'synthetic job that records the dry-run flag it was given',
      run: async (c) => {
        sawDryRun = c.app.dryRun;
        return jobSucceeded({ synthetic: true });
      },
    });
    const job = enqueue(ctx, 'synthetic_real_job', {}, { dryRun: false });
    expect(job.dryRun).toBe(false);
    const r = await new JobRunner({ registry }).runJob({ ...ctx, dryRun: true }, job.id);
    expect(r.outcome).toBe('succeeded');
    expect(sawDryRun).toBe(true);
    expect(summarizeRun({ ...ctx, dryRun: true }, r, true).dryRun).toBe(true);
  });
});
