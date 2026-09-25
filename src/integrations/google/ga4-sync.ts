import type { AppContext } from '../../app/context.js';
import { AppError, ConfigError } from '../../core/errors.js';
import { toMicros } from '../../core/money.js';
import type { RetryPolicy } from '../../core/retry.js';
import { addDays, dateInZone, isIsoDate, isValidTimeZone } from '../../core/time.js';
import { recordAudit } from '../../database/audit.js';
import { coverageGaps, ga4Coverage } from '../../seo/coverage.js';
import { GoogleApiError, isQuotaStop } from './errors.js';
import {
  DEFAULT_QUOTA_RESERVE,
  checkCompatibility,
  ga4DateToIso,
  ga4PropertyName,
  getMetadata,
  quotaLow,
  runReport,
  runReportAll,
  summarizeMetadata,
  type Ga4CallContext,
  type Ga4FilterExpression,
  type Ga4PropertyQuota,
  type PagedReport,
  type QuotaReserve,
} from './ga4-client.js';
import {
  cacheGa4Metadata,
  compactMetadata,
  confirmRateScale,
  integerConsistencyFromStoredRows,
  loadCachedGa4Metadata,
  loadRateScale,
  loadRateScaleConfirmation,
  planGa4Metrics,
  remarkStoredRates,
  saveRateScale,
  type Ga4MetricPlan,
  type RateScaleBasis,
  type RateScaleConfirmation,
  type RemarkResult,
  type StoredRateScale,
} from './ga4-metadata.js';
import { ga4ConversionChecklist } from './ga4-checklist.js';
import { checkCredentialsOffline, type OfflineCredentialCheck } from './credentials-check.js';
import { assertNetworkAllowed } from './gsc-properties.js';
import { CONFIRM_RATE_SCALE_COMMAND } from './rate-scale-command.js';
import type { GoogleAuthProvider } from './types.js';
import { emptyCounts, finishBatch, revisionKey, settleScope, startBatch, tally, upsertRevision, type BatchCounts, type RetireScope, type RevisionMeta, type SqlValue, type VersionedTable } from './versioned.js';

/**
 * GA4 ingestion (Data API v1beta).
 *
 * Views (session-scoped acquisition dimensions only):
 *  - google_organic: sessionSource = "google" AND sessionMedium = "organic"
 *    (comparable with Search Console)
 *  - all_organic:    sessionDefaultChannelGroup = "Organic Search"
 * Event-scoped attribution dimensions (source, medium, defaultChannelGroup)
 * are never mixed with session metrics.
 *
 * Users are NOT additive: totalUsers is fetched at period grain into
 * ga4_period_metrics and never summed from daily rows.
 */

export const GA4_TRANSFORMATION_VERSION = 'ga4-ingest@1';
/**
 * Dates within this many days of "today" (property time zone, today
 * included) are marked incomplete. This is a conservative assumption about
 * GA4 processing latency, not a documented freshness guarantee.
 */
export const GA4_ASSUMED_PROCESSING_DAYS = 2;

export type Ga4ChannelView = 'google_organic' | 'all_organic';
export type Ga4EventView = Ga4ChannelView | 'all_traffic';

const exact = (fieldName: string, value: string): Ga4FilterExpression => ({ filter: { fieldName, stringFilter: { matchType: 'EXACT', value, caseSensitive: false } } });

export const CHANNEL_VIEWS: Record<Ga4ChannelView, { description: string; filter: Ga4FilterExpression }> = {
  google_organic: {
    description: 'Session source "google" and session medium "organic" (session-scoped, last-click). Comparable with Search Console clicks.',
    filter: { andGroup: { expressions: [exact('sessionSource', 'google'), exact('sessionMedium', 'organic')] } },
  },
  all_organic: {
    description: 'Session default channel group "Organic Search" (all search engines, session-scoped).',
    filter: exact('sessionDefaultChannelGroup', 'Organic Search'),
  },
};

function viewFilter(view: Ga4EventView): Ga4FilterExpression | null {
  return view === 'all_traffic' ? null : CHANNEL_VIEWS[view].filter;
}

function andFilters(...parts: Array<Ga4FilterExpression | null>): Ga4FilterExpression | undefined {
  const xs = parts.filter((p): p is Ga4FilterExpression => !!p);
  if (!xs.length) return undefined;
  if (xs.length === 1) return xs[0];
  return { andGroup: { expressions: xs } };
}

export const LANDING_DIMENSIONS = ['date', 'landingPagePlusQueryString', 'hostName'] as const;

export interface SyncGa4Options {
  provider: GoogleAuthProvider;
  days?: number;
  dryRun?: boolean;
  /** Rows per runReport page (default 100,000; documented max 250,000). */
  limit?: number;
  maxPagesPerReport?: number;
  retry?: RetryPolicy;
  /** Period windows (days, ending at the latest complete date) for non-additive metrics. */
  periodWindows?: number[];
  /**
   * Explicit periods (YYYY-MM-DD, inclusive) fetched at period grain in
   * addition to `periodWindows`, e.g. the exact period of a weekly/monthly
   * report and its comparison period, so period-level users and rates are
   * available for exactly that period (users are never summed from days).
   * A period ending after the latest complete GA4 date is still fetched and
   * stored with is_complete = 0.
   */
  periods?: Array<{ start: string; end: string }>;
  quotaReserve?: QuotaReserve;
  includeLandingEvents?: boolean;
}

export interface Ga4DatasetResult {
  dataset: VersionedTable;
  view: string;
  variant: string;
  batchId: string | null;
  status: 'succeeded' | 'partial' | 'failed' | 'skipped';
  rowsReceived: number;
  rowsNewRevision: number;
  rowsRevised: number;
  rowsUnchanged: number;
  /** Current rows of earlier syncs retired because a complete report over the same scope no longer returned them. */
  rowsRetired: number;
  /** Current rows not returned by an INCOMPLETE report (thresholded, sampled, "(other)", truncated); kept current. */
  rowsStaleRetained: number;
  apiPages: number;
  truncated: boolean;
  warnings: string[];
}

/** One date-series slice of GA4 ingestion: landing per channel view, events per view and variant. */
export interface Ga4Slice {
  key: string;
  dataset: 'ga4_landing_daily' | 'ga4_event_daily';
  view: Ga4EventView;
  variant?: 'all_landing_pages' | 'by_landing_page';
}

export interface Ga4SliceRange extends Ga4Slice {
  start: string;
  /** Earliest date re-requested because earlier syncs never (fully) collected it; null = plain refresh. */
  backfillFrom: string | null;
  /** Dates before the refresh start that were missing or interrupted (quota stop, failed report). */
  gapDates: number;
}

export interface Ga4RangePlan {
  /** Earliest start over all slices. */
  start: string;
  end: string;
  mode: 'initial' | 'incremental' | 'explicit';
  /** Target window verified after the sync (initialHistoryDays, or the explicit range). */
  window?: { start: string; end: string };
  /** Per-slice start (only when slices were requested). */
  slices?: Ga4SliceRange[];
}

/** Dates of a slice still not collected in the target window after a sync. */
export interface Ga4CoverageGap {
  slice: string;
  firstDate: string;
  dates: number;
}

export interface SyncGa4Result {
  status: 'succeeded' | 'partial' | 'failed' | 'dry_run' | 'disabled';
  propertyId: string | null;
  timeZone: string | null;
  currencyCode: string | null;
  synthetic: boolean;
  range: ({ start: string; end: string; mode: 'initial' | 'incremental' | 'explicit'; incompleteFrom: string } & Pick<Ga4RangePlan, 'window' | 'slices'>) | null;
  metricPlan: Ga4MetricPlan | null;
  datasets: Ga4DatasetResult[];
  limitations: string[];
  warnings: string[];
  rateScale: RateScale;
  checklist?: string;
  /** Dry run only; `credentialCheck` as in SyncGscResult.plan (a missing credential fails the dry run like the real run). */
  plan?: { notes: string[]; reports: string[]; credentialCheck?: OfflineCredentialCheck['status'] };
  /** Known gaps left in the target window (status is 'partial' while any remain). */
  gaps?: Ga4CoverageGap[];
}

