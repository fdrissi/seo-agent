import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../core/errors.js';
import { isWithin, safeResolve } from '../security/paths.js';
import { appRoot, appVersion, forbiddenRootLabel, resolveRealPath, workspacePaths, type WorkspacePathOverrides, type WorkspacePaths } from './paths.js';

/**
 * Workspace initialization. NEVER overwrites existing files: every file is
 * created only when missing, and the result lists what was created versus
 * left untouched. Upgrades never rewrite a workspace; data changes happen only
 * through versioned migrations with a pre-migration backup.
 */

export const WORKSPACE_FORMAT_VERSION = 1;

export interface WorkspaceManifest {
  formatVersion: number;
  createdAt: string;
  createdByAppVersion: string;
  kind: 'live' | 'demo';
  note: string;
  /**
   * Optional relocations of workspace folders (absolute paths, validated by
   * `validateWorkspacePathOverrides`; applied by `workspacePaths`).
   */
  paths?: WorkspacePathOverrides;
}

export interface InitResult {
  root: string;
  created: string[];
  existing: string[];
  warnings: string[];
}

export interface InitOptions {
  kind?: 'live' | 'demo';
  /** Allow a workspace inside the application repository (discouraged; demo/tests only). */
  allowInsideRepo?: boolean;
  /**
   * Allow initializing a non-empty directory that has no workspace.json
   * (the layout is added next to the existing files; nothing is overwritten).
   * Default true for programmatic callers; the `init` command passes false
   * unless --allow-existing-dir is given.
   */
  allowExistingDir?: boolean;
  now?: Date;
  /** Report what would be created without touching the filesystem. */
  dryRun?: boolean;
  /** Environment used to find the home directory (default process.env). */
  env?: NodeJS.ProcessEnv;
}

const SECRETS_README = `# Secrets directory (private)

This directory holds credentials for this workspace only. It must never be
committed, synced to a shared vault, or attached to issues.

- secrets.env: API keys and passwords (dotenv format, mode 0600).
- google/: Google OAuth client file, refresh token file, or service-account key (mode 0600).

Prefer injecting secrets from a password manager (for example \`op run -- npm run cli -- doctor\`)
when available. Environment variables take precedence over secrets.env.
`;

const SECRETS_ENV_TEMPLATE = `# Private secrets for this workspace. Mode 0600. Never commit or share.
# Environment variables with the same names take precedence.
# LLM_GATEWAY_API_KEY=
# DATAFORSEO_LOGIN=
# DATAFORSEO_PASSWORD=
# APIFY_TOKEN=
# QDRANT_API_KEY=
# PAGESPEED_API_KEY=
`;

const WORKSPACE_README = `# seo-agent private workspace

This directory is PRIVATE. It contains your site configuration, credentials,
Obsidian vault, SQLite database, raw API responses, reports, logs, and backups.
It is intentionally separate from the application source code.

- config/sites/<site-id>.yaml  Site configuration (validated). Edit or run \`setup\`.
- secrets/                      Credentials (0700). Never place secrets in the vault.
- vault/<site-id>/              Obsidian-compatible Markdown vault.
- data/seo-agent.sqlite         Authoritative operational database.
- data/raw/                     Raw API responses referenced by observations.
- qdrant/                       Qdrant storage (rebuildable search index).
- reports/, exports/            Generated reports and manual exports.
- backups/                      Database/vault backups (pre-migration backups too).
- logs/                         Redacted logs.

Upgrading the application never overwrites this workspace.
`;

/** lstat-based existence (true for dangling symlinks, which must never be written through). */
function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `target` is inside the application repository. Both sides are
 * compared lexically AND with symlinks resolved (resolveRealPath), so a path
 * that reaches the repository through a symlink is recognised.
 */
export function isRepoPath(target: string): boolean {
  let root: string;
  try {
    root = appRoot();
  } catch {
    return false;
  }
  return isWithin(root, path.resolve(target)) || isWithin(resolveRealPath(root), resolveRealPath(target));
}

