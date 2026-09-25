import { hashObject } from '../core/hash.js';
import { newId } from '../core/ids.js';
import type { ClaimLabel } from '../core/modes.js';
import { addDays, type IsoDate } from '../core/time.js';
import { parseJson, type Db } from '../database/db.js';
import type { MemoryRetriever, MemorySourceType, RetrievalResult } from '../memory/types.js';
import { normalizeQuery } from '../router/intent.js';
import { reasonInputs, type ReasonCode, type ReasonInputs, type Route, type RouteDecision } from '../router/types.js';
import type { PageAnalysis } from './page-analysis.js';

/**
 * Recommendation assembly: ONE primary action, or an explicit no-action /
 * repair-measurement / collect-more-evidence decision, plus at most three
 * secondary observations. Previous experiments, owner decisions, rejected
 * recommendations, and learnings are consulted first so rejected or
 * already-tested ideas are not re-proposed and active experiments are not
 * stacked (page experiments, site-wide experiments, and experiments that use
 * the page as a comparison page). Every statement carries a claim label.
 *
 * Synthetic data (fixture/demo rows, or a synthetic context) is never
 * presented as a real measurement: its figures keep the OBSERVED label with
 * the synthetic flag and a [SYNTHETIC] marker (as report sections label them:
 * "OBSERVED [SYNTHETIC]"), never a value under DATA_UNAVAILABLE, and their
 * sources get source_type 'fixture' / trust_class 'synthetic'.
 */

export const RECOMMEND_VERSION = 'recommend@1.4.0';
export const MAX_SECONDARY = 3;

export type RecommendationKind = 'primary' | 'secondary' | 'no_action' | 'repair_measurement' | 'collect_more_evidence';

export interface CandidateOpportunity {
  id: string | null;
  route: Route;
  pageId: string | null;
  url: string | null;
  query: string | null;
  isBranded: boolean | null;
  score: number | null;
  scoringVersion: string | null;
  rawCounts: Record<string, unknown>;
  evidenceQuality: number | null;
  reasons: ReasonCode[];
  isProtected: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  /** Derived from synthetic (fixture/demo) data: never presented as observed. */
  synthetic?: boolean;
}

export interface ClaimDraft {
  key: string;
  text: string;
  label: ClaimLabel;
  support: 'supports' | 'contradicts' | 'context' | 'missing';
  /** The claim rests on synthetic (fixture/demo) data. */
  synthetic?: boolean;
  evidence?: {
    /** competitor_page: a comparison of crawled pages (third-party content, scraped_untrusted); llm_output: model synthesis (model_generated). */
    sourceType: 'gsc' | 'ga4' | 'crawl' | 'url_inspection' | 'competitor_page' | 'llm_output';
    url: string | null;
    summary: string;
    value: unknown;
    locator: Record<string, unknown>;
    dateRange: { start: string | null; end: string | null };
    synthetic?: boolean;
    /** Evidence kind (default 'metric'). */
    kind?: 'metric' | 'observation' | 'excerpt';
  };
}

export interface RecommendationDraft {
  kind: RecommendationKind;
  actionType: string;
  title: string;
  opportunityId: string | null;
  pageId: string | null;
  url: string | null;
  query: string | null;
  route: Route | null;
  diagnosis: string;
  proposedChange: string | null;
  hypothesis: string | null;
  successCriteria: string | null;
  risks: string | null;
  reviewDate: IsoDate | null;
  scoringVersion: string | null;
  details: Record<string, unknown>;
  claims: ClaimDraft[];
}

/**
 * What an owner decision is about, resolved from its subject to the fields a
 * candidate is compared on. A decision on a recommendation or opportunity
 * carries that proposal's page, query, and action; a decision on a query or
 * keyword carries the normalized query; a site-wide decision (for example a
 * subject-less entry of `01 Business/Owner Decisions.md`) is knowledge only
 * and never excludes a specific candidate.
 */
export interface DecisionTarget {
  pageId: string | null;
  url: string | null;
  /** Normalized query (router `normalizeQuery`). */
  query: string | null;
  /** Recommendation action type (ACTION_TYPE); null = any action on the subject. */
  actionType: string | null;
  opportunityId: string | null;
  /** Experiment type of a decided experiment (matched through the similar-experiment table). */
  experimentType: string | null;
  siteWide: boolean;
}

export interface PriorContext {
  /** pageId null = site-wide/template experiment. comparisonPageIds = its comparison (control) pages. */
  activeExperiments: Array<{ id: string; pageId: string | null; type: string; status: string; comparisonPageIds?: string[] }>;
  /** query: the query of the recommendation the experiment came from, when known. */
  concludedExperiments: Array<{ id: string; pageId: string | null; type: string; status: string; updatedAt: string; query?: string | null }>;
  /** target: the resolved subject (absent on hand-built contexts: the raw subject id is then compared with the candidate's opportunity id, page id, and URL). */
  decisions: Array<{ id: string; subjectType: string; subjectId: string; decision: string; reason: string | null; decidedAt: string; decidedBy?: string; vaultPath?: string | null; target?: DecisionTarget }>;
  rejectedRecommendations: Array<{ id: string; pageId: string | null; actionType: string; title: string; updatedAt: string; query?: string | null; opportunityId?: string | null }>;
  learnings: Array<{ id: string; statement: string; scope: string; status: string }>;
  /**
   * Memory retrieval before recommending. `detail` explains the retrieval
   * mode: `detailKind` 'policy' is a deliberate choice (for example full-text
   * only by policy: no implicit query-embedding spend), 'degraded' a fault,
   * 'error' a failed search. `searched` lists the source types asked for.
   */
  memory: {
    status: 'not_configured' | 'ok' | 'degraded' | 'error';
    detail?: string;
    detailKind?: 'policy' | 'degraded' | 'error';
    method?: 'hybrid' | 'fts_only';
    searched?: string[];
    items: Array<{ title: string; sourceType: string; recordStatus: string | null; sourceRef: string; excerpt: string; trustClass?: string }>;
  };
}

export interface RecommendationSet {
  version: string;
  siteId: string;
  period: { start: string | null; end: string | null };
  primary: RecommendationDraft;
  secondary: RecommendationDraft[];
  excluded: Array<{ opportunityId: string | null; pageId: string | null; route: Route; reason: string }>;
  priorContext: PriorContext;
  /** Any part rests on synthetic (fixture/demo) data. */
  synthetic: boolean;
}

/**
 * Deep SERP/competitor analysis of one (query, page) from the weekly `compare`
 * stage (competitive_comparisons). Attached to the primary recommendation when
 * it concerns the compared page: what our page does better, observed gaps
 * (never ranking causes), and caveats become labeled claims.
 */
export interface ComparisonForRecommendation {
  /** competitive_comparisons row id (null when not persisted, e.g. a dry run). */
  id: string | null;
  query: string;
  pageId: string | null;
  url: string;
  opportunityId: string | null;
  competitorsCompared: number;
  competitorsInaccessible: number;
  ourAdvantages: string[];
  gaps: string[];
  caveats: string[];
  synthesis: { status: 'ok' | 'skipped' | 'failed'; reason: string | null; summary?: string | null; model?: string | null; promptVersion?: string | null };
  serp: { snapshotId: string | null; collectedAt: string | null; locationCode: number | null; languageCode: string | null; device: string | null } | null;
  /** Latest fetch time of the compared pages (ISO), when known. */
  fetchedAt?: string | null;
  synthetic: boolean;
}

export const ACTION_TYPE: Record<Route, string> = {
  INVALID_OR_INCOMPLETE_DATA: 'repair_measurement',
  TECHNICAL_BLOCKER: 'technical_investigation',
  EXPERIMENT_ACTIVE: 'none',
  HEALTHY: 'none',
  RANKING_OPPORTUNITY: 'targeted_seo_audit',
  CTR_OPPORTUNITY: 'title_snippet_investigation',
  CONVERSION_OPPORTUNITY: 'conversion_path_review',
  DECLINE: 'decline_investigation',
  CONTENT_OPPORTUNITY: 'content_overlap_check',
  INDEXING_UNKNOWN: 'inspect_indexing',
  LOW_DATA: 'collect_more_evidence',
  IRRELEVANT: 'archive',
  UNSURE: 'human_review',
};

/** Experiment types considered "the same idea" for each route (no repeated testing until a favorable result appears). */
const SIMILAR_EXPERIMENT_TYPES: Partial<Record<Route, string[]>> = {
  RANKING_OPPORTUNITY: ['content_section', 'title_meta', 'internal_links'],
  CTR_OPPORTUNITY: ['title_meta'],
  CONVERSION_OPPORTUNITY: ['content_section', 'other'],
  CONTENT_OPPORTUNITY: ['new_page', 'content_section'],
};

const OPTIMIZATION_ROUTES: ReadonlySet<Route> = new Set(['RANKING_OPPORTUNITY', 'CTR_OPPORTUNITY', 'CONVERSION_OPPORTUNITY', 'DECLINE', 'CONTENT_OPPORTUNITY', 'INDEXING_UNKNOWN']);
/**
 * Diagnostic routes exempt from the minimum-evidence rule: their action is an
 * investigation that changes nothing (a free URL Inspection, a decline
 * investigation), and waiting cannot produce the missing evidence (an
 * unindexed page never gains impressions).
 */
