import { afterEach, describe, expect, it } from 'vitest';
import type { TestContext } from '../../helpers/context.js';
import { jsonResponse } from '../../helpers/fake-fetch.js';
import { checkConfiguredModels, discoverModels, loadCachedCatalog } from '../../../src/integrations/llm/models.js';
import { llmStatus } from '../../../src/integrations/llm/status.js';
import { createLlmClient } from '../../../src/integrations/llm/gateway.js';
import { planLlmCost } from '../../../src/integrations/llm/plan.js';
import { BASE, TEST_KEY, catalogJson, fakeGateway, gatewayError, llmTestContext, rows } from './harness.js';
import { MemorySecretStore } from '../../../src/config/secrets.js';
import { fakeFetch, match } from '../../helpers/fake-fetch.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

describe('model discovery (free GET /v1/models)', () => {
  it('fetches the authenticated catalog, caches capabilities with retrieval time, and reuses the fresh cache', async () => {
    const gw = fakeGateway();
    ctx = llmTestContext({ fetch: gw.fetch });
    const a = await discoverModels(ctx);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.catalog.source).toBe('network');
    expect(a.catalog.authenticated).toBe(true);
    expect(a.catalog.retrievedAt).toBe('2026-09-24T09:00:00.000Z');
    expect(a.catalog.skipped).toBe(1); // entry without an id is skipped, never guessed
    expect(gw.modelsRequests[0]!.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    const snap = rows<{ model_count: number; is_synthetic: number }>(ctx, 'SELECT model_count, is_synthetic FROM llm_model_catalog_snapshots');
    expect(snap).toEqual([{ model_count: 8, is_synthetic: 0 }]);
    const cap = rows<{ structured_outputs: number; tools: number; prompt_price: string }>(ctx, "SELECT * FROM llm_model_capabilities WHERE model_id = 'synthetic-cheap-structured'")[0]!;
    expect(cap).toMatchObject({ structured_outputs: 1, tools: 1, prompt_price: '0.15e-6' });
    const preq = rows<{ is_paid: number; endpoint: string; status: string }>(ctx, "SELECT * FROM provider_requests WHERE endpoint = 'models.list'");
    expect(preq).toEqual([expect.objectContaining({ is_paid: 0, status: 'succeeded' })]);

    const b = await discoverModels(ctx);
    expect(b.ok && b.catalog.source).toBe('cache');
    expect(gw.modelsRequests).toHaveLength(1);
    ctx.clock.advanceMs(25 * 60 * 60 * 1000);
    const c = await discoverModels(ctx);
    expect(c.ok && c.catalog.source).toBe('network');
    expect(gw.modelsRequests).toHaveLength(2);
  });

  it('falls back to a recent cached catalog (flagged) when a refresh fails, and reports unreachable without one', async () => {
    let fail = false;
    const f = fakeFetch([match('GET', `${BASE}/models`, () => (fail ? gatewayError(503, 'down', 'api_error') : jsonResponse(catalogJson())))]);
    ctx = llmTestContext({ fetch: f });
    expect((await discoverModels(ctx)).ok).toBe(true);
    fail = true;
    ctx.clock.advanceMs(25 * 60 * 60 * 1000);
    const r = await discoverModels(ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.catalog.stale).toBe(true);
    expect(r.warning).toContain('HTTP 503');
    ctx.clock.advanceMs(8 * 24 * 60 * 60 * 1000);
    const r2 = await discoverModels(ctx);
    expect(r2.ok).toBe(false);
    expect(!r2.ok && r2.state).toBe('unreachable');
  });

  it('with a key, never reuses a cached unauthenticated (unfiltered public) catalog: it refetches with the key', async () => {
    const gw = fakeGateway();
    ctx = llmTestContext({ fetch: gw.fetch, secrets: { LLM_GATEWAY_API_KEY: '' } });
    const anon = await discoverModels(ctx);
    expect(anon.ok && anon.catalog.authenticated).toBe(false);
    expect(gw.modelsRequests[0]!.headers.authorization).toBeUndefined();
    (ctx.secrets as MemorySecretStore).set('LLM_GATEWAY_API_KEY', TEST_KEY);
    const keyed = await discoverModels(ctx);
    expect(keyed.ok).toBe(true);
    if (!keyed.ok) return;
    expect(keyed.catalog.source).toBe('network');
    expect(keyed.catalog.authenticated).toBe(true);
    expect(gw.modelsRequests).toHaveLength(2);
    expect(gw.modelsRequests[1]!.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    // The authenticated snapshot is now reused while fresh.
    const again = await discoverModels(ctx);
    expect(again.ok && again.catalog.source).toBe('cache');
    expect(gw.modelsRequests).toHaveLength(2);
  });

  it('with a key, an unauthenticated cached catalog is not used as a stale fallback when the refresh fails', async () => {
    let down = false;
    const f = fakeFetch([match('GET', `${BASE}/models`, () => (down ? gatewayError(503, 'down', 'api_error') : jsonResponse(catalogJson())))]);
    ctx = llmTestContext({ fetch: f, secrets: { LLM_GATEWAY_API_KEY: '' } });
    expect((await discoverModels(ctx)).ok).toBe(true);
    (ctx.secrets as MemorySecretStore).set('LLM_GATEWAY_API_KEY', TEST_KEY);
    down = true;
    const r = await discoverModels(ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.state).toBe('unreachable');
  });

  it('reports 401 as unauthorized with a next step and never leaks the key', async () => {
    const f = fakeFetch([match('GET', `${BASE}/models`, () => gatewayError(401, 'Invalid API key', 'invalid_request_error', 'invalid_api_key'))]);
    ctx = llmTestContext({ fetch: f });
    const r = await discoverModels(ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.state).toBe('unauthorized');
    expect(r.nextStep).toContain('LLM_GATEWAY_API_KEY');
    expect(JSON.stringify(r)).not.toContain(TEST_KEY);
  });

  it('offline mode uses only the cache', async () => {
    ctx = llmTestContext();
    const r = await discoverModels(ctx);
    expect(r.ok === false && r.state).toBe('offline');
    expect(loadCachedCatalog(ctx)).toBeNull();
  });

  it('checks configured models: ok, invalid id, wrong kind, unknown price', async () => {
    const gw = fakeGateway();
    ctx = llmTestContext({ fetch: gw.fetch, models: { cheap: 'synthetic-cheap-latest', reasoning: 'synthetic-unpriced', embedding: 'synthetic-reasoner' } });
    const d = await discoverModels(ctx);
    if (!d.ok) throw new Error('discovery failed');
    const checks = Object.fromEntries(checkConfiguredModels(ctx, d.catalog).map((c) => [c.tier, c]));
    expect(checks.cheap!.status).toBe('ok');
    expect(checks.cheap!.warnings.join(' ')).toContain('alias');
    expect(checks.reasoning!.status).toBe('unknown_price');
    expect(checks.embedding!.status).toBe('wrong_kind');
    ctx.cleanup();
    ctx = llmTestContext({ fetch: gw.fetch, models: { cheap: 'prov-b/synthetic-multi-provider', reasoning: 'prov-z/synthetic-multi-provider', embedding: 'no-such-model' } });
    const d2 = await discoverModels(ctx);
    if (!d2.ok) throw new Error('discovery failed');
    const c2 = Object.fromEntries(checkConfiguredModels(ctx, d2.catalog).map((c) => [c.tier, c]));
    expect(c2.cheap!.status).toBe('ok');
    expect(c2.cheap!.capabilities!.tools).toBe(false); // pinned prov-b mapping has no tools
    expect(c2.cheap!.capabilities!.inputPricePerMillionUsd).toBe('3');
    expect(c2.reasoning!.status).toBe('invalid_model');
    expect(c2.embedding!.status).toBe('invalid_model');
  });
});

describe('llmStatus (never chargeable)', () => {
  it('reports each honest state', async () => {
    ctx = llmTestContext({ secrets: { LLM_GATEWAY_API_KEY: '' } });
    expect((await llmStatus(ctx, { network: false })).state).toBe('missing_credentials');
    ctx.cleanup();

    ctx = llmTestContext({ models: { reasoning: null } });
    const mis = await llmStatus(ctx, { network: false });
    expect(mis.state).toBe('misconfigured');
    expect(mis.detail).toContain('REASONING_MODEL');
    ctx.cleanup();

    ctx = llmTestContext();
    const unverified = await llmStatus(ctx, { network: false });
    expect(unverified.state).toBe('configured_unverified');
    expect(unverified.networkChecked).toBe(false);
    expect(unverified.chargeable).toBe(false);
    expect(unverified.sendsExternally.length).toBeGreaterThan(0);
    ctx.cleanup();

    ctx = llmTestContext({ features: { llm: false, embeddings: false } });
    expect((await llmStatus(ctx, { network: true })).state).toBe('disabled');
  });

  it('refuses a plain-http LLM_GATEWAY_BASE_URL to a non-loopback host everywhere: misconfigured status, no request carries the key', async () => {
    const gw = fakeGateway({ chat: [() => { throw new Error('must not be called'); }], embeddings: [() => { throw new Error('must not be called'); }] });
    ctx = llmTestContext({ fetch: gw.fetch, secrets: { LLM_GATEWAY_BASE_URL: 'http://gateway.example.test/v1' } });
    const status = await llmStatus(ctx, { network: true, fetch: gw.fetch });
    expect(status.state).toBe('misconfigured');
    expect(status.detail).toMatch(/plain http to a non-loopback host/);
    expect(status.nextStep).toMatch(/https/);
    const d = await discoverModels(ctx, { force: true, fetch: gw.fetch });
    expect(d.ok === false && d.state).toBe('misconfigured');
    expect(loadCachedCatalog(ctx)).toBeNull(); // never throws (reports and pipelines keep working)
    const client = createLlmClient(ctx, { fetch: gw.fetch });
    const text = await client.text({ siteId: ctx.siteId, runId: ctx.runId, role: 'extractor', tier: 'cheap', promptId: 'system.connection-test', variables: {}, evidence: [] });
    expect(text.ok === false && text.status).toBe('not_configured');
    expect(text.ok === false && text.reason).toMatch(/plain http/);
    const emb = await client.embed({ siteId: ctx.siteId, runId: ctx.runId, texts: ['synthetic'] });
    expect(emb.ok === false && emb.status).toBe('not_configured');
    expect(gw.fetch.calls).toHaveLength(0);
    expect(rows(ctx, 'SELECT * FROM budget_reservations')).toHaveLength(0);
    ctx.cleanup();

    // Loopback http (a local proxy) and https stay valid.
    ctx = llmTestContext({ secrets: { LLM_GATEWAY_BASE_URL: 'http://127.0.0.1:8787/v1' } });
    expect((await llmStatus(ctx, { network: false })).state).toBe('configured_unverified');
  });

  it('network check lists models and reads the key budget only (no completion)', async () => {
    const gw = fakeGateway();
    ctx = llmTestContext({ fetch: gw.fetch });
    const s = await llmStatus(ctx, { network: true });
    expect(s.state).toBe('ready');
    expect(s.networkChecked).toBe(true);
    expect(s.chargeable).toBe(false);
    expect(s.key?.limitMicros).toBe(5_000_000);
    expect(s.key?.usageMicros).toBe(100_000);
    expect(gw.fetch.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(gw.chatBodies).toHaveLength(0);
  });

  it('network check reports unreachable (not ready) when the live listing fails and only a cached catalog was used', async () => {
    let down = false;
    const f = fakeFetch([
      match('GET', `${BASE}/models`, () => (down ? gatewayError(503, 'down', 'api_error') : jsonResponse(catalogJson()))),
      match('GET', `${BASE}/key`, () => (down ? gatewayError(503, 'down', 'api_error') : jsonResponse({ data: { usage: '0', limit: '5' } }))),
    ]);
    ctx = llmTestContext({ fetch: f });
    expect((await discoverModels(ctx)).ok).toBe(true);
    down = true;
    const s = await llmStatus(ctx, { network: true, fetch: f });
    expect(s.state).toBe('unreachable');
    expect(s.networkChecked).toBe(true);
    expect(s.detail).toContain('Nothing was verified live');
    expect(s.detail).toContain('cached catalog');
    expect(s.detail).toContain('HTTP 503');
    expect(s.detail).not.toContain('verified in the gateway catalog');
    expect(s.catalog?.source).toBe('cache');
  });

  it('network check flags invalid models as misconfigured and unpriced models as degraded', async () => {
    const gw = fakeGateway();
    ctx = llmTestContext({ fetch: gw.fetch, models: { cheap: 'bogus-model-id' } });
    const s = await llmStatus(ctx, { network: true });
    expect(s.state).toBe('misconfigured');
    expect(s.detail).toContain('bogus-model-id');
    ctx.cleanup();
    ctx = llmTestContext({ fetch: gw.fetch, models: { cheap: 'synthetic-unpriced' } });
    const d = await llmStatus(ctx, { network: true });
    expect(d.state).toBe('degraded');
    expect(d.detail).toContain('BUDGET_UNKNOWN_PRICE');
  });

  it('demo profile reports the synthetic fixture client', async () => {
    ctx = llmTestContext({ profile: 'demo' });
    expect((await llmStatus(ctx, { network: true })).state).toBe('fixture');
  });
});

describe('planLlmCost (no network, no reservation)', () => {
  it('sums conservative upper bounds and keeps unknown prices unknown', async () => {
    const gw = fakeGateway();
    ctx = llmTestContext({ fetch: gw.fetch });
    const d = await discoverModels(ctx);
    if (!d.ok) throw new Error('discovery failed');
    const plan = planLlmCost(ctx, d.catalog, [
      { label: 'classify ambiguous queries', tier: 'cheap', requests: 10, inputTokensPerRequest: 2_000, maxOutputTokens: 500 },
      { label: 'embed notes', tier: 'embedding', requests: 1, inputTokensPerRequest: 1_000_000 },
    ]);
    // cheap: 10 x (2000 x 0.15 + 500 x 0.60) micros = 10 x 600; embedding: 1M x $0.02/1M = 20,000 micros
    expect(plan.lines.map((l) => l.upperBoundMicros)).toEqual([6_000, 20_000]);
    expect(plan.totalUpperBoundMicros).toBe(26_000);
    expect(rows(ctx, 'SELECT * FROM budget_reservations')).toHaveLength(0);
    ctx.cleanup();
    ctx = llmTestContext({ fetch: gw.fetch, models: { cheap: 'synthetic-unpriced' } });
    const d2 = await discoverModels(ctx);
    if (!d2.ok) throw new Error('discovery failed');
    const p2 = planLlmCost(ctx, d2.catalog, [{ label: 'x', tier: 'cheap', requests: 1, inputTokensPerRequest: 10 }]);
    expect(p2.totalUpperBoundMicros).toBeNull();
    expect(p2.notes.join(' ')).toContain('BUDGET_UNKNOWN_PRICE');
  });

  it('adds a flat per-request fee once per embeddings request, not once per line', async () => {
    const gw = fakeGateway();
    ctx = llmTestContext({ fetch: gw.fetch });
    const d = await discoverModels(ctx);
    if (!d.ok) throw new Error('discovery failed');
    const catalog = { ...d.catalog, models: d.catalog.models.map((m) => (m.id === 'synthetic-embed-small' ? { ...m, prices: { ...m.prices, requestFeeMicros: 100 } } : m)) };
    const plan = planLlmCost(ctx, catalog, [{ label: 'embed chunks', tier: 'embedding', requests: 5, inputTokensPerRequest: 1_000 }]);
    // per request: 1000 tok x $0.02/1M = 20 micros + 100 fee = 120; x 5 requests
    expect(plan.lines[0]!.upperBoundMicros).toBe(600);
  });
});
