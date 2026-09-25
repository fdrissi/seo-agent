import { AppError } from '../core/errors.js';
import { parseJson, type Db } from '../database/db.js';
import { canonicalChange, mapToApprovalActionType } from './artifact.js';
import type { ApprovalActionType } from './types.js';

/**
 * Structured change content shared by exports, experiments, approvals, and
 * live verification.
 *
 * Integration contract for recommendation producers (documented in
 * docs/modules/experiments-approvals.md): `recommendations.details_json` MAY
 * carry machine-checkable fields. Recognized keys (first match wins):
 *   title:           proposedTitle | newTitle
 *   metaDescription: proposedMetaDescription | newMetaDescription
 *   bodyMarkdown:    proposedContentMarkdown | proposedSectionMarkdown | bodyMarkdown
 *   canonical:       proposedCanonical
 *   robots:          proposedRobots
 *   redirectTo:      redirectTo | redirectTarget
 *   internalLinks:   internalLinks (array)
 *   structuredData:  structuredData
 *   targetUrl:       targetUrl
 *   rollbackPlan:    rollbackPlan
 * Without them the change is the free-text `proposed_change`, which is still
 * hashed and approved exactly, but can only be verified live by a human.
 *
 * `details_json.change` ({ kind: 'title'|'meta_description'|'section'|'redirect',
 * proposedTitle?, proposedMetaDescription?, proposedSectionMarkdown?, redirectTo? })
 * is the structured change recorded by `experiments specify-change`; it wins
 * over the loose keys above and determines the approval action type
 * (recommendationActionType), whatever the row's action label says; the
 * label of the recommendation it was specified from is kept in
 * `details_json.originalActionType`. Audit/investigation recommendations (see
 * INVESTIGATION_ACTION_TYPES) are refused as experiments, approvals, and
 * exports until such a structured change exists.
 */

export interface ContentChange {
  instructions?: string;
  title?: string;
  metaDescription?: string;
  bodyMarkdown?: string;
  canonical?: string;
  robots?: string;
  redirectTo?: string;
  slug?: string;
  internalLinks?: unknown[];
  structuredData?: unknown;
}

export interface RecommendationRow {
  id: string;
  site_id: string;
  opportunity_id: string | null;
  kind: string;
  action_type: string;
  title: string;
  page_id: string | null;
  query: string | null;
  diagnosis: string | null;
  proposed_change: string | null;
  hypothesis: string | null;
  success_criteria: string | null;
  risks: string | null;
  review_date: string | null;
  details_json: string | null;
  status: string;
  prompt_version: string | null;
  model_id: string | null;
  scoring_version: string | null;
  created_at: string;
}

export function getRecommendation(db: Db, siteId: string, id: string): RecommendationRow | null {
  return db.get<RecommendationRow>('SELECT * FROM recommendations WHERE site_id = ? AND id = ?', [siteId, id]) ?? null;
}

