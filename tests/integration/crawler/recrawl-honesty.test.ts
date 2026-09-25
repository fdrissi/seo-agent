/**
 * SYNTHETIC local-site scenarios for honest crawl outcomes: login widgets,
 * redirects to dead pages, rate limits, timeouts, and which issues a re-crawl
 * may resolve. Local node:http server on 127.0.0.1 only (test-only loopback
 * escape hatch); hostnames map to 127.0.0.1 through a fake resolver.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { crawlSite } from '../../../src/crawler/crawl.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import { fakeFetch } from '../../helpers/fake-fetch.js';
import { mapResolver, send, startServer, testFetcher, type TestServer } from './helpers.js';

const WORDS = (topic: string, n: number) => Array.from({ length: n }, (_, i) => `${topic}${i % 7 === 0 ? '.' : ''}`).join(' ');
const page = (title: string, body: string, head = '') => `<!doctype html><html lang="en"><head><title>${title}</title>${head}</head><body>${body}</body></html>`;
const SHARED_TEXT = `<p>${'Synthetic duplicated paragraph about widget maintenance schedules and careful testing. '.repeat(6)}</p>`;

interface Scenario {
  hangNoTitle: boolean;
  rateLimitPages: boolean;
}
const scenario: Scenario = { hangNoTitle: false, rateLimitPages: false };

let server: TestServer;

beforeAll(async () => {
  server = await startServer(async (_req, res, url) => {
    const p = url.pathname;
    if (p === '/robots.txt' || p === '/sitemap.xml') return send(res, 404, 'not found', { 'content-type': 'text/plain' });
    if (scenario.rateLimitPages && p !== '/') return send(res, 429, 'slow down', { 'retry-after': '3600' });
    switch (p) {
      case '/':
        return send(
          res,
          200,
          page(
            'Synthetic widgets home',
            // Site-wide sign-in widget in the header: a hint, not a login wall.
            `<header><nav><a href="/about">About</a></nav><form action="/session" method="post"><input type="email" name="e"><input type="password" name="p"><button>Sign in</button></form></header>
             <main><h1>Welcome to synthetic widgets</h1><p>${WORDS('widget', 100)}</p>
             <a href="/about">About</a> <a href="/moved">Moved</a> <a href="/notitle">No title</a> <a href="/a">A</a> <a href="/b">B</a> <a href="/hop1">Hop</a>
             <a href="/p1">p1</a> <a href="/p2">p2</a> <a href="/p3">p3</a></main>`,
            '<meta name="description" content="Synthetic widgets home page used by crawler tests only.">',
          ),
        );
      case '/about':
        return send(res, 200, page('About synthetic widgets', `<main><h1>About</h1><p>${WORDS('about', 60)}</p></main>`, '<meta name="description" content="About the synthetic widgets company, used in tests only.">'));
      case '/moved':
        return send(res, 301, '', { location: '/dead' });
      case '/dead':
        return send(res, 404, 'gone missing');
      case '/notitle':
        if (scenario.hangNoTitle) {
          await new Promise((r) => setTimeout(r, 1_000));
          return send(res, 200, 'late');
        }
        return send(res, 200, '<html><head></head><body><main><h1>Untitled</h1><p>Page without a title or description.</p></main></body></html>');
      case '/a':
      case '/b':
        return send(res, 200, page(`Page ${p}`, `<main><h1>Widget care</h1>${SHARED_TEXT}<a href="/about">About</a></main>`, `<meta name="description" content="Synthetic page ${p} with duplicated body text for tests.">`));
      case '/hop1':
        return send(res, 302, '', { location: '/hop2' });
      case '/hop2':
        return send(res, 302, '', { location: '/about' });
      case '/p1':
      case '/p2':
      case '/p3':
        return send(res, 200, page(`Product ${p}`, `<main><h1>Product</h1><p>${WORDS('product', 40)}</p></main>`, `<meta name="description" content="Synthetic product page ${p} used only by crawler tests.">`));
      default:
        return send(res, 404, 'not found');
    }
  });
});

afterAll(async () => {
  await server.close();
});

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
  scenario.hangNoTitle = false;
  scenario.rateLimitPages = false;
});

function siteCtx(): TestContext {
  const config = testSiteConfig({
    site: { id: 'test-site', businessName: 'Test Co (synthetic)', url: `${server.origin()}/`, allowedHostnames: ['site.test'] },
    crawl: { maxPages: 60, maxDepth: 5, requestDelayMs: 0, maxBytes: 200_000, timeoutMs: 3_000 },
  });
  ctx = createTestContext({ config, fetch: fakeFetch([]) });
  return ctx;
}

const fetcher = (o: { timeoutMs?: number; maxRedirects?: number; perHostConcurrency?: number } = {}) => testFetcher({ resolver: mapResolver({ 'site.test': '127.0.0.1' }), ...o });
const o = (p: string) => `${server.origin()}${p}`;

function issue(c: TestContext, p: string, type: string) {
  return c.db.get<{ status: string; confirmed: number; severity: string; is_heuristic: number; detail_json: string }>(
    'SELECT status, confirmed, severity, is_heuristic, detail_json FROM technical_issues WHERE site_id = ? AND url = ? AND issue_type = ?',
    [c.siteId, o(p), type],
  );
}

describe('honest crawl outcomes', () => {
  it('does not treat a header sign-in widget on a short public page as a login wall', async () => {
    const c = siteCtx();
    const r = await crawlSite(c, { fetcher: fetcher() });
    expect(r.status).toBe('completed');
    const home = c.db.get<{ blocked_reason: string | null; extraction_json: string }>('SELECT blocked_reason, extraction_json FROM crawl_results WHERE crawl_id = ? AND requested_url = ?', [r.crawlId, o('/')])!;
    expect(home.blocked_reason).toBeNull();
    const x = JSON.parse(home.extraction_json);
    expect(x).toMatchObject({ loginForm: true, loginFormInContent: false, loginBarrier: false });
    expect(x.loginHint).toMatch(/site chrome/);
    // Links on the page were followed and no barrier issue was invented.
    expect(server.hits.some((h) => h.path === '/about')).toBe(true);
    expect(c.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM technical_issues WHERE site_id = ? AND issue_type = 'access_blocked'", [c.siteId])!.n).toBe(0);
  });

  it('keeps the final status of a redirect to a dead page and reports the link as broken', async () => {
    const c = siteCtx();
    const before = server.hits.length;
    const r = await crawlSite(c, { fetcher: fetcher() });
    const moved = c.db.get<{ status_code: number; final_url: string; extraction_json: string }>('SELECT status_code, final_url, extraction_json FROM crawl_results WHERE crawl_id = ? AND requested_url = ?', [r.crawlId, o('/moved')])!;
    expect(moved.status_code).toBe(301);
    expect(moved.final_url).toBe(o('/dead'));
    expect(JSON.parse(moved.extraction_json).finalStatus).toBe(404);
    // The final URL got its own row and page from the same response (no second request).
    const dead = c.db.get<{ status_code: number; discovered_via_json: string }>('SELECT status_code, discovered_via_json FROM crawl_results WHERE crawl_id = ? AND requested_url = ?', [r.crawlId, o('/dead')])!;
    expect(dead.status_code).toBe(404);
    expect(JSON.parse(dead.discovered_via_json)).toEqual(['redirect']);
    expect(server.hits.slice(before).filter((h) => h.path === '/dead')).toHaveLength(1);
    expect(c.db.get<{ lifecycle: string }>('SELECT lifecycle FROM pages WHERE site_id = ? AND url = ?', [c.siteId, o('/dead')])!.lifecycle).toBe('gone');
    const broken = issue(c, '/moved', 'broken_internal_link')!;
    expect(broken).toMatchObject({ confirmed: 1, severity: 'high' });
    expect(JSON.parse(broken.detail_json)).toMatchObject({ viaRedirect: true, finalStatus: 404, finalUrl: o('/dead') });
    expect(issue(c, '/moved', 'internal_link_to_redirect')).toBeUndefined();
  });

  it('fails honestly when the start URL redirects to a dead page', async () => {
    const c = siteCtx();
    const r = await crawlSite(c, { fetcher: fetcher(), startUrl: o('/moved') });
    expect(r.status).toBe('failed');
    expect(r.stopReason).toMatch(/redirects to .*\/dead, which returned HTTP 404/);
    expect(r.checks).toBeNull();
  });

  it('reports a chain over the local redirect cap as a suspicion, not a confirmed blocker', async () => {
    const c = siteCtx();
    await crawlSite(c, { fetcher: fetcher({ maxRedirects: 1 }) });
    const long = issue(c, '/hop1', 'redirect_chain_too_long')!;
    expect(long).toMatchObject({ confirmed: 0, severity: 'medium' });
    expect(JSON.parse(long.detail_json).note).toMatch(/this crawler's limit/);
  });

  it('never resolves issues on a URL that merely timed out, and reports the crawl as partial', async () => {
    const c = siteCtx();
    await crawlSite(c, { fetcher: fetcher() });
    expect(issue(c, '/notitle', 'missing_title')!.status).toBe('open');
    expect(issue(c, '/notitle', 'missing_meta_description')!.status).toBe('open');
    scenario.hangNoTitle = true;
    const r2 = await crawlSite(c, { fetcher: fetcher({ timeoutMs: 300 }) });
    const row = c.db.get<{ status_code: number | null; blocked_reason: string }>('SELECT status_code, blocked_reason FROM crawl_results WHERE crawl_id = ? AND requested_url = ?', [r2.crawlId, o('/notitle')])!;
    expect(row).toMatchObject({ status_code: null, blocked_reason: 'timeout' });
    expect(issue(c, '/notitle', 'missing_title')!.status).toBe('open');
    expect(issue(c, '/notitle', 'missing_meta_description')!.status).toBe('open');
    expect(issue(c, '/notitle', 'internal_link_unreachable')!.status).toBe('open');
    expect(r2.status).toBe('partial');
    expect(r2.stopReason).toMatch(/1 URL\(s\) timeout/);
    expect(r2.checks!.notes.join(' ')).toMatch(/not observed this time/);
  });

  it('does not resolve cross-page issues after a partial crawl', async () => {
    const c = siteCtx();
    await crawlSite(c, { fetcher: fetcher() });
    expect(issue(c, '/a', 'suspected_duplicate_content')!.status).toBe('open');
    expect(issue(c, '/b', 'suspected_duplicate_content')!.status).toBe('open');
    const r2 = await crawlSite(c, { fetcher: fetcher(), startUrl: o('/a'), maxPages: 1 });
    expect(r2.status).toBe('partial');
    expect(issue(c, '/a', 'suspected_duplicate_content')!.status).toBe('open');
    expect(issue(c, '/b', 'suspected_duplicate_content')!.status).toBe('open');
    expect(r2.checks!.notes.join(' ')).toMatch(/not auto-resolved/);
    // A complete crawl from site.url still resolves what it re-evaluated.
    const r3 = await crawlSite(c, { fetcher: fetcher() });
    expect(r3.status).toBe('completed');
    expect(issue(c, '/a', 'suspected_duplicate_content')!.status).toBe('open'); // still duplicated
  });

  it('stops requesting a host that asks for a long Retry-After and reports a partial crawl', async () => {
    scenario.rateLimitPages = true;
    const c = siteCtx();
    const before = server.hits.length;
    const f = fetcher({ perHostConcurrency: 1 });
    const r = await crawlSite(c, { fetcher: f });
    const pageHits = server.hits.slice(before).filter((h) => h.path !== '/robots.txt' && h.path !== '/sitemap.xml' && h.path !== '/');
    expect(pageHits).toHaveLength(1); // only the first 429; everything after it was never requested
    expect(f.slept.every((ms) => ms < 60_000)).toBe(true);
    expect(r.status).toBe('partial');
    expect(r.stopReason).toMatch(/rate limited/);
    expect(r.counts.attempted).toBe(2);
    const limited = c.db.all<{ blocked_reason: string; error: string | null }>("SELECT blocked_reason, error FROM crawl_results WHERE crawl_id = ? AND blocked_reason = 'rate_limited'", [r.crawlId]);
    expect(limited.length).toBeGreaterThanOrEqual(5);
    expect(limited.filter((l) => /back-off|back off/.test(l.error ?? '')).length).toBe(limited.length - 1);
  });
});
