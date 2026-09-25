import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isNode, isScalar, parseDocument, visit } from 'yaml';
import { AppError, ConfigError } from '../core/errors.js';
import { hashObject } from '../core/hash.js';
import { toMicros, type Micros } from '../core/money.js';
import { effectiveFeatures } from './profiles.js';
import type { SecretStore } from './secrets.js';
import { SITE_CONFIG_SCHEMA_VERSION, safeParseSiteConfig, type SiteConfig } from './site-schema.js';
import type { FeatureKey } from './site-schema.js';
import { siteConfigFile, type WorkspacePaths } from './paths.js';

/** Explicit tags allowed in configuration/frontmatter YAML (the YAML 1.2 core schema only). */
const SAFE_YAML_TAGS = new Set(
  ['str', 'int', 'float', 'bool', 'null', 'map', 'seq'].map((t) => `tag:yaml.org,2002:${t}`),
);

/** Mapping keys that could reach Object.prototype machinery; refused at any depth. */
const FORBIDDEN_YAML_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Parse YAML safely with the YAML 1.2 core schema. Nothing is constructed from
 * tags and nothing executes: any explicit tag outside the core schema
 * (`!!js/function`, `!!binary`, `!!set`, `!custom`, ...) is rejected instead
 * of being silently coerced, duplicate keys are rejected, alias expansion
 * is bounded (billion-laughs protection), and the keys `__proto__`,
 * `constructor`, and `prototype` are rejected at any depth.
 */
export function parseYamlSafe(text: string, source = 'yaml'): unknown {
  let doc;
  try {
    doc = parseDocument(text, { schema: 'core', customTags: [], resolveKnownTags: false, uniqueKeys: true, logLevel: 'silent', prettyErrors: true });
  } catch (err) {
    throw new ConfigError(`${source}: invalid YAML (${(err as Error).message})`);
  }
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) throw new ConfigError(`${source}: invalid YAML (${problem.message})`);
  let unsafeTag: string | null = null;
  visit(doc, (_key, node) => {
    if (isNode(node) && node.tag && !SAFE_YAML_TAGS.has(node.tag)) {
      unsafeTag = node.tag;
      return visit.BREAK;
    }
    return undefined;
  });
  if (unsafeTag) throw new ConfigError(`${source}: invalid YAML (tag "${unsafeTag}" is not allowed; only plain YAML 1.2 core values are accepted)`);
  let forbiddenKey: string | null = null;
  visit(doc, {
    Pair(_key, pair) {
      const k = isScalar(pair.key) ? pair.key.value : pair.key;
      if (typeof k === 'string' && FORBIDDEN_YAML_KEYS.has(k)) {
        forbiddenKey = k;
        return visit.BREAK;
      }
      return undefined;
    },
  });
  if (forbiddenKey) throw new ConfigError(`${source}: invalid YAML (the key "${forbiddenKey}" is not allowed)`);
  try {
    return doc.toJS({ maxAliasCount: 100 });
  } catch (err) {
    throw new ConfigError(`${source}: invalid YAML (${(err as Error).message})`);
  }
}

export function loadSiteConfigFile(file: string): SiteConfig {
  if (!existsSync(file)) {
    throw new AppError('CONFIG_MISSING', `Site config not found: ${file}`, { hint: 'Run `npm run cli -- setup` to create one.' });
  }
  const raw = parseYamlSafe(readFileSync(file, 'utf8'), file);
  assertSiteConfigVersion(raw, file);
  const parsed = safeParseSiteConfig(raw);
  if (!parsed.ok) throw new ConfigError(`Invalid site config ${file}`, { details: { errors: parsed.errors } });
  return parsed.config;
}

/**
 * An older `schemaVersion` is never migrated implicitly (and never rewritten
 * on load): it fails with CONFIG_INVALID pointing at `config migrate`. A newer
 * one asks for an application upgrade.
 */
export function assertSiteConfigVersion(raw: unknown, file: string): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const v = (raw as Record<string, unknown>).schemaVersion;
  if (typeof v !== 'number' || !Number.isInteger(v) || v === SITE_CONFIG_SCHEMA_VERSION) return;
  if (v < SITE_CONFIG_SCHEMA_VERSION) {
    throw new ConfigError(`${file} uses site configuration format ${v}; this application uses format ${SITE_CONFIG_SCHEMA_VERSION}. It was not changed.`, {
      details: { errors: [`schemaVersion: ${v} is older than ${SITE_CONFIG_SCHEMA_VERSION}`], schemaVersion: v, supported: SITE_CONFIG_SCHEMA_VERSION },
      hint: 'Review the upgrade with `npm run cli -- config migrate` (shows a diff; nothing is written), then apply it with `npm run cli -- config migrate --yes` (the original is backed up first).',
    });
  }
  throw new ConfigError(`${file} uses site configuration format ${v}, newer than this application supports (${SITE_CONFIG_SCHEMA_VERSION}). It was not changed.`, {
    details: { errors: [`schemaVersion: ${v} is newer than ${SITE_CONFIG_SCHEMA_VERSION}`], schemaVersion: v, supported: SITE_CONFIG_SCHEMA_VERSION },
    hint: 'Upgrade the application to the version that wrote this configuration (see docs/UPGRADING.md).',
  });
}

