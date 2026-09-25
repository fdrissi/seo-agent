import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { budgetTimeZone, createAppContext, type AppContext } from '../app/context.js';
import { BudgetService, SYNTHETIC_DEMO_COSTS } from '../budgets/budget-service.js';
import { COMPUTED_COST_NOTE } from '../budgets/types.js';
import { collectStatuses, defaultFixtureSiteDir, type AppServices } from '../app/services.js';
import { applyDecisionEffects } from '../approvals/effects.js';
import { exportSubject } from '../approvals/export.js';
import { markImplemented } from '../approvals/implementation.js';
import { ApprovalService } from '../approvals/service.js';
import { validateApproverName } from '../approvals/approver.js';
import { fixedClock, type Clock } from '../core/clock.js';
import { AppError, errorMessage, isAppError } from '../core/errors.js';
import { createLogger, type Logger } from '../core/logger.js';
import { formatUsd, toMicros } from '../core/money.js';
import { MemorySecretStore } from '../config/secrets.js';
import { readManifest } from '../config/workspace.js';
import { runContentProductionJob } from '../content/jobs.js';
import { maxRevisions } from '../content/review.js';
import { ingestSyntheticDataset } from '../integrations/apify/runs.js';
import { JobRegistry } from '../jobs/registry.js';
import { JobRunner, enqueueAndRun } from '../jobs/runner.js';
import { getJob } from '../jobs/store.js';
import { stageDisplayRows, stageOutputNotes, workflowDegradedStages, workflowJobHandler, type DegradedStageSummary } from '../jobs/workflow-handler.js';
import { checkVault } from '../obsidian/check.js';
import { renderAll } from '../obsidian/notes.js';
import { buildDashboard } from '../reports/dashboard.js';
import { wikiLinkResolver } from '../reports/links.js';
import { proposeFromRecommendation } from '../experiments/propose.js';
import { risksStated } from '../experiments/repository.js';
import { specifyRecommendationChange } from '../experiments/specify-change.js';
import { isInvestigationActionType } from '../approvals/change.js';
import { pipelineParamsSchema, type PipelineParams, type ReportOutput } from '../workflows/pipelines/common.js';
import { contentDepsFrom } from '../workflows/pipelines/content-queue.js';
import { runPipeline, summarizeRun, type PipelineRunResult } from '../workflows/pipelines/handlers.js';
import { WEEKLY_WORKFLOW, createWeeklyStages, type ResearchOutput } from '../workflows/pipelines/weekly.js';
import type { EngineStage } from '../workflows/stage.js';
import { createDemoEnv, demoApifyItems, demoBudgetPrices, type DemoEnv } from './fixtures.js';
import { prepareDemoWorkspace, type PreparedDemoWorkspace } from './workspace.js';

/**
 * The offline demo (spec sections 29 and 31, "Demo profile").
 *
 * Runs the real pipelines end to end in an ISOLATED demo workspace, on
 * SYNTHETIC fixtures only, with zero external network access:
 *
 *   1. workspace      isolated demo workspace (manifest kind "demo"), fictional site config, vault
 *   2. baseline       ingest GSC/GA4 fixtures (versioned), crawl the fixture site, reconcile, report, dashboard
 *   3. weekly         RESEARCH-mode weekly job, INTERRUPTED mid-run (simulated Ctrl+C)
 *   4. resume         the same job resumed from its checkpoints (completed stages and paid research not redone)
 *   5. routing        deterministic routes with reason codes
 *   6. recommendation one sourced recommendation (claim labels + evidence), research incl. blocked competitors
 *   7. content        Apify dataset fixture -> content queue -> brief -> draft approval (demo approver) -> draft -> quality review
 *   8. experiment     an audit recommendation is never tested as-is: the demo persona records ONE concrete SYNTHETIC
 *                     title/meta change (specify-change) -> proposed -> approved -> EXECUTE-mode manual export ->
 *                     synthetic deployment -> mark-implemented (full live verification) -> observing
 *   9. budgets        a SYNTHETIC priced run is reserved and reconciled (flagged synthetic, recorded as computed from
 *                     usage at list price) until a lowered per-run cap stops it; an unknown price is denied
 *  10. vault          entity notes + dashboard re-rendered, vault link check
 *  11. isolation      network requests (must be 0), synthetic flags, separate workspace
 *
 * Every value the demo produces is SYNTHETIC. The demo approver is an
 * explicit, labeled demo persona that exists only inside the demo workspace;
 * in a real workspace only a human approves (`approvals approve --as`).
 */

export const DEMO_APPROVER = 'Demo Approver - synthetic persona';
export const DEMO_SOURCE_REVISION = 'demo-site@r1 (synthetic)';
export const DEMO_DEPLOY_REVISION = 'demo-site@r2 (synthetic deployment)';
/** Stage at which the demo interrupts the weekly job (after the paid research stage completed). */
export const DEMO_INTERRUPT_STAGE = 'retrieve_memory';
export const SYNTHETIC_LABEL = 'SYNTHETIC';
/** Run id of the demo's synthetic priced budget run (reserve -> reconcile under a lowered per-run cap). */
export const DEMO_PRICED_RUN_ID = 'demo-synthetic-priced-run';
/**
 * Risks the labeled demo persona states when the recommendation it tests
 * states none (spec 23: an experiment is never proposed without its risks).
 * Clearly SYNTHETIC and never used outside the demo workspace.
 */
export const DEMO_SYNTHETIC_RISKS =
  'SYNTHETIC demo risk: the new title and meta description could lower click-through for queries the old wording matched, or describe the page less accurately than before; demo data only.';

/** The demo's steps, in order (ids are stable; used by the CLI plan, the walkthrough, and the tests). */
export const DEMO_STEPS: ReadonlyArray<readonly [string, string]> = [
  ['workspace', 'Isolated demo workspace'],
  ['baseline', 'Ingest fixtures and generate the vault (baseline job)'],
  ['interrupt', 'Weekly job (RESEARCH mode) interrupted mid-run'],
  ['resume', 'Resume the interrupted job from its last checkpoint'],
  ['routing', 'Route opportunities (deterministic rules with reason codes)'],
  ['recommendation', 'Sourced recommendation (claim labels + evidence)'],
  ['content', 'Content draft workflow (brief -> draft approval -> draft -> quality review)'],
  ['experiment', 'Record an experiment (proposed -> approved -> mark-implemented -> observing)'],
  ['budgets', 'Enforce budgets (synthetic priced run stopped by a lowered per-run cap; unknown price denied)'],
  ['vault', 'Vault: dashboard, pages, reports, experiments, drafts'],
  ['isolation', 'Isolation and honesty checks'],
];

const HOUR = 3_600_000;
const MINUTE = 60_000;

export type DemoStepStatus = 'ok' | 'degraded' | 'failed' | 'skipped';

export interface DemoStep {
  id: string;
  title: string;
  status: DemoStepStatus;
  /** Human-readable lines (every figure is synthetic). */
  lines: string[];
  artifacts: Array<{ label: string; path: string }>;
  data: Record<string, unknown>;
  error?: { code: string; message: string; hint?: string };
}

export interface DemoOptions {
  /** Demo directory (default `<os.tmpdir()>/seo-agent-demo`). */
  dir?: string;
  /**
   * Start of the simulated demo timeline. The demo advances a synthetic clock
   * by about one day and one hour; the default start (now minus two days)
   * keeps every simulated timestamp in the past.
   */
  startAt?: string | Date;
  /** Explicit demo approver name (a labeled synthetic persona; validated like any human approver name). */
  approver?: string;
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
  /** Called after each step (progress output). */
  onStep?: (step: DemoStep) => void;
}

export interface DemoResult {
  synthetic: true;
  label: string;
  ok: boolean;
  workspace: { root: string; kind: string; vaultDir: string; dbFile: string; configFile: string; siteDir: string; refreshed: boolean; untouched: string[] };
  site: { id: string; businessName: string; url: string };
  timeline: { start: string; end: string; note: string };
  steps: DemoStep[];
  network: { externalRequests: number; attempted: string[]; dataforseoFixtureRequests: number; competitorFixtureRequests: number };
  paths: Record<string, string | null>;
  nextCommands: string[];
}

class StepFailed extends Error {}

function rel(root: string, p: string | null | undefined): string | null {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.join(root, p);
}

function count(ctx: AppContext, sql: string, params: unknown[] = []): number {
  return Number(ctx.db.get<{ n: number }>(sql, params)?.n ?? 0);
}

function withMode(ctx: AppContext, mode: AppContext['mode']): AppContext {
  return { ...ctx, mode };
}

/** Counts every attempt to use the context's network (the demo must make none). */
function guardNetwork(ctx: AppContext, attempted: string[]): void {
  const inner = ctx.fetch;
  ctx.fetch = async (input, init) => {
    attempted.push(`${(init?.method ?? 'GET').toUpperCase()} ${String(input).replace(/\?.*$/, '')}`);
    return inner(input, init);
  };
}

