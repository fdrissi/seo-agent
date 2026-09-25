import type { Db } from '../database/db.js';
import { parseJson } from '../database/db.js';
import { eachDate, type IsoDate } from '../core/time.js';
import { normalizeUrl } from '../seo/url.js';
import { batchUncollectedDates, describeRowLoss, ga4BatchRowLoss, type Ga4RowLoss } from '../seo/coverage.js';
import { rateScaleClass, rateScaleUnverifiedReason, rateToFraction } from '../seo/metrics.js';

/**
 * Window metrics for experiment measurement, computed from CURRENT-revision
 * GSC and GA4 rows (the *_current views), at compatible grain:
 *
 * - GSC page rows (aggregation byPage), one search type, one segment_key.
 *   CTR = sum(clicks) / sum(impressions); position = impression-weighted mean
 *   of reported positions. Property totals and page/query rows are never mixed in.
 * - GA4 landing-page rows for one channel view (google_organic by default,
 *   comparable with GSC) and one segment_key. Session conversion rate uses the
 *   reported event-specific sessionKeyEventRate: converting sessions are
 *   estimated as sum(rate x sessions) and the window rate is that sum divided
 *   by sessions. Repeatable key-event counts are reported as occurrences and
 *   never divided by sessions. A rate whose stored scale is 'undetermined'
 *   (0-1 vs 0-100 not established, see seo/metrics.rateScaleClass) is never
 *   used as a fraction: the window rate is then unavailable with the reason.
 *   Once the property's scale is established (`sync ga4 --confirm-rate-scale`,
 *   the integer-consistency proof, or a value above 1), the GA4 module
 *   re-marks the stored rows as new revisions ('fraction' or
 *   'percent_normalized', migration 0320), so baseline and observation windows
 *   (and the primarySessionRate guardrail) use the confirmed scale, older days
 *   included.
 *
 * Missing is not zero. Coverage comes from the SAME dataset as the metric
 * (property totals and page rows are separate datasets and never stand in for
 * each other):
 * - A date is covered when the page-level dataset (gsc_page_daily /
 *   ga4_landing_daily, same property, search type or channel view, and
 *   segment_key) has at least one current row for it. On a covered date, a
 *   page without a row is an observed zero (GSC and GA4 omit all-zero rows).
 * - A date without any page-level row is missing, even when property totals
 *   exist for it (the page sync may lag or run on another cadence).
 * - A date covered by an ingestion batch that hit a row limit (truncated) is
 *   uncertain for pages without a row that day (they may have been dropped):
 *   such dates are reported in `truncatedDates` and make the window
 *   incomplete, never zero.
 * - GA4 only: a covered date whose covering landing-page report(s) ALL said
 *   rows may be left out ("(other)" bucketing, thresholding, sampling; the
 *   batch's stored response metadata, same rule as seo/coverage.ga4Coverage)
 *   is uncertain for a page without a row that day: such dates are reported
 *   in `rowLossDates` and handled like `truncatedDates` (window incomplete).
 *   On a window with such uncertain dates the primary rate and revenue are
 *   never 'observed', and when the page has no row at all in the window its
 *   sessions, key events, and revenue are null (unknown), never 0. With some
 *   rows, the additive sums cover only the dates with rows: a lower bound on
 *   an incomplete window, never compared as a complete total.
 * - GA4 only: a covered date on which the identity's landing values are
 *   ESTIMATES, whether or not it has a row, is reported in `estimateDates`
 *   (with `estimateReasons`) and makes the window incomplete. That is a date
 *   whose covering landing-page report(s) were ALL sampled or bucketed rows
 *   into "(other)", or on which a current row of the identity came from such
 *   a report (a later report that re-stated the row replaces its batch).
 *   Sampled values are estimates; with "(other)" bucketing, some
 *   landingPagePlusQueryString variants of a page can sit in the "(other)"
 *   row, so the page total can be partial. The sums stay (estimates of an
 *   incomplete window), but the primary rate and revenue are never
 *   'observed'. Thresholding alone does not make present rows estimates
 *   (GA4 withholds whole rows and sets the flag even when nothing is
 *   withheld); it only makes ABSENT rows unknown (`rowLossDates`).
 * - Non-final/incomplete days make the window "incomplete".
 */

export interface PageIdentity {
  pageIds: string[];
  urls: string[];
  landingPaths: string[];
  hosts: string[];
  /** Number of pages this identity stands for (1 for a treated page, N for a comparison group). */
  pageCount: number;
}

