import type { AppContext } from '../../app/context.js';
import { AppError, ConfigError } from '../../core/errors.js';
import { newId } from '../../core/ids.js';
import type { RetryPolicy } from '../../core/retry.js';
import { addDays, dateInZone, eachDate } from '../../core/time.js';
import { recordAudit } from '../../database/audit.js';
import { coverageGaps, gscCoverage } from '../../seo/coverage.js';
import { isQuotaStop } from './errors.js';
import {
  GSC_DAILY_ROW_CEILING,
  GSC_MAX_ROW_LIMIT,
  GSC_SEARCH_ANALYTICS_MIN_INTERVAL_MS,
  Pacer,
  GSC_TIME_ZONE,
  normalizeAggregation,
  propertyAggregationFor,
  queryAllPages,
  validateGscPropertyFormat,
  type GscCallContext,
  type GscDimension,
  type GscQueryRequest,
  type GscRow,
  type GscSearchType,
  type PaginatedGscResult,
} from './gsc-client.js';
import { checkCredentialsOffline, type OfflineCredentialCheck } from './credentials-check.js';
import { assertConfiguredPropertyAccessible, assertNetworkAllowed, discoverGscProperties } from './gsc-properties.js';
import { inspectUrls, selectPriorityUrls, type InspectUrlsResult } from './url-inspection.js';
import type { GoogleAuthProvider } from './types.js';
import { emptyCounts, finishBatch, revisionKey, settleScope, startBatch, tally, upsertRevision, type BatchCounts, type RetireScope, type RevisionMeta, type VersionedTable } from './versioned.js';

/**
 * Search Console ingestion into three SEPARATE datasets:
 *  - gsc_property_daily   property totals (dimension date only, aggregation byProperty)
 *  - gsc_page_daily       page totals (date, page; aggregation byPage)
 *  - gsc_page_query_daily targeted page/query detail for the top N pages (page filter)
 * They are never summed together. Visible query rows omit anonymized queries
 * and are subject to row limits, so they are not page or site totals.
 *
 * Page/query rows stored as not final are re-requested once Google reports
 * their dates as final, also for pages that have left the top N (and from
 * their earliest not-final date for pages still in it), so a page that drops
 * out and comes back never keeps not-final rows forever. Rows still not final
 * after a sync are reported as a warning and keep the sync 'partial'.
 */

export const GSC_TRANSFORMATION_VERSION = 'gsc-ingest@1';
/** Upper bound on history: Search Console keeps about 16 months (GSC26). */
export const GSC_MAX_HISTORY_DAYS = 486;
/**
 * When Google reports no first_incomplete_date, the last N days (including
 * today, Pacific time) are still treated as not final. The docs say absence
 * means "no incomplete points", but the metadata casing on the wire is
 * unverified, so this conservative default only delays finality.
 */
export const GSC_ASSUMED_INCOMPLETE_DAYS = 4;

export type GscSegment = 'country' | 'device' | 'searchAppearance';

export interface SyncGscOptions {
  provider: GoogleAuthProvider;
  /** Override the history window (days ending yesterday, Pacific time). */
  days?: number;
  dryRun?: boolean;
  searchTypes?: GscSearchType[];
  /** Optional segment dimensions, only when the analysis requires them. */
  segments?: GscSegment[];
  topPages?: number;
  includePageQuery?: boolean;
  /** Rows per API page (default 25,000, the documented maximum). */
  rowLimit?: number;
  /** Days per page-total request (default 1: Google recommends one day at a time for coverage). */
  pageChunkDays?: number;
  maxPagesPerQuery?: number;
  retry?: RetryPolicy;
  /** Inspect this many priority URLs after syncing (bounded by config urlInspectionMaxPerRun). */
  inspect?: number;
  baseUrl?: string;
  /** Minimum ms between Search Analytics calls (default 55 for live providers, 0 for fixtures). */
  pacingMs?: number;
}

export interface GscDatasetResult {
  dataset: VersionedTable;
  searchType: GscSearchType;
  segmentKey: string;
  batchId: string | null;
  status: 'succeeded' | 'partial' | 'failed' | 'skipped';
  rowsReceived: number;
  rowsNewRevision: number;
  rowsRevised: number;
  rowsUnchanged: number;
  /** Current rows of earlier syncs retired because a complete request over the same scope no longer returned them. */
  rowsRetired: number;
  /** Current rows not returned by an INCOMPLETE request; kept current because absence proves nothing there. */
  rowsStaleRetained: number;
  apiPages: number;
  truncated: boolean;
  warnings: string[];
  /**
   * gsc_page_query_daily only: current rows still stored as not final for
   * dates Search Console now reports as final (in the history window) after
   * this sync. Their queries count as incomplete for those dates until a
   * later sync settles them. Absent when there are none.
   */
  notFinalRows?: GscNotFinalRows;
}

/** Page/query rows left not final for dates that are final at the source. */
export interface GscNotFinalRows {
  pages: number;
  rows: number;
  firstDate: string;
  lastDate: string;
}

export interface GscAvailability {
  searchType: GscSearchType;
  firstIncompleteDate: string | null;
  firstIncompleteSource: 'api' | 'assumed' | 'none_in_range';
  latestFinalDate: string | null;
  latestAnyDate: string | null;
}

/** Start of one dataset's request range within a GscRangePlan. */
export interface GscDatasetRange {
  dataset: VersionedTable;
  start: string;
  /** Earliest date re-requested because earlier syncs never (fully) collected it; null = plain refresh. */
  backfillFrom: string | null;
  /** Dates before the refresh start that were missing or interrupted (quota stop, request failure). */
  gapDates: number;
}

export interface GscRangePlan {
  searchType: GscSearchType;
  /** Earliest start over all datasets. */
  start: string;
  end: string;
  mode: 'initial' | 'incremental' | 'explicit';
  /**
   * Target window whose coverage is verified after the sync: the history
   * window (google.gsc.initialHistoryDays) for initial/incremental syncs, the
   * requested range for explicit ones.
   */
  window?: { start: string; end: string };
  /** Per-dataset start (unsegmented datasets): the incremental refresh, or earlier to backfill gaps. */
  datasets?: GscDatasetRange[];
}

/** Dates in the target window that are still not collected after a sync. */
export interface GscCoverageGap {
  searchType: GscSearchType;
  dataset: VersionedTable;
  firstDate: string;
  dates: number;
}

