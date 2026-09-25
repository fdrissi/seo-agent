import { AppError, type ErrorCode } from '../../core/errors.js';
import { parseRetryAfter } from '../../core/retry.js';
import { redactString } from '../../security/redact.js';

/**
 * Google API error parsing and classification.
 *
 * Search Console documents the legacy shape
 *   { error: { errors: [{ domain, reason, message }], code, message } }
 * and GA4 documents the google.rpc shape
 *   { error: { code, message, status, details? } }.
 * Which shape each host returns on the wire is unverified
 * (docs/integration-contracts.md sections 2 and 3), so both are accepted.
 */

export type GoogleErrorKind =
  | 'api_not_enabled' // 403 accessNotConfigured / SERVICE_DISABLED
  | 'permission_denied' // 403 no access to the property
  | 'insufficient_scopes' // 403 token lacks a required scope
  | 'unauthenticated' // 401
  | 'invalid_grant' // refresh token expired/revoked: re-consent required
  | 'credentials' // local credentials missing (no ADC, no key file, no token): never retried
  | 'config' // local credential/configuration problem (unusable key, wrong credential type): never retried
  | 'rate_limited' // short-term limit (per-minute/per-second, concurrency): a short backoff can help
  | 'quota_exhausted' // load, hourly, or daily quota: NOT retried within the run
  | 'invalid_argument' // 400 (bad request, incompatible metrics, unknown property format)
  | 'not_found' // 404
  | 'server_error' // 5xx
  | 'network' // transport failure: the request never produced an HTTP response
  | 'offline' // network access forbidden in this run
  | 'unknown';

export type GoogleApiName = 'gsc' | 'ga4' | 'url_inspection' | 'oauth' | 'auth';

export interface ParsedGoogleError {
  status: number;
  message: string;
  /** Legacy `errors[].reason` values plus google.rpc ErrorInfo reasons. */
  reasons: string[];
  /** google.rpc status such as PERMISSION_DENIED (when present). */
  rpcStatus: string | null;
  /** Activation URL for a disabled API, when Google reports one. */
  activationUrl: string | null;
}

const RATE_REASONS = new Set(['ratelimitexceeded', 'userratelimitexceeded', 'quotaexceeded', 'dailylimitexceeded', 'resource_exhausted', 'rate_limit_exceeded']);
const SHORT_TERM_REASONS = new Set(['ratelimitexceeded', 'userratelimitexceeded', 'rate_limit_exceeded']);
const LONG_TERM_REASONS = new Set(['quotaexceeded', 'dailylimitexceeded']);

export function parseGoogleErrorBody(status: number, body: unknown): ParsedGoogleError {
  const out: ParsedGoogleError = { status, message: `HTTP ${status}`, reasons: [], rpcStatus: null, activationUrl: null };
  if (!body || typeof body !== 'object') {
    if (typeof body === 'string' && body.trim()) out.message = body.trim().slice(0, 500);
    return out;
  }
  const b = body as Record<string, unknown>;
  // OAuth token endpoint errors: { error: 'invalid_grant', error_description }
  if (typeof b.error === 'string') {
    out.reasons.push(b.error);
    out.message = typeof b.error_description === 'string' ? `${b.error}: ${b.error_description}` : b.error;
    return out;
  }
  const e = b.error as Record<string, unknown> | undefined;
  if (!e || typeof e !== 'object') return out;
  if (typeof e.message === 'string') out.message = e.message;
  if (typeof e.status === 'string') out.rpcStatus = e.status;
  if (Array.isArray(e.errors)) {
    for (const item of e.errors) {
      const reason = (item as { reason?: unknown })?.reason;
      if (typeof reason === 'string') out.reasons.push(reason);
    }
  }
  if (Array.isArray(e.details)) {
    for (const d of e.details) {
      const detail = d as { reason?: unknown; metadata?: Record<string, unknown>; links?: Array<{ url?: unknown }> };
      if (typeof detail?.reason === 'string') out.reasons.push(detail.reason);
      const act = detail?.metadata?.activationUrl;
      if (typeof act === 'string') out.activationUrl = act;
      if (!out.activationUrl && Array.isArray(detail?.links)) {
        const link = detail.links.find((l) => typeof l?.url === 'string' && /console\.(developers|cloud)\.google\.com\/apis/.test(String(l.url)));
        if (link) out.activationUrl = String(link.url);
      }
    }
  }
  return out;
}

