import { createHmac, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import { ENV_DEFAULTS, ENV_KEYS, SECRET_ENV_KEYS, checkSecretFilePermissions, type EnvKey } from '../config/env.js';
import { listSiteIds, loadSiteConfig, parseYamlSafe } from '../config/load.js';
import { appDirs, appRoot, appVersion, siteConfigFile, type WorkspacePaths } from '../config/paths.js';
import { effectiveFeatures } from '../config/profiles.js';
import { LayeredSecretStore, type SecretStore } from '../config/secrets.js';
import { FEATURE_KEYS, siteConfigSchema, type FeatureKey, type SiteConfig } from '../config/site-schema.js';
import { isRepoPath, readManifest } from '../config/workspace.js';
import { openDatabase, type Db } from '../database/db.js';
import { loadMigrations } from '../database/migrate.js';
import type { IntegrationId, IntegrationState, IntegrationStatus } from '../integrations/types.js';
import { safeResolve } from './paths.js';
import { REDACTED, redactString } from './redact.js';

/**
 * Redacted diagnostic export for public bug reports.
 *
 * The bundle (JSON + a human-readable Markdown summary) is written to
 * <workspace>/diagnostics/ and NEVER uploaded. The user must inspect it before
 * attaching it to a public issue.
 *
 * What it contains: app/Node/OS versions, workspace layout with paths replaced
 * by placeholders, the configuration SHAPE (values redacted except booleans,
 * schema enums, numbers, time zones, cron expressions, currency codes, and
 * budget/cap amounts), feature flags, locally inspected integration states
 * (credential presence only), migration status, recent job statuses and
 * redacted errors, and row counts per table (never rows).
 *
 * What it never contains: secret values, hostnames, URLs, Search Console
 * properties, GA4 property IDs, emails, business names, event names, machine
 * hostname, OS user name, or absolute paths. Identifiers are replaced with
 * `<kind h:xxxxxxxx>` using an HMAC keyed by a random per-export key that is
 * discarded, so equal values correlate within one bundle but cannot be
 * dictionary-reversed across bundles.
 *
 * Identifiers of EVERY site are registered before anything is scrubbed: the
 * reported sites, sites excluded by --site, configs that fail validation (read
 * leniently from the raw YAML or text), and every site in the database. With
 * --site, per-site database and log sections cover only the selected site.
 */

export const DIAGNOSTICS_FORMAT = 'seo-agent-diagnostics';
export const DIAGNOSTICS_FORMAT_VERSION = 1;
const MARKDOWN_MARKER = `<!-- ${DIAGNOSTICS_FORMAT} v${DIAGNOSTICS_FORMAT_VERSION} -->`;

export const DIAGNOSTICS_NOTICE = [
  'This is a REDACTED diagnostic bundle generated locally by seo-agent. It was not uploaded anywhere.',
  'INSPECT this file before attaching it to a public issue. Remove anything you are not comfortable sharing.',
  'Secret values, hostnames, URLs, property IDs, emails, business/event names, and absolute paths are replaced with placeholders or keyed hashes.',
  'Row counts are included; database rows, analytics data, vault notes, and raw responses are not.',
];

// ---------------------------------------------------------------------------
// Identifier masking

/** Extra credential shapes masked on top of src/security/redact.ts (defense in depth). */
const EXTRA_SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bllmgtwy_[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{30,}/g, REDACTED],
  [/"private_key"\s*:\s*"[^"]*"/g, `"private_key": "${REDACTED}"`],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g, REDACTED], // truncated PEM without END marker
];

/** Well-known public API hosts: not identifying, kept (without path/query) because they help debugging. */
const PUBLIC_SERVICE_HOST_RE =
  /(?:^|\.)(?:googleapis\.com|google\.com|llmgateway\.io|dataforseo\.com|apify\.com|qdrant\.tech|github\.com|npmjs\.org|nodejs\.org)$/i;
const FILE_EXTENSIONS = new Set(
  'js mjs cjs ts mts cts tsx jsx json jsonl yaml yml md markdown sqlite sqlite3 db log txt csv tsv html htm xml env sql lock map css scss pem key gz tgz zip wal shm sh bak tmp d'.split(' '),
);
/**
 * Generic TLDs masked in free text. Every two-letter TLD (country code) is also
 * masked except `id` (too common in code paths such as `site.id`). Words that
 * double as code identifiers (site, page, blog, cloud...) are deliberately left
 * out; hostnames from site configuration are always replaced exactly anyway.
 */
const GENERIC_TLDS = new Set(
  'com net org io dev app ai biz xyz info online shop store tech agency studio digital pro travel health finance consulting marketing academy education email company group test invalid example'.split(' '),
);

export type IdentifierKind = 'host' | 'url' | 'property' | 'ga4' | 'email' | 'site' | 'name' | 'event' | 'login' | 'machine' | 'user' | 'id' | 'ip' | 'num' | 'path';

export class IdentifierMasker {
  private readonly key: Buffer;
  private readonly known = new Map<string, IdentifierKind>();
  private readonly pathPrefixes: Array<[string, string]> = [];
  private readonly secrets = new Set<string>();
  masked = 0;

  constructor(key: Buffer = randomBytes(32)) {
    this.key = key;
  }

  hash(value: string): string {
    return createHmac('sha256', this.key).update(value.trim().toLowerCase()).digest('hex').slice(0, 8);
  }

  token(kind: IdentifierKind, value: string): string {
    this.masked++;
    return `<${kind} h:${this.hash(value)}>`;
  }

  /** Register a known identifier (hostname, property, name...) for exact, boundary-aware replacement. */
  register(kind: IdentifierKind, value: string | null | undefined): void {
    if (!value) return;
    const v = value.trim();
    if (v.length < 4) return;
    if (!this.known.has(v)) this.known.set(v, kind);
    if (kind === 'url') {
      try {
        const host = new URL(v).hostname;
        if (host) this.register('host', host);
      } catch {
        /* not a URL */
      }
    }
    if (kind === 'host' && v.startsWith('www.')) this.register('host', v.slice(4));
  }

  /** Register a secret value that must never appear in output (exact match). */
  registerSecret(value: string | null | undefined): void {
    if (value && value.trim().length >= 4) this.secrets.add(value.trim());
  }

  /** Replace an absolute path prefix (workspace, app root, home, tmp) with a placeholder. */
  registerPath(prefix: string | null | undefined, placeholder: string): void {
    if (!prefix) return;
    const variants = new Set([path.resolve(prefix)]);
    try {
      variants.add(realpathSync(prefix));
    } catch {
      /* may not exist */
    }
    for (const v of variants) if (v.length > 1) this.pathPrefixes.push([v, placeholder]);
    this.pathPrefixes.sort((a, b) => b[0].length - a[0].length);
  }

  sensitiveValues(): string[] {
    return [...this.secrets, ...this.known.keys()];
  }

