/**
 * NEW-USER ACCEPTANCE TEST (preamble "Personal use and upgrades"): "a new
 * user can run the demo, configure their own workspace, enable selected
 * integrations, and upgrade the application without exposing or
 * overwriting private data."
 *
 * Everything goes through the real CLI in-process with an isolated HOME and
 * no credentials; the global fetch throws (tests/setup.ts). The upgrade is
 * simulated with a temporary COPY of the migrations directory plus extra
 * migrations, selected with the test-only SEO_AGENT_MIGRATIONS_DIR (honored
 * only under the test runner), and applied through the CLI: `db migrate`
 * (verified pre-migration backup), then a normal command (automatic
 * migration), then docs/UPGRADING.md recovery procedure A for a failing
 * migration. The repository's migrations are never touched.
 */
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appDirs, siteConfigFile, siteVaultDir, workspacePaths } from '../../src/config/paths.js';
import { readManifest } from '../../src/config/workspace.js';
import { loadMigrations } from '../../src/database/migrate.js';
import { verifyDatabaseFile } from '../../src/database/backup.js';
import { demoFixturesDir } from '../../src/demo/index.js';
import { DEMO_START, openReadOnly, runCli, scalar, snapshotFiles, tempDir, type TempDir } from './helpers.js';

let tmp: TempDir | undefined;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
});

/** Synthetic secret: never a real credential; it must never appear outside the secrets file. */
const SYNTHETIC_SECRET = 'sk-synthetic-e2e-never-real-7f3a9c1b5d2e';
const SITE_ID = 'acme-live';

function siteYaml(features: string): string {
  // A core-profile config for a fictional business on reserved example domains (verbatim text is preserved on import).
  return `# Private site configuration (SYNTHETIC test business; reserved example domains)
schemaVersion: 1
profile: core
site:
  id: ${SITE_ID}
  businessName: Acme Live Test Co (synthetic)
  url: https://www.example.net/
  allowedHostnames: [www.example.net]
business:
  offer: Synthetic offer for the new-user acceptance test.
market:
  languages: [en]
  devices: [desktop, mobile]
reporting:
  currency: EUR
  businessTimezone: Europe/Tallinn
google:
  searchConsoleProperty: "sc-domain:example.net"
  ga4PropertyId: "987654321"
conversions:
  primaryEvents:
    - { name: generate_lead, meaning: Contact form submitted (synthetic), kind: lead }
research:
  dataforseo: { mode: sandbox }
features:${features}
`;
}

function allFilesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  for (const [rel, buf] of snapshotFiles(dir)) if (buf.includes(needle)) hits.push(rel);
  return hits;
}

