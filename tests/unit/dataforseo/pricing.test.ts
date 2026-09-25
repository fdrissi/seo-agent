import { describe, expect, it } from 'vitest';
import {
  DOCUMENTED_PRICE_MAX_AGE_DAYS,
  PRICE_KEY_ALIASES,
  PROVISIONAL_SAFETY_FACTOR,
  estimateRowPricedRequest,
  estimateSerpTask,
  estimateVolumeTask,
  hasSearchOperators,
  pricingOverrideWarnings,
  pricingSummary,
  resolvePrice,
} from '../../../src/integrations/dataforseo/pricing.js';
import { dfsConfig } from '../../integration/dataforseo/helpers.js';

const now = new Date('2026-09-24T09:00:00Z');

describe('DataForSEO pricing and estimates', () => {
  const cfg = dfsConfig();

  it('estimates standard SERP tasks per 10-result page (DF30)', () => {
    expect(estimateSerpTask(cfg, { keyword: 'synthetic query', depth: 10, queue: 'standard', sandbox: false }, now)).toMatchObject({ upperBoundMicros: 600, basis: { source: 'documented' } });
    expect(estimateSerpTask(cfg, { keyword: 'synthetic query', depth: 25, queue: 'standard', sandbox: false }, now).upperBoundMicros).toBe(1800);
    expect(estimateSerpTask(cfg, { keyword: 'synthetic query', depth: 10, queue: 'live', sandbox: false }, now).upperBoundMicros).toBe(2000);
  });

  it('multiplies by 5 for search operators (DF4)', () => {
    expect(hasSearchOperators('site:example.test pricing')).toBe(true);
    expect(hasSearchOperators('intitle:guide')).toBe(true);
    expect(hasSearchOperators('how to price a website')).toBe(false);
    expect(estimateSerpTask(cfg, { keyword: 'site:example.test pricing', depth: 10, queue: 'standard', sandbox: false }, now).upperBoundMicros).toBe(3000);
  });

  it('prices Google Ads search volume per task, not per keyword (DF31)', () => {
    expect(estimateVolumeTask(cfg, { queue: 'standard', sandbox: false, tasks: 1 }, now).upperBoundMicros).toBe(60_000);
    expect(estimateVolumeTask(cfg, { queue: 'live', sandbox: false, tasks: 2 }, now).upperBoundMicros).toBe(180_000);
  });

  it('sandbox is free with a fixed_zero basis (DF14)', () => {
    expect(estimateSerpTask(cfg, { keyword: 'q', depth: 10, queue: 'standard', sandbox: true }, now)).toMatchObject({ upperBoundMicros: 0, basis: { source: 'fixed_zero' } });
  });

  it('config pricingOverrides take precedence as verified_config', () => {
    const c = dfsConfig({ dataforseo: { pricingOverrides: { 'serp.google.organic.standard': '0.0009' } } });
    const e = estimateSerpTask(c, { keyword: 'q', depth: 20, queue: 'standard', sandbox: false }, now);
    expect(e.upperBoundMicros).toBe(1800);
    expect(e.basis.source).toBe('verified_config');
  });

  it('treats stale documented prices as UNKNOWN (null upper bound, never 0)', () => {
    const later = new Date(now.getTime() + (DOCUMENTED_PRICE_MAX_AGE_DAYS + 5) * 86_400_000);
    const e = estimateSerpTask(cfg, { keyword: 'q', depth: 10, queue: 'standard', sandbox: false }, later);
    expect(e.upperBoundMicros).toBeNull();
    expect(e.basis.source).toBe('unknown');
    expect(e.basis.detail).toMatch(/re-verify/);
    const fixed = dfsConfig({ dataforseo: { pricingOverrides: { 'serp.google.organic.standard': '0.0006' } } });
    expect(estimateSerpTask(fixed, { keyword: 'q', depth: 10, queue: 'standard', sandbox: false }, later).upperBoundMicros).toBe(600);
  });

  it('has no documented price for LLM mentions (unverified), so it is unknown', () => {
    const r = resolvePrice(cfg, 'ai_optimization.llm_mentions.request', now);
    expect(r.ok).toBe(false);
    const e = estimateRowPricedRequest(cfg, { requestKey: 'ai_optimization.llm_mentions.request', rowKey: 'ai_optimization.llm_mentions.row', maxRows: 10, sandbox: false }, now);
    expect(e.upperBoundMicros).toBeNull();
  });

  it('bounds row-priced endpoints with a hard row limit', () => {
    const e = estimateRowPricedRequest(cfg, { requestKey: 'backlinks.request', rowKey: 'backlinks.row', maxRows: 1000, sandbox: false }, now);
    expect(e.upperBoundMicros).toBe(24_000 + 36_000);
  });

  it('an unknown (stale) price keeps a null upper bound but carries a conservative provisional hold', () => {
    const later = new Date(now.getTime() + (DOCUMENTED_PRICE_MAX_AGE_DAYS + 5) * 86_400_000);
    expect(PROVISIONAL_SAFETY_FACTOR).toBe(2);
    const e = estimateSerpTask(cfg, { keyword: 'q', depth: 20, queue: 'standard', sandbox: false }, later);
    expect(e).toMatchObject({ upperBoundMicros: null, provisionalMicros: 600 * 2 * 2, basis: { source: 'unknown' } });
    expect(e.basis.detail).toMatch(/holds \$0\.0024/);
    // Search operators still multiply the hold by 5.
    expect(estimateSerpTask(cfg, { keyword: 'site:example.test q', depth: 10, queue: 'standard', sandbox: false }, later).provisionalMicros).toBe(600 * 2 * 5);
    expect(estimateVolumeTask(cfg, { queue: 'standard', sandbox: false, tasks: 1 }, later)).toMatchObject({ upperBoundMicros: null, provisionalMicros: 120_000 });
    // Known prices have no provisional field (the upper bound is the hold).
    expect(estimateSerpTask(cfg, { keyword: 'q', depth: 10, queue: 'standard', sandbox: false }, now).provisionalMicros).toBeUndefined();
  });

  it('LLM mentions: unknown price, provisional hold from the unverified static figures; no hold without a safe row limit', () => {
    const e = estimateRowPricedRequest(cfg, { requestKey: 'ai_optimization.llm_mentions.request', rowKey: 'ai_optimization.llm_mentions.row', maxRows: 10, sandbox: false }, now);
    expect(e).toMatchObject({ upperBoundMicros: null, provisionalMicros: 200_000 + 10 * 2_000 });
    const bad = estimateRowPricedRequest(cfg, { requestKey: 'backlinks.request', rowKey: 'backlinks.row', maxRows: Number.NaN, sandbox: false }, now);
    expect(bad).toMatchObject({ upperBoundMicros: null, provisionalMicros: null });
    expect(bad.basis.detail).toMatch(/cannot run even with an approval/);
  });

  it('accepts per-task endpoint keys as pricingOverrides aliases and reports keys it cannot use', () => {
    const aliased = dfsConfig({ dataforseo: { pricingOverrides: { 'serp/google/organic/task_post': '0.0009' } } });
    const r = resolvePrice(aliased, 'serp.google.organic.standard', now);
    expect(r).toMatchObject({ ok: true, price: { micros: 900, source: 'verified_config' } });
    expect(r.ok && r.price.detail).toMatch(/via alias "serp\/google\/organic\/task_post"/);
    expect(pricingOverrideWarnings(aliased)).toEqual([]);
    expect(Object.values(PRICE_KEY_ALIASES)).toContain('keywords.google_ads.search_volume.standard');

    const typo = dfsConfig({ dataforseo: { pricingOverrides: { 'serp.google.organic': '0.0006', 'backlinks/summary/live': '0.03' } } });
    const w = pricingOverrideWarnings(typo);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/\["serp\.google\.organic"\] is not a recognized price key and is IGNORED/);
    expect(w[1]).toMatch(/"backlinks\/summary\/live"/);
    // The typo does not silently become a price.
    expect(estimateSerpTask(typo, { keyword: 'q', depth: 10, queue: 'standard', sandbox: false }, now).basis.source).toBe('documented');

    const shadowed = dfsConfig({ dataforseo: { pricingOverrides: { 'serp.google.organic.standard': '0.0007', 'serp/google/organic/task_post': '0.0009' } } });
    expect(resolvePrice(shadowed, 'serp.google.organic.standard', now)).toMatchObject({ ok: true, price: { micros: 700 } });
    expect(pricingOverrideWarnings(shadowed)[0]).toMatch(/is ignored because "serp\.google\.organic\.standard" is also set/);
  });

  it('summarizes every price key with its basis', () => {
    const s = pricingSummary(cfg, now);
    expect(s.find((p) => p.key === 'serp.google.organic.standard')?.status).toBe('documented');
    expect(s.find((p) => p.key === 'ai_optimization.llm_mentions.request')?.status).toBe('unknown');
  });
});
