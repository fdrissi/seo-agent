import { AppError, type ErrorCode } from '../../core/errors.js';
import { toMicros, type Micros } from '../../core/money.js';
import { redactString } from '../../security/redact.js';

/**
 * DataForSEO response envelope (docs/integration-contracts.md section 6,
 * "Response envelope"). The API returns HTTP 200 for most errors; the real
 * outcome lives in `status_code` at the response level AND per task (DF13).
 */

export interface DfsTask<R = unknown> {
  id: string;
  status_code: number;
  status_message: string;
  time?: string;
  cost?: number | null;
  result_count?: number;
  path?: string[];
  data?: Record<string, unknown>;
  result: R[] | null;
}

export interface DfsEnvelope<R = unknown> {
  version?: string;
  status_code: number;
  status_message: string;
  time?: string;
  cost?: number | null;
  tasks_count?: number;
  tasks_error?: number;
  tasks: DfsTask<R>[];
}

export const DFS_STATUS = {
  OK: 20000,
  TASK_CREATED: 20100,
  TASK_HANDED: 40601,
  TASK_IN_QUEUE: 40602,
  NO_SEARCH_RESULTS: 40102,
  PARTIAL_RESULTS: 40106,
  RESULTS_EXPIRED: 40403,
  TASK_NOT_FOUND: 40401,
} as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Minimal structural validation. Returns null when the body is not an envelope. */
export function parseEnvelope<R = unknown>(body: unknown): DfsEnvelope<R> | null {
  if (!isRecord(body) || typeof body.status_code !== 'number') return null;
  const tasksRaw = body.tasks;
  if (tasksRaw !== undefined && tasksRaw !== null && !Array.isArray(tasksRaw)) return null;
  const tasks: DfsTask<R>[] = [];
  for (const t of (tasksRaw as unknown[] | null | undefined) ?? []) {
    if (!isRecord(t) || typeof t.status_code !== 'number') return null;
    tasks.push({
      id: typeof t.id === 'string' ? t.id : '',
      status_code: t.status_code,
      status_message: typeof t.status_message === 'string' ? t.status_message : '',
      ...(typeof t.time === 'string' ? { time: t.time } : {}),
      cost: typeof t.cost === 'number' && Number.isFinite(t.cost) ? t.cost : null,
      ...(typeof t.result_count === 'number' ? { result_count: t.result_count } : {}),
      ...(Array.isArray(t.path) ? { path: t.path.filter((p): p is string => typeof p === 'string') } : {}),
      ...(isRecord(t.data) ? { data: t.data } : {}),
      result: Array.isArray(t.result) ? (t.result as R[]) : null,
    });
  }
  return {
    ...(typeof body.version === 'string' ? { version: body.version } : {}),
    status_code: body.status_code,
    status_message: typeof body.status_message === 'string' ? body.status_message : '',
    ...(typeof body.time === 'string' ? { time: body.time } : {}),
    cost: typeof body.cost === 'number' && Number.isFinite(body.cost) ? body.cost : null,
    ...(typeof body.tasks_count === 'number' ? { tasks_count: body.tasks_count } : {}),
    ...(typeof body.tasks_error === 'number' ? { tasks_error: body.tasks_error } : {}),
    tasks,
  };
}

export type TaskOutcome = 'ok' | 'created' | 'pending' | 'no_results' | 'partial' | 'expired' | 'not_found' | 'error';

export function taskOutcome(code: number): TaskOutcome {
  switch (code) {
    case DFS_STATUS.OK:
      return 'ok';
    case DFS_STATUS.TASK_CREATED:
      return 'created';
    case DFS_STATUS.TASK_HANDED:
    case DFS_STATUS.TASK_IN_QUEUE:
      return 'pending';
    case DFS_STATUS.NO_SEARCH_RESULTS:
      return 'no_results';
    case DFS_STATUS.PARTIAL_RESULTS:
      return 'partial';
    case DFS_STATUS.RESULTS_EXPIRED:
      return 'expired';
    case DFS_STATUS.TASK_NOT_FOUND:
      return 'not_found';
    default:
      return 'error';
  }
}

