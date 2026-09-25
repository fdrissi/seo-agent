/**
 * Generate the command reference of docs/CLI.md from the registered command
 * tree (`buildProgram()` in src/cli/main.ts), so the option tables never drift
 * from the code. Read-only: it builds the commander tree (no command action
 * runs, nothing touches a workspace, the network, or money) and prints
 * Markdown to standard output.
 *
 * Usage (from the repository root):
 *   npx tsx scripts/cli-reference.ts                 full reference, grouped in the docs/CLI.md sections
 *   npx tsx scripts/cli-reference.ts setup memory    only these top-level commands (no section headings)
 *   npx tsx scripts/cli-reference.ts --site-lock     the commands that refuse with LOCKED while a job
 *                                                    holds the site lock (for the "Site lock" paragraph)
 *
 * Each command gets: a heading (### for a top-level command, #### for a
 * subcommand), its description, its subcommand list, the usage line, and a
 * table of its own options with default values as registered and required
 * options marked. `setup` also gets the wizard step ids and step groups that
 * `setup --only` accepts (the same list as `setup --list-steps`).
 */
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command, Option } from 'commander';
import { buildProgram } from '../src/cli/main.js';
import { CONDITIONALLY_MUTATING_COMMANDS, CliRuntime, MUTATING_COMMANDS, commandPathOf } from '../src/cli/runtime.js';
import { listWizardStepGroups, listWizardSteps } from '../src/setup/wizard.js';

/** The reference sections of docs/CLI.md and the top-level commands each one documents, in page order. */
export const CLI_REFERENCE_SECTIONS: ReadonlyArray<{ title: string; commands: readonly string[] }> = [
  { title: 'Getting started and workspace', commands: ['demo', 'init', 'workspace', 'setup', 'doctor', 'config', 'db'] },
  { title: 'Google access and ingestion', commands: ['auth', 'sync'] },
  { title: 'Crawling and performance', commands: ['crawl', 'perf'] },
  { title: 'Pipelines (durable jobs)', commands: ['baseline', 'weekly', 'monthly'] },
  { title: 'Pages, analysis, and research', commands: ['analyze', 'pages', 'research', 'apify', 'models'] },
  { title: 'Content pipeline', commands: ['content'] },
  { title: 'Memory and vault', commands: ['memory', 'vault'] },
  { title: 'Experiments, approvals, and export', commands: ['experiments', 'approvals', 'export'] },
  { title: 'Reports, data exchange, and costs', commands: ['report', 'data', 'ai-citations', 'costs'] },
  { title: 'Jobs and scheduling', commands: ['jobs', 'schedule'] },
  { title: 'Backup, restore, and diagnostics', commands: ['backup', 'restore', 'diagnostics'] },
];

const GENERATED_MARK = '<!-- generated reference: see "How this reference is maintained" -->';

/**
 * Replace this machine's temporary and home directories (some option
 * descriptions compute a default path at registration) with placeholders, so
 * the generated page never carries a local path.
 */
export function withoutLocalPaths(text: string): string {
  const swap = (t: string, dir: string, label: string): string => {
    if (!dir || dir === path.sep) return t;
    const variants = new Set([dir]);
    try {
      variants.add(realpathSync(dir));
    } catch {
      /* not resolvable: the literal path only */
    }
    let out = t;
    for (const v of [...variants].sort((a, b) => b.length - a.length)) out = out.split(v).join(label);
    return out;
  };
  return swap(swap(text, os.tmpdir(), '<os tmpdir>'), os.homedir(), '~');
}

