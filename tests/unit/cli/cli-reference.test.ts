import os from 'node:os';
import type { Command } from 'commander';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CLI_REFERENCE_SECTIONS,
  buildReferenceProgram,
  documentedOptionFlags,
  optionMeaning,
  registeredOptionFlags,
  renderCliReference,
  siteLockCommands,
  usageLine,
  withoutLocalPaths,
} from '../../../scripts/cli-reference.js';
import { commandPathOf } from '../../../src/cli/runtime.js';
import { listWizardStepGroups } from '../../../src/setup/wizard.js';

/**
 * B1-08: scripts/cli-reference.ts regenerates the docs/CLI.md reference from
 * the registered command tree. Building the tree runs no command action: no
 * workspace, network, or money is touched.
 */

let program: Command;
let reference: string;

beforeAll(async () => {
  const built = await buildReferenceProgram();
  expect(built.loadErrors).toEqual([]);
  program = built.program;
  reference = renderCliReference(program);
});

describe('scripts/cli-reference.ts', () => {
  it('has a heading for every registered command, in the docs/CLI.md sections', () => {
    const headings = new Set([...reference.matchAll(/^#{3,4} `([^`]+)`\s*$/gm)].map((m) => m[1]!));
    const all: string[] = [];
    const walk = (c: Command) => {
      for (const sub of c.commands) {
        all.push(commandPathOf(sub));
        walk(sub);
      }
    };
    walk(program);
    expect(all.filter((c) => !headings.has(c))).toEqual([]);
    for (const s of CLI_REFERENCE_SECTIONS) expect(reference).toContain(`## ${s.title}\n`);
    // A top-level command missing from the section map is still documented, in a final section.
    const unplaced = program.commands.map((c) => c.name()).filter((n) => !CLI_REFERENCE_SECTIONS.some((s) => s.commands.includes(n)));
    if (unplaced.length) expect(reference).toContain('## Other commands');
  });

  it('documents exactly the registered option flags (so a regenerated docs/CLI.md passes aliases.test.ts)', () => {
    const documented = documentedOptionFlags(reference);
    const registered = registeredOptionFlags(program);
    for (const [cmd, flags] of registered) {
      const cmdObj = cmd.split(' ').reduce<Command | undefined>((c, name) => c?.commands.find((x) => x.name() === name), program);
      const runnable = typeof (cmdObj as unknown as { _actionHandler?: unknown })._actionHandler === 'function';
      expect(documented.get(cmd) ?? [], cmd).toEqual(runnable ? flags : []);
    }
  });

  it('lists the setup --only step ids and step groups (e.g. --only conversions)', () => {
    const setup = renderCliReference(program, { only: ['setup'] });
    expect(setup).toContain('| `--only <steps>` | comma-separated wizard step ids or groups to ask (again)');
    expect(setup).toContain('| `conversions` | `conversions.primaryEvents`, `conversions.secondaryEvents` |');
    for (const g of listWizardStepGroups()) expect(setup).toContain(`| \`${g.group}\` |`);
    expect(setup).toContain('| `google.searchConsoleProperty` | Google access | `google.searchConsoleProperty` |');
  });

  it('renders usage lines, defaults, required options, and escapes table pipes', () => {
    const find = (p: string) => p.split(' ').reduce<Command>((c, name) => c.commands.find((x) => x.name() === name)!, program);
    expect(usageLine(find('costs reconcile'))).toBe('[options] <reservation-id>');
    expect(usageLine(find('workspace status'))).toBe('');
    expect(usageLine(find('sync inspect'))).toBe('[options] [urls...]');
    const tier = find('models test').options.find((o) => o.long === '--tier')!;
    expect(optionMeaning(tier)).toBe('cheap | reasoning | embedding (default: `cheap`)');
    expect(renderCliReference(program, { only: ['models'] })).toContain('| `--tier <tier>` | cheap \\| reasoning \\| embedding (default: `cheap`) |');
    const evidence = find('costs reconcile').options.find((o) => o.long === '--evidence')!;
    expect(optionMeaning(evidence)).toMatch(/\(required\)$/);
    // --no-* flags show no default; data import documents the new --unguard flag.
    expect(renderCliReference(program, { only: ['auth'] })).toContain('| `--no-network` | skip the free read-only Google calls |');
    expect(renderCliReference(program, { only: ['data'] })).toContain('| `--unguard` |');
  });

  it('never carries a local path (defaults computed from the temporary or home directory)', () => {
    expect(reference).not.toContain(os.tmpdir());
    expect(reference).not.toContain(os.homedir());
    expect(reference).toContain('<os tmpdir>/seo-agent-demo');
    expect(withoutLocalPaths(`${os.tmpdir()}/x and ${os.homedir()}/y`)).toBe('<os tmpdir>/x and ~/y');
  });

  it('lists the site-lock commands for the docs (always, and the flag-gated ones only with their flags)', () => {
    const s = siteLockCommands(program);
    expect(s.always).toEqual(expect.arrayContaining(['sync gsc', 'memory sync', 'memory rebuild', 'memory reconcile', 'content bootstrap', 'models test', 'costs reconcile', 'apify import-schema']));
    // NF-08: commands that always write derived data now take the lease too.
    expect(s.always).toEqual(expect.arrayContaining(['analyze page', 'analyze route', 'analyze reconcile', 'report build', 'vault render', 'content import', 'content measure', 'apify inspect']));
    expect(s.always).not.toContain('crawl site'); // listed defensively, not a registered command
    expect(s.conditional).toEqual([
      { command: 'memory search', flags: '--allow-paid' },
      { command: 'pages infer-types', flags: '--apply' },
      { command: 'vault import-business', flags: '--apply' },
      { command: 'research tasks', flags: '--poll or --abandon' },
      { command: 'apify runs', flags: '--resume or --confirm-not-accepted' },
    ]);
  });
});
