import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureCrawlerDeps } from '../../../src/app/services.js';
import { OAuthGoogleAuthProvider } from '../../../src/auth/providers.js';
import { TOKEN_FORMAT, TokenStore } from '../../../src/auth/token-store.js';
import { checkpointDisplayStatus } from '../../../src/cli/commands/jobs.js';
import { pipelineHeadline, renderPipelineRun } from '../../../src/cli/commands/pipelines.js';
import { siteVaultDir } from '../../../src/config/paths.js';
import { runPipeline } from '../../../src/workflows/pipelines/handlers.js';
import type { CostPlanOutput } from '../../../src/workflows/pipelines/baseline.js';
import type { ReportOutput } from '../../../src/workflows/pipelines/common.js';
import type { TestContext } from '../../helpers/context.js';
import { count, NOW, PIPELINE_FIXTURES, pipelineConfig, pipelineContext, refusingFetch, testEnv } from './helpers.js';

/** Whole pipelines run in these tests; a loaded machine can exceed the default 20 s. */
const PIPELINE_TEST_TIMEOUT_MS = 60_000;

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

describe('baseline pipeline (demo profile, synthetic fixtures, offline)', () => {
  it('runs every stage end to end as a durable job and produces a labeled baseline report, dashboard, and vault notes', async () => {
    ctx = pipelineContext();
    const env = testEnv();
    const r = await runPipeline(ctx, 'baseline', {}, { env });
    expect(r.error).toBeNull();
    expect(r.outcome).toBe('succeeded');
    expect(r.workflow.status).toBe('succeeded');
    const byStage = Object.fromEntries(r.workflow.stages.map((s) => [s.stage, s.status]));
    for (const s of ['acquire_lock', 'check_access', 'sync_gsc', 'plan_period', 'sync_ga4', 'crawl_site', 'reconcile_urls', 'check_measurement', 'index_memory', 'cost_plan', 'report']) expect(byStage[s], s).toBe('succeeded');

    // Synthetic ingestion and crawl, flagged as such.
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM gsc_page_daily WHERE site_id = ?', [ctx.siteId])).toBeGreaterThan(0);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM gsc_page_daily WHERE site_id = ? AND is_synthetic = 0', [ctx.siteId])).toBe(0);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM ga4_landing_daily WHERE site_id = ?', [ctx.siteId])).toBeGreaterThan(0);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM crawls WHERE site_id = ? AND is_synthetic = 1 AND kind = 'own_site'", [ctx.siteId])).toBe(1);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM crawl_results WHERE site_id = ? AND render_mode = 'fixture'", [ctx.siteId])).toBeGreaterThan(3);

    // GA4 period metrics fetched for exactly the report period.
    const report = r.outputs.report as ReportOutput;
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM ga4_period_metrics WHERE site_id = ? AND period_start = ? AND period_end = ?', [ctx.siteId, report.period.start, report.period.end])).toBeGreaterThan(0);

    // Baseline: no paid research, no experiments, nothing published.
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM dataforseo_tasks WHERE site_id = ?', [ctx.siteId])).toBe(0);
    expect(env.dfsCalls).toHaveLength(0);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM apify_runs WHERE site_id = ?', [ctx.siteId])).toBe(0);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM experiments WHERE site_id = ?', [ctx.siteId])).toBe(0);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM publications WHERE site_id = ?', [ctx.siteId])).toBe(0);

    // Report: persisted, synthetic watermark, vault note + dashboard written through the VaultWriter.
    expect(report.persisted).toBe(true);
    expect(report.isSynthetic).toBe(true);
    expect(report.vaultNote).toMatch(/^07 Reports\//);
    const vault = siteVaultDir(ctx.paths, ctx.siteId);
    expect(existsSync(path.join(vault, report.vaultNote!))).toBe(true);
    const dashboard = readFileSync(path.join(vault, '00 Dashboard/Dashboard.md'), 'utf8');
    expect(dashboard).toMatch(/SYNTHETIC/);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM reports WHERE site_id = ? AND kind = 'baseline'", [ctx.siteId])).toBe(1);

    // Cost plan shown, not executed without explicit approval.
    const plan = r.outputs.cost_plan as CostPlanOutput;
    expect(plan.approved).toBe(false);
    expect(plan.display).toMatch(/PROPOSED COST PLAN/);
    expect(byStage.optional_ai).toBe('succeeded');
    expect((r.outputs.optional_ai as { ran: boolean }).ran).toBe(false);
  }, PIPELINE_TEST_TIMEOUT_MS);

  it('reports missing credentials honestly (core profile): Google stages degrade, the report states the blockers', async () => {
    ctx = pipelineContext({ config: pipelineConfig({ profile: 'core' }), online: true });
    const r = await runPipeline(ctx, 'baseline', {}, { env: testEnv() });
    expect(r.outcome).toBe('succeeded');
    expect(r.note).toMatch(/degraded/);
    const degraded = Object.fromEntries(r.workflow.degraded.map((d) => [d.stage, d.code]));
    expect(degraded.sync_gsc).toBe('CREDENTIALS_MISSING');
    expect(degraded.sync_ga4).toBe('CREDENTIALS_MISSING');
    const access = r.outputs.check_access as { problems: Array<{ id: string; state: string }> };
    expect(access.problems.some((p) => p.id === 'google_auth' && p.state === 'missing_credentials')).toBe(true);
    const report = r.outputs.report as ReportOutput;
    expect(report.isSynthetic).toBe(false);
    expect(report.accessIssues).toBeGreaterThan(0);
    expect(report.stageNotes.find((n) => n.stage === 'sync_gsc')).toMatchObject({ status: 'failed', code: 'CREDENTIALS_MISSING' });
    const md = readFileSync(path.join(ctx.paths.root, report.markdownFile!), 'utf8');
    // Markdown escapes underscores; the data-quality/blocker item names the stage, its status, and the next step.
    expect(md).toMatch(/baseline stage "sync\\?_gsc" failed \(CREDENTIALS\\?_MISSING\)/);
    expect(md).toMatch(/secrets\.env/);
    // No fabricated data: nothing was ingested.
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM gsc_page_daily WHERE site_id = ?', [ctx.siteId])).toBe(0);
  }, PIPELINE_TEST_TIMEOUT_MS);
});