export type DfsErrorKind =
  | 'auth'
  | 'account'
  | 'funds'
  | 'rate_limit'
  | 'provider_cost_limit'
  | 'access_denied'
  | 'ip_not_whitelisted'
  | 'concurrency'
  | 'duplicate_limit'
  | 'invalid_request'
  | 'not_found'
  | 'expired'
  | 'task_failed_resubmit'
  | 'server'
  | 'unknown';

interface Mapping {
  kind: DfsErrorKind;
  code: ErrorCode;
  /** Safe to retry automatically for FREE, idempotent GETs only. Paid POSTs are never retried. */
  retryableGet: boolean;
  hint?: string;
}

const CREDENTIAL_HINT =
  'Check DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD (the API credentials from https://app.dataforseo.com/api-access, not the account password) in the workspace secrets file.';

/** Map a DataForSEO internal status code (DF13) to an application error class. */
export function mapStatusCode(code: number): Mapping {
  if (code === 40100) return { kind: 'auth', code: 'PERMISSION_DENIED', retryableGet: false, hint: CREDENTIAL_HINT };
  if (code === 40104) return { kind: 'account', code: 'PERMISSION_DENIED', retryableGet: false, hint: 'DataForSEO account verification is required (see the DataForSEO dashboard).' };
  if (code === 40200 || code === 40210)
    return { kind: 'funds', code: 'PROVIDER_ERROR', retryableGet: false, hint: 'DataForSEO balance is insufficient. No automatic top-ups are performed; fund the account yourself if intended.' };
  if (code === 40201) return { kind: 'account', code: 'PERMISSION_DENIED', retryableGet: false, hint: 'The DataForSEO account is paused.' };
  if (code === 40202 || code === 40209) return { kind: code === 40202 ? 'rate_limit' : 'concurrency', code: 'RATE_LIMITED', retryableGet: true };
  if (code === 40203) return { kind: 'provider_cost_limit', code: 'PROVIDER_ERROR', retryableGet: false, hint: 'A provider-side cost limit on the DataForSEO account was reached.' };
  if (code === 40204) return { kind: 'access_denied', code: 'PERMISSION_DENIED', retryableGet: false, hint: 'This endpoint needs extra access or a subscription on the DataForSEO account.' };
  if (code === 40205 || code === 40206) return { kind: 'duplicate_limit', code: 'PROVIDER_ERROR', retryableGet: false };
  if (code === 40207) return { kind: 'ip_not_whitelisted', code: 'PERMISSION_DENIED', retryableGet: false, hint: 'The calling IP is not whitelisted in the DataForSEO dashboard.' };
  if ([40000, 40006, 40501, 40502, 40503, 40505, 40506, 40402].includes(code)) return { kind: 'invalid_request', code: 'VALIDATION_FAILED', retryableGet: false };
  if (code === 40105 || code === 40400 || code === 40401) return { kind: 'not_found', code: 'NOT_FOUND', retryableGet: false };
  if (code === 40403) return { kind: 'expired', code: 'DATA_UNAVAILABLE', retryableGet: false };
  if (code === 40101 || code === 40103) return { kind: 'task_failed_resubmit', code: 'PROVIDER_ERROR', retryableGet: false };
  if (code >= 50000 && code < 60000) return { kind: 'server', code: 'PROVIDER_ERROR', retryableGet: true };
  return { kind: 'unknown', code: 'PROVIDER_ERROR', retryableGet: false };
}

/** Error raised for DataForSEO API-level failures (including those inside HTTP 200 responses). */
export class DataForSeoApiError extends AppError {
  readonly dfsStatusCode: number | null;
  readonly level: 'http' | 'response' | 'task';
  readonly kind: DfsErrorKind;
  readonly retryableGet: boolean;

  constructor(input: { endpoint: string; level: 'http' | 'response' | 'task'; statusCode: number | null; statusMessage: string; httpStatus?: number | null; taskId?: string }) {
    const mapping = input.statusCode !== null ? mapStatusCode(input.statusCode) : httpMapping(input.httpStatus ?? 0);
    const msg = `DataForSEO ${input.endpoint}: ${input.level}-level error ${input.statusCode ?? `HTTP ${input.httpStatus ?? '?'}`} ${redactString(input.statusMessage).slice(0, 300)}`.trim();
    super(mapping.code, msg, {
      details: { endpoint: input.endpoint, level: input.level, statusCode: input.statusCode, httpStatus: input.httpStatus ?? null, kind: mapping.kind, ...(input.taskId ? { taskId: input.taskId } : {}) },
      ...(mapping.hint ? { hint: mapping.hint } : {}),
    });
    this.name = 'DataForSeoApiError';
    this.dfsStatusCode = input.statusCode;
    this.level = input.level;
    this.kind = mapping.kind;
    this.retryableGet = mapping.retryableGet;
  }
}

