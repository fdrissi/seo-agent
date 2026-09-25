import { afterEach, describe, expect, it } from 'vitest';
import { DATAFORSEO_HOSTS, createDataForSeoClient } from '../../../src/integrations/dataforseo/client.js';
import { AppError } from '../../../src/core/errors.js';
import { fakeFetch, jsonResponse, match } from '../../helpers/fake-fetch.js';
import type { TestContext } from '../../helpers/context.js';
import { SYNTHETIC_TOKEN, clockSleep, dfsConfig, dfsContext, fakeDataForSeo, fixture } from './helpers.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    return (e as AppError).code;
  }
  return undefined;
}

describe('DataForSEO client', () => {
  it('sends HTTP Basic auth to the live host for free GETs and logs a non-paid provider request', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch });
    const client = createDataForSeoClient(ctx);
    expect(client.mode).toBe('live');
    expect(client.baseUrl).toBe(DATAFORSEO_HOSTS.live);
    await client.getFree('serp/google/languages');
    const call = fake.fetch.calls[0]!;
    expect(call.url).toBe('https://api.dataforseo.com/v3/serp/google/languages');
    expect(call.headers.authorization).toBe(`Basic ${SYNTHETIC_TOKEN}`);
    expect(call.url).not.toContain('synthetic-password');
    const pr = ctx.db.get<{ is_paid: number; status: string; endpoint: string }>('SELECT is_paid, status, endpoint FROM provider_requests WHERE site_id = ?', [ctx.siteId])!;
    expect(pr).toMatchObject({ is_paid: 0, status: 'succeeded', endpoint: 'serp/google/languages' });
  });

  it('uses the sandbox host when config mode is sandbox or --sandbox is requested (sandbox still needs Basic auth)', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch, config: dfsConfig({ dataforseo: { mode: 'sandbox' } }) });
    const c1 = createDataForSeoClient(ctx);
    expect(c1.baseUrl).toBe(DATAFORSEO_HOSTS.sandbox);
    expect(c1.isSandbox).toBe(true);
    await c1.getFree('serp/google/languages');
    expect(fake.fetch.calls[0]!.url.startsWith('https://sandbox.dataforseo.com/v3/')).toBe(true);
    expect(fake.fetch.calls[0]!.headers.authorization).toMatch(/^Basic /);
  });

  it('never upgrades to live from an option when config is not live', async () => {
    ctx = dfsContext({ fetch: fakeDataForSeo().fetch, config: dfsConfig({ dataforseo: { mode: 'sandbox' } }) });
    expect(await codeOf(() => createDataForSeoClient(ctx!, { mode: 'live' }))).toBe('POLICY_DENIED');
    expect(createDataForSeoClient(ctx, { mode: 'sandbox' }).isSandbox).toBe(true);
  });

  it('reports disabled, missing-credential, and offline states honestly', async () => {
    ctx = dfsContext({ fetch: fakeDataForSeo().fetch, config: dfsConfig({ dataforseo: { mode: 'disabled' } }) });
    expect(await codeOf(() => createDataForSeoClient(ctx!))).toBe('INTEGRATION_DISABLED');
    ctx.cleanup();
    ctx = dfsContext({ fetch: fakeDataForSeo().fetch, config: dfsConfig({ features: { dataforseo: false } }) });
    expect(await codeOf(() => createDataForSeoClient(ctx!, { mode: 'sandbox' }))).toBe('INTEGRATION_DISABLED');
    ctx.cleanup();
    ctx = dfsContext({ fetch: fakeDataForSeo().fetch, credentials: false });
    expect(await codeOf(() => createDataForSeoClient(ctx!))).toBe('CREDENTIALS_MISSING');
    ctx.cleanup();
    ctx = dfsContext({}); // offline test context
    expect(await codeOf(() => createDataForSeoClient(ctx!))).toBe('INTEGRATION_UNAVAILABLE');
  });

  it('raises response-level errors that arrive inside HTTP 200 and does not retry non-retryable ones', async () => {
    const f = fakeFetch([match('GET', /languages$/, () => jsonResponse({ status_code: 40501, status_message: 'Invalid Field. (synthetic)', cost: 0, tasks: [] }))]);
    ctx = dfsContext({ fetch: f });
    const client = createDataForSeoClient(ctx, { sleep: clockSleep(ctx) });
    const err = await client.getFree('serp/google/languages').catch((e) => e);
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.level).toBe('response');
    expect(f.calls).toHaveLength(1);
    expect(ctx.db.get<{ status: string }>('SELECT status FROM provider_requests')!.status).toBe('failed');
  });

  it('retries free GETs on rate limits inside HTTP 200, then succeeds', async () => {
    let n = 0;
    const f = fakeFetch([
      match('GET', /languages$/, () => (++n < 2 ? jsonResponse({ status_code: 40202, status_message: 'Rate limit (synthetic)', cost: 0, tasks: [] }) : jsonResponse(fixture('languages.json')))),
    ]);
    ctx = dfsContext({ fetch: f });
    const client = createDataForSeoClient(ctx, { sleep: clockSleep(ctx) });
    const r = await client.getFree<{ language_code: string }>('serp/google/languages');
    expect(r.envelope.tasks[0]!.result!.length).toBe(2);
    expect(f.calls).toHaveLength(2);
  });

  it('maps HTTP 401 to PERMISSION_DENIED with an actionable hint', async () => {
    const f = fakeFetch([match('GET', /user_data$/, () => jsonResponse(fixture('unauthorized-401.json'), 401))]);
    ctx = dfsContext({ fetch: f });
    const err = await createDataForSeoClient(ctx).getFree('appendix/user_data').catch((e) => e);
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.hint).toMatch(/api-access/);
  });

  it('refuses to use getFree for paid endpoints', async () => {
    ctx = dfsContext({ fetch: fakeDataForSeo().fetch });
    expect(await codeOf(createDataForSeoClient(ctx).getFree('serp/google/organic/task_post'))).toBe('POLICY_DENIED');
  });
});
