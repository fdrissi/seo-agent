import type { Command } from 'commander';
import type { AppContext } from '../../app/context.js';
import { AppError, ValidationError } from '../../core/errors.js';
import { modeAtLeast } from '../../core/modes.js';
import { formatUsd, toMicros } from '../../core/money.js';
import { isIsoDate } from '../../core/time.js';
import type { CostPlanOutput } from '../../workflows/pipelines/baseline.js';
import { spendSummaryText, type ReportOutput, type SpendEntry } from '../../workflows/pipelines/common.js';
import { combineDegradedStages, degradedStagesNote, noteDisplayStatus, stageDisplayRows, stageOutputNotes, type StageOutputNote } from '../../jobs/workflow-handler.js';
import { PIPELINE_JOB_TYPES, assertNoDryRunResume, runPipeline, type PipelineJobType, type PipelineRunResult } from '../../workflows/pipelines/handlers.js';
import type { ResearchOutput } from '../../workflows/pipelines/weekly.js';
import { HISTORICAL_PERIOD_PRIMARY_ID } from '../../seo/stages.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';
import { signalController, statusText } from './jobs.js';

/**
 * `baseline`, `weekly`, `monthly`, and `content queue`: the pipelines of spec
 * section 27, each run as a durable job (per-site lock, checkpoints, resume,
 * cancellation, circuit breakers). All support the global --dry-run, --json,
 * and --mode flags, plus --resume <jobId>.
 *
 * - --dry-run executes the workflow against a temporary copy of the database:
 *   no paid stage runs, nothing is written to the workspace database, vault,
 *   or reports, and no network request is made by status checks. It is
 *   refused with --resume (a resumed job is real; VALIDATION_FAILED).
 * - A run refused because another run holds the lock leaves nothing queued:
 *   its new job is closed as cancelled (LOCKED) and the output says so.
 * - Weekly research (DataForSEO SERPs + competitor pages) runs only with
 *   --mode RESEARCH or higher; otherwise it is skipped and says so.
 * - Baseline never makes paid DataForSEO/Apify requests; optional LLM /
 *   embedding work needs --approve-cost-plan <usd> covering the displayed plan.
 */

interface CommonOpts {
  resume?: string;
  rerunPaidStages?: boolean;
  from?: string;
  to?: string;
}

function periodParam(opts: CommonOpts): { period?: { start: string; end: string } } {
  if (!opts.from && !opts.to) return {};
  if (!opts.from || !opts.to) throw new ValidationError('Pass both --from and --to (YYYY-MM-DD).');
  if (!isIsoDate(opts.from) || !isIsoDate(opts.to)) throw new ValidationError('--from/--to must be valid YYYY-MM-DD dates.');
  if (opts.from > opts.to) throw new ValidationError('--from must not be after --to.');
  return { period: { start: opts.from, end: opts.to } };
}

function positiveInt(v: string, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ValidationError(`${name} must be a positive integer`);
  return n;
}

const TITLES: Record<PipelineJobType, string> = {
  baseline: 'Baseline',
  weekly: 'Weekly',
  monthly: 'Monthly',
  'content.queue': 'Content queue',
};

type OutputNote = StageOutputNote;

/**
 * Honest notes carried in stage OUTPUTS: a stage the engine records as
 * "succeeded" may still say it was skipped or degraded (for example the
 * own-site crawl offline, research with every competitor page blocked, a
 * disabled integration). Sources: the report's stage notes (all stages before
 * the report) and the `note` of the summarized outputs. Shared with the job
 * summary (src/jobs/workflow-handler.ts), which persists the same list.
 */
export function outputNotes(r: PipelineRunResult): Map<string, OutputNote> {
  return stageOutputNotes(r.outputs);
}

/** Display status of a stage: the engine status, unless the stage "succeeded" but its own output says skipped/degraded/offline. */
export function stageDisplayStatus(engineStatus: string, note: OutputNote | undefined): string {
  return noteDisplayStatus(engineStatus, note);
}

/** The combined degraded list of a run (persisted with the job, merged with the summarized outputs). */
function runDegradedStages(r: PipelineRunResult) {
  return combineDegradedStages(r.workflow.stages, r.workflow.degraded, outputNotes(r), Array.isArray(r.degradedStages) ? r.degradedStages : []);
}