export const EVIDENCE_EXEMPT_ROUTES: ReadonlySet<Route> = new Set(['INDEXING_UNKNOWN', 'DECLINE']);
/** Routes whose primary recommendation can carry a deep SERP/competitor comparison. */
const COMPARISON_ROUTES: ReadonlySet<Route> = new Set(['RANKING_OPPORTUNITY', 'CTR_OPPORTUNITY', 'CONVERSION_OPPORTUNITY', 'DECLINE', 'CONTENT_OPPORTUNITY']);
/** Routes whose action changes a page (investigations and inspections do not). */
const CHANGE_ROUTES: ReadonlySet<Route> = new Set(['RANKING_OPPORTUNITY', 'CTR_OPPORTUNITY', 'CONVERSION_OPPORTUNITY', 'CONTENT_OPPORTUNITY']);

/** Structured owner-decision vocabulary that excludes a subject from recommendations. */
export const REJECTING_DECISIONS: ReadonlySet<string> = new Set(['reject', 'rejected', 'decline', 'declined', 'deny', 'denied', 'dismiss', 'dismissed', 'defer', 'deferred', 'skip', 'skipped', 'no_action', 'no-action', 'no action', 'wont_do', "won't do", 'not_now', 'not now']);
const REJECTING_LEAD = /^(rejected|reject|declined|denied|deny|dismissed|dismiss|deferred|defer|skipped|skip|no[_ -]action|won'?t[_ -]do|won'?t|not[_ -]now)(?![\p{L}\p{N}])/iu;

/**
 * An owner decision excludes a subject when it IS a rejecting decision
 * ("rejected", "no_action", "deferred", ...) or its free text STARTS with one
 * ("rejected: owner prefers the current copy"). Words later in the sentence
 * never count: "approved: investigate the traffic decline" is not a rejection.
 */
export function isRejectingDecision(decision: string): boolean {
  const d = decision.trim().toLowerCase();
  return REJECTING_DECISIONS.has(d) || REJECTING_LEAD.test(d);
}

export function candidateFromAnalysis(a: PageAnalysis, opportunityId: string | null = null): CandidateOpportunity {
  return {
    id: opportunityId,
    route: a.decision.route,
    pageId: a.page.id,
    url: a.page.url,
    query: a.focusQuery,
    isBranded: a.score ? (a.score.segment === 'unknown' ? null : a.score.segment === 'branded') : null,
    score: a.score?.score ?? null,
    scoringVersion: a.score?.version ?? null,
    rawCounts: a.score?.rawCounts ?? {},
    evidenceQuality: a.score?.components.evidence.value ?? null,
    reasons: a.decision.reasons,
    isProtected: a.page.isProtected,
    periodStart: a.decision.period?.start ?? null,
    periodEnd: a.decision.period?.end ?? null,
    synthetic: a.bundle.synthetic,
  };
}

/**
 * Candidate opportunities from the database for the latest (or given) period.
 * `ids` restricts them to specific opportunities (e.g. those persisted by the
 * current routing run), so stale rows of earlier runs are never recommended.
 */
export function loadCandidates(db: Db, siteId: string, period?: { start: string; end: string }, opts: { ids?: readonly string[] } = {}): CandidateOpportunity[] {
  if (opts.ids && opts.ids.length === 0) return [];
  const p =
    period ??
    db.get<{ start: string | null; end: string | null }>(
      "SELECT period_start AS start, period_end AS end FROM opportunities WHERE site_id = ? AND status IN ('candidate', 'shortlisted') ORDER BY period_end DESC, updated_at DESC LIMIT 1",
      [siteId],
    );
  if (!p || !p.start || !p.end) return [];
  const rows = db.all<{
    id: string;
    route: Route;
    page_id: string | null;
    query: string | null;
    is_branded: number | null;
    score: number | null;
    scoring_version: string | null;
    raw_counts_json: string | null;
    score_components_json: string | null;
    period_start: string | null;
    period_end: string | null;
    url: string | null;
    is_protected: number | null;
    reason_codes_json: string | null;
  }>(
    `SELECT o.id, o.route, o.page_id, o.query, o.is_branded, o.score, o.scoring_version, o.raw_counts_json, o.score_components_json, o.period_start, o.period_end,
            p.url, p.is_protected, rd.reason_codes_json
       FROM opportunities o
       LEFT JOIN pages p ON p.id = o.page_id
       LEFT JOIN route_decisions rd ON rd.id = o.route_decision_id
      WHERE o.site_id = ? AND o.status IN ('candidate', 'shortlisted') AND o.period_start = ? AND o.period_end = ?`,
    [siteId, p.start, p.end],
  );
  const wanted = opts.ids ? new Set(opts.ids) : null;
  return rows.filter((r) => !wanted || wanted.has(r.id)).map((r) => {
    const comps = parseJson<{ components?: { evidence?: { value?: number } } }>(r.score_components_json, {});
    const rawCounts = parseJson<Record<string, unknown>>(r.raw_counts_json, {});
    return {
      id: r.id,
      route: r.route,
      pageId: r.page_id,
      url: r.url,
      query: r.query,
      isBranded: r.is_branded === null ? null : r.is_branded === 1,
      score: r.score,
      scoringVersion: r.scoring_version,
      rawCounts,
      evidenceQuality: comps.components?.evidence?.value ?? null,
      reasons: parseJson<Array<ReasonCode & { kind?: string }>>(r.reason_codes_json, []).filter((x) => x.kind !== 'note'),
      isProtected: r.is_protected === 1,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      synthetic: rawCounts.dataOrigin === 'SYNTHETIC',
    };
  });
}

/** Memory source types searched for the history of earlier proposals, tests, and decisions. */
export const PRIOR_HISTORY_SOURCE_TYPES: readonly MemorySourceType[] = ['rejected_proposal', 'experiment_summary', 'decision', 'approved_learning'];
/**
 * Owner knowledge searched separately so it is never crowded out by history:
 * business notes (the vault's `01 Business/**` notes, including the standing
 * entries of `01 Business/Owner Decisions.md`; owner-approved when imported by
 * the business-note sync) and recorded decisions.
 */
export const OWNER_KNOWLEDGE_SOURCE_TYPES: readonly MemorySourceType[] = ['business_note', 'decision'];
export const DEFAULT_PRIOR_MEMORY_QUERY = 'previous recommendations experiments decisions';
const CONCLUDED_STATUSES = ['positive', 'negative', 'inconclusive', 'cancelled'] as const;

const NO_TARGET: DecisionTarget = { pageId: null, url: null, query: null, actionType: null, opportunityId: null, experimentType: null, siteWide: false };

function normQuery(q: string | null | undefined): string | null {
  if (!q) return null;
  return normalizeQuery(q) || null;
}

function stripObservation(actionType: string): string {
  return actionType.replace(/^observation:/, '');
}

/**
 * The label a recommendation is compared on. A revision recorded by
 * `experiments specify-change` is typed by its concrete change (e.g.
 * title_meta_change); the label of the proposal it was specified from is kept
 * in details_json.originalActionType, and that is what a later candidate for
 * the same idea carries.
 */
function comparableActionType(actionType: string, detailsJson: string | null): string {
  const d = parseJson<unknown>(detailsJson, null);
  const original = d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>).originalActionType : undefined;
  return stripObservation(typeof original === 'string' && original.trim() ? original : actionType);
}

/**
 * Resolve a decision subject to what candidates are compared on (site-scoped
 * lookups). Proposals (recommendation, opportunity) are matched on their page
 * and action (their query when they have no page), so an idea the owner
 * rejected stays rejected when a later run proposes it again under a new id.
 * Returns undefined for subject types that concern no candidate (drafts,
 * briefs, batches, learnings, ...) or subjects that no longer exist.
 */
export function resolveDecisionTarget(db: Db, siteId: string, subjectType: string, subjectId: string): DecisionTarget | undefined {
  switch (subjectType) {
    case 'page':
      return { ...NO_TARGET, pageId: subjectId };
    case 'url':
      return { ...NO_TARGET, url: subjectId };
    case 'query':
      return normQuery(subjectId) ? { ...NO_TARGET, query: normQuery(subjectId) } : undefined;
    case 'keyword': {
      const k = db.get<{ normalized: string }>('SELECT normalized FROM keywords WHERE site_id = ? AND id = ?', [siteId, subjectId]);
      return k ? { ...NO_TARGET, query: normQuery(k.normalized) } : undefined;
    }
    case 'opportunity': {
      const o = db.get<{ page_id: string | null; query: string | null; route: string }>('SELECT page_id, query, route FROM opportunities WHERE site_id = ? AND id = ?', [siteId, subjectId]);
      if (!o) return { ...NO_TARGET, opportunityId: subjectId };
      return { ...NO_TARGET, opportunityId: subjectId, pageId: o.page_id, query: o.page_id ? null : normQuery(o.query), actionType: ACTION_TYPE[o.route as Route] ?? null };
    }
    case 'recommendation': {
      const r = db.get<{ page_id: string | null; query: string | null; action_type: string; opportunity_id: string | null; details_json: string | null }>(
        'SELECT page_id, query, action_type, opportunity_id, details_json FROM recommendations WHERE site_id = ? AND id = ?',
        [siteId, subjectId],
      );
      if (!r) return undefined;
      return { ...NO_TARGET, opportunityId: r.opportunity_id, pageId: r.page_id, query: r.page_id ? null : normQuery(r.query), actionType: comparableActionType(r.action_type, r.details_json) };
    }
    case 'experiment': {
      const e = db.get<{ page_id: string | null; type: string }>('SELECT page_id, type FROM experiments WHERE site_id = ? AND id = ?', [siteId, subjectId]);
      return e?.page_id ? { ...NO_TARGET, pageId: e.page_id, experimentType: e.type } : undefined;
    }
    case 'site':
      return { ...NO_TARGET, siteWide: true };
    default:
      return undefined;
  }
}

