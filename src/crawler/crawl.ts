import type { AppContext } from '../app/context.js';
import { DEFAULT_WORKERS, mapBounded } from '../core/concurrency.js';
import { AppError } from '../core/errors.js';
import { recordAudit } from '../database/audit.js';
import { normalizeUrl } from '../seo/url.js';
import { runTechnicalChecks, type TechnicalCheckSummary } from './checks.js';
import { buildFetcher, buildGuard, offlineBlock, type CrawlerDeps } from './deps.js';
import { extractPage, loginBarrierAssessment, type PageExtraction } from './extract.js';
import { REDIRECT_STATUSES, type HopDecision, type SafeFetcher } from './fetch.js';
import { compareRawRendered, playwrightAvailability, renderPage, type RenderDiscrepancies } from './render.js';
import { isTransientRobotsFailure, originOf, RobotsCache } from './robots.js';
import { discoverSitemaps, type SitemapDiscovery } from './sitemaps.js';
import {
  createCrawl,
  finishCrawl,
  insertInternalLinks,
  insertResult,
  lifecycleFor,
  linkTargetsToPages,
  recordRobots,
  recordSitemaps,
  saveText,
  upsertPage,
  type CrawlKind,
} from './store.js';
import { matchesAnyPath, TrapDetector, type TrapLimits } from './traps.js';
import type { BlockedReason, CrawlCounts, SafeFetchResult } from './types.js';

/**
 * Own-site crawl: robots.txt -> bounded sitemap discovery -> breadth-first
 * crawl of allowed hostnames with depth/page caps, trap prevention, excluded
 * paths, per-host politeness, and honest block reasons. Results go to
 * crawls / crawl_results / pages / internal_links, then technical checks run.
 */

export const NON_HTML_EXTENSIONS = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|zip|gz|tgz|tar|rar|7z|mp4|m4v|mp3|m4a|mov|avi|wmv|webm|ogg|wav|flac|docx?|xlsx?|pptx?|odt|ods|csv|exe|dmg|pkg|apk|iso|css|js|mjs|json|woff2?|ttf|otf|eot|xml|txt|rss|atom)$/i;

export type CrawlRunStatus = 'completed' | 'partial' | 'failed' | 'cancelled' | 'disabled' | 'offline' | 'dry_run';

export interface CrawlSiteOptions extends CrawlerDeps {
  startUrl?: string;
  maxPages?: number;
  maxDepth?: number;
  useSitemaps?: boolean;
  /** Render JS-dependent pages with Playwright when installed and features.playwright is on. */
  render?: boolean;
  maxRenderPages?: number;
  workers?: number;
  trapLimits?: Partial<TrapLimits>;
  runChecks?: boolean;
  jobId?: string | null;
  signal?: AbortSignal;
}

export interface CrawlPlan {
  kind: CrawlKind;
  startUrl: string;
  allowedHostnames: string[];
  maxPages: number;
  maxDepth: number;
  useSitemaps: boolean;
  maxSitemapFiles: number;
  maxSitemapUrls: number;
  excludedPaths: string[];
  userAgent: string;
  requestDelayMs: number;
  perHostConcurrency: number;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  render: boolean;
  guard: ReturnType<ReturnType<typeof buildGuard>['describe']>;
  transport: string;
}

export interface RenderSummary {
  requested: boolean;
  status: 'not_requested' | 'disabled_by_config' | 'optional_disabled' | 'available';
  rendered: number;
  detail: string;
}

export interface CrawlSiteResult {
  status: CrawlRunStatus;
  crawlId: string | null;
  kind: CrawlKind;
  startUrl: string;
  stopReason: string | null;
  counts: CrawlCounts;
  unvisited: number;
  depthLimited: number;
  robots: Array<{ origin: string; state: string; note: string; sitemaps: string[]; crawlDelayMs: number | null }>;
  sitemaps: { files: number; parsed: number; urls: number; truncated: boolean; notes: string[] } | null;
  trapHits: number;
  render: RenderSummary;
  checks: TechnicalCheckSummary | null;
  transport: 'pinned' | 'injected' | 'fixture';
  isSynthetic: boolean;
  notes: string[];
  plan: CrawlPlan;
  nextStep?: string;
  /**
   * Machine-readable cause of a crawl that failed before anything was
   * requested: 'CRAWL_NETWORK_ERROR' for a transient network/DNS problem
   * (retry later; site.url is not at fault), 'CRAWL_START_URL_REFUSED' for an
   * SSRF policy refusal of the start URL (site.url must change). Absent otherwise.
   */
  failureCode?: 'CRAWL_NETWORK_ERROR' | 'CRAWL_START_URL_REFUSED';
}

