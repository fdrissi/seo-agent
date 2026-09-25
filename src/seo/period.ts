import { addDays, daysBetweenInclusive, type IsoDate } from '../core/time.js';
import type { Db } from '../database/db.js';
import type { Period } from './metrics.js';

/** Resolve which Search Console property to analyse: configured, else the only one present in the data. */
export function resolveGscProperty(db: Db, siteId: string, configured: string | null): { property: string; basis: 'config' | 'data' } | { property: null; reason: string } {
  if (configured) return { property: configured, basis: 'config' };
  const props = db.all<{ property: string }>(
    'SELECT DISTINCT property FROM gsc_page_daily WHERE site_id = ? UNION SELECT DISTINCT property FROM gsc_property_daily WHERE site_id = ?',
    [siteId, siteId],
  );
  if (props.length === 1) return { property: props[0]!.property, basis: 'data' };
  if (props.length === 0) return { property: null, reason: 'no Search Console property configured and no Search Console data ingested' };
  return { property: null, reason: `several Search Console properties have data (${props.map((p) => p.property).join(', ')}); set google.searchConsoleProperty` };
}

export function resolveGa4Property(db: Db, siteId: string, configured: string | null): { propertyId: string; basis: 'config' | 'data' } | { propertyId: null; reason: string } {
  if (configured) return { propertyId: configured, basis: 'config' };
  const props = db.all<{ property_id: string }>('SELECT DISTINCT property_id FROM ga4_landing_daily WHERE site_id = ?', [siteId]);
  if (props.length === 1) return { propertyId: props[0]!.property_id, basis: 'data' };
  if (props.length === 0) return { propertyId: null, reason: 'no GA4 property configured and no GA4 data ingested' };
  return { propertyId: null, reason: `several GA4 properties have data (${props.map((p) => p.property_id).join(', ')}); set google.ga4PropertyId` };
}

/** Latest date whose Search Console data is final (from rows or reported availability). */
export function latestFinalGscDate(db: Db, siteId: string, property: string, searchType: string): IsoDate | null {
  const r = db.get<{ d: string | null }>(
    `SELECT MAX(d) AS d FROM (
       SELECT MAX(date) AS d FROM gsc_property_daily WHERE site_id = ? AND property = ? AND search_type = ? AND is_current = 1 AND is_final = 1
       UNION ALL SELECT MAX(date) FROM gsc_page_daily WHERE site_id = ? AND property = ? AND search_type = ? AND is_current = 1 AND is_final = 1
       UNION ALL SELECT MAX(latest_final_date) FROM gsc_data_availability WHERE site_id = ? AND property = ? AND search_type = ?)`,
    [siteId, property, searchType, siteId, property, searchType, siteId, property, searchType],
  );
  return r?.d ?? null;
}

/** Latest GA4 date whose rows are all complete. */
export function latestCompleteGa4Date(db: Db, siteId: string, propertyId: string): IsoDate | null {
  const r = db.get<{ d: string | null }>(
    `SELECT MAX(date) AS d FROM (SELECT date, MIN(is_complete) AS c FROM ga4_landing_daily WHERE site_id = ? AND property_id = ? AND is_current = 1 GROUP BY date) WHERE c = 1`,
    [siteId, propertyId],
  );
  return r?.d ?? null;
}

export function windowEnding(end: IsoDate, days: number): Period {
  if (!Number.isInteger(days) || days < 1) throw new RangeError(`days must be a positive integer: ${days}`);
  return { start: addDays(end, -(days - 1)), end };
}

/** The immediately preceding window of the same length (weekday-aligned when the length is a multiple of 7). */
export function previousWindow(p: Period): Period {
  const len = daysBetweenInclusive(p.start, p.end);
  return { start: addDays(p.start, -len), end: addDays(p.start, -1) };
}

export interface AnalysisPeriod {
  period: Period;
  previous: Period;
  basis: string;
  weekdayAligned: boolean;
}

/**
 * Default analysis window: `days` days ending at the latest date that is final
 * in Search Console AND complete in GA4 (when GA4 is available), so incomplete
 * current dates are never compared with completed periods.
 */
export function defaultAnalysisPeriod(
  db: Db,
  siteId: string,
  opts: { gscProperty: string | null; searchType: string; ga4PropertyId: string | null; days: number; end?: IsoDate | null; today: IsoDate },
): AnalysisPeriod {
  let end = opts.end ?? null;
  let basis: string;
  if (end) basis = 'explicit end date';
  else {
    const g = opts.gscProperty ? latestFinalGscDate(db, siteId, opts.gscProperty, opts.searchType) : null;
    const a = opts.ga4PropertyId ? latestCompleteGa4Date(db, siteId, opts.ga4PropertyId) : null;
    if (g && a) {
      end = g < a ? g : a;
      basis = `latest date final in Search Console (${g}) and complete in GA4 (${a})`;
    } else if (g) {
      end = g;
      basis = `latest final Search Console date (${g})`;
    } else if (a) {
      end = a;
      basis = `latest complete GA4 date (${a})`;
    } else {
      end = addDays(opts.today, -3);
      basis = 'no final data found; defaulted to today minus 3 days (Search Console data is typically final after 2-3 days)';
    }
  }
  const period = windowEnding(end, opts.days);
  return { period, previous: previousWindow(period), basis, weekdayAligned: opts.days % 7 === 0 };
}
