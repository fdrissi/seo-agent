import type { CostEstimate, PriceBasis } from '../../budgets/types.js';
import { addMicros, formatUsd, fromMicros, mulMicros, toMicros, type Micros } from '../../core/money.js';

/**
 * Apify actor pricing semantics (docs/integration-contracts.md section 7).
 *
 * - `pricingInfos` is a history array; the record in force is the one with
 *   the latest `startedAt` <= now (inference recorded as unverified).
 * - PAY_PER_EVENT events carry either a flat `eventPriceUsd` or
 *   `eventTieredPricingUsd` keyed by tier. The tier that applies to the
 *   account is unverified, so estimates use the MOST EXPENSIVE tier.
 * - The container path `pricingPerEvent.actorChargeEvents` follows the Apify
 *   API; it is not spelled out in the contract doc, so parsing is defensive and
 *   any unrecognized shape yields "unknown price" (never $0).
 * - Only PAY_PER_EVENT is estimated. Any other pricing model is unknown here.
 */

export interface PricingEvent {
  key: string;
  title: string | null;
  description: string | null;
  /** Flat price in micros, when the event has a flat price. */
  flatPriceMicros: Micros | null;
  /** Tier -> price in micros, when the event is tiered. */
  tieredPricesMicros: Record<string, Micros> | null;
  isPrimary: boolean;
  isOneTime: boolean;
}

export interface PricingRecord {
  pricingModel: string;
  startedAt: string | null;
  minimalMaxTotalChargeUsdMicros: Micros | null;
  events: PricingEvent[] | null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Non-negative finite USD number -> micros; anything else -> null (unknown). */
export function usdToMicros(v: unknown): Micros | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return toMicros(v);
}

export function parsePricingRecord(raw: unknown): PricingRecord | null {
  const r = obj(raw);
  if (!r || typeof r.pricingModel !== 'string') return null;
  const rec: PricingRecord = {
    pricingModel: r.pricingModel,
    startedAt: typeof r.startedAt === 'string' ? r.startedAt : null,
    minimalMaxTotalChargeUsdMicros: usdToMicros(r.minimalMaxTotalChargeUsd),
    events: null,
  };
  const perEvent = obj(r.pricingPerEvent);
  const events = obj(perEvent?.actorChargeEvents);
  if (events) {
    const list: PricingEvent[] = [];
    for (const [key, value] of Object.entries(events)) {
      const e = obj(value);
      if (!e) continue;
      const flat = usdToMicros(e.eventPriceUsd);
      let tiered: Record<string, Micros> | null = null;
      const tiers = obj(e.eventTieredPricingUsd);
      if (tiers) {
        tiered = {};
        for (const [tier, t] of Object.entries(tiers)) {
          const price = usdToMicros(obj(t)?.tieredEventPriceUsd);
          if (price !== null) tiered[tier] = price;
        }
        if (Object.keys(tiered).length === 0) tiered = null;
      }
      list.push({
        key,
        title: typeof e.eventTitle === 'string' ? e.eventTitle : null,
        description: typeof e.eventDescription === 'string' ? e.eventDescription : null,
        flatPriceMicros: flat,
        tieredPricesMicros: tiered,
        isPrimary: e.isPrimaryEvent === true,
        isOneTime: e.isOneTimeEvent === true,
      });
    }
    rec.events = list;
  }
  return rec;
}

/** The pricing record in force at `now`: latest `startedAt` <= now. Null when none qualifies. */
export function selectCurrentPricing(pricingInfos: unknown, now: Date): PricingRecord | null {
  if (!Array.isArray(pricingInfos)) return null;
  let best: PricingRecord | null = null;
  let bestAt = -Infinity;
  for (const raw of pricingInfos) {
    const rec = parsePricingRecord(raw);
    if (!rec?.startedAt) continue;
    const at = Date.parse(rec.startedAt);
    if (Number.isNaN(at) || at > now.getTime()) continue;
    if (at > bestAt) {
      best = rec;
      bestAt = at;
    }
  }
  return best;
}

function eventPriceCandidates(e: PricingEvent): Micros[] {
  const candidates: Micros[] = [];
  if (e.flatPriceMicros !== null) candidates.push(e.flatPriceMicros);
  if (e.tieredPricesMicros) candidates.push(...Object.values(e.tieredPricesMicros));
  return candidates;
}

/** Conservative (highest) unit price for an event; null when the event carries no parseable price. */
export function maxEventPriceMicros(e: PricingEvent): Micros | null {
  const c = eventPriceCandidates(e);
  return c.length ? Math.max(...c) : null;
}

/** Lowest unit price for an event (cheapest tier); null when the event carries no parseable price. */
export function minEventPriceMicros(e: PricingEvent): Micros | null {
  const c = eventPriceCandidates(e);
  return c.length ? Math.min(...c) : null;
}

export interface EstimateLine {
  event: string;
  units: number;
  unitPriceMicros: Micros;
  subtotalMicros: Micros;
  note: string;
}

