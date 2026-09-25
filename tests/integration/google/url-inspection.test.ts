import { afterEach, describe, expect, it } from 'vitest';
import { createFixtureGoogleAuthProvider } from '../../../src/integrations/google/fixture-provider.js';
import { URL_INSPECTION_TRANSFORMATION_VERSION, inspectUrls, selectPriorityUrls } from '../../../src/integrations/google/url-inspection.js';
import type { TestContext } from '../../helpers/context.js';
import { GOOGLE_FIXTURES, SYNTHETIC_GA4, SYNTHETIC_PROPERTY, googleConfig, googleTestContext } from './_helpers.js';

/** SYNTHETIC Search Console rows and fixture inspections (example.test only). */
const NOW = '2026-09-24T09:00:00.000Z';
let ctx: TestContext;
afterEach(() => ctx?.cleanup());

function pageRow(page: string, clicks: number, extra: { property?: string; searchType?: string; segmentKey?: string } = {}): void {
  ctx.db.run(
    `INSERT INTO gsc_page_daily (site_id, property, search_type, date, date_tz, page, segment_key, clicks, impressions, aggregation_type, is_final, revision, is_current, row_hash, batch_id, collected_at, transformation_version, is_synthetic)
     VALUES (?, ?, ?, '2026-09-20', 'America/Los_Angeles', ?, ?, ?, ?, 'byPage', 1, 1, 1, ?, 'ingb_synthetic', ?, 'test@1', 1)`,
    [ctx.siteId, extra.property ?? SYNTHETIC_PROPERTY, extra.searchType ?? 'web', page, extra.segmentKey ?? '', clicks, clicks * 10, `${page}|${extra.property ?? ''}|${extra.searchType ?? ''}|${extra.segmentKey ?? ''}`, NOW],
  );
}

describe('URL Inspection selection and provenance', () => {
  it('ranks priority URLs only within the configured property, primary search type, and unsegmented rows', () => {
    ctx = googleTestContext({ now: NOW });
    ctx.db.run(
      `INSERT INTO ingestion_batches (id, site_id, source, dataset, property, date_start, date_end, request_json, status, transformation_version, is_synthetic, started_at)
       VALUES ('ingb_synthetic', ?, 'gsc', 'gsc_page_daily', ?, '2026-09-20', '2026-09-20', '{"_synthetic":true}', 'succeeded', 'test@1', 1, ?)`,
      [ctx.siteId, SYNTHETIC_PROPERTY, NOW],
    );
    pageRow('https://www.example.test/scoped', 5);
    pageRow('https://www.example.test/segmented', 900, { segmentKey: 'device=MOBILE' });
    pageRow('https://www.example.test/image-search', 800, { searchType: 'image' });
    pageRow('https://www.example.test/other-property', 700, { property: 'https://www.example.test/' });
    expect(selectPriorityUrls(ctx, 5)).toEqual(['https://www.example.test/', 'https://www.example.test/scoped']);
  });

  it('records the transformation version on every stored inspection', async () => {
    ctx = googleTestContext({ now: NOW, config: googleConfig() });
    const provider = createFixtureGoogleAuthProvider(GOOGLE_FIXTURES, { gscProperty: SYNTHETIC_PROPERTY, ga4PropertyId: SYNTHETIC_GA4, clock: ctx.clock });
    const r = await inspectUrls(ctx, provider, ['https://www.example.test/', 'https://www.example.test/pricing']);
    expect(r.status).toBe('succeeded');
    expect(ctx.db.all('SELECT DISTINCT transformation_version FROM url_inspections WHERE site_id = ?', [ctx.siteId])).toEqual([{ transformation_version: URL_INSPECTION_TRANSFORMATION_VERSION }]);
    // The same URL inspected again at the identical instant is the same observation (grain), not a second row.
    const again = await inspectUrls(ctx, provider, ['https://www.example.test/']);
    expect(again.outcomes[0]!.inspectionId).toBe(r.outcomes[0]!.inspectionId);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM url_inspections WHERE site_id = ?', [ctx.siteId])!.n).toBe(2);
  });

  it('returns nothing_inspected (not succeeded) when every URL is skipped', async () => {
    ctx = googleTestContext({ now: NOW });
    const provider = createFixtureGoogleAuthProvider(GOOGLE_FIXTURES, { gscProperty: SYNTHETIC_PROPERTY, ga4PropertyId: SYNTHETIC_GA4, clock: ctx.clock });
    const r = await inspectUrls(ctx, provider, ['https://elsewhere.example.invalid/']);
    expect(r).toMatchObject({ status: 'nothing_inspected', inspected: 0, failed: 0, skipped: 1 });
    expect(r.note).toMatch(/Nothing was inspected/);
    expect((await inspectUrls(ctx, provider, [])).status).toBe('nothing_inspected');
  });
});
