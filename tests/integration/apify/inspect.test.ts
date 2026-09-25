import { afterEach, describe, expect, it } from 'vitest';
import { findSchemaForBuild, inspectActor, listStoredSchemas, missingRequiredOutputFields, readmeProvenance, resolveRunnableSchema } from '../../../src/integrations/apify/schema.js';
import { ACTOR_ID, BUILD_ID, FakeApify, OUTPUT_FIELDS, SYNTHETIC_README, TEST_TOKEN, buildObject, fixtureSchema } from '../../fixtures/apify/fake-apify.js';
import { apifyContext, type ApifyTestSetup } from './apify-context.js';

const noSleep = { clientOptions: { sleep: async () => {} } };

describe('apify inspect (free reads)', () => {
  let s: ApifyTestSetup;
  afterEach(() => s?.ctx.cleanup());

  it('confirms identity, pricing, latest build, and stores the verified schema with its hash', async () => {
    s = apifyContext({ build: null });
    const r = await inspectActor(s.ctx, noSleep);
    expect(r.identity).toMatchObject({ id: ACTOR_ID, username: 'harshmaur', name: 'reddit-scraper' });
    expect(r.identityWarnings).toEqual([]);
    expect(r.pricing?.model).toBe('PAY_PER_EVENT');
    expect(r.pricing?.startedAt).toBe('2026-08-10T14:51:28.574Z');
    expect(r.latestBuild).toMatchObject({ buildId: BUILD_ID, buildNumber: '0.0.513', status: 'SUCCEEDED', schemaSource: 'build', verified: true });
    expect(r.latestBuild?.compatibility?.ok).toBe(true);
    expect(r.latestBuild?.outputSchema?.missingUsedFields).toEqual([]);
    expect(r.latestBuild?.outputSchema?.fieldCount).toBeGreaterThan(20);
    expect(r.pinnedBuild.configured).toBeNull();
    expect(r.nextSteps.join('\n')).toMatch(/research\.apify\.build: "0\.0\.513"/);
    const rows = listStoredSchemas(s.ctx.db, ACTOR_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'api', verified: true, buildNumber: '0.0.513', buildId: BUILD_ID });
    expect(rows[0]!.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.pricing?.pricingInfos).toHaveLength(3);
    // Unpinned: runs are refused.
    expect(resolveRunnableSchema(s.ctx)).toMatchObject({ ok: false, state: 'misconfigured' });
    // Free reads are logged, the token is only a header, and nothing chargeable was called.
    for (const c of s.fake.calls) {
      expect(c.method).toBe('GET');
      expect(c.url).not.toContain(TEST_TOKEN);
      expect(c.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    }
    const logged = s.ctx.db.all<{ endpoint: string; is_paid: number; status: string }>('SELECT endpoint, is_paid, status FROM provider_requests WHERE site_id = ?', [s.ctx.siteId]);
    expect(logged.map((l) => l.endpoint)).toEqual(expect.arrayContaining(['apify.actor.get', 'apify.build.get']));
    expect(logged.every((l) => l.is_paid === 0 && l.status === 'succeeded')).toBe(true);
  });

  it('works without a token for public reads and says a token is needed for runs', async () => {
    s = apifyContext({ build: null, noToken: true });
    const r = await inspectActor(s.ctx, noSleep);
    expect(r.tokenPresent).toBe(false);
    expect(s.fake.calls.every((c) => c.headers.authorization === undefined)).toBe(true);
    expect(r.nextSteps.join('\n')).toMatch(/APIFY_TOKEN is not set/);
  });

  it('marks the pinned build and makes it runnable', async () => {
    s = apifyContext({ build: '0.0.513' });
    const r = await inspectActor(s.ctx, noSleep);
    expect(r.pinnedBuild.resolved?.verified).toBe(true);
    expect(r.pinnedBuild.resolved?.pinned).toBe(true);
    const rs = resolveRunnableSchema(s.ctx);
    expect(rs.ok).toBe(true);
    if (rs.ok) expect(rs.row.pinned).toBe(true);
  });

  it('never treats a tag as a pin', async () => {
    s = apifyContext({ build: 'latest' });
    const r = await inspectActor(s.ctx, noSleep);
    expect(r.pinnedBuild.isBuildNumber).toBe(false);
    expect(r.pinnedBuild.note).toMatch(/not a build number/);
    const rs = resolveRunnableSchema(s.ctx);
    expect(rs.ok).toBe(false);
    if (!rs.ok) expect(rs.detail).toMatch(/tag/);
  });

  it('detects schema drift for a newer build before the pin is upgraded', async () => {
    const fake = new FakeApify();
    // Pinned older build 0.0.512 with the fixture schema.
    fake.builds.set('SYNBUILD000000512', buildObject({ id: 'SYNBUILD000000512', buildNumber: '0.0.512' }));
    // New latest build 0.0.513 adds a webhook field and a Slack delivery toggle.
    const next = fixtureSchema();
    next.properties.webhookUrl = { title: 'Webhook URL', type: 'string', description: 'Send results to this webhook', default: '' };
    next.properties.sendToSlack = { title: 'Send to Slack', type: 'boolean', default: false };
    fake.builds.set(BUILD_ID, buildObject({ schema: next }));
    s = apifyContext({ fake, build: '0.0.512' });
    const r = await inspectActor(s.ctx, noSleep);
    expect(r.pinnedBuild.resolved).toMatchObject({ buildNumber: '0.0.512', verified: true });
    expect(r.drift).toHaveLength(1);
    const d = r.drift[0]!;
    expect(d).toMatchObject({ fromBuild: '0.0.512', toBuild: '0.0.513' });
    expect(d.diff.added).toEqual(['sendToSlack', 'webhookUrl']);
    expect(d.compatibility.forcedOff.map((f) => f.field)).toContain('sendToSlack');
    expect(d.compatibility.keptAbsent.map((f) => f.field)).toContain('webhookUrl');
    const audit = s.ctx.db.all<{ event_type: string }>(`SELECT event_type FROM audit_events WHERE event_type = 'apify.schema_drift'`);
    expect(audit).toHaveLength(1);
    // The pinned build stays runnable; the new build is stored but not pinned.
    const rs = resolveRunnableSchema(s.ctx);
    expect(rs.ok && rs.build).toBe('0.0.512');
    expect(findSchemaForBuild(s.ctx.db, ACTOR_ID, '0.0.513')?.pinned).toBe(false);
  });

  it('falls back to the build OpenAPI definition when inputSchema is missing', async () => {
    const fake = new FakeApify();
    fake.builds.set(BUILD_ID, buildObject({ inputSchema: null }));
    fake.openapi.set(BUILD_ID, { openapi: '3.0.1', servers: [{ url: 'https://api.apify.com/v2' }], components: { schemas: { inputSchema: fixtureSchema() } } });
    s = apifyContext({ fake });
    const r = await inspectActor(s.ctx, noSleep);
    expect(r.latestBuild).toMatchObject({ schemaSource: 'openapi', verified: true });
  });

  it('reports an unresolved integration (with the import path) when no schema is accessible', async () => {
    const fake = new FakeApify();
    fake.builds.set(BUILD_ID, buildObject({ inputSchema: null }));
    s = apifyContext({ fake });
    const r = await inspectActor(s.ctx, noSleep);
    expect(r.latestBuild?.schemaSource).toBe('unavailable');
    expect(r.unresolved.join('\n')).toMatch(/not accessible/);
    expect(r.nextSteps.join('\n')).toMatch(/apify import-schema/);
    expect(listStoredSchemas(s.ctx.db, ACTOR_ID)).toHaveLength(0);
    expect(resolveRunnableSchema(s.ctx).ok).toBe(false);
  });

  it('stores a changed schema for the same immutable build as unverified and refuses runs', async () => {
    s = apifyContext({ build: '0.0.513' });
    await inspectActor(s.ctx, noSleep);
    const changed = fixtureSchema();
    changed.properties.maxPostsCount.maximum = 10;
    s.fake.builds.set(BUILD_ID, buildObject({ schema: changed }));
    s.ctx.clock.advanceMs(60_000);
    const r = await inspectActor(s.ctx, noSleep);
    expect(r.latestBuild?.verified).toBe(false);
    expect(r.latestBuild?.problems.join(' ')).toMatch(/immutable build/);
    expect(resolveRunnableSchema(s.ctx).ok).toBe(false);
  });

  it('reconfirms the output schema: missing dataset fields the normalizer reads are reported', async () => {
    const fake = new FakeApify();
    fake.builds.set(BUILD_ID, buildObject({ outputFields: ['dataType', 'id', 'title'] }));
    s = apifyContext({ fake });
    const r = await inspectActor(s.ctx, noSleep);
    expect(r.latestBuild?.outputSchema?.missingUsedFields).toContain('postUrl');
    expect(r.latestBuild?.problems.join(' ')).toMatch(/output schema lacks fields/);
    s.ctx.cleanup();
    const none = new FakeApify();
    none.builds.set(BUILD_ID, buildObject({ outputFields: null }));
    s = apifyContext({ fake: none });
    const r2 = await inspectActor(s.ctx, noSleep);
    expect(r2.latestBuild?.outputSchema).toBeNull();
    expect(r2.latestBuild?.problems.join(' ')).toMatch(/output fields are unconfirmed/);
  });

  it('does not verify a build that belongs to another actor or did not succeed', async () => {
    const fake = new FakeApify();
    fake.builds.set(BUILD_ID, buildObject({ actId: 'SomeOtherActor123', status: 'SUCCEEDED' }));
    s = apifyContext({ fake });
    const r = await inspectActor(s.ctx, noSleep);
    expect(r.latestBuild?.verified).toBe(false);
    expect(r.latestBuild?.problems.join(' ')).toMatch(/belongs to actor/);
  });

  it('warns when the live identity differs from the listing (the ID stays authoritative)', async () => {
    const fake = new FakeApify();
    fake.actor = { ...fake.actor, username: 'someone-else', isDeprecated: true };
    s = apifyContext({ fake });
    const r = await inspectActor(s.ctx, noSleep);
    expect(r.identityWarnings.join('\n')).toMatch(/authoritative/);
    expect(r.identityWarnings.join('\n')).toMatch(/deprecated/);
  });

  it('refuses to inspect offline (no network attempt)', async () => {
    s = apifyContext();
    s.ctx.offline = true;
    await expect(inspectActor(s.ctx, noSleep)).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE' });
    expect(s.fake.calls).toHaveLength(0);
  });
});