/**
 * Scale of key-event rates (sessionKeyEventRate:<event>, userKeyEventRate:<event>).
 * `source`: 'stored' = 0-100 was proven by an earlier sync of this property
 * (persisted in ga4_property_metadata); 'this_sync' = a value above 1 was seen
 * in this sync's reports; 'confirmed' = the latest confirmation recorded for
 * the property (owner assertion via `sync ga4 --confirm-rate-scale`, or an
 * earlier integer-consistency proof; migration 0320); 'proven' = this sync
 * proved 0-1 from the integer consistency of small daily rows; 'none' =
 * nothing establishes the scale.
 */
export type RateScale = {
  detected: 'fraction_0_1' | 'percent_0_100' | 'undetermined';
  maxObserved: number | null;
  normalized: boolean;
  source?: 'stored' | 'this_sync' | 'confirmed' | 'proven' | 'none';
  /** How a 'confirmed' / 'proven' scale was established, and when. */
  confirmation?: { id: string; basis: RateScaleBasis; confirmedAt: string; actor: string } | null;
  /** A recorded 0-1 confirmation that an observed value above 1 contradicts (0-100 wins). */
  contradiction?: string | null;
  /** Stored rates of earlier syncs re-marked (as new revisions) once the scale was established. */
  remarked?: RemarkResult | null;
};

/** Per-row marker stored with each rate (migration 0100). */
type RowRateScale = 'percent_normalized' | 'fraction' | 'undetermined';

interface Env {
  ctx: AppContext;
  c: Ga4CallContext;
  propertyId: string;
  tz: string;
  currency: string | null;
  synthetic: boolean;
  limit: number;
  maxPages: number;
  reserve: QuotaReserve;
  incompleteFrom: string;
  plan: Ga4MetricPlan;
  events: string[];
  /** Decided once, after all reports are fetched and before any row is written. */
  rateScale: RateScale;
  lastQuota: Ga4PropertyQuota | null;
  quotaStop: string | null;
  meta: (batchId: string) => RevisionMeta;
}

/**
 * A fetched report whose rows are not written yet. All reports of a sync are
 * fetched first so the rate scale can be decided from every rate value before
 * any row is stored; then each `commit` writes its batch.
 */
interface Prepared {
  rateValues: number[];
  commit: () => Ga4DatasetResult;
}

function result(dataset: VersionedTable, view: string, variant: string, batchId: string | null): Ga4DatasetResult {
  return { dataset, view, variant, batchId, status: 'succeeded', rowsReceived: 0, rowsNewRevision: 0, rowsRevised: 0, rowsUnchanged: 0, rowsRetired: 0, rowsStaleRetained: 0, apiPages: 0, truncated: false, warnings: [] };
}

function applyCounts(r: Ga4DatasetResult, c: BatchCounts): void {
  r.rowsReceived = c.received;
  r.rowsNewRevision = c.newRevisions;
  r.rowsRevised = c.revised;
  r.rowsUnchanged = c.unchanged;
  r.rowsRetired = c.retired;
  r.rowsStaleRetained = c.staleRetained;
}

function numbers(values: Array<number | null | undefined>): number[] {
  return values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

/**
 * Decide the key-event rate scale for the whole sync. The docs call these
 * metrics "percentages" but do not say 0-1 or 0-100 (unverified). A value
 * above 1 (now, or in any earlier sync of this property) proves 0-100: values
 * are divided by 100 and marked 'percent_normalized'. It wins over any
 * recorded confirmation (a 0-1 confirmation it contradicts is reported).
 * Otherwise the latest recorded confirmation (migration 0320: owner assertion
 * or integer consistency) decides: 0-1 values are stored as reported and
 * marked 'fraction'; 0-100 values are divided by 100. Without either, the
 * scale is 'undetermined' and values are stored exactly as reported.
 */
export function decideRateScale(stored: StoredRateScale | null, values: number[], confirmation: Pick<RateScaleConfirmation, 'id' | 'scale' | 'basis' | 'confirmedAt' | 'actor'> | null = null): RateScale {
  const maxNow = values.length ? Math.max(...values) : null;
  const maxObserved = maxNow === null ? stored?.maxObserved ?? null : Math.max(maxNow, stored?.maxObserved ?? maxNow);
  const conf = confirmation ? { id: confirmation.id, basis: confirmation.basis, confirmedAt: confirmation.confirmedAt, actor: confirmation.actor } : null;
  const contradiction =
    confirmation?.scale === 'fraction'
      ? `the recorded 0-1 confirmation (${confirmation.basis === 'owner_assertion' ? 'owner' : 'integer consistency'}, ${confirmation.confirmedAt}) is contradicted: a key-event rate above 1 (max ${maxObserved}) was observed, which proves 0-100`
      : null;
  if (stored?.scale === 'percent_0_100') return { detected: 'percent_0_100', maxObserved, normalized: true, source: 'stored', ...(contradiction ? { contradiction } : {}) };
  if (maxNow !== null && maxNow > 1) return { detected: 'percent_0_100', maxObserved, normalized: true, source: 'this_sync', ...(contradiction ? { contradiction } : {}) };
  if (confirmation?.scale === 'percent') return { detected: 'percent_0_100', maxObserved, normalized: true, source: 'confirmed', confirmation: conf };
  if (confirmation?.scale === 'fraction') return { detected: 'fraction_0_1', maxObserved, normalized: false, source: 'confirmed', confirmation: conf };
  return { detected: 'undetermined', maxObserved, normalized: false, source: 'none' };
}

function normalizeRate(env: Env, v: number | null | undefined): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return env.rateScale.detected === 'percent_0_100' ? v / 100 : v;
}

function rowRateScale(env: Env): RowRateScale {
  if (env.rateScale.detected === 'percent_0_100') return 'percent_normalized';
  return env.rateScale.detected === 'fraction_0_1' ? 'fraction' : 'undetermined';
}

/** The `--confirm-rate-scale` command, spelled out for messages (one definition: ./rate-scale-command.ts). */
export { CONFIRM_RATE_SCALE_COMMAND };

/** Reasons why an absent row in this report does not prove the row is gone (or zero). */
function incompleteReasons(report: PagedReport, malformed = 0): string[] {
  const s = summarizeMetadata(report.metadata);
  const out: string[] = [];
  if (report.stoppedAtMaxPages) out.push('pagination stopped at the page guard');
  if (report.stoppedForQuota) out.push('paging stopped at the quota reserve');
  if (s.subjectToThresholding) out.push('subjectToThresholding');
  if (s.dataLossFromOtherRow) out.push('dataLossFromOtherRow ("(other)" bucketing)');
  if (Array.isArray(s.samplingMetadatas) && s.samplingMetadatas.length) out.push('sampled');
  if (Array.isArray(s.dataTruncationReasons) && s.dataTruncationReasons.length) out.push('dataTruncationReasons');
  if (malformed) out.push(`${malformed} malformed row(s) could not be keyed`);
  return out;
}

function retirementNote(counts: BatchCounts, reasons: string[]): Record<string, unknown> {
  return {
    retiredRows: counts.retired,
    staleRowsRetained: counts.staleRetained,
    retirementSkippedBecause: reasons,
    meaning:
      'Rows returned by an earlier sync but not by this report over the same scope are retired (is_current = 0, superseded_by_batch_id = this batch) only when the report is complete. When it is thresholded, sampled, bucketed into "(other)", or truncated, an absent row proves nothing: it stays current and is counted as staleRowsRetained.',
  };
}

function retirementWarnings(r: Ga4DatasetResult, counts: BatchCounts, reasons: string[], what: string): void {
  if (counts.retired) r.warnings.push(`${counts.retired} ${what} stored by an earlier sync are no longer reported by GA4; they were retired (not current, not zero).`);
  if (counts.staleRetained) r.warnings.push(`${counts.staleRetained} stored ${what} were not returned, but the report is incomplete (${reasons.join('; ')}); they stay current and may be stale.`);
}

