import { describe, expect, it } from 'vitest';
import {
  addDays,
  assertIsoDate,
  compareDates,
  dateInZone,
  daysBetweenInclusive,
  eachDate,
  isIsoDate,
  isValidTimeZone,
  isoWeekKey,
  monthKey,
  weekdayOf,
  zonedParts,
} from '../../../src/core/time.js';

const at = (iso: string) => new Date(iso);

describe('IANA time zones', () => {
  it('accepts IANA names and rejects raw offsets and junk', () => {
    for (const tz of ['Europe/Tallinn', 'America/Los_Angeles', 'UTC', 'Asia/Kolkata']) expect(isValidTimeZone(tz)).toBe(true);
    for (const tz of ['+02:00', '-0800', '+3', 'Mars/Olympus_Mons', '', '  ']) expect(isValidTimeZone(tz)).toBe(false);
  });
});

describe('dateInZone across daylight-saving transitions', () => {
  it('Europe/Tallinn: autumn fall-back (2026-10-25, 04:00 EEST -> 03:00 EET)', () => {
    expect(dateInZone(at('2026-10-24T20:59:59Z'), 'Europe/Tallinn')).toBe('2026-10-24'); // 23:59:59 EEST
    expect(dateInZone(at('2026-10-24T21:00:00Z'), 'Europe/Tallinn')).toBe('2026-10-25'); // 00:00 EEST
    expect(dateInZone(at('2026-10-25T21:59:59Z'), 'Europe/Tallinn')).toBe('2026-10-25'); // 23:59:59 EET
    expect(dateInZone(at('2026-10-25T22:00:00Z'), 'Europe/Tallinn')).toBe('2026-10-26'); // 00:00 EET
  });

  it('Europe/Tallinn: spring-forward (2026-03-29, 03:00 EET -> 04:00 EEST)', () => {
    expect(dateInZone(at('2026-03-28T21:59:59Z'), 'Europe/Tallinn')).toBe('2026-03-28');
    expect(dateInZone(at('2026-03-28T22:00:00Z'), 'Europe/Tallinn')).toBe('2026-03-29');
    expect(dateInZone(at('2026-03-29T20:59:59Z'), 'Europe/Tallinn')).toBe('2026-03-29');
    expect(dateInZone(at('2026-03-29T21:00:00Z'), 'Europe/Tallinn')).toBe('2026-03-30');
  });

  it('America/Los_Angeles: spring-forward (2026-03-08) and fall-back (2026-11-01)', () => {
    expect(dateInZone(at('2026-03-08T07:59:59Z'), 'America/Los_Angeles')).toBe('2026-03-07'); // PST
    expect(dateInZone(at('2026-03-08T08:00:00Z'), 'America/Los_Angeles')).toBe('2026-03-08');
    expect(dateInZone(at('2026-03-09T06:59:59Z'), 'America/Los_Angeles')).toBe('2026-03-08'); // PDT
    expect(dateInZone(at('2026-03-09T07:00:00Z'), 'America/Los_Angeles')).toBe('2026-03-09');
    expect(dateInZone(at('2026-11-01T06:59:59Z'), 'America/Los_Angeles')).toBe('2026-10-31'); // PDT
    expect(dateInZone(at('2026-11-01T07:00:00Z'), 'America/Los_Angeles')).toBe('2026-11-01');
    expect(dateInZone(at('2026-11-02T07:59:59Z'), 'America/Los_Angeles')).toBe('2026-11-01'); // PST
    expect(dateInZone(at('2026-11-02T08:00:00Z'), 'America/Los_Angeles')).toBe('2026-11-02');
  });

  it('the same instant can be different calendar dates in different zones', () => {
    const instant = at('2026-09-24T23:30:00Z');
    expect(dateInZone(instant, 'Europe/Tallinn')).toBe('2026-09-25');
    expect(dateInZone(instant, 'America/Los_Angeles')).toBe('2026-09-24');
    expect(dateInZone(instant, 'UTC')).toBe('2026-09-24');
  });

  it('zonedParts reports the repeated wall-clock hour on fall-back', () => {
    // 03:30 occurs twice in Tallinn on 2026-10-25 (EEST then EET).
    expect(zonedParts(at('2026-10-25T00:30:00Z'), 'Europe/Tallinn')).toMatchObject({ year: 2026, month: 10, day: 25, hour: 3, minute: 30, weekday: 0 });
    expect(zonedParts(at('2026-10-25T01:30:00Z'), 'Europe/Tallinn')).toMatchObject({ day: 25, hour: 3, minute: 30 });
    // Midnight is hour 0 (h23), not 24.
    expect(zonedParts(at('2026-09-24T21:00:00Z'), 'Europe/Tallinn')).toMatchObject({ day: 25, hour: 0, weekday: 5 });
  });
});

