import { AppError } from '../core/errors.js';
import { parseJson, type Db } from '../database/db.js';
import {
  ACTIVE_STATUSES,
  type ComparisonPage,
  type ExperimentChange,
  type ExperimentRecord,
  type ExperimentStatus,
  type FrozenVersions,
  type Guardrail,
  type MetricName,
  type OutcomeKind,
  type SampleRequirements,
} from './types.js';

/**
 * The risks text earlier versions stored when neither the recommendation nor
 * the proposer stated risks. Such an experiment cannot be approved (see
 * risksStated); it is re-proposed with --risks instead.
 */
export const RISKS_NOT_STATED_PLACEHOLDER = 'Not stated by the recommendation (see warnings).';

/** True when an experiment's risks are actually stated (not empty and not the legacy placeholder). */
export function risksStated(risks: string | null | undefined): boolean {
  const t = (risks ?? '').trim();
  return t.length > 0 && t !== RISKS_NOT_STATED_PLACEHOLDER;
}

export interface ExperimentRow {
  id: string;
  site_id: string;
  page_id: string | null;
  recommendation_id: string | null;
  type: string;
  hypothesis: string;
  evidence_json: string;
  proposed_change: string;
  change_hash: string;
  baseline_json: string | null;
  primary_metric: string;
  outcome_kind: OutcomeKind;
  guardrail_metrics_json: string;
  min_observation_days: number;
  sample_requirements_json: string;
  risks: string;
  rollback_plan: string;
  review_date: string | null;
  status: ExperimentStatus;
  frozen_versions_json: string | null;
  implemented_at: string | null;
  source_revision: string | null;
  before_snapshot_ref: string | null;
  after_snapshot_ref: string | null;
  observation_start: string | null;
  observation_end: string | null;
  comparison_pages_json: string | null;
  outcome_json: string | null;
  approval_id: string | null;
  created_at: string;
  updated_at: string;
}

const DEFAULT_SAMPLE: SampleRequirements = {
  minImpressionsPerWindow: 0,
  minSessionsPerWindow: 0,
  minConvertingSessionsPerWindow: 0,
  minRelativeEffect: 0.1,
  maxObservationDays: 84,
  segmentKey: '',
  searchType: 'web',
  channelView: 'google_organic',
};

