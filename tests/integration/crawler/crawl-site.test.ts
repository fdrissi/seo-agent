import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { crawlPage, crawlSite } from '../../../src/crawler/crawl.js';
import { runTechnicalChecks } from '../../../src/crawler/checks.js';
import { searchEligibilityForResult } from '../../../src/crawler/eligibility.js';
import { crawlerStatus } from '../../../src/crawler/status.js';
import { fixtureSiteTransport } from '../../../src/crawler/transport.js';
import { SafeFetcher } from '../../../src/crawler/fetch.js';
import type { HttpTransport } from '../../../src/crawler/transport.js';
import { SsrfGuard, type Resolver } from '../../../src/security/ssrf.js';
import { levelForState } from '../../../src/setup/doctor.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import { fakeFetch } from '../../helpers/fake-fetch.js';
import { FAKE_PUBLIC_IP, FIXTURES, fixture, mapResolver, send, startServer, testFetcher, type TestServer } from './helpers.js';

let server: TestServer;
let robotsMode: 'normal' | 'disallow_all' | 'error' = 'normal';
let missingFixed = false;

const PAGES: Record<string, string> = {
  '/': 'site/index.html',
  '/about': 'site/about.html',
  '/blog/': 'site/blog.html',
  '/blog/post-1': 'site/post-1.html',
  '/dup-a': 'site/dup-a.html',
  '/dup-b': 'site/dup-b.html',
  '/noindex-page': 'site/noindex.html',
  '/canonical-conflict': 'site/canonical-conflict.html',
  '/de/': 'site/de.html',
  '/members': 'site/members.html',
  '/login': 'site/login.html',
  '/sitemap-only': 'site/sitemap-only.html',
};

beforeAll(async () => {
  server = await startServer((req, res, url) => {
    const origin = server.origin();
    const sub = (s: string) => s.replaceAll('{{ORIGIN}}', origin);
    const p = url.pathname;
    if (p === '/robots.txt') {
      if (robotsMode === 'error') return send(res, 500, 'oops', { 'content-type': 'text/plain' });
      if (robotsMode === 'disallow_all') return send(res, 200, 'User-agent: *\nDisallow: /\n', { 'content-type': 'text/plain' });
      return send(res, 200, sub(fixture('site/robots.txt')), { 'content-type': 'text/plain' });
    }
    if (p === '/sitemap_index.xml' || p === '/sitemap-pages.xml') return send(res, 200, sub(fixture(`site${p}`)), { 'content-type': 'application/xml' });
    if (p === '/old-page') return send(res, 301, '', { location: '/old-2' });
    if (p === '/old-2') return send(res, 302, '', { location: `${origin}/about` });
    if (p === '/account') return send(res, 302, '', { location: '/login' });
    if (p === '/missing') return missingFixed ? send(res, 200, '<html><head><title>Missing page now restored</title></head><body><h1>Restored</h1></body></html>') : send(res, 404, 'not found');
    if (p === '/gone') return send(res, 410, 'gone');
    if (p === '/offsite-start') return send(res, 301, '', { location: `http://other.test:${server.port}/` });
    if (p === '/blog/post-2') return send(res, 200, '<html><head><title>Second synthetic post</title></head><body><h1>Second</h1><p><a href="/blog/post-3">third</a></p></body></html>');
    if (p === '/big') return send(res, 200, `<html><body>${'z'.repeat(300_000)}</body></html>`);
    if (p.startsWith('/calendar/')) {
      const [, , y, m] = p.split('/');
      const next = Number(m) + 1;
      return send(res, 200, `<html><head><title>Calendar ${y}-${m}</title></head><body><h1>Events</h1><a href="/calendar/${y}/${next}">next month</a> <a href="/calendar/${Number(y) + 1}/${m}">next year</a></body></html>`);
    }
    if (p === '/filter') {
      const links = ['blue', 'green', 'pink', 'teal', 'gold'].map((c) => `<a href="/filter?color=${c}&size=${c.length}">${c}</a>`).join(' ');
      return send(res, 200, `<html><head><title>Filter ${url.search}</title></head><body><h1>Filter</h1>${links}</body></html>`);
    }
    if (p === '/canonical-conflict') return send(res, 200, sub(fixture(PAGES[p]!)), { link: `<${origin}/about>; rel="canonical"` });
    const file = PAGES[p];
    if (file) return send(res, 200, sub(fixture(file)));
    return send(res, 404, 'not found');
  });
});