export function pageIdentity(db: Db, siteId: string, pages: Array<{ id: string | null; url: string }>): PageIdentity {
  const pageIds = new Set<string>();
  const urls = new Set<string>();
  for (const p of pages) {
    if (p.id) {
      pageIds.add(p.id);
      for (const a of db.all<{ alias_url: string }>(`SELECT alias_url FROM url_aliases WHERE site_id = ? AND page_id = ? AND confidence = 'established'`, [siteId, p.id])) urls.add(a.alias_url);
    }
    urls.add(p.url);
  }
  const landingPaths = new Set<string>();
  const hosts = new Set<string>();
  for (const u of urls) {
    const n = normalizeUrl(u);
    if (!n) continue;
    landingPaths.add(n.path);
    landingPaths.add(n.pathWithQuery);
    hosts.add(n.host);
  }
  return { pageIds: [...pageIds], urls: [...urls], landingPaths: [...landingPaths], hosts: [...hosts], pageCount: pages.length };
}

// ------------------------------------------------------------ coverage helpers

interface BatchRow {
  date_start: string;
  date_end: string;
  truncated: number;
  coverage_json: string | null;
  request_json: string;
  started_at: string;
}

/**
 * Dates in [start, end] whose LATEST covering ingestion batch of this dataset
 * hit a row limit. GSC page batches list the affected dates
 * (coverage.truncatedDates); a truncated batch without that list taints its
 * whole range. `relevant` filters batches by request (search type, segment,
 * channel view).
 */
function truncatedBatchDates(
  db: Db,
  q: { siteId: string; source: 'gsc' | 'ga4'; dataset: string; property: string | null; start: IsoDate; end: IsoDate },
  relevant: (request: Record<string, unknown>) => boolean,
): Set<string> {
  const propFilter = q.property ? ' AND property = ?' : '';
  const batches = db
    .all<BatchRow>(
      `SELECT date_start, date_end, truncated, coverage_json, request_json, started_at FROM ingestion_batches
       WHERE site_id = ? AND source = ? AND dataset = ? AND status IN ('succeeded', 'partial') AND date_start <= ? AND date_end >= ?${propFilter}
       ORDER BY started_at DESC, id DESC LIMIT 1000`,
      [q.siteId, q.source, q.dataset, q.end, q.start, ...(q.property ? [q.property] : [])],
    )
    .filter((b) => relevant(parseJson<Record<string, unknown>>(b.request_json, {}) ?? {}));
  const out = new Set<string>();
  if (!batches.some((b) => b.truncated === 1)) return out;
  for (const d of eachDate(q.start, q.end)) {
    const latest = batches.find((b) => b.date_start <= d && d <= b.date_end);
    if (!latest || latest.truncated !== 1) continue;
    const listed = parseJson<{ truncatedDates?: unknown } | null>(latest.coverage_json, null)?.truncatedDates;
    if (!Array.isArray(listed) || listed.includes(d)) out.add(d);
  }
  return out;
}

/**
 * GA4 row loss per date in [start, end]: the dates on which EVERY covering
 * landing-page batch of this channel view (succeeded/partial, the date not
 * left uncollected by an interrupted batch) reported that rows may be left
 * out ("(other)" bucketing, thresholding, sampling), with the reasons. One
 * covering report free of row loss proves absence (the same rule as
 * seo/coverage.ga4Coverage, which the router, analysis, and reports use).
 * Works without a configured property (all properties' batches are read,
 * like the metric rows). `only` restricts the reasons that count (e.g.
 * sampling and "(other)" for estimate dates): a batch reporting none of them
 * counts as clean.
 */
function rowLossBatchDates(
  db: Db,
  q: { siteId: string; property: string | null; start: IsoDate; end: IsoDate },
  relevant: (request: Record<string, unknown>) => boolean,
  only?: ReadonlySet<Ga4RowLoss>,
): Map<string, Ga4RowLoss[]> {
  const propFilter = q.property ? ' AND property = ?' : '';
  const batches = db
    .all<{ date_start: string; date_end: string; request_json: string; metadata_json: string | null; coverage_json: string | null }>(
      `SELECT date_start, date_end, request_json, metadata_json, coverage_json FROM ingestion_batches
       WHERE site_id = ? AND source = 'ga4' AND dataset = 'ga4_landing_daily' AND status IN ('succeeded', 'partial') AND date_start <= ? AND date_end >= ?${propFilter}`,
      [q.siteId, q.end, q.start, ...(q.property ? [q.property] : [])],
    )
    .filter((b) => relevant(parseJson<Record<string, unknown>>(b.request_json, {}) ?? {}));
  const out = new Map<string, Ga4RowLoss[]>();
  const loss = batches.map((b) => ga4BatchRowLoss(b.metadata_json).filter((r) => !only || only.has(r)));
  if (!loss.some((l) => l.length > 0)) return out;
  const uncollected = batches.map((b) => batchUncollectedDates(b));
  for (const d of eachDate(q.start, q.end)) {
    const covering = batches.map((_, i) => i).filter((i) => batches[i]!.date_start <= d && d <= batches[i]!.date_end && !uncollected[i]?.has(d));
    if (covering.length && covering.every((i) => loss[i]!.length > 0)) out.set(d, [...new Set(covering.flatMap((i) => loss[i]!))]);
  }
  return out;
}

