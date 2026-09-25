#!/usr/bin/env node
import { readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { appVersion } from '../config/paths.js';
// A leaf module (node built-ins only): safe to import before the warning filter.
import { runningBuildFreshness, staleBuildWarning, type BuildFreshness } from '../setup/build-info.js';
// A leaf module (no imports): terminal-safe text for the last-resort error line.
import { forTerminal } from '../core/terminal.js';
// Type-only: runtime.js loads node:sqlite (via the app context), so it is
// imported dynamically AFTER the warning filter below is installed.
import type { CliRuntime, CommandModule } from './runtime.js';

/**
 * Entry point: `npm run cli -- <command>`.
 * Command modules are discovered from ./commands so each area registers its
 * own commands without editing a shared registry.
 */

// ---------------------------------------------------------------------------
// Node's `node:sqlite` emits "ExperimentalWarning: SQLite is an experimental
// feature" on Node 24 (the module is used deliberately; see docs/ARCHITECTURE.md).
// Hide exactly that one warning for CLI users; every other warning, including
// other ExperimentalWarnings, is passed through unchanged.
// ---------------------------------------------------------------------------

const SQLITE_EXPERIMENTAL = /\bSQLite is an experimental feature\b/i;

/** True only for Node's SQLite ExperimentalWarning. */
export function isSqliteExperimentalWarning(warning: unknown, typeOrOptions?: unknown): boolean {
  const message = typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : '';
  let type: string | undefined;
  if (typeof typeOrOptions === 'string') type = typeOrOptions;
  else if (typeOrOptions && typeof typeOrOptions === 'object' && typeof (typeOrOptions as { type?: unknown }).type === 'string') type = (typeOrOptions as { type: string }).type;
  else if (warning instanceof Error) type = warning.name;
  return type === 'ExperimentalWarning' && SQLITE_EXPERIMENTAL.test(message);
}

const FILTER_MARK = Symbol.for('seo-agent.sqliteWarningFilter');

/** Idempotently wrap `process.emitWarning` to drop only the SQLite ExperimentalWarning. */
export function installSqliteWarningFilter(proc: NodeJS.Process = process): void {
  const current = proc.emitWarning as typeof proc.emitWarning & { [FILTER_MARK]?: true };
  if (current[FILTER_MARK]) return;
  const original = proc.emitWarning;
  const filtered = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    if (isSqliteExperimentalWarning(warning, rest[0])) return;
    return (original as (...args: unknown[]) => void).call(proc, warning, ...rest);
  } as typeof proc.emitWarning & { [FILTER_MARK]?: true };
  filtered[FILTER_MARK] = true;
  proc.emitWarning = filtered;
}

installSqliteWarningFilter();

export interface CommandLoadError {
  module: string;
  stage: 'import' | 'register';
  message: string;
}

const loadErrors = new WeakMap<Command, CommandLoadError[]>();

/** Command modules that failed to import or register while building `program`. */
export function getCommandLoadErrors(program: Command): CommandLoadError[] {
  return loadErrors.get(program) ?? [];
}