function coverageFrom(report: PagedReport, extra: Record<string, unknown> = {}): { coverage: Record<string, unknown>; warnings: string[] } {
  const s = summarizeMetadata(report.metadata);
  const warnings: string[] = [];
  if (s.subjectToThresholding) warnings.push('GA4 reports this data as subject to thresholding: some rows may be withheld (it can be true even when nothing is missing).');
  if (s.dataLossFromOtherRow) warnings.push('Some dimension combinations were bucketed into an "(other)" row (high cardinality); per-page values are incomplete.');
  if (Array.isArray(s.samplingMetadatas) && s.samplingMetadatas.length) warnings.push('The report is sampled; see samplingRatio in the batch metadata.');
  if (Array.isArray(s.dataTruncationReasons) && s.dataTruncationReasons.length) warnings.push('GA4 reported data truncation reasons (see batch metadata).');
  if (Array.isArray(s.schemaRestrictions) && s.schemaRestrictions.length) warnings.push('Some metrics are restricted by the identity\'s GA4 role (schemaRestrictionResponse).');
  if (s.emptyReason) warnings.push(`GA4 empty reason: ${String(s.emptyReason)}`);
  if (report.stoppedForQuota) warnings.push('Paging stopped early to protect the GA4 property quota reserve.');
  if (report.stoppedAtMaxPages) warnings.push('Paging stopped at the page guard; rows may be missing.');
  return { coverage: { ...s, warnings, ...extra }, warnings };
}

/**
 * Coverage fields of a report whose paging stopped at the quota reserve: its
 * dates are recorded as NOT fully collected (coverage.interrupted), so the
 * next incremental sync re-requests them instead of treating them as done.
 */
function interruption(stoppedForQuota: boolean): Record<string, unknown> {
  if (!stoppedForQuota) return {};
  return {
    interrupted: true,
    interruptedBecause: 'paging stopped at the GA4 quota reserve',
    collectedRanges: [],
    interruptedMeaning: 'Rows were received for some dates, but no date is known to be complete. The next incremental sync re-requests this range.',
  };
}

function reportMetadata(env: Env, report: PagedReport, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ...summarizeMetadata(report.metadata),
    propertyTimeZoneUsed: env.tz,
    rowCount: report.rowCount,
    metricTypes: report.metricTypes,
    propertyQuota: report.lastQuota,
    transformation: GA4_TRANSFORMATION_VERSION,
    ...extra,
  };
}

function trackQuota(env: Env, report: PagedReport): void {
  if (report.lastQuota) env.lastQuota = report.lastQuota;
  const low = quotaLow(env.lastQuota, env.reserve);
  if (low || report.stoppedForQuota) env.quotaStop = low ?? 'quota reserve reached';
}

function restrictedMetrics(report: PagedReport): Set<string> {
  const s = summarizeMetadata(report.metadata);
  return new Set(((s.schemaRestrictions as Array<{ metricName?: string }>) ?? []).map((r) => r.metricName ?? '').filter(Boolean));
}

/** Upsert and remember the key as returned by this report. */
function upsertTracked(env: Env, table: VersionedTable, returned: Set<string>, counts: BatchCounts, key: Record<string, SqlValue>, values: Record<string, SqlValue>, batchId: string): void {
  returned.add(revisionKey(table, key));
  tally(counts, upsertRevision(env.ctx.db, table, env.ctx.siteId, key, values, env.meta(batchId)));
}

