/**
 * Configuration migrations (preamble: "configuration/schema migrations,
 * pre-migration backups"). The production registries are empty at version 1,
 * so these tests inject a SYNTHETIC v0 -> v1 transform and remove it again.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../../src/cli/main.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import {
  applyConfigMigrations,
  configMigrationRegistry,
  migrationChain,
  planSiteConfigMigration,
  planWorkspaceConfigMigrations,
  planWorkspaceManifestMigration,
  type ConfigMigration,
} from '../../../src/config/config-migrations.js';
import { loadSiteConfig } from '../../../src/config/load.js';
import { siteConfigFile, workspacePaths } from '../../../src/config/paths.js';
import { SITE_CONFIG_SCHEMA_VERSION } from '../../../src/config/site-schema.js';
import { WORKSPACE_FORMAT_VERSION, initWorkspace, readManifest } from '../../../src/config/workspace.js';

/** SYNTHETIC v0 -> v1 site transform: v0 kept the business name at the top level as `name`. */
const SITE_V0_TO_V1: ConfigMigration = {
  from: 0,
  description: 'move top-level "name" to site.businessName (synthetic test transform)',
  migrate(doc) {
    const { name, ...rest } = doc as { name?: unknown; site?: Record<string, unknown> } & Record<string, unknown>;
    const site = { ...((rest.site as Record<string, unknown> | undefined) ?? {}) };
    if (typeof name === 'string' && site.businessName === undefined) site.businessName = name;
    return { ...rest, site };
  },
};

/** SYNTHETIC v0 -> v1 manifest transform: v0 called the workspace kind `mode`. */
const WORKSPACE_V0_TO_V1: ConfigMigration = {
  from: 0,
  description: 'rename "mode" to "kind" (synthetic test transform)',
  migrate(doc) {
    const { mode, ...rest } = doc as { mode?: unknown } & Record<string, unknown>;
    return { ...rest, kind: rest.kind ?? mode ?? 'live' };
  },
};

const V0_SITE = `# Private site config (SYNTHETIC test business)
schemaVersion: 0
name: Acme Synthetic Co
site:
  id: acme-site
  # canonical URL, verified by the owner
  url: https://www.example.com/
  allowedHostnames: [www.example.com]
reporting:
  businessTimezone: Europe/Tallinn # business zone
crawl:
  maxPages: 150 # keep small
`;

const V0_MANIFEST = `${JSON.stringify({ formatVersion: 0, createdAt: '2020-01-01T00:00:00.000Z', createdByAppVersion: '0.0.1', mode: 'live', note: 'synthetic older workspace' }, null, 2)}\n`;

let tmp: string;
let root: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-cfgmig-'));
  root = path.join(tmp, 'workspace');
  initWorkspace(root, { now: new Date('2026-09-24T09:00:00Z') });
});
afterEach(() => {
  configMigrationRegistry.site.length = 0;
  configMigrationRegistry.workspace.length = 0;
  rmSync(tmp, { recursive: true, force: true });
});

const writeSite = (text = V0_SITE) => {
  const file = siteConfigFile(workspacePaths(root), 'acme-site');
  writeFileSync(file, text, { mode: 0o600 });
  return file;
};

async function cli(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const runtime = new CliRuntime({ out: (t) => void out.push(t), err: (t) => void err.push(t) }, { HOME: tmp, SEO_AGENT_WORKSPACE: root });
  const program = await buildProgram(runtime);
  program.exitOverride();
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'seo-agent', ...args]);
  } catch (e) {
    if (!(e instanceof CliExit) && !String((e as { code?: string }).code ?? '').startsWith('commander.')) throw e;
  }
  const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = undefined;
  return { out: out.join('\n'), err: err.join('\n'), code, json: <T = any>() => JSON.parse(out.join('\n')) as T };
}

