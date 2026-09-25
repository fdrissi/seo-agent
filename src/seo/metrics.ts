import { incomplete, missing, observed, unavailable, type Measured, type MeasurementStatus } from '../core/measured.js';
import type { IsoDate } from '../core/time.js';
import type { Db } from '../database/db.js';
import { describeRowLoss, ga4Coverage, gscCoverage, type CoverageSummary, type Ga4RowLoss } from './coverage.js';
import { CONFIRM_RATE_SCALE_COMMAND } from '../integrations/google/rate-scale-command.js';

/**
 * Deterministic metric aggregation. Numbers are computed here, never by a model.
 *
 * Search Console:
 *   - CTR = sum(clicks) / sum(impressions). Percentages are never averaged.
 *   - Position = impression-weighted average ONLY across compatible
 *     observations (same property, search type, aggregation type, segment,
 *     and date time zone). Anything else is reported as unavailable.
 *   - Property totals, page totals, and page/query rows are separate
 *     datasets. Nothing here adds one to another.
 *   - Only current revisions are read. Non-final dates are excluded by default
 *     (or included when explicitly requested). Either way the aggregate is
 *     then `incomplete` (with its partial value): a window with excluded
 *     dates is shorter than requested and is never compared as if complete.
 * GA4:
 *   - Sessions, event occurrences, and revenue are additive across dates.
 *   - Primary-event session conversion rate = sum(rate_i * sessions_i) /
 *     sum(sessions_i), computed ONLY when the rate was observed for every
 *     row; otherwise it is unavailable with the reason. Event occurrences are
 *     reported separately and are never divided by sessions.
 *   - Users are not additive: they come only from ga4_period_metrics rows for
 *     exactly the requested period.
 * Zero and missing are different: a collected date without a row is a zero,
 * an uncollected date is missing, a truncated date is incomplete. For GA4, a
 * collected date whose covering report(s) all reported row loss ("(other)"
 * bucketing, thresholding, sampling; coverage `rowLoss`) proves nothing for a
 * landing page without a row: the aggregate is incomplete with that reason,
 * never an observed 0.
 * Synthetic rows (is_synthetic = 1: fixtures, demo) mark the aggregate
 * `synthetic`; callers must never present such values as observed.
 */

export const METRICS_VERSION = 'metrics@1.2.0';

// ---------------------------------------------------------------------------
// GA4 key-event rate scale
// ---------------------------------------------------------------------------

/**
 * Scale of GA4 key-event rates (sessionKeyEventRate:<event>,
 * userKeyEventRate:<event>). The GA4 documentation does not say whether they
 * are 0-1 or 0-100, so the GA4 sync records a marker with every stored rate
 * (migration 0100: `ga4_landing_daily.primary_session_rate_scale`,
 * `ga4_period_metrics.rate_scale`):
 *
 * - 'fraction'           verified 0-1 scale (owner confirmation or the
 *                        integer-consistency proof, migration 0320): used directly.
 * - 'percent_normalized' 0-100 was observed or confirmed; the value was divided
 *                        by 100, so the stored value is a fraction: used directly.
 * - 'percent'            (defensive) a stored 0-100 value: divided by 100.
 * - 'undetermined'       nothing established the scale yet; the value is stored
 *                        exactly as reported and is NEVER treated as a
 *                        fraction: no rate x sessions, no OBSERVED percentage.
 *                        Once the property's scale is established (a value
 *                        above 1, `sync ga4 --confirm-rate-scale`, or the
 *                        integer-consistency proof), these rows are re-marked
 *                        as new revisions, so older days become usable too.
 * - NULL                 no marker (rows written before the marker existed or
 *                        by fixtures): the original column contract
 *                        (migration 0004: "0..1 as reported") applies.
 */
export type RateScaleClass = 'fraction' | 'percent' | 'undetermined';

/** Reason prefix used wherever an 'undetermined' rate is refused. */
export const RATE_SCALE_UNVERIFIED = 'rate scale unverified';

export function rateScaleClass(marker: string | null | undefined): RateScaleClass {
  if (marker === 'undetermined') return 'undetermined';
  if (marker === 'percent') return 'percent';
  return 'fraction';
}

/** A stored key-event rate as a 0..1 fraction, or null when its scale is unverified. */
export function rateToFraction(value: number, marker: string | null | undefined): number | null {
  const c = rateScaleClass(marker);
  if (c === 'undetermined') return null;
  return c === 'percent' ? value / 100 : value;
}

/** How the owner establishes an undetermined rate scale (named in every refusal; the command includes the required --as). */
export const CONFIRM_RATE_SCALE_HINT = `compare one stored value with the GA4 interface, then run \`${CONFIRM_RATE_SCALE_COMMAND}\``;

/** Explanation for a refused 'undetermined' rate (`what` names the metric). */
export function rateScaleUnverifiedReason(what: string, detail = ''): string {
  return `${RATE_SCALE_UNVERIFIED}: ${what} is stored exactly as GA4 reported it (rate_scale = undetermined; GA4 does not document whether it is 0-1 or 0-100, no value above 1 has been observed for this property, and no confirmation is recorded), so it is not treated as a fraction${detail ? `; ${detail}` : ''}. To establish the scale, ${CONFIRM_RATE_SCALE_HINT}`;
}
/** Search Console reports calendar dates in Pacific time (docs: America/Los_Angeles). Used as a label only; rows carry date_tz. */
export const GSC_REPORTING_TIME_ZONE = 'America/Los_Angeles';

export type IncompletePolicy = 'exclude' | 'flag';

export interface Period {
  start: IsoDate;
  end: IsoDate;
}

export interface SearchObservation {
  date: IsoDate;
  dateTz: string;
  property: string;
  searchType: string;
  aggregationType: string;
  segmentKey: string;
  clicks: number;
  impressions: number;
  position: number | null;
  isFinal: boolean;
  /** Row is synthetic (fixture/demo data), not a real measurement. */
  isSynthetic?: boolean;
}