  /** Full scrubbing pipeline for free text (error messages, log lines, details). */
  scrub(input: string): string {
    let out = redactString(input);
    for (const [re, rep] of EXTRA_SECRET_PATTERNS) out = out.replace(re, rep);
    for (const s of [...this.secrets].sort((a, b) => b.length - a.length)) if (out.includes(s)) out = out.split(s).join(REDACTED);
    for (const [prefix, placeholder] of this.pathPrefixes) if (out.includes(prefix)) out = out.split(prefix).join(placeholder);
    // URLs first (whole URL hashed, including its path): keep only scheme + host of public API hosts and loopback.
    out = out.replace(/\b([a-z][a-z0-9+.-]{1,15}):\/\/([^\s"'<>)\]}]+)/gi, (_m, scheme: string, rest: string) => {
      const hostPort = rest.split(/[/?#]/)[0] ?? '';
      const host = hostPort.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (PUBLIC_SERVICE_HOST_RE.test(host) || isLoopback(host)) return `${scheme}://${hostPort}${rest.length > hostPort.length ? '/<path redacted>' : ''}`;
      return this.token('url', `${scheme}://${rest}`);
    });
    // Emails.
    out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => this.token('email', m));
    // Known identifiers, longest first, case-insensitive, not inside larger words.
    for (const [value, kind] of [...this.known.entries()].sort((a, b) => b[0].length - a[0].length)) {
      const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(value)}(?![A-Za-z0-9])`, 'gi');
      out = out.replace(re, (m) => this.token(kind, m));
    }
    out = out.replace(/sc-domain:[A-Za-z0-9.-]+/g, (m) => this.token('property', m));
    // IPv4 (loopback and unspecified kept: they are useful and not identifying).
    out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (m) => (isLoopback(m) || m === '0.0.0.0' ? m : this.token('ip', m)));
    // Bare hostnames with a common TLD (config hostnames are already replaced exactly above).
    out = out.replace(/\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24}))\b/gi, (m, _full: string, tld: string) => {
      const t = tld.toLowerCase();
      if (FILE_EXTENSIONS.has(t)) return m;
      if (t.length === 2 ? t === 'id' : !GENERIC_TLDS.has(t)) return m;
      // Reserved names (example.com, *.test) are masked too: harmless over-masking keeps the rule simple.
      if (PUBLIC_SERVICE_HOST_RE.test(m) || isLoopback(m)) return m;
      return this.token('host', m);
    });
    // Long digit runs (GA4 property IDs, account numbers).
    out = out.replace(/(?<![A-Za-z0-9])\d{7,}(?![A-Za-z0-9])/g, (m) => this.token('num', m));
    return out;
  }

  /**
   * Final guard over the bundle: any registered secret or identifier that
   * survived inside a STRING VALUE is removed. Object keys are never rewritten
   * for identifiers (they are the bundle's own schema; the few user-derived
   * keys are sanitized when built), so an identifier that happens to equal a
   * key name ("database", "format", "environment") cannot corrupt the bundle.
   * Secrets are removed everywhere, keys included. Values at `keepPaths`
   * (schema enums and code-generated labels) are left untouched.
   */
  finalCheckValue<T>(value: T, keepPaths: readonly RegExp[] = []): { value: T; removed: number } {
    let removed = 0;
    const secrets = [...this.secrets].sort((a, b) => b.length - a.length);
    const identifiers = [...this.known.keys()].sort((a, b) => b.length - a.length).map((v) => new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(v)}(?![A-Za-z0-9])`, 'gi'));
    const clean = (str: string, withIdentifiers: boolean): string => {
      let out = str;
      for (const sec of secrets) {
        if (out.includes(sec)) {
          removed += out.split(sec).length - 1;
          out = out.split(sec).join(REDACTED);
        }
      }
      if (withIdentifiers) {
        for (const re of identifiers) {
          out = out.replace(re, () => {
            removed++;
            return '<removed>';
          });
        }
      }
      return out;
    };
    const walk = (v: unknown, at: string): unknown => {
      if (typeof v === 'string') return clean(v, !keepPaths.some((re) => re.test(at)));
      if (Array.isArray(v)) return v.map((x) => walk(x, `${at}[]`));
      if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[clean(k, false)] = walk(val, `${at}.${k}`);
        return out;
      }
      return v;
    };
    return { value: walk(value, '$') as T, removed };
  }

  /** String form of finalCheckValue (JSON in, JSON out). Fails closed on invalid JSON. */
  finalCheck(json: string, keepPaths: readonly RegExp[] = []): { text: string; removed: number } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new AppError('INTERNAL', 'Diagnostics redaction self-check received invalid JSON; refusing to write a bundle that may leak data.');
    }
    const r = this.finalCheckValue(parsed, keepPaths);
    return { text: JSON.stringify(r.value), removed: r.removed };
  }
}

/**
 * Bundle paths whose string values are schema enums, CHECK-constrained
 * database values, or code-generated labels. The final identifier check skips
 * them so a user identifier equal to such a word (a subreddit named "valid",
 * a brand called "Installed") cannot corrupt the bundle's structure. Secrets
 * are still removed there.
 */
const STRUCTURAL_VALUE_PATHS: readonly RegExp[] = [
  /^\$\.format$/,
  /^\$\.generatedAt$/,
  /^\$\.app\.(?:version|node|platform|arch|sqlite|playwright)$/,
  /^\$\.workspace\.(?:root|source)$/,
  /^\$\.workspace\.layout\[\]\.(?:path|mode)$/,
  /^\$\.workspace\.secretsFile\.mode$/,
  /^\$\.environment\[\]\.(?:key|source)$/,
  /^\$\.sites\[\]\.(?:label|configStatus|profile)$/,
  /^\$\.(?:sites\[\]\.integrations|reportedIntegrations)\[\]\.(?:id|state|source)$/,
  /^\$\.database\.migrations\.[a-zA-Z]+\[\]$/,
  /^\$\.database\.tableCounts\[\]\.table$/,
  /^\$\.database\.jobs\.(?:byStatus|recent)\[\]\.(?:site|status|mode|createdAt|startedAt|finishedAt)$/,
  /^\$\.database\.(?:providerRequests|budgetReservations|circuitBreakers)\[\]\.(?:site|status|costStatus|state)$/,
  /^\$\.logs\.recentProblems\[\]\.(?:at|level)$/,
];

/** System account names that are not identifying and would collide with ordinary words. */
const GENERIC_ACCOUNT_NAMES = new Set(['root', 'node', 'admin', 'user', 'users', 'ubuntu', 'runner', 'app', 'www-data', 'nobody', 'debian', 'guest', 'docker', 'vagrant', 'ec2-user']);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isLoopback(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

// ---------------------------------------------------------------------------
// Config shape redaction driven by the zod schema (enums/literals are kept).

interface ZodDefLike {
  type: string;
  innerType?: ZodLike;
  shape?: Record<string, ZodLike>;
  element?: ZodLike;
  valueType?: ZodLike;
  in?: ZodLike;
}
interface ZodLike {
  _zod?: { def?: ZodDefLike };
}

function unwrap(schema: ZodLike | undefined): ZodDefLike | null {
  let s = schema;
  for (let i = 0; i < 12 && s; i++) {
    const def = s._zod?.def;
    if (!def) return null;
    if (['default', 'prefault', 'optional', 'nullable', 'readonly', 'catch', 'nonoptional'].includes(def.type) && def.innerType) s = def.innerType;
    else if (def.type === 'pipe' && def.in) s = def.in;
    else return def;
  }
  return null;
}

const KEEP_STRING_PATHS: RegExp[] = [
  /^scheduler\.timezone$/,
  /^reporting\.businessTimezone$/,
  /^reporting\.currency$/,
  /^scheduler\.(?:weekly|monthly)\.cron$/,
  /^budgets\./,
  /^research\.apify\.maxTotalChargeUsd$/,
  /^research\.dataforseo\.pricingOverrides\.[^.]+$/,
  /^llm\.pricingOverrides\.[^.]+\.(?:input|output)PerMillionUsd$/,
];
const KEEP_RECORD_KEYS: RegExp[] = [/^budgets\.accountMonthlyUsd$/, /^research\.dataforseo\.pricingOverrides$/];

function redactConfigValue(value: unknown, schema: ZodLike | undefined, at: string, masker: IdentifierMasker): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  const def = unwrap(schema);
  if (typeof value === 'string') {
    if (value === '') return '';
    if (def && (def.type === 'enum' || def.type === 'literal')) return value;
    if (KEEP_STRING_PATHS.some((re) => re.test(at))) return value;
    if (at === 'site.url' || /^site\.urlAliases\[\]\.(?:alias|canonical)$/.test(at)) return masker.token('url', value);
    if (at === 'site.allowedHostnames[]' || at === 'research.approvedDomains[]' || at === 'research.competitors[].domain') return masker.token('host', value);
    if (at === 'google.searchConsoleProperty') return `<${value.startsWith('sc-domain:') ? 'sc-domain property' : 'url-prefix property'} h:${masker.hash(value)}>`;
    if (at === 'google.ga4PropertyId') return masker.token('ga4', value);
    if (at === 'research.apify.actorId') return value === ENV_DEFAULTS.APIFY_CONTENT_ACTOR_ID ? `${value} (default public Actor ID)` : masker.token('id', value);
    if (at === 'research.apify.build') return /^(?:latest|\d+\.\d+(?:\.\d+)?)$/.test(value) ? value : '<set>';
    return '<redacted>';
  }
  if (Array.isArray(value)) {
    const el = def?.type === 'array' ? def.element : undefined;
    return value.map((v) => redactConfigValue(v, el, `${at}[]`, masker));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    if (def?.type === 'record') {
      const keepKeys = KEEP_RECORD_KEYS.some((re) => re.test(at));
      let i = 0;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        // Kept record keys (provider/endpoint names) are still scrubbed: the final check never rewrites keys.
        const key = keepKeys ? masker.scrub(k) : `<key ${++i} h:${masker.hash(k)}>`;
        out[key] = redactConfigValue(v, def.valueType, `${at}.${keepKeys ? k : '*'}`, masker);
      }
      return out;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const child = def?.type === 'object' ? def.shape?.[k] : undefined;
      out[k] = redactConfigValue(v, child, at ? `${at}.${k}` : k, masker);
    }
    return out;
  }
  return '<redacted>';
}

export function redactConfigShape(config: SiteConfig, masker: IdentifierMasker): unknown {
  return redactConfigValue(config, siteConfigSchema as unknown as ZodLike, '', masker);
}

