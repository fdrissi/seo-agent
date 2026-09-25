import { hashObject } from '../../core/hash.js';
import type { FetchLike } from '../types.js';

/**
 * SYNTHETIC fixture transport for the offline demo and tests. It mimics the
 * DataForSEO envelope shapes documented in docs/integration-contracts.md
 * section 6 with clearly labeled fake data on reserved example domains. It is
 * never a live measurement: results produced through it are flagged
 * is_sandbox = 1 (use client mode 'fixture'). No network access, no credentials.
 */

export interface SyntheticDataForSeoOptions {
  /** Own-site URL to place in synthetic SERPs (e.g. a demo page on a reserved domain). */
  ownUrl?: string | null;
  /** 1-based organic rank for ownUrl; null/undefined = not present. */
  ownRank?: number | null;
  /** Number of synthetic organic results per SERP (default 10). */
  results?: number;
}

function envelope(tasks: unknown[], extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ _synthetic: true, version: 'synthetic', status_code: 20000, status_message: 'Ok. (synthetic fixture)', time: '0 sec.', cost: 0, tasks_count: tasks.length, tasks_error: 0, tasks, ...extra }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function syntheticId(seed: unknown): string {
  const h = hashObject(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'topic';
}

export function syntheticSerpResult(task: Record<string, unknown>, opts: SyntheticDataForSeoOptions = {}): Record<string, unknown> {
  const keyword = decodeURIComponent(String(task.keyword ?? 'synthetic query'));
  const n = opts.results ?? 10;
  const items: Array<Record<string, unknown>> = [];
  let rank = 1;
  for (let i = 1; rank <= n; i++) {
    if (opts.ownUrl && opts.ownRank === rank) {
      const host = new URL(opts.ownUrl).hostname;
      items.push({ type: 'organic', rank_group: rank, rank_absolute: rank, domain: host, url: opts.ownUrl, title: `[SYNTHETIC] Own page for "${keyword}"`, description: 'Synthetic fixture result.' });
    } else {
      items.push({
        type: 'organic',
        rank_group: rank,
        rank_absolute: rank,
        domain: `competitor-${i}.example`,
        url: `https://competitor-${i}.example/${slug(keyword)}`,
        title: `[SYNTHETIC] Result ${i} for "${keyword}"`,
        description: 'Synthetic fixture result on a reserved example domain.',
      });
    }
    rank++;
  }
  return {
    keyword,
    type: 'organic',
    se_domain: 'google.example',
    location_code: task.location_code ?? null,
    language_code: task.language_code ?? null,
    check_url: null,
    datetime: '2026-01-01 00:00:00 +00:00',
    item_types: ['organic'],
    se_results_count: null,
    items_count: items.length,
    items,
  };
}

export function syntheticVolumeResult(task: Record<string, unknown>): Array<Record<string, unknown>> {
  const keywords = Array.isArray(task.keywords) ? task.keywords.map(String) : [];
  return keywords.map((k) => {
    const h = parseInt(hashObject(k).slice(0, 6), 16);
    return {
      keyword: k,
      location_code: task.location_code ?? null,
      language_code: task.language_code ?? null,
      search_partners: false,
      competition: null,
      competition_index: h % 101,
      search_volume: (h % 50) * 10,
      monthly_searches: null,
    };
  });
}

/** Build a fixture FetchLike. Pair with `createDataForSeoClient(ctx, { mode: 'fixture', fetch })`. */
export function createSyntheticDataForSeoFetch(opts: SyntheticDataForSeoOptions = {}): FetchLike {
  const posted = new Map<string, { kind: 'serp' | 'volume'; task: Record<string, unknown> }>();
  return async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v3\//, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Array<Record<string, unknown>>) : [];
    const created = (kind: 'serp' | 'volume', path: string) =>
      body.map((t) => {
        const id = syntheticId({ kind, t });
        posted.set(id, { kind, task: t });
        return { id, status_code: 20100, status_message: 'Task Created. (synthetic)', time: '0 sec.', cost: 0, result_count: 0, path: path.split('/'), data: { ...t }, result: null };
      });
    if (method === 'POST' && path === 'serp/google/organic/task_post') return envelope(created('serp', path));
    if (method === 'POST' && path === 'keywords_data/google_ads/search_volume/task_post') return envelope(created('volume', path));
    if (method === 'POST' && path === 'serp/google/organic/live/advanced') {
      const t = body[0] ?? {};
      return envelope([{ id: syntheticId({ live: t }), status_code: 20000, status_message: 'Ok. (synthetic)', cost: 0, data: t, result: [syntheticSerpResult(t, opts)] }]);
    }
    if (method === 'POST' && path === 'keywords_data/google_ads/search_volume/live') {
      const t = body[0] ?? {};
      return envelope([{ id: syntheticId({ live: t }), status_code: 20000, status_message: 'Ok. (synthetic)', cost: 0, data: t, result: syntheticVolumeResult(t) }]);
    }
    const kindFor = (p: string): 'serp' | 'volume' | null => (p.startsWith('serp/google/organic/') ? 'serp' : p.startsWith('keywords_data/google_ads/search_volume/') ? 'volume' : null);
    if (method === 'GET' && path.endsWith('/tasks_ready')) {
      const kind = kindFor(path);
      const result = [...posted.entries()].filter(([, v]) => v.kind === kind).map(([id, v]) => ({ id, tag: v.task.tag ?? null, date_posted: '2026-01-01 00:00:00 +00:00' }));
      return envelope([{ id: syntheticId({ ready: path }), status_code: 20000, status_message: 'Ok.', cost: 0, result_count: result.length, result }]);
    }
    const get = /^(serp\/google\/organic\/task_get\/advanced|keywords_data\/google_ads\/search_volume\/task_get)\/([A-Za-z0-9-]+)$/.exec(path);
    if (method === 'GET' && get) {
      const entry = posted.get(get[2]!);
      if (!entry) return envelope([{ id: get[2], status_code: 40401, status_message: 'Task Not Found. (synthetic)', cost: 0, result: null }]);
      const result = entry.kind === 'serp' ? [syntheticSerpResult(entry.task, opts)] : syntheticVolumeResult(entry.task);
      return envelope([{ id: get[2], status_code: 20000, status_message: 'Ok. (synthetic)', cost: 0, data: entry.task, result }]);
    }
    if (method === 'GET' && path === 'appendix/user_data') return envelope([{ id: 'synthetic', status_code: 20000, status_message: 'Ok.', cost: 0, result: [{ login: 'synthetic', money: { balance: null } }] }]);
    return new Response(JSON.stringify({ _synthetic: true, status_code: 40400, status_message: 'Not Found. (synthetic)', tasks: [] }), { status: 404, headers: { 'content-type': 'application/json' } });
  };
}
