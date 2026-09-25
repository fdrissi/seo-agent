import { AppError, errorMessage } from '../core/errors.js';
import { retry, type RetryPolicy } from '../core/retry.js';
import type { Logger } from '../core/logger.js';
import type { FetchLike } from '../integrations/types.js';
import { redactString } from '../security/redact.js';

/**
 * Qdrant REST adapter (v1.19.x), verified against docs/integration-contracts.md
 * section 8 (retrieved 2026-09-24). This is the ONLY component that talks to
 * Qdrant; it receives an injected FetchLike and never goes through the
 * SSRF-guarded crawler fetcher (local Qdrant access belongs to this fixed
 * adapter, spec section 26).
 *
 * Endpoints used (all verified):
 *   GET  /healthz                                   plain text, no auth needed
 *   GET  /                                          {title, version, commit}
 *   GET  /collections/{name}/exists                 result.exists
 *   PUT  /collections/{name}                        {vectors:{size, distance:'Cosine'}}
 *   GET  /collections/{name}                        result.config.params.vectors, points_count
 *   PUT  /collections/{name}/index?wait=true        {field_name, field_schema}
 *   PUT  /collections/{name}/points?wait=true       {points:[{id, vector, payload}]}
 *   POST /collections/{name}/points/delete?wait=true {points:[ids]} | {filter}
 *   POST /collections/{name}/points/scroll          {filter, limit, offset, with_payload, with_vector}
 *   POST /collections/{name}/points/query           {query, filter, limit, with_payload:true}
 *
 * Not used: the deprecated /points/search endpoint (removed from the v1.19
 * OpenAPI). Error bodies are unverified, so non-2xx responses are reported
 * as HTTP status plus redacted, truncated body text.
 */

export const QDRANT_VERIFIED_API_VERSION = '1.19';

export type QdrantMatch = { value: string | number | boolean } | { any: Array<string | number> } | { except: Array<string | number> };
export type QdrantCondition =
  | { key: string; match: QdrantMatch }
  | { key: string; range: { gt?: number | string; gte?: number | string; lt?: number | string; lte?: number | string } }
  | { has_id: Array<string | number> }
  | { is_empty: { key: string } }
  | { is_null: { key: string } }
  | QdrantFilter;
export interface QdrantFilter {
  must?: QdrantCondition[];
  should?: QdrantCondition[];
  must_not?: QdrantCondition[];
}

export type PayloadFieldSchema = 'keyword' | 'integer' | 'float' | 'bool' | 'datetime' | 'text' | 'uuid';

export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface QdrantRecord {
  id: string | number;
  payload?: Record<string, unknown> | null;
}

export interface QdrantScoredPoint extends QdrantRecord {
  score: number;
  version?: number;
}

export interface QdrantCollectionInfo {
  status: string | null;
  pointsCount: number | null;
  vectorSize: number | null;
  distance: string | null;
  namedVectors: boolean;
  payloadSchema: Record<string, unknown>;
}

export interface QdrantHealth {
  ok: boolean;
  httpStatus: number | null;
  detail: string;
  version: string | null;
  versionWarning: string | null;
}

export class QdrantError extends AppError {
  readonly httpStatus: number | null;
  readonly retryable: boolean;
  constructor(message: string, opts: { httpStatus?: number | null; retryable?: boolean; cause?: unknown } = {}) {
    super(opts.httpStatus === 401 || opts.httpStatus === 403 ? 'PERMISSION_DENIED' : 'INTEGRATION_UNAVAILABLE', message, {
      details: { httpStatus: opts.httpStatus ?? null },
      hint:
        opts.httpStatus === 401 || opts.httpStatus === 403
          ? 'Qdrant rejected the API key. Set QDRANT_API_KEY in <workspace>/secrets/secrets.env to the key configured on the server.'
          : 'Start Qdrant (`docker compose up -d qdrant`) and check QDRANT_URL. Memory search continues with full-text only.',
      ...(opts.cause !== undefined ? { cause: opts.cause } : {}),
    });
    this.name = 'QdrantError';
    this.httpStatus = opts.httpStatus ?? null;
    this.retryable = opts.retryable ?? false;
  }
}

export interface QdrantClientOptions {
  baseUrl: string;
  apiKey?: string | null;
  fetch: FetchLike;
  timeoutMs?: number;
  retryPolicy?: RetryPolicy;
  logger?: Logger;
  /** Max points per upsert request (keeps requests well under Qdrant's default 32 MB limit). */
  upsertBatchSize?: number;
}