type DecisionRow = { id: string; subject_type: string; subject_id: string; decision: string; reason: string | null; decided_by: string; decided_at: string; vault_path: string | null };
const DECISION_COLUMNS = 'id, subject_type, subject_id, decision, reason, decided_by, decided_at, vault_path';

function toDecision(db: Db, siteId: string, d: DecisionRow): PriorContext['decisions'][number] {
  const target = resolveDecisionTarget(db, siteId, d.subject_type, d.subject_id);
  return { id: d.id, subjectType: d.subject_type, subjectId: d.subject_id, decision: d.decision, reason: d.reason, decidedAt: d.decided_at, decidedBy: d.decided_by, vaultPath: d.vault_path, ...(target ? { target } : {}) };
}

type ConcludedRow = { id: string; page_id: string | null; type: string; status: string; updated_at: string; query: string | null };
const CONCLUDED_SELECT = `SELECT e.id, e.page_id, e.type, e.status, e.updated_at, r.query
       FROM experiments e LEFT JOIN recommendations r ON r.id = e.recommendation_id AND r.site_id = e.site_id`;

type RejectedRow = { id: string; page_id: string | null; action_type: string; title: string; updated_at: string; query: string | null; opportunity_id: string | null; details_json: string | null };
const REJECTED_COLUMNS = 'id, page_id, action_type, title, updated_at, query, opportunity_id, details_json';

/**
 * Prior context consulted BEFORE recommending (spec section 19): active and
 * concluded experiments, owner decisions (page, URL, query/keyword,
 * opportunity, recommendation, and experiment subjects are resolved; site-wide
 * decisions are knowledge only), rejected recommendations, learnings, and a
 * memory search of the history (rejected proposals, experiment summaries,
 * decisions, approved learnings) and of the owner's knowledge (business notes,
 * decisions). Standing owner decisions kept in a vault note apply whatever
 * their age; other records use the lookback window. A rejected proposal,
 * concluded experiment, or decision that memory retrieval surfaces from
 * outside the window is re-read from SQLite (the source of truth) and
 * consulted too. Degraded, failing, or policy-limited retrieval is reported
 * with its detail, never hidden.
 */
export async function loadPriorContext(db: Db, siteId: string, opts: { today: IsoDate; lookbackDays?: number; memory?: MemoryRetriever; memoryQuery?: string }): Promise<PriorContext> {
  const since = addDays(opts.today, -(opts.lookbackDays ?? 180));
  const activeExperiments = db
    .all<{ id: string; page_id: string | null; type: string; status: string; comparison_pages_json: string | null }>(
      "SELECT id, page_id, type, status, comparison_pages_json FROM experiments WHERE site_id = ? AND status IN ('observing', 'approved', 'awaiting_implementation')",
      [siteId],
    )
    .map((e) => ({ id: e.id, pageId: e.page_id, type: e.type, status: e.status, comparisonPageIds: comparisonIds(e.comparison_pages_json) }));
  const toConcluded = (e: ConcludedRow) => ({ id: e.id, pageId: e.page_id, type: e.type, status: e.status, updatedAt: e.updated_at, query: e.query });
  const concludedExperiments = db
    .all<ConcludedRow>(`${CONCLUDED_SELECT} WHERE e.site_id = ? AND e.status IN (${CONCLUDED_STATUSES.map(() => '?').join(', ')}) AND e.updated_at >= ? ORDER BY e.updated_at DESC`, [siteId, ...CONCLUDED_STATUSES, since])
    .map(toConcluded);
  const decisions = db
    .all<DecisionRow>(`SELECT ${DECISION_COLUMNS} FROM decisions WHERE site_id = ? AND (decided_at >= ? OR vault_path IS NOT NULL) ORDER BY decided_at DESC LIMIT 200`, [siteId, since])
    .map((d) => toDecision(db, siteId, d));
  const toRejected = (r: RejectedRow) => ({ id: r.id, pageId: r.page_id, actionType: comparableActionType(r.action_type, r.details_json), title: r.title, updatedAt: r.updated_at, query: r.query, opportunityId: r.opportunity_id });
  const rejectedRecommendations = db
    .all<RejectedRow>(`SELECT ${REJECTED_COLUMNS} FROM recommendations WHERE site_id = ? AND status = 'rejected' AND updated_at >= ? ORDER BY updated_at DESC`, [siteId, since])
    .map(toRejected);
  const learnings = db
    .all<{ id: string; statement: string; scope: string; status: string }>("SELECT id, statement, scope, status FROM learnings WHERE site_id = ? AND status IN ('approved', 'proposed') ORDER BY updated_at DESC LIMIT 20", [siteId])
    .map((l) => ({ id: l.id, statement: l.statement, scope: l.scope, status: l.status }));
  const memory = opts.memory ? await searchPriorMemory(opts.memory, siteId, opts.memoryQuery ?? DEFAULT_PRIOR_MEMORY_QUERY) : ({ status: 'not_configured', items: [] } as PriorContext['memory']);

  // Records surfaced by memory retrieval (outside the lookback window) are consulted too, as re-read from SQLite.
  for (const item of memory.items) {
    const [kind, id] = splitRef(item.sourceRef);
    if (!id) continue;
    if (item.sourceType === 'rejected_proposal' && kind === 'recommendation' && !rejectedRecommendations.some((r) => r.id === id)) {
      const row = db.get<RejectedRow>(`SELECT ${REJECTED_COLUMNS} FROM recommendations WHERE site_id = ? AND id = ? AND status = 'rejected'`, [siteId, id]);
      if (row) rejectedRecommendations.push(toRejected(row));
    } else if (item.sourceType === 'experiment_summary' && kind === 'experiment' && !concludedExperiments.some((e) => e.id === id)) {
      const row = db.get<ConcludedRow>(`${CONCLUDED_SELECT} WHERE e.site_id = ? AND e.id = ? AND e.status IN (${CONCLUDED_STATUSES.map(() => '?').join(', ')})`, [siteId, id, ...CONCLUDED_STATUSES]);
      if (row) concludedExperiments.push(toConcluded(row));
    } else if (item.sourceType === 'decision' && kind === 'decision' && !decisions.some((d) => d.id === id)) {
      const row = db.get<DecisionRow>(`SELECT ${DECISION_COLUMNS} FROM decisions WHERE site_id = ? AND id = ?`, [siteId, id]);
      if (row) decisions.push(toDecision(db, siteId, row));
    }
  }
  return { activeExperiments, concludedExperiments, decisions, rejectedRecommendations, learnings, memory };
}

function splitRef(ref: string): [string, string | null] {
  const i = ref.indexOf(':');
  return i > 0 ? [ref.slice(0, i), ref.slice(i + 1) || null] : [ref, null];
}

/**
 * Two memory searches: the history (rejected proposals, experiment summaries,
 * decisions, approved learnings) and the owner's knowledge (business notes,
 * decisions). Rejected and negative items keep their record status so they
 * are never mistaken for recommendations.
 */
