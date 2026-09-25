import { addDays, eachDate, type IsoDate } from '../core/time.js';
import { parseJson, type Db } from '../database/db.js';
import { activeSiteConfig } from '../database/sites.js';

/**
 * Collection coverage per calendar date, derived from ingestion batches and
 * row finality. It is what lets the metrics layer tell an actual zero (the
 * date was collected and the page had no row) from missing data (the date
 * was never collected) and from incomplete data (fresh/partial dates, or a
 * batch that hit a documented row limit).
 *
 * Batches are scoped to exactly the slice being aggregated:
 *  - GA4: the channel view recorded on the batch request (`request_json.view`);
 *    a successful `all_organic` batch never proves `google_organic` coverage.
 *  - Search Console: the segment set a request produces (extra dimensions
 *    such as country/device, or a fixed searchAppearance filter); a segment
 *    batch never proves coverage of the no-segment page totals.
 * Batches that do not record a view / dimensions (older or fixture batches)
 * are accepted for any slice.
 *
 * Truncation is per date when the batch records it (`coverage_json.truncatedDates`
 * and chunks where pagination stopped); only when a truncated batch records
 * no per-date detail is its whole range treated as truncated.
 *
 * Interrupted collection: a batch stopped by a quota or a request failure
 * records `coverage_json.interrupted = true` and the date ranges it did
 * complete (`collectedRanges`). Dates outside those ranges are NOT covered by
 * that batch: they are 'missing' unless another batch collected them, or
 * flagged `interrupted` (and truncated) when rows from the interrupted batch
 * exist. Incremental syncs use this to backfill exactly those dates.
 *
 * Owner imports (`data import`, source 'import') without --complete cover only
 * the dates they had rows for, and those dates stay truncated. A date covered
 * ONLY by such imports is flagged `importOnly`: reports keep treating it as
 * truncated (absent pages unknown, never zero), and sync planning
 * (coverageGaps) treats it as re-collectable, because the API may hold the
 * rows the file left out (for example a UI export capped at 1000 rows).
 */

export type DateState = 'final' | 'incomplete' | 'missing';

/**
 * Why GA4 may have left a row out of a collected report (response metadata):
 *  - 'other_row':    dataLossFromOtherRow: high-cardinality rows were bucketed
 *                    into an "(other)" row;
 *  - 'thresholding': subjectToThresholding: rows below the privacy thresholds
 *                    may be withheld (GA4 says it can be true even when
 *                    nothing is missing, so absence proves nothing);
 *  - 'sampling':     the report was sampled.
 * A landing page WITHOUT a row on such a date is unknown, not zero. A row
 * that is present is a real row.
 */
export type Ga4RowLoss = 'other_row' | 'thresholding' | 'sampling';

export interface DateCoverage {
  state: DateState;
  /** A covering batch hit a documented row limit or was partial: absent rows may be omitted, not zero. */
  truncated: boolean;
  /**
   * Collection of this date was started but interrupted (quota stop, request
   * failure) and no other batch completed it. Recoverable: a re-sync can
   * collect it, unlike a documented row limit.
   */
  interrupted?: boolean;
  /**
   * Search Console only: every batch covering this date is an owner import
   * without --complete (see gscCoverage). The date stays truncated for
   * reports; sync planning re-collects it (coverageGaps).
   */
  importOnly?: boolean;
  /**
   * GA4 only: every batch covering this date reported that rows may be left
   * out ("(other)" bucketing, thresholding, sampling). The date stays
   * collected (its rows are real), but a slice WITHOUT a row on it is
   * incomplete, never an observed zero.
   */
  rowLoss?: Ga4RowLoss[];
}

export interface CoverageSummary {
  start: IsoDate;
  end: IsoDate;
  byDate: Record<IsoDate, DateCoverage>;
  final: IsoDate[];
  incomplete: IsoDate[];
  missing: IsoDate[];
  truncated: IsoDate[];
  /** Dates whose collection was interrupted and never completed (see DateCoverage.interrupted). */
  interrupted?: IsoDate[];
  /** GA4 dates whose covering reports may leave rows out (see DateCoverage.rowLoss). */
  rowLoss?: IsoDate[];
  warnings: string[];
}

