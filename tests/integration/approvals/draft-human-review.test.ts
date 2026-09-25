/**
 * A production-bound draft export needs a named human's recorded acceptance of
 * the exact draft body (`content mark-reviewed`) IN ADDITION to a valid
 * approval (spec sections 22 and 24). Automated verdicts never count.
 * SYNTHETIC drafts on example.test domains only.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDecisionEffects } from '../../../src/approvals/effects.js';
import { exportSubject, manualExportPublisher } from '../../../src/approvals/export.js';
import { markImplemented } from '../../../src/approvals/implementation.js';
import { draftHumanReviewBlocker } from '../../../src/approvals/publisher.js';
import { requestApprovalForSubject } from '../../../src/approvals/requests.js';
import { ApprovalService } from '../../../src/approvals/service.js';
import { draftHumanReview, resolveProposal } from '../../../src/approvals/subjects.js';
import type { TargetChecker } from '../../../src/approvals/target-check.js';
import { resolveContentDeps } from '../../../src/content/deps.js';
import { checkPublicationGate } from '../../../src/content/publication.js';
import { insertQualityReview } from '../../../src/content/store.js';
import { sha256 } from '../../../src/core/hash.js';
import { acceptDraftAsHuman, experimentsSiteConfig, seedDraft } from '../../fixtures/experiments/seed.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

const NOW = '2026-09-20T09:00:00.000Z';
const absent: TargetChecker = {
  async fingerprint() {
    return { ok: true as const, fingerprint: 'absent:404', checkedAt: NOW, detail: 'synthetic: page does not exist yet' };
  },
};

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

function exportedDirs(c: TestContext): string[] {
  const base = path.join(c.paths.exportsDir, c.siteId);
  return existsSync(base) ? readdirSync(base).filter((d) => !d.startsWith('.')) : [];
}

/** A draft that passed the AUTOMATED review only (status review_passed, verdict pass), approved by a human. */
async function automatedPassWithApproval(c: TestContext, gate: ApprovalService) {
  const { draftId } = seedDraft(c.db, c.siteId);
  insertQualityReview(c.db, { siteId: c.siteId, subjectType: 'draft', subjectId: draftId, verdict: 'pass', deterministic: { synthetic: true }, aiReview: null, reasons: [], revisionRound: 0, now: NOW });
  const req = await requestApprovalForSubject(c, gate, { subjectType: 'draft', subjectId: draftId, requestedBy: 'owner:Alice' }, { targetChecker: absent });
  const approved = gate.approve(c.siteId, req.approval.id, { approver: 'Alice', confirmHashPrefix: req.hashPrefix, acknowledgeUnboundRevision: true });
  const effects = applyDecisionEffects(c.db, c.clock, approved, 'owner:Alice');
  return { draftId, req, effects };
}

const draftStatus = (c: TestContext, id: string) => c.db.get<{ status: string }>('SELECT status FROM content_drafts WHERE id = ?', [id])!.status;

