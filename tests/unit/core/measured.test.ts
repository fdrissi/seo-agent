import { describe, expect, it } from 'vitest';
import { formatMeasured, fromDb, incomplete, isObserved, mapMeasured, missing, observed, unavailable, valueOf } from '../../../src/core/measured.js';

describe('Measured<T>: zero versus missing', () => {
  it('keeps an observed zero distinct from missing', () => {
    const zero = observed(0);
    const none = missing<number>('no rows returned');
    expect(isObserved(zero)).toBe(true);
    expect(valueOf(zero)).toBe(0);
    expect(isObserved(none)).toBe(false);
    expect(valueOf(none)).toBeUndefined();
  });

  it('never substitutes zero for unavailable or incomplete values', () => {
    expect(valueOf(unavailable<number>('GA4 not connected'))).toBeUndefined();
    expect(valueOf(incomplete<number>('partial day', 12))).toBeUndefined();
  });

  it('incomplete keeps an optional partial value', () => {
    expect(incomplete('x')).toEqual({ status: 'incomplete', reason: 'x' });
    expect(incomplete('x', 0)).toEqual({ status: 'incomplete', reason: 'x', partialValue: 0 });
  });

  it('mapMeasured transforms observed and partial values and passes statuses through', () => {
    expect(mapMeasured(observed(2), (v) => v * 10)).toEqual({ status: 'observed', value: 20 });
    expect(mapMeasured(incomplete('p', 3), (v) => v + 1)).toEqual({ status: 'incomplete', reason: 'p', partialValue: 4 });
    expect(mapMeasured(incomplete<number>('p'), (v) => v + 1)).toEqual({ status: 'incomplete', reason: 'p' });
    expect(mapMeasured(missing<number>('m'), (v) => v + 1)).toEqual({ status: 'missing', reason: 'm' });
    expect(mapMeasured(unavailable<number>('u'), (v) => v + 1)).toEqual({ status: 'unavailable', reason: 'u' });
  });

  it('formats each state honestly', () => {
    expect(formatMeasured(observed(0))).toBe('0');
    expect(formatMeasured(missing('not synced'))).toBe('missing (not synced)');
    expect(formatMeasured(unavailable('no access'))).toBe('DATA UNAVAILABLE (no access)');
    expect(formatMeasured(incomplete('today'))).toBe('incomplete (today)');
    expect(formatMeasured(incomplete('today', 5), (v) => `${v} clicks`)).toBe('5 clicks (incomplete: today)');
  });

  it('fromDb maps nullable columns and status columns without inventing zeros', () => {
    expect(fromDb(0, 'observed')).toEqual({ status: 'observed', value: 0 });
    expect(fromDb(0, null)).toEqual({ status: 'observed', value: 0 });
    expect(fromDb(null, null)).toEqual({ status: 'missing', reason: 'not recorded' });
    expect(fromDb(undefined, undefined, 'why')).toEqual({ status: 'missing', reason: 'why' });
    expect(fromDb(null, 'observed')).toEqual({ status: 'missing', reason: 'not recorded' });
    expect(fromDb(null, 'unavailable', 'no permission')).toEqual({ status: 'unavailable', reason: 'no permission' });
    expect(fromDb(7, 'incomplete', 'partial')).toEqual({ status: 'incomplete', reason: 'partial', partialValue: 7 });
    expect(fromDb(null, 'incomplete', 'partial')).toEqual({ status: 'incomplete', reason: 'partial' });
  });
});
