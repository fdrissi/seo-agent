/**
 * SYNTHETIC tests for evidence honesty in the content pipeline: memory is
 * re-checked against its original, original value is real (not search
 * impressions), estimates stay estimates, competitor headings stay topic
 * prompts, branded clusters are navigational/segmented, relevance is never
 * auto-dismissed, and a writer output that needs review stops the durable
 * job for a human instead of failing as a provider error.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { siteVaultDir } from '../../../src/config/paths.js';
import { createBrief, runBriefGate } from '../../../src/content/brief.js';
import { classifyCandidates } from '../../../src/content/classify.js';
import { computeDemand, demandSummaryLines } from '../../../src/content/demand.js';
import { computeOverlap, decide } from '../../../src/content/existing.js';
import { contentProductionJobHandler, runContentProductionJob } from '../../../src/content/jobs.js';
import { prioritizeItems } from '../../../src/content/prioritize.js';
import { assignSignals, getItem, insertItem, latestBrief, latestDraft, listItems, listSignals, updateItem, upsertSignal } from '../../../src/content/store.js';
import type { Candidate, ContentDecision } from '../../../src/content/types.js';
import { JobRegistry } from '../../../src/jobs/registry.js';
import { JobRunner } from '../../../src/jobs/runner.js';
import { createMemoryService } from '../../../src/memory/service.js';
import { recordStageReview } from '../../../src/workflows/reviews.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { FakeApprovalGate, FakeLlm } from '../../fixtures/content/fakes.js';
import { briefSynthesis, classifyAllInformational, contentConfig, goodDraft, passingReview, researchedSchedulingItem } from '../../fixtures/content/seed.js';

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

type Req = Parameters<typeof briefSynthesis>[0];

describe('memory evidence is re-checked against its original before reuse (A3-03)', () => {
  it('a business note edited after sync no longer supports its old number; a deleted note is dropped', async () => {
    // Non-demo profile: in a demo workspace memory never holds owner-approved facts (everything is synthetic).
    ctx = createTestContext({ config: contentConfig({ profile: 'full' } as never) });
    const llm = new FakeLlm({
      'content.classify': classifyAllInformational,
      'content.brief': (req: Req) => {
        const base = briefSynthesis(req);
        return { ...base, outline: [{ ...base.outline[0]!, answers: ['Plan for 37 production runs per week in a small bakery production schedule.'] }, base.outline[1]!] };
      },
    });
    const approvals = new FakeApprovalGate();
    const itemId = await researchedSchedulingItem(ctx, { llm, memory: null, approvals, vault: null }, { synthetic: false });
    const dir = path.join(siteVaultDir(ctx.paths, ctx.siteId), '01 Business');
    mkdirSync(dir, { recursive: true });
    const note = path.join(dir, 'Production volume.md');
    const noteText = (runs: number) => `---\ntitle: Production volume\n---\n<!-- SYNTHETIC FIXTURE: fictional volume for tests. -->\n\n# Production volume\n\nA small bakery production schedule typically plans ${runs} production runs per week.\n`;
    writeFileSync(note, noteText(37));
    // Owner-approved (as if imported by the validated business-note sync); full-text retrieval only.
    const memory = createMemoryService(ctx, { llm: null, qdrant: null, collectOptions: { businessNoteTrust: () => 'owner_approved' } });
    await memory.sync({});
    const deps = { llm, memory, approvals, vault: null };

    const fresh = await createBrief(ctx, deps, itemId, { useModel: true, requestApproval: false });
    const mem = fresh.brief.evidenceSources.find((e) => e.kind === 'memory');
    expect(mem, 'the note is retrieved').toBeDefined();
    expect(mem!.label).toMatch(/original verified/);
    expect(mem!.trustClass).toBe('owner_approved');
    expect(fresh.gate.issues.filter((i) => i.code === 'unsupported_number')).toEqual([]);

    // The owner edits the note; memory is NOT re-synced. The stale chunk must not support "37".
    writeFileSync(note, noteText(52));
    const stale = await createBrief(ctx, deps, itemId, { useModel: true, requestApproval: false, force: true });
    const staleEv = stale.brief.evidenceSources.find((e) => e.kind === 'memory')!;
    expect(staleEv.label).toMatch(/STALE/);
    expect(staleEv.trustClass).toBe('user_reported');
    expect(stale.gate.passed).toBe(false);
    expect(stale.gate.issues.find((i) => i.code === 'unsupported_number')?.message).toMatch(/"37"/);
    expect(stale.gate.issues.some((i) => i.code === 'stale_memory_evidence')).toBe(true);

    // Deleted note: the chunk is dropped and the drop is stated.
    rmSync(note);
    const gone = await createBrief(ctx, deps, itemId, { useModel: true, requestApproval: false, force: true });
    expect(gone.brief.evidenceSources.some((e) => e.kind === 'memory')).toBe(false);
    expect(gone.brief.researchFindings.some((f) => f.label === 'DATA_UNAVAILABLE' && /no longer exists/.test(f.finding))).toBe(true);
  });
});

describe('original value and relevance decisions (A6-04, A6-16)', () => {
  function item(c: TestContext, title: string, signals: Array<{ origin: 'gsc_query' | 'manual' | 'apify_reddit'; text: string; impressions?: number }>) {
    const now = c.clock.now().toISOString();
    const id = insertItem(c.db, { siteId: c.siteId, title, primaryQuestion: title, stage: 'existing_checked', intent: 'informational', clusterId: null, isSynthetic: true, now });
    const sigs = signals.map((s) =>
      upsertSignal(c.db, c.siteId, { origin: s.origin, signalType: 'question', text: s.text, isSynthetic: true, ...(s.origin === 'gsc_query' ? { engagement: { kind: 'gsc_metrics', impressions: s.impressions ?? 50, clicks: 1, weightedPosition: 9 } } : {}) }, now),
    );
    assignSignals(c.db, c.siteId, sigs.map((s) => s.id), id);
    return { item: getItem(c.db, c.siteId, id)!, signals: listSignals(c.db, c.siteId, { itemId: id }) };
  }
  const site = { pages: [], crawlAvailable: true, gscAvailable: true };

  it('search impressions and customer questions are demand, not original value', () => {
    ctx = createTestContext({ config: contentConfig({ business: { offer: 'Planner software that helps small bakeries schedule production', targetCustomer: 'Owners of small bakeries', differentiators: [], productFacts: [], approvedClaims: [], prohibitedClaims: [] } } as never) });
    const { item: it1, signals } = item(ctx, 'how to schedule bakery production', [
      { origin: 'gsc_query', text: 'how to schedule bakery production', impressions: 400 },
      { origin: 'manual', text: 'How should I schedule bakery production for weekends?' },
    ]);
    const d = decide(ctx, it1, signals, computeDemand(signals), computeOverlap(it1, signals, site));
    expect(d.originalValueAvailable).toBe(false);
    expect(d.originalValue).toMatch(/^None identified/);
    expect(d.originalValue).not.toMatch(/Available: .*Search Console/);
    expect(d.decision).toBe('defer');
    expect(d.reason).toMatch(/No original contribution/);
  });

  it('no term overlap is an owner-review deferral, never an automatic rejection', () => {
    ctx = createTestContext({ config: contentConfig() });
    const { item: it1, signals } = item(ctx, 'how to rebuild a vintage motorcycle carburetor', [
      { origin: 'apify_reddit', text: 'How to rebuild a vintage motorcycle carburetor?' },
      { origin: 'apify_reddit', text: 'Carburetor rebuild kit for old motorcycles?' },
    ]);
    const d = decide(ctx, it1, signals, computeDemand(signals), computeOverlap(it1, signals, site));
    expect(d.relationStrength).toBe('none');
    expect(d.decision).toBe('defer');
    expect(d.reason).toMatch(/Owner review needed/);
    expect(d.reason).toMatch(/not dismissed automatically/);
  });
});

describe('branded queries (A6-05)', () => {
  const cand = (key: string, text: string): Candidate => ({ key, text, signalIds: [`sig_${key}`], origins: ['gsc_query'], signalTypes: ['query'], nearDuplicates: [], isSynthetic: true, existingItemId: null });

  it('strips brand-alias tokens before the rules: brand + navigational words is navigational, brand words never supply intent', async () => {
    ctx = createTestContext({ config: contentConfig({ brand: { aliases: ['Example Widgets', 'Guide Hub', 'Best Buy'] } } as never) });
    const out = await classifyCandidates(ctx, null, [
      cand('a', 'example widgets'),
      cand('b', 'example widgets contact'),
      cand('c', 'guide hub login'),
      cand('d', 'best buy login'),
      cand('e', 'guide hub tutorial for beginners'),
      cand('f', 'best buy opening hours'),
    ]);
    const by = Object.fromEntries(out.classifications.map((c) => [c.key, c]));
    expect(by.a).toMatchObject({ intent: 'navigational', matchedRules: ['brand_only'] });
    expect(by.b).toMatchObject({ intent: 'navigational', matchedRules: ['brand_navigational'] });
    expect(by.c!.intent).toBe('navigational');
    expect(by.d!.intent).toBe('navigational');
    expect(by.f!.intent).toBe('navigational');
    // "guide" inside the brand name does not count; "tutorial" outside it does.
    expect(by.e!.intent).toBe('informational');
    expect(by.e!.rationale).toMatch(/brand "guide hub" removed/);
  });

  it('ranks branded clusters in a separate segment after non-branded items, even with a higher score', () => {
    ctx = createTestContext({ config: contentConfig() });
    const now = ctx.clock.now().toISOString();
    const mk = (title: string, branded: boolean, impressions: number, decision: ContentDecision) => {
      const id = insertItem(ctx.db, { siteId: ctx.siteId, title, primaryQuestion: title, stage: 'existing_checked', intent: 'informational', clusterId: null, isSynthetic: true, now, decision });
      const demand = { ...computeDemand([]), gsc: { ...computeDemand([]).gsc, impressions: { status: 'observed' as const, value: impressions } }, signalCount: 5, relationStrength: 'strong' as const, originalValueAvailable: true, branded };
      updateItem(ctx.db, ctx.siteId, id, { demand }, now);
      return id;
    };
    const branded = mk('crumb planner setup guide', true, 5000, 'improve_existing');
    const plain = mk('how to schedule bakery production', false, 40, 'create_page');
    const out = prioritizeItems(ctx, listItems(ctx.db, ctx.siteId));
    expect(out.topItemId).toBe(plain);
    expect(out.ranked.map((r) => [r.itemId, r.segment])).toEqual([
      [plain, 'non_branded'],
      [branded, 'branded'],
    ]);
    expect(out.ranked[1]!.score!).toBeGreaterThan(out.ranked[0]!.score!);
    expect(getItem(ctx.db, ctx.siteId, branded)!.demand!.scoring!.limitations.join(' ')).toMatch(/Branded cluster/);
  });

  it('marks an item branded when its question names the brand', () => {
    ctx = createTestContext({ config: contentConfig() });
    const now = ctx.clock.now().toISOString();
    const id = insertItem(ctx.db, { siteId: ctx.siteId, title: 'crumb planner shift templates', primaryQuestion: 'crumb planner shift templates', stage: 'existing_checked', intent: 'informational', clusterId: null, isSynthetic: true, now });
    const it1 = getItem(ctx.db, ctx.siteId, id)!;
    const d = decide(ctx, it1, [], computeDemand([]), computeOverlap(it1, [], { pages: [], crawlAvailable: true, gscAvailable: true }));
    expect(d.branded).toBe(true);
  });
});

describe('estimates and competitor headings in briefs (A6-15, A6-09)', () => {
  it('labels the volume estimate INFERRED and only accepts it as support when the sentence calls it an estimate', async () => {
    ctx = createTestContext({ config: contentConfig() });
    const deps = { llm: new FakeLlm({ 'content.classify': classifyAllInformational }), memory: null, approvals: null, vault: null };
    const itemId = await researchedSchedulingItem(ctx, deps);
    const r = await createBrief(ctx, deps, itemId, { useModel: false });
    const vol = r.brief.researchFindings.find((f) => f.evidenceIds.includes('metric:volume_estimate'))!;
    expect(vol.label).toBe('INFERRED');
    expect(vol.finding).toMatch(/third-party estimate/);
    const line = r.brief.demandSummary.find((d) => /search-volume/i.test(d.metric))!;
    expect(line).toMatchObject({ label: 'INFERRED' });
    expect(line.value).toMatch(/210 \(third-party estimate\)/);
    expect(demandSummaryLines(getItem(ctx.db, ctx.siteId, itemId)!.demand!).find((d) => /search-volume/i.test(d.metric))!.label).toBe('INFERRED');

    const withAnswer = (answer: string) => ({ ...r.brief, outline: [{ ...r.brief.outline[0]!, answers: [answer] }, ...r.brief.outline.slice(1)] });
    const asDemand = runBriefGate(ctx, withAnswer('About 210 bakers search for a bakery production schedule every month.'));
    expect(asDemand.issues.find((i) => i.code === 'unsupported_number')?.message).toMatch(/"210"/);
    const asEstimate = runBriefGate(ctx, withAnswer('Keyword tools estimate 210 monthly searches for a bakery production schedule.'));
    expect(asEstimate.issues.filter((i) => i.code === 'unsupported_number')).toEqual([]);
  });

  it('never turns competitor headings into outline headings; they are listed as topic prompts', async () => {
    ctx = createTestContext({ config: contentConfig() });
    const deps = { llm: new FakeLlm({ 'content.classify': classifyAllInformational }), memory: null, approvals: null, vault: null };
    const itemId = await researchedSchedulingItem(ctx, deps);
    const now = ctx.clock.now().toISOString();
    const gaps = ['How many bakers do you need to schedule bakery production?', 'What is the best bakery production schedule template?'].map((text) => upsertSignal(ctx.db, ctx.siteId, { origin: 'competitor_gap', signalType: 'question', text, isSynthetic: true, url: 'https://competitor.example.test/guide' }, now));
    assignSignals(ctx.db, ctx.siteId, gaps.map((g) => g.id), itemId);
    const r = await createBrief(ctx, deps, itemId, { useModel: false, requestApproval: false });
    for (const g of gaps) expect(r.brief.outline.some((o) => o.heading === g.text)).toBe(false);
    const prompt = r.brief.researchFindings.find((f) => /topic prompt, do not copy/.test(f.finding))!;
    expect(prompt).toBeDefined();
    expect(prompt.evidenceIds.sort()).toEqual(gaps.map((g) => g.id).sort());
    // A synthesized outline that copies one verbatim is flagged (and is not required answer coverage).
    const copied = runBriefGate(ctx, { ...r.brief, outline: [...r.brief.outline.slice(0, 1), { heading: gaps[0]!.text, purpose: 'x', answers: [], evidenceIds: [gaps[0]!.id] }, ...r.brief.outline.slice(1)] });
    expect(copied.issues.find((i) => i.code === 'competitor_heading_copied')).toBeDefined();
  });
});

describe('writer output that needs review stops the durable job for a human (A3-09)', () => {
  it('needs_review is a needs_review stop with the call id and raw output stored; the approval is not used; --reviewed ends without a draft', async () => {
    ctx = createTestContext({ config: contentConfig(), mode: 'DRAFT' });
    // The writer returns output that fails the schema (after the gateway's repairs): status needs_review.
    const llm = new FakeLlm({ 'content.classify': classifyAllInformational, 'content.draft': () => ({ titleOptions: [], bodyMarkdown: 'not a package' }), 'content.review': passingReview });
    const approvals = new FakeApprovalGate();
    const deps = { llm, memory: null, approvals, vault: null };
    const itemId = await researchedSchedulingItem(ctx, deps);
    const b = await createBrief(ctx, deps, itemId, { useModel: false });
    expect(b.gate.passed).toBe(true);
    approvals.approve(b.approvalRequest!.id);

    const run = await runContentProductionJob(ctx, { itemId }, deps);
    expect(run.outcome).toBe('waiting');
    expect(run.failure).toBeNull();
    expect(run.stoppedBy).toMatchObject({ stage: 'draft', status: 'needs_review' });
    expect(run.stoppedBy!.reason).toMatch(/failed validation after the controlled repair attempts/);
    expect(run.stoppedBy!.reason).toMatch(/--reviewed draft/);
    const out = run.outputs.draft as { draftId: string | null; modelReview: { callId: string | null; lastRawOutput: string | null } };
    expect(out.draftId).toBeNull();
    expect(out.modelReview.lastRawOutput).toMatch(/not a package/);
    expect(latestDraft(ctx.db, ctx.siteId, itemId)).toBeNull();
    // The one-time draft approval was NOT consumed.
    expect(approvals.records.find((a) => a.id === b.approvalRequest!.id)!.status).toBe('approved');
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE site_id = ? AND event_type = 'content.draft_needs_review'", [ctx.siteId])!.n).toBe(1);
    // Not a provider failure: nothing counted against the provider's health.
    expect(run.stages.find((s) => s.stage === 'draft')?.error).toBeUndefined();

    // A human records the review; resuming continues past the stop and ends without a draft.
    recordStageReview(ctx.db, ctx.clock, { siteId: ctx.siteId, jobId: run.jobId, stage: 'draft', reviewer: 'owner:Test Owner' });
    const runner = new JobRunner({ registry: new JobRegistry().register(contentProductionJobHandler(deps)), maxMode: ctx.mode });
    const resumed = (await runner.resume(ctx, run.jobId, { actor: 'owner:Test Owner' })).results[0]!;
    expect(resumed.outcome).toBe('succeeded');
    expect(latestDraft(ctx.db, ctx.siteId, itemId)).toBeNull();
    expect(latestBrief(ctx.db, ctx.siteId, itemId)!.id).toBe(b.record!.id);
  });

  it('a normal run still drafts and reviews (control)', async () => {
    ctx = createTestContext({ config: contentConfig(), mode: 'DRAFT' });
    const llm = new FakeLlm({ 'content.classify': classifyAllInformational, 'content.draft': () => goodDraft(), 'content.review': passingReview });
    const approvals = new FakeApprovalGate();
    const deps = { llm, memory: null, approvals, vault: null };
    const itemId = await researchedSchedulingItem(ctx, deps);
    const b = await createBrief(ctx, deps, itemId, { useModel: false });
    approvals.approve(b.approvalRequest!.id);
    const run = await runContentProductionJob(ctx, { itemId }, deps);
    expect(run.stoppedBy).toMatchObject({ stage: 'quality_review', status: 'needs_review' });
    expect((run.outputs.draft as { draftId: string | null }).draftId).toBe(latestDraft(ctx.db, ctx.siteId, itemId)!.id);
  });
});
