import { AppError, errorMessage } from '../../core/errors.js';
import { parseRetryAfter } from '../../core/retry.js';
import { redactString } from '../../security/redact.js';
import type { FetchLike } from '../types.js';
import type { LlmFailureStatus } from './types.js';

/**
 * Transport helpers for the LLM Gateway (OpenAI-compatible, verified in
 * docs/integration-contracts.md §1): bearer auth, the error envelope
 * `{error:{message,type,param,code}}` (HTTP status authoritative), and the
 * billing interpretation of failures used for budget reconciliation.
 */

/**
 * Next step for an LLM Gateway charge whose amount is unknown (ambiguous
 * submission, 5xx/timeout after submission, unreadable response): the owner
 * checks the gateway usage log and settles the reservation with the audited
 * `costs reconcile` command (an explicit amount, or `--not-charged` only when
 * the log shows no charge). Never a blind resubmission.
 */
export function reconcileNextStep(reservationId?: string | null): string {
  const id = reservationId || '<reservation-id>';
  const settle = `\`npm run cli -- costs reconcile ${id} --actual-usd <amount from the usage log> --evidence "<what the usage log shows>" --by "<your name>"\` (or \`--not-charged\` instead of \`--actual-usd\` when the log shows no charge)`;
  return reservationId
    ? `Check the LLM Gateway usage log for this request, then settle reservation ${reservationId}: ${settle}. Not retried automatically; do not resubmit blindly.`
    : `Check the LLM Gateway usage log for this request, then settle the unresolved reservation (\`npm run cli -- costs --unresolved\` shows its id): ${settle}. Not retried automatically; do not resubmit blindly.`;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** True for loopback hosts (localhost, 127.0.0.0/8, ::1). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(h) || /^127(?:\.\d{1,3}){3}$/.test(h) || h.endsWith('.localhost');
}

export type BaseUrlCheck = { ok: true; url: string } | { ok: false; reason: string; nextStep: string };

/**
 * Check LLM_GATEWAY_BASE_URL before any request carries the API key: it must
 * be an https URL, or plain http only to a loopback host (a local proxy).
 * Credentials embedded in the URL are refused too. The URL itself contains
 * no secret, so it may be shown in messages.
 */
export function checkGatewayBaseUrl(base: string): BaseUrlCheck {
  const trimmed = String(base ?? '').trim().replace(/\/+$/, '');
  const nextStep = 'Set LLM_GATEWAY_BASE_URL to an https URL (default https://api.llmgateway.io/v1), or to http://127.0.0.1:<port>/... for a local proxy. The API key is sent as a Bearer token with every request and must never travel unencrypted over a network.';
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'LLM_GATEWAY_BASE_URL is not a valid URL; no request was sent.', nextStep };
  }
  if (u.username || u.password) return { ok: false, reason: 'LLM_GATEWAY_BASE_URL must not embed credentials; no request was sent.', nextStep: 'Remove the user:password part; the key belongs in LLM_GATEWAY_API_KEY (<workspace>/secrets/secrets.env).' };
  if (u.protocol === 'https:') return { ok: true, url: trimmed };
  if (u.protocol === 'http:') {
    if (isLoopbackHost(u.hostname)) return { ok: true, url: trimmed };
    return { ok: false, reason: `LLM_GATEWAY_BASE_URL uses plain http to a non-loopback host (${u.host}); the API key would be sent unencrypted, so no request was sent.`, nextStep };
  }
  return { ok: false, reason: `LLM_GATEWAY_BASE_URL must use https (got ${u.protocol.replace(/:$/, '')}); no request was sent.`, nextStep };
}

/**
 * Normalized base URL (trimmed, no trailing slash). Refuses (CONFIG_INVALID) a
 * non-https URL unless the host is loopback, so the Bearer key is never sent
 * in cleartext over a network. Use checkGatewayBaseUrl for a non-throwing check.
 */
export function normalizeBaseUrl(base: string): string {
  const c = checkGatewayBaseUrl(base);
  if (!c.ok) throw new AppError('CONFIG_INVALID', c.reason, { hint: c.nextStep });
  return c.url;
}

export function gatewayUrl(base: string, path: string): string {
  return `${normalizeBaseUrl(base)}/${path.replace(/^\/+/, '')}`;
}

export function authHeaders(apiKey: string | undefined, extra: Record<string, string> = {}): Record<string, string> {
  return {
    accept: 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...extra,
  };
}

