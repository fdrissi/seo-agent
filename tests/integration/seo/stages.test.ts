import { afterEach, describe, expect, it } from 'vitest';
import { buildReportOfKind } from '../../../src/reports/build.js';
import { comparisonsFromPrior, createSeoStages, priorMemoryQuery } from '../../../src/seo/stages.js';
import type { CandidateOpportunity } from '../../../src/seo/recommend.js';
import type { StageContext } from '../../../src/workflows/types.js';
import { validateWorkflow } from '../../../src/workflows/engine.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { SeoSeeder } from '../../fixtures/seo/seed.js';
import { scenarioConfig, seedScenario } from '../../fixtures/seo/scenario.js';

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

describe('seo workflow stages', () => {
  it('reconcile_urls -> route_and_score -> recommend produce validated, checkpointable outputs', async () => {
    ctx = createTestContext({ config: scenarioConfig() });
    seedScenario(new SeoSeeder(ctx.db, ctx.siteId));
    const jobId = 'job_test_weekly';
    ctx.db.run("INSERT INTO jobs (id, site_id, type, status, created_at) VALUES (?, ?, 'weekly', 'running', ?)", [jobId, ctx.siteId, '2026-09-24T09:00:00Z']);
    const [reconcile, route, recommend] = createSeoStages();
    const prior: Record<string, unknown> = {};
    const sctx = (): StageContext => ({ app: ctx, jobId, workflow: 'weekly', prior, signal: new AbortController().signal, attempt: 1 });
    for (const stage of [reconcile, route, recommend]) {
      expect(stage.prerequisites.every((p) => p in prior)).toBe(true);
      const input = stage.input.parse(await stage.buildInput(sctx(), { days: 28 }));
      const output = stage.output.parse(await stage.run(input as never, sctx()));
      JSON.parse(JSON.stringify(output)); // checkpoint-serializable
      prior[stage.name] = output;
    }
    expect(prior.reconcile_urls).toMatchObject({ pagesCreated: 5, unresolved: 0 });
    expect(prior.route_and_score).toMatchObject({ counts: { TECHNICAL_BLOCKER: 1 }, intentHookStatus: ['not_configured'] });
    expect(prior.recommend).toMatchObject({ kind: 'primary' });
    const rd = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM route_decisions WHERE site_id = ? AND job_id = ?', [ctx.siteId, jobId])!;
    expect(rd.n).toBe(5);
    expect(route.costAllowance).toBe('none');
    expect(route.retry.maxAttempts).toBe(1);
  });

  it('dry run writes nothing in any stage and recommends only from the current run', async () => {
    ctx = createTestContext({ config: scenarioConfig(), dryRun: true });
    const seed = new SeoSeeder(ctx.db, ctx.siteId);
    seedScenario(seed);
    const count = (t: string) => ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE site_id = ?`, [ctx.siteId])!.n;
    const idCount = () => ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM gsc_page_daily WHERE site_id = ? AND page_id IS NOT NULL', [ctx.siteId])!.n;
    const before = { pages: count('pages'), aliases: count('url_aliases'), ids: idCount(), decisions: count('route_decisions'), recs: count('recommendations') };
    const [reconcile, route, recommend] = createSeoStages();
    const prior: Record<string, unknown> = {};
    const sctx = (): StageContext => ({ app: ctx, jobId: 'job_dry', workflow: 'weekly', prior, signal: new AbortController().signal, attempt: 1 });
    for (const stage of [reconcile, route, recommend]) {
      const input = stage.input.parse(await stage.buildInput(sctx(), { days: 28 }));
      prior[stage.name] = stage.output.parse(await stage.run(input as never, sctx()));
    }
    expect(prior.reconcile_urls).toMatchObject({ dryRun: true, pagesCreated: 5 });
    expect({ pages: count('pages'), aliases: count('url_aliases'), ids: idCount(), decisions: count('route_decisions'), recs: count('recommendations') }).toEqual(before);
    expect(prior.recommend).toMatchObject({ primaryId: 'dry-run', saved: false });
  });

  it('recommend never re-proposes an earlier run\'s opportunity that the current run did not produce', async () => {
    ctx = createTestContext({ config: scenarioConfig() });
    seedScenario(new SeoSeeder(ctx.db, ctx.siteId), { withBrokenIssue: false });
    const [reconcile, route, recommend] = createSeoStages();
    const prior: Record<string, unknown> = {};
    const sctx = (): StageContext => ({ app: ctx, jobId: 'job_w', workflow: 'weekly', prior, signal: new AbortController().signal, attempt: 1 });
    ctx.db.run("INSERT INTO jobs (id, site_id, type, status, created_at) VALUES ('job_w', ?, 'weekly', 'running', ?)", [ctx.siteId, '2026-09-24T09:00:00Z']);
    prior.reconcile_urls = await reconcile.run({} as never, sctx());
    const routeOut = await route.run(route.input.parse(await route.buildInput(sctx(), { days: 28 })) as never, sctx());
    prior.route_and_score = routeOut;
    // A stale high-score candidate from some earlier run on a page this run routed elsewhere (not re-derived).
    const guide = ctx.db.get<{ id: string }>('SELECT id FROM pages WHERE site_id = ? AND url = ?', [ctx.siteId, 'https://www.example.test/guide'])!.id;
    ctx.db.run(
      "INSERT INTO opportunities (id, site_id, kind, route, page_id, score, scoring_version, status, period_start, period_end, created_at, updated_at) VALUES ('opp_stale', ?, 'page', 'CTR_OPPORTUNITY', ?, 99, 'scoring@0.9.0', 'candidate', ?, ?, ?, ?)",
      [ctx.siteId, guide, routeOut.period.start, routeOut.period.end, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'],
    );
    const out = await recommend.run(recommend.input.parse(await recommend.buildInput(sctx(), {})) as never, sctx());
    expect(out.title).not.toMatch(/Title\/snippet/);
    const rec = ctx.db.all<{ opportunity_id: string | null }>('SELECT opportunity_id FROM recommendations WHERE site_id = ?', [ctx.siteId]);
    expect(rec.some((r) => r.opportunity_id === 'opp_stale')).toBe(false);
    expect(routeOut.candidates.every((c) => c.id === null || routeOut.persisted.some((p) => p.opportunityId === c.id))).toBe(true);
  });

  it('requires a non-empty cost allowance with an intent hook (engine-valid stages)', () => {
    expect(() => createSeoStages({ intentHook: () => undefined, intentCostAllowance: [] })).toThrow(/non-empty intentCostAllowance/);
    const stages = createSeoStages({ intentHook: () => undefined, intentCostAllowance: [{ provider: 'llm_gateway', maxMicros: 50_000 }] });
    expect(stages[1].costAllowance).toEqual([{ provider: 'llm_gateway', maxMicros: 50_000 }]);
    const withReport = [...stages, { ...stages[2], name: 'report', prerequisites: ['recommend'], next: ['done'] }];
    expect(validateWorkflow(withReport as never).errors).toEqual([]);
    expect(validateWorkflow([...createSeoStages(), withReport[3]!] as never).errors).toEqual([]);
  });
});

describe('recommend consumes the weekly compare stage (A6-01)', () => {
  it('passes this run\'s comparisons to the primary recommendation, and the weekly report renders them without a reports change', async () => {
    ctx = createTestContext({ config: scenarioConfig() });
    seedScenario(new SeoSeeder(ctx.db, ctx.siteId), { withBrokenIssue: false });
    const jobId = 'job_cmp';
    ctx.db.run("INSERT INTO jobs (id, site_id, type, status, created_at) VALUES (?, ?, 'weekly', 'running', ?)", [jobId, ctx.siteId, '2026-09-24T09:00:00Z']);
    const [reconcile, route, recommend] = createSeoStages();
    const prior: Record<string, unknown> = {};
    const sctx = (): StageContext => ({ app: ctx, jobId, workflow: 'weekly', prior, signal: new AbortController().signal, attempt: 1 });
    prior.reconcile_urls = await reconcile.run({} as never, sctx());
    const routeOut = await route.run(route.input.parse(await route.buildInput(sctx(), { days: 28 })) as never, sctx());
    // A synthetic ranking candidate on /guide (the compare stage researched and compared it).
    const guide = ctx.db.get<{ id: string }>('SELECT id FROM pages WHERE site_id = ? AND url = ?', [ctx.siteId, 'https://www.example.test/guide'])!.id;
    prior.route_and_score = {
      ...routeOut,
      siteDecision: null,
      candidates: [{ id: null, route: 'RANKING_OPPORTUNITY', pageId: guide, url: 'https://www.example.test/guide', query: 'how do widgets work', isBranded: false, score: 70, scoringVersion: 'scoring@1.1.0', rawCounts: { impressions: 4000, clicks: 200 }, evidenceQuality: 0.9, reasons: [{ code: 'QUERY_POSITION_IN_RANGE', detail: 'synthetic' }], isProtected: false, periodStart: routeOut.period.start, periodEnd: routeOut.period.end, synthetic: true }],
    };
    prior.compare = {
      comparisons: [
        {
          id: null,
          query: 'how do widgets work',
          pageId: guide,
          url: 'https://www.example.test/guide',
          opportunityId: null,
          competitorsCompared: 2,
          competitorsInaccessible: 1,
          ourAdvantages: ['Our page has original data or first-hand testing; only 0 of 2 compared competitor pages do.'],
          gaps: ['2 of 2 compared competitor pages show warranty/guarantee information; ours does not (observed difference, not a ranking cause).'],
          caveats: ['Observed differences are inputs for a human/analyst; no feature is claimed to cause any ranking.'],
          synthesis: { status: 'skipped', reason: 'synthesis skipped: no reasoning model is configured (llm reasoning tier)' },
          serp: { snapshotId: null, collectedAt: '2026-09-23T00:00:00.000Z', locationCode: null, languageCode: 'en', device: 'desktop' },
          fetchedAt: '2026-09-23T01:00:00.000Z',
          synthetic: true,
        },
        { bogus: true },
      ],
    };
    expect(comparisonsFromPrior(prior.compare)).toHaveLength(1);
    const input = recommend.input.parse(await recommend.buildInput(sctx(), {}));
    expect(input.comparisons).toHaveLength(1);
    const out = await recommend.run(input as never, sctx());
    expect(out.kind).toBe('primary');
    const claims = ctx.db.all<{ claim_key: string; claim_text: string }>("SELECT claim_key, claim_text FROM claim_evidence WHERE site_id = ? AND subject_id = ? AND claim_key LIKE 'primary.compare.%'", [ctx.siteId, out.primaryId]);
    expect(claims.map((c) => c.claim_key)).toEqual(expect.arrayContaining(['primary.compare.scope', 'primary.compare.advantage.1', 'primary.compare.gap.1', 'primary.compare.caveats', 'primary.compare.synthesis']));
    const details = JSON.parse(ctx.db.get<{ d: string }>('SELECT details_json AS d FROM recommendations WHERE id = ?', [out.primaryId])!.d);
    expect(details.comparison).toMatchObject({ query: 'how do widgets work', synthetic: true });
    // The weekly report already renders recommendation claims: the comparison appears with no reports change.
    const built = await buildReportOfKind(ctx, 'weekly', { statuses: null, jobId, persist: false, period: routeOut.period });
    expect(built.markdown).toMatch(/What our page does better: Our page has original data/);
    expect(built.markdown).toMatch(/Observed difference \(a research prompt, not a ranking cause\): 2 of 2 compared competitor pages show warranty/);
    expect(built.markdown).toMatch(/synthesis skipped: no reasoning model/);
  });
});

describe('recommend stage: prior context before recommending (spec 19)', () => {
  it('searches memory with this run\'s candidates (history + owner business notes) and persists what was consulted', async () => {
    ctx = createTestContext({ config: scenarioConfig() });
    seedScenario(new SeoSeeder(ctx.db, ctx.siteId));
    const calls: Array<{ text: string; types: string[] }> = [];
    const memory = {
      search: async (q: { text: string; sourceTypes?: string[] }) => {
        calls.push({ text: q.text, types: q.sourceTypes ?? [] });
        return { chunks: [], method: 'fts_only' as const, degraded: false, detail: 'full-text only by policy (SYNTHETIC test)', usedTokens: 0, budgetTokens: 100, truncated: false };
      },
    };
    const [reconcile, route, recommend] = createSeoStages({ memory: memory as never });
    const prior: Record<string, unknown> = {};
    const sctx = (): StageContext => ({ app: ctx, jobId: 'job_prior', workflow: 'weekly', prior, signal: new AbortController().signal, attempt: 1 });
    ctx.db.run("INSERT INTO jobs (id, site_id, type, status, created_at) VALUES ('job_prior', ?, 'weekly', 'running', ?)", [ctx.siteId, '2026-09-24T09:00:00Z']);
    for (const stage of [reconcile, route, recommend]) {
      const input = stage.input.parse(await stage.buildInput(sctx(), { days: 28 }));
      prior[stage.name] = stage.output.parse(await stage.run(input as never, sctx()));
    }
    const candidates = (prior.route_and_score as { candidates: CandidateOpportunity[] }).candidates;
    const expected = priorMemoryQuery(candidates);
    expect(expected.startsWith('previous recommendations experiments decisions')).toBe(true);
    expect(expected.length).toBeGreaterThan('previous recommendations experiments decisions'.length);
    expect(calls.map((c) => c.types)).toEqual([
      ['rejected_proposal', 'experiment_summary', 'decision', 'approved_learning'],
      ['business_note', 'decision'],
    ]);
    expect(calls[0]!.text).toBe(expected);
    const primaryId = (prior.recommend as { primaryId: string }).primaryId;
    const details = JSON.parse(ctx.db.get<{ d: string }>('SELECT details_json AS d FROM recommendations WHERE site_id = ? AND id = ?', [ctx.siteId, primaryId])!.d);
    expect(details.priorContext.memory).toMatchObject({ status: 'ok', detailKind: 'policy', detail: 'full-text only by policy (SYNTHETIC test)' });
    expect(details.priorContext.memory.searched).toEqual(expect.arrayContaining(['business_note', 'rejected_proposal']));
  });

  it('priorMemoryQuery uses the best candidates\' queries and URL paths, bounded', () => {
    const q = priorMemoryQuery([
      { id: 'o1', route: 'RANKING_OPPORTUNITY', pageId: 'p1', url: 'https://www.example.com/blue-widgets/guide', query: 'blue widgets', isBranded: false, score: 10, scoringVersion: null, rawCounts: {}, evidenceQuality: null, reasons: [], isProtected: false, periodStart: null, periodEnd: null },
      { id: 'o2', route: 'CTR_OPPORTUNITY', pageId: 'p2', url: 'not a url', query: null, isBranded: false, score: 90, scoringVersion: null, rawCounts: {}, evidenceQuality: null, reasons: [], isProtected: false, periodStart: null, periodEnd: null },
    ]);
    expect(q).toBe('previous recommendations experiments decisions blue widgets blue widgets guide');
    expect(priorMemoryQuery([]).length).toBeLessThanOrEqual(300);
  });
});
