import type { AppContext } from '../app/context.js';
import { sleep as defaultSleep } from '../core/concurrency.js';
import { AppError, PolicyDeniedError, ValidationError } from '../core/errors.js';
import { hashObject } from '../core/hash.js';
import { formatUsd } from '../core/money.js';
import { RUNTIME_MODES, modeAtLeast, type RuntimeMode } from '../core/modes.js';
import { NO_RETRY, backoffDelay, type RetryPolicy } from '../core/retry.js';
import { recordAudit } from '../database/audit.js';
import type { BudgetProvider } from '../budgets/types.js';
import { StageBudgetGuard, exhaustedLimits } from './budget-guard.js';
import { CheckpointStore } from './checkpoints.js';
import { errorCodeOf, isRetryableError, toErrorInfo, type ErrorInfo } from './errors.js';
import { isCheckpointReviewed } from './reviews.js';
import { isTerminalState, type DegradedStage, type EngineResult, type EngineStage, type EngineStageContext, type PaidWorkSkipped, type ProviderGate, type StageTools } from './stage.js';
import type { CostAllowance, StageOutcome, StopDecision } from './types.js';

export { runBoundedParallel, MAX_WORKERS, type BoundedParallelOptions, type BoundedParallelResult } from './parallel.js';
export { routeWith, routeAll, type RouteRule, type RouteDecision, type RouteOptions, type AmbiguousClassifier, type ClassifierAnswer } from './router.js';
export { TERMINAL_STATES, defineStage, toolsOf, stageMayPay, paidWorkSkippedReason, type EngineStage, type EngineResult, type StageTools, type ProviderGate, type PaidWorkSkipped } from './stage.js';

/**
 * SEQUENTIAL workflow engine (spec section 4).
 *
 * For each stage, in order:
 *   1. runtime-mode gate (spec 24), prerequisites (a stage runs only when its
 *      predecessors' outputs validated), dry-run gate for paid stages,
 *      circuit-breaker gate for declared providers, budget pre-flight;
 *   2. build the input and validate it with the stage's zod schema;
 *   3. reuse the latest succeeded checkpoint when stage version AND input hash
 *      match (resume after a crash); otherwise
 *   4. check evidence requirements, run with a per-attempt timeout
 *      (AbortSignal), retry only idempotent non-paid stages with backoff,
 *      validate the output, evaluate stopping conditions and next-state
 *      validity, and persist the result as a checkpoint.
 *
 * An aborted attempt (timeout, cancellation, shutdown) is awaited for up to
 * `abortGraceMs` so that neither a retry nor the next job overlaps it. A stage
 * that ignores its signal past the grace period is reported as orphaned: it
 * is never retried, and `onOrphanedStage` lets the job runner keep the site
 * lock until it settles.
 *
 * Every stage result (succeeded, failed attempt, skipped, stopped) is
 * persisted in `checkpoints`. Workflows always run inside a durable job
 * (checkpoints reference jobs.id).
 */

export interface RunSequentialOptions {
  jobId: string;
  /** Aborts the workflow (cancellation, lock loss, shutdown). The abort reason becomes the result error. */
  signal?: AbortSignal;
  /** Circuit breakers for declared stage providers. */
  breakers?: ProviderGate | null;
  /** Called between stages and attempts; may throw (e.g. CANCELLED) to stop the workflow cooperatively. */
  heartbeat?: () => void;
  /** Reuse matching checkpoints (default true). */
  reuseCheckpoints?: boolean;
  /**
   * Explicit human decision to rerun paid stages that were interrupted in an
   * earlier run (after reconciling the provider-side state). Default false.
   */
  rerunAmbiguousPaidStages?: boolean;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  rand?: () => number;
  onStage?: (outcome: StageOutcome) => void;
  /**
   * After a stage attempt is aborted (timeout, cancellation, shutdown), how
   * long to wait for it to actually stop before moving on. Default 5 s.
   */
  abortGraceMs?: number;
  /**
   * Called with a stage's still-pending work when it did not stop within the
   * grace period. The job runner uses it to keep holding the site lock until
   * the work settles. Without it the engine only records a warning.
   */
  onOrphanedStage?: (work: Promise<unknown>, info: { stage: string; attempt: number }) => void;
}

export const DEFAULT_ABORT_GRACE_MS = 5_000;

/** Codes of skips that are a deliberate policy (not a failure): the stage was not supposed to run. */
const POLICY_SKIP_CODES: ReadonlySet<string> = new Set(['MODE_NOT_PERMITTED', 'DRY_RUN']);

const MAX_LOGGED_NOTE_DETAIL = 300;

/**
 * The honest note a stage carried in its OUTPUT (`note: { status, code,
 * detail, nextStep }`, the pipelines' convention in
 * src/workflows/pipelines/common.ts) when it says the stage did not do all of
 * its work, or null for a clean output. Status: skipped | degraded, or
 * `offline` when the code says so (the display status `jobs show` and the
 * pipeline summary use). Only the first line of the detail, bounded.
 */
function incompleteOutputNote(output: unknown): { status: string; code: string | null; detail: string; nextStep: string | null } | null {
  if (!output || typeof output !== 'object') return null;
  const n = (output as { note?: unknown }).note;
  if (!n || typeof n !== 'object') return null;
  const { status, code, detail, nextStep } = n as { status?: unknown; code?: unknown; detail?: unknown; nextStep?: unknown };
  if (typeof status !== 'string' || status === 'succeeded') return null;
  const c = typeof code === 'string' && code ? code : null;
  const firstLine = typeof detail === 'string' ? (detail.split('\n')[0] ?? '') : '';
  return {
    status: c && /OFFLINE/.test(c) ? 'offline' : status,
    code: c,
    detail: firstLine.length > MAX_LOGGED_NOTE_DETAIL ? `${firstLine.slice(0, MAX_LOGGED_NOTE_DETAIL)}...` : firstLine,
    nextStep: typeof nextStep === 'string' && nextStep ? nextStep : null,
  };
}