/**
 * Headline status. "succeeded" is never shown bare when a stage was skipped,
 * failed, or (per its own output note) skipped/degraded/offline. It counts the
 * same combined list as the job record (`degradedStages`), so `jobs list`,
 * `jobs show`, `--json`, and this headline agree. Exit codes are not affected
 * (they follow the job outcome).
 */
export function pipelineHeadline(r: PipelineRunResult): string {
  if (r.outcome !== 'succeeded') return r.outcome;
  const degraded = degradedStagesNote(runDegradedStages(r));
  const others = (r.note ?? '').split('; ').filter((p) => p && !p.startsWith('degraded: '));
  const nothingRan = others.filter((p) => p.startsWith('nothing ran'));
  const rest = others.filter((p) => !p.startsWith('nothing ran'));
  const parts = [...nothingRan, ...(degraded ? [degraded] : []), ...rest];
  return statusText('succeeded', parts.length ? parts.join('; ') : null);
}

/** The recommend stage output as the summary reads it (src/seo/stages.ts recommendOutput). */
interface RecommendOutputSummary {
  primaryId?: string;
  kind?: string;
  title?: string;
  saved?: boolean;
  note?: { code?: string | null; detail?: string } | null;
}

/**
 * Why a recommendation was not saved, stated with its real reason: an
 * explicit historical period (`weekly --from/--to` ending before the latest
 * complete date) is assembled for review only and never saved or superseding;
 * only a dry run is called a dry run. Empty when it was saved.
 */
export function recommendationSavedSuffix(rec: RecommendOutputSummary, dryRun: boolean): string {
  if (rec.saved) return '';
  if (rec.primaryId === HISTORICAL_PERIOD_PRIMARY_ID || rec.note?.code === 'HISTORICAL_PERIOD') return ' (not saved: explicit historical period; review only)';
  if (dryRun || rec.primaryId === 'dry-run') return ' (not saved: dry run)';
  return rec.note?.detail ? ` (not saved: ${rec.note.detail.split('\n')[0]!.slice(0, 160)})` : ' (not saved)';
}

