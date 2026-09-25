import { afterEach, describe, expect, it } from 'vitest';
import { observed, incomplete, valueOf } from '../../../src/core/measured.js';
import { confirmRateScale } from '../../../src/integrations/google/ga4-metadata.js';
import { coverageFrom, fullCoverage, ga4Coverage } from '../../../src/seo/coverage.js';
import { aggregateGa4, aggregateSearch, compareMeasured, ga4PageMetrics, type Ga4Observation, type SearchObservation } from '../../../src/seo/metrics.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { GA4_PROPERTY, PRIMARY_EVENT, reportsTestConfig, seedBatch, seedGa4Landing, seedGa4Period, seedPage } from '../../fixtures/reports/seed.js';

// Synthetic observations (example data only).
const s = (o: Partial<SearchObservation> & Pick<SearchObservation, 'date' | 'clicks' | 'impressions'>): SearchObservation => ({
  dateTz: 'America/Los_Angeles',
  property: 'sc-domain:example.test',
  searchType: 'web',
  aggregationType: 'byPage',
  segmentKey: '',
  position: 5,
  isFinal: true,
  ...o,
});

const g = (o: Partial<Ga4Observation> & Pick<Ga4Observation, 'date' | 'sessions'>): Ga4Observation => ({
  ...gBase(o),
  ...(o.primaryKeyEvents !== undefined && o.primaryKeyEvents !== null && !o.primaryKeyEventsStatus ? { primaryKeyEventsStatus: 'observed' as const } : {}),
});
const gBase = (o: Partial<Ga4Observation> & Pick<Ga4Observation, 'date' | 'sessions'>): Ga4Observation => ({
  dateTz: 'Europe/Tallinn',
  channelView: 'google_organic',
  segmentKey: '',
  landingPage: '/p',
  hostName: 'www.example.test',
  engagedSessions: null,
  keyEvents: null,
  primaryEventName: 'generate_lead',
  primaryKeyEvents: null,
  primaryKeyEventsStatus: 'missing',
  primaryRate: null,
  primaryRateStatus: 'missing',
  revenueMicros: null,
  revenueCurrency: null,
  revenueStatus: 'missing',
  isComplete: true,
  ...o,
});

