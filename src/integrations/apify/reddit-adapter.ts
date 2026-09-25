import type { AppContext } from '../../app/context.js';
import { ENV_KEYS, SECRET_ENV_KEYS, type EnvKey } from '../../config/env.js';
import { isSecretKey, redactString } from '../../security/redact.js';
import { propertyTypes, validateInputAgainstSchema, type ActorInputSchema, type InputProperty } from './input-schema.js';

/**
 * Typed adapter for the Apify Reddit Scraper actor.
 *
 * The Actor ID is authoritative (spec section 15): `9sHOY9RzPYGjmTHo8`,
 * publicly listed as `harshmaur/reddit-scraper`. No other actor is ever
 * substituted by this adapter.
 *
 * Field names below come from docs/integration-contracts.md section 7
 * ("Input type", live build 0.0.513 on 2026-09-24). They are only a DEFAULT
 * MAPPING: every run validates the built input against the stored, verified
 * schema of the pinned build, and a field missing from that schema is never
 * sent.
 */

export const REDDIT_SCRAPER_ACTOR_ID = '9sHOY9RzPYGjmTHo8';
export const REDDIT_SCRAPER_LISTING = { username: 'harshmaur', name: 'reddit-scraper' } as const;

/** Research fields the adapter sets itself. */
export const MANAGED_RESEARCH_FIELDS = [
  'searchTerms',
  'searchPosts',
  'searchComments',
  'searchCommunities',
  'withinCommunity',
  'searchSort',
  'searchTime',
  'postedAfter',
  'postedBefore',
  'crawlCommentsPerPost',
  'includeNSFW',
  'maxPostsCount',
  'maxCommentsCount',
  'maxCommentsPerPost',
  'maxCommunitiesCount',
] as const;

/**
 * Direct-URL and full-subreddit inputs. Sort, time range, and community apply
 * only to `searchTerms`, not to these (contract section 7), and they can
 * target user profiles, so the time-range policy and the result/cost bounds
 * cannot be enforced for them. The adapter sets the list inputs to `[]` and
 * rejects any attempt to set them through `extraInput`.
 */
export const URL_INPUT_FIELDS = ['startUrls', 'subredditUrls', 'fastMode'] as const;
/** Narrowing filters that `extraInput` may set (validated; dates must lie inside the configured time window). */
export const EXTRA_INPUT_FILTER_FIELDS = ['onlyWithFlair', 'commentedAfter', 'commentedBefore'] as const;
/** Known fields the adapter does not manage itself. */
export const KNOWN_NEUTRAL_FIELDS = [...URL_INPUT_FIELDS, ...EXTRA_INPUT_FILTER_FIELDS] as const;

/** AI add-ons (paid `analyzed_item` / `custom_label` events). Always forced off. */
export const AI_ADDON_BOOLEAN_FIELDS = ['aiAnalysis', 'wantsHelp', 'isOwner', 'isVendor', 'hasPain', 'mentionsPrice', 'featureRequest', 'willingToPay', 'painPoint', 'competitor'] as const;
export const AI_ADDON_OBJECT_FIELDS = ['customLabels'] as const;

/**
 * Outbound MCP delivery inputs. Plain-string activation fields are sent as
 * explicit empty strings ("Leave empty to scrape only"); the connector
 * resource reference and the secret token stay absent (see analyzeSchemaForAdapter).
 */
export const DELIVERY_FIELDS = [
  'mcpConnector',
  'mcpMode',
  'mcpTarget',
  'mcpComments',
  'mcpCommentsPerPost',
  'mcpMessage',
  'mcpTool',
  'mcpArguments',
  'mcpMaxItems',
  'mcpServerUrl',
  'mcpServerToken',
] as const;
/** Delivery fields whose non-empty value would activate outbound delivery. */
export const DELIVERY_ACTIVATION_FIELDS = ['mcpConnector', 'mcpTarget', 'mcpTool', 'mcpServerUrl', 'mcpServerToken'] as const;

/** Which input fields trigger which paid events (from the actor's pricing descriptions). */
export const EVENT_TRIGGER_FIELDS: Record<string, readonly string[]> = {
  analyzed_item: AI_ADDON_BOOLEAN_FIELDS,
  custom_label: [...AI_ADDON_BOOLEAN_FIELDS.filter((f) => f !== 'aiAnalysis'), ...AI_ADDON_OBJECT_FIELDS],
};