/**
 * Row-loss reasons that make PRESENT GA4 landing values estimates: a sampled
 * report, or one that bucketed rows into "(other)" (a page's
 * landingPagePlusQueryString variants may be counted there). Thresholding is
 * not one of them (see the file comment).
 */
const ESTIMATE_LOSS: ReadonlySet<Ga4RowLoss> = new Set<Ga4RowLoss>(['sampling', 'other_row']);

/** Estimate reasons (ESTIMATE_LOSS) of the batches that produced rows, by batch id (site-scoped). */
function estimateLossOfBatches(db: Db, siteId: string, batchIds: string[]): Map<string, Ga4RowLoss[]> {
  const out = new Map<string, Ga4RowLoss[]>();
  for (let i = 0; i < batchIds.length; i += 500) {
    const chunk = batchIds.slice(i, i + 500);
    for (const b of db.all<{ id: string; metadata_json: string | null }>(`SELECT id, metadata_json FROM ingestion_batches WHERE site_id = ? AND id IN (${ph(chunk.length)})`, [siteId, ...chunk])) {
      const reasons = ga4BatchRowLoss(b.metadata_json).filter((r) => ESTIMATE_LOSS.has(r));
      if (reasons.length) out.set(b.id, reasons);
    }
  }
  return out;
}

/** Does a GSC page-dataset batch request match this search type and segment? Unknown request fields are treated as matching (conservative). */
function gscBatchRelevant(searchType: string, segmentKey: string): (req: Record<string, unknown>) => boolean {
  return (req) => {
    if (typeof req.type === 'string' && req.type !== searchType) return false;
    const dims = Array.isArray(req.dimensions) ? req.dimensions : null;
    const filtered = Array.isArray(req.dimensionFilterGroups) && req.dimensionFilterGroups.length > 0;
    const unsegmented = (!dims || dims.length <= 2) && !filtered;
    return segmentKey === '' ? unsegmented : !unsegmented || (!dims && !filtered);
  };
}

function ga4BatchRelevant(channelView: string): (req: Record<string, unknown>) => boolean {
  return (req) => typeof req.view !== 'string' || req.view === channelView;
}

const ph = (n: number) => Array.from({ length: n }, () => '?').join(', ');

export type WindowStatus = 'observed' | 'incomplete' | 'unavailable';

export interface GscMetrics {
  status: WindowStatus;
  reason: string | null;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
  positionPartial: boolean;
  daysExpected: number;
  daysWithData: number;
  missingDates: string[];
  nonFinalDates: string[];
  /** Covered dates hit by a row-limit truncation on which this identity has no (or not every) row: uncertain, never zero. */
  truncatedDates: string[];
  rows: number;
  anySynthetic: boolean;
}

export interface GscQuery {
  siteId: string;
  property: string | null;
  searchType: string;
  segmentKey: string;
  start: IsoDate;
  end: IsoDate;
}