export function toExperiment(r: ExperimentRow): ExperimentRecord {
  return {
    id: r.id,
    siteId: r.site_id,
    pageId: r.page_id,
    recommendationId: r.recommendation_id,
    type: r.type,
    hypothesis: r.hypothesis,
    evidence: parseJson<Record<string, unknown>>(r.evidence_json, {}),
    proposedChange: r.proposed_change,
    changeHash: r.change_hash,
    baseline: parseJson<Record<string, unknown> | null>(r.baseline_json, null),
    primaryMetric: r.primary_metric as MetricName,
    outcomeKind: r.outcome_kind,
    guardrails: parseJson<Guardrail[]>(r.guardrail_metrics_json, []),
    minObservationDays: r.min_observation_days,
    sampleRequirements: { ...DEFAULT_SAMPLE, ...parseJson<Partial<SampleRequirements>>(r.sample_requirements_json, {}) },
    risks: r.risks,
    rollbackPlan: r.rollback_plan,
    reviewDate: r.review_date,
    status: r.status,
    frozenVersions: parseJson<FrozenVersions | null>(r.frozen_versions_json, null),
    implementedAt: r.implemented_at,
    sourceRevision: r.source_revision,
    beforeSnapshotRef: r.before_snapshot_ref,
    afterSnapshotRef: r.after_snapshot_ref,
    observationStart: r.observation_start,
    observationEnd: r.observation_end,
    comparisonPages: parseJson<ComparisonPage[]>(r.comparison_pages_json, []),
    outcome: parseJson<Record<string, unknown> | null>(r.outcome_json, null),
    approvalId: r.approval_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function findExperiment(db: Db, siteId: string, id: string): ExperimentRecord | null {
  const r = db.get<ExperimentRow>('SELECT * FROM experiments WHERE site_id = ? AND id = ?', [siteId, id]);
  return r ? toExperiment(r) : null;
}

export function getExperiment(db: Db, siteId: string, id: string): ExperimentRecord {
  const e = findExperiment(db, siteId, id);
  if (!e) throw new AppError('NOT_FOUND', `Experiment ${id} not found for site ${siteId}.`, { hint: 'List experiments with `experiments list`.' });
  return e;
}

export function listExperiments(db: Db, siteId: string, opts: { statuses?: readonly ExperimentStatus[]; pageId?: string; limit?: number } = {}): ExperimentRecord[] {
  const where = ['site_id = ?'];
  const params: unknown[] = [siteId];
  if (opts.statuses?.length) {
    where.push(`status IN (${opts.statuses.map(() => '?').join(', ')})`);
    params.push(...opts.statuses);
  }
  if (opts.pageId) {
    where.push('page_id = ?');
    params.push(opts.pageId);
  }
  params.push(opts.limit ?? 500);
  return db.all<ExperimentRow>(`SELECT * FROM experiments WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`, params).map(toExperiment);
}

export function getExperimentChange(db: Db, siteId: string, experimentId: string): ExperimentChange | null {
  const r = db.get<{ action_type: string; target_url: string; change_json: string; change_hash: string }>(
    'SELECT action_type, target_url, change_json, change_hash FROM experiment_changes WHERE site_id = ? AND experiment_id = ?',
    [siteId, experimentId],
  );
  return r ? { actionType: r.action_type, targetUrl: r.target_url, change: parseJson<Record<string, unknown>>(r.change_json, {}), changeHash: r.change_hash } : null;
}

/**
 * Experiments on a page that are approved, awaiting implementation, or observing.
 * @deprecated For the one-change-per-page rule use `pageFreeze` (./freeze.ts),
 * which also counts proposed experiments and matches by target URL.
 */
export function activeExperimentsOnPage(db: Db, siteId: string, pageId: string, excludeId?: string): ExperimentRecord[] {
  return db
    .all<ExperimentRow>(
      `SELECT * FROM experiments WHERE site_id = ? AND page_id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')}) AND id != ? ORDER BY created_at`,
      [siteId, pageId, ...ACTIVE_STATUSES, excludeId ?? ''],
    )
    .map(toExperiment);
}

export function statusHistory(db: Db, siteId: string, experimentId: string): Array<{ from: string | null; to: string; actor: string; reason: string | null; at: string }> {
  return db
    .all<{ from_status: string | null; to_status: string; actor: string; reason: string | null; at: string }>(
      'SELECT from_status, to_status, actor, reason, at FROM experiment_status_history WHERE site_id = ? AND experiment_id = ? ORDER BY id',
      [siteId, experimentId],
    )
    .map((h) => ({ from: h.from_status, to: h.to_status, actor: h.actor, reason: h.reason, at: h.at }));
}

export interface EvaluationRow {
  id: string;
  experiment_id: string;
  site_id: string;
  sequence: number;
  evaluated_at: string;
  result: string;
  concluded: number;
  after_conclusion: number;
  reasons_json: string;
  windows_json: string | null;
  seo_json: string | null;
  conversion_json: string | null;
  guardrails_json: string | null;
  interference_json: string | null;
  significance_json: string;
  method: string;
  method_version: string;
  frozen_versions_json: string | null;
  is_synthetic: number;
  actor: string;
}

export function listEvaluations(db: Db, siteId: string, experimentId: string): Array<Record<string, unknown>> {
  return db
    .all<EvaluationRow>('SELECT * FROM experiment_evaluations WHERE site_id = ? AND experiment_id = ? ORDER BY sequence', [siteId, experimentId])
    .map((e) => ({
      id: e.id,
      sequence: e.sequence,
      evaluatedAt: e.evaluated_at,
      result: e.result,
      concluded: e.concluded === 1,
      afterConclusion: e.after_conclusion === 1,
      reasons: parseJson(e.reasons_json, []),
      windows: parseJson(e.windows_json, null),
      seo: parseJson(e.seo_json, null),
      conversion: parseJson(e.conversion_json, null),
      guardrails: parseJson(e.guardrails_json, null),
      interference: parseJson(e.interference_json, null),
      significance: parseJson(e.significance_json, null),
      method: e.method,
      methodVersion: e.method_version,
      isSynthetic: e.is_synthetic === 1,
      actor: e.actor,
    }));
}

export interface PageRow {
  id: string;
  site_id: string;
  url: string;
  host: string;
  path: string;
  page_type: string | null;
  is_protected: number;
}

export function getPage(db: Db, siteId: string, pageId: string): PageRow | null {
  return db.get<PageRow>('SELECT id, site_id, url, host, path, page_type, is_protected FROM pages WHERE site_id = ? AND id = ?', [siteId, pageId]) ?? null;
}

/** Find a page by id or exact normalized URL. */
export function findPageByRef(db: Db, siteId: string, ref: string): PageRow | null {
  return (
    db.get<PageRow>('SELECT id, site_id, url, host, path, page_type, is_protected FROM pages WHERE site_id = ? AND (id = ? OR url = ?) LIMIT 1', [siteId, ref, ref]) ??
    db.get<PageRow>(
      `SELECT p.id, p.site_id, p.url, p.host, p.path, p.page_type, p.is_protected FROM url_aliases a JOIN pages p ON p.id = a.page_id
       WHERE a.site_id = ? AND a.alias_url = ? AND a.confidence = 'established' LIMIT 1`,
      [siteId, ref],
    ) ??
    null
  );
}