export function renderPipelineRun(r: PipelineRunResult): string {
  const title = TITLES[r.type as PipelineJobType] ?? r.type;
  const lines: string[] = [];
  lines.push(`${title} pipeline, job ${r.jobId} (mode ${r.mode}${r.dryRun ? ', DRY RUN' : ''}): ${pipelineHeadline(r)}`);
  // The note follows the EFFECTIVE dry run of the job, never merely the use of a scratch database.
  if (r.dryRun) {
    lines.push(
      r.scratchDatabase
        ? 'Dry run: executed against a temporary copy of the database; nothing was written to the workspace, no paid stage ran.'
        : 'Dry run: no paid stage ran; the job and its checkpoints are recorded in the workspace database.',
    );
  } else if (r.scratchDatabase) {
    lines.push('WARNING: this run used a temporary copy of the database but was NOT a dry run; its records were discarded with the copy.');
  }
  if (r.workflow.stoppedBy) lines.push(`Stopped at ${r.workflow.stoppedBy.stage} (${r.workflow.stoppedBy.status}): ${r.workflow.stoppedBy.reason}`);
  if (r.error && r.outcome !== 'succeeded') lines.push(`Error [${r.error.code}]: ${r.error.message}${r.error.hint ? `\nNext step: ${r.error.hint}` : ''}`);
  if (r.workflow.stages.length) {
    // One display row per stage (shared with the demo): the stage's own output note, then the job record's
    // output-sourced entries (outputs not among the summarized ones), then the engine's degraded entries (a stage
    // run without its optional paid work, e.g. an LLM budget exhausted at run time). A stage the headline counts
    // is never shown as a bare "succeeded".
    const rows = stageDisplayRows(r.workflow.stages, runDegradedStages(r), outputNotes(r));
    lines.push('', 'Stages:');
    r.workflow.stages.forEach((s, i) => {
      const row = rows[i]!;
      const why = row.reason ? `  ${row.reason}` : '';
      lines.push(`  ${s.stage.padEnd(20)} ${row.shown.padEnd(10)}${s.resumedFromCheckpoint ? ' (from checkpoint)' : ''}${s.error ? `  ${s.error.code}: ${s.error.message}` : why}`);
    });
  }
  const access = r.outputs.check_access as { problems?: Array<{ id: string; state: string; detail: string; nextStep: string | null }> } | undefined;
  if (access?.problems?.length) {
    lines.push('', 'Access issues (blockers are reported, not hidden):');
    for (const p of access.problems) lines.push(`  - ${p.id}: ${p.state}: ${p.detail}${p.nextStep ? ` Next step: ${p.nextStep}` : ''}`);
  }
  const research = r.outputs.research as ResearchOutput | undefined;
  if (research) {
    lines.push('', `Research (${research.isSandbox ? 'SANDBOX/SYNTHETIC, not usable for real recommendations' : 'live'}): ${research.status}; ${research.queries.length} quer${research.queries.length === 1 ? 'y' : 'ies'}, ${research.competitorPages.length} competitor page(s)`);
    for (const q of research.queries) lines.push(`  - "${q.query}": ${q.status}${q.error ? ` (${q.error.code}: ${q.error.message})` : ''}`);
    for (const p of research.competitorPages.filter((x) => x.status !== 'fetched')) lines.push(`  - competitor ${p.url}: ${p.status}${p.blockedReason ? ` (${p.blockedReason})` : ''}${p.reason ? `: ${p.reason}` : ''}`);
  }
  const plan = r.outputs.cost_plan as CostPlanOutput | undefined;
  if (plan) lines.push('', plan.display);
  const rec = r.outputs.recommend as RecommendOutputSummary | undefined;
  if (rec?.title) lines.push('', `Recommendation: ${rec.kind}: ${rec.title}${recommendationSavedSuffix(rec, r.dryRun)}`);
  const report = r.outputs.report as ReportOutput | undefined;
  if (report) {
    lines.push('', `Report ${report.reportId} (${report.kind}, ${report.period.start} to ${report.period.end})${report.isSynthetic ? ' [SYNTHETIC]' : ''}: confidence ${report.confidence}, ${report.warnings} warning(s), ${report.accessIssues} access issue(s)`);
    if (report.markdownFile) lines.push(`  file: ${report.markdownFile}`);
    if (report.vaultNote) lines.push(`  vault note: ${report.vaultNote}${report.dashboard ? `; dashboard: ${report.dashboard}` : ''} (${report.vault.status}: ${report.vault.created} created, ${report.vault.updated} updated, ${report.vault.conflicts} conflict(s))`);
    if (!report.persisted) lines.push('  not persisted (dry run)');
    if (report.primaryAction) lines.push(`  primary action: ${report.primaryAction}`);
    if (report.nextAction) lines.push(`  next action: ${report.nextAction}`);
    if (report.stageNotes.length) {
      lines.push('  stage statuses recorded in the report:');
      for (const n of report.stageNotes) lines.push(`    - ${n.stage} ${n.status}${n.code ? ` (${n.code})` : ''}: ${n.detail}${n.nextStep ? ` Next step: ${n.nextStep}` : ''}`);
    }
  }
  // Provider-reported and computed-from-usage amounts are kept apart; synthetic (demo, fixture, sandbox) amounts are tagged.
  const costs = r.outputs.reconcile_costs as { unresolvedReservations?: unknown[]; spend?: SpendEntry[]; spendDemo?: boolean } | undefined;
  if (costs?.spend) {
    lines.push('', `${spendSummaryText(costs.spend, { demo: costs.spendDemo === true })}${costs.unresolvedReservations?.length ? `; ${costs.unresolvedReservations.length} unresolved reservation(s)` : ''}`);
  }
  if (r.workflow.warnings.length) lines.push('', ...r.workflow.warnings.slice(0, 5).map((w) => `Warning: ${w}`));
  if (!r.scratchDatabase && (r.outcome === 'failed' || r.outcome === 'interrupted' || r.outcome === 'retry_scheduled')) lines.push('', `Resume from the last successful checkpoint: npm run cli -- jobs resume ${r.jobId}`);
  return lines.join('\n');
}

