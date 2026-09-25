import { AppError } from '../core/errors.js';
import { hashObject } from '../core/hash.js';
import { valueOf, type Measured } from '../core/measured.js';
import type { SiteConfig } from '../config/site-schema.js';
import { compareMeasured, type Change } from '../seo/metrics.js';
import { wilsonInterval } from '../seo/stats.js';
import {
  ROUTE_NEXT_STEP,
  type ConversionStatus,
  type PageRouteInput,
  type QuerySignal,
  type ReasonCode,
  type ReasonInputs,
  type ReasonInputSource,
  type ReasonQueryRow,
  type Route,
  type RouteDecision,
  type RouterThresholds,
  type RuleTrace,
} from './types.js';

/**
 * Deterministic, ordered routing rules with explainable reason codes.
 * Prerequisites (data validity, confirmed technical blockers, active
 * experiments) are evaluated before any optimization opportunity. The first
 * matching rule decides; every rule's outcome is kept in the trace.
 */

export const RULES_VERSION = 'router-rules@1.1.0';

export type RuleId = 'invalid_data' | 'technical_blocker' | 'experiment_active' | 'healthy' | 'ranking' | 'ctr' | 'conversion' | 'decline' | 'content' | 'indexing_unknown' | 'low_data' | 'irrelevant';

/** Spec section 18 order. */
export const DEFAULT_RULE_ORDER: readonly RuleId[] = ['invalid_data', 'technical_blocker', 'experiment_active', 'healthy', 'ranking', 'ctr', 'conversion', 'decline', 'content', 'indexing_unknown', 'low_data', 'irrelevant'];

/** Prerequisite rules: always evaluated first, in this order, whatever `router.ruleOrder` says (spec section 18). */
export const PREREQUISITE_RULES: readonly RuleId[] = ['invalid_data', 'technical_blocker', 'experiment_active'];

export const DEFAULT_THRESHOLD_EXTRAS = {
  conversionPoorRatio: 0.5,
  notSetShareMax: 0.2,
  requireConversionDefinition: true,
  commercialPageTypes: ['offer', 'product', 'category', 'tool'],
  maxQueriesInReasons: 5,
  minClicksForJoinCheck: 20,
  minPreviousConversionsForDecline: 5,
} as const;

/**
 * Optional router fields of the site config (`router.conversionPoorRatio`,
 * `router.notSetShareMax`, `router.requireConversionDefinition`,
 * `router.commercialPageTypes`, `router.minClicksForJoinCheck`,
 * `router.minPreviousConversionsForDecline`, `router.ruleOrder`). Read
 * defensively: a field that is absent (or of the wrong type) falls back to the
 * documented default above, never to a guessed value.
 */
function routerExtras(config: Pick<SiteConfig, 'router'>): Record<string, unknown> {
  const r = (config as { router?: unknown }).router;
  return r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
}

const finiteNumber = (v: unknown, min: number, max: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined);
const nonNegativeInt = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);

function stringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
  return out.length === v.length ? [...new Set(out)] : undefined;
}

/** Page types that count as commercial business evidence (`router.commercialPageTypes`, else the documented default). */
export function commercialPageTypesFromConfig(config: Pick<SiteConfig, 'router'>): string[] {
  return stringList(routerExtras(config).commercialPageTypes) ?? [...DEFAULT_THRESHOLD_EXTRAS.commercialPageTypes];
}

export function thresholdsFromConfig(config: Pick<SiteConfig, 'router' | 'experiments'>, overrides: Partial<RouterThresholds> = {}): RouterThresholds {
  const x = routerExtras(config);
  const D = DEFAULT_THRESHOLD_EXTRAS;
  return {
    rankingPositionMin: config.router.rankingPositionMin,
    rankingPositionMax: config.router.rankingPositionMax,
    minImpressionsForOpportunity: config.router.minImpressionsForOpportunity,
    lowDataSiteMaxImpressions: config.router.lowDataSiteMaxImpressions,
    declineThresholdPct: config.router.declineThresholdPct,
    healthyCtrRatio: config.router.healthyCtrRatio,
    minSessionsForConversion: config.experiments.minSessionsForConversionEvaluation,
    conversionPoorRatio: finiteNumber(x.conversionPoorRatio, 0, 1) ?? D.conversionPoorRatio,
    notSetShareMax: finiteNumber(x.notSetShareMax, 0, 1) ?? D.notSetShareMax,
    requireConversionDefinition: typeof x.requireConversionDefinition === 'boolean' ? x.requireConversionDefinition : D.requireConversionDefinition,
    commercialPageTypes: commercialPageTypesFromConfig(config),
    maxQueriesInReasons: D.maxQueriesInReasons,
    minClicksForJoinCheck: nonNegativeInt(x.minClicksForJoinCheck) ?? D.minClicksForJoinCheck,
    minPreviousConversionsForDecline: nonNegativeInt(x.minPreviousConversionsForDecline) ?? D.minPreviousConversionsForDecline,
    ...overrides,
  };
}

export const RULE_IDS: readonly RuleId[] = DEFAULT_RULE_ORDER;

/**
 * Resolve a configurable rule order (`router.ruleOrder`). Every entry must be a
 * known RuleId (no duplicates); missing rules are appended in the default
 * order; the prerequisite rules (invalid_data, technical_blocker,
 * experiment_active) are always forced first, in that order, so an owner can
 * never route an optimization before data validity, confirmed blockers, or an
 * active experiment. Undefined/empty -> DEFAULT_RULE_ORDER.
 */
