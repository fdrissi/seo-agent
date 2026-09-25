import type { Measured } from '../core/measured.js';
import type { Period } from '../seo/metrics.js';

/** Routes, in the spec's suggested evaluation order, plus UNSURE for ambiguous cases. */
export const ROUTES = [
  'INVALID_OR_INCOMPLETE_DATA',
  'TECHNICAL_BLOCKER',
  'EXPERIMENT_ACTIVE',
  'HEALTHY',
  'RANKING_OPPORTUNITY',
  'CTR_OPPORTUNITY',
  'CONVERSION_OPPORTUNITY',
  'DECLINE',
  'CONTENT_OPPORTUNITY',
  'INDEXING_UNKNOWN',
  'LOW_DATA',
  'IRRELEVANT',
  'UNSURE',
] as const;
export type Route = (typeof ROUTES)[number];

/** What each route means for the owner (never an instruction to edit by itself). */
export const ROUTE_NEXT_STEP: Record<Route, string> = {
  INVALID_OR_INCOMPLETE_DATA: 'Repair measurement or wait for complete data before optimizing.',
  TECHNICAL_BLOCKER: 'Investigate the confirmed access/indexability failure first.',
  EXPERIMENT_ACTIVE: 'Monitor the running experiment; do not stack unrelated changes on this page.',
  HEALTHY: 'Leave this page unchanged.',
  RANKING_OPPORTUNITY: 'Targeted SEO audit of the shortlisted queries (a shortlist heuristic, not an instruction to edit).',
  CTR_OPPORTUNITY: 'Investigate title, snippet, and SERP presentation for the weak-CTR queries.',
  CONVERSION_OPPORTUNITY: 'Review tracking, intent match, and the conversion path.',
  DECLINE: 'Investigate technical changes, demand, competitors, and other changes behind the decline.',
  CONTENT_OPPORTUNITY: 'Check overlap with existing pages, research, then brief if justified.',
  INDEXING_UNKNOWN: 'Inspect indexing status. Never delete or redirect automatically.',
  LOW_DATA: 'Collect more evidence (bootstrap workflow for a new or small site).',
  IRRELEVANT: 'Archive with the recorded reason.',
  UNSURE: 'Ambiguous or mixed case: needs classification or human review before routing.',
};

export type ReasonCodeId =
  // Measurement prerequisites
  | 'GSC_PROPERTY_UNRESOLVED'
  | 'GSC_DATA_MISSING'
  | 'GSC_DATA_INCOMPLETE'
  | 'GA4_PROPERTY_UNRESOLVED'
  | 'GA4_DATA_MISSING'
  | 'GA4_DATA_INCOMPLETE'
  | 'MISSING_CONVERSION_DEFINITION'
  | 'PRIMARY_RATE_UNAVAILABLE'
  /**
   * Note (never a routing reason by itself): GA4 reported the primary-event
   * session rate, but its 0-1 vs 0-100 scale is not established, so
   * conversions are not assessed; search-based routes still run.
   */
  | 'RATE_SCALE_UNVERIFIED'
  /** Note: page search metrics are not observed (incomplete/missing), so "leave unchanged" (HEALTHY) is not concluded. */
  | 'SEARCH_METRICS_NOT_OBSERVED'
  | 'JOIN_UNRESOLVED'
  | 'GA4_NOT_SET_SHARE_HIGH'
  // Technical
  | 'CONFIRMED_TECHNICAL_ISSUE'
  | 'INSPECTION_INDEXING_BLOCKED'
  | 'INSPECTION_ROBOTS_DISALLOWED'
  | 'INSPECTION_FETCH_FAILED'
  | 'CRAWL_HTTP_ERROR'
  | 'SUSPECTED_TECHNICAL_ISSUE'
  // Experiments
  | 'EXPERIMENT_OBSERVING'
  | 'EXPERIMENT_PENDING_IMPLEMENTATION'
  | 'EXPERIMENT_REVIEW_DUE'
  | 'EXPERIMENT_SITE_WIDE'
  | 'EXPERIMENT_CONTROL_PAGE'
  // Healthy
  | 'SUFFICIENT_EXPOSURE'
  | 'STABLE'
  | 'CTR_NOT_WEAK'
  | 'CONVERSIONS_NOT_POOR'
  /** HEALTHY although conversion performance was not assessed (insufficient sessions, unmeasured, or no benchmark). */
  | 'CONVERSIONS_NOT_ASSESSED'
  | 'NO_RANKING_CANDIDATE_WITH_BUSINESS_EVIDENCE'
  // Opportunities
  | 'QUERY_POSITION_IN_RANGE'
  | 'BUSINESS_EVIDENCE_CONVERSIONS'
  | 'BUSINESS_EVIDENCE_COMMERCIAL_INTENT'
  | 'BUSINESS_EVIDENCE_PAGE_TYPE'
  | 'CTR_BELOW_COMPARABLE'
  | 'CTR_BENCHMARK_UNAVAILABLE'
  | 'CONVERSION_RATE_BELOW_BENCHMARK'
  | 'CONVERSION_BENCHMARK_UNAVAILABLE'
  | 'CLICKS_DECLINED'
  | 'CONVERSIONS_DECLINED'
  | 'PREVIOUS_PERIOD_NOT_COMPARABLE'
  | 'UNCOVERED_DEMAND_QUERIES'
  | 'RECURRING_CUSTOMER_QUESTION'
  // Indexing / low data / scope
  | 'NO_IMPRESSIONS_NOT_INSPECTED'
  | 'INSPECTION_NOT_INDEXED'
  | 'NEVER_AUTO_DELETE_OR_REDIRECT'
  | 'SITE_LOW_DATA'
  | 'PAGE_BELOW_EVIDENCE_THRESHOLD'
  | 'EXCLUDED_PATH'
  | 'OUT_OF_SCOPE'
  // Ambiguity
  | 'AMBIGUOUS_INTENT'
  | 'MIXED_INTENT'
  | 'INTENT_DECIDED_BY_MODEL'
  | 'NO_RULE_MATCHED';