/**
 * Caps that bound a RESEARCH-mode (or higher) pipeline run, printed before it
 * starts (docs/CLI.md "Money": the cap is shown before anything chargeable is
 * sent): per-run ceilings from site config plus what remains this month (and
 * week) according to the budget ledger. Configured ceilings, not price quotes.
 */
export function researchCapLines(ctx: Pick<AppContext, 'config' | 'budgets' | 'siteId' | 'mode'>, type: PipelineJobType): string[] {
  const b = ctx.config.budgets;
  const usd = (v: string) => formatUsd(toMicros(v));
  let report: ReturnType<AppContext['budgets']['report']> | null = null;
  try {
    report = ctx.budgets.report(ctx.siteId);
  } catch {
    report = null;
  }
  const spend = (provider: string) => report?.providers.find((p) => p.provider === provider);
  const remaining = (provider: string) => {
    const p = spend(provider);
    if (!p) return 'remaining budget unknown (the ledger could not be read)';
    const month = `${formatUsd(p.remainingMicros)} of ${formatUsd(p.limitMicros)} left this month${p.remainingVerified ? '' : ' (upper bound: charges with unknown cost are outstanding)'}`;
    return p.weekly ? `${month}, ${formatUsd(p.weekly.remainingMicros)} of ${formatUsd(p.weekly.limitMicros)} left this week` : month;
  };
  const lines = [
    `Spending caps for this ${ctx.mode}-mode ${TITLES[type].toLowerCase()} run (configured ceilings, not price quotes):`,
    `  - dataforseo: up to ${usd(b.dataforseo.perRunUsd)} per run; ${remaining('dataforseo')}${type === 'baseline' ? ' (the baseline makes no DataForSEO requests)' : ''}`,
    `  - apify: up to ${usd(b.apify.perRunUsd)} per run; ${remaining('apify')}${type === 'baseline' ? ' (the baseline makes no Apify requests)' : ''}`,
    `  - llm_gateway: up to ${usd(b.llmGateway.perRunUsd)} per run; ${remaining('llm_gateway')}${type === 'baseline' ? ' (optional LLM work runs only with --approve-cost-plan)' : ''}`,
    `  - combined: ${report ? `${formatUsd(report.combined.remainingMicros)} of ${formatUsd(report.combined.limitMicros)} left this month${report.combined.remainingVerified ? '' : ' (upper bound)'}` : `${usd(b.combinedMonthlyUsd)} per month`}`,
  ];
  return lines;
}

async function runAndPrint(cli: CliRuntime, g: GlobalOptions, type: PipelineJobType, params: Record<string, unknown>, opts: CommonOpts): Promise<void> {
  const ctx = cli.context(g);
  const sig = signalController();
  try {
    if (opts.rerunPaidStages && !opts.resume) throw new ValidationError('--rerun-paid-stages applies only with --resume <jobId> (after reconciling the interrupted paid request).');
    // Refused before anything is printed or run: a resumed job is real, so it has no dry run.
    assertNoDryRunResume(ctx, type, opts.resume);
    // RESEARCH-mode runs may spend money: show the caps before anything is sent (stderr keeps --json stdout clean).
    if (type !== PIPELINE_JOB_TYPES.contentQueue && modeAtLeast(ctx.mode, 'RESEARCH')) {
      for (const line of researchCapLines(ctx, type)) cli.io.err(line);
      if (ctx.dryRun) cli.io.err('  (dry run: no paid stage runs; nothing is charged)');
    }
    const result = await runPipeline(ctx, type, params, {
      ...(opts.resume ? { resumeJobId: opts.resume } : {}),
      ...(opts.rerunPaidStages ? { rerunPaidStages: true } : {}),
      signal: sig.signal,
    });
    cli.print(g, result, renderPipelineRun);
    if (result.outcome !== 'succeeded' && result.outcome !== 'waiting') process.exitCode = 1;
  } finally {
    sig.dispose();
    ctx.db.close();
  }
}