afterAll(async () => {
  await server.close();
});

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
  robotsMode = 'normal';
  missingFixed = false;
});

function siteCtx(crawl: Record<string, unknown> = {}, extra: { features?: Record<string, boolean>; dryRun?: boolean; offline?: boolean } = {}): TestContext {
  const config = testSiteConfig({
    site: { id: 'test-site', businessName: 'Test Co (synthetic)', url: `${server.origin()}/`, allowedHostnames: ['site.test'] },
    crawl: { excludedPaths: ['/admin'], protectedPaths: ['/noindex-page'], maxPages: 60, maxDepth: 6, requestDelayMs: 0, maxBytes: 200_000, timeoutMs: 3_000, ...crawl },
    ...(extra.features ? { features: extra.features } : {}),
  });
  ctx = createTestContext({ config, ...(extra.offline ? {} : { fetch: fakeFetch([]) }), ...(extra.dryRun ? { dryRun: true } : {}) });
  return ctx;
}

const fetcher = () => testFetcher({ resolver: mapResolver({ 'site.test': '127.0.0.1', 'offsite.example.com': FAKE_PUBLIC_IP }) });
const TRAPS = { maxCalendarVariantsPerTemplate: 3, maxQueryVariantsPerPath: 3 };

function issues(c: TestContext) {
  return c.db.all<{ url: string; issue_type: string; severity: string; is_heuristic: number; confirmed: number; status: string; detail_json: string }>('SELECT * FROM technical_issues WHERE site_id = ? ORDER BY url, issue_type', [c.siteId]);
}

