import os from 'node:os';
import type { Command } from 'commander';
import { ownerActor, validateApproverName } from '../../approvals/approver.js';
import { AppError, ValidationError } from '../../core/errors.js';
import { CircuitBreakers, type BreakerState } from '../../jobs/circuit-breaker.js';
import { createDefaultRegistry } from '../../jobs/handlers.js';
import { DEFAULT_LOCK_NAME, getSiteLock, listSiteLocks, type LockInfo } from '../../jobs/locks.js';
import {
  defaultIsPidAlive,
  defaultProcessStartedAt,
  describeLeaseHolder,
  leaseHolderLiveness,
  releaseDeadLease,
  unrenewedLeaseSeenAt,
  type LeaseHolderLiveness,
  type ReleaseDeadLeaseResult,
} from '../../jobs/manual-lease.js';
import { JobRegistry } from '../../jobs/registry.js';
import { JobRunner, type RunJobResult } from '../../jobs/runner.js';
import { getJob, listJobRuns, listJobs, requestCancel, requireJob, resumeJobCommand, type CancelResult } from '../../jobs/store.js';
import { JOB_STATUSES, type JobRecord, type JobStatus } from '../../jobs/types.js';
import { workflowDegradedStages, workflowResultNote, type DegradedStageSummary } from '../../jobs/workflow-handler.js';
import { CheckpointStore, type CheckpointSummary } from '../../workflows/checkpoints.js';
import type { CliRuntime } from '../runtime.js';

/**
 * `jobs list | show <id> | resume [id] | cancel <id> | locks [--release <lock> --as <name>] | breakers [--reset <provider>]`.
 * Jobs, locks, and breakers are always scoped to the selected site.
 */

/**
 * How this invocation judges process liveness on this host: the defaults
 * (process table, `ps` for start times), or the host identity a test injected
 * through the runtime's lease options.
 */
function hostCheck(cli: CliRuntime): { hostname: string; isPidAlive: (pid: number) => boolean; processStartedAt?: (pid: number) => number | null } {
  const l = cli.options.lease ?? {};
  const processStartedAt = l.processStartedAt ?? (l.isPidAlive ? undefined : defaultProcessStartedAt);
  return { hostname: l.hostname ?? os.hostname(), isPidAlive: l.isPidAlive ?? defaultIsPidAlive, ...(processStartedAt ? { processStartedAt } : {}) };
}

/** A runner used only to judge liveness (`jobs list`, `show`, `cancel`): the same check everywhere. */
function livenessRunner(cli: CliRuntime, registry: JobRegistry = createDefaultRegistry()): JobRunner {
  const h = hostCheck(cli);
  return new JobRunner({ registry, hostname: h.hostname, isPidAlive: h.isPidAlive, ...(h.processStartedAt ? { processStartedAt: h.processStartedAt } : {}) });
}

interface JobListItem {
  id: string;
  type: string;
  status: JobStatus;
  mode: string;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  heartbeatAt: string | null;
  nextAttemptAt: string | null;
  finishedAt: string | null;
  error: string | null;
  appearsInterrupted: string | null;
  /** Honest summary of an incomplete workflow result (skipped/failed stages), or null. */
  note: string | null;
}

function listItem(j: JobRecord, stale: string | null): JobListItem {
  return {
    id: j.id,
    type: j.type,
    status: j.status,
    mode: j.mode,
    attempt: j.attempt,
    maxAttempts: j.maxAttempts,
    createdAt: j.createdAt,
    heartbeatAt: j.heartbeatAt,
    nextAttemptAt: j.nextAttemptAt,
    finishedAt: j.finishedAt,
    error: j.error ? `${j.error.code}: ${j.error.message}` : null,
    appearsInterrupted: stale,
    note: workflowResultNote(j.result),
  };
}

/** Status text that never shows a bare "succeeded" for a degraded workflow run. */
export function statusText(status: string, note: string | null): string {
  return status === 'succeeded' && note ? `succeeded (${note})` : status;
}