export interface SyncGscResult {
  status: 'succeeded' | 'partial' | 'failed' | 'dry_run' | 'disabled';
  property: string | null;
  timeZone: string;
  synthetic: boolean;
  ranges: GscRangePlan[];
  datasets: GscDatasetResult[];
  availability: GscAvailability[];
  warnings: string[];
  /**
   * Dry run only. `credentialCheck`: whether the auth provider's credential
   * resolved locally ('ok'), is the synthetic fixture provider ('fixture'), or
   * could not be checked without a network call ('unverified', also a
   * warning). A missing credential fails the dry run like the real run
   * (CREDENTIALS_MISSING), so a plan is never shown for a sync that cannot run.
   */
  plan?: { estimatedMinRequests: number; datasets: string[]; notes: string[]; credentialCheck?: OfflineCredentialCheck['status'] };
  inspection?: InspectUrlsResult;
  /** Known gaps left in the target window (status is 'partial' while any remain). */
  gaps?: GscCoverageGap[];
}

interface Env {
  ctx: AppContext;
  c: GscCallContext;
  property: string;
  today: string;
  rowLimit: number;
  maxPages: number;
  synthetic: boolean;
  meta: (batchId: string) => RevisionMeta;
}

function segmentDims(segments: GscSegment[] | undefined): GscDimension[] {
  return (['country', 'device'] as const).filter((d) => segments?.includes(d));
}

/** Canonical segment key: 'country=usa;device=MOBILE;searchAppearance=...' (alphabetical). */
export function segmentKeyOf(parts: { country?: string | null; device?: string | null; searchAppearance?: string | null }): string {
  const out: string[] = [];
  if (parts.country) out.push(`country=${parts.country}`);
  if (parts.device) out.push(`device=${parts.device}`);
  if (parts.searchAppearance) out.push(`searchAppearance=${parts.searchAppearance}`);
  return out.join(';');
}

/** Unsegmented datasets whose coverage drives incremental backfill. */
function gapDatasets(includePageQuery: boolean): VersionedTable[] {
  return ['gsc_property_daily', 'gsc_page_daily', ...(includePageQuery ? (['gsc_page_query_daily'] as const) : [])];
}

/** Dates in [start, end] never collected or interrupted, for one unsegmented dataset. */
function datasetGaps(ctx: AppContext, property: string, searchType: GscSearchType, dataset: VersionedTable, start: string, end: string): string[] {
  if (start > end) return [];
  return coverageGaps(gscCoverage(ctx.db, ctx.siteId, { dataset: dataset as 'gsc_property_daily' | 'gsc_page_daily' | 'gsc_page_query_daily', property, searchType, start, end, segmentKey: '' }));
}

/**
 * Request range per search type. Initial: the history window
 * (initialHistoryDays). Incremental: the recent refresh window (or from the
 * day after the latest final property-total date, if earlier), and, PER
 * DATASET, earlier when recorded coverage shows dates in the history window
 * that were never collected or whose collection was interrupted (quota stop,
 * failed request). Documented row limits are not gaps: re-requesting returns
 * the same capped rows. Bounded by GSC_MAX_HISTORY_DAYS.
 */
export function computeGscRange(ctx: AppContext, property: string, searchType: GscSearchType, today: string, days?: number, opts: { includePageQuery?: boolean } = {}): GscRangePlan {
  const end = addDays(today, -1);
  const floor = addDays(end, -(GSC_MAX_HISTORY_DAYS - 1));
  const clamp = (d: string) => (d < floor ? floor : d > end ? end : d);
  const datasets = gapDatasets(opts.includePageQuery !== false);
  if (days !== undefined) {
    if (!Number.isInteger(days) || days < 1) throw new ConfigError('--days must be a positive integer');
    const start = clamp(addDays(end, -(days - 1)));
    return { searchType, start, end, mode: 'explicit', window: { start, end }, datasets: datasets.map((dataset) => ({ dataset, start, backfillFrom: null, gapDates: 0 })) };
  }
  const windowStart = clamp(addDays(end, -(ctx.config.google.gsc.initialHistoryDays - 1)));
  const last = ctx.db.get<{ d: string | null }>(
    'SELECT MAX(date) AS d FROM gsc_property_daily WHERE site_id = ? AND property = ? AND search_type = ? AND is_current = 1 AND is_final = 1',
    [ctx.siteId, property, searchType],
  )?.d;
  if (!last) {
    return { searchType, start: windowStart, end, mode: 'initial', window: { start: windowStart, end }, datasets: datasets.map((dataset) => ({ dataset, start: windowStart, backfillFrom: null, gapDates: 0 })) };
  }
  const refreshStart = addDays(end, -(ctx.config.google.gsc.refreshRecentDays - 1));
  const gapStart = addDays(last, 1);
  const base = clamp(gapStart < refreshStart ? gapStart : refreshStart);
  const ranges: GscDatasetRange[] = datasets.map((dataset) => {
    const gaps = datasetGaps(ctx, property, searchType, dataset, windowStart, addDays(base, -1));
    return gaps.length ? { dataset, start: clamp(gaps[0]!), backfillFrom: clamp(gaps[0]!), gapDates: gaps.length } : { dataset, start: base, backfillFrom: null, gapDates: 0 };
  });
  const start = ranges.reduce((m, r) => (r.start < m ? r.start : m), base);
  return { searchType, start, end, mode: 'incremental', window: { start: windowStart < start ? windowStart : start, end }, datasets: ranges };
}

/** The request range of one dataset within a plan (the plan start when not recorded). */
function datasetRange(range: GscRangePlan, dataset: VersionedTable): GscRangePlan {
  const start = range.datasets?.find((d) => d.dataset === dataset)?.start ?? range.start;
  return { ...range, start };
}

function resolveFirstIncomplete(res: PaginatedGscResult, today: string, end: string): { date: string | null; source: GscAvailability['firstIncompleteSource'] } {
  if (res.firstIncompleteDate) return { date: res.firstIncompleteDate, source: 'api' };
  const assumed = addDays(today, -(GSC_ASSUMED_INCOMPLETE_DAYS - 1));
  if (assumed > end) return { date: null, source: 'none_in_range' };
  return { date: assumed, source: 'assumed' };
}

function isFinal(date: string, firstIncomplete: string | null): boolean {
  return firstIncomplete === null || date < firstIncomplete;
}

function validRow(row: GscRow, dims: number): boolean {
  return (
    Array.isArray(row?.keys) &&
    row.keys.length === dims &&
    Number.isFinite(row.clicks) &&
    Number.isFinite(row.impressions) &&
    row.clicks >= 0 &&
    row.impressions >= 0
  );
}

function metricValues(row: GscRow) {
  return {
    clicks: Math.round(row.clicks),
    impressions: Math.round(row.impressions),
    ctr: Number.isFinite(row.ctr) ? row.ctr : null,
    position: Number.isFinite(row.position) ? row.position : null,
  };
}

function splitRange(start: string, end: string, chunkDays: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let s = start;
  while (s <= end) {
    let e = addDays(s, chunkDays - 1);
    if (e > end) e = end;
    out.push([s, e]);
    s = addDays(e, 1);
  }
  return out;
}