/** Row-loss reasons GA4 reported for one ingestion batch (its stored response metadata). */
export function ga4BatchRowLoss(metadataJson: string | null | undefined): Ga4RowLoss[] {
  const m = parseJson<Record<string, unknown> | null>(metadataJson ?? null, null);
  if (!m || typeof m !== 'object') return [];
  const out: Ga4RowLoss[] = [];
  if (m.dataLossFromOtherRow === true) out.push('other_row');
  if (m.subjectToThresholding === true) out.push('thresholding');
  if (Array.isArray(m.samplingMetadatas) && m.samplingMetadatas.length > 0) out.push('sampling');
  return out;
}

/** Plain-language description of row-loss reasons. */
export function describeRowLoss(reasons: readonly Ga4RowLoss[]): string {
  const text: Record<Ga4RowLoss, string> = {
    other_row: 'rows bucketed into "(other)" (dataLossFromOtherRow)',
    thresholding: 'thresholding (subjectToThresholding: rows may be withheld)',
    sampling: 'sampling',
  };
  return [...new Set(reasons)].map((r) => text[r]).join(', ');
}

const GSC_DATASETS: ReadonlySet<string> = new Set(['gsc_property_daily', 'gsc_page_daily', 'gsc_page_query_daily']);
/** Datasets whose rows carry a segment_key column. */
const GSC_SEGMENTED: ReadonlySet<string> = new Set(['gsc_page_daily', 'gsc_page_query_daily']);
/** Search Console dimensions that define the dataset grain (not a segment). */
const GSC_BASE_DIMENSIONS: ReadonlySet<string> = new Set(['date', 'page', 'query']);
const GSC_SEGMENT_DIMENSIONS: ReadonlySet<string> = new Set(['country', 'device', 'searchAppearance']);

interface BatchRow {
  date_start: string;
  date_end: string;
  status: string;
  truncated: number;
  request_json: string;
  metadata_json: string | null;
  coverage_json: string | null;
}

function requestSearchType(requestJson: string): string | null {
  const j = parseJson<Record<string, unknown>>(requestJson, {});
  const t = j.type ?? j.searchType ?? j.search_type;
  return typeof t === 'string' ? t.toLowerCase() : null;
}

function requestDataState(requestJson: string): string | null {
  const j = parseJson<Record<string, unknown>>(requestJson, {});
  const d = j.dataState ?? j.data_state;
  return typeof d === 'string' ? d.toLowerCase() : null;
}

/** GA4 channel view recorded on a batch request (null when not recorded). */
export function requestChannelView(requestJson: string): string | null {
  const j = parseJson<Record<string, unknown>>(requestJson, {});
  const v = j.view ?? j.channelView ?? j.channel_view;
  return typeof v === 'string' ? v : null;
}

/** Names of the segment dimensions in a segment key, e.g. 'country=usa;device=MOBILE' -> 'country,device'. */
export function segmentShapeOf(segmentKey: string): string {
  if (!segmentKey) return '';
  return segmentKey
    .split(';')
    .map((part) => part.split('=')[0] ?? '')
    .sort()
    .join(',');
}

/**
 * The segment set a Search Console request produces:
 *  - `{ fixed }` for a request filtered to one searchAppearance value (rows keyed 'searchAppearance=<v>'),
 *  - `{ shape }` for extra segment dimensions ('' = no segment),
 *  - null when the request does not record its dimensions (legacy/fixture batch: accepted for any segment).
 */
export function requestSegmentScope(requestJson: string): { shape: string; fixed: string | null } | null {
  const j = parseJson<Record<string, unknown>>(requestJson, {});
  const dims = Array.isArray(j.dimensions) ? j.dimensions.filter((d): d is string => typeof d === 'string') : null;
  const filters: Array<{ dimension: string; expression: string }> = [];
  if (Array.isArray(j.dimensionFilterGroups)) {
    for (const g of j.dimensionFilterGroups) {
      const fs = g && typeof g === 'object' ? (g as { filters?: unknown }).filters : null;
      if (!Array.isArray(fs)) continue;
      for (const f of fs) {
        const o = f && typeof f === 'object' ? (f as Record<string, unknown>) : {};
        if (typeof o.dimension === 'string' && GSC_SEGMENT_DIMENSIONS.has(o.dimension) && typeof o.expression === 'string') filters.push({ dimension: o.dimension, expression: o.expression });
      }
    }
  }
  if (dims === null && filters.length === 0) return null;
  const segDims = (dims ?? []).filter((d) => !GSC_BASE_DIMENSIONS.has(d));
  const shape = [...new Set([...segDims, ...filters.map((f) => f.dimension)])].sort().join(',');
  const sa = filters.find((f) => f.dimension === 'searchAppearance');
  return { shape, fixed: sa && segDims.length === 0 && filters.length === 1 ? `searchAppearance=${sa.expression}` : null };
}

