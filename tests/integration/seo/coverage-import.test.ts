/**
 * B3-02: `data import` batches count as Search Console coverage (spec 6:
 * missing, incomplete, and actual zero are different states; spec 11).
 * C1-05: a re-import with --complete whose rows are all unchanged still covers
 * its range. C1-04: dates known only from imports without --complete stay
 * truncated for reports but are re-collected by the next Search Console sync.
 *
 * SYNTHETIC data only: the CSV files are written by this test into a temporary
 * workspace, use the reserved example.test domain, and contain invented numbers.
 * They are imported as the owner's live import (no --synthetic): a live
 * workspace refuses a synthetic import (D1-R01), and coverage does not depend
 * on the synthetic label.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importDataset } from '../../../src/data/import.js';
import { computeGscRange } from '../../../src/integrations/google/gsc-sync.js';
import { coverageGaps, gscCoverage } from '../../../src/seo/coverage.js';
import { gscPageMetrics } from '../../../src/seo/metrics.js';
import { UrlReconciler } from '../../../src/seo/reconcile.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { GSC_PROPERTY, SITE_URL, eachDate, insertRow, reportsTestConfig, seedBatch, seedGscProperty, sid } from '../../fixtures/reports/seed.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const START = '2026-09-01';
const END = '2026-09-03';

/** /pricing has a row every day; /blog/guide only on the first day (absent from the file afterwards). */
const PAGES_CSV = [
  'Date,Page,Clicks,Impressions,CTR,Position',
  `2026-09-01,${SITE_URL}/pricing,6,100,6%,5.2`,
  `2026-09-02,${SITE_URL}/pricing,4,90,4.44%,5.8`,
  `2026-09-03,${SITE_URL}/pricing,5,95,5.26%,5.5`,
  `2026-09-01,${SITE_URL}/blog/guide,2,40,5%,12.5`,
].join('\n');

function importPages(c: TestContext, complete: boolean): { guide: string; pricing: string; batchId: string } {
  const file = path.join(c.paths.root, 'pages.csv');
  writeFileSync(file, PAGES_CSV);
  const r = importDataset(c, 'gsc-pages', file, complete ? { complete: true } : {});
  expect(r.status).toBe('succeeded');
  new UrlReconciler(c.db, c.siteId, c.config, c.clock).run({ dryRun: false });
  const id = (p: string) => c.db.get<{ id: string }>('SELECT id FROM pages WHERE site_id = ? AND url = ?', [c.siteId, `${SITE_URL}${p}`])!.id;
  return { guide: id('/blog/guide'), pricing: id('/pricing'), batchId: r.batchId! };
}

const scope = { property: GSC_PROPERTY, searchType: 'web', segmentKey: '', start: START, end: END };

describe('Search Console coverage includes owner imports (B3-02)', () => {
  it('an import WITHOUT --complete makes a page absent from the file incomplete, never an observed zero', () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const { guide, pricing } = importPages(ctx, false);
    const cov = gscCoverage(ctx.db, ctx.siteId, { dataset: 'gsc_page_daily', ...scope });
    expect(cov.truncated).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    const g = gscPageMetrics(ctx.db, ctx.siteId, guide, scope);
    expect(g.completeness).toBe('incomplete');
    expect(g.clicks).toEqual({ status: 'incomplete', reason: expect.stringMatching(/2 date\(s\) hit a row limit or were not fully collected \(for example an import without --complete\)/), partialValue: 2 });
    expect(g.datesTruncated).toEqual(['2026-09-02', '2026-09-03']);
    // A page with a row on every date is fully known.
    expect(gscPageMetrics(ctx.db, ctx.siteId, pricing, scope).clicks).toEqual({ status: 'observed', value: 15 });
  });

  it('an import WITH --complete makes the same absence an observed zero (the owner asserted completeness)', () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const { guide } = importPages(ctx, true);
    const cov = gscCoverage(ctx.db, ctx.siteId, { dataset: 'gsc_page_daily', ...scope });
    expect(cov.truncated).toEqual([]);
    expect(cov.final).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    const g = gscPageMetrics(ctx.db, ctx.siteId, guide, scope);
    expect(g.completeness).toBe('complete');
    expect(g.clicks).toEqual({ status: 'observed', value: 2 });
    expect(g.impressions).toEqual({ status: 'observed', value: 40 });
  });

  it('an import proves nothing for a date it has no rows for (without --complete) or for another segment shape', () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const file = path.join(ctx.paths.root, 'sparse.csv');
    writeFileSync(file, ['Date,Page,Clicks,Impressions,CTR,Position', `2026-09-01,${SITE_URL}/pricing,6,100,6%,5.2`, `2026-09-03,${SITE_URL}/pricing,5,95,5.26%,5.5`].join('\n'));
    importDataset(ctx, 'gsc-pages', file);
    const cov = gscCoverage(ctx.db, ctx.siteId, { dataset: 'gsc_page_daily', ...scope });
    // 09-02 has no row in a non-complete import: not collected (missing), which a sync can backfill.
    expect(cov.byDate['2026-09-02']).toEqual({ state: 'missing', truncated: false });
    // 09-01 is known only from an import without --complete: truncated for reports, re-collectable for a sync.
    expect(cov.byDate['2026-09-01']).toEqual({ state: 'final', truncated: true, importOnly: true });
    // The import wrote no-segment rows only: it says nothing about a country segment slice.
    const seg = gscCoverage(ctx.db, ctx.siteId, { dataset: 'gsc_page_daily', ...scope, segmentKey: 'country=est' });
    expect(seg.missing).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
  });
});