export function renderJobList(r: {
  siteId: string;
  jobs: JobListItem[];
  locks?: Array<{ lockName: string; owner: string; jobId: string | null; expiresAt: string; jobStatus?: string | null }>;
}): string {
  const lockLines = (r.locks ?? []).map(
    (l) =>
      `Lock "${l.lockName}" held by ${l.owner}${l.jobId ? ` for ${l.jobId}` : ''} (lease until ${l.expiresAt})${
        l.jobStatus && l.jobStatus !== 'running' ? ` - that job is ${l.jobStatus}; the lock is kept until work it started (a stage that ignored its abort signal) settles` : ''
      }`,
  );
  if (!r.jobs.length) return [`No jobs for site ${r.siteId}.`, ...lockLines].join('\n');
  const lines = [`Jobs for ${r.siteId} (newest first):`, ...lockLines, '', 'id                               type        status       mode      attempts  created'];
  for (const j of r.jobs) {
    lines.push(`${j.id.padEnd(32)} ${j.type.padEnd(11)} ${j.status.padEnd(12)} ${j.mode.padEnd(9)} ${`${j.attempt}/${j.maxAttempts}`.padEnd(9)} ${j.createdAt}`);
    if (j.nextAttemptAt && j.status === 'queued') lines.push(`  next attempt at ${j.nextAttemptAt}`);
    if (j.error && j.status !== 'succeeded') lines.push(`  ${j.error}`);
    if (j.note && j.status === 'succeeded') lines.push(`  NOTE: ${j.note}`);
    // The resume command names the job's --mode when it is above ANALYZE (a plain `jobs resume` refuses it).
    if (j.appearsInterrupted) lines.push(`  appears interrupted: ${j.appearsInterrupted} (run \`${resumeJobCommand(j.id, j.mode)}\`)`);
  }
  return lines.join('\n');
}

interface JobDetail {
  job: JobRecord;
  runs: ReturnType<typeof listJobRuns>;
  /** `displayStatus` (in --json output): the status the table shows (see checkpointDisplayStatus). */
  checkpoints: Array<CheckpointSummary & { displayStatus?: string }>;
  lock: ReturnType<typeof getSiteLock> | null;
  appearsInterrupted: string | null;
}

/**
 * Display status of a checkpointed stage: the checkpoint's own status, unless
 * the job result counts the stage as skipped, degraded, or offline
 * (`degradedStages`, e.g. a stage recorded as succeeded whose own output note
 * says OFFLINE): then "offline (OFFLINE)". A stage the summary reports as
 * degraded is never shown as a bare "succeeded".
 */
export function checkpointDisplayStatus(c: { stage: string; status: string }, degraded: ReadonlyMap<string, DegradedStageSummary>): string {
  const d = degraded.get(c.stage);
  if (!d || (c.status !== 'succeeded' && c.status !== d.status)) return c.status;
  return `${d.status} (${d.code})`;
}

/** The job result's degraded stages, keyed by stage (see workflowDegradedStages). */
export function degradedByStage(result: unknown): Map<string, DegradedStageSummary> {
  return new Map(workflowDegradedStages(result).map((d) => [d.stage, d]));
}

export function renderJobDetail(d: JobDetail): string {
  const j = d.job;
  const degraded = degradedByStage(j.result);
  const lines = [
    `Job ${j.id}`,
    `  site:        ${j.siteId}`,
    `  type:        ${j.type}`,
    `  status:      ${statusText(j.status, workflowResultNote(j.result))}${j.cancelRequested && j.status === 'running' ? ' (cancel requested)' : ''}`,
    `  mode:        ${j.mode}${j.dryRun ? ' (dry run)' : ''}`,
    `  attempts:    ${j.attempt} run(s), max ${j.maxAttempts} failed`,
    `  created:     ${j.createdAt}`,
    `  started:     ${j.startedAt ?? '-'}`,
    `  finished:    ${j.finishedAt ?? '-'}`,
    `  heartbeat:   ${j.heartbeatAt ?? '-'}`,
  ];
  if (j.nextAttemptAt) lines.push(`  next retry:  ${j.nextAttemptAt}`);
  if (j.error) lines.push(`  error:       ${j.error.code}: ${j.error.message}`, ...(j.error.hint ? [`  next step:   ${j.error.hint}`] : []));
  if (d.appearsInterrupted) lines.push(`  NOTE: appears interrupted (${d.appearsInterrupted}); run \`${resumeJobCommand(j.id, j.mode)}\`.`);
  if (Object.keys(j.params).length) lines.push(`  params:      ${JSON.stringify(j.params)}`);
  lines.push('', 'Runs:');
  if (!d.runs.length) lines.push('  (none)');
  for (const r of d.runs) lines.push(`  #${r.attempt} ${r.status.padEnd(11)} pid ${r.pid ?? '-'} on ${r.hostname ?? '-'} ${r.startedAt} -> ${r.finishedAt ?? '...'}${r.error ? `  ${r.error.code}: ${r.error.message}` : ''}`);
  lines.push('', 'Checkpoints (stage results):');
  if (!d.checkpoints.length) lines.push('  (none)');
  for (const c of d.checkpoints) {
    lines.push(`  ${c.stage.padEnd(24)} ${checkpointDisplayStatus(c, degraded).padEnd(10)} v${c.stageVersion} attempt ${c.attempt}${c.durationMs !== null ? ` ${c.durationMs}ms` : ''}${c.error ? `  ${c.error.code}: ${c.error.message}` : ''}`);
  }
  if (j.result && typeof j.result === 'object') lines.push('', `Result: ${JSON.stringify(j.result)}`);
  return lines.join('\n');
}

