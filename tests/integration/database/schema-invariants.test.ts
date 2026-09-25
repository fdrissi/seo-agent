import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listAudit, recordAudit } from '../../../src/database/audit.js';
import { RawStore } from '../../../src/database/raw-store.js';
import { parseSiteConfig } from '../../../src/config/site-schema.js';
import { configActivations, configVersionActiveAt, ensureSite } from '../../../src/database/sites.js';
import { REDACTED, registerSecret } from '../../../src/security/redact.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';

let ctx: TestContext;
beforeEach(() => {
  ctx = createTestContext();
});
afterEach(() => ctx.cleanup());

const NOW = '2026-09-24T09:00:00.000Z';

function insertBatch(id: string): void {
  ctx.db.run(
    `INSERT INTO ingestion_batches (id, site_id, source, dataset, property, date_start, date_end, request_json, status, transformation_version, is_synthetic, started_at)
     VALUES (?, ?, 'gsc', 'gsc_property_daily', 'sc-domain:example.test', '2026-09-01', '2026-09-01', '{}', 'succeeded', 't1', 1, ?)`,
    [id, ctx.siteId, NOW],
  );
}

function insertPropertyDay(revision: number, isCurrent: 0 | 1, clicks: number): void {
  ctx.db.run(
    `INSERT INTO gsc_property_daily (site_id, property, search_type, date, date_tz, clicks, impressions, aggregation_type, is_final, revision, is_current, row_hash, batch_id, collected_at, transformation_version, is_synthetic)
     VALUES (?, 'sc-domain:example.test', 'web', '2026-09-01', 'America/Los_Angeles', ?, 100, 'byProperty', 1, ?, ?, ?, 'batch_1', ?, 't1', 1)`,
    [ctx.siteId, clicks, revision, isCurrent, `hash-${revision}`, NOW],
  );
}

describe('append-only history', () => {
  it('audit_events rejects UPDATE and DELETE', () => {
    recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'test', eventType: 'x.created' });
    expect(() => ctx.db.run("UPDATE audit_events SET actor = 'attacker'")).toThrow(/append-only/);
    expect(() => ctx.db.run('DELETE FROM audit_events')).toThrow(/append-only/);
    expect(listAudit(ctx.db, ctx.siteId).some((e) => e.event_type === 'x.created')).toBe(true);
  });

  it('reports cannot be rewritten after generation', () => {
    ctx.db.run(
      `INSERT INTO reports (id, site_id, kind, content_hash, is_synthetic, generated_at) VALUES ('rpt_1', ?, 'weekly', 'h1', 1, ?)`,
      [ctx.siteId, NOW],
    );
    expect(() => ctx.db.run("UPDATE reports SET content_hash = 'h2' WHERE id = 'rpt_1'")).toThrow(/append-only/);
    expect(ctx.db.get<{ content_hash: string }>("SELECT content_hash FROM reports WHERE id = 'rpt_1'")!.content_hash).toBe('h1');
  });

  // Migration 0010 adds reports_no_delete (0009 already blocked UPDATE).
  it('reports cannot be deleted after generation', () => {
    ctx.db.run(
      `INSERT INTO reports (id, site_id, kind, content_hash, is_synthetic, generated_at) VALUES ('rpt_del', ?, 'weekly', 'h1', 1, ?)`,
      [ctx.siteId, NOW],
    );
    expect(() => ctx.db.run("DELETE FROM reports WHERE id = 'rpt_del'")).toThrow(/append-only/);
    expect(ctx.db.get("SELECT id FROM reports WHERE id = 'rpt_del'")).toBeDefined();
  });

  it('recordAudit redacts details before storing them', () => {
    registerSecret('synthetic-audit-secret-001');
    recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'test', eventType: 'x', details: { note: 'used synthetic-audit-secret-001', api_key: 'abc123456789' } });
    const row = ctx.db.get<{ details_json: string }>("SELECT details_json FROM audit_events WHERE event_type = 'x'")!;
    expect(JSON.parse(row.details_json)).toEqual({ note: `used ${REDACTED}`, api_key: REDACTED });
  });
});

