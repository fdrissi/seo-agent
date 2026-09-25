import { newId } from '../core/ids.js';
import type { Clock } from '../core/clock.js';
import { systemClock } from '../core/clock.js';
import type { Db } from '../database/db.js';
import { parseJson } from '../database/db.js';
import { redact } from '../security/redact.js';
import type { ErrorInfo } from './errors.js';
import type { StageStatus } from './types.js';

/**
 * Persisted workflow stage results (table `checkpoints`, migration 0001).
 * Grain: one row per (job, stage, attempt). The latest succeeded/stopped row
 * with an output per (job, stage) is the resume checkpoint; it is reused only
 * when the stage version and input hash both match.
 *
 * Outputs are stored as plain JSON in the private workspace database. They are
 * NOT passed through secret redaction because redaction rewrites values under
 * key names such as "session", which would corrupt measurements; stages must
 * never put secrets into outputs. Error records ARE redacted here, in `save`,
 * whatever built them (thrown errors, validation issues, evidence problems,
 * gate reasons).
 */

export interface CheckpointRow {
  id: string;
  site_id: string;
  job_id: string;
  workflow: string;
  stage: string;
  stage_version: string;
  status: StageStatus;
  input_hash: string | null;
  output_json: string | null;
  output_ref: string | null;
  error_json: string | null;
  attempt: number;
  duration_ms: number | null;
  created_at: string;
}

export interface CheckpointSummary {
  id: string;
  stage: string;
  stageVersion: string;
  status: StageStatus;
  inputHash: string | null;
  attempt: number;
  durationMs: number | null;
  createdAt: string;
  error: ErrorInfo | null;
  hasOutput: boolean;
}

export interface SaveCheckpointInput {
  siteId: string;
  jobId: string;
  workflow: string;
  stage: string;
  stageVersion: string;
  status: StageStatus;
  inputHash?: string | null;
  output?: unknown;
  error?: ErrorInfo | null;
  attempt: number;
  durationMs?: number | null;
}

export class CheckpointStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  save(input: SaveCheckpointInput): string {
    const id = newId('ckpt');
    this.db.run(
      `INSERT INTO checkpoints (id, site_id, job_id, workflow, stage, stage_version, status, input_hash, output_json, output_ref, error_json, attempt, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      [
        id,
        input.siteId,
        input.jobId,
        input.workflow,
        input.stage,
        input.stageVersion,
        input.status,
        input.inputHash ?? null,
        input.output === undefined ? null : JSON.stringify(input.output),
        input.error ? JSON.stringify(redact(input.error)) : null,
        input.attempt,
        input.durationMs ?? null,
        this.clock.now().toISOString(),
      ],
    );
    return id;
  }

  /**
   * Latest checkpoint for a stage that carries a usable output (succeeded, or
   * stopped with an output). Ordered by insertion (rowid) so equal timestamps
   * from a fixed clock still resolve to the most recent row.
   */
  latestWithOutput(siteId: string, jobId: string, stage: string): { row: CheckpointRow; output: unknown } | undefined {
    const row = this.db.get<CheckpointRow>(
      `SELECT * FROM checkpoints
       WHERE site_id = ? AND job_id = ? AND stage = ? AND status IN ('succeeded', 'stopped') AND output_json IS NOT NULL
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [siteId, jobId, stage],
    );
    if (!row) return undefined;
    return { row, output: parseJson<unknown>(row.output_json, undefined) };
  }

  /** Next attempt number for a stage of a job (attempts keep counting across resumes). */
  nextAttempt(siteId: string, jobId: string, stage: string): number {
    const r = this.db.get<{ n: number | null }>('SELECT MAX(attempt) AS n FROM checkpoints WHERE site_id = ? AND job_id = ? AND stage = ?', [siteId, jobId, stage]);
    return Number(r?.n ?? 0) + 1;
  }

  /**
   * Most recent row of a real execution attempt of a stage (attempt >= 1): its
   * final outcome, or an in-flight marker when the process died mid-attempt.
   * Engine gate decisions (skips/blocks, attempt 0) are ignored.
   */
  latestAttempt(siteId: string, jobId: string, stage: string): CheckpointSummary | undefined {
    const r = this.db.get<CheckpointRow>(
      'SELECT * FROM checkpoints WHERE site_id = ? AND job_id = ? AND stage = ? AND attempt > 0 ORDER BY created_at DESC, rowid DESC LIMIT 1',
      [siteId, jobId, stage],
    );
    return r ? toSummary(r) : undefined;
  }

  list(siteId: string, jobId: string): CheckpointSummary[] {
    return this.db.all<CheckpointRow>('SELECT * FROM checkpoints WHERE site_id = ? AND job_id = ? ORDER BY created_at, rowid', [siteId, jobId]).map(toSummary);
  }
}

function toSummary(r: CheckpointRow): CheckpointSummary {
  return {
    id: r.id,
    stage: r.stage,
    stageVersion: r.stage_version,
    status: r.status,
    inputHash: r.input_hash,
    attempt: r.attempt,
    durationMs: r.duration_ms,
    createdAt: r.created_at,
    error: parseJson<ErrorInfo | null>(r.error_json, null),
    hasOutput: r.output_json !== null,
  };
}