export function describeRun(r: RunJobResult): string {
  const base = `${r.job.id} (${r.job.type}): ${r.outcome === 'succeeded' ? statusText('succeeded', workflowResultNote(r.job.result)) : r.outcome}`;
  switch (r.outcome) {
    case 'failed':
    case 'interrupted':
      return `${base} - ${r.error.code}: ${r.error.message}${r.error.hint ? `\n  next step: ${r.error.hint}` : ''}`;
    case 'retry_scheduled':
      return `${base} - ${r.error.code}: ${r.error.message}; next attempt at ${r.nextAttemptAt}`;
    case 'locked':
      return `${base} - site lock held by ${r.heldBy.owner} (job ${r.heldBy.jobId ?? '-'}, lease until ${r.heldBy.expiresAt})`;
    case 'not_runnable':
      return `${base} - ${r.reason}`;
    case 'waiting':
      return `${base} - ${r.reason}`;
    default:
      return base;
  }
}

function parseStatuses(v: string | undefined): JobStatus[] | undefined {
  if (!v) return undefined;
  const out = v.split(',').map((s) => s.trim()).filter(Boolean);
  for (const s of out) if (!(JOB_STATUSES as readonly string[]).includes(s)) throw new ValidationError(`Unknown job status "${s}" (use ${JOB_STATUSES.join(', ')})`);
  return out as JobStatus[];
}

/**
 * Audit actor for `jobs resume`. With --reviewed, --reviewer is required and
 * must be a human name (validateApproverName refuses automation names such as
 * cli, system, scheduler, model, or agent); it is recorded as owner:<name>.
 * Without --reviewed the actor is the reviewer when given (validated the same
 * way), else "cli".
 */
export function reviewActor(opts: { reviewed?: string; reviewer?: string }): string {
  if (opts.reviewed !== undefined && (opts.reviewer === undefined || opts.reviewer.trim() === '')) {
    throw new AppError('VALIDATION_FAILED', '--reviewed records a human review: pass --reviewer "<your name>" as well. Nothing was changed.', {
      hint: 'Example: `npm run cli -- jobs resume <job-id> --reviewed <stage> --reviewer "Jane Doe"`. Automation names (cli, system, scheduler, model, agent) are refused.',
    });
  }
  if (opts.reviewer === undefined) return 'cli';
  return ownerActor(validateApproverName(opts.reviewer));
}

export interface BreakerView extends BreakerState {
  /** True while the breaker refuses requests (open, or half-open with a probe in flight). */
  refusing: boolean;
  /** Whether the next request would be allowed now (as the half-open probe when not closed). */
  probeAllowedNow: boolean;
}

export interface BreakersReport {
  siteId: string;
  at: string;
  failureThreshold: number;
  cooldownMs: number;
  breakers: BreakerView[];
  /** Present after `--reset <provider>` (or its dry run). */
  reset?: { provider: string; dryRun: boolean; previous: BreakerState };
}

