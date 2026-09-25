import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CommanderError, type Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram, getCommandLoadErrors } from '../../../src/cli/main.js';
import { CliRuntime } from '../../../src/cli/runtime.js';
import { appRoot } from '../../../src/config/paths.js';
import { documentedOptionFlags, registeredOptionFlags } from '../../../scripts/cli-reference.js';

/**
 * Spec section 29: "Provide convenience npm aliases for common commands and
 * test them." Every alias must resolve to a command this build registers.
 * The test only builds the command tree and asks commander for `--help`; no
 * command action runs, so nothing touches the network, a workspace, or money.
 */

const CLI_ENTRY = 'tsx src/cli/main.ts';

/** Aliases the README and docs/CLI.md promise. Keys are package.json script names. */
const REQUIRED_ALIASES = [
  'demo',
  'doctor',
  'setup',
  'baseline',
  'weekly',
  'monthly',
  'costs',
  'sync:gsc',
  'sync:ga4',
  'crawl',
  'memory:sync',
  'memory:search',
  'jobs',
  'approvals',
  'export',
  'backup',
] as const;

/** Flags that authorize spending, raise the runtime mode, or skip safety checks. An alias must never carry them. */
const FORBIDDEN_FLAGS = ['--allow-spend', '--confirm-spend', '--allow-paid', '--max-usd', '--approve-cost-plan', '--mode', '--rerun-paid-stages', '--confirm', '--force', '--use-model', '--network'];

const pkg = JSON.parse(readFileSync(path.join(appRoot(), 'package.json'), 'utf8')) as { scripts: Record<string, string> };
const cliDoc = readFileSync(path.join(appRoot(), 'docs', 'CLI.md'), 'utf8');

/** Scripts that invoke the CLI entry point (excluding the generic `cli` passthrough). */
const cliScripts = Object.entries(pkg.scripts).filter(([name, cmd]) => name !== 'cli' && (cmd === CLI_ENTRY || cmd.startsWith(`${CLI_ENTRY} `)));

function argvOf(script: string): string[] {
  const cmd = pkg.scripts[script] ?? '';
  return cmd.slice(CLI_ENTRY.length).trim().split(/\s+/).filter(Boolean);
}

type Resolution = { ok: true; command: Command; path: string[] } | { ok: false; reason: string };

/** Walk the registered command tree along the alias words (subcommands only; aliases carry no arguments). */
function resolve(program: Command, words: string[]): Resolution {
  let current = program;
  const walked: string[] = [];
  for (const word of words) {
    const next = current.commands.find((c) => c.name() === word || c.aliases().includes(word));
    if (!next) return { ok: false, reason: `"${[...walked, word].join(' ')}" is not a registered command` };
    current = next;
    walked.push(next.name());
  }
  if (walked.length === 0) return { ok: false, reason: 'the script names no command' };
  return { ok: true, command: current, path: walked };
}

/** True when running the command does something (an action), rather than only printing its subcommand list. */
function isRunnable(cmd: Command): boolean {
  // commander keeps the action in a private field; a group without one prints help and exits 1.
  return typeof (cmd as unknown as { _actionHandler?: unknown })._actionHandler === 'function';
}

function forEachCommand(cmd: Command, fn: (c: Command) => void): void {
  fn(cmd);
  for (const sub of cmd.commands) forEachCommand(sub, fn);
}

let program: Command;
let output: string[];
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  fetchSpy = vi.fn(async () => {
    throw new Error('network access is not allowed in the alias test');
  });
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  output = [];
  program = await buildProgram(new CliRuntime({ out: (t) => void output.push(t), err: (t) => void output.push(t) }, {}));
  // Never let commander call process.exit, and capture help text from every level.
  forEachCommand(program, (c) => {
    c.exitOverride();
    c.configureOutput({ writeOut: (s) => void output.push(s), writeErr: (s) => void output.push(s) });
  });
});

afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
});