export function gscWindowMetrics(db: Db, id: PageIdentity, q: GscQuery): GscMetrics {
  const propFilter = q.property ? ' AND property = ?' : '';
  const propParam = q.property ? [q.property] : [];
  // Coverage from the page-level dataset only (same property, search type, segment).
  const dates = db.all<{ date: string; fin: number; syn: number }>(
    `SELECT date, MIN(is_final) AS fin, MAX(is_synthetic) AS syn FROM gsc_page_daily_current
     WHERE site_id = ? AND search_type = ? AND segment_key = ? AND date BETWEEN ? AND ?${propFilter} GROUP BY date`,
    [q.siteId, q.searchType, q.segmentKey, q.start, q.end, ...propParam],
  );
  const expected = eachDate(q.start, q.end);
  const have = new Map(dates.map((d) => [d.date, d]));
  const missingDates = expected.filter((d) => !have.has(d));
  const nonFinalDates = dates.filter((d) => d.fin !== 1).map((d) => d.date);
  const base = {
    daysExpected: expected.length,
    daysWithData: dates.length,
    missingDates,
    nonFinalDates,
    truncatedDates: [] as string[],
  };
  if (!dates.length) {
    return {
      status: 'unavailable',
      reason: 'no Search Console page-level data for this property/search type/segment in the window',
      clicks: null,
      impressions: null,
      ctr: null,
      position: null,
      positionPartial: false,
      rows: 0,
      anySynthetic: false,
      ...base,
    };
  }
  const idParts: string[] = [];
  const idParams: unknown[] = [];
  if (id.pageIds.length) {
    idParts.push(`page_id IN (${ph(id.pageIds.length)})`);
    idParams.push(...id.pageIds);
  }
  if (id.urls.length) {
    idParts.push(`(page_id IS NULL AND page IN (${ph(id.urls.length)}))`);
    idParams.push(...id.urls);
  }
  if (!idParts.length) {
    return { status: 'unavailable', reason: 'page identity is empty', clicks: null, impressions: null, ctr: null, position: null, positionPartial: false, rows: 0, anySynthetic: false, ...base };
  }
  const idWhere = `site_id = ? AND search_type = ? AND segment_key = ? AND date BETWEEN ? AND ?${propFilter} AND (${idParts.join(' OR ')})`;
  const idArgs = [q.siteId, q.searchType, q.segmentKey, q.start, q.end, ...propParam, ...idParams];
  const agg = db.get<{ c: number | null; i: number | null; pw: number | null; iw: number | null; n: number; syn: number | null }>(
    `SELECT SUM(clicks) AS c, SUM(impressions) AS i,
            SUM(CASE WHEN position IS NOT NULL THEN position * impressions END) AS pw,
            SUM(CASE WHEN position IS NOT NULL THEN impressions END) AS iw,
            COUNT(*) AS n, MAX(is_synthetic) AS syn
     FROM gsc_page_daily_current WHERE ${idWhere}`,
    idArgs,
  )!;
  // Row-limit truncation: on a truncated date, a page without a row may have been dropped, so it is not a zero.
  const truncated = truncatedBatchDates(db, { siteId: q.siteId, source: 'gsc', dataset: 'gsc_page_daily', property: q.property, start: q.start, end: q.end }, gscBatchRelevant(q.searchType, q.segmentKey));
  if (truncated.size) {
    const perDate = new Map(
      db
        .all<{ date: string; pages: number }>(`SELECT date, COUNT(DISTINCT COALESCE(page_id, page)) AS pages FROM gsc_page_daily_current WHERE ${idWhere} GROUP BY date`, idArgs)
        .map((r) => [r.date, r.pages]),
    );
    base.truncatedDates = [...truncated].filter((d) => have.has(d) && (perDate.get(d) ?? 0) < id.pageCount).sort();
  }
  // Covered dates only: absent page rows on covered, untruncated dates are observed zeros. Without
  // any row in the window and with truncated dates, the total is unknown (never a fabricated 0).
  const unknownTotal = agg.n === 0 && base.truncatedDates.length > 0;
  const clicks = unknownTotal ? null : (agg.c ?? 0);
  const impressions = unknownTotal ? null : (agg.i ?? 0);
  const incomplete = missingDates.length || nonFinalDates.length || base.truncatedDates.length;
  const status: WindowStatus = incomplete ? 'incomplete' : 'observed';
  return {
    status,
    reason: incomplete
      ? `${missingDates.length} missing, ${nonFinalDates.length} non-final, and ${base.truncatedDates.length} row-limit-truncated day(s) in the window (page-level dataset)${
          unknownTotal ? '; the page has no row in the window and rows may have been dropped on the truncated day(s): clicks and impressions are unknown, not zero' : ''
        }`
      : null,
    clicks,
    impressions,
    ctr: clicks !== null && impressions !== null && impressions > 0 ? clicks / impressions : null,
    position: agg.iw && agg.iw > 0 && agg.pw !== null ? agg.pw / agg.iw : null,
    positionPartial: (agg.iw ?? 0) < (impressions ?? 0),
    rows: agg.n,
    anySynthetic: (agg.syn ?? 0) === 1 || dates.some((d) => d.syn === 1),
    ...base,
  };
}

