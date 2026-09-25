/**
 * Freshness in a workspace that fills Search Console datasets with owner
 * imports (`data import`, the alternative to the integration, spec 2.14)
 * (D1-R06): one freshness entry per source and dataset, unique claim ids, and
 * no claim-contract issues. SYNTHETIC data only (demo-profile workspace,
 * reserved example.test domain, invented numbers).
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eachDate } from '../../../src/core/time.js';
import { importDataset } from '../../../src/data/import.js';
import { buildWeeklyReport } from '../../../src/reports/build.js';
import { allClaims } from '../../../src/reports/model.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { GSC_PROPERTY, SITE_URL, WEEK, reportsTestConfig, seedBatch } from '../../fixtures/reports/seed.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

/** A demo-profile workspace (Search Console enabled, never synced) with one owner import of page totals. */
async function importOnlyWorkspace(): Promise<{ c: TestContext; batchId: string }> {
  // A demo workspace: synthetic test files are imported there (a live workspace refuses them).
  const c = createTestContext({ config: reportsTestConfig({ profile: 'demo' }) });
  expect(c.settings.features.gsc).toBe(true);
  const file = path.join(c.paths.root, 'pages.csv');
  writeFileSync(file, ['# SYNTHETIC test export (invented numbers)', 'Date,Page,Clicks,Impressions,CTR,Position', ...eachDate(WEEK.start, WEEK.end).map((d) => `${d},${SITE_URL}/imported-page,1,10,10%,8.0`)].join('\n'));
  const imp = importDataset(c, 'gsc-pages', file, { synthetic: true, complete: true });
  expect(imp.status).toBe('succeeded');
  return { c, batchId: imp.batchId! };
}

describe('import-only freshness (D1-R06)', () => {
  it('Search Console enabled but never synced, one import batch: no duplicate freshness claim ids and no contract issues', async () => {
    const w = await importOnlyWorkspace();
    ctx = w.c;
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    expect(b.issues).toEqual([]);
    const fresh = b.report.sections.find((s) => s.key === 'freshness')!.claims;
    const ids = fresh.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(allClaims(b.report).filter((c) => c.id.startsWith('freshness.')).map((c) => c.id).sort()).toEqual(ids.slice().sort());
    // The imported dataset is described by the import entry (source and dataset in the id), not as "never synced".
    const imported = fresh.find((c) => c.id === 'freshness.import.gsc_page_daily')!;
    expect(imported).toMatchObject({ label: 'OBSERVED', evidenceStatus: 'supported' });
    expect(imported.sourceIds).toContain(`ingestion_batches:${w.batchId}`);
    expect(ids).not.toContain('freshness.gsc.gsc_page_daily');
    expect(b.report.data.dataQuality!.some((d) => d.code === 'never_synced_gsc_page_daily')).toBe(false);
    // A dataset no source filled is still "never synced".
    expect(fresh.find((c) => c.id === 'freshness.gsc.gsc_property_daily')).toMatchObject({ label: 'DATA_UNAVAILABLE', text: 'gsc gsc_property_daily: never synced.' });
    expect(b.report.data.dataQuality!.some((d) => d.code === 'never_synced_gsc_property_daily')).toBe(true);
    expect(b.report.data.freshness!.filter((e) => e.dataset === 'gsc_page_daily').map((e) => e.source)).toEqual(['import']);
  });

  it('a sync and an import of the same dataset are separate entries with separate claim ids', async () => {
    const w = await importOnlyWorkspace();
    ctx = w.c;
    const synced = seedBatch(ctx.db, ctx.siteId, { source: 'gsc', dataset: 'gsc_page_daily', property: GSC_PROPERTY, start: WEEK.start, end: WEEK.end, synthetic: 1 });
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    expect(b.issues).toEqual([]);
    const fresh = b.report.sections.find((s) => s.key === 'freshness')!.claims;
    expect(new Set(fresh.map((c) => c.id)).size).toBe(fresh.length);
    expect(fresh.find((c) => c.id === 'freshness.gsc.gsc_page_daily')!.sourceIds).toContain(`ingestion_batches:${synced}`);
    expect(fresh.find((c) => c.id === 'freshness.import.gsc_page_daily')!.sourceIds).toContain(`ingestion_batches:${w.batchId}`);
    expect(b.report.data.freshness!.filter((e) => e.dataset === 'gsc_page_daily').map((e) => e.source).sort()).toEqual(['gsc', 'import']);
  });
});
