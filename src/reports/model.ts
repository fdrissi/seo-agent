import { CLAIM_LABELS, type ClaimLabel } from '../core/modes.js';
import type { Measured } from '../core/measured.js';
import type { SpendReport } from '../budgets/types.js';
import type { IntegrationState } from '../integrations/types.js';
import type { LinkTarget } from './links.js';

/**
 * Typed report model shared by the baseline, weekly, and monthly reports and
 * the dashboard.
 *
 * Every statement in a report is a `Claim` with one of the reporting-contract
 * labels (OBSERVED, INFERRED, HYPOTHESIS, RECOMMENDATION, DATA_UNAVAILABLE),
 * the source IDs it was derived from, retrieval dates, the metric definitions
 * it uses, and evidence links. A source URL alone is never treated as
 * supporting evidence: an evidence link must say whether it actually supports
 * the claim (`supportsClaim`), and `validateReport` rejects OBSERVED/INFERRED
 * claims that have no supporting evidence unless the claim is explicitly
 * surfaced as unverified (`evidenceStatus: 'missing' | 'context_only'`).
 *
 * Numbers are computed in code (src/reports/metrics.ts); an optional LLM
 * executive summary is labeled as model-generated and never authoritative.
 */

export const REPORT_SCHEMA_VERSION = 1;
export const REPORT_GENERATOR_VERSION = 'reports@1.0.0';
export const SYNTHETIC_WATERMARK = 'SYNTHETIC DEMO DATA - not real measurements';

