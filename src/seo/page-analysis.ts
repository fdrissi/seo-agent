import type { Clock } from '../core/clock.js';
import { unavailable, valueOf, type Measured } from '../core/measured.js';
import { dateInZone, type IsoDate } from '../core/time.js';
import { effectiveFeatures } from '../config/profiles.js';
import type { SiteConfig } from '../config/site-schema.js';
import { parseJson, type Db } from '../database/db.js';
import { classifyQueries, IntentClassifierRules, type ClassifyOutcome, type IntentClassifierHook } from '../router/intent.js';
import { evaluateRoute, thresholdsFromConfig, deriveSignals, resolveRuleOrder, ruleOrderFromConfig, type RuleId } from '../router/rules.js';
import { persistQueryIntents, persistRouteDecision, routeSite } from '../router/router.js';
import type { ExperimentSignal, InspectionSignal, PageRouteInput, QuerySignal, RouteDecision, RouterThresholds, TechnicalSignal } from '../router/types.js';
import { ConversionBenchmark, CtrBenchmarks } from './benchmarks.js';
import { batchTruncatedDates, describeRowLoss, ga4Coverage, gscCoverage, type CoverageSummary } from './coverage.js';
import { assembleJoinedRow, ga4NotSetShare, pageHasUrlVariants, queryImpactHypotheses, type JoinedPageRow, type QueryImpactHypothesis } from './join.js';
import {
  ga4PageMetrics,
  ga4PageUsers,
  gscAllPageQueryUnits,
  gscAllPageUnits,
  gscPageMetrics,
  gscPropertyMetrics,
  gscQueryMetrics,
  type Ga4Aggregate,
  type Ga4Scope,
  type GscScope,
  type QueryAggregate,
  type SearchAggregate,
} from './metrics.js';
import { defaultAnalysisPeriod, resolveGa4Property, resolveGscProperty, windowEnding, type AnalysisPeriod } from './period.js';
import { UrlReconciler, type PageRow } from './reconcile.js';
import { defaultScoringParams, opportunityKindFor, persistOpportunity, scoreOpportunity, type ScoreResult, type ScoringInput, type ScoringParams } from './scoring.js';
import { normalizeUrl } from './url.js';

/**
 * Builds router inputs from the database (metrics, joins, benchmarks,
 * technical issues, inspections, experiments, query intent), evaluates the
 * route, and scores the opportunity. Nothing here calls the network; the only
 * optional external call is the injected intent hook (cheap model tier) for
 * genuinely ambiguous queries.
 */

export const ANALYSIS_VERSION = 'page-analysis@1.2.0';
export const LOW_DATA_WINDOW_DAYS = 28;
const MAX_QUERIES_PER_PAGE = 50;

export interface AnalysisDeps {
  db: Db;
  siteId: string;
  config: SiteConfig;
  clock: Clock;
  intentHook?: IntentClassifierHook;
  thresholdOverrides?: Partial<RouterThresholds>;
  /** Rule order override (validated and completed like `router.ruleOrder`; prerequisites forced first). Default: from config. */
  ruleOrder?: readonly string[];
  scoringOverrides?: Partial<ScoringParams>;
  /** The context operates on synthetic demo data (AppContext.synthetic). Synthetic rows are detected either way. */
  synthetic?: boolean;
}

export type SourceStatus = 'complete' | 'incomplete' | 'missing' | 'unresolved' | 'not_configured';

export interface SiteAnalysis {
  siteId: string;
  today: IsoDate;
  searchType: string;
  period: AnalysisPeriod;
  gsc: { property: string | null; scope: GscScope | null; status: Exclude<SourceStatus, 'not_configured'>; detail: string; coverage: CoverageSummary | null };
  ga4: { propertyId: string | null; scope: Ga4Scope | null; status: SourceStatus; detail: string; coverage: CoverageSummary | null; timeZone: string | null };
  conversionDefinition: 'configured' | 'missing';
  primaryEvents: string[];
  siteTotals: SearchAggregate | null;
  totalImpressions: Measured<number>;
  lowData: boolean | null;
  lowDataWindow: { start: IsoDate; end: IsoDate };
  notSetShare: Measured<number>;
  thresholds: RouterThresholds;
  /** Rule evaluation order (router.ruleOrder, validated; prerequisites first). Absent = default order. */
  ruleOrder?: readonly RuleId[];
  scoring: ScoringParams;
  refImpressions: number;
  refConversions: number;
  siteDecision: RouteDecision | null;
  warnings: string[];
  /** Synthetic (fixture/demo) data is in scope: nothing derived from it is an observation. */
  synthetic: boolean;
  /** GA4 google_organic landing rows in the period that are not joined to any page (for per-page join issues). */
  unjoinedGa4: Array<{ hostName: string; landingPage: string; sessions: number }>;
  /** internal */
  ctrQueryBench: CtrBenchmarks;
  ctrPageBench: CtrBenchmarks;
  convBench: ConversionBenchmark | null;
}

/**
 * Site-level collection status. Missing or non-final dates make the window
 * incomplete (repairable: re-sync or wait). Row-limit truncation is NOT a
 * site-level failure (nobody can repair a documented API row ceiling): it is
 * a coverage warning, and each page whose totals it may affect (no row on a
 * truncated date) carries an incomplete aggregate of its own.
 */
export function coverageStatus(
  c: CoverageSummary,
  label: string,
  opts: {
    /**
     * Truncated dates whose only covering batches are owner imports without --complete (`data import`,
     * truncated = 1): described as such, never as an API row limit.
     */
    importTruncated?: ReadonlySet<string>;
  } = {},
): { status: 'complete' | 'incomplete' | 'missing'; detail: string; warning: string | null } {
  const total = Object.keys(c.byDate).length;
  if (c.missing.length === total) return { status: 'missing', detail: `${label}: no data collected for ${c.start}..${c.end}`, warning: null };
  const parts: string[] = [];
  if (c.missing.length) parts.push(`${c.missing.length} date(s) not collected (e.g. ${c.missing[0]})`);
  if (c.incomplete.length) parts.push(`${c.incomplete.length} date(s) not final (e.g. ${c.incomplete[0]})`);
  const byImport = opts.importTruncated ? c.truncated.filter((d) => opts.importTruncated!.has(d)) : [];
  const byLimit = c.truncated.filter((d) => !byImport.includes(d));
  const truncText =
    [
      byLimit.length
        ? `${byLimit.length} date(s) hit a documented row limit (e.g. ${byLimit[0]}): lower-traffic rows may be omitted on those dates; pages without a row on them are flagged incomplete individually`
        : null,
      byImport.length
        ? `${byImport.length} date(s) come from an owner import without --complete (e.g. ${byImport[0]}): rows absent from the file are unknown, not zero; pages without a row on them are flagged incomplete individually`
        : null,
    ]
      .filter(Boolean)
      .join('; ') || null;
  // GA4 "(other)" bucketing / thresholding / sampling: like a row limit, not a site-level failure; pages without a row are incomplete individually.
  const lossDates = (c.rowLoss ?? []).filter((d) => c.byDate[d]?.state === 'final' && !c.byDate[d]?.truncated);
  const lossReasons = [...new Set(lossDates.flatMap((d) => c.byDate[d]?.rowLoss ?? []))];
  const lossText = lossDates.length
    ? `${lossDates.length} date(s) (e.g. ${lossDates[0]}) where GA4 reported ${describeRowLoss(lossReasons)}: landing pages without a row on them are flagged incomplete individually, never counted as zero sessions`
    : null;
  const trunc = [truncText, lossText].filter(Boolean).join('; ') || null;
  const warning = trunc ? `${label}: ${trunc}` : null;
  if (parts.length) return { status: 'incomplete', detail: `${label}: ${parts.join('; ')}${trunc ? `; ${trunc}` : ''}`, warning };
  return { status: 'complete', detail: `${label}: ${total} final date(s) collected${trunc ? `; ${trunc}` : ''}`, warning };
}