/** Retry guidance for a transient network/DNS failure of the own-site crawl (never "change site.url"). */
export function networkRetryStep(host: string): string {
  return `This is a network/DNS problem on this machine or at the DNS provider, not a site.url problem: check the network connection and DNS (does ${host} resolve?), then re-run the crawl. \`npm run cli -- crawl status --network\` re-checks reachability.`;
}

/** DNS failures are transient (retry later), never an SSRF policy block (same rule as the competitor crawler). */
export function isDnsFailure(r: Pick<SafeFetchResult, 'errorCode'>): boolean {
  return r.errorCode === 'unsafe_url:dns_failure';
}

interface QueueItem {
  url: string;
  depth: number;
  via: string[];
}

function emptyCounts(): CrawlCounts {
  return { attempted: 0, fetched: 0, blocked: 0, failed: 0, skipped: 0 };
}

function normKey(url: string): string | null {
  return normalizeUrl(url)?.url ?? null;
}

function lower(a: readonly string[]): string[] {
  return a.map((h) => h.toLowerCase());
}

function buildPlan(ctx: AppContext, kind: CrawlKind, startUrl: string, opts: CrawlSiteOptions, fetcher: SafeFetcher | null): CrawlPlan {
  const c = ctx.config.crawl;
  const guard = fetcher?.guard ?? buildGuard(ctx, opts);
  return {
    kind,
    startUrl,
    allowedHostnames: lower(ctx.config.site.allowedHostnames),
    maxPages: kind === 'single_page' ? 1 : (opts.maxPages ?? c.maxPages),
    maxDepth: kind === 'single_page' ? 0 : (opts.maxDepth ?? c.maxDepth),
    useSitemaps: kind === 'own_site' && opts.useSitemaps !== false,
    maxSitemapFiles: c.maxSitemapFiles,
    maxSitemapUrls: c.maxSitemapUrls,
    excludedPaths: [...c.excludedPaths],
    userAgent: fetcher?.userAgent ?? c.userAgent,
    requestDelayMs: c.requestDelayMs,
    perHostConcurrency: c.perHostConcurrency,
    timeoutMs: c.timeoutMs,
    maxBytes: c.maxBytes,
    maxRedirects: c.maxRedirects,
    render: !!opts.render,
    guard: guard.describe(),
    transport: fetcher?.transport.kind ?? opts.transport?.kind ?? 'pinned',
  };
}

function baseResult(kind: CrawlKind, startUrl: string, plan: CrawlPlan, status: CrawlRunStatus, notes: string[] = []): CrawlSiteResult {
  return {
    status,
    crawlId: null,
    kind,
    startUrl,
    stopReason: null,
    counts: emptyCounts(),
    unvisited: 0,
    depthLimited: 0,
    robots: [],
    sitemaps: null,
    trapHits: 0,
    render: { requested: plan.render, status: 'not_requested', rendered: 0, detail: 'Rendering not requested.' },
    checks: null,
    transport: plan.transport as CrawlSiteResult['transport'],
    isSynthetic: false,
    notes,
    plan,
  };
}

class CrawlSession {
  readonly counts = emptyCounts();
  readonly seen = new Set<string>();
  readonly allowedHosts: Set<string>;
  readonly robots: RobotsCache;
  readonly traps: TrapDetector;
  readonly notes: string[] = [];
  unvisited = 0;
  depthLimited = 0;
  capped = false;
  fetchedSlots = 0;
  rendered = 0;
  renderAvailable = false;
  sitemapUrls = new Set<string>();

  constructor(
    readonly ctx: AppContext,
    readonly crawlId: string,
    readonly fetcher: SafeFetcher,
    readonly plan: CrawlPlan,
    readonly opts: CrawlSiteOptions,
    readonly followLinks: boolean,
  ) {
    this.allowedHosts = new Set(plan.allowedHostnames);
    this.robots = new RobotsCache(fetcher, {
      ...(opts.signal ? { signal: opts.signal } : {}),
      now: () => ctx.clock.now(),
      onFetched: (p) => recordRobots(ctx, crawlId, p),
    });
    this.traps = new TrapDetector(opts.trapLimits ?? {});
  }

  get renderMode(): 'http' | 'fixture' {
    return this.fetcher.transport.kind === 'fixture' ? 'fixture' : 'http';
  }

