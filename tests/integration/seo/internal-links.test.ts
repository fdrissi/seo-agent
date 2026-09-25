import { afterEach, describe, expect, it } from 'vitest';
import { defaultPhrases, defaultPhrasesDetailed, findPassage, findPotentialOrphans, suggestInternalLinks } from '../../../src/seo/internal-links.js';
import { buildComparisonInputs } from '../../../src/seo/competitive.js';
import { UrlReconciler } from '../../../src/seo/reconcile.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import { daily, PROPERTY, SeoSeeder } from '../../fixtures/seo/seed.js';

let ctx: TestContext;
afterEach(() => ctx?.cleanup());
const HOST = 'https://www.example.test';

/** Synthetic site; `property` configures google.searchConsoleProperty (default: the seeder's synthetic property). */
function setup(opts: { property?: string | null } = {}) {
  ctx = createTestContext({ config: testSiteConfig({ google: { searchConsoleProperty: opts.property === undefined ? PROPERTY : opts.property } }) });
  return new SeoSeeder(ctx.db, ctx.siteId);
}

function text(t: string): string {
  return ctx.raw.save({ siteId: ctx.siteId, provider: 'crawler', kind: 'text', payload: { text: t } });
}

describe('internal-link suggestions', () => {
  it('suggests {source, destination, passage, anchor, reason} from crawl text and skips existing links', () => {
    const seed = setup();
    const crawl = seed.crawl('own_site', { pagesFetched: 4, pagesAttempted: 4 });
    const blog = seed.crawlResult(crawl, { requestedUrl: `${HOST}/blog/choosing`, textRef: text('Choosing well matters. Many readers ask about widget sizing charts before buying. Measure twice.') });
    const faq = seed.crawlResult(crawl, { requestedUrl: `${HOST}/faq`, textRef: text('Our widget sizing charts are updated yearly.') });
    seed.crawlResult(crawl, { requestedUrl: `${HOST}/about`, textRef: text('We started in a garage.') });
    seed.crawlResult(crawl, { requestedUrl: `${HOST}/sizing`, textRef: text('Widget sizing charts for every model.'), headings: [{ level: 1, text: 'Widget sizing charts' }] });
    seed.internalLink(crawl, faq, `${HOST}/sizing`, 'sizing');
    seed.gscPage(daily('2026-09-01', '2026-09-07', (date) => ({ date, page: `${HOST}/sizing`, clicks: 5, impressions: 100, position: 6 })));
    seed.gscQuery(daily('2026-09-01', '2026-09-07', (date) => ({ date, page: `${HOST}/sizing`, query: 'widget sizing charts', clicks: 4, impressions: 80, position: 6 })));
    const rec = new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock);
    rec.run();
    const dest = rec.resolve(`${HOST}/sizing`) as { pageId: string; pageUrl: string };
    const out = suggestInternalLinks(ctx.db, ctx.raw, ctx.siteId, { destinations: [{ pageId: dest.pageId, url: dest.pageUrl }] });
    expect(out.suggestions).toHaveLength(1);
    const s = out.suggestions[0]!;
    expect(s.sourcePage.url).toBe(`${HOST}/blog/choosing`);
    expect(s.destination.url).toBe(`${HOST}/sizing`);
    expect(s.proposedAnchor).toBe('widget sizing charts');
    expect(s.passage).toBe('Many readers ask about widget sizing charts before buying.');
    expect(s.reason).toMatch(/does not link/);
    expect(s.phraseOrigin).toBe('gsc_query');
    expect(out.note).toMatch(/not authority scores/);
    void blog;
  });

  it('sums phrase impressions only within the configured property, search type, and unsegmented rows', () => {
    const OTHER_PROPERTY = 'https://www.example.test/';
    const seed = setup();
    const crawl = seed.crawl('own_site', { pagesFetched: 2, pagesAttempted: 2 });
    seed.crawlResult(crawl, { requestedUrl: `${HOST}/blog`, textRef: text('Readers compare every size table. Some want a sizing guide first. Others ask for widget sizing charts.') });
    seed.crawlResult(crawl, { requestedUrl: `${HOST}/sizing`, textRef: text('Sizing.') });
    const page = `${HOST}/sizing`;
    // Configured slice (sc-domain property, web, unsegmented): 7 days x 20 = 140 impressions.
    seed.gscQuery(daily('2026-09-01', '2026-09-07', (date) => ({ date, page, query: 'widget sizing charts', clicks: 2, impressions: 20, position: 5 })));
    // Country/device rows of the same traffic (sync --segments country,device): must not be added in.
    seed.gscQuery(daily('2026-09-01', '2026-09-07', (date) => ({ date, page, query: 'widget sizing charts', clicks: 1, impressions: 15, position: 5, segmentKey: 'country=usa;device=MOBILE' })));
    seed.gscQuery(daily('2026-09-01', '2026-09-07', (date) => ({ date, page, query: 'sizing guide', clicks: 9, impressions: 900, position: 5, segmentKey: 'country=usa;device=DESKTOP' })));
    // A second property and another search type for the same page: must not be added in either.
    seed.gscQuery(daily('2026-09-01', '2026-09-07', (date) => ({ date, page, query: 'size table', clicks: 9, impressions: 800, position: 5, property: OTHER_PROPERTY })));
    seed.gscQuery(daily('2026-09-01', '2026-09-07', (date) => ({ date, page, query: 'widget sizing charts', clicks: 9, impressions: 700, position: 5, searchType: 'image' })));
    const rec = new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock);
    rec.run();
    const dest = rec.resolve(page) as { pageId: string; pageUrl: string };
    // The fixture exercises the defect: summing every current, final row of the page mixes all of the above.
    const unscoped = ctx.db.get<{ s: number }>("SELECT SUM(impressions) AS s FROM gsc_page_query_daily WHERE site_id = ? AND page_id = ? AND query = 'widget sizing charts' AND is_current = 1 AND is_final = 1", [ctx.siteId, dest.pageId])!.s;
    expect(unscoped).toBe(140 + 105 + 4900);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM gsc_page_query_daily WHERE site_id = ? AND page_id = ? AND (property <> ? OR segment_key <> '')", [ctx.siteId, dest.pageId, PROPERTY])!.n).toBe(21);
    const phrases = defaultPhrases(ctx.db, ctx.siteId, dest.pageId, crawl).filter((p) => p.origin === 'gsc_query');
    expect(phrases.map((p) => [p.text, p.weight])).toEqual([['widget sizing charts', 140]]);
    const out = suggestInternalLinks(ctx.db, ctx.raw, ctx.siteId, { destinations: [{ pageId: dest.pageId, url: dest.pageUrl }] });
    expect(out.suggestions).toHaveLength(1);
    expect(out.suggestions[0]!.proposedAnchor).toBe('widget sizing charts');
    expect(out.suggestions[0]!.reason).toMatch(/140 impressions/);
    // Explicit scope: the other property's rows only.
    expect(defaultPhrases(ctx.db, ctx.siteId, dest.pageId, crawl, 5, { property: OTHER_PROPERTY, searchType: 'web' }).filter((p) => p.origin === 'gsc_query').map((p) => [p.text, p.weight])).toEqual([['size table', 5600]]);
  });

  it('uses no Search Console phrases, and says why, when no property is configured', () => {
    const seed = setup({ property: null });
    const crawl = seed.crawl('own_site', { pagesFetched: 2, pagesAttempted: 2 });
    seed.crawlResult(crawl, { requestedUrl: `${HOST}/blog`, textRef: text('Many readers ask about widget sizing charts before buying.') });
    seed.crawlResult(crawl, { requestedUrl: `${HOST}/sizing`, textRef: text('Sizing.'), headings: [{ level: 1, text: 'Sizing charts' }] });
    seed.gscQuery(daily('2026-09-01', '2026-09-07', (date) => ({ date, page: `${HOST}/sizing`, query: 'widget sizing charts', clicks: 4, impressions: 80, position: 6 })));
    const rec = new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock);
    rec.run();
    const dest = rec.resolve(`${HOST}/sizing`) as { pageId: string; pageUrl: string };
    const d = defaultPhrasesDetailed(ctx.db, ctx.siteId, dest.pageId, crawl);
    expect(d.phrases.some((p) => p.origin === 'gsc_query')).toBe(false);
    expect(d.notes.join(' ')).toMatch(/No Search Console property is configured/);
    const out = suggestInternalLinks(ctx.db, ctx.raw, ctx.siteId, { destinations: [{ pageId: dest.pageId, url: dest.pageUrl }] });
    expect(out.notes!.join(' ')).toMatch(/No Search Console property is configured/);
    expect(out.suggestions.map((x) => x.phraseOrigin)).toEqual(['h1']);
  });

  it('reports potential orphans only relative to crawl coverage and never as authority', () => {
    const seed = setup();
    const crawl = seed.crawl('own_site', { status: 'partial', pagesFetched: 2, pagesAttempted: 3, stopReason: 'maxPages' });
    const home = seed.crawlResult(crawl, { requestedUrl: `${HOST}/` });
    seed.crawlResult(crawl, { requestedUrl: `${HOST}/linked` });
    seed.crawlResult(crawl, { requestedUrl: `${HOST}/lonely` });
    seed.internalLink(crawl, home, `${HOST}/linked`, 'Linked');
    seed.gscPage([{ date: '2026-09-01', page: `${HOST}/gsc-only`, clicks: 1, impressions: 10, position: 9 }]);
    new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    const r = findPotentialOrphans(ctx.db, ctx.siteId);
    // Partial crawl (maxPages, frontier not exhausted): pages that could link to /lonely may never have been fetched,
    // so nothing is called a potential orphan; zero-inbound fetched pages are not assessable.
    expect(r.coverageComplete).toBe(false);
    expect(r.potentialOrphans).toEqual([]);
    const na = new Map(r.notAssessable.map((x) => [x.url, x]));
    expect([...na.keys()].sort()).toEqual([`${HOST}/`, `${HOST}/gsc-only`, `${HOST}/lonely`]);
    expect(na.get(`${HOST}/lonely`)!.reason).toMatch(/^not assessable \(inbound sources outside coverage\)/);
    expect(na.get(`${HOST}/lonely`)!.crawledInThisCrawl).toBe(true);
    // A page known only from Search Console is outside the partial crawl's coverage: not assessable.
    expect(na.get(`${HOST}/gsc-only`)!.reason).toMatch(/outside the coverage of partial crawl/);
    expect(na.get(`${HOST}/gsc-only`)!.crawledInThisCrawl).toBe(false);
    expect(r.coverageNote).toMatch(/partial.*2 of 3.*maxPages/);
    expect(r.coverageNote).toMatch(/not assessable/);
    expect(r.metricNote).toMatch(/not an authority score/);
    expect(r.inboundCounts.find((c) => c.url === `${HOST}/linked`)!.inboundInternalLinkCount).toBe(1);
  });

  it('never lists gone (404/410) pages as potential orphans', () => {
    const seed = setup();
    const crawl = seed.crawl('own_site', { status: 'completed', pagesFetched: 2, pagesAttempted: 3, stopReason: 'frontier exhausted' });
    const home = seed.crawlResult(crawl, { requestedUrl: `${HOST}/` });
    seed.crawlResult(crawl, { requestedUrl: `${HOST}/linked` });
    seed.crawlResult(crawl, { requestedUrl: `${HOST}/removed`, status: 404 });
    seed.internalLink(crawl, home, `${HOST}/linked`, 'Linked');
    seed.gscPage([{ date: '2026-09-01', page: `${HOST}/orphan`, clicks: 1, impressions: 10, position: 9 }]);
    new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    ctx.db.run("UPDATE pages SET lifecycle = 'gone' WHERE site_id = ? AND url = ?", [ctx.siteId, `${HOST}/removed`]);
    const r = findPotentialOrphans(ctx.db, ctx.siteId);
    const urls = r.potentialOrphans.map((o) => o.url);
    expect(urls).not.toContain(`${HOST}/removed`);
    expect(urls).toContain(`${HOST}/orphan`);
    expect(r.inboundCounts.some((c) => c.url === `${HOST}/removed`)).toBe(false);
  });

  it('after a completed crawl, a known page the crawl never reached is a potential orphan', () => {
    const seed = setup();
    const crawl = seed.crawl('own_site', { status: 'completed', pagesFetched: 2, pagesAttempted: 2, stopReason: 'frontier exhausted' });
    const home = seed.crawlResult(crawl, { requestedUrl: `${HOST}/` });
    seed.crawlResult(crawl, { requestedUrl: `${HOST}/linked` });
    seed.internalLink(crawl, home, `${HOST}/linked`, 'Linked');
    seed.gscPage([{ date: '2026-09-01', page: `${HOST}/gsc-only`, clicks: 1, impressions: 10, position: 9 }]);
    new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    const r = findPotentialOrphans(ctx.db, ctx.siteId);
    expect(r.coverageComplete).toBe(true);
    expect(r.notAssessable).toEqual([]);
    const gscOnly = r.potentialOrphans.find((o) => o.url === `${HOST}/gsc-only`)!;
    expect(gscOnly.crawledInThisCrawl).toBe(false);
    expect(gscOnly.note).toMatch(/completed crawl never reached it/);
  });

  it('is honest when no crawl exists', () => {
    setup();
    expect(suggestInternalLinks(ctx.db, ctx.raw, ctx.siteId, { destinations: [] }).note).toMatch(/No completed own-site crawl/);
    expect(findPotentialOrphans(ctx.db, ctx.siteId).coverageNote).toMatch(/cannot be assessed/);
  });

  it('finds whole-word, case-insensitive passages across scripts', () => {
    expect(findPassage('Ostke vidinat. Vidina hind on madal!', 'vidina hind')).toEqual({ passage: 'Vidina hind on madal!', anchor: 'Vidina hind' });
    expect(findPassage('widgetsizing', 'widget')).toBeNull();
  });
});

