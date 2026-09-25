/**
 * `data export` / `data import` (spec 2: CSV/JSON import/export instead of
 * extra integrations). SYNTHETIC data only: every file below is written by this
 * test into a temporary workspace, uses reserved example.test domains, and
 * contains invented numbers.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { register } from '../../../src/cli/commands/data.js';
import { CliRuntime } from '../../../src/cli/runtime.js';
import { exportDataset, formatExport } from '../../../src/data/export.js';
import { DATA_IMPORT_VERSION, importDataset } from '../../../src/data/import.js';
import { parseCsvRecords, toCsv } from '../../../src/data/csv.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { GSC_PROPERTY, SITE_URL, eachDate, insertRow, reportsTestConfig, seedGscPageQueries, seedGscPages, seedGscProperty, sid } from '../../fixtures/reports/seed.js';

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

const DAYS = eachDate('2026-09-01', '2026-09-03');

/** SYNTHETIC daily page rows, as an API / BigQuery / Looker Studio export with the Date dimension would give them. */
const PAGES_CSV = [
  'Date,Page,Clicks,Impressions,CTR,Position',
  `2026-09-01,${SITE_URL}/pricing,6,100,6%,5.2`,
  `2026-09-02,${SITE_URL}/pricing,4,90,4.44%,5.8`,
  `2026-09-02,${SITE_URL}/blog/guide,"1,200","3,000",0.4,12.5`,
].join('\n');

describe('data export', () => {
  it('exports one dataset at its stored grain (current revisions only; never mixed with property totals)', () => {
    const ctx = newCtx();
    seedGscProperty(ctx.db, ctx.siteId, { dates: DAYS, clicks: 10, impressions: 200, position: 8 });
    const pageBatch = seedGscPages(ctx.db, ctx.siteId, { dates: DAYS, pages: [{ url: `${SITE_URL}/pricing`, clicks: 6, impressions: 100, position: 5 }] });
    // A superseded revision is never exported.
    insertRow(ctx.db, 'gsc_page_daily', { site_id: ctx.siteId, property: GSC_PROPERTY, search_type: 'web', date: '2026-09-01', date_tz: 'America/Los_Angeles', page: `${SITE_URL}/pricing`, segment_key: '', clicks: 999, impressions: 9999, ctr: 0.1, position: 1, aggregation_type: 'byPage', is_final: 1, revision: 0, is_current: 0, row_hash: sid('h'), batch_id: pageBatch, collected_at: '2026-09-22T06:00:00.000Z', transformation_version: 'test@1', is_synthetic: 0 });
    const r = exportDataset(ctx, 'gsc-pages', { from: '2026-09-02', to: '2026-09-03' });
    expect(r.rowCount).toBe(2);
    expect(r.rows.map((x) => x.date)).toEqual(['2026-09-02', '2026-09-03']);
    expect(r.rows.every((x) => x.page === `${SITE_URL}/pricing` && x.clicks === 6)).toBe(true);
    expect(r.grain).toContain('page');
    expect(r.uniqueKey).toEqual(['property', 'search_type', 'date', 'page', 'segment_key']);
    expect(r.notes.join(' ')).toContain('not additive with property totals');
    const json = JSON.parse(formatExport(r, 'json'));
    expect(json).toMatchObject({ dataset: 'gsc-pages', rowCount: 2, filters: { from: '2026-09-02', to: '2026-09-03' } });
    const csv = formatExport(r, 'csv');
    const parsed = parseCsvRecords(csv);
    expect(parsed.header.slice(0, 5)).toEqual(['property', 'search_type', 'date', 'date_tz', 'page']);
    expect(parsed.records).toHaveLength(2);
    expect(csv).not.toContain('999');
    // Property totals are their own dataset.
    expect(exportDataset(ctx, 'gsc-property').rows.every((x) => x.clicks === 10)).toBe(true);
    expect(() => exportDataset(ctx, 'gsc-everything')).toThrow(/Unknown dataset/);
  });

  it('keeps unknown costs empty (never $0) and guards spreadsheet formulas in text cells', () => {
    const ctx = newCtx();
    insertRow(ctx.db, 'cost_ledger', { id: sid('cl'), site_id: ctx.siteId, provider: 'dataforseo', amount_usd_micros: null, amount_status: 'unknown', source: 'estimate', period_month: '2026-09', period_week: '2026-W37', recorded_at: '2026-09-10T10:00:00.000Z' });
    insertRow(ctx.db, 'cost_ledger', { id: sid('cl'), site_id: ctx.siteId, provider: 'apify', amount_usd_micros: 20000, amount_status: 'actual', source: 'provider_reported', period_month: '2026-09', period_week: '2026-W37', recorded_at: '2026-09-11T10:00:00.000Z' });
    const costs = exportDataset(ctx, 'costs');
    expect(costs.rows.map((r) => [r.provider, r.amount_usd_micros, r.amount_status])).toEqual([
      ['dataforseo', null, 'unknown'],
      ['apify', 20000, 'actual'],
    ]);
    const csv = parseCsvRecords(formatExport(costs, 'csv')).records;
    expect(csv[0]!.amount_usd_micros).toBe('');
    expect(csv[1]!.amount_usd_micros).toBe('20000');

    seedGscPageQueries(ctx.db, ctx.siteId, { dates: ['2026-09-01'], rows: [{ url: `${SITE_URL}/pricing`, query: '=HYPERLINK("https://evil.invalid")', clicks: 1, impressions: 10, position: 3 }] });
    const q = formatExport(exportDataset(ctx, 'gsc-queries'), 'csv');
    expect(q).toContain(`"'=HYPERLINK(""https://evil.invalid"")"`);
    expect(toCsv(['n'], [{ n: -5 }])).toContain('-5'); // numbers are never altered
    // parseCsvRecords keeps cells as written by default; the guard is removed for files recognized as
    // seo-agent exports (`data import` recognizes the export column layout) or on request (--unguard).
    expect(parseCsvRecords(q).records[0]!.query).toBe(`'=HYPERLINK("https://evil.invalid")`);
    expect(parseCsvRecords(q, { unguard: true }).records[0]!.query).toBe('=HYPERLINK("https://evil.invalid")');
  });
});