export function resolveRuleOrder(order: readonly string[] | null | undefined): RuleId[] {
  if (!order || order.length === 0) return [...DEFAULT_RULE_ORDER];
  const known = new Set<string>(RULE_IDS);
  const unknown = order.filter((o) => !known.has(o));
  const dupes = order.filter((o, i) => order.indexOf(o) !== i);
  if (unknown.length || dupes.length) {
    throw new AppError('CONFIG_INVALID', `router.ruleOrder is invalid: ${[unknown.length ? `unknown rule(s) ${unknown.map((u) => `"${u}"`).join(', ')}` : null, dupes.length ? `duplicate rule(s) ${[...new Set(dupes)].join(', ')}` : null].filter(Boolean).join('; ')}.`, {
      hint: `Use only these rule ids, each at most once: ${RULE_IDS.join(', ')} (missing ones are appended in the default order; ${PREREQUISITE_RULES.join(', ')} always run first).`,
      details: { unknown, duplicates: [...new Set(dupes)] },
    });
  }
  const rest = (order as RuleId[]).filter((o) => !PREREQUISITE_RULES.includes(o));
  const missing = DEFAULT_RULE_ORDER.filter((o) => !PREREQUISITE_RULES.includes(o) && !rest.includes(o));
  return [...PREREQUISITE_RULES, ...rest, ...missing];
}

/** The rule order configured for the site (`router.ruleOrder`), validated and completed. */
export function ruleOrderFromConfig(config: Pick<SiteConfig, 'router'>): RuleId[] {
  const raw = routerExtras(config).ruleOrder;
  if (raw === undefined || raw === null) return [...DEFAULT_RULE_ORDER];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
    throw new AppError('CONFIG_INVALID', 'router.ruleOrder must be a list of rule ids.', { hint: `Valid rule ids: ${RULE_IDS.join(', ')}.` });
  }
  return resolveRuleOrder(raw as string[]);
}

/** rules_version recorded with every decision: code version plus a hash of thresholds and order. */
export function rulesVersionFor(t: RouterThresholds, order: readonly RuleId[] = DEFAULT_RULE_ORDER): string {
  return `${RULES_VERSION}+${hashObject({ t, order }).slice(0, 8)}`;
}

const num = (m: Measured<number> | null | undefined): number | undefined => (m ? valueOf(m) : undefined);
/** Observed value or null ("not observed", never 0), for recorded reason inputs. */
const obs = (m: Measured<number> | null | undefined): number | null => (m && m.status === 'observed' ? m.value : null);

/** Views/tables named as the locator of a reason's inputs. */
const GSC_PAGE = 'gsc_page_daily_current';
const GSC_QUERY = 'gsc_page_query_daily_current';
const GSC_PROPERTY = 'gsc_property_daily_current';
const GA4_LANDING = 'ga4_landing_daily_current';
const BATCHES = 'ingestion_batches';
/** At most this many per-query rows are recorded as a reason's inputs. */
const MAX_INPUT_ROWS = 20;

/**
 * `{ inputs }` for `ReasonCode.data`: the measured inputs a reason rests on
 * (ReasonInputs). A value that was not observed is null, never 0.
 */
export function reasonInputsData(period: { start: string; end: string } | null, source: ReasonInputSource, table: string, x: { values?: NonNullable<ReasonInputs['values']>; rows?: ReasonQueryRow[] }): { inputs: ReasonInputs } {
  return { inputs: { source, table, period: period ? { start: period.start, end: period.end } : null, ...x } };
}

/** Per-query rows (observed position, impressions, clicks; CTR and comparable CTR for CTR reasons). */
function queryRows(qs: readonly QuerySignal[], withCtr = false): ReasonQueryRow[] {
  return qs.slice(0, MAX_INPUT_ROWS).map((q) => ({ query: q.query, position: obs(q.position), impressions: obs(q.impressions), clicks: obs(q.clicks), ...(withCtr ? { ctr: obs(q.ctr), expectedCtr: obs(q.expectedCtr) } : {}) }));
}

/** GA4 conversion inputs of the page (sessions, converting sessions, rate, site benchmark). */
function conversionValues(input: PageRouteInput): NonNullable<ReasonInputs['values']> {
  return { sessions: obs(input.business.sessions), convertingSessions: obs(input.business.convertingSessions), conversionRate: obs(input.business.conversionRate), benchmarkConversionRate: obs(input.business.benchmarkConversionRate) };
}

/** "5000 impressions", or the status and reason of a value that is not observed (never 0). */
export function describeMeasuredCount(m: Measured<number> | null | undefined, label: string): string {
  if (!m) return `${label} unknown`;
  if (m.status === 'observed') return `${m.value} ${label}`;
  const partial = m.status === 'incomplete' && m.partialValue !== undefined ? ` (partial value ${m.partialValue})` : '';
  return `${label} ${m.status}${partial}: ${m.reason}`;
}

export interface DerivedSignals {
  impressions: number | undefined;
  sessions: number | undefined;
  dataSufficient: boolean;
  conversionStatus: ConversionStatus;
  conversionDetail: string;
  clicksChange: Measured<Change>;
  conversionsChange: Measured<Change> | null;
  declineReasons: ReasonCode[];
  previousComparable: boolean;
  ctrWeakQueries: QuerySignal[];
  pageCtrWeak: boolean | null;
  ctrBenchmarkAvailable: boolean;
  rankingCandidates: QuerySignal[];
  businessEvidence: ReasonCode[];
  uncoveredDemand: QuerySignal[];
}

function ctrWeak(clicks: number, impressions: number, expected: number, ratio: number): boolean {
  const w = wilsonInterval(clicks, impressions);
  return w !== null && w.high < expected * ratio;
}

function listQueries(qs: QuerySignal[], t: RouterThresholds): string {
  const shown = qs.slice(0, t.maxQueriesInReasons).map((q) => `"${q.query}" (pos ${num(q.position)?.toFixed(1) ?? '?'}, ${num(q.impressions) ?? '?'} impr)`);
  return shown.join(', ') + (qs.length > shown.length ? ` and ${qs.length - shown.length} more` : '');
}

