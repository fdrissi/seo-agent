import type { AppContext } from '../../app/context.js';
import { AppError, type ErrorCode } from '../../core/errors.js';
import { sleep as coreSleep } from '../../core/concurrency.js';
import { parseRetryAfter } from '../../core/retry.js';
import type { Logger } from '../../core/logger.js';
import { redactString } from '../../security/redact.js';
import type { FetchLike } from '../types.js';
import {
  apifyActorSchema,
  apifyBuildSchema,
  apifyBuildShortSchema,
  apifyRunSchema,
  apifyRunShortSchema,
  type ApifyActor,
  type ApifyBuild,
  type ApifyBuildShort,
  type ApifyRun,
  type ApifyRunShort,
  type DatasetPage,
  type PaginatedList,
  type RunStartOptions,
} from './types.js';

/**
 * Generic Apify API v2 client.
 *
 * Contract: docs/integration-contracts.md section 7 (retrieved 2026-09-24).
 * - Base URL https://api.apify.com, canonical `/v2/actors/...` prefix.
 * - Auth: `Authorization: Bearer <APIFY_TOKEN>` on every call. The token is
 *   NEVER placed in a query string (it would end up in logs).
 * - Errors: `{error: {type, message}}`. 429 and 5xx on idempotent GETs are
 *   retried with exponential backoff; the paid run POST is NEVER retried.
 * - A transport failure on the run POST is surfaced as an ambiguous
 *   submission (the provider may have accepted the run).
 */

export const APIFY_API_BASE = 'https://api.apify.com';

export interface ApifyClientOptions {
  token: string | undefined;
  fetch: FetchLike;
  baseUrl?: string;
  /** Per-request timeout for ordinary calls (ms). */
  requestTimeoutMs?: number;
  /** Max attempts for idempotent GETs (429/5xx/transport). */
  maxGetAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

/** HTTP-level error returned by the Apify API. */
export class ApifyApiError extends AppError {
  readonly httpStatus: number;
  readonly apifyErrorType: string | null;
  readonly retryAfterMs: number | undefined;

  constructor(httpStatus: number, apifyErrorType: string | null, message: string, endpoint: string, retryAfterMs?: number) {
    super(codeForStatus(httpStatus), `Apify ${endpoint}: HTTP ${httpStatus}${apifyErrorType ? ` ${apifyErrorType}` : ''}: ${message}`, {
      details: { httpStatus, apifyErrorType, endpoint },
      hint: hintForStatus(httpStatus, apifyErrorType),
    });
    this.name = 'ApifyApiError';
    this.httpStatus = httpStatus;
    this.apifyErrorType = apifyErrorType;
    this.retryAfterMs = retryAfterMs;
  }

  get retryable(): boolean {
    return this.httpStatus === 429 || this.httpStatus >= 500;
  }
}

/**
 * The request did not produce an HTTP response (network error, timeout,
 * offline mode). `sent` is false only when we know the request never left
 * this process (offline mode); otherwise the outcome is unknown.
 */
export class ApifyTransportError extends AppError {
  readonly sent: boolean;
  readonly timedOut: boolean;

  constructor(endpoint: string, cause: unknown, opts: { sent: boolean; timedOut: boolean }) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(opts.sent ? 'INTEGRATION_UNAVAILABLE' : 'INTEGRATION_DISABLED', `Apify ${endpoint}: ${opts.timedOut ? 'request timed out' : 'network error'} (${redactString(msg)})`, {
      details: { endpoint, sent: opts.sent, timedOut: opts.timedOut },
      cause,
    });
    this.name = 'ApifyTransportError';
    this.sent = opts.sent;
    this.timedOut = opts.timedOut;
  }
}

function codeForStatus(status: number): ErrorCode {
  if (status === 400) return 'VALIDATION_FAILED';
  if (status === 401 || status === 403) return 'PERMISSION_DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 408) return 'TIMEOUT';
  if (status === 429) return 'RATE_LIMITED';
  return 'PROVIDER_ERROR';
}

