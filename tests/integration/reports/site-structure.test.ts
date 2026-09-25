import { afterEach, describe, expect, it } from 'vitest';
import { buildMonthlyReport, buildWeeklyReport } from '../../../src/reports/build.js';
import { allClaims, validateReport, type Claim, type Report, type ReportTable } from '../../../src/reports/model.js';
import { assessAeoForSite } from '../../../src/crawler/aeo.js';
import type { OrphanReport, SuggestResult } from '../../../src/seo/internal-links.js';
import { buildSiteStructureSummary } from '../../../src/seo/site-structure.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { SeoSeeder } from '../../fixtures/seo/seed.js';
import { SITE_URL, reportsTestConfig, seedPage, seedWeeklyScenario } from '../../fixtures/reports/seed.js';

/**
 * Weekly internal-link suggestions / potential orphans and monthly page-level
 * AEO checks, read from the database. SYNTHETIC fixtures on www.example.test.
 */

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

function find(report: Report, id: string): Claim {
  const c = allClaims(report).find((x) => x.id === id);
  if (!c) throw new Error(`claim ${id} not found; have: ${allClaims(report).map((x) => x.id).join(', ')}`);
  return c;
}

function table(report: Report, id: string): ReportTable | undefined {
  return report.sections.flatMap((s) => s.tables).find((t) => t.id === id);
}

function text(c: TestContext, t: string): string {
  return c.raw.save({ siteId: c.siteId, provider: 'crawler', kind: 'text', payload: { text: t, _synthetic: true } });
}

/** Weekly scenario + a synthetic own-site crawl: /blog/guide mentions a /pricing query without linking; /about has no inbound link. */
function seedLinkScenario(c: TestContext, opts: { status?: 'completed' | 'partial' } = {}) {
  const s = seedWeeklyScenario(c.db, c.siteId);
  const aboutId = seedPage(c.db, c.siteId, '/about');
  const seed = new SeoSeeder(c.db, c.siteId);
  const crawl = seed.crawl('own_site', { status: opts.status ?? 'completed', pagesFetched: 3, pagesAttempted: opts.status === 'partial' ? 9 : 3, ...(opts.status === 'partial' ? { stopReason: 'page_cap' } : {}) });
  const pricing = seed.crawlResult(crawl, { requestedUrl: `${SITE_URL}/pricing`, pageId: s.pricingPageId, title: 'Pricing', headings: [{ level: 1, text: 'Pricing plans' }], textRef: text(c, 'Pricing plans\nPlans for every team size.') });
  const guide = seed.crawlResult(crawl, { requestedUrl: `${SITE_URL}/blog/guide`, pageId: s.guidePageId, title: 'Guide', headings: [{ level: 1, text: 'Buying guide' }], textRef: text(c, 'Buying guide\nOur guide explains how to compare seo tool pricing before you buy.') });
  const about = seed.crawlResult(crawl, { requestedUrl: `${SITE_URL}/about`, pageId: aboutId, title: 'About', textRef: text(c, 'About us\nWe are a small synthetic team.') });
  seed.internalLink(crawl, pricing, `${SITE_URL}/blog/guide`, 'guide', { sourcePageId: s.pricingPageId, targetPageId: s.guidePageId });
  seed.internalLink(crawl, about, `${SITE_URL}/pricing`, 'pricing', { sourcePageId: aboutId, targetPageId: s.pricingPageId });
  void guide;
  return { ...s, aboutId, crawl };
}