const KNOWN = new Set<string>([...MANAGED_RESEARCH_FIELDS, ...KNOWN_NEUTRAL_FIELDS, ...AI_ADDON_BOOLEAN_FIELDS, ...AI_ADDON_OBJECT_FIELDS, ...DELIVERY_FIELDS]);

const RISKY_NAME_RE =
  /(webhook|mcp|integrat|notif|slack|discord|telegram|whatsapp|email|sms|zapier|n8n|callback|deliver|upload|export|sheet|airtable|notion|hubspot|crm|analy[sz]|llm|openai|gpt|claude|gemini|sentiment|label|classif|summar|enrich)/i;
/** Case-sensitive camelCase "AI" detection (e.g. aiSummary, useAiTags, runAI). */
const RISKY_AI_CAMEL_RE = /(^ai([A-Z_]|$)|[a-z]Ai([A-Z]|$)|[a-z]AI([A-Z]|$)|^AI([A-Z_]|$))/;
const RISKY_TEXT_RE = /\b(AI|LLM|GPT|webhooks?|MCP|deliver(y|s)?|send (results|them|items|to)|notify|notifications?|integrations?|analy[sz]e[sd]?|analysis|sentiment)\b/i;
/**
 * Negated toggles ("skipAiEnrichment", "disableWebhookDelivery", "No AI"):
 * `false` would turn the risky feature ON, so they are never forced.
 */
const NEGATED_NAME_RE = /^(skip|disable|disabled|dont|do_?not|no|not|without|exclude|omit|suppress|block|prevent|avoid|ignore|opt_?out|turn_?off|off)([A-Z_\-]|$)|(Skip|Disable|Disabled|Dont|DoNot|Without|Exclude|Omit|Suppress|Block|Prevent|Avoid|Ignore|OptOut|TurnOff)([A-Z_]|$)/;
const NEGATED_TITLE_RE = /^\s*(skip|disable[sd]?|don'?t|do not|without|exclude|omit|suppress|opt[- ]?out( of)?|turn off|no)\b/i;

export interface ForcedField {
  field: string;
  value: unknown;
  reason: string;
}

export interface AdapterSchemaAnalysis {
  ok: boolean;
  errors: string[];
  warnings: string[];
  forcedOff: ForcedField[];
  keptAbsent: Array<{ field: string; reason: string }>;
  unmappedFields: string[];
  missingKnownFields: string[];
}

function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
}

function looksRisky(name: string, p: InputProperty): boolean {
  return RISKY_NAME_RE.test(name) || RISKY_AI_CAMEL_RE.test(name) || RISKY_TEXT_RE.test(`${p.title ?? ''} ${p.description ?? ''} ${p.resourceType ?? ''}`);
}

function looksNegated(name: string, p: InputProperty): boolean {
  return NEGATED_NAME_RE.test(name) || NEGATED_TITLE_RE.test(p.title ?? '');
}

/** A plain, non-secret string property that accepts "" (no enum/pattern/resource reference). */
function acceptsEmptyString(p: InputProperty): boolean {
  if (!propertyTypes(p).includes('string') || p.isSecret === true || p.resourceType) return false;
  if (p.enum && !p.enum.includes('')) return false;
  if (p.pattern) {
    try {
      if (!new RegExp(p.pattern).test('')) return false;
    } catch {
      return false;
    }
  }
  const minLength = (p as { minLength?: unknown }).minLength;
  return !(typeof minLength === 'number' && minLength > 0);
}

/**
 * Decide, for a given schema, which fields must be forced off, which stay
 * absent, and whether the adapter can run at all. Unknown fields that look
 * like AI add-ons, delivery, webhooks, or integrations are disabled when a
 * safe "off" value exists and block the run when they cannot be disabled.
 */