export function deriveSignals(input: PageRouteInput, t: RouterThresholds): DerivedSignals {
  const impressions = num(input.search.impressions);
  const sessions = num(input.business.sessions);
  const dataSufficient = (impressions ?? 0) >= t.minImpressionsForOpportunity || (sessions ?? 0) >= t.minSessionsForConversion;

  // Conversion status (Wilson interval against the site's own benchmark).
  let conversionStatus: ConversionStatus;
  let conversionDetail: string;
  const rate = num(input.business.conversionRate);
  const converting = num(input.business.convertingSessions);
  const bench = num(input.business.benchmarkConversionRate);
  if (input.measurement.conversionDefinition === 'missing') {
    conversionStatus = 'unmeasured';
    conversionDetail = 'no primary conversion event configured';
  } else if (rate === undefined || converting === undefined || sessions === undefined) {
    conversionStatus = 'unmeasured';
    const r = input.business.conversionRate;
    conversionDetail = r.status === 'observed' ? 'conversion inputs incomplete' : `conversion rate ${r.status}: ${r.reason}`;
  } else if (sessions < t.minSessionsForConversion) {
    conversionStatus = 'insufficient';
    conversionDetail = `${sessions} sessions < ${t.minSessionsForConversion} required to judge conversion performance`;
  } else if (bench === undefined) {
    conversionStatus = 'no_benchmark';
    conversionDetail = 'site conversion benchmark unavailable';
  } else {
    const w = wilsonInterval(converting, sessions)!;
    if (w.high < bench * t.conversionPoorRatio) {
      conversionStatus = 'poor';
      conversionDetail = `page rate ${(rate * 100).toFixed(2)}% (95% upper bound ${(w.high * 100).toFixed(2)}%) is below ${t.conversionPoorRatio} x site rate ${(bench * 100).toFixed(2)}%`;
    } else {
      conversionStatus = 'satisfactory';
      conversionDetail = `page rate ${(rate * 100).toFixed(2)}% vs site ${(bench * 100).toFixed(2)}% (not credibly below ${t.conversionPoorRatio} x site rate)`;
    }
  }

  // Decline: complete, comparable periods only; noise guard 2*sqrt(previous).
  const clicksChange = input.search.previousClicks ? compareMeasured(input.search.clicks, input.search.previousClicks) : compareMeasured(input.search.clicks, { status: 'unavailable', reason: 'no previous period' });
  const previousComparable = clicksChange.status === 'observed';
  const declineReasons: ReasonCode[] = [];
  const prevImpr = num(input.search.previousImpressions);
  if (clicksChange.status === 'observed') {
    const c = clicksChange.value;
    const pct = valueOf(c.pct);
    if (pct !== undefined && pct <= -t.declineThresholdPct && (prevImpr ?? 0) >= t.minImpressionsForOpportunity && -c.absolute > 2 * Math.sqrt(c.previous)) {
      declineReasons.push({
        code: 'CLICKS_DECLINED',
        detail: `clicks ${c.previous} -> ${c.current} (${pct}%) versus the previous comparable period`,
        data: { previous: c.previous, current: c.current, pct, ...reasonInputsData(input.period, 'gsc', GSC_PAGE, { values: { previousClicks: c.previous, currentClicks: c.current, pct, previousImpressions: prevImpr ?? null, previousStart: input.previous?.start ?? null, previousEnd: input.previous?.end ?? null } }) },
      });
    }
  }
  let conversionsChange: Measured<Change> | null = null;
  if (input.business.previousConvertingSessions) {
    conversionsChange = compareMeasured(input.business.convertingSessions, input.business.previousConvertingSessions);
    if (conversionsChange.status === 'observed') {
      const c = conversionsChange.value;
      const pct = valueOf(c.pct);
      if (pct !== undefined && pct <= -t.declineThresholdPct && c.previous >= (t.minPreviousConversionsForDecline ?? DEFAULT_THRESHOLD_EXTRAS.minPreviousConversionsForDecline) && -c.absolute > 2 * Math.sqrt(c.previous)) {
        declineReasons.push({
          code: 'CONVERSIONS_DECLINED',
          detail: `converting sessions ${c.previous} -> ${c.current} (${pct}%)`,
          data: { previous: c.previous, current: c.current, pct, ...reasonInputsData(input.period, 'ga4', GA4_LANDING, { values: { previousConvertingSessions: c.previous, currentConvertingSessions: c.current, pct, previousStart: input.previous?.start ?? null, previousEnd: input.previous?.end ?? null } }) },
        });
      }
    }
  }

  // CTR versus comparable positions (this site's own data).
  const ctrWeakQueries: QuerySignal[] = [];
  let ctrBenchmarkAvailable = false;
  for (const q of input.queries) {
    const qi = num(q.impressions);
    const qc = num(q.clicks);
    const exp = num(q.expectedCtr);
    if (exp !== undefined) ctrBenchmarkAvailable = true;
    if (qi === undefined || qc === undefined || exp === undefined || qi < t.minImpressionsForOpportunity) continue;
    if (ctrWeak(qc, qi, exp, t.healthyCtrRatio)) ctrWeakQueries.push(q);
  }
  let pageCtrWeak: boolean | null = null;
  if (input.queries.length === 0) {
    const exp = num(input.search.expectedCtr);
    const c = num(input.search.clicks);
    if (exp !== undefined) ctrBenchmarkAvailable = true;
    if (exp !== undefined && c !== undefined && impressions !== undefined && impressions >= t.minImpressionsForOpportunity) pageCtrWeak = ctrWeak(c, impressions, exp, t.healthyCtrRatio);
  } else pageCtrWeak = ctrWeakQueries.length > 0;

  // Ranking shortlist heuristic (query-level positions).
  const rankingCandidates = input.queries.filter((q) => {
    const p = num(q.position);
    const i = num(q.impressions);
    return p !== undefined && i !== undefined && p >= t.rankingPositionMin && p <= t.rankingPositionMax && i >= t.minImpressionsForOpportunity;
  });
  const businessEvidence: ReasonCode[] = [];
  if ((converting ?? 0) > 0) businessEvidence.push({ code: 'BUSINESS_EVIDENCE_CONVERSIONS', detail: `~${converting} converting session(s) recorded on this page in the period`, data: reasonInputsData(input.period, 'ga4', GA4_LANDING, { values: { convertingSessions: converting ?? null, sessions: sessions ?? null } }) });
  if (input.pageType && t.commercialPageTypes.includes(input.pageType)) businessEvidence.push({ code: 'BUSINESS_EVIDENCE_PAGE_TYPE', detail: `page type "${input.pageType}" is configured as commercial` });
  const commercial = rankingCandidates.filter((q) => q.intent.intent === 'commercial' || q.intent.intent === 'transactional');
  if (commercial.length) businessEvidence.push({ code: 'BUSINESS_EVIDENCE_COMMERCIAL_INTENT', detail: `commercial/transactional intent: ${listQueries(commercial, t)}`, data: { queries: commercial.map((q) => q.query), ...reasonInputsData(input.period, 'gsc', GSC_QUERY, { rows: queryRows(commercial) }) } });

  const uncoveredDemand = input.queries.filter((q) => {
    const p = num(q.position);
    const i = num(q.impressions);
    return p !== undefined && i !== undefined && p > t.rankingPositionMax && i >= t.minImpressionsForOpportunity && q.intent.intent !== 'navigational';
  });

  return { impressions, sessions, dataSufficient, conversionStatus, conversionDetail, clicksChange, conversionsChange, declineReasons, previousComparable, ctrWeakQueries, pageCtrWeak, ctrBenchmarkAvailable, rankingCandidates, businessEvidence, uncoveredDemand };
}

