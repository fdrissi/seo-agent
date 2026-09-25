/**
 * Test helpers for the DataForSEO slice: a stateful FAKE DataForSEO transport
 * (built on tests/helpers/fake-fetch.ts) serving SYNTHETIC fixtures from
 * tests/fixtures/dataforseo, plus context/config builders. No network.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import { fakeFetch, jsonResponse, type RecordedRequest, type Route } from '../../helpers/fake-fetch.js';
import type { SiteConfigInput } from '../../../src/config/site-schema.js';
import type { ApprovalGate, ApprovalRecord, ApprovalRequestInput } from '../../../src/approvals/types.js';
import type { RuntimeMode } from '../../../src/core/modes.js';
import { newId } from '../../../src/core/ids.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, '../../fixtures/dataforseo');

export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as T;
}

export const SYNTHETIC_LOGIN = 'synthetic-login@example.test';
export const SYNTHETIC_PASSWORD = 'synthetic-password-0123456789';
export const SYNTHETIC_TOKEN = Buffer.from(`${SYNTHETIC_LOGIN}:${SYNTHETIC_PASSWORD}`).toString('base64');
export const LOCATION = 9990001;

export function dfsConfig(overrides: Partial<Omit<SiteConfigInput, 'site'>> & { site?: Partial<SiteConfigInput['site']>; dataforseo?: Record<string, unknown>; seriousQueriesPerRun?: number } = {}) {
  const { dataforseo, seriousQueriesPerRun, ...rest } = overrides;
  // testSiteConfig merges a partial `site` over its synthetic defaults.
  return testSiteConfig({
    profile: 'full',
    market: { countries: [], languages: ['en'], searchLocations: [{ name: 'Synthetic Country', locationCode: LOCATION, languageCode: 'en' }], devices: ['desktop', 'mobile'] },
    brand: { aliases: ['testco'] },
    ...rest,
    research: {
      seriousQueriesPerRun: seriousQueriesPerRun ?? 3,
      dataforseo: { mode: 'live', ...(dataforseo ?? {}) },
      ...((rest as { research?: Record<string, unknown> }).research ?? {}),
    } as SiteConfigInput['research'],
  } as Parameters<typeof testSiteConfig>[0]);
}

export function dfsContext(opts: {
  fetch?: ReturnType<typeof fakeFetch>;
  config?: ReturnType<typeof dfsConfig>;
  credentials?: boolean;
  mode?: RuntimeMode;
  dryRun?: boolean;
  now?: string;
} = {}): TestContext {
  return createTestContext({
    config: opts.config ?? dfsConfig(),
    secrets: opts.credentials === false ? {} : { DATAFORSEO_LOGIN: SYNTHETIC_LOGIN, DATAFORSEO_PASSWORD: SYNTHETIC_PASSWORD },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    mode: opts.mode ?? 'RESEARCH',
    ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
}

export type PostBehavior = 'ok' | 'timeout' | 'network_error' | 'http500' | 'task_error' | 'response_error' | 'http401' | 'drop_tasks';

export interface FakeDfsOptions {
  /** Tasks appear in tasks_ready immediately (default true). */
  ready?: boolean;
  postBehavior?: PostBehavior;
  /** Task-level cost reported per created task (USD float). */
  taskCost?: number | null;
  /** Response-level cost; default = sum of task costs. */
  responseCost?: number | null;
  /** Called with the request BEFORE the fake answers a POST (to inspect DB state). */
  onPost?: (req: RecordedRequest) => void;
  onTasksReady?: (req: RecordedRequest) => void;
  /** Include tags in tasks_ready (default true). */
  echoTags?: boolean;
  /** task_get returns 40602 In Queue until setReady(true). */
  pendingUntilReady?: boolean;
  /** Routes tried BEFORE the fake's own routes (to inject errors, e.g. task-level codes inside HTTP 200). */
  before?: Route[];
}

/** A SYNTHETIC envelope: response-level 20000 with ONE task carrying `code` (a task-level error inside HTTP 200 when code != 20000). */
export function taskLevelEnvelope(code: number, message: string, result: unknown[] | null = null, id = '00000000-0000-4000-8000-00000000e001') {
  return { _synthetic: true, version: '0.1.synthetic', status_code: 20000, status_message: 'Ok.', time: '0 sec.', cost: 0, tasks_count: 1, tasks_error: code === 20000 ? 0 : 1, tasks: [{ id, status_code: code, status_message: message, time: '0 sec.', cost: 0, result_count: 0, path: ['v3'], data: {}, result }] };
}