describe('registries and chains', () => {
  it('the production registries are empty at version 1', () => {
    expect(SITE_CONFIG_SCHEMA_VERSION).toBe(1);
    expect(WORKSPACE_FORMAT_VERSION).toBe(1);
    expect(configMigrationRegistry).toEqual({ site: [], workspace: [] });
  });

  it('builds only contiguous chains', () => {
    const v1: ConfigMigration = { from: 1, description: 'x', migrate: (d) => d };
    expect(migrationChain([SITE_V0_TO_V1, v1], 0, 2)?.map((m) => m.from)).toEqual([0, 1]);
    expect(migrationChain([v1], 0, 2)).toBeNull();
    expect(migrationChain([SITE_V0_TO_V1, SITE_V0_TO_V1], 0, 1)).toBeNull();
    expect(migrationChain([], 1, 1)).toEqual([]);
  });
});

describe('site config migration (v0 -> v1, synthetic transform)', () => {
  it('plans a diff that keeps comments of unchanged sections and validates the result; nothing is written', () => {
    const file = writeSite();
    const plan = planSiteConfigMigration(file, { migrations: [SITE_V0_TO_V1] });
    expect(plan).toMatchObject({ status: 'pending', fromVersion: 0, toVersion: 1, errors: [] });
    expect(plan.steps).toEqual(['v0 -> v1: move top-level "name" to site.businessName (synthetic test transform)']);
    expect(plan.proposedText).toContain('schemaVersion: 1');
    expect(plan.proposedText).toContain('businessName: Acme Synthetic Co');
    expect(plan.proposedText).not.toMatch(/^name:/m);
    for (const kept of ['# Private site config (SYNTHETIC test business)', '# canonical URL, verified by the owner', 'businessTimezone: Europe/Tallinn # business zone', 'maxPages: 150 # keep small']) {
      expect(plan.proposedText).toContain(kept);
    }
    expect(plan.diff).toMatch(/^-schemaVersion: 0$/m);
    expect(plan.diff).toMatch(/^\+schemaVersion: 1$/m);
    expect(readFileSync(file, 'utf8')).toBe(V0_SITE);
  });

  it('reports a missing migration path, a newer version, and a result that would not validate', () => {
    const file = writeSite();
    expect(planSiteConfigMigration(file, { migrations: [] })).toMatchObject({ status: 'unsupported', fromVersion: 0 });
    writeSite(V0_SITE.replace('schemaVersion: 0', 'schemaVersion: 3'));
    expect(planSiteConfigMigration(file, { migrations: [SITE_V0_TO_V1] })).toMatchObject({ status: 'newer', fromVersion: 3 });
    writeSite(V0_SITE.replace('name: Acme Synthetic Co\n', ''));
    const broken = planSiteConfigMigration(file, { migrations: [SITE_V0_TO_V1] });
    expect(broken.status).toBe('invalid');
    expect(broken.errors.join('\n')).toMatch(/site\.businessName/);
    writeSite(V0_SITE.replace('schemaVersion: 0', 'schemaVersion: 1').replace('name: Acme Synthetic Co\n', '').replace('  id: acme-site\n', '  id: acme-site\n  businessName: Acme\n'));
    expect(planSiteConfigMigration(file, { migrations: [SITE_V0_TO_V1] })).toMatchObject({ status: 'current', fromVersion: 1, proposedText: null });
  });

  it('applies with a backup of the original (0600) and writes the migrated file with mode 0600', () => {
    const file = writeSite();
    const paths = workspacePaths(root);
    const plans = planWorkspaceConfigMigrations(paths, { siteMigrations: [SITE_V0_TO_V1] });
    const applied = applyConfigMigrations(paths, plans, new Date('2026-09-24T10:00:00.000Z'));
    expect(applied.backupDir).toBe(path.join(paths.backupsDir, 'config', '2026-09-24T10-00-00-000Z'));
    expect(applied.written).toEqual([{ file, backup: path.join(applied.backupDir!, 'sites', 'acme-site.yaml') }]);
    expect(readFileSync(applied.written[0]!.backup, 'utf8')).toBe(V0_SITE);
    expect(loadSiteConfig(paths, 'acme-site').site.businessName).toBe('Acme Synthetic Co');
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(applied.written[0]!.backup).mode & 0o777).toBe(0o600);
    }
    // A second backup directory never overwrites the first.
    writeSite();
    const again = applyConfigMigrations(paths, planWorkspaceConfigMigrations(paths, { siteMigrations: [SITE_V0_TO_V1] }), new Date('2026-09-24T10:00:00.000Z'));
    expect(again.backupDir).toBe(`${applied.backupDir}-1`);
  });

  it('refuses to overwrite a file that changed after planning', () => {
    const file = writeSite();
    const paths = workspacePaths(root);
    const plans = planWorkspaceConfigMigrations(paths, { siteMigrations: [SITE_V0_TO_V1] });
    writeFileSync(file, `${V0_SITE}# edited meanwhile\n`);
    expect(() => applyConfigMigrations(paths, plans, new Date())).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(readFileSync(file, 'utf8')).toBe(`${V0_SITE}# edited meanwhile\n`);
  });
});