export function pickString(obj: Record<string, unknown> | null | undefined, ...keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

export function recommendationDetails(rec: RecommendationRow): Record<string, unknown> {
  const d = parseJson<unknown>(rec.details_json, {});
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
}

export function changeFromRecommendation(rec: RecommendationRow): ContentChange {
  const d = recommendationDetails(rec);
  const s = structuredChangeOf(d);
  const change: ContentChange = {};
  const set = <K extends keyof ContentChange>(k: K, v: ContentChange[K] | undefined) => {
    if (v !== undefined) change[k] = v;
  };
  set('instructions', rec.proposed_change?.trim() || undefined);
  // A structured change (details_json.change, recorded by `experiments specify-change`) is the exact change and wins.
  set('title', s?.proposedTitle ?? pickString(d, 'proposedTitle', 'newTitle'));
  set('metaDescription', s?.proposedMetaDescription ?? pickString(d, 'proposedMetaDescription', 'newMetaDescription'));
  set('bodyMarkdown', s?.proposedSectionMarkdown ?? pickString(d, 'proposedContentMarkdown', 'proposedSectionMarkdown', 'bodyMarkdown'));
  set('canonical', pickString(d, 'proposedCanonical'));
  set('robots', pickString(d, 'proposedRobots'));
  set('redirectTo', s?.redirectTo ?? pickString(d, 'redirectTo', 'redirectTarget'));
  if (Array.isArray(d.internalLinks)) set('internalLinks', d.internalLinks);
  if (d.structuredData !== undefined && d.structuredData !== null) set('structuredData', d.structuredData);
  return canonicalChange(change as Record<string, unknown>) as ContentChange;
}

// ------------------------------------------------------------------ investigations vs changes

/**
 * Recommendation action types that describe an audit, investigation, or
 * review, NOT a production change (src/seo/recommend.ts ACTION_TYPE). Their
 * proposed_change is an instruction to a human ("compare intent ... then
 * propose ONE specific change"), so it can never be hashed, approved,
 * exported, or tested as "the exact change". The owner first records ONE
 * concrete change (`experiments specify-change`), which becomes a new
 * recommendation revision carrying a structured `details_json.change`.
 */
export const INVESTIGATION_ACTION_TYPES: readonly string[] = [
  'targeted_seo_audit',
  'technical_investigation',
  'title_snippet_investigation',
  'decline_investigation',
  'content_overlap_check',
  'inspect_indexing',
  'conversion_path_review',
  'human_review',
  'archive',
];

/** True for audit/investigation/review action types (also any `*_investigation` and secondary `observation:*` types). */
export function isInvestigationActionType(actionType: string | null | undefined): boolean {
  const a = (actionType ?? '').trim().toLowerCase();
  if (!a) return false;
  if (a.startsWith('observation:')) return true;
  return INVESTIGATION_ACTION_TYPES.includes(a) || /_investigation$/.test(a);
}

export const STRUCTURED_CHANGE_KINDS = ['title', 'meta_description', 'section', 'redirect'] as const;
export type StructuredChangeKind = (typeof STRUCTURED_CHANGE_KINDS)[number];

/**
 * The ONE concrete change recorded for a recommendation revision
 * (`details_json.change`). `title` may carry a meta description as well (one
 * title/meta snippet change); `section` and `redirect` stand alone.
 */
export interface StructuredChange {
  kind: StructuredChangeKind;
  proposedTitle?: string;
  proposedMetaDescription?: string;
  proposedSectionMarkdown?: string;
  redirectTo?: string;
}

/** The structured change in recommendation details, or null when absent or incomplete for its kind. */
export function structuredChangeOf(details: Record<string, unknown> | null | undefined): StructuredChange | null {
  const raw = details?.change;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  const kind = typeof c.kind === 'string' ? (c.kind as StructuredChangeKind) : null;
  if (!kind || !(STRUCTURED_CHANGE_KINDS as readonly string[]).includes(kind)) return null;
  const out: StructuredChange = { kind };
  const title = pickString(c, 'proposedTitle');
  const meta = pickString(c, 'proposedMetaDescription');
  const section = pickString(c, 'proposedSectionMarkdown');
  const redirect = pickString(c, 'redirectTo');
  switch (kind) {
    case 'title':
      if (!title) return null;
      out.proposedTitle = title;
      if (meta) out.proposedMetaDescription = meta;
      break;
    case 'meta_description':
      if (!meta) return null;
      out.proposedMetaDescription = meta;
      break;
    case 'section':
      if (!section) return null;
      out.proposedSectionMarkdown = section;
      break;
    case 'redirect':
      if (!redirect) return null;
      out.redirectTo = redirect;
      break;
  }
  return out;
}

/** Experiment type implied by a structured change. */
export function experimentTypeForStructuredChange(s: StructuredChange): 'title_meta' | 'content_section' | 'technical' {
  return s.kind === 'section' ? 'content_section' : s.kind === 'redirect' ? 'technical' : 'title_meta';
}

/**
 * Refuse a production-bound recommendation whose action type is an
 * audit/investigation unless its details carry a structured change. A
 * no-action decision record is never refused here (it is not a change).
 */
export function assertConcreteRecommendation(rec: Pick<RecommendationRow, 'id' | 'kind' | 'action_type' | 'details_json'>, use: string): void {
  if (isNoActionRecommendation(rec)) return;
  if (!isInvestigationActionType(rec.action_type)) return;
  if (structuredChangeOf(recommendationDetails(rec as RecommendationRow))) return;
  throw new AppError('VALIDATION_FAILED', `Recommendation ${rec.id} is an investigation ("${rec.action_type}"), not a concrete change; it cannot ${use}.`, {
    details: { recommendationId: rec.id, actionType: rec.action_type, reason: 'investigation_not_change' },
    hint: `Do the investigation first, then record ONE concrete change as a new revision: \`experiments specify-change ${rec.id} --title "<new title>" [--meta "<new meta description>"] --by "<your name>"\` (or --section-file <file.md>, or --redirect-to <url>). Use the new recommendation id it prints.`,
  });
}

/** Recommendation kinds that are decisions, not changes (schema: recommendations.kind). */
export const NO_ACTION_KINDS: readonly string[] = ['no_action', 'collect_more_evidence'];

/**
 * True when a recommendation proposes no production change. Decided by the
 * KIND only: a primary/secondary/repair_measurement recommendation with an
 * empty or "none" action type fails closed (it is still a production change
 * that needs an approval), it never fails open.
 */
export function isNoActionRecommendation(rec: Pick<RecommendationRow, 'kind'>): boolean {
  return NO_ACTION_KINDS.includes(rec.kind);
}

/** Structured fields of a change that would alter production if deployed. */
export const PRODUCTION_FIELDS = ['title', 'metaDescription', 'bodyMarkdown', 'canonical', 'robots', 'redirectTo', 'slug', 'internalLinks', 'structuredData'] as const;

export function productionFieldsOf(change: ContentChange): string[] {
  return PRODUCTION_FIELDS.filter((k) => change[k] !== undefined);
}

/** The strongest action type implied by the structured fields of a change. */
export function impliedActionType(change: ContentChange): ApprovalActionType {
  if (change.redirectTo) return 'redirect';
  if (change.robots) return 'robots_change';
  if (change.canonical) return 'canonical_change';
  if (change.bodyMarkdown || change.internalLinks || change.structuredData !== undefined) return 'update_page';
  if (change.title || change.metaDescription) return 'title_meta_change';
  return 'update_page';
}

/**
 * Approval action type of a production recommendation.
 *
 * A recorded structured change (`details_json.change`, written by
 * `experiments specify-change`) is the exact change, so the type is implied by
 * it, whatever the row's label says: a title recorded for a
 * `repair_measurement` recommendation is a title/meta change, never an
 * analytics change. Otherwise a recognized action_type maps directly; an
 * investigation label with production fields is typed by those fields; an
 * empty, "none", or "no_action" action type on a production kind fails closed
 * to the type implied by its structured fields (update_page when nothing more
 * specific is implied). Every result is a production action type (EXECUTE +
 * approval).
 *
 * `details_json` is optional for backward compatibility; without it only the
 * label and the change fields are consulted.
 */
export function recommendationActionType(rec: Pick<RecommendationRow, 'action_type'> & Partial<Pick<RecommendationRow, 'details_json'>>, change: ContentChange): ApprovalActionType {
  const a = (rec.action_type ?? '').trim().toLowerCase();
  const hasFields = productionFieldsOf(change).length > 0;
  // A specified revision is typed by its structured change, never by the label it inherited.
  if (hasFields && rec.details_json !== undefined && structuredChangeOf(detailsFromJson(rec.details_json))) return impliedActionType(change);
  // An investigation label says nothing about the change; a specified revision is typed by its structured fields.
  if (isInvestigationActionType(a) && hasFields) return impliedActionType(change);
  if (a && a !== 'none' && a !== 'no_action') return mapToApprovalActionType(a);
  return impliedActionType(change);
}

function detailsFromJson(json: string | null | undefined): Record<string, unknown> {
  const d = parseJson<unknown>(json ?? null, {});
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
}

/** Where a change came from, for label-vs-change warnings (see actionScopeWarnings). */
export interface ActionLabelSource {
  /**
   * Action labels recorded for the source: the row's action_type and, for a
   * specified revision, details_json.originalActionType. Investigation,
   * empty, "none", and "no_action" labels are ignored (they say nothing about
   * the change).
   */
  labels?: ReadonlyArray<string | null | undefined>;
  /** The structured change (details_json.change) the approval type was derived from. */
  structured?: StructuredChange | null;
}

/** Labels and structured change of a recommendation row, for actionScopeWarnings. */
export function recommendationLabelSource(rec: Pick<RecommendationRow, 'action_type' | 'details_json'>): ActionLabelSource {
  const d = detailsFromJson(rec.details_json);
  const original = typeof d.originalActionType === 'string' ? d.originalActionType : null;
  return { labels: [rec.action_type, original], structured: structuredChangeOf(d) };
}

/** Approval action types that legitimately set a page's title or meta description. */
const TITLE_META_SCOPE: readonly ApprovalActionType[] = ['title_meta_change', 'update_page', 'publish_content', 'merge_pages'];
/** Approval action types that legitimately change page content, links, or structured data. */
const CONTENT_SCOPE: readonly ApprovalActionType[] = ['update_page', 'publish_content', 'merge_pages'];

const STRUCTURED_KIND_TEXT: Record<StructuredChangeKind, string> = {
  title: 'title/meta',
  meta_description: 'meta description',
  section: 'content section',
  redirect: 'redirect',
};

/**
 * Warnings when the change reaches beyond its action type, or when the
 * source's action label disagrees with the structured change it is typed by.
 * Labels never weaken the approval (the type comes from the exact change), but
 * a reviewer must see every mismatch: robots, canonical, and redirect fields;
 * title/meta fields under a type that does not set them (e.g.
 * analytics_change); content fields under a title/meta type; and a label such
 * as "repair_measurement" on a revision whose structured change is a title.
 */
export function actionScopeWarnings(actionType: ApprovalActionType, change: ContentChange, source: ActionLabelSource = {}): string[] {
  const out: string[] = [];
  if (change.robots && actionType !== 'robots_change') out.push(`The change also sets a robots directive ("${change.robots}") although its action type is ${actionType}; review it as a robots change.`);
  if (change.canonical && actionType !== 'canonical_change') out.push(`The change also sets a canonical URL (${change.canonical}) although its action type is ${actionType}; review it as a canonical change.`);
  if (change.redirectTo && actionType !== 'redirect') out.push(`The change also sets a redirect (${change.redirectTo}) although its action type is ${actionType}; review it as a redirect.`);
  const titleMeta = [change.title ? 'title' : null, change.metaDescription ? 'meta description' : null].filter((x): x is string => !!x);
  if (titleMeta.length && !TITLE_META_SCOPE.includes(actionType)) out.push(`The change also sets the page ${titleMeta.join(' and ')} although its action type is ${actionType}; review it as a title/meta change.`);
  const content = [change.bodyMarkdown ? 'page content' : null, change.internalLinks ? 'internal links' : null, change.structuredData !== undefined ? 'structured data' : null].filter((x): x is string => !!x);
  if (content.length && !CONTENT_SCOPE.includes(actionType)) out.push(`The change also edits ${content.join(', ')} although its action type is ${actionType}; review it as a page update.`);
  if (source.structured) {
    const seen = new Set<string>();
    for (const raw of source.labels ?? []) {
      const label = (raw ?? '').trim();
      const l = label.toLowerCase();
      if (!l || l === 'none' || l === 'no_action' || isInvestigationActionType(l) || seen.has(l)) continue;
      seen.add(l);
      const labeled = mapToApprovalActionType(l);
      if (labeled !== actionType) {
        out.push(
          `The recommendation label "${label}" (${labeled}) does not match its structured ${STRUCTURED_KIND_TEXT[source.structured.kind]} change; it is reviewed, approved, and exported as ${actionType}, not ${labeled}.`,
        );
      }
    }
  }
  return out;
}