async function fetchLandingView(env: Env, view: Ga4ChannelView, start: string, end: string): Promise<Prepared> {
  const { ctx, plan } = env;
  const metrics = [...plan.coreMetrics, plan.primaryKeyEventsMetric, plan.primaryRateMetric, plan.revenueMetric].filter((m): m is string => !!m);
  const body = { dateRanges: [{ startDate: start, endDate: end }], dimensions: LANDING_DIMENSIONS.map((name) => ({ name })), metrics: metrics.map((name) => ({ name })), dimensionFilter: CHANNEL_VIEWS[view].filter, keepEmptyRows: false };
  const batchId = startBatch(ctx, { source: 'ga4', dataset: 'ga4_landing_daily', property: env.propertyId, dateStart: start, dateEnd: end, request: { ...body, limit: env.limit, view }, transformationVersion: GA4_TRANSFORMATION_VERSION, synthetic: env.synthetic });
  const r = result('ga4_landing_daily', view, 'daily', batchId);
  const counts = emptyCounts();
  let report: PagedReport;
  let alt: PagedReport | null = null;
  try {
    report = await runReportAll(env.c, env.propertyId, body, { limit: env.limit, maxPages: env.maxPages, reserve: env.reserve, rawKind: `ga4-landing-${view}` });
    trackQuota(env, report);
    if (plan.primaryKeyEventsAlternative && plan.primaryEvent && !env.quotaStop) {
      alt = await runReportAll(
        env.c,
        env.propertyId,
        {
          dateRanges: [{ startDate: start, endDate: end }],
          dimensions: [...LANDING_DIMENSIONS, 'eventName'].map((name) => ({ name })),
          metrics: [{ name: 'keyEvents' }],
          dimensionFilter: andFilters(CHANNEL_VIEWS[view].filter, exact('eventName', plan.primaryEvent))!,
          keepEmptyRows: false,
        },
        { limit: env.limit, maxPages: env.maxPages, reserve: env.reserve, rawKind: `ga4-landing-${view}-primary-keyevents` },
      );
      trackQuota(env, alt);
    }
  } catch (err) {
    r.status = 'failed';
    r.warnings.push(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    finishBatch(ctx, batchId, { status: 'failed', counts, apiPages: r.apiPages, truncated: false, error: err });
    throw err;
  }
  const rateValues = plan.primaryRateMetric ? numbers(report.rows.map((x) => x.metrics[plan.primaryRateMetric!])) : [];

  const commit = (): Ga4DatasetResult => {
    r.apiPages = report.pages + (alt?.pages ?? 0);
    r.truncated = report.stoppedAtMaxPages || report.stoppedForQuota || !!alt?.stoppedAtMaxPages || !!alt?.stoppedForQuota;
    const restricted = restrictedMetrics(report);
    const revenueUsable = !!plan.revenueMetric && !restricted.has(plan.revenueMetric);
    const currency = (summarizeMetadata(report.metadata).currencyCode as string | null) ?? env.currency;
    const altCounts = new Map<string, number>();
    // An absent row in the alternative report is a zero ONLY when that report is complete:
    // thresholding, "(other)" bucketing, sampling, truncation, or a paging stop make absence meaningless.
    const altIncomplete = alt ? incompleteReasons(alt) : [];
    for (const row of alt?.rows ?? []) {
      const k = `${row.dims.date}|${row.dims.landingPagePlusQueryString}|${row.dims.hostName}`;
      altCounts.set(k, (altCounts.get(k) ?? 0) + (row.metrics.keyEvents ?? 0));
    }
    const metricNames = {
      sessions: 'sessions',
      engagedSessions: plan.coreMetrics.includes('engagedSessions') ? 'engagedSessions' : null,
      keyEvents: plan.coreMetrics.includes('keyEvents') ? 'keyEvents' : null,
      primaryKeyEvents: plan.primaryKeyEventsMetric ?? (plan.primaryKeyEventsAlternative ? `ALTERNATIVE: ${plan.primaryKeyEventsAlternative}` : null),
      primarySessionRate: plan.primaryRateMetric,
      primarySessionRateScale: plan.primaryRateMetric ? rowRateScale(env) : null,
      revenue: revenueUsable ? plan.revenueMetric : null,
      view: CHANNEL_VIEWS[view].description,
    };
    let malformed = 0;
    let notSetRows = 0;
    let notSetSessions = 0;
    let altAbsentIncomplete = 0;
    const returned = new Set<string>();
    ctx.db.transaction(() => {
      for (const row of report.rows) {
        const date = ga4DateToIso(row.dims.date ?? '');
        const sessions = row.metrics.sessions;
        if (!date || typeof sessions !== 'number' || sessions < 0) {
          malformed++;
          continue;
        }
        const landing = row.dims.landingPagePlusQueryString ?? '';
        const host = row.dims.hostName ?? '';
        if (landing === '(not set)') {
          notSetRows++;
          notSetSessions += sessions;
        }
        let primaryKeyEvents: number | null = null;
        let primaryKeyEventsStatus: 'observed' | 'missing' | 'unavailable' | 'incomplete' = 'unavailable';
        if (plan.primaryKeyEventsMetric) {
          const v = row.metrics[plan.primaryKeyEventsMetric];
          primaryKeyEventsStatus = typeof v === 'number' ? 'observed' : 'missing';
          if (typeof v === 'number') primaryKeyEvents = v;
        } else if (alt) {
          const v = altCounts.get(`${row.dims.date}|${landing}|${host}`);
          if (v !== undefined) {
            primaryKeyEvents = v;
            primaryKeyEventsStatus = 'observed';
          } else if (altIncomplete.length === 0) {
            // GA4 drops all-zero rows, so a landing row absent from the COMPLETE alternative report had zero primary key events.
            primaryKeyEvents = 0;
            primaryKeyEventsStatus = 'observed';
          } else {
            primaryKeyEventsStatus = 'incomplete';
            altAbsentIncomplete++;
          }
        }
        const rate = plan.primaryRateMetric ? normalizeRate(env, row.metrics[plan.primaryRateMetric]) : null;
        const revenueRaw = revenueUsable ? row.metrics[plan.revenueMetric!] : null;
        const revenueMicros = typeof revenueRaw === 'number' ? toMicros(revenueRaw) : null;
        upsertTracked(
          env,
          'ga4_landing_daily',
          returned,
          counts,
          { property_id: env.propertyId, date, channel_view: view, landing_page: landing, host_name: host, segment_key: '' },
          {
            date_tz: env.tz,
            sessions: Math.round(sessions),
            engaged_sessions: typeof row.metrics.engagedSessions === 'number' ? Math.round(row.metrics.engagedSessions) : null,
            key_events: typeof row.metrics.keyEvents === 'number' ? row.metrics.keyEvents : null,
            primary_event_name: plan.primaryEvent,
            primary_key_events: primaryKeyEvents,
            primary_key_events_status: primaryKeyEventsStatus,
            primary_session_rate: rate,
            // 'unavailable' = the metric cannot be requested; 'missing' = requested but no value came back.
            primary_session_rate_status: !plan.primaryRateMetric ? 'unavailable' : rate === null ? 'missing' : 'observed',
            primary_session_rate_scale: rate === null ? null : rowRateScale(env),
            revenue_micros: revenueMicros,
            revenue_currency: revenueMicros !== null ? currency : null,
            revenue_status: !revenueUsable ? 'unavailable' : revenueMicros === null ? 'missing' : 'observed',
            metric_names_json: JSON.stringify(metricNames),
            is_complete: date < env.incompleteFrom ? 1 : 0,
          },
          batchId,
        );
      }
      settleScope(ctx.db, 'ga4_landing_daily', ctx.siteId, { equals: { property_id: env.propertyId, channel_view: view, segment_key: '' }, range: { column: 'date', start, end } }, returned, batchId, incompleteReasons(report, malformed), counts);
    });
    const reasons = incompleteReasons(report, malformed);
    const cov = coverageFrom(report, {
      notSet: { rows: notSetRows, sessions: notSetSessions, note: '"(not set)" landing pages are kept as an explicit bucket (for example sessions without a page_view event).' },
      malformedRows: malformed,
      rateScale: { ...env.rateScale },
      primaryKeyEventsSource: metricNames.primaryKeyEvents,
      ...(alt
        ? {
            primaryKeyEventsAlternative: {
              complete: altIncomplete.length === 0,
              incompleteBecause: altIncomplete,
              absentRowsStoredAsIncomplete: altAbsentIncomplete,
              meaning: altIncomplete.length
                ? 'The alternative report is incomplete, so a landing row it does not return is stored as NULL with status "incomplete", not as zero.'
                : 'The alternative report is complete, so a landing row it does not return had zero primary key events (GA4 drops all-zero rows).',
            },
          }
        : {}),
      retirement: retirementNote(counts, reasons),
      limitations: plan.limitations,
      ...interruption(report.stoppedForQuota || !!alt?.stoppedForQuota),
    });
    r.warnings.push(...cov.warnings);
    if (altAbsentIncomplete) r.warnings.push(`The keyEvents+eventName alternative report is incomplete (${altIncomplete.join('; ')}); ${altAbsentIncomplete} landing row(s) it did not return have primary key events stored as NULL ("incomplete"), not zero.`);
    if (plan.revenueMetric && !revenueUsable) r.warnings.push(`${plan.revenueMetric} is restricted by the identity's role; revenue stored as unavailable, not zero.`);
    if (malformed) r.warnings.push(`${malformed} malformed row(s) were skipped.`);
    retirementWarnings(r, counts, reasons, 'landing-page row(s)');
    applyCounts(r, counts);
    r.status = r.truncated ? 'partial' : 'succeeded';
    finishBatch(ctx, batchId, {
      status: r.truncated ? 'partial' : 'succeeded',
      counts,
      apiPages: r.apiPages,
      truncated: r.truncated,
      coverage: cov.coverage,
      metadata: reportMetadata(env, report, { view, metrics, metricNames, alternativeReport: alt ? { pages: alt.pages, rowCount: alt.rowCount, ...summarizeMetadata(alt.metadata) } : null }),
      rawRefs: [...report.rawRefs, ...(alt?.rawRefs ?? [])],
    });
    return r;
  };
  return { rateValues, commit };
}

async function fetchEventView(env: Env, view: Ga4EventView, byLanding: boolean, start: string, end: string): Promise<Prepared> {
  const { ctx } = env;
  const dims = ['date', 'eventName', ...(byLanding ? ['landingPagePlusQueryString'] : [])];
  const body = {
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: dims.map((name) => ({ name })),
    metrics: [{ name: 'eventCount' }, { name: 'keyEvents' }],
    dimensionFilter: andFilters(viewFilter(view), { filter: { fieldName: 'eventName', inListFilter: { values: env.events, caseSensitive: true } } })!,
    keepEmptyRows: false,
  };
  const variant = byLanding ? 'by_landing_page' : 'all_landing_pages';
  const batchId = startBatch(ctx, { source: 'ga4', dataset: 'ga4_event_daily', property: env.propertyId, dateStart: start, dateEnd: end, request: { ...body, limit: env.limit, view, variant }, transformationVersion: GA4_TRANSFORMATION_VERSION, synthetic: env.synthetic });
  const r = result('ga4_event_daily', view, variant, batchId);
  const counts = emptyCounts();
  let report: PagedReport;
  try {
    report = await runReportAll(env.c, env.propertyId, body, { limit: env.limit, maxPages: env.maxPages, reserve: env.reserve, rawKind: `ga4-events-${view}-${variant}` });
    trackQuota(env, report);
  } catch (err) {
    r.status = 'failed';
    finishBatch(ctx, batchId, { status: 'failed', counts, apiPages: 0, truncated: false, error: err });
    throw err;
  }
  const commit = (): Ga4DatasetResult => {
    r.apiPages = report.pages;
    r.truncated = report.stoppedAtMaxPages || report.stoppedForQuota;
    const seenEvents = new Set<string>();
    const returned = new Set<string>();
    let malformed = 0;
    ctx.db.transaction(() => {
      for (const row of report.rows) {
        const date = ga4DateToIso(row.dims.date ?? '');
        const eventName = row.dims.eventName ?? '';
        const count = row.metrics.eventCount;
        if (!date || !eventName || typeof count !== 'number' || count < 0) {
          malformed++;
          continue;
        }
        seenEvents.add(eventName);
        // '' is reserved for "all landing pages" in this table.
        const landing = byLanding ? row.dims.landingPagePlusQueryString || '(empty)' : '';
        const listed = env.plan.keyEventListed[eventName] === true;
        upsertTracked(
          env,
          'ga4_event_daily',
          returned,
          counts,
          { property_id: env.propertyId, date, channel_view: view, event_name: eventName, landing_page: landing },
          { date_tz: env.tz, event_count: Math.round(count), key_event_count: listed && typeof row.metrics.keyEvents === 'number' ? row.metrics.keyEvents : null, is_complete: date < env.incompleteFrom ? 1 : 0 },
          batchId,
        );
      }
      const scope: RetireScope = byLanding
        ? { equals: { property_id: env.propertyId, channel_view: view }, range: { column: 'date', start, end }, inList: { column: 'event_name', values: env.events }, where: (k) => k.landing_page !== '' }
        : { equals: { property_id: env.propertyId, channel_view: view, landing_page: '' }, range: { column: 'date', start, end }, inList: { column: 'event_name', values: env.events } };
      settleScope(ctx.db, 'ga4_event_daily', ctx.siteId, scope, returned, batchId, incompleteReasons(report, malformed), counts);
    });
    const reasons = incompleteReasons(report, malformed);
    const missingEvents = env.events.filter((e) => !seenEvents.has(e));
    const cov = coverageFrom(report, {
      eventsWithoutRows: missingEvents,
      eventsWithoutRowsMeaning: 'No rows means the event was not recorded in this range for this view: either not triggered or not tracked. Verify with the manual conversion checklist; it is not recorded as zero.',
      keyEventCountNote: 'key_event_count is NULL for events that getMetadata does not list as key events (keyEvents would read 0 for them).',
      malformedRows: malformed,
      retirement: retirementNote(counts, reasons),
      ...interruption(report.stoppedForQuota),
    });
    r.warnings.push(...cov.warnings);
    if (missingEvents.length) r.warnings.push(`No rows for configured event(s): ${missingEvents.join(', ')} (not triggered or not tracked; not stored as zero).`);
    retirementWarnings(r, counts, reasons, 'event row(s)');
    applyCounts(r, counts);
    r.status = r.truncated ? 'partial' : 'succeeded';
    finishBatch(ctx, batchId, { status: r.truncated ? 'partial' : 'succeeded', counts, apiPages: r.apiPages, truncated: r.truncated, coverage: cov.coverage, metadata: reportMetadata(env, report, { view, variant, events: env.events }), rawRefs: report.rawRefs });
    return r;
  };
  return { rateValues: [], commit };
}

async function fetchPeriod(env: Env, view: Ga4EventView, byLanding: boolean, start: string, end: string): Promise<Prepared> {
  const { ctx, plan } = env;
  const rateMetrics = [plan.primaryRateMetric, plan.primaryUserRateMetric].filter((m): m is string => !!m);
  const metrics = ['totalUsers', 'sessions', ...rateMetrics];
  const body = {
    dateRanges: [{ startDate: start, endDate: end }],
    ...(byLanding ? { dimensions: [{ name: 'landingPagePlusQueryString' }] } : {}),
    metrics: metrics.map((name) => ({ name })),
    ...(viewFilter(view) ? { dimensionFilter: viewFilter(view)! } : {}),
    keepEmptyRows: false,
  };
  const variant = byLanding ? 'by_landing_page' : 'all_landing_pages';
  const batchId = startBatch(ctx, { source: 'ga4', dataset: 'ga4_period_metrics', property: env.propertyId, dateStart: start, dateEnd: end, request: { ...body, limit: env.limit, view, variant }, transformationVersion: GA4_TRANSFORMATION_VERSION, synthetic: env.synthetic });
  const r = result('ga4_period_metrics', view, `${variant} ${start}..${end}`, batchId);
  const counts = emptyCounts();
  let report: PagedReport;
  try {
    report = await runReportAll(env.c, env.propertyId, body, { limit: env.limit, maxPages: env.maxPages, reserve: env.reserve, rawKind: `ga4-period-${view}-${variant}` });
    trackQuota(env, report);
  } catch (err) {
    r.status = 'failed';
    finishBatch(ctx, batchId, { status: 'failed', counts, apiPages: 0, truncated: false, error: err });
    throw err;
  }
  const rateValues = numbers(report.rows.flatMap((x) => rateMetrics.map((m) => x.metrics[m])));
  const commit = (): Ga4DatasetResult => {
    r.apiPages = report.pages;
    r.truncated = report.stoppedAtMaxPages || report.stoppedForQuota;
    const returned = new Set<string>();
    const upsert = (landing: string, metric: string, value: number | null, status: 'observed' | 'missing' | 'unavailable', isRate: boolean) =>
      upsertTracked(
        env,
        'ga4_period_metrics',
        returned,
        counts,
        { property_id: env.propertyId, period_start: start, period_end: end, channel_view: view, landing_page: landing, metric },
        { date_tz: env.tz, value, value_status: status, rate_scale: isRate && value !== null ? rowRateScale(env) : null, is_complete: end < env.incompleteFrom ? 1 : 0 },
        batchId,
      );
    ctx.db.transaction(() => {
      if (!byLanding && report.rows.length === 0) {
        // No row: GA4 drops all-zero rows, but thresholding can also withhold data. Recorded as missing, never as zero.
        for (const m of metrics) upsert('', m, null, 'missing', rateMetrics.includes(m));
      }
      for (const row of report.rows) {
        const landing = byLanding ? row.dims.landingPagePlusQueryString || '(empty)' : '';
        for (const m of metrics) {
          const raw = row.metrics[m];
          const isRate = rateMetrics.includes(m);
          const v = isRate ? normalizeRate(env, raw) : (raw ?? null);
          upsert(landing, m, v, v === null ? 'missing' : 'observed', isRate);
        }
      }
      if (!byLanding && plan.primaryEvent) {
        if (!plan.primaryRateMetric) upsert('', `sessionKeyEventRate:${plan.primaryEvent}`, null, 'unavailable', true);
        if (!plan.primaryUserRateMetric) upsert('', `userKeyEventRate:${plan.primaryEvent}`, null, 'unavailable', true);
      }
      // Scope: this exact period and view, the metrics this report requested, and site level vs per-landing rows.
      const scope: RetireScope = byLanding
        ? { equals: { property_id: env.propertyId, period_start: start, period_end: end, channel_view: view }, inList: { column: 'metric', values: metrics }, where: (k) => k.landing_page !== '' }
        : { equals: { property_id: env.propertyId, period_start: start, period_end: end, channel_view: view, landing_page: '' }, inList: { column: 'metric', values: metrics } };
      settleScope(ctx.db, 'ga4_period_metrics', ctx.siteId, scope, returned, batchId, incompleteReasons(report), counts);
    });
    const reasons = incompleteReasons(report);
    const cov = coverageFrom(report, {
      nonAdditive: 'totalUsers and rates are fetched at this period grain. Never sum daily or per-segment users; never average daily rates.',
      rateScale: { ...env.rateScale },
      retirement: retirementNote(counts, reasons),
    });
    r.warnings.push(...cov.warnings);
    retirementWarnings(r, counts, reasons, 'period metric row(s)');
    applyCounts(r, counts);
    r.status = r.truncated ? 'partial' : 'succeeded';
    finishBatch(ctx, batchId, { status: r.truncated ? 'partial' : 'succeeded', counts, apiPages: r.apiPages, truncated: r.truncated, coverage: cov.coverage, metadata: reportMetadata(env, report, { view, variant, metrics, window: { start, end } }), rawRefs: report.rawRefs });
    return r;
  };
  return { rateValues, commit };
}

/** Date-series slices synced for the configured events (landing views always). */
export function ga4Slices(opts: { events: boolean; landingEvents: boolean }): Ga4Slice[] {
  const out: Ga4Slice[] = (['google_organic', 'all_organic'] as const).map((view) => ({ key: `landing ${view}`, dataset: 'ga4_landing_daily', view }));
  if (opts.events) {
    for (const view of ['all_traffic', 'google_organic', 'all_organic'] as const) out.push({ key: `events ${view}`, dataset: 'ga4_event_daily', view, variant: 'all_landing_pages' });
    if (opts.landingEvents) for (const view of ['google_organic', 'all_organic'] as const) out.push({ key: `events ${view} by landing`, dataset: 'ga4_event_daily', view, variant: 'by_landing_page' });
  }
  return out;
}

function sliceGaps(ctx: AppContext, propertyId: string, slice: Ga4Slice, start: string, end: string): string[] {
  if (start > end) return [];
  return coverageGaps(ga4Coverage(ctx.db, ctx.siteId, { propertyId, start, end, channelView: slice.view, segmentKey: '', dataset: slice.dataset, ...(slice.variant ? { variant: slice.variant } : {}) }));
}

/**
 * Request range. Initial: the history window (initialHistoryDays).
 * Incremental: the recent refresh window (or from the day after the latest
 * complete landing date, if earlier), and, PER SLICE (landing per channel
 * view; events per view and variant), earlier when recorded coverage shows
 * dates of the history window that were never collected or whose collection
 * was interrupted (quota stop, failed report).
 */
export function computeGa4Range(ctx: AppContext, propertyId: string, today: string, days?: number, opts: { slices?: Ga4Slice[] } = {}): Ga4RangePlan {
  const end = addDays(today, -1);
  const slices = opts.slices ?? [];
  const flat = (start: string): Ga4SliceRange[] => slices.map((sl) => ({ ...sl, start, backfillFrom: null, gapDates: 0 }));
  if (days !== undefined) {
    if (!Number.isInteger(days) || days < 1) throw new ConfigError('--days must be a positive integer');
    const start = addDays(end, -(days - 1));
    return { start, end, mode: 'explicit', window: { start, end }, ...(slices.length ? { slices: flat(start) } : {}) };
  }
  const windowStart = addDays(end, -(ctx.config.google.ga4.initialHistoryDays - 1));
  const last = ctx.db.get<{ d: string | null }>('SELECT MAX(date) AS d FROM ga4_landing_daily WHERE site_id = ? AND property_id = ? AND is_current = 1 AND is_complete = 1', [ctx.siteId, propertyId])?.d;
  if (!last) return { start: windowStart, end, mode: 'initial', window: { start: windowStart, end }, ...(slices.length ? { slices: flat(windowStart) } : {}) };
  const refreshStart = addDays(end, -(ctx.config.google.ga4.refreshRecentDays - 1));
  const gapStart = addDays(last, 1);
  let base = gapStart < refreshStart ? gapStart : refreshStart;
  if (base > end) base = end;
  const ranges: Ga4SliceRange[] = slices.map((sl) => {
    const gaps = sliceGaps(ctx, propertyId, sl, windowStart, addDays(base, -1));
    return gaps.length ? { ...sl, start: gaps[0]!, backfillFrom: gaps[0]!, gapDates: gaps.length } : { ...sl, start: base, backfillFrom: null, gapDates: 0 };
  });
  const start = ranges.reduce((m, r) => (r.start < m ? r.start : m), base);
  return { start, end, mode: 'incremental', window: { start: windowStart < start ? windowStart : start, end }, ...(slices.length ? { slices: ranges } : {}) };
}

/** Validate and de-duplicate explicit GA4 periods (YYYY-MM-DD, start <= end). */
function normalizeExplicitPeriods(periods: SyncGa4Options['periods']): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = [];
  for (const p of periods ?? []) {
    if (!p || !isIsoDate(p.start) || !isIsoDate(p.end)) throw new ConfigError(`Invalid GA4 period ${JSON.stringify(p)}: use YYYY-MM-DD dates.`);
    if (p.start > p.end) throw new ConfigError(`Invalid GA4 period ${p.start}..${p.end}: start is after end.`);
    if (!out.some((x) => x.start === p.start && x.end === p.end)) out.push({ start: p.start, end: p.end });
  }
  return out;
}

