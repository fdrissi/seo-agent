import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installWiring } from '../../../src/app/wiring.js';
import { buildProgram } from '../../../src/cli/main.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { createDefaultRegistry } from '../../../src/jobs/handlers.js';
import { enqueue } from '../../../src/jobs/store.js';
import type { CostPlanOutput } from '../../../src/workflows/pipelines/baseline.js';
import { validateWorkflow } from '../../../src/workflows/engine.js';
import { createBaselineStages } from '../../../src/workflows/pipelines/baseline.js';
import type { ReportOutput } from '../../../src/workflows/pipelines/common.js';
import { createContentQueueStages } from '../../../src/workflows/pipelines/content-queue.js';
import { PIPELINE_STAGE_ORDER, runPipeline } from '../../../src/workflows/pipelines/handlers.js';
import { createMonthlyStages } from '../../../src/workflows/pipelines/monthly.js';
import { createWeeklyStages } from '../../../src/workflows/pipelines/weekly.js';
import type { TestContext } from '../../helpers/context.js';
import { count, pipelineConfig, pipelineContext, testEnv } from './helpers.js';

/** Whole pipelines run in these tests; a loaded machine can exceed the default 20 s. */
const PIPELINE_TEST_TIMEOUT_MS = 60_000;

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

async function cli(c: TestContext, args: string[]): Promise<{ out: string; err: string; code: number }> {
  let out = '';
  let err = '';
  const runtime = new CliRuntime({ out: (t) => (out += `${t}\n`), err: (t) => (err += `${t}\n`) }, { ...process.env, SEO_AGENT_WORKSPACE: c.paths.root });
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

describe('pipeline definitions', () => {
  it('every pipeline is a valid workflow: schemas, prerequisites in order, next states, allowances', () => {
    ctx = pipelineContext();
    const env = testEnv();
    for (const [name, stages] of [
      ['baseline', createBaselineStages(env, ctx)],
      ['baseline (approved)', createBaselineStages(env, ctx, { approveCostPlanMicros: 50_000 })],
      ['weekly', createWeeklyStages(env, ctx)],
      ['monthly', createMonthlyStages(env, ctx)],
      ['content queue', createContentQueueStages(env, ctx, { useModel: false, semantic: false })],
    ] as const) {
      const v = validateWorkflow(stages);
      expect(v.errors, name).toEqual([]);
      for (const s of stages) {
        expect(s.timeoutMs, `${name}:${s.name}`).toBeGreaterThan(0);
        expect(s.stoppingConditions.length, `${name}:${s.name}`).toBeGreaterThan(0);
        expect(s.evidence.requirement.length, `${name}:${s.name}`).toBeGreaterThan(0);
      }
    }
    // Weekly research is paid, budgeted, and gated by RESEARCH mode; baseline has no paid research stage.
    const research = createWeeklyStages(env, ctx).find((s) => s.name === 'research')!;
    expect(research.requiredMode).toBe('RESEARCH');
    expect(research.costAllowance).toEqual([{ provider: 'dataforseo', maxMicros: ctx.settings.budgets.dataforseo.perRun }]);
    expect(createBaselineStages(env, ctx).some((s) => s.costAllowance !== 'none' && s.costAllowance.some((a) => a.provider === 'dataforseo' || a.provider === 'apify'))).toBe(false);
  });

  it('stage-order constants match the stages each pipeline builds; index_memory never spends (A3-05)', () => {
    ctx = pipelineContext();
    const env = testEnv();
    const built: Record<string, string[]> = {
      baseline: createBaselineStages(env, ctx).map((s) => s.name),
      weekly: createWeeklyStages(env, ctx).map((s) => s.name),
      monthly: createMonthlyStages(env, ctx).map((s) => s.name),
      'content.queue': createContentQueueStages(env, ctx, { useModel: false, semantic: false }).map((s) => s.name),
    };
    for (const [type, names] of Object.entries(built)) expect(names, type).toEqual([...PIPELINE_STAGE_ORDER[type as keyof typeof PIPELINE_STAGE_ORDER]]);
    const before = (list: string[], a: string, b: string) => list.indexOf(a) >= 0 && list.indexOf(a) < list.indexOf(b);
    expect(before(built.weekly!, 'index_memory', 'retrieve_memory')).toBe(true);
    expect(before(built.monthly!, 'index_memory', 'report')).toBe(true);
    expect(built['content.queue']!.slice(0, 3)).toEqual(['queue_gate', 'index_memory', 'apify_signals']);
    expect(before(built.weekly!, 'research', 'compare') && before(built.weekly!, 'compare', 'recommend')).toBe(true);
    for (const stages of [createWeeklyStages(env, ctx), createMonthlyStages(env, ctx), createContentQueueStages(env, ctx, { useModel: false, semantic: false }), createBaselineStages(env, ctx)]) {
      const idx = stages.find((s) => s.name === 'index_memory')!;
      expect(idx.costAllowance).toBe('none');
    }
  });

  it('registers baseline/weekly/monthly/content.queue with the default job registry (jobs resume, scheduler)', () => {
    installWiring();
    const registry = createDefaultRegistry();
    for (const t of ['baseline', 'weekly', 'monthly', 'content.queue', 'content.research']) expect(registry.has(t), t).toBe(true);
    // Scheduler params are accepted by the handlers' params schema.
    ctx = pipelineContext();
    const job = enqueue(ctx, 'weekly', { trigger: 'schedule', scheduleId: 'sched_1', scheduledFor: '2026-09-28T06:00:00.000Z', timezone: 'Europe/Tallinn' }, { registry });
    expect(job.type).toBe('weekly');
  });
});

describe('monthly and content queue', () => {
  it('monthly: separate attribution section, competitor re-check only in RESEARCH mode, AI visibility honestly unavailable', async () => {
    ctx = pipelineContext();
    const r = await runPipeline(ctx, 'monthly', {}, { env: testEnv() });
    expect(r.outcome).toBe('succeeded');
    const degraded = Object.fromEntries(r.workflow.degraded.map((d) => [d.stage, d.code]));
    expect(degraded.competitor_changes).toBe('MODE_NOT_PERMITTED');
    const report = r.outputs.report as ReportOutput;
    expect(report.kind).toBe('monthly');
    expect(report.stageNotes.find((n) => n.stage === 'ai_visibility')).toMatchObject({ status: 'skipped', code: 'INTEGRATION_DISABLED' });
    // A5-10 / B2-05: the hint names no nonexistent budget, collector, or endpoint; it points to the manual import that exists.
    const ai = report.stageNotes.find((n) => n.stage === 'ai_visibility')!;
    expect(ai.detail).toMatch(/DATA_UNAVAILABLE, not zero/);
    expect(ai.nextStep).toMatch(/`ai-citations import`/);
    expect(ai.nextStep).toMatch(/spends nothing/);
    expect(ai.nextStep).not.toMatch(/no collector or manual-import adapter/);
    expect(ai.nextStep).not.toMatch(/DataForSEO/);
    expect(ai.nextStep).not.toMatch(/approving its budget/);
    // A3-05: memory ingested before the monthly report (free).
    const names = r.workflow.stages.map((x) => x.stage);
    expect(names.indexOf('index_memory')).toBeLessThan(names.indexOf('report'));
    expect(r.workflow.stages.find((x) => x.stage === 'index_memory')?.status).toBe('succeeded');
    expect(count(ctx, "SELECT COUNT(*) AS n FROM reports WHERE site_id = ? AND kind = 'monthly'", [ctx.siteId])).toBe(1);
    const md = readFileSync(path.join(ctx.paths.root, report.markdownFile!), 'utf8');
    expect(md).toMatch(/Attribution assumptions/i);
    // Exactly the monthly period was requested at GA4 period grain.
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM ga4_period_metrics WHERE site_id = ? AND period_start = ? AND period_end = ?', [ctx.siteId, report.period.start, report.period.end])).toBeGreaterThan(0);
  }, PIPELINE_TEST_TIMEOUT_MS);

  it('monthly ai_visibility (enabled): counts grounded observations of the reviewed month and points to `ai-citations import` when there are none (B2-05)', async () => {
    ctx = pipelineContext({ config: pipelineConfig({ features: { aiCitations: true } } as never) });
    expect(ctx.settings.features.aiCitations).toBe(true);
    const stage = createMonthlyStages(testEnv(), ctx).find((s) => s.name === 'ai_visibility')!;
    const period = { start: '2026-08-01', end: '2026-08-31', timeZone: 'UTC' };
    const sctx = { app: ctx, jobId: 'job_ai_visibility', workflow: 'monthly', prior: { plan_period: { period } }, signal: new AbortController().signal, attempt: 1 };
    // C5-09: a period that is not known is not measured: null, never a measured 0.
    const unknownPeriod = (await stage.run({}, { ...sctx, prior: {} })) as { enabled: boolean; checksInPeriod: number | null; note: { code: string } | null };
    expect(unknownPeriod).toMatchObject({ enabled: true, checksInPeriod: null, note: { code: 'NO_DATA' } });
    // Enabled with a known period: the recorded observations are counted (none recorded: a count of 0, stated as DATA_UNAVAILABLE for visibility).
    const none = (await stage.run({}, sctx)) as { enabled: boolean; checksInPeriod: number | null; note: { code: string; detail: string; nextStep: string } | null };
    expect(none).toMatchObject({ enabled: true, checksInPeriod: 0, note: { code: 'NO_DATA' } });
    expect(none.note!.detail).toMatch(/DATA_UNAVAILABLE, not zero/);
    expect(none.note!.nextStep).toMatch(/ai-citations import/);
    // SYNTHETIC observations as the manual import records them: one grounded, one ungrounded, one outside the month.
    const insert = (id: string, grounded: number, at: string) =>
      ctx!.db.run("INSERT INTO ai_citation_checks (id, site_id, engine, query, method, is_grounded, is_synthetic, checked_at) VALUES (?, ?, 'synthetic-engine', 'example widgets', 'manual_import', ?, 1, ?)", [id, ctx!.siteId, grounded, at]);
    insert('aic_synthetic_1', 1, '2026-08-10T12:00:00.000Z');
    insert('aic_synthetic_2', 0, '2026-08-11T12:00:00.000Z');
    insert('aic_synthetic_3', 1, '2026-09-10T12:00:00.000Z');
    const some = await stage.run({}, sctx);
    expect(some).toEqual({ enabled: true, checksInPeriod: 2, groundedInPeriod: 1, note: null });
  });

  it('monthly ai_visibility (disabled): checksInPeriod is null (not measured), never 0 (C5-09)', async () => {
    ctx = pipelineContext();
    expect(ctx.settings.features.aiCitations).toBe(false);
    const stage = createMonthlyStages(testEnv(), ctx).find((s) => s.name === 'ai_visibility')!;
    const sctx = { app: ctx, jobId: 'job_ai_visibility_off', workflow: 'monthly', prior: { plan_period: { period: { start: '2026-08-01', end: '2026-08-31', timeZone: 'UTC' } } }, signal: new AbortController().signal, attempt: 1 };
    const out = (await stage.run({}, sctx)) as { enabled: boolean; checksInPeriod: number | null; note: { status: string; code: string } | null };
    expect(out).toMatchObject({ enabled: false, checksInPeriod: null, note: { status: 'skipped', code: 'INTEGRATION_DISABLED' } });
    // The output schema accepts null (the engine validates stage outputs with it).
    expect(stage.output.safeParse(out).success).toBe(true);
    expect(stage.output.safeParse({ ...out, checksInPeriod: undefined }).success).toBe(false);
  });

  it('content queue: disabled by default outside the demo/full profile (no_action), never drafts when enabled', async () => {
    ctx = pipelineContext({ config: pipelineConfig({ profile: 'core' }) });
    const off = await runPipeline(ctx, 'content.queue', {}, { env: testEnv() });
    expect(off.outcome).toBe('succeeded');
    expect(off.workflow.stoppedBy).toMatchObject({ stage: 'queue_gate', status: 'no_action' });
    ctx.cleanup();
    ctx = pipelineContext();
    const env = testEnv();
    await runPipeline(ctx, 'baseline', {}, { env });
    const on = await runPipeline(ctx, 'content.queue', {}, { env });
    expect(on.outcome).toBe('succeeded');
    expect(on.workflow.stages.map((s) => s.stage)).toContain('discover');
    expect(on.workflow.stages.find((s) => s.stage === 'index_memory')?.status).toBe('succeeded');
    expect(on.workflow.stages.map((s) => s.stage)).not.toContain('draft');
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM content_drafts WHERE site_id = ?', [ctx.siteId])).toBe(0);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM publications WHERE site_id = ?', [ctx.siteId])).toBe(0);
  }, PIPELINE_TEST_TIMEOUT_MS);
});

