import { AppError } from '../core/errors.js';
import { SECRET_ENV_KEYS, type EnvKey } from '../config/env.js';
import { effectiveFeatures } from '../config/profiles.js';
import type { SecretStore } from '../config/secrets.js';
import type { FeatureKey, SiteConfig } from '../config/site-schema.js';
import { getAt, isPlainObject, type Values } from './values.js';

/**
 * Which credentials a site needs, derived from its profile and feature flags,
 * plus a guard that keeps secret values out of every file the wizard writes
 * (site config, draft). Secret values are only ever written by
 * `SecretStore.set` into the protected secrets file.
 */

export interface SecretNeed {
  key: EnvKey;
  label: string;
  /** What it enables and what happens without it. */
  why: string;
  /** Whether requests made with it can cost money (budgeted). */
  paid: boolean;
  /** Optional credentials are never required for the profile to work. */
  optional: boolean;
  howToGet: string;
}

/** Effective feature flags for a partial config (profile defaults + explicit flags). */
export function featuresOf(values: Values): Record<FeatureKey, boolean> {
  const profile = (getAt(values, 'profile') as SiteConfig['profile'] | undefined) ?? 'core';
  const features = getAt(values, 'features');
  return effectiveFeatures({ profile, features: (isPlainObject(features) ? features : {}) as SiteConfig['features'] });
}

export function secretNeeds(values: Values): SecretNeed[] {
  const f = featuresOf(values);
  const profile = (getAt(values, 'profile') as string | undefined) ?? 'core';
  if (profile === 'demo') return [];
  const needs: SecretNeed[] = [];
  if (f.llm || f.embeddings) {
    needs.push({
      key: 'LLM_GATEWAY_API_KEY',
      label: 'LLM Gateway API key',
      why:
        profile === 'core'
          ? 'Enables optional AI analysis. Without it, AI features report "not configured" and deterministic reports still work.'
          : 'Enables AI analysis, drafting, and embeddings for vector memory.',
      paid: true,
      optional: profile === 'core',
      howToGet: 'Create a dedicated LLM Gateway project key with a recurring spend limit (see docs/ACCESS_SETUP.md). Usage is billed per token by the gateway and capped by budgets.llmGateway.',
    });
  }
  const dfsMode = (getAt(values, 'research.dataforseo.mode') as string | undefined) ?? 'disabled';
  if (f.dataforseo && dfsMode !== 'disabled') {
    const how = 'Use dedicated DataForSEO API credentials (API login/password from the DataForSEO dashboard, not your account password). Sandbox requests are free; live tasks are billed per task and capped by budgets.dataforseo.';
    needs.push({ key: 'DATAFORSEO_LOGIN', label: 'DataForSEO API login', why: 'Enables selective SERP and keyword-volume research.', paid: true, optional: false, howToGet: how });
    needs.push({ key: 'DATAFORSEO_PASSWORD', label: 'DataForSEO API password', why: 'Pairs with DATAFORSEO_LOGIN (HTTP Basic auth).', paid: true, optional: false, howToGet: how });
  }
  if (f.apify) {
    needs.push({
      key: 'APIFY_TOKEN',
      label: 'Apify API token',
      why: 'Enables the Reddit content-research actor (runs are billed by Apify and capped by budgets.apify).',
      paid: true,
      optional: false,
      howToGet: 'Create a personal API token in Apify Console > Settings > API & Integrations, then run `apify inspect` to verify the actor build and pricing before any run.',
    });
  }
  if (f.pagespeed) {
    needs.push({
      key: 'PAGESPEED_API_KEY',
      label: 'PageSpeed Insights / CrUX API key',
      why: 'Enables lab (Lighthouse) and field (CrUX) performance checks for priority pages.',
      paid: false,
      optional: false,
      howToGet: 'Create a Google Cloud API key restricted to the PageSpeed Insights API and the Chrome UX Report API (free quota).',
    });
  }
  if (f.qdrant) {
    needs.push({
      key: 'QDRANT_API_KEY',
      label: 'Qdrant API key',
      why: 'Only needed when your Qdrant instance requires an API key. The bundled local compose setup (127.0.0.1 only) does not.',
      paid: false,
      optional: true,
      howToGet: 'Set the same key as QDRANT__SERVICE__API_KEY on the Qdrant server (see docs/modules/memory.md).',
    });
  }
  return needs;
}

/**
 * Throw when `text` contains the value of a configured secret. Never prints
 * the value; names only the variable.
 */
export function assertNoKnownSecrets(text: string, secrets: SecretStore, where: string): void {
  for (const key of SECRET_ENV_KEYS) {
    const v = secrets.get(key);
    if (v && v.length >= 6 && text.includes(v)) {
      throw new AppError('POLICY_DENIED', `Refusing to write ${where}: it would contain the value of ${key}. Secrets belong only in the protected secrets file or the environment.`, {
        hint: 'Remove the secret from the answer or file and try again.',
      });
    }
  }
}