function datasetResult(dataset: VersionedTable, searchType: GscSearchType, segmentKey: string, batchId: string | null): GscDatasetResult {
  return { dataset, searchType, segmentKey, batchId, status: 'succeeded', rowsReceived: 0, rowsNewRevision: 0, rowsRevised: 0, rowsUnchanged: 0, rowsRetired: 0, rowsStaleRetained: 0, apiPages: 0, truncated: false, warnings: [] };
}

function applyCounts(r: GscDatasetResult, counts: BatchCounts): void {
  r.rowsReceived = counts.received;
  r.rowsNewRevision = counts.newRevisions;
  r.rowsRevised = counts.revised;
  r.rowsUnchanged = counts.unchanged;
  r.rowsRetired = counts.retired;
  r.rowsStaleRetained = counts.staleRetained;
}

/** Names of the optional dimensions encoded in a segment key, e.g. 'country=usa;device=MOBILE' -> 'country,device'. */
export function segmentShape(segmentKey: string): string {
  if (!segmentKey) return '';
  return segmentKey
    .split(';')
    .map((part) => part.split('=')[0] ?? '')
    .sort()
    .join(',');
}

/** Retirement scope restricted to exactly the segment set a request produces. */
function segmentScope(segmentKeyFixed: string, segDims: readonly GscDimension[]): Pick<RetireScope, 'equals' | 'where'> {
  if (segmentKeyFixed) return { equals: { segment_key: segmentKeyFixed } };
  if (!segDims.length) return { equals: { segment_key: '' } };
  const shape = [...segDims].sort().join(',');
  return { equals: {}, where: (k) => segmentShape(String(k.segment_key ?? '')) === shape };
}

function retirementNote(counts: BatchCounts, reasons: string[]): Record<string, unknown> {
  return {
    retiredRows: counts.retired,
    staleRowsRetained: counts.staleRetained,
    retirementSkippedBecause: reasons,
    meaning:
      'Rows returned by an earlier sync but not by this complete request over the same scope were retired (is_current = 0, superseded_by_batch_id = this batch); they are not deleted and not stored as zero. When a request was incomplete, absent rows were kept current and counted as staleRowsRetained.',
  };
}

/**
 * Record an interrupted batch. `collected` lists the date ranges that were
 * completely collected before the failure (e.g. finished page-total chunks);
 * every other date of the batch range is recorded as NOT collected
 * (coverage_json.interrupted / collectedRanges), so coverage reports it as
 * missing or interrupted and the next incremental sync backfills it.
 */
function failBatch(env: Env, r: GscDatasetResult, counts: BatchCounts, rawRefs: string[], coverage: unknown, err: unknown, collected: Array<{ start: string; end: string }> = []): void {
  r.status = counts.received > 0 || collected.length > 0 ? 'partial' : 'failed';
  applyCounts(r, counts);
  const message = err instanceof Error ? err.message : String(err);
  r.warnings.push(`Request failed: ${message}`);
  const cov = {
    ...(coverage && typeof coverage === 'object' ? (coverage as Record<string, unknown>) : {}),
    interrupted: true,
    interruptedBecause: message,
    collectedRanges: collected,
    interruptedMeaning: 'The request set stopped before every date was collected. Dates outside collectedRanges were NOT collected by this batch; they are missing (not zero) and the next incremental sync re-requests them.',
  };
  if (r.batchId) finishBatch(env.ctx, r.batchId, { status: r.status === 'partial' ? 'partial' : 'failed', counts, apiPages: r.apiPages, truncated: r.truncated, coverage: cov, rawRefs, error: err });
  // Let the caller report this dataset even when the error is rethrown.
  if (err && typeof err === 'object') (err as { datasetResult?: GscDatasetResult }).datasetResult = r;
}

