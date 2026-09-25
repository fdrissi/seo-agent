import type { Clock } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { recordAudit } from '../database/audit.js';
import type { Db } from '../database/db.js';
import { getExperiment } from './repository.js';
import type { ExperimentRecord, ExperimentStatus } from './types.js';

/**
 * Experiment status machine:
 *
 *   proposed -> approved -> awaiting_implementation -> observing -> positive | negative | inconclusive
 *   (any non-terminal) -> cancelled
 *
 * Every transition appends to experiment_status_history (append-only) and
 * the audit log. Terminal statuses never change, so a concluded outcome can
 * never be re-labeled by re-running an evaluation.
 */

export const TRANSITIONS: Record<ExperimentStatus, readonly ExperimentStatus[]> = {
  proposed: ['approved', 'cancelled'],
  approved: ['awaiting_implementation', 'cancelled'],
  awaiting_implementation: ['observing', 'cancelled'],
  observing: ['positive', 'negative', 'inconclusive', 'cancelled'],
  positive: [],
  negative: [],
  inconclusive: [],
  cancelled: [],
};

export function canTransition(from: ExperimentStatus, to: ExperimentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Columns a transition may set alongside the status. */
export interface TransitionPatch {
  implemented_at?: string | null;
  source_revision?: string | null;
  before_snapshot_ref?: string | null;
  after_snapshot_ref?: string | null;
  observation_start?: string | null;
  observation_end?: string | null;
  outcome_json?: string | null;
  approval_id?: string | null;
  review_date?: string | null;
}

const PATCHABLE = new Set<keyof TransitionPatch>([
  'implemented_at',
  'source_revision',
  'before_snapshot_ref',
  'after_snapshot_ref',
  'observation_start',
  'observation_end',
  'outcome_json',
  'approval_id',
  'review_date',
]);

export function transitionExperiment(
  db: Db,
  clock: Clock,
  input: { siteId: string; experimentId: string; to: ExperimentStatus; actor: string; reason?: string | null; patch?: TransitionPatch; expectFrom?: readonly ExperimentStatus[] },
): ExperimentRecord {
  return db.transaction(() => {
    const exp = getExperiment(db, input.siteId, input.experimentId);
    if (input.expectFrom && !input.expectFrom.includes(exp.status)) {
      throw new AppError('CONFLICT', `Experiment ${exp.id} is ${exp.status}; expected ${input.expectFrom.join(' or ')}.`);
    }
    if (!canTransition(exp.status, input.to)) {
      throw new AppError('CONFLICT', `Experiment ${exp.id} cannot move from ${exp.status} to ${input.to}.`, {
        details: { from: exp.status, to: input.to, allowed: TRANSITIONS[exp.status] },
      });
    }
    const at = clock.now().toISOString();
    const sets = ['status = ?', 'updated_at = ?'];
    const params: unknown[] = [input.to, at];
    for (const [k, v] of Object.entries(input.patch ?? {})) {
      if (!PATCHABLE.has(k as keyof TransitionPatch)) throw new AppError('INTERNAL', `Column ${k} is not patchable in a status transition.`);
      sets.push(`${k} = ?`);
      params.push(v);
    }
    params.push(exp.id, input.siteId, exp.status);
    const changed = db.run(`UPDATE experiments SET ${sets.join(', ')} WHERE id = ? AND site_id = ? AND status = ?`, params).changes;
    if (changed !== 1) throw new AppError('CONFLICT', `Experiment ${exp.id} changed concurrently; retry.`);
    db.run('INSERT INTO experiment_status_history (experiment_id, site_id, from_status, to_status, actor, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      exp.id,
      input.siteId,
      exp.status,
      input.to,
      input.actor,
      input.reason ?? null,
      at,
    ]);
    recordAudit(db, {
      siteId: input.siteId,
      actor: input.actor,
      eventType: 'experiment.status_changed',
      subjectType: 'experiment',
      subjectId: exp.id,
      details: { from: exp.status, to: input.to, reason: input.reason ?? null },
      at: clock.now(),
    });
    return getExperiment(db, input.siteId, exp.id);
  });
}
