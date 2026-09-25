import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { syntheticResolver, type ServiceOptions } from '../app/services.js';
import type { CrawlerDeps } from '../crawler/deps.js';
import { SafeFetcher } from '../crawler/fetch.js';
import { fixtureTransport } from '../crawler/transport.js';
import { toMicros, type Micros } from '../core/money.js';
import { createSyntheticDataForSeoFetch } from '../integrations/dataforseo/synthetic.js';
import type { FetchLike } from '../integrations/types.js';
import { SsrfGuard } from '../security/ssrf.js';
import { createPipelineEnv, type PipelineEnv } from '../workflows/pipelines/common.js';
import { demoFixturesDir } from './workspace.js';

/**
 * In-process SYNTHETIC fixture adapters for the offline demo. Nothing here
 * opens a socket: every "HTTP" answer is produced from files under
 * tests/fixtures (reserved example domains only), and every provider row they
 * lead to is flagged synthetic / sandbox.
 */

/** Reserved competitor hosts produced by the synthetic DataForSEO SERP fixture. */
export const DEMO_COMPETITOR_HOSTS = Array.from({ length: 10 }, (_, i) => `competitor-${i + 1}.example`);

export interface CountingFetch extends FetchLike {
  calls: string[];
}

/** DataForSEO fixture transport that records every request (the demo shows the count; nothing leaves the process). */
export function countingSyntheticDataForSeo(): CountingFetch {
  const synthetic = createSyntheticDataForSeoFetch();
  const calls: string[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${String(input).replace(/\?.*$/, '')}`);
    return synthetic(input, init);
  }) as CountingFetch;
  fn.calls = calls;
  return fn;
}

/**
 * Competitor pages for the demo (tests/fixtures/demo/competitors): an article
 * with a fake injection line, a robots.txt that disallows crawling, a login
 * barrier (401), an access denial (403), and 404 everywhere else. Requests are
 * recorded so the walkthrough can show that blocked pages were never fetched.
 */
export function demoCompetitorCrawler(userAgent: string): CrawlerDeps & { requests: string[] } {
  const dir = path.join(demoFixturesDir(), 'competitors');
  const article = readFileSync(path.join(dir, 'article.html'), 'utf8');
  const login = readFileSync(path.join(dir, 'login.html'), 'utf8');
  const requests: string[] = [];
  const html = { 'content-type': 'text/html; charset=utf-8' };
  const text = { 'content-type': 'text/plain; charset=utf-8' };
  const transport = fixtureTransport((raw) => {
    requests.push(raw);
    const u = new URL(raw);
    if (u.pathname === '/robots.txt') {
      if (u.hostname === 'competitor-2.example') return { status: 200, headers: text, body: '# SYNTHETIC robots.txt\nUser-agent: *\nDisallow: /\n' };
      return { status: 200, headers: text, body: '# SYNTHETIC robots.txt\nUser-agent: *\nAllow: /\n' };
    }
    if (u.hostname === 'competitor-1.example') return { status: 200, headers: html, body: article };
    if (u.hostname === 'competitor-3.example') return { status: 401, headers: { ...html, 'www-authenticate': 'Basic realm="synthetic"' }, body: login };
    if (u.hostname === 'competitor-4.example') return { status: 403, headers: text, body: 'Forbidden (synthetic)' };
    return undefined;
  });
  const fetcher = new SafeFetcher({
    guard: new SsrfGuard({ resolver: syntheticResolver(DEMO_COMPETITOR_HOSTS) }),
    transport,
    userAgent,
    timeoutMs: 5_000,
    maxBytes: 500_000,
    maxRedirects: 3,
    perHostConcurrency: 1,
    delayMs: 0,
  });
  return Object.assign({ fetcher }, { requests });
}

export interface DemoEnv extends PipelineEnv {
  dataforseoCalls: string[];
  competitor: ReturnType<typeof demoCompetitorCrawler>;
}

/**
 * Pipeline environment of the demo: the demo-profile services (fixture Google
 * provider, deterministic fixture LLM, synthetic DataForSEO transport, fixture
 * crawler over the demo's own copy of the synthetic site) plus the synthetic
 * competitor pages.
 */
export function createDemoEnv(opts: { siteDir: string; userAgent: string; extra?: ServiceOptions }): DemoEnv {
  const dfs = countingSyntheticDataForSeo();
  const competitor = demoCompetitorCrawler(opts.userAgent);
  const env = createPipelineEnv({
    fixtureSiteDir: opts.siteDir,
    competitorCrawler: competitor,
    dataforseo: { mode: 'fixture', fetch: dfs, sleep: async () => {} },
    ...(opts.extra ?? {}),
  });
  return Object.assign(env, { dataforseoCalls: dfs.calls, competitor });
}

/** Synthetic Reddit-like dataset items (tests/fixtures/demo/apify/dataset.json). */
export function demoApifyItems(): unknown[] {
  const file = path.join(demoFixturesDir(), 'apify', 'dataset.json');
  if (!existsSync(file)) return [];
  const doc = JSON.parse(readFileSync(file, 'utf8')) as { _synthetic?: boolean; items?: unknown[] };
  if (doc._synthetic !== true) throw new Error(`${file} is not labeled synthetic; the demo only loads synthetic fixtures.`);
  return doc.items ?? [];
}

/** SYNTHETIC per-request prices for the demo's budget step (tests/fixtures/demo/budget-prices.json). */
export interface DemoBudgetPrices {
  provider: 'dataforseo';
  endpoint: string;
  estimateMicros: Micros;
  actualMicros: Micros;
  requests: number;
  loweredPerRunCapMicros: Micros;
}

export function demoBudgetPrices(): DemoBudgetPrices {
  const file = path.join(demoFixturesDir(), 'budget-prices.json');
  const doc = JSON.parse(readFileSync(file, 'utf8')) as { _synthetic?: boolean; provider?: string; endpoint?: string; estimateUsd?: string; actualUsd?: string; requests?: number; loweredPerRunCapUsd?: string };
  if (doc._synthetic !== true) throw new Error(`${file} is not labeled synthetic; the demo only loads synthetic fixtures.`);
  if (doc.provider !== 'dataforseo' || !doc.endpoint?.startsWith('synthetic/') || !doc.estimateUsd || !doc.actualUsd || !doc.loweredPerRunCapUsd || !Number.isInteger(doc.requests) || doc.requests! < 1) {
    throw new Error(`${file} is not a valid synthetic demo price fixture.`);
  }
  return {
    provider: 'dataforseo',
    endpoint: doc.endpoint,
    estimateMicros: toMicros(doc.estimateUsd),
    actualMicros: toMicros(doc.actualUsd),
    requests: doc.requests!,
    loweredPerRunCapMicros: toMicros(doc.loweredPerRunCapUsd),
  };
}
