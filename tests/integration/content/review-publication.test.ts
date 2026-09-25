import { afterEach, describe, expect, it } from 'vitest';
import { createBrief } from '../../../src/content/brief.js';
import { resolveContentDeps } from '../../../src/content/deps.js';
import { checkPublicationGate, markHumanReviewed, measurePublishedContent } from '../../../src/content/publication.js';
import { draftAndReview, reviewDraft, reviewWithRevisions } from '../../../src/content/review.js';
import { draftNote } from '../../../src/content/notes.js';
import { getDraft, getItem, latestQualityReview, setDraftStatus, updateItem } from '../../../src/content/store.js';
import { resolveProposal } from '../../../src/approvals/subjects.js';
import { assertDraftHumanAccepted, proposalArtifactHash } from '../../../src/approvals/publisher.js';
import { newId } from '../../../src/core/ids.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { FakeApprovalGate, FakeLlm } from '../../fixtures/content/fakes.js';
import { classifyAllInformational, contentConfig, goodDraft, passingReview, researchedSchedulingItem, SITE_URL } from '../../fixtures/content/seed.js';

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

async function approvedBrief(c: TestContext, llm: FakeLlm, approvals: FakeApprovalGate, opts: { synthetic?: boolean } = {}) {
  const deps = { llm, memory: null, approvals, vault: null };
  const itemId = await researchedSchedulingItem(c, deps, opts);
  const b = await createBrief(c, deps, itemId, { useModel: false });
  expect(b.gate.passed).toBe(true);
  approvals.approve(b.approvalRequest!.id);
  return { deps, itemId, brief: b };
}

