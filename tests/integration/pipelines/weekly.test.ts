import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { ServiceAccountGoogleAuthProvider } from '../../../src/auth/providers.js';
import { JobRegistry } from '../../../src/jobs/registry.js';
import { JobRunner, enqueueAndRun } from '../../../src/jobs/runner.js';
import { workflowJobHandler } from '../../../src/jobs/workflow-handler.js';
import { pipelineParamsSchema, type PipelineParams, type ReportOutput } from '../../../src/workflows/pipelines/common.js';
import { runPipeline, summarizeRun } from '../../../src/workflows/pipelines/handlers.js';
import { createWeeklyStages, researchCandidatePlan, researchCandidates, researchGscScope, WEEKLY_STAGE_ORDER, type CompareOutput, type ResearchOutput } from '../../../src/workflows/pipelines/weekly.js';
import { CheckpointStore } from '../../../src/workflows/checkpoints.js';
import { pipelineHeadline, renderPipelineRun } from '../../../src/cli/commands/pipelines.js';
import { insertRow, seedBatch, sid } from '../../fixtures/reports/seed.js';
import { FakeLlm } from '../../fixtures/seo/fake-llm.js';
import type { EngineStage } from '../../../src/workflows/stage.js';
import type { TestContext } from '../../helpers/context.js';
import { count, pipelineConfig, pipelineContext, refusingFetch, testEnv } from './helpers.js';

/** Whole pipelines run in these tests; a loaded machine can exceed the default 20 s. */
const PIPELINE_TEST_TIMEOUT_MS = 60_000;

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

function paidRequests(c: TestContext): number {
  return count(c, "SELECT COUNT(*) AS n FROM provider_requests WHERE site_id = ? AND provider = 'dataforseo' AND method = 'POST'", [c.siteId]);
}

/** Spend the whole weekly DataForSEO budget with synthetic, reconciled reservations (each within the per-run cap). */
function exhaustDataForSeoWeek(c: TestContext): void {
  const b = c.settings.budgets.dataforseo;
  let left = b.weekly;
  let i = 0;
  while (left > 0) {
    const amount = Math.min(left, b.perRun);
    const r = c.budgets.reserve({ siteId: c.siteId, provider: 'dataforseo', runId: `synthetic-prior-run-${i++}`, purpose: 'synthetic prior spend (test)', estimate: { upperBoundMicros: amount, basis: { source: 'verified_config', detail: 'synthetic test seed' } } });
    c.budgets.reconcile(r.id, { actualMicros: amount, source: 'manual' });
    left -= amount;
  }
}