/**
 * Truncated dates of a Search Console coverage whose truncation comes only
 * from owner imports without --complete (source 'import', truncated = 1): no
 * Search Console sync batch of this property and search type is truncated on
 * them. Those dates did not hit an API row limit; rows absent from the file
 * are unknown, not zero.
 */
export function importOnlyTruncatedDates(db: Db, siteId: string, dataset: 'gsc_page_daily' | 'gsc_property_daily' | 'gsc_page_query_daily', property: string, searchType: string, coverage: Pick<CoverageSummary, 'start' | 'end' | 'truncated'>): Set<string> {
  const out = new Set<string>();
  if (!coverage.truncated.length) return out;
  const batches = db.all<{ source: string; date_start: string; date_end: string; status: string; truncated: number; request_json: string; coverage_json: string | null }>(
    `SELECT source, date_start, date_end, status, truncated, request_json, coverage_json FROM ingestion_batches
      WHERE site_id = ? AND source IN ('gsc', 'import') AND dataset = ? AND property = ? AND status IN ('succeeded', 'partial')
        AND date_start <= ? AND date_end >= ?`,
    [siteId, dataset, property, coverage.end, coverage.start],
  );
  const typeOf = (json: string): string | null => {
    const j = parseJson<Record<string, unknown>>(json, {});
    const t = j.type ?? j.searchType ?? j.search_type;
    return typeof t === 'string' ? t.toLowerCase() : null;
  };
  const inScope = batches.filter((b) => {
    const t = typeOf(b.request_json);
    return t === null || t === searchType.toLowerCase();
  });
  const imports = inScope.filter((b) => b.source === 'import' && (b.truncated === 1 || b.status === 'partial'));
  if (!imports.length) return out;
  const syncs = inScope.filter((b) => b.source !== 'import').map((b) => ({ b, dates: batchTruncatedDates(b) }));
  for (const d of coverage.truncated) {
    if (!imports.some((b) => b.date_start <= d && d <= b.date_end)) continue;
    const syncTruncated = syncs.some(({ b, dates }) => b.date_start <= d && d <= b.date_end && (dates === 'all' || (dates !== 'none' && dates.has(d))));
    if (!syncTruncated) out.add(d);
  }
  return out;
}

/**
 * Measurement status for display (analyze headline): a source whose dates are
 * all collected and final but some of them truncated (a documented row limit,
 * or an owner import without --complete) is 'partial', never 'complete';
 * routing keeps treating truncation per page (coverageStatus).
 */
export function measurementDisplayStatus(status: string, coverage: Pick<CoverageSummary, 'truncated'> | null | undefined): string {
  return status === 'complete' && (coverage?.truncated.length ?? 0) > 0 ? 'partial' : status;
}

/** Any synthetic (fixture/demo) row among the metric rows in scope for the window. */
function syntheticInScope(db: Db, siteId: string, gsc: { property: string; start: string; end: string } | null, ga4: { propertyId: string; start: string; end: string } | null): boolean {
  const q = (sql: string, params: unknown[]) => (db.get<{ s: number | null }>(sql, params)?.s ?? 0) === 1;
  if (gsc && (q('SELECT MAX(is_synthetic) AS s FROM gsc_page_daily WHERE site_id = ? AND is_current = 1 AND property = ? AND date BETWEEN ? AND ?', [siteId, gsc.property, gsc.start, gsc.end]) || q('SELECT MAX(is_synthetic) AS s FROM gsc_property_daily WHERE site_id = ? AND is_current = 1 AND property = ? AND date BETWEEN ? AND ?', [siteId, gsc.property, gsc.start, gsc.end]))) return true;
  if (ga4 && q('SELECT MAX(is_synthetic) AS s FROM ga4_landing_daily WHERE site_id = ? AND is_current = 1 AND property_id = ? AND date BETWEEN ? AND ?', [siteId, ga4.propertyId, ga4.start, ga4.end])) return true;
  return false;
}

