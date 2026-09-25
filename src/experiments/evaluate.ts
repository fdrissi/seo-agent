import type { AppContext } from '../app/context.js';
import { budgetTimeZone } from '../app/context.js';
import { AppError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { addDays, dateInZone } from '../core/time.js';
import { recordAudit } from '../database/audit.js';
import { normalizeUrl } from '../seo/url.js';
import { describeRowLoss, type Ga4RowLoss } from '../seo/coverage.js';
import type { ApprovalGate } from '../approvals/types.js';
import { assertAllowed } from '../approvals/policy.js';
import { annotationsBetween, type AnnotationRecord } from './annotations.js';
import { proposeLearning } from './learnings.js';
import { EVALUATION_METHOD, EVALUATION_METHOD_VERSION, SIGNIFICANCE } from './method.js';
import {
  ga4EstimateDates,
  ga4TimeZone,
  ga4UncertainDates,
  ga4WindowMetrics,
  gscTimeZone,
  gscWindowMetrics,
  latestCompleteGa4Date,
  latestCompleteGscDate,
  pageIdentity,
  type Ga4Metrics,
  type GscMetrics,
  type PageIdentity,
} from './metrics.js';
import { measurementConfigOf, resolveMeasuredGscProperty } from './propose.js';
import { getExperiment, getExperimentChange, getPage, listExperiments } from './repository.js';
import { transitionExperiment } from './status.js';
import { TERMINAL_STATUSES, higherIsBetter, isConversionMetric, isSeoMetric, type ComparisonPage, type ExperimentRecord, type MeasurementConfig, type MetricName } from './types.js';
import { computeWindows, type MeasurementWindows, type WindowResult } from './windows.js';

/**
 * Observational experiment evaluation.
 *
 * Method (EVALUATION_METHOD, version-frozen per experiment):
 * 1. Windows: weekday-matched, equal-length whole weeks before/after the
 *    implementation date, per data source and in that source's reporting
 *    zone, ending at the latest complete date (see windows.ts).
 * 2. Metrics: current-revision GSC page rows and GA4 landing rows for the
 *    treated page and for unchanged comparison pages, same segment and
 *    search type / channel view in both windows (segment matching). GA4
 *    windows with possibly-missing rows (row limit, GA4 row loss) or with
 *    estimated values (sampled or "(other)"-bucketed reports) give no
 *    comparable value: conversion comparisons and GA4 guardrails are not
 *    judged, and the reasons carry a "GA4 data caveat".
 * 3. Effect: direction-adjusted relative change of the treated page minus
 *    the pooled relative change of the comparison pages (difference-in-
 *    differences style). Without comparison pages it is a plain before/after.
 * 4. Sufficiency: minimum complete-data observation days, minimum
 *    impressions / sessions / converting sessions per window. Missing,
 *    incomplete, or too-small samples are "collecting" (still observing) or,
 *    once the maximum observation period has passed, "inconclusive". They are
 *    never read as failure: zero extra conversions in a small sample is
 *    insufficient data, not a negative result.
 * 5. SEO visibility and conversion outcomes are assessed separately. A
 *    visibility gain with a breached conversion guardrail, or a mixed
 *    visibility/conversion result, is not a win (inconclusive, needs review).
 * 6. Interference: annotations, other experiments, and recorded
 *    implementations of drafts/recommendations (publications) overlapping
 *    the windows are listed. A change on the treated page is blocking;
 *    comparison pages that changed are excluded from the comparison group;
 *    blocking kinds downgrade a positive/negative result to inconclusive.
 * 7. No significance test is implemented (see SIGNIFICANCE).
 * 8. Every evaluation is appended to experiment_evaluations. A concluded
 *    experiment's status never changes; later evaluations are informational.
 *    experiment_measurements keeps the first-recorded values per window
 *    (append-only); when revised source data changes them, the evaluation
 *    says so explicitly (the evaluation row holds the current values).
 */

export type EvaluationResult = 'collecting' | 'positive' | 'negative' | 'inconclusive' | 'data_unavailable';
export type Verdict = 'positive' | 'negative' | 'no_meaningful_change' | 'insufficient_data' | 'data_unavailable';

export interface Side {
  baseline: number | null;
  observation: number | null;
  /** Direction-adjusted relative change (positive = better). */
  improvement: number | null;
}

export interface MetricComparison {
  metric: MetricName;
  label: 'OBSERVED' | 'DATA_UNAVAILABLE';
  treated: Side;
  control: (Side & { pages: number }) | null;
  /** treated.improvement - control.improvement (or treated.improvement when no control). */
  effect: number | null;
  threshold: number;
  verdict: Verdict;
  reasons: string[];
}

export interface OutcomeAssessment {
  kind: 'seo_visibility' | 'conversion';
  primary: MetricComparison;
  supporting: MetricComparison[];
  sample: Record<string, unknown>;
}

export interface GuardrailResult {
  metric: MetricName;
  maxRelativeDecline: number;
  status: 'ok' | 'breached' | 'unavailable';
  comparison: MetricComparison;
}

export interface InterferenceItem {
  source: 'annotation' | 'experiment' | 'publication';
  id: string;
  kind: string;
  scope: string;
  at: string;
  description: string;
  blocking: boolean;
  effect: string;
}

export interface EvaluationOutcome {
  experimentId: string;
  evaluationId: string | null;
  sequence: number | null;
  evaluatedAt: string;
  result: EvaluationResult;
  concluded: boolean;
  afterConclusion: boolean;
  statusBefore: string;
  statusAfter: string;
  reasons: string[];
  windows: {
    gsc: WindowResult | null;
    ga4: WindowResult | null;
    elapsedDays: number;
    completeDays: number;
    /** Length of the weekday-matched observation window actually evaluated (whole weeks; 0 = no window yet). */
    measuredDays?: number;
    minObservationDays: number;
    maxObservationDays: number;
  };
  seo: OutcomeAssessment | null;
  conversion: OutcomeAssessment | null;
  guardrails: GuardrailResult[];
  interference: { items: InterferenceItem[]; blocking: boolean; excludedComparisonPages: string[] };
  significance: typeof SIGNIFICANCE;
  methodVersion: string;
  frozenMethodVersion: string | null;
  isSynthetic: boolean;
  dryRun: boolean;
  learning: { learningId: string; approvalId: string } | null;
  /** Windows whose recomputed values differ from the first-recorded experiment_measurements row (source data revised). */
  measurementRevisions: string[];
  /** Scope caveat: the recommendation's success criteria were query-level, the evaluation measured page-level totals (null = none). */
  scopeCaveat?: string | null;
  /** Measurement-relevant configuration that changed since the experiment was proposed (empty = none; null = not checkable). */
  configDrift?: ConfigDrift[] | null;
}

export interface ConfigDrift {
  field: keyof MeasurementConfig;
  frozen: unknown;
  current: unknown;
  affects: 'seo' | 'conversion' | 'informational';
}

const QUERY_LEVEL_CRITERIA = /\b(quer(y|ies)|keywords?|search terms?)\b/i;

/** Compare the measurement configuration frozen at proposal with the current one. */
export function measurementConfigDrift(frozen: MeasurementConfig, current: MeasurementConfig): ConfigDrift[] {
  const out: ConfigDrift[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const affects: Record<keyof MeasurementConfig, ConfigDrift['affects']> = {
    gscProperty: 'seo',
    searchType: 'seo',
    ga4Property: 'conversion',
    primaryEvents: 'conversion',
    channelView: 'conversion',
    segmentKey: 'seo',
    brandAliases: 'informational',
  };
  for (const k of Object.keys(affects) as Array<keyof MeasurementConfig>) {
    if (!same(frozen[k] ?? null, current[k] ?? null)) out.push({ field: k, frozen: frozen[k] ?? null, current: current[k] ?? null, affects: affects[k] });
  }
  return out;
}

// ------------------------------------------------------------------ helpers

function improvement(metric: MetricName, b: number | null, o: number | null): number | null {
  if (b === null || o === null) return null;
  if (b === 0) return null;
  return higherIsBetter(metric) ? (o - b) / b : (b - o) / b;
}

function gscValue(m: GscMetrics | null, metric: MetricName): number | null {
  if (!m || m.status === 'unavailable') return null;
  switch (metric) {
    case 'clicks':
      return m.clicks;
    case 'impressions':
      return m.impressions;
    case 'ctr':
      return m.ctr;
    case 'position':
      return m.position;
    default:
      return null;
  }
}

function ga4Value(m: Ga4Metrics | null, metric: MetricName): number | null {
  if (!m || m.status === 'unavailable') return null;
  // Covered days on which the page(s) have no landing row although rows may be missing (row limit,
  // GA4 "(other)" bucketing / thresholding / sampling): the window's sums and rates would count
  // those unknown rows as zero, so no value of this window is comparable. Likewise days whose
  // values are estimates (sampled or "(other)"-bucketed reports, even with a row): never exact numbers.
  if (ga4UncertainDates(m).length || ga4EstimateDates(m).length) return null;
  switch (metric) {
    case 'sessions':
      return m.sessions;
    case 'primarySessionRate':
      return m.primaryRateStatus === 'observed' ? m.primarySessionRate : null;
    case 'primaryKeyEvents':
      return m.primaryKeyEvents;
    case 'engagedSessionRate':
      return m.engagedSessionRate;
    case 'revenue':
      return m.revenueStatus === 'observed' ? m.revenueMicros : null;
    default:
      return null;
  }
}

interface WindowMetrics {
  treatedBase: GscMetrics | Ga4Metrics | null;
  treatedObs: GscMetrics | Ga4Metrics | null;
  controlBase: GscMetrics | Ga4Metrics | null;
  controlObs: GscMetrics | Ga4Metrics | null;
  controlPages: number;
}

interface Ga4DataCaveats {
  /** Windows with collected days on which the page(s) have no landing row although rows may be missing (null = none). */
  missing: string | null;
  /** Windows with collected days whose landing values are estimates (sampling, "(other)" bucketing) (null = none). */
  estimate: string | null;
}

/**
 * GA4 windows (treated or comparison) that give no exact value:
 * - `missing`: collected days on which the page(s) have no landing row
 *   although rows may be missing: a row-limit truncation, or GA4 "(other)"
 *   bucketing / thresholding / sampling (the batch's response metadata).
 *   Those rows are unknown, not zero.
 * - `estimate`: collected days whose landing values are estimates or partial
 *   totals although the page(s) may have rows: the report(s) were sampled or
 *   bucketed rows into "(other)" (metrics.ga4WindowMetrics estimateDates).
 * Either way every conversion comparison and GA4 guardrail of the
 * evaluation is incomplete and never judged.
 */
function ga4DataCaveats(wm: WindowMetrics | null): Ga4DataCaveats {
  if (!wm) return { missing: null, estimate: null };
  const missingParts: string[] = [];
  const estimateParts: string[] = [];
  const reasons = new Set<Ga4RowLoss>();
  const estimateReasons = new Set<Ga4RowLoss>();
  let truncated = false;
  const windows = [
    ['treated baseline', wm.treatedBase],
    ['treated observation', wm.treatedObs],
    ['comparison baseline', wm.controlBase],
    ['comparison observation', wm.controlObs],
  ] as const;
  for (const [label, m] of windows) {
    const g = m as Ga4Metrics | null;
    if (!g) continue;
    const trunc = g.truncatedDates?.length ?? 0;
    const loss = g.rowLossDates?.length ?? 0;
    const est = ga4EstimateDates(g).length;
    if (trunc || loss) {
      if (trunc) truncated = true;
      for (const r of g.rowLossReasons ?? []) reasons.add(r);
      missingParts.push(`${label}: ${[trunc ? `${trunc} row-limit-truncated` : '', loss ? `${loss} row-loss` : ''].filter(Boolean).join(' and ')} day(s)`);
    }
    if (est) {
      for (const r of g.estimateReasons ?? []) estimateReasons.add(r);
      estimateParts.push(`${label}: ${est} estimate day(s)`);
    }
  }
  const why = [...(reasons.size ? [`GA4 reported ${describeRowLoss([...reasons])}`] : []), ...(truncated ? ['a landing-page sync hit its row limit'] : [])].join('; ');
  const estimateWhy = [
    ...(estimateReasons.has('sampling') ? ['sampled values are estimates'] : []),
    ...(estimateReasons.has('other_row') ? ['landing-page variants of a page may be counted in the "(other)" row, so its totals may be partial'] : []),
  ].join('; ');
  return {
    missing: missingParts.length
      ? `GA4 landing rows may be missing on collected days where the page(s) have no row (${why}): ${missingParts.join(', ')}. Those rows are unknown, not zero, so the conversion comparisons and GA4 guardrails are incomplete and not judged`
      : null,
    estimate: estimateParts.length
      ? `GA4 landing values are estimates on collected days where GA4 reported ${describeRowLoss([...estimateReasons].sort())} (${estimateWhy || 'values not exact'}), whether or not the page(s) have a row: ${estimateParts.join(', ')}. Those values are not exact, so the conversion comparisons and GA4 guardrails are not judged as observed`
      : null,
  };
}

function valueOf(m: GscMetrics | Ga4Metrics | null, metric: MetricName): number | null {
  if (!m) return null;
  return isSeoMetric(metric) ? gscValue(m as GscMetrics, metric) : ga4Value(m as Ga4Metrics, metric);
}

function compare(metric: MetricName, wm: WindowMetrics, threshold: number, sufficient: { ok: boolean; reasons: string[] }): MetricComparison {
  const tb = valueOf(wm.treatedBase, metric);
  const to = valueOf(wm.treatedObs, metric);
  const treated: Side = { baseline: tb, observation: to, improvement: improvement(metric, tb, to) };
  let control: MetricComparison['control'] = null;
  if (wm.controlPages > 0) {
    const cb = valueOf(wm.controlBase, metric);
    const co = valueOf(wm.controlObs, metric);
    control = { baseline: cb, observation: co, improvement: improvement(metric, cb, co), pages: wm.controlPages };
  }
  const reasons = [...sufficient.reasons];
  let effect: number | null = null;
  if (treated.improvement !== null) {
    if (control && control.improvement !== null) effect = treated.improvement - control.improvement;
    else {
      effect = treated.improvement;
      reasons.push(control ? 'comparison pages have no usable baseline for this metric: plain before/after' : 'no comparison pages: plain before/after comparison');
    }
  }
  let verdict: Verdict;
  if (tb === null || to === null) {
    verdict = sufficient.ok ? 'data_unavailable' : 'insufficient_data';
    if (tb === null) reasons.push('treated baseline value unavailable');
    if (to === null) reasons.push('treated observation value unavailable');
  } else if (!sufficient.ok) verdict = 'insufficient_data';
  else if (effect === null) {
    verdict = 'insufficient_data';
    reasons.push('relative change undefined (zero baseline)');
  } else if (effect >= threshold) verdict = 'positive';
  else if (effect <= -threshold) verdict = 'negative';
  else {
    verdict = 'no_meaningful_change';
    reasons.push(`effect ${(effect * 100).toFixed(1)}% is within the +/-${(threshold * 100).toFixed(0)}% meaningful-change threshold`);
  }
  return { metric, label: tb === null || to === null ? 'DATA_UNAVAILABLE' : 'OBSERVED', treated, control, effect, threshold, verdict, reasons };
}

function dateOfInstant(iso: string, tz: string): string {
  return dateInZone(new Date(iso), tz);
}

// ------------------------------------------------------------------- main

export interface EvaluateOptions {
  /** Conclude now if the minimum period is reached, even with insufficient data (-> inconclusive). */
  conclude?: boolean;
  dryRun?: boolean;
  actor?: string;
  gate?: ApprovalGate;
}

export function evaluateExperiment(ctx: AppContext, experimentId: string, opts: EvaluateOptions = {}): EvaluationOutcome {
  if (!opts.dryRun) assertAllowed(ctx.mode, 'record_evaluation');
  const exp = getExperiment(ctx.db, ctx.siteId, experimentId);
  const terminal = TERMINAL_STATUSES.includes(exp.status);
  if (exp.status !== 'observing' && !terminal) {
    throw new AppError('CONFLICT', `Experiment ${exp.id} is ${exp.status}; evaluation starts only after a recorded implementation (mark-implemented).`);
  }
  if (!exp.implementedAt) throw new AppError('DATA_UNAVAILABLE', `Experiment ${exp.id} has no recorded implementation time.`);
  const now = ctx.clock.now();
  const cfg = ctx.config;
  const sample = exp.sampleRequirements;
  const reasons: string[] = [];
  // ONE Search Console property for treated and comparison pages: configured, else the one
  // recorded at proposal, else the only one with page data; several are never summed.
  const gscProperty = resolveMeasuredGscProperty(ctx, sample.measuredScope?.gscProperty ?? null);
  const property = gscProperty.property;
  const gscAmbiguity = gscProperty.property === null && gscProperty.ambiguous ? gscProperty.reason : null;
  const ga4Property = cfg.google.ga4PropertyId;

  const change = getExperimentChange(ctx.db, ctx.siteId, exp.id);
  const treatedPage = exp.pageId ? getPage(ctx.db, ctx.siteId, exp.pageId) : null;
  const treatedUrl = treatedPage?.url ?? change?.targetUrl;
  if (!treatedUrl) throw new AppError('DATA_UNAVAILABLE', `Experiment ${exp.id} has no page or target URL to measure.`);
  const treatedId = pageIdentity(ctx.db, ctx.siteId, [{ id: exp.pageId, url: treatedUrl }]);

  const needSeo = exp.outcomeKind !== 'conversion' || exp.guardrails.some((g) => isSeoMetric(g.metric));
  const needConv = exp.outcomeKind !== 'seo_visibility' || exp.guardrails.some((g) => isConversionMetric(g.metric));

  // Windows per source.
  const gscTz = gscAmbiguity ? null : gscTimeZone(ctx.db, ctx.siteId, property);
  const gscWin: WindowResult | null = gscTz
    ? computeWindows({
        implementedAt: exp.implementedAt,
        timeZone: gscTz,
        latestCompleteDate: latestCompleteGscDate(ctx.db, ctx.siteId, property, sample.searchType, sample.segmentKey),
        maxDays: sample.maxObservationDays,
        minDays: exp.minObservationDays,
      })
    : null;
  const ga4Tz = ga4TimeZone(ctx.db, ctx.siteId, ga4Property);
  const ga4Win: WindowResult | null = ga4Tz
    ? computeWindows({
        implementedAt: exp.implementedAt,
        timeZone: ga4Tz,
        latestCompleteDate: latestCompleteGa4Date(ctx.db, ctx.siteId, ga4Property, sample.channelView, sample.segmentKey),
        maxDays: sample.maxObservationDays,
        minDays: exp.minObservationDays,
      })
    : null;

  const businessTz = budgetTimeZone(cfg);
  const elapsedDays = Math.max(0, Math.floor((now.getTime() - new Date(exp.implementedAt).getTime()) / 86_400_000));
  const availableOf = (w: WindowResult | null) => (w ? (w.ok ? w.windows.availableObservationDays : w.availableObservationDays) : 0);
  const completeDays =
    exp.outcomeKind === 'seo_visibility' ? availableOf(gscWin) : exp.outcomeKind === 'conversion' ? availableOf(ga4Win) : Math.min(availableOf(gscWin), availableOf(ga4Win));
  // The minimum is reached only when the evaluated (whole-week) window itself is at least that long.
  const windowDaysOf = (w: WindowResult | null) =>
    !w ? 0 : w.ok ? w.windows.observation.days : w.reason === 'less_than_min' ? Math.floor(Math.min(w.availableObservationDays, sample.maxObservationDays) / 7) * 7 : 0;
  const measuredDays =
    exp.outcomeKind === 'seo_visibility' ? windowDaysOf(gscWin) : exp.outcomeKind === 'conversion' ? windowDaysOf(ga4Win) : Math.min(windowDaysOf(gscWin), windowDaysOf(ga4Win));

  // Interference and comparison-page hygiene (uses the widest window span available).
  const spans = [gscWin, ga4Win].filter((w): w is { ok: true; windows: MeasurementWindows } => !!w && w.ok).map((w) => w.windows);
  const interference = collectInterference(ctx, exp, spans, gscTz ?? ga4Tz ?? businessTz, treatedUrl);
  const comparison: ComparisonPage[] = exp.comparisonPages.filter((c) => !interference.excludedComparisonPages.includes(c.pageId));
  const controlId: PageIdentity | null = comparison.length ? pageIdentity(ctx.db, ctx.siteId, comparison.map((c) => ({ id: c.pageId, url: c.url }))) : null;

  // Metrics.
  let gscWM: WindowMetrics | null = null;
  if (needSeo && gscWin?.ok) {
    const w = gscWin.windows;
    const q = { siteId: ctx.siteId, property, searchType: sample.searchType, segmentKey: sample.segmentKey };
    gscWM = {
      treatedBase: gscWindowMetrics(ctx.db, treatedId, { ...q, start: w.baseline.start, end: w.baseline.end }),
      treatedObs: gscWindowMetrics(ctx.db, treatedId, { ...q, start: w.observation.start, end: w.observation.end }),
      controlBase: controlId ? gscWindowMetrics(ctx.db, controlId, { ...q, start: w.baseline.start, end: w.baseline.end }) : null,
      controlObs: controlId ? gscWindowMetrics(ctx.db, controlId, { ...q, start: w.observation.start, end: w.observation.end }) : null,
      controlPages: comparison.length,
    };
  }
  let ga4WM: WindowMetrics | null = null;
  if (needConv && ga4Win?.ok) {
    const w = ga4Win.windows;
    const q = { siteId: ctx.siteId, propertyId: ga4Property, channelView: sample.channelView, segmentKey: sample.segmentKey };
    ga4WM = {
      treatedBase: ga4WindowMetrics(ctx.db, treatedId, { ...q, start: w.baseline.start, end: w.baseline.end }),
      treatedObs: ga4WindowMetrics(ctx.db, treatedId, { ...q, start: w.observation.start, end: w.observation.end }),
      controlBase: controlId ? ga4WindowMetrics(ctx.db, controlId, { ...q, start: w.baseline.start, end: w.baseline.end }) : null,
      controlObs: controlId ? ga4WindowMetrics(ctx.db, controlId, { ...q, start: w.observation.start, end: w.observation.end }) : null,
      controlPages: comparison.length,
    };
  }

  const threshold = sample.minRelativeEffect;
  const noWM: WindowMetrics = { treatedBase: null, treatedObs: null, controlBase: null, controlObs: null, controlPages: 0 };
  // Absent GA4 landing rows that may have been left out (row limit, "(other)", thresholding, sampling) are unknown, not zero;
  // values from sampled or "(other)"-bucketed reports are estimates, not exact.
  const ga4Caveats = ga4DataCaveats(ga4WM);
  const ga4CaveatNotes = [ga4Caveats.missing, ga4Caveats.estimate].filter((n): n is string => !!n);

  // SEO visibility assessment.
  const seoSufficiency = (() => {
    const r: string[] = [];
    if (!gscTz) r.push(gscAmbiguity ?? 'no Search Console data for this site/property');
    else if (!gscWin?.ok) r.push(gscWin ? `no weekday-matched GSC window yet (${gscWin.reason}, ${gscWin.availableObservationDays} complete day(s) after implementation)` : 'no GSC window');
    const b = gscWM?.treatedBase as GscMetrics | null | undefined;
    const o = gscWM?.treatedObs as GscMetrics | null | undefined;
    for (const [label, m] of [['baseline', b], ['observation', o]] as const) {
      if (!m) continue;
      if (m.status !== 'observed') r.push(`GSC ${label} window ${m.status}${m.reason ? ` (${m.reason})` : ''}`);
      if ((m.impressions ?? 0) < sample.minImpressionsPerWindow) r.push(`GSC ${label} impressions ${m.impressions ?? 'n/a'} < required ${sample.minImpressionsPerWindow}`);
    }
    return { ok: r.length === 0 && !!gscWM, reasons: r };
  })();
  const seo: OutcomeAssessment | null =
    exp.outcomeKind === 'conversion'
      ? null
      : {
          kind: 'seo_visibility',
          primary: compare(isSeoMetric(exp.primaryMetric) ? exp.primaryMetric : 'clicks', gscWM ?? noWM, threshold, seoSufficiency),
          supporting: (['clicks', 'impressions', 'ctr', 'position'] as const)
            .filter((m) => m !== exp.primaryMetric)
            .map((m) => compare(m, gscWM ?? noWM, threshold, seoSufficiency)),
          sample: {
            minImpressionsPerWindow: sample.minImpressionsPerWindow,
            treatedImpressions: { baseline: (gscWM?.treatedBase as GscMetrics | null)?.impressions ?? null, observation: (gscWM?.treatedObs as GscMetrics | null)?.impressions ?? null },
            comparisonPages: gscWM?.controlPages ?? 0,
            segmentKey: sample.segmentKey,
            searchType: sample.searchType,
          },
        };

  // Conversion assessment.
  const convSufficiency = (() => {
    const r: string[] = [];
    if (!ga4Property) r.push('GA4 property is not configured');
    if (!cfg.conversions.primaryEvents.length) r.push('no primary conversion event is configured');
    if (!ga4Tz) r.push('no GA4 data for this site/property');
    else if (!ga4Win?.ok) r.push(ga4Win ? `no weekday-matched GA4 window yet (${ga4Win.reason}, ${ga4Win.availableObservationDays} complete day(s) after implementation)` : 'no GA4 window');
    const b = ga4WM?.treatedBase as Ga4Metrics | null | undefined;
    const o = ga4WM?.treatedObs as Ga4Metrics | null | undefined;
    for (const [label, m] of [['baseline', b], ['observation', o]] as const) {
      if (!m) continue;
      if (m.status !== 'observed') r.push(`GA4 ${label} window ${m.status}${m.reason ? ` (${m.reason})` : ''}`);
      if ((m.sessions ?? 0) < sample.minSessionsPerWindow) r.push(`GA4 ${label} sessions ${m.sessions ?? 'n/a'} < required ${sample.minSessionsPerWindow}`);
      if (m.primaryRateStatus !== 'observed') r.push(`GA4 ${label} primary session key-event rate is ${m.primaryRateStatus}`);
    }
    // Unknown converting sessions (rate not observed, already a reason above) are never read as 0.
    if (b && o && b.convertingSessions !== null && o.convertingSessions !== null) {
      const maxConv = Math.max(b.convertingSessions, o.convertingSessions);
      if (maxConv < sample.minConvertingSessionsPerWindow) {
        r.push(`too few converting sessions to judge (max ${maxConv.toFixed(1)} per window < ${sample.minConvertingSessionsPerWindow}); a small or zero change in a small sample is not evidence of failure`);
      }
    }
    // Also the comparison windows: a comparison group whose missing rows count as zero (or whose values are estimates) would bias the effect.
    r.push(...ga4CaveatNotes);
    return { ok: r.length === 0 && !!ga4WM, reasons: r };
  })();
  const conversion: OutcomeAssessment | null =
    exp.outcomeKind === 'seo_visibility'
      ? null
      : {
          kind: 'conversion',
          primary: compare(isConversionMetric(exp.primaryMetric) ? exp.primaryMetric : 'primarySessionRate', ga4WM ?? noWM, threshold, convSufficiency),
          supporting: (['sessions', 'primarySessionRate', 'primaryKeyEvents', 'engagedSessionRate'] as const)
            .filter((m) => m !== exp.primaryMetric)
            .map((m) => compare(m, ga4WM ?? noWM, threshold, convSufficiency)),
          sample: {
            minSessionsPerWindow: sample.minSessionsPerWindow,
            minConvertingSessionsPerWindow: sample.minConvertingSessionsPerWindow,
            treatedSessions: { baseline: (ga4WM?.treatedBase as Ga4Metrics | null)?.sessions ?? null, observation: (ga4WM?.treatedObs as Ga4Metrics | null)?.sessions ?? null },
            estimatedConvertingSessions: {
              baseline: (ga4WM?.treatedBase as Ga4Metrics | null)?.convertingSessions ?? null,
              observation: (ga4WM?.treatedObs as Ga4Metrics | null)?.convertingSessions ?? null,
              note: 'estimated as sum(reported sessionKeyEventRate x sessions); key-event occurrences are reported separately and never divided by sessions',
            },
            channelView: sample.channelView,
            segmentKey: sample.segmentKey,
            ...(ga4Caveats.missing ? { absentRowsUnknown: ga4Caveats.missing } : {}),
            ...(ga4Caveats.estimate ? { estimatedValues: ga4Caveats.estimate } : {}),
          },
        };

  // Measurement configuration drift since the proposal (A7-09).
  const frozenCfg = exp.frozenVersions?.measurementConfig ?? null;
  const configDrift: ConfigDrift[] | null = frozenCfg ? measurementConfigDrift(frozenCfg, measurementConfigOf(ctx, sample)) : null;
  const seoDrift = (configDrift ?? []).filter((d) => d.affects === 'seo');
  const convDrift = (configDrift ?? []).filter((d) => d.affects === 'conversion');
  const describeDrift = (ds: ConfigDrift[]) => ds.map((d) => `${d.field} ${JSON.stringify(d.frozen)} -> ${JSON.stringify(d.current)}`).join('; ');

  // Guardrails.
  const guardrails: GuardrailResult[] = exp.guardrails.map((g) => {
    const wm = isSeoMetric(g.metric) ? gscWM : ga4WM;
    const suff = isSeoMetric(g.metric) ? seoSufficiency : convSufficiency;
    const c = compare(g.metric, wm ?? noWM, g.maxRelativeDecline, suff);
    const drifted = isSeoMetric(g.metric) ? seoDrift : convDrift;
    if (drifted.length) c.reasons.push(`measurement configuration changed during the experiment (${describeDrift(drifted)}): the windows are not comparable`);
    const status: GuardrailResult['status'] =
      drifted.length || c.verdict === 'insufficient_data' || c.verdict === 'data_unavailable' ? 'unavailable' : c.effect !== null && c.effect <= -g.maxRelativeDecline ? 'breached' : 'ok';
    return { metric: g.metric, maxRelativeDecline: g.maxRelativeDecline, status, comparison: c };
  });

  // Frozen method version.
  const frozenMethodVersion = exp.frozenVersions?.measurementMethodVersion ?? null;
  if (frozenMethodVersion && frozenMethodVersion !== EVALUATION_METHOD_VERSION) {
    reasons.push(`measurement method changed since the experiment started (frozen v${frozenMethodVersion}, current v${EVALUATION_METHOD_VERSION}); treat the comparison with caution`);
  }

  // Scope caveat (A7-07): the evaluator measures page-level totals, never query-level metrics.
  const ev = exp.evidence as { recommendationSuccessCriteria?: unknown; successCriteria?: unknown; criteriaScopeMismatch?: unknown; query?: unknown };
  const originalCriteria =
    typeof ev.recommendationSuccessCriteria === 'string' ? ev.recommendationSuccessCriteria : !sample.measuredScope && typeof ev.successCriteria === 'string' ? ev.successCriteria : null;
  const queryLevel = ev.criteriaScopeMismatch === true || (!!originalCriteria && QUERY_LEVEL_CRITERIA.test(originalCriteria));
  const scopeDesc = `page-level totals (Search Console ${sample.searchType}${sample.segmentKey ? `, segment ${sample.segmentKey}` : ', unsegmented'}; GA4 ${sample.channelView})`;
  const scopeCaveat = queryLevel
    ? `scope caveat: the recommendation's success criteria are query-level ("${(originalCriteria ?? '').slice(0, 200)}"), but this evaluation measured ${scopeDesc}; it does not test the query-level criterion`
    : null;
  if (scopeCaveat) reasons.push(scopeCaveat);
  if (configDrift === null) reasons.push('measurement configuration was not frozen at proposal (the experiment predates it); configuration drift cannot be checked');
  else if (configDrift.length) reasons.push(`measurement configuration changed since the experiment was proposed: ${describeDrift(configDrift)}`);
  // The verdict carries the GA4 caveat: the conversion outcome and GA4 guardrails were not judged on rows counted as zero or on estimates.
  if (ga4CaveatNotes.length) {
    const affected = [...(conversion ? ['the conversion outcome'] : []), ...(guardrails.some((g) => isConversionMetric(g.metric)) ? [`GA4 guardrail(s) ${guardrails.filter((g) => isConversionMetric(g.metric)).map((g) => g.metric).join(', ')}`] : [])];
    const what = [...(ga4Caveats.missing ? ['incomplete, not zero'] : []), ...(ga4Caveats.estimate ? ['estimated, not exact'] : [])].join('; ');
    reasons.push(`GA4 data caveat (${affected.join(' and ') || 'GA4 metrics'} ${what}): ${ga4CaveatNotes.join('. ')}`);
  }

  // Decide.
  const minReached = measuredDays >= exp.minObservationDays;
  const maxReached = elapsedDays >= sample.maxObservationDays;
  let result: EvaluationResult;
  let conclusive = false;
  if (!minReached) {
    reasons.push(
      `minimum observation period not reached: the weekday-matched window covers ${measuredDays} of ${exp.minObservationDays} day(s) (${completeDays} complete data day(s) after implementation, ${elapsedDays} calendar day(s) elapsed)`,
    );
    if (maxReached) {
      result = 'inconclusive';
      conclusive = true;
      reasons.push(`maximum observation period (${sample.maxObservationDays} days) passed without enough complete data: concluded inconclusive`);
    } else result = 'collecting';
  } else {
    const verdicts: Verdict[] = [];
    if (seo) verdicts.push(seo.primary.verdict);
    if (conversion) verdicts.push(conversion.primary.verdict);
    const insufficient = verdicts.some((v) => v === 'insufficient_data' || v === 'data_unavailable');
    if (insufficient) {
      for (const a of [seo, conversion]) if (a && (a.primary.verdict === 'insufficient_data' || a.primary.verdict === 'data_unavailable')) reasons.push(`${a.kind}: ${a.primary.verdict} (${a.primary.reasons.join('; ') || 'no detail'})`);
      if (maxReached || opts.conclude) {
        result = 'inconclusive';
        conclusive = true;
        reasons.push(maxReached ? `maximum observation period (${sample.maxObservationDays} days) reached with insufficient evidence: concluded inconclusive` : 'concluded on request with insufficient evidence: inconclusive');
      } else {
        result = 'collecting';
        reasons.push(`continuing to collect data (up to ${sample.maxObservationDays} days) before concluding`);
      }
    } else {
      conclusive = true;
      const pos = verdicts.filter((v) => v === 'positive').length;
      const neg = verdicts.filter((v) => v === 'negative').length;
      if (pos && neg) {
        result = 'inconclusive';
        reasons.push('mixed outcome: search visibility and conversion moved in opposite directions; this is not a win and needs human review');
      } else if (pos) result = 'positive';
      else if (neg) result = 'negative';
      else {
        result = 'inconclusive';
        reasons.push('no meaningful change beyond the threshold');
      }
      if (result === 'positive') {
        const breached = guardrails.filter((g) => g.status === 'breached');
        if (breached.length) {
          result = 'inconclusive';
          reasons.push(`guardrail breached (${breached.map((b) => `${b.metric} ${(b.comparison.effect! * 100).toFixed(1)}%`).join(', ')}): a visibility gain with worse outcomes is not treated as a win`);
        }
        const unverified = guardrails.filter((g) => g.status === 'unavailable');
        if (unverified.length) reasons.push(`guardrail(s) unverified for lack of data: ${unverified.map((u) => u.metric).join(', ')}`);
      }
      if ((result === 'positive' || result === 'negative') && interference.blocking) {
        reasons.push(`interference during the measurement windows (${interference.items.filter((i) => i.blocking).map((i) => `${i.kind}@${i.at}`).join(', ')}): the ${result} change cannot be attributed; concluded inconclusive`);
        result = 'inconclusive';
      }
    }
    // A drifted measurement configuration makes the affected outcome(s) incomparable: concluded inconclusive.
    const affected: string[] = [];
    if (seo && seoDrift.length) affected.push(`search visibility (${describeDrift(seoDrift)})`);
    if (conversion && convDrift.length) affected.push(`conversion (${describeDrift(convDrift)})`);
    if (affected.length) {
      result = 'inconclusive';
      conclusive = true;
      reasons.push(`the measurement configuration of the ${affected.join(' and ')} outcome changed during the experiment, so baseline and observation measure different things: concluded inconclusive`);
    }
  }
  if (interference.items.length) reasons.push(`${interference.items.length} interference flag(s) recorded (${interference.blocking ? 'blocking' : 'non-blocking'})`);

  const isSynthetic =
    ctx.synthetic ||
    [gscWM, ga4WM].some((wm) => wm && [wm.treatedBase, wm.treatedObs, wm.controlBase, wm.controlObs].some((m) => !!m && (m as { anySynthetic: boolean }).anySynthetic));
  if (isSynthetic) reasons.push('SYNTHETIC data: this evaluation uses fixture/demo rows and is not a real measurement');

  // experiment_measurements keeps first-recorded values; say so when revised source data changed them.
  const planned = plannedMeasurements(gscWin, ga4Win, gscWM, ga4WM);
  const measurementRevisions = revisedMeasurements(ctx, exp, planned);
  if (measurementRevisions.length) {
    reasons.push(
      `source data was revised since the first recorded measurement for ${measurementRevisions.join(', ')}; experiment_measurements keeps the first-recorded values (append-only) and this evaluation row holds the current values`,
    );
  }

  const concludeNow = conclusive && !terminal && result !== 'collecting';
  const statusAfter = concludeNow ? (result as 'positive' | 'negative' | 'inconclusive') : exp.status;
  if (terminal) reasons.unshift(`experiment already concluded as ${exp.status}; this re-evaluation is informational and does not change the recorded outcome`);

  const outcome: EvaluationOutcome = {
    experimentId: exp.id,
    evaluationId: null,
    sequence: null,
    evaluatedAt: now.toISOString(),
    result,
    concluded: concludeNow,
    afterConclusion: terminal,
    statusBefore: exp.status,
    statusAfter,
    reasons,
    windows: { gsc: gscWin, ga4: ga4Win, elapsedDays, completeDays, measuredDays, minObservationDays: exp.minObservationDays, maxObservationDays: sample.maxObservationDays },
    seo,
    conversion,
    guardrails,
    interference,
    significance: SIGNIFICANCE,
    methodVersion: EVALUATION_METHOD_VERSION,
    frozenMethodVersion,
    isSynthetic,
    dryRun: !!opts.dryRun,
    learning: null,
    measurementRevisions,
    scopeCaveat,
    configDrift,
  };
  if (opts.dryRun) return outcome;

  const actor = opts.actor ?? 'system';
  const evalId = newId('eval');
  ctx.db.transaction(() => {
    const seq = (ctx.db.get<{ n: number | null }>('SELECT MAX(sequence) AS n FROM experiment_evaluations WHERE experiment_id = ?', [exp.id])?.n ?? 0) + 1;
    ctx.db.run(
      `INSERT INTO experiment_evaluations (id, experiment_id, site_id, sequence, evaluated_at, result, concluded, after_conclusion, reasons_json, windows_json, seo_json, conversion_json,
         guardrails_json, interference_json, significance_json, method, method_version, frozen_versions_json, is_synthetic, actor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        evalId,
        exp.id,
        ctx.siteId,
        seq,
        outcome.evaluatedAt,
        result,
        concludeNow ? 1 : 0,
        terminal ? 1 : 0,
        JSON.stringify(reasons),
        JSON.stringify(outcome.windows),
        seo ? JSON.stringify(seo) : null,
        conversion ? JSON.stringify(conversion) : null,
        JSON.stringify(guardrails),
        JSON.stringify(interference),
        JSON.stringify(SIGNIFICANCE),
        EVALUATION_METHOD,
        EVALUATION_METHOD_VERSION,
        exp.frozenVersions ? JSON.stringify(exp.frozenVersions) : null,
        isSynthetic ? 1 : 0,
        actor,
      ],
    );
    outcome.evaluationId = evalId;
    outcome.sequence = seq;
    writeMeasurements(ctx, exp, planned);
    recordAudit(ctx.db, {
      siteId: ctx.siteId,
      actor,
      eventType: 'experiment.evaluated',
      subjectType: 'experiment',
      subjectId: exp.id,
      details: { evaluationId: evalId, sequence: seq, result, concluded: concludeNow, afterConclusion: terminal },
      at: now,
    });
    if (concludeNow) {
      const obsEnd = [gscWin, ga4Win].filter((w): w is { ok: true; windows: MeasurementWindows } => !!w && w.ok).map((w) => w.windows.observation.end).sort().pop() ?? null;
      transitionExperiment(ctx.db, ctx.clock, {
        siteId: ctx.siteId,
        experimentId: exp.id,
        to: statusAfter as 'positive' | 'negative' | 'inconclusive',
        actor,
        reason: `evaluation ${evalId}: ${reasons.slice(0, 3).join('; ')}`.slice(0, 1000),
        patch: {
          observation_end: obsEnd,
          outcome_json: JSON.stringify({
            result,
            evaluationId: evalId,
            label: 'OBSERVED',
            observational: true,
            seo: seo ? { metric: seo.primary.metric, verdict: seo.primary.verdict, effect: seo.primary.effect, treated: seo.primary.treated, control: seo.primary.control } : null,
            conversion: conversion ? { metric: conversion.primary.metric, verdict: conversion.primary.verdict, effect: conversion.primary.effect, treated: conversion.primary.treated, control: conversion.primary.control } : null,
            guardrails: guardrails.map((g) => ({ metric: g.metric, status: g.status })),
            interference: interference.items.map((i) => ({ id: i.id, kind: i.kind, blocking: i.blocking })),
            significance: SIGNIFICANCE.statement,
            scopeCaveat,
            configDrift,
            isSynthetic,
          }),
        },
      });
    }
  });

  if (concludeNow && (result === 'positive' || result === 'negative') && opts.gate) {
    const primary = (seo ?? conversion)!.primary;
    const eff = primary.effect !== null ? `${(primary.effect * 100).toFixed(1)}%` : 'n/a';
    const dir = result === 'positive' ? 'improvement' : 'deterioration';
    const obsWin = (seo ? gscWin : ga4Win) as WindowResult | null;
    const span = obsWin?.ok ? `${obsWin.windows.observation.start}..${obsWin.windows.observation.end}` : 'n/a';
    const r = proposeLearning(ctx.db, ctx.clock, opts.gate, {
      siteId: ctx.siteId,
      statement: `On ${treatedUrl}, a ${exp.type} change was followed by a ${dir} in ${primary.metric} of ${eff} relative to ${primary.control ? `${primary.control.pages} comparison page(s)` : 'the pre-change period'} (observational, not proof of causality).`,
      scope: `site:${ctx.siteId}; page:${treatedUrl}; change type:${exp.type}; observed ${span}`,
      evidence: {
        experimentId: exp.id,
        evaluationId: evalId,
        evaluationResult: result,
        concluded: true,
        metric: primary.metric,
        verdict: primary.verdict,
        treated: primary.treated,
        control: primary.control,
        effect: primary.effect,
        windowSource: seo ? 'gsc' : 'ga4',
        windows: outcome.windows,
        isSynthetic,
      },
      experimentId: exp.id,
      requestedBy: actor,
    });
    outcome.learning = { learningId: r.learning.id, approvalId: r.approval.id };
  }
  return outcome;
}

interface PlannedMeasurement {
  kind: 'baseline' | 'observation' | 'comparison';
  start: string;
  end: string;
  metricsJson: string;
  methodVersion: string;
  label: string;
}

function plannedMeasurements(gscWin: WindowResult | null, ga4Win: WindowResult | null, gscWM: WindowMetrics | null, ga4WM: WindowMetrics | null): PlannedMeasurement[] {
  const out: PlannedMeasurement[] = [];
  const put = (kind: PlannedMeasurement['kind'], start: string, end: string, metrics: unknown, source: string) =>
    out.push({ kind, start, end, metricsJson: JSON.stringify({ source, metrics }), methodVersion: `${EVALUATION_METHOD_VERSION}:${source}`, label: `${source} ${kind} ${start}..${end}` });
  if (gscWin?.ok && gscWM) {
    const w = gscWin.windows;
    put('baseline', w.baseline.start, w.baseline.end, gscWM.treatedBase, 'gsc');
    put('observation', w.observation.start, w.observation.end, gscWM.treatedObs, 'gsc');
    if (gscWM.controlPages) put('comparison', w.baseline.start, w.observation.end, { baseline: gscWM.controlBase, observation: gscWM.controlObs, pages: gscWM.controlPages }, 'gsc');
  }
  if (ga4Win?.ok && ga4WM) {
    const w = ga4Win.windows;
    put('baseline', w.baseline.start, w.baseline.end, ga4WM.treatedBase, 'ga4');
    put('observation', w.observation.start, w.observation.end, ga4WM.treatedObs, 'ga4');
    if (ga4WM.controlPages) put('comparison', w.baseline.start, w.observation.end, { baseline: ga4WM.controlBase, observation: ga4WM.controlObs, pages: ga4WM.controlPages }, 'ga4');
  }
  return out;
}

function revisedMeasurements(ctx: AppContext, exp: ExperimentRecord, planned: PlannedMeasurement[]): string[] {
  const out: string[] = [];
  for (const m of planned) {
    const existing = ctx.db.get<{ metrics_json: string }>(
      'SELECT metrics_json FROM experiment_measurements WHERE site_id = ? AND experiment_id = ? AND window_kind = ? AND period_start = ? AND period_end = ? AND method_version = ?',
      [ctx.siteId, exp.id, m.kind, m.start, m.end, m.methodVersion],
    );
    if (existing && existing.metrics_json !== m.metricsJson) out.push(m.label);
  }
  return out;
}

/** First-recorded measurement per (experiment, window, period, method/source); never updated (see revisedMeasurements). */
function writeMeasurements(ctx: AppContext, exp: ExperimentRecord, planned: PlannedMeasurement[]): void {
  const at = ctx.clock.now().toISOString();
  for (const m of planned) {
    ctx.db.run(
      `INSERT OR IGNORE INTO experiment_measurements (id, experiment_id, site_id, window_kind, period_start, period_end, metrics_json, method, method_version, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId('msr'), exp.id, ctx.siteId, m.kind, m.start, m.end, m.metricsJson, EVALUATION_METHOD, m.methodVersion, at],
    );
  }
}

const BLOCKING_SITE_KINDS = new Set(['site_change', 'template_change', 'outage', 'critical_fix']);

function normUrl(u: string): string {
  return normalizeUrl(u)?.url ?? u;
}

export function collectInterference(
  ctx: AppContext,
  exp: ExperimentRecord,
  spans: MeasurementWindows[],
  fallbackTz: string,
  treatedUrl?: string | null,
): { items: InterferenceItem[]; blocking: boolean; excludedComparisonPages: string[] } {
  const items: InterferenceItem[] = [];
  const excluded = new Set<string>();
  const implAt = exp.implementedAt!;
  // Span in instants: from the earliest baseline start to the latest observation end (whole days, generous by one day on each side).
  const startDate = spans.length ? spans.map((s) => s.baseline.start).sort()[0]! : dateOfInstant(implAt, fallbackTz);
  const endDate = spans.length ? spans.map((s) => s.observation.end).sort().pop()! : dateOfInstant(ctx.clock.now().toISOString(), fallbackTz);
  const tz = spans[0]?.timeZone ?? fallbackTz;
  const fromIso = new Date(Date.parse(`${startDate}T00:00:00Z`) - 86_400_000).toISOString();
  const toIso = new Date(Date.parse(`${endDate}T23:59:59Z`) + 86_400_000).toISOString();
  const inSpan = (iso: string) => {
    const d = dateOfInstant(iso, tz);
    return d >= startDate && d <= endDate;
  };
  const comparisonIds = new Set(exp.comparisonPages.map((c) => c.pageId));
  const conversionInvolved = exp.outcomeKind !== 'seo_visibility' || exp.guardrails.some((g) => isConversionMetric(g.metric));

  for (const a of annotationsBetween(ctx.db, ctx.siteId, fromIso, toIso) as AnnotationRecord[]) {
    if (!inSpan(a.occurredAt)) continue;
    if (a.source === `experiment:${exp.id}` || a.source?.startsWith(`experiment:${exp.id}:`)) continue; // this experiment's own records
    if (a.scope === 'page') {
      if (a.pageId && a.pageId === exp.pageId) {
        items.push({ source: 'annotation', id: a.id, kind: a.kind, scope: a.scope, at: a.occurredAt, description: a.description, blocking: true, effect: 'another change on the treated page during the measurement windows' });
      } else if (a.pageId && comparisonIds.has(a.pageId)) {
        excluded.add(a.pageId);
        items.push({ source: 'annotation', id: a.id, kind: a.kind, scope: a.scope, at: a.occurredAt, description: a.description, blocking: false, effect: 'comparison page changed: excluded from the comparison group' });
      }
      continue;
    }
    const blocking = ((a.scope === 'site' || a.scope === 'template') && BLOCKING_SITE_KINDS.has(a.kind)) || (a.kind === 'tracking_change' && conversionInvolved);
    items.push({
      source: 'annotation',
      id: a.id,
      kind: a.kind,
      scope: a.scope,
      at: a.occurredAt,
      description: a.description,
      blocking,
      effect: blocking
        ? 'site/template/tracking change can affect the treated page differently from comparison pages'
        : 'external/site-wide factor; comparison pages partially control for it, flagged for review',
    });
  }

  // Recorded implementations of drafts and recommendations (experiments are handled below).
  const treatedUrls = new Set([treatedUrl, getExperimentChange(ctx.db, ctx.siteId, exp.id)?.targetUrl].filter((u): u is string => !!u).map(normUrl));
  const comparisonByUrl = new Map(exp.comparisonPages.map((c) => [normUrl(c.url), c.pageId]));
  const pubs = ctx.db.all<{ id: string; subject_type: string; subject_id: string; page_id: string | null; url: string; implemented_at: string }>(
    `SELECT id, subject_type, subject_id, page_id, url, implemented_at FROM publications
     WHERE site_id = ? AND subject_type != 'experiment' AND implemented_at >= ? AND implemented_at <= ? ORDER BY implemented_at`,
    [ctx.siteId, fromIso, toIso],
  );
  for (const p of pubs) {
    if (!inSpan(p.implemented_at)) continue;
    const url = normUrl(p.url);
    const onTreated = (!!p.page_id && p.page_id === exp.pageId) || treatedUrls.has(url);
    const comparisonId = p.page_id && comparisonIds.has(p.page_id) ? p.page_id : (comparisonByUrl.get(url) ?? null);
    if (onTreated) {
      items.push({
        source: 'publication',
        id: p.id,
        kind: 'recorded_change',
        scope: 'page',
        at: p.implemented_at,
        description: `${p.subject_type} ${p.subject_id} was implemented on the treated page`,
        blocking: true,
        effect: 'another recorded change on the treated page during the measurement windows',
      });
    } else if (comparisonId) {
      excluded.add(comparisonId);
      items.push({
        source: 'publication',
        id: p.id,
        kind: 'recorded_change',
        scope: 'page',
        at: p.implemented_at,
        description: `${p.subject_type} ${p.subject_id} was implemented on a comparison page`,
        blocking: false,
        effect: 'comparison page changed: excluded from the comparison group',
      });
    }
  }

  for (const other of listExperiments(ctx.db, ctx.siteId, { statuses: ['observing', 'positive', 'negative', 'inconclusive', 'cancelled'] })) {
    if (other.id === exp.id || !other.implementedAt || !inSpan(other.implementedAt)) continue;
    if (other.pageId && other.pageId === exp.pageId) {
      items.push({ source: 'experiment', id: other.id, kind: 'overlapping_experiment', scope: 'page', at: other.implementedAt, description: `Experiment ${other.id} changed the same page`, blocking: true, effect: 'another change on the treated page' });
    } else if (other.pageId && comparisonIds.has(other.pageId)) {
      excluded.add(other.pageId);
      items.push({ source: 'experiment', id: other.id, kind: 'comparison_page_experiment', scope: 'page', at: other.implementedAt, description: `Experiment ${other.id} changed a comparison page`, blocking: false, effect: 'comparison page excluded' });
    }
  }
  return { items, blocking: items.some((i) => i.blocking), excludedComparisonPages: [...excluded] };
}

export interface ReviewResult {
  evaluated: EvaluationOutcome[];
  /** Observing experiments not yet due (minimum period and review date not reached); not evaluated unless includeNotDue. */
  notDue: Array<{ id: string; dueDate: string; reviewDate: string | null }>;
  awaitingImplementation: Array<{ id: string; pageId: string | null; approvalId: string | null; updatedAt: string }>;
  errors: Array<{ experimentId: string; error: string }>;
}

/**
 * An observing experiment is due for evaluation once its minimum observation
 * period has elapsed since the actual implementation (business time zone) or
 * its review date has been reached.
 */
export function dueInfo(ctx: AppContext, e: ExperimentRecord): { due: boolean; dueDate: string } {
  const tz = budgetTimeZone(ctx.config);
  const today = dateInZone(ctx.clock.now(), tz);
  const dueDate = e.implementedAt ? addDays(dateInZone(new Date(e.implementedAt), tz), e.minObservationDays) : today;
  const due = today >= dueDate || (!!e.reviewDate && today >= e.reviewDate);
  return { due, dueDate };
}

/** Evaluate due observing experiments (the weekly/monthly review). Records every evaluation. */
export function reviewExperiments(ctx: AppContext, opts: EvaluateOptions & { experimentIds?: string[]; includeNotDue?: boolean } = {}): ReviewResult {
  const observing = listExperiments(ctx.db, ctx.siteId, { statuses: ['observing'] }).filter((e) => !opts.experimentIds || opts.experimentIds.includes(e.id));
  const evaluated: EvaluationOutcome[] = [];
  const notDue: ReviewResult['notDue'] = [];
  const errors: ReviewResult['errors'] = [];
  for (const e of observing) {
    const d = dueInfo(ctx, e);
    if (!d.due && !opts.includeNotDue && !opts.experimentIds) {
      notDue.push({ id: e.id, dueDate: d.dueDate, reviewDate: e.reviewDate });
      continue;
    }
    try {
      evaluated.push(evaluateExperiment(ctx, e.id, opts));
    } catch (err) {
      errors.push({ experimentId: e.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const awaiting = listExperiments(ctx.db, ctx.siteId, { statuses: ['approved', 'awaiting_implementation'] }).map((e) => ({ id: e.id, pageId: e.pageId, approvalId: e.approvalId, updatedAt: e.updatedAt }));
  return { evaluated, notDue, awaitingImplementation: awaiting, errors };
}