async function searchPriorMemory(retriever: MemoryRetriever, siteId: string, text: string): Promise<PriorContext['memory']> {
  const searches: Array<{ sourceTypes: MemorySourceType[]; text: string; limit: number }> = [
    { sourceTypes: [...PRIOR_HISTORY_SOURCE_TYPES], text, limit: 8 },
    { sourceTypes: [...OWNER_KNOWLEDGE_SOURCE_TYPES], text: `${text} owner business decision`, limit: 6 },
  ];
  const results: RetrievalResult[] = [];
  const errors: string[] = [];
  for (const s of searches) {
    try {
      results.push(await retriever.search({ siteId, text: s.text, sourceTypes: s.sourceTypes, limit: s.limit }));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  const searched = [...new Set(searches.flatMap((s) => s.sourceTypes))];
  const uniq = (xs: Array<string | undefined>) => [...new Set(xs.filter((x): x is string => !!x && !!x.trim()))];
  if (!results.length) return { status: 'error', detail: uniq(errors).join('; '), detailKind: 'error', searched, items: [] };
  const seen = new Set<string>();
  const items: PriorContext['memory']['items'] = [];
  for (const r of results) {
    for (const c of r.chunks) {
      if (seen.has(c.chunkId)) continue;
      seen.add(c.chunkId);
      items.push({ title: c.title, sourceType: c.sourceType, recordStatus: c.recordStatus, sourceRef: c.sourceRef, excerpt: c.text.slice(0, 300), trustClass: c.trustClass });
    }
  }
  const method = results.every((r) => r.method === 'hybrid') ? ('hybrid' as const) : ('fts_only' as const);
  const degraded = results.some((r) => r.degraded) || errors.length > 0;
  if (degraded) {
    const detail = uniq([...results.filter((r) => r.degraded).map((r) => r.degradedReason ?? r.detail ?? 'retrieval degraded'), ...errors.map((e) => `search failed: ${e}`)]).join('; ');
    return { status: 'degraded', ...(detail ? { detail, detailKind: 'degraded' as const } : {}), method, searched, items };
  }
  const policy = uniq(results.map((r) => r.detail)).join('; ');
  return { status: 'ok', ...(policy ? { detail: policy, detailKind: 'policy' as const } : {}), method, searched, items };
}

function comparisonIds(json: string | null): string[] {
  const v = parseJson<unknown>(json, []);
  if (!Array.isArray(v)) return [];
  return v.map((c) => (c && typeof c === 'object' ? (c as { pageId?: unknown }).pageId : c)).filter((x): x is string => typeof x === 'string');
}

/**
 * Compact, auditable record of the prior context consulted before
 * recommending: counts, the candidates held back and why, standing site-wide
 * owner decisions (knowledge only), and the memory retrieval status with its
 * detail and the references it returned (no excerpts).
 */
export function priorContextSummary(prior: PriorContext, excluded: RecommendationSet['excluded'] = []): Record<string, unknown> {
  return {
    activeExperiments: prior.activeExperiments.length,
    concludedExperiments: prior.concludedExperiments.length,
    decisions: prior.decisions.length,
    rejectedRecommendations: prior.rejectedRecommendations.length,
    learnings: prior.learnings.length,
    excluded: excluded.slice(0, 10).map((x) => ({ opportunityId: x.opportunityId, pageId: x.pageId, route: x.route, reason: x.reason })),
    standingOwnerDecisions: prior.decisions
      .filter((d) => d.target?.siteWide || d.subjectType === 'site')
      .slice(0, 10)
      .map((d) => ({ id: d.id, date: d.decidedAt.slice(0, 10), decision: d.decision.slice(0, 300), source: d.vaultPath ?? null, note: 'owner knowledge; never excludes a specific candidate' })),
    memory: {
      status: prior.memory.status,
      detail: prior.memory.detail ?? null,
      detailKind: prior.memory.detailKind ?? null,
      method: prior.memory.method ?? null,
      searched: prior.memory.searched ?? [],
      items: prior.memory.items.slice(0, 12).map((i) => ({ sourceType: i.sourceType, sourceRef: i.sourceRef, recordStatus: i.recordStatus, title: i.title.slice(0, 160) })),
    },
  };
}

/** A resolved decision subject concerns this candidate (site-wide decisions never do). */
function decisionMatches(c: CandidateOpportunity, t: DecisionTarget): boolean {
  if (t.siteWide) return false;
  if (t.opportunityId && c.id && t.opportunityId === c.id) return true;
  if (!t.pageId && !t.url && !t.query) return false;
  if ((t.pageId || t.url) && !((t.pageId !== null && t.pageId === c.pageId) || (t.url !== null && t.url === c.url))) return false;
  if (t.query && normQuery(c.query) !== t.query) return false;
  if (t.actionType && ACTION_TYPE[c.route] !== t.actionType) return false;
  if (t.experimentType && !(SIMILAR_EXPERIMENT_TYPES[c.route] ?? []).includes(t.experimentType)) return false;
  return true;
}

function exclusionReason(c: CandidateOpportunity, prior: PriorContext): string | null {
  if (c.pageId) {
    const active = prior.activeExperiments.find((e) => e.pageId === c.pageId);
    if (active) return `experiment ${active.id} is ${active.status} on this page; changes are not stacked`;
    const control = prior.activeExperiments.find((e) => e.pageId !== c.pageId && (e.comparisonPageIds ?? []).includes(c.pageId!));
    if (control && CHANGE_ROUTES.has(c.route)) return `this page is a comparison (control) page of experiment ${control.id} (${control.status}); changing it would bias that evaluation`;
  }
  const siteWide = prior.activeExperiments.find((e) => e.pageId === null);
  if (siteWide && CHANGE_ROUTES.has(c.route)) return `site-wide experiment ${siteWide.id} (${siteWide.type}) is ${siteWide.status}; page changes are not stacked on it until it is reviewed`;
  // Owner decisions: resolved subjects (page, URL, query/keyword, opportunity, recommendation, experiment); the raw subject id when unresolved.
  const subjects = new Set([c.id, c.pageId, c.url].filter((x): x is string => !!x));
  const dec = prior.decisions.find((d) => isRejectingDecision(d.decision) && (d.target ? decisionMatches(c, d.target) : subjects.has(d.subjectId)));
  if (dec) {
    const about = dec.subjectType === 'page' || dec.subjectType === 'url' || subjects.has(dec.subjectId) ? '' : ` [${dec.subjectType} ${dec.subjectId}]`;
    return `owner decision "${dec.decision}" on ${dec.decidedAt}${dec.reason ? ` (${dec.reason})` : ''}${about}`;
  }
  // Rejected proposals: the same action on the same page (or, for a proposal without a page, the same query) is not re-proposed.
  const action = ACTION_TYPE[c.route];
  const cq = normQuery(c.query);
  const rej = prior.rejectedRecommendations.find((r) => stripObservation(r.actionType) === action && (r.pageId ? r.pageId === c.pageId : !!cq && normQuery(r.query) === cq));
  if (rej) return rej.pageId ? `a "${action}" recommendation for this page was rejected on ${rej.updatedAt}` : `a "${action}" recommendation for "${rej.query}" was rejected on ${rej.updatedAt}`;
  // Negative / inconclusive / cancelled experiments of the same kind on the same page (or query) are not re-tested.
  const similar = SIMILAR_EXPERIMENT_TYPES[c.route];
  if (similar) {
    const done = prior.concludedExperiments.find(
      (e) => similar.includes(e.type) && e.status !== 'positive' && ((c.pageId !== null && e.pageId === c.pageId) || (e.pageId === null && !!cq && normQuery(e.query) === cq)),
    );
    if (done) return `a similar experiment (${done.type}) ended ${done.status} on ${done.updatedAt}; not re-testing until there is new evidence`;
  }
  return null;
}

function n(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function metricClaims(c: CandidateOpportunity, keyPrefix: string): ClaimDraft[] {
  const range = { start: c.periodStart, end: c.periodEnd };
  const period = c.periodStart && c.periodEnd ? `${c.periodStart}..${c.periodEnd}` : 'the analysis period';
  const scope = c.query && (c.route === 'RANKING_OPPORTUNITY' || c.route === 'CTR_OPPORTUNITY' || c.route === 'CONTENT_OPPORTUNITY') ? `${c.route === 'RANKING_OPPORTUNITY' ? 'shortlisted queries' : c.route === 'CONTENT_OPPORTUNITY' ? 'uncovered-demand queries' : `query "${c.query}"`}` : 'page';
  const out: ClaimDraft[] = [];
  const add = (key: string, value: number | null, source: 'gsc' | 'ga4', observedText: (v: number) => string, missingText: string) => {
    if (value === null) out.push({ key: `${keyPrefix}.${key}`, text: missingText, label: 'DATA_UNAVAILABLE', support: 'missing' });
    else
      out.push({
        key: `${keyPrefix}.${key}`,
        text: observedText(value),
        label: 'OBSERVED',
        support: 'supports',
        evidence: { sourceType: source, url: c.url, summary: observedText(value), value: { [key]: value, scope }, locator: { table: source === 'gsc' ? 'gsc_page_daily/gsc_page_query_daily (current revisions)' : 'ga4_landing_daily (current revisions, google_organic)', pageId: c.pageId, query: c.query }, dateRange: range },
      });
  };
  const rc = c.rawCounts;
  add('impressions', n(rc.impressions), 'gsc', (v) => `${v} Search Console impressions (${scope}, ${period}).`, `Search Console impressions unavailable for ${period}.`);
  add('clicks', n(rc.clicks), 'gsc', (v) => `${v} Search Console clicks (${scope}, ${period}).`, `Search Console clicks unavailable for ${period}.`);
  if (n(rc.position) !== null) add('position', n(rc.position), 'gsc', (v) => `Impression-weighted average position ${v.toFixed(1)} (${scope}); an aggregate, not a live ranking.`, '');
  add('sessions', n(rc.sessions), 'ga4', (v) => `${v} google_organic sessions landed on the page (${period}).`, 'google_organic sessions unavailable for this page and period.');
  const conv = n(rc.convertingSessions);
  add('convertingSessions', conv, 'ga4', (v) => `~${v} session(s) with the primary event (derived from the reported session key-event rate; not an event count).`, 'Primary-event converting sessions unavailable (rate not observed or no primary event configured).');
  return out;
}

/** What a claim built from routing reasons is about (the candidate page/query and its window). */
export interface ReasonClaimSubject {
  url: string | null;
  pageId: string | null;
  query: string | null;
  period?: { start: string | null; end: string | null } | null;
  synthetic?: boolean;
}

/**
 * The evidence item behind a claim that rests on routing reasons: the measured
 * inputs the router recorded on them (`ReasonCode.data.inputs`: per-query rows
 * with position and impressions, page totals, rates, crawl or URL Inspection
 * observations), their window, and the current-revision view they were read
 * from (gsc_page_query_daily_current when query rows are involved). Null when
 * no reason has a measured input.
 */
export function reasonsEvidence(route: Route | null, reasons: readonly ReasonCode[], subject: ReasonClaimSubject): NonNullable<ClaimDraft['evidence']> | null {
  const measured = reasons.flatMap((r) => {
    const inputs = reasonInputs(r);
    return inputs ? [{ r, inputs }] : [];
  });
  if (!measured.length) return null;
  const first = measured[0]!.inputs;
  const rows = measured.flatMap((m) => m.inputs.rows ?? []);
  const queries = [...new Set(rows.map((q) => q.query))];
  const inputPeriod = measured.find((m) => m.inputs.period)?.inputs.period ?? null;
  const range = subject.period && (subject.period.start || subject.period.end) ? { start: subject.period.start, end: subject.period.end } : { start: inputPeriod?.start ?? null, end: inputPeriod?.end ?? null };
  const window = range.start && range.end ? ` (${range.start}..${range.end})` : '';
  const notMeasured = reasons.filter((r) => !reasonInputs(r)).map((r) => r.code);
  const describe = (m: { r: ReasonCode; inputs: ReasonInputs }) => `${m.r.code} [${m.inputs.source}${m.inputs.rows ? `, ${m.inputs.rows.length} query row(s)` : ''}]`;
  return {
    sourceType: first.source,
    kind: 'observation',
    url: subject.url,
    summary: `Measured inputs of the ${route ?? 'routing'} decision${window}: ${measured.map(describe).join(', ')}`.slice(0, 500),
    value: {
      ...(route ? { route } : {}),
      reasons: measured.map((m) => ({ code: m.r.code, source: m.inputs.source, table: m.inputs.table, period: m.inputs.period, ...(m.inputs.values ? { values: m.inputs.values } : {}), ...(m.inputs.rows ? { rows: m.inputs.rows } : {}) })),
      ...(notMeasured.length ? { notMeasured } : {}),
    },
    locator: {
      table: rows.length ? 'gsc_page_query_daily_current' : first.table,
      tables: [...new Set(measured.map((m) => m.inputs.table))],
      pageId: subject.pageId,
      query: subject.query,
      ...(queries.length ? { queries: queries.slice(0, 20) } : {}),
      decisions: 'route_decisions (reason_codes_json)',
    },
    dateRange: range,
    ...(subject.synthetic ? { synthetic: true } : {}),
  };
}

/**
 * A claim that rests on routing reasons (the recommendation's route claim, or
 * a site-level measurement / low-data observation). It "supports" the
 * recommendation only with the evidence item built from the reasons' measured
 * inputs; when no reason has one (experiment records, configuration, intent
 * classification, no rule matched), it is recorded as context, never as
 * "supports" without an evidence item (D2-ACC-03).
 */
export function reasonsClaim(key: string, text: string, label: ClaimLabel, route: Route | null, reasons: readonly ReasonCode[], subject: ReasonClaimSubject): ClaimDraft {
  const evidence = reasonsEvidence(route, reasons, subject);
  return evidence ? { key, text, label, support: 'supports', evidence } : { key, text, label, support: 'context' };
}

const TEXT: Partial<Record<Route, (c: CandidateOpportunity, reviewDays: number) => Pick<RecommendationDraft, 'title' | 'proposedChange' | 'hypothesis' | 'successCriteria' | 'risks'>>> = {
  RANKING_OPPORTUNITY: (c, d) => ({
    title: `Targeted SEO audit${c.query ? ` for "${c.query}"` : ''} on ${c.url}`,
    proposedChange: `Compare intent, page type, useful information, examples, evidence, and freshness against the current results for ${c.query ? `"${c.query}"` : 'the shortlisted queries'} (competitor comparison inputs), then propose ONE specific change for approval. Positions 4-20 are a shortlist heuristic, not an instruction to edit.`,
    hypothesis: 'If the page better satisfies the searcher intent for the shortlisted queries, their impression-weighted position and clicks may improve. Not guaranteed; rankings are never promised.',
    successCriteria: `Clicks and impression-weighted position for the shortlisted queries over at least ${d} days after the verified implementation date, versus a weekday-matched baseline; primary-event conversions as a guardrail.`,
    risks: 'An edit can reduce relevance for other queries the page already ranks for. Protected pages need explicit owner review.',
  }),
  CTR_OPPORTUNITY: (c, d) => ({
    title: `Title/snippet investigation${c.query ? ` for "${c.query}"` : ''} on ${c.url}`,
    proposedChange: 'Review the current title, meta description, and SERP presentation for the weak-CTR queries; propose title/description options for approval.',
    hypothesis: 'A title/snippet that better matches the query intent may raise CTR at a comparable position. Google may rewrite snippets; not guaranteed.',
    successCriteria: `CTR for the affected queries at a comparable average position over at least ${d} days after implementation; clicks and conversions as guardrails.`,
    risks: 'Higher CTR with poorer intent match can reduce lead quality. Title changes can shift rankings.',
  }),
  CONVERSION_OPPORTUNITY: (c, d) => ({
    title: `Conversion-path review on ${c.url}`,
    proposedChange: 'First verify the primary event fires correctly on this page (manual test checklist, no fake conversions), then check intent match of the top queries and review the CTA/form path.',
    hypothesis: 'If tracking is correct and the page better serves the intent of its visitors, the primary-event session conversion rate may rise.',
    successCriteria: `Primary-event session conversion rate with at least the configured minimum sessions over at least ${d} days; sessions as a guardrail.`,
    risks: 'Low conversion may reflect informational intent or assisted journeys that GA4 cannot attribute; do not remove useful content to chase conversions.',
  }),
  DECLINE: (c) => ({
    title: `Investigate decline on ${c.url}`,
    proposedChange: 'Investigate before editing: technical changes (crawl, indexing, canonicals), query/position shifts, demand changes (impressions), competitor changes, and recorded site changes.',
    hypothesis: 'The decline has an identifiable cause among technical, demand, competitive, or site changes. The cause is not asserted from this data.',
    successCriteria: 'A documented cause with evidence, or an explicit "no identifiable cause" record.',
    risks: 'Reacting to normal fluctuation or seasonality with an edit can make things worse.',
  }),
  CONTENT_OPPORTUNITY: (c) => ({
    title: `Content overlap check${c.query ? ` for "${c.query}"` : ''}`,
    proposedChange: 'Check whether an existing page should be improved, extended with a section, or whether a distinct page/tool is justified; research before any brief. Do not create one page per keyword.',
    hypothesis: 'There is relevant demand the site does not satisfy well today. Search-volume estimates are not exact demand.',
    successCriteria: 'An overlap decision (improve existing / add section / new page / defer / reject) with recorded reason.',
    risks: 'Cannibalization of existing pages; thin or duplicate content.',
  }),
  INDEXING_UNKNOWN: (c) => ({
    title: `Inspect indexing for ${c.url}`,
    proposedChange: `Run the free Search Console URL Inspection for this URL (\`npm run cli -- sync inspect ${c.url ?? '<url>'}\`; it shows Google's indexed version, not a live test) and check crawlability. Changes nothing on the site; waiting alone will not produce impressions for an unindexed page. Never delete or redirect automatically.`,
    hypothesis: 'The page may be unindexed, excluded, or simply without demand; zero impressions alone do not establish which.',
    successCriteria: 'A recorded indexing state for the URL.',
    risks: 'Deleting or redirecting on zero impressions alone can destroy useful pages.',
  }),
  TECHNICAL_BLOCKER: (c) => ({
    title: `Technical investigation for ${c.url}`,
    proposedChange: `Investigate and fix the confirmed issue(s): ${c.reasons.map((r) => r.detail).join('; ')}. Production changes (robots, canonical, redirects) require explicit approval.`,
    hypothesis: 'Removing a confirmed access/indexability failure is a prerequisite for any optimization on this page.',
    successCriteria: 'The issue is no longer observed in a fresh crawl and URL Inspection.',
    risks: 'Robots/canonical/redirect changes are production actions and need human approval.',
  }),
};

function reviewDate(today: IsoDate, days: number): IsoDate {
  return addDays(today, days);
}

function draftFor(c: CandidateOpportunity, kind: RecommendationKind, today: IsoDate, reviewDays: number): RecommendationDraft {
  const text = TEXT[c.route]?.(c, reviewDays) ?? { title: `${c.route} on ${c.url ?? 'site'}`, proposedChange: null, hypothesis: null, successCriteria: null, risks: null };
  const key = kind === 'secondary' ? `secondary.${c.pageId ?? 'site'}` : 'primary';
  const claims: ClaimDraft[] = [...metricClaims(c, key)];
  claims.push(
    reasonsClaim(`${key}.route`, `Routed to ${c.route}: ${c.reasons.map((r) => `${r.code} (${r.detail})`).join('; ')}`, 'INFERRED', c.route, c.reasons, {
      url: c.url,
      pageId: c.pageId,
      query: c.query,
      period: { start: c.periodStart, end: c.periodEnd },
      ...(c.synthetic ? { synthetic: true } : {}),
    }),
  );
  if (text.hypothesis) claims.push({ key: `${key}.hypothesis`, text: text.hypothesis, label: 'HYPOTHESIS', support: 'context' });
  if (c.query) claims.push({ key: `${key}.query_impact`, text: `Business impact of "${c.query}" is a hypothesis based on page-level evidence; query-level conversions are not measured.`, label: 'HYPOTHESIS', support: 'context' });
  if (text.proposedChange) claims.push({ key: `${key}.action`, text: text.proposedChange, label: 'RECOMMENDATION', support: 'context' });
  return {
    kind,
    actionType: kind === 'secondary' ? `observation:${ACTION_TYPE[c.route]}` : ACTION_TYPE[c.route],
    title: text.title,
    opportunityId: c.id,
    pageId: c.pageId,
    url: c.url,
    query: c.query,
    route: c.route,
    diagnosis: c.reasons.map((r) => r.detail).join('; '),
    proposedChange: kind === 'secondary' ? null : text.proposedChange,
    hypothesis: kind === 'secondary' ? null : text.hypothesis,
    successCriteria: kind === 'secondary' ? null : text.successCriteria,
    risks: kind === 'secondary' ? null : `${text.risks ?? ''}${c.isProtected ? ' This is a protected page: explicit owner review required.' : ''}`.trim() || null,
    reviewDate: kind === 'secondary' ? null : reviewDate(today, reviewDays),
    scoringVersion: c.scoringVersion,
    details: { score: c.score, evidenceQuality: c.evidenceQuality, rawCounts: c.rawCounts, reasons: c.reasons, segment: c.isBranded === null ? 'unknown' : c.isBranded ? 'branded' : 'non_branded' },
    claims,
  };
}

function simpleDraft(kind: RecommendationKind, actionType: string, title: string, diagnosis: string, claims: ClaimDraft[], extra: Partial<RecommendationDraft> = {}): RecommendationDraft {
  const action = kind === 'secondary' ? null : (claims.find((c) => c.label === 'RECOMMENDATION')?.text ?? null);
  return {
    kind,
    actionType,
    title,
    opportunityId: null,
    pageId: null,
    url: null,
    query: null,
    route: null,
    diagnosis,
    proposedChange: action,
    hypothesis: null,
    successCriteria: null,
    risks: null,
    reviewDate: null,
    scoringVersion: null,
    details: {},
    claims,
    ...extra,
  };
}

export interface AssembleOptions {
  candidates: readonly CandidateOpportunity[];
  siteDecision: RouteDecision | null;
  /** Route counts from the routing run (to tell "all healthy" from "not enough evidence"). */
  routeCounts?: Record<string, number>;
  /** Single-page preview: the page's own (possibly unscored) route. `period`: the routing window (else taken from the reasons' inputs). */
  pageRoute?: { route: Route; reasons: ReasonCode[]; pageId: string; url: string; period?: { start: string; end: string } | null } | null;
  today: IsoDate;
  reviewDays: number;
  lowTrafficReviewDays: number;
  minScore?: number;
  minEvidence?: number;
  prior: PriorContext;
  extraObservations?: Array<{ title: string; text: string; label: ClaimLabel }>;
  /** The run operates on synthetic data (AppContext.synthetic / synthetic rows in scope). */
  synthetic?: boolean;
  /** Deep SERP/competitor comparisons of this run (weekly `compare` stage); the matching one is attached to the primary. */
  comparisons?: readonly ComparisonForRecommendation[];
}

/** Marker on every claim text and title that rests on synthetic (fixture/demo) data (the reports' claim marker). */
export const SYNTHETIC_MARKER = '[SYNTHETIC]';

/**
 * Relabel a draft that rests on synthetic data, the way report sections label
 * synthetic figures ("OBSERVED [SYNTHETIC]"): an observed figure keeps its
 * OBSERVED label and value, sets the synthetic flag (claim and evidence, so
 * its source is recorded as trust_class 'synthetic'), and its text carries the
 * [SYNTHETIC] marker. A value is never placed under DATA_UNAVAILABLE, which
 * means "not measured" (a DATA_UNAVAILABLE claim stays a statement without a
 * value). Inferences say they are based on synthetic data, and the title
 * carries the [SYNTHETIC] marker.
 */
export function markSynthetic(d: RecommendationDraft): RecommendationDraft {
  if (d.details.synthetic === true) return d;
  const marked = (text: string) => (text.startsWith(SYNTHETIC_MARKER) ? text : `${SYNTHETIC_MARKER} ${text}`);
  return {
    ...d,
    title: marked(d.title),
    details: { ...d.details, synthetic: true },
    claims: d.claims.map((c) => {
      if (c.label === 'OBSERVED') return { ...c, synthetic: true, text: marked(c.text), ...(c.evidence ? { evidence: { ...c.evidence, synthetic: true } } : {}) };
      // An inference's evidence item (e.g. the route claim's router inputs) is synthetic too: its source is recorded as a fixture.
      if (c.label === 'INFERRED') return { ...c, synthetic: true, text: `Based on SYNTHETIC data: ${c.text}`, ...(c.evidence ? { evidence: { ...c.evidence, synthetic: true } } : {}) };
      return { ...c, synthetic: true, ...(c.evidence ? { evidence: { ...c.evidence, synthetic: true } } : {}) };
    }),
  };
}

export function assembleRecommendation(siteId: string, o: AssembleOptions): RecommendationSet {
  const minScore = o.minScore ?? 20;
  const minEvidence = o.minEvidence ?? 0.35;
  const excluded: RecommendationSet['excluded'] = [];
  const period = { start: o.candidates[0]?.periodStart ?? o.siteDecision?.period?.start ?? null, end: o.candidates[0]?.periodEnd ?? o.siteDecision?.period?.end ?? null };
  const byScore = (a: CandidateOpportunity, b: CandidateOpportunity) => {
    const seg = (x: CandidateOpportunity) => (x.isBranded === true ? 1 : 0);
    return seg(a) - seg(b) || (b.score ?? -1) - (a.score ?? -1);
  };
  const weakEvidence = (c: CandidateOpportunity) => (c.score ?? 0) < minScore || (c.evidenceQuality !== null && c.evidenceQuality < minEvidence);
  const eligible: CandidateOpportunity[] = [];
  for (const c of o.candidates) {
    const why = exclusionReason(c, o.prior);
    if (why && c.route !== 'INVALID_OR_INCOMPLETE_DATA' && c.route !== 'TECHNICAL_BLOCKER') excluded.push({ opportunityId: c.id, pageId: c.pageId, route: c.route, reason: why });
    else eligible.push(c);
  }
  const measurement = eligible.filter((c) => c.route === 'INVALID_OR_INCOMPLETE_DATA').sort(byScore);
  const technical = eligible.filter((c) => c.route === 'TECHNICAL_BLOCKER').sort(byScore);
  const optimization = eligible.filter((c) => OPTIMIZATION_ROUTES.has(c.route)).sort(byScore);
  const secondaries: RecommendationDraft[] = [];
  let primary: RecommendationDraft;
  const lowData = o.siteDecision?.route === 'LOW_DATA';
  const reviewDays = lowData ? o.lowTrafficReviewDays : o.reviewDays;

  if (o.siteDecision?.route === 'INVALID_OR_INCOMPLETE_DATA') {
    const reasons = o.siteDecision.reasons;
    const sitePeriod = o.siteDecision.period ? { start: o.siteDecision.period.start, end: o.siteDecision.period.end } : null;
    primary = simpleDraft('repair_measurement', 'repair_measurement', 'Repair measurement before optimizing', reasons.map((r) => r.detail).join('; '), [
      reasonsClaim('primary.measurement', `Site-level measurement problem: ${reasons.map((r) => `${r.code} (${r.detail})`).join('; ')}`, 'OBSERVED', 'INVALID_OR_INCOMPLETE_DATA', reasons, { url: null, pageId: null, query: null, period: sitePeriod }),
      { key: 'primary.action', text: 'Repair measurement or wait for complete data; optimization recommendations are withheld until then.', label: 'RECOMMENDATION', support: 'context' },
    ], { details: { reasons }, proposedChange: 'Fix the listed measurement gaps (see docs/ACCESS_SETUP.md for access; GA4 event changes are a human action).', successCriteria: 'Complete, final data with a configured primary event and resolvable joins.' });
  } else if (measurement.length) {
    const m = measurement[0]!;
    primary = { ...draftFor(m, 'repair_measurement', o.today, reviewDays), title: `Repair measurement for ${m.url ?? 'site'}`, proposedChange: `Resolve: ${m.reasons.map((r) => r.detail).join('; ')}` };
  } else if (technical.length) {
    primary = draftFor(technical[0]!, 'primary', o.today, reviewDays);
  } else if (lowData && optimization.length === 0) {
    primary = simpleDraft('collect_more_evidence', 'bootstrap', 'Bootstrap: collect evidence for a new or small site', o.siteDecision!.reasons.map((r) => r.detail).join('; '), [
      reasonsClaim('primary.low_data', o.siteDecision!.reasons.map((r) => r.detail).join('; '), 'OBSERVED', 'LOW_DATA', o.siteDecision!.reasons, { url: null, pageId: null, query: null, period: o.siteDecision!.period ? { start: o.siteDecision!.period.start, end: o.siteDecision!.period.end } : null }),
      { key: 'primary.action', text: 'Produce an offer-page brief and one genuinely useful supporting-page brief, plus measurement and technical-readiness checks. No historical conversion evidence is assumed.', label: 'RECOMMENDATION', support: 'context' },
    ], { details: { reasons: o.siteDecision!.reasons } });
  } else {
    const best = optimization[0];
    const siteWide = o.prior.activeExperiments.find((e) => e.pageId === null);
    const heldBySiteWide = !!siteWide && excluded.some((x) => x.reason.startsWith(`site-wide experiment ${siteWide.id}`));
    if (!best) {
      const counts = o.routeCounts ?? {};
      const pr = o.pageRoute;
      if (pr) primary = pageRouteDraft(pr, o.today, reviewDays);
      else if (heldBySiteWide) {
        primary = simpleDraft('no_action', 'monitor_experiment', `Monitor site-wide experiment ${siteWide!.id}`, `Site-wide experiment ${siteWide!.id} (${siteWide!.type}) is ${siteWide!.status}; ${excluded.length} page change candidate(s) are held back.`, [
          // An experiment record, not a measurement: context (no evidence item).
          { key: 'primary.experiment', text: `Site-wide experiment ${siteWide!.id} (${siteWide!.type}) is ${siteWide!.status}.`, label: 'OBSERVED', support: 'context' },
          { key: 'primary.action', text: 'Do not stack page changes on a running site-wide experiment; review it when its observation window closes.', label: 'RECOMMENDATION', support: 'context' },
        ], { details: { experimentId: siteWide!.id, heldBack: excluded.length } });
      } else {
        const undecided = (counts.LOW_DATA ?? 0) + (counts.UNSURE ?? 0);
        const settled = (counts.HEALTHY ?? 0) + (counts.EXPERIMENT_ACTIVE ?? 0) + (counts.IRRELEVANT ?? 0);
        primary =
          undecided > settled
            ? simpleDraft('collect_more_evidence', 'collect_more_evidence', 'Collect more evidence before changing anything', `Most pages lack enough evidence (${JSON.stringify(counts)}).`, [
                // A count of this run's routing decisions, not a measurement: context (no evidence item).
                { key: 'primary.routes', text: `Route counts: ${JSON.stringify(counts)}`, label: 'OBSERVED', support: 'context' },
                { key: 'primary.action', text: 'No change this cycle; keep measuring.', label: 'RECOMMENDATION', support: 'context' },
              ])
            : simpleDraft('no_action', 'none', 'No action: leave pages unchanged this cycle', `No eligible opportunity (${JSON.stringify(counts)}).`, [
                { key: 'primary.routes', text: `Route counts: ${JSON.stringify(counts)}`, label: 'OBSERVED', support: 'context' },
                { key: 'primary.action', text: 'Leave pages unchanged. A weekly report does not require a weekly change.', label: 'RECOMMENDATION', support: 'context' },
              ]);
      }
    } else if (!EVIDENCE_EXEMPT_ROUTES.has(best.route) && weakEvidence(best)) {
      // A no-change diagnostic (URL Inspection, decline investigation) further down is actionable now; otherwise keep measuring.
      const diagnostic = optimization.find((c) => EVIDENCE_EXEMPT_ROUTES.has(c.route));
      if (diagnostic) primary = draftFor(diagnostic, 'primary', o.today, reviewDays);
      else
        primary = simpleDraft('collect_more_evidence', 'collect_more_evidence', `Collect more evidence (best candidate: ${best.url ?? best.route})`, `Best candidate scored ${best.score ?? 'n/a'} with evidence quality ${best.evidenceQuality ?? 'n/a'} (minimums ${minScore} / ${minEvidence}).`, [
          ...metricClaims(best, 'primary'),
          { key: 'primary.action', text: 'Evidence is too weak for a change; keep measuring and revisit.', label: 'RECOMMENDATION', support: 'context' },
        ], { opportunityId: best.id, pageId: best.pageId, url: best.url, route: best.route, details: { score: best.score, evidenceQuality: best.evidenceQuality } });
    } else {
      // Diagnostic routes are exempt from the minimum-evidence rule (their action changes nothing).
      primary = draftFor(best, 'primary', o.today, reviewDays);
      if (EVIDENCE_EXEMPT_ROUTES.has(best.route) && weakEvidence(best)) {
        primary = { ...primary, details: { ...primary.details, minimumEvidenceExempt: `${best.route} is a no-change diagnostic; the minimum-evidence rule (score ${minScore} / evidence ${minEvidence}) applies only to changes` } };
      }
    }
  }
  if (o.comparisons?.length) primary = attachComparison(primary, o.comparisons);
  // What was consulted before recommending (spec section 19), recorded with the primary item.
  primary = { ...primary, details: { ...primary.details, priorContext: priorContextSummary(o.prior, excluded) } };

  // Secondary observations (max 3): other candidates on other pages, then extra observations.
  const used = new Set([primary.pageId].filter(Boolean));
  for (const c of [...technical, ...optimization]) {
    if (secondaries.length >= MAX_SECONDARY) break;
    if (c.id !== null && c.id === primary.opportunityId) continue;
    if (c.pageId && used.has(c.pageId)) continue;
    used.add(c.pageId);
    secondaries.push(draftFor(c, 'secondary', o.today, reviewDays));
  }
  for (const x of o.extraObservations ?? []) {
    if (secondaries.length >= MAX_SECONDARY) break;
    secondaries.push(simpleDraft('secondary', 'observation', x.title, x.text, [{ key: `secondary.obs.${secondaries.length}`, text: x.text, label: x.label, support: 'context' }]));
  }
  const synthetic = o.synthetic === true || o.candidates.some((c) => c.synthetic === true);
  if (synthetic) return { version: RECOMMEND_VERSION, siteId, period, primary: markSynthetic(primary), secondary: secondaries.map(markSynthetic), excluded, priorContext: o.prior, synthetic };
  return { version: RECOMMEND_VERSION, siteId, period, primary, secondary: secondaries, excluded, priorContext: o.prior, synthetic };
}

/** The comparison of this run that concerns the primary recommendation's page (and query, when known). */
export function matchComparison(d: Pick<RecommendationDraft, 'opportunityId' | 'pageId' | 'url' | 'query'>, comparisons: readonly ComparisonForRecommendation[]): ComparisonForRecommendation | null {
  const norm = (q: string | null | undefined) => (q ?? '').normalize('NFKC').trim().toLocaleLowerCase();
  return (
    (d.opportunityId ? comparisons.find((c) => c.opportunityId === d.opportunityId) : undefined) ??
    comparisons.find((c) => ((d.pageId && c.pageId === d.pageId) || (d.url && c.url === d.url)) && d.query !== null && norm(c.query) === norm(d.query)) ??
    comparisons.find((c) => (d.pageId && c.pageId === d.pageId) || (d.url && c.url === d.url)) ??
    null
  );
}

const MAX_COMPARISON_ITEMS = 5;

/**
 * Attach the deep comparison to the primary recommendation: labeled claims
 * (rendered by the weekly report with the recommendation's other claims)
 * and a `details.comparison` summary. Comparison statements are INFERRED
 * (keyword heuristics over crawled pages; never ranking causes); a model
 * synthesis is a HYPOTHESIS; a synthesis that did not run is stated as
 * DATA_UNAVAILABLE with its reason.
 */
function attachComparison(primary: RecommendationDraft, comparisons: readonly ComparisonForRecommendation[]): RecommendationDraft {
  if (primary.kind !== 'primary' || !primary.route || !COMPARISON_ROUTES.has(primary.route)) return primary;
  const cmp = matchComparison(primary, comparisons);
  if (!cmp) return primary;
  const serp = cmp.serp
    ? `localized SERP snapshot${cmp.serp.collectedAt ? ` of ${cmp.serp.collectedAt.slice(0, 10)}` : ''} (location ${cmp.serp.locationCode ?? 'unknown'}, language ${cmp.serp.languageCode ?? 'unknown'}, device ${cmp.serp.device ?? 'unknown'})`
    : 'competitor pages crawled for this query (SERP locality not verified)';
  const day = cmp.fetchedAt ? cmp.fetchedAt.slice(0, 10) : null;
  const evidence = (summary: string): NonNullable<ClaimDraft['evidence']> => ({
    sourceType: 'competitor_page',
    kind: 'observation',
    url: cmp.url,
    summary,
    value: { query: cmp.query, competitorsCompared: cmp.competitorsCompared, competitorsInaccessible: cmp.competitorsInaccessible, serp: cmp.serp },
    locator: { table: 'competitive_comparisons', id: cmp.id, query: cmp.query, pageId: cmp.pageId },
    dateRange: { start: day, end: day },
    ...(cmp.synthetic ? { synthetic: true } : {}),
  });
  const base = `Competitor comparison${cmp.id ? ` ${cmp.id}` : ''} for "${cmp.query}"`;
  const syn = cmp.synthetic ? { synthetic: true } : {};
  const claims: ClaimDraft[] = [
    {
      key: 'primary.compare.scope',
      text: `Deep analysis for "${cmp.query}": our page was compared with ${cmp.competitorsCompared} accessible competitor page(s) from the ${serp}; ${cmp.competitorsInaccessible} competitor page(s) were not accessible (access barriers are never bypassed). Heuristic comparison of crawled pages; differences are not ranking causes.`,
      label: 'INFERRED',
      support: 'supports',
      evidence: evidence(`${base}: scope and page counts`),
      ...syn,
    },
  ];
  const advantages = cmp.ourAdvantages;
  if (!advantages.length) {
    claims.push({ key: 'primary.compare.advantage.1', text: 'What our page does better: no advantage was detected by the deterministic comparison (a heuristic miss does not prove there is none).', label: 'INFERRED', support: 'supports', evidence: evidence(`${base}: no advantage detected`), ...syn });
  }
  advantages.slice(0, MAX_COMPARISON_ITEMS).forEach((a, i) => claims.push({ key: `primary.compare.advantage.${i + 1}`, text: `What our page does better: ${a}`, label: 'INFERRED', support: 'supports', evidence: evidence(`${base}: our advantage ${i + 1}`), ...syn }));
  cmp.gaps.slice(0, MAX_COMPARISON_ITEMS).forEach((g, i) => claims.push({ key: `primary.compare.gap.${i + 1}`, text: `Observed difference (a research prompt, not a ranking cause): ${g}`, label: 'INFERRED', support: 'supports', evidence: evidence(`${base}: gap ${i + 1}`), ...syn }));
  if (cmp.caveats.length) claims.push({ key: 'primary.compare.caveats', text: `Comparison caveats: ${cmp.caveats.slice(0, 8).join(' ')}`, label: 'INFERRED', support: 'supports', evidence: evidence(`${base}: caveats`), ...syn });
  if (cmp.synthesis.status === 'ok' && cmp.synthesis.summary) {
    claims.push({ key: 'primary.compare.synthesis', text: `Model synthesis of the comparison (reasoning tier${cmp.synthesis.model ? `, ${cmp.synthesis.model}` : ''}${cmp.synthesis.promptVersion ? `, prompt ${cmp.synthesis.promptVersion}` : ''}; model output, not a measurement): ${cmp.synthesis.summary}`, label: 'HYPOTHESIS', support: 'context', ...syn });
  } else {
    claims.push({ key: 'primary.compare.synthesis', text: `SERP synthesis not available: ${cmp.synthesis.reason ?? `synthesis ${cmp.synthesis.status}`}. The deterministic comparison above stands on its own.`, label: 'DATA_UNAVAILABLE', support: 'missing', ...syn });
  }
  const note = ` Deep comparison attached${cmp.id ? ` (competitive_comparisons ${cmp.id})` : ''}: start from what the page already does better; the observed gaps are research prompts, not headings to copy or ranking causes.`;
  return {
    ...primary,
    proposedChange: primary.proposedChange ? `${primary.proposedChange}${note}` : primary.proposedChange,
    details: {
      ...primary.details,
      comparison: {
        id: cmp.id,
        query: cmp.query,
        competitorsCompared: cmp.competitorsCompared,
        competitorsInaccessible: cmp.competitorsInaccessible,
        ourAdvantages: cmp.ourAdvantages,
        gaps: cmp.gaps,
        caveats: cmp.caveats,
        synthesis: { status: cmp.synthesis.status, reason: cmp.synthesis.reason },
        serp: cmp.serp,
        synthetic: cmp.synthetic,
      },
    },
    claims: [...primary.claims, ...claims],
  };
}

function pageRouteDraft(pr: NonNullable<AssembleOptions['pageRoute']>, today: IsoDate, reviewDays: number): RecommendationDraft {
  const reasons = pr.reasons.map((r) => `${r.code} (${r.detail})`).join('; ');
  const base = { pageId: pr.pageId, url: pr.url, route: pr.route, details: { reasons: pr.reasons } };
  const obs: ClaimDraft = reasonsClaim('primary.route', `Routed to ${pr.route}: ${reasons}`, 'INFERRED', pr.route, pr.reasons, { url: pr.url, pageId: pr.pageId, query: null, period: pr.period ?? null });
  switch (pr.route) {
    case 'HEALTHY':
      return simpleDraft('no_action', 'none', `Leave ${pr.url} unchanged`, reasons, [obs, { key: 'primary.action', text: 'Satisfactory performance without material issues: leave the page unchanged.', label: 'RECOMMENDATION', support: 'context' }], base);
    case 'EXPERIMENT_ACTIVE':
      return simpleDraft('no_action', 'monitor_experiment', `Monitor the experiment on ${pr.url}`, reasons, [obs, { key: 'primary.action', text: 'Do not stack unrelated changes while the observation window is open.', label: 'RECOMMENDATION', support: 'context' }], { ...base, reviewDate: addDays(today, 0) });
    case 'IRRELEVANT':
      return simpleDraft('no_action', 'archive', `Archive ${pr.url} from optimization`, reasons, [obs], base);
    case 'UNSURE':
      return simpleDraft('collect_more_evidence', 'human_review', `Review intent/scope for ${pr.url}`, reasons, [obs, { key: 'primary.action', text: 'Ambiguous or mixed intent: classify (or review) before choosing an action.', label: 'RECOMMENDATION', support: 'context' }], base);
    case 'LOW_DATA':
    default:
      return simpleDraft('collect_more_evidence', 'collect_more_evidence', `Collect more evidence for ${pr.url}`, reasons, [obs, { key: 'primary.action', text: `Keep measuring; revisit after about ${reviewDays} days.`, label: 'RECOMMENDATION', support: 'context' }], base);
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function ensureSource(db: Db, siteId: string, e: NonNullable<ClaimDraft['evidence']>, now: string): string {
  const contentHash = hashObject({ value: e.value, dateRange: e.dateRange, locator: e.locator });
  const url = e.url ?? `site:${siteId}`;
  // Synthetic figures are fixture data, never first-party measurements; competitor pages are
  // scraped third-party content and model synthesis is model output.
  const sourceType = e.synthetic ? 'fixture' : e.sourceType;
  const trustClass = e.synthetic ? 'synthetic' : e.sourceType === 'competitor_page' ? 'scraped_untrusted' : e.sourceType === 'llm_output' ? 'model_generated' : 'first_party_measurement';
  const existing = db.get<{ id: string }>('SELECT id FROM sources WHERE site_id = ? AND source_type = ? AND url = ? AND content_hash = ?', [siteId, sourceType, url, contentHash]);
  if (existing) return existing.id;
  const id = newId('src');
  db.run(
    `INSERT INTO sources (id, site_id, source_type, trust_class, url, title, retrieved_at, content_hash, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, siteId, sourceType, trustClass, url, e.summary.slice(0, 200), now, contentHash, JSON.stringify({ derivedBy: RECOMMEND_VERSION, dataset: e.sourceType, ...(e.synthetic ? { synthetic: true } : {}) })],
  );
  return id;
}

export interface PersistedRecommendation {
  primaryId: string;
  secondaryIds: string[];
  claimCount: number;
  superseded: number;
}

/** Experiment statuses in which the experiment still stands for its source recommendation. */
export const OPEN_EXPERIMENT_STATUSES = ['proposed', 'approved', 'awaiting_implementation', 'observing'] as const;

/**
 * Persist the recommendation set with claim-level evidence. Earlier
 * still-"proposed" recommendations for the site are marked superseded
 * (approved/implemented/rejected ones are never touched), except those an
 * open experiment (proposed, approved, awaiting implementation, observing)
 * was proposed from: that recommendation is being tested, not replaced.
 */
export function persistRecommendationSet(db: Db, siteId: string, set: RecommendationSet, opts: { now: Date; jobId?: string | null; supersedePrevious?: boolean }): PersistedRecommendation {
  const now = opts.now.toISOString();
  return db.transaction(() => {
    let superseded = 0;
    if (opts.supersedePrevious ?? true) {
      superseded = db.run(
        `UPDATE recommendations SET status = 'superseded', updated_at = ?
         WHERE site_id = ? AND status = 'proposed'
           AND id NOT IN (SELECT recommendation_id FROM experiments
                          WHERE site_id = ? AND recommendation_id IS NOT NULL AND status IN (${OPEN_EXPERIMENT_STATUSES.map(() => '?').join(', ')}))`,
        [now, siteId, siteId, ...OPEN_EXPERIMENT_STATUSES],
      ).changes;
    }
    let claimCount = 0;
    const insert = (r: RecommendationDraft): string => {
      const id = newId('rec');
      db.run(
        `INSERT INTO recommendations (id, site_id, job_id, opportunity_id, kind, action_type, title, page_id, query, diagnosis, proposed_change, hypothesis, success_criteria, risks, review_date, details_json, status, prompt_version, model_id, scoring_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', NULL, NULL, ?, ?, ?)`,
        [id, siteId, opts.jobId ?? null, r.opportunityId, r.kind, r.actionType, r.title, r.pageId, r.query, r.diagnosis, r.proposedChange, r.hypothesis, r.successCriteria, r.risks, r.reviewDate, JSON.stringify({ ...r.details, route: r.route, url: r.url, version: RECOMMEND_VERSION }), r.scoringVersion, now, now],
      );
      for (const c of r.claims) {
        let evidenceId: string | null = null;
        if (c.evidence) {
          const sourceId = ensureSource(db, siteId, c.evidence, now);
          evidenceId = newId('ev');
          db.run(
            `INSERT INTO evidence (id, site_id, source_id, kind, summary, locator_json, value_json, date_range_start, date_range_end, collected_at, transformation_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [evidenceId, siteId, sourceId, c.evidence.kind ?? 'metric', c.evidence.summary, JSON.stringify(c.evidence.locator), JSON.stringify(c.evidence.value), c.evidence.dateRange.start, c.evidence.dateRange.end, now, RECOMMEND_VERSION],
          );
        }
        db.run(
          `INSERT INTO claim_evidence (id, site_id, subject_type, subject_id, claim_key, claim_text, claim_label, evidence_id, support, created_at) VALUES (?, ?, 'recommendation', ?, ?, ?, ?, ?, ?, ?)`,
          [newId('claim'), siteId, id, c.key, c.text, c.label, evidenceId, c.support, now],
        );
        claimCount++;
      }
      return id;
    };
    const primaryId = insert(set.primary);
    const secondaryIds = set.secondary.slice(0, MAX_SECONDARY).map(insert);
    if (set.primary.opportunityId && (set.primary.kind === 'primary' || set.primary.kind === 'repair_measurement')) db.run("UPDATE opportunities SET status = 'recommended', updated_at = ? WHERE id = ? AND site_id = ?", [now, set.primary.opportunityId, siteId]);
    return { primaryId, secondaryIds, claimCount, superseded };
  });
}