export function prepareSiteAnalysis(deps: AnalysisDeps, opts: { days?: number; end?: IsoDate | null; searchType?: string } = {}): SiteAnalysis {
  const { db, siteId, config: cfg } = deps;
  const features = effectiveFeatures(cfg);
  const tz = cfg.reporting.businessTimezone ?? cfg.scheduler.timezone;
  const today = dateInZone(deps.clock.now(), tz);
  const searchType = opts.searchType ?? cfg.google.gsc.searchTypes[0] ?? 'web';
  const warnings: string[] = [];
  const gscProp = features.gsc ? resolveGscProperty(db, siteId, cfg.google.searchConsoleProperty) : { property: null, reason: 'Search Console integration is disabled (features.gsc)' };
  const ga4Prop = features.ga4 ? resolveGa4Property(db, siteId, cfg.google.ga4PropertyId) : { propertyId: null, reason: 'GA4 integration is disabled (features.ga4)' };
  const period = defaultAnalysisPeriod(db, siteId, { gscProperty: gscProp.property, searchType, ga4PropertyId: ga4Prop.propertyId, days: opts.days ?? 28, end: opts.end ?? null, today });
  const primaryEvents = cfg.conversions.primaryEvents.map((e) => e.name);
  const { start, end } = period.period;

  const gscScope: GscScope | null = gscProp.property ? { property: gscProp.property, searchType, segmentKey: '', start, end, incompletePolicy: 'exclude' } : null;
  const ga4Scope: Ga4Scope | null = ga4Prop.propertyId ? { propertyId: ga4Prop.propertyId, channelView: 'google_organic', segmentKey: '', start, end, configuredPrimaryEvents: primaryEvents } : null;

  let gsc: SiteAnalysis['gsc'];
  if (!gscScope) gsc = { property: null, scope: null, status: 'unresolved', detail: 'reason' in gscProp ? gscProp.reason : 'unresolved', coverage: null };
  else {
    const coverage = gscCoverage(db, siteId, { dataset: 'gsc_page_daily', property: gscScope.property, searchType, start, end, segmentKey: '' });
    const s = coverageStatus(coverage, `Search Console ${gscScope.property} (${searchType})`, { importTruncated: importOnlyTruncatedDates(db, siteId, 'gsc_page_daily', gscScope.property, searchType, coverage) });
    gsc = { property: gscScope.property, scope: gscScope, status: s.status, detail: s.detail, coverage };
    if (s.warning) warnings.push(s.warning);
  }
  let ga4: SiteAnalysis['ga4'];
  if (!ga4Scope) {
    const reason = 'reason' in ga4Prop ? ga4Prop.reason : 'unresolved';
    const status: SourceStatus = !features.ga4 || /no GA4 property configured and no GA4 data/.test(reason) ? 'not_configured' : 'unresolved';
    ga4 = { propertyId: null, scope: null, status, detail: reason, coverage: null, timeZone: null };
  } else {
    const coverage = ga4Coverage(db, siteId, { propertyId: ga4Scope.propertyId, start, end, channelView: ga4Scope.channelView, segmentKey: '' });
    const s = coverageStatus(coverage, `GA4 ${ga4Scope.propertyId} google_organic`);
    const tzRow = db.get<{ time_zone: string | null }>('SELECT time_zone FROM ga4_property_metadata WHERE site_id = ? AND property_id = ?', [siteId, ga4Scope.propertyId]);
    ga4 = { propertyId: ga4Scope.propertyId, scope: ga4Scope, status: s.status, detail: s.detail, coverage, timeZone: tzRow?.time_zone ?? null };
    if (s.warning) warnings.push(s.warning);
    warnings.push(...coverage.warnings);
  }

  const thresholds = thresholdsFromConfig(cfg, deps.thresholdOverrides);
  const ruleOrder = deps.ruleOrder ? resolveRuleOrder(deps.ruleOrder) : ruleOrderFromConfig(cfg);
  const lowWin = windowEnding(end, LOW_DATA_WINDOW_DAYS);
  let siteTotals: SearchAggregate | null = null;
  let totalImpressions: Measured<number> = unavailable('Search Console property not resolved');
  let lowData: boolean | null = null;
  if (gscScope) {
    siteTotals = gscPropertyMetrics(db, siteId, { ...gscScope, start: lowWin.start, end: lowWin.end });
    totalImpressions = siteTotals.impressions;
    const t = valueOf(siteTotals.impressions);
    if (t !== undefined) lowData = t < thresholds.lowDataSiteMaxImpressions;
    else {
      // Property totals unavailable: page rows are only a LOWER bound (never presented as totals).
      const lower = gscAllPageUnits(db, siteId, { ...gscScope, start: lowWin.start, end: lowWin.end }).reduce((a, u) => a + u.impressions, 0);
      if (lower >= thresholds.lowDataSiteMaxImpressions) lowData = false;
      warnings.push(`property totals unavailable (${siteTotals.impressions.status}); low-data check used page rows only as a lower bound (${lower} impressions)`);
    }
  }
  const notSetShare = ga4Scope ? ga4NotSetShare(db, siteId, ga4Scope) : unavailable('GA4 not configured');

  const brandRules = new IntentClassifierRules({ brandAliases: cfg.brand.aliases, languages: cfg.market.languages });
  const queryUnits = gscScope ? gscAllPageQueryUnits(db, siteId, gscScope) : [];
  const pageUnits = gscScope ? gscAllPageUnits(db, siteId, gscScope) : [];
  const brandedCache = new Map<string, boolean>();
  const isBranded = (q: string) => {
    let b = brandedCache.get(q);
    if (b === undefined) {
      b = brandRules.classify(q).branded;
      brandedCache.set(q, b);
    }
    return b;
  };
  const ctrQueryBench = new CtrBenchmarks(
    queryUnits.map((u) => ({ pageId: u.pageId, clicks: u.clicks, impressions: u.impressions, position: u.position, branded: isBranded(u.query) })),
    thresholds.minImpressionsForOpportunity,
  );
  const ctrPageBench = new CtrBenchmarks(
    pageUnits.map((u) => ({ pageId: u.pageId, clicks: u.clicks, impressions: u.impressions, position: u.position, branded: false })),
    thresholds.minImpressionsForOpportunity,
  );
  const convBench = ga4Scope ? new ConversionBenchmark(db, siteId, ga4Scope) : null;
  const conversionDefinition = primaryEvents.length ? 'configured' : 'missing';
  const synthetic = deps.synthetic === true || syntheticInScope(db, siteId, gscScope ? { property: gscScope.property, start: lowWin.start < start ? lowWin.start : start, end } : null, ga4Scope ? { propertyId: ga4Scope.propertyId, start, end } : null);
  if (synthetic) warnings.push('SYNTHETIC data in scope (fixture/demo rows): figures are not real measurements and are never labeled OBSERVED');
  const unjoinedGa4 = ga4Scope
    ? db
        .all<{ host_name: string; landing_page: string; sessions: number }>(
          `SELECT host_name, landing_page, SUM(sessions) AS sessions FROM ga4_landing_daily
            WHERE site_id = ? AND is_current = 1 AND property_id = ? AND channel_view = ? AND segment_key = '' AND page_id IS NULL AND date BETWEEN ? AND ?
              AND landing_page != '(not set)' GROUP BY host_name, landing_page HAVING SUM(sessions) > 0`,
          [siteId, ga4Scope.propertyId, ga4Scope.channelView, start, end],
        )
        .map((r) => ({ hostName: r.host_name, landingPage: r.landing_page, sessions: r.sessions }))
    : [];

  const siteDecision = routeSite(
    {
      siteId,
      period: period.period,
      gsc: gsc.status,
      gscDetail: gsc.detail,
      ga4: ga4.status,
      ga4Detail: ga4.detail,
      conversionDefinition,
      totalImpressions: lowData === null && totalImpressions.status !== 'observed' ? unavailable('site totals unavailable') : totalImpressions,
      windowDays: LOW_DATA_WINDOW_DAYS,
      notSetShare,
    },
    thresholds,
    ruleOrder,
  );

  return {
    siteId,
    today,
    searchType,
    period,
    gsc,
    ga4,
    conversionDefinition,
    primaryEvents,
    siteTotals,
    totalImpressions,
    lowData,
    lowDataWindow: lowWin,
    notSetShare,
    thresholds,
    ruleOrder,
    scoring: {
      ...defaultScoringParams({
        minImpressions: thresholds.minImpressionsForOpportunity,
        minSessions: thresholds.minSessionsForConversion,
        rankingPositionMin: thresholds.rankingPositionMin,
        rankingPositionMax: thresholds.rankingPositionMax,
        commercialPageTypes: thresholds.commercialPageTypes,
      }),
      ...deps.scoringOverrides,
    },
    refImpressions: pageUnits.reduce((a, u) => Math.max(a, u.impressions), 0),
    refConversions: convBench?.maxPageConverting() ?? 0,
    siteDecision,
    warnings,
    synthetic,
    unjoinedGa4,
    ctrQueryBench,
    ctrPageBench,
    convBench,
  };
}

/**
 * Issue types written by the crawler's technical checks (src/crawler/checks.ts)
 * that are access/indexability failures of the URL they are recorded on, when
 * the crawler marked them confirmed (it confirms only observed 404/410,
 * redirect loops/limits, robots/noindex/login barriers):
 *   broken_internal_link     this URL returned 404/410 while linked internally
 *   sitemap_url_not_ok       this URL is in the sitemap and returned 404/410
 *   redirect_loop / redirect_chain_too_long
 *   access_blocked           login/access barrier (high only when protected or in the sitemap)
 *   robots_blocked_in_sitemap / robots_blocked_protected
 *   accidental_noindex       noindex observed on a linked/sitemap/protected page
 *   canonical_target_not_ok  this page's canonical target returned 404/410
 */
export const ACCESS_BLOCKER_ISSUE_TYPES: ReadonlySet<string> = new Set([
  'broken_internal_link',
  'sitemap_url_not_ok',
  'redirect_loop',
  'redirect_chain_too_long',
  'access_blocked',
  'robots_blocked_in_sitemap',
  'robots_blocked_protected',
  'accidental_noindex',
  'canonical_target_not_ok',
]);
/** Generic names from other issue sources (imports, older tools). */
const GENERIC_BLOCKER_PATTERN = /noindex|robots|not_found|(^|_)(404|410)($|_)|soft_404|access_denied|forbidden|redirect_loop|redirect_error|dns_error/i;