export interface RunCostEstimate extends CostEstimate {
  lines: EstimateLine[];
  warnings: string[];
  /**
   * Cost terms of the estimate (null when the estimate is unknown):
   * `fixedMicros` = one-time charges; `perResultMaxMicros` / `perResultMinMicros`
   * = the charge added by one more stored result at the highest / lowest tier.
   * Used to fit bounds under a cap and to detect runs stopped by the cap.
   */
  terms: EstimateTerms | null;
}

export interface EstimateTerms {
  fixedMicros: Micros;
  perResultMaxMicros: Micros;
  perResultMinMicros: Micros;
}

export interface EstimateInput {
  /** Upper bound on results (posts + comments) the input can store. */
  maxResults: number;
  memoryMbytes: number;
  /** Events whose triggers the input explicitly disables (e.g. AI add-ons). */
  disabledEvents: ReadonlySet<string>;
  verifiedAt?: string;
}

/**
 * Conservative upper bound for one PAY_PER_EVENT run.
 *
 * - One-time events count once; when the event description says "per GB of
 *   memory" (the Reddit actor's `init` event; semantics unverified) the count
 *   is ceil(memory GB), at least 1.
 * - The primary event counts once per possible result.
 * - Events whose triggers are explicitly disabled in the input count 0.
 * - Any other event is assumed to be chargeable once per possible result: an
 *   item limit is NOT assumed to bound every charge.
 */
export function estimateRunCost(pricing: PricingRecord | null, input: EstimateInput): RunCostEstimate {
  const unknown = (detail: string, warnings: string[] = []): RunCostEstimate => ({
    upperBoundMicros: null,
    basis: { source: 'unknown', detail },
    lines: [],
    warnings,
    terms: null,
  });
  if (!pricing) return unknown('No current Apify pricing record is stored for this actor. Run `apify inspect` to retrieve verified pricing.');
  if (pricing.pricingModel !== 'PAY_PER_EVENT') {
    return unknown(`Pricing model ${pricing.pricingModel} is not supported by the estimator (only PAY_PER_EVENT is verified for this actor).`);
  }
  if (!pricing.events || pricing.events.length === 0) return unknown('The pricing record has no parseable charge events.');
  if (!Number.isSafeInteger(input.maxResults) || input.maxResults < 0) return unknown('Result bound is not a non-negative integer.');

  const lines: EstimateLine[] = [];
  const warnings: string[] = [];
  const gb = Math.max(1, Math.ceil(input.memoryMbytes / 1024));
  const terms: EstimateTerms = { fixedMicros: 0, perResultMaxMicros: 0, perResultMinMicros: 0 };
  for (const e of pricing.events) {
    const price = maxEventPriceMicros(e);
    const minPrice = minEventPriceMicros(e);
    if (price === null || minPrice === null) return unknown(`Charge event "${e.key}" has no parseable price.`);
    let units: number;
    let note: string;
    if (input.disabledEvents.has(e.key)) {
      units = 0;
      note = 'trigger disabled in the actor input';
    } else if (e.isOneTime) {
      const perGb = /per\s*GB/i.test(e.description ?? '');
      units = perGb ? gb : 1;
      note = perGb ? `one-time; description says "per GB of memory" (unverified), counted x${gb}` : 'one-time event';
      terms.fixedMicros = addMicros(terms.fixedMicros, mulMicros(price, units));
    } else if (e.isPrimary) {
      units = input.maxResults;
      note = 'primary event, once per possible result';
      terms.perResultMaxMicros = addMicros(terms.perResultMaxMicros, price);
      terms.perResultMinMicros = addMicros(terms.perResultMinMicros, minPrice);
    } else {
      units = input.maxResults;
      note = 'unrecognized event assumed chargeable once per possible result';
      warnings.push(`Unrecognized charge event "${e.key}" counted conservatively per result.`);
      terms.perResultMaxMicros = addMicros(terms.perResultMaxMicros, price);
    }
    if (e.tieredPricesMicros) note += '; tiered price, highest tier used';
    lines.push({ event: e.key, units, unitPriceMicros: price, subtotalMicros: mulMicros(price, units), note });
  }
  const total = addMicros(...lines.map((l) => l.subtotalMicros));
  const basis: PriceBasis = {
    source: 'provider_api',
    detail: lines.map((l) => `${l.event}: ${l.units} x ${formatUsd(l.unitPriceMicros)} (${l.note})`).join('; '),
    units: input.maxResults,
    unitLabel: 'results',
    ...(input.verifiedAt ? { verifiedAt: input.verifiedAt } : {}),
  };
  return { upperBoundMicros: total, basis, lines, warnings, terms };
}

/** What the run was observed to do, used to reject preliminary or contradictory usage figures. */
export interface ObservedActivity {
  /** The run actually ran (terminal SUCCEEDED/FAILED/TIMED-OUT, or produced items): one-time events were charged. */
  started?: boolean;
  /** Lower bound on posts/comments saved to the dataset (each is a primary `result` event). */
  resultItems?: number;
}