function hintForStatus(status: number, type: string | null): string | undefined {
  if (status === 401) {
    return type === 'token-not-provided'
      ? 'Set APIFY_TOKEN in <workspace>/secrets/secrets.env (mode 0600) or inject it as an environment variable. Never paste it into chat.'
      : 'APIFY_TOKEN was rejected. Rotate/create a token in the Apify console (Settings > Integrations) and update the workspace secrets file.';
  }
  if (status === 402) return 'The Apify account cannot pay for this request (x402/payment required). Check the account plan and limits; no automatic top-ups are performed.';
  if (status === 403) return 'The token lacks permission for this resource. Check the token scope in the Apify console.';
  if (status === 429) return 'Apify rate limit reached; retried reads with exponential backoff. Try again later.';
  return undefined;
}

function isTimeoutError(err: unknown): boolean {
  const e = err as { name?: string; code?: string } | null;
  return !!e && (e.name === 'TimeoutError' || e.name === 'AbortError' || e.code === 'TIMEOUT' || e.code === 'UND_ERR_HEADERS_TIMEOUT');
}

function isOfflineError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'OFFLINE';
}

/** Convert `username/name` to the `username~name` path form; IDs pass through. */
export function actorPathId(actorId: string): string {
  return encodeURIComponent(actorId.replace('/', '~'));
}