/**
 * A technical issue is a routing blocker only when confirmed, not heuristic,
 * and either critical or an access/indexability failure of at least medium
 * severity. Confirmed low/info observations (e.g. an intentional member-area
 * login wall that is neither protected nor in the sitemap) stay notes.
 */
export function isBlockingIssue(issue: { issue_type: string; severity: string; confirmed: number; is_heuristic: number }): boolean {
  if (issue.confirmed !== 1 || issue.is_heuristic !== 0) return false;
  if (issue.severity === 'critical') return true;
  if (issue.severity === 'low' || issue.severity === 'info') return false;
  return ACCESS_BLOCKER_ISSUE_TYPES.has(issue.issue_type) || GENERIC_BLOCKER_PATTERN.test(issue.issue_type);
}

const FETCH_FAILURES = new Set(['SOFT_404', 'BLOCKED_ROBOTS_TXT', 'NOT_FOUND', 'ACCESS_DENIED', 'SERVER_ERROR', 'REDIRECT_ERROR', 'ACCESS_FORBIDDEN', 'BLOCKED_4XX', 'INTERNAL_CRAWL_ERROR', 'INVALID_URL']);

export interface TechnicalIssueRow {
  id: string;
  url: string;
  issue_type: string;
  severity: string;
  confirmed: number;
  is_heuristic: number;
  detail_json: string | null;
  last_seen_at: string;
}

interface CrawlStatusRow {
  id: string;
  status_code: number | null;
  requested_url: string;
  final_url: string | null;
  redirect_chain_json: string | null;
  extraction_json: string | null;
  fetched_at: string;
  is_synthetic: number;
}

function chainLength(json: string | null): number {
  const v = parseJson<unknown>(json, null);
  return Array.isArray(v) ? v.length : 0;
}

/** Own-site crawl rows requested for exactly this URL (any outcome, including redirects), newest first. */
function ownCrawlObservations(db: Db, siteId: string, page: { id: string; url: string }): CrawlStatusRow[] {
  return db
    .all<CrawlStatusRow>(
      `SELECT cr.id, cr.status_code, cr.requested_url, cr.final_url, cr.redirect_chain_json, cr.extraction_json, cr.fetched_at, c.is_synthetic
         FROM crawl_results cr JOIN crawls c ON c.id = cr.crawl_id
        WHERE cr.site_id = ? AND c.kind IN ('own_site', 'single_page') AND (cr.page_id = ? OR cr.final_url = ? OR cr.requested_url = ?)
        ORDER BY cr.fetched_at DESC, cr.id DESC LIMIT 50`,
      [siteId, page.id, page.url, page.url],
    )
    .filter((r) => (normalizeUrl(r.requested_url)?.url ?? r.requested_url) === page.url);
}

function isDirect(r: CrawlStatusRow, pageUrl: string): boolean {
  if (chainLength(r.redirect_chain_json) > 0) return false;
  return !r.final_url || (normalizeUrl(r.final_url)?.url ?? r.final_url) === pageUrl;
}

/**
 * The page's own direct crawl observations, newest first: rows for exactly
 * this URL that did not redirect. A redirecting row (first status 3xx) whose
 * final URL is this page is not an observation of this page's response.
 */
export function directCrawlObservations(db: Db, siteId: string, page: { id: string; url: string }, limit = 5): CrawlStatusRow[] {
  return ownCrawlObservations(db, siteId, page)
    .filter((r) => isDirect(r, page.url))
    .slice(0, limit);
}

/** Final status of a redirect observation: recorded with the redirect (crawler), else the final URL's own latest row. */
function redirectFinalStatus(db: Db, siteId: string, r: CrawlStatusRow): number | null {
  const x = parseJson<Record<string, unknown>>(r.extraction_json, {});
  if (typeof x.finalStatus === 'number') return x.finalStatus;
  if (!r.final_url) return null;
  const fin = normalizeUrl(r.final_url)?.url ?? r.final_url;
  const row = db.get<{ status_code: number | null }>(
    `SELECT cr.status_code FROM crawl_results cr JOIN crawls c ON c.id = cr.crawl_id
      WHERE cr.site_id = ? AND c.kind IN ('own_site', 'single_page') AND cr.requested_url IN (?, ?) AND (cr.redirect_chain_json IS NULL OR cr.redirect_chain_json = '[]')
      ORDER BY cr.fetched_at DESC, cr.id DESC LIMIT 1`,
    [siteId, fin, r.final_url],
  );
  return row?.status_code ?? null;
}

export function readTechnicalSignals(
  db: Db,
  siteId: string,
  page: { id: string; url: string },
): { confirmed: TechnicalSignal[]; suspected: TechnicalSignal[]; inspection: InspectionSignal | null; issues: TechnicalIssueRow[]; latestCrawlStatus: number | null; synthetic: boolean } {
  const issues = db.all<TechnicalIssueRow>(
    "SELECT id, url, issue_type, severity, confirmed, is_heuristic, detail_json, last_seen_at FROM technical_issues WHERE site_id = ? AND status = 'open' AND (page_id = ? OR url = ?) ORDER BY severity, issue_type",
    [siteId, page.id, page.url],
  );
  const confirmed: TechnicalSignal[] = [];
  const suspected: TechnicalSignal[] = [];
  for (const i of issues) {
    const detail = (() => {
      const d = parseJson<Record<string, unknown>>(i.detail_json, {});
      const msg = d.message ?? d.detail ?? d.summary ?? d.note;
      const status = typeof d.status === 'number' ? `HTTP ${d.status}; ` : typeof d.targetStatus === 'number' ? `target HTTP ${d.targetStatus}; ` : '';
      return `${status}${typeof msg === 'string' ? msg : `last seen ${i.last_seen_at}`}`;
    })();
    const sig: TechnicalSignal = { source: 'technical_issue', type: i.issue_type, severity: i.severity, confirmed: i.confirmed === 1, detail };
    if (isBlockingIssue(i)) confirmed.push(sig);
    else suspected.push(sig);
  }
  const insp = db.get<{ verdict: string | null; coverage_state: string | null; indexing_state: string | null; robots_txt_state: string | null; page_fetch_state: string | null; inspected_at: string; is_synthetic: number }>(
    'SELECT verdict, coverage_state, indexing_state, robots_txt_state, page_fetch_state, inspected_at, is_synthetic FROM url_inspections WHERE site_id = ? AND (page_id = ? OR url = ?) ORDER BY inspected_at DESC LIMIT 1',
    [siteId, page.id, page.url],
  );
  let inspection: InspectionSignal | null = null;
  if (insp) {
    inspection = { verdict: insp.verdict, coverageState: insp.coverage_state, indexingState: insp.indexing_state, robotsTxtState: insp.robots_txt_state, pageFetchState: insp.page_fetch_state, inspectedAt: insp.inspected_at };
    const note = `URL Inspection (Google's indexed version, not a live test) at ${insp.inspected_at}`;
    if (insp.indexing_state && insp.indexing_state.startsWith('BLOCKED_')) confirmed.push({ source: 'url_inspection', type: 'indexing_blocked', severity: 'critical', confirmed: true, detail: `${insp.indexing_state}; ${note}` });
    if (insp.robots_txt_state === 'DISALLOWED') confirmed.push({ source: 'url_inspection', type: 'robots_disallowed', severity: 'critical', confirmed: true, detail: `robots.txt DISALLOWED; ${note}` });
    if (insp.page_fetch_state && FETCH_FAILURES.has(insp.page_fetch_state)) confirmed.push({ source: 'url_inspection', type: 'fetch_failed', severity: 'critical', confirmed: true, detail: `${insp.page_fetch_state}; ${note}` });
  }
  // The page's own latest HTTP response in own-site crawls.
  const own = ownCrawlObservations(db, siteId, page);
  const direct = own.filter((r) => isDirect(r, page.url)).slice(0, 5);
  const newest = own.find((r) => r.status_code !== null);
  let latest = direct.find((r) => r.status_code !== null);
  let latestCrawlStatus = latest?.status_code ?? null;
  if (newest && !isDirect(newest, page.url)) {
    // The latest observation of this URL is a redirect: judge where it leads.
    latest = undefined;
    latestCrawlStatus = newest.status_code;
    const fin = redirectFinalStatus(db, siteId, newest);
    if (fin === 404 || fin === 410) {
      confirmed.push({ source: 'crawl', type: `redirect_to_http_${fin}`, severity: 'critical', confirmed: true, detail: `this URL redirects (HTTP ${newest.status_code}) to ${newest.final_url}, which returned HTTP ${fin} (own-site crawl at ${newest.fetched_at})` });
    } else if (fin !== null && fin >= 500) {
      suspected.push({ source: 'crawl', type: `redirect_to_http_${fin}`, severity: 'medium', confirmed: false, detail: `this URL redirects to ${newest.final_url}, which returned HTTP ${fin}; may be transient, re-crawl to confirm` });
    }
  }
  if (latest && (latestCrawlStatus === 404 || latestCrawlStatus === 410)) {
    confirmed.push({ source: 'crawl', type: `http_${latestCrawlStatus}`, severity: 'critical', confirmed: true, detail: `own-site crawl at ${latest.fetched_at} returned HTTP ${latestCrawlStatus} for this URL` });
  } else if (latest && latestCrawlStatus !== null && latestCrawlStatus >= 500) {
    const withStatus = direct.filter((r) => r.status_code !== null);
    const previous = withStatus[1];
    if (previous && previous.status_code !== null && previous.status_code >= 500) {
      confirmed.push({ source: 'crawl', type: 'http_5xx_repeated', severity: 'high', confirmed: true, detail: `HTTP ${latestCrawlStatus} at ${latest.fetched_at} and HTTP ${previous.status_code} at ${previous.fetched_at} (two consecutive own-site crawls)` });
    } else {
      suspected.push({ source: 'crawl', type: `http_${latestCrawlStatus}`, severity: 'medium', confirmed: false, detail: `own-site crawl at ${latest.fetched_at} returned HTTP ${latestCrawlStatus}; may be transient, re-crawl to confirm` });
    }
  }
  const synthetic = insp?.is_synthetic === 1 || own.some((r) => r.is_synthetic === 1);
  return { confirmed, suspected, inspection, issues, latestCrawlStatus, synthetic };
}