describe('quality review loop', () => {
  it('stops automated revisions after 2 loops and hands the draft to a human', async () => {
    ctx = createTestContext({ config: contentConfig(), mode: 'DRAFT' });
    const bad = () => goodDraft('\n\n73% of bakeries lose 12 hours a week to scheduling.');
    const llm = new FakeLlm({ 'content.classify': classifyAllInformational, 'content.draft': bad, 'content.review': passingReview });
    const approvals = new FakeApprovalGate();
    const { deps, itemId } = await approvedBrief(ctx, llm, approvals);
    const r = await draftAndReview(ctx, deps, itemId);
    expect(llm.callsFor('content.draft')).toHaveLength(3); // initial + 2 revisions
    expect(r.drafts.map((d) => d.revisionRound)).toEqual([0, 1, 2]);
    expect(r.revisionsUsed).toBe(2);
    expect(r.finalReview.verdict).toBe('needs_human_review');
    expect(r.finalReview.revisionLimitReached).toBe(true);
    expect(r.finalReview.reasons.some((x) => x.code === 'unsupported_numbers')).toBe(true);
    expect(getDraft(ctx.db, ctx.siteId, r.drafts[0]!.id)!.status).toBe('superseded');
    expect(r.finalDraft.status).toBe('needs_human_review');
    // Revision requests carry the code-computed findings as evidence (not as prompt text) and the previous draft.
    const rev = llm.callsFor('content.draft')[1]!;
    expect(rev.evidence.find((e) => e.id === 'quality_findings')?.text).toMatch(/73%/);
    expect(rev.evidence.find((e) => e.id === 'previous_draft')?.trustClass).toBe('model_generated');
    expect(rev.variables.revision_round).toBe(1);
    // No third automated revision is possible.
    await expect(reviewWithRevisions(ctx, deps, r.finalDraft.id, { revise: true })).resolves.toMatchObject({ drafts: [] });
    // Approval was consumed exactly once.
    expect(approvals.records.filter((a) => a.status === 'executed')).toHaveLength(1);
  });

  it('fixes issues through a revision and passes when the AI review finds nothing (still needs human approval to publish)', async () => {
    ctx = createTestContext({ config: contentConfig(), mode: 'DRAFT' });
    const llm = new FakeLlm({
      'content.classify': classifyAllInformational,
      'content.draft': (_req, i) => (i === 0 ? goodDraft('\n\nOur planner integrates with Salesforce.') : goodDraft()),
      'content.review': passingReview,
    });
    const approvals = new FakeApprovalGate();
    const { deps, itemId } = await approvedBrief(ctx, llm, approvals);
    const r = await draftAndReview(ctx, deps, itemId);
    expect(r.reviews[0]!.verdict).toBe('needs_revision');
    expect(r.reviews[0]!.reasons.some((x) => x.code === 'product_fact_consistency')).toBe(true);
    expect(r.finalReview.verdict).toBe('pass');
    expect(r.finalDraft.status).toBe('review_passed');
    expect(getItem(ctx.db, ctx.siteId, itemId)!.stage).toBe('in_review');
    expect(latestQualityReview(ctx.db, ctx.siteId, 'draft', r.finalDraft.id)?.verdict).toBe('pass');
    // Synthetic demo data: never publishable, even after AI + deterministic pass.
    const gate = checkPublicationGate(ctx, deps, r.finalDraft.id);
    expect(gate.allowed).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/synthetic/i);
  });

  it('a made-up statistic whose digits appear in window dates or metrics never passes (non-synthetic scenario)', async () => {
    ctx = createTestContext({ config: contentConfig({ profile: 'core', features: { contentDiscovery: true } }), mode: 'DRAFT' });
    const fake = () => goodDraft('\n\n24% of small bakeries miss their first bake of the day, and most lose 20 minutes each morning.');
    const llm = new FakeLlm({ 'content.classify': classifyAllInformational, 'content.draft': fake, 'content.review': passingReview });
    llm.synthetic = false;
    const approvals = new FakeApprovalGate();
    const { deps, itemId, brief } = await approvedBrief(ctx, llm, approvals, { synthetic: false });
    // The evidence really contains those digits (GSC window dates, metrics), which must not support the statistic.
    expect(JSON.stringify(brief.brief.evidenceSources)).toMatch(/2026-0\d-\d\d/);
    const r = await draftAndReview(ctx, deps, itemId);
    const nums = r.reviews[0]!.checks.find((c) => c.id === 'unsupported_numbers')!;
    expect(nums.status).toBe('fail');
    expect(nums.findings.map((f) => f.detail).join(' ')).toMatch(/"24%"/);
    expect(nums.findings.map((f) => f.detail).join(' ')).toMatch(/"20 minutes"/);
    expect(r.finalReview.verdict).not.toBe('pass');
    expect(r.finalDraft.status).not.toBe('review_passed');
  });

  it('degrades honestly when the AI review is unavailable (human review required)', async () => {
    ctx = createTestContext({ config: contentConfig(), mode: 'DRAFT' });
    const llm = new FakeLlm({ 'content.classify': classifyAllInformational, 'content.draft': () => goodDraft() });
    const approvals = new FakeApprovalGate();
    const { deps, itemId } = await approvedBrief(ctx, llm, approvals);
    const r = await draftAndReview(ctx, deps, itemId);
    expect(r.finalReview.aiReview.status).toBe('unavailable');
    expect(r.finalReview.verdict).toBe('needs_human_review');
    expect(r.finalReview.aiReview.disclaimer).toMatch(/not a guarantee/);
  });
});

