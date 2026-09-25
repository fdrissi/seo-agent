/**
 * Memory/Qdrant status honesty (SYNTHETIC data, fake Qdrant + fake embedder,
 * offline).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServices, DisabledLlmClient } from '../../../src/app/services.js';
import { EmbeddingService } from '../../../src/memory/embeddings.js';
import { createMemoryService, memoryStatus } from '../../../src/memory/service.js';
import { registerMemoryLlmFactory } from '../../../src/memory/wiring.js';
import { memoryIndexNote } from '../../../src/workflows/pipelines/common.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { installFixtureVault, memoryConfig, memoryHarness, NO_RETRY_POLICY, type MemoryHarness } from '../../fixtures/memory/setup.js';

let h: MemoryHarness | undefined;
afterEach(() => {
  registerMemoryLlmFactory(null);
  h?.ctx.cleanup();
  h = undefined;
});

const q = (text: string) => ({ siteId: 'test-site', text });

describe('memory status', () => {
  it('QDRANT_API_KEY over plain http to a non-loopback host is refused: misconfigured status, full-text search keeps working', async () => {
    h = memoryHarness({ secrets: { QDRANT_URL: 'http://qdrant.internal.test:6333', QDRANT_API_KEY: 'synthetic-qdrant-key-000' } });
    installFixtureVault(h.ctx);
    const service = h.make({ qdrant: undefined });
    const status = await memoryStatus(h.ctx, { network: true, llm: h.embedder });
    expect(status.integration.state).toBe('misconfigured');
    expect(status.integration.detail).toMatch(/plain HTTP to a non-loopback host/);
    expect(status.integration.nextStep).toMatch(/https QDRANT_URL/);
    expect(status.qdrant.warnings.join(' ')).toMatch(/refused/);
    await service.sync({});
    const r = await service.search(q('discount school email'));
    expect(r.method).toBe('fts_only');
    expect(r.chunks.length).toBeGreaterThan(0);
    // Nothing was ever sent to the insecure Qdrant URL (the key never left the process).
    expect(h.qdrant.requests).toHaveLength(0);
  });

  it('per-query choices (unpaid query embedding, empty query) never make a healthy Qdrant look degraded', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    await h.service.sync({ allowPaid: true });
    const unpaid = h.make({ retrievalOptions: { allowPaidQueryEmbedding: false } });

    const r = await unpaid.search(q('a query whose vector is not cached yet'));
    expect(r.method).toBe('fts_only');
    expect(r.degraded).toBe(true); // the result itself is honest about being full-text only
    expect(r.degradedReason).toMatch(/paid call and was not allowed/);
    const blank = await unpaid.search(q('   '));
    expect(blank.degradedReason).toBe('empty query');

    const rs = h.ctx.db.get<{ last_method: string; degraded: number }>('SELECT last_method, degraded FROM memory_retrieval_state')!;
    expect(rs).toEqual({ last_method: 'hybrid', degraded: 0 });
    const offlineStatus = await h.service.status({ network: false });
    expect(offlineStatus.integration.state).toBe('configured_unverified');
    const net = await h.service.status({ network: true });
    expect(net.integration.state).toBe('ready');
  });

  it('a real Qdrant failure is still persisted and reported as degraded without a network check', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    await h.service.sync({ allowPaid: true });
    h.qdrant.down = true;
    await h.service.search(q('school discount'));
    const st = await h.service.status({ network: false });
    expect(st.integration.state).toBe('degraded');
    expect(st.integration.detail).toMatch(/Qdrant unavailable/);
  });

  it('memoryStatus without an llm argument resolves the memory LLM client (doctor path)', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    await h.service.sync({ allowPaid: true });
    const embedder = h.embedder;
    registerMemoryLlmFactory(() => embedder);
    const st = await memoryStatus(h.ctx, { network: true }); // no llm passed: resolved like the memory CLI does
    expect(st.embeddings.state).toBe('ready');
    expect(st.integration.state).toBe('ready');
    expect(st.nextSteps.join(' ')).not.toMatch(/LLM_GATEWAY_API_KEY/);
  });

  it('an explicit llm: null reports embeddings as not wired, with a next step that matches the configured secrets', async () => {
    h = memoryHarness({ secrets: { LLM_GATEWAY_API_KEY: 'synthetic-test-key-not-real' } });
    const withKey = await memoryStatus(h.ctx, { network: false, llm: null });
    expect(withKey.embeddings.state).toBe('not_configured');
    expect(withKey.embeddings.nextStep).toMatch(/are set, but no LLM client is wired into memory/);
    h.ctx.cleanup();

    h = memoryHarness();
    const noKey = await memoryStatus(h.ctx, { network: false, llm: null });
    expect(noKey.embeddings.nextStep).toMatch(/Set LLM_GATEWAY_API_KEY/);
  });

  it('an offline run (a per-invocation choice) is never persisted as degraded retrieval', async () => {
    h = memoryHarness();
    installFixtureVault(h.ctx);
    await h.service.sync({ allowPaid: true });
    const svc = h.make({ qdrantRetryPolicy: NO_RETRY_POLICY });
    (h.ctx as { offline: boolean }).offline = true;
    const sync = await svc.sync({ allowPaid: true });
    expect(sync.index.status).toBe('skipped');
    const r = await svc.search(q('school discount'));
    expect(r.degradedReason).toMatch(/offline mode/);
    (h.ctx as { offline: boolean }).offline = false;
    const rs = h.ctx.db.get<{ last_method: string; degraded: number }>('SELECT last_method, degraded FROM memory_retrieval_state')!;
    expect(rs).toEqual({ last_method: 'hybrid', degraded: 0 });
    expect((await h.service.status({ network: false })).integration.state).toBe('configured_unverified');
  });
});

// ---------------------------------------------------------------------------
// D2-ACC-07: --offline is a per-invocation switch, not a configuration problem. With LLM_GATEWAY_API_KEY and
// models.embedding configured, an offline memory sync / status / weekly index note names the network switch
// and never tells the owner to set a key they already set. SYNTHETIC config and key; offline context.
// ---------------------------------------------------------------------------

const SYNTHETIC_KEY = 'synthetic-test-key-not-real';
const MISSING_CONFIG = /missing key or model|Set LLM_GATEWAY_API_KEY|Configure the LLM Gateway|not set/;

let ctx: TestContext | null = null;

/** Offline context (no fetch) with the key and an embedding model configured (full profile: embeddings + Qdrant on). */
function offlineConfigured(): TestContext {
  ctx = createTestContext({ config: memoryConfig(), secrets: { LLM_GATEWAY_API_KEY: SYNTHETIC_KEY } });
  expect(ctx.offline).toBe(true);
  expect(ctx.settings.models.embedding).toBe('fake-embed-model');
  return ctx;
}

