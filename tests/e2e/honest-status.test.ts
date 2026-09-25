/**
 * Honest, actionable statuses (spec 31: "no credentials, failed optional
 * APIs, an empty site, a blocked competitor crawl, and a budget exhaustion
 * each produce honest actionable statuses rather than fake successful
 * data"). End to end through the real pipelines and adapters; every
 * provider is a synthetic fixture or a refusing fake, nothing reaches the
 * network (tests/setup.ts makes the global fetch throw).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectStatuses, createServices, fixtureCrawlerDeps } from '../../src/app/services.js';
import { appDirs } from '../../src/config/paths.js';
import { crawlCompetitorPages } from '../../src/crawler/competitor.js';
import { runLowDataBootstrap } from '../../src/content/bootstrap.js';
import { demoCompetitorCrawler, demoFixturesDir } from '../../src/demo/index.js';
import { createDemoEnv } from '../../src/demo/fixtures.js';
import { inspectActor } from '../../src/integrations/apify/schema.js';
import { listApifyRuns, runContentResearch } from '../../src/integrations/apify/runs.js';
import type { FetchLike } from '../../src/integrations/types.js';
import { memoryStatus } from '../../src/memory/service.js';
import { initSiteVault } from '../../src/obsidian/template.js';
import { createPipelineEnv, type ReportOutput } from '../../src/workflows/pipelines/common.js';
import { runPipeline } from '../../src/workflows/pipelines/handlers.js';
import type { ResearchOutput } from '../../src/workflows/pipelines/weekly.js';
import { FakeApify, TEST_TOKEN } from '../fixtures/apify/fake-apify.js';
import { installFixtureVault, memoryHarness, type MemoryHarness } from '../fixtures/memory/setup.js';
import { createTestContext, testSiteConfig, type TestContext } from '../helpers/context.js';
import { allClaims, type Report } from '../../src/reports/model.js';

const NOW = '2026-09-24T09:00:00.000Z';
const PIPELINE_SITE = path.join(appDirs.fixtures(), 'pipelines', 'site');
const EMPTY_SITE = path.join(demoFixturesDir(), 'empty-site');

let ctx: TestContext | undefined;
let harness: MemoryHarness | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
  harness?.ctx.cleanup();
  harness = undefined;
});

/** Online context whose every request is refused and recorded (so "no request was attempted" can be asserted). */
function refusingFetch(): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn: FetchLike = async (input) => {
    calls.push(String(input));
    throw Object.assign(new Error(`network refused in tests: ${String(input)}`), { code: 'ECONNREFUSED' });
  };
  return Object.assign(fn, { calls });
}

function count(c: TestContext, sql: string, params: unknown[] = []): number {
  return Number(c.db.get<{ n: number }>(sql, params)?.n ?? 0);
}

function withVault(c: TestContext): TestContext {
  initSiteVault({ templateDir: appDirs.vaultTemplate(), vaultRoot: c.paths.vaultRoot, siteId: c.siteId, businessName: c.config.site.businessName });
  return c;
}

