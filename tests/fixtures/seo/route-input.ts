/**
 * SYNTHETIC router inputs for unit tests (example.test URLs only).
 */
import { observed, unavailable, type Measured } from '../../../src/core/measured.js';
import { IntentClassifierRules } from '../../../src/router/intent.js';
import type { PageRouteInput, QuerySignal, RouterThresholds } from '../../../src/router/types.js';

export const T: RouterThresholds = {
  rankingPositionMin: 4,
  rankingPositionMax: 20,
  minImpressionsForOpportunity: 100,
  lowDataSiteMaxImpressions: 500,
  declineThresholdPct: 25,
  healthyCtrRatio: 0.8,
  minSessionsForConversion: 200,
  conversionPoorRatio: 0.5,
  notSetShareMax: 0.2,
  requireConversionDefinition: true,
  commercialPageTypes: ['offer', 'product', 'category', 'tool'],
  maxQueriesInReasons: 5,
};

const rules = new IntentClassifierRules({ brandAliases: ['Acme Widgets'], languages: [] });

export function q(query: string, o: { clicks: number; impressions: number; position: number; expectedCtr?: number | null; intentOverride?: QuerySignal['intent']['intent'] }): QuerySignal {
  const intent = rules.classify(query);
  const i = o.intentOverride ? { ...intent, intent: o.intentOverride, ambiguous: o.intentOverride === 'mixed' || o.intentOverride === 'unsure' } : intent;
  return {
    query,
    clicks: observed(o.clicks),
    impressions: observed(o.impressions),
    ctr: o.impressions ? observed(o.clicks / o.impressions) : unavailable('no impressions'),
    position: observed(o.position),
    expectedCtr: o.expectedCtr === null || o.expectedCtr === undefined ? unavailable('no benchmark') : observed(o.expectedCtr),
    intent: i,
  };
}

const m = (v: number | null): Measured<number> => (v === null ? unavailable('n/a') : observed(v));

/** A healthy, fully measured page; override pieces per test. */
export function baseInput(over: Partial<PageRouteInput> = {}): PageRouteInput {
  const base: PageRouteInput = {
    siteId: 'test-site',
    pageId: 'page_1',
    url: 'https://www.example.test/guide',
    pageType: null,
    isExcluded: false,
    isProtected: false,
    period: { start: '2026-08-25', end: '2026-09-21' },
    previous: { start: '2026-07-28', end: '2026-08-24' },
    measurement: { gsc: 'complete', gscDetail: 'ok', ga4: 'complete', ga4Detail: 'ok', conversionDefinition: 'configured', primaryRateGap: null, joinIssues: [], notSetShare: observed(0.01) },
    technical: { confirmed: [], suspected: [], inspection: null, latestCrawlStatus: 200 },
    experiments: [],
    search: { clicks: m(300), impressions: m(5000), ctr: m(0.06), position: m(2.1), expectedCtr: m(0.06), previousClicks: m(310), previousImpressions: m(5100) },
    queries: [q('what is a widget', { clicks: 200, impressions: 3000, position: 1.8, expectedCtr: 0.07 })],
    business: { sessions: m(280), convertingSessions: m(8), conversionRate: m(8 / 280), benchmarkConversionRate: m(0.025), previousConvertingSessions: m(9) },
    site: { lowData: false, totalImpressions: m(50_000), windowDays: 28 },
    today: '2026-09-24',
  };
  return { ...base, ...over };
}