describe('data import', () => {
  it('imports daily GSC page rows as a versioned batch with source "import" and provenance; a re-import never double counts', () => {
    const ctx = newCtx();
    const f = file(ctx, 'pages.csv', PAGES_CSV);
    const r = importDataset(ctx, 'gsc-pages', f, { complete: true });
    expect(r.status).toBe('succeeded');
    expect(r.accepted).toBe(3);
    expect(r.counts).toMatchObject({ received: 3, newRevisions: 3, unchanged: 0 });
    const batch = ctx.db.get<Record<string, unknown>>('SELECT * FROM ingestion_batches WHERE id = ?', [r.batchId]);
    expect(batch).toMatchObject({ source: 'import', dataset: 'gsc_page_daily', property: GSC_PROPERTY, date_start: '2026-09-01', date_end: '2026-09-02', status: 'succeeded', transformation_version: DATA_IMPORT_VERSION, is_synthetic: 0, truncated: 0 });
    expect(JSON.parse(String(batch!.raw_refs_json))).toEqual([r.rawRef]);
    expect(JSON.parse(String(batch!.request_json))).toMatchObject({ type: 'web', importedDataset: 'gsc-pages', file: 'pages.csv', sha256: r.sha256, completeness: 'owner_asserted' });
    // The stored file (private workspace raw store) holds the exact content.
    expect(ctx.raw.load<{ content: string; sha256: string }>(r.rawRef!)).toMatchObject({ content: PAGES_CSV, sha256: r.sha256 });
    const rows = ctx.db.all<Record<string, unknown>>("SELECT date, page, clicks, impressions, ctr, position, aggregation_type, is_final, date_tz, batch_id, transformation_version, is_synthetic FROM gsc_page_daily_current WHERE site_id = ? ORDER BY date, page", [ctx.siteId]);
    expect(rows).toEqual([
      { date: '2026-09-01', page: `${SITE_URL}/pricing`, clicks: 6, impressions: 100, ctr: 0.06, position: 5.2, aggregation_type: 'byPage', is_final: 1, date_tz: 'America/Los_Angeles', batch_id: r.batchId, transformation_version: DATA_IMPORT_VERSION, is_synthetic: 0 },
      { date: '2026-09-02', page: `${SITE_URL}/blog/guide`, clicks: 1200, impressions: 3000, ctr: 0.4, position: 12.5, aggregation_type: 'byPage', is_final: 1, date_tz: 'America/Los_Angeles', batch_id: r.batchId, transformation_version: DATA_IMPORT_VERSION, is_synthetic: 0 },
      { date: '2026-09-02', page: `${SITE_URL}/pricing`, clicks: 4, impressions: 90, ctr: 0.0444, position: 5.8, aggregation_type: 'byPage', is_final: 1, date_tz: 'America/Los_Angeles', batch_id: r.batchId, transformation_version: DATA_IMPORT_VERSION, is_synthetic: 0 },
    ]);
    const again = importDataset(ctx, 'gsc-pages', f, { complete: true });
    expect(again.counts).toMatchObject({ received: 3, newRevisions: 0, unchanged: 3 });
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM gsc_page_daily_current WHERE site_id = ?', [ctx.siteId])!.n).toBe(3);
    // A corrected value becomes a new revision; the old one stays as history.
    const fixed = file(ctx, 'pages-fixed.csv', PAGES_CSV.replace(`${SITE_URL}/pricing,4,90`, `${SITE_URL}/pricing,5,90`));
    expect(importDataset(ctx, 'gsc-pages', fixed, { complete: true }).counts).toMatchObject({ newRevisions: 1, revised: 1, unchanged: 2 });
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM gsc_page_daily WHERE site_id = ? AND date = '2026-09-02' AND page = ?", [ctx.siteId, `${SITE_URL}/pricing`])!.n).toBe(2);
  });

  it('refuses an aggregated export without a date column instead of storing it as one day', () => {
    const ctx = newCtx();
    const f = file(ctx, 'Pages.csv', ['Top pages,Clicks,Impressions,CTR,Position', `${SITE_URL}/pricing,120,3000,4%,6.1`].join('\n'));
    expect(() => importDataset(ctx, 'gsc-pages', f)).toThrow(/no date column.*aggregated over a date range/);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ingestion_batches WHERE site_id = ?', [ctx.siteId])!.n).toBe(0);
  });

  it('rejects invalid rows with their row numbers (all-or-nothing unless --skip-invalid) and never sums duplicates', () => {
    const ctx = newCtx();
    const f = file(ctx, 'bad.csv', [PAGES_CSV, `2026-09-03,not-a-url,1,10,,`, `2026-09-01,${SITE_URL}/pricing,1,10,,`, `09/03/2026,${SITE_URL}/x,1,10,,`].join('\n'));
    const r = importDataset(ctx, 'gsc-pages', f);
    expect(r.status).toBe('failed');
    expect(r.rejected.map((e) => e.row)).toEqual([5, 6, 7]);
    expect(r.rejected[0]!.errors.join(' ')).toContain('absolute http(s) URL');
    expect(r.rejected[1]!.errors.join(' ')).toContain('duplicate of row 2');
    expect(r.rejected[2]!.errors.join(' ')).toContain('YYYY-MM-DD');
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM gsc_page_daily WHERE site_id = ?', [ctx.siteId])!.n).toBe(0);
    const partial = importDataset(ctx, 'gsc-pages', f, { skipInvalid: true });
    expect(partial.status).toBe('partial');
    expect(partial.accepted).toBe(3);
    expect(ctx.db.get<{ status: string }>('SELECT status FROM ingestion_batches WHERE id = ?', [partial.batchId])!.status).toBe('partial');
  });

  it('keeps rows collected by a Google sync unless --replace; completeness is not assumed; recent days are not final', () => {
    const ctx = newCtx();
    seedGscPages(ctx.db, ctx.siteId, { dates: ['2026-09-01'], pages: [{ url: `${SITE_URL}/pricing`, clicks: 7, impressions: 110, position: 5 }] });
    const f = file(ctx, 'pages.csv', [PAGES_CSV, `2026-09-23,${SITE_URL}/pricing,2,40,5%,6`].join('\n'));
    const r = importDataset(ctx, 'gsc-pages', f);
    expect(r.skippedExisting).toBe(1);
    expect(ctx.db.get<{ clicks: number }>("SELECT clicks FROM gsc_page_daily_current WHERE site_id = ? AND date = '2026-09-01' AND page = ?", [ctx.siteId, `${SITE_URL}/pricing`])!.clicks).toBe(7);
    // Completeness not asserted: the batch is flagged, so absent rows are never read as zeros.
    expect(ctx.db.get<{ truncated: number }>('SELECT truncated FROM ingestion_batches WHERE id = ?', [r.batchId])!.truncated).toBe(1);
    // 2026-09-23 is within the last days before today (2026-09-24, Pacific): stored as not final.
    expect(ctx.db.get<{ is_final: number }>("SELECT is_final FROM gsc_page_daily_current WHERE site_id = ? AND date = '2026-09-23'", [ctx.siteId])!.is_final).toBe(0);
    const replaced = importDataset(ctx, 'gsc-pages', f, { replace: true, complete: true });
    expect(replaced.skippedExisting).toBe(0);
    expect(ctx.db.get<{ clicks: number }>("SELECT clicks FROM gsc_page_daily_current WHERE site_id = ? AND date = '2026-09-01' AND page = ?", [ctx.siteId, `${SITE_URL}/pricing`])!.clicks).toBe(6);
  });

  it('imports property totals (the Search Console "Dates" export) and page/query rows from JSON; a file that declares itself synthetic is labeled (demo workspace) or refused (live workspace)', () => {
    const ctx = newCtx('demo');
    const DATES_CSV = ['# SYNTHETIC fixture: invented numbers', 'Date,Clicks,Impressions,CTR,Position', '2026-09-01,10,200,5%,8', '2026-09-02,12,210,5.71%,7.9'].join('\n');
    const live = newCtx();
    expect(() => importDataset(live, 'gsc-property', file(live, 'Dates.csv', DATES_CSV), { complete: true })).toThrow(expect.objectContaining({ code: 'WORKSPACE_UNSAFE' }));
    const dates = file(ctx, 'Dates.csv', DATES_CSV);
    const d = importDataset(ctx, 'gsc-property', dates, { complete: true });
    expect(d).toMatchObject({ status: 'succeeded', synthetic: true, accepted: 2 });
    expect(ctx.db.all<{ is_synthetic: number; aggregation_type: string }>('SELECT DISTINCT is_synthetic, aggregation_type FROM gsc_property_daily WHERE site_id = ?', [ctx.siteId])).toEqual([{ is_synthetic: 1, aggregation_type: 'byProperty' }]);
    const q = file(ctx, 'queries.json', JSON.stringify({ _synthetic: true, rows: [{ date: '2026-09-01', page: `${SITE_URL}/pricing`, query: 'test co pricing', clicks: 2, impressions: 20, position: 1.5, country: 'est', device: 'mobile' }] }));
    const qr = importDataset(ctx, 'gsc-queries', q, { complete: true });
    expect(qr.status).toBe('succeeded');
    expect(ctx.db.get('SELECT query, segment_key, country, device, is_synthetic FROM gsc_page_query_daily_current WHERE site_id = ?', [ctx.siteId])).toEqual({ query: 'test co pricing', segment_key: 'country=est;device=MOBILE', country: 'est', device: 'MOBILE', is_synthetic: 1 });
  });

  it('imports a keyword list with provider-labeled volume estimates and provenance', () => {
    const ctx = newCtx();
    const f = file(ctx, 'keywords.csv', ['Keyword,Search volume,Language,Intent,Branded', 'widget pricing,1300,en,commercial,no', 'test co login,90,en,navigational,yes', 'widget repair guide,,,,'].join('\n'));
    const r = importDataset(ctx, 'keywords', f, { provider: 'Other Tool' });
    expect(r.status).toBe('succeeded');
    expect(r.keywords).toEqual({ created: 3, matchedExisting: 0, volumes: 2 });
    const kw = ctx.db.get<{ intent: string; intent_source: string; is_branded: number; origins_json: string }>("SELECT intent, intent_source, is_branded, origins_json FROM keywords WHERE site_id = ? AND normalized = 'test co login'", [ctx.siteId]);
    expect(kw).toMatchObject({ intent: 'navigational', intent_source: 'manual', is_branded: 1 });
    expect(JSON.parse(kw!.origins_json)).toContain('import');
    const m = ctx.db.all<{ provider: string; search_volume: number; raw_ref: string }>('SELECT provider, search_volume, raw_ref FROM keyword_metrics WHERE site_id = ? ORDER BY search_volume', [ctx.siteId]);
    expect(m).toEqual([
      { provider: 'import:other_tool', search_volume: 90, raw_ref: r.rawRef },
      { provider: 'import:other_tool', search_volume: 1300, raw_ref: r.rawRef },
    ]);
    expect(ctx.db.get('SELECT source, dataset, status FROM ingestion_batches WHERE id = ?', [r.batchId])).toEqual({ source: 'import', dataset: 'keywords', status: 'succeeded' });
    // Importing the list again matches the existing keywords instead of duplicating them.
    expect(importDataset(ctx, 'keywords', f, { provider: 'Other Tool' }).keywords).toMatchObject({ created: 0, matchedExisting: 3 });
  });

  it('round-trips: an export of page rows imports into another workspace unchanged', () => {
    const a = newCtx();
    const b = newCtx();
    importDataset(a, 'gsc-pages', file(a, 'pages.csv', PAGES_CSV), { complete: true });
    const exported = file(b, 'export.csv', formatExport(exportDataset(a, 'gsc-pages'), 'csv'));
    const r = importDataset(b, 'gsc-pages', exported, { complete: true });
    expect(r.status).toBe('succeeded');
    expect(r.warnings.join(' ')).toContain('Ignored columns');
    const cols = 'date, page, segment_key, clicks, impressions, ctr, position';
    expect(b.db.all(`SELECT ${cols} FROM gsc_page_daily_current WHERE site_id = ? ORDER BY date, page`, [b.siteId])).toEqual(a.db.all(`SELECT ${cols} FROM gsc_page_daily_current WHERE site_id = ? ORDER BY date, page`, [a.siteId]));
  });

  it('a preview (dry run) validates and counts without writing anything', () => {
    const ctx = newCtx();
    const r = importDataset(ctx, 'gsc-pages', file(ctx, 'pages.csv', PAGES_CSV), { preview: true });
    expect(r).toMatchObject({ status: 'preview', accepted: 3, batchId: null, rawRef: null });
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ingestion_batches WHERE site_id = ?', [ctx.siteId])!.n).toBe(0);
  });
});