/**
 * Demo/live separation at run time: a demo-profile site (synthetic fixtures)
 * never runs in a live workspace, and a live (core/full) site never runs in a
 * demo workspace (real credentials and data would sit in a directory a demo
 * refresh deletes). Throws WORKSPACE_UNSAFE; nothing has been written.
 */
export function assertProfileMatchesWorkspace(kind: WorkspaceManifest['kind'], profile: string, where: { root: string; siteId: string }): void {
  if (kind === 'live' && profile === 'demo') {
    throw new AppError('WORKSPACE_UNSAFE', `Site "${where.siteId}" uses the demo profile (synthetic fixtures), but ${where.root} is a live workspace. Synthetic demo data never mixes with live data; nothing was run or written.`, {
      details: { workspaceKind: kind, profile, siteId: where.siteId },
      hint: `Remove config/sites/${where.siteId}.yaml from this live workspace and run \`npm run demo\` (isolated demo workspace), or set a core/full profile with real settings.`,
    });
  }
  if (kind === 'demo' && profile !== 'demo') {
    throw new AppError('WORKSPACE_UNSAFE', `${where.root} is a demo workspace, but site "${where.siteId}" uses the ${profile} profile. Real credentials and data never belong in a demo workspace (a demo refresh deletes it); nothing was run or written.`, {
      details: { workspaceKind: kind, profile, siteId: where.siteId },
      hint: 'Create a separate live workspace (`npm run cli -- --workspace <dir> init`) and import the config there with `npm run cli -- --workspace <dir> setup --from <file.yaml>`.',
    });
  }
}

/** Refuse a manifest format this application cannot use as-is (newer: upgrade; older: `config migrate`). */
export function assertManifestFormatSupported(manifest: WorkspaceManifest, root: string): void {
  if (manifest.formatVersion > WORKSPACE_FORMAT_VERSION) {
    throw new AppError('WORKSPACE_UNSAFE', `Workspace ${root} uses format ${manifest.formatVersion}, newer than this application supports (${WORKSPACE_FORMAT_VERSION}). Nothing was changed.`, {
      hint: 'Upgrade the application to the version that created this workspace (see docs/UPGRADING.md); never downgrade a live workspace.',
      details: { formatVersion: manifest.formatVersion, supported: WORKSPACE_FORMAT_VERSION },
    });
  }
  if (manifest.formatVersion < WORKSPACE_FORMAT_VERSION) {
    throw new AppError('WORKSPACE_UNSAFE', `Workspace ${root} uses the older format ${manifest.formatVersion}; this application uses format ${WORKSPACE_FORMAT_VERSION}. Nothing was changed.`, {
      hint: 'Review the upgrade with `npm run cli -- config migrate` (shows a diff), then apply it with `npm run cli -- config migrate --yes` (the original is backed up first).',
      details: { formatVersion: manifest.formatVersion, supported: WORKSPACE_FORMAT_VERSION },
    });
  }
}

export function readManifest(paths: WorkspacePaths): WorkspaceManifest | null {
  if (!existsSync(paths.manifest)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.manifest, 'utf8'));
  } catch (err) {
    throw new AppError('WORKSPACE_UNSAFE', `Workspace manifest ${paths.manifest} is not valid JSON (${(err as Error).message}).`, {
      hint: 'It was not modified. Restore it from a backup or fix it by hand; init never overwrites it.',
    });
  }
  const m = parsed as Partial<WorkspaceManifest> | null;
  if (!m || typeof m !== 'object' || typeof m.formatVersion !== 'number' || !Number.isInteger(m.formatVersion)) {
    throw new AppError('WORKSPACE_UNSAFE', `Workspace manifest ${paths.manifest} has no valid formatVersion.`, {
      hint: 'It was not modified. Restore it from a backup or fix it by hand; init never overwrites it.',
    });
  }
  return m as WorkspaceManifest;
}

