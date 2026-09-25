import os from 'node:os';
import type { AppContext } from '../app/context.js';
import { sleep as defaultSleep } from '../core/concurrency.js';
import { AppError } from '../core/errors.js';
import { ulid } from '../core/ids.js';
import { modeAtLeast, type RuntimeMode } from '../core/modes.js';
import { backoffDelay, type RetryPolicy } from '../core/retry.js';
import { recordAudit } from '../database/audit.js';
import { redact } from '../security/redact.js';
import { cancelledError, errorCodeOf, isRetryableError, toErrorInfo, type ErrorInfo } from '../workflows/errors.js';
import { CircuitBreakers, type CircuitBreakerOptions } from './circuit-breaker.js';
import { DEFAULT_LOCK_NAME, acquireSiteLock, getSiteLock, releaseSiteLock, renewSiteLock, type LockInfo } from './locks.js';
import { defaultProcessStartedAt, describeLeaseHolder, leaseHolderAliveReason, noteUnrenewedLease, type LeaseHolderCheck } from './manual-lease.js';
import type { JobRegistry } from './registry.js';
import { closeUnstartedJob, consecutiveInterruptedRuns, enqueue, failedRunCount, getJob, listJobRuns, requireJob, resumeJobCommand, toJobRecord, type EnqueueOptions, type RunningJobHolder } from './store.js';
import { recordStageReview, type StageReviewRecord } from '../workflows/reviews.js';
import type { JobHandlerContext, JobOutcome, JobRecord, JobRow, JobStatus } from './types.js';

export { closeUnstartedJob, enqueue, getJob, listJobs, listJobRuns, requestCancel, requireJob, resumeJobCommand, type EnqueueOptions, type CancelResult, type CancelOptions, type RunningJobHolder } from './store.js';

/**
 * Durable job runner.
 *
 * - Non-overlapping per-site runs: a job runs only while its runner holds the
 *   site lock (lease renewed by heartbeats; expired leases may be taken over).
 * - Every run attempt is a `job_runs` row with pid and hostname.
 * - Retry with exponential backoff up to `max_attempts` FAILED runs, only for
 *   failures reported as retryable (paid work is never blindly retried).
 * - Cancellation: `cancel_requested` is polled and checked on heartbeats; the
 *   handler's AbortSignal fires with a CANCELLED error.
 * - Crash recovery: `running` jobs whose process on this host is gone, or
 *   (on another host) whose heartbeat went stale, become `interrupted`. A job
 *   whose process is alive on this host is not declared stale on heartbeat
 *   age alone (a laptop that just woke up has not heartbeated yet) until
 *   `localStaleAfterMs`. `resume` continues interrupted jobs, and workflow
 *   handlers reuse their checkpoints. The scheduler's drain resumes
 *   interrupted SCHEDULED jobs automatically, up to a cap of consecutive
 *   interruptions.
 * - Every write that ends a run (and every heartbeat) is guarded by the run's
 *   lock owner and attempt, so a slow run that was declared stale and taken
 *   over can never overwrite the newer run's result.
 * - Work that outlives the handler (a stage that ignored its abort signal)
 *   keeps the site lock held until it settles.
 * - Result and error JSON are redacted before storage.
 */

export const DEFAULT_JOB_BACKOFF: RetryPolicy = { maxAttempts: 3, baseDelayMs: 60_000, maxDelayMs: 30 * 60_000, jitter: 0.2 };
/** A job whose process is alive on this host is treated as hung only after this long without a heartbeat. */
export const DEFAULT_LOCAL_STALE_AFTER_MS = 6 * 3_600_000;
/** Automatic resumption stops after this many consecutive interrupted runs of one job. */
export const DEFAULT_MAX_AUTO_RESUMES = 3;

export interface AutoResumePolicy {
  /** Stop resuming automatically once the job has this many consecutive interrupted runs. */
  maxConsecutiveInterruptions: number;
  /**
   * Only jobs enqueued by the scheduler (params.trigger = 'schedule'). A job a
   * human interrupted in the foreground (Ctrl+C) is left for them. Default true.
   */
  scheduledOnly: boolean;
}

export const DEFAULT_AUTO_RESUME: AutoResumePolicy = { maxConsecutiveInterruptions: DEFAULT_MAX_AUTO_RESUMES, scheduledOnly: true };

export type AutoResumeDecision = { eligible: true; interruptions: number } | { eligible: false; reason: string; interruptions: number };

/** Whether an interrupted job may be resumed without a human (scheduler drain). */
export function autoResumeDecision(db: AppContext['db'], job: JobRecord, policy: AutoResumePolicy = DEFAULT_AUTO_RESUME): AutoResumeDecision {
  const interruptions = consecutiveInterruptedRuns(db, job.siteId, job.id);
  if (job.status !== 'interrupted') return { eligible: false, reason: `status is ${job.status}`, interruptions };
  if (job.cancelRequested) return { eligible: false, reason: 'cancellation was requested', interruptions };
  if (policy.scheduledOnly && job.params.trigger !== 'schedule') {
    return { eligible: false, reason: `it was not started by the scheduler; resume it with \`${resumeJobCommand(job.id, job.mode)}\` or cancel it with \`jobs cancel ${job.id}\``, interruptions };
  }
  if (interruptions >= policy.maxConsecutiveInterruptions) {
    return {
      eligible: false,
      reason: `it was interrupted ${interruptions} times in a row (automatic resume stops at ${policy.maxConsecutiveInterruptions}); check \`jobs show ${job.id}\`, then run \`${resumeJobCommand(job.id, job.mode)}\` or \`jobs cancel ${job.id}\``,
      interruptions,
    };
  }
  return { eligible: true, interruptions };
}

