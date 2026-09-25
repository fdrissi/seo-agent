/**
 * inspect_urls "nothing_inspected" handling and the report stage's dashboard
 * status caveat. SYNTHETIC: demo-profile fixtures on reserved example
 * domains; no network (the online context refuses every request).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { siteVaultDir } from '../../../src/config/paths.js';
import { runPipeline } from '../../../src/workflows/pipelines/handlers.js';
import { inspectUrlsStage, nothingInspectedNote, OFFLINE_STATUS_NOTE, offlineStatusNote, type ReportOutput } from '../../../src/workflows/pipelines/common.js';
import type { StageContext } from '../../../src/workflows/types.js';
import type { TestContext } from '../../helpers/context.js';
import { pipelineConfig, pipelineContext, testEnv } from './helpers.js';

const PIPELINE_TEST_TIMEOUT_MS = 60_000;

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

function stageContext(c: TestContext): StageContext {
  return { app: c, jobId: 'job_synthetic_inspect', workflow: 'baseline', prior: {}, signal: new AbortController().signal, attempt: 1 };
}

describe('inspect_urls: nothing inspected is a degraded stage with a next step', () => {
  it('maps skip reasons to an actionable next step (never a success)', () => {
    const base = { property: 'sc-domain:example.com', cap: 5 };
    expect(nothingInspectedNote({ ...base, outcomes: [] })).toMatchObject({ status: 'degraded', code: 'NOTHING_INSPECTED', detail: expect.stringMatching(/no priority URL was selected/) });
    expect(nothingInspectedNote({ ...base, outcomes: [] }).nextStep).toMatch(/sync gsc/);
    expect(nothingInspectedNote({ ...base, outcomes: [{ url: 'https://www.example.com/', status: 'skipped', reason: 'Dry run: no request made' }] }).nextStep).toMatch(/without --dry-run/);
    expect(nothingInspectedNote({ ...base, outcomes: [{ url: 'https://other.example/', status: 'skipped', reason: 'Not under the Search Console property sc-domain:example.com' }] }).nextStep).toMatch(/google\.searchConsoleProperty/);
    expect(nothingInspectedNote({ ...base, cap: 0, outcomes: [{ url: 'https://www.example.com/', status: 'skipped', reason: 'Daily URL Inspection quota budget reached' }] }).nextStep).toMatch(/quota/);
    expect(nothingInspectedNote({ ...base, cap: 0, outcomes: [{ url: 'https://www.example.com/', status: 'skipped', reason: 'Per-run cap reached (urlInspectionMaxPerRun=1)' }] }).nextStep).toMatch(/urlInspectionMaxPerRun/);
    const n = nothingInspectedNote({ ...base, outcomes: [{ url: 'https://www.example.com/a', status: 'skipped', reason: 'Dry run: no request made' }, { url: 'https://www.example.com/b', status: 'skipped', reason: 'Dry run: no request made' }] });
    expect(n.detail).toMatch(/all 2 URL\(s\) were skipped \(Dry run: no request made\); no indexed state was observed/);
  });

  it('the stage returns the degraded note when every priority URL is skipped (dry run)', async () => {
    ctx = pipelineContext({ dryRun: true });
    const stage = inspectUrlsStage(testEnv(), 'next', []);
    const sctx = stageContext(ctx);
    const input = stage.input.parse(await stage.buildInput(sctx, {}));
    const out = stage.output.parse(await stage.run(input, sctx)) as { status: string; inspected: number; note: { status: string; code: string; nextStep: string } | null };
    expect(out.status).toBe('nothing_inspected');
    expect(out.inspected).toBe(0);
    expect(out.note).toMatchObject({ status: 'degraded', code: 'NOTHING_INSPECTED' });
    expect(out.note!.nextStep).toMatch(/without --dry-run/);
  });

  it('a baseline run lists the stage in the report with its next step', async () => {
    ctx = pipelineContext({ dryRun: true });
    const r = await runPipeline(ctx, 'baseline', {}, { env: testEnv() });
    expect(r.outcome).toBe('succeeded');
    const report = r.outputs.report as ReportOutput;
    const n = report.stageNotes.find((x) => x.stage === 'inspect_urls');
    expect(n).toMatchObject({ status: 'degraded', code: 'NOTHING_INSPECTED' });
    expect(n!.nextStep).toMatch(/without --dry-run/);
  }, PIPELINE_TEST_TIMEOUT_MS);
});

describe('report stage: dashboard integration-status caveat', () => {
  it('offlineStatusNote: the offline caveat only when the run made no network checks', () => {
    expect(offlineStatusNote({ network: false })).toBe(OFFLINE_STATUS_NOTE);
    expect(offlineStatusNote(undefined)).toBe(OFFLINE_STATUS_NOTE);
    expect(offlineStatusNote({ network: true })).toBeNull();
  });

  it('an offline (demo) run writes the run\'s offline caveat under the dashboard integration table', async () => {
    ctx = pipelineContext();
    const r = await runPipeline(ctx, 'baseline', {}, { env: testEnv() });
    expect(r.outcome).toBe('succeeded');
    expect((r.outputs.check_access as { network: boolean }).network).toBe(false);
    const dashboard = readFileSync(path.join(siteVaultDir(ctx.paths, ctx.siteId), '00 Dashboard/Dashboard.md'), 'utf8');
    expect(dashboard).toMatch(/Offline checks only during this run/);
    // The dashboard's generic fallback caveat is replaced by the run's own statement.
    expect(dashboard).not.toMatch(/Offline checks only: no network request verified these statuses/);
  }, PIPELINE_TEST_TIMEOUT_MS);

  it('a run with network checks does not claim offline checks on the dashboard', async () => {
    ctx = pipelineContext({ config: pipelineConfig({ profile: 'core' }), online: true });
    const r = await runPipeline(ctx, 'baseline', {}, { env: testEnv() });
    expect(r.outcome).toBe('succeeded');
    expect((r.outputs.check_access as { network: boolean }).network).toBe(true);
    const dashboard = readFileSync(path.join(siteVaultDir(ctx.paths, ctx.siteId), '00 Dashboard/Dashboard.md'), 'utf8');
    expect(dashboard).toMatch(/## Integration status/);
    expect(dashboard).not.toMatch(/Offline checks only during this run/);
  }, PIPELINE_TEST_TIMEOUT_MS);
});
