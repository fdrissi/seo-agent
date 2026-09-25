import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AppContext } from './context.js';
import { errorMessage, isAppError } from '../core/errors.js';
import { appDirs, siteVaultDir } from '../config/paths.js';
import { ApprovalService } from '../approvals/service.js';
import type { ApprovalGate } from '../approvals/types.js';
import type { FetchedPage, PageFetcher, PageFetchResult } from '../approvals/page-fetch.js';
import { pageTargetChecker, type TargetChecker } from '../approvals/target-check.js';
import { createGoogleAuthProvider, resolveGoogleAuthMode } from '../auth/providers.js';
import { buildFetcher, type CrawlerDeps } from '../crawler/deps.js';
import { SafeFetcher } from '../crawler/fetch.js';
import { crawlerStatus } from '../crawler/status.js';
import { fixtureSiteTransport, fixtureTransport } from '../crawler/transport.js';
import { SsrfGuard, type Resolver } from '../security/ssrf.js';
import { isAllowedHost } from '../seo/url.js';
import { createApifyClient, type ApifyClient } from '../integrations/apify/client.js';
import { apifyStatus } from '../integrations/apify/status.js';
import type { DataForSeoClientOptions } from '../integrations/dataforseo/client.js';
import { dataforseoStatus } from '../integrations/dataforseo/status.js';
import { createSyntheticDataForSeoFetch } from '../integrations/dataforseo/synthetic.js';
import { googleStatus } from '../integrations/google/status.js';
import type { GoogleAuthProvider } from '../integrations/google/types.js';
import { createFixtureLlmClient, type FixtureHandler } from '../integrations/llm/fixture-client.js';
import { createLlmClient, type GatewayClientOptions } from '../integrations/llm/gateway.js';
import { llmStatus } from '../integrations/llm/status.js';
import type { EmbedRequest, EmbedResult, LlmClient, LlmFailureStatus, LlmUnavailable, ModelTier, StructuredRequest, StructuredResult, TextRequest, TextResult } from '../integrations/llm/types.js';
import { performanceStatuses } from '../integrations/pagespeed/status.js';
import type { FetchLike, IntegrationId, IntegrationState, IntegrationStatus, StatusCheckOptions } from '../integrations/types.js';
import { createMemoryService, memoryStatus, type MemoryService, type MemoryServiceDeps } from '../memory/service.js';
import { vaultIntegrationStatus } from '../obsidian/status.js';
import type { JobRegistry } from '../jobs/registry.js';
import { listSiteLocks } from '../jobs/locks.js';
import { describeSchedules } from '../jobs/scheduler.js';
import { listJobs } from '../jobs/store.js';
import { createVaultWriter, type FileVaultWriter } from '../obsidian/writer.js';
import { syntheticLlmHandlers } from '../workflows/pipelines/synthetic-llm.js';

/**
 * Concrete service graph for one site context (the integration layer).
 *
 * `createServices(ctx)` builds the real implementation of every slice
 * contract for this context: the Google auth provider (OAuth / service
 * account from settings, the synthetic fixture provider only for the demo
 * profile), the LLM client (LLM Gateway when a key and models are configured,
 * the deterministic fixture client in demo mode, otherwise a disabled client
 * that answers `not_configured` honestly), memory (SQLite FTS always; Qdrant
 * and embeddings only when enabled), the vault writer, the approval gate, the
 * crawler dependencies (SSRF-safe fetcher; fixture site in demo mode),
 * DataForSEO/Apify/PageSpeed options, and an SSRF-safe page fetcher for
 * approval target rechecks.
 *
 * Creating services never throws for a missing optional integration: the
 * problem is recorded as an IntegrationStatus in `issues` and the affected
 * service is null or disabled.
 *
 * IMPORTANT: build services from the context that will spend money. Inside a
 * workflow stage that is the stage context (`sctx.app`), whose budget service
 * enforces the stage's cost allowance; the LLM client reserves through it.
 */

