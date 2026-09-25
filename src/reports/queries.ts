import type { AppContext } from '../app/context.js';
import { parseJson, type Db } from '../database/db.js';
import { addDays, dateInZone, eachDate, isValidTimeZone } from '../core/time.js';

/**
 * Read-only SQL for reports. Every query is parameterized and scoped by
 * site_id, reads current-revision views for metric tables, and keeps
 * synthetic flags so the report can watermark itself.
 */

export interface BatchInfo {
  id: string;
  source: string;
  dataset: string;
  property: string;
  date_start: string;
  date_end: string;
  status: string;
  truncated: number;
  coverage_json: string | null;
  metadata_json: string | null;
  is_synthetic: number;
  started_at: string;
  finished_at: string | null;
}

/**
 * Which slice of a dataset a coverage check is about. Ingestion writes one
 * batch per GA4 channel view and per Search Console search type, recording
 * them only in request_json, so coverage must be scoped to the exact slice
 * being reported: another view's or search type's successful batch never
 * proves that this one was collected.
 */
export interface CoverageScope {
  property?: string | null;
  /** GA4 channel view (`request_json.view`). Batches that do not record this exact view never count. */
  ga4View?: string | null;
  /**
   * Search Console search type (`request_json.type`, or its deprecated alias
   * `searchType`). When a batch recorded neither, the documented API default
   * `web` applies (docs/integration-contracts.md, Search Console `type`).
   */
  gscSearchType?: string | null;
}

/** Successful/partial batches overlapping [start, end] for one dataset slice, and the dates none of them covers. */
export function batchCoverage(db: Db, siteId: string, dataset: string, start: string, end: string, scope: CoverageScope = {}): { batches: BatchInfo[]; uncovered: string[] } {
  const property = scope.property ?? null;
  const view = scope.ga4View ?? null;
  const searchType = scope.gscSearchType ?? null;
  const batches = db.all<BatchInfo>(
    `SELECT id, source, dataset, property, date_start, date_end, status, truncated, coverage_json, metadata_json, is_synthetic, started_at, finished_at
     FROM ingestion_batches
     WHERE site_id = ? AND dataset = ? AND status IN ('succeeded', 'partial') AND date_start <= ? AND date_end >= ?
       AND (? IS NULL OR property = ?)
       AND (? IS NULL OR json_extract(request_json, '$.view') = ?)
       AND (? IS NULL OR lower(COALESCE(json_extract(request_json, '$.type'), json_extract(request_json, '$.searchType'), 'web')) = lower(?))
     ORDER BY started_at`,
    [siteId, dataset, end, start, property, property, view, view, searchType, searchType],
  );
  const covered = new Set<string>();
  for (const b of batches) {
    const s = b.date_start > start ? b.date_start : start;
    const e = b.date_end < end ? b.date_end : end;
    if (s <= e) for (const d of eachDate(s, e)) covered.add(d);
  }
  const uncovered = eachDate(start, end).filter((d) => !covered.has(d));
  return { batches, uncovered };
}

// ---------------------------------------------------------------------------
// Search Console
// ---------------------------------------------------------------------------

export function resolveGscProperty(ctx: AppContext): { property: string | null; others: string[]; searchType: string } {
  const configured = ctx.config.google.searchConsoleProperty;
  const searchTypes = ctx.config.google.gsc.searchTypes;
  const searchType = searchTypes.includes('web') ? 'web' : (searchTypes[0] ?? 'web');
  const props = ctx.db.all<{ property: string }>('SELECT DISTINCT property FROM gsc_property_daily_current WHERE site_id = ? ORDER BY property', [ctx.siteId]).map((r) => r.property);
  const pageProps = ctx.db.all<{ property: string }>('SELECT DISTINCT property FROM gsc_page_daily_current WHERE site_id = ? ORDER BY property', [ctx.siteId]).map((r) => r.property);
  const all = [...new Set([...props, ...pageProps])].sort();
  if (configured) return { property: configured, others: all.filter((p) => p !== configured), searchType };
  if (all.length === 0) return { property: null, others: [], searchType };
  return { property: all[0]!, others: all.slice(1), searchType };
}

export interface GscDailyRow {
  date: string;
  date_tz: string;
  clicks: number;
  impressions: number;
  position: number | null;
  is_final: number;
  is_synthetic: number;
  batch_id: string;
  collected_at: string;
}

export function gscPropertyRows(db: Db, siteId: string, property: string, searchType: string, start: string, end: string): GscDailyRow[] {
  return db.all<GscDailyRow>(
    `SELECT date, date_tz, clicks, impressions, position, is_final, is_synthetic, batch_id, collected_at
     FROM gsc_property_daily_current
     WHERE site_id = ? AND property = ? AND search_type = ? AND date BETWEEN ? AND ?
     ORDER BY date`,
    [siteId, property, searchType, start, end],
  );
}

export interface GscPageAgg {
  page: string;
  page_id: string | null;
  clicks: number;
  impressions: number;
  pos_weighted: number | null;
  pos_impressions: number | null;
  days: number;
  syn: number;
}

export function gscTopPages(db: Db, siteId: string, property: string, searchType: string, start: string, end: string, limit: number): { rows: GscPageAgg[]; totalPages: number; batchIds: string[]; collectedAt: string[]; synthetic: boolean; excludedIncomplete: number } {
  const where = `site_id = ? AND property = ? AND search_type = ? AND segment_key = '' AND date BETWEEN ? AND ?`;
  const params = [siteId, property, searchType, start, end];
  const rows = db.all<GscPageAgg>(
    `SELECT page, MAX(page_id) AS page_id, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
            SUM(CASE WHEN position IS NOT NULL THEN position * impressions END) AS pos_weighted,
            SUM(CASE WHEN position IS NOT NULL THEN impressions END) AS pos_impressions,
            COUNT(DISTINCT date) AS days, MAX(is_synthetic) AS syn
     FROM gsc_page_daily_current WHERE ${where} AND is_final = 1
     GROUP BY page ORDER BY clicks DESC, impressions DESC, page LIMIT ?`,
    [...params, limit],
  );
  const meta = db.get<{ pages: number; syn: number | null; incomplete: number | null }>(
    `SELECT COUNT(DISTINCT CASE WHEN is_final = 1 THEN page END) AS pages, MAX(is_synthetic) AS syn, SUM(CASE WHEN is_final = 0 THEN 1 ELSE 0 END) AS incomplete
     FROM gsc_page_daily_current WHERE ${where}`,
    params,
  );
  const batches = db.all<{ batch_id: string; c: string }>(
    `SELECT batch_id, MAX(collected_at) AS c FROM gsc_page_daily_current WHERE ${where} AND is_final = 1 GROUP BY batch_id ORDER BY c DESC LIMIT 20`,
    params,
  );
  return {
    rows,
    totalPages: Number(meta?.pages ?? 0),
    batchIds: batches.map((b) => b.batch_id),
    collectedAt: batches.map((b) => b.c),
    synthetic: Number(meta?.syn ?? 0) === 1,
    excludedIncomplete: Number(meta?.incomplete ?? 0),
  };
}

