import type { Logger } from '../core/logger.js';
import type { Micros } from '../core/money.js';
import type { RuntimeMode } from '../core/modes.js';
import { AppError } from '../core/errors.js';
import type { BudgetProvider, Reservation, ReserveRequest } from '../budgets/types.js';
import type { CostAllowance, StageContext, StageDefinition, StopDecision, WorkflowResult } from './types.js';

/**
 * Engine-level extensions to the shared `StageDefinition` contract
 * (src/workflows/types.ts is the frozen interface; these optional fields are
 * layered on top so existing stage definitions stay valid).
 */

/**
 * Terminal states a stage may list in `next`. `done` is the normal end of a
 * workflow; the others are the statuses a `shouldStop` decision may return.
 */
export const TERMINAL_STATES = ['done', 'completed_early', 'blocked', 'needs_review', 'no_action'] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

export function isTerminalState(s: string): s is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(s);
}

export interface StageExtensions {
  /**
   * Retries happen ONLY for stages marked idempotent that spend no money.
   * Paid stages always run with NO_RETRY (a timeout may mean the provider
   * accepted the job; see src/core/retry.ts). Default false.
   */
  idempotent?: boolean;
  /** Minimum runtime mode (spec section 24). Lower modes skip the stage with an honest reason. Default ANALYZE. */
  requiredMode?: RuntimeMode;
  /**
   * Optional stages degrade the workflow instead of failing it: when they are
   * skipped (mode, circuit open, budget exhausted, evidence missing) or fail,
   * the workflow continues and the reason is listed in `degraded`.
   */
  optional?: boolean;
  /** Earlier stages whose outputs are passed in `prior` when available, without being required. */
  optionalPrerequisites?: string[];
  /** External providers the stage depends on; checked against circuit breakers before the stage runs. */
  providers?: string[];
  /**
   * The stage's paid work is OPTIONAL: it declares a cost allowance for an
   * optional paid call (a cheap-model hook, a model summary, embeddings) but
   * produces its output without it. When a declared provider's budget is
   * exhausted, or the circuit breaker of a provider that only the paid work
   * needs is open, the engine runs the stage WITHOUT any allowance (every
   * reservation is refused; `tools.paidWorkSkipped` says why) and records a
   * degraded entry, instead of skipping an optional stage or stopping the
   * workflow at a required one. The stage must check its allowance
   * (`stageMayPay`) before a paid call. Default false.
   */
  paidWorkOptional?: boolean;
  /**
   * Narrow the declared cost allowance for this run once the stage's validated
   * input is known (for example, a report needs its LLM allowance only when an
   * earlier stage approved a model summary). Return 'none' when no paid call
   * can happen. The result can only reduce the declared caps: providers that
   * are not declared and amounts above the declared cap are ignored.
   */
  effectiveAllowance?: (input: any, ctx: StageContext) => CostAllowance[] | 'none';
}

/** A stage definition as accepted by the engine. */
export type EngineStage<I = any, O = any> = StageDefinition<I, O> & StageExtensions;

/** Helper that keeps full type inference for input/output schemas. */
export function defineStage<I, O>(stage: EngineStage<I, O>): EngineStage<I, O> {
  return stage;
}

/** Circuit-breaker style gate for external providers (implemented by src/jobs/circuit-breaker.ts). */
export interface ProviderGate {
  /** Non-mutating check used by the engine before starting a stage (does not consume the half-open probe). */
  peek(provider: string): GateDecision;
  /** Mutating check made right before a request; may turn this caller into the half-open probe. */
  canRequest(provider: string): GateDecision;
  recordSuccess(provider: string): void;
  recordFailure(provider: string, error: unknown): void;
  execute<T>(provider: string, fn: () => Promise<T>): Promise<T>;
}

export type GateDecision =
  | { allowed: true; probe: boolean }
  | { allowed: false; reason: string; nextProbeAt: string | null };