describe('new-user acceptance', () => {
  it('runs the demo, configures a separate live workspace from YAML, enables integrations, and upgrades without exposing or overwriting private data', { timeout: 180_000 }, async () => {
    tmp = tempDir('new-user');
    const home = path.join(tmp.root, 'home');
    mkdirSync(home);
    const env = { HOME: home };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    // 1. Run the demo (isolated, synthetic, offline).
    const demoDir = path.join(tmp.root, 'demo');
    const demo = await runCli(['demo', '--dir', demoDir, '--start-at', DEMO_START, '--json'], env);
    expect(demo.code, demo.err).toBe(0);
    expect(demo.json()).toMatchObject({ ok: true, synthetic: true, network: { externalRequests: 0 } });
    expect(readManifest(workspacePaths(demoDir))?.kind).toBe('demo');

    // 2. Initialize a separate live workspace.
    const live = path.join(tmp.root, 'live-workspace');
    const paths = workspacePaths(live);
    const init = await runCli(['--workspace', live, 'init', '--json'], env);
    expect(init.code, init.err).toBe(0);
    expect(readManifest(paths)?.kind).toBe('live');
    expect(existsSync(paths.dbFile)).toBe(true);

    // The demo's synthetic config can never be imported into the live workspace.
    const demoImport = await runCli(['--workspace', live, 'setup', '--from', path.join(demoFixturesDir(), 'site.yaml')], env);
    expect(demoImport.code).toBe(1);
    expect(demoImport.err).toMatch(/npm run demo/);

    // 3. Configure it from a YAML file (non-interactive setup).
    const source = path.join(tmp.root, 'my-site.yaml');
    writeFileSync(source, siteYaml(' {}'));
    const setup = await runCli(['--workspace', live, 'setup', '--from', source, '--json'], env);
    expect(setup.code, setup.err + setup.out).toBe(0);
    expect(setup.json()).toMatchObject({ status: 'created', siteId: SITE_ID, profile: 'core' });
    const configFile = siteConfigFile(paths, SITE_ID);
    expect(readFileSync(configFile, 'utf8')).toBe(siteYaml(' {}'));

    // 4. Enable selected integrations via config (reviewed diff, backup of the previous version).
    const enabled = siteYaml('\n  pagespeed: true\n  dataforseo: true\n  urlInspection: true');
    writeFileSync(source, enabled);
    const update = await runCli(['--workspace', live, 'setup', '--from', source, '--update', '--json'], env);
    expect(update.code, update.err + update.out).toBe(0);
    expect(update.json()).toMatchObject({ status: 'updated' });
    expect(readFileSync(configFile, 'utf8')).toBe(enabled);
    expect(readdirSync(path.join(paths.backupsDir, 'config')).length).toBe(1);
    const validate = await runCli(['--workspace', live, '--site', SITE_ID, 'config', 'validate', '--json'], env);
    expect(validate.code, validate.err + validate.out).toBe(0);

    // The enabled integrations report honest statuses (no credentials yet), with no network and no spend.
    const doctor = await runCli(['--workspace', live, '--site', SITE_ID, 'doctor', '--json'], env);
    const report = doctor.json<{ ok: boolean }>();
    expect(JSON.stringify(report)).toMatch(/dataforseo/);
    expect(JSON.stringify(report)).toMatch(/missing_credentials|DATAFORSEO_LOGIN/);
    expect(fetchSpy).not.toHaveBeenCalled();

    // 5. Private data: a secret in the protected secrets file, the vault, and human edits in designated notes.
    appendFileSync(paths.secretsEnvFile, `LLM_GATEWAY_API_KEY=${SYNTHETIC_SECRET}\n`);
    chmodSync(paths.secretsEnvFile, 0o600);
    const vaultInit = await runCli(['--workspace', live, '--site', SITE_ID, 'vault', 'init'], env);
    expect(vaultInit.code, vaultInit.err).toBe(0);
    const vaultDir = siteVaultDir(paths, SITE_ID);
    const profileNote = path.join(vaultDir, '01 Business', 'Business Profile.md');
    appendFileSync(profileNote, '\n<!-- human edit -->\nOwner note: our support team answers within one business day (synthetic human edit).\n');
    const humanNote = path.join(vaultDir, '12 Decisions', 'Owner decision - keep pricing page.md');
    writeFileSync(humanNote, '# Owner decision (human-written, synthetic)\n\nKeep the pricing page structure until the next review.\n');
    // A generated render runs next to the human notes and must not touch them.
    const render = await runCli(['--workspace', live, '--site', SITE_ID, 'vault', 'render', '--json'], env);
    expect(render.code, render.err + render.out).toBe(0);

    const snapshot = () => ({
      config: snapshotFiles(paths.configDir),
      secrets: snapshotFiles(paths.secretsDir),
      humanNotes: new Map([profileNote, humanNote].map((f) => [f, readFileSync(f)])),
      vault: snapshotFiles(vaultDir),
    });
    // Re-running the installation steps (as a reinstall/upgrade would) never overwrites anything.
    expect((await runCli(['--workspace', live, 'init', '--json'], env)).json<{ created: string[] }>().created).toEqual([]);
    const reinitVault = await runCli(['--workspace', live, '--site', SITE_ID, 'vault', 'init', '--json'], env);
    expect(reinitVault.code, reinitVault.err).toBe(0);
    const reimport = await runCli(['--workspace', live, 'setup', '--from', source], env);
    expect(reimport.code).toBe(1); // an existing config is never replaced without --update
    expect(reimport.err).toMatch(/--update|CONFLICT|exists/);
    writeFileSync(source, siteYaml(' {}'));
    const conflicting = await runCli(['--workspace', live, 'setup', '--from', source], env);
    expect(conflicting.code).toBe(1);
    expect(conflicting.err).toMatch(/CONFLICT/);

    const before = snapshot();
    const db0 = openReadOnly(paths.dbFile);
    const appliedBefore = scalar(db0, 'SELECT COUNT(*) FROM schema_migrations');
    db0.close();
    expect(appliedBefore).toBe(loadMigrations().length);

    // 6. Application upgrade THROUGH THE CLI. A newer build is simulated with a temporary copy of the
    //    migrations directory plus extra migrations; the test-only SEO_AGENT_MIGRATIONS_DIR (honored only
    //    under the test runner) points the in-process application at it. The repository is never touched.
    const vNext = path.join(tmp.root, 'app-vNext-migrations');
    mkdirSync(vNext);
    for (const f of readdirSync(appDirs.migrations())) copyFileSync(path.join(appDirs.migrations(), f), path.join(vNext, f));
    writeFileSync(
      path.join(vNext, '9990_upgrade_simulation.sql'),
      '-- Temporary migration added by tests/e2e/new-user.test.ts to simulate an application upgrade.\nCREATE TABLE upgrade_simulation_probe (id INTEGER PRIMARY KEY, note TEXT NOT NULL);\n',
    );
    const savedMigrationsDir = process.env.SEO_AGENT_MIGRATIONS_DIR;
    const useMigrations = (dir: string | null) => {
      if (dir) process.env.SEO_AGENT_MIGRATIONS_DIR = dir;
      else delete process.env.SEO_AGENT_MIGRATIONS_DIR;
    };
    try {
      useMigrations(vNext);
      const status = await runCli(['--workspace', live, 'db', 'status', '--json'], env);
      expect(status.json<{ pending: string[] }>().pending).toEqual(['9990_upgrade_simulation']);

      // 6a. Explicit `db migrate`: a verified, private pre-migration backup holding the pre-upgrade schema.
      const backupsBefore = new Set(readdirSync(paths.backupsDir));
      const upgrade = await runCli(['--workspace', live, 'db', 'migrate', '--json'], env);
      expect(upgrade.code, upgrade.err).toBe(0);
      const result = upgrade.json<{ applied: string[]; backupFile: string | null }>();
      expect(result.applied).toEqual(['9990_upgrade_simulation']);
      expect(result.backupFile).toBeTruthy();
      expect(backupsBefore.has(path.basename(result.backupFile!))).toBe(false);
      expect(verifyDatabaseFile(result.backupFile!).migrations).toBe(appliedBefore);
      if (process.platform !== 'win32') expect(statSync(result.backupFile!).mode & 0o777).toBe(0o600);
      const bk = openReadOnly(result.backupFile!);
      try {
        expect(scalar(bk, "SELECT COUNT(*) FROM sqlite_master WHERE name = 'upgrade_simulation_probe'")).toBe(0);
        expect(scalar(bk, 'SELECT COUNT(*) FROM sites WHERE id = ?', SITE_ID)).toBe(1);
      } finally {
        bk.close();
      }

      // 6b. The next release adds another migration: a normal command applies it automatically, with a backup.
      writeFileSync(path.join(vNext, '9991_auto_migrate_probe.sql'), '-- Temporary migration (tests/e2e/new-user.test.ts): applied automatically by a normal command.\nCREATE TABLE auto_migrate_probe (id INTEGER PRIMARY KEY);\n');
      const normal = await runCli(['--workspace', live, '--site', SITE_ID, 'setup', 'vault', '--json'], env);
      expect(normal.code, normal.err).toBe(0);
      expect(normal.err).toMatch(/Database migrated \(9991_auto_migrate_probe\)\. Pre-migration backup: .*pre-migration-.*\.sqlite/);
      const afterAuto = openReadOnly(paths.dbFile);
      try {
        expect(scalar(afterAuto, "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('upgrade_simulation_probe', 'auto_migrate_probe')")).toBe(2);
        expect(scalar(afterAuto, 'SELECT COUNT(*) FROM schema_migrations')).toBe(appliedBefore + 2);
      } finally {
        afterAuto.close();
      }

      // 6c. docs/UPGRADING.md recovery procedure A: a migration fails during an upgrade.
      const vBroken = path.join(tmp.root, 'app-vBroken-migrations');
      mkdirSync(vBroken);
      for (const f of readdirSync(vNext)) copyFileSync(path.join(vNext, f), path.join(vBroken, f));
      writeFileSync(path.join(vBroken, '9992_broken_upgrade.sql'), '-- Deliberately failing migration (tests/e2e/new-user.test.ts).\nCREATE TABLE broken_probe (id INTEGER PRIMARY KEY);\nINSERT INTO table_that_does_not_exist VALUES (1);\n');
      useMigrations(vBroken);
      const failed = await runCli(['--workspace', live, 'db', 'migrate'], env);
      expect(failed.code).toBe(1);
      expect(failed.err).toContain('Error [MIGRATION_FAILED]: Migration 9992_broken_upgrade.sql failed');
      const premigration = /pre-migration backup was written to (\S+?\.sqlite)/.exec(failed.err)?.[1];
      expect(premigration, failed.err).toBeTruthy();
      //   Step 3: place the pre-migration backup in a directory and restore it (verify first, then --confirm).
      const restoreDir = path.join(paths.backupsDir, 'restore-premigration');
      mkdirSync(restoreDir, { recursive: true });
      copyFileSync(premigration!, path.join(restoreDir, 'seo-agent.sqlite'));
      const verifyOnly = await runCli(['--workspace', live, 'restore', '--from', restoreDir], env);
      expect(verifyOnly.code, verifyOnly.err).toBe(0);
      expect(verifyOnly.out).toContain('Backup verified');
      const restored = await runCli(['--workspace', live, 'restore', '--from', restoreDir, '--confirm', '--json'], env);
      expect(restored.code, restored.err).toBe(0);
      const restoredJson = restored.json<{ preRestoreBackup: string | null }>();
      expect(restoredJson.preRestoreBackup && existsSync(restoredJson.preRestoreBackup)).toBeTruthy();
      //   Step 4: back on the previous release, `db status` shows no unknown (and no pending) migrations.
      useMigrations(vNext);
      const prev = await runCli(['--workspace', live, 'db', 'status', '--json'], env);
      expect(prev.code, prev.err).toBe(0);
      expect(prev.json()).toMatchObject({ database: 'present', pending: [], unknown: [] });
      const recovered = openReadOnly(paths.dbFile);
      try {
        expect(scalar(recovered, "SELECT COUNT(*) FROM sqlite_master WHERE name = 'broken_probe'")).toBe(0);
        expect(scalar(recovered, 'SELECT COUNT(*) FROM schema_migrations')).toBe(appliedBefore + 2);
        expect(scalar(recovered, 'SELECT COUNT(*) FROM sites WHERE id = ?', SITE_ID)).toBe(1);
      } finally {
        recovered.close();
      }
    } finally {
      if (savedMigrationsDir === undefined) delete process.env.SEO_AGENT_MIGRATIONS_DIR;
      else process.env.SEO_AGENT_MIGRATIONS_DIR = savedMigrationsDir;
    }

    // The previous application version (the repository's migrations) refuses the upgraded database instead of downgrading it (and writes nothing).
    const downgrade = await runCli(['--workspace', live, 'db', 'migrate'], env);
    expect(downgrade.code).toBe(1);
    expect(downgrade.err).toMatch(/unknown to this application version|do not downgrade/i);
    const oldInit = await runCli(['--workspace', live, 'init'], env);
    expect(oldInit.code).toBe(1);
    expect(oldInit.err).toMatch(/unknown to this application version|downgrade/i);

    // 7. Private files are byte-identical: config, secrets file, human-edited vault notes (and the whole vault).
    const now = snapshot();
    expect([...now.config.keys()].sort()).toEqual([...before.config.keys()].sort());
    for (const [k, v] of before.config) expect(now.config.get(k)?.equals(v), `config/${k}`).toBe(true);
    for (const [k, v] of before.secrets) expect(now.secrets.get(k)?.equals(v), `secrets/${k}`).toBe(true);
    for (const [k, v] of before.humanNotes) expect(now.humanNotes.get(k)?.equals(v), k).toBe(true);
    for (const [k, v] of before.vault) expect(now.vault.get(k)?.equals(v), `vault/${k}`).toBe(true);
    expect(readFileSync(profileNote, 'utf8')).toMatch(/synthetic human edit/);
    if (process.platform !== 'win32') expect(statSync(paths.secretsEnvFile).mode & 0o777).toBe(0o600);

    // Nothing private is exposed: the secret stays in the secrets file only; the demo and the live workspace stay separate.
    expect(allFilesContaining(live, SYNTHETIC_SECRET)).toEqual(['secrets/secrets.env']);
    expect(allFilesContaining(demoDir, SYNTHETIC_SECRET)).toEqual([]);
    const diag = await runCli(['--workspace', live, 'diagnostics', 'export', '--dry-run', '--json'], env);
    expect(diag.code, diag.err).toBe(0);
    expect(diag.out).not.toContain(SYNTHETIC_SECRET);
    const liveDb = openReadOnly(paths.dbFile);
    try {
      expect(scalar(liveDb, 'SELECT COUNT(*) FROM sites WHERE is_demo = 1')).toBe(0);
      expect(scalar(liveDb, "SELECT COUNT(*) FROM sites WHERE id = 'demo-widgets'")).toBe(0);
      expect(scalar(liveDb, 'SELECT COUNT(*) FROM gsc_page_daily')).toBe(0);
    } finally {
      liveDb.close();
    }
    const demoDb = openReadOnly(workspacePaths(demoDir).dbFile);
    try {
      expect(scalar(demoDb, 'SELECT COUNT(*) FROM sites WHERE id = ?', SITE_ID)).toBe(0);
    } finally {
      demoDb.close();
    }
    expect(readManifest(workspacePaths(demoDir))?.kind).toBe('demo');
    expect(readManifest(paths)?.kind).toBe('live');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
