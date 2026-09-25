/**
 * Exercises the Qdrant adapter over real HTTP against a local 127.0.0.1
 * server that serves the SYNTHETIC in-memory Qdrant double (not a real
 * Qdrant). Uses undici's fetch directly because the global fetch is blocked
 * in tests.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetch as undiciFetch } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from '../../../src/integrations/types.js';
import { createMemoryService } from '../../../src/memory/service.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { FakeEmbedder } from '../../fixtures/memory/fake-embedder.js';
import { FakeQdrant } from '../../fixtures/memory/fake-qdrant.js';
import { DIMS, NO_RETRY_POLICY, installFixtureVault, memoryConfig } from '../../fixtures/memory/setup.js';

let server: http.Server | null = null;
let ctx: TestContext | null = null;
afterEach(async () => {
  ctx?.cleanup();
  ctx = null;
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

async function serve(fake: FakeQdrant): Promise<string> {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      fake.requests.push({ method: req.method ?? 'GET', path: url.pathname, query: url.search, headers, body: body ? JSON.parse(body) : null });
      const r = fake.handle(req.method ?? 'GET', url.pathname, headers, body ? JSON.parse(body) : null);
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
      res.end(await r.text());
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const realFetch = ((input: string | URL, init?: RequestInit) => undiciFetch(input, init as Parameters<typeof undiciFetch>[1])) as unknown as FetchLike;

describe('Qdrant adapter over local HTTP (synthetic server)', () => {
  it('syncs and searches end to end with the api-key header', async () => {
    const fake = new FakeQdrant({ apiKey: 'synthetic-local-qdrant-key' });
    const url = await serve(fake);
    ctx = createTestContext({ config: memoryConfig(), fetch: realFetch, secrets: { QDRANT_URL: url, QDRANT_API_KEY: 'synthetic-local-qdrant-key' } });
    installFixtureVault(ctx);
    const svc = createMemoryService(ctx, { llm: new FakeEmbedder(DIMS), qdrantRetryPolicy: NO_RETRY_POLICY });
    const s = await svc.sync({ allowPaid: true });
    expect(s.index.status).toBe('ok');
    expect(fake.requests.filter((r) => r.path !== '/healthz').every((r) => r.headers['api-key'] === 'synthetic-local-qdrant-key')).toBe(true);
    const r = await svc.search({ siteId: ctx.siteId, text: 'school discount' });
    expect(r.method).toBe('hybrid');
    expect(r.chunks[0]!.title).toBe('Pricing');
    const st = await svc.status({ network: true });
    expect(st.integration.state).toBe('ready');
    expect(st.qdrant.collection?.exists).toBe(true);
    expect(JSON.stringify(st)).not.toContain('synthetic-local-qdrant-key');
  });

  it('reports permission_denied when the API key is wrong, and search degrades to full-text', async () => {
    const fake = new FakeQdrant({ apiKey: 'synthetic-server-key' });
    const url = await serve(fake);
    ctx = createTestContext({ config: memoryConfig(), fetch: realFetch, secrets: { QDRANT_URL: url, QDRANT_API_KEY: 'synthetic-wrong-key' } });
    installFixtureVault(ctx);
    const embedder = new FakeEmbedder(DIMS);
    const svc = createMemoryService(ctx, { llm: embedder, qdrantRetryPolicy: NO_RETRY_POLICY });
    const st = await svc.status({ network: true });
    expect(st.integration.state).toBe('permission_denied');
    expect(st.integration.nextStep).toMatch(/QDRANT_API_KEY/);
    const s = await svc.sync({ allowPaid: true });
    expect(s.index.status).toBe('degraded');
    expect(s.index.degradedReason).toMatch(/rejected an authenticated request/);
    expect(s.index.embedded).toBe(0); // no paid embedding before Qdrant access is verified
    expect(embedder.calls).toHaveLength(0);
    const r = await svc.search({ siteId: ctx.siteId, text: 'school discount' });
    expect(r.method).toBe('fts_only');
    expect(r.chunks[0]!.title).toBe('Pricing');
  });

  it('reports unreachable when nothing listens', async () => {
    ctx = createTestContext({ config: memoryConfig(), fetch: realFetch, secrets: { QDRANT_URL: 'http://127.0.0.1:9' } });
    const svc = createMemoryService(ctx, { llm: new FakeEmbedder(DIMS), qdrantRetryPolicy: NO_RETRY_POLICY, qdrantTimeoutMs: 2_000 });
    const st = await svc.status({ network: true });
    expect(st.integration.state).toBe('unreachable');
    expect(st.integration.nextStep).toMatch(/docker compose up -d qdrant/);
  });
});
