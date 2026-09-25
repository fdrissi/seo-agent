import { describe, expect, it } from 'vitest';
import { MICROS_PER_UNIT, addMicros, costPerMillionCeil, formatMoney, formatUsd, fromMicros, mulMicros, toMicros } from '../../../src/core/money.js';

describe('toMicros', () => {
  it.each([
    ['0.0015', 1_500],
    ['12', 12_000_000],
    ['-3.5', -3_500_000],
    ['+1.25', 1_250_000],
    ['.5', 500_000],
    ['5.', 5_000_000],
    ['  7.000001  ', 7_000_001],
    ['0', 0],
    ['0.000000', 0],
  ])('parses decimal string %j exactly', (input, expected) => {
    expect(toMicros(input)).toBe(expected);
  });

  it('parses numbers without floating-point drift', () => {
    expect(toMicros(0.25)).toBe(250_000);
    expect(toMicros(0.1 + 0.2)).toBe(300_000);
    expect(toMicros(1.005)).toBe(1_005_000);
    expect(toMicros(19.99)).toBe(19_990_000);
    expect(toMicros(-0.75)).toBe(-750_000);
  });

  it('rounds the 7th fractional digit half-up, away from zero', () => {
    expect(toMicros('0.0000005')).toBe(1);
    expect(toMicros('0.00000049999')).toBe(0);
    expect(toMicros('1.2345675')).toBe(1_234_568);
    expect(toMicros('1.2345674999')).toBe(1_234_567);
    expect(toMicros('-0.0000005')).toBe(-1);
    expect(toMicros('-1.2345674')).toBe(-1_234_567);
    expect(toMicros('0.9999995')).toBe(1_000_000);
  });

  it('never returns negative zero', () => {
    expect(Object.is(toMicros('-0'), 0)).toBe(true);
    expect(Object.is(toMicros('-0.0000001'), 0)).toBe(true);
  });

  it('accepts the largest safe amount and rejects anything larger', () => {
    expect(toMicros('9007199254.740991')).toBe(Number.MAX_SAFE_INTEGER);
    expect(toMicros('-9007199254.740991')).toBe(-Number.MAX_SAFE_INTEGER);
    expect(() => toMicros('9007199254.740992')).toThrow(RangeError);
    expect(() => toMicros('99999999999')).toThrow(RangeError);
    expect(() => toMicros(1e21)).toThrow(RangeError);
  });

  it.each(['abc', '', '1e5', '1.2.3', '$5', '5 USD', '--1', '1,000'])('rejects malformed amount %j', (input) => {
    expect(() => toMicros(input)).toThrow(RangeError);
  });

  it('rejects non-finite numbers', () => {
    expect(() => toMicros(Number.NaN)).toThrow(RangeError);
    expect(() => toMicros(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('fromMicros / formatting', () => {
  it('renders exact six-digit decimals', () => {
    expect(fromMicros(1_500)).toBe('0.001500');
    expect(fromMicros(-1)).toBe('-0.000001');
    expect(fromMicros(12 * MICROS_PER_UNIT)).toBe('12.000000');
    expect(() => fromMicros(0.5)).toThrow(RangeError);
  });

  it('round-trips through toMicros', () => {
    for (const m of [0, 1, 999_999, 1_000_000, 123_456_789, -42, Number.MAX_SAFE_INTEGER]) expect(toMicros(fromMicros(m))).toBe(m);
  });

  it('formats USD with cents and keeps significant sub-cent digits', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1_230_000)).toBe('$1.23');
    expect(formatUsd(5_000_000)).toBe('$5.00');
    expect(formatUsd(4_200)).toBe('$0.0042');
    expect(formatUsd(1)).toBe('$0.000001');
    expect(formatUsd(-1_500_000)).toBe('-$1.50');
  });

  it('formats unknown amounts as "unknown", never $0', () => {
    expect(formatUsd(null)).toBe('unknown');
    expect(formatUsd(undefined)).toBe('unknown');
    expect(formatMoney(null, 'EUR')).toBe('unknown');
  });

  it('formats other currencies with their code', () => {
    expect(formatMoney(1_230_000, 'EUR')).toBe('1.23 EUR');
    expect(formatMoney(1_000_000, 'EUR')).toBe('1.00 EUR');
    expect(formatMoney(1_234_500, 'GBP')).toBe('1.2345 GBP');
    expect(formatMoney(2_500_000, 'USD')).toBe('$2.50');
  });
});

describe('arithmetic', () => {
  it('adds and multiplies safe integers only', () => {
    expect(addMicros()).toBe(0);
    expect(addMicros(1, 2, 3)).toBe(6);
    expect(() => addMicros(Number.MAX_SAFE_INTEGER, 1)).toThrow(RangeError);
    expect(() => addMicros(1.5)).toThrow(RangeError);
    expect(mulMicros(1_500, 3)).toBe(4_500);
    expect(() => mulMicros(1, 1.5)).toThrow(RangeError);
    expect(() => mulMicros(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError);
  });

  it('costPerMillionCeil rounds UP so reservations are conservative', () => {
    // $0.60 per 1M tokens
    expect(costPerMillionCeil(600_000, 1_500)).toBe(900); // exact
    expect(costPerMillionCeil(600_000, 1)).toBe(1); // 0.6 micro -> 1
    expect(costPerMillionCeil(600_000, 1_666)).toBe(1_000); // 999.6 -> 1000
    expect(costPerMillionCeil(1, 1)).toBe(1);
    expect(costPerMillionCeil(1, 1_000_001)).toBe(2);
    expect(costPerMillionCeil(0, 10_000_000)).toBe(0);
    expect(costPerMillionCeil(15_000_000, 0)).toBe(0);
  });

  it('costPerMillionCeil handles huge products without overflow and rejects unsafe results', () => {
    expect(costPerMillionCeil(15_000_000, 1_000_000_000)).toBe(15_000_000_000);
    expect(costPerMillionCeil(Number.MAX_SAFE_INTEGER, 1_000_000)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => costPerMillionCeil(Number.MAX_SAFE_INTEGER, 2_000_000)).toThrow(RangeError);
  });

  it('costPerMillionCeil ceilings negative adjustments toward zero', () => {
    expect(costPerMillionCeil(-1_500_000, 1)).toBe(-1); // ceil(-1.5)
    expect(costPerMillionCeil(-600_000, 1)).toBe(0); // ceil(-0.6)
  });

  it('costPerMillionCeil validates units', () => {
    expect(() => costPerMillionCeil(600_000, -1)).toThrow(RangeError);
    expect(() => costPerMillionCeil(600_000, 1.5)).toThrow(RangeError);
    expect(() => costPerMillionCeil(0.5, 1)).toThrow(RangeError);
  });
});