function headerInt(headers: Headers, name: string): number | null {
  const v = headers.get(name);
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export class ApifyClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly maxGetAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: ApifyClientOptions) {
    this.baseUrl = (opts.baseUrl ?? APIFY_API_BASE).replace(/\/+$/, '');
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.maxGetAttempts = Math.max(1, opts.maxGetAttempts ?? 4);
    this.sleep = opts.sleep ?? ((ms) => coreSleep(ms));
  }

  get hasToken(): boolean {
    return !!this.opts.token;
  }

  private url(path: string, query: Record<string, string | number | boolean | null | undefined> = {}): string {
    const u = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      if (k === 'token') throw new AppError('INTERNAL', 'Refusing to place an Apify token in a URL query string');
      u.searchParams.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
    }
    return u.toString();
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json', ...extra };
    if (this.opts.token) h.authorization = `Bearer ${this.opts.token}`;
    return h;
  }

  /** One HTTP exchange; throws ApifyApiError / ApifyTransportError. */
  private async exchange(endpoint: string, url: string, init: { method: string; body?: string; timeoutMs?: number }): Promise<Response> {
    const timeoutMs = init.timeoutMs ?? this.requestTimeoutMs;
    let res: Response;
    try {
      res = await this.opts.fetch(url, {
        method: init.method,
        headers: this.headers(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ApifyTransportError(endpoint, err, { sent: !isOfflineError(err), timedOut: isTimeoutError(err) });
    }
    if (!res.ok) {
      let type: string | null = null;
      let message = res.statusText || 'request failed';
      try {
        const body = (await res.json()) as { error?: { type?: unknown; message?: unknown } };
        if (body?.error) {
          if (typeof body.error.type === 'string') type = body.error.type;
          if (typeof body.error.message === 'string') message = body.error.message;
        }
      } catch {
        /* non-JSON error body */
      }
      throw new ApifyApiError(res.status, type, redactString(message).slice(0, 500), endpoint, parseRetryAfter(res.headers.get('retry-after')));
    }
    return res;
  }

  /** Idempotent GET with bounded exponential backoff on 429/5xx/transport errors. */
  private async get(endpoint: string, url: string, timeoutMs?: number): Promise<Response> {
    let delay = 500;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.exchange(endpoint, url, { method: 'GET', ...(timeoutMs ? { timeoutMs } : {}) });
      } catch (err) {
        const retryable =
          (err instanceof ApifyApiError && err.retryable) || (err instanceof ApifyTransportError && err.sent);
        if (!retryable || attempt >= this.maxGetAttempts) throw err;
        // Random D..2D, doubling each retry (contract "Errors and retries").
        const wait = err instanceof ApifyApiError && err.retryAfterMs !== undefined ? err.retryAfterMs : delay + Math.floor(Math.random() * delay);
        this.opts.logger?.debug('Apify GET retry', { endpoint, attempt, waitMs: wait });
        await this.sleep(wait);
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  private async json(res: Response, endpoint: string): Promise<unknown> {
    try {
      return await res.json();
    } catch (err) {
      throw new AppError('PROVIDER_ERROR', `Apify ${endpoint}: response was not valid JSON`, { cause: err });
    }
  }

  private dataOf(body: unknown, endpoint: string): unknown {
    if (!body || typeof body !== 'object' || !('data' in body)) {
      throw new AppError('PROVIDER_ERROR', `Apify ${endpoint}: response has no "data" envelope`);
    }
    return (body as { data: unknown }).data;
  }

  private parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { message: string } } }, value: unknown, endpoint: string): T {
    const r = schema.safeParse(value);
    if (!r.success) throw new AppError('PROVIDER_ERROR', `Apify ${endpoint}: unexpected response shape (${r.error.message.slice(0, 300)})`);
    return r.data;
  }

  /** GET /v2/actors/{actorId} (AP1/AP2). Free read; public actors need no token. */
  async getActor(actorId: string): Promise<ApifyActor> {
    const ep = 'actor.get';
    const res = await this.get(ep, this.url(`/v2/actors/${actorPathId(actorId)}`));
    return this.parse(apifyActorSchema, this.dataOf(await this.json(res, ep), ep), ep);
  }

  /** GET /v2/actors/{actorId}/builds/default (AP3). Free read. */
  async getDefaultBuild(actorId: string): Promise<ApifyBuild> {
    const ep = 'actor.build.default';
    const res = await this.get(ep, this.url(`/v2/actors/${actorPathId(actorId)}/builds/default`));
    return this.parse(apifyBuildSchema, this.dataOf(await this.json(res, ep), ep), ep);
  }

  /** GET /v2/actor-builds/{buildId} (AP5). Free read. */
  async getBuild(buildId: string): Promise<ApifyBuild> {
    const ep = 'build.get';
    const res = await this.get(ep, this.url(`/v2/actor-builds/${encodeURIComponent(buildId)}`));
    return this.parse(apifyBuildSchema, this.dataOf(await this.json(res, ep), ep), ep);
  }

  /** GET /v2/actor-builds/{buildId}/openapi.json (AP6). Free read; raw OpenAPI document (no data envelope). */
  async getBuildOpenApi(buildId: string): Promise<unknown> {
    const ep = 'build.openapi';
    const res = await this.get(ep, this.url(`/v2/actor-builds/${encodeURIComponent(buildId)}/openapi.json`));
    return this.json(res, ep);
  }

  /**
   * GET /v2/actors/{actorId}/builds. UNVERIFIED: this endpoint's response is
   * not recorded in docs/integration-contracts.md. It is parsed defensively as
   * a standard `{data:{items}}` list and used only as an optional fallback.
   */
  async listBuilds(actorId: string, q: { offset?: number; limit?: number; desc?: boolean } = {}): Promise<PaginatedList<ApifyBuildShort>> {
    const ep = 'actor.builds.list';
    const res = await this.get(ep, this.url(`/v2/actors/${actorPathId(actorId)}/builds`, { offset: q.offset ?? 0, limit: q.limit ?? 100, desc: q.desc ?? true }));
    return this.parseList(this.dataOf(await this.json(res, ep), ep), apifyBuildShortSchema, ep);
  }

  /**
   * POST /v2/actors/{actorId}/runs (AP8/AP10). PAID. Never retried: a
   * transport failure throws ApifyTransportError (ambiguous unless `sent` is
   * false). The `webhooks` query parameter is deliberately never sent.
   */
  async startRun(actorId: string, body: string, o: RunStartOptions): Promise<{ run: ApifyRun; httpStatus: number }> {
    const ep = 'actor.runs.start';
    const url = this.url(`/v2/actors/${actorPathId(actorId)}/runs`, {
      build: o.build,
      timeout: o.timeoutSecs,
      memory: o.memoryMbytes,
      maxItems: o.maxItems ?? undefined,
      maxTotalChargeUsd: o.maxTotalChargeUsd,
      restartOnError: false,
      waitForFinish: o.waitForFinish ?? 0,
    });
    const res = await this.exchange(ep, url, { method: 'POST', body, timeoutMs: this.requestTimeoutMs + (o.waitForFinish ?? 0) * 1000 });
    const run = this.parse(apifyRunSchema, this.dataOf(await this.json(res, ep), ep), ep);
    return { run, httpStatus: res.status };
  }

  /** GET /v2/actor-runs/{runId}?waitForFinish=0..60 (AP8). */
  async getRun(runId: string, q: { waitForFinish?: number } = {}): Promise<ApifyRun> {
    const ep = 'run.get';
    const wait = Math.max(0, Math.min(60, Math.floor(q.waitForFinish ?? 0)));
    const res = await this.get(ep, this.url(`/v2/actor-runs/${encodeURIComponent(runId)}`, { waitForFinish: wait || undefined }), this.requestTimeoutMs + wait * 1000);
    return this.parse(apifyRunSchema, this.dataOf(await this.json(res, ep), ep), ep);
  }

  /** GET /v2/actors/{actorId}/runs (AP8). Token required (AP7: 401 without). */
  async listRuns(
    actorId: string,
    q: { offset?: number; limit?: number; desc?: boolean; status?: string[]; startedAfter?: string; startedBefore?: string } = {},
  ): Promise<PaginatedList<ApifyRunShort>> {
    const ep = 'actor.runs.list';
    const res = await this.get(
      ep,
      this.url(`/v2/actors/${actorPathId(actorId)}/runs`, {
        offset: q.offset ?? 0,
        limit: Math.min(1000, q.limit ?? 100),
        desc: q.desc ?? true,
        status: q.status?.length ? q.status.join(',') : undefined,
        startedAfter: q.startedAfter,
        startedBefore: q.startedBefore,
      }),
    );
    return this.parseList(this.dataOf(await this.json(res, ep), ep), apifyRunShortSchema, ep);
  }

  /** Page through list-runs with a hard cap on pages. `complete` is false when the cap stopped paging. */
  async listRunsAll(actorId: string, q: { startedAfter?: string; startedBefore?: string; pageSize?: number; maxPages?: number } = {}): Promise<{ items: ApifyRunShort[]; complete: boolean }> {
    const pageSize = q.pageSize ?? 100;
    const maxPages = q.maxPages ?? 10;
    const items: ApifyRunShort[] = [];
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      const r = await this.listRuns(actorId, { offset, limit: pageSize, desc: true, ...(q.startedAfter ? { startedAfter: q.startedAfter } : {}), ...(q.startedBefore ? { startedBefore: q.startedBefore } : {}) });
      items.push(...r.items);
      offset += pageSize;
      const total = r.total;
      if (r.items.length === 0 || (total !== null && offset >= total) || (total === null && r.items.length < pageSize)) return { items, complete: true };
    }
    return { items, complete: false };
  }

  /**
   * GET /v2/datasets/{datasetId}/items (AP8/AP12). The body is a bare JSON
   * array; pagination comes from X-Apify-Pagination-* headers.
   */
  async getDatasetItemsPage(datasetId: string, q: { offset: number; limit: number; clean?: boolean; fields?: string[]; omit?: string[] }): Promise<DatasetPage> {
    const ep = 'dataset.items';
    const res = await this.get(
      ep,
      this.url(`/v2/datasets/${encodeURIComponent(datasetId)}/items`, {
        format: 'json',
        clean: q.clean ?? true,
        offset: q.offset,
        limit: q.limit,
        fields: q.fields?.length ? q.fields.join(',') : undefined,
        omit: q.omit?.length ? q.omit.join(',') : undefined,
      }),
    );
    const body = await this.json(res, ep);
    if (!Array.isArray(body)) throw new AppError('PROVIDER_ERROR', `Apify ${ep}: expected a JSON array of items`);
    return {
      items: body,
      total: headerInt(res.headers, 'x-apify-pagination-total'),
      offset: headerInt(res.headers, 'x-apify-pagination-offset') ?? q.offset,
      limit: headerInt(res.headers, 'x-apify-pagination-limit') ?? q.limit,
      count: headerInt(res.headers, 'x-apify-pagination-count') ?? body.length,
    };
  }

  /**
   * Fetch all dataset items with offset/limit pagination. Advances by `limit`
   * (not by count: `clean` pages can be short) until offset >= total. Stops at
   * `maxItems`; `complete` is false when the bound stopped the fetch or an
   * error interrupted it (the error is returned, not thrown, so callers can
   * quarantine a partial result).
   */
  async fetchAllDatasetItems(
    datasetId: string,
    q: { pageSize?: number; maxItems: number; fields?: string[]; maxPages?: number },
  ): Promise<{ items: unknown[]; total: number | null; complete: boolean; pages: number; error?: AppError; reason?: string }> {
    const pageSize = Math.max(1, Math.min(q.pageSize ?? 1000, q.maxItems || 1));
    const maxPages = q.maxPages ?? Math.ceil(q.maxItems / pageSize) + 2;
    const items: unknown[] = [];
    let offset = 0;
    let total: number | null = null;
    let pages = 0;
    try {
      while (pages < maxPages) {
        const page = await this.getDatasetItemsPage(datasetId, { offset, limit: pageSize, clean: true, ...(q.fields ? { fields: q.fields } : {}) });
        pages++;
        if (page.total !== null) total = page.total;
        items.push(...page.items);
        offset += pageSize;
        if (total !== null && total > q.maxItems) {
          return { items, total, complete: false, pages, reason: `dataset holds ${total} items, above the enforced bound of ${q.maxItems}` };
        }
        if (total !== null ? offset >= total : page.items.length === 0) return { items, total, complete: true, pages };
      }
      return { items, total, complete: false, pages, reason: `stopped after ${pages} pages (page cap)` };
    } catch (err) {
      const error = err instanceof AppError ? err : new AppError('PROVIDER_ERROR', String((err as Error)?.message ?? err));
      return { items, total, complete: false, pages, error, reason: `dataset fetch failed after ${items.length} items: ${error.message}` };
    }
  }

  /** GET /v2/key-value-stores/{storeId}/records/{key} (contract section 4, RUN-SUMMARY). Returns null on 404. */
  async getKeyValueRecord(storeId: string, key: string): Promise<unknown | null> {
    const ep = 'kv.record.get';
    try {
      const res = await this.get(ep, this.url(`/v2/key-value-stores/${encodeURIComponent(storeId)}/records/${encodeURIComponent(key)}`));
      return await this.json(res, ep);
    } catch (err) {
      if (err instanceof ApifyApiError && err.httpStatus === 404) return null;
      throw err;
    }
  }

  /**
   * POST /v2/actor-runs/{runId}/abort. UNVERIFIED: this path comes from the
   * Apify API reference but is not recorded in docs/integration-contracts.md.
   * Used only on explicit request (`apify runs --resume --abort-overdue`).
   */
  async abortRun(runId: string): Promise<ApifyRun> {
    const ep = 'run.abort';
    const res = await this.exchange(ep, this.url(`/v2/actor-runs/${encodeURIComponent(runId)}/abort`), { method: 'POST' });
    return this.parse(apifyRunSchema, this.dataOf(await this.json(res, ep), ep), ep);
  }

  private parseList<T>(data: unknown, itemSchema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, ep: string): PaginatedList<T> {
    if (!data || typeof data !== 'object') throw new AppError('PROVIDER_ERROR', `Apify ${ep}: list response has no data object`);
    const d = data as { total?: unknown; offset?: unknown; limit?: unknown; count?: unknown; items?: unknown };
    if (!Array.isArray(d.items)) throw new AppError('PROVIDER_ERROR', `Apify ${ep}: list response has no items array`);
    const items: T[] = [];
    for (const raw of d.items) {
      const r = itemSchema.safeParse(raw);
      if (r.success) items.push(r.data);
    }
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return { total: num(d.total), offset: num(d.offset) ?? 0, limit: num(d.limit), count: num(d.count) ?? items.length, items };
  }
}

/** Build a client from the application context (token from the secret store, network from ctx.fetch). */
export function createApifyClient(ctx: Pick<AppContext, 'secrets' | 'fetch' | 'logger'>, opts: Partial<Omit<ApifyClientOptions, 'token' | 'fetch'>> = {}): ApifyClient {
  return new ApifyClient({ token: ctx.secrets.get('APIFY_TOKEN'), fetch: ctx.fetch, logger: ctx.logger, ...opts });
}
