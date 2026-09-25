import { afterEach, describe, expect, it } from 'vitest';
import { createBrief, briefHash } from '../../../src/content/brief.js';
import { checkDraftPreconditions, DraftRefusedError, generateDraft } from '../../../src/content/draft.js';
import { getItem, latestBrief, latestDraft, updateItem } from '../../../src/content/store.js';
import type { ContentDeps } from '../../../src/content/deps.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { FakeApprovalGate, FakeLlm } from '../../fixtures/content/fakes.js';
import { briefSynthesis, classifyAllInformational, contentConfig, goodDraft, passingReview, researchedSchedulingItem, seedRedditSignal } from '../../fixtures/content/seed.js';

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

function makeDeps(): { deps: ContentDeps; llm: FakeLlm; approvals: FakeApprovalGate } {
  const llm = new FakeLlm({ 'content.classify': classifyAllInformational, 'content.brief': briefSynthesis, 'content.draft': () => goodDraft(), 'content.review': passingReview });
  const approvals = new FakeApprovalGate();
  return { deps: { llm, memory: null, approvals, vault: null }, llm, approvals };
}

async function refusal(p: Promise<unknown>): Promise<DraftRefusedError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DraftRefusedError) return e;
    throw e;
  }
  throw new Error('expected a DraftRefusedError');
}