interface RuleOutcome {
  route: Route;
  reasons: ReasonCode[];
}

type RuleFn = (input: PageRouteInput, t: RouterThresholds, d: DerivedSignals, notes: ReasonCode[]) => RuleOutcome | null;

export const RULES: Readonly<Record<RuleId, RuleFn>> = {
  invalid_data: (input, t, d, notes) => {
    const m = input.measurement;
    const reasons: ReasonCode[] = [];
    // Coverage reasons rest on the recorded ingestion coverage (ingestion_batches); property and conversion-definition reasons on configuration only.
    if (m.gsc === 'unresolved') reasons.push({ code: 'GSC_PROPERTY_UNRESOLVED', detail: m.gscDetail });
    else if (m.gsc === 'missing') reasons.push({ code: 'GSC_DATA_MISSING', detail: m.gscDetail, data: reasonInputsData(input.period, 'gsc', BATCHES, { values: { coverage: 'missing' } }) });
    else if (m.gsc === 'incomplete') reasons.push({ code: 'GSC_DATA_INCOMPLETE', detail: m.gscDetail, data: reasonInputsData(input.period, 'gsc', BATCHES, { values: { coverage: 'incomplete' } }) });
    if (m.ga4 === 'unresolved' || (m.ga4 === 'not_configured' && t.requireConversionDefinition)) reasons.push({ code: 'GA4_PROPERTY_UNRESOLVED', detail: m.ga4Detail });
    else if (m.ga4 === 'missing') reasons.push({ code: 'GA4_DATA_MISSING', detail: m.ga4Detail, data: reasonInputsData(input.period, 'ga4', BATCHES, { values: { coverage: 'missing' } }) });
    else if (m.ga4 === 'incomplete') reasons.push({ code: 'GA4_DATA_INCOMPLETE', detail: m.ga4Detail, data: reasonInputsData(input.period, 'ga4', BATCHES, { values: { coverage: 'incomplete' } }) });
    if (m.conversionDefinition === 'missing' && t.requireConversionDefinition) reasons.push({ code: 'MISSING_CONVERSION_DEFINITION', detail: 'conversions.primaryEvents is empty; business outcomes cannot be evaluated' });
    if (m.primaryRateGap) reasons.push({ code: 'PRIMARY_RATE_UNAVAILABLE', detail: m.primaryRateGap, data: reasonInputsData(input.period, 'ga4', GA4_LANDING, { values: { sessions: obs(input.business.sessions), conversionRateStatus: input.business.conversionRate.status } }) });
    // An unestablished rate SCALE is not a measurement gap: conversions are not assessed, every other route still runs.
    if (m.rateScaleUnverified) {
      notes.push({
        code: 'RATE_SCALE_UNVERIFIED',
        detail: `conversions not assessed: ${m.rateScaleUnverified}. Conversion-dependent routing (CONVERSION_OPPORTUNITY, conversion declines, converting sessions as business evidence) waits for the confirmed scale; technical, CTR, ranking, content, indexing, and click-decline routes are unaffected.`,
      });
    }
    for (const j of m.joinIssues) reasons.push({ code: 'JOIN_UNRESOLVED', detail: j });
    const clicks = num(input.search.clicks);
    if (clicks !== undefined && clicks >= (t.minClicksForJoinCheck ?? DEFAULT_THRESHOLD_EXTRAS.minClicksForJoinCheck) && d.sessions === 0 && m.ga4 === 'complete') {
      const st = input.technical.latestCrawlStatus;
      if (input.technical.confirmed.length > 0 || st === 404 || st === 410) {
        // A confirmed access failure (gone page, blocked fetch) explains missing sessions: not a join gap.
        notes.push({ code: 'JOIN_UNRESOLVED', detail: `${clicks} Search Console clicks but 0 google_organic sessions; consistent with the confirmed access failure, so not treated as a measurement gap` });
      } else {
        reasons.push({ code: 'JOIN_UNRESOLVED', detail: `${clicks} Search Console clicks but 0 google_organic sessions matched this page: possible unresolved URL variant or tracking gap`, data: reasonInputsData(input.period, 'gsc', GSC_PAGE, { values: { clicks, googleOrganicSessions: d.sessions ?? null } }) });
      }
    }
    const ns = num(m.notSetShare);
    if (ns !== undefined && ns > t.notSetShareMax) reasons.push({ code: 'GA4_NOT_SET_SHARE_HIGH', detail: `${(ns * 100).toFixed(1)}% of google_organic sessions have landing page "(not set)" (threshold ${(t.notSetShareMax * 100).toFixed(0)}%)`, data: reasonInputsData(input.period, 'ga4', GA4_LANDING, { values: { notSetShare: ns, threshold: t.notSetShareMax } }) });
    return reasons.length ? { route: 'INVALID_OR_INCOMPLETE_DATA', reasons } : null;
  },

  technical_blocker: (input, _t, _d, notes) => {
    for (const s of input.technical.suspected) {
      notes.push({ code: 'SUSPECTED_TECHNICAL_ISSUE', detail: `${s.type} (${s.severity}, ${s.confirmed ? 'observed, but not an access/indexability blocker' : 'not confirmed'}): ${s.detail}` });
    }
    const confirmed = [...input.technical.confirmed];
    // A gone page (404/410 in the latest own-site crawl of this exact URL) is a confirmed access failure.
    const st = input.technical.latestCrawlStatus;
    if ((st === 404 || st === 410) && !confirmed.some((c) => c.source === 'crawl')) {
      confirmed.push({ source: 'crawl', type: `http_${st}`, severity: 'critical', confirmed: true, detail: `the latest own-site crawl of this URL returned HTTP ${st}` });
    }
    if (confirmed.length === 0) return null;
    return {
      route: 'TECHNICAL_BLOCKER',
      reasons: confirmed.map((c) => ({
        code:
          c.source === 'url_inspection'
            ? c.type === 'robots_disallowed'
              ? 'INSPECTION_ROBOTS_DISALLOWED'
              : c.type === 'indexing_blocked'
                ? 'INSPECTION_INDEXING_BLOCKED'
                : 'INSPECTION_FETCH_FAILED'
            : c.source === 'crawl'
              ? 'CRAWL_HTTP_ERROR'
              : 'CONFIRMED_TECHNICAL_ISSUE',
        detail: `${c.type} (${c.severity}): ${c.detail}`,
        // An own-site crawl or URL Inspection observation (its date is in the detail), not a value over the routing window.
        data: reasonInputsData(null, c.source === 'url_inspection' ? 'url_inspection' : 'crawl', c.source === 'url_inspection' ? 'url_inspections' : c.source === 'crawl' ? 'crawl_results' : 'technical_issues', { values: { type: c.type, severity: c.severity, confirmed: c.confirmed } }),
      })),
    };
  },

  experiment_active: (input, _t, _d, notes) => {
    const reasons: ReasonCode[] = [];
    for (const e of input.experiments) {
      const scope = e.scope ?? 'page';
      if (scope === 'site') {
        notes.push({ code: 'EXPERIMENT_SITE_WIDE', detail: `site-wide experiment ${e.id} (${e.type}) is ${e.status}${e.observationEnd ? ` until ${e.observationEnd}` : ''}; page changes that could confound it are not recommended until it is reviewed`, data: { experimentId: e.id } });
        continue;
      }
      if (scope === 'comparison') {
        notes.push({ code: 'EXPERIMENT_CONTROL_PAGE', detail: `this page is a comparison (control) page of experiment ${e.id} (${e.status}); changing it would bias that evaluation`, data: { experimentId: e.id } });
        continue;
      }
      if (e.status === 'observing') {
        reasons.push({ code: 'EXPERIMENT_OBSERVING', detail: `experiment ${e.id} (${e.type}) is observing${e.observationEnd ? ` until ${e.observationEnd}` : ''}`, data: { experimentId: e.id } });
        const due = e.reviewDate ?? e.observationEnd;
        if (due && due <= input.today) reasons.push({ code: 'EXPERIMENT_REVIEW_DUE', detail: `experiment ${e.id} review date ${due} has passed; review it before any new change` });
      } else if (e.status === 'approved' || e.status === 'awaiting_implementation') {
        reasons.push({ code: 'EXPERIMENT_PENDING_IMPLEMENTATION', detail: `experiment ${e.id} is ${e.status}; do not stack another change`, data: { experimentId: e.id } });
      }
    }
    return reasons.length ? { route: 'EXPERIMENT_ACTIVE', reasons } : null;
  },

  healthy: (input, t, d, notes) => {
    if (!d.dataSufficient) return null;
    // "Leave unchanged" needs observed search data: incomplete or missing page totals never read as a healthy 0.
    if (input.search.impressions.status !== 'observed') {
      notes.push({ code: 'SEARCH_METRICS_NOT_OBSERVED', detail: `not concluded HEALTHY: page ${describeMeasuredCount(input.search.impressions, 'impressions')}; "leave unchanged" needs observed Search Console page totals` });
      return null;
    }
    if (d.declineReasons.length) return null;
    if (d.pageCtrWeak === true) return null;
    if (d.conversionStatus === 'poor') return null;
    if (d.rankingCandidates.length && (d.businessEvidence.length || d.rankingCandidates.some((q) => q.intent.ambiguous))) return null;
    // Relevant (non-navigational, non-branded) demand this page ranks beyond the shortlist band for: evaluated as CONTENT_OPPORTUNITY, not "leave unchanged".
    if (d.uncoveredDemand.some((q) => !q.intent.branded)) return null;
    const change = d.clicksChange.status === 'observed' ? d.clicksChange.value : null;
    const pageCtrValues = { clicks: obs(input.search.clicks), impressions: obs(input.search.impressions), ctr: obs(input.search.ctr), expectedCtr: obs(input.search.expectedCtr) };
    const reasons: ReasonCode[] = [
      { code: 'SUFFICIENT_EXPOSURE', detail: `${describeMeasuredCount(input.search.impressions, 'impressions')}, ${describeMeasuredCount(input.business.sessions, 'google_organic sessions')} in the period`, data: reasonInputsData(input.period, 'gsc', GSC_PAGE, { values: { impressions: obs(input.search.impressions), googleOrganicSessions: obs(input.business.sessions) } }) },
      {
        code: 'STABLE',
        detail: d.previousComparable ? 'no meaningful decline versus the previous comparable period' : 'previous period not comparable; no decline evidence',
        // Without a comparable previous period there is no measured input: only the absence of decline evidence.
        ...(d.previousComparable && change ? { data: reasonInputsData(input.period, 'gsc', GSC_PAGE, { values: { previousClicks: change.previous, currentClicks: change.current, pct: valueOf(change.pct) ?? null, previousStart: input.previous?.start ?? null, previousEnd: input.previous?.end ?? null } }) } : {}),
      },
      {
        code: 'CTR_NOT_WEAK',
        detail: d.ctrBenchmarkAvailable ? 'CTR not credibly below comparable positions on this site' : 'no comparable CTR benchmark; no evidence of weak CTR',
        ...(d.ctrBenchmarkAvailable ? { data: input.queries.length ? reasonInputsData(input.period, 'gsc', GSC_QUERY, { rows: queryRows(input.queries, true) }) : reasonInputsData(input.period, 'gsc', GSC_PAGE, { values: pageCtrValues }) } : {}),
      },
      // Only a satisfactory assessment is a finding; insufficient/unmeasured/no-benchmark was not assessed.
      d.conversionStatus === 'satisfactory' ? { code: 'CONVERSIONS_NOT_POOR', detail: d.conversionDetail, data: reasonInputsData(input.period, 'ga4', GA4_LANDING, { values: conversionValues(input) }) } : { code: 'CONVERSIONS_NOT_ASSESSED', detail: `conversion performance not assessed (${d.conversionStatus}): ${d.conversionDetail}` },
      {
        code: 'NO_RANKING_CANDIDATE_WITH_BUSINESS_EVIDENCE',
        detail: d.rankingCandidates.length ? `${d.rankingCandidates.length} query(ies) in positions ${t.rankingPositionMin}-${t.rankingPositionMax} without business evidence` : `no query with >= ${t.minImpressionsForOpportunity} impressions in positions ${t.rankingPositionMin}-${t.rankingPositionMax}`,
        ...(input.queries.length ? { data: reasonInputsData(input.period, 'gsc', GSC_QUERY, { rows: queryRows(d.rankingCandidates.length ? d.rankingCandidates : input.queries) }) } : {}),
      },
    ];
    if (!d.ctrBenchmarkAvailable) notes.push({ code: 'CTR_BENCHMARK_UNAVAILABLE', detail: 'not enough comparable impressions on this site to benchmark CTR' });
    return { route: 'HEALTHY', reasons };
  },

  ranking: (input, t, d) => {
    if (d.rankingCandidates.length === 0) return null;
    if (d.businessEvidence.length) {
      return {
        route: 'RANKING_OPPORTUNITY',
        reasons: [
          { code: 'QUERY_POSITION_IN_RANGE', detail: `positions ${t.rankingPositionMin}-${t.rankingPositionMax} (shortlist heuristic): ${listQueries(d.rankingCandidates, t)}`, data: { queries: d.rankingCandidates.map((q) => q.query), ...reasonInputsData(input.period, 'gsc', GSC_QUERY, { rows: queryRows(d.rankingCandidates) }) } },
          ...d.businessEvidence,
        ],
      };
    }
    const ambiguous = d.rankingCandidates.filter((q) => q.intent.ambiguous);
    if (ambiguous.length) {
      const mixed = ambiguous.filter((q) => q.intent.intent === 'mixed');
      return {
        route: 'UNSURE',
        reasons: [
          { code: mixed.length ? 'MIXED_INTENT' : 'AMBIGUOUS_INTENT', detail: `ranking candidates without business evidence have ${mixed.length ? 'mixed' : 'unclear'} intent: ${listQueries(ambiguous, t)}`, data: { queries: ambiguous.map((q) => q.query), ...reasonInputsData(input.period, 'gsc', GSC_QUERY, { rows: queryRows(ambiguous) }) } },
          { code: 'QUERY_POSITION_IN_RANGE', detail: listQueries(d.rankingCandidates, t), data: { queries: d.rankingCandidates.map((q) => q.query), ...reasonInputsData(input.period, 'gsc', GSC_QUERY, { rows: queryRows(d.rankingCandidates) }) } },
        ],
      };
    }
    return null;
  },

  ctr: (input, t, d, notes) => {
    if (d.ctrWeakQueries.length) {
      return {
        route: 'CTR_OPPORTUNITY',
        reasons: d.ctrWeakQueries.slice(0, t.maxQueriesInReasons).map((q) => ({
          code: 'CTR_BELOW_COMPARABLE' as const,
          detail: `"${q.query}": CTR ${((num(q.ctr) ?? 0) * 100).toFixed(2)}% at position ${num(q.position)?.toFixed(1)} vs ${((num(q.expectedCtr) ?? 0) * 100).toFixed(2)}% for comparable positions on this site (${q.intent.branded ? 'branded' : 'non-branded'} benchmark)`,
          data: { query: q.query, ...reasonInputsData(input.period, 'gsc', GSC_QUERY, { rows: queryRows([q], true) }) },
        })),
      };
    }
    if (d.pageCtrWeak === true && input.queries.length === 0) {
      return {
        route: 'CTR_OPPORTUNITY',
        reasons: [
          {
            code: 'CTR_BELOW_COMPARABLE',
            detail: `page CTR ${((num(input.search.ctr) ?? 0) * 100).toFixed(2)}% vs ${((num(input.search.expectedCtr) ?? 0) * 100).toFixed(2)}% for pages at comparable positions (no query rows available)`,
            data: reasonInputsData(input.period, 'gsc', GSC_PAGE, { values: { clicks: obs(input.search.clicks), impressions: obs(input.search.impressions), ctr: obs(input.search.ctr), expectedCtr: obs(input.search.expectedCtr) } }),
          },
        ],
      };
    }
    if (!d.ctrBenchmarkAvailable && (d.impressions ?? 0) >= t.minImpressionsForOpportunity && !notes.some((n) => n.code === 'CTR_BENCHMARK_UNAVAILABLE')) {
      notes.push({ code: 'CTR_BENCHMARK_UNAVAILABLE', detail: 'not enough comparable impressions on this site to benchmark CTR' });
    }
    return null;
  },

  conversion: (input, _t, d, notes) => {
    if (d.conversionStatus === 'poor') return { route: 'CONVERSION_OPPORTUNITY', reasons: [{ code: 'CONVERSION_RATE_BELOW_BENCHMARK', detail: d.conversionDetail, data: reasonInputsData(input.period, 'ga4', GA4_LANDING, { values: conversionValues(input) }) }] };
    if (d.conversionStatus === 'no_benchmark') notes.push({ code: 'CONVERSION_BENCHMARK_UNAVAILABLE', detail: d.conversionDetail });
    return null;
  },

  decline: (_input, _t, d, notes) => {
    if (d.declineReasons.length) return { route: 'DECLINE', reasons: d.declineReasons };
    if (!d.previousComparable && d.clicksChange.status !== 'observed') notes.push({ code: 'PREVIOUS_PERIOD_NOT_COMPARABLE', detail: d.clicksChange.reason });
    return null;
  },

  content: (input, t, d) => {
    if (d.uncoveredDemand.length === 0) return null;
    return {
      route: 'CONTENT_OPPORTUNITY',
      reasons: [
        {
          code: 'UNCOVERED_DEMAND_QUERIES',
          detail: `relevant demand where this page ranks beyond position ${t.rankingPositionMax}: ${listQueries(d.uncoveredDemand, t)} (check overlap before proposing a page)`,
          data: { queries: d.uncoveredDemand.map((q) => q.query), ...reasonInputsData(input.period, 'gsc', GSC_QUERY, { rows: queryRows(d.uncoveredDemand) }) },
        },
      ],
    };
  },

  indexing_unknown: (input, _t, d) => {
    if (d.impressions !== 0) return null;
    const insp = input.technical.inspection;
    if (insp && insp.verdict === 'PASS') return null;
    const never: ReasonCode = { code: 'NEVER_AUTO_DELETE_OR_REDIRECT', detail: 'zero impressions do not prove the page is not indexed; never delete or redirect automatically' };
    // d.impressions === 0 here: an observed zero (covered days, no rows), never a missing value.
    if (!insp) return { route: 'INDEXING_UNKNOWN', reasons: [{ code: 'NO_IMPRESSIONS_NOT_INSPECTED', detail: 'no Search Console impressions in the period and no URL Inspection record', data: reasonInputsData(input.period, 'gsc', GSC_PAGE, { values: { impressions: 0, urlInspection: 'none recorded' } }) }, never] };
    return {
      route: 'INDEXING_UNKNOWN',
      reasons: [
        {
          code: 'INSPECTION_NOT_INDEXED',
          detail: `URL Inspection (indexed-state, not a live test) verdict ${insp.verdict ?? 'unknown'}: ${insp.coverageState ?? 'no coverage state'} (${insp.inspectedAt})`,
          data: reasonInputsData(null, 'url_inspection', 'url_inspections', { values: { verdict: insp.verdict, coverageState: insp.coverageState, indexingState: insp.indexingState, inspectedAt: insp.inspectedAt, searchConsoleImpressions: 0 } }),
        },
        never,
      ],
    };
  },

  low_data: (input, t, d) => {
    if (input.site.lowData) {
      const total = obs(input.site.totalImpressions);
      return {
        route: 'LOW_DATA',
        reasons: [
          {
            code: 'SITE_LOW_DATA',
            detail: `site has ${num(input.site.totalImpressions) ?? 'unknown'} impressions over ${input.site.windowDays} days (< ${t.lowDataSiteMaxImpressions}); bootstrap workflow`,
            ...(total !== null ? { data: reasonInputsData(input.period, 'gsc', GSC_PROPERTY, { values: { totalImpressions: total, windowDays: input.site.windowDays, lowDataSiteMaxImpressions: t.lowDataSiteMaxImpressions } }) } : {}),
          },
        ],
      };
    }
    if (!d.dataSufficient) {
      const impressions = obs(input.search.impressions);
      const sessions = obs(input.business.sessions);
      // Inputs only when something was observed: "impressions missing and sessions missing" rests on no measurement.
      const data = impressions !== null || sessions !== null ? reasonInputsData(input.period, impressions !== null ? 'gsc' : 'ga4', impressions !== null ? GSC_PAGE : GA4_LANDING, { values: { impressions, sessions, minImpressions: t.minImpressionsForOpportunity, minSessions: t.minSessionsForConversion } }) : null;
      return {
        route: 'LOW_DATA',
        reasons: [{ code: 'PAGE_BELOW_EVIDENCE_THRESHOLD', detail: `page has ${describeMeasuredCount(input.search.impressions, 'impressions')} (< ${t.minImpressionsForOpportunity} needed) and ${describeMeasuredCount(input.business.sessions, 'sessions')} (< ${t.minSessionsForConversion} needed); collect more evidence`, ...(data ? { data } : {}) }],
      };
    }
    return null;
  },

  irrelevant: (input) => (input.isExcluded ? { route: 'IRRELEVANT', reasons: [{ code: 'EXCLUDED_PATH', detail: 'path matches crawl.excludedPaths (owner-configured as outside scope)' }] } : null),
};

