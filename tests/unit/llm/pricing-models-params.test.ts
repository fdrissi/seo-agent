import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { testSiteConfig } from '../../helpers/context.js';
import { deriveCapabilities, findModel, parseModelsResponse, type ModelCatalog } from '../../../src/integrations/llm/models.js';
import { buildChatBody, decideResponseFormat, isStrictCompatible, zodToJsonSchema } from '../../../src/integrations/llm/params.js';
import { actualChatCost, estimateChatCost, estimateEmbeddingCost, parseUsage, perTokenPriceToMicrosPerMillion, resolvePrices, usdAmountToMicrosCeil } from '../../../src/integrations/llm/pricing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogBody = JSON.parse(readFileSync(path.resolve(here, '../../fixtures/llm/models.synthetic.json'), 'utf8'));

function catalog(): ModelCatalog {
  const parsed = parseModelsResponse(catalogBody);
  return { snapshotId: 's', baseUrl: 'https://api.llmgateway.io/v1', retrievedAt: '2026-09-24T00:00:00.000Z', authenticated: true, source: 'network', stale: false, skipped: parsed.skipped.length, models: parsed.models.map((m) => deriveCapabilities(m)), isSynthetic: true };
}
const NOW = new Date('2026-09-24T00:00:00Z');
const caps = (id: string) => {
  const r = findModel(catalog(), id, NOW);
  if (!r.ok) throw new Error(r.reason);
  return r.caps;
};

describe('price parsing (verified exponent-notation USD-per-token strings)', () => {
  it('converts exactly to micros per 1M tokens, rounding up', () => {
    expect(perTokenPriceToMicrosPerMillion('0.15e-6')).toBe(150_000); // $0.15 / 1M
    expect(perTokenPriceToMicrosPerMillion('3.0e-6')).toBe(3_000_000);
    expect(perTokenPriceToMicrosPerMillion('0.02e-6')).toBe(20_000);
    expect(perTokenPriceToMicrosPerMillion('0.0000006')).toBe(600_000);
    expect(perTokenPriceToMicrosPerMillion('0')).toBe(0);
    expect(perTokenPriceToMicrosPerMillion('1e-15')).toBe(1); // sub-micro rounds up, never down to 0
    expect(perTokenPriceToMicrosPerMillion(1.5e-7)).toBe(150_000);
    for (const bad of ['', '-1e-6', 'abc', null, undefined, '1e-6x', '.', {}]) expect(perTokenPriceToMicrosPerMillion(bad)).toBeNull();
    expect(usdAmountToMicrosCeil('0.001')).toBe(1000);
  });
});

describe('catalog parsing and capabilities', () => {
  it('parses tolerant of unknown fields and skips entries without an id', () => {
    const parsed = parseModelsResponse(catalogBody);
    expect(parsed.models).toHaveLength(8);
    expect(parsed.skipped).toHaveLength(1);
    expect(() => parseModelsResponse({ nope: [] })).toThrow(/data/);
  });

  it('derives conservative capabilities', () => {
    const cheap = caps('synthetic-cheap-structured');
    expect(cheap).toMatchObject({ structuredOutputs: true, jsonOutput: true, tools: true, reasoning: false, reasoningPossible: false, isEmbedding: false, contextLength: 128000, maxOutput: 16384 });
    expect(cheap.prices).toMatchObject({ inputPerMillion: 150_000, outputPerMillion: 600_000 });
    const multi = caps('synthetic-multi-provider');
    expect(multi.tools).toBe(false); // one mapping lacks tools
    expect(multi.maxOutput).toBe(4096); // min across mappings
    expect(multi.prices.inputPerMillion).toBe(3_000_000); // max across mappings
    const reasoner = caps('synthetic-reasoner');
    expect(reasoner.reasoning).toBe(true);
    expect(reasoner.reasoningEfforts).toEqual(['low', 'medium', 'high']);
    expect(caps('synthetic-embed-small').isEmbedding).toBe(true);
    expect(caps('synthetic-unpriced').prices.inputPerMillion).toBeNull();
  });

  it('finds ids, aliases, and provider pins; rejects unknown, deactivated, auto; never substitutes', () => {
    const c = catalog();
    expect(findModel(c, 'synthetic-cheap-latest', NOW)).toMatchObject({ ok: true, resolvedVia: 'alias' });
    const pinned = findModel(c, 'prov-a/synthetic-multi-provider', NOW);
    expect(pinned.ok && pinned.caps.tools).toBe(true);
    expect(pinned.ok && pinned.caps.prices.inputPerMillion).toBe(1_000_000);
    expect(pinned.ok && pinned.caps.pinnedProvider).toBe('prov-a');
    const missing = findModel(c, 'synthetic-cheap-structurd', NOW);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.similar).toContain('synthetic-cheap-structured');
      expect(missing.nextStep).toContain('No substitute is chosen automatically');
    }
    expect(findModel(c, 'synthetic-deactivated', NOW).ok).toBe(false);
    const before = findModel(c, 'synthetic-deactivated', new Date('2025-12-01T00:00:00Z'));
    expect(before.ok && before.warnings.join(' ')).toContain('scheduled for deactivation');
    expect(findModel(c, 'auto', NOW).ok).toBe(false);
    expect(findModel(c, 'prov-z/synthetic-multi-provider', NOW).ok).toBe(false);
  });
});

