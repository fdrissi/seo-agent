/**
 * SYNTHETIC in-memory fake of the Apify API v2 routes used by the apify
 * integration (shapes from docs/integration-contracts.md section 7). Built on
 * tests/helpers/fake-fetch.ts; no network is involved.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATASET_FIELDS } from '../../../src/integrations/apify/normalize.js';
import { fakeFetch, jsonResponse, type RecordedRequest } from '../../helpers/fake-fetch.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURE_DIR = here;
export const ACTOR_ID = '9sHOY9RzPYGjmTHo8';
export const BUILD_ID = 'SYNBUILD000000513';
export const BUILD_NUMBER = '0.0.513';
export const TEST_TOKEN = 'apify_api_SYNTHETICTESTTOKEN0000000000000000';

export function loadJson<T = any>(name: string): T {
  return JSON.parse(readFileSync(path.join(here, name), 'utf8')) as T;
}

export function fixtureSchema(): Record<string, any> {
  return loadJson('input-schema.json');
}
export function fixtureActor(): Record<string, any> {
  return loadJson('actor.json').data;
}
export function fixtureItems(): any[] {
  return loadJson('dataset-items.json').items;
}

/**
 * SYNTHETIC build README (not the real actor documentation): it only carries
 * the load-bearing passages the adapter depends on, so README provenance and
 * drift can be tested offline.
 */
export const SYNTHETIC_README = [
  '# Reddit Scraper (SYNTHETIC README for tests; not the real actor documentation)',
  '',
  '## Limits',
  'maxPostsCount: 10 stores at most 10 posts (per searchTerms keyword).',
  '',
  '## Output',
  'A run can mix item shapes: split on dataType and deduplicate on dataType + id.',
  '',
  '## RUN-SUMMARY',
  'The RUN-SUMMARY record has itemsTotal, skippedTotal, requests (finished, failed, retries) and emptyReason.',
  '',
  '## Changelog',
  'Synthetic changelog line.',
].join('\n');

/** Synthetic dataset output fields (a subset of the documented 161; includes author fields that must never be requested). */
export const OUTPUT_FIELDS = [...DATASET_FIELDS, 'parsedId', 'authorName', 'authorFullname', 'bodyHtml', 'crawledAt', 'flair', 'domain', 'postType', 'parentId', 'isSubmitter'];

export function buildObject(
  opts: { id?: string; buildNumber?: string; schema?: unknown; status?: string; actId?: string; inputSchema?: unknown; outputFields?: string[] | null; readme?: string | null } = {},
): Record<string, unknown> {
  const out = opts.outputFields === undefined ? OUTPUT_FIELDS : opts.outputFields;
  return {
    readme: opts.readme === undefined ? SYNTHETIC_README : opts.readme,
    id: opts.id ?? BUILD_ID,
    actId: opts.actId ?? ACTOR_ID,
    status: opts.status ?? 'SUCCEEDED',
    buildNumber: opts.buildNumber ?? BUILD_NUMBER,
    startedAt: '2026-09-24T07:29:14.388Z',
    finishedAt: '2026-09-24T07:29:32.130Z',
    inputSchema: 'inputSchema' in opts ? opts.inputSchema : JSON.stringify(opts.schema ?? fixtureSchema()),
    actorDefinition: {
      minMemoryMbytes: 256,
      maxMemoryMbytes: 2048,
      ...(out ? { storages: { dataset: { fields: { properties: Object.fromEntries(out.map((f) => [f, { type: ['string', 'number', 'boolean', 'null'] }])) } } } } : {}),
    },
  };
}

export interface FakeRunState {
  run: Record<string, any>;
  /** Statuses returned by successive GET run calls; the last one repeats. */
  statuses: string[];
  polls: number;
  /** Fields merged into the run once it is terminal (e.g. usage). */
  finalFields?: Record<string, unknown>;
}

export type StartBehavior =
  | { kind: 'ok' }
  | { kind: 'timeout'; createRun: boolean }
  | { kind: 'http'; status: number; type: string; message: string };

export class FakeApify {
  actor: Record<string, any> = fixtureActor();
  builds = new Map<string, Record<string, unknown>>([[BUILD_ID, buildObject()]]);
  openapi = new Map<string, unknown>();
  runs = new Map<string, FakeRunState>();
  datasets = new Map<string, unknown[]>();
  kv = new Map<string, Record<string, unknown>>();
  /** Extra RunShort items returned by list-runs (besides runs created by POST). */
  foreignRuns: Array<Record<string, any>> = [];
  startBehavior: StartBehavior = { kind: 'ok' };
  startCount = 0;
  /** Status sequence for runs created by POST. */
  nextStatuses: string[] = ['RUNNING', 'SUCCEEDED'];
  nextFinalFields: Record<string, unknown> = { usageTotalUsd: 0.05, chargedEventCounts: { init: 1, result: 12 } };
  nextItems: unknown[] = fixtureItems();
  /** Dataset pages whose offset is in this set fail with HTTP 500. */
  failDatasetOffsets = new Set<number>();
  onStart?: (req: RecordedRequest) => void;
  requireToken = true;
  /** When set, a Bearer token other than this one is rejected with 401 invalid-token (as the live API does). */
  acceptedToken?: string;
  /** When false, POST-created runs do not get an INPUT record in their default key-value store. */
  storeInputRecord = true;
  private seq = 0;

