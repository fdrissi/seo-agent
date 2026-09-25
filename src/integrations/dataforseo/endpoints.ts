import { AppError, IntegrationDisabledError, PolicyDeniedError } from '../../core/errors.js';
import type { FeatureKey } from '../../config/site-schema.js';

/**
 * DataForSEO endpoint allowlist.
 *
 * Only endpoints listed here can be called. Every entry cites the primary
 * documentation verified in docs/integration-contracts.md section 6 (source
 * IDs DF1-DF42, retrieved 2026-09-24). Paths are relative to `/v3` and are
 * identical on the production and sandbox hosts (DF14).
 *
 * Backlinks, DataForSEO Labs, AI Optimization (LLM mentions/responses/scraper,
 * AI keyword data) and AI SERP families are DISABLED by default: they need the
 * matching feature flag AND an explicit approval bound to the exact request.
 */

export type EndpointFamily =
  | 'serp_google_organic'
  | 'serp_google_lookup'
  | 'keywords_google_ads_volume'
  | 'keywords_google_ads_lookup'
  | 'account'
  | 'backlinks'
  | 'labs'
  | 'ai_optimization';

export type QueueKind = 'standard' | 'live';

export interface EndpointSpec {
  /** Logical key. Equal to the path template relative to /v3. */
  key: string;
  method: 'GET' | 'POST';
  family: EndpointFamily;
  /** Chargeable request (POST task creation or live call). GET retrieval/lookups are free. */
  paid: boolean;
  queue: QueueKind | null;
  /** Documented maximum tasks per POST body (100 for task_post, 1 for live). */
  maxTasksPerPost?: number;
  /** Feature flag that must be on (gated families also need an approval). */
  gate?: FeatureKey;
  /** Documented per-minute call ceiling enforced client-side (in-process only). */
  rateLimitPerMinute?: number;
  /**
   * Row-priced (gated) endpoints: how billable rows are bounded so the charge
   * cannot exceed the reserved estimate.
   *  - 'limit_field': the task's `limit` field caps returned rows; when the
   *    caller omits it, `limit = maxRows` is sent (and approved).
   *  - 'single_row': one summary item per request; no `limit` is sent.
   */
  rowBound?: 'limit_field' | 'single_row';
  /** Contract source IDs from docs/integration-contracts.md. */
  verifiedBy: string[];
  note?: string;
}

const specs: EndpointSpec[] = [
  // Google organic SERP, standard queue (DF4-DF7)
  { key: 'serp/google/organic/task_post', method: 'POST', family: 'serp_google_organic', paid: true, queue: 'standard', maxTasksPerPost: 100, verifiedBy: ['DF4', 'DF30'] },
  { key: 'serp/google/organic/tasks_ready', method: 'GET', family: 'serp_google_organic', paid: false, queue: null, rateLimitPerMinute: 20, verifiedBy: ['DF5'] },
  { key: 'serp/google/organic/task_get/advanced/{id}', method: 'GET', family: 'serp_google_organic', paid: false, queue: null, verifiedBy: ['DF7'] },
  { key: 'serp/google/organic/task_get/regular/{id}', method: 'GET', family: 'serp_google_organic', paid: false, queue: null, verifiedBy: ['DF6'] },
  // Google organic SERP, live (only when config queue = 'live') (DF9)
  { key: 'serp/google/organic/live/advanced', method: 'POST', family: 'serp_google_organic', paid: true, queue: 'live', maxTasksPerPost: 1, verifiedBy: ['DF9', 'DF30'] },
  // SERP lookups (free) (DF11, DF12)
  { key: 'serp/google/locations', method: 'GET', family: 'serp_google_lookup', paid: false, queue: null, verifiedBy: ['DF11'] },
  { key: 'serp/google/locations/{country}', method: 'GET', family: 'serp_google_lookup', paid: false, queue: null, verifiedBy: ['DF11'] },
  { key: 'serp/google/languages', method: 'GET', family: 'serp_google_lookup', paid: false, queue: null, verifiedBy: ['DF12'] },
  // Google Ads search volume (DF16-DF20). No Google Ads account needed (DF36).
  { key: 'keywords_data/google_ads/search_volume/task_post', method: 'POST', family: 'keywords_google_ads_volume', paid: true, queue: 'standard', maxTasksPerPost: 100, verifiedBy: ['DF17', 'DF31'] },
  { key: 'keywords_data/google_ads/search_volume/tasks_ready', method: 'GET', family: 'keywords_google_ads_volume', paid: false, queue: null, rateLimitPerMinute: 20, verifiedBy: ['DF19', 'DF20'] },
  { key: 'keywords_data/google_ads/search_volume/task_get/{id}', method: 'GET', family: 'keywords_google_ads_volume', paid: false, queue: null, verifiedBy: ['DF19'] },
  { key: 'keywords_data/google_ads/search_volume/live', method: 'POST', family: 'keywords_google_ads_volume', paid: true, queue: 'live', maxTasksPerPost: 1, rateLimitPerMinute: 12, verifiedBy: ['DF18', 'DF31'] },
  // Keywords Data lookups (free) (DF21, DF22)
  { key: 'keywords_data/google_ads/locations', method: 'GET', family: 'keywords_google_ads_lookup', paid: false, queue: null, verifiedBy: ['DF21'] },
  { key: 'keywords_data/google_ads/locations/{country}', method: 'GET', family: 'keywords_google_ads_lookup', paid: false, queue: null, verifiedBy: ['DF21'] },
  { key: 'keywords_data/google_ads/languages', method: 'GET', family: 'keywords_google_ads_lookup', paid: false, queue: null, verifiedBy: ['DF22'] },
  // Account data (free) (DF15)
  { key: 'appendix/user_data', method: 'GET', family: 'account', paid: false, queue: null, verifiedBy: ['DF15'] },
  // Gated research endpoints: feature flag + approval (DF23-DF29, DF32, DF33)
  {
    key: 'backlinks/summary/live',
    method: 'POST',
    family: 'backlinks',
    paid: true,
    queue: 'live',
    maxTasksPerPost: 1,
    gate: 'dataforseoBacklinks',
    rowBound: 'single_row',
    verifiedBy: ['DF23', 'DF28', 'DF32'],
    note: 'Summary endpoint: one summary item per target (DF28); the estimate still assumes up to maxRows rows.',
  },
  {
    key: 'dataforseo_labs/google/ranked_keywords/live',
    method: 'POST',
    family: 'labs',
    paid: true,
    queue: 'live',
    maxTasksPerPost: 1,
    gate: 'dataforseoLabsExports',
    rowBound: 'limit_field',
    verifiedBy: ['DF24', 'DF29', 'DF33'],
    note: 'Priced per task + per item (DF33): the `limit` field (DF29) bounds billable items.',
  },
  {
    key: 'ai_optimization/llm_mentions/search_mentions/live',
    method: 'POST',
    family: 'ai_optimization',
    paid: true,
    queue: 'live',
    maxTasksPerPost: 1,
    gate: 'dataforseoAiVisibility',
    rowBound: 'limit_field',
    verifiedBy: ['DF25', 'DF26', 'DF27'],
    note: 'Pricing is UNVERIFIED (DF34 static figures are inconsistent); requests need an approval for an unknown price.',
  },
];