describe('cost estimates', () => {
  const config = testSiteConfig();

  it('upper bound = input x in-price + max output x out-price + reasoning allowance', () => {
    const p = resolvePrices(caps('synthetic-cheap-structured'), config, 'synthetic-cheap-structured', '2026-09-24');
    const e = estimateChatCost(p, { inputTokens: 10_000, maxOutputTokens: 1_000, reasoningTokens: 0 });
    expect(e.upperBoundMicros).toBe(1_500 + 600);
    expect(e.basis.source).toBe('provider_api');
    const withReasoning = estimateChatCost(p, { inputTokens: 10_000, maxOutputTokens: 1_000, reasoningTokens: 1_000 });
    expect(withReasoning.upperBoundMicros).toBe(1_500 + 600 + 600);
  });

  it('unknown price gives a null upper bound (source unknown), unless a verified override exists', () => {
    const unpriced = caps('synthetic-unpriced');
    const e = estimateChatCost(resolvePrices(unpriced, config, 'synthetic-unpriced'), { inputTokens: 10, maxOutputTokens: 10, reasoningTokens: 0 });
    expect(e.upperBoundMicros).toBeNull();
    expect(e.basis.source).toBe('unknown');
    const withOverride = testSiteConfig({ llm: { pricingOverrides: { 'synthetic-unpriced': { inputPerMillionUsd: '1.00', outputPerMillionUsd: '4.00' } } } });
    const e2 = estimateChatCost(resolvePrices(unpriced, withOverride, 'synthetic-unpriced'), { inputTokens: 1_000_000, maxOutputTokens: 1_000_000, reasoningTokens: 0 });
    expect(e2.upperBoundMicros).toBe(5_000_000);
    expect(e2.basis.source).toBe('verified_config');
  });

  it('overrides never lower a catalog price in the upper bound', () => {
    const cfg = testSiteConfig({ llm: { pricingOverrides: { 'synthetic-cheap-structured': { inputPerMillionUsd: '0.01', outputPerMillionUsd: '0.01' } } } });
    const p = resolvePrices(caps('synthetic-cheap-structured'), cfg, 'synthetic-cheap-structured');
    expect(p.inputPerMillion).toBe(150_000);
  });

  it('embedding estimates use input price only', () => {
    const p = resolvePrices(caps('synthetic-embed-small'), config, 'synthetic-embed-small');
    expect(estimateEmbeddingCost(p, 1_000_000).upperBoundMicros).toBe(20_000);
  });

  it('actual cost: gateway-reported > computed from usage > unknown (never 0)', () => {
    const p = resolvePrices(caps('synthetic-cheap-structured'), config, 'synthetic-cheap-structured');
    expect(actualChatCost(parseUsage({ prompt_tokens: 1, completion_tokens: 1, cost: 0.0012 }), p)).toMatchObject({ micros: 1200, source: 'gateway_reported' });
    expect(actualChatCost(parseUsage({ prompt_tokens: 1000, completion_tokens: 100 }), p)).toMatchObject({ micros: 210, source: 'computed_from_usage' });
    expect(actualChatCost(parseUsage(undefined), p)).toMatchObject({ micros: null, source: 'unknown' });
    expect(actualChatCost(parseUsage({ prompt_tokens: 5 }), p)).toMatchObject({ micros: null, source: 'unknown' });
    // Top-level reasoning tokens (inclusion unverified) are added conservatively; detail tokens are assumed included.
    expect(actualChatCost(parseUsage({ prompt_tokens: 0, completion_tokens: 100, reasoning_tokens: 100 }), p).micros).toBe(120);
    expect(actualChatCost(parseUsage({ prompt_tokens: 0, completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 100 } }), p).micros).toBe(60);
    expect(parseUsage({ cost: null, prompt_tokens: -3 })).toMatchObject({ gatewayCostUsd: null, promptTokens: null });
  });
});

