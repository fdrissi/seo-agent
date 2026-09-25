import { z } from 'zod';
import type { AppContext } from '../../app/context.js';
import { budgetTimeZone } from '../../app/context.js';
import { collectStatuses, createServices, type AppServices, type ServiceOptions } from '../../app/services.js';
import { AppError, errorMessage } from '../../core/errors.js';
import { formatUsd } from '../../core/money.js';
import { NO_RETRY, type RetryPolicy } from '../../core/retry.js';
import { addDays, dateInZone, daysBetweenInclusive, isIsoDate } from '../../core/time.js';
import { crawlSite } from '../../crawler/crawl.js';
import { reviewExperiments } from '../../experiments/evaluate.js';
import { resumeApifyRuns } from '../../integrations/apify/runs.js';
import { pollPendingTasks } from '../../integrations/dataforseo/tasks.js';
import { loadCachedGa4Metadata, planGa4Metrics } from '../../integrations/google/ga4-metadata.js';
import { ga4ConversionChecklist } from '../../integrations/google/ga4-checklist.js';
import { syncGa4 } from '../../integrations/google/ga4-sync.js';
import { GSC_TIME_ZONE } from '../../integrations/google/gsc-client.js';
import { syncGsc, type GscSegment } from '../../integrations/google/gsc-sync.js';
import { inspectUrls, selectPriorityUrls, type InspectUrlsResult } from '../../integrations/google/url-inspection.js';
import { checkPerformance, selectPriorityPages } from '../../integrations/pagespeed/check.js';
import { getSiteLock, DEFAULT_LOCK_NAME } from '../../jobs/locks.js';
import type { IndexRunReport } from '../../memory/indexer.js';
import { renderAll, RENDER_KINDS, type RenderKind } from '../../obsidian/notes.js';
import { buildReportOfKind, type PipelineStageNote, type ReportBuildInput } from '../../reports/build.js';
import { buildDashboard } from '../../reports/dashboard.js';
import { wikiLinkResolver } from '../../reports/links.js';
import type { ReportKind } from '../../reports/model.js';
import { resolvePeriod } from '../../reports/period.js';
import { prepareSiteAnalysis } from '../../seo/page-analysis.js';
import { siteStructureSchema, type SiteStructureSummary } from '../../seo/site-structure.js';
import { CheckpointStore } from '../checkpoints.js';
import { defineStage, stageMayPay, toolsOf, type EngineStage } from '../stage.js';
import type { CostAllowance, StageContext } from '../types.js';

/**
 * Building blocks shared by the baseline, weekly, monthly, and content-queue
 * pipelines (spec section 27). Every stage is a full `StageDefinition`:
 * validated input/output schemas, prerequisites, an evidence requirement,
 * timeout, retry policy, cost allowance, stopping conditions, and next
 * states. Stages run inside a durable job (per-site lock, checkpoints,
 * resume, cancellation, circuit breakers).
 *
 * Conventions:
 * - Services are built per STAGE context (`env.services(sctx.app)`), so every
 *   paid call reserves through the stage's budget guard.
 * - Optional stages THROW when they cannot do their work (missing
 *   credentials, provider down): the engine records them as degraded and the
 *   report lists them. Partial results are returned with a `note`.
 * - Nothing here publishes, starts experiments, or changes production.
 */

// ---------------------------------------------------------------------------
// Environment and params
// ---------------------------------------------------------------------------

export interface PipelineEnv {
  /** Build the concrete services for a (stage) context. */
  services: (app: AppContext) => AppServices;
  /** Service options (the default `services` factory uses them). */
  serviceOptions?: ServiceOptions;
}

export function createPipelineEnv(opts: ServiceOptions = {}): PipelineEnv {
  return { services: (app) => createServices(app, opts), serviceOptions: opts };
}

const isoDate = z.string().refine((d) => isIsoDate(d), 'expected a valid YYYY-MM-DD date');

/** Job params shared by the pipelines (scheduler params are accepted too). */
export const pipelineParamsSchema = z.object({
  trigger: z.string().max(40).optional(),
  scheduleId: z.string().max(100).optional(),
  scheduledFor: z.string().max(60).optional(),
  timezone: z.string().max(100).optional(),
  /** Explicit report period (business time zone). Default: per report kind, ending at the latest complete date. */
  period: z.object({ start: isoDate, end: isoDate }).refine((p) => p.start <= p.end, 'period start must not be after its end').optional(),
  /** Baseline only: explicit approval of the displayed cost plan, as a cap in USD micros. */
  approveCostPlanMicros: z.number().int().min(0).max(1_000_000_000).optional(),
  /** Bound the own-site crawl below crawl.maxPages. */
  crawlMaxPages: z.number().int().min(1).max(100_000).optional(),
  /** Lower research.seriousQueriesPerRun for this run (never raises it). */
  researchMaxQueries: z.number().int().min(1).max(10).optional(),
  /** How long weekly research polls queued SERP tasks (free GETs). */
  researchWaitMs: z.number().int().min(0).max(600_000).optional(),
});
export type PipelineParams = z.infer<typeof pipelineParamsSchema>;

export function paramsOf(params: Record<string, unknown>): PipelineParams {
  const r = pipelineParamsSchema.safeParse(params);
  return r.success ? r.data : {};
}

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

export const statusSchema = z.object({
  id: z.string(),
  state: z.string(),
  detail: z.string(),
  nextStep: z.string().optional(),
  sendsExternally: z.array(z.string()).default([]),
  checkedAt: z.string(),
  networkChecked: z.boolean(),
  chargeable: z.boolean(),
});
export type StatusRecord = z.infer<typeof statusSchema>;

/** Honest stage note carried in outputs (partial / skipped work within a stage that succeeded). */
export const noteSchema = z
  .object({
    status: z.enum(['succeeded', 'degraded', 'skipped']),
    code: z.string().nullable(),
    detail: z.string(),
    nextStep: z.string().nullable(),
  })
  .nullable();
export type StageNote = z.infer<typeof noteSchema>;

export const periodSchema = z.object({
  start: z.string(),
  end: z.string(),
  days: z.number(),
  timeZone: z.string(),
  label: z.string(),
  comparison: z.object({ start: z.string(), end: z.string(), label: z.string() }).nullable(),
  latestCompleteDate: z.string().nullable(),
  latestCompleteBasis: z.string(),
  explicit: z.boolean(),
});

export const IDEMPOTENT_RETRY: RetryPolicy = { maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 10_000, jitter: 0.2 };

export function note(status: 'succeeded' | 'degraded' | 'skipped', detail: string, code: string | null = null, nextStep: string | null = null): StageNote {
  return { status, code, detail, nextStep };
}

function limit<T>(xs: readonly T[], n: number): T[] {
  return xs.slice(0, n);
}

/** Record provider health in the job's circuit breakers (no-op outside the engine). */
async function withBreaker<T>(sctx: StageContext, provider: string, fn: () => Promise<T>): Promise<T> {
  let breakers: ReturnType<typeof toolsOf>['breakers'] = null;
  try {
    breakers = toolsOf(sctx).breakers;
  } catch {
    breakers = null;
  }
  if (!breakers) return fn();
  return breakers.execute(provider, fn);
}

function businessToday(app: AppContext): string {
  return dateInZone(app.clock.now(), budgetTimeZone(app.config));
}

// ---------------------------------------------------------------------------
// acquire_lock
// ---------------------------------------------------------------------------

export function acquireLockStage(next: string, lockName: string = DEFAULT_LOCK_NAME): EngineStage {
  return defineStage({
    name: 'acquire_lock',
    version: 'acquire_lock@1',
    description: 'Confirm that the per-site lock is held by this job (the job runner acquires it before the workflow starts), so runs of this site never overlap.',
    input: z.object({ lockName: z.string() }),
    output: z.object({ lockName: z.string(), owner: z.string(), jobId: z.string().nullable(), acquiredAt: z.string(), expiresAt: z.string() }),
    prerequisites: [],
    evidence: { requirement: 'The site_locks row for this job.' },
    timeoutMs: 10_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    idempotent: true,
    stoppingConditions: ['Another runner holds the lock: the stage fails with LOCKED and nothing else runs.'],
    next: [next],
    buildInput: () => ({ lockName }),
    run: async (input, sctx) => {
      const lock = getSiteLock(sctx.app.db, sctx.app.siteId, input.lockName);
      if (!lock || lock.jobId !== sctx.jobId) {
        throw new AppError('LOCKED', `The ${input.lockName} lock of site ${sctx.app.siteId} is not held by job ${sctx.jobId}${lock ? ` (held by ${lock.owner} for ${lock.jobId ?? 'no job'})` : ''}.`, {
          hint: 'Run pipelines through the job runner (the `baseline`/`weekly`/`monthly` commands or `jobs resume`).',
        });
      }
      return { lockName: lock.lockName, owner: lock.owner, jobId: lock.jobId, acquiredAt: lock.acquiredAt, expiresAt: lock.expiresAt };
    },
  });
}

// ---------------------------------------------------------------------------
// check_access
// ---------------------------------------------------------------------------

export const accessOutput = z.object({
  network: z.boolean(),
  statuses: z.array(statusSchema),
  problems: z.array(z.object({ id: z.string(), state: z.string(), detail: z.string(), nextStep: z.string().nullable() })),
  googleProvider: z.string().nullable(),
  llm: z.string(),
  synthetic: z.boolean(),
});
export type AccessOutput = z.infer<typeof accessOutput>;

const PROBLEM_STATES = new Set(['missing_credentials', 'misconfigured', 'unreachable', 'permission_denied', 'degraded', 'unresolved']);

