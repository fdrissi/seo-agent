import { describe, expect, it } from 'vitest';
import { incomplete, observed, unavailable } from '../../../src/core/measured.js';
import { routeContentSignal, routeSite } from '../../../src/router/router.js';
import { DEFAULT_RULE_ORDER, evaluateRoute, resolveRuleOrder, ruleOrderFromConfig, rulesVersionFor, thresholdsFromConfig } from '../../../src/router/rules.js';
import { IntentClassifierRules } from '../../../src/router/intent.js';
import { reasonInputs } from '../../../src/router/types.js';
import { testSiteConfig } from '../../helpers/context.js';
import { baseInput, q, T } from '../../fixtures/seo/route-input.js';

const codes = (d: { reasons: Array<{ code: string }> }) => d.reasons.map((r) => r.code);

describe('router rules (spec section 18 order)', () => {
  it('routes a healthy page to HEALTHY (leave unchanged) with explainable reasons', () => {
    const d = evaluateRoute(baseInput(), T);
    expect(d.route).toBe('HEALTHY');
    expect(codes(d)).toEqual(['SUFFICIENT_EXPOSURE', 'STABLE', 'CTR_NOT_WEAK', 'CONVERSIONS_NOT_POOR', 'NO_RANKING_CANDIDATE_WITH_BUSINESS_EVIDENCE']);
    expect(d.nextStep).toMatch(/unchanged/);
    expect(d.decidedBy).toBe('rule');
    expect(d.rulesVersion).toMatch(/^router-rules@1\.1\.0\+[0-9a-f]{8}$/);
    expect(d.trace.map((t) => t.rule)).toEqual([...DEFAULT_RULE_ORDER]);
  });

  it('routes an active experiment before any opportunity (no stacking)', () => {
    const input = baseInput({
      experiments: [{ id: 'exp_1', status: 'observing', type: 'title_meta', observationEnd: '2026-10-20', reviewDate: null }],
      queries: [q('buy widgets online', { clicks: 5, impressions: 2000, position: 8, expectedCtr: 0.05 })],
    });
    const d = evaluateRoute(input, T);
    expect(d.route).toBe('EXPERIMENT_ACTIVE');
    expect(codes(d)).toContain('EXPERIMENT_OBSERVING');
    const pending = evaluateRoute(baseInput({ experiments: [{ id: 'exp_2', status: 'awaiting_implementation', type: 'title_meta', observationEnd: null, reviewDate: null }] }), T);
    expect(codes(pending)).toContain('EXPERIMENT_PENDING_IMPLEMENTATION');
    const due = evaluateRoute(baseInput({ experiments: [{ id: 'exp_3', status: 'observing', type: 'x', observationEnd: '2026-09-01', reviewDate: null }] }), T);
    expect(codes(due)).toContain('EXPERIMENT_REVIEW_DUE');
  });

  it('routes only CONFIRMED technical issues to TECHNICAL_BLOCKER; suspicions stay notes', () => {
    const blocked = evaluateRoute(baseInput({ technical: { confirmed: [{ source: 'technical_issue', type: 'accidental_noindex', severity: 'critical', confirmed: true, detail: 'noindex' }], suspected: [], inspection: null, latestCrawlStatus: 200 } }), T);
    expect(blocked.route).toBe('TECHNICAL_BLOCKER');
    expect(codes(blocked)).toEqual(['CONFIRMED_TECHNICAL_ISSUE']);
    const insp = evaluateRoute(baseInput({ technical: { confirmed: [{ source: 'url_inspection', type: 'indexing_blocked', severity: 'critical', confirmed: true, detail: 'BLOCKED_BY_META_TAG' }], suspected: [], inspection: null, latestCrawlStatus: 200 } }), T);
    expect(codes(insp)).toEqual(['INSPECTION_INDEXING_BLOCKED']);
    const suspected = evaluateRoute(baseInput({ technical: { confirmed: [], suspected: [{ source: 'technical_issue', type: 'duplicate_title', severity: 'low', confirmed: false, detail: 'dup' }], inspection: null, latestCrawlStatus: 200 } }), T);
    expect(suspected.route).toBe('HEALTHY');
    expect(suspected.notes.map((n) => n.code)).toContain('SUSPECTED_TECHNICAL_ISSUE');
  });

  it('treats a gone page (latest own crawl 404/410) as a confirmed blocker and words observed non-blockers honestly', () => {
    const gone = evaluateRoute(baseInput({ technical: { confirmed: [], suspected: [], inspection: null, latestCrawlStatus: 410 } }), T);
    expect(gone.route).toBe('TECHNICAL_BLOCKER');
    expect(codes(gone)).toEqual(['CRAWL_HTTP_ERROR']);
    expect(gone.reasons[0]!.detail).toMatch(/HTTP 410/);
    // An observed (confirmed) but non-blocking issue is not described as "not confirmed".
    const observedNote = evaluateRoute(
      baseInput({ technical: { confirmed: [], suspected: [{ source: 'technical_issue', type: 'access_blocked', severity: 'info', confirmed: true, detail: 'member area' }, { source: 'technical_issue', type: 'duplicate_title', severity: 'low', confirmed: false, detail: 'dup' }], inspection: null, latestCrawlStatus: 200 } }),
      T,
    );
    expect(observedNote.route).toBe('HEALTHY');
    const notes = observedNote.notes.filter((n) => n.code === 'SUSPECTED_TECHNICAL_ISSUE').map((n) => n.detail);
    expect(notes[0]).toMatch(/access_blocked \(info, observed, but not an access\/indexability blocker\)/);
    expect(notes[1]).toMatch(/duplicate_title \(low, not confirmed\)/);
  });

  it('does not call zero sessions a join gap when a confirmed access failure explains them', () => {
    const input = baseInput({ business: { ...baseInput().business, sessions: observed(0), convertingSessions: observed(0) }, technical: { confirmed: [], suspected: [], inspection: null, latestCrawlStatus: 404 } });
    const d = evaluateRoute(input, T);
    expect(d.route).toBe('TECHNICAL_BLOCKER');
    expect(d.notes.find((n) => n.code === 'JOIN_UNRESOLVED')!.detail).toMatch(/consistent with the confirmed access failure/);
    const noFailure = evaluateRoute(baseInput({ business: { ...baseInput().business, sessions: observed(0), convertingSessions: observed(0) } }), T);
    expect(noFailure.route).toBe('INVALID_OR_INCOMPLETE_DATA');
    expect(codes(noFailure)).toContain('JOIN_UNRESOLVED');
  });

  it('keeps site-wide and control-page experiments as notes (the page itself is routed)', () => {
    const d = evaluateRoute(
      baseInput({
        experiments: [
          { id: 'exp_site', status: 'observing', type: 'title_meta', observationEnd: '2026-10-20', reviewDate: null, scope: 'site' },
          { id: 'exp_ctl', status: 'observing', type: 'content_section', observationEnd: '2026-10-20', reviewDate: null, scope: 'comparison' },
        ],
      }),
      T,
    );
    expect(d.route).toBe('HEALTHY');
    expect(d.notes.map((n) => n.code)).toEqual(expect.arrayContaining(['EXPERIMENT_SITE_WIDE', 'EXPERIMENT_CONTROL_PAGE']));
    expect(d.inputsSummary.experiments).toEqual([
      { id: 'exp_site', status: 'observing', scope: 'site' },
      { id: 'exp_ctl', status: 'observing', scope: 'comparison' },
    ]);
  });

  it('routes prerequisites first: invalid data beats a technical blocker and an experiment', () => {
    const input = baseInput({
      measurement: { ...baseInput().measurement, conversionDefinition: 'missing' },
      technical: { confirmed: [{ source: 'technical_issue', type: 'server_error', severity: 'critical', confirmed: true, detail: '500' }], suspected: [], inspection: null, latestCrawlStatus: 500 },
      experiments: [{ id: 'e', status: 'observing', type: 'x', observationEnd: null, reviewDate: null }],
    });
    const d = evaluateRoute(input, T);
    expect(d.route).toBe('INVALID_OR_INCOMPLETE_DATA');
    expect(codes(d)).toContain('MISSING_CONVERSION_DEFINITION');
    expect(d.trace.find((t) => t.rule === 'technical_blocker')!.matched).toBe(false);
  });

  it('flags incomplete collection, primary-rate gaps, broken joins, and high "(not set)" share as INVALID_OR_INCOMPLETE_DATA', () => {
    expect(codes(evaluateRoute(baseInput({ measurement: { ...baseInput().measurement, gsc: 'incomplete', gscDetail: '3 dates not final' } }), T))).toContain('GSC_DATA_INCOMPLETE');
    expect(codes(evaluateRoute(baseInput({ measurement: { ...baseInput().measurement, primaryRateGap: 'rate not observed' } }), T))).toContain('PRIMARY_RATE_UNAVAILABLE');
    expect(codes(evaluateRoute(baseInput({ business: { ...baseInput().business, sessions: observed(0) } }), T))).toContain('JOIN_UNRESOLVED');
    expect(codes(evaluateRoute(baseInput({ measurement: { ...baseInput().measurement, notSetShare: observed(0.4) } }), T))).toContain('GA4_NOT_SET_SHARE_HIGH');
    const noReq = evaluateRoute(baseInput({ measurement: { ...baseInput().measurement, conversionDefinition: 'missing' } }), { ...T, requireConversionDefinition: false });
    expect(noReq.route).not.toBe('INVALID_OR_INCOMPLETE_DATA');
  });

  it('routes queries in positions 4-20 with business evidence to RANKING_OPPORTUNITY', () => {
    const d = evaluateRoute(baseInput({ queries: [q('best widgets', { clicks: 30, impressions: 2000, position: 7.5, expectedCtr: 0.015 })] }), T);
    expect(d.route).toBe('RANKING_OPPORTUNITY');
    expect(codes(d)).toEqual(expect.arrayContaining(['QUERY_POSITION_IN_RANGE', 'BUSINESS_EVIDENCE_COMMERCIAL_INTENT', 'BUSINESS_EVIDENCE_CONVERSIONS']));
    // The 4-20 band is adjustable.
    expect(evaluateRoute(baseInput({ queries: [q('best widgets', { clicks: 30, impressions: 2000, position: 7.5, expectedCtr: 0.015 })] }), { ...T, rankingPositionMax: 6 }).route).not.toBe('RANKING_OPPORTUNITY');
  });

  it('routes ambiguous intent to UNSURE instead of forcing a classification', () => {
    const input = baseInput({
      business: { ...baseInput().business, convertingSessions: observed(0), conversionRate: observed(0), previousConvertingSessions: observed(0) },
      queries: [q('blue widgets', { clicks: 30, impressions: 2000, position: 9, expectedCtr: 0.015 })],
    });
    const d = evaluateRoute(input, T);
    expect(d.route).toBe('UNSURE');
    expect(codes(d)).toContain('AMBIGUOUS_INTENT');
    const mixed = evaluateRoute({ ...input, queries: [q('how much does a widget cost', { clicks: 30, impressions: 2000, position: 9, expectedCtr: 0.015 })] }, T);
    expect(codes(mixed)).toContain('MIXED_INTENT');
    // An informational query without business evidence is not forced into an opportunity.
    const info = evaluateRoute({ ...input, queries: [q('what is a widget', { clicks: 30, impressions: 2000, position: 9, expectedCtr: 0.015 })] }, T);
    expect(info.route).toBe('HEALTHY');
  });

  it('records model-decided intent', () => {
    const qs = q('blue widgets', { clicks: 30, impressions: 2000, position: 9, expectedCtr: 0.015 });
    const input = baseInput({ queries: [{ ...qs, intent: { ...qs.intent, intent: 'commercial', ambiguous: false, decidedBy: 'model' } }] });
    const d = evaluateRoute(input, T);
    expect(d.route).toBe('RANKING_OPPORTUNITY');
    expect(d.decidedBy).toBe('model');
    expect(d.notes.map((n) => n.code)).toContain('INTENT_DECIDED_BY_MODEL');
  });

  it('routes weak CTR versus comparable positions on this site to CTR_OPPORTUNITY', () => {
    const d = evaluateRoute(baseInput({ queries: [q('what is a widget', { clicks: 10, impressions: 4000, position: 2.2, expectedCtr: 0.12 })] }), T);
    expect(d.route).toBe('CTR_OPPORTUNITY');
    expect(codes(d)).toEqual(['CTR_BELOW_COMPARABLE']);
    // No benchmark -> no inferred weakness.
    const nb = evaluateRoute(baseInput({ queries: [q('what is a widget', { clicks: 10, impressions: 4000, position: 2.2, expectedCtr: null })] }), T);
    expect(nb.route).toBe('HEALTHY');
    expect(nb.notes.map((n) => n.code)).toContain('CTR_BENCHMARK_UNAVAILABLE');
  });

  it('routes credibly poor conversion to CONVERSION_OPPORTUNITY (Wilson bound vs site benchmark)', () => {
    const d = evaluateRoute(baseInput({ business: { ...baseInput().business, sessions: observed(1500), convertingSessions: observed(1), conversionRate: observed(1 / 1500), benchmarkConversionRate: observed(0.03), previousConvertingSessions: observed(1) } }), T);
    expect(d.route).toBe('CONVERSION_OPPORTUNITY');
    // Small samples are not judged.
    const small = evaluateRoute(baseInput({ business: { ...baseInput().business, sessions: observed(150), convertingSessions: observed(0), conversionRate: observed(0), benchmarkConversionRate: observed(0.03), previousConvertingSessions: observed(0) } }), T);
    expect(small.route).toBe('HEALTHY');
  });

  it('routes a meaningful decline to DECLINE and ignores noise', () => {
    const d = evaluateRoute(baseInput({ search: { ...baseInput().search, clicks: observed(150), previousClicks: observed(320) } }), T);
    expect(d.route).toBe('DECLINE');
    expect(codes(d)).toContain('CLICKS_DECLINED');
    const noise = evaluateRoute(baseInput({ search: { ...baseInput().search, clicks: observed(6), previousClicks: observed(10), impressions: observed(5000) } }), T);
    expect(noise.route).not.toBe('DECLINE');
    const incompletePrev = evaluateRoute(baseInput({ search: { ...baseInput().search, clicks: observed(150), previousClicks: incomplete('fresh', 320) } }), T);
    expect(incompletePrev.route).not.toBe('DECLINE');
  });

  it('routes uncovered demand beyond position 20 to CONTENT_OPPORTUNITY when nothing else applies (consistent inputs: page impressions >= query impressions)', () => {
    // A page with 5000 impressions, healthy CTR at position 2, stable clicks, AND a relevant query with 400 impressions at position 34.
    const input = baseInput({ queries: [q('what is a widget', { clicks: 200, impressions: 3000, position: 1.8, expectedCtr: 0.07 }), q('widget repair guide', { clicks: 0, impressions: 400, position: 34 })] });
    expect(input.search.impressions).toEqual(observed(5000));
    const d = evaluateRoute(input, T);
    expect(d.route).toBe('CONTENT_OPPORTUNITY');
    expect(codes(d)).toEqual(['UNCOVERED_DEMAND_QUERIES']);
    expect(d.reasons[0]!.detail).toContain('"widget repair guide" (pos 34.0, 400 impr)');
    // HEALTHY was evaluated first and declined because of the uncovered demand (not skipped).
    expect(d.trace.find((t) => t.rule === 'healthy')!.matched).toBe(false);
  });

  it('keeps HEALTHY when the only query beyond the shortlist band is branded or navigational', () => {
    const branded = evaluateRoute(baseInput({ queries: [q('what is a widget', { clicks: 200, impressions: 3000, position: 1.8, expectedCtr: 0.07 }), q('acme widgets reviews', { clicks: 0, impressions: 400, position: 34 })] }), T);
    expect(branded.route).toBe('HEALTHY');
    const navigational = evaluateRoute(baseInput({ queries: [q('what is a widget', { clicks: 200, impressions: 3000, position: 1.8, expectedCtr: 0.07 }), q('widget login', { clicks: 0, impressions: 400, position: 34, intentOverride: 'navigational' })] }), T);
    expect(navigational.route).toBe('HEALTHY');
  });

  it('never concludes HEALTHY on unobserved impressions and never prints unknown impressions as 0', () => {
    // Row-limit truncation made the page aggregate incomplete while sessions alone make the page "data sufficient".
    const truncated = incomplete<number>('2 date(s) hit a row limit; absent rows may be omitted rather than zero', 4200);
    const d = evaluateRoute(baseInput({ search: { ...baseInput().search, impressions: truncated, clicks: incomplete('same', 250), ctr: incomplete('same', 0.06), position: incomplete('same', 2.2), previousClicks: null, previousImpressions: null }, queries: [] }), T);
    expect(d.route).not.toBe('HEALTHY');
    expect(d.route).toBe('UNSURE');
    const why = d.reasons.find((r) => r.code === 'SEARCH_METRICS_NOT_OBSERVED')!;
    expect(why.detail).toMatch(/impressions incomplete \(partial value 4200\): 2 date\(s\) hit a row limit/);
    expect(JSON.stringify(d)).not.toMatch(/\b0 impressions/);
    // Missing page totals and too few sessions: LOW_DATA, with the status spelled out.
    const low = evaluateRoute(baseInput({ search: { ...baseInput().search, impressions: unavailable('Search Console not resolved'), clicks: unavailable('n/a'), previousClicks: null, previousImpressions: null }, business: { ...baseInput().business, sessions: observed(40) }, queries: [] }), T);
    expect(low.route).toBe('LOW_DATA');
    expect(low.reasons[0]!.detail).toMatch(/impressions unavailable: Search Console not resolved/);
    expect(low.reasons[0]!.detail).not.toMatch(/\b0 impressions/);
  });

  it('HEALTHY reports observed impressions and sessions with their values', () => {
    const d = evaluateRoute(baseInput(), T);
    expect(d.reasons.find((r) => r.code === 'SUFFICIENT_EXPOSURE')!.detail).toBe('5000 impressions, 280 google_organic sessions in the period');
  });

  it('routes zero impressions without inspection to INDEXING_UNKNOWN (never delete/redirect)', () => {
    const input = baseInput({ search: { ...baseInput().search, impressions: observed(0), clicks: observed(0), ctr: unavailable('no impressions'), position: unavailable('no impressions'), previousClicks: observed(0), previousImpressions: observed(0) }, business: { ...baseInput().business, sessions: observed(0), convertingSessions: observed(0), previousConvertingSessions: observed(0) }, queries: [] });
    const d = evaluateRoute(input, T);
    expect(d.route).toBe('INDEXING_UNKNOWN');
    expect(codes(d)).toEqual(['NO_IMPRESSIONS_NOT_INSPECTED', 'NEVER_AUTO_DELETE_OR_REDIRECT']);
    const indexed = evaluateRoute({ ...input, technical: { ...input.technical, inspection: { verdict: 'PASS', coverageState: 'Submitted and indexed', indexingState: 'INDEXING_ALLOWED', robotsTxtState: 'ALLOWED', pageFetchState: 'SUCCESSFUL', inspectedAt: '2026-09-20T00:00:00Z' } } }, T);
    expect(indexed.route).toBe('LOW_DATA');
  });

  it('routes a low-data site to LOW_DATA (bootstrap)', () => {
    const d = evaluateRoute(baseInput({ site: { lowData: true, totalImpressions: observed(120), windowDays: 28 }, search: { ...baseInput().search, impressions: observed(40), clicks: observed(2), previousClicks: observed(3), previousImpressions: observed(50) }, business: { ...baseInput().business, sessions: observed(3), convertingSessions: observed(0), previousConvertingSessions: observed(0) }, queries: [] }), T);
    expect(d.route).toBe('LOW_DATA');
    expect(codes(d)).toEqual(['SITE_LOW_DATA']);
  });

  it('archives owner-excluded pages as IRRELEVANT with a reason', () => {
    const d = evaluateRoute(baseInput({ isExcluded: true, technical: { confirmed: [{ source: 'technical_issue', type: 'accidental_noindex', severity: 'critical', confirmed: true, detail: 'x' }], suspected: [], inspection: null, latestCrawlStatus: 200 } }), T);
    expect(d.route).toBe('IRRELEVANT');
    expect(codes(d)).toEqual(['EXCLUDED_PATH']);
  });

  it('supports a configurable rule order and versions the thresholds', () => {
    const input = baseInput({ queries: [q('best widgets', { clicks: 30, impressions: 2000, position: 7.5, expectedCtr: 0.2 })] });
    expect(evaluateRoute(input, T).route).toBe('RANKING_OPPORTUNITY');
    expect(evaluateRoute(input, T, { order: ['invalid_data', 'ctr', 'ranking'] }).route).toBe('CTR_OPPORTUNITY');
    expect(rulesVersionFor(T)).not.toBe(rulesVersionFor({ ...T, healthyCtrRatio: 0.5 }));
    const t = thresholdsFromConfig(testSiteConfig({ router: { rankingPositionMin: 3, rankingPositionMax: 15 } as never }));
    expect(t.rankingPositionMin).toBe(3);
    expect(t.minSessionsForConversion).toBe(200);
  });
});

