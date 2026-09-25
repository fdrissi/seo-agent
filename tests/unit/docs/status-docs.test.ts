import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { beforeAll, describe, expect, it } from 'vitest';
import { appRoot } from '../../../src/config/paths.js';
import { buildProgram } from '../../../src/cli/main.js';
import { CliRuntime, MUTATING_COMMANDS } from '../../../src/cli/runtime.js';

/**
 * Spec section 32: the feature-status matrix and the requirements checklist
 * must not overstate what exists. These checks read the Markdown only: every
 * test file the two documents cite must exist, the FEATURE_STATUS summary must
 * match its own table rows, and the CLI reference must list exactly the
 * commands the runtime refuses while a job holds the site lock.
 *
 * They also catch stale claims (B2-05, B2-06): a row may not say a command
 * does not exist while the CLI registers it, the stated test-file count must
 * be the suite's, the stated test count must be plausible for the suite, and
 * a provider-facing adapter whose only evidence is fakes is never
 * implemented-and-tested (the page's own definition requires that no live
 * provider is needed for the behavior to be meaningful).
 */

const root = appRoot();
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
const featureStatus = read('docs/FEATURE_STATUS.md');
const traceability = read('docs/REQUIREMENTS_TRACEABILITY.md');
const cliDoc = read('docs/CLI.md');

const STATUSES = ['implemented-and-tested', 'implemented-awaiting-credentials', 'optional-disabled', 'genuinely-incomplete'] as const;

/** True when a cited test path exists; `*` matches within one directory level (e.g. `tests/unit/core/*.test.ts`). */
function citedTestExists(rel: string): boolean {
  if (!rel.includes('*')) return existsSync(path.join(root, rel));
  const dir = path.dirname(rel);
  if (dir.includes('*') || !existsSync(path.join(root, dir))) return false;
  const re = new RegExp(`^${path.basename(rel).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
  return readdirSync(path.join(root, dir)).some((f) => re.test(f));
}

describe('docs/FEATURE_STATUS.md', () => {
  const tables = featureStatus.slice(featureStatus.indexOf('## 1. '), featureStatus.indexOf('## Access still required'));
  const rows = tables.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---') && !l.startsWith('| Feature |'));

  it('gives every feature row exactly one of the four spec statuses', () => {
    const bad = rows.filter((r) => {
      const cells = r.split(' | ');
      return !STATUSES.includes((cells[1] ?? '').trim() as (typeof STATUSES)[number]);
    });
    expect(bad).toEqual([]);
  });

  it('states summary counts that match the table rows', () => {
    const counts = new Map<string, number>(STATUSES.map((s) => [s, 0]));
    for (const r of rows) {
      const status = r.split(' | ')[1]!.trim();
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    const summary = featureStatus.slice(featureStatus.indexOf('## Summary'), featureStatus.indexOf('## 1. '));
    expect(summary).toContain(`Counted from the rows of the tables below (${rows.length} rows)`);
    for (const s of STATUSES) expect(summary, `summary count for ${s}`).toMatch(new RegExp(`\\| ${s} \\| ${counts.get(s)} \\|`));
  });

  it('cites only test files that exist', () => {
    const cited = [...featureStatus.matchAll(/`(tests\/[^`\s]+\.test\.ts)`/g)].map((m) => m[1]!);
    expect(cited.length).toBeGreaterThan(100);
    expect([...new Set(cited)].filter((c) => !citedTestExists(c))).toEqual([]);
  });

  it('has no unfilled placeholders', () => {
    expect(featureStatus).not.toMatch(/PLACEHOLDER/);
  });
});

