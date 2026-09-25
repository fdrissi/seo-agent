import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { addDays } from '../../../src/core/time.js';
import { toMicros } from '../../../src/core/money.js';
import { JobRegistry } from '../../../src/jobs/registry.js';
import { JobRunner, enqueueAndRun } from '../../../src/jobs/runner.js';
import { workflowJobHandler } from '../../../src/jobs/workflow-handler.js';
import { CheckpointStore } from '../../../src/workflows/checkpoints.js';
import { createBaselineStages, remainingBudgetProblem, type CostPlanOutput } from '../../../src/workflows/pipelines/baseline.js';
import { inspectUrlsStage, measurementOutput, nextStepForCode, pipelineParamsSchema, type PipelineParams, type ReportOutput } from '../../../src/workflows/pipelines/common.js';
import { contentQueueModelPlan, createContentQueueStages } from '../../../src/workflows/pipelines/content-queue.js';
import { renderPipelineRun } from '../../../src/cli/commands/pipelines.js';
import { workflowResultNote } from '../../../src/jobs/workflow-handler.js';
import { runPipeline, summarizeRun } from '../../../src/workflows/pipelines/handlers.js';
import { createWeeklyStages } from '../../../src/workflows/pipelines/weekly.js';
import { HISTORICAL_PERIOD_PRIMARY_ID } from '../../../src/seo/stages.js';
import { FakeLlm } from '../../fixtures/seo/fake-llm.js';
import type { TestContext } from '../../helpers/context.js';
import { count, pipelineConfig, pipelineContext, testEnv } from './helpers.js';

/**
 * B5-02 / B5-04 / B6-08 (synthetic, offline): an exhausted LLM budget never
 * blocks the weekly, content-queue, or baseline pipelines (routing,
 * recommendations, and the report are still produced); the report period
 * drives the join check and the routing window, and an explicit historical
 * weekly period is never saved over the current recommendation; weekly and
 * monthly reports get bounded country/device context.
 */

const PIPELINE_TEST_TIMEOUT_MS = 90_000;

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

/** Commit the whole LLM Gateway month with synthetic, reconciled reservations (each within the per-run cap). */
function exhaustLlmMonth(c: TestContext): void {
  const b = c.settings.budgets.llmGateway;
  let left = b.monthly;
  let i = 0;
  while (left > 0) {
    const amount = Math.min(left, b.perRun);
    const r = c.budgets.reserve({ siteId: c.siteId, provider: 'llm_gateway', runId: `synthetic-prior-llm-run-${i++}`, purpose: 'synthetic prior LLM spend (test)', estimate: { upperBoundMicros: amount, basis: { source: 'verified_config', detail: 'synthetic test seed' } } });
    c.budgets.reconcile(r.id, { actualMicros: amount, source: 'manual' });
    left -= amount;
  }
}

function checkpointOutput<T>(c: TestContext, jobId: string, stage: string): T {
  return new CheckpointStore(c.db, c.clock).latestWithOutput(c.siteId, jobId, stage)!.output as T;
}

interface RouteOut {
  period: { start: string; end: string };
  candidates: unknown[];
  persisted: unknown[];
  notPersistedReason?: string | null;
  note?: { status: string; code: string | null; detail: string; nextStep: string | null } | null;
}