describe('workspace.json migration (format 0 -> 1, synthetic transform)', () => {
  it('plans and applies the manifest upgrade with a backup; init and contexts refuse the old format until then', () => {
    const paths = workspacePaths(root);
    writeFileSync(paths.manifest, V0_MANIFEST, { mode: 0o600 });
    expect(() => initWorkspace(root)).toThrow(expect.objectContaining({ code: 'WORKSPACE_UNSAFE', hint: expect.stringContaining('config migrate') }));
    expect(planWorkspaceManifestMigration(paths, { migrations: [] })).toMatchObject({ status: 'unsupported', fromVersion: 0 });
    const plan = planWorkspaceManifestMigration(paths, { migrations: [WORKSPACE_V0_TO_V1] })!;
    expect(plan).toMatchObject({ status: 'pending', fromVersion: 0, toVersion: 1 });
    expect(JSON.parse(plan.proposedText!)).toMatchObject({ formatVersion: 1, kind: 'live', note: 'synthetic older workspace' });
    expect(JSON.parse(plan.proposedText!).mode).toBeUndefined();
    const applied = applyConfigMigrations(paths, [plan], new Date('2026-09-24T11:00:00.000Z'));
    expect(readFileSync(path.join(applied.backupDir!, 'workspace.json'), 'utf8')).toBe(V0_MANIFEST);
    expect(readManifest(paths)).toMatchObject({ formatVersion: 1, kind: 'live' });
    if (process.platform !== 'win32') expect(statSync(paths.manifest).mode & 0o777).toBe(0o600);
    expect(() => initWorkspace(root)).not.toThrow();
  });
});