describe('an unverified GA4 rate scale is not a measurement failure (B3-01)', () => {
  const scaleReason = 'rate scale unverified: sessionKeyEventRate:<event> is stored exactly as GA4 reported it (rate_scale = undetermined)';
  /** GA4 reported the rate, but its 0-1 vs 0-100 scale is not established: conversions cannot be assessed. */
  const scaleUnverified = (over: Parameters<typeof baseInput>[0] = {}) => {
    const b = baseInput(over);
    return {
      ...b,
      measurement: { ...b.measurement, primaryRateGap: null, rateScaleUnverified: scaleReason },
      business: { ...b.business, convertingSessions: unavailable(scaleReason), conversionRate: unavailable(scaleReason), benchmarkConversionRate: unavailable(scaleReason), previousConvertingSessions: unavailable(scaleReason) },
    };
  };

  it('routes a scale-unverified page with weak CTR to CTR_OPPORTUNITY, not INVALID_OR_INCOMPLETE_DATA', () => {
    const d = evaluateRoute(scaleUnverified({ queries: [q('what is a widget', { clicks: 10, impressions: 4000, position: 2.2, expectedCtr: 0.12 })] }), T);
    expect(d.route).toBe('CTR_OPPORTUNITY');
    expect(d.trace.find((t) => t.rule === 'invalid_data')!.matched).toBe(false);
    const note = d.notes.find((n) => n.code === 'RATE_SCALE_UNVERIFIED')!;
    expect(note.detail).toMatch(/^conversions not assessed: rate scale unverified/);
    expect(note.detail).toMatch(/Conversion-dependent routing/);
  });

  it('routes a scale-unverified commercial query in positions 4-20 to RANKING_OPPORTUNITY (commercial intent is business evidence; conversions are not)', () => {
    const d = evaluateRoute(scaleUnverified({ queries: [q('best widgets', { clicks: 30, impressions: 2000, position: 7.5, expectedCtr: 0.015 })] }), T);
    expect(d.route).toBe('RANKING_OPPORTUNITY');
    expect(codes(d)).toContain('BUSINESS_EVIDENCE_COMMERCIAL_INTENT');
    expect(codes(d)).not.toContain('BUSINESS_EVIDENCE_CONVERSIONS');
  });

  it('keeps conversion-dependent routes unavailable and says so when a page is otherwise healthy', () => {
    const d = evaluateRoute(scaleUnverified(), T);
    expect(d.route).toBe('HEALTHY');
    const na = d.reasons.find((r) => r.code === 'CONVERSIONS_NOT_ASSESSED')!;
    expect(na.detail).toMatch(/not assessed \(unmeasured\): conversion rate unavailable: rate scale unverified/);
    expect(codes(d)).not.toContain('CONVERSIONS_NOT_POOR');
    // Credibly "poor" conversion cannot be concluded from an unverified scale.
    const poorIfFraction = evaluateRoute(scaleUnverified({ business: { ...baseInput().business, sessions: observed(1500) } }), T);
    expect(poorIfFraction.route).not.toBe('CONVERSION_OPPORTUNITY');
  });

  it('still routes technical blockers, declines, and indexing gaps for scale-unverified pages', () => {
    expect(evaluateRoute(scaleUnverified({ technical: { confirmed: [], suspected: [], inspection: null, latestCrawlStatus: 404 } }), T).route).toBe('TECHNICAL_BLOCKER');
    expect(evaluateRoute(scaleUnverified({ search: { ...baseInput().search, clicks: observed(150), previousClicks: observed(320) } }), T).route).toBe('DECLINE');
    const zero = scaleUnverified({ search: { ...baseInput().search, impressions: observed(0), clicks: observed(0), ctr: unavailable('no impressions'), position: unavailable('no impressions'), previousClicks: observed(0), previousImpressions: observed(0) }, queries: [] });
    expect(evaluateRoute({ ...zero, business: { ...zero.business, sessions: observed(10) } }, T).route).toBe('INDEXING_UNKNOWN');
  });

  it('a rate that GA4 did not report is still a measurement gap (INVALID_OR_INCOMPLETE_DATA)', () => {
    const d = evaluateRoute(baseInput({ measurement: { ...baseInput().measurement, primaryRateGap: 'primary-event session rate (sessionKeyEventRate:<event>) not observed for 3 of 3 rows (missing)' } }), T);
    expect(d.route).toBe('INVALID_OR_INCOMPLETE_DATA');
    expect(codes(d)).toEqual(['PRIMARY_RATE_UNAVAILABLE']);
  });
});