describe('honest statuses (end to end)', () => {
  it('no credentials: every integration says what is missing, nothing is ingested or invented, and the report states the blockers', async () => {
    const fetch = refusingFetch();
    ctx = withVault(
      createTestContext({
        config: testSiteConfig({
          profile: 'full',
          site: { id: 'nocreds-site', businessName: 'No Credentials Co (synthetic)', url: 'https://www.example.com/', allowedHostnames: ['www.example.com'] },
          google: { searchConsoleProperty: 'sc-domain:example.com', ga4PropertyId: '123456789' },
          conversions: { primaryEvents: [{ name: 'generate_lead', meaning: 'Lead form (synthetic)', kind: 'lead' }], secondaryEvents: [] },
          research: { dataforseo: { mode: 'live' } } as never,
          crawl: { requestDelayMs: 0, maxPages: 10 },
        }),
        now: NOW,
        fetch,
      }),
    );
    // The own-site crawl reads a synthetic site in-process (the site itself is reachable; only credentials are missing).
    const env = createPipelineEnv({ crawler: fixtureCrawlerDeps(ctx, PIPELINE_SITE) });
    const r = await runPipeline(ctx, 'baseline', {}, { env });
    expect(r.outcome).toBe('succeeded');
    expect(r.note).toMatch(/degraded/);
    const degraded = Object.fromEntries(r.workflow.degraded.map((d) => [d.stage, d.code]));
    expect(degraded.sync_gsc).toBe('CREDENTIALS_MISSING');
    expect(degraded.sync_ga4).toBe('CREDENTIALS_MISSING');

    const access = r.outputs.check_access as { problems: Array<{ id: string; state: string; nextStep: string | null }> };
    const problems = Object.fromEntries(access.problems.map((p) => [p.id, p]));
    for (const id of ['google_auth', 'google_gsc', 'google_ga4', 'llm_gateway', 'dataforseo', 'apify', 'pagespeed']) {
      expect(problems[id]?.state, id).toBe('missing_credentials');
      expect(problems[id]?.nextStep, id).toBeTruthy();
    }
    // Never a secret request in chat: the next steps point to the secrets file.
    expect(problems.llm_gateway!.nextStep).toMatch(/secrets\.env/);

    // Nothing fabricated: no Google rows, no model calls, no paid requests, no network attempts.
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM gsc_page_daily WHERE site_id = ?', [ctx.siteId])).toBe(0);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM ga4_landing_daily WHERE site_id = ?', [ctx.siteId])).toBe(0);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM llm_calls WHERE site_id = ?', [ctx.siteId])).toBe(0);
    // No paid request and no request to a credentialed provider. The only attempts are free, unauthenticated
    // checks (local Qdrant health, keyless PageSpeed); they were refused here and are reported, not hidden.
    expect(count(ctx, "SELECT COUNT(*) AS n FROM provider_requests WHERE site_id = ? AND (is_paid = 1 OR provider IN ('llm_gateway', 'dataforseo', 'apify', 'google_gsc', 'google_ga4'))", [ctx.siteId])).toBe(0);
    expect(fetch.calls.map((u) => new URL(u).host).filter((h) => h !== '127.0.0.1:6333' && h !== 'pagespeedonline.googleapis.com')).toEqual([]);
    expect(problems.qdrant?.state).toBe('unreachable');
    expect(count(ctx, "SELECT COUNT(*) AS n FROM provider_requests WHERE site_id = ? AND provider = 'pagespeed' AND status = 'succeeded'", [ctx.siteId])).toBe(0);

    const report = r.outputs.report as ReportOutput;
    // The own-site crawl rows came from the synthetic fixture site, so the report is honestly watermarked as synthetic.
    expect(report.isSynthetic).toBe(true);
    expect(report.accessIssues).toBeGreaterThan(0);
    expect(report.primaryAction ?? report.nextAction ?? '').toMatch(/repair|wait|collect|measurement|credential|access/i);
    const md = readFileSync(path.join(ctx.paths.root, report.markdownFile!), 'utf8');
    expect(md).toMatch(/CREDENTIALS\\?_MISSING/);
    expect(md).toMatch(/DATA UNAVAILABLE|DATA\\?_UNAVAILABLE/);
  });

  it('no credentials, DRY RUN: the Google sync stages fail with CREDENTIALS_MISSING like the real run, never a bare "succeeded" (C3-04)', async () => {
    const fetch = refusingFetch();
    ctx = withVault(
      createTestContext({
        config: testSiteConfig({
          profile: 'core',
          site: { id: 'nocreds-dry', businessName: 'No Credentials Dry Run Co (synthetic)', url: 'https://www.example.com/', allowedHostnames: ['www.example.com'] },
          google: { searchConsoleProperty: 'sc-domain:example.com', ga4PropertyId: '123456789' },
          crawl: { requestDelayMs: 0, maxPages: 10 },
        }),
        now: NOW,
        fetch,
        dryRun: true,
      }),
    );
    const env = createPipelineEnv({ crawler: fixtureCrawlerDeps(ctx, PIPELINE_SITE) });
    const r = await runPipeline(ctx, 'baseline', {}, { env });
    expect(r.dryRun).toBe(true);
    const byStage = Object.fromEntries(r.workflow.stages.map((s) => [s.stage, s]));
    for (const stage of ['sync_gsc', 'sync_ga4']) {
      expect(byStage[stage]?.status, stage).toBe('failed');
      expect(byStage[stage]?.error?.code, stage).toBe('CREDENTIALS_MISSING');
      expect(r.degradedStages.find((d) => d.stage === stage), stage).toMatchObject({ code: 'CREDENTIALS_MISSING' });
    }
    // Nothing was requested from Google and nothing was ingested.
    expect(fetch.calls.filter((u) => /googleapis\.com\/(webmasters|analyticsdata|searchconsole)|oauth2/.test(u))).toEqual([]);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM gsc_page_daily WHERE site_id = ?', [ctx.siteId])).toBe(0);
  });

  it('Qdrant down: retrieval falls back to full-text search, says it is degraded, and the status reports it', async () => {
    harness = memoryHarness();
    installFixtureVault(harness.ctx);
    await harness.service.sync({ allowPaid: true });
    harness.qdrant.down = true;
    const res = await harness.service.search({ siteId: harness.ctx.siteId, text: 'school discount' });
    expect(res.method).toBe('fts_only');
    expect(res.degraded).toBe(true);
    expect(res.degradedReason).toMatch(/Qdrant unavailable/);
    expect(res.chunks.length).toBeGreaterThan(0); // real full-text results, not an empty "success"
    const status = await memoryStatus(harness.ctx, { network: false, llm: harness.embedder });
    expect(status.integration.state).toBe('degraded');
    expect(status.integration.detail).toMatch(/Qdrant unavailable/);
  });

  it('Apify run fails: results are quarantined (never treated as research), the charge is still reconciled, the status is actionable', async () => {
    const fake = new FakeApify();
    ctx = createTestContext({
      config: testSiteConfig({ features: { apify: true }, research: { seedTopics: ['invoicing software'], apify: { build: '0.0.513' } } as never }),
      secrets: { APIFY_TOKEN: TEST_TOKEN },
      fetch: fake.fetch,
      mode: 'RESEARCH',
      now: NOW,
    });
    await inspectActor(ctx, { clientOptions: { sleep: async () => {} } });
    fake.nextStatuses = ['RUNNING', 'FAILED'];
    fake.nextFinalFields = { usageTotalUsd: 0.02, statusMessage: 'Actor failed (synthetic)' };
    const r = await runContentResearch(ctx, { runtime: { sleep: async () => {}, pollWaitSecs: 0, stableUsageDelayMs: 0 }, maxItems: 10, maxCommentsPerPost: 2 });
    expect(r.status).toBe('quarantined');
    expect(r.quarantineReason).toMatch(/FAILED/);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM content_signals WHERE site_id = ?', [ctx.siteId])).toBe(0);
    expect(listApifyRuns(ctx)[0]).toMatchObject({ status: 'quarantined', processingStatus: 'quarantined' });
    // The provider-reported charge is reconciled, never dropped to $0 or left as an invisible reservation.
    const res = ctx.db.get<{ status: string; actual_usd_micros: number | null }>("SELECT status, actual_usd_micros FROM budget_reservations WHERE site_id = ? AND provider = 'apify'", [ctx.siteId]);
    expect(res).toMatchObject({ status: 'reconciled', actual_usd_micros: 20_000 });
    // The content queue carries on without the quarantined data.
    const q = await runPipeline(ctx, 'content.queue', {}, { env: createPipelineEnv({ apifyClient: null }) });
    expect(q.outcome).toBe('succeeded');
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM content_signals WHERE site_id = ? AND origin = ?', [ctx.siteId, 'apify_reddit'])).toBe(0);
  });

  function newSiteContext(): TestContext {
    return withVault(
      createTestContext({
        config: testSiteConfig({
          profile: 'demo',
          site: { id: 'new-site', businessName: 'Example New Widgets (synthetic)', url: 'https://www.example.com/', allowedHostnames: ['www.example.com'] },
          business: { offer: 'Synthetic widget subscriptions for small teams.', targetCustomer: 'Synthetic small teams' },
          google: { searchConsoleProperty: 'sc-domain:example.com', ga4PropertyId: '123456789' },
          conversions: { primaryEvents: [{ name: 'generate_lead', meaning: 'Lead form (synthetic)', kind: 'lead' }], secondaryEvents: [] },
          research: { seedTopics: ['widget setup checklist'] } as never,
          crawl: { requestDelayMs: 0, maxPages: 10 },
        }),
        now: NOW,
      }),
    );
  }

  it('empty site (no data at all): no invented metrics, "repair measurement or wait" instead of an opportunity, and the low-data bootstrap', async () => {
    ctx = newSiteContext();
    const env = createPipelineEnv({ googleFixturesDir: path.join(EMPTY_SITE, 'google'), fixtureSiteDir: path.join(EMPTY_SITE, 'site') });
    expect((await runPipeline(ctx, 'baseline', {}, { env })).outcome).toBe('succeeded');
    const weekly = await runPipeline(ctx, 'weekly', {}, { env });
    expect(weekly.outcome).toBe('succeeded');

    // Nothing was measured, so nothing is stored as if it were (Search Console omits empty days: missing, not zero).
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM gsc_page_daily WHERE site_id = ?', [ctx.siteId])).toBe(0);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM gsc_property_daily WHERE site_id = ?', [ctx.siteId])).toBe(0);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM ga4_landing_daily WHERE site_id = ?', [ctx.siteId])).toBe(0);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM crawl_results WHERE site_id = ?', [ctx.siteId])).toBeGreaterThan(0); // the site itself exists

    // No optimization opportunity is manufactured from missing data; the route says why.
    const routes = ctx.db.all<{ route: string }>('SELECT route FROM route_decisions WHERE site_id = ? AND job_id = ?', [ctx.siteId, weekly.jobId]).map((x) => x.route);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.filter((x) => ['RANKING_OPPORTUNITY', 'CTR_OPPORTUNITY', 'CONVERSION_OPPORTUNITY', 'DECLINE', 'HEALTHY'].includes(x))).toEqual([]);
    const joins = weekly.outputs.validate_joins as { note: { nextStep: string | null } | null };
    expect(joins.note?.nextStep).toMatch(/wait|repair/i);
    const rec = ctx.db.get<{ kind: string }>('SELECT kind FROM recommendations WHERE site_id = ? ORDER BY created_at DESC LIMIT 1', [ctx.siteId]);
    expect(['no_action', 'repair_measurement', 'collect_more_evidence']).toContain(rec?.kind);
    const report = weekly.outputs.report as ReportOutput;
    const md = readFileSync(path.join(ctx.paths.root, report.markdownFile!), 'utf8');
    expect(md).toMatch(/DATA UNAVAILABLE|DATA\\?_UNAVAILABLE/);

    // Low-data bootstrap: an offer-page brief, one supporting-page brief when a topic exists, readiness checks; no conversion history assumed.
    const svc = createServices(ctx, env.serviceOptions);
    const boot = await runLowDataBootstrap(ctx, { llm: svc.llm, memory: svc.memory, approvals: svc.approvals, vault: svc.vault }, { requestApproval: false });
    expect(boot.lowData).toMatchObject({ isLowData: true, impressions28d: null });
    expect(boot.lowData.reason).toMatch(/No Search Console property data/);
    expect(boot.offerPage?.itemId).toBeTruthy();
    expect(boot.readiness.length).toBeGreaterThan(0);
    expect(boot.conversionHistory).toMatch(/No historical conversion evidence/);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM content_briefs WHERE site_id = ?', [ctx.siteId])).toBeGreaterThanOrEqual(1);
  });

  it('small new site (a few impressions): the router takes the LOW_DATA bootstrap route', async () => {
    ctx = newSiteContext();
    const env = createPipelineEnv({ googleFixturesDir: path.join(EMPTY_SITE, 'google-small'), fixtureSiteDir: path.join(EMPTY_SITE, 'site') });
    expect((await runPipeline(ctx, 'baseline', {}, { env })).outcome).toBe('succeeded');
    const weekly = await runPipeline(ctx, 'weekly', {}, { env });
    expect(weekly.outcome).toBe('succeeded');
    const site = ctx.db.get<{ route: string; reason_codes_json: string }>("SELECT route, reason_codes_json FROM route_decisions WHERE site_id = ? AND job_id = ? AND subject_type = 'site'", [ctx.siteId, weekly.jobId]);
    expect(site?.route).toBe('LOW_DATA');
    const impressions = count(ctx, "SELECT SUM(impressions) AS n FROM gsc_property_daily_current WHERE site_id = ? AND search_type = 'web'", [ctx.siteId]);
    expect(impressions).toBeGreaterThan(0);
    expect(impressions).toBeLessThan(ctx.config.router.lowDataSiteMaxImpressions * 4);
    const svc = createServices(ctx, env.serviceOptions);
    const boot = await runLowDataBootstrap(ctx, { llm: svc.llm, memory: svc.memory, approvals: svc.approvals, vault: svc.vault }, { requestApproval: false });
    expect(boot.lowData.isLowData).toBe(true);
    expect(boot.lowData.impressions28d).toBeLessThan(boot.lowData.threshold);
    expect(boot.offerPage?.itemId).toBeTruthy();
  });

  it('blocked competitor crawl: robots.txt, login barriers, and access denials are recorded as blocked and never bypassed', async () => {
    ctx = createTestContext({ config: testSiteConfig({ crawl: { requestDelayMs: 0 } }), now: NOW, fetch: refusingFetch() });
    const competitor = demoCompetitorCrawler('seo-agent-e2e/1.0 (+synthetic)');
    const targets = ['competitor-1.example', 'competitor-2.example', 'competitor-3.example', 'competitor-4.example'].map((h) => ({ url: `https://${h}/widgets-guide`, query: 'how to choose a widget' }));
    // The URLs come from a stored (SYNTHETIC) SERP snapshot of the query, as in the weekly research stage:
    // a query URL that no stored SERP of the query lists is refused as not_approved (B6-10).
    ctx.db.run(
      `INSERT INTO serp_snapshots (id, site_id, query, provider, device, parameter_hash, items_count, is_sandbox, collected_at) VALUES ('serp_e2e_blocked', ?, 'how to choose a widget', 'dataforseo', 'desktop', 'ph_e2e', ?, 0, ?)`,
      [ctx.siteId, targets.length, NOW],
    );
    targets.forEach((t, i) =>
      ctx!.db.run(`INSERT INTO serp_results (snapshot_id, site_id, result_type, rank_group, rank_absolute, url, domain, is_own_site) VALUES ('serp_e2e_blocked', ?, 'organic', ?, ?, ?, ?, 0)`, [ctx!.siteId, i + 1, i + 1, t.url, new URL(t.url).hostname]),
    );
    const r = await crawlCompetitorPages(ctx, targets, { fetcher: competitor.fetcher! });
    const byHost = Object.fromEntries(r.pages.map((p) => [new URL(p.url).hostname, p]));
    expect(byHost['competitor-1.example']).toMatchObject({ status: 'fetched' });
    expect(byHost['competitor-2.example']).toMatchObject({ status: 'blocked', blockedReason: 'robots' });
    expect(byHost['competitor-3.example']).toMatchObject({ status: 'blocked', blockedReason: 'login_required' });
    expect(byHost['competitor-4.example']).toMatchObject({ status: 'blocked', blockedReason: 'access_denied' });
    expect(r.counts.blocked).toBe(3);
    // robots.txt disallow: the page itself was never requested; no content of blocked pages was stored.
    expect(competitor.requests.filter((u) => u.startsWith('https://competitor-2.example/') && !u.endsWith('/robots.txt'))).toEqual([]);
    for (const host of ['competitor-2.example', 'competitor-3.example', 'competitor-4.example']) expect(byHost[host]!.contentHash).toBeNull();
    // The fake instruction on competitor-1 is stored as untrusted data only; nothing was approved or changed.
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM approvals WHERE site_id = ?', [ctx.siteId])).toBe(0);
    expect(ctx.config.budgets.llmGateway.monthlyUsd).toBe('5.00');
  });

  it('synthetic demo data: every data-derived claim in the demo report carries the SYNTHETIC flag, not only the banner', async () => {
    ctx = withVault(
      createTestContext({
        config: testSiteConfig({
          profile: 'demo',
          site: { id: 'demo-flags-site', businessName: 'Demo Flags Co (synthetic)', url: 'https://www.example.com/', allowedHostnames: ['www.example.com'] },
          google: { searchConsoleProperty: 'sc-domain:example.com', ga4PropertyId: '123456789' },
          conversions: { primaryEvents: [{ name: 'generate_lead', meaning: 'Lead form (synthetic)', kind: 'lead' }], secondaryEvents: [] },
          brand: { aliases: ['Example'] },
          crawl: { requestDelayMs: 0, maxPages: 25 },
        }),
        now: NOW,
      }),
    );
    const env = createDemoEnv({ siteDir: PIPELINE_SITE, userAgent: 'seo-agent-e2e/1.0 (+synthetic)' });
    expect((await runPipeline(ctx, 'baseline', {}, { env })).outcome).toBe('succeeded');
    const r = await runPipeline(ctx, 'weekly', {}, { env });
    expect(r.outcome).toBe('succeeded');
    const out = r.outputs.report as ReportOutput;
    const report = JSON.parse(readFileSync(path.join(ctx.paths.root, out.markdownFile!.replace(/\.md$/, '.json')), 'utf8')) as Report;
    expect(report.isSynthetic).toBe(true);
    // Data-derived = OBSERVED/INFERRED claims computed from ingested measurement rows.
    const dataDerived = allClaims(report).filter((c) => (c.label === 'OBSERVED' || c.label === 'INFERRED') && (c.sourceIds.some((id) => id.startsWith('ingestion_batches:')) || /^(gsc|ga4|freshness\.(gsc|ga4))\./.test(c.id)));
    expect(dataDerived.length).toBeGreaterThan(5);
    expect(dataDerived.filter((c) => c.synthetic !== true).map((c) => c.id)).toEqual([]);
    // The three claims named by the audit, whenever the demo data produces them.
    for (const id of ['gsc.brand', 'gsc.query.unattributed', 'ga4.google_organic.vs_gsc']) {
      const c = allClaims(report).find((x) => x.id === id);
      if (c && c.label !== 'DATA_UNAVAILABLE') expect(c.synthetic, id).toBe(true);
    }
    const md = readFileSync(path.join(ctx.paths.root, out.markdownFile!), 'utf8');
    for (const line of md.split('\n').filter((l) => /^- \*\*(OBSERVED|INFERRED)\*\* /.test(l) && /(Clicks|Sessions|Impressions|Visible query rows|Search Console clicks)/.test(l))) {
      expect(line).toContain('[SYNTHETIC]');
    }
  });

  it('budget exhaustion: research stops before any request with an actionable status; the report is still produced', async () => {
    ctx = withVault(
      createTestContext({
        config: testSiteConfig({
          profile: 'demo',
          site: { id: 'budget-site', businessName: 'Budget Co (synthetic)', url: 'https://www.example.com/', allowedHostnames: ['www.example.com'] },
          google: { searchConsoleProperty: 'sc-domain:example.com', ga4PropertyId: '123456789' },
          conversions: { primaryEvents: [{ name: 'generate_lead', meaning: 'Lead form (synthetic)', kind: 'lead' }], secondaryEvents: [] },
          market: { countries: [], languages: ['en'], searchLocations: [{ name: 'Synthetic Country', locationCode: 9990001, languageCode: 'en' }], devices: ['desktop'] },
          research: { seriousQueriesPerRun: 3, dataforseo: { mode: 'sandbox' } } as never,
          crawl: { requestDelayMs: 0, maxPages: 25 },
        }),
        now: NOW,
        mode: 'RESEARCH',
      }),
    );
    // Spend the whole weekly DataForSEO budget with synthetic, reconciled reservations.
    const b = ctx.settings.budgets.dataforseo;
    for (let left = b.weekly, i = 0; left > 0; i++) {
      const amount = Math.min(left, b.perRun);
      const res = ctx.budgets.reserve({ siteId: ctx.siteId, provider: 'dataforseo', runId: `synthetic-prior-${i}`, purpose: 'synthetic prior spend (test)', estimate: { upperBoundMicros: amount, basis: { source: 'verified_config', detail: 'synthetic' } } });
      ctx.budgets.reconcile(res.id, { actualMicros: amount, source: 'manual' });
      left -= amount;
    }
    const env = createDemoEnv({ siteDir: PIPELINE_SITE, userAgent: 'seo-agent-e2e/1.0 (+synthetic)' });
    const r = await runPipeline(ctx, 'weekly', {}, { env });
    expect(r.outcome).toBe('succeeded');
    const d = r.workflow.degraded.find((x) => x.stage === 'research');
    expect(d?.code).toBe('BUDGET_EXCEEDED');
    expect(env.dataforseoCalls).toEqual([]);
    expect(env.competitor.requests).toEqual([]);
    const research = r.outputs.research as ResearchOutput | undefined;
    expect(research?.queries.length ?? 0).toBe(0);
    const report = r.outputs.report as ReportOutput;
    expect(report.persisted).toBe(true);
    const note = report.stageNotes.find((n) => n.stage === 'research')!;
    expect(note.code).toBe('BUDGET_EXCEEDED');
    expect(note.nextStep).toMatch(/budget/i);
    expect(note.nextStep).toMatch(/costs/);
    // Still one recommendation or an explicit wait, never invented research.
    expect(r.outputs.recommend).toBeDefined();
    const statuses = await collectStatuses(ctx, createServices(ctx, env.serviceOptions), { network: false });
    expect(statuses.every((s) => s.chargeable === false && s.networkChecked === false)).toBe(true);
  });
});