async function syncPropertyTotals(env: Env, range: GscRangePlan): Promise<{ result: GscDatasetResult; availability: GscAvailability }> {
  const { ctx } = env;
  const st = range.searchType;
  const aggregation = propertyAggregationFor(st);
  const body: Omit<GscQueryRequest, 'startRow'> = { startDate: range.start, endDate: range.end, dimensions: ['date'], type: st, aggregationType: aggregation, dataState: 'all' };
  const batchId = startBatch(ctx, { source: 'gsc', dataset: 'gsc_property_daily', property: env.property, dateStart: range.start, dateEnd: range.end, request: { ...body, rowLimit: env.rowLimit }, transformationVersion: GSC_TRANSFORMATION_VERSION, synthetic: env.synthetic });
  const r = datasetResult('gsc_property_daily', st, '', batchId);
  const counts = emptyCounts();
  let res: PaginatedGscResult;
  try {
    res = await queryAllPages(env.c, env.property, body, { rowLimit: env.rowLimit, maxPages: env.maxPages });
  } catch (err) {
    failBatch(env, r, counts, [], null, err);
    throw err;
  }
  r.apiPages = res.pages;
  r.truncated = res.stoppedAtMaxPages;
  const fi = resolveFirstIncomplete(res, env.today, range.end);
  const aggType = normalizeAggregation(res.responseAggregationType, aggregation);
  const seen = new Set<string>();
  const returnedKeys = new Set<string>();
  const incompleteReasons: string[] = [];
  let malformed = 0;
  ctx.db.transaction(() => {
    for (const row of res.rows) {
      if (!validRow(row, 1)) {
        malformed++;
        continue;
      }
      const date = row.keys![0]!;
      seen.add(date);
      const key = { property: env.property, search_type: st, date };
      returnedKeys.add(revisionKey('gsc_property_daily', key));
      const o = upsertRevision(ctx.db, 'gsc_property_daily', ctx.siteId, key, { date_tz: GSC_TIME_ZONE, ...metricValues(row), aggregation_type: aggType, is_final: isFinal(date, fi.date) ? 1 : 0 }, env.meta(batchId));
      tally(counts, o);
    }
    if (res.stoppedAtMaxPages) incompleteReasons.push('pagination stopped at the page guard');
    if (malformed) incompleteReasons.push(`${malformed} malformed row(s) could not be keyed`);
    settleScope(ctx.db, 'gsc_property_daily', ctx.siteId, { equals: { property: env.property, search_type: st }, range: { column: 'date', start: range.start, end: range.end } }, returnedKeys, batchId, incompleteReasons, counts);
  });
  const datesWithoutRows = eachDate(range.start, range.end).filter((d) => !seen.has(d));
  if (fi.source === 'assumed') {
    r.warnings.push(`Google reported no first_incomplete_date; dates from ${fi.date} (Pacific time) are conservatively treated as not final.`);
  }
  if (datesWithoutRows.length) {
    r.warnings.push(`${datesWithoutRows.length} date(s) returned no rows. Search Console omits days with no data; they are recorded as missing, not stored as zero.`);
  }
  if (malformed) r.warnings.push(`${malformed} malformed row(s) were skipped.`);
  if (res.stoppedAtMaxPages) r.warnings.push('Pagination stopped at the page guard; data may be incomplete.');
  if (counts.retired) r.warnings.push(`${counts.retired} date(s) stored by an earlier sync are no longer reported by Google; they were retired (not current, not zero).`);
  if (counts.staleRetained) r.warnings.push(`${counts.staleRetained} stored date(s) were not returned, but the response was incomplete (${incompleteReasons.join('; ')}); they stay current.`);
  applyCounts(r, counts);
  r.status = res.stoppedAtMaxPages ? 'partial' : 'succeeded';
  const finalDates = [...seen].filter((d) => isFinal(d, fi.date)).sort();
  const anyDates = [...seen].sort();
  const availability: GscAvailability = {
    searchType: st,
    firstIncompleteDate: fi.date,
    firstIncompleteSource: fi.source,
    latestFinalDate: finalDates.at(-1) ?? null,
    latestAnyDate: anyDates.at(-1) ?? null,
  };
  finishBatch(ctx, batchId, {
    status: r.status === 'partial' ? 'partial' : 'succeeded',
    counts,
    apiPages: res.pages,
    truncated: r.truncated,
    coverage: {
      datesWithoutRows,
      datesWithoutRowsMeaning: 'Search Console omits days with no data. These dates are missing observations, not confirmed zeros.',
      firstIncompleteDate: fi.date,
      firstIncompleteSource: fi.source,
      malformedRows: malformed,
      retirement: retirementNote(counts, incompleteReasons),
      warnings: r.warnings,
    },
    metadata: { responseAggregationType: res.responseAggregationType ?? null, aggregationRequested: aggregation, dataState: 'all', timeZone: GSC_TIME_ZONE, firstIncompleteDate: fi.date, firstIncompleteSource: fi.source, metadataSeen: res.metadataSeen },
    rawRefs: res.rawRefs,
  });
  ctx.db.run(
    `INSERT INTO gsc_data_availability (id, site_id, property, search_type, first_incomplete_date, latest_final_date, latest_any_date, metadata_json, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId('gscav'),
      ctx.siteId,
      env.property,
      st,
      fi.date,
      availability.latestFinalDate,
      availability.latestAnyDate,
      JSON.stringify({ source: fi.source, requestedStart: range.start, requestedEnd: range.end, dataState: 'all', timeZone: GSC_TIME_ZONE, batchId, datesWithoutRows: datesWithoutRows.length }),
      ctx.clock.now().toISOString(),
    ],
  );
  return { result: r, availability };
}

interface PageRequestSet {
  segmentKeyFixed: string;
  dims: GscDimension[];
  filters: { dimension: 'searchAppearance'; operator: 'equals'; expression: string }[];
  searchAppearance: string | null;
}

async function syncPageTotals(env: Env, range: GscRangePlan, firstIncomplete: string | null, set: PageRequestSet, chunkDays: number): Promise<GscDatasetResult> {
  const { ctx } = env;
  const st = range.searchType;
  const baseBody = {
    dimensions: set.dims,
    type: st,
    aggregationType: 'byPage' as const,
    dataState: 'all' as const,
    ...(set.filters.length ? { dimensionFilterGroups: [{ groupType: 'and' as const, filters: set.filters }] } : {}),
  };
  const batchId = startBatch(ctx, { source: 'gsc', dataset: 'gsc_page_daily', property: env.property, dateStart: range.start, dateEnd: range.end, request: { ...baseBody, rowLimit: env.rowLimit, chunkDays }, transformationVersion: GSC_TRANSFORMATION_VERSION, synthetic: env.synthetic });
  const r = datasetResult('gsc_page_daily', st, set.segmentKeyFixed || (set.dims.length > 2 ? `dims:${set.dims.slice(2).join(',')}` : ''), batchId);
  const counts = emptyCounts();
  const rawRefs: string[] = [];
  const rowsPerDate = new Map<string, number>();
  const skippedRetirement: Array<{ start: string; end: string; reasons: string[] }> = [];
  const collectedChunks: Array<{ start: string; end: string }> = [];
  let malformed = 0;
  let firstInc = firstIncomplete;
  const segScope = segmentScope(set.segmentKeyFixed, set.dims.slice(2));
  const coverage = () => ({
    note: 'Grouping by page may drop some data (Google docs); page totals are NOT additive with property totals.',
    truncatedDates: [...rowsPerDate].filter(([, n]) => n >= GSC_DAILY_ROW_CEILING).map(([d]) => d),
    malformedRows: malformed,
    retirement: { ...retirementNote(counts, [...new Set(skippedRetirement.flatMap((x) => x.reasons))]), skippedChunks: skippedRetirement },
    warnings: r.warnings,
  });
  try {
    for (const [s, e] of splitRange(range.start, range.end, chunkDays)) {
      const res = await queryAllPages(env.c, env.property, { startDate: s, endDate: e, ...baseBody }, { rowLimit: env.rowLimit, maxPages: env.maxPages });
      r.apiPages += res.pages;
      rawRefs.push(...res.rawRefs);
      if (res.stoppedAtMaxPages) r.truncated = true;
      if (res.firstIncompleteDate && (!firstInc || res.firstIncompleteDate < firstInc)) firstInc = res.firstIncompleteDate;
      const aggType = normalizeAggregation(res.responseAggregationType, 'byPage');
      const returnedKeys = new Set<string>();
      const chunkRowsPerDate = new Map<string, number>();
      let chunkMalformed = 0;
      ctx.db.transaction(() => {
        for (const row of res.rows) {
          if (!validRow(row, set.dims.length)) {
            malformed++;
            chunkMalformed++;
            continue;
          }
          const k = row.keys!;
          const date = k[0]!;
          const page = k[1]!;
          const country = set.dims.includes('country') ? k[set.dims.indexOf('country')]! : null;
          const device = set.dims.includes('device') ? k[set.dims.indexOf('device')]! : null;
          const segmentKey = segmentKeyOf({ country, device, searchAppearance: set.searchAppearance });
          rowsPerDate.set(date, (rowsPerDate.get(date) ?? 0) + 1);
          chunkRowsPerDate.set(date, (chunkRowsPerDate.get(date) ?? 0) + 1);
          const key = { property: env.property, search_type: st, date, page, segment_key: segmentKey };
          returnedKeys.add(revisionKey('gsc_page_daily', key));
          const o = upsertRevision(
            ctx.db,
            'gsc_page_daily',
            ctx.siteId,
            key,
            { date_tz: GSC_TIME_ZONE, country, device, search_appearance: set.searchAppearance, ...metricValues(row), aggregation_type: aggType, is_final: isFinal(date, firstInc) ? 1 : 0 },
            env.meta(batchId),
          );
          tally(counts, o);
        }
        // Retire only inside this chunk's exact scope, and only when the chunk is complete.
        const reasons: string[] = [];
        if (res.stoppedAtMaxPages) reasons.push('pagination stopped at the page guard');
        const ceiling = [...chunkRowsPerDate].filter(([, n]) => n >= GSC_DAILY_ROW_CEILING).map(([d]) => d);
        if (ceiling.length) reasons.push(`row ceiling reached on ${ceiling.join(', ')}`);
        if (chunkMalformed) reasons.push(`${chunkMalformed} malformed row(s) could not be keyed`);
        if (reasons.length) skippedRetirement.push({ start: s, end: e, reasons });
        settleScope(
          ctx.db,
          'gsc_page_daily',
          ctx.siteId,
          { equals: { property: env.property, search_type: st, ...segScope.equals }, range: { column: 'date', start: s, end: e }, ...(segScope.where ? { where: segScope.where } : {}) },
          returnedKeys,
          batchId,
          reasons,
          counts,
        );
      });
      collectedChunks.push({ start: s, end: e });
    }
  } catch (err) {
    failBatch(env, r, counts, rawRefs, coverage(), err, collectedChunks);
    throw err;
  }
  const cov = coverage();
  if (cov.truncatedDates.length) {
    r.truncated = true;
    r.warnings.push(`${cov.truncatedDates.length} date(s) reached the documented ${GSC_DAILY_ROW_CEILING.toLocaleString('en-US')} rows/day ceiling; lower-traffic pages are missing for those dates.`);
  }
  if (malformed) r.warnings.push(`${malformed} malformed row(s) were skipped.`);
  if (counts.retired) r.warnings.push(`${counts.retired} page row(s) stored by an earlier sync are no longer reported by Google; they were retired (not current, not zero).`);
  if (counts.staleRetained) r.warnings.push(`${counts.staleRetained} stored page row(s) were not returned by an incomplete request; they stay current (see coverage retirement.skippedChunks).`);
  applyCounts(r, counts);
  r.status = r.truncated ? 'partial' : 'succeeded';
  finishBatch(ctx, batchId, { status: r.truncated ? 'partial' : 'succeeded', counts, apiPages: r.apiPages, truncated: r.truncated, coverage: coverage(), metadata: { aggregationRequested: 'byPage', dataState: 'all', timeZone: GSC_TIME_ZONE, firstIncompleteDate: firstInc, dimensions: set.dims }, rawRefs });
  return r;
}

async function discoverSearchAppearances(env: Env, range: GscRangePlan): Promise<string[]> {
  const res = await queryAllPages(env.c, env.property, { startDate: range.start, endDate: range.end, dimensions: ['searchAppearance'], type: range.searchType, dataState: 'all' }, { rowLimit: env.rowLimit, maxPages: env.maxPages });
  return [...new Set(res.rows.map((r) => r.keys?.[0]).filter((v): v is string => typeof v === 'string' && v.length > 0))].sort();
}

function storedSearchAppearances(ctx: AppContext, property: string, range: GscRangePlan): string[] {
  return ctx.db
    .all<{ v: string }>(
      `SELECT DISTINCT search_appearance AS v FROM gsc_page_daily
       WHERE site_id = ? AND property = ? AND search_type = ? AND is_current = 1 AND search_appearance IS NOT NULL AND date BETWEEN ? AND ?`,
      [ctx.siteId, property, range.searchType, range.start, range.end],
    )
    .map((r) => r.v)
    .filter((v) => typeof v === 'string' && v.length > 0);
}

/**
 * Current page/query rows stored as NOT final, per page, for one segment
 * shape and dates in [start, end]. Callers pass an end before the first
 * incomplete date, so these are rows Google now reports as final that were
 * never re-collected (for example because the page left the top N).
 */
function notFinalPageQueryRows(ctx: AppContext, property: string, st: GscSearchType, segDims: readonly GscDimension[], start: string, end: string): Map<string, { first: string; last: string; rows: number }> {
  const out = new Map<string, { first: string; last: string; rows: number }>();
  if (start > end) return out;
  const shape = [...segDims].sort().join(',');
  const rows = ctx.db.all<{ page: string; segment_key: string; first: string; last: string; n: number }>(
    `SELECT page, segment_key, MIN(date) AS first, MAX(date) AS last, COUNT(*) AS n FROM gsc_page_query_daily
      WHERE site_id = ? AND property = ? AND search_type = ? AND is_current = 1 AND is_final = 0 AND date BETWEEN ? AND ?
      GROUP BY page, segment_key`,
    [ctx.siteId, property, st, start, end],
  );
  for (const r of rows) {
    if (segmentShape(r.segment_key) !== shape) continue;
    const cur = out.get(r.page);
    out.set(r.page, cur ? { first: r.first < cur.first ? r.first : cur.first, last: r.last > cur.last ? r.last : cur.last, rows: cur.rows + r.n } : { first: r.first, last: r.last, rows: r.n });
  }
  return out;
}

function summarizeNotFinal(m: Map<string, { first: string; last: string; rows: number }>): GscNotFinalRows | null {
  if (!m.size) return null;
  const v = [...m.values()];
  return {
    pages: m.size,
    rows: v.reduce((a, x) => a + x.rows, 0),
    firstDate: v.reduce((a, x) => (x.first < a ? x.first : a), v[0]!.first),
    lastDate: v.reduce((a, x) => (x.last > a ? x.last : a), v[0]!.last),
  };
}

/** Page totals (gsc_page_daily, unsegmented) of one page over [start, end]; null when no current row exists. */
function pageTotalsOf(ctx: AppContext, property: string, st: GscSearchType, page: string, start: string, end: string): { clicks: number | null; impressions: number | null } {
  const r = ctx.db.get<{ clicks: number | null; impressions: number | null; n: number }>(
    `SELECT SUM(clicks) AS clicks, SUM(impressions) AS impressions, COUNT(*) AS n FROM gsc_page_daily
      WHERE site_id = ? AND property = ? AND search_type = ? AND segment_key = '' AND is_current = 1 AND page = ? AND date BETWEEN ? AND ?`,
    [ctx.siteId, property, st, page, start, end],
  );
  return r && r.n > 0 ? { clicks: r.clicks, impressions: r.impressions } : { clicks: null, impressions: null };
}

interface PageQueryTarget {
  page: string;
  start: string;
  end: string;
  /** top_pages: in the top N for the range; settle_not_final: re-requested only to settle rows stored as not final. */
  reason: 'top_pages' | 'settle_not_final';
  clicks: number | null;
  impressions: number | null;
}

function topPages(ctx: AppContext, property: string, st: GscSearchType, start: string, end: string, limit: number): Array<{ page: string; clicks: number; impressions: number }> {
  return ctx.db.all<{ page: string; clicks: number; impressions: number }>(
    `SELECT page, SUM(clicks) AS clicks, SUM(impressions) AS impressions FROM gsc_page_daily
     WHERE site_id = ? AND property = ? AND search_type = ? AND segment_key = '' AND is_current = 1 AND date BETWEEN ? AND ?
     GROUP BY page ORDER BY clicks DESC, impressions DESC, page ASC LIMIT ?`,
    [ctx.siteId, property, st, start, end, limit],
  );
}

async function syncPageQuery(env: Env, range: GscRangePlan, firstIncomplete: string | null, segDims: GscDimension[], limit: number): Promise<GscDatasetResult> {
  const { ctx } = env;
  const st = range.searchType;
  const pages = topPages(ctx, env.property, st, range.start, range.end, limit);
  // Rows stored as not final for dates Google now reports as final (inside the history window) are
  // re-requested: from their earliest such date for top pages, and on their own for pages that left the
  // top N (up to `limit` such pages per sync, earliest first). Otherwise they would stay not final forever.
  const windowStart = range.window && range.window.start < range.start ? range.window.start : range.start;
  const settleEndOf = (fi: string | null) => {
    const e = fi ? addDays(fi, -1) : range.end;
    return e < range.end ? e : range.end;
  };
  const stale = notFinalPageQueryRows(ctx, env.property, st, segDims, windowStart, settleEndOf(firstIncomplete));
  const topSet = new Set(pages.map((p) => p.page));
  const targets: PageQueryTarget[] = pages.map((p) => {
    const s = stale.get(p.page);
    if (s && s.first < range.start) return { page: p.page, start: s.first, end: range.end, reason: 'top_pages', ...pageTotalsOf(ctx, env.property, st, p.page, s.first, range.end) };
    return { page: p.page, start: range.start, end: range.end, reason: 'top_pages', clicks: p.clicks, impressions: p.impressions };
  });
  const settleCandidates = [...stale].filter(([page]) => !topSet.has(page)).sort((a, b) => a[1].first.localeCompare(b[1].first) || a[0].localeCompare(b[0]));
  for (const [page, s] of settleCandidates.slice(0, limit)) {
    targets.push({ page, start: s.first, end: s.last, reason: 'settle_not_final', ...pageTotalsOf(ctx, env.property, st, page, s.first, s.last) });
  }
  const settleTargets = targets.filter((t) => t.reason === 'settle_not_final').length;
  const extendedTop = targets.filter((t) => t.reason === 'top_pages' && t.start < range.start).length;
  const dims: GscDimension[] = ['date', 'page', 'query', ...segDims];
  const batchId = startBatch(ctx, {
    source: 'gsc',
    dataset: 'gsc_page_query_daily',
    property: env.property,
    dateStart: range.start,
    dateEnd: range.end,
    request: { dimensions: dims, type: st, aggregationType: 'byPage', dataState: 'all', rowLimit: env.rowLimit, pageFilter: 'equals <page>', pages: pages.length, settleNotFinalPages: settleTargets, topPagesExtendedToSettle: extendedTop },
    transformationVersion: GSC_TRANSFORMATION_VERSION,
    synthetic: env.synthetic,
  });
  const r = datasetResult('gsc_page_query_daily', st, segDims.length ? `dims:${segDims.join(',')}` : '', batchId);
  const counts = emptyCounts();
  const rawRefs: string[] = [];
  const perPage: Array<Record<string, unknown>> = [];
  const skippedRetirement: Array<{ page: string; reasons: string[] }> = [];
  let malformed = 0;
  let firstInc = firstIncomplete;
  const segScope = segmentScope('', segDims);
  const coverage = () => ({
    note: 'Visible query rows exclude anonymized queries and are subject to row limits. Never sum them as page or site totals.',
    unattributedEstimate:
      'Per page: page total (gsc_page_daily) minus the sum of visible query rows over the same dates. This is an ESTIMATE of anonymized queries plus rows dropped by limits.',
    settleNotFinal:
      'Pages with reason settle_not_final left the top N but had rows stored as not final for dates Google now reports as final; they were re-requested over those dates only, so the rows become final or are retired. Top pages with such rows before the refresh start were requested from their earliest such date.',
    pages: perPage,
    malformedRows: malformed,
    retirement: { ...retirementNote(counts, [...new Set(skippedRetirement.flatMap((x) => x.reasons))]), skippedPages: skippedRetirement },
    warnings: r.warnings,
  });
  try {
    for (const p of targets) {
      const res = await queryAllPages(
        env.c,
        env.property,
        { startDate: p.start, endDate: p.end, dimensions: dims, type: st, aggregationType: 'byPage', dataState: 'all', dimensionFilterGroups: [{ groupType: 'and', filters: [{ dimension: 'page', operator: 'equals', expression: p.page }] }] },
        { rowLimit: env.rowLimit, maxPages: env.maxPages },
      );
      r.apiPages += res.pages;
      rawRefs.push(...res.rawRefs);
      if (res.stoppedAtMaxPages) r.truncated = true;
      if (res.firstIncompleteDate && (!firstInc || res.firstIncompleteDate < firstInc)) firstInc = res.firstIncompleteDate;
      const aggType = normalizeAggregation(res.responseAggregationType, 'byPage');
      let visClicks = 0;
      let visImpr = 0;
      const returnedKeys = new Set<string>();
      const rowsPerDate = new Map<string, number>();
      let pageMalformed = 0;
      ctx.db.transaction(() => {
        for (const row of res.rows) {
          if (!validRow(row, dims.length)) {
            malformed++;
            pageMalformed++;
            continue;
          }
          const k = row.keys!;
          const date = k[0]!;
          const page = k[1]!;
          const query = k[2]!;
          const country = segDims.includes('country') ? k[dims.indexOf('country')]! : null;
          const device = segDims.includes('device') ? k[dims.indexOf('device')]! : null;
          const m = metricValues(row);
          visClicks += m.clicks;
          visImpr += m.impressions;
          rowsPerDate.set(date, (rowsPerDate.get(date) ?? 0) + 1);
          const key = { property: env.property, search_type: st, date, page, query, segment_key: segmentKeyOf({ country, device }) };
          returnedKeys.add(revisionKey('gsc_page_query_daily', key));
          const o = upsertRevision(
            ctx.db,
            'gsc_page_query_daily',
            ctx.siteId,
            key,
            { date_tz: GSC_TIME_ZONE, country, device, ...m, aggregation_type: aggType, is_final: isFinal(date, firstInc) ? 1 : 0 },
            env.meta(batchId),
          );
          tally(counts, o);
        }
        // Scope: this page filter, the requested dates, and this segment shape only.
        const reasons: string[] = [];
        if (res.stoppedAtMaxPages) reasons.push('pagination stopped at the page guard');
        const ceiling = [...rowsPerDate].filter(([, n]) => n >= GSC_DAILY_ROW_CEILING).map(([d]) => d);
        if (ceiling.length) reasons.push(`row ceiling reached on ${ceiling.join(', ')}`);
        if (pageMalformed) reasons.push(`${pageMalformed} malformed row(s) could not be keyed`);
        if (reasons.length) skippedRetirement.push({ page: p.page, reasons });
        settleScope(
          ctx.db,
          'gsc_page_query_daily',
          ctx.siteId,
          { equals: { property: env.property, search_type: st, page: p.page, ...segScope.equals }, range: { column: 'date', start: p.start, end: p.end }, ...(segScope.where ? { where: segScope.where } : {}) },
          returnedKeys,
          batchId,
          reasons,
          counts,
        );
      });
      perPage.push({
        page: p.page,
        reason: p.reason,
        requested: { start: p.start, end: p.end },
        pageTotalClicks: p.clicks,
        pageTotalImpressions: p.impressions,
        visibleQueryClicks: visClicks,
        visibleQueryImpressions: visImpr,
        unattributedClicksEstimate: segDims.length || p.clicks === null ? null : Math.max(0, p.clicks - visClicks),
        unattributedImpressionsEstimate: segDims.length || p.impressions === null ? null : Math.max(0, p.impressions - visImpr),
        queryRows: res.rows.length,
        truncated: res.stoppedAtMaxPages,
      });
    }
  } catch (err) {
    failBatch(env, r, counts, rawRefs, coverage(), err);
    throw err;
  }
  if (!pages.length) r.warnings.push('No pages with Search Console data in this range; no page/query detail was requested.');
  if (settleTargets) r.warnings.push(`${settleTargets} page(s) outside the top ${limit} were re-requested because their page/query rows were stored as not final for dates Google now reports as final.`);
  if (malformed) r.warnings.push(`${malformed} malformed row(s) were skipped.`);
  if (counts.retired) r.warnings.push(`${counts.retired} page/query row(s) stored by an earlier sync are no longer reported for their page; they were retired (not current, not zero).`);
  if (counts.staleRetained) r.warnings.push(`${counts.staleRetained} stored page/query row(s) were not returned by an incomplete request; they stay current (see coverage retirement.skippedPages).`);
  // Data quality: rows still not final for dates that are final at the source (pages beyond this sync's
  // re-request limit, or re-requests that were incomplete). Their queries stay 'incomplete' for those dates.
  const left = summarizeNotFinal(notFinalPageQueryRows(ctx, env.property, st, segDims, windowStart, settleEndOf(firstInc)));
  if (left) {
    r.notFinalRows = left;
    r.warnings.push(
      `${left.rows} page/query row(s) on ${left.pages} page(s) between ${left.firstDate} and ${left.lastDate} are still stored as not final although Search Console reports those dates as final (the pages exceeded this sync's re-request limit of ${limit} or their re-request was incomplete). Their queries count as incomplete for those dates (not used as ranking or CTR evidence) until a later sync settles them.`,
    );
  }
  applyCounts(r, counts);
  r.status = r.truncated ? 'partial' : 'succeeded';
  finishBatch(ctx, batchId, { status: r.truncated ? 'partial' : 'succeeded', counts, apiPages: r.apiPages, truncated: r.truncated, coverage: coverage(), metadata: { aggregationRequested: 'byPage', dataState: 'all', timeZone: GSC_TIME_ZONE, firstIncompleteDate: firstInc, dimensions: dims, topPagesLimit: limit }, rawRefs });
  return r;
}

