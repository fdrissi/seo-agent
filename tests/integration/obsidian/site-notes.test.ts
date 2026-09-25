import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkVault } from '../../../src/obsidian/check.js';
import { parseNote } from '../../../src/obsidian/frontmatter.js';
import { renderAll } from '../../../src/obsidian/notes.js';
import { createVaultWriter } from '../../../src/obsidian/writer.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { SeoSeeder } from '../../fixtures/seo/seed.js';

/**
 * Page notes and the 09 AI Search note show page-level AEO checks, internal-link
 * suggestions, and potential orphans (relative to crawl coverage).
 * SYNTHETIC fixtures on the reserved www.example.test host.
 */

const HOST = 'https://www.example.test';
let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

function text(c: TestContext, t: string): string {
  return c.raw.save({ siteId: c.siteId, provider: 'crawler', kind: 'text', payload: { text: t, _synthetic: true } });
}

function setup(opts: { crawl?: 'completed' | 'partial' | 'none' } = {}) {
  ctx = createTestContext();
  const c = ctx;
  const seed = new SeoSeeder(c.db, c.siteId);
  const pricing = seed.page(`${HOST}/pricing`);
  const guide = seed.page(`${HOST}/blog/guide`);
  const about = seed.page(`${HOST}/about`);
  const never = seed.page(`${HOST}/never-crawled`);
  const now = '2026-09-20T00:00:00.000Z';
  c.db.run(`INSERT INTO opportunities (id, site_id, kind, route, page_id, score, status, created_at, updated_at) VALUES ('opp_syn_pricing', ?, 'page', 'CTR_OPPORTUNITY', ?, 0.8, 'candidate', ?, ?)`, [c.siteId, pricing, now, now]);
  let crawl: string | null = null;
  if (opts.crawl !== 'none') {
    const partial = opts.crawl === 'partial';
    crawl = seed.crawl('own_site', { status: partial ? 'partial' : 'completed', pagesFetched: 3, pagesAttempted: partial ? 8 : 3, ...(partial ? { stopReason: 'page_cap' } : {}) });
    const rPricing = seed.crawlResult(crawl, {
      requestedUrl: `${HOST}/pricing`,
      pageId: pricing,
      title: 'Pricing',
      headings: [{ level: 1, text: 'Widget pricing plans' }, { level: 2, text: 'Overview' }],
      textRef: text(c, 'Widget pricing plans\nEvery plan includes support.\nOverview\nAs mentioned above, 45% of teams pick the middle plan.'),
    });
    seed.crawlResult(crawl, { requestedUrl: `${HOST}/blog/guide`, pageId: guide, title: 'Guide', headings: [{ level: 1, text: 'Buying guide' }], textRef: text(c, 'Buying guide\nCompare our widget pricing plans before you buy, according to our published price list.') });
    const rAbout = seed.crawlResult(crawl, { requestedUrl: `${HOST}/about`, pageId: about, title: 'About', textRef: text(c, 'About us\nWe are a small synthetic team.') });
    seed.internalLink(crawl, rPricing, `${HOST}/blog/guide`, 'guide', { sourcePageId: pricing, targetPageId: guide });
    seed.internalLink(crawl, rAbout, `${HOST}/pricing`, 'pricing', { sourcePageId: about, targetPageId: pricing });
  }
  const writer = createVaultWriter(c);
  const read = (rel: string) => readFileSync(path.join(writer.vaultDir, ...rel.split('/')), 'utf8');
  const region = (rel: string) => parseNote(read(rel)).generatedRegion!;
  return { c, writer, read, region, crawl, ids: { pricing, guide, about, never } };
}

function sectionOf(region: string, heading: string): string {
  const start = region.indexOf(`## ${heading}`);
  if (start < 0) throw new Error(`section ${heading} not found`);
  const next = region.indexOf('\n## ', start + 3);
  return region.slice(start, next < 0 ? undefined : next);
}

