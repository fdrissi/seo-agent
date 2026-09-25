import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runBatchDrafts, batchIdentity, expansionIdentity } from '../../../src/content/batch.js';
import { DraftRefusedError, generateDraft } from '../../../src/content/draft.js';
import { markHumanReviewed } from '../../../src/content/publication.js';
import { reviewDraft, reviewSiblings } from '../../../src/content/review.js';
import { NO_CONVERSION_HISTORY_STATEMENT, runLowDataBootstrap } from '../../../src/content/bootstrap.js';
import { createBrief } from '../../../src/content/brief.js';
import { computeDemand } from '../../../src/content/demand.js';
import { importManualQuestions } from '../../../src/content/import.js';
import { runContentResearch } from '../../../src/content/pipeline.js';
import { assignSignals, getDraft, getItem, insertBrief, insertDraft, insertItem, latestBrief, latestDraft, setDraftStatus, updateItem, upsertSignal } from '../../../src/content/store.js';
import type { DraftPackage } from '../../../src/content/types.js';
import type { StructuredRequest, StructuredResult } from '../../../src/integrations/llm/types.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { FakeApprovalGate, FakeLlm } from '../../fixtures/content/fakes.js';
import { classifyAllInformational, contentConfig, passingReview, seedPages, seedPropertyImpressions, SITE_URL } from '../../fixtures/content/seed.js';

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