describe('aggregateSearch', () => {
  it('computes CTR as sum(clicks)/sum(impressions), never the average of daily CTRs', () => {
    const a = aggregateSearch([s({ date: '2026-09-01', clicks: 1, impressions: 10 }), s({ date: '2026-09-02', clicks: 50, impressions: 1000 })], { coverage: fullCoverage('2026-09-01', '2026-09-02') });
    // mean of daily CTRs would be (0.1 + 0.05) / 2 = 0.075
    expect(valueOf(a.ctr)).toBeCloseTo(51 / 1010, 6);
    expect(valueOf(a.clicks)).toBe(51);
    expect(valueOf(a.impressions)).toBe(1010);
  });

  it('weights position by impressions', () => {
    const a = aggregateSearch([s({ date: '2026-09-01', clicks: 0, impressions: 900, position: 10 }), s({ date: '2026-09-02', clicks: 0, impressions: 100, position: 2 })], { coverage: fullCoverage('2026-09-01', '2026-09-02') });
    expect(valueOf(a.position)).toBeCloseTo(9.2, 4); // not the simple mean 6
  });

  it('rejects aggregation across incompatible segments, search types, properties, or aggregation types', () => {
    const cases: Array<Partial<SearchObservation>> = [{ segmentKey: 'device=MOBILE' }, { searchType: 'image' }, { property: 'https://www.example.test/' }, { aggregationType: 'byProperty' }];
    for (const diff of cases) {
      const a = aggregateSearch([s({ date: '2026-09-01', clicks: 1, impressions: 10 }), s({ date: '2026-09-02', clicks: 1, impressions: 10, ...diff })]);
      expect(a.completeness).toBe('incompatible');
      expect(a.position.status).toBe('unavailable');
      expect(a.clicks.status).toBe('unavailable');
    }
    const tz = aggregateSearch([s({ date: '2026-09-01', clicks: 1, impressions: 10 }), s({ date: '2026-09-02', clicks: 1, impressions: 10, dateTz: 'UTC' })]);
    expect(tz.completeness).toBe('incompatible');
  });

  it('distinguishes an actual zero from missing data', () => {
    const zero = aggregateSearch([], { coverage: fullCoverage('2026-09-01', '2026-09-07') });
    expect(zero.clicks).toEqual(observed(0));
    expect(zero.impressions).toEqual(observed(0));
    expect(zero.ctr.status).toBe('unavailable'); // undefined, not 0%
    expect(zero.position.status).toBe('unavailable');

    const miss = aggregateSearch([], { coverage: coverageFrom('2026-09-01', '2026-09-07', {}) });
    expect(miss.clicks.status).toBe('missing');
    expect(miss.completeness).toBe('missing');

    const unknown = aggregateSearch([]);
    expect(unknown.clicks.status).toBe('missing');
  });

  it('flags partial collection and row-limit truncation as incomplete', () => {
    const cov = coverageFrom('2026-09-01', '2026-09-03', { '2026-09-01': 'final', '2026-09-02': { state: 'final', truncated: true } });
    const a = aggregateSearch([s({ date: '2026-09-01', clicks: 5, impressions: 50 })], { coverage: cov });
    expect(a.clicks.status).toBe('incomplete');
    expect(a.datesMissing).toEqual(['2026-09-03']);
    expect(a.datesTruncated).toEqual(['2026-09-02']);
  });

  it('excludes non-final dates by default and flags them when asked', () => {
    const rows = [s({ date: '2026-09-01', clicks: 5, impressions: 50 }), s({ date: '2026-09-02', clicks: 7, impressions: 70, isFinal: false })];
    const cov = coverageFrom('2026-09-01', '2026-09-02', { '2026-09-01': 'final', '2026-09-02': 'incomplete' });
    const ex = aggregateSearch(rows, { coverage: cov });
    // Excluding a non-final date shortens the window: the value is partial, never "observed".
    expect(ex.clicks.status).toBe('incomplete');
    expect(ex.clicks.status === 'incomplete' && ex.clicks.partialValue).toBe(5);
    expect(ex.clicks.status === 'incomplete' && ex.clicks.reason).toMatch(/1 non-final date\(s\) excluded/);
    expect(ex.completeness).toBe('incomplete');
    expect(ex.datesExcludedIncomplete).toEqual(['2026-09-02']);
    const fl = aggregateSearch(rows, { coverage: cov, incompletePolicy: 'flag' });
    expect(fl.clicks.status).toBe('incomplete');
    expect(fl.clicks.status === 'incomplete' && fl.clicks.partialValue).toBe(12);
    const onlyIncomplete = aggregateSearch([rows[1]!], { coverage: coverageFrom('2026-09-02', '2026-09-02', { '2026-09-02': 'incomplete' }) });
    expect(onlyIncomplete.clicks.status).toBe('incomplete');
  });
});

