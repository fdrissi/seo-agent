import { formatUsd, mulMicros, toMicros, type Micros } from '../../core/money.js';
import type { CostEstimate, PriceBasis } from '../../budgets/types.js';
import type { SiteConfig } from '../../config/site-schema.js';

/**
 * DataForSEO cost estimation.
 *
 * Price resolution order for each price key:
 *   1. `research.dataforseo.pricingOverrides[<key>]` in the site config
 *      (owner-verified; basis `verified_config`).
 *   2. The documented price below, read from primary pricing pages on
 *      2026-09-24 (docs/integration-contracts.md section 6). Documented prices
 *      are used only while younger than DOCUMENTED_PRICE_MAX_AGE_DAYS; after
 *      that they are treated as UNKNOWN until re-verified, so stale pricing is
 *      never carried forward silently.
 *   3. Otherwise the price is UNKNOWN: the request is skipped
 *      (BUDGET_UNKNOWN_PRICE) unless explicitly approved.
 *
 * Override keys are the price keys below. The per-task endpoint keys in
 * PRICE_KEY_ALIASES are accepted as aliases (the config schema describes the
 * keys "by endpoint key"); any other key is reported by
 * `pricingOverrideWarnings` instead of being silently ignored.
 *
 * Unknown prices keep `upperBoundMicros: null` (never 0). When the owner
 * approves such a request, the budget still HOLDS a conservative provisional
 * amount (`provisionalMicros`): the last documented price, or the unverified
 * static figure, x PROVISIONAL_SAFETY_FACTOR. If no provisional bound can be
 * formed, the request is refused even with an approval, so an unresolved
 * charge is never held at $0.
 *
 * These are provider list prices, not owner-specific values. Sandbox requests
 * are free per DF14 ("You won't be charged for using Sandbox endpoints").
 */

export type PriceKey =
  | 'serp.google.organic.standard'
  | 'serp.google.organic.priority'
  | 'serp.google.organic.live'
  | 'keywords.google_ads.search_volume.standard'
  | 'keywords.google_ads.search_volume.live'
  | 'backlinks.request'
  | 'backlinks.row'
  | 'labs.google.task'
  | 'labs.google.item'
  | 'ai_optimization.llm_mentions.request'
  | 'ai_optimization.llm_mentions.row';

export const PRICE_KEYS: readonly PriceKey[] = [
  'serp.google.organic.standard',
  'serp.google.organic.priority',
  'serp.google.organic.live',
  'keywords.google_ads.search_volume.standard',
  'keywords.google_ads.search_volume.live',
  'backlinks.request',
  'backlinks.row',
  'labs.google.task',
  'labs.google.item',
  'ai_optimization.llm_mentions.request',
  'ai_optimization.llm_mentions.row',
];

export interface DocumentedPrice {
  usd: string;
  unit: string;
  source: string;
  verifiedAt: string;
}

/** Documented list prices (USD). Keys without an entry are unverified. */
export const DOCUMENTED_PRICES: Readonly<Partial<Record<PriceKey, DocumentedPrice>>> = {
  'serp.google.organic.standard': { usd: '0.0006', unit: 'SERP page of 10 results (standard queue, normal priority)', source: 'DF30', verifiedAt: '2026-09-24' },
  'serp.google.organic.priority': { usd: '0.0012', unit: 'SERP page of 10 results (priority queue)', source: 'DF30', verifiedAt: '2026-09-24' },
  'serp.google.organic.live': { usd: '0.002', unit: 'SERP page of 10 results (live)', source: 'DF30', verifiedAt: '2026-09-24' },
  'keywords.google_ads.search_volume.standard': { usd: '0.06', unit: 'task (up to 1000 keywords, standard queue)', source: 'DF31', verifiedAt: '2026-09-24' },
  'keywords.google_ads.search_volume.live': { usd: '0.09', unit: 'task (up to 1000 keywords, live)', source: 'DF31', verifiedAt: '2026-09-24' },
  'backlinks.request': { usd: '0.024', unit: 'request', source: 'DF32', verifiedAt: '2026-09-24' },
  'backlinks.row': { usd: '0.000036', unit: 'row', source: 'DF32', verifiedAt: '2026-09-24' },
  'labs.google.task': { usd: '0.012', unit: 'task', source: 'DF33', verifiedAt: '2026-09-24' },
  'labs.google.item': { usd: '0.00012', unit: 'item', source: 'DF33', verifiedAt: '2026-09-24' },
  // ai_optimization.llm_mentions.*: DF34 static figures are inconsistent -> unverified.
};