/**
 * Stage lines as the pipeline commands print them (src/cli/commands/pipelines.ts):
 * a stage the engine recorded as succeeded whose own output says it was
 * skipped, degraded, or offline is shown with that status and its reason,
 * never as a bare "succeeded".
 */
export function stageLine(r: Pick<PipelineRunResult, 'workflow' | 'degradedStages' | 'outputs'>): string[] {
  // The same display rows as the pipeline commands (stageDisplayRows): output notes, the job record's output
  // entries, and the engine's degraded entries (a stage run without its optional paid work) are all applied.
  const rows = stageDisplayRows(r.workflow.stages, r.degradedStages, stageOutputNotes(r.outputs));
  return r.workflow.stages.map((s, i) => {
    const row = rows[i]!;
    return `  ${s.stage.padEnd(20)} ${row.shown}${s.resumedFromCheckpoint ? ' (from checkpoint)' : ''}${s.error ? `  ${s.error.code}: ${s.error.message}` : row.reason ? `  ${row.reason}` : ''}`;
  });
}

/** One line naming the stages that did not do all of their work (the combined list `jobs show` uses), or nothing. */
function degradedLine(r: Pick<PipelineRunResult, 'degradedStages'>, what = 'Stages that did not do all of their work'): string[] {
  if (!r.degradedStages.length) return [];
  return [`${what} (${r.degradedStages.length}): ${r.degradedStages.map((d) => `${d.stage} ${d.status} (${d.code})`).join(', ')}.`];
}

/** The combined degraded list persisted on a job record (what `jobs show` prints); empty for an unknown job. */
function recordedDegradedStages(ctx: AppContext, jobId: string | null | undefined): DegradedStageSummary[] {
  if (!jobId) return [];
  return workflowDegradedStages(getJob(ctx.db, ctx.siteId, jobId)?.result);
}

function reportArtifacts(root: string, vaultDir: string, report: ReportOutput | undefined): Array<{ label: string; path: string }> {
  if (!report) return [];
  const out: Array<{ label: string; path: string }> = [];
  if (report.markdownFile) out.push({ label: `${report.kind} report (Markdown + JSON, SYNTHETIC)`, path: rel(root, report.markdownFile)! });
  if (report.vaultNote) out.push({ label: `${report.kind} report vault note`, path: path.join(vaultDir, report.vaultNote) });
  if (report.dashboard) out.push({ label: 'Dashboard', path: path.join(vaultDir, report.dashboard) });
  return out;
}