export interface ServiceOptions {
  /** Google auth provider override (tests). `null` = explicitly unavailable. */
  googleProvider?: GoogleAuthProvider | null;
  /** Fixture directory for the demo Google provider (default tests/fixtures/google). */
  googleFixturesDir?: string;
  /** LLM client override (tests). `null` = disabled client. */
  llm?: LlmClient | null;
  /** Extra/override fixture handlers for the demo LLM client, keyed by prompt id. */
  fixtureLlmHandlers?: Record<string, FixtureHandler>;
  /** Options passed to the LLM Gateway client (the approval gate is always wired). */
  gateway?: Omit<GatewayClientOptions, 'approvals'>;
  /** Own-site crawler dependencies (fetcher / transport / resolver). */
  crawler?: CrawlerDeps;
  /**
   * Competitor crawler dependencies. Default: the own-site dependencies; in
   * the demo profile (when no own-site crawler is injected either) the
   * SYNTHETIC demo competitor fixture (`demoCompetitorCrawlerDeps`).
   */
  competitorCrawler?: CrawlerDeps;
  /** Synthetic site served by the fixture transport in demo mode (default tests/fixtures/pipelines/site). */
  fixtureSiteDir?: string;
  /** DataForSEO client options (demo: synthetic fixture transport). */
  dataforseo?: DataForSeoClientOptions;
  /** Apify client override (tests). */
  apifyClient?: ApifyClient | null;
  /** Memory dependencies (Qdrant client/fetch overrides). */
  memory?: Omit<MemoryServiceDeps, 'llm'>;
  /** Fetch used for PageSpeed/CrUX (default ctx.fetch). */
  pagespeedFetch?: FetchLike;
  /** Approval gate override (tests). */
  approvals?: ApprovalGate;
}

export type LlmKind = 'gateway' | 'fixture' | 'disabled' | 'injected';

export interface AppServices {
  readonly ctx: AppContext;
  /** Problems found while building services (missing optional integrations); never thrown. */
  readonly issues: IntegrationStatus[];
  readonly google: { provider: GoogleAuthProvider | null; mode: 'oauth' | 'service_account' | 'fixture' | null; error: string | null };
  readonly llm: LlmClient;
  readonly llmKind: LlmKind;
  readonly approvals: ApprovalGate;
  /** Full-text memory (no LLM client, so it never spends on embeddings implicitly). */
  readonly memory: MemoryService;
  /** Memory with the LLM client for embeddings (paid; use only under an explicit allowance). */
  memoryWithEmbeddings(): MemoryService;
  /** True when embeddings can run for this site (feature flags + configured embedding model). */
  readonly embeddingsAvailable: boolean;
  readonly vault: FileVaultWriter | null;
  readonly crawler: CrawlerDeps;
  readonly competitorCrawler: CrawlerDeps;
  readonly dataforseo: DataForSeoClientOptions & { approvals: ApprovalGate };
  readonly apify: { client: ApifyClient | null };
  readonly pagespeed: { fetch?: FetchLike };
  /** SSRF-safe fetcher (DNS revalidation) for the site's own pages (approval rechecks, live verification). */
  readonly pageFetcher: PageFetcher;
  readonly targetChecker: TargetChecker;
}

function status(ctx: AppContext, id: IntegrationId, state: IntegrationState, detail: string, nextStep?: string): IntegrationStatus {
  return { id, state, detail, ...(nextStep ? { nextStep } : {}), sendsExternally: [], checkedAt: ctx.clock.now().toISOString(), networkChecked: false, chargeable: false };
}

// ---------------------------------------------------------------------------
// LLM: a disabled client that answers honestly
// ---------------------------------------------------------------------------

/**
 * LlmClient used when no model connection is configured. Every call returns
 * `{ ok: false, status }` with the reason and the owner's next step; nothing is
 * sent anywhere and nothing is fabricated.
 */
export class DisabledLlmClient implements LlmClient {
  readonly synthetic = false;
  constructor(
    readonly reason: string,
    readonly nextStep: string,
    readonly failureStatus: LlmFailureStatus = 'not_configured',
  ) {}
  isConfigured(_tier: ModelTier | 'embedding'): boolean {
    return false;
  }
  /** The real cause (e.g. --offline) for callers that would otherwise guess "missing key or model". */
  get unavailable(): LlmUnavailable {
    return { status: this.failureStatus, reason: this.reason, nextStep: this.nextStep };
  }
  async structured<T>(_req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return { ok: false, status: this.failureStatus, reason: this.reason, nextStep: this.nextStep };
  }
  async text(_req: TextRequest): Promise<TextResult> {
    return { ok: false, status: this.failureStatus, reason: this.reason, nextStep: this.nextStep };
  }
  async embed(_req: EmbedRequest): Promise<EmbedResult> {
    return { ok: false, status: this.failureStatus, reason: this.reason, nextStep: this.nextStep };
  }
}