/** Read-only view of the site's persisted circuit breakers (open and half-open ones first). */
export function breakersReport(b: CircuitBreakers, siteId: string, at: Date): BreakersReport {
  const rank = (s: BreakerState) => (s.state === 'open' ? 0 : s.state === 'half_open' ? 1 : 2);
  const breakers = b
    .list()
    .map((st): BreakerView => {
      const d = b.peek(st.provider);
      return { ...st, refusing: !d.allowed, probeAllowedNow: d.allowed && st.state !== 'closed' };
    })
    .sort((x, y) => rank(x) - rank(y) || x.provider.localeCompare(y.provider));
  const policy = b.policy('__default__');
  return { siteId, at: at.toISOString(), failureThreshold: policy.failureThreshold, cooldownMs: policy.cooldownMs, breakers };
}

export function renderBreakers(r: BreakersReport): string {
  const lines: string[] = [];
  if (r.reset) {
    const p = r.reset.previous;
    lines.push(
      r.reset.dryRun
        ? `Dry run: would reset the ${r.reset.provider} circuit breaker (now ${p.state}, ${p.consecutiveFailures} consecutive failure(s)); nothing was changed.`
        : `Reset the ${r.reset.provider} circuit breaker (was ${p.state}, ${p.consecutiveFailures} consecutive failure(s)); recorded in the audit log. The next run contacts the provider again.`,
      '',
    );
  }
  if (!r.breakers.length) {
    lines.push(`No circuit breaker state is recorded for site ${r.siteId}: every provider is closed (requests allowed).`);
    return lines.join('\n');
  }
  lines.push(`Circuit breakers for ${r.siteId} at ${r.at} (open after ${r.failureThreshold} consecutive provider failures by default, ${Math.round(r.cooldownMs / 60_000)} min cooldown):`);
  for (const b of r.breakers) {
    const state = b.state === 'open' ? 'OPEN' : b.state === 'half_open' ? 'HALF-OPEN' : 'closed';
    const when =
      b.state === 'closed'
        ? `requests allowed; ${b.consecutiveFailures} consecutive failure(s) so far`
        : b.probeAllowedNow
          ? `cooldown over: the next request is the probe (success closes it, failure re-opens it); ${b.consecutiveFailures} consecutive failure(s)`
          : `${b.state === 'open' ? 'refusing requests' : 'a probe request is in flight'}; next probe after ${b.nextProbeAt ?? 'unknown'}; ${b.consecutiveFailures} consecutive failure(s)${b.openedAt ? `, opened ${b.openedAt}` : ''}`;
    lines.push(`  ${b.provider.padEnd(14)} ${state.padEnd(10)} ${when}`);
    if (b.lastError) lines.push(`    last error: ${b.lastError}`);
  }
  const refusing = r.breakers.filter((b) => b.state !== 'closed');
  lines.push(
    '',
    refusing.length
      ? `${refusing.length} breaker(s) not closed. Stages that use these providers are skipped (optional) or retried after the next probe (required). Once the cause is fixed, close one with: npm run cli -- jobs breakers --reset <provider>`
      : 'No breaker is open or half-open.',
  );
  return lines.join('\n');
}

export function renderCancel(x: CancelResult): string {
  if (x.outcome === 'cancelled') {
    return x.interruptedBecause
      ? `Cancelled ${x.jobId}: it was recorded as running, but ${x.interruptedBecause}, so it was marked interrupted and then cancelled (its site lock was released).`
      : `Cancelled ${x.jobId} (was ${x.previousStatus}).`;
  }
  if (x.outcome === 'cancel_requested') return `Cancellation requested for running job ${x.jobId}. ${x.note}`;
  return `Job ${x.jobId} already ${x.previousStatus}; nothing to cancel.`;
}

/**
 * Audit actor for `jobs locks --release`: --as is required and must be a
 * human name (validateApproverName refuses automation names); recorded as
 * owner:<name>. Null when nothing is released.
 */
export function releaseActor(opts: { release?: string; as?: string }): string | null {
  if (opts.release === undefined) {
    if (opts.as !== undefined) throw new AppError('VALIDATION_FAILED', '--as names who releases a lease: use it with --release <lock>. Nothing was changed.');
    return null;
  }
  if (opts.as === undefined || opts.as.trim() === '') {
    throw new AppError('VALIDATION_FAILED', 'Releasing a lease is a human decision: pass --as "<your name>" as well. Nothing was changed.', {
      hint: 'Example: `npm run cli -- jobs locks --release site --as "Jane Doe"`. Automation names (cli, system, scheduler, model, agent) are refused.',
    });
  }
  return ownerActor(validateApproverName(opts.as));
}