export interface GscQueryAgg {
  query: string;
  clicks: number;
  impressions: number;
  pos_weighted: number | null;
  pos_impressions: number | null;
  syn: number;
}

export function gscVisibleQueries(db: Db, siteId: string, property: string, searchType: string, start: string, end: string): { rows: GscQueryAgg[]; batchIds: string[]; collectedAt: string[]; synthetic: boolean } {
  const where = `site_id = ? AND property = ? AND search_type = ? AND segment_key = '' AND is_final = 1 AND date BETWEEN ? AND ?`;
  const params = [siteId, property, searchType, start, end];
  const rows = db.all<GscQueryAgg>(
    `SELECT query, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
            SUM(CASE WHEN position IS NOT NULL THEN position * impressions END) AS pos_weighted,
            SUM(CASE WHEN position IS NOT NULL THEN impressions END) AS pos_impressions,
            MAX(is_synthetic) AS syn
     FROM gsc_page_query_daily_current WHERE ${where}
     GROUP BY query ORDER BY clicks DESC, impressions DESC, query`,
    params,
  );
  const batches = db.all<{ batch_id: string; c: string }>(
    `SELECT batch_id, MAX(collected_at) AS c FROM gsc_page_query_daily_current WHERE ${where} GROUP BY batch_id ORDER BY c DESC LIMIT 20`,
    params,
  );
  return { rows, batchIds: batches.map((b) => b.batch_id), collectedAt: batches.map((b) => b.c), synthetic: rows.some((r) => Number(r.syn) === 1) };
}

/** Page-total clicks vs visible query-row clicks over the same (page, date) pairs. `synthetic` = any contributing row (query or page) is synthetic. */
export function gscUnattributed(db: Db, siteId: string, property: string, searchType: string, start: string, end: string): { pages: number; pageClicks: number; queryClicks: number; synthetic: boolean } | null {
  const params = [siteId, property, searchType, start, end];
  const r = db.get<{ pages: number | null; page_clicks: number | null; query_clicks: number | null; syn: number | null }>(
    `WITH qpd AS (
       SELECT page, date, SUM(clicks) AS qc, MAX(is_synthetic) AS qsyn FROM gsc_page_query_daily_current
       WHERE site_id = ? AND property = ? AND search_type = ? AND segment_key = '' AND is_final = 1 AND date BETWEEN ? AND ?
       GROUP BY page, date
     )
     SELECT COUNT(DISTINCT qpd.page) AS pages, SUM(p.clicks) AS page_clicks, SUM(qpd.qc) AS query_clicks, MAX(MAX(qpd.qsyn, p.is_synthetic)) AS syn
     FROM qpd JOIN gsc_page_daily_current p
       ON p.page = qpd.page AND p.date = qpd.date AND p.site_id = ? AND p.property = ? AND p.search_type = ? AND p.segment_key = '' AND p.is_final = 1`,
    [...params, siteId, property, searchType],
  );
  if (!r || !r.pages || r.page_clicks === null || r.query_clicks === null) return null;
  return { pages: Number(r.pages), pageClicks: Number(r.page_clicks), queryClicks: Number(r.query_clicks), synthetic: Number(r.syn ?? 0) === 1 };
}

export interface GscSegmentAgg {
  segment_key: string;
  clicks: number;
  impressions: number;
  pos_weighted: number | null;
  pos_impressions: number | null;
  collected_at: string | null;
  syn: number | null;
}

export function gscSegmentRows(db: Db, siteId: string, property: string, searchType: string, start: string, end: string): GscSegmentAgg[] {
  return db.all<GscSegmentAgg>(
    `SELECT segment_key, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
            SUM(CASE WHEN position IS NOT NULL THEN position * impressions END) AS pos_weighted,
            SUM(CASE WHEN position IS NOT NULL THEN impressions END) AS pos_impressions, MAX(collected_at) AS collected_at, MAX(is_synthetic) AS syn
     FROM gsc_page_daily_current
     WHERE site_id = ? AND property = ? AND search_type = ? AND segment_key <> '' AND is_final = 1 AND date BETWEEN ? AND ?
     GROUP BY segment_key`,
    [siteId, property, searchType, start, end],
  );
}

export function gscPageMetrics(db: Db, siteId: string, opts: { pageId: string | null; pageUrl: string | null; property: string; searchType: string; start: string; end: string; query?: string | null }): { clicks: number; impressions: number; pos_weighted: number | null; pos_impressions: number | null; days: number; batchIds: string[]; collectedAt: string[]; syn: boolean } | null {
  const table = opts.query ? 'gsc_page_query_daily_current' : 'gsc_page_daily_current';
  const pageCond = opts.pageId ? 'page_id = ?' : 'page = ?';
  const pageVal = opts.pageId ?? opts.pageUrl;
  if (!pageVal) return null;
  const params: unknown[] = [siteId, opts.property, opts.searchType, opts.start, opts.end, pageVal];
  let queryCond = '';
  if (opts.query) {
    queryCond = ' AND query = ?';
    params.push(opts.query);
  }
  const where = `site_id = ? AND property = ? AND search_type = ? AND segment_key = '' AND is_final = 1 AND date BETWEEN ? AND ? AND ${pageCond}${queryCond}`;
  const r = db.get<{ clicks: number | null; impressions: number | null; pw: number | null; pi: number | null; days: number; syn: number | null }>(
    `SELECT SUM(clicks) AS clicks, SUM(impressions) AS impressions,
            SUM(CASE WHEN position IS NOT NULL THEN position * impressions END) AS pw,
            SUM(CASE WHEN position IS NOT NULL THEN impressions END) AS pi,
            COUNT(DISTINCT date) AS days, MAX(is_synthetic) AS syn
     FROM ${table} WHERE ${where}`,
    params,
  );
  if (!r || r.clicks === null) return null;
  const b = db.all<{ batch_id: string; c: string }>(`SELECT batch_id, MAX(collected_at) AS c FROM ${table} WHERE ${where} GROUP BY batch_id ORDER BY c DESC LIMIT 5`, params);
  return {
    clicks: Number(r.clicks),
    impressions: Number(r.impressions ?? 0),
    pos_weighted: r.pw,
    pos_impressions: r.pi,
    days: Number(r.days),
    batchIds: b.map((x) => x.batch_id),
    collectedAt: b.map((x) => x.c),
    syn: Number(r.syn ?? 0) === 1,
  };
}