export async function runDemo(opts: DemoOptions = {}): Promise<DemoResult> {
  const start = opts.startAt ? new Date(opts.startAt) : new Date(Math.floor((Date.now() - 2 * 24 * HOUR) / MINUTE) * MINUTE);
  if (Number.isNaN(start.getTime())) throw new AppError('VALIDATION_FAILED', `Invalid demo start time: ${String(opts.startAt)}`);
  const approver = validateApproverName(opts.approver ?? DEMO_APPROVER);
  const clock = fixedClock(start);
  const steps: DemoStep[] = [];
  const attempted: string[] = [];

  const record = (step: DemoStep): DemoStep => {
    steps.push(step);
    opts.onStep?.(step);
    return step;
  };

  // ---------------------------------------------------------------- 1. workspace
  // Throws (touching nothing) when the directory is not safe for the demo.
  const ws: PreparedDemoWorkspace = prepareDemoWorkspace({ ...(opts.dir ? { dir: opts.dir } : {}), now: clock.now(), fixtureSiteDir: defaultFixtureSiteDir(), ...(opts.env ? { env: opts.env } : {}) });
  const logger = opts.logger ?? createLogger({ file: path.join(ws.paths.logsDir, 'seo-agent.log'), console: false, base: { site: ws.config.site.id, demo: true } });
  const ctx = createAppContext({
    workspaceRoot: ws.root,
    siteId: ws.config.site.id,
    config: ws.config,
    // Never the owner's environment or secrets file: the demo needs no credentials.
    secrets: new MemorySecretStore({}),
    clock,
    logger,
    offline: true,
    mode: 'ANALYZE',
  });
  guardNetwork(ctx, attempted);
  const env = createDemoEnv({ siteDir: ws.siteDir, userAgent: ctx.config.crawl.userAgent });
  const services = (c: AppContext): AppServices => env.services(c);
  const paths: Record<string, string | null> = {
    workspace: ws.root,
    vault: ws.vaultDir,
    database: ctx.paths.dbFile,
    config: ws.configFile,
    dashboard: null,
    baselineReport: null,
    weeklyReport: null,
    draft: null,
    exportPackage: null,
  };

  try {
    record({
      id: 'workspace',
      title: 'Isolated demo workspace',
      status: 'ok',
      lines: [
        `${ws.refreshed ? 'Refreshed the previous demo' : 'Created a new demo workspace'} at ${ws.root} (manifest kind "${readManifest(ws.paths)?.kind}"; a live workspace is never touched).`,
        `Fictional business: ${ws.config.site.businessName} on ${ws.config.site.url} (reserved example domain, SYNTHETIC).`,
        'Profile "demo": fixture Google provider, deterministic fixture LLM, synthetic DataForSEO transport, synthetic Apify dataset, fixture crawler. No credentials are read; network access is disabled.',
        ...(ws.untouched.length ? [`Left untouched (not created by the demo): ${ws.untouched.join(', ')}`] : []),
      ],
      artifacts: [
        { label: 'Demo site config (SYNTHETIC)', path: ws.configFile },
        { label: 'Demo vault', path: ws.vaultDir },
        { label: 'Demo database (separate from any live workspace)', path: ctx.paths.dbFile },
      ],
      data: { root: ws.root, refreshed: ws.refreshed, untouched: ws.untouched },
    });

    // ------------------------------------------------------------- 2. baseline
    const baseline = await runPipeline(ctx, 'baseline', {}, { env });
    const baselineReport = baseline.outputs.report as ReportOutput | undefined;
    paths.baselineReport = rel(ws.root, baselineReport?.markdownFile ?? null);
    paths.dashboard = baselineReport?.dashboard ? path.join(ws.vaultDir, baselineReport.dashboard) : null;
    const ingest = {
      gscPageRows: count(ctx, 'SELECT COUNT(*) AS n FROM gsc_page_daily WHERE site_id = ?', [ctx.siteId]),
      gscQueryRows: count(ctx, 'SELECT COUNT(*) AS n FROM gsc_page_query_daily WHERE site_id = ?', [ctx.siteId]),
      ga4LandingRows: count(ctx, 'SELECT COUNT(*) AS n FROM ga4_landing_daily WHERE site_id = ?', [ctx.siteId]),
      ga4PeriodRows: count(ctx, 'SELECT COUNT(*) AS n FROM ga4_period_metrics WHERE site_id = ?', [ctx.siteId]),
      crawledPages: count(ctx, "SELECT COUNT(*) AS n FROM crawl_results WHERE site_id = ? AND render_mode = 'fixture'", [ctx.siteId]),
      nonSyntheticRows:
        count(ctx, 'SELECT COUNT(*) AS n FROM gsc_page_daily WHERE site_id = ? AND is_synthetic = 0', [ctx.siteId]) +
        count(ctx, 'SELECT COUNT(*) AS n FROM ga4_landing_daily WHERE site_id = ? AND is_synthetic = 0', [ctx.siteId]),
    };
    const plan = baseline.outputs.cost_plan as { display?: string; approved?: boolean } | undefined;
    record({
      id: 'baseline',
      title: 'Ingest fixtures and generate the vault (baseline job)',
      // The combined degraded list (engine + stage output notes), as `jobs show` and the pipeline commands report it.
      status: baseline.outcome === 'succeeded' ? (baseline.degradedStages.length ? 'degraded' : 'ok') : 'failed',
      lines: [
        `Baseline job ${baseline.jobId}: ${baseline.outcome}${baseline.note ? ` (${baseline.note})` : ''}.`,
        `SYNTHETIC ingestion: ${ingest.gscPageRows} GSC page-day rows, ${ingest.gscQueryRows} page/query-day rows, ${ingest.ga4LandingRows} GA4 landing-page rows, ${ingest.ga4PeriodRows} GA4 period metrics; ${ingest.crawledPages} fixture pages crawled (render_mode "fixture"). Rows not flagged synthetic: ${ingest.nonSyntheticRows}.`,
        `Cost plan for optional AI work shown, not executed (approved: ${plan?.approved ? 'yes' : 'no'}); the baseline makes no paid DataForSEO/Apify request, starts no experiment, publishes nothing.`,
        ...(baselineReport ? [`Baseline report ${baselineReport.reportId} [SYNTHETIC]: confidence ${baselineReport.confidence}, ${baselineReport.warnings} warning(s).`] : []),
        ...degradedLine(baseline),
        ...stageLine(baseline),
      ],
      artifacts: reportArtifacts(ws.root, ws.vaultDir, baselineReport),
      data: {
        jobId: baseline.jobId,
        outcome: baseline.outcome,
        ingest,
        degraded: baseline.degradedStages,
        paidResearchRequests: env.dataforseoCalls.length,
        experiments: count(ctx, 'SELECT COUNT(*) AS n FROM experiments WHERE site_id = ?', [ctx.siteId]),
        publications: count(ctx, 'SELECT COUNT(*) AS n FROM publications WHERE site_id = ?', [ctx.siteId]),
      },
    });
    if (baseline.outcome !== 'succeeded') throw new StepFailed('baseline did not succeed');

    // A synthetic day passes: recent Search Console days are revised by the fixture provider.
    clock.advanceMs(24 * HOUR);

    // ---------------------------------------------- 3. weekly, interrupted mid-run
    const research = withMode(ctx, 'RESEARCH');
    const interrupt = new AbortController();
    const interruptingHandler = workflowJobHandler<PipelineParams>({
      type: 'weekly',
      description: 'Weekly pipeline (demo run that is interrupted once, like Ctrl+C, before retrieve_memory completes)',
      workflow: WEEKLY_WORKFLOW,
      paramsSchema: pipelineParamsSchema as unknown as z.ZodType<PipelineParams>,
      maxAttempts: 2,
      stages: (_p, jctx) =>
        createWeeklyStages(env, jctx.app).map((s): EngineStage =>
          s.name === DEMO_INTERRUPT_STAGE
            ? {
                ...s,
                run: async (_input, sctx) => {
                  // Simulated interruption (e.g. Ctrl+C / process stop) while this stage runs.
                  interrupt.abort();
                  if (!sctx.signal.aborted) await new Promise((resolve) => sctx.signal.addEventListener('abort', resolve, { once: true }));
                  throw sctx.signal.reason;
                },
              }
            : s,
        ),
    });
    const runner = new JobRunner({ registry: new JobRegistry().register(interruptingHandler), maxMode: research.mode });
    const interrupted = await enqueueAndRun(research, runner, 'weekly', {}, { actor: 'demo', retryInline: false, signal: interrupt.signal });
    if (runner.pendingLockHolds) await runner.settled();
    const firstRun = summarizeRun(research, interrupted, false);
    const before = {
      dataforseoRequests: env.dataforseoCalls.length,
      competitorRequests: env.competitor.requests.length,
      paidSubmissions: count(ctx, "SELECT COUNT(*) AS n FROM provider_requests WHERE site_id = ? AND provider = 'dataforseo' AND method = 'POST'", [ctx.siteId]),
      reservations: count(ctx, 'SELECT COUNT(*) AS n FROM budget_reservations WHERE site_id = ?', [ctx.siteId]),
      ingestionBatches: count(ctx, 'SELECT COUNT(*) AS n FROM ingestion_batches WHERE site_id = ?', [ctx.siteId]),
      crawls: count(ctx, 'SELECT COUNT(*) AS n FROM crawls WHERE site_id = ?', [ctx.siteId]),
    };
    const revisedRows = count(ctx, 'SELECT COUNT(*) AS n FROM gsc_page_daily WHERE site_id = ? AND revision > 1', [ctx.siteId]);
    // Checkpointed = the engine recorded the stage as succeeded. Only the stages that also did all of their work are
    // "completed": a checkpointed stage whose display status is offline/degraded/skipped (e.g. performance offline,
    // research with blocked competitors) is listed apart with its code, never as completed work.
    const interruptRows = stageDisplayRows(firstRun.workflow.stages, firstRun.degradedStages, stageOutputNotes(firstRun.outputs)).filter((row) => row.status === 'succeeded');
    const checkpointedBefore = interruptRows.map((row) => row.stage);
    const completedBefore = interruptRows.filter((row) => row.shown === 'succeeded').map((row) => row.stage);
    const degradedBefore = interruptRows.filter((row) => row.shown !== 'succeeded').map((row) => ({ stage: row.stage, status: row.shown, code: row.code ?? row.shown.toUpperCase() }));
    record({
      id: 'interrupt',
      title: `Weekly job (RESEARCH mode) interrupted during ${DEMO_INTERRUPT_STAGE}`,
      status: interrupted.outcome === 'interrupted' ? 'ok' : 'failed',
      lines: [
        `Weekly job ${firstRun.jobId}: ${interrupted.outcome} (job status ${firstRun.jobStatus}). The demo simulated an interruption (like Ctrl+C) while "${DEMO_INTERRUPT_STAGE}" ran.`,
        `Completed and checkpointed before the interruption: ${completedBefore.join(', ') || 'none'}.`,
        ...(degradedBefore.length
          ? [`Checkpointed before the interruption but degraded, offline, or skipped (did not do all of their work; reused as is on resume): ${degradedBefore.map((d) => `${d.stage} ${d.status} (${d.code})`).join(', ')}.`]
          : []),
        `Versioned ingestion: one synthetic day later, ${revisedRows} Search Console page-day row(s) were stored as NEW revisions (recent days revised by the fixture provider; the current view shows only the latest revision, nothing is double-counted).`,
        `Synthetic DataForSEO fixture requests so far: ${before.dataforseoRequests}; synthetic competitor fixture requests: ${before.competitorRequests}.`,
      ],
      artifacts: [],
      data: { jobId: firstRun.jobId, outcome: interrupted.outcome, completedBefore, checkpointedBefore, degradedBefore, revisedRows, before },
    });
    if (interrupted.outcome !== 'interrupted') throw new StepFailed('the weekly job was not interrupted as planned');

    // ------------------------------------------------------ 4. resume from checkpoint
    const resumed = await runPipeline(research, 'weekly', {}, { env, resumeJobId: firstRun.jobId });
    const after = {
      dataforseoRequests: env.dataforseoCalls.length,
      competitorRequests: env.competitor.requests.length,
      paidSubmissions: count(ctx, "SELECT COUNT(*) AS n FROM provider_requests WHERE site_id = ? AND provider = 'dataforseo' AND method = 'POST'", [ctx.siteId]),
      reservations: count(ctx, 'SELECT COUNT(*) AS n FROM budget_reservations WHERE site_id = ?', [ctx.siteId]),
      ingestionBatches: count(ctx, 'SELECT COUNT(*) AS n FROM ingestion_batches WHERE site_id = ?', [ctx.siteId]),
      crawls: count(ctx, 'SELECT COUNT(*) AS n FROM crawls WHERE site_id = ?', [ctx.siteId]),
    };
    const fromCheckpoint = resumed.workflow.stages.filter((s) => s.resumedFromCheckpoint).map((s) => s.stage);
    const rerun = resumed.workflow.stages.filter((s) => !s.resumedFromCheckpoint).map((s) => s.stage);
    const nothingRedone = (Object.keys(before) as Array<keyof typeof before>).every((k) => before[k] === after[k]);
    const weeklyReport = resumed.outputs.report as ReportOutput | undefined;
    paths.weeklyReport = rel(ws.root, weeklyReport?.markdownFile ?? null);
    if (weeklyReport?.dashboard) paths.dashboard = path.join(ws.vaultDir, weeklyReport.dashboard);
    record({
      id: 'resume',
      title: 'Resume the interrupted job from its last checkpoint',
      status: resumed.outcome === 'succeeded' && nothingRedone ? (resumed.degradedStages.length ? 'degraded' : 'ok') : 'failed',
      lines: [
        `Resumed job ${resumed.jobId}: ${resumed.outcome}${resumed.note ? ` (${resumed.note})` : ''}.`,
        `Reused from checkpoints (not redone): ${fromCheckpoint.join(', ')}.`,
        `Ran after the resume: ${rerun.join(', ')}.`,
        nothingRedone
          ? `No completed work was repeated. Counts before -> after the resume: ${countsLine(before, after)}.${before.reservations === 0 ? ' (The fixture research is free and reserves no budget in either run; the budget step below exercises reservations.)' : ''}`
          : `WARNING: counts changed during the resume: ${countsLine(before, after)}`,
        ...(weeklyReport ? [`Weekly report ${weeklyReport.reportId} [SYNTHETIC]: confidence ${weeklyReport.confidence}, ${weeklyReport.warnings} warning(s), ${weeklyReport.accessIssues} access issue(s).`] : []),
        ...degradedLine(resumed),
      ],
      artifacts: reportArtifacts(ws.root, ws.vaultDir, weeklyReport),
      data: { jobId: resumed.jobId, outcome: resumed.outcome, fromCheckpoint, rerun, before, after, nothingRedone, degraded: resumed.degradedStages },
    });
    if (resumed.outcome !== 'succeeded') throw new StepFailed('the resumed weekly job did not succeed');

    // ---------------------------------------------------------------- 5. routing
    const routes = ctx.db.all<{ route: string; n: number }>(
      `SELECT route, COUNT(*) AS n FROM route_decisions WHERE site_id = ? AND job_id = ? GROUP BY route ORDER BY n DESC, route`,
      [ctx.siteId, resumed.jobId],
    );
    const routeExamples = ctx.db.all<{ route: string; reason_codes: string | null; subject: string | null }>(
      `SELECT r.route, r.reason_codes_json AS reason_codes, COALESCE(p.url || CASE WHEN r.query IS NOT NULL THEN ' / "' || r.query || '"' ELSE '' END, r.query, r.subject_type) AS subject
       FROM route_decisions r LEFT JOIN pages p ON p.id = r.page_id AND p.site_id = r.site_id
       WHERE r.site_id = ? AND r.job_id = ? ORDER BY r.decided_at, r.id LIMIT 6`,
      [ctx.siteId, resumed.jobId],
    );
    record({
      id: 'routing',
      title: 'Route opportunities (deterministic rules with reason codes)',
      status: routes.length ? 'ok' : 'degraded',
      lines: [
        routes.length ? `Routes of this run [SYNTHETIC data]: ${routes.map((r) => `${r.route} x${r.n}`).join(', ')}.` : 'No route decisions were recorded for this run.',
        ...routeExamples.map((r) => `  - ${r.subject ?? '(site)'} -> ${r.route} (reason codes: ${reasonCodes(r.reason_codes).join(', ') || 'none'})`),
      ],
      artifacts: [],
      data: { routes, examples: routeExamples },
    });

    // ---------------------------------------------------- 6. sourced recommendation
    const researchOut = resumed.outputs.research as ResearchOutput | undefined;
    const rec = resumed.outputs.recommend as { primaryId?: string; kind?: string; title?: string; saved?: boolean } | undefined;
    const recRow = rec?.primaryId
      ? ctx.db.get<{ id: string; kind: string; action_type: string; title: string; query: string | null; diagnosis: string | null; hypothesis: string | null; proposed_change: string | null; details_json: string | null; status: string }>(
          'SELECT id, kind, action_type, title, query, diagnosis, hypothesis, proposed_change, details_json, status FROM recommendations WHERE site_id = ? AND id = ?',
          [ctx.siteId, rec.primaryId],
        )
      : undefined;
    const reportJson = weeklyReport?.markdownFile ? readReportJson(ws.root, weeklyReport.markdownFile) : null;
    const claims = reportJson ? collectClaims(reportJson) : [];
    const labelCounts = claims.reduce<Record<string, number>>((acc, c) => ((acc[c.label] = (acc[c.label] ?? 0) + 1), acc), {});
    const evidenced = claims.filter((c) => c.evidence > 0);
    const blocked = [...new Map((researchOut?.competitorPages ?? []).filter((p) => p.status === 'blocked').map((p) => [`${new URL(p.url).hostname}:${p.blockedReason}`, p])).values()];
    record({
      id: 'recommendation',
      title: 'Sourced recommendation (claim labels + evidence)',
      status: recRow ? 'ok' : 'failed',
      lines: [
        recRow ? `Primary: [${recRow.kind}/${recRow.action_type}] ${recRow.title} (recommendation ${recRow.id}, status ${recRow.status}) [SYNTHETIC]` : 'No recommendation was recorded.',
        ...(recRow?.diagnosis ? [`  Diagnosis: ${oneLine(recRow.diagnosis)}`] : []),
        ...(recRow?.hypothesis ? [`  Hypothesis: ${oneLine(recRow.hypothesis)}`] : []),
        `Weekly report claims by label: ${Object.entries(labelCounts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}; ${evidenced.length} claim(s) carry evidence links (source ids, retrieval dates).`,
        ...evidenced.slice(0, 3).map((c) => `  - ${c.label}: ${oneLine(c.text).slice(0, 140)} [${c.evidence} evidence link(s)]`),
        researchOut
          ? `Research [SANDBOX/SYNTHETIC, never usable for real recommendations]: ${researchOut.queries.length} query(ies), ${researchOut.competitorPages.length} competitor page(s); blocked and never bypassed: ${blocked.map((b) => `${new URL(b.url).hostname} (${b.blockedReason})`).join(', ') || 'none'}.`
          : 'Research did not run.',
      ],
      artifacts: weeklyReport?.markdownFile ? [{ label: 'Weekly report with labeled claims', path: rel(ws.root, weeklyReport.markdownFile)! }] : [],
      data: { recommendationId: recRow?.id ?? null, kind: recRow?.kind ?? null, actionType: recRow?.action_type ?? null, labelCounts, evidencedClaims: evidenced.length, blocked: blocked.map((b) => ({ url: b.url, reason: b.blockedReason })), researchSandbox: researchOut?.isSandbox ?? null },
    });

    // ------------------------------------------------------------- 7. content
    await contentStep(ctx, env, approver, clock, ws, paths, record);

    // ---------------------------------------------------------- 8. experiment
    await experimentStep(ctx, env, services, approver, clock, ws, paths, recRow?.id ?? null, record);

    // ------------------------------------------------------------- 9. budgets
    budgetStep(ctx, clock, record);

    // --------------------------------------------------------------- 10. vault
    await vaultStep(ctx, services, ws, paths, record);
  } catch (err) {
    if (!(err instanceof StepFailed)) {
      record({
        id: 'error',
        title: 'Demo stopped',
        status: 'failed',
        lines: [`The demo stopped: ${errorMessage(err)}`],
        artifacts: [],
        data: {},
        error: { code: isAppError(err) ? err.code : 'INTERNAL', message: errorMessage(err), ...(isAppError(err) && err.hint ? { hint: err.hint } : {}) },
      });
    }
  }

  // Steps that could not run after a failure are listed as skipped (never silently missing).
  for (const [id, title] of DEMO_STEPS) {
    if (id === 'isolation' || steps.some((s) => s.id === id)) continue;
    record({ id, title, status: 'skipped', lines: ['Not run because an earlier step failed (see above).'], artifacts: [], data: {} });
  }

  // ---------------------------------------------------------------- 11. isolation
  const isolation = isolationStep(ctx, env, attempted, ws);
  record(isolation);
  ctx.db.close();

  const ok = steps.every((s) => s.status === 'ok' || s.status === 'degraded');
  return {
    synthetic: true,
    label: SYNTHETIC_LABEL,
    ok,
    workspace: { root: ws.root, kind: 'demo', vaultDir: ws.vaultDir, dbFile: ctx.paths.dbFile, configFile: ws.configFile, siteDir: ws.siteDir, refreshed: ws.refreshed, untouched: ws.untouched },
    site: { id: ws.config.site.id, businessName: ws.config.site.businessName, url: ws.config.site.url },
    timeline: {
      start: start.toISOString(),
      end: clock.now().toISOString(),
      note: 'The demo runs on a SYNTHETIC clock (about one simulated day). Timestamps in the demo workspace follow that clock.',
    },
    steps,
    network: { externalRequests: attempted.length, attempted, dataforseoFixtureRequests: env.dataforseoCalls.length, competitorFixtureRequests: env.competitor.requests.length },
    paths,
    nextCommands: [
      `npm run cli -- --workspace "${ws.root}" jobs list`,
      `npm run cli -- --workspace "${ws.root}" report show weekly --latest`,
      `npm run cli -- --workspace "${ws.root}" approvals list --all`,
      `npm run cli -- --workspace "${ws.root}" experiments list`,
      `npm run cli -- --workspace "${ws.root}" costs`,
    ],
  };
}

