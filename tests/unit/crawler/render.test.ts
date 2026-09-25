import { afterEach, describe, expect, it } from 'vitest';
import { crawlSite } from '../../../src/crawler/crawl.js';
import { extractPage } from '../../../src/crawler/extract.js';
import { SafeFetcher } from '../../../src/crawler/fetch.js';
import { compareRawRendered, defaultPlaywrightLoader, playwrightAvailability, renderPage, type ContextLike, type PlaywrightLike, type PlaywrightLoader, type RouteLike } from '../../../src/crawler/render.js';
import { crawlerStatus } from '../../../src/crawler/status.js';
import { fixtureTransport } from '../../../src/crawler/transport.js';
import { SsrfGuard } from '../../../src/security/ssrf.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import { FAKE_PUBLIC_IP, fixture, mapResolver } from '../../integration/crawler/helpers.js';

interface FakeLog {
  launches: number;
  launchOptions: Record<string, unknown>[];
  contextOptions: Record<string, unknown>[];
  aborted: string[];
  continued: string[];
  closedWebSockets: string[];
  pageClosed: number;
}

interface FakeOpts {
  html: string;
  subrequests?: Array<{ url: string; type?: string }>;
  /** Redirect hops Chromium would follow WITHOUT calling route() (Playwright's documented behaviour). */
  redirects?: Array<{ from: string; to: string }>;
  webSockets?: string[];
  failLaunch?: boolean;
  /** Simulate an old Playwright without routeWebSocket / request events. */
  legacy?: boolean;
  finalUrl?: string;
}

type Req = { url: () => string; resourceType: () => string; redirectedFrom: () => Req | null };

/** Minimal fake of the Playwright API surface used by render.ts (no browser, no network). */
function fakePlaywright(opts: FakeOpts): { loader: PlaywrightLoader; log: FakeLog } {
  const log: FakeLog = { launches: 0, launchOptions: [], contextOptions: [], aborted: [], continued: [], closedWebSockets: [], pageClosed: 0 };
  const pw: PlaywrightLike = {
    chromium: {
      async launch(lo?: Record<string, unknown>) {
        log.launches++;
        log.launchOptions.push(lo ?? {});
        if (opts.failLaunch) throw new Error('Executable does not exist (run npx playwright install)');
        return {
          async newContext(o?: Record<string, unknown>) {
            log.contextOptions.push(o ?? {});
            let handler: ((r: RouteLike) => Promise<void>) | null = null;
            let wsHandler: ((ws: { url(): string; close(): Promise<void> }) => Promise<void> | void) | null = null;
            const requestListeners: Array<(r: Req) => void> = [];
            let current = '';
            const req = (url: string, type: string, from: Req | null = null): Req => ({ url: () => url, resourceType: () => type, redirectedFrom: () => from });
            const ctx: ContextLike = {
              async route(_p: string, h: (r: RouteLike) => Promise<void>) {
                handler = h;
              },
              async newPage() {
                const intercept = async (r: Req): Promise<'abort' | 'continue'> => {
                  for (const l of requestListeners) l(r);
                  const state: { outcome: 'abort' | 'continue' } = { outcome: 'continue' };
                  await handler!({
                    request: () => r,
                    abort: async () => {
                      state.outcome = 'abort';
                      log.aborted.push(r.url());
                    },
                    continue: async () => {
                      state.outcome = 'continue';
                      log.continued.push(r.url());
                    },
                  });
                  return state.outcome;
                };
                return {
                  async goto(url: string) {
                    current = url;
                    const doc = req(url, 'document');
                    if ((await intercept(doc)) === 'abort') throw new Error('net::ERR_BLOCKED_BY_CLIENT');
                    // Redirect hops: Playwright emits request events but does NOT call route handlers.
                    let prev = doc;
                    for (const hop of opts.redirects ?? []) {
                      const next = req(hop.to, 'document', prev);
                      for (const l of requestListeners) l(next);
                      log.continued.push(`hop:${hop.to}`);
                      prev = next;
                      current = hop.to;
                    }
                    for (const s of opts.subrequests ?? []) await intercept(req(s.url, s.type ?? 'script'));
                    for (const w of opts.webSockets ?? []) {
                      if (wsHandler) await wsHandler({ url: () => w, close: async () => void log.closedWebSockets.push(w) });
                    }
                    if (opts.finalUrl) current = opts.finalUrl;
                    return { status: () => 200 };
                  },
                  async content() {
                    return opts.html;
                  },
                  url: () => current,
                  async close() {
                    log.pageClosed++;
                  },
                };
              },
              async close() {},
            };
            if (!opts.legacy) {
              ctx.routeWebSocket = async (_p, h) => {
                wsHandler = h as typeof wsHandler;
              };
              ctx.on = (_e, h) => {
                requestListeners.push(h as (r: Req) => void);
              };
            }
            return ctx;
          },
          async close() {},
        };
      },
    },
  };
  return { loader: async () => pw, log };
}

