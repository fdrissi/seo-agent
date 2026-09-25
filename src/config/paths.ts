import { existsSync, lstatSync, opendirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../core/errors.js';
import { isWithin, safeResolve } from '../security/paths.js';

/**
 * Public application vs private workspace.
 *
 * The application (this repository or an installed package) contains code,
 * prompts, migrations, docs, and vault templates. Everything private (site
 * config, secrets, vaults, databases, raw responses, reports, logs, backups,
 * Qdrant storage) lives in a workspace OUTSIDE the repository by default.
 *
 * Workspace resolution precedence (highest first):
 *   1. --workspace <dir> CLI flag
 *   2. SEO_AGENT_WORKSPACE environment variable
 *   3. ~/seo-agent-workspace
 *
 * Locations inside the workspace are derived from its root, except the ones
 * the workspace manifest (`workspace.json`) relocates with an optional,
 * validated `paths` block (vaultDir, backupsDir, qdrantDir, exportsDir,
 * reportsDir). See docs/WORKSPACE.md, "Custom locations".
 */

export const DEFAULT_WORKSPACE_DIRNAME = 'seo-agent-workspace';

export interface WorkspacePaths {
  root: string;
  manifest: string;
  configDir: string;
  sitesDir: string;
  secretsDir: string;
  /** Protected secret file (dotenv format, mode 0600). */
  secretsEnvFile: string;
  /** Google credential files live under secrets/google (mode 0600). */
  googleDir: string;
  vaultRoot: string;
  dataDir: string;
  dbFile: string;
  rawDir: string;
  cacheDir: string;
  qdrantDir: string;
  exportsDir: string;
  reportsDir: string;
  logsDir: string;
  backupsDir: string;
  diagnosticsDir: string;
}

export function defaultWorkspaceDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.HOME || os.homedir(), DEFAULT_WORKSPACE_DIRNAME);
}

export function resolveWorkspaceDir(flag?: string | null, env: NodeJS.ProcessEnv = process.env): string {
  const raw = flag || env.SEO_AGENT_WORKSPACE || defaultWorkspaceDir(env);
  // Expand "~" and "~/..." only; "~other-user/..." is not expanded (no user lookup).
  const expanded = raw === '~' || raw.startsWith('~/') ? path.join(env.HOME || os.homedir(), raw.slice(1)) : raw;
  return path.resolve(expanded);
}

/**
 * Resolve symbolic links in `p` even when it does not exist yet: the deepest
 * existing ancestor is resolved with the operating system's realpath
 * (`realpathSync.native`) and the missing remainder is appended. Used by every
 * "is this inside X" safety check so a path reached through a symlink (for
 * example macOS /tmp -> /private/tmp, or a symlinked projects folder) is
 * compared by where it really is. The native realpath also returns the
 * canonical letter case of existing components on a case-insensitive volume
 * (macOS APFS, Windows NTFS), so "<ws>/Vault" resolves to "<ws>/vault" (D3-02);
 * the JavaScript realpath keeps the case as typed. Compare two resolved paths
 * with `isWithinRealPath` / `isSameRealPath`, which also fold the case of the
 * parts that do not exist yet on such a volume.
 */
