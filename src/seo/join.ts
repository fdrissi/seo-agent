import { observed, unavailable, valueOf, type Measured } from '../core/measured.js';
import type { Db } from '../database/db.js';
import { ga4PageMetrics, gscPageMetrics, GSC_REPORTING_TIME_ZONE, type Ga4Aggregate, type Ga4Scope, type GscScope, type Period, type QueryAggregate, type SearchAggregate } from './metrics.js';

/**
 * GSC x GA4 join at compatible PAGE/PERIOD grain.
 *
 * Each side is first aggregated to exactly one row per page per period
 * (GSC byPage totals; GA4 google_organic landing sessions, session-scoped
 * acquisition), THEN joined on page_id. Query rows are never joined to GA4
 * rows, so conversions are never multiplied by the number of keywords.
 *
 * Date boundaries stay explicit: Search Console dates are Pacific time, GA4
 * dates are in the property time zone. Aggregated daily data cannot be shifted
 * into one identical window, so both boundaries are reported side by side.
 */

export const JOIN_VERSION = 'join@1.0.0';

export type MismatchReasonCode =
  | 'DATE_TIMEZONE_BOUNDARIES'
  | 'CONSENT_OR_ANALYTICS_BLOCKING'
  | 'REDIRECTS_OR_URL_VARIANTS'
  | 'ATTRIBUTION_DIFFERENCES'
  | 'TRACKING_GAPS'
  | 'CLICK_SESSION_CARDINALITY'
  | 'SEARCH_TYPE_SCOPE'
  | 'DATA_INCOMPLETE';

export interface MismatchReason {
  code: MismatchReasonCode;
  /** `observed_condition`: the condition exists in our data (not that it caused the gap). `possible`: a known general cause, not checked. */
  status: 'observed_condition' | 'possible';
  detail: string;
}

export interface ClicksVsSessions {
  clicks: Measured<number>;
  sessions: Measured<number>;
  /** sessions / clicks */
  ratio: Measured<number>;
  direction: 'sessions_exceed_clicks' | 'clicks_exceed_sessions' | 'similar' | 'not_comparable';
  possibleReasons: MismatchReason[];
  note: string;
}

export interface DateBoundaries {
  gsc: { start: string; end: string; timeZone: string };
  ga4: { start: string; end: string; timeZone: string | null };
  sameCalendarDates: boolean;
  sameTimeZone: boolean | null;
  note: string;
}

export interface JoinedPageRow {
  grain: 'page/period';
  pageId: string;
  url: string;
  period: Period;
  gsc: SearchAggregate;
  ga4: Ga4Aggregate | null;
  dateBoundaries: DateBoundaries;
  clicksVsSessions: ClicksVsSessions;
}

export interface JoinContext {
  /** Whether the page has redirect/canonical/configured aliases or multiple raw variants. */
  hasUrlVariants: boolean;
  /** Share of google_organic sessions whose landing page is "(not set)" site-wide in the period. */
  notSetSessionShare: Measured<number>;
}

const SIMILAR_LOW = 0.8;
const SIMILAR_HIGH = 1.25;