function batchCoversSegment(b: BatchRow, segmentKey: string): boolean {
  const scope = requestSegmentScope(b.request_json);
  if (scope === null) return true;
  if (scope.fixed) return scope.fixed === segmentKey;
  return scope.shape === segmentShapeOf(segmentKey);
}

/**
 * The dates an owner import recorded per segment shape at import time
 * (`coverage_json.importScope.datesByShape`: every date the file had a valid
 * row for, including rows that were unchanged or kept from a Google sync).
 * Null when the batch did not record it (batches imported before it was
 * recorded).
 */
export function importRecordedDates(coverageJson: string | null | undefined): Map<string, Set<string>> | null {
  const cov = parseJson<Record<string, unknown> | null>(coverageJson ?? null, null);
  const scope = cov && typeof cov === 'object' && cov.importScope && typeof cov.importScope === 'object' ? (cov.importScope as Record<string, unknown>) : null;
  const by = scope && scope.datesByShape && typeof scope.datesByShape === 'object' && !Array.isArray(scope.datesByShape) ? (scope.datesByShape as Record<string, unknown>) : null;
  if (!by) return null;
  const out = new Map<string, Set<string>>();
  for (const [shape, dates] of Object.entries(by)) {
    if (!Array.isArray(dates)) continue;
    out.set(shape, new Set(dates.filter((d): d is string => typeof d === 'string')));
  }
  return out;
}

/**
 * What an owner import (`data import`, source 'import') collected for one
 * segment slice. Imports do not record the request's dimensions; their
 * segment set is the one of the rows they had: a country/device export never
 * proves the no-segment page totals, and vice versa. An import that had no
 * row of the slice proves nothing (null). The dates are the ones the batch
 * recorded at import time (so a re-import whose rows were all unchanged, and
 * therefore wrote no revision, still counts); for older batches that did not
 * record them, the dates of the rows the batch wrote. An older batch that
 * wrote no row falls back to its recorded date range only when it asserted
 * completeness and the dataset has a single shape (property totals): for a
 * segmented dataset its segment set is unknown, so it proves nothing.
 *
 * Completeness is the batch's own flag: an import with `--complete` (not
 * truncated, not partial) covers every date of its range, so a page absent
 * from the file on those dates had no data; an import without it (truncated)
 * covers only the dates it has rows for, and those dates stay truncated, so
 * pages absent from the file are incomplete, never zeros.
 */
function importBatchScope(db: Db, siteId: string, dataset: string, b: BatchRow & { id: string }, segmented: boolean, segmentKey: string): { complete: boolean; dates: Set<string> } | null {
  if (!GSC_DATASETS.has(dataset)) return null;
  const complete = b.truncated !== 1 && b.status !== 'partial';
  const shape = segmentShapeOf(segmentKey);
  const recorded = importRecordedDates(b.coverage_json);
  if (recorded) {
    const dates = recorded.get(shape);
    return dates && dates.size ? { complete, dates } : null;
  }
  const rows = db.all<{ date: string; segment_key: string | null }>(
    `SELECT DISTINCT date, ${segmented ? 'segment_key' : "'' AS segment_key"} FROM ${dataset} WHERE site_id = ? AND batch_id = ?`,
    [siteId, b.id],
  );
  const dates = new Set(rows.filter((r) => segmentShapeOf(r.segment_key ?? '') === shape).map((r) => r.date));
  if (dates.size) return { complete, dates };
  if (complete && !segmented && shape === '' && b.date_start <= b.date_end) return { complete, dates: new Set(eachDate(b.date_start, b.date_end)) };
  return null;
}

/**
 * Dates a truncated/partial batch could not fully collect:
 *  - 'none' when the batch is neither truncated nor partial,
 *  - a set of dates when the batch records them (truncatedDates, chunks stopped by pagination/quota),
 *  - 'all' when it is truncated but records no per-date detail (conservative).
 */