describe('--complete on a re-import whose rows are unchanged (C1-05)', () => {
  it('a re-import of the same file with --complete covers its whole range although it writes no new revision', () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const { guide } = importPages(ctx, false);
    expect(gscCoverage(ctx.db, ctx.siteId, { dataset: 'gsc_page_daily', ...scope }).truncated).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    const again = importDataset(ctx, 'gsc-pages', path.join(ctx.paths.root, 'pages.csv'), { complete: true });
    expect(again.status).toBe('succeeded');
    expect(again.counts).toMatchObject({ received: 4, newRevisions: 0, unchanged: 4 });
    // The batch owns no row, but recorded the dates it saw (unchanged rows included) per segment shape.
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM gsc_page_daily WHERE site_id = ? AND batch_id = ?', [ctx.siteId, again.batchId])!.n).toBe(0);
    const cov = JSON.parse(ctx.db.get<{ coverage_json: string }>('SELECT coverage_json FROM ingestion_batches WHERE id = ?', [again.batchId])!.coverage_json);
    expect(cov.importScope).toEqual({ datesByShape: { '': ['2026-09-01', '2026-09-02', '2026-09-03'] } });
    const after = gscCoverage(ctx.db, ctx.siteId, { dataset: 'gsc_page_daily', ...scope });
    expect(after.truncated).toEqual([]);
    expect(after.final).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    // The owner's completeness assertion now applies: /blog/guide absent on 09-02 and 09-03 is an observed zero.
    expect(gscPageMetrics(ctx.db, ctx.siteId, guide, scope).clicks).toEqual({ status: 'observed', value: 2 });
  });

  it('says so when the completeness assertion cannot apply (invalid rows skipped: a partial batch)', () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const file = path.join(ctx.paths.root, 'with-bad-row.csv');
    writeFileSync(file, [PAGES_CSV, '2026-09-02,not-a-url,1,10,,'].join('\n'));
    const r = importDataset(ctx, 'gsc-pages', file, { complete: true, skipInvalid: true });
    expect(r.status).toBe('partial');
    expect(r.warnings.join(' ')).toMatch(/Completeness \(--complete\) was NOT applied: 1 invalid row\(s\) were skipped/);
    expect(gscCoverage(ctx.db, ctx.siteId, { dataset: 'gsc_page_daily', ...scope }).truncated).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
  });

  it('an older complete property-totals import that recorded no dates and owns no rows falls back to its date range; a segmented one proves nothing', () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const legacy = (dataset: string) =>
      insertRow(ctx!.db, 'ingestion_batches', {
        id: sid('batch'), site_id: ctx!.siteId, source: 'import', dataset, property: GSC_PROPERTY, date_start: START, date_end: END,
        request_json: JSON.stringify({ type: 'web', importedDataset: 'legacy', completeness: 'owner_asserted' }), status: 'succeeded', truncated: 0,
        coverage_json: JSON.stringify({ warnings: ['legacy synthetic batch'] }), transformation_version: 'data-import@1', is_synthetic: 1, started_at: '2026-09-22T06:00:00.000Z', finished_at: '2026-09-22T06:00:00.000Z',
      });
    legacy('gsc_property_daily');
    legacy('gsc_page_daily');
    expect(gscCoverage(ctx.db, ctx.siteId, { dataset: 'gsc_property_daily', ...scope }).missing).toEqual([]);
    expect(gscCoverage(ctx.db, ctx.siteId, { dataset: 'gsc_page_daily', ...scope }).missing).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
  });
});

