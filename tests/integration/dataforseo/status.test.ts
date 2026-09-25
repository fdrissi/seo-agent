import { afterEach, describe, expect, it } from 'vitest';
import { dataforseoStatus } from '../../../src/integrations/dataforseo/status.js';
import { fakeFetch, jsonResponse, match } from '../../helpers/fake-fetch.js';
import type { TestContext } from '../../helpers/context.js';
import { SYNTHETIC_LOGIN, dfsConfig, dfsContext, fakeDataForSeo, fixture } from './helpers.js';
import { createSyntheticDataForSeoFetch } from '../../../src/integrations/dataforseo/synthetic.js';
import { collectStatuses, createServices } from '../../../src/app/services.js';
import { levelForState } from '../../../src/setup/doctor.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

describe('dataforseoStatus', () => {
  it('is disabled when the config mode is disabled (with an actionable next step)', async () => {
    ctx = dfsContext({ fetch: fakeDataForSeo().fetch, config: dfsConfig({ dataforseo: { mode: 'disabled' } }) });
    const s = await dataforseoStatus(ctx, { network: true });
    expect(s).toMatchObject({ state: 'disabled', networkChecked: false, chargeable: false });
    expect(s.nextStep).toMatch(/sandbox/);
  });

  it('reports missing credentials without any request', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch, credentials: false });
    const s = await dataforseoStatus(ctx, { network: true });
    expect(s.state).toBe('missing_credentials');
    expect(s.nextStep).toMatch(/secrets\.env/);
    expect(fake.fetch.calls).toHaveLength(0);
  });

  it('is configured_unverified without a network check', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch });
    const s = await dataforseoStatus(ctx, { network: false });
    expect(s.state).toBe('configured_unverified');
    expect(fake.fetch.calls).toHaveLength(0);
    expect(s.sendsExternally.length).toBeGreaterThan(0);
    expect(s.pricing.find((p) => p.key === 'serp.google.organic.standard')?.status).toBe('documented');
  });

  it('network check uses only the free user_data GET, never a paid endpoint, and never prints the login', async () => {
    const fake = fakeDataForSeo();
    ctx = dfsContext({ fetch: fake.fetch });
    const s = await dataforseoStatus(ctx, { network: true });
    expect(s).toMatchObject({ state: 'ready', networkChecked: true, chargeable: false, accountBalanceUsd: '12.3456' });
    expect(fake.fetch.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET https://api.dataforseo.com/v3/appendix/user_data']);
    expect(JSON.stringify(s)).not.toContain(SYNTHETIC_LOGIN);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM budget_reservations')!.n).toBe(0);
  });

  it('maps a 401 to permission_denied', async () => {
    ctx = dfsContext({ fetch: fakeFetch([match('GET', /user_data$/, () => jsonResponse(fixture('unauthorized-401.json'), 401))]) });
    const s = await dataforseoStatus(ctx, { network: true });
    expect(s.state).toBe('permission_denied');
    expect(s.nextStep).toMatch(/api-access/);
  });

  it('reports unreachable on network failure', async () => {
    ctx = dfsContext({ fetch: fakeFetch([]) });
    const s = await dataforseoStatus(ctx, { network: true, sleep: async () => {} });
    expect(s.state).toBe('unreachable');
  });

  it('lists unrecognized pricingOverrides keys as pricing warnings', async () => {
    ctx = dfsContext({ fetch: fakeDataForSeo().fetch, config: dfsConfig({ dataforseo: { pricingOverrides: { 'serp/google/organic/standard': '0.0006', 'serp/google/organic/task_post': '0.0006' } } }) });
    const s = await dataforseoStatus(ctx, { network: false });
    expect(s.pricingWarnings).toHaveLength(1);
    expect(s.pricingWarnings[0]).toMatch(/"serp\/google\/organic\/standard"\] is not a recognized price key/);
    // The accepted alias shows up as a verified override.
    expect(s.pricing.find((p) => p.key === 'serp.google.organic.standard')).toMatchObject({ status: 'verified_config' });
  });

  it('--offline with configured credentials is "disabled" (doctor INFO: network access disabled), never misconfigured (D2-ACC-07)', async () => {
    ctx = dfsContext({}); // offline context; credentials and live mode are configured
    for (const network of [false, true]) {
      const s = await dataforseoStatus(ctx, { network });
      expect(s.state).toBe('disabled');
      expect(levelForState(s.state)).toBe('info');
      expect(s.detail).toMatch(/network access disabled \(--offline\)/);
      expect(s.detail).not.toMatch(/misconfigured|missing/i);
      expect(s.nextStep).toMatch(/^Run without --offline/);
      expect(s.networkChecked).toBe(false);
      expect(JSON.stringify(s)).not.toContain(SYNTHETIC_LOGIN);
    }
    // Real configuration problems still win over the offline switch.
    ctx.cleanup();
    ctx = dfsContext({ credentials: false });
    expect((await dataforseoStatus(ctx, { network: false })).state).toBe('missing_credentials');
    ctx.cleanup();
    ctx = dfsContext({ config: dfsConfig({ dataforseo: { mode: 'disabled' } }) });
    expect((await dataforseoStatus(ctx, { network: false })).state).toBe('disabled');
    expect((await dataforseoStatus(ctx, { network: false })).detail).toMatch(/research\.dataforseo\.mode is "disabled"/);
  });

  it('the statuses an offline doctor / vault render collect say "disabled (--offline)" for DataForSEO, not misconfigured', async () => {
    ctx = dfsContext({});
    const statuses = await collectStatuses(ctx, createServices(ctx, { googleProvider: null }), { network: true, only: ['dataforseo'] });
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ id: 'dataforseo', state: 'disabled', networkChecked: false });
    expect(statuses[0]!.detail).toMatch(/network access disabled \(--offline\)/);
  });

  it('reports fixture state for the synthetic transport', async () => {
    ctx = dfsContext({ fetch: fakeDataForSeo().fetch });
    const s = await dataforseoStatus(ctx, { network: true, mode: 'fixture', fetch: createSyntheticDataForSeoFetch() });
    expect(s.state).toBe('fixture');
    expect(s.isSandbox).toBe(true);
  });
});
