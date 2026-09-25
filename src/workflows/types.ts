import type { z } from 'zod';
import type { Micros } from '../core/money.js';
import type { RetryPolicy } from '../core/retry.js';
import type { BudgetProvider } from '../budgets/types.js';
import type { AppContext } from '../app/context.js';

/**
 * Workflow stage contract. Every stage defines a validated input/output
 * schema, prerequisites, evidence requirements, timeout, retry policy, cost
 * allowance, stopping conditions, and next valid states. Stage results are
 * persisted as checkpoints so interrupted workflows resume from the last
 * successful stage.
 *
 * Three orchestration patterns are implemented in src/workflows/engine.ts:
 * SEQUENTIAL (a stage runs only when its predecessors' outputs validated),
 * BOUNDED PARALLEL (default 3 workers, stricter per-provider limits), and
 * ROUTER (deterministic rules first, cheap model only for ambiguous cases).
 */

export interface CostAllowance {
  provider: BudgetProvider;
  maxMicros: Micros;
}

export type StopDecision =
  | { stop: false }
  | { stop: true; reason: string; status: 'completed_early' | 'blocked' | 'needs_review' | 'no_action' };

export interface StageContext {
  app: AppContext;
  jobId: string;
  workflow: string;
  /** Outputs of prerequisite stages, keyed by stage name (already validated). */
  prior: Record<string, unknown>;
  signal: AbortSignal;
  attempt: number;
}

export interface StageDefinition<I = unknown, O = unknown> {
  name: string;
  /** Bump when stage logic or prompts change; recorded with checkpoints and experiments. */
  version: string;
  description: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  /** Stage names whose validated outputs must exist before this stage runs. */
  prerequisites: string[];
  /** Human-readable evidence requirement plus an optional programmatic check returning problems. */
  evidence: { requirement: string; check?: (input: I, ctx: StageContext) => string[] };
  timeoutMs: number;
  retry: RetryPolicy;
  /** 'none' for stages that never spend money. */
  costAllowance: CostAllowance[] | 'none';
  /** Documented stopping conditions; `shouldStop` evaluates them against the output. */
  stoppingConditions: string[];
  shouldStop?: (output: O, ctx: StageContext) => StopDecision;
  /** Valid next states (stage names or terminal states). */
  next: string[];
  /** Build this stage's input from prior outputs and workflow params. */
  buildInput: (ctx: StageContext, params: Record<string, unknown>) => I | Promise<I>;
  run: (input: I, ctx: StageContext) => Promise<O>;
}

export type StageStatus = 'succeeded' | 'failed' | 'skipped' | 'stopped';

export interface StageOutcome {
  stage: string;
  status: StageStatus;
  resumedFromCheckpoint: boolean;
  output?: unknown;
  error?: { code: string; message: string };
  stop?: StopDecision;
  durationMs: number;
}

export interface WorkflowResult {
  workflow: string;
  jobId: string;
  status: 'succeeded' | 'failed' | 'stopped' | 'cancelled';
  stages: StageOutcome[];
  outputs: Record<string, unknown>;
}