function llmNotConfiguredReason(ctx: AppContext): { reason: string; nextStep: string; status: LlmFailureStatus } | null {
  if (!ctx.settings.features.llm) {
    return { reason: `AI analysis is disabled for site ${ctx.siteId} (features.llm = false); no model call was made.`, nextStep: 'Set features.llm: true in the site config to enable it.', status: 'disabled' };
  }
  if (ctx.offline && !ctx.synthetic) {
    return { reason: 'Network access is disabled (--offline); no model call was made.', nextStep: 'Run without --offline to use the LLM Gateway.', status: 'disabled' };
  }
  const m = ctx.settings.models;
  const hasKey = ctx.secrets.has('LLM_GATEWAY_API_KEY');
  if (!hasKey || (!m.cheap && !m.reasoning && !m.embedding)) {
    const missing = [!hasKey ? 'LLM_GATEWAY_API_KEY' : null, !m.cheap && !m.reasoning && !m.embedding ? 'CHEAP_MODEL / REASONING_MODEL / EMBEDDING_MODEL' : null].filter(Boolean).join(' and ');
    return {
      reason: `No LLM model connection is configured (${missing} not set); deterministic analysis only, no model call was made.`,
      nextStep: 'Put LLM_GATEWAY_API_KEY in <workspace>/secrets/secrets.env (never in chat), run `npm run cli -- models list`, and set CHEAP_MODEL / REASONING_MODEL / EMBEDDING_MODEL (docs/ACCESS_SETUP.md).',
      status: 'not_configured',
    };
  }
  return null;
}

function buildLlm(ctx: AppContext, approvals: ApprovalGate, opts: ServiceOptions, issues: IntegrationStatus[]): { llm: LlmClient; kind: LlmKind } {
  if (opts.llm !== undefined) {
    if (opts.llm) return { llm: opts.llm, kind: 'injected' };
    return { llm: new DisabledLlmClient('The LLM client was explicitly disabled for this run; no model call was made.', 'Remove the override to use the configured client.', 'disabled'), kind: 'disabled' };
  }
  if (ctx.synthetic) {
    const handlers = { ...syntheticLlmHandlers(), ...(opts.fixtureLlmHandlers ?? {}) };
    issues.push(status(ctx, 'llm_gateway', 'fixture', 'Demo profile: deterministic SYNTHETIC fixture LLM client (no model is called; outputs are labeled synthetic).'));
    return { llm: createFixtureLlmClient(handlers, { ctx }), kind: 'fixture' };
  }
  const why = llmNotConfiguredReason(ctx);
  if (why) {
    issues.push(status(ctx, 'llm_gateway', why.status === 'disabled' ? 'disabled' : 'missing_credentials', why.reason, why.nextStep));
    return { llm: new DisabledLlmClient(why.reason, why.nextStep, why.status), kind: 'disabled' };
  }
  try {
    return { llm: createLlmClient(ctx, { ...(opts.gateway ?? {}), approvals }), kind: 'gateway' };
  } catch (err) {
    const reason = `The LLM Gateway client could not be created: ${errorMessage(err)}`;
    issues.push(status(ctx, 'llm_gateway', 'misconfigured', reason, 'Check the llm section of the site config and `npm run cli -- models check`.'));
    return { llm: new DisabledLlmClient(reason, 'Check the llm section of the site config.', 'not_configured'), kind: 'disabled' };
  }
}

/**
 * Why the full-text memory service (built without an embedding client on
 * purpose, so automated runs never spend on embeddings implicitly) has no
 * vectors, in the words the index_memory note and memory status repeat: the
 * LLM client's own reason when it cannot run at all (--offline, features.llm
 * off, no key), otherwise the deliberate policy. Never "configure the
 * gateway" when the gateway is configured and only the network is off.
 */
export function fullTextMemoryNoClient(ctx: AppContext, llm: LlmClient): { reason: string; nextStep: string } {
  const why = llm.unavailable;
  if (why) return { reason: why.reason, nextStep: why.nextStep };
  if (llm.isConfigured('embedding')) {
    return {
      reason: 'This run indexes memory without an embedding client on purpose (automated runs never spend on embeddings implicitly).',
      nextStep: 'Run `npm run cli -- memory sync --allow-paid` to embed new chunks within the budget.',
    };
  }
  return {
    reason: `No embedding model client is configured${ctx.settings.models.embedding ? '' : ' (EMBEDDING_MODEL / models.embedding not set)'}.`,
    nextStep: 'Set LLM_GATEWAY_API_KEY in <workspace>/secrets/secrets.env and EMBEDDING_MODEL (see docs/ACCESS_SETUP.md).',
  };
}