describe('docs/REQUIREMENTS_TRACEABILITY.md', () => {
  it('cites only test files that exist (paths are relative to tests/)', () => {
    const cited = [...traceability.matchAll(/`((?:unit|integration|e2e)\/[^`\s]+\.test\.ts)`/g)].map((m) => `tests/${m[1]!}`);
    expect(cited.length).toBeGreaterThan(100);
    expect([...new Set(cited)].filter((c) => !citedTestExists(c))).toEqual([]);
  });

  it('lists a status for every requirement row', () => {
    const rows = traceability.split('\n').filter((l) => /^\| (P\.\d+|\d+\.\d+[a-z]?) \|/.test(l));
    expect(rows.length).toBeGreaterThan(200);
    const allowed = /\| (Tested|Tested offline, live unverified|Documented|Process|Partial|Gap)\b[^|]*\|\s*$/;
    expect(rows.filter((r) => !allowed.test(r))).toEqual([]);
  });
});

describe('docs/CLI.md site-lock list', () => {
  // The list sits between "as long as a live lease exists:" and "They do nothing".
  const lock = cliDoc.indexOf('**Site lock.**');
  const para = cliDoc.slice(cliDoc.indexOf('exists:', lock), cliDoc.indexOf('They do nothing', lock));

  it('names every registered command the runtime refuses while a job holds the site lock', () => {
    const headings = new Set([...cliDoc.matchAll(/^#{3,4} `([^`]+)`\s*$/gm)].map((m) => m[1]!));
    const documented = new Set([...para.matchAll(/`([a-z][a-z0-9 -]*[a-z0-9])`/g)].map((m) => m[1]!));
    // `crawl site` is listed in MUTATING_COMMANDS defensively but is not a registered command.
    const registered = [...MUTATING_COMMANDS].filter((c) => headings.has(c));
    expect(registered.length).toBeGreaterThan(10);
    expect(registered.filter((c) => !documented.has(c))).toEqual([]);
    expect([...documented].filter((c) => !MUTATING_COMMANDS.has(c))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stale claims (B2-05, B2-06)
// ---------------------------------------------------------------------------

/** Every command path the CLI registers ("ai-citations", "ai-citations import", ...). */
async function registeredCommands(): Promise<Set<string>> {
  const runtime = new CliRuntime({ out: () => {}, err: () => {} }, { ...process.env });
  const program = await buildProgram(runtime);
  const names = new Set<string>();
  const walk = (cmd: Command, prefix: string) => {
    for (const c of cmd.commands) {
      const name = prefix ? `${prefix} ${c.name()}` : c.name();
      names.add(name);
      walk(c, name);
    }
  };
  walk(program, '');
  return names;
}

/** Lower-case words with hyphens/punctuation as spaces and a trailing plural "s" dropped ("AI-citations" -> "ai citation"). */
function words(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ')} `;
}

/** A sentence in the row that says a command is missing ("no collector, import command, ...", "`x` does not exist"). */
const DENIES_COMMAND = [/\bno\b[^.|;]*?\bcommands?\b/i, /\bcommands?\b[^.|;]*?\b(?:does not exist|do not exist|is missing|are missing|not (?:yet )?implemented)\b/i];

/** Rows (cells split) that say a command does not exist although the CLI registers a command for their subject. */
function commandDenials(rows: string[][], registered: Set<string>): string[] {
  const topLevel = [...registered].filter((c) => !c.includes(' '));
  const out: string[] = [];
  for (const cells of rows) {
    const text = cells.join(' | ');
    if (!DENIES_COMMAND.some((re) => re.test(text))) continue;
    const subject = words(cells.slice(0, 2).join(' '));
    for (const cmd of topLevel) {
      if (subject.includes(words(cmd))) out.push(`"${cells[0]}": says a command does not exist, but \`${cmd}\` is registered`);
    }
    for (const m of text.matchAll(/\bno `([a-z][a-z0-9 -]*[a-z0-9])`/gi)) {
      if (registered.has(m[1]!)) out.push(`"${cells[0]}": says there is no \`${m[1]}\`, but it is registered`);
    }
  }
  return out;
}

function tableRows(markdown: string, filter: (line: string) => boolean): string[][] {
  return markdown
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| ---') && filter(l))
    .map((l) =>
      l
        .slice(2, l.endsWith(' |') ? -2 : undefined)
        .split(' | ')
        .map((c) => c.trim()),
    );
}

function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listTestFiles(p));
    else if (e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('status docs never deny a command the CLI registers (B2-05)', () => {
  let registered: Set<string>;
  beforeAll(async () => {
    registered = await registeredCommands();
  });

  it('finds the registered commands (sanity)', () => {
    expect(registered.has('ai-citations')).toBe(true);
    expect(registered.has('ai-citations import')).toBe(true);
    expect(registered.size).toBeGreaterThan(30);
  });

  it('the matcher flags a row that denies a registered command, and only that row (synthetic rows)', () => {
    const synthetic = [
      ['AI-citation monitoring (spec 17)', 'genuinely-incomplete', 'There is no collector, import command, or separate budget.'],
      ['Import of GA4 and other metric exports', 'genuinely-incomplete', '`data import` accepts Search Console exports only.'],
      ['Widget polishing (synthetic)', 'genuinely-incomplete', 'There is no widget command.'],
    ];
    expect(commandDenials(synthetic, registered)).toEqual([expect.stringMatching(/^"AI-citation monitoring \(spec 17\)": says a command does not exist, but `ai-citations` is registered$/)]);
  });

  it('docs/FEATURE_STATUS.md', () => {
    const tables = featureStatus.slice(featureStatus.indexOf('## 1. '), featureStatus.indexOf('## Access still required'));
    const rows = tableRows(tables, (l) => !l.startsWith('| Feature |'));
    expect(commandDenials(rows, registered)).toEqual([]);
  });

  it('docs/REQUIREMENTS_TRACEABILITY.md', () => {
    const rows = tableRows(traceability, (l) => /^\| (?:P\.\d+|\d+(?:\.\d+[a-z]?)?)[ :|]/.test(l));
    expect(rows.length).toBeGreaterThan(200);
    expect(commandDenials(rows, registered)).toEqual([]);
  });
});

describe('stated verification numbers match the suite (B2-05)', () => {
  const files = listTestFiles(path.join(root, 'tests'));
  // Static lower bound: every it()/test() call site is at least one test (it.each and loops only add tests).
  const declared = files.reduce((n, f) => n + (readFileSync(f, 'utf8').match(/^\s*(?:it|test)(?:\.(?:skip|only|todo|concurrent|sequential|fails|skipIf\([^)]*\)|runIf\([^)]*\)|each\([^)]*\)))*\(/gm)?.length ?? 0), 0);
  const fs = featureStatus.match(/`npx vitest run`: (\d+) test files and (\d+) tests/);
  const tr = traceability.match(/^\| 32\.2 \|[^\n]*?(\d+) test files, (\d+) tests\b/m);

  it('both documents state the numbers', () => {
    expect(fs, 'FEATURE_STATUS verification bullet').not.toBeNull();
    expect(tr, 'REQUIREMENTS_TRACEABILITY row 32.2').not.toBeNull();
    expect(fs!.slice(1, 3)).toEqual(tr!.slice(1, 3));
  });

  it('the stated number of test files is the number of test files in the suite', () => {
    expect(Number(fs?.[1]), 'FEATURE_STATUS').toBe(files.length);
    expect(Number(tr?.[1]), 'REQUIREMENTS_TRACEABILITY 32.2').toBe(files.length);
  });

  it('the stated number of tests is plausible for the suite (at least the declared tests, at most 1.5 times as many)', () => {
    // The exact total is known only after a run (it.each and loops expand at collection time); these bounds catch a stale count.
    for (const [doc, m] of [['FEATURE_STATUS', fs], ['REQUIREMENTS_TRACEABILITY 32.2', tr]] as const) {
      const stated = Number(m?.[2]);
      expect(stated, doc).toBeGreaterThanOrEqual(declared);
      expect(stated, doc).toBeLessThanOrEqual(Math.ceil(declared * 1.5));
    }
  });
});

describe('fakes are not live evidence (B2-06)', () => {
  /** Rows about something that talks to an external provider (by name) or is an adapter/client of one. */
  const PROVIDER = /\b(?:google|search console|ga4|oauth|apify|dataforseo|qdrant|llm gateway|pagespeed|crux|github|playwright)\b|\b(?:adapter|client)\b/i;
  const FAKE_EVIDENCE = /\bfakes?\b|\bfake (?:server|api|endpoint|token endpoint|browser|transport)\b/i;

  function fakeOnlyAdapters(rows: string[][]): string[] {
    return rows.filter((c) => c[1] === 'implemented-and-tested' && PROVIDER.test(c[0] ?? '') && FAKE_EVIDENCE.test(c[2] ?? '')).map((c) => c[0]!);
  }

  it('the matcher (synthetic rows)', () => {
    expect(
      fakeOnlyAdapters([
        ['Generic Apify v2 client', 'implemented-and-tested', '`tests/unit/apify/client.test.ts` (fakes).'],
        ['Generic Apify v2 client (offline logic)', 'implemented-awaiting-credentials', '`tests/unit/apify/client.test.ts` (fakes).'],
        ['Budget reservations', 'implemented-and-tested', '`tests/unit/budgets/x.test.ts` (no fakes needed)'],
      ]),
    ).toEqual(['Generic Apify v2 client']);
  });

  it('docs/FEATURE_STATUS.md: a provider adapter tested only against fakes is not implemented-and-tested', () => {
    const tables = featureStatus.slice(featureStatus.indexOf('## 1. '), featureStatus.indexOf('## Access still required'));
    expect(fakeOnlyAdapters(tableRows(tables, (l) => !l.startsWith('| Feature |')))).toEqual([]);
  });
});

describe('docs/DATA_FLOWS.md states what Qdrant really stores (C2-06)', () => {
  const dataFlows = read('docs/DATA_FLOWS.md');
  const qdrantRow = dataFlows.split('\n').find((l) => l.startsWith('| Qdrant |'));
  const section = dataFlows.slice(dataFlows.indexOf('### Qdrant'), dataFlows.indexOf('\n### ', dataFlows.indexOf('### Qdrant') + 1));

  /** Sentences that say chunk text is stored/kept somewhere without negating it or naming SQLite as the place. */
  function claimsTextInQdrant(text: string): string[] {
    return text
      .replace(/\s+/g, ' ')
      .split(/(?<=[.;|])\s+/)
      .filter((s) => /chunk text/i.test(s) && /\b(?:stor\w*|stays?|kept|keeps?|receives?)\b|\+/i.test(s) && !/\b(?:no|not|never)\b/i.test(s) && !/sqlite/i.test(s));
  }

  it('the matcher flags the old wording and accepts the corrected one (synthetic lines)', () => {
    expect(claimsTextInQdrant('| Qdrant | `features.qdrant` | chunk text + metadata + vectors, stored on your Qdrant server |')).toHaveLength(1);
    expect(claimsTextInQdrant('Default URL: vectors, chunk text, and metadata stay on your machine.')).toHaveLength(1);
    expect(claimsTextInQdrant('No chunk text is stored in Qdrant: the text stays in SQLite.')).toEqual([]);
  });

  it('never claims chunk text is stored in Qdrant, in the summary row or the Qdrant section', () => {
    expect(qdrantRow, 'summary row').toBeDefined();
    expect(section.length).toBeGreaterThan(0);
    const cells = qdrantRow!.split(' | ');
    // "Receives" is the third column, "Never receives" the fourth.
    expect(cells[2]).not.toMatch(/\btext\b/i);
    expect(cells[2]).toMatch(/vectors/i);
    expect(cells[3]).toMatch(/chunk text/i);
    expect(claimsTextInQdrant(qdrantRow!)).toEqual([]);
    expect(claimsTextInQdrant(section)).toEqual([]);
    expect(section).toContain('No chunk text is stored in Qdrant');
  });

  it('matches the payload the code sends: MemoryPointPayload has no text field', () => {
    const src = read('src/memory/qdrant.ts');
    const body = /export interface MemoryPointPayload \{([\s\S]*?)\n\}/.exec(src)?.[1];
    expect(body, 'MemoryPointPayload in src/memory/qdrant.ts').toBeDefined();
    const fields = [...body!.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]!);
    expect(fields).toEqual(expect.arrayContaining(['site_id', 'document_id', 'chunk_id', 'source_type', 'trust_class', 'status', 'language', 'content_hash', 'source_date']));
    expect(fields.filter((f) => /text|body|^content$|^chunk$/i.test(f))).toEqual([]);
  });
});