describe('budget period keys', () => {
  it('monthKey follows the zone at month boundaries', () => {
    const instant = at('2026-01-31T22:30:00Z');
    expect(monthKey(instant, 'Europe/Tallinn')).toBe('2026-02');
    expect(monthKey(instant, 'America/Los_Angeles')).toBe('2026-01');
  });

  it.each([
    ['2020-12-31', '2020-W53'],
    ['2021-01-01', '2020-W53'],
    ['2021-01-03', '2020-W53'],
    ['2021-01-04', '2021-W01'],
    ['2024-12-29', '2024-W52'],
    ['2024-12-30', '2025-W01'],
    ['2025-12-28', '2025-W52'],
    ['2025-12-29', '2026-W01'],
    ['2026-01-01', '2026-W01'],
    ['2026-09-24', '2026-W39'],
    ['2026-12-31', '2026-W53'],
    ['2027-01-03', '2026-W53'],
    ['2027-01-04', '2027-W01'],
    ['2008-12-29', '2009-W01'],
  ])('isoWeekKey(%s) = %s at year boundaries', (date, key) => {
    expect(isoWeekKey(at(`${date}T12:00:00Z`), 'UTC')).toBe(key);
  });

  it('isoWeekKey uses the local date of the zone (Sunday night vs Monday morning)', () => {
    const instant = at('2027-01-03T22:30:00Z');
    expect(isoWeekKey(instant, 'Europe/Tallinn')).toBe('2027-W01'); // Monday 00:30 local
    expect(isoWeekKey(instant, 'America/Los_Angeles')).toBe('2026-W53'); // Sunday 14:30 local
  });
});

describe('calendar date arithmetic', () => {
  it('addDays handles month/year ends and leap years', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29'); // DST day is still one calendar day
    expect(addDays('2026-09-24', 0)).toBe('2026-09-24');
    expect(addDays('2026-09-24', -365)).toBe('2025-09-24');
  });

  it('rejects impossible or malformed dates', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError);
    expect(() => addDays('2026-13-01', 1)).toThrow(RangeError);
    expect(() => addDays('2026-9-1', 1)).toThrow(RangeError);
    expect(() => assertIsoDate('2025-02-29')).toThrow(RangeError);
    expect(() => assertIsoDate('2024-02-29')).not.toThrow();
    expect(isIsoDate('2026-04-31')).toBe(false);
    expect(isIsoDate('2026-04-30')).toBe(true);
    expect(isIsoDate(20260430)).toBe(false);
  });

  it('counts, enumerates, compares, and names weekdays', () => {
    expect(daysBetweenInclusive('2026-01-01', '2026-01-31')).toBe(31);
    expect(daysBetweenInclusive('2026-03-01', '2026-03-31')).toBe(31);
    expect(daysBetweenInclusive('2026-09-24', '2026-09-24')).toBe(1);
    expect(eachDate('2026-02-27', '2026-03-02')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
    expect(eachDate('2026-03-02', '2026-02-27')).toEqual([]);
    expect(compareDates('2026-01-01', '2026-01-02')).toBe(-1);
    expect(compareDates('2026-01-02', '2026-01-01')).toBe(1);
    expect(compareDates('2026-01-01', '2026-01-01')).toBe(0);
    expect(weekdayOf('2026-09-24')).toBe(4); // Thursday
    expect(weekdayOf('2026-09-27')).toBe(0); // Sunday
  });
});
