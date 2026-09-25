import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { warnIfStaleBuild } from '../../../src/cli/main.js';
import { assertScheduledRunBuild } from '../../../src/cli/commands/schedule.js';
import { buildSchedulingInstructions, renderInstructions, resolveCliInvocation } from '../../../src/jobs/instructions.js';
import { buildFreshnessCheck } from '../../../src/setup/doctor.js';
import { appRoot } from '../../../src/config/paths.js';
import { openDatabase } from '../../../src/database/db.js';
import { loadMigrations, migrate } from '../../../src/database/migrate.js';
import {
  BUILD_INFO_FILE,
  REBUILD_STEPS,
  REINSTALL_STEPS,
  buildRepairSteps,
  checkBuildFreshness,
  hashSourceTree,
  isCompiledRuntime,
  listMigrationFiles,
  runningBuildFreshness,
  runningBuildMigrationGuard,
  scheduledRunBuildProblem,
  setRunningBuildForTests,
  staleBuildWarning,
  type BuildFreshness,
} from '../../../src/setup/build-info.js';
import * as script from '../../../scripts/write-build-info.mjs';
import { makeWorkspace, runCli, type TestWorkspace } from './helpers.js';

/**
 * B1-05: `npm run build` stamps dist/ (scripts/write-build-info.mjs), and the
 * runtime compares the stamp with package.json, src/, and migrations/.
 * Everything here runs on synthetic temporary application trees; the real
 * repository's dist/ is never written.
 */