export const DOCUMENTED_PRICE_MAX_AGE_DAYS = 90;

/**
 * UNVERIFIED figures used ONLY to size the budget hold of an explicitly
 * approved unknown-price request. They are never used as a price estimate.
 */
export const PROVISIONAL_PRICES: Readonly<Partial<Record<PriceKey, DocumentedPrice>>> = {
  // DF34 static HTML says $0.1/request + $0.001/row, but its calculator shows $0.05 (inconsistent).
  'ai_optimization.llm_mentions.request': { usd: '0.1', unit: 'request', source: 'DF34 static figure (unverified)', verifiedAt: '2026-09-24' },
  'ai_optimization.llm_mentions.row': { usd: '0.001', unit: 'row', source: 'DF34 static figure (unverified)', verifiedAt: '2026-09-24' },
};

/** Headroom on stale or unverified figures for a provisional hold (prices rose ~20% on 2026-07-01, DF35). */
export const PROVISIONAL_SAFETY_FACTOR = 2;

/**
 * Per-task endpoint keys accepted as pricingOverrides aliases. Row-priced
 * endpoints have two prices (request + row), so they need the price keys.
 */
export const PRICE_KEY_ALIASES: Readonly<Record<string, PriceKey>> = {
  'serp/google/organic/task_post': 'serp.google.organic.standard',
  'serp/google/organic/live/advanced': 'serp.google.organic.live',
  'keywords_data/google_ads/search_volume/task_post': 'keywords.google_ads.search_volume.standard',
  'keywords_data/google_ads/search_volume/live': 'keywords.google_ads.search_volume.live',
};

export interface ResolvedPrice {
  key: PriceKey;
  micros: Micros;
  source: 'verified_config' | 'documented';
  detail: string;
  verifiedAt?: string;
}

/** A conservative per-unit amount to hold when an unknown price is approved. */
export interface ProvisionalUnitPrice {
  micros: Micros;
  detail: string;
}

export type PriceResolution = { ok: true; price: ResolvedPrice } | { ok: false; key: PriceKey; reason: string; provisional: ProvisionalUnitPrice | null };

function overrideFor(config: SiteConfig, key: PriceKey): { value: string | number; via: string } | undefined {
  const overrides = config.research.dataforseo.pricingOverrides as Record<string, string | number | undefined>;
  const direct = overrides[key];
  if (direct !== undefined) return { value: direct, via: key };
  for (const [alias, target] of Object.entries(PRICE_KEY_ALIASES)) {
    const v = overrides[alias];
    if (target === key && v !== undefined) return { value: v, via: alias };
  }
  return undefined;
}

function provisionalFrom(p: DocumentedPrice, label: string): ProvisionalUnitPrice {
  return { micros: mulMicros(toMicros(p.usd), PROVISIONAL_SAFETY_FACTOR), detail: `${label} $${p.usd} per ${p.unit} (${p.source}) x${PROVISIONAL_SAFETY_FACTOR} safety factor` };
}

export function resolvePrice(config: SiteConfig, key: PriceKey, now: Date): PriceResolution {
  const override = overrideFor(config, key);
  if (override !== undefined) {
    const via = override.via === key ? '' : ` via alias "${override.via}"`;
    return { ok: true, price: { key, micros: toMicros(override.value), source: 'verified_config', detail: `${key} = $${override.value} (site config pricingOverrides${via})` } };
  }
  const doc = DOCUMENTED_PRICES[key];
  if (!doc) {
    const prov = PROVISIONAL_PRICES[key];
    return {
      ok: false,
      key,
      reason: `No verified price for ${key}; set research.dataforseo.pricingOverrides["${key}"] after checking https://dataforseo.com/pricing`,
      provisional: prov ? provisionalFrom(prov, 'unverified figure') : null,
    };
  }
  const ageDays = (now.getTime() - Date.parse(`${doc.verifiedAt}T00:00:00Z`)) / 86_400_000;
  if (ageDays > DOCUMENTED_PRICE_MAX_AGE_DAYS) {
    return {
      ok: false,
      key,
      reason: `Documented price for ${key} was verified on ${doc.verifiedAt} (${Math.floor(ageDays)} days ago, limit ${DOCUMENTED_PRICE_MAX_AGE_DAYS}); re-verify at https://dataforseo.com/pricing and set research.dataforseo.pricingOverrides["${key}"]`,
      provisional: provisionalFrom(doc, `last documented price (verified ${doc.verifiedAt})`),
    };
  }
  return { ok: true, price: { key, micros: toMicros(doc.usd), source: 'documented', detail: `${key} = $${doc.usd} per ${doc.unit} (${doc.source}, verified ${doc.verifiedAt})`, verifiedAt: doc.verifiedAt } };
}