  private hopPolicy = async (url: URL, hop: number): Promise<HopDecision> => {
    if (hop === 0) return null;
    if (!this.allowedHosts.has(url.hostname.toLowerCase())) {
      return { stop: true, blockedReason: null, note: `Redirects to ${url.host}, outside allowedHostnames; not followed.`, errorCode: 'offsite_redirect' };
    }
    const ex = matchesAnyPath(url.pathname, this.plan.excludedPaths);
    if (ex) return { stop: true, blockedReason: 'excluded', note: `Redirect target matches crawl.excludedPaths "${ex}".` };
    const d = await this.robots.isAllowed(url);
    if (!d.allowed) return { stop: true, blockedReason: 'robots', note: `Redirect target ${d.reason}` };
    return null;
  };

  private recordSkip(item: QueueItem, reason: BlockedReason, error: string, robotsAllowed: boolean | null, createPage: boolean): void {
    const pageId = createPage ? upsertPage(this.ctx, item.url, { source: item.via.includes('sitemap') && !item.via.includes('link') ? 'sitemap' : 'crawl' }) : null;
    insertResult(this.ctx, {
      crawlId: this.crawlId,
      pageId,
      requestedUrl: item.url,
      fetch: null,
      renderMode: this.renderMode,
      robotsAllowed,
      extraction: null,
      textRef: null,
      blockedReason: reason,
      error,
      depth: item.depth,
      discoveredVia: item.via,
      inSitemap: this.sitemapUrls.has(item.url),
    });
  }

  private enqueue(next: QueueItem[], href: string, depth: number, via: string): void {
    const key = normKey(href);
    if (!key) return;
    let u: URL;
    try {
      u = new URL(key);
    } catch {
      return;
    }
    if (!this.allowedHosts.has(u.hostname.toLowerCase())) return;
    if (NON_HTML_EXTENSIONS.test(u.pathname)) return;
    if (this.seen.has(key)) return;
    if (depth > this.plan.maxDepth) {
      this.depthLimited++;
      return;
    }
    this.seen.add(key);
    next.push({ url: key, depth, via: [via] });
  }

  async process(item: QueueItem, next: QueueItem[]): Promise<void> {
    const { ctx } = this;
    let u: URL;
    try {
      u = new URL(item.url);
    } catch {
      return;
    }
    const excluded = matchesAnyPath(u.pathname, this.plan.excludedPaths);
    if (excluded) {
      this.counts.skipped++;
      this.recordSkip(item, 'excluded', `Matches crawl.excludedPaths pattern "${excluded}"; not fetched.`, null, false);
      return;
    }
    const trap = this.traps.check(u);
    if (trap.trap) {
      this.counts.skipped++;
      this.recordSkip(item, 'crawl_trap', `Crawler-trap guard: ${trap.reason}; not fetched.`, null, false);
      return;
    }
    const robots = await this.robots.isAllowed(u);
    if (!robots.allowed) {
      this.counts.blocked++;
      this.recordSkip(item, 'robots', robots.reason, false, true);
      return;
    }
    const backoff = this.fetcher.hostBackoff(u.host);
    if (backoff) {
      this.counts.blocked++;
      this.recordSkip(item, 'rate_limited', `Not requested: ${u.host} asked this crawler to back off (${backoff.note}); remaining URLs on this host are skipped until then.`, true, true);
      return;
    }
    if (this.fetcher.rateLimitedStreak(u.host) >= 3) {
      this.counts.blocked++;
      this.recordSkip(item, 'rate_limited', `${u.host} repeatedly rate-limited this crawl; remaining URLs on this host were not requested.`, true, true);
      return;
    }
    if (this.fetchedSlots >= this.plan.maxPages) {
      this.unvisited++;
      this.capped = true;
      return;
    }
    this.fetchedSlots++;
    this.counts.attempted++;
    const r = await this.fetcher.fetch(item.url, { accept: ['html'], beforeHop: this.hopPolicy, ...(this.opts.signal ? { signal: this.opts.signal } : {}) });
    if (r.attempts === 0) {
      // The host entered a rate-limit back-off while this URL was queued: nothing was sent.
      this.counts.attempted--;
      this.fetchedSlots--;
    }
    await this.handleFetch(item, r, next);
  }

