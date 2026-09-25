import { afterEach, describe, expect, it } from 'vitest';
import { valueOf } from '../../../src/core/measured.js';
import { bucketOf, ConversionBenchmark, CtrBenchmarks } from '../../../src/seo/benchmarks.js';
import type { Ga4Scope } from '../../../src/seo/metrics.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { daily, GA4_PROPERTY, SeoSeeder } from '../../fixtures/seo/seed.js';
import { confirmRateScale } from '../../../src/integrations/google/ga4-metadata.js';

// Synthetic units only.
describe('comparable-position CTR benchmarks (site data only)', () => {
  const units = [
    { pageId: 'p1', clicks: 50, impressions: 1000, position: 2, branded: false },
    { pageId: 'p2', clicks: 30, impressions: 1000, position: 2.2, branded: false },
    { pageId: 'p3', clicks: 70, impressions: 1000, position: 1.8, branded: false },
    { pageId: 'p4', clicks: 400, impressions: 1000, position: 2, branded: true },
    { pageId: 'p5', clicks: 5, impressions: 50, position: 8, branded: false },
  ];
  const b = new CtrBenchmarks(units, 100);

  it('excludes the evaluated page and separates branded from non-branded', () => {
    expect(valueOf(b.expected(2, false, 'p1'))).toBeCloseTo(100 / 2000, 6);
    expect(valueOf(b.expected(2, false, null))).toBeCloseTo(150 / 3000, 6);
    expect(b.expected(2, true, 'p9').status).toBe('unavailable'); // only one branded unit
  });

  it('refuses to benchmark without enough comparable data', () => {
    expect(b.expected(8, false, null).status).toBe('unavailable');
    expect(b.expected(undefined, false, null).status).toBe('unavailable');
    expect(bucketOf(0.9).label).toBe('1');
    expect(bucketOf(15).label).toBe('11-20');
    expect(bucketOf(64).label).toBe('21+');
  });
});

describe('site conversion benchmark and the key-event rate scale', () => {
  let ctx: TestContext | undefined;
  afterEach(() => ctx?.cleanup());
  const scope: Ga4Scope = { propertyId: GA4_PROPERTY, channelView: 'google_organic', start: '2026-09-01', end: '2026-09-02', configuredPrimaryEvents: ['generate_lead'] };

  it('uses verified-scale rates as fractions and refuses rates stored with scale "undetermined"', () => {
    ctx = createTestContext();
    const seed = new SeoSeeder(ctx.db, ctx.siteId);
    // SYNTHETIC landing rows for two paths (page ids stay NULL: site-level benchmark).
    seed.ga4Landing(daily('2026-09-01', '2026-09-02', (date) => ({ date, landingPage: '/a', sessions: 100, rate: 0.1 })));
    seed.ga4Landing(daily('2026-09-01', '2026-09-02', (date) => ({ date, landingPage: '/b', sessions: 100, rate: 0.3 })));
    expect(valueOf(new ConversionBenchmark(ctx.db, ctx.siteId, scope).rate(null))).toBeCloseTo(0.2, 6);

    ctx.db.run("UPDATE ga4_landing_daily SET primary_session_rate_scale = 'undetermined' WHERE site_id = ? AND landing_page = '/b'", [ctx.siteId]);
    const b = new ConversionBenchmark(ctx.db, ctx.siteId, scope);
    const r = b.rate(null);
    expect(r.status).toBe('unavailable');
    expect(r.status !== 'observed' && r.reason).toMatch(/^rate scale unverified/);

    // Once the owner confirms the scale, the same stored rows are re-marked and the benchmark is back (no SQL change).
    confirmRateScale(ctx, GA4_PROPERTY, { scale: 'fraction', evidence: 'GA4 UI shows 30.00% for /b on 2026-09-01; stored 0.3', actor: 'Alice' });
    expect(valueOf(new ConversionBenchmark(ctx.db, ctx.siteId, scope).rate(null))).toBeCloseTo(0.2, 6);
  });
});