export function analyzeSchemaForAdapter(schema: ActorInputSchema): AdapterSchemaAnalysis {
  const props = schema.properties;
  const errors: string[] = [];
  const warnings: string[] = [];
  const forcedOff: ForcedField[] = [];
  const keptAbsent: Array<{ field: string; reason: string }> = [];
  const unmapped: string[] = [];

  for (const f of AI_ADDON_BOOLEAN_FIELDS) if (props[f]) forcedOff.push({ field: f, value: false, reason: 'AI analysis add-on (paid event) disabled' });
  for (const f of AI_ADDON_OBJECT_FIELDS) if (props[f]) forcedOff.push({ field: f, value: {}, reason: 'AI custom labels (paid event) disabled' });

  for (const f of DELIVERY_FIELDS) {
    const p = props[f];
    if (!p) continue;
    const activates = (DELIVERY_ACTIVATION_FIELDS as readonly string[]).includes(f);
    if (!activates) {
      keptAbsent.push({ field: f, reason: 'outbound MCP delivery option: inert without a connector/target (all activation fields are empty)' });
    } else if (acceptsEmptyString(p)) {
      forcedOff.push({ field: f, value: '', reason: 'outbound MCP delivery explicitly disabled (empty = scrape only)' });
    } else if (isEmptyValue(p.default)) {
      keptAbsent.push({
        field: f,
        reason: p.isSecret
          ? 'secret delivery credential: never set by this application (empty by default; ignored without a server URL)'
          : 'delivery resource reference: left unset (empty by default); an explicit empty value is unverified for resource fields',
      });
    } else if (propertyTypes(p).includes('string') && p.isSecret !== true) {
      forcedOff.push({ field: f, value: '', reason: 'outbound MCP delivery target blanked (schema default is non-empty)' });
    } else {
      errors.push(`Delivery field "${f}" has a non-empty default that cannot be safely blanked; review the schema before running.`);
    }
  }

  for (const [name, p] of Object.entries(props)) {
    if (KNOWN.has(name)) continue;
    const types = propertyTypes(p);
    if (looksRisky(name, p)) {
      if (types.includes('boolean')) {
        // Only a positively named toggle whose default is already off can be forced to false safely.
        if (looksNegated(name, p)) errors.push(`Unrecognized toggle "${name}" looks like a negated AI/delivery/integration switch; false could turn the feature on. Review the schema before running.`);
        else if (p.default === true) errors.push(`Unrecognized AI/delivery/integration toggle "${name}" defaults to true; its polarity cannot be verified automatically. Review the schema before running.`);
        else forcedOff.push({ field: name, value: false, reason: 'unrecognized add-on/delivery/AI toggle forced off (default off, positive name)' });
      } else if (types.includes('object')) forcedOff.push({ field: name, value: {}, reason: 'unrecognized add-on/delivery/AI object emptied' });
      else if (types.includes('array') && (p.minItems ?? 0) === 0) forcedOff.push({ field: name, value: [], reason: 'unrecognized add-on/delivery/AI list emptied' });
      else if (isEmptyValue(p.default)) keptAbsent.push({ field: name, reason: 'unrecognized add-on/delivery/AI field left unset (empty default)' });
      else errors.push(`Unrecognized field "${name}" looks like an AI add-on, delivery, webhook, or integration and has a non-empty default that cannot be disabled safely.`);
    } else {
      unmapped.push(name);
    }
  }
  if (unmapped.length) warnings.push(`Unmapped schema fields left at actor defaults: ${unmapped.join(', ')}`);

  const missingKnown = [...MANAGED_RESEARCH_FIELDS].filter((f) => !props[f]);
  if (!props.searchTerms) errors.push('Schema has no "searchTerms" field: keyword research is not possible with this build.');
  if (!props.maxPostsCount) errors.push('Schema has no "maxPostsCount" field: the result count cannot be limited, so runs are refused.');
  if (!props.searchTime && !props.postedAfter) errors.push('Schema has neither "searchTime" nor "postedAfter": the time range cannot be limited, so runs are refused.');
  for (const f of missingKnown) if (!['searchTerms', 'maxPostsCount'].includes(f)) warnings.push(`Known field "${f}" is absent from this schema.`);
  for (const req of schema.required ?? []) {
    if (!(MANAGED_RESEARCH_FIELDS as readonly string[]).includes(req) && !forcedOff.some((f) => f.field === req)) {
      errors.push(`Schema requires "${req}", which this adapter does not know how to set safely.`);
    }
  }
  return { ok: errors.length === 0, errors, warnings, forcedOff, keptAbsent, unmappedFields: unmapped, missingKnownFields: missingKnown };
}

export type RedditSort = 'relevance' | 'hot' | 'top' | 'new' | 'comments';
export type RedditTimeRange = 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';