export function resolveRealPath(p: string): string {
  const abs = path.resolve(p);
  const rest: string[] = [];
  let current = abs;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return abs;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/** The deepest existing directory at or above `abs` (the directory of an existing file). */
function deepestExistingDir(abs: string): string | null {
  let current = abs;
  for (;;) {
    try {
      const st = statSync(current);
      return st.isDirectory() ? current : path.dirname(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

const swapAsciiCase = (name: string) => name.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));

/**
 * Whether names inside `dir` are looked up case-insensitively: an entry whose
 * name has an ASCII letter is looked up again with the case of its letters
 * swapped. Null when `dir` has no such entry (or cannot be read).
 */
function probeDirCaseInsensitive(dir: string): boolean | null {
  let handle;
  try {
    handle = opendirSync(dir);
  } catch {
    return null;
  }
  let name: string | null = null;
  try {
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      if (/[a-z]/i.test(entry.name)) {
        name = entry.name;
        break;
      }
    }
  } catch {
    name = null;
  } finally {
    try {
      handle.closeSync();
    } catch {
      /* already closed */
    }
  }
  if (!name) return null;
  try {
    const a = lstatSync(path.join(dir, name));
    const b = lstatSync(path.join(dir, swapAsciiCase(name)));
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

const caseInsensitiveByDevice = new Map<number, boolean>();

/**
 * Whether the volume that holds `p` (its deepest existing directory) compares
 * file names case-insensitively, as macOS APFS and Windows NTFS do by default.
 * Probed once per device by looking up an existing entry with its letter case
 * swapped; when no directory on the device can be probed, macOS and Windows
 * are assumed case-insensitive and other systems case-sensitive.
 */
export function isCaseInsensitivePath(p: string): boolean {
  const fallback = process.platform === 'darwin' || process.platform === 'win32';
  const dir = deepestExistingDir(path.resolve(p));
  if (!dir) return fallback;
  let dev: number;
  try {
    dev = statSync(dir).dev;
  } catch {
    return fallback;
  }
  const cached = caseInsensitiveByDevice.get(dev);
  if (cached !== undefined) return cached;
  let result: boolean | null = null;
  for (let cur = dir; ; ) {
    result = probeDirCaseInsensitive(cur);
    if (result !== null) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    try {
      if (statSync(parent).dev !== dev) break;
    } catch {
      break;
    }
    cur = parent;
  }
  const value = result ?? fallback;
  caseInsensitiveByDevice.set(dev, value);
  return value;
}

/** Case- and normalization-folded form of a path, for comparisons on a case-insensitive volume. */
const foldPath = (p: string) => p.normalize('NFC').toLowerCase();

/** `child` is `parent` or inside it; both already resolved by resolveRealPath. */
function isWithinResolved(parentReal: string, childReal: string): boolean {
  if (isWithin(parentReal, childReal)) return true;
  return isCaseInsensitivePath(childReal) && isWithin(foldPath(parentReal), foldPath(childReal));
}

/** Both already resolved by resolveRealPath. */
function isSameResolved(aReal: string, bReal: string): boolean {
  if (aReal === bReal) return true;
  return isCaseInsensitivePath(bReal) && foldPath(aReal) === foldPath(bReal);
}

/**
 * Whether `child` is `parent` or inside it, comparing where both really are:
 * symlinks resolved (resolveRealPath) and, on a case-insensitive volume,
 * letter case ignored, so "<ws>/Vault/token.json" is inside "<ws>/vault" on
 * macOS even before the vault exists (D3-02).
 */
export function isWithinRealPath(parent: string, child: string): boolean {
  return isWithinResolved(resolveRealPath(parent), resolveRealPath(child));
}

/** Whether `a` and `b` name the same location (symlinks resolved; case ignored on a case-insensitive volume). */
export function isSameRealPath(a: string, b: string): boolean {
  return isSameResolved(resolveRealPath(a), resolveRealPath(b));
}

/**
 * Directories that must never become (or hold the top level of) a private
 * workspace, a demo directory, or a relocated workspace folder: the
 * filesystem root, the home directory, and the system temporary directory
 * itself (subdirectories of the last two are fine). Returns a label for the
 * refused location, or null. Symlinks are resolved on both sides, and letter
 * case is ignored on a case-insensitive volume.
 */
export function forbiddenRootLabel(target: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const real = resolveRealPath(target);
  const homes = [...new Set([env.HOME, os.homedir()].filter((h): h is string => !!h))];
  const forbidden: Array<[string, string]> = [
    [path.parse(real).root, 'the filesystem root'],
    ...homes.map((h): [string, string] => [resolveRealPath(h), 'your home directory']),
    [resolveRealPath(os.tmpdir()), 'the system temporary directory itself'],
  ];
  for (const [p, label] of forbidden) if (isSameResolved(p, real)) return label;
  return null;
}

/**
 * Workspace folders the manifest may relocate (`workspace.json` -> `paths`).
 * `reportsDir` is relocatable because report records store paths relative to
 * the reports folder (src/reports/storage.ts), and legacy workspace-relative
 * rows still resolve. The database, secrets, config, logs, and diagnostics
 * stay under the workspace root.
 */
export const MANIFEST_PATH_KEYS = ['vaultDir', 'backupsDir', 'qdrantDir', 'exportsDir', 'reportsDir'] as const;
export type ManifestPathKey = (typeof MANIFEST_PATH_KEYS)[number];
export type WorkspacePathOverrides = Partial<Record<ManifestPathKey, string>>;

/**
 * Validate a manifest `paths` block for the workspace at `root`. Every entry
 * is optional; each given one must be an absolute path that is not inside the
 * application repository, not the filesystem root / home directory / system
 * temp directory itself, not inside (or equal to) the workspace's secrets/
 * directory, not the workspace root, and not a parent of the workspace (which
 * would put secrets/ inside it). Symlinks are resolved before comparing, and
 * letter case is ignored on a case-insensitive volume ("<ws>/SECRETS/x" is
 * inside secrets/ on macOS).
 */
export function validateWorkspacePathOverrides(root: string, raw: unknown, env: NodeJS.ProcessEnv = process.env): { paths: WorkspacePathOverrides; errors: string[] } {
  const out: WorkspacePathOverrides = {};
  const errors: string[] = [];
  if (raw === undefined || raw === null) return { paths: out, errors };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { paths: out, errors: ['paths: must be an object such as {"vaultDir": "/absolute/path"}'] };
  const realRoot = resolveRealPath(root);
  const realSecrets = resolveRealPath(path.join(root, 'secrets'));
  let repo: string | null = null;
  try {
    repo = appRoot();
  } catch {
    repo = null;
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const at = `paths.${key}`;
    if (!(MANIFEST_PATH_KEYS as readonly string[]).includes(key)) {
      errors.push(`${at}: unknown key (allowed: ${MANIFEST_PATH_KEYS.join(', ')})`);
      continue;
    }
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
      errors.push(`${at}: must be a non-empty absolute path`);
      continue;
    }
    if (!path.isAbsolute(value)) {
      errors.push(`${at}: must be an absolute path (got ${JSON.stringify(value)}; "~" is not expanded here)`);
      continue;
    }
    const real = resolveRealPath(value);
    const label = forbiddenRootLabel(value, env);
    if (label) {
      errors.push(`${at}: refusing ${label} (${value})`);
      continue;
    }
    if (repo && (isWithin(repo, path.resolve(value)) || isWithinResolved(resolveRealPath(repo), real))) {
      errors.push(`${at}: ${value} is inside the application repository; private data must live outside it`);
      continue;
    }
    if (isWithinResolved(realSecrets, real)) {
      errors.push(`${at}: ${value} is inside the workspace secrets/ directory`);
      continue;
    }
    if (isSameResolved(realRoot, real)) {
      errors.push(`${at}: ${value} is the workspace root itself; name a dedicated folder`);
      continue;
    }
    if (isWithinResolved(real, realRoot)) {
      errors.push(`${at}: ${value} contains the workspace (and its secrets/); name a folder outside it`);
      continue;
    }
    out[key as ManifestPathKey] = path.resolve(value);
  }
  return { paths: out, errors };
}

const overrideCache = new Map<string, { stamp: string; paths: WorkspacePathOverrides }>();

/**
 * The validated `paths` block of the workspace manifest at `root` (empty when
 * there is no manifest, no block, or the manifest is not readable JSON:
 * `readManifest` reports a corrupt manifest). An invalid block throws
 * WORKSPACE_UNSAFE instead of silently falling back to the default
 * locations.
 */
export function manifestPathOverrides(root: string): WorkspacePathOverrides {
  const r = path.resolve(root);
  const file = path.join(r, 'workspace.json');
  let stamp: string;
  try {
    const st = statSync(file);
    if (!st.isFile()) return {};
    stamp = `${st.mtimeMs}:${st.size}:${process.env.HOME ?? ''}`;
  } catch {
    return {};
  }
  const cached = overrideCache.get(file);
  if (cached && cached.stamp === stamp) return cached.paths;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  const block = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { paths?: unknown }).paths : undefined;
  const v = validateWorkspacePathOverrides(r, block);
  if (v.errors.length) {
    throw new AppError('WORKSPACE_UNSAFE', `The "paths" block in ${file} is invalid; nothing was read or written.`, {
      details: { errors: v.errors },
      hint: 'Fix or remove the "paths" block in workspace.json (see docs/WORKSPACE.md, "Custom locations").',
    });
  }
  overrideCache.set(file, { stamp, paths: v.paths });
  return v.paths;
}

export function workspacePaths(root: string): WorkspacePaths {
  const r = path.resolve(root);
  const secretsDir = path.join(r, 'secrets');
  const dataDir = path.join(r, 'data');
  // Optional relocations declared in workspace.json (validated; derived from the root otherwise).
  const o = manifestPathOverrides(r);
  return {
    root: r,
    manifest: path.join(r, 'workspace.json'),
    configDir: path.join(r, 'config'),
    sitesDir: path.join(r, 'config', 'sites'),
    secretsDir,
    secretsEnvFile: path.join(secretsDir, 'secrets.env'),
    googleDir: path.join(secretsDir, 'google'),
    vaultRoot: o.vaultDir ?? path.join(r, 'vault'),
    dataDir,
    dbFile: path.join(dataDir, 'seo-agent.sqlite'),
    rawDir: path.join(dataDir, 'raw'),
    cacheDir: path.join(dataDir, 'cache'),
    qdrantDir: o.qdrantDir ?? path.join(r, 'qdrant'),
    exportsDir: o.exportsDir ?? path.join(r, 'exports'),
    reportsDir: o.reportsDir ?? path.join(r, 'reports'),
    logsDir: path.join(r, 'logs'),
    backupsDir: o.backupsDir ?? path.join(r, 'backups'),
    diagnosticsDir: path.join(r, 'diagnostics'),
  };
}

/** Vault directory for one site. Site IDs are validated slugs; still resolved safely. */
export function siteVaultDir(paths: WorkspacePaths, siteId: string): string {
  return safeResolve(paths.vaultRoot, siteId);
}

export function siteConfigFile(paths: WorkspacePaths, siteId: string): string {
  return safeResolve(paths.sitesDir, `${siteId}.yaml`);
}

let cachedAppRoot: string | undefined;

/**
 * Root of the installed application (directory containing this package's
 * package.json). Works from src/ (tsx) and dist/ (compiled).
 */
export function appRoot(): string {
  if (cachedAppRoot) return cachedAppRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const name = (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name;
        if (name === 'seo-agent') {
          cachedAppRoot = dir;
          return dir;
        }
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Could not locate the seo-agent application root');
    dir = parent;
  }
}

export function appVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(appRoot(), 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

/**
 * Test-only override of the migrations directory (simulates an upgraded
 * application in the end-to-end upgrade test). Honored ONLY when running
 * under the test runner (NODE_ENV=test or VITEST set); a normal run always
 * uses the application's own migrations.
 */
export function migrationsDirOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env.SEO_AGENT_MIGRATIONS_DIR;
  if (!dir) return null;
  if (env.NODE_ENV !== 'test' && !env.VITEST) return null;
  return path.resolve(dir);
}

export const appDirs = {
  migrations: () => migrationsDirOverride() ?? path.join(appRoot(), 'migrations'),
  prompts: () => path.join(appRoot(), 'prompts'),
  vaultTemplate: () => path.join(appRoot(), 'vault', '_template'),
  fixtures: () => path.join(appRoot(), 'tests', 'fixtures'),
  exampleSiteConfig: () => path.join(appRoot(), 'config', 'sites', 'example.site.yaml'),
};