export type TransportErrorKind =
  /** Client-side timeout fired after the request was handed to the network. */
  | 'timeout'
  /** Caller aborted after submission. */
  | 'aborted'
  /** The request definitely never reached the gateway (DNS/connection refused/offline/TLS). */
  | 'not_sent'
  /** Network failure with unknown delivery state. */
  | 'unknown';

export class TransportError extends Error {
  constructor(
    readonly kind: TransportErrorKind,
    message: string,
    readonly causeCode?: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

/** Errno/undici codes meaning the request never reached the server. */
const NOT_SENT_CODES = new Set([
  'OFFLINE',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_INVALID_URL',
  'UND_ERR_INVALID_ARG',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function errorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | undefined;
  if (typeof e?.code === 'string') return e.code;
  if (typeof e?.cause?.code === 'string') return e.cause.code;
  return undefined;
}

export function classifyTransportError(err: unknown, timedOut: boolean, callerAborted: boolean): TransportError {
  if (err instanceof TransportError) return err;
  const name = (err as { name?: string } | undefined)?.name;
  const code = errorCode(err);
  const msg = redactString(errorMessage(err));
  if (timedOut || name === 'TimeoutError' || code === 'TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return new TransportError('timeout', `request timed out (${msg})`, code);
  }
  if (callerAborted || name === 'AbortError') return new TransportError('aborted', `request aborted by caller (${msg})`, code);
  if (code && NOT_SENT_CODES.has(code)) return new TransportError('not_sent', `request not delivered (${code}: ${msg})`, code);
  return new TransportError('unknown', `network error with unknown delivery state (${msg})`, code);
}

export interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
}

/**
 * fetch + read the whole body under one timeout. A timeout during the body
 * read is still a timeout (delivery state ambiguous).
 */
export async function fetchWithTimeout(fetchFn: FetchLike, url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<HttpResult> {
  if (signal?.aborted) throw new TransportError('not_sent', 'request cancelled by caller before submission');
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(Object.assign(new Error(`timed out after ${timeoutMs}ms`), { name: 'TimeoutError' }));
  }, timeoutMs);
  const onAbort = () => {
    callerAborted = true;
    controller.abort(signal?.reason ?? new Error('aborted'));
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetchFn(url, { ...init, signal: controller.signal });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  } catch (err) {
    throw classifyTransportError(err, timedOut, callerAborted);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export interface GatewayErrorEnvelope {
  message: string | null;
  type: string | null;
  code: string | null;
}

export function parseErrorEnvelope(text: string): GatewayErrorEnvelope {
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown; type?: unknown; code?: unknown } | string; message?: unknown };
    if (body && typeof body.error === 'object' && body.error) {
      return {
        message: typeof body.error.message === 'string' ? redactString(body.error.message).slice(0, 500) : null,
        type: typeof body.error.type === 'string' ? body.error.type : null,
        code: typeof body.error.code === 'string' ? body.error.code : null,
      };
    }
    if (typeof body?.error === 'string') return { message: redactString(body.error).slice(0, 500), type: null, code: null };
    if (typeof body?.message === 'string') return { message: redactString(body.message).slice(0, 500), type: null, code: null };
  } catch {
    /* not JSON */
  }
  return { message: text ? redactString(text).slice(0, 300) : null, type: null, code: null };
}

export interface HttpFailureClass {
  status: LlmFailureStatus;
  /**
   * 'not_billed': the gateway rejected the request before inference (release the reservation).
   * 'ambiguous': the request may have been processed/billed (keep the reservation unresolved).
   */
  billing: 'not_billed' | 'ambiguous';
  reason: string;
  nextStep: string;
  retryAfterMs?: number;
}

/**
 * Map a gateway HTTP failure to an honest status. Automatic retries are never
 * performed for chat/embedding POSTs; the next step tells the owner what to do.
 */