// ---------------------------------------------------------------------------
// Crawler dependencies and the SSRF-safe page fetcher
// ---------------------------------------------------------------------------

/** Documentation address used only by the synthetic resolver: the fixture transport never opens a connection. */
const SYNTHETIC_RESOLVED_ADDRESS = '93.184.216.34';

/** Resolver for synthetic demo hosts only (unknown hosts fail like a real NXDOMAIN). */
export function syntheticResolver(hosts: readonly string[]): Resolver {
  const allowed = new Set(hosts.map((h) => h.toLowerCase()));
  return async (hostname: string) => {
    if (!allowed.has(hostname.toLowerCase())) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname} (synthetic resolver)`), { code: 'ENOTFOUND' });
    return [{ address: SYNTHETIC_RESOLVED_ADDRESS, family: 4 as const }];
  };
}

export function defaultFixtureSiteDir(): string {
  return path.join(appDirs.fixtures(), 'pipelines', 'site');
}

/**
 * Offline crawler dependencies serving a synthetic site from `dir` (demo):
 * the SSRF guard still runs (with a synthetic resolver) and every result is
 * flagged as fixture data (is_synthetic = 1, render_mode 'fixture').
 */
export function fixtureCrawlerDeps(ctx: AppContext, dir: string): CrawlerDeps {
  const hosts = ctx.config.site.allowedHostnames;
  const c = ctx.config.crawl;
  const fetcher = new SafeFetcher({
    guard: new SsrfGuard({ resolver: syntheticResolver(hosts) }),
    transport: fixtureSiteTransport({ dir, hosts }),
    userAgent: c.userAgent,
    timeoutMs: c.timeoutMs,
    maxBytes: c.maxBytes,
    maxRedirects: c.maxRedirects,
    perHostConcurrency: c.perHostConcurrency,
    delayMs: 0,
  });
  return { fetcher };
}

/**
 * Reserved competitor hosts of the synthetic DataForSEO SERP fixture (the same
 * list as DEMO_COMPETITOR_HOSTS in src/demo/fixtures.ts).
 */
export const DEMO_COMPETITOR_FIXTURE_HOSTS: readonly string[] = Array.from({ length: 10 }, (_, i) => `competitor-${i + 1}.example`);

export function defaultDemoCompetitorFixtureDir(): string {
  return path.join(appDirs.fixtures(), 'demo', 'competitors');
}

/**
 * Offline competitor crawler for the demo profile, so normal CLI runs in a
 * demo workspace behave like the demo: SYNTHETIC competitor pages from
 * tests/fixtures/demo/competitors (reserved example hosts only). competitor-1
 * serves an article (with a fake injection line), competitor-2 disallows
 * crawling in robots.txt, competitor-3 is a login barrier (401), competitor-4
 * denies access (403), everything else is 404. The SSRF guard still runs with
 * a synthetic resolver; no socket is ever opened.
 */
export function demoCompetitorCrawlerDeps(ctx: AppContext, dir: string = defaultDemoCompetitorFixtureDir()): CrawlerDeps {
  const articleFile = path.join(dir, 'article.html');
  const loginFile = path.join(dir, 'login.html');
  if (!existsSync(articleFile) || !existsSync(loginFile)) throw new Error(`demo competitor fixtures not found in ${dir}`);
  const cache = new Map<string, string>();
  const read = (f: string) => {
    let v = cache.get(f);
    if (v === undefined) cache.set(f, (v = readFileSync(f, 'utf8')));
    return v;
  };
  const html = { 'content-type': 'text/html; charset=utf-8' };
  const text = { 'content-type': 'text/plain; charset=utf-8' };
  const transport = fixtureTransport((raw) => {
    const u = new URL(raw);
    if (u.pathname === '/robots.txt') {
      if (u.hostname === 'competitor-2.example') return { status: 200, headers: text, body: '# SYNTHETIC robots.txt\nUser-agent: *\nDisallow: /\n' };
      return { status: 200, headers: text, body: '# SYNTHETIC robots.txt\nUser-agent: *\nAllow: /\n' };
    }
    if (u.hostname === 'competitor-1.example') return { status: 200, headers: html, body: read(articleFile) };
    if (u.hostname === 'competitor-3.example') return { status: 401, headers: { ...html, 'www-authenticate': 'Basic realm="synthetic"' }, body: read(loginFile) };
    if (u.hostname === 'competitor-4.example') return { status: 403, headers: text, body: 'Forbidden (synthetic)' };
    return undefined;
  });
  const c = ctx.config.crawl;
  const fetcher = new SafeFetcher({
    guard: new SsrfGuard({ resolver: syntheticResolver(DEMO_COMPETITOR_FIXTURE_HOSTS) }),
    transport,
    userAgent: c.userAgent,
    timeoutMs: c.timeoutMs,
    maxBytes: c.maxBytes,
    maxRedirects: c.maxRedirects,
    perHostConcurrency: c.perHostConcurrency,
    delayMs: 0,
  });
  return { fetcher };
}

/**
 * Competitor crawler dependencies for a context: the demo competitor fixture
 * in the demo profile, otherwise the default SSRF-safe network fetcher.
 */
export function competitorCrawlerDepsFor(ctx: AppContext): CrawlerDeps {
  if (!ctx.synthetic) return {};
  try {
    return demoCompetitorCrawlerDeps(ctx);
  } catch {
    // Without the fixture files the crawler reports the demo/offline state honestly (no request is made).
    return {};
  }
}

/**
 * PageFetcher for the site's OWN pages built on the crawler's SSRF-safe
 * fetcher: static URL checks, DNS resolution with every answer classified,
 * the connection pinned to the validated addresses, and every redirect hop
 * revalidated. Hosts outside `site.allowedHostnames` are refused before any
 * DNS lookup.
 */
export function createSsrfSafePageFetcher(ctx: AppContext, deps: CrawlerDeps = {}): PageFetcher {
  const allowed = ctx.config.site.allowedHostnames;
  return async (url: string): Promise<PageFetchResult> => {
    const kind = deps.fetcher?.transport.kind ?? deps.transport?.kind;
    if (ctx.offline && kind !== 'fixture') return { ok: false, reason: 'offline', detail: 'Network access is disabled (offline/demo mode); live state could not be checked.' };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, reason: 'unsafe_url', detail: `Not an absolute URL: ${url}` };
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false, reason: 'unsafe_url', detail: `Unsupported scheme ${parsed.protocol}` };
    if (!isAllowedHost(parsed.href, allowed)) return { ok: false, reason: 'blocked_host', detail: `Host ${parsed.hostname} is not one of the site's allowedHostnames.` };
    let fetcher: SafeFetcher;
    try {
      fetcher = buildFetcher(ctx, deps);
    } catch (err) {
      return { ok: false, reason: 'network_error', detail: `Fetcher unavailable: ${errorMessage(err)}` };
    }
    const r = await fetcher.fetch(parsed.href, {
      accept: ['html'],
      beforeHop: (u) => (isAllowedHost(u.href, allowed) ? null : { stop: true, blockedReason: null, note: `redirect to ${u.hostname}, outside the site's allowedHostnames`, errorCode: 'offsite_redirect' }),
    });
    const chain = r.redirectChain.map((h) => h.url);
    if (r.errorCode === 'offsite_redirect') return { ok: false, reason: 'blocked_host', detail: r.note ?? 'redirect outside allowedHostnames' };
    if (r.blockedReason === 'unsafe_url') return { ok: false, reason: 'unsafe_url', detail: r.error ?? 'refused by the SSRF guard' };
    if (r.errorCode === 'too_many_redirects' || r.errorCode === 'redirect_loop') return { ok: false, reason: 'too_many_redirects', detail: r.error ?? r.errorCode };
    if (r.blockedReason === 'timeout') return { ok: false, reason: 'timeout', detail: r.error ?? 'timed out' };
    if (r.blockedReason === 'too_large') return { ok: false, reason: 'too_large', detail: r.note ?? 'response too large', ...(r.status !== null ? { status: r.status } : {}) };
    if (r.blockedReason === 'unsupported_content') return { ok: false, reason: 'unsupported_content', detail: r.note ?? 'unsupported content type', ...(r.status !== null ? { status: r.status } : {}) };
    if (r.status === null) return { ok: false, reason: 'network_error', detail: r.error ?? r.note ?? 'no response' };
    if (r.status >= 400 || r.blockedReason) return { ok: false, reason: 'http_error', detail: r.note ?? `HTTP ${r.status}`, status: r.status };
    if (r.status >= 300) return { ok: false, reason: 'http_error', detail: `HTTP ${r.status} without a usable Location`, status: r.status };
    const html = r.text ?? (r.body ? new TextDecoder('utf-8').decode(r.body) : '');
    const page: FetchedPage = { requestedUrl: url, finalUrl: r.finalUrl ?? parsed.href, status: r.status, contentType: r.contentType, html, fetchedAt: ctx.clock.now().toISOString(), redirectChain: chain };
    return { ok: true, page };
  };
}

