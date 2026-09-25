import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildProgram } from '../../../src/cli/main.js';
import { appRoot } from '../../../src/config/paths.js';

/**
 * SKILL.md is the entry point for AI agents operating seo-agent. Agents run
 * what it says literally, so every command, flag, npm alias, and file it
 * mentions must exist. These checks only build the command tree; no command
 * action runs.
 */

const root = appRoot();
const skill = readFileSync(path.join(root, 'SKILL.md'), 'utf8');
const scripts = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;

/** Global options that take a value (skipped before the command path). */
const GLOBAL_WITH_VALUE = new Set(['--workspace', '-w', '--site', '-s', '--mode']);
const GLOBAL_FLAGS = new Set(['--dry-run', '--json', '--offline', ...GLOBAL_WITH_VALUE]);

/** Every `npm run cli -- ...` invocation in code blocks and inline code. */
function cliInvocations(markdown: string): string[][] {
  const out: string[][] = [];
  for (const m of markdown.matchAll(/npm run cli -- ([^`\n#]+)/g)) {
    out.push(m[1]!.trim().split(/\s+/).filter((t) => t !== '...'));
  }
  return out;
}

function optionFlags(cmd: Command): Set<string> {
  const flags = new Set<string>();
  for (const o of cmd.options) {
    if (o.long) flags.add(o.long);
    if (o.short) flags.add(o.short);
    // commander registers --no-x negations as the long flag itself
  }
  return flags;
}

let program: Command;
beforeAll(async () => {
  program = await buildProgram();
});

/** Resolve tokens to [command, remaining tokens], skipping global options. */
function resolve(tokens: string[]): { cmd: Command | null; rest: string[]; path: string[] } {
  const rest = [...tokens];
  const pathParts: string[] = [];
  while (rest.length && GLOBAL_FLAGS.has(rest[0]!)) {
    const flag = rest.shift()!;
    if (GLOBAL_WITH_VALUE.has(flag)) rest.shift();
  }
  let cmd: Command = program;
  while (rest.length) {
    const next = cmd.commands.find((c) => c.name() === rest[0] || c.aliases().includes(rest[0]!));
    if (!next) break;
    pathParts.push(rest.shift()!);
    cmd = next;
  }
  return { cmd: cmd === program ? null : cmd, rest, path: pathParts };
}

describe('SKILL.md', () => {
  it('has skill frontmatter with a name and a trigger-rich description', () => {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(skill);
    expect(m, 'YAML frontmatter at the top of SKILL.md').not.toBeNull();
    const fm = parseYaml(m![1]!) as { name?: string; description?: string };
    expect(fm.name).toBe('seo-agent');
    expect(fm.description?.length ?? 0).toBeGreaterThan(200);
    expect(fm.description).toMatch(/use this skill/i);
  });

  it('only names CLI commands and options that this build registers', () => {
    const invocations = cliInvocations(skill);
    expect(invocations.length).toBeGreaterThan(15);
    const problems: string[] = [];
    for (const tokens of invocations) {
      // Generic prose such as `npm run cli -- <command>` names no concrete command.
      if (tokens[0]?.startsWith('<')) continue;
      const { cmd, rest, path: cmdPath } = resolve(tokens);
      if (!cmd) {
        problems.push(`unknown command: npm run cli -- ${tokens.join(' ')}`);
        continue;
      }
      const known = optionFlags(cmd);
      for (const t of rest) {
        if (t.startsWith('--') && !known.has(t) && !GLOBAL_FLAGS.has(t)) problems.push(`${cmdPath.join(' ')}: unknown option ${t}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('only uses npm aliases that exist, and each alias targets a registered command', () => {
    const aliases = [...skill.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)].map((m) => m[1]!).filter((a) => a !== 'cli');
    expect(aliases.length).toBeGreaterThan(3);
    for (const alias of new Set(aliases)) {
      expect(scripts[alias], `package.json script "${alias}"`).toBeDefined();
      const target = scripts[alias]!.replace(/^tsx src\/cli\/main\.ts\s*/, '');
      if (target !== scripts[alias]) expect(resolve(target.split(/\s+/)).cmd, `alias ${alias}`).not.toBeNull();
    }
  });

  it('only references files that exist in the repository', () => {
    const refs = new Set<string>();
    for (const m of skill.matchAll(/`((?:docs\/)?[A-Za-z_][A-Za-z0-9_./-]*\.(?:md|yaml))`/g)) refs.add(m[1]!);
    for (const m of skill.matchAll(/\]\(([^)#]+\.md)\)/g)) refs.add(m[1]!);
    expect(refs.size).toBeGreaterThan(5);
    const missing = [...refs].filter((r) => !r.includes('<') && !existsSync(path.join(root, r)));
    expect(missing).toEqual([]);
  });

  it('is pointed to at the very top of README.md, before any other section', () => {
    const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
    const firstSection = readme.indexOf('\n## ');
    const pointer = readme.indexOf('(SKILL.md)');
    expect(pointer).toBeGreaterThan(0);
    expect(pointer).toBeLessThan(firstSection);
    expect(readme.slice(0, pointer)).toMatch(/AI agents/);
  });
});