/**
 * Split quota errors into short-term limits (retried with a short backoff) and
 * exhausted quotas (never retried within a run: they need minutes to a day).
 *  - Search Console: a Search Analytics "quota exceeded" (load quota) needs a
 *    wait of at least 15 minutes; quotaExceeded / dailyLimitExceeded likewise.
 *    rateLimitExceeded / userRateLimitExceeded are per-minute limits.
 *  - GA4: 429 RESOURCE_EXHAUSTED means back off until the hourly or daily
 *    token reset; only the concurrent-requests limit is short-term.
 * docs/integration-contracts.md sections 2 and 3. The exact status/reason of
 * the load-quota error is unverified, so the message is also matched.
 */
function rateLimitKind(p: ParsedGoogleError, reasons: string[], msg: string, api?: GoogleApiName): 'rate_limited' | 'quota_exhausted' | null {
  const exhausted = p.status === 429 || p.rpcStatus === 'RESOURCE_EXHAUSTED';
  const quota403 = p.status === 403 && (reasons.some((r) => RATE_REASONS.has(r)) || /quota exceeded|rate limit/.test(msg));
  if (!exhausted && !quota403) return null;
  if (/per ?(minute|second|100 seconds)|concurrent/.test(msg)) return 'rate_limited';
  if (reasons.some((r) => LONG_TERM_REASONS.has(r)) || /quota exceeded|per ?day|daily|per ?hour|hourly|tokens/.test(msg)) return 'quota_exhausted';
  if (reasons.some((r) => SHORT_TERM_REASONS.has(r))) return 'rate_limited';
  if (api === 'ga4') return 'quota_exhausted';
  return 'rate_limited';
}

export function classifyGoogleError(p: ParsedGoogleError, api?: GoogleApiName): GoogleErrorKind {
  const reasons = p.reasons.map((r) => r.toLowerCase());
  const msg = p.message.toLowerCase();
  if (reasons.includes('invalid_grant') || /\binvalid_grant\b/.test(msg)) return 'invalid_grant';
  const rate = rateLimitKind(p, reasons, msg, api);
  if (rate) return rate;
  if (
    reasons.includes('accessnotconfigured') ||
    reasons.includes('service_disabled') ||
    /has not been used in project|it is disabled|api has not been enabled|service_disabled/.test(msg)
  ) {
    return 'api_not_enabled';
  }
  if (reasons.includes('access_token_scope_insufficient') || /insufficient authentication scopes|insufficient scope/.test(msg)) return 'insufficient_scopes';
  if (p.status === 401 || p.rpcStatus === 'UNAUTHENTICATED') return 'unauthenticated';
  if (p.status === 403 || p.rpcStatus === 'PERMISSION_DENIED') return 'permission_denied';
  if (p.status === 404 || p.rpcStatus === 'NOT_FOUND') return 'not_found';
  if (p.status === 400 || p.rpcStatus === 'INVALID_ARGUMENT' || p.rpcStatus === 'FAILED_PRECONDITION') return 'invalid_argument';
  if (p.status >= 500) return 'server_error';
  return 'unknown';
}