describe('CLI: config migrate [--yes] and db migrate (read-only report)', () => {
  it('shows the diff without --yes (nothing written), applies with --yes (backup first), and db migrate only reports', async () => {
    configMigrationRegistry.site.push(SITE_V0_TO_V1);
    configMigrationRegistry.workspace.push(WORKSPACE_V0_TO_V1);
    const paths = workspacePaths(root);
    const file = writeSite();
    writeFileSync(paths.manifest, V0_MANIFEST, { mode: 0o600 });

    // Commands that load the site refuse the older config with the next step.
    const validate = await cli('config', 'validate', '--json');
    expect(validate.code).toBe(1);
    expect(JSON.stringify(validate.json())).toMatch(/older than 1/);

    // db migrate reports pending configuration migrations, read-only.
    const db = await cli('db', 'migrate', '--json');
    expect(db.code, db.err).toBe(0);
    expect(db.json().pendingConfigMigrations).toEqual([
      { file: paths.manifest, kind: 'workspace-manifest', status: 'pending', fromVersion: 0, toVersion: 1 },
      { file, kind: 'site-config', status: 'pending', fromVersion: 0, toVersion: 1 },
    ]);
    const dbHuman = await cli('db', 'migrate', '--dry-run');
    expect(dbHuman.out).toContain('Configuration migrations pending (not applied by db migrate)');
    expect(dbHuman.out).toContain('config migrate');
    expect(readFileSync(file, 'utf8')).toBe(V0_SITE);
    expect(readFileSync(paths.manifest, 'utf8')).toBe(V0_MANIFEST);

    // Without --yes: the diff, and nothing written.
    const preview = await cli('config', 'migrate');
    expect(preview.code, preview.err).toBe(0);
    expect(preview.out).toContain('Pending: workspace.json (version 0 -> 1)');
    expect(preview.out).toContain(`Pending: ${file} (version 0 -> 1)`);
    expect(preview.out).toMatch(/^\+schemaVersion: 1$/m);
    expect(preview.out).toContain('Nothing was written. Apply with: npm run cli -- config migrate --yes');
    expect(readFileSync(file, 'utf8')).toBe(V0_SITE);
    expect(existsSync(path.join(paths.backupsDir, 'config'))).toBe(false);
    // --dry-run never writes, even with --yes.
    expect((await cli('config', 'migrate', '--yes', '--dry-run', '--json')).json()).toMatchObject({ applied: false, dryRun: true });
    expect(readFileSync(file, 'utf8')).toBe(V0_SITE);

    // --yes: backups first, then 0600 writes.
    const run = await cli('config', 'migrate', '--yes', '--json');
    expect(run.code, run.err).toBe(0);
    const r = run.json<{ applied: boolean; backupDir: string; written: Array<{ file: string; backup: string }> }>();
    expect(r.applied).toBe(true);
    expect(r.written.map((w) => w.file).sort()).toEqual([file, paths.manifest].sort());
    expect(readdirSync(r.backupDir).sort()).toEqual(['sites', 'workspace.json']);
    expect(readFileSync(path.join(r.backupDir, 'sites', 'acme-site.yaml'), 'utf8')).toBe(V0_SITE);
    expect(readFileSync(path.join(r.backupDir, 'workspace.json'), 'utf8')).toBe(V0_MANIFEST);
    if (process.platform !== 'win32') for (const f of [file, paths.manifest]) expect(statSync(f).mode & 0o777).toBe(0o600);
    expect((await cli('config', 'validate', '--json')).code).toBe(0);
    expect((await cli('config', 'migrate')).out).toContain('No configuration migration is needed.');
    // Now current: db migrate output is unchanged from before this feature.
    expect((await cli('db', 'migrate', '--dry-run', '--json')).json()).toEqual({ dryRun: true, wouldApply: [], unknown: [] });
  });

  it('refuses to apply anything while a file cannot be migrated, and exits 1', async () => {
    const file = writeSite();
    mkdirSync(path.dirname(file), { recursive: true });
    const r = await cli('config', 'migrate', '--yes');
    expect(r.code).toBe(1);
    expect(r.out).toContain(`Cannot migrate: ${file} (version 0)`);
    expect(r.out).toContain('No configuration migration path from schemaVersion 0 to 1');
    expect(readFileSync(file, 'utf8')).toBe(V0_SITE);
    configMigrationRegistry.site.push(SITE_V0_TO_V1);
    writeFileSync(siteConfigFile(workspacePaths(root), 'future-site'), V0_SITE.replace('schemaVersion: 0', 'schemaVersion: 5').replace('acme-site', 'future-site'));
    const blocked = await cli('config', 'migrate', '--yes');
    expect(blocked.code).toBe(1);
    expect(blocked.err).toContain('Error [CONFIG_INVALID]: Nothing was migrated');
    expect(readFileSync(file, 'utf8')).toBe(V0_SITE);
  });
});