describe('baseline cost plan approval', () => {
  it('runs optional LLM work only with an explicit approval covering the displayed plan (fixture client in the demo)', async () => {
    ctx = pipelineContext();
    const r = await runPipeline(ctx, 'baseline', { approveCostPlanMicros: 10_000 }, { env: testEnv() });
    expect(r.outcome).toBe('succeeded');
    const plan = r.outputs.cost_plan as CostPlanOutput;
    expect(plan.approved).toBe(true);
    expect(plan.totalUpperBoundMicros).toBe(0);
    expect((r.outputs.optional_ai as { ran: boolean }).ran).toBe(true);
    const report = r.outputs.report as ReportOutput;
    expect(report.llmSummary).toBe('generated');
    // The summary came from the synthetic fixture client and is recorded as such.
    expect(count(ctx, "SELECT COUNT(*) AS n FROM llm_calls WHERE site_id = ? AND prompt_id = 'reports.executive-summary' AND is_synthetic = 1", [ctx.siteId])).toBe(1);
  }, PIPELINE_TEST_TIMEOUT_MS);

  it('never approves an unknown price, even with a cap (core profile, no model configured)', async () => {
    ctx = pipelineContext({ config: pipelineConfig({ profile: 'core' }) });
    const r = await runPipeline(ctx, 'baseline', { approveCostPlanMicros: 1_000_000 }, { env: testEnv() });
    const plan = r.outputs.cost_plan as CostPlanOutput;
    expect(plan.approved).toBe(false);
    expect((r.outputs.optional_ai as { ran: boolean }).ran).toBe(false);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM llm_calls WHERE site_id = ?', [ctx.siteId])).toBe(0);
  }, PIPELINE_TEST_TIMEOUT_MS);
});