/** Identifying config fields (path, kind). Arrays are marked with []. */
const IDENTIFIER_PATHS: ReadonlyArray<readonly [string, IdentifierKind]> = [
  ['site.id', 'site'],
  ['site.businessName', 'name'],
  ['site.url', 'url'],
  ['site.allowedHostnames[]', 'host'],
  ['site.urlAliases[].alias', 'url'],
  ['site.urlAliases[].canonical', 'url'],
  ['google.ga4PropertyId', 'ga4'],
  ['conversions.primaryEvents[].name', 'event'],
  ['conversions.secondaryEvents[].name', 'event'],
  ['brand.aliases[]', 'name'],
  ['research.competitors[].domain', 'host'],
  ['research.competitors[].name', 'name'],
  ['research.approvedDomains[]', 'host'],
  ['research.subreddits[]', 'name'],
  ['market.searchLocations[].name', 'name'],
  ['business.productFacts[].source', 'url'],
];

function valuesAt(obj: unknown, pathExpr: string): string[] {
  let current: unknown[] = [obj];
  for (const part of pathExpr.split('.')) {
    const isArray = part.endsWith('[]');
    const key = isArray ? part.slice(0, -2) : part;
    const next: unknown[] = [];
    for (const c of current) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
      const v = (c as Record<string, unknown>)[key];
      if (isArray) {
        if (Array.isArray(v)) next.push(...v);
      } else if (v !== undefined && v !== null) next.push(v);
    }
    current = next;
  }
  return current.filter((v) => typeof v === 'string' || typeof v === 'number').map((v) => String(v));
}

/**
 * Register every identifying value of a site config with the masker. Works on a
 * validated SiteConfig AND on raw, schema-invalid YAML/JSON (fields are read
 * leniently by path; wrong types are skipped), so a config that fails
 * validation after an upgrade still has its identifiers masked.
 */
export function registerConfigIdentifiers(config: SiteConfig | unknown, masker: IdentifierMasker): void {
  for (const [p, kind] of IDENTIFIER_PATHS) {
    for (const v of valuesAt(config, p)) {
      if (kind === 'url' && p === 'business.productFacts[].source' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) continue;
      masker.register(kind, v);
    }
  }
  for (const prop of valuesAt(config, 'google.searchConsoleProperty')) {
    masker.register('property', prop);
    if (prop.startsWith('sc-domain:')) masker.register('host', prop.slice('sc-domain:'.length));
    else masker.register('url', prop);
  }
  for (const actor of valuesAt(config, 'research.apify.actorId')) if (actor !== ENV_DEFAULTS.APIFY_CONTENT_ACTOR_ID) masker.register('id', actor);
}

const IDENTIFYING_YAML_KEYS = /^(?:id|businessName|name|domain|alias|canonical|url|ga4PropertyId|searchConsoleProperty|actorId)$/;
const IDENTIFYING_YAML_LISTS = /^(?:allowedHostnames|aliases|subreddits|approvedDomains)$/;

/**
 * Last-resort registration from the raw text of a config file that is not
 * even valid YAML: URLs, sc-domain properties, hostnames, identifying
 * `key: value` scalars, and items of identifying lists. Over-masking is
 * acceptable here; leaking is not.
 */