describe('weekly pipeline (demo profile, synthetic fixtures, offline)', () => {
  it('RESEARCH mode: syncs, routes, researches the shortlist, records blocked competitor pages honestly, and recommends one action', async () => {
    ctx = pipelineContext({ mode: 'RESEARCH' });
    const env = testEnv();
    const r = await runPipeline(ctx, 'weekly', {}, { env });
    expect(r.error).toBeNull();
    expect(r.outcome).toBe('succeeded');
    const byStage = Object.fromEntries(r.workflow.stages.map((s) => [s.stage, s.status]));
    for (const s of WEEKLY_STAGE_ORDER) expect(byStage[s], s).toBe('succeeded');
    expect(r.workflow.stages.map((s) => s.stage)).toEqual([...WEEKLY_STAGE_ORDER]);
    const research = r.outputs.research as ResearchOutput;
    expect(research.isSandbox).toBe(true); // fixture data is labeled, never live
    expect(research.queries.length).toBeGreaterThanOrEqual(1);
    expect(research.queries.length).toBeLessThanOrEqual(ctx.config.research.seriousQueriesPerRun);
    // Blocked competitor pages: robots.txt disallow and HTTP 403 are recorded, never bypassed.
    const blocked = research.competitorPages.filter((p) => p.status === 'blocked');
    expect(blocked.map((p) => p.blockedReason)).toEqual(expect.arrayContaining(['robots', 'access_denied']));
    expect(env.competitor.requests.some((u) => u.startsWith('https://competitor-2.example/') && !u.endsWith('/robots.txt'))).toBe(false);
    expect(research.note).toMatchObject({ status: 'degraded', code: 'COMPETITOR_BLOCKED' });

    const report = r.outputs.report as ReportOutput;
    expect(report.kind).toBe('weekly');
    expect(report.isSynthetic).toBe(true);
    expect(report.stageNotes.find((n) => n.stage === 'research')?.code).toBe('COMPETITOR_BLOCKED');
    const md = readFileSync(path.join(ctx.paths.root, report.markdownFile!), 'utf8');
    expect(md).toMatch(/blocked/);
    expect(md).toMatch(/not bypassed/);
    // Exactly the report period (and its comparison period) fetched at GA4 period grain.
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM ga4_period_metrics WHERE site_id = ? AND period_start = ? AND period_end = ?', [ctx.siteId, report.period.start, report.period.end])).toBeGreaterThan(0);
    // One primary recommendation (or an explicit no-action decision) was recorded.
    const rec = r.outputs.recommend as { primaryId: string; secondaryIds: string[]; saved: boolean };
    expect(rec.saved).toBe(true);
    expect(rec.secondaryIds.length).toBeLessThanOrEqual(3);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM recommendations WHERE site_id = ? AND id = ?', [ctx.siteId, rec.primaryId])).toBe(1);

    // Research submissions went through the provider-request log (synthetic, flagged).
    expect(paidRequests(ctx)).toBeGreaterThan(0);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM provider_requests WHERE site_id = ? AND provider = 'dataforseo' AND is_synthetic = 0", [ctx.siteId])).toBe(0);

    // C5-03: spend keeps provider-reported and computed amounts apart and tags the synthetic sandbox amounts,
    // in the stage output, the CLI summary, and the vault system log (never "actual").
    const costs = r.outputs.reconcile_costs as { spend: Array<{ provider: string; reportedMicros?: number; computedMicros?: number; syntheticCount?: number }>; spendDemo?: boolean };
    const dfs = costs.spend.find((x) => x.provider === 'dataforseo')!;
    expect(dfs.reportedMicros).toBeTypeOf('number');
    expect(dfs.computedMicros).toBeTypeOf('number');
    expect(dfs.syntheticCount).toBeGreaterThan(0);
    const line = renderPipelineRun(r).split('\n').find((l) => l.startsWith('Spend this month'))!;
    expect(line).toMatch(/dataforseo \$\S+ provider-reported, \$\S+ computed from usage, /);
    // The demo-profile test context is synthetic as a whole: the whole line is tagged (else the provider would be).
    expect(line).toMatch(costs.spendDemo ? /^Spend this month \[SYNTHETIC: no real charges\]: / : /dataforseo [^;]*\[SYNTHETIC: no real charges\]/);
    expect(line).not.toMatch(/ actual/);
    const logs = readdirSync(ctx.paths.vaultRoot, { recursive: true, encoding: 'utf8' }).filter((f) => f.includes('14 System Logs') && f.endsWith('.md') && !f.includes('Conflicts'));
    const log = logs.map((f) => readFileSync(path.join(ctx!.paths.vaultRoot, f), 'utf8')).join('\n');
    const costLine = log.split('\n').find((l) => l.includes('costs reconciled'))!;
    expect(costLine).toMatch(/spend this month.*dataforseo \$\S+ provider-reported, \$\S+ computed from usage/);
    expect(costLine).toContain('[SYNTHETIC: no real charges]');
    expect(costLine).not.toMatch(/actual this month/);
  }, PIPELINE_TEST_TIMEOUT_MS);

  it('ANALYZE mode (default): research is skipped with an honest, actionable status; nothing is sent to DataForSEO', async () => {
    ctx = pipelineContext();
    const env = testEnv();
    const r = await runPipeline(ctx, 'weekly', {}, { env });
    expect(r.outcome).toBe('succeeded');
    expect(r.workflow.degraded.find((d) => d.stage === 'research')?.code).toBe('MODE_NOT_PERMITTED');
    expect(env.dfsCalls).toHaveLength(0);
    const report = r.outputs.report as ReportOutput;
    const note = report.stageNotes.find((n) => n.stage === 'research')!;
    expect(note).toMatchObject({ status: 'skipped', code: 'MODE_NOT_PERMITTED' });
    expect(note.nextStep).toMatch(/--mode RESEARCH/);
    expect(r.outputs.recommend).toBeDefined();
  }, PIPELINE_TEST_TIMEOUT_MS);

  it('budget exhaustion stops research with an actionable status and still produces the report', async () => {
    ctx = pipelineContext({ mode: 'RESEARCH' });
    exhaustDataForSeoWeek(ctx);
    const env = testEnv();
    const r = await runPipeline(ctx, 'weekly', {}, { env });
    expect(r.outcome).toBe('succeeded');
    const d = r.workflow.degraded.find((x) => x.stage === 'research')!;
    expect(d.code).toBe('BUDGET_EXCEEDED');
    expect(d.reason).toMatch(/dataforseo budget exhausted/);
    expect(env.dfsCalls).toHaveLength(0);
    expect(paidRequests(ctx)).toBe(0);
    const report = r.outputs.report as ReportOutput;
    expect(report.persisted).toBe(true);
    const note = report.stageNotes.find((n) => n.stage === 'research')!;
    expect(note.code).toBe('BUDGET_EXCEEDED');
    expect(note.nextStep).toMatch(/budget/i);
    const md = readFileSync(path.join(ctx.paths.root, report.markdownFile!), 'utf8');
    expect(md).toMatch(/BUDGET\\?_EXCEEDED/);
    // The job still ends with one recommendation or an explicit wait, never invented research.
    expect(r.outputs.recommend).toBeDefined();
  }, PIPELINE_TEST_TIMEOUT_MS);

  it('an interrupted weekly run resumes from its checkpoints without redoing completed stages or spending twice', async () => {
    ctx = pipelineContext({ mode: 'RESEARCH' });
    const env = testEnv();
    let crashes = 0;
    const handler = workflowJobHandler<PipelineParams>({
      type: 'weekly',
      description: 'weekly with a simulated crash in retrieve_memory (test)',
      workflow: 'weekly',
      paramsSchema: pipelineParamsSchema as unknown as z.ZodType<PipelineParams>,
      stages: (_p, jctx) =>
        createWeeklyStages(env, jctx.app).map((s): EngineStage =>
          s.name === 'retrieve_memory'
            ? {
                ...s,
                run: async (input, sctx) => {
                  if (crashes === 0) {
                    crashes++;
                    throw new Error('simulated crash in retrieve_memory');
                  }
                  return s.run(input, sctx);
                },
              }
            : s,
        ),
    });
    const runner = new JobRunner({ registry: new JobRegistry().register(handler), maxMode: ctx.mode });
    const first = await enqueueAndRun(ctx, runner, 'weekly', {}, { retryInline: false });
    expect(first.outcome).toBe('failed');
    const s1 = summarizeRun(ctx, first, false);
    expect(s1.workflow.failure).toMatchObject({ stage: 'retrieve_memory' });
    expect(s1.workflow.stages.find((s) => s.stage === 'research')?.status).toBe('succeeded');

    const dfsBefore = env.dfsCalls.length;
    const paidBefore = paidRequests(ctx);
    const reservationsBefore = count(ctx, 'SELECT COUNT(*) AS n FROM budget_reservations WHERE site_id = ?', [ctx.siteId]);
    const batchesBefore = count(ctx, 'SELECT COUNT(*) AS n FROM ingestion_batches WHERE site_id = ?', [ctx.siteId]);
    const crawlsBefore = count(ctx, 'SELECT COUNT(*) AS n FROM crawls WHERE site_id = ?', [ctx.siteId]);
    const competitorRequestsBefore = env.competitor.requests.length;

    const resumed = await runner.resume(ctx, first.job.id);
    const r2 = resumed.results[0]!;
    expect(r2.outcome).toBe('succeeded');
    const s2 = summarizeRun(ctx, r2, false);
    const byStage = Object.fromEntries(s2.workflow.stages.map((s) => [s.stage, s]));
    for (const s of ['acquire_lock', 'check_access', 'resume_pending', 'sync_gsc', 'plan_period', 'sync_ga4', 'crawl_site', 'performance', 'validate_joins', 'review_experiments', 'reconcile_urls', 'route_and_score', 'research', 'compare', 'index_memory']) {
      expect(byStage[s]!.resumedFromCheckpoint, s).toBe(true);
    }
    expect(byStage.retrieve_memory!.resumedFromCheckpoint).toBe(false);
    expect(byStage.retrieve_memory!.status).toBe('succeeded');
    expect(byStage.report!.status).toBe('succeeded');
    // Nothing completed was redone: no new provider calls, paid submissions, reservations, ingestion batches, or crawls.
    expect(env.dfsCalls.length).toBe(dfsBefore);
    expect(paidRequests(ctx)).toBe(paidBefore);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM budget_reservations WHERE site_id = ?', [ctx.siteId])).toBe(reservationsBefore);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM ingestion_batches WHERE site_id = ?', [ctx.siteId])).toBe(batchesBefore);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM crawls WHERE site_id = ?', [ctx.siteId])).toBe(crawlsBefore);
    expect(env.competitor.requests.length).toBe(competitorRequestsBefore);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM reports WHERE site_id = ? AND kind = 'weekly'", [ctx.siteId])).toBe(1);
  }, PIPELINE_TEST_TIMEOUT_MS);

  it('missing Google credentials (core profile): sync stages degrade honestly, routing reports invalid/incomplete data, the report is still produced', async () => {
    ctx = pipelineContext({ config: pipelineConfig({ profile: 'core' }), online: true });
    const r = await runPipeline(ctx, 'weekly', {}, { env: testEnv() });
    expect(r.outcome).toBe('succeeded');
    const degraded = Object.fromEntries(r.workflow.degraded.map((d) => [d.stage, d.code]));
    expect(degraded.sync_gsc).toBe('CREDENTIALS_MISSING');
    expect(degraded.sync_ga4).toBe('CREDENTIALS_MISSING');
    const joins = r.outputs.validate_joins as { gsc: { status: string }; note: { code: string } | null };
    expect(joins.gsc.status).not.toBe('complete');
    const report = r.outputs.report as ReportOutput;
    expect(report.accessIssues).toBeGreaterThan(0);
    expect(report.isSynthetic).toBe(false);
    expect(report.primaryAction).toMatch(/repair|wait|collect|measurement/i);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM gsc_page_daily WHERE site_id = ?', [ctx.siteId])).toBe(0);

    // C5-02: the Core profile disables Qdrant and embeddings by configuration: memory is full-text only BY POLICY,
    // an informational note naming the flags, never a degraded MEMORY_FTS_ONLY entry.
    const idx = new CheckpointStore(ctx.db, ctx.clock).latestWithOutput(ctx.siteId, r.jobId, 'index_memory')!.output as { index: { policy?: boolean; degraded: boolean; degradedReason: string | null }; note: { status: string; code: string | null; detail: string; nextStep: string | null } | null };
    expect(idx.index).toMatchObject({ policy: true, degraded: false, degradedReason: null });
    expect(idx.note).toMatchObject({ status: 'succeeded', code: 'MEMORY_FTS_ONLY_POLICY' });
    expect(idx.note!.detail).toMatch(/features\.embeddings and features\.qdrant are off in the site configuration \(not degraded\)/);
    expect(idx.note!.nextStep).toMatch(/features\.embeddings: true and features\.qdrant: true/);
    expect(idx.note!.nextStep).not.toMatch(/--approve-cost-plan|--allow-paid/);
    expect(r.degradedStages.some((d) => d.stage === 'index_memory' || d.code === 'MEMORY_FTS_ONLY')).toBe(false);
    expect(report.stageNotes.some((n) => n.stage === 'index_memory')).toBe(false);
    expect(renderPipelineRun(r)).toMatch(/\n {2}index_memory\s+succeeded/);
  }, PIPELINE_TEST_TIMEOUT_MS);

  // R3-NF-G8: in a dry run the syncs request and write nothing. Service-account mode without a credential
  // file (Application Default Credentials from a metadata server) cannot even be verified offline: the
  // stages say both, never a bare "succeeded".
  it('--dry-run with credentials that cannot be verified offline (ADC): sync stages are skipped (DRY_RUN) and say the credentials are unverified', async () => {
    ctx = pipelineContext({ config: pipelineConfig({ profile: 'core' }), online: true, dryRun: true });
    const home = path.join(ctx.paths.root, 'synthetic-empty-home'); // no gcloud ADC file: the metadata server would be used
    mkdirSync(home, { recursive: true });
    const provider = new ServiceAccountGoogleAuthProvider({ keyFile: null, fetch: ctx.fetch, env: { HOME: home } });
    const r = await runPipeline(ctx, 'weekly', {}, { env: testEnv({ googleProvider: provider }) });
    expect(r.dryRun).toBe(true);
    expect(r.outcome).toBe('succeeded');
    const counted = Object.fromEntries(r.degradedStages.map((d) => [d.stage, d]));
    for (const stage of ['sync_gsc', 'sync_ga4']) {
      expect(r.workflow.stages.find((s) => s.stage === stage)?.status, stage).toBe('succeeded');
      expect(counted[stage], stage).toMatchObject({ status: 'skipped', code: 'DRY_RUN', source: 'output' });
      expect(counted[stage]!.reason, stage).toMatch(/^Dry run: nothing was requested or written\. Credentials could not be verified offline\. Credentials NOT verified: .*metadata server/);
    }
    const report = r.outputs.report as ReportOutput;
    expect(report.stageNotes.find((n) => n.stage === 'sync_ga4')).toMatchObject({ status: 'skipped', code: 'DRY_RUN', nextStep: expect.stringMatching(/only the real run can verify these credentials .*auth diagnose/) });
    const text = renderPipelineRun(r);
    expect(text).toMatch(/^ {2}sync_gsc +skipped +DRY_RUN: Dry run: nothing was requested or written\. Credentials could not be verified offline\./m);
    expect(text).toMatch(/^ {2}crawl_site +skipped +CRAWL_DRY_RUN: /m);
    expect(text).not.toMatch(/^ {2}sync_g(sc|a4) +succeeded/m);
    expect(pipelineHeadline(r)).toMatch(/^succeeded \(degraded: .*sync_gsc \(DRY_RUN\)/);
    expect(ctx.logEntries.some((e) => e.level === 'warn' && e.msg.startsWith('Stage sync_ga4 skipped: DRY_RUN: Dry run: nothing was requested or written. Credentials could not be verified offline.'))).toBe(true);
    expect(refusingFetch.calls.filter((u) => /googleapis\.com|metadata/.test(u))).toEqual([]);
  }, PIPELINE_TEST_TIMEOUT_MS);

  it('Core-profile baseline: no MEMORY_FTS_ONLY degraded entry (full-text only by policy, C5-02)', async () => {
    ctx = pipelineContext({ config: pipelineConfig({ profile: 'core' }) });
    const r = await runPipeline(ctx, 'baseline', {}, { env: testEnv() });
    expect(r.outcome).toBe('succeeded');
    const idx = new CheckpointStore(ctx.db, ctx.clock).latestWithOutput(ctx.siteId, r.jobId, 'index_memory')!.output as { note: { status: string; code: string | null; nextStep: string | null } | null };
    expect(idx.note).toMatchObject({ status: 'succeeded', code: 'MEMORY_FTS_ONLY_POLICY' });
    // The baseline's paid-embedding hint (--approve-cost-plan) cannot help while the flags are off: the next step names them.
    expect(idx.note!.nextStep).not.toMatch(/--approve-cost-plan/);
    expect(r.degradedStages.some((d) => d.code === 'MEMORY_FTS_ONLY')).toBe(false);
    expect(pipelineHeadline(r)).not.toContain('MEMORY_FTS_ONLY');
    expect(ctx.db.get<{ degraded: number }>('SELECT degraded FROM memory_retrieval_state WHERE site_id = ?', [ctx.siteId])?.degraded).toBe(0);
  }, PIPELINE_TEST_TIMEOUT_MS);
});

