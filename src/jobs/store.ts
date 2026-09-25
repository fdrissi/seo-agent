import type { AppContext } from '../app/context.js';
import { AppError, ValidationError } from '../core/errors.js';
import { newId, newTraceId } from '../core/ids.js';
import { DEFAULT_MODE, RUNTIME_MODES, type RuntimeMode } from '../core/modes.js';
import { recordAudit } from '../database/audit.js';
import { parseJson, type Db } from '../database/db.js';
import { redact } from '../security/redact.js';
import type { ErrorInfo } from '../workflows/errors.js';
import { JOB_TYPE_RE, type JobRegistry } from './registry.js';
import { JOB_STATUSES, type JobRecord, type JobRow, type JobRunRecord, type JobStatus } from './types.js';

/**
 * Durable job rows (table `jobs`, migrations 0001 + 0180). One row per logical
 * job; every run attempt is a `job_runs` row. All queries are scoped by site.
 */

export const DEFAULT_MAX_ATTEMPTS = 3;

export function toJobRecord(r: JobRow): JobRecord {
  return {
    id: r.id,
    siteId: r.site_id,
    type: r.type,
    status: r.status,
    mode: r.mode,
    params: parseJson<Record<string, unknown>>(r.params_json, {}),
    dryRun: r.dry_run === 1,
    attempt: r.attempt,
    maxAttempts: r.max_attempts,
    nextAttemptAt: r.next_attempt_at,
    cancelRequested: r.cancel_requested === 1,
    parentJobId: r.parent_job_id,
    traceId: r.trace_id,
    error: parseJson<ErrorInfo | null>(r.error_json, null),
    result: parseJson<unknown>(r.result_json, null),
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    heartbeatAt: r.heartbeat_at,
    lockOwner: r.lock_owner,
  };
}

export interface EnqueueOptions {
  maxAttempts?: number;
  /** Defaults to the context's runtime mode. */
  mode?: RuntimeMode;
  /** Defaults to the context's dry-run flag. */
  dryRun?: boolean;
  parentJobId?: string;
  /** Earliest start (ISO). Default: immediately. */
  runAt?: string;
  /** When given, params are validated against the handler's schema and unknown types are rejected. */
  registry?: JobRegistry;
  actor?: string;
}