/**
 * Active experiments that constrain this page: experiments on the page itself
 * (scope 'page' -> EXPERIMENT_ACTIVE), site-wide/template experiments with no
 * page (scope 'site'), and experiments that use this page as a comparison
 * (control) page (scope 'comparison'). The latter two are notes and
 * recommendation exclusions, not a route of their own.
 */
export function readExperimentSignals(db: Db, siteId: string, pageId: string): ExperimentSignal[] {
  const rows = db.all<{ id: string; page_id: string | null; status: string; type: string; observation_end: string | null; review_date: string | null; comparison_pages_json: string | null }>(
    `SELECT id, page_id, status, type, observation_end, review_date, comparison_pages_json FROM experiments
      WHERE site_id = ? AND status IN ('observing', 'approved', 'awaiting_implementation') AND (page_id = ? OR page_id IS NULL OR comparison_pages_json IS NOT NULL)
      ORDER BY created_at`,
    [siteId, pageId],
  );
  const out: ExperimentSignal[] = [];
  for (const e of rows) {
    const base = { id: e.id, status: e.status, type: e.type, observationEnd: e.observation_end, reviewDate: e.review_date };
    if (e.page_id === pageId) out.push({ ...base, scope: 'page' });
    else if (e.page_id === null) out.push({ ...base, scope: 'site' });
    else if (comparisonPageIds(e.comparison_pages_json).includes(pageId)) out.push({ ...base, scope: 'comparison' });
  }
  return out;
}

/** Page ids of an experiment's comparison (control) pages. */
export function comparisonPageIds(json: string | null): string[] {
  const v = parseJson<unknown>(json, []);
  if (!Array.isArray(v)) return [];
  return v.map((c) => (c && typeof c === 'object' ? (c as { pageId?: unknown }).pageId : c)).filter((x): x is string => typeof x === 'string');
}

/**
 * Measurement joins that affect this page (INVALID_OR_INCOMPLETE_DATA when present):
 *  - GA4 google_organic sessions for this page's host+path that are not joined
 *    to any page (both http and https identities exist without merge
 *    evidence, or the row has no hostName);
 *  - probable (possible but unproven) redirect/canonical equivalence between
 *    this page and a variant that carries its own traffic in the period, so
 *    the page's totals may be split across two identities. `unverified`
 *    evidence (redirect to an error page or off-site, conflicting canonicals)
 *    contradicts equivalence and is not a split.
 */
export function readJoinIssues(db: Db, siteId: string, site: Pick<SiteAnalysis, 'unjoinedGa4' | 'period' | 'gsc' | 'ga4'>, page: { id: string; url: string }): string[] {
  const issues: string[] = [];
  const own = normalizeUrl(page.url);
  if (!own) return issues;
  for (const g of site.unjoinedGa4) {
    if (g.hostName) {
      if (g.hostName.toLowerCase() !== own.host) continue;
      const variants = (['https', 'http'] as const).map((sch) => normalizeUrl(`${sch}://${g.hostName}${g.landingPage}`)?.url);
      if (!variants.includes(page.url)) continue;
      issues.push(`${g.sessions} google_organic session(s) for ${g.hostName}${g.landingPage} are not joined to any page (GA4 reports no scheme and no merge evidence decides between http/https identities); this page's sessions may be undercounted`);
    } else {
      const n = normalizeUrl(g.landingPage, `${own.url.split('//')[0]}//${own.host}`);
      if (n?.url !== page.url) continue;
      issues.push(`${g.sessions} google_organic session(s) for landing path ${g.landingPage} have no hostName and are not joined to any page; re-sync GA4 with the hostName dimension`);
    }
  }
  const { start, end } = site.period.period;
  const traffic = (variantId: string): { impressions: number; sessions: number } => {
    const impressions = site.gsc.scope
      ? (db.get<{ n: number | null }>("SELECT SUM(impressions) AS n FROM gsc_page_daily WHERE site_id = ? AND is_current = 1 AND page_id = ? AND property = ? AND search_type = ? AND segment_key = '' AND date BETWEEN ? AND ?", [siteId, variantId, site.gsc.scope.property, site.gsc.scope.searchType, start, end])?.n ?? 0)
      : 0;
    const sessions = site.ga4.scope
      ? (db.get<{ n: number | null }>("SELECT SUM(sessions) AS n FROM ga4_landing_daily WHERE site_id = ? AND is_current = 1 AND page_id = ? AND property_id = ? AND channel_view = ? AND segment_key = '' AND date BETWEEN ? AND ?", [siteId, variantId, site.ga4.scope.propertyId, site.ga4.scope.channelView, start, end])?.n ?? 0)
      : 0;
    return { impressions, sessions };
  };
  const seen = new Set<string>();
  // Variants pointing at this page with weaker-than-established evidence.
  const inbound = db.all<{ alias_url: string; relation: string; confidence: string }>(
    "SELECT alias_url, relation, confidence FROM url_aliases WHERE site_id = ? AND page_id = ? AND relation IN ('redirect', 'canonical') AND confidence = 'probable'",
    [siteId, page.id],
  );
  for (const a of inbound) {
    const n = normalizeUrl(a.alias_url);
    if (!n || n.url === page.url || seen.has(n.url)) continue;
    seen.add(n.url);
    const variant = db.get<{ id: string }>('SELECT id FROM pages WHERE site_id = ? AND url = ?', [siteId, n.url]);
    if (!variant || variant.id === page.id) continue;
    const t = traffic(variant.id);
    if (t.impressions > 0 || t.sessions > 0) {
      issues.push(`${a.relation} evidence from ${n.url} is ${a.confidence} (not merged); that variant has ${t.impressions} impression(s) and ${t.sessions} session(s) recorded separately, so this page's totals may be split`);
    }
  }
  // This page points at another identity with weaker-than-established evidence.
  const outbound = db.get<{ page_id: string; relation: string; confidence: string }>(
    "SELECT page_id, relation, confidence FROM url_aliases WHERE site_id = ? AND alias_url = ? AND relation IN ('redirect', 'canonical') AND confidence = 'probable'",
    [siteId, page.url],
  );
  if (outbound && outbound.page_id !== page.id) {
    const target = db.get<{ url: string }>('SELECT url FROM pages WHERE site_id = ? AND id = ?', [siteId, outbound.page_id]);
    const t = traffic(outbound.page_id);
    if (target && (t.impressions > 0 || t.sessions > 0)) {
      issues.push(`${outbound.relation} evidence to ${target.url} is ${outbound.confidence} (not merged); both identities carry traffic, so totals may be split between them`);
    }
  }
  return issues;
}