describe('low-data bootstrap', () => {
  it('produces an offer-page brief, one supporting-page brief, and readiness checks without assuming conversion history', async () => {
    ctx = createTestContext({ config: contentConfig() });
    seedPages(ctx, [
      { path: '/', pageType: 'offer', title: 'Crumb Planner: production and shift planning for bakeries', headings: ['Plan production', 'Schedule shifts'], text: 'Crumb Planner helps small bakeries plan production.' },
      { path: '/pricing/', pageType: 'other', title: 'Pricing', headings: [], text: 'Plans.' },
    ]);
    const csv = path.join(ctx.paths.root, 'questions.csv');
    writeFileSync(csv, 'question\n"How do I plan bakery shifts with reusable templates?"\n');
    importManualQuestions(ctx, csv);
    const deps = { llm: new FakeLlm({ 'content.classify': classifyAllInformational }), memory: null, approvals: new FakeApprovalGate(), vault: null };
    await runContentResearch(ctx, deps, {});

    const r = await runLowDataBootstrap(ctx, deps, { useModel: false });
    expect(r.lowData.isLowData).toBe(true);
    expect(r.lowData.reason).toMatch(/No Search Console/);
    expect(r.conversionHistory).toBe(NO_CONVERSION_HISTORY_STATEMENT);
    const byId = Object.fromEntries(r.readiness.map((c) => [c.id, c]));
    expect(byId.gsc_property!.status).toBe('fail');
    expect(byId.gsc_property!.nextStep).toMatch(/auth/);
    expect(byId.primary_conversion!.status).toBe('pass');
    expect(byId.conversion_data!.status).toBe('unknown');
    expect(byId.conversion_data!.detail).toMatch(/none is assumed/);
    expect(byId.crawl!.status).toBe('pass');
    expect(byId.offer_page!.status).toBe('pass');
    expect(byId.offer_indexability!.status).toBe('pass');

    // Offer-page brief
    expect(r.offerPage).not.toBeNull();
    const offerItem = getItem(ctx.db, ctx.siteId, r.offerPage!.itemId)!;
    expect(offerItem.decision).toBe('improve_existing');
    expect(offerItem.whyExists).toMatch(/No historical conversion evidence/);
    const offerBrief = latestBrief(ctx.db, ctx.siteId, offerItem.id)!;
    expect(offerBrief.brief.bootstrap).toBe('offer_page');
    expect(offerBrief.brief.pageType).toBe('offer');
    expect(offerBrief.brief.researchFindings.some((f) => f.label === 'DATA_UNAVAILABLE' && /conversion/.test(f.finding))).toBe(true);
    expect(r.offerPage!.status).toBe('briefed');
    expect(r.offerPage!.brief!.gate.issues.filter((i) => i.severity === 'error')).toEqual([]);

    // Exactly one supporting-page brief
    expect(r.supportingPage.itemId).not.toBeNull();
    const supporting = r.supportingPage as { itemId: string; brief: { gate: { passed: boolean } } };
    expect(supporting.itemId).not.toBe(offerItem.id);
    expect(latestBrief(ctx.db, ctx.siteId, supporting.itemId)!.brief.bootstrap).toBe('supporting_page');

    // Idempotent: a second run reuses the same offer item and, with unchanged inputs, the same brief.
    const again = await runLowDataBootstrap(ctx, deps, { useModel: false });
    expect(again.offerPage!.itemId).toBe(offerItem.id);
    expect(again.offerPage!.brief?.reused).toBe(true);
    expect(latestBrief(ctx.db, ctx.siteId, offerItem.id)!.version).toBe(offerBrief.version);

    // An offer item that is already in production/published/measuring is never moved back or re-briefed.
    const now = ctx.clock.now().toISOString();
    updateItem(ctx.db, ctx.siteId, offerItem.id, { stage: 'measuring' }, now);
    updateItem(ctx.db, ctx.siteId, supporting.itemId, { stage: 'in_review' }, now);
    const briefsBefore = { offer: latestBrief(ctx.db, ctx.siteId, offerItem.id)!.version, supporting: latestBrief(ctx.db, ctx.siteId, supporting.itemId)!.version };
    const third = await runLowDataBootstrap(ctx, deps, { useModel: false, force: true });
    expect(third.offerPage).toMatchObject({ itemId: offerItem.id, status: 'already_in_progress', stage: 'measuring', brief: null });
    expect(third.supportingPage).toMatchObject({ itemId: supporting.itemId, status: 'already_in_progress', stage: 'in_review' });
    expect(getItem(ctx.db, ctx.siteId, offerItem.id)!.stage).toBe('measuring');
    expect(getItem(ctx.db, ctx.siteId, offerItem.id)!.decision).toBe('improve_existing');
    expect(getItem(ctx.db, ctx.siteId, supporting.itemId)!.stage).toBe('in_review');
    expect(latestBrief(ctx.db, ctx.siteId, offerItem.id)!.version).toBe(briefsBefore.offer);
    expect(latestBrief(ctx.db, ctx.siteId, supporting.itemId)!.version).toBe(briefsBefore.supporting);
  });

  it('is skipped on a site with enough data unless forced, and honest in dry-run', async () => {
    ctx = createTestContext({ config: contentConfig() });
    seedPropertyImpressions(ctx, 100); // 2,800 impressions / 28 days > default threshold 500
    const deps = { llm: null, memory: null, approvals: null, vault: null };
    const r = await runLowDataBootstrap(ctx, deps);
    expect(r.lowData.isLowData).toBe(false);
    expect(r.skipped).toMatch(/normal pipeline/);
    expect(r.offerPage).toBeNull();
    ctx.dryRun = true;
    const d = await runLowDataBootstrap(ctx, deps, { force: true });
    expect(d.skipped).toMatch(/dry run/);
  });

  it('reports no supporting page honestly when no candidate has business relation and original value', async () => {
    ctx = createTestContext({ config: contentConfig({ research: { seedTopics: [] } }) });
    seedPages(ctx, [{ path: '/', pageType: 'offer', title: 'Crumb Planner', text: 'x' }]);
    const r = await runLowDataBootstrap(ctx, { llm: null, memory: null, approvals: null, vault: null }, { useModel: false });
    expect(r.supportingPage.itemId).toBeNull();
    expect((r.supportingPage as { reason: string }).reason).toMatch(/content import/);
  });
});

/** Fake model with a small async delay that records peak concurrency. */
class SlowLlm extends FakeLlm {
  active = 0;
  peak = 0;
  override async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    await new Promise((r) => setTimeout(r, 15));
    try {
      return await super.structured(req);
    } finally {
      this.active--;
    }
  }
}

