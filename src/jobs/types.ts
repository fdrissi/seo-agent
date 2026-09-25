import type { z } from 'zod';
import type { AppContext } from '../app/context.js';
import type { RuntimeMode } from '../core/modes.js';
import type { ErrorInfo } from '../workflows/errors.js';
import type { ProviderGate } from '../workflows/stage.js';

/** Job statuses (CHECK constraint in migrations/0001_core.sql). */
export const JOB_STATUSES = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];

export interface JobRow {
  id: string;
  site_id: string;
  type: string;
  status: JobStatus;
  mode: RuntimeMode;
  params_json: string | null;
  dry_run: number;
  attempt: number;
  max_attempts: number;
  next_attempt_at: string | null;
  cancel_requested: number;
  parent_job_id: string | null;
  trace_id: string | null;
  error_json: string | null;
  result_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
  lock_owner: string | null;
}

export interface JobRecord {
  id: string;
  siteId: string;
  type: string;
  status: JobStatus;
  mode: RuntimeMode;
  params: Record<string, unknown>;
  dryRun: boolean;
  /** Number of runs started (job_runs rows). */
  attempt: number;
  /** Maximum number of FAILED runs before the job stays failed (interrupted runs do not count). */
  maxAttempts: number;
  nextAttemptAt: string | null;
  cancelRequested: boolean;
  parentJobId: string | null;
  traceId: string | null;
  error: ErrorInfo | null;
  result: unknown;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
  lockOwner: string | null;
}

export type JobRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface JobRunRecord {
  id: string;
  jobId: string;
  siteId: string;
  attempt: number;
  status: JobRunStatus;
  pid: number | null;
  hostname: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: ErrorInfo | null;
}

/** What a job handler reports back. Handlers may also simply throw. */
export type JobOutcome =
  | { status: 'succeeded'; result?: unknown }
  | { status: 'waiting'; reason: string; result?: unknown }
  | {
      status: 'failed';
      error: ErrorInfo;
      retryable: boolean;
      result?: unknown;
      /**
       * Earliest ISO instant a retry can help (e.g. an open circuit breaker's
       * next probe). The runner never schedules the retry before it.
       */
      retryAfter?: string;
    };

export const jobSucceeded = (result?: unknown): JobOutcome => (result === undefined ? { status: 'succeeded' } : { status: 'succeeded', result });
export const jobWaiting = (reason: string, result?: unknown): JobOutcome => (result === undefined ? { status: 'waiting', reason } : { status: 'waiting', reason, result });
export const jobFailed = (error: ErrorInfo, retryable: boolean, result?: unknown, opts: { retryAfter?: string } = {}): JobOutcome => ({
  status: 'failed',
  error,
  retryable,
  ...(result === undefined ? {} : { result }),
  ...(opts.retryAfter ? { retryAfter: opts.retryAfter } : {}),
});

export interface JobHandlerContext {
  /** Site context with runId = job id, and the job's recorded mode and dry-run flag. */
  app: AppContext;
  job: JobRecord;
  /** 1-based number of this run (job_runs.attempt). */
  attempt: number;
  /** Aborted on cancellation (CANCELLED), lock loss (LOCKED), or runner shutdown. */
  signal: AbortSignal;
  /** Extends the site lock lease and job heartbeat; throws when the job must stop (cancelled / lock lost). */
  heartbeat(): void;
  isCancelRequested(): boolean;
  /** Per-site circuit breakers (provider health). */
  breakers: ProviderGate;
  /** True when a previous run of this job exists (checkpoints may be reused). */
  resumed: boolean;
  /** Explicit human overrides for this run (e.g. `jobs resume <id> --rerun-paid-stages`). */
  overrides: { rerunAmbiguousPaidStages: boolean };
  /**
   * Work that may still be running after the handler returns (a workflow stage
   * that ignored its AbortSignal past the grace period). The runner keeps the
   * site lock held, renewing its lease, until every registered promise
   * settles, so no other job of the site can start while it runs.
   */
  keepLockUntilSettled(work: Promise<unknown>, label: string): void;
}

export interface JobHandler<P extends Record<string, unknown> = Record<string, unknown>> {
  type: string;
  description: string;
  /** Validates params at enqueue and before each run. */
  paramsSchema?: z.ZodType<P>;
  /**
   * Lock that makes runs non-overlapping. Default 'site': at most one job
   * holding the site lock runs per site at a time. A separate queue (e.g.
   * optional content discovery) may use its own lock name.
   */
  lockName?: string;
  /** Default max failed attempts for jobs of this type (enqueue may override). */
  maxAttempts?: number;
  /**
   * When the handler THROWS, the runner retries (with backoff, up to
   * maxAttempts) only if this is true and the error is transient. Handlers
   * that may submit paid requests must leave this false and report failures
   * through `jobFailed(error, retryable)` so paid POSTs are never blindly
   * retried. Default false.
   */
  idempotent?: boolean;
  run(ctx: JobHandlerContext, params: P): Promise<JobOutcome>;
}
