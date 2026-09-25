import type { Clock } from '../core/clock.js';
import { parseJson, type Db } from '../database/db.js';
import { describeHolders, pageFreeze } from '../experiments/freeze.js';
import { applyLearningDecision } from '../experiments/learnings.js';
import { findExperiment, getExperimentChange } from '../experiments/repository.js';
import { transitionExperiment } from '../experiments/status.js';
import { draftHumanReview, draftPackageRawBody } from './subjects.js';
import type { ApprovalRecord } from './types.js';

/**
 * Status effects of a human approval decision on the approved subject.
 * Called by the CLI right after `approvals approve|reject`. Effects apply only
 * when the approval still binds the subject's CURRENT artifact hash.
 */
export function applyDecisionEffects(db: Db, clock: Clock, approval: ApprovalRecord, actor: string): string[] {
  const notes: string[] = [];
  if (approval.status !== 'approved' && approval.status !== 'rejected') return notes;
  switch (approval.subjectType) {
    case 'experiment': {
      const exp = findExperiment(db, approval.siteId, approval.subjectId);
      if (!exp) break;
      if (exp.changeHash !== approval.artifactHash) {
        notes.push(`Experiment ${exp.id} change differs from the approved artifact; status unchanged.`);
        break;
      }
      if (approval.status === 'approved' && exp.status === 'proposed') {
        transitionExperiment(db, clock, {
          siteId: approval.siteId,
          experimentId: exp.id,
          to: 'approved',
          actor,
          reason: `approval ${approval.id} approved by ${approval.approver}`,
          patch: { approval_id: approval.id },
        });
        notes.push(
          `Experiment ${exp.id} is now approved. Next: \`export experiment ${exp.id} --mode EXECUTE\` (rechecks the target and writes the package; consumes the approval), deploy exactly that package, then \`experiments mark-implemented ${exp.id}\`.`,
        );
        // The recommendation the experiment tests is approved with it, so a later run never records it as superseded.
        if (exp.recommendationId) {
          const changed = db.run(`UPDATE recommendations SET status = 'approved', updated_at = ? WHERE site_id = ? AND id = ? AND status = 'proposed'`, [
            clock.now().toISOString(),
            approval.siteId,
            exp.recommendationId,
          ]).changes;
          if (changed) notes.push(`Recommendation ${exp.recommendationId} marked approved (tested as experiment ${exp.id}).`);
        }
        // Re-check the page at decision time: the approval is recorded either
        // way, but the approver must see that the page is held by another
        // experiment (possible only with a recorded critical-fix override).
        const target = getExperimentChange(db, approval.siteId, exp.id)?.targetUrl ?? approval.target;
        const freeze = pageFreeze(db, approval.siteId, { pageId: exp.pageId, url: target }, { excludeExperimentId: exp.id });
        const holders = [...freeze.observing, ...freeze.pending];
        if (holders.length) {
          const override = (exp.evidence as { freezeOverride?: { reason?: string } | null }).freezeOverride?.reason;
          notes.push(
            `Warning: the page is also held by ${describeHolders(holders)}.${override ? ` Critical-fix override recorded at proposal: ${override}.` : ''} Export refuses while another experiment is observing the page unless --critical-fix is given.`,
          );
        }
      } else if (approval.status === 'rejected' && exp.status === 'proposed') {
        transitionExperiment(db, clock, { siteId: approval.siteId, experimentId: exp.id, to: 'cancelled', actor, reason: `approval ${approval.id} rejected` });
        notes.push(`Experiment ${exp.id} cancelled (approval rejected).`);
      }
      break;
    }
    case 'learning': {
      const n = applyLearningDecision(db, clock, approval);
      if (n) notes.push(n);
      break;
    }
    case 'recommendation': {
      const next = approval.status === 'approved' ? 'approved' : 'rejected';
      const changed = db.run(`UPDATE recommendations SET status = ?, updated_at = ? WHERE site_id = ? AND id = ? AND status = 'proposed'`, [next, clock.now().toISOString(), approval.siteId, approval.subjectId]).changes;
      if (changed) notes.push(`Recommendation ${approval.subjectId} marked ${next}.`);
      if (approval.status === 'approved') notes.push(`Next: \`export recommendation ${approval.subjectId} --mode EXECUTE\`, deploy the package, then \`experiments mark-implemented ${approval.subjectId} --subject-type recommendation\`.`);
      break;
    }
    case 'draft': {
      if (approval.status === 'approved') {
        // Human review is required for publication in addition to the approval. Without a
        // recorded acceptance of the exact body the draft stays reviewable (not 'approved'),
        // so `content mark-reviewed` can still record it; the export refuses until then.
        const d = db.get<{ package_json: string; status: string }>('SELECT package_json, status FROM content_drafts WHERE site_id = ? AND id = ?', [approval.siteId, approval.subjectId]);
        const body = d ? draftPackageRawBody(parseJson<Record<string, unknown>>(d.package_json, {})) : undefined;
        const review = body !== undefined ? draftHumanReview({ db, siteId: approval.siteId }, approval.subjectId, body) : null;
        if (review?.accepted) {
          const changed = db.run(`UPDATE content_drafts SET status = 'approved' WHERE site_id = ? AND id = ? AND status = 'review_passed'`, [approval.siteId, approval.subjectId]).changes;
          if (changed) notes.push(`Draft ${approval.subjectId} marked approved for export (body accepted by ${review.reviewer ?? 'a named human'}).`);
          notes.push(`Next: \`export draft ${approval.subjectId} --mode EXECUTE\`, publish the package, then \`experiments mark-implemented ${approval.subjectId} --subject-type draft\`.`);
        } else {
          notes.push(
            `Draft ${approval.subjectId} stays "${d?.status ?? 'unknown'}": ${review?.reason ?? 'its body could not be read'}. The export also needs a named human's recorded acceptance of this exact body. Next: \`content mark-reviewed ${approval.subjectId} --as "<your name>" --confirm ${review ? review.bodyHash.slice(0, 12) : '<body-hash prefix>'}\`, then \`export draft ${approval.subjectId} --mode EXECUTE\`.`,
          );
        }
      }
      break;
    }
    default:
      break;
  }
  return notes;
}