function makeReadyItem(c: TestContext, n: number): string {
  const now = c.clock.now().toISOString();
  const q = `How do I plan bakery topic ${String.fromCharCode(97 + n)} with reusable shift templates?`;
  const id = insertItem(c.db, { siteId: c.siteId, title: q, primaryQuestion: q, stage: 'existing_checked', intent: 'informational', clusterId: null, isSynthetic: true, now });
  const s = upsertSignal(c.db, c.siteId, { origin: 'manual', signalType: 'question', text: q, isSynthetic: true }, now);
  assignSignals(c.db, c.siteId, [s.id], id);
  updateItem(
    c.db,
    c.siteId,
    id,
    {
      decision: 'create_page',
      decisionReason: 'test',
      whyExists: 'customers ask',
      whoBenefits: 'bakery owners',
      businessRelation: 'shift templates',
      originalValue: 'Available: verified product facts (pf-templates).',
      readerNextStep: 'Start a free trial.',
      overlap: { status: 'complete', statusReason: 'checked', pages: [], cannibalization: { risk: 'low', explanation: 'none' }, uncertainty: 'heuristic' },
      demand: { ...computeDemand([s]), relationStrength: 'strong', originalValueAvailable: true },
    },
    now,
  );
  return id;
}

const cityDraft = (city: string) => ({
  titleOptions: [`Bakery shift planning in ${city}`],
  metaDescription: `How bakeries in ${city} can plan shifts with reusable shift templates and a clear weekly routine.`,
  slugSuggestion: `bakery-shift-planning-${city.toLowerCase()}`,
  bodyMarkdown: [
    `# Bakery shift planning in ${city}`,
    '',
    `Bakeries in ${city} can plan bakery shifts by working backwards from opening time. Every bakery in ${city} should list each product, its proofing and baking steps, and assign each step to a shift.`,
    '',
    `The planner includes reusable shift templates, so bakeries in ${city} can reuse the same early production run every week and share the plan with staff.`,
    '',
    `Start a free trial to plan your next production week in ${city} on the [planner](${SITE_URL}).`,
  ].join('\n'),
  internalLinkSuggestions: [],
  structuredDataProposal: null,
  sourceLedger: [],
  factCheckNotes: [],
});

