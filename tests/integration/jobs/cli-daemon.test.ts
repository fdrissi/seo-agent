import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { register as registerJobs } from '../../../src/cli/commands/jobs.js';
import { register as registerSchedule } from '../../../src/cli/commands/schedule.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { addDefaultHandler } from '../../../src/jobs/handlers.js';
import { enqueue } from '../../../src/jobs/store.js';
import { jobFailed } from '../../../src/jobs/types.js';
import { workflowJobHandler } from '../../../src/jobs/workflow-handler.js';
import { clearRegisteredSecrets, registerSecret } from '../../../src/security/redact.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { chain, stage } from '../../unit/workflows/_stages.js';

/**
 * CLI behaviour that needs registered handlers (kept in its own file because
 * `addDefaultHandler` registers globally for this module instance):
 *  - `schedule run` in daemon mode redacts its output (it bypasses cli.print);
 *  - a workflow job that skipped stages is never shown as a bare "succeeded";
 *  - `jobs resume <id> --reviewed <stage>` continues a job waiting for review;
 *  - `schedule show` reports a schedule blocked by an interrupted job loudly.
 */

const SECRET = 'synthetic-secret-value-9f8e7d6c5b4a';

addDefaultHandler(() => ({
  type: 'leaky',
  description: 'synthetic handler whose failure message echoes a secret',
  run: async () => jobFailed({ code: 'PROVIDER_ERROR', message: `upstream rejected token ${SECRET} (Authorization: Bearer ${SECRET})` }, false),
}));
addDefaultHandler(() =>
  workflowJobHandler({
    type: 'weekly',
    description: 'synthetic weekly with a DRAFT-only stage',
    workflow: 'weekly',
    stages: chain([stage('analyze'), stage('draft', { requiredMode: 'DRAFT' })]),
  }),
);

addDefaultHandler(() =>
  workflowJobHandler({
    type: 'content',
    description: 'synthetic content workflow that stops for human review',
    workflow: 'content',
    stages: chain(
      [
        stage('draft', { stoppingConditions: ['always'], shouldStop: () => ({ stop: true, reason: 'human review is required', status: 'needs_review' }) }),
        stage('publish_prep', { prerequisites: ['draft'] }),
      ],
      ['needs_review'],
    ),
  }),
);

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

