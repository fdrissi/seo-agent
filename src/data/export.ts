import type { AppContext } from '../app/context.js';
import { AppError } from '../core/errors.js';
import { assertIsoDate } from '../core/time.js';
import { redact } from '../security/redact.js';
import { toCsv, type CellValue } from './csv.js';

/**
 * `data export <dataset>`: CSV or JSON over ONE dataset at its stored grain.
 *
 * - Metric datasets read the *_current views (latest revision only) and are
 *   exported row by row at their unique key: nothing is aggregated, and no
 *   export ever mixes property totals, page rows, and query rows (each is its
 *   own dataset with its own grain note).
 * - Missing stays missing: NULL is an empty CSV cell / JSON null, never 0.
 *   Unknown costs keep amount_usd_micros NULL with amount_status 'unknown'.
 * - Provenance columns (batch, collection time, transformation version,
 *   synthetic flag) travel with every metric row.
 * - Text passes through secret redaction; CSV text cells get the spreadsheet
 *   formula guard (see csv.ts).
 * - Synthetic data stays labeled. containsSynthetic is true when any row is
 *   synthetic, or when the export comes from a demo workspace or a demo site
 *   (ctx.synthetic, sites.is_demo = 1: every row there is synthetic). Datasets
 *   whose table stores no synthetic flag (recommendations, opportunities,
 *   keywords) get a derived is_synthetic column from that demo flag. A CSV
 *   export of a demo workspace or site starts with a `# SYNTHETIC ...` comment
 *   line (SYNTHETIC_EXPORT_COMMENT), which `data import` reads as a synthetic
 *   declaration, so a re-import is labeled synthetic (and a live workspace
 *   refuses it).
 */

export const DATA_EXPORT_VERSION = 'data-export@1';

/**
 * First line of a CSV export from a demo workspace or demo site. A leading
 * `#` comment that names SYNTHETIC declares the file synthetic to `data import`
 * (and to csv.ts leadingComments); no comma, so a spreadsheet keeps it in one cell.
 */
export function syntheticExportComment(dataset: string): string {
  return `# SYNTHETIC data - fixture or demo rows and not real measurements (seo-agent ${DATA_EXPORT_VERSION} ${dataset} from a demo workspace). Import it only into a demo workspace.`;
}

type Filter = { kind: 'date'; column: string } | { kind: 'period' } | { kind: 'timestamp'; column: string };

export interface ExportDataset {
  /** Source view or table (fixed identifier). */
  source: string;
  grain: string;
  uniqueKey: string[];
  columns: string[];
  orderBy: string;
  filter: Filter;
  notes: string[];
  /**
   * Derived columns: SQL expression per column name (fixed in this registry,
   * never from input). Every other column is read as stored.
   */
  expressions?: Readonly<Record<string, string>>;
  /**
   * The source table stores no synthetic flag: the is_synthetic column is
   * derived (1 for a demo site, sites.is_demo = 1, or a demo workspace context).
   */
  derivedSynthetic?: boolean;
}

const GSC_PROV = ['revision', 'batch_id', 'collected_at', 'transformation_version', 'is_synthetic'];

/** Derived is_synthetic for a table without the column: the demo flag of the row's site (a fixed identifier, never input). */
function siteDemoFlag(table: string): string {
  return `(SELECT s.is_demo FROM sites s WHERE s.id = ${table}.site_id)`;
}
const DERIVED_SYNTHETIC_NOTE = 'is_synthetic is derived (this table stores no per-row flag): 1 when the site is a demo site with synthetic data (sites.is_demo = 1, or a demo workspace). A synthetic row is never live data.';