// ---------------------------------------------------------------------------
// Service graph
// ---------------------------------------------------------------------------

export function createServices(ctx: AppContext, opts: ServiceOptions = {}): AppServices {
  const issues: IntegrationStatus[] = [];

  // Approval gate (SQLite-backed; approvals bind the exact proposal).
  const approvals: ApprovalGate = opts.approvals ?? new ApprovalService(ctx.db, { clock: ctx.clock });

  // Google auth provider.
  let google: AppServices['google'];
  if (opts.googleProvider !== undefined) {
    google = { provider: opts.googleProvider, mode: opts.googleProvider?.mode ?? null, error: opts.googleProvider ? null : 'Google provider explicitly unavailable for this run.' };
  } else {
    try {
      const provider = createGoogleAuthProvider(ctx, opts.googleFixturesDir ? { fixturesDir: opts.googleFixturesDir } : {});
      google = { provider, mode: provider.mode, error: null };
    } catch (err) {
      const detail = `Google auth provider unavailable: ${errorMessage(err)}`;
      google = { provider: null, mode: null, error: detail };
      issues.push(status(ctx, 'google_auth', 'misconfigured', detail, isAppError(err) && err.hint ? err.hint : 'Check GOOGLE_AUTH_MODE and the Google credential files (`npm run cli -- auth status`).'));
    }
  }

  // LLM client.
  const { llm, kind: llmKind } = buildLlm(ctx, approvals, opts, issues);
  const embeddingsAvailable = ctx.settings.features.embeddings && ctx.settings.features.llm && llm.isConfigured('embedding');

  // Memory: FTS always; Qdrant client when enabled (the service degrades to FTS when unreachable).
  const memDeps: MemoryServiceDeps = { ...(opts.memory ?? {}) };
  const memory = createMemoryService(ctx, { ...memDeps, llm: null, embeddingOptions: { ...(memDeps.embeddingOptions ?? {}), noClient: memDeps.embeddingOptions?.noClient ?? fullTextMemoryNoClient(ctx, llm) } });
  let withEmbeddings: MemoryService | null = null;
  const memoryWithEmbeddings = (): MemoryService => (withEmbeddings ??= embeddingsAvailable ? createMemoryService(ctx, { ...memDeps, llm }) : memory);

  // Vault writer.
  let vault: FileVaultWriter | null = null;
  if (ctx.settings.features.obsidian) {
    try {
      vault = createVaultWriter(ctx);
    } catch (err) {
      issues.push(status(ctx, 'obsidian', 'misconfigured', `Vault writer unavailable: ${errorMessage(err)}`, 'Run `npm run cli -- vault init` and check the workspace vault path.'));
    }
  }

  // Crawler dependencies.
  let crawler: CrawlerDeps = opts.crawler ?? {};
  if (!opts.crawler && ctx.synthetic) {
    try {
      crawler = fixtureCrawlerDeps(ctx, opts.fixtureSiteDir ?? defaultFixtureSiteDir());
      issues.push(status(ctx, 'crawler', 'fixture', 'Demo profile: the own-site crawl reads a SYNTHETIC fixture site (no network; rows flagged is_synthetic = 1).'));
    } catch (err) {
      issues.push(status(ctx, 'crawler', 'misconfigured', `Fixture crawler unavailable: ${errorMessage(err)}`));
    }
  }
  let competitorCrawler: CrawlerDeps = opts.competitorCrawler ?? crawler;
  if (!opts.competitorCrawler && !opts.crawler && ctx.synthetic) {
    // Demo profile: the synthetic competitor pages (not the own-site fixture, whose resolver knows only the site's hosts).
    try {
      competitorCrawler = demoCompetitorCrawlerDeps(ctx);
    } catch (err) {
      issues.push(status(ctx, 'crawler', 'misconfigured', `Demo competitor fixture unavailable: ${errorMessage(err)}; competitor pages would fail DNS in the demo profile.`));
    }
  }

  // DataForSEO (demo: synthetic fixture transport, never the network).
  const dataforseo: AppServices['dataforseo'] = {
    ...(ctx.synthetic && !opts.dataforseo ? { mode: 'fixture' as const, fetch: createSyntheticDataForSeoFetch() } : {}),
    ...(opts.dataforseo ?? {}),
    approvals,
  };

  // Apify client (created only when a token exists; runs are always explicit).
  let apifyClient: ApifyClient | null = null;
  if (opts.apifyClient !== undefined) apifyClient = opts.apifyClient;
  else if (ctx.settings.features.apify && ctx.secrets.has('APIFY_TOKEN') && !ctx.offline) {
    try {
      apifyClient = createApifyClient(ctx);
    } catch (err) {
      issues.push(status(ctx, 'apify', 'misconfigured', `Apify client unavailable: ${errorMessage(err)}`));
    }
  }

  const pageFetcher = createSsrfSafePageFetcher(ctx, crawler);
  const targetChecker = pageTargetChecker(pageFetcher, () => ctx.clock.now());

  return {
    ctx,
    issues,
    google,
    llm,
    llmKind,
    approvals,
    memory,
    memoryWithEmbeddings,
    embeddingsAvailable,
    vault,
    crawler,
    competitorCrawler,
    dataforseo,
    apify: { client: apifyClient },
    pagespeed: opts.pagespeedFetch ? { fetch: opts.pagespeedFetch } : {},
    pageFetcher,
    targetChecker,
  };
}

