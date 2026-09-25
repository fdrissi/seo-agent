import type { AppContext } from '../app/context.js';
import { budgetTimeZone } from '../app/context.js';
import { AppError } from '../core/errors.js';
import { recordAudit } from '../database/audit.js';
import { describeHolders, pageFreeze } from '../experiments/freeze.js';
import { findExperiment } from '../experiments/repository.js';
import { transitionExperiment } from '../experiments/status.js';
import { sitePageFetcherFromContext } from './page-fetch.js';
import { assertAllowed, evaluatePolicy, policyActionForApproval } from './policy.js';
import { assertDraftHumanAccepted, ManualExportPublisher, type PreparedArtifact, type PublishResult } from './publisher.js';
import type { ApprovalService } from './service.js';
import { resolveProposal } from './subjects.js';
import { pageTargetChecker, recheckTarget, type TargetChecker, type TargetRecheck } from './target-check.js';
import type { ApprovalCheck } from './types.js';

/**
 * `export <subject-type> <id>`: build the exact artifact and, for
 * production-bound subjects, execute it through the ManualExportPublisher
 * only when (1) the runtime mode is EXECUTE, (2) for a draft, a named human
 * accepted its exact body (`content mark-reviewed`; automated verdicts never
 * count), (3) a valid human approval binds this exact artifact hash (and
 * source revision), and (4) the target recheck immediately before execution
 * shows it unchanged (or the owner explicitly accepts an unverifiable
 * recheck, which is recorded). The approval is consumed (one-time) in the
 * same transaction that writes the package.
 *
 * One meaningful change per page: a production-bound export for a page that
 * another experiment is observing is refused unless the owner gives a
 * critical-fix reason (recorded in the approval execution, the audit log,
 * and the package; mark-implemented turns it into a critical_fix annotation
 * at the actual deployment time). Other open experiments on the page are
 * reported as warnings.
 */

export interface ExportInput {
  subjectType: string;
  subjectId: string;
  actor: string;
  sourceRevision?: string | null;
  allowUnverifiedTarget?: boolean;
  /** Critical broken functionality only: export although another experiment is observing the page (recorded). */
  criticalFixReason?: string | null;
  dryRun?: boolean;
  /**
   * The owner states that the supplied --revision is the site's CURRENT
   * revision and the approval's bound revision is stale: a mismatching live
   * approval is invalidated (recorded). Without it, a revision mismatch is
   * only refused and the approval is left untouched (a typo destroys nothing).
   */
  invalidateStale?: boolean;
}

export interface ExportOutcome {
  status: 'exported' | 'dry_run';
  productionBound: boolean;
  subjectType: string;
  subjectId: string;
  actionType: string;
  targetUrl: string;
  artifactHash: string;
  approval: ApprovalCheck | null;
  recheck: TargetRecheck | null;
  result: PublishResult | null;
  plannedDir: string | null;
  warnings: string[];
  /** Experiments holding the target page (observing ones require a critical-fix reason). */
  pageHeldBy: Array<{ id: string; status: string }>;
  criticalFixReason: string | null;
  isSynthetic: boolean;
}

export function manualExportPublisher(ctx: AppContext): ManualExportPublisher {
  return new ManualExportPublisher({ exportsDir: ctx.paths.exportsDir, siteId: ctx.siteId, timeZone: budgetTimeZone(ctx.config), clock: ctx.clock });
}

export function defaultTargetChecker(ctx: AppContext): TargetChecker {
  return pageTargetChecker(sitePageFetcherFromContext(ctx), () => ctx.clock.now());
}

export function prepareArtifact(ctx: AppContext, subjectType: string, subjectId: string): PreparedArtifact {
  return manualExportPublisher(ctx).prepare(resolveProposal(ctx, subjectType, subjectId));
}

