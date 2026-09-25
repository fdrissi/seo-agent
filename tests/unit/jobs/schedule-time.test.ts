import { describe, expect, it } from 'vitest';
import { zonedParts } from '../../../src/core/time.js';
import { dstNotesForCron, findTransitions, zoneOffsetMinutes } from '../../../src/jobs/dst.js';
import { formatInZone, nextRunAfter, nextRuns, parseCron } from '../../../src/jobs/scheduler.js';

const TZ = 'Europe/Tallinn';
const localHour = (d: Date) => zonedParts(d, TZ).hour;

describe('timezone-aware schedules (croner, IANA zones, no hardcoded offsets)', () => {
  it('weekly Monday 07:00 in Europe/Tallinn stays 07:00 local across the October 2026 DST end', () => {
    const runs = nextRuns('0 7 * * 1', TZ, new Date('2026-10-15T00:00:00Z'), 3);
    expect(runs.map((d) => d.toISOString())).toEqual(['2026-10-19T04:00:00.000Z', '2026-10-26T05:00:00.000Z', '2026-11-02T05:00:00.000Z']);
    expect(runs.map(localHour)).toEqual([7, 7, 7]);
    // Exactly one week of wall-clock time is 7 days + 1 hour of elapsed time across the change.
    expect(runs[1]!.getTime() - runs[0]!.getTime()).toBe((7 * 24 + 1) * 3_600_000);
  });

  it('weekly schedule across the March 2027 DST start', () => {
    const runs = nextRuns('0 7 * * 1', TZ, new Date('2027-03-18T00:00:00Z'), 2);
    expect(runs.map((d) => d.toISOString())).toEqual(['2027-03-22T05:00:00.000Z', '2027-03-29T04:00:00.000Z']);
    expect(runs.map(localHour)).toEqual([7, 7]);
  });

  it('monthly schedule and strict next-run semantics', () => {
    expect(nextRunAfter('0 8 2 * *', TZ, new Date('2026-09-24T09:00:00Z'))?.toISOString()).toBe('2026-10-02T05:00:00.000Z');
    expect(nextRunAfter('0 8 2 * *', TZ, new Date('2026-10-02T05:00:00Z'))?.toISOString()).toBe('2026-11-02T06:00:00.000Z');
  });

  it('the same cron in another zone yields different instants (zone is data, not code)', () => {
    const tallinn = nextRunAfter('0 7 * * 1', TZ, new Date('2026-09-24T00:00:00Z'))!;
    const ny = nextRunAfter('0 7 * * 1', 'America/New_York', new Date('2026-09-24T00:00:00Z'))!;
    expect(tallinn.toISOString()).toBe('2026-09-28T04:00:00.000Z');
    expect(ny.toISOString()).toBe('2026-09-28T11:00:00.000Z');
  });

  it('rejects fixed UTC offsets, invalid zones, and non-5-field cron expressions', () => {
    expect(() => parseCron('0 7 * * 1', 'UTC+2')).toThrow(/IANA/);
    expect(() => parseCron('0 7 * * 1', '+03:00')).toThrow(/IANA/);
    expect(() => parseCron('0 7 * * 1', 'Mars/Olympus')).toThrow(/IANA/);
    expect(() => parseCron('0 0 7 * * 1', TZ)).toThrow(/Invalid cron/);
    expect(() => parseCron('every monday', TZ)).toThrow(/Invalid cron/);
    expect(() => parseCron('0 7 * * 1', TZ)).not.toThrow();
  });

  it('reads offsets from the time zone database', () => {
    expect(zoneOffsetMinutes(new Date('2026-07-01T00:00:00Z'), TZ)).toBe(180);
    expect(zoneOffsetMinutes(new Date('2026-12-01T00:00:00Z'), TZ)).toBe(120);
    expect(zoneOffsetMinutes(new Date('2026-12-01T00:00:00Z'), 'UTC')).toBe(0);
    expect(zoneOffsetMinutes(new Date('2026-12-01T00:00:00Z'), 'Asia/Kolkata')).toBe(330);
    expect(zoneOffsetMinutes(new Date('2026-12-01T00:00:00Z'), 'America/St_Johns')).toBe(-210);
  });

  it('finds the Europe/Tallinn transitions with their gap/overlap wall-clock windows', () => {
    const t = findTransitions(TZ, new Date('2026-09-24T00:00:00Z'), new Date('2027-09-24T00:00:00Z'));
    expect(t).toEqual([
      { at: '2026-10-25T01:00:00.000Z', kind: 'overlap', offsetBeforeMinutes: 180, offsetAfterMinutes: 120, localDate: '2026-10-25', wallStart: '03:00', wallEnd: '04:00' },
      { at: '2027-03-28T01:00:00.000Z', kind: 'gap', offsetBeforeMinutes: 120, offsetAfterMinutes: 180, localDate: '2027-03-28', wallStart: '03:00', wallEnd: '04:00' },
    ]);
  });

  it('reports what actually happens to a schedule inside a DST gap or overlap', () => {
    const notes = dstNotesForCron('30 3 * * *', TZ, new Date('2026-09-24T00:00:00Z'));
    const overlap = notes.find((n) => n.kind === 'overlap')!;
    const gap = notes.find((n) => n.kind === 'gap')!;
    expect(overlap).toMatchObject({ localDate: '2026-10-25', wallTime: '03:30', actualRuns: ['2026-10-25T00:30:00.000Z'] });
    expect(overlap.message).toMatch(/fires once/);
    // 03:30 does not exist on 2027-03-28; the run happens exactly once that day (croner shifts it forward by the gap).
    expect(gap).toMatchObject({ localDate: '2027-03-28', wallTime: '03:30', actualRuns: ['2027-03-28T01:30:00.000Z'] });
    expect(localHour(new Date(gap.actualRuns[0]!))).toBe(4);
    // Default weekly/monthly schedules are unaffected.
    expect(dstNotesForCron('0 7 * * 1', TZ, new Date('2026-09-24T00:00:00Z'))).toEqual([]);
    expect(dstNotesForCron('0 8 2 * *', TZ, new Date('2026-09-24T00:00:00Z'))).toEqual([]);
  });

  it('formats instants in the zone with the zone-derived offset label', () => {
    expect(formatInZone(new Date('2026-10-26T05:00:00Z'), TZ)).toBe('Mon 2026-10-26 07:00 GMT+2 (Europe/Tallinn)');
    expect(formatInZone(new Date('2026-10-19T04:00:00Z'), TZ)).toBe('Mon 2026-10-19 07:00 GMT+3 (Europe/Tallinn)');
  });
});