// ---------------------------------------------------------------------------
// Status aggregation (doctor, dashboard, reports)
// ---------------------------------------------------------------------------

export interface CollectStatusOptions extends StatusCheckOptions {
  /** Skip slow or network-bound reporters (e.g. for `vault render`). */
  only?: IntegrationId[];
}

async function safeStatus(ctx: AppContext, id: IntegrationId, fn: () => Promise<IntegrationStatus | IntegrationStatus[]>): Promise<IntegrationStatus[]> {
  try {
    const r = await fn();
    return Array.isArray(r) ? r : [r];
  } catch (err) {
    return [status(ctx, id, 'misconfigured', `Status check failed: ${errorMessage(err)}`, isAppError(err) && err.hint ? err.hint : undefined)];
  }
}

/**
 * Every slice's status reporter, in one list. `network: false` never makes a
 * request; `network: true` allows only free, read-only checks (never a
 * chargeable call). Errors become a `misconfigured` status instead of
 * throwing.
 */
export async function collectStatuses(ctx: AppContext, services: AppServices | null, opts: CollectStatusOptions): Promise<IntegrationStatus[]> {
  const svc = services ?? createServices(ctx);
  const want = (id: IntegrationId) => !opts.only || opts.only.includes(id);
  const network = opts.network && !ctx.offline;
  const out: IntegrationStatus[] = [];

  // GOOGLE_AUTH_MODE validation first (an invalid value is a configuration error, not a crash).
  let authModeProblem: IntegrationStatus | null = null;
  try {
    resolveGoogleAuthMode(ctx);
  } catch (err) {
    authModeProblem = status(ctx, 'google_auth', 'misconfigured', errorMessage(err), isAppError(err) && err.hint ? err.hint : 'Use GOOGLE_AUTH_MODE=oauth or service_account.');
  }
  if (want('google_auth') || want('google_gsc') || want('google_ga4') || want('google_url_inspection')) {
    if (authModeProblem) out.push(authModeProblem);
    else out.push(...(await safeStatus(ctx, 'google_auth', () => googleStatus(ctx, { network, ...(svc.google.provider ? { provider: svc.google.provider } : {}) }))));
  }
  if (want('llm_gateway')) {
    if (svc.llmKind === 'fixture' || svc.llmKind === 'injected') {
      out.push(status(ctx, 'llm_gateway', svc.llm.synthetic ? 'fixture' : 'configured_unverified', svc.llm.synthetic ? 'SYNTHETIC fixture LLM client (demo/test): no model is called.' : 'An injected LLM client is used for this run.'));
    } else out.push(...(await safeStatus(ctx, 'llm_gateway', () => llmStatus(ctx, { network }))));
  }
  // A disabled client (--offline, features.llm off, no key) is passed too, so the embedding state names its real cause.
  if (want('qdrant')) out.push(...(await safeStatus(ctx, 'qdrant', async () => (await memoryStatus(ctx, { network, llm: svc.embeddingsAvailable || svc.llm.unavailable ? svc.llm : null })).integration)));
  if (want('crawler') || want('playwright')) {
    const r = await safeStatus(ctx, 'crawler', async () => {
      const s = await crawlerStatus(ctx, { network: network && !ctx.synthetic, ...svc.crawler });
      return [s.crawler as IntegrationStatus, s.playwright];
    });
    out.push(...r.filter((s) => want(s.id)));
  }
  if (want('pagespeed') || want('crux')) {
    const r = await safeStatus(ctx, 'pagespeed', () => performanceStatuses(ctx, { network, ...(svc.pagespeed.fetch ? { fetch: svc.pagespeed.fetch } : {}) }));
    out.push(...r.filter((s) => want(s.id)));
  }
  if (want('dataforseo')) {
    const { approvals: _a, ...dfsOpts } = svc.dataforseo;
    void _a;
    out.push(...(await safeStatus(ctx, 'dataforseo', () => dataforseoStatus(ctx, { network, ...dfsOpts }))));
  }
  if (want('apify')) out.push(...(await safeStatus(ctx, 'apify', () => apifyStatus(ctx, { network, ...(svc.apify.client ? { client: svc.apify.client } : {}) }))));
  if (want('obsidian')) out.push(...(await safeStatus(ctx, 'obsidian', async () => vaultIntegrationStatus(ctx, siteVaultDir(ctx.paths, ctx.siteId)))));

  // Service-creation issues not already represented by a reporter (e.g. a Google provider that failed to build).
  for (const issue of svc.issues) {
    if (!want(issue.id)) continue;
    if (!out.some((s) => s.id === issue.id)) out.push(issue);
  }
  return out;
}