export interface ReasonCode {
  code: ReasonCodeId;
  detail: string;
  /** Structured detail. `data.inputs` (ReasonInputs) holds the measured inputs the reason rests on. */
  data?: Record<string, unknown>;
}

/** Dataset a reason's measured inputs were read from. */
export type ReasonInputSource = 'gsc' | 'ga4' | 'crawl' | 'url_inspection';

/** One Search Console page/query row a reason rests on. Values are observed ones; null = not observed (never 0). */
export interface ReasonQueryRow {
  query: string;
  position: number | null;
  impressions: number | null;
  clicks: number | null;
  ctr?: number | null;
  /** Comparable CTR on this site (CTR reasons). */
  expectedCtr?: number | null;
}

/**
 * The measured inputs a routing reason rests on, recorded in
 * `ReasonCode.data.inputs` (and so in route_decisions.reason_codes_json):
 * the dataset and current-revision view (or table) the values were read from,
 * the window, and the observed values the rule compared (per-query rows with
 * position and impressions, page totals, rates, crawl or URL Inspection
 * observations). Reasons that rest only on configuration, records
 * (experiments), intent classification, a policy, or the absence of a match
 * carry none. A recommendation's route claim is backed by an evidence item
 * built from these inputs (src/seo/recommend.ts); without any, it is context
 * only (never "supports" without an evidence item).
 */
export interface ReasonInputs {
  source: ReasonInputSource;
  /** Current-revision view or table the values come from (the evidence locator). */
  table: string;
  /** Window the values cover (the routing period), when known. */
  period: { start: string; end: string } | null;
  values?: Record<string, number | string | boolean | null>;
  rows?: ReasonQueryRow[];
}

const INPUT_SOURCES: readonly string[] = ['gsc', 'ga4', 'crawl', 'url_inspection'];

/**
 * The measured inputs recorded on a reason, or null. Validated, because
 * reasons are also read back from stored JSON (route_decisions, stage
 * checkpoints) written by older versions without inputs.
 */
export function reasonInputs(r: Pick<ReasonCode, 'data'>): ReasonInputs | null {
  const x = r.data?.inputs as Partial<ReasonInputs> | undefined;
  if (!x || typeof x !== 'object' || typeof x.source !== 'string' || !INPUT_SOURCES.includes(x.source) || typeof x.table !== 'string' || !x.table) return null;
  const values = x.values && typeof x.values === 'object' && !Array.isArray(x.values) ? x.values : undefined;
  const rows = Array.isArray(x.rows) ? x.rows.filter((q): q is ReasonQueryRow => !!q && typeof q === 'object' && typeof (q as ReasonQueryRow).query === 'string') : undefined;
  if (!(values && Object.keys(values).length) && !(rows && rows.length)) return null;
  const p = x.period;
  const period = p && typeof p === 'object' && typeof p.start === 'string' && typeof p.end === 'string' ? { start: p.start, end: p.end } : null;
  return { source: x.source as ReasonInputSource, table: x.table, period, ...(values && Object.keys(values).length ? { values } : {}), ...(rows && rows.length ? { rows } : {}) };
}

export type QueryIntent = 'informational' | 'commercial' | 'transactional' | 'navigational' | 'mixed' | 'unsure';

export interface IntentResult {
  query: string;
  normalized: string;
  intent: QueryIntent;
  branded: boolean;
  matchedBrandAlias: string | null;
  signals: string[];
  decidedBy: 'rule' | 'model';
  /** mixed/unsure after rules (and after the optional model hook). */
  ambiguous: boolean;
  rationale?: string;
}

export interface QuerySignal {
  query: string;
  clicks: Measured<number>;
  impressions: Measured<number>;
  ctr: Measured<number>;
  position: Measured<number>;
  /** Comparable CTR from this site's own data at a similar position (branded/non-branded separately). */
  expectedCtr: Measured<number>;
  intent: IntentResult;
}