describe('research candidates read ONE Search Console slice (NF-04)', () => {
  const PAGE = 'https://www.example.com/pricing';
  const pageCandidate = { id: 'opp_synthetic_1', route: 'RANKING_OPPORTUNITY', url: PAGE, query: null, score: 10, rawCounts: {} };
  const period = { start: '2026-09-14', end: '2026-09-20' };

  /** SYNTHETIC page/query rows of one property and search type (and page rows, which make the property "have data"). */
  function seedSlice(c: TestContext, property: string, searchType: string, rows: Array<{ query: string; impressions: number }>): void {
    const batch = seedBatch(c.db, c.siteId, { source: 'gsc', dataset: 'gsc_page_query_daily', property, start: period.start, end: period.end, searchType, synthetic: 1 });
    const common = { site_id: c.siteId, property, search_type: searchType, date: '2026-09-15', date_tz: 'America/Los_Angeles', page: PAGE, segment_key: '', aggregation_type: 'byPage', is_final: 1, revision: 1, is_current: 1, batch_id: batch, collected_at: '2026-09-22T06:00:00.000Z', transformation_version: 'test@1', is_synthetic: 1 };
    for (const r of rows) insertRow(c.db, 'gsc_page_query_daily', { ...common, query: r.query, clicks: 0, impressions: r.impressions, ctr: 0, position: 5, row_hash: sid('h') });
    const total = rows.reduce((a, r) => a + r.impressions, 0);
    insertRow(c.db, 'gsc_page_daily', { ...common, clicks: 0, impressions: total, ctr: 0, position: 5, row_hash: sid('h') });
  }

  it('two search types: only the configured primary type is read, never summed with image/news rows', () => {
    ctx = pipelineContext({ config: pipelineConfig({ google: { searchConsoleProperty: 'sc-domain:example.com', ga4PropertyId: '123456789', gsc: { searchTypes: ['web', 'image'] } } } as never) });
    seedSlice(ctx, 'sc-domain:example.com', 'web', [{ query: 'widget pricing', impressions: 10 }]);
    seedSlice(ctx, 'sc-domain:example.com', 'image', [{ query: 'widget pricing', impressions: 500 }, { query: 'widget photo', impressions: 1_000 }]);
    const plan = researchCandidatePlan(ctx, [pageCandidate], period);
    expect(plan.fallbackSkipped).toBeNull();
    expect(plan.candidates.map((c) => [c.query, c.impressions])).toEqual([['widget pricing', 10]]);
    expect(researchCandidates(ctx, [pageCandidate], period)).toEqual(plan.candidates);
  });

  it('two properties: only the configured property is read', () => {
    ctx = pipelineContext();
    seedSlice(ctx, 'sc-domain:example.com', 'web', [{ query: 'widget pricing', impressions: 10 }]);
    seedSlice(ctx, 'https://www.example.com/', 'web', [{ query: 'widget pricing', impressions: 500 }, { query: 'old property query', impressions: 1_000 }]);
    const plan = researchCandidatePlan(ctx, [pageCandidate], period);
    expect(plan.candidates.map((c) => [c.query, c.impressions])).toEqual([['widget pricing', 10]]);
  });

  it('no configured property: the only property with data is used; several are never mixed (skipped with the reason)', () => {
    ctx = pipelineContext({ config: pipelineConfig({ google: { searchConsoleProperty: null, ga4PropertyId: '123456789' } } as never) });
    expect(ctx.config.google.searchConsoleProperty).toBeNull();
    seedSlice(ctx, 'sc-domain:example.com', 'web', [{ query: 'widget pricing', impressions: 10 }]);
    expect(researchGscScope(ctx)).toEqual({ scope: { property: 'sc-domain:example.com', searchType: 'web' }, skipped: null });
    expect(researchCandidatePlan(ctx, [pageCandidate], period).candidates.map((c) => c.query)).toEqual(['widget pricing']);

    seedSlice(ctx, 'https://www.example.com/', 'web', [{ query: 'old property query', impressions: 1_000 }]);
    const plan = researchCandidatePlan(ctx, [pageCandidate], period);
    expect(plan.candidates).toEqual([]);
    expect(plan.fallbackSkipped).toMatch(/query fallback for page-level candidates was skipped: no google\.searchConsoleProperty is configured and several Search Console properties have data/);
    // Query-level candidates do not need the fallback and are kept.
    const withQuery = researchCandidatePlan(ctx, [{ ...pageCandidate, id: 'opp_synthetic_2', query: 'widget pricing', rawCounts: { impressions: 7 } }, pageCandidate], period);
    expect(withQuery.candidates.map((c) => c.query)).toEqual(['widget pricing']);
    expect(withQuery.fallbackSkipped).not.toBeNull();
  });
});

