import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build freshness (docs/UPGRADING.md, docs/SCHEDULING.md).
 *
 * `npm run build` compiles src/ into dist/ and then runs
 * scripts/write-build-info.mjs, which writes `dist/build-info.json`: the
 * package version, the Git revision when available, a hash of the TypeScript
 * sources (src/**\/*.ts), and the sorted list of migration files. dist/ is not
 * version-controlled, so `git checkout <tag> && npm ci` keeps an OLD build.
 * This module compares that stamp with the files on disk so that:
 *
 * - `schedule instructions` never points a scheduler at a stale dist/;
 * - `schedule run` refuses to start from a dist/ whose stamp does not match
 *   migrations/;
 * - the CLI warns at startup when it runs from a stale dist/;
 * - `migrate()` refuses, when running compiled, to apply migrations the
 *   build was not stamped with;
 * - `doctor` reports the state.
 *
 * The hash algorithm is duplicated in scripts/write-build-info.mjs (the
 * build script cannot import TypeScript, and dist/ cannot import scripts/);
 * tests/integration/setup/build-info.test.ts proves both agree.
 *
 * This module is a leaf (node built-ins only) so the CLI entry point and the
 * migration runner can use it cheaply.
 */

export const BUILD_INFO_FILE = 'build-info.json';
export const BUILD_INFO_SCHEMA = 1;
/** Migration file names (also used by src/database/migrate.ts loadMigrations). */
export const MIGRATION_FILE_RE = /^\d{4}_[a-z0-9_]+\.sql$/;
/** What the owner must do when the compiled build does not match the sources. */
export const REBUILD_STEPS =
  'Run `npm run build`, then re-run `npm run cli -- schedule instructions` and reinstall the printed scheduler snippet if its command changed (docs/UPGRADING.md).';
/**
 * What the owner must do when a compiled build WITHOUT src/ (a packaged
 * install or a container image) is unstamped or does not match its files: it
 * cannot be rebuilt in place, so REBUILD_STEPS would be impossible advice.
 */
export const REINSTALL_STEPS =
  'This installation has no src/ directory (a packaged install or container image), so it cannot be rebuilt in place: reinstall or upgrade the seo-agent package (or pull or rebuild the container image) with a complete release whose dist/ includes build-info.json, then re-run `seo-agent schedule instructions` and reinstall the printed scheduler snippet if its command changed (docs/UPGRADING.md).';

export interface BuildInfo {
  schema: 1;
  name: string;
  version: string;
  builtAt: string;
  /** `git rev-parse HEAD` at build time, or null outside a Git checkout. */
  gitRevision: string | null;
  /** Uncommitted changes under src/ or migrations/ at build time (null when unknown). */
  gitDirty: boolean | null;
  /** sha256 over the sorted src/**\/*.ts files (see hashSourceTree). */
  srcHash: string;
  srcFiles: number;
  /** Sorted migration file names at build time; null when migrations/ was not present at build time. */
  migrations: string[] | null;
}

export type BuildState = 'fresh' | 'stale' | 'unstamped' | 'not_built';

export interface BuildFreshness {
  state: BuildState;
  appRoot: string;
  distDir: string;
  /** dist/cli/main.js */
  entry: string;
  info: BuildInfo | null;
  /** Why the build is stale or unstamped (empty when fresh or not built). */
  reasons: string[];
  currentVersion: string | null;
  /** null when not compared (no stamp, or package.json unreadable). */
  versionMatches: boolean | null;
  /** null when not compared (no stamp, or no src/ directory, e.g. a packaged install). */
  sourcesMatch: boolean | null;
  /**
   * True when the sources directory exists (a checkout that `npm run build`
   * can rebuild); false for a packaged install or container image. Optional
   * for hand-built values: buildRepairSteps() then checks `<appRoot>/src`.
   */
  hasSources?: boolean;
  migrations: {
    stamped: string[] | null;
    onDisk: string[] | null;
    /** On disk but unknown to the build (an older build would apply migrations it does not know). */
    added: string[];
    /** Known to the build but missing on disk (the build is newer than the checked-out migrations). */
    removed: string[];
    /** null when not compared (no stamp, the stamp has no list, or no migrations/ directory). */
    match: boolean | null;
  };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Hash of the TypeScript sources: every regular `*.ts` file under `srcDir`
 * (what tsconfig.build.json compiles), by POSIX relative path in sorted
 * order, as sha256 over lines `<relPath>\0<sha256(content)>\n`. Null when
 * `srcDir` does not exist.
 */
export function hashSourceTree(srcDir: string): { hash: string; files: number } | null {
  if (!isDir(srcDir)) return null;
  const rels: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), childRel);
      else if (e.isFile() && e.name.endsWith('.ts')) rels.push(childRel);
    }
  };
  walk(srcDir, '');
  rels.sort();
  const h = createHash('sha256');
  for (const rel of rels) h.update(`${rel}\0${sha256Hex(readFileSync(path.join(srcDir, ...rel.split('/'))))}\n`);
  return { hash: h.digest('hex'), files: rels.length };
}