export interface RedditResearchRequest {
  searchTerms: string[];
  withinCommunity?: string | null;
  sort?: RedditSort;
  timeRange: RedditTimeRange;
  /** YYYY-MM-DD (UTC per the actor docs). Setting it makes the actor ignore searchTime. */
  postedAfter?: string | null;
  postedBefore?: string | null;
  /**
   * Earliest date (YYYY-MM-DD, UTC) any date filter may reach, derived from the
   * configured time range; null/absent = unlimited ('all'). Date filters are
   * day-granular, so the effective window can start up to one day earlier than
   * the exact time-range boundary.
   */
  earliestDate?: string | null;
  /** Today's date (YYYY-MM-DD, UTC): date filters in the future are rejected. */
  today?: string;
  /** Upper bound on posts across all search terms. */
  maxItems: number;
  /** Upper bound on comments crawled per post (0 disables comment crawling). */
  maxCommentsPerPost: number;
  /** Advanced: narrowing filters only (EXTRA_INPUT_FILTER_FIELDS). Managed, URL, AI, and delivery fields cannot be set. */
  extraInput?: Record<string, unknown>;
}

export interface BuiltRedditInput {
  input: Record<string, unknown>;
  /** The exact JSON body sent to Apify (compared with the run's INPUT record when reconciling ambiguous submissions). */
  body: string;
  postsBound: number;
  commentsBound: number;
  /** Upper bound on stored results (posts + comments) used for cost estimation. */
  maxResults: number;
  forcedOff: ForcedField[];
  keptAbsent: Array<{ field: string; reason: string }>;
  unmappedFields: string[];
  /** Paid events whose triggers are disabled by this input. */
  disabledEvents: string[];
  warnings: string[];
}

