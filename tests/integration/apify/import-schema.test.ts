import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importActorSchema, inspectActor, listStoredSchemas, resolveRunnableSchema } from '../../../src/integrations/apify/schema.js';
import { runContentResearch } from '../../../src/integrations/apify/runs.js';
import { ACTOR_ID, BUILD_ID, FIXTURE_DIR, fixtureSchema } from '../../fixtures/apify/fake-apify.js';
import { RT, apifyContext, type ApifyTestSetup } from './apify-context.js';

describe('apify import-schema', () => {
  let s: ApifyTestSetup;
  afterEach(() => s?.ctx.cleanup());
  const write = (name: string, v: unknown) => {
    const f = path.join(s.ctx.paths.root, name);
    writeFileSync(f, JSON.stringify(v));
    return f;
  };

  it('stores a raw schema UNVERIFIED (integration unresolved) and runs stay refused', async () => {
    s = apifyContext({ build: '0.0.513' });
    const r = importActorSchema(s.ctx, write('schema.json', fixtureSchema()), { build: '0.0.513' });
    expect(r).toMatchObject({ status: 'unresolved', verified: false, kind: 'input_schema', propertyCount: 43, buildNumber: '0.0.513' });
    expect(r.compatibility.ok).toBe(true);
    expect(r.nextSteps.join('\n')).toMatch(/UNVERIFIED/);
    const rs = resolveRunnableSchema(s.ctx);
    expect(rs.ok).toBe(false);
    if (!rs.ok) expect(rs.detail).toMatch(/imported, unresolved/);
    const res = await runContentResearch(s.ctx, { runtime: RT });
    expect(res.status).toBe('misconfigured');
    expect(s.fake.calls).toHaveLength(0);
  });

  it('an API inspect of the same build later verifies it', async () => {
    s = apifyContext({ build: '0.0.513' });
    importActorSchema(s.ctx, write('schema.json', fixtureSchema()), { build: '0.0.513' });
    s.ctx.clock.advanceMs(1000);
    await inspectActor(s.ctx, { clientOptions: { sleep: async () => {} } });
    expect(resolveRunnableSchema(s.ctx).ok).toBe(true);
  });

  it('accepts an owner-attested build export (recorded in the audit log)', () => {
    s = apifyContext({ build: '0.0.513' });
    const file = write('build.json', { data: { id: BUILD_ID, actId: ACTOR_ID, buildNumber: '0.0.513', status: 'SUCCEEDED', inputSchema: JSON.stringify(fixtureSchema()) } });
    const r = importActorSchema(s.ctx, file, { attest: true });
    expect(r).toMatchObject({ status: 'attested', verified: true, kind: 'build', buildNumber: '0.0.513' });
    expect(resolveRunnableSchema(s.ctx).ok).toBe(true);
    const audit = s.ctx.db.get<{ details_json: string }>(`SELECT details_json FROM audit_events WHERE event_type = 'apify.schema_imported_attested'`);
    expect(JSON.parse(audit!.details_json)).toMatchObject({ attested: true, buildNumber: '0.0.513' });
  });

  it('imports an OpenAPI definition', () => {
    s = apifyContext({ build: null });
    const r = importActorSchema(s.ctx, write('openapi.json', { openapi: '3.0.1', components: { schemas: { inputSchema: fixtureSchema() } } }));
    expect(r.kind).toBe('openapi');
    expect(r.status).toBe('unresolved');
  });

  it('rejects an example input (never treated as the complete schema)', () => {
    s = apifyContext();
    expect(() => importActorSchema(s.ctx, path.join(FIXTURE_DIR, 'example-input.json'))).toThrow(/example input/);
    expect(listStoredSchemas(s.ctx.db, ACTOR_ID)).toHaveLength(0);
  });

  it('validates attestation, build numbers, and actor identity', () => {
    s = apifyContext();
    const raw = write('schema.json', fixtureSchema());
    expect(() => importActorSchema(s.ctx, raw, { attest: true })).toThrow(/requires the exact build number/);
    expect(() => importActorSchema(s.ctx, raw, { build: 'latest' })).toThrow(/not a build number/);
    const other = write('other.json', { data: { id: 'X', actId: 'AnotherActor0001', buildNumber: '1.0.0', inputSchema: JSON.stringify(fixtureSchema()) } });
    expect(() => importActorSchema(s.ctx, other)).toThrow(/belongs to actor AnotherActor0001/);
    const mismatch = write('b.json', { data: { id: 'Y', actId: ACTOR_ID, buildNumber: '0.0.500', inputSchema: JSON.stringify(fixtureSchema()) } });
    expect(() => importActorSchema(s.ctx, mismatch, { build: '0.0.513' })).toThrow(/does not match/);
    expect(() => importActorSchema(s.ctx, path.join(s.ctx.paths.root, 'missing.json'))).toThrow(/not found/);
  });
});
