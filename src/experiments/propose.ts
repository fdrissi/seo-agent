import type { AppContext } from '../app/context.js';
import { budgetTimeZone } from '../app/context.js';
import { AppError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { hashObject } from '../core/hash.js';
import { addDays, dateInZone } from '../core/time.js';
import { recordAudit } from '../database/audit.js';
import { ARTIFACT_HASH_VERSION, computeArtifactHash, experimentTypeFor } from '../approvals/artifact.js';
import {
  actionScopeWarnings,
  assertConcreteRecommendation,
  changeFromRecommendation,
  experimentTypeForStructuredChange,
  getRecommendation,
  isNoActionRecommendation,
  pickString,
  recommendationActionType,
  recommendationDetails,
  recommendationLabelSource,
  structuredChangeOf,
} from '../approvals/change.js';
import { assertAllowed } from '../approvals/policy.js';
import type { ApprovalService } from '../approvals/service.js';
import { assertOnSiteTarget } from '../approvals/subjects.js';
import type { TargetChecker } from '../approvals/target-check.js';
import type { ApprovalRecord } from '../approvals/types.js';
import { configuredGscScope } from '../seo/coverage.js';
import { describeHolders, pageFreeze } from './freeze.js';
import { EVALUATION_METHOD, EVALUATION_METHOD_VERSION } from './method.js';
import { ga4WindowMetrics, gscWindowMetrics, latestCompleteGa4Date, latestCompleteGscDate, pageIdentity } from './metrics.js';
import { getExperiment, getPage, listExperiments, risksStated, type PageRow } from './repository.js';
import { trailingWeeks } from './windows.js';
import {
  isConversionMetric,
  isMetricName,
  isSeoMetric,
  type ComparisonPage,
  type ExperimentRecord,
  type FrozenVersions,
  type Guardrail,
  type MeasurementConfig,
  type MetricName,
  type OutcomeKind,
  type SampleRequirements,
} from './types.js';

/**
 * Propose an experiment from a recommendation. The proposal records every
 * field required by spec section 23, computes the exact change hash, freezes
 * prompt/model/scoring/measurement versions, and files a PENDING approval
 * request for the exact change. Nothing is approved here.
 */

export const DEFAULT_COMPARISON_PAGES = 5;
/** Defaults for per-experiment sample requirements (recorded on each experiment; overridable per proposal). */
export const DEFAULT_MIN_RELATIVE_EFFECT = 0.1;
export const DEFAULT_MIN_CONVERTING_SESSIONS = 10;
export const DEFAULT_GUARDRAIL_MAX_DECLINE = 0.2;
export const MAX_OBSERVATION_MULTIPLIER = 3;
/** Buffer between the end of the minimum observation period and the review date (data finalization lag). */
export const REVIEW_BUFFER_DAYS = 7;
/** Extra buffer at proposal time, before the implementation date is known. */
export const PROPOSAL_REVIEW_BUFFER_DAYS = 14;
const BASELINE_WEEKS = 4;

export interface ProposeInput {
  recommendationId: string;
  requestedBy: string;
  primaryMetric?: string;
  outcomeKind?: OutcomeKind;
  minObservationDays?: number;
  comparisonPages?: number;
  minRelativeEffect?: number;
  sourceRevision?: string | null;
  /** Risks of the change; required when the recommendation states none (the proposal is refused otherwise). */
  risks?: string;
  rollbackPlan?: string;
  /**
   * Required to re-test when this exact change, or a change of the same type
   * on the same page, was already tested (concluded, or cancelled after it
   * went live). Recorded with the prior tests in the evidence.
   */
  retestReason?: string;
  /**
   * Critical broken functionality only: allows proposing a change for a page
   * that another experiment holds. The intent is recorded in the evidence and
   * the audit log; the blocking critical_fix annotation is written only when
   * the change is actually implemented (mark-implemented, at the real time).
   */
  criticalFixReason?: string;
  approvalTtlHours?: number;
  /**
   * Search Console segment_key measured in both windows (e.g. a device or
   * country segment ingested by the GSC sync). Default '' = unsegmented page
   * totals. Refused when no Search Console page rows exist for the segment.
   */
  segmentKey?: string;
}

/** Days per week: observation windows are whole weeks (weekday matching). */
const WEEK = 7;

/**
 * The measurement-relevant configuration frozen at proposal (A7-09): a change
 * of any of these during an experiment means the baseline and observation
 * windows may measure different things.
 */
export function measurementConfigOf(ctx: Pick<AppContext, 'config'>, sample: Pick<SampleRequirements, 'channelView' | 'searchType' | 'segmentKey'>): MeasurementConfig {
  const cfg = ctx.config;
  return {
    gscProperty: cfg.google.searchConsoleProperty ?? null,
    ga4Property: cfg.google.ga4PropertyId ?? null,
    primaryEvents: cfg.conversions.primaryEvents.map((e) => e.name).sort(),
    brandAliases: [...cfg.brand.aliases].map((a) => a.trim()).sort(),
    channelView: sample.channelView,
    searchType: sample.searchType,
    segmentKey: sample.segmentKey,
  };
}

export function measurementConfigHash(m: MeasurementConfig): string {
  return hashObject(m);
}

const QUERY_LEVEL_CRITERIA = /\b(quer(y|ies)|keywords?|search terms?)\b/i;

/** The page-level success criterion the evaluator actually measures (A7-07). */
export function pageLevelSuccessCriteria(metric: MetricName, outcomeKind: OutcomeKind, sample: SampleRequirements): string {
  const scope = isConversionMetric(metric)
    ? `GA4 landing-page rows (channel view ${sample.channelView}, ${sample.segmentKey ? `segment ${sample.segmentKey}` : 'unsegmented'})`
    : `Search Console page totals (search type ${sample.searchType}, ${sample.segmentKey ? `segment ${sample.segmentKey}` : 'all queries, unsegmented'})`;
  return `Page-level ${metric} of the treated page, from ${scope}, changes by at least ${Math.round(sample.minRelativeEffect * 100)}% relative to the unchanged comparison pages (or the pre-change period without them) over weekday-matched windows of equal length; outcome kind ${outcomeKind}. Query-level metrics are not evaluated.`;
}

export interface ProposeResult {
  experiment: ExperimentRecord;
  approval: ApprovalRecord;
  warnings: string[];
}

function defaultPrimaryMetric(type: string, actionType: string): MetricName {
  if (/conversion|cta|form|checkout|signup|lead/.test(actionType.toLowerCase())) return 'primarySessionRate';
  if (type === 'title_meta') return 'ctr';
  return 'clicks';
}

function outcomeKindFor(metric: MetricName): OutcomeKind {
  return isConversionMetric(metric) ? 'conversion' : 'seo_visibility';
}

function defaultRollbackPlan(type: string): string {
  switch (type) {
    case 'title_meta':
      return 'Restore the previous title and meta description recorded in the before-snapshot (export package rollback.md), then record the rollback with `experiments annotate --kind site_change`.';
    case 'content_section':
      return 'Revert the page content to the before-snapshot revision (source revision recorded at implementation), then record the rollback as an annotation.';
    case 'internal_links':
      return 'Remove the added links / restore the previous links from the before-snapshot, then record the rollback as an annotation.';
    case 'technical':
      return 'Revert the technical change to the recorded source revision; re-check indexability after rollback and record it as an annotation.';
    case 'new_page':
      return 'Unpublish or noindex the new page only after human review (production action requiring its own approval); record it as an annotation.';
    default:
      return 'Revert to the source revision recorded at implementation and record the rollback as an annotation.';
  }
}

/** Search Console dataset scope used to rank comparison pages (the same one the experiment measures). */
export interface ComparisonScope {
  property: string | null;
  searchType: string;
  segmentKey: string;
}

/** Search type measured by default: the configured primary search type ('web' when synced, else the first configured type). */
export function defaultSearchType(ctx: Pick<AppContext, 'config'>): string {
  const scoped = configuredGscScope(ctx.config);
  if (scoped) return scoped.searchType;
  const types = ctx.config.google.gsc.searchTypes;
  return types.includes('web') ? 'web' : (types[0] ?? 'web');
}

/** The ONE Search Console property an experiment measures, or why there is none. */
export type MeasuredGscProperty =
  | { property: string; basis: 'config' | 'recorded' | 'data' }
  | { property: null; ambiguous: boolean; reason: string };

/**
 * Resolve the single Search Console property experiment metrics come from:
 * the configured property (configuredGscScope), else the property recorded
 * on the experiment at proposal, else the only property with page-level data.
 * With no property configured and several properties holding page rows,
 * nothing is resolved (`ambiguous`): rows of different properties describe
 * the same clicks and are never ranked or summed together.
 */
export function resolveMeasuredGscProperty(ctx: Pick<AppContext, 'db' | 'siteId' | 'config'>, recorded?: string | null): MeasuredGscProperty {
  const configured = configuredGscScope(ctx.config);
  if (configured) return { property: configured.property, basis: 'config' };
  if (recorded) return { property: recorded, basis: 'recorded' };
  const props = ctx.db.all<{ property: string }>('SELECT DISTINCT property FROM gsc_page_daily_current WHERE site_id = ? ORDER BY property', [ctx.siteId]).map((r) => r.property);
  if (props.length === 1) return { property: props[0]!, basis: 'data' };
  if (!props.length) return { property: null, ambiguous: false, reason: 'no Search Console property is configured and no Search Console page data exists' };
  return {
    property: null,
    ambiguous: true,
    reason: `no Search Console property is configured and several properties have page data (${props.join(', ')}); their rows are never ranked or summed together (set google.searchConsoleProperty)`,
  };
}

/**
 * The exact Search Console dataset comparison pages are ranked on: one
 * property (explicit, configured, or the only one with data), one search type
 * (explicit or the configured primary type), and one segment (explicit, else
 * '' = unsegmented page totals). Null scope with a reason when no single
 * property can be determined.
 */
export function comparisonScope(
  ctx: Pick<AppContext, 'db' | 'siteId' | 'config'>,
  scope?: Partial<ComparisonScope>,
): { scope: ComparisonScope & { property: string }; reason: null } | { scope: null; reason: string } {
  const searchType = scope?.searchType ?? defaultSearchType(ctx);
  const segmentKey = scope?.segmentKey ?? '';
  let property = scope?.property ?? null;
  if (!property) {
    const r = resolveMeasuredGscProperty(ctx);
    if (r.property === null) return { scope: null, reason: r.reason };
    property = r.property;
  }
  return { scope: { property, searchType, segmentKey }, reason: null };
}

/**
 * Unchanged comparison pages: most-visible pages without active experiments,
 * same page type when known. Visibility is ranked on the SAME Search Console
 * dataset the experiment measures (one property, search type, and segment;
 * see comparisonScope), so rows of another property, search type, or segment
 * never pick the comparison group. When no single property can be resolved,
 * no comparison pages are selected (never a ranking across properties).
 */
export function selectComparisonPages(
  ctx: AppContext,
  treated: PageRow | null,
  window: { start: string; end: string },
  limit: number,
  excludeExperimentId?: string,
  scope?: Partial<ComparisonScope>,
): ComparisonPage[] {
  if (limit <= 0) return [];
  const resolved = comparisonScope(ctx, scope).scope;
  if (!resolved) return [];
  const { property, searchType, segmentKey } = resolved;
  const busy = new Set(
    listExperiments(ctx.db, ctx.siteId, { statuses: ['proposed', 'approved', 'awaiting_implementation', 'observing'] })
      .filter((e) => e.id !== excludeExperimentId)
      .map((e) => e.pageId)
      .filter((p): p is string => !!p),
  );
  const rows = ctx.db.all<{ page_id: string; url: string; page_type: string | null; impressions: number }>(
    `SELECT g.page_id AS page_id, p.url AS url, p.page_type AS page_type, SUM(g.impressions) AS impressions
     FROM gsc_page_daily_current g JOIN pages p ON p.id = g.page_id
     WHERE g.site_id = ? AND p.site_id = ? AND g.date BETWEEN ? AND ? AND g.property = ? AND g.search_type = ? AND g.segment_key = ? AND p.is_excluded = 0
     GROUP BY g.page_id ORDER BY impressions DESC LIMIT 200`,
    [ctx.siteId, ctx.siteId, window.start, window.end, property, searchType, segmentKey],
  );
  const candidates = rows.filter((r) => r.page_id !== treated?.id && !busy.has(r.page_id) && r.impressions > 0);
  const sameType = treated?.page_type ? candidates.filter((r) => r.page_type === treated.page_type) : [];
  const pool = sameType.length >= Math.min(limit, 2) ? sameType : candidates;
  return pool.slice(0, limit).map((r) => ({ pageId: r.page_id, url: r.url }));
}

export async function proposeFromRecommendation(ctx: AppContext, gate: ApprovalService, input: ProposeInput, deps: { targetChecker?: TargetChecker } = {}): Promise<ProposeResult> {
  assertAllowed(ctx.mode, 'propose_experiment');
  const warnings: string[] = [];
  const rec = getRecommendation(ctx.db, ctx.siteId, input.recommendationId);
  if (!rec) throw new AppError('NOT_FOUND', `Recommendation ${input.recommendationId} not found for site ${ctx.siteId}.`);
  if (isNoActionRecommendation(rec)) throw new AppError('VALIDATION_FAILED', `Recommendation ${rec.id} is a "${rec.kind}" decision with no change to test.`);
  if (!['proposed', 'approved'].includes(rec.status)) throw new AppError('CONFLICT', `Recommendation ${rec.id} is ${rec.status}; only proposed or approved recommendations can become experiments.`);
  // An audit/investigation instruction is not a change: nothing to hash, approve, or measure.
  assertConcreteRecommendation(rec, 'become an experiment');
  if (!rec.proposed_change?.trim()) throw new AppError('VALIDATION_FAILED', `Recommendation ${rec.id} has no exact proposed change.`);
  if (!rec.hypothesis?.trim()) throw new AppError('VALIDATION_FAILED', `Recommendation ${rec.id} has no hypothesis; an experiment needs one.`);
  // Spec 23: every experiment states its risks. Nothing is recorded (and no approval requested) without them.
  const risks = input.risks?.trim() || rec.risks?.trim() || '';
  if (!risksStated(risks)) {
    throw new AppError('VALIDATION_FAILED', `Recommendation ${rec.id} states no risks and none were given; an experiment needs its risks before it can be proposed and approved.`, {
      details: { recommendationId: rec.id, reason: 'risks_not_stated' },
      hint: `Propose it with the risks stated: \`experiments propose --recommendation ${rec.id} --risks "<what could go wrong, for which pages or queries>"\`.`,
    });
  }

  const details = recommendationDetails(rec);
  const structured = structuredChangeOf(details);
  const page = rec.page_id ? getPage(ctx.db, ctx.siteId, rec.page_id) : null;
  const targetUrl = pickString(details, 'targetUrl') ?? page?.url;
  if (!targetUrl) throw new AppError('VALIDATION_FAILED', `Recommendation ${rec.id} has no page or target URL.`);
  assertOnSiteTarget(ctx, targetUrl, `Recommendation ${rec.id}`);
  const type = structured ? experimentTypeForStructuredChange(structured) : experimentTypeFor(rec.action_type);
  // The exact change: the structured change (when recorded) is hashed with the target and action type.
  const change = changeFromRecommendation(rec);
  const actionType = recommendationActionType(rec, change);
  const changeHash = computeArtifactHash({ actionType, target: targetUrl, change: change as Record<string, unknown> });
  // The reviewer sees every scope or label mismatch (e.g. a title change on a recommendation labeled repair_measurement).
  warnings.push(...actionScopeWarnings(actionType, change, recommendationLabelSource(rec)));

  // One meaningful change per page at a time: any open experiment (including
  // one still only proposed) holds the page.
  const freeze = pageFreeze(ctx.db, ctx.siteId, { pageId: page?.id ?? null, url: targetUrl });
  const holders = [...freeze.observing, ...freeze.pending];
  const criticalFix = input.criticalFixReason?.trim() || null;
  if (holders.length && !criticalFix) {
    throw new AppError('CONFLICT', `Page ${targetUrl} already has an open experiment (${describeHolders(holders)}). One meaningful change per page at a time.`, {
      details: { openExperiments: holders.map((a) => ({ id: a.id, status: a.status })) },
      hint: 'Wait for it to conclude, cancel it (or reject its pending approval), or, only for critical broken functionality, pass --critical-fix "<reason>". The override is recorded and flags the running experiment once the fix is actually implemented.',
    });
  }

  // No re-testing until favorable: prior tests are experiments with this exact
  // change, or with a change of the same type on the same page, that
  // concluded or were cancelled after they went live.
  const pageId = page?.id ?? freeze.pageId;
  const prior = ctx.db.all<{ id: string; status: string; change_hash: string; type: string; implemented_at: string | null; evals: number }>(
    `SELECT e.id, e.status, e.change_hash, e.type, e.implemented_at,
            (SELECT COUNT(*) FROM experiment_evaluations v WHERE v.experiment_id = e.id) AS evals
     FROM experiments e
     WHERE e.site_id = ? AND (e.change_hash = ? OR (? IS NOT NULL AND e.page_id = ? AND e.type = ?))
     ORDER BY e.created_at`,
    [ctx.siteId, changeHash, pageId, pageId, type],
  );
  const open = prior.filter((p) => p.change_hash === changeHash && !['positive', 'negative', 'inconclusive', 'cancelled'].includes(p.status));
  if (open.length) throw new AppError('CONFLICT', `The same change is already an open experiment (${open.map((o) => o.id).join(', ')}).`);
  const wentLive = (p: { implemented_at: string | null; evals: number }) => p.implemented_at !== null || p.evals > 0;
  const priorTests = prior
    .filter((p) => ['positive', 'negative', 'inconclusive'].includes(p.status) || (p.status === 'cancelled' && wentLive(p)))
    .map((p) => ({ experimentId: p.id, status: p.status, match: p.change_hash === changeHash ? ('exact_change' as const) : ('same_page_and_type' as const), wentLive: wentLive(p) }));
  const retestReason = input.retestReason?.trim() || null;
  if (priorTests.length && !retestReason) {
    const exact = priorTests.filter((t) => t.match === 'exact_change');
    const what = exact.length ? 'This exact change was already tested' : `A ${type} change on this page was already tested`;
    throw new AppError('CONFLICT', `${what} (${priorTests.map((c) => `${c.experimentId}: ${c.status}${c.status === 'cancelled' ? ' after going live' : ''}`).join(', ')}). Repeating a test until a favorable result appears is not allowed.`, {
      details: { priorTests },
      hint: 'If there is a documented, material reason to test again (e.g. the earlier test was invalidated by an outage), pass --retest-reason "<reason>"; prior outcomes stay recorded in the new experiment.',
    });
  }

  // Baseline (last 4 complete weeks) and low-traffic detection.
  const cfg = ctx.config;
  // ONE Search Console property (configured, else the only one with page data): never several summed.
  const gscProperty = resolveMeasuredGscProperty(ctx);
  const property = gscProperty.property;
  const gscAmbiguity = gscProperty.property === null && gscProperty.ambiguous ? gscProperty.reason : null;
  if (gscAmbiguity) {
    warnings.push(`Search Console: ${gscAmbiguity}. No Search Console baseline or comparison pages were used; configure the property and propose again.`);
  } else if (gscProperty.property !== null && gscProperty.basis === 'data') {
    warnings.push(`google.searchConsoleProperty is not configured; the only Search Console property with page data (${gscProperty.property}) is measured.`);
  }
  const searchType = defaultSearchType(ctx);
  const ga4Property = cfg.google.ga4PropertyId;
  const channelView = 'google_organic' as const;
  const segmentKey = (input.segmentKey ?? '').trim();
  if (segmentKey) {
    if (segmentKey.length > 200 || /[\u0000-\u001f]/.test(segmentKey)) throw new AppError('VALIDATION_FAILED', 'The segment key is not a valid Search Console segment_key.');
    const rows = ctx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM gsc_page_daily_current WHERE site_id = ? AND search_type = ? AND segment_key = ? ${property ? 'AND property = ?' : ''}`,
      property ? [ctx.siteId, searchType, segmentKey, property] : [ctx.siteId, searchType, segmentKey],
    )?.n;
    if (!rows) {
      throw new AppError('VALIDATION_FAILED', `No Search Console page rows exist for segment "${segmentKey}" (search type ${searchType}); an experiment cannot be measured on it.`, {
        hint: 'Omit --segment to measure unsegmented page totals, or ingest that segment with the Search Console sync first.',
      });
    }
    warnings.push(`Segment "${segmentKey}" is measured in both windows for Search Console. GA4 landing-page rows are ingested unsegmented, so conversion outcomes and conversion guardrails for this segment will be DATA_UNAVAILABLE.`);
  }
  const identity = pageIdentity(ctx.db, ctx.siteId, [{ id: page?.id ?? null, url: targetUrl }]);
  const gscEnd = gscAmbiguity ? null : latestCompleteGscDate(ctx.db, ctx.siteId, property, searchType, segmentKey);
  const gscWindow = gscEnd ? trailingWeeks(gscEnd, BASELINE_WEEKS) : null;
  const gscBaseline = gscWindow ? gscWindowMetrics(ctx.db, identity, { siteId: ctx.siteId, property, searchType, segmentKey, start: gscWindow.start, end: gscWindow.end }) : null;
  const ga4End = latestCompleteGa4Date(ctx.db, ctx.siteId, ga4Property, channelView, segmentKey);
  const ga4Window = ga4End ? trailingWeeks(ga4End, BASELINE_WEEKS) : null;
  const ga4Baseline = ga4Window ? ga4WindowMetrics(ctx.db, identity, { siteId: ctx.siteId, propertyId: ga4Property, channelView, segmentKey, start: ga4Window.start, end: ga4Window.end }) : null;
  const baselineImpressions = gscBaseline && gscBaseline.status !== 'unavailable' ? gscBaseline.impressions : null;
  const lowTraffic = baselineImpressions === null || baselineImpressions < cfg.experiments.minImpressionsForEvaluation;
  const configuredMin = lowTraffic ? cfg.experiments.lowTrafficMinObservationDays : cfg.experiments.defaultMinObservationDays;
  let requestedMin = configuredMin;
  if (input.minObservationDays !== undefined) {
    if (!Number.isInteger(input.minObservationDays) || input.minObservationDays < 7) throw new AppError('VALIDATION_FAILED', 'minObservationDays must be an integer of at least 7.');
    if (input.minObservationDays < configuredMin) warnings.push(`Minimum observation period ${input.minObservationDays} days is shorter than the configured ${configuredMin} days${lowTraffic ? ' for low-traffic pages' : ''}.`);
    requestedMin = input.minObservationDays;
  }
  // Measurement windows are whole weeks (weekday matching): a minimum that is not a
  // multiple of 7 is rounded UP, so the evaluated window is never shorter than the minimum.
  const minObservationDays = Math.ceil(requestedMin / WEEK) * WEEK;
  if (minObservationDays !== requestedMin) {
    warnings.push(`Minimum observation period rounded up from ${requestedMin} to ${minObservationDays} days: measurement windows are whole weeks (weekday-matched).`);
  }
  if (lowTraffic) warnings.push(baselineImpressions === null ? 'No Search Console baseline is available for this page; treated as low traffic (longer observation period).' : `Low traffic (${baselineImpressions} impressions in the last 4 complete weeks); longer observation period applies.`);

  let primaryMetric: MetricName = defaultPrimaryMetric(type, rec.action_type);
  if (input.primaryMetric) {
    if (!isMetricName(input.primaryMetric)) throw new AppError('VALIDATION_FAILED', `Unknown primary metric "${input.primaryMetric}".`);
    primaryMetric = input.primaryMetric;
  }
  const outcomeKind: OutcomeKind = input.outcomeKind ?? outcomeKindFor(primaryMetric);
  if (outcomeKind === 'seo_visibility' && !isSeoMetric(primaryMetric)) throw new AppError('VALIDATION_FAILED', `Primary metric ${primaryMetric} is not a search-visibility metric.`);
  if (outcomeKind === 'conversion' && !isConversionMetric(primaryMetric)) throw new AppError('VALIDATION_FAILED', `Primary metric ${primaryMetric} is not a conversion metric.`);

  const conversionsConfigured = !!ga4Property && cfg.conversions.primaryEvents.length > 0;
  const guardrails: Guardrail[] = [];
  if (outcomeKind === 'seo_visibility') {
    if (conversionsConfigured) guardrails.push({ metric: 'primarySessionRate', maxRelativeDecline: DEFAULT_GUARDRAIL_MAX_DECLINE });
    else warnings.push('No conversion guardrail: GA4 property or primary conversion event is not configured, so lead quality cannot be checked.');
  } else if (outcomeKind === 'conversion') {
    guardrails.push({ metric: 'clicks', maxRelativeDecline: DEFAULT_GUARDRAIL_MAX_DECLINE });
  }
  if ((outcomeKind === 'conversion' || outcomeKind === 'both') && !conversionsConfigured) {
    warnings.push('Conversion outcome requested but GA4 property / primary event is not configured: the conversion outcome will be DATA UNAVAILABLE until measurement is configured.');
  }

  const minRelativeEffect = input.minRelativeEffect ?? DEFAULT_MIN_RELATIVE_EFFECT;
  if (!(minRelativeEffect > 0 && minRelativeEffect < 10)) throw new AppError('VALIDATION_FAILED', 'minRelativeEffect must be > 0 (e.g. 0.1 for 10%).');
  const sample: SampleRequirements = {
    minImpressionsPerWindow: cfg.experiments.minImpressionsForEvaluation,
    minSessionsPerWindow: cfg.experiments.minSessionsForConversionEvaluation,
    minConvertingSessionsPerWindow: DEFAULT_MIN_CONVERTING_SESSIONS,
    minRelativeEffect,
    maxObservationDays: minObservationDays * MAX_OBSERVATION_MULTIPLIER,
    segmentKey,
    searchType,
    channelView,
  };
  // What is actually measured, recorded explicitly (A7-07): page-level totals, never query-level metrics.
  sample.measuredScope = {
    level: 'page',
    seoDataset: 'gsc_page_daily (current revision)',
    conversionDataset: 'ga4_landing_daily (current revision)',
    gscProperty: property ?? null,
    ga4Property: ga4Property ?? null,
    searchType,
    segmentKey,
    channelView,
    queryLevel: false,
  };

  const comparisonPages = gscWindow ? selectComparisonPages(ctx, page, gscWindow, input.comparisonPages ?? DEFAULT_COMPARISON_PAGES, undefined, { property, searchType, segmentKey }) : [];
  if (!comparisonPages.length) warnings.push('No unchanged comparison pages with Search Console data were found; evaluation will be a plain before/after comparison (weaker evidence).');

  const siteRow = ctx.db.get<{ v: number | null }>('SELECT active_config_version AS v FROM sites WHERE id = ?', [ctx.siteId]);
  const measurementConfig = measurementConfigOf(ctx, sample);
  const frozen: FrozenVersions = {
    promptVersion: rec.prompt_version,
    modelId: rec.model_id,
    scoringVersion: rec.scoring_version,
    measurementMethod: EVALUATION_METHOD,
    measurementMethodVersion: EVALUATION_METHOD_VERSION,
    configVersion: siteRow?.v ?? null,
    configHash: ctx.settings.configHash,
    artifactHashVersion: ARTIFACT_HASH_VERSION,
    measurementConfig,
    measurementConfigHash: measurementConfigHash(measurementConfig),
  };

  // The success criteria stored on the experiment are the page-level ones the evaluator measures.
  const recCriteria = rec.success_criteria?.trim() || null;
  const criteriaScopeMismatch = !!recCriteria && (QUERY_LEVEL_CRITERIA.test(recCriteria) || (!!rec.query && !segmentKey));
  const successCriteria = pageLevelSuccessCriteria(primaryMetric, outcomeKind, sample);
  if (criteriaScopeMismatch) {
    warnings.push(`The recommendation's success criteria are query-level ("${recCriteria!.slice(0, 160)}"), but the experiment measures page-level totals; the stored success criteria were rewritten to the page-level metric and the evaluation will record this caveat.`);
  }

  const tz = budgetTimeZone(cfg);
  const today = dateInZone(ctx.clock.now(), tz);
  const reviewDate = rec.review_date && rec.review_date > today ? rec.review_date : addDays(today, minObservationDays + PROPOSAL_REVIEW_BUFFER_DAYS);
  const rollbackPlan = input.rollbackPlan?.trim() || pickString(details, 'rollbackPlan') || defaultRollbackPlan(type);

  const evidence = {
    recommendationId: rec.id,
    opportunityId: rec.opportunity_id,
    query: rec.query,
    diagnosis: rec.diagnosis,
    /** What the evaluator measures (page level). */
    successCriteria,
    /** As written in the recommendation (may be query-level; see criteriaScopeMismatch). */
    recommendationSuccessCriteria: recCriteria,
    criteriaScopeMismatch,
    structuredChange: structured,
    recommendationEvidence: details.evidence ?? null,
    priorTests,
    retestReason,
    /** Critical-fix override intent (recorded now; the blocking annotation is written at mark-implemented). */
    freezeOverride: criticalFix
      ? { reason: criticalFix, heldBy: holders.map((h) => ({ experimentId: h.id, status: h.status })), requestedBy: input.requestedBy, requestedAt: ctx.clock.now().toISOString() }
      : null,
    isSynthetic: ctx.synthetic || !!gscBaseline?.anySynthetic || !!ga4Baseline?.anySynthetic,
  };
  const baseline = {
    label: 'OBSERVED',
    note: 'Trailing 4 complete weeks before the proposal; the evaluation baseline is recomputed from the weekday-matched window immediately before the actual implementation date.',
    gsc: gscWindow ? { window: gscWindow, property, searchType, segmentKey, metrics: gscBaseline } : { status: 'unavailable', reason: gscAmbiguity ?? 'no complete Search Console data' },
    ga4: ga4Window ? { window: ga4Window, propertyId: ga4Property, channelView, segmentKey, metrics: ga4Baseline } : { status: 'unavailable', reason: 'no complete GA4 data' },
    lowTraffic,
  };

  const id = newId('exp');
  const now = ctx.clock.now().toISOString();
  const summary = `Experiment ${id} (${type}) on ${targetUrl}: ${rec.proposed_change.trim()}`.slice(0, 600);

  let targetFingerprint: string | null = null;
  if (deps.targetChecker) {
    const fp = await deps.targetChecker.fingerprint(targetUrl);
    if (fp.ok) targetFingerprint = fp.fingerprint;
    else warnings.push(`Target could not be fingerprinted now (${fp.reason}); the pre-execution recheck will be unverifiable unless the approval is re-requested online before it is approved (\`approvals request experiment ${id}\`).`);
  }
  if (!input.sourceRevision) {
    warnings.push('The approval is not bound to a source revision, so a later site change would not invalidate it. Bind one with --revision, or the approver must acknowledge this with --accept-unbound-revision.');
  }

  const approval = ctx.db.transaction(() => {
    ctx.db.run(
      `INSERT INTO experiments (id, site_id, page_id, recommendation_id, type, hypothesis, evidence_json, proposed_change, change_hash, baseline_json, primary_metric, outcome_kind,
         guardrail_metrics_json, min_observation_days, sample_requirements_json, risks, rollback_plan, review_date, status, frozen_versions_json, comparison_pages_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)`,
      [
        id,
        ctx.siteId,
        page?.id ?? null,
        rec.id,
        type,
        rec.hypothesis!.trim(),
        JSON.stringify(evidence),
        rec.proposed_change!.trim(),
        changeHash,
        JSON.stringify(baseline),
        primaryMetric,
        outcomeKind,
        JSON.stringify(guardrails),
        minObservationDays,
        JSON.stringify(sample),
        risks,
        rollbackPlan,
        reviewDate,
        JSON.stringify(frozen),
        JSON.stringify(comparisonPages),
        now,
        now,
      ],
    );
    ctx.db.run('INSERT INTO experiment_changes (experiment_id, site_id, action_type, target_url, change_json, change_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      id,
      ctx.siteId,
      actionType,
      targetUrl,
      JSON.stringify(change),
      changeHash,
      now,
    ]);
    ctx.db.run('INSERT INTO experiment_status_history (experiment_id, site_id, from_status, to_status, actor, reason, at) VALUES (?, ?, NULL, ?, ?, ?, ?)', [
      id,
      ctx.siteId,
      'proposed',
      input.requestedBy,
      `proposed from recommendation ${rec.id}`,
      now,
    ]);
    recordAudit(ctx.db, {
      siteId: ctx.siteId,
      actor: input.requestedBy,
      eventType: 'experiment.proposed',
      subjectType: 'experiment',
      subjectId: id,
      details: { recommendationId: rec.id, type, changeHash, primaryMetric, outcomeKind, minObservationDays, priorTests: priorTests.length, retestReason },
      at: ctx.clock.now(),
    });
    if (criticalFix) {
      recordAudit(ctx.db, {
        siteId: ctx.siteId,
        actor: input.requestedBy,
        eventType: 'experiment.freeze_override_requested',
        subjectType: 'experiment',
        subjectId: id,
        details: { reason: criticalFix, heldBy: holders.map((h) => ({ id: h.id, status: h.status })), pageId: page?.id ?? null, targetUrl },
        at: ctx.clock.now(),
      });
    }
    return gate.request({
      siteId: ctx.siteId,
      actionType,
      target: targetUrl,
      subjectType: 'experiment',
      subjectId: id,
      artifactHash: changeHash,
      sourceRevision: input.sourceRevision ?? null,
      summary,
      payload: { change, hypothesis: rec.hypothesis, primaryMetric, outcomeKind, minObservationDays, rollbackPlan, targetFingerprint, successCriteria, measuredScope: sample.measuredScope },
      requestedBy: input.requestedBy,
      ...(input.approvalTtlHours ? { ttlHours: input.approvalTtlHours } : {}),
    });
  });
  const experiment = getExperiment(ctx.db, ctx.siteId, id);
  if (criticalFix) {
    warnings.push(
      `Freeze override requested for ${describeHolders(holders)} (reason recorded in the experiment evidence). Nothing is flagged yet: when this change is actually deployed, mark-implemented records a critical_fix annotation at the real deployment time, which flags the running experiment(s).`,
    );
  }
  warnings.push(`Approval ${approval.id} is pending. A human reviews the exact change with \`approvals show ${approval.id}\` and approves it with \`approvals approve ${approval.id} --as <name> --confirm <hash prefix printed by approvals show>\`.`);
  return { experiment, approval, warnings };
}
