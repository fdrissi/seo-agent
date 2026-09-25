import { addDays, compareDates, dateInZone, daysBetweenInclusive, eachDate, weekdayOf, type IsoDate } from '../core/time.js';

/**
 * Weekday-matched measurement windows of equal length.
 *
 * - The implementation date (in the data source's own reporting time zone) is
 *   a mixed before/after day and is excluded from both windows.
 * - Observation starts the day after the implementation date and ends at the
 *   latest COMPLETE data date (never a partial/incomplete day).
 * - Both windows have the same length, a whole number of weeks, so every
 *   weekday appears equally often in each (weekday matching).
 * - The baseline window is the same number of days immediately before the
 *   implementation date.
 *
 * GSC and GA4 use different date boundaries (GSC reports in its own zone,
 * GA4 in the property zone); windows are computed per source and never
 * shifted into one another.
 */

export interface Window {
  start: IsoDate;
  end: IsoDate;
  days: number;
}

export interface MeasurementWindows {
  timeZone: string;
  implementationDate: IsoDate;
  baseline: Window;
  observation: Window;
  /** Complete data days available after the implementation date (before truncation to whole weeks). */
  availableObservationDays: number;
  weekdayMatched: boolean;
}

export type WindowResult =
  | { ok: true; windows: MeasurementWindows }
  | { ok: false; reason: 'no_complete_data_after_implementation' | 'less_than_one_week' | 'less_than_min'; implementationDate: IsoDate; availableObservationDays: number; minDays?: number };

/**
 * `minDays`: the experiment's minimum observation period. The window is cut to
 * whole weeks, so without it a minimum that is not a multiple of 7 (e.g. 10)
 * could be "reached" by the day count while the evaluated window is shorter
 * (7). With it, the result is `less_than_min` until the whole-week window
 * itself is at least the minimum.
 */
export function computeWindows(input: { implementedAt: string | Date; timeZone: string; latestCompleteDate: IsoDate | null; maxDays?: number; fixedDays?: number; minDays?: number }): WindowResult {
  const implDate = dateInZone(new Date(input.implementedAt), input.timeZone);
  const obsStart = addDays(implDate, 1);
  if (!input.latestCompleteDate || compareDates(input.latestCompleteDate, obsStart) < 0) {
    return { ok: false, reason: 'no_complete_data_after_implementation', implementationDate: implDate, availableObservationDays: 0 };
  }
  const available = daysBetweenInclusive(obsStart, input.latestCompleteDate);
  let len = input.fixedDays !== undefined ? Math.min(input.fixedDays, available) : available;
  if (input.maxDays !== undefined) len = Math.min(len, input.maxDays);
  len = Math.floor(len / 7) * 7;
  if (len < 7) return { ok: false, reason: 'less_than_one_week', implementationDate: implDate, availableObservationDays: available };
  if (input.minDays !== undefined && len < input.minDays) return { ok: false, reason: 'less_than_min', implementationDate: implDate, availableObservationDays: available, minDays: input.minDays };
  const observation: Window = { start: obsStart, end: addDays(obsStart, len - 1), days: len };
  const baseline: Window = { start: addDays(implDate, -len), end: addDays(implDate, -1), days: len };
  return { ok: true, windows: { timeZone: input.timeZone, implementationDate: implDate, baseline, observation, availableObservationDays: available, weekdayMatched: weekdaysMatch(baseline, observation) } };
}

/** Count of each weekday (0 = Sunday) in a window. */
export function weekdayCounts(w: { start: IsoDate; end: IsoDate }): number[] {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const d of eachDate(w.start, w.end)) counts[weekdayOf(d)]!++;
  return counts;
}

export function weekdaysMatch(a: { start: IsoDate; end: IsoDate }, b: { start: IsoDate; end: IsoDate }): boolean {
  const ca = weekdayCounts(a);
  const cb = weekdayCounts(b);
  return ca.every((v, i) => v === cb[i]);
}

/** A trailing window of whole weeks ending at `end` (used for baselines at proposal time). */
export function trailingWeeks(end: IsoDate, weeks: number): Window {
  const days = weeks * 7;
  return { start: addDays(end, -(days - 1)), end, days };
}