// ---------------------------------------------------------------------------
// GA4
// ---------------------------------------------------------------------------

export function resolveGa4Property(ctx: AppContext): { propertyId: string | null; others: string[] } {
  const configured = ctx.config.google.ga4PropertyId;
  const ids = ctx.db.all<{ property_id: string }>('SELECT DISTINCT property_id FROM ga4_landing_daily_current WHERE site_id = ? ORDER BY property_id', [ctx.siteId]).map((r) => r.property_id);
  if (configured) return { propertyId: configured, others: ids.filter((i) => i !== configured) };
  if (ids.length === 0) return { propertyId: null, others: [] };
  return { propertyId: ids[0]!, others: ids.slice(1) };
}

export interface Ga4ChannelAgg {
  rows: number;
  days: number;
  sessions: number | null;
  engaged: number | null;
  engaged_null: number | null;
  key_events: number | null;
  key_events_null: number | null;
  pke: number | null;
  pke_not_observed: number | null;
  /** SUM(rate x sessions) over rows whose rate scale is verified (never 'undetermined'), as fractions. */
  conv_sessions: number | null;
  rate_sessions: number | null;
  rate_not_observed: number | null;
  /** Rows with an observed rate stored with scale 'undetermined' (never used as fractions). */
  rate_unverified: number | null;
  /** SUM(raw rate x sessions) over all observed rates, on the scale GA4 reported (for an explicitly unverified raw value only). */
  raw_rate_weighted: number | null;
  event_names: string | null;
  rate_statuses: string | null;
  pke_statuses: string | null;
  not_set_sessions: number | null;
  unmatched_sessions: number | null;
  revenue_not_observed: number | null;
  syn: number | null;
  date_tz: string | null;
}

export function ga4ChannelAggregate(db: Db, siteId: string, propertyId: string, channelView: string, start: string, end: string, pageId?: string | null): { agg: Ga4ChannelAgg | null; incompleteRows: number; revenue: Array<{ currency: string; micros: number }>; batchIds: string[]; collectedAt: string[] } {
  const pageCond = pageId ? ' AND page_id = ?' : '';
  const base = [siteId, propertyId, channelView, start, end, ...(pageId ? [pageId] : [])];
  const where = `site_id = ? AND property_id = ? AND channel_view = ? AND date BETWEEN ? AND ? AND segment_key = ''${pageCond}`;
  const agg = db.get<Ga4ChannelAgg>(
    `SELECT COUNT(*) AS rows, COUNT(DISTINCT date) AS days, SUM(sessions) AS sessions,
            SUM(engaged_sessions) AS engaged, SUM(CASE WHEN engaged_sessions IS NULL THEN 1 ELSE 0 END) AS engaged_null,
            SUM(key_events) AS key_events, SUM(CASE WHEN key_events IS NULL THEN 1 ELSE 0 END) AS key_events_null,
            SUM(CASE WHEN primary_key_events_status = 'observed' THEN primary_key_events END) AS pke,
            SUM(CASE WHEN primary_key_events_status = 'observed' AND primary_key_events IS NOT NULL THEN 0 ELSE 1 END) AS pke_not_observed,
            SUM(CASE WHEN primary_session_rate_status = 'observed' AND primary_session_rate IS NOT NULL AND primary_session_rate_scale IS NOT 'undetermined'
                     THEN (CASE WHEN primary_session_rate_scale = 'percent' THEN primary_session_rate / 100.0 ELSE primary_session_rate END) * sessions END) AS conv_sessions,
            SUM(CASE WHEN primary_session_rate_status = 'observed' AND primary_session_rate IS NOT NULL THEN sessions END) AS rate_sessions,
            SUM(CASE WHEN primary_session_rate_status = 'observed' AND primary_session_rate IS NOT NULL THEN 0 ELSE 1 END) AS rate_not_observed,
            SUM(CASE WHEN primary_session_rate_status = 'observed' AND primary_session_rate IS NOT NULL AND primary_session_rate_scale = 'undetermined' THEN 1 ELSE 0 END) AS rate_unverified,
            SUM(CASE WHEN primary_session_rate_status = 'observed' AND primary_session_rate IS NOT NULL THEN primary_session_rate * sessions END) AS raw_rate_weighted,
            GROUP_CONCAT(DISTINCT primary_event_name) AS event_names,
            GROUP_CONCAT(DISTINCT primary_session_rate_status) AS rate_statuses,
            GROUP_CONCAT(DISTINCT primary_key_events_status) AS pke_statuses,
            SUM(CASE WHEN landing_page = '(not set)' THEN sessions ELSE 0 END) AS not_set_sessions,
            SUM(CASE WHEN page_id IS NULL AND landing_page <> '(not set)' THEN sessions ELSE 0 END) AS unmatched_sessions,
            SUM(CASE WHEN revenue_status = 'observed' AND revenue_micros IS NOT NULL THEN 0 ELSE 1 END) AS revenue_not_observed,
            MAX(is_synthetic) AS syn, MAX(date_tz) AS date_tz
     FROM ga4_landing_daily_current WHERE ${where} AND is_complete = 1`,
    base,
  );
  const inc = db.get<{ n: number | null }>(`SELECT SUM(CASE WHEN is_complete = 0 THEN 1 ELSE 0 END) AS n FROM ga4_landing_daily_current WHERE ${where}`, base);
  const revenue = db.all<{ currency: string | null; micros: number | null }>(
    `SELECT revenue_currency AS currency, SUM(revenue_micros) AS micros FROM ga4_landing_daily_current
     WHERE ${where} AND is_complete = 1 AND revenue_status = 'observed' AND revenue_micros IS NOT NULL GROUP BY revenue_currency`,
    base,
  );
  const batches = db.all<{ batch_id: string; c: string }>(
    `SELECT batch_id, MAX(collected_at) AS c FROM ga4_landing_daily_current WHERE ${where} AND is_complete = 1 GROUP BY batch_id ORDER BY c DESC LIMIT 20`,
    base,
  );
  return {
    agg: agg && Number(agg.rows) > 0 ? agg : null,
    incompleteRows: Number(inc?.n ?? 0),
    revenue: revenue.map((r) => ({ currency: r.currency ?? 'unknown', micros: Number(r.micros ?? 0) })),
    batchIds: batches.map((b) => b.batch_id),
    collectedAt: batches.map((b) => b.c),
  };
}

