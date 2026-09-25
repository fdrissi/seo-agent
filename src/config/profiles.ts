import { FEATURE_KEYS, type FeatureKey, type SiteConfig } from './site-schema.js';

export type Profile = SiteConfig['profile'];

/**
 * Profile defaults. Demo needs no credentials and makes no network requests.
 * Core: Google ingestion, crawling, SQLite, Markdown reports; AI analysis when a
 * model connection is configured. Full: the complete stack. Paid research
 * add-ons (backlinks, Labs exports, AI visibility) stay off in every profile
 * until explicitly approved.
 */
export const PROFILE_DEFAULTS: Record<Profile, Record<FeatureKey, boolean>> = {
  demo: {
    gsc: true,
    ga4: true,
    crawl: true,
    playwright: false,
    pagespeed: true,
    urlInspection: true,
    llm: true,
    embeddings: true,
    qdrant: false,
    obsidian: true,
    dataforseo: true,
    apify: true,
    contentDiscovery: true,
    aiCitations: false,
    dataforseoBacklinks: false,
    dataforseoLabsExports: false,
    dataforseoAiVisibility: false,
  },
  core: {
    gsc: true,
    ga4: true,
    crawl: true,
    playwright: false,
    pagespeed: false,
    urlInspection: false,
    llm: true, // effective only when a model connection is configured
    embeddings: false,
    qdrant: false,
    obsidian: true,
    dataforseo: false,
    apify: false,
    contentDiscovery: false,
    aiCitations: false,
    dataforseoBacklinks: false,
    dataforseoLabsExports: false,
    dataforseoAiVisibility: false,
  },
  full: {
    gsc: true,
    ga4: true,
    crawl: true,
    playwright: true,
    pagespeed: true,
    urlInspection: true,
    llm: true,
    embeddings: true,
    qdrant: true,
    obsidian: true,
    dataforseo: true,
    apify: true,
    contentDiscovery: true,
    aiCitations: false,
    dataforseoBacklinks: false,
    dataforseoLabsExports: false,
    dataforseoAiVisibility: false,
  },
};

/** Effective feature flags: explicit config overrides profile defaults. */
export function effectiveFeatures(cfg: Pick<SiteConfig, 'profile' | 'features'>): Record<FeatureKey, boolean> {
  const base = PROFILE_DEFAULTS[cfg.profile];
  const out = {} as Record<FeatureKey, boolean>;
  for (const k of FEATURE_KEYS) out[k] = cfg.features[k] ?? base[k];
  return out;
}