function primaryEvent(pricing: PricingRecord): PricingEvent | undefined {
  return pricing.events?.find((e) => e.isPrimary);
}

/**
 * Why provider-reported `chargedEventCounts` cannot be trusted as final, or
 * null when they are consistent with the observed activity. The contract
 * warns that counts right after completion can be preliminary; an empty map,
 * a missing one-time event on a run that ran, or fewer primary events than
 * the results already fetched are treated as preliminary (unknown), never $0.
 */
export function eventCountsInconsistency(pricing: PricingRecord | null, counts: Record<string, number> | null | undefined, observed: ObservedActivity = {}): string | null {
  if (!counts) return 'no charged event counts reported';
  const entries = Object.entries(counts);
  if (entries.length === 0) return 'charged event counts are empty';
  if (entries.some(([, n]) => !Number.isSafeInteger(n) || n < 0)) return 'charged event counts are not non-negative integers';
  const total = entries.reduce((a, [, n]) => a + n, 0);
  const ran = observed.started === true || (observed.resultItems ?? 0) > 0;
  if (ran && total === 0) return 'every charged event count is 0 for a run that ran';
  if (pricing?.events && ran) {
    for (const e of pricing.events) {
      if (e.isOneTime && !((counts[e.key] ?? 0) > 0)) return `one-time event "${e.key}" is missing from the counts of a run that ran`;
    }
  }
  const primary = pricing ? primaryEvent(pricing) : undefined;
  if (primary && observed.resultItems !== undefined && (counts[primary.key] ?? 0) < observed.resultItems) {
    return `"${primary.key}" count ${counts[primary.key] ?? 0} is below the ${observed.resultItems} result(s) already fetched`;
  }
  return null;
}

/**
 * Compute the charge from provider-reported `chargedEventCounts` when every
 * charged event has a FLAT price. Tiered events depend on the account tier
 * (unverified) so the result is null (unknown), never a guess. Counts that
 * look preliminary or contradict the observed activity also yield null.
 */
export function chargeFromEventCounts(pricing: PricingRecord | null, counts: Record<string, number> | null | undefined, observed: ObservedActivity = {}): Micros | null {
  if (!pricing?.events || !counts) return null;
  if (eventCountsInconsistency(pricing, counts, observed) !== null) return null;
  let total = 0;
  for (const [key, n] of Object.entries(counts)) {
    if (n === 0) continue;
    const e = pricing.events.find((ev) => ev.key === key);
    if (!e || e.flatPriceMicros === null || e.tieredPricesMicros) return null;
    total = addMicros(total, mulMicros(e.flatPriceMicros, n));
  }
  return total;
}

/**
 * Lowest and highest charge consistent with `chargedEventCounts` across all
 * price tiers. Null when counts are missing/invalid or an event is unpriced.
 */
export function chargeRangeFromEventCounts(pricing: PricingRecord | null, counts: Record<string, number> | null | undefined): { lowMicros: Micros; highMicros: Micros } | null {
  if (!pricing?.events || !counts || Object.keys(counts).length === 0) return null;
  let low = 0;
  let high = 0;
  for (const [key, n] of Object.entries(counts)) {
    if (!Number.isSafeInteger(n) || n < 0) return null;
    if (n === 0) continue;
    const e = pricing.events.find((ev) => ev.key === key);
    const lo = e ? minEventPriceMicros(e) : null;
    const hi = e ? maxEventPriceMicros(e) : null;
    if (lo === null || hi === null) return null;
    low = addMicros(low, mulMicros(lo, n));
    high = addMicros(high, mulMicros(hi, n));
  }
  return { lowMicros: low, highMicros: high };
}

/**
 * Why a provider-reported total cannot be final given the observed activity
 * (e.g. $0 for a run that ran and saved results), or null when plausible.
 */
export function reportedUsageInconsistency(pricing: PricingRecord | null, reportedMicros: Micros, observed: ObservedActivity = {}): string | null {
  const ran = observed.started === true || (observed.resultItems ?? 0) > 0;
  if (ran && reportedMicros === 0) return 'usageTotalUsd is $0 for a run that ran (one-time and result events are charged)';
  const primary = pricing ? primaryEvent(pricing) : undefined;
  const minPrimary = primary ? minEventPriceMicros(primary) : null;
  if (minPrimary !== null && observed.resultItems !== undefined && reportedMicros < mulMicros(minPrimary, observed.resultItems)) {
    return `usageTotalUsd ${formatUsd(reportedMicros)} is below the minimum charge for the ${observed.resultItems} result(s) already fetched`;
  }
  return null;
}

/** Decimal USD string for a provider cap (e.g. 1030000 -> "1.03"). */
export function microsToUsdParam(micros: Micros): string {
  const s = fromMicros(micros);
  return s.replace(/0+$/, '').replace(/\.$/, '');
}
