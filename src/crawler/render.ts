import type { SsrfGuard } from '../security/ssrf.js';
import type { PageExtraction } from './extract.js';
import { startGuardedProxy, type GuardedProxy, type GuardedProxyFactory } from './render-proxy.js';

/**
 * Optional Playwright rendering. Playwright is NOT a dependency: it is loaded
 * with a dynamic import and, when missing, every render reports the honest
 * status `optional_disabled` (the raw HTTP crawl keeps working).
 *
 * SSRF protection has several layers because Playwright's `route()` only sees
 * the first URL of a redirect chain and never sees WebSockets:
 * 1. The top-level URL is validated before a browser is launched.
 * 2. Chromium runs behind an SSRF-enforcing local proxy (render-proxy.ts),
 *    with the loopback bypass removed (`<-loopback>`). Every connection,
 *    including redirect hops and WebSockets, is validated there and connected
 *    only to guard-validated addresses, so it is DNS-pinned. Non-proxied WebRTC
 *    UDP is disabled by a launch flag.
 * 3. `context.route('**\/*')` validates each request before it is sent and
 *    enforces the subrequest cap and the resource-type skip list.
 * 4. `context.on('request')` re-validates every redirect hop
 *    (`request.redirectedFrom()`). If a hop points at a refused destination,
 *    the render is discarded (status `blocked`, no HTML is kept).
 * 5. `context.routeWebSocket` (when available) closes every WebSocket.
 * The final page URL is validated again before any HTML is returned.
 * Limitation: layers 2 and 5 use Playwright/Chromium behaviour that this
 * repository cannot live-test because Playwright is not installed. The proxy
 * itself is tested offline.
 *
 * Every render uses a fresh, isolated browser context (no shared storage, no
 * downloads, service workers blocked). Raw-vs-rendered discrepancies are
 * recorded. A local headless Chromium render is NOT equivalent to Googlebot's
 * rendering and is never described as such.
 */

export const RENDER_DISCLAIMER = 'Rendered with a local headless Chromium via Playwright. This is not equivalent to how Googlebot renders or indexes the page.';

export interface RequestLike {
  url(): string;
  resourceType(): string;
  /** Previous request of a redirect chain (Playwright API); null for the first request. */
  redirectedFrom?(): RequestLike | null;
}
export interface RouteLike {
  request(): RequestLike;
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}
export interface WebSocketRouteLike {
  url(): string;
  close(opts?: { code?: number; reason?: string }): Promise<void> | void;
}
export interface PageLike {
  goto(url: string, opts?: Record<string, unknown>): Promise<{ status(): number } | null>;
  content(): Promise<string>;
  url(): string;
  close(): Promise<void>;
}
export interface ContextLike {
  route(pattern: string, handler: (route: RouteLike) => Promise<void>): Promise<void>;
  /** Playwright >= 1.48. */
  routeWebSocket?(pattern: RegExp | string, handler: (ws: WebSocketRouteLike) => Promise<void> | void): Promise<void>;
  on?(event: 'request', handler: (request: RequestLike) => void): unknown;
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
export interface BrowserLike {
  newContext(opts?: Record<string, unknown>): Promise<ContextLike>;
  close(): Promise<void>;
}
export interface PlaywrightLike {
  chromium: { launch(opts?: Record<string, unknown>): Promise<BrowserLike> };
}
export type PlaywrightLoader = () => Promise<PlaywrightLike | null>;

/** Dynamic import of the optional `playwright` package; null when not installed. */
export const defaultPlaywrightLoader: PlaywrightLoader = async () => {
  const moduleName: string = 'playwright';
  try {
    const mod = (await import(/* @vite-ignore */ moduleName)) as { default?: PlaywrightLike } & Partial<PlaywrightLike>;
    const pw = (mod.chromium ? mod : mod.default) as PlaywrightLike | undefined;
    return pw && pw.chromium ? pw : null;
  } catch {
    return null;
  }
};

export interface PlaywrightAvailability {
  available: boolean;
  detail: string;
  nextStep?: string;
}

export async function playwrightAvailability(loader: PlaywrightLoader = defaultPlaywrightLoader): Promise<PlaywrightAvailability> {
  const pw = await loader();
  if (pw) return { available: true, detail: 'playwright module is importable (browser binaries are checked on first launch)' };
  return {
    available: false,
    detail: 'optional-disabled: the optional "playwright" package is not installed; raw HTTP crawling continues without rendering',
    nextStep: 'Only if you need JavaScript rendering: `npm install playwright` then `npx playwright install chromium`, and set features.playwright: true.',
  };
}

/** Chromium flags added to every render (defence in depth; not live-tested here). */
export const RENDER_LAUNCH_ARGS: readonly string[] = ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];