describe('bounded parallel batch drafts', () => {
  it('is refused unless batch is enabled, the pilot is approved, and a batch_expansion approval exists', async () => {
    ctx = createTestContext({ config: contentConfig(), mode: 'DRAFT' });
    seedPages(ctx, [{ path: '/', pageType: 'offer', title: 'Crumb Planner', text: 'x' }]);
    const approvals = new FakeApprovalGate();
    const deps = { llm: new FakeLlm({}), memory: null, approvals, vault: null };
    const ids = [makeReadyItem(ctx, 0), makeReadyItem(ctx, 1)];
    for (const id of ids) await createBrief(ctx, deps, id, { useModel: false, requestApproval: false });
    const r = await runBatchDrafts(ctx, deps, { itemIds: ids });
    expect(r.status).toBe('refused');
    expect(r.reason).toMatch(/batchEnabled/);
    expect(approvals.records).toHaveLength(0);
  });

  it('requires a batch_expansion approval bound to the exact briefs, runs a pilot of 3 with at most 3 workers, and halts when the pilot fails (city-name substitution)', async () => {
    ctx = createTestContext({ config: contentConfig({ content: { batchEnabled: true, pilotApproved: true, maxInProduction: 5, maxAutomatedRevisions: 2 } }), mode: 'DRAFT' });
    seedPages(ctx, [{ path: '/', pageType: 'offer', title: 'Crumb Planner', text: 'x' }]);
    const cities = ['Tallinn', 'Tartu', 'Parnu', 'Narva'];
    const llm = new SlowLlm({ 'content.draft': (req) => cityDraft(cities[Number(String(req.variables.proposed_url).match(/topic-([a-d])/)?.[1]?.charCodeAt(0) ?? 97) - 97]!), 'content.review': passingReview });
    const approvals = new FakeApprovalGate();
    const deps = { llm, memory: null, approvals, vault: null };
    const ids = [0, 1, 2, 3].map((n) => makeReadyItem(ctx, n));
    for (const id of ids) expect((await createBrief(ctx, deps, id, { useModel: false, requestApproval: false })).gate.passed).toBe(true);

    const first = await runBatchDrafts(ctx, deps, { itemIds: ids });
    expect(first.status).toBe('refused');
    expect(first.approvalRequest?.actionType).toBe('batch_expansion');
    expect(first.approvalRequest?.artifactHash).toBe(batchIdentity(ctx, ids).artifactHash);
    approvals.approve(first.approvalRequest!.id);

    const r = await runBatchDrafts(ctx, deps, { itemIds: ids });
    expect(r.pilot.size).toBe(3);
    expect(llm.peak).toBeLessThanOrEqual(3);
    expect(llm.peak).toBeGreaterThan(1);
    expect(r.status).toBe('halted_after_pilot');
    expect(r.pilot.passed).toBe(false);
    const pilotVerdicts = r.items.filter((i) => i.phase === 'pilot').map((i) => i.verdict);
    expect(pilotVerdicts).toContain('reject');
    expect(r.items.find((i) => i.phase === 'expansion')?.status).toBe('skipped');
    // One-time: the batch approval was consumed.
    expect(approvals.records.find((a) => a.id === first.approvalRequest!.id)?.status).toBe('executed');
    const again = await runBatchDrafts(ctx, deps, { itemIds: ids });
    expect(again.status).toBe('refused');
    expect(again.reason).toMatch(/rejected/);

    // A rejected city page cannot be re-reviewed into a pass...
    const pilotDrafts = r.items.filter((i) => i.phase === 'pilot').map((i) => i.draftId!);
    await expect(reviewDraft(ctx, deps, pilotDrafts[0]!, { useModel: true })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(getDraft(ctx.db, ctx.siteId, pilotDrafts[0]!)!.status).toBe('rejected');
    // ...and even if its status were reset, the rejected siblings still count for template similarity.
    const d0 = getDraft(ctx.db, ctx.siteId, pilotDrafts[0]!)!;
    setDraftStatus(ctx.db, ctx.siteId, d0.id, 'needs_human_review');
    updateItem(ctx.db, ctx.siteId, d0.contentItemId, { stage: 'in_review' }, ctx.clock.now().toISOString());
    const rr = await reviewDraft(ctx, deps, d0.id, { useModel: true });
    expect(rr.verdict).toBe('reject');
    expect(rr.checks.find((c) => c.id === 'template_similarity')?.status).toBe('fail');
  });

  it('compares against every draft sharing the programmatic template (superseded and rejected included)', async () => {
    ctx = createTestContext({ config: contentConfig({ content: { batchEnabled: true, pilotApproved: true, maxInProduction: 5, maxAutomatedRevisions: 2 } }), mode: 'DRAFT' });
    seedPages(ctx, [{ path: '/', pageType: 'offer', title: 'Crumb Planner', text: 'x' }]);
    const deps = { llm: null, memory: null, approvals: new FakeApprovalGate(), vault: null };
    const [a, b, c] = [makeReadyItem(ctx, 0), makeReadyItem(ctx, 1), makeReadyItem(ctx, 2)];
    const programmatic = { isProgrammatic: true, templateId: 'city', differentiatingData: [] };
    const now = ctx.clock.now().toISOString();
    const draftFor = (itemId: string, tpl: boolean) => {
      const r = latestBrief(ctx.db, ctx.siteId, itemId)!;
      const brief = tpl ? insertBrief(ctx.db, { siteId: ctx.siteId, itemId, brief: { ...r.brief, programmatic }, contentHash: r.contentHash, gate: r.gate!, status: 'gate_passed', promptVersion: null, modelId: null, now }) : r;
      const pkg = { body: `Body for ${itemId}`, authorization: { kind: 'item' } } as unknown as DraftPackage;
      return (v: number) => insertDraft(ctx.db, { siteId: ctx.siteId, itemId, briefId: brief.id, briefVersion: brief.version, briefHash: brief.contentHash, pkg: { ...pkg, body: `${pkg.body} v${v}` }, bodyHash: `h${v}`, unresolvedFacts: 0, revisionRound: v, promptVersion: null, modelId: null, now });
    };
    for (const id of [a, b, c]) await createBrief(ctx, deps, id, { useModel: false, requestApproval: false });
    const mkA = draftFor(a, true);
    const mkB = draftFor(b, true);
    const mkC = draftFor(c, false);
    const b1 = mkB(1);
    const b2 = mkB(2); // supersedes b1
    setDraftStatus(ctx.db, ctx.siteId, b2.id, 'rejected');
    const c1 = mkC(1);
    const a1 = mkA(1);
    const ids = reviewSiblings(ctx, a1).map((x) => x.draftId).sort();
    // Latest of every other item (rejected b2 included) plus the superseded same-template b1.
    expect(ids).toEqual([b1.id, b2.id, c1.id].sort());
    expect(reviewSiblings(ctx, a1).find((x) => x.draftId === b1.id)?.templateId).toBe('city');
  });

  it('refuses a forged or stale batch authorization (no draft, no model call)', async () => {
    ctx = createTestContext({ config: contentConfig({ content: { batchEnabled: true, pilotApproved: true, maxInProduction: 5, maxAutomatedRevisions: 2 } }), mode: 'DRAFT' });
    seedPages(ctx, [{ path: '/', pageType: 'offer', title: 'Crumb Planner', text: 'x' }]);
    const llm = new FakeLlm({ 'content.draft': () => distinctDraft('a'), 'content.review': passingReview });
    const approvals = new FakeApprovalGate();
    const deps = { llm, memory: null, approvals, vault: null };
    const ids = [makeReadyItem(ctx, 0), makeReadyItem(ctx, 1)];
    for (const id of ids) await createBrief(ctx, deps, id, { useModel: false, requestApproval: false });
    const forged = { approvalId: 'apr_forged', subjectId: 'x'.repeat(32), artifactHash: 'f'.repeat(64), hashInput: { siteId: ctx.siteId, briefs: [] }, capacityReserved: true };
    const err = await generateDraft(ctx, deps, ids[0]!, { batch: forged }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DraftRefusedError);
    expect((err as DraftRefusedError).preconditions.checks.find((c) => c.id === 'approval')?.detail).toMatch(/forged|altered/);
    // A self-consistent authorization without a human approval is refused too.
    const id = batchIdentity(ctx, ids);
    const unapproved = { approvalId: 'apr_x', subjectId: id.batchKey, artifactHash: id.artifactHash, hashInput: { siteId: ctx.siteId, briefs: id.briefs }, capacityReserved: true };
    const err2 = (await generateDraft(ctx, deps, ids[0]!, { batch: unapproved }).catch((e: unknown) => e)) as DraftRefusedError;
    expect(err2.preconditions.checks.find((c) => c.id === 'approval')?.detail).toMatch(/No approved batch_expansion/);
    // An approved batch does not cover a brief rebuilt after the approval.
    const apr = approvals.grant({ siteId: ctx.siteId, actionType: 'batch_expansion', subjectType: 'content_batch', subjectId: id.batchKey, artifactHash: id.artifactHash });
    await createBrief(ctx, deps, ids[0]!, { useModel: false, requestApproval: false, force: true });
    const err3 = (await generateDraft(ctx, deps, ids[0]!, { batch: { ...unapproved, approvalId: apr.id } }).catch((e: unknown) => e)) as DraftRefusedError;
    expect(err3.preconditions.checks.find((c) => c.id === 'approval')?.detail).toMatch(/not the brief approved in the batch/);
    expect(llm.callsFor('content.draft')).toHaveLength(0);
    expect(latestDraft(ctx.db, ctx.siteId, ids[0]!)).toBeNull();
  });

  it('stops after the pilot; expansion needs human acceptance of every pilot draft and a second approval bound to them', async () => {
    ctx = createTestContext({ config: contentConfig({ content: { batchEnabled: true, pilotApproved: true, maxInProduction: 5, maxAutomatedRevisions: 2 } }), mode: 'DRAFT' });
    seedPages(ctx, [{ path: '/', pageType: 'offer', title: 'Crumb Planner', text: 'x' }]);
    const llm = new FakeLlm({ 'content.draft': (req) => distinctDraft(String(req.variables.proposed_url).match(/topic-([a-d])/)?.[1] ?? 'a'), 'content.review': passingReview });
    const approvals = new FakeApprovalGate();
    const deps = { llm, memory: null, approvals, vault: null };
    const ids = [0, 1, 2, 3].map((n) => makeReadyItem(ctx, n));
    for (const id of ids) expect((await createBrief(ctx, deps, id, { useModel: false, requestApproval: false })).gate.passed).toBe(true);

    const first = await runBatchDrafts(ctx, deps, { itemIds: ids });
    approvals.approve(first.approvalRequest!.id);
    const pilot = await runBatchDrafts(ctx, deps, { itemIds: ids });
    expect(pilot.status).toBe('pilot_complete');
    expect(pilot.reason).toMatch(/STOPPED/);
    expect(llm.callsFor('content.draft')).toHaveLength(3);
    const pilotItems = pilot.items.filter((i) => i.phase === 'pilot');
    expect(pilotItems.every((i) => i.status === 'drafted' && i.verdict !== 'reject')).toBe(true);
    expect(pilot.items.find((i) => i.phase === 'expansion')).toMatchObject({ status: 'skipped' });

    // Automated verdicts alone never expand the batch.
    const notReviewed = await runBatchDrafts(ctx, deps, { itemIds: ids });
    expect(notReviewed.status).toBe('refused');
    expect(notReviewed.reason).toMatch(/mark-reviewed/);
    expect(notReviewed.approvalRequest).toBeNull();

    for (const p of pilotItems) {
      const d = getDraft(ctx.db, ctx.siteId, p.draftId!)!;
      markHumanReviewed(ctx, d.id, { reviewer: 'Alice', confirmHashPrefix: d.bodyHash.slice(0, 10) });
    }
    const awaiting = await runBatchDrafts(ctx, deps, { itemIds: ids });
    expect(awaiting.status).toBe('refused');
    expect(awaiting.approvalRequest?.subjectId).toBe(`${first.batchKey}:expansion`);
    const reviewed = pilotItems.map((p) => getDraft(ctx.db, ctx.siteId, p.draftId!)!);
    expect(awaiting.approvalRequest?.artifactHash).toBe(expansionIdentity(ctx, first.batchKey, batchIdentity(ctx, ids).briefs.slice(3), reviewed).artifactHash);
    expect(llm.callsFor('content.draft')).toHaveLength(3);

    approvals.approve(awaiting.approvalRequest!.id);
    const expanded = await runBatchDrafts(ctx, deps, { itemIds: ids });
    expect(expanded.status).toBe('completed');
    expect(expanded.phase).toBe('expansion');
    expect(expanded.items).toHaveLength(1);
    expect(expanded.items[0]).toMatchObject({ status: 'drafted', phase: 'expansion' });
    expect(latestDraft(ctx.db, ctx.siteId, expanded.items[0]!.itemId)!.pkg.authorization).toMatchObject({ kind: 'batch', batchKey: `${first.batchKey}:expansion` });
    expect(llm.callsFor('content.draft')).toHaveLength(4);
    // One-time: no second expansion.
    expect((await runBatchDrafts(ctx, deps, { itemIds: ids })).status).toBe('refused');
  });
});

/** Distinct, fact-based drafts per topic (no name substitution). */
function distinctDraft(letter: string) {
  const topic: Record<string, string[]> = {
    a: ['Weekday mornings need a firm oven start, so list proofing windows first and give the earliest mixer shift to whoever opens.', 'Keep one spare baker on call for sick days and write the rota on the whiteboard near the walk-in.'],
    b: ['Holiday weeks bring heavy pastry orders; freeze laminated dough ahead and stagger bakers so the counter never runs empty before lunch.', 'Confirm special orders on Monday and lock the menu after Wednesday to protect the weekend crew.'],
    c: ['Wholesale cafe deliveries leave at dawn, which means packing lists must be ready by the previous evening shift.', 'Label every crate by route, load the van in reverse order, and keep a driver checklist by the loading door.'],
    d: ['Sourdough loaves need long cold retards; plan retarder space per night and rotate racks between two overnight bakers.', 'Feed the levain on a fixed clock and record hydration notes so the next shift can adjust the flour blend.'],
  };
  const [p1, p2] = topic[letter] ?? topic.a!;
  return {
    titleOptions: [`Plan bakery topic ${letter} with reusable shift templates`],
    metaDescription: `A practical way to plan bakery topic ${letter} with reusable shift templates, specific to this situation.`,
    slugSuggestion: `plan-bakery-topic-${letter}-shift-templates`,
    bodyMarkdown: [`# Planning bakery topic ${letter} around shift templates`, '', `To plan bakery topic ${letter}, start from the reusable shift templates and adapt them to the specific constraint below.`, '', p1, '', p2, '', 'The planner includes reusable shift templates.', '', `Start a free trial on the [planner](${SITE_URL}).`].join('\n'),
    internalLinkSuggestions: [],
    structuredDataProposal: null,
    sourceLedger: [{ claim: 'The planner includes reusable shift templates.', evidenceIds: [], factIds: ['pf-templates'] }],
    factCheckNotes: [],
  };
}
