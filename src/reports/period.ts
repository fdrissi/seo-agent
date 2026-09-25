import type { AppContext } from '../app/context.js';
import { budgetTimeZone } from '../app/context.js';
import { AppError } from '../core/errors.js';
import { addDays, assertIsoDate, dateInZone, daysBetweenInclusive, type IsoDate } from '../core/time.js';
import type { ReportKind, ReportPeriod } from './model.js';

/**
 * Report period resolution. Periods end at the latest date believed COMPLETE
 * so incomplete current dates are never compared with completed periods:
 *
 * 1. Search Console data availability (latest final date / first incomplete date),
 * 2. else the latest final Search Console property row,
 * 3. else the latest complete GA4 row,
 * 4. else business-today minus 3 days (Search Console final data typically
 *    lags 2-3 days), labeled as an assumption.
 *
 * Weekly: 7 days ending there, compared with the preceding 7 days.
 * Monthly: the latest full calendar month ending on or before it, compared with the month before.
 * Baseline: `google.gsc.initialHistoryDays` (default 90) ending there; no comparison.
 */

export interface PeriodOverride {
  start?: string;
  end?: string;
}

export function reportTimeZone(ctx: AppContext): string {
  return budgetTimeZone(ctx.config);
}

/**
 * The report time zone and where it came from. When
 * reporting.businessTimezone is unknown (null), period boundaries use the
 * scheduler zone (budgetTimeZone falls back to scheduler.timezone); that zone
 * is a fact about the owner's machine, not the business, so reports say so
 * instead of labelling it the business time zone.
 */
export function reportTimeZoneInfo(ctx: AppContext): { timeZone: string; source: 'business' | 'scheduler_fallback'; schedulerTimeZone: string } {
  const business = ctx.config.reporting.businessTimezone;
  return { timeZone: reportTimeZone(ctx), source: business ? 'business' : 'scheduler_fallback', schedulerTimeZone: ctx.config.scheduler.timezone };
}

export function latestCompleteDate(ctx: AppContext): { date: IsoDate; basis: string; fromData: boolean } {
  const tz = reportTimeZone(ctx);
  const today = dateInZone(ctx.clock.now(), tz);
  const cap = addDays(today, -1);
  const clamp = (d: string) => (d > cap ? cap : d);
  const property = ctx.config.google.searchConsoleProperty;

  const avail = ctx.db.get<{ latest_final_date: string | null; first_incomplete_date: string | null; checked_at: string }>(
    `SELECT latest_final_date, first_incomplete_date, checked_at FROM gsc_data_availability
     WHERE site_id = ? AND (? IS NULL OR property = ?) ORDER BY checked_at DESC LIMIT 1`,
    [ctx.siteId, property, property],
  );
  if (avail?.latest_final_date) return { date: clamp(avail.latest_final_date), basis: `Search Console data availability (latest final date, checked ${avail.checked_at})`, fromData: true };
  if (avail?.first_incomplete_date) {
    return { date: clamp(addDays(avail.first_incomplete_date, -1)), basis: `Search Console data availability (day before first incomplete date, checked ${avail.checked_at})`, fromData: true };
  }
  const gsc = ctx.db.get<{ d: string | null }>(
    `SELECT MAX(date) AS d FROM gsc_property_daily_current WHERE site_id = ? AND is_final = 1 AND (? IS NULL OR property = ?)`,
    [ctx.siteId, property, property],
  );
  if (gsc?.d) return { date: clamp(gsc.d), basis: 'latest final Search Console property row', fromData: true };
  const ga4 = ctx.db.get<{ d: string | null }>(`SELECT MAX(date) AS d FROM ga4_landing_daily_current WHERE site_id = ? AND is_complete = 1`, [ctx.siteId]);
  if (ga4?.d) return { date: clamp(ga4.d), basis: 'latest complete GA4 row (no final Search Console data)', fromData: true };
  return { date: addDays(today, -3), basis: `assumption: no complete data found; business-today (${tz}) minus 3 days`, fromData: false };
}

export function lastDayOfMonth(date: IsoDate): IsoDate {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

export function firstDayOfMonth(date: IsoDate): IsoDate {
  return `${date.slice(0, 7)}-01`;
}

function previousMonthRange(start: IsoDate): { start: IsoDate; end: IsoDate } {
  const end = addDays(start, -1);
  return { start: firstDayOfMonth(end), end };
}

export function resolvePeriod(ctx: AppContext, kind: ReportKind, override: PeriodOverride = {}): ReportPeriod {
  const tz = reportTimeZone(ctx);
  const latest = latestCompleteDate(ctx);
  const explicit = !!(override.start || override.end);
  let start: IsoDate;
  let end: IsoDate;
  let comparison: ReportPeriod['comparison'] = null;

  if (explicit) {
    if (!override.start || !override.end) throw new AppError('VALIDATION_FAILED', 'Pass both a period start and end (YYYY-MM-DD).');
    assertIsoDate(override.start);
    assertIsoDate(override.end);
    if (override.start > override.end) throw new AppError('VALIDATION_FAILED', `Period start ${override.start} is after end ${override.end}.`);
    start = override.start;
    end = override.end;
    if (kind === 'monthly' && start === firstDayOfMonth(start) && end === lastDayOfMonth(start)) {
      const p = previousMonthRange(start);
      comparison = { ...p, label: `Month ${p.start.slice(0, 7)}` };
    } else if (kind !== 'baseline') {
      const len = daysBetweenInclusive(start, end);
      comparison = { start: addDays(start, -len), end: addDays(start, -1), label: `Previous ${len} days` };
    }
  } else if (kind === 'weekly') {
    end = latest.date;
    start = addDays(end, -6);
    comparison = { start: addDays(start, -7), end: addDays(start, -1), label: 'Previous 7 days' };
  } else if (kind === 'monthly') {
    const monthEnd = lastDayOfMonth(latest.date);
    end = monthEnd === latest.date ? latest.date : addDays(firstDayOfMonth(latest.date), -1);
    start = firstDayOfMonth(end);
    const p = previousMonthRange(start);
    comparison = { ...p, label: `Month ${p.start.slice(0, 7)}` };
  } else {
    const days = ctx.config.google.gsc.initialHistoryDays;
    end = latest.date;
    start = addDays(end, -(days - 1));
  }

  const label =
    kind === 'monthly' && start === firstDayOfMonth(start) && end === lastDayOfMonth(start)
      ? `Month ${start.slice(0, 7)}`
      : `${kind === 'baseline' ? 'Baseline' : kind === 'weekly' ? 'Week' : 'Period'} ${start} to ${end}`;

  return {
    start,
    end,
    days: daysBetweenInclusive(start, end),
    timeZone: tz,
    timeZoneSource: reportTimeZoneInfo(ctx).source,
    label,
    comparison,
    latestCompleteDate: latest.fromData ? latest.date : null,
    latestCompleteBasis: latest.basis,
    explicit,
  };
}
