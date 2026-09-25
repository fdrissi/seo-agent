import type { AppContext } from '../app/context.js';
import type { IntegrationStatus, StatusCheckOptions } from '../integrations/types.js';
import { buildFetcher, type CrawlerDeps } from './deps.js';
import { playwrightAvailability } from './render.js';
import { networkRetryStep } from './crawl.js';
import { fetchRobots, isTransientRobotsFailure, originOf } from './robots.js';

/**
 * Honest crawler / Playwright status. `IntegrationId` (foundation) has no
 * 'crawler' member, so the crawler status uses a local widened id type.
 */
export type CrawlerIntegrationStatus = Omit<IntegrationStatus, 'id'> & { id: 'crawler' };

export interface CrawlerStatusReport {
  crawler: CrawlerIntegrationStatus;
  playwright: IntegrationStatus;
  lastCrawl: { id: string; kind: string; status: string; startedAt: string; finishedAt: string | null; pagesFetched: number; pagesBlocked: number; stopReason: string | null } | null;
}

const CRAWLER_SENDS = [
  'HTTP GET requests (with the configured User-Agent) to your own site: robots.txt, sitemaps, and pages',
  'For competitor research only: GET requests to selected competitor pages and their robots.txt',
  'No cookies, credentials, or API keys are sent',
];
const PLAYWRIGHT_SENDS = ['A local headless Chromium loads the page and subresources that pass the SSRF guard (same destinations as a normal browser visit)'];

export async function crawlerStatus(ctx: AppContext, opts: StatusCheckOptions & CrawlerDeps): Promise<CrawlerStatusReport> {
  const at = ctx.clock.now().toISOString();
  const last = ctx.db.get<{ id: string; kind: string; status: string; started_at: string; finished_at: string | null; pages_fetched: number; pages_blocked: number; stop_reason: string | null }>(
    'SELECT id, kind, status, started_at, finished_at, pages_fetched, pages_blocked, stop_reason FROM crawls WHERE site_id = ? ORDER BY started_at DESC LIMIT 1',
    [ctx.siteId],
  );
  const lastCrawl = last
    ? { id: last.id, kind: last.kind, status: last.status, startedAt: last.started_at, finishedAt: last.finished_at, pagesFetched: last.pages_fetched, pagesBlocked: last.pages_blocked, stopReason: last.stop_reason }
    : null;
  const base = { id: 'crawler' as const, sendsExternally: CRAWLER_SENDS, checkedAt: at, networkChecked: false, chargeable: false };
  let crawler: CrawlerIntegrationStatus;
  if (!ctx.settings.features.crawl) crawler = { ...base, state: 'disabled', detail: 'features.crawl is off.', nextStep: 'Set features.crawl: true in the site config.' };
  else if (ctx.synthetic) crawler = { ...base, state: 'fixture', detail: 'Demo mode: crawling uses synthetic fixture pages only.' };
  else if (ctx.offline || !opts.network) {
    crawler = { ...base, state: 'configured_unverified', detail: `Crawler configured (max ${ctx.config.crawl.maxPages} pages, depth ${ctx.config.crawl.maxDepth}); no network check performed${ctx.offline ? ' (offline mode)' : ''}.` };
  } else {
    const fetcher = buildFetcher(ctx, opts);
    const policy = await fetchRobots(fetcher, originOf(ctx.config.site.url), { now: () => ctx.clock.now() });
    const i = policy.info;
    if (i.state === 'parsed' || i.state === 'not_found') {
      const home = policy.isAllowed(ctx.config.site.url);
      crawler = {
        ...base,
        networkChecked: true,
        state: home.allowed ? 'ready' : 'degraded',
        detail: `robots.txt ${i.state === 'parsed' ? 'parsed' : 'absent (HTTP ' + i.httpStatus + ')'}; start URL ${home.allowed ? 'allowed' : `blocked: ${home.reason}`}.`,
        ...(home.allowed ? {} : { nextStep: 'The site robots.txt disallows this crawler for the start URL; the crawler will not bypass it.' }),
      };
    } else if (i.state === 'unsafe' && i.errorCode !== 'unsafe_url:dns_failure') {
      // A real SSRF policy refusal of the configured site (private/loopback/metadata destination, blocked port).
      crawler = { ...base, networkChecked: true, state: 'misconfigured', detail: i.note, nextStep: 'site.url must be a public http(s) URL on a default port; the SSRF guard refuses private, loopback, and metadata destinations.' };
    } else if (i.errorCode === 'unsafe_url:dns_failure' || isTransientRobotsFailure(i)) {
      // DNS failure, connection error, or timeout: a transient network problem, never a site.url problem.
      const host = new URL(ctx.config.site.url).hostname;
      crawler = { ...base, networkChecked: true, state: 'unreachable', detail: i.note, nextStep: networkRetryStep(host) };
    } else {
      crawler = { ...base, networkChecked: true, state: 'unreachable', detail: i.note };
    }
  }

  const pbase = { id: 'playwright' as const, sendsExternally: PLAYWRIGHT_SENDS, checkedAt: at, networkChecked: false, chargeable: false };
  let playwright: IntegrationStatus;
  if (!ctx.settings.features.playwright) playwright = { ...pbase, state: 'disabled', detail: 'optional-disabled: features.playwright is off; raw HTTP crawling is used.' };
  else {
    const a = await playwrightAvailability(opts.playwrightLoader);
    playwright = a.available
      ? { ...pbase, state: 'configured_unverified', detail: `${a.detail}. Rendering is used only for pages whose raw HTML looks JavaScript-dependent, and is never presented as equivalent to Googlebot.` }
      : { ...pbase, state: 'disabled', detail: a.detail, ...(a.nextStep ? { nextStep: a.nextStep } : {}) };
  }
  return { crawler, playwright, lastCrawl };
}