export interface TechnicalSignal {
  source: 'technical_issue' | 'url_inspection' | 'crawl';
  type: string;
  severity: string;
  confirmed: boolean;
  detail: string;
}

export interface InspectionSignal {
  verdict: string | null;
  coverageState: string | null;
  indexingState: string | null;
  robotsTxtState: string | null;
  pageFetchState: string | null;
  inspectedAt: string;
}

export interface ExperimentSignal {
  id: string;
  status: string;
  type: string;
  observationEnd: string | null;
  reviewDate: string | null;
  /**
   * 'page' (default): the experiment changes this page -> EXPERIMENT_ACTIVE.
   * 'site': a site-wide/template experiment (page_id NULL) -> note; page changes are not recommended on top of it.
   * 'comparison': this page is a comparison (control) page of the experiment -> note; changing it would bias the evaluation.
   */
  scope?: 'page' | 'site' | 'comparison';
}

export type ConversionStatus = 'unmeasured' | 'insufficient' | 'no_benchmark' | 'poor' | 'satisfactory';

export interface PageRouteInput {
  siteId: string;
  pageId: string;
  url: string;
  pageType: string | null;
  isExcluded: boolean;
  isProtected: boolean;
  period: Period;
  previous: Period | null;
  measurement: {
    gsc: 'complete' | 'incomplete' | 'missing' | 'unresolved';
    gscDetail: string;
    ga4: 'complete' | 'incomplete' | 'missing' | 'unresolved' | 'not_configured';
    ga4Detail: string;
    conversionDefinition: 'configured' | 'missing';
    /** Sessions exist but the primary-event session rate was not observed for them (a measurement gap: INVALID_OR_INCOMPLETE_DATA). */
    primaryRateGap: string | null;
    /**
     * The rate WAS reported, but its 0-1 vs 0-100 scale is not established yet
     * (stored scale 'undetermined'). Not a measurement gap: conversions are
     * not assessed (RATE_SCALE_UNVERIFIED note) and search-based routes run.
     * Resolved by `sync ga4 --confirm-rate-scale fraction|percent --evidence ... --as "<your name>"`
     * (CONFIRM_RATE_SCALE_COMMAND in src/integrations/google/rate-scale-command.ts).
     */
    rateScaleUnverified?: string | null;
    joinIssues: string[];
    notSetShare: Measured<number>;
  };
  technical: { confirmed: TechnicalSignal[]; suspected: TechnicalSignal[]; inspection: InspectionSignal | null; latestCrawlStatus: number | null };
  experiments: ExperimentSignal[];
  search: {
    clicks: Measured<number>;
    impressions: Measured<number>;
    ctr: Measured<number>;
    position: Measured<number>;
    /** Page-level comparable CTR (used only when no query rows exist). */
    expectedCtr: Measured<number>;
    previousClicks: Measured<number> | null;
    previousImpressions: Measured<number> | null;
  };
  queries: QuerySignal[];
  business: {
    sessions: Measured<number>;
    convertingSessions: Measured<number>;
    conversionRate: Measured<number>;
    benchmarkConversionRate: Measured<number>;
    previousConvertingSessions: Measured<number> | null;
  };
  site: { lowData: boolean | null; totalImpressions: Measured<number>; windowDays: number };
  /** Evaluation date (ISO, business time zone) for experiment review checks. */
  today: string;
  /** Inputs include synthetic (fixture/demo) rows: the decision is about synthetic data, never an observation. */
  synthetic?: boolean;
}

export interface RouterThresholds {
  rankingPositionMin: number;
  rankingPositionMax: number;
  minImpressionsForOpportunity: number;
  lowDataSiteMaxImpressions: number;
  declineThresholdPct: number;
  healthyCtrRatio: number;
  minSessionsForConversion: number;
  /** Poor conversion: Wilson 95% upper bound of the page rate < benchmark x this ratio. */
  conversionPoorRatio: number;
  /** Share of "(not set)" google_organic sessions that marks a site-level tracking gap. */
  notSetShareMax: number;
  requireConversionDefinition: boolean;
  commercialPageTypes: string[];
  maxQueriesInReasons: number;
  /** Clicks at or above which 0 matched google_organic sessions is treated as a join gap (default 20). */
  minClicksForJoinCheck?: number;
  /** Previous-period converting sessions required before a conversion decline counts (default 5). */
  minPreviousConversionsForDecline?: number;
}

export interface RuleTrace {
  rule: string;
  matched: boolean;
  route?: Route;
  reasons: ReasonCode[];
}

export interface RouteDecision {
  subjectType: 'site' | 'page' | 'page_query' | 'content_signal';
  siteId: string;
  pageId: string | null;
  query: string | null;
  route: Route;
  reasons: ReasonCode[];
  /** Observations that did not decide the route but must stay visible (e.g. suspected issues). */
  notes: ReasonCode[];
  trace: RuleTrace[];
  decidedBy: 'rule' | 'model' | 'owner';
  rulesVersion: string;
  period: Period | null;
  nextStep: string;
  inputsSummary: Record<string, unknown>;
}
