/**
 * Demo isolation in BOTH directions (spec 29; audit A1-01 / A8-02):
 *   - a demo workspace never accepts a live (core/full) config, and
 *   - refreshing a demo never deletes data the demo did not create: it aborts
 *     with WORKSPACE_UNSAFE, listing the offending paths, BEFORE removing
 *     anything (user-added site configs, non-demo sites in the database,
 *     values in secrets.env, Google credential files).
 * - cost rows of a demo site are flagged synthetic (budget_reservations and
 *   cost_ledger are part of the isolation check) and `costs` in a demo
 *   workspace prints "SYNTHETIC DEMO DATA: no real charges" (B1-03).
 * Everything is SYNTHETIC and offline (reserved example domains only).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultFixtureSiteDir } from '../../src/app/services.js';
import { siteConfigFile, workspacePaths } from '../../src/config/paths.js';
import { parseSiteConfig } from '../../src/config/site-schema.js';
import { openDatabase } from '../../src/database/db.js';
import { migrate } from '../../src/database/migrate.js';
import { ensureSite } from '../../src/database/sites.js';
import { BudgetService } from '../../src/budgets/budget-service.js';
import { ProviderRequestLog } from '../../src/budgets/provider-requests.js';
import { demoRefreshBlockers, demoSiteConfig, isDemoWorkspace, prepareDemoWorkspace } from '../../src/demo/index.js';
import { DEMO_START, runCli, snapshotFiles, tempDir, type TempDir } from './helpers.js';

let tmp: TempDir | undefined;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
});

const CORE_YAML = `schemaVersion: 1
profile: core
site:
  id: my-real-site
  businessName: My Real Site Test Co (synthetic)
  url: https://www.example.org/
  allowedHostnames: [www.example.org]
reporting:
  businessTimezone: Europe/Tallinn
`;

function freshDemo(t: TempDir): string {
  const dir = path.join(t.root, 'demo');
  prepareDemoWorkspace({ dir, now: new Date(DEMO_START), fixtureSiteDir: defaultFixtureSiteDir(), env: { HOME: path.join(t.root, 'home') } });
  expect(isDemoWorkspace(dir)).toBe(true);
  return dir;
}

async function expectRefreshRefused(dir: string, env: NodeJS.ProcessEnv, offending: RegExp): Promise<void> {
  // SQLite may leave its -wal/-shm sidecar files after the read-only check; they hold no new data.
  const data = (rel: string) => !/\.sqlite-(wal|shm)$/.test(rel);
  const before = snapshotFiles(dir, data);
  for (const extra of [['--dry-run'], []]) {
    const r = await runCli(['demo', '--dir', dir, '--start-at', DEMO_START, ...extra], env);
    expect(r.code, `demo ${extra.join(' ')}`).toBe(1);
    expect(r.err).toContain('Error [WORKSPACE_UNSAFE]');
    expect(r.err).toContain('refreshing the demo would delete it, so nothing was changed');
    expect(r.err).toMatch(offending);
  }
  // Nothing was removed or changed.
  const after = snapshotFiles(dir, data);
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [k, v] of before) expect(after.get(k)?.equals(v), k).toBe(true);
}

describe('demo workspace isolation', () => {
  it('refuses to import or set up a live config in a demo workspace', async () => {
    tmp = tempDir('demo-iso-import');
    const dir = freshDemo(tmp);
    const env = { HOME: path.join(tmp.root, 'home') };
    const src = path.join(tmp.root, 'real.yaml');
    writeFileSync(src, CORE_YAML);
    const r = await runCli(['--workspace', dir, 'setup', '--from', src], env);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Error [POLICY_DENIED]');
    expect(r.err).toContain('cannot be imported into a demo workspace');
    expect(existsSync(siteConfigFile(workspacePaths(dir), 'my-real-site'))).toBe(false);
    expect(demoRefreshBlockers(dir)).toEqual([]);
  });

  it('a refresh over a user-added config aborts before deleting anything and lists the file', async () => {
    tmp = tempDir('demo-iso-config');
    const dir = freshDemo(tmp);
    const env = { HOME: path.join(tmp.root, 'home') };
    const added = siteConfigFile(workspacePaths(dir), 'my-real-site');
    writeFileSync(added, CORE_YAML, { mode: 0o600 });
    await expectRefreshRefused(dir, env, new RegExp(`${added.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(not the demo site configuration\\)`));
    expect(readFileSync(added, 'utf8')).toBe(CORE_YAML);
    // A demo site file whose profile was changed by hand is not "demo data" either.
    rmSync(added);
    const demoFile = siteConfigFile(workspacePaths(dir), demoSiteConfig().site.id);
    writeFileSync(demoFile, readFileSync(demoFile, 'utf8').replace('profile: demo', 'profile: core'));
    expect(demoRefreshBlockers(dir)).toEqual([`${demoFile} (no longer a demo-profile configuration)`]);
  });

  it('a refresh aborts when secrets.env holds values or Google credential files exist (values are never printed)', async () => {
    tmp = tempDir('demo-iso-secrets');
    const dir = freshDemo(tmp);
    const env = { HOME: path.join(tmp.root, 'home') };
    const paths = workspacePaths(dir);
    const secret = 'synthetic-demo-iso-secret-5c1d9e';
    writeFileSync(paths.secretsEnvFile, `${readFileSync(paths.secretsEnvFile, 'utf8')}APIFY_TOKEN=${secret}\n`);
    chmodSync(paths.secretsEnvFile, 0o600);
    await expectRefreshRefused(dir, env, /secrets\.env \(holds values for APIFY_TOKEN\)/);
    const r = await runCli(['demo', '--dir', dir, '--start-at', DEMO_START, '--json'], env);
    expect(r.out + r.err).not.toContain(secret);
    // Commented-out template lines are fine; a Google credential file is not.
    writeFileSync(paths.secretsEnvFile, '# APIFY_TOKEN=\n', { mode: 0o600 });
    mkdirSync(paths.googleDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(paths.googleDir, 'token.json'), '{"synthetic": true}\n', { mode: 0o600 });
    await expectRefreshRefused(dir, env, /token\.json \(Google credential file\)/);
  });

  it('a refresh aborts when the database holds a non-demo site; once the demo only holds demo data it refreshes', async () => {
    tmp = tempDir('demo-iso-db');
    const dir = freshDemo(tmp);
    const env = { HOME: path.join(tmp.root, 'home') };
    const paths = workspacePaths(dir);
    const db = openDatabase(paths.dbFile);
    try {
      migrate(db);
      ensureSite(db, demoSiteConfig(), { source: 'demo', now: new Date(DEMO_START) });
      ensureSite(db, parseSiteConfig({ profile: 'core', site: { id: 'my-real-site', businessName: 'Real (synthetic)', url: 'https://www.example.org/', allowedHostnames: ['www.example.org'] } }), { source: 'file', now: new Date(DEMO_START) });
    } finally {
      db.close();
    }
    await expectRefreshRefused(dir, env, /site "my-real-site" is not a demo site/);

    // Only demo data left: the dry run plans a refresh and the refresh itself works.
    rmSync(paths.dbFile);
    expect(demoRefreshBlockers(dir)).toEqual([]);
    const dry = await runCli(['demo', '--dir', dir, '--dry-run', '--json'], env);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.json()).toMatchObject({ dryRun: true, action: 'refresh the previous demo' });
    const again = prepareDemoWorkspace({ dir, now: new Date(DEMO_START), fixtureSiteDir: defaultFixtureSiteDir(), env });
    expect(again.refreshed).toBe(true);
  });

  it('cost rows of the demo site are flagged synthetic and `costs` in the demo workspace is labeled (text and JSON)', async () => {
    tmp = tempDir('demo-iso-costs');
    const dir = freshDemo(tmp);
    const env = { HOME: path.join(tmp.root, 'home') };
    const paths = workspacePaths(dir);
    const cfg = demoSiteConfig();
    const db = openDatabase(paths.dbFile);
    try {
      migrate(db);
      ensureSite(db, cfg, { source: 'demo', now: new Date() });
      // The system clock, so the amounts land in the month `costs` shows.
      const budgets = new BudgetService(db, {
        limits: { llmGateway: { monthly: 5_000_000, perRun: 500_000 }, dataforseo: { weekly: 1_000_000, monthly: 10_000_000, perRun: 500_000 }, apify: { monthly: 10_000_000, perRun: 1_000_000 }, pagespeed: { monthly: 0, perRun: 0 }, combinedMonthly: 25_000_000, accountMonthly: {} },
        siteId: cfg.site.id,
        timeZone: cfg.reporting.businessTimezone ?? cfg.scheduler.timezone,
      });
      const requests = new ProviderRequestLog(db);
      const r = budgets.reserve({ siteId: cfg.site.id, provider: 'dataforseo', runId: 'demo-iso', purpose: 'SYNTHETIC demo fixture task', estimate: { upperBoundMicros: 2_000, basis: { source: 'documented', detail: 'SYNTHETIC fixture price' } } });
      // Even a provider request that was not flagged synthetic cannot make a demo site's cost row "real".
      const preq = requests.prepare({ siteId: cfg.site.id, provider: 'dataforseo', endpoint: 'synthetic/priced_fixture_task', method: 'POST', isPaid: true, params: { synthetic: true }, reservationId: r.id });
      budgets.attachRequest(r.id, preq.id);
      budgets.reconcile(r.id, { actualMicros: 1_500, source: 'computed_from_usage', providerRequestId: preq.id });
      expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM budget_reservations WHERE site_id = ? AND is_synthetic = 0', [cfg.site.id])!.n).toBe(0);
      expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_ledger WHERE site_id = ? AND is_synthetic = 0', [cfg.site.id])!.n).toBe(0);
      expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_ledger WHERE site_id = ? AND is_synthetic = 1', [cfg.site.id])!.n).toBe(1);
    } finally {
      db.close();
    }
    const text = await runCli(['--workspace', dir, 'costs'], env);
    expect(text.code, text.err).toBe(0);
    expect(text.out.split('\n')[0]).toMatch(/^SYNTHETIC DEMO DATA: no real charges/);
    expect(text.out).toMatch(/^dataforseo\s+\$0\.00\s+\$0\.0015\s.*\[SYNTHETIC\]$/m);
    expect(text.out).toContain('computed from usage at list price, not provider-reported');
    const json = await runCli(['--workspace', dir, '--json', 'costs'], env);
    expect(json.code, json.err).toBe(0);
    expect(json.json()).toMatchObject({ synthetic: true, containsSynthetic: true, siteId: cfg.site.id });
    expect(json.json().costBasis.find((b: { provider: string }) => b.provider === 'dataforseo')).toMatchObject({ reportedMicros: 0, computedMicros: 1_500, syntheticMicros: 1_500 });
  });
});