export interface LockView extends LockInfo {
  /** job <id>, manual command "<command>", or the owner string. */
  holder: string;
  expired: boolean;
  /** Status of the lease's job, or null for a manual-command lease. */
  jobStatus: string | null;
  /** Runtime mode of the lease's job (its resume command needs it above ANALYZE), or null for a manual-command lease. */
  jobMode: string | null;
  liveness: LeaseHolderLiveness;
  /** When a contender first saw this manual lease expired while its process was alive (it is treated as hung a few heartbeats later), or null. */
  unrenewedSeenAt: string | null;
}

export interface LocksReport {
  siteId: string;
  at: string;
  locks: LockView[];
  /** Present after `--release` (or its dry run). */
  release?: { lockName: string; dryRun: boolean; by: string; outcome: 'released' | 'would_release'; holder: string; previous: LockInfo; detail: string };
}

function lockViews(db: Parameters<typeof listSiteLocks>[0], siteId: string, check: Parameters<typeof leaseHolderLiveness>[3] & { now: Date }): LockView[] {
  return listSiteLocks(db, siteId).map((l) => {
    const seen = l.jobId ? null : unrenewedLeaseSeenAt(db, siteId, l);
    const job = l.jobId ? getJob(db, siteId, l.jobId) : undefined;
    return {
      ...l,
      holder: describeLeaseHolder(l),
      expired: Date.parse(l.expiresAt) <= check.now.getTime(),
      jobStatus: job?.status ?? null,
      jobMode: job?.mode ?? null,
      liveness: leaseHolderLiveness(db, siteId, l, check),
      unrenewedSeenAt: seen !== null ? new Date(seen).toISOString() : null,
    };
  });
}

function releaseRefusal(r: ReleaseDeadLeaseResult, siteId: string, held: LockInfo[]): AppError {
  const nothing = ' Nothing was changed.';
  switch (r.outcome) {
    case 'not_found':
      return new AppError('NOT_FOUND', `${r.detail}${nothing}`, { hint: held.length ? `Held locks: ${held.map((l) => `${l.lockName} (${describeLeaseHolder(l)})`).join(', ')}.` : `No lock is held for site ${siteId}.` });
    case 'job_running':
      return new AppError('CONFLICT', `${r.detail} A job's lease is not released by hand.${nothing}`, {
        hint: `Use \`npm run cli -- jobs cancel ${r.lock?.jobId}\` (a job whose process on this machine is gone is marked interrupted and cancelled, and its lease is released) or \`jobs resume ${r.lock?.jobId}\`.`,
      });
    case 'holder_alive':
      return new AppError('LOCKED', `Not releasing the "${r.lockName}" lease: ${r.detail}${nothing}`, {
        hint: `Wait for it to finish. If that process is hung, stop it${r.liveness?.pid !== null && r.liveness?.pid !== undefined ? ` (process ${r.liveness.pid})` : ''}, then run this again.`,
      });
    default:
      return new AppError('POLICY_DENIED', `Not releasing the "${r.lockName}" lease: ${r.detail}${nothing}`, {
        hint: 'A lease from another machine is taken over automatically once it expires (90 s after its last heartbeat); run `jobs locks` on the machine that holds it to check its process.',
      });
  }
}

export function renderLocks(r: LocksReport): string {
  const lines: string[] = [];
  if (r.release) {
    lines.push(
      r.release.outcome === 'would_release'
        ? `Dry run: would release the "${r.release.lockName}" lease of ${r.release.holder} (${r.release.detail}); nothing was changed.`
        : `Released the "${r.release.lockName}" lease of ${r.release.holder} (${r.release.detail}); recorded in the audit log as ${r.release.by}.`,
      '',
    );
  }
  if (!r.locks.length) {
    lines.push(`No locks are held for site ${r.siteId}.`);
    return lines.join('\n');
  }
  lines.push(`Locks of site ${r.siteId} at ${r.at}:`);
  for (const l of r.locks) {
    lines.push(`  ${l.lockName.padEnd(8)} ${l.holder}${l.jobStatus ? ` (job ${l.jobStatus})` : ''}; owner ${l.owner}`);
    lines.push(`           heartbeat ${l.heartbeatAt}, lease ${l.expired ? 'EXPIRED' : 'until'} ${l.expiresAt}`);
    const state = l.liveness.state === 'alive' ? 'ALIVE' : l.liveness.state === 'dead' ? 'GONE' : 'UNVERIFIED';
    lines.push(`           holder process: ${state}: ${l.liveness.detail}`);
    if (l.unrenewedSeenAt) lines.push(`           seen expired and unrenewed since ${l.unrenewedSeenAt}; treated as hung a few heartbeats after that`);
    if (l.liveness.state === 'dead' && !(l.jobId && l.jobStatus === 'running')) lines.push(`           release it with: npm run cli -- jobs locks --release ${l.lockName} --as "<your name>"`);
    if (l.jobId && l.jobStatus === 'running' && l.liveness.state === 'dead') lines.push(`           the job's process is gone: run \`jobs cancel ${l.jobId}\` or \`${resumeJobCommand(l.jobId, l.jobMode ?? 'ANALYZE')}\``);
  }
  return lines.join('\n');
}