export function batchTruncatedDates(b: Pick<BatchRow, 'truncated' | 'status' | 'coverage_json'>): 'none' | 'all' | Set<string> {
  if (b.truncated !== 1 && b.status !== 'partial') return 'none';
  const cov = parseJson<Record<string, unknown> | null>(b.coverage_json, null);
  if (!cov || typeof cov !== 'object') return 'all';
  const dates = new Set<string>();
  // An interrupted batch records what it completed; its uncollected dates are handled by batchUncollectedDates.
  const interrupted = cov.interrupted === true;
  let recorded = interrupted;
  if (Array.isArray(cov.truncatedDates)) {
    recorded = true;
    for (const d of cov.truncatedDates) if (typeof d === 'string') dates.add(d);
  }
  const retirement = cov.retirement && typeof cov.retirement === 'object' ? (cov.retirement as Record<string, unknown>) : null;
  const chunks = retirement?.skippedChunks;
  if (Array.isArray(chunks)) {
    recorded = true;
    for (const c of chunks) {
      const o = c && typeof c === 'object' ? (c as Record<string, unknown>) : {};
      const reasons = Array.isArray(o.reasons) ? o.reasons.map(String) : [];
      if (typeof o.start !== 'string' || typeof o.end !== 'string') continue;
      // Retirement is also skipped for malformed rows or the row ceiling (already listed per date).
      if (!reasons.some((r) => /pagination|page guard|quota/i.test(r))) continue;
      for (let d = o.start; d <= o.end; d = addDays(d, 1)) dates.add(d);
    }
  }
  if (interrupted) return dates.size ? dates : 'none';
  // A truncated batch that recorded no affected date contradicts itself: be conservative.
  if (!recorded || dates.size === 0) return 'all';
  return dates;
}

/**
 * Dates inside a batch's range that it never collected because it was
 * interrupted (quota stop, request failure). Null when the batch was not
 * interrupted (or does not record it: older batches).
 */
export function batchUncollectedDates(b: Pick<BatchRow, 'date_start' | 'date_end' | 'coverage_json'>): Set<string> | null {
  const cov = parseJson<Record<string, unknown> | null>(b.coverage_json, null);
  if (!cov || typeof cov !== 'object' || cov.interrupted !== true) return null;
  const collected = Array.isArray(cov.collectedRanges) ? cov.collectedRanges : [];
  const out = new Set<string>();
  for (const d of eachDate(b.date_start, b.date_end)) {
    const done = collected.some((r) => {
      const o = r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
      return typeof o.start === 'string' && typeof o.end === 'string' && o.start <= d && d <= o.end;
    });
    if (!done) out.add(d);
  }
  return out;
}

function isUncollectedOn(b: BatchRow, d: IsoDate, cache: Map<BatchRow, Set<string> | null>): boolean {
  let u = cache.get(b);
  if (u === undefined) {
    u = batchUncollectedDates(b);
    cache.set(b, u);
  }
  return u !== null && u.has(d);
}

function isTruncatedOn(b: BatchRow, d: IsoDate, cache: Map<BatchRow, 'none' | 'all' | Set<string>>): boolean {
  let t = cache.get(b);
  if (t === undefined) {
    t = batchTruncatedDates(b);
    cache.set(b, t);
  }
  return t === 'all' ? true : t === 'none' ? false : t.has(d);
}

function summarize(start: IsoDate, end: IsoDate, byDate: Record<IsoDate, DateCoverage>, warnings: string[]): CoverageSummary {
  const interrupted: IsoDate[] = [];
  const rowLoss: IsoDate[] = [];
  const s: CoverageSummary = { start, end, byDate, final: [], incomplete: [], missing: [], truncated: [], interrupted, rowLoss, warnings };
  for (const d of eachDate(start, end)) {
    const c = byDate[d]!;
    s[c.state].push(d);
    if (c.truncated) s.truncated.push(d);
    if (c.interrupted) interrupted.push(d);
    if (c.rowLoss?.length) rowLoss.push(d);
  }
  return s;
}