export function listSiteIds(paths: WorkspacePaths): string[] {
  if (!existsSync(paths.sitesDir)) return [];
  return readdirSync(paths.sitesDir)
    .filter((f) => f.endsWith('.yaml') && !f.startsWith('.'))
    .map((f) => f.replace(/\.yaml$/, ''))
    .sort();
}

export function loadSiteConfig(paths: WorkspacePaths, siteId: string): SiteConfig {
  const cfg = loadSiteConfigFile(siteConfigFile(paths, siteId));
  if (cfg.site.id !== siteId) {
    throw new ConfigError(`Site config file ${siteId}.yaml declares site.id "${cfg.site.id}"; they must match.`);
  }
  return cfg;
}

/** Resolve --site: explicit flag, or the only configured site. */
export function resolveSiteId(paths: WorkspacePaths, flag?: string | null): string {
  if (flag) return flag;
  const ids = listSiteIds(paths);
  if (ids.length === 1) return ids[0]!;
  if (ids.length === 0) throw new AppError('CONFIG_MISSING', 'No site configured in this workspace.', { hint: 'Run `npm run cli -- setup` or pass --site.' });
  throw new AppError('CONFIG_INVALID', `Multiple sites configured (${ids.join(', ')}); pass --site <id>.`);
}

export interface ModelSettings {
  cheap: string | null;
  reasoning: string | null;
  embedding: string | null;
  embeddingDimensions: number | null;
  source: { cheap: string; reasoning: string; embedding: string };
}

export interface BudgetSettings {
  llmGateway: { monthly: Micros; perRun: Micros };
  dataforseo: { weekly: Micros; monthly: Micros; perRun: Micros };
  apify: { monthly: Micros; perRun: Micros };
  pagespeed: { monthly: Micros; perRun: Micros };
  combinedMonthly: Micros;
  accountMonthly: Record<string, Micros>;
}

/**
 * Fully resolved runtime settings for one site.
 *
 * Override precedence (highest first), documented in docs/CONFIGURATION.md:
 *   1. CLI flags (per command)
 *   2. Environment variables (process env, then workspace secrets file)
 *   3. Site configuration file
 *   4. Built-in defaults (profile defaults for feature flags)
 */
export interface RuntimeSettings {
  config: SiteConfig;
  configHash: string;
  features: Record<FeatureKey, boolean>;
  models: ModelSettings;
  budgets: BudgetSettings;
  llmBaseUrl: string;
  qdrantUrl: string;
  googleAuthMode: 'oauth' | 'service_account';
  apify: { actorId: string; build: string | null; actorIdSource: string };
}

export function resolveRuntimeSettings(config: SiteConfig, secrets: SecretStore): RuntimeSettings {
  const pick = (envKey: 'CHEAP_MODEL' | 'REASONING_MODEL' | 'EMBEDDING_MODEL', cfgValue: string | null) => {
    const envVal = secrets.get(envKey);
    if (envVal) return { value: envVal, source: `env:${envKey}` };
    if (cfgValue) return { value: cfgValue, source: 'site-config' };
    return { value: null, source: 'unset' };
  };
  const cheap = pick('CHEAP_MODEL', config.models.cheap);
  const reasoning = pick('REASONING_MODEL', config.models.reasoning);
  const embedding = pick('EMBEDDING_MODEL', config.models.embedding);
  const b = config.budgets;
  const mode = secrets.get('GOOGLE_AUTH_MODE');
  const envActor = secrets.get('APIFY_CONTENT_ACTOR_ID');
  const actorFromEnv = secrets.sourceOf('APIFY_CONTENT_ACTOR_ID') === 'env' || secrets.sourceOf('APIFY_CONTENT_ACTOR_ID') === 'secrets-file';
  return {
    config,
    configHash: hashObject(config),
    features: effectiveFeatures(config),
    models: {
      cheap: cheap.value,
      reasoning: reasoning.value,
      embedding: embedding.value,
      embeddingDimensions: config.models.embeddingDimensions,
      source: { cheap: cheap.source, reasoning: reasoning.source, embedding: embedding.source },
    },
    budgets: {
      llmGateway: { monthly: toMicros(b.llmGateway.monthlyUsd), perRun: toMicros(b.llmGateway.perRunUsd) },
      dataforseo: { weekly: toMicros(b.dataforseo.weeklyUsd), monthly: toMicros(b.dataforseo.monthlyUsd), perRun: toMicros(b.dataforseo.perRunUsd) },
      apify: { monthly: toMicros(b.apify.monthlyUsd), perRun: toMicros(b.apify.perRunUsd) },
      pagespeed: { monthly: toMicros(b.pagespeed.monthlyUsd), perRun: toMicros(b.pagespeed.perRunUsd) },
      combinedMonthly: toMicros(b.combinedMonthlyUsd),
      accountMonthly: Object.fromEntries(Object.entries(b.accountMonthlyUsd).map(([k, v]) => [k, toMicros(v)])),
    },
    llmBaseUrl: secrets.get('LLM_GATEWAY_BASE_URL') ?? 'https://api.llmgateway.io/v1',
    qdrantUrl: secrets.get('QDRANT_URL') ?? 'http://127.0.0.1:6333',
    googleAuthMode: mode === 'service_account' ? 'service_account' : 'oauth',
    apify: {
      actorId: actorFromEnv && envActor ? envActor : config.research.apify.actorId,
      build: secrets.get('APIFY_CONTENT_ACTOR_BUILD') || config.research.apify.build,
      actorIdSource: actorFromEnv ? 'env' : 'site-config',
    },
  };
}