describe('production-bound draft export requires a recorded human acceptance', () => {
  it('refuses an approved draft that only passed automated review, with the next step; nothing is written or consumed', async () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: NOW, mode: 'EXECUTE' });
    const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
    const { draftId, req, effects } = await automatedPassWithApproval(ctx, gate);
    const bodyHash = draftHumanReview(ctx, draftId, (JSON.parse(ctx.db.get<{ package_json: string }>('SELECT package_json FROM content_drafts WHERE id = ?', [draftId])!.package_json) as { body: string }).body).bodyHash;

    // The request warned, and the approval decision did not mark the draft approved (so it can still be reviewed).
    expect(req.warnings.join(' ')).toMatch(/Human review: the latest review \(qrv_\w+, verdict pass\) is automated.*export will be refused.*content mark-reviewed/);
    expect(draftStatus(ctx, draftId)).toBe('review_passed');
    expect(effects.join(' ')).toMatch(new RegExp(`stays "review_passed".*content mark-reviewed ${draftId} --as "<your name>" --confirm ${bodyHash.slice(0, 12)}`));

    for (const dryRun of [true, false]) {
      const err = await exportSubject(ctx, gate, { subjectType: 'draft', subjectId: draftId, actor: 'owner:Alice', dryRun }, { targetChecker: absent }).catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: 'POLICY_DENIED',
        message: expect.stringMatching(/Export of draft .* is refused: the latest review .* is automated.*in addition to a valid approval; automated quality verdicts never count/),
        details: { reason: 'human_review_required', draftId, bodyHash },
        hint: expect.stringContaining(`content mark-reviewed ${draftId} --as "<your name>" --confirm ${bodyHash.slice(0, 12)}`),
      });
    }
    expect(exportedDirs(ctx)).toEqual([]);
    expect(gate.get(req.approval.id)?.status).toBe('approved');
  });

  it('after a named human accepts the exact body, the same approval exports, and the package records who accepted it', async () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: NOW, mode: 'EXECUTE' });
    const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
    const { draftId, req } = await automatedPassWithApproval(ctx, gate);
    // Possible AFTER the approval: the draft stayed reviewable.
    const accepted = acceptDraftAsHuman(ctx, draftId, 'Bob');
    const r = await exportSubject(ctx, gate, { subjectType: 'draft', subjectId: draftId, actor: 'owner:Alice' }, { targetChecker: absent });
    expect(r.status).toBe('exported');
    expect(r.artifactHash).toBe(req.artifactHash); // acceptance does not change the artifact
    expect(gate.get(req.approval.id)?.status).toBe('executed');
    expect(draftStatus(ctx, draftId)).toBe('exported');
    const meta = JSON.parse(readFileSync(path.join(r.result!.exportDir, 'metadata.json'), 'utf8'));
    expect(meta.humanReview).toEqual({ accepted: true, reviewer: 'Bob', reviewId: accepted.reviewId, reviewedAt: NOW, bodyHash: accepted.bodyHash, reason: null });
  });

  it('a later automated re-review, or an acceptance of a different body, no longer counts', async () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: NOW, mode: 'EXECUTE' });
    const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
    const { draftId } = seedDraft(ctx.db, ctx.siteId);
    acceptDraftAsHuman(ctx, draftId);
    const req = await requestApprovalForSubject(ctx, gate, { subjectType: 'draft', subjectId: draftId, requestedBy: 'owner:Alice' }, { targetChecker: absent });
    expect(req.warnings.join(' ')).not.toMatch(/Human review:/);
    const approved = gate.approve(ctx.siteId, req.approval.id, { approver: 'Alice', confirmHashPrefix: req.hashPrefix, acknowledgeUnboundRevision: true });
    expect(applyDecisionEffects(ctx.db, ctx.clock, approved, 'owner:Alice').join(' ')).toMatch(/marked approved for export \(body accepted by Alice\)/);

    // An automated review recorded after the human acceptance supersedes it.
    ctx.clock.set('2026-09-20T09:30:00.000Z');
    insertQualityReview(ctx.db, { siteId: ctx.siteId, subjectType: 'draft', subjectId: draftId, verdict: 'pass', deterministic: { synthetic: true }, aiReview: null, reasons: [], revisionRound: 0, now: ctx.clock.now().toISOString() });
    await expect(exportSubject(ctx, gate, { subjectType: 'draft', subjectId: draftId, actor: 'owner:Alice' }, { targetChecker: absent })).rejects.toThrow(/latest review .* is automated/);

    // A human acceptance of another body (the stored body changed afterwards).
    const { draftId: d2 } = seedDraft(ctx.db, ctx.siteId);
    acceptDraftAsHuman(ctx, d2);
    ctx.db.run(`UPDATE content_drafts SET package_json = json_set(package_json, '$.body', 'A different synthetic body that nobody accepted.') WHERE id = ?`, [d2]);
    const p2 = resolveProposal(ctx, 'draft', d2);
    expect(p2.humanReview).toMatchObject({ accepted: false, bodyHash: sha256('A different synthetic body that nobody accepted.'), reason: expect.stringMatching(/is for a different body/) });
    await expect(exportSubject(ctx, gate, { subjectType: 'draft', subjectId: d2, actor: 'owner:Alice' }, { targetChecker: absent })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(exportedDirs(ctx)).toEqual([]);
  });

  it('the publisher itself refuses a production-bound draft artifact without an accepted review (defense in depth)', async () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: NOW, mode: 'EXECUTE' });
    const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
    const { draftId, req } = await automatedPassWithApproval(ctx, gate);
    const publisher = manualExportPublisher(ctx);
    const artifact = publisher.prepare(resolveProposal(ctx, 'draft', draftId));
    expect(artifact.artifactHash).toBe(req.artifactHash);
    expect(() => publisher.publishSync({ artifact, approval: gate.get(req.approval.id)!, recheck: null, allowUnverifiedTarget: true, actor: 'owner:Alice' })).toThrow(/Export of draft .* is refused/);
    expect(exportedDirs(ctx)).toEqual([]);
  });

  it('parity: `content publish-check` is ALLOWED exactly when `export draft` does not refuse with human_review_required', async () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: NOW, mode: 'EXECUTE' });
    const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
    const { draftId, req } = await automatedPassWithApproval(ctx, gate);
    // The content side resolves the approvals workflow's binding and checks the real approval service.
    const { deps } = await resolveContentDeps(ctx, { llm: null, memory: null, approvals: gate, vault: null });
    const exportOnce = (dryRun: boolean) => exportSubject(ctx!, gate, { subjectType: 'draft', subjectId: draftId, actor: 'owner:Alice', dryRun }, { targetChecker: absent });

    // Automated pass + valid approval: publish-check is BLOCKED on the missing human acceptance, and so is the export.
    const blocked = checkPublicationGate(ctx, deps, draftId);
    expect(blocked.approval?.ok).toBe(true);
    expect(blocked.allowed).toBe(false);
    expect(blocked.humanReview).toMatchObject({ accepted: false, reason: expect.stringMatching(/is automated/) });
    const prefix = blocked.humanReview.bodyHash.slice(0, 12);
    expect(blocked.blockers).toEqual([expect.stringContaining(`content mark-reviewed ${draftId} --as "<name>" --confirm ${prefix}`)]);
    await expect(exportOnce(true)).rejects.toMatchObject({ code: 'POLICY_DENIED', details: { reason: 'human_review_required' } });

    // After a named human accepts the exact body: ALLOWED, and the export goes through with the same approval.
    const accepted = acceptDraftAsHuman(ctx, draftId, 'Bob');
    const allowed = checkPublicationGate(ctx, deps, draftId);
    expect(allowed.allowed).toBe(true);
    expect(allowed.humanReview).toEqual({ accepted: true, reviewer: 'Bob', reviewId: accepted.reviewId, reviewedAt: NOW, bodyHash: accepted.bodyHash, reason: null });
    const preview = await exportOnce(true);
    expect(preview.status).toBe('dry_run'); // passes every check, writes nothing
    const r = await exportOnce(false);
    expect(r.status).toBe('exported');
    expect(r.artifactHash).toBe(req.artifactHash);

    // A later automated re-review: publish-check and export both refuse again.
    ctx.clock.set('2026-09-20T09:30:00.000Z');
    const { draftId: d2 } = seedDraft(ctx.db, ctx.siteId);
    acceptDraftAsHuman(ctx, d2);
    insertQualityReview(ctx.db, { siteId: ctx.siteId, subjectType: 'draft', subjectId: d2, verdict: 'pass', deterministic: { synthetic: true }, aiReview: null, reasons: [], revisionRound: 0, now: '2026-09-20T09:31:00.000Z' });
    const again = checkPublicationGate(ctx, deps, d2);
    expect(again.humanReview.accepted).toBe(false);
    expect(again.blockers.join(' ')).toMatch(/No recorded human acceptance of this exact body: the latest review .* is automated/);
    await expect(exportSubject(ctx, gate, { subjectType: 'draft', subjectId: d2, actor: 'owner:Alice' }, { targetChecker: absent })).rejects.toMatchObject({ details: { reason: 'human_review_required' } });
  });

  it('only production-bound drafts are gated', () => {
    const hr = { accepted: false, reviewer: null, reviewId: null, reviewedAt: null, bodyHash: 'x', reason: 'synthetic reason' };
    expect(draftHumanReviewBlocker({ subjectType: 'recommendation', productionBound: true, humanReview: null })).toBeNull();
    expect(draftHumanReviewBlocker({ subjectType: 'experiment', productionBound: true })).toBeNull();
    expect(draftHumanReviewBlocker({ subjectType: 'draft', productionBound: false, humanReview: hr })).toBeNull();
    expect(draftHumanReviewBlocker({ subjectType: 'draft', productionBound: true, humanReview: hr })).toBe('synthetic reason');
    expect(draftHumanReviewBlocker({ subjectType: 'draft', productionBound: true })).toMatch(/no human review record/);
    expect(draftHumanReviewBlocker({ subjectType: 'draft', productionBound: true, humanReview: { ...hr, accepted: true, reason: null } })).toBeNull();
  });

  it('a draft recorded live without an export and without human review is recorded, with a visible warning', async () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: NOW, mode: 'EXECUTE' });
    const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
    const { draftId } = await automatedPassWithApproval(ctx, gate);
    ctx.clock.set('2026-09-20T12:00:00.000Z');
    const r = await markImplemented(
      ctx,
      gate,
      { subjectType: 'draft', subjectId: draftId, implementedAt: '2026-09-20T11:00:00Z', revision: 'cms-rev-1', recordedBy: 'Alice', deployedWithoutExport: 'Synthetic: pasted into the CMS directly' },
      { fetcher: async () => ({ ok: false as const, reason: 'offline', detail: 'offline in test' }) },
    );
    expect(r.warnings.join(' ')).toMatch(/went live without the recorded human review that export requires \(the latest review .* is automated/);
  });
});