  readonly fetch = fakeFetch([(req) => this.route(req)]);

  get calls(): RecordedRequest[] {
    return this.fetch.calls;
  }

  callsTo(method: string, re: RegExp): RecordedRequest[] {
    return this.calls.filter((c) => c.method === method && re.test(new URL(c.url).pathname));
  }

  addRun(state: Partial<FakeRunState> & { run: Record<string, any> }): FakeRunState {
    const s: FakeRunState = { statuses: [state.run.status ?? 'SUCCEEDED'], polls: 0, ...state };
    this.runs.set(state.run.id, s);
    return s;
  }

  private authed(req: RecordedRequest): boolean {
    return /^Bearer .+/.test(req.headers.authorization ?? '');
  }

  private unauthorized(req: RecordedRequest): Response {
    if (this.authed(req)) return jsonResponse({ error: { type: 'invalid-token', message: 'Authentication token is not valid' } }, 401);
    return jsonResponse({ error: { type: 'token-not-provided', message: 'Authentication token was not provided' } }, 401);
  }

  private tokenOk(req: RecordedRequest): boolean {
    if (!this.authed(req)) return false;
    return this.acceptedToken === undefined || req.headers.authorization === `Bearer ${this.acceptedToken}`;
  }

  private currentRun(s: FakeRunState, advance: boolean): Record<string, any> {
    const idx = Math.min(s.polls, s.statuses.length - 1);
    const status = s.statuses[idx]!;
    if (advance) s.polls++;
    const terminal = ['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(status);
    return { ...s.run, status, ...(terminal ? { finishedAt: '2026-09-24T09:03:00.000Z', ...(s.finalFields ?? {}) } : {}) };
  }

  private route(req: RecordedRequest): Response | undefined {
    const u = new URL(req.url);
    if (u.searchParams.has('token')) throw new Error('token must never be sent as a query parameter');
    const p = u.pathname;
    let m: RegExpExecArray | null;
    if (req.method === 'GET' && (m = /^\/v2\/actors\/([^/]+)$/.exec(p))) {
      if (decodeURIComponent(m[1]!) !== this.actor.id) return jsonResponse({ error: { type: 'record-not-found', message: 'Actor not found' } }, 404);
      return jsonResponse({ data: this.actor });
    }
    if (req.method === 'GET' && (m = /^\/v2\/actors\/([^/]+)\/builds\/default$/.exec(p))) {
      const latest = this.actor.taggedBuilds?.latest?.buildId;
      const b = latest ? this.builds.get(latest) : undefined;
      return b ? jsonResponse({ data: b }) : jsonResponse({ error: { type: 'record-not-found', message: 'no build' } }, 404);
    }
    if (req.method === 'GET' && (m = /^\/v2\/actors\/([^/]+)\/builds$/.exec(p))) {
      const items = [...this.builds.values()].map((b) => ({ id: b.id, status: b.status, buildNumber: b.buildNumber, startedAt: b.startedAt, finishedAt: b.finishedAt }));
      return jsonResponse({ data: { total: items.length, offset: 0, limit: 1000, count: items.length, items } });
    }
    if (req.method === 'GET' && (m = /^\/v2\/actor-builds\/([^/]+)\/openapi\.json$/.exec(p))) {
      const doc = this.openapi.get(decodeURIComponent(m[1]!));
      return doc ? jsonResponse(doc) : jsonResponse({ error: { type: 'record-not-found', message: 'no openapi' } }, 404);
    }
    if (req.method === 'GET' && (m = /^\/v2\/actor-builds\/([^/]+)$/.exec(p))) {
      const b = this.builds.get(decodeURIComponent(m[1]!));
      return b ? jsonResponse({ data: b }) : jsonResponse({ error: { type: 'record-not-found', message: 'Build not found' } }, 404);
    }
    if (req.method === 'POST' && (m = /^\/v2\/actors\/([^/]+)\/runs$/.exec(p))) {
      if (this.requireToken && !this.tokenOk(req)) return this.unauthorized(req);
      this.startCount++;
      this.onStart?.(req);
      const b = this.startBehavior;
      if (b.kind === 'http') return jsonResponse({ error: { type: b.type, message: b.message } }, b.status);
      const id = `SYNRUN${String(++this.seq).padStart(11, '0')}`;
      const datasetId = `SYNDS${String(this.seq).padStart(12, '0')}`;
      const kvId = `SYNKV${String(this.seq).padStart(12, '0')}`;
      const run = {
        id,
        actId: ACTOR_ID,
        userId: 'SYNTHETICUSERID01',
        status: 'READY',
        startedAt: '2026-09-24T09:00:01.000Z',
        finishedAt: null,
        buildId: BUILD_ID,
        buildNumber: u.searchParams.get('build'),
        defaultDatasetId: datasetId,
        defaultKeyValueStoreId: kvId,
        defaultRequestQueueId: 'SYNRQ000000000001',
        meta: { origin: 'API' },
        options: {
          build: u.searchParams.get('build'),
          timeoutSecs: Number(u.searchParams.get('timeout')),
          memoryMbytes: Number(u.searchParams.get('memory')),
          maxItems: u.searchParams.has('maxItems') ? Number(u.searchParams.get('maxItems')) : null,
          maxTotalChargeUsd: Number(u.searchParams.get('maxTotalChargeUsd')),
        },
        stats: { inputBodyLen: Buffer.byteLength(req.body ?? '', 'utf8'), restartCount: 0 },
        usageTotalUsd: null,
        chargedEventCounts: null,
      };
      this.runs.set(id, { run, statuses: [...this.nextStatuses], polls: 0, finalFields: { ...this.nextFinalFields } });
      this.datasets.set(datasetId, [...this.nextItems]);
      // The POST body is stored as INPUT in the run's default key-value store (Run Actor docs).
      if (this.storeInputRecord) this.kv.set(kvId, { ...(this.kv.get(kvId) ?? {}), INPUT: JSON.parse(req.body ?? '{}') });
      if (b.kind === 'timeout') {
        if (!b.createRun) {
          this.runs.delete(id);
          this.datasets.delete(datasetId);
          this.kv.delete(kvId);
        }
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      }
      return jsonResponse({ data: run }, 201, { location: `https://api.apify.com/v2/actor-runs/${id}` });
    }
    if (req.method === 'POST' && (m = /^\/v2\/actor-runs\/([^/]+)\/abort$/.exec(p))) {
      const s = this.runs.get(decodeURIComponent(m[1]!));
      if (!s) return jsonResponse({ error: { type: 'record-not-found', message: 'Run not found' } }, 404);
      s.statuses = ['ABORTED'];
      s.polls = 0;
      return jsonResponse({ data: this.currentRun(s, false) });
    }
    if (req.method === 'GET' && (m = /^\/v2\/actor-runs\/([^/]+)$/.exec(p))) {
      const s = this.runs.get(decodeURIComponent(m[1]!));
      if (!s) return jsonResponse({ error: { type: 'record-not-found', message: 'Run not found' } }, 404);
      return jsonResponse({ data: this.currentRun(s, true) });
    }
    if (req.method === 'GET' && (m = /^\/v2\/actors\/([^/]+)\/runs$/.exec(p))) {
      if (this.requireToken && !this.tokenOk(req)) return this.unauthorized(req);
      const all = [
        ...[...this.runs.values()].map((s) => {
          const r = this.currentRun(s, false);
          return { id: r.id, actId: r.actId, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, buildId: r.buildId, buildNumber: r.buildNumber, meta: r.meta, defaultDatasetId: r.defaultDatasetId };
        }),
        ...this.foreignRuns,
      ];
      const offset = Number(u.searchParams.get('offset') ?? 0);
      const limit = Number(u.searchParams.get('limit') ?? 1000);
      const items = all.slice(offset, offset + limit);
      return jsonResponse({ data: { total: all.length, offset, limit, desc: true, count: items.length, items } });
    }
    if (req.method === 'GET' && (m = /^\/v2\/datasets\/([^/]+)\/items$/.exec(p))) {
      const items = this.datasets.get(decodeURIComponent(m[1]!));
      if (!items) return jsonResponse({ error: { type: 'record-not-found', message: 'Dataset not found' } }, 404);
      const offset = Number(u.searchParams.get('offset') ?? 0);
      const limit = u.searchParams.has('limit') ? Number(u.searchParams.get('limit')) : items.length;
      if (this.failDatasetOffsets.has(offset)) return jsonResponse({ error: { type: 'internal-error', message: 'synthetic failure' } }, 500);
      const fields = u.searchParams.get('fields')?.split(',');
      const page = items.slice(offset, offset + limit).map((it) =>
        fields && it && typeof it === 'object' ? Object.fromEntries(Object.entries(it as Record<string, unknown>).filter(([k]) => fields.includes(k))) : it,
      );
      return jsonResponse(page, 200, {
        'x-apify-pagination-offset': String(offset),
        'x-apify-pagination-limit': String(limit),
        'x-apify-pagination-count': String(page.length),
        'x-apify-pagination-total': String(items.length),
        'x-apify-pagination-desc': 'false',
      });
    }
    if (req.method === 'GET' && (m = /^\/v2\/key-value-stores\/([^/]+)\/records\/([^/]+)$/.exec(p))) {
      const rec = this.kv.get(decodeURIComponent(m[1]!))?.[decodeURIComponent(m[2]!)];
      return rec === undefined ? jsonResponse({ error: { type: 'record-not-found', message: 'Record not found' } }, 404) : jsonResponse(rec);
    }
    return undefined;
  }
}