export function registerConfigTextIdentifiers(text: string, masker: IdentifierMasker): void {
  const unquote = (v: string) => v.trim().replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '').trim();
  for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>#,\]}]+/gi)) masker.register('url', m[0]);
  for (const m of text.matchAll(/sc-domain:([A-Za-z0-9.-]+)/g)) {
    masker.register('property', m[0]);
    masker.register('host', m[1]);
  }
  for (const m of text.matchAll(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24})\b/gi)) {
    if (!FILE_EXTENSIONS.has(m[1]!.toLowerCase())) masker.register('host', m[0]);
  }
  let listKey: string | null = null;
  let listIndent = -1;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const item = /^\s*-\s+(.+)$/.exec(line);
    if (listKey && item && indent >= listIndent) {
      const v = unquote(item[1]!);
      if (!/^[A-Za-z_]+\s*:/.test(v)) masker.register(listKey === 'allowedHostnames' || listKey === 'approvedDomains' ? 'host' : 'name', v);
    } else if (listKey && indent <= listIndent && !item) listKey = null;
    const kv = /^\s*(?:-\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const rest = kv[2]!.trim();
    if (IDENTIFYING_YAML_LISTS.test(key)) {
      if (!rest || rest.startsWith('#')) {
        listKey = key;
        listIndent = indent;
      } else if (rest.startsWith('[')) {
        for (const v of rest.replace(/^\[|\].*$/g, '').split(',')) masker.register(key === 'allowedHostnames' || key === 'approvedDomains' ? 'host' : 'name', unquote(v));
      }
    } else if (IDENTIFYING_YAML_KEYS.test(key) && rest && !rest.startsWith('#') && !/^[|>[{]/.test(rest)) {
      const v = unquote(rest);
      if (v && v !== 'null' && v !== '~') masker.register('name', v);
    }
  }
}

/**
 * Register identifiers stored in the database for EVERY site (names, base
 * URLs, and the retained configuration versions), including sites without a
 * config file or excluded by --site. Read-only.
 */
export function registerDatabaseIdentifiers(db: Db, masker: IdentifierMasker): void {
  const rows = safeQuery(() => db.all<{ id: string; name: string | null; base_url: string | null }>('SELECT id, name, base_url FROM sites ORDER BY id'), []).value;
  for (const r of rows) {
    masker.register('site', r.id);
    masker.register('name', r.name);
    masker.register('url', r.base_url);
    const cfgRows = safeQuery(() => db.all<{ config_json: string }>('SELECT config_json FROM config_versions WHERE site_id = ? ORDER BY version DESC LIMIT 5', [r.id]), []).value;
    for (const c of cfgRows) {
      try {
        registerConfigIdentifiers(JSON.parse(c.config_json) as unknown, masker);
      } catch {
        /* unparseable config_json: CHECK(json_valid) makes this unlikely */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Bundle types

export interface DiagnosticIntegration {
  id: IntegrationId;
  state: IntegrationState;
  detail: string;
  nextStep?: string;
  /** Local inspection only: credential presence and config, no network request. */
  source: 'local-inspection' | 'reported-by-doctor';
  networkChecked: boolean;
}

export interface DiagnosticSite {
  label: string;
  configStatus: 'valid' | 'invalid';
  configErrors: string[];
  profile: string | null;
  features: Partial<Record<FeatureKey, { effective: boolean; explicit: boolean | null }>>;
  configShape: unknown;
  integrations: DiagnosticIntegration[];
}

export interface DiagnosticTableCount {
  table: string;
  rows: number | null;
  syntheticRows?: number;
  error?: string;
}

export interface DiagnosticJob {
  site: string;
  type: string;
  status: string;
  mode: string;
  dryRun: boolean;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: { code: string | null; message: string | null } | null;
}

export interface DiagnosticBundle {
  format: typeof DIAGNOSTICS_FORMAT;
  formatVersion: typeof DIAGNOSTICS_FORMAT_VERSION;
  generatedAt: string;
  notice: string[];
  /** Which sites the per-site sections cover (identifiers of excluded sites are still masked). */
  scope: { restrictedToSelectedSites: boolean; sitesReported: number; otherSitesExcluded: number };
  app: {
    version: string;
    node: string;
    platform: string;
    arch: string;
    osType: string;
    osRelease: string;
    cpus: number;
    totalMemoryGb: number;
    sqlite: string | null;
    playwright: 'installed' | 'not_installed';
  };
  workspace: {
    root: '<WORKSPACE>';
    source: 'flag' | 'env' | 'default' | 'unknown';
    exists: boolean;
    insideAppRepository: boolean;
    manifest: { formatVersion: number; kind: string; createdByAppVersion: string } | null;
    layout: Array<{ path: string; exists: boolean; files: number | null; bytes: number | null; mode: string | null }>;
    secretsFile: { present: boolean; mode: string | null; accessibleByOthers: boolean };
    googleCredentialFiles: number;
  };
  environment: Array<{ key: EnvKey; set: boolean; source: string; isSecret: boolean }>;
  sites: DiagnosticSite[];
  /** Statuses supplied by `doctor` (details scrubbed); empty when not provided. */
  reportedIntegrations: DiagnosticIntegration[];
  database: {
    present: boolean;
    error: string | null;
    migrations: { applied: string[]; pending: string[]; unknown: string[]; checksumMismatches: string[] } | null;
    tableCounts: DiagnosticTableCount[];
    jobs: { byStatus: Array<{ site: string; status: string; count: number }>; recent: DiagnosticJob[] };
    providerRequests: Array<{ site: string; provider: string; status: string; synthetic: boolean; count: number }>;
    budgetReservations: Array<{ site: string; provider: string; status: string; costStatus: string; count: number; estimatedMicros: number; actualMicros: number | null }>;
    circuitBreakers: Array<{ site: string; provider: string; state: string; consecutiveFailures: number; lastError: string | null }>;
  };
  logs: { present: boolean; bytesRead: number; levels: Record<string, number>; recentProblems: Array<{ at: string | null; level: string; msg: string }> };
  redaction: { identifiersMasked: number; selfCheck: { passed: boolean; removed: number }; rules: string[] };
}

// ---------------------------------------------------------------------------
// Collection

export interface DiagnosticsSiteInput {
  siteId: string;
  config: SiteConfig | null;
  error?: string;
  raw?: unknown;
  rawText?: string | null;
}

export interface DiagnosticsInput {
  paths: WorkspacePaths;
  secrets: SecretStore;
  /**
   * Site configs to report (null config = failed to load; error is scrubbed).
   * `raw`/`rawText` (the unvalidated YAML value/text) let identifiers of an
   * invalid config be masked anyway.
   */
  sites: DiagnosticsSiteInput[];
  /**
   * Sites NOT reported (excluded by --site) whose identifiers must still be
   * masked everywhere (shared logs, free-text errors).
   */
  maskOnlySites?: DiagnosticsSiteInput[];
  /** Restrict per-site database/log sections to these site ids (null/undefined = every site). */
  siteFilter?: string[] | null;
  /** Read-only database handle or null when absent/unopenable. */
  db: Db | null;
  dbError?: string | null;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  appVersion?: string;
  appRoot?: string | null;
  workspaceSource?: 'flag' | 'env' | 'default' | 'unknown';
  /** Optional statuses from `doctor` (details are scrubbed). */
  integrationStatuses?: IntegrationStatus[];
  recentJobs?: number;
  /** Injected HMAC key (tests); a random per-export key is used otherwise. */
  hmacKey?: Buffer;
  migrationsDir?: string;
}

function countDir(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  let guard = 0;
  while (stack.length && guard++ < 50_000) {
    const d = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        files++;
        try {
          bytes += statSync(p).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { files, bytes };
}

function modeOf(p: string): string | null {
  if (process.platform === 'win32') return null;
  try {
    return (statSync(p).mode & 0o777).toString(8).padStart(3, '0');
  } catch {
    return null;
  }
}

function playwrightInstalled(): 'installed' | 'not_installed' {
  try {
    createRequire(import.meta.url).resolve('playwright');
    return 'installed';
  } catch (err) {
    return (err as { code?: string }).code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' ? 'installed' : 'not_installed';
  }
}

function sqliteVersion(db: Db | null): string | null {
  try {
    if (db) return String(db.get<{ v: string }>('SELECT sqlite_version() AS v')?.v ?? null);
    const mem = new DatabaseSync(':memory:');
    try {
      return String((mem.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v);
    } finally {
      mem.close();
    }
  } catch {
    return null;
  }
}

function fileExists(p: string | undefined, base: string): boolean {
  if (!p) return false;
  try {
    return existsSync(path.isAbsolute(p) ? p : path.resolve(base, p));
  } catch {
    return false;
  }
}

/** Local (no network) integration inspection: feature flags, config, and credential PRESENCE only. */
export function inspectIntegrations(config: SiteConfig, secrets: SecretStore, paths: WorkspacePaths): DiagnosticIntegration[] {
  const f = effectiveFeatures(config);
  const out: DiagnosticIntegration[] = [];
  const add = (id: IntegrationId, state: IntegrationState, detail: string, nextStep?: string) =>
    out.push({ id, state, detail, ...(nextStep ? { nextStep } : {}), source: 'local-inspection', networkChecked: false });
  const demo = config.profile === 'demo';
  const secretsHint = 'Put it in <WORKSPACE>/secrets/secrets.env (mode 0600) or a password-manager-injected environment variable. See docs/ACCESS_SETUP.md.';

  // Google
  const mode = secrets.get('GOOGLE_AUTH_MODE') === 'service_account' ? 'service_account' : 'oauth';
  let googleCreds: boolean;
  let googleDetail: string;
  if (mode === 'service_account') {
    const set = secrets.has('GOOGLE_APPLICATION_CREDENTIALS');
    const exists = fileExists(secrets.get('GOOGLE_APPLICATION_CREDENTIALS'), paths.root);
    googleCreds = set && exists;
    googleDetail = `auth mode service_account; credentials file ${set ? (exists ? 'configured and present' : 'configured but NOT found') : 'not configured'}`;
  } else {
    const clientSet = secrets.has('GOOGLE_OAUTH_CLIENT_FILE');
    const clientExists = fileExists(secrets.get('GOOGLE_OAUTH_CLIENT_FILE'), paths.root);
    const tokenSet = secrets.has('GOOGLE_TOKEN_FILE');
    const tokenExists = fileExists(secrets.get('GOOGLE_TOKEN_FILE'), paths.root);
    googleCreds = clientExists && tokenExists;
    googleDetail = `auth mode oauth; client file ${clientSet ? (clientExists ? 'present' : 'configured but NOT found') : 'not configured'}; token file ${tokenSet ? (tokenExists ? 'present' : 'configured but NOT found') : 'not configured'}`;
  }
  const google = (id: IntegrationId, enabled: boolean, propertySet: boolean, propertyLabel: string) => {
    if (!enabled) return add(id, 'disabled', 'feature flag off');
    if (demo) return add(id, 'fixture', 'demo profile uses synthetic fixtures');
    if (!googleCreds) return add(id, 'missing_credentials', googleDetail, 'Run `npm run cli -- auth google` (see docs/ACCESS_SETUP.md).');
    if (!propertySet) return add(id, 'misconfigured', `${googleDetail}; ${propertyLabel} not configured`, `Set ${propertyLabel} in the site config (discover it with \`auth status\`).`);
    return add(id, 'configured_unverified', `${googleDetail}; ${propertyLabel} configured`);
  };
  google('google_gsc', f.gsc, !!config.google.searchConsoleProperty, 'google.searchConsoleProperty');
  google('google_ga4', f.ga4, !!config.google.ga4PropertyId, 'google.ga4PropertyId');
  google('google_url_inspection', f.urlInspection && f.gsc, !!config.google.searchConsoleProperty, 'google.searchConsoleProperty');

  // LLM Gateway
  if (!f.llm) add('llm_gateway', 'disabled', 'feature flag off');
  else if (demo) add('llm_gateway', 'fixture', 'demo profile uses the deterministic fixture client');
  else if (!secrets.has('LLM_GATEWAY_API_KEY')) add('llm_gateway', 'missing_credentials', 'LLM_GATEWAY_API_KEY not set; AI analysis is skipped', `Create a dedicated key. ${secretsHint}`);
  else {
    const cheap = !!(secrets.get('CHEAP_MODEL') || config.models.cheap);
    const reasoning = !!(secrets.get('REASONING_MODEL') || config.models.reasoning);
    const embedding = !!(secrets.get('EMBEDDING_MODEL') || config.models.embedding);
    const detail = `key present; cheap model ${cheap ? 'set' : 'unset'}, reasoning model ${reasoning ? 'set' : 'unset'}, embedding model ${embedding ? 'set' : 'unset'}${f.embeddings ? '' : ' (embeddings feature off)'}`;
    if (!cheap && !reasoning) add('llm_gateway', 'misconfigured', detail, 'Set CHEAP_MODEL / REASONING_MODEL after verifying availability with `doctor --network`.');
    else add('llm_gateway', 'configured_unverified', detail);
  }

  // DataForSEO
  const dfsMode = config.research.dataforseo.mode;
  if (!f.dataforseo || dfsMode === 'disabled') add('dataforseo', 'disabled', `feature flag ${f.dataforseo ? 'on' : 'off'}; research.dataforseo.mode ${dfsMode}`);
  else if (demo) add('dataforseo', 'fixture', 'demo profile uses synthetic fixtures');
  else if (!secrets.has('DATAFORSEO_LOGIN') || !secrets.has('DATAFORSEO_PASSWORD')) add('dataforseo', 'missing_credentials', `mode ${dfsMode}; login ${secrets.has('DATAFORSEO_LOGIN') ? 'set' : 'unset'}, password ${secrets.has('DATAFORSEO_PASSWORD') ? 'set' : 'unset'}`, `Use the API credentials from the DataForSEO dashboard. ${secretsHint}`);
  else add('dataforseo', dfsMode === 'sandbox' ? 'fixture' : 'configured_unverified', `mode ${dfsMode}${dfsMode === 'sandbox' ? ' (synthetic sandbox data, never used in recommendations)' : ''}; credentials present`);

  // Apify
  if (!f.apify) add('apify', 'disabled', 'feature flag off');
  else if (demo) add('apify', 'fixture', 'demo profile uses synthetic fixtures');
  else if (!secrets.has('APIFY_TOKEN')) add('apify', 'missing_credentials', 'APIFY_TOKEN not set', secretsHint);
  else add('apify', config.research.apify.build ? 'configured_unverified' : 'misconfigured', `token present; build ${config.research.apify.build ? 'pinned' : 'NOT pinned'}`, config.research.apify.build ? undefined : 'Run `npm run cli -- apify inspect` and pin a verified build.');

  // Qdrant
  if (!f.qdrant) add('qdrant', 'disabled', 'feature flag off (full-text retrieval only)');
  else {
    const url = secrets.get('QDRANT_URL') ?? '';
    let loopback = false;
    try {
      loopback = isLoopback(new URL(url).hostname);
    } catch {
      /* invalid */
    }
    const key = secrets.has('QDRANT_API_KEY');
    if (!url) add('qdrant', 'misconfigured', 'QDRANT_URL not set');
    else if (!loopback && !key) add('qdrant', 'misconfigured', 'remote (non-loopback) Qdrant URL without QDRANT_API_KEY', 'Protect remote Qdrant with an API key and network controls, or bind it to 127.0.0.1.');
    else add('qdrant', 'configured_unverified', `${loopback ? 'loopback' : 'remote'} URL; API key ${key ? 'set' : 'unset'}`);
  }

  // PageSpeed / CrUX
  for (const id of ['pagespeed', 'crux'] as const) {
    if (!f.pagespeed) add(id, 'disabled', 'feature flag off');
    else if (demo) add(id, 'fixture', 'demo profile uses synthetic fixtures');
    else if (!secrets.has('PAGESPEED_API_KEY')) add(id, 'missing_credentials', 'PAGESPEED_API_KEY not set (keyless calls are rejected in practice)', secretsHint);
    else add(id, 'configured_unverified', 'API key present');
  }

  // Playwright (optional dependency)
  const pw = playwrightInstalled();
  if (!f.playwright) add('playwright', 'disabled', `feature flag off; package ${pw === 'installed' ? 'installed' : 'not installed'}`);
  else if (pw === 'not_installed') add('playwright', 'disabled', 'optional-disabled: feature flag on but the optional Playwright package is not installed; direct HTTP crawling is used', 'Install Playwright only if rendering is required (see docs/ACCESS_SETUP.md).');
  else add('playwright', 'configured_unverified', 'package installed (browsers not verified)');

  // Obsidian-compatible vault
  if (!f.obsidian) add('obsidian', 'disabled', 'feature flag off');
  else {
    let exists = false;
    try {
      exists = existsSync(safeResolve(paths.vaultRoot, config.site.id));
    } catch {
      exists = false;
    }
    add('obsidian', exists ? 'ready' : 'misconfigured', `site vault directory ${exists ? 'present' : 'not created yet'} (Obsidian itself is never required)`);
  }
  return out;
}

function readLogTail(file: string, maxBytes = 256 * 1024): { text: string; bytes: number } {
  if (!existsSync(file)) return { text: '', bytes: 0 };
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return { text, bytes: buf.length };
  } finally {
    closeSync(fd);
  }
}

function safeQuery<T>(fn: () => T, fallback: T): { value: T; error: string | null } {
  try {
    return { value: fn(), error: null };
  } catch (err) {
    return { value: fallback, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Build the redacted bundle from already-loaded inputs (no writes, no network). */
export function buildDiagnosticBundle(input: DiagnosticsInput): DiagnosticBundle {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const masker = new IdentifierMasker(input.hmacKey);
  const { paths, secrets } = input;

  // Register everything that must not leak.
  masker.registerPath(paths.root, '<WORKSPACE>');
  const root = input.appRoot === undefined ? safeAppRoot() : input.appRoot;
  masker.registerPath(root, '<APP>');
  masker.registerPath(env.HOME || os.homedir(), '~');
  masker.registerPath(os.tmpdir(), '<TMP>');
  for (const key of ENV_KEYS) if (SECRET_ENV_KEYS.has(key)) masker.registerSecret(secrets.get(key));
  masker.register('login', secrets.get('DATAFORSEO_LOGIN'));
  for (const key of ['GOOGLE_OAUTH_CLIENT_FILE', 'GOOGLE_TOKEN_FILE', 'GOOGLE_APPLICATION_CREDENTIALS'] as const) masker.register('path', secrets.get(key));
  try {
    masker.register('machine', os.hostname());
  } catch {
    /* ignore */
  }
  try {
    const user = os.userInfo().username;
    if (user && user.length >= 4 && !GENERIC_ACCOUNT_NAMES.has(user.toLowerCase())) masker.register('user', user);
  } catch {
    /* ignore */
  }
  const siteLabels = new Map<string, string>();
  const labelFor = (siteId: string) => {
    let l = siteLabels.get(siteId);
    if (!l) {
      l = `site-${siteLabels.size + 1} (h:${masker.hash(siteId)})`;
      siteLabels.set(siteId, l);
    }
    return l;
  };
  // Every site's identifiers are registered BEFORE anything is scrubbed: reported
  // sites, sites excluded by --site, invalid configs (read leniently), and every
  // site known to the database.
  for (const s of [...input.sites, ...(input.maskOnlySites ?? [])]) {
    masker.register('site', s.siteId);
    if (s.config) registerConfigIdentifiers(s.config, masker);
    else {
      if (s.raw !== undefined && s.raw !== null) registerConfigIdentifiers(s.raw, masker);
      if (s.rawText) registerConfigTextIdentifiers(s.rawText, masker);
    }
  }
  if (input.db) registerDatabaseIdentifiers(input.db, masker);

  // App / platform
  const app: DiagnosticBundle['app'] = {
    version: input.appVersion ?? safeAppVersion(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osType: os.type(),
    osRelease: os.release(),
    cpus: os.cpus().length,
    totalMemoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    sqlite: sqliteVersion(input.db),
    playwright: playwrightInstalled(),
  };

  // Workspace layout
  const manifest = safeQuery(() => readManifest(paths), null).value;
  const layoutDirs: Array<[string, string]> = [
    ['config/sites', paths.sitesDir],
    ['secrets', paths.secretsDir],
    ['secrets/google', paths.googleDir],
    ['vault', paths.vaultRoot],
    ['data', paths.dataDir],
    ['data/raw', paths.rawDir],
    ['data/cache', paths.cacheDir],
    ['qdrant', paths.qdrantDir],
    ['reports', paths.reportsDir],
    ['exports', paths.exportsDir],
    ['logs', paths.logsDir],
    ['backups', paths.backupsDir],
    ['diagnostics', paths.diagnosticsDir],
  ];
  const layout = layoutDirs.map(([label, dir]) => {
    const exists = existsSync(dir);
    const counts = exists ? countDir(dir) : null;
    return { path: `<WORKSPACE>/${label}`, exists, files: counts?.files ?? null, bytes: counts?.bytes ?? null, mode: exists ? modeOf(dir) : null };
  });
  const secretsWarning = safeQuery(() => checkSecretFilePermissions(paths.secretsEnvFile), null).value;
  const workspace: DiagnosticBundle['workspace'] = {
    root: '<WORKSPACE>',
    source: input.workspaceSource ?? 'unknown',
    exists: existsSync(paths.root),
    // isRepoPath resolves symlinks on both sides (resolveRealPath), so a workspace reached through a symlink into the repository is reported.
    insideAppRepository: safeQuery(() => isRepoPath(paths.root), false).value,
    manifest: manifest ? { formatVersion: manifest.formatVersion, kind: manifest.kind, createdByAppVersion: manifest.createdByAppVersion } : null,
    layout,
    secretsFile: { present: existsSync(paths.secretsEnvFile), mode: modeOf(paths.secretsEnvFile), accessibleByOthers: !!secretsWarning },
    googleCredentialFiles: existsSync(paths.googleDir) ? countDir(paths.googleDir).files : 0,
  };

  const environment = ENV_KEYS.map((key) => ({ key, set: secrets.has(key), source: secrets.sourceOf(key), isSecret: SECRET_ENV_KEYS.has(key) }));

  // Sites
  const sites: DiagnosticSite[] = input.sites.map((s) => {
    if (!s.config) {
      return { label: labelFor(s.siteId), configStatus: 'invalid', configErrors: scrubConfigError(s.error ?? 'failed to load', masker), profile: null, features: {}, configShape: null, integrations: [] };
    }
    const eff = effectiveFeatures(s.config);
    const features: DiagnosticSite['features'] = {};
    for (const k of FEATURE_KEYS) features[k] = { effective: eff[k], explicit: s.config.features[k] ?? null };
    return {
      label: labelFor(s.siteId),
      configStatus: 'valid',
      configErrors: [],
      profile: s.config.profile,
      features,
      configShape: redactConfigShape(s.config, masker),
      integrations: inspectIntegrations(s.config, secrets, paths),
    };
  });
  const reportedIntegrations: DiagnosticIntegration[] = (input.integrationStatuses ?? []).map((st) => ({
    id: st.id,
    state: st.state,
    detail: masker.scrub(st.detail),
    ...(st.nextStep ? { nextStep: masker.scrub(st.nextStep) } : {}),
    source: 'reported-by-doctor',
    networkChecked: st.networkChecked,
  }));

  const siteFilter = input.siteFilter && input.siteFilter.length ? new Set(input.siteFilter) : null;
  const database = collectDatabase(input, masker, labelFor, siteFilter);
  const logs = collectLogs(paths, masker, siteFilter);

  const bundle: DiagnosticBundle = {
    format: DIAGNOSTICS_FORMAT,
    formatVersion: DIAGNOSTICS_FORMAT_VERSION,
    generatedAt: now.toISOString(),
    notice: DIAGNOSTICS_NOTICE,
    scope: { restrictedToSelectedSites: !!siteFilter, sitesReported: sites.length, otherSitesExcluded: (input.maskOnlySites ?? []).length },
    app,
    workspace,
    environment,
    sites,
    reportedIntegrations,
    database,
    logs,
    redaction: {
      identifiersMasked: 0,
      selfCheck: { passed: false, removed: 0 },
      rules: [
        'secret values from the secret store are replaced exactly',
        'credential shapes (Authorization headers, PEM keys, Google/Apify/LLM Gateway/GitHub/AWS/npm tokens, JWTs, key=value query params, URL credentials) are masked',
        'config values are redacted except booleans, schema enums, numbers, time zones, cron expressions, currency codes, and budget/cap amounts',
        'hostnames, URLs, Search Console properties, GA4 property IDs, emails, site IDs, business/brand/competitor/event names, subreddits, IP addresses, and long numbers are replaced with keyed hashes',
        'absolute paths are replaced with <WORKSPACE>, <APP>, <TMP>, and ~',
        'no database rows, analytics data, vault notes, raw responses, or log fields are included',
      ],
    },
  };

  // Final self-check over every string value: nothing registered may survive.
  // Keys are never rewritten for identifiers, so the structure stays intact.
  const checked = masker.finalCheckValue(JSON.parse(JSON.stringify(bundle)) as DiagnosticBundle, STRUCTURAL_VALUE_PATHS);
  const final = checked.value;
  final.redaction.identifiersMasked = masker.masked;
  final.redaction.selfCheck = { passed: true, removed: checked.removed };
  return final;
}

/**
 * Config load errors can quote values (a mismatched site id) or include YAML
 * source snippets. Keep only the message lines, mask quoted values, then scrub.
 */
export function scrubConfigError(message: string, masker: IdentifierMasker): string[] {
  const withoutSnippets = message.split(/\n\s*\n/)[0] ?? message;
  return withoutSnippets
    .split(/\n|;\s+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((line) => masker.scrub(line.replace(/"[^"\n]*"|'[^'\n]*'/g, (q) => `"<value h:${masker.hash(q.slice(1, -1))}>"`)))
    .map((line) => truncate(line, 300));
}

function safeAppRoot(): string | null {
  try {
    return appRoot();
  } catch {
    return null;
  }
}

function safeAppVersion(): string {
  try {
    return appVersion();
  } catch {
    return 'unknown';
  }
}

function collectDatabase(input: DiagnosticsInput, masker: IdentifierMasker, labelFor: (siteId: string) => string, siteFilter: Set<string> | null): DiagnosticBundle['database'] {
  const empty: DiagnosticBundle['database'] = {
    present: false,
    error: input.dbError ? masker.scrub(input.dbError) : null,
    migrations: null,
    tableCounts: [],
    jobs: { byStatus: [], recent: [] },
    providerRequests: [],
    budgetReservations: [],
    circuitBreakers: [],
  };
  const db = input.db;
  if (!db) return empty;
  const out: DiagnosticBundle['database'] = { ...empty, present: true };

  // Migration status (read-only: never creates schema_migrations).
  const applied = safeQuery(() => db.all<{ version: string; name: string; checksum: string }>('SELECT version, name, checksum FROM schema_migrations ORDER BY version'), []);
  if (applied.error) out.error = masker.scrub(`schema_migrations unreadable: ${applied.error}`);
  else {
    const files = safeQuery(() => loadMigrations(input.migrationsDir ?? appDirs.migrations()), []).value;
    const byVersion = new Map(files.map((f) => [f.version, f]));
    const appliedSet = new Set(applied.value.map((a) => a.version));
    out.migrations = {
      applied: applied.value.map((a) => a.name),
      pending: files.filter((f) => !appliedSet.has(f.version)).map((f) => f.name),
      unknown: applied.value.filter((a) => !byVersion.has(a.version)).map((a) => a.name),
      checksumMismatches: applied.value.filter((a) => byVersion.has(a.version) && byVersion.get(a.version)!.checksum !== a.checksum).map((a) => a.name),
    };
  }

  // Row counts per table (identifiers validated; never rows).
  const tables = safeQuery(() => db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"), []).value;
  for (const { name } of tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    const count = safeQuery(() => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name}"`)?.n ?? 0), null);
    const entry: DiagnosticTableCount = { table: name, rows: count.value };
    if (count.error) entry.error = masker.scrub(count.error);
    const cols = safeQuery(() => db.all<{ name: string }>(`PRAGMA table_info("${name}")`), []).value;
    if (cols.some((c) => c.name === 'is_synthetic')) {
      const syn = safeQuery(() => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name}" WHERE is_synthetic = 1`)?.n ?? 0), null).value;
      if (syn !== null) entry.syntheticRows = syn;
    }
    out.tableCounts.push(entry);
  }

  // Per-site operational summaries (every query is scoped by site_id). With
  // --site, only the selected sites are included.
  const allSiteIds = safeQuery(() => db.all<{ id: string }>('SELECT id FROM sites ORDER BY id').map((r) => r.id), []).value;
  const siteIds = siteFilter ? allSiteIds.filter((id) => siteFilter.has(id)) : allSiteIds;
  const limit = Math.max(0, Math.min(200, input.recentJobs ?? 20));
  for (const siteId of siteIds) {
    const site = labelFor(siteId);
    for (const r of safeQuery(() => db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM jobs WHERE site_id = ? GROUP BY status ORDER BY status', [siteId]), []).value) {
      out.jobs.byStatus.push({ site, status: r.status, count: Number(r.n) });
    }
    const recent = safeQuery(
      () =>
        db.all<{ type: string; status: string; mode: string; dry_run: number; attempt: number; max_attempts: number; created_at: string; started_at: string | null; finished_at: string | null; error_json: string | null }>(
          'SELECT type, status, mode, dry_run, attempt, max_attempts, created_at, started_at, finished_at, error_json FROM jobs WHERE site_id = ? ORDER BY created_at DESC LIMIT ?',
          [siteId, limit],
        ),
      [],
    ).value;
    for (const j of recent) {
      out.jobs.recent.push({
        site,
        type: masker.scrub(j.type),
        status: j.status,
        mode: j.mode,
        dryRun: j.dry_run === 1,
        attempt: Number(j.attempt),
        maxAttempts: Number(j.max_attempts),
        createdAt: j.created_at,
        startedAt: j.started_at,
        finishedAt: j.finished_at,
        error: parseJobError(j.error_json, masker),
      });
    }
    for (const r of safeQuery(() => db.all<{ provider: string; status: string; is_synthetic: number; n: number }>('SELECT provider, status, is_synthetic, COUNT(*) AS n FROM provider_requests WHERE site_id = ? GROUP BY provider, status, is_synthetic ORDER BY provider, status', [siteId]), []).value) {
      out.providerRequests.push({ site, provider: r.provider, status: r.status, synthetic: r.is_synthetic === 1, count: Number(r.n) });
    }
    for (const r of safeQuery(
      () =>
        db.all<{ provider: string; status: string; cost_status: string; n: number; est: number | null; act: number | null; act_n: number }>(
          'SELECT provider, status, cost_status, COUNT(*) AS n, SUM(estimated_usd_micros) AS est, SUM(actual_usd_micros) AS act, COUNT(actual_usd_micros) AS act_n FROM budget_reservations WHERE site_id = ? GROUP BY provider, status, cost_status ORDER BY provider, status',
          [siteId],
        ),
      [],
    ).value) {
      out.budgetReservations.push({ site, provider: r.provider, status: r.status, costStatus: r.cost_status, count: Number(r.n), estimatedMicros: Number(r.est ?? 0), actualMicros: Number(r.act_n) > 0 ? Number(r.act) : null });
    }
    for (const r of safeQuery(() => db.all<{ provider: string; state: string; consecutive_failures: number; last_error: string | null }>('SELECT provider, state, consecutive_failures, last_error FROM circuit_breakers WHERE site_id = ? ORDER BY provider', [siteId]), []).value) {
      out.circuitBreakers.push({ site, provider: r.provider, state: r.state, consecutiveFailures: Number(r.consecutive_failures), lastError: r.last_error ? truncate(masker.scrub(r.last_error), 500) : null });
    }
  }
  return out;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}... [truncated]` : s;
}

function parseJobError(errorJson: string | null, masker: IdentifierMasker): DiagnosticJob['error'] {
  if (!errorJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(errorJson);
  } catch {
    return { code: null, message: truncate(masker.scrub(errorJson), 500) };
  }
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    const code = typeof o.code === 'string' ? masker.scrub(o.code) : null;
    const message = typeof o.message === 'string' ? truncate(masker.scrub(o.message), 500) : null;
    return { code, message };
  }
  return { code: null, message: truncate(masker.scrub(String(parsed)), 500) };
}

const LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

function collectLogs(paths: WorkspacePaths, masker: IdentifierMasker, siteFilter: Set<string> | null): DiagnosticBundle['logs'] {
  const file = path.join(paths.logsDir, 'seo-agent.log');
  const { text, bytes } = safeQuery(() => readLogTail(file), { text: '', bytes: 0 }).value;
  const levels: Record<string, number> = {};
  const problems: Array<{ at: string | null; level: string; msg: string }> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: { at?: unknown; level?: unknown; msg?: unknown; site?: unknown; siteId?: unknown; site_id?: unknown };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      levels.unparsed = (levels.unparsed ?? 0) + 1;
      continue;
    }
    // Level names become object keys: only known levels are kept verbatim.
    const level = typeof entry.level === 'string' && LOG_LEVELS.has(entry.level) ? entry.level : 'other';
    // With --site, lines attributed to another site are counted but not quoted.
    const lineSite = [entry.site, entry.siteId, entry.site_id].find((v) => typeof v === 'string') as string | undefined;
    if (siteFilter && lineSite && !siteFilter.has(lineSite)) {
      levels.otherSites = (levels.otherSites ?? 0) + 1;
      continue;
    }
    levels[level] = (levels[level] ?? 0) + 1;
    if (level === 'warn' || level === 'error') {
      problems.push({ at: typeof entry.at === 'string' ? entry.at : null, level, msg: truncate(masker.scrub(typeof entry.msg === 'string' ? entry.msg : ''), 300) });
    }
  }
  return { present: existsSync(file), bytesRead: bytes, levels, recentProblems: problems.slice(-20) };
}

// ---------------------------------------------------------------------------
// Gathering from a workspace (used by the CLI)

export interface GatherOptions {
  paths: WorkspacePaths;
  env?: NodeJS.ProcessEnv;
  secrets?: SecretStore;
  siteId?: string | null;
  workspaceSource?: DiagnosticsInput['workspaceSource'];
  integrationStatuses?: IntegrationStatus[];
  recentJobs?: number;
  now?: Date;
}

/**
 * Load everything read-only from a workspace and build the bundle. Works when
 * configuration is invalid or the database is missing/corrupt: those failures
 * become part of the (redacted) report instead of aborting it. Never runs
 * migrations and never writes to the database.
 */
export function gatherDiagnostics(opts: GatherOptions): DiagnosticBundle {
  const { paths } = opts;
  const env = opts.env ?? process.env;
  const secrets = opts.secrets ?? new LayeredSecretStore(existsSync(paths.secretsEnvFile) ? paths.secretsEnvFile : null, env);
  const allIds = safeQuery(() => listSiteIds(paths), []).value;
  const selected = opts.siteId ? [opts.siteId] : allIds;
  const sites = selected.map((siteId) => loadSiteForDiagnostics(paths, siteId));
  // Other sites are loaded only so their identifiers can be masked in shared data.
  const maskOnlySites = allIds.filter((id) => !selected.includes(id)).map((siteId) => loadSiteForDiagnostics(paths, siteId));
  let db: Db | null = null;
  let dbError: string | null = null;
  if (existsSync(paths.dbFile)) {
    try {
      db = openDatabase(paths.dbFile, { readOnly: true });
    } catch (err) {
      dbError = `database could not be opened read-only: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  try {
    return buildDiagnosticBundle({
      paths,
      secrets,
      sites,
      maskOnlySites,
      siteFilter: opts.siteId ? [opts.siteId] : null,
      db,
      dbError,
      env,
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.workspaceSource ? { workspaceSource: opts.workspaceSource } : {}),
      ...(opts.integrationStatuses ? { integrationStatuses: opts.integrationStatuses } : {}),
      ...(opts.recentJobs !== undefined ? { recentJobs: opts.recentJobs } : {}),
    });
  } finally {
    db?.close();
  }
}

const MAX_CONFIG_BYTES = 1024 * 1024;

/**
 * Load one site config for diagnostics. On validation failure the raw YAML
 * value (and, if the YAML itself is broken, the raw text) is kept so the
 * site's identifiers can still be masked.
 */
function loadSiteForDiagnostics(paths: WorkspacePaths, siteId: string): DiagnosticsSiteInput {
  let rawText: string | null = null;
  try {
    const file = siteConfigFile(paths, siteId);
    if (existsSync(file) && statSync(file).size <= MAX_CONFIG_BYTES) rawText = readFileSync(file, 'utf8');
  } catch {
    rawText = null;
  }
  try {
    return { siteId, config: loadSiteConfig(paths, siteId) };
  } catch (err) {
    const details = (err as { details?: { errors?: unknown } }).details;
    const errors = Array.isArray(details?.errors) ? `: ${(details.errors as unknown[]).map(String).join('; ')}` : '';
    let raw: unknown = undefined;
    if (rawText !== null) {
      try {
        raw = parseYamlSafe(rawText, `${siteId}.yaml`);
      } catch {
        raw = undefined;
      }
    }
    return { siteId, config: null, error: `${err instanceof Error ? err.message : String(err)}${errors}`, raw, rawText };
  }
}

// ---------------------------------------------------------------------------
// Rendering and files

function fmtBytes(n: number | null): string {
  if (n === null) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

function md(s: unknown): string {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderDiagnosticsMarkdown(b: DiagnosticBundle): string {
  const L: string[] = [];
  L.push(MARKDOWN_MARKER, '', '# seo-agent diagnostics (redacted)', '');
  for (const n of b.notice) L.push(`> ${n}`);
  L.push('', `Generated: ${b.generatedAt}`, '');
  if (b.scope?.restrictedToSelectedSites) L.push(`Scope: ${b.scope.sitesReported} selected site(s); ${b.scope.otherSitesExcluded} other site(s) excluded (their identifiers are masked).`, '');
  L.push('## Environment', '');
  L.push(`- seo-agent ${b.app.version}; Node ${b.app.node}; ${b.app.platform}/${b.app.arch} (${b.app.osType} ${b.app.osRelease}); ${b.app.cpus} CPU(s), ${b.app.totalMemoryGb} GB RAM`);
  L.push(`- SQLite ${b.app.sqlite ?? 'unknown'}; Playwright ${b.app.playwright === 'installed' ? 'installed' : 'not installed (optional)'}`);
  L.push('');
  L.push('## Workspace', '');
  L.push(`- Location: <WORKSPACE> (source: ${b.workspace.source}); exists: ${b.workspace.exists ? 'yes' : 'no'}; inside the application repository: ${b.workspace.insideAppRepository ? 'YES (not recommended)' : 'no'}`);
  L.push(`- Manifest: ${b.workspace.manifest ? `format ${b.workspace.manifest.formatVersion}, kind ${b.workspace.manifest.kind}, created by ${b.workspace.manifest.createdByAppVersion}` : 'missing'}`);
  L.push(`- Secrets file: ${b.workspace.secretsFile.present ? `present (mode ${b.workspace.secretsFile.mode ?? 'n/a'}${b.workspace.secretsFile.accessibleByOthers ? ', ACCESSIBLE BY OTHER USERS: run chmod 600' : ''})` : 'absent'}; Google credential files: ${b.workspace.googleCredentialFiles}`);
  L.push('', '| Directory | Exists | Files | Size | Mode |', '| --- | --- | --- | --- | --- |');
  for (const d of b.workspace.layout) L.push(`| ${d.path} | ${d.exists ? 'yes' : 'no'} | ${d.files ?? '-'} | ${fmtBytes(d.bytes)} | ${d.mode ?? '-'} |`);
  L.push('', '## Environment variables (presence only, never values)', '', '| Key | Set | Source | Secret |', '| --- | --- | --- | --- |');
  for (const e of b.environment) L.push(`| ${e.key} | ${e.set ? 'yes' : 'no'} | ${e.source} | ${e.isSecret ? 'yes' : 'no'} |`);
  L.push('', '## Sites', '');
  if (!b.sites.length) L.push('No site configuration found.');
  for (const s of b.sites) {
    L.push(`### ${s.label}`, '');
    L.push(`- Config: ${s.configStatus}${s.profile ? `; profile ${s.profile}` : ''}`);
    for (const e of s.configErrors) L.push(`  - ${md(e)}`);
    const on = Object.entries(s.features).filter(([, v]) => v?.effective).map(([k]) => k);
    const off = Object.entries(s.features).filter(([, v]) => v && !v.effective).map(([k]) => k);
    if (s.configStatus === 'valid') L.push(`- Features on: ${on.join(', ') || 'none'}`, `- Features off: ${off.join(', ') || 'none'}`);
    if (s.integrations.length) {
      L.push('', '| Integration | State | Detail | Source |', '| --- | --- | --- | --- |');
      for (const i of s.integrations) L.push(`| ${i.id} | ${i.state} | ${md(i.detail)}${i.nextStep ? ` Next: ${md(i.nextStep)}` : ''} | ${i.source}${i.networkChecked ? ' (network)' : ''} |`);
    }
    L.push('');
  }
  if (b.reportedIntegrations.length) {
    L.push('## Integration checks reported by doctor', '', '| Integration | State | Detail | Network check |', '| --- | --- | --- | --- |');
    for (const i of b.reportedIntegrations) L.push(`| ${i.id} | ${i.state} | ${md(i.detail)}${i.nextStep ? ` Next: ${md(i.nextStep)}` : ''} | ${i.networkChecked ? 'yes' : 'no'} |`);
    L.push('');
  }
  L.push('## Database', '');
  if (!b.database.present) L.push(`No database available${b.database.error ? `: ${md(b.database.error)}` : ''}.`);
  else {
    if (b.database.error) L.push(`- Error: ${md(b.database.error)}`);
    const m = b.database.migrations;
    if (m) {
      L.push(`- Migrations applied: ${m.applied.length}; pending: ${m.pending.join(', ') || 'none'}`);
      if (m.unknown.length) L.push(`- UNKNOWN migrations (database newer than this app): ${m.unknown.join(', ')}`);
      if (m.checksumMismatches.length) L.push(`- CHECKSUM MISMATCH: ${m.checksumMismatches.join(', ')}`);
    }
    if (b.database.jobs.byStatus.length) {
      L.push('', '| Site | Job status | Count |', '| --- | --- | --- |');
      for (const r of b.database.jobs.byStatus) L.push(`| ${r.site} | ${r.status} | ${r.count} |`);
    }
    if (b.database.jobs.recent.length) {
      L.push('', '### Recent jobs', '', '| Site | Type | Status | Mode | Attempt | Created | Error |', '| --- | --- | --- | --- | --- | --- | --- |');
      for (const j of b.database.jobs.recent) L.push(`| ${j.site} | ${md(j.type)} | ${j.status} | ${j.mode}${j.dryRun ? ' (dry run)' : ''} | ${j.attempt}/${j.maxAttempts} | ${j.createdAt} | ${j.error ? md(`${j.error.code ?? ''} ${j.error.message ?? ''}`.trim()) : ''} |`);
    }
    if (b.database.providerRequests.length) {
      L.push('', '### Provider requests', '', '| Site | Provider | Status | Synthetic | Count |', '| --- | --- | --- | --- | --- |');
      for (const r of b.database.providerRequests) L.push(`| ${r.site} | ${r.provider} | ${r.status} | ${r.synthetic ? 'yes' : 'no'} | ${r.count} |`);
    }
    if (b.database.budgetReservations.length) {
      L.push('', '### Budget reservations', '', '| Site | Provider | Status | Cost status | Count | Estimated (micro-USD) | Actual (micro-USD) |', '| --- | --- | --- | --- | --- | --- | --- |');
      for (const r of b.database.budgetReservations) L.push(`| ${r.site} | ${r.provider} | ${r.status} | ${r.costStatus} | ${r.count} | ${r.estimatedMicros} | ${r.actualMicros ?? 'unknown'} |`);
    }
    if (b.database.circuitBreakers.length) {
      L.push('', '### Circuit breakers', '', '| Site | Provider | State | Failures | Last error |', '| --- | --- | --- | --- | --- |');
      for (const r of b.database.circuitBreakers) L.push(`| ${r.site} | ${r.provider} | ${r.state} | ${r.consecutiveFailures} | ${md(r.lastError ?? '')} |`);
    }
    L.push('', '### Row counts per table (no rows included)', '', '| Table | Rows | Synthetic rows |', '| --- | --- | --- |');
    for (const t of b.database.tableCounts) L.push(`| ${t.table} | ${t.rows ?? `error: ${md(t.error)}`} | ${t.syntheticRows ?? '-'} |`);
  }
  L.push('', '## Logs', '');
  if (!b.logs.present) L.push('No log file.');
  else {
    L.push(`- Levels (last ${fmtBytes(b.logs.bytesRead)}): ${Object.entries(b.logs.levels).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
    for (const p of b.logs.recentProblems) L.push(`- ${p.at ?? '?'} [${p.level}] ${md(p.msg)}`);
  }
  L.push('', '## Redaction', '');
  L.push(`- Identifiers masked: ${b.redaction.identifiersMasked}; final self-check ${b.redaction.selfCheck.passed ? 'passed' : 'FAILED'} (${b.redaction.selfCheck.removed} leftover value(s) removed)`);
  for (const r of b.redaction.rules) L.push(`- ${r}`);
  L.push('', 'Before sharing: read this file and the JSON bundle end to end. Nothing was uploaded.');
  return `${L.join('\n')}\n`;
}

export interface WrittenBundle {
  jsonFile: string;
  markdownFile: string;
  uploaded: false;
}

/** Write the bundle as JSON + Markdown (mode 0600, never overwriting). */
export function writeDiagnosticsBundle(bundle: DiagnosticBundle, diagnosticsDir: string, now: Date = new Date(bundle.generatedAt)): WrittenBundle {
  mkdirSync(diagnosticsDir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
  const suffix = randomBytes(3).toString('hex');
  const base = `diagnostics-${stamp}-${suffix}`;
  const jsonFile = safeResolve(diagnosticsDir, `${base}.json`);
  const markdownFile = safeResolve(diagnosticsDir, `${base}.md`);
  writeFileSync(jsonFile, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  writeFileSync(markdownFile, renderDiagnosticsMarkdown(bundle), { mode: 0o600, flag: 'wx' });
  return { jsonFile, markdownFile, uploaded: false };
}

export type ReadDiagnostics = { kind: 'json'; bundle: DiagnosticBundle; file: string } | { kind: 'markdown'; text: string; file: string };

/** Resolve a bundle path: a bare name is looked up inside the diagnostics directory (no traversal). */
export function resolveDiagnosticsFile(diagnosticsDir: string, file: string): string {
  if (path.isAbsolute(file)) return file;
  if (!file.includes('/') && !file.includes('\\')) return safeResolve(diagnosticsDir, file);
  return path.resolve(file);
}

export function readDiagnosticsFile(file: string): ReadDiagnostics {
  if (!existsSync(file)) throw new AppError('NOT_FOUND', `Diagnostics file not found: ${file}`, { hint: 'Run `npm run cli -- diagnostics list` to see exported bundles.' });
  const text = readFileSync(file, 'utf8');
  if (text.startsWith(MARKDOWN_MARKER)) return { kind: 'markdown', text, file };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError('VALIDATION_FAILED', `${path.basename(file)} is not a seo-agent diagnostics bundle`);
  }
  const b = parsed as Partial<DiagnosticBundle>;
  if (b.format !== DIAGNOSTICS_FORMAT) throw new AppError('VALIDATION_FAILED', `${path.basename(file)} is not a seo-agent diagnostics bundle`);
  if (b.formatVersion !== DIAGNOSTICS_FORMAT_VERSION) throw new AppError('VALIDATION_FAILED', `Unsupported diagnostics format version ${String(b.formatVersion)}`);
  return { kind: 'json', bundle: parsed as DiagnosticBundle, file };
}

export function listDiagnosticsFiles(diagnosticsDir: string): Array<{ name: string; bytes: number; modifiedAt: string }> {
  if (!existsSync(diagnosticsDir)) return [];
  return readdirSync(diagnosticsDir)
    .filter((f) => /^diagnostics-.*\.(?:json|md)$/.test(f))
    .sort()
    .map((name) => {
      const st = statSync(path.join(diagnosticsDir, name));
      return { name, bytes: st.size, modifiedAt: st.mtime.toISOString() };
    });
}

/** Stable digest of a bundle's content (for tests and change detection). */
export function bundleDigest(b: DiagnosticBundle): string {
  return sha256(JSON.stringify({ ...b, generatedAt: '' }));
}
