import { describe, expect, it } from 'vitest';
import {
  aggregateByDimension,
  ctr,
  fmtPct,
  isBrandedQuery,
  parseSegmentKey,
  pctChange,
  sessionWeightedRate,
  weightedPosition,
  weightedPositionFromSums,
} from '../../../src/reports/metrics.js';

describe('report metric arithmetic (synthetic numbers)', () => {
  it('computes CTR from summed counts, never by averaging daily CTRs', () => {
    // Day 1: 1/10 = 10%, day 2: 9/990 = ~0.9%. Average of percentages would be ~5.45%.
    const days = [
      { clicks: 1, impressions: 10 },
      { clicks: 9, impressions: 990 },
    ];
    const clicks = days.reduce((a, d) => a + d.clicks, 0);
    const impressions = days.reduce((a, d) => a + d.impressions, 0);
    expect(ctr(clicks, impressions)).toBeCloseTo(0.01, 10);
    expect(ctr(5, 0)).toBeNull();
  });

  it('weights positions by impressions and ignores rows without positions', () => {
    expect(
      weightedPosition([
        { position: 2, impressions: 100 },
        { position: 20, impressions: 900 },
        { position: null, impressions: 500 },
        { position: 3, impressions: 0 },
      ]),
    ).toBeCloseTo((2 * 100 + 20 * 900) / 1000, 10);
    expect(weightedPosition([])).toBeNull();
    expect(weightedPositionFromSums(null, 10)).toBeNull();
    expect(weightedPositionFromSums(500, 100)).toBe(5);
  });

  it('aggregates session rates from compatible counts and refuses partial data', () => {
    const r = sessionWeightedRate([
      { rate: 0.2, sessions: 50 },
      { rate: 0, sessions: 50 },
    ]);
    expect(r?.rate).toBeCloseTo(0.1, 10);
    expect(r?.convertingSessions).toBeCloseTo(10, 10);
    // One missing daily rate: no silent denominator change.
    expect(sessionWeightedRate([{ rate: 0.2, sessions: 50 }, { rate: null, sessions: 50 }])).toBeNull();
    expect(sessionWeightedRate([])).toBeNull();
    // A rate stored with an unverified scale is never combined as a fraction; a stored 0-100 value is divided by 100.
    expect(sessionWeightedRate([{ rate: 0.2, sessions: 50, scale: 'undetermined' }, { rate: 0.1, sessions: 50, scale: 'fraction' }])).toBeNull();
    expect(sessionWeightedRate([{ rate: 20, sessions: 50, scale: 'percent' }])?.convertingSessions).toBeCloseTo(10, 10);
  });

  it('treats undefined growth as null, not zero', () => {
    expect(pctChange(10, 0)).toBeNull();
    expect(pctChange(null, 5)).toBeNull();
    expect(pctChange(15, 10)).toBeCloseTo(0.5, 10);
    expect(fmtPct(null)).toBe('n/a');
  });

  it('classifies branded queries only when aliases are configured', () => {
    expect(isBrandedQuery('test co pricing', [])).toBeNull();
    expect(isBrandedQuery('Test Co pricing', ['Test Co'])).toBe(true);
    expect(isBrandedQuery('testco login', ['Test Co'])).toBe(true);
    expect(isBrandedQuery('seo tool pricing', ['Test Co'])).toBe(false);
    // Substring inside another word is not a brand match.
    expect(isBrandedQuery('contest cost', ['test co'])).toBe(false);
    expect(isBrandedQuery('Ümlaut Brand review', ['umlaut brand'])).toBe(true);
  });

  it('parses segment keys into dimensions and a shape', () => {
    expect(parseSegmentKey('device=MOBILE;country=est')).toEqual({ dims: { device: 'MOBILE', country: 'est' }, shape: 'country;device' });
  });

  it('aggregates one dimension over a single segment shape (no double counting across requests)', () => {
    const rows = [
      // request A: device only
      { segmentKey: 'device=MOBILE', clicks: 10, impressions: 100, positionWeighted: 500, positionImpressions: 100 },
      { segmentKey: 'device=DESKTOP', clicks: 5, impressions: 50, positionWeighted: 100, positionImpressions: 50 },
      // request B: country + device (same traffic split differently)
      { segmentKey: 'country=est;device=MOBILE', clicks: 7, impressions: 60, positionWeighted: 300, positionImpressions: 60 },
      { segmentKey: 'country=fin;device=MOBILE', clicks: 3, impressions: 40, positionWeighted: 200, positionImpressions: 40 },
    ];
    const device = aggregateByDimension(rows, 'device');
    expect(device.shape).toBe('device');
    expect(device.values.find((v) => v.value === 'MOBILE')?.clicks).toBe(10); // not 20
    const country = aggregateByDimension(rows, 'country');
    expect(country.shape).toBe('country;device');
    expect(country.values.map((v) => v.value)).toEqual(['est', 'fin']);
    expect(aggregateByDimension(rows, 'searchAppearance')).toEqual({ shape: null, values: [] });
  });
});