describe('page notes: internal links and AEO', () => {
  it('shows link suggestions (source, destination, passage, anchor, reason) in both directions and orphan status relative to the crawl', () => {
    const { c, writer, region, crawl } = setup();
    const r = renderAll(c, writer);
    expect(r.errors).toEqual([]);

    const pricing = sectionOf(region('02 Website/Pages/Pricing.md'), 'Internal links');
    expect(pricing).toContain(`Not an orphan in crawl \`${crawl}\` (completed; 3 of 3 attempted page(s) fetched): 1 distinct crawled page(s) link here.`);
    expect(pricing).toContain('never an authority score');
    expect(pricing).toContain('SYNTHETIC crawl');
    expect(pricing).toContain('### Suggested links to this page');
    expect(pricing).toContain('| Source page | Proposed anchor | Passage | Reason |');
    expect(pricing).toContain('[[02 Website/Pages/Blog - guide\\|');
    expect(pricing).toContain('widget pricing plans');
    expect(pricing).toContain('Compare our widget pricing plans before you buy, according to our published price list.');
    expect(pricing).toContain('does not link to the destination');

    const guide = sectionOf(region('02 Website/Pages/Blog - guide.md'), 'Internal links');
    expect(guide).toContain('### Suggested links from this page');
    expect(guide).toContain('[[02 Website/Pages/Pricing\\|');
    // The guide is not a priority destination this render: stated, not shown as "none".
    expect(guide).toContain('Not computed for this page');
    expect(guide).toContain('analyze links --url https://www.example.test/blog/guide');

    const about = sectionOf(region('02 Website/Pages/About.md'), 'Internal links');
    expect(about).toContain('**Potential orphan** relative to crawl');
    expect(about).toContain("Links from outside this crawl's coverage are unknown.");

    const check = checkVault({ db: c.db, siteId: c.siteId, vaultDir: writer.vaultDir });
    expect(check.issues.filter((i) => i.severity === 'error')).toEqual([]);
    // Deterministic: a second render changes nothing.
    const again = renderAll(c, writer);
    expect(again.counts.created + again.counts.updated + again.counts.conflict).toBe(0);
  });

  it('shows every spec-17 AEO criterion on the page note; factual consistency is DATA UNAVAILABLE, never "ok"', () => {
    const { c, writer, region } = setup();
    renderAll(c, writer);
    const aeo = sectionOf(region('02 Website/Pages/Pricing.md'), 'AI search readiness (AEO, heuristic)');
    for (const criterion of ['Clear answers', 'Descriptive headings', 'Self-contained sections', 'Factual consistency', 'Useful evidence', 'Crawl / index / snippet eligibility']) expect(aeo).toContain(`| ${criterion} |`);
    expect(aeo).toMatch(/\| Factual consistency \| DATA UNAVAILABLE \| DATA UNAVAILABLE: not assessed/);
    // No Search Console query rows for the page: the answer check is unknown, not ok.
    expect(aeo).toMatch(/\| Clear answers \| unknown \| DATA\\?_UNAVAILABLE: no Search Console query rows/);
    // "As mentioned above" -> self-contained sections to review; a generic "Overview" heading -> headings to review.
    expect(aeo).toMatch(/\| Self-contained sections \| \*\*review\*\* \|/);
    expect(aeo).toMatch(/\| Descriptive headings \| \*\*review\*\* \|/);
    expect(aeo).toContain('crawl allowed');
    expect(aeo).toContain('SYNTHETIC crawl');
    expect(aeo).toContain('HEURISTIC');
    expect(aeo).toContain('not Google ranking rules');
    const never = sectionOf(region('02 Website/Pages/Never crawled.md'), 'AI search readiness (AEO, heuristic)');
    expect(never).toContain('DATA UNAVAILABLE: this page has no own-site crawl result');
  });

  it('"Suggested links from this page" says None only for a page whose crawled text was searched; otherwise Not assessable (C5-08)', () => {
    const { c, writer, region, crawl, ids } = setup();
    const seed = new SeoSeeder(c.db, c.siteId);
    // Pages the suggestion run cannot search: fetched with an error status, noindex, no stored text, and stored text that cannot be loaded.
    const missing = seed.page(`${HOST}/gone-missing`);
    const noindex = seed.page(`${HOST}/hidden-page`);
    const noText = seed.page(`${HOST}/no-text`);
    const lostText = seed.page(`${HOST}/lost-text`);
    seed.crawlResult(crawl!, { requestedUrl: `${HOST}/gone-missing`, pageId: missing, status: 404, textRef: text(c, 'Widget pricing plans are listed here.') });
    seed.crawlResult(crawl!, { requestedUrl: `${HOST}/hidden-page`, pageId: noindex, metaRobots: 'noindex, follow', textRef: text(c, 'Our widget pricing plans, again.') });
    seed.crawlResult(crawl!, { requestedUrl: `${HOST}/no-text`, pageId: noText, textRef: null });
    seed.crawlResult(crawl!, { requestedUrl: `${HOST}/lost-text`, pageId: lostText, textRef: 'raw_synthetic_does_not_exist' });
    // A redirect row toward the about page is skipped as a source under the about URL ("status 301"); the about page itself was still searched.
    seed.crawlResult(crawl!, { requestedUrl: `${HOST}/old-about`, finalUrl: `${HOST}/about`, status: 301 });
    const r = renderAll(c, writer);
    expect(r.errors).toEqual([]);
    const pathOf = (pageId: string) => c.db.get<{ rel_path: string }>('SELECT rel_path FROM vault_notes WHERE site_id = ? AND note_id = ?', [c.siteId, pageId])!.rel_path;
    const outbound = (pageId: string) => {
      const section = sectionOf(region(pathOf(pageId)), 'Internal links');
      return section.slice(section.indexOf('### Suggested links from this page'));
    };
    const notAssessable = `Not assessable: this page has no crawled text in crawl \`${crawl}\`.`;
    for (const pageId of [ids.never, missing, noindex, noText, lostText]) {
      expect({ pageId, text: outbound(pageId) }).toEqual({ pageId, text: expect.stringContaining(notAssessable) });
      expect(outbound(pageId)).not.toContain('None');
    }
    // A crawled page with searchable text and no match: "None" is an observation for this crawl.
    expect(outbound(ids.about)).toContain(`None toward the 1 other priority page(s) of this render in crawl \`${crawl}\``);
    // The only priority page is never compared with itself.
    expect(outbound(ids.pricing)).toContain('None: this page is the only priority page of this render');
    // The guide has a real suggestion toward the pricing page.
    expect(outbound(ids.guide)).toContain('[[02 Website/Pages/Pricing\\|');
  });

  it('"None" says so when a priority page reached its suggestion limit before this page was searched', () => {
    const { c, writer, region, crawl, ids } = setup();
    const seed = new SeoSeeder(c.db, c.siteId);
    // Five sources sorted before the guide fill the pricing page's limit, so the guide is never searched for it.
    for (const n of [1, 2, 3, 4, 5]) {
      const id = seed.page(`${HOST}/a${n}`);
      seed.crawlResult(crawl!, { requestedUrl: `${HOST}/a${n}`, pageId: id, textRef: text(c, `Article ${n}: see our widget pricing plans.`) });
    }
    renderAll(c, writer);
    const guide = sectionOf(region('02 Website/Pages/Blog - guide.md'), 'Internal links');
    const outbound = guide.slice(guide.indexOf('### Suggested links from this page'));
    expect(outbound).toContain('None toward the 1 other priority page(s) of this render');
    expect(outbound).toContain('1 of them already had the maximum of 5 suggestions, so this page may not have been searched for them.');
  });

  it('a partial crawl makes orphan status "not assessable"; no crawl makes both sections DATA UNAVAILABLE', () => {
    const partial = setup({ crawl: 'partial' });
    renderAll(partial.c, partial.writer);
    expect(sectionOf(partial.region('02 Website/Pages/About.md'), 'Internal links')).toContain('Orphan status not assessable:');
    expect(sectionOf(partial.region('02 Website/Pages/About.md'), 'Internal links')).not.toContain('Potential orphan**');
    partial.c.cleanup();
    ctx = undefined;

    const none = setup({ crawl: 'none' });
    renderAll(none.c, none.writer);
    const page = none.region('02 Website/Pages/Pricing.md');
    expect(sectionOf(page, 'Internal links')).toContain('DATA UNAVAILABLE: no completed own-site crawl');
    expect(sectionOf(page, 'AI search readiness (AEO, heuristic)')).toContain('DATA UNAVAILABLE');
    expect(sectionOf(none.region('09 AI Search/AI Citation Checks.md'), 'Page-level AEO assessment (heuristic)')).toContain('DATA UNAVAILABLE: no completed own-site crawl yet');
  });
});