/** Sorted migration file names in `dir`, or null when it does not exist. */
export function listMigrationFiles(dir: string): string[] | null {
  if (!isDir(dir)) return null;
  return readdirSync(dir)
    .filter((f) => MIGRATION_FILE_RE.test(f))
    .sort();
}

/** Read and shape-check `<distDir>/build-info.json`. */
export function readBuildInfo(distDir: string): { info: BuildInfo | null; problem: string | null } {
  const file = path.join(distDir, BUILD_INFO_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { info: null, problem: `${file} is missing: this build was not made with \`npm run build\`, so it cannot show which sources and migrations it was built from` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { info: null, problem: `${file} is not valid JSON (${(err as Error).message})` };
  }
  const r = raw as Partial<BuildInfo> | null;
  const okList = (v: unknown) => v === null || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
  if (
    !r ||
    typeof r !== 'object' ||
    r.schema !== BUILD_INFO_SCHEMA ||
    typeof r.version !== 'string' ||
    typeof r.srcHash !== 'string' ||
    typeof r.builtAt !== 'string' ||
    !okList(r.migrations)
  ) {
    return { info: null, problem: `${file} has an unexpected format (written by another version of the build script)` };
  }
  return {
    info: {
      schema: BUILD_INFO_SCHEMA,
      name: typeof r.name === 'string' ? r.name : 'seo-agent',
      version: r.version,
      builtAt: r.builtAt,
      gitRevision: typeof r.gitRevision === 'string' ? r.gitRevision : null,
      gitDirty: typeof r.gitDirty === 'boolean' ? r.gitDirty : null,
      srcHash: r.srcHash,
      srcFiles: typeof r.srcFiles === 'number' ? r.srcFiles : 0,
      migrations: r.migrations ? [...r.migrations] : null,
    },
    problem: null,
  };
}

function packageVersion(appRoot: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

function listPreview(items: string[], max = 5): string {
  return `${items.slice(0, max).join(', ')}${items.length > max ? `, and ${items.length - max} more` : ''}`;
}

export interface BuildFreshnessOptions {
  appRoot: string;
  /** Compiled output directory (default <appRoot>/dist). */
  distDir?: string;
  /** Migrations on disk (default <appRoot>/migrations). */
  migrationsDir?: string;
  /** Sources on disk (default <appRoot>/src). */
  srcDir?: string;
}

/** Compare the stamp of a compiled build with the version, sources, and migrations on disk. */
export function checkBuildFreshness(opts: BuildFreshnessOptions): BuildFreshness {
  const appRoot = path.resolve(opts.appRoot);
  const distDir = path.resolve(opts.distDir ?? path.join(appRoot, 'dist'));
  const entry = path.join(distDir, 'cli', 'main.js');
  const migrationsDir = opts.migrationsDir ?? path.join(appRoot, 'migrations');
  const srcDir = opts.srcDir ?? path.join(appRoot, 'src');
  const currentVersion = packageVersion(appRoot);
  const onDisk = listMigrationFiles(migrationsDir);
  const base: BuildFreshness = {
    state: 'not_built',
    appRoot,
    distDir,
    entry,
    info: null,
    reasons: [],
    currentVersion,
    versionMatches: null,
    sourcesMatch: null,
    hasSources: isDir(srcDir),
    migrations: { stamped: null, onDisk, added: [], removed: [], match: null },
  };
  let entryExists = false;
  try {
    entryExists = statSync(entry).isFile();
  } catch {
    entryExists = false;
  }
  if (!entryExists) return base;
  const { info, problem } = readBuildInfo(distDir);
  if (!info) return { ...base, state: 'unstamped', reasons: [problem ?? 'no build stamp'] };

  const reasons: string[] = [];
  const versionMatches = currentVersion === null ? null : info.version === currentVersion;
  if (versionMatches === false) reasons.push(`the build is version ${info.version}, but package.json is ${currentVersion}`);
  const src = hashSourceTree(srcDir);
  const sourcesMatch = src ? src.hash === info.srcHash : null;
  if (sourcesMatch === false) reasons.push(`src/ changed since the build (${info.builtAt}${info.gitRevision ? `, Git ${info.gitRevision.slice(0, 12)}` : ''})`);
  const migrations = { ...base.migrations, stamped: info.migrations };
  if (info.migrations && onDisk) {
    const stamped = new Set(info.migrations);
    const present = new Set(onDisk);
    migrations.added = onDisk.filter((m) => !stamped.has(m));
    migrations.removed = info.migrations.filter((m) => !present.has(m));
    migrations.match = !migrations.added.length && !migrations.removed.length;
    if (migrations.added.length) reasons.push(`migrations/ has ${migrations.added.length} migration(s) the build does not know: ${listPreview(migrations.added)}`);
    if (migrations.removed.length) reasons.push(`the build expects ${migrations.removed.length} migration(s) missing from migrations/: ${listPreview(migrations.removed)}`);
  }
  return { ...base, state: reasons.length ? 'stale' : 'fresh', info, reasons, versionMatches, sourcesMatch, migrations };
}

// ---------------------------------------------------------------------------
// The running process
// ---------------------------------------------------------------------------

const HERE = fileURLToPath(import.meta.url);

/** True when this process runs the compiled JavaScript (dist/), not the TypeScript sources. */
export function isCompiledRuntime(): boolean {
  return HERE.endsWith('.js');
}

/** The dist/ directory of the running build, or null when running from sources. */
export function runningDistDir(): string | null {
  // This file compiles to <dist>/setup/build-info.js.
  return isCompiledRuntime() ? path.resolve(path.dirname(HERE), '..') : null;
}

let override: { freshness: BuildFreshness | null } | undefined;
let cache: { at: number; value: BuildFreshness } | undefined;
const CACHE_MS = 30_000;

/**
 * Test-only: pretend the process runs from a compiled build with this
 * freshness (null = running from sources; undefined = no override). Honored
 * only under the test runner (NODE_ENV=test or VITEST set).
 */
export function setRunningBuildForTests(freshness: BuildFreshness | null | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'test' && !env.VITEST) throw new Error('setRunningBuildForTests is only available under the test runner');
  override = freshness === undefined ? undefined : { freshness };
  cache = undefined;
}

/** Freshness of the build this process runs from; null when it runs from the TypeScript sources. */
export function runningBuildFreshness(): BuildFreshness | null {
  if (override) return override.freshness;
  const distDir = runningDistDir();
  if (!distDir) return null;
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  const value = checkBuildFreshness({ appRoot: path.dirname(distDir), distDir });
  cache = { at: now, value };
  return value;
}

/**
 * The repair steps for a compiled build that is unstamped or out of date:
 * REBUILD_STEPS (`npm run build`) when its sources are present, otherwise
 * REINSTALL_STEPS (a packaged install cannot be rebuilt in place).
 */
export function buildRepairSteps(f: (Pick<BuildFreshness, 'appRoot'> & { hasSources?: boolean }) | null | undefined): string {
  if (!f) return REBUILD_STEPS;
  return (f.hasSources ?? isDir(path.join(f.appRoot, 'src'))) ? REBUILD_STEPS : REINSTALL_STEPS;
}

function describeBuild(f: BuildFreshness): string {
  if (!f.info) return `the compiled build in ${f.distDir}`;
  return `the compiled build in ${f.distDir} (v${f.info.version}, built ${f.info.builtAt}${f.info.gitRevision ? `, Git ${f.info.gitRevision.slice(0, 12)}` : ''})`;
}

/** One-line startup warning for a stale or unstamped compiled build (null when fresh or running from sources). */
export function staleBuildWarning(f: BuildFreshness | null): string | null {
  if (!f || f.state === 'fresh' || f.state === 'not_built') return null;
  if (f.state === 'unstamped') return `WARNING: ${describeBuild(f)} has no build stamp, so it may not match src/ and migrations/: ${f.reasons.join('; ')}. ${buildRepairSteps(f)}`;
  return `WARNING: ${describeBuild(f)} is out of date: ${f.reasons.join('; ')}. It runs the old compiled code. ${buildRepairSteps(f)}`;
}

/**
 * Why `schedule run` must not start from this build (null when it may): the
 * running compiled build has no stamp, or its stamp does not match the
 * migrations on disk. Running from sources (null) is always allowed.
 */
export function scheduledRunBuildProblem(f: BuildFreshness | null): string | null {
  if (!f || f.state === 'not_built') return null;
  if (f.state === 'unstamped') return `${describeBuild(f)} has no build stamp (${BUILD_INFO_FILE}), so it cannot show that it knows the migrations in migrations/: ${f.reasons.join('; ')}`;
  if (f.migrations.match === false) {
    return `${describeBuild(f)} does not match migrations/: ${[
      ...(f.migrations.added.length ? [`${f.migrations.added.length} migration(s) on disk are unknown to it (${listPreview(f.migrations.added)})`] : []),
      ...(f.migrations.removed.length ? [`${f.migrations.removed.length} migration(s) it expects are missing (${listPreview(f.migrations.removed)})`] : []),
    ].join('; ')}`;
  }
  return null;
}

/** The migrations a compiled build may apply (see migrate()). */
export interface BuildMigrationGuard {
  /** Human description of the build, for messages. */
  build: string;
  /** Migration file names the build was stamped with (empty for an unstamped build: it may apply none). */
  known: readonly string[];
  /** What the owner must do when a migration is refused (buildRepairSteps; default REBUILD_STEPS). */
  hint?: string;
}

/** Guard for the running process: null when running from sources, or when the stamp has no migration list. */
export function runningBuildMigrationGuard(): BuildMigrationGuard | null {
  const f = runningBuildFreshness();
  if (!f || f.state === 'not_built') return null;
  if (!f.info) return { build: `${describeBuild(f)}, which has no build stamp (${BUILD_INFO_FILE})`, known: [], hint: buildRepairSteps(f) };
  if (!f.info.migrations) return null;
  return { build: describeBuild(f), known: f.info.migrations, hint: buildRepairSteps(f) };
}
