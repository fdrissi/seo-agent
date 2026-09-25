import { isAllowedHost } from '../seo/url.js';
import type { FetchLike } from '../integrations/types.js';

/**
 * Minimal read-only fetcher for the site's OWN pages, used for the
 * pre-execution target recheck and for verifying what actually went live.
 *
 * Restrictions: GET only, http/https only, host must be one of the site's
 * configured `allowedHostnames`, redirects are followed manually and only
 * within those hosts, response size and time are capped, no credentials or
 * cookies are sent. Offline/demo contexts return an honest `offline` result.
 *
 * Integration note: the crawler slice owns the SSRF-safe fetcher with DNS
 * revalidation. It can be injected here (any `PageFetcher`) without changing
 * callers.
 */

export interface FetchedPage {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  html: string;
  fetchedAt: string;
  redirectChain: string[];
}

export type PageFetchFailure = 'offline' | 'blocked_host' | 'unsafe_url' | 'http_error' | 'network_error' | 'too_large' | 'unsupported_content' | 'too_many_redirects' | 'timeout';

export type PageFetchResult = { ok: true; page: FetchedPage } | { ok: false; reason: PageFetchFailure; detail: string; status?: number };

export type PageFetcher = (url: string) => Promise<PageFetchResult>;

export interface SitePageFetcherOptions {
  fetch: FetchLike;
  offline: boolean;
  allowedHostnames: readonly string[];
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  now?: () => Date;
}

export function createSitePageFetcher(opts: SitePageFetcherOptions): PageFetcher {
  const now = opts.now ?? (() => new Date());
  return async (url: string): Promise<PageFetchResult> => {
    if (opts.offline) return { ok: false, reason: 'offline', detail: 'Network access is disabled (offline/demo mode); live state could not be checked.' };
    const chain: string[] = [];
    let current = url;
    for (let hop = 0; hop <= opts.maxRedirects; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(current);
      } catch {
        return { ok: false, reason: 'unsafe_url', detail: `Not an absolute URL: ${current}` };
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false, reason: 'unsafe_url', detail: `Unsupported scheme ${parsed.protocol}` };
      if (parsed.username || parsed.password) return { ok: false, reason: 'unsafe_url', detail: 'URLs with embedded credentials are refused.' };
      if (!isAllowedHost(parsed.href, opts.allowedHostnames)) {
        return { ok: false, reason: 'blocked_host', detail: `Host ${parsed.hostname} is not one of the site's allowedHostnames.` };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      let res: Response;
      try {
        res = await opts.fetch(parsed.href, {
          method: 'GET',
          redirect: 'manual',
          headers: { 'user-agent': opts.userAgent, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const e = err as { code?: string; name?: string; message?: string };
        if (e?.code === 'OFFLINE') return { ok: false, reason: 'offline', detail: 'Network access is disabled; live state could not be checked.' };
        if (e?.name === 'AbortError') return { ok: false, reason: 'timeout', detail: `Timed out after ${opts.timeoutMs} ms` };
        return { ok: false, reason: 'network_error', detail: String(e?.message ?? err) };
      }
      if (res.status >= 300 && res.status < 400) {
        clearTimeout(timer);
        const loc = res.headers.get('location');
        if (!loc) return { ok: false, reason: 'http_error', detail: `Redirect ${res.status} without Location`, status: res.status };
        chain.push(parsed.href);
        current = new URL(loc, parsed.href).href;
        continue;
      }
      try {
        const ct = res.headers.get('content-type');
        if (res.status >= 400) return { ok: false, reason: 'http_error', detail: `HTTP ${res.status}`, status: res.status };
        if (ct && !/html|xml|text\/plain/i.test(ct)) return { ok: false, reason: 'unsupported_content', detail: `Content-Type ${ct}`, status: res.status };
        const len = Number(res.headers.get('content-length') ?? '0');
        if (len > opts.maxBytes) return { ok: false, reason: 'too_large', detail: `Content-Length ${len} exceeds ${opts.maxBytes}`, status: res.status };
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength > opts.maxBytes) return { ok: false, reason: 'too_large', detail: `Body exceeds ${opts.maxBytes} bytes`, status: res.status };
        return {
          ok: true,
          page: { requestedUrl: url, finalUrl: parsed.href, status: res.status, contentType: ct, html: new TextDecoder('utf-8').decode(buf), fetchedAt: now().toISOString(), redirectChain: chain },
        };
      } catch (err) {
        const e = err as { name?: string; message?: string };
        if (e?.name === 'AbortError') return { ok: false, reason: 'timeout', detail: `Timed out after ${opts.timeoutMs} ms` };
        return { ok: false, reason: 'network_error', detail: String(e?.message ?? err) };
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: false, reason: 'too_many_redirects', detail: `More than ${opts.maxRedirects} redirects` };
  };
}

/** Context fields the default site fetcher needs. */
export interface SitePageFetcherContext {
  fetch: FetchLike;
  offline: boolean;
  config: { site: { allowedHostnames: string[] }; crawl: { userAgent: string; timeoutMs: number; maxBytes: number; maxRedirects: number } };
  clock: { now(): Date };
}

/**
 * Factory installed by the integration layer (src/app/wiring.ts) that builds
 * the crawler's SSRF-safe fetcher (DNS revalidation, pinned connections,
 * per-hop checks) for a context. Without one, the minimal fetcher above is
 * used (host allowlist and schemes only, no DNS revalidation).
 */
export type SitePageFetcherFactory = (ctx: SitePageFetcherContext) => PageFetcher;

let registeredFactory: SitePageFetcherFactory | null = null;

/** Register (or clear with null) the site page fetcher factory. */
export function registerSitePageFetcherFactory(factory: SitePageFetcherFactory | null): void {
  registeredFactory = factory;
}

/** Build the site fetcher from an application context (the registered SSRF-safe fetcher when wired). */
export function sitePageFetcherFromContext(ctx: SitePageFetcherContext): PageFetcher {
  if (registeredFactory) return registeredFactory(ctx);
  return createSitePageFetcher({
    fetch: ctx.fetch,
    offline: ctx.offline,
    allowedHostnames: ctx.config.site.allowedHostnames,
    userAgent: ctx.config.crawl.userAgent,
    timeoutMs: ctx.config.crawl.timeoutMs,
    maxBytes: ctx.config.crawl.maxBytes,
    maxRedirects: ctx.config.crawl.maxRedirects,
    now: () => ctx.clock.now(),
  });
}
