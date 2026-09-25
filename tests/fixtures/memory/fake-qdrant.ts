/**
 * SYNTHETIC TEST DOUBLE. In-memory Qdrant that implements the REST shapes
 * verified in docs/integration-contracts.md section 8 (v1.19): health,
 * collections (exists/create/info), payload indexes, upsert, delete (ids or
 * filter), scroll (paged), and query (cosine + filter). Not a real Qdrant.
 *
 * Knobs for failure tests:
 * - down: every request fails like a refused connection.
 * - ignoreSiteFilterOnQuery: the query endpoint ignores site_id conditions
 *   (simulates a buggy/misconfigured index returning cross-site points).
 * - apiKey: when set, non-health endpoints require a matching `api-key` header.
 */
import type { FetchLike } from '../../../src/integrations/types.js';

type Payload = Record<string, unknown>;
interface StoredPoint {
  vector: number[];
  payload: Payload;
}
interface Collection {
  size: number;
  distance: string;
  points: Map<string, StoredPoint>;
  indexes: Map<string, unknown>;
}

export interface FakeQdrantRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: unknown;
}

type Cond = Record<string, unknown>;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function getKey(payload: Payload, key: string): unknown {
  return key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Payload)[k] : undefined), payload);
}

export function matchesFilter(id: string, payload: Payload, filter: Cond | undefined, skipKeys: Set<string> = new Set()): boolean {
  if (!filter) return true;
  const must = (filter.must as Cond[] | undefined) ?? [];
  const should = (filter.should as Cond[] | undefined) ?? [];
  const mustNot = (filter.must_not as Cond[] | undefined) ?? [];
  const test = (c: Cond): boolean => {
    if ('must' in c || 'should' in c || 'must_not' in c) return matchesFilter(id, payload, c, skipKeys);
    if ('has_id' in c) return (c.has_id as unknown[]).map(String).includes(id);
    const key = c.key as string;
    if (skipKeys.has(key)) return true;
    const v = getKey(payload, key);
    if ('match' in c) {
      const m = c.match as Cond;
      if ('value' in m) return v === m.value;
      if ('any' in m) return (m.any as unknown[]).includes(v);
      if ('except' in m) return !(m.except as unknown[]).includes(v);
    }
    if ('is_null' in c) return v === null;
    if ('is_empty' in c) return v === undefined || v === null || (Array.isArray(v) && v.length === 0);
    throw new Error(`fake-qdrant: unsupported condition ${JSON.stringify(c)}`);
  };
  if (!must.every(test)) return false;
  if (should.length && !should.some(test)) return false;
  if (mustNot.some(test)) return false;
  return true;
}

function ok(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ time: 0.001, status: 'ok', result }), { status, headers: { 'content-type': 'application/json' } });
}
function err(status: number, message: string): Response {
  return new Response(JSON.stringify({ time: 0.001, status: { error: message } }), { status, headers: { 'content-type': 'application/json' } });
}

export class FakeQdrant {
  readonly collections = new Map<string, Collection>();
  readonly requests: FakeQdrantRequest[] = [];
  down = false;
  ignoreSiteFilterOnQuery = false;
  apiKey: string | null = null;
  version = '1.19.1';

  constructor(opts: { apiKey?: string } = {}) {
    this.apiKey = opts.apiKey ?? null;
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' && init.body ? (JSON.parse(init.body) as unknown) : null;
    this.requests.push({ method, path: url.pathname, query: url.search, headers, body });
    if (this.down) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6333'), { code: 'ECONNREFUSED' }) });
    return this.handle(method, url.pathname, headers, body);
  };

  /** Number of requests matching a method and path pattern. */
  count(method: string, pathRe: RegExp): number {
    return this.requests.filter((r) => r.method === method && pathRe.test(r.path)).length;
  }

  pointsFor(collection: string, siteId?: string): Array<{ id: string; payload: Payload; vector: number[] }> {
    const c = this.collections.get(collection);
    if (!c) return [];
    return [...c.points.entries()].filter(([, p]) => !siteId || p.payload.site_id === siteId).map(([id, p]) => ({ id, payload: p.payload, vector: p.vector }));
  }