export async function syncGsc(ctx: AppContext, opts: SyncGscOptions): Promise<SyncGscResult> {
  const synthetic = opts.provider.mode === 'fixture';
  const base: SyncGscResult = { status: 'succeeded', property: ctx.config.google.searchConsoleProperty, timeZone: GSC_TIME_ZONE, synthetic, ranges: [], datasets: [], availability: [], warnings: [] };
  if (!ctx.settings.features.gsc) {
    return { ...base, status: 'disabled', warnings: ['Search Console ingestion is disabled by the site feature flags (features.gsc).'] };
  }
  const property = ctx.config.google.searchConsoleProperty;
  if (!property) {
    throw new AppError('CONFIG_MISSING', 'No Search Console property is configured (google.searchConsoleProperty).', {
      hint: 'Run `npm run cli -- auth status` to list the properties this identity can access, then copy one exactly into the site config.',
    });
  }
  const fmt = validateGscPropertyFormat(property);
  if (!fmt.ok) throw new ConfigError(`Invalid Search Console property "${property}": ${fmt.problems.join(' ')}`);
  const rowLimit = opts.rowLimit ?? GSC_MAX_ROW_LIMIT;
  if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > GSC_MAX_ROW_LIMIT) throw new ConfigError(`rowLimit must be 1..${GSC_MAX_ROW_LIMIT}`);
  const searchTypes = opts.searchTypes ?? ctx.config.google.gsc.searchTypes;
  const today = dateInZone(ctx.clock.now(), GSC_TIME_ZONE);
  const includePQ = opts.includePageQuery !== false;
  const ranges = searchTypes.map((st) => computeGscRange(ctx, property, st, today, opts.days, { includePageQuery: includePQ }));
  const chunkDays = Math.max(1, opts.pageChunkDays ?? 1);
  const limit = opts.topPages ?? ctx.config.google.gsc.pageQueryTopPages;
  const segDims = segmentDims(opts.segments);
  const backfillNotes = ranges.flatMap((r) =>
    (r.datasets ?? [])
      .filter((d) => d.backfillFrom)
      .map(
        (d) =>
          `Backfill: ${d.dataset} (${r.searchType}) is re-requested from ${d.backfillFrom} because ${d.gapDates} date(s) of the history window before the refresh start were never collected or their collection was interrupted (for example an earlier sync stopped at a quota).`,
      ),
  );

  if (opts.dryRun || ctx.dryRun) {
    // Fails like the real run when the credential is missing (no network call, nothing written).
    const credentials = checkCredentialsOffline(opts.provider);
    let est = 1; // sites.list
    for (const r of ranges) {
      const chunks = splitRange(r.start, r.end, chunkDays).length;
      est += 2 + chunks * 2 * (1 + (segDims.length ? 1 : 0)) + (includePQ ? limit * 2 * (1 + (segDims.length ? 1 : 0)) : 0);
    }
    return {
      ...base,
      status: 'dry_run',
      ranges,
      warnings: credentials.status === 'unverified' ? [credentials.note] : [],
      plan: {
        estimatedMinRequests: est,
        datasets: ['gsc_property_daily', 'gsc_page_daily', ...(includePQ ? ['gsc_page_query_daily'] : [])],
        credentialCheck: credentials.status,
        notes: [
          'Dry run: no Google request was made and nothing was written.',
          credentials.note,
          'Search Console reads are free (quota-limited); no budget reservation is needed.',
          'Pagination continues until an empty page, so each query costs at least 2 requests.',
          ...(includePQ ? [`Page/query detail may also re-request up to ${limit} page(s) outside the top pages whose stored rows are still not final for dates Google now reports as final.`] : []),
          ...backfillNotes,
          ...(opts.segments?.includes('searchAppearance') ? ['searchAppearance segments add one discovery query plus one request set per appearance value.'] : []),
        ],
      },
    };
  }

  assertNetworkAllowed(ctx, opts.provider, 'gsc');
  const client = await opts.provider.getClient();
  const pacer = new Pacer(opts.pacingMs ?? (synthetic ? 0 : GSC_SEARCH_ANALYTICS_MIN_INTERVAL_MS));
  const c: GscCallContext = { ctx, client, synthetic, pacer, ...(opts.retry ? { retry: opts.retry } : {}), ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) };
  const discovery = await discoverGscProperties(ctx, opts.provider, { client, ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) });
  assertConfiguredPropertyAccessible(discovery);
  const collectedAt = ctx.clock.now().toISOString();
  const env: Env = {
    ctx,
    c,
    property,
    today,
    rowLimit,
    maxPages: opts.maxPagesPerQuery ?? 40,
    synthetic,
    meta: (batchId) => ({ batchId, collectedAt, transformationVersion: GSC_TRANSFORMATION_VERSION, isSynthetic: synthetic }),
  };
  const result: SyncGscResult = { ...base, property, ranges };
  result.warnings.push(...backfillNotes);
  let stopped = false;
  for (const range of ranges) {
    if (stopped) {
      result.datasets.push({ ...datasetResult('gsc_property_daily', range.searchType, '', null), status: 'skipped', warnings: ['Skipped after a quota/rate-limit stop.'] });
      continue;
    }
    const pageRange = datasetRange(range, 'gsc_page_daily');
    const pqRange = datasetRange(range, 'gsc_page_query_daily');
    try {
      const { result: totals, availability } = await syncPropertyTotals(env, datasetRange(range, 'gsc_property_daily'));
      result.datasets.push(totals);
      result.availability.push(availability);
      const sets: PageRequestSet[] = [{ segmentKeyFixed: '', dims: ['date', 'page'], filters: [], searchAppearance: null }];
      if (segDims.length) sets.push({ segmentKeyFixed: '', dims: ['date', 'page', ...segDims], filters: [], searchAppearance: null });
      if (opts.segments?.includes('searchAppearance')) {
        const discovered = await discoverSearchAppearances(env, pageRange);
        // Values stored earlier for this range but no longer reported are re-queried, so their rows can be retired honestly.
        const stored = storedSearchAppearances(ctx, property, pageRange);
        const vanished = stored.filter((v) => !discovered.includes(v));
        if (vanished.length) result.warnings.push(`searchAppearance value(s) ${vanished.join(', ')} were stored earlier for ${pageRange.start}..${pageRange.end} but are no longer reported; they were re-queried so absent rows can be retired.`);
        for (const v of [...new Set([...discovered, ...stored])].sort()) {
          sets.push({ segmentKeyFixed: `searchAppearance=${v}`, dims: ['date', 'page'], filters: [{ dimension: 'searchAppearance', operator: 'equals', expression: v }], searchAppearance: v });
        }
      }
      for (const set of sets) result.datasets.push(await syncPageTotals(env, pageRange, availability.firstIncompleteDate, set, chunkDays));
      if (includePQ) {
        result.datasets.push(await syncPageQuery(env, pqRange, availability.firstIncompleteDate, [], limit));
        if (segDims.length) result.datasets.push(await syncPageQuery(env, pqRange, availability.firstIncompleteDate, segDims, limit));
      }
    } catch (err) {
      if (isQuotaStop(err)) {
        stopped = true;
        const partial = (err as { datasetResult?: GscDatasetResult }).datasetResult;
        if (partial) result.datasets.push(partial);
        result.warnings.push(`${err.message}. ${err.hint ?? ''}`.trim());
        continue;
      }
      throw err;
    }
  }
  for (const d of result.datasets) result.warnings.push(...d.warnings.map((w) => `[${d.dataset} ${d.searchType}${d.segmentKey ? ` ${d.segmentKey}` : ''}] ${w}`));
  // Known gaps left in the target window keep the sync 'partial' until a later sync collects them.
  const gaps: GscCoverageGap[] = [];
  for (const range of ranges) {
    const w = range.window ?? { start: range.start, end: range.end };
    for (const dataset of gapDatasets(includePQ)) {
      const g = datasetGaps(ctx, property, range.searchType, dataset, w.start, w.end);
      if (g.length) gaps.push({ searchType: range.searchType, dataset, firstDate: g[0]!, dates: g.length });
    }
  }
  if (gaps.length) {
    result.gaps = gaps;
    for (const g of gaps) {
      result.warnings.push(`Coverage gap: ${g.dates} date(s) of ${g.dataset} (${g.searchType}) between ${g.firstDate} and the end of the target window are not collected (missing, not zero); the next incremental sync backfills them.`);
    }
  }
  const anyFailed = result.datasets.some((d) => d.status === 'failed' || d.status === 'skipped');
  const anyPartial = result.datasets.some((d) => d.status === 'partial');
  // Page/query rows left not final for dates that are final at the source are a known data-quality gap.
  const notFinal = result.datasets.some((d) => d.notFinalRows);
  result.status = stopped || anyFailed || anyPartial || gaps.length > 0 || notFinal ? 'partial' : 'succeeded';

  if (opts.inspect && opts.inspect > 0) {
    if (!ctx.settings.features.urlInspection) {
      result.warnings.push('URL Inspection was requested but features.urlInspection is disabled.');
    } else {
      const urls = selectPriorityUrls(ctx, opts.inspect);
      result.inspection = await inspectUrls(ctx, opts.provider, urls, { client, max: opts.inspect, ...(opts.retry ? { retry: opts.retry } : {}), ...(opts.pacingMs !== undefined ? { pacingMs: opts.pacingMs } : {}) });
      if (result.inspection.status === 'nothing_inspected') result.warnings.push(`URL Inspection was requested but nothing was inspected: ${result.inspection.note}`);
    }
  }

  recordAudit(ctx.db, {
    siteId: ctx.siteId,
    actor: 'system',
    eventType: 'google.gsc.synced',
    subjectType: 'gsc_property',
    subjectId: property,
    traceId: ctx.runId,
    details: {
      status: result.status,
      synthetic,
      ranges,
      datasets: result.datasets.map((d) => ({ dataset: d.dataset, searchType: d.searchType, segmentKey: d.segmentKey, status: d.status, rows: d.rowsReceived, newRevisions: d.rowsNewRevision })),
    },
    at: ctx.clock.now(),
  });
  return result;
}