export function checkAccessStage(env: PipelineEnv, next: string, prerequisites: string[] = []): EngineStage {
  return defineStage({
    name: 'check_access',
    version: 'check_access@1',
    description: 'Validate access: every integration reports an honest status (free, read-only checks only; never chargeable).',
    input: z.object({ network: z.boolean() }),
    output: accessOutput,
    prerequisites,
    evidence: { requirement: 'Status reporters of every slice (configuration, stored credentials, and free read-only checks).' },
    timeoutMs: 120_000,
    retry: IDEMPOTENT_RETRY,
    costAllowance: 'none',
    idempotent: true,
    stoppingConditions: ['Never stops: missing credentials are reported as blockers and the affected stages degrade.'],
    next: [next],
    buildInput: (sctx) => ({ network: !sctx.app.offline && !sctx.app.dryRun && !sctx.app.synthetic }),
    run: async (input, sctx) => {
      const svc = env.services(sctx.app);
      const statuses = (await collectStatuses(sctx.app, svc, { network: input.network })).map((s) => statusSchema.parse(JSON.parse(JSON.stringify(s))));
      return {
        network: input.network,
        statuses,
        problems: statuses.filter((s) => PROBLEM_STATES.has(s.state)).map((s) => ({ id: s.id, state: s.state, detail: s.detail, nextStep: s.nextStep ?? null })),
        googleProvider: svc.google.provider?.mode ?? null,
        llm: svc.llmKind,
        synthetic: sctx.app.synthetic,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// resume_pending / reconcile_costs (free provider GETs + reservation review)
// ---------------------------------------------------------------------------

/**
 * Spend of one provider this budget month. `actualMicros` keeps its meaning
 * (every reconciled amount); the cost basis splits it into provider-reported
 * and computed-from-usage parts, and names the synthetic (fixture, sandbox,
 * demo) share. The split fields are absent in checkpoints of older versions.
 */
export const spendEntrySchema = z.object({
  provider: z.string(),
  actualMicros: z.number(),
  reservedMicros: z.number(),
  estimatedMicros: z.number(),
  unknownCount: z.number(),
  /** Of actualMicros: reported by the provider/gateway (or entered by a named human from its billing history). */
  reportedMicros: z.number().optional(),
  /** Of actualMicros: computed by this application from usage at list price (the provider reported no charge). */
  computedMicros: z.number().optional(),
  computedCount: z.number().optional(),
  /** Of the committed amount: synthetic (fixture, sandbox, demo) reservations; no real charge. */
  syntheticMicros: z.number().optional(),
  syntheticCount: z.number().optional(),
});
export type SpendEntry = z.infer<typeof spendEntrySchema>;

const pendingOutput = z.object({
  dataforseo: z.object({ status: z.string(), checked: z.number(), fetched: z.number(), pending: z.number(), ambiguous: z.number(), reconciled: z.number(), errors: z.array(z.string()) }),
  apify: z.object({ status: z.string(), detail: z.string(), runs: z.number(), usageReconciled: z.number() }),
  unresolvedReservations: z.array(z.object({ id: z.string(), provider: z.string(), status: z.string(), estimatedMicros: z.number(), purpose: z.string().nullable(), createdAt: z.string() })),
  spend: z.array(spendEntrySchema),
  /**
   * The spend above is from a demo site or context (every amount is synthetic;
   * nothing was charged). Absent in checkpoints of older versions.
   */
  spendDemo: z.boolean().optional(),
  note: noteSchema,
});

/** Tag of spend figures that come from synthetic data (a demo site/context, or fixture/sandbox reservations). */
export const SYNTHETIC_SPEND_TAG = '[SYNTHETIC: no real charges]';

/**
 * One provider's spend in words, keeping provider-reported and computed
 * amounts apart (spec 25: a computed amount is never presented as a
 * provider charge): "$R provider-reported, $C computed from usage, $X
 * reserved, $E estimated-only[, N unknown]". A provider whose amounts include
 * synthetic reservations carries the SYNTHETIC tag with the synthetic amount
 * (not repeated per provider when the whole line is demo data). Entries
 * without the split (older checkpoints) say so instead of calling the total
 * provider-reported.
 */
export function spendEntryText(s: SpendEntry, opts: { demo?: boolean } = {}): string {
  const actual =
    s.reportedMicros !== undefined && s.computedMicros !== undefined
      ? `${formatUsd(s.reportedMicros)} provider-reported, ${formatUsd(s.computedMicros)} computed from usage`
      : `${formatUsd(s.actualMicros)} reconciled (provider-reported/computed split not recorded)`;
  const syn = !opts.demo && (s.syntheticCount ?? 0) > 0 ? ` ${SYNTHETIC_SPEND_TAG} (${formatUsd(s.syntheticMicros ?? 0)} of it from ${s.syntheticCount} fixture/sandbox/demo reservation(s))` : '';
  return `${s.provider} ${actual}, ${formatUsd(s.reservedMicros)} reserved, ${formatUsd(s.estimatedMicros)} estimated-only${s.unknownCount ? `, ${s.unknownCount} unknown` : ''}${syn}`;
}

/** "Spend this month[ SYNTHETIC tag]: <provider texts>": shared by the pipeline CLI summary and the vault system log. */
export function spendSummaryText(spend: readonly SpendEntry[], opts: { demo?: boolean } = {}): string {
  return `Spend this month${opts.demo ? ` ${SYNTHETIC_SPEND_TAG}` : ''}: ${spend.map((s) => spendEntryText(s, opts)).join('; ')}`;
}

async function pendingWork(env: PipelineEnv, sctx: StageContext): Promise<z.infer<typeof pendingOutput>> {
  const app = sctx.app;
  const svc = env.services(app);
  const notes: string[] = [];
  let dfs: z.infer<typeof pendingOutput>['dataforseo'] = { status: 'skipped', checked: 0, fetched: 0, pending: 0, ambiguous: 0, reconciled: 0, errors: [] };
  if (app.dryRun) dfs.status = 'dry_run';
  else if (!app.settings.features.dataforseo) dfs.status = 'disabled';
  else {
    try {
      const { approvals: _a, ...dfsOpts } = svc.dataforseo;
      void _a;
      const r = await pollPendingTasks(app, { ...dfsOpts, forPolling: true });
      dfs = { status: 'polled', checked: r.checked, fetched: r.fetched.length, pending: r.pending.length, ambiguous: r.ambiguous.length, reconciled: r.reconciled.length, errors: limit(r.errors, 10) };
      if (r.ambiguous.length) notes.push(`${r.ambiguous.length} DataForSEO task(s) are ambiguous (charge unknown, reservation kept); they are never resubmitted automatically.`);
    } catch (err) {
      dfs = { ...dfs, status: 'error', errors: [errorMessage(err)] };
      notes.push(`DataForSEO pending tasks were not polled: ${errorMessage(err)}`);
    }
  }
  let apify: z.infer<typeof pendingOutput>['apify'] = { status: 'skipped', detail: '', runs: 0, usageReconciled: 0 };
  if (!app.settings.features.apify) apify = { ...apify, status: 'disabled', detail: 'features.apify is off' };
  else {
    try {
      const r = await resumeApifyRuns(app, { ...(svc.apify.client ? { client: svc.apify.client } : {}) });
      apify = { status: r.status, detail: r.detail, runs: r.runs.length, usageReconciled: r.usageReconciled.length };
    } catch (err) {
      apify = { ...apify, status: 'error', detail: errorMessage(err) };
      notes.push(`Apify runs were not resumed: ${errorMessage(err)}`);
    }
  }
  const unresolved = app.db
    .all<{ id: string; provider: string; status: string; estimated_usd_micros: number; purpose: string | null; created_at: string }>(
      `SELECT id, provider, status, estimated_usd_micros, purpose, created_at FROM budget_reservations WHERE site_id = ? AND status IN ('reserved', 'unresolved') ORDER BY created_at LIMIT 50`,
      [app.siteId],
    )
    .map((r) => ({ id: r.id, provider: r.provider, status: r.status, estimatedMicros: r.estimated_usd_micros, purpose: r.purpose, createdAt: r.created_at }));
  if (unresolved.length) notes.push(`${unresolved.length} budget reservation(s) are not reconciled yet (kept reserved at their estimate; unknown charges are never counted as $0).`);
  const report = app.budgets.report(app.siteId);
  const spend = report.providers.map((p): SpendEntry => {
    const basis = (report.costBasis ?? []).find((b) => b.provider === p.provider);
    return {
      provider: p.provider,
      actualMicros: p.actualMicros,
      reservedMicros: p.reservedMicros,
      estimatedMicros: p.estimatedMicros,
      unknownCount: p.unknownCount,
      ...(basis
        ? { reportedMicros: basis.reportedMicros, computedMicros: basis.computedMicros, computedCount: basis.computedCount, syntheticMicros: basis.syntheticMicros, syntheticCount: basis.syntheticCount }
        : {}),
    };
  });
  return {
    dataforseo: dfs,
    apify,
    unresolvedReservations: unresolved,
    spend,
    spendDemo: report.synthetic === true || app.synthetic,
    note: notes.length ? note('degraded', notes.join(' '), null, unresolved.length ? 'Review with `npm run cli -- costs` and reconcile ambiguous charges from the provider dashboards.' : null) : null,
  };
}

export function resumePendingStage(env: PipelineEnv, next: string, prerequisites: string[]): EngineStage {
  return defineStage({
    name: 'resume_pending',
    version: 'resume_pending@1',
    description: 'Resume queued/ambiguous DataForSEO tasks and pending Apify runs with free GETs (never resubmits a paid request).',
    input: z.object({}),
    output: pendingOutput,
    prerequisites,
    evidence: { requirement: 'dataforseo_tasks, apify_runs, and budget_reservations rows of this site.' },
    timeoutMs: 300_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    optional: true,
    providers: [],
    stoppingConditions: ['Never stops the workflow; provider errors are recorded.'],
    next: [next],
    buildInput: () => ({}),
    run: async (_input, sctx) => pendingWork(env, sctx),
  });
}

export function reconcileCostsStage(env: PipelineEnv, prerequisites: string[]): EngineStage {
  return defineStage({
    name: 'reconcile_costs',
    version: 'reconcile_costs@1',
    description: 'Reconcile costs: poll pending DataForSEO tasks and Apify runs (free), and list unresolved reservations and spend (provider-reported, computed from usage, reserved, estimated, unknown kept separate; synthetic amounts labeled).',
    input: z.object({}),
    output: pendingOutput,
    prerequisites,
    evidence: { requirement: 'Provider task/run history and budget_reservations.' },
    timeoutMs: 300_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    optional: true,
    stoppingConditions: ['Final stage.'],
    next: ['done'],
    buildInput: () => ({}),
    run: async (_input, sctx) => {
      const out = await pendingWork(env, sctx);
      const svc = env.services(sctx.app);
      if (svc.vault && !sctx.app.dryRun) {
        try {
          const unknown = out.spend.reduce((s, p) => s + p.unknownCount, 0);
          svc.vault.appendSystemLog(
            `${sctx.workflow} job ${sctx.jobId}: costs reconciled; ${out.unresolvedReservations.length} unresolved reservation(s); ${unknown} charge(s) with unknown cost; ${spendSummaryText(out.spend, { demo: out.spendDemo === true }).replace(/^Spend/, 'spend')}.`,
          );
        } catch {
          /* the system log is a convenience; the database is authoritative */
        }
      }
      return out;
    },
  });
}

// ---------------------------------------------------------------------------
// Google sync
// ---------------------------------------------------------------------------

const datasetSummary = z.object({ dataset: z.string(), status: z.string(), rowsReceived: z.number(), truncated: z.boolean(), warnings: z.number() });

const segmentsOutput = z.object({
  /** fetched | partial | skipped | failed */
  status: z.string(),
  dimensions: z.array(z.string()),
  /** Report period the segment rows are for (start) and the request window (start..end, days ending yesterday in the Search Console time zone). */
  periodStart: z.string().nullable(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  days: z.number().nullable(),
  rowsReceived: z.number(),
  detail: z.string(),
});

const gscOutput = z.object({
  status: z.string(),
  property: z.string().nullable(),
  synthetic: z.boolean(),
  days: z.number().nullable(),
  datasets: z.array(datasetSummary),
  firstIncompleteDate: z.string().nullable(),
  warnings: z.array(z.string()),
  /** Country/device segment rows for the report period (weekly/monthly); absent in older checkpoints. */
  segments: segmentsOutput.nullable().optional(),
  note: noteSchema,
});

/**
 * Stage note of a Search Console or GA4 sync that ran as a dry run (status
 * `dry_run`): nothing was requested or written, so the stage is SKIPPED with
 * `DRY_RUN` (counted like the performance stage's dry-run skip), never a bare
 * success. The detail carries the offline credential check of the plan
 * (`plan.credentialCheck` and its note); credentials that could not be
 * verified offline (for example Application Default Credentials from a
 * metadata server) are said to be unverified, never "checked".
 */
export function syncDryRunNote(plan: { notes?: readonly string[]; credentialCheck?: string } | null | undefined): NonNullable<StageNote> {
  const check = plan?.credentialCheck ?? null;
  const credentialNote = plan?.notes?.find((n) => /^Credentials\b/.test(n)) ?? null;
  const parts = ['Dry run: nothing was requested or written.'];
  if (check === 'unverified') parts.push('Credentials could not be verified offline.');
  if (credentialNote) parts.push(credentialNote);
  else if (check === null) parts.push('The credentials were not checked.');
  return {
    status: 'skipped',
    code: 'DRY_RUN',
    detail: parts.join(' '),
    nextStep:
      check === 'unverified'
        ? 'Run without --dry-run to collect data; only the real run can verify these credentials (check them first with `npm run cli -- auth diagnose`).'
        : 'Run without --dry-run to collect data.',
  };
}

function providerOrThrow(svc: AppServices): NonNullable<AppServices['google']['provider']> {
  if (!svc.google.provider) throw new AppError('CREDENTIALS_MISSING', svc.google.error ?? 'No Google auth provider is available for this site.', { hint: 'Run `npm run cli -- auth google` (or configure a service account) and check `npm run cli -- auth status`.' });
  return svc.google.provider;
}

/** Report segment dimensions: requested only when the site config names target countries or devices (market.countries / market.devices). */
export const REPORT_SEGMENT_DIMENSIONS: readonly GscSegment[] = ['country', 'device'];
/** Segment rows are fetched automatically only for report periods that start at most this many days before yesterday (a calendar month plus the lag). */
export const REPORT_SEGMENT_MAX_DAYS = 93;

export function reportSegmentsWanted(app: Pick<AppContext, 'config'>): boolean {
  return app.config.market.countries.length > 0 || app.config.market.devices.length > 0;
}

export interface SyncGscStageOptions {
  next: string;
  prerequisites: string[];
  days: (app: AppContext) => number | null;
  /**
   * Weekly/monthly: also fetch country/device segment rows (the existing
   * `syncGsc` segments option) bounded to this report kind's period, when the
   * site config names target countries or devices. The report then shows
   * country/device context instead of DATA_UNAVAILABLE.
   */
  reportSegments?: ReportKind;
}

/**
 * First date in start..end without FINAL current country/device page rows for
 * every configured search type (null when all are stored). Dates with no
 * row at all count as uncovered, so they are requested again.
 */
function firstUncoveredSegmentDate(app: AppContext, start: string, end: string): string | null {
  const property = app.config.google.searchConsoleProperty;
  const types = app.config.google.gsc.searchTypes;
  if (!property || !types.length) return start;
  const rows = app.db.all<{ d: string; n: number }>(
    `SELECT date AS d, COUNT(DISTINCT search_type) AS n FROM gsc_page_daily_current
     WHERE site_id = ? AND property = ? AND is_final = 1 AND date BETWEEN ? AND ?
       AND search_type IN (${types.map(() => '?').join(', ')})
       AND segment_key LIKE '%country=%' AND segment_key LIKE '%device=%' AND segment_key NOT LIKE '%searchAppearance=%'
     GROUP BY date`,
    [app.siteId, property, start, end, ...types],
  );
  const covered = new Set(rows.filter((r) => Number(r.n) >= types.length).map((r) => r.d));
  for (let d = start; d <= end; d = addDays(d, 1)) if (!covered.has(d)) return d;
  return null;
}

/**
 * Bounded segment fetch for the report period: a second, page-totals-only
 * `syncGsc` call with country/device dimensions over the days from the report
 * period start to yesterday (Search Console time), after the regular sync
 * made the period resolvable. Versioned ingestion never double counts the
 * unsegmented rows it re-reads. A failure degrades only the segment context.
 */
async function syncReportSegments(sctx: StageContext, kind: ReportKind, override: { start: string; end: string } | null, provider: NonNullable<AppServices['google']['provider']>): Promise<z.infer<typeof segmentsOutput>> {
  const app = sctx.app;
  const dims = [...REPORT_SEGMENT_DIMENSIONS];
  const base = { dimensions: dims, periodStart: null, start: null, end: null, days: null, rowsReceived: 0 };
  let periodStart: string;
  try {
    periodStart = resolvePeriod(app, kind, override ?? {}).start;
  } catch (err) {
    return { ...base, status: 'skipped', detail: `The report period could not be resolved (${errorMessage(err)}); no segment rows were requested.` };
  }
  const yesterday = addDays(dateInZone(app.clock.now(), GSC_TIME_ZONE), -1);
  if (periodStart > yesterday) return { ...base, periodStart, status: 'skipped', detail: `The report period starts after the latest Search Console date (${yesterday}); no segment rows were requested.` };
  const days = daysBetweenInclusive(periodStart, yesterday);
  if (days > REPORT_SEGMENT_MAX_DAYS) {
    return {
      ...base,
      periodStart,
      days,
      status: 'skipped',
      detail: `The report period starts ${days} days before the latest Search Console date; country/device rows are fetched automatically only for the last ${REPORT_SEGMENT_MAX_DAYS} days. Fetch them explicitly with \`npm run cli -- sync gsc --segments country,device --days ${Math.min(days, 486)}\`.`,
    };
  }
  // Dates of the period whose final country/device rows are already stored are not requested again (quota).
  const start = firstUncoveredSegmentDate(app, periodStart, yesterday);
  if (start === null) return { ...base, periodStart, days: 0, status: 'up_to_date', detail: `Final country/device segment rows for ${periodStart}..${yesterday} are already stored; nothing was requested.` };
  const fetchDays = daysBetweenInclusive(start, yesterday);
  const r = await withBreaker(sctx, 'google', () => syncGsc(app, { provider, days: fetchDays, segments: dims, includePageQuery: false }));
  // Segmented request sets are reported with segment key "dims:<dimensions>" (the unsegmented rows re-read here are not counted).
  const segmented = r.datasets.filter((d) => d.segmentKey.startsWith('dims:'));
  const rows = segmented.reduce((n, d) => n + d.rowsReceived, 0);
  const segFailed = !segmented.length || segmented.every((d) => d.status === 'failed' || d.status === 'skipped');
  if (r.status === 'failed' || segFailed) return { ...base, periodStart, start, end: yesterday, days: fetchDays, status: 'failed', detail: `Country/device segment sync failed: ${limit(r.warnings, 2).join('; ') || 'no segment dataset was collected'}` };
  return {
    ...base,
    periodStart,
    start,
    end: yesterday,
    days: fetchDays,
    rowsReceived: rows,
    status: r.status === 'partial' ? 'partial' : 'fetched',
    detail: `${rows} ${dims.join('/')} segment row(s) collected for ${start}..${yesterday} (page totals only)${r.status === 'partial' ? `; partial: ${limit(r.warnings, 2).join('; ')}` : ''}.`,
  };
}

export function syncGscStage(env: PipelineEnv, opts: SyncGscStageOptions): EngineStage {
  const kind = opts.reportSegments ?? null;
  return defineStage({
    name: 'sync_gsc',
    version: kind ? 'sync_gsc@2' : 'sync_gsc@1',
    description: kind
      ? `Search Console ingestion (versioned; re-runs never double count): property totals, page totals, targeted page/query detail, data availability; plus country/device segment rows bounded to the ${kind} report period when market.countries or market.devices is set.`
      : 'Search Console ingestion (versioned; re-runs never double count): property totals, page totals, targeted page/query detail, data availability.',
    input: z.object({ days: z.number().int().positive().nullable(), segments: z.boolean().optional(), period: z.object({ start: z.string(), end: z.string() }).nullable().optional() }),
    output: gscOutput,
    prerequisites: opts.prerequisites,
    evidence: { requirement: 'An accessible, exactly configured Search Console property (read-only scope).' },
    timeoutMs: 45 * 60_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    optional: true,
    providers: ['google'],
    stoppingConditions: ['Missing credentials or provider errors degrade this stage; the report states it and routes to INVALID_OR_INCOMPLETE_DATA when data is missing.'],
    next: [opts.next],
    buildInput: (sctx, params) => ({
      days: opts.days(sctx.app),
      ...(kind ? { segments: reportSegmentsWanted(sctx.app), period: paramsOf(params).period ?? null } : {}),
    }),
    run: async (input, sctx) => {
      const app = sctx.app;
      if (!app.settings.features.gsc) return { status: 'disabled', property: null, synthetic: app.synthetic, days: input.days, datasets: [], firstIncompleteDate: null, warnings: [], note: note('skipped', 'Search Console ingestion is disabled (features.gsc).', 'INTEGRATION_DISABLED', 'Set features.gsc: true in the site config.') };
      if (!app.config.google.searchConsoleProperty) {
        throw new AppError('CONFIG_MISSING', 'No Search Console property is configured (google.searchConsoleProperty).', { hint: 'Discover it with `npm run cli -- auth status` and set google.searchConsoleProperty exactly (never guessed).' });
      }
      const provider = providerOrThrow(env.services(app));
      const r = await withBreaker(sctx, 'google', () => syncGsc(app, { provider, ...(input.days ? { days: input.days } : {}) }));
      if (r.status === 'failed') throw new AppError('PROVIDER_ERROR', `Search Console sync failed: ${limit(r.warnings, 3).join('; ') || 'every dataset failed'}`, { hint: 'Run `npm run cli -- auth diagnose`.' });
      const first = r.availability.map((a) => (a as { firstIncompleteDate?: string | null }).firstIncompleteDate ?? null).find((d) => !!d) ?? null;
      const notes: string[] = [];
      if (r.status === 'partial') notes.push(`Search Console sync was partial: ${limit(r.warnings, 3).join('; ')}`);
      let segments: z.infer<typeof segmentsOutput> | null = null;
      if (kind && input.segments && !app.dryRun && r.status !== 'dry_run') {
        try {
          segments = await syncReportSegments(sctx, kind, input.period ?? null, provider);
        } catch (err) {
          segments = { status: 'failed', dimensions: [...REPORT_SEGMENT_DIMENSIONS], periodStart: null, start: null, end: null, days: null, rowsReceived: 0, detail: `Country/device segment sync failed: ${errorMessage(err)}` };
        }
        if (segments.status === 'failed' || segments.status === 'partial') notes.push(`${segments.detail} Country/device context in the report may be missing or incomplete (never zero).`);
        else if (segments.status === 'skipped' && segments.days !== null && segments.days > REPORT_SEGMENT_MAX_DAYS) notes.push(`${segments.detail} Without them the report shows country/device context as unavailable (never zero).`);
      }
      return {
        status: r.status,
        property: r.property,
        synthetic: r.synthetic,
        days: input.days,
        datasets: r.datasets.map((d) => ({ dataset: `${d.dataset}${d.segmentKey ? `:${d.segmentKey}` : ''}:${d.searchType}`, status: d.status, rowsReceived: d.rowsReceived, truncated: d.truncated, warnings: d.warnings.length })),
        firstIncompleteDate: first,
        warnings: limit(r.warnings, 20),
        ...(kind ? { segments } : {}),
        // A dry run requested and wrote nothing: skipped (DRY_RUN), never a bare success.
        note:
          r.status === 'dry_run'
            ? syncDryRunNote(r.plan)
            : notes.length
              ? note(
                  'degraded',
                  notes.join(' '),
                  r.status === 'partial' ? 'PARTIAL' : segments?.status === 'skipped' ? 'SEGMENTS_NOT_FETCHED' : 'SEGMENTS_UNAVAILABLE',
                  segments?.status === 'skipped' && r.status !== 'partial' ? `Fetch them explicitly: \`npm run cli -- sync gsc --segments country,device --days ${Math.min(segments.days ?? REPORT_SEGMENT_MAX_DAYS, 486)}\`.` : 'Re-run later; unchanged rows are not duplicated.',
                )
              : null,
      };
    },
  });
}

/** Deterministic report period, fixed once per job (checkpointed) after the Search Console sync. */
export function planPeriodStage(kind: ReportKind, next: string, prerequisites: string[], optionalPrerequisites: string[]): EngineStage {
  return defineStage({
    name: 'plan_period',
    version: 'plan_period@1',
    description: `Fix the ${kind} report period (ending at the latest complete date; incomplete dates are never compared with complete periods) and the business date of this run.`,
    input: z.object({ override: z.object({ start: z.string(), end: z.string() }).nullable() }),
    output: z.object({ kind: z.string(), period: periodSchema, today: z.string() }),
    prerequisites,
    optionalPrerequisites,
    evidence: { requirement: 'Search Console data availability, else the latest final/complete rows, else a labeled assumption.' },
    timeoutMs: 30_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    idempotent: true,
    stoppingConditions: ['Never stops; an assumed end date is labeled in the report.'],
    next: [next],
    buildInput: (_sctx, params) => ({ override: paramsOf(params).period ?? null }),
    run: async (input, sctx) => ({ kind, period: resolvePeriod(sctx.app, kind, input.override ?? {}), today: businessToday(sctx.app) }),
  });
}

const ga4Output = z.object({
  status: z.string(),
  propertyId: z.string().nullable(),
  synthetic: z.boolean(),
  periods: z.array(z.object({ start: z.string(), end: z.string() })),
  datasets: z.array(datasetSummary),
  primaryRateMetric: z.string().nullable(),
  limitations: z.array(z.string()),
  warnings: z.array(z.string()),
  note: noteSchema,
});

export function syncGa4Stage(env: PipelineEnv, opts: { next: string; prerequisites: string[]; optionalPrerequisites?: string[]; days: (app: AppContext) => number | null }): EngineStage {
  return defineStage({
    name: 'sync_ga4',
    version: 'sync_ga4@1',
    description: 'GA4 ingestion: Google organic and all organic landing views, events, and period-level users/rates for exactly the report period (and its comparison period).',
    input: z.object({ days: z.number().int().positive().nullable(), periods: z.array(z.object({ start: z.string(), end: z.string() })) }),
    output: ga4Output,
    prerequisites: opts.prerequisites,
    optionalPrerequisites: opts.optionalPrerequisites ?? [],
    evidence: { requirement: 'A numeric GA4 property the credentials can read; configured primary/secondary events.' },
    timeoutMs: 45 * 60_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    optional: true,
    providers: ['google'],
    stoppingConditions: ['Missing credentials, property, or quota degrade this stage; the report marks GA4 data DATA_UNAVAILABLE.'],
    next: [opts.next],
    buildInput: (sctx) => {
      const plan = sctx.prior.plan_period as { period?: z.infer<typeof periodSchema> } | undefined;
      const p = plan?.period;
      const periods = p ? [{ start: p.start, end: p.end }, ...(p.comparison ? [{ start: p.comparison.start, end: p.comparison.end }] : [])] : [];
      return { days: opts.days(sctx.app), periods };
    },
    run: async (input, sctx) => {
      const app = sctx.app;
      if (!app.settings.features.ga4) return { status: 'disabled', propertyId: null, synthetic: app.synthetic, periods: input.periods, datasets: [], primaryRateMetric: null, limitations: [], warnings: [], note: note('skipped', 'GA4 ingestion is disabled (features.ga4).', 'INTEGRATION_DISABLED', 'Set features.ga4: true in the site config.') };
      if (!app.config.google.ga4PropertyId) throw new AppError('CONFIG_MISSING', 'No GA4 property is configured (google.ga4PropertyId).', { hint: 'Copy the numeric GA4 property ID (GA4 Admin > Property details) into the site config.' });
      const provider = providerOrThrow(env.services(app));
      const r = await withBreaker(sctx, 'google', () => syncGa4(app, { provider, ...(input.days ? { days: input.days } : {}), periods: input.periods }));
      if (r.status === 'failed') throw new AppError('PROVIDER_ERROR', `GA4 sync failed: ${limit(r.warnings, 3).join('; ') || 'every report failed'}`, { hint: 'Run `npm run cli -- auth diagnose`.' });
      const limitations = limit(r.limitations, 10);
      return {
        status: r.status,
        propertyId: r.propertyId,
        synthetic: r.synthetic,
        periods: input.periods,
        datasets: r.datasets.map((d) => ({ dataset: `${d.dataset}:${d.view}:${d.variant}`, status: d.status, rowsReceived: d.rowsReceived, truncated: d.truncated, warnings: d.warnings.length })),
        primaryRateMetric: r.metricPlan?.primaryRateMetric ?? null,
        limitations,
        warnings: limit(r.warnings, 20),
        // A dry run requested and wrote nothing: skipped (DRY_RUN), never a bare success.
        note:
          r.status === 'dry_run'
            ? syncDryRunNote(r.plan)
            : r.status === 'partial'
              ? note('degraded', `GA4 sync was partial: ${limit(r.warnings, 3).join('; ')}`, 'PARTIAL', 'Re-run later; unchanged rows are not duplicated.')
              : r.metricPlan && !r.metricPlan.primaryRateMetric && app.config.conversions.primaryEvents.length
                ? note('degraded', `The session key-event rate for the primary event "${app.config.conversions.primaryEvents[0]!.name}" is not available in GA4 metadata; conversion rates are reported as DATA_UNAVAILABLE (no substitute is used silently).`, 'PRIMARY_EVENT_METRIC_UNAVAILABLE', 'Mark the event as a key event in GA4 and follow `npm run cli -- sync ga4 --checklist`.')
                : null,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Measurement / join validation
// ---------------------------------------------------------------------------

export const measurementOutput = z.object({
  period: z.object({ start: z.string(), end: z.string() }),
  gsc: z.object({ status: z.string(), detail: z.string() }),
  ga4: z.object({ status: z.string(), detail: z.string() }),
  conversionDefinition: z.string(),
  primaryEvent: z.string().nullable(),
  primaryEventMetric: z.object({ available: z.boolean().nullable(), detail: z.string() }),
  siteRoute: z.string().nullable(),
  siteReasons: z.array(z.string()),
  unjoinedGa4Rows: z.number(),
  lowData: z.boolean().nullable(),
  synthetic: z.boolean(),
  warnings: z.array(z.string()),
  checklist: z.string().nullable(),
  note: noteSchema,
});

/**
 * Measurement / join check over `days` ending at `end` (default: the latest
 * date complete in Search Console and GA4). The pipelines pass the report
 * period, so the check covers exactly the reviewed dates.
 */
export function measurementCheck(app: AppContext, days = 28, end: string | null = null): z.infer<typeof measurementOutput> {
  const site = prepareSiteAnalysis({ db: app.db, siteId: app.siteId, config: app.config, clock: app.clock, synthetic: app.synthetic }, { days, end });
  const primaryEvent = app.config.conversions.primaryEvents[0]?.name ?? null;
  let metric: { available: boolean | null; detail: string } = { available: null, detail: 'GA4 metadata has not been fetched yet (no successful GA4 sync).' };
  let checklist: string | null = null;
  const pid = app.config.google.ga4PropertyId;
  if (!primaryEvent) metric = { available: false, detail: 'No primary conversion event is configured (conversions.primaryEvents).' };
  else if (pid) {
    const cached = loadCachedGa4Metadata(app, pid);
    if (cached?.metadata) {
      const plan = planGa4Metrics(cached.metadata, { primary: app.config.conversions.primaryEvents.map((e) => e.name), secondary: app.config.conversions.secondaryEvents.map((e) => e.name) });
      metric = plan.primaryRateMetric
        ? { available: true, detail: `${plan.primaryRateMetric} is listed in GA4 metadata (fetched ${cached.fetchedAt}).` }
        : { available: false, detail: `sessionKeyEventRate:${primaryEvent} is not listed in GA4 metadata (fetched ${cached.fetchedAt}); the event may not be marked as a key event.` };
      if (!plan.primaryRateMetric) checklist = ga4ConversionChecklist(app.config, plan);
    }
  }
  const siteReasons = (site.siteDecision?.reasons ?? []).map((r) => `${r.code}: ${r.detail}`);
  const problems: string[] = [];
  if (site.gsc.status !== 'complete') problems.push(`Search Console ${site.gsc.status}: ${site.gsc.detail}`);
  if (site.ga4.status !== 'complete') problems.push(`GA4 ${site.ga4.status}: ${site.ga4.detail}`);
  if (site.conversionDefinition === 'missing') problems.push('no primary conversion event is configured');
  if (metric.available === false) problems.push(metric.detail);
  if (site.unjoinedGa4.length) problems.push(`${site.unjoinedGa4.length} GA4 landing row(s) could not be joined to a known page`);
  return {
    period: site.period.period,
    gsc: { status: site.gsc.status, detail: site.gsc.detail },
    ga4: { status: site.ga4.status, detail: site.ga4.detail },
    conversionDefinition: site.conversionDefinition,
    primaryEvent,
    primaryEventMetric: metric,
    siteRoute: site.siteDecision?.route ?? null,
    siteReasons: limit(siteReasons, 10),
    unjoinedGa4Rows: site.unjoinedGa4.length,
    lowData: site.lowData,
    synthetic: site.synthetic,
    warnings: limit(site.warnings, 20),
    checklist,
    note: problems.length ? note('degraded', `Measurement check: ${problems.join('; ')}.`, site.siteDecision?.route ?? 'MEASUREMENT_INCOMPLETE', checklist ? 'Follow the GA4 conversion checklist (`npm run cli -- sync ga4 --checklist`) and re-run.' : 'Repair measurement or wait for complete data before optimizing.') : null,
  };
}

export function measurementStage(name: 'check_measurement' | 'validate_joins', next: string, prerequisites: string[], optionalPrerequisites: string[] = []): EngineStage {
  return defineStage({
    name,
    version: name === 'validate_joins' ? 'validate_joins@2' : `${name}@1`,
    description:
      name === 'check_measurement'
        ? 'Check measurement: complete GSC/GA4 coverage, primary-event metric availability, conversion definition, and GA4/GSC page joins.'
        : 'Validate joins: GSC and GA4 joined at compatible page/period grain; incomplete data and unjoined landing pages are reported, never multiplied.',
    // validate_joins: the report period of this run (plan_period); check_measurement (or no plan): the latest 28 complete days.
    input: z.object({ days: z.number().int().min(1).max(480), end: z.string().nullable().optional() }),
    output: measurementOutput,
    prerequisites,
    optionalPrerequisites,
    evidence: { requirement: 'Ingested GSC/GA4 rows with coverage metadata and the cached GA4 metadata.' },
    timeoutMs: 120_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    idempotent: true,
    stoppingConditions: ['Never stops: INVALID_OR_INCOMPLETE_DATA is passed to routing (repair measurement or wait).'],
    next: [next],
    buildInput: (sctx) => {
      // validate_joins (weekly, monthly) checks the reviewed period. The baseline's check_measurement checks the
      // latest 28 complete days: the baseline period is the whole history window, which can start before the first
      // collected Search Console date, and would flag those dates instead of the current measurement health.
      const p = name === 'validate_joins' ? (sctx.prior.plan_period as { period?: { end?: unknown; days?: unknown } } | undefined)?.period : undefined;
      if (p && typeof p.end === 'string' && isIsoDate(p.end) && typeof p.days === 'number' && p.days >= 1) return { days: Math.min(480, Math.floor(p.days)), end: p.end };
      return { days: 28, end: null };
    },
    run: async (input, sctx) => measurementCheck(sctx.app, input.days, input.end ?? null),
  });
}

// ---------------------------------------------------------------------------
// Crawl, performance, URL inspection
// ---------------------------------------------------------------------------

const crawlOutput = z.object({
  status: z.string(),
  crawlId: z.string().nullable(),
  counts: z.object({ attempted: z.number(), fetched: z.number(), blocked: z.number(), failed: z.number(), skipped: z.number() }),
  stopReason: z.string().nullable(),
  transport: z.string(),
  isSynthetic: z.boolean(),
  confirmedIssues: z.number().nullable(),
  issuesByType: z.record(z.string(), z.number()),
  notes: z.array(z.string()),
  note: noteSchema,
});

export function crawlSiteStage(env: PipelineEnv, next: string, prerequisites: string[]): EngineStage {
  return defineStage({
    name: 'crawl_site',
    version: 'crawl_site@1',
    description: 'Bounded own-site crawl (robots.txt respected, SSRF-safe, crawl-trap limits) followed by technical checks.',
    input: z.object({ maxPages: z.number().int().positive().nullable() }),
    output: crawlOutput,
    prerequisites,
    evidence: { requirement: 'The configured site URL and allowed hostnames; crawl caps from the site config.' },
    timeoutMs: 60 * 60_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    optional: true,
    providers: ['crawler'],
    stoppingConditions: ['Login barriers, access denials, robots disallow, and traps stop the affected URLs (never bypassed).'],
    next: [next],
    buildInput: (_sctx, params) => ({ maxPages: paramsOf(params).crawlMaxPages ?? null }),
    run: async (input, sctx) => {
      const app = sctx.app;
      const svc = env.services(app);
      const r = await withBreaker(sctx, 'crawler', () => crawlSite(app, { ...svc.crawler, jobId: sctx.jobId, signal: sctx.signal, ...(input.maxPages ? { maxPages: input.maxPages } : {}) }));
      if (r.status === 'failed') throw new AppError('PROVIDER_ERROR', `Own-site crawl failed: ${r.stopReason ?? limit(r.notes, 2).join('; ')}`, { hint: r.nextStep ?? 'Check `npm run cli -- crawl status --network`.' });
      // Every status but a completed crawl carries a note: a dry run fetched nothing (CRAWL_DRY_RUN), never a bare success.
      const degraded = r.status === 'offline' || r.status === 'disabled' || r.status === 'partial' || r.status === 'cancelled' || r.status === 'dry_run';
      const detail = r.status === 'dry_run' ? `Own-site crawl not run (dry run): ${limit(r.notes, 2).join('; ') || 'no request was made and nothing was written.'}` : `Own-site crawl ${r.status}: ${r.stopReason ?? limit(r.notes, 2).join('; ')}`;
      const nextStep = r.nextStep ?? (r.status === 'dry_run' ? 'Run without --dry-run to crawl the site.' : null);
      return {
        status: r.status,
        crawlId: r.crawlId,
        counts: r.counts,
        stopReason: r.stopReason,
        transport: r.transport,
        isSynthetic: r.isSynthetic,
        confirmedIssues: r.checks?.confirmedCount ?? null,
        issuesByType: r.checks?.byType ?? {},
        notes: limit(r.notes, 10),
        note: degraded ? note(r.status === 'partial' ? 'degraded' : 'skipped', detail, `CRAWL_${r.status.toUpperCase()}`, nextStep) : null,
      };
    },
  });
}

export function performanceStage(env: PipelineEnv, next: string, prerequisites: string[]): EngineStage {
  return defineStage({
    name: 'performance',
    version: 'performance@1',
    description: 'PageSpeed lab + CrUX field checks for priority pages only (reason priority_page; cached; lab and field kept separate).',
    input: z.object({ limit: z.number().int().min(1).max(10) }),
    output: z.object({
      checks: z.array(z.object({ url: z.string(), status: z.string(), lab: z.string(), field: z.string() })),
      note: noteSchema,
    }),
    prerequisites,
    evidence: { requirement: 'Priority pages (site root, protected pages, top GSC pages); PAGESPEED_API_KEY for PSI/CrUX.' },
    timeoutMs: 10 * 60_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    optional: true,
    providers: ['pagespeed'],
    stoppingConditions: ['Disabled, offline, or missing key: recorded as a skipped check, never a fabricated score.'],
    next: [next],
    buildInput: () => ({ limit: 3 }),
    run: async (input, sctx) => {
      const app = sctx.app;
      if (!app.settings.features.pagespeed) return { checks: [], note: note('skipped', 'Performance checks are disabled (features.pagespeed).', 'INTEGRATION_DISABLED', 'Set features.pagespeed: true and PAGESPEED_API_KEY to enable them.') };
      const svc = env.services(app);
      const checks: Array<{ url: string; status: string; lab: string; field: string }> = [];
      for (const p of selectPriorityPages(app, input.limit)) {
        try {
          const r = await checkPerformance(app, p.url, { reason: 'priority_page', device: 'mobile', ...(svc.pagespeed.fetch ? { fetch: svc.pagespeed.fetch } : {}) });
          checks.push({ url: p.url, status: r.status, lab: r.lab.status, field: r.crux.status });
        } catch (err) {
          checks.push({ url: p.url, status: 'failed', lab: 'failed', field: errorMessage(err).slice(0, 200) });
        }
      }
      const bad = checks.filter((c) => c.status !== 'ok' && c.status !== 'cached');
      if (!bad.length) return { checks, note: null };
      const kinds = [...new Set(bad.map((b) => b.status))];
      const code = kinds.length === 1 && kinds[0] === 'dry_run' ? 'DRY_RUN' : kinds.length === 1 && kinds[0] === 'offline' ? 'OFFLINE' : 'PERFORMANCE_UNAVAILABLE';
      const nextStep = code === 'DRY_RUN' ? 'Dry run: run without --dry-run to check performance.' : code === 'OFFLINE' ? 'Run online (without --offline / outside the demo) with PAGESPEED_API_KEY configured.' : 'Configure PAGESPEED_API_KEY (free Google API key; enable the PageSpeed Insights and Chrome UX Report APIs) and run online.';
      return { checks, note: note(bad.length === checks.length ? 'skipped' : 'degraded', `${bad.length} of ${checks.length} performance check(s) did not complete (${kinds.join(', ')}); no score is estimated.`, code, nextStep) };
    },
  });
}

/**
 * Stage note for a URL Inspection run in which nothing was inspected (every
 * URL skipped, or no URL selected). It is never a success: no indexed state
 * was observed, so the stage is degraded with the next step that fits the
 * skip reasons.
 */
export function nothingInspectedNote(r: Pick<InspectUrlsResult, 'outcomes' | 'property' | 'cap'>): NonNullable<StageNote> {
  const reasons = r.outcomes.filter((o) => o.status === 'skipped').map((o) => o.reason ?? '');
  const all = (re: RegExp) => reasons.length > 0 && reasons.every((x) => re.test(x));
  const some = (re: RegExp) => reasons.some((x) => re.test(x));
  let nextStep: string;
  if (!r.outcomes.length) {
    nextStep = 'No priority URL was selected: sync Search Console (`npm run cli -- sync gsc`) so the site has pages with recent impressions, check that site.url lies under google.searchConsoleProperty, then rerun.';
  } else if (all(/^Dry run/)) {
    nextStep = 'Dry run: run without --dry-run to inspect URLs.';
  } else if (all(/^Not under the Search Console property/)) {
    nextStep = `None of the selected URLs is under the configured Search Console property${r.property ? ` ${r.property}` : ''}: check google.searchConsoleProperty (URL-prefix vs domain property) with \`npm run cli -- auth status\`.`;
  } else if (some(/quota/i)) {
    nextStep = 'The daily URL Inspection quota budget is used up; the next run continues after it resets (never forced).';
  } else if (some(/^Per-run cap reached/)) {
    nextStep = `The per-run cap allowed no inspection (cap ${r.cap}); raise google.gsc.urlInspectionMaxPerRun in the site config if you want URL Inspection in this pipeline.`;
  } else {
    nextStep = 'Review the skip reasons (`npm run cli -- sync inspect --json`) and rerun.';
  }
  const kinds = [...new Set(reasons.map((x) => x.replace(/ \(.*$/, '').replace(/property .*$/, 'property')))].slice(0, 3);
  const detail = r.outcomes.length ? `URL Inspection inspected nothing: all ${r.outcomes.length} URL(s) were skipped (${kinds.join('; ')}); no indexed state was observed.` : 'URL Inspection inspected nothing: no priority URL was selected; no indexed state was observed.';
  return { status: 'degraded', code: 'NOTHING_INSPECTED', detail, nextStep };
}

export function inspectUrlsStage(env: PipelineEnv, next: string, prerequisites: string[]): EngineStage {
  return defineStage({
    name: 'inspect_urls',
    version: 'inspect_urls@1',
    description: "URL Inspection for priority URLs only (Google's indexed state; not a live test; zero impressions never imply 'not indexed').",
    input: z.object({ max: z.number().int().min(0).max(50) }),
    output: z.object({ status: z.string(), inspected: z.number(), failed: z.number(), outcomes: z.array(z.object({ url: z.string(), verdict: z.string().nullable(), coverageState: z.string().nullable() })), detail: z.string(), note: noteSchema }),
    prerequisites,
    evidence: { requirement: 'Search Console property access (read-only) and features.urlInspection.' },
    timeoutMs: 10 * 60_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    optional: true,
    providers: ['google'],
    stoppingConditions: ['Per-run cap and daily quota; missing access degrades this stage.'],
    next: [next],
    buildInput: (sctx) => ({ max: Math.max(0, Math.min(50, sctx.app.config.google.gsc.urlInspectionMaxPerRun)) }),
    run: async (input, sctx) => {
      const app = sctx.app;
      if (!app.settings.features.urlInspection) {
        const detail = 'URL Inspection is disabled (features.urlInspection); no indexed state was observed.';
        return { status: 'disabled', inspected: 0, failed: 0, outcomes: [], detail, note: note('skipped', detail, 'INTEGRATION_DISABLED', 'Set features.urlInspection: true in the site config to inspect priority URLs (read-only, quota-limited).') };
      }
      if (input.max === 0) {
        const detail = 'URL Inspection is off for pipelines: google.gsc.urlInspectionMaxPerRun is 0; no indexed state was observed.';
        return { status: 'disabled', inspected: 0, failed: 0, outcomes: [], detail, note: note('skipped', detail, 'INTEGRATION_DISABLED', 'Raise google.gsc.urlInspectionMaxPerRun in the site config to inspect priority URLs.') };
      }
      const provider = providerOrThrow(env.services(app));
      const urls = selectPriorityUrls(app, input.max);
      const r = await withBreaker(sctx, 'google', () => inspectUrls(app, provider, urls, { max: input.max }));
      if (r.status === 'failed') throw new AppError('PROVIDER_ERROR', `URL Inspection failed: ${r.note}`);
      return {
        status: r.status,
        inspected: r.inspected,
        failed: r.failed,
        outcomes: limit(r.outcomes, 20).map((o) => ({ url: o.url, verdict: o.verdict ?? null, coverageState: o.coverageState ?? null })),
        detail: r.note,
        note: r.status === 'partial' ? note('degraded', `URL Inspection partial: ${r.note}`, 'PARTIAL', null) : r.status === 'nothing_inspected' ? nothingInspectedNote(r) : null,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Experiments review
// ---------------------------------------------------------------------------

export function reviewExperimentsStage(env: PipelineEnv, next: string, prerequisites: string[], optionalPrerequisites: string[] = []): EngineStage {
  return defineStage({
    name: 'review_experiments',
    version: 'review_experiments@1',
    description: 'Review existing experiments: evaluate those due (observational, weekday-matched; no significance claims), list those not yet due or awaiting implementation.',
    input: z.object({}),
    output: z.object({
      evaluated: z.array(z.object({ experimentId: z.string(), result: z.string(), concluded: z.boolean(), statusAfter: z.string() })),
      notDue: z.array(z.object({ id: z.string(), dueDate: z.string() })),
      awaitingImplementation: z.number(),
      errors: z.array(z.object({ experimentId: z.string(), error: z.string() })),
      note: noteSchema,
    }),
    prerequisites,
    optionalPrerequisites,
    evidence: { requirement: 'Recorded implementation times and complete GSC/GA4 windows; interference annotations.' },
    timeoutMs: 5 * 60_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    stoppingConditions: ['Never stops; insufficient evidence keeps an experiment observing.'],
    next: [next],
    buildInput: () => ({}),
    run: async (_input, sctx) => {
      const app = sctx.app;
      const svc = env.services(app);
      const r = reviewExperiments(app, { dryRun: app.dryRun, actor: 'system', gate: svc.approvals });
      return {
        evaluated: r.evaluated.map((e) => ({ experimentId: e.experimentId, result: String(e.result), concluded: e.concluded, statusAfter: e.statusAfter })),
        notDue: r.notDue.map((n) => ({ id: n.id, dueDate: n.dueDate })),
        awaitingImplementation: r.awaitingImplementation.length,
        errors: r.errors,
        note: r.errors.length ? note('degraded', `${r.errors.length} experiment evaluation(s) failed: ${r.errors.map((e) => `${e.experimentId}: ${e.error}`).slice(0, 3).join('; ')}`, 'EVALUATION_FAILED', null) : null,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Report + dashboard + vault
// ---------------------------------------------------------------------------

export const reportOutput = z.object({
  reportId: z.string(),
  kind: z.string(),
  period: z.object({ start: z.string(), end: z.string() }),
  persisted: z.boolean(),
  markdownFile: z.string().nullable(),
  vaultNote: z.string().nullable(),
  dashboard: z.string().nullable(),
  vault: z.object({ status: z.string(), created: z.number(), updated: z.number(), unchanged: z.number(), conflicts: z.number(), errors: z.array(z.string()) }),
  confidence: z.string(),
  primaryAction: z.string().nullable(),
  nextAction: z.string().nullable(),
  warnings: z.number(),
  accessIssues: z.number(),
  isSynthetic: z.boolean(),
  llmSummary: z.string(),
  issues: z.number(),
  stageNotes: z.array(z.object({ stage: z.string(), status: z.string(), code: z.string().nullable(), detail: z.string(), nextStep: z.string().nullable() })),
});
export type ReportOutput = z.infer<typeof reportOutput>;

/** Next step for engine-level skip/failure codes (so the report states an actionable status). */
export function nextStepForCode(code: string | null | undefined, stage: string): string | null {
  switch (code) {
    case 'MODE_NOT_PERMITTED':
      return `Re-run with --mode RESEARCH (or higher) to allow the budgeted ${stage} stage.`;
    case 'BUDGET_EXCEEDED':
      return 'Budget exhausted for this period: wait for the next period or raise the ceiling in the site config budgets (never automatic). Review spend with `npm run cli -- costs`.';
    case 'BUDGET_UNKNOWN_PRICE':
      return 'No verified price: configure a verified price override in the site config or approve the specific request through `approvals`.';
    case 'CREDENTIALS_MISSING':
      return 'Configure the credentials in <workspace>/secrets/secrets.env (never in chat) and check `npm run cli -- doctor`.';
    case 'INTEGRATION_DISABLED':
      return 'Enable the feature in the site config (features.*) if you want this stage.';
    case 'INTEGRATION_UNAVAILABLE':
      return 'The provider is unavailable (circuit breaker open); the next run retries after the cooldown. Check the breakers with `npm run cli -- jobs breakers`.';
    case 'OFFLINE':
      return 'This run was offline (--offline or demo mode); run without --offline to contact the provider.';
    case 'DRY_RUN':
      return 'Dry run: run without --dry-run to execute it.';
    case 'CONFIG_MISSING':
      return 'Complete the site configuration (`npm run cli -- config validate`).';
    case 'PREREQUISITE_UNSATISFIED':
      return 'A required earlier stage produced no output; see its status above.';
    default:
      return null;
  }
}

/** Stage outcomes of this job (engine checkpoints + notes carried in stage outputs), for the report. */
export function collectStageNotes(sctx: StageContext, stageNames: readonly string[]): PipelineStageNote[] {
  const app = sctx.app;
  const rows = new CheckpointStore(app.db, app.clock).list(app.siteId, sctx.jobId);
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) latest.set(r.stage, r);
  const out: PipelineStageNote[] = [];
  for (const name of stageNames) {
    const outNote = (sctx.prior[name] as { note?: StageNote } | undefined)?.note ?? null;
    if (outNote && outNote.status !== 'succeeded') {
      out.push({ stage: name, status: outNote.status, code: outNote.code, detail: outNote.detail, nextStep: outNote.nextStep ?? nextStepForCode(outNote.code, name), severity: outNote.status === 'degraded' ? 'warning' : 'info' });
      continue;
    }
    if (name in sctx.prior) continue;
    const cp = latest.get(name);
    if (!cp) continue;
    if (cp.status === 'skipped' || cp.status === 'failed') {
      const code = cp.error?.code ?? null;
      const policy = code === 'MODE_NOT_PERMITTED' || code === 'DRY_RUN';
      out.push({
        stage: name,
        status: cp.status === 'failed' ? 'failed' : 'skipped',
        code,
        detail: cp.error?.message ?? `stage ${cp.status}`,
        nextStep: (cp.error as { hint?: string } | null)?.hint ?? nextStepForCode(code, name),
        severity: policy ? 'info' : 'warning',
      });
    }
  }
  return out;
}

/** Caveat for the integration-status table of the entity notes and the dashboard: statuses of a run without network checks are offline checks only. */
export const OFFLINE_STATUS_NOTE = 'Offline checks only during this run (configuration and stored credentials).';

export function offlineStatusNote(access: Pick<AccessOutput, 'network'> | null | undefined): string | null {
  return access?.network ? null : OFFLINE_STATUS_NOTE;
}

/** The site-structure summary of an earlier `site_structure` stage output, or null when absent/invalid. */
export function siteStructureFromPrior(prior: unknown): SiteStructureSummary | null {
  const r = siteStructureSchema.safeParse((prior as { summary?: unknown } | undefined)?.summary);
  return r.success ? r.data : null;
}

export interface ReportStageOptions {
  kind: ReportKind;
  /** Stages whose outputs/outcomes are summarized in the report. */
  earlierStages: string[];
  prerequisites: string[];
  next: string;
  /**
   * Optional executive-summary allowance (baseline: only after an approved
   * cost plan). It is used only when optional_ai approved the summary in this
   * run (effectiveAllowance), and an exhausted LLM budget makes the report
   * deterministic instead of blocking it (paidWorkOptional).
   */
  llmAllowance?: CostAllowance[] | null;
}

export function reportStage(env: PipelineEnv, opts: ReportStageOptions): EngineStage {
  return defineStage({
    name: 'report',
    version: `report_${opts.kind}@1`,
    description: `Build the ${opts.kind} report (Markdown + JSON, append-only, claim-labeled), write it to the vault, re-render entity notes, and update the dashboard.`,
    input: z.object({ kind: z.string(), period: z.object({ start: z.string(), end: z.string() }).nullable(), llmSummary: z.boolean() }),
    output: reportOutput,
    prerequisites: opts.prerequisites,
    optionalPrerequisites: opts.earlierStages.filter((s) => !opts.prerequisites.includes(s)),
    evidence: { requirement: 'Deterministic queries over SQLite; integration statuses from check_access; stage outcomes of this job.' },
    timeoutMs: 10 * 60_000,
    retry: NO_RETRY,
    costAllowance: opts.llmAllowance && opts.llmAllowance.length ? opts.llmAllowance : 'none',
    // The model summary is optional: declared only when optional_ai approved it, dropped when the LLM budget is exhausted.
    ...(opts.llmAllowance && opts.llmAllowance.length ? { paidWorkOptional: true, effectiveAllowance: (input: { llmSummary: boolean }) => (input.llmSummary ? opts.llmAllowance! : ('none' as const)) } : {}),
    stoppingConditions: ['Final reporting stage: "wait" or "repair measurement" is a valid recommendation.', 'An exhausted LLM budget never blocks the report: the optional model summary is skipped and the report stays deterministic.'],
    next: [opts.next],
    buildInput: (sctx) => {
      const plan = sctx.prior.plan_period as { period?: { start: string; end: string } } | undefined;
      const ai = sctx.prior.optional_ai as { llmSummaryApproved?: boolean } | undefined;
      return { kind: opts.kind, period: plan?.period ? { start: plan.period.start, end: plan.period.end } : null, llmSummary: !!ai?.llmSummaryApproved && !!opts.llmAllowance?.length };
    },
    run: async (input, sctx) => {
      const app = sctx.app;
      const svc = env.services(app);
      const access = sctx.prior.check_access as AccessOutput | undefined;
      const statuses = access ? (access.statuses as unknown as Parameters<typeof buildReportOfKind>[2]['statuses']) : null;
      const stageNotes = collectStageNotes(sctx, opts.earlierStages);
      const writer = svc.vault;
      const linkResolver = writer ? wikiLinkResolver({ link: (p, a) => writer.link(p, a), notePath: () => null }) : undefined;
      const siteStructure = siteStructureFromPrior(sctx.prior.site_structure);
      // The weekly site_structure summary (internal links, potential orphans, page-level AEO checks) is rendered by the report.
      const reportInput: ReportBuildInput = {
        statuses,
        jobId: sctx.jobId,
        ...(input.period ? { period: input.period } : {}),
        ...(linkResolver ? { linkResolver } : {}),
        pipeline: { workflow: sctx.workflow, jobId: sctx.jobId, stages: stageNotes },
        // The summary is requested only when approved AND this attempt holds an LLM allowance.
        ...(input.llmSummary && stageMayPay(sctx, 'llm_gateway') ? { llmSummary: { client: svc.llm, tier: 'cheap' as const } } : {}),
        ...(siteStructure ? { siteStructure } : {}),
      };
      const built = await buildReportOfKind(app, opts.kind, reportInput);
      const vault = { status: writer ? 'written' : 'disabled', created: 0, updated: 0, unchanged: 0, conflicts: 0, errors: [] as string[] };
      let vaultNote: string | null = null;
      let dashboard: string | null = null;
      if (writer) {
        if (app.dryRun) vault.status = 'dry_run';
        const count = (s: string) => {
          if (s === 'created') vault.created++;
          else if (s === 'updated') vault.updated++;
          else if (s === 'unchanged') vault.unchanged++;
          else if (s === 'conflict') vault.conflicts++;
        };
        try {
          const o = writer.writeGenerated(built.note);
          count(o.status);
          vaultNote = o.relPath;
        } catch (err) {
          vault.errors.push(`report note: ${errorMessage(err)}`);
        }
        try {
          const only = RENDER_KINDS.filter((k): k is RenderKind => k !== 'dashboard');
          const summary = renderAll(app, writer, { only, integrationStatuses: statuses ?? null, integrationStatusNote: offlineStatusNote(access) });
          vault.created += summary.counts.created;
          vault.updated += summary.counts.updated;
          vault.unchanged += summary.counts.unchanged;
          vault.conflicts += summary.counts.conflict;
          vault.errors.push(...summary.errors.slice(0, 5).map((e) => `${e.key}: ${e.error}`));
          if (summary.status === 'disabled') vault.status = 'disabled';
        } catch (err) {
          vault.errors.push(`entity notes: ${errorMessage(err)}`);
        }
        try {
          const d = writer.writeGenerated(buildDashboard(app, { statuses, statusNote: offlineStatusNote(access), ...(linkResolver ? { linkResolver } : {}) }));
          count(d.status);
          dashboard = d.relPath;
        } catch (err) {
          vault.errors.push(`dashboard: ${errorMessage(err)}`);
        }
      }
      const r = built.report;
      return {
        reportId: r.id,
        kind: r.kind,
        period: { start: r.period.start, end: r.period.end },
        persisted: !!built.stored,
        markdownFile: built.stored ? built.stored.relMarkdownPath : null,
        vaultNote,
        dashboard,
        vault,
        confidence: r.summary.confidence,
        primaryAction: r.summary.primaryAction ? `${r.summary.primaryAction.kind}: ${r.summary.primaryAction.title}` : null,
        nextAction: r.summary.nextAction,
        warnings: r.summary.warnings,
        accessIssues: r.summary.accessIssues,
        isSynthetic: r.isSynthetic,
        llmSummary: r.generator.llmSummary.status,
        issues: built.issues.length,
        stageNotes: stageNotes.map((n) => ({ stage: n.stage, status: n.status, code: n.code ?? null, detail: n.detail, nextStep: n.nextStep ?? null })),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// index_memory (shared: baseline, weekly, monthly, content queue)
// ---------------------------------------------------------------------------

export const memoryIndexOutput = z.object({
  ingest: z.object({ created: z.number(), newVersion: z.number(), unchanged: z.number(), rejected: z.number(), tombstones: z.number() }),
  index: z.object({
    status: z.string(),
    upserted: z.number(),
    cacheHits: z.number(),
    skippedPaid: z.number(),
    degraded: z.boolean(),
    degradedReason: z.string().nullable(),
    /** Full-text only BY POLICY (features.qdrant / features.embeddings off in the site config): not degraded. Absent in older checkpoints. */
    policy: z.boolean().optional(),
    policyReason: z.string().nullable().optional(),
  }),
  pendingChunks: z.number(),
  qdrantEnabled: z.boolean(),
  note: noteSchema,
});

/** Stage note code of memory that is full-text only by configuration (informational, never degraded). */
export const MEMORY_FTS_ONLY_POLICY = 'MEMORY_FTS_ONLY_POLICY';

/**
 * The index_memory stage note:
 * - Qdrant or embeddings disabled by the site configuration (e.g. the Core
 *   profile): full-text only BY POLICY. At most an informational note
 *   (status "succeeded", never listed as degraded) naming the config flags.
 * - Enabled but failing or not configured (embedding model or client missing,
 *   Qdrant down, offline): degraded MEMORY_FTS_ONLY, with the paid-embedding hint.
 * - Otherwise no note.
 */
export function memoryIndexNote(
  index: Pick<IndexRunReport, 'policy' | 'policyReason' | 'policyFlags' | 'degraded' | 'degradedReason' | 'plan'>,
  paidEmbeddingHint: string,
): StageNote {
  if (index.policy) {
    const flags = index.policyFlags?.length ? index.policyFlags : [...(index.plan.embedding.state === 'disabled' ? ['features.embeddings'] : []), ...(!index.plan.qdrant.enabled ? ['features.qdrant'] : [])];
    const off = flags.length ? flags.join(' and ') : 'features.embeddings or features.qdrant';
    return note(
      'succeeded',
      `Memory indexed for full-text search only by policy: ${off} ${flags.length > 1 ? 'are' : 'is'} off in the site configuration (not degraded)${index.policyReason ? `. ${index.policyReason}` : ''}`,
      MEMORY_FTS_ONLY_POLICY,
      `Only if you want semantic memory: set ${flags.length ? flags.map((f) => `${f}: true`).join(' and ') : 'features.embeddings: true and features.qdrant: true'} in the site config (then configure the embedding model and Qdrant).`,
    );
  }
  if (!index.degraded && index.plan.embedding.state === 'ready' && index.plan.qdrant.enabled) return null;
  // The paid-embedding hint is in the detail (pipelines build memory without an embedding client on purpose; vectors need an explicit paid run).
  return note('degraded', `Memory indexed for full-text search only${index.plan.qdrant.enabled ? '' : ' (Qdrant disabled)'}; ${paidEmbeddingHint}${index.degradedReason ? ` (${index.degradedReason})` : ''}.`, 'MEMORY_FTS_ONLY', null);
}

export interface IndexMemoryStageOptions {
  /** Degrade the workflow instead of failing it when memory indexing fails (weekly/monthly/content queue). Default false. */
  optional?: boolean;
  optionalPrerequisites?: string[];
  /** How the owner gets semantic vectors in this pipeline (stated in the FTS-only note). */
  paidEmbeddingHint?: string;
}

/**
 * Incremental memory ingestion (spec section 8): collect new and changed
 * business notes, excerpts, competitor findings, briefs, experiments,
 * decisions, rejected proposals, and learnings (deletions become tombstones)
 * and index them for SQLite full-text search; vectors only from the embedding
 * cache. It NEVER spends: `allowPaid: false` and cost allowance 'none'.
 */
export function indexMemoryStage(env: PipelineEnv, next: string, prerequisites: string[], opts: IndexMemoryStageOptions = {}): EngineStage {
  const hint = opts.paidEmbeddingHint ?? 'semantic vectors for new chunks need an explicit paid embedding run (`memory sync --allow-paid`)';
  return defineStage({
    name: 'index_memory',
    version: 'index_memory@1',
    description: 'Index selected memory (business notes, excerpts, competitor findings, experiments, decisions, learnings; deletions propagated) into SQLite full-text search; vectors only from the embedding cache (never a paid call).',
    input: z.object({}),
    output: memoryIndexOutput,
    prerequisites,
    ...(opts.optionalPrerequisites?.length ? { optionalPrerequisites: opts.optionalPrerequisites } : {}),
    evidence: { requirement: 'Vault business notes and SQLite records; secrets and raw metrics are rejected by the collectors.' },
    timeoutMs: 10 * 60_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    ...(opts.optional ? { optional: true } : {}),
    stoppingConditions: [
      'Never stops the workflow on Qdrant problems (full-text retrieval continues, recorded as degraded).',
      'Qdrant or embeddings disabled by the site configuration (features.qdrant / features.embeddings): full-text only by policy, an informational note, never degraded.',
      ...(opts.optional ? ['A failed ingestion degrades this stage only; later stages search the previous index.'] : [])],
    next: [next],
    buildInput: () => ({}),
    run: async (_input, sctx) => {
      const app = sctx.app;
      const r = await env.services(app).memory.sync({ allowPaid: false, signal: sctx.signal });
      const agg = { created: 0, newVersion: 0, unchanged: 0, rejected: 0 };
      for (const v of Object.values(r.ingest?.bySourceType ?? {})) {
        agg.created += v.created;
        agg.newVersion += v.newVersion;
        agg.unchanged += v.unchanged;
        agg.rejected += v.rejected;
      }
      return {
        ingest: { ...agg, tombstones: r.ingest?.tombstonesCreated ?? 0 },
        index: { status: r.index.status, upserted: r.index.upserted, cacheHits: r.index.cacheHits, skippedPaid: r.index.skippedPaid, degraded: r.index.degraded, degradedReason: r.index.degradedReason, policy: r.index.policy === true, policyReason: r.index.policyReason ?? null },
        pendingChunks: r.index.plan.chunks.pending,
        qdrantEnabled: r.index.plan.qdrant.enabled,
        note: memoryIndexNote(r.index, hint),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Utilities for pipeline assembly
// ---------------------------------------------------------------------------

/** Re-point a stage's next state(s) so slice-provided stages can be placed in a pipeline. */
export function withNext<S extends EngineStage>(stage: S, next: string[], patch: Partial<EngineStage> = {}): S {
  return { ...stage, ...patch, next } as S;
}

