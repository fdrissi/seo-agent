#!/usr/bin/env node
// Writes dist/build-info.json right after `tsc -p tsconfig.build.json`
// (package.json "build": `tsc -p tsconfig.build.json && node scripts/write-build-info.mjs`).
//
// The stamp records the package version, the Git revision when available, a
// hash of the TypeScript sources (src/**/*.ts), and the sorted migrations/
// list. At run time src/setup/build-info.ts compares it with the files on
// disk, so a dist/ left over from before an upgrade is detected instead of
// silently running old code against new migrations (docs/UPGRADING.md).
//
// The hash algorithm must stay identical to hashSourceTree() in
// src/setup/build-info.ts; tests/integration/setup/build-info.test.ts checks it.
// verifyBuildInfo() is the read side (the checkBuildFreshness() comparison)
// for scripts/release-check.mjs, which must not trust the compiled code it checks.
//
// Imports node built-ins only: the container build stage copies just this file
// (Dockerfile; `npm run release:check` item "docker-build-inputs").
//
// Safety: the script refuses to stamp a dist/ whose compiled files are older
// than their sources (for example when it is run on its own after editing
// src/ without compiling), because the stamp would then describe code that
// dist/ does not contain.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILD_INFO_FILE = 'build-info.json';
export const BUILD_INFO_SCHEMA = 1;
const MIGRATION_FILE_RE = /^\d{4}_[a-z0-9_]+\.sql$/;

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function sourceFiles(srcDir) {
  const rels = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), childRel);
      else if (e.isFile() && e.name.endsWith('.ts')) rels.push(childRel);
    }
  };
  walk(srcDir, '');
  return rels.sort();
}

/** Same algorithm as hashSourceTree() in src/setup/build-info.ts. */
export function hashSourceTree(srcDir) {
  if (!isDir(srcDir)) return null;
  const rels = sourceFiles(srcDir);
  const h = createHash('sha256');
  for (const rel of rels) h.update(`${rel}\0${sha256Hex(readFileSync(path.join(srcDir, ...rel.split('/'))))}\n`);
  return { hash: h.digest('hex'), files: rels.length };
}

export function listMigrationFiles(dir) {
  if (!isDir(dir)) return null;
  return readdirSync(dir)
    .filter((f) => MIGRATION_FILE_RE.test(f))
    .sort();
}

/** `git rev-parse HEAD` and whether src/ or migrations/ have uncommitted changes; nulls outside Git. */
export function gitState(root) {
  const git = (args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 10_000 }).trim();
  let revision = null;
  try {
    revision = git(['rev-parse', 'HEAD']) || null;
  } catch {
    return { revision: null, dirty: null };
  }
  let dirty = null;
  try {
    dirty = git(['status', '--porcelain', '--', 'src', 'migrations']).length > 0;
  } catch {
    dirty = null;
  }
  return { revision, dirty };
}

/**
 * Compiled files older than their sources (src/x/y.ts -> dist/x/y.js), and
 * sources with no compiled file. Declaration-only files (.d.ts) are skipped.
 */
export function staleOutputs(root, distDir = path.join(root, 'dist')) {
  const srcDir = path.join(root, 'src');
  const out = [];
  if (!isDir(srcDir)) return out;
  for (const rel of sourceFiles(srcDir)) {
    if (rel.endsWith('.d.ts')) continue;
    const src = path.join(srcDir, ...rel.split('/'));
    const js = path.join(distDir, ...rel.replace(/\.ts$/, '.js').split('/'));
    let jsTime;
    try {
      jsTime = statSync(js).mtimeMs;
    } catch {
      out.push(`${rel} (no compiled file)`);
      continue;
    }
    // A small tolerance for filesystems with coarse timestamps.
    if (statSync(src).mtimeMs > jsTime + 1000) out.push(`${rel} (changed after it was compiled)`);
  }
  return out;
}

export function createBuildInfo(root, opts = {}) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const src = hashSourceTree(path.join(root, 'src'));
  if (!src) throw new Error(`No src/ directory in ${root}; nothing to stamp.`);
  const git = opts.git === false ? { revision: null, dirty: null } : gitState(root);
  return {
    schema: BUILD_INFO_SCHEMA,
    name: typeof pkg.name === 'string' ? pkg.name : 'seo-agent',
    version: String(pkg.version),
    builtAt: (opts.now ?? new Date()).toISOString(),
    gitRevision: git.revision,
    gitDirty: git.dirty,
    srcHash: src.hash,
    srcFiles: src.files,
    migrations: listMigrationFiles(path.join(root, 'migrations')),
  };
}

function listPreview(items, max = 5) {
  return `${items.slice(0, max).join(', ')}${items.length > max ? `, and ${items.length - max} more` : ''}`;
}

