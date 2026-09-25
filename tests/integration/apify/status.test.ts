import { afterEach, describe, expect, it } from 'vitest';
import { apifyStatus } from '../../../src/integrations/apify/status.js';
import { importActorSchema } from '../../../src/integrations/apify/schema.js';
import { ApifyClient } from '../../../src/integrations/apify/client.js';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BUILD_ID, buildObject, fixtureSchema } from '../../fixtures/apify/fake-apify.js';
import { apifyContext, inspected, type ApifyTestSetup } from './apify-context.js';

describe('apifyStatus', () => {
  let s: ApifyTestSetup;
  afterEach(() => s?.ctx.cleanup());

  it('reports disabled, missing credentials, and an unpinned build without network', async () => {
    s = apifyContext({ features: { apify: false } });
    expect((await apifyStatus(s.ctx, { network: true })).state).toBe('disabled');
    s.ctx.cleanup();
    s = apifyContext({ noToken: true });
    const m = await apifyStatus(s.ctx, { network: true });
    expect(m.state).toBe('missing_credentials');
    expect(m.nextStep).toMatch(/secrets\.env/);
    s.ctx.cleanup();
    s = apifyContext({ build: null });
    const u = await apifyStatus(s.ctx, { network: true });
    expect(u.state).toBe('misconfigured');
    expect(u.nextStep).toMatch(/apify inspect/);
    expect(s.fake.calls).toHaveLength(0);
    expect(u.chargeable).toBe(false);
    expect(u.sendsExternally.join(' ')).toMatch(/Never sent: Google, LLM Gateway, CMS/);
  });

  it('flags an imported, unverified schema as an unresolved integration', async () => {
    s = apifyContext({ build: '0.0.513' });
    const f = path.join(s.ctx.paths.root, 'schema.json');
    writeFileSync(f, JSON.stringify(fixtureSchema()));
    importActorSchema(s.ctx, f, { build: '0.0.513' });
    const st = await apifyStatus(s.ctx, { network: false });
    expect(st.state).toBe('misconfigured');
    expect(st.detail).toMatch(/unresolved/);
  });

  it('is configured_unverified without network and ready after free network checks', async () => {
    s = await inspected();
    const offline = await apifyStatus(s.ctx, { network: false });
    expect(offline).toMatchObject({ state: 'configured_unverified', networkChecked: false });
    expect(s.fake.calls).toHaveLength(0);
    const live = await apifyStatus(s.ctx, { network: true, client: new ApifyClient({ token: 'apify_api_SYNTHETICTESTTOKEN0000000000000000', fetch: s.fake.fetch, sleep: async () => {} }) });
    expect(live).toMatchObject({ state: 'ready', networkChecked: true, chargeable: false });
    expect(s.fake.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('reports a rejected token, a newer build, and pinned-build drift', async () => {
    s = await inspected();
    // The live API answers an unknown token with 401 invalid-token.
    s.fake.acceptedToken = 'apify_api_SYNTHETICOTHERTOKEN000000000000000';
    const rejected = await apifyStatus(s.ctx, { network: true });
    expect(rejected).toMatchObject({ state: 'misconfigured', networkChecked: true });
    expect(rejected.detail).toMatch(/APIFY_TOKEN was rejected/);
    expect(rejected.nextStep).toMatch(/Rotate\/create a token/);
    s.fake.acceptedToken = undefined;
    // No token at all: 401 token-not-provided.
    const none = new ApifyClient({ token: undefined, fetch: s.fake.fetch, sleep: async () => {} });
    const missing = await apifyStatus(s.ctx, { network: true, client: none });
    expect(missing.state).toBe('misconfigured');
    expect(missing.nextStep).toMatch(/Set APIFY_TOKEN/);

    s.fake.actor = { ...s.fake.actor, taggedBuilds: { latest: { buildId: 'SYNBUILD000000514', buildNumber: '0.0.514' } } };
    const newer = await apifyStatus(s.ctx, { network: true });
    expect(newer.state).toBe('ready');
    expect(newer.detail).toMatch(/newer build \(0\.0\.514\)/);

    const changed = fixtureSchema();
    changed.properties.maxPostsCount.maximum = 5;
    s.fake.builds.set(BUILD_ID, buildObject({ schema: changed }));
    expect((await apifyStatus(s.ctx, { network: true })).state).toBe('misconfigured');
  });

  it('returns fixture state in demo mode', async () => {
    s = apifyContext({ profile: 'demo' });
    expect((await apifyStatus(s.ctx, { network: true })).state).toBe('fixture');
  });
});