describe('dry run and CLI', () => {
  it('--dry-run executes against a temporary copy of the database: nothing is written to the workspace', async () => {
    ctx = pipelineContext({ mode: 'RESEARCH', dryRun: true });
    const env = testEnv();
    const r = await runPipeline(ctx, 'weekly', {}, { env });
    expect(r.scratchDatabase).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.workflow.degraded.find((d) => d.stage === 'research')?.code).toBe('DRY_RUN');
    expect(env.dfsCalls).toHaveLength(0);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM jobs WHERE site_id = ?', [ctx.siteId])).toBe(0);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM reports WHERE site_id = ?', [ctx.siteId])).toBe(0);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM gsc_page_daily WHERE site_id = ?', [ctx.siteId])).toBe(0);
    expect((r.outputs.report as ReportOutput).persisted).toBe(false);
    const reportsDir = path.join(ctx.paths.root, 'reports');
    expect(existsSync(reportsDir) ? readdirSync(reportsDir) : []).toEqual([]);
  }, PIPELINE_TEST_TIMEOUT_MS);

  it('the CLI runs baseline and weekly as durable jobs, prints JSON, and resumes by job id', async () => {
    ctx = pipelineContext();
    const b = await cli(ctx, ['baseline', '--json']);
    expect(b.code).toBe(0);
    const baseline = JSON.parse(b.out);
    expect(baseline.type).toBe('baseline');
    expect(baseline.outcome).toBe('succeeded');
    expect(baseline.outputs.cost_plan.display).toMatch(/PROPOSED COST PLAN/);

    const w = await cli(ctx, ['weekly']);
    expect(w.code).toBe(0);
    expect(w.out).toMatch(/Weekly pipeline, job job_/);
    expect(w.out).toMatch(/research\s+skipped/);
    expect(w.out).toMatch(/--mode RESEARCH/);

    // --resume refuses a finished job and a job of another type, without changing either.
    const done = await cli(ctx, ['baseline', '--resume', baseline.jobId, '--json']);
    expect(done.code).toBe(1);
    expect(done.out).toMatch(/already succeeded/);
    const wrongType = await cli(ctx, ['weekly', '--resume', baseline.jobId, '--json']);
    expect(wrongType.code).toBe(1);
    expect(wrongType.out).toMatch(/is a baseline job, not weekly/);
    expect(ctx.db.get<{ status: string }>('SELECT status FROM jobs WHERE id = ?', [baseline.jobId])!.status).toBe('succeeded');
  }, PIPELINE_TEST_TIMEOUT_MS);

  it('content queue and durable content production from the CLI: production waits for the human draft approval', async () => {
    // Briefs need original value (verified facts or real differentiators): SYNTHETIC ones for the fixture site.
    ctx = pipelineContext({
      config: pipelineConfig({
        business: {
          differentiators: ['SYNTHETIC: every widget, widget dashboard, and widget report is tested in our own lab before release (demo fixture)'],
          productFacts: [{ id: 'synthetic-widget-fact', statement: 'SYNTHETIC: widgets and widget reporting dashboards ship with a two-year warranty (demo fixture)', source: 'owner', verifiedAt: '2026-09-01' }],
        },
      } as never),
    });
    expect((await cli(ctx, ['baseline', '--json'])).code).toBe(0);
    const q = await cli(ctx, ['content', 'queue', '--json']);
    expect(q.code).toBe(0);
    const queue = JSON.parse(q.out);
    expect(queue.type).toBe('content.queue');
    const top = (queue.outputs.prioritize as { topItemId: string | null }).topItemId;
    expect(top).toBeTruthy();
    // --use-model from the start: the brief the human approves is the one the draft run reuses.
    const p = await cli(ctx, ['content', 'produce', top!, '--use-model', '--json']);
    expect(p.code).toBe(0);
    const prod = JSON.parse(p.out);
    expect(prod.outcome).toBe('waiting');
    expect(prod.stoppedBy).toMatchObject({ stage: 'brief', status: 'needs_review' });
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM content_drafts WHERE site_id = ?', [ctx.siteId])).toBe(0);

    // A human approves draft generation for that exact brief; a DRAFT-mode run then drafts (synthetic
    // placeholder from the fixture client), reviews, and stops for human review. Nothing is published.
    const approvalId = (prod.outputs.brief as { approvalRequestId: string | null }).approvalRequestId!;
    expect(approvalId).toBeTruthy();
    const hash = ctx.db.get<{ h: string }>('SELECT artifact_hash AS h FROM approvals WHERE id = ?', [approvalId])!.h;
    const approve = await cli(ctx, ['approvals', 'approve', approvalId, '--as', 'synthetic-tester', '--confirm', hash.slice(0, 12)]);
    expect(approve.code).toBe(0);
    const d = await cli(ctx, ['--mode', 'DRAFT', 'content', 'produce', top!, '--use-model', '--json']);
    const draftRun = JSON.parse(d.out);
    expect((draftRun.outputs.brief as { reused: boolean }).reused).toBe(true);
    expect(draftRun.stages.map((s: { stage: string }) => s.stage)).toEqual(['brief', 'draft', 'quality_review']);
    expect(draftRun.outcome).toBe('waiting');
    expect(draftRun.stoppedBy).toMatchObject({ stage: 'quality_review', status: 'needs_review' });
    const draft = ctx.db.get<{ body: string }>('SELECT package_json AS body FROM content_drafts WHERE site_id = ?', [ctx.siteId]);
    expect(draft?.body).toMatch(/SYNTHETIC DEMO DRAFT/);
    expect((draftRun.outputs.quality_review as { verdict: string }).verdict).not.toBe('pass');
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM publications WHERE site_id = ?', [ctx.siteId])).toBe(0);
  }, PIPELINE_TEST_TIMEOUT_MS);
});
