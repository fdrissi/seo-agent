import { afterEach, describe, expect, it } from 'vitest';
import { runContentResearch } from '../../../src/content/pipeline.js';
import { discoverSignals } from '../../../src/content/signals.js';
import { listItems, listSignals } from '../../../src/content/store.js';
import { demandSummaryLines } from '../../../src/content/demand.js';
import { importManualQuestions } from '../../../src/content/import.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { FakeApprovalGate, FakeLlm, FakeMemory } from '../../fixtures/content/fakes.js';
import { classifyAllInformational, contentConfig, seedGscQueries, seedKeywordMetric, seedPages, seedRedditSignal } from '../../fixtures/content/seed.js';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

function seedScenario(c: TestContext) {
  seedPages(c, [
    { path: '/', pageType: 'offer', title: 'Crumb Planner: production and shift planning for bakeries', headings: ['Plan production', 'Schedule shifts'], text: 'Crumb Planner helps small bakeries plan production and shifts.' },
    { path: '/blog/sourdough-starter-care/', pageType: 'article', title: 'Caring for a sourdough starter', headings: ['Feeding schedule'], text: 'How to feed a sourdough starter.' },
  ]);
  seedGscQueries(c, [
    { query: 'how to schedule bakery production', path: '/', impressions: 40, clicks: 2, position: 14 },
    { query: 'bakery production schedule', path: '/', impressions: 25, clicks: 1, position: 18 },
    { query: 'sourdough starter feeding', path: '/blog/sourdough-starter-care/', impressions: 300, clicks: 30, position: 5 },
  ]);
  seedKeywordMetric(c, 'bakery production schedule', 210, false);
  seedKeywordMetric(c, 'bakery schedule app', 9999, true); // sandbox: must never be used
  seedRedditSignal(c, { text: 'How do you schedule bakery staff for 4am starts?', url: 'https://www.reddit.invalid/r/Baking/comments/abc', upVotes: 42, commentsCount: 17 });
}