export interface JobRunnerOptions {
  registry: JobRegistry;
  /** Lock owner identity; default `<hostname>:<pid>:<random>`. */
  owner?: string;
  hostname?: string;
  pid?: number;
  /** Lock lease length. Default 90 s. */
  leaseMs?: number;
  /** Heartbeat interval (lease renewal + job heartbeat). Default 15 s. */
  heartbeatMs?: number;
  /** How often a running job checks `cancel_requested`. Default 1 s. */
  cancelPollMs?: number;
  /** A running job on ANOTHER host whose heartbeat is older than this is considered interrupted. Default = leaseMs. */
  staleAfterMs?: number;
  /**
   * A running job whose process is alive on THIS host is considered hung (and
   * interrupted) only after its heartbeat is older than this, and its expired
   * lock is not taken over before then. Default 6 h.
   */
  localStaleAfterMs?: number;
  /** Backoff between failed attempts of a job. */
  backoff?: RetryPolicy;
  breakers?: CircuitBreakerOptions;
  /** Highest job mode this runner executes (the unattended scheduler uses RESEARCH). Default EXECUTE. */
  maxMode?: RuntimeMode;
  isPidAlive?: (pid: number) => boolean;
  /**
   * Start time of the process that has a pid on this host, used to tell a
   * manual lease holder from a process that reused its pid (see
   * src/jobs/manual-lease.ts). Default: read with `ps`, unless `isPidAlive` is
   * injected (tests), in which case only the pid is checked.
   */
  processStartedAt?: (pid: number) => number | null;
  /** A live local manual-lease holder is treated as hung this long after a contender first saw its lease expired. Default MANUAL_LOCAL_STALE_AFTER_MS. */
  unrenewedAfterMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  rand?: () => number;
}

export type RunJobResult =
  | { outcome: 'succeeded'; job: JobRecord }
  | { outcome: 'waiting'; job: JobRecord; reason: string }
  | { outcome: 'failed'; job: JobRecord; error: ErrorInfo }
  | { outcome: 'retry_scheduled'; job: JobRecord; error: ErrorInfo; nextAttemptAt: string }
  | { outcome: 'cancelled'; job: JobRecord }
  | { outcome: 'interrupted'; job: JobRecord; error: ErrorInfo }
  | { outcome: 'locked'; job: JobRecord; heldBy: LockInfo }
  | { outcome: 'not_runnable'; job: JobRecord; reason: string };

export interface RunJobOptions {
  /** External abort (e.g. daemon shutdown): the job becomes `interrupted` and can be resumed. */
  signal?: AbortSignal;
  /** Wait out the backoff and retry in-process instead of leaving the retry queued. */
  retryInline?: boolean;
  /** Allow running a `failed` job (explicit `jobs resume <id>`). */
  allowFailed?: boolean;
  /** Ignore `next_attempt_at` (explicit resume). */
  ignoreSchedule?: boolean;
  /** Explicit human decision to rerun paid workflow stages that were interrupted mid-flight. */
  rerunAmbiguousPaidStages?: boolean;
}

export interface NeedsAttention {
  jobId: string;
  type: string;
  status: JobStatus;
  reason: string;
}

export interface RecoveredJob {
  jobId: string;
  type: string;
  reason: string;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function interruptedError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'INTERRUPTED' });
}

function safeJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(redact(value));
  } catch {
    return JSON.stringify({ note: 'result was not JSON-serializable' });
  }
}

export class JobRunner {
  readonly owner: string;
  readonly hostname: string;
  readonly pid: number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly cancelPollMs: number;
  private readonly staleAfterMs: number;
  private readonly localStaleAfterMs: number;
  private readonly backoff: RetryPolicy;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly processStartedAt: ((pid: number) => number | null) | undefined;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly active = new Set<string>();
  /** Locks kept after a run because work it started (an orphaned stage) is still running. */
  private readonly holds = new Set<Promise<void>>();
  /** Job ids whose finished run still holds the lock for orphaned work (a new run of the job must not re-enter it). */
  private readonly heldJobs = new Set<string>();

  constructor(private readonly opts: JobRunnerOptions) {
    this.hostname = opts.hostname ?? os.hostname();
    this.pid = opts.pid ?? process.pid;
    this.owner = opts.owner ?? `${this.hostname}:${this.pid}:${ulid().slice(-8)}`;
    this.leaseMs = opts.leaseMs ?? 90_000;
    this.heartbeatMs = opts.heartbeatMs ?? 15_000;
    this.cancelPollMs = opts.cancelPollMs ?? 1_000;
    this.staleAfterMs = opts.staleAfterMs ?? this.leaseMs;
    this.localStaleAfterMs = Math.max(opts.localStaleAfterMs ?? DEFAULT_LOCAL_STALE_AFTER_MS, this.staleAfterMs);
    this.backoff = opts.backoff ?? DEFAULT_JOB_BACKOFF;
    this.isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
    this.processStartedAt = opts.processStartedAt ?? (opts.isPidAlive ? undefined : defaultProcessStartedAt);
    this.sleep = opts.sleep ?? defaultSleep;
    if (this.heartbeatMs >= this.leaseMs) throw new RangeError('heartbeatMs must be shorter than leaseMs');
  }

  get registry(): JobRegistry {
    return this.opts.registry;
  }

  /** Number of site locks this runner still holds for orphaned work of finished runs. */
  get pendingLockHolds(): number {
    return this.holds.size;
  }

  /** Resolves when every lock held for orphaned work has been released. */
  async settled(): Promise<void> {
    while (this.holds.size) await Promise.all([...this.holds]);
  }

  /** Run one job (and, with retryInline, its retries) to a stable status. */
  async runJob(ctx: AppContext, jobId: string, opts: RunJobOptions = {}): Promise<RunJobResult> {
    let first = true;
    for (;;) {
      const r = await this.runOnce(ctx, jobId, first ? opts : { ...opts, ignoreSchedule: true });
      first = false;
      if (r.outcome !== 'retry_scheduled' || !opts.retryInline) return r;
      const delay = Math.max(0, Date.parse(r.nextAttemptAt) - ctx.clock.now().getTime());
      ctx.logger.info(`Job ${jobId} failed (${r.error.code}); retrying in ${Math.round(delay / 1000)}s`, { attempt: r.job.attempt });
      try {
        await this.sleep(delay, opts.signal);
      } catch {
        return r;
      }
    }
  }