export const DEFAULT_QDRANT_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 2_000, jitter: 0.2 };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return LOOPBACK_HOSTS.has(u.hostname) || /^127(?:\.\d{1,3}){3}$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** True when an API key would travel unencrypted to a non-loopback host. */
export function insecureApiKeyTransport(baseUrl: string, apiKey: string | null | undefined): boolean {
  if (!apiKey) return false;
  try {
    return new URL(baseUrl).protocol === 'http:' && !isLoopbackUrl(baseUrl);
  } catch {
    return false;
  }
}

function truncate(s: string, n = 500): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

/**
 * Website isolation guard: every read/delete by filter must carry a
 * `site_id` equality condition in `must`. Deleting or searching across sites
 * is never allowed through this adapter.
 */
export function assertSiteScoped(filter: QdrantFilter | undefined, operation: string): string {
  const cond = filter?.must?.find(
    (c): c is { key: string; match: { value: string } } =>
      typeof c === 'object' && c !== null && 'key' in c && (c as { key: unknown }).key === 'site_id' && 'match' in c && typeof ((c as { match: { value?: unknown } }).match.value) === 'string',
  );
  if (!cond || !cond.match.value) {
    throw new AppError('POLICY_DENIED', `Qdrant ${operation} without a mandatory site_id filter was refused (website isolation).`);
  }
  return cond.match.value;
}

export class QdrantClient {
  readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly logger: Logger | undefined;
  readonly upsertBatchSize: number;