export const EXPORT_DATASETS = {
  'gsc-property': {
    source: 'gsc_property_daily_current',
    grain: 'one row per (property, search_type, date): Search Console property totals (aggregation byProperty)',
    uniqueKey: ['property', 'search_type', 'date'],
    columns: ['property', 'search_type', 'date', 'date_tz', 'clicks', 'impressions', 'ctr', 'position', 'aggregation_type', 'is_final', ...GSC_PROV],
    orderBy: 'property, search_type, date',
    filter: { kind: 'date', column: 'date' },
    notes: ['Property totals. Never add page or query rows to them: Search Console aggregates by property and by page differently.', 'ctr and position are as reported per day; aggregate CTR as SUM(clicks) / SUM(impressions) and position weighted by impressions.'],
  },
  'gsc-pages': {
    source: 'gsc_page_daily_current',
    grain: 'one row per (property, search_type, date, page, segment_key): Search Console page totals (aggregation byPage)',
    uniqueKey: ['property', 'search_type', 'date', 'page', 'segment_key'],
    columns: ['property', 'search_type', 'date', 'date_tz', 'page', 'page_id', 'segment_key', 'country', 'device', 'search_appearance', 'clicks', 'impressions', 'ctr', 'position', 'aggregation_type', 'is_final', ...GSC_PROV],
    orderBy: 'property, search_type, date, page, segment_key',
    filter: { kind: 'date', column: 'date' },
    notes: ['Page totals are not additive with property totals.', 'Rows with a non-empty segment_key are a separate country/device/appearance breakdown: never add them to segment_key = "" rows.'],
  },
  'gsc-queries': {
    source: 'gsc_page_query_daily_current',
    grain: 'one row per (property, search_type, date, page, query, segment_key): visible page/query rows (targeted detail)',
    uniqueKey: ['property', 'search_type', 'date', 'page', 'query', 'segment_key'],
    columns: ['property', 'search_type', 'date', 'date_tz', 'page', 'page_id', 'query', 'segment_key', 'country', 'device', 'clicks', 'impressions', 'ctr', 'position', 'aggregation_type', 'is_final', ...GSC_PROV],
    orderBy: 'property, search_type, date, page, query, segment_key',
    filter: { kind: 'date', column: 'date' },
    notes: ['Visible query rows omit anonymized queries and are subject to row limits: never sum them as page or site totals.'],
  },
  'ga4-landing': {
    source: 'ga4_landing_daily_current',
    grain: 'one row per (property_id, date, channel_view, landing_page, host_name, segment_key): GA4 landing-page sessions',
    uniqueKey: ['property_id', 'date', 'channel_view', 'landing_page', 'host_name', 'segment_key'],
    columns: [
      'property_id', 'date', 'date_tz', 'channel_view', 'landing_page', 'host_name', 'page_id', 'segment_key', 'sessions', 'engaged_sessions', 'key_events',
      'primary_event_name', 'primary_key_events', 'primary_key_events_status', 'primary_session_rate', 'primary_session_rate_status', 'primary_session_rate_scale',
      'revenue_micros', 'revenue_currency', 'revenue_status', 'is_complete', ...GSC_PROV,
    ],
    orderBy: 'property_id, channel_view, date, landing_page, host_name, segment_key',
    filter: { kind: 'date', column: 'date' },
    notes: [
      'google_organic is a subset of all_organic: the channel views are separate and are never added.',
      'Rates are not additive: aggregate them session-weighted. primary_session_rate_scale "undetermined" means the value is exactly as GA4 reported it (0-1 vs 0-100 not established): do not treat it as a fraction.',
      'Primary key events are occurrences (repeatable), not sessions or users.',
    ],
  },
  'ga4-events': {
    source: 'ga4_event_daily_current',
    grain: "one row per (property_id, date, channel_view, event_name, landing_page): GA4 event occurrences (landing_page '' = all landing pages)",
    uniqueKey: ['property_id', 'date', 'channel_view', 'event_name', 'landing_page'],
    columns: ['property_id', 'date', 'date_tz', 'channel_view', 'event_name', 'landing_page', 'event_count', 'key_event_count', 'is_complete', ...GSC_PROV],
    orderBy: 'property_id, channel_view, date, event_name, landing_page',
    filter: { kind: 'date', column: 'date' },
    notes: ["Rows with landing_page '' are totals across landing pages: never add per-landing rows to them.", 'Event counts are occurrences, not sessions or users.'],
  },
  'ga4-period': {
    source: 'ga4_period_metrics_current',
    grain: 'one row per (property_id, period_start, period_end, channel_view, landing_page, metric): period-level GA4 metrics',
    uniqueKey: ['property_id', 'period_start', 'period_end', 'channel_view', 'landing_page', 'metric'],
    columns: ['property_id', 'period_start', 'period_end', 'date_tz', 'channel_view', 'landing_page', 'metric', 'value', 'value_status', 'rate_scale', 'is_complete', ...GSC_PROV],
    orderBy: 'property_id, channel_view, period_start, period_end, landing_page, metric',
    filter: { kind: 'period' },
    notes: ['Users and rates are period-grain: never sum them across periods, days, or landing pages.', 'rate_scale "undetermined": value exactly as GA4 reported it (0-1 vs 0-100 not established).'],
  },
  recommendations: {
    source: 'recommendations',
    grain: 'one row per recommendation (primary, secondary, no_action, repair_measurement, collect_more_evidence)',
    uniqueKey: ['id'],
    columns: ['id', 'job_id', 'opportunity_id', 'kind', 'action_type', 'title', 'page_id', 'query', 'diagnosis', 'proposed_change', 'hypothesis', 'success_criteria', 'risks', 'review_date', 'status', 'prompt_version', 'model_id', 'scoring_version', 'created_at', 'updated_at', 'is_synthetic'],
    orderBy: 'created_at, id',
    filter: { kind: 'timestamp', column: 'created_at' },
    expressions: { is_synthetic: siteDemoFlag('recommendations') },
    derivedSynthetic: true,
    notes: ['An exported recommendation authorizes nothing: production changes still need an approval bound to the exact proposal.', DERIVED_SYNTHETIC_NOTE],
  },
  opportunities: {
    source: 'opportunities',
    grain: 'one row per opportunity (page, page/query, content, technical, measurement, internal link)',
    uniqueKey: ['id'],
    columns: ['id', 'route_decision_id', 'kind', 'route', 'page_id', 'query', 'is_branded', 'score', 'score_components_json', 'raw_counts_json', 'scoring_version', 'status', 'status_reason', 'period_start', 'period_end', 'created_at', 'updated_at', 'is_synthetic'],
    orderBy: 'created_at, id',
    filter: { kind: 'timestamp', column: 'created_at' },
    expressions: { is_synthetic: siteDemoFlag('opportunities') },
    derivedSynthetic: true,
    notes: ['Scores are relative priorities, not forecasts; raw counts are kept next to them.', DERIVED_SYNTHETIC_NOTE],
  },
  costs: {
    source: 'cost_ledger',
    grain: 'one row per recorded charge (cost ledger entry)',
    uniqueKey: ['id'],
    columns: ['id', 'provider', 'reservation_id', 'provider_request_id', 'amount_usd_micros', 'amount_status', 'amount_basis', 'source', 'usage_json', 'period_month', 'period_week', 'recorded_at', 'is_synthetic'],
    orderBy: 'recorded_at, id',
    filter: { kind: 'timestamp', column: 'recorded_at' },
    // A free sandbox/fixture request settled at a verified $0 (usage priceBasis 'fixed_zero', or any synthetic $0
    // entry) is stored with source computed_from_usage but was not computed: it is exported as 'fixed_zero'.
    // CASE (not AND) guards json_extract, so a malformed usage_json can never fail the export.
    expressions: {
      amount_basis:
        "CASE WHEN amount_status = 'actual' AND source = 'computed_from_usage' AND amount_usd_micros = 0 AND (is_synthetic = 1 OR (CASE WHEN json_valid(usage_json) THEN json_extract(usage_json, '$.priceBasis') END) = 'fixed_zero') THEN 'fixed_zero' WHEN amount_status = 'actual' AND source = 'computed_from_usage' THEN 'computed' ELSE amount_status END",
    },
    notes: [
      'Amounts are integer USD micros. amount_status "unknown" keeps amount_usd_micros empty: an unknown cost is never $0.',
      'amount_basis "computed": the amount was computed from usage at list price, not provider-reported (source computed_from_usage, because the provider reported no charge). amount_status stays "actual" because it counts toward the budget limits; the provider bill may differ.',
      'amount_basis "fixed_zero": a free sandbox or fixture request settled at a verified $0 (price basis fixed_zero). It was not computed from usage and nothing was charged; the source column still reads computed_from_usage for schema reasons.',
      'amount_basis "actual": reported by the provider or gateway (source provider_reported / gateway_reported), or entered by a named human from the provider billing history (source manual).',
      'is_synthetic 1: a fixture, sandbox, or demo entry. No real charge was made; never add it to real spend.',
    ],
  },
  keywords: {
    source: 'keywords',
    grain: 'one row per keyword (site, normalized text, language)',
    uniqueKey: ['normalized', 'language'],
    columns: ['id', 'keyword', 'normalized', 'language', 'is_branded', 'intent', 'intent_source', 'cluster_id', 'first_seen_at', 'origins_json', 'is_synthetic'],
    orderBy: 'normalized, language',
    filter: { kind: 'timestamp', column: 'first_seen_at' },
    expressions: { is_synthetic: siteDemoFlag('keywords') },
    derivedSynthetic: true,
    notes: ['Search volumes are provider estimates and live in keyword_metrics; they are not part of this dataset.', DERIVED_SYNTHETIC_NOTE],
  },
} as const satisfies Record<string, ExportDataset>;