export interface Ga4Metrics {
  status: WindowStatus;
  reason: string | null;
  sessions: number | null;
  engagedSessions: number | null;
  engagedSessionRate: number | null;
  /** Estimated from the reported event-specific session key-event rate x sessions. */
  convertingSessions: number | null;
  primarySessionRate: number | null;
  primaryRateStatus: WindowStatus;
  /** Why the primary rate is not observed (e.g. "rate scale unverified: ..."); null when observed. */
  primaryRateReason?: string | null;
  primaryEventName: string | null;
  /** Primary key-event OCCURRENCES (repeatable); never a rate. */
  primaryKeyEvents: number | null;
  revenueMicros: number | null;
  revenueCurrency: string | null;
  revenueStatus: WindowStatus;
  daysExpected: number;
  daysWithData: number;
  missingDates: string[];
  incompleteDates: string[];
  /** Covered dates hit by a truncated landing-page batch on which this identity has no (or not every) row: uncertain, never zero. */
  truncatedDates: string[];
  /**
   * Covered dates (not already in truncatedDates) whose covering landing-page
   * report(s) all said rows may be left out ("(other)" bucketing,
   * thresholding, sampling) and on which this identity has no (or not every)
   * row: uncertain, never zero.
   */
  rowLossDates: string[];
  /** Row-loss reasons GA4 reported for rowLossDates (empty when none). */
  rowLossReasons: Ga4RowLoss[];
  /**
   * Covered dates on which this identity's landing values are estimates or
   * partial totals, whether or not it has a row: every covering landing-page
   * report was sampled or bucketed rows into "(other)", or a current row of
   * the identity came from such a report. The window is then incomplete and
   * its rate and revenue are not observed. Always set by ga4WindowMetrics
   * (optional only for records computed before evaluation method v3).
   */
  estimateDates?: string[];
  /** The reasons for estimateDates: 'sampling' and/or 'other_row' (empty when none). */
  estimateReasons?: Ga4RowLoss[];
  rows: number;
  anySynthetic: boolean;
}

/** Covered dates of a GA4 window on which a page without a row is unknown, not zero (row-limit truncation or GA4 row loss). */
export function ga4UncertainDates(m: Pick<Ga4Metrics, 'truncatedDates'> & Partial<Pick<Ga4Metrics, 'rowLossDates'>>): string[] {
  return [...new Set([...(m.truncatedDates ?? []), ...(m.rowLossDates ?? [])])].sort();
}

/** Covered dates of a GA4 window whose landing values are estimates or partial (sampling, "(other)" bucketing): never exact numbers. */
export function ga4EstimateDates(m: Partial<Pick<Ga4Metrics, 'estimateDates'>>): string[] {
  return [...(m.estimateDates ?? [])].sort();
}

export interface Ga4Query {
  siteId: string;
  propertyId: string | null;
  channelView: 'google_organic' | 'all_organic';
  segmentKey: string;
  start: IsoDate;
  end: IsoDate;
}

interface Ga4Row {
  date: string;
  sessions: number;
  engaged_sessions: number | null;
  primary_event_name: string | null;
  primary_key_events: number | null;
  primary_key_events_status: string;
  primary_session_rate: number | null;
  primary_session_rate_status: string;
  primary_session_rate_scale: string | null;
  revenue_micros: number | null;
  revenue_currency: string | null;
  revenue_status: string;
  is_complete: number;
  is_synthetic: number;
  batch_id: string | null;
}