describe('site and content-signal routing', () => {
  const site = { siteId: 'test-site', period: { start: '2026-08-25', end: '2026-09-21' }, gsc: 'complete' as const, gscDetail: 'ok', ga4: 'complete' as const, ga4Detail: 'ok', conversionDefinition: 'configured' as const, totalImpressions: observed(50_000), windowDays: 28, notSetShare: observed(0) };

  it('returns null when no site-level constraint applies', () => {
    expect(routeSite(site, T)).toBeNull();
  });

  it('routes missing data or definitions to INVALID and small sites to LOW_DATA', () => {
    expect(routeSite({ ...site, gsc: 'missing', gscDetail: 'no data' }, T)!.route).toBe('INVALID_OR_INCOMPLETE_DATA');
    expect(routeSite({ ...site, conversionDefinition: 'missing' }, T)!.reasons.map((r) => r.code)).toContain('MISSING_CONVERSION_DEFINITION');
    expect(routeSite({ ...site, ga4: 'not_configured', ga4Detail: 'none' }, T)!.route).toBe('INVALID_OR_INCOMPLETE_DATA');
    const low = routeSite({ ...site, totalImpressions: observed(80) }, T)!;
    expect(low.route).toBe('LOW_DATA');
    expect(low.nextStep).toMatch(/offer-page brief/);
  });

  it('routes content signals without auto-dismissing unclear relevance', () => {
    const rules = new IntentClassifierRules({ brandAliases: [] });
    const base = { siteId: 'test-site', signalId: 'sig_1', origin: 'apify_reddit', signalType: 'question', occurrences: 3, businessTerms: ['widget repair service'] };
    expect(routeContentSignal({ ...base, text: 'how to repair a widget?' }, rules.classify('how to repair a widget?'), T).route).toBe('CONTENT_OPPORTUNITY');
    expect(routeContentSignal({ ...base, text: 'how to bake bread?' }, rules.classify('how to bake bread?'), T).route).toBe('UNSURE');
    expect(routeContentSignal({ ...base, text: 'widget colors' }, rules.classify('widget colors'), T).route).toBe('UNSURE');
    const irr = routeContentSignal({ ...base, text: 'how to bake bread?', ownerDecision: 'irrelevant' }, rules.classify('how to bake bread?'), T);
    expect(irr.route).toBe('IRRELEVANT');
    expect(irr.decidedBy).toBe('owner');
  });
});

