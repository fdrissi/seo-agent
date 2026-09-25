import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ENV_ALLOWED_VALUES, ENV_KEYS } from '../../../src/config/env.js';
import { LayeredSecretStore, MemorySecretStore } from '../../../src/config/secrets.js';
import {
  GSC_DEFAULT_BASE,
  GSC_HOSTS,
  Pacer,
  GSC_SEARCH_ANALYTICS_MIN_INTERVAL_MS,
  canReadData,
  firstIncompleteDateOf,
  normalizeAggregation,
  normalizePermissionLevel,
  propertyAggregationFor,
  queryAllPages,
  resolveGscBaseUrl,
  similarProperties,
  urlBelongsToProperty,
  validateGscPropertyFormat,
  validateSearchAnalyticsRequest,
} from '../../../src/integrations/google/gsc-client.js';
import { segmentKeyOf } from '../../../src/integrations/google/gsc-sync.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { FAST_RETRY, ScriptedClient, SYNTHETIC_PROPERTY } from '../../integration/google/_helpers.js';

describe('Search Console request validation (documented rules)', () => {
  const base = { startDate: '2026-09-01', endDate: '2026-09-02' };
  it('accepts valid requests', () => {
    expect(() => validateSearchAnalyticsRequest({ ...base, dimensions: ['date', 'page', 'query'], aggregationType: 'byPage', rowLimit: 25000, startRow: 25000, dataState: 'all' })).not.toThrow();
    expect(() => validateSearchAnalyticsRequest({ ...base, dimensions: ['date'], aggregationType: 'byProperty', type: 'web' })).not.toThrow();
  });
  it('rejects documented invalid combinations', () => {
    const bad = (x: object) => () => validateSearchAnalyticsRequest({ ...base, ...x });
    expect(bad({ dimensions: ['page'], aggregationType: 'byProperty' })).toThrow(/byProperty/);
    expect(bad({ dimensionFilterGroups: [{ filters: [{ dimension: 'page', expression: 'https://x.test/' }] }], aggregationType: 'byProperty' })).toThrow(/byProperty/);
    expect(bad({ type: 'discover', aggregationType: 'byProperty' })).toThrow(/discover/);
    expect(bad({ dimensions: ['hour'], dataState: 'all' })).toThrow(/hourly_all/);
    expect(bad({ dimensions: ['searchAppearance', 'page'] })).toThrow(/searchAppearance/);
    expect(bad({ rowLimit: 25001 })).toThrow(/rowLimit/);
    expect(bad({ rowLimit: 0 })).toThrow(/rowLimit/);
    expect(bad({ startRow: -1 })).toThrow(/startRow/);
    expect(bad({ startDate: '2026-09-03' })).toThrow(/endDate/);
    expect(bad({ dimensions: ['date', 'date'] })).toThrow(/repeat/);
    expect(bad({ dimensionFilterGroups: [{ filters: [{ dimension: 'country', expression: 'ee' }] }] })).toThrow(/alpha-3/);
    expect(bad({ dimensionFilterGroups: [{ filters: [{ dimension: 'device', expression: 'PHONE' }] }] })).toThrow(/DESKTOP/);
    expect(bad({ dimensionFilterGroups: [{ filters: [{ dimension: 'query', expression: 'x'.repeat(4097) }] }] })).toThrow(/4096/);
    expect(bad({ dimensionFilterGroups: [{ groupType: 'or', filters: [] }] })).toThrow(/and/);
  });
  it('uses auto aggregation where byProperty is unsupported', () => {
    expect(propertyAggregationFor('web')).toBe('byProperty');
    expect(propertyAggregationFor('discover')).toBe('auto');
    expect(propertyAggregationFor('googleNews')).toBe('auto');
  });
});