const KIND_CODE: Record<GoogleErrorKind, ErrorCode> = {
  api_not_enabled: 'PERMISSION_DENIED',
  permission_denied: 'PERMISSION_DENIED',
  insufficient_scopes: 'PERMISSION_DENIED',
  unauthenticated: 'CREDENTIALS_MISSING',
  invalid_grant: 'CREDENTIALS_MISSING',
  credentials: 'CREDENTIALS_MISSING',
  config: 'CONFIG_INVALID',
  rate_limited: 'RATE_LIMITED',
  quota_exhausted: 'RATE_LIMITED',
  invalid_argument: 'VALIDATION_FAILED',
  not_found: 'NOT_FOUND',
  server_error: 'PROVIDER_ERROR',
  network: 'INTEGRATION_UNAVAILABLE',
  // Nothing was sent (network disabled for this run): not a provider-health failure, so it never
  // opens the circuit breaker (countsAsProviderFailure) and is never retried within the run.
  offline: 'OFFLINE',
  unknown: 'PROVIDER_ERROR',
};

const API_LABEL: Record<GoogleApiName, string> = {
  gsc: 'Google Search Console API',
  url_inspection: 'Google Search Console API (URL Inspection)',
  ga4: 'Google Analytics Data API',
  oauth: 'Google OAuth',
  auth: 'Google authorization',
};

/**
 * Google credential mode the error happened under. Service accounts have no
 * refresh token, consent screen, or Testing publishing status, so their
 * credential errors get service-account guidance instead of OAuth guidance.
 */
export type GoogleAuthModeHint = 'oauth' | 'service_account' | 'fixture';

/** Where a service account's keys and status are managed (for hints). */
export const SERVICE_ACCOUNT_KEYS_PATH = 'Google Cloud console > IAM & Admin > Service accounts > (the account) > Keys';

/** Service-account guidance for credential errors, or null when the generic hint applies. */
function serviceAccountHint(kind: GoogleErrorKind): string | null {
  switch (kind) {
    case 'invalid_grant':
      return `Google rejected the service-account token request (invalid_grant). Common causes: the key was disabled or deleted, the service account was disabled or deleted, the system clock is wrong (signed token requests carry timestamps; sync the clock), or the workload identity configuration is stale. Check ${SERVICE_ACCOUNT_KEYS_PATH}, create a new key (or regenerate the workload identity configuration), point GOOGLE_APPLICATION_CREDENTIALS at it (mode 0600), then run \`npm run cli -- auth diagnose\`.`;
    case 'unauthenticated':
      return `Google rejected the service-account credentials. Check that the service account and its key are enabled (${SERVICE_ACCOUNT_KEYS_PATH}) and that GOOGLE_APPLICATION_CREDENTIALS points at the current key or workload identity configuration, then run \`npm run cli -- auth diagnose\`.`;
    case 'insufficient_scopes':
      return 'The service-account token lacks a required read-only scope. The application requests both read-only scopes itself; if you use workload identity federation or impersonation, check that the configuration does not restrict scopes, then run `npm run cli -- auth diagnose`.';
    default:
      return null;
  }
}

