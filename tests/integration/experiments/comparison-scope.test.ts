/**
 * Comparison pages and comparison metrics come from ONE Search Console dataset
 * (SYNTHETIC data, example.test domains, is_synthetic = 1):
 * - one property (configured, else recorded at proposal, else the only one with
 *   page data), the configured search type, and segment_key '' by default;
 * - rows of another property, another search type, or a segment never rank a
 *   page into the comparison group or enter the comparison metrics;
 * - with no property configured and several properties holding page rows,
 *   nothing is selected or summed (an explicit reason instead).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalService } from '../../../src/approvals/service.js';
import { evaluateExperiment } from '../../../src/experiments/evaluate.js';
import { comparisonScope, proposeFromRecommendation, resolveMeasuredGscProperty, selectComparisonPages } from '../../../src/experiments/propose.js';
import { getExperiment, getPage } from '../../../src/experiments/repository.js';
import { buildScenario, REVISION, seedScenarioData, stableChecker, T, type Scenario } from '../../fixtures/experiments/scenario.js';
import { experimentsSiteConfig, GSC_PROPERTY, seedGscPage, seedPage, seedRecommendation } from '../../fixtures/experiments/seed.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

/** A second (URL-prefix) property of the same synthetic site: the same clicks, reported again. */
const OTHER_PROPERTY = 'https://www.example.test/';
const WINDOW = { start: '2026-05-30', end: '2026-06-26' };

let ctx: TestContext | undefined;
let s: Scenario | undefined;
afterEach(() => {
  ctx?.cleanup();
  s?.ctx.cleanup();
  ctx = undefined;
  s = undefined;
});

/** Very visible pages whose rows are all outside the measured dataset, plus one page that is small in it but huge elsewhere. */
function seedDecoys(c: TestContext) {
  const big = { start: T.dataStart, end: T.dataEnd, clicks: () => 900, impressions: () => 90_000 };
  const otherProperty = seedPage(c.db, c.siteId, { path: '/other-property-only', pageType: 'article' });
  seedGscPage(c.db, c.siteId, { ...big, pageUrl: otherProperty.url, pageId: otherProperty.id, property: OTHER_PROPERTY });
  const image = seedPage(c.db, c.siteId, { path: '/image-search-only', pageType: 'article' });
  seedGscPage(c.db, c.siteId, { ...big, pageUrl: image.url, pageId: image.id, searchType: 'image' });
  const segment = seedPage(c.db, c.siteId, { path: '/segment-only', pageType: 'article' });
  seedGscPage(c.db, c.siteId, { ...big, pageUrl: segment.url, pageId: segment.id, segmentKey: 'device:MOBILE' });
  // Small in the measured dataset (below the three regular comparison pages), huge in the other property.
  const mixed = seedPage(c.db, c.siteId, { path: '/small-here-big-elsewhere', pageType: 'article' });
  seedGscPage(c.db, c.siteId, { start: T.dataStart, end: T.dataEnd, pageUrl: mixed.url, pageId: mixed.id, clicks: () => 1, impressions: () => 100 });
  seedGscPage(c.db, c.siteId, { ...big, pageUrl: mixed.url, pageId: mixed.id, property: OTHER_PROPERTY });
  return { otherProperty, image, segment, mixed };
}