/**
 * Compare <root>/dist/build-info.json with package.json, src/, and migrations/
 * in `root`: the same comparison and states as checkBuildFreshness() in
 * src/setup/build-info.ts (tests/integration/setup/build-info.test.ts proves
 * they agree), for tools that must not depend on the compiled code they check
 * (scripts/release-check.mjs).
 *
 * state: 'not_built' (no dist/cli/main.js), 'unstamped' (no readable stamp),
 * 'stale' (reasons say why), or 'fresh'.
 */
export function verifyBuildInfo(root, opts = {}) {
  const distDir = opts.distDir ?? path.join(root, 'dist');
  const entry = path.join(distDir, 'cli', 'main.js');
  let entryExists = false;
  try {
    entryExists = statSync(entry).isFile();
  } catch {
    entryExists = false;
  }
  if (!entryExists) return { state: 'not_built', info: null, reasons: [`${entry} does not exist: nothing was compiled`] };
  const file = path.join(distDir, BUILD_INFO_FILE);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { state: 'unstamped', info: null, reasons: [`${file} is missing: this build was not made with \`npm run build\``] };
  }
  let info;
  try {
    info = JSON.parse(text);
  } catch (err) {
    return { state: 'unstamped', info: null, reasons: [`${file} is not valid JSON (${err instanceof Error ? err.message : String(err)})`] };
  }
  const okList = (v) => v === null || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
  if (!info || typeof info !== 'object' || info.schema !== BUILD_INFO_SCHEMA || typeof info.version !== 'string' || typeof info.srcHash !== 'string' || typeof info.builtAt !== 'string' || !okList(info.migrations)) {
    return { state: 'unstamped', info: null, reasons: [`${file} has an unexpected format (written by another version of the build script)`] };
  }
  const reasons = [];
  let currentVersion = null;
  try {
    const v = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    currentVersion = typeof v === 'string' ? v : null;
  } catch {
    currentVersion = null;
  }
  if (currentVersion !== null && info.version !== currentVersion) reasons.push(`the build is version ${info.version}, but package.json is ${currentVersion}`);
  const src = hashSourceTree(path.join(root, 'src'));
  if (src && src.hash !== info.srcHash) reasons.push(`src/ changed since the build (${info.builtAt})`);
  const onDisk = listMigrationFiles(path.join(root, 'migrations'));
  if (info.migrations && onDisk) {
    const stamped = new Set(info.migrations);
    const present = new Set(onDisk);
    const added = onDisk.filter((m) => !stamped.has(m));
    const removed = info.migrations.filter((m) => !present.has(m));
    if (added.length) reasons.push(`migrations/ has ${added.length} migration(s) the build does not know: ${listPreview(added)}`);
    if (removed.length) reasons.push(`the build expects ${removed.length} migration(s) missing from migrations/: ${listPreview(removed)}`);
  }
  return { state: reasons.length ? 'stale' : 'fresh', info, reasons };
}

/** Write <root>/dist/build-info.json (atomically). Throws when dist/ is missing or older than src/. */
export function writeBuildInfo(root, opts = {}) {
  const distDir = path.join(root, 'dist');
  const entry = path.join(distDir, 'cli', 'main.js');
  try {
    statSync(entry);
  } catch {
    throw new Error(`${entry} does not exist. Compile first: npm run build (tsc -p tsconfig.build.json && node scripts/write-build-info.mjs).`);
  }
  if (opts.checkOutputs !== false) {
    const stale = staleOutputs(root, distDir);
    if (stale.length) {
      throw new Error(
        `dist/ is older than src/ for ${stale.length} file(s) (${stale.slice(0, 5).join(', ')}${stale.length > 5 ? ', ...' : ''}). Refusing to stamp a build that does not contain these sources; run \`npm run build\`.`,
      );
    }
  }
  const info = createBuildInfo(root, opts);
  const file = path.join(distDir, BUILD_INFO_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, file);
  return { file, info };
}

function isMain() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  // Real paths: the script may be reached through a symlink (for example macOS /var -> /private/var).
  try {
    return realpathSync(path.resolve(argv1)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    // --skip-output-check: stamp even when compiled files look older than their sources
    // (only for a compiler that does not rewrite unchanged outputs; never needed with `npm run build`).
    const { file, info } = writeBuildInfo(root, { checkOutputs: !process.argv.includes('--skip-output-check') });
    const notes = [];
    if (info.migrations === null) notes.push('WARNING: migrations/ was not found, so the stamp has no migration list and migration checks are skipped for this build');
    if (info.gitDirty) notes.push('note: src/ or migrations/ had uncommitted changes');
    process.stdout.write(
      `Build stamp written: ${path.relative(root, file)} (v${info.version}${info.gitRevision ? `, Git ${info.gitRevision.slice(0, 12)}` : ''}, ${info.srcFiles} source files, ${info.migrations ? info.migrations.length : 'no'} migrations)${notes.length ? `\n${notes.join('\n')}` : ''}\n`,
    );
  } catch (err) {
    process.stderr.write(`write-build-info: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
