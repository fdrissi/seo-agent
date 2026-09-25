/**
 * Demo/live separation at run time (spec 29: synthetic fixtures live in an
 * isolated demo database/vault, never mixed into live reporting). Every
 * command that builds a site context compares the site profile with the
 * workspace manifest kind BEFORE the database is opened, in both directions.
 * Everything here is SYNTHETIC and offline.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppContext } from '../../../src/app/context.js';
import { siteConfigFile, workspacePaths } from '../../../src/config/paths.js';
import { MemorySecretStore } from '../../../src/config/secrets.js';
import { initWorkspace } from '../../../src/config/workspace.js';
import { restoreDatabase } from '../../../src/database/backup.js';
import { memoryLogger } from '../../../src/core/logger.js';
import { demoFixturesDir, demoSiteConfig } from '../../../src/demo/index.js';
import { DATA_IMPORT_VERSION } from '../../../src/data/import.js';
import { emptyCounts, finishBatch, startBatch, tally, upsertRevision } from '../../../src/integrations/google/versioned.js';
import { openReadOnly, runCli, scalar, tempDir, type TempDir } from '../../e2e/helpers.js';
import { BASE_ANSWERS, runWizard, type TestWorkspace } from '../setup/helpers.js';
import { testSiteConfig } from '../../helpers/context.js';

let tmp: TempDir | undefined;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
});

const GSC_TABLES = ['gsc_properties', 'gsc_data_availability', 'gsc_property_daily', 'gsc_page_daily', 'gsc_page_query_daily'];

/** A core-profile config for a fictional business on reserved example domains. */
const CORE_YAML = `schemaVersion: 1
profile: core
site:
  id: acme-core
  businessName: Acme Core Test Co (synthetic)
  url: https://www.example.net/
  allowedHostnames: [www.example.net]
reporting:
  businessTimezone: Europe/Tallinn
google:
  searchConsoleProperty: "sc-domain:example.net"
`;

describe('a demo-profile config hand-placed in a LIVE workspace', () => {
  it('is refused by `sync gsc` and `baseline` before anything is written: zero rows in sites and every gsc table; doctor fails it', async () => {
    tmp = tempDir('demo-in-live');
    const live = path.join(tmp.root, 'live');
    const env = { HOME: path.join(tmp.root, 'home') };
    expect((await runCli(['--workspace', live, 'init', '--json'], env)).code).toBe(0);
    const paths = workspacePaths(live);
    const demoId = demoSiteConfig().site.id;
    copyFileSync(path.join(demoFixturesDir(), 'site.yaml'), siteConfigFile(paths, demoId));

    for (const args of [['sync', 'gsc'], ['baseline'], ['sync', 'gsc', '--dry-run']]) {
      const r = await runCli(['--workspace', live, ...args], env);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.err).toContain('Error [WORKSPACE_UNSAFE]');
      expect(r.err).toMatch(/uses the demo profile .* is a live workspace/);
      expect(r.err).toContain('npm run demo');
    }

    const db = openReadOnly(paths.dbFile);
    try {
      expect(scalar(db, 'SELECT COUNT(*) FROM sites')).toBe(0);
      for (const t of GSC_TABLES) expect(scalar(db, `SELECT COUNT(*) FROM ${t}`), t).toBe(0);
      expect(scalar(db, 'SELECT COUNT(*) FROM provider_requests')).toBe(0);
    } finally {
      db.close();
    }
    expect(readdirSync(paths.rawDir)).toEqual([]);

    const doctor = await runCli(['--workspace', live, 'doctor', '--json'], env);
    expect(doctor.code).toBe(1);
    const report = doctor.json<{ ok: boolean; checks: Array<{ id: string; level: string; nextStep?: string }> }>();
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'config.demo-in-live')).toMatchObject({ level: 'fail', nextStep: expect.stringContaining('npm run demo') });
  });
});