export interface CompatibilityKey {
  property: string;
  searchType: string;
  aggregationType: string;
  segmentKey: string;
}

export interface SearchAggregate {
  clicks: Measured<number>;
  impressions: Measured<number>;
  ctr: Measured<number>;
  position: Measured<number>;
  rows: number;
  compatibility: CompatibilityKey | null;
  timeZone: string | null;
  datesWithRows: IsoDate[];
  datesExcludedIncomplete: IsoDate[];
  datesMissing: IsoDate[];
  datesTruncated: IsoDate[];
  /** Overall completeness of the aggregate for the requested window. */
  completeness: 'complete' | 'incomplete' | 'missing' | 'incompatible';
  /** At least one row read is synthetic (fixture/demo): never present as observed. */
  synthetic: boolean;
  warnings: string[];
}

function round(n: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function compatKey(o: SearchObservation): string {
  return JSON.stringify([o.property, o.searchType.toLowerCase(), o.aggregationType.toLowerCase(), o.segmentKey]);
}

function allUnavailable(reason: string, rows: number, warnings: string[], synthetic: boolean): SearchAggregate {
  return {
    clicks: unavailable(reason),
    impressions: unavailable(reason),
    ctr: unavailable(reason),
    position: unavailable(reason),
    rows,
    compatibility: null,
    timeZone: null,
    datesWithRows: [],
    datesExcludedIncomplete: [],
    datesMissing: [],
    datesTruncated: [],
    completeness: 'incompatible',
    synthetic,
    warnings,
  };
}

/** Wrap a computed value according to completeness. */
function withCompleteness<T>(value: T, state: 'complete' | 'incomplete', reason: string): Measured<T> {
  return state === 'complete' ? observed(value) : incomplete(reason, value);
}

/**
 * Aggregate Search Console observations. `coverage` (when given) lets dates
 * without rows count as zero (collected and final), missing (not collected),
 * or incomplete (fresh data or row-limit truncation).
 */
export function aggregateSearch(obs: readonly SearchObservation[], opts: { incompletePolicy?: IncompletePolicy; coverage?: CoverageSummary } = {}): SearchAggregate {
  const policy = opts.incompletePolicy ?? 'exclude';
  const warnings: string[] = [];
  const synthetic = obs.some((o) => o.isSynthetic === true);
  const keys = new Set(obs.map(compatKey));
  if (keys.size > 1) {
    const combos = [...keys].map((k) => {
      const [p, t, a, s] = JSON.parse(k) as string[];
      return `${p}/${t}/${a}/${s || '(no segment)'}`;
    });
    return allUnavailable(`incompatible observations cannot be aggregated (property/searchType/aggregationType/segment differ: ${combos.join(', ')})`, obs.length, warnings, synthetic);
  }
  const tzs = new Set(obs.map((o) => o.dateTz));
  if (tzs.size > 1) return allUnavailable(`observations use different date time zones (${[...tzs].join(', ')})`, obs.length, warnings, synthetic);

  const first = obs[0];
  const included = policy === 'exclude' ? obs.filter((o) => o.isFinal) : [...obs];
  const excludedIncomplete = policy === 'exclude' ? [...new Set(obs.filter((o) => !o.isFinal).map((o) => o.date))].sort() : [];
  const flaggedIncomplete = policy === 'flag' ? [...new Set(obs.filter((o) => !o.isFinal).map((o) => o.date))].sort() : [];
  const datesWithRows = [...new Set(included.map((o) => o.date))].sort();

  // Dates without rows: zero only when collected, final, and not truncated.
  const cov = opts.coverage;
  const datesMissing: IsoDate[] = [];
  const datesTruncated: IsoDate[] = [];
  const datesNoRowIncomplete: IsoDate[] = [];
  if (cov) {
    const withRows = new Set(obs.map((o) => o.date));
    for (const [d, c] of Object.entries(cov.byDate)) {
      if (withRows.has(d)) continue;
      if (c.state === 'missing') datesMissing.push(d);
      else if (c.state === 'incomplete') {
        if (policy === 'flag') datesNoRowIncomplete.push(d);
        else excludedIncomplete.push(d);
      } else if (c.truncated) datesTruncated.push(d);
    }
    excludedIncomplete.sort();
  } else if (obs.length === 0) {
    const reason = 'no rows and collection coverage unknown (a missing row is not a zero)';
    return { ...allUnavailable(reason, 0, warnings, synthetic), clicks: missing(reason), impressions: missing(reason), ctr: missing(reason), position: missing(reason), completeness: 'missing' };
  }

  const withRowsAll = new Set(obs.map((o) => o.date));
  const finalNoRowDates = cov ? Object.entries(cov.byDate).filter(([d, c]) => !withRowsAll.has(d) && c.state === 'final').length : 0;
  if (included.length === 0 && finalNoRowDates === 0 && datesNoRowIncomplete.length === 0) {
    // Nothing collected (or only incomplete dates excluded).
    const onlyIncomplete = cov && datesMissing.length === 0 && excludedIncomplete.length > 0;
    const reason = onlyIncomplete
      ? `only incomplete (non-final) dates in the window (${excludedIncomplete.length}); excluded to avoid comparing incomplete data`
      : `no data collected for ${cov ? `${datesMissing.length} date(s)` : 'the window'}`;
    const m = onlyIncomplete ? incomplete<number>(reason) : missing<number>(reason);
    return {
      clicks: m,
      impressions: m,
      ctr: m,
      position: m,
      rows: obs.length,
      compatibility: first ? { property: first.property, searchType: first.searchType, aggregationType: first.aggregationType, segmentKey: first.segmentKey } : null,
      timeZone: first?.dateTz ?? null,
      datesWithRows: [],
      datesExcludedIncomplete: excludedIncomplete,
      datesMissing,
      datesTruncated,
      completeness: onlyIncomplete ? 'incomplete' : 'missing',
      synthetic,
      warnings,
    };
  }

  const reasons: string[] = [];
  if (datesMissing.length) reasons.push(`${datesMissing.length} date(s) not collected`);
  if (datesTruncated.length) reasons.push(`${datesTruncated.length} date(s) hit a row limit or were not fully collected (for example an import without --complete); absent rows may be omitted rather than zero`);
  if (flaggedIncomplete.length || datesNoRowIncomplete.length) reasons.push(`${flaggedIncomplete.length + datesNoRowIncomplete.length} non-final date(s) included`);
  // Excluded non-final dates make the effective window shorter than requested: never "observed".
  if (excludedIncomplete.length) reasons.push(`${excludedIncomplete.length} non-final date(s) excluded; the value covers a shorter window than requested`);
  const state: 'complete' | 'incomplete' = reasons.length ? 'incomplete' : 'complete';
  const reasonText = reasons.join('; ');
  if (excludedIncomplete.length) warnings.push(`${excludedIncomplete.length} non-final date(s) excluded: ${excludedIncomplete[0]}..${excludedIncomplete[excludedIncomplete.length - 1]}`);

  let clicks = 0;
  let impressions = 0;
  let weighted = 0;
  let positionMissing = 0;
  for (const o of included) {
    clicks += o.clicks;
    impressions += o.impressions;
    if (o.impressions > 0) {
      if (o.position === null || !Number.isFinite(o.position)) positionMissing++;
      else weighted += o.position * o.impressions;
    }
  }
  const ctr: Measured<number> = impressions > 0 ? withCompleteness(round(clicks / impressions), state, reasonText) : unavailable('no impressions in the window; CTR is undefined (not zero)');
  let position: Measured<number>;
  if (impressions === 0) position = unavailable('no impressions in the window; position is undefined');
  else if (positionMissing > 0) position = unavailable(`${positionMissing} row(s) with impressions have no reported position`);
  else position = withCompleteness(round(weighted / impressions, 4), state, reasonText);

  return {
    clicks: withCompleteness(clicks, state, reasonText),
    impressions: withCompleteness(impressions, state, reasonText),
    ctr,
    position,
    rows: included.length,
    compatibility: first ? { property: first.property, searchType: first.searchType, aggregationType: first.aggregationType, segmentKey: first.segmentKey } : null,
    timeZone: first?.dateTz ?? null,
    datesWithRows,
    datesExcludedIncomplete: excludedIncomplete,
    datesMissing,
    datesTruncated,
    completeness: state,
    synthetic,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// GA4
// ---------------------------------------------------------------------------

export interface Ga4Observation {
  date: IsoDate;
  dateTz: string;
  channelView: string;
  segmentKey: string;
  landingPage: string;
  hostName: string;
  sessions: number;
  engagedSessions: number | null;
  keyEvents: number | null;
  primaryEventName: string | null;
  primaryKeyEvents: number | null;
  primaryKeyEventsStatus: MeasurementStatus;
  primaryRate: number | null;
  primaryRateStatus: MeasurementStatus;
  /** Scale marker stored with the rate (see `rateScaleClass`); 'undetermined' rates are never used as fractions. */
  primaryRateScale?: string | null;
  revenueMicros: number | null;
  revenueCurrency: string | null;
  revenueStatus: MeasurementStatus;
  isComplete: boolean;
  /** Row is synthetic (fixture/demo data), not a real measurement. */
  isSynthetic?: boolean;
}

export interface Ga4Aggregate {
  sessions: Measured<number>;
  engagedSessions: Measured<number>;
  primaryEventName: string | null;
  /** Primary-event session conversion rate (0..1), session-weighted from the reported per-row rate. */
  primaryConversionRate: Measured<number>;
  /** Sessions that triggered the primary event, derived as sum(rate_i * sessions_i). Not an event count. */
  primaryConvertingSessions: Measured<number>;
  /** Primary event occurrences (repeatable); never divided by sessions. */
  primaryEventOccurrences: Measured<number>;
  /** All key-event occurrences (repeatable). */
  keyEventOccurrences: Measured<number>;
  revenue: Measured<{ micros: number; currency: string }>;
  rows: number;
  channelView: string | null;
  timeZone: string | null;
  datesWithRows: IsoDate[];
  datesExcludedIncomplete: IsoDate[];
  datesMissing: IsoDate[];
  completeness: 'complete' | 'incomplete' | 'missing' | 'incompatible';
  /** At least one row read is synthetic (fixture/demo): never present as observed. */
  synthetic: boolean;
  /** True when the primary rate was refused because its stored scale is 'undetermined'. */
  primaryRateScaleUnverified?: boolean;
  warnings: string[];
}

function ga4AllUnavailable(reason: string, rows: number, synthetic: boolean): Ga4Aggregate {
  const u = unavailable<never>(reason);
  return {
    sessions: u,
    engagedSessions: u,
    primaryEventName: null,
    primaryConversionRate: u,
    primaryConvertingSessions: u,
    primaryEventOccurrences: u,
    keyEventOccurrences: u,
    revenue: u,
    rows,
    channelView: null,
    timeZone: null,
    datesWithRows: [],
    datesExcludedIncomplete: [],
    datesMissing: [],
    completeness: 'incompatible',
    synthetic,
    warnings: [],
  };
}

/** Sum a nullable additive metric: observed only when present for every row. */
function sumStatus(rows: readonly Ga4Observation[], get: (r: Ga4Observation) => number | null, status: (r: Ga4Observation) => MeasurementStatus, label: string, state: 'complete' | 'incomplete', stateReason: string): Measured<number> {
  if (rows.length === 0) return missing(`no rows for ${label}`);
  let total = 0;
  let missingRows = 0;
  let unavailableRows = 0;
  for (const r of rows) {
    const s = status(r);
    const v = get(r);
    if (s === 'observed' && v !== null) total += v;
    else if (s === 'unavailable') unavailableRows++;
    else missingRows++;
  }
  if (unavailableRows === rows.length) return unavailable(`${label} is unavailable for this property/report`);
  if (missingRows + unavailableRows === rows.length) return missing(`${label} was not recorded`);
  if (missingRows + unavailableRows > 0) return incomplete(`${label} recorded for ${rows.length - missingRows - unavailableRows} of ${rows.length} rows`, round(total));
  return withCompleteness(round(total), state, stateReason);
}

export function aggregateGa4(obs: readonly Ga4Observation[], opts: { configuredPrimaryEvents: readonly string[]; incompletePolicy?: IncompletePolicy; coverage?: CoverageSummary }): Ga4Aggregate {
  const policy = opts.incompletePolicy ?? 'exclude';
  const synthetic = obs.some((o) => o.isSynthetic === true);
  const views = new Set(obs.map((o) => `${o.channelView}|${o.segmentKey}`));
  if (views.size > 1) return ga4AllUnavailable(`incompatible GA4 rows (channel view/segment differ: ${[...views].join(', ')})`, obs.length, synthetic);
  const tzs = new Set(obs.map((o) => o.dateTz));
  if (tzs.size > 1) return ga4AllUnavailable(`GA4 rows use different time zones (${[...tzs].join(', ')})`, obs.length, synthetic);

  const included = policy === 'exclude' ? obs.filter((o) => o.isComplete) : [...obs];
  const excluded = policy === 'exclude' ? [...new Set(obs.filter((o) => !o.isComplete).map((o) => o.date))] : [];
  const flagged = policy === 'flag' ? [...new Set(obs.filter((o) => !o.isComplete).map((o) => o.date))] : [];
  const datesMissing: IsoDate[] = [];
  const withRows = new Set(obs.map((o) => o.date));
  let truncatedNoRow = 0;
  // Collected dates without a row where GA4 reported that rows may be left out ("(other)", thresholding, sampling).
  const rowLossNoRow: IsoDate[] = [];
  const rowLossReasons = new Set<Ga4RowLoss>();
  let cleanZeroDates = 0;
  if (opts.coverage) {
    for (const [d, c] of Object.entries(opts.coverage.byDate)) {
      if (withRows.has(d)) continue;
      if (c.state === 'missing') datesMissing.push(d);
      else if (c.state === 'incomplete' && policy === 'exclude') excluded.push(d);
      else if (c.state === 'incomplete') flagged.push(d);
      else if (c.truncated) truncatedNoRow++;
      else if (c.rowLoss?.length) {
        rowLossNoRow.push(d);
        for (const r of c.rowLoss) rowLossReasons.add(r);
      } else cleanZeroDates++;
    }
  }
  excluded.sort();
  const warnings: string[] = [...(opts.coverage?.warnings ?? [])];
  if (excluded.length) warnings.push(`${excluded.length} incomplete GA4 date(s) excluded`);
  const first = obs[0];
  const base = {
    rows: included.length,
    channelView: first?.channelView ?? null,
    timeZone: first?.dateTz ?? null,
    datesWithRows: [...new Set(included.map((o) => o.date))].sort(),
    datesExcludedIncomplete: excluded,
    datesMissing,
    synthetic,
    warnings,
  };

  const reasons: string[] = [];
  if (datesMissing.length) reasons.push(`${datesMissing.length} GA4 date(s) not collected`);
  if (flagged.length) reasons.push(`${flagged.length} incomplete GA4 date(s) included`);
  if (truncatedNoRow) reasons.push(`${truncatedNoRow} truncated GA4 date(s) without rows`);
  if (rowLossNoRow.length) {
    reasons.push(
      `no GA4 landing row on ${rowLossNoRow.length} collected date(s) (e.g. ${rowLossNoRow[0]}) where GA4 reported ${describeRowLoss([...rowLossReasons])}; a missing row there is unknown, not zero`,
    );
  }
  // Excluded incomplete dates make the effective window shorter than requested: never "observed".
  if (excluded.length) reasons.push(`${excluded.length} incomplete GA4 date(s) excluded; the value covers a shorter window than requested`);
  const state: 'complete' | 'incomplete' = reasons.length ? 'incomplete' : 'complete';
  const why = reasons.join('; ');

  if (included.length === 0) {
    const collectedFinal = opts.coverage ? Object.entries(opts.coverage.byDate).filter(([d, c]) => !withRows.has(d) && c.state === 'final').length : 0;
    if (collectedFinal > 0 && cleanZeroDates === 0 && rowLossNoRow.length > 0) {
      // Every collected date without a row may have had its row withheld or bucketed: nothing is known, not even a partial zero.
      const m = incomplete<never>(why);
      const noPrimary = opts.configuredPrimaryEvents.length === 0 ? unavailable<number>('no primary conversion event is configured (conversions.primaryEvents)') : null;
      return {
        ...base,
        sessions: m,
        engagedSessions: m,
        primaryEventName: null,
        primaryConversionRate: noPrimary ?? m,
        primaryConvertingSessions: noPrimary ?? m,
        primaryEventOccurrences: noPrimary ?? m,
        keyEventOccurrences: m,
        revenue: m,
        completeness: 'incomplete',
      };
    }
    if (collectedFinal > 0) {
      // Collected, final dates and no sessions landed on this page: an observed zero (flagged when coverage is partial).
      const zero = withCompleteness(0, state, why);
      const noPrimary = opts.configuredPrimaryEvents.length === 0 ? unavailable<number>('no primary conversion event is configured (conversions.primaryEvents)') : null;
      return {
        ...base,
        sessions: zero,
        engagedSessions: zero,
        primaryEventName: null,
        primaryConversionRate: noPrimary ?? unavailable('no sessions in the window; conversion rate is undefined (not zero)'),
        primaryConvertingSessions: noPrimary ?? zero,
        primaryEventOccurrences: noPrimary ?? zero,
        keyEventOccurrences: zero,
        revenue: unavailable('no sessions in the window'),
        completeness: state,
      };
    }
    const onlyIncomplete = !!opts.coverage && excluded.length > 0 && datesMissing.length === 0;
    const reason = opts.coverage ? (onlyIncomplete ? 'only incomplete GA4 dates in the window; excluded' : `GA4 data not collected for ${datesMissing.length} date(s)`) : 'no GA4 rows and collection coverage unknown (a missing row is not a zero)';
    const m = onlyIncomplete ? incomplete<never>(reason) : missing<never>(reason);
    return { ...base, sessions: m, engagedSessions: m, primaryEventName: null, primaryConversionRate: m, primaryConvertingSessions: m, primaryEventOccurrences: m, keyEventOccurrences: m, revenue: m, completeness: onlyIncomplete ? 'incomplete' : 'missing' };
  }

  const sessions = included.reduce((a, o) => a + o.sessions, 0);
  const engagedKnown = included.every((o) => o.engagedSessions !== null);
  const engagedSessions: Measured<number> = engagedKnown
    ? withCompleteness(included.reduce((a, o) => a + (o.engagedSessions ?? 0), 0), state, why)
    : incomplete('engagedSessions not recorded for every row');

  // Primary-event session conversion rate.
  let primaryConversionRate: Measured<number>;
  let primaryConvertingSessions: Measured<number>;
  let primaryRateScaleUnverified = false;
  const names = [...new Set(included.map((o) => o.primaryEventName).filter((n): n is string => !!n))];
  const withSessions = included.filter((o) => o.sessions > 0);
  if (opts.configuredPrimaryEvents.length === 0) {
    primaryConversionRate = unavailable('no primary conversion event is configured (conversions.primaryEvents)');
    primaryConvertingSessions = primaryConversionRate;
  } else if (names.length > 1) {
    primaryConversionRate = unavailable(`rows report different primary events (${names.join(', ')}); rates for different events are not combined`);
    primaryConvertingSessions = primaryConversionRate;
  } else if (names.length === 1 && !opts.configuredPrimaryEvents.includes(names[0]!)) {
    primaryConversionRate = unavailable(`rows report event "${names[0]}", which is not a configured primary event`);
    primaryConvertingSessions = primaryConversionRate;
  } else if (sessions === 0) {
    primaryConversionRate = unavailable('no sessions in the window; conversion rate is undefined (not zero)');
    primaryConvertingSessions = observed(0);
  } else {
    const notObserved = withSessions.filter((o) => o.primaryRateStatus !== 'observed' || o.primaryRate === null);
    const unverified = withSessions.filter((o) => o.primaryRate !== null && rateScaleClass(o.primaryRateScale) === 'undetermined');
    const fraction = (o: Ga4Observation): number => (o.primaryRate === null ? 0 : (rateToFraction(o.primaryRate, o.primaryRateScale) ?? 0));
    const outOfScale = withSessions.filter((o) => o.primaryRate !== null && (fraction(o) < 0 || fraction(o) > 1));
    if (notObserved.length) {
      const statuses = [...new Set(notObserved.map((o) => o.primaryRateStatus))].join('/');
      primaryConversionRate = unavailable(
        `primary-event session rate (sessionKeyEventRate:<event>) not observed for ${notObserved.length} of ${withSessions.length} rows (${statuses}); event occurrences are not substituted and "any key event" rates are not used`,
      );
      primaryConvertingSessions = primaryConversionRate;
    } else if (unverified.length) {
      primaryRateScaleUnverified = true;
      primaryConversionRate = unavailable(rateScaleUnverifiedReason('sessionKeyEventRate:<event>', `${unverified.length} of ${withSessions.length} rows; converting sessions are not derived from it`));
      primaryConvertingSessions = primaryConversionRate;
    } else if (outOfScale.length) {
      primaryConversionRate = unavailable(`${outOfScale.length} row(s) report a rate outside 0..1; the rate scale is unverified, so it is not combined`);
      primaryConvertingSessions = primaryConversionRate;
    } else {
      const converting = withSessions.reduce((a, o) => a + fraction(o) * o.sessions, 0);
      primaryConversionRate = withCompleteness(round(converting / sessions), state, why);
      primaryConvertingSessions = withCompleteness(round(converting, 3), state, why);
    }
  }

  const primaryEventOccurrences = opts.configuredPrimaryEvents.length === 0
    ? unavailable<number>('no primary conversion event is configured')
    : sumStatus(included, (o) => o.primaryKeyEvents, (o) => o.primaryKeyEventsStatus, 'primary event occurrences', state, why);
  const keyEventOccurrences = sumStatus(included, (o) => o.keyEvents, (o) => (o.keyEvents === null ? 'missing' : 'observed'), 'key event occurrences', state, why);

  let revenue: Measured<{ micros: number; currency: string }>;
  const revObserved = included.filter((o) => o.revenueStatus === 'observed' && o.revenueMicros !== null);
  const currencies = [...new Set(revObserved.map((o) => o.revenueCurrency ?? ''))];
  if (included.every((o) => o.revenueStatus === 'unavailable')) revenue = unavailable('revenue is unavailable for this property/report');
  else if (revObserved.length === 0) revenue = missing('revenue was not recorded');
  else if (currencies.length > 1 || currencies[0] === '') revenue = unavailable(`revenue currencies differ or are unknown (${currencies.join(', ') || 'none'}); not summed`);
  else {
    const total = revObserved.reduce((a, o) => a + (o.revenueMicros ?? 0), 0);
    const value = { micros: total, currency: currencies[0]! };
    revenue = revObserved.length === included.length ? withCompleteness(value, state, why) : incomplete(`revenue recorded for ${revObserved.length} of ${included.length} rows`, value);
  }

  return {
    ...base,
    sessions: withCompleteness(sessions, state, why),
    engagedSessions,
    primaryEventName: names[0] ?? null,
    primaryConversionRate,
    primaryConvertingSessions,
    primaryEventOccurrences,
    keyEventOccurrences,
    revenue,
    completeness: state,
    ...(primaryRateScaleUnverified ? { primaryRateScaleUnverified: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Database readers (current revisions only, always scoped by site_id)
// ---------------------------------------------------------------------------

interface GscRow {
  date: string;
  date_tz: string;
  property: string;
  search_type: string;
  aggregation_type: string;
  segment_key: string;
  clicks: number;
  impressions: number;
  position: number | null;
  is_final: number;
  is_synthetic: number;
}

function toSearchObs(r: GscRow): SearchObservation {
  return {
    date: r.date,
    dateTz: r.date_tz,
    property: r.property,
    searchType: r.search_type,
    aggregationType: r.aggregation_type,
    segmentKey: r.segment_key ?? '',
    clicks: r.clicks,
    impressions: r.impressions,
    position: r.position,
    isFinal: r.is_final === 1,
    isSynthetic: r.is_synthetic === 1,
  };
}

export interface GscScope extends Period {
  property: string;
  searchType: string;
  segmentKey?: string;
  incompletePolicy?: IncompletePolicy;
}

const GSC_COLS = 'date, date_tz, property, search_type, aggregation_type, segment_key, clicks, impressions, position, is_final, is_synthetic';

export function readGscPageObservations(db: Db, siteId: string, pageId: string, s: GscScope): SearchObservation[] {
  return db
    .all<GscRow>(
      `SELECT ${GSC_COLS} FROM gsc_page_daily WHERE site_id = ? AND is_current = 1 AND page_id = ? AND property = ? AND search_type = ? AND segment_key = ? AND date BETWEEN ? AND ? ORDER BY date`,
      [siteId, pageId, s.property, s.searchType, s.segmentKey ?? '', s.start, s.end],
    )
    .map(toSearchObs);
}

/** Property totals (byProperty). Kept separate from page and query datasets. */
export function readGscPropertyObservations(db: Db, siteId: string, s: GscScope): SearchObservation[] {
  return db
    .all<GscRow>(
      `SELECT date, date_tz, property, search_type, aggregation_type, '' AS segment_key, clicks, impressions, position, is_final, is_synthetic FROM gsc_property_daily WHERE site_id = ? AND is_current = 1 AND property = ? AND search_type = ? AND date BETWEEN ? AND ? ORDER BY date`,
      [siteId, s.property, s.searchType, s.start, s.end],
    )
    .map(toSearchObs);
}

export function gscPageMetrics(db: Db, siteId: string, pageId: string, s: GscScope): SearchAggregate {
  const coverage = gscCoverage(db, siteId, { dataset: 'gsc_page_daily', property: s.property, searchType: s.searchType, start: s.start, end: s.end, segmentKey: s.segmentKey ?? '' });
  return aggregateSearch(readGscPageObservations(db, siteId, pageId, s), { incompletePolicy: s.incompletePolicy ?? 'exclude', coverage });
}

export function gscPropertyMetrics(db: Db, siteId: string, s: GscScope): SearchAggregate {
  const coverage = gscCoverage(db, siteId, { dataset: 'gsc_property_daily', property: s.property, searchType: s.searchType, start: s.start, end: s.end });
  return aggregateSearch(readGscPropertyObservations(db, siteId, s), { incompletePolicy: s.incompletePolicy ?? 'exclude', coverage });
}

export interface QueryAggregate {
  query: string;
  agg: SearchAggregate;
}

/**
 * Per-query aggregates for one page (visible query rows only). Anonymized
 * queries are never returned by GSC, so these never add up to page totals and
 * are never presented as such.
 */
export function gscQueryMetrics(db: Db, siteId: string, pageId: string, s: GscScope): QueryAggregate[] {
  const rows = db.all<GscRow & { query: string }>(
    `SELECT ${GSC_COLS}, query FROM gsc_page_query_daily WHERE site_id = ? AND is_current = 1 AND page_id = ? AND property = ? AND search_type = ? AND segment_key = ? AND date BETWEEN ? AND ? ORDER BY query, date`,
    [siteId, pageId, s.property, s.searchType, s.segmentKey ?? '', s.start, s.end],
  );
  const byQuery = new Map<string, SearchObservation[]>();
  for (const r of rows) {
    const list = byQuery.get(r.query) ?? [];
    list.push(toSearchObs(r));
    byQuery.set(r.query, list);
  }
  return [...byQuery.entries()].map(([query, obs]) => ({ query, agg: aggregateSearch(obs, { incompletePolicy: s.incompletePolicy ?? 'exclude' }) }));
}

/** Per-(page, query) aggregates across the site for benchmarks. */
export function gscAllPageQueryUnits(db: Db, siteId: string, s: GscScope): Array<{ pageId: string | null; query: string; clicks: number; impressions: number; position: number | null }> {
  const rows = db.all<{ page_id: string | null; query: string; clicks: number; impressions: number; wpos: number | null; missing_pos: number }>(
    `SELECT MAX(page_id) AS page_id, query, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
            SUM(CASE WHEN impressions > 0 THEN position * impressions END) AS wpos,
            SUM(CASE WHEN impressions > 0 AND position IS NULL THEN 1 ELSE 0 END) AS missing_pos
       FROM gsc_page_query_daily
      WHERE site_id = ? AND is_current = 1 AND is_final = 1 AND property = ? AND search_type = ? AND segment_key = ? AND date BETWEEN ? AND ?
      GROUP BY COALESCE(page_id, page), query`,
    [siteId, s.property, s.searchType, s.segmentKey ?? '', s.start, s.end],
  );
  return rows.map((r) => ({
    pageId: r.page_id,
    query: r.query,
    clicks: r.clicks,
    impressions: r.impressions,
    position: r.impressions > 0 && r.missing_pos === 0 && r.wpos !== null ? r.wpos / r.impressions : null,
  }));
}

/** Per-page aggregates across the site (final dates only) for benchmarks and site context. */
export function gscAllPageUnits(db: Db, siteId: string, s: GscScope): Array<{ pageId: string | null; clicks: number; impressions: number; position: number | null }> {
  const rows = db.all<{ page_id: string | null; clicks: number; impressions: number; wpos: number | null; missing_pos: number }>(
    `SELECT page_id, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
            SUM(CASE WHEN impressions > 0 THEN position * impressions END) AS wpos,
            SUM(CASE WHEN impressions > 0 AND position IS NULL THEN 1 ELSE 0 END) AS missing_pos
       FROM gsc_page_daily
      WHERE site_id = ? AND is_current = 1 AND is_final = 1 AND property = ? AND search_type = ? AND segment_key = ? AND date BETWEEN ? AND ?
      GROUP BY page_id`,
    [siteId, s.property, s.searchType, s.segmentKey ?? '', s.start, s.end],
  );
  return rows.map((r) => ({
    pageId: r.page_id,
    clicks: r.clicks,
    impressions: r.impressions,
    position: r.impressions > 0 && r.missing_pos === 0 && r.wpos !== null ? r.wpos / r.impressions : null,
  }));
}

interface Ga4Row {
  date: string;
  date_tz: string;
  channel_view: string;
  segment_key: string;
  landing_page: string;
  host_name: string;
  sessions: number;
  engaged_sessions: number | null;
  key_events: number | null;
  primary_event_name: string | null;
  primary_key_events: number | null;
  primary_key_events_status: MeasurementStatus;
  primary_session_rate: number | null;
  primary_session_rate_status: MeasurementStatus;
  primary_session_rate_scale: string | null;
  revenue_micros: number | null;
  revenue_currency: string | null;
  revenue_status: MeasurementStatus;
  is_complete: number;
  is_synthetic: number;
}

function toGa4Obs(r: Ga4Row): Ga4Observation {
  return {
    date: r.date,
    dateTz: r.date_tz,
    channelView: r.channel_view,
    segmentKey: r.segment_key ?? '',
    landingPage: r.landing_page,
    hostName: r.host_name,
    sessions: r.sessions,
    engagedSessions: r.engaged_sessions,
    keyEvents: r.key_events,
    primaryEventName: r.primary_event_name,
    primaryKeyEvents: r.primary_key_events,
    primaryKeyEventsStatus: r.primary_key_events_status,
    primaryRate: r.primary_session_rate,
    primaryRateStatus: r.primary_session_rate_status,
    primaryRateScale: r.primary_session_rate_scale,
    revenueMicros: r.revenue_micros,
    revenueCurrency: r.revenue_currency,
    revenueStatus: r.revenue_status,
    isComplete: r.is_complete === 1,
    isSynthetic: r.is_synthetic === 1,
  };
}

export interface Ga4Scope extends Period {
  propertyId: string;
  channelView: 'google_organic' | 'all_organic';
  segmentKey?: string;
  incompletePolicy?: IncompletePolicy;
  configuredPrimaryEvents: readonly string[];
}

const GA4_COLS =
  'date, date_tz, channel_view, segment_key, landing_page, host_name, sessions, engaged_sessions, key_events, primary_event_name, primary_key_events, primary_key_events_status, primary_session_rate, primary_session_rate_status, primary_session_rate_scale, revenue_micros, revenue_currency, revenue_status, is_complete, is_synthetic';

export function readGa4PageObservations(db: Db, siteId: string, pageId: string, s: Ga4Scope): Ga4Observation[] {
  return db
    .all<Ga4Row>(
      `SELECT ${GA4_COLS} FROM ga4_landing_daily WHERE site_id = ? AND is_current = 1 AND page_id = ? AND property_id = ? AND channel_view = ? AND segment_key = ? AND date BETWEEN ? AND ? ORDER BY date`,
      [siteId, pageId, s.propertyId, s.channelView, s.segmentKey ?? '', s.start, s.end],
    )
    .map(toGa4Obs);
}

export function ga4PageMetrics(db: Db, siteId: string, pageId: string, s: Ga4Scope): Ga4Aggregate {
  const coverage = ga4Coverage(db, siteId, { propertyId: s.propertyId, start: s.start, end: s.end, channelView: s.channelView, segmentKey: s.segmentKey ?? '' });
  return aggregateGa4(readGa4PageObservations(db, siteId, pageId, s), { configuredPrimaryEvents: s.configuredPrimaryEvents, incompletePolicy: s.incompletePolicy ?? 'exclude', coverage });
}

/**
 * Site-level GA4 aggregate over all landing rows of a channel view
 * (optionally excluding one page, for benchmarks). Includes unresolved and
 * "(not set)" landing rows, because they are real sessions.
 */
export function ga4SiteMetrics(db: Db, siteId: string, s: Ga4Scope & { excludePageId?: string }): Ga4Aggregate {
  const rows = db
    .all<Ga4Row>(
      `SELECT ${GA4_COLS} FROM ga4_landing_daily WHERE site_id = ? AND is_current = 1 AND property_id = ? AND channel_view = ? AND segment_key = ? AND date BETWEEN ? AND ?
         AND (? IS NULL OR page_id IS NULL OR page_id != ?) ORDER BY date`,
      [siteId, s.propertyId, s.channelView, s.segmentKey ?? '', s.start, s.end, s.excludePageId ?? null, s.excludePageId ?? null],
    )
    .map(toGa4Obs);
  const coverage = ga4Coverage(db, siteId, { propertyId: s.propertyId, start: s.start, end: s.end, channelView: s.channelView, segmentKey: s.segmentKey ?? '' });
  return aggregateGa4(rows, { configuredPrimaryEvents: s.configuredPrimaryEvents, incompletePolicy: s.incompletePolicy ?? 'exclude', coverage });
}

/**
 * Users are NOT additive across dates, pages, or segments. They are read only
 * from ga4_period_metrics for exactly the requested period and landing page
 * ('' = all landing pages). Never summed from daily rows or sub-periods.
 */
export function ga4PeriodUsers(
  db: Db,
  siteId: string,
  opts: Period & { propertyId: string; channelView: 'google_organic' | 'all_organic' | 'all_traffic'; landingPage?: string; metric?: 'totalUsers' | 'activeUsers' },
): Measured<number> {
  const metric = opts.metric ?? 'totalUsers';
  const landing = opts.landingPage ?? '';
  const row = db.get<{ value: number | null; value_status: MeasurementStatus; is_complete: number }>(
    `SELECT value, value_status, is_complete FROM ga4_period_metrics WHERE site_id = ? AND is_current = 1 AND property_id = ? AND channel_view = ? AND landing_page = ? AND metric = ? AND period_start = ? AND period_end = ?`,
    [siteId, opts.propertyId, opts.channelView, landing, metric, opts.start, opts.end],
  );
  if (!row) {
    const sub = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ga4_period_metrics WHERE site_id = ? AND is_current = 1 AND property_id = ? AND channel_view = ? AND landing_page = ? AND metric = ? AND period_start >= ? AND period_end <= ?`,
      [siteId, opts.propertyId, opts.channelView, landing, metric, opts.start, opts.end],
    );
    return unavailable(
      `${metric} is not additive across dates; no period-level row exists for exactly ${opts.start}..${opts.end}${sub && sub.n > 0 ? ` (${sub.n} sub-period row(s) exist and are deliberately not summed)` : ''}`,
    );
  }
  if (row.value_status !== 'observed' || row.value === null) return row.value_status === 'unavailable' ? unavailable(`${metric} unavailable for this report`) : missing(`${metric} not recorded`);
  return row.is_complete === 1 ? observed(row.value) : incomplete('period includes incomplete GA4 dates', row.value);
}

/** Distinct raw GA4 landing paths mapped to a page (needed to look up period-level metrics). */
export function ga4LandingVariants(db: Db, siteId: string, pageId: string, propertyId: string): Array<{ landingPage: string; hostName: string }> {
  return db
    .all<{ landing_page: string; host_name: string }>('SELECT DISTINCT landing_page, host_name FROM ga4_landing_daily WHERE site_id = ? AND page_id = ? AND property_id = ? AND is_current = 1', [siteId, pageId, propertyId])
    .map((r) => ({ landingPage: r.landing_page, hostName: r.host_name }));
}

/**
 * Users for one page: available only when the page maps to exactly one
 * landing path with a period row, AND no other host shares that landing path.
 * The period-level by-landing report is keyed by landingPagePlusQueryString
 * only (no hostName), so when the daily landing rows show the same path on
 * several hosts (www and non-www, staging, another domain in the property),
 * its users figure mixes them and is never presented as this page's users.
 */
export function ga4PageUsers(db: Db, siteId: string, pageId: string, opts: Period & { propertyId: string; channelView: 'google_organic' | 'all_organic' }): Measured<number> {
  const variants = ga4LandingVariants(db, siteId, pageId, opts.propertyId);
  const paths = [...new Set(variants.map((v) => v.landingPage))];
  if (paths.length === 0) return missing('no GA4 landing rows for this page');
  if (paths.length > 1) return unavailable(`page maps to ${paths.length} GA4 landing-path variants; users cannot be summed across them`);
  const landing = paths[0]!;
  const hosts = ga4LandingPathHosts(db, siteId, { ...opts, landingPage: landing });
  if (hosts.length > 1) {
    return unavailable(
      `other hosts share this landing path: GA4 landing rows for "${landing}" (${opts.channelView}, ${opts.start}..${opts.end}) come from ${hosts.length} hosts (${hosts.map((h) => h || '(host not reported)').join(', ')}), and the period-level users figure is not split by host, so it would mix them`,
    );
  }
  return ga4PeriodUsers(db, siteId, { ...opts, landingPage: landing });
}

/** Distinct host names (including '' = not reported) of the daily landing rows for one landing path, view, and period. */
export function ga4LandingPathHosts(db: Db, siteId: string, opts: Period & { propertyId: string; channelView: string; landingPage: string }): string[] {
  return db
    .all<{ host_name: string }>(
      `SELECT DISTINCT host_name FROM ga4_landing_daily WHERE site_id = ? AND is_current = 1 AND property_id = ? AND channel_view = ? AND landing_page = ? AND date BETWEEN ? AND ? ORDER BY host_name`,
      [siteId, opts.propertyId, opts.channelView, opts.landingPage, opts.start, opts.end],
    )
    .map((r) => r.host_name);
}

// ---------------------------------------------------------------------------
// Period comparison
// ---------------------------------------------------------------------------

export interface Change {
  current: number;
  previous: number;
  absolute: number;
  /** Relative change in percent; unavailable when previous is 0. */
  pct: Measured<number>;
}

/**
 * Compare two measured values. Refuses (unavailable) when either side is not
 * fully observed: incomplete current dates are never compared with completed
 * periods.
 */
export function compareMeasured(current: Measured<number>, previous: Measured<number>): Measured<Change> {
  if (current.status !== 'observed') return unavailable(`current period not comparable (${current.status}: ${current.reason})`);
  if (previous.status !== 'observed') return unavailable(`previous period not comparable (${previous.status}: ${previous.reason})`);
  const abs = current.value - previous.value;
  return observed({
    current: current.value,
    previous: previous.value,
    absolute: round(abs),
    pct: previous.value === 0 ? unavailable('previous value is zero') : observed(round((abs / previous.value) * 100, 2)),
  });
}