/**
 * Problems with research.dataforseo.pricingOverrides that would otherwise be
 * silent: keys that are neither a price key nor an accepted endpoint alias,
 * and an alias shadowed by its price key.
 */
export function pricingOverrideWarnings(config: SiteConfig): string[] {
  const overrides = config.research.dataforseo.pricingOverrides as Record<string, unknown>;
  const warnings: string[] = [];
  for (const k of Object.keys(overrides)) {
    if ((PRICE_KEYS as readonly string[]).includes(k)) continue;
    const target = PRICE_KEY_ALIASES[k];
    if (target) {
      if (overrides[target] !== undefined) warnings.push(`research.dataforseo.pricingOverrides["${k}"] is ignored because "${target}" is also set.`);
      continue;
    }
    warnings.push(
      `research.dataforseo.pricingOverrides["${k}"] is not a recognized price key and is IGNORED. Use one of: ${PRICE_KEYS.join(', ')} (or the endpoint keys ${Object.keys(PRICE_KEY_ALIASES).join(', ')}).`,
    );
  }
  return warnings;
}

const SANDBOX_BASIS: PriceBasis = { source: 'fixed_zero', detail: 'DataForSEO sandbox/fixture: free, synthetic data (DF14)' };

/**
 * The verified-zero estimate of a sandbox or fixture request (basis
 * `fixed_zero`): the sandbox host is free per DF14 and the fixture transport
 * never leaves the process. Such requests still go through the budget
 * reservation path (reserve $0 -> reconcile $0, flagged synthetic), so the
 * demo exercises the same lifecycle as a paid request without spending.
 */
export function sandboxCostEstimate(mode: 'sandbox' | 'fixture' = 'sandbox'): DfsCostEstimate {
  return {
    upperBoundMicros: 0,
    basis: {
      source: 'fixed_zero',
      detail: mode === 'fixture' ? 'DataForSEO SYNTHETIC fixture transport: answered in-process, nothing sent or charged ($0 verified)' : 'DataForSEO sandbox host: free per DF14, synthetic data ($0 verified)',
    },
  };
}

/**
 * A DataForSEO cost estimate. `provisionalMicros` is set only when the price
 * is unknown (`upperBoundMicros: null`): the amount the budget must hold if
 * the owner approves this exact request, or null when no bound can be formed.
 */
export interface DfsCostEstimate extends CostEstimate {
  provisionalMicros?: Micros | null;
}

function unknownEstimate(detail: string, provisionalMicros: Micros | null, provisionalDetail?: string): DfsCostEstimate {
  const hold = provisionalMicros === null ? 'no provisional bound can be formed, so it cannot run even with an approval' : `an approved request holds ${formatUsd(provisionalMicros)} (${provisionalDetail ?? 'provisional'})`;
  return { upperBoundMicros: null, basis: { source: 'unknown', detail: `${detail}; ${hold}` }, provisionalMicros };
}

function basisFrom(price: ResolvedPrice, units: number, unitLabel: string, extra: string): PriceBasis {
  return {
    source: price.source,
    detail: `${price.detail}; ${units} ${unitLabel}${extra}`,
    unitPriceMicros: price.micros,
    units,
    unitLabel,
    ...(price.verifiedAt ? { verifiedAt: price.verifiedAt } : {}),
  };
}

/** Google search operators multiply the SERP charge by 5 (DF4, DF10). */
const OPERATOR_RE = /(^|\s)-?(site|intitle|allintitle|inurl|allinurl|intext|allintext|inanchor|allinanchor|filetype|ext|related|cache|link|info|define|before|after|source|location):/i;

export function hasSearchOperators(keyword: string): boolean {
  return OPERATOR_RE.test(keyword);
}

export interface SerpEstimateInput {
  keyword: string;
  depth: number;
  queue: 'standard' | 'live';
  sandbox: boolean;
}

/**
 * Conservative upper bound for one Google organic SERP task:
 * base price x ceil(depth / 10) x (5 when search operators are present).
 * Paid extras (calculate_rectangles, load_async_ai_overview,
 * people_also_ask_click_depth, max_crawl_pages) are never sent.
 */
