import { describe, expect, it } from 'vitest';
import { defaultScoringParams, scoreOpportunity, shortlist, smoothedConversions, SCORING_VERSION, type ScoringInput } from '../../../src/seo/scoring.js';

const params = defaultScoringParams({ minImpressions: 100, minSessions: 200, rankingPositionMin: 4, rankingPositionMax: 20, commercialPageTypes: ['offer', 'product'] });

const base: ScoringInput = {
  route: 'RANKING_OPPORTUNITY',
  pageType: null,
  isProtected: false,
  branded: false,
  intent: 'commercial',
  impressions: 5000,
  clicks: 150,
  ctr: 0.03,
  expectedCtr: 0.04,
  position: 7,
  sessions: 1000,
  convertingSessions: 30,
  primaryEventOccurrences: 45,
  siteConversionRate: 0.03,
  declinePct: null,
  gscComplete: true,
  ga4Complete: true,
  activeExperimentOnPage: false,
  suspectedIssues: 0,
  refImpressions: 20_000,
  refConversions: 30,
};

describe('opportunity scoring', () => {
  it('does not let 1 conversion from 2 sessions outrank reliable high-volume evidence', () => {
    const reliable = scoreOpportunity(base, params);
    const tiny = scoreOpportunity({ ...base, impressions: 60, clicks: 2, sessions: 2, convertingSessions: 1 }, params);
    expect(reliable.score).toBeGreaterThan(tiny.score);
    // Even with identical search exposure, the smoothed outcome keeps the tiny sample below.
    const tinySameExposure = scoreOpportunity({ ...base, sessions: 2, convertingSessions: 1 }, params);
    expect(reliable.score).toBeGreaterThan(tinySameExposure.score);
    expect(tinySameExposure.components.outcome.value).toBeLessThan(0.1);
    // Raw counts are never hidden by smoothing.
    expect(tiny.rawCounts).toMatchObject({ sessions: 2, convertingSessions: 1, rawConversionRate: 0.5 });
    expect(tiny.rawCounts.smoothedConversionRate).toBeLessThan(0.05);
    expect(tiny.version).toBe(SCORING_VERSION);
  });

  it('smooths toward the site rate (Beta prior) or shrinks volume when no site rate exists', () => {
    const a = smoothedConversions(1, 2, 0.03, 100);
    expect(a.smoothedRate).toBeCloseTo((1 + 3) / 102, 6);
    expect(a.expected).toBeCloseTo(2 / 102, 6); // shrunk observed count, not smoothedRate * n
    const b = smoothedConversions(1, 2, null, 100);
    expect(b.smoothedRate).toBeNull();
    expect(b.expected).toBeCloseTo(2 / 102, 6);
    expect(smoothedConversions(0, 0, 0.03, 100).expected).toBe(0);
  });

  it('never counts prior mass as conversions: zero observed conversions give outcome 0 at any traffic', () => {
    const zero = scoreOpportunity({ ...base, sessions: 5000, convertingSessions: 0, refConversions: 5 }, params);
    expect(zero.components.outcome.value).toBe(0);
    expect(zero.rawCounts.shrunkConvertingSessions).toBe(0);
    const some = scoreOpportunity({ ...base, sessions: 200, convertingSessions: 3, refConversions: 5 }, params);
    expect(some.components.outcome.value).toBeGreaterThan(0.5);
    expect(some.score).toBeGreaterThan(zero.score);
    // Shrinkage: x * n / (n + k), never above the observed count.
    expect(smoothedConversions(3, 200, 0.03, 100).expected).toBeCloseTo(2, 6);
    expect(smoothedConversions(0, 5000, 0.03, 100).expected).toBe(0);
    // The smoothed RATE still moves toward the site rate and is reported next to the raw rate.
    expect(zero.rawCounts.smoothedConversionRate).toBeCloseTo(3 / 5100, 6);
    expect(zero.rawCounts.rawConversionRate).toBe(0);
  });

  it('adds a site-experiment risk and records synthetic origin', () => {
    const s = scoreOpportunity(base, params);
    const site = scoreOpportunity({ ...base, activeExperimentOnSite: true }, params);
    expect(site.score).toBeLessThan(s.score);
    expect(site.penalties.risk.factors.join(' ')).toMatch(/site-wide experiment/);
    expect(s.rawCounts.dataOrigin).toBe('measured');
    expect(scoreOpportunity({ ...base, synthetic: true }, params).rawCounts.dataOrigin).toBe('SYNTHETIC');
  });

  it('penalizes uncertainty and risk explicitly', () => {
    const s = scoreOpportunity(base, params);
    const prot = scoreOpportunity({ ...base, isProtected: true }, params);
    expect(prot.score).toBeLessThan(s.score);
    expect(prot.penalties.risk.factors[0]).toMatch(/protected/);
    const partial = scoreOpportunity({ ...base, ga4Complete: false, sessions: null, convertingSessions: null }, params);
    expect(partial.penalties.uncertainty.value).toBeGreaterThan(s.penalties.uncertainty.value);
    expect(partial.components.outcome.explanation).toMatch(/unavailable/);
  });

  it('keeps branded and non-branded opportunities in separate shortlists', () => {
    const items = [
      { id: 'a', result: scoreOpportunity({ ...base, branded: true, intent: 'navigational' }, params) },
      { id: 'b', result: scoreOpportunity(base, params) },
      { id: 'c', result: scoreOpportunity({ ...base, impressions: 300 }, params) },
    ];
    const s = shortlist(items, 5);
    expect(s.branded.map((x) => x.id)).toEqual(['a']);
    expect(s.nonBranded.map((x) => x.id)).toEqual(['b', 'c']);
  });

  it('never invents authority or backlink metrics', () => {
    const s = scoreOpportunity(base, params);
    expect(Object.keys(s.components).sort()).toEqual(['demand', 'effort', 'evidence', 'intent', 'outcome', 'relevance', 'room']);
    expect(s.notMeasured).toEqual(expect.arrayContaining(['backlinks', 'domain/page authority']));
    expect(JSON.stringify(s.components)).not.toMatch(/authority|backlink/i);
  });

  it('documents improvement room per route', () => {
    expect(scoreOpportunity({ ...base, route: 'CTR_OPPORTUNITY', ctr: 0.01, expectedCtr: 0.04 }, params).components.room.value).toBeCloseTo(0.75, 4);
    expect(scoreOpportunity({ ...base, position: 4 }, params).components.room.value).toBe(1);
    expect(scoreOpportunity({ ...base, position: 18 }, params).components.room.value).toBeCloseTo(0.3, 4);
    expect(scoreOpportunity({ ...base, route: 'DECLINE', declinePct: -40 }, params).components.room.value).toBeCloseTo(0.4, 4);
  });
});
