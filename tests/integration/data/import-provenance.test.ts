/**
 * `data import` keeps what a `data export` file says about its rows, and
 * `data export` writes only where it should. SYNTHETIC data only: every file
 * below is written by this test into a temporary workspace, uses reserved
 * example.test / other.test domains, and contains invented numbers.
 *
 * - C1-01: a recognized export keeps its synthetic label (is_synthetic,
 *   containsSynthetic), its property, its segments (segment_key,
 *   search_appearance), and its finality; a mixed synthetic/live file is refused.
 * - D1-R01: a LIVE workspace refuses a synthetic import (WORKSPACE_UNSAFE,
 *   nothing written); a synthetic row never supersedes a non-synthetic current
 *   row (even with --replace); a live row with the values of a synthetic
 *   current row is a new revision, never "unchanged".
 * - D1-R04: every dataset exported from a demo workspace says containsSynthetic
 *   (CSV: a `# SYNTHETIC` comment line; recommendations, opportunities, and
 *   keywords: a derived is_synthetic column), so a re-import stays synthetic.
 * - D1-R08: a `property` column is honoured in any file, not only in a
 *   recognized export.
 * - C4-08: an import into a demo workspace is stored synthetic.
 * - C4-04: Object.prototype names are not import datasets.
 * - C4-05: the default export target stays inside <workspace>/exports (no
 *   symlink escape) and an explicit --out never writes through a symlink.
 * - C1-10: `data export --out -` on a terminal shows control characters as
 *   visible markers; import stores text without control characters.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { register, stdoutExportText, stdoutIsTerminal } from '../../../src/cli/commands/data.js';
import { CliRuntime } from '../../../src/cli/runtime.js';
import { isAppError } from '../../../src/core/errors.js';
import { leadingComments, parseCsvRecords } from '../../../src/data/csv.js';
import { EXPORT_DATASET_NAMES, exportDataset, formatExport } from '../../../src/data/export.js';
import { DATA_IMPORT_VERSION, importDataset, isImportDataset } from '../../../src/data/import.js';
import { upsertKeyword } from '../../../src/integrations/dataforseo/store.js';
import { upsertRevision } from '../../../src/integrations/google/versioned.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { GA4_PROPERTY, GSC_PROPERTY, SITE_URL, eachDate, insertRow, reportsTestConfig, seedGa4Landing, seedGa4Period, seedGscPageQueries, seedGscPages, seedGscProperty, seedPage, seedRecommendation, sid } from '../../fixtures/reports/seed.js';

const contexts: TestContext[] = [];
const outside: string[] = [];
const realCheck = stdoutIsTerminal.check;
afterEach(() => {
  while (contexts.length) contexts.pop()!.cleanup();
  while (outside.length) rmSync(outside.pop()!, { recursive: true, force: true });
  stdoutIsTerminal.check = realCheck;
  process.exitCode = undefined;
});

function newCtx(profile: 'core' | 'demo' = 'core'): TestContext {
  const c = createTestContext({ config: reportsTestConfig({ profile }) });
  contexts.push(c);
  return c;
}

function outsideDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-outside-'));
  outside.push(d);
  return d;
}

function file(c: TestContext, name: string, content: string): string {
  const p = path.join(c.paths.root, name);
  writeFileSync(p, content);
  return p;
}

const OTHER_PROPERTY = 'sc-domain:other.test';
const DAYS = eachDate('2026-09-01', '2026-09-02');
const batches = (c: TestContext) => c.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ingestion_batches WHERE site_id = ?', [c.siteId])!.n;
const pageRows = (c: TestContext) =>
  c.db.all<Record<string, unknown>>('SELECT property, date, page, segment_key, country, device, search_appearance, clicks, impressions, is_final, is_synthetic FROM gsc_page_daily_current WHERE site_id = ? ORDER BY property, date, page, segment_key', [c.siteId]);
const exportCsv = (c: TestContext, dataset: string) => formatExport(exportDataset(c, dataset), 'csv');
const RAW_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
const ESC = '\u001b';
const BEL = '\u0007';

/** The error a call throws (undefined when it does not throw). */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

/** Raw files stored by imports (data/raw); a refused import stores none. */
function rawFiles(c: TestContext): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(path.join(d, e.name)) : out.push(e.name));
  };
  walk(c.paths.rawDir);
  return out;
}