describe('a live (core) config in a DEMO workspace', () => {
  it('is refused by every command, by doctor, by `setup --from`, and by the wizard profile step', async () => {
    tmp = tempDir('live-in-demo');
    const demo = path.join(tmp.root, 'demo');
    initWorkspace(demo, { kind: 'demo' });
    const paths = workspacePaths(demo);
    const env = { HOME: path.join(tmp.root, 'home') };

    // setup --from refuses to import it (nothing written).
    const src = path.join(tmp.root, 'core.yaml');
    writeFileSync(src, CORE_YAML);
    const imported = await runCli(['--workspace', demo, 'setup', '--from', src], env);
    expect(imported.code).toBe(1);
    expect(imported.err).toContain('Error [POLICY_DENIED]');
    expect(imported.err).toContain('cannot be imported into a demo workspace');
    expect(readdirSync(paths.sitesDir)).toEqual([]);

    // The wizard refuses the core profile in a demo workspace (nothing written, the answer is not replayed).
    const ws: TestWorkspace = { tmp: tmp.root, root: demo, paths, cleanup: () => undefined };
    await expect(runWizard(ws, { ...BASE_ANSWERS, profile: 'core' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // Not even the draft that held only the site id (asked before the profile) stays behind.
    expect(readdirSync(paths.sitesDir)).toEqual([]);

    // Hand-placed anyway: commands refuse to build a context for it; doctor fails it.
    writeFileSync(siteConfigFile(paths, 'acme-core'), CORE_YAML);
    const sync = await runCli(['--workspace', demo, 'sync', 'gsc'], env);
    expect(sync.code).toBe(1);
    expect(sync.err).toContain('Error [WORKSPACE_UNSAFE]');
    expect(sync.err).toMatch(/is a demo workspace, but site "acme-core" uses the core profile/);
    expect(existsSync(paths.dbFile)).toBe(false);
    const doctor = await runCli(['--workspace', demo, 'doctor', '--json'], env);
    const report = doctor.json<{ ok: boolean; checks: Array<{ id: string; level: string }> }>();
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'config.live-in-demo')).toMatchObject({ level: 'fail' });
    expect(readFileSync(siteConfigFile(paths, 'acme-core'), 'utf8')).toBe(CORE_YAML);
  });
});

describe('createAppContext (library level)', () => {
  it('refuses the mismatch before opening the database, and accepts matching kinds', () => {
    tmp = tempDir('ctx-kind');
    const live = path.join(tmp.root, 'live');
    const demo = path.join(tmp.root, 'demo');
    initWorkspace(live);
    initWorkspace(demo, { kind: 'demo' });
    const base = { secrets: new MemorySecretStore({}), logger: memoryLogger(), offline: true };
    const demoCfg = testSiteConfig({ profile: 'demo', site: { id: 'demo-site' } });
    const coreCfg = testSiteConfig();
    expect(() => createAppContext({ ...base, workspaceRoot: live, siteId: 'demo-site', config: demoCfg })).toThrow(expect.objectContaining({ code: 'WORKSPACE_UNSAFE' }));
    expect(() => createAppContext({ ...base, workspaceRoot: demo, siteId: coreCfg.site.id, config: coreCfg })).toThrow(expect.objectContaining({ code: 'WORKSPACE_UNSAFE' }));
    expect(existsSync(workspacePaths(live).dbFile)).toBe(false);
    expect(existsSync(workspacePaths(demo).dbFile)).toBe(false);
    const ok1 = createAppContext({ ...base, workspaceRoot: live, siteId: coreCfg.site.id, config: coreCfg });
    const ok2 = createAppContext({ ...base, workspaceRoot: demo, siteId: 'demo-site', config: demoCfg });
    expect(ok1.synthetic).toBe(false);
    expect(ok2.synthetic).toBe(true);
    ok1.db.close();
    ok2.db.close();
  });
});

describe('restore and doctor keep demo and live DATABASES apart (C2-02)', () => {
  /** A demo workspace whose database holds the demo site (is_demo = 1), and a backup of it. SYNTHETIC. */
  async function demoBackupDir(root: string, env: NodeJS.ProcessEnv): Promise<{ dir: string; demoId: string }> {
    const demo = path.join(root, 'demo');
    initWorkspace(demo, { kind: 'demo' });
    const paths = workspacePaths(demo);
    const demoId = demoSiteConfig().site.id;
    copyFileSync(path.join(demoFixturesDir(), 'site.yaml'), siteConfigFile(paths, demoId));
    const costs = await runCli(['--workspace', demo, 'costs'], env); // registers the demo site
    expect(costs.code, costs.err).toBe(0);
    const b = await runCli(['--workspace', demo, 'backup', '--json'], env);
    expect(b.code, b.err).toBe(0);
    expect(b.json<{ sites: unknown }>().sites).toEqual([{ id: demoId, isDemo: true }]);
    return { dir: b.json<{ dir: string }>().dir, demoId };
  }

  /** A live workspace with one registered core-profile site. */
  async function liveWorkspace(root: string, env: NodeJS.ProcessEnv): Promise<string> {
    const live = path.join(root, 'live');
    expect((await runCli(['--workspace', live, 'init', '--json'], env)).code).toBe(0);
    writeFileSync(siteConfigFile(workspacePaths(live), 'acme-core'), CORE_YAML);
    const costs = await runCli(['--workspace', live, 'costs'], env);
    expect(costs.code, costs.err).toBe(0);
    return live;
  }

  const siteRows = (dbFile: string) => {
    const db = openReadOnly(dbFile);
    try {
      return db.prepare('SELECT id, is_demo FROM sites ORDER BY id').all() as Array<{ id: string; is_demo: number }>;
    } finally {
      db.close();
    }
  };

  it('`restore` refuses a demo backup in a live workspace (preview and --confirm); nothing is replaced', async () => {
    tmp = tempDir('restore-demo-into-live');
    const env = { HOME: path.join(tmp.root, 'home') };
    const { dir, demoId } = await demoBackupDir(tmp.root, env);
    const live = await liveWorkspace(tmp.root, env);
    const paths = workspacePaths(live);

    for (const extra of [[], ['--dry-run'], ['--confirm'], ['--confirm', '--force']]) {
      const r = await runCli(['--workspace', live, 'restore', '--from', dir, ...extra], env);
      expect(r.code, extra.join(' ')).toBe(1);
      expect(r.err).toContain('Error [WORKSPACE_UNSAFE]');
      expect(r.err).toContain(`holds demo site(s) ${demoId} (synthetic data)`);
      expect(r.err).toContain('is a live workspace');
    }
    const json = await runCli(['--workspace', live, '--json', 'restore', '--from', dir, '--confirm'], env);
    expect(json.json()).toMatchObject({ ok: false, error: { code: 'WORKSPACE_UNSAFE', details: { workspaceKind: 'live', mismatchedSites: [{ id: demoId, isDemo: true }] } } });
    // The live database is untouched: still only the live site, and no restore copies or pre-restore backup were written.
    expect(siteRows(paths.dbFile)).toEqual([{ id: 'acme-core', is_demo: 0 }]);
    expect(readdirSync(paths.backupsDir).filter((f) => f.startsWith('pre-restore-'))).toEqual([]);
    expect(readdirSync(live).filter((f) => f.startsWith('restored-'))).toEqual([]);
  });

  it('`restore` refuses a live backup in a demo workspace', async () => {
    tmp = tempDir('restore-live-into-demo');
    const env = { HOME: path.join(tmp.root, 'home') };
    const live = await liveWorkspace(tmp.root, env);
    const b = await runCli(['--workspace', live, 'backup', '--json'], env);
    const demo = path.join(tmp.root, 'demo2');
    initWorkspace(demo, { kind: 'demo' });
    const r = await runCli(['--workspace', demo, 'restore', '--from', b.json<{ dir: string }>().dir, '--confirm'], env);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Error [WORKSPACE_UNSAFE]');
    expect(r.err).toContain('holds live (non-demo) site(s) acme-core');
    expect(existsSync(workspacePaths(demo).dbFile) ? siteRows(workspacePaths(demo).dbFile) : []).toEqual([]);
  });

  it('doctor fails a live workspace whose database already holds a demo site (e.g. restored by an older version), and passes a matching one', async () => {
    tmp = tempDir('doctor-demo-db-in-live');
    const env = { HOME: path.join(tmp.root, 'home') };
    const { dir, demoId } = await demoBackupDir(tmp.root, env);
    const live = await liveWorkspace(tmp.root, env);
    const paths = workspacePaths(live);

    const before = (await runCli(['--workspace', live, 'doctor', '--json'], env)).json<{ checks: Array<{ id: string; level: string; detail: string }> }>();
    expect(before.checks.find((c) => c.id === 'database.demo-live')).toMatchObject({ level: 'ok' });

    // What an unchecked restore used to do (the library without workspaceKind still allows it).
    restoreDatabase({ backupFile: path.join(dir, 'seo-agent.sqlite'), dbFile: paths.dbFile, backupsDir: paths.backupsDir });
    expect(siteRows(paths.dbFile)).toEqual([{ id: demoId, is_demo: 1 }]);
    const doctor = await runCli(['--workspace', live, 'doctor', '--json'], env);
    expect(doctor.code).toBe(1);
    const report = doctor.json<{ ok: boolean; checks: Array<{ id: string; level: string; detail: string; nextStep?: string }> }>();
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'database.demo-live')).toMatchObject({
      level: 'fail',
      detail: expect.stringContaining(`demo site(s) ${demoId} (sites.is_demo = 1: synthetic data) although this is a live workspace`),
      nextStep: expect.stringContaining('restore --from <backup dir> --confirm'),
    });
    const human = await runCli(['--workspace', live, 'doctor'], env);
    expect(human.out).toContain('[FAIL] Demo data in a live workspace');
  });

  it('doctor fails a live workspace whose current Search Console rows are labeled synthetic (an older synthetic `data import`); `data import` refuses more, and the real file supersedes them (D1-R01)', async () => {
    tmp = tempDir('doctor-synthetic-rows-in-live');
    const env = { HOME: path.join(tmp.root, 'home') };
    const live = await liveWorkspace(tmp.root, env);
    const paths = workspacePaths(live);
    const demoLive = async () => (await runCli(['--workspace', live, 'doctor', '--json'], env)).json<{ ok: boolean; checks: Array<{ id: string; level: string; title: string; detail: string; nextStep?: string }> }>().checks.find((c) => c.id === 'database.demo-live');
    expect(await demoLive()).toMatchObject({ level: 'ok', detail: expect.stringContaining('no current Search Console/GA4 row labeled synthetic') });

    // What an older version's synthetic import into this live workspace left behind (SYNTHETIC rows, reserved example.net domain).
    const ctx = createAppContext({ workspaceRoot: live, siteId: 'acme-core', secrets: new MemorySecretStore({}), logger: memoryLogger(), offline: true });
    let batchId = '';
    try {
      batchId = startBatch(ctx, { source: 'import', dataset: 'gsc_page_daily', property: 'sc-domain:example.net', dateStart: '2025-06-01', dateEnd: '2025-06-02', request: { type: 'web', importedDataset: 'gsc-pages' }, transformationVersion: DATA_IMPORT_VERSION, synthetic: true });
      const counts = emptyCounts();
      ctx.db.transaction(() => {
        for (const date of ['2025-06-01', '2025-06-02']) {
          const key = { property: 'sc-domain:example.net', search_type: 'web', date, page: 'https://www.example.net/pricing', segment_key: '' };
          const values = { date_tz: 'America/Los_Angeles', country: null, device: null, search_appearance: null, clicks: 99, impressions: 999, ctr: null, position: null, aggregation_type: 'byPage', is_final: 1 };
          tally(counts, upsertRevision(ctx.db, 'gsc_page_daily', ctx.siteId, key, values, { batchId, collectedAt: '2025-06-03T06:00:00.000Z', transformationVersion: DATA_IMPORT_VERSION, isSynthetic: true }));
        }
      });
      finishBatch(ctx, batchId, { status: 'succeeded', counts, apiPages: 0, truncated: true });
    } finally {
      ctx.db.close();
    }

    const doctor = await runCli(['--workspace', live, 'doctor', '--json'], env);
    expect(doctor.code).toBe(1);
    expect(doctor.json<{ ok: boolean }>().ok).toBe(false);
    const failed = await demoLive();
    expect(failed).toMatchObject({ level: 'fail', title: 'Synthetic data in a live workspace' });
    expect(failed!.detail).toContain("2 current Search Console/GA4 row(s) in this live workspace's database are labeled synthetic (is_synthetic = 1): gsc_page_daily 2 (site acme-core)");
    expect(failed!.detail).toContain(`${batchId} (import)`);
    expect(failed!.nextStep).toContain('restore --from <backup dir> --confirm');
    expect(failed!.nextStep).toContain(path.join(paths.backupsDir, 'pre-restore-<time>.sqlite'));
    expect(failed!.nextStep).toMatch(/re-import the owner's real file\(s\) with `data import` \(without --synthetic\)/);
    expect((await runCli(['--workspace', live, 'doctor'], env)).out).toContain('[FAIL] Synthetic data in a live workspace');

    // `data import` now refuses a synthetic file here; nothing changes.
    const synthetic = path.join(tmp.root, 'synthetic.csv');
    writeFileSync(synthetic, ['# SYNTHETIC fixture: invented numbers', 'Date,Page,Clicks,Impressions', '2025-06-01,https://www.example.net/pricing,1,10'].join('\n'));
    const refused = await runCli(['--workspace', live, 'data', 'import', 'gsc-pages', synthetic], env);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('Error [WORKSPACE_UNSAFE]');
    expect((await demoLive())!.level).toBe('fail');

    // The owner's real file supersedes the synthetic revisions of the same keys; doctor passes again.
    const real = path.join(tmp.root, 'real.csv');
    writeFileSync(real, ['Date,Page,Clicks,Impressions', '2025-06-01,https://www.example.net/pricing,6,100', '2025-06-02,https://www.example.net/pricing,4,90'].join('\n'));
    const imported = await runCli(['--workspace', live, 'data', 'import', 'gsc-pages', real, '--complete'], env);
    expect(imported.code, imported.err).toBe(0);
    expect(await demoLive()).toMatchObject({ level: 'ok' });
    const db = openReadOnly(paths.dbFile);
    try {
      expect(scalar(db, 'SELECT COUNT(*) FROM gsc_page_daily WHERE is_current = 1 AND is_synthetic = 1')).toBe(0);
      expect(scalar(db, 'SELECT COUNT(*) FROM gsc_page_daily WHERE is_current = 0 AND is_synthetic = 1')).toBe(2);
    } finally {
      db.close();
    }
  });
});

