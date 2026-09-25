import type { AppContext } from '../app/context.js';
import { SsrfGuard, type Resolver } from '../security/ssrf.js';
import { SafeFetcher } from './fetch.js';
import { createPinnedTransport, type HttpTransport } from './transport.js';
import type { PlaywrightLoader } from './render.js';

/**
 * Injectable crawler dependencies. Production code passes nothing and gets
 * the SSRF guard (system DNS) + DNS-pinned undici transport built from the
 * site's crawl configuration. Tests/demo inject a resolver, transport, or a
 * complete fetcher. The generic crawler never uses ctx.fetch: fixed adapters
 * (Qdrant, LLM Gateway, Google APIs) have their own clients.
 */
export interface CrawlerDeps {
  fetcher?: SafeFetcher;
  guard?: SsrfGuard;
  transport?: HttpTransport;
  resolver?: Resolver;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  playwrightLoader?: PlaywrightLoader;
}

/** Non-default port of the configured site URL is implicitly allowlisted for its own host. */
export function siteHostPorts(ctx: AppContext): string[] {
  const out: string[] = [];
  try {
    const u = new URL(ctx.config.site.url);
    if (u.port) {
      for (const h of ctx.config.site.allowedHostnames) out.push(`${h.toLowerCase()}:${u.port}`);
    }
  } catch {
    /* invalid URLs are rejected by config validation */
  }
  return out;
}

export function buildGuard(ctx: AppContext, deps: CrawlerDeps = {}): SsrfGuard {
  if (deps.guard) return deps.guard;
  return new SsrfGuard({ ...(deps.resolver ? { resolver: deps.resolver } : {}), allowedHostPorts: siteHostPorts(ctx) });
}

export function buildFetcher(ctx: AppContext, deps: CrawlerDeps = {}): SafeFetcher {
  if (deps.fetcher) return deps.fetcher;
  const c = ctx.config.crawl;
  return new SafeFetcher({
    guard: buildGuard(ctx, deps),
    transport: deps.transport ?? createPinnedTransport({ connectTimeoutMs: Math.min(c.timeoutMs, 10_000) }),
    userAgent: c.userAgent,
    timeoutMs: c.timeoutMs,
    maxBytes: c.maxBytes,
    maxRedirects: c.maxRedirects,
    perHostConcurrency: c.perHostConcurrency,
    delayMs: c.requestDelayMs,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
}

/**
 * Network policy: in offline/demo mode the crawler may only use an injected
 * fixture transport/fetcher. Returns a reason string when the crawl must not run.
 */
export function offlineBlock(ctx: AppContext, deps: CrawlerDeps): string | null {
  if (!ctx.offline) return null;
  const kind = deps.fetcher?.transport.kind ?? deps.transport?.kind;
  if (kind === 'fixture') return null;
  return 'Network access is disabled (offline/demo mode); no crawl requests were made.';
}