describe('weekly report: internal-link suggestions and potential orphans', () => {
  it('shows source, destination, passage, anchor, and reason, and potential orphans relative to a completed crawl', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const s = seedLinkScenario(ctx);
    const b = await buildWeeklyReport(ctx, { statuses: null });
    expect(b.issues).toEqual([]);
    expect(validateReport(b.report)).toEqual([]);
    const keys = b.report.sections.map((x) => x.key);
    expect(keys.indexOf('internal_links')).toBeGreaterThan(keys.indexOf('content'));

    const sug = find(b.report, 'links.suggestions');
    expect(sug.label).toBe('RECOMMENDATION');
    expect(sug.text).toContain('1 internal-link suggestion(s) for 2 priority destination page(s) (2 top Search Console page(s) of the period)');
    expect(sug.sourceIds).toEqual([`crawls:${s.crawl}`]);
    expect(sug.synthetic).toBe(true);
    const t = table(b.report, 'links.suggestions')!;
    expect(t.columns).toEqual(['Source page', 'Destination page', 'Proposed anchor', 'Passage', 'Reason']);
    expect(t.rows).toEqual([[`${SITE_URL}/blog/guide`, `${SITE_URL}/pricing`, 'seo tool pricing', 'Our guide explains how to compare seo tool pricing before you buy.', expect.stringContaining('does not link to the destination')]]);

    const orphans = find(b.report, 'links.orphans');
    expect(orphans.label).toBe('INFERRED');
    expect(orphans.text).toContain(`1 potential orphan page(s) relative to own-site crawl ${s.crawl} (completed; 3 of 3 attempted page(s) fetched)`);
    expect(orphans.metricIds).toEqual(['links.inbound_internal']);
    expect(table(b.report, 'links.orphans')!.rows).toEqual([[`${SITE_URL}/about`, 'yes', 'fixture', expect.stringContaining('no crawled page links to it')]]);
    expect(b.report.data.internalLinks).toEqual({ crawlId: s.crawl, destinations: 2, suggestions: 1, potentialOrphans: 1, coverageComplete: true });
    // Synthetic crawl -> the report is labeled synthetic.
    expect(b.report.isSynthetic).toBe(true);

    expect(b.markdown).toContain('## Internal links (suggestions and potential orphans)');
    expect(b.markdown).toContain('never an authority score');
    expect(b.markdown).toContain('Our guide explains how to compare seo tool pricing before you buy.');
    expect(b.report.metricDefinitions.map((d) => d.id)).toContain('links.inbound_internal');
  });

  it('a partial crawl makes orphan status not assessable (never "no orphans")', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedLinkScenario(ctx, { status: 'partial' });
    const b = await buildWeeklyReport(ctx, { statuses: null });
    expect(b.issues).toEqual([]);
    const o = find(b.report, 'links.orphans');
    expect(o.label).toBe('DATA_UNAVAILABLE');
    expect(o.text).toContain('not assessable');
    expect(o.reason).toContain('stopped: page_cap');
    expect(table(b.report, 'links.orphans')).toBeUndefined();
    expect(b.report.data.internalLinks?.potentialOrphans).toBeNull();
  });

  it('without a crawl, or when not collected, both claims are DATA UNAVAILABLE', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const b = await buildWeeklyReport(ctx, { statuses: null });
    expect(b.issues).toEqual([]);
    for (const id of ['links.suggestions', 'links.orphans']) {
      expect(find(b.report, id).label).toBe('DATA_UNAVAILABLE');
      expect(find(b.report, id).reason).toContain('no completed or partial own-site crawl');
    }
    const n = await buildWeeklyReport(ctx, { statuses: null, internalLinks: null, persist: false });
    expect(find(n.report, 'links.suggestions').text).toContain('not collected for this report');
    expect(find(n.report, 'links.orphans').label).toBe('DATA_UNAVAILABLE');
  });

  it('uses internal-link data supplied in the report input instead of recomputing it', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const crawl = { id: 'crawl_supplied', status: 'completed', pagesFetched: 5, pagesAttempted: 5, stopReason: null, startedAt: '2026-09-21T00:00:00.000Z', finishedAt: '2026-09-21T00:10:00.000Z' };
    const suggestions: SuggestResult = {
      version: 'internal-links@1.0.0',
      crawl,
      suggestions: [{ sourcePage: { pageId: null, url: `${SITE_URL}/a` }, destination: { pageId: 'page_b', url: `${SITE_URL}/b` }, passage: 'See widget care tips here.', proposedAnchor: 'widget care tips', reason: 'supplied (synthetic)', phraseOrigin: 'provided', crawlId: crawl.id }],
      skipped: [],
      note: 'supplied',
    };
    const orphans: OrphanReport = { version: 'internal-links@1.0.0', crawl, coverageComplete: true, potentialOrphans: [], notAssessable: [], inboundCounts: [], coverageNote: 'supplied coverage', metricNote: 'not an authority score' };
    const b = await buildWeeklyReport(ctx, { statuses: null, internalLinks: { suggestions, orphans, destinationsBasis: 'pages chosen by the caller' } });
    expect(b.issues).toEqual([]);
    expect(find(b.report, 'links.suggestions').text).toContain('1 internal-link suggestion(s) for 1 priority destination page(s) (pages chosen by the caller)');
    expect(find(b.report, 'links.orphans').text).toContain('No potential orphan pages relative to own-site crawl crawl_supplied');
    expect(table(b.report, 'links.suggestions')!.rows[0]![2]).toBe('widget care tips');
  });
});