export function explainClicksVsSessions(gsc: SearchAggregate, ga4: Ga4Aggregate | null, boundaries: DateBoundaries, ctx: JoinContext, searchType: string): ClicksVsSessions {
  const clicks = gsc.clicks;
  const sessions: Measured<number> = ga4 ? ga4.sessions : unavailable('GA4 not configured or not joined');
  const reasons: MismatchReason[] = [];
  const c = valueOf(clicks);
  const s = valueOf(sessions);
  let ratio: Measured<number>;
  let direction: ClicksVsSessions['direction'];
  if (c === undefined || s === undefined) {
    ratio = unavailable('clicks or sessions not fully observed for the period');
    direction = 'not_comparable';
  } else if (c === 0) {
    ratio = unavailable('no clicks in the period');
    direction = s > 0 ? 'sessions_exceed_clicks' : 'similar';
  } else {
    const r = Math.round((s / c) * 1000) / 1000;
    ratio = observed(r);
    direction = r < SIMILAR_LOW ? 'clicks_exceed_sessions' : r > SIMILAR_HIGH ? 'sessions_exceed_clicks' : 'similar';
  }
  if (gsc.completeness !== 'complete' || (ga4 && ga4.completeness !== 'complete')) {
    reasons.push({ code: 'DATA_INCOMPLETE', status: 'observed_condition', detail: `completeness: GSC ${gsc.completeness}, GA4 ${ga4?.completeness ?? 'not joined'}` });
  }
  reasons.push({
    code: 'DATE_TIMEZONE_BOUNDARIES',
    status: boundaries.sameTimeZone === false ? 'observed_condition' : 'possible',
    detail: boundaries.note,
  });
  if (direction !== 'similar' || c === undefined || s === undefined) {
    reasons.push({ code: 'CONSENT_OR_ANALYTICS_BLOCKING', status: 'possible', detail: 'Consent choices, blockers, or failed tags can prevent GA4 from recording sessions that Search Console counts as clicks. Not verified from this data.' });
    reasons.push({
      code: 'REDIRECTS_OR_URL_VARIANTS',
      status: ctx.hasUrlVariants ? 'observed_condition' : 'possible',
      detail: ctx.hasUrlVariants
        ? 'This page has recorded URL variants or aliases; clicks and sessions may be attributed to different URL forms.'
        : 'Redirects or URL variants can split clicks and landing pages across URLs.',
    });
    reasons.push({ code: 'ATTRIBUTION_DIFFERENCES', status: 'possible', detail: 'GSC counts clicks on Google results; GA4 counts sessions whose session source/medium is google/organic. Session timeouts, returning visits, and source overwrites differ between the systems.' });
    const ns = valueOf(ctx.notSetSessionShare);
    reasons.push({
      code: 'TRACKING_GAPS',
      status: ns !== undefined && ns > 0 ? 'observed_condition' : 'possible',
      detail: ns !== undefined && ns > 0 ? `${(ns * 100).toFixed(1)}% of google_organic sessions site-wide have landing page "(not set)" in this period.` : 'Sessions without a page_view appear under "(not set)" and cannot be joined to a page.',
    });
    reasons.push({ code: 'CLICK_SESSION_CARDINALITY', status: 'possible', detail: 'One click can produce several sessions (or none if the visitor leaves before the tag fires).' });
    if (searchType.toLowerCase() !== 'web') reasons.push({ code: 'SEARCH_TYPE_SCOPE', status: 'possible', detail: `GSC figures are for search type "${searchType}" only.` });
    else reasons.push({ code: 'SEARCH_TYPE_SCOPE', status: 'possible', detail: 'GSC "web" excludes Discover and Google News, which GA4 may still classify as google/organic.' });
  }
  return {
    clicks,
    sessions,
    ratio,
    direction,
    possibleReasons: reasons,
    note: 'Possible explanations only. The data does not establish which (if any) caused a difference; causes are never asserted.',
  };
}

export function dateBoundaries(period: Period, gsc: SearchAggregate, ga4: Ga4Aggregate | null): DateBoundaries {
  const gTz = gsc.timeZone ?? GSC_REPORTING_TIME_ZONE;
  const aTz = ga4?.timeZone ?? null;
  const same = aTz === null ? null : aTz === gTz;
  return {
    gsc: { start: period.start, end: period.end, timeZone: gTz },
    ga4: { start: period.start, end: period.end, timeZone: aTz },
    sameCalendarDates: true,
    sameTimeZone: same,
    note:
      same === false
        ? `Same calendar dates, different day boundaries: Search Console days are ${gTz}, GA4 days are ${aTz}. Daily aggregates cannot be shifted into an identical window.`
        : same === true
          ? `Both systems report days in ${gTz}.`
          : `Search Console days are ${gTz}; the GA4 property time zone is unknown for this window.`,
  };
}

/** Share of google_organic sessions landing on "(not set)" site-wide in the period. */
export function ga4NotSetShare(db: Db, siteId: string, s: Pick<Ga4Scope, 'propertyId' | 'channelView' | 'start' | 'end'>): Measured<number> {
  const r = db.get<{ total: number | null; notset: number | null }>(
    `SELECT SUM(sessions) AS total, SUM(CASE WHEN landing_page = '(not set)' THEN sessions ELSE 0 END) AS notset
       FROM ga4_landing_daily WHERE site_id = ? AND is_current = 1 AND property_id = ? AND channel_view = ? AND segment_key = '' AND date BETWEEN ? AND ?`,
    [siteId, s.propertyId, s.channelView, s.start, s.end],
  );
  if (!r || r.total === null) return unavailable('no GA4 landing rows in the period');
  if (r.total === 0) return unavailable('no GA4 sessions in the period');
  return observed(Math.round(((r.notset ?? 0) / r.total) * 10000) / 10000);
}