describe('competitor comparison inputs from the database', () => {
  it('selects competitor pages from the latest SERP snapshot and compares with our crawled page', () => {
    const seed = setup();
    const own = seed.crawl('own_site');
    seed.crawlResult(own, { requestedUrl: `${HOST}/guide`, headings: [{ level: 2, text: 'Widget durability tests' }], textRef: text('We tested 30 widgets. For example, steel lasted longest.') });
    const comp = seed.crawl('competitor');
    seed.crawlResult(comp, { requestedUrl: 'https://a.example.invalid/w', headings: [{ level: 2, text: 'Widget materials' }] });
    seed.crawlResult(comp, { requestedUrl: 'https://b.example.invalid/w', headings: [{ level: 2, text: 'Materials used' }] });
    ctx.db.run("INSERT INTO serp_snapshots (id, site_id, query, provider, device, parameter_hash, is_sandbox, collected_at) VALUES ('snap1', ?, 'widget guide', 'fixture', 'desktop', 'h', 0, ?)", [ctx.siteId, seed.now]);
    for (const [i, u] of ['https://a.example.invalid/w', 'https://b.example.invalid/w'].entries()) {
      ctx.db.run("INSERT INTO serp_results (snapshot_id, site_id, result_type, rank_absolute, url, is_own_site) VALUES ('snap1', ?, 'organic', ?, ?, 0)", [ctx.siteId, i + 1, u]);
    }
    const inputs = buildComparisonInputs(ctx.db, ctx.raw, ctx.siteId, { ourUrl: `${HOST}/guide`, query: 'widget guide' });
    expect(inputs.competitors.map((c) => c.url)).toEqual(['https://a.example.invalid/w', 'https://b.example.invalid/w']);
    expect(inputs.topicCoverage.gapTopics).toEqual(['materials']);
    expect(inputs.ourAdvantages.join(' ')).toMatch(/original data/);
    expect(inputs.ourPage!.textAvailable).toBe(true);
  });
});
