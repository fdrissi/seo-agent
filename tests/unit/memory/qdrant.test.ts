import { describe, expect, it } from 'vitest';
import { AppError } from '../../../src/core/errors.js';
import { registerSecret } from '../../../src/security/redact.js';
import { MEMORY_PAYLOAD_INDEXES, QdrantClient, QdrantError, insecureApiKeyTransport, isLoopbackUrl } from '../../../src/memory/qdrant.js';
import { fakeFetch, jsonResponse, match } from '../../helpers/fake-fetch.js';
import { FakeQdrant } from '../../fixtures/memory/fake-qdrant.js';

const NO_RETRY = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: 0 };
const BASE = 'http://127.0.0.1:6333';

describe('Qdrant REST adapter (verified v1.19 shapes)', () => {
  it('creates a cosine collection sized to the embedding dims, with payload indexes before data', async () => {
    const q = new FakeQdrant();
    const client = new QdrantClient({ baseUrl: `${BASE}/`, fetch: q.fetch, retryPolicy: NO_RETRY });
    const r = await client.ensureCollection('seo_agent__x__d8__c1', 8, MEMORY_PAYLOAD_INDEXES);
    expect(r.created).toBe(true);
    const create = q.requests.find((x) => x.method === 'PUT' && x.path === '/collections/seo_agent__x__d8__c1')!;
    expect(create.body).toEqual({ vectors: { size: 8, distance: 'Cosine' } });
    const idx = q.requests.filter((x) => x.path.endsWith('/index'));
    expect(idx.map((x) => (x.body as { field_name: string }).field_name).sort()).toEqual(Object.keys(MEMORY_PAYLOAD_INDEXES).sort());
    expect(idx.every((x) => x.query === '?wait=true')).toBe(true);
    expect((idx.find((x) => (x.body as { field_name: string }).field_name === 'superseded')!.body as { field_schema: string }).field_schema).toBe('bool');
    // Idempotent: second call creates nothing.
    const before = q.requests.length;
    const again = await client.ensureCollection('seo_agent__x__d8__c1', 8, MEMORY_PAYLOAD_INDEXES);
    expect(again.created).toBe(false);
    expect(q.requests.slice(before).some((x) => x.method === 'PUT')).toBe(false);
  });

  it('refuses an existing collection with a different vector size (never mixes spaces)', async () => {
    const q = new FakeQdrant();
    const client = new QdrantClient({ baseUrl: BASE, fetch: q.fetch, retryPolicy: NO_RETRY });
    await client.createCollection('c', 16);
    await expect(client.ensureCollection('c', 8, {})).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('upserts with wait=true, UUID ids, and the api-key header; queries always request payloads', async () => {
    const q = new FakeQdrant({ apiKey: 'synthetic-qdrant-key-000' });
    const client = new QdrantClient({ baseUrl: BASE, apiKey: 'synthetic-qdrant-key-000', fetch: q.fetch, retryPolicy: NO_RETRY, upsertBatchSize: 2 });
    await client.createCollection('c', 2);
    const id = (n: number) => `00000000-0000-5000-8000-00000000000${n}`;
    await client.upsertPoints('c', [1, 2, 3].map((n) => ({ id: id(n), vector: [n, 1], payload: { site_id: 's', n } })));
    const upserts = q.requests.filter((x) => x.method === 'PUT' && x.path === '/collections/c/points');
    expect(upserts).toHaveLength(2); // batched
    expect(upserts[0]!.query).toBe('?wait=true');
    expect(upserts.every((x) => x.headers['api-key'] === 'synthetic-qdrant-key-000')).toBe(true);
    const hits = await client.query('c', { vector: [1, 1], filter: { must: [{ key: 'site_id', match: { value: 's' } }] }, limit: 2 });
    expect(hits).toHaveLength(2);
    const qreq = q.requests.find((x) => x.path === '/collections/c/points/query')!;
    expect(qreq.body).toMatchObject({ with_payload: true, with_vector: false, limit: 2 });
    expect(hits[0]!.payload).toBeDefined();
  });

  it('scrolls every page until next_page_offset is null', async () => {
    const q = new FakeQdrant();
    const client = new QdrantClient({ baseUrl: BASE, fetch: q.fetch, retryPolicy: NO_RETRY });
    await client.createCollection('c', 2);
    const pts = Array.from({ length: 600 }, (_, i) => ({ id: `00000000-0000-5000-8000-${String(i).padStart(12, '0')}`, vector: [1, i], payload: { site_id: i % 2 ? 'a' : 'b' } }));
    await client.upsertPoints('c', pts);
    const all = await client.scrollAll('c', { must: [{ key: 'site_id', match: { value: 'a' } }] }, ['site_id']);
    expect(all).toHaveLength(300);
    expect(q.count('POST', /\/points\/scroll$/)).toBe(2);
    await client.deletePoints('c', all.map((p) => String(p.id)));
    expect((await client.getCollection('c')).pointsCount).toBe(300);
    await client.deleteByFilter('c', { must: [{ key: 'site_id', match: { value: 'b' } }] });
    expect((await client.getCollection('c')).pointsCount).toBe(0);
  });

  it('reports non-2xx as QdrantError with status and redacted body; 401 is PERMISSION_DENIED', async () => {
    const f = fakeFetch([
      match('GET', `${BASE}/collections/x/exists`, () => new Response('Invalid api-key synthetic-registered-qdrant-key-abcdefghij123', { status: 401 })),
      match('GET', `${BASE}/collections/y/exists`, () => new Response('boom', { status: 500 })),
      match('GET', `${BASE}/collections/z/exists`, () => jsonResponse({ status: { error: 'nope' } })),
    ]);
    registerSecret('synthetic-registered-qdrant-key-abcdefghij123');
    const client = new QdrantClient({ baseUrl: BASE, fetch: f, retryPolicy: NO_RETRY });
    const e1 = await client.collectionExists('x').catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(QdrantError);
    expect((e1 as AppError).code).toBe('PERMISSION_DENIED');
    expect((e1 as QdrantError).httpStatus).toBe(401);
    expect((e1 as Error).message).not.toContain('abcdefghij123');
    await expect(client.collectionExists('y')).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE', httpStatus: 500 });
    await expect(client.collectionExists('z')).rejects.toBeInstanceOf(QdrantError);
  });

  it('retries idempotent requests on 5xx within the bounded policy', async () => {
    let n = 0;
    const f = fakeFetch([match('GET', `${BASE}/collections/c/exists`, () => (++n < 3 ? new Response('busy', { status: 503 }) : jsonResponse({ status: 'ok', time: 0, result: { exists: true } })))]);
    const client = new QdrantClient({ baseUrl: BASE, fetch: f, retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, jitter: 0 } });
    expect(await client.collectionExists('c')).toBe(true);
    expect(n).toBe(3);
  });

  it('health never throws: plain-text healthz, unauthenticated, version check', async () => {
    const q = new FakeQdrant({ apiKey: 'synthetic-qdrant-key-000' });
    const client = new QdrantClient({ baseUrl: BASE, apiKey: 'synthetic-qdrant-key-000', fetch: q.fetch, retryPolicy: NO_RETRY });
    const h = await client.health();
    expect(h).toMatchObject({ ok: true, version: '1.19.1', versionWarning: null });
    expect(q.requests[0]!.path).toBe('/healthz');
    expect(q.requests[0]!.headers['api-key']).toBeUndefined();
    q.version = '1.25.0';
    expect((await client.health()).versionWarning).toMatch(/1\.19/);
    q.down = true;
    const down = await client.health();
    expect(down.ok).toBe(false);
    expect(down.detail).toMatch(/fetch failed|ECONNREFUSED/);
  });

  it('validates the base URL and flags insecure API-key transport', () => {
    expect(() => new QdrantClient({ baseUrl: 'ftp://x', fetch: async () => new Response('') })).toThrow(AppError);
    expect(() => new QdrantClient({ baseUrl: 'http://user:pass@127.0.0.1:6333', fetch: async () => new Response('') })).toThrow(/credentials/);
    expect(isLoopbackUrl('http://127.0.0.1:6333')).toBe(true);
    expect(isLoopbackUrl('http://localhost:6333')).toBe(true);
    expect(insecureApiKeyTransport('http://qdrant.internal.test:6333', 'k')).toBe(true);
    expect(insecureApiKeyTransport('https://qdrant.internal.test:6333', 'k')).toBe(false);
    expect(insecureApiKeyTransport('http://127.0.0.1:6333', 'k')).toBe(false);
    expect(insecureApiKeyTransport('http://qdrant.internal.test:6333', null)).toBe(false);
    expect(isLoopbackUrl('http://127.evil.example:6333')).toBe(false);
  });

  it('refuses to create a client that would send QDRANT_API_KEY over plain http to a non-loopback host', async () => {
    const q = new FakeQdrant();
    expect(() => new QdrantClient({ baseUrl: 'http://qdrant.internal.test:6333', apiKey: 'synthetic-qdrant-key-000', fetch: q.fetch })).toThrow(/plain HTTP to a non-loopback host/);
    expect(q.requests).toHaveLength(0); // nothing was sent
    // https, loopback, or no key are fine (defaults: local Qdrant on 127.0.0.1).
    expect(() => new QdrantClient({ baseUrl: 'https://qdrant.internal.test:6333', apiKey: 'synthetic-qdrant-key-000', fetch: q.fetch })).not.toThrow();
    expect(() => new QdrantClient({ baseUrl: 'http://127.0.0.1:6333', apiKey: 'synthetic-qdrant-key-000', fetch: q.fetch })).not.toThrow();
    expect(() => new QdrantClient({ baseUrl: 'http://qdrant.internal.test:6333', fetch: q.fetch })).not.toThrow();
  });
  it('refuses query, scroll, and delete-by-filter without a site_id filter (website isolation)', async () => {
    const q = new FakeQdrant();
    const client = new QdrantClient({ baseUrl: BASE, fetch: q.fetch, retryPolicy: NO_RETRY });
    await client.createCollection('c', 2);
    const before = q.requests.length;
    await expect(client.query('c', { vector: [1, 0], filter: {}, limit: 5 })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(client.scroll('c', { filter: { must: [{ key: 'status', match: { value: 'active' } }] } })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(client.deleteByFilter('c', { should: [{ key: 'site_id', match: { value: 's' } }] })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(q.requests.length).toBe(before); // nothing was sent
  });
});