export function pageHasUrlVariants(db: Db, siteId: string, pageId: string): boolean {
  const r = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM url_aliases WHERE site_id = ? AND page_id = ? AND relation IN ('redirect', 'canonical', 'configured', 'manual') AND confidence = 'established'`,
    [siteId, pageId],
  );
  if ((r?.n ?? 0) > 0) return true;
  const g = db.get<{ n: number }>('SELECT COUNT(DISTINCT page) AS n FROM gsc_page_daily WHERE site_id = ? AND page_id = ?', [siteId, pageId]);
  const a = db.get<{ n: number }>('SELECT COUNT(DISTINCT landing_page) AS n FROM ga4_landing_daily WHERE site_id = ? AND page_id = ?', [siteId, pageId]);
  return (g?.n ?? 0) > 1 || (a?.n ?? 0) > 1;
}

/**
 * Join GSC and GA4 for one page and period. Both sides are aggregated to one
 * row first; the result is exactly one row per page per period.
 */
export function joinPagePeriod(db: Db, siteId: string, page: { id: string; url: string }, gscScope: GscScope, ga4Scope: Ga4Scope | null): JoinedPageRow {
  const period: Period = { start: gscScope.start, end: gscScope.end };
  const gsc = gscPageMetrics(db, siteId, page.id, gscScope);
  const ga4 = ga4Scope ? ga4PageMetrics(db, siteId, page.id, { ...ga4Scope, start: period.start, end: period.end }) : null;
  const ctx: JoinContext = {
    hasUrlVariants: pageHasUrlVariants(db, siteId, page.id),
    notSetSessionShare: ga4Scope ? ga4NotSetShare(db, siteId, { ...ga4Scope, start: period.start, end: period.end }) : unavailable('GA4 not configured'),
  };
  return assembleJoinedRow(page, period, gsc, ga4, ctx, gscScope.searchType);
}

/** Build the joined row from already-aggregated page/period sides (one row each). */
export function assembleJoinedRow(page: { id: string; url: string }, period: Period, gsc: SearchAggregate, ga4: Ga4Aggregate | null, ctx: JoinContext, searchType: string): JoinedPageRow {
  const boundaries = dateBoundaries(period, gsc, ga4);
  return {
    grain: 'page/period',
    pageId: page.id,
    url: page.url,
    period,
    gsc,
    ga4,
    dateBoundaries: boundaries,
    clicksVsSessions: explainClicksVsSessions(gsc, ga4, boundaries, ctx, searchType),
  };
}

/** Join every page that has GSC or GA4 rows in the period (one row per page). */
export function joinAllPages(db: Db, siteId: string, gscScope: GscScope, ga4Scope: Ga4Scope | null): JoinedPageRow[] {
  const pages = db.all<{ id: string; url: string }>(
    `SELECT p.id, p.url FROM pages p WHERE p.site_id = ? AND (
        EXISTS (SELECT 1 FROM gsc_page_daily g WHERE g.site_id = p.site_id AND g.page_id = p.id AND g.is_current = 1 AND g.date BETWEEN ? AND ?)
        OR EXISTS (SELECT 1 FROM ga4_landing_daily a WHERE a.site_id = p.site_id AND a.page_id = p.id AND a.is_current = 1 AND a.date BETWEEN ? AND ?))
      ORDER BY p.url`,
    [siteId, gscScope.start, gscScope.end, gscScope.start, gscScope.end],
  );
  return pages.map((p) => joinPagePeriod(db, siteId, p, gscScope, ga4Scope));
}

export interface QueryImpactHypothesis {
  query: string;
  clicks: Measured<number>;
  impressions: Measured<number>;
  /** Share of the page's VISIBLE query clicks (anonymized queries are not included). */
  visibleClickShare: Measured<number>;
  label: 'HYPOTHESIS';
  statement: string;
}

/**
 * Query-level business impact is a HYPOTHESIS based on page-level evidence.
 * No conversion is attributed to a query; only the visible click share is
 * reported next to the page-level outcome.
 */
export function queryImpactHypotheses(row: JoinedPageRow, queries: readonly QueryAggregate[]): QueryImpactHypothesis[] {
  const visibleClicks = queries.reduce((a, q) => a + (valueOf(q.agg.clicks) ?? 0), 0);
  const conv = row.ga4 ? valueOf(row.ga4.primaryConvertingSessions) : undefined;
  return queries.map((q) => {
    const c = valueOf(q.agg.clicks);
    const share: Measured<number> = c === undefined ? unavailable('query clicks not fully observed') : visibleClicks === 0 ? unavailable('no visible query clicks') : observed(Math.round((c / visibleClicks) * 10000) / 10000);
    const shareText = share.status === 'observed' ? `${(share.value * 100).toFixed(1)}% of the page's visible query clicks` : 'an unknown share of visible query clicks';
    return {
      query: q.query,
      clicks: q.agg.clicks,
      impressions: q.agg.impressions,
      visibleClickShare: share,
      label: 'HYPOTHESIS',
      statement:
        conv === undefined
          ? `"${q.query}" accounts for ${shareText}. Page-level conversions are unavailable, so no business impact is attributed to this query.`
          : `"${q.query}" accounts for ${shareText}. The page recorded ~${conv} converting session(s) at page level; which queries led to them is not measured, so any query-level impact is a hypothesis.`,
    };
  });
}