export function hintForKind(kind: GoogleErrorKind, api: GoogleApiName, activationUrl?: string | null, authMode?: GoogleAuthModeHint): string {
  if (authMode === 'service_account') {
    const sa = serviceAccountHint(kind);
    if (sa) return sa;
  }
  switch (kind) {
    case 'api_not_enabled':
      return `Enable the ${API_LABEL[api]} in the Google Cloud project that owns your OAuth client or service account (Google Cloud console > APIs & Services > Library)${activationUrl ? ` (${activationUrl})` : ''}, wait a few minutes, then retry.`;
    case 'permission_denied':
      return api === 'ga4'
        ? 'Grant the authorized Google account (or the service-account email) the Viewer role on this GA4 property: GA4 Admin > Access Management. Do not grant Administrator or Editor for read-only reporting. Also check the property ID is the numeric GA4 property ID.'
        : 'Grant the authorized Google account (or the service-account email) access to this exact Search Console property: Settings > Users and permissions (Restricted or Full user). Owner is not required. Run `npm run cli -- auth status` to list the properties you can access.';
    case 'insufficient_scopes':
      return 'The stored authorization lacks a required read-only scope. Re-run `npm run cli -- auth google` and keep both read-only permissions checked on the consent screen.';
    case 'unauthenticated':
      return 'Google rejected the credentials. Run `npm run cli -- auth diagnose`, then `npm run cli -- auth google` (OAuth) or check GOOGLE_APPLICATION_CREDENTIALS (service account).';
    case 'invalid_grant':
      return 'The Google authorization expired or was revoked (invalid_grant). If your OAuth app is External with publishing status "Testing", refresh tokens expire 7 days after consent. Re-run `npm run cli -- auth google`; for long-lived access publish the app to "In production", use an Internal app, or use a service account.';
    case 'credentials':
      return 'Google credentials are missing. OAuth: run `npm run cli -- auth google`. Service account: set GOOGLE_APPLICATION_CREDENTIALS to a key or workload identity config (mode 0600), or run on a host with an attached service account. Then run `npm run cli -- auth status`.';
    case 'config':
      return 'The Google credential could not be used (for example an unreadable or altered private key, or the wrong credential type for GOOGLE_AUTH_MODE). Run `npm run cli -- auth diagnose` and re-download the credential file.';
    case 'rate_limited':
      return 'A short-term Google rate limit (per-minute or concurrent requests) was hit; requests were retried with backoff. If it persists, retry the sync in a few minutes; stored data is kept.';
    case 'quota_exhausted':
      return api === 'ga4'
        ? 'GA4 quota exhausted (429 RESOURCE_EXHAUSTED). Hourly quotas refresh within an hour and daily quotas at midnight Pacific time. It was not retried within this run; retry later and the sync resumes from stored data.'
        : 'Search Console quota or load limit reached ("quota exceeded"). It was not retried within this run. Wait at least 15 minutes before retrying; if it recurs immediately, the daily load quota is exhausted, so retry tomorrow.';
    case 'invalid_argument':
      return 'Google rejected the request as invalid. Check the configured property format and the requested dimensions/metrics (run `npm run cli -- auth diagnose`).';
    case 'not_found':
      return api === 'ga4'
        ? 'GA4 property not found. Use the numeric GA4 property ID (GA4 Admin > Property details), not a measurement ID (G-...) or a Universal Analytics ID (UA-...).'
        : 'Resource not found. Check the exact Search Console property string reported by `npm run cli -- auth status`.';
    case 'server_error':
      return 'Google returned a server error. The request was retried with backoff; retry the sync later.';
    case 'network':
      return 'Could not reach Google. Check network connectivity and retry.';
    case 'offline':
      return 'Network access is disabled for this run (offline or demo mode). Run without --offline to contact Google.';
    default:
      return 'Run `npm run cli -- auth diagnose` for permission diagnostics.';
  }
}

export class GoogleApiError extends AppError {
  readonly status: number;
  readonly kind: GoogleErrorKind;
  readonly reasons: string[];
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly api: GoogleApiName;

  constructor(input: {
    api: GoogleApiName;
    status: number;
    kind: GoogleErrorKind;
    message: string;
    reasons?: string[];
    retryAfterMs?: number;
    activationUrl?: string | null;
    cause?: unknown;
    /** Keep the original error code (e.g. CREDENTIALS_MISSING from a provider) instead of the kind's default. */
    code?: ErrorCode;
    /** Keep a more specific hint written by the credential provider. */
    hint?: string;
    extraDetails?: Record<string, unknown>;
    /** Credential mode in use, so credential errors get mode-specific guidance (see hintForKind). */
    authMode?: GoogleAuthModeHint;
  }) {
    const label = input.kind === 'credentials' || input.kind === 'config' ? API_LABEL.auth : API_LABEL[input.api];
    super(input.code ?? KIND_CODE[input.kind], `${label}: ${redactString(input.message)}`, {
      details: { api: input.api, status: input.status, kind: input.kind, reasons: input.reasons ?? [], ...(input.authMode ? { authMode: input.authMode } : {}), ...(input.extraDetails ?? {}) },
      hint: input.hint ?? hintForKind(input.kind, input.api, input.activationUrl, input.authMode),
      ...(input.cause !== undefined ? { cause: input.cause } : {}),
    });
    this.name = 'GoogleApiError';
    this.status = input.status;
    this.kind = input.kind;
    this.reasons = input.reasons ?? [];
    this.retryable = input.kind === 'rate_limited' || input.kind === 'server_error' || input.kind === 'network';
    this.retryAfterMs = input.retryAfterMs;
    this.api = input.api;
  }
}

