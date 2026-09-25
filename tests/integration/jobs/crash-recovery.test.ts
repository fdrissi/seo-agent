import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobRegistry } from '../../../src/jobs/registry.js';
import { JobRunner, enqueueAndRun } from '../../../src/jobs/runner.js';
import { getSiteLock } from '../../../src/jobs/locks.js';
import { enqueue, getJob, listJobRuns } from '../../../src/jobs/store.js';
import { workflowJobHandler } from '../../../src/jobs/workflow-handler.js';
import { CheckpointStore } from '../../../src/workflows/checkpoints.js';
import { summarizeRun } from '../../../src/workflows/pipelines/handlers.js';
import { renderPipelineRun } from '../../../src/cli/commands/pipelines.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { crashStages } from '../../fixtures/jobs/crash-stages.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const worker = path.join(repo, 'tests', 'fixtures', 'jobs', 'crash-worker.ts');
const tsxLoader = path.join(repo, 'node_modules', 'tsx', 'dist', 'loader.mjs');

/**
 * A real process crash: a child process runs the job and SIGKILLs itself in
 * stage 2 while holding the site lock. The parent detects the interruption
 * (dead pid on this host), releases the lock, and resumes from the stage-1
 * checkpoint without rerunning stage 1.
 */
describe('crash recovery with a real child process', () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => ctx.cleanup());

  it('resume after a crash skips completed stages', async () => {
    const job = enqueue(ctx, 'weekly', { topic: 'synthetic topic' });
    const marker = path.join(ctx.paths.root, 'stages.log');
    const child = spawnSync(process.execPath, ['--import', tsxLoader, worker, ctx.paths.root, ctx.siteId, job.id, marker], { encoding: 'utf8', timeout: 30_000 });
    expect(child.signal).toBe('SIGKILL');
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual(['research', 'analysis']);

    // The crashed run left the job running with a held lock.
    expect(getJob(ctx.db, ctx.siteId, job.id)?.status).toBe('running');
    expect(getSiteLock(ctx.db, ctx.siteId)?.jobId).toBe(job.id);
    const childRun = listJobRuns(ctx.db, ctx.siteId, job.id)[0]!;
    expect(childRun).toMatchObject({ status: 'running', hostname: os.hostname() });
    expect(childRun.pid).toBe(child.pid);

    const calls: string[] = [];
    const registry = new JobRegistry().register(workflowJobHandler({ type: 'weekly', description: 'synthetic', workflow: 'weekly', stages: crashStages({ onStage: (n) => calls.push(n) }) }));
    const runner = new JobRunner({ registry });
    const recovered = runner.recoverInterrupted(ctx);
    expect(recovered).toEqual([expect.objectContaining({ jobId: job.id, reason: expect.stringMatching(/no longer running/) })]);
    expect(getSiteLock(ctx.db, ctx.siteId)).toBeUndefined();

    const r = await runner.resume(ctx, job.id);
    expect(r.results[0]!.outcome).toBe('succeeded');
    expect(calls).toEqual(['analysis', 'brief']); // research reused from the child's checkpoint
    const result = getJob(ctx.db, ctx.siteId, job.id)!.result as { stages: Array<{ stage: string; resumedFromCheckpoint: boolean }> };
    expect(result.stages.map((s) => [s.stage, s.resumedFromCheckpoint])).toEqual([
      ['research', true],
      ['analysis', false],
      ['brief', false],
    ]);
    expect(listJobRuns(ctx.db, ctx.siteId, job.id).map((x) => x.status)).toEqual(['interrupted', 'succeeded']);
    expect(new CheckpointStore(ctx.db, ctx.clock).list(ctx.siteId, job.id).filter((c) => c.stage === 'research')).toHaveLength(1);
  });

  it('a crash inside a PAID stage is never blindly rerun: resume blocks until an explicit, reconciled rerun', async () => {
    const job = enqueue(ctx, 'weekly', { topic: 'synthetic topic' });
    const marker = path.join(ctx.paths.root, 'stages.log');
    const child = spawnSync(process.execPath, ['--import', tsxLoader, worker, ctx.paths.root, ctx.siteId, job.id, marker, 'analysis'], { encoding: 'utf8', timeout: 30_000 });
    expect(child.signal).toBe('SIGKILL');
    const inflight = new CheckpointStore(ctx.db, ctx.clock).latestAttempt(ctx.siteId, job.id, 'analysis');
    expect(inflight?.error?.code).toBe('IN_FLIGHT');

    const calls: string[] = [];
    const stages = crashStages({ onStage: (n) => calls.push(n), paidStage: 'analysis' });
    const registry = new JobRegistry().register(workflowJobHandler({ type: 'weekly', description: 'synthetic', workflow: 'weekly', stages }));
    const runner = new JobRunner({ registry });

    const blocked = await runner.resume(ctx, job.id);
    expect(blocked.recovered).toHaveLength(1);
    expect(blocked.results[0]).toMatchObject({ outcome: 'failed', error: { code: 'AMBIGUOUS_SUBMISSION' } });
    expect(calls).toEqual([]); // neither the reused stage 1 nor the paid stage 2 ran
    expect(getJob(ctx.db, ctx.siteId, job.id)!.error!.message).toMatch(/--rerun-paid-stages/);

    // Still blocked on a plain resume; allowed only with the explicit per-job decision.
    expect((await runner.resume(ctx, job.id)).results[0]!.outcome).toBe('failed');
    await expect(runner.resume(ctx, undefined, { rerunAmbiguousPaidStages: true })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const rerun = await runner.resume(ctx, job.id, { rerunAmbiguousPaidStages: true });
    expect(rerun.results[0]!.outcome).toBe('succeeded');
    expect(calls).toEqual(['analysis', 'brief']);
    const audit = ctx.db.get("SELECT id FROM audit_events WHERE event_type = 'job.rerun_paid_stages_authorized' AND subject_id = ?", [job.id]);
    expect(audit).toBeTruthy();
  });

  // D2-ACC-09: the crashed run can never finish, so "wait for it" is not a next step; resuming a RESEARCH job needs its --mode.
  it('after a RESEARCH job crashed holding the lock, a new run is refused with a next step that resumes it with its --mode, and that step works', async () => {
    const job = enqueue(ctx, 'weekly', { topic: 'synthetic topic' }, { mode: 'RESEARCH' });
    const marker = path.join(ctx.paths.root, 'stages.log');
    const child = spawnSync(process.execPath, ['--import', tsxLoader, worker, ctx.paths.root, ctx.siteId, job.id, marker], { encoding: 'utf8', timeout: 30_000 });
    expect(child.signal).toBe('SIGKILL');
    const crashed = getJob(ctx.db, ctx.siteId, job.id)!;
    expect(crashed).toMatchObject({ status: 'running', mode: 'RESEARCH' });
    // Right after the crash: the crashed run's lease has not expired, so nothing may take it over.
    ctx.clock.set(crashed.heartbeatAt!);
    const lock = getSiteLock(ctx.db, ctx.siteId)!;
    expect(lock.jobId).toBe(job.id);

    const calls: string[] = [];
    const registry = new JobRegistry().register(workflowJobHandler({ type: 'weekly', description: 'synthetic', workflow: 'weekly', stages: crashStages({ onStage: (n) => calls.push(n) }) }));
    // The default CLI ceiling (ANALYZE), as a foreground `weekly` builds it.
    const analyze = new JobRunner({ registry, maxMode: 'ANALYZE' });
    const gone = `process ${child.pid} on ${os.hostname()} is no longer running`;
    // The same verdict `jobs list` shows as "appears interrupted".
    expect(analyze.staleReason(ctx, crashed)).toBe(gone);
    expect(analyze.interruptedLockHolder(ctx, lock)).toEqual({ jobId: job.id, type: 'weekly', mode: 'RESEARCH', state: 'gone', reason: gone });

    // A new foreground run is refused (LOCKED) and closed; its next step resumes the crashed run, never "wait".
    const refused = await enqueueAndRun(ctx, analyze, 'weekly', { topic: 'synthetic topic' }, { retryInline: false });
    expect(refused.outcome).toBe('locked');
    const err = getJob(ctx.db, ctx.siteId, refused.job.id)!.error!;
    expect(err.code).toBe('LOCKED');
    expect(err.message).toContain(`held by job ${job.id} (lease until ${lock.expiresAt}), whose run was interrupted (${gone}); runs never overlap.`);
    expect(err.hint).toBe(
      `The run holding the lock was interrupted (${gone}): resume it with \`npm run cli -- --mode RESEARCH jobs resume ${job.id}\` (completed stages are reused from checkpoints), or cancel it with \`npm run cli -- jobs cancel ${job.id}\` and run the command again.`,
    );
    expect(err.hint).not.toMatch(/Wait for/);
    // The pipeline summary prints that next step.
    expect(renderPipelineRun(summarizeRun(ctx, refused, false))).toContain(`Next step: The run holding the lock was interrupted (${gone}): resume it with \`npm run cli -- --mode RESEARCH jobs resume ${job.id}\``);
    // A job that is resumed (not enqueued) and finds the lock held by the crashed run gets the same next step.
    const resumedLocked = summarizeRun(ctx, { outcome: 'locked', job: crashed, heldBy: { ...lock, jobId: 'job_other_synthetic' } }, false, { jobId: 'job_other_synthetic', type: 'weekly', mode: 'RESEARCH', state: 'gone', reason: gone });
    expect(resumedLocked.error?.hint).toBe(
      `The run holding the lock was interrupted (${gone}): resume it with \`npm run cli -- --mode RESEARCH jobs resume job_other_synthetic\` (completed stages are reused from checkpoints), or cancel it with \`npm run cli -- jobs cancel job_other_synthetic\` and then resume this job again: \`npm run cli -- --mode RESEARCH jobs resume ${job.id}\`.`,
    );
    expect(calls).toEqual([]);

    // Following the hint: without --mode the RESEARCH job is refused; the recorded interruption names the mode.
    const plain = await analyze.resume(ctx, job.id);
    expect(plain.results[0]).toMatchObject({ outcome: 'not_runnable', reason: expect.stringMatching(/--mode RESEARCH/) });
    expect(getJob(ctx.db, ctx.siteId, job.id)).toMatchObject({ status: 'interrupted', error: { code: 'INTERRUPTED', hint: expect.stringContaining(`\`npm run cli -- --mode RESEARCH jobs resume ${job.id}\``) } });
    const withMode = await new JobRunner({ registry, maxMode: 'RESEARCH' }).resume(ctx, job.id);
    expect(withMode.results[0]!.outcome).toBe('succeeded');
    expect(calls).toEqual(['analysis', 'brief']); // research reused from the crashed run's checkpoint
  });
});