export interface PageInputBundle {
  input: PageRouteInput;
  gsc: SearchAggregate | null;
  gscPrevious: SearchAggregate | null;
  ga4: Ga4Aggregate | null;
  ga4Previous: Ga4Aggregate | null;
  users: Measured<number>;
  queries: QueryAggregate[];
  intents: ClassifyOutcome;
  join: JoinedPageRow | null;
  technicalIssues: TechnicalIssueRow[];
  /** Any input is synthetic (fixture/demo rows or a synthetic context). */
  synthetic: boolean;
}

export async function buildPageRouteInput(deps: AnalysisDeps, site: SiteAnalysis, page: PageRow): Promise<PageInputBundle> {
  const { db, siteId, config: cfg } = deps;
  const prev = site.period.previous;
  const gsc = site.gsc.scope ? gscPageMetrics(db, siteId, page.id, site.gsc.scope) : null;
  const gscPrevious = site.gsc.scope ? gscPageMetrics(db, siteId, page.id, { ...site.gsc.scope, start: prev.start, end: prev.end }) : null;
  const ga4 = site.ga4.scope ? ga4PageMetrics(db, siteId, page.id, site.ga4.scope) : null;
  const ga4Previous = site.ga4.scope ? ga4PageMetrics(db, siteId, page.id, { ...site.ga4.scope, start: prev.start, end: prev.end }) : null;
  const users = site.ga4.scope ? ga4PageUsers(db, siteId, page.id, { propertyId: site.ga4.scope.propertyId, channelView: 'google_organic', start: site.period.period.start, end: site.period.period.end }) : unavailable('GA4 not configured');

  const queries = site.gsc.scope
    ? gscQueryMetrics(db, siteId, page.id, site.gsc.scope)
        .sort((a, b) => (valueOf(b.agg.impressions) ?? 0) - (valueOf(a.agg.impressions) ?? 0))
        .slice(0, MAX_QUERIES_PER_PAGE)
    : [];
  const intents = await classifyQueries(
    queries.map((q) => q.query),
    { brandAliases: cfg.brand.aliases, languages: cfg.market.languages, ...(deps.intentHook ? { hook: deps.intentHook } : {}) },
  );
  const querySignals: QuerySignal[] = queries.map((q, i) => {
    const intent = intents.results[i]!;
    return {
      query: q.query,
      clicks: q.agg.clicks,
      impressions: q.agg.impressions,
      ctr: q.agg.ctr,
      position: q.agg.position,
      expectedCtr: site.ctrQueryBench.expected(valueOf(q.agg.position), intent.branded, page.id),
      intent,
    };
  });

  const tech = readTechnicalSignals(db, siteId, page);
  const experiments = readExperimentSignals(db, siteId, page.id);
  const joinIssues = readJoinIssues(db, siteId, site, page);
  const synthetic =
    site.synthetic ||
    tech.synthetic ||
    [gsc, gscPrevious].some((a) => a?.synthetic === true) ||
    [ga4, ga4Previous].some((a) => a?.synthetic === true) ||
    queries.some((q) => q.agg.synthetic);

  // A rate that GA4 did not report (or that is not listed for the event) is a measurement gap.
  // A reported rate whose 0-1 vs 0-100 scale is not established yet is not: conversions are
  // simply not assessed, and every search-based route still runs (RATE_SCALE_UNVERIFIED note).
  let primaryRateGap: string | null = null;
  let rateScaleUnverified: string | null = null;
  if (ga4 && site.conversionDefinition === 'configured') {
    const s = valueOf(ga4.sessions);
    const r = ga4.primaryConversionRate;
    if (r.status === 'unavailable' && ga4.primaryRateScaleUnverified) rateScaleUnverified = r.reason;
    else if (s !== undefined && s > 0 && r.status === 'unavailable') primaryRateGap = r.reason;
  }
  const gscState: PageRouteInput['measurement']['gsc'] = site.gsc.status === 'complete' && gsc?.completeness === 'incompatible' ? 'incomplete' : site.gsc.status;
  const join = gsc
    ? assembleJoinedRow(page, site.period.period, gsc, ga4, { hasUrlVariants: pageHasUrlVariants(db, siteId, page.id), notSetSessionShare: site.notSetShare }, site.searchType)
    : null;

  const input: PageRouteInput = {
    siteId,
    pageId: page.id,
    url: page.url,
    pageType: page.page_type,
    isExcluded: page.is_excluded === 1,
    isProtected: page.is_protected === 1,
    period: site.period.period,
    previous: prev,
    measurement: {
      gsc: gscState,
      gscDetail: gsc?.completeness === 'incompatible' ? `${site.gsc.detail}; page rows incompatible: ${gsc.clicks.status !== 'observed' ? gsc.clicks.reason : ''}` : site.gsc.detail,
      ga4: site.ga4.status,
      ga4Detail: site.ga4.detail,
      conversionDefinition: site.conversionDefinition,
      primaryRateGap,
      rateScaleUnverified,
      joinIssues,
      notSetShare: site.notSetShare,
    },
    technical: { confirmed: tech.confirmed, suspected: tech.suspected, inspection: tech.inspection, latestCrawlStatus: tech.latestCrawlStatus },
    experiments,
    search: {
      clicks: gsc?.clicks ?? unavailable('Search Console not resolved'),
      impressions: gsc?.impressions ?? unavailable('Search Console not resolved'),
      ctr: gsc?.ctr ?? unavailable('Search Console not resolved'),
      position: gsc?.position ?? unavailable('Search Console not resolved'),
      expectedCtr: gsc ? site.ctrPageBench.expected(valueOf(gsc.position), false, page.id) : unavailable('Search Console not resolved'),
      previousClicks: gscPrevious?.clicks ?? null,
      previousImpressions: gscPrevious?.impressions ?? null,
    },
    queries: querySignals,
    business: {
      sessions: ga4?.sessions ?? unavailable('GA4 not configured'),
      convertingSessions: ga4?.primaryConvertingSessions ?? unavailable('GA4 not configured'),
      conversionRate: ga4?.primaryConversionRate ?? unavailable('GA4 not configured'),
      benchmarkConversionRate: site.convBench?.rate(page.id) ?? unavailable('GA4 not configured'),
      previousConvertingSessions: ga4Previous?.primaryConvertingSessions ?? null,
    },
    site: { lowData: site.lowData, totalImpressions: site.totalImpressions, windowDays: LOW_DATA_WINDOW_DAYS },
    today: site.today,
    synthetic,
  };
  return { input, gsc, gscPrevious, ga4, ga4Previous, users, queries, intents, join, technicalIssues: tech.issues, synthetic };
}