  private async handleFetch(item: QueueItem, fetched: SafeFetchResult, next: QueueItem[]): Promise<void> {
    const { ctx } = this;
    // A DNS failure (resolver error, timeout, empty answer) is transient, not an SSRF policy block:
    // record it as a network error so the crawl reports it as "re-crawl later" (errorCode keeps the cause).
    const r: SafeFetchResult = fetched.blockedReason === 'unsafe_url' && isDnsFailure(fetched) ? { ...fetched, blockedReason: 'network_error' } : fetched;
    const finalKey = r.finalUrl ? normKey(r.finalUrl) : null;
    const redirected = r.redirectChain.length > 0 && finalKey !== null && finalKey !== item.url;
    const failed = r.blockedReason === 'timeout' || r.blockedReason === 'network_error' || (r.errorCode !== null && !r.blockedReason && r.errorCode !== 'offsite_redirect');
    if (r.blockedReason) this.counts.blocked++;
    else if (failed) this.counts.failed++;
    else this.counts.fetched++;
    // The redirect chain reached a final (non-redirect) response for r.finalUrl. When a hop policy,
    // the SSRF guard, a loop, the redirect cap, or a login redirect stopped the chain, the final
    // URL was never requested and there is no final status.
    const chainComplete = r.redirectChain.length > 0 && r.status !== null && !REDIRECT_STATUSES.has(r.status);
    const finalStatus = chainComplete ? r.status : null;
    const extra = { fetchErrorCode: r.errorCode, note: r.note, attempts: r.attempts, pinned: r.pinned, durationMs: r.durationMs, finalStatus };
    const isContentResponse = r.status !== null && r.status >= 200 && r.status < 300 && r.text !== null && !r.blockedReason;

    if (redirected) {
      // Row for the requested (redirecting) URL: status of the first response, no content.
      const pageId = upsertPage(ctx, item.url, { source: item.via.includes('sitemap') && !item.via.includes('link') ? 'sitemap' : 'crawl', lifecycle: 'redirected' });
      insertResult(ctx, {
        crawlId: this.crawlId,
        pageId,
        requestedUrl: item.url,
        fetch: r,
        renderMode: this.renderMode,
        robotsAllowed: true,
        extraction: null,
        textRef: null,
        blockedReason: isContentResponse ? null : r.blockedReason,
        error: r.error ?? (r.errorCode === 'offsite_redirect' ? r.note : null),
        depth: item.depth,
        discoveredVia: item.via,
        inSitemap: this.sitemapUrls.has(item.url),
        extra,
      });
      // The final URL gets its own row from the same response (no second request), including
      // non-2xx finals (404/410/5xx/...), so a redirect to a dead page is visible as such.
      if (chainComplete && finalKey && this.allowedHosts.has(new URL(finalKey).hostname.toLowerCase()) && !this.seen.has(finalKey)) {
        this.seen.add(finalKey);
        const finalItem: QueueItem = { url: finalKey, depth: item.depth, via: ['redirect'] };
        if (isContentResponse) await this.storeContent(finalItem, r, next, { finalUrlOverride: finalKey, statusOverride: r.status, redirectChainOverride: null });
        else this.storeFinalWithoutContent(finalItem, r, item.url);
      }
      return;
    }
    if (isContentResponse) {
      await this.storeContent(item, r, next, {});
      return;
    }
    const pageId = upsertPage(ctx, item.url, { source: item.via.includes('sitemap') && !item.via.includes('link') ? 'sitemap' : 'crawl', lifecycle: lifecycleFor(r.firstStatus, false) });
    insertResult(ctx, {
      crawlId: this.crawlId,
      pageId,
      requestedUrl: item.url,
      fetch: r,
      renderMode: this.renderMode,
      robotsAllowed: true,
      extraction: null,
      textRef: null,
      blockedReason: r.blockedReason,
      error: r.error ?? r.note,
      depth: item.depth,
      discoveredVia: item.via,
      inSitemap: this.sitemapUrls.has(item.url),
      extra,
    });
  }

  /** Row for the final URL of a completed redirect chain whose final response carried no usable content. */
  private storeFinalWithoutContent(item: QueueItem, r: SafeFetchResult, reachedFrom: string): void {
    const pageId = upsertPage(this.ctx, item.url, { source: 'crawl', lifecycle: lifecycleFor(r.status, false) });
    insertResult(this.ctx, {
      crawlId: this.crawlId,
      pageId,
      requestedUrl: item.url,
      fetch: r,
      renderMode: this.renderMode,
      robotsAllowed: true,
      extraction: null,
      textRef: null,
      blockedReason: r.blockedReason,
      error: r.error ?? r.note ?? (r.status !== null && (r.status < 200 || r.status >= 300) ? `HTTP ${r.status} (reached by redirect from ${reachedFrom})` : null),
      depth: item.depth,
      discoveredVia: item.via,
      inSitemap: this.sitemapUrls.has(item.url),
      finalUrlOverride: item.url,
      statusOverride: r.status,
      redirectChainOverride: null,
      extra: { fetchErrorCode: r.errorCode, note: r.note, finalStatus: r.status, reachedByRedirectFrom: reachedFrom },
    });
  }