/**
 * After a sync's rows are written: once the property's scale is established,
 * re-mark the rates earlier syncs stored while it was not (new revisions; the
 * earlier revision is kept). When nothing establishes it, try the
 * integer-consistency proof of 0-1 over the stored daily rows (never a
 * guess: see ga4-metadata.integerConsistencyScale); a proof is recorded like
 * a confirmation (basis 'integer_consistency', actor 'system') and audited.
 */
function settleStoredRateScale(ctx: AppContext, propertyId: string, scale: RateScale, synthetic: boolean): RateScale {
  if (scale.detected === 'percent_0_100') {
    // A contradicted 0-1 confirmation also re-marks the rows it marked 'fraction'.
    const remarked = remarkStoredRates(ctx, propertyId, 'percent', scale.source === 'confirmed' && scale.confirmation ? scale.confirmation.id : 'observed-above-1', { onlyUndetermined: !scale.contradiction });
    auditRemark(ctx, propertyId, 'percent', remarked, scale);
    return { ...scale, remarked };
  }
  if (scale.detected === 'fraction_0_1' && scale.confirmation) {
    const remarked = remarkStoredRates(ctx, propertyId, 'fraction', scale.confirmation.id, { onlyUndetermined: true });
    auditRemark(ctx, propertyId, 'fraction', remarked, scale);
    return { ...scale, remarked };
  }
  const proof = integerConsistencyFromStoredRows(ctx, propertyId);
  if (proof.decided !== 'fraction') return scale;
  const c = confirmRateScale(ctx, propertyId, {
    scale: 'fraction',
    basis: 'integer_consistency',
    actor: 'system',
    evidence: `Proven by the GA4 sync from stored daily rows: ${proof.reason}.`,
    evidenceDetail: { consistentRows: proof.consistentRows, inconsistentRows: proof.inconsistentRows, examples: proof.examples },
    synthetic,
    traceId: ctx.runId,
  });
  const recorded = loadRateScaleConfirmation(ctx, propertyId);
  return {
    detected: 'fraction_0_1',
    maxObserved: scale.maxObserved,
    normalized: false,
    source: 'proven',
    confirmation: recorded ? { id: recorded.id, basis: recorded.basis, confirmedAt: recorded.confirmedAt, actor: recorded.actor } : null,
    remarked: c.remarked,
  };
}