  private async runOnce(ctx: AppContext, jobId: string, opts: RunJobOptions): Promise<RunJobResult> {
    const db = ctx.db;
    let job = requireJob(db, ctx.siteId, jobId);
    const now = ctx.clock.now();

    if (job.status === 'running') {
      const reason = this.staleReason(ctx, job, now);
      if (!reason) return { outcome: 'not_runnable', job, reason: `already running (owner ${job.lockOwner ?? 'unknown'}, last heartbeat ${job.heartbeatAt ?? 'never'})` };
      this.markInterrupted(ctx, job, reason);
      job = requireJob(db, ctx.siteId, jobId);
    }
    if (job.cancelRequested && job.status !== 'cancelled' && job.status !== 'succeeded' && job.status !== 'failed') {
      this.finishWithoutRun(ctx, job, 'cancelled', { code: 'CANCELLED', message: 'Cancelled before it could run' });
      return { outcome: 'cancelled', job: requireJob(db, ctx.siteId, jobId) };
    }
    const runnable: JobStatus[] = ['queued', 'interrupted', 'waiting', ...(opts.allowFailed ? (['failed'] as JobStatus[]) : [])];
    if (!runnable.includes(job.status)) return { outcome: 'not_runnable', job, reason: `status is ${job.status}` };
    if (job.status === 'queued' && job.nextAttemptAt && Date.parse(job.nextAttemptAt) > now.getTime() && !opts.ignoreSchedule) {
      return { outcome: 'not_runnable', job, reason: `next attempt scheduled at ${job.nextAttemptAt}` };
    }
    if (this.opts.maxMode && !modeAtLeast(this.opts.maxMode, job.mode)) {
      return { outcome: 'not_runnable', job, reason: `job mode ${job.mode} exceeds this runner's maximum (${this.opts.maxMode}); run it explicitly with --mode ${job.mode}` };
    }
    const handler = this.opts.registry.get(job.type);
    if (!handler) {
      const error: ErrorInfo = {
        code: 'NOT_FOUND',
        message: `No job handler is registered for type "${job.type}" in this build`,
        hint: `Registered types: ${this.opts.registry.types().join(', ') || '(none)'}. After a handler is available, run \`jobs resume ${job.id}\`.`,
      };
      this.finishWithoutRun(ctx, job, 'failed', error);
      return { outcome: 'failed', job: requireJob(db, ctx.siteId, jobId), error };
    }
    let params: Record<string, unknown> = job.params;
    if (handler.paramsSchema) {
      const parsed = handler.paramsSchema.safeParse(job.params);
      if (!parsed.success) {
        const error: ErrorInfo = { code: 'VALIDATION_FAILED', message: `Invalid params for job type "${job.type}": ${parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ')}` };
        this.finishWithoutRun(ctx, job, 'failed', error);
        return { outcome: 'failed', job: requireJob(db, ctx.siteId, jobId), error };
      }
      params = parsed.data as Record<string, unknown>;
    }

    const lockName = handler.lockName ?? DEFAULT_LOCK_NAME;
    if (this.heldJobs.has(jobId)) {
      const cur = getSiteLock(db, ctx.siteId, lockName);
      if (cur) return { outcome: 'locked', job, heldBy: cur };
    }
    const acq = acquireSiteLock(db, {
      siteId: ctx.siteId,
      lockName,
      owner: this.owner,
      jobId,
      leaseMs: this.leaseMs,
      now,
      mayTakeOver: (cur) => this.lockHolderAliveReason(ctx, cur, now) === null,
    });
    if (!acq.acquired) {
      // An expired manual lease whose process is alive: start the few-heartbeats window after which it counts as hung.
      if (Date.parse(acq.heldBy.expiresAt) <= now.getTime()) {
        try {
          noteUnrenewedLease(db, ctx.siteId, acq.heldBy, this.holderCheck(now), this.owner);
        } catch {
          /* database busy: the next contender records the sighting */
        }
      }
      return { outcome: 'locked', job, heldBy: acq.heldBy };
    }
    if (acq.takenOverFrom) ctx.logger.warn(`Took over expired ${lockName} lock from ${acq.takenOverFrom.owner}`, { previousJob: acq.takenOverFrom.jobId });

    const attempt = job.attempt + 1;
    const runId = `jrun_${ulid()}`;
    const resumed = job.attempt > 0;
    const claimed = db.transaction(() => {
      const r = db.run(
        `UPDATE jobs SET status = 'running', attempt = ?, started_at = COALESCE(started_at, ?), heartbeat_at = ?, lock_owner = ?,
           next_attempt_at = NULL, finished_at = NULL
         WHERE id = ? AND site_id = ? AND status = ? AND attempt = ?`,
        [attempt, now.toISOString(), now.toISOString(), this.owner, jobId, ctx.siteId, job.status, job.attempt],
      );
      if (r.changes === 0) return false;
      db.run(`INSERT INTO job_runs (id, job_id, site_id, attempt, status, pid, hostname, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`, [
        runId,
        jobId,
        ctx.siteId,
        attempt,
        this.pid,
        this.hostname,
        now.toISOString(),
      ]);
      recordAudit(db, { siteId: ctx.siteId, actor: 'system', eventType: 'job.started', subjectType: 'job', subjectId: jobId, details: { type: job.type, attempt, owner: this.owner, resumed }, at: now });
      return true;
    });
    if (!claimed) {
      releaseSiteLock(db, { siteId: ctx.siteId, lockName, owner: this.owner, jobId });
      return { outcome: 'not_runnable', job: requireJob(db, ctx.siteId, jobId), reason: 'claimed by another runner' };
    }
    this.active.add(jobId);

    const ctl = new AbortController();
    const onExternalAbort = () => ctl.abort(interruptedError(`Runner stopped while job ${jobId} was running`));
    if (opts.signal) {
      if (opts.signal.aborted) onExternalAbort();
      else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    let lockLost = false;
    const checkCancel = () => {
      const row = db.get<{ cancel_requested: number }>('SELECT cancel_requested FROM jobs WHERE id = ? AND site_id = ?', [jobId, ctx.siteId]);
      if (row?.cancel_requested === 1 && !ctl.signal.aborted) ctl.abort(cancelledError(`Job ${jobId} was cancelled`));
    };
    const heartbeat = () => {
      if (ctl.signal.aborted) throw ctl.signal.reason;
      const at = ctx.clock.now();
      if (!renewSiteLock(db, { siteId: ctx.siteId, lockName, owner: this.owner, jobId, leaseMs: this.leaseMs, now: at })) {
        lockLost = true;
        const e = new AppError('LOCKED', `The ${lockName} lock for job ${jobId} was lost (lease expired and another runner took over); stopping.`);
        ctl.abort(e);
        throw e;
      }
      // Guarded by owner and attempt: a run that was declared stale (and possibly resumed elsewhere) must stop.
      const hb = db.run("UPDATE jobs SET heartbeat_at = ? WHERE id = ? AND site_id = ? AND status = 'running' AND lock_owner = ? AND attempt = ?", [
        at.toISOString(),
        jobId,
        ctx.siteId,
        this.owner,
        attempt,
      ]);
      if (hb.changes === 0) {
        const e = new AppError('LOCKED', `Job ${jobId} was marked interrupted or claimed by another runner while this run (attempt ${attempt}) was still going; stopping.`);
        ctl.abort(e);
        throw e;
      }
      checkCancel();
      if (ctl.signal.aborted) throw ctl.signal.reason;
    };
    const hbTimer = setInterval(() => {
      try {
        heartbeat();
      } catch {
        /* abort already signalled */
      }
    }, this.heartbeatMs);
    hbTimer.unref();
    const cancelTimer = setInterval(() => {
      try {
        checkCancel();
      } catch {
        /* database busy: retried on the next poll */
      }
    }, this.cancelPollMs);
    cancelTimer.unref();

    const running = requireJob(db, ctx.siteId, jobId);
    const orphanWork: Array<{ work: Promise<void>; label: string }> = [];
    const hctx: JobHandlerContext = {
      // A dry-run context never runs a job for real, whatever the job row says (e.g. resuming a real
      // job from a --dry-run invocation against a scratch copy of the database): dry run is sticky.
      app: { ...ctx, runId: jobId, mode: job.mode, dryRun: ctx.dryRun || job.dryRun, logger: ctx.logger.child({ job: jobId, jobType: job.type }) },
      job: running,
      attempt,
      signal: ctl.signal,
      heartbeat,
      isCancelRequested: () => {
        checkCancel();
        return ctl.signal.aborted && errorCodeOf(ctl.signal.reason) === 'CANCELLED';
      },
      // With network access disabled (--offline, demo mode) nothing reaches a provider, so the run
      // never changes breaker state (it still sees open breakers).
      breakers: new CircuitBreakers(db, ctx.siteId, ctx.clock, ctx.offline ? { ...this.opts.breakers, offline: true } : this.opts.breakers),
      resumed,
      overrides: { rerunAmbiguousPaidStages: opts.rerunAmbiguousPaidStages === true },
      keepLockUntilSettled: (work, label) => {
        orphanWork.push({
          work: work.then(
            () => undefined,
            () => undefined,
          ),
          label,
        });
      },
    };

    let outcome: JobOutcome | undefined;
    let thrown: unknown;
    try {
      outcome = await handler.run(hctx, params);
    } catch (err) {
      thrown = err;
    } finally {
      clearInterval(hbTimer);
      clearInterval(cancelTimer);
      opts.signal?.removeEventListener('abort', onExternalAbort);
    }

    try {
      const end = ctx.clock.now();
      const fin = (f: FinalizeInput): RunJobResult | null => {
        if (this.finalize(ctx, jobId, runId, attempt, f)) return null;
        // Superseded: the job was declared stale and marked interrupted / resumed by another runner.
        const job = requireJob(db, ctx.siteId, jobId);
        const error: ErrorInfo = {
          code: 'SUPERSEDED',
          message: `This run (attempt ${attempt}) was superseded: the job was marked interrupted or taken over by another runner (job is now ${job.status}); this run's ${f.jobStatus} result was discarded.`,
        };
        return { outcome: 'interrupted', job, error };
      };
      const orphanHint = orphanWork.length ? ` ${orphanWork.map((o) => o.label).join(', ')} did not stop in time; the ${lockName} lock stays held until it settles.` : '';
      if (ctl.signal.aborted) {
        const raw = toErrorInfo(ctl.signal.reason, 'INTERRUPTED');
        const info = orphanHint ? { ...raw, hint: `${raw.hint ? `${raw.hint} ` : ''}${orphanHint.trim()}` } : raw;
        if (info.code === 'CANCELLED') {
          return fin({ jobStatus: 'cancelled', runStatus: 'cancelled', error: info, result: outcome?.result, now: end }) ?? { outcome: 'cancelled', job: requireJob(db, ctx.siteId, jobId) };
        }
        return fin({ jobStatus: 'interrupted', runStatus: 'interrupted', error: info, result: outcome?.result, now: end }) ?? { outcome: 'interrupted', job: requireJob(db, ctx.siteId, jobId), error: info };
      }
      if (outcome && outcome.status === 'succeeded') {
        return fin({ jobStatus: 'succeeded', runStatus: 'succeeded', result: outcome.result, now: end }) ?? { outcome: 'succeeded', job: requireJob(db, ctx.siteId, jobId) };
      }
      if (outcome && outcome.status === 'waiting') {
        return (
          fin({ jobStatus: 'waiting', runStatus: 'succeeded', result: outcome.result, note: outcome.reason, now: end }) ?? { outcome: 'waiting', job: requireJob(db, ctx.siteId, jobId), reason: outcome.reason }
        );
      }
      let error: ErrorInfo;
      let retryable: boolean;
      let retryAfter: string | undefined;
      if (outcome && outcome.status === 'failed') {
        error = outcome.error;
        retryable = outcome.retryable;
        retryAfter = outcome.retryAfter;
      } else if (thrown !== undefined) {
        error = toErrorInfo(thrown);
        retryable = handler.idempotent === true && isRetryableError(thrown);
      } else {
        error = { code: 'INTERNAL', message: `Handler for "${job.type}" returned no outcome` };
        retryable = false;
      }
      // Work still running in the background must not overlap a retry of the same job.
      if (orphanWork.length) retryable = false;
      if (orphanHint) error = { ...error, hint: `${error.hint ? `${error.hint} ` : ''}${orphanHint.trim()}` };
      const failures = failedRunCount(db, ctx.siteId, jobId) + 1;
      const maxAttempts = requireJob(db, ctx.siteId, jobId).maxAttempts;
      if (retryable && failures < maxAttempts) {
        let nextMs = end.getTime() + backoffDelay(failures, this.backoff, this.opts.rand);
        // Never retry before the failure says a retry can help (e.g. an open circuit breaker's next probe).
        const after = retryAfter ? Date.parse(retryAfter) : Number.NaN;
        if (Number.isFinite(after) && after > nextMs) nextMs = after;
        const nextAt = new Date(nextMs).toISOString();
        return (
          fin({ jobStatus: 'queued', runStatus: 'failed', error, result: outcome?.result, nextAttemptAt: nextAt, now: end }) ?? {
            outcome: 'retry_scheduled',
            job: requireJob(db, ctx.siteId, jobId),
            error,
            nextAttemptAt: nextAt,
          }
        );
      }
      const finalError: ErrorInfo = retryable ? { ...error, hint: error.hint ?? `Gave up after ${failures} failed attempt(s). Fix the cause, then run \`jobs resume ${jobId}\`.` } : error;
      return fin({ jobStatus: 'failed', runStatus: 'failed', error: finalError, result: outcome?.result, now: end }) ?? { outcome: 'failed', job: requireJob(db, ctx.siteId, jobId), error: finalError };
    } finally {
      this.active.delete(jobId);
      if (orphanWork.length && !lockLost) this.holdLockUntilSettled(ctx, lockName, jobId, orphanWork);
      else releaseSiteLock(db, { siteId: ctx.siteId, lockName, owner: this.owner, jobId });
    }
  }

  /**
   * Keep holding (and renewing) the site lock of a finished run until work it
   * started settles, so no other job of the site overlaps it. The run's result
   * is already recorded; only the lock is kept.
   */
  private holdLockUntilSettled(ctx: AppContext, lockName: string, jobId: string, work: Array<{ work: Promise<void>; label: string }>): void {
    const db = ctx.db;
    const labels = work.map((w) => w.label);
    ctx.logger.warn(`Keeping the ${lockName} lock after job ${jobId} until ${labels.join(', ')} settles (it ignored its abort signal)`);
    try {
      recordAudit(db, { siteId: ctx.siteId, actor: 'system', eventType: 'lock.held_for_orphaned_work', subjectType: 'site_lock', subjectId: lockName, details: { jobId, work: labels }, at: ctx.clock.now() });
    } catch {
      /* audit is best effort here; the lock itself is what matters */
    }
    const renew = setInterval(() => {
      try {
        if (!renewSiteLock(db, { siteId: ctx.siteId, lockName, owner: this.owner, jobId, leaseMs: this.leaseMs, now: ctx.clock.now() })) {
          clearInterval(renew);
          ctx.logger.warn(`The ${lockName} lock held for orphaned work of job ${jobId} was taken over`);
        }
      } catch {
        /* database busy or closed: the lease simply runs out */
      }
    }, this.heartbeatMs);
    renew.unref();
    const done = Promise.all(work.map((w) => w.work)).then(() => {
      clearInterval(renew);
      try {
        if (releaseSiteLock(db, { siteId: ctx.siteId, lockName, owner: this.owner, jobId })) {
          recordAudit(db, { siteId: ctx.siteId, actor: 'system', eventType: 'lock.released_after_orphaned_work', subjectType: 'site_lock', subjectId: lockName, details: { jobId, work: labels }, at: ctx.clock.now() });
        }
      } catch {
        /* database closed: the lease expires, and a dead holder process can be taken over */
      }
    });
    this.holds.add(done);
    this.heldJobs.add(jobId);
    void done.finally(() => {
      this.holds.delete(done);
      this.heldJobs.delete(jobId);
    });
  }

  /**
   * Record the end of a run. The job row is updated only while this run still
   * owns it (status running, lock_owner = this runner, same attempt); returns
   * false when the run was superseded, in which case only this run's job_runs
   * row is closed (as interrupted) and the job row is left to the newer run.
   */
  private finalize(ctx: AppContext, jobId: string, runId: string, attempt: number, f: FinalizeInput): boolean {
    const db = ctx.db;
    const iso = f.now.toISOString();
    const errorJson = f.error ? safeJson(f.error) : null;
    const finished = f.jobStatus === 'queued' ? null : iso;
    const result = f.note ? { ...(typeof f.result === 'object' && f.result !== null ? (f.result as Record<string, unknown>) : f.result === undefined ? {} : { value: f.result }), waitingReason: f.note } : f.result;
    const applied = db.transaction(() => {
      const upd = db.run(
        `UPDATE jobs SET status = ?, finished_at = ?, heartbeat_at = ?, lock_owner = NULL, next_attempt_at = ?, error_json = ?,
           result_json = COALESCE(?, result_json)
         WHERE id = ? AND site_id = ? AND status = 'running' AND lock_owner = ? AND attempt = ?`,
        [f.jobStatus, finished, iso, f.nextAttemptAt ?? null, f.jobStatus === 'succeeded' ? null : errorJson, safeJson(result), jobId, ctx.siteId, this.owner, attempt],
      );
      if (upd.changes === 0) {
        const superseded: ErrorInfo = {
          code: 'SUPERSEDED',
          message: `Run superseded: the job was marked interrupted or taken over by another runner before this run finished; its ${f.jobStatus} result was discarded.`,
        };
        db.run('UPDATE job_runs SET status = ?, finished_at = ?, error_json = ? WHERE id = ? AND site_id = ?', ['interrupted', iso, safeJson(superseded), runId, ctx.siteId]);
        recordAudit(db, {
          siteId: ctx.siteId,
          actor: 'system',
          eventType: 'job.run_superseded',
          subjectType: 'job',
          subjectId: jobId,
          details: { attempt, owner: this.owner, discardedStatus: f.jobStatus },
          at: f.now,
        });
        return false;
      }
      db.run('UPDATE job_runs SET status = ?, finished_at = ?, error_json = ? WHERE id = ? AND site_id = ?', [f.runStatus, iso, errorJson, runId, ctx.siteId]);
      recordAudit(db, {
        siteId: ctx.siteId,
        actor: 'system',
        eventType: f.jobStatus === 'queued' ? 'job.retry_scheduled' : `job.${f.jobStatus}`,
        subjectType: 'job',
        subjectId: jobId,
        details: { runStatus: f.runStatus, ...(f.error ? { error: f.error } : {}), ...(f.nextAttemptAt ? { nextAttemptAt: f.nextAttemptAt } : {}) },
        at: f.now,
      });
      return true;
    });
    if (applied) ctx.logger.info(`Job ${jobId} -> ${f.jobStatus}`, f.error ? { code: f.error.code } : {});
    else ctx.logger.warn(`Run ${runId} of job ${jobId} was superseded by another runner; its ${f.jobStatus} result was discarded`);
    return applied;
  }

  /** Terminal transition for a job that never started a run (no job_runs row). */
  private finishWithoutRun(ctx: AppContext, job: JobRecord, status: 'failed' | 'cancelled', error: ErrorInfo): void {
    const now = ctx.clock.now();
    ctx.db.transaction(() => {
      ctx.db.run(`UPDATE jobs SET status = ?, finished_at = ?, next_attempt_at = NULL, error_json = ? WHERE id = ? AND site_id = ?`, [status, now.toISOString(), safeJson(error), job.id, ctx.siteId]);
      recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType: `job.${status}`, subjectType: 'job', subjectId: job.id, details: { error, withoutRun: true }, at: now });
    });
  }

  /**
   * Why a `running` job should be considered interrupted, or null when it looks alive.
   *
   * On this host the process table is authoritative: a dead pid means
   * interrupted; a live pid is NOT declared stale on heartbeat age alone (after
   * a laptop wakes, wall-clock heartbeats are hours old until the process's
   * timers fire), only after `localStaleAfterMs`. On another host only the
   * heartbeat age can be judged.
   */
  staleReason(ctx: AppContext, job: JobRecord, now: Date = ctx.clock.now()): string | null {
    const h = this.runningJobHolder(ctx, job, now);
    return h.state === 'alive' ? null : h.reason;
  }

  /**
   * The same check as `staleReason` (what `jobs list` shows), classified:
   * `gone` when the job's latest running run belongs to a process on THIS
   * host that no longer exists (verified), `stale` when it only looks
   * interrupted (a stale heartbeat on another host, a hung local process, no
   * run recorded), `alive` otherwise. Used by `jobs cancel` (requestCancel).
   */
  runningJobHolder(ctx: AppContext, job: JobRecord, now: Date = ctx.clock.now()): RunningJobHolder {
    if (job.status !== 'running') return { state: 'alive' };
    if (this.active.has(job.id) && job.lockOwner === this.owner) return { state: 'alive' };
    const runs = listJobRuns(ctx.db, ctx.siteId, job.id);
    const run = [...runs].reverse().find((r) => r.status === 'running');
    const age = job.heartbeatAt ? now.getTime() - Date.parse(job.heartbeatAt) : Number.POSITIVE_INFINITY;
    if (run && run.hostname === this.hostname && run.pid !== null) {
      if (!this.isPidAlive(run.pid)) return { state: 'gone', reason: `process ${run.pid} on ${run.hostname} is no longer running` };
      if (age > this.localStaleAfterMs) {
        return { state: 'stale', reason: `process ${run.pid} on ${run.hostname} is alive but has not heartbeated since ${job.heartbeatAt ?? 'it started'} (${Math.round(age / 1000)}s); treating it as hung` };
      }
      return { state: 'alive' };
    }
    if (!job.heartbeatAt) return { state: 'stale', reason: 'no heartbeat recorded' };
    if (age > this.staleAfterMs) return { state: 'stale', reason: `heartbeat is stale (last at ${job.heartbeatAt}, ${Math.round(age / 1000)}s ago)` };
    return { state: 'alive' };
  }

  /** How this runner judges lease holders on its host (see src/jobs/manual-lease.ts). */
  private holderCheck(now: Date): LeaseHolderCheck {
    return {
      hostname: this.hostname,
      isPidAlive: this.isPidAlive,
      now,
      localStaleAfterMs: this.localStaleAfterMs,
      ...(this.processStartedAt ? { processStartedAt: this.processStartedAt } : {}),
      ...(this.opts.unrenewedAfterMs !== undefined ? { unrenewedAfterMs: this.opts.unrenewedAfterMs } : {}),
    };
  }

  /**
   * Why an expired lock must NOT be taken over, or null. It is refused while
   * the lock's job is still `running` in a process that is alive on this host
   * and heartbeated within `localStaleAfterMs` (e.g. a laptop that just woke
   * up), and likewise while a MANUAL command's lease belongs to a process that
   * is alive on this host (same pid and, when recorded, the same process start
   * time) and was not seen unrenewed for a few heartbeats (see
   * src/jobs/manual-lease.ts). A lock whose job is
   * no longer running (leaked, or the holder slept during a hold) can be taken
   * over once its lease expired.
   */
  lockHolderAliveReason(ctx: AppContext, lock: LockInfo, now: Date = ctx.clock.now()): string | null {
    return leaseHolderAliveReason(ctx.db, ctx.siteId, lock, this.holderCheck(now));
  }

  /**
   * The job holding `lock` when its run appears interrupted: the job is still
   * recorded as `running`, but the check `jobs list` shows as "appears
   * interrupted" (`runningJobHolder`) says its process on this host is gone
   * (verified) or its run only looks interrupted (a stale heartbeat on another
   * host, a hung local process). Null for a live holder, a manual-command
   * lease, and a lock kept by a job that is no longer running (work it started
   * that has not settled yet). Read-only.
   */
  interruptedLockHolder(ctx: AppContext, lock: LockInfo, now: Date = ctx.clock.now()): InterruptedLockHolder | null {
    if (!lock.jobId) return null;
    const job = getJob(ctx.db, ctx.siteId, lock.jobId);
    if (!job || job.status !== 'running') return null;
    const h = this.runningJobHolder(ctx, job, now);
    if (h.state === 'alive') return null;
    return { jobId: job.id, type: job.type, mode: job.mode, state: h.state, reason: h.reason };
  }

  private markInterrupted(ctx: AppContext, job: JobRecord, reason: string): boolean {
    const now = ctx.clock.now();
    const error: ErrorInfo = { code: 'INTERRUPTED', message: `Run stopped without finishing: ${reason}`, hint: `Resume with \`${resumeJobCommand(job.id, job.mode)}\`; completed stages are reused from checkpoints.` };
    return ctx.db.transaction(() => {
      const r = ctx.db.run(
        `UPDATE jobs SET status = 'interrupted', lock_owner = NULL, error_json = ? WHERE id = ? AND site_id = ? AND status = 'running' AND COALESCE(heartbeat_at, '') = ?`,
        [safeJson(error), job.id, ctx.siteId, job.heartbeatAt ?? ''],
      );
      if (r.changes === 0) return false;
      ctx.db.run(`UPDATE job_runs SET status = 'interrupted', finished_at = ?, error_json = ? WHERE job_id = ? AND site_id = ? AND status = 'running'`, [now.toISOString(), safeJson(error), job.id, ctx.siteId]);
      if (job.lockOwner) ctx.db.run('DELETE FROM site_locks WHERE site_id = ? AND owner = ? AND job_id = ?', [ctx.siteId, job.lockOwner, job.id]);
      recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType: 'job.interrupted', subjectType: 'job', subjectId: job.id, details: { reason, previousOwner: job.lockOwner }, at: now });
      return true;
    });
  }

  /**
   * Crash recovery: mark `running` jobs of this site whose runner is gone as
   * `interrupted` (their locks are released). Called on startup, before
   * draining, and by `jobs resume`.
   */
  recoverInterrupted(ctx: AppContext): RecoveredJob[] {
    const now = ctx.clock.now();
    const rows = ctx.db.all<JobRow>("SELECT * FROM jobs WHERE site_id = ? AND status = 'running' ORDER BY created_at", [ctx.siteId]);
    const out: RecoveredJob[] = [];
    for (const row of rows) {
      const job = toJobRecord(row);
      const reason = this.staleReason(ctx, job, now);
      if (reason && this.markInterrupted(ctx, job, reason)) out.push({ jobId: job.id, type: job.type, reason });
    }
    return out;
  }

  /**
   * Resume one job (by id) or every interrupted job and due retry of the site.
   * Workflow handlers reuse checkpoints of completed stages.
   */
  async resume(
    ctx: AppContext,
    jobId?: string,
    opts: { signal?: AbortSignal; actor?: string; rerunAmbiguousPaidStages?: boolean; reviewedStage?: string } = {},
  ): Promise<{ recovered: RecoveredJob[]; results: RunJobResult[]; review?: StageReviewRecord }> {
    if (opts.rerunAmbiguousPaidStages && !jobId) {
      throw new AppError('VALIDATION_FAILED', 'Rerunning interrupted paid stages must be authorized per job: pass a job id.');
    }
    if (opts.reviewedStage !== undefined && !jobId) throw new AppError('VALIDATION_FAILED', 'A review is recorded per job: pass a job id with --reviewed.');
    const recovered = this.recoverInterrupted(ctx);
    const results: RunJobResult[] = [];
    let review: StageReviewRecord | undefined;
    if (jobId) {
      const job = requireJob(ctx.db, ctx.siteId, jobId);
      if (opts.reviewedStage !== undefined) {
        const stoppedBy = (job.result as { stoppedBy?: { stage?: string; status?: string } } | null)?.stoppedBy;
        if (job.status !== 'waiting' || stoppedBy?.status !== 'needs_review') {
          throw new AppError('CONFLICT', `Job ${jobId} is ${job.status} and is not waiting for a human review; --reviewed does not apply.`);
        }
        if (stoppedBy.stage !== opts.reviewedStage) {
          throw new AppError('VALIDATION_FAILED', `Job ${jobId} is waiting for review of stage "${stoppedBy.stage}", not "${opts.reviewedStage}".`);
        }
        review = recordStageReview(ctx.db, ctx.clock, { siteId: ctx.siteId, jobId, stage: opts.reviewedStage, reviewer: opts.actor ?? 'cli' });
      }
      if (job.status === 'succeeded') throw new AppError('CONFLICT', `Job ${jobId} already succeeded; enqueue a new job to run it again.`);
      if (job.status === 'cancelled') throw new AppError('CONFLICT', `Job ${jobId} was cancelled; enqueue a new job if you still want it.`);
      if (job.status === 'running') throw new AppError('LOCKED', `Job ${jobId} is still running (heartbeat ${job.heartbeatAt ?? 'unknown'}); it cannot be resumed twice.`);
      if (job.status === 'failed') {
        const failures = failedRunCount(ctx.db, ctx.siteId, jobId);
        if (failures >= job.maxAttempts) {
          ctx.db.transaction(() => {
            ctx.db.run('UPDATE jobs SET max_attempts = ? WHERE id = ? AND site_id = ?', [failures + 1, jobId, ctx.siteId]);
            recordAudit(ctx.db, { siteId: ctx.siteId, actor: opts.actor ?? 'cli', eventType: 'job.attempts_extended', subjectType: 'job', subjectId: jobId, details: { maxAttempts: failures + 1 }, at: ctx.clock.now() });
          });
        }
      }
      if (opts.rerunAmbiguousPaidStages) {
        recordAudit(ctx.db, { siteId: ctx.siteId, actor: opts.actor ?? 'cli', eventType: 'job.rerun_paid_stages_authorized', subjectType: 'job', subjectId: jobId, at: ctx.clock.now() });
      }
      results.push(
        await this.runJob(ctx, jobId, {
          retryInline: true,
          allowFailed: true,
          ignoreSchedule: true,
          ...(opts.rerunAmbiguousPaidStages ? { rerunAmbiguousPaidStages: true } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        }),
      );
      return { recovered, results, ...(review ? { review } : {}) };
    }
    const nowIso = ctx.clock.now().toISOString();
    const candidates = ctx.db.all<{ id: string }>(
      `SELECT id FROM jobs WHERE site_id = ? AND cancel_requested = 0 AND (status = 'interrupted' OR (status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)))
       ORDER BY created_at, rowid`,
      [ctx.siteId, nowIso],
    );
    for (const c of candidates) {
      if (opts.signal?.aborted) break;
      const r = await this.runJob(ctx, c.id, { retryInline: true, ignoreSchedule: true, ...(opts.signal ? { signal: opts.signal } : {}) });
      results.push(r);
      if (r.outcome === 'locked') break;
    }
    return { recovered, results };
  }

  /**
   * Run due queued jobs of the site one at a time (non-overlapping), oldest
   * first. With `autoResume`, interrupted jobs that pass `autoResumeDecision`
   * (scheduled jobs, below the consecutive-interruption cap) are resumed too;
   * the others are reported in `needsAttention`. Paid stages that were in
   * flight are still never rerun automatically: the engine stops such a job
   * with AMBIGUOUS_SUBMISSION until a human reconciles it.
   *
   * With `scheduledOnly` (the scheduler tick), only jobs the scheduler
   * enqueued (`params.trigger = 'schedule'`) are started: a queued job that a
   * human started in the foreground (e.g. a retry left by `weekly`) is never
   * run unattended; it is reported in `needsAttention` instead.
   */
  async drain(
    ctx: AppContext,
    opts: { maxJobs?: number; signal?: AbortSignal; autoResume?: Partial<AutoResumePolicy> | false; scheduledOnly?: boolean } = {},
  ): Promise<{ recovered: RecoveredJob[]; results: RunJobResult[]; needsAttention: NeedsAttention[] }> {
    const recovered = this.recoverInterrupted(ctx);
    const results: RunJobResult[] = [];
    const tried = new Set<string>();
    const maxJobs = opts.maxJobs ?? 10;
    const policy: AutoResumePolicy | null = opts.autoResume ? { ...DEFAULT_AUTO_RESUME, ...opts.autoResume } : null;
    const attention = new Map<string, NeedsAttention>();
    while (results.length < maxJobs && !opts.signal?.aborted) {
      const nowIso = ctx.clock.now().toISOString();
      const due = ctx.db
        .all<JobRow>(
          `SELECT * FROM jobs WHERE site_id = ? AND cancel_requested = 0
             AND ((status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) OR (? = 1 AND status = 'interrupted'))
           ORDER BY created_at, rowid LIMIT 100`,
          [ctx.siteId, nowIso, policy ? 1 : 0],
        )
        .map(toJobRecord);
      let next: JobRecord | undefined;
      for (const j of due) {
        if (tried.has(j.id)) continue;
        const unscheduled = opts.scheduledOnly === true && j.params.trigger !== 'schedule';
        if (unscheduled && j.status === 'queued') {
          attention.set(j.id, {
            jobId: j.id,
            type: j.type,
            status: j.status,
            reason: `${j.type} job ${j.id} is queued but was not started by the scheduler, so it is not run unattended; run it with \`jobs resume ${j.id}\` or cancel it with \`jobs cancel ${j.id}\``,
          });
          tried.add(j.id);
          continue;
        }
        if (j.status === 'interrupted' && policy) {
          const d = autoResumeDecision(ctx.db, j, unscheduled ? { ...policy, scheduledOnly: true } : policy);
          if (!d.eligible) {
            attention.set(j.id, { jobId: j.id, type: j.type, status: j.status, reason: `${j.type} job ${j.id} is interrupted and is not resumed automatically: ${d.reason}` });
            tried.add(j.id);
            continue;
          }
          ctx.logger.info(`Resuming interrupted scheduled job ${j.id} automatically`, { interruptions: d.interruptions });
        }
        next = j;
        break;
      }
      if (!next) break;
      tried.add(next.id);
      const r = await this.runJob(ctx, next.id, opts.signal ? { signal: opts.signal } : {});
      results.push(r);
      if (r.outcome === 'locked') break;
    }
    return { recovered, results, needsAttention: [...attention.values()] };
  }
}