describe('aggregateGa4', () => {
  const cov = fullCoverage('2026-09-01', '2026-09-02');
  const events = ['generate_lead'];

  it('computes the primary-event session rate as sum(rate*sessions)/sum(sessions)', () => {
    const a = aggregateGa4([g({ date: '2026-09-01', sessions: 100, primaryRate: 0.05, primaryRateStatus: 'observed' }), g({ date: '2026-09-02', sessions: 300, primaryRate: 0.01, primaryRateStatus: 'observed' })], { configuredPrimaryEvents: events, coverage: cov });
    expect(valueOf(a.primaryConversionRate)).toBeCloseTo(8 / 400, 6); // not the mean 0.03
    expect(valueOf(a.primaryConvertingSessions)).toBeCloseTo(8, 6);
    expect(valueOf(a.sessions)).toBe(400);
  });

  it('never divides repeatable event occurrences by sessions when the rate is not observed', () => {
    const a = aggregateGa4([g({ date: '2026-09-01', sessions: 200, primaryKeyEvents: 20, primaryRate: null, primaryRateStatus: 'unavailable' }), g({ date: '2026-09-02', sessions: 200, primaryKeyEvents: 0, primaryRate: null, primaryRateStatus: 'unavailable' })], { configuredPrimaryEvents: events, coverage: cov });
    expect(a.primaryConversionRate.status).toBe('unavailable');
    expect(a.primaryConversionRate.status !== 'observed' && a.primaryConversionRate.reason).toMatch(/not observed/);
    expect(valueOf(a.primaryEventOccurrences)).toBe(20); // reported separately as occurrences
  });

  it('refuses a rate when only some rows observed it (no filtered denominators)', () => {
    const a = aggregateGa4([g({ date: '2026-09-01', sessions: 100, primaryRate: 0.1, primaryRateStatus: 'observed' }), g({ date: '2026-09-02', sessions: 900, primaryRate: null, primaryRateStatus: 'missing' })], { configuredPrimaryEvents: events, coverage: cov });
    expect(a.primaryConversionRate.status).toBe('unavailable');
  });

  it('keeps repeated events separate from converting sessions', () => {
    const a = aggregateGa4([g({ date: '2026-09-01', sessions: 100, primaryRate: 0.02, primaryRateStatus: 'observed', primaryKeyEvents: 9, keyEvents: 12 })], { configuredPrimaryEvents: events, coverage: fullCoverage('2026-09-01', '2026-09-01') });
    expect(valueOf(a.primaryConvertingSessions)).toBeCloseTo(2, 6);
    expect(valueOf(a.primaryEventOccurrences)).toBe(9);
    expect(valueOf(a.keyEventOccurrences)).toBe(12);
  });

  it('never uses a rate stored with scale "undetermined" as a fraction (no rate x sessions, no observed rate)', () => {
    const rows = [g({ date: '2026-09-01', sessions: 100, primaryRate: 0.5, primaryRateStatus: 'observed', primaryRateScale: 'undetermined' }), g({ date: '2026-09-02', sessions: 300, primaryRate: 0.9, primaryRateStatus: 'observed', primaryRateScale: 'undetermined' })];
    const a = aggregateGa4(rows, { configuredPrimaryEvents: events, coverage: cov });
    expect(a.primaryConversionRate.status).toBe('unavailable');
    expect(a.primaryConversionRate.status !== 'observed' && a.primaryConversionRate.reason).toMatch(/^rate scale unverified/);
    expect(a.primaryConvertingSessions.status).toBe('unavailable');
    expect(a.primaryRateScaleUnverified).toBe(true);
    // One undetermined row is enough to refuse the combination.
    const mixed = aggregateGa4([{ ...rows[0]!, primaryRateScale: 'fraction' }, rows[1]!], { configuredPrimaryEvents: events, coverage: cov });
    expect(mixed.primaryConversionRate.status).toBe('unavailable');
  });

  it('uses fraction and percent_normalized rates as stored and divides a stored 0-100 (percent) rate by 100', () => {
    const a = aggregateGa4([g({ date: '2026-09-01', sessions: 100, primaryRate: 0.05, primaryRateStatus: 'observed', primaryRateScale: 'fraction' }), g({ date: '2026-09-02', sessions: 300, primaryRate: 0.01, primaryRateStatus: 'observed', primaryRateScale: 'percent_normalized' })], { configuredPrimaryEvents: events, coverage: cov });
    expect(valueOf(a.primaryConversionRate)).toBeCloseTo(8 / 400, 6);
    const p = aggregateGa4([g({ date: '2026-09-01', sessions: 100, primaryRate: 5, primaryRateStatus: 'observed', primaryRateScale: 'percent' })], { configuredPrimaryEvents: events, coverage: fullCoverage('2026-09-01', '2026-09-01') });
    expect(valueOf(p.primaryConversionRate)).toBeCloseTo(0.05, 6);
    expect(valueOf(p.primaryConvertingSessions)).toBeCloseTo(5, 6);
  });

  it('reports unavailable when no primary event is configured, events are mixed, or the rate scale is suspicious', () => {
    const rows = [g({ date: '2026-09-01', sessions: 10, primaryRate: 0.1, primaryRateStatus: 'observed' })];
    expect(aggregateGa4(rows, { configuredPrimaryEvents: [], coverage: fullCoverage('2026-09-01', '2026-09-01') }).primaryConversionRate.status).toBe('unavailable');
    const mixed = aggregateGa4([...rows, g({ date: '2026-09-02', sessions: 10, primaryRate: 0.1, primaryRateStatus: 'observed', primaryEventName: 'purchase' })], { configuredPrimaryEvents: ['generate_lead', 'purchase'], coverage: cov });
    expect(mixed.primaryConversionRate.status).toBe('unavailable');
    const pctScale = aggregateGa4([g({ date: '2026-09-01', sessions: 10, primaryRate: 12.5, primaryRateStatus: 'observed' })], { configuredPrimaryEvents: events, coverage: fullCoverage('2026-09-01', '2026-09-01') });
    expect(pctScale.primaryConversionRate.status).toBe('unavailable');
    const other = aggregateGa4([g({ date: '2026-09-01', sessions: 10, primaryRate: 0.1, primaryRateStatus: 'observed', primaryEventName: 'scroll' })], { configuredPrimaryEvents: events, coverage: fullCoverage('2026-09-01', '2026-09-01') });
    expect(other.primaryConversionRate.status).toBe('unavailable');
  });

  it('treats collected dates without rows as zero sessions and uncollected dates as missing', () => {
    const zero = aggregateGa4([], { configuredPrimaryEvents: events, coverage: cov });
    expect(zero.sessions).toEqual(observed(0));
    expect(zero.primaryConversionRate.status).toBe('unavailable');
    const miss = aggregateGa4([], { configuredPrimaryEvents: events, coverage: coverageFrom('2026-09-01', '2026-09-02', {}) });
    expect(miss.sessions.status).toBe('missing');
  });

  it('sums revenue only for a single known currency', () => {
    const ok = aggregateGa4([g({ date: '2026-09-01', sessions: 5, revenueMicros: 1_000_000, revenueCurrency: 'EUR', revenueStatus: 'observed' }), g({ date: '2026-09-02', sessions: 5, revenueMicros: 500_000, revenueCurrency: 'EUR', revenueStatus: 'observed' })], { configuredPrimaryEvents: events, coverage: cov });
    expect(valueOf(ok.revenue)).toEqual({ micros: 1_500_000, currency: 'EUR' });
    const mixed = aggregateGa4([g({ date: '2026-09-01', sessions: 5, revenueMicros: 1, revenueCurrency: 'EUR', revenueStatus: 'observed' }), g({ date: '2026-09-02', sessions: 5, revenueMicros: 1, revenueCurrency: 'USD', revenueStatus: 'observed' })], { configuredPrimaryEvents: events, coverage: cov });
    expect(mixed.revenue.status).toBe('unavailable');
  });

  it('rejects mixing channel views', () => {
    const a = aggregateGa4([g({ date: '2026-09-01', sessions: 5 }), g({ date: '2026-09-02', sessions: 5, channelView: 'all_organic' })], { configuredPrimaryEvents: events });
    expect(a.completeness).toBe('incompatible');
  });
});