/**
 * Dates a re-sync should (re)collect: never collected ('missing'),
 * interrupted before collection completed, or known only from owner imports
 * without --complete (`importOnly`: the API may hold rows the file left out).
 * Documented row limits of a sync are NOT gaps: re-requesting returns the
 * same capped rows. For sync planning only: reports read `truncated` and keep
 * treating import-only dates as incomplete.
 */
export function coverageGaps(c: CoverageSummary): IsoDate[] {
  return eachDate(c.start, c.end).filter((d) => {
    const x = c.byDate[d];
    return x?.state === 'missing' || x?.interrupted === true || x?.importOnly === true;
  });
}

/**
 * The Search Console slice analysis queries must be restricted to: the
 * configured property and its primary search type ('web' when configured,
 * else the first configured type). Null when no property is configured.
 * Rows of other properties, search types, or segments are never summed in.
 */
export interface ConfiguredGscScope {
  property: string;
  searchType: string;
}

export function configuredGscScope(config: { google?: { searchConsoleProperty?: string | null; gsc?: { searchTypes?: readonly string[] } } } | null | undefined): ConfiguredGscScope | null {
  const property = config?.google?.searchConsoleProperty ?? null;
  if (!property) return null;
  const types = config?.google?.gsc?.searchTypes ?? [];
  return { property, searchType: types.includes('web') ? 'web' : (types[0] ?? 'web') };
}

/** configuredGscScope of the site's ACTIVE recorded configuration (for callers that only have a Db). */
export function activeGscScope(db: Db, siteId: string): ConfiguredGscScope | null {
  return configuredGscScope(activeSiteConfig(db, siteId) as Parameters<typeof configuredGscScope>[0]);
}

/** Warnings from GA4 response metadata stored on batches (thresholding, sampling, "(other)" bucketing). */
function ga4MetadataWarnings(batches: BatchRow[]): string[] {
  const out = new Set<string>();
  for (const b of batches) {
    const m = parseJson<Record<string, unknown>>(b.metadata_json, {});
    if (m.subjectToThresholding === true) out.add('GA4 reported subjectToThresholding: some rows may be withheld');
    if (Array.isArray(m.samplingMetadatas) && m.samplingMetadatas.length) out.add('GA4 report was sampled');
    if (m.dataLossFromOtherRow === true) out.add('GA4 bucketed some rows into "(other)" (dataLossFromOtherRow)');
  }
  return [...out];
}

/**
 * Search Console coverage for one dataset/property/search type and segment.
 * `dataset` is the target table name recorded on ingestion batches;
 * `segmentKey` ('' = no segment, the default) selects which request sets count.
 */