export interface PageAnalysis {
  version: string;
  page: { id: string; url: string; pageType: string | null; isProtected: boolean; isExcluded: boolean; lifecycle: string };
  bundle: PageInputBundle;
  decision: RouteDecision;
  score: ScoreResult | null;
  focusQuery: string | null;
  queryHypotheses: QueryImpactHypothesis[];
}

/** Routes that produce a scored opportunity. */
export const SCORED_ROUTES = new Set(['RANKING_OPPORTUNITY', 'CTR_OPPORTUNITY', 'CONVERSION_OPPORTUNITY', 'DECLINE', 'CONTENT_OPPORTUNITY', 'TECHNICAL_BLOCKER', 'INDEXING_UNKNOWN', 'INVALID_OR_INCOMPLETE_DATA']);

function scoringInputFor(site: SiteAnalysis, a: { input: PageRouteInput; decision: RouteDecision; bundle: PageInputBundle }): { input: ScoringInput; focusQuery: string | null } {
  const { input, decision, bundle } = a;
  const d = deriveSignals(input, site.thresholds);
  const num = (m: Measured<number> | null | undefined) => (m ? (valueOf(m) ?? null) : null);
  let focus: QuerySignal | null = null;
  let impressions = num(input.search.impressions);
  let clicks = num(input.search.clicks);
  let ctr = num(input.search.ctr);
  let expectedCtr = num(input.search.expectedCtr);
  let position = num(input.search.position);
  if (decision.route === 'RANKING_OPPORTUNITY' && d.rankingCandidates.length) {
    const cands = d.rankingCandidates;
    focus = cands.find((q) => q.intent.intent === 'commercial' || q.intent.intent === 'transactional') ?? cands[0]!;
    impressions = cands.reduce((s, q) => s + (num(q.impressions) ?? 0), 0);
    clicks = cands.reduce((s, q) => s + (num(q.clicks) ?? 0), 0);
    position = impressions > 0 ? cands.reduce((s, q) => s + (num(q.position) ?? 0) * (num(q.impressions) ?? 0), 0) / impressions : null;
    ctr = impressions > 0 ? clicks / impressions : null;
  } else if (decision.route === 'CTR_OPPORTUNITY' && d.ctrWeakQueries.length) {
    focus = [...d.ctrWeakQueries].sort((x, y) => ((num(y.expectedCtr) ?? 0) - (num(y.ctr) ?? 0)) * (num(y.impressions) ?? 0) - ((num(x.expectedCtr) ?? 0) - (num(x.ctr) ?? 0)) * (num(x.impressions) ?? 0))[0]!;
    impressions = num(focus.impressions);
    clicks = num(focus.clicks);
    ctr = num(focus.ctr);
    expectedCtr = num(focus.expectedCtr);
    position = num(focus.position);
  } else if (decision.route === 'CONTENT_OPPORTUNITY' && d.uncoveredDemand.length) {
    focus = d.uncoveredDemand[0]!;
    impressions = d.uncoveredDemand.reduce((s, q) => s + (num(q.impressions) ?? 0), 0);
  }
  const top = focus ?? input.queries[0] ?? null;
  const decl = d.clicksChange.status === 'observed' ? valueOf(d.clicksChange.value.pct) ?? null : null;
  return {
    focusQuery: focus?.query ?? null,
    input: {
      route: decision.route,
      pageType: input.pageType,
      isProtected: input.isProtected,
      branded: top ? top.intent.branded : null,
      intent: top ? top.intent.intent : null,
      impressions,
      clicks,
      ctr,
      expectedCtr,
      position,
      sessions: num(input.business.sessions),
      convertingSessions: num(input.business.convertingSessions),
      primaryEventOccurrences: bundle.ga4 ? num(bundle.ga4.primaryEventOccurrences) : null,
      siteConversionRate: num(input.business.benchmarkConversionRate),
      declinePct: decision.route === 'DECLINE' ? decl : null,
      gscComplete: bundle.gsc?.completeness === 'complete',
      ga4Complete: bundle.ga4?.completeness === 'complete',
      activeExperimentOnPage: input.experiments.some((e) => (e.scope ?? 'page') === 'page'),
      activeExperimentOnSite: input.experiments.some((e) => e.scope === 'site' || e.scope === 'comparison'),
      synthetic: bundle.synthetic,
      suspectedIssues: input.technical.suspected.filter((s) => !s.confirmed).length,
      refImpressions: site.refImpressions,
      refConversions: site.refConversions,
    },
  };
}

export async function analyzePage(deps: AnalysisDeps, site: SiteAnalysis, page: PageRow): Promise<PageAnalysis> {
  const bundle = await buildPageRouteInput(deps, site, page);
  const decision = evaluateRoute(bundle.input, site.thresholds, site.ruleOrder ? { order: site.ruleOrder } : {});
  let score: ScoreResult | null = null;
  let focusQuery: string | null = null;
  // A site-wide measurement problem is one site-level decision, not one measurement opportunity per page.
  const siteWideInvalid = decision.route === 'INVALID_OR_INCOMPLETE_DATA' && site.siteDecision?.route === 'INVALID_OR_INCOMPLETE_DATA';
  if (SCORED_ROUTES.has(decision.route) && !siteWideInvalid) {
    const s = scoringInputFor(site, { input: bundle.input, decision, bundle });
    score = scoreOpportunity(s.input, site.scoring);
    focusQuery = s.focusQuery;
  }
  return {
    version: ANALYSIS_VERSION,
    page: { id: page.id, url: page.url, pageType: page.page_type, isProtected: page.is_protected === 1, isExcluded: page.is_excluded === 1, lifecycle: page.lifecycle },
    bundle,
    decision,
    score,
    focusQuery,
    queryHypotheses: bundle.join ? queryImpactHypotheses(bundle.join, bundle.queries) : [],
  };
}

export interface PersistedAnalysis {
  routeDecisionId: string;
  opportunityId: string | null;
  /** Earlier open opportunities of this page and period archived by this run. */
  superseded: number;
}

/**
 * Persist the route decision, query intents, and (for scored/archived routes)
 * the opportunity. Any OTHER open opportunity of this page for the same
 * period (an earlier run's route, focus query, or scoring version) is
 * archived as superseded, so stale candidates are never recommended.
 */