describe('sync planning re-collects dates known only from an incomplete import (C1-04)', () => {
  const TODAY = '2026-09-24';
  const WINDOW_START = '2026-06-26'; // 90 days (initialHistoryDays) ending yesterday
  const IMPORT_DAYS = eachDate('2026-09-01', '2026-09-13');

  function setup(complete: boolean): TestContext {
    const c = createTestContext({ config: reportsTestConfig() });
    // Property totals were synced through 09-13 (so the next sync is incremental from the refresh window, 09-14).
    seedGscProperty(c.db, c.siteId, { dates: eachDate(WINDOW_START, '2026-09-13'), clicks: 10, impressions: 200, position: 8 });
    // Page totals were synced up to 08-31; 09-01..09-13 come only from an owner import (one page per day).
    seedBatch(c.db, c.siteId, { source: 'gsc', dataset: 'gsc_page_daily', property: GSC_PROPERTY, start: WINDOW_START, end: '2026-08-31' });
    const file = path.join(c.paths.root, 'ui-pages.csv');
    writeFileSync(file, ['Date,Page,Clicks,Impressions', ...IMPORT_DAYS.map((d) => `${d},${SITE_URL}/pricing,3,50`)].join('\n'));
    expect(importDataset(c, 'gsc-pages', file, complete ? { complete: true } : {}).status).toBe('succeeded');
    return c;
  }

  it('after an import without --complete, computeGscRange backfills the page dataset over the import-only dates; reports still see them truncated', () => {
    ctx = setup(false);
    const plan = computeGscRange(ctx, GSC_PROPERTY, 'web', TODAY, undefined, { includePageQuery: false });
    expect(plan.mode).toBe('incremental');
    expect(plan.datasets).toEqual([
      { dataset: 'gsc_property_daily', start: '2026-09-14', backfillFrom: null, gapDates: 0 },
      { dataset: 'gsc_page_daily', start: '2026-09-01', backfillFrom: '2026-09-01', gapDates: 13 },
    ]);
    expect(plan.start).toBe('2026-09-01');
    const cov = gscCoverage(ctx.db, ctx.siteId, { dataset: 'gsc_page_daily', property: GSC_PROPERTY, searchType: 'web', segmentKey: '', start: '2026-09-01', end: '2026-09-13' });
    expect(cov.truncated).toEqual(IMPORT_DAYS);
    expect(cov.missing).toEqual([]);
    expect(coverageGaps(cov)).toEqual(IMPORT_DAYS);
  });

  it('once a sync covers those dates they are no longer import-only (no endless backfill)', () => {
    ctx = setup(false);
    seedBatch(ctx.db, ctx.siteId, { source: 'gsc', dataset: 'gsc_page_daily', property: GSC_PROPERTY, start: '2026-09-01', end: '2026-09-13' });
    const plan = computeGscRange(ctx, GSC_PROPERTY, 'web', TODAY, undefined, { includePageQuery: false });
    expect(plan.datasets?.find((d) => d.dataset === 'gsc_page_daily')).toEqual({ dataset: 'gsc_page_daily', start: '2026-09-14', backfillFrom: null, gapDates: 0 });
  });

  it('an import WITH --complete is not re-collected', () => {
    ctx = setup(true);
    const plan = computeGscRange(ctx, GSC_PROPERTY, 'web', TODAY, undefined, { includePageQuery: false });
    expect(plan.datasets?.find((d) => d.dataset === 'gsc_page_daily')).toEqual({ dataset: 'gsc_page_daily', start: '2026-09-14', backfillFrom: null, gapDates: 0 });
  });
});