describe('weekly report: data handed over by the pipeline site_structure stage', () => {
  it('renders internal links and AEO from ReportBuildInput.siteStructure (bounded lists, total counts kept)', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const s = seedLinkScenario(ctx);
    const summary = buildSiteStructureSummary(ctx.db, ctx.raw, ctx.siteId, {
      destinations: [{ pageId: s.pricingPageId, url: `${SITE_URL}/pricing`, origin: 'candidate' }],
      aeo: assessAeoForSite(ctx),
      now: ctx.clock.now(),
    });
    const b = await buildWeeklyReport(ctx, { statuses: null, siteStructure: summary });
    expect(b.issues).toEqual([]);
    expect(validateReport(b.report)).toEqual([]);
    const sug = find(b.report, 'links.suggestions');
    expect(sug.label).toBe('RECOMMENDATION');
    expect(sug.text).toContain('1 internal-link suggestion(s) for 1 priority destination page(s) (1 candidate page(s) of this run)');
    expect(table(b.report, 'links.suggestions')!.rows[0]!.slice(0, 3)).toEqual([`${SITE_URL}/blog/guide`, `${SITE_URL}/pricing`, 'seo tool pricing']);
    expect(find(b.report, 'links.orphans').text).toContain('1 potential orphan page(s)');
    // The run assessed AEO too: the weekly report shows it (factual consistency still DATA UNAVAILABLE).
    const keys = b.report.sections.map((x) => x.key);
    expect(keys.indexOf('aeo')).toBe(keys.indexOf('internal_links') + 1);
    expect(find(b.report, 'aeo.pages').label).toBe('INFERRED');
    expect(find(b.report, 'aeo.pages').text).toContain(`3 page(s) of own-site crawl ${s.crawl}`);
    expect(find(b.report, 'aeo.factual_consistency').label).toBe('DATA_UNAVAILABLE');
    expect(b.report.isSynthetic).toBe(true);
  });

  it('a run without a crawl states both sections as DATA UNAVAILABLE', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const summary = buildSiteStructureSummary(ctx.db, ctx.raw, ctx.siteId, { destinations: [], aeo: null, aeoUnavailableReason: 'no own-site crawl', now: ctx.clock.now() });
    const b = await buildWeeklyReport(ctx, { statuses: null, siteStructure: summary });
    expect(b.issues).toEqual([]);
    for (const id of ['links.suggestions', 'links.orphans', 'aeo.pages', 'aeo.factual_consistency']) expect(find(b.report, id).label).toBe('DATA_UNAVAILABLE');
  });
});

