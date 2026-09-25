/**
 * Site-structure summary for reports: internal-link suggestions, potential
 * orphans relative to crawl coverage, and page-level heuristic AEO checks.
 * SYNTHETIC fixtures on the reserved example.test domain.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { assessAeoForSite } from '../../../src/crawler/aeo.js';
import { buildSiteStructureSummary, siteStructureSchema, topGscPageDestinations, SITE_STRUCTURE_VERSION } from '../../../src/seo/site-structure.js';
import { UrlReconciler } from '../../../src/seo/reconcile.js';
import { linkDestinations, siteStructureNote, siteStructureStage } from '../../../src/workflows/pipelines/site-structure.js';
import type { StageContext } from '../../../src/workflows/types.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import { daily, PROPERTY, SeoSeeder } from '../../fixtures/seo/seed.js';

let ctx: TestContext;
afterEach(() => ctx?.cleanup());
const HOST = 'https://www.example.test';

function setup() {
  ctx = createTestContext({ config: testSiteConfig({ google: { searchConsoleProperty: PROPERTY } }) });
  return new SeoSeeder(ctx.db, ctx.siteId);
}

function text(t: string): string {
  return ctx.raw.save({ siteId: ctx.siteId, provider: 'crawler', kind: 'text', payload: { text: t } });
}

/** A small synthetic site: /blog mentions "widget sizing charts" without linking to /sizing; /faq links to it; /lonely has no inbound link. */
function seedSite(seed: SeoSeeder, crawlOpts: Parameters<SeoSeeder['crawl']>[1] = {}) {
  const crawl = seed.crawl('own_site', { pagesFetched: 4, pagesAttempted: 4, ...crawlOpts });
  seed.crawlResult(crawl, { requestedUrl: `${HOST}/blog`, title: 'Blog', headings: [{ level: 1, text: 'Choosing widgets' }], textRef: text('Choosing widgets\nMany readers ask about widget sizing charts before buying. Measure twice.') });
  const faq = seed.crawlResult(crawl, { requestedUrl: `${HOST}/faq`, title: 'FAQ', headings: [{ level: 1, text: 'Questions' }], textRef: text('Questions\nOur widget sizing charts are updated yearly.') });
  seed.crawlResult(crawl, { requestedUrl: `${HOST}/sizing`, title: 'Widget sizing charts', headings: [{ level: 1, text: 'Widget sizing charts' }], textRef: text('Widget sizing charts\nWidget sizing charts for every model.') });
  seed.crawlResult(crawl, { requestedUrl: `${HOST}/lonely`, title: 'Lonely page', headings: [{ level: 1, text: 'Lonely page' }], textRef: text('Lonely page\nNothing links here.') });
  seed.internalLink(crawl, faq, `${HOST}/sizing`, 'sizing');
  seed.gscPage(daily('2026-09-01', '2026-09-07', (date) => ({ date, page: `${HOST}/sizing`, clicks: 5, impressions: 100, position: 6 })));
  seed.gscQuery(daily('2026-09-01', '2026-09-07', (date) => ({ date, page: `${HOST}/sizing`, query: 'widget sizing charts', clicks: 4, impressions: 80, position: 6 })));
  const rec = new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock);
  rec.run();
  const dest = rec.resolve(`${HOST}/sizing`) as { pageId: string; pageUrl: string };
  return { crawl, dest };
}