  private async storeContent(
    item: QueueItem,
    r: SafeFetchResult,
    next: QueueItem[],
    overrides: { finalUrlOverride?: string; statusOverride?: number | null; redirectChainOverride?: null },
  ): Promise<void> {
    const { ctx } = this;
    const finalUrl = overrides.finalUrlOverride ?? r.finalUrl ?? item.url;
    const x = extractPage(r.text ?? '', { url: finalUrl, headers: r.headers, internalHosts: this.plan.allowedHostnames });
    const login = loginBarrierAssessment(x, new URL(finalUrl));
    const loginBarrier = login.barrier;
    let discrepancies: RenderDiscrepancies | undefined;
    let renderMode: 'http' | 'playwright' | 'fixture' = this.renderMode;
    if (this.renderAvailable && x.jsShellSuspected && this.rendered < (this.opts.maxRenderPages ?? 10)) {
      this.rendered++;
      const rendered = await renderPage(finalUrl, {
        guard: this.fetcher.guard,
        ...(this.opts.playwrightLoader ? { loader: this.opts.playwrightLoader } : {}),
        userAgent: this.fetcher.userAgent,
        timeoutMs: this.plan.timeoutMs * 2,
      });
      if (rendered.status === 'rendered' && rendered.html) {
        const rx = extractPage(rendered.html, { url: finalUrl, headers: r.headers, internalHosts: this.plan.allowedHostnames });
        discrepancies = compareRawRendered(x, rx);
        discrepancies.notes.push(`${rendered.blockedSubrequests.length} browser subrequest(s) blocked by the SSRF guard.`);
        renderMode = 'playwright';
      } else if (rendered.status === 'blocked' || rendered.status === 'failed') {
        this.notes.push(`${finalUrl}: render ${rendered.status === 'blocked' ? 'discarded' : 'failed'} (${(rendered.error ?? 'unknown error').slice(0, 300)}); raw HTML results kept.`);
      }
    }
    const textRef = x.text ? saveText(ctx, { url: finalUrl, text: x.text, untrusted: false }) : null;
    const pageId = upsertPage(ctx, finalUrl, { source: item.via.includes('sitemap') && !item.via.includes('link') ? 'sitemap' : 'crawl', lifecycle: 'active', language: x.language });
    const resultId = insertResult(ctx, {
      crawlId: this.crawlId,
      pageId,
      requestedUrl: item.url,
      fetch: r,
      renderMode,
      robotsAllowed: true,
      extraction: x,
      textRef,
      blockedReason: loginBarrier ? 'login_required' : null,
      error: loginBarrier ? `Sign-in page detected (heuristic: ${login.signals.join(', ')}); treated as a login barrier. Links on this page were not followed.` : null,
      depth: item.depth,
      discoveredVia: item.via,
      inSitemap: this.sitemapUrls.has(item.url),
      extra: {
        fetchErrorCode: r.errorCode,
        attempts: r.attempts,
        pinned: r.pinned,
        durationMs: r.durationMs,
        finalStatus: r.status,
        loginBarrier,
        ...(loginBarrier ? { barrierDetection: 'login_form_heuristic', barrierSignals: login.signals } : {}),
        ...(!loginBarrier && x.loginForm ? { loginHint: login.hint } : {}),
      },
      ...(overrides.finalUrlOverride !== undefined ? { finalUrlOverride: overrides.finalUrlOverride } : {}),
      ...(overrides.statusOverride !== undefined ? { statusOverride: overrides.statusOverride } : {}),
      ...(overrides.redirectChainOverride !== undefined ? { redirectChainOverride: overrides.redirectChainOverride } : {}),
      ...(discrepancies ? { renderDiscrepancies: discrepancies } : {}),
    });
    if (loginBarrier) {
      this.counts.fetched--;
      this.counts.blocked++;
      return;
    }
    insertInternalLinks(ctx, this.crawlId, resultId, pageId, x.links);
    if (!this.followLinks) return;
    if (x.robots.nofollow) {
      this.notes.push(`${item.url}: meta robots nofollow respected; links on this page were not followed.`);
      return;
    }
    for (const l of x.links) if (l.internal) this.enqueue(next, l.href, item.depth + 1, 'link');
    if (x.metaRefresh?.url) this.enqueue(next, x.metaRefresh.url, item.depth + 1, 'meta_refresh');
  }
}