const temps: string[] = [];
afterEach(() => {
  setRunningBuildForTests(undefined);
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(d);
  return d;
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A synthetic application tree: package.json, src/, migrations/, and (optionally) compiled dist/. */
function makeApp(opts: { version?: string; built?: boolean } = {}): string {
  const root = tempDir('seo-agent-build-');
  write(path.join(root, 'package.json'), JSON.stringify({ name: 'seo-agent', version: opts.version ?? '9.9.9-synthetic' }));
  write(path.join(root, 'src', 'cli', 'main.ts'), 'export const main = 1;\n');
  write(path.join(root, 'src', 'core', 'util.ts'), 'export const util = 2;\n');
  write(path.join(root, 'src', 'core', 'types.d.ts'), 'export type T = string;\n');
  write(path.join(root, 'src', 'core', 'notes.txt'), 'not compiled, not hashed\n');
  write(path.join(root, 'migrations', '0001_core.sql'), 'CREATE TABLE a (id INTEGER);\n');
  write(path.join(root, 'migrations', '0002_more.sql'), 'CREATE TABLE b (id INTEGER);\n');
  write(path.join(root, 'migrations', 'README.md'), 'not a migration\n');
  if (opts.built !== false) compile(root);
  return root;
}

/** Stand-in for tsc: one .js per non-declaration .ts, written after the sources. */
function compile(root: string): void {
  write(path.join(root, 'dist', 'cli', 'main.js'), 'export const main = 1;\n');
  write(path.join(root, 'dist', 'core', 'util.js'), 'export const util = 2;\n');
}

const NOW = new Date('2026-09-24T09:00:00.000Z');

describe('scripts/write-build-info.mjs and src/setup/build-info.ts agree', () => {
  it('hash the same sources and list the same migrations (synthetic tree and a snapshot of the real src/)', () => {
    const root = makeApp();
    expect(script.hashSourceTree(path.join(root, 'src'))).toEqual(hashSourceTree(path.join(root, 'src')));
    expect(hashSourceTree(path.join(root, 'src'))!.files).toBe(3); // .ts and .d.ts, never other files
    expect(script.listMigrationFiles(path.join(root, 'migrations'))).toEqual(['0001_core.sql', '0002_more.sql']);
    expect(listMigrationFiles(path.join(root, 'migrations'))).toEqual(['0001_core.sql', '0002_more.sql']);

    // A snapshot, so edits made to src/ while the test runs cannot make the two calls differ.
    const snap = tempDir('seo-agent-src-snapshot-');
    cpSync(path.join(appRoot(), 'src'), path.join(snap, 'src'), { recursive: true });
    const a = script.hashSourceTree(path.join(snap, 'src'));
    expect(a).not.toBeNull();
    expect(a).toEqual(hashSourceTree(path.join(snap, 'src')));

    const real = path.join(appRoot(), 'migrations');
    expect(script.listMigrationFiles(real)).toEqual(listMigrationFiles(real));
    expect(listMigrationFiles(real)).toEqual(loadMigrations(real).map((m) => m.file));
  });

  it('writes dist/build-info.json with version, Git revision (null outside Git), source hash, and migrations', () => {
    const root = makeApp();
    const { file, info } = script.writeBuildInfo(root, { git: false, now: NOW });
    expect(file).toBe(path.join(root, 'dist', BUILD_INFO_FILE));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(info);
    expect(info).toMatchObject({ schema: 1, name: 'seo-agent', version: '9.9.9-synthetic', builtAt: NOW.toISOString(), gitRevision: null, gitDirty: null, srcFiles: 3, migrations: ['0001_core.sql', '0002_more.sql'] });
    expect(info.srcHash).toBe(hashSourceTree(path.join(root, 'src'))!.hash);
    expect(checkBuildFreshness({ appRoot: root })).toMatchObject({ state: 'fresh', reasons: [], versionMatches: true, sourcesMatch: true, migrations: { match: true, added: [], removed: [] } });
  });

  it('refuses to stamp a dist/ that is missing or older than its sources', () => {
    const unbuilt = makeApp({ built: false });
    expect(() => script.writeBuildInfo(unbuilt, { git: false })).toThrow(/does not exist\. Compile first/);

    const root = makeApp();
    const future = new Date(Date.now() + 60_000);
    utimesSync(path.join(root, 'src', 'core', 'util.ts'), future, future);
    expect(script.staleOutputs(root)).toEqual(['core/util.ts (changed after it was compiled)']);
    expect(() => script.writeBuildInfo(root, { git: false })).toThrow(/older than src\/.*core\/util\.ts/);
    expect(existsSync(path.join(root, 'dist', BUILD_INFO_FILE))).toBe(false);
    write(path.join(root, 'src', 'core', 'extra.ts'), 'export const extra = 3;\n');
    expect(script.staleOutputs(root)).toContain('core/extra.ts (no compiled file)');
  });

  it('runs as the build step (`node scripts/write-build-info.mjs`) and fails loudly without a compiled dist/', () => {
    const root = makeApp();
    mkdirSync(path.join(root, 'scripts'));
    copyFileSync(path.join(appRoot(), 'scripts', 'write-build-info.mjs'), path.join(root, 'scripts', 'write-build-info.mjs'));
    const out = execFileSync(process.execPath, [path.join(root, 'scripts', 'write-build-info.mjs')], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    expect(out).toMatch(/Build stamp written: dist[/\\]build-info\.json \(v9\.9\.9-synthetic.*3 source files, 2 migrations\)/);
    expect(checkBuildFreshness({ appRoot: root }).state).toBe('fresh');

    rmSync(path.join(root, 'dist'), { recursive: true });
    let status = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [path.join(root, 'scripts', 'write-build-info.mjs')], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
    } catch (err) {
      status = (err as { status: number }).status;
      stderr = String((err as { stderr: string }).stderr);
    }
    expect(status).toBe(1);
    expect(stderr).toMatch(/write-build-info: .*does not exist/);
  });

  it('verifyBuildInfo (release:check) reaches the same state as checkBuildFreshness in every case (C1-03)', () => {
    const cases: Array<[string, string]> = [];
    const unbuilt = makeApp({ built: false });
    cases.push(['not built', unbuilt]);
    const unstamped = makeApp();
    cases.push(['unstamped', unstamped]);
    const fresh = makeApp();
    script.writeBuildInfo(fresh, { git: false, now: NOW });
    cases.push(['fresh', fresh]);
    const version = makeApp();
    script.writeBuildInfo(version, { git: false, now: NOW });
    write(path.join(version, 'package.json'), JSON.stringify({ name: 'seo-agent', version: '9.10.0-synthetic' }));
    cases.push(['version moved on', version]);
    const sources = makeApp();
    script.writeBuildInfo(sources, { git: false, now: NOW });
    write(path.join(sources, 'src', 'core', 'util.ts'), 'export const util = 5;\n');
    cases.push(['sources changed', sources]);
    const migrationAdded = makeApp();
    script.writeBuildInfo(migrationAdded, { git: false, now: NOW });
    write(path.join(migrationAdded, 'migrations', '0003_new.sql'), 'CREATE TABLE c (id INTEGER);\n');
    cases.push(['migration added', migrationAdded]);
    const packaged = makeApp();
    script.writeBuildInfo(packaged, { git: false, now: NOW });
    rmSync(path.join(packaged, 'src'), { recursive: true });
    cases.push(['packaged install (no src/)', packaged]);
    const corrupt = makeApp();
    write(path.join(corrupt, 'dist', BUILD_INFO_FILE), '{ not json');
    cases.push(['corrupt stamp', corrupt]);

    const states = cases.map(([label, root]) => [label, script.verifyBuildInfo(root).state, checkBuildFreshness({ appRoot: root }).state]);
    for (const [label, a, b] of states) expect(a, label).toBe(b);
    expect(states.map((x) => x[1])).toEqual(['not_built', 'unstamped', 'fresh', 'stale', 'stale', 'stale', 'fresh', 'unstamped']);
    expect(script.verifyBuildInfo(migrationAdded).reasons).toEqual(checkBuildFreshness({ appRoot: migrationAdded }).reasons);
  });

  it('npm run build compiles and then stamps', () => {
    const pkg = JSON.parse(readFileSync(path.join(appRoot(), 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toBe('tsc -p tsconfig.build.json && node scripts/write-build-info.mjs');
    expect(existsSync(path.join(appRoot(), 'scripts', 'write-build-info.mjs'))).toBe(true);
  });
});

describe('build freshness', () => {
  function stamped(opts: { version?: string } = {}): string {
    const root = makeApp(opts);
    script.writeBuildInfo(root, { git: false, now: NOW });
    return root;
  }

  it('not built, unstamped, and fresh', () => {
    expect(checkBuildFreshness({ appRoot: makeApp({ built: false }) }).state).toBe('not_built');
    const unstamped = checkBuildFreshness({ appRoot: makeApp() });
    expect(unstamped.state).toBe('unstamped');
    expect(unstamped.reasons.join(' ')).toMatch(/build-info\.json is missing: this build was not made with `npm run build`/);
    expect(checkBuildFreshness({ appRoot: stamped() }).state).toBe('fresh');
  });

  it('an upgrade without a rebuild (new version, changed sources, new migration) makes it stale', () => {
    const root = stamped();
    write(path.join(root, 'package.json'), JSON.stringify({ name: 'seo-agent', version: '9.10.0-synthetic' }));
    write(path.join(root, 'src', 'core', 'util.ts'), 'export const util = 3;\n');
    write(path.join(root, 'migrations', '0003_new.sql'), 'CREATE TABLE c (id INTEGER);\n');
    const f = checkBuildFreshness({ appRoot: root });
    expect(f.state).toBe('stale');
    expect(f.versionMatches).toBe(false);
    expect(f.sourcesMatch).toBe(false);
    expect(f.migrations).toMatchObject({ added: ['0003_new.sql'], removed: [], match: false });
    const text = f.reasons.join('\n');
    expect(text).toMatch(/version 9\.9\.9-synthetic, but package\.json is 9\.10\.0-synthetic/);
    expect(text).toMatch(/src\/ changed since the build/);
    expect(text).toMatch(/migrations\/ has 1 migration\(s\) the build does not know: 0003_new\.sql/);
  });

  it('a build newer than the checked-out migrations is stale too; a packaged install without src/ compares what it can', () => {
    const root = stamped();
    rmSync(path.join(root, 'migrations', '0002_more.sql'));
    expect(checkBuildFreshness({ appRoot: root }).migrations).toMatchObject({ removed: ['0002_more.sql'], match: false });

    const packaged = stamped();
    rmSync(path.join(packaged, 'src'), { recursive: true });
    const f = checkBuildFreshness({ appRoot: packaged });
    expect(f).toMatchObject({ state: 'fresh', sourcesMatch: null, migrations: { match: true } });
  });

  it('schedule run refuses an unstamped build or one that does not match migrations/, not a src-only change or the sources', () => {
    expect(scheduledRunBuildProblem(null)).toBeNull();
    expect(() => assertScheduledRunBuild(null)).not.toThrow();

    const fresh = checkBuildFreshness({ appRoot: stamped() });
    expect(scheduledRunBuildProblem(fresh)).toBeNull();

    const srcOnly = stamped();
    write(path.join(srcOnly, 'src', 'core', 'util.ts'), 'export const util = 4;\n');
    const srcStale = checkBuildFreshness({ appRoot: srcOnly });
    expect(srcStale.state).toBe('stale');
    expect(scheduledRunBuildProblem(srcStale)).toBeNull();

    const unstamped = checkBuildFreshness({ appRoot: makeApp() });
    expect(scheduledRunBuildProblem(unstamped)).toMatch(/has no build stamp/);

    const newMigration = stamped();
    write(path.join(newMigration, 'migrations', '0003_new.sql'), 'CREATE TABLE c (id INTEGER);\n');
    const mismatch = checkBuildFreshness({ appRoot: newMigration });
    expect(scheduledRunBuildProblem(mismatch)).toMatch(/does not match migrations\/: 1 migration\(s\) on disk are unknown to it \(0003_new\.sql\)/);
    expect(() => assertScheduledRunBuild(mismatch)).toThrow(expect.objectContaining({ code: 'CONFLICT', hint: expect.stringContaining('npm run build') }));
  });

  it('the CLI warns at startup only when running from a stale or unstamped compiled build', () => {
    // Under the test runner this process runs the TypeScript sources.
    expect(isCompiledRuntime()).toBe(false);
    expect(runningBuildFreshness()).toBeNull();
    const lines: string[] = [];
    expect(warnIfStaleBuild((t) => lines.push(t), null)).toBeNull();
    expect(warnIfStaleBuild((t) => lines.push(t), checkBuildFreshness({ appRoot: stamped() }))).toBeNull();
    expect(lines).toEqual([]);

    const root = stamped();
    write(path.join(root, 'migrations', '0003_new.sql'), 'CREATE TABLE c (id INTEGER);\n');
    const w = warnIfStaleBuild((t) => lines.push(t), checkBuildFreshness({ appRoot: root }));
    expect(lines).toEqual([w]);
    expect(w).toMatch(/^WARNING: the compiled build in .* \(v9\.9\.9-synthetic, built 2026-09-24T09:00:00\.000Z\) is out of date: .*0003_new\.sql.*It runs the old compiled code\. Run `npm run build`, then re-run `npm run cli -- schedule instructions`/);
    expect(staleBuildWarning(checkBuildFreshness({ appRoot: makeApp() }))).toMatch(/has no build stamp/);
  });

  it('the test-only override is refused outside the test runner', () => {
    expect(() => setRunningBuildForTests(null, {})).toThrow(/only available under the test runner/);
  });
});

describe('a packaged install (compiled, no src/) is never told to run `npm run build` (C1-03)', () => {
  afterEach(() => setRunningBuildForTests(undefined));

  function packagedUnstamped(): BuildFreshness {
    const root = makeApp();
    rmSync(path.join(root, 'src'), { recursive: true });
    return checkBuildFreshness({ appRoot: root });
  }

  it('buildRepairSteps: rebuild when the sources exist, reinstall or upgrade otherwise', () => {
    const packaged = packagedUnstamped();
    expect(packaged).toMatchObject({ state: 'unstamped', hasSources: false });
    expect(buildRepairSteps(packaged)).toBe(REINSTALL_STEPS);
    expect(REINSTALL_STEPS).toMatch(/reinstall or upgrade the seo-agent package/);
    expect(REINSTALL_STEPS).not.toContain('npm run build');
    const checkout = checkBuildFreshness({ appRoot: makeApp() });
    expect(checkout.hasSources).toBe(true);
    expect(buildRepairSteps(checkout)).toBe(REBUILD_STEPS);
    // A hand-built value without hasSources falls back to looking for <appRoot>/src.
    const { hasSources: _drop, ...legacy } = packaged;
    expect(buildRepairSteps(legacy)).toBe(REINSTALL_STEPS);
    expect(buildRepairSteps(null)).toBe(REBUILD_STEPS);
    expect(staleBuildWarning(packaged)).toMatch(/has no build stamp.*reinstall or upgrade the seo-agent package/);
    // The reason may say how the build was (not) made; the advice never tells a packaged install to rebuild.
    expect(staleBuildWarning(packaged)).not.toContain(REBUILD_STEPS);
    expect(staleBuildWarning(packaged)).not.toMatch(/Run `npm run build`/);
  });

  it('migrate() refuses on a fresh workspace with a MIGRATION_FAILED hint to reinstall or upgrade, not to run `npm run build`', () => {
    const file = path.join(tempDir('seo-agent-packaged-'), 'fresh.sqlite');
    setRunningBuildForTests(packagedUnstamped());
    expect(runningBuildMigrationGuard()).toMatchObject({ known: [], hint: REINSTALL_STEPS });
    const db = openDatabase(file);
    try {
      let caught: unknown;
      try {
        migrate(db);
      } catch (err) {
        caught = err;
      }
      expect(caught).toMatchObject({ code: 'MIGRATION_FAILED', message: expect.stringMatching(/has no build stamp.*No migration was applied/) });
      const hint = (caught as { hint?: string }).hint ?? '';
      expect(hint).toMatch(/no src\/ directory .* reinstall or upgrade the seo-agent package/);
      expect(hint).not.toContain('npm run build');
      expect(db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'schema_migrations'")).toBeUndefined();
    } finally {
      db.close();
    }
    // The same unstamped build WITH its sources (a checkout) is told to rebuild.
    setRunningBuildForTests(checkBuildFreshness({ appRoot: makeApp() }));
    expect(runningBuildMigrationGuard()?.hint).toBe(REBUILD_STEPS);
    // A guard without a hint (older callers) keeps the rebuild advice.
    const db2 = openDatabase(file);
    try {
      expect(() => migrate(db2, { buildGuard: { build: 'a synthetic build', known: [] } })).toThrow(expect.objectContaining({ hint: REBUILD_STEPS }));
    } finally {
      db2.close();
    }
  });
});

describe('doctor, `schedule run`, and `schedule instructions` name the repair that works for the install (R3-NF-R5)', () => {
  /** A stamped build whose migrations/ gained a file it does not know; `packaged` removes src/ (a packaged install or container image). */
  function staleBuild(packaged: boolean): { root: string; f: BuildFreshness } {
    const root = makeApp();
    script.writeBuildInfo(root, { git: false, now: NOW });
    write(path.join(root, 'migrations', '0003_new.sql'), 'CREATE TABLE c (id INTEGER);\n');
    if (packaged) rmSync(path.join(root, 'src'), { recursive: true });
    return { root, f: checkBuildFreshness({ appRoot: root }) };
  }
  const instructionsFor = (root: string) =>
    buildSchedulingInstructions({ siteId: 'example-site', workspaceRoot: '/srv/workspace.invalid', logsDir: '/srv/workspace.invalid/logs', invocation: resolveCliInvocation(root, '/opt/node/bin/node'), timezone: 'Europe/Tallinn', schedules: [] });

  it('a packaged install without src/ is told to reinstall or upgrade, never to run `npm run build`', () => {
    const { root, f } = staleBuild(true);
    expect(f).toMatchObject({ state: 'stale', hasSources: false, migrations: { added: ['0003_new.sql'] } });

    // doctor runtime.build: both the dist/ a scheduler would run and the build doctor itself runs from.
    for (const build of [{ running: null, dist: f }, { running: f, dist: f }]) {
      const c = buildFreshnessCheck(build);
      expect(c.nextStep).toBe(REINSTALL_STEPS);
      expect(`${c.detail} ${c.nextStep}`).not.toContain('npm run build');
    }

    // schedule run refuses the build with the reinstall hint.
    let refusal: unknown;
    try {
      assertScheduledRunBuild(f);
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toMatchObject({ code: 'CONFLICT', hint: REINSTALL_STEPS, message: expect.stringContaining('does not match migrations/') });
    expect((refusal as { hint: string }).hint).not.toContain('npm run build');

    // schedule instructions: the rejected dist/ carries the reinstall steps, and the warning prints them.
    const si = instructionsFor(root);
    const warning = si.warnings.find((w) => w.includes('was NOT used'))!;
    expect(warning).toContain(REINSTALL_STEPS);
    expect(warning).toMatch(/point at the TypeScript sources, which this installation does not have/);
    expect(renderInstructions(si)).not.toContain('npm run build');
  });

  it('a checkout (src/ present) keeps the rebuild steps everywhere', () => {
    const { root, f } = staleBuild(false);
    expect(f).toMatchObject({ state: 'stale', hasSources: true });
    expect(buildFreshnessCheck({ running: null, dist: f }).nextStep).toBe(REBUILD_STEPS);
    expect(() => assertScheduledRunBuild(f)).toThrow(expect.objectContaining({ code: 'CONFLICT', hint: REBUILD_STEPS }));
    const warning = instructionsFor(root).warnings.find((w) => w.includes('was NOT used'))!;
    expect(warning).toContain(REBUILD_STEPS);
    expect(warning).toMatch(/run the TypeScript sources through tsx instead/);
  });
});

describe('running from a compiled build (simulated with the test-only override)', () => {
  let ws: TestWorkspace | undefined;
  afterEach(() => {
    ws?.cleanup();
    ws = undefined;
  });

  function staleWithNewMigration(): BuildFreshness {
    const root = makeApp();
    script.writeBuildInfo(root, { git: false, now: NOW });
    write(path.join(root, 'migrations', '0003_new.sql'), 'CREATE TABLE c (id INTEGER);\n');
    return checkBuildFreshness({ appRoot: root });
  }

  it('`schedule run --once` refuses to start before opening the workspace database', async () => {
    ws = makeWorkspace();
    setRunningBuildForTests(staleWithNewMigration());
    const r = await runCli(ws, ['schedule', 'run', '--once']);
    expect(r.exitCode).toBe(1);
    expect(r.err).toMatch(/Error \[CONFLICT\]: schedule run refused to start: the compiled build in .* does not match migrations\/.*0003_new\.sql.*Nothing was enqueued or run/);
    expect(r.err).toMatch(/Next step: Run `npm run build`, then re-run `npm run cli -- schedule instructions`/);
    expect(existsSync(ws.paths.dbFile)).toBe(false);
  });

  it('migrate() applies only migrations the build was stamped with; an unstamped build applies none', () => {
    const dir = tempDir('seo-agent-guard-');
    const real = loadMigrations();
    const file = path.join(dir, 'guard.sqlite');

    // Unstamped compiled build: every pending migration is refused, and nothing is written.
    setRunningBuildForTests(checkBuildFreshness({ appRoot: makeApp() }));
    expect(runningBuildMigrationGuard()).toMatchObject({ known: [] });
    let db = openDatabase(file);
    try {
      expect(() => migrate(db)).toThrow(expect.objectContaining({ code: 'MIGRATION_FAILED', message: expect.stringMatching(/has no build stamp.*No migration was applied/), hint: expect.stringContaining('npm run build') }));
      expect(db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'schema_migrations'")).toBeUndefined();
    } finally {
      db.close();
    }

    // A stamp that knows all but the newest migration: only that one is named, nothing is applied.
    const newest = real[real.length - 1]!;
    const guardedInfo = { ...checkBuildFreshness({ appRoot: makeApp() }) };
    setRunningBuildForTests({
      ...guardedInfo,
      state: 'stale',
      info: { schema: 1, name: 'seo-agent', version: '0.0.0-synthetic', builtAt: NOW.toISOString(), gitRevision: null, gitDirty: null, srcHash: 'x', srcFiles: 0, migrations: real.slice(0, -1).map((m) => m.file) },
    });
    db = openDatabase(file);
    try {
      expect(() => migrate(db)).toThrow(new RegExp(`Refusing to apply 1 pending migration\\(s\\) .*: ${newest.name}\\.`));
      expect(db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'schema_migrations'")).toBeUndefined();
    } finally {
      db.close();
    }

    // Running from the sources: no restriction.
    setRunningBuildForTests(null);
    expect(runningBuildMigrationGuard()).toBeNull();
    db = openDatabase(file);
    try {
      expect(migrate(db).applied).toHaveLength(real.length);
    } finally {
      db.close();
    }
  });
});