export function initWorkspace(root: string, opts: InitOptions = {}): InitResult {
  const resolvedRoot = path.resolve(root);
  // Never the filesystem root, the home directory, or the system temp directory itself (the demo refuses the same list).
  const forbidden = forbiddenRootLabel(resolvedRoot, opts.env ?? process.env);
  if (forbidden) {
    throw new AppError('WORKSPACE_UNSAFE', `Refusing to use ${forbidden} (${resolvedRoot}) as a private workspace: its files would mix with unrelated files.`, {
      hint: 'Use a dedicated directory, e.g. ~/seo-agent-workspace (the default), via --workspace or SEO_AGENT_WORKSPACE.',
    });
  }
  if (isRepoPath(resolvedRoot) && !opts.allowInsideRepo) {
    throw new AppError('WORKSPACE_UNSAFE', `Refusing to create a private workspace inside the application repository: ${resolvedRoot}`, {
      hint: 'Choose a directory outside the repository (default ~/seo-agent-workspace) or set SEO_AGENT_WORKSPACE.',
    });
  }
  const paths = workspacePaths(resolvedRoot);
  const result: InitResult = { root: paths.root, created: [], existing: [], warnings: [] };

  const existingManifest = readManifest(paths);
  if (existingManifest && opts.kind && existingManifest.kind !== opts.kind) {
    throw new AppError('WORKSPACE_EXISTS', `Workspace at ${paths.root} is a ${existingManifest.kind} workspace, not ${opts.kind}.`);
  }
  if (existingManifest && existingManifest.formatVersion > WORKSPACE_FORMAT_VERSION) {
    throw new AppError('WORKSPACE_UNSAFE', `Workspace format ${existingManifest.formatVersion} is newer than this application supports (${WORKSPACE_FORMAT_VERSION}). Upgrade the application; do not downgrade.`);
  }
  if (existingManifest) assertManifestFormatSupported(existingManifest, paths.root);
  if (!existingManifest && opts.allowExistingDir === false && existsSync(paths.root)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(paths.root);
    } catch {
      entries = [];
    }
    if (entries.length) {
      throw new AppError('WORKSPACE_UNSAFE', `${paths.root} is not empty and has no workspace.json; refusing to mix a private workspace with unrelated files. Nothing was changed.`, {
        details: { entries: entries.slice(0, 20) },
        hint: 'Choose an empty or new directory, or run `npm run cli -- init --allow-existing-dir` to add the workspace layout next to the existing files (existing files are never overwritten).',
      });
    }
  }

  const dryRun = !!opts.dryRun;
  const dir = (p: string, mode = 0o755) => {
    if (lexists(p)) {
      result.existing.push(p);
      return;
    }
    if (!dryRun) mkdirSync(p, { recursive: true, mode });
    result.created.push(p);
  };
  const file = (p: string, content: string, mode = 0o644) => {
    if (lexists(p)) {
      result.existing.push(p);
      return;
    }
    if (dryRun) {
      result.created.push(p);
      return;
    }
    try {
      // 'wx' fails if the file appeared concurrently: never overwrite.
      writeFileSync(p, content, { mode, flag: 'wx' });
      result.created.push(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      result.existing.push(p);
      result.warnings.push(`${p} appeared while initializing; left untouched.`);
    }
  };

  dir(paths.root, 0o700);
  for (const d of [paths.configDir, paths.sitesDir, paths.vaultRoot, paths.dataDir, paths.rawDir, paths.cacheDir, paths.qdrantDir, paths.exportsDir, paths.reportsDir, paths.logsDir, paths.backupsDir, paths.diagnosticsDir]) dir(d, 0o700);
  dir(paths.secretsDir, 0o700);
  dir(paths.googleDir, 0o700);
  if (process.platform !== 'win32' && !dryRun) {
    // The only permission change ever applied to existing entries: secrets stay private.
    for (const d of [paths.secretsDir, paths.googleDir]) {
      const mode = statSync(d).mode & 0o777;
      if (mode !== 0o700) {
        chmodSync(d, 0o700);
        if (result.existing.includes(d)) result.warnings.push(`Tightened permissions of ${d} from ${mode.toString(8)} to 700.`);
      }
    }
  }

  if (process.platform !== 'win32' && !dryRun) {
    // Existing folders are never re-permissioned (only secrets/ is), but a workspace or data/
    // folder other users can read exposes the database: say so with the exact fix.
    for (const d of [paths.root, paths.dataDir]) {
      if (!result.existing.includes(d)) continue;
      let mode: number;
      try {
        mode = statSync(d).mode & 0o777;
      } catch {
        continue;
      }
      if (mode & 0o077) result.warnings.push(`${d} is accessible by other users (mode ${mode.toString(8)}); it holds private data such as the database. Run: chmod 700 "${d}"`);
    }
  }

  const manifest: WorkspaceManifest = {
    formatVersion: WORKSPACE_FORMAT_VERSION,
    createdAt: (opts.now ?? new Date()).toISOString(),
    createdByAppVersion: appVersion(),
    kind: opts.kind ?? 'live',
    note: opts.kind === 'demo' ? 'Synthetic demo workspace. Contains no real data.' : 'Private seo-agent workspace. Do not commit or share.',
  };
  file(paths.manifest, JSON.stringify(manifest, null, 2) + '\n', 0o600);
  file(path.join(paths.root, 'README.md'), WORKSPACE_README, 0o644);
  file(path.join(paths.root, '.gitignore'), '# Private workspace: never commit.\n*\n', 0o644);
  file(path.join(paths.secretsDir, 'README.md'), SECRETS_README, 0o600);
  file(paths.secretsEnvFile, SECRETS_ENV_TEMPLATE, 0o600);
  if (!dryRun && process.platform !== 'win32' && existsSync(paths.secretsEnvFile)) {
    const mode = statSync(paths.secretsEnvFile).mode & 0o777;
    if (mode & 0o077) result.warnings.push(`${paths.secretsEnvFile} is accessible by other users (mode ${mode.toString(8)}); run: chmod 600 "${paths.secretsEnvFile}"`);
  }

  return result;
}

