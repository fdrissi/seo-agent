/**
 * Money is stored as integer micro-units (1 USD = 1_000_000 micros) to avoid
 * floating point comparison errors. API costs are always USD micros; revenue
 * keeps its source-reported currency separately.
 *
 * Unknown cost is represented as `null` at the boundary and must never be
 * converted to 0.
 */

export type Micros = number;

export const MICROS_PER_UNIT = 1_000_000;

function assertSafe(n: number, label: string): void {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${label} is not a safe integer micro amount: ${n}`);
}

/**
 * Parse a decimal amount ("0.0015", "12", "-3.5", 0.25) into integer micros
 * using string arithmetic (no floating point accumulation). Values with more
 * than 6 fractional digits are rounded half-up (away from zero) to 6 digits.
 */
export function toMicros(amount: string | number): Micros {
  let s = typeof amount === 'number' ? numberToPlainString(amount) : amount.trim();
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(s)) throw new RangeError(`Invalid decimal amount: ${String(amount)}`);
  let sign = 1;
  if (s.startsWith('-')) {
    sign = -1;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  const [intPart = '0', fracRaw = ''] = s.split('.');
  const frac = (fracRaw + '0000000').slice(0, 7);
  let micros = Number(intPart || '0') * MICROS_PER_UNIT + Number(frac.slice(0, 6));
  if (Number(frac[6]) >= 5) micros += 1;
  const result = sign * micros;
  assertSafe(result, 'amount');
  return result === 0 ? 0 : result;
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`Invalid amount: ${n}`);
  // toFixed(9) avoids exponent notation for realistic prices and keeps enough precision to round.
  return n.toFixed(9);
}

export function fromMicros(micros: Micros): string {
  assertSafe(micros, 'micros');
  const sign = micros < 0 ? '-' : '';
  const abs = Math.abs(micros);
  const intPart = Math.floor(abs / MICROS_PER_UNIT);
  const frac = String(abs % MICROS_PER_UNIT).padStart(6, '0');
  return `${sign}${intPart}.${frac}`;
}

/** Format for humans, e.g. "$1.23" or "$0.0042" (keeps significant sub-cent digits). */
export function formatUsd(micros: Micros | null | undefined): string {
  if (micros === null || micros === undefined) return 'unknown';
  const s = fromMicros(micros);
  const [i, f = ''] = s.split('.');
  const trimmed = f.replace(/0+$/, '');
  const frac = trimmed.length <= 2 ? trimmed.padEnd(2, '0') : trimmed;
  return `${i!.startsWith('-') ? '-' : ''}$${i!.replace('-', '')}.${frac}`;
}

export function formatMoney(micros: Micros | null | undefined, currency: string): string {
  if (micros === null || micros === undefined) return 'unknown';
  if (currency === 'USD') return formatUsd(micros);
  return `${fromMicros(micros).replace(/(\.\d{2}\d*?)0+$/, '$1')} ${currency}`;
}

export function addMicros(...values: Micros[]): Micros {
  let total = 0;
  for (const v of values) {
    assertSafe(v, 'addend');
    total += v;
  }
  assertSafe(total, 'sum');
  return total;
}

/** Multiply a micro price by an integer quantity (e.g. tokens, items). */
export function mulMicros(unitMicros: Micros, quantity: number): Micros {
  assertSafe(unitMicros, 'unit price');
  if (!Number.isSafeInteger(quantity)) throw new RangeError(`quantity must be an integer: ${quantity}`);
  const r = unitMicros * quantity;
  assertSafe(r, 'product');
  return r;
}

/**
 * Price per 1M units (e.g. USD per 1M tokens) times a unit count, rounded UP
 * so budget reservations are conservative upper bounds.
 */
export function costPerMillionCeil(pricePerMillionMicros: Micros, units: number): Micros {
  assertSafe(pricePerMillionMicros, 'price');
  if (!Number.isSafeInteger(units) || units < 0) throw new RangeError(`units must be a non-negative integer: ${units}`);
  // (price * units) / 1e6 rounded up, using BigInt to avoid overflow.
  const num = BigInt(pricePerMillionMicros) * BigInt(units);
  const q = num / 1_000_000n; // BigInt division truncates toward zero
  const r = num % 1_000_000n;
  // Ceiling: only a positive remainder rounds up (a truncated negative is already the ceiling).
  const out = Number(r > 0n ? q + 1n : q);
  assertSafe(out, 'cost');
  return out;
}