describe('human publication gate', () => {
  it('never lets a quality pass or AI score authorize publication; checks the approvals workflow binding (canonical change hash) and EXECUTE mode', async () => {
    // Non-synthetic rows in a temp test DB exercise the real (non-demo) path.
    ctx = createTestContext({ config: contentConfig({ profile: 'core', features: { contentDiscovery: true } }), mode: 'EXECUTE' });
    const llm = new FakeLlm({ 'content.classify': classifyAllInformational, 'content.draft': () => goodDraft(), 'content.review': passingReview });
    llm.synthetic = false;
    const approvals = new FakeApprovalGate();
    const { deps: base, itemId } = await approvedBrief(ctx, llm, approvals, { synthetic: false });
    const r = await draftAndReview(ctx, base, itemId);
    expect(r.finalReview.verdict).toBe('pass');
    expect(r.finalDraft.pkg.isSynthetic).toBe(false);

    // Without the approvals proposal resolver the binding is reported unavailable (never a guessed hash).
    const unwired = checkPublicationGate(ctx, base, r.finalDraft.id);
    expect(unwired.allowed).toBe(false);
    expect(unwired.binding).toBeNull();
    expect(unwired.blockers.join(' ')).toMatch(/binding unavailable/);

    // Conventional wiring resolves the approvals workflow's proposal (same hash `approvals request draft` binds).
    const { deps } = await resolveContentDeps(ctx, { llm, memory: null, approvals, vault: null });
    expect(deps.proposals).toBeTruthy();
    const expected = proposalArtifactHash(resolveProposal(ctx, 'draft', r.finalDraft.id));
    const id = r.finalDraft.id;
    const prefix = r.finalDraft.bodyHash.slice(0, 12);
    const humanBlocker = new RegExp(`No recorded human acceptance of this exact body: the latest review \\(qrv_\\w+, verdict pass\\) is automated.*\`export draft\` refuses.*\`content mark-reviewed ${id} --as "<name>" --confirm ${prefix}\``);
    const before = checkPublicationGate(ctx, deps, id);
    expect(before.allowed).toBe(false);
    expect(before.binding).toMatchObject({ subjectType: 'draft', actionType: 'update_page', artifactHash: expected });
    expect(before.binding!.artifactHash).not.toBe(r.finalDraft.bodyHash);
    expect(before.humanReview).toMatchObject({ accepted: false, reviewer: null, bodyHash: r.finalDraft.bodyHash });
    expect(before.blockers).toEqual([expect.stringMatching(humanBlocker), expect.stringMatching(/No valid update_page approval.*\(none\).*approvals request draft/)]);
    // The content gate never creates publication approvals (no competing request that could invalidate the owner's).
    expect(approvals.records.filter((a) => a.actionType === 'update_page' || a.actionType === 'publish_content')).toHaveLength(0);

    // An approval bound to the body hash alone does not count.
    approvals.grant({ siteId: ctx.siteId, actionType: 'update_page', subjectType: 'draft', subjectId: r.finalDraft.id, artifactHash: r.finalDraft.bodyHash });
    expect(checkPublicationGate(ctx, deps, r.finalDraft.id).blockers.join(' ')).toMatch(/hash_mismatch/);

    // The approval the approvals workflow creates (bound to the canonical change hash) is recognised...
    approvals.grant({ siteId: ctx.siteId, actionType: 'update_page', subjectType: 'draft', subjectId: id, artifactHash: expected });
    // ...but an automated pass plus a valid approval is still BLOCKED: nobody accepted this exact body (NF-02).
    const automatedOnly = checkPublicationGate(ctx, deps, id);
    expect(automatedOnly.approval?.ok).toBe(true);
    expect(automatedOnly.allowed).toBe(false);
    expect(automatedOnly.blockers).toEqual([expect.stringMatching(humanBlocker)]);
    // The same verdict `export draft` reaches on the resolved proposal (assertDraftHumanAccepted).
    expect(() => assertDraftHumanAccepted(resolveProposal(ctx, 'draft', id))).toThrow(expect.objectContaining({ code: 'POLICY_DENIED', details: expect.objectContaining({ reason: 'human_review_required' }) }));

    // A named human accepts the exact body: now allowed, and the result names who accepted it and when.
    const accepted = markHumanReviewed(ctx, id, { reviewer: 'Alice', confirmHashPrefix: prefix });
    const after = checkPublicationGate(ctx, deps, id);
    expect(after.allowed).toBe(true);
    expect(after.blockers).toEqual([]);
    expect(after.humanReview).toEqual({ accepted: true, reviewer: 'Alice', reviewId: accepted.reviewId, reviewedAt: ctx.clock.now().toISOString(), bodyHash: r.finalDraft.bodyHash, reason: null });
    expect(after.note).toMatch(/never authorize/);
    expect(() => assertDraftHumanAccepted(resolveProposal(ctx, 'draft', id))).not.toThrow();

    // Changing the draft body invalidates the binding.
    ctx.db.run('UPDATE content_drafts SET body_hash = ? WHERE id = ?', ['0'.repeat(64), r.finalDraft.id]);
    expect(checkPublicationGate(ctx, deps, r.finalDraft.id).allowed).toBe(false);
  });

  it('blocks publication while unresolved facts remain, even with an approval, and outside EXECUTE mode', async () => {
    ctx = createTestContext({ config: contentConfig({ profile: 'core', features: { contentDiscovery: true } }), mode: 'DRAFT' });
    const withUnverified = () => ({ ...goodDraft(), factCheckNotes: [{ statement: 'The planner exports production schedules to CSV.', status: 'verified', evidenceIds: [], note: '' }, { statement: 'Most bakeries start baking at 4am.', status: 'needs_owner_input', evidenceIds: [], note: 'owner to confirm' }] });
    const llm = new FakeLlm({ 'content.classify': classifyAllInformational, 'content.draft': withUnverified, 'content.review': passingReview });
    llm.synthetic = false;
    const approvals = new FakeApprovalGate();
    const { deps, itemId } = await approvedBrief(ctx, llm, approvals, { synthetic: false });
    const r = await draftAndReview(ctx, deps, itemId);
    // The "verified" note cites no evidence: the model's word is not evidence, so it is downgraded and marked too (B2-01).
    expect(r.finalDraft.unresolvedFacts).toBe(2);
    expect(r.finalDraft.pkg.body).toContain('[[UNVERIFIED: Most bakeries start baking at 4am.]]');
    expect(r.finalDraft.pkg.body).toContain('[[UNVERIFIED: The planner exports production schedules to CSV.]]');
    expect(r.finalDraft.pkg.factCheckNotes[0]).toMatchObject({ status: 'unverified', downgraded: { from: 'verified' } });
    expect(r.finalReview.verdict).toBe('needs_human_review');
    approvals.grant({ siteId: ctx.siteId, actionType: 'update_page', subjectType: 'draft', subjectId: r.finalDraft.id, artifactHash: r.finalDraft.bodyHash });
    const gate = checkPublicationGate(ctx, deps, r.finalDraft.id);
    expect(gate.allowed).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/unresolved fact/);
    expect(gate.blockers.join(' ')).toMatch(/EXECUTE/);
  });

  it('a "verified" fact-check note with invented or empty evidence gets an UNVERIFIED marker and blocks publication (B2-01 regression)', async () => {
    ctx = createTestContext({ config: contentConfig({ profile: 'core', features: { contentDiscovery: true } }), mode: 'EXECUTE' });
    const regulation = 'Food safety law requires bakeries to keep a daily fridge temperature log.';
    const industry = 'Most bakery owners plan production two weeks ahead.';
    const selfCertified = () => ({
      ...goodDraft(`\n\n${regulation} ${industry}`),
      factCheckNotes: [
        { statement: regulation, status: 'verified', evidenceIds: ['fsa-guidance-2024'], note: 'well known' }, // invented id
        { statement: industry, status: 'verified', evidenceIds: [], note: '' }, // no evidence at all
        { statement: 'The planner exports production schedules to CSV.', status: 'verified', evidenceIds: ['pf-export'], note: '' }, // a real product fact states it
      ],
    });
    const llm = new FakeLlm({ 'content.classify': classifyAllInformational, 'content.draft': selfCertified, 'content.review': passingReview });
    llm.synthetic = false;
    const approvals = new FakeApprovalGate();
    const { deps: base, itemId } = await approvedBrief(ctx, llm, approvals, { synthetic: false });
    const r = await draftAndReview(ctx, base, itemId);
    const d = r.finalDraft;
    expect(d.pkg.body).toContain(`[[UNVERIFIED: ${regulation}]]`);
    expect(d.pkg.body).toContain(`[[UNVERIFIED: ${industry}]]`);
    expect(d.pkg.body).not.toContain('[[UNVERIFIED: The planner exports');
    expect(d.unresolvedFacts).toBe(2);
    expect(d.pkg.factCheckNotes.map((n) => n.status)).toEqual(['unverified', 'unverified', 'verified']);
    expect(d.pkg.factCheckNotes[0]!.evidenceIds).toEqual([]); // the invented id is not kept
    expect(d.pkg.factCheckNotes[2]!.evidenceIds).toEqual(['fact:pf-export']);
    expect(r.finalReview.verdict).toBe('needs_human_review');
    expect(r.finalReview.reasons.some((x) => x.code === 'unresolved_facts')).toBe(true);
    // The vault note never shows the model's claim as a bare **verified**.
    const note = draftNote(getItem(ctx.db, ctx.siteId, itemId)!, d, r.finalReview).body;
    expect(note).not.toMatch(/\*\*verified\*\*/);
    expect(note).toMatch(/model-claimed verified \(evidence: fact:pf-export\)/);
    expect(note).toMatch(/\*\*unverified\*\* \(the model claimed verified;/);
    // Blocked: a human cannot accept it, and the publication gate lists the unresolved facts even with an approval.
    expect(() => markHumanReviewed(ctx, d.id, { reviewer: 'Alice', confirmHashPrefix: d.bodyHash.slice(0, 8) })).toThrow(/unresolved fact/);
    const { deps } = await resolveContentDeps(ctx, { llm, memory: null, approvals, vault: null });
    approvals.grant({ siteId: ctx.siteId, actionType: 'update_page', subjectType: 'draft', subjectId: d.id, artifactHash: d.bodyHash });
    const gate = checkPublicationGate(ctx, deps, d.id);
    expect(gate.allowed).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/2 unresolved fact\(s\).*content revise-manual/);
    // The audit event records the downgrade.
    const created = ctx.db.get<{ details_json: string }>(`SELECT details_json FROM audit_events WHERE event_type = 'content.draft_created' AND subject_id = ?`, [r.drafts[0]!.id]);
    expect(JSON.parse(created!.details_json)).toMatchObject({ verifiedClaimsDowngraded: 2 });
  });

  it('lets a named human accept a needs_human_review draft only for the exact body and only without blocking findings', async () => {
    ctx = createTestContext({ config: contentConfig({ profile: 'core', features: { contentDiscovery: true } }), mode: 'DRAFT' });
    const llm = new FakeLlm({ 'content.classify': classifyAllInformational, 'content.draft': () => goodDraft() }); // no AI review -> needs_human_review
    llm.synthetic = false;
    const approvals = new FakeApprovalGate();
    const { deps, itemId } = await approvedBrief(ctx, llm, approvals, { synthetic: false });
    const r = await draftAndReview(ctx, deps, itemId);
    expect(r.finalReview.verdict).toBe('needs_human_review');
    expect(checkPublicationGate(ctx, deps, r.finalDraft.id).blockers.join(' ')).toMatch(/awaits human review/);
    expect(() => markHumanReviewed(ctx, r.finalDraft.id, { reviewer: 'Alice', confirmHashPrefix: '00000000' })).toThrow(/Confirm the exact body/);
    expect(() => markHumanReviewed(ctx, r.finalDraft.id, { reviewer: ' ', confirmHashPrefix: r.finalDraft.bodyHash.slice(0, 8) })).toThrow(/named reviewer/);
    const ok = markHumanReviewed(ctx, r.finalDraft.id, { reviewer: 'Alice', confirmHashPrefix: r.finalDraft.bodyHash.slice(0, 10) });
    expect(ok.status).toBe('review_passed');
    expect(getDraft(ctx.db, ctx.siteId, r.finalDraft.id)!.status).toBe('review_passed');
    const audit = ctx.db.get<{ actor: string }>(`SELECT actor FROM audit_events WHERE event_type = 'content.human_review'`);
    expect(audit?.actor).toBe('owner:Alice');
    // Still not publishable without the approval and EXECUTE mode; the human-acceptance blocker is gone.
    const gate = checkPublicationGate(ctx, deps, r.finalDraft.id);
    expect(gate.allowed).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/approval/);
    expect(gate.blockers.join(' ')).not.toMatch(/awaits human review|No recorded human acceptance/);
    expect(gate.humanReview).toMatchObject({ accepted: true, reviewer: 'Alice', reviewId: ok.reviewId });
  });

  it('refuses human acceptance while revise-level findings or unresolved facts remain', async () => {
    ctx = createTestContext({ config: contentConfig(), mode: 'DRAFT' });
    const llm = new FakeLlm({ 'content.classify': classifyAllInformational, 'content.draft': () => goodDraft('\n\n73% of bakeries lose 12 hours a week.'), 'content.review': passingReview });
    const approvals = new FakeApprovalGate();
    const { deps, itemId } = await approvedBrief(ctx, llm, approvals);
    const r = await draftAndReview(ctx, deps, itemId);
    expect(r.finalReview.verdict).toBe('needs_human_review'); // revision limit reached
    expect(() => markHumanReviewed(ctx, r.finalDraft.id, { reviewer: 'Alice', confirmHashPrefix: r.finalDraft.bodyHash.slice(0, 8) })).toThrow(/require revision or rejection/);
  });

  it('moves recorded publications to measuring with observational metrics (missing is not zero)', async () => {
    ctx = createTestContext({ config: contentConfig(), mode: 'DRAFT' });
    const llm = new FakeLlm({ 'content.classify': classifyAllInformational, 'content.draft': () => goodDraft(), 'content.review': passingReview });
    const approvals = new FakeApprovalGate();
    const { deps, itemId } = await approvedBrief(ctx, llm, approvals);
    const r = await draftAndReview(ctx, deps, itemId);
    ctx.db.run(
      `INSERT INTO publications (id, site_id, subject_type, subject_id, url, method, implemented_at, recorded_by, created_at) VALUES (?, ?, 'draft', ?, ?, 'manual_export', '2026-09-21T10:00:00Z', 'owner:test', ?)`,
      [newId('pub'), ctx.siteId, r.finalDraft.id, `${SITE_URL}new-page/`, ctx.clock.now().toISOString()],
    );
    const m = measurePublishedContent(ctx);
    expect(m).toHaveLength(1);
    // No Search Console property is configured and no page/property rows exist: DATA_UNAVAILABLE, never 0 and never a sum.
    expect(m[0]!.clicks.status).toBe('unavailable');
    expect(m[0]!.clicks.status !== 'observed' && m[0]!.clicks.reason).toMatch(/property not resolved/);
    expect(m[0]!.note).toMatch(/not proof of causality/);
    expect(getItem(ctx.db, ctx.siteId, itemId)!.stage).toBe('measuring');
  });

  it('never re-reviews superseded, published, or rejected drafts (no status or stage regression); --dry-run previews only', async () => {
    ctx = createTestContext({ config: contentConfig(), mode: 'DRAFT' });
    const llm = new FakeLlm({
      'content.classify': classifyAllInformational,
      'content.draft': (_req, i) => (i === 0 ? goodDraft('\n\nOur planner integrates with Salesforce.') : goodDraft()),
      'content.review': passingReview,
    });
    const approvals = new FakeApprovalGate();
    const { deps, itemId } = await approvedBrief(ctx, llm, approvals);
    const r = await draftAndReview(ctx, deps, itemId);
    const [first, final] = [r.drafts[0]!, r.finalDraft];
    expect(getDraft(ctx.db, ctx.siteId, first.id)!.status).toBe('superseded');
    // Superseded draft: refused, state unchanged.
    await expect(reviewDraft(ctx, deps, first.id, { useModel: true })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(getDraft(ctx.db, ctx.siteId, first.id)!.status).toBe('superseded');
    expect(getItem(ctx.db, ctx.siteId, itemId)!.stage).toBe('in_review');
    // Preview is allowed and changes nothing.
    const preview = await reviewDraft(ctx, deps, first.id, { preview: true });
    expect(preview.reviewId).toBeNull();
    expect(getDraft(ctx.db, ctx.siteId, first.id)!.status).toBe('superseded');
    // Published draft + measuring item: refused, nothing moves backward.
    setDraftStatus(ctx.db, ctx.siteId, final.id, 'published');
    updateItem(ctx.db, ctx.siteId, itemId, { stage: 'measuring' }, ctx.clock.now().toISOString());
    await expect(reviewDraft(ctx, deps, final.id, { useModel: true })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(reviewDraft(ctx, deps, first.id, { useModel: true })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(getDraft(ctx.db, ctx.siteId, final.id)!.status).toBe('published');
    expect(getItem(ctx.db, ctx.siteId, itemId)!.stage).toBe('measuring');
    // Rejected is sticky.
    setDraftStatus(ctx.db, ctx.siteId, final.id, 'rejected');
    updateItem(ctx.db, ctx.siteId, itemId, { stage: 'rejected' }, ctx.clock.now().toISOString());
    await expect(reviewDraft(ctx, deps, final.id, { useModel: true })).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/final/) });
    await expect(reviewWithRevisions(ctx, deps, final.id, { revise: true })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(getDraft(ctx.db, ctx.siteId, final.id)!.status).toBe('rejected');
  });

  it('review of a draft in dry-run persists nothing', async () => {
    ctx = createTestContext({ config: contentConfig(), mode: 'DRAFT' });
    const llm = new FakeLlm({ 'content.classify': classifyAllInformational, 'content.draft': () => goodDraft(), 'content.review': passingReview });
    const approvals = new FakeApprovalGate();
    const { deps, itemId } = await approvedBrief(ctx, llm, approvals);
    const r = await draftAndReview(ctx, deps, itemId);
    const count = () => Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM quality_reviews WHERE subject_id = ?', [r.finalDraft.id])!.n);
    const n = count();
    ctx.dryRun = true;
    const preview = await reviewDraft(ctx, deps, r.finalDraft.id);
    expect(preview.reviewId).toBeNull();
    expect(preview.aiReview.status).toBe('skipped');
    expect(count()).toBe(n);
  });
});
