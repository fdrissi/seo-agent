import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildProgram } from '../../../src/cli/main.js';
import { pipelineHeadline, renderPipelineRun } from '../../../src/cli/commands/pipelines.js';
import { statusText } from '../../../src/cli/commands/jobs.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { JobRegistry } from '../../../src/jobs/registry.js';
import { JobRunner } from '../../../src/jobs/runner.js';
import { enqueue, getJob } from '../../../src/jobs/store.js';
import { workflowJobHandler, workflowResultNote } from '../../../src/jobs/workflow-handler.js';
import { summarizeRun, type PipelineRunResult } from '../../../src/workflows/pipelines/handlers.js';
import type { TestContext } from '../../helpers/context.js';
import { chain, stage } from '../../unit/workflows/_stages.js';
import { pipelineContext } from '../pipelines/helpers.js';

/**
 * B2-07 (spec 27/31 degraded workflows reported honestly; machine-readable
 * output; spec 32): the persisted job note counts the engine's degraded
 * stages PLUS the stages whose own output note says skipped/degraded/offline,
 * so `jobs list`, `jobs show`, `--json` (`degradedStages`), and the text
 * headline all report the same count. SYNTHETIC stages and fixtures only.
 */

let ctx: TestContext | undefined;
beforeEach(() => {
  process.env.SEO_AGENT_LOG_LEVEL = 'error';
});
afterEach(() => {
  delete process.env.SEO_AGENT_LOG_LEVEL;
  ctx?.cleanup();
  ctx = undefined;
  process.exitCode = undefined;
});

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

const noteOut = z.object({ value: z.number(), note: z.object({ status: z.string(), code: z.string().nullable(), detail: z.string(), nextStep: z.string().nullable() }).nullable() });
const withNote = (name: string, note: { status: string; code: string | null; detail: string } | null) =>
  stage(name, { output: noteOut, run: async () => ({ value: 1, note: note ? { ...note, nextStep: null } : null }) });

/** Two full weekly pipeline runs through the CLI (offline fixtures). */
const PIPELINE_TEST_TIMEOUT_MS = 60_000;

const countIn = (text: string | null) => Number(/degraded: (\d+) stage\(s\)/.exec(text ?? '')?.[1] ?? 0);