export function gscCoverage(
  db: Db,
  siteId: string,
  opts: { dataset: 'gsc_property_daily' | 'gsc_page_daily' | 'gsc_page_query_daily'; property: string; searchType: string; start: IsoDate; end: IsoDate; segmentKey?: string },
): CoverageSummary {
  if (!GSC_DATASETS.has(opts.dataset)) throw new RangeError(`Unknown GSC dataset: ${String(opts.dataset)}`);
  const segmentKey = opts.segmentKey ?? '';
  const segmented = GSC_SEGMENTED.has(opts.dataset);
  const uncollected = new Map<BatchRow, Set<string> | null>();
  const batches = db
    .all<BatchRow & { id: string; source: string }>(
      `SELECT id, source, date_start, date_end, status, truncated, request_json, metadata_json, coverage_json FROM ingestion_batches
        WHERE site_id = ? AND source IN ('gsc', 'import') AND dataset = ? AND property = ? AND status IN ('succeeded', 'partial')
          AND date_start <= ? AND date_end >= ?`,
      [siteId, opts.dataset, opts.property, opts.end, opts.start],
    )
    .filter((b) => {
      const t = requestSearchType(b.request_json);
      return (t === null || t === opts.searchType.toLowerCase()) && (b.source === 'import' || batchCoversSegment(b, segmentKey));
    });
  // Owner imports: which dates of this slice they collected (see importBatchScope).
  const imports = new Map<BatchRow, { complete: boolean; dates: Set<string> } | null>();
  for (const b of batches) if (b.source === 'import') imports.set(b, importBatchScope(db, siteId, opts.dataset, b, segmented, segmentKey));
  const collects = (b: BatchRow & { source: string }, d: IsoDate): boolean => {
    if (b.source !== 'import') return !isUncollectedOn(b, d, uncollected);
    const scope = imports.get(b);
    return !!scope && (scope.complete || scope.dates.has(d));
  };
  const rowFinality = new Map(
    db
      .all<{ date: string; mn: number }>(
        `SELECT date, MIN(is_final) AS mn FROM ${opts.dataset} WHERE site_id = ? AND is_current = 1 AND property = ? AND search_type = ?${segmented ? ' AND segment_key = ?' : ''} AND date BETWEEN ? AND ? GROUP BY date`,
        segmented ? [siteId, opts.property, opts.searchType, segmentKey, opts.start, opts.end] : [siteId, opts.property, opts.searchType, opts.start, opts.end],
      )
      .map((r) => [r.date, r.mn === 1]),
  );
  const avail = db.get<{ first_incomplete_date: string | null; latest_final_date: string | null }>(
    'SELECT first_incomplete_date, latest_final_date FROM gsc_data_availability WHERE site_id = ? AND property = ? AND search_type = ? ORDER BY checked_at DESC LIMIT 1',
    [siteId, opts.property, opts.searchType],
  );
  const cache = new Map<BatchRow, 'none' | 'all' | Set<string>>();
  const byDate: Record<IsoDate, DateCoverage> = {};
  for (const d of eachDate(opts.start, opts.end)) {
    const overlapping = batches.filter((b) => b.date_start <= d && b.date_end >= d);
    const covering = overlapping.filter((b) => collects(b, d));
    if (covering.length === 0) {
      // Interrupted sync batches overlap this date but never completed it: recoverable by a re-sync.
      const interrupted = overlapping.some((b) => b.source !== 'import');
      // Rows prove collection even if the batch bookkeeping could not be matched.
      byDate[d] = rowFinality.has(d)
        ? { state: rowFinality.get(d) ? 'final' : 'incomplete', truncated: interrupted, ...(interrupted ? { interrupted } : {}) }
        : { state: 'missing', truncated: false, ...(interrupted ? { interrupted } : {}) };
      continue;
    }
    // A date is fully collected when at least one covering batch collected it without truncation.
    const truncated = covering.every((b) => isTruncatedOn(b, d, cache));
    // Known only from owner imports without --complete: truncated for reports, re-collectable for a sync.
    const importOnly = truncated && covering.every((b) => b.source === 'import' && imports.get(b)?.complete !== true);
    let final: boolean;
    if (rowFinality.has(d)) final = rowFinality.get(d)!;
    else {
      const states = covering.map((b) => requestDataState(b.request_json));
      final = states.some((s) => s === null || s === 'final');
      if (avail?.first_incomplete_date && d >= avail.first_incomplete_date) final = false;
      if (avail?.latest_final_date && d <= avail.latest_final_date) final = true;
    }
    byDate[d] = { state: final ? 'final' : 'incomplete', truncated, ...(importOnly ? { importOnly } : {}) };
  }
  return summarize(opts.start, opts.end, byDate, []);
}

/** GA4 event-report variant recorded on a batch request (null when not recorded). */
function requestVariant(requestJson: string): string | null {
  const j = parseJson<Record<string, unknown>>(requestJson, {});
  return typeof j.variant === 'string' ? j.variant : null;
}

/**
 * GA4 coverage for one property and channel view. Finality comes from
 * is_complete of that view's rows; only batches for that view (or batches
 * that do not record a view) count as collection.
 *
 * `dataset` selects the table ('ga4_landing_daily' by default, or
 * 'ga4_event_daily'); for events, `variant` ('all_landing_pages' |
 * 'by_landing_page') restricts both the batches and the rows to that report.
 */