describe('09 AI Search note: page-level AEO assessment', () => {
  it('lists the assessed pages of the latest own-site crawl with links to their page notes and the six criteria', () => {
    const { c, writer, read, region, crawl } = setup();
    renderAll(c, writer);
    const note = parseNote(read('09 AI Search/AI Citation Checks.md'));
    expect(note.frontmatter.source_ids).toContain(crawl);
    expect(note.frontmatter.synthetic).toBe(true);
    const aeo = sectionOf(region('09 AI Search/AI Citation Checks.md'), 'Page-level AEO assessment (heuristic)');
    expect(aeo).toContain(`3 page(s) of own-site crawl \`${crawl}\` (SYNTHETIC crawl)`);
    expect(aeo).toContain('| Page | Clear answers | Headings | Sections | Evidence | Factual consistency | Indexing | Snippet | AI features |');
    expect(aeo).toContain('[[02 Website/Pages/Pricing\\|');
    expect(aeo).toContain('Factual consistency: DATA UNAVAILABLE: not assessed');
    expect(aeo).toMatch(/Self-contained sections: 2 ok, 1 to review, 0 unknown/);
    expect(aeo).toContain('not assessed |');
    // The AI-citation part of the note is unchanged: still explicit about missing checks.
    expect(note.generatedRegion).toContain('DATA UNAVAILABLE: no AI citation checks recorded.');
  });
});