describe('degraded stages: one count everywhere', () => {
  it('a synthetic workflow job: the stored note, jobs list/show, the run summary (--json), and the headline agree', async () => {
    ctx = pipelineContext();
    const registry = new JobRegistry().register(
      workflowJobHandler({
        type: 'synthetic_weekly',
        description: 'synthetic weekly whose stages report their own degradation',
        workflow: 'synthetic_weekly',
        stages: chain([
          withNote('sync_gsc', { status: 'skipped', code: 'OFFLINE', detail: 'Network access is disabled (synthetic)' }),
          withNote('inspect_urls', { status: 'skipped', code: 'INTEGRATION_DISABLED', detail: 'URL inspection is disabled (synthetic)' }),
          withNote('crawl_site', { status: 'degraded', code: 'CRAWL_PARTIAL', detail: '3 of 5 pages fetched (synthetic)' }),
          withNote('route_and_score', null),
          stage('draft', { requiredMode: 'DRAFT' }),
        ]),
      }),
    );
    const job = enqueue(ctx, 'synthetic_weekly', {}, { registry });
    const r = await new JobRunner({ registry }).runJob(ctx, job.id);
    expect(r.outcome).toBe('succeeded');

    const stored = getJob(ctx.db, ctx.siteId, job.id)!.result as { degraded: unknown[]; degradedStages: Array<{ stage: string; code: string; status: string; source: string }> };
    expect(stored.degraded).toHaveLength(1); // the engine alone sees only the DRAFT-mode skip
    expect(stored.degradedStages.map((d) => [d.stage, d.code, d.status, d.source])).toEqual([
      ['draft', 'MODE_NOT_PERMITTED', 'skipped', 'engine'],
      ['sync_gsc', 'OFFLINE', 'offline', 'output'],
      ['inspect_urls', 'INTEGRATION_DISABLED', 'skipped', 'output'],
      ['crawl_site', 'CRAWL_PARTIAL', 'degraded', 'output'],
    ]);
    const note = workflowResultNote(stored);
    expect(note).toBe('degraded: 4 stage(s) skipped, degraded, or failed: draft (MODE_NOT_PERMITTED), sync_gsc (OFFLINE), inspect_urls (INTEGRATION_DISABLED), crawl_site (CRAWL_PARTIAL)');

    // `jobs list` (text and --json) and `jobs show` read the same stored note.
    const listJson = JSON.parse((await cli(ctx, ['--json', 'jobs', 'list'])).out) as { jobs: Array<{ id: string; note: string | null }> };
    expect(listJson.jobs.find((j) => j.id === job.id)?.note).toBe(note);
    expect((await cli(ctx, ['jobs', 'list'])).out).toContain(`NOTE: ${note}`);
    const show = (await cli(ctx, ['jobs', 'show', job.id])).out;
    expect(show).toContain(`status:      ${statusText('succeeded', note)}`);

    // C5-06: the checkpoint table never prints a bare "succeeded" for a stage the summary counts as degraded.
    const checkpointRow = (stage: string) => show.split('\n').find((l) => new RegExp(`^ {2}${stage} +\\S`).test(l) && / v\S+ attempt /.test(l));
    expect(checkpointRow('sync_gsc')).toMatch(/^ {2}sync_gsc +offline \(OFFLINE\) +v/);
    expect(checkpointRow('inspect_urls')).toMatch(/^ {2}inspect_urls +skipped \(INTEGRATION_DISABLED\) +v/);
    expect(checkpointRow('crawl_site')).toMatch(/^ {2}crawl_site +degraded \(CRAWL_PARTIAL\) +v/);
    expect(checkpointRow('route_and_score')).toMatch(/^ {2}route_and_score +succeeded +v/);
    for (const d of stored.degradedStages) {
      const row = checkpointRow(d.stage);
      if (row) expect(row, d.stage).not.toMatch(new RegExp(`^ {2}${d.stage} +succeeded\\b`));
    }
    // --json carries the same display status next to the raw checkpoint status.
    const showJson = JSON.parse((await cli(ctx, ['--json', 'jobs', 'show', job.id])).out) as { checkpoints: Array<{ stage: string; status: string; displayStatus: string }> };
    expect(showJson.checkpoints.find((c) => c.stage === 'sync_gsc')).toMatchObject({ status: 'succeeded', displayStatus: 'offline (OFFLINE)' });
    expect(showJson.checkpoints.find((c) => c.stage === 'route_and_score')).toMatchObject({ status: 'succeeded', displayStatus: 'succeeded' });

    // The run summary (what `--json` prints) and the text headline count the same four stages,
    // although only some stage outputs are part of the summarized outputs.
    const summary: PipelineRunResult = summarizeRun(ctx, r, false);
    expect(summary.degradedStages.map((d) => d.stage)).toEqual(['draft', 'sync_gsc', 'inspect_urls', 'crawl_site']);
    expect(summary.note).toBe(note);
    expect(pipelineHeadline(summary)).toBe(statusText('succeeded', note));
    expect(renderPipelineRun(summary)).toMatch(/sync_gsc\s+offline\s+OFFLINE: Network access is disabled/);
  });

  it('the real weekly pipeline: `weekly --json`, `jobs list --json`, and the text headline report the same count', async () => {
    ctx = pipelineContext();
    const w = await cli(ctx, ['weekly', '--json']);
    expect(w.code).toBe(0);
    const run = JSON.parse(w.out) as PipelineRunResult;
    expect(run.outcome).toBe('succeeded');
    expect(Array.isArray(run.degradedStages)).toBe(true);
    // Research is skipped outside RESEARCH mode: at least that engine-degraded stage is counted.
    expect(run.degradedStages.map((d) => d.stage)).toContain('research');
    expect(countIn(run.note)).toBe(run.degradedStages.length);

    const list = JSON.parse((await cli(ctx, ['--json', 'jobs', 'list'])).out) as { jobs: Array<{ id: string; note: string | null }> };
    expect(list.jobs.find((j) => j.id === run.jobId)?.note).toBe(run.note);
    expect(pipelineHeadline(run)).toBe(statusText('succeeded', run.note));

    // C5-06: `jobs show` of the same job shows every counted stage with its degraded status, never a bare "succeeded".
    const shown = (await cli(ctx, ['jobs', 'show', run.jobId])).out.split('\n');
    let checked = 0;
    for (const d of run.degradedStages) {
      const row = shown.find((l) => new RegExp(`^ {2}${d.stage} +\\S`).test(l) && / v\S+ attempt /.test(l));
      if (!row) continue; // a stage the engine never reached has no checkpoint
      checked++;
      expect(row, d.stage).not.toMatch(new RegExp(`^ {2}${d.stage} +succeeded\\b`));
      expect(row, d.stage).toContain(`(${d.code})`);
    }
    expect(checked).toBeGreaterThan(0);

    // A text run: its headline counts what its own job record says.
    const text = await cli(ctx, ['weekly']);
    expect(text.code).toBe(0);
    const headline = text.out.split('\n')[0]!;
    const jobId = /job (job_\w+)/.exec(headline)?.[1];
    expect(jobId).toBeTruthy();
    const stored = getJob(ctx.db, ctx.siteId, jobId!)!;
    const storedNote = workflowResultNote(stored.result);
    const storedList = (stored.result as { degradedStages: Array<{ stage: string }> }).degradedStages;
    expect(countIn(headline)).toBe(storedList.length);
    expect(headline).toContain(statusText('succeeded', storedNote));
    // Every stage the headline counts is shown with a non-"succeeded" status in the stage table.
    for (const d of storedList) {
      const row = text.out.split('\n').find((l) => new RegExp(`^ {2}${d.stage} +\\S`).test(l));
      expect(row, d.stage).toBeDefined();
      expect(row!, d.stage).not.toMatch(new RegExp(`^ {2}${d.stage} +succeeded\\b`));
    }
  }, PIPELINE_TEST_TIMEOUT_MS);
});
