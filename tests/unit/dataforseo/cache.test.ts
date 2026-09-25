import { afterEach, describe, expect, it } from 'vitest';
import { getCached, putCached, researchCacheKey, type CacheKeyInput } from '../../../src/integrations/dataforseo/cache.js';
import { serpParameterHash, volumeParameterHash } from '../../../src/integrations/dataforseo/store.js';
import { dfsContext } from '../../integration/dataforseo/helpers.js';
import type { TestContext } from '../../helpers/context.js';

const base: CacheKeyInput = { siteId: 'test-site', endpoint: 'serp/google/organic/advanced', locationCode: 9990001, languageCode: 'en', device: 'desktop', parameterHash: 'abc', mode: 'live' };

describe('research cache keys', () => {
  it('are stable for identical inputs', () => {
    expect(researchCacheKey(base)).toBe(researchCacheKey({ ...base }));
    expect(researchCacheKey({ ...base, languageCode: 'EN' })).toBe(researchCacheKey(base));
  });

  it('include endpoint, location, language, device, parameter hash, mode, and site', () => {
    const k = researchCacheKey(base);
    for (const variant of [
      { endpoint: 'keywords_data/google_ads/search_volume' },
      { locationCode: 9990002 },
      { languageCode: 'xx' },
      { device: 'mobile' },
      { parameterHash: 'def' },
      { mode: 'sandbox' as const },
      { siteId: 'other-site' },
    ]) {
      expect(researchCacheKey({ ...base, ...variant }), JSON.stringify(variant)).not.toBe(k);
    }
  });

  it('SERP parameter hashes change with depth, device, and locale but not with query case/spacing', () => {
    const p = { keyword: 'Synthetic  Query', locationCode: 9990001, languageCode: 'en', device: 'desktop', depth: 10 };
    expect(serpParameterHash(p)).toBe(serpParameterHash({ ...p, keyword: 'synthetic query' }));
    expect(serpParameterHash({ ...p, depth: 20 })).not.toBe(serpParameterHash(p));
    expect(serpParameterHash({ ...p, device: 'mobile' })).not.toBe(serpParameterHash(p));
    expect(serpParameterHash({ ...p, locationCode: 9990002 })).not.toBe(serpParameterHash(p));
    expect(volumeParameterHash('a b', 1, 'en')).not.toBe(volumeParameterHash('a b', 2, 'en'));
  });
});

describe('research cache storage', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  it('returns valid entries and ignores expired ones', () => {
    ctx = dfsContext();
    const input = { ...base, siteId: ctx.siteId };
    const key = putCached(ctx, { ...input, payloadRef: 'db:serp_snapshots:x', ttlDays: 7, isSandbox: false });
    expect(key).toBe(researchCacheKey(input));
    expect(getCached(ctx, key!)?.payloadRef).toBe('db:serp_snapshots:x');
    ctx.clock.advanceMs(8 * 86_400_000);
    expect(getCached(ctx, key!)).toBeNull();
  });

  it('a TTL of 0 disables caching', () => {
    ctx = dfsContext();
    expect(putCached(ctx, { ...base, siteId: ctx.siteId, payloadRef: 'x', ttlDays: 0, isSandbox: false })).toBeNull();
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM research_cache')!.n).toBe(0);
  });
});
