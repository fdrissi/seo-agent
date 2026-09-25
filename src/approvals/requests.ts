import type { AppContext } from '../app/context.js';
import { AppError } from '../core/errors.js';
import { parseJson } from '../database/db.js';
import { describeHolders, pageFreeze } from '../experiments/freeze.js';
import { getExperiment } from '../experiments/repository.js';
import { learningApprovalPayload, learningHash } from '../experiments/learnings.js';
import { hashPrefix } from './artifact.js';
import { assertAllowed } from './policy.js';
import { draftHumanReviewBlocker, proposalArtifactHash } from './publisher.js';
import type { ApprovalService } from './service.js';
import { resolveProposal } from './subjects.js';
import type { TargetChecker } from './target-check.js';
import type { ApprovalRecord } from './types.js';

/**
 * Create a PENDING approval request for the exact current proposal of a
 * subject. A request grants nothing; only `approvals approve` by a named
 * human does. Re-requesting after the proposal changed invalidates the old
 * live approval (with the reason recorded).
 *
 * Target fingerprint: the fingerprint that the pre-execution recheck compares
 * against is the one STORED on the approval. Re-requesting online while an
 * identical request is still pending without a fingerprint replaces that
 * request (the old one is invalidated with the reason) so the new one carries
 * the fingerprint. An already approved request is never modified: the result
 * reports its stored fingerprint (possibly null) and says what that means.
 */

export interface SubjectRequestInput {
  subjectType: string;
  subjectId: string;
  requestedBy: string;
  sourceRevision?: string | null;
  ttlHours?: number;
}

export interface SubjectRequestResult {
  approval: ApprovalRecord;
  artifactHash: string;
  hashPrefix: string;
  /** The fingerprint stored on the returned approval (what the pre-execution recheck will compare against). */
  targetFingerprint: string | null;
  warnings: string[];
}