interface Posted {
  id: string;
  endpoint: 'serp' | 'volume';
  task: Record<string, unknown>;
}

let counter = 0;
function remoteId(): string {
  counter++;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

function volumeResults(task: Record<string, unknown>) {
  const data = fixture<{ keywords: Record<string, Record<string, unknown>>; default: Record<string, unknown> }>('search-volume-results.json');
  const kws = Array.isArray(task.keywords) ? (task.keywords as string[]) : [];
  return kws.map((k) => ({ keyword: k, location_code: task.location_code ?? null, language_code: task.language_code ?? null, search_partners: false, ...(data.keywords[k] ?? data.default) }));
}

function serpGet(p: Posted): unknown {
  const text = readFileSync(path.join(FIXTURES, 'serp-task-get-advanced.json'), 'utf8')
    .replaceAll('__TASK_ID__', p.id)
    .replaceAll('__KEYWORD__', decodeURIComponent(String(p.task.keyword ?? '')).replace(/"/g, '\\"'))
    .replaceAll('__TAG__', String(p.task.tag ?? ''));
  return JSON.parse(text);
}

export function fakeDataForSeo(opts: FakeDfsOptions = {}) {
  const posted = new Map<string, Posted>();
  const state = { ready: opts.ready ?? true, postBehavior: opts.postBehavior ?? ('ok' as PostBehavior), posts: 0, taskGets: 0, tasksReadyCalls: 0 };
  const taskCost = opts.taskCost === undefined ? 0.0006 : opts.taskCost;

  const hang = (_req: RecordedRequest, init?: { signal?: AbortSignal | null }) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
    });

  const postRoute = (kind: 'serp' | 'volume', live: boolean): Route => (req) => {
    const isMatch =
      req.method === 'POST' &&
      (kind === 'serp'
        ? req.url.endsWith(live ? '/v3/serp/google/organic/live/advanced' : '/v3/serp/google/organic/task_post')
        : req.url.endsWith(live ? '/v3/keywords_data/google_ads/search_volume/live' : '/v3/keywords_data/google_ads/search_volume/task_post'));
    if (!isMatch) return undefined;
    state.posts++;
    opts.onPost?.(req);
    const body = JSON.parse(req.body ?? '[]') as Array<Record<string, unknown>>;
    switch (state.postBehavior) {
      case 'network_error':
        throw Object.assign(new Error('socket hang up (synthetic)'), { code: 'ECONNRESET' });
      case 'http500':
        return new Response('Internal Server Error (synthetic)', { status: 500 });
      case 'http401':
        return jsonResponse(fixture('unauthorized-401.json'), 401);
      case 'response_error':
        return jsonResponse(fixture('response-error-in-200.json'));
      case 'task_error': {
        const tpl = fixture('task-error-in-200.json');
        tpl.tasks = body.map((t) => ({ ...tpl.tasks[0], id: remoteId(), data: { ...tpl.tasks[0].data, ...t } }));
        return jsonResponse(tpl);
      }
      default:
        break;
    }
    const tasks = body.map((t) => {
      const id = remoteId();
      const p: Posted = { id, endpoint: kind, task: t };
      if (!live) posted.set(id, p);
      const result = live ? (kind === 'serp' ? (serpGet(p) as { tasks: Array<{ result: unknown }> }).tasks[0]!.result : volumeResults(t)) : null;
      return {
        id,
        status_code: live ? 20000 : 20100,
        status_message: live ? 'Ok.' : 'Task Created.',
        time: '0.01 sec.',
        cost: taskCost,
        result_count: live ? 1 : 0,
        path: ['v3'],
        data: { api: kind === 'serp' ? 'serp' : 'keywords_data', function: live ? 'live' : 'task_post', ...t },
        result,
      };
    });
    const visible = state.postBehavior === 'drop_tasks' ? tasks.slice(1) : tasks;
    const sum = taskCost === null ? null : tasks.length * taskCost;
    return jsonResponse({
      _synthetic: true,
      version: '0.1.synthetic',
      status_code: 20000,
      status_message: 'Ok.',
      time: '0.1 sec.',
      cost: opts.responseCost === undefined ? sum : opts.responseCost,
      tasks_count: visible.length,
      tasks_error: 0,
      tasks: visible,
    });
  };

  const readyRoute = (kind: 'serp' | 'volume'): Route => (req) => {
    const suffix = kind === 'serp' ? '/v3/serp/google/organic/tasks_ready' : '/v3/keywords_data/google_ads/search_volume/tasks_ready';
    if (req.method !== 'GET' || !req.url.endsWith(suffix)) return undefined;
    state.tasksReadyCalls++;
    opts.onTasksReady?.(req);
    const result = state.ready
      ? [...posted.values()].filter((p) => p.endpoint === kind).map((p) => ({ id: p.id, se: 'google', se_type: 'organic', date_posted: '2026-09-24 09:00:00 +00:00', tag: opts.echoTags === false ? null : (p.task.tag ?? null), endpoint_advanced: `/v3/serp/google/organic/task_get/advanced/${p.id}` }))
      : [];
    return jsonResponse({ _synthetic: true, status_code: 20000, status_message: 'Ok.', cost: 0, tasks_count: 1, tasks_error: 0, tasks: [{ id: '00000000-0000-4000-8000-0000000ready', status_code: 20000, status_message: 'Ok.', cost: 0, result_count: result.length, result }] });
  };

  const getRoute: Route = (req) => {
    if (req.method !== 'GET') return undefined;
    const m = /\/v3\/(serp\/google\/organic\/task_get\/advanced|keywords_data\/google_ads\/search_volume\/task_get)\/([A-Za-z0-9-]+)$/.exec(req.url);
    if (!m) return undefined;
    state.taskGets++;
    const p = posted.get(m[2]!);
    if (!p) return jsonResponse({ _synthetic: true, status_code: 20000, status_message: 'Ok.', cost: 0, tasks_count: 1, tasks_error: 1, tasks: [{ id: m[2], status_code: 40401, status_message: 'Task Not Found.', cost: 0, result: null }] });
    if (opts.pendingUntilReady && !state.ready) {
      return jsonResponse({ _synthetic: true, status_code: 20000, status_message: 'Ok.', cost: 0, tasks_count: 1, tasks_error: 0, tasks: [{ id: p.id, status_code: 40602, status_message: 'Task In Queue.', cost: 0, result: null }] });
    }
    if (p.endpoint === 'serp') return jsonResponse(serpGet(p));
    return jsonResponse({ _synthetic: true, status_code: 20000, status_message: 'Ok.', cost: 0, tasks_count: 1, tasks_error: 0, tasks: [{ id: p.id, status_code: 20000, status_message: 'Ok.', cost: 0, data: p.task, result: volumeResults(p.task) }] });
  };

  const lookupRoute: Route = (req) => {
    if (req.method !== 'GET') return undefined;
    if (/\/v3\/(serp\/google|keywords_data\/google_ads)\/locations(\/[a-z]{2})?$/.test(req.url)) return jsonResponse(fixture('locations.json'));
    if (/\/v3\/(serp\/google|keywords_data\/google_ads)\/languages$/.test(req.url)) return jsonResponse(fixture('languages.json'));
    if (req.url.endsWith('/v3/appendix/user_data')) return new Response(readFileSync(path.join(FIXTURES, 'user-data.json'), 'utf8').replace('__LOGIN__', SYNTHETIC_LOGIN), { status: 200 });
    return undefined;
  };

  const timeoutRoute: Route = (req) => {
    if (req.method === 'POST' && state.postBehavior === 'timeout') {
      state.posts++;
      opts.onPost?.(req);
      return undefined;
    }
    return undefined;
  };

  const base = fakeFetch([...(opts.before ?? []), postRoute('serp', false), postRoute('serp', true), postRoute('volume', false), postRoute('volume', true), readyRoute('serp'), readyRoute('volume'), getRoute, lookupRoute]);
  // Wrap to support hanging (timeout) POSTs that honour the abort signal.
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET').toUpperCase() === 'POST' && state.postBehavior === 'timeout') {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      const req: RecordedRequest = { url: String(input), method: 'POST', headers, body: typeof init?.body === 'string' ? init.body : null };
      base.calls.push(req);
      timeoutRoute(req);
      return hang(req, init ?? {});
    }
    return base(input, init);
  }) as ReturnType<typeof fakeFetch>;
  fetchFn.calls = base.calls;
  return {
    fetch: fetchFn,
    state,
    posted,
    setReady(v: boolean) {
      state.ready = v;
    },
    setPostBehavior(b: PostBehavior) {
      state.postBehavior = b;
    },
    postCalls: () => base.calls.filter((c) => c.method === 'POST'),
  };
}

