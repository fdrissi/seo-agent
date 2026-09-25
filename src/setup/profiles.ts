import { PROFILE_DEFAULTS, type Profile } from '../config/profiles.js';
import { FEATURE_DESCRIPTIONS, FEATURE_KEYS } from '../config/site-schema.js';

/**
 * Human explanation of the Demo / Core / Full setup profiles for the wizard.
 * What each profile enables is derived from PROFILE_DEFAULTS, so the text
 * cannot drift from the actual feature defaults.
 */

export interface ProfileInfo {
  id: Profile;
  title: string;
  summary: string;
  enables: string[];
  credentials: string[];
  paidServices: string[];
  notes: string[];
}

function enabled(profile: Profile): string[] {
  return FEATURE_KEYS.filter((k) => PROFILE_DEFAULTS[profile][k]).map((k) => `${k}: ${FEATURE_DESCRIPTIONS[k]}`);
}

export const PROFILE_INFO: Record<Profile, ProfileInfo> = {
  demo: {
    id: 'demo',
    title: 'Demo',
    summary: 'Offline tour with clearly labeled synthetic data. No credentials, no network requests, no spending.',
    enables: enabled('demo'),
    credentials: ['None.'],
    paidServices: ['None.'],
    notes: [
      'The demo runs in its own isolated demo workspace so synthetic data never mixes with live reporting.',
      'Start it with: npm run demo',
    ],
  },
  core: {
    id: 'core',
    title: 'Core',
    summary: 'Google Search Console + GA4 ingestion, own-site crawling, SQLite, and Markdown reports/vault. AI analysis runs only when a model connection is configured.',
    enables: enabled('core'),
    credentials: [
      'Google: a Desktop OAuth client you create in your own Google Cloud project (or a service account) with read access to the Search Console property and GA4 property. Both Google APIs are free to use.',
      'Optional: LLM_GATEWAY_API_KEY plus model ids for AI analysis.',
    ],
    paidServices: ['Optional: LLM Gateway (billed per token by the gateway; capped by your LLM budget).'],
    notes: ['No DataForSEO or Apify requests are made in this profile.'],
  },
  full: {
    id: 'full',
    title: 'Full',
    summary: 'Everything in Core plus LLM Gateway analysis and embeddings, Qdrant vector memory, performance checks, URL Inspection, optional Playwright rendering, DataForSEO research, and Apify community research.',
    enables: enabled('full'),
    credentials: [
      'Google (as in Core).',
      'LLM_GATEWAY_API_KEY and model ids you verify with `models list`.',
      'DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD (use the free sandbox first).',
      'APIFY_TOKEN.',
      'PAGESPEED_API_KEY (free Google API key).',
      'Docker for the local Qdrant container (QDRANT_API_KEY only when your Qdrant requires one).',
    ],
    paidServices: ['LLM Gateway (per token)', 'DataForSEO (per task; sandbox is free)', 'Apify (per actor run/result)'],
    notes: [
      'Paid add-ons (AI citations, DataForSEO backlinks, Labs exports, AI visibility) stay off until you enable them explicitly.',
      'Every paid request is reserved against your budget ceilings first; unknown prices need approval or are skipped.',
    ],
  },
};

export function renderProfileInfo(): string {
  const lines: string[] = ['Setup profiles:'];
  let n = 1;
  for (const p of ['demo', 'core', 'full'] as const) {
    const info = PROFILE_INFO[p];
    lines.push('', `  [${n++}] ${info.title}: ${info.summary}`);
    lines.push(`      Credentials needed: ${info.credentials.join(' ')}`);
    lines.push(`      Paid services: ${info.paidServices.join('; ')}`);
    lines.push(`      Enables: ${FEATURE_KEYS.filter((k) => PROFILE_DEFAULTS[p][k]).join(', ')}`);
    for (const note of info.notes) lines.push(`      Note: ${note}`);
  }
  return lines.join('\n');
}