describe('crawlSite against a synthetic local site', () => {
  it('crawls within limits, respects robots/exclusions/login walls/traps, and records everything honestly', async () => {
    const c = siteCtx();
    const r = await crawlSite(c, { fetcher: fetcher(), trapLimits: TRAPS });
    const o = server.origin();
    expect(r.status).toBe('completed');
    expect(r.crawlId).toBeTruthy();
    expect(r.transport).toBe('pinned');

    // robots.txt respected: disallowed paths are never requested.
    expect(server.hits.some((h) => h.path.startsWith('/private/'))).toBe(false);
    // Excluded paths and links behind a login wall are never requested.
    expect(server.hits.some((h) => h.path.startsWith('/admin'))).toBe(false);
    expect(server.hits.some((h) => h.path.startsWith('/members/secret-area'))).toBe(false);
    expect(server.hits.some((h) => h.path.startsWith('/login'))).toBe(false);
    // Non-HTML links and images are not fetched.
    expect(server.hits.some((h) => h.path.endsWith('.pdf') || h.path.startsWith('/img/'))).toBe(false);

    const rows = c.db.all<{ requested_url: string; status_code: number | null; blocked_reason: string | null; final_url: string | null; redirect_chain_json: string | null; in_sitemap: number | null; text_ref: string | null; title: string | null; word_count: number | null; error: string | null }>(
      'SELECT * FROM crawl_results WHERE crawl_id = ? AND site_id = ?',
      [r.crawlId, c.siteId],
    );
    const row = (p: string) => rows.find((x) => x.requested_url === `${o}${p}`)!;
    expect(row('/private/secret').blocked_reason).toBe('robots');
    expect(row('/private/listed-but-disallowed')).toMatchObject({ blocked_reason: 'robots', in_sitemap: 1 });
    expect(row('/admin/panel').blocked_reason).toBe('excluded');
    expect(row('/account')).toMatchObject({ blocked_reason: 'login_required', status_code: 302 });
    expect(row('/members').blocked_reason).toBe('login_required');
    expect(row('/big').blocked_reason).toBe('too_large');
    expect(row('/missing').status_code).toBe(404);
    // Redirect chain recorded on the requesting URL.
    const old = row('/old-page');
    expect(old.status_code).toBe(301);
    expect(old.final_url).toBe(`${o}/about`);
    expect(JSON.parse(old.redirect_chain_json!)).toHaveLength(2);
    // Sitemap-only page discovered (entities decoded) and flagged in_sitemap.
    expect(row('/sitemap-only?a=1&b=2')).toMatchObject({ status_code: 200, in_sitemap: 1 });
    // Crawler traps bounded.
    const traps = rows.filter((x) => x.blocked_reason === 'crawl_trap');
    expect(traps.length).toBeGreaterThan(0);
    expect(rows.filter((x) => x.requested_url.includes('/calendar/') && x.status_code === 200)).toHaveLength(3);
    expect(rows.filter((x) => x.requested_url.includes('/filter?') && x.status_code === 200).length).toBeLessThanOrEqual(3);
    expect(r.trapHits).toBe(traps.length);

    // Extraction stored; text lives in the raw store, not in the DB.
    const home = row('/');
    expect(home.title).toBe('Synthetic Widgets Co - Home');
    expect(home.word_count).toBeGreaterThan(20);
    const text = c.raw.load<{ text: string }>(home.text_ref!);
    expect(text!.text).toContain('We make synthetic widgets for testing crawlers.');

    // Robots + sitemap records.
    expect(r.robots[0]).toMatchObject({ state: 'parsed', sitemaps: [`${o}/sitemap_index.xml`] });
    expect(r.sitemaps).toMatchObject({ parsed: 2 });
    const smaps = c.db.all<{ url: string; status: string; reason: string | null }>('SELECT url, status, reason FROM crawl_sitemaps WHERE crawl_id = ?', [r.crawlId]);
    expect(smaps.find((s) => s.url.startsWith('https://offsite.example.com'))!.reason).toMatch(/outside allowedHostnames/);
    expect(c.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM crawl_robots WHERE crawl_id = ?', [r.crawlId])!.n).toBe(1);

    // Pages + internal links.
    const pages = c.db.all<{ url: string; lifecycle: string; is_protected: number; first_source: string }>('SELECT url, lifecycle, is_protected, first_source FROM pages WHERE site_id = ?', [c.siteId]);
    expect(pages.find((p) => p.url === `${o}/`)!.lifecycle).toBe('active');
    expect(pages.find((p) => p.url === `${o}/old-page`)!.lifecycle).toBe('redirected');
    expect(pages.find((p) => p.url === `${o}/missing`)!.lifecycle).toBe('gone');
    expect(pages.find((p) => p.url === `${o}/noindex-page`)!.is_protected).toBe(1);
    expect(pages.some((p) => p.url.includes('/admin'))).toBe(false);
    const links = c.db.all<{ target_url: string; target_page_id: string | null; anchor_text: string; is_nofollow: number; context_snippet: string | null }>('SELECT * FROM internal_links WHERE crawl_id = ?', [r.crawlId]);
    const toAbout = links.find((l) => l.target_url === `${o}/about` && l.anchor_text === 'about us')!;
    expect(toAbout.target_page_id).toBeTruthy();
    expect(toAbout.context_snippet).toContain('We make synthetic widgets');
    expect(links.some((l) => l.target_url.startsWith('https://external.example.com'))).toBe(false);

    // Crawl row.
    const crawl = c.db.get<{ status: string; pages_fetched: number; pages_blocked: number; is_synthetic: number; finished_at: string | null }>('SELECT * FROM crawls WHERE id = ?', [r.crawlId]);
    expect(crawl).toMatchObject({ status: 'completed', is_synthetic: 0 });
    expect(crawl!.finished_at).toBeTruthy();
    expect(crawl!.pages_blocked).toBeGreaterThan(0);

    // Technical checks.
    const all = issues(c);
    const find = (p: string, t: string) => all.find((i) => i.url === `${o}${p}` && i.issue_type === t);
    expect(find('/missing', 'broken_internal_link')).toMatchObject({ severity: 'high', confirmed: 1, is_heuristic: 0 });
    expect(JSON.parse(find('/missing', 'broken_internal_link')!.detail_json).linkCount).toBeGreaterThanOrEqual(2);
    expect(find('/old-page', 'redirect_chain')).toMatchObject({ confirmed: 0 });
    expect(find('/old-page', 'internal_link_to_redirect')).toBeTruthy();
    expect(find('/noindex-page', 'accidental_noindex')).toMatchObject({ severity: 'critical', confirmed: 1 });
    expect(JSON.parse(find('/noindex-page', 'accidental_noindex')!.detail_json).reasons).toEqual(expect.arrayContaining(['protected page', 'listed in the sitemap', 'linked internally']));
    expect(find('/private/listed-but-disallowed', 'robots_blocked_in_sitemap')).toMatchObject({ confirmed: 1 });
    expect(find('/gone', 'sitemap_url_not_ok')).toMatchObject({ confirmed: 1 });
    expect(find('/canonical-conflict', 'canonical_multiple')).toBeTruthy();
    expect(find('/canonical-conflict', 'canonical_header_conflict')).toBeTruthy();
    const titleLen = find('/about', 'title_length')!;
    expect(titleLen).toMatchObject({ is_heuristic: 1, confirmed: 0, severity: 'info' });
    expect(JSON.parse(titleLen.detail_json).label).toMatch(/EDITORIAL HEURISTIC: not a Google ranking rule/);
    expect(find('/about', 'missing_meta_description')).toBeTruthy();
    const dupA = find('/dup-a', 'suspected_duplicate_content')!;
    expect(dupA).toMatchObject({ confirmed: 0 });
    expect(JSON.parse(dupA.detail_json).label).toBe('SUSPECTED duplication');
    const dupTitle = find('/dup-b', 'duplicate_title')!;
    expect(dupTitle.is_heuristic).toBe(1);
    expect(JSON.parse(dupTitle.detail_json).note).toMatch(/never justifies deleting/);
    const alt = find('/', 'image_missing_alt')!;
    expect(JSON.parse(alt.detail_json).note).toMatch(/decorative/);
    expect(find('/', 'hreflang_missing_return')).toBeTruthy();
    // Login redirects (URL pattern) and sign-in forms (page heuristics) are suspicions, never confirmed.
    expect(find('/account', 'access_blocked')).toMatchObject({ confirmed: 0, severity: 'info' });
    expect(JSON.parse(find('/account', 'access_blocked')!.detail_json).detection).toBe('login_redirect');
    expect(find('/members', 'access_blocked')).toMatchObject({ confirmed: 0 });
    expect(JSON.parse(find('/members', 'access_blocked')!.detail_json)).toMatchObject({ detection: 'login_form_heuristic', signals: expect.arrayContaining(['password form in main content', 'sign-in title']) });
    // No verdicts invented for things that were not observed.
    expect(all.some((i) => i.issue_type === 'broken_internal_link' && i.url.includes('/private/'))).toBe(false);
    expect(all.some((i) => /index(ed)?_ok|low_quality|thin_content/.test(i.issue_type))).toBe(false);
    expect(r.checks!.notes.join(' ')).toMatch(/HTTP 200 does not prove a page is indexed/);

    // Audit trail.
    expect(c.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE site_id = ? AND event_type = 'crawl.finished'", [c.siteId])!.n).toBe(1);
  });

  it('re-crawling resolves fixed issues and keeps issue identity stable', async () => {
    const c = siteCtx();
    await crawlSite(c, { fetcher: fetcher(), trapLimits: TRAPS });
    const o = server.origin();
    const before = c.db.get<{ id: string; status: string }>('SELECT id, status FROM technical_issues WHERE site_id = ? AND url = ? AND issue_type = ?', [c.siteId, `${o}/missing`, 'broken_internal_link'])!;
    expect(before.status).toBe('open');
    missingFixed = true;
    const r2 = await crawlSite(c, { fetcher: fetcher(), trapLimits: TRAPS });
    const after = c.db.get<{ id: string; status: string }>('SELECT id, status FROM technical_issues WHERE site_id = ? AND url = ? AND issue_type = ?', [c.siteId, `${o}/missing`, 'broken_internal_link'])!;
    expect(after.id).toBe(before.id);
    expect(after.status).toBe('resolved');
    expect(r2.checks!.resolved).toBeGreaterThan(0);
    expect(r2.checks!.updated).toBeGreaterThan(0);
  });

  it('stops at maxPages and reports a partial crawl with unvisited URLs', async () => {
    const c = siteCtx();
    const r = await crawlSite(c, { fetcher: fetcher(), maxPages: 4, trapLimits: TRAPS });
    expect(r.status).toBe('partial');
    expect(r.counts.attempted).toBe(4);
    expect(r.unvisited).toBeGreaterThan(0);
    expect(r.stopReason).toMatch(/maxPages \(4\) reached/);
  });

  it('respects maxDepth', async () => {
    const c = siteCtx({ maxDepth: 1 });
    const before = server.hits.length;
    const r = await crawlSite(c, { fetcher: fetcher(), trapLimits: TRAPS });
    expect(r.status).toBe('partial');
    expect(r.depthLimited).toBeGreaterThan(0);
    expect(server.hits.slice(before).filter((h) => h.path === '/blog/post-1').length).toBe(0);
  });

  it('fails honestly when robots.txt disallows the start URL (no page requests)', async () => {
    robotsMode = 'disallow_all';
    const c = siteCtx();
    const before = server.hits.length;
    const r = await crawlSite(c, { fetcher: fetcher(), useSitemaps: false });
    expect(r.status).toBe('failed');
    expect(r.stopReason).toMatch(/robots/);
    expect(r.nextStep).toBeTruthy();
    expect(server.hits.slice(before).map((h) => h.path)).toEqual(['/robots.txt']);
  });

  it('treats an erroring robots.txt as disallowed rather than guessing', async () => {
    robotsMode = 'error';
    const c = siteCtx();
    const r = await crawlSite(c, { fetcher: fetcher() });
    expect(r.status).toBe('failed');
    expect(r.robots[0]!.state).toBe('unreachable');
  });

  it('returns honest non-run statuses: dry run, offline, disabled', async () => {
    const dry = siteCtx({}, { dryRun: true });
    const before = server.hits.length;
    const d = await crawlSite(dry, { fetcher: fetcher() });
    expect(d.status).toBe('dry_run');
    expect(d.plan.maxPages).toBe(60);
    expect(dry.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM crawls')!.n).toBe(0);
    dry.cleanup();
    const off = siteCtx({}, { offline: true });
    const r = await crawlSite(off);
    expect(r.status).toBe('offline');
    expect(r.nextStep).toBeTruthy();
    off.cleanup();
    ctx = siteCtx({}, { features: { crawl: false } });
    expect((await crawlSite(ctx, { fetcher: fetcher() })).status).toBe('disabled');
    expect(server.hits.length).toBe(before);
  });

  it('fails explicitly when the start URL redirects outside allowedHostnames', async () => {
    const c = siteCtx();
    const before = server.hits.length;
    const r = await crawlSite(c, { fetcher: fetcher(), startUrl: `${server.origin()}/offsite-start`, useSitemaps: false });
    expect(r.status).toBe('failed');
    expect(r.stopReason).toMatch(/outside site.allowedHostnames/);
    expect(r.nextStep).toMatch(/www and non-www are never merged/);
    expect(server.hits.slice(before).some((h) => h.host === 'other.test')).toBe(false);
  });

  it('refuses to start an own-site crawl on a host outside allowedHostnames', async () => {
    const c = siteCtx();
    await expect(crawlSite(c, { fetcher: fetcher(), startUrl: 'https://www.example.com/' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('crawls a single page without following links', async () => {
    const c = siteCtx();
    const r = await crawlPage(c, `${server.origin()}/blog/`, { fetcher: fetcher() });
    expect(r.status).toBe('completed');
    expect(r.kind).toBe('single_page');
    expect(r.counts.attempted).toBe(1);
    expect(r.checks!.notes.join(' ')).toMatch(/Single-page crawl/);
  });

  it('crawls synthetic fixture files offline in demo-style mode and flags them as synthetic', async () => {
    const config = testSiteConfig({ site: { id: 'test-site', businessName: 'Test Co (synthetic)', url: 'https://www.example.test/', allowedHostnames: ['www.example.test'] }, crawl: { requestDelayMs: 0 } });
    ctx = createTestContext({ config }); // offline
    const f = new SafeFetcher({
      guard: new SsrfGuard({ resolver: mapResolver({ 'www.example.test': FAKE_PUBLIC_IP }) }),
      transport: fixtureSiteTransport({ dir: `${FIXTURES}/site`, hosts: ['www.example.test'] }),
      userAgent: 'seo-agent-test/1.0',
      timeoutMs: 1000,
      maxBytes: 100_000,
      maxRedirects: 3,
      perHostConcurrency: 1,
      delayMs: 0,
    });
    const r = await crawlSite(ctx, { fetcher: f, useSitemaps: false, maxPages: 5 });
    expect(r.isSynthetic).toBe(true);
    expect(r.transport).toBe('fixture');
    expect(ctx.db.get<{ is_synthetic: number }>('SELECT is_synthetic FROM crawls WHERE id = ?', [r.crawlId])!.is_synthetic).toBe(1);
    expect(ctx.db.get<{ render_mode: string }>('SELECT render_mode FROM crawl_results WHERE crawl_id = ? LIMIT 1', [r.crawlId])!.render_mode).toBe('fixture');
  });

  it('crawlerStatus --network checks robots.txt reachability and reports the last crawl', async () => {
    const c = siteCtx();
    const s = await crawlerStatus(c, { network: true, fetcher: fetcher() });
    expect(s.crawler).toMatchObject({ id: 'crawler', state: 'ready', networkChecked: true, chargeable: false });
    expect(s.lastCrawl).toBeNull();
    await crawlPage(c, `${server.origin()}/about`, { fetcher: fetcher() });
    expect((await crawlerStatus(c, { network: false })).lastCrawl).toMatchObject({ kind: 'single_page', status: 'completed' });
    robotsMode = 'disallow_all';
    const blocked = await crawlerStatus(c, { network: true, fetcher: fetcher() });
    expect(blocked.crawler.state).toBe('degraded');
    expect(blocked.crawler.nextStep).toMatch(/will not bypass/);
  });

  it('derives crawl/index/snippet eligibility from stored results without claiming indexing', async () => {
    const c = siteCtx();
    const r = await crawlSite(c, { fetcher: fetcher(), trapLimits: TRAPS });
    const id = (p: string) => c.db.get<{ id: string }>('SELECT id FROM crawl_results WHERE crawl_id = ? AND requested_url = ?', [r.crawlId, `${server.origin()}${p}`])!.id;
    expect(searchEligibilityForResult(c, id('/noindex-page'))).toMatchObject({ crawl: 'allowed', indexing: 'blocked_by_noindex', aiFeatures: 'not_eligible' });
    expect(searchEligibilityForResult(c, id('/private/secret'))).toMatchObject({ crawl: 'blocked_by_robots_txt', indexing: 'unknown' });
    const home = searchEligibilityForResult(c, id('/'))!;
    expect(home.indexing).toBe('no_blocking_directive_observed');
    expect(home.caveat).toMatch(/does not mean the page is indexed/);
    expect(searchEligibilityForResult(c, 'cres_missing')).toBeNull();
  });

  it('runTechnicalChecks ignores competitor crawls and unknown crawl ids', async () => {
    const c = siteCtx();
    expect(runTechnicalChecks(c, 'crawl_missing').notes[0]).toMatch(/not found/);
  });
});

// ---------------------------------------------------------------------------
// D2-ACC-01: a DNS/network failure on the own-site crawl is a transient network problem, never an SSRF
// refusal or a misconfigured site.url. SYNTHETIC: injected resolvers only (ENOTFOUND for the own site); the
// transport records and refuses every send, so no request can leave the test.
// ---------------------------------------------------------------------------

const HOST = 'www.example.test'; // testSiteConfig: site.url https://www.example.test/

/** Online context (a fake fetch that refuses everything; the crawler never uses ctx.fetch). */
function onlineCtx(): TestContext {
  ctx = createTestContext({ fetch: fakeFetch([]) });
  return ctx;
}

function recordingTransport(): HttpTransport & { sent: string[] } {
  const sent: string[] = [];
  return {
    kind: 'injected',
    sent,
    async send(target) {
      sent.push(target.url.toString());
      throw new Error('no request may be sent in this test');
    },
  };
}

function fetcherWith(resolver: Resolver, transport: HttpTransport): SafeFetcher {
  return new SafeFetcher({ guard: new SsrfGuard({ resolver }), transport, userAgent: 'seo-agent-test/1.0 (+synthetic)', timeoutMs: 2_000, maxBytes: 100_000, maxRedirects: 3, perHostConcurrency: 1, delayMs: 0, sleep: async () => {} });
}

describe('own-site crawl: DNS failure is transient, not an SSRF refusal (D2-ACC-01)', () => {
  it('crawlSite reports a retryable network/DNS failure with a retry next step, not "change site.url"', async () => {
    const c = onlineCtx();
    const transport = recordingTransport();
    const r = await crawlSite(c, { fetcher: fetcherWith(mapResolver({}), transport) });
    expect(r.status).toBe('failed');
    expect(r.stopReason).toBe(`DNS resolution failed for ${HOST} (transient network/DNS problem)`);
    expect(r.failureCode).toBe('CRAWL_NETWORK_ERROR');
    expect(r.notes.join(' ')).toMatch(/ENOTFOUND/);
    expect(r.nextStep).toMatch(/network connection and DNS/);
    expect(r.nextStep).toMatch(/re-run the crawl/);
    expect(r.nextStep).toMatch(/crawl status --network/);
    // Never the SSRF / site.url wording.
    expect(`${r.stopReason} ${r.nextStep}`).not.toMatch(/SSRF|must be a public|private, loopback/);
    expect(transport.sent).toEqual([]);
  });

  it('crawlerStatus --network: unreachable (doctor WARN) with a retry next step, never misconfigured (FAIL)', async () => {
    const c = onlineCtx();
    const transport = recordingTransport();
    const s = await crawlerStatus(c, { network: true, fetcher: fetcherWith(mapResolver({}), transport) });
    expect(s.crawler.state).toBe('unreachable');
    expect(s.crawler.networkChecked).toBe(true);
    expect(levelForState(s.crawler.state)).toBe('warn');
    expect(s.crawler.detail).toMatch(/DNS resolution failed for www\.example\.test/);
    expect(s.crawler.detail).toMatch(/transient network\/DNS problem/);
    expect(s.crawler.nextStep).toMatch(/network connection and DNS/);
    expect(s.crawler.nextStep).not.toMatch(/must be a public|SSRF/);
    expect(transport.sent).toEqual([]);
  });

  it('a DNS failure after the start check (robots.txt) is still transient: CRAWL_NETWORK_ERROR, robots state unreachable', async () => {
    const c = onlineCtx();
    const transport = recordingTransport();
    let calls = 0;
    const flaky: Resolver = async (hostname) => {
      calls++;
      if (calls === 1) return [{ address: FAKE_PUBLIC_IP, family: 4 }];
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    };
    const r = await crawlSite(c, { fetcher: fetcherWith(flaky, transport) });
    expect(r.status).toBe('failed');
    expect(r.failureCode).toBe('CRAWL_NETWORK_ERROR');
    expect(r.nextStep).toMatch(/network connection and DNS/);
    expect(r.robots[0]).toMatchObject({ state: 'unreachable' });
    expect(r.robots[0]!.note).toMatch(/DNS resolution failed/);
    const stored = c.db.get<{ state: string; note: string }>('SELECT state, note FROM crawl_robots WHERE site_id = ? AND crawl_id = ?', [c.siteId, r.crawlId]);
    expect(stored?.state).toBe('unreachable');
    expect(transport.sent).toEqual([]);
  });

  it('a real SSRF refusal of site.url stays a policy block: misconfigured (doctor FAIL) and the site.url next step', async () => {
    const c = onlineCtx();
    const transport = recordingTransport();
    const privateSite = mapResolver({ [HOST]: '10.0.0.5' });
    const r = await crawlSite(c, { fetcher: fetcherWith(privateSite, transport) });
    expect(r.status).toBe('failed');
    expect(r.stopReason).toBe('Start URL refused by the SSRF guard (dns_blocked_ip)');
    expect(r.failureCode).toBe('CRAWL_START_URL_REFUSED');
    expect(r.nextStep).toMatch(/site\.url must be a public http\(s\) URL/);
    const s = await crawlerStatus(c, { network: true, fetcher: fetcherWith(privateSite, transport) });
    expect(s.crawler.state).toBe('misconfigured');
    expect(levelForState(s.crawler.state)).toBe('fail');
    expect(transport.sent).toEqual([]);
  });
});
