import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgram, getCommandLoadErrors, installSqliteWarningFilter, isEntryPoint, isSqliteExperimentalWarning } from '../../../src/cli/main.js';
import { CliRuntime } from '../../../src/cli/runtime.js';
import { appRoot } from '../../../src/config/paths.js';

const FOUNDATION_MODULES = ['workspace.ts', 'config.ts', 'costs.ts', 'backup.ts', 'db.ts'];
const quietRuntime = () => new CliRuntime({ out: () => undefined, err: () => undefined }, {});

describe('command discovery', () => {
  it('registers the foundation commands from src/cli/commands automatically', async () => {
    const program = await buildProgram(quietRuntime());
    const names = program.commands.map((c) => c.name());
    for (const n of ['init', 'workspace', 'config', 'costs', 'backup', 'restore', 'db']) expect(names).toContain(n);
    const config = program.commands.find((c) => c.name() === 'config')!;
    // At least these (other areas may add config subcommands, e.g. `config migrate`).
    expect(config.commands.map((c) => c.name()).sort()).toEqual(expect.arrayContaining(['docs', 'schema', 'show', 'validate']));
    const db = program.commands.find((c) => c.name() === 'db')!;
    expect(db.commands.map((c) => c.name()).sort()).toEqual(['migrate', 'status']);
    // Foundation modules always load; a broken module elsewhere is reported, not fatal.
    expect(getCommandLoadErrors(program).filter((e) => FOUNDATION_MODULES.includes(e.module))).toEqual([]);
  });

  it('exposes the global options on every command', async () => {
    const program = await buildProgram(quietRuntime());
    const flags = program.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--workspace', '--site', '--dry-run', '--json', '--mode', '--offline']));
  });
});

/** Spec section 29: the required commands (`npm run cli -- <command>`). Kept here because specs/ is private. */
const SPEC_29_COMMANDS = [
  'setup',
  'doctor',
  'demo',
  'auth google',
  'auth status',
  'sync gsc',
  'sync ga4',
  'crawl',
  'baseline',
  'weekly',
  'monthly',
  'research keyword',
  'analyze page',
  'apify inspect',
  'apify test',
  'content discover',
  'content brief',
  'content draft',
  'content review',
  'experiments list',
  'experiments review',
  'experiments mark-implemented',
  'approvals list',
  'approvals approve',
  'approvals reject',
  'memory sync',
  'memory search',
  'memory rebuild',
  'costs',
  'jobs list',
  'jobs resume',
  'export',
  'backup',
  'restore',
] as const;

function resolveCommand(program: Command, path: string): Command | undefined {
  let cur: Command | undefined = program;
  for (const name of path.split(' ')) cur = cur?.commands.find((c) => c.name() === name || c.aliases().includes(name));
  return cur;
}

describe('spec section 29 command list', () => {
  it('lists all 34 required commands', () => {
    expect(SPEC_29_COMMANDS).toHaveLength(34);
    expect(new Set(SPEC_29_COMMANDS).size).toBe(34);
  });

  it.each(SPEC_29_COMMANDS)('`%s` resolves in buildProgram() and has an action', async (name) => {
    const program = await buildProgram(quietRuntime());
    const cmd = resolveCommand(program, name);
    expect(cmd, `${name} is not registered`).toBeDefined();
    expect((cmd as unknown as { _actionHandler: unknown })._actionHandler, `${name} has no action`).toBeTypeOf('function');
  });

  it('every spec command accepts the global --site, --dry-run, and --json options', async () => {
    const program = await buildProgram(quietRuntime());
    const globals = program.options.map((o) => o.long);
    for (const flag of ['--site', '--dry-run', '--json']) expect(globals).toContain(flag);
    // Global options are defined on the root program, so every subcommand inherits them (optsWithGlobals).
    for (const name of SPEC_29_COMMANDS) {
      const own = resolveCommand(program, name)!.options.map((o) => o.long);
      for (const flag of ['--site', '--dry-run', '--json']) expect(own, `${name} redefines ${flag}`).not.toContain(flag);
    }
  });
});