export async function requestApprovalForSubject(ctx: AppContext, gate: ApprovalService, input: SubjectRequestInput, deps: { targetChecker?: TargetChecker } = {}): Promise<SubjectRequestResult> {
  assertAllowed(ctx.mode, 'request_approval');
  const warnings: string[] = [];

  if (input.subjectType === 'learning') {
    const l = ctx.db.get<{ id: string; statement: string; scope: string; evidence_json: string; status: string; experiment_id: string | null }>(
      'SELECT id, statement, scope, evidence_json, status, experiment_id FROM learnings WHERE site_id = ? AND id = ?',
      [ctx.siteId, input.subjectId],
    );
    if (!l) throw new AppError('NOT_FOUND', `Learning ${input.subjectId} not found.`);
    if (l.status !== 'proposed') throw new AppError('CONFLICT', `Learning ${l.id} is ${l.status}; only proposed learnings can be promoted.`);
    const evidence = parseJson(l.evidence_json, null);
    const hash = learningHash({ statement: l.statement, scope: l.scope, evidence });
    const approval = gate.request({
      siteId: ctx.siteId,
      actionType: 'learning_promotion',
      target: `learning:${l.id}`,
      subjectType: 'learning',
      subjectId: l.id,
      artifactHash: hash,
      summary: `Promote learning (scope: ${l.scope}): ${l.statement}`.slice(0, 500),
      payload: learningApprovalPayload({ statement: l.statement, scope: l.scope, experimentId: l.experiment_id, evidence }),
      requestedBy: input.requestedBy,
      ...(input.ttlHours ? { ttlHours: input.ttlHours } : {}),
    });
    const flags = (gate.detail(ctx.siteId, approval.id).payload?.statementFlags ?? []) as unknown[];
    for (const f of flags) if (typeof f === 'string') warnings.push(`Learning statement: ${f}`);
    return { approval, artifactHash: hash, hashPrefix: hashPrefix(hash), targetFingerprint: null, warnings };
  }

  if (input.subjectType === 'experiment') {
    const exp = getExperiment(ctx.db, ctx.siteId, input.subjectId);
    if (!['proposed', 'approved', 'awaiting_implementation'].includes(exp.status)) throw new AppError('CONFLICT', `Experiment ${exp.id} is ${exp.status}; no approval can be requested.`);
  }
  const proposal = resolveProposal(ctx, input.subjectType, input.subjectId);
  if (!proposal.productionBound) throw new AppError('VALIDATION_FAILED', `${proposal.subjectType} ${proposal.subjectId} proposes no production change; no approval is needed to export it.`);
  const hash = proposalArtifactHash(proposal);
  let fresh: string | null = null;
  let fingerprintFailed = false;
  if (deps.targetChecker) {
    const fp = await deps.targetChecker.fingerprint(proposal.targetUrl);
    if (fp.ok) fresh = fp.fingerprint;
    else {
      fingerprintFailed = true;
      warnings.push(`The target could not be fingerprinted now (${fp.reason}); the pre-execution recheck will be unverifiable unless you re-request online before the approval is decided.`);
    }
  }
  const binding = { siteId: ctx.siteId, actionType: proposal.actionType, subjectType: proposal.subjectType, subjectId: proposal.subjectId, artifactHash: hash, sourceRevision: input.sourceRevision ?? null };
  const existing = gate.findLive(binding);
  const storedOf = (d: { payload: Record<string, unknown> | null } | null) => (typeof d?.payload?.targetFingerprint === 'string' ? d.payload.targetFingerprint : null);
  if (existing && fresh && storedOf(existing) !== fresh) {
    const had = storedOf(existing);
    if (existing.status === 'pending') {
      gate.invalidate(ctx.siteId, existing.id, had === null ? 'superseded: re-requested online to capture the target fingerprint' : 'superseded: the target page changed since the request', input.requestedBy);
      warnings.push(
        had === null
          ? `Pending approval ${existing.id} had no target fingerprint; it was replaced by a new request that carries one.`
          : `The target changed since pending approval ${existing.id} was requested; it was replaced by a new request against the current page.`,
      );
    } else if (had === null) {
      warnings.push(`Approval ${existing.id} was already approved without a target fingerprint and is not modified; its pre-execution recheck is unverifiable (export needs --allow-unverified-target, which is recorded).`);
    } else {
      warnings.push(`The target changed since approval ${existing.id} was approved; the export's recheck will refuse and invalidate it. Request a new approval after reviewing the current page.`);
    }
  }
  const approval = gate.request({
    ...binding,
    target: proposal.targetUrl,
    summary: proposal.summary.slice(0, 600),
    payload: { change: proposal.change, targetFingerprint: fresh, currentSnapshotRef: proposal.current.snapshotRef, isSynthetic: proposal.isSynthetic, warnings: proposal.warnings },
    requestedBy: input.requestedBy,
    ...(input.ttlHours ? { ttlHours: input.ttlHours } : {}),
  });
  const stored = storedOf(gate.detail(ctx.siteId, approval.id));
  if (stored === null && !fingerprintFailed) {
    warnings.push(`No target fingerprint is stored on approval ${approval.id}; the pre-execution recheck will be unverifiable (export needs --allow-unverified-target, which is recorded).`);
  }
  if (approval.sourceRevision === null) {
    warnings.push('The approval is not bound to a source revision, so a later site change would not invalidate it. Bind one with --revision, or the approver must acknowledge this with --accept-unbound-revision.');
  }
  if (proposal.subjectType !== 'experiment') {
    const freeze = pageFreeze(ctx.db, ctx.siteId, { pageId: proposal.pageId, url: proposal.targetUrl });
    if (freeze.observing.length) warnings.push(`The page has an experiment under observation (${describeHolders(freeze.observing)}): the export will be refused unless a critical-fix reason is given.`);
    if (freeze.pending.length) warnings.push(`The page is also held by ${describeHolders(freeze.pending)}; one meaningful change per page at a time.`);
  }
  warnings.push(...proposal.warnings);
  // Not stored on the approval (acceptance can be recorded later without changing the artifact).
  const humanBlocker = draftHumanReviewBlocker(proposal);
  if (humanBlocker) {
    warnings.push(
      `Human review: ${humanBlocker}. The export will be refused until a named human accepts this exact body: \`content mark-reviewed ${proposal.subjectId} --as "<your name>" --confirm ${proposal.humanReview?.bodyHash.slice(0, 12) ?? '<body-hash prefix>'}\`.`,
    );
  }
  return { approval, artifactHash: hash, hashPrefix: hashPrefix(hash), targetFingerprint: stored, warnings };
}