  constructor(opts: QdrantClientOptions) {
    let u: URL;
    try {
      u = new URL(opts.baseUrl);
    } catch {
      throw new AppError('CONFIG_INVALID', `QDRANT_URL is not a valid URL`, { hint: 'Set QDRANT_URL, e.g. http://127.0.0.1:6333' });
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new AppError('CONFIG_INVALID', 'QDRANT_URL must use http or https');
    if (u.username || u.password) throw new AppError('CONFIG_INVALID', 'QDRANT_URL must not embed credentials; use QDRANT_API_KEY');
    if (insecureApiKeyTransport(opts.baseUrl, opts.apiKey)) {
      // Refused, not just warned: the api-key header would travel in cleartext over a network.
      throw new AppError('CONFIG_INVALID', `QDRANT_API_KEY would be sent over plain HTTP to a non-loopback host (${u.host}); refusing to create the Qdrant client.`, {
        hint: 'Use an https QDRANT_URL (enable TLS on Qdrant or put a TLS reverse proxy in front of it), or a loopback URL such as http://127.0.0.1:6333 for a local Qdrant. Memory search continues with full-text only until then.',
      });
    }
    this.baseUrl = u.toString().replace(/\/+$/, '');
    this.apiKey = opts.apiKey || null;
    this.fetchFn = opts.fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retryPolicy = opts.retryPolicy ?? DEFAULT_QDRANT_RETRY;
    this.logger = opts.logger;
    this.upsertBatchSize = Math.max(1, opts.upsertBatchSize ?? 64);
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json' };
    if (json) h['content-type'] = 'application/json';
    if (this.apiKey) h['api-key'] = this.apiKey;
    return h;
  }

  private async send(method: string, path: string, body?: unknown, opts: { retry?: boolean; auth?: boolean } = {}): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const once = async () => {
      let res: Response;
      try {
        const headers = this.headers(body !== undefined);
        if (opts.auth === false) delete headers['api-key'];
        res = await this.fetchFn(url, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        throw new QdrantError(`Qdrant request failed (${method} ${path}): ${redactString(errorMessage(err))}`, { retryable: true, cause: err });
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new QdrantError(`Qdrant ${method} ${path} returned HTTP ${res.status}: ${redactString(truncate(text))}`, {
          httpStatus: res.status,
          retryable: res.status >= 500 || res.status === 429,
        });
      }
      return res;
    };
    if (opts.retry === false) return once();
    return retry(once, {
      policy: this.retryPolicy,
      shouldRetry: (err) => err instanceof QdrantError && err.retryable,
      onRetry: (err, attempt, delay) => this.logger?.warn('Qdrant request retry', { attempt, delayMs: delay, error: errorMessage(err) }),
    });
  }

  private async call<T>(method: string, path: string, body?: unknown, opts: { retry?: boolean } = {}): Promise<T> {
    const res = await this.send(method, path, body, opts);
    const text = await res.text();
    let parsed: { status?: unknown; result?: unknown };
    try {
      parsed = JSON.parse(text) as { status?: unknown; result?: unknown };
    } catch {
      throw new QdrantError(`Qdrant ${method} ${path} returned non-JSON body: ${redactString(truncate(text))}`, { httpStatus: res.status });
    }
    if (parsed.status !== 'ok') {
      throw new QdrantError(`Qdrant ${method} ${path} returned status ${redactString(truncate(JSON.stringify(parsed.status ?? null)))}`, { httpStatus: res.status });
    }
    return parsed.result as T;
  }

  private async write(method: string, path: string, body: unknown): Promise<void> {
    const once = async () => {
      const result = await this.call<{ status?: string } | boolean>(method, path, body, { retry: false });
      if (result && typeof result === 'object' && result.status === 'wait_timeout') {
        throw new QdrantError(`Qdrant ${method} ${path}: operation did not complete before wait timeout`, { retryable: true });
      }
    };
    // Writes used here are idempotent (upsert by deterministic id, delete by id/filter, create index), so bounded retries are safe.
    await retry(once, {
      policy: this.retryPolicy,
      shouldRetry: (err) => err instanceof QdrantError && err.retryable,
      onRetry: (err, attempt, delay) => this.logger?.warn('Qdrant write retry', { attempt, delayMs: delay, error: errorMessage(err) }),
    });
  }

  private col(name: string): string {
    return `/collections/${encodeURIComponent(name)}`;
  }

  /** Free, unauthenticated health check: GET /healthz, then GET / for the version. Never retried. */
  async health(): Promise<QdrantHealth> {
    let status: number | null = null;
    try {
      const res = await this.send('GET', '/healthz', undefined, { retry: false, auth: false });
      status = res.status;
      await res.text().catch(() => '');
    } catch (err) {
      const httpStatus = err instanceof QdrantError ? err.httpStatus : null;
      return { ok: false, httpStatus, detail: errorMessage(err), version: null, versionWarning: null };
    }
    let version: string | null = null;
    try {
      const res = await this.send('GET', '/', undefined, { retry: false });
      const body = (await res.json()) as { version?: unknown; result?: { version?: unknown } };
      const v = body.version ?? body.result?.version;
      version = typeof v === 'string' ? v : null;
    } catch {
      version = null;
    }
    const versionWarning =
      version && !version.replace(/^v/, '').startsWith(`${QDRANT_VERIFIED_API_VERSION}.`)
        ? `Qdrant server ${version} differs from the verified API version ${QDRANT_VERIFIED_API_VERSION}.x; the adapter uses only documented endpoints but has not been verified against this version.`
        : null;
    return { ok: true, httpStatus: status, detail: 'healthz check passed', version, versionWarning };
  }

  async collectionExists(name: string): Promise<boolean> {
    const r = await this.call<{ exists?: boolean }>('GET', `${this.col(name)}/exists`);
    return r?.exists === true;
  }

  async createCollection(name: string, size: number): Promise<void> {
    if (!Number.isInteger(size) || size <= 0) throw new RangeError(`Invalid vector size ${size}`);
    await this.write('PUT', this.col(name), { vectors: { size, distance: 'Cosine' } });
  }

  async getCollection(name: string): Promise<QdrantCollectionInfo> {
    const r = await this.call<{
      status?: string;
      points_count?: number | null;
      config?: { params?: { vectors?: unknown } };
      payload_schema?: Record<string, unknown>;
    }>('GET', this.col(name));
    const vectors = r?.config?.params?.vectors as { size?: unknown; distance?: unknown } | Record<string, unknown> | undefined;
    let vectorSize: number | null = null;
    let distance: string | null = null;
    let named = false;
    if (vectors && typeof vectors === 'object') {
      if (typeof (vectors as { size?: unknown }).size === 'number') {
        vectorSize = (vectors as { size: number }).size;
        distance = typeof (vectors as { distance?: unknown }).distance === 'string' ? ((vectors as { distance: string }).distance) : null;
      } else named = Object.keys(vectors).length > 0;
    }
    return {
      status: r?.status ?? null,
      pointsCount: typeof r?.points_count === 'number' ? r.points_count : null,
      vectorSize,
      distance,
      namedVectors: named,
      payloadSchema: r?.payload_schema ?? {},
    };
  }

  async createPayloadIndex(name: string, field: string, schema: PayloadFieldSchema): Promise<void> {
    await this.write('PUT', `${this.col(name)}/index?wait=true`, { field_name: field, field_schema: schema });
  }

  /**
   * Create the collection when missing (vector size = dims, cosine) and its
   * payload indexes (created before ingesting data, as documented). An
   * existing collection whose vector size/distance differs is REFUSED: vectors
   * of different embedding spaces are never mixed.
   */
  async ensureCollection(name: string, dims: number, indexes: Record<string, PayloadFieldSchema>): Promise<{ created: boolean; info: QdrantCollectionInfo }> {
    let created = false;
    if (!(await this.collectionExists(name))) {
      await this.createCollection(name, dims);
      created = true;
    }
    const info = await this.getCollection(name);
    if (info.namedVectors || info.vectorSize !== dims || (info.distance !== null && info.distance !== 'Cosine')) {
      throw new AppError(
        'CONFLICT',
        `Qdrant collection "${name}" has vector size ${info.vectorSize ?? 'unknown'} / distance ${info.distance ?? 'unknown'}${info.namedVectors ? ' (named vectors)' : ''}, expected ${dims} / Cosine. Refusing to mix embedding spaces.`,
        { hint: 'Use a new embedding version (change model/dimensions in config) or delete the mismatched collection and run `memory rebuild`.' },
      );
    }
    const existing = new Set(Object.keys(info.payloadSchema));
    for (const [field, schema] of Object.entries(indexes)) {
      if (!existing.has(field)) await this.createPayloadIndex(name, field, schema);
    }
    return { created, info };
  }

  async upsertPoints(name: string, points: QdrantPoint[]): Promise<number> {
    let n = 0;
    for (let i = 0; i < points.length; i += this.upsertBatchSize) {
      const batch = points.slice(i, i + this.upsertBatchSize);
      await this.write('PUT', `${this.col(name)}/points?wait=true`, { points: batch });
      n += batch.length;
    }
    return n;
  }

  async deletePoints(name: string, ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += 256) {
      await this.write('POST', `${this.col(name)}/points/delete?wait=true`, { points: ids.slice(i, i + 256) });
    }
  }