export interface WorkflowValidation {
  errors: string[];
  warnings: string[];
}

/** Static checks of a workflow definition: names, prerequisites order, next states, allowances. */
export function validateWorkflow(stages: readonly EngineStage[]): WorkflowValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!stages.length) errors.push('workflow has no stages');
  const names = stages.map((s) => s.name);
  const seen = new Set<string>();
  stages.forEach((s, i) => {
    const where = `stage "${s.name}"`;
    if (!s.name || !/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(s.name)) errors.push(`stage #${i + 1} has an invalid name "${s.name}"`);
    if (seen.has(s.name)) errors.push(`duplicate stage name "${s.name}"`);
    seen.add(s.name);
    if (!s.version) errors.push(`${where}: version is required`);
    if (!Number.isInteger(s.timeoutMs) || s.timeoutMs <= 0) errors.push(`${where}: timeoutMs must be a positive integer`);
    const earlier = new Set(names.slice(0, i));
    for (const p of s.prerequisites) {
      if (p === s.name) errors.push(`${where}: cannot be its own prerequisite`);
      else if (!earlier.has(p)) errors.push(`${where}: prerequisite "${p}" must be an earlier stage of this workflow`);
    }
    for (const p of s.optionalPrerequisites ?? []) if (!earlier.has(p)) errors.push(`${where}: optional prerequisite "${p}" must be an earlier stage of this workflow`);
    if (!s.optional) {
      for (const p of s.prerequisites) {
        if (stages.find((x) => x.name === p)?.optional) {
          warnings.push(`${where}: required stage depends on optional stage "${p}"; if "${p}" fails or is unavailable, the workflow stops blocked (list it in optionalPrerequisites to degrade instead)`);
        }
      }
    }
    if (!Array.isArray(s.next) || s.next.length === 0) errors.push(`${where}: next must list at least one valid next state`);
    else {
      const following = stages[i + 1];
      if (following && !s.next.includes(following.name)) errors.push(`${where}: next [${s.next.join(', ')}] does not include the following stage "${following.name}"`);
      if (!following && !s.next.some(isTerminalState)) errors.push(`${where}: last stage must list a terminal state (e.g. "done") in next`);
      for (const n of s.next) if (!isTerminalState(n) && !names.includes(n)) warnings.push(`${where}: next state "${n}" is not a stage of this workflow`);
    }
    if (s.costAllowance !== 'none') {
      if (!Array.isArray(s.costAllowance) || s.costAllowance.length === 0) errors.push(`${where}: costAllowance must be 'none' or a non-empty list`);
      else for (const a of s.costAllowance) if (!Number.isSafeInteger(a.maxMicros) || a.maxMicros < 0) errors.push(`${where}: cost allowance for ${a.provider} must be non-negative integer micros`);
      if (s.retry.maxAttempts > 1) warnings.push(`${where}: paid stage declares ${s.retry.maxAttempts} attempts; paid stages always run with NO_RETRY`);
    } else if (s.retry.maxAttempts > 1 && !s.idempotent) {
      warnings.push(`${where}: declares retries but is not marked idempotent; it will not be retried`);
    }
    if (s.requiredMode && !(RUNTIME_MODES as readonly string[]).includes(s.requiredMode)) errors.push(`${where}: unknown requiredMode ${s.requiredMode}`);
    if (!s.stoppingConditions?.length && s.shouldStop) warnings.push(`${where}: shouldStop is defined but stoppingConditions are not documented`);
  });
  return { errors, warnings };
}

/** Retries only for idempotent stages that spend no money; everything else runs once. */
export function effectiveRetryPolicy(stage: EngineStage): RetryPolicy {
  if (stage.costAllowance !== 'none' || !stage.idempotent) return NO_RETRY;
  return stage.retry.maxAttempts >= 1 ? stage.retry : NO_RETRY;
}

/** Failure codes after which a paid stage's provider-side outcome is unknown. */
const AMBIGUOUS_PAID_CODES: ReadonlySet<string> = new Set(['IN_FLIGHT', 'TIMEOUT', 'CANCELLED', 'INTERRUPTED', 'LOCKED', 'AMBIGUOUS_SUBMISSION']);

function formatIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string[] {
  return error.issues.slice(0, 20).map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`);
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(signal.reason ?? new AppError('CANCELLED', 'aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      p.catch(() => undefined); // the stage may still settle later; never leave an unhandled rejection
      reject(signal.reason ?? new AppError('CANCELLED', 'aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Resolves true when `settled` resolves within `ms`, false otherwise (real timers). */
async function settleWithin(settled: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms));
  });
  try {
    return await Promise.race([settled.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Intersect a stage's declared allowance with the allowance it asks for in
 * this run (`effectiveAllowance`): only declared providers, never above the
 * declared cap. An empty result is 'none'.
 */
export function narrowAllowance(declared: CostAllowance[] | 'none', requested: CostAllowance[] | 'none'): CostAllowance[] | 'none' {
  if (declared === 'none' || requested === 'none' || !Array.isArray(requested)) return 'none';
  const caps = new Map<CostAllowance['provider'], number>();
  for (const a of declared) caps.set(a.provider, (caps.get(a.provider) ?? 0) + a.maxMicros);
  const out: CostAllowance[] = [];
  for (const r of requested) {
    const cap = caps.get(r.provider);
    if (cap === undefined || !Number.isSafeInteger(r.maxMicros) || r.maxMicros <= 0) continue;
    out.push({ provider: r.provider, maxMicros: Math.min(cap, r.maxMicros) });
    caps.delete(r.provider);
  }
  return out.length ? out : 'none';
}

function sameAllowance(a: CostAllowance[] | 'none', b: CostAllowance[] | 'none'): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function jsonRoundTrip(value: unknown): unknown {
  const s = JSON.stringify(value);
  return s === undefined ? undefined : JSON.parse(s);
}

export async function runSequential(
  ctx: AppContext,
  workflowName: string,
  stages: readonly EngineStage[],
  params: Record<string, unknown>,
  opts: RunSequentialOptions,
): Promise<EngineResult> {
  const validation = validateWorkflow(stages);
  if (validation.errors.length) {
    throw new ValidationError(`Workflow "${workflowName}" definition is invalid`, { errors: validation.errors });
  }
  const jobId = opts.jobId;
  const job = ctx.db.get<{ site_id: string }>('SELECT site_id FROM jobs WHERE id = ?', [jobId]);
  if (!job) {
    throw new AppError('NOT_FOUND', `Job ${jobId} not found; workflows run inside a durable job so results can be checkpointed.`, {
      hint: 'Create the job with enqueue() from src/jobs/runner.ts first.',
    });
  }
  if (job.site_id !== ctx.siteId) throw new PolicyDeniedError(`Job ${jobId} belongs to another site`, { jobId });

  const store = new CheckpointStore(ctx.db, ctx.clock);
  const sleep = opts.sleep ?? defaultSleep;
  const graceMs = opts.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new ValidationError('abortGraceMs must be a non-negative number');
  const reuse = opts.reuseCheckpoints !== false;
  const mode: RuntimeMode = ctx.mode;
  const log = ctx.logger.child({ job: jobId, workflow: workflowName });

  const outcomes: StageOutcome[] = [];
  const outputs: Record<string, unknown> = {};
  const degraded: DegradedStage[] = [];
  /** Stages that ran without their optional paid work (listed in `degraded`, but they did run). */
  const ranWithoutPaidWork = new Set<string>();
  const orphaned: EngineResult['orphaned'] = [];
  /** Why a stage has no output: a deliberate policy skip (mode, dry run) or a failure/unavailability. */
  const missingCause = new Map<string, { cause: 'policy' | 'failure'; code: string }>();
  const warnings = [...validation.warnings];
  let status: EngineResult['status'] = 'succeeded';
  let stoppedBy: EngineResult['stoppedBy'];
  let failure: EngineResult['failure'];

  const emit = (o: StageOutcome) => {
    outcomes.push(o);
    opts.onStage?.(o);
  };

  /** Throws the abort reason when the parent signal fired or the heartbeat says stop. */
  const checkParent = () => {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new AppError('CANCELLED', 'Workflow aborted');
    opts.heartbeat?.();
  };

  const parentAbortResult = (err: unknown, stageName: string) => {
    const info = toErrorInfo(err, 'CANCELLED');
    if (info.code === 'CANCELLED') status = 'cancelled';
    else {
      status = 'failed';
      failure = { stage: stageName, code: info.code, message: info.message, retryable: false };
    }
    return info;
  };

  recordAudit(ctx.db, {
    siteId: ctx.siteId,
    actor: 'system',
    eventType: 'workflow.started',
    subjectType: 'job',
    subjectId: jobId,
    details: { workflow: workflowName, stages: stages.map((s) => `${s.name}@${s.version}`), mode, dryRun: ctx.dryRun },
    at: ctx.clock.now(),
  });
  log.info(`Workflow ${workflowName} started`, { stages: stages.length, mode });

  let index = 0;
  for (; index < stages.length; index++) {
    const stage = stages[index]!;
    const started = Date.now();
    try {
      checkParent();
    } catch (err) {
      const info = parentAbortResult(err, stage.name);
      emit({ stage: stage.name, status: 'skipped', resumedFromCheckpoint: false, error: { code: info.code, message: info.message }, durationMs: 0 });
      index++;
      break;
    }

    const skip = (code: string, reason: string, cause: 'policy' | 'failure' = POLICY_SKIP_CODES.has(code) ? 'policy' : 'failure') => {
      store.save({ siteId: ctx.siteId, jobId, workflow: workflowName, stage: stage.name, stageVersion: stage.version, status: 'skipped', error: { code, message: reason }, attempt: 0, durationMs: 0 });
      missingCause.set(stage.name, { cause, code });
      degraded.push({ stage: stage.name, code, reason });
      emit({ stage: stage.name, status: 'skipped', resumedFromCheckpoint: false, error: { code, message: reason }, durationMs: Date.now() - started });
      log.warn(`Stage ${stage.name} skipped: ${reason}`, { code });
    };

    const blockStop = (code: string, reason: string) => {
      const decision = { stop: true as const, reason, status: 'blocked' as const };
      store.save({ siteId: ctx.siteId, jobId, workflow: workflowName, stage: stage.name, stageVersion: stage.version, status: 'stopped', error: { code, message: reason }, attempt: 0, durationMs: 0 });
      emit({ stage: stage.name, status: 'stopped', resumedFromCheckpoint: false, stop: decision, error: { code, message: reason }, durationMs: Date.now() - started });
      status = 'stopped';
      stoppedBy = { stage: stage.name, decision, code };
      log.warn(`Workflow stopped at ${stage.name}: ${reason}`, { code });
    };

    const failWorkflow = (info: ErrorInfo, retryable: boolean, retryAfter?: string | null) => {
      status = 'failed';
      failure = { stage: stage.name, code: info.code, message: info.message, retryable, ...(retryable && retryAfter ? { retryAfter } : {}) };
    };
    /** An optional stage failed or was unavailable: the workflow continues without its output. */
    const degrade = (code: string, reason: string) => {
      missingCause.set(stage.name, { cause: 'failure', code });
      degraded.push({ stage: stage.name, code, reason });
    };

    // 1. Runtime mode gate (spec 24).
    if (stage.requiredMode && !modeAtLeast(mode, stage.requiredMode)) {
      skip('MODE_NOT_PERMITTED', `requires ${stage.requiredMode} mode; running in ${mode}`);
      continue;
    }
    // 2. Prerequisites: every required predecessor output must exist (and has been validated).
    //    A missing output caused by policy (mode, dry run) skips this stage too. A missing output
    //    caused by a failure means a required stage cannot do its work: the workflow stops blocked
    //    instead of reporting success.
    const missing = stage.prerequisites.filter((p) => !(p in outputs));
    if (missing.length) {
      const failed = missing.filter((p) => missingCause.get(p)?.cause !== 'policy');
      const describe = (names: string[]) => names.map((p) => `${p} (${missingCause.get(p)?.code ?? 'no output'})`).join(', ');
      if (failed.length && !stage.optional) {
        blockStop('PREREQUISITE_UNSATISFIED', `required stage "${stage.name}" cannot run: prerequisite(s) ${describe(failed)} produced no validated output`);
        index++;
        break;
      }
      skip('PREREQUISITE_UNSATISFIED', `requires validated output of ${describe(missing)}`, failed.length ? 'failure' : 'policy');
      continue;
    }
    // 3. Build and validate the input (buildInput must be side-effect free: it also runs when a checkpoint is reused).
    //    The allowance (and so the guard) may still be narrowed below: effectiveAllowance, or optional paid work dropped.
    let allowance: CostAllowance[] | 'none' = stage.costAllowance;
    let paidWorkSkipped: PaidWorkSkipped | null = null;
    let guard = new StageBudgetGuard(ctx.budgets, ctx.siteId, jobId, stage.name, allowance);
    const stageLogger = log.child({ stage: stage.name });
    let stageApp: AppContext = { ...ctx, runId: jobId, budgets: guard.proxy(), logger: stageLogger };
    const useAllowance = (next: CostAllowance[] | 'none') => {
      allowance = next;
      guard = new StageBudgetGuard(ctx.budgets, ctx.siteId, jobId, stage.name, next);
      stageApp = { ...stageApp, budgets: guard.proxy() };
    };
    /** A paidWorkOptional stage runs without any allowance: recorded as degraded, never as skipped. */
    const dropPaidWork = (code: PaidWorkSkipped['code'], reason: string) => {
      useAllowance('none');
      paidWorkSkipped = { code, reason };
      ranWithoutPaidWork.add(stage.name);
      degraded.push({ stage: stage.name, code, reason: `${reason}; the stage ran without its optional paid work` });
      log.warn(`Stage ${stage.name} runs without its optional paid work: ${reason}`, { code });
    };
    const priorNames = [...stage.prerequisites, ...(stage.optionalPrerequisites ?? [])];
    const prior: Record<string, unknown> = {};
    for (const p of priorNames) if (p in outputs) prior[p] = outputs[p];
    const firstAttempt = store.nextAttempt(ctx.siteId, jobId, stage.name);
    const makeCtx = (signal: AbortSignal, attempt: number, deadline: Date): EngineStageContext => {
      const tools: StageTools = {
        budget: guard,
        breakers: opts.breakers ?? null,
        logger: stageLogger,
        mode,
        deadline: deadline.toISOString(),
        checkpointHeartbeat: checkParent,
        paidWorkSkipped,
      };
      return { app: stageApp, jobId, workflow: workflowName, prior, signal, attempt, tools };
    };
    const baseSignal = opts.signal ?? new AbortController().signal;

    let input: unknown;
    try {
      input = await stage.buildInput(makeCtx(baseSignal, firstAttempt, new Date(Date.now() + stage.timeoutMs)), params);
    } catch (err) {
      if (opts.signal?.aborted) {
        parentAbortResult(opts.signal.reason, stage.name);
        index++;
        break;
      }
      const info: ErrorInfo = { ...toErrorInfo(err), code: errorCodeOf(err) === 'INTERNAL' ? 'BUILD_INPUT_FAILED' : errorCodeOf(err) };
      store.save({ siteId: ctx.siteId, jobId, workflow: workflowName, stage: stage.name, stageVersion: stage.version, status: 'failed', error: info, attempt: firstAttempt, durationMs: Date.now() - started });
      emit({ stage: stage.name, status: 'failed', resumedFromCheckpoint: false, error: { code: info.code, message: info.message }, durationMs: Date.now() - started });
      if (stage.optional) {
        degrade(info.code, info.message);
        continue;
      }
      failWorkflow(info, false);
      index++;
      break;
    }
    const parsedInput = stage.input.safeParse(input);
    if (!parsedInput.success) {
      const issues = formatIssues(parsedInput.error);
      const info: ErrorInfo = { code: 'VALIDATION_FAILED', message: `Stage "${stage.name}" input failed schema validation: ${issues.join('; ')}`, details: { stage: stage.name, side: 'input', issues } };
      store.save({ siteId: ctx.siteId, jobId, workflow: workflowName, stage: stage.name, stageVersion: stage.version, status: 'failed', error: info, attempt: firstAttempt, durationMs: Date.now() - started });
      emit({ stage: stage.name, status: 'failed', resumedFromCheckpoint: false, error: { code: info.code, message: info.message }, durationMs: Date.now() - started });
      if (stage.optional) {
        degrade(info.code, info.message);
        continue;
      }
      failWorkflow(info, false);
      index++;
      break;
    }
    const stageInput = parsedInput.data;
    // The hash covers everything the stage can see: its validated input AND the prior outputs in ctx.prior.
    const inputHash = hashObject({ input: stageInput, prior });
    // Declare only the allowance this run can actually use (never more than declared).
    if (stage.effectiveAllowance && stage.costAllowance !== 'none') {
      try {
        const narrowed = narrowAllowance(stage.costAllowance, stage.effectiveAllowance(stageInput, makeCtx(baseSignal, firstAttempt, new Date(Date.now() + stage.timeoutMs))));
        if (!sameAllowance(narrowed, stage.costAllowance)) useAllowance(narrowed);
      } catch (err) {
        // Conservative: keep the declared allowance (every gate below still applies to it).
        warnings.push(`stage "${stage.name}": effectiveAllowance failed (${toErrorInfo(err).message}); the declared allowance is used`);
      }
    }

    // Resume: reuse the last succeeded checkpoint when version and input hash match (before any gate,
    // so a completed stage is never blocked by a budget it already spent or a provider that is now down).
    const evaluateStop = (output: unknown, sctx: EngineStageContext): { decision: StopDecision; error?: ErrorInfo } => {
      if (!stage.shouldStop) return { decision: { stop: false } };
      try {
        const decision = stage.shouldStop(output, sctx) ?? { stop: false };
        if (decision.stop && !stage.next.includes(decision.status)) {
          return {
            decision,
            error: { code: 'INVALID_TRANSITION', message: `Stage "${stage.name}" stopped with "${decision.status}", which is not among its declared next states [${stage.next.join(', ')}]` },
          };
        }
        return { decision };
      } catch (err) {
        return { decision: { stop: false }, error: toErrorInfo(err) };
      }
    };

    if (reuse) {
      const cp = store.latestWithOutput(ctx.siteId, jobId, stage.name);
      if (cp && cp.row.stage_version === stage.version && cp.row.input_hash === inputHash) {
        const parsedOut = stage.output.safeParse(cp.output);
        if (parsedOut.success) {
          const sctx = makeCtx(baseSignal, cp.row.attempt, new Date());
          const ev = evaluateStop(parsedOut.data, sctx);
          if (!ev.error) {
            outputs[stage.name] = parsedOut.data;
            if (ev.decision.stop && ev.decision.status === 'needs_review' && isCheckpointReviewed(ctx.db, ctx.siteId, cp.row.id)) {
              // A human recorded a review of exactly this output (`jobs resume <id> --reviewed <stage>`): continue past the stop.
              emit({ stage: stage.name, status: 'succeeded', resumedFromCheckpoint: true, output: parsedOut.data, durationMs: Date.now() - started });
              warnings.push(`stage "${stage.name}": human review recorded for checkpoint ${cp.row.id}; continuing past needs_review`);
              log.info(`Stage ${stage.name} reviewed; continuing`, { checkpoint: cp.row.id });
              continue;
            }
            if (ev.decision.stop) {
              emit({ stage: stage.name, status: 'stopped', resumedFromCheckpoint: true, output: parsedOut.data, stop: ev.decision, durationMs: Date.now() - started });
              status = 'stopped';
              stoppedBy = { stage: stage.name, decision: ev.decision };
              index++;
              break;
            }
            emit({ stage: stage.name, status: 'succeeded', resumedFromCheckpoint: true, output: parsedOut.data, durationMs: Date.now() - started });
            const reusedNote = incompleteOutputNote(parsedOut.data);
            log.info(`Stage ${stage.name} reused checkpoint ${cp.row.id}${reusedNote ? ` (recorded as ${reusedNote.status}${reusedNote.code ? `: ${reusedNote.code}` : ''})` : ''}`);
            continue;
          }
        } else {
          warnings.push(`stage "${stage.name}": stored checkpoint no longer matches the output schema; rerunning`);
        }
      }
    }

    // 4. Dry run never spends money.
    if (ctx.dryRun && allowance !== 'none') {
      const caps = allowance.map((a) => `${a.provider} up to ${formatUsd(a.maxMicros)}`).join(', ');
      skip('DRY_RUN', `dry run: paid stage not executed (would be allowed to spend ${caps})`);
      continue;
    }
    // 5. Circuit breakers for declared providers. A provider that only the optional paid work of a
    //    paidWorkOptional stage needs does not block it: the stage runs without that paid work.
    let gateBlocked: { provider: string; reason: string; nextProbeAt: string | null } | undefined;
    let paidProviderBlocked: { provider: string; reason: string } | undefined;
    if (opts.breakers) {
      const paidProviders = new Set<string>(allowance === 'none' ? [] : allowance.map((a) => a.provider));
      for (const p of stage.providers ?? []) {
        const d = opts.breakers.peek(p);
        if (d.allowed) continue;
        if (stage.paidWorkOptional && paidProviders.has(p)) {
          paidProviderBlocked ??= { provider: p, reason: `provider ${p} unavailable: ${d.reason}${d.nextProbeAt ? ` (next probe after ${d.nextProbeAt})` : ''}` };
          continue;
        }
        gateBlocked = { provider: p, reason: d.reason, nextProbeAt: d.nextProbeAt };
        break;
      }
    }
    if (paidProviderBlocked && !gateBlocked) dropPaidWork('INTEGRATION_UNAVAILABLE', paidProviderBlocked.reason);
    if (gateBlocked) {
      const reason = `provider ${gateBlocked.provider} unavailable: ${gateBlocked.reason}${gateBlocked.nextProbeAt ? ` (next probe after ${gateBlocked.nextProbeAt})` : ''}`;
      if (stage.optional) {
        skip('INTEGRATION_UNAVAILABLE', reason);
        continue;
      }
      store.save({ siteId: ctx.siteId, jobId, workflow: workflowName, stage: stage.name, stageVersion: stage.version, status: 'skipped', error: { code: 'INTEGRATION_UNAVAILABLE', message: reason }, attempt: 0, durationMs: 0 });
      emit({ stage: stage.name, status: 'skipped', resumedFromCheckpoint: false, error: { code: 'INTEGRATION_UNAVAILABLE', message: reason }, durationMs: 0 });
      // Nothing was sent, so a later job-level retry is safe, but not before the breaker allows a probe.
      failWorkflow({ code: 'INTEGRATION_UNAVAILABLE', message: reason }, true, gateBlocked.nextProbeAt);
      index++;
      break;
    }
    // 6. Budget pre-flight: never start a paid stage whose budget is already exhausted. A stage whose
    //    paid work is optional runs without it instead (degraded, never a lost run).
    if (allowance !== 'none') {
      const exhausted = allowance.flatMap((a) => exhaustedLimits(ctx.budgets, ctx.siteId, a.provider, jobId).map((c) => ({ provider: a.provider, ...c })));
      if (exhausted.length) {
        const e = exhausted[0]!;
        const reason = `${e.provider} budget exhausted (${e.scope}: ${formatUsd(e.committedMicros)} committed of ${formatUsd(e.limitMicros)})`;
        if (stage.paidWorkOptional) {
          dropPaidWork('BUDGET_EXCEEDED', reason);
        } else {
          if (stage.optional) {
            skip('BUDGET_EXCEEDED', reason);
            continue;
          }
          blockStop('BUDGET_EXCEEDED', reason);
          index++;
          break;
        }
      }
    }

    // 7. Evidence requirements.
    let evidenceProblems: string[] = [];
    if (stage.evidence.check) {
      try {
        evidenceProblems = stage.evidence.check(stageInput, makeCtx(baseSignal, firstAttempt, new Date(Date.now() + stage.timeoutMs)));
      } catch (err) {
        evidenceProblems = [`evidence check failed: ${toErrorInfo(err).message}`];
      }
    }
    if (evidenceProblems.length) {
      const reason = `evidence requirement not met (${stage.evidence.requirement}): ${evidenceProblems.join('; ')}`;
      if (stage.optional) {
        skip('EVIDENCE_INSUFFICIENT', reason);
        continue;
      }
      blockStop('EVIDENCE_INSUFFICIENT', reason);
      index++;
      break;
    }

    // 8. Paid stages are never blindly re-executed: if an earlier run of this job stopped while this
    //    stage was in flight (crash, timeout, cancellation, lock loss), the provider may already have
    //    accepted the request. Require reconciliation and an explicit rerun decision. A stage that
    //    runs without any allowance in this attempt cannot spend, so it cannot spend twice either.
    const paid = allowance !== 'none';
    if (paid) {
      const last = store.latestAttempt(ctx.siteId, jobId, stage.name);
      const lastCode = last?.error?.code;
      if (last && lastCode && AMBIGUOUS_PAID_CODES.has(lastCode)) {
        if (!opts.rerunAmbiguousPaidStages) {
          blockStop(
            'AMBIGUOUS_SUBMISSION',
            `paid stage "${stage.name}" did not finish in an earlier run (${lastCode} at ${last.createdAt}); the provider may have accepted and charged the request. Reconcile it first (\`costs --unresolved\`, provider history), then rerun explicitly with \`jobs resume ${jobId} --rerun-paid-stages\`.`,
          );
          index++;
          break;
        }
        warnings.push(`stage "${stage.name}": rerunning a paid stage that was interrupted earlier (${lastCode}); explicitly authorized`);
        recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'cli', eventType: 'workflow.paid_stage_rerun_authorized', subjectType: 'job', subjectId: jobId, details: { stage: stage.name, previous: lastCode }, at: ctx.clock.now() });
      }
    }

    // 9. Run with timeout and (only for idempotent, non-paid stages) retries.
    const policy = effectiveRetryPolicy(stage);
    let succeeded: { output: unknown; attempt: number; durationMs: number; sctx: EngineStageContext } | undefined;
    let lastError: ErrorInfo | undefined;
    let lastRetryable = false;
    let aborted = false;
    for (let a = 0; a < policy.maxAttempts; a++) {
      const attempt = firstAttempt + a;
      try {
        checkParent();
      } catch (err) {
        lastError = parentAbortResult(err, stage.name);
        aborted = true;
        break;
      }
      const attemptStarted = Date.now();
      if (paid) {
        // In-flight marker: if the process dies during this attempt, resume sees it and refuses a blind rerun.
        store.save({ siteId: ctx.siteId, jobId, workflow: workflowName, stage: stage.name, stageVersion: stage.version, status: 'failed', inputHash, error: { code: 'IN_FLIGHT', message: 'paid stage started; superseded by the final result of this attempt' }, attempt, durationMs: null });
      }
      const attemptCtl = new AbortController();
      const timer = setTimeout(
        () => attemptCtl.abort(new AppError('TIMEOUT', `Stage "${stage.name}" timed out after ${stage.timeoutMs}ms (attempt ${attempt})`)),
        stage.timeoutMs,
      );
      const signal = opts.signal ? AbortSignal.any([opts.signal, attemptCtl.signal]) : attemptCtl.signal;
      const sctx = makeCtx(signal, attempt, new Date(attemptStarted + stage.timeoutMs));
      const work = Promise.resolve().then(() => stage.run(stageInput, sctx));
      const settled = work.then(
        () => undefined,
        () => undefined,
      );
      try {
        const raw = await raceAbort(work, signal);
        const parsedOut = stage.output.safeParse(raw);
        if (!parsedOut.success) {
          const issues = formatIssues(parsedOut.error);
          throw new ValidationError(`Stage "${stage.name}" output failed schema validation: ${issues.join('; ')}`, { stage: stage.name, side: 'output', issues });
        }
        succeeded = { output: parsedOut.data, attempt, durationMs: Date.now() - attemptStarted, sctx };
        break;
      } catch (err) {
        // The attempt was told to stop: wait (bounded) until it really has, so that neither a retry
        // nor the next job of the site overlaps it. A stage that ignores its signal is orphaned.
        let orphanNote = '';
        if (signal.aborted) {
          clearTimeout(timer);
          if (!(await settleWithin(settled, graceMs))) {
            orphaned.push({ stage: stage.name, attempt });
            orphanNote = `; the stage did not stop within ${graceMs}ms after being aborted and may still be running, so it is not retried`;
            if (opts.onOrphanedStage) opts.onOrphanedStage(settled, { stage: stage.name, attempt });
            else warnings.push(`stage "${stage.name}" (attempt ${attempt}) ignored its abort signal and may still be running in the background`);
            log.warn(`Stage ${stage.name} attempt ${attempt} did not stop within ${graceMs}ms after abort`, { stage: stage.name });
          }
        }
        if (opts.signal?.aborted) {
          const info = parentAbortResult(opts.signal.reason, stage.name);
          const saved = orphanNote ? { ...info, message: `${info.message}${orphanNote}` } : info;
          store.save({ siteId: ctx.siteId, jobId, workflow: workflowName, stage: stage.name, stageVersion: stage.version, status: 'failed', inputHash, error: saved, attempt, durationMs: Date.now() - attemptStarted });
          lastError = saved;
          aborted = true;
          break;
        }
        const effective = attemptCtl.signal.aborted ? attemptCtl.signal.reason : err;
        const base = toErrorInfo(effective);
        const info = orphanNote ? { ...base, message: `${base.message}${orphanNote}` } : base;
        lastError = info;
        lastRetryable = !orphanNote && isRetryableError(effective);
        store.save({ siteId: ctx.siteId, jobId, workflow: workflowName, stage: stage.name, stageVersion: stage.version, status: 'failed', inputHash, error: info, attempt, durationMs: Date.now() - attemptStarted });
        log.warn(`Stage ${stage.name} attempt ${attempt} failed: ${info.message}`, { code: info.code });
        const more = a + 1 < policy.maxAttempts;
        if (!more || !lastRetryable) break;
        const delay = backoffDelay(a + 1, policy, opts.rand);
        try {
          await sleep(delay, opts.signal);
        } catch (sleepErr) {
          lastError = parentAbortResult(opts.signal?.reason ?? sleepErr, stage.name);
          aborted = true;
          break;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    if (aborted) {
      emit({ stage: stage.name, status: 'failed', resumedFromCheckpoint: false, ...(lastError ? { error: { code: lastError.code, message: lastError.message } } : {}), durationMs: Date.now() - started });
      index++;
      break;
    }

    if (!succeeded) {
      const info = lastError ?? { code: 'INTERNAL', message: 'stage produced no result' };
      emit({ stage: stage.name, status: 'failed', resumedFromCheckpoint: false, error: { code: info.code, message: info.message }, durationMs: Date.now() - started });
      if (stage.optional) {
        degrade(info.code, info.message);
        continue;
      }
      // A job-level retry reruns this stage, so it is only safe for idempotent, non-paid stages.
      failWorkflow(info, lastRetryable && stage.idempotent === true && stage.costAllowance === 'none');
      index++;
      break;
    }

    // 10. Stopping conditions and next-state validity, then persist.
    const ev = evaluateStop(succeeded.output, succeeded.sctx);
    if (ev.error) {
      store.save({ siteId: ctx.siteId, jobId, workflow: workflowName, stage: stage.name, stageVersion: stage.version, status: 'failed', inputHash, error: ev.error, attempt: succeeded.attempt, durationMs: succeeded.durationMs });
      emit({ stage: stage.name, status: 'failed', resumedFromCheckpoint: false, error: { code: ev.error.code, message: ev.error.message }, durationMs: Date.now() - started });
      failWorkflow(ev.error, false);
      index++;
      break;
    }
    const roundTrip = jsonRoundTrip(succeeded.output);
    if (roundTrip === undefined || !stage.output.safeParse(roundTrip).success) {
      warnings.push(`stage "${stage.name}": output is not JSON round-trippable; its checkpoint cannot be reused on resume`);
    }
    const reserved = Object.fromEntries(Object.keys(guard.caps).map((p) => [p, guard.reservedMicros(p as BudgetProvider)]));
    const unknownPrice = Object.fromEntries(
      Object.keys(guard.caps)
        .map((p) => [p, guard.unknownPriceReservations(p as BudgetProvider)] as const)
        .filter(([, n]) => n > 0),
    );
    store.save({
      siteId: ctx.siteId,
      jobId,
      workflow: workflowName,
      stage: stage.name,
      stageVersion: stage.version,
      status: ev.decision.stop ? 'stopped' : 'succeeded',
      inputHash,
      output: succeeded.output,
      attempt: succeeded.attempt,
      durationMs: succeeded.durationMs,
    });
    outputs[stage.name] = succeeded.output;
    if (ev.decision.stop) {
      emit({ stage: stage.name, status: 'stopped', resumedFromCheckpoint: false, output: succeeded.output, stop: ev.decision, durationMs: Date.now() - started });
      status = 'stopped';
      stoppedBy = { stage: stage.name, decision: ev.decision };
      log.info(`Workflow stopped at ${stage.name}: ${ev.decision.reason}`, { status: ev.decision.status });
      index++;
      break;
    }
    emit({ stage: stage.name, status: 'succeeded', resumedFromCheckpoint: false, output: succeeded.output, durationMs: Date.now() - started });
    const logFields = {
      attempt: succeeded.attempt,
      // Known upper bounds only; approved unknown-price reservations are reported separately (their cost is unknown, not 0).
      ...(Object.keys(reserved).length ? { reservedMicros: reserved } : {}),
      ...(Object.keys(unknownPrice).length ? { unknownPriceReservations: unknownPrice } : {}),
    };
    // A stage whose own output note says it did not do all of its work (offline, skipped, degraded) is
    // logged as such, at warn level like an engine-level skip: never "succeeded" (spec 31).
    const outNote = incompleteOutputNote(succeeded.output);
    if (outNote) {
      log.warn(`Stage ${stage.name} ${outNote.status}: ${outNote.code ? `${outNote.code}: ` : ''}${outNote.detail}`, { ...logFields, status: outNote.status, code: outNote.code, ...(outNote.nextStep ? { nextStep: outNote.nextStep } : {}) });
    } else {
      log.info(`Stage ${stage.name} succeeded`, logFields);
    }
  }

  // Stages never reached (after a failure, stop, or cancellation).
  for (; index < stages.length; index++) {
    const s = stages[index]!;
    if (outcomes.some((o) => o.stage === s.name)) continue;
    emit({ stage: s.name, status: 'skipped', resumedFromCheckpoint: false, error: { code: 'NOT_REACHED', message: `not reached (workflow ${status})` }, durationMs: 0 });
  }

  const optionalNames = new Set(stages.filter((s) => s.optional).map((s) => s.name));
  // A required stage that ran without its optional paid work did run: it is degraded, not skipped.
  const skippedRequired = degraded.filter((d) => !optionalNames.has(d.stage) && !ranWithoutPaidWork.has(d.stage));
  const result: EngineResult = {
    workflow: workflowName,
    jobId,
    status,
    stages: outcomes,
    outputs,
    degraded,
    skippedRequired,
    orphaned,
    warnings,
    runtimeMode: mode,
    dryRun: ctx.dryRun,
    ...(stoppedBy ? { stoppedBy } : {}),
    ...(failure ? { failure } : {}),
  };
  recordAudit(ctx.db, {
    siteId: ctx.siteId,
    actor: 'system',
    eventType: 'workflow.finished',
    subjectType: 'job',
    subjectId: jobId,
    details: {
      workflow: workflowName,
      status,
      stages: outcomes.map((o) => ({ stage: o.stage, status: o.status, resumed: o.resumedFromCheckpoint, code: o.error?.code })),
      degraded,
      ...(orphaned.length ? { orphaned } : {}),
      ...(failure ? { failure } : {}),
      ...(stoppedBy ? { stoppedBy } : {}),
    },
    at: ctx.clock.now(),
  });
  log.info(`Workflow ${workflowName} finished: ${status}`, { degraded: degraded.length });
  return result;
}

/** Compact, JSON-safe summary of a workflow result (no stage outputs) for job result records. */
export function summarizeWorkflow(r: EngineResult): Record<string, unknown> {
  return {
    workflow: r.workflow,
    status: r.status,
    runtimeMode: r.runtimeMode,
    dryRun: r.dryRun,
    stages: r.stages.map((s) => ({
      stage: s.stage,
      status: s.status,
      resumedFromCheckpoint: s.resumedFromCheckpoint,
      durationMs: s.durationMs,
      ...(s.error ? { error: s.error } : {}),
      ...(s.stop && s.stop.stop ? { stop: { status: s.stop.status, reason: s.stop.reason } } : {}),
    })),
    degraded: r.degraded,
    skippedRequired: r.skippedRequired,
    ...(r.orphaned.length ? { orphaned: r.orphaned } : {}),
    warnings: r.warnings,
    ...(r.stoppedBy ? { stoppedBy: { stage: r.stoppedBy.stage, status: r.stoppedBy.decision.status, reason: r.stoppedBy.decision.reason, code: r.stoppedBy.code } } : {}),
    ...(r.failure ? { failure: r.failure } : {}),
  };
}