/** AbortController wired to SIGINT/SIGTERM for foreground work; returns a disposer. */
export function signalController(): { signal: AbortSignal; dispose: () => void } {
  const ctl = new AbortController();
  const onSignal = (sig: NodeJS.Signals) => ctl.abort(Object.assign(new Error(`Received ${sig}; stopping`), { code: 'INTERRUPTED' }));
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return {
    signal: ctl.signal,
    dispose: () => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    },
  };
}

export function register(program: Command, cli: CliRuntime): void {
  const jobs = program.command('jobs').description('Durable jobs: list, inspect, resume after interruption, and cancel; site locks');

  jobs
    .command('list')
    .description('List jobs for the site (newest first)')
    .option('--status <statuses>', `filter by status, comma-separated (${JOB_STATUSES.join(', ')})`)
    .option('--type <type>', 'filter by job type')
    .option('--limit <n>', 'maximum number of jobs', '20')
    .action(
      cli.action(async (opts: { status?: string; type?: string; limit: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const limit = Number(opts.limit);
          if (!Number.isInteger(limit) || limit < 1) throw new ValidationError('--limit must be a positive integer');
          const statuses = parseStatuses(opts.status);
          const runner = livenessRunner(cli);
          const list = listJobs(ctx.db, ctx.siteId, { ...(statuses ? { status: statuses } : {}), ...(opts.type ? { type: opts.type } : {}), limit });
          const locks = listSiteLocks(ctx.db, ctx.siteId).map((l) => ({ ...l, jobStatus: l.jobId ? (getJob(ctx.db, ctx.siteId, l.jobId)?.status ?? null) : null }));
          const result = { siteId: ctx.siteId, jobs: list.map((j) => listItem(j, runner.staleReason(ctx, j))), locks };
          cli.print(g, result, renderJobList);
        } finally {
          ctx.db.close();
        }
      }),
    );

  jobs
    .command('show <id>')
    .description('Show a job with its runs (pid, host) and checkpointed stage results')
    .action(
      cli.action(async (id: string, _opts: unknown, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const job = requireJob(ctx.db, ctx.siteId, id);
          const runner = livenessRunner(cli);
          const locks = listSiteLocks(ctx.db, ctx.siteId).filter((l) => l.jobId === id);
          const degraded = degradedByStage(job.result);
          const detail: JobDetail = {
            job,
            runs: listJobRuns(ctx.db, ctx.siteId, id),
            checkpoints: new CheckpointStore(ctx.db, ctx.clock).list(ctx.siteId, id).map((c) => ({ ...c, displayStatus: checkpointDisplayStatus(c, degraded) })),
            lock: locks[0] ?? null,
            appearsInterrupted: runner.staleReason(ctx, job),
          };
          cli.print(g, detail, renderJobDetail);
        } finally {
          ctx.db.close();
        }
      }),
    );

  jobs
    .command('resume [id]')
    .description('Recover interrupted jobs and continue them from their last successful checkpoint (all interrupted jobs and due retries when no id is given)')
    .option(
      '--rerun-paid-stages',
      'with a job id: explicitly rerun paid stages that were interrupted mid-flight. Only after reconciling them (`costs --unresolved`, provider history): the provider may already have charged the earlier request',
    )
    .option('--reviewed <stage>', 'with a job id and --reviewer: record (audited) that you reviewed the output of the stage the job is waiting on, and continue past it')
    .option('--reviewer <name>', 'the human who reviewed (required with --reviewed; recorded as owner:<name>; automation names such as cli, system, or scheduler are refused)')
    .action(
      cli.action(async (id: string | undefined, resumeOpts: { rerunPaidStages?: boolean; reviewed?: string; reviewer?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        // A recorded review is a human decision (spec 24): it needs an explicit, validated human name,
        // never the default automation actor. Validated before anything is opened or changed.
        const actor = reviewActor(resumeOpts);
        const ctx = cli.context(g);
        const registry = createDefaultRegistry();
        // The invoking --mode is the ceiling: a RESEARCH/DRAFT job needs an explicit --mode to be resumed.
        const runner = new JobRunner({ registry, maxMode: ctx.mode });
        try {
          if (ctx.dryRun) {
            const candidates = id
              ? [requireJob(ctx.db, ctx.siteId, id)]
              : listJobs(ctx.db, ctx.siteId, { status: ['interrupted', 'queued', 'running'], limit: 200 }).filter((j) => j.status !== 'running' || runner.staleReason(ctx, j));
            const plan = {
              dryRun: true,
              siteId: ctx.siteId,
              ...(resumeOpts.reviewed ? { wouldRecordReview: { stage: resumeOpts.reviewed, reviewer: actor } } : {}),
              wouldResume: candidates.map((j) => ({ ...listItem(j, runner.staleReason(ctx, j)), handlerRegistered: registry.has(j.type) })),
            };
            cli.print(g, plan, (p: typeof plan) =>
              [
                ...(p.wouldRecordReview ? [`Dry run: would record a review of stage "${p.wouldRecordReview.stage}" by ${p.wouldRecordReview.reviewer}.`] : []),
                p.wouldResume.length
                  ? [`Dry run: would resume ${p.wouldResume.length} job(s):`, ...p.wouldResume.map((j) => `  ${j.id} ${j.type} ${j.status}${j.handlerRegistered ? '' : ' (no handler registered in this build)'}`)].join('\n')
                  : 'Dry run: nothing to resume.',
              ].join('\n'),
            );
            return;
          }
          const sig = signalController();
          try {
            const r = await runner.resume(ctx, id, {
              signal: sig.signal,
              actor,
              ...(resumeOpts.rerunPaidStages ? { rerunAmbiguousPaidStages: true } : {}),
              ...(resumeOpts.reviewed ? { reviewedStage: resumeOpts.reviewed } : {}),
            });
            const out = {
              siteId: ctx.siteId,
              recovered: r.recovered,
              ...(r.review ? { review: r.review } : {}),
              results: r.results.map((x) => ({ jobId: x.job.id, type: x.job.type, outcome: x.outcome, status: x.job.status, note: workflowResultNote(x.job.result), detail: describeRun(x) })),
            };
            cli.print(g, out, (o: typeof out) => {
              const lines: string[] = [];
              if (o.review) lines.push(`Recorded review of stage "${o.review.stage}" (checkpoint ${o.review.checkpointId}) by ${o.review.reviewer}.`);
              for (const rec of o.recovered) lines.push(`Marked ${rec.jobId} (${rec.type}) interrupted: ${rec.reason}`);
              if (!o.results.length) lines.push('Nothing to resume.');
              for (const x of o.results) lines.push(x.detail);
              return lines.join('\n');
            });
            if (r.results.some((x) => x.outcome === 'failed' || x.outcome === 'interrupted' || x.outcome === 'locked' || x.outcome === 'not_runnable')) process.exitCode = 1;
            if (runner.pendingLockHolds) {
              cli.io.err('A stage ignored its abort signal and is still running; keeping the site lock until it settles (no other job of this site can start meanwhile).');
              await runner.settled();
            }
          } finally {
            sig.dispose();
          }
        } finally {
          ctx.db.close();
        }
      }),
    );

  jobs
    .command('cancel <id>')
    .description('Cancel a job: immediately when not running; a running job stops at its next cooperative check, and a running job whose process on this machine is gone is marked interrupted and cancelled at once')
    .action(
      cli.action(async (id: string, _opts: unknown, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          // The same liveness check `jobs list` uses: a crashed run never reaches a cooperative check.
          const runner = livenessRunner(cli);
          const holder = (j: JobRecord) => runner.runningJobHolder(ctx, j);
          if (ctx.dryRun) {
            const job = requireJob(ctx.db, ctx.siteId, id);
            const h = job.status === 'running' ? holder(job) : null;
            const would =
              job.status === 'running'
                ? h?.state === 'gone'
                  ? `mark it interrupted and cancel it immediately (${h.reason}), releasing its lock`
                  : h?.state === 'stale'
                    ? `request cancellation; its run appears interrupted (${h.reason}), so \`jobs resume ${id}\` would then close it as cancelled`
                    : 'request cancellation (running job stops at its next check)'
                : ['succeeded', 'failed', 'cancelled'].includes(job.status)
                  ? `nothing (already ${job.status})`
                  : 'cancel immediately';
            cli.print(g, { dryRun: true, jobId: id, status: job.status, would }, (r: { would: string }) => `Dry run: would ${r.would}.`);
            return;
          }
          const r: CancelResult = requestCancel(ctx, id, 'cli', { holder });
          cli.print(g, r, renderCancel);
        } finally {
          ctx.db.close();
        }
      }),
    );

  jobs
    .command('locks')
    .description('Show the site\'s locks (job and manual-command leases) and whether each holder process is alive; --release <lock> --as <name> removes a lease whose holder is verified dead (audited)')
    .option('--release <lock>', 'lock to release (site or content); only when its holder process is verified dead on this machine (no such process, or its pid now belongs to another process)')
    .option('--as <name>', 'the human releasing the lease (required with --release; recorded as owner:<name>; automation names such as cli, system, or scheduler are refused)')
    .action(
      cli.action(async (opts: { release?: string; as?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        // A release is a human decision: validated before anything is opened or changed.
        const actor = releaseActor(opts);
        const ctx = cli.context(g);
        try {
          const check = { ...hostCheck(cli), now: ctx.clock.now() };
          let release: LocksReport['release'];
          if (opts.release !== undefined) {
            const requested = opts.release.trim();
            // `--release <site id>` means that site's "site" lock.
            const lockName = requested === ctx.siteId && !getSiteLock(ctx.db, ctx.siteId, requested) ? DEFAULT_LOCK_NAME : requested;
            const r = releaseDeadLease(ctx.db, ctx.siteId, lockName, check, actor!, { dryRun: ctx.dryRun });
            if (r.outcome !== 'released' && r.outcome !== 'would_release') throw releaseRefusal(r, ctx.siteId, listSiteLocks(ctx.db, ctx.siteId));
            release = { lockName, dryRun: ctx.dryRun, by: actor!, outcome: r.outcome, holder: r.lock ? describeLeaseHolder(r.lock) : lockName, previous: r.lock!, detail: r.detail };
          }
          const report: LocksReport = { siteId: ctx.siteId, at: check.now.toISOString(), locks: lockViews(ctx.db, ctx.siteId, check), ...(release ? { release } : {}) };
          cli.print(g, report, renderLocks);
        } finally {
          ctx.db.close();
        }
      }),
    );

  jobs
    .command('breakers')
    .description('Show the persisted circuit breakers of the site (open and half-open first, with the next probe time and last error); --reset <provider> closes one (audited)')
    .option('--reset <provider>', 'forget the breaker state of this provider (e.g. google, crawler) after fixing the cause; recorded in the audit log')
    .action(
      cli.action(async (opts: { reset?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const b = new CircuitBreakers(ctx.db, ctx.siteId, ctx.clock);
          let reset: BreakersReport['reset'];
          if (opts.reset !== undefined) {
            const provider = opts.reset.trim();
            const recorded = b.list();
            const previous = recorded.find((x) => x.provider === provider);
            if (!previous) {
              throw new AppError('NOT_FOUND', `No circuit breaker state is recorded for provider "${provider}" on site ${ctx.siteId}; nothing was changed.`, {
                hint: recorded.length ? `Recorded providers: ${recorded.map((x) => `${x.provider} (${x.state})`).join(', ')}.` : 'No breaker state is recorded for this site: every provider is closed.',
              });
            }
            if (!ctx.dryRun) b.reset(provider, 'cli');
            reset = { provider, dryRun: ctx.dryRun, previous };
          }
          const report = breakersReport(b, ctx.siteId, ctx.clock.now());
          cli.print(g, reset ? { ...report, reset } : report, renderBreakers);
        } finally {
          ctx.db.close();
        }
      }),
    );
}