/** Create a queued job for the context's site. */
export function enqueue(ctx: Pick<AppContext, 'db' | 'siteId' | 'clock' | 'mode' | 'dryRun'>, type: string, params: Record<string, unknown> = {}, opts: EnqueueOptions = {}): JobRecord {
  if (!JOB_TYPE_RE.test(type)) throw new ValidationError(`Invalid job type "${type}"`);
  let finalParams: Record<string, unknown> = params;
  let maxAttempts = opts.maxAttempts;
  if (opts.registry) {
    const handler = opts.registry.get(type);
    if (!handler) {
      throw new AppError('NOT_FOUND', `No job handler is registered for type "${type}" in this build`, {
        hint: `Registered types: ${opts.registry.types().join(', ') || '(none)'}`,
      });
    }
    if (handler.paramsSchema) {
      const parsed = handler.paramsSchema.safeParse(params);
      if (!parsed.success) {
        throw new ValidationError(`Invalid params for job type "${type}"`, { errors: parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`) });
      }
      finalParams = parsed.data as Record<string, unknown>;
    }
    maxAttempts ??= handler.maxAttempts;
  }
  maxAttempts ??= DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new ValidationError('maxAttempts must be an integer between 1 and 20');
  const mode = opts.mode ?? ctx.mode;
  if (!(RUNTIME_MODES as readonly string[]).includes(mode)) throw new ValidationError(`Unknown mode ${mode}`);
  let paramsJson: string;
  try {
    paramsJson = JSON.stringify(finalParams ?? {});
  } catch {
    throw new ValidationError('Job params must be JSON-serializable');
  }
  if (opts.runAt !== undefined && Number.isNaN(Date.parse(opts.runAt))) throw new ValidationError(`Invalid runAt ${opts.runAt}`);
  const now = ctx.clock.now().toISOString();
  const id = newId('job');
  ctx.db.transaction(() => {
    ctx.db.run(
      `INSERT INTO jobs (id, site_id, type, status, mode, params_json, dry_run, attempt, max_attempts, next_attempt_at, cancel_requested, parent_job_id, trace_id, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, 0, ?, ?, 0, ?, ?, ?)`,
      [id, ctx.siteId, type, mode, paramsJson, (opts.dryRun ?? ctx.dryRun) ? 1 : 0, maxAttempts, opts.runAt ? new Date(opts.runAt).toISOString() : null, opts.parentJobId ?? null, newTraceId(), now],
    );
    recordAudit(ctx.db, { siteId: ctx.siteId, actor: opts.actor ?? 'system', eventType: 'job.enqueued', subjectType: 'job', subjectId: id, details: { type, mode }, at: ctx.clock.now() });
  });
  return getJob(ctx.db, ctx.siteId, id)!;
}

export function getJob(db: Db, siteId: string, id: string): JobRecord | undefined {
  const r = db.get<JobRow>('SELECT * FROM jobs WHERE id = ? AND site_id = ?', [id, siteId]);
  return r ? toJobRecord(r) : undefined;
}

export function requireJob(db: Db, siteId: string, id: string): JobRecord {
  const j = getJob(db, siteId, id);
  if (!j) throw new AppError('NOT_FOUND', `Job ${id} not found for site ${siteId}`, { hint: 'List jobs with `jobs list`.' });
  return j;
}

export interface ListJobsFilter {
  status?: JobStatus | JobStatus[];
  type?: string;
  limit?: number;
}

export function listJobs(db: Db, siteId: string, filter: ListJobsFilter = {}): JobRecord[] {
  const where = ['site_id = ?'];
  const params: unknown[] = [siteId];
  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    for (const s of statuses) if (!(JOB_STATUSES as readonly string[]).includes(s)) throw new ValidationError(`Unknown job status ${s}`);
    where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  if (filter.type) {
    where.push('type = ?');
    params.push(filter.type);
  }
  const limit = Math.max(1, Math.min(filter.limit ?? 50, 1000));
  params.push(limit);
  return db.all<JobRow>(`SELECT * FROM jobs WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ?`, params).map(toJobRecord);
}

export function listJobRuns(db: Db, siteId: string, jobId: string): JobRunRecord[] {
  return db
    .all<{ id: string; job_id: string; site_id: string; attempt: number; status: JobRunRecord['status']; pid: number | null; hostname: string | null; started_at: string; finished_at: string | null; error_json: string | null }>(
      'SELECT * FROM job_runs WHERE site_id = ? AND job_id = ? ORDER BY attempt',
      [siteId, jobId],
    )
    .map((r) => ({
      id: r.id,
      jobId: r.job_id,
      siteId: r.site_id,
      attempt: r.attempt,
      status: r.status,
      pid: r.pid,
      hostname: r.hostname,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      error: parseJson<ErrorInfo | null>(r.error_json, null),
    }));
}

export function failedRunCount(db: Db, siteId: string, jobId: string): number {
  const r = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job_runs WHERE site_id = ? AND job_id = ? AND status = 'failed'", [siteId, jobId]);
  return Number(r?.n ?? 0);
}

/**
 * Number of runs at the end of the job's history that were interrupted
 * (shutdown, crash, lock loss) with no finished run in between. Used to stop
 * automatic resumption of a job that keeps getting interrupted.
 */
export function consecutiveInterruptedRuns(db: Db, siteId: string, jobId: string): number {
  const rows = db.all<{ status: string }>('SELECT status FROM job_runs WHERE site_id = ? AND job_id = ? ORDER BY attempt DESC', [siteId, jobId]);
  let n = 0;
  for (const r of rows) {
    if (r.status !== 'interrupted') break;
    n++;
  }
  return n;
}

/**
 * What the liveness check that `jobs list` uses (JobRunner.runningJobHolder /
 * staleReason) says about the process behind a `running` job:
 * - `alive`: it looks alive; it sees a cancellation at its next cooperative check;
 * - `gone`: its latest run belongs to a process on THIS host that no longer
 *   exists (verified): it can never reach that check;
 * - `stale`: it only looks interrupted (a stale heartbeat on another host, a
 *   hung local process), which is not verified.
 */
export type RunningJobHolder = { state: 'alive' } | { state: 'gone'; reason: string } | { state: 'stale'; reason: string };

/**
 * The command that resumes a job: `npm run cli -- jobs resume <id>`, with
 * `--mode <job mode>` when the job's mode is above the default ANALYZE.
 * `jobs resume` runs jobs up to the invoking `--mode` only, so without it a
 * RESEARCH (or higher) job is refused as not runnable.
 */
export function resumeJobCommand(jobId: string, mode: string): string {
  const needsMode = (RUNTIME_MODES as readonly string[]).includes(mode) && mode !== DEFAULT_MODE;
  return `npm run cli -- ${needsMode ? `--mode ${mode} ` : ''}jobs resume ${jobId}`;
}

export interface CancelOptions {
  /** Liveness of a running job's process. Without it, a running job only gets `cancel_requested` (as if alive). */
  holder?: (job: JobRecord) => RunningJobHolder;
}

export type CancelResult =
  | {
      jobId: string;
      outcome: 'cancelled';
      previousStatus: JobStatus;
      /** Set when the job was `running` but its process was gone: it was marked interrupted, then cancelled, in one step. */
      interruptedBecause?: string;
    }
  | {
      jobId: string;
      outcome: 'cancel_requested';
      previousStatus: JobStatus;
      note: string;
      /** Set when the running job only appears interrupted (not verified): why, as `jobs list` shows it. */
      appearsInterrupted?: string;
    }
  | { jobId: string; outcome: 'already_finished'; previousStatus: JobStatus };

/**
 * Request cancellation. Jobs that are not running are cancelled immediately;
 * a running job gets `cancel_requested = 1`, which its runner checks
 * cooperatively (between stages, on heartbeats) and turns into an abort.
 *
 * With `opts.holder` (the liveness check `jobs list` uses), a running job
 * whose process on this host is gone (a crash) never reaches that check: it is
 * marked interrupted and then cancelled in one transaction (its run closed as
 * interrupted, its site lock released, audited `job.interrupted` and
 * `job.cancelled`), so nothing (e.g. `restore`) stays blocked by it. A running
 * job that only appears interrupted gets `cancel_requested`, and the note
 * says so and names the next step (`jobs resume <id>` then closes it as
 * cancelled without running it).
 */
export function requestCancel(ctx: Pick<AppContext, 'db' | 'siteId' | 'clock'>, jobId: string, actor = 'cli', opts: CancelOptions = {}): CancelResult {
  const now = ctx.clock.now();
  return ctx.db.transaction((): CancelResult => {
    const job = requireJob(ctx.db, ctx.siteId, jobId);
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
      return { jobId, outcome: 'already_finished' as const, previousStatus: job.status };
    }
    if (job.status === 'running') {
      const holder = opts.holder?.(job) ?? { state: 'alive' as const };
      if (holder.state === 'gone') {
        const interrupted: ErrorInfo = { code: 'INTERRUPTED', message: `Run stopped without finishing: ${holder.reason}` };
        const cancelled: ErrorInfo = {
          code: 'CANCELLED',
          message: `Cancelled by ${actor}: the run had stopped without finishing (${holder.reason}), so the job was marked interrupted and then cancelled`,
        };
        const r = ctx.db.run(
          `UPDATE jobs SET status = 'cancelled', cancel_requested = 1, lock_owner = NULL, finished_at = ?, next_attempt_at = NULL, error_json = ?
           WHERE id = ? AND site_id = ? AND status = 'running' AND COALESCE(heartbeat_at, '') = ?`,
          [now.toISOString(), JSON.stringify(redact(cancelled)), jobId, ctx.siteId, job.heartbeatAt ?? ''],
        );
        if (r.changes > 0) {
          ctx.db.run(`UPDATE job_runs SET status = 'interrupted', finished_at = ?, error_json = ? WHERE job_id = ? AND site_id = ? AND status = 'running'`, [
            now.toISOString(),
            JSON.stringify(redact(interrupted)),
            jobId,
            ctx.siteId,
          ]);
          if (job.lockOwner) ctx.db.run('DELETE FROM site_locks WHERE site_id = ? AND owner = ? AND job_id = ?', [ctx.siteId, job.lockOwner, jobId]);
          recordAudit(ctx.db, { siteId: ctx.siteId, actor, eventType: 'job.interrupted', subjectType: 'job', subjectId: jobId, details: { reason: holder.reason, previousOwner: job.lockOwner, detectedBy: 'cancel' }, at: now });
          recordAudit(ctx.db, { siteId: ctx.siteId, actor, eventType: 'job.cancelled', subjectType: 'job', subjectId: jobId, details: { previousStatus: job.status, interrupted: holder.reason }, at: now });
          return { jobId, outcome: 'cancelled' as const, previousStatus: job.status, interruptedBecause: holder.reason };
        }
      }
      ctx.db.run('UPDATE jobs SET cancel_requested = 1 WHERE id = ? AND site_id = ?', [jobId, ctx.siteId]);
      const stale = holder.state === 'stale' ? holder.reason : undefined;
      recordAudit(ctx.db, { siteId: ctx.siteId, actor, eventType: 'job.cancel_requested', subjectType: 'job', subjectId: jobId, ...(stale ? { details: { appearsInterrupted: stale } } : {}), at: now });
      if (stale) {
        return {
          jobId,
          outcome: 'cancel_requested' as const,
          previousStatus: job.status,
          appearsInterrupted: stale,
          note: `Its run appears interrupted (${stale}), so it may never reach its next cooperative check. Run \`jobs resume ${jobId}\`: it marks the job interrupted and, because cancellation is now requested, closes it as cancelled without running it.`,
        };
      }
      return { jobId, outcome: 'cancel_requested' as const, previousStatus: job.status, note: 'The running job stops at its next cooperative check (stage boundary or heartbeat).' };
    }
    ctx.db.run(
      `UPDATE jobs SET status = 'cancelled', cancel_requested = 1, finished_at = ?, next_attempt_at = NULL,
         error_json = ? WHERE id = ? AND site_id = ?`,
      [now.toISOString(), JSON.stringify({ code: 'CANCELLED', message: `Cancelled by ${actor} while ${job.status}` }), jobId, ctx.siteId],
    );
    recordAudit(ctx.db, { siteId: ctx.siteId, actor, eventType: 'job.cancelled', subjectType: 'job', subjectId: jobId, details: { previousStatus: job.status }, at: now });
    return { jobId, outcome: 'cancelled' as const, previousStatus: job.status };
  });
}