describe('comparison-page selection scope', () => {
  it('ranks only rows of the configured property, the configured search type, and segment_key ""', async () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: T.proposeAt });
    const { page, comparison } = seedScenarioData(ctx);
    const decoys = seedDecoys(ctx);
    expect(comparisonScope(ctx)).toEqual({ scope: { property: GSC_PROPERTY, searchType: 'web', segmentKey: '' }, reason: null });

    const treated = getPage(ctx.db, ctx.siteId, page.id);
    const picked = selectComparisonPages(ctx, treated, WINDOW, 3).map((c) => c.pageId);
    expect(picked.sort()).toEqual(comparison.map((c) => c.id).sort());
    // A wider limit reaches the small page by its measured-dataset rank; the decoys never appear.
    const wide = selectComparisonPages(ctx, treated, WINDOW, 10).map((c) => c.pageId);
    expect(wide).toHaveLength(4);
    expect(wide[3]).toBe(decoys.mixed.id);
    for (const d of [decoys.otherProperty, decoys.image, decoys.segment]) expect(wide).not.toContain(d.id);

    // The proposal (default limit 5) selects the same measured-dataset ranking: no decoy.
    const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
    const rec = seedRecommendation(ctx.db, ctx.siteId, { pageId: page.id });
    const r = await proposeFromRecommendation(ctx, gate, { recommendationId: rec, requestedBy: 'owner:Alice', sourceRevision: REVISION }, { targetChecker: stableChecker });
    expect(r.experiment.comparisonPages.map((c) => c.pageId).sort()).toEqual([...comparison.map((c) => c.id), decoys.mixed.id].sort());
    expect(r.experiment.sampleRequirements.measuredScope).toMatchObject({ gscProperty: GSC_PROPERTY, searchType: 'web', segmentKey: '' });
  });

  it('without a configured property, uses the only property with page data (and says so)', async () => {
    ctx = createTestContext({ config: experimentsSiteConfig({ searchConsoleProperty: null }), now: T.proposeAt });
    const { page, comparison } = seedScenarioData(ctx);
    expect(resolveMeasuredGscProperty(ctx)).toEqual({ property: GSC_PROPERTY, basis: 'data' });
    const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
    const rec = seedRecommendation(ctx.db, ctx.siteId, { pageId: page.id });
    const r = await proposeFromRecommendation(ctx, gate, { recommendationId: rec, requestedBy: 'owner:Alice', sourceRevision: REVISION }, { targetChecker: stableChecker });
    expect(r.experiment.comparisonPages.map((c) => c.pageId).sort()).toEqual(comparison.map((c) => c.id).sort());
    expect(r.experiment.sampleRequirements.measuredScope?.gscProperty).toBe(GSC_PROPERTY);
    expect(r.warnings.join(' ')).toMatch(/searchConsoleProperty is not configured; the only Search Console property with page data \(sc-domain:example\.test\) is measured/);
  });

  it('without a configured property and with several properties holding page rows, selects nothing and sums nothing', async () => {
    ctx = createTestContext({ config: experimentsSiteConfig({ searchConsoleProperty: null }), now: T.proposeAt });
    const { page } = seedScenarioData(ctx);
    seedDecoys(ctx);
    const scope = comparisonScope(ctx);
    expect(scope.scope).toBeNull();
    expect(scope.reason).toMatch(/several properties have page data \(https:\/\/www\.example\.test\/, sc-domain:example\.test\)/);
    expect(selectComparisonPages(ctx, getPage(ctx.db, ctx.siteId, page.id), WINDOW, 5)).toEqual([]);
    // An explicit scope is still honored.
    expect(selectComparisonPages(ctx, getPage(ctx.db, ctx.siteId, page.id), WINDOW, 3, undefined, { property: GSC_PROPERTY }).length).toBe(3);

    const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
    const rec = seedRecommendation(ctx.db, ctx.siteId, { pageId: page.id });
    const r = await proposeFromRecommendation(ctx, gate, { recommendationId: rec, requestedBy: 'owner:Alice', sourceRevision: REVISION }, { targetChecker: stableChecker });
    expect(r.experiment.comparisonPages).toEqual([]);
    expect(r.experiment.baseline).toMatchObject({ gsc: { status: 'unavailable', reason: expect.stringMatching(/several properties have page data/) } });
    expect(r.warnings.join(' ')).toMatch(/Search Console: no Search Console property is configured and several properties have page data/);
  });
});

describe('comparison metrics at evaluation', () => {
  it('measure the property recorded at proposal; rows of another property added later never enter them', async () => {
    s = await buildScenario({ config: { searchConsoleProperty: null } });
    expect(getExperiment(s.ctx.db, s.ctx.siteId, s.experimentId).sampleRequirements.measuredScope?.gscProperty).toBe(GSC_PROPERTY);
    // Later, a second property reports very different numbers for the same pages.
    for (const p of [s.page, ...s.comparison]) {
      seedGscPage(s.ctx.db, s.ctx.siteId, { pageUrl: p.url, pageId: p.id, start: T.dataStart, end: T.dataEnd, clicks: () => 500, impressions: () => 1000, property: OTHER_PROPERTY });
    }
    s.ctx.clock.set(T.evaluateAt);
    const ev = evaluateExperiment(s.ctx, s.experimentId, { dryRun: true });
    const primary = ev.seo!.primary;
    expect(primary.metric).toBe('ctr');
    // Recorded property only: treated 20/1000 before, controls 50/2000 in both windows.
    expect(primary.treated.baseline).toBeCloseTo(0.02, 6);
    expect(primary.control?.baseline).toBeCloseTo(0.025, 6);
    expect(primary.control?.observation).toBeCloseTo(0.025, 6);
  });

  it('report the ambiguity instead of summing properties when no single property can be resolved', async () => {
    s = await buildScenario({ config: { searchConsoleProperty: null } });
    // An experiment without a recorded property (e.g. proposed before one was recorded).
    s.ctx.db.run(`UPDATE experiments SET sample_requirements_json = json_set(sample_requirements_json, '$.measuredScope.gscProperty', NULL) WHERE id = ?`, [s.experimentId]);
    seedGscPage(s.ctx.db, s.ctx.siteId, { pageUrl: s.page.url, pageId: s.page.id, start: T.dataStart, end: T.dataEnd, clicks: () => 500, impressions: () => 1000, property: OTHER_PROPERTY });
    s.ctx.clock.set(T.evaluateAt);
    const ev = evaluateExperiment(s.ctx, s.experimentId, { dryRun: true });
    expect(ev.result).not.toBe('positive');
    expect(ev.windows.gsc).toBeNull();
    expect(JSON.stringify(ev)).toMatch(/several properties have page data/);
  });
});