describe('an exhausted LLM budget never blocks a pipeline (B5-02)', () => {
  it('weekly: routing runs rule-only with an honest note; recommendation and report are produced', async () => {
    ctx = pipelineContext();
    const llm = new FakeLlm(() => ({ classifications: [] }), { cheap: true, reasoning: false });
    const env = testEnv({ llm });
    // With budget available, routing declares the small LLM allowance for its optional intent hook (paid work optional).
    const before = createWeeklyStages(env, ctx).find((s) => s.name === 'route_and_score')!;
    expect(before.costAllowance).toEqual([{ provider: 'llm_gateway', maxMicros: Math.floor(ctx.settings.budgets.llmGateway.perRun * 0.1) }]);
    expect(before.paidWorkOptional).toBe(true);
    expect(before.optional).toBe(false);

    exhaustLlmMonth(ctx);
    const after = createWeeklyStages(env, ctx).find((s) => s.name === 'route_and_score')!;
    expect(after.costAllowance).toBe('none');

    const r = await runPipeline(ctx, 'weekly', {}, { env });
    expect(r.outcome).toBe('succeeded');
    expect(r.workflow.stoppedBy).toBeNull();
    const byStage = Object.fromEntries(r.workflow.stages.map((s) => [s.stage, s.status]));
    for (const s of ['route_and_score', 'recommend', 'report']) expect(byStage[s], s).toBe('succeeded');
    const route = checkpointOutput<RouteOut>(ctx, r.jobId, 'route_and_score');
    expect(route.note).toMatchObject({ status: 'degraded', code: 'BUDGET_EXCEEDED' });
    expect(route.note!.detail).toMatch(/rules only/);
    expect(route.note!.detail).toMatch(/LLM Gateway budget is exhausted \(site_service_month/);
    expect(llm.requests.filter((q) => q.tier === 'cheap')).toHaveLength(0);
    const rec = r.outputs.recommend as { saved: boolean; primaryId: string };
    expect(rec.saved).toBe(true);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM recommendations WHERE site_id = ? AND id = ?', [ctx.siteId, rec.primaryId])).toBe(1);
    const report = r.outputs.report as ReportOutput;
    expect(report.persisted).toBe(true);
    expect(report.stageNotes.find((n) => n.stage === 'route_and_score')).toMatchObject({ code: 'BUDGET_EXCEEDED' });
  }, PIPELINE_TEST_TIMEOUT_MS);

  it('weekly: a budget exhausted AFTER the stages were built (resume) is handled by the engine: routing still runs, degraded', async () => {
    ctx = pipelineContext();
    const llm = new FakeLlm(() => ({ classifications: [] }), { cheap: true, reasoning: false });
    const env = testEnv({ llm });
    const stages = createWeeklyStages(env, ctx);
    expect(stages.find((s) => s.name === 'route_and_score')!.costAllowance).not.toBe('none');
    exhaustLlmMonth(ctx);
    const handler = workflowJobHandler<PipelineParams>({
      type: 'weekly',
      description: 'weekly with stages built before the LLM budget ran out (test)',
      workflow: 'weekly',
      paramsSchema: pipelineParamsSchema as unknown as z.ZodType<PipelineParams>,
      stages: () => stages,
    });
    const runner = new JobRunner({ registry: new JobRegistry().register(handler), maxMode: ctx.mode });
    const run = await enqueueAndRun(ctx, runner, 'weekly', {}, { retryInline: false });
    expect(run.outcome).toBe('succeeded');
    const s = summarizeRun(ctx, run, false);
    expect(s.workflow.stages.find((x) => x.stage === 'route_and_score')?.status).toBe('succeeded');
    expect(s.workflow.degraded.find((d) => d.stage === 'route_and_score')).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    const route = checkpointOutput<RouteOut>(ctx, run.job.id, 'route_and_score');
    expect(route.note).toMatchObject({ status: 'degraded', code: 'BUDGET_EXCEEDED' });
    expect(llm.requests.filter((q) => q.tier === 'cheap')).toHaveLength(0);
    expect((s.outputs.report as ReportOutput).persisted).toBe(true);
    expect((s.outputs.recommend as { saved: boolean }).saved).toBe(true);
  }, PIPELINE_TEST_TIMEOUT_MS);

  it('content queue: rule-only research stages declare no allowance; with --use-model an exhausted budget runs classify rules-only and still prioritizes', async () => {
    ctx = pipelineContext();
    const env = testEnv();
    // Without --use-model / --semantic no research stage can make a paid call, so none declares an allowance or an LLM provider.
    for (const s of createContentQueueStages(env, ctx, { useModel: false, semantic: false })) {
      expect(s.costAllowance, s.name).toBe('none');
      expect(s.providers ?? [], s.name).not.toContain('llm_gateway');
    }
    const withModel = createContentQueueStages(env, ctx, { useModel: true, semantic: false });
    expect(withModel.find((s) => s.name === 'discover')!.costAllowance).toBe('none'); // full-text memory only
    const classify = withModel.find((s) => s.name === 'classify')!;
    expect(classify.costAllowance).not.toBe('none');
    expect(classify.paidWorkOptional).toBe(true);

    expect((await runPipeline(ctx, 'baseline', {}, { env })).outcome).toBe('succeeded');
    exhaustLlmMonth(ctx);
    const q = await runPipeline(ctx, 'content.queue', { useModel: true }, { env });
    expect(q.outcome).toBe('succeeded');
    const byStage = Object.fromEntries(q.workflow.stages.map((s) => [s.stage, s.status]));
    for (const s of ['discover', 'dedupe', 'classify', 'cluster', 'validate_demand', 'check_existing']) expect(byStage[s], s).toBe('succeeded');
    expect(['succeeded', 'stopped']).toContain(byStage.prioritize);
    expect(q.workflow.degraded.find((d) => d.stage === 'classify')).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(q.outputs.prioritize).toBeDefined();
    const cls = checkpointOutput<{ modelStatus: string }>(ctx, q.jobId, 'classify');
    expect(cls.modelStatus).not.toMatch(/^completed/);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM budget_reservations WHERE site_id = ? AND run_id = ? AND provider = 'llm_gateway'", [ctx.siteId, q.jobId])).toBe(0);
    // C1-11: the stage the engine ran without its paid work is "degraded" in the stage table, as the headline counts it.
    const out = renderPipelineRun(q);
    expect(out.split('\n')[0]).toMatch(/classify \(BUDGET_EXCEEDED\)/);
    expect(out).toMatch(/\n {2}classify\s+degraded\s+BUDGET_EXCEEDED: /);
    expect(out).not.toMatch(/\n {2}classify\s+succeeded/);
    expect(q.degradedStages.find((d) => d.stage === 'classify')).toMatchObject({ status: 'degraded', code: 'BUDGET_EXCEEDED', source: 'engine' });
  }, PIPELINE_TEST_TIMEOUT_MS);

  it('content queue --use-model with a $0 share of the per-run LLM budget: classify says BUDGET_EXCEEDED and the run is degraded, never silently rules-only (C1-11)', async () => {
    ctx = pipelineContext({ config: pipelineConfig({ budgets: { llmGateway: { monthlyUsd: '5.00', perRunUsd: '0.00' } } } as never) });
    expect(ctx.settings.budgets.llmGateway.perRun).toBe(0);
    const env = testEnv();
    const plan = contentQueueModelPlan(env, ctx, { useModel: true, semantic: false });
    expect(plan.allowances.classify).toBeNull();
    expect(plan.unavailable.classify).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(plan.unavailable.classify!.detail).toMatch(/budgets\.llmGateway\.perRun leaves no allowance/);
    expect(plan.unavailable.cluster).toBeNull(); // --semantic was not requested
    // Without --use-model nothing was requested, so nothing is unavailable.
    expect(contentQueueModelPlan(env, ctx, { useModel: false, semantic: false }).unavailable).toEqual({ classify: null, cluster: null });

    expect((await runPipeline(ctx, 'baseline', {}, { env })).outcome).toBe('succeeded');
    const q = await runPipeline(ctx, 'content.queue', { useModel: true }, { env });
    expect(q.outcome).toBe('succeeded');
    const cls = checkpointOutput<{ modelStatus: string; ambiguousCount: number }>(ctx, q.jobId, 'classify');
    expect(cls.ambiguousCount).toBeGreaterThan(0); // the fixture has ambiguous candidates, so the model was needed
    expect(cls.modelStatus).toMatch(/^skipped: BUDGET_EXCEEDED: budgets\.llmGateway\.perRun leaves no allowance/);
    const d = q.degradedStages.find((x) => x.stage === 'classify');
    expect(d).toMatchObject({ status: 'degraded', code: 'BUDGET_EXCEEDED', source: 'output' });
    const out = renderPipelineRun(q);
    expect(out.split('\n')[0]).toMatch(/succeeded \(degraded: .*classify \(BUDGET_EXCEEDED\)/);
    expect(out).toMatch(/\n {2}classify\s+degraded\s+BUDGET_EXCEEDED: /);
    // The job record agrees with the CLI headline.
    const stored = ctx.db.get<{ result_json: string }>('SELECT result_json FROM jobs WHERE id = ?', [q.jobId])!;
    expect(workflowResultNote(JSON.parse(stored.result_json))).toMatch(/classify \(BUDGET_EXCEEDED\)/);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM budget_reservations WHERE site_id = ? AND run_id = ? AND provider = 'llm_gateway'", [ctx.siteId, q.jobId])).toBe(0);
  }, PIPELINE_TEST_TIMEOUT_MS);

  it('baseline: an approved cost plan with an exhausted LLM budget still produces the report (the summary is skipped, never blocking)', async () => {
    ctx = pipelineContext();
    const env = testEnv();
    // The report declares its LLM allowance for the optional summary, which is paid work the report can do without.
    const report = createBaselineStages(env, ctx, { approveCostPlanMicros: 10_000 }).find((s) => s.name === 'report')!;
    expect(report.paidWorkOptional).toBe(true);
    expect(report.effectiveAllowance).toBeTypeOf('function');
    expect(createBaselineStages(env, ctx).find((s) => s.name === 'report')!.costAllowance).toBe('none');

    exhaustLlmMonth(ctx);
    const r = await runPipeline(ctx, 'baseline', { approveCostPlanMicros: 10_000 }, { env });
    expect(r.outcome).toBe('succeeded');
    expect(r.workflow.stoppedBy).toBeNull();
    expect(r.workflow.degraded.find((d) => d.stage === 'optional_ai')).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    const out = r.outputs.report as ReportOutput;
    expect(out.persisted).toBe(true);
    expect(out.llmSummary).not.toBe('generated');
    expect(count(ctx, "SELECT COUNT(*) AS n FROM llm_calls WHERE site_id = ? AND prompt_id = 'reports.executive-summary'", [ctx.siteId])).toBe(0);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM reports WHERE site_id = ? AND kind = 'baseline'", [ctx.siteId])).toBe(1);
  }, PIPELINE_TEST_TIMEOUT_MS);
});

describe('cost_plan checks what is LEFT of the budgets, not only the per-run cap (B5-02)', () => {
  it('names the month and the combined ceiling (spent by other providers) and refuses unverifiable limits', () => {
    ctx = pipelineContext({ config: pipelineConfig({ budgets: { combinedMonthlyUsd: '1.00' } } as never) });
    const est = (usd: string) => ({ upperBoundMicros: toMicros(usd), basis: { source: 'verified_config' as const, detail: 'synthetic test seed' } });
    expect(remainingBudgetProblem(ctx, 'job_plan', toMicros('0.01'))).toBeNull();
    // Apify spend alone uses up the combined monthly ceiling.
    const a = ctx.budgets.reserve({ siteId: ctx.siteId, provider: 'apify', runId: 'synthetic-apify-run', purpose: 'synthetic prior Apify spend (test)', estimate: est('1.00') });
    ctx.budgets.reconcile(a.id, { actualMicros: toMicros('1.00'), source: 'manual' });
    expect(remainingBudgetProblem(ctx, 'job_plan', toMicros('0.01'))).toMatch(/remaining combined monthly \(all providers\) budget \(\$0\.00 of \$1\.00 left\)/);
    ctx.cleanup();

    ctx = pipelineContext();
    exhaustLlmMonth(ctx);
    expect(remainingBudgetProblem(ctx, 'job_plan', toMicros('0.01'))).toMatch(/remaining LLM Gateway monthly budget/);
    // A $0 plan still fits an exactly-spent month (nothing is spent).
    expect(remainingBudgetProblem(ctx, 'job_plan', 0)).toBeNull();
  });

  it('the cost_plan stage refuses a plan that fits the per-run cap but not the remaining month', async () => {
    ctx = pipelineContext();
    const base = testEnv();
    // SYNTHETIC priced plan: 3 pending memory chunks whose embeddings cost at most $0.02 (verified price in this stub).
    const env = {
      ...base,
      services: (app: Parameters<typeof base.services>[0]) => ({
        ...base.services(app),
        embeddingsAvailable: true,
        memoryWithEmbeddings: () => ({ plan: () => ({ paid: { required: true, items: 3, estimatedTokens: 1_200, estimatedCostMicros: toMicros('0.02'), priceBasis: 'synthetic verified price', note: 'synthetic test plan' } }) }) as never,
      }),
    };
    const stage = createBaselineStages(env, ctx, { approveCostPlanMicros: toMicros('1.00') }).find((s) => s.name === 'cost_plan')!;
    const run = async (jobId: string) => (await stage.run({ capMicros: toMicros('1.00'), dryRun: false }, { app: ctx!, jobId, workflow: 'baseline', prior: {}, signal: new AbortController().signal, attempt: 1 })) as CostPlanOutput;
    const fits = await run('job_cost_plan_1');
    expect(fits.totalUpperBoundMicros).toBe(toMicros('0.02'));
    expect(fits.approved).toBe(true);

    exhaustLlmMonth(ctx);
    const refused = await run('job_cost_plan_2');
    expect(refused.totalUpperBoundMicros).toBeLessThanOrEqual(ctx.settings.budgets.llmGateway.perRun);
    expect(refused.approved).toBe(false);
    expect(refused.reason).toMatch(/^Not approved: the upper bound \$0\.02 does not fit the remaining LLM Gateway monthly budget \(\$0\.00 of \$5\.00 left\)/);
  });
});

describe('report period drives the join check and the routing window (B5-04)', () => {
  it('weekly --from/--to for a past week: routes over that window, checks joins for it, and saves or supersedes nothing', async () => {
    ctx = pipelineContext();
    const env = testEnv();
    const first = await runPipeline(ctx, 'weekly', {}, { env });
    expect(first.outcome).toBe('succeeded');
    const current = (first.outputs.report as ReportOutput).period;
    // The default run's join check covers exactly its report period.
    expect((first.outputs.validate_joins as z.infer<typeof measurementOutput>).period).toEqual(current);
    const recsBefore = ctx.db.all<{ id: string; status: string }>('SELECT id, status FROM recommendations WHERE site_id = ? ORDER BY id', [ctx.siteId]);
    expect(recsBefore.some((x) => x.status === 'proposed')).toBe(true);

    const period = { start: addDays(current.end, -20), end: addDays(current.end, -14) };
    const past = await runPipeline(ctx, 'weekly', { period }, { env });
    expect(past.outcome).toBe('succeeded');
    const report = past.outputs.report as ReportOutput;
    expect(report.period).toEqual(period);
    expect((past.outputs.validate_joins as z.infer<typeof measurementOutput>).period).toEqual(period);
    const route = checkpointOutput<RouteOut>(ctx, past.jobId, 'route_and_score');
    expect(route.period.end).toBe(period.end);
    expect(route.persisted).toEqual([]);
    expect(route.notPersistedReason).toMatch(/explicit historical report period/);
    expect(route.note).toMatchObject({ status: 'skipped', code: 'HISTORICAL_PERIOD' });
    const rec = past.outputs.recommend as { saved: boolean; primaryId: string; kind: string; title: string; note?: { code: string } | null };
    expect(rec).toMatchObject({ saved: false, primaryId: HISTORICAL_PERIOD_PRIMARY_ID, note: { code: 'HISTORICAL_PERIOD' } });
    // Nothing saved, nothing superseded: the current proposal stays the current one.
    expect(ctx.db.all<{ id: string; status: string }>('SELECT id, status FROM recommendations WHERE site_id = ? ORDER BY id', [ctx.siteId])).toEqual(recsBefore);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM route_decisions WHERE site_id = ? AND job_id = ?', [ctx.siteId, past.jobId])).toBe(0);
    expect(report.stageNotes.find((n) => n.stage === 'recommend')).toMatchObject({ code: 'HISTORICAL_PERIOD' });

    // NF-12: the summary gives the real reason (not a dry run), and the report's prioritized action agrees with it.
    const out = renderPipelineRun(past);
    expect(out).toMatch(/Recommendation: .+ \(not saved: explicit historical period; review only\)/);
    expect(out).not.toContain('(not saved: dry run)');
    expect(report.primaryAction).toMatch(/^review_only: Review only \(explicit historical period; not saved\): /);
    expect(report.primaryAction).not.toMatch(/^wait/);
    const md = readFileSync(path.join(ctx.paths.root, report.markdownFile!), 'utf8');
    const action = md.slice(md.indexOf('## Prioritized action'), md.indexOf('\n## ', md.indexOf('## Prioritized action') + 3));
    expect(action).toMatch(/Review only: for the explicit historical period/);
    expect(action).toMatch(/assembled the recommendation ".+" for review only\. It was not saved, supersedes no earlier proposal/);
    expect(report.primaryAction).toContain(`${rec.kind}: ${rec.title}`);
    expect(action).not.toMatch(/Wait: no production change is recommended/);
  }, PIPELINE_TEST_TIMEOUT_MS);

  it('monthly: validate_joins checks the reviewed month, not the latest 28 days', async () => {
    ctx = pipelineContext();
    const r = await runPipeline(ctx, 'monthly', {}, { env: testEnv() });
    expect(r.outcome).toBe('succeeded');
    const report = r.outputs.report as ReportOutput;
    expect(report.period.start.endsWith('-01')).toBe(true);
    expect((r.outputs.validate_joins as z.infer<typeof measurementOutput>).period).toEqual(report.period);
  }, PIPELINE_TEST_TIMEOUT_MS);
});

describe('country/device context in scheduled reports (B6-08)', () => {
  it('weekly: sync_gsc fetches segment rows bounded to the report period and the report shows device/country context', async () => {
    ctx = pipelineContext();
    const r = await runPipeline(ctx, 'weekly', {}, { env: testEnv() });
    expect(r.outcome).toBe('succeeded');
    const gsc = checkpointOutput<{ segments?: { status: string; start: string; periodStart: string; rowsReceived: number } | null }>(ctx, r.jobId, 'sync_gsc');
    expect(gsc.segments).toMatchObject({ status: 'fetched' });
    expect(gsc.segments!.rowsReceived).toBeGreaterThan(0);
    const report = r.outputs.report as ReportOutput;
    expect(gsc.segments!.periodStart).toBe(report.period.start);
    expect(gsc.segments!.start).toBe(report.period.start);
    // Segment rows exist only from the report period start on (bounded), never before.
    const earliest = ctx.db.get<{ d: string }>("SELECT MIN(date) AS d FROM gsc_page_daily WHERE site_id = ? AND segment_key != ''", [ctx.siteId])!.d;
    expect(earliest >= report.period.start).toBe(true);
    const md = readFileSync(path.join(ctx.paths.root, report.markdownFile!), 'utf8');
    expect(md).toMatch(/Device context/);
    expect(md).toMatch(/Country context/);
    expect(md).not.toMatch(/Country\/device context is unavailable/);
  }, PIPELINE_TEST_TIMEOUT_MS);

  it('no market countries or devices configured: no segment request', async () => {
    ctx = pipelineContext({ config: pipelineConfig({ market: { countries: [], languages: ['en'], searchLocations: [{ name: 'Synthetic Country', locationCode: 9990001, languageCode: 'en' }], devices: [] } } as never) });
    const r = await runPipeline(ctx, 'weekly', {}, { env: testEnv() });
    expect(r.outcome).toBe('succeeded');
    expect(checkpointOutput<{ segments?: unknown }>(ctx, r.jobId, 'sync_gsc').segments).toBeNull();
    expect(count(ctx, "SELECT COUNT(*) AS n FROM gsc_page_daily WHERE site_id = ? AND segment_key != ''", [ctx.siteId])).toBe(0);
  }, PIPELINE_TEST_TIMEOUT_MS);
});

describe('inspect_urls never looks like a success when it is off (coordination with G3a, B2-07)', () => {
  it('features.urlInspection off or a zero cap: a skipped INTEGRATION_DISABLED note with the next step', async () => {
    ctx = pipelineContext({ config: pipelineConfig({ features: { urlInspection: false } } as never) });
    expect(ctx.settings.features.urlInspection).toBe(false);
    const stage = inspectUrlsStage(testEnv(), 'check_measurement', ['reconcile_urls']);
    const sctx = { app: ctx, jobId: 'job_inspect', workflow: 'baseline', prior: {}, signal: new AbortController().signal, attempt: 1 };
    const off = (await stage.run({ max: 5 }, sctx)) as { status: string; note: { status: string; code: string; nextStep: string } | null };
    expect(off.status).toBe('disabled');
    expect(off.note).toMatchObject({ status: 'skipped', code: 'INTEGRATION_DISABLED' });
    expect(off.note!.nextStep).toMatch(/features\.urlInspection: true/);
    ctx.cleanup();
    ctx = pipelineContext();
    const zero = (await inspectUrlsStage(testEnv(), 'check_measurement', ['reconcile_urls']).run({ max: 0 }, { ...sctx, app: ctx })) as { note: { code: string; nextStep: string } | null };
    expect(zero.note).toMatchObject({ code: 'INTEGRATION_DISABLED' });
    expect(zero.note!.nextStep).toMatch(/urlInspectionMaxPerRun/);
  });
});

describe('actionable next steps for engine codes (coordination with G3a)', () => {
  it('OFFLINE and INTEGRATION_UNAVAILABLE say what to do', () => {
    expect(nextStepForCode('OFFLINE', 'sync_gsc')).toBe('This run was offline (--offline or demo mode); run without --offline to contact the provider.');
    const unavailable = nextStepForCode('INTEGRATION_UNAVAILABLE', 'sync_gsc')!;
    expect(unavailable).toMatch(/npm run cli -- jobs breakers/);
    expect(unavailable).not.toMatch(/or offline/);
  });
});