/**
 * Copy the vault template for a site into the workspace, creating only
 * missing files (never overwriting human edits). Every destination is
 * resolved with safeResolve: a symlink inside the vault that points outside
 * it is never written through; such entries (and files where a folder is
 * expected) are listed in `skipped` instead.
 */
export function ensureVaultFromTemplate(templateDir: string, targetDir: string): { created: string[]; existing: string[]; skipped: string[] } {
  const created: string[] = [];
  const existing: string[] = [];
  const skipped: string[] = [];
  const resolve = (rel: string): string | null => {
    if (!rel) return path.resolve(targetDir);
    try {
      return safeResolve(targetDir, rel);
    } catch {
      skipped.push(path.join(targetDir, rel));
      return null;
    }
  };
  const walk = (rel: string) => {
    const dst = resolve(rel);
    if (dst === null) return;
    if (!lexists(dst)) {
      mkdirSync(dst, { recursive: true });
      created.push(dst);
    } else if (!statSync(dst).isDirectory()) {
      skipped.push(dst);
      return;
    }
    for (const entry of readdirSync(path.join(templateDir, rel), { withFileTypes: true })) {
      if (entry.name === '.gitkeep') continue;
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) {
        const d = resolve(childRel);
        if (d === null) continue;
        if (lexists(d)) existing.push(d);
        else {
          cpSync(path.join(templateDir, childRel), d, { errorOnExist: true, force: false });
          created.push(d);
        }
      }
    }
  };
  if (existsSync(templateDir)) walk('');
  return { created, existing, skipped };
}