export function ga4Coverage(
  db: Db,
  siteId: string,
  opts: { propertyId: string; start: IsoDate; end: IsoDate; channelView?: string; segmentKey?: string; dataset?: string; variant?: 'all_landing_pages' | 'by_landing_page' },
): CoverageSummary {
  const view = opts.channelView ?? null;
  const segmentKey = opts.segmentKey ?? '';
  const dataset = opts.dataset ?? 'ga4_landing_daily';
  const variant = opts.variant ?? null;
  const batches = db
    .all<BatchRow>(
      `SELECT date_start, date_end, status, truncated, request_json, metadata_json, coverage_json FROM ingestion_batches
        WHERE site_id = ? AND source = 'ga4' AND dataset = ? AND property = ? AND status IN ('succeeded', 'partial')
          AND date_start <= ? AND date_end >= ?`,
      [siteId, dataset, opts.propertyId, opts.end, opts.start],
    )
    .filter((b) => {
      if (variant !== null) {
        const v = requestVariant(b.request_json);
        if (v !== null && v !== variant) return false;
      }
      if (view === null) return true;
      const v = requestChannelView(b.request_json);
      return v === null || v === view;
    });
  let rowSql: string;
  const rowParams: unknown[] = [siteId, opts.propertyId];
  if (dataset === 'ga4_event_daily') {
    // Event rows have no segment; '' is the "all landing pages" variant.
    rowSql = `SELECT date, MIN(is_complete) AS mn FROM ga4_event_daily WHERE site_id = ? AND is_current = 1 AND property_id = ?${view === null ? '' : ' AND channel_view = ?'}${
      variant === 'all_landing_pages' ? " AND landing_page = ''" : variant === 'by_landing_page' ? " AND landing_page <> ''" : ''
    } AND date BETWEEN ? AND ? GROUP BY date`;
    if (view !== null) rowParams.push(view);
  } else {
    rowSql = `SELECT date, MIN(is_complete) AS mn FROM ga4_landing_daily WHERE site_id = ? AND is_current = 1 AND property_id = ?${view === null ? '' : ' AND channel_view = ?'} AND segment_key = ? AND date BETWEEN ? AND ? GROUP BY date`;
    if (view !== null) rowParams.push(view);
    rowParams.push(segmentKey);
  }
  rowParams.push(opts.start, opts.end);
  const rowCompleteness = new Map(db.all<{ date: string; mn: number }>(rowSql, rowParams).map((r) => [r.date, r.mn === 1]));
  const cache = new Map<BatchRow, 'none' | 'all' | Set<string>>();
  const uncollected = new Map<BatchRow, Set<string> | null>();
  const loss = new Map<BatchRow, Ga4RowLoss[]>(batches.map((b) => [b, ga4BatchRowLoss(b.metadata_json)]));
  const byDate: Record<IsoDate, DateCoverage> = {};
  for (const d of eachDate(opts.start, opts.end)) {
    const overlapping = batches.filter((b) => b.date_start <= d && b.date_end >= d);
    const covering = overlapping.filter((b) => !isUncollectedOn(b, d, uncollected));
    if (covering.length === 0) {
      const interrupted = overlapping.length > 0;
      byDate[d] = rowCompleteness.has(d)
        ? { state: rowCompleteness.get(d) ? 'final' : 'incomplete', truncated: interrupted, ...(interrupted ? { interrupted } : {}) }
        : { state: 'missing', truncated: false, ...(interrupted ? { interrupted } : {}) };
      continue;
    }
    const truncated = covering.every((b) => isTruncatedOn(b, d, cache));
    const complete = rowCompleteness.has(d) ? rowCompleteness.get(d)! : true;
    // Absence proves nothing unless at least one covering report was free of row loss.
    const rowLoss = covering.every((b) => loss.get(b)!.length > 0) ? [...new Set(covering.flatMap((b) => loss.get(b)!))] : [];
    byDate[d] = { state: complete ? 'final' : 'incomplete', truncated, ...(rowLoss.length ? { rowLoss } : {}) };
  }
  return summarize(opts.start, opts.end, byDate, ga4MetadataWarnings(batches));
}

/** Coverage where every date is final and collected (for pure/unit use). */
export function fullCoverage(start: IsoDate, end: IsoDate): CoverageSummary {
  const byDate: Record<IsoDate, DateCoverage> = {};
  for (const d of eachDate(start, end)) byDate[d] = { state: 'final', truncated: false };
  return summarize(start, end, byDate, []);
}

/** Build coverage from explicit per-date states (tests, fixtures, demo). */
export function coverageFrom(start: IsoDate, end: IsoDate, states: Partial<Record<IsoDate, DateState | DateCoverage>>, fallback: DateState = 'missing'): CoverageSummary {
  const byDate: Record<IsoDate, DateCoverage> = {};
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const s = states[d];
    byDate[d] = s === undefined ? { state: fallback, truncated: false } : typeof s === 'string' ? { state: s, truncated: false } : s;
  }
  return summarize(start, end, byDate, []);
}
