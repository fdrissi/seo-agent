import type { PriceBasis } from '../../budgets/types.js';
import type { LimitCheck } from '../../budgets/types.js';
import type { DataForSeoMode } from './client.js';

/** dataforseo_tasks.status values (migration 0005). */
export type TaskStatus = 'submitting' | 'queued' | 'ready' | 'fetched' | 'failed' | 'ambiguous' | 'expired';
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['submitting', 'queued', 'ready', 'ambiguous'];

export type TaskKind = 'serp' | 'volume' | 'gated';

/** Stored in dataforseo_tasks.params_json.meta (no credentials). */
export interface TaskMeta {
  kind: TaskKind;
  mode: DataForSeoMode;
  queue: 'standard' | 'live';
  purpose: string;
  runId: string;
  query?: string;
  keywords?: string[];
  locationCode?: number | null;
  languageCode?: string | null;
  device?: 'desktop' | 'mobile' | null;
  depth?: number;
  origin?: string;
}

export interface TaskParams {
  task: Record<string, unknown>;
  meta: TaskMeta;
}

export interface TaskRow {
  id: string;
  site_id: string;
  provider_request_id: string | null;
  endpoint: string;
  remote_task_id: string | null;
  tag: string | null;
  parameter_hash: string;
  params_json: string;
  status: TaskStatus;
  api_status_code: number | null;
  api_status_message: string | null;
  cost_usd_micros: number | null;
  is_sandbox: number;
  raw_ref: string | null;
  submitted_at: string | null;
  ready_at: string | null;
  fetched_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CompetitorUrl {
  query: string;
  url: string;
  domain: string | null;
  rankAbsolute: number | null;
  title: string | null;
  snapshotId: string;
  isSandbox: boolean;
  /** False for sandbox/fixture data in a live workspace: never use it in real recommendations. */
  usableForRecommendations: boolean;
}

export interface PlanItem {
  label: string;
  kind: TaskKind;
  action: 'cache_hit' | 'reuse_open_task' | 'submit' | 'skip';
  estimateMicros: number | null;
  basis: PriceBasis | null;
  taskId?: string;
  reason?: string;
}

export interface BudgetCaps {
  perRun: { limitMicros: number; committedMicros: number; remainingMicros: number };
  weekly: { limitMicros: number; committedMicros: number; remainingMicros: number } | null;
  monthly: { limitMicros: number; committedMicros: number; remainingMicros: number };
  combinedMonthly: { limitMicros: number; committedMicros: number; remainingMicros: number };
}

export interface CostPlan {
  provider: 'dataforseo';
  mode: DataForSeoMode | null;
  isSandbox: boolean;
  queue: 'standard' | 'live';
  items: PlanItem[];
  cacheHits: number;
  openTasks: number;
  submissions: number;
  /** Sum of submission upper bounds; null when any price is unknown (never 0). */
  totalEstimateMicros: number | null;
  unknownPrice: boolean;
  caps: BudgetCaps;
  /** Result of checking the total against every budget limit (no reservation is written). */
  budgetOk: boolean;
  violated: LimitCheck | null;
}

export interface Blocker {
  code: string;
  message: string;
  hint?: string;
}
