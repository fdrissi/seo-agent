import { describe, expect, it } from 'vitest';
import {
  chargeFromEventCounts,
  chargeRangeFromEventCounts,
  estimateRunCost,
  eventCountsInconsistency,
  microsToUsdParam,
  parsePricingRecord,
  reportedUsageInconsistency,
  selectCurrentPricing,
} from '../../../src/integrations/apify/pricing.js';
import { fixtureActor } from '../../fixtures/apify/fake-apify.js';

const now = new Date('2026-09-24T09:00:00Z');
const current = () => selectCurrentPricing(fixtureActor().pricingInfos, now)!;

describe('apify pricing', () => {
  it('selects the record with the latest startedAt <= now (ignores future and older records)', () => {
    const p = current();
    expect(p.startedAt).toBe('2026-08-10T14:51:28.574Z');
    expect(p.pricingModel).toBe('PAY_PER_EVENT');
    expect(p.events?.map((e) => e.key).sort()).toEqual(['analyzed_item', 'custom_label', 'init', 'result']);
    expect(selectCurrentPricing(fixtureActor().pricingInfos, new Date('2027-02-01T00:00:00Z'))!.startedAt).toBe('2027-01-01T00:00:00.000Z');
    expect(selectCurrentPricing(fixtureActor().pricingInfos, new Date('2025-01-01T00:00:00Z'))).toBeNull();
  });

  it('estimates conservatively: highest tier, per-GB init, disabled AI events at 0', () => {
    const e = estimateRunCost(current(), { maxResults: 30, memoryMbytes: 1024, disabledEvents: new Set(['analyzed_item', 'custom_label']) });
    // init $0.02 x 1 GB + result $0.002 (FREE tier, highest) x 30
    expect(e.upperBoundMicros).toBe(20_000 + 60_000);
    expect(e.basis.source).toBe('provider_api');
    expect(e.lines.find((l) => l.event === 'analyzed_item')?.units).toBe(0);
    const big = estimateRunCost(current(), { maxResults: 30, memoryMbytes: 2048, disabledEvents: new Set(['analyzed_item', 'custom_label']) });
    expect(big.upperBoundMicros).toBe(40_000 + 60_000);
    // Cost terms used to fit bounds under a cap and to detect cap-stopped runs.
    expect(e.terms).toEqual({ fixedMicros: 20_000, perResultMaxMicros: 2_000, perResultMinMicros: 1_500 });
    expect(estimateRunCost(null, { maxResults: 1, memoryMbytes: 512, disabledEvents: new Set() }).terms).toBeNull();
  });

  it('does not assume an item limit bounds charges of events it cannot rule out', () => {
    const e = estimateRunCost(current(), { maxResults: 100, memoryMbytes: 512, disabledEvents: new Set() });
    // AI events not disabled -> counted once per possible result.
    expect(e.upperBoundMicros).toBe(20_000 + 100 * 2_000 + 100 * 500 + 100 * 100);
    const withUnknown = parsePricingRecord({
      pricingModel: 'PAY_PER_EVENT',
      startedAt: '2026-01-01T00:00:00Z',
      pricingPerEvent: { actorChargeEvents: { result: { eventPriceUsd: 0.001, isPrimaryEvent: true }, surprise_event: { eventPriceUsd: 0.01 } } },
    });
    const u = estimateRunCost(withUnknown, { maxResults: 10, memoryMbytes: 512, disabledEvents: new Set() });
    expect(u.upperBoundMicros).toBe(10 * 1_000 + 10 * 10_000);
    expect(u.warnings.join(' ')).toMatch(/surprise_event/);
  });

  it('returns an unknown estimate (null, never $0) when pricing is missing or unsupported', () => {
    expect(estimateRunCost(null, { maxResults: 1, memoryMbytes: 512, disabledEvents: new Set() }).upperBoundMicros).toBeNull();
    const flat = parsePricingRecord({ pricingModel: 'FLAT_PRICE_PER_MONTH', startedAt: '2026-01-01T00:00:00Z' });
    const e = estimateRunCost(flat, { maxResults: 1, memoryMbytes: 512, disabledEvents: new Set() });
    expect(e.upperBoundMicros).toBeNull();
    expect(e.basis.source).toBe('unknown');
    const noEvents = parsePricingRecord({ pricingModel: 'PAY_PER_EVENT', startedAt: '2026-01-01T00:00:00Z', pricingPerEvent: {} });
    expect(estimateRunCost(noEvents, { maxResults: 1, memoryMbytes: 512, disabledEvents: new Set() }).upperBoundMicros).toBeNull();
  });

  it('computes charges from event counts only when every charged event has a flat price', () => {
    expect(chargeFromEventCounts(current(), { init: 1, result: 10 })).toBeNull(); // result is tiered: tier unknown
    expect(chargeFromEventCounts(current(), { init: 1 })).toBe(20_000);
    expect(chargeFromEventCounts(current(), { init: 1, result: 0 })).toBe(20_000);
    expect(chargeFromEventCounts(current(), { mystery: 1 })).toBeNull();
    expect(chargeFromEventCounts(current(), null)).toBeNull();
  });

  it('never turns empty, preliminary, or contradictory event counts into $0', () => {
    const flat = parsePricingRecord({
      pricingModel: 'PAY_PER_EVENT',
      startedAt: '2026-01-01T00:00:00Z',
      pricingPerEvent: { actorChargeEvents: { init: { eventPriceUsd: 0.02, isOneTimeEvent: true }, result: { eventPriceUsd: 0.002, isPrimaryEvent: true } } },
    });
    expect(chargeFromEventCounts(flat, {})).toBeNull();
    expect(eventCountsInconsistency(flat, {})).toMatch(/empty/);
    expect(chargeFromEventCounts(flat, { init: 0, result: 0 }, { started: true })).toBeNull();
    expect(chargeFromEventCounts(flat, { result: 14 }, { started: true, resultItems: 14 })).toBeNull(); // init missing
    expect(eventCountsInconsistency(flat, { result: 14 }, { started: true })).toMatch(/one-time event "init"/);
    expect(chargeFromEventCounts(flat, { init: 1, result: 3 }, { started: true, resultItems: 14 })).toBeNull(); // fewer results than fetched
    expect(eventCountsInconsistency(flat, { init: 1, result: 3 }, { resultItems: 14 })).toMatch(/below the 14 result/);
    expect(chargeFromEventCounts(flat, { init: 1, result: 14 }, { started: true, resultItems: 14 })).toBe(20_000 + 14 * 2_000);
  });

  it('flags provider-reported usage that contradicts the observed activity', () => {
    expect(reportedUsageInconsistency(current(), 0, { started: true })).toMatch(/\$0 for a run that ran/);
    expect(reportedUsageInconsistency(current(), 10_000, { started: true, resultItems: 14 })).toMatch(/below the minimum charge for the 14 result/);
    expect(reportedUsageInconsistency(current(), 50_000, { started: true, resultItems: 14 })).toBeNull();
    expect(reportedUsageInconsistency(current(), 0, {})).toBeNull(); // a run that never ran may legitimately cost $0
  });

  it('bounds the charge implied by tiered event counts', () => {
    expect(chargeRangeFromEventCounts(current(), { init: 1, result: 10 })).toEqual({ lowMicros: 20_000 + 10 * 1_500, highMicros: 20_000 + 10 * 2_000 });
    expect(chargeRangeFromEventCounts(current(), {})).toBeNull();
    expect(chargeRangeFromEventCounts(current(), { mystery: 2 })).toBeNull();
  });

  it('formats provider caps as plain decimals', () => {
    expect(microsToUsdParam(80_000)).toBe('0.08');
    expect(microsToUsdParam(1_000_000)).toBe('1');
    expect(microsToUsdParam(1_234_567)).toBe('1.234567');
  });
});