describe('brief gate', () => {
  it('passes a deterministic brief with all required fields and evidence, and requests a draft approval bound to its hash', async () => {
    ctx = createTestContext({ config: contentConfig() });
    const { deps, approvals } = makeDeps();
    const itemId = await researchedSchedulingItem(ctx, deps);
    const r = await createBrief(ctx, deps, itemId, { useModel: false });
    expect(r.gate.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(r.gate.passed).toBe(true);
    const b = r.brief;
    for (const f of ['audience', 'primaryQuestion', 'businessPurpose', 'uniqueContribution'] as const) expect(b[f].length).toBeGreaterThan(3);
    expect(b.queryCluster.queries.length).toBeGreaterThan(1);
    expect(b.intent).toBe('informational');
    expect(b.proposedUrl ?? b.targetPageUrl).toBeTruthy();
    expect(b.existingPageOverlap.pages.length).toBeGreaterThan(0);
    expect(b.researchFindings.every((f) => f.evidenceIds.length > 0)).toBe(true);
    // Owner-provided topics (config seed topics) are never presented as customer questions.
    const origins = new Map(b.evidenceSources.map((e) => [e.id, e.origin]));
    const customer = b.researchFindings.find((f) => /Customers raise this question/.test(f.finding));
    for (const id of customer?.evidenceIds ?? []) expect(['manual', 'apify_reddit']).toContain(origins.get(id));
    const owner = b.researchFindings.find((f) => /owner lists this as a business topic/i.test(f.finding));
    expect(owner).toBeDefined();
    expect(owner!.finding).toMatch(/not a customer question/);
    for (const id of owner!.evidenceIds) expect(origins.get(id)).toBe('business_knowledge');
    expect(b.evidenceSources.some((e) => e.id.startsWith('fact:'))).toBe(true);
    expect(b.evidenceSources.some((e) => e.isSandbox)).toBe(false);
    expect(JSON.stringify(b)).not.toContain('9999');
    expect(b.outline.length).toBeGreaterThanOrEqual(2);
    expect(b.usefulExamples.length).toBeGreaterThan(0);
    expect(b.cta.targetUrl).toBe('https://www.example.test/');
    expect(Array.isArray(b.unresolvedQuestions)).toBe(true);
    expect(r.record?.status).toBe('gate_passed');
    expect(r.contentHash).toBe(briefHash(b));
    expect(r.approvalRequest?.actionType).toBe('draft_generation');
    expect(r.approvalRequest?.artifactHash).toBe(r.contentHash);
    expect(approvals.records).toHaveLength(1);
    // provenance rows
    const claims = ctx.db.all('SELECT * FROM claim_evidence WHERE site_id = ? AND subject_id = ?', [ctx.siteId, r.record!.id]);
    expect(claims.length).toBeGreaterThan(0);
  });

  it('fails the gate for fabricated numbers, unsupported product claims, and word-count targets in model synthesis', async () => {
    ctx = createTestContext({ config: contentConfig() });
    const { deps, llm } = makeDeps();
    const itemId = await researchedSchedulingItem(ctx, deps);
    (llm as unknown as { handlers: Record<string, unknown> }).handlers['content.brief'] = (req: Parameters<typeof briefSynthesis>[0]) => {
      const base = briefSynthesis(req);
      return {
        ...base,
        researchFindings: [{ finding: '73% of bakeries lose 12 hours a week to scheduling.', evidenceIds: [req.evidence[0]!.id], label: 'OBSERVED' }],
        uniqueContribution: 'Our planner integrates with every POS system. Write a 2,000-word guide.',
      };
    };
    const r = await createBrief(ctx, deps, itemId, { useModel: true });
    const codes = r.gate.issues.filter((i) => i.severity === 'error').map((i) => i.code);
    expect(r.gate.passed).toBe(false);
    expect(codes).toEqual(expect.arrayContaining(['unsupported_number', 'unsupported_product_claim', 'word_count_target']));
    expect(r.record?.status).toBe('gate_failed');
    expect(r.approvalRequest).toBeNull();
  });

  it('accepts signals written by the Apify adapter (run-metadata collection windows) as valid brief evidence', async () => {
    ctx = createTestContext({ config: contentConfig() });
    const { deps } = makeDeps();
    // Same shape the Apify slice persists: run metadata instead of start/end/description.
    seedRedditSignal(ctx, { text: 'How to schedule bakery production?', url: 'https://www.reddit.invalid/r/Baking/comments/w1', window: { actorId: '9sHOY9RzPYGjmTHo8', build: '0.0.513', remoteRunId: 'run_synthetic', runStartedAt: '2026-09-20T08:00:00Z', runFinishedAt: '2026-09-20T08:05:00Z', searchTime: 'month', postedAfter: null, postedBefore: null, searchTerm: 'bakery schedule', community: 'r/Baking' } });
    const itemId = await researchedSchedulingItem(ctx, deps);
    const signalsInItem = ctx.db.all<{ origin: string }>('SELECT origin FROM content_signals WHERE content_item_id = ?', [itemId]);
    expect(signalsInItem.some((s) => s.origin === 'apify_reddit')).toBe(true);
    const r = await createBrief(ctx, deps, itemId, { useModel: false });
    expect(r.gate.issues.filter((i) => i.code === 'schema')).toEqual([]);
    expect(r.gate.passed).toBe(true);
    const ev = r.brief.evidenceSources.find((e) => e.origin === 'apify_reddit')!;
    expect(ev.window?.end).toBe('2026-09-20');
    expect(ev.window?.description).toMatch(/searchTime=month/);
    expect(ev.window?.details?.remoteRunId).toBe('run_synthetic');
  });

  it('refuses to brief deferred/rejected items and keeps the reason', async () => {
    ctx = createTestContext({ config: contentConfig() });
    const { deps } = makeDeps();
    const itemId = await researchedSchedulingItem(ctx, deps);
    updateItem(ctx.db, ctx.siteId, itemId, { decision: 'defer', decisionReason: 'test: weak demand', stage: 'deferred' }, ctx.clock.now().toISOString());
    await expect(createBrief(ctx, deps, itemId)).rejects.toMatchObject({ code: 'POLICY_DENIED', hint: 'test: weak demand' });
  });

  it('fails when the existing-content check was impossible', async () => {
    ctx = createTestContext({ config: contentConfig() });
    const { deps } = makeDeps();
    const itemId = await researchedSchedulingItem(ctx, deps);
    const item = getItem(ctx.db, ctx.siteId, itemId)!;
    updateItem(ctx.db, ctx.siteId, itemId, { decision: 'create_page', overlap: { ...item.overlap!, status: 'unavailable', pages: [] } }, ctx.clock.now().toISOString());
    const r = await createBrief(ctx, deps, itemId, { useModel: false });
    expect(r.gate.issues.map((i) => i.code)).toContain('existing_check_missing');
    expect(r.gate.passed).toBe(false);
  });
});

describe('draft preconditions', () => {
  it('refuses in ANALYZE mode even with a valid approval (and makes no model call)', async () => {
    ctx = createTestContext({ config: contentConfig() }); // default mode ANALYZE
    const { deps, llm, approvals } = makeDeps();
    const itemId = await researchedSchedulingItem(ctx, deps);
    const b = await createBrief(ctx, deps, itemId, { useModel: false });
    approvals.approve(b.approvalRequest!.id);
    const err = await refusal(generateDraft(ctx, deps, itemId));
    expect(err.code).toBe('POLICY_DENIED');
    expect(err.preconditions.checks.find((c) => c.id === 'mode')?.ok).toBe(false);
    expect(llm.callsFor('content.draft')).toHaveLength(0);
    expect(latestDraft(ctx.db, ctx.siteId, itemId)).toBeNull();
  });

  it('refuses without an approval, creates a pending request bound to the brief hash, then drafts once approved (one-time)', async () => {
    ctx = createTestContext({ config: contentConfig(), mode: 'DRAFT' });
    const { deps, llm, approvals } = makeDeps();
    const itemId = await researchedSchedulingItem(ctx, deps);
    const b = await createBrief(ctx, deps, itemId, { useModel: false, requestApproval: false });
    expect(approvals.records).toHaveLength(0);

    const err = await refusal(generateDraft(ctx, deps, itemId));
    expect(err.code).toBe('APPROVAL_REQUIRED');
    expect(err.approvalRequest?.status).toBe('pending');
    expect(err.approvalRequest?.artifactHash).toBe(b.contentHash);
    expect(llm.callsFor('content.draft')).toHaveLength(0);

    // Pending is still refused.
    expect((await refusal(generateDraft(ctx, deps, itemId))).preconditions.checks.find((c) => c.id === 'approval')?.detail).toMatch(/pending/);

    approvals.approve(err.approvalRequest!.id);
    const r = await generateDraft(ctx, deps, itemId);
    expect(r.draft.briefId).toBe(b.record!.id);
    expect(r.draft.briefHash).toBe(b.contentHash);
    expect(r.draft.briefVersion).toBe(b.record!.version);
    expect(r.draft.pkg.titleOptions.length).toBeGreaterThan(0);
    expect(r.draft.pkg.metaDescription).toBeTruthy();
    expect(r.draft.pkg.slugSuggestion).toMatch(/^[a-z0-9-]+$/);
    expect(r.draft.pkg.sourceLedger.length).toBeGreaterThan(0);
    expect(r.draft.pkg.publicationBlockers.join(' ')).toMatch(/publish_content approval/);
    expect(r.approvalConsumed?.status).toBe('executed');
    expect(getItem(ctx.db, ctx.siteId, itemId)!.stage).toBe('drafted');

    // One-time: the consumed approval cannot generate another draft.
    const again = await refusal(generateDraft(ctx, deps, itemId));
    expect(again.preconditions.checks.find((c) => c.id === 'approval')?.detail).toMatch(/already used/);
  });

  it('refuses when the brief gate did not pass', async () => {
    ctx = createTestContext({ config: contentConfig(), mode: 'DRAFT' });
    const { deps, approvals } = makeDeps();
    const itemId = await researchedSchedulingItem(ctx, deps);
    const item = getItem(ctx.db, ctx.siteId, itemId)!;
    updateItem(ctx.db, ctx.siteId, itemId, { decision: 'create_page', overlap: { ...item.overlap!, status: 'unavailable', pages: [] } }, ctx.clock.now().toISOString());
    const b = await createBrief(ctx, deps, itemId, { useModel: false });
    expect(b.gate.passed).toBe(false);
    approvals.grant({ siteId: ctx.siteId, actionType: 'draft_generation', subjectType: 'content_brief', subjectId: b.record!.id, artifactHash: b.contentHash });
    const err = await refusal(generateDraft(ctx, deps, itemId));
    expect(err.preconditions.checks.find((c) => c.id === 'brief_gate')?.ok).toBe(false);
  });

  it('invalidates the approval when the brief changes (hash mismatch) or is tampered with', async () => {
    ctx = createTestContext({ config: contentConfig(), mode: 'DRAFT' });
    const { deps, approvals } = makeDeps();
    const itemId = await researchedSchedulingItem(ctx, deps);
    const b1 = await createBrief(ctx, deps, itemId, { useModel: false });
    approvals.approve(b1.approvalRequest!.id);
    // Tamper with the stored brief: integrity check fails.
    const tampered = { ...b1.brief, uniqueContribution: `${b1.brief.uniqueContribution} (edited)` };
    ctx.db.run('UPDATE content_briefs SET brief_json = ? WHERE id = ?', [JSON.stringify(tampered), b1.record!.id]);
    const err1 = await refusal(generateDraft(ctx, deps, itemId));
    expect(err1.preconditions.checks.find((c) => c.id === 'brief_integrity')?.ok).toBe(false);
    // A new brief version (with a model synthesis) has a different hash: the old approval does not cover it.
    const b2 = await createBrief(ctx, deps, itemId, { useModel: true, requestApproval: false });
    expect(b2.contentHash).not.toBe(b1.contentHash);
    const err2 = await refusal(generateDraft(ctx, deps, itemId));
    expect(err2.preconditions.approval && !err2.preconditions.approval.ok && err2.preconditions.approval.reason).toBe('none');
    expect(latestBrief(ctx.db, ctx.siteId, itemId)!.id).toBe(b2.record!.id);
  });

  it('enforces one approved content item in production at a time', async () => {
    ctx = createTestContext({ config: contentConfig(), mode: 'DRAFT' });
    const { deps, approvals } = makeDeps();
    const itemId = await researchedSchedulingItem(ctx, deps);
    const b = await createBrief(ctx, deps, itemId, { useModel: false });
    approvals.approve(b.approvalRequest!.id);
    // Another item is already in production.
    const other = ctx.db.get<{ id: string }>('SELECT id FROM content_items WHERE site_id = ? AND id != ? LIMIT 1', [ctx.siteId, itemId]);
    const otherId = other?.id ?? (await import('../../../src/content/store.js')).insertItem(ctx.db, { siteId: ctx.siteId, title: 'Other item', primaryQuestion: null, stage: 'drafted', intent: 'informational', clusterId: null, isSynthetic: true, now: ctx.clock.now().toISOString() });
    updateItem(ctx.db, ctx.siteId, otherId, { stage: 'in_review' }, ctx.clock.now().toISOString());
    const pre = checkDraftPreconditions(ctx, deps, itemId);
    expect(pre.checks.find((c) => c.id === 'capacity')?.ok).toBe(false);
    const err = await refusal(generateDraft(ctx, deps, itemId));
    expect(err.code).toBe('POLICY_DENIED');
    expect(err.message).toMatch(/production/);
  });

  it('refuses without a configured model or approval service (honest statuses)', async () => {
    ctx = createTestContext({ config: contentConfig(), mode: 'DRAFT' });
    const { deps } = makeDeps();
    const itemId = await researchedSchedulingItem(ctx, deps);
    await createBrief(ctx, deps, itemId, { useModel: false });
    const pre = checkDraftPreconditions(ctx, { llm: new FakeLlm({}, { reasoning: false }), memory: null, approvals: null, vault: null }, itemId);
    expect(pre.checks.find((c) => c.id === 'approval')?.detail).toMatch(/not wired/);
    expect(pre.checks.find((c) => c.id === 'model')?.detail).toMatch(/REASONING_MODEL/);
    expect(pre.ok).toBe(false);
  });
});