export interface RenderOptions {
  guard: SsrfGuard;
  loader?: PlaywrightLoader;
  userAgent: string;
  timeoutMs: number;
  /** Rendered HTML larger than this is truncated (and flagged). */
  maxHtmlChars?: number;
  /** Abort after this many subrequests. */
  maxSubrequests?: number;
  /** Resource types not needed for DOM discrepancies (saves bandwidth). */
  skipResourceTypes?: readonly string[];
  /** Starts the SSRF-enforcing proxy (tests may inject one). */
  proxyFactory?: GuardedProxyFactory;
}

export interface RenderResult {
  status: 'rendered' | 'optional_disabled' | 'blocked' | 'failed';
  url: string;
  finalUrl: string | null;
  httpStatus: number | null;
  html: string | null;
  htmlTruncated: boolean;
  blockedSubrequests: Array<{ url: string; reason: string }>;
  allowedSubrequests: number;
  /** SSRF protections that were active for this render. */
  protections: string[];
  durationMs: number;
  error: string | null;
  disclaimer: string;
}

export async function renderPage(url: string, opts: RenderOptions): Promise<RenderResult> {
  const started = Date.now();
  const base: RenderResult = {
    status: 'failed',
    url,
    finalUrl: null,
    httpStatus: null,
    html: null,
    htmlTruncated: false,
    blockedSubrequests: [],
    allowedSubrequests: 0,
    protections: [],
    durationMs: 0,
    error: null,
    disclaimer: RENDER_DISCLAIMER,
  };
  let proxy: GuardedProxy | null = null;
  const done = (patch: Partial<RenderResult>): RenderResult => {
    const blocked = [...base.blockedSubrequests];
    for (const b of proxy?.blocked ?? []) if (!blocked.some((x) => x.url === b.url && x.reason === b.reason)) blocked.push({ ...b, reason: `proxy:${b.reason}` });
    return { ...base, blockedSubrequests: blocked, ...patch, durationMs: Date.now() - started };
  };

  // The top-level URL must pass the guard before a browser is even launched.
  const first = await opts.guard.check(url);
  if (!first.ok) return done({ status: 'blocked', error: first.error.message, blockedSubrequests: [{ url, reason: first.error.reason }] });

  const pw = await (opts.loader ?? defaultPlaywrightLoader)();
  if (!pw) return done({ status: 'optional_disabled', error: 'playwright is not installed (optional)' });

  const maxSub = opts.maxSubrequests ?? 300;
  const skip = new Set(opts.skipResourceTypes ?? ['media', 'font', 'websocket', 'eventsource', 'manifest']);
  let browser: BrowserLike | null = null;
  let context: ContextLike | null = null;
  let page: PageLike | null = null;
  const hopChecks: Array<Promise<void>> = [];
  let unsafeHop: { url: string; reason: string } | null = null;
  try {
    try {
      proxy = await (opts.proxyFactory ?? startGuardedProxy)({ guard: opts.guard, maxRequests: maxSub * 2, connectTimeoutMs: Math.min(opts.timeoutMs, 10_000) });
    } catch (err) {
      return done({ status: 'failed', error: `Could not start the SSRF-enforcing proxy; not rendering: ${(err as Error).message ?? String(err)}` });
    }
    base.protections.push('guarded_proxy');
    browser = await pw.chromium.launch({
      headless: true,
      // "<-loopback>" removes Chromium's implicit proxy bypass for localhost/127.0.0.1/[::1].
      proxy: { server: proxy.server, bypass: '<-loopback>' },
      args: [...RENDER_LAUNCH_ARGS],
    });
    context = await browser.newContext({
      userAgent: opts.userAgent,
      acceptDownloads: false,
      serviceWorkers: 'block',
      javaScriptEnabled: true,
      ignoreHTTPSErrors: false,
      bypassCSP: false,
    });
    const ctxRef = context;
    if (typeof ctxRef.routeWebSocket === 'function') {
      await ctxRef.routeWebSocket(/.*/, async (ws) => {
        base.blockedSubrequests.push({ url: ws.url().slice(0, 500), reason: 'websocket_blocked' });
        await ws.close({ code: 1008, reason: 'blocked by seo-agent renderer' });
      });
      base.protections.push('websocket_block');
    }
    // Redirect hops are not shown to route(): validate each one and discard the render on a refused hop.
    if (typeof ctxRef.on === 'function') {
      ctxRef.on('request', (req) => {
        const from = req.redirectedFrom?.() ?? null;
        if (!from) return;
        const target = req.url();
        hopChecks.push(
          (async () => {
            const check = await opts.guard.check(target);
            if (check.ok) return;
            const hit = { url: target.slice(0, 500), reason: `redirect_hop:${check.error.reason}` };
            base.blockedSubrequests.push(hit);
            unsafeHop ??= hit;
            await page?.close().catch(() => undefined);
          })().catch(() => undefined),
        );
      });
      base.protections.push('redirect_hop_check');
    }
    let seen = 0;
    await ctxRef.route('**/*', async (route) => {
      const req = route.request();
      const target = req.url();
      if (/^(data|blob):/i.test(target)) return route.continue();
      seen++;
      if (seen > maxSub) {
        base.blockedSubrequests.push({ url: target.slice(0, 500), reason: 'subrequest cap reached' });
        return route.abort('blockedbyclient');
      }
      if (skip.has(req.resourceType())) return route.abort('blockedbyclient');
      const check = await opts.guard.check(target);
      if (!check.ok) {
        base.blockedSubrequests.push({ url: target.slice(0, 500), reason: check.error.reason });
        return route.abort('blockedbyclient');
      }
      base.allowedSubrequests++;
      return route.continue();
    });
    base.protections.push('route_guard');
    page = await ctxRef.newPage();
    let response: { status(): number } | null = null;
    let navError: unknown = null;
    try {
      response = await page.goto(url, { waitUntil: 'load', timeout: opts.timeoutMs });
    } catch (err) {
      navError = err;
    }
    await Promise.allSettled(hopChecks);
    const hop = unsafeHop as { url: string; reason: string } | null;
    if (hop) {
      return done({ status: 'blocked', error: `A browser redirect hop to a refused destination was detected (${hop.reason}: ${hop.url}); the render was discarded and no HTML was kept.` });
    }
    if (navError) throw navError;
    const finalUrl = page.url();
    const finalCheck = await opts.guard.check(finalUrl);
    if (!finalCheck.ok) {
      return done({ status: 'blocked', finalUrl: finalUrl.slice(0, 500), error: `The rendered page ended on a refused destination (${finalCheck.error.reason}); the render was discarded.` });
    }
    let html = await page.content();
    const max = opts.maxHtmlChars ?? 5_000_000;
    let truncated = false;
    if (html.length > max) {
      html = html.slice(0, max);
      truncated = true;
    }
    await page.close();
    return done({ status: 'rendered', finalUrl, httpStatus: response ? response.status() : null, html, htmlTruncated: truncated, allowedSubrequests: base.allowedSubrequests });
  } catch (err) {
    return done({ status: 'failed', error: (err as Error).message ?? String(err) });
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await proxy?.close().catch(() => undefined);
  }
}