/**
 * Evaluate the ordered rules for one page. Owner-excluded pages skip every
 * rule except `irrelevant` (explicit configuration beats inferred signals).
 */
export function evaluateRoute(input: PageRouteInput, t: RouterThresholds, opts: { order?: readonly RuleId[] } = {}): RouteDecision {
  const order = opts.order ?? DEFAULT_RULE_ORDER;
  const d = deriveSignals(input, t);
  const trace: RuleTrace[] = [];
  const notes: ReasonCode[] = [];
  let chosen: RuleOutcome | null = null;
  for (const id of order) {
    if (chosen) {
      trace.push({ rule: id, matched: false, reasons: [] });
      continue;
    }
    if (input.isExcluded && id !== 'irrelevant') {
      trace.push({ rule: id, matched: false, reasons: [{ code: 'EXCLUDED_PATH', detail: 'skipped: page is owner-excluded' }] });
      continue;
    }
    const out = RULES[id](input, t, d, notes);
    trace.push(out ? { rule: id, matched: true, route: out.route, reasons: out.reasons } : { rule: id, matched: false, reasons: [] });
    if (out) chosen = out;
  }
  if (!chosen) {
    // Explain why nothing matched when search data was not observed (never "healthy" on unknown impressions): moved from the notes to the reasons.
    const unobserved = notes.filter((n) => n.code === 'SEARCH_METRICS_NOT_OBSERVED');
    for (const n of unobserved) notes.splice(notes.indexOf(n), 1);
    chosen = { route: 'UNSURE', reasons: [{ code: 'NO_RULE_MATCHED', detail: 'no rule matched; needs human review' }, ...unobserved] };
  }
  const modelIntents = input.queries.filter((q) => q.intent.decidedBy === 'model');
  const usedModel = modelIntents.length > 0 && ['RANKING_OPPORTUNITY', 'UNSURE', 'CONTENT_OPPORTUNITY', 'HEALTHY'].includes(chosen.route);
  if (modelIntents.length) notes.push({ code: 'INTENT_DECIDED_BY_MODEL', detail: `${modelIntents.length} ambiguous query intent(s) classified by the low-cost model: ${modelIntents.slice(0, 5).map((q) => `"${q.query}"=${q.intent.intent}`).join(', ')}` });
  return {
    subjectType: 'page',
    siteId: input.siteId,
    pageId: input.pageId,
    query: null,
    route: chosen.route,
    reasons: chosen.reasons,
    notes,
    trace,
    decidedBy: usedModel ? 'model' : 'rule',
    rulesVersion: rulesVersionFor(t, order),
    period: input.period,
    nextStep: ROUTE_NEXT_STEP[chosen.route],
    inputsSummary: summarizeInput(input, d),
  };
}