function countsLine(before: Record<string, number>, after: Record<string, number>): string {
  const labels: Record<string, string> = {
    dataforseoRequests: 'synthetic DataForSEO fixture requests',
    competitorRequests: 'synthetic competitor requests',
    paidSubmissions: 'DataForSEO POST submissions',
    reservations: 'budget reservations',
    ingestionBatches: 'ingestion batches',
    crawls: 'crawls',
  };
  return Object.keys(before)
    .map((k) => `${labels[k] ?? k} ${before[k]} -> ${after[k]}`)
    .join(', ');
}

function reasonCodes(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as Array<{ code?: unknown; kind?: unknown }>;
    return Array.isArray(v) ? v.filter((x) => x && typeof x.code === 'string' && x.kind !== 'note').map((x) => String(x.code)) : [];
  } catch {
    return [];
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function readReportJson(root: string, markdownFile: string): unknown {
  const jsonFile = rel(root, markdownFile.replace(/\.md$/, '.json'))!;
  if (!existsSync(jsonFile)) return null;
  try {
    return JSON.parse(readFileSync(jsonFile, 'utf8'));
  } catch {
    return null;
  }
}

/** Every labeled claim in a report JSON (label, text, number of evidence links). */
export function collectClaims(report: unknown): Array<{ label: string; text: string; evidence: number }> {
  const out: Array<{ label: string; text: string; evidence: number }> = [];
  const LABELS = new Set(['OBSERVED', 'INFERRED', 'HYPOTHESIS', 'RECOMMENDATION', 'DATA_UNAVAILABLE']);
  const walk = (v: unknown, depth: number) => {
    if (depth > 12 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    if (typeof o.label === 'string' && LABELS.has(o.label) && typeof o.text === 'string') {
      out.push({ label: o.label, text: o.text, evidence: Array.isArray(o.evidence) ? o.evidence.length : 0 });
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(report, 0);
  return out;
}

// ---------------------------------------------------------------------------
// 7. content: Apify fixture -> queue -> brief -> approval -> draft -> review
// ---------------------------------------------------------------------------

async function contentStep(
  ctx: AppContext,
  env: DemoEnv,
  approver: string,
  clock: Clock & { advanceMs(ms: number): void },
  ws: PreparedDemoWorkspace,
  paths: Record<string, string | null>,
  record: (s: DemoStep) => DemoStep,
): Promise<void> {
  const lines: string[] = [];
  const artifacts: Array<{ label: string; path: string }> = [];
  const data: Record<string, unknown> = {};
  let status: DemoStepStatus = 'ok';
  try {
    clock.advanceMs(10 * MINUTE);
    const items = demoApifyItems();
    const apify = ingestSyntheticDataset(ctx, items, { label: 'demo: synthetic Reddit-like dataset', searchTerms: ctx.config.research.seedTopics, timeRange: 'month' });
    lines.push(`Apify dataset fixture: ${apify.normalized} synthetic item(s) normalized, ${apify.signals.created} signal(s) stored (is_synthetic = 1; no Apify run, token, or budget involved).`);
    data.apify = { runId: apify.apifyRunId, normalized: apify.normalized, signals: apify.signals.created };

    const queue = await runPipeline(ctx, 'content.queue', { useModel: true }, { env });
    const prioritize = queue.outputs.prioritize as { topItemId?: string | null } | undefined;
    const top = prioritize?.topItemId ?? null;
    const items2 = count(ctx, 'SELECT COUNT(*) AS n FROM content_items WHERE site_id = ?', [ctx.siteId]);
    lines.push(`Content queue job ${queue.jobId}: ${queue.outcome}${queue.note ? ` (${queue.note})` : ''}; ${items2} content item(s) discovered and prioritized from GSC queries and the Apify fixture (never drafts or publishes on its own).`);
    // The combined degraded list of the job (engine + stage output notes), as `jobs show` and the baseline/resume steps use it.
    if (queue.degradedStages.length) status = 'degraded';
    lines.push(...degradedLine(queue, 'Content queue stages that did not do all of their work'));
    data.queue = { jobId: queue.jobId, outcome: queue.outcome, items: items2, topItemId: top, degraded: queue.degradedStages };
    if (!top) {
      status = 'degraded';
      lines.push('No content item was prioritized, so no brief/draft was produced.');
      return;
    }
    const topItem = ctx.db.get<{ title: string; decision: string | null }>('SELECT title, decision FROM content_items WHERE site_id = ? AND id = ?', [ctx.siteId, top]);
    lines.push(`Top item ${top}: "${topItem?.title ?? '?'}" (decision: ${topItem?.decision ?? 'none'}) [SYNTHETIC].`);

    // Brief (ANALYZE mode): the job stops for the human draft approval.
    const source = contentDepsFrom(env);
    const briefRun = await runContentProductionJob(ctx, { itemId: top, useModel: true }, source);
    const brief = briefRun.outputs.brief as { briefId?: string | null; approvalRequestId?: string | null; approvalStatus?: string | null; gate?: { passed?: boolean } } | undefined;
    lines.push(`Brief: job ${briefRun.jobId} ${briefRun.outcome}${briefRun.stoppedBy ? ` at ${briefRun.stoppedBy.stage} (${briefRun.stoppedBy.status})` : ''}; brief ${brief?.briefId ?? 'none'}, draft approval request ${brief?.approvalRequestId ?? 'none'} (${brief?.approvalStatus ?? 'n/a'}).`);
    const briefDegraded = recordedDegradedStages(ctx, briefRun.jobId);
    if (briefDegraded.length) status = 'degraded';
    lines.push(...degradedLine({ degradedStages: briefDegraded }, 'Brief job stages that did not do all of their work'));
    data.brief = { jobId: briefRun.jobId, outcome: briefRun.outcome, briefId: brief?.briefId ?? null, approvalId: brief?.approvalRequestId ?? null, degraded: briefDegraded };
    const approvalId = brief?.approvalRequestId ?? null;
    if (!approvalId) {
      status = 'degraded';
      lines.push('No draft approval was requested (the brief did not pass its gate); drafting was not attempted.');
      return;
    }

    // The explicit demo approver records the draft approval (demo workspace only).
    clock.advanceMs(5 * MINUTE);
    assertDemoContext(ctx);
    const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
    const detail = gate.detail(ctx.siteId, approvalId);
    const decided = gate.approve(ctx.siteId, approvalId, { approver, confirmHashPrefix: detail.artifactHash.slice(0, 12), note: 'SYNTHETIC demo approval by the labeled demo persona.' });
    applyDecisionEffects(ctx.db, ctx.clock, decided, `owner:${approver}`);
    lines.push(`Draft approval ${approvalId} approved by "${approver}" (explicit demo persona; bound to brief hash ${detail.artifactHash.slice(0, 12)}...). In a real workspace only you approve: approvals approve <id> --as <name> --confirm <hash>.`);
    data.draftApproval = { id: approvalId, approver, status: decided.status };

    // Draft + quality review (DRAFT mode).
    clock.advanceMs(5 * MINUTE);
    const draftRun = await runContentProductionJob(withMode(ctx, 'DRAFT'), { itemId: top, useModel: true }, source);
    const draft = draftRun.outputs.draft as { draftId?: string; version?: number | null; unresolvedFacts?: number } | undefined;
    const review = draftRun.outputs.quality_review as { finalDraftId?: string | null; verdict?: string; reasons?: string[]; revisions?: number } | undefined;
    // The verdict belongs to the FINAL draft version: automated revisions supersede earlier versions.
    const finalDraft = describeFinalDraft(ctx, draft?.draftId ?? null, review);
    lines.push(
      `Draft: job ${draftRun.jobId} ${draftRun.outcome}${draftRun.stoppedBy ? ` at ${draftRun.stoppedBy.stage} (${draftRun.stoppedBy.status})` : ''}; first draft ${draft?.draftId ?? 'none'}${draft?.version ? ` (v${draft.version})` : ''} with ${draft?.unresolvedFacts ?? 0} unresolved fact(s) flagged (SYNTHETIC placeholder text from the fixture client).`,
    );
    lines.push(
      `Automated revisions before the stop: ${finalDraft.revisions} (max ${finalDraft.maxRevisions})${finalDraft.revisions && finalDraft.firstVersion !== null && finalDraft.finalVersion !== null ? `: v${finalDraft.firstVersion} -> v${finalDraft.finalVersion}; earlier versions are superseded` : ''}.`,
    );
    lines.push(
      `Final draft ${finalDraft.id ?? 'none'}${finalDraft.finalVersion !== null ? ` (v${finalDraft.finalVersion}, revision round ${finalDraft.revisionRound ?? '?'}, ${finalDraft.unresolvedFacts ?? '?'} unresolved fact(s))` : ''}: quality review verdict ${review?.verdict ?? 'none'}${review?.reasons?.length ? ` (${review.reasons.slice(0, 2).map(oneLine).join('; ')})` : ''}. Human review is always required; nothing is published.`,
    );
    const draftDegraded = recordedDegradedStages(ctx, draftRun.jobId);
    if (draftDegraded.length) status = 'degraded';
    lines.push(...degradedLine({ degradedStages: draftDegraded }, 'Draft job stages that did not do all of their work'));
    data.draft = {
      jobId: draftRun.jobId,
      degraded: draftDegraded,
      outcome: draftRun.outcome,
      draftId: draft?.draftId ?? null,
      firstVersion: finalDraft.firstVersion,
      finalDraftId: finalDraft.id,
      finalVersion: finalDraft.finalVersion,
      revisions: finalDraft.revisions,
      maxRevisions: finalDraft.maxRevisions,
      verdict: review?.verdict ?? null,
      stages: draftRun.stages.map((s) => s.stage),
    };
    if (!draft?.draftId) status = 'degraded';
    data.itemId = top;
  } catch (err) {
    status = 'failed';
    lines.push(`Content workflow error: ${errorMessage(err)}`);
  } finally {
    record({ id: 'content', title: 'Content draft workflow (brief -> draft approval -> draft -> quality review)', status, lines, artifacts, data });
  }
}

/**
 * The draft the quality verdict belongs to: the last version produced by the
 * automated revision loop (bounded by maxRevisions), with its version and the
 * number of automated revisions that ran before the stop.
 */
function describeFinalDraft(
  ctx: AppContext,
  firstDraftId: string | null,
  review: { finalDraftId?: string | null; revisions?: number } | undefined,
): { id: string | null; firstVersion: number | null; finalVersion: number | null; revisionRound: number | null; unresolvedFacts: number | null; revisions: number; maxRevisions: number } {
  const row = (id: string | null) =>
    id ? ctx.db.get<{ version: number; revision_round: number; unresolved_facts: number }>('SELECT version, revision_round, unresolved_facts FROM content_drafts WHERE site_id = ? AND id = ?', [ctx.siteId, id]) : undefined;
  const id = review?.finalDraftId ?? firstDraftId;
  const first = row(firstDraftId);
  const final = row(id);
  return {
    id,
    firstVersion: first?.version ?? null,
    finalVersion: final?.version ?? null,
    revisionRound: final?.revision_round ?? null,
    unresolvedFacts: final?.unresolved_facts ?? null,
    revisions: review?.revisions ?? 0,
    maxRevisions: maxRevisions(ctx),
  };
}

function assertDemoContext(ctx: AppContext): void {
  const manifest = readManifest(ctx.paths);
  if (!ctx.synthetic || ctx.config.profile !== 'demo' || manifest?.kind !== 'demo') {
    throw new AppError('POLICY_DENIED', 'The demo persona may only record approvals inside a demo workspace with the demo profile.');
  }
}

// ---------------------------------------------------------------------------
// 8. experiment: proposed -> approved -> export -> deploy -> mark-implemented
// ---------------------------------------------------------------------------

async function experimentStep(
  ctx: AppContext,
  _env: DemoEnv,
  services: (c: AppContext) => AppServices,
  approver: string,
  clock: Clock & { advanceMs(ms: number): void },
  ws: PreparedDemoWorkspace,
  paths: Record<string, string | null>,
  preferredRecommendationId: string | null,
  record: (s: DemoStep) => DemoStep,
): Promise<void> {
  const lines: string[] = [];
  const artifacts: Array<{ label: string; path: string }> = [];
  const data: Record<string, unknown> = {};
  let status: DemoStepStatus = 'ok';
  try {
    assertDemoContext(ctx);
    const recId = pickExperimentRecommendation(ctx, preferredRecommendationId);
    if (!recId) {
      status = 'degraded';
      lines.push('No production-bound recommendation is available to test, so no experiment was proposed (the router chose a no-action decision).');
      return;
    }
    const svc = services(ctx);
    const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
    clock.advanceMs(10 * MINUTE);
    // An audit/investigation recommendation is not a change: the demo persona first records ONE
    // concrete, SYNTHETIC title/meta change as a new recommendation revision (experiments specify-change).
    const source = ctx.db.get<{ action_type: string; title: string; hypothesis: string | null; risks: string | null }>('SELECT action_type, title, hypothesis, risks FROM recommendations WHERE site_id = ? AND id = ?', [ctx.siteId, recId]);
    // Spec 23: an experiment is never proposed without its risks. A recommendation that states none
    // (a secondary observation, a simple-draft primary) gets a clearly labeled SYNTHETIC risk from the demo persona.
    const syntheticRisks = source && !risksStated(source.risks) ? DEMO_SYNTHETIC_RISKS : null;
    if (syntheticRisks) {
      lines.push(`Recommendation ${recId} states no risks, and an experiment is never proposed without them: the labeled demo persona states a SYNTHETIC risk ("${syntheticRisks}").`);
      data.syntheticRisks = syntheticRisks;
    }
    let testedRecId = recId;
    const investigation = !!source && isInvestigationActionType(source.action_type);
    if (source && investigation) {
      const specified = specifyRecommendationChange(ctx, {
        recommendationId: recId,
        by: approver,
        ...syntheticTitleMetaChange(ctx, recId),
        note: 'SYNTHETIC demo: the labeled demo persona records one concrete title/meta change after the audit.',
        ...(source.hypothesis?.trim() ? {} : { hypothesis: 'SYNTHETIC demo hypothesis: a clearer, more specific title and meta description raise the click-through rate of this page without hurting lead quality.' }),
        ...(syntheticRisks ? { risks: syntheticRisks } : {}),
      });
      testedRecId = specified.recommendation.id;
      lines.push(
        `Recommendation ${recId} is an investigation ("${source.action_type}"), not a change. The demo persona recorded ONE concrete SYNTHETIC ${specified.change.kind} change as revision ${testedRecId} (${recId} is now superseded): ${oneLine(specified.recommendation.proposed_change ?? '')}`,
      );
      data.specified = { from: recId, to: testedRecId, kind: specified.change.kind, changeHash: specified.changeHash };
    }
    const proposed = await proposeFromRecommendation(
      ctx,
      gate,
      // The specified revision already carries the synthetic risks; a change recommendation gets them here.
      { recommendationId: testedRecId, requestedBy: `owner:${approver}`, sourceRevision: DEMO_SOURCE_REVISION, ...(syntheticRisks && !investigation ? { risks: syntheticRisks } : {}) },
      { targetChecker: svc.targetChecker },
    );
    const exp = proposed.experiment;
    const target = ctx.db.get<{ target_url: string }>('SELECT target_url FROM experiment_changes WHERE site_id = ? AND experiment_id = ?', [ctx.siteId, exp.id])?.target_url ?? null;
    lines.push(`Proposed ${exp.id} (${exp.type}) on ${target ?? 'the target page'} from recommendation ${testedRecId}: primary metric ${exp.primaryMetric}, minimum ${exp.minObservationDays} days [SYNTHETIC].`);
    data.proposed = { experimentId: exp.id, recommendationId: testedRecId, approvalId: proposed.approval.id, status: exp.status };

    clock.advanceMs(5 * MINUTE);
    const detail = gate.detail(ctx.siteId, proposed.approval.id);
    const decided = gate.approve(ctx.siteId, proposed.approval.id, { approver, confirmHashPrefix: detail.artifactHash.slice(0, 12), note: 'SYNTHETIC demo approval by the labeled demo persona.' });
    const effects = applyDecisionEffects(ctx.db, ctx.clock, decided, `owner:${approver}`);
    const afterApproval = statusOf(ctx, exp.id);
    lines.push(`Approved by "${approver}" (demo persona) for artifact ${detail.artifactHash.slice(0, 12)}... at revision ${DEMO_SOURCE_REVISION}: experiment is now ${afterApproval}.${effects.length ? ` ${effects.map(oneLine).join(' ')}` : ''}`);

    // EXECUTE-mode manual export: rechecks the target, consumes the one-time approval, writes a package. Nothing is published.
    clock.advanceMs(5 * MINUTE);
    const exported = await exportSubject(withMode(ctx, 'EXECUTE'), gate, { subjectType: 'experiment', subjectId: exp.id, actor: `owner:${approver}`, sourceRevision: DEMO_SOURCE_REVISION }, { targetChecker: svc.targetChecker });
    paths.exportPackage = exported.result?.exportDir ?? null;
    if (paths.exportPackage) artifacts.push({ label: 'Manual export package (SYNTHETIC; nothing was published)', path: paths.exportPackage });
    lines.push(`EXECUTE-mode manual export: ${exported.status}; target recheck ${exported.recheck?.status ?? 'n/a'}; approval consumed once. Package: ${paths.exportPackage ?? 'none'}.`);

    // Synthetic deployment: the demo edits ITS OWN copy of the fixture site, then records the implementation.
    clock.advanceMs(10 * MINUTE);
    const deployedAt = clock.now().toISOString();
    const deployed = applySyntheticDeployment(ws.siteDir, ctx.config.site.url, exported.targetUrl, proposalChange(ctx, exp.id));
    lines.push(`Synthetic deployment recorded at ${deployedAt} (SYNTHETIC implementation time): ${deployed.detail}`);
    clock.advanceMs(5 * MINUTE);
    const implemented = await markImplemented(ctx, gate, { subjectType: 'experiment', subjectId: exp.id, implementedAt: deployedAt, revision: DEMO_DEPLOY_REVISION, recordedBy: approver }, { fetcher: svc.pageFetcher });
    lines.push(
      `mark-implemented: publication ${implemented.publicationId} at ${implemented.implementedAt} (synthetic implementation time, revision ${implemented.sourceRevision}); live verification ${implemented.verification.status}${implemented.verification.reason ? ` (${oneLine(implemented.verification.reason)})` : ''}.`,
    );
    lines.push(`Experiment ${exp.id} is ${implemented.experiment?.status ?? statusOf(ctx, exp.id)}; the observation window starts at the implementation time (${implemented.experiment?.observationStart ?? '?'}), review ${implemented.experiment?.reviewDate ?? '?'}.`);
    const history = ctx.db.all<{ to_status: string }>('SELECT to_status FROM experiment_status_history WHERE site_id = ? AND experiment_id = ? ORDER BY id', [ctx.siteId, exp.id]).map((r) => r.to_status);
    lines.push(`Status history: ${history.join(' -> ')}.`);
    data.experiment = { id: exp.id, status: statusOf(ctx, exp.id), history, verification: implemented.verification.status, publicationId: implemented.publicationId, implementedAt: implemented.implementedAt, exportDir: paths.exportPackage };
    if (statusOf(ctx, exp.id) !== 'observing') status = 'failed';
  } catch (err) {
    status = 'failed';
    lines.push(`Experiment workflow error: ${errorMessage(err)}${isAppError(err) && err.hint ? ` Next step: ${err.hint}` : ''}`);
  } finally {
    record({ id: 'experiment', title: 'Record an experiment (proposed -> approved -> mark-implemented -> observing)', status, lines, artifacts, data });
  }
}

function findDraftNote(vaultDir: string): string | null {
  return listNotes(path.join(vaultDir, '05 Content', 'Drafts'))[0] ?? null;
}

function listNotes(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listNotes(abs));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(abs);
  }
  return out.sort();
}

function countMarkdown(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countMarkdown(path.join(dir, e.name));
    else if (e.isFile() && e.name.endsWith('.md')) n++;
  }
  return n;
}

function statusOf(ctx: AppContext, experimentId: string): string {
  return ctx.db.get<{ status: string }>('SELECT status FROM experiments WHERE site_id = ? AND id = ?', [ctx.siteId, experimentId])?.status ?? 'unknown';
}

/**
 * The recommendation the demo tests: one that states its risks (spec 23),
 * the weekly primary first among those; else the weekly primary or the
 * newest other proposed one (the demo persona then states SYNTHETIC risks).
 */
function pickExperimentRecommendation(ctx: AppContext, preferred: string | null): string | null {
  const rows = ctx.db.all<{ id: string; kind: string; action_type: string; risks: string | null }>(
    `SELECT id, kind, action_type, risks FROM recommendations WHERE site_id = ? AND status = 'proposed' AND kind IN ('primary', 'secondary') ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at DESC, id`,
    [ctx.siteId, preferred ?? ''],
  );
  return (rows.find((r) => risksStated(r.risks)) ?? rows[0])?.id ?? null;
}

/** A SYNTHETIC, clearly labeled title/meta change for the demo page of a recommendation. */
function syntheticTitleMetaChange(ctx: AppContext, recId: string): { title: string; metaDescription: string } {
  const row = ctx.db.get<{ url: string | null }>('SELECT p.url AS url FROM recommendations r LEFT JOIN pages p ON p.id = r.page_id AND p.site_id = r.site_id WHERE r.site_id = ? AND r.id = ?', [ctx.siteId, recId]);
  const where = row?.url ? new URL(row.url).pathname : '/';
  return {
    title: `${ctx.config.site.businessName}: ${where === '/' ? 'home' : where.replace(/^\/|\/$/g, '')} (SYNTHETIC demo title)`,
    metaDescription: `SYNTHETIC demo meta description for ${where} on a fictional site, recorded by the labeled demo persona; not a real proposal.`,
  };
}

function proposalChange(ctx: AppContext, experimentId: string): Record<string, unknown> {
  const row = ctx.db.get<{ change_json: string | null }>('SELECT change_json FROM experiment_changes WHERE site_id = ? AND experiment_id = ?', [ctx.siteId, experimentId]);
  try {
    return row?.change_json ? (JSON.parse(row.change_json) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Apply the approved change to the demo's OWN copy of the synthetic site
 * (title / meta description only; anything else is left as is and the
 * verification reports it honestly).
 */
export function applySyntheticDeployment(siteDir: string, siteUrl: string, targetUrl: string, change: Record<string, unknown>): { applied: string[]; detail: string } {
  const u = new URL(targetUrl);
  if (u.host !== new URL(siteUrl).host) return { applied: [], detail: `target ${targetUrl} is not on the demo site; nothing was changed.` };
  const relPath = u.pathname === '/' ? 'index.html' : `${u.pathname.replace(/^\//, '').replace(/\/$/, '/index')}.html`;
  const file = path.join(siteDir, ...relPath.split('/'));
  if (!file.startsWith(siteDir + path.sep) || !existsSync(file)) return { applied: [], detail: `no fixture page for ${u.pathname} in the demo site copy; nothing was changed.` };
  let html = readFileSync(file, 'utf8');
  const applied: string[] = [];
  // Canonical change fields (src/approvals/change.ts).
  const title = typeof change.title === 'string' ? change.title : null;
  const meta = typeof change.metaDescription === 'string' ? change.metaDescription : null;
  if (title && /<title>[\s\S]*?<\/title>/i.test(html)) {
    html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
    applied.push('title');
  }
  if (meta && /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i.test(html)) {
    html = html.replace(/<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i, `<meta name="description" content="${escapeHtml(meta)}">`);
    applied.push('meta description');
  }
  if (!applied.length) return { applied, detail: `the approved change is not a machine-applicable title/meta edit (for example an audit instruction), so the demo left its synthetic copy of ${relPath} unchanged; live verification reports this honestly instead of claiming a match.` };
  writeFileSync(file, html.replace('<!-- SYNTHETIC fixture page', '<!-- SYNTHETIC fixture page (demo deployment applied)'));
  return { applied, detail: `applied ${applied.join(' and ')} to the demo's own synthetic site copy (${relPath}); no real website exists or was changed.` };
}

// ---------------------------------------------------------------------------
// 9. budgets
// ---------------------------------------------------------------------------

function budgetStep(ctx: AppContext, clock: Clock & { advanceMs(ms: number): void }, record: (s: DemoStep) => DemoStep): void {
  clock.advanceMs(5 * MINUTE);
  const lines: string[] = [];
  const data: Record<string, unknown> = {};
  let status: DemoStepStatus = 'ok';
  const deniedBefore = count(ctx, "SELECT COUNT(*) AS n FROM audit_events WHERE site_id = ? AND event_type = 'budget.denied'", [ctx.siteId]);

  // (a) The real reserve -> reconcile path with SYNTHETIC fixture prices, under a
  //     per-run cap lowered for this run only (the site config is unchanged).
  //     Each synthetic request is answered in-process by the fixture: nothing is
  //     sent and nothing is charged; every provider request is flagged synthetic.
  const prices = demoBudgetPrices();
  const lowered = new BudgetService(ctx.db, {
    limits: { ...ctx.settings.budgets, dataforseo: { ...ctx.settings.budgets.dataforseo, perRun: prices.loweredPerRunCapMicros } },
    siteId: ctx.siteId,
    timeZone: budgetTimeZone(ctx.config),
    clock,
    actor: 'demo',
  });
  const runId = DEMO_PRICED_RUN_ID;
  const reconciled: string[] = [];
  let stop: { code: string | null; message: string; attempt: number } | null = null;
  for (let i = 1; i <= prices.requests; i++) {
    const purpose = `SYNTHETIC demo priced fixture task ${i} of ${prices.requests} (answered in-process; nothing sent)`;
    let reservationId: string;
    try {
      reservationId = lowered.reserve({
        siteId: ctx.siteId,
        provider: prices.provider,
        runId,
        purpose,
        estimate: { upperBoundMicros: prices.estimateMicros, basis: { source: 'documented', detail: `SYNTHETIC fixture price ${formatUsd(prices.estimateMicros)} per task (tests/fixtures/demo/budget-prices.json; not a real price)` } },
        synthetic: true,
      }).id;
    } catch (err) {
      stop = { code: isAppError(err) ? err.code : null, message: errorMessage(err), attempt: i };
      break;
    }
    const preq = ctx.requests.prepare({ siteId: ctx.siteId, provider: prices.provider, endpoint: prices.endpoint, method: 'POST', isPaid: true, params: { synthetic: true, task: i }, reservationId, isSynthetic: true });
    lowered.attachRequest(reservationId, preq.id);
    ctx.requests.markSubmitted(preq.id);
    ctx.requests.complete(preq.id, { status: 'succeeded', externalId: `synthetic-task-${i}` });
    lowered.reconcile(reservationId, { actualMicros: prices.actualMicros, source: 'computed_from_usage', usage: { synthetic: true, fixture: 'tests/fixtures/demo/budget-prices.json', tasks: 1 }, providerRequestId: preq.id });
    reconciled.push(reservationId);
  }
  lines.push(
    `SYNTHETIC priced run (per-run cap lowered to ${formatUsd(prices.loweredPerRunCapMicros)} for this run only): ${reconciled.length} fixture task(s) reserved at ${formatUsd(prices.estimateMicros)} each and reconciled at the SYNTHETIC fixture price ${formatUsd(prices.actualMicros)} each, recorded as ${COMPUTED_COST_NOTE} and flagged synthetic; nothing was sent or charged.`,
  );
  if (stop) {
    lines.push(`The lowered per-run cap stopped task ${stop.attempt} before anything was prepared -> ${stop.code ?? 'ERROR'}: ${stop.message}.`);
    data.overBudget = { code: stop.code, message: stop.message, stoppedAtAttempt: stop.attempt, estimateMicros: prices.estimateMicros, perRunMicros: prices.loweredPerRunCapMicros };
    if (stop.code !== 'BUDGET_EXCEEDED') status = 'failed';
  } else {
    status = 'failed';
    lines.push('ERROR: the lowered per-run cap never stopped the synthetic run; budgets are not enforced.');
  }
  if (!reconciled.length) status = 'failed';
  data.pricedRun = { runId, reconciled: reconciled.length, estimateMicros: prices.estimateMicros, actualMicros: prices.actualMicros, loweredPerRunCapMicros: prices.loweredPerRunCapMicros };

  // (b) An unknown price is refused (never counted as $0) without an approval.
  const requestsBefore = count(ctx, 'SELECT COUNT(*) AS n FROM provider_requests WHERE site_id = ?', [ctx.siteId]);
  try {
    ctx.budgets.reserve({
      siteId: ctx.siteId,
      provider: 'llm_gateway',
      runId: 'demo-budget-check',
      purpose: 'SYNTHETIC demo: model call with no verified price (never sent)',
      estimate: { upperBoundMicros: null, basis: { source: 'unknown', detail: 'no verified price (SYNTHETIC demo)' } },
      synthetic: true,
    });
    status = 'failed';
    lines.push('ERROR: an unknown-price reservation was accepted without approval.');
  } catch (err) {
    const denied = isAppError(err) ? err : null;
    lines.push(`Denied: a model call without a verified price -> ${denied?.code ?? 'ERROR'} (unknown cost is never counted as $0; it needs a verified price or an explicit approval).`);
    data.unknownPrice = { code: denied?.code ?? null, message: errorMessage(err) };
    if (denied?.code !== 'BUDGET_UNKNOWN_PRICE') status = 'failed';
  }
  const requestsAfter = count(ctx, 'SELECT COUNT(*) AS n FROM provider_requests WHERE site_id = ?', [ctx.siteId]);
  const deniedAudits = count(ctx, "SELECT COUNT(*) AS n FROM audit_events WHERE site_id = ? AND event_type = 'budget.denied'", [ctx.siteId]) - deniedBefore;
  lines.push(`Provider requests prepared by the denied attempts: ${requestsAfter - requestsBefore}. Denials recorded in the audit log by this step: ${deniedAudits} (the cap stop and the unknown price).`);
  const report = ctx.budgets.report(ctx.siteId);
  const spendLine = report.providers.map((p) => {
    const basis = report.costBasis.find((b) => b.provider === p.provider);
    const computed = basis?.computedMicros ?? 0;
    return `${p.provider} ${formatUsd(p.actualMicros - computed)} provider-reported, ${formatUsd(computed)} computed, ${formatUsd(p.reservedMicros)} reserved${p.unknownCount ? `, ${p.unknownCount} unknown` : ''}`;
  });
  lines.push(`Spend this month [${SYNTHETIC_DEMO_COSTS}; only the fixture prices above]: ${spendLine.join('; ')}.`);
  const nonSyntheticCosts =
    count(ctx, 'SELECT COUNT(*) AS n FROM budget_reservations WHERE site_id = ? AND is_synthetic = 0', [ctx.siteId]) + count(ctx, 'SELECT COUNT(*) AS n FROM cost_ledger WHERE site_id = ? AND is_synthetic = 0', [ctx.siteId]);
  lines.push(`Budget reservations and cost-ledger rows not flagged synthetic: ${nonSyntheticCosts}. \`costs\` in this workspace prints a "${SYNTHETIC_DEMO_COSTS}" banner (and "synthetic": true with --json).`);
  data.spend = { synthetic: report.synthetic, containsSynthetic: report.containsSynthetic, costBasis: report.costBasis, nonSyntheticCostRows: nonSyntheticCosts };
  if (!report.synthetic || nonSyntheticCosts !== 0) status = 'failed';
  data.requestsPrepared = requestsAfter - requestsBefore;
  data.deniedAudits = deniedAudits;
  if (requestsAfter !== requestsBefore || deniedAudits !== 2) status = 'failed';
  record({ id: 'budgets', title: 'Enforce budgets (synthetic priced run stopped by a lowered per-run cap; unknown price denied)', status, lines, artifacts: [], data });
}

// ---------------------------------------------------------------------------
// 10. vault
// ---------------------------------------------------------------------------

async function vaultStep(ctx: AppContext, services: (c: AppContext) => AppServices, ws: PreparedDemoWorkspace, paths: Record<string, string | null>, record: (s: DemoStep) => DemoStep): Promise<void> {
  const lines: string[] = [];
  let status: DemoStepStatus = 'ok';
  const data: Record<string, unknown> = {};
  try {
    const svc = services(ctx);
    const writer = svc.vault;
    if (!writer) throw new AppError('INTEGRATION_DISABLED', 'The vault writer is not available.');
    const statuses = await collectStatuses(ctx, svc, { network: false });
    const summary = renderAll(ctx, writer, { integrationStatuses: statuses, integrationStatusNote: 'Demo: SYNTHETIC fixture integrations, offline checks only.' });
    const linkResolver = wikiLinkResolver({ link: (p, a) => writer.link(p, a), notePath: () => null });
    const d = writer.writeGenerated(buildDashboard(ctx, { statuses, linkResolver }));
    paths.dashboard = path.join(ws.vaultDir, d.relPath);
    paths.draft = findDraftNote(ws.vaultDir);
    const reportNotes = listNotes(path.join(ws.vaultDir, '07 Reports'));
    const check = checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir: ws.vaultDir });
    const notes = countMarkdown(ws.vaultDir);
    lines.push(`Vault re-rendered: ${summary.counts.created} created, ${summary.counts.updated} updated, ${summary.counts.unchanged} unchanged, ${summary.counts.conflict} conflict(s); dashboard ${d.status}. ${notes} Markdown note(s) in the vault.`);
    lines.push(`Vault check: ${check.notesScanned} note(s), ${check.linksChecked} wikilink(s) checked, ${check.counts.errors} error(s), ${check.counts.warnings} warning(s). The vault is plain Markdown; Obsidian is optional.`);
    data.render = summary.counts;
    data.notes = notes;
    data.reportNotes = reportNotes;
    data.check = { ok: check.ok, counts: check.counts, notesScanned: check.notesScanned, linksChecked: check.linksChecked, issues: check.issues.slice(0, 10) };
    if (summary.counts.conflict) status = 'degraded';
  } catch (err) {
    status = 'failed';
    lines.push(`Vault error: ${errorMessage(err)}`);
  }
  const artifacts = [
    ...(paths.dashboard ? [{ label: 'Dashboard (SYNTHETIC)', path: paths.dashboard }] : []),
    ...(paths.draft ? [{ label: 'Draft note for human review (SYNTHETIC)', path: paths.draft }] : []),
  ];
  record({ id: 'vault', title: 'Vault: dashboard, pages, reports, experiments, drafts', status, lines, artifacts, data });
}

// ---------------------------------------------------------------------------
// 11. isolation / honesty checks
// ---------------------------------------------------------------------------

const SYNTHETIC_TABLES: Array<[string, string]> = [
  ['gsc_page_daily', 'is_synthetic'],
  ['gsc_page_query_daily', 'is_synthetic'],
  ['ga4_landing_daily', 'is_synthetic'],
  ['crawls', 'is_synthetic'],
  ['provider_requests', 'is_synthetic'],
  ['budget_reservations', 'is_synthetic'],
  ['cost_ledger', 'is_synthetic'],
  ['apify_runs', 'is_synthetic'],
  ['llm_calls', 'is_synthetic'],
  ['content_signals', 'is_synthetic'],
];

function isolationStep(ctx: AppContext, env: DemoEnv, attempted: string[], ws: PreparedDemoWorkspace): DemoStep {
  const nonSynthetic: Record<string, number> = {};
  for (const [table, col] of SYNTHETIC_TABLES) {
    try {
      const n = count(ctx, `SELECT COUNT(*) AS n FROM ${table} WHERE site_id = ? AND ${col} = 0`, [ctx.siteId]);
      if (n) nonSynthetic[table] = n;
    } catch {
      /* table/column absent in this schema version: nothing to check */
    }
  }
  const site = ctx.db.get<{ is_demo: number }>('SELECT is_demo FROM sites WHERE id = ?', [ctx.siteId]);
  const ok = attempted.length === 0 && Object.keys(nonSynthetic).length === 0 && site?.is_demo === 1;
  return {
    id: 'isolation',
    title: 'Isolation and honesty checks',
    status: ok ? 'ok' : 'failed',
    lines: [
      `External network requests: ${attempted.length} (network access is disabled in the demo; fixture adapters answered in-process: ${env.dataforseoCalls.length} synthetic DataForSEO, ${env.competitor.requests.length} synthetic competitor).`,
      `Rows not flagged synthetic in provider/metric/cost tables (${SYNTHETIC_TABLES.map(([t]) => t).join(', ')}): ${Object.keys(nonSynthetic).length ? JSON.stringify(nonSynthetic) : 'none'}. Site registered as demo: ${site?.is_demo === 1 ? 'yes' : 'no'}.`,
      `Separate demo workspace and database: ${ws.root} (never mixed into live reporting; a live workspace refuses demo configs).`,
    ],
    artifacts: [],
    data: { attempted, nonSynthetic, isDemoSite: site?.is_demo === 1, checkedTables: SYNTHETIC_TABLES.map(([t]) => t) },
  };
}