describe('properties', () => {
  it('validates exact property formats without constructing them', () => {
    expect(validateGscPropertyFormat('sc-domain:example.test').ok).toBe(true);
    expect(validateGscPropertyFormat('https://www.example.test/').ok).toBe(true);
    expect(validateGscPropertyFormat('https://www.example.test').problems.join()).toMatch(/end with "\/"/);
    expect(validateGscPropertyFormat('example.test').ok).toBe(false);
    expect(validateGscPropertyFormat('sc-domain:https://example.test/').ok).toBe(false);
    expect(validateGscPropertyFormat('sc-domain:www.example.test').notes.join()).toMatch(/www/);
  });
  it('normalizes both documented permission casings', () => {
    expect(normalizePermissionLevel('siteOwner')).toBe('siteOwner');
    expect(normalizePermissionLevel('SITE_FULL_USER')).toBe('siteFullUser');
    expect(normalizePermissionLevel('SITE_RESTRICTED_USER')).toBe('siteRestrictedUser');
    expect(normalizePermissionLevel('siteUnverifiedUser')).toBe('siteUnverifiedUser');
    expect(normalizePermissionLevel('SITE_PERMISSION_LEVEL_UNSPECIFIED')).toBe('unknown');
    expect(canReadData('siteRestrictedUser')).toBe(true);
    expect(canReadData('siteUnverifiedUser')).toBe(false);
  });
  it('matches URLs to properties and suggests near matches only', () => {
    expect(urlBelongsToProperty('https://blog.example.test/x', 'sc-domain:example.test')).toBe(true);
    expect(urlBelongsToProperty('https://notexample.test/x', 'sc-domain:example.test')).toBe(false);
    expect(urlBelongsToProperty('https://www.example.test/a', 'https://www.example.test/')).toBe(true);
    expect(urlBelongsToProperty('http://www.example.test/a', 'https://www.example.test/')).toBe(false);
    expect(similarProperties('https://example.test/', ['sc-domain:example.test', 'https://www.example.test/', 'https://example.net/'])).toEqual(['sc-domain:example.test', 'https://www.example.test/']);
  });
  it('only allows documented Search Console hosts', () => {
    expect(resolveGscBaseUrl('https://www.googleapis.com/')).toBe('https://www.googleapis.com');
    expect(() => resolveGscBaseUrl('https://gsc-proxy.example.com')).toThrow();
  });

  it('GSC_BASE_URL is a documented env key with a Google-host allowlist, read through the layered store (env > secrets.env), never process.env directly', () => {
    expect(ENV_KEYS).toContain('GSC_BASE_URL');
    expect(ENV_ALLOWED_VALUES.GSC_BASE_URL).toEqual([...GSC_HOSTS]);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-gsc-base-'));
    const saved = process.env.GSC_BASE_URL;
    try {
      const file = path.join(dir, 'secrets', 'secrets.env');
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, 'GSC_BASE_URL=https://www.googleapis.com/\n', { mode: 0o600 });
      chmodSync(file, 0o600);
      // secrets.env is honored (it used to be ignored).
      expect(resolveGscBaseUrl(undefined, new LayeredSecretStore(file, {}))).toBe('https://www.googleapis.com');
      // The store's environment wins over the file.
      expect(resolveGscBaseUrl(undefined, new LayeredSecretStore(file, { GSC_BASE_URL: 'https://searchconsole.googleapis.com' }))).toBe('https://searchconsole.googleapis.com');
      // A disallowed host is refused whichever layer it comes from.
      expect(() => resolveGscBaseUrl(undefined, new LayeredSecretStore(file, { GSC_BASE_URL: 'https://gsc-proxy.example.com' }))).toThrow(/must be one of/);
      // The process environment is not consulted behind the store's back.
      process.env.GSC_BASE_URL = 'https://gsc-proxy.example.com';
      expect(resolveGscBaseUrl(undefined, new MemorySecretStore({}))).toBe(GSC_DEFAULT_BASE);
      expect(resolveGscBaseUrl()).toBe(GSC_DEFAULT_BASE);
      // An explicit value (callers/tests) still takes precedence.
      expect(resolveGscBaseUrl('https://www.googleapis.com', new MemorySecretStore({ GSC_BASE_URL: 'https://searchconsole.googleapis.com' }))).toBe('https://www.googleapis.com');
    } finally {
      if (saved === undefined) delete process.env.GSC_BASE_URL;
      else process.env.GSC_BASE_URL = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('response helpers', () => {
  it('reads first_incomplete_date in both casings and normalizes aggregation enums', () => {
    expect(firstIncompleteDateOf({ metadata: { first_incomplete_date: '2026-09-22' } })).toBe('2026-09-22');
    expect(firstIncompleteDateOf({ metadata: { firstIncompleteDate: '2026-09-21' } })).toBe('2026-09-21');
    expect(firstIncompleteDateOf({})).toBeNull();
    expect(normalizeAggregation('BY_PROPERTY', 'auto')).toBe('byProperty');
    expect(normalizeAggregation('byPage', 'auto')).toBe('byPage');
    expect(normalizeAggregation(undefined, 'byPage')).toBe('byPage');
  });
  it('builds canonical segment keys', () => {
    expect(segmentKeyOf({})).toBe('');
    expect(segmentKeyOf({ device: 'MOBILE', country: 'usa' })).toBe('country=usa;device=MOBILE');
    expect(segmentKeyOf({ searchAppearance: 'VIDEO' })).toBe('searchAppearance=VIDEO');
  });
});

describe('quota pacing', () => {
  it('keeps sequential Search Analytics calls under 1,200 QPM', async () => {
    expect(60_000 / GSC_SEARCH_ANALYTICS_MIN_INTERVAL_MS).toBeLessThan(1_200);
    const p = new Pacer(30);
    const t0 = Date.now();
    await p.wait();
    await p.wait();
    await p.wait();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
    const off = new Pacer(0);
    const t1 = Date.now();
    for (let i = 0; i < 50; i++) await off.wait();
    expect(Date.now() - t1).toBeLessThan(50);
  });
});

describe('queryAllPages pagination guard (B3-08)', () => {
  let ctx: TestContext | undefined;
  afterEach(() => ctx?.cleanup());

  /** SYNTHETIC Search Analytics rows for example.test; `total` rows in all, served by startRow/rowLimit. */
  function run(total: number, rowLimit: number, maxPages: number) {
    ctx = createTestContext();
    const client = new ScriptedClient((req) => {
      const start = req.body.startRow ?? 0;
      const n = Math.max(0, Math.min(rowLimit, total - start));
      const rows = Array.from({ length: n }, (_, i) => ({ keys: [`https://www.example.test/p${start + i}`], clicks: 1, impressions: 2, ctr: 0.5, position: 3 }));
      return { body: n ? { rows } : {} };
    });
    const res = queryAllPages({ ctx, client, synthetic: true, retry: FAST_RETRY }, SYNTHETIC_PROPERTY, { startDate: '2026-09-01', endDate: '2026-09-01', dimensions: ['page'] }, { rowLimit, maxPages });
    return { res, client };
  }

  it('does not flag truncation when the guard is reached after a short page (the short page proves the end)', async () => {
    const { res, client } = run(5, 2, 3); // pages of 2, 2, 1: the guard is hit right after the short page
    const r = await res;
    expect(r.rows).toHaveLength(5);
    expect(r.pages).toBe(3);
    expect(client.calls).toHaveLength(3);
    expect(r.stoppedAtMaxPages).toBe(false);
  });

  it('flags truncation when the guard is reached after a full page (more rows may exist)', async () => {
    const r = await run(10, 2, 3).res; // pages of 2, 2, 2 and more remain
    expect(r.rows).toHaveLength(6);
    expect(r.stoppedAtMaxPages).toBe(true);
  });

  it('flags truncation when the guard lands exactly on the end with a full last page (the end is not proven)', async () => {
    const r = await run(6, 2, 3).res;
    expect(r.rows).toHaveLength(6);
    expect(r.stoppedAtMaxPages).toBe(true);
  });

  it('pages until an empty page when the guard is not reached', async () => {
    const { res, client } = run(4, 2, 10);
    const r = await res;
    expect(r.rows).toHaveLength(4);
    expect(client.calls.map((c) => c.body.startRow)).toEqual([0, 2, 4]);
    expect(r.stoppedAtMaxPages).toBe(false);
  });
});