export function ga4WindowMetrics(db: Db, id: PageIdentity, q: Ga4Query): Ga4Metrics {
  const propFilter = q.propertyId ? ' AND property_id = ?' : '';
  const propParam = q.propertyId ? [q.propertyId] : [];
  // Coverage from the landing-page dataset only (same property, channel view, segment).
  const dates = db.all<{ date: string; comp: number; syn: number }>(
    `SELECT date, MIN(is_complete) AS comp, MAX(is_synthetic) AS syn FROM ga4_landing_daily_current
     WHERE site_id = ? AND channel_view = ? AND segment_key = ? AND date BETWEEN ? AND ?${propFilter} GROUP BY date`,
    [q.siteId, q.channelView, q.segmentKey, q.start, q.end, ...propParam],
  );
  const expected = eachDate(q.start, q.end);
  const have = new Set(dates.map((d) => d.date));
  const missingDates = expected.filter((d) => !have.has(d));
  const incompleteDates = dates.filter((d) => d.comp !== 1).map((d) => d.date);
  const empty: Ga4Metrics = {
    status: 'unavailable',
    reason: 'no GA4 landing-page data for this property/channel view in the window',
    sessions: null,
    engagedSessions: null,
    engagedSessionRate: null,
    convertingSessions: null,
    primarySessionRate: null,
    primaryRateStatus: 'unavailable',
    primaryEventName: null,
    primaryKeyEvents: null,
    revenueMicros: null,
    revenueCurrency: null,
    revenueStatus: 'unavailable',
    daysExpected: expected.length,
    daysWithData: dates.length,
    missingDates,
    incompleteDates,
    truncatedDates: [],
    rowLossDates: [],
    rowLossReasons: [],
    estimateDates: [],
    estimateReasons: [],
    rows: 0,
    anySynthetic: false,
  };
  if (!dates.length) return empty;
  const idParts: string[] = [];
  const idParams: unknown[] = [];
  if (id.pageIds.length) {
    idParts.push(`page_id IN (${ph(id.pageIds.length)})`);
    idParams.push(...id.pageIds);
  }
  if (id.landingPaths.length) {
    const hostClause = id.hosts.length ? `(host_name IN (${ph(id.hosts.length)}) OR host_name = '')` : `host_name = ''`;
    idParts.push(`(page_id IS NULL AND landing_page IN (${ph(id.landingPaths.length)}) AND ${hostClause})`);
    idParams.push(...id.landingPaths, ...id.hosts);
  }
  if (!idParts.length) return { ...empty, reason: 'page identity is empty' };
  const rows = db.all<Ga4Row & { pkey: string }>(
    `SELECT date, sessions, engaged_sessions, primary_event_name, primary_key_events, primary_key_events_status, primary_session_rate, primary_session_rate_status, primary_session_rate_scale,
            revenue_micros, revenue_currency, revenue_status, is_complete, is_synthetic, batch_id, COALESCE(page_id, host_name || landing_page) AS pkey
     FROM ga4_landing_daily_current
     WHERE site_id = ? AND channel_view = ? AND segment_key = ? AND date BETWEEN ? AND ?${propFilter} AND (${idParts.join(' OR ')})`,
    [q.siteId, q.channelView, q.segmentKey, q.start, q.end, ...propParam, ...idParams],
  );
  // Pages of this identity with a row, per date (a covered date where fewer pages than the identity has rows is uncertain when rows may be missing).
  const perDate = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!perDate.has(r.date)) perDate.set(r.date, new Set());
    perDate.get(r.date)!.add(r.pkey);
  }
  const lacksRow = (d: string) => have.has(d) && (perDate.get(d)?.size ?? 0) < id.pageCount;
  const truncated = truncatedBatchDates(db, { siteId: q.siteId, source: 'ga4', dataset: 'ga4_landing_daily', property: q.propertyId, start: q.start, end: q.end }, ga4BatchRelevant(q.channelView));
  const truncatedDates = [...truncated].sort().filter(lacksRow);
  // GA4 row loss ("(other)", thresholding, sampling) on covered dates where this identity has no row: unknown, not zero.
  const truncatedSet = new Set(truncatedDates);
  const rowLossDates: string[] = [];
  const rowLossReasons = new Set<Ga4RowLoss>();
  for (const [d, reasons] of [...rowLossBatchDates(db, { siteId: q.siteId, property: q.propertyId, start: q.start, end: q.end }, ga4BatchRelevant(q.channelView))].sort(([a], [b]) => a.localeCompare(b))) {
    if (truncatedSet.has(d) || !lacksRow(d)) continue;
    rowLossDates.push(d);
    for (const r of reasons) rowLossReasons.add(r);
  }
  const uncertainDays = truncatedDates.length + rowLossDates.length;
  // No row at all and dates on which rows may have been left out: nothing is known, not even a zero.
  const unknownTotals = rows.length === 0 && uncertainDays > 0;
  const uncertainReason =
    uncertainDays > 0
      ? `no landing row for ${id.pageCount > 1 ? 'every page' : 'the page'} on ${uncertainDays} collected day(s) where rows may be missing (${[
          ...(truncatedDates.length ? [`${truncatedDates.length} row-limit-truncated`] : []),
          ...(rowLossDates.length ? [`${rowLossDates.length} where GA4 reported ${describeRowLoss([...rowLossReasons])}`] : []),
        ].join('; ')}): unknown, not zero`
      : null;
  // Sampled or "(other)"-bucketed reports, whether or not the page has a row: its values those days are estimates, not exact.
  const estimate = new Map<string, Set<Ga4RowLoss>>();
  const addEstimate = (d: string, reasons: readonly Ga4RowLoss[]) => {
    if (!have.has(d) || !reasons.length) return;
    if (!estimate.has(d)) estimate.set(d, new Set());
    for (const r of reasons) estimate.get(d)!.add(r);
  };
  // (a) every covering report of the date was sampled or bucketed into "(other)";
  for (const [d, reasons] of rowLossBatchDates(db, { siteId: q.siteId, property: q.propertyId, start: q.start, end: q.end }, ga4BatchRelevant(q.channelView), ESTIMATE_LOSS)) addEstimate(d, reasons);
  // (b) a current row of this identity came from such a report (an earlier clean report does not make it exact).
  const rowBatchLoss = estimateLossOfBatches(db, q.siteId, [...new Set(rows.map((r) => r.batch_id).filter((b): b is string => !!b))]);
  for (const r of rows) addEstimate(r.date, (r.batch_id && rowBatchLoss.get(r.batch_id)) || []);
  const estimateDates = [...estimate.keys()].sort();
  const estimateReasons = [...new Set([...estimate.values()].flatMap((s) => [...s]))].sort();
  const estimateReason = estimateDates.length
    ? `${estimateDates.length} collected day(s) where GA4 reported ${describeRowLoss(estimateReasons)}: the landing values of ${id.pageCount > 1 ? 'these pages' : 'the page'} on those days are ${[
        ...(estimateReasons.includes('sampling') ? ['sampled estimates'] : []),
        ...(estimateReasons.includes('other_row') ? ['possibly partial (landing-page variants may be counted in the "(other)" row)'] : []),
      ].join(' or ')}, not exact`
    : null;

  const sessions = unknownTotals ? null : rows.reduce((s, r) => s + r.sessions, 0);
  const engagedKnown = rows.every((r) => r.engaged_sessions !== null);
  const engagedSessions = unknownTotals ? null : engagedKnown ? rows.reduce((s, r) => s + (r.engaged_sessions ?? 0), 0) : null;

  const withSessions = rows.filter((r) => r.sessions > 0);
  const rateObserved = withSessions.filter((r) => r.primary_session_rate_status === 'observed' && r.primary_session_rate !== null);
  const rateUnverified = rateObserved.filter((r) => rateScaleClass(r.primary_session_rate_scale) === 'undetermined');
  let primaryRateStatus: WindowStatus = 'observed';
  let primaryRateReason: string | null = null;
  if (withSessions.length && rateObserved.length === 0) {
    primaryRateStatus = 'unavailable';
    primaryRateReason = 'sessionKeyEventRate:<primary event> was not observed for any row with sessions';
  } else if (rateUnverified.length) {
    // Never multiply an unverified-scale rate by sessions: it may be 100x too high.
    primaryRateStatus = 'unavailable';
    primaryRateReason = rateScaleUnverifiedReason('sessionKeyEventRate:<primary event>', `${rateUnverified.length} of ${withSessions.length} row(s) with sessions`);
  } else if (rateObserved.length < withSessions.length) {
    primaryRateStatus = 'incomplete';
    primaryRateReason = `sessionKeyEventRate:<primary event> observed for ${rateObserved.length} of ${withSessions.length} row(s) with sessions`;
  } else if (uncertainReason || estimateReason) {
    // The sessions and conversions of the missing rows are unknown, or the rows are estimates: the window rate is not an observed rate.
    primaryRateStatus = 'incomplete';
    primaryRateReason = `sessionKeyEventRate:<primary event>: ${[uncertainReason, estimateReason].filter(Boolean).join('; ')}`;
  }
  if (rows.length === 0 && !uncertainReason && !estimateReason) {
    // Covered dates, no row, nothing left out: an observed zero-session window (the rate itself is undefined).
    primaryRateStatus = 'observed';
    primaryRateReason = null;
  }
  const convertingSessions = primaryRateStatus === 'observed' ? rateObserved.reduce((s, r) => s + (rateToFraction(r.primary_session_rate ?? 0, r.primary_session_rate_scale) ?? 0) * r.sessions, 0) : null;

  const keObserved = rows.filter((r) => r.primary_key_events_status === 'observed' && r.primary_key_events !== null);
  // Occurrences: observed sum when every row has them; 0 only for a window with no row and nothing left out.
  const primaryKeyEvents = rows.length ? (keObserved.length === rows.length ? keObserved.reduce((s, r) => s + (r.primary_key_events ?? 0), 0) : null) : unknownTotals ? null : 0;

  const revObserved = rows.filter((r) => r.revenue_status === 'observed' && r.revenue_micros !== null);
  const currencies = new Set(revObserved.map((r) => r.revenue_currency ?? ''));
  let revenueStatus: WindowStatus = 'observed';
  if (rows.length && revObserved.length === 0) revenueStatus = 'unavailable';
  else if (revObserved.length < rows.length || currencies.size > 1 || uncertainReason || estimateReason) revenueStatus = 'incomplete';
  const names = new Set(rows.map((r) => r.primary_event_name).filter((n): n is string => !!n));

  const status: WindowStatus = missingDates.length || incompleteDates.length || uncertainDays || estimateDates.length ? 'incomplete' : 'observed';
  return {
    status,
    reason:
      status === 'incomplete'
        ? `${missingDates.length} missing, ${incompleteDates.length} incomplete, and ${truncatedDates.length} truncated day(s) in the window (landing-page dataset)${
            rowLossDates.length ? `; ${rowLossDates.length} day(s) where GA4 reported ${describeRowLoss([...rowLossReasons])} and ${id.pageCount > 1 ? 'not every page has' : 'the page has no'} row: unknown, not zero` : ''
          }${estimateReason ? `; ${estimateReason}` : ''}${unknownTotals ? '; the page has no row in the window, so sessions, key events, and revenue are unknown (not zero)' : ''}`
        : null,
    sessions,
    engagedSessions,
    engagedSessionRate: engagedSessions !== null && sessions !== null && sessions > 0 ? engagedSessions / sessions : null,
    convertingSessions,
    primarySessionRate: convertingSessions !== null && sessions !== null && sessions > 0 ? convertingSessions / sessions : null,
    primaryRateStatus,
    primaryRateReason,
    primaryEventName: names.size === 1 ? [...names][0]! : names.size > 1 ? `(multiple: ${[...names].join(', ')})` : null,
    primaryKeyEvents,
    revenueMicros: revenueStatus === 'observed' ? revObserved.reduce((s, r) => s + (r.revenue_micros ?? 0), 0) : null,
    revenueCurrency: currencies.size === 1 ? [...currencies][0] || null : null,
    revenueStatus,
    daysExpected: expected.length,
    daysWithData: dates.length,
    missingDates,
    incompleteDates,
    truncatedDates,
    rowLossDates,
    rowLossReasons: [...rowLossReasons],
    estimateDates,
    estimateReasons,
    rows: rows.length,
    anySynthetic: rows.some((r) => r.is_synthetic === 1) || dates.some((d) => d.syn === 1),
  };
}