describe('weekly deep analysis (compare) and memory ingestion', () => {
  it('compares the top researched candidate with its localized SERP competitors, persists it, and states why synthesis was skipped (demo fixture client)', async () => {
    ctx = pipelineContext({ mode: 'RESEARCH' });
    const env = testEnv();
    const stages = createWeeklyStages(env, ctx);
    const compare = stages.find((s) => s.name === 'compare')!;
    expect(compare.costAllowance).toBe('none'); // demo fixture client: no LLM allowance
    expect(stages.find((s) => s.name === 'research')!.next).toEqual(['compare']);
    expect(stages.find((s) => s.name === 'recommend')!.optionalPrerequisites).toContain('compare');
    const r = await runPipeline(ctx, 'weekly', {}, { env });
    expect(r.outcome).toBe('succeeded');
    const out = r.outputs.compare as CompareOutput;
    expect(out.comparisons.length).toBeGreaterThanOrEqual(1);
    expect(out.comparisons.length).toBeLessThanOrEqual(3);
    const c = out.comparisons[0]!;
    expect(c.competitorsCompared).toBeGreaterThanOrEqual(1);
    expect(c.competitorsInaccessible).toBeGreaterThanOrEqual(1); // robots/403 pages are never compared
    expect(c.synthetic).toBe(true);
    expect(c.serp).toMatchObject({ locationCode: 9990001, languageCode: 'en', device: 'desktop' });
    expect(c.synthesis).toMatchObject({ status: 'skipped' });
    expect(c.synthesis.reason).toMatch(/^synthesis skipped: the demo fixture LLM client/);
    expect(c.caveats.join(' ')).toMatch(/SYNTHETIC/);
    const rows = ctx.db.all<{ id: string; query: string; is_synthetic: number; synthesis_status: string; run_id: string; location_code: number; device: string }>('SELECT id, query, is_synthetic, synthesis_status, run_id, location_code, device FROM competitive_comparisons WHERE site_id = ?', [ctx.siteId]);
    expect(rows).toHaveLength(out.comparisons.length);
    expect(rows[0]).toMatchObject({ id: c.id, query: c.query, is_synthetic: 1, synthesis_status: 'skipped', run_id: r.jobId, location_code: 9990001, device: 'desktop' });
    // Memory was ingested (free) before retrieval.
    const idx = r.workflow.stages.map((s) => s.stage);
    expect(idx.indexOf('index_memory')).toBeLessThan(idx.indexOf('retrieve_memory'));
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM memory_documents WHERE site_id = ?', [ctx.siteId])).toBeGreaterThan(0);
  }, 60_000);

  it('runs the SERP synthesis only with a configured reasoning model, within a small LLM allowance', async () => {
    ctx = pipelineContext({ mode: 'RESEARCH' });
    // SYNTHETIC in-memory model (injected; not the demo fixture client).
    const llm = new FakeLlm((req) =>
      req.promptId === 'analysis.serp-synthesis'
        ? { summary: 'Synthetic synthesis: offer pages dominate this SERP.', intentAssessment: { text: 'Commercial intent.', label: 'INFERRED' }, ourAdvantages: [], gapsWorthResearching: [], caveats: ['synthetic'] }
        : { classifications: [] },
    );
    const env = testEnv({ llm });
    const compare = createWeeklyStages(env, ctx).find((s) => s.name === 'compare')!;
    expect(compare.costAllowance).toEqual([{ provider: 'llm_gateway', maxMicros: Math.floor(ctx.settings.budgets.llmGateway.perRun * 0.1) }]);
    const r = await runPipeline(ctx, 'weekly', {}, { env });
    expect(r.outcome).toBe('succeeded');
    const out = r.outputs.compare as CompareOutput;
    expect(out.synthesis.allowed).toBe(true);
    expect(out.comparisons[0]!.synthesis).toMatchObject({ status: 'ok', reason: null, summary: 'Synthetic synthesis: offer pages dominate this SERP.' });
    const synth = llm.requests.filter((q) => q.promptId === 'analysis.serp-synthesis');
    expect(synth).toHaveLength(out.comparisons.length);
    expect(synth[0]!.tier).toBe('reasoning');
    expect(ctx.db.get<{ s: string; j: string }>('SELECT synthesis_status AS s, synthesis_json AS j FROM competitive_comparisons WHERE site_id = ?', [ctx.siteId])!.s).toBe('ok');
  }, 60_000);

  it('without a reasoning model: no LLM allowance, and "synthesis skipped: <reason>" is recorded', async () => {
    ctx = pipelineContext({ mode: 'RESEARCH' });
    const noReasoning = new FakeLlm(() => ({ classifications: [] }), { cheap: true, reasoning: false });
    const env2 = testEnv({ llm: noReasoning });
    expect(createWeeklyStages(env2, ctx).find((s) => s.name === 'compare')!.costAllowance).toBe('none');
    const r2 = await runPipeline(ctx, 'weekly', {}, { env: env2 });
    const out2 = r2.outputs.compare as CompareOutput;
    expect(out2.comparisons[0]!.synthesis.reason).toMatch(/^synthesis skipped: no reasoning model is configured/);
    expect(noReasoning.requests.some((q) => q.promptId === 'analysis.serp-synthesis')).toBe(false);
  }, 60_000);

  it('ANALYZE mode: no research, so no comparison; the recommendation is still made', async () => {
    ctx = pipelineContext();
    const r = await runPipeline(ctx, 'weekly', {}, { env: testEnv() });
    expect(r.outcome).toBe('succeeded');
    expect(r.workflow.degraded.find((d) => d.stage === 'compare')?.code).toBe('PREREQUISITE_UNSATISFIED');
    expect(r.workflow.stages.find((s) => s.stage === 'index_memory')?.status).toBe('succeeded');
    expect(r.outputs.recommend).toBeDefined();
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM competitive_comparisons WHERE site_id = ?', [ctx.siteId])).toBe(0);
  }, 60_000);
});
