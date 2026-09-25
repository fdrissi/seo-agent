/**
 * Experiment record types (spec section 23). SQLite is authoritative
 * (migrations 0007 + 0190); these types are the typed view used in code.
 */

export const EXPERIMENT_STATUSES = ['proposed', 'approved', 'awaiting_implementation', 'observing', 'positive', 'negative', 'inconclusive', 'cancelled'] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export const TERMINAL_STATUSES: readonly ExperimentStatus[] = ['positive', 'negative', 'inconclusive', 'cancelled'];
/**
 * Approved-or-later, not yet concluded. NOTE: a merely `proposed` experiment
 * also holds its page (one meaningful change per page at a time); use
 * `pageFreeze` / `OPEN_EXPERIMENT_STATUSES` from `./freeze.js` for that rule.
 */
export const ACTIVE_STATUSES: readonly ExperimentStatus[] = ['approved', 'awaiting_implementation', 'observing'];

export const EXPERIMENT_TYPES = ['title_meta', 'content_section', 'internal_links', 'technical', 'new_page', 'other'] as const;
export type ExperimentType = (typeof EXPERIMENT_TYPES)[number];

export type OutcomeKind = 'seo_visibility' | 'conversion' | 'both';

/** Metrics the evaluator can compute from current-revision GSC/GA4 rows. */
export const SEO_METRICS = ['clicks', 'impressions', 'ctr', 'position'] as const;
export const CONVERSION_METRICS = ['primarySessionRate', 'primaryKeyEvents', 'sessions', 'engagedSessionRate', 'revenue'] as const;
export type SeoMetric = (typeof SEO_METRICS)[number];
export type ConversionMetric = (typeof CONVERSION_METRICS)[number];
export type MetricName = SeoMetric | ConversionMetric;

export function isSeoMetric(m: string): m is SeoMetric {
  return (SEO_METRICS as readonly string[]).includes(m);
}
export function isConversionMetric(m: string): m is ConversionMetric {
  return (CONVERSION_METRICS as readonly string[]).includes(m);
}
export function isMetricName(m: string): m is MetricName {
  return isSeoMetric(m) || isConversionMetric(m);
}
/** Direction of improvement. Average position improves when it goes DOWN. */
export function higherIsBetter(m: MetricName): boolean {
  return m !== 'position';
}

export interface Guardrail {
  metric: MetricName;
  /** Maximum tolerated relative deterioration (0.2 = 20% worse) before the result cannot be called a win. */
  maxRelativeDecline: number;
}

export interface SampleRequirements {
  /** Minimum GSC impressions for the treated page in EACH window (baseline and observation). */
  minImpressionsPerWindow: number;
  /** Minimum GA4 sessions for the treated page in EACH window for conversion outcomes. */
  minSessionsPerWindow: number;
  /** Minimum (estimated) converting sessions in EACH window before a conversion change can be judged. */
  minConvertingSessionsPerWindow: number;
  /** Smallest relative effect (difference-in-differences) treated as meaningful; smaller = no meaningful change. */
  minRelativeEffect: number;
  /** After this many days of complete observation data, an experiment is concluded even with insufficient data (inconclusive). */
  maxObservationDays: number;
  /** GSC/GA4 segment_key used in both windows (segment matching). '' = unsegmented rows. */
  segmentKey: string;
  searchType: string;
  channelView: 'google_organic' | 'all_organic';
  /**
   * The measured scope, recorded explicitly at proposal (absent on experiments
   * proposed before it was recorded): page-level totals of one Search Console
   * dataset (property, search type, segment) and one GA4 channel view. Query-level
   * metrics are never evaluated.
   */
  measuredScope?: MeasuredScope;
}

export interface MeasuredScope {
  level: 'page';
  seoDataset: string;
  conversionDataset: string;
  gscProperty: string | null;
  ga4Property: string | null;
  searchType: string;
  segmentKey: string;
  channelView: 'google_organic' | 'all_organic';
  queryLevel: false;
}

/** Measurement-relevant configuration frozen at proposal; compared with the current config at evaluation. */
export interface MeasurementConfig {
  gscProperty: string | null;
  ga4Property: string | null;
  primaryEvents: string[];
  brandAliases: string[];
  channelView: string;
  searchType: string;
  segmentKey: string;
}

export interface FrozenVersions {
  promptVersion: string | null;
  modelId: string | null;
  scoringVersion: string | null;
  measurementMethod: string;
  measurementMethodVersion: string;
  configVersion: number | null;
  configHash: string | null;
  artifactHashVersion: number;
  /** Absent on experiments proposed before measurement-config freezing. */
  measurementConfig?: MeasurementConfig;
  measurementConfigHash?: string;
}

export interface ComparisonPage {
  pageId: string;
  url: string;
}

export interface ExperimentChange {
  actionType: string;
  targetUrl: string;
  change: Record<string, unknown>;
  changeHash: string;
}

export interface ExperimentRecord {
  id: string;
  siteId: string;
  pageId: string | null;
  recommendationId: string | null;
  type: string;
  hypothesis: string;
  evidence: Record<string, unknown>;
  proposedChange: string;
  changeHash: string;
  baseline: Record<string, unknown> | null;
  primaryMetric: MetricName;
  outcomeKind: OutcomeKind;
  guardrails: Guardrail[];
  minObservationDays: number;
  sampleRequirements: SampleRequirements;
  risks: string;
  rollbackPlan: string;
  reviewDate: string | null;
  status: ExperimentStatus;
  frozenVersions: FrozenVersions | null;
  implementedAt: string | null;
  sourceRevision: string | null;
  beforeSnapshotRef: string | null;
  afterSnapshotRef: string | null;
  observationStart: string | null;
  observationEnd: string | null;
  comparisonPages: ComparisonPage[];
  outcome: Record<string, unknown> | null;
  approvalId: string | null;
  createdAt: string;
  updatedAt: string;
}
