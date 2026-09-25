import { afterEach, describe, expect, it } from 'vitest';
import { processFetchedTask } from '../../../src/integrations/dataforseo/tasks.js';
import { primaryMarketLanguage, SERP_TRANSFORMATION_VERSION, storeSerpObservation, upsertKeyword, VOLUME_TRANSFORMATION_VERSION } from '../../../src/integrations/dataforseo/store.js';
import type { DfsTask } from '../../../src/integrations/dataforseo/envelope.js';
import type { TaskMeta, TaskRow } from '../../../src/integrations/dataforseo/types.js';
import type { TestContext } from '../../helpers/context.js';
import { dfsConfig, dfsContext, LOCATION } from '../../integration/dataforseo/helpers.js';

/** SYNTHETIC keywords and responses (example.test / example.invalid domains only). */
let ctx: TestContext;
afterEach(() => ctx?.cleanup());

const T = '2026-09-24T09:00:00.000Z';

function keywordRows() {
  return ctx.db.all<{ id: string; normalized: string; language: string | null; origins_json: string }>('SELECT id, normalized, language, origins_json FROM keywords WHERE site_id = ? ORDER BY normalized, id', [ctx.siteId]);
}

function taskRow(id: string, meta: TaskMeta): TaskRow {
  ctx.db.run(
    `INSERT INTO dataforseo_tasks (id, site_id, endpoint, remote_task_id, parameter_hash, params_json, status, is_sandbox, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ready', 1, ?, ?)`,
    [id, ctx.siteId, meta.kind === 'serp' ? 'serp/google/organic/task_post' : 'keywords_data/google_ads/search_volume/task_post', `remote_${id}`, `hash_${id}`, JSON.stringify({ task: {}, meta }), T, T],
  );
  return ctx.db.get<TaskRow>('SELECT * FROM dataforseo_tasks WHERE id = ?', [id])!;
}

describe('keyword rows: one per query across Search Console and research languages', () => {
  it('reuses the language-less (Search Console) row for research in any language and leaves its language alone', () => {
    ctx = dfsContext();
    // Search Console / router rows carry no language.
    ctx.db.run("INSERT INTO keywords (id, site_id, keyword, normalized, language, first_seen_at, origins_json) VALUES ('kw_gsc', ?, 'buy widgets online', 'buy widgets online', NULL, ?, '[\"gsc\"]')", [ctx.siteId, T]);
    expect(upsertKeyword(ctx, { keyword: 'Buy  Widgets Online', language: 'en', origin: 'dataforseo_serp' })).toBe('kw_gsc');
    expect(upsertKeyword(ctx, { keyword: 'buy widgets online', language: 'de', origin: 'dataforseo_volume' })).toBe('kw_gsc');
    expect(keywordRows()).toEqual([{ id: 'kw_gsc', normalized: 'buy widgets online', language: null, origins_json: JSON.stringify(['gsc', 'dataforseo_serp', 'dataforseo_volume']) }]);
  });

  it('stores a new query in the primary market language without a language, other languages with theirs', () => {
    ctx = dfsContext();
    expect(primaryMarketLanguage(ctx)).toBe('en');
    const en = upsertKeyword(ctx, { keyword: 'synthetic widget pricing', language: 'en', origin: 'dataforseo_serp' });
    const de = upsertKeyword(ctx, { keyword: 'synthetische preise', language: 'de', origin: 'dataforseo_serp' });
    expect(keywordRows().map((k) => [k.normalized, k.language])).toEqual([
      ['synthetic widget pricing', null],
      ['synthetische preise', 'de'],
    ]);
    // Later lookups (Search Console without a language, research with one) land on the same rows.
    expect(upsertKeyword(ctx, { keyword: 'synthetic widget pricing', language: null, origin: 'gsc' })).toBe(en);
    expect(upsertKeyword(ctx, { keyword: 'synthetic widget pricing', language: 'en-US', origin: 'dataforseo_volume' })).toBe(en);
    expect(upsertKeyword(ctx, { keyword: 'synthetische preise', language: 'de', origin: 'dataforseo_volume' })).toBe(de);
    expect(upsertKeyword(ctx, { keyword: 'synthetische preise', language: null, origin: 'gsc' })).toBe(de);
    expect(keywordRows()).toHaveLength(2);
  });

  it('without a configured market language the request language is kept', () => {
    ctx = dfsContext({ config: dfsConfig({ market: { countries: [], languages: [], searchLocations: [], devices: ['desktop'] } }) });
    expect(primaryMarketLanguage(ctx)).toBeNull();
    upsertKeyword(ctx, { keyword: 'synthetic widgets', language: 'en', origin: 'dataforseo_serp' });
    expect(keywordRows().map((k) => k.language)).toEqual(['en']);
  });
});