describe('excluded incomplete dates are never compared as a full window', () => {
  it('a 7-day window with 3 non-final days is incomplete and not comparable with a full previous week', () => {
    const cur = [
      ...['2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'].map((date) => s({ date, clicks: 40, impressions: 400 })),
      ...['2026-09-21', '2026-09-22', '2026-09-23'].map((date) => s({ date, clicks: 5, impressions: 60, isFinal: false })),
    ];
    const curCov = coverageFrom('2026-09-17', '2026-09-23', { '2026-09-21': 'incomplete', '2026-09-22': 'incomplete', '2026-09-23': 'incomplete' }, 'final');
    const prev = ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16'].map((date) => s({ date, clicks: 40, impressions: 400 }));
    const a = aggregateSearch(cur, { coverage: curCov });
    const b = aggregateSearch(prev, { coverage: fullCoverage('2026-09-10', '2026-09-16') });
    expect(a.clicks).toEqual(incomplete(expect.stringMatching(/3 non-final date\(s\) excluded/) as unknown as string, 160));
    expect(b.clicks).toEqual(observed(280));
    // A shorter effective window would look like a -43% decline: refused.
    expect(compareMeasured(a.clicks, b.clicks).status).toBe('unavailable');
  });

  it('GA4: excluded incomplete dates make sessions incomplete', () => {
    const rows = [g({ date: '2026-09-01', sessions: 10 }), g({ date: '2026-09-02', sessions: 4, isComplete: false })];
    const a = aggregateGa4(rows, { configuredPrimaryEvents: ['generate_lead'], coverage: coverageFrom('2026-09-01', '2026-09-02', { '2026-09-01': 'final', '2026-09-02': 'incomplete' }) });
    expect(a.sessions.status).toBe('incomplete');
    expect(a.sessions.status === 'incomplete' && a.sessions.partialValue).toBe(10);
  });
});