export interface PeriodMetricRow {
  metric: string;
  value: number | null;
  value_status: string;
  /** Key-event rate scale marker (migration 0100); NULL for non-rate metrics. See seo/metrics.rateScaleClass. */
  rate_scale: string | null;
  is_complete: number;
  batch_id: string;
  collected_at: string;
  is_synthetic: number;
}

/** Period-grain metrics for EXACTLY this period (never derived from daily rows). */
export function ga4PeriodMetrics(db: Db, siteId: string, propertyId: string, channelView: string, start: string, end: string, landingPage = ''): Map<string, PeriodMetricRow> {
  const rows = db.all<PeriodMetricRow>(
    `SELECT metric, value, value_status, rate_scale, is_complete, batch_id, collected_at, is_synthetic FROM ga4_period_metrics_current
     WHERE site_id = ? AND property_id = ? AND channel_view = ? AND period_start = ? AND period_end = ? AND landing_page = ?`,
    [siteId, propertyId, channelView, start, end, landingPage],
  );
  return new Map(rows.map((r) => [r.metric, r]));
}

/** Distinct periods for which a period-grain metric exists (newest first), to explain an exact-period miss. */
export function ga4PeriodsWithMetric(db: Db, siteId: string, propertyId: string, channelView: string, metrics: string[], limit = 3): Array<{ start: string; end: string }> {
  if (metrics.length === 0) return [];
  return db
    .all<{ period_start: string; period_end: string }>(
      `SELECT DISTINCT period_start, period_end FROM ga4_period_metrics_current
       WHERE site_id = ? AND property_id = ? AND channel_view = ? AND landing_page = '' AND metric IN (${metrics.map(() => '?').join(', ')})
       ORDER BY period_end DESC, period_start DESC LIMIT ?`,
      [siteId, propertyId, channelView, ...metrics, limit],
    )
    .map((r) => ({ start: r.period_start, end: r.period_end }));
}

export function ga4PropertyTimeZone(db: Db, siteId: string, propertyId: string): string | null {
  return db.get<{ time_zone: string | null }>('SELECT time_zone FROM ga4_property_metadata WHERE site_id = ? AND property_id = ?', [siteId, propertyId])?.time_zone ?? null;
}

export function ga4PropertyMetadataJson(db: Db, siteId: string, propertyId: string): unknown {
  return ga4PropertyMetadata(db, siteId, propertyId).metadata;
}

export function ga4PropertyMetadata(db: Db, siteId: string, propertyId: string): { metadata: unknown; fetchedAt: string | null } {
  const r = db.get<{ metadata_json: string | null; fetched_at: string }>('SELECT metadata_json, fetched_at FROM ga4_property_metadata WHERE site_id = ? AND property_id = ?', [siteId, propertyId]);
  return { metadata: parseJson<unknown>(r?.metadata_json, null), fetchedAt: r?.fetched_at ?? null };
}

// ---------------------------------------------------------------------------
// Freshness and data quality
// ---------------------------------------------------------------------------

export function recentBatches(db: Db, siteId: string, limit = 500): BatchInfo[] {
  return db.all<BatchInfo>(
    `SELECT id, source, dataset, property, date_start, date_end, status, truncated, coverage_json, metadata_json, is_synthetic, started_at, finished_at
     FROM ingestion_batches WHERE site_id = ? ORDER BY started_at DESC LIMIT ?`,
    [siteId, limit],
  );
}

const DATASET_TABLES: Record<string, { view: string; complete: string }> = {
  gsc_property_daily: { view: 'gsc_property_daily_current', complete: 'is_final' },
  gsc_page_daily: { view: 'gsc_page_daily_current', complete: 'is_final' },
  gsc_page_query_daily: { view: 'gsc_page_query_daily_current', complete: 'is_final' },
  ga4_landing_daily: { view: 'ga4_landing_daily_current', complete: 'is_complete' },
  ga4_event_daily: { view: 'ga4_event_daily_current', complete: 'is_complete' },
};

export function datasetDateRange(db: Db, siteId: string, dataset: string): { latest: string | null; firstIncomplete: string | null; earliest: string | null; days: number } {
  const t = DATASET_TABLES[dataset];
  if (!t) return { latest: null, firstIncomplete: null, earliest: null, days: 0 };
  // Table/column names come from the fixed map above, never from input.
  const r = db.get<{ latest: string | null; earliest: string | null; first_incomplete: string | null; days: number }>(
    `SELECT MAX(date) AS latest, MIN(date) AS earliest, MIN(CASE WHEN ${t.complete} = 0 THEN date END) AS first_incomplete, COUNT(DISTINCT date) AS days
     FROM ${t.view} WHERE site_id = ?`,
    [siteId],
  );
  return { latest: r?.latest ?? null, earliest: r?.earliest ?? null, firstIncomplete: r?.first_incomplete ?? null, days: Number(r?.days ?? 0) };
}