describe('versioned ingestion invariants', () => {
  it('the partial unique index allows only one current revision per grain key', () => {
    insertBatch('batch_1');
    insertPropertyDay(1, 1, 10);
    expect(() => insertPropertyDay(2, 1, 12)).toThrow(/UNIQUE/);
    // Correct flow: demote the old revision, then insert the new current one.
    ctx.db.transaction(() => {
      ctx.db.run('UPDATE gsc_property_daily SET is_current = 0 WHERE site_id = ? AND revision = 1', [ctx.siteId]);
      insertPropertyDay(2, 1, 12);
    });
    expect(ctx.db.all('SELECT revision, clicks FROM gsc_property_daily_current WHERE site_id = ?', [ctx.siteId])).toEqual([{ revision: 2, clicks: 12 }]);
    expect(() => insertPropertyDay(2, 0, 99)).toThrow(/UNIQUE/); // (key, revision) is unique too
  });
});

describe('cost tables encode unknown versus zero', () => {
  it('cost_ledger requires NULL amounts exactly when the status is unknown, and one entry per provider request', () => {
    const base = [ctx.siteId, '2026-09', '2026-W39', NOW];
    const insert = (id: string, amount: number | null, status: string, reqId: string | null) =>
      ctx.db.run(
        `INSERT INTO cost_ledger (id, site_id, provider, provider_request_id, amount_usd_micros, amount_status, source, period_month, period_week, recorded_at)
         VALUES (?, ?, 'apify', ?, ?, ?, 'manual', ?, ?, ?)`,
        [id, base[0], reqId, amount, status, base[1], base[2], base[3]],
      );
    expect(() => insert('c1', 0, 'unknown', null)).toThrow(/CHECK/);
    expect(() => insert('c2', null, 'actual', null)).toThrow(/CHECK/);
    insert('c3', 0, 'actual', null); // an actual zero is allowed and distinct from unknown
    insert('c4', null, 'unknown', null);
    ctx.db.run(`INSERT INTO provider_requests (id, site_id, provider, endpoint, method, request_hash, status, created_at) VALUES ('preq_1', ?, 'apify', 'runs', 'POST', 'h', 'succeeded', ?)`, [ctx.siteId, NOW]);
    insert('c5', 100, 'actual', 'preq_1');
    expect(() => insert('c6', 100, 'actual', 'preq_1')).toThrow(/UNIQUE/);
  });

  it('budget_reservations rejects negative amounts and unknown statuses', () => {
    const ins = (est: number, status: string) =>
      ctx.db.run(
        `INSERT INTO budget_reservations (id, site_id, provider, purpose, estimated_usd_micros, status, cost_status, period_month, period_week, created_at, updated_at)
         VALUES (?, ?, 'apify', 'p', ?, ?, 'estimated', '2026-09', '2026-W39', ?, ?)`,
        [`r_${est}_${status}`, ctx.siteId, est, status, NOW, NOW],
      );
    expect(() => ins(-1, 'reserved')).toThrow(/CHECK/);
    expect(() => ins(1, 'spent')).toThrow(/CHECK/);
    expect(() => ins(0, 'reserved')).not.toThrow();
  });
});

