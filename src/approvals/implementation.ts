import type { AppContext } from '../app/context.js';
import { AppError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { addDays, dateInZone } from '../core/time.js';
import { budgetTimeZone } from '../app/context.js';
import { recordAudit } from '../database/audit.js';
import { parseInstant, recordAnnotation } from '../experiments/annotations.js';
import { describeHolders, pageFreeze } from '../experiments/freeze.js';
import { getExperiment } from '../experiments/repository.js';
import { REVIEW_BUFFER_DAYS } from '../experiments/propose.js';
import { transitionExperiment } from '../experiments/status.js';
import { normalizeUrl } from '../seo/url.js';
import { ownerActor, validateApproverName } from './approver.js';
import { shortRef } from './artifact.js';
import { getRecommendation, pickString, recommendationDetails, structuredChangeOf } from './change.js';
import { sitePageFetcherFromContext, type PageFetcher } from './page-fetch.js';
import { assertAllowed, policyActionForApproval } from './policy.js';
import { draftHumanReviewBlocker, proposalArtifactHash, type PublishProposal } from './publisher.js';
import type { ApprovalDetail, ApprovalService } from './service.js';
import { currentStateFor, isProposalSubjectType, resolveProposal } from './subjects.js';
import { expectationsFromChange, verifyLive, type VerificationResult } from './verify.js';

/**
 * mark-implemented: record that a human deployed an approved change.
 *
 * Validates that an approval exists for the EXACT artifact hash, that the
 * reported deployment time is not in the future and not before the approval
 * decision, and that the URL is the approved target. Captures before/after
 * snapshot references, records a publications row with rollback information,
 * verifies what actually went live when the page can be fetched (a mismatch
 * is recorded, never hidden; offline = "unverified"), and for experiments
 * starts the observation window at the ACTUAL implementation time (never the
 * approval or draft time).
 *
 * One approval authorizes exactly one implementation record:
 * - The normal path: the approval was executed by the EXECUTE-mode manual
 *   export (which rechecked the target immediately before execution), and no
 *   publication references it yet.
 * - A change that went live WITHOUT an export can only be recorded with an
 *   explicit reason (`deployedWithoutExport`) in EXECUTE mode. The approval is
 *   consumed here; the missing pre-execution recheck is recorded as
 *   "skipped" in the approval execution, the publication, and the audit log.
 * - Any other executed approval (already used for a publication, or consumed
 *   by something else) is refused: request a new approval.
 * The database also refuses a second publication for the same approval
 * (migration 0191).
 */

export interface MarkImplementedInput {
  subjectType: string;
  subjectId: string;
  /** ISO-8601 instant with an explicit zone: when the change actually went live. */
  implementedAt: string;
  /** Deployment/source revision (commit, CMS revision id). */
  revision: string;
  url?: string | null;
  recordedBy: string;
  /**
   * Allows recording on a page that another experiment is observing; recorded
   * as an overrides_freeze critical_fix annotation at the implementation
   * time. Defaults to the reason recorded by the export or the proposal.
   */
  criticalFixReason?: string | null;
  /**
   * The change went live without the EXECUTE-mode export (so no pre-execution
   * target recheck ran). Requires --mode EXECUTE; the reason is recorded.
   */
  deployedWithoutExport?: string | null;
}

export interface MarkImplementedResult {
  publicationId: string;
  subjectType: string;
  subjectId: string;
  approvalId: string;
  approvalConsumedNow: boolean;
  /** What guarded execution before the change went live. */
  preExecution: { exported: boolean; exportDir: string | null; recheck: string | null; deployedWithoutExport: string | null };
  implementedAt: string;
  sourceRevision: string;
  url: string;
  beforeSnapshotRef: string | null;
  afterSnapshotRef: string | null;
  verification: VerificationResult;
  rollback: Record<string, unknown>;
  experiment: { id: string; status: string; observationStart: string | null; reviewDate: string | null } | null;
  warnings: string[];
  isSynthetic: boolean;
}

function sameTarget(a: string, b: string): boolean {
  const na = normalizeUrl(a)?.url ?? a;
  const nb = normalizeUrl(b)?.url ?? b;
  return na === nb;
}

export async function markImplemented(ctx: AppContext, gate: ApprovalService, input: MarkImplementedInput, deps: { fetcher?: PageFetcher } = {}): Promise<MarkImplementedResult> {
  assertAllowed(ctx.mode, 'record_implementation');
  const recordedBy = validateApproverName(input.recordedBy);
  const actor = ownerActor(recordedBy);
  if (!isProposalSubjectType(input.subjectType)) throw new AppError('VALIDATION_FAILED', `Unsupported subject type "${input.subjectType}" (use experiment, draft, or recommendation).`);
  const implementedAt = parseInstant(input.implementedAt, '--at');
  const now = ctx.clock.now();
  if (new Date(implementedAt).getTime() > now.getTime()) {
    throw new AppError('VALIDATION_FAILED', `The implementation time ${implementedAt} is in the future. Record the actual time the change went live, after it went live.`);
  }
  const revision = (input.revision ?? '').trim();
  if (!revision) throw new AppError('VALIDATION_FAILED', 'A source/deployment revision is required (--revision).');
  const warnings: string[] = [];

  // Resolve the exact artifact that was approved.
  let proposal: PublishProposal;
  let artifactHash: string;
  if (input.subjectType === 'experiment') {
    const exp = getExperiment(ctx.db, ctx.siteId, input.subjectId);
    if (exp.status === 'observing' || ['positive', 'negative', 'inconclusive'].includes(exp.status)) {
      throw new AppError('CONFLICT', `Experiment ${exp.id} already has a recorded implementation (${exp.implementedAt}); status ${exp.status}.`);
    }
    if (exp.status === 'cancelled') throw new AppError('CONFLICT', `Experiment ${exp.id} is cancelled.`);
    proposal = resolveProposal(ctx, 'experiment', exp.id);
    artifactHash = exp.changeHash;
  } else {
    proposal = resolveProposal(ctx, input.subjectType, input.subjectId);
    artifactHash = proposalArtifactHash(proposal);
    if (!proposal.productionBound) throw new AppError('VALIDATION_FAILED', `${input.subjectType} ${input.subjectId} proposes no production change; nothing to mark implemented.`);
  }
  const url = input.url?.trim() || proposal.targetUrl;
  if (!sameTarget(url, proposal.targetUrl)) {
    throw new AppError('VALIDATION_FAILED', `The URL ${url} is not the approved target ${proposal.targetUrl}.`, {
      hint: 'An approval binds its target. If the change went live elsewhere, that is a different change: request a new approval for it.',
    });
  }

  const approval: ApprovalDetail | null = gate.findAuthorizing({ siteId: ctx.siteId, subjectType: proposal.subjectType, subjectId: proposal.subjectId, artifactHash, actionType: proposal.actionType });
  if (!approval) {
    const latest = gate.latestForSubject(ctx.siteId, proposal.subjectType, proposal.subjectId);
    const why = !latest
      ? 'no approval exists for it'
      : latest.artifactHash !== artifactHash
        ? `the latest approval (${latest.id}, ${latest.status}) is for a different artifact (${shortRef(latest.artifactHash)}... vs current ${shortRef(artifactHash)}...)`
        : `the latest approval (${latest.id}) is ${latest.status}`;
    throw new AppError('APPROVAL_REQUIRED', `Cannot mark ${proposal.subjectType} ${proposal.subjectId} implemented: ${why}.`, {
      hint: 'Only a change a human approved via `approvals approve` can be recorded as implemented. An `approved: true` note in Markdown does not count.',
    });
  }
  if (!approval.decidedAt || new Date(implementedAt).getTime() < new Date(approval.decidedAt).getTime()) {
    throw new AppError('VALIDATION_FAILED', `The implementation time ${implementedAt} is before the approval decision (${approval.decidedAt}). A change deployed before approval was not authorized by it.`);
  }

  // One approval authorizes exactly one implementation record.
  const withoutExport = input.deployedWithoutExport?.trim() || null;
  const execution = approval.execution ?? {};
  const exportedBy = approval.status === 'executed' && execution.kind === 'manual_export';
  if (approval.status === 'executed') {
    if (!exportedBy) {
      throw new AppError('APPROVAL_INVALID', `Approval ${approval.id} was already used (${String(execution.kind ?? 'unknown execution')} at ${approval.executedAt}); one approval authorizes one implementation.`, {
        details: { approvalId: approval.id, executionKind: execution.kind ?? null },
        hint: `Request and approve a new approval for this change: \`approvals request ${proposal.subjectType} ${proposal.subjectId}\`.`,
      });
    }
    const used = publicationForApproval(ctx, approval.id);
    if (used) {
      throw new AppError('APPROVAL_INVALID', `Approval ${approval.id} already authorized publication ${used.id} (implemented ${used.implemented_at}); one approval authorizes one implementation.`, {
        details: { approvalId: approval.id, publicationId: used.id },
        hint: `A further deployment of this change needs its own approval: \`approvals request ${proposal.subjectType} ${proposal.subjectId}\`.`,
      });
    }
    if (withoutExport) warnings.push('--deployed-without-export was ignored: the approval was executed by an export.');
  } else {
    // Approved but never exported: the EXECUTE gate and the pre-execution
    // target recheck of the export did not run.
    if (!withoutExport) {
      throw new AppError('APPROVAL_INVALID', `Approval ${approval.id} was never exported: the EXECUTE-mode export, which rechecks the target immediately before execution, has not run.`, {
        details: { approvalId: approval.id, reason: 'not_exported' },
        hint: `Export first (\`export ${proposal.subjectType} ${proposal.subjectId} --mode EXECUTE\`), deploy exactly that package, then run mark-implemented. If the change is ALREADY live without an export, record that explicitly: --deployed-without-export "<reason>" --mode EXECUTE (the skipped recheck is recorded).`,
      });
    }
    // Consuming a production approval outside the export still needs EXECUTE mode and a valid approval of the same action type.
    assertAllowed(ctx.mode, policyActionForApproval(proposal.actionType), { approval: { ok: true, approval } });
    warnings.push(`Recorded without an export: the pre-execution target recheck was skipped (reason: ${withoutExport}).`);
    // The export would have refused a draft without a recorded human acceptance; what went live is still recorded, visibly.
    const humanBlocker = draftHumanReviewBlocker(proposal);
    if (humanBlocker) warnings.push(`Draft ${proposal.subjectId} went live without the recorded human review that export requires (${humanBlocker}).`);
  }
  const preExecution = {
    exported: exportedBy,
    exportDir: exportedBy && typeof execution.exportDir === 'string' ? execution.exportDir : null,
    recheck: exportedBy ? (typeof execution.recheck === 'string' ? execution.recheck : null) : 'skipped',
    deployedWithoutExport: exportedBy ? null : withoutExport,
  };

  // One meaningful change per page at a time.
  const freeze = pageFreeze(ctx.db, ctx.siteId, { pageId: proposal.pageId, url: proposal.targetUrl }, { excludeExperimentId: proposal.subjectType === 'experiment' ? proposal.subjectId : null });
  let criticalFix = input.criticalFixReason?.trim() || null;
  if (freeze.observing.length && !criticalFix) {
    const fromExport = typeof execution.criticalFixReason === 'string' ? execution.criticalFixReason : null;
    const fromProposal = proposal.subjectType === 'experiment' ? ((getExperiment(ctx.db, ctx.siteId, proposal.subjectId).evidence as { freezeOverride?: { reason?: unknown } | null }).freezeOverride?.reason ?? null) : null;
    criticalFix = fromExport ?? (typeof fromProposal === 'string' ? fromProposal : null);
    if (criticalFix) warnings.push(`Using the critical-fix reason recorded at ${fromExport ? 'export' : 'proposal'}: ${criticalFix}`);
  }
  if (freeze.observing.length) {
    if (!criticalFix) {
      throw new AppError('CONFLICT', `Page ${proposal.targetUrl} has an experiment under observation (${describeHolders(freeze.observing)}); another change would contaminate it.`, {
        hint: 'Only critical broken functionality may override the observation freeze: pass --critical-fix "<reason>" (recorded and flagged on the running experiment).',
      });
    }
    warnings.push(`Observation freeze overridden for ${describeHolders(freeze.observing)}: ${criticalFix}`);
  }
  if (freeze.pending.length) warnings.push(`The page is also held by ${describeHolders(freeze.pending)}; this change will interfere with that experiment's measurement.`);
  const overrideReason = freeze.observing.length ? criticalFix : null;
  let overrideAnnotationId: string | null = null;

  // Snapshots.
  const before = currentStateFor(ctx, proposal.pageId, proposal.targetUrl, implementedAt);
  const exportDir = preExecution.exportDir;
  const beforeSnapshotRef = before.snapshotRef ?? (exportDir ? `export:${exportDir}/rollback.json` : null);
  if (!before.snapshotRef) warnings.push(exportDir ? 'No crawl snapshot before the implementation; the export package rollback.json is the before-reference.' : 'No before-snapshot is available; rollback depends on the site revision history.');

  const fetcher = deps.fetcher ?? sitePageFetcherFromContext(ctx);
  const fetched = await fetcher(url);
  let afterSnapshotRef: string | null = null;
  if (fetched.ok) {
    afterSnapshotRef = ctx.raw.save({
      siteId: ctx.siteId,
      provider: 'own_site',
      kind: 'after_snapshot',
      payload: { url, finalUrl: fetched.page.finalUrl, status: fetched.page.status, fetchedAt: fetched.page.fetchedAt, redirectChain: fetched.page.redirectChain, html: fetched.page.html },
      at: now,
    });
  }
  const bodyScope = bodyScopeOf(ctx, proposal);
  const verification = verifyLive(expectationsFromChange(proposal.actionType, proposal.change, { bodyScope, baselineText: before.text }), fetched, artifactHash);
  if (verification.status !== 'match') warnings.push(`Live verification: ${verification.status}${verification.reason ? ` (${verification.reason})` : ''}.`);
  if (verification.coverage?.unapproved.status === 'found') {
    warnings.push(`The live page contains main text that is not in the approved artifact (possible unapproved or injected content): ${verification.coverage.unapproved.blocks.slice(0, 3).map((b) => `"${b}"`).join(', ')}. Review the live page and the deployed package.`);
  }
  const rollback = {
    plan: proposal.rollbackPlan,
    previous: { snapshotRef: before.snapshotRef, capturedAt: before.capturedAt, title: before.title, metaDescription: before.metaDescription, canonical: before.canonical, robots: before.robots },
    exportRollback: exportDir ? `${exportDir}/rollback.json` : null,
    sourceRevisionDeployed: revision,
    sourceRevisionAtApproval: approval.sourceRevision,
  };

  const publicationId = newId('pub');
  const createdAt = now.toISOString();
  const tz = budgetTimeZone(ctx.config);
  let consumedNow = false;
  const expOut = ctx.db.transaction(() => {
    const dup = publicationForApproval(ctx, approval.id);
    if (dup) throw new AppError('APPROVAL_INVALID', `Approval ${approval.id} already authorized publication ${dup.id}; one approval authorizes one implementation.`);
    if (approval.status === 'approved') {
      gate.consume(approval.id, { kind: 'mark_implemented_without_export', actor, implementedAt, revision, url, recheck: 'skipped', deployedWithoutExport: withoutExport });
      consumedNow = true;
    }
    const annotatedPageId = freeze.pageId ?? proposal.pageId;
    if (overrideReason && annotatedPageId) {
      // Written now, at the ACTUAL deployment time: this is what flags the running experiment(s).
      overrideAnnotationId = recordAnnotation(ctx.db, ctx.clock, {
        siteId: ctx.siteId,
        scope: 'page',
        kind: 'critical_fix',
        occurredAt: implementedAt,
        description: `Critical fix deployed during an observation freeze (${describeHolders(freeze.observing)}): ${overrideReason}`,
        pageId: annotatedPageId,
        source: `${proposal.subjectType}:${proposal.subjectId}:critical_fix`,
        overridesFreeze: true,
        recordedBy: actor,
      }).annotation.id;
    }
    ctx.db.run(
      `INSERT INTO publications (id, site_id, subject_type, subject_id, approval_id, url, page_id, method, export_path, implemented_at, source_revision,
         before_snapshot_ref, after_snapshot_ref, verified_live, verification_json, rollback_json, recorded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'manual_export', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        publicationId,
        ctx.siteId,
        proposal.subjectType,
        proposal.subjectId,
        approval.id,
        url,
        proposal.pageId,
        exportDir,
        implementedAt,
        revision,
        beforeSnapshotRef,
        afterSnapshotRef,
        verification.status === 'match' ? 1 : 0,
        JSON.stringify({ ...verification, preExecution }),
        JSON.stringify(rollback),
        actor,
        createdAt,
      ],
    );
    let expResult: MarkImplementedResult['experiment'] = null;
    if (proposal.subjectType === 'experiment') {
      let exp = getExperiment(ctx.db, ctx.siteId, proposal.subjectId);
      if (exp.status === 'proposed') {
        throw new AppError('CONFLICT', `Experiment ${exp.id} is still proposed although approval ${approval.id} exists; run \`approvals show ${approval.id}\` to check.`);
      }
      if (exp.status === 'approved') {
        exp = transitionExperiment(ctx.db, ctx.clock, { siteId: ctx.siteId, experimentId: exp.id, to: 'awaiting_implementation', actor, reason: 'implemented manually from the approved change', patch: { approval_id: approval.id } });
      }
      const reviewDate = addDays(dateInZone(new Date(implementedAt), tz), exp.minObservationDays + REVIEW_BUFFER_DAYS);
      exp = transitionExperiment(ctx.db, ctx.clock, {
        siteId: ctx.siteId,
        experimentId: exp.id,
        to: 'observing',
        actor,
        reason: `implemented at ${implementedAt} (revision ${revision}); observation starts at the actual implementation time`,
        expectFrom: ['awaiting_implementation'],
        patch: {
          implemented_at: implementedAt,
          observation_start: implementedAt,
          source_revision: revision,
          before_snapshot_ref: beforeSnapshotRef,
          after_snapshot_ref: afterSnapshotRef,
          approval_id: approval.id,
          review_date: reviewDate,
        },
      });
      expResult = { id: exp.id, status: exp.status, observationStart: exp.observationStart, reviewDate: exp.reviewDate };
      // The recommendation the experiment tests is now implemented (it is never recorded as superseded by a later run).
      if (exp.recommendationId) {
        ctx.db.run(`UPDATE recommendations SET status = 'implemented', updated_at = ? WHERE site_id = ? AND id = ? AND status IN ('proposed', 'approved')`, [createdAt, ctx.siteId, exp.recommendationId]);
      }
    } else if (proposal.subjectType === 'draft') {
      ctx.db.run(`UPDATE content_drafts SET status = 'published' WHERE site_id = ? AND id = ? AND status IN ('review_passed', 'approved', 'exported')`, [ctx.siteId, proposal.subjectId]);
    } else if (proposal.subjectType === 'recommendation') {
      ctx.db.run(`UPDATE recommendations SET status = 'implemented', updated_at = ? WHERE site_id = ? AND id = ? AND status IN ('proposed', 'approved')`, [createdAt, ctx.siteId, proposal.subjectId]);
    }
    recordAudit(ctx.db, {
      siteId: ctx.siteId,
      actor,
      eventType: 'implementation.recorded',
      subjectType: proposal.subjectType,
      subjectId: proposal.subjectId,
      details: {
        publicationId,
        approvalId: approval.id,
        implementedAt,
        revision,
        url,
        verification: verification.status,
        ...(verification.coverage
          ? { coverage: { summary: verification.coverage.summary, paragraphs: { total: verification.coverage.paragraphs.total, found: verification.coverage.paragraphs.found }, unapproved: verification.coverage.unapproved.status } }
          : {}),
        overrideAnnotationId,
        preExecution,
      },
      at: now,
    });
    return expResult;
  });

  return {
    publicationId,
    subjectType: proposal.subjectType,
    subjectId: proposal.subjectId,
    approvalId: approval.id,
    approvalConsumedNow: consumedNow,
    preExecution,
    implementedAt,
    sourceRevision: revision,
    url,
    beforeSnapshotRef,
    afterSnapshotRef,
    verification,
    rollback,
    experiment: expOut,
    warnings,
    isSynthetic: proposal.isSynthetic,
  };
}