export function persistPageAnalysis(db: Db, a: PageAnalysis, opts: { jobId?: string | null; now: Date }): PersistedAnalysis {
  return db.transaction(() => {
    const routeDecisionId = persistRouteDecision(db, a.decision, opts);
    persistQueryIntents(db, a.decision.siteId, a.bundle.intents.results, opts.now);
    let opportunityId: string | null = null;
    if (a.score || a.decision.route === 'IRRELEVANT') {
      opportunityId = persistOpportunity(
        db,
        {
          siteId: a.decision.siteId,
          routeDecisionId,
          route: a.decision.route,
          kind: opportunityKindFor(a.decision.route, a.focusQuery !== null),
          pageId: a.page.id,
          query: a.focusQuery,
          isBranded: a.score ? (a.score.segment === 'unknown' ? null : a.score.segment === 'branded') : null,
          result: a.score,
          status: a.decision.route === 'IRRELEVANT' ? 'archived' : 'candidate',
          statusReason: a.decision.route === 'IRRELEVANT' ? a.decision.reasons.map((r) => r.detail).join('; ') : null,
          periodStart: a.decision.period?.start ?? null,
          periodEnd: a.decision.period?.end ?? null,
        },
        opts.now,
      );
    }
    const superseded = supersedeOpenOpportunities(db, a.decision.siteId, a.page.id, a.decision.period ?? null, opportunityId, `superseded: page re-routed to ${a.decision.route} (route decision ${routeDecisionId})`, opts.now);
    return { routeDecisionId, opportunityId, superseded };
  });
}

/** Archive open (candidate/shortlisted) opportunities of a page for a period, except `keepId`. */
export function supersedeOpenOpportunities(db: Db, siteId: string, pageId: string, period: { start: string; end: string } | null, keepId: string | null, reason: string, now: Date): number {
  return db.run(
    `UPDATE opportunities SET status = 'archived', status_reason = ?, updated_at = ?
      WHERE site_id = ? AND page_id = ? AND period_start IS ? AND period_end IS ? AND status IN ('candidate', 'shortlisted') AND id IS NOT ?`,
    [reason, now.toISOString(), siteId, pageId, period?.start ?? null, period?.end ?? null, keepId],
  ).changes;
}

export interface MergedPage {
  pageId: string;
  url: string;
  mergedInto: { pageId: string; url: string };
  /** Evidence chain, e.g. ['redirect', 'canonical'] or ['configured']. */
  relations: string[];
}

/**
 * Routable pages: every page that is not redirected (unless its redirect leads
 * to an error: an unmerged URL with its own search data and a technical
 * problem) and whose own URL does not resolve to another page through
 * established merge evidence (a configured
 * alias or wildcard rule, a permanent redirect, an agreeing canonical, or a
 * manual alias). A merged page's metric rows already count toward its target,
 * so routing it separately would report false zeros.
 */
export function partitionRoutablePages(db: Db, siteId: string, config: SiteConfig | null): { routable: PageRow[]; merged: MergedPage[] } {
  const all = db.all<PageRow>('SELECT * FROM pages WHERE site_id = ? ORDER BY url', [siteId]);
  // Redirected pages are routed only when the redirect was not merged because its target
  // returned an error (the URL keeps its own search data and needs a technical fix).
  const brokenRedirect = (p: PageRow): boolean => {
    const a = db.get<{ relation: string; confidence: string; evidence_json: string | null }>('SELECT relation, confidence, evidence_json FROM url_aliases WHERE site_id = ? AND alias_url = ?', [siteId, p.url]);
    if (!a || a.relation !== 'redirect' || a.confidence === 'established') return false;
    const fs = parseJson<{ finalStatus?: unknown }>(a.evidence_json, {}).finalStatus;
    return typeof fs === 'number' && fs >= 400;
  };
  const pages = all.filter((p) => p.lifecycle !== 'redirected' || brokenRedirect(p));
  if (!config) return { routable: pages, merged: [] };
  const rec = new UrlReconciler(db, siteId, config);
  const routable: PageRow[] = [];
  const merged: MergedPage[] = [];
  for (const p of pages) {
    const r = rec.resolve(p.url);
    if (r.status === 'resolved' && r.pageId !== p.id) {
      merged.push({ pageId: p.id, url: p.url, mergedInto: { pageId: r.pageId, url: r.pageUrl }, relations: r.steps.filter((st) => st.relation !== 'normalized' && st.from !== st.to).map((st) => st.relation) });
    } else routable.push(p);
  }
  return { routable, merged };
}

/** Pages to route: every non-redirected, non-merged page of the site (merged pages are skipped when `config` is given). */
export function listRoutablePages(db: Db, siteId: string, config: SiteConfig | null = null): PageRow[] {
  return partitionRoutablePages(db, siteId, config).routable;
}

export interface SiteRouteRun {
  site: SiteAnalysis;
  analyses: PageAnalysis[];
  persisted: Array<PersistedAnalysis & { pageId: string }>;
  siteDecisionId: string | null;
  counts: Record<string, number>;
  /** Pages not routed because established evidence merges them into another page. */
  merged: MergedPage[];
  /** Open opportunities of this period archived because their page is no longer routed (merged/redirected). */
  archivedStale: number;
}

/** Route (and optionally persist) every routable page. */
export async function routeAllPages(deps: AnalysisDeps, site: SiteAnalysis, opts: { persist: boolean; jobId?: string | null; pageIds?: string[] } = { persist: false }): Promise<SiteRouteRun> {
  const part = partitionRoutablePages(deps.db, deps.siteId, deps.config);
  const pages = part.routable.filter((p) => !opts.pageIds || opts.pageIds.includes(p.id));
  const analyses: PageAnalysis[] = [];
  for (const p of pages) analyses.push(await analyzePage(deps, site, p));
  const persisted: SiteRouteRun['persisted'] = [];
  let siteDecisionId: string | null = null;
  let archivedStale = 0;
  if (opts.persist) {
    const now = deps.clock.now();
    if (site.siteDecision) siteDecisionId = persistRouteDecision(deps.db, site.siteDecision, { jobId: opts.jobId ?? null, now });
    for (const a of analyses) persisted.push({ pageId: a.page.id, ...persistPageAnalysis(deps.db, a, { jobId: opts.jobId ?? null, now }) });
    if (!opts.pageIds) {
      // Full run: open candidates of this period whose page was not routed are stale.
      const routed = new Set(analyses.map((a) => a.page.id));
      const mergedInto = new Map(part.merged.map((m) => [m.pageId, m.mergedInto.url]));
      const period = site.period.period;
      const stale = deps.db.all<{ page_id: string }>(
        "SELECT DISTINCT page_id FROM opportunities WHERE site_id = ? AND period_start = ? AND period_end = ? AND status IN ('candidate', 'shortlisted') AND page_id IS NOT NULL",
        [deps.siteId, period.start, period.end],
      );
      for (const o of stale) {
        if (routed.has(o.page_id)) continue;
        const into = mergedInto.get(o.page_id);
        archivedStale += supersedeOpenOpportunities(deps.db, deps.siteId, o.page_id, period, null, into ? `superseded: page is merged into ${into} by established evidence` : 'superseded: page is no longer routed (redirected, merged, or removed)', now);
      }
    }
  }
  const counts: Record<string, number> = {};
  for (const a of analyses) counts[a.decision.route] = (counts[a.decision.route] ?? 0) + 1;
  return { site, analyses, persisted, siteDecisionId, counts, merged: opts.pageIds ? part.merged.filter((m) => opts.pageIds!.includes(m.pageId)) : part.merged, archivedStale };
}