describe('subcommand help', () => {
  it('`sync gsc --help` lists the global --dry-run and --json options (showGlobalOptions)', async () => {
    const program = await buildProgram(quietRuntime());
    const help = resolveCommand(program, 'sync gsc')!.helpInformation();
    expect(help).toMatch(/Global Options:/);
    expect(help).toMatch(/--dry-run/);
    expect(help).toMatch(/--json/);
    expect(help).toMatch(/--site <id>/);
    expect(resolveCommand(program, 'export')!.helpInformation()).toMatch(/--dry-run/);
  });

  it('prints the global options for `sync gsc --help` from the real entry point', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'sync', 'gsc', '--help'], { cwd: appRoot(), encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: seo-agent sync gsc');
    expect(r.stdout).toMatch(/--dry-run/);
    expect(r.stdout).toMatch(/--json/);
  });
});

describe('node:sqlite ExperimentalWarning filter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('matches only the SQLite ExperimentalWarning', () => {
    const msg = 'SQLite is an experimental feature and might change at any time';
    expect(isSqliteExperimentalWarning(msg, 'ExperimentalWarning')).toBe(true);
    expect(isSqliteExperimentalWarning(msg, { type: 'ExperimentalWarning' })).toBe(true);
    expect(isSqliteExperimentalWarning(Object.assign(new Error(msg), { name: 'ExperimentalWarning' }))).toBe(true);
    expect(isSqliteExperimentalWarning(msg, 'DeprecationWarning')).toBe(false);
    expect(isSqliteExperimentalWarning('The Fetch API is an experimental feature', 'ExperimentalWarning')).toBe(false);
    expect(isSqliteExperimentalWarning(msg)).toBe(false);
  });

  it('drops only that warning and passes every other warning through unchanged (idempotent install)', () => {
    const calls: unknown[][] = [];
    const fake = { emitWarning: (...args: unknown[]) => void calls.push(args) } as unknown as NodeJS.Process;
    installSqliteWarningFilter(fake);
    const wrapped = fake.emitWarning;
    installSqliteWarningFilter(fake);
    expect(fake.emitWarning).toBe(wrapped);
    fake.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
    fake.emitWarning('SQLite is an experimental feature', { type: 'ExperimentalWarning', code: 'X' });
    fake.emitWarning('Something else is experimental', 'ExperimentalWarning');
    fake.emitWarning('old api', 'DeprecationWarning', 'DEP0001');
    expect(calls).toEqual([
      ['Something else is experimental', 'ExperimentalWarning'],
      ['old api', 'DeprecationWarning', 'DEP0001'],
    ]);
  });

  it('keeps the real process warnings flowing in a child process', () => {
    const script = [
      "await import('./src/cli/main.ts');",
      "process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');",
      "process.emitWarning('synthetic-other-warning', 'ExperimentalWarning');",
    ].join('\n');
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: appRoot(), encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('synthetic-other-warning');
    expect(r.stderr).not.toContain('SQLite is an experimental feature');
  });
});

describe('entry point detection', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('treats a symlinked bin (npm install) as the entry point', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-bin-'));
    dirs.push(dir);
    const real = path.join(dir, 'main.js');
    writeFileSync(real, '');
    const link = path.join(dir, 'seo-agent');
    symlinkSync(real, link);
    expect(isEntryPoint(link, real)).toBe(true);
    expect(isEntryPoint(real, real)).toBe(true);
    expect(isEntryPoint(path.join(dir, 'other.js'), real)).toBe(false);
    expect(isEntryPoint(undefined, real)).toBe(false);
  });
});

describe('`npm run cli -- --help` output', () => {
  it('prints usage on stdout with no ExperimentalWarning noise', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', '--help'], { cwd: appRoot(), encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: seo-agent');
    for (const n of ['init', 'costs', 'backup', 'restore', 'config']) expect(r.stdout).toMatch(new RegExp(`\\n  ${n}\\b`));
    expect(r.stderr).not.toMatch(/ExperimentalWarning|SQLite is an experimental/);
  });
});
