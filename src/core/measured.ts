/**
 * Missing, unavailable, incomplete, and actual zero are different states.
 * `Measured<T>` makes that distinction explicit in types so a missing value
 * can never silently become 0.
 */

export type MeasurementStatus = 'observed' | 'missing' | 'unavailable' | 'incomplete';

export type Measured<T> =
  | { status: 'observed'; value: T }
  | { status: 'missing'; reason: string }
  | { status: 'unavailable'; reason: string }
  | { status: 'incomplete'; reason: string; partialValue?: T };

export const observed = <T>(value: T): Measured<T> => ({ status: 'observed', value });
export const missing = <T = never>(reason: string): Measured<T> => ({ status: 'missing', reason });
export const unavailable = <T = never>(reason: string): Measured<T> => ({ status: 'unavailable', reason });
export const incomplete = <T>(reason: string, partialValue?: T): Measured<T> =>
  partialValue === undefined ? { status: 'incomplete', reason } : { status: 'incomplete', reason, partialValue };

export function isObserved<T>(m: Measured<T>): m is { status: 'observed'; value: T } {
  return m.status === 'observed';
}

/** Returns the observed value or undefined. Never substitutes zero. */
export function valueOf<T>(m: Measured<T>): T | undefined {
  return m.status === 'observed' ? m.value : undefined;
}

export function mapMeasured<T, U>(m: Measured<T>, fn: (v: T) => U): Measured<U> {
  if (m.status === 'observed') return { status: 'observed', value: fn(m.value) };
  if (m.status === 'incomplete') {
    return m.partialValue === undefined
      ? { status: 'incomplete', reason: m.reason }
      : { status: 'incomplete', reason: m.reason, partialValue: fn(m.partialValue) };
  }
  return m;
}

/** Human-readable rendering used by reports. */
export function formatMeasured<T>(m: Measured<T>, fmt: (v: T) => string = String): string {
  switch (m.status) {
    case 'observed':
      return fmt(m.value);
    case 'missing':
      return `missing (${m.reason})`;
    case 'unavailable':
      return `DATA UNAVAILABLE (${m.reason})`;
    case 'incomplete':
      return m.partialValue === undefined ? `incomplete (${m.reason})` : `${fmt(m.partialValue)} (incomplete: ${m.reason})`;
  }
}

/** Convert a nullable DB value plus a status column into a Measured value. */
export function fromDb<T>(value: T | null | undefined, status: string | null | undefined, reason = 'not recorded'): Measured<T> {
  const s = (status ?? (value === null || value === undefined ? 'missing' : 'observed')) as MeasurementStatus;
  if (s === 'observed') {
    if (value === null || value === undefined) return { status: 'missing', reason };
    return { status: 'observed', value };
  }
  if (s === 'incomplete') return value === null || value === undefined ? { status: 'incomplete', reason } : { status: 'incomplete', reason, partialValue: value };
  return { status: s, reason };
}
