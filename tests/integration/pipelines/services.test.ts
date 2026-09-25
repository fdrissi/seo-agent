import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { collectStatuses, createServices, createSsrfSafePageFetcher, jobsStatus, syntheticResolver } from '../../../src/app/services.js';
import { installWiring, uninstallWiring } from '../../../src/app/wiring.js';
import { sitePageFetcherFromContext } from '../../../src/approvals/page-fetch.js';
import { siteVaultDir } from '../../../src/config/paths.js';
import { resolveContentDeps } from '../../../src/content/deps.js';
import { SafeFetcher } from '../../../src/crawler/fetch.js';
import { fixtureTransport } from '../../../src/crawler/transport.js';
import { createFixtureGoogleAuthProvider } from '../../../src/integrations/google/fixture-provider.js';
import { syncGa4 } from '../../../src/integrations/google/ga4-sync.js';
import { createDefaultRegistry } from '../../../src/jobs/handlers.js';
import { resolveMemoryLlm } from '../../../src/memory/wiring.js';
import { collectDashboardStatuses } from '../../../src/obsidian/status.js';
import { SsrfGuard, type Resolver } from '../../../src/security/ssrf.js';
import type { TestContext } from '../../helpers/context.js';
import { count, pipelineConfig, pipelineContext, refusingFetch } from './helpers.js';

let ctx: TestContext | undefined;
afterEach(() => {
  uninstallWiring();
  ctx?.cleanup();
  ctx = undefined;
});

const GOOGLE_FIXTURES = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../fixtures/google');

describe('createServices', () => {
  it('never throws for missing optional integrations; the LLM client is disabled and answers not_configured honestly', async () => {
    ctx = pipelineContext({ config: pipelineConfig({ profile: 'full' }), online: true });
    const svc = createServices(ctx);
    expect(svc.llmKind).toBe('disabled');
    expect(svc.llm.isConfigured('cheap')).toBe(false);
    const res = await svc.llm.structured({ siteId: ctx.siteId, runId: 'r', role: 'classifier', tier: 'cheap', promptId: 'router.classify-intent', variables: {}, evidence: [], schema: z.object({}), schemaName: 'X' });
    expect(res).toMatchObject({ ok: false, status: 'not_configured' });
    if (!res.ok) expect(res.nextStep).toMatch(/secrets\.env/);
    expect(svc.issues.find((i) => i.id === 'llm_gateway')?.state).toBe('missing_credentials');
    expect(svc.google.provider?.mode).toBe('oauth');
    expect(svc.apify.client).toBeNull();
    expect(svc.vault).not.toBeNull();
    expect(refusingFetch.calls).toHaveLength(0);
  });

  it('uses the LLM Gateway client (with the approval gate) only when a key and models are configured', () => {
    ctx = pipelineContext({ config: pipelineConfig({ profile: 'core' }), online: true, secrets: { LLM_GATEWAY_API_KEY: 'synthetic-test-key-not-real', CHEAP_MODEL: 'synthetic/cheap-model' } });
    const svc = createServices(ctx);
    expect(svc.llmKind).toBe('gateway');
    expect(svc.llm.isConfigured('cheap')).toBe(true);
    expect(svc.llm.isConfigured('reasoning')).toBe(false);
  });

  it('demo profile: fixture Google provider, synthetic fixture LLM client, fixture crawler, and the synthetic DataForSEO transport', () => {
    ctx = pipelineContext();
    const svc = createServices(ctx);
    expect(svc.google.provider?.mode).toBe('fixture');
    expect(svc.llmKind).toBe('fixture');
    expect(svc.llm.synthetic).toBe(true);
    expect(svc.crawler.fetcher?.transport.kind).toBe('fixture');
    expect(svc.dataforseo.mode).toBe('fixture');
    expect(svc.issues.map((i) => i.state)).toEqual(expect.arrayContaining(['fixture']));
  });

  it('an invalid GOOGLE_AUTH_MODE is a configuration status, not a crash', async () => {
    ctx = pipelineContext({ config: pipelineConfig({ profile: 'core' }), online: true, secrets: { GOOGLE_AUTH_MODE: 'fixture' } });
    const svc = createServices(ctx);
    expect(svc.google.provider).toBeNull();
    expect(svc.issues.find((i) => i.id === 'google_auth')).toMatchObject({ state: 'misconfigured' });
    const statuses = await collectStatuses(ctx, svc, { network: false });
    expect(statuses.find((s) => s.id === 'google_auth')).toMatchObject({ state: 'misconfigured' });
    expect(statuses.find((s) => s.id === 'google_auth')!.detail).toMatch(/demo profile/);
  });
});

describe('collectStatuses and jobsStatus', () => {
  it('aggregates every slice status offline without any network request or chargeable check', async () => {
    ctx = pipelineContext({ config: pipelineConfig({ profile: 'full' }), online: true });
    const statuses = await collectStatuses(ctx, null, { network: false });
    const ids = new Set(statuses.map((s) => s.id));
    for (const id of ['google_auth', 'llm_gateway', 'qdrant', 'crawler', 'playwright', 'pagespeed', 'crux', 'dataforseo', 'apify', 'obsidian']) expect(ids.has(id as never), id).toBe(true);
    expect(statuses.every((s) => !s.networkChecked && !s.chargeable)).toBe(true);
    expect(refusingFetch.calls).toHaveLength(0);
    expect(statuses.find((s) => s.id === 'dataforseo')?.state).toMatch(/missing_credentials|disabled/);
  });

  it('reports jobs, locks, and schedules (read-only)', async () => {
    installWiring();
    ctx = pipelineContext();
    const s = jobsStatus(ctx, createDefaultRegistry());
    expect(s.handlers).toEqual(expect.arrayContaining(['baseline', 'weekly', 'monthly', 'content.queue']));
    expect(s.schedules.map((x) => x.jobType)).toEqual(['weekly', 'monthly']);
    expect(s.notes.join(' ')).toMatch(/opt-in/);
  });
});