describe('site registry and raw store', () => {
  it('ensureSite records a new configuration version only when the config changes', () => {
    const first = ensureSite(ctx.db, ctx.config, { now: new Date(NOW) });
    expect(first.configChanged).toBe(false); // createTestContext already registered this config
    const changed = testSiteConfig({ crawl: { maxPages: 42 } });
    const second = ensureSite(ctx.db, changed, { now: new Date(NOW) });
    expect(second.configChanged).toBe(true);
    expect(second.configVersion).toBe(first.configVersion + 1);
    expect(second.site.active_config_version).toBe(second.configVersion);
    expect(ensureSite(ctx.db, ctx.config).configVersion).toBe(first.configVersion); // switching back reuses the version
    const demo = ensureSite(ctx.db, parseSiteConfig({ profile: 'demo', site: { id: 'demo-site', businessName: 'Demo (synthetic)', url: 'https://demo.example.test/', allowedHostnames: ['demo.example.test'] } }));
    expect(demo.site.is_demo).toBe(1);
  });

  it('records every activation, including a return to an earlier configuration (A -> B -> A), append-only', () => {
    const a = ctx.config;
    const b = testSiteConfig({ crawl: { maxPages: 42 } });
    const vA = ensureSite(ctx.db, a, { now: new Date('2026-09-24T10:00:00Z') }).configVersion; // already active: nothing recorded
    const vB = ensureSite(ctx.db, b, { now: new Date('2026-09-25T10:00:00Z') }).configVersion;
    expect(ensureSite(ctx.db, a, { now: new Date('2026-09-26T10:00:00Z') }).configVersion).toBe(vA);
    expect(configActivations(ctx.db, ctx.siteId).map((x) => [x.version, x.previousVersion])).toEqual([
      [vA, null], // first registration (createTestContext)
      [vB, vA],
      [vA, vB], // the return to A is recorded, not lost
    ]);
    // Which configuration was active when can be reconstructed.
    expect(configVersionActiveAt(ctx.db, ctx.siteId, '2026-09-25T12:00:00Z')).toBe(vB);
    expect(configVersionActiveAt(ctx.db, ctx.siteId, '2026-09-26T12:00:00Z')).toBe(vA);
    const events = ctx.db.all<{ subject_id: string; details_json: string }>("SELECT subject_id, details_json FROM audit_events WHERE site_id = ? AND event_type = 'config.activated' ORDER BY id", [ctx.siteId]);
    expect(events.map((e) => [e.subject_id, JSON.parse(e.details_json).previousVersion, JSON.parse(e.details_json).returnToEarlierVersion])).toEqual([
      [String(vB), vA, false],
      [String(vA), vB, true],
    ]);
    // Re-running with the active configuration records nothing.
    ensureSite(ctx.db, a, { now: new Date('2026-09-27T10:00:00Z') });
    expect(configActivations(ctx.db, ctx.siteId)).toHaveLength(3);
    expect(() => ctx.db.run('UPDATE config_activations SET version = 99')).toThrow(/append-only/);
    expect(() => ctx.db.run('DELETE FROM config_activations')).toThrow(/append-only/);
  });

  it('RawStore writes redacted 0600 files inside the workspace and rejects traversal', () => {
    const raw = new RawStore(ctx.paths.rawDir);
    registerSecret('synthetic-raw-secret-0001');
    const ref = raw.save({ siteId: ctx.siteId, provider: 'apify', kind: 'run', payload: { token: 'abcdef123456', text: 'contains synthetic-raw-secret-0001', n: 0 }, at: new Date(NOW) });
    expect(ref).toMatch(/^raw:test-site\/apify\/2026-09-24\/run-raw_[0-9A-Z]{26}\.json$/);
    const file = path.join(ctx.paths.rawDir, ref.slice(4));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain('synthetic-raw-secret-0001');
    expect(raw.load(ref)).toEqual({ token: REDACTED, text: `contains ${REDACTED}`, n: 0 });
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(raw.load('raw:test-site/apify/none.json')).toBeNull();
    expect(raw.load('https://example.com/x.json')).toBeNull();
    expect(() => raw.load('raw:../../secrets/secrets.env')).toThrow(expect.objectContaining({ code: 'UNSAFE_PATH' }));
    expect(() => raw.save({ siteId: '../escape', provider: 'x', kind: 'y', payload: {} })).toThrow(expect.objectContaining({ code: 'UNSAFE_PATH' }));
  });
});

/**
 * Spec section 6: every entity exists; every observation retains site, collection
 * time, applicable date range, raw-response reference, and transformation
 * version; every metric table has a defined grain enforced by a unique key.
 * Introspected with PRAGMA table_info / index_list over an explicit registry.
 */
interface ObservationSpec {
  /** Collection time column. */
  collected: string;
  /** Applicable date range columns (one column = a single date grain). */
  dateRange: string[] | { pointInTime: string };
  /** Raw-response reference: a column, or the FK column through which it is reached. */
  raw: { column: string } | { via: string; note: string } | { none: string };
  /** Transformation version: a column, or the FK column of the batch that records it. */
  transformation: { column: string } | { via: string };
  /** Columns (or expressions) of the unique index that enforces the grain. */
  uniqueKey: string[];
}