export interface JobsStatus {
  /** Job handler types registered in this build (baseline/weekly/monthly/content queue ...). */
  handlers: string[];
  counts: Record<string, number>;
  attention: Array<{ id: string; type: string; status: string; error: string | null; updatedAt: string }>;
  locks: Array<{ lockName: string; owner: string; jobId: string | null; expiresAt: string }>;
  schedules: Array<{ jobType: string; enabled: boolean; handlerRegistered: boolean; nextRunLocal: string | null; drift: string[]; blockedBy: string | null }>;
  notes: string[];
}

/**
 * Durable jobs and scheduler status (read-only, no network): registered
 * handlers, job counts by status, jobs needing attention (failed,
 * interrupted, waiting for review), held site locks, and schedules.
 */
export function jobsStatus(ctx: AppContext, registry: JobRegistry): JobsStatus {
  const counts = Object.fromEntries(ctx.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM jobs WHERE site_id = ? GROUP BY status', [ctx.siteId]).map((r) => [r.status, r.n]));
  const attention = listJobs(ctx.db, ctx.siteId, { status: ['failed', 'interrupted', 'waiting'], limit: 10 }).map((j) => ({
    id: j.id,
    type: j.type,
    status: j.status,
    error: j.error ? `${j.error.code}: ${j.error.message}` : null,
    updatedAt: j.finishedAt ?? j.heartbeatAt ?? j.createdAt,
  }));
  const locks = listSiteLocks(ctx.db, ctx.siteId).map((l) => ({ lockName: l.lockName, owner: l.owner, jobId: l.jobId, expiresAt: l.expiresAt }));
  let schedules: JobsStatus['schedules'] = [];
  const notes: string[] = [];
  try {
    schedules = describeSchedules(ctx, registry).schedules.map((s) => ({
      jobType: s.jobType,
      enabled: s.enabled,
      handlerRegistered: s.handlerRegistered,
      nextRunLocal: s.nextRunLocal,
      drift: s.drift,
      blockedBy: s.blockedBy ? `${s.blockedBy.jobId} (${s.blockedBy.status}): ${s.blockedBy.detail}` : null,
    }));
  } catch (err) {
    notes.push(`Schedules could not be read: ${errorMessage(err)}`);
  }
  if (!schedules.some((s) => s.enabled)) notes.push('No schedule is enabled (scheduling is opt-in: run a manual baseline/weekly first, then `schedule enable weekly`).');
  return { handlers: registry.types(), counts, attention, locks, schedules, notes };
}

/** Statuses whose state means an integration problem the owner should act on. */
export const PROBLEM_STATUS_STATES: ReadonlySet<IntegrationState> = new Set(['missing_credentials', 'misconfigured', 'unreachable', 'permission_denied', 'degraded', 'unresolved']);
