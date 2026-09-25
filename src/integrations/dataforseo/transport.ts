import { AppError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import { redactString } from '../../security/redact.js';
import type { FetchLike } from '../types.js';
import { buildPath, type EndpointSpec } from './endpoints.js';
import { DataForSeoApiError, parseEnvelope, type DfsEnvelope } from './envelope.js';

/**
 * Low-level HTTP transport. INTERNAL: callers use the client (free GETs) or
 * the task lifecycle in tasks.ts (paid POSTs with budget reservation).
 *
 * Every call returns a classified outcome instead of throwing, so the paid
 * lifecycle can distinguish:
 *   ok         HTTP 200 and response-level status 20000
 *   rejected   the provider definitely did not accept the request
 *              (HTTP 401/402/404, or a response-level 4xxxx error in HTTP 200)
 *   not_sent   the request never left this process (offline, DNS, refused)
 *   ambiguous  the request may have been accepted (timeout, network error
 *              after sending, 5xx, unparseable body, response-level 5xxxx on a POST)
 */

export type TransportOutcome<R = unknown> =
  | { kind: 'ok'; httpStatus: number; envelope: DfsEnvelope<R>; headers: Record<string, string> }
  | { kind: 'rejected'; httpStatus: number; envelope: DfsEnvelope | null; error: DataForSeoApiError }
  | { kind: 'not_sent'; error: AppError }
  | { kind: 'ambiguous'; httpStatus: number | null; envelope: DfsEnvelope | null; error: AppError };

export interface TransportConfig {
  baseUrl: string;
  /** `Basic <base64>` or null (fixture mode). Never logged. */
  authHeader: string | null;
  fetch: FetchLike;
  timeoutMs: number;
  liveTimeoutMs: number;
  logger: Logger;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const NOT_SENT_CODES = new Set(['OFFLINE', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL', 'UND_ERR_INVALID_ARG']);

function errorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  if (e && typeof e.code === 'string') return e.code;
  if (e && e.cause && typeof e.cause.code === 'string') return e.cause.code;
  return undefined;
}

export function definitelyNotSent(err: unknown): boolean {
  const code = errorCode(err);
  return code !== undefined && NOT_SENT_CODES.has(code);
}

/** In-process sliding window for documented per-minute ceilings (tasks_ready 20/min, Google Ads live 12/min). */
class RateWindow {
  private readonly hits = new Map<string, number[]>();
  async take(key: string, perMinute: number, now: () => number, sleep: (ms: number) => Promise<void>): Promise<void> {
    for (let guard = 0; guard < 1000; guard++) {
      const t = now();
      const list = (this.hits.get(key) ?? []).filter((x) => t - x < 60_000);
      if (list.length < perMinute) {
        list.push(t);
        this.hits.set(key, list);
        return;
      }
      this.hits.set(key, list);
      await sleep(Math.max(1, 60_000 - (t - list[0]!)));
    }
  }
}

export class DataForSeoTransport {
  private readonly window = new RateWindow();

  constructor(private readonly cfg: TransportConfig) {}

  get baseUrl(): string {
    return this.cfg.baseUrl;
  }

  async request<R = unknown>(spec: EndpointSpec, args: { pathParams?: Record<string, string>; body?: unknown[]; timeoutMs?: number } = {}): Promise<TransportOutcome<R>> {
    const path = buildPath(spec, args.pathParams);
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/${path}`;
    if (spec.rateLimitPerMinute) await this.window.take(spec.key, spec.rateLimitPerMinute, this.cfg.now, this.cfg.sleep);

    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.cfg.authHeader) headers.authorization = this.cfg.authHeader;
    let body: string | undefined;
    if (spec.method === 'POST') {
      if (!Array.isArray(args.body) || args.body.length === 0) throw new AppError('VALIDATION_FAILED', `${spec.key}: POST body must be a non-empty array of tasks`);
      if (spec.maxTasksPerPost && args.body.length > spec.maxTasksPerPost) {
        throw new AppError('VALIDATION_FAILED', `${spec.key}: at most ${spec.maxTasksPerPost} task(s) per POST (got ${args.body.length})`);
      }
      headers['content-type'] = 'application/json';
      body = JSON.stringify(args.body);
    }

    const timeoutMs = args.timeoutMs ?? (spec.queue === 'live' ? this.cfg.liveTimeoutMs : this.cfg.timeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(Object.assign(new Error(`DataForSEO ${spec.key} timed out after ${timeoutMs}ms`), { code: 'TIMEOUT', name: 'TimeoutError' })), timeoutMs);
    const started = this.cfg.now();
    let res: Response;
    let text: string;
    try {
      res = await this.cfg.fetch(url, { method: spec.method, headers, ...(body !== undefined ? { body } : {}), signal: controller.signal });
      text = await res.text();
    } catch (err) {
      clearTimeout(timer);
      const message = redactString(err instanceof Error ? err.message : String(err));
      if (definitelyNotSent(err)) {
        return { kind: 'not_sent', error: new AppError('INTEGRATION_UNAVAILABLE', `DataForSEO ${spec.key}: request not sent (${message})`, { details: { endpoint: spec.key } }) };
      }
      const timedOut = controller.signal.aborted;
      return {
        kind: 'ambiguous',
        httpStatus: null,
        envelope: null,
        error: new AppError(timedOut ? 'TIMEOUT' : 'PROVIDER_ERROR', `DataForSEO ${spec.key}: ${timedOut ? 'local timeout' : 'network error'} (${message})`, { details: { endpoint: spec.key } }),
      };
    }
    clearTimeout(timer);
    const respHeaders: Record<string, string> = {};
    for (const h of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'content-type']) {
      const v = res.headers.get(h);
      if (v !== null) respHeaders[h] = v;
    }
    this.cfg.logger.debug(`DataForSEO ${spec.method} ${spec.key}`, { httpStatus: res.status, ms: this.cfg.now() - started, rateLimitRemaining: respHeaders['x-ratelimit-remaining'] ?? null });

    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    const envelope = parseEnvelope<R>(parsed);

    // Documented non-200 statuses: 401, 402, 404 (not accepted) and 500 (DF13).
    if (res.status === 401 || res.status === 402 || res.status === 404) {
      return {
        kind: 'rejected',
        httpStatus: res.status,
        envelope,
        error: new DataForSeoApiError({ endpoint: spec.key, level: 'http', statusCode: envelope?.status_code ?? null, statusMessage: envelope?.status_message ?? `HTTP ${res.status}`, httpStatus: res.status }),
      };
    }
    if (res.status !== 200 || !envelope) {
      const error = new DataForSeoApiError({
        endpoint: spec.key,
        level: 'http',
        statusCode: envelope?.status_code ?? null,
        statusMessage: envelope ? envelope.status_message : res.status === 200 ? 'unparseable response body' : `HTTP ${res.status}`,
        httpStatus: res.status,
      });
      if (spec.method === 'POST') return { kind: 'ambiguous', httpStatus: res.status, envelope, error };
      return { kind: 'rejected', httpStatus: res.status, envelope, error };
    }
    if (envelope.status_code !== 20000) {
      const error = new DataForSeoApiError({ endpoint: spec.key, level: 'response', statusCode: envelope.status_code, statusMessage: envelope.status_message, httpStatus: res.status });
      // A response-level server error on a POST may still have created tasks.
      if (spec.method === 'POST' && envelope.status_code >= 50000) return { kind: 'ambiguous', httpStatus: res.status, envelope, error };
      return { kind: 'rejected', httpStatus: res.status, envelope, error };
    }
    return { kind: 'ok', httpStatus: res.status, envelope, headers: respHeaders };
  }
}
