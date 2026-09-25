import { validateApproverName } from '../approvals/approver.js';
import type { Clock } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { recordAudit } from '../database/audit.js';
import type { Db } from '../database/db.js';
import { CheckpointStore } from './checkpoints.js';

/**
 * Recorded human reviews of workflow stages that stopped with `needs_review`.
 *
 * A review is an append-only audit event (`workflow.stage_reviewed`) whose
 * subject is the exact checkpoint that was reviewed. When a job is resumed,
 * the engine reuses that checkpoint and, instead of stopping at the same
 * `needs_review` decision again, continues with the next stage. A review
 * applies to one checkpoint only: if the stage reruns (new input, new stage
 * version) its new output needs a new review. The reviewer must be a named
 * human (`owner:<name>`, validated like an approver).
 */

export const STAGE_REVIEWED_EVENT = 'workflow.stage_reviewed';

export interface StageReviewRecord {
  jobId: string;
  stage: string;
  checkpointId: string;
  stageVersion: string;
  reviewer: string;
  at: string;
}

/** Record that a human reviewed the latest stopped checkpoint of `stage` in `jobId`. */
export function recordStageReview(
  db: Db,
  clock: Clock,
  input: { siteId: string; jobId: string; stage: string; reviewer: string; note?: string },
): StageReviewRecord {
  const store = new CheckpointStore(db, clock);
  const cp = store.latestWithOutput(input.siteId, input.jobId, input.stage);
  if (!cp) {
    throw new AppError('NOT_FOUND', `Job ${input.jobId} has no checkpointed output for stage "${input.stage}" to review.`, {
      hint: 'Check the stage name with `jobs show <id>`.',
    });
  }
  if (cp.row.status !== 'stopped') {
    throw new AppError('CONFLICT', `Stage "${input.stage}" of job ${input.jobId} did not stop for review (latest checkpoint is ${cp.row.status}).`);
  }
  assertHumanReviewer(input.reviewer);
  const at = clock.now();
  recordAudit(db, {
    siteId: input.siteId,
    actor: input.reviewer,
    eventType: STAGE_REVIEWED_EVENT,
    subjectType: 'checkpoint',
    subjectId: cp.row.id,
    details: { jobId: input.jobId, stage: input.stage, stageVersion: cp.row.stage_version, inputHash: cp.row.input_hash, ...(input.note ? { note: input.note } : {}) },
    at,
  });
  return { jobId: input.jobId, stage: input.stage, checkpointId: cp.row.id, stageVersion: cp.row.stage_version, reviewer: input.reviewer, at: at.toISOString() };
}

/**
 * A recorded review must name a human: the reviewer is `owner:<name>` with a
 * name that validateApproverName accepts (automation identities such as cli,
 * system, scheduler, model, or agent are refused). Spec 24: an LLM or
 * automation cannot act as the reviewer.
 */
export function assertHumanReviewer(reviewer: string): void {
  const m = /^owner:(.+)$/s.exec(reviewer);
  if (!m) {
    throw new AppError('VALIDATION_FAILED', `A stage review must be recorded by a named human (owner:<name>), not "${reviewer}". Nothing was recorded.`, {
      hint: 'Pass --reviewer "<your name>" with --reviewed.',
    });
  }
  validateApproverName(m[1]);
}

/** Whether a human review was recorded for this exact checkpoint. */
export function isCheckpointReviewed(db: Db, siteId: string, checkpointId: string): boolean {
  const r = db.get<{ id: number }>("SELECT id FROM audit_events WHERE site_id = ? AND event_type = ? AND subject_type = 'checkpoint' AND subject_id = ? LIMIT 1", [
    siteId,
    STAGE_REVIEWED_EVENT,
    checkpointId,
  ]);
  return r !== undefined;
}