describe('apify inspect: README provenance and output-schema blockers (A5-04, A5-08)', () => {
  let s: ApifyTestSetup;
  afterEach(() => s?.ctx.cleanup());

  it('hashes the build README and its load-bearing passages and stores them with the schema row (never the text)', async () => {
    s = apifyContext({ build: '0.0.513' });
    const r = await inspectActor(s.ctx, noSleep);
    expect(r.latestBuild?.readme).toMatchObject({ retrievedAt: '2026-09-24T09:00:00.000Z', length: SYNTHETIC_README.length });
    expect(r.latestBuild?.readme?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.values(r.latestBuild!.readme!.passages).every((h) => typeof h === 'string')).toBe(true);
    const row = findSchemaForBuild(s.ctx.db, ACTOR_ID, '0.0.513')!;
    expect(row.provenance?.readme?.sha256).toBe(r.latestBuild?.readme?.sha256);
    expect(row.provenance?.outputSchema).toMatchObject({ missingRequired: [], checkedAt: '2026-09-24T09:00:00.000Z' });
    const raw = s.ctx.db.get<{ provenance_json: string }>('SELECT provenance_json FROM apify_actor_schemas WHERE id = ?', [row.id])!.provenance_json;
    expect(raw).not.toContain('maxPostsCount: 10'); // hashes only
    expect(r.readmeDrift).toBeNull(); // pinned == latest
  });

  it('reports README drift between the pinned and the latest build and flags load-bearing passages', async () => {
    const fake = new FakeApify();
    fake.builds.set('SYNBUILD000000512', buildObject({ id: 'SYNBUILD000000512', buildNumber: '0.0.512' }));
    fake.builds.set(BUILD_ID, buildObject({ readme: SYNTHETIC_README.replace('(per searchTerms keyword)', '(total across all inputs)') }));
    s = apifyContext({ fake, build: '0.0.512' });
    const r = await inspectActor(s.ctx, noSleep);
    expect(r.readmeDrift).toMatchObject({ fromBuild: '0.0.512', toBuild: '0.0.513', changed: true });
    expect(r.readmeDrift!.passagesChanged.map((p) => p.key)).toEqual(['maxPostsCount']);
    expect(r.readmeDrift!.note).toMatch(/load-bearing passages/);
    expect(s.ctx.db.get(`SELECT id FROM audit_events WHERE event_type = 'apify.readme_drift'`)).toBeTruthy();
  });

  it('a README edit outside the load-bearing passages is reported as a change without flagged passages', async () => {
    const fake = new FakeApify();
    fake.builds.set('SYNBUILD000000512', buildObject({ id: 'SYNBUILD000000512', buildNumber: '0.0.512' }));
    fake.builds.set(BUILD_ID, buildObject({ readme: SYNTHETIC_README.replace('Synthetic changelog line.', 'Another synthetic changelog line.') }));
    s = apifyContext({ fake, build: '0.0.512' });
    const r = await inspectActor(s.ctx, noSleep);
    expect(r.readmeDrift).toMatchObject({ changed: true, passagesChanged: [] });
  });

  it('a build without a README is a problem (documentation not reconfirmed), not silently accepted', async () => {
    const fake = new FakeApify();
    fake.builds.set(BUILD_ID, buildObject({ readme: null }));
    s = apifyContext({ fake, build: '0.0.513' });
    const r = await inspectActor(s.ctx, noSleep);
    expect(r.latestBuild?.readme).toBeNull();
    expect(r.latestBuild?.problems.join(' ')).toMatch(/no README/);
  });

  it('treats required output fields missing from the dataset schema as a run blocker', async () => {
    expect(missingRequiredOutputFields(['dataType', 'id', 'body', 'url', 'createdAt'])).toEqual([]);
    expect(missingRequiredOutputFields(['dataType', 'id', 'createdAt'])).toEqual(['title/body', 'postUrl/url']);
    const fake = new FakeApify();
    fake.builds.set(BUILD_ID, buildObject({ outputFields: OUTPUT_FIELDS.filter((f) => f !== 'createdAt') }));
    s = apifyContext({ fake, build: '0.0.513' });
    const r = await inspectActor(s.ctx, noSleep);
    expect(r.latestBuild?.blockers?.[0]).toMatch(/output schema drift: .*createdAt/);
    expect(r.unresolved.join('\n')).toMatch(/Build 0\.0\.513: output schema drift/);
    const rs = resolveRunnableSchema(s.ctx);
    expect(rs.ok).toBe(false);
    if (!rs.ok) expect(rs.detail).toMatch(/lacks required field\(s\) createdAt/);
  });

  it('readmeProvenance marks a missing passage as null', () => {
    const p = readmeProvenance('# Synthetic\nNothing load-bearing here.', new Date('2026-09-24T09:00:00Z'));
    expect(p.passages).toEqual({ maxPostsCount: null, runSummary: null, dedupeKey: null });
  });
});
