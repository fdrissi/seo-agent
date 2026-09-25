/**
 * Date helpers that respect IANA time zones (never hardcoded UTC offsets).
 * Calendar dates are represented as 'YYYY-MM-DD' strings in an explicit zone.
 */

export type IsoDate = string; // YYYY-MM-DD

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDate(d: string): asserts d is IsoDate {
  if (!isIsoDate(d)) throw new RangeError(`Invalid ISO date: ${d}`);
}

/**
 * True for a real calendar date in 'YYYY-MM-DD' form. `Date.parse` silently
 * rolls impossible dates over (2026-02-30 -> 2026-03-02), so the parsed value
 * is round-tripped and compared.
 */
export function isIsoDate(d: unknown): d is IsoDate {
  if (typeof d !== 'string' || !DATE_RE.test(d)) return false;
  const ms = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === d;
}

/**
 * True for IANA time zone names (e.g. "Europe/Tallinn", "UTC"). Raw UTC
 * offsets such as "+02:00" are rejected even though Intl accepts them: fixed
 * offsets ignore daylight-saving changes.
 */
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || !tz.trim() || /^[+-−]?\d/.test(tz.trim())) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Calendar date of an instant as observed in the given IANA zone. */
export function dateInZone(instant: Date, timeZone: string): IsoDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Wall-clock components of an instant in a zone. */
export function zonedParts(instant: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: weekdays.indexOf(get('weekday')),
  };
}

export function addDays(date: IsoDate, days: number): IsoDate {
  assertIsoDate(date);
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Inclusive number of calendar days between two dates. */
export function daysBetweenInclusive(start: IsoDate, end: IsoDate): number {
  assertIsoDate(start);
  assertIsoDate(end);
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

export function eachDate(start: IsoDate, end: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 0 = Sunday ... 6 = Saturday for a calendar date. */
export function weekdayOf(date: IsoDate): number {
  assertIsoDate(date);
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function compareDates(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Month key 'YYYY-MM' for the instant in the zone (budget periods). */
export function monthKey(instant: Date, timeZone: string): string {
  return dateInZone(instant, timeZone).slice(0, 7);
}

/** ISO week key 'YYYY-Www' for the instant in the zone (budget periods). */
export function isoWeekKey(instant: Date, timeZone: string): string {
  const local = dateInZone(instant, timeZone);
  const d = new Date(`${local}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