/** Per-stage spending guard: enforces the stage's declared cost allowance on top of run/site/account budgets. */
export interface StageBudget {
  /** Declared per-stage caps by provider (empty when the stage declares no allowance). */
  readonly caps: Partial<Record<BudgetProvider, Micros>>;
  /** Reserve through the budget service after checking the stage cap. `runId` is forced to the job id. */
  reserve(req: Omit<ReserveRequest, 'siteId' | 'runId'> & { siteId?: string; runId?: string }): Reservation;
  /** Sum of KNOWN upper bounds reserved by this stage so far, per provider (unknown-price reservations excluded). */
  reservedMicros(provider: BudgetProvider): Micros;
  /** Approved reservations whose price is unknown (never counted as $0). */
  unknownPriceReservations(provider: BudgetProvider): number;
}

/** Extra tools the engine attaches to every StageContext it creates. */
export interface StageTools {
  budget: StageBudget;
  /** Null when the workflow runs without a provider gate. */
  breakers: ProviderGate | null;
  logger: Logger;
  mode: RuntimeMode;
  /** ISO instant at which this attempt times out. */
  deadline: string;
  /** Cooperative cancellation / lock-loss check; throws when the job must stop. */
  checkpointHeartbeat(): void;
  /**
   * Why a `paidWorkOptional` stage runs without its declared allowance in this
   * attempt (`BUDGET_EXCEEDED`, `INTEGRATION_UNAVAILABLE`), else null/absent.
   */
  paidWorkSkipped?: PaidWorkSkipped | null;
}

/** Why the engine runs a `paidWorkOptional` stage without its optional paid work. */
export interface PaidWorkSkipped {
  code: 'BUDGET_EXCEEDED' | 'INTEGRATION_UNAVAILABLE';
  reason: string;
}

export type EngineStageContext = StageContext & { tools: StageTools };

/** Access the engine's stage tools from a StageContext (throws if the context was not created by the engine). */
export function toolsOf(ctx: StageContext): StageTools {
  const tools = (ctx as Partial<EngineStageContext>).tools;
  if (!tools) throw new AppError('INTERNAL', 'Stage context was not created by the workflow engine (no stage tools attached).');
  return tools;
}

/**
 * Whether a stage may make paid calls to `provider` in this attempt: false
 * when the engine runs it without a (positive) allowance for that provider,
 * because it declared none, its allowance was narrowed to none, or its
 * optional paid work was dropped (budget exhausted, provider unavailable).
 * Outside the engine (no stage tools) stage allowances are not enforced, so
 * this returns true and the budget service alone decides.
 */
export function stageMayPay(ctx: StageContext, provider: BudgetProvider): boolean {
  const tools = (ctx as Partial<EngineStageContext>).tools;
  if (!tools) return true;
  return (tools.budget.caps[provider] ?? 0) > 0;
}

/** Why the engine dropped this stage's optional paid work in this attempt, or null. */
export function paidWorkSkippedReason(ctx: StageContext): PaidWorkSkipped | null {
  return (ctx as Partial<EngineStageContext>).tools?.paidWorkSkipped ?? null;
}

export interface DegradedStage {
  stage: string;
  code: string;
  reason: string;
}

export interface EngineResult extends WorkflowResult {
  /** Stages that were skipped or failed without failing the workflow, with reasons. */
  degraded: DegradedStage[];
  /** The decision that stopped the workflow early, when status is 'stopped'. */
  stoppedBy?: { stage: string; decision: Extract<StopDecision, { stop: true }>; code?: string };
  /**
   * The error that failed the workflow, when status is 'failed'. `retryAfter`
   * is the earliest instant a job-level retry can help (e.g. the next probe of
   * an open circuit breaker).
   */
  failure?: { stage: string; code: string; message: string; retryable: boolean; retryAfter?: string };
  /**
   * Non-optional stages that were skipped by policy (runtime mode, dry run, or
   * a prerequisite skipped by policy). The workflow still counts as succeeded,
   * but it did not do all of its work; renderers must say so.
   */
  skippedRequired: DegradedStage[];
  /**
   * Stages that were aborted (timeout, cancellation, shutdown) but did not stop
   * within the grace period and may still be running in the background.
   */
  orphaned: Array<{ stage: string; attempt: number }>;
  warnings: string[];
  runtimeMode: RuntimeMode;
  dryRun: boolean;
}