export async function buildProgram(cli?: CliRuntime): Promise<Command> {
  const runtime = cli ?? new (await import('./runtime.js')).CliRuntime();
  const program = new Command();
  program
    .name('seo-agent')
    .description('Self-hosted SEO, AEO, and content intelligence agent. Evidence first; humans approve production changes.')
    .version(appVersion())
    .option('-w, --workspace <dir>', 'private workspace directory (default: $SEO_AGENT_WORKSPACE or ~/seo-agent-workspace)')
    .option('-s, --site <id>', 'site id (optional when the workspace has exactly one site)')
    .option('--dry-run', 'show what would happen without external requests, spending, or writes where supported')
    .option('--json', 'machine-readable JSON output')
    .option('--mode <mode>', 'runtime mode: ANALYZE (default), RESEARCH, DRAFT, EXECUTE')
    .option('--offline', 'forbid all network requests for this invocation')
    .showHelpAfterError()
    // Subcommand help lists the global options (--site, --dry-run, --json, --mode, --offline) too.
    // Set before any command is registered: subcommands inherit the help configuration when created.
    .configureHelp({ showGlobalOptions: true })
    .configureOutput({ writeErr: (s) => runtime.io.err(s.trimEnd()), writeOut: (s) => runtime.io.out(s.trimEnd()) });
  // Tag the command about to run, so the runtime can apply command-level policy centrally
  // (e.g. manual commands that change data hold the per-site lease while they run, and refuse while a job
  // holds it; see MUTATING_COMMANDS).
  program.hook('preAction', (_hooked, actionCommand) => runtime.tagCommand(actionCommand));

  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.join(here, 'commands');
  const ext = path.extname(fileURLToPath(import.meta.url)); // .ts under tsx/vitest, .js when compiled
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(ext) && !f.endsWith(`.test${ext}`) && !f.endsWith(`.d.ts`))
    .sort();
  const errors: CommandLoadError[] = [];
  for (const f of files) {
    let mod: Partial<CommandModule>;
    try {
      mod = (await import(pathToFileURL(path.join(dir, f)).href)) as Partial<CommandModule>;
    } catch (err) {
      errors.push({ module: f, stage: 'import', message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (typeof mod.register !== 'function') continue;
    try {
      mod.register(program, runtime);
    } catch (err) {
      errors.push({ module: f, stage: 'register', message: err instanceof Error ? err.message : String(err) });
    }
  }
  loadErrors.set(program, errors);
  if (errors.length) {
    // One broken command area must not take down unrelated commands; say so honestly.
    const { redactString } = await import('../security/redact.js');
    runtime.io.err(
      `Warning: ${errors.length} command module(s) failed to load and are unavailable: ${errors
        .map((e) => `${e.module} (${e.stage}: ${redactString(e.message).split('\n')[0]})`)
        .join('; ')}`,
    );
  }
  return program;
}

/**
 * Print the stale-build warning when this process runs from a compiled build
 * whose stamp does not match the checked-out version, src/, or migrations/.
 * Returns the warning (null when there is none, including when running from sources).
 */
export function warnIfStaleBuild(err: (text: string) => void, freshness: BuildFreshness | null): string | null {
  const warning = staleBuildWarning(freshness);
  if (warning) err(warning);
  return warning;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const { CliExit, CliRuntime: Runtime } = await import('./runtime.js');
  // Central integration wiring: concrete services (LLM client with the approval gate, memory,
  // vault, SSRF-safe page fetcher, integration statuses, pipeline job handlers) for EVERY command.
  // Installed here, before any command runs; tests that call buildProgram() directly keep
  // injecting their own fakes (or call installWiring() themselves).
  (await import('../app/wiring.js')).installWiring();
  const cli = new Runtime();
  // Running from a compiled build (dist/) that is older than src/ or migrations/ (for example
  // after `git checkout <tag> && npm ci` without `npm run build`) runs old code: say so loudly.
  warnIfStaleBuild((t) => cli.io.err(t), runningBuildFreshness());
  const program = await buildProgram(cli);
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CliExit) return;
    cli.fail(err, argv.includes('--json'));
  } finally {
    // Safety net: a manual command never leaves its per-site lease held after the CLI is done.
    cli.releaseLeases();
  }
}

/**
 * True when this file is the process entry point. Compares real paths so the
 * npm-installed `seo-agent` bin (a symlink to dist/cli/main.js) also runs.
 */
export function isEntryPoint(argv1: string | undefined = process.argv[1], self: string = fileURLToPath(import.meta.url)): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(path.resolve(argv1)) === realpathSync(self);
  } catch {
    return path.resolve(argv1) === self;
  }
}

/**
 * The last-resort "Fatal:" line for an error that escaped main(): redacted and
 * terminal-safe (an error message can carry stored or fetched text; control,
 * bidi, and invisible characters become visible [U+XXXX] markers).
 */
export async function fatalLine(err: unknown): Promise<string> {
  const { redactString } = await import('../security/redact.js');
  return `Fatal: ${forTerminal(redactString(err instanceof Error ? err.message : String(err)))}\n`;
}

if (isEntryPoint()) {
  main().catch(async (err) => {
    const { CliExit } = await import('./runtime.js');
    if (!(err instanceof CliExit)) {
      process.stderr.write(await fatalLine(err));
      process.exitCode = 1;
    }
  });
}