export const REPORT_KINDS = ['baseline', 'weekly', 'monthly'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export function isReportKind(v: string): v is ReportKind {
  return (REPORT_KINDS as readonly string[]).includes(v);
}

export type EvidenceLinkKind =
  | 'db_query' // a reproducible query over a current-revision view (table + filters)
  | 'db_record' // a specific row (table:id)
  | 'raw_ref' // a raw API response stored in the private workspace (data/raw)
  | 'evidence' // an evidence row (evidence:id) with a summary/excerpt
  | 'url' // an external URL (never sufficient on its own)
  | 'vault_note'
  | 'report'
  | 'doc' // repository documentation (e.g. docs/integration-contracts.md)
  | 'config' // a site-configuration field
  | 'integration_status'; // an integration status supplied to the report builder

export interface EvidenceLink {
  kind: EvidenceLinkKind;
  label: string;
  /** Locator: URL, `table:id`, `view?filters`, raw ref, or vault path. */
  ref: string;
  /** True only when following this link lets a reader check the claim. */
  supportsClaim: boolean;
  note?: string;
}

export type EvidenceStatus = 'supported' | 'context_only' | 'missing' | 'not_applicable';

export interface Claim {
  /** Stable key within the report, e.g. `gsc.clicks.current`. */
  id: string;
  label: ClaimLabel;
  text: string;
  /** Source record IDs (`ingestion_batches:<id>`, `recommendations:<id>`, ...). */
  sourceIds: string[];
  /** Retrieval/collection timestamps (ISO) of the underlying sources. */
  retrievedAt: string[];
  /** IDs into `Report.metricDefinitions`. */
  metricIds: string[];
  evidence: EvidenceLink[];
  /** Why data is unavailable, or the rationale for a recommendation/hypothesis. */
  reason?: string;
  evidenceStatus: EvidenceStatus;
  /** True when any underlying row is synthetic. */
  synthetic?: boolean;
  /** Records this claim is about (rendered via the link resolver). */
  links?: LinkTarget[];
}

export interface MetricDefinition {
  id: string;
  name: string;
  definition: string;
  formula?: string;
  source: 'gsc' | 'ga4' | 'budgets' | 'experiments' | 'crawl' | 'content' | 'ai_citations' | 'derived';
  /** Whether values can be summed: across dates only, across everything, or never. */
  additivity: 'additive' | 'across_dates_only' | 'non_additive';
  unit: 'count' | 'ratio' | 'position' | 'usd_micros' | 'currency_micros' | 'days' | 'level';
}

export interface ReportTable {
  id: string;
  title: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
  note?: string;
  /** Total rows before top-N truncation (reports never include full raw datasets). */
  totalRows?: number;
}

export const SECTION_KEYS = [
  'executive_summary',
  'dates',
  'freshness',
  'evidence_confidence',
  'google_organic',
  'all_organic',
  'gsc_performance',
  'data_quality',
  'experiments',
  'primary_action',
  'content',
  'spend',
  // monthly
  'organic_conversion_review',
  'experiments_review',
  'content_cohorts',
  'competitor_changes',
  'ai_visibility',
  'api_usage',
  'learnings',
  'attribution_assumptions',
  // baseline
  'collection',
  'crawl_summary',
  'url_reconciliation',
  'measurement_check',
  'memory_index',
  'blockers',
  'cost_plan',
  // site structure (weekly: internal links; monthly: AEO)
  'internal_links',
  'aeo',
  // always last
  'next_action',
  'metric_definitions',
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export interface ReportSection {
  key: SectionKey;
  title: string;
  claims: Claim[];
  tables: ReportTable[];
  notes: string[];
}

export interface ReportPeriod {
  start: string;
  end: string;
  days: number;
  /** Business time zone used for period boundaries (IANA). */
  timeZone: string;
  /**
   * Where `timeZone` came from: 'business' = reporting.businessTimezone;
   * 'scheduler_fallback' = the business time zone is unknown and the
   * scheduler zone is used for period boundaries (never presented as the
   * business zone). Optional for reports stored before it was recorded.
   */
  timeZoneSource?: 'business' | 'scheduler_fallback';
  label: string;
  comparison: { start: string; end: string; label: string } | null;
  /** Latest date believed complete in every available source, and how it was determined. */
  latestCompleteDate: string | null;
  latestCompleteBasis: string;
  explicit: boolean;
}

export interface FreshnessEntry {
  source: string;
  dataset: string;
  lastSuccessfulSyncAt: string | null;
  lastAttemptAt: string | null;
  lastStatus: string | null;
  latestDataDate: string | null;
  firstIncompleteDate: string | null;
  coverageWarnings: string[];
  truncated: boolean;
}

export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'none';

export interface ConfidenceAssessment {
  level: ConfidenceLevel;
  reasons: string[];
}

export interface GscTotals {
  property: string;
  searchType: string;
  dateTz: string | null;
  start: string;
  end: string;
  daysWithData: number;
  expectedDays: number;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  excludedIncompleteRows: number;
  batchIds: string[];
  collectedAt: string[];
  synthetic: boolean;
  /** Dates in the window not covered by any successful ingestion batch. */
  uncoveredDates: string[];
}

export interface Ga4ChannelTotals {
  channelView: 'google_organic' | 'all_organic';
  propertyId: string;
  dateTz: string | null;
  start: string;
  end: string;
  daysWithData: number;
  sessions: number;
  engagedSessions: Measured<number>;
  keyEvents: Measured<number>;
  primaryEventName: string | null;
  primaryEventOccurrences: Measured<number>;
  primarySessionRate: Measured<number>;
  primarySessionRateBasis: 'period_metric' | 'session_weighted_daily' | null;
  /**
   * Set when the rate was refused because its stored scale is 'undetermined'
   * (0-1 vs 0-100 not established): the raw value exactly as GA4 reported it
   * (session-weighted over daily rows, or the period value). Never a fraction
   * and never rendered as an OBSERVED percentage.
   */
  primarySessionRateUnverified?: { raw: number; basis: 'period_metric' | 'session_weighted_daily' } | null;
  /**
   * Set when the property's key-event rate scale rests on an owner assertion
   * (`sync ga4 --confirm-rate-scale ... --as <name>`, basis owner_assertion)
   * rather than on GA4 data (a value above 1) or the integer-consistency
   * proof: every verified rate (and what is derived from it) carries this
   * provenance as a caveat and a source id. Null/absent otherwise.
   */
  rateScaleAssertion?: RateScaleAssertion | null;
  sessionsWithPrimaryEvent: Measured<number>;
  /**
   * Users who triggered the primary event, at period grain only
   * (userKeyEventRate:<event> and totalUsers for EXACTLY this period; never
   * summed from daily rows). Distinct from occurrences, converting sessions,
   * and the session rate.
   */
  primaryEventUsers?: PrimaryEventUsers;
  users: Measured<number>;
  usersMetric: string | null;
  revenue: Array<{ currency: string; micros: number }>;
  revenueStatus: Measured<number>['status'];
  notSetSessions: number;
  unmatchedSessions: number;
  excludedIncompleteRows: number;
  batchIds: string[];
  collectedAt: string[];
  synthetic: boolean;
}

/** The owner assertion a property's GA4 key-event rate scale rests on (ga4_rate_scale_confirmations, migration 0320). */
export interface RateScaleAssertion {
  confirmationId: string;
  /** 'fraction' = 0-1 (used as reported); 'percent' = 0-100 (divided by 100). */
  scale: 'fraction' | 'percent';
  /** The named human who asserted it (without the `owner:` prefix). */
  actor: string;
  confirmedAt: string;
  /** What the owner compared (kept in the audit log). */
  evidence: string;
  synthetic: boolean;
}

export interface PrimaryEventUsers {
  /** Share of users (0..1) who triggered the event; unavailable when missing or the scale is unverified. */
  share: Measured<number>;
  /** Derived count: share x totalUsers (same period and view); unavailable unless both are observed and the scale is verified. */
  users: Measured<number>;
  /** totalUsers for the same period, when observed. */
  totalUsers: number | null;
  /** Raw stored userKeyEventRate when its scale is 'undetermined' (never a fraction). */
  rawUnverified: number | null;
  batchIds: string[];
  collectedAt: string[];
  synthetic: boolean;
}

export interface DataQualityItem {
  severity: 'critical' | 'warning' | 'info';
  code: string;
  message: string;
  source?: string;
  nextStep?: string;
  /** Site-config field the item refers to (for config-derived items). */
  configField?: string;
  /** Record that shows the problem, e.g. `ingestion_batches:<id>` or `integration_status:<id>`. */
  recordRef?: string;
}

export interface AccessIssue {
  integration: string;
  state: IntegrationState;
  detail: string;
  nextStep: string | null;
}

export interface ExperimentSummary {
  id: string;
  status: string;
  type: string;
  pageUrl: string | null;
  hypothesis: string;
  primaryMetric: string;
  observationStart: string | null;
  daysObserved: number | null;
  minObservationDays: number;
  impressionsSinceStart: number | null;
  sessionsSinceStart: number | null;
  requiredImpressions: number | null;
  requiredSessions: number | null;
  enoughEvidence: boolean;
  evidenceNote: string;
  reviewDate: string | null;
  interferingChanges: number;
}

export interface PrimaryActionSummary {
  /**
   * 'review_only': an explicit historical period run (weekly --from/--to ending before the latest
   * complete date) assembled a recommendation for review only; it was not saved and supersedes nothing.
   */
  kind: 'primary' | 'no_action' | 'repair_measurement' | 'collect_more_evidence' | 'wait' | 'review_only';
  recommendationId: string | null;
  title: string;
  actionType: string | null;
  pageUrl: string | null;
  query: string | null;
  diagnosis: string | null;
  proposedChange: string | null;
  hypothesis: string | null;
  successCriteria: string | null;
  risks: string | null;
  reviewDate: string | null;
  status: string | null;
  createdAt: string | null;
  secondary: Array<{ id: string; title: string; kind: string }>;
}

export interface ContentQueueItem {
  id: string;
  title: string;
  stage: string;
  decision: string | null;
  priorityScore: number | null;
  draftStatus: string | null;
  unresolvedFacts: number | null;
  reviewVerdict: string | null;
  publishedAt: string | null;
  synthetic: boolean;
}

export interface NextActionSummary {
  code: string;
  text: string;
  command: string | null;
}

export interface ReportData {
  gsc?: {
    property: string | null;
    searchType: string;
    current: Measured<GscTotals>;
    previous: Measured<GscTotals> | null;
    otherProperties: string[];
  };
  googleOrganic?: Measured<Ga4ChannelTotals>;
  allOrganic?: Measured<Ga4ChannelTotals>;
  googleOrganicPrevious?: Measured<Ga4ChannelTotals> | null;
  allOrganicPrevious?: Measured<Ga4ChannelTotals> | null;
  freshness?: FreshnessEntry[];
  confidence?: ConfidenceAssessment;
  dataQuality?: DataQualityItem[];
  accessIssues?: AccessIssue[];
  statusesChecked?: boolean;
  experiments?: ExperimentSummary[];
  primaryAction?: PrimaryActionSummary;
  contentQueue?: ContentQueueItem[];
  contentStages?: Record<string, number>;
  /** Spend of the reviewed budget month (monthly) or the month in progress (weekly/baseline). */
  spend?: SpendReport;
  /** Monthly reports only: the current budget month when it differs from the reviewed month. */
  spendCurrentMonth?: SpendReport;
  unknownCostEntries?: number;
  pendingApprovals?: number;
  nextAction?: NextActionSummary;
  /** Weekly: counts behind the internal-links section (null = not assessed). Tables hold the top-N rows. */
  internalLinks?: { crawlId: string | null; destinations: number; suggestions: number | null; potentialOrphans: number | null; coverageComplete: boolean };
  /** Monthly: counts behind the page-level AEO section. */
  aeo?: {
    crawlId: string | null;
    version: string;
    pagesAssessed: number;
    notAssessed: number;
    counts?: Record<'answer' | 'headings' | 'sections' | 'evidence', Record<'ok' | 'review' | 'unknown', number>>;
    eligibility?: { noindex: number; snippetBlocked: number; snippetLimited: number; aiFeaturesNotEligible: number; unknown: number; robotsBlocked: number };
  };
  [key: string]: unknown;
}

export interface LlmSummaryInfo {
  status: 'not_requested' | 'generated' | 'skipped' | 'failed';
  detail: string;
  model?: string;
  promptVersion?: string;
  costMicros?: number | null;
}

export interface Report {
  schemaVersion: number;
  id: string;
  kind: ReportKind;
  siteId: string;
  siteName: string;
  generatedAt: string;
  generator: { version: string; deterministic: true; llmSummary: LlmSummaryInfo };
  period: ReportPeriod;
  isSynthetic: boolean;
  watermark: string | null;
  jobId: string | null;
  sections: ReportSection[];
  metricDefinitions: MetricDefinition[];
  data: ReportData;
  /** Short machine summary persisted to reports.summary_json. */
  summary: ReportSummary;
}

export interface ReportSummary {
  kind: ReportKind;
  period: { start: string; end: string };
  confidence: ConfidenceLevel;
  isSynthetic: boolean;
  primaryAction: { kind: PrimaryActionSummary['kind']; title: string; recommendationId: string | null } | null;
  nextAction: string | null;
  warnings: number;
  accessIssues: number;
  claimCounts: Record<ClaimLabel, number>;
}

// ---------------------------------------------------------------------------
// Claim constructors
// ---------------------------------------------------------------------------

export interface ClaimOptions {
  sourceIds?: string[];
  retrievedAt?: string[];
  metricIds?: string[];
  evidence?: EvidenceLink[];
  reason?: string;
  evidenceStatus?: EvidenceStatus;
  synthetic?: boolean;
  links?: LinkTarget[];
}

export function claim(label: ClaimLabel, id: string, text: string, opts: ClaimOptions = {}): Claim {
  const evidence = opts.evidence ?? [];
  const c: Claim = {
    id,
    label,
    text,
    sourceIds: uniq(opts.sourceIds ?? []),
    retrievedAt: uniq(opts.retrievedAt ?? []).sort(),
    metricIds: uniq(opts.metricIds ?? []),
    evidence,
    evidenceStatus: opts.evidenceStatus ?? defaultEvidenceStatus(label, evidence),
  };
  if (opts.reason !== undefined) c.reason = opts.reason;
  if (opts.synthetic) c.synthetic = true;
  if (opts.links && opts.links.length) c.links = opts.links;
  return c;
}

function defaultEvidenceStatus(label: ClaimLabel, evidence: EvidenceLink[]): EvidenceStatus {
  if (label === 'DATA_UNAVAILABLE') return 'not_applicable';
  if (evidence.some((e) => e.supportsClaim)) return 'supported';
  if (evidence.length > 0) return 'context_only';
  return label === 'RECOMMENDATION' || label === 'HYPOTHESIS' ? 'not_applicable' : 'missing';
}

export const observed = (id: string, text: string, opts: ClaimOptions = {}) => claim('OBSERVED', id, text, opts);
export const inferred = (id: string, text: string, opts: ClaimOptions = {}) => claim('INFERRED', id, text, opts);
export const hypothesis = (id: string, text: string, opts: ClaimOptions = {}) => claim('HYPOTHESIS', id, text, opts);
export const recommendation = (id: string, text: string, opts: ClaimOptions = {}) => claim('RECOMMENDATION', id, text, opts);
export const unavailable = (id: string, text: string, reason: string, opts: ClaimOptions = {}) =>
  claim('DATA_UNAVAILABLE', id, text, { ...opts, reason });

export function section(key: SectionKey, title: string, parts: Partial<Omit<ReportSection, 'key' | 'title'>> = {}): ReportSection {
  return { key, title, claims: parts.claims ?? [], tables: parts.tables ?? [], notes: parts.notes ?? [] };
}

export function dbQueryLink(view: string, filters: Record<string, string | number | null | undefined>, label?: string): EvidenceLink {
  const q = Object.entries(filters)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('&');
  const dflt = view.endsWith('_current') ? `${view} (current revision)` : `${view} (query)`;
  return { kind: 'db_query', label: label ?? dflt, ref: q ? `${view}?${q}` : view, supportsClaim: true };
}

export function recordLink(table: string, id: string, label?: string, supportsClaim = true): EvidenceLink {
  return { kind: 'db_record', label: label ?? `${table}:${id}`, ref: `${table}:${id}`, supportsClaim };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ReportIssue {
  claimId?: string;
  section?: string;
  message: string;
}

export function allClaims(report: Pick<Report, 'sections'>): Claim[] {
  return report.sections.flatMap((s) => s.claims);
}

/**
 * Structural checks for the reporting contract. The builders are expected to
 * produce reports with zero issues; tests assert that.
 */
export function validateReport(report: Report): ReportIssue[] {
  const issues: ReportIssue[] = [];
  const seen = new Set<string>();
  const metricIds = new Set(report.metricDefinitions.map((m) => m.id));
  for (const s of report.sections) {
    for (const c of s.claims) {
      if (seen.has(c.id)) issues.push({ claimId: c.id, section: s.key, message: 'duplicate claim id' });
      seen.add(c.id);
      if (!(CLAIM_LABELS as readonly string[]).includes(c.label)) issues.push({ claimId: c.id, section: s.key, message: `invalid label ${c.label}` });
      if (!c.text.trim()) issues.push({ claimId: c.id, section: s.key, message: 'empty claim text' });
      for (const m of c.metricIds) if (!metricIds.has(m)) issues.push({ claimId: c.id, section: s.key, message: `unknown metric definition ${m}` });
      if (c.label === 'DATA_UNAVAILABLE' && !c.reason) issues.push({ claimId: c.id, section: s.key, message: 'DATA_UNAVAILABLE claim without a reason' });
      if (c.label === 'OBSERVED' || c.label === 'INFERRED') {
        const explicitlyUnverified = c.evidenceStatus === 'missing' || c.evidenceStatus === 'context_only';
        const supported = c.evidence.some((e) => e.supportsClaim);
        if (!explicitlyUnverified) {
          if (c.sourceIds.length === 0) issues.push({ claimId: c.id, section: s.key, message: `${c.label} claim without source IDs` });
          if (c.label === 'OBSERVED' && c.retrievedAt.length === 0) issues.push({ claimId: c.id, section: s.key, message: 'OBSERVED claim without a retrieval date' });
          if (!supported) {
            const urlOnly = c.evidence.length > 0 && c.evidence.every((e) => e.kind === 'url');
            issues.push({
              claimId: c.id,
              section: s.key,
              message: urlOnly ? 'a source URL alone does not support the claim' : `${c.label} claim without supporting evidence`,
            });
          }
        }
        if (c.evidenceStatus === 'supported' && !supported) issues.push({ claimId: c.id, section: s.key, message: 'evidenceStatus "supported" but no link supports the claim' });
      }
    }
  }
  const primary = report.sections.find((s) => s.key === 'primary_action');
  if (!primary) issues.push({ section: 'primary_action', message: 'missing primary action / wait section' });
  else {
    const recs = primary.claims.filter((c) => c.id === 'action.primary');
    if (recs.length !== 1) issues.push({ section: 'primary_action', message: 'exactly one primary action (or explicit wait) claim is required' });
  }
  if (!report.sections.some((s) => s.key === 'next_action')) issues.push({ section: 'next_action', message: 'missing next action section' });
  if (report.isSynthetic && report.watermark !== SYNTHETIC_WATERMARK) issues.push({ message: 'synthetic report without watermark' });
  return issues;
}

export function countClaims(report: Pick<Report, 'sections'>): Record<ClaimLabel, number> {
  const out = Object.fromEntries(CLAIM_LABELS.map((l) => [l, 0])) as Record<ClaimLabel, number>;
  for (const c of allClaims(report)) out[c.label]++;
  return out;
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