  handle(method: string, path: string, headers: Record<string, string>, body: unknown): Response {
    if (method === 'GET' && (path === '/healthz' || path === '/livez' || path === '/readyz')) {
      return new Response('healthz check passed', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (this.apiKey && headers['api-key'] !== this.apiKey) return new Response('Must provide an API key or an Authorization bearer token', { status: 401 });
    if (method === 'GET' && path === '/') return new Response(JSON.stringify({ title: 'qdrant - vector search engine', version: this.version, commit: null }), { status: 200 });

    const m = /^\/collections\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) return err(404, `Not found: ${path}`);
    const name = decodeURIComponent(m[1]!);
    const rest = m[2] ?? '';
    const col = this.collections.get(name);
    const b = (body ?? {}) as Cond;

    if (rest === '/exists' && method === 'GET') return ok({ exists: !!col });
    if (rest === '' && method === 'PUT') {
      if (col) return err(409, `Collection \`${name}\` already exists!`);
      const vectors = b.vectors as { size: number; distance: string };
      if (!vectors || typeof vectors.size !== 'number' || !['Cosine', 'Euclid', 'Dot', 'Manhattan'].includes(vectors.distance)) return err(400, 'bad vectors config');
      this.collections.set(name, { size: vectors.size, distance: vectors.distance, points: new Map(), indexes: new Map() });
      return ok(true);
    }
    if (!col) return err(404, `Collection \`${name}\` doesn't exist!`);
    if (rest === '' && method === 'GET') {
      return ok({
        status: 'green',
        optimizer_status: 'ok',
        segments_count: 1,
        points_count: col.points.size,
        indexed_vectors_count: 0,
        config: { params: { vectors: { size: col.size, distance: col.distance } } },
        payload_schema: Object.fromEntries([...col.indexes.entries()].map(([k, v]) => [k, { data_type: v, points: col.points.size }])),
      });
    }
    if (rest === '/index' && method === 'PUT') {
      col.indexes.set(b.field_name as string, b.field_schema);
      return ok({ status: 'completed', operation_id: 1 });
    }
    if (rest === '/points' && method === 'PUT') {
      const points = b.points as Array<{ id: string; vector: number[]; payload?: Payload }>;
      for (const p of points) {
        if (!Array.isArray(p.vector) || p.vector.length !== col.size) return err(400, `Wrong input: Vector dimension error: expected dim: ${col.size}, got ${p.vector?.length}`);
        if (typeof p.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(p.id)) return err(400, 'Wrong input: bad point id');
      }
      for (const p of points) col.points.set(p.id.toLowerCase(), { vector: p.vector, payload: p.payload ?? {} });
      return ok({ status: 'completed', operation_id: 2 });
    }
    if (rest === '/points/delete' && method === 'POST') {
      if (Array.isArray(b.points)) for (const id of b.points as string[]) col.points.delete(String(id).toLowerCase());
      else if (b.filter) for (const [id, p] of [...col.points.entries()]) if (matchesFilter(id, p.payload, b.filter as Cond)) col.points.delete(id);
      return ok({ status: 'completed', operation_id: 3 });
    }
    if (rest === '/points/scroll' && method === 'POST') {
      const limit = (b.limit as number | undefined) ?? 10;
      const ids = [...col.points.keys()].sort().filter((id) => matchesFilter(id, col.points.get(id)!.payload, b.filter as Cond | undefined));
      const start = b.offset ? ids.findIndex((id) => id >= String(b.offset)) : 0;
      const page = ids.slice(Math.max(0, start), Math.max(0, start) + limit);
      const next = ids[Math.max(0, start) + limit] ?? null;
      const wp = b.with_payload ?? true;
      return ok({
        points: page.map((id) => ({ id, payload: this.projectPayload(col.points.get(id)!.payload, wp) })),
        next_page_offset: next,
      });
    }
    if (rest === '/points/query' && method === 'POST') {
      const vector = b.query as number[];
      if (!Array.isArray(vector) || vector.length !== col.size) return err(400, `Wrong input: Vector dimension error: expected dim: ${col.size}, got ${vector?.length}`);
      const skip = this.ignoreSiteFilterOnQuery ? new Set(['site_id']) : new Set<string>();
      const scored = [...col.points.entries()]
        .filter(([id, p]) => matchesFilter(id, p.payload, b.filter as Cond | undefined, skip))
        .map(([id, p]) => ({ id, version: 1, score: cosine(vector, p.vector), payload: p.payload }))
        .sort((x, y) => y.score - x.score)
        .slice(0, (b.limit as number | undefined) ?? 10);
      const wp = b.with_payload ?? false;
      return ok({ points: scored.map((s) => (wp ? { ...s, payload: this.projectPayload(s.payload, wp) } : { id: s.id, version: s.version, score: s.score })) });
    }
    return err(404, `fake-qdrant: unsupported ${method} ${path}`);
  }

  private projectPayload(payload: Payload, wp: unknown): Payload | undefined {
    if (wp === false) return undefined;
    if (Array.isArray(wp)) return Object.fromEntries(Object.entries(payload).filter(([k]) => (wp as string[]).includes(k)));
    return payload;
  }
}
