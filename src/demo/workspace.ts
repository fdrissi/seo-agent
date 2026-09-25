import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { AppError } from '../core/errors.js';
import { readDotenvFile } from '../config/env.js';
import { parseYamlSafe } from '../config/load.js';
import { appDirs, appRoot, forbiddenRootLabel, resolveRealPath, siteConfigFile, workspacePaths, type WorkspacePaths } from '../config/paths.js';
import { parseSiteConfig, type SiteConfig } from '../config/site-schema.js';
import { initWorkspace, isRepoPath, readManifest } from '../config/workspace.js';
import { openDatabase } from '../database/db.js';
import { initSiteVault } from '../obsidian/template.js';

/**
 * The ISOLATED demo workspace (spec 29: "an isolated demo database/vault,
 * never mixed into live reporting").
 *
 * - Default location: `<os.tmpdir()>/seo-agent-demo`, or `--dir`.
 * - It is a normal workspace whose manifest says `kind: "demo"`, plus a demo
 *   marker file. The demo never touches a live workspace (manifest kind
 *   `live`), a directory that is not a workspace but holds files, the
 *   application repository, the home directory, or the filesystem root.
 * - Refreshing a previous demo removes ONLY the entries the demo itself
 *   creates (workspace folders, manifest, demo site copy, marker); anything
 *   else found in the directory is left untouched and reported. Before
 *   anything is removed, the refresh aborts (WORKSPACE_UNSAFE, listing the
 *   paths) when those folders hold something the demo did not create: a
 *   site config other than the demo site, a non-demo site in the database,
 *   a value in secrets/secrets.env, or a Google credential file.
 * - The demo site configuration (`tests/fixtures/demo/site.yaml`, profile
 *   `demo`) describes a fictional business on reserved example domains.
 */

export const DEMO_DIR_NAME = 'seo-agent-demo';
export const DEMO_MARKER_FILE = '.seo-agent-demo.json';
/** Copy of the synthetic fixture site served (offline) to the demo crawler; the demo "deploys" its synthetic change here. */
export const DEMO_SITE_DIR = 'demo-site';

/** Entries the demo creates inside its directory (the only ones a refresh removes). */
const DEMO_OWNED_ENTRIES = [
  'workspace.json',
  'README.md',
  '.gitignore',
  'config',
  'secrets',
  'vault',
  'data',
  'qdrant',
  'exports',
  'reports',
  'logs',
  'backups',
  'diagnostics',
  DEMO_SITE_DIR,
  DEMO_MARKER_FILE,
];

export interface DemoMarker {
  _synthetic: true;
  kind: 'seo-agent-demo';
  note: string;
  createdAt: string;
  root: string;
  siteId: string;
}

export function defaultDemoDir(): string {
  return path.join(os.tmpdir(), DEMO_DIR_NAME);
}

export function demoFixturesDir(): string {
  return path.join(appDirs.fixtures(), 'demo');
}

/** The synthetic site configuration of the demo (profile demo, reserved example domains). */
export function demoSiteConfigText(): string {
  return readFileSync(path.join(demoFixturesDir(), 'site.yaml'), 'utf8');
}

export function demoSiteConfig(): SiteConfig {
  const cfg = parseSiteConfig(parse(demoSiteConfigText()));
  if (cfg.profile !== 'demo') throw new AppError('CONFIG_INVALID', 'The demo site configuration must use the demo profile.');
  return cfg;
}

export interface PreparedDemoWorkspace {
  root: string;
  paths: WorkspacePaths;
  config: SiteConfig;
  configFile: string;
  vaultDir: string;
  siteDir: string;
  /** True when a previous demo in this directory was replaced. */
  refreshed: boolean;
  /** Entries found in the directory that the demo did not create (left untouched). */
  untouched: string[];
}

function readMarker(root: string): DemoMarker | null {
  const file = path.join(root, DEMO_MARKER_FILE);
  if (!existsSync(file)) return null;
  try {
    const m = JSON.parse(readFileSync(file, 'utf8')) as Partial<DemoMarker>;
    return m && m.kind === 'seo-agent-demo' && m._synthetic === true ? (m as DemoMarker) : null;
  } catch {
    return null;
  }
}