describe('a LIVE workspace refuses synthetic imports (D1-R01)', () => {
  it('refuses every synthetic signal with WORKSPACE_UNSAFE before anything is written (also as a preview)', () => {
    const demo = newCtx('demo');
    seedGscPages(demo.db, demo.siteId, { dates: DAYS, pages: [{ url: `${SITE_URL}/pricing`, clicks: 6, impressions: 100, position: 5 }], synthetic: 1 });
    // A live workspace whose own rows are partly synthetic (for example seeded by an older version): its export has is_synthetic = 1 rows but no comment.
    const src = newCtx();
    seedGscPages(src.db, src.siteId, { dates: DAYS, pages: [{ url: `${SITE_URL}/pricing`, clicks: 6, impressions: 100, position: 5 }], synthetic: 1 });
    const live = newCtx();
    expect(live.synthetic).toBe(false);
    const plain = file(live, 'plain.csv', ['Date,Page,Clicks,Impressions', `2026-09-01,${SITE_URL}/pricing,6,100`].join('\n'));
    const cases: Array<[string, () => unknown, RegExp]> = [
      ['CSV export of a demo workspace', () => importDataset(live, 'gsc-pages', file(live, 'demo-export.csv', exportCsv(demo, 'gsc-pages')), { complete: true }), /2 row\(s\) of the file are marked is_synthetic = 1; the file declares itself synthetic/],
      ['JSON export of a demo workspace', () => importDataset(live, 'gsc-pages', file(live, 'demo-export.json', formatExport(exportDataset(demo, 'gsc-pages'), 'json'))), /the file declares itself synthetic/],
      ['is_synthetic = 1 rows only', () => importDataset(live, 'gsc-pages', file(live, 'rows.csv', exportCsv(src, 'gsc-pages'))), /\(2 row\(s\) of the file are marked is_synthetic = 1\)/],
      ['a "# SYNTHETIC" comment only', () => importDataset(live, 'gsc-pages', file(live, 'comment.csv', ['# SYNTHETIC fixture: invented numbers', 'Date,Page,Clicks,Impressions', `2026-09-01,${SITE_URL}/pricing,6,100`].join('\n'))), /\(the file declares itself synthetic/],
      ['--synthetic on a plain file', () => importDataset(live, 'gsc-pages', plain, { synthetic: true }), /\(--synthetic was passed\)/],
      ['--synthetic with --replace', () => importDataset(live, 'gsc-pages', plain, { synthetic: true, replace: true }), /--synthetic was passed/],
      ['a preview of a synthetic file', () => importDataset(live, 'gsc-pages', plain, { synthetic: true, preview: true }), /--synthetic was passed/],
      ['a synthetic keyword list', () => importDataset(live, 'keywords', file(live, 'keywords.json', JSON.stringify({ _synthetic: true, rows: [{ keyword: 'synthetic widget' }] }))), /the file declares itself synthetic/],
    ];
    for (const [name, run, reason] of cases) {
      const err = thrown(run);
      expect(isAppError(err) && err.code, name).toBe('WORKSPACE_UNSAFE');
      expect((err as Error).message, name).toMatch(reason);
      expect((err as Error).message, name).toMatch(/is a live workspace\. Synthetic data never mixes with live data or replaces the owner's rows; nothing was imported\./);
      expect(isAppError(err) && err.hint, name).toMatch(/demo workspace instead: `npm run demo` creates one/);
    }
    expect(batches(live)).toBe(0);
    expect(pageRows(live)).toEqual([]);
    expect(live.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM keywords WHERE site_id = ?', [live.siteId])!.n).toBe(0);
    expect(rawFiles(live)).toEqual([]);
    // The same plain file without --synthetic is the owner's live import.
    expect(importDataset(live, 'gsc-pages', plain)).toMatchObject({ status: 'succeeded', synthetic: false });
    expect(pageRows(live).map((x) => x.is_synthetic)).toEqual([0]);
  });

  it('the CLI refuses it too (exit 1, WORKSPACE_UNSAFE), and --dry-run as well', async () => {
    const live = newCtx();
    const f = file(live, 'fixture.csv', ['# SYNTHETIC fixture', 'Date,Page,Clicks,Impressions', `2026-09-01,${SITE_URL}/pricing,6,100`].join('\n'));
    for (const extra of [[], ['--dry-run']]) {
      const r = await run(live.paths.root, [...extra, 'data', 'import', 'gsc-pages', f]);
      expect(r.failed, extra.join(' ')).toBe(true);
      expect(r.err).toContain('Error [WORKSPACE_UNSAFE]');
      expect(r.err).toContain('npm run demo');
    }
    expect(batches(live)).toBe(0);
  });
});

describe('a synthetic row never supersedes live data (D1-R01)', () => {
  /** A non-synthetic current row written by an earlier owner import (source 'import'), as a workspace without a manifest could hold it. */
  function liveImportRow(c: TestContext, date: string): string {
    const batchId = sid('batch');
    insertRow(c.db, 'ingestion_batches', {
      id: batchId, site_id: c.siteId, source: 'import', dataset: 'gsc_page_daily', property: GSC_PROPERTY, date_start: date, date_end: date,
      request_json: JSON.stringify({ type: 'web', importedDataset: 'gsc-pages' }), status: 'succeeded', truncated: 0, transformation_version: DATA_IMPORT_VERSION, is_synthetic: 0,
      started_at: '2026-09-22T06:00:00.000Z', finished_at: '2026-09-22T06:00:00.000Z',
    });
    seedGscPages(c.db, c.siteId, { dates: [date], pages: [{ url: `${SITE_URL}/pricing`, clicks: 9, impressions: 150, position: 4 }], batchId });
    return batchId;
  }

  it('keeps a non-synthetic current row (an earlier import or a Google sync), even with --replace; new keys are written', () => {
    const demo = newCtx('demo');
    liveImportRow(demo, '2026-09-01');
    seedGscPages(demo.db, demo.siteId, { dates: ['2026-09-02'], pages: [{ url: `${SITE_URL}/pricing`, clicks: 8, impressions: 140, position: 4 }] }); // a Google sync
    const f = file(demo, 'synthetic.csv', ['Date,Page,Clicks,Impressions', ...['2026-09-01', '2026-09-02', '2026-09-03'].map((d) => `${d},${SITE_URL}/pricing,1,10`)].join('\n'));
    const preview = importDataset(demo, 'gsc-pages', f, { replace: true, preview: true });
    expect(preview).toMatchObject({ status: 'preview', keptNonSynthetic: 2, skippedExisting: 0 });
    for (const replace of [false, true]) {
      const r = importDataset(demo, 'gsc-pages', f, { replace });
      expect(r, `replace ${replace}`).toMatchObject({ status: 'succeeded', synthetic: true, keptNonSynthetic: 2, skippedExisting: 0 });
      expect(r.warnings.join(' ')).toMatch(/2 row\(s\) were kept: their current row is non-synthetic \(live\) data, and a synthetic row never supersedes live data \(also not with --replace\)/);
      expect(JSON.parse(demo.db.get<{ coverage_json: string }>('SELECT coverage_json FROM ingestion_batches WHERE id = ?', [r.batchId])!.coverage_json).keptNonSynthetic).toBe(2);
    }
    expect(pageRows(demo).map((x) => [x.date, x.clicks, x.is_synthetic])).toEqual([
      ['2026-09-01', 9, 0],
      ['2026-09-02', 8, 0],
      ['2026-09-03', 1, 1],
    ]);
  });

  it('a live row with the values of a synthetic current row is a new revision, never "unchanged" (the row hash is not changed)', () => {
    const live = newCtx();
    // What an older version's synthetic import left behind: a synthetic current revision under an import batch.
    const oldBatch = sid('batch');
    insertRow(live.db, 'ingestion_batches', {
      id: oldBatch, site_id: live.siteId, source: 'import', dataset: 'gsc_page_daily', property: GSC_PROPERTY, date_start: '2026-09-01', date_end: '2026-09-01',
      request_json: JSON.stringify({ type: 'web' }), status: 'succeeded', truncated: 0, transformation_version: DATA_IMPORT_VERSION, is_synthetic: 1, started_at: '2026-09-22T06:00:00.000Z', finished_at: '2026-09-22T06:00:00.000Z',
    });
    const f = file(live, 'owner.csv', ['Date,Page,Clicks,Impressions', `2026-09-01,${SITE_URL}/pricing,6,100`].join('\n'));
    // The owner's live file, first imported into a scratch context to learn the exact key/values the import writes.
    const scratch = newCtx();
    importDataset(scratch, 'gsc-pages', file(scratch, 'owner.csv', readFileSync(f, 'utf8')));
    const written = scratch.db.get<Record<string, string | number | null>>('SELECT * FROM gsc_page_daily_current WHERE site_id = ?', [scratch.siteId])!;
    const key = { property: written.property!, search_type: written.search_type!, date: written.date!, page: written.page!, segment_key: written.segment_key! };
    const values = { date_tz: written.date_tz!, country: null, device: null, search_appearance: null, clicks: 6, impressions: 100, ctr: null, position: null, aggregation_type: 'byPage', is_final: written.is_final! };
    live.db.transaction(() => upsertRevision(live.db, 'gsc_page_daily', live.siteId, key, values, { batchId: oldBatch, collectedAt: '2026-09-22T06:00:00.000Z', transformationVersion: DATA_IMPORT_VERSION, isSynthetic: true }));
    expect(live.db.get('SELECT row_hash FROM gsc_page_daily WHERE site_id = ?', [live.siteId])).toEqual({ row_hash: written.row_hash });

    const r = importDataset(live, 'gsc-pages', f);
    expect(r).toMatchObject({ status: 'succeeded', synthetic: false, counts: { received: 1, newRevisions: 1, revised: 1, unchanged: 0 } });
    expect(pageRows(live).map((x) => x.is_synthetic)).toEqual([0]);
    const revisions = live.db.all<{ revision: number; is_current: number; is_synthetic: number; row_hash: string }>('SELECT revision, is_current, is_synthetic, row_hash FROM gsc_page_daily WHERE site_id = ? ORDER BY revision', [live.siteId]);
    expect(revisions.map((x) => [x.revision, x.is_current, x.is_synthetic])).toEqual([
      [1, 0, 1],
      [2, 1, 0],
    ]);
    // The stored row-hash formula did not change: both revisions have the same hash.
    expect(new Set(revisions.map((x) => x.row_hash)).size).toBe(1);
    // A second identical live import is unchanged.
    expect(importDataset(live, 'gsc-pages', f).counts).toMatchObject({ unchanged: 1, newRevisions: 0 });
  });
});

describe('data import of a data export keeps its synthetic label (C1-01)', () => {
  it('a demo export imported into a demo workspace stays synthetic (CSV is_synthetic column); the honoured columns are not "ignored"', () => {
    const demo = newCtx('demo');
    seedGscPages(demo.db, demo.siteId, { dates: DAYS, pages: [{ url: `${SITE_URL}/pricing`, clicks: 6, impressions: 100, position: 5 }], synthetic: 1 });
    const demo2 = newCtx('demo');
    const r = importDataset(demo2, 'gsc-pages', file(demo2, 'demo-export.csv', exportCsv(demo, 'gsc-pages')), { complete: true });
    expect(r.status, JSON.stringify(r.rejected)).toBe('succeeded');
    expect(r.synthetic).toBe(true);
    expect(pageRows(demo2).map((x) => x.is_synthetic)).toEqual([1, 1]);
    expect(demo2.db.get('SELECT is_synthetic FROM ingestion_batches WHERE id = ?', [r.batchId])).toEqual({ is_synthetic: 1 });
    expect(r.warnings.join(' ')).toMatch(/Every row is stored as SYNTHETIC \(2 row\(s\) of the file are marked is_synthetic = 1; the file declares itself synthetic; this is a demo workspace\)/);
    // property, segment_key, search_appearance, is_final, and is_synthetic are honoured; provenance of the other workspace is not imported.
    expect(r.warnings).toContain('Ignored columns: date_tz, page_id, aggregation_type, revision, batch_id, collected_at, transformation_version.');
  });

  it('a JSON export with containsSynthetic: true declares the file synthetic (the envelope alone is enough)', () => {
    const demo = newCtx('demo');
    seedGscPages(demo.db, demo.siteId, { dates: DAYS, pages: [{ url: `${SITE_URL}/pricing`, clicks: 6, impressions: 100, position: 5 }], synthetic: 1 });
    const json = formatExport(exportDataset(demo, 'gsc-pages'), 'json');
    expect(JSON.parse(json).containsSynthetic).toBe(true);
    const demo2 = newCtx('demo');
    const r = importDataset(demo2, 'gsc-pages', file(demo2, 'demo-export.json', json), { complete: true });
    expect(r).toMatchObject({ status: 'succeeded', synthetic: true });
    expect(pageRows(demo2).every((x) => x.is_synthetic === 1)).toBe(true);
    // The envelope alone (rows without is_synthetic) is enough: it is named as a reason, and a live workspace refuses it.
    const envelope = JSON.parse(json);
    envelope.rows = envelope.rows.map((row: Record<string, unknown>) => ({ date: row.date, page: row.page, clicks: row.clicks, impressions: row.impressions }));
    const demo3 = newCtx('demo');
    const e = importDataset(demo3, 'gsc-pages', file(demo3, 'envelope.json', JSON.stringify(envelope)), { complete: true });
    expect(e.synthetic).toBe(true);
    expect(e.warnings.join(' ')).toMatch(/Every row is stored as SYNTHETIC \(the file declares itself synthetic; this is a demo workspace\)/);
    const live = newCtx();
    expect(thrown(() => importDataset(live, 'gsc-pages', file(live, 'envelope.json', JSON.stringify(envelope))))).toMatchObject({ code: 'WORKSPACE_UNSAFE' });
  });

  it('refuses a file that mixes synthetic and live rows unless --synthetic labels every row synthetic (a live workspace refuses it outright)', () => {
    const src = newCtx();
    seedGscPages(src.db, src.siteId, { dates: ['2026-09-01'], pages: [{ url: `${SITE_URL}/pricing`, clicks: 6, impressions: 100, position: 5 }] });
    seedGscPages(src.db, src.siteId, { dates: ['2026-09-02'], pages: [{ url: `${SITE_URL}/pricing`, clicks: 4, impressions: 90, position: 5 }], synthetic: 1 });
    const live = newCtx();
    const lf = file(live, 'mixed.csv', exportCsv(src, 'gsc-pages'));
    for (const opts of [{}, { synthetic: true }]) {
      const err = thrown(() => importDataset(live, 'gsc-pages', lf, opts));
      expect(isAppError(err) && err.code).toBe('WORKSPACE_UNSAFE');
      expect(String((err as Error).message)).toMatch(/1 row\(s\) of the file are marked is_synthetic = 1/);
    }
    expect(batches(live)).toBe(0);
    const dst = newCtx('demo');
    const f = file(dst, 'mixed.csv', exportCsv(src, 'gsc-pages'));
    const err = thrown(() => importDataset(dst, 'gsc-pages', f));
    expect(isAppError(err) && err.code).toBe('VALIDATION_FAILED');
    expect(String((err as Error).message)).toMatch(/mixes synthetic rows \(is_synthetic = 1: 1 row\(s\)\) with non-synthetic rows \(1 row\(s\)\)/);
    expect(batches(dst)).toBe(0);
    const r = importDataset(dst, 'gsc-pages', f, { synthetic: true });
    expect(r).toMatchObject({ status: 'succeeded', synthetic: true });
    expect(pageRows(dst).map((x) => x.is_synthetic)).toEqual([1, 1]);
  });

  it('an is_synthetic column is honoured in any file; an invalid value rejects the row', () => {
    const ctx = newCtx();
    const flagged = file(ctx, 'flagged.csv', ['date,page,clicks,impressions,is_synthetic', `2026-09-01,${SITE_URL}/pricing,1,10,1`].join('\n'));
    expect(thrown(() => importDataset(ctx, 'gsc-pages', flagged))).toMatchObject({ code: 'WORKSPACE_UNSAFE', message: expect.stringContaining('1 row(s) of the file are marked is_synthetic = 1') });
    const demo = newCtx('demo');
    const d = importDataset(demo, 'gsc-pages', file(demo, 'flagged.csv', readFileSync(flagged, 'utf8')));
    expect(d.synthetic).toBe(true);
    expect(d.warnings.join(' ')).toContain('1 row(s) of the file are marked is_synthetic = 1');
    const bad = importDataset(ctx, 'gsc-pages', file(ctx, 'bad-flag.csv', ['date,page,clicks,impressions,is_synthetic', `2026-09-01,${SITE_URL}/pricing,1,10,maybe`].join('\n')));
    expect(bad.status).toBe('failed');
    expect(bad.rejected[0]!.errors.join(' ')).toContain('is_synthetic must be 0 or 1');
  });
});

describe('every dataset exported from a demo workspace is labeled synthetic (D1-R04)', () => {
  /** One SYNTHETIC row in each of the ten export datasets. */
  function seedAll(c: TestContext, synthetic: 0 | 1): void {
    const pageId = seedPage(c.db, c.siteId, '/pricing');
    seedGscProperty(c.db, c.siteId, { dates: ['2026-09-01'], clicks: 10, impressions: 200, position: 8, synthetic });
    seedGscPages(c.db, c.siteId, { dates: ['2026-09-01'], pages: [{ url: `${SITE_URL}/pricing`, pageId, clicks: 6, impressions: 100, position: 5 }], synthetic });
    seedGscPageQueries(c.db, c.siteId, { dates: ['2026-09-01'], rows: [{ url: `${SITE_URL}/pricing`, pageId, query: 'synthetic widget price', clicks: 1, impressions: 10, position: 3 }], synthetic });
    const batches = seedGa4Landing(c.db, c.siteId, { dates: ['2026-09-01'], rows: [{ channel: 'google_organic', landingPage: '/pricing', pageId, sessions: 5, primary: 1, rate: 0.2, rateStatus: 'observed', rateScale: 'fraction' }], synthetic });
    insertRow(c.db, 'ga4_event_daily', {
      site_id: c.siteId, property_id: GA4_PROPERTY, date: '2026-09-01', date_tz: 'Europe/Tallinn', channel_view: 'google_organic', event_name: 'generate_lead', landing_page: '', event_count: 2, key_event_count: 2,
      is_complete: 1, revision: 1, is_current: 1, row_hash: sid('h'), batch_id: batches.google_organic, collected_at: '2026-09-22T06:00:00.000Z', transformation_version: 'test@1', is_synthetic: synthetic,
    });
    seedGa4Period(c.db, c.siteId, { start: '2026-09-01', end: '2026-09-01', channel: 'google_organic', metric: 'totalUsers', value: 6, synthetic });
    seedRecommendation(c.db, c.siteId, { pageId, createdAt: '2026-09-22T06:00:00.000Z' });
    insertRow(c.db, 'opportunities', { id: sid('opp'), site_id: c.siteId, kind: 'page', route: 'CTR_OPPORTUNITY', page_id: pageId, score: 0.5, scoring_version: 'test@1', status: 'candidate', created_at: '2026-09-22T06:00:00.000Z', updated_at: '2026-09-22T06:00:00.000Z' });
    const res = c.budgets.reserve({ siteId: c.siteId, provider: 'dataforseo', runId: 'run_all', purpose: '[SYNTHETIC] fixture task', estimate: { upperBoundMicros: 0, basis: { source: 'fixed_zero', detail: 'fixture' } }, synthetic: synthetic === 1 });
    c.budgets.reconcile(res.id, { actualMicros: 0, source: 'computed_from_usage' });
    upsertKeyword(c, { keyword: 'synthetic widget price', language: 'en', origin: 'manual' });
  }
  const DERIVED = ['recommendations', 'opportunities', 'keywords'];

  it('containsSynthetic, a `# SYNTHETIC` CSV comment, and (recommendations, opportunities, keywords) a derived is_synthetic column', () => {
    const demo = newCtx('demo');
    seedAll(demo, 1);
    expect(EXPORT_DATASET_NAMES).toHaveLength(10);
    for (const name of EXPORT_DATASET_NAMES) {
      const r = exportDataset(demo, name);
      expect(r.rowCount, name).toBeGreaterThan(0);
      expect(r, name).toMatchObject({ containsSynthetic: true, demoData: true });
      expect(r.columns, name).toContain('is_synthetic');
      expect(r.rows.every((x) => x.is_synthetic === 1), name).toBe(true);
      const csv = formatExport(r, 'csv');
      expect(csv.split('\r\n')[0], name).toMatch(/^# SYNTHETIC data - fixture or demo rows and not real measurements \(seo-agent data-export@1 .* from a demo workspace\)\. Import it only into a demo workspace\.$/);
      expect(csv.split('\r\n')[0], name).not.toContain(',');
      expect(leadingComments(csv).some((c) => /\bsynthetic\b/i.test(c)), name).toBe(true);
      // The comment is skipped by the parser: the header and rows are unchanged.
      const parsed = parseCsvRecords(csv);
      expect(parsed.header, name).toEqual(r.columns);
      expect(parsed.records.every((x) => x.is_synthetic === '1'), name).toBe(true);
      expect(JSON.parse(formatExport(r, 'json')), name).toMatchObject({ containsSynthetic: true, demoData: true });
      if (DERIVED.includes(name)) expect(r.notes.join(' '), name).toMatch(/is_synthetic is derived/);
    }
  });

  it('a live workspace exports is_synthetic 0 for the derived datasets, with no comment and containsSynthetic false', () => {
    const live = newCtx();
    seedAll(live, 0);
    for (const name of EXPORT_DATASET_NAMES) {
      const r = exportDataset(live, name);
      expect(r, name).toMatchObject({ containsSynthetic: false, demoData: false });
      expect(r.rows.every((x) => x.is_synthetic === 0), name).toBe(true);
      expect(formatExport(r, 'csv').startsWith('#'), name).toBe(false);
    }
  });

  it('a keywords export of a demo workspace is refused by a live workspace and stays synthetic in a demo one; is_synthetic is not an ignored column', () => {
    const demo = newCtx('demo');
    upsertKeyword(demo, { keyword: 'synthetic widget price', language: 'en', origin: 'dataforseo_fixture' });
    const r = exportDataset(demo, 'keywords');
    const live = newCtx();
    for (const [name, text] of [['keywords.csv', formatExport(r, 'csv')], ['keywords.json', formatExport(r, 'json')]] as const) {
      expect(thrown(() => importDataset(live, 'keywords', file(live, name, text))), name).toMatchObject({ code: 'WORKSPACE_UNSAFE' });
      const demo2 = newCtx('demo');
      const k = importDataset(demo2, 'keywords', file(demo2, name, text));
      expect(k, name).toMatchObject({ status: 'succeeded', synthetic: true });
      expect(k.warnings.join(' '), name).toMatch(/Every row is stored as SYNTHETIC \(1 row\(s\) of the file are marked is_synthetic = 1; the file declares itself synthetic; this is a demo workspace\)/);
      const ignored = k.warnings.find((w) => w.startsWith('Ignored columns:')) ?? '';
      expect(ignored, name).not.toContain('is_synthetic');
      expect(demo2.db.get('SELECT is_synthetic FROM ingestion_batches WHERE id = ?', [k.batchId]), name).toEqual({ is_synthetic: 1 });
    }
    expect(live.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM keywords WHERE site_id = ?', [live.siteId])!.n).toBe(0);
  });
});

describe('data import of a data export keeps its property, segments, and finality (C1-01)', () => {
  it("rejects rows of another Search Console property unless --property names it", () => {
    const src = newCtx();
    seedGscPages(src.db, src.siteId, { dates: DAYS, pages: [{ url: `${SITE_URL}/pricing`, clicks: 6, impressions: 100, position: 5 }], property: OTHER_PROPERTY });
    seedGscPages(src.db, src.siteId, { dates: ['2026-09-01'], pages: [{ url: `${SITE_URL}/about`, clicks: 1, impressions: 10, position: 5 }] });
    const dst = newCtx();
    const f = file(dst, 'two-properties.csv', exportCsv(src, 'gsc-pages'));
    const refused = importDataset(dst, 'gsc-pages', f);
    expect(refused.status).toBe('failed');
    expect(refused.rejected).toHaveLength(2);
    expect(refused.rejected[0]!.errors.join(' ')).toContain(`property "${OTHER_PROPERTY}" differs from the target property "${GSC_PROPERTY}"`);
    expect(pageRows(dst)).toEqual([]);
    // --skip-invalid: only the configured property's row is stored.
    const partial = importDataset(dst, 'gsc-pages', f, { skipInvalid: true });
    expect(partial.status).toBe('partial');
    expect(pageRows(dst).map((x) => [x.property, x.page])).toEqual([[GSC_PROPERTY, `${SITE_URL}/about`]]);
    // --property names the other property: its rows are stored under it (and the configured property's row is now the rejected one).
    const other = importDataset(dst, 'gsc-pages', f, { property: OTHER_PROPERTY, skipInvalid: true });
    expect(other.accepted).toBe(2);
    expect(dst.db.get('SELECT property FROM ingestion_batches WHERE id = ?', [other.batchId])).toEqual({ property: OTHER_PROPERTY });
    expect(pageRows(dst).filter((x) => x.property === OTHER_PROPERTY)).toHaveLength(2);
  });

  it('honours a property column in ANY file, not only a recognized export (D1-R08)', () => {
    const ctx = newCtx();
    // Not an export: an edited file with only some columns, one row of another property and one of the target property.
    const f = file(ctx, 'edited.csv', ['Date,Page,Clicks,Impressions,Property', `2026-09-01,${SITE_URL}/pricing,6,100,${OTHER_PROPERTY}`, `2026-09-01,${SITE_URL}/about,1,10,${GSC_PROPERTY}`, `2026-09-02,${SITE_URL}/about,2,20,`].join('\n'));
    const refused = importDataset(ctx, 'gsc-pages', f);
    expect(refused.status).toBe('failed');
    expect(refused.rejected).toEqual([{ row: 2, errors: [expect.stringContaining(`property "${OTHER_PROPERTY}" differs from the target property "${GSC_PROPERTY}"`)] }]);
    expect(refused.warnings.join(' ')).not.toMatch(/Ignored columns: .*property/i);
    expect(pageRows(ctx)).toEqual([]);
    // The rows of the target property (and a row with an empty property) are imported with --skip-invalid.
    const partial = importDataset(ctx, 'gsc-pages', f, { skipInvalid: true });
    expect(partial).toMatchObject({ status: 'partial', accepted: 2 });
    expect(pageRows(ctx).map((x) => [x.property, x.date, x.page])).toEqual([
      [GSC_PROPERTY, '2026-09-01', `${SITE_URL}/about`],
      [GSC_PROPERTY, '2026-09-02', `${SITE_URL}/about`],
    ]);
    // --property names the other property: its row is stored under it.
    const other = importDataset(ctx, 'gsc-pages', file(ctx, 'other.csv', ['Date,Page,Clicks,Impressions,Property', `2026-09-01,${SITE_URL}/pricing,6,100,${OTHER_PROPERTY}`].join('\n')), { property: OTHER_PROPERTY });
    expect(other.status).toBe('succeeded');
    expect(pageRows(ctx).filter((x) => x.property === OTHER_PROPERTY).map((x) => x.page)).toEqual([`${SITE_URL}/pricing`]);
  });

  it('keeps country/device and search-appearance rows in their own segment: they never become page totals', () => {
    const src = newCtx();
    seedGscPages(src.db, src.siteId, {
      dates: ['2026-09-01'],
      pages: [
        { url: `${SITE_URL}/pricing`, clicks: 9, impressions: 150, position: 5 },
        { url: `${SITE_URL}/pricing`, clicks: 2, impressions: 30, position: 4, segmentKey: 'country=usa;device=MOBILE', country: 'usa', device: 'MOBILE' },
      ],
    });
    // 09-02 has ONLY a search-appearance breakdown row: it must not become the page total of that day.
    seedGscPages(src.db, src.siteId, { dates: DAYS, pages: [{ url: `${SITE_URL}/pricing`, clicks: 1, impressions: 20, position: 3, segmentKey: 'searchAppearance=VIDEO' }] });
    src.db.run("UPDATE gsc_page_daily SET search_appearance = 'VIDEO' WHERE site_id = ? AND segment_key = 'searchAppearance=VIDEO'", [src.siteId]);
    const dst = newCtx();
    const r = importDataset(dst, 'gsc-pages', file(dst, 'segments.csv', exportCsv(src, 'gsc-pages')), { complete: true });
    expect(r.status, JSON.stringify(r.rejected)).toBe('succeeded');
    expect(pageRows(dst)).toEqual(pageRows(src));
    expect(dst.db.all("SELECT date FROM gsc_page_daily_current WHERE site_id = ? AND segment_key = ''", [dst.siteId])).toEqual([{ date: '2026-09-01' }]);
    expect(r.warnings.join(' ')).toMatch(/3 row\(s\) are a country\/device\/search-appearance breakdown/);
    // The recorded coverage scope keeps the shapes apart.
    const cov = JSON.parse(dst.db.get<{ coverage_json: string }>('SELECT coverage_json FROM ingestion_batches WHERE id = ?', [r.batchId])!.coverage_json);
    expect(cov.importScope.datesByShape).toEqual({ '': ['2026-09-01'], 'country,device': ['2026-09-01'], searchAppearance: ['2026-09-01', '2026-09-02'] });
  });

  it('rejects a segment_key that contradicts the country/device columns; refuses segments in property totals and query rows as page totals', () => {
    const ctx = newCtx();
    const bad = importDataset(ctx, 'gsc-pages', file(ctx, 'contradiction.csv', ['date,page,clicks,impressions,country,segment_key', `2026-09-01,${SITE_URL}/pricing,1,10,est,country=usa`].join('\n')));
    expect(bad.status).toBe('failed');
    expect(bad.rejected[0]!.errors.join(' ')).toContain('country "est" does not match the segment_key "country=usa"');
    expect(() => importDataset(ctx, 'gsc-property', file(ctx, 'prop-seg.csv', ['date,clicks,impressions,segment_key', '2026-09-01,1,10,searchAppearance=VIDEO'].join('\n')))).toThrow(/property totals without segments/);
    const src = newCtx();
    seedGscPageQueries(src.db, src.siteId, { dates: ['2026-09-01'], rows: [{ url: `${SITE_URL}/pricing`, query: 'synthetic widget price', clicks: 1, impressions: 10, position: 3 }] });
    expect(() => importDataset(ctx, 'gsc-pages', file(ctx, 'queries-export.csv', exportCsv(src, 'gsc-queries')))).toThrow(/query rows.*never page totals: import the file as gsc-queries/);
    expect(() => importDataset(ctx, 'gsc-property', file(ctx, 'pages-as-property.csv', ['date,page,clicks,impressions', `2026-09-01,${SITE_URL}/pricing,1,10`].join('\n')))).toThrow(/page rows.*import the file as gsc-pages/);
    // Refused files and rejected rows write nothing.
    expect(batches(ctx)).toBe(0);
    expect(pageRows(ctx)).toEqual([]);
  });

  it('a row that was not final in the exporting workspace stays not final', () => {
    const src = newCtx();
    seedGscPages(src.db, src.siteId, { dates: DAYS, pages: [{ url: `${SITE_URL}/pricing`, clicks: 6, impressions: 100, position: 5 }] });
    src.db.run("UPDATE gsc_page_daily SET is_final = 0 WHERE site_id = ? AND date = '2026-09-02'", [src.siteId]);
    const dst = newCtx();
    const r = importDataset(dst, 'gsc-pages', file(dst, 'finality.csv', exportCsv(src, 'gsc-pages')), { complete: true });
    expect(pageRows(dst).map((x) => [x.date, x.is_final])).toEqual([
      ['2026-09-01', 1],
      ['2026-09-02', 0],
    ]);
    expect(r.warnings.join(' ')).toMatch(/1 row\(s\) were not final in the exporting workspace/);
  });
});

describe('data import into a demo workspace (C4-08)', () => {
  it('stores Search Console rows and keyword batches as synthetic', () => {
    const demo = newCtx('demo');
    expect(demo.synthetic).toBe(true);
    const r = importDataset(demo, 'gsc-pages', file(demo, 'pages.csv', ['Date,Page,Clicks,Impressions', `2026-09-01,${SITE_URL}/pricing,6,100`].join('\n')));
    expect(r).toMatchObject({ status: 'succeeded', synthetic: true });
    expect(pageRows(demo).map((x) => x.is_synthetic)).toEqual([1]);
    expect(r.warnings.join(' ')).toContain('this is a demo workspace');
    const k = importDataset(demo, 'keywords', file(demo, 'keywords.csv', ['Keyword,Search volume', 'synthetic widget,100'].join('\n')));
    expect(k).toMatchObject({ status: 'succeeded', synthetic: true });
    expect(demo.db.get('SELECT is_synthetic FROM ingestion_batches WHERE id = ?', [k.batchId])).toEqual({ is_synthetic: 1 });
    expect(exportDataset(demo, 'gsc-pages').containsSynthetic).toBe(true);
  });
});

async function run(root: string, args: string[]): Promise<{ out: string; err: string; failed: boolean }> {
  const out: string[] = [];
  const err: string[] = [];
  const cli = new CliRuntime({ out: (t) => void out.push(t), err: (t) => void err.push(t) }, { ...process.env, SEO_AGENT_WORKSPACE: root });
  const program = new Command();
  program.exitOverride().option('-w, --workspace <dir>').option('-s, --site <id>').option('--dry-run').option('--json').option('--mode <mode>').option('--offline').configureOutput({ writeErr: (s) => err.push(s), writeOut: (s) => out.push(s) });
  register(program, cli);
  let failed = false;
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'seo-agent', '--workspace', root, '--offline', ...args]);
  } catch {
    failed = true;
  }
  failed = failed || Number(process.exitCode ?? 0) !== 0;
  process.exitCode = undefined;
  return { out: out.join('\n'), err: err.join('\n'), failed };
}

describe('data import: Object.prototype names are not datasets (C4-04)', () => {
  it('`__proto__`, `constructor`, `toString`, and `hasOwnProperty` fail with VALIDATION_FAILED and write nothing', async () => {
    const ctx = newCtx();
    const f = file(ctx, 'keywords.csv', ['keyword', 'synthetic widget'].join('\n'));
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(isImportDataset(name)).toBe(false);
      let err: unknown;
      try {
        importDataset(ctx, name, f);
      } catch (e) {
        err = e;
      }
      expect(isAppError(err) && err.code, name).toBe('VALIDATION_FAILED');
      const cli = await run(ctx.paths.root, ['data', 'import', name, f]);
      expect(cli.failed, name).toBe(true);
      expect(cli.err).toContain('Error [VALIDATION_FAILED]: Unknown import dataset');
    }
    expect(isImportDataset('keywords')).toBe(true);
    expect(batches(ctx)).toBe(0);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM keywords WHERE site_id = ?', [ctx.siteId])!.n).toBe(0);
  });
});

describe('data export target (C4-05)', () => {
  it('writes the default export inside <workspace>/exports/data atomically with mode 0600', async () => {
    const ctx = newCtx();
    seedGscPages(ctx.db, ctx.siteId, { dates: DAYS, pages: [{ url: `${SITE_URL}/pricing`, clicks: 6, impressions: 100, position: 5 }] });
    const r = await run(ctx.paths.root, ['--json', 'data', 'export', 'gsc-pages']);
    expect(r.failed, r.err).toBe(false);
    const target = JSON.parse(r.out).file as string;
    expect(target).toBe(path.join(ctx.paths.exportsDir, 'data', 'test-site-gsc-pages-start-latest.csv'));
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(target)).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('refuses a symlinked exports/data folder that points outside the workspace', async () => {
    const ctx = newCtx();
    seedGscPages(ctx.db, ctx.siteId, { dates: DAYS, pages: [{ url: `${SITE_URL}/pricing`, clicks: 6, impressions: 100, position: 5 }] });
    const away = outsideDir();
    mkdirSync(ctx.paths.exportsDir, { recursive: true });
    symlinkSync(away, path.join(ctx.paths.exportsDir, 'data'));
    const r = await run(ctx.paths.root, ['data', 'export', 'gsc-pages']);
    expect(r.failed).toBe(true);
    expect(r.err).toContain('UNSAFE_PATH');
    expect(readdirSync(away)).toEqual([]);
  });

  it('refuses a symlink at the default file name (never overwrites the link target) and an explicit --out symlink', async () => {
    const ctx = newCtx();
    seedGscPages(ctx.db, ctx.siteId, { dates: DAYS, pages: [{ url: `${SITE_URL}/pricing`, clicks: 6, impressions: 100, position: 5 }] });
    const away = outsideDir();
    const victim = path.join(away, 'victim.csv');
    writeFileSync(victim, 'original synthetic content\n');
    const dataDir = path.join(ctx.paths.exportsDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    const link = path.join(dataDir, 'test-site-gsc-pages-start-latest.csv');
    symlinkSync(victim, link);
    const r = await run(ctx.paths.root, ['data', 'export', 'gsc-pages']);
    expect(r.failed).toBe(true);
    expect(r.err).toContain('UNSAFE_PATH');
    expect(readFileSync(victim, 'utf8')).toBe('original synthetic content\n');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    const outLink = path.join(ctx.paths.root, 'chosen.csv');
    symlinkSync(victim, outLink);
    const explicit = await run(ctx.paths.root, ['data', 'export', 'gsc-pages', '--out', outLink]);
    expect(explicit.failed).toBe(true);
    expect(explicit.err).toMatch(/UNSAFE_PATH.*symbolic link/);
    expect(readFileSync(victim, 'utf8')).toBe('original synthetic content\n');
    // An explicit regular file path is still the owner's choice.
    const plain = path.join(ctx.paths.root, 'plain.csv');
    expect((await run(ctx.paths.root, ['data', 'export', 'gsc-pages', '--out', plain])).failed).toBe(false);
    expect(existsSync(plain)).toBe(true);
  });
});

describe('control characters (C1-10)', () => {
  const HOSTILE_QUERY = `synthetic widget${ESC}]0;owned${BEL}${ESC}[2K\u009b31m\rprice`;

  it('`data export --out -` on a terminal shows control characters as visible markers; piped output stays exact', async () => {
    const ctx = newCtx();
    seedGscPageQueries(ctx.db, ctx.siteId, { dates: ['2026-09-01'], rows: [{ url: `${SITE_URL}/pricing`, query: HOSTILE_QUERY, clicks: 1, impressions: 10, position: 3 }] });
    stdoutIsTerminal.check = () => true;
    const tty = await run(ctx.paths.root, ['data', 'export', 'gsc-queries', '--out', '-']);
    expect(tty.failed, tty.err).toBe(false);
    expect(tty.out).not.toMatch(RAW_CONTROL);
    expect(tty.out).toContain('synthetic widget[U+001B]]0;owned[U+0007][U+001B][2K[U+009B]31m[U+000D]price');
    expect(tty.out.split('\n')[0]).toMatch(/^property,search_type,date/);
    expect(tty.out).not.toContain('[U+000D]\n'); // CRLF row ends became plain newlines
    expect(tty.err).toContain('shown as visible [U+XXXX] markers');
    stdoutIsTerminal.check = () => false;
    const piped = await run(ctx.paths.root, ['data', 'export', 'gsc-queries', '--out', '-']);
    expect(piped.out).toContain(HOSTILE_QUERY);
    expect(piped.err).toBe('');
    expect(stdoutExportText('a,b\r\nx,y\r\n', false)).toEqual({ text: 'a,b\r\nx,y', marked: false });
    expect(stdoutExportText('a,b\r\nx,y\r\n', true)).toEqual({ text: 'a,b\nx,y', marked: false });
  });

  it('data import replaces control characters in cell text with spaces before storing, and says so', () => {
    const ctx = newCtx('demo'); // the files below declare themselves synthetic: a live workspace would refuse them
    const q = importDataset(ctx, 'gsc-queries', file(ctx, 'queries.json', JSON.stringify({ _synthetic: true, rows: [{ date: '2026-09-01', page: `${SITE_URL}/pricing`, query: HOSTILE_QUERY, clicks: 1, impressions: 10 }] })));
    expect(q.status, JSON.stringify(q.rejected)).toBe('succeeded');
    const stored = ctx.db.get<{ query: string }>('SELECT query FROM gsc_page_query_daily_current WHERE site_id = ?', [ctx.siteId])!.query;
    expect(stored).not.toMatch(RAW_CONTROL);
    expect(stored).toBe('synthetic widget ]0;owned  [2K 31m price');
    expect(q.warnings.join(' ')).toMatch(/1 cell\(s\) contained control characters/);
    const k = importDataset(ctx, 'keywords', file(ctx, 'keywords.json', JSON.stringify({ _synthetic: true, rows: [{ keyword: `widget${ESC}[8m hidden` }] })));
    expect(k.status).toBe('succeeded');
    expect(ctx.db.all<{ keyword: string }>('SELECT keyword FROM keywords WHERE site_id = ?', [ctx.siteId]).map((x) => x.keyword)).toEqual(['widget [8m hidden']);
  });
});