async function prepare(ctx: AppContext, kind: CrawlKind, startUrl: string, opts: CrawlSiteOptions): Promise<{ result?: CrawlSiteResult; fetcher?: SafeFetcher; plan: CrawlPlan }> {
  const injectedFetcher = opts.fetcher ?? null;
  const plan = buildPlan(ctx, kind, startUrl, opts, injectedFetcher);
  if (!ctx.settings.features.crawl) {
    return { plan, result: { ...baseResult(kind, startUrl, plan, 'disabled', ['Crawling is disabled for this site (features.crawl: false).']), nextStep: 'Set features.crawl: true in the site config to enable crawling.' } };
  }
  let start: URL;
  try {
    start = new URL(startUrl);
  } catch {
    throw new AppError('VALIDATION_FAILED', `Invalid start URL: ${startUrl}`);
  }
  if (!plan.allowedHostnames.includes(start.hostname.toLowerCase())) {
    throw new AppError('VALIDATION_FAILED', `${start.hostname} is not in site.allowedHostnames; own-site crawls only fetch allowed hosts.`, {
      hint: 'Add the hostname to site.allowedHostnames if it is yours, or use `crawl competitor` for third-party pages.',
    });
  }
  if (ctx.dryRun) {
    return { plan, result: baseResult(kind, startUrl, plan, 'dry_run', ['Dry run: no requests were made and nothing was written.']) };
  }
  const offline = offlineBlock(ctx, opts);
  if (offline) {
    return { plan, result: { ...baseResult(kind, startUrl, plan, 'offline', [offline]), nextStep: 'Run without --offline (and outside demo mode) to crawl the live site.' } };
  }
  const fetcher = buildFetcher(ctx, opts);
  return { plan: buildPlan(ctx, kind, startUrl, opts, fetcher), fetcher };
}

async function renderSetup(ctx: AppContext, session: CrawlSession, opts: CrawlSiteOptions): Promise<RenderSummary> {
  if (!opts.render) return { requested: false, status: 'not_requested', rendered: 0, detail: 'Rendering not requested.' };
  if (!ctx.settings.features.playwright) return { requested: true, status: 'disabled_by_config', rendered: 0, detail: 'features.playwright is off; raw HTTP crawl only.' };
  const a = await playwrightAvailability(opts.playwrightLoader);
  session.renderAvailable = a.available;
  return { requested: true, status: a.available ? 'available' : 'optional_disabled', rendered: 0, detail: a.available ? a.detail : `${a.detail}. ${a.nextStep ?? ''}`.trim() };
}