export function datasetWindowStats(db: Db, siteId: string, dataset: string, start: string, end: string): { earliest: string | null; latest: string | null; days: number; rows: number; synthetic: boolean; collectedAt: string | null } {
  const t = DATASET_TABLES[dataset];
  if (!t) return { earliest: null, latest: null, days: 0, rows: 0, synthetic: false, collectedAt: null };
  const r = db.get<{ earliest: string | null; latest: string | null; days: number; rows: number; syn: number | null; c: string | null }>(
    `SELECT MIN(date) AS earliest, MAX(date) AS latest, COUNT(DISTINCT date) AS days, COUNT(*) AS rows, MAX(is_synthetic) AS syn, MAX(collected_at) AS c
     FROM ${t.view} WHERE site_id = ? AND date BETWEEN ? AND ?`,
    [siteId, start, end],
  );
  return { earliest: r?.earliest ?? null, latest: r?.latest ?? null, days: Number(r?.days ?? 0), rows: Number(r?.rows ?? 0), synthetic: Number(r?.syn ?? 0) === 1, collectedAt: r?.c ?? null };
}

export function gscAvailability(db: Db, siteId: string, property: string | null): { first_incomplete_date: string | null; latest_final_date: string | null; checked_at: string } | undefined {
  return db.get(
    `SELECT first_incomplete_date, latest_final_date, checked_at FROM gsc_data_availability WHERE site_id = ? AND (? IS NULL OR property = ?) ORDER BY checked_at DESC LIMIT 1`,
    [siteId, property, property],
  );
}

/** Coverage warnings stored by ingestion in several possible shapes; returns short strings. */
export function extractWarnings(text: unknown, max = 20): string[] {
  const v = typeof text === 'string' ? parseJson<unknown>(text, null) : text;
  const out: string[] = [];
  const visit = (x: unknown, depth: number): void => {
    if (depth > 4 || x === null || x === undefined) return;
    if (typeof x === 'string') {
      if (x.trim()) out.push(x.trim());
      return;
    }
    if (Array.isArray(x)) {
      for (const i of x) visit(i, depth + 1);
      return;
    }
    if (typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if (typeof o.message === 'string') {
        out.push(typeof o.code === 'string' ? `${o.code}: ${o.message}` : o.message);
        return;
      }
      if ('warnings' in o) {
        visit(o.warnings, depth + 1);
        return;
      }
      for (const [k, val] of Object.entries(o)) {
        if (typeof val === 'string') out.push(`${k}: ${val}`);
        else if (val === true) out.push(k);
        else if (typeof val === 'number') out.push(`${k}: ${val}`);
        else if (Array.isArray(val) || (val && typeof val === 'object')) visit(val, depth + 1);
      }
    }
  };
  visit(v, 0);
  return [...new Set(out)].slice(0, max);
}

/** GA4 report metadata flags (thresholding, sampling, (other) row, truncation, restrictions). */
export function ga4MetadataFlags(text: unknown): string[] {
  const v = typeof text === 'string' ? parseJson<unknown>(text, null) : text;
  const flags = new Set<string>();
  const visit = (x: unknown, depth: number): void => {
    if (depth > 5 || !x || typeof x !== 'object') return;
    if (Array.isArray(x)) {
      for (const i of x) visit(i, depth + 1);
      return;
    }
    const o = x as Record<string, unknown>;
    if (o.subjectToThresholding === true) flags.add('GA4 reported subjectToThresholding: some rows may be withheld by thresholds.');
    if (o.dataLossFromOtherRow === true) flags.add('GA4 reported dataLossFromOtherRow: some rows were bucketed into "(other)".');
    if (Array.isArray(o.samplingMetadatas) && o.samplingMetadatas.length > 0) flags.add('GA4 report was sampled (samplingMetadatas present).');
    if (Array.isArray(o.dataTruncationReasons) && o.dataTruncationReasons.length > 0) flags.add('GA4 reported data truncation (dataTruncationReasons present).');
    const restr = (o.schemaRestrictionResponse as { activeMetricRestrictions?: unknown[] } | undefined)?.activeMetricRestrictions;
    if (Array.isArray(restr) && restr.length > 0) flags.add('GA4 restricted some metrics for this user role (schemaRestrictionResponse).');
    if (typeof o.emptyReason === 'string' && o.emptyReason) flags.add(`GA4 emptyReason: ${o.emptyReason}`);
    for (const val of Object.values(o)) if (val && typeof val === 'object') visit(val, depth + 1);
  };
  visit(v, 0);
  return [...flags];
}

export function latestCrawl(db: Db, siteId: string): { id: string; status: string; pages_attempted: number; pages_fetched: number; pages_blocked: number; pages_failed: number; stop_reason: string | null; is_synthetic: number; started_at: string; finished_at: string | null } | undefined {
  return db.get(
    `SELECT id, status, pages_attempted, pages_fetched, pages_blocked, pages_failed, stop_reason, is_synthetic, started_at, finished_at
     FROM crawls WHERE site_id = ? AND kind = 'own_site' ORDER BY started_at DESC LIMIT 1`,
    [siteId],
  );
}

export function latestTimestamp(db: Db, siteId: string, table: 'url_inspections' | 'performance_checks' | 'serp_snapshots' | 'memory_index_state'): string | null {
  const col = table === 'url_inspections' ? 'inspected_at' : table === 'performance_checks' ? 'checked_at' : table === 'serp_snapshots' ? 'collected_at' : 'last_sync_at';
  const extra = table === 'serp_snapshots' ? ' AND is_sandbox = 0' : '';
  return db.get<{ t: string | null }>(`SELECT MAX(${col}) AS t FROM ${table} WHERE site_id = ?${extra}`, [siteId])?.t ?? null;
}

// ---------------------------------------------------------------------------
// Decisions, experiments, content, approvals
// ---------------------------------------------------------------------------

export interface RecommendationRow {
  id: string;
  job_id: string | null;
  opportunity_id: string | null;
  kind: string;
  action_type: string;
  title: string;
  page_id: string | null;
  page_url: string | null;
  query: string | null;
  diagnosis: string | null;
  proposed_change: string | null;
  hypothesis: string | null;
  success_criteria: string | null;
  risks: string | null;
  review_date: string | null;
  details_json: string | null;
  status: string;
  prompt_version: string | null;
  model_id: string | null;
  created_at: string;
}

const REC_COLS = `r.id, r.job_id, r.opportunity_id, r.kind, r.action_type, r.title, r.page_id, p.url AS page_url, r.query, r.diagnosis,
  r.proposed_change, r.hypothesis, r.success_criteria, r.risks, r.review_date, r.details_json, r.status, r.prompt_version, r.model_id, r.created_at`;