describe('configurable router thresholds and rule order (A6-13, A6-14)', () => {
  /** Config with router extras injected after schema parsing (fields may not be in the schema yet). */
  const withRouter = (extra: Record<string, unknown>) => {
    const cfg = testSiteConfig();
    return { ...cfg, router: { ...cfg.router, ...extra } } as typeof cfg;
  };

  it('reads the router extras from config and keeps documented defaults when absent or invalid', () => {
    const d = thresholdsFromConfig(testSiteConfig());
    expect(d).toMatchObject({ conversionPoorRatio: 0.5, notSetShareMax: 0.2, requireConversionDefinition: true, commercialPageTypes: ['offer', 'product', 'category', 'tool'], minClicksForJoinCheck: 20, minPreviousConversionsForDecline: 5 });
    const t = thresholdsFromConfig(withRouter({ conversionPoorRatio: 0.7, notSetShareMax: 0.1, requireConversionDefinition: false, commercialPageTypes: ['service', 'offer'], minClicksForJoinCheck: 50, minPreviousConversionsForDecline: 10 }));
    expect(t).toMatchObject({ conversionPoorRatio: 0.7, notSetShareMax: 0.1, requireConversionDefinition: false, commercialPageTypes: ['service', 'offer'], minClicksForJoinCheck: 50, minPreviousConversionsForDecline: 10 });
    const bad = thresholdsFromConfig(withRouter({ conversionPoorRatio: 3, notSetShareMax: 'x', commercialPageTypes: [1, 2], minClicksForJoinCheck: -1 }));
    expect(bad).toMatchObject({ conversionPoorRatio: 0.5, notSetShareMax: 0.2, commercialPageTypes: ['offer', 'product', 'category', 'tool'], minClicksForJoinCheck: 20 });
    // Explicit overrides still win.
    expect(thresholdsFromConfig(withRouter({ minClicksForJoinCheck: 50 }), { minClicksForJoinCheck: 7 }).minClicksForJoinCheck).toBe(7);
  });

  it('applies the configured join-check and conversion-decline minimums', () => {
    const zeroSessions = baseInput({ business: { ...baseInput().business, sessions: observed(0), convertingSessions: observed(0) } });
    expect(evaluateRoute(zeroSessions, T).route).toBe('INVALID_OR_INCOMPLETE_DATA');
    // 300 clicks < a configured minimum of 500: zero sessions are not called a join gap.
    expect(codes(evaluateRoute(zeroSessions, { ...T, minClicksForJoinCheck: 500 }))).not.toContain('JOIN_UNRESOLVED');
    // 8 -> 2 converting sessions: a decline under the default minimum of 5 previous conversions...
    const convDecline = baseInput({ business: { ...baseInput().business, convertingSessions: observed(2), conversionRate: observed(2 / 280), previousConvertingSessions: observed(8) } });
    const byDefault = evaluateRoute(convDecline, T);
    expect(byDefault.route).toBe('DECLINE');
    expect(codes(byDefault)).toContain('CONVERSIONS_DECLINED');
    // ...but not when the owner requires at least 10 previous conversions.
    const configured = evaluateRoute(convDecline, { ...T, minPreviousConversionsForDecline: 10 });
    expect(configured.route).not.toBe('DECLINE');
    expect(codes(configured)).not.toContain('CONVERSIONS_DECLINED');
    expect(configured.rulesVersion).not.toBe(byDefault.rulesVersion);
  });

  it('validates router.ruleOrder, completes it, and forces the prerequisite rules first', () => {
    expect(resolveRuleOrder(undefined)).toEqual([...DEFAULT_RULE_ORDER]);
    const o = resolveRuleOrder(['ctr', 'ranking', 'invalid_data']);
    expect(o.slice(0, 3)).toEqual(['invalid_data', 'technical_blocker', 'experiment_active']);
    expect(o.slice(3, 5)).toEqual(['ctr', 'ranking']);
    expect([...o].sort()).toEqual([...DEFAULT_RULE_ORDER].sort());
    expect(() => resolveRuleOrder(['ctr', 'rank'])).toThrow(/unknown rule\(s\) "rank"/);
    expect(() => resolveRuleOrder(['ctr', 'ctr'])).toThrow(/duplicate rule\(s\) ctr/);
    expect(ruleOrderFromConfig(testSiteConfig())).toEqual([...DEFAULT_RULE_ORDER]);
    expect(ruleOrderFromConfig(withRouter({ ruleOrder: ['ctr', 'ranking'] })).slice(0, 5)).toEqual(['invalid_data', 'technical_blocker', 'experiment_active', 'ctr', 'ranking']);
    expect(() => ruleOrderFromConfig(withRouter({ ruleOrder: 'ctr' }))).toThrow(/must be a list/);
  });

  it('a configured order changes the route but never lets an optimization beat a prerequisite; rules_version hashes the order', () => {
    const input = baseInput({ queries: [q('best widgets', { clicks: 30, impressions: 2000, position: 7.5, expectedCtr: 0.2 })] });
    const order = resolveRuleOrder(['ctr', 'ranking']);
    const d = evaluateRoute(input, T, { order });
    expect(d.route).toBe('CTR_OPPORTUNITY');
    expect(d.trace.map((x) => x.rule)).toEqual(order);
    expect(d.rulesVersion).not.toBe(evaluateRoute(input, T).rulesVersion);
    // Owner puts ctr first: the experiment prerequisite still wins.
    const withExperiment = { ...input, experiments: [{ id: 'exp_1', status: 'observing', type: 'title_meta', observationEnd: null, reviewDate: null }] };
    expect(evaluateRoute(withExperiment, T, { order: resolveRuleOrder(['ctr']) }).route).toBe('EXPERIMENT_ACTIVE');
  });

  it('HEALTHY says CONVERSIONS_NOT_ASSESSED when conversion performance was not measured or judged', () => {
    const insufficient = evaluateRoute(baseInput({ business: { ...baseInput().business, sessions: observed(150), convertingSessions: observed(0), conversionRate: observed(0), benchmarkConversionRate: observed(0.03), previousConvertingSessions: observed(0) } }), T);
    expect(insufficient.route).toBe('HEALTHY');
    expect(codes(insufficient)).toContain('CONVERSIONS_NOT_ASSESSED');
    expect(codes(insufficient)).not.toContain('CONVERSIONS_NOT_POOR');
    expect(insufficient.reasons.find((r) => r.code === 'CONVERSIONS_NOT_ASSESSED')!.detail).toMatch(/not assessed \(insufficient\)/);
    const unmeasured = evaluateRoute(baseInput({ business: { ...baseInput().business, conversionRate: unavailable('rate not reported') } }), T);
    expect(unmeasured.route).toBe('HEALTHY');
    expect(codes(unmeasured)).toContain('CONVERSIONS_NOT_ASSESSED');
    const noBench = evaluateRoute(baseInput({ business: { ...baseInput().business, benchmarkConversionRate: unavailable('no site rate') } }), T);
    expect(codes(noBench)).toContain('CONVERSIONS_NOT_ASSESSED');
    expect(codes(evaluateRoute(baseInput(), T))).toContain('CONVERSIONS_NOT_POOR');
  });

  it('routeSite versions the site decision with the rule order', () => {
    const site = { siteId: 'test-site', period: { start: '2026-08-25', end: '2026-09-21' }, gsc: 'missing' as const, gscDetail: 'none', ga4: 'complete' as const, ga4Detail: 'ok', conversionDefinition: 'configured' as const, totalImpressions: observed(50_000), windowDays: 28, notSetShare: observed(0) };
    expect(routeSite(site, T, resolveRuleOrder(['ctr']))!.rulesVersion).not.toBe(routeSite(site, T)!.rulesVersion);
  });
});