export interface GoogleErrorOptions {
  /** Credential mode in use (service accounts get service-account guidance for credential errors). */
  authMode?: GoogleAuthModeHint;
}

export function googleErrorFromResponse(api: GoogleApiName, status: number, body: unknown, headers?: Headers | Record<string, string>, opts: GoogleErrorOptions = {}): GoogleApiError {
  const parsed = parseGoogleErrorBody(status, body);
  const retryAfterRaw = headers instanceof Headers ? headers.get('retry-after') : headers?.['retry-after'];
  const retryAfterMs = parseRetryAfter(retryAfterRaw ?? undefined);
  return new GoogleApiError({
    api,
    status,
    kind: classifyGoogleError(parsed, api),
    message: parsed.message,
    reasons: parsed.reasons,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    activationUrl: parsed.activationUrl,
    ...(opts.authMode ? { authMode: opts.authMode } : {}),
  });
}

/**
 * Re-issue a credential error with guidance for the credential mode in use.
 * Only errors that still carry the generic hint of their kind are changed (a
 * specific hint written by a provider is kept); other errors are returned as is.
 */
export function withAuthModeHint(err: GoogleApiError, authMode: GoogleAuthModeHint | undefined): GoogleApiError {
  if (authMode !== 'service_account' || !serviceAccountHint(err.kind) || err.hint !== hintForKind(err.kind, err.api)) return err;
  const original = err.details ?? {};
  const { api: _api, status: _status, kind: _kind, reasons: _reasons, ...extraDetails } = original as Record<string, unknown>;
  const prefix = `${err.kind === 'credentials' || err.kind === 'config' ? API_LABEL.auth : API_LABEL[err.api]}: `;
  return new GoogleApiError({
    api: err.api,
    status: err.status,
    kind: err.kind,
    message: err.message.startsWith(prefix) ? err.message.slice(prefix.length) : err.message,
    reasons: err.reasons,
    ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
    code: err.code,
    extraDetails,
    authMode,
    cause: err.cause ?? err,
  });
}