describe('central wiring', () => {
  it('installs concrete dependencies for memory, content, the vault dashboard, and approvals', async () => {
    ctx = pipelineContext();
    installWiring();
    installWiring(); // idempotent
    const mem = await resolveMemoryLlm(ctx);
    expect(mem.source).toBe('registered-factory');
    expect(mem.llm?.synthetic).toBe(true);
    const content = await resolveContentDeps(ctx);
    for (const name of ['llm', 'memory', 'approvals', 'vault'] as const) expect(content.status.find((s) => s.name === name), name).toMatchObject({ wired: true, detail: 'provided by registered factory' });
    const dash = await collectDashboardStatuses(ctx, siteVaultDir(ctx.paths, ctx.siteId));
    expect(dash.statuses.length).toBeGreaterThan(5);
    expect(dash.note).toMatch(/Offline checks only/);
  });

  it('approval target rechecks use the SSRF-safe fetcher (static checks before any request, DNS answers classified)', async () => {
    ctx = pipelineContext({ config: pipelineConfig({ profile: 'core', site: { url: 'http://127.0.0.1/', allowedHostnames: ['127.0.0.1'] } }), online: true });
    const before = await sitePageFetcherFromContext(ctx)('http://127.0.0.1/pricing');
    expect(before).toMatchObject({ ok: false, reason: 'network_error' }); // minimal default fetcher: it tried ctx.fetch
    expect(refusingFetch.calls.length).toBe(1);
    installWiring();
    const after = await sitePageFetcherFromContext(ctx)('http://127.0.0.1/pricing');
    expect(after).toMatchObject({ ok: false, reason: 'unsafe_url' }); // loopback refused by the SSRF guard, nothing sent
    expect(refusingFetch.calls.length).toBe(1);
  });
});

describe('createSsrfSafePageFetcher', () => {
  function deps(resolver: Resolver, routes: Record<string, { status?: number; headers?: Record<string, string>; body?: string }>) {
    const fetcher = new SafeFetcher({ guard: new SsrfGuard({ resolver }), transport: fixtureTransport(routes), userAgent: 'seo-agent-test', timeoutMs: 1000, maxBytes: 100_000, maxRedirects: 3, perHostConcurrency: 1, delayMs: 0 });
    return { fetcher };
  }

  it('fetches own pages, maps 404 for target fingerprints, and refuses other hosts, private DNS answers, and off-site redirects', async () => {
    ctx = pipelineContext();
    const good = deps(syntheticResolver(['www.example.com', 'evil.example']), {
      'https://www.example.com/ok': { status: 200, headers: { 'content-type': 'text/html' }, body: '<html><title>ok</title></html>' },
      'https://www.example.com/gone': { status: 404, headers: { 'content-type': 'text/html' }, body: 'nope' },
      'https://www.example.com/away': { status: 301, headers: { location: 'https://evil.example/' } },
    });
    const f = createSsrfSafePageFetcher(ctx, good);
    const ok = await f('https://www.example.com/ok');
    expect(ok.ok && ok.page.html).toMatch(/ok/);
    expect(await f('https://www.example.com/gone')).toMatchObject({ ok: false, reason: 'http_error', status: 404 });
    expect(await f('https://other.example/')).toMatchObject({ ok: false, reason: 'blocked_host' });
    expect(await f('https://www.example.com/away')).toMatchObject({ ok: false, reason: 'blocked_host' });
    const privateDns = createSsrfSafePageFetcher(ctx, deps(async () => [{ address: '10.0.0.7', family: 4 }], {}));
    expect(await privateDns('https://www.example.com/ok')).toMatchObject({ ok: false, reason: 'unsafe_url' });
  });
});

describe('syncGa4 explicit periods (report period at period grain)', () => {
  it('fetches period-level users/rates for exactly the requested period and rejects invalid periods', async () => {
    ctx = pipelineContext({ config: pipelineConfig({ profile: 'core', google: { searchConsoleProperty: 'sc-domain:example.com', ga4PropertyId: '123456789' } }), online: true });
    const provider = createFixtureGoogleAuthProvider(GOOGLE_FIXTURES, { gscProperty: 'sc-domain:example.com', ga4PropertyId: '123456789', clock: ctx.clock });
    const r = await syncGa4(ctx, { provider, days: 20, periodWindows: [], periods: [{ start: '2026-09-14', end: '2026-09-20' }] });
    expect(r.status).not.toBe('failed');
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_period_metrics WHERE site_id = ? AND period_start = '2026-09-14' AND period_end = '2026-09-20' AND metric = 'totalUsers'", [ctx.siteId])).toBeGreaterThan(0);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM ga4_period_metrics WHERE site_id = ? AND NOT (period_start = '2026-09-14' AND period_end = '2026-09-20')", [ctx.siteId])).toBe(0);
    await expect(syncGa4(ctx, { provider, periods: [{ start: '2026-09-20', end: '2026-09-14' }] })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    const dry = await syncGa4(ctx, { provider, dryRun: true, periodWindows: [], periods: [{ start: '2026-09-14', end: '2026-09-20' }] });
    expect(dry.plan?.reports.join(' ')).toMatch(/explicit period 2026-09-14\.\.2026-09-20/);
  });
});
