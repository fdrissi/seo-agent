import { newId } from '../../core/ids.js';
import type { Micros } from '../../core/money.js';
import type { Db } from '../../database/db.js';
import { redact } from '../../security/redact.js';
import type { TruncationInfo } from './types.js';

/**
 * `llm_calls` rows: one row per HTTP request to the gateway (initial request,
 * tool round, or repair attempt); rows of one logical call share
 * `call_group_id`. Columns from migrations 0002 and 0150.
 */

export type LlmCallStatus = 'succeeded' | 'invalid_output' | 'needs_review' | 'tool_round' | 'provider_error' | 'ambiguous' | 'skipped';
export type LlmValidationStatus = 'valid' | 'repaired' | 'invalid' | 'not_applicable' | 'error';
export type LlmCostStatus = 'actual' | 'estimated' | 'unknown';

export interface LlmCallRecord {
  siteId: string;
  runId: string;
  traceId: string;
  callGroupId: string;
  attempt: number;
  role: string;
  tier: 'cheap' | 'reasoning' | 'embedding';
  promptId: string;
  promptVersion: string;
  modelRequested: string;
  modelReturned: string | null;
  params: Record<string, unknown>;
  maxOutputTokens: number;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  costMicros: Micros | null;
  costStatus: LlmCostStatus;
  schemaName: string | null;
  validationStatus: LlmValidationStatus;
  repairAttempts: number;
  truncation: TruncationInfo[];
  evidenceBundleHash: string | null;
  providerRequestId: string | null;
  reservationId: string | null;
  status: LlmCallStatus;
  responseFormat: 'json_schema' | 'json_object' | 'prompt' | 'text' | 'embedding' | null;
  httpStatus: number | null;
  error: unknown;
  isSynthetic: boolean;
  createdAt: Date;
}

/** Job id to link only when `runId` names an existing job of this site (FK-safe). */
function jobIdFor(db: Db, siteId: string, runId: string): string | null {
  const row = db.get<{ id: string }>('SELECT id FROM jobs WHERE id = ? AND site_id = ?', [runId, siteId]);
  return row?.id ?? null;
}

export function insertLlmCall(db: Db, r: LlmCallRecord): string {
  const id = newId('llm');
  db.run(
    `INSERT INTO llm_calls (id, site_id, provider_request_id, trace_id, role, tier, prompt_id, prompt_version, model_requested, model_returned, params_json,
       max_output_tokens, input_tokens, output_tokens, reasoning_tokens, cost_usd_micros, cost_status, schema_name, validation_status, repair_attempts,
       truncated, truncation_json, evidence_bundle_hash, job_id, created_at,
       call_group_id, attempt, status, response_format, reservation_id, run_id, http_status, error_json, is_synthetic)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      r.siteId,
      r.providerRequestId,
      r.traceId,
      r.role,
      r.tier,
      r.promptId,
      r.promptVersion,
      r.modelRequested,
      r.modelReturned,
      JSON.stringify(redact(r.params)),
      r.maxOutputTokens,
      r.inputTokens,
      r.outputTokens,
      r.reasoningTokens,
      r.costMicros,
      r.costMicros === null ? 'unknown' : r.costStatus,
      r.schemaName,
      r.validationStatus,
      Math.max(0, Math.min(2, r.repairAttempts)),
      r.truncation.length ? 1 : 0,
      r.truncation.length ? JSON.stringify(r.truncation) : null,
      r.evidenceBundleHash,
      jobIdFor(db, r.siteId, r.runId),
      r.createdAt.toISOString(),
      r.callGroupId,
      r.attempt,
      r.status,
      r.responseFormat,
      r.reservationId,
      r.runId,
      r.httpStatus,
      r.error === undefined || r.error === null ? null : JSON.stringify(redact(r.error instanceof Error ? { name: r.error.name, message: r.error.message } : r.error)),
      r.isSynthetic ? 1 : 0,
    ],
  );
  return id;
}

/** Update the validation outcome of an already-recorded attempt. */
export function updateLlmCallOutcome(db: Db, siteId: string, id: string, input: { status: LlmCallStatus; validationStatus: LlmValidationStatus; error?: unknown }): void {
  db.run('UPDATE llm_calls SET status = ?, validation_status = ?, error_json = COALESCE(?, error_json) WHERE id = ? AND site_id = ?', [
    input.status,
    input.validationStatus,
    input.error === undefined ? null : JSON.stringify(redact(input.error)),
    id,
    siteId,
  ]);
}

export interface LlmCallRow {
  id: string;
  site_id: string;
  provider_request_id: string | null;
  trace_id: string;
  role: string;
  tier: string;
  prompt_id: string;
  prompt_version: string;
  model_requested: string;
  model_returned: string | null;
  params_json: string | null;
  max_output_tokens: number;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cost_usd_micros: number | null;
  cost_status: string;
  schema_name: string | null;
  validation_status: string;
  repair_attempts: number;
  truncated: number;
  truncation_json: string | null;
  evidence_bundle_hash: string | null;
  call_group_id: string | null;
  attempt: number | null;
  status: string | null;
  response_format: string | null;
  reservation_id: string | null;
  run_id: string | null;
  http_status: number | null;
  error_json: string | null;
  is_synthetic: number;
  created_at: string;
}

export function listLlmCalls(db: Db, siteId: string, opts: { callGroupId?: string; limit?: number } = {}): LlmCallRow[] {
  if (opts.callGroupId) return db.all<LlmCallRow>('SELECT * FROM llm_calls WHERE site_id = ? AND call_group_id = ? ORDER BY attempt, created_at', [siteId, opts.callGroupId]);
  return db.all<LlmCallRow>('SELECT * FROM llm_calls WHERE site_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', [siteId, opts.limit ?? 100]);
}