describe('reasons record the measured inputs they rest on (D2-ACC-03)', () => {
  const inputsOf = (d: { reasons: Array<{ code: string; data?: Record<string, unknown> }> }, code: string) => reasonInputs(d.reasons.find((r) => r.code === code)!);

  it('query reasons carry per-query rows (observed position, impressions, clicks) and the routing window', () => {
    const ranking = evaluateRoute(baseInput({ queries: [q('best widgets', { clicks: 30, impressions: 2000, position: 7.5, expectedCtr: 0.015 })] }), T);
    expect(inputsOf(ranking, 'QUERY_POSITION_IN_RANGE')).toEqual({ source: 'gsc', table: 'gsc_page_query_daily_current', period: { start: '2026-08-25', end: '2026-09-21' }, rows: [{ query: 'best widgets', position: 7.5, impressions: 2000, clicks: 30 }] });
    expect(inputsOf(ranking, 'BUSINESS_EVIDENCE_COMMERCIAL_INTENT')!.rows).toEqual([{ query: 'best widgets', position: 7.5, impressions: 2000, clicks: 30 }]);
    expect(inputsOf(ranking, 'BUSINESS_EVIDENCE_CONVERSIONS')).toMatchObject({ source: 'ga4', table: 'ga4_landing_daily_current', values: { convertingSessions: 8, sessions: 280 } });
    // The existing data fields stay (query names), with the inputs next to them.
    expect(ranking.reasons[0]!.data).toMatchObject({ queries: ['best widgets'] });
    const ctr = evaluateRoute(baseInput({ queries: [q('what is a widget', { clicks: 10, impressions: 4000, position: 2.2, expectedCtr: 0.12 })] }), T);
    expect(ctr.route).toBe('CTR_OPPORTUNITY');
    expect(inputsOf(ctr, 'CTR_BELOW_COMPARABLE')!.rows).toEqual([{ query: 'what is a widget', position: 2.2, impressions: 4000, clicks: 10, ctr: 10 / 4000, expectedCtr: 0.12 }]);
  });

  it('a value that was not observed is null, never 0; a reason with nothing observed records no inputs', () => {
    const partly = evaluateRoute(baseInput({ search: { ...baseInput().search, impressions: observed(60), clicks: observed(3), previousClicks: observed(3), previousImpressions: observed(55) }, queries: [], business: { ...baseInput().business, sessions: unavailable('not synced'), convertingSessions: unavailable('not synced'), conversionRate: unavailable('not synced') } }), T);
    expect(partly.route).toBe('LOW_DATA');
    expect(inputsOf(partly, 'PAGE_BELOW_EVIDENCE_THRESHOLD')!.values).toMatchObject({ impressions: 60, sessions: null });
    const nothing = evaluateRoute(baseInput({ search: { ...baseInput().search, impressions: incomplete('partial days'), clicks: incomplete('partial days') }, queries: [], business: { ...baseInput().business, sessions: unavailable('not synced'), convertingSessions: unavailable('not synced'), conversionRate: unavailable('not synced') } }), T);
    expect(nothing.route).toBe('LOW_DATA');
    expect(inputsOf(nothing, 'PAGE_BELOW_EVIDENCE_THRESHOLD')).toBeNull();
    // Records, configuration, and "no rule matched" carry none.
    const exp = evaluateRoute(baseInput({ experiments: [{ id: 'exp_1', status: 'observing', type: 'title_meta', observationEnd: null, reviewDate: null }] }), T);
    expect(exp.reasons.every((r) => reasonInputs(r) === null)).toBe(true);
    const excluded = evaluateRoute(baseInput({ isExcluded: true }), T);
    expect(excluded.reasons.every((r) => reasonInputs(r) === null)).toBe(true);
  });

  it('technical and URL Inspection reasons cite their observation (no routing window); site reasons cite coverage and property totals', () => {
    const blocked = evaluateRoute(baseInput({ technical: { confirmed: [{ source: 'url_inspection', type: 'indexing_blocked', severity: 'critical', confirmed: true, detail: 'BLOCKED_BY_META_TAG' }], suspected: [], inspection: null, latestCrawlStatus: 200 } }), T);
    expect(inputsOf(blocked, 'INSPECTION_INDEXING_BLOCKED')).toEqual({ source: 'url_inspection', table: 'url_inspections', period: null, values: { type: 'indexing_blocked', severity: 'critical', confirmed: true } });
    const site = { siteId: 'test-site', period: { start: '2026-08-25', end: '2026-09-21' }, gsc: 'missing' as const, gscDetail: 'no sync', ga4: 'complete' as const, ga4Detail: 'ok', conversionDefinition: 'missing' as const, totalImpressions: observed(50_000), windowDays: 28, notSetShare: observed(0) };
    const invalid = routeSite(site, T)!;
    expect(inputsOf(invalid, 'GSC_DATA_MISSING')).toMatchObject({ source: 'gsc', table: 'ingestion_batches', values: { coverage: 'missing' } });
    expect(inputsOf(invalid, 'MISSING_CONVERSION_DEFINITION')).toBeNull();
    const low = routeSite({ ...site, gsc: 'complete', conversionDefinition: 'configured', totalImpressions: observed(80) }, T)!;
    expect(inputsOf(low, 'SITE_LOW_DATA')).toMatchObject({ source: 'gsc', table: 'gsc_property_daily_current', values: { totalImpressions: 80, windowDays: 28 } });
  });

  it('reasonInputs rejects malformed stored data (older rows, hand-edited JSON)', () => {
    expect(reasonInputs({})).toBeNull();
    expect(reasonInputs({ data: { inputs: { source: 'serp', table: 'x', values: { a: 1 } } } })).toBeNull();
    expect(reasonInputs({ data: { inputs: { source: 'gsc', table: '', values: { a: 1 } } } })).toBeNull();
    expect(reasonInputs({ data: { inputs: { source: 'gsc', table: 'gsc_page_daily_current', values: {} } } })).toBeNull();
    expect(reasonInputs({ data: { inputs: { source: 'gsc', table: 'gsc_page_daily_current', rows: [{ nope: 1 }] } } })).toBeNull();
    expect(reasonInputs({ data: { inputs: { source: 'gsc', table: 'gsc_page_daily_current', period: 'bad', values: { impressions: 5 } } } })).toEqual({ source: 'gsc', table: 'gsc_page_daily_current', period: null, values: { impressions: 5 } });
  });
});
