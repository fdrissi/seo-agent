/**
 * What an experiment actually measures (SYNTHETIC data, example.test domains):
 * - the measured scope is recorded explicitly (page-level totals, one Search
 *   Console dataset and GA4 channel view) and query-level success criteria are
 *   rewritten to the page-level metric, with a caveat in the evaluation;
 * - the minimum observation period is whole weeks and the evaluated window is
 *   never shorter than it;
 * - a change of the measurement configuration during the experiment is
 *   recorded and makes affected outcomes inconclusive;
 * - comparison pages are ranked on the same Search Console dataset.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateExperiment } from '../../../src/experiments/evaluate.js';
import { measurementConfigHash, proposeFromRecommendation } from '../../../src/experiments/propose.js';
import { getExperiment } from '../../../src/experiments/repository.js';
import { ApprovalService } from '../../../src/approvals/service.js';
import { buildScenario, REVISION, seedScenarioData, stableChecker, T, type Scenario } from '../../fixtures/experiments/scenario.js';
import { experimentsSiteConfig, seedGscPage, seedPage, seedRecommendation } from '../../fixtures/experiments/seed.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

const QUERY_CRITERIA = 'CTR for the affected queries at a comparable average position improves by 10%.';

let s: Scenario | undefined;
let ctx: TestContext | undefined;
afterEach(() => {
  s?.ctx.cleanup();
  ctx?.cleanup();
  s = undefined;
  ctx = undefined;
});

describe('measured scope and success criteria (A7-07)', () => {
  it('records the page-level scope, rewrites query-level criteria, and the evaluation carries a scope caveat', async () => {
    s = await buildScenario({ recommendation: { successCriteria: QUERY_CRITERIA, query: 'synthetic widget sizes' } });
    const e = getExperiment(s.ctx.db, s.ctx.siteId, s.experimentId);
    expect(e.sampleRequirements.measuredScope).toEqual({
      level: 'page',
      seoDataset: 'gsc_page_daily (current revision)',
      conversionDataset: 'ga4_landing_daily (current revision)',
      gscProperty: 'sc-domain:example.test',
      ga4Property: '123456789',
      searchType: 'web',
      segmentKey: '',
      channelView: 'google_organic',
      queryLevel: false,
    });
    const ev0 = e.evidence as { successCriteria: string; recommendationSuccessCriteria: string; criteriaScopeMismatch: boolean };
    expect(ev0.successCriteria).toMatch(/^Page-level ctr of the treated page, from Search Console page totals \(search type web, all queries, unsegmented\)/);
    expect(ev0.successCriteria).toMatch(/Query-level metrics are not evaluated\.$/);
    expect(ev0.recommendationSuccessCriteria).toBe(QUERY_CRITERIA);
    expect(ev0.criteriaScopeMismatch).toBe(true);
    const payload = new ApprovalService(s.ctx.db).detail(s.ctx.siteId, s.approvalId).payload!;
    expect(payload.successCriteria).toBe(ev0.successCriteria);
    const ev = evaluateExperiment(s.ctx, s.experimentId, { dryRun: true });
    expect(ev.scopeCaveat).toMatch(/^scope caveat: the recommendation's success criteria are query-level \("CTR for the affected queries/);
    expect(ev.scopeCaveat).toMatch(/measured page-level totals \(Search Console web, unsegmented; GA4 google_organic\)/);
    expect(ev.reasons).toContain(ev.scopeCaveat);
  });

  it('page-level criteria carry no caveat', async () => {
    s = await buildScenario();
    const ev = evaluateExperiment(s.ctx, s.experimentId, { dryRun: true });
    expect(ev.scopeCaveat).toBeNull();
    expect((getExperiment(s.ctx.db, s.ctx.siteId, s.experimentId).evidence as { criteriaScopeMismatch: boolean }).criteriaScopeMismatch).toBe(false);
  });

  it('comparison pages are ranked on the measured dataset only; --segment measures one existing Search Console segment', async () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: T.proposeAt });
    const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
    const { page, comparison } = seedScenarioData(ctx);
    // A very visible page that has rows ONLY in a device segment: never a comparison page for unsegmented totals.
    const mobile = seedPage(ctx.db, ctx.siteId, { path: '/mobile-only', pageType: 'article' });
    seedGscPage(ctx.db, ctx.siteId, { pageUrl: mobile.url, pageId: mobile.id, start: T.dataStart, end: T.dataEnd, clicks: () => 900, impressions: () => 90_000, segmentKey: 'device:MOBILE' });
    const rec = seedRecommendation(ctx.db, ctx.siteId, { pageId: page.id });
    const plain = await proposeFromRecommendation(ctx, gate, { recommendationId: rec, requestedBy: 'owner:Alice', sourceRevision: REVISION }, { targetChecker: stableChecker });
    expect(plain.experiment.comparisonPages.map((c) => c.pageId).sort()).toEqual(comparison.map((c) => c.id).sort());
    gate.invalidateSubject(ctx.siteId, 'experiment', plain.experiment.id, 'test');
    ctx.db.run(`UPDATE experiments SET status = 'cancelled' WHERE id = ?`, [plain.experiment.id]);
    await expect(proposeFromRecommendation(ctx, gate, { recommendationId: rec, requestedBy: 'owner:Alice', segmentKey: 'country:xyz', retestReason: 'x' })).rejects.toThrow(/No Search Console page rows exist for segment "country:xyz"/);
    const seg = await proposeFromRecommendation(ctx, gate, { recommendationId: rec, requestedBy: 'owner:Alice', sourceRevision: REVISION, segmentKey: 'device:MOBILE', retestReason: 'segment test' }, { targetChecker: stableChecker });
    expect(seg.experiment.sampleRequirements).toMatchObject({ segmentKey: 'device:MOBILE', measuredScope: { segmentKey: 'device:MOBILE' } });
    expect(seg.experiment.comparisonPages.map((c) => c.pageId)).toEqual([mobile.id]);
    expect(seg.warnings.join(' ')).toMatch(/GA4 landing-page rows are ingested unsegmented/);
  });
});

describe('minimum observation period in whole weeks (A7-08)', () => {
  it('rounds a 10-day minimum up to 14 days, and never evaluates a shorter window', async () => {
    s = await buildScenario({ propose: { minObservationDays: 10 } });
    const e = getExperiment(s.ctx.db, s.ctx.siteId, s.experimentId);
    expect(e.minObservationDays).toBe(14);
    expect(e.sampleRequirements.maxObservationDays).toBe(42);
    // 11 complete days after the implementation date: a 7-day window would exist, but it is below the minimum.
    s.ctx.clock.set('2026-07-14T09:00:00.000Z');
    for (const t of ['gsc_page_daily', 'gsc_property_daily', 'ga4_landing_daily']) s.ctx.db.run(`DELETE FROM ${t} WHERE date > '2026-07-12'`);
    const ev = evaluateExperiment(s.ctx, s.experimentId, { dryRun: true, conclude: true });
    expect(ev.result).toBe('collecting');
    expect(ev.windows.gsc).toMatchObject({ ok: false, reason: 'less_than_min', availableObservationDays: 11, minDays: 14 });
    expect(ev.windows.measuredDays).toBe(7);
    expect(ev.reasons.join(' ')).toMatch(/window covers 7 of 14 day\(s\)/);
  });

  it('warns when the minimum is rounded', async () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: T.proposeAt });
    const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
    const { page } = seedScenarioData(ctx);
    const rec = seedRecommendation(ctx.db, ctx.siteId, { pageId: page.id });
    const r = await proposeFromRecommendation(ctx, gate, { recommendationId: rec, requestedBy: 'owner:Alice', minObservationDays: 30 });
    expect(r.experiment.minObservationDays).toBe(35);
    expect(r.warnings.join(' ')).toMatch(/rounded up from 30 to 35 days/);
  });
});

describe('frozen measurement configuration and drift (A7-09)', () => {
  it('freezes the measurement-relevant config subset with a hash', async () => {
    s = await buildScenario();
    const f = getExperiment(s.ctx.db, s.ctx.siteId, s.experimentId).frozenVersions!;
    expect(f.measurementConfig).toEqual({
      gscProperty: 'sc-domain:example.test',
      ga4Property: '123456789',
      primaryEvents: ['generate_lead'],
      brandAliases: [],
      channelView: 'google_organic',
      searchType: 'web',
      segmentKey: '',
    });
    expect(f.measurementConfigHash).toBe(measurementConfigHash(f.measurementConfig!));
    const ev = evaluateExperiment(s.ctx, s.experimentId, { dryRun: true });
    expect(ev.configDrift).toEqual([]);
  });

  it('a changed primary conversion event is recorded; the conversion outcome is concluded inconclusive', async () => {
    s = await buildScenario({ propose: { primaryMetric: 'primarySessionRate' }, ga4: { sessionsBefore: 400, sessionsAfter: 400, rateBefore: 0.04, rateAfter: 0.08 } });
    s.ctx.config.conversions.primaryEvents = [{ name: 'book_demo', meaning: 'Synthetic other event', kind: 'lead' } as (typeof s.ctx.config.conversions.primaryEvents)[number]];
    const ev = evaluateExperiment(s.ctx, s.experimentId, { actor: 'system:test' });
    expect(ev.configDrift).toEqual([{ field: 'primaryEvents', frozen: ['generate_lead'], current: ['book_demo'], affects: 'conversion' }]);
    expect(ev.result).toBe('inconclusive');
    expect(ev.concluded).toBe(true);
    expect(ev.reasons.join(' ')).toMatch(/measurement configuration of the conversion \(primaryEvents \["generate_lead"\] -> \["book_demo"\]\) outcome changed during the experiment/);
    expect(getExperiment(s.ctx.db, s.ctx.siteId, s.experimentId).status).toBe('inconclusive');
    expect((getExperiment(s.ctx.db, s.ctx.siteId, s.experimentId).outcome as { configDrift: unknown[] }).configDrift).toHaveLength(1);
  });

  it('a visibility experiment keeps its SEO verdict, but a drifted conversion guardrail is unverifiable, and brand alias changes are informational', async () => {
    s = await buildScenario();
    s.ctx.config.conversions.primaryEvents = [];
    s.ctx.config.brand.aliases = ['synthetic brand'];
    const ev = evaluateExperiment(s.ctx, s.experimentId, { dryRun: true });
    expect(ev.configDrift?.map((d) => `${d.field}:${d.affects}`)).toEqual(['primaryEvents:conversion', 'brandAliases:informational']);
    expect(ev.result).toBe('positive');
    expect(ev.guardrails).toMatchObject([{ metric: 'primarySessionRate', status: 'unavailable' }]);
    expect(ev.guardrails[0]!.comparison.reasons.join(' ')).toMatch(/measurement configuration changed during the experiment/);
  });

  it('a changed Search Console property makes a visibility outcome inconclusive', async () => {
    s = await buildScenario();
    s.ctx.config.google.searchConsoleProperty = 'sc-domain:other.example.test';
    const ev = evaluateExperiment(s.ctx, s.experimentId, { dryRun: true });
    expect(ev.configDrift?.find((d) => d.field === 'gscProperty')).toMatchObject({ affects: 'seo' });
    expect(ev.result).toBe('inconclusive');
  });

  it('an experiment proposed before the freeze says drift cannot be checked', async () => {
    s = await buildScenario();
    s.ctx.db.run(`UPDATE experiments SET frozen_versions_json = json_remove(frozen_versions_json, '$.measurementConfig', '$.measurementConfigHash') WHERE id = ?`, [s.experimentId]);
    const ev = evaluateExperiment(s.ctx, s.experimentId, { dryRun: true });
    expect(ev.configDrift).toBeNull();
    expect(ev.reasons.join(' ')).toMatch(/was not frozen at proposal .* drift cannot be checked/);
    expect(ev.result).toBe('positive');
  });
});
