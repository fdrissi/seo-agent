import { describe, expect, it } from 'vitest';
import { computeWindows, weekdayCounts, weekdaysMatch, trailingWeeks } from '../../../src/experiments/windows.js';
import { weekdayOf } from '../../../src/core/time.js';

describe('weekday-matched measurement windows', () => {
  it('builds equal-length whole-week windows around the implementation date, excluding that date', () => {
    const r = computeWindows({ implementedAt: '2026-06-10T15:00:00Z', timeZone: 'America/Los_Angeles', latestCompleteDate: '2026-07-20' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = r.windows;
    expect(w.implementationDate).toBe('2026-06-10');
    expect(w.observation.start).toBe('2026-06-11');
    expect(w.baseline.end).toBe('2026-06-09');
    expect(w.baseline.days).toBe(w.observation.days);
    expect(w.observation.days % 7).toBe(0);
    expect(w.observation.days).toBe(35); // 40 available days floored to 5 weeks
    expect(w.availableObservationDays).toBe(40);
    expect(w.weekdayMatched).toBe(true);
    expect(weekdayCounts(w.baseline)).toEqual(weekdayCounts(w.observation));
    // Whole weeks: every weekday occurs exactly length/7 times in each window.
    expect(weekdayCounts(w.observation)).toEqual([5, 5, 5, 5, 5, 5, 5]);
    expect(weekdayOf(w.observation.end)).toBe((weekdayOf(w.observation.start) + 6) % 7);
  });

  it('uses the data source time zone for the implementation date (never a fixed offset)', () => {
    // 2026-06-10T05:00Z is still June 9 in Los Angeles but June 10 in Tallinn.
    const la = computeWindows({ implementedAt: '2026-06-10T05:00:00Z', timeZone: 'America/Los_Angeles', latestCompleteDate: '2026-07-30' });
    const tl = computeWindows({ implementedAt: '2026-06-10T05:00:00Z', timeZone: 'Europe/Tallinn', latestCompleteDate: '2026-07-30' });
    expect(la.ok && la.windows.implementationDate).toBe('2026-06-09');
    expect(tl.ok && tl.windows.implementationDate).toBe('2026-06-10');
  });

  it('reports honestly when there is not yet a full week of complete data', () => {
    const none = computeWindows({ implementedAt: '2026-06-10T15:00:00Z', timeZone: 'UTC', latestCompleteDate: '2026-06-10' });
    expect(none).toMatchObject({ ok: false, reason: 'no_complete_data_after_implementation', availableObservationDays: 0 });
    const short = computeWindows({ implementedAt: '2026-06-10T15:00:00Z', timeZone: 'UTC', latestCompleteDate: '2026-06-15' });
    expect(short).toMatchObject({ ok: false, reason: 'less_than_one_week', availableObservationDays: 5 });
    const missing = computeWindows({ implementedAt: '2026-06-10T15:00:00Z', timeZone: 'UTC', latestCompleteDate: null });
    expect(missing.ok).toBe(false);
  });

  it('caps the window at the maximum observation length', () => {
    const r = computeWindows({ implementedAt: '2026-01-10T12:00:00Z', timeZone: 'UTC', latestCompleteDate: '2026-09-01', maxDays: 60 });
    expect(r.ok && r.windows.observation.days).toBe(56);
  });

  it('with a minimum that is not a multiple of 7, returns less_than_min until the whole-week window reaches it', () => {
    // Implementation 2026-06-10 (UTC): observation starts 2026-06-11.
    const at = (latest: string) => computeWindows({ implementedAt: '2026-06-10T15:00:00Z', timeZone: 'UTC', latestCompleteDate: latest, minDays: 10 });
    // 10 complete days: the day count "reaches" 10, but the whole-week window would only be 7 days.
    expect(at('2026-06-20')).toMatchObject({ ok: false, reason: 'less_than_min', availableObservationDays: 10, minDays: 10 });
    expect(at('2026-06-23')).toMatchObject({ ok: false, reason: 'less_than_min', availableObservationDays: 13 });
    const ok = at('2026-06-24');
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.windows.observation.days).toBe(14);
      expect(ok.windows.observation.days).toBeGreaterThanOrEqual(10);
      expect(ok.windows.weekdayMatched).toBe(true);
    }
    // A 30-day minimum is satisfied only by a 35-day window.
    const m30 = (latest: string) => computeWindows({ implementedAt: '2026-06-10T15:00:00Z', timeZone: 'UTC', latestCompleteDate: latest, minDays: 30 });
    expect(m30('2026-07-12')).toMatchObject({ ok: false, reason: 'less_than_min', availableObservationDays: 32 });
    expect(m30('2026-07-15').ok && (m30('2026-07-15') as { windows: { observation: { days: number } } }).windows.observation.days).toBe(35);
    // Without minDays the old behavior is unchanged (backward compatible).
    expect(computeWindows({ implementedAt: '2026-06-10T15:00:00Z', timeZone: 'UTC', latestCompleteDate: '2026-06-20' })).toMatchObject({ ok: true });
  });

  it('detects non-matching weekday composition', () => {
    expect(weekdaysMatch({ start: '2026-06-01', end: '2026-06-07' }, { start: '2026-06-08', end: '2026-06-14' })).toBe(true);
    expect(weekdaysMatch({ start: '2026-06-01', end: '2026-06-05' }, { start: '2026-06-06', end: '2026-06-10' })).toBe(false);
    expect(trailingWeeks('2026-06-28', 4)).toEqual({ start: '2026-06-01', end: '2026-06-28', days: 28 });
  });
});