/** Escape a table cell (a `|` would end the cell). */
function cell(text: string): string {
  return withoutLocalPaths(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function hasAction(cmd: Command): boolean {
  // commander keeps the action in a private field; a group without one prints its help.
  return typeof (cmd as unknown as { _actionHandler?: unknown })._actionHandler === 'function';
}

function visibleOptions(cmd: Command): Option[] {
  return cmd.options.filter((o) => !(o as Option & { hidden?: boolean }).hidden);
}

/** "[options] <url>": the options marker when the command has options of its own, then its arguments. */
export function usageLine(cmd: Command): string {
  const args = cmd.registeredArguments.map((a) => {
    const name = `${a.name()}${a.variadic ? '...' : ''}`;
    return a.required ? `<${name}>` : `[${name}]`;
  });
  return [visibleOptions(cmd).length ? '[options]' : '', ...args].filter(Boolean).join(' ');
}

/** The option's meaning: its description, the registered default (not for --no-* flags), and "(required)". */
export function optionMeaning(o: Option): string {
  const parts = [o.description];
  const d: unknown = o.defaultValue;
  const shown = d === undefined || d === null || d === false || o.negate ? null : Array.isArray(d) ? (d.length ? d.join(',') : null) : String(d);
  if (shown !== null && shown !== '') parts.push(`(default: \`${shown}\`)`);
  if (o.mandatory) parts.push('(required)');
  return parts.filter(Boolean).join(' ');
}

/** The option table (or the no-options line) of one command. */
export function optionTable(cmd: Command): string[] {
  const opts = visibleOptions(cmd);
  if (!opts.length) return ['No command-specific options (global options apply).'];
  return ['| Option | Meaning |', '| --- | --- |', ...opts.map((o) => `| \`${o.flags}\` | ${cell(optionMeaning(o))} |`)];
}

/** Step ids and groups accepted by `setup --only` (the `setup --list-steps` list). */
export function setupStepTables(): string[] {
  const steps = listWizardSteps();
  const groups = listWizardStepGroups();
  return [
    '`--only` accepts these wizard step ids and step groups (comma-separated; a group asks every step in it). `setup --list-steps` prints the same list.',
    '',
    '| Step id | Section | Site config fields |',
    '| --- | --- | --- |',
    ...steps.map((s) => `| \`${s.id}\` | ${cell(s.section)} | ${s.paths.length ? s.paths.map((p) => `\`${p}\``).join(', ') : ''} |`),
    '',
    '| Step group | Steps |',
    '| --- | --- |',
    ...groups.map((g) => `| \`${g.group}\` | ${g.stepIds.map((id) => `\`${id}\``).join(', ')} |`),
  ];
}

/** Reference Markdown of one command and (recursively) its subcommands. */
export function renderCommand(cmd: Command): string[] {
  const p = commandPathOf(cmd);
  const depth = p.split(' ').length;
  const out: string[] = [`${depth === 1 ? '###' : '####'} \`${p}\``, ''];
  if (cmd.description()) out.push(withoutLocalPaths(cmd.description()), '');
  if (cmd.commands.length) out.push(`Subcommands: ${cmd.commands.map((c) => `\`${c.name()}\``).join(', ')}.`, '');
  if (hasAction(cmd)) {
    const usage = usageLine(cmd);
    out.push('```sh', `npm run cli -- ${p}${usage ? ` ${usage}` : ''}`, '```', '', ...optionTable(cmd), '');
    if (p === 'setup') out.push(...setupStepTables(), '');
  }
  for (const sub of cmd.commands) out.push(...renderCommand(sub));
  return out;
}

export interface CliReferenceOptions {
  /** Only these top-level commands, without section headings. Default: the full reference in sections. */
  only?: readonly string[];
}

/** The generated reference (Markdown). Commands missing from CLI_REFERENCE_SECTIONS end up in a final "Other commands" section. */
export function renderCliReference(program: Command, opts: CliReferenceOptions = {}): string {
  const byName = new Map(program.commands.map((c) => [c.name(), c]));
  const lines: string[] = [];
  if (opts.only?.length) {
    for (const name of opts.only) {
      const c = byName.get(name);
      if (!c) throw new Error(`"${name}" is not a registered top-level command`);
      lines.push(...renderCommand(c));
    }
    return `${lines.join('\n').trimEnd()}\n`;
  }
  const sections = [...CLI_REFERENCE_SECTIONS.map((s) => ({ title: s.title, commands: [...s.commands] }))];
  const other = program.commands.map((c) => c.name()).filter((n) => !CLI_REFERENCE_SECTIONS.some((s) => s.commands.includes(n)));
  if (other.length) sections.push({ title: 'Other commands', commands: other });
  for (const s of sections) {
    const cmds = s.commands.map((n) => byName.get(n)).filter((c): c is Command => !!c);
    if (!cmds.length) continue;
    lines.push(`## ${s.title}`, '', GENERATED_MARK, '');
    for (const c of cmds) {
      lines.push(...renderCommand(c));
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * The option flags each command section of a CLI reference documents
 * (`### \`cmd\``/`#### \`cmd sub\`` headings; option-table rows whose
 * first cell is a flag). Used by tests/unit/cli/aliases.test.ts to compare
 * docs/CLI.md with the registered options.
 */
export function documentedOptionFlags(markdown: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    if (fenced) continue;
    if (/^#{1,6} /.test(line)) {
      current = /^#{3,4} `([^`]+)`\s*$/.exec(line)?.[1] ?? null;
      if (current && !out.has(current)) out.set(current, []);
      continue;
    }
    const row = current ? /^\| `(-[^`]+)` \|/.exec(line) : null;
    if (row) out.get(current!)!.push(row[1]!);
  }
  return out;
}

/** The registered option flags of every command, keyed by command path. */
export function registeredOptionFlags(program: Command): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (c: Command) => {
    for (const sub of c.commands) {
      out.set(commandPathOf(sub), visibleOptions(sub).map((o) => o.flags));
      walk(sub);
    }
  };
  walk(program);
  return out;
}

/** The registered commands that take the per-site lease, as the "Site lock" paragraph of docs/CLI.md lists them. */
export function siteLockCommands(program: Command): { always: string[]; conditional: Array<{ command: string; flags: string }> } {
  const registered = new Set<string>();
  const walk = (c: Command) => {
    for (const sub of c.commands) {
      registered.add(commandPathOf(sub));
      walk(sub);
    }
  };
  walk(program);
  return {
    always: [...MUTATING_COMMANDS].filter((c) => registered.has(c)),
    conditional: [...CONDITIONALLY_MUTATING_COMMANDS].filter(([c]) => registered.has(c)).map(([command, v]) => ({ command, flags: v.flags })),
  };
}

function sentenceList(items: string[]): string {
  const q = items.map((i) => `\`${i}\``);
  return q.length <= 1 ? q.join('') : `${q.slice(0, -1).join(', ')}, and ${q[q.length - 1]}`;
}

export async function buildReferenceProgram(): Promise<{ program: Command; loadErrors: string[] }> {
  const loadErrors: string[] = [];
  const runtime = new CliRuntime({ out: () => undefined, err: (t) => void loadErrors.push(t) }, {});
  const program = await buildProgram(runtime);
  return { program, loadErrors };
}

async function main(argv: string[]): Promise<void> {
  const { program, loadErrors } = await buildReferenceProgram();
  for (const e of loadErrors) process.stderr.write(`${e}\n`);
  if (loadErrors.length) process.exitCode = 1;
  if (argv.includes('--site-lock')) {
    const s = siteLockCommands(program);
    process.stdout.write(`Always (MUTATING_COMMANDS): ${sentenceList(s.always)}.\n`);
    for (const c of s.conditional) process.stdout.write(`With ${c.flags} (CONDITIONALLY_MUTATING_COMMANDS): \`${c.command}\`.\n`);
    return;
  }
  const only = argv.filter((a) => !a.startsWith('-'));
  process.stdout.write(renderCliReference(program, only.length ? { only } : {}));
}

function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(path.resolve(argv1)) === realpathSync(self);
  } catch {
    return path.resolve(argv1) === self;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
