import { ENV_DEFAULTS, ENV_KEYS, SECRET_ENV_KEYS, type EnvKey } from './env.js';
import { PROFILE_DEFAULTS } from './profiles.js';
import { FEATURE_DESCRIPTIONS, FEATURE_KEYS, describeSiteConfigFields, type SiteConfigFieldDoc } from './site-schema.js';

/**
 * Markdown generated from the configuration source of truth (zod schema,
 * profile defaults, env metadata). docs/CONFIGURATION.md embeds these blocks
 * between GENERATED markers; a test fails when the document drifts.
 * Regenerate with: npm run cli -- config docs
 */

export const GENERATED_BLOCKS = ['fields', 'profiles', 'env'] as const;
export type GeneratedBlock = (typeof GENERATED_BLOCKS)[number];

export const beginMarker = (block: GeneratedBlock) => `<!-- BEGIN GENERATED: ${block} (npm run cli -- config docs) -->`;
export const endMarker = (block: GeneratedBlock) => `<!-- END GENERATED: ${block} -->`;

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

function typeText(f: SiteConfigFieldDoc): string {
  return f.nullable ? `${f.type} or null` : f.type;
}

function defaultText(f: SiteConfigFieldDoc): string {
  if (f.required) return '**required**';
  if (f.default === null) return f.path.startsWith('features.') ? 'profile default' : '-';
  return `\`${f.default}\``;
}

/** Field reference grouped by top-level section. */
export function siteConfigFieldsMarkdown(): string {
  const fields = describeSiteConfigFields();
  const sections = new Map<string, SiteConfigFieldDoc[]>();
  const topLevelScalars: SiteConfigFieldDoc[] = [];
  for (const f of fields) {
    const top = f.path.split(/[.[]/)[0]!;
    if (f.path === top && !f.group) {
      topLevelScalars.push(f);
      continue;
    }
    if (!sections.has(top)) sections.set(top, []);
    sections.get(top)!.push(f);
  }
  const table = (rows: SiteConfigFieldDoc[]) => [
    '| Field | Type | Default | Description |',
    '| --- | --- | --- | --- |',
    ...rows.map((f) => `| \`${cell(f.path)}\` | ${cell(typeText(f))} | ${cell(defaultText(f))} | ${cell(f.description)} |`),
    '',
  ];
  const out: string[] = [];
  if (topLevelScalars.length) out.push('### Top-level fields', '', ...table(topLevelScalars));
  for (const [top, list] of sections) {
    const head = list.find((f) => f.path === top)!;
    out.push(`### \`${top}\``, '', head.description, '', ...table(list.filter((f) => f.path !== top)));
  }
  return out.join('\n').trimEnd();
}

/** Feature defaults per setup profile. */
export function profileFeaturesMarkdown(): string {
  const yes = (v: boolean) => (v ? 'on' : 'off');
  const out = ['| Feature | demo | core | full | What it enables |', '| --- | --- | --- | --- | --- |'];
  for (const k of FEATURE_KEYS) {
    out.push(`| \`${k}\` | ${yes(PROFILE_DEFAULTS.demo[k])} | ${yes(PROFILE_DEFAULTS.core[k])} | ${yes(PROFILE_DEFAULTS.full[k])} | ${cell(FEATURE_DESCRIPTIONS[k])} |`);
  }
  return out.join('\n');
}

const ENV_PURPOSE: Record<EnvKey, string> = {
  LLM_GATEWAY_API_KEY: 'LLM Gateway API key (chat and embeddings).',
  LLM_GATEWAY_BASE_URL: 'OpenAI-compatible LLM Gateway base URL.',
  CHEAP_MODEL: 'Overrides `models.cheap` (extraction/classification model ID).',
  REASONING_MODEL: 'Overrides `models.reasoning` (synthesis/prioritization model ID).',
  EMBEDDING_MODEL: 'Overrides `models.embedding`.',
  GOOGLE_AUTH_MODE: '`oauth` (desktop loopback flow) or `service_account`.',
  GOOGLE_OAUTH_CLIENT_FILE: 'Path to the OAuth desktop client JSON (keep it under `secrets/google/`).',
  GOOGLE_TOKEN_FILE: 'Path to the stored OAuth token file (keep it under `secrets/google/`).',
  GOOGLE_APPLICATION_CREDENTIALS: 'Path to a service-account key file (service_account mode).',
  DATAFORSEO_LOGIN: 'DataForSEO API login (account identifier). The Basic authorization header built from it is always redacted.',
  DATAFORSEO_PASSWORD: 'DataForSEO API password.',
  APIFY_TOKEN: 'Apify API token.',
  APIFY_CONTENT_ACTOR_ID: 'Overrides `research.apify.actorId` only when explicitly set.',
  APIFY_CONTENT_ACTOR_BUILD: 'Overrides `research.apify.build` (pinned, verified build).',
  QDRANT_URL: 'Local Qdrant endpoint.',
  QDRANT_API_KEY: 'Qdrant API key, when Qdrant is protected.',
  PAGESPEED_API_KEY: 'PageSpeed Insights / CrUX API key.',
  SEO_AGENT_WORKSPACE: 'Private workspace directory (overridden by `--workspace`).',
  SEO_AGENT_LOG_LEVEL: '`debug`, `info` (default), `warn`, or `error`. Unknown values fall back to `info`.',
  GSC_BASE_URL: 'Optional Search Console API host: `https://searchconsole.googleapis.com` (used when unset) or `https://www.googleapis.com`. Any other value is refused.',
};

/** Environment variables recognised by the application. */
export function envVarsMarkdown(): string {
  const out = ['| Variable | Secret | Default | Purpose |', '| --- | --- | --- | --- |'];
  for (const k of ENV_KEYS) {
    const def = ENV_DEFAULTS[k];
    out.push(`| \`${k}\` | ${SECRET_ENV_KEYS.has(k) ? 'yes' : 'no'} | ${def ? `\`${def}\`` : '-'} | ${cell(ENV_PURPOSE[k])} |`);
  }
  return out.join('\n');
}

export function generatedBlock(block: GeneratedBlock): string {
  const body = block === 'fields' ? siteConfigFieldsMarkdown() : block === 'profiles' ? profileFeaturesMarkdown() : envVarsMarkdown();
  return `${beginMarker(block)}\n\n${body}\n\n${endMarker(block)}`;
}

/** Replace every generated block in a document with freshly generated content. */
export function refreshGeneratedBlocks(doc: string): string {
  let out = doc;
  for (const block of GENERATED_BLOCKS) {
    const start = out.indexOf(beginMarker(block));
    const end = out.indexOf(endMarker(block));
    if (start < 0 || end < start) continue;
    out = `${out.slice(0, start)}${generatedBlock(block)}${out.slice(end + endMarker(block).length)}`;
  }
  return out;
}