// ------------------------------------------------------------ availability

export function gscTimeZone(db: Db, siteId: string, property: string | null): string | null {
  const q = property ? ' AND property = ?' : '';
  const p = property ? [siteId, property] : [siteId];
  return (
    db.get<{ tz: string }>(`SELECT date_tz AS tz FROM gsc_page_daily_current WHERE site_id = ?${q} ORDER BY date DESC LIMIT 1`, p)?.tz ??
    db.get<{ tz: string }>(`SELECT date_tz AS tz FROM gsc_property_daily_current WHERE site_id = ?${q} ORDER BY date DESC LIMIT 1`, p)?.tz ??
    null
  );
}

export function ga4TimeZone(db: Db, siteId: string, propertyId: string | null): string | null {
  const meta = propertyId
    ? db.get<{ tz: string | null }>('SELECT time_zone AS tz FROM ga4_property_metadata WHERE site_id = ? AND property_id = ?', [siteId, propertyId])
    : db.get<{ tz: string | null }>('SELECT time_zone AS tz FROM ga4_property_metadata WHERE site_id = ? ORDER BY fetched_at DESC LIMIT 1', [siteId]);
  if (meta?.tz) return meta.tz;
  const q = propertyId ? ' AND property_id = ?' : '';
  return db.get<{ tz: string }>(`SELECT date_tz AS tz FROM ga4_landing_daily_current WHERE site_id = ?${q} ORDER BY date DESC LIMIT 1`, propertyId ? [siteId, propertyId] : [siteId])?.tz ?? null;
}