export interface RenderDiscrepancies {
  disclaimer: string;
  title: { raw: string | null; rendered: string | null } | null;
  metaDescription: { raw: string | null; rendered: string | null } | null;
  canonical: { raw: string | null; rendered: string | null } | null;
  metaRobots: { raw: string | null; rendered: string | null } | null;
  h1: { raw: string[]; rendered: string[] } | null;
  wordCount: { raw: number; rendered: number; delta: number };
  internalLinks: { raw: number; rendered: number; onlyInRendered: string[]; onlyInRaw: string[] };
  structuredDataTypes: { raw: string[]; rendered: string[]; added: string[]; removed: string[] } | null;
  /** Main content appears only after JavaScript runs (inaccessible to non-rendering clients). */
  contentDependsOnJavascript: boolean;
  notes: string[];
}

function diffField(a: string | null, b: string | null): { raw: string | null; rendered: string | null } | null {
  return (a ?? '') === (b ?? '') ? null : { raw: a, rendered: b };
}

/** Compare raw-HTML extraction with rendered-DOM extraction. Pure. */
export function compareRawRendered(raw: PageExtraction, rendered: PageExtraction): RenderDiscrepancies {
  const rawLinks = new Set(raw.links.filter((l) => l.internal).map((l) => l.href));
  const renLinks = new Set(rendered.links.filter((l) => l.internal).map((l) => l.href));
  const h1Raw = raw.headings.filter((h) => h.level === 1).map((h) => h.text);
  const h1Ren = rendered.headings.filter((h) => h.level === 1).map((h) => h.text);
  const rawTypes = new Set(raw.structuredDataTypes);
  const renTypes = new Set(rendered.structuredDataTypes);
  const added = [...renTypes].filter((t) => !rawTypes.has(t));
  const removed = [...rawTypes].filter((t) => !renTypes.has(t));
  const delta = rendered.wordCount - raw.wordCount;
  const contentDependsOnJavascript = rendered.wordCount >= 50 && rendered.wordCount > raw.wordCount * 1.5 + 50;
  const d: RenderDiscrepancies = {
    disclaimer: RENDER_DISCLAIMER,
    title: diffField(raw.title, rendered.title),
    metaDescription: diffField(raw.metaDescription, rendered.metaDescription),
    canonical: diffField(raw.canonical, rendered.canonical),
    metaRobots: diffField(raw.metaRobots, rendered.metaRobots),
    h1: JSON.stringify(h1Raw) === JSON.stringify(h1Ren) ? null : { raw: h1Raw, rendered: h1Ren },
    wordCount: { raw: raw.wordCount, rendered: rendered.wordCount, delta },
    internalLinks: {
      raw: rawLinks.size,
      rendered: renLinks.size,
      onlyInRendered: [...renLinks].filter((l) => !rawLinks.has(l)).slice(0, 50),
      onlyInRaw: [...rawLinks].filter((l) => !renLinks.has(l)).slice(0, 50),
    },
    structuredDataTypes: added.length || removed.length ? { raw: [...rawTypes], rendered: [...renTypes], added, removed } : null,
    contentDependsOnJavascript,
    notes: [],
  };
  if (contentDependsOnJavascript) d.notes.push('Most visible text appears only after JavaScript runs; clients that do not render JavaScript see little content.');
  if (d.canonical) d.notes.push('The canonical differs between raw HTML and the rendered DOM (conflicting signals).');
  if (d.metaRobots) d.notes.push('Robots meta directives differ between raw HTML and the rendered DOM.');
  if (d.internalLinks.onlyInRendered.length) d.notes.push(`${d.internalLinks.onlyInRendered.length} internal link(s) exist only in the rendered DOM.`);
  return d;
}