/** Fast fake sleep that advances the test clock instead of waiting. */
export function clockSleep(ctx: TestContext) {
  return async (ms: number) => {
    ctx.clock.advanceMs(ms);
  };
}

/** Insert a synthetic, current GSC page/query row so the query counts as part of the GSC shortlist. */
export function insertGscQuery(ctx: TestContext, query: string, opts: { impressions?: number; isSynthetic?: boolean } = {}): void {
  const now = ctx.clock.now().toISOString();
  const batch = ctx.db.get<{ id: string }>('SELECT id FROM ingestion_batches WHERE site_id = ? LIMIT 1', [ctx.siteId])?.id ?? newId('batch');
  ctx.db.run(
    `INSERT OR IGNORE INTO ingestion_batches (id, site_id, source, dataset, property, date_start, date_end, request_json, status, transformation_version, is_synthetic, started_at)
     VALUES (?, ?, 'gsc', 'gsc_page_query_daily', 'sc-domain:example.test', '2026-09-01', '2026-09-20', '{}', 'succeeded', 'test@1', 1, ?)`,
    [batch, ctx.siteId, now],
  );
  ctx.db.run(
    `INSERT INTO gsc_page_query_daily (site_id, property, search_type, date, date_tz, page, query, clicks, impressions, ctr, position, aggregation_type, is_final, revision, is_current, row_hash, batch_id, collected_at, transformation_version, is_synthetic)
     VALUES (?, 'sc-domain:example.test', 'web', '2026-09-20', 'America/Los_Angeles', 'https://www.example.test/pricing', ?, 3, ?, 0.01, 8.5, 'byPage', 1, 1, 1, ?, ?, ?, 'test@1', ?)`,
    [ctx.siteId, query, opts.impressions ?? 300, `h-${query}`, batch, now, opts.isSynthetic ? 1 : 0],
  );
}