/** A plausible secret value: one line, no whitespace or control characters. */
export function validateSecretValue(value: string): string | null {
  if (!value) return 'empty';
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return 'Secrets cannot contain spaces, tabs, or control characters.';
  if (value.length > 4096) return 'Value is too long.';
  return null;
}

// ---------------------------------------------------------------------------
// Secret-looking content in imported configuration text (`setup --from`)
// ---------------------------------------------------------------------------

/** Words that make a key name a credential holder (compared per word, so "maxOutputTokens" is not one). */
const SECRET_KEY_WORDS = new Set(['token', 'secret', 'password', 'passwd', 'apikey', 'privatekey', 'credential', 'credentials']);
/** A trailing word that describes a secret instead of holding one (e.g. GOOGLE_TOKEN_FILE, token_mode). */
const SECRET_METADATA_WORDS = new Set(['file', 'path', 'dir', 'mode', 'name', 'names', 'url', 'count', 'env', 'type', 'kind', 'status', 'source', 'set', 'present', 'configured', 'required', 'enabled', 'hint', 'label', 'id', 'ids']);

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** True for key names such as `api_key`, `apiKey`, `LLM_GATEWAY_API_KEY`, `refreshToken`, `client_secret`, `password`. */
export function isSecretNamedKey(key: string): boolean {
  const words = keyWords(key);
  if (!words.length) return false;
  if (SECRET_METADATA_WORDS.has(words[words.length - 1]!)) return false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (SECRET_KEY_WORDS.has(w)) return true;
    const next = words[i + 1];
    if ((w === 'api' || w === 'private' || w === 'access') && next === 'key') return true;
  }
  return false;
}

/** Distinctive credential shapes (never printed; only the shape name and line are reported). */
const CREDENTIAL_SHAPES: Array<[string, RegExp]> = [
  ['PEM private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Google OAuth access token', /\bya29\.[A-Za-z0-9._-]{10,}/],
  ['Google OAuth refresh token', /(?:^|[^A-Za-z0-9:/])1\/\/[A-Za-z0-9._-]{20,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}/],
  ['Google OAuth client secret', /\bGOCSPX-[A-Za-z0-9_-]{10,}/],
  ['Apify token', /\bapify_api_[A-Za-z0-9]{20,}/],
  ['LLM Gateway key', /\bllmgtwy_[A-Za-z0-9_-]{8,}/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}/],
  ['AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['JSON Web Token', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['API secret key', /\b(?:sk|rk)[-_](?:live_|test_|proj-)?[A-Za-z0-9_-]{16,}/],
  ['credentials in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
];

/** A secret-named assignment anywhere in the text (also in comments): `password: x`, `api_key = x`, `APIFY_TOKEN=x`. */
const SECRET_ASSIGNMENT = /(?:^|[\s#{,(\[])["']?([A-Za-z0-9_.-]*?(?:password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key))["']?[ \t]*[:=][ \t]*(["']?)([^\s"',;}\]#]*)\2/gim;
const PLACEHOLDER_VALUES = new Set(['', 'null', '~', 'none', 'unset', 'missing', 'set', 'present', 'redacted', '[redacted]', 'true', 'false']);

/**
 * Findings (never values) for text that looks like it holds credentials:
 * secret-named keys at any depth of the parsed document, secret-named
 * assignments anywhere in the text (comments included), and distinctive
 * credential shapes. Used by `setup --from`, which refuses such files.
 */
export function findSecretLikeContent(text: string, parsed: unknown): string[] {
  const findings: string[] = [];
  const walk = (v: unknown, at: string) => {
    if (Array.isArray(v)) v.forEach((item, i) => walk(item, `${at}[${i}]`));
    else if (isPlainObject(v)) {
      for (const [k, child] of Object.entries(v)) {
        const p = at ? `${at}.${k}` : k;
        // Worded without "name: value" so the finding itself survives output redaction.
        if (isSecretNamedKey(k)) findings.push(`${p} is a secret-named key (secrets never belong in site config)`);
        walk(child, p);
      }
    }
  };
  walk(parsed, '');
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [name, re] of CREDENTIAL_SHAPES) {
      if (re.test(line)) findings.push(`line ${i + 1}: looks like a credential (${name})`);
    }
    for (const m of line.matchAll(SECRET_ASSIGNMENT)) {
      const key = m[1]!;
      const value = (m[3] ?? '').trim();
      if (!isSecretNamedKey(key.split('.').pop() ?? key) || PLACEHOLDER_VALUES.has(value.toLowerCase()) || value.startsWith('<')) continue;
      findings.push(`line ${i + 1}: "${key}" is assigned a value (secret-named)`);
    }
  });
  return [...new Set(findings)];
}