describe('capability-driven parameter builder', () => {
  const schema = zodToJsonSchema(z.object({ a: z.string(), b: z.number() }))!;

  it('zod -> JSON Schema with strict compatibility detection', () => {
    expect(schema.strictCompatible).toBe(true);
    expect(schema.schema.$schema).toBeUndefined();
    expect(zodToJsonSchema(z.object({ a: z.string().optional() }))!.strictCompatible).toBe(false);
    expect(isStrictCompatible({ type: 'object', properties: { x: { type: 'object', properties: { y: { type: 'string' } }, required: ['y'] } }, required: ['x'], additionalProperties: false })).toBe(false);
    expect(zodToJsonSchema(z.string().transform((s) => s.length))).not.toBeNull();
  });

  it('chooses json_schema > json_object > prompt by verified capability', () => {
    expect(decideResponseFormat(caps('synthetic-cheap-structured'), true, schema)).toBe('json_schema');
    expect(decideResponseFormat(caps('synthetic-cheap-structured'), true, null)).toBe('json_object');
    expect(decideResponseFormat(caps('synthetic-json-only'), true, schema)).toBe('json_object');
    expect(decideResponseFormat(caps('synthetic-plain'), true, schema)).toBe('prompt');
    expect(decideResponseFormat(caps('synthetic-plain'), false, schema)).toBe('text');
  });

  it('omits unsupported params with reasons and always sends a clamped max_tokens', () => {
    const plain = buildChatBody({ model: 'synthetic-plain', caps: caps('synthetic-plain'), tier: 'cheap', messages: [], maxOutputTokens: 5000, format: 'json_schema', schema, temperature: 0, reasoningEffort: 'low', tools: [{ type: 'function', function: { name: 'get_site_profile', description: 'd', parameters: {} } }] });
    expect(plain.body).toEqual({ model: 'synthetic-plain', max_tokens: 2048, messages: [] });
    expect(plain.format).toBe('prompt');
    expect(plain.omitted.map((o) => o.param).sort()).toEqual(['max_tokens', 'reasoning_effort', 'response_format.json_schema', 'temperature', 'tools']);
    const jsonOnPlain = buildChatBody({ model: 'synthetic-plain', caps: caps('synthetic-plain'), tier: 'cheap', messages: [], maxOutputTokens: 10, format: 'json_object' });
    expect(jsonOnPlain.format).toBe('prompt');
    expect(jsonOnPlain.omitted.map((o) => o.param)).toEqual(['response_format.json_object']);
    const cheap = buildChatBody({ model: 'm', caps: caps('synthetic-cheap-structured'), tier: 'cheap', messages: [], maxOutputTokens: 100, format: 'json_schema', schemaName: 'My Schema!', schema, temperature: 0, responseHealing: true });
    expect(cheap.body).toMatchObject({ temperature: 0, max_tokens: 100, response_format: { type: 'json_schema', json_schema: { name: 'My_Schema_', strict: true } }, plugins: [{ id: 'response-healing' }] });
    const unknownParams = { ...caps('synthetic-cheap-structured'), supportedParameters: null };
    expect(buildChatBody({ model: 'm', caps: unknownParams, tier: 'cheap', messages: [], maxOutputTokens: 10, format: 'text', temperature: 0.5 }).body.temperature).toBeUndefined();
  });

  it('sends reasoning.max_tokens only to reasoning models, and never together with reasoning_effort', () => {
    const r = buildChatBody({ model: 'm', caps: caps('synthetic-reasoner'), tier: 'reasoning', messages: [], maxOutputTokens: 100, format: 'text', reasoningEffort: 'low', reasoningMaxTokens: 300 });
    expect(r.body.reasoning).toEqual({ effort: 'low', max_tokens: 300 });
    expect(r.body.reasoning_effort).toBeUndefined();
    const onlyMax = buildChatBody({ model: 'm', caps: caps('synthetic-reasoner'), tier: 'reasoning', messages: [], maxOutputTokens: 100, format: 'text', reasoningMaxTokens: 300 });
    expect(onlyMax.body.reasoning).toEqual({ max_tokens: 300 });
    const effortOnly = buildChatBody({ model: 'm', caps: caps('synthetic-reasoner'), tier: 'reasoning', messages: [], maxOutputTokens: 100, format: 'text', reasoningEffort: 'high' });
    expect(effortOnly.body.reasoning_effort).toBe('high');
    expect(effortOnly.body.reasoning).toBeUndefined();
    const plain = buildChatBody({ model: 'm', caps: caps('synthetic-plain'), tier: 'reasoning', messages: [], maxOutputTokens: 100, format: 'text', reasoningMaxTokens: 300 });
    expect(plain.body.reasoning).toBeUndefined();
    expect(plain.omitted.map((o) => o.param)).toContain('reasoning.max_tokens');
  });
});