const PRIMARY_KINDS = `r.kind IN ('primary', 'no_action', 'repair_measurement', 'collect_more_evidence')`;
/** Recommendation statuses that can still be acted on; rejected/withdrawn/superseded/expired ones never are. */
export const LIVE_RECOMMENDATION_STATUSES = ['proposed', 'approved'] as const;
const LIVE = `r.status IN ('proposed', 'approved')`;

export function isLiveRecommendation(status: string): boolean {
  return (LIVE_RECOMMENDATION_STATUSES as readonly string[]).includes(status);
}

/** Latest primary/no-action/repair/collect recommendation recorded by one job, in ANY status. */
export function jobPrimaryRecommendation(db: Db, siteId: string, jobId: string): RecommendationRow | undefined {
  return db.get<RecommendationRow>(
    `SELECT ${REC_COLS} FROM recommendations r LEFT JOIN pages p ON p.id = r.page_id
     WHERE r.site_id = ? AND r.job_id = ? AND ${PRIMARY_KINDS}
     ORDER BY r.created_at DESC LIMIT 1`,
    [siteId, jobId],
  );
}

/**
 * The live (proposed/approved) prioritized recommendation for a report: the
 * job's own when `jobId` is given and it is still live, otherwise the latest
 * live one recorded no later than `notAfter`.
 */
export function latestPrimaryRecommendation(db: Db, siteId: string, opts: { jobId?: string | null; notAfter: string }): RecommendationRow | undefined {
  if (opts.jobId) {
    const byJob = db.get<RecommendationRow>(
      `SELECT ${REC_COLS} FROM recommendations r LEFT JOIN pages p ON p.id = r.page_id
       WHERE r.site_id = ? AND r.job_id = ? AND ${PRIMARY_KINDS} AND ${LIVE} AND r.created_at <= ?
       ORDER BY r.created_at DESC LIMIT 1`,
      [siteId, opts.jobId, opts.notAfter],
    );
    if (byJob) return byJob;
  }
  return db.get<RecommendationRow>(
    `SELECT ${REC_COLS} FROM recommendations r LEFT JOIN pages p ON p.id = r.page_id
     WHERE r.site_id = ? AND ${PRIMARY_KINDS} AND ${LIVE} AND r.created_at <= ?
     ORDER BY r.created_at DESC LIMIT 1`,
    [siteId, opts.notAfter],
  );
}

export function secondaryRecommendations(db: Db, siteId: string, primary: RecommendationRow): RecommendationRow[] {
  return db.all<RecommendationRow>(
    `SELECT ${REC_COLS} FROM recommendations r LEFT JOIN pages p ON p.id = r.page_id
     WHERE r.site_id = ? AND r.kind = 'secondary' AND r.status IN ('proposed', 'approved')
       AND ((? IS NOT NULL AND r.job_id = ?) OR (? IS NULL AND substr(r.created_at, 1, 10) = substr(?, 1, 10)))
     ORDER BY r.created_at LIMIT 3`,
    [siteId, primary.job_id, primary.job_id, primary.job_id, primary.created_at],
  );
}

export interface ClaimEvidenceRow {
  id: string;
  claim_key: string;
  claim_text: string;
  claim_label: string;
  support: string;
  evidence_id: string | null;
  ev_kind: string | null;
  ev_summary: string | null;
  ev_excerpt: string | null;
  ev_locator: string | null;
  ev_start: string | null;
  ev_end: string | null;
  ev_collected: string | null;
  source_id: string | null;
  source_type: string | null;
  trust_class: string | null;
  source_url: string | null;
  source_title: string | null;
  retrieved_at: string | null;
  raw_ref: string | null;
}

export function claimEvidenceFor(db: Db, siteId: string, subjectType: string, subjectId: string): ClaimEvidenceRow[] {
  return db.all<ClaimEvidenceRow>(
    `SELECT ce.id, ce.claim_key, ce.claim_text, ce.claim_label, ce.support, ce.evidence_id,
            e.kind AS ev_kind, e.summary AS ev_summary, e.excerpt AS ev_excerpt, e.locator_json AS ev_locator,
            e.date_range_start AS ev_start, e.date_range_end AS ev_end, e.collected_at AS ev_collected,
            s.id AS source_id, s.source_type, s.trust_class, s.url AS source_url, s.title AS source_title, s.retrieved_at, s.raw_ref
     FROM claim_evidence ce
     LEFT JOIN evidence e ON e.id = ce.evidence_id AND e.site_id = ce.site_id
     LEFT JOIN sources s ON s.id = e.source_id AND s.site_id = ce.site_id
     WHERE ce.site_id = ? AND ce.subject_type = ? AND ce.subject_id = ?
     ORDER BY ce.claim_key, ce.created_at`,
    [siteId, subjectType, subjectId],
  );
}

export interface ExperimentRow {
  id: string;
  page_id: string | null;
  page_url: string | null;
  type: string;
  hypothesis: string;
  primary_metric: string;
  outcome_kind: string;
  min_observation_days: number;
  sample_requirements_json: string;
  review_date: string | null;
  status: string;
  implemented_at: string | null;
  observation_start: string | null;
  observation_end: string | null;
  outcome_json: string | null;
  updated_at: string;
}

const EXP_COLS = `e.id, e.page_id, p.url AS page_url, e.type, e.hypothesis, e.primary_metric, e.outcome_kind, e.min_observation_days,
  e.sample_requirements_json, e.review_date, e.status, e.implemented_at, e.observation_start, e.observation_end, e.outcome_json, e.updated_at`;

export function activeExperiments(db: Db, siteId: string): ExperimentRow[] {
  return db.all<ExperimentRow>(
    `SELECT ${EXP_COLS} FROM experiments e LEFT JOIN pages p ON p.id = e.page_id
     WHERE e.site_id = ? AND e.status IN ('approved', 'awaiting_implementation', 'observing')
     ORDER BY CASE e.status WHEN 'observing' THEN 0 WHEN 'awaiting_implementation' THEN 1 ELSE 2 END, e.created_at`,
    [siteId],
  );
}

export function concludedExperiments(db: Db, siteId: string, startIso: string, endIso: string): Array<ExperimentRow & { concluded_at: string }> {
  return db.all(
    `SELECT ${EXP_COLS}, h.at AS concluded_at FROM experiments e LEFT JOIN pages p ON p.id = e.page_id
     JOIN experiment_status_history h ON h.experiment_id = e.id AND h.site_id = e.site_id
     WHERE e.site_id = ? AND h.to_status IN ('positive', 'negative', 'inconclusive', 'cancelled') AND h.at >= ? AND h.at < ?
     ORDER BY h.at`,
    [siteId, startIso, endIso],
  );
}