export const ENDPOINTS: ReadonlyMap<string, EndpointSpec> = new Map(specs.map((s) => [s.key, s]));

/** Path prefixes of families that are disabled by default, with the flag that unlocks them. */
export const GATED_PREFIXES: ReadonlyArray<{ prefix: string; family: EndpointFamily; gate: FeatureKey; label: string }> = [
  { prefix: 'backlinks/', family: 'backlinks', gate: 'dataforseoBacklinks', label: 'Backlinks API' },
  { prefix: 'dataforseo_labs/', family: 'labs', gate: 'dataforseoLabsExports', label: 'DataForSEO Labs API (large exports)' },
  { prefix: 'ai_optimization/', family: 'ai_optimization', gate: 'dataforseoAiVisibility', label: 'AI Optimization API (LLM mentions/responses/scraper, AI keyword data)' },
  { prefix: 'serp/google/ai_mode/', family: 'ai_optimization', gate: 'dataforseoAiVisibility', label: 'Google AI Mode SERP' },
  { prefix: 'serp/ai_summary', family: 'ai_optimization', gate: 'dataforseoAiVisibility', label: 'SERP AI summary' },
];

/** Standard-queue companions of a task_post endpoint. */
export const STANDARD_COMPANIONS: Readonly<Record<string, { tasksReady: string; taskGet: string }>> = {
  'serp/google/organic/task_post': { tasksReady: 'serp/google/organic/tasks_ready', taskGet: 'serp/google/organic/task_get/advanced/{id}' },
  'keywords_data/google_ads/search_volume/task_post': {
    tasksReady: 'keywords_data/google_ads/search_volume/tasks_ready',
    taskGet: 'keywords_data/google_ads/search_volume/task_get/{id}',
  },
};

function gatedFamilyFor(path: string): (typeof GATED_PREFIXES)[number] | undefined {
  const p = path.replace(/^\/+/, '').replace(/^v3\//, '');
  return GATED_PREFIXES.find((g) => p.startsWith(g.prefix));
}

/**
 * Look up an endpoint and enforce the allowlist and feature gates. Throws
 * POLICY_DENIED for anything not allowlisted and INTEGRATION_DISABLED when a
 * gated family's feature flag is off. The approval half of the gate is
 * enforced by `callGatedEndpoint` (gated.ts), never skipped.
 */
export function requireEndpoint(key: string, features: Readonly<Record<FeatureKey, boolean>>): EndpointSpec {
  const spec = ENDPOINTS.get(key);
  if (!spec) {
    const gated = gatedFamilyFor(key);
    if (gated) {
      if (!features[gated.gate]) {
        throw new IntegrationDisabledError('dataforseo', `${gated.label} is disabled by default; it needs features.${gated.gate} = true AND an approval (endpoint "${key}")`);
      }
      throw new PolicyDeniedError(`DataForSEO endpoint "${key}" is not on the allowlist (only selected ${gated.label} endpoints are implemented).`, { endpoint: key });
    }
    throw new PolicyDeniedError(`DataForSEO endpoint "${key}" is not on the allowlist.`, { endpoint: key, allowlist: [...ENDPOINTS.keys()] });
  }
  if (spec.gate && !features[spec.gate]) {
    throw new IntegrationDisabledError('dataforseo', `endpoint family "${spec.family}" is disabled by default; it needs features.${spec.gate} = true AND an approval (endpoint "${key}")`);
  }
  return spec;
}

const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const COUNTRY_RE = /^[a-z]{2}$/;

/** Fill a path template. Parameters are validated so they cannot alter the path. */
export function buildPath(spec: EndpointSpec, params: Readonly<Record<string, string>> = {}): string {
  return spec.key.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const value = params[name];
    if (value === undefined) throw new AppError('VALIDATION_FAILED', `Missing path parameter "${name}" for ${spec.key}`);
    if (name === 'id' && !ID_RE.test(value)) throw new AppError('VALIDATION_FAILED', `Invalid DataForSEO task id "${value}"`);
    if (name === 'country' && !COUNTRY_RE.test(value)) throw new AppError('VALIDATION_FAILED', `Invalid ISO country code "${value}" (use two lowercase letters)`);
    return encodeURIComponent(value);
  });
}