describe('monthly report: page-level AEO assessment', () => {
  function seedAeoCrawl(c: TestContext): string {
    const seed = new SeoSeeder(c.db, c.siteId);
    const crawl = seed.crawl('own_site', { pagesFetched: 2, pagesAttempted: 3 });
    const guideId = seedPage(c.db, c.siteId, '/guide');
    const hiddenId = seedPage(c.db, c.siteId, '/hidden');
    seed.crawlResult(crawl, {
      requestedUrl: `${SITE_URL}/guide`,
      pageId: guideId,
      title: 'Widget pricing guide',
      headings: [
        { level: 1, text: 'Widget pricing guide' },
        { level: 2, text: 'How much does a widget cost?' },
      ],
      textRef: text(c, 'Widget pricing guide\nA widget costs between 10 and 20 dollars depending on size, according to our published price list.\nHow much does a widget cost?\nA standard widget costs 15 dollars including delivery to most regions.'),
    });
    const hidden = seed.crawlResult(crawl, { requestedUrl: `${SITE_URL}/hidden`, pageId: hiddenId, title: 'Hidden', headings: [{ level: 1, text: 'Hidden page' }, { level: 2, text: 'Overview' }], textRef: text(c, 'Hidden page\nThis page is not for search.\nOverview\nAs mentioned above, 45% of visitors never scroll.') });
    const robots = { noindex: true, nofollow: false, nosnippet: false, noarchive: false, noimageindex: false, maxSnippet: null, unavailableAfter: null, sources: ['meta:robots'] };
    c.db.run('UPDATE crawl_results SET extraction_json = ? WHERE id = ?', [JSON.stringify({ robots, _synthetic: true }), hidden]);
    seed.crawlResult(crawl, { requestedUrl: `${SITE_URL}/private`, status: null, blockedReason: 'robots' });
    return crawl;
  }

  it('reports every spec-17 criterion: heuristic checks (INFERRED), eligibility (OBSERVED), factual consistency (DATA UNAVAILABLE)', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const crawl = seedAeoCrawl(ctx);
    const b = await buildMonthlyReport(ctx, { statuses: null });
    expect(b.issues).toEqual([]);
    expect(validateReport(b.report)).toEqual([]);
    const keys = b.report.sections.map((x) => x.key);
    expect(keys.indexOf('aeo')).toBe(keys.indexOf('ai_visibility') + 1);

    const pages = find(b.report, 'aeo.pages');
    expect(pages.label).toBe('INFERRED');
    expect(pages.text).toContain(`2 page(s) of own-site crawl ${crawl} assessed with deterministic AEO heuristics (aeo-heuristic@1)`);
    expect(pages.text).toMatch(/clear answers 0 ok, 0 to review, 2 unknown/);
    expect(pages.text).toMatch(/self-contained sections 1 ok, 1 to review, 0 unknown/);
    expect(pages.synthetic).toBe(true);
    expect(pages.sourceIds).toContain(`crawls:${crawl}`);

    const factual = find(b.report, 'aeo.factual_consistency');
    expect(factual.label).toBe('DATA_UNAVAILABLE');
    expect(factual.reason).toContain('do not verify facts');

    const elig = find(b.report, 'aeo.eligibility');
    expect(elig.label).toBe('OBSERVED');
    expect(elig.text).toContain('noindex on 1');
    expect(elig.text).toContain('not eligible for AI features on 1');
    expect(elig.text).toContain('1 URL(s) of this crawl were blocked by robots.txt');
    expect(elig.text).toContain('No blocking directive does not mean a page is indexed');

    const t = table(b.report, 'aeo.pages')!;
    expect(t.columns).toEqual(['Page', 'Clear answers', 'Headings', 'Sections', 'Evidence', 'Factual consistency', 'Indexing', 'Snippet', 'AI features']);
    const hiddenRow = t.rows.find((r) => r[0] === `${SITE_URL}/hidden`)!;
    expect(hiddenRow).toEqual([`${SITE_URL}/hidden`, 'unknown', 'REVIEW', 'REVIEW', 'REVIEW', 'not assessed', 'blocked_by_noindex', 'no_restriction_observed', 'not_eligible']);
    const review = table(b.report, 'aeo.review')!;
    expect(review.rows.some((r) => r[0] === `${SITE_URL}/hidden` && r[1] === 'Self-contained sections' && /as mentioned above/i.test(String(r[2])))).toBe(true);
    expect(b.report.data.aeo).toMatchObject({ crawlId: crawl, pagesAssessed: 2, notAssessed: 0, eligibility: { noindex: 1, robotsBlocked: 1 } });
    expect(b.markdown).toContain('## AI-search readiness (page-level AEO heuristics)');
    expect(b.markdown).toContain('not Google ranking rules');
    expect(b.report.isSynthetic).toBe(true);
  });

  it('without a crawl, or when not collected, the assessment is DATA UNAVAILABLE (never shown as zero)', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const b = await buildMonthlyReport(ctx, { statuses: null });
    expect(b.issues).toEqual([]);
    expect(find(b.report, 'aeo.pages').label).toBe('DATA_UNAVAILABLE');
    expect(find(b.report, 'aeo.pages').reason).toContain('no completed or partial own-site crawl');
    expect(find(b.report, 'aeo.factual_consistency').label).toBe('DATA_UNAVAILABLE');
    expect(allClaims(b.report).some((c) => c.id === 'aeo.eligibility')).toBe(false);
    const n = await buildMonthlyReport(ctx, { statuses: null, aeo: null, persist: false });
    expect(find(n.report, 'aeo.pages').text).toContain('not collected for this report');
  });

  it('the weekly report has no AEO section and the monthly report has no internal-links section', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedAeoCrawl(ctx);
    const w = await buildWeeklyReport(ctx, { statuses: null, persist: false });
    const m = await buildMonthlyReport(ctx, { statuses: null, persist: false });
    expect(w.report.sections.map((s) => s.key)).not.toContain('aeo');
    expect(m.report.sections.map((s) => s.key)).not.toContain('internal_links');
  });
});
