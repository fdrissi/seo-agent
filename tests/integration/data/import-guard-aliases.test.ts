/**
 * `data import` honesty about the file it reads. SYNTHETIC data only: every
 * file below is written by this test into a temporary workspace, uses
 * reserved example.test domains, and contains invented numbers.
 *
 * - B4A2-06: a genuine leading apostrophe in a third-party file is kept; the
 *   export formula guard is reversible and removed only from files recognized
 *   as seo-agent exports (marker comment or exact export column layout), or
 *   with --unguard. export -> import round-trips exactly.
 * - B4A2-04: `constructor`, `__proto__`, `toString`, and `hasOwnProperty`
 *   columns / JSON keys are reported as ignored, never accepted.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { register } from '../../../src/cli/commands/data.js';
import { CliRuntime } from '../../../src/cli/runtime.js';
import { EXPORT_MARKER, csvCell, parseCsvRecords, toCsv, unguardCell } from '../../../src/data/csv.js';
import { exportDataset, formatExport } from '../../../src/data/export.js';
import { importDataset } from '../../../src/data/import.js';
import { upsertKeyword } from '../../../src/integrations/dataforseo/store.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { SITE_URL, reportsTestConfig, seedGscPageQueries } from '../../fixtures/reports/seed.js';

const contexts: TestContext[] = [];
afterEach(() => {
  while (contexts.length) contexts.pop()!.cleanup();
  process.exitCode = undefined;
});

/** A live (core) test workspace, or a demo one (synthetic imports are refused in a live workspace). */
function newCtx(profile: 'core' | 'demo' = 'core'): TestContext {
  const c = createTestContext({ config: reportsTestConfig({ profile }) });
  contexts.push(c);
  return c;
}

function file(c: TestContext, name: string, content: string): string {
  const p = path.join(c.paths.root, name);
  writeFileSync(p, content);
  return p;
}

const keywordsOf = (c: TestContext) => c.db.all<{ keyword: string }>('SELECT keyword FROM keywords WHERE site_id = ? ORDER BY keyword', [c.siteId]).map((r) => r.keyword);

/** Values that start with a formula character or an apostrophe (the cases the guard must round-trip). */
const TRICKY = ["'quoted synthetic phrase", '-minus synthetic widgets', '=SUM(1,2)', "''double apostrophe widget", "'-apostrophe then minus", '@mention widget', '+plus widget', 'plain synthetic widget'];

describe('CSV formula guard (csv.ts)', () => {
  it('guards formula starts AND leading apostrophes, so unguarding restores the exact value', () => {
    for (const v of TRICKY) {
      const cellText = csvCell(v);
      const parsed = parseCsvRecords(toCsv(['v'], [{ v }]), { unguard: true }).records[0]!.v!;
      expect(parsed, `${v} -> ${cellText}`).toBe(v);
    }
    expect(csvCell("'x")).toBe("''x");
    expect(csvCell('-x')).toBe("'-x");
    expect(csvCell('x')).toBe('x');
    expect(unguardCell("''x")).toBe("'x");
    expect(unguardCell("'x")).toBe("'x"); // never produced by the guard: a real apostrophe stays
    expect(unguardCell("'")).toBe("'");
  });

  it('parseCsvRecords keeps every cell as written unless asked to unguard or the file carries the export marker', () => {
    const text = ['keyword', "'-minus", "'quoted"].join('\n');
    const plain = parseCsvRecords(text);
    expect(plain.records.map((r) => r.keyword)).toEqual(["'-minus", "'quoted"]);
    expect(plain).toMatchObject({ unguarded: false, guardLikeCells: 1 });
    const marked = parseCsvRecords(`# ${EXPORT_MARKER}1 keywords\n${text}`);
    expect(marked.records.map((r) => r.keyword)).toEqual(['-minus', "'quoted"]);
    expect(marked.unguarded).toBe(true);
    expect(parseCsvRecords(text, { unguard: (header) => header.includes('keyword') }).records[0]!.keyword).toBe('-minus');
  });
});