const guard = () =>
  new SsrfGuard({ resolver: mapResolver({ 'www.example.test': FAKE_PUBLIC_IP, 'cdn.example.com': FAKE_PUBLIC_IP, 'internal.example.com': '10.0.0.3' }) });
const RENDERED = '<html><head><title>App - rendered</title><link rel="canonical" href="https://www.example.test/app"></head><body><main><h1>Rendered app</h1><p>' + 'Client side rendered synthetic content about widgets. '.repeat(20) + '</p><a href="/only-in-rendered">More</a></main></body></html>';

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

describe('optional Playwright rendering', () => {
  it('reports optional-disabled when playwright is not installed', async () => {
    expect(await defaultPlaywrightLoader()).toBeNull();
    const a = await playwrightAvailability();
    expect(a.available).toBe(false);
    expect(a.detail).toMatch(/optional-disabled/);
    expect(a.nextStep).toMatch(/npm install playwright/);
    const r = await renderPage('https://www.example.test/app', { guard: guard(), userAgent: 't', timeoutMs: 1000 });
    expect(r.status).toBe('optional_disabled');
    expect(r.html).toBeNull();
    expect(r.disclaimer).toMatch(/not equivalent to how Googlebot/);
  });

  it('isolates the context and blocks unsafe browser subrequests through the SSRF guard', async () => {
    const { loader, log } = fakePlaywright({
      html: RENDERED,
      subrequests: [
        { url: 'https://cdn.example.com/app.js' },
        { url: 'http://169.254.169.254/latest/meta-data/iam/', type: 'xhr' },
        { url: 'http://10.0.0.1/admin', type: 'fetch' },
        { url: 'https://internal.example.com/api', type: 'fetch' },
        { url: 'data:image/png;base64,iVBORw0KGgo=', type: 'image' },
        { url: 'https://cdn.example.com/font.woff2', type: 'font' },
      ],
    });
    const r = await renderPage('https://www.example.test/app', { guard: guard(), loader, userAgent: 'seo-agent-test', timeoutMs: 1000 });
    expect(r.status).toBe('rendered');
    expect(r.html).toContain('Rendered app');
    expect(log.contextOptions[0]).toMatchObject({ acceptDownloads: false, serviceWorkers: 'block', userAgent: 'seo-agent-test' });
    expect(r.blockedSubrequests.map((b) => b.reason)).toEqual(['metadata_endpoint', 'blocked_ip', 'dns_blocked_ip']);
    expect(log.aborted).toEqual(expect.arrayContaining(['http://169.254.169.254/latest/meta-data/iam/', 'http://10.0.0.1/admin', 'https://internal.example.com/api', 'https://cdn.example.com/font.woff2']));
    expect(log.continued).toEqual(expect.arrayContaining(['https://www.example.test/app', 'https://cdn.example.com/app.js', 'data:image/png;base64,iVBORw0KGgo=']));
    expect(r.allowedSubrequests).toBe(2);
    // Chromium runs behind the SSRF-enforcing proxy with the loopback bypass removed.
    expect(log.launchOptions[0]).toMatchObject({ headless: true, proxy: { server: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), bypass: '<-loopback>' } });
    expect(log.launchOptions[0]!.args).toEqual(expect.arrayContaining(['--force-webrtc-ip-handling-policy=disable_non_proxied_udp']));
    expect(r.protections).toEqual(['guarded_proxy', 'websocket_block', 'redirect_hop_check', 'route_guard']);
  });

  it('discards the render when a redirect hop (invisible to route()) points at a metadata IP', async () => {
    const { loader, log } = fakePlaywright({
      html: '<html><body>{"AccessKeyId":"SYNTHETIC-SHOULD-NOT-BE-KEPT"}</body></html>',
      redirects: [
        { from: 'https://www.example.test/app', to: 'https://cdn.example.com/bounce' },
        { from: 'https://cdn.example.com/bounce', to: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' },
      ],
    });
    const r = await renderPage('https://www.example.test/app', { guard: guard(), loader, userAgent: 't', timeoutMs: 1000 });
    expect(r.status).toBe('blocked');
    expect(r.html).toBeNull();
    expect(r.error).toMatch(/redirect hop to a refused destination.*metadata_endpoint/);
    expect(r.blockedSubrequests).toEqual(expect.arrayContaining([{ url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/', reason: 'redirect_hop:metadata_endpoint' }]));
    expect(log.pageClosed).toBeGreaterThanOrEqual(1); // navigation aborted as soon as the hop was refused
    // A redirect hop to a private IP via DNS is caught the same way.
    const dns = fakePlaywright({ html: '<html></html>', redirects: [{ from: 'https://www.example.test/app', to: 'https://internal.example.com/admin' }] });
    const r2 = await renderPage('https://www.example.test/app', { guard: guard(), loader: dns.loader, userAgent: 't', timeoutMs: 1000 });
    expect(r2.status).toBe('blocked');
    expect(r2.blockedSubrequests.map((b) => b.reason)).toContain('redirect_hop:dns_blocked_ip');
    // Safe hops are fine.
    const ok = fakePlaywright({ html: RENDERED, redirects: [{ from: 'https://www.example.test/app', to: 'https://www.example.test/app/' }] });
    expect((await renderPage('https://www.example.test/app', { guard: guard(), loader: ok.loader, userAgent: 't', timeoutMs: 1000 })).status).toBe('rendered');
  });

  it('closes every WebSocket and refuses a final URL on a blocked destination', async () => {
    const { loader, log } = fakePlaywright({ html: RENDERED, webSockets: ['ws://10.0.0.1/socket', 'wss://cdn.example.com/live'] });
    const r = await renderPage('https://www.example.test/app', { guard: guard(), loader, userAgent: 't', timeoutMs: 1000 });
    expect(r.status).toBe('rendered');
    expect(log.closedWebSockets).toEqual(['ws://10.0.0.1/socket', 'wss://cdn.example.com/live']);
    expect(r.blockedSubrequests.filter((b) => b.reason === 'websocket_blocked')).toHaveLength(2);
    const bad = fakePlaywright({ html: RENDERED, finalUrl: 'http://10.0.0.1/' });
    const r2 = await renderPage('https://www.example.test/app', { guard: guard(), loader: bad.loader, userAgent: 't', timeoutMs: 1000 });
    expect(r2).toMatchObject({ status: 'blocked', html: null });
  });

  it('still renders with an older Playwright (no routeWebSocket / request events) and says which protections were active', async () => {
    const { loader } = fakePlaywright({ html: RENDERED, legacy: true });
    const r = await renderPage('https://www.example.test/app', { guard: guard(), loader, userAgent: 't', timeoutMs: 1000 });
    expect(r.status).toBe('rendered');
    expect(r.protections).toEqual(['guarded_proxy', 'route_guard']);
  });

  it('does not render when the SSRF-enforcing proxy cannot start', async () => {
    const { loader, log } = fakePlaywright({ html: RENDERED });
    const r = await renderPage('https://www.example.test/app', {
      guard: guard(),
      loader,
      userAgent: 't',
      timeoutMs: 1000,
      proxyFactory: async () => {
        throw new Error('EADDRINUSE');
      },
    });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/SSRF-enforcing proxy/);
    expect(log.launches).toBe(0);
  });

  it('never launches a browser for an unsafe top-level URL and reports launch failures honestly', async () => {
    const { loader, log } = fakePlaywright({ html: RENDERED });
    const r = await renderPage('http://169.254.169.254/', { guard: guard(), loader, userAgent: 't', timeoutMs: 1000 });
    expect(r.status).toBe('blocked');
    expect(log.launches).toBe(0);
    const failing = fakePlaywright({ html: RENDERED, failLaunch: true });
    const f = await renderPage('https://www.example.test/app', { guard: guard(), loader: failing.loader, userAgent: 't', timeoutMs: 1000 });
    expect(f.status).toBe('failed');
    expect(f.error).toMatch(/playwright install/);
  });

  it('compares raw and rendered extractions without claiming Googlebot equivalence', () => {
    const raw = extractPage(fixture('pages/js-shell.html'), { url: 'https://www.example.test/app', internalHosts: ['www.example.test'] });
    const rendered = extractPage(RENDERED, { url: 'https://www.example.test/app', internalHosts: ['www.example.test'] });
    const d = compareRawRendered(raw, rendered);
    expect(d.contentDependsOnJavascript).toBe(true);
    expect(d.title).toEqual({ raw: 'App', rendered: 'App - rendered' });
    expect(d.canonical).toEqual({ raw: null, rendered: 'https://www.example.test/app' });
    expect(d.internalLinks.onlyInRendered).toEqual(['https://www.example.test/only-in-rendered']);
    expect(d.wordCount.delta).toBeGreaterThan(100);
    expect(d.disclaimer).toMatch(/not equivalent/);
    expect(d.notes.join(' ')).toMatch(/only after JavaScript runs/);
  });
});

describe('crawlSite rendering integration (fixture transport, fake browser)', () => {
  const routes = {
    'https://www.example.test/robots.txt': { status: 404, body: '' },
    'https://www.example.test/': { headers: { 'content-type': 'text/html' }, body: '<html><head><title>Synthetic home page title</title></head><body><h1>Home</h1><p>Plenty of words on the home page so it is not a shell. <a href="/app">App</a></p></body></html>' },
    'https://www.example.test/app': { headers: { 'content-type': 'text/html' }, body: fixture('pages/js-shell.html') },
  };
  const fetcher = () =>
    new SafeFetcher({ guard: guard(), transport: fixtureTransport(routes), userAgent: 'seo-agent-test/1.0', timeoutMs: 1000, maxBytes: 100_000, maxRedirects: 3, perHostConcurrency: 1, delayMs: 0 });
  const make = (playwright: boolean) => {
    ctx = createTestContext({ config: testSiteConfig({ features: { playwright }, crawl: { requestDelayMs: 0 } }) });
    return ctx;
  };

  it('renders only JavaScript-dependent pages and stores discrepancies', async () => {
    const c = make(true);
    const { loader, log } = fakePlaywright({ html: RENDERED });
    const r = await crawlSite(c, { fetcher: fetcher(), render: true, playwrightLoader: loader, useSitemaps: false });
    expect(r.render).toMatchObject({ requested: true, status: 'available', rendered: 1 });
    expect(log.launches).toBe(1);
    const row = c.db.get<{ render_mode: string; render_discrepancies_json: string }>("SELECT render_mode, render_discrepancies_json FROM crawl_results WHERE crawl_id = ? AND requested_url = 'https://www.example.test/app'", [r.crawlId])!;
    expect(row.render_mode).toBe('playwright');
    const d = JSON.parse(row.render_discrepancies_json);
    expect(d.contentDependsOnJavascript).toBe(true);
    expect(d.disclaimer).toMatch(/not equivalent to how Googlebot/);
    const issue = c.db.get<{ issue_type: string; confirmed: number }>("SELECT issue_type, confirmed FROM technical_issues WHERE site_id = ? AND url = 'https://www.example.test/app' AND issue_type = 'content_requires_javascript'", [c.siteId]);
    expect(issue).toMatchObject({ confirmed: 0 });
  });

  it('reports optional-disabled / disabled-by-config without failing the crawl', async () => {
    const c = make(true);
    const r = await crawlSite(c, { fetcher: fetcher(), render: true, useSitemaps: false });
    expect(r.status).toBe('completed');
    expect(r.render.status).toBe('optional_disabled');
    const heuristic = c.db.get<{ is_heuristic: number }>("SELECT is_heuristic FROM technical_issues WHERE site_id = ? AND issue_type = 'content_requires_javascript_suspected'", [c.siteId]);
    expect(heuristic).toMatchObject({ is_heuristic: 1 });
    c.cleanup();
    const c2 = make(false);
    const r2 = await crawlSite(c2, { fetcher: fetcher(), render: true, useSitemaps: false });
    expect(r2.render.status).toBe('disabled_by_config');
  });

  it('crawlerStatus reports playwright as optional-disabled and the crawler without network checks', async () => {
    const c = make(true);
    const s = await crawlerStatus(c, { network: false });
    expect(s.playwright.state).toBe('disabled');
    expect(s.playwright.detail).toMatch(/optional-disabled/);
    expect(s.crawler.state).toBe('configured_unverified');
    expect(s.crawler.networkChecked).toBe(false);
    expect(s.crawler.sendsExternally.join(' ')).toMatch(/No cookies, credentials, or API keys/);
    const withFake = await crawlerStatus(c, { network: false, playwrightLoader: fakePlaywright({ html: '' }).loader });
    expect(withFake.playwright.state).toBe('configured_unverified');
    expect(withFake.playwright.detail).toMatch(/never presented as equivalent to Googlebot/);
  });
});