describe('DataForSEO observations: provenance and idempotent storage', () => {
  const serpTask = (): DfsTask => ({
    id: 'remote_t1',
    status_code: 20000,
    status_message: 'Ok.',
    result: [{ keyword: 'synthetic widget pricing', location_code: LOCATION, language_code: 'en', datetime: '2026-09-24 08:00:00 +00:00', items: [{ type: 'organic', rank_group: 1, rank_absolute: 1, url: 'https://a.example.invalid/w', domain: 'a.example.invalid', title: 'Synthetic' }] }],
  });

  it('a SERP task yields one snapshot with its transformation version, even when processed twice', () => {
    ctx = dfsContext();
    const meta: TaskMeta = { kind: 'serp', mode: 'sandbox', queue: 'standard', purpose: 'test', runId: 'run_1', query: 'synthetic widget pricing', locationCode: LOCATION, languageCode: 'en', device: 'desktop', depth: 10 };
    const row = taskRow('t1', meta);
    const first = processFetchedTask(ctx, row, serpTask(), 'raw:test-site/dataforseo/2026-09-24/task-get-a.json');
    expect(ctx.db.get<{ status: string }>("SELECT status FROM dataforseo_tasks WHERE id = 't1'")!.status).toBe('fetched');
    const again = storeSerpObservation(ctx, { taskRow: row, meta, task: serpTask(), rawRef: 'raw:test-site/dataforseo/2026-09-24/task-get-b.json', partial: false, noResults: false });
    expect(again.snapshotId).toBe(first.snapshotId);
    expect(ctx.db.all('SELECT transformation_version FROM serp_snapshots WHERE site_id = ?', [ctx.siteId])).toEqual([{ transformation_version: SERP_TRANSFORMATION_VERSION }]);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM serp_results WHERE site_id = ?', [ctx.siteId])!.n).toBe(1);
  });

  it('volume rows record their transformation version; a duplicate keyword or a re-processed response adds nothing', () => {
    ctx = dfsContext();
    const meta: TaskMeta = { kind: 'volume', mode: 'sandbox', queue: 'standard', purpose: 'test', runId: 'run_1', keywords: ['synthetic widgets'], locationCode: LOCATION, languageCode: 'en', device: null };
    const row = taskRow('t2', meta);
    const task: DfsTask = {
      id: 'remote_t2',
      status_code: 20000,
      status_message: 'Ok.',
      result: [
        { keyword: 'synthetic widgets', location_code: LOCATION, language_code: 'en', search_volume: 40, competition_index: 20 },
        { keyword: 'Synthetic Widgets', location_code: LOCATION, language_code: 'en', search_volume: 40, competition_index: 20 },
      ],
    };
    const raw = 'raw:test-site/dataforseo/2026-09-24/task-get-v.json';
    const first = processFetchedTask(ctx, row, task, raw);
    expect(first.metricIds).toHaveLength(1);
    const second = processFetchedTask(ctx, row, task, raw);
    expect(second.metricIds).toEqual(first.metricIds);
    expect(ctx.db.all('SELECT transformation_version, search_volume FROM keyword_metrics WHERE site_id = ?', [ctx.siteId])).toEqual([{ transformation_version: VOLUME_TRANSFORMATION_VERSION, search_volume: 40 }]);
  });

  it('storing and marking the task fetched are one transaction: a failure while marking it stores nothing', () => {
    ctx = dfsContext();
    const meta: TaskMeta = { kind: 'serp', mode: 'sandbox', queue: 'standard', purpose: 'test', runId: 'run_1', query: 'synthetic widget pricing', locationCode: LOCATION, languageCode: 'en', device: 'desktop', depth: 10 };
    const row = taskRow('t3', meta);
    // Simulate a crash AFTER the observation was stored, while the task is being marked 'fetched'.
    ctx.db.exec("CREATE TEMP TRIGGER fail_mark_fetched BEFORE UPDATE ON dataforseo_tasks WHEN NEW.status = 'fetched' BEGIN SELECT RAISE(ABORT, 'synthetic crash while marking fetched'); END");
    expect(() => processFetchedTask(ctx, row, serpTask(), 'raw:test-site/dataforseo/2026-09-24/task-get-c.json')).toThrow(/synthetic crash/);
    ctx.db.exec('DROP TRIGGER fail_mark_fetched');
    // Neither the observation nor the status change survived: a later poll stores it exactly once.
    expect(ctx.db.get<{ status: string }>("SELECT status FROM dataforseo_tasks WHERE id = 't3'")!.status).toBe('ready');
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM serp_snapshots WHERE site_id = ?', [ctx.siteId])!.n).toBe(0);
    processFetchedTask(ctx, row, serpTask(), 'raw:test-site/dataforseo/2026-09-24/task-get-c.json');
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM serp_snapshots WHERE site_id = ?', [ctx.siteId])!.n).toBe(1);
  });
});