/**
 * Close a job that never started (still `queued`, no run yet) as `cancelled`
 * with the given error, audited as `job.cancelled` (withoutRun). Used when a
 * foreground command's freshly enqueued job is refused before it could run
 * (e.g. LOCKED: another job holds the site lock), so nothing is left queued
 * for an unattended scheduler tick to pick up later. Returns false (and
 * changes nothing) when the job already moved on (started, or finished
 * elsewhere).
 */
export function closeUnstartedJob(ctx: Pick<AppContext, 'db' | 'siteId' | 'clock'>, jobId: string, error: ErrorInfo, actor = 'system'): boolean {
  const now = ctx.clock.now();
  const safe = redact(error);
  return ctx.db.transaction(() => {
    const r = ctx.db.run(
      `UPDATE jobs SET status = 'cancelled', finished_at = ?, next_attempt_at = NULL, error_json = ?
       WHERE id = ? AND site_id = ? AND status = 'queued' AND attempt = 0`,
      [now.toISOString(), JSON.stringify(safe), jobId, ctx.siteId],
    );
    if (r.changes === 0) return false;
    recordAudit(ctx.db, { siteId: ctx.siteId, actor, eventType: 'job.cancelled', subjectType: 'job', subjectId: jobId, details: { error: safe, withoutRun: true, refused: true }, at: now });
    return true;
  });
}