  async deleteByFilter(name: string, filter: QdrantFilter): Promise<void> {
    assertSiteScoped(filter, 'delete-by-filter');
    await this.write('POST', `${this.col(name)}/points/delete?wait=true`, { filter });
  }

  async scroll(name: string, opts: { filter: QdrantFilter; limit?: number; offset?: string | number | null; withPayload?: boolean | string[] }): Promise<{ points: QdrantRecord[]; nextOffset: string | number | null }> {
    assertSiteScoped(opts.filter, 'scroll');
    const r = await this.call<{ points?: QdrantRecord[]; next_page_offset?: string | number | null }>('POST', `${this.col(name)}/points/scroll`, {
      filter: opts.filter,
      limit: opts.limit ?? 256,
      ...(opts.offset !== undefined && opts.offset !== null ? { offset: opts.offset } : {}),
      with_payload: opts.withPayload ?? true,
      with_vector: false,
    });
    return { points: Array.isArray(r?.points) ? r.points : [], nextOffset: r?.next_page_offset ?? null };
  }

  /** Scroll every page (loop until next_page_offset is null), with a hard page cap. */
  async scrollAll(name: string, filter: QdrantFilter, withPayload: boolean | string[] = true, maxPages = 10_000): Promise<QdrantRecord[]> {
    const out: QdrantRecord[] = [];
    let offset: string | number | null = null;
    for (let page = 0; page < maxPages; page++) {
      const r = await this.scroll(name, { filter, limit: 256, offset, withPayload });
      out.push(...r.points);
      if (r.nextOffset === null || r.nextOffset === undefined) return out;
      offset = r.nextOffset;
    }
    throw new QdrantError(`Qdrant scroll exceeded ${maxPages} pages for ${name}`);
  }

  async query(name: string, opts: { vector: number[]; filter: QdrantFilter; limit: number; scoreThreshold?: number }): Promise<QdrantScoredPoint[]> {
    assertSiteScoped(opts.filter, 'query');
    const r = await this.call<{ points?: QdrantScoredPoint[] }>('POST', `${this.col(name)}/points/query`, {
      query: opts.vector,
      filter: opts.filter,
      limit: opts.limit,
      with_payload: true,
      with_vector: false,
      ...(opts.scoreThreshold !== undefined ? { score_threshold: opts.scoreThreshold } : {}),
    });
    return Array.isArray(r?.points) ? r.points : [];
  }
}

/** Payload indexes created on every memory collection (before data is ingested). */
export const MEMORY_PAYLOAD_INDEXES: Record<string, PayloadFieldSchema> = {
  site_id: 'keyword',
  source_type: 'keyword',
  trust_class: 'keyword',
  status: 'keyword',
  language: 'keyword',
  superseded: 'bool',
  access_scope: 'keyword',
  document_id: 'keyword',
};

/** Qdrant payload stored with each memory vector. No chunk text is stored in Qdrant (SQLite holds it). */
export interface MemoryPointPayload {
  site_id: string;
  document_id: string;
  chunk_id: string;
  source_type: string;
  trust_class: string;
  status: string;
  record_status: string | null;
  access_scope: string;
  language: string;
  superseded: boolean;
  content_hash: string;
  occurrence: number;
  document_version: number;
  embedding_version_id: string;
  chunker_version: string;
  source_date: string | null;
}