/**
 * Refuse every directory that could hold something the demo must never
 * touch. Returns whether an existing demo workspace will be refreshed.
 */
export function assertDemoDirSafe(root: string, env: NodeJS.ProcessEnv = process.env): { existingDemo: boolean } {
  const abs = path.resolve(root);
  const real = resolveRealPath(abs);
  // The same forbidden-root list `init` uses (filesystem root, home directory, system temp directory itself).
  const label = forbiddenRootLabel(abs, env);
  if (label) throw new AppError('WORKSPACE_UNSAFE', `Refusing to use ${label} (${abs}) as the demo directory.`, { hint: `Pass --dir <empty or demo directory>, e.g. ${defaultDemoDir()}.` });
  let repo: string | null = null;
  try {
    repo = resolveRealPath(appRoot());
  } catch {
    repo = null;
  }
  if ((repo && (real === repo || real.startsWith(`${repo}${path.sep}`))) || isRepoPath(abs)) {
    throw new AppError('WORKSPACE_UNSAFE', `Refusing to create the demo workspace inside the application repository (${abs}).`, { hint: `Use the default (${defaultDemoDir()}) or --dir outside the repository.` });
  }
  if (!existsSync(abs)) return { existingDemo: false };
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) throw new AppError('WORKSPACE_UNSAFE', `The demo directory ${abs} is a symbolic link; refusing to follow it.`, { hint: 'Pass --dir <a real directory path>.' });
  if (!st.isDirectory()) throw new AppError('WORKSPACE_UNSAFE', `The demo path ${abs} exists and is not a directory.`, { hint: 'Pass --dir <empty or demo directory>.' });
  const paths = workspacePaths(abs);
  let manifest: ReturnType<typeof readManifest>;
  try {
    manifest = readManifest(paths);
  } catch (err) {
    throw new AppError('WORKSPACE_UNSAFE', `${abs} has an unreadable workspace manifest; the demo will not touch it.`, { cause: err, hint: 'Pass --dir <empty or demo directory>.' });
  }
  if (manifest && manifest.kind !== 'demo') {
    throw new AppError('WORKSPACE_UNSAFE', `${abs} is a ${manifest.kind} workspace. The demo never touches a live workspace; nothing was changed.`, {
      hint: `Run the demo in its own directory (default ${defaultDemoDir()}), e.g. npm run demo -- --dir /tmp/seo-agent-demo`,
    });
  }
  const entries = readdirSync(abs);
  if (!manifest) {
    if (entries.length === 0) return { existingDemo: false };
    throw new AppError('WORKSPACE_UNSAFE', `${abs} is not empty and is not a seo-agent demo workspace; the demo will not touch it.`, { hint: 'Pass --dir <empty or demo directory>.' });
  }
  if (!readMarker(abs)) {
    throw new AppError('WORKSPACE_UNSAFE', `${abs} is marked as a demo workspace but has no demo marker (${DEMO_MARKER_FILE}); refusing to refresh it automatically.`, {
      hint: 'Delete that directory yourself if it only holds demo data, or pass another --dir.',
    });
  }
  assertDemoRefreshSafe(abs);
  return { existingDemo: true };
}

/**
 * What a refresh would delete that the demo did not create (paths only,
 * never values): site configs other than the demo site (or a demo site file
 * whose profile is no longer demo), setup drafts, database sites that are
 * not flagged as demo, values in secrets/secrets.env, and Google credential
 * files.
 */