export async function exportSubject(ctx: AppContext, gate: ApprovalService, input: ExportInput, deps: { targetChecker?: TargetChecker; publisher?: ManualExportPublisher } = {}): Promise<ExportOutcome> {
  const publisher = deps.publisher ?? manualExportPublisher(ctx);
  const proposal = resolveProposal(ctx, input.subjectType, input.subjectId);
  const artifact = publisher.prepare(proposal);
  const base = {
    productionBound: proposal.productionBound,
    subjectType: proposal.subjectType,
    subjectId: proposal.subjectId,
    actionType: proposal.actionType,
    targetUrl: proposal.targetUrl,
    artifactHash: artifact.artifactHash,
    warnings: artifact.proposal.warnings,
    pageHeldBy: [] as Array<{ id: string; status: string }>,
    criticalFixReason: null as string | null,
    isSynthetic: proposal.isSynthetic,
  };

  if (!proposal.productionBound) {
    assertAllowed(ctx.mode, 'export_record');
    if (input.dryRun || ctx.dryRun) return { ...base, status: 'dry_run', approval: null, recheck: null, result: null, plannedDir: publisher.plannedDir(artifact) };
    const result = publisher.publishSync({ artifact, approval: null, recheck: null, allowUnverifiedTarget: false, actor: input.actor });
    recordAudit(ctx.db, {
      siteId: ctx.siteId,
      actor: input.actor,
      eventType: 'export.record_exported',
      subjectType: proposal.subjectType,
      subjectId: proposal.subjectId,
      details: { exportDir: result.exportDir, artifactHash: artifact.artifactHash },
      at: ctx.clock.now(),
    });
    return { ...base, status: 'exported', approval: null, recheck: null, result, plannedDir: result.exportDir };
  }

  // Production-bound: mode + exact approval, enforced in code.
  const action = policyActionForApproval(proposal.actionType);
  const modeOnly = evaluatePolicy(ctx.mode, action, {});
  if (modeOnly.reason === 'mode_insufficient') assertAllowed(ctx.mode, action);
  // Drafts: human review is required for publication IN ADDITION to the approval
  // (a named human's recorded acceptance of this exact body; automated verdicts never count).
  assertDraftHumanAccepted(proposal);
  const dryRun = !!(input.dryRun || ctx.dryRun);
  const binding = {
    siteId: ctx.siteId,
    actionType: proposal.actionType,
    subjectType: proposal.subjectType,
    subjectId: proposal.subjectId,
    artifactHash: artifact.artifactHash,
    sourceRevision: input.sourceRevision ?? null,
  };
  // A dry run only looks (pure check, no expiry writes, nothing invalidated).
  // A real run owns this proposal and knows its CURRENT hash: live approvals for
  // another hash are invalidated (verified evidence). A differing --revision is
  // unverified and only refused, unless the owner passes --invalidate-stale.
  const check = dryRun ? gate.check(binding, { readOnly: true }) : gate.checkCurrent(binding, { invalidateStaleRevision: !!input.invalidateStale, actor: input.actor });
  if (!check.ok) {
    const bound = check.approval?.sourceRevision ?? null;
    const supplied = input.sourceRevision ?? null;
    const detail =
      check.reason === 'revision_mismatch'
        ? supplied
          ? ` The supplied --revision "${supplied}" does not match the revision "${bound}" that approval ${check.approval?.id} is bound to. The supplied revision was not verified against the site, so nothing was invalidated.`
          : ` Approval ${check.approval?.id} is bound to revision "${bound}", and no --revision was supplied. Nothing was invalidated.`
        : check.reason === 'hash_mismatch'
          ? ` The current proposal hashes to ${artifact.artifactHash.slice(0, 12)}..., which no approval binds: the proposal changed after it was approved${dryRun ? '' : ' (the stale approval was invalidated)'}.`
          : '';
    const hint =
      check.reason === 'none'
        ? `Request one: \`approvals request ${proposal.subjectType} ${proposal.subjectId}\`. A human then reviews it with \`approvals show <id>\` and approves it.`
        : check.reason === 'revision_mismatch'
          ? `Re-run with --revision "${bound}" if that is still the site's revision (check for a typo). If the site really changed since the approval, re-run with the current --revision and --invalidate-stale (recorded), then request a new approval.`
          : check.reason === 'pending'
            ? `A human must review (\`approvals show ${check.approval?.id}\`) and approve it first.`
            : check.reason === 'hash_mismatch'
              ? `Review the current proposal and request a new approval: \`approvals request ${proposal.subjectType} ${proposal.subjectId}\`.`
              : `Approval ${check.approval?.id ?? ''} is ${check.approval?.status ?? check.reason}. Request a new approval for the current proposal: \`approvals request ${proposal.subjectType} ${proposal.subjectId}\`.`;
    throw new AppError(check.reason === 'none' ? 'APPROVAL_REQUIRED' : 'APPROVAL_INVALID', `Export of ${proposal.subjectType} ${proposal.subjectId} is not authorized: approval ${check.reason}.${detail}`, {
      details: {
        reason: check.reason,
        artifactHash: artifact.artifactHash,
        ...(check.approval ? { approvalId: check.approval.id, approvalStatus: check.approval.status } : {}),
        ...(check.reason === 'revision_mismatch' ? { boundRevision: bound, suppliedRevision: supplied, invalidated: false } : {}),
      },
      hint,
    });
  }
  assertAllowed(ctx.mode, action, { approval: check });
  const approval = check.approval;
  const warnings = artifact.proposal.warnings; // also rendered into the package README
  if (approval.sourceRevision === null) {
    warnings.push(
      `Approval ${approval.id} is not bound to a source revision (the approver accepted that explicitly)${input.sourceRevision ? `; the supplied --revision ${input.sourceRevision} could not be verified against it` : ''}.`,
    );
  }

  // One meaningful change per page at a time.
  const freeze = pageFreeze(ctx.db, ctx.siteId, { pageId: proposal.pageId, url: proposal.targetUrl }, { excludeExperimentId: proposal.subjectType === 'experiment' ? proposal.subjectId : null });
  const criticalFix = input.criticalFixReason?.trim() || null;
  const heldBy = [...freeze.observing, ...freeze.pending].map((e) => ({ id: e.id, status: e.status }));
  if (freeze.observing.length && !criticalFix) {
    throw new AppError('CONFLICT', `Refusing to export: ${proposal.targetUrl} has an experiment under observation (${describeHolders(freeze.observing)}); another change would contaminate its measurement.`, {
      details: { observing: freeze.observing.map((e) => e.id) },
      hint: 'Wait until it concludes or cancel it. Only critical broken functionality may override the observation freeze: pass --critical-fix "<reason>" (recorded; the running experiment is flagged when the fix is marked implemented).',
    });
  }
  if (freeze.observing.length) warnings.push(`Observation freeze overridden for ${describeHolders(freeze.observing)} (critical fix: ${criticalFix}). Record the deployment with mark-implemented; it flags the running experiment(s).`);
  if (freeze.pending.length) warnings.push(`The page is also held by ${describeHolders(freeze.pending)}; one meaningful change per page at a time. Deploying this change will interfere with that experiment's measurement.`);
  const held = { pageHeldBy: heldBy, criticalFixReason: freeze.observing.length ? criticalFix : null };

  if (dryRun) return { ...base, ...held, status: 'dry_run', approval: check, recheck: null, result: null, plannedDir: publisher.plannedDir(artifact) };

  // Recheck the target immediately before execution.
  const detail = gate.detail(ctx.siteId, approval.id);
  const expected = typeof detail.payload?.targetFingerprint === 'string' ? detail.payload.targetFingerprint : null;
  const recheck = await recheckTarget(deps.targetChecker ?? defaultTargetChecker(ctx), proposal.targetUrl, expected);
  recordAudit(ctx.db, { siteId: ctx.siteId, actor: input.actor, eventType: 'approval.target_recheck', subjectType: 'approval', subjectId: approval.id, details: { ...recheck }, at: ctx.clock.now() });
  if (recheck.status === 'changed') {
    gate.invalidate(ctx.siteId, approval.id, `target changed before execution: ${recheck.detail}`, input.actor);
    throw new AppError('CONFLICT', `Refusing to export: ${recheck.detail} Approval ${approval.id} was invalidated.`, {
      hint: `Review the current page and request a new approval: \`approvals request ${proposal.subjectType} ${proposal.subjectId}\`.`,
    });
  }
  if (recheck.status === 'unverifiable' && !input.allowUnverifiedTarget) {
    throw new AppError('DATA_UNAVAILABLE', `Refusing to export: ${recheck.detail}`, {
      hint: 'Run online so the target can be rechecked, or pass --allow-unverified-target to proceed (recorded in the approval execution and the package).',
    });
  }

  const planned = publisher.plannedDir(artifact);
  const result = ctx.db.transaction(() => {
    gate.consume(approval.id, {
      kind: 'manual_export',
      actor: input.actor,
      exportDir: planned,
      artifactHash: artifact.artifactHash,
      recheck: recheck.status,
      allowUnverifiedTarget: !!input.allowUnverifiedTarget,
      sourceRevisionSupplied: input.sourceRevision ?? null,
      sourceRevisionBound: approval.sourceRevision,
      ...(held.criticalFixReason ? { criticalFixReason: held.criticalFixReason, freezeOverriddenFor: freeze.observing.map((e) => e.id) } : {}),
    });
    const executed = gate.get(approval.id)!;
    const r = publisher.publishSync({ artifact, approval: executed, recheck, allowUnverifiedTarget: !!input.allowUnverifiedTarget, actor: input.actor }, planned);
    if (proposal.subjectType === 'experiment') {
      const exp = findExperiment(ctx.db, ctx.siteId, proposal.subjectId);
      if (exp?.status === 'approved') {
        transitionExperiment(ctx.db, ctx.clock, { siteId: ctx.siteId, experimentId: exp.id, to: 'awaiting_implementation', actor: input.actor, reason: `exported for manual implementation (${r.exportDir})`, patch: { approval_id: approval.id } });
      }
    } else if (proposal.subjectType === 'draft') {
      ctx.db.run(`UPDATE content_drafts SET status = 'exported' WHERE site_id = ? AND id = ? AND status IN ('review_passed', 'approved')`, [ctx.siteId, proposal.subjectId]);
    }
    recordAudit(ctx.db, {
      siteId: ctx.siteId,
      actor: input.actor,
      eventType: 'export.package_written',
      subjectType: proposal.subjectType,
      subjectId: proposal.subjectId,
      details: { approvalId: approval.id, exportDir: r.exportDir, artifactHash: artifact.artifactHash, recheck: recheck.status, pageHeldBy: heldBy, criticalFixReason: held.criticalFixReason },
      at: ctx.clock.now(),
    });
    if (held.criticalFixReason) {
      recordAudit(ctx.db, {
        siteId: ctx.siteId,
        actor: input.actor,
        eventType: 'export.freeze_override',
        subjectType: proposal.subjectType,
        subjectId: proposal.subjectId,
        details: { approvalId: approval.id, reason: held.criticalFixReason, observing: freeze.observing.map((e) => e.id), targetUrl: proposal.targetUrl },
        at: ctx.clock.now(),
      });
    }
    return r;
  });
  return { ...base, ...held, status: 'exported', approval: { ok: true, approval: gate.get(approval.id)! }, recheck, result, plannedDir: result.exportDir };
}