describe('data import: leading apostrophes (B4A2-06)', () => {
  it('keeps genuine leading apostrophes of a third-party keyword list and says why', () => {
    const ctx = newCtx();
    const f = file(ctx, 'tool-export.csv', ['Keyword,Search Volume', "'quoted synthetic phrase,10", "'-dash widgets,20", 'plain synthetic widget,30'].join('\n'));
    const r = importDataset(ctx, 'keywords', f);
    expect(r.status).toBe('succeeded');
    expect(keywordsOf(ctx)).toEqual(["'-dash widgets", "'quoted synthetic phrase", 'plain synthetic widget']);
    expect(r.warnings.join(' ')).toMatch(/1 cell\(s\) start with an apostrophe .* kept exactly as written .* --unguard/);
  });

  it('--unguard (unguard: true) removes the guard from a file exported without the marker', () => {
    const ctx = newCtx();
    const f = file(ctx, 'old-export.csv', ['keyword', "'-dash widgets", "'quoted synthetic phrase"].join('\n'));
    const r = importDataset(ctx, 'keywords', f, { unguard: true });
    expect(keywordsOf(ctx)).toEqual(["'quoted synthetic phrase", '-dash widgets']);
    expect(r.warnings.join(' ')).toMatch(/Removed the spreadsheet formula guard .* from 1 cell\(s\) \(--unguard\)/);
  });

  it('round-trips a keywords export exactly (recognized by its column layout)', () => {
    const src = newCtx();
    for (const k of TRICKY) upsertKeyword(src, { keyword: k, language: 'en', origin: 'manual' });
    const csv = formatExport(exportDataset(src, 'keywords'), 'csv');
    expect(csv).toContain("'''double apostrophe widget");
    const dst = newCtx();
    const r = importDataset(dst, 'keywords', file(dst, 'keywords-export.csv', csv));
    expect(r.status, JSON.stringify(r.rejected)).toBe('succeeded');
    expect(keywordsOf(dst)).toEqual(keywordsOf(src));
    expect(r.warnings.join(' ')).toMatch(/column layout of the keywords export/);
  });

  it('round-trips Search Console queries exactly (gsc-queries export -> gsc-queries import)', () => {
    const src = newCtx();
    seedGscPageQueries(src.db, src.siteId, {
      dates: ['2026-09-01'],
      rows: [
        { url: `${SITE_URL}/pricing`, query: "'quoted synthetic query", clicks: 1, impressions: 10, position: 3 },
        { url: `${SITE_URL}/pricing`, query: '-minus synthetic query', clicks: 2, impressions: 20, position: 4 },
        { url: `${SITE_URL}/pricing`, query: '=HYPERLINK("https://evil.invalid")', clicks: 3, impressions: 30, position: 5 },
      ],
    });
    const csv = formatExport(exportDataset(src, 'gsc-queries'), 'csv');
    const dst = newCtx();
    const r = importDataset(dst, 'gsc-queries', file(dst, 'queries-export.csv', csv), { complete: true });
    expect(r.status, JSON.stringify(r.rejected)).toBe('succeeded');
    const queries = (c: TestContext) => c.db.all<{ query: string }>('SELECT query FROM gsc_page_query_daily_current WHERE site_id = ? ORDER BY query', [c.siteId]).map((x) => x.query);
    expect(queries(dst)).toEqual(queries(src));
  });

  it('`data import --unguard` passes the flag through the CLI', async () => {
    const ctx = newCtx();
    const f = file(ctx, 'old-export.csv', ['keyword', "'-dash widgets"].join('\n'));
    const out: string[] = [];
    const cli = new CliRuntime({ out: (t) => void out.push(t), err: () => undefined }, { ...process.env, SEO_AGENT_WORKSPACE: ctx.paths.root });
    const program = new Command();
    program.exitOverride().option('-w, --workspace <dir>').option('-s, --site <id>').option('--dry-run').option('--json').option('--mode <mode>').option('--offline');
    register(program, cli);
    await program.parseAsync(['node', 'seo-agent', '--workspace', ctx.paths.root, '--offline', '--json', 'data', 'import', 'keywords', f, '--unguard']);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ status: 'succeeded', accepted: 1 });
    expect(keywordsOf(ctx)).toEqual(['-dash widgets']);
  });
});

describe('data import: prototype-member column names (B4A2-04)', () => {
  it('reports constructor, __proto__, toString, and hasOwnProperty CSV headers as ignored columns', () => {
    const ctx = newCtx();
    const f = file(ctx, 'pages.csv', ['Date,Page,Clicks,Impressions,constructor,__proto__,toString,hasOwnProperty', `2026-09-01,${SITE_URL}/pricing,1,10,a,b,c,d`].join('\n'));
    const r = importDataset(ctx, 'gsc-pages', f, { preview: true });
    expect(r.accepted).toBe(1);
    expect(r.warnings).toContain('Ignored columns: constructor, __proto__, tostring, hasownproperty.');
  });

  it('reports the same JSON keys as ignored (keywords)', () => {
    const ctx = newCtx('demo'); // the file declares itself synthetic: a live workspace would refuse it
    const f = file(ctx, 'keywords.json', '{"_synthetic": true, "rows": [{"keyword": "synthetic widget", "constructor": "a", "__proto__": {"polluted": true}, "toString": "c", "hasOwnProperty": "d"}]}');
    const r = importDataset(ctx, 'keywords', f, { preview: true });
    expect(r.accepted).toBe(1);
    expect(r.warnings).toContain('Ignored columns: constructor, __proto__, toString, hasOwnProperty.');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('a keyword list whose only keyword column is named "constructor" has no keyword column', () => {
    const ctx = newCtx();
    const f = file(ctx, 'bad.csv', ['constructor', 'synthetic widget'].join('\n'));
    expect(() => importDataset(ctx, 'keywords', f, { preview: true })).toThrow(/no keyword column/);
  });
});