export function classifyHttpFailure(httpStatus: number, env: GatewayErrorEnvelope, headers?: Headers, endpoint = 'chat/completions'): HttpFailureClass {
  const msg = env.message ?? '';
  const detail = `${endpoint} HTTP ${httpStatus}${env.type ? ` ${env.type}` : ''}${env.code ? `/${env.code}` : ''}${msg ? `: ${msg}` : ''}`;
  const retryAfterMs = parseRetryAfter(headers?.get('retry-after') ?? null);
  const withRetry = retryAfterMs !== undefined ? { retryAfterMs } : {};
  switch (true) {
    case httpStatus === 400: {
      if (/json schema|json_schema|structured output|response_format/i.test(msg) || env.code === 'model_not_supported' || env.code === 'unsupported_parameter_combination') {
        return { status: 'unsupported', billing: 'not_billed', reason: detail, nextStep: 'The model rejected a parameter. Run `models list` to refresh capabilities (the catalog may have changed) or choose a model that supports this request.' };
      }
      if (env.code === 'model_not_found') return { status: 'invalid_model', billing: 'not_billed', reason: detail, nextStep: 'Run `models list` and set the configured model to an id the gateway lists. No substitute is chosen automatically.' };
      return { status: 'provider_error', billing: 'not_billed', reason: detail, nextStep: 'The gateway rejected the request as invalid. Inspect the request parameters in llm_calls.params_json; not retried.' };
    }
    case httpStatus === 401:
      if (/usage limit/i.test(msg)) {
        return { status: 'budget_exceeded', billing: 'not_billed', reason: `LLM Gateway key reached its usage limit (${detail})`, nextStep: 'The key-level spend limit in the LLM Gateway dashboard was reached. No automatic increase is performed; raise it only if you intend to spend more.' };
      }
      return { status: 'not_configured', billing: 'not_billed', reason: `LLM Gateway rejected the API key (${detail})`, nextStep: 'Check LLM_GATEWAY_API_KEY in <workspace>/secrets/secrets.env (or your password-manager environment). Never paste keys into chat.' };
    case httpStatus === 402:
      return { status: 'budget_exceeded', billing: 'not_billed', reason: `LLM Gateway credits exhausted (${detail})`, nextStep: 'Top up credits in the LLM Gateway dashboard only if you intend to spend more. No automatic top-ups are performed.' };
    case httpStatus === 403:
      return { status: 'provider_error', billing: 'not_billed', reason: `permission denied by gateway IAM/compliance/plan (${detail})`, nextStep: 'Check the key/project IAM rules and plan in the LLM Gateway dashboard (embeddings return 403 on Dev plans).' };
    case httpStatus === 404:
      return env.code === 'model_not_found' || /model/i.test(msg)
        ? { status: 'invalid_model', billing: 'not_billed', reason: detail, nextStep: 'Run `models list` and set the configured model to an id the gateway lists. No substitute is chosen automatically.' }
        : { status: 'provider_error', billing: 'not_billed', reason: detail, nextStep: 'Check LLM_GATEWAY_BASE_URL (default https://api.llmgateway.io/v1).' };
    case httpStatus === 410:
      return { status: 'provider_error', billing: 'not_billed', reason: `project archived or organization blocked (${detail})`, nextStep: 'Check the project status in the LLM Gateway dashboard; keys of archived projects are inactive.' };
    case httpStatus === 413:
      return { status: 'unsupported', billing: 'not_billed', reason: `request too large (${detail})`, nextStep: 'Lower llm.maxInputTokens in the site config or send less evidence.' };
    case httpStatus === 429:
      return { status: 'provider_error', billing: 'not_billed', reason: `rate limited or gateway spend cap reached (${detail})`, nextStep: `Wait ${retryAfterMs !== undefined ? `${Math.ceil(retryAfterMs / 1000)}s (Retry-After)` : 'before retrying'}; a daily/monthly spend cap will not clear quickly. Not retried automatically.`, ...withRetry };
    case httpStatus === 529:
      return { status: 'provider_error', billing: 'not_billed', reason: `gateway overloaded (${detail})`, nextStep: 'Retry later; not retried automatically.', ...withRetry };
    case httpStatus === 408 || httpStatus === 499 || httpStatus === 504:
      return {
        status: 'provider_error',
        billing: 'ambiguous',
        reason: `gateway/upstream timeout (${detail}); the upstream provider may have processed and billed the request`,
        nextStep: reconcileNextStep(),
      };
    default:
      return {
        status: 'provider_error',
        billing: httpStatus >= 500 ? 'ambiguous' : 'not_billed',
        reason: detail,
        nextStep:
          httpStatus >= 500
            ? `Upstream/gateway error; billing state is not guaranteed. ${reconcileNextStep()}`
            : 'Unexpected gateway response; not retried.',
      };
  }
}