async function runSession(ctx: AppContext, kind: CrawlKind, startUrl: string, opts: CrawlSiteOptions): Promise<CrawlSiteResult> {
  const prep = await prepare(ctx, kind, startUrl, opts);
  if (prep.result) return prep.result;
  const fetcher = prep.fetcher!;
  const plan = prep.plan;
  const startCheck = await fetcher.guard.check(startUrl);
  if (!startCheck.ok) {
    const e = startCheck.error;
    if (e.reason === 'dns_failure') {
      // A resolver error, timeout, or empty answer is a transient network/DNS problem, not an SSRF
      // policy refusal: the start URL is not at fault and nothing was requested (see competitor.ts).
      const host = new URL(startUrl).hostname;
      return {
        ...baseResult(kind, startUrl, plan, 'failed', [e.message]),
        stopReason: `DNS resolution failed for ${host} (transient network/DNS problem)`,
        failureCode: 'CRAWL_NETWORK_ERROR',
        nextStep: networkRetryStep(host),
      };
    }
    return {
      ...baseResult(kind, startUrl, plan, 'failed', [e.message]),
      stopReason: `Start URL refused by the SSRF guard (${e.reason})`,
      failureCode: 'CRAWL_START_URL_REFUSED',
      nextStep: 'site.url must be a public http(s) URL on a default (or explicitly allowlisted) port; private, loopback, and metadata destinations are never crawled.',
    };
  }
  const isSynthetic = ctx.synthetic || fetcher.transport.kind === 'fixture';
  const crawlId = createCrawl(ctx, { kind, config: plan as unknown as Record<string, unknown>, jobId: opts.jobId ?? null, isSynthetic });
  const session = new CrawlSession(ctx, crawlId, fetcher, plan, opts, kind === 'own_site');
  const result = baseResult(kind, startUrl, plan, 'completed');
  result.crawlId = crawlId;
  result.isSynthetic = isSynthetic;
  result.render = await renderSetup(ctx, session, opts);
  if (fetcher.transport.kind !== 'pinned') result.notes.push(`Transport "${fetcher.transport.kind}": connections are not DNS-pinned (tests/fixtures only).`);
  if (fetcher.guard.testOnlyAllowLoopback) result.notes.push('TEST-ONLY loopback escape hatch is enabled on the SSRF guard.');

  let status: Exclude<CrawlRunStatus, 'disabled' | 'offline' | 'dry_run'> = 'completed';
  let stopReason: string | null = null;
  try {
    const startKey = normKey(startUrl) ?? startUrl;
    const origin = originOf(startKey);
    const startRobots = await session.robots.get(origin);
    let discovery: SitemapDiscovery | null = null;
    // Nothing more is requested from an origin the SSRF guard refused or whose name did not resolve.
    if (plan.useSitemaps && startRobots.info.state !== 'unsafe' && startRobots.info.errorCode !== 'unsafe_url:dns_failure') {
      discovery = await discoverSitemaps(fetcher, {
        origin,
        robots: startRobots,
        allowedHostnames: plan.allowedHostnames,
        limits: { maxFiles: plan.maxSitemapFiles, maxUrls: plan.maxSitemapUrls, maxBytes: plan.maxBytes },
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      recordSitemaps(ctx, crawlId, discovery.files);
      for (const s of discovery.urls) {
        const k = normKey(s.loc);
        if (k) session.sitemapUrls.add(k);
      }
      result.sitemaps = {
        files: discovery.files.length,
        parsed: discovery.files.filter((f) => f.status === 'parsed').length,
        urls: discovery.urls.length,
        truncated: discovery.truncated,
        notes: discovery.notes,
      };
    }

    session.seen.add(startKey);
    let level: QueueItem[] = [{ url: startKey, depth: 0, via: ['start'] }];
    const workers = Math.max(1, opts.workers ?? DEFAULT_WORKERS);
    for (let depth = 0; level.length; depth++) {
      if (opts.signal?.aborted) {
        status = 'cancelled';
        stopReason = 'cancelled';
        break;
      }
      const next: QueueItem[] = [];
      const settled = await mapBounded(level, workers, (item) => session.process(item, next), opts.signal);
      for (const s of settled) if (!s.ok) ctx.logger.warn('crawl item failed', { error: (s.error as Error)?.message ?? String(s.error) });
      if (depth === 0 && kind === 'own_site') {
        // Sitemap URLs join the frontier after the start page's own links.
        for (const s of discovery?.urls ?? []) {
          const k = normKey(s.loc);
          if (!k || session.seen.has(k)) continue;
          if (1 > plan.maxDepth) {
            session.depthLimited++;
            continue;
          }
          session.seen.add(k);
          next.push({ url: k, depth: 1, via: ['sitemap'] });
        }
      }
      for (const item of next) if (session.sitemapUrls.has(item.url) && !item.via.includes('sitemap')) item.via.push('sitemap');
      level = next;
      if (session.capped) {
        session.unvisited += level.length;
        break;
      }
    }

    // Start URL outcome decides whether the crawl failed outright.
    const startRow = ctx.db.get<{ status_code: number | null; blocked_reason: string | null; error: string | null; final_url: string | null; extraction_json: string | null }>(
      'SELECT status_code, blocked_reason, error, final_url, extraction_json FROM crawl_results WHERE crawl_id = ? AND site_id = ? AND requested_url = ?',
      [crawlId, ctx.siteId, startKey],
    );
    const startExtra = startRow?.extraction_json ? (JSON.parse(startRow.extraction_json) as { fetchErrorCode?: string | null; finalStatus?: number | null }) : {};
    const startOffsite = startExtra.fetchErrorCode === 'offsite_redirect';
    const startFinalError = startRow && startRow.status_code !== null && startRow.status_code >= 300 && startRow.status_code < 400 && typeof startExtra.finalStatus === 'number' && startExtra.finalStatus >= 400 ? startExtra.finalStatus : null;
    // URLs left unfetched by transient conditions mean the crawl did not cover what it found.
    const transient = ctx.db.all<{ blocked_reason: string; n: number }>(
      `SELECT blocked_reason, COUNT(*) AS n FROM crawl_results
        WHERE crawl_id = ? AND site_id = ? AND blocked_reason IN ('rate_limited', 'timeout', 'network_error') GROUP BY blocked_reason ORDER BY blocked_reason`,
      [crawlId, ctx.siteId],
    );
    if (status !== 'cancelled') {
      if (!startRow || startRow.status_code === null || startRow.blocked_reason) {
        status = 'failed';
        stopReason = `Start URL not crawlable: ${startRow?.blocked_reason ?? 'no response'}${startRow?.error ? ` (${startRow.error})` : ''}`;
        const startRobotsInfo = startRow?.blocked_reason === 'robots' ? startRobots.info : null;
        if (startRow?.blocked_reason === 'network_error' || startRow?.blocked_reason === 'timeout' || (startRobotsInfo !== null && isTransientRobotsFailure(startRobotsInfo))) {
          // Transient (DNS, connection, timeout): retry later; the start URL itself is not at fault.
          result.failureCode = 'CRAWL_NETWORK_ERROR';
          result.nextStep = networkRetryStep(new URL(startKey).hostname);
        }
      } else if (startFinalError !== null) {
        status = 'failed';
        stopReason = `Start URL redirects to ${startRow!.final_url ?? 'another URL'}, which returned HTTP ${startFinalError}; nothing else was crawled.`;
      } else if (startOffsite) {
        status = 'failed';
        stopReason = `Start URL redirects to ${startRow.final_url ?? 'another host'}, outside site.allowedHostnames; nothing else was crawled.`;
        result.nextStep = 'If that host is yours, add it to site.allowedHostnames (www and non-www are never merged automatically) or set site.url to the final URL.';
      } else if (session.capped || session.depthLimited > 0 || discovery?.truncated || transient.length) {
        status = 'partial';
        const parts: string[] = [];
        if (session.capped) parts.push(`maxPages (${plan.maxPages}) reached with ${session.unvisited} discovered URL(s) not fetched`);
        if (session.depthLimited) parts.push(`maxDepth (${plan.maxDepth}) left ${session.depthLimited} link(s) unfollowed`);
        if (discovery?.truncated) parts.push('sitemap discovery truncated by limits');
        if (transient.length) parts.push(`${transient.map((t) => `${t.n} URL(s) ${t.blocked_reason.replace('_', ' ')}`).join(', ')} (not fetched; re-crawl later)`);
        stopReason = parts.join('; ');
      } else stopReason = 'frontier exhausted';
    }
  } catch (err) {
    status = opts.signal?.aborted ? 'cancelled' : 'failed';
    stopReason = `${status === 'cancelled' ? 'cancelled' : 'error'}: ${(err as Error).message ?? String(err)}`;
    ctx.logger.error('crawl failed', { crawlId, error: stopReason });
  }

  linkTargetsToPages(ctx, crawlId);
  finishCrawl(ctx, crawlId, { status, counts: { ...session.counts, blocked: session.counts.blocked + session.counts.skipped }, stopReason });
  result.status = status;
  result.stopReason = stopReason;
  result.counts = session.counts;
  result.unvisited = session.unvisited;
  result.depthLimited = session.depthLimited;
  result.trapHits = session.traps.hits.length;
  result.render.rendered = session.rendered;
  result.robots = (await session.robots.policies().catch(() => [])).map((p) => ({ origin: p.info.origin, state: p.info.state, note: p.info.note, sitemaps: p.info.sitemaps, crawlDelayMs: p.info.crawlDelayMs }));
  result.notes.push(...session.notes.slice(0, 50));
  if (session.traps.hits.length) result.notes.push(`${session.traps.hits.length} URL(s) skipped by crawler-trap guards (coverage limit, not proof of a problem).`);
  if (status !== 'failed' && status !== 'cancelled' && opts.runChecks !== false) {
    result.checks = runTechnicalChecks(ctx, crawlId);
  }
  if (status === 'failed') result.nextStep ??= 'Check that the start URL is reachable, allowed by robots.txt, and not behind a login.';
  recordAudit(ctx.db, {
    siteId: ctx.siteId,
    actor: 'system',
    eventType: 'crawl.finished',
    subjectType: 'crawl',
    subjectId: crawlId,
    details: { kind, status, stopReason, counts: session.counts, isSynthetic },
    at: ctx.clock.now(),
  });
  return result;
}

/** Bounded own-site crawl (see module doc). */
export async function crawlSite(ctx: AppContext, opts: CrawlSiteOptions = {}): Promise<CrawlSiteResult> {
  return runSession(ctx, 'own_site', opts.startUrl ?? ctx.config.site.url, opts);
}

/** Fetch and analyse one own-site URL (no link following). */
export async function crawlPage(ctx: AppContext, url: string, opts: Omit<CrawlSiteOptions, 'startUrl' | 'maxPages' | 'maxDepth' | 'useSitemaps'> = {}): Promise<CrawlSiteResult> {
  return runSession(ctx, 'single_page', url, { ...opts, useSitemaps: false });
}

export type { PageExtraction };
