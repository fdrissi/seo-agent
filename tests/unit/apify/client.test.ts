import { describe, expect, it } from 'vitest';
import { ApifyApiError, ApifyClient, ApifyTransportError } from '../../../src/integrations/apify/client.js';
import { offlineFetch } from '../../../src/integrations/types.js';
import { fakeFetch, jsonResponse, match } from '../../helpers/fake-fetch.js';
import { FakeApify, TEST_TOKEN, fixtureActor } from '../../fixtures/apify/fake-apify.js';

const noSleep = async () => {};

describe('ApifyClient', () => {
  it('sends the token only as a Bearer header, never in the URL', async () => {
    const fake = new FakeApify();
    const client = new ApifyClient({ token: TEST_TOKEN, fetch: fake.fetch, sleep: noSleep });
    await client.getActor('9sHOY9RzPYGjmTHo8');
    const call = fake.calls[0]!;
    expect(call.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(call.url).toBe('https://api.apify.com/v2/actors/9sHOY9RzPYGjmTHo8');
    expect(call.url).not.toContain(TEST_TOKEN);
  });

  it('omits the Authorization header when no token is configured (public free reads)', async () => {
    const fake = new FakeApify();
    const client = new ApifyClient({ token: undefined, fetch: fake.fetch, sleep: noSleep });
    const actor = await client.getActor('9sHOY9RzPYGjmTHo8');
    expect(actor.username).toBe('harshmaur');
    expect(fake.calls[0]!.headers.authorization).toBeUndefined();
  });

  it('converts username/name actor ids to the tilde path form', async () => {
    const f = fakeFetch([match('GET', /acts|actors/, () => jsonResponse({ data: fixtureActor() }))]);
    await new ApifyClient({ token: TEST_TOKEN, fetch: f, sleep: noSleep }).getActor('harshmaur/reddit-scraper');
    expect(f.calls[0]!.url).toBe('https://api.apify.com/v2/actors/harshmaur~reddit-scraper');
  });

  it('retries idempotent GETs on 429/5xx with backoff, and surfaces Apify error types', async () => {
    let n = 0;
    const f = fakeFetch([
      match('GET', /actor-runs/, () => {
        n++;
        if (n === 1) return jsonResponse({ error: { type: 'rate-limit-exceeded', message: 'slow down' } }, 429, { 'retry-after': '0' });
        if (n === 2) return jsonResponse({ error: { type: 'internal', message: 'oops' } }, 503);
        return jsonResponse({ data: { id: 'R1', status: 'RUNNING' } });
      }),
    ]);
    const sleeps: number[] = [];
    const client = new ApifyClient({ token: TEST_TOKEN, fetch: f, sleep: async (ms) => void sleeps.push(ms) });
    const run = await client.getRun('R1', { waitForFinish: 60 });
    expect(run.status).toBe('RUNNING');
    expect(n).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(f.calls[0]!.url).toContain('waitForFinish=60');

    const f404 = fakeFetch([match('GET', /actor-runs/, () => jsonResponse({ error: { type: 'record-not-found', message: 'Run not found' } }, 404))]);
    const err = await new ApifyClient({ token: TEST_TOKEN, fetch: f404, sleep: noSleep }).getRun('nope').catch((e) => e);
    expect(err).toBeInstanceOf(ApifyApiError);
    expect(err.httpStatus).toBe(404);
    expect(err.apifyErrorType).toBe('record-not-found');
    expect(f404.calls).toHaveLength(1);
  });

  it('never retries the paid run POST (5xx or transport errors)', async () => {
    const f500 = fakeFetch([match('POST', /\/runs/, () => jsonResponse({ error: { type: 'internal-error', message: 'x' } }, 500))]);
    const c = new ApifyClient({ token: TEST_TOKEN, fetch: f500, sleep: noSleep });
    const opts = { build: '0.0.513', timeoutSecs: 300, memoryMbytes: 1024, maxItems: 30, maxTotalChargeUsd: '0.08' };
    await expect(c.startRun('9sHOY9RzPYGjmTHo8', '{}', opts)).rejects.toBeInstanceOf(ApifyApiError);
    expect(f500.calls).toHaveLength(1);

    const fTimeout = fakeFetch([
      () => {
        throw Object.assign(new Error('aborted due to timeout'), { name: 'TimeoutError' });
      },
    ]);
    const e = await new ApifyClient({ token: TEST_TOKEN, fetch: fTimeout, sleep: noSleep }).startRun('9sHOY9RzPYGjmTHo8', '{}', opts).catch((x) => x);
    expect(e).toBeInstanceOf(ApifyTransportError);
    expect(e.sent).toBe(true);
    expect(e.timedOut).toBe(true);
    expect(fTimeout.calls).toHaveLength(1);

    const off = await new ApifyClient({ token: TEST_TOKEN, fetch: offlineFetch, sleep: noSleep }).startRun('9sHOY9RzPYGjmTHo8', '{}', opts).catch((x) => x);
    expect(off).toBeInstanceOf(ApifyTransportError);
    expect(off.sent).toBe(false);
  });

  it('starts a run with only verified query params and no webhooks', async () => {
    const fake = new FakeApify();
    const c = new ApifyClient({ token: TEST_TOKEN, fetch: fake.fetch, sleep: noSleep });
    const { run, httpStatus } = await c.startRun('9sHOY9RzPYGjmTHo8', '{"searchTerms":["a"]}', { build: '0.0.513', timeoutSecs: 300, memoryMbytes: 1024, maxItems: 30, maxTotalChargeUsd: '0.08' });
    expect(httpStatus).toBe(201);
    expect(run.id).toMatch(/^SYNRUN/);
    const u = new URL(fake.calls[0]!.url);
    expect(Object.fromEntries(u.searchParams)).toEqual({ build: '0.0.513', timeout: '300', memory: '1024', maxItems: '30', maxTotalChargeUsd: '0.08', restartOnError: '0', waitForFinish: '0' });
    expect(fake.calls[0]!.headers['content-type']).toBe('application/json');
  });

  it('paginates dataset items by offset/limit using pagination headers', async () => {
    const fake = new FakeApify();
    fake.datasets.set('DS1', Array.from({ length: 7 }, (_, i) => ({ dataType: 'post', id: `t3_${i}`, authorName: 'x' })));
    const c = new ApifyClient({ token: TEST_TOKEN, fetch: fake.fetch, sleep: noSleep });
    const r = await c.fetchAllDatasetItems('DS1', { pageSize: 3, maxItems: 100, fields: ['dataType', 'id'] });
    expect(r.complete).toBe(true);
    expect(r.total).toBe(7);
    expect(r.items).toHaveLength(7);
    expect(r.pages).toBe(3);
    const offsets = fake.calls.map((x) => new URL(x.url).searchParams.get('offset'));
    expect(offsets).toEqual(['0', '3', '6']);
    expect(new URL(fake.calls[0]!.url).searchParams.get('fields')).toBe('dataType,id');
    expect(new URL(fake.calls[0]!.url).searchParams.get('clean')).toBe('1');
    expect(JSON.stringify(r.items)).not.toContain('authorName');
  });

  it('advances by limit (not count) when clean pages are short, and stops on an empty page without a total header', async () => {
    const pages: Record<string, unknown[]> = { '0': [{ id: 1 }], '2': [{ id: 2 }, { id: 3 }], '4': [] };
    const f = fakeFetch([
      match('GET', /datasets/, (req) => {
        const off = new URL(req.url).searchParams.get('offset')!;
        return jsonResponse(pages[off] ?? []);
      }),
    ]);
    const r = await new ApifyClient({ token: TEST_TOKEN, fetch: f, sleep: noSleep }).fetchAllDatasetItems('DS', { pageSize: 2, maxItems: 10 });
    expect(r.items).toHaveLength(3);
    expect(r.complete).toBe(true);
    expect(f.calls.map((c) => new URL(c.url).searchParams.get('offset'))).toEqual(['0', '2', '4']);
  });

  it('returns a partial result (not an exception) when a page fails mid-way, and flags datasets above the bound', async () => {
    const fake = new FakeApify();
    fake.datasets.set('DS2', Array.from({ length: 6 }, (_, i) => ({ id: i })));
    fake.failDatasetOffsets.add(2);
    const c = new ApifyClient({ token: TEST_TOKEN, fetch: fake.fetch, sleep: noSleep, maxGetAttempts: 2 });
    const r = await c.fetchAllDatasetItems('DS2', { pageSize: 2, maxItems: 100 });
    expect(r.complete).toBe(false);
    expect(r.items).toHaveLength(2);
    expect(r.reason).toMatch(/failed after 2 items/);
    fake.failDatasetOffsets.clear();
    const big = await c.fetchAllDatasetItems('DS2', { pageSize: 2, maxItems: 4 });
    expect(big.complete).toBe(false);
    expect(big.reason).toMatch(/above the enforced bound/);
  });

  it('lists runs with verified query params and requires the token', async () => {
    const fake = new FakeApify();
    const c = new ApifyClient({ token: TEST_TOKEN, fetch: fake.fetch, sleep: noSleep });
    await c.listRuns('9sHOY9RzPYGjmTHo8', { limit: 10, status: ['SUCCEEDED', 'FAILED'], startedAfter: '2026-09-24T08:55:00.000Z' });
    const q = Object.fromEntries(new URL(fake.calls[0]!.url).searchParams);
    expect(q).toEqual({ offset: '0', limit: '10', desc: '1', status: 'SUCCEEDED,FAILED', startedAfter: '2026-09-24T08:55:00.000Z' });
    const anon = new ApifyClient({ token: undefined, fetch: fake.fetch, sleep: noSleep });
    const err = await anon.listRuns('9sHOY9RzPYGjmTHo8').catch((e) => e);
    expect(err).toBeInstanceOf(ApifyApiError);
    expect(err.httpStatus).toBe(401);
    expect(err.hint).toMatch(/APIFY_TOKEN/);
  });
});