export function demoRefreshBlockers(root: string): string[] {
  const paths = workspacePaths(root);
  const demoId = demoSiteConfig().site.id;
  const demoFile = `${demoId}.yaml`;
  const out: string[] = [];
  if (existsSync(paths.sitesDir)) {
    for (const entry of readdirSync(paths.sitesDir).sort()) {
      const file = path.join(paths.sitesDir, entry);
      if (entry !== demoFile) {
        out.push(`${file} (not the demo site configuration)`);
        continue;
      }
      let profile: unknown = null;
      try {
        const raw = parseYamlSafe(readFileSync(file, 'utf8'), file);
        profile = raw && typeof raw === 'object' ? (raw as { profile?: unknown }).profile : null;
      } catch {
        profile = null;
      }
      if (profile !== 'demo') out.push(`${file} (no longer a demo-profile configuration)`);
    }
  }
  if (existsSync(paths.dbFile)) {
    try {
      const db = openDatabase(paths.dbFile, { readOnly: true });
      try {
        const hasSites = db.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'sites'");
        const live = hasSites ? db.all<{ id: string }>('SELECT id FROM sites WHERE is_demo = 0 ORDER BY id') : [];
        for (const r of live) out.push(`${paths.dbFile} (site "${r.id}" is not a demo site)`);
      } finally {
        db.close();
      }
    } catch {
      out.push(`${paths.dbFile} (could not be read to confirm it only holds demo data)`);
    }
  }
  const secretValues = Object.entries(readDotenvFile(paths.secretsEnvFile)).filter(([, v]) => v !== '');
  if (secretValues.length) out.push(`${paths.secretsEnvFile} (holds values for ${secretValues.map(([k]) => k).join(', ')})`);
  if (existsSync(paths.googleDir)) {
    for (const entry of readdirSync(paths.googleDir).sort()) out.push(`${path.join(paths.googleDir, entry)} (Google credential file)`);
  }
  return out;
}

/** Abort a demo refresh (before anything is deleted) when it would destroy something the demo did not create. */
export function assertDemoRefreshSafe(root: string): void {
  const blockers = demoRefreshBlockers(root);
  if (!blockers.length) return;
  throw new AppError('WORKSPACE_UNSAFE', `${root} holds data the demo did not create; refreshing the demo would delete it, so nothing was changed.`, {
    details: { errors: blockers },
    hint: 'Move those files to a live workspace (`npm run cli -- --workspace <dir> init`), or run the demo in another directory with --dir.',
  });
}

/**
 * Create (or refresh) the isolated demo workspace: manifest kind `demo`,
 * the synthetic site configuration, the site vault from the template, and a
 * private copy of the synthetic fixture site.
 */
export function prepareDemoWorkspace(opts: { dir?: string; now: Date; fixtureSiteDir: string; env?: NodeJS.ProcessEnv }): PreparedDemoWorkspace {
  const root = path.resolve(opts.dir ?? defaultDemoDir());
  // assertDemoDirSafe also refuses a refresh that would delete non-demo data (checked before any removal).
  const { existingDemo } = assertDemoDirSafe(root, opts.env);
  const untouched: string[] = [];
  if (existingDemo) {
    for (const entry of readdirSync(root)) {
      if (DEMO_OWNED_ENTRIES.includes(entry)) rmSync(path.join(root, entry), { recursive: true, force: true });
      else untouched.push(entry);
    }
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  initWorkspace(root, { kind: 'demo', now: opts.now });
  const paths = workspacePaths(root);
  const config = demoSiteConfig();
  const configFile = siteConfigFile(paths, config.site.id);
  writeFileSync(configFile, demoSiteConfigText(), { mode: 0o600, flag: 'wx' });
  const vault = initSiteVault({ templateDir: appDirs.vaultTemplate(), vaultRoot: paths.vaultRoot, siteId: config.site.id, businessName: config.site.businessName });
  const siteDir = path.join(root, DEMO_SITE_DIR);
  cpSync(opts.fixtureSiteDir, siteDir, { recursive: true, errorOnExist: true, force: false });
  writeFileSync(
    path.join(siteDir, 'SYNTHETIC-README.txt'),
    'SYNTHETIC demo website copy. Served offline by the demo fixture transport (no network).\nThe demo simulates a deployment by editing a page here; nothing real is changed.\n',
  );
  const marker: DemoMarker = {
    _synthetic: true,
    kind: 'seo-agent-demo',
    note: 'SYNTHETIC seo-agent demo workspace. Contains only fictional data; safe to delete. Never use it for live reporting.',
    createdAt: opts.now.toISOString(),
    root,
    siteId: config.site.id,
  };
  writeFileSync(path.join(root, DEMO_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  return { root, paths, config, configFile, vaultDir: vault.vaultDir, siteDir, refreshed: existingDemo, untouched };
}

/** True when `root` holds a seo-agent demo workspace (manifest kind demo + marker). */
export function isDemoWorkspace(root: string): boolean {
  try {
    const m = readManifest(workspacePaths(root));
    return m?.kind === 'demo' && readMarker(root) !== null;
  } catch {
    return false;
  }
}