describe('content discovery pipeline (integration)', () => {
  it('discovers, dedups, classifies, clusters, validates demand, checks existing content, decides, and prioritizes', async () => {
    ctx = createTestContext({ config: contentConfig() });
    seedScenario(ctx);
    const csv = path.join(ctx.paths.root, 'questions.csv');
    writeFileSync(csv, 'question,count\n"How do I schedule early bakery shifts for a small team?",3\n"What should a bakery production schedule include?",2\n');
    importManualQuestions(ctx, csv);
    const llm = new FakeLlm({ 'content.classify': classifyAllInformational });
    const memory = new FakeMemory([{ siteId: ctx.siteId, text: 'Customers often ask: How far ahead should I plan the weekly bake? Also, weekends are hard.' }]);
    const deps = { llm, memory, approvals: new FakeApprovalGate(), vault: null };

    const run = await runContentResearch(ctx, deps, {});
    expect(run.status === 'completed' || run.status === 'stopped').toBe(true);
    expect(run.outcomes.map((o) => o.stage)).toEqual(['discover', 'dedupe', 'classify', 'cluster', 'validate_demand', 'check_existing', 'prioritize'].slice(0, run.outcomes.length));
    expect(run.outcomes.every((o) => o.status !== 'failed')).toBe(true);

    const signals = listSignals(ctx.db, ctx.siteId);
    const origins = new Set(signals.map((s) => s.origin));
    for (const o of ['gsc_query', 'dataforseo', 'apify_reddit', 'business_knowledge', 'manual']) expect(origins.has(o as never)).toBe(true);
    // Every signal records origin, window, limitations.
    for (const s of signals) {
      expect(s.limitations.length).toBeGreaterThan(10);
      expect(s.collectionWindow).not.toBeNull();
    }
    // Sandbox research excluded everywhere.
    expect(signals.some((s) => s.text === 'bakery schedule app')).toBe(false);
    const discover = run.outputs.discover as { excluded: { sandboxKeywordMetrics: number } };
    expect(discover.excluded.sandboxKeywordMetrics).toBe(1);
    expect(JSON.stringify(listItems(ctx.db, ctx.siteId))).not.toContain('9999');

    // Clustering: fewer items than signals (no one-article-per-keyword).
    const items = listItems(ctx.db, ctx.siteId);
    expect(items.length).toBeLessThan(signals.length);
    const scheduling = items.find((i) => listSignals(ctx.db, ctx.siteId, { itemId: i.id }).some((s) => s.text === 'how to schedule bakery production'))!;
    expect(scheduling).toBeDefined();
    const members = listSignals(ctx.db, ctx.siteId, { itemId: scheduling.id }).map((s) => s.text);
    expect(members.length).toBeGreaterThan(1);

    // Reddit engagement is engagement, never search volume.
    const redditItem = items.find((i) => listSignals(ctx.db, ctx.siteId, { itemId: i.id }).some((s) => s.origin === 'apify_reddit'))!;
    expect(redditItem.demand!.community.threads).toBe(1);
    expect(redditItem.demand!.community.label).toMatch(/not search volume/i);
    if (redditItem.demand!.searchVolumeEstimate.max.status === 'observed') expect(redditItem.demand!.searchVolumeEstimate.max.value).not.toBe(42);

    // Every item has a decision with a preserved reason and the rationale fields.
    for (const i of items) {
      expect(i.decision).not.toBeNull();
      expect(i.decisionReason).toMatch(/\S/);
      expect(i.whyExists).toMatch(/\S/);
      expect(i.whoBenefits).toMatch(/\S/);
      expect(i.businessRelation).toMatch(/\S/);
      expect(i.originalValue).toMatch(/\S/);
      expect(i.readerNextStep).toMatch(/\S/);
      expect(i.overlap?.uncertainty).toMatch(/not proof of cannibalization/);
    }
    // The page receiving impressions for the scheduling queries is preferred over a new page.
    expect(['improve_existing', 'add_section']).toContain(scheduling.decision);
    // Sourdough is outside the configured business scope but the site already receives impressions -> not "create_page" without original value.
    const sourdough = items.find((i) => i.title.includes('sourdough'))!;
    expect(sourdough.decision).not.toBe('create_page');

    // Missing is never zero.
    const noGsc = items.find((i) => i.demand?.gsc.impressions.status !== 'observed');
    if (noGsc) expect(noGsc.demand!.gsc.impressions).toMatchObject({ status: 'missing' });
    // Counts from sources that were never collected are DATA_UNAVAILABLE, not an observed 0.
    const lines = Object.fromEntries(demandSummaryLines(scheduling.demand!).map((l) => [l.metric, l]));
    expect(lines['Competitor gap signals']).toMatchObject({ label: 'DATA_UNAVAILABLE' });
    expect(lines['Competitor gap signals']!.value).toMatch(/No competitive comparison data/);
    const community = lines['Community threads (engagement, not volume)']!;
    expect(community.label).toBe('OBSERVED'); // Apify was collected (one successful run)
    expect(community.value).not.toMatch(/UNAVAILABLE/);

    // Classification model only used for ambiguous candidates, candidate text only in evidence.
    for (const call of llm.callsFor('content.classify')) {
      expect(JSON.stringify(call.variables)).not.toMatch(/bakery staff/);
      expect(call.evidence.length).toBeGreaterThan(0);
    }

    // Idempotent: re-running creates no new items and no duplicate signals.
    const before = { items: items.length, signals: signals.length };
    await runContentResearch(ctx, deps, {});
    expect(listItems(ctx.db, ctx.siteId).length).toBe(before.items);
    expect(listSignals(ctx.db, ctx.siteId).length).toBe(before.signals);

    // Notes are returned as data for the vault slice.
    expect(run.notes.some((n) => n.relPath.startsWith('11 Content Farm/'))).toBe(true);
    expect(run.notes.some((n) => n.relPath.startsWith('10 Content Opportunities/'))).toBe(true);
  });

  it('excludes signals from quarantined/failed Apify runs and synthetic signals outside demo contexts', async () => {
    ctx = createTestContext({ config: contentConfig({ profile: 'core', features: { contentDiscovery: true } }) });
    seedRedditSignal(ctx, { text: 'Quarantined post about bakery shifts?', url: 'https://www.reddit.invalid/r/x/1', runStatus: 'quarantined' });
    seedRedditSignal(ctx, { text: 'Failed post about bakery shifts?', url: 'https://www.reddit.invalid/r/x/2', runStatus: 'FAILED' });
    // Non-quarantined runs: one synthetic signal (excluded outside demo contexts) and one real signal (kept).
    const syntheticId = seedRedditSignal(ctx, { text: 'Synthetic post about early bakery shifts?', url: 'https://www.reddit.invalid/r/x/3' });
    const realId = seedRedditSignal(ctx, { text: 'Real post about early bakery shifts?', url: 'https://www.reddit.invalid/r/x/4', synthetic: false });
    const res = await discoverSignals(ctx, null);
    expect(res.excluded.quarantinedApifySignals).toBe(2);
    expect(res.excluded.syntheticSignals).toBe(1);
    expect(res.signalIds).not.toContain(syntheticId);
    expect(res.signalIds).toContain(realId);
    expect(res.signals.filter((s) => s.origin === 'apify_reddit').map((s) => s.id)).toEqual([realId]);
    expect(res.sourceStatus.find((s) => s.origin === 'apify_reddit')?.status).toBe('collected');
    expect(res.sourceStatus.find((s) => s.origin === 'business_knowledge')?.detail).toMatch(/memory retriever not wired/);
  });

  it('reports honest empty statuses on a site with no data', async () => {
    ctx = createTestContext({ config: contentConfig({ research: { seedTopics: [] } }) });
    const res = await discoverSignals(ctx, null);
    expect(res.signalIds).toEqual([]);
    const gsc = res.sourceStatus.find((s) => s.origin === 'gsc_query')!;
    expect(gsc.status).toBe('empty');
    expect(gsc.detail).toMatch(/sync gsc/);
    // Never-collected sources are "unavailable", not an empty collection.
    expect(res.sourceStatus.find((s) => s.origin === 'apify_reddit')).toMatchObject({ status: 'unavailable', detail: expect.stringMatching(/Not collected/) });
    expect(res.sourceStatus.find((s) => s.origin === 'manual')).toMatchObject({ status: 'unavailable', detail: expect.stringMatching(/Not collected/) });
    const run = await runContentResearch(ctx, { llm: null, memory: null, approvals: null, vault: null }, {});
    expect(run.status).toBe('stopped');
    expect(run.stop && run.stop.stop ? run.stop.status : null).toBe('no_action');
  });

  it('uses embeddings for semantic clustering only when explicitly requested and configured', async () => {
    ctx = createTestContext({ config: contentConfig() });
    seedScenario(ctx);
    // Synthetic 2-d "embeddings": scheduling texts point one way, everything else another.
    const embedder = (texts: string[]) => texts.map((t) => (/schedul|shift|staff/i.test(t) ? new Float32Array([1, 0.05]) : new Float32Array([0.05, 1])));
    const llm = new FakeLlm({ 'content.classify': classifyAllInformational }, { cheap: true, reasoning: true, embedding: true }, embedder);
    const deps = { llm, memory: null, approvals: new FakeApprovalGate(), vault: null };
    const plain = await runContentResearch(ctx, deps, {});
    expect(llm.embedCalls).toHaveLength(0);
    expect((plain.outputs.cluster as { semanticStatus: string }).semanticStatus).toBe('not requested');
    const sem = await runContentResearch(ctx, deps, {}, { cluster: { semantic: true } });
    expect(llm.embedCalls).toHaveLength(1);
    const out = sem.outputs.cluster as { semanticStatus: string; method: string };
    expect(out.semanticStatus).toMatch(/used \(fixture-embed, 2 dims\)/);
    expect(out.method).toMatch(/embedding/);
  });

  it('preview mode writes nothing', async () => {
    ctx = createTestContext({ config: contentConfig() });
    seedGscQueries(ctx, [{ query: 'bakery production schedule', path: '/', impressions: 10 }]);
    const res = await discoverSignals(ctx, null, { preview: true });
    expect(res.countsByOrigin.gsc_query).toBe(1);
    expect(listSignals(ctx.db, ctx.siteId)).toEqual([]);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sources WHERE site_id = ?', [ctx.siteId])!.n).toBe(0);
  });
});