export type ExportDatasetName = keyof typeof EXPORT_DATASETS;
export const EXPORT_DATASET_NAMES = Object.keys(EXPORT_DATASETS) as ExportDatasetName[];

export function isExportDataset(v: string): v is ExportDatasetName {
  return (EXPORT_DATASET_NAMES as string[]).includes(v);
}

export interface ExportResult {
  dataset: ExportDatasetName;
  siteId: string;
  source: string;
  grain: string;
  uniqueKey: string[];
  notes: string[];
  filters: { from: string | null; to: string | null; appliesTo: string };
  exportedAt: string;
  transformationVersion: string;
  rowCount: number;
  /**
   * True when any exported row is synthetic (fixture/demo data), or when the
   * export comes from a demo workspace or demo site (every row there is synthetic).
   */
  containsSynthetic: boolean;
  /**
   * True when the export comes from a demo workspace or a demo site
   * (ctx.synthetic or sites.is_demo = 1). A CSV export then starts with the
   * `# SYNTHETIC ...` comment line (syntheticExportComment).
   */
  demoData: boolean;
  columns: string[];
  rows: Array<Record<string, CellValue>>;
}

export function exportDataset(ctx: AppContext, dataset: string, opts: { from?: string | null; to?: string | null } = {}): ExportResult {
  if (!isExportDataset(dataset)) throw new AppError('VALIDATION_FAILED', `Unknown dataset "${dataset}". Use one of: ${EXPORT_DATASET_NAMES.join(', ')}.`);
  const def: ExportDataset = EXPORT_DATASETS[dataset];
  const from = opts.from ?? null;
  const to = opts.to ?? null;
  if (from) assertIsoDate(from);
  if (to) assertIsoDate(to);
  if (from && to && from > to) throw new AppError('VALIDATION_FAILED', `--from ${from} is after --to ${to}.`);
  const where = ['site_id = ?'];
  const params: unknown[] = [ctx.siteId];
  let appliesTo: string;
  const f = def.filter;
  if (f.kind === 'date') {
    appliesTo = `${f.column} (reporting date)`;
    if (from) (where.push(`${f.column} >= ?`), params.push(from));
    if (to) (where.push(`${f.column} <= ?`), params.push(to));
  } else if (f.kind === 'period') {
    appliesTo = 'period_start >= from and period_end <= to (whole periods only)';
    if (from) (where.push('period_start >= ?'), params.push(from));
    if (to) (where.push('period_end <= ?'), params.push(to));
  } else {
    appliesTo = `${f.column} (UTC date)`;
    if (from) (where.push(`substr(${f.column}, 1, 10) >= ?`), params.push(from));
    if (to) (where.push(`substr(${f.column}, 1, 10) <= ?`), params.push(to));
  }
  // Identifiers and derived-column expressions come from the fixed dataset registry above, never from input.
  const select = def.columns.map((c) => (def.expressions?.[c] ? `${def.expressions[c]} AS ${c}` : c)).join(', ');
  const stored = ctx.db.all<Record<string, CellValue>>(`SELECT ${select} FROM ${def.source} WHERE ${where.join(' AND ')} ORDER BY ${def.orderBy}`, params);
  const demoData = ctx.synthetic || siteIsDemo(ctx);
  // A derived flag also follows the context: a demo workspace's rows are synthetic whatever the site row says.
  const rows = def.derivedSynthetic && demoData ? stored.map((r) => ({ ...r, is_synthetic: 1 })) : stored;
  const safeRows = redact(rows);
  return {
    dataset,
    siteId: ctx.siteId,
    source: def.source,
    grain: def.grain,
    uniqueKey: [...def.uniqueKey],
    notes: [...def.notes],
    filters: { from, to, appliesTo },
    exportedAt: ctx.clock.now().toISOString(),
    transformationVersion: DATA_EXPORT_VERSION,
    rowCount: safeRows.length,
    containsSynthetic: demoData || (def.columns.includes('is_synthetic') && safeRows.some((r) => Number(r.is_synthetic) === 1)),
    demoData,
    columns: [...def.columns],
    rows: safeRows,
  };
}

/** True when the context's site is registered as a demo site (sites.is_demo = 1). */
function siteIsDemo(ctx: AppContext): boolean {
  return ctx.db.get<{ is_demo: number }>('SELECT is_demo FROM sites WHERE id = ?', [ctx.siteId])?.is_demo === 1;
}

/**
 * Serialize an export. JSON carries the grain, key, notes, filters, and
 * containsSynthetic next to the rows; CSV is the rows only, after a
 * `# SYNTHETIC ...` comment line when the export comes from a demo workspace
 * or demo site (rows with a stored is_synthetic flag carry it in that column).
 */
export function formatExport(r: ExportResult, format: 'csv' | 'json'): string {
  if (format === 'csv') return `${r.demoData ? `${syntheticExportComment(r.dataset)}\r\n` : ''}${toCsv(r.columns, r.rows)}`;
  return `${JSON.stringify(r, null, 2)}\n`;
}