const OBSERVATIONS: Record<string, ObservationSpec> = {
  gsc_property_daily: { collected: 'collected_at', dateRange: ['date'], raw: { via: 'batch_id', note: 'ingestion_batches.raw_refs_json' }, transformation: { column: 'transformation_version' }, uniqueKey: ['site_id', 'property', 'search_type', 'date'] },
  gsc_page_daily: { collected: 'collected_at', dateRange: ['date'], raw: { via: 'batch_id', note: 'ingestion_batches.raw_refs_json' }, transformation: { column: 'transformation_version' }, uniqueKey: ['site_id', 'property', 'search_type', 'date', 'page', 'segment_key'] },
  gsc_page_query_daily: { collected: 'collected_at', dateRange: ['date'], raw: { via: 'batch_id', note: 'ingestion_batches.raw_refs_json' }, transformation: { column: 'transformation_version' }, uniqueKey: ['site_id', 'property', 'search_type', 'date', 'page', 'query', 'segment_key'] },
  ga4_landing_daily: { collected: 'collected_at', dateRange: ['date'], raw: { via: 'batch_id', note: 'ingestion_batches.raw_refs_json' }, transformation: { column: 'transformation_version' }, uniqueKey: ['site_id', 'property_id', 'date', 'channel_view', 'landing_page', 'host_name', 'segment_key'] },
  ga4_event_daily: { collected: 'collected_at', dateRange: ['date'], raw: { via: 'batch_id', note: 'ingestion_batches.raw_refs_json' }, transformation: { column: 'transformation_version' }, uniqueKey: ['site_id', 'property_id', 'date', 'channel_view', 'event_name', 'landing_page'] },
  ga4_period_metrics: { collected: 'collected_at', dateRange: ['period_start', 'period_end'], raw: { via: 'batch_id', note: 'ingestion_batches.raw_refs_json' }, transformation: { column: 'transformation_version' }, uniqueKey: ['site_id', 'property_id', 'period_start', 'period_end', 'channel_view', 'landing_page', 'metric'] },
  crawl_results: { collected: 'fetched_at', dateRange: { pointInTime: 'fetched_at' }, raw: { column: 'raw_ref' }, transformation: { column: 'transformation_version' }, uniqueKey: ['crawl_id', 'requested_url'] },
  url_inspections: { collected: 'inspected_at', dateRange: { pointInTime: 'inspected_at' }, raw: { column: 'raw_ref' }, transformation: { column: 'transformation_version' }, uniqueKey: ['site_id', 'property', 'url', 'inspected_at'] },
  technical_issues: { collected: 'last_seen_at', dateRange: ['first_seen_at', 'last_seen_at'], raw: { via: 'crawl_id', note: 'crawl_results.raw_ref of that crawl' }, transformation: { column: 'transformation_version' }, uniqueKey: ['site_id', 'url', 'issue_type'] },
  keyword_metrics: { collected: 'collected_at', dateRange: { pointInTime: 'collected_at' }, raw: { column: 'raw_ref' }, transformation: { column: 'transformation_version' }, uniqueKey: ['site_id', 'keyword_id', 'provider', 'location_code', 'language_code', 'collected_at'] },
  serp_snapshots: { collected: 'collected_at', dateRange: { pointInTime: 'collected_at' }, raw: { column: 'raw_ref' }, transformation: { column: 'transformation_version' }, uniqueKey: ['site_id', 'dataforseo_task_id'] },
  rankings: { collected: 'observed_at', dateRange: { pointInTime: 'observed_at' }, raw: { via: 'snapshot_id', note: 'serp_snapshots.raw_ref' }, transformation: { via: 'snapshot_id' }, uniqueKey: ['snapshot_id', 'keyword_id'] },
  performance_checks: { collected: 'checked_at', dateRange: ['date_range_start', 'date_range_end'], raw: { column: 'raw_ref' }, transformation: { column: 'tool_version' }, uniqueKey: ['site_id', 'url', 'source', 'device', 'checked_at'] },
  ai_citation_checks: { collected: 'checked_at', dateRange: { pointInTime: 'checked_at' }, raw: { column: 'response_ref' }, transformation: { column: 'method' }, uniqueKey: ['site_id', 'engine', 'query', 'prompt', 'location', 'method', 'checked_at'] },
  competitor_changes: { collected: 'detected_at', dateRange: { pointInTime: 'detected_at' }, raw: { none: 'derived from two crawl_results rows (previous_hash/new_hash)' }, transformation: { via: 'competitor_page_id' }, uniqueKey: ['site_id', 'competitor_page_id', 'change_type', 'new_hash', 'detected_at'] },
};