function auditRemark(ctx: AppContext, propertyId: string, target: 'fraction' | 'percent', remarked: RemarkResult, scale: RateScale): void {
  if (!remarked.landingRows && !remarked.periodRows) return;
  recordAudit(ctx.db, {
    siteId: ctx.siteId,
    actor: 'system',
    eventType: 'google.ga4.rate_scale_remarked',
    subjectType: 'ga4_property',
    subjectId: propertyId,
    traceId: ctx.runId,
    details: { target, remarked, source: scale.source ?? null, confirmationId: scale.confirmation?.id ?? null, contradiction: scale.contradiction ?? null },
    at: ctx.clock.now(),
  });
}

/** Human-readable notes on the key-event rate scale of one sync. */
function rateScaleWarnings(scale: RateScale, rateRequested: boolean): string[] {
  const out: string[] = [];
  const remarked = scale.remarked && (scale.remarked.landingRows || scale.remarked.periodRows) ? ` ${scale.remarked.landingRows} daily and ${scale.remarked.periodRows} period rate row(s) stored earlier with an undetermined scale were re-marked on this scale (new revisions; earlier revisions kept).` : '';
  if (scale.contradiction) out.push(`Key-event rate scale: ${scale.contradiction}. Rates are stored as 0-100 percentages (divided by 100).`);
  if (scale.detected === 'percent_0_100') {
    out.push(
      scale.source === 'stored'
        ? `Key-event rates for this property were earlier observed on a 0-100 scale (stored finding); all rates in this sync were divided by 100 and marked percent_normalized.${remarked}`
        : scale.source === 'confirmed'
          ? `Key-event rates are on a 0-100 scale (recorded confirmation ${scale.confirmation?.id ?? ''}, ${scale.confirmation?.confirmedAt ?? ''}); all rates in this sync were divided by 100 and marked percent_normalized.${remarked}`
          : `Key-event rate values above 1 were observed (max ${scale.maxObserved}); every rate in this sync was treated as a 0-100 percentage, stored as a fraction, and marked percent_normalized. The finding is stored for later syncs.${remarked}`,
    );
  } else if (scale.detected === 'fraction_0_1') {
    out.push(
      scale.source === 'proven'
        ? `Key-event rates are on a 0-1 scale, proven from stored daily rows (rate x sessions is a whole number of converting sessions on small rows; recorded as confirmation ${scale.confirmation?.id ?? ''}); rates are stored as reported and marked fraction.${remarked}`
        : `Key-event rates are on a 0-1 scale (recorded ${scale.confirmation?.basis === 'integer_consistency' ? 'integer-consistency proof' : 'owner confirmation'} ${scale.confirmation?.id ?? ''}, ${scale.confirmation?.confirmedAt ?? ''}); rates are stored as reported and marked fraction.${remarked}`,
    );
  } else if (rateRequested) {
    out.push(`Key-event rate scale (0-1 vs 0-100) is undocumented and nothing has established it for this property (no value above 1, no confirmation, and the stored daily rows do not prove it); rates are stored exactly as reported and marked scale "undetermined" (not verified fractions). Compare one stored value with the GA4 interface and confirm the scale: ${CONFIRM_RATE_SCALE_COMMAND}.`);
  }
  return out;
}