export function countAnnotations(db: Db, siteId: string, pageId: string | null, sinceIso: string): number {
  const r = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM change_annotations WHERE site_id = ? AND occurred_at >= ? AND (page_id IS NULL OR scope IN ('site', 'template', 'external') OR (? IS NOT NULL AND page_id = ?))`,
    [siteId, sinceIso, pageId, pageId],
  );
  return Number(r?.n ?? 0);
}

/**
 * Page impressions (byPage, no segment) for ONE property and ONE search type.
 * Several search types or properties (sc-domain + URL-prefix) are never summed:
 * that would double-count and declare experiments ready too early.
 */
export function pageImpressionsSince(db: Db, siteId: string, opts: { pageId: string; property: string; searchType: string; since: string; until: string }): number | null {
  const r = db.get<{ n: number | null }>(
    `SELECT SUM(impressions) AS n FROM gsc_page_daily_current
     WHERE site_id = ? AND property = ? AND search_type = ? AND page_id = ? AND segment_key = '' AND is_final = 1 AND date BETWEEN ? AND ?`,
    [siteId, opts.property, opts.searchType, opts.pageId, opts.since, opts.until],
  );
  return r?.n === null || r?.n === undefined ? null : Number(r.n);
}

/** Google organic landing sessions for ONE GA4 property (never summed across properties or views). */
export function pageSessionsSince(db: Db, siteId: string, opts: { pageId: string; propertyId: string; since: string; until: string }): number | null {
  const r = db.get<{ n: number | null }>(
    `SELECT SUM(sessions) AS n FROM ga4_landing_daily_current
     WHERE site_id = ? AND property_id = ? AND page_id = ? AND channel_view = 'google_organic' AND segment_key = '' AND is_complete = 1 AND date BETWEEN ? AND ?`,
    [siteId, opts.propertyId, opts.pageId, opts.since, opts.until],
  );
  return r?.n === null || r?.n === undefined ? null : Number(r.n);
}

export interface ContentItemRow {
  id: string;
  title: string;
  stage: string;
  decision: string | null;
  priority_score: number | null;
  is_synthetic: number;
  draft_id: string | null;
  draft_status: string | null;
  unresolved_facts: number | null;
  review_verdict: string | null;
  published_at: string | null;
}

export function contentQueue(db: Db, siteId: string, limit: number): { items: ContentItemRow[]; stages: Record<string, number>; total: number } {
  const stages = Object.fromEntries(
    db.all<{ stage: string; n: number }>('SELECT stage, COUNT(*) AS n FROM content_items WHERE site_id = ? GROUP BY stage ORDER BY stage', [siteId]).map((r) => [r.stage, Number(r.n)]),
  );
  const items = db.all<ContentItemRow>(
    `SELECT ci.id, ci.title, ci.stage, ci.decision, ci.priority_score, ci.is_synthetic,
            (SELECT d.id FROM content_drafts d WHERE d.content_item_id = ci.id AND d.site_id = ci.site_id ORDER BY d.version DESC LIMIT 1) AS draft_id,
            (SELECT d.status FROM content_drafts d WHERE d.content_item_id = ci.id AND d.site_id = ci.site_id ORDER BY d.version DESC LIMIT 1) AS draft_status,
            (SELECT d.unresolved_facts FROM content_drafts d WHERE d.content_item_id = ci.id AND d.site_id = ci.site_id ORDER BY d.version DESC LIMIT 1) AS unresolved_facts,
            (SELECT q.verdict FROM quality_reviews q
               WHERE q.site_id = ci.site_id AND q.subject_type = 'draft'
                 AND q.subject_id = (SELECT d.id FROM content_drafts d WHERE d.content_item_id = ci.id AND d.site_id = ci.site_id ORDER BY d.version DESC LIMIT 1)
               ORDER BY q.created_at DESC LIMIT 1) AS review_verdict,
            (SELECT MAX(pb.implemented_at) FROM publications pb JOIN content_drafts d2 ON pb.subject_type = 'draft' AND pb.subject_id = d2.id
               WHERE d2.content_item_id = ci.id AND pb.site_id = ci.site_id) AS published_at
     FROM content_items ci
     WHERE ci.site_id = ? AND ci.stage NOT IN ('rejected', 'deferred')
     ORDER BY CASE ci.stage
       WHEN 'in_review' THEN 0 WHEN 'quality_checked' THEN 1 WHEN 'drafted' THEN 2 WHEN 'approved' THEN 3 WHEN 'exported' THEN 4
       WHEN 'briefed' THEN 5 WHEN 'prioritized' THEN 6 WHEN 'published' THEN 7 WHEN 'measuring' THEN 8 ELSE 9 END,
       ci.priority_score DESC, ci.updated_at DESC
     LIMIT ?`,
    [siteId, limit],
  );
  const total = Object.entries(stages).filter(([s]) => s !== 'rejected' && s !== 'deferred').reduce((a, [, n]) => a + n, 0);
  return { items, stages, total };
}

/**
 * Latest draft of each live content item that is waiting on the owner:
 * status needs_human_review, or unresolved facts (publication stays blocked).
 */
export function draftsAwaitingOwner(db: Db, siteId: string): { rows: Array<{ id: string; title: string; status: string; unresolved_facts: number }>; total: number; needsReview: number; unresolvedFacts: number } {
  const rows = db.all<{ id: string; title: string; status: string; unresolved_facts: number }>(
    `SELECT d.id, ci.title, d.status, d.unresolved_facts
       FROM content_drafts d
       JOIN content_items ci ON ci.id = d.content_item_id AND ci.site_id = d.site_id
      WHERE d.site_id = ? AND ci.stage NOT IN ('rejected', 'deferred', 'published', 'measuring')
        AND d.version = (SELECT MAX(d2.version) FROM content_drafts d2 WHERE d2.site_id = d.site_id AND d2.content_item_id = d.content_item_id)
        AND (d.status = 'needs_human_review' OR (d.unresolved_facts > 0 AND d.status NOT IN ('rejected', 'superseded', 'exported', 'published')))
      ORDER BY d.created_at, d.id`,
    [siteId],
  );
  return {
    rows,
    total: rows.length,
    needsReview: rows.filter((r) => r.status === 'needs_human_review').length,
    unresolvedFacts: rows.filter((r) => Number(r.unresolved_facts) > 0).length,
  };
}

export function pendingApprovals(db: Db, siteId: string, nowIso: string, limit: number): { rows: Array<{ id: string; action_type: string; target: string; summary: string; requested_at: string; expires_at: string }>; total: number } {
  const rows = db.all<{ id: string; action_type: string; target: string; summary: string; requested_at: string; expires_at: string }>(
    `SELECT id, action_type, target, summary, requested_at, expires_at FROM approvals WHERE site_id = ? AND status = 'pending' AND expires_at > ? ORDER BY requested_at LIMIT ?`,
    [siteId, nowIso, limit],
  );
  const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM approvals WHERE site_id = ? AND status = 'pending' AND expires_at > ?`, [siteId, nowIso]);
  return { rows, total: Number(total?.n ?? 0) };
}