/** Spec section 6 entity list -> tables. */
const ENTITIES: Record<string, string[]> = {
  'sites, configuration versions, pages, URL aliases, internal links': ['sites', 'config_versions', 'config_activations', 'pages', 'url_aliases', 'internal_links'],
  'crawls, content snapshots, sources, evidence, source-to-claim references': ['crawls', 'crawl_results', 'sources', 'evidence', 'claim_evidence'],
  'GSC property totals, page metrics, page/query datasets': ['gsc_property_daily', 'gsc_page_daily', 'gsc_page_query_daily', 'ingestion_batches', 'gsc_data_availability'],
  'GA4 landing-page metrics, event metrics, report metadata': ['ga4_landing_daily', 'ga4_event_daily', 'ga4_period_metrics', 'ga4_property_metadata'],
  'keywords, clusters, SERP snapshots, rankings, competitors, competitor changes': ['keywords', 'keyword_clusters', 'serp_snapshots', 'serp_results', 'rankings', 'competitors', 'competitor_pages', 'competitor_changes'],
  'opportunities, recommendations, briefs, drafts, quality reviews, publication records': ['opportunities', 'recommendations', 'content_briefs', 'content_drafts', 'quality_reviews', 'publications'],
  'experiments, measurements, external-change annotations, decisions, learnings': ['experiments', 'experiment_measurements', 'change_annotations', 'decisions', 'learnings'],
  'jobs, runs, checkpoints, provider requests, Apify runs, costs, reservations, approvals, audit events': ['jobs', 'job_runs', 'checkpoints', 'provider_requests', 'apify_runs', 'cost_ledger', 'budget_reservations', 'approvals', 'audit_events'],
  'document chunks, embedding versions, index status, deletion/tombstone records': ['memory_documents', 'memory_chunks', 'embedding_versions', 'chunk_index_status', 'memory_tombstones'],
};

function columns(table: string): Map<string, { notnull: number }> {
  return new Map(ctx.db.all<{ name: string; notnull: number }>(`SELECT name, "notnull" FROM pragma_table_info(?)`, [table]).map((c) => [c.name, c]));
}

/** Unique indexes of a table with the text of their key (column names or expressions). */
function uniqueIndexes(table: string): Array<{ name: string; key: string; partial: boolean }> {
  return ctx.db
    .all<{ name: string; unique: number; partial: number }>(`SELECT name, "unique", partial FROM pragma_index_list(?)`, [table])
    .filter((i) => i.unique === 1)
    .map((i) => {
      const cols = ctx.db.all<{ name: string | null; key: number }>(`SELECT name, "key" FROM pragma_index_xinfo(?)`, [i.name]).filter((c) => c.key === 1);
      const sql = ctx.db.get<{ sql: string | null }>("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", [i.name])?.sql ?? '';
      return { name: i.name, key: `${cols.map((c) => c.name ?? '').join(',')} ${sql}`, partial: i.partial === 1 };
    });
}