describe('synthetic rows', () => {
  it('mark the aggregate synthetic (never to be presented as observed)', () => {
    expect(aggregateSearch([s({ date: '2026-09-01', clicks: 1, impressions: 10, isSynthetic: true })], { coverage: fullCoverage('2026-09-01', '2026-09-01') }).synthetic).toBe(true);
    expect(aggregateSearch([s({ date: '2026-09-01', clicks: 1, impressions: 10 })], { coverage: fullCoverage('2026-09-01', '2026-09-01') }).synthetic).toBe(false);
    expect(aggregateGa4([g({ date: '2026-09-01', sessions: 3, isSynthetic: true })], { configuredPrimaryEvents: ['generate_lead'], coverage: fullCoverage('2026-09-01', '2026-09-01') }).synthetic).toBe(true);
  });
});

describe('compareMeasured', () => {
  it('never compares an incomplete current period with a completed one', () => {
    expect(compareMeasured(incomplete('fresh dates', 10), observed(20)).status).toBe('unavailable');
    const c = compareMeasured(observed(15), observed(20));
    expect(c.status === 'observed' && valueOf(c.value.pct)).toBe(-25);
    const z = compareMeasured(observed(5), observed(0));
    expect(z.status === 'observed' && z.value.pct.status).toBe('unavailable');
  });
});

describe('GA4 row loss: an absent landing row is not an observed zero (B2-04)', () => {
  const events = ['generate_lead'];
  const lossy = (reasons: Array<'other_row' | 'thresholding' | 'sampling'>) => ({ state: 'final' as const, truncated: false, rowLoss: reasons });

  it('under "(other)" bucketing a page without any row is incomplete with the reason, never 0 sessions', () => {
    const cov = coverageFrom('2026-09-01', '2026-09-02', { '2026-09-01': lossy(['other_row']), '2026-09-02': lossy(['other_row']) });
    const a = aggregateGa4([], { configuredPrimaryEvents: events, coverage: cov });
    expect(a.sessions.status).toBe('incomplete');
    expect(a.sessions.status === 'incomplete' && a.sessions.partialValue).toBeUndefined();
    expect(a.sessions.status !== 'observed' && a.sessions.reason).toMatch(/no GA4 landing row on 2 collected date\(s\) \(e\.g\. 2026-09-01\) where GA4 reported rows bucketed into "\(other\)" \(dataLossFromOtherRow\); a missing row there is unknown, not zero/);
    expect(a.completeness).toBe('incomplete');
    expect(a.primaryConvertingSessions.status).toBe('incomplete');
    expect(a.primaryEventOccurrences.status).toBe('incomplete');
  });

  it('under thresholding the same rule applies; clean collected dates still count as zeros (partial value)', () => {
    const cov = coverageFrom('2026-09-01', '2026-09-03', { '2026-09-01': 'final', '2026-09-02': lossy(['thresholding']), '2026-09-03': lossy(['thresholding']) });
    const a = aggregateGa4([], { configuredPrimaryEvents: events, coverage: cov });
    expect(a.sessions).toEqual(incomplete(expect.stringMatching(/thresholding \(subjectToThresholding: rows may be withheld\)/) as unknown as string, 0));
    // A page WITH rows keeps its real values; only its row-less lossy dates make it incomplete.
    const b = aggregateGa4([g({ date: '2026-09-01', sessions: 7 })], { configuredPrimaryEvents: events, coverage: cov });
    expect(b.sessions.status === 'incomplete' && b.sessions.partialValue).toBe(7);
    // Rows on every lossy date (and none on the clean date, a real zero): nothing is unknown.
    const c = aggregateGa4([g({ date: '2026-09-02', sessions: 3 }), g({ date: '2026-09-03', sessions: 4 })], { configuredPrimaryEvents: events, coverage: cov });
    expect(c.sessions).toEqual(observed(7));
    const full = aggregateGa4([g({ date: '2026-09-01', sessions: 1 }), g({ date: '2026-09-02', sessions: 3 }), g({ date: '2026-09-03', sessions: 4 })], { configuredPrimaryEvents: events, coverage: cov });
    expect(full.sessions).toEqual(observed(8));
    // Without row loss, collected dates without rows are still zeros.
    expect(aggregateGa4([], { configuredPrimaryEvents: events, coverage: fullCoverage('2026-09-01', '2026-09-03') }).sessions).toEqual(observed(0));
  });
});