const TRANSPORT_CODE_RE = /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|ENETUNREACH|ENETDOWN|EHOSTUNREACH|EHOSTDOWN|ESOCKETTIMEDOUT|UND_ERR_[A-Z_]+|ERR_SOCKET_[A-Z_]+|TimeoutError)$/;
const TRANSPORT_MESSAGE_RE = /\b(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b|socket hang up|fetch failed|network error|other side closed/i;
const KEY_CODE_RE = /^ERR_(OSSL|CRYPTO)_/;
const KEY_MESSAGE_RE = /DECODER routines|PEM routines|asn1|bad base64|unsupported key|invalid key|No key or keyFile set|private[_ ]key/i;

function causeChain(err: unknown): Array<{ name?: unknown; code?: unknown; message?: unknown }> {
  const out: Array<{ name?: unknown; code?: unknown; message?: unknown }> = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur && typeof cur === 'object'; i++) {
    out.push(cur as { name?: unknown; code?: unknown; message?: unknown });
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

/** A real transport failure: fetch TypeError, timeout, or a socket/DNS error code anywhere in the cause chain. */
export function isTransportError(err: unknown): boolean {
  return causeChain(err).some((e) => {
    if (e.name === 'TimeoutError') return true;
    if (typeof e.code === 'string' && TRANSPORT_CODE_RE.test(e.code)) return true;
    const message = typeof e.message === 'string' ? e.message : '';
    if (e instanceof TypeError && /fetch failed|network|terminated|socket/i.test(message)) return true;
    return TRANSPORT_MESSAGE_RE.test(message);
  });
}

function isKeyError(err: unknown): boolean {
  return causeChain(err).some((e) => (typeof e.code === 'string' && KEY_CODE_RE.test(e.code)) || (typeof e.message === 'string' && KEY_MESSAGE_RE.test(e.message)));
}

function kindForAppError(err: AppError): GoogleErrorKind {
  switch (err.code) {
    case 'CREDENTIALS_MISSING':
      return 'credentials';
    case 'CONFIG_INVALID':
    case 'CONFIG_MISSING':
    case 'UNSAFE_PATH':
    case 'WORKSPACE_UNSAFE':
      return 'config';
    case 'PERMISSION_DENIED':
      return 'permission_denied';
    case 'RATE_LIMITED':
      return 'rate_limited';
    default:
      return 'unknown';
  }
}

/**
 * Map errors thrown by google-auth-library (GaxiosError from token refresh,
 * JWT signing, ADC discovery), by a credential provider (AppError), or by
 * fetch into a GoogleApiError. Only real transport failures become the
 * retryable 'network' kind; credential and configuration problems keep their
 * code and hint and are never retried.
 */
export function googleErrorFromUnknown(api: GoogleApiName, err: unknown, opts: GoogleErrorOptions = {}): GoogleApiError {
  const g = googleErrorFromUnknownBase(api, err);
  return opts.authMode ? withAuthModeHint(g, opts.authMode) : g;
}

function googleErrorFromUnknownBase(api: GoogleApiName, err: unknown): GoogleApiError {
  if (err instanceof GoogleApiError) return err;
  if (err instanceof AppError) {
    return new GoogleApiError({ api, status: 0, kind: kindForAppError(err), message: err.message, code: err.code, ...(err.hint ? { hint: err.hint } : {}), ...(err.details ? { extraDetails: { original: err.details } } : {}), cause: err });
  }
  const e = err as { code?: unknown; status?: unknown; message?: unknown; response?: { status?: number; data?: unknown; headers?: unknown } } | undefined;
  if (e?.code === 'OFFLINE') return new GoogleApiError({ api, status: 0, kind: 'offline', message: String(e.message ?? 'offline'), cause: err });
  const resp = e?.response;
  if (resp && typeof resp.status === 'number') {
    const parsed = parseGoogleErrorBody(resp.status, resp.data);
    const kind = classifyGoogleError(parsed, api);
    return new GoogleApiError({ api, status: resp.status, kind, message: parsed.message, reasons: parsed.reasons, activationUrl: parsed.activationUrl, cause: err });
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/invalid_grant/i.test(message)) return new GoogleApiError({ api, status: 400, kind: 'invalid_grant', message, reasons: ['invalid_grant'], cause: err });
  if (/network access is disabled/i.test(message)) return new GoogleApiError({ api, status: 0, kind: 'offline', message, cause: err });
  if (/Could not load the default credentials/i.test(message)) return new GoogleApiError({ api, status: 0, kind: 'credentials', message, cause: err });
  if (isKeyError(err)) {
    return new GoogleApiError({
      api,
      status: 0,
      kind: 'config',
      message: `The credential's private key could not be used to sign the token request (${message})`,
      hint: 'The service-account key file looks damaged or is not a PEM private key. Download a new key (or use workload identity federation), point GOOGLE_APPLICATION_CREDENTIALS at it (mode 0600), then run `npm run cli -- auth diagnose`.',
      cause: err,
    });
  }
  if (isTransportError(err)) return new GoogleApiError({ api, status: 0, kind: 'network', message, cause: err });
  return new GoogleApiError({ api, status: 0, kind: 'unknown', message, cause: err });
}

/** Errors after which a sync stops early with a partial status (quota or rate limit that outlived the retries). */
export function isQuotaStop(err: unknown): err is GoogleApiError {
  return err instanceof GoogleApiError && (err.kind === 'rate_limited' || err.kind === 'quota_exhausted');
}