/**
 * Whether the approved body is the page's whole main content ('full': drafts,
 * full-content changes) or one section of an existing page ('section': a
 * structured section change or proposedSectionMarkdown). Decides how live
 * text outside the approved paragraphs is judged.
 */
function bodyScopeOf(ctx: AppContext, proposal: PublishProposal): 'full' | 'section' {
  if (proposal.subjectType === 'draft') return 'full';
  const sectionIn = (details: Record<string, unknown>) => structuredChangeOf(details)?.kind === 'section' || !!pickString(details, 'proposedSectionMarkdown');
  if (proposal.subjectType === 'recommendation') {
    const rec = getRecommendation(ctx.db, ctx.siteId, proposal.subjectId);
    return rec && sectionIn(recommendationDetails(rec)) ? 'section' : 'full';
  }
  const exp = getExperiment(ctx.db, ctx.siteId, proposal.subjectId);
  const s = (exp.evidence as { structuredChange?: { kind?: unknown } | null }).structuredChange;
  if (s && s.kind === 'section') return 'section';
  const rec = exp.recommendationId ? getRecommendation(ctx.db, ctx.siteId, exp.recommendationId) : null;
  return rec && sectionIn(recommendationDetails(rec)) ? 'section' : 'full';
}

function publicationForApproval(ctx: AppContext, approvalId: string): { id: string; implemented_at: string } | null {
  return ctx.db.get<{ id: string; implemented_at: string }>('SELECT id, implemented_at FROM publications WHERE site_id = ? AND approval_id = ? LIMIT 1', [ctx.siteId, approvalId]) ?? null;
}

export function listPublications(ctx: AppContext, opts: { subjectType?: string; subjectId?: string } = {}): Array<Record<string, unknown>> {
  const where = ['site_id = ?'];
  const params: unknown[] = [ctx.siteId];
  if (opts.subjectType) {
    where.push('subject_type = ?');
    params.push(opts.subjectType);
  }
  if (opts.subjectId) {
    where.push('subject_id = ?');
    params.push(opts.subjectId);
  }
  return ctx.db.all(`SELECT * FROM publications WHERE ${where.join(' AND ')} ORDER BY implemented_at DESC`, params);
}