describe('memory with --offline and a configured embedding model (D2-ACC-07)', () => {
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });

  it('memory sync (the CLI wiring: the disabled LLM client) reports the offline reason and "Run without --offline"', async () => {
    const c = offlineConfigured();
    installFixtureVault(c);
    const svc = createServices(c, { googleProvider: null });
    expect(svc.llmKind).toBe('disabled');
    expect(svc.llm).toBeInstanceOf(DisabledLlmClient);
    expect(svc.llm.unavailable).toMatchObject({ status: 'disabled', reason: expect.stringMatching(/--offline/) });

    const memory = createMemoryService(c, { llm: svc.llm });
    const r = await memory.sync({});
    expect(r.index.status).toBe('skipped');
    expect(r.index.plan.embedding).toMatchObject({ state: 'unavailable', model: 'fake-embed-model' });
    expect(r.index.plan.embedding.reason).toMatch(/Network access is disabled \(--offline\)/);
    expect(r.index.plan.embedding.nextStep).toMatch(/^Run without --offline/);
    expect(r.index.degradedReason).toMatch(/--offline/);
    expect(`${r.index.plan.embedding.reason} ${r.index.plan.embedding.nextStep} ${r.index.degradedReason}`).not.toMatch(MISSING_CONFIG);
    // Not full-text only "by policy": features.embeddings is on.
    expect(r.index.policy).toBe(false);
  });

  it('memory status (doctor path: the client resolved through the registered factory) names --offline, not a missing key', async () => {
    const c = offlineConfigured();
    registerMemoryLlmFactory((x) => createServices(x, { googleProvider: null }).llm);
    const st = await memoryStatus(c, { network: false });
    expect(st.embeddings.state).toBe('unavailable');
    expect(st.embeddings.reason).toMatch(/Network access is disabled \(--offline\)/);
    expect(st.embeddings.nextStep).toMatch(/^Run without --offline/);
    expect(st.nextSteps.join(' ')).not.toMatch(MISSING_CONFIG);
    // An explicit llm: null in an offline run says the same, not "no client wired".
    const noClient = await memoryStatus(c, { network: false, llm: null });
    expect(noClient.embeddings.reason).toMatch(/--offline/);
    expect(noClient.embeddings.nextStep).toMatch(/^Run without --offline/);
    expect(noClient.nextSteps.join(' ')).not.toMatch(MISSING_CONFIG);
  });

  it('the pipelines\' full-text memory (weekly index_memory) carries the offline reason into its stage note', async () => {
    const c = offlineConfigured();
    installFixtureVault(c);
    const svc = createServices(c, { googleProvider: null });
    const r = await svc.memory.sync({ allowPaid: false });
    expect(r.index.degradedReason).toMatch(/Network access is disabled \(--offline\)/);
    expect(r.index.degradedReason).not.toMatch(MISSING_CONFIG);
    const n = memoryIndexNote(r.index, 'semantic vectors for new chunks need an explicit paid embedding run (`memory sync --allow-paid`)');
    expect(n?.detail).toMatch(/--offline/);
    expect(n?.detail).not.toMatch(MISSING_CONFIG);
  });

  it('online with a configured gateway, the pipelines\' memory states the no-implicit-spend policy instead of "configure the gateway"', async () => {
    ctx = createTestContext({ config: memoryConfig(), secrets: { LLM_GATEWAY_API_KEY: SYNTHETIC_KEY }, fetch: async () => { throw new Error('no request in this test'); } });
    const svc = createServices(ctx, { googleProvider: null });
    expect(svc.llmKind).toBe('gateway');
    const r = await svc.memory.sync({ allowPaid: false, dryRun: true });
    expect(r.index.plan.embedding.reason).toMatch(/without an embedding client on purpose/);
    expect(r.index.plan.embedding.nextStep).toMatch(/memory sync --allow-paid/);
    expect(`${r.index.plan.embedding.reason} ${r.index.plan.embedding.nextStep}`).not.toMatch(MISSING_CONFIG);
  });

  it('a disabled client that reports not_configured keeps that state, with its own reason instead of the generic guess', () => {
    const c = offlineConfigured();
    const e = new EmbeddingService(c, new DisabledLlmClient('No LLM model connection is configured (synthetic reason).', 'Synthetic next step.', 'not_configured'));
    expect(e.resolveTarget()).toEqual({ state: 'not_configured', reason: 'No LLM model connection is configured (synthetic reason).', nextStep: 'Synthetic next step.' });
  });
});