describe('ga4Coverage carries GA4 batch metadata (B2-04)', () => {
  let ctx: TestContext | undefined;
  afterEach(() => {
    ctx?.cleanup();
    ctx = undefined;
  });
  const dates = ['2026-09-14', '2026-09-15'];
  const scope = (pageId: string) => ({ propertyId: GA4_PROPERTY, channelView: 'google_organic' as const, start: dates[0]!, end: dates[1]!, configuredPrimaryEvents: [PRIMARY_EVENT] });

  it('dates whose covering report bucketed rows into "(other)" or was thresholded make an absent page incomplete; a clean report proves zero', () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const other = seedPage(ctx.db, ctx.siteId, '/other');
    const absent = seedPage(ctx.db, ctx.siteId, '/absent');
    seedGa4Landing(ctx.db, ctx.siteId, { dates, rows: [{ channel: 'google_organic', landingPage: '/other', pageId: other, sessions: 30 }], metadata: { dataLossFromOtherRow: true, subjectToThresholding: false } });
    const cov = ga4Coverage(ctx.db, ctx.siteId, { propertyId: GA4_PROPERTY, start: dates[0]!, end: dates[1]!, channelView: 'google_organic' });
    expect(cov.byDate[dates[0]!]).toMatchObject({ state: 'final', truncated: false, rowLoss: ['other_row'] });
    expect(cov.rowLoss).toEqual(dates);
    const a = ga4PageMetrics(ctx.db, ctx.siteId, absent, scope(absent));
    expect(a.sessions.status).toBe('incomplete');
    expect(a.sessions.status !== 'observed' && a.sessions.reason).toMatch(/"\(other\)"/);
    // The page that has rows keeps its observed values.
    expect(ga4PageMetrics(ctx.db, ctx.siteId, other, scope(other)).sessions).toEqual(observed(60));
    // A later complete report without row loss for the same view proves the absence: an observed zero.
    seedBatch(ctx.db, ctx.siteId, { source: 'ga4', dataset: 'ga4_landing_daily', property: GA4_PROPERTY, start: dates[0]!, end: dates[1]!, view: 'google_organic', metadata: { dataLossFromOtherRow: false, subjectToThresholding: false } });
    expect(ga4PageMetrics(ctx.db, ctx.siteId, absent, scope(absent)).sessions).toEqual(observed(0));
  });

  it('thresholding metadata on the covering report makes an absent page incomplete too', () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const other = seedPage(ctx.db, ctx.siteId, '/other');
    const absent = seedPage(ctx.db, ctx.siteId, '/absent');
    seedGa4Landing(ctx.db, ctx.siteId, { dates, rows: [{ channel: 'google_organic', landingPage: '/other', pageId: other, sessions: 30 }], metadata: { subjectToThresholding: true } });
    const a = ga4PageMetrics(ctx.db, ctx.siteId, absent, scope(absent));
    expect(a.sessions.status).toBe('incomplete');
    expect(a.sessions.status !== 'observed' && a.sessions.reason).toMatch(/thresholding/);
  });
});