describe('schedule daemon output and degraded job status in the CLI', () => {
  let ctx: TestContext;
  beforeEach(() => {
    process.env.SEO_AGENT_LOG_LEVEL = 'error';
    registerSecret(SECRET);
    ctx = createTestContext();
  });
  afterEach(() => {
    delete process.env.SEO_AGENT_LOG_LEVEL;
    clearRegisteredSecrets();
    process.exitCode = undefined;
    ctx.cleanup();
  });

  it('daemon-mode `schedule run` redacts tick output (human and --json)', async () => {
    // Jobs the scheduler queued (only those run unattended).
    enqueue(ctx, 'leaky', { trigger: 'schedule' });
    const human = await runCli(ctx.paths.root, ['schedule', 'run', '--max-ticks', '1', '--tick-seconds', '1']);
    expect(human.out).toMatch(/ran job_.* \(leaky\): failed - PROVIDER_ERROR/);
    expect(human.out).not.toContain(SECRET);
    expect(human.out).toContain('[REDACTED]');
    expect(human.err).toMatch(/first tick after the next start resumes it/);

    enqueue(ctx, 'leaky', { trigger: 'schedule' });
    const json = await runCli(ctx.paths.root, ['--json', 'schedule', 'run', '--max-ticks', '1', '--tick-seconds', '1']);
    expect(json.out).not.toContain(SECRET);
    const ticks = JSON.parse(json.out) as Array<{ ran: Array<{ outcome: string }> }>;
    expect(ticks[0]!.ran.map((r) => r.outcome)).toEqual(['failed']);
  });

  it('a workflow job with skipped stages shows "succeeded (degraded: ...)" in schedule run, jobs list, and jobs show', async () => {
    const job = enqueue(ctx, 'weekly', { trigger: 'schedule' });
    const tick = await runCli(ctx.paths.root, ['schedule', 'run', '--once']);
    expect(tick.out).toContain(`ran ${job.id} (weekly): succeeded (degraded: 1 stage(s) skipped or failed: draft (MODE_NOT_PERMITTED))`);

    const list = await runCli(ctx.paths.root, ['jobs', 'list']);
    expect(list.out).toMatch(/NOTE: degraded: 1 stage\(s\) skipped or failed: draft \(MODE_NOT_PERMITTED\)/);
    const listJson = JSON.parse((await runCli(ctx.paths.root, ['--json', 'jobs', 'list'])).out) as { jobs: Array<{ status: string; note: string | null }> };
    expect(listJson.jobs[0]).toMatchObject({ status: 'succeeded', note: expect.stringMatching(/^degraded: 1 stage/) });

    const show = await runCli(ctx.paths.root, ['jobs', 'show', job.id]);
    expect(show.out).toMatch(/status: +succeeded \(degraded: 1 stage/);
  });

  it('`jobs resume <id> --reviewed <stage>` records an audited review and continues the waiting job', async () => {
    const job = enqueue(ctx, 'content', {});
    const first = await runCli(ctx.paths.root, ['jobs', 'resume', job.id]);
    expect(first.out).toMatch(/waiting - human review is required \(after the review, continue with `jobs resume .* --reviewed draft`\)/);
    const again = await runCli(ctx.paths.root, ['jobs', 'resume', job.id]);
    expect(again.out).toMatch(/: waiting/);
    const reviewed = await runCli(ctx.paths.root, ['jobs', 'resume', job.id, '--reviewed', 'draft', '--reviewer', 'synthetic-reviewer']);
    expect(reviewed.exitCode).toBe(0);
    expect(reviewed.out).toContain('Recorded review of stage "draft"');
    expect(reviewed.out).toMatch(/\(content\): succeeded/);
    const audit = ctx.db.get<{ actor: string }>("SELECT actor FROM audit_events WHERE event_type = 'workflow.stage_reviewed'");
    expect(audit?.actor).toBe('owner:synthetic-reviewer');
  });

  it('`jobs resume --reviewed` requires a validated human --reviewer (automation names are refused, nothing is recorded)', async () => {
    const job = enqueue(ctx, 'content', {});
    expect((await runCli(ctx.paths.root, ['jobs', 'resume', job.id])).out).toMatch(/: waiting/);
    const reviews = () => ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'workflow.stage_reviewed'")!.n;

    const missing = await runCli(ctx.paths.root, ['jobs', 'resume', job.id, '--reviewed', 'draft']);
    expect(missing.exitCode).toBe(1);
    expect(missing.err).toMatch(/Error \[VALIDATION_FAILED\]: --reviewed records a human review: pass --reviewer/);
    for (const name of ['cli', 'claude', 'system', 'scheduler', 'seo-agent', 'my bot', 'owner:system']) {
      const r = await runCli(ctx.paths.root, ['--json', 'jobs', 'resume', job.id, '--reviewed', 'draft', '--reviewer', name]);
      expect(r.exitCode, name).toBe(1);
      expect(JSON.parse(r.out).error.code, name).toBe('VALIDATION_FAILED');
    }
    // The dry run validates too.
    const dry = await runCli(ctx.paths.root, ['--dry-run', 'jobs', 'resume', job.id, '--reviewed', 'draft']);
    expect(dry.exitCode).toBe(1);
    expect(reviews()).toBe(0);
    expect(ctx.db.get<{ status: string }>('SELECT status FROM jobs WHERE id = ?', [job.id])!.status).toBe('waiting');

    const ok = await runCli(ctx.paths.root, ['jobs', 'resume', job.id, '--reviewed', 'draft', '--reviewer', 'Synthetic Reviewer']);
    expect(ok.exitCode).toBe(0);
    expect(ok.out).toContain('by owner:Synthetic Reviewer');
    expect(reviews()).toBe(1);
    expect(ctx.db.get<{ actor: string }>("SELECT actor FROM audit_events WHERE event_type = 'workflow.stage_reviewed'")?.actor).toBe('owner:Synthetic Reviewer');
  });

  it('`schedule show` reports a schedule blocked by an interrupted job that is not resumed automatically', async () => {
    expect((await runCli(ctx.paths.root, ['schedule', 'enable', 'weekly', '--force'])).exitCode).toBe(0);
    const job = enqueue(ctx, 'weekly', { trigger: 'cli' });
    ctx.db.run("UPDATE jobs SET status = 'interrupted', attempt = 1 WHERE id = ?", [job.id]);
    const show = await runCli(ctx.paths.root, ['schedule', 'show']);
    expect(show.out).toContain(`BLOCKED: previous weekly job ${job.id} is interrupted and is not resumed automatically`);
    expect(show.out).toMatch(/An interrupted scheduled job is resumed from its checkpoints by the next tick/);
  });
});