export function bestOpportunity(db: Db, siteId: string): { id: string; kind: string; route: string; page_id: string | null; page_url: string | null; query: string | null; score: number | null; status: string; raw_counts_json: string | null; updated_at: string } | undefined {
  return db.get(
    `SELECT o.id, o.kind, o.route, o.page_id, p.url AS page_url, o.query, o.score, o.status, o.raw_counts_json, o.updated_at
     FROM opportunities o LEFT JOIN pages p ON p.id = o.page_id
     WHERE o.site_id = ? AND o.status IN ('shortlisted', 'researching', 'recommended')
     ORDER BY CASE o.status WHEN 'recommended' THEN 0 WHEN 'researching' THEN 1 ELSE 2 END, o.score DESC, o.updated_at DESC LIMIT 1`,
    [siteId],
  );
}

/** Unknown-amount charges for one budget month. Synthetic fixture/sandbox calls and requests are excluded (never real spend). */
/**
 * The budget time zone of a site from its active configuration
 * (reporting.businessTimezone, else scheduler.timezone: the same rule as
 * app/context.ts budgetTimeZone). Null when no valid zone is recorded.
 */
export function siteBudgetTimeZone(db: Db, siteId: string): string | null {
  const row = db.get<{ business: string | null; scheduler: string | null }>(
    `SELECT json_extract(c.config_json, '$.reporting.businessTimezone') AS business, json_extract(c.config_json, '$.scheduler.timezone') AS scheduler
       FROM sites s JOIN config_versions c ON c.site_id = s.id AND c.version = s.active_config_version
      WHERE s.id = ?`,
    [siteId],
  );
  const tz = row?.business ?? row?.scheduler ?? null;
  return tz && isValidTimeZone(tz) ? tz : null;
}

/**
 * Charges of unknown amount in one budget month ('YYYY-MM' in the budget time
 * zone), synthetic fixture rows excluded.
 *
 * - Ledger entries: by their stored period_month (budget time zone).
 * - LLM calls: by the budget month of their linked reservation
 *   (budget_reservations.period_month), so a call just after local midnight
 *   on a month boundary lands in the same month as its budget reservation.
 *   A call without a reservation is bucketed by the LOCAL month of created_at
 *   in `timeZone` (default: the site's budget time zone), never by the UTC
 *   month of the timestamp.
 */
export function unknownCostCounts(db: Db, siteId: string, periodMonth: string, timeZone?: string): { ledgerUnknown: number; llmUnknown: number; ambiguousRequests: number } {
  const ledger = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM cost_ledger cl LEFT JOIN provider_requests pr ON pr.id = cl.provider_request_id AND pr.site_id = cl.site_id
     WHERE cl.site_id = ? AND cl.period_month = ? AND cl.amount_status = 'unknown' AND COALESCE(pr.is_synthetic, 0) = 0 AND cl.is_synthetic = 0`,
    [siteId, periodMonth],
  );
  const linked = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM llm_calls lc JOIN budget_reservations br ON br.id = lc.reservation_id AND br.site_id = lc.site_id
     WHERE lc.site_id = ? AND lc.cost_status = 'unknown' AND lc.is_synthetic = 0 AND br.period_month = ?`,
    [siteId, periodMonth],
  );
  const tz = timeZone ?? siteBudgetTimeZone(db, siteId);
  let unlinked = 0;
  const month = /^(\d{4})-(\d{2})$/.exec(periodMonth);
  if (month) {
    // Loose UTC bounds (one day either side of the local month); the exact local month is checked below.
    const first = `${periodMonth}-01`;
    const next = Number(month[2]) === 12 ? `${Number(month[1]) + 1}-01-01` : `${month[1]}-${String(Number(month[2]) + 1).padStart(2, '0')}-01`;
    const rows = db.all<{ created_at: string }>(
      `SELECT lc.created_at FROM llm_calls lc LEFT JOIN budget_reservations br ON br.id = lc.reservation_id AND br.site_id = lc.site_id
       WHERE lc.site_id = ? AND lc.cost_status = 'unknown' AND lc.is_synthetic = 0 AND br.id IS NULL AND lc.created_at >= ? AND lc.created_at < ?`,
      [siteId, `${addDays(first, -1)}T00:00:00.000Z`, `${addDays(next, 1)}T00:00:00.000Z`],
    );
    unlinked = rows.filter((r) => {
      const at = new Date(r.created_at);
      if (Number.isNaN(at.getTime())) return false;
      // Without any recorded zone the UTC month is the only month available.
      return (tz ? dateInZone(at, tz) : r.created_at.slice(0, 10)).slice(0, 7) === periodMonth;
    }).length;
  }
  const amb = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM provider_requests WHERE site_id = ? AND status = 'ambiguous' AND is_synthetic = 0`, [siteId]);
  return { ledgerUnknown: Number(ledger?.n ?? 0), llmUnknown: Number(linked?.n ?? 0) + unlinked, ambiguousRequests: Number(amb?.n ?? 0) };
}

/** UTC instants bounding local dates [start, end] in `tz` with a one-day margin; callers filter precisely. */
export function looseIsoBounds(start: string, end: string): { from: string; to: string } {
  return { from: `${addDays(start, -1)}T00:00:00.000Z`, to: `${addDays(end, 2)}T00:00:00.000Z` };
}