interface FinalizeInput {
  jobStatus: JobStatus;
  runStatus: 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  error?: ErrorInfo;
  result?: unknown;
  nextAttemptAt?: string;
  note?: string;
  now: Date;
}

export interface EnqueueAndRunOptions extends EnqueueOptions, RunJobOptions {
  /**
   * Leave the new job `queued` when the lock is held (old behaviour). By
   * default a foreground job that cannot start because another run holds its
   * lock is closed as `cancelled` with code LOCKED: a command the operator
   * ran now must not turn into an unattended run later.
   */
  keepQueuedIfLocked?: boolean;
}

/**
 * A job that holds a lock while its run appears interrupted
 * (`JobRunner.interruptedLockHolder`): `gone` when its process on this host no
 * longer exists (verified), `stale` when it only looks interrupted.
 */
export interface InterruptedLockHolder {
  jobId: string;
  type: string;
  mode: RuntimeMode;
  state: 'gone' | 'stale';
  reason: string;
}

/** "was interrupted (<reason>)" / "appears interrupted (<reason>)" for an interrupted lock holder. */
export function interruptedHolderText(holder: InterruptedLockHolder): string {
  return `${holder.state === 'gone' ? 'was interrupted' : 'appears interrupted'} (${holder.reason})`;
}

/**
 * Next step when a lock is held by a job whose run appears interrupted: that
 * run can never finish by itself, so waiting for it is not a next step.
 * Resuming it (with the `--mode` its job needs) finishes it from its
 * checkpoints; cancelling it frees the lock.
 */