export type BuildResult = { ok: true; built: BuiltRedditInput } | { ok: false; errors: string[]; warnings: string[] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

function clampToSchema(p: InputProperty | undefined, n: number): number {
  let v = n;
  if (p?.maximum !== undefined) v = Math.min(v, Math.floor(p.maximum));
  if (p?.minimum !== undefined) v = Math.max(v, Math.ceil(p.minimum));
  return v;
}

/**
 * Build the actor input ONLY from fields present in the verified schema,
 * enforcing result/comment/time limits and forcing AI add-ons and delivery off.
 *
 * `maxPostsCount` scope is ambiguous in the actor docs (total vs per search
 * term), so it is set to floor(maxItems / terms): the post bound holds under
 * either interpretation.
 */
export function buildRedditInput(schema: ActorInputSchema, req: RedditResearchRequest): BuildResult {
  const analysis = analyzeSchemaForAdapter(schema);
  const errors = [...analysis.errors];
  const warnings = [...analysis.warnings];
  const props = schema.properties;
  const has = (f: string) => Object.prototype.hasOwnProperty.call(props, f);

  const terms = [...new Set(req.searchTerms.map((t) => t.trim()).filter(Boolean))];
  if (terms.length === 0) errors.push('At least one search term is required.');
  if (terms.some((t) => t.length > 200)) errors.push('Search terms must be at most 200 characters.');
  if (!Number.isInteger(req.maxItems) || req.maxItems < 1) errors.push('maxItems must be a positive integer.');
  if (!Number.isInteger(req.maxCommentsPerPost) || req.maxCommentsPerPost < 0) errors.push('maxCommentsPerPost must be a non-negative integer.');
  if (terms.length > 0 && Number.isInteger(req.maxItems) && terms.length > req.maxItems) {
    errors.push(`${terms.length} search terms exceed the result bound of ${req.maxItems} posts; use fewer terms or raise research.apify.maxItems.`);
  }
  const extra = req.extraInput ?? {};
  const dateFilters: Array<[string, unknown]> = [
    ['postedAfter', req.postedAfter],
    ['postedBefore', req.postedBefore],
    ['commentedAfter', extra.commentedAfter],
    ['commentedBefore', extra.commentedBefore],
  ];
  for (const [k, v] of dateFilters) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || !isValidDate(v)) {
      errors.push(`${k} must be YYYY-MM-DD.`);
      continue;
    }
    if (req.earliestDate && v < req.earliestDate) {
      errors.push(`${k} ${v} is outside the configured time range (research.apify.timeRange "${req.timeRange}" allows ${req.earliestDate} or later); widen the configured range to go further back.`);
    }
    if (req.today && k.endsWith('After') && v > req.today) errors.push(`${k} ${v} is in the future.`);
  }
  if (req.postedAfter && req.postedBefore && isValidDate(req.postedAfter) && isValidDate(req.postedBefore) && req.postedBefore < req.postedAfter) {
    errors.push('postedBefore is earlier than postedAfter (empty window).');
  }
  if (errors.length) return { ok: false, errors, warnings };

  const input: Record<string, unknown> = {};
  input.searchTerms = terms;
  if (has('searchPosts')) input.searchPosts = true;
  if (has('searchComments')) input.searchComments = false;
  if (has('maxCommentsCount')) input.maxCommentsCount = 0;
  if (has('searchCommunities')) input.searchCommunities = false;
  if (has('maxCommunitiesCount')) input.maxCommunitiesCount = 0;
  if (has('includeNSFW')) input.includeNSFW = false;
  // Direct-URL / full-subreddit inputs are not used (time range, sort, and bounds do not apply to them).
  for (const f of ['startUrls', 'subredditUrls'] as const) if (has(f)) input[f] = [];

  if (req.withinCommunity) {
    if (has('withinCommunity')) input.withinCommunity = req.withinCommunity.trim();
    else errors.push('A community restriction was requested but the schema has no "withinCommunity" field.');
  }

  if (has('searchSort')) {
    const sort = req.sort ?? 'relevance';
    const allowed = props.searchSort?.enum;
    if (allowed && !allowed.includes(sort)) errors.push(`searchSort "${sort}" is not allowed by the schema (${JSON.stringify(allowed)}).`);
    else input.searchSort = sort;
  }

  // Time range.
  if (has('searchTime')) {
    const allowed = props.searchTime?.enum;
    if (allowed && !allowed.includes(req.timeRange)) errors.push(`searchTime "${req.timeRange}" is not allowed by the schema (${JSON.stringify(allowed)}).`);
    else input.searchTime = req.timeRange;
  }
  if (req.postedAfter) {
    if (has('postedAfter')) input.postedAfter = req.postedAfter;
    else errors.push('postedAfter was requested but the schema has no "postedAfter" field.');
  } else if (!('searchTime' in input) && has('postedAfter') && req.earliestDate) {
    // No searchTime control in this build: enforce the configured window with the date filter.
    input.postedAfter = req.earliestDate;
    warnings.push(`The schema has no "searchTime" field; the configured time range is enforced as postedAfter=${req.earliestDate}.`);
  }
  if (req.postedBefore) {
    if (has('postedBefore')) input.postedBefore = req.postedBefore;
    else errors.push('postedBefore was requested but the schema has no "postedBefore" field.');
  }
  if (!('searchTime' in input) && !('postedAfter' in input)) {
    errors.push('No supported time-range control could be set (searchTime not in schema; pass postedAfter).');
  }

  // Result count.
  let perTerm = Math.floor(req.maxItems / Math.max(1, terms.length));
  perTerm = clampToSchema(props.maxPostsCount, perTerm);
  if (perTerm < 1) errors.push('The schema bounds for maxPostsCount do not allow at least one post per term.');
  input.maxPostsCount = perTerm;
  const postsBound = perTerm * terms.length;

  // Comments per post.
  let commentsBound = 0;
  if (req.maxCommentsPerPost > 0 && has('crawlCommentsPerPost') && has('maxCommentsPerPost')) {
    const perPost = clampToSchema(props.maxCommentsPerPost, req.maxCommentsPerPost);
    input.crawlCommentsPerPost = true;
    input.maxCommentsPerPost = perPost;
    commentsBound = postsBound * perPost;
  } else {
    if (has('crawlCommentsPerPost')) input.crawlCommentsPerPost = false;
    if (has('maxCommentsPerPost')) input.maxCommentsPerPost = 0;
    if (req.maxCommentsPerPost > 0) warnings.push('Comment crawling disabled: the schema has no bounded per-post comment control.');
  }

  for (const f of analysis.forcedOff) input[f.field] = f.value;

  if (req.extraInput) {
    const protectedFields = new Set<string>([
      ...MANAGED_RESEARCH_FIELDS,
      ...AI_ADDON_BOOLEAN_FIELDS,
      ...AI_ADDON_OBJECT_FIELDS,
      ...DELIVERY_FIELDS,
      ...analysis.forcedOff.map((f) => f.field),
      ...analysis.keptAbsent.map((f) => f.field),
    ]);
    const allowed = new Set<string>(EXTRA_INPUT_FILTER_FIELDS);
    for (const [k, v] of Object.entries(req.extraInput)) {
      if (!has(k)) errors.push(`"${k}" is not a field of the verified input schema`);
      else if (protectedFields.has(k)) errors.push(`"${k}" is managed by the adapter (limits, AI add-ons, or delivery) and cannot be overridden.`);
      else if ((URL_INPUT_FIELDS as readonly string[]).includes(k)) {
        errors.push(`"${k}" (direct URL / full-subreddit input) is not supported: the time range, sort, and community apply only to searchTerms, profile URLs would collect personal data, and results/cost could not be bounded.`);
      } else if (!allowed.has(k)) errors.push(`"${k}" is not an allowed extra input; only the narrowing filters ${[...allowed].join(', ')} may be set.`);
      else input[k] = v;
    }
  }

  errors.push(...validateInputAgainstSchema(input, schema));
  if (errors.length) return { ok: false, errors, warnings };

  // An event counts as disabled only when at least one of its trigger fields exists in the schema
  // and every existing trigger is explicitly off in the input; otherwise it is priced per result.
  const disabledEvents = Object.entries(EVENT_TRIGGER_FIELDS)
    .filter(([, triggers]) => {
      const present = triggers.filter((t) => has(t));
      return present.length > 0 && present.every((t) => t in input && (input[t] === false || isEmptyValue(input[t])));
    })
    .map(([event]) => event);

  return {
    ok: true,
    built: {
      input,
      body: JSON.stringify(input),
      postsBound,
      commentsBound,
      maxResults: postsBound + commentsBound,
      forcedOff: analysis.forcedOff,
      keptAbsent: analysis.keptAbsent,
      unmappedFields: analysis.unmappedFields,
      disabledEvents,
      warnings,
    },
  };
}

