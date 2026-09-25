/**
 * Helpers for the pipeline integration tests. Everything is SYNTHETIC and
 * offline: the demo-profile context uses the fixture Google provider
 * (tests/fixtures/google), the deterministic fixture LLM client, the fixture
 * site in tests/fixtures/pipelines/site, the synthetic DataForSEO transport,
 * and a fixture transport for competitor pages on reserved *.example domains.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SiteConfigInput } from '../../../src/config/site-schema.js';
import { appDirs } from '../../../src/config/paths.js';
import { SafeFetcher } from '../../../src/crawler/fetch.js';
import { fixtureTransport } from '../../../src/crawler/transport.js';
import type { CrawlerDeps } from '../../../src/crawler/deps.js';
import { createSyntheticDataForSeoFetch } from '../../../src/integrations/dataforseo/synthetic.js';
import { initSiteVault } from '../../../src/obsidian/template.js';
import { SsrfGuard } from '../../../src/security/ssrf.js';
import { syntheticResolver, type ServiceOptions } from '../../../src/app/services.js';
import { createPipelineEnv, type PipelineEnv } from '../../../src/workflows/pipelines/common.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import type { RuntimeMode } from '../../../src/core/modes.js';
import type { EnvKey } from '../../../src/config/env.js';
import type { FetchLike } from '../../../src/integrations/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PIPELINE_FIXTURES = path.resolve(here, '../../fixtures/pipelines');
export const NOW = '2026-09-24T09:00:00.000Z';

type ConfigOverrides = Omit<Partial<SiteConfigInput>, 'site'> & { site?: Partial<SiteConfigInput['site']> };

/** Synthetic site config on reserved example.com hosts, matching the Google fixtures. */
export function pipelineConfig(overrides: ConfigOverrides = {}) {
  const { site, ...rest } = overrides;
  return testSiteConfig({
    profile: 'demo',
    market: { countries: [], languages: ['en'], searchLocations: [{ name: 'Synthetic Country', locationCode: 9990001, languageCode: 'en' }], devices: ['desktop'] },
    brand: { aliases: ['example widgets'] },
    google: { searchConsoleProperty: 'sc-domain:example.com', ga4PropertyId: '123456789' },
    conversions: { primaryEvents: [{ name: 'generate_lead', meaning: 'Demo request form submitted (synthetic)', kind: 'lead' }], secondaryEvents: [] },
    crawl: { requestDelayMs: 0, maxPages: 25 },
    research: { seriousQueriesPerRun: 3, dataforseo: { mode: 'sandbox' } } as SiteConfigInput['research'],
    ...rest,
    site: { id: 'demo-site', businessName: 'Example Widgets (synthetic)', url: 'https://www.example.com/', allowedHostnames: ['www.example.com'], ...(site ?? {}) },
  } as Parameters<typeof testSiteConfig>[0]);
}

/** A fetch that refuses every request: the context is "online" (not --offline) but no test may reach the network. */
export const refusingFetch: FetchLike & { calls: string[] } = Object.assign(
  async (input: string | URL) => {
    refusingFetch.calls.push(String(input));
    throw Object.assign(new Error(`network refused in tests: ${String(input)}`), { code: 'ECONNREFUSED' });
  },
  { calls: [] as string[] },
);

export function pipelineContext(opts: { config?: ReturnType<typeof pipelineConfig>; mode?: RuntimeMode; secrets?: Partial<Record<EnvKey, string>>; dryRun?: boolean; initVault?: boolean; online?: boolean } = {}): TestContext {
  refusingFetch.calls.length = 0;
  const ctx = createTestContext({
    config: opts.config ?? pipelineConfig(),
    now: NOW,
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.secrets ? { secrets: opts.secrets } : {}),
    ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
    ...(opts.online ? { fetch: refusingFetch } : {}),
  });
  if (opts.initVault !== false) initSiteVault({ templateDir: appDirs.vaultTemplate(), vaultRoot: ctx.paths.vaultRoot, siteId: ctx.siteId, businessName: ctx.config.site.businessName });
  return ctx;
}

export const COMPETITOR_HOSTS = ['competitor-1.example', 'competitor-2.example', 'competitor-3.example', 'competitor-4.example', 'competitor-5.example'];

/**
 * Competitor pages: competitor-1 serves an article (with a fake injection
 * line), competitor-2 disallows crawling in robots.txt, competitor-3 answers
 * 403, the others 404. Requests are counted.
 */
export function competitorCrawler(): CrawlerDeps & { requests: string[] } {
  const article = readFileSync(path.join(PIPELINE_FIXTURES, 'competitors/article.html'), 'utf8');
  const requests: string[] = [];
  const transport = fixtureTransport((raw) => {
    requests.push(raw);
    const u = new URL(raw);
    if (u.pathname === '/robots.txt') {
      if (u.hostname === 'competitor-2.example') return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /\n' };
      return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nAllow: /\n' };
    }
    if (u.hostname === 'competitor-1.example') return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: article };
    if (u.hostname === 'competitor-3.example') return { status: 403, headers: { 'content-type': 'text/html' }, body: 'forbidden (synthetic)' };
    return undefined;
  });
  const fetcher = new SafeFetcher({
    guard: new SsrfGuard({ resolver: syntheticResolver(COMPETITOR_HOSTS) }),
    transport,
    userAgent: 'seo-agent-test/1.0 (+synthetic)',
    timeoutMs: 2_000,
    maxBytes: 200_000,
    maxRedirects: 3,
    perHostConcurrency: 1,
    delayMs: 0,
  });
  return Object.assign({ fetcher }, { requests });
}

export interface TestEnv extends PipelineEnv {
  competitor: ReturnType<typeof competitorCrawler>;
  dfsCalls: string[];
}

/** Pipeline environment for tests: demo fixtures plus the competitor fixture transport and a counted DataForSEO transport. */
export function testEnv(extra: ServiceOptions = {}): TestEnv {
  const competitor = competitorCrawler();
  const synthetic = createSyntheticDataForSeoFetch();
  const dfsCalls: string[] = [];
  const env = createPipelineEnv({
    competitorCrawler: competitor,
    dataforseo: {
      mode: 'fixture',
      fetch: async (input, init) => {
        dfsCalls.push(`${(init?.method ?? 'GET').toUpperCase()} ${String(input)}`);
        return synthetic(input, init);
      },
      sleep: async () => {},
    },
    ...extra,
  });
  return Object.assign(env, { competitor, dfsCalls });
}

export function count(ctx: TestContext, sql: string, params: unknown[] = []): number {
  return Number(ctx.db.get<{ n: number }>(sql, params)?.n ?? 0);
}