function m(v: Measured<number> | null | undefined): unknown {
  if (!v) return null;
  return v.status === 'observed' ? v.value : { status: v.status, reason: v.reason };
}

export function summarizeInput(input: PageRouteInput, d: DerivedSignals): Record<string, unknown> {
  return {
    url: input.url,
    period: input.period,
    previous: input.previous,
    measurement: { gsc: input.measurement.gsc, ga4: input.measurement.ga4, conversionDefinition: input.measurement.conversionDefinition, primaryRateGap: input.measurement.primaryRateGap, rateScaleUnverified: input.measurement.rateScaleUnverified ?? null },
    search: { clicks: m(input.search.clicks), impressions: m(input.search.impressions), ctr: m(input.search.ctr), position: m(input.search.position) },
    business: { sessions: m(input.business.sessions), convertingSessions: m(input.business.convertingSessions), conversionRate: m(input.business.conversionRate), benchmarkConversionRate: m(input.business.benchmarkConversionRate) },
    derived: {
      dataSufficient: d.dataSufficient,
      conversionStatus: d.conversionStatus,
      rankingCandidates: d.rankingCandidates.map((q) => q.query),
      ctrWeakQueries: d.ctrWeakQueries.map((q) => q.query),
      uncoveredDemand: d.uncoveredDemand.map((q) => q.query),
      declines: d.declineReasons.map((r) => r.code),
    },
    technical: { confirmed: input.technical.confirmed.length, suspected: input.technical.suspected.length, latestCrawlStatus: input.technical.latestCrawlStatus },
    experiments: input.experiments.map((e) => ({ id: e.id, status: e.status, scope: e.scope ?? 'page' })),
    synthetic: input.synthetic === true,
    site: { lowData: input.site.lowData, totalImpressions: m(input.site.totalImpressions) },
    queries: input.queries.slice(0, 20).map((q) => ({ query: q.query, intent: q.intent.intent, branded: q.intent.branded, decidedBy: q.intent.decidedBy, position: m(q.position), impressions: m(q.impressions) })),
  };
}
