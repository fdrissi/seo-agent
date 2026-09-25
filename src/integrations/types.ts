/**
 * Shared integration contracts. Every provider sits behind a documented
 * adapter; optional integrations must fail or stay disabled without breaking
 * unrelated workflows, and must report an honest status.
 */

export type IntegrationId =
  | 'google_auth'
  | 'google_gsc'
  | 'google_ga4'
  | 'google_url_inspection'
  | 'llm_gateway'
  | 'dataforseo'
  | 'apify'
  | 'qdrant'
  | 'pagespeed'
  | 'crux'
  | 'playwright'
  | 'crawler'
  | 'obsidian';

export type IntegrationState =
  | 'ready' // configured and (if checked) reachable
  | 'configured_unverified' // credentials present, no network check performed
  | 'disabled' // feature flag off or profile excludes it
  | 'missing_credentials'
  | 'misconfigured'
  | 'degraded' // partially working (e.g. Qdrant down, full-text fallback in use)
  | 'unreachable'
  | 'permission_denied'
  | 'unresolved' // configuration exists but could not be verified (e.g. imported, unverified schema)
  | 'fixture'; // demo/test fixtures, never live data

export interface IntegrationStatus {
  id: IntegrationId;
  state: IntegrationState;
  detail: string;
  /** Exact next step for the owner, when action is needed. */
  nextStep?: string;
  /** What data this integration sends to an external service when enabled. */
  sendsExternally: string[];
  checkedAt: string;
  /** Whether a network request was made to produce this status. */
  networkChecked: boolean;
  /** Whether the check could have incurred a charge (doctor never does this without an explicit flag). */
  chargeable: boolean;
}

/** Minimal fetch signature so adapters can be tested with fakes and demo mode can forbid network access. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** A fetch that always refuses: used in demo/offline mode so fixtures can never silently hit the network. */
export const offlineFetch: FetchLike = async (input) => {
  throw Object.assign(new Error(`Network access is disabled in offline/demo mode (attempted ${String(input).replace(/\?.*$/, '')})`), { code: 'OFFLINE' });
};

export interface StatusCheckOptions {
  /** Allow a free, read-only network check. Never a chargeable call. */
  network: boolean;
}

export interface StatusReporter {
  status(opts: StatusCheckOptions): Promise<IntegrationStatus>;
}
