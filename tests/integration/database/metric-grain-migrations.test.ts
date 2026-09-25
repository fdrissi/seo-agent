import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appDirs } from '../../../src/config/paths.js';
import { openDatabase, type Db } from '../../../src/database/db.js';
import { migrate } from '../../../src/database/migrate.js';

/**
 * Forward migrations 0200-0203 on a database that already holds rows written
 * before them (SYNTHETIC data, example.test domains only): duplicates of the
 * new grains are removed with references re-pointed, provenance columns are
 * added, the activation history is back-filled, and duplicate keyword rows
 * (NULL language vs research language) are merged.
 */

const T = '2026-09-24T09:00:00.000Z';
let dir: string;
let db: Db;

/** Apply every application migration numbered below 0200 (the schema these rows were written with). */
function migrateBefore0200(): void {
  const partial = path.join(dir, 'before-0200');
  mkdirSync(partial);
  for (const f of readdirSync(appDirs.migrations()).filter((x) => /^\d{4}_[a-z0-9_]+\.sql$/.test(x) && x < '0200')) copyFileSync(path.join(appDirs.migrations(), f), path.join(partial, f));
  migrate(db, { dir: partial });
}

function site(id: string, config: Record<string, unknown>, extra: { activeVersion?: number; versions?: Array<{ v: number; at: string }> } = {}): void {
  db.run('INSERT INTO sites (id, name, base_url, is_demo, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)', [id, 'Synthetic Co', 'https://www.example.test/', T, '2026-09-20T00:00:00.000Z']);
  const versions = extra.versions ?? [{ v: 1, at: T }];
  for (const { v, at } of versions) {
    db.run("INSERT INTO config_versions (id, site_id, version, config_hash, config_json, source, created_at) VALUES (?, ?, ?, ?, ?, 'file', ?)", [`cfg_${id}_${v}`, id, v, `hash_${v}`, JSON.stringify({ ...config, v }), at]);
  }
  db.run('UPDATE sites SET active_config_version = ? WHERE id = ?', [extra.activeVersion ?? versions.at(-1)!.v, id]);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-mig0200-'));
  db = openDatabase(path.join(dir, 'db.sqlite'));
  migrateBefore0200();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('0200_metric_grains on existing rows', () => {
  it('removes duplicate observations, keeps the earliest, and re-points cache references', () => {
    site('s1', { market: { languages: ['en'] } });
    db.run("INSERT INTO keywords (id, site_id, keyword, normalized, language, first_seen_at) VALUES ('kw1', 's1', 'synthetic widgets', 'synthetic widgets', NULL, ?)", [T]);
    // The same DataForSEO task stored twice (crash between store and 'fetched').
    for (const [id, at] of [['snap_a', '2026-09-24T09:00:00.000Z'], ['snap_b', '2026-09-24T09:05:00.000Z']] as const) {
      db.run("INSERT INTO serp_snapshots (id, site_id, keyword_id, query, provider, device, parameter_hash, is_sandbox, dataforseo_task_id, collected_at) VALUES (?, 's1', 'kw1', 'synthetic widgets', 'dataforseo', 'desktop', 'h', 1, 'dfs_1', ?)", [id, at]);
      db.run("INSERT INTO serp_results (snapshot_id, site_id, result_type, rank_absolute, url, is_own_site) VALUES (?, 's1', 'organic', 1, 'https://a.example.invalid/', 0)", [id]);
      db.run("INSERT INTO rankings (id, site_id, keyword_id, snapshot_id, rank_absolute, observed_at) VALUES (?, 's1', 'kw1', ?, NULL, ?)", [`rank_${id}`, id, at]);
    }
    db.run("INSERT INTO research_cache (cache_key, site_id, provider, endpoint, parameter_hash, payload_ref, is_sandbox, created_at, expires_at) VALUES ('c1', 's1', 'dataforseo', 'serp', 'h', 'db:serp_snapshots:snap_b', 1, ?, ?)", [T, T]);
    for (const id of ['m1', 'm2']) {
      db.run("INSERT INTO keyword_metrics (id, site_id, keyword_id, provider, location_code, language_code, search_volume, is_sandbox, collected_at, expires_at) VALUES (?, 's1', 'kw1', 'dataforseo', NULL, 'en', 10, 1, ?, ?)", [id, T, T]);
    }
    db.run("INSERT INTO research_cache (cache_key, site_id, provider, endpoint, parameter_hash, payload_ref, is_sandbox, created_at, expires_at) VALUES ('c2', 's1', 'dataforseo', 'volume', 'h2', 'db:keyword_metrics:m2', 1, ?, ?)", [T, T]);
    for (const id of ['i1', 'i2']) db.run("INSERT INTO url_inspections (id, site_id, property, url, is_synthetic, inspected_at) VALUES (?, 's1', 'sc-domain:example.test', 'https://www.example.test/', 1, ?)", [id, T]);
    for (const id of ['p1', 'p2']) db.run("INSERT INTO performance_checks (id, site_id, url, source, data_kind, device, metrics_json, cache_key, is_synthetic, checked_at) VALUES (?, 's1', 'https://www.example.test/', 'psi_lab', 'lab', 'mobile', '{}', 'k', 1, ?)", [id, T]);

    migrate(db);
    expect(db.all('SELECT id FROM serp_snapshots ORDER BY id')).toEqual([{ id: 'snap_a' }]);
    expect(db.all('SELECT snapshot_id FROM serp_results')).toEqual([{ snapshot_id: 'snap_a' }]);
    expect(db.all('SELECT snapshot_id FROM rankings')).toEqual([{ snapshot_id: 'snap_a' }]);
    expect(db.get("SELECT payload_ref FROM research_cache WHERE cache_key = 'c1'")).toEqual({ payload_ref: 'db:serp_snapshots:snap_a' });
    expect(db.all('SELECT id FROM keyword_metrics')).toEqual([{ id: 'm1' }]);
    expect(db.get("SELECT payload_ref FROM research_cache WHERE cache_key = 'c2'")).toEqual({ payload_ref: 'db:keyword_metrics:m1' });
    expect(db.all('SELECT id FROM url_inspections')).toEqual([{ id: 'i1' }]);
    expect(db.all('SELECT id FROM performance_checks')).toEqual([{ id: 'p1' }]);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
  });
});

describe('0201_observation_provenance on existing rows', () => {
  it('adds provenance columns (unknown stays NULL) and back-fills the CrUX collection period', () => {
    site('s1', {});
    const crux = { record: { collectionPeriod: { firstDate: '2026-08-25', lastDate: '2026-09-21' } }, _synthetic: true };
    db.run("INSERT INTO performance_checks (id, site_id, url, source, data_kind, field_scope, device, metrics_json, cache_key, is_synthetic, checked_at) VALUES ('p1', 's1', 'https://www.example.test/', 'crux_api', 'field', 'page', 'phone', ?, 'k', 1, ?)", [JSON.stringify(crux), T]);
    db.run("INSERT INTO performance_checks (id, site_id, url, source, data_kind, field_scope, device, metrics_json, cache_key, is_synthetic, checked_at) VALUES ('p2', 's1', 'https://www.example.test/', 'psi_field', 'field', 'page', 'mobile', '{}', 'k2', 1, ?)", [T]);
    migrate(db);
    expect(db.all('SELECT id, date_range_start, date_range_end FROM performance_checks ORDER BY id')).toEqual([
      { id: 'p1', date_range_start: '2026-08-25', date_range_end: '2026-09-21' },
      { id: 'p2', date_range_start: null, date_range_end: null },
    ]);
    for (const [t, c] of [
      ['crawl_results', 'transformation_version'],
      ['crawl_results', 'raw_ref'],
      ['url_inspections', 'transformation_version'],
      ['technical_issues', 'transformation_version'],
      ['keyword_metrics', 'transformation_version'],
      ['serp_snapshots', 'transformation_version'],
    ] as const) {
      expect(db.all<{ name: string }>('SELECT name FROM pragma_table_info(?)', [t]).map((x) => x.name), `${t}.${c}`).toContain(c);
    }
  });
});

describe('0202_config_activations back-fill', () => {
  it('reconstructs activations, including an earlier return to an older configuration', () => {
    site('s1', {}, { versions: [{ v: 1, at: '2026-09-01T00:00:00.000Z' }, { v: 2, at: '2026-09-10T00:00:00.000Z' }], activeVersion: 1 });
    site('s2', {}, { versions: [{ v: 1, at: '2026-09-05T00:00:00.000Z' }] });
    migrate(db);
    expect(db.all("SELECT version, previous_version, source, activated_at FROM config_activations WHERE site_id = 's1' ORDER BY activated_at")).toEqual([
      { version: 1, previous_version: null, source: 'file', activated_at: '2026-09-01T00:00:00.000Z' },
      { version: 2, previous_version: 1, source: 'file', activated_at: '2026-09-10T00:00:00.000Z' },
      { version: 1, previous_version: 2, source: 'migration', activated_at: '2026-09-20T00:00:00.000Z' },
    ]);
    expect(db.all("SELECT version FROM config_activations WHERE site_id = 's2'")).toEqual([{ version: 1 }]);
  });
});

describe('0203_keyword_language_dedup', () => {
  it('merges the research-language duplicate into the language-less row and re-points children', () => {
    site('s1', { market: { languages: ['en-US'], searchLocations: [] } });
    const kw = (id: string, normalized: string, language: string | null, extra: { intent?: string; origins?: string[]; at?: string } = {}) =>
      db.run('INSERT INTO keywords (id, site_id, keyword, normalized, language, intent, intent_source, first_seen_at, origins_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        id,
        's1',
        normalized,
        normalized,
        language,
        extra.intent ?? null,
        extra.intent ? 'rule' : null,
        extra.at ?? T,
        JSON.stringify(extra.origins ?? []),
      ]);
    kw('k_gsc', 'buy widgets online', null, { intent: 'transactional', origins: ['gsc'], at: '2026-09-02T00:00:00.000Z' });
    kw('k_en', 'buy widgets online', 'en', { origins: ['dataforseo_serp'], at: '2026-09-01T00:00:00.000Z' });
    // Three languages for one query: only the primary-market one is merged; 'de' stays a separate keyword.
    kw('k2_null', 'widget', null, { origins: ['gsc'] });
    kw('k2_en', 'widget', 'en', { origins: ['dataforseo_volume'] });
    kw('k2_de', 'widget', 'de', { origins: ['dataforseo_volume'] });
    // No language-less row: nothing to merge.
    kw('k3_de', 'nur deutsch', 'de');
    db.run("INSERT INTO serp_snapshots (id, site_id, keyword_id, query, provider, language_code, device, parameter_hash, is_sandbox, dataforseo_task_id, collected_at) VALUES ('snap1', 's1', 'k_en', 'buy widgets online', 'dataforseo', 'en', 'desktop', 'h', 0, 'dfs_1', ?)", [T]);
    db.run("INSERT INTO rankings (id, site_id, keyword_id, snapshot_id, rank_absolute, observed_at) VALUES ('r1', 's1', 'k_en', 'snap1', 4, ?)", [T]);
    db.run("INSERT INTO keyword_metrics (id, site_id, keyword_id, provider, location_code, language_code, search_volume, is_sandbox, collected_at, expires_at) VALUES ('m1', 's1', 'k_en', 'dataforseo', 2840, 'en', 30, 0, ?, ?)", [T, T]);
    db.run("INSERT INTO keyword_metrics (id, site_id, keyword_id, provider, location_code, language_code, search_volume, is_sandbox, collected_at, expires_at) VALUES ('m2', 's1', 'k2_en', 'dataforseo', 2840, 'en', 90, 0, ?, ?)", [T, T]);

    migrate(db);
    expect(db.all("SELECT id, language FROM keywords WHERE site_id = 's1' ORDER BY id")).toEqual([
      { id: 'k2_de', language: 'de' },
      { id: 'k2_null', language: null },
      { id: 'k3_de', language: 'de' },
      { id: 'k_gsc', language: null },
    ]);
    const merged = db.get<{ origins_json: string; intent: string; first_seen_at: string }>("SELECT origins_json, intent, first_seen_at FROM keywords WHERE id = 'k_gsc'")!;
    expect(JSON.parse(merged.origins_json).sort()).toEqual(['dataforseo_serp', 'gsc']);
    expect(merged.intent).toBe('transactional');
    expect(merged.first_seen_at).toBe('2026-09-01T00:00:00.000Z');
    expect(db.get("SELECT keyword_id, language_code FROM serp_snapshots WHERE id = 'snap1'")).toEqual({ keyword_id: 'k_gsc', language_code: 'en' });
    expect(db.get("SELECT keyword_id FROM rankings WHERE id = 'r1'")).toEqual({ keyword_id: 'k_gsc' });
    expect(db.all('SELECT id, keyword_id FROM keyword_metrics ORDER BY id')).toEqual([
      { id: 'm1', keyword_id: 'k_gsc' },
      { id: 'm2', keyword_id: 'k2_null' },
    ]);
    const audit = db.get<{ details_json: string }>("SELECT details_json FROM audit_events WHERE site_id = 's1' AND event_type = 'keywords.language_duplicates_merged'")!;
    expect(JSON.parse(audit.details_json)).toMatchObject({ mergedRows: 2 });
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
  });
});