function httpMapping(status: number): Mapping {
  if (status === 401) return { kind: 'auth', code: 'PERMISSION_DENIED', retryableGet: false, hint: CREDENTIAL_HINT };
  if (status === 402) return { kind: 'funds', code: 'PROVIDER_ERROR', retryableGet: false, hint: 'DataForSEO returned 402 Payment Required.' };
  if (status === 404) return { kind: 'not_found', code: 'NOT_FOUND', retryableGet: false };
  if (status === 429) return { kind: 'rate_limit', code: 'RATE_LIMITED', retryableGet: true };
  if (status >= 500) return { kind: 'server', code: 'PROVIDER_ERROR', retryableGet: true };
  return { kind: 'unknown', code: 'PROVIDER_ERROR', retryableGet: false };
}

function costToMicros(cost: number | null | undefined): Micros | null {
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return null;
  return toMicros(cost);
}

export interface EnvelopeCost {
  /** Actual charge derived from TASK-level costs; null when any task cost is missing (unknown, never 0). */
  actualMicros: Micros | null;
  perTaskMicros: Array<Micros | null>;
  /** Response-level total, recorded for audit only and NEVER added to task-level costs. */
  responseLevelMicros: Micros | null;
  basis: 'task_level' | 'response_level_no_tasks' | 'unknown';
}

/**
 * Derive the charge of a POST from task-level `cost` fields. The response-level
 * `cost` is the sum of the same charges; adding both would double count, so it
 * is only used when the response contains no tasks at all.
 */
export function envelopeCost(env: DfsEnvelope): EnvelopeCost {
  const responseLevelMicros = costToMicros(env.cost);
  if (env.tasks.length > 0) {
    const perTaskMicros = env.tasks.map((t) => costToMicros(t.cost));
    const known = perTaskMicros.every((c) => c !== null);
    return {
      actualMicros: known ? perTaskMicros.reduce<number>((s, c) => s + (c ?? 0), 0) : null,
      perTaskMicros,
      responseLevelMicros,
      basis: known ? 'task_level' : 'unknown',
    };
  }
  return { actualMicros: responseLevelMicros, perTaskMicros: [], responseLevelMicros, basis: responseLevelMicros === null ? 'unknown' : 'response_level_no_tasks' };
}

/** Throw when the response-level status is not 20000 (the whole request failed). */
export function assertResponseOk(env: DfsEnvelope, endpoint: string, httpStatus: number): void {
  if (env.status_code !== DFS_STATUS.OK) {
    throw new DataForSeoApiError({ endpoint, level: 'response', statusCode: env.status_code, statusMessage: env.status_message, httpStatus });
  }
}

/**
 * Task-level codes that definitively end a task (DF13): "task failed,
 * resubmit" (40101, 40103), invalid requests (40000, 40006, 405xx, 40402),
 * deleted / not found (40105, 40400, 40401). Everything else that is not a
 * success or pending code (5xxxx server errors, rate limits, account-level
 * errors, undocumented codes) is treated as transient for an already-paid
 * task: it is retried with free GETs and never resubmitted.
 */
export function isDefinitiveTaskFailure(code: number): boolean {
  const kind = mapStatusCode(code).kind;
  return kind === 'task_failed_resubmit' || kind === 'invalid_request' || kind === 'not_found';
}

/** Throw when a task-level status is an error (pending/no-results/partial are not errors). */
export function taskError(task: DfsTask, endpoint: string): DataForSeoApiError | null {
  const o = taskOutcome(task.status_code);
  if (o === 'error' || o === 'expired' || o === 'not_found') {
    return new DataForSeoApiError({ endpoint, level: 'task', statusCode: task.status_code, statusMessage: task.status_message, taskId: task.id });
  }
  return null;
}
