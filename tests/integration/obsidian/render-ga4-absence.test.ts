/**
 * Vault page notes read a missing GA4 landing row with the same rule as the
 * router and `analyze page` (B2-04): a zero only on collected dates without row
 * loss; unknown where GA4 reported "(other)" bucketing or thresholding.
 * SYNTHETIC data only (example.test domains, invented numbers).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ga4Window, renderGa4Window, type RenderContext } from '../../../src/obsidian/render-context.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { GA4_PROPERTY, reportsTestConfig, seedBatch, seedGa4Landing, seedPage } from '../../fixtures/reports/seed.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const DATES = ['2026-09-14', '2026-09-15', '2026-09-16'];

function rc(c: TestContext): RenderContext {
  // Only the fields ga4Window reads.
  return { ctx: c, ga4: { propertyId: GA4_PROPERTY, configured: true }, windowDays: 3 } as unknown as RenderContext;
}

describe('vault GA4 page summaries under row loss', () => {
  it('a page without a landing row on thresholded dates is shown as incomplete, never as 0 sessions or DATA UNAVAILABLE', () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const present = seedPage(ctx.db, ctx.siteId, '/present');
    const absent = seedPage(ctx.db, ctx.siteId, '/absent');
    seedGa4Landing(ctx.db, ctx.siteId, { dates: DATES, rows: [{ channel: 'google_organic', landingPage: '/present', pageId: present, sessions: 12 }], metadata: { subjectToThresholding: true } });

    const a = ga4Window(rc(ctx), { pageId: absent });
    expect(a.available).toBe(true);
    const organic = a.channels.find((c) => c.channel === 'google_organic')!;
    expect(organic.sessionsMeasured).toEqual({ status: 'incomplete', reason: expect.stringMatching(/no landing row on 3 collected date\(s\) \(e\.g\. 2026-09-14\) where GA4 reported thresholding .*unknown, not zero/) });
    const text = renderGa4Window(a, 'GA4 landing page').join('\n');
    expect(text).toMatch(/sessions incomplete \(no landing row on 3 collected date\(s\)/);
    expect(text).not.toMatch(/sessions 0\b/);

    // The page with rows keeps its figure.
    const p = ga4Window(rc(ctx), { pageId: present });
    expect(p.channels.find((c) => c.channel === 'google_organic')!.sessionsMeasured).toEqual({ status: 'observed', value: 36 });
    expect(renderGa4Window(p, 'GA4 landing page').join('\n')).toMatch(/sessions 36\b/);
  });

  it('a complete report without row loss makes the same absence an observed zero', () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const present = seedPage(ctx.db, ctx.siteId, '/present');
    const absent = seedPage(ctx.db, ctx.siteId, '/absent');
    seedGa4Landing(ctx.db, ctx.siteId, { dates: DATES, rows: [{ channel: 'google_organic', landingPage: '/present', pageId: present, sessions: 12 }], metadata: { subjectToThresholding: false, dataLossFromOtherRow: false } });
    const a = ga4Window(rc(ctx), { pageId: absent });
    expect(a.channels.find((c) => c.channel === 'google_organic')!.sessionsMeasured).toEqual({ status: 'observed', value: 0 });
    expect(renderGa4Window(a, 'GA4 landing page').join('\n')).toMatch(/sessions 0\b/);
    // A view that was never collected is not shown as zero.
    expect(a.channels.find((c) => c.channel === 'all_organic')).toBeUndefined();
    // "(other)" bucketing on a later report for the same view keeps the clean report's proof (one clean report is enough).
    seedBatch(ctx.db, ctx.siteId, { source: 'ga4', dataset: 'ga4_landing_daily', property: GA4_PROPERTY, start: DATES[0]!, end: DATES[2]!, view: 'google_organic', metadata: { dataLossFromOtherRow: true } });
    expect(ga4Window(rc(ctx), { pageId: absent }).channels.find((c) => c.channel === 'google_organic')!.sessionsMeasured).toEqual({ status: 'observed', value: 0 });
  });
});