describe('site-structure summary (report input)', () => {
  it('carries internal-link suggestions, potential orphans relative to a completed crawl, and page-level AEO checks; synthetic data is flagged', () => {
    const seed = setup();
    const { crawl, dest } = seedSite(seed);
    const aeo = assessAeoForSite(ctx);
    const s = buildSiteStructureSummary(ctx.db, ctx.raw, ctx.siteId, { destinations: [{ pageId: dest.pageId, url: dest.pageUrl, origin: 'candidate' }], aeo, now: ctx.clock.now() });
    expect(siteStructureSchema.parse(s)).toEqual(s);
    expect(s.version).toBe(SITE_STRUCTURE_VERSION);
    expect(s.synthetic).toBe(true); // seeded crawls are synthetic
    expect(s.crawl).toMatchObject({ id: crawl, status: 'completed', synthetic: true });
    expect(s.internalLinks.claimLabel).toBe('RECOMMENDATION');
    expect(s.internalLinks.suggestions).toEqual([
      expect.objectContaining({ sourcePage: expect.objectContaining({ url: `${HOST}/blog` }), destination: { pageId: dest.pageId, url: dest.pageUrl }, proposedAnchor: 'widget sizing charts', passage: 'Many readers ask about widget sizing charts before buying.', phraseOrigin: 'gsc_query' }),
    ]);
    expect(s.internalLinks.suggestions[0]!.reason).toMatch(/does not link/);
    expect(s.orphans).toMatchObject({ claimLabel: 'INFERRED', coverageComplete: true, notAssessable: 0 });
    expect(s.orphans.potentialOrphans.map((o) => o.url)).toEqual(expect.arrayContaining([`${HOST}/lonely`]));
    expect(s.orphans.potentialOrphans.map((o) => o.url)).not.toContain(`${HOST}/sizing`);
    expect(s.orphans.metricNote).toMatch(/not an authority score/);
    expect(s.aeo).toMatchObject({ claimLabel: 'INFERRED', label: 'HEURISTIC', crawlId: crawl, assessed: 4 });
    const sizing = s.aeo.pages.find((p) => p.url === `${HOST}/sizing`)!;
    expect(Object.keys(sizing.checks)).toEqual(['answer', 'headings', 'sections', 'evidence']);
    expect(sizing.eligibility).toMatchObject({ crawl: 'allowed' });
    expect(s.aeo.caveat).toMatch(/not Google ranking rules/);
    expect(s.notes).toEqual([]);
  });

  it('a partial crawl calls no page an orphan; no crawl states everything unavailable (never zero-filled)', () => {
    const seed = setup();
    const { dest } = seedSite(seed, { status: 'partial', stopReason: 'max pages reached' });
    const partial = buildSiteStructureSummary(ctx.db, ctx.raw, ctx.siteId, { destinations: [{ pageId: dest.pageId, url: dest.pageUrl }], aeo: null, aeoUnavailableReason: 'not requested (SYNTHETIC test)', now: ctx.clock.now() });
    expect(partial.orphans).toMatchObject({ coverageComplete: false, potentialOrphans: [], totalPotentialOrphans: 0 });
    expect(partial.orphans.notAssessable).toBeGreaterThan(0);
    expect(partial.notes.join(' ')).toMatch(/was partial: no page is called a potential orphan/);
    expect(partial.aeo).toMatchObject({ claimLabel: 'DATA_UNAVAILABLE', assessed: 0, pages: [] });
    expect(partial.notes.join(' ')).toMatch(/AEO checks were not assessed: not requested/);
    expect(siteStructureNote(partial, null)).toMatchObject({ status: 'degraded', code: 'CRAWL_PARTIAL' });

    ctx.cleanup();
    setup();
    const none = buildSiteStructureSummary(ctx.db, ctx.raw, ctx.siteId, { destinations: [], aeo: assessAeoForSite(ctx), now: ctx.clock.now() });
    expect(none.crawl).toBeNull();
    expect(none.internalLinks).toMatchObject({ claimLabel: 'DATA_UNAVAILABLE', suggestions: [], totalSuggestions: 0 });
    expect(none.internalLinks.note).toMatch(/No suggestions were fabricated/);
    expect(none.orphans).toMatchObject({ claimLabel: 'DATA_UNAVAILABLE', potentialOrphans: [] });
    expect(none.aeo.claimLabel).toBe('DATA_UNAVAILABLE');
    expect(none.notes[0]).toMatch(/No completed or partial own-site crawl/);
    expect(siteStructureNote(none, null)).toMatchObject({ status: 'degraded', code: 'CRAWL_MISSING', nextStep: expect.stringMatching(/crawl/) });
  });

  it('is bounded for reports', () => {
    const seed = setup();
    const { dest } = seedSite(seed);
    const s = buildSiteStructureSummary(ctx.db, ctx.raw, ctx.siteId, { destinations: [{ pageId: dest.pageId, url: dest.pageUrl }], aeo: assessAeoForSite(ctx), now: ctx.clock.now(), limits: { aeoPages: 1, orphans: 1 } });
    expect(s.aeo.pages).toHaveLength(1);
    expect(s.aeo.assessed).toBe(4);
    expect(s.aeo.omittedFromReport).toBe(3);
    expect(s.aeo.notAssessed).toBe(3); // no crawl page beyond the assessment limit + 3 left out by the report bound
    expect(s.orphans.potentialOrphans.length).toBeLessThanOrEqual(1);
    expect(s.orphans.totalPotentialOrphans).toBeGreaterThanOrEqual(s.orphans.potentialOrphans.length);
  });
});

describe('weekly site_structure stage', () => {
  it('uses this run\'s candidate pages as destinations (best first), else the top Search Console pages', () => {
    const seed = setup();
    const { dest } = seedSite(seed);
    const lonely = new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).resolve(`${HOST}/lonely`) as { pageId: string; pageUrl: string };
    expect(
      linkDestinations(ctx, [
        { route: 'HEALTHY', pageId: lonely.pageId, url: lonely.pageUrl, score: 99 },
        { route: 'RANKING_OPPORTUNITY', pageId: dest.pageId, url: dest.pageUrl, score: 10 },
        { route: 'INDEXING_UNKNOWN', pageId: lonely.pageId, url: lonely.pageUrl, score: 50 },
      ]),
    ).toEqual([
      { pageId: lonely.pageId, url: lonely.pageUrl, origin: 'candidate' },
      { pageId: dest.pageId, url: dest.pageUrl, origin: 'candidate' },
    ]);
    expect(linkDestinations(ctx, [])).toEqual([{ pageId: dest.pageId, url: dest.pageUrl, origin: 'top_gsc_page' }]);
    expect(topGscPageDestinations(ctx.db, ctx.siteId, null)).toEqual([]);
  });

  it('runs read-only and free, and returns a checkpointable summary', async () => {
    const seed = setup();
    const { dest } = seedSite(seed);
    const stage = siteStructureStage('report', ['route_and_score'], ['crawl_site']);
    expect(stage.costAllowance).toBe('none');
    expect(stage.optional).toBe(true);
    const prior = { route_and_score: { candidates: [{ route: 'CTR_OPPORTUNITY', pageId: dest.pageId, url: dest.pageUrl, score: 70 }] } };
    const sctx: StageContext = { app: ctx, jobId: 'job_synthetic_structure', workflow: 'weekly', prior, signal: new AbortController().signal, attempt: 1 };
    const tables = ['recommendations', 'opportunities', 'pages', 'crawl_results', 'internal_links'];
    const before = tables.map((t) => ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE site_id = ?`, [ctx.siteId])!.n);
    const input = stage.input.parse(await stage.buildInput(sctx, {}));
    const out = stage.output.parse(await stage.run(input, sctx)) as { summary: { internalLinks: { suggestions: unknown[] }; aeo: { assessed: number } }; note: unknown };
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    expect(out.summary.internalLinks.suggestions).toHaveLength(1);
    expect(out.summary.aeo.assessed).toBe(4);
    expect(out.note).toBeNull();
    expect(tables.map((t) => ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE site_id = ?`, [ctx.siteId])!.n)).toEqual(before);
  });
});