describe('schema introspection: entities, provenance, and grain (spec section 6)', () => {
  it('every section 6 entity has a table', () => {
    const tables = new Set(ctx.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name));
    const missing = Object.entries(ENTITIES).flatMap(([entity, ts]) => ts.filter((t) => !tables.has(t)).map((t) => `${entity}: ${t}`));
    expect(missing).toEqual([]);
  });

  for (const [table, spec] of Object.entries(OBSERVATIONS)) {
    it(`${table}: site, collection time, date range, raw reference, transformation version, unique grain`, () => {
      const cols = columns(table);
      expect(cols.size, `${table} exists`).toBeGreaterThan(0);
      if (table !== 'rankings' || cols.has('site_id')) expect(cols.get('site_id')?.notnull, `${table}.site_id NOT NULL`).toBe(1);
      expect(cols.has(spec.collected), `${table}.${spec.collected}`).toBe(true);
      const range = Array.isArray(spec.dateRange) ? spec.dateRange : [spec.dateRange.pointInTime];
      for (const c of range) expect(cols.has(c), `${table} date range column ${c}`).toBe(true);
      if ('column' in spec.raw) expect(cols.has(spec.raw.column), `${table}.${spec.raw.column}`).toBe(true);
      if ('via' in spec.raw) expect(cols.has(spec.raw.via), `${table}.${spec.raw.via} (raw reference via ${spec.raw.note})`).toBe(true);
      if ('column' in spec.transformation) expect(cols.has(spec.transformation.column), `${table}.${spec.transformation.column}`).toBe(true);
      else expect(cols.has(spec.transformation.via), `${table}.${spec.transformation.via}`).toBe(true);
      const idx = uniqueIndexes(table);
      const match = idx.find((i) => spec.uniqueKey.every((k) => new RegExp(`\\b${k}\\b`).test(i.key)));
      expect(match, `${table} has a unique index over (${spec.uniqueKey.join(', ')}); found: ${idx.map((i) => i.name).join(', ') || 'none'}`).toBeDefined();
    });
  }

  it('batch-backed tables reach raw references and transformation versions through ingestion_batches', () => {
    const cols = columns('ingestion_batches');
    for (const c of ['raw_refs_json', 'transformation_version', 'request_json', 'coverage_json', 'metadata_json', 'date_start', 'date_end', 'started_at']) expect(cols.has(c), c).toBe(true);
    expect(cols.get('transformation_version')!.notnull).toBe(1);
  });

  it('the new unique keys reject duplicate observations (NULL key parts included)', () => {
    const at = '2026-09-24T09:00:00.000Z';
    const kw = "INSERT INTO keywords (id, site_id, keyword, normalized, language, first_seen_at) VALUES ('kw_1', ?, 'synthetic widgets', 'synthetic widgets', NULL, ?)";
    ctx.db.run(kw, [ctx.siteId, at]);
    const metric = (id: string) =>
      ctx.db.run("INSERT INTO keyword_metrics (id, site_id, keyword_id, provider, location_code, language_code, is_sandbox, collected_at, expires_at) VALUES (?, ?, 'kw_1', 'dataforseo', NULL, NULL, 1, ?, ?)", [id, ctx.siteId, at, at]);
    metric('m1');
    expect(() => metric('m2')).toThrow(/UNIQUE/);
    const snap = (id: string, task: string | null) =>
      ctx.db.run("INSERT INTO serp_snapshots (id, site_id, query, provider, device, parameter_hash, is_sandbox, dataforseo_task_id, collected_at) VALUES (?, ?, 'q', 'dataforseo', 'desktop', 'h', 1, ?, ?)", [id, ctx.siteId, task, at]);
    snap('s1', 'dfs_task_1');
    expect(() => snap('s2', 'dfs_task_1')).toThrow(/UNIQUE/);
    snap('s3', null);
    snap('s4', null); // manual/fixture snapshots without a task id are not constrained by the task key
    const rank = (id: string) => ctx.db.run("INSERT INTO rankings (id, site_id, keyword_id, snapshot_id, rank_absolute, observed_at) VALUES (?, ?, 'kw_1', 's1', 3, ?)", [id, ctx.siteId, at]);
    rank('r1');
    expect(() => rank('r2')).toThrow(/UNIQUE/);
    const insp = (id: string) => ctx.db.run("INSERT INTO url_inspections (id, site_id, property, url, is_synthetic, inspected_at) VALUES (?, ?, 'sc-domain:example.test', 'https://www.example.test/', 1, ?)", [id, ctx.siteId, at]);
    insp('i1');
    expect(() => insp('i2')).toThrow(/UNIQUE/);
    const perf = (id: string) =>
      ctx.db.run("INSERT INTO performance_checks (id, site_id, url, source, data_kind, device, metrics_json, cache_key, is_synthetic, checked_at) VALUES (?, ?, 'https://www.example.test/', 'psi_lab', 'lab', 'mobile', '{}', 'k', 1, ?)", [id, ctx.siteId, at]);
    perf('p1');
    expect(() => perf('p2')).toThrow(/UNIQUE/);
  });
});