/** In-memory ApprovalGate fake (the real approvals module is another slice). */
export function fakeApprovals(opts: { autoApprove?: boolean } = {}): ApprovalGate & { records: ApprovalRecord[]; approve(id: string): void; consumed: string[] } {
  const records: ApprovalRecord[] = [];
  const consumed: string[] = [];
  const find = (i: { siteId: string; actionType: string; subjectType: string; subjectId: string; artifactHash: string }) =>
    records.find((r) => r.siteId === i.siteId && r.actionType === i.actionType && r.subjectType === i.subjectType && r.subjectId === i.subjectId && r.artifactHash === i.artifactHash && (r.status === 'pending' || r.status === 'approved'));
  return {
    records,
    consumed,
    approve(id: string) {
      const r = records.find((x) => x.id === id)!;
      Object.assign(r, { status: 'approved', approver: 'owner:test', decidedAt: '2026-09-24T09:00:00.000Z' });
    },
    request(input: ApprovalRequestInput): ApprovalRecord {
      const existing = find(input);
      if (existing) return existing;
      const rec: ApprovalRecord = {
        id: newId('appr'),
        siteId: input.siteId,
        actionType: input.actionType,
        target: input.target,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        artifactHash: input.artifactHash,
        sourceRevision: input.sourceRevision ?? null,
        summary: input.summary,
        status: opts.autoApprove ? 'approved' : 'pending',
        requestedBy: input.requestedBy,
        requestedAt: '2026-09-24T09:00:00.000Z',
        approver: opts.autoApprove ? 'owner:test' : null,
        decidedAt: opts.autoApprove ? '2026-09-24T09:00:00.000Z' : null,
        expiresAt: '2026-10-24T09:00:00.000Z',
        executedAt: null,
      };
      records.push(rec);
      return rec;
    },
    check(input) {
      const r = find(input);
      if (!r) return { ok: false, reason: 'none' };
      if (r.status !== 'approved') return { ok: false, reason: 'pending', approval: r };
      return { ok: true, approval: r };
    },
    consume(id: string) {
      const r = records.find((x) => x.id === id);
      if (!r || r.status !== 'approved') throw new Error('not approved');
      r.status = 'executed';
      r.executedAt = '2026-09-24T09:00:00.000Z';
      consumed.push(id);
      return r;
    },
  };
}