/** Credential-bearing environment keys whose values must never reach the actor input. */
const SENSITIVE_ENV_KEYS: readonly EnvKey[] = ENV_KEYS.filter(
  (k) => SECRET_ENV_KEYS.has(k) || k === 'DATAFORSEO_LOGIN' || k === 'GOOGLE_OAUTH_CLIENT_FILE' || k === 'GOOGLE_TOKEN_FILE' || k === 'GOOGLE_APPLICATION_CREDENTIALS',
);

const SECRETISH_KEY_RE = /(token|secret|password|passwd|api[_-]?key|apikey|credential|authorization|cookie|private[_-]?key)/i;

export interface SensitiveValues {
  /** [label, value] pairs; labels are env key names, never the values. */
  values: Array<[string, string]>;
  privatePaths: string[];
}

/** Collect configured secret values and private workspace paths to scan for (values never leave this process). */
export function collectSensitiveValues(ctx: Pick<AppContext, 'secrets' | 'paths'>): SensitiveValues {
  const values: Array<[string, string]> = [];
  for (const k of SENSITIVE_ENV_KEYS) {
    const v = ctx.secrets.get(k);
    if (v && v.trim().length >= 6) values.push([k, v.trim()]);
  }
  const privatePaths = [ctx.paths.secretsDir, ctx.paths.googleDir, ctx.paths.dbFile, ctx.paths.dataDir].filter(Boolean);
  return { values, privatePaths };
}

/**
 * Scan an actor input for credentials: configured secret values (Google,
 * Gateway, DataForSEO, Apify, Qdrant, PageSpeed), credential-shaped strings
 * (bearer tokens, API keys, private keys, URL-embedded credentials), secret-
 * named fields, and private workspace/database paths. Findings name the field
 * path and the kind of secret, never the value.
 */
export function scanInputForSecrets(input: unknown, sensitive: SensitiveValues): string[] {
  const findings: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') {
      if (redactString(v) !== v) findings.push(`${path}: contains a credential-shaped value`);
      for (const [label, secret] of sensitive.values) if (v.includes(secret)) findings.push(`${path}: contains the configured ${label}`);
      for (const p of sensitive.privatePaths) if (p && v.includes(p)) findings.push(`${path}: references a private workspace path`);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        const childPath = path ? `${path}.${k}` : k;
        if ((isSecretKey(k) || SECRETISH_KEY_RE.test(k)) && !isEmptyValue(child)) findings.push(`${childPath}: secret-named field is set`);
        walk(child, childPath);
      }
    }
  };
  walk(input, '');
  return [...new Set(findings)];
}