/**
 * Latest date whose PAGE-LEVEL GSC data is final (same property, search type,
 * segment). Property totals never extend it. API-reported availability can
 * only lower it (a page row flagged final after the reported final date is
 * not trusted).
 */
export function latestCompleteGscDate(db: Db, siteId: string, property: string | null, searchType: string, segmentKey = ''): IsoDate | null {
  const q = property ? ' AND property = ?' : '';
  const pageFinal =
    db.get<{ d: string | null }>(
      `SELECT MAX(date) AS d FROM gsc_page_daily_current WHERE site_id = ? AND search_type = ? AND segment_key = ? AND is_final = 1${q}`,
      property ? [siteId, searchType, segmentKey, property] : [siteId, searchType, segmentKey],
    )?.d ?? null;
  if (!pageFinal) return null;
  const avail =
    db.get<{ d: string | null }>(
      `SELECT latest_final_date AS d FROM gsc_data_availability WHERE site_id = ? AND search_type = ?${q} ORDER BY checked_at DESC LIMIT 1`,
      property ? [siteId, searchType, property] : [siteId, searchType],
    )?.d ?? null;
  return avail && avail < pageFinal ? avail : pageFinal;
}

/** Latest date with complete landing-page GA4 data (same property, channel view, segment). */
export function latestCompleteGa4Date(db: Db, siteId: string, propertyId: string | null, channelView: string, segmentKey = ''): IsoDate | null {
  const q = propertyId ? ' AND property_id = ?' : '';
  return (
    db.get<{ d: string | null }>(
      `SELECT MAX(date) AS d FROM ga4_landing_daily_current WHERE site_id = ? AND channel_view = ? AND segment_key = ? AND is_complete = 1${q}`,
      propertyId ? [siteId, channelView, segmentKey, propertyId] : [siteId, channelView, segmentKey],
    )?.d ?? null
  );
}