export async function syncGa4(ctx: AppContext, opts: SyncGa4Options): Promise<SyncGa4Result> {
  const synthetic = opts.provider.mode === 'fixture';
  const propertyId = ctx.config.google.ga4PropertyId;
  const base: SyncGa4Result = { status: 'succeeded', propertyId, timeZone: null, currencyCode: null, synthetic, range: null, metricPlan: null, datasets: [], limitations: [], warnings: [], rateScale: { detected: 'undetermined', maxObserved: null, normalized: false } };
  if (!ctx.settings.features.ga4) return { ...base, status: 'disabled', warnings: ['GA4 ingestion is disabled by the site feature flags (features.ga4).'] };
  if (!propertyId) {
    throw new AppError('CONFIG_MISSING', 'No GA4 property is configured (google.ga4PropertyId).', {
      hint: 'Copy the numeric GA4 property ID (GA4 Admin > Property details) into the site config. A measurement ID (G-...) is not a property ID.',
    });
  }
  ga4PropertyName(propertyId);
  const primary = ctx.config.conversions.primaryEvents.map((e) => e.name);
  const secondary = ctx.config.conversions.secondaryEvents.map((e) => e.name);
  const events = [...new Set([...primary, ...secondary])];
  const windows = opts.periodWindows ?? [7, 28];
  const explicitPeriods = normalizeExplicitPeriods(opts.periods);
  if (opts.dryRun || ctx.dryRun) {
    // Fails like the real run when the credential is missing (no network call, nothing written).
    const credentials = checkCredentialsOffline(opts.provider);
    const cached = loadCachedGa4Metadata(ctx, propertyId);
    return {
      ...base,
      status: 'dry_run',
      timeZone: cached?.timeZone ?? null,
      currencyCode: cached?.currencyCode ?? null,
      warnings: credentials.status === 'unverified' ? [credentials.note] : [],
      plan: {
        credentialCheck: credentials.status,
        notes: [
          'Dry run: no GA4 request was made and nothing was written.',
          credentials.note,
          'GA4 Data API reads are free but consume property token quotas; returnPropertyQuota is requested and paging stops at the configured reserve.',
          cached?.timeZone ? `Dates use the cached property time zone ${cached.timeZone}.` : 'The property time zone is read from GA4 on the first real sync.',
        ],
        reports: [
          'getMetadata + one probe report (time zone, currency) + checkCompatibility',
          ...(['google_organic', 'all_organic'] as const).map((v) => `ga4_landing_daily ${v}: date x landingPagePlusQueryString x hostName`),
          ...(events.length ? ['ga4_event_daily: all_traffic, google_organic, all_organic (+ by landing page for organic views)'] : ['ga4_event_daily skipped: no primary/secondary events configured']),
          ...windows.map((w) => `ga4_period_metrics: totalUsers, sessions, primary session and user key-event rates for the last ${w} complete days (site and landing-page level)`),
          ...explicitPeriods.map((p) => `ga4_period_metrics: totalUsers, sessions, primary session and user key-event rates for the explicit period ${p.start}..${p.end} (site and landing-page level)`),
        ],
      },
    };
  }

  assertNetworkAllowed(ctx, opts.provider, 'ga4');
  const client = await opts.provider.getClient();
  const c: Ga4CallContext = { ctx, client, synthetic, ...(opts.retry ? { retry: opts.retry } : {}) };
  const { metadata } = await getMetadata(c, propertyId);
  const compact = compactMetadata(metadata);
  const probe = await runReport(c, propertyId, { dateRanges: [{ startDate: 'yesterday', endDate: 'yesterday' }], metrics: [{ name: 'sessions' }], limit: '1', returnPropertyQuota: true }, 'ga4-probe');
  const cached = loadCachedGa4Metadata(ctx, propertyId);
  const tzReported = probe.response.metadata?.timeZone ?? null;
  const tz = tzReported && isValidTimeZone(tzReported) ? tzReported : cached?.timeZone ?? null;
  const currency = probe.response.metadata?.currencyCode ?? cached?.currencyCode ?? null;
  cacheGa4Metadata(ctx, propertyId, compact, { timeZone: tzReported && isValidTimeZone(tzReported) ? tzReported : null, currencyCode: probe.response.metadata?.currencyCode ?? null });
  if (!tz) {
    throw new AppError('DATA_UNAVAILABLE', 'GA4 did not report the property time zone, so report dates cannot be interpreted.', { hint: 'Retry the sync; if it persists, run `npm run cli -- auth diagnose`.' });
  }
  const warnings: string[] = [];
  if (cached?.timeZone && tzReported && cached.timeZone !== tzReported) warnings.push(`GA4 property time zone changed from ${cached.timeZone} to ${tzReported}; earlier rows keep their recorded date_tz.`);

  const incompatible = new Set<string>();
  try {
    const compat = await checkCompatibility(c, propertyId, { dimensions: LANDING_DIMENSIONS.map((name) => ({ name })), dimensionFilter: CHANNEL_VIEWS.google_organic.filter });
    for (const m of compat.response.metricCompatibilities ?? []) {
      if (m.compatibility === 'INCOMPATIBLE' && m.metricMetadata?.apiName) incompatible.add(m.metricMetadata.apiName);
    }
  } catch (err) {
    if (err instanceof GoogleApiError && (err.kind === 'invalid_argument' || err.kind === 'server_error')) warnings.push(`checkCompatibility failed (${err.message}); metric compatibility is unverified for this sync.`);
    else throw err;
  }
  const plan = planGa4Metrics(compact, { primary, secondary }, incompatible);
  const today = dateInZone(ctx.clock.now(), tz);
  const slices = ga4Slices({ events: events.length > 0, landingEvents: opts.includeLandingEvents !== false });
  const range = computeGa4Range(ctx, propertyId, today, opts.days, { slices });
  const sliceStart = (key: string): string => range.slices?.find((x) => x.key === key)?.start ?? range.start;
  for (const sl of range.slices ?? []) {
    if (sl.backfillFrom) warnings.push(`Backfill: ${sl.key} is re-requested from ${sl.backfillFrom} because ${sl.gapDates} date(s) of the history window before the refresh start were never collected or their collection was interrupted (for example an earlier sync stopped at a quota).`);
  }
  const incompleteFrom = addDays(today, -(GA4_ASSUMED_PROCESSING_DAYS - 1));
  const collectedAt = ctx.clock.now().toISOString();
  const env: Env = {
    ctx,
    c,
    propertyId,
    tz,
    currency,
    synthetic,
    limit: opts.limit ?? 100_000,
    maxPages: opts.maxPagesPerReport ?? 50,
    reserve: opts.quotaReserve ?? DEFAULT_QUOTA_RESERVE,
    incompleteFrom,
    plan,
    events,
    rateScale: { ...base.rateScale }, // decided after all reports are fetched
    lastQuota: probe.response.propertyQuota ?? null,
    quotaStop: quotaLow(probe.response.propertyQuota, opts.quotaReserve ?? DEFAULT_QUOTA_RESERVE),
    meta: (batchId) => ({ batchId, collectedAt, transformationVersion: GA4_TRANSFORMATION_VERSION, isSynthetic: synthetic }),
  };
  const out: SyncGa4Result = { ...base, timeZone: tz, currencyCode: currency, range: { ...range, incompleteFrom }, metricPlan: plan, limitations: plan.limitations.map((l) => `${l.metric}: ${l.reason}`), warnings };
  if (!plan.coreMetrics.includes('sessions')) {
    throw new AppError('DATA_UNAVAILABLE', 'GA4 metadata does not list the sessions metric for this property; landing-page ingestion cannot run.', { hint: 'Run `npm run cli -- auth diagnose`.' });
  }

  const latestComplete = addDays(incompleteFrom, -1);
  const tasks: Array<{ label: string; dataset: VersionedTable; fetch: () => Promise<Prepared> }> = [];
  for (const view of ['google_organic', 'all_organic'] as const) tasks.push({ label: `landing ${view}`, dataset: 'ga4_landing_daily', fetch: () => fetchLandingView(env, view, sliceStart(`landing ${view}`), range.end) });
  if (events.length) {
    for (const view of ['all_traffic', 'google_organic', 'all_organic'] as const) tasks.push({ label: `events ${view}`, dataset: 'ga4_event_daily', fetch: () => fetchEventView(env, view, false, sliceStart(`events ${view}`), range.end) });
    if (opts.includeLandingEvents !== false) for (const view of ['google_organic', 'all_organic'] as const) tasks.push({ label: `events ${view} by landing`, dataset: 'ga4_event_daily', fetch: () => fetchEventView(env, view, true, sliceStart(`events ${view} by landing`), range.end) });
  } else {
    out.warnings.push('No primary or secondary events are configured (conversions.*); event metrics were not requested.');
  }
  const periodKeys = new Set<string>();
  for (const w of windows) {
    if (!Number.isInteger(w) || w < 1) continue;
    const ps = addDays(latestComplete, -(w - 1));
    periodKeys.add(`${ps}..${latestComplete}`);
    for (const view of ['google_organic', 'all_organic', 'all_traffic'] as const) tasks.push({ label: `period ${w}d ${view}`, dataset: 'ga4_period_metrics', fetch: () => fetchPeriod(env, view, false, ps, latestComplete) });
    for (const view of ['google_organic', 'all_organic'] as const) tasks.push({ label: `period ${w}d ${view} by landing`, dataset: 'ga4_period_metrics', fetch: () => fetchPeriod(env, view, true, ps, latestComplete) });
  }
  for (const p of explicitPeriods) {
    if (periodKeys.has(`${p.start}..${p.end}`)) continue;
    periodKeys.add(`${p.start}..${p.end}`);
    if (p.end >= incompleteFrom) warnings.push(`Explicit GA4 period ${p.start}..${p.end} ends on or after ${incompleteFrom}, which may still be processing; its rows are stored with is_complete = 0.`);
    for (const view of ['google_organic', 'all_organic', 'all_traffic'] as const) tasks.push({ label: `period ${p.start}..${p.end} ${view}`, dataset: 'ga4_period_metrics', fetch: () => fetchPeriod(env, view, false, p.start, p.end) });
    for (const view of ['google_organic', 'all_organic'] as const) tasks.push({ label: `period ${p.start}..${p.end} ${view} by landing`, dataset: 'ga4_period_metrics', fetch: () => fetchPeriod(env, view, true, p.start, p.end) });
  }

  // Phase 1: fetch every report (nothing is written yet, except batch bookkeeping).
  const slots: Array<Ga4DatasetResult | Prepared | null> = tasks.map(() => null);
  let stopped: string | null = null;
  let fatal: unknown = undefined;
  for (const [i, t] of tasks.entries()) {
    if (stopped || env.quotaStop) {
      stopped ??= `GA4 quota reserve reached (${env.quotaStop})`;
      slots[i] = { ...result(t.dataset, t.label, 'skipped', null), status: 'skipped', warnings: [`Skipped: ${stopped}`] };
      continue;
    }
    try {
      slots[i] = await t.fetch();
    } catch (err) {
      if (isQuotaStop(err)) {
        stopped = err.message;
        slots[i] = { ...result(t.dataset, t.label, 'failed', null), status: 'failed', warnings: [`Failed: ${err.message}`] };
        out.warnings.push(`${err.message}. ${err.hint ?? ''}`.trim());
        continue;
      }
      fatal = err;
      break;
    }
  }

  // Phase 2: decide the rate scale from EVERY fetched rate value (and the stored finding), then write.
  const prepared = slots.filter((x): x is Prepared => !!x && 'commit' in x);
  const storedScale = loadRateScale(ctx, propertyId);
  const confirmation = loadRateScaleConfirmation(ctx, propertyId);
  env.rateScale = decideRateScale(storedScale, prepared.flatMap((p) => p.rateValues), confirmation);
  if (env.rateScale.detected === 'percent_0_100' && (env.rateScale.source === 'this_sync' || env.rateScale.source === 'stored') && storedScale?.scale !== 'percent_0_100') {
    saveRateScale(ctx, propertyId, { scale: 'percent_0_100', maxObserved: env.rateScale.maxObserved, detectedAt: ctx.clock.now().toISOString() });
  } else if (env.rateScale.maxObserved !== (storedScale?.maxObserved ?? null) || !storedScale) {
    saveRateScale(ctx, propertyId, { scale: storedScale?.scale ?? 'undetermined', maxObserved: env.rateScale.maxObserved, detectedAt: storedScale?.detectedAt ?? null });
  }
  for (const [i, slot] of slots.entries()) {
    if (slot && 'commit' in slot) slots[i] = slot.commit();
  }
  if (fatal !== undefined) throw fatal;
  out.datasets = slots.filter((x): x is Ga4DatasetResult => !!x && !('commit' in x));

  // Rates stored by earlier syncs while the scale was not established are re-marked now (new revisions).
  env.rateScale = settleStoredRateScale(ctx, propertyId, env.rateScale, synthetic);

  if (stopped) out.warnings.push(`Stopped early: ${stopped}. Re-run later; unchanged rows are not duplicated.`);
  for (const d of out.datasets) out.warnings.push(...d.warnings.map((w) => `[${d.dataset} ${d.view} ${d.variant}] ${w}`));
  out.rateScale = env.rateScale;
  out.warnings.push(...rateScaleWarnings(env.rateScale, !!plan.primaryRateMetric));
  // Known gaps left in the target window keep the sync 'partial' until a later sync collects them.
  const gaps: Ga4CoverageGap[] = [];
  const w = range.window ?? { start: range.start, end: range.end };
  for (const sl of slices) {
    const g = sliceGaps(ctx, propertyId, sl, w.start, w.end);
    if (g.length) gaps.push({ slice: sl.key, firstDate: g[0]!, dates: g.length });
  }
  if (gaps.length) {
    out.gaps = gaps;
    for (const g of gaps) out.warnings.push(`Coverage gap: ${g.dates} date(s) of ${g.slice} from ${g.firstDate} in the target window are not collected (missing, not zero); the next incremental sync backfills them.`);
  }
  out.status = out.datasets.some((d) => d.status !== 'succeeded') || stopped || gaps.length > 0 ? 'partial' : 'succeeded';
  if (!plan.primaryRateMetric) out.checklist = ga4ConversionChecklist(ctx.config, plan);

  recordAudit(ctx.db, {
    siteId: ctx.siteId,
    actor: 'system',
    eventType: 'google.ga4.synced',
    subjectType: 'ga4_property',
    subjectId: propertyId,
    traceId: ctx.runId,
    details: { status: out.status, synthetic, range: out.range, limitations: out.limitations, datasets: out.datasets.map((d) => ({ dataset: d.dataset, view: d.view, variant: d.variant, status: d.status, rows: d.rowsReceived })) },
    at: ctx.clock.now(),
  });
  return out;
}