function common(cmd: Command): Command {
  return cmd
    .option('--resume <jobId>', 'continue an existing job from its last successful checkpoint (completed stages are not redone)')
    .option('--rerun-paid-stages', 'with --resume: explicitly rerun a paid stage interrupted mid-flight (only after reconciling it: `costs --unresolved`, provider history)');
}

export function register(program: Command, cli: CliRuntime): void {
  common(
    program
      .command('baseline')
      .description('Baseline: validate access -> 90-day GSC/GA4 history -> bounded own-site crawl -> reconcile URLs -> check measurement -> index memory -> cost plan -> baseline report + dashboard. No paid DataForSEO/Apify, no experiments, nothing published.'),
  )
    .option('--approve-cost-plan <usd>', 'explicitly approve the displayed optional LLM/embedding cost plan up to this cap in USD (e.g. 0.05); unknown prices are never approved')
    .option('--crawl-max-pages <n>', 'bound the own-site crawl below crawl.maxPages')
    .option('--from <date>', 'explicit report period start (YYYY-MM-DD, business time zone)')
    .option('--to <date>', 'explicit report period end (YYYY-MM-DD)')
    .action(
      cli.action(async (opts: CommonOpts & { approveCostPlan?: string; crawlMaxPages?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        let cap: number | undefined;
        if (opts.approveCostPlan !== undefined) {
          try {
            cap = toMicros(opts.approveCostPlan);
          } catch {
            throw new ValidationError('--approve-cost-plan must be a USD amount such as 0.05');
          }
          if (cap < 0) throw new ValidationError('--approve-cost-plan must not be negative');
        }
        const params = {
          ...periodParam(opts),
          ...(cap !== undefined ? { approveCostPlanMicros: cap } : {}),
          ...(opts.crawlMaxPages ? { crawlMaxPages: positiveInt(opts.crawlMaxPages, '--crawl-max-pages') } : {}),
        };
        await runAndPrint(cli, g, PIPELINE_JOB_TYPES.baseline, params, opts);
      }),
    );

  common(
    program
      .command('weekly')
      .description('Weekly: site lock -> fresh complete data -> joins -> experiments review -> routing -> shortlist -> budgeted research (only with --mode RESEARCH) -> memory -> one recommendation or no-action -> report/dashboard -> cost reconciliation'),
  )
    .option('--from <date>', 'explicit report period start (YYYY-MM-DD)')
    .option('--to <date>', 'explicit report period end (YYYY-MM-DD)')
    .option('--research-max-queries <n>', 'lower research.seriousQueriesPerRun for this run (never raises it)')
    .option('--research-wait <seconds>', 'poll queued SERP tasks up to this long (free GETs; default 90)')
    .action(
      cli.action(async (opts: CommonOpts & { researchMaxQueries?: string; researchWait?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const params = {
          ...periodParam(opts),
          ...(opts.researchMaxQueries ? { researchMaxQueries: positiveInt(opts.researchMaxQueries, '--research-max-queries') } : {}),
          ...(opts.researchWait !== undefined ? { researchWaitMs: Math.min(600, Math.max(0, Number(opts.researchWait) || 0)) * 1000 } : {}),
        };
        await runAndPrint(cli, g, PIPELINE_JOB_TYPES.weekly, params, opts);
      }),
    );

  common(
    program
      .command('monthly')
      .description('Monthly: organic + conversion performance, experiments, published-content cohorts, competitor changes (RESEARCH mode), optional AI visibility, API usage, data quality, learnings; observed results kept apart from attribution assumptions'),
  )
    .option('--from <date>', 'explicit report period start (YYYY-MM-DD)')
    .option('--to <date>', 'explicit report period end (YYYY-MM-DD)')
    .action(
      cli.action(async (opts: CommonOpts, cmd: Command) => {
        const g = cli.globals(cmd);
        await runAndPrint(cli, g, PIPELINE_JOB_TYPES.monthly, periodParam(opts), opts);
      }),
    );

  // `content queue` / `content produce`: attached to the content slice's `content` command when it
  // exists (no duplicate names).
  const content = program.commands.find((c) => c.name() === 'content');
  const parent = content ?? program;
  if (!content?.commands.some((c) => c.name() === 'produce')) registerContentProduce(parent, cli, content ? 'produce' : 'content-produce');
  if (content && content.commands.some((c) => c.name() === 'queue')) return;
  const queue = parent.command(content ? 'queue' : 'content-queue');
  common(queue.description('Content discovery queue as a durable job (features.contentDiscovery; own "content" lock): resume Apify runs, discover -> dedupe -> classify -> cluster -> validate demand -> check existing -> prioritize, vault notes. Never drafts or publishes.'))
    .option('--gsc-days <n>', 'Search Console lookback in days', '28')
    .option('--max-queries <n>', 'maximum Search Console queries to collect', '200')
    .option('--use-model', 'allow the cheap model for ambiguous intent (spends money within per-stage allowances)')
    .option('--semantic', 'also use embeddings for clustering (requires --use-model)')
    .action(
      cli.action(async (opts: CommonOpts & { gscDays: string; maxQueries: string; useModel?: boolean; semantic?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        if (opts.semantic && !opts.useModel) throw new AppError('POLICY_DENIED', '--semantic uses paid embeddings: pass --use-model as well.');
        const params = { gscDays: positiveInt(opts.gscDays, '--gsc-days'), maxGscQueries: positiveInt(opts.maxQueries, '--max-queries'), useModel: !!opts.useModel, semantic: !!opts.semantic };
        await runAndPrint(cli, g, PIPELINE_JOB_TYPES.contentQueue, params, opts);
      }),
    );
}

interface ProduceRun {
  jobId: string;
  outcome: string;
  workflowStatus: string | null;
  stages: Array<{ stage: string; status: string; resumedFromCheckpoint: boolean; error?: { code: string; message: string } }>;
  stoppedBy: { stage: string; status: string; reason: string } | null;
  failure: { stage: string; code: string; message: string } | null;
  note: string | null;
  outputs: Record<string, unknown>;
}

function renderProduce(r: ProduceRun): string {
  const lines = [`Content production, job ${r.jobId}: ${r.outcome}${r.workflowStatus ? ` (workflow ${r.workflowStatus})` : ''}${r.note ? ` [${r.note}]` : ''}`];
  if (r.stoppedBy) lines.push(`Stopped at ${r.stoppedBy.stage} (${r.stoppedBy.status}): ${r.stoppedBy.reason}`);
  if (r.failure) lines.push(`Failed at ${r.failure.stage}: ${r.failure.code}: ${r.failure.message}`);
  for (const s of r.stages) lines.push(`  ${s.stage.padEnd(16)} ${s.status.padEnd(10)}${s.resumedFromCheckpoint ? ' (from checkpoint)' : ''}${s.error ? `  ${s.error.code}: ${s.error.message}` : ''}`);
  const brief = r.outputs.brief as { briefId?: string | null; approvalStatus?: string | null } | undefined;
  const draft = r.outputs.draft as { draftId?: string; unresolvedFacts?: number } | undefined;
  const review = r.outputs.quality_review as { verdict?: string; reasons?: string[] } | undefined;
  if (brief?.briefId) lines.push(`Brief ${brief.briefId} (draft approval: ${brief.approvalStatus ?? 'none'})`);
  if (draft?.draftId) lines.push(`Draft ${draft.draftId}: ${draft.unresolvedFacts ?? 0} unresolved fact(s) flagged`);
  if (review?.verdict) lines.push(`Quality verdict: ${review.verdict}. Human review is always required; nothing is published.`);
  if (r.outcome === 'failed' || r.outcome === 'interrupted') lines.push(`Resume: npm run cli -- content produce --resume ${r.jobId} (or jobs resume ${r.jobId})`);
  return lines.join('\n');
}

/**
 * `content produce <item-id>`: brief -> draft -> quality review as ONE durable
 * job (checkpoints, resume, per-stage LLM allowances enforced by the engine).
 * Drafting still requires --mode DRAFT, a gate-passed brief, and a human
 * draft approval bound to the brief hash; the job waits for review otherwise.
 */
function registerContentProduce(parent: Command, cli: CliRuntime, name: string): void {
  parent
    .command(`${name} [item-id]`)
    .description('Durable content production for one item: brief (reused when unchanged) -> draft (needs --mode DRAFT and a human draft approval) -> quality review; checkpointed and resumable, per-stage LLM allowances enforced. Never publishes.')
    .option('--use-model', 'allow model calls (spends money within per-stage allowances and budgets)')
    .option('--resume <jobId>', 'continue an existing production job from its last successful checkpoint')
    .action(
      cli.action(async (itemId: string | undefined, opts: { useModel?: boolean; resume?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        if (!itemId && !opts.resume) throw new ValidationError('Pass an item id, or --resume <jobId>.');
        const ctx = cli.context(g);
        const sig = signalController();
        try {
          if (ctx.dryRun) throw new AppError('POLICY_DENIED', 'content produce has no dry run; preview with `content brief <item-id> --dry-run` and `content draft <item-id> --dry-run`.');
          const { JobRegistry } = await import('../../jobs/registry.js');
          const { JobRunner, enqueueAndRun } = await import('../../jobs/runner.js');
          const { CONTENT_PRODUCTION_JOB, contentProductionJobHandler } = await import('../../content/jobs.js');
          const { contentDepsFrom } = await import('../../workflows/pipelines/content-queue.js');
          const { createPipelineEnv } = await import('../../workflows/pipelines/common.js');
          const { CheckpointStore } = await import('../../workflows/checkpoints.js');
          const { workflowResultNote } = await import('../../jobs/workflow-handler.js');
          const runner = new JobRunner({ registry: new JobRegistry().register(contentProductionJobHandler(contentDepsFrom(createPipelineEnv()))), maxMode: ctx.mode });
          if (opts.resume) {
            const { requireJob } = await import('../../jobs/store.js');
            const existing = requireJob(ctx.db, ctx.siteId, opts.resume);
            if (existing.type !== CONTENT_PRODUCTION_JOB) throw new ValidationError(`Job ${existing.id} is a ${existing.type} job, not ${CONTENT_PRODUCTION_JOB}; nothing was changed. Use \`jobs resume ${existing.id}\`.`);
          }
          const r = opts.resume
            ? (await runner.resume(ctx, opts.resume, { actor: 'cli', signal: sig.signal })).results[0]!
            : await enqueueAndRun(ctx, runner, CONTENT_PRODUCTION_JOB, { itemId: itemId!, useModel: !!opts.useModel }, { actor: 'cli', retryInline: false, signal: sig.signal });
          const res = (r.job.result ?? null) as { status?: string; stages?: ProduceRun['stages']; stoppedBy?: ProduceRun['stoppedBy']; failure?: ProduceRun['failure'] } | null;
          const store = new CheckpointStore(ctx.db, ctx.clock);
          const outputs: Record<string, unknown> = {};
          for (const s of ['brief', 'draft', 'quality_review']) {
            const cp = store.latestWithOutput(ctx.siteId, r.job.id, s);
            if (cp) outputs[s] = cp.output;
          }
          const run: ProduceRun = {
            jobId: r.job.id,
            outcome: r.outcome,
            workflowStatus: res?.status ?? null,
            stages: res?.stages ?? [],
            stoppedBy: res?.stoppedBy ?? null,
            failure: res?.failure ?? null,
            note:
              r.outcome === 'waiting' || r.outcome === 'not_runnable'
                ? r.reason
                : r.outcome === 'failed' || r.outcome === 'interrupted' || r.outcome === 'retry_scheduled'
                  ? `${r.error.code}: ${r.error.message}`
                  : r.outcome === 'locked'
                    ? r.job.status === 'cancelled' && r.job.error?.code === 'LOCKED'
                      ? `LOCKED: ${r.job.error.message}`
                      : `LOCKED: the ${r.heldBy.lockName} lock is held (job ${r.heldBy.jobId ?? '-'}, lease until ${r.heldBy.expiresAt}); runs never overlap. Job ${r.job.id} did not run and is unchanged (still ${r.job.status}).`
                    : workflowResultNote(r.job.result),
            outputs,
          };
          cli.print(g, run, renderProduce);
          if (r.outcome !== 'succeeded' && r.outcome !== 'waiting') process.exitCode = 1;
        } finally {
          sig.dispose();
          ctx.db.close();
        }
      }),
    );
}