async function run(root: string, args: string[]): Promise<{ out: string; err: string; failed: boolean }> {
  const out: string[] = [];
  const err: string[] = [];
  const cli = new CliRuntime({ out: (t) => out.push(t), err: (t) => err.push(t) }, { ...process.env, SEO_AGENT_WORKSPACE: root });
  const program = new Command();
  program.exitOverride().option('-w, --workspace <dir>').option('-s, --site <id>').option('--dry-run').option('--json').option('--mode <mode>').option('--offline').configureOutput({ writeErr: (s) => err.push(s), writeOut: (s) => out.push(s) });
  register(program, cli);
  let failed = false;
  try {
    await program.parseAsync(['node', 'seo-agent', '--workspace', root, '--offline', ...args]);
  } catch {
    failed = true;
  }
  return { out: out.join('\n'), err: err.join('\n'), failed };
}

describe('data CLI', () => {
  it('imports a file and exports a dataset to the workspace exports folder or standard output', async () => {
    const ctx = newCtx();
    const root = ctx.paths.root;
    const f = file(ctx, 'pages.csv', PAGES_CSV);
    const imp = await run(root, ['--json', 'data', 'import', 'gsc-pages', f, '--complete']);
    expect(imp.failed).toBe(false);
    expect(JSON.parse(imp.out)).toMatchObject({ dataset: 'gsc-pages', status: 'succeeded', accepted: 3 });

    const exp = await run(root, ['--json', 'data', 'export', 'gsc-pages', '--format', 'json', '--from', '2026-09-01', '--to', '2026-09-02']);
    expect(exp.failed).toBe(false);
    const meta = JSON.parse(exp.out);
    expect(meta).toMatchObject({ dataset: 'gsc-pages', rowCount: 3 });
    expect(meta.file.startsWith(path.join(root, 'exports'))).toBe(true);
    expect(existsSync(meta.file)).toBe(true);
    expect(JSON.parse(readFileSync(meta.file, 'utf8')).rows).toHaveLength(3);

    const stdout = await run(root, ['data', 'export', 'gsc-pages', '--out', '-']);
    expect(stdout.out.split('\n')[0]).toContain('property,search_type,date');
    expect(stdout.out.trim().split('\n')).toHaveLength(4);

    const bad = await run(root, ['data', 'export', 'nope']);
    expect(bad.failed || process.exitCode === 1).toBe(true);
  });
});