describe('npm convenience aliases (package.json scripts)', () => {
  it('the generic `cli` script and every alias use the same entry point', () => {
    expect(pkg.scripts.cli).toBe(CLI_ENTRY);
    for (const alias of REQUIRED_ALIASES) {
      expect(pkg.scripts[alias], `package.json is missing the "${alias}" script`).toBeDefined();
      expect(pkg.scripts[alias]!.startsWith(`${CLI_ENTRY} `), `"${alias}" must run ${CLI_ENTRY}`).toBe(true);
    }
  });

  it.each(REQUIRED_ALIASES.map((a) => [a]))('`npm run %s` maps to a registered, runnable command named after it', (alias) => {
    const words = argvOf(alias);
    const r = resolve(program, words);
    const loadErrors = getCommandLoadErrors(program).map((e) => `${e.module}: ${e.message}`);
    expect(r.ok, r.ok ? '' : `${alias}: ${r.reason}; command modules that failed to load: ${loadErrors.join('; ') || 'none'}`).toBe(true);
    if (!r.ok) return;
    // "sync:gsc" -> sync gsc, "jobs" -> jobs list: the alias name is the start of the command path.
    expect(r.path.slice(0, alias.split(':').length)).toEqual(alias.split(':'));
    expect(isRunnable(r.command), `${alias} -> "${r.path.join(' ')}" only prints a subcommand list`).toBe(true);
  });

  it('every script that invokes the CLI (including ones not listed above) resolves to a registered command', () => {
    expect(cliScripts.length).toBeGreaterThanOrEqual(REQUIRED_ALIASES.length);
    for (const [name] of cliScripts) {
      const r = resolve(program, argvOf(name));
      expect(r.ok, r.ok ? '' : `package.json script "${name}": ${r.reason}`).toBe(true);
    }
  });

  it('aliases carry no flags: spending, mode changes, and overrides are always typed explicitly', () => {
    for (const [name] of cliScripts) {
      const words = argvOf(name);
      expect(words.filter((w) => w.startsWith('-')), `package.json script "${name}" must not embed options`).toEqual([]);
      for (const flag of FORBIDDEN_FLAGS) expect(words).not.toContain(flag);
    }
  });

  it.each(REQUIRED_ALIASES.map((a) => [a]))('commander resolves `npm run %s -- --help` to that command without running it', async (alias) => {
    const words = argvOf(alias);
    let thrown: unknown;
    try {
      await program.parseAsync(['node', 'seo-agent', ...words, '--help']);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CommanderError);
    expect((thrown as CommanderError).code).toBe('commander.helpDisplayed');
    expect(output.join('\n')).toContain(`Usage: seo-agent ${words.join(' ')}`);
  });

  it('every CLI alias is documented in docs/CLI.md', () => {
    for (const [name] of cliScripts) {
      expect(cliDoc, `docs/CLI.md does not mention \`npm run ${name}\``).toContain(`npm run ${name}`);
    }
  });
});

describe('docs/CLI.md covers the registered commands', () => {
  it('has a reference heading for every registered command and subcommand', () => {
    const headings = new Set(
      cliDoc
        .split('\n')
        .map((line) => /^#{2,6} `([^`]+)`\s*$/.exec(line)?.[1])
        .filter((h): h is string => !!h),
    );
    const missing: string[] = [];
    const walk = (cmd: Command, prefix: string[]) => {
      for (const sub of cmd.commands) {
        const name = [...prefix, sub.name()];
        if (!headings.has(name.join(' '))) missing.push(name.join(' '));
        walk(sub, name);
      }
    };
    walk(program, []);
    expect(missing, 'commands missing from docs/CLI.md').toEqual([]);
  });

  it('documents no command that this build does not register', () => {
    const registered = new Set<string>();
    const walk = (cmd: Command, prefix: string[]) => {
      for (const sub of cmd.commands) {
        const name = [...prefix, sub.name()];
        registered.add(name.join(' '));
        walk(sub, name);
      }
    };
    walk(program, []);
    const documented = cliDoc
      .split('\n')
      .map((line) => /^#{3,6} `([^`]+)`\s*$/.exec(line)?.[1])
      .filter((h): h is string => !!h);
    expect(documented.filter((h) => !registered.has(h)), 'documented commands that do not exist').toEqual([]);
  });
});

/**
 * B1-08: the option tables of docs/CLI.md are generated from the command tree
 * (`npx tsx scripts/cli-reference.ts`), so the flags each documented command
 * lists must be exactly the flags it registers. This test depends on
 * docs/CLI.md being regenerated from that script whenever an option changes.
 */
describe('docs/CLI.md option tables match the registered options', () => {
  it('lists exactly the registered option flags of every documented command', () => {
    const documented = documentedOptionFlags(cliDoc);
    const registered = registeredOptionFlags(program);
    const mismatches: string[] = [];
    for (const [cmd, flags] of documented) {
      const actual = registered.get(cmd);
      if (!actual) continue; // an unregistered heading is reported by the test above
      const missing = actual.filter((f) => !flags.includes(f));
      const extra = flags.filter((f) => !actual.includes(f));
      if (missing.length || extra.length) mismatches.push(`${cmd}: ${missing.length ? `undocumented ${missing.join(', ')}` : ''}${missing.length && extra.length ? '; ' : ''}${extra.length ? `not registered ${extra.join(', ')}` : ''}`);
    }
    expect(mismatches, 'regenerate the reference with `npx tsx scripts/cli-reference.ts`').toEqual([]);
  });
});