describe('confirming the GA4 rate scale makes stored rows usable (B3-01)', () => {
  let ctx: TestContext | undefined;
  afterEach(() => {
    ctx?.cleanup();
    ctx = undefined;
  });
  const dates = ['2026-09-10', '2026-09-11', '2026-09-12'];
  const scope = (pageId: string) => ({ propertyId: GA4_PROPERTY, channelView: 'google_organic' as const, start: dates[0]!, end: dates[2]!, configuredPrimaryEvents: [PRIMARY_EVENT] });

  it('a fraction confirmation re-marks older "undetermined" rows (new revisions, earlier kept) and the rate becomes observed', () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const page = seedPage(ctx.db, ctx.siteId, '/pricing');
    seedGa4Landing(ctx.db, ctx.siteId, { dates, rows: [{ channel: 'google_organic', landingPage: '/pricing', pageId: page, sessions: 50, rate: 0.04, rateScale: 'undetermined' }] });
    seedGa4Period(ctx.db, ctx.siteId, { start: dates[0]!, end: dates[2]!, channel: 'google_organic', metric: `sessionKeyEventRate:${PRIMARY_EVENT}`, value: 0.04, rateScale: 'undetermined' });
    const before = ga4PageMetrics(ctx.db, ctx.siteId, page, scope(page));
    expect(before.primaryConversionRate.status !== 'observed' && before.primaryConversionRate.reason).toMatch(/^rate scale unverified/);
    expect(before.primaryConversionRate.status !== 'observed' && before.primaryConversionRate.reason).toContain('--confirm-rate-scale fraction|percent');
    // The printed command is runnable as shown: it includes the required --as (R3-NF-G7).
    expect(before.primaryConversionRate.status !== 'observed' && before.primaryConversionRate.reason).toContain('`npm run cli -- sync ga4 --confirm-rate-scale fraction|percent --evidence "<what you compared>" --as "<your name>"`');

    const r = confirmRateScale(ctx, GA4_PROPERTY, { scale: 'fraction', evidence: 'GA4 UI shows 4.00% for /pricing on 2026-09-10; stored 0.04', actor: 'owner:Test Owner' });
    expect(r.remarked).toEqual({ landingRows: 3, periodRows: 1 });
    const after = ga4PageMetrics(ctx.db, ctx.siteId, page, scope(page));
    expect(after.primaryConversionRate).toEqual(observed(0.04));
    expect(after.primaryConvertingSessions).toEqual(observed(6));
    // Earlier revisions are kept (not current) with the raw value; the new revision records the confirmation.
    const revisions = ctx.db.all<{ revision: number; is_current: number; primary_session_rate: number; primary_session_rate_scale: string; transformation_version: string }>(
      "SELECT revision, is_current, primary_session_rate, primary_session_rate_scale, transformation_version FROM ga4_landing_daily WHERE site_id = ? AND date = '2026-09-10' ORDER BY revision",
      [ctx.siteId],
    );
    expect(revisions).toEqual([
      { revision: 1, is_current: 0, primary_session_rate: 0.04, primary_session_rate_scale: 'undetermined', transformation_version: 'test@1' },
      { revision: 2, is_current: 1, primary_session_rate: 0.04, primary_session_rate_scale: 'fraction', transformation_version: `test@1+rate-scale:fraction@${r.confirmationId}` },
    ]);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ga4_landing_daily WHERE site_id = ? AND is_current = 1 AND page_id = ?", [ctx.siteId, page])!.n).toBe(3);
    expect(ctx.db.get<{ rate_scale: string; value: number }>('SELECT rate_scale, value FROM ga4_period_metrics_current WHERE site_id = ?', [ctx.siteId])).toEqual({ rate_scale: 'fraction', value: 0.04 });
  });

  it('a percent confirmation divides stored values by 100; switching back restores them', () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const page = seedPage(ctx.db, ctx.siteId, '/pricing');
    seedGa4Landing(ctx.db, ctx.siteId, { dates, rows: [{ channel: 'google_organic', landingPage: '/pricing', pageId: page, sessions: 50, rate: 0.5, rateScale: 'undetermined' }] });
    confirmRateScale(ctx, GA4_PROPERTY, { scale: 'percent', evidence: 'GA4 UI shows 0.50% for /pricing on 2026-09-10; stored 0.5', actor: 'Alice' });
    const pct = ga4PageMetrics(ctx.db, ctx.siteId, page, scope(page));
    expect(valueOf(pct.primaryConversionRate)).toBeCloseTo(0.005, 9);
    expect(ctx.db.all<{ s: string }>('SELECT DISTINCT primary_session_rate_scale AS s FROM ga4_landing_daily_current WHERE site_id = ?', [ctx.siteId])).toEqual([{ s: 'percent_normalized' }]);
    ctx.clock.advanceMs(1000);
    const back = confirmRateScale(ctx, GA4_PROPERTY, { scale: 'fraction', evidence: 'Re-checked: GA4 UI shows 50% for this page and day', actor: 'Alice' });
    expect(back.previous?.scale).toBe('percent');
    expect(valueOf(ga4PageMetrics(ctx.db, ctx.siteId, page, scope(page)).primaryConversionRate)).toBeCloseTo(0.5, 9);
  });
});