/** SYNTHETIC OAuth client file and stored token (never valid anywhere): the offline credential check resolves them. */
function writeFakeOAuthCredentials(c: TestContext): OAuthGoogleAuthProvider {
  mkdirSync(c.paths.googleDir, { recursive: true });
  const clientFile = path.join(c.paths.googleDir, 'oauth-client.json');
  writeFileSync(clientFile, JSON.stringify({ installed: { client_id: 'synthetic-client.apps.example.invalid', client_secret: 'synthetic-secret', project_id: 'synthetic' } }), { mode: 0o600 });
  const tokenFile = path.join(c.paths.googleDir, 'token.json');
  new TokenStore(tokenFile, c.clock).write({ format: TOKEN_FORMAT, client_id: 'synthetic-client.apps.example.invalid', requested_scopes: [], tokens: { refresh_token: 'synthetic-refresh-token', access_token: 'synthetic-access-token' }, obtained_via: 'desktop_loopback_pkce', created_at: NOW, updated_at: NOW, refresh_token_expires_at: null });
  return new OAuthGoogleAuthProvider({ clientFile, tokenStore: new TokenStore(tokenFile, c.clock), fetch: c.fetch });
}

// R3-NF-G8 / D2-ACC-08: `--dry-run baseline` is the documented first-run check. With credentials that
// resolve, the Google syncs and the crawl request and write nothing: they are skipped (DRY_RUN /
// CRAWL_DRY_RUN) like the performance dry-run skip, never a bare "succeeded".
describe('baseline --dry-run with resolvable credentials (core profile)', () => {
  it('sync_gsc, sync_ga4, and crawl_site render as skipped with DRY_RUN notes, are counted in the headline and by `jobs show`, and are logged as skipped', async () => {
    // PageSpeed on, so the performance stage's own DRY_RUN skip is there to compare with.
    ctx = pipelineContext({ config: pipelineConfig({ profile: 'core', features: { pagespeed: true } } as Parameters<typeof pipelineConfig>[0]), online: true, dryRun: true });
    const provider = writeFakeOAuthCredentials(ctx);
    const env = testEnv({ googleProvider: provider, crawler: fixtureCrawlerDeps(ctx, path.join(PIPELINE_FIXTURES, 'site')) });
    const r = await runPipeline(ctx, 'baseline', {}, { env });
    expect(r.dryRun).toBe(true);
    expect(r.outcome).toBe('succeeded');
    const engineStatus = Object.fromEntries(r.workflow.stages.map((s) => [s.stage, s.status]));
    const counted = Object.fromEntries(r.degradedStages.map((d) => [d.stage, d]));
    for (const stage of ['sync_gsc', 'sync_ga4']) {
      // The engine ran the stage; its own output says nothing was requested or written.
      expect(engineStatus[stage], stage).toBe('succeeded');
      expect(counted[stage], stage).toMatchObject({ status: 'skipped', code: 'DRY_RUN', source: 'output' });
      expect(counted[stage]!.reason, stage).toMatch(/^Dry run: nothing was requested or written\. Credentials: the OAuth client file and stored token resolve \(checked locally without a network call/);
      expect(counted[stage]!.reason, stage).not.toMatch(/could not be verified/);
    }
    expect(counted.crawl_site).toMatchObject({ status: 'skipped', code: 'CRAWL_DRY_RUN', source: 'output' });

    // The stage table: "skipped  DRY_RUN: ...", never a bare "succeeded".
    const text = renderPipelineRun(r);
    expect(text).toMatch(/^ {2}sync_gsc +skipped +DRY_RUN: Dry run: nothing was requested or written\. Credentials: /m);
    expect(text).toMatch(/^ {2}sync_ga4 +skipped +DRY_RUN: Dry run: nothing was requested or written\. Credentials: /m);
    expect(text).toMatch(/^ {2}crawl_site +skipped +CRAWL_DRY_RUN: Own-site crawl not run \(dry run\)/m);
    expect(text).toMatch(/^ {2}performance +skipped +DRY_RUN: /m);
    for (const stage of ['sync_gsc', 'sync_ga4', 'crawl_site']) expect(text, stage).not.toMatch(new RegExp(`^ {2}${stage}\\s+succeeded`, 'm'));
    // The report's stage statuses carry the next step.
    const report = r.outputs.report as ReportOutput;
    expect(report.stageNotes.find((n) => n.stage === 'sync_gsc')).toMatchObject({ status: 'skipped', code: 'DRY_RUN', nextStep: 'Run without --dry-run to collect data.' });
    expect(report.stageNotes.find((n) => n.stage === 'crawl_site')).toMatchObject({ status: 'skipped', code: 'CRAWL_DRY_RUN', nextStep: expect.stringMatching(/without --dry-run/) });

    // The headline and `jobs show` count them exactly like the performance stage's DRY_RUN skip.
    expect(r.note).toMatch(new RegExp(`^degraded: ${r.degradedStages.length} stage\\(s\\) skipped, degraded, or failed: `));
    expect(pipelineHeadline(r)).toMatch(/^succeeded \(degraded: /);
    expect(pipelineHeadline(r)).toMatch(/sync_gsc \(DRY_RUN\)/);
    const byStage = new Map(r.degradedStages.map((d) => [d.stage, d]));
    for (const stage of ['sync_gsc', 'sync_ga4']) expect(checkpointDisplayStatus({ stage, status: 'succeeded' }, byStage), stage).toBe('skipped (DRY_RUN)');
    expect(checkpointDisplayStatus({ stage: 'crawl_site', status: 'succeeded' }, byStage)).toBe('skipped (CRAWL_DRY_RUN)');
    expect(counted.performance).toMatchObject({ status: 'skipped', code: 'DRY_RUN', source: 'output' });
    expect(checkpointDisplayStatus({ stage: 'performance', status: 'succeeded' }, byStage)).toBe('skipped (DRY_RUN)');

    // The engine log says so too (warn), never "Stage sync_gsc succeeded".
    const logs = ctx.logEntries.map((e) => `${e.level} ${e.msg}`);
    expect(logs).toContain('warn Stage sync_gsc skipped: DRY_RUN: Dry run: nothing was requested or written. Credentials: the OAuth client file and stored token resolve (checked locally without a network call; property access is verified by the real run).');
    expect(logs.some((l) => l.startsWith('warn Stage crawl_site skipped: CRAWL_DRY_RUN: '))).toBe(true);
    expect(logs.filter((l) => /Stage (sync_gsc|sync_ga4|crawl_site) succeeded/.test(l))).toEqual([]);

    // Nothing was requested from Google, and nothing was written to the workspace.
    expect(refusingFetch.calls.filter((u) => /googleapis\.com|oauth2/.test(u))).toEqual([]);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM gsc_page_daily WHERE site_id = ?', [ctx.siteId])).toBe(0);
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM jobs WHERE site_id = ?', [ctx.siteId])).toBe(0);
  }, PIPELINE_TEST_TIMEOUT_MS);
});