export function interruptedHolderHint(holder: InterruptedLockHolder, then: string): string {
  return `The run holding the lock ${interruptedHolderText(holder)}: resume it with \`${resumeJobCommand(holder.jobId, holder.mode)}\` (completed stages are reused from checkpoints), or cancel it with \`npm run cli -- jobs cancel ${holder.jobId}\` and ${then}`;
}

/**
 * Error recorded on a foreground job that was refused because its lock is held (nothing was left queued).
 * With `holder` (JobRunner.interruptedLockHolder of `heldBy`), the holder's run appears interrupted and the
 * next step is to resume or cancel it, never to wait for it.
 */
export function lockedRefusalError(heldBy: LockInfo, jobId: string, holder?: InterruptedLockHolder | null): ErrorInfo {
  const interrupted = holder && heldBy.jobId && holder.jobId === heldBy.jobId ? holder : null;
  return {
    code: 'LOCKED',
    message: `The ${heldBy.lockName} lock of this site is held by ${describeLeaseHolder(heldBy)} (lease until ${heldBy.expiresAt})${interrupted ? `, whose run ${interruptedHolderText(interrupted)}` : ''}; runs never overlap. Job ${jobId} did not run and was closed as cancelled, so nothing was left queued.`,
    hint: interrupted
      ? interruptedHolderHint(interrupted, 'run the command again.')
      : heldBy.jobId
        ? 'Wait for that run to finish (check `npm run cli -- jobs list`), then run the command again.'
        : `Wait for that command to finish, then run the command again. \`npm run cli -- jobs locks\` shows the lease and whether its process is still alive; a lease whose process is gone can be released with \`jobs locks --release ${heldBy.lockName} --as "<your name>"\`.`,
  };
}

