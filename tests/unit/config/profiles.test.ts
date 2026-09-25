import { describe, expect, it } from 'vitest';
import { PROFILE_DEFAULTS, effectiveFeatures } from '../../../src/config/profiles.js';
import { FEATURE_KEYS } from '../../../src/config/site-schema.js';

const PAID_ADDONS = ['aiCitations', 'dataforseoBacklinks', 'dataforseoLabsExports', 'dataforseoAiVisibility'] as const;

describe('setup profiles', () => {
  it('every profile defines every feature flag', () => {
    for (const profile of ['demo', 'core', 'full'] as const) expect(Object.keys(PROFILE_DEFAULTS[profile]).sort()).toEqual([...FEATURE_KEYS].sort());
  });

  it('demo enables the offline fixture-backed features but not Qdrant or Playwright', () => {
    const f = effectiveFeatures({ profile: 'demo', features: {} });
    expect(f).toMatchObject({ gsc: true, ga4: true, crawl: true, llm: true, dataforseo: true, apify: true, obsidian: true, qdrant: false, playwright: false });
  });

  it('core covers Google ingestion, crawl, and Markdown; paid research and vectors stay off', () => {
    const f = effectiveFeatures({ profile: 'core', features: {} });
    expect(f).toMatchObject({ gsc: true, ga4: true, crawl: true, obsidian: true, llm: true });
    expect(f).toMatchObject({ dataforseo: false, apify: false, qdrant: false, embeddings: false, contentDiscovery: false, playwright: false });
  });

  it('full enables the complete stack', () => {
    const f = effectiveFeatures({ profile: 'full', features: {} });
    for (const k of ['gsc', 'ga4', 'crawl', 'playwright', 'pagespeed', 'urlInspection', 'llm', 'embeddings', 'qdrant', 'obsidian', 'dataforseo', 'apify', 'contentDiscovery'] as const) {
      expect(f[k]).toBe(true);
    }
  });

  it('paid add-ons stay off in every profile until explicitly enabled', () => {
    for (const profile of ['demo', 'core', 'full'] as const) {
      const f = effectiveFeatures({ profile, features: {} });
      for (const k of PAID_ADDONS) expect(f[k]).toBe(false);
    }
  });

  it('explicit flags override profile defaults in both directions', () => {
    const f = effectiveFeatures({ profile: 'core', features: { dataforseo: true, gsc: false } });
    expect(f.dataforseo).toBe(true);
    expect(f.gsc).toBe(false);
    expect(f.ga4).toBe(true);
    expect(effectiveFeatures({ profile: 'full', features: { qdrant: false } }).qdrant).toBe(false);
  });
});