export function estimateSerpTask(config: SiteConfig, input: SerpEstimateInput, now: Date): DfsCostEstimate {
  if (input.sandbox) return { upperBoundMicros: 0, basis: SANDBOX_BASIS };
  const key: PriceKey = input.queue === 'live' ? 'serp.google.organic.live' : 'serp.google.organic.standard';
  const r = resolvePrice(config, key, now);
  const pages = Math.max(1, Math.ceil(input.depth / 10));
  const mult = hasSearchOperators(input.keyword) ? 5 : 1;
  if (!r.ok) {
    return r.provisional
      ? unknownEstimate(r.reason, mulMicros(r.provisional.micros, pages * mult), `${r.provisional.detail} x ${pages * mult} page(s)${mult > 1 ? ' incl. x5 for search operators' : ''}`)
      : unknownEstimate(r.reason, null);
  }
  return {
    upperBoundMicros: mulMicros(r.price.micros, pages * mult),
    basis: basisFrom(r.price, pages * mult, pages * mult === 1 ? 'SERP page' : 'SERP pages', mult > 1 ? ' (x5 for search operators)' : ''),
  };
}

/** Google Ads search volume: priced per task of up to 1000 keywords. */
export function estimateVolumeTask(config: SiteConfig, input: { queue: 'standard' | 'live'; sandbox: boolean; tasks: number }, now: Date): DfsCostEstimate {
  if (input.sandbox) return { upperBoundMicros: 0, basis: SANDBOX_BASIS };
  const key: PriceKey = input.queue === 'live' ? 'keywords.google_ads.search_volume.live' : 'keywords.google_ads.search_volume.standard';
  const r = resolvePrice(config, key, now);
  if (!r.ok) return r.provisional ? unknownEstimate(r.reason, mulMicros(r.provisional.micros, input.tasks), `${r.provisional.detail} x ${input.tasks} task(s)`) : unknownEstimate(r.reason, null);
  return { upperBoundMicros: mulMicros(r.price.micros, input.tasks), basis: basisFrom(r.price, input.tasks, input.tasks === 1 ? 'task' : 'tasks', '') };
}

/** Per-request + per-row endpoints (backlinks, Labs, LLM mentions) with a hard row limit. */
export function estimateRowPricedRequest(
  config: SiteConfig,
  input: { requestKey: PriceKey; rowKey: PriceKey; maxRows: number; sandbox: boolean },
  now: Date,
): DfsCostEstimate {
  if (input.sandbox) return { upperBoundMicros: 0, basis: SANDBOX_BASIS };
  if (!Number.isSafeInteger(input.maxRows) || input.maxRows < 0) return unknownEstimate('No safe row limit: a hard "limit" is required to bound the charge', null);
  const req = resolvePrice(config, input.requestKey, now);
  const row = resolvePrice(config, input.rowKey, now);
  if (!req.ok || !row.ok) {
    const reason = [req.ok ? null : req.reason, row.ok ? null : row.reason].filter(Boolean).join('; ');
    const reqHold = req.ok ? req.price.micros : (req.provisional?.micros ?? null);
    const rowHold = row.ok ? row.price.micros : (row.provisional?.micros ?? null);
    if (reqHold === null || rowHold === null) return unknownEstimate(reason, null);
    const parts = [req.ok ? req.price.detail : req.provisional!.detail, `${row.ok ? row.price.detail : row.provisional!.detail} x ${input.maxRows} rows`];
    return unknownEstimate(reason, reqHold + mulMicros(rowHold, input.maxRows), parts.join(' + '));
  }
  const upper = req.price.micros + mulMicros(row.price.micros, input.maxRows);
  return {
    upperBoundMicros: upper,
    basis: { source: req.price.source === 'documented' || row.price.source === 'documented' ? 'documented' : 'verified_config', detail: `${req.price.detail} + ${row.price.detail} x ${input.maxRows} rows (hard limit)` },
  };
}

/** Summaries for status/doctor output. */
export function pricingSummary(config: SiteConfig, now: Date): Array<{ key: PriceKey; status: 'verified_config' | 'documented' | 'unknown'; detail: string }> {
  return PRICE_KEYS.map((key) => {
    const r = resolvePrice(config, key, now);
    return r.ok ? { key, status: r.price.source, detail: r.price.detail } : { key, status: 'unknown' as const, detail: r.reason };
  });
}