/**
 * Enqueue a job and run it now in this process (used by foreground commands
 * such as `baseline`/`weekly`): same durability, locking, checkpoints, and
 * retry rules as scheduled runs. When the lock is held the new job is closed
 * as `cancelled` (code LOCKED) unless `keepQueuedIfLocked`; the result keeps
 * the `locked` outcome and carries the closed job.
 */
export async function enqueueAndRun(
  ctx: AppContext,
  runner: JobRunner,
  type: string,
  params: Record<string, unknown> = {},
  opts: EnqueueAndRunOptions = {},
): Promise<RunJobResult> {
  const { signal, retryInline, keepQueuedIfLocked, allowFailed, ignoreSchedule, rerunAmbiguousPaidStages, ...enqueueOpts } = opts;
  const job = enqueue(ctx, type, params, { registry: runner.registry, ...enqueueOpts });
  const r = await runner.runJob(ctx, job.id, {
    retryInline: retryInline ?? true,
    ...(signal ? { signal } : {}),
    ...(allowFailed !== undefined ? { allowFailed } : {}),
    ...(ignoreSchedule !== undefined ? { ignoreSchedule } : {}),
    ...(rerunAmbiguousPaidStages !== undefined ? { rerunAmbiguousPaidStages } : {}),
  });
  if (r.outcome !== 'locked' || keepQueuedIfLocked) return r;
  closeUnstartedJob(ctx, job.id, lockedRefusalError(r.heldBy, job.id, runner.interruptedLockHolder(ctx, r.heldBy)), enqueueOpts.actor ?? 'system');
  return { ...r, job: requireJob(ctx.db, ctx.siteId, job.id) };
}

/** Convenience: load a job and report whether it currently looks stale (read-only). */
export function describeStaleness(runner: JobRunner, ctx: AppContext, jobId: string): string | null {
  const job = getJob(ctx.db, ctx.siteId, jobId);
  return job ? runner.staleReason(ctx, job) : null;
}
