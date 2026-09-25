import type { AppContext } from '../app/context.js';
import { humanAcceptedDraft, latestQualityReview } from '../content/store.js';
import { AppError } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import { parseJson } from '../database/db.js';
import { getExperiment, getExperimentChange, getPage } from '../experiments/repository.js';
import { isAllowedHost } from '../seo/url.js';
import { canonicalChange } from './artifact.js';
import {
  actionScopeWarnings,
  assertConcreteRecommendation,
  changeFromRecommendation,
  getRecommendation,
  isInvestigationActionType,
  isNoActionRecommendation,
  pickString,
  productionFieldsOf,
  recommendationActionType,
  recommendationDetails,
  recommendationLabelSource,
  structuredChangeOf,
  type ContentChange,
} from './change.js';
import type { CurrentState, DraftHumanReview, ProposalSubjectType, PublishProposal } from './publisher.js';
import type { ApprovalActionType } from './types.js';

/**
 * Resolve an exportable subject (draft, recommendation, experiment) into a
 * PublishProposal read directly from the shared SQLite schema. The proposal
 * content, not the record status, determines the artifact hash.
 */

export const PROPOSAL_SUBJECT_TYPES: readonly ProposalSubjectType[] = ['draft', 'recommendation', 'experiment'];

export function isProposalSubjectType(t: string): t is ProposalSubjectType {
  return (PROPOSAL_SUBJECT_TYPES as readonly string[]).includes(t);
}

/** Latest successful crawl snapshot of a page (by page id or exact URL). */
export function currentStateFor(ctx: AppContext, pageId: string | null, url: string, before?: string): CurrentState {
  const row = ctx.db.get<{
    id: string;
    fetched_at: string;
    title: string | null;
    meta_description: string | null;
    canonical_url: string | null;
    meta_robots: string | null;
    text_ref: string | null;
  }>(
    `SELECT id, fetched_at, title, meta_description, canonical_url, meta_robots, text_ref FROM crawl_results
     WHERE site_id = ? AND (page_id = ? OR final_url = ? OR requested_url = ?) AND status_code BETWEEN 200 AND 299
       ${before ? 'AND fetched_at <= ?' : ''}
     ORDER BY fetched_at DESC LIMIT 1`,
    before ? [ctx.siteId, pageId ?? '', url, url, before] : [ctx.siteId, pageId ?? '', url, url],
  );
  if (!row) {
    return { snapshotRef: null, capturedAt: null, title: null, metaDescription: null, canonical: null, robots: null, text: null, note: 'no successful crawl snapshot of this URL exists' };
  }
  let text: string | null = null;
  if (row.text_ref) {
    try {
      const payload = ctx.raw.load<unknown>(row.text_ref);
      if (typeof payload === 'string') text = payload;
      else if (payload && typeof payload === 'object') text = pickString(payload as Record<string, unknown>, 'text', 'content', 'visibleText') ?? null;
    } catch {
      text = null;
    }
  }
  return {
    snapshotRef: `crawl_result:${row.id}`,
    capturedAt: row.fetched_at,
    title: row.title,
    metaDescription: row.meta_description,
    canonical: row.canonical_url,
    robots: row.meta_robots,
    text,
    note: text === null ? 'page text not available in the raw store' : null,
  };
}

/**
 * A proposal target (possibly model-produced) must be an absolute http(s) URL
 * on one of the site's configured allowedHostnames. An off-site target could
 * otherwise become the bound approval target and be exported.
 */
export function assertOnSiteTarget(ctx: Pick<AppContext, 'config'>, url: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError('VALIDATION_FAILED', `${label} target "${url}" is not an absolute URL.`);
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) {
    throw new AppError('VALIDATION_FAILED', `${label} target "${url}" must be a plain http(s) URL.`);
  }
  if (!isAllowedHost(parsed.href, ctx.config.site.allowedHostnames)) {
    throw new AppError('VALIDATION_FAILED', `${label} target ${parsed.href} is not on this site: host ${parsed.hostname} is not one of site.allowedHostnames (${ctx.config.site.allowedHostnames.join(', ')}).`, {
      hint: 'Approvals and exports only bind targets on the configured site. Fix the target in the source record, or add the host to site.allowedHostnames if it really is your site.',
    });
  }
  return url;
}

/** Warnings for structured fields that point off-site (legitimate sometimes, never silent). */
function offSiteFieldWarnings(ctx: AppContext, change: ContentChange): string[] {
  const out: string[] = [];
  for (const [name, v] of [
    ['redirect target', change.redirectTo],
    ['canonical', change.canonical],
  ] as const) {
    if (v && /^https?:\/\//i.test(v) && !isAllowedHost(v, ctx.config.site.allowedHostnames)) out.push(`The ${name} ${v} is outside the site's allowedHostnames; confirm this cross-domain ${name} is intended.`);
  }
  return out;
}

function siteUrlFor(ctx: AppContext, slugOrPath: string): string {
  return new URL(slugOrPath.startsWith('/') ? slugOrPath : `/${slugOrPath.replace(/^\/+/, '')}`, ctx.config.site.url).href;
}

// ------------------------------------------------------------ drafts

const EXPORTABLE_DRAFT_STATUSES = ['review_passed', 'approved', 'exported', 'published'];

const BODY_KEYS = ['bodyMarkdown', 'body', 'markdown'] as const;

function nestedContent(pkg: Record<string, unknown>): Record<string, unknown> {
  return (pkg.content && typeof pkg.content === 'object' ? (pkg.content as Record<string, unknown>) : {}) as Record<string, unknown>;
}

/** The body a draft package exports (trimmed, as bound into the artifact). */
export function draftPackageBody(pkg: Record<string, unknown>): string | undefined {
  return pickString(pkg, ...BODY_KEYS) ?? pickString(nestedContent(pkg), ...BODY_KEYS) ?? (typeof pkg.content === 'string' ? pkg.content : undefined);
}

/**
 * The same field as draftPackageBody, untrimmed: the exact string a reviewer
 * accepted (`content mark-reviewed` hashes the stored body as is).
 */
export function draftPackageRawBody(pkg: Record<string, unknown>): string | undefined {
  const raw = (o: Record<string, unknown>): string | undefined => {
    for (const k of BODY_KEYS) {
      const v = o[k];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return undefined;
  };
  return raw(pkg) ?? raw(nestedContent(pkg)) ?? (typeof pkg.content === 'string' ? pkg.content : undefined);
}

/**
 * The recorded human acceptance of a draft's EXACT body: the draft's latest
 * quality review must be a named human's acceptance (`content mark-reviewed`,
 * read through the content module's humanAcceptedDraft) of the SHA-256 of the
 * stored body that would be exported (`body`: draftPackageRawBody, untrimmed,
 * as the reviewer confirmed it). An automated verdict ('pass' included), an
 * acceptance of an earlier body, or a later automated re-review does not count.
 */
export function draftHumanReview(ctx: Pick<AppContext, 'db' | 'siteId'>, draftId: string, body: string): DraftHumanReview {
  const bodyHash = sha256(body);
  const latest = latestQualityReview(ctx.db, ctx.siteId, 'draft', draftId);
  const human = (latest?.checks as { humanReview?: { reviewer?: unknown; bodyHash?: unknown } } | null | undefined)?.humanReview;
  if (latest && humanAcceptedDraft(ctx.db, ctx.siteId, draftId, bodyHash)) {
    return { accepted: true, reviewer: typeof human?.reviewer === 'string' ? human.reviewer : null, reviewId: latest.id, reviewedAt: latest.createdAt, bodyHash, reason: null };
  }
  let reason: string;
  if (!latest) reason = 'no review of this draft is recorded, and no named human accepted its body';
  else if (human && human.bodyHash !== bodyHash) reason = `the recorded human acceptance (review ${latest.id}) is for a different body than the one that would be exported`;
  else if (human) reason = `the latest human review (${latest.id}) is not an acceptance (verdict ${latest.verdict})`;
  else reason = `the latest review (${latest.id}, verdict ${latest.verdict}) is automated; no named human accepted this exact body since`;
  return { accepted: false, reviewer: null, reviewId: null, reviewedAt: null, bodyHash, reason };
}

function firstTitle(v: unknown): string | undefined {
  if (!Array.isArray(v)) return undefined;
  for (const x of v) {
    if (typeof x === 'string' && x.trim()) return x.trim();
    if (x && typeof x === 'object' && typeof (x as { title?: unknown }).title === 'string') return ((x as { title: string }).title).trim();
  }
  return undefined;
}

function draftProposal(ctx: AppContext, id: string): PublishProposal {
  const d = ctx.db.get<{
    id: string;
    content_item_id: string;
    brief_id: string;
    brief_version: number;
    brief_hash: string;
    version: number;
    status: string;
    package_json: string;
    body_hash: string;
    unresolved_facts: number;
  }>('SELECT id, content_item_id, brief_id, brief_version, brief_hash, version, status, package_json, body_hash, unresolved_facts FROM content_drafts WHERE site_id = ? AND id = ?', [ctx.siteId, id]);
  if (!d) throw new AppError('NOT_FOUND', `Draft ${id} not found for site ${ctx.siteId}.`);
  if (!EXPORTABLE_DRAFT_STATUSES.includes(d.status)) {
    throw new AppError('VALIDATION_FAILED', `Draft ${id} is "${d.status}"; only drafts that passed review (${EXPORTABLE_DRAFT_STATUSES.join(', ')}) can be exported for publication.`);
  }
  if (d.unresolved_facts > 0) {
    throw new AppError('VALIDATION_FAILED', `Draft ${id} has ${d.unresolved_facts} unresolved fact(s); publication is blocked until they are resolved.`);
  }
  const item = ctx.db.get<{ id: string; title: string; target_page_id: string | null; is_synthetic: number }>('SELECT id, title, target_page_id, is_synthetic FROM content_items WHERE site_id = ? AND id = ?', [
    ctx.siteId,
    d.content_item_id,
  ]);
  const brief = ctx.db.get<{ brief_json: string }>('SELECT brief_json FROM content_briefs WHERE site_id = ? AND id = ?', [ctx.siteId, d.brief_id]);
  const pkg = parseJson<Record<string, unknown>>(d.package_json, {});
  const briefJson = parseJson<Record<string, unknown>>(brief?.brief_json, {});
  const body = draftPackageBody(pkg);
  if (!body) throw new AppError('VALIDATION_FAILED', `Draft ${id} package has no body content to export.`);
  const warnings: string[] = [];
  let title = pickString(pkg, 'selectedTitle', 'title');
  if (!title) {
    title = firstTitle(pkg.titleOptions) ?? firstTitle(pkg.titles);
    if (title) warnings.push('No title was selected in the draft package; the first title option is used. Choosing another title changes the artifact and needs a new approval.');
  }
  const meta = pickString(pkg, 'metaDescription', 'meta_description') ?? (pkg.meta && typeof pkg.meta === 'object' ? pickString(pkg.meta as Record<string, unknown>, 'description') : undefined);
  const slug = pickString(pkg, 'slug', 'slugSuggestion') ?? firstTitle(pkg.slugSuggestions);
  const targetPage = item?.target_page_id ? getPage(ctx.db, ctx.siteId, item.target_page_id) : null;
  let targetUrl = targetPage?.url ?? pickString(pkg, 'proposedUrl', 'targetUrl') ?? pickString(briefJson, 'proposedUrl', 'targetUrl');
  if (!targetUrl && slug) targetUrl = siteUrlFor(ctx, slug);
  if (!targetUrl) throw new AppError('VALIDATION_FAILED', `Draft ${id} has no target page, proposed URL, or slug.`);
  assertOnSiteTarget(ctx, targetUrl, `Draft ${id}`);
  const change: ContentChange = canonicalChange({
    title,
    metaDescription: meta,
    bodyMarkdown: body,
    slug,
    internalLinks: Array.isArray(pkg.internalLinks) ? pkg.internalLinks : Array.isArray(pkg.internalLinkSuggestions) ? pkg.internalLinkSuggestions : undefined,
    structuredData: pkg.structuredData ?? pkg.structuredDataProposal ?? undefined,
  }) as ContentChange;
  const actionType = targetPage ? 'update_page' : 'publish_content';
  warnings.push(...actionScopeWarnings(actionType, change), ...offSiteFieldWarnings(ctx, change));
  return {
    siteId: ctx.siteId,
    subjectType: 'draft',
    subjectId: d.id,
    actionType,
    productionBound: true,
    targetUrl,
    pageId: targetPage?.id ?? null,
    title: title ?? item?.title ?? d.id,
    summary: `${actionType === 'publish_content' ? 'Publish new page' : 'Update page'} ${targetUrl} from draft ${d.id} v${d.version} (brief ${d.brief_id} v${d.brief_version}).`,
    change,
    current: currentStateFor(ctx, targetPage?.id ?? null, targetUrl),
    rollbackPlan: targetPage
      ? 'Restore the previous page content from the before-snapshot/source revision.'
      : 'Unpublish the new page (itself a production change needing approval) or keep it and record the decision.',
    context: {
      contentItemId: d.content_item_id,
      draftVersion: d.version,
      briefId: d.brief_id,
      briefVersion: d.brief_version,
      briefHash: d.brief_hash,
      bodyHash: d.body_hash,
      titleOptions: pkg.titleOptions ?? null,
      sourceLedger: pkg.sourceLedger ?? null,
      factCheckNotes: pkg.factCheckNotes ?? null,
    },
    isSynthetic: ctx.synthetic || item?.is_synthetic === 1,
    warnings,
    humanReview: draftHumanReview(ctx, d.id, draftPackageRawBody(pkg) ?? body),
  };
}

// ------------------------------------------------------------ recommendations

function recommendationProposal(ctx: AppContext, id: string): PublishProposal {
  const rec = getRecommendation(ctx.db, ctx.siteId, id);
  if (!rec) throw new AppError('NOT_FOUND', `Recommendation ${id} not found for site ${ctx.siteId}.`);
  if (['rejected', 'withdrawn', 'superseded'].includes(rec.status)) throw new AppError('VALIDATION_FAILED', `Recommendation ${id} is ${rec.status} and cannot be exported for implementation.`);
  // An audit/investigation instruction is not an exact change: never approved, exported, or recorded as implemented.
  assertConcreteRecommendation(rec, 'be approved, exported, or recorded as a production change');
  const details = recommendationDetails(rec);
  const page = rec.page_id ? getPage(ctx.db, ctx.siteId, rec.page_id) : null;
  const noAction = isNoActionRecommendation(rec);
  const change = changeFromRecommendation(rec);
  if (noAction) {
    // A decision record may explain itself in text, but it can never carry a production change.
    const fields = productionFieldsOf(change);
    if (fields.length) {
      throw new AppError('VALIDATION_FAILED', `Recommendation ${id} is a "${rec.kind}" decision but carries production change fields (${fields.join(', ')}).`, {
        hint: 'A no-action record cannot be exported with production changes. Fix the recommendation (kind or details) at its source; a production change needs a production kind and an approval.',
      });
    }
  }
  const targetUrl = pickString(details, 'targetUrl') ?? page?.url ?? (noAction ? ctx.config.site.url : undefined);
  if (!targetUrl) throw new AppError('VALIDATION_FAILED', `Recommendation ${id} has no page or target URL.`);
  if (!noAction) assertOnSiteTarget(ctx, targetUrl, `Recommendation ${id}`);
  if (!noAction && !change.instructions) throw new AppError('VALIDATION_FAILED', `Recommendation ${id} has no exact proposed change.`);
  const actionType = recommendationActionType(rec, change);
  const warnings: string[] = rec.risks ? [] : ['The recommendation does not state risks.'];
  if (!noAction) {
    const a = (rec.action_type ?? '').trim().toLowerCase();
    if (!a || a === 'none' || a === 'no_action') warnings.push(`The recommendation is a "${rec.kind}" change without a usable action type ("${rec.action_type}"); it is treated as ${actionType} (fail closed) and needs an approval.`);
    warnings.push(...actionScopeWarnings(actionType, change, recommendationLabelSource(rec)), ...offSiteFieldWarnings(ctx, change));
  }
  return {
    siteId: ctx.siteId,
    subjectType: 'recommendation',
    subjectId: rec.id,
    actionType,
    productionBound: !noAction,
    targetUrl,
    pageId: page?.id ?? null,
    title: rec.title,
    summary: noAction ? `${rec.kind} decision: ${rec.title}. No production change.` : `${rec.title}: ${change.instructions}`,
    change,
    current: currentStateFor(ctx, page?.id ?? null, targetUrl),
    rollbackPlan: pickString(details, 'rollbackPlan') ?? 'Revert to the before-snapshot / source revision recorded at implementation.',
    context: {
      kind: rec.kind,
      actionType: rec.action_type,
      query: rec.query,
      diagnosis: rec.diagnosis,
      hypothesis: rec.hypothesis,
      successCriteria: rec.success_criteria,
      risks: rec.risks,
      reviewDate: rec.review_date,
      promptVersion: rec.prompt_version,
      modelId: rec.model_id,
      scoringVersion: rec.scoring_version,
    },
    isSynthetic: ctx.synthetic,
    warnings,
  };
}

// ------------------------------------------------------------ experiments

function experimentProposal(ctx: AppContext, id: string): PublishProposal {
  const exp = getExperiment(ctx.db, ctx.siteId, id);
  const change = getExperimentChange(ctx.db, ctx.siteId, id);
  if (!change) throw new AppError('DATA_UNAVAILABLE', `Experiment ${id} has no recorded exact change.`);
  if (change.changeHash !== exp.changeHash) throw new AppError('CONFLICT', `Experiment ${id} change hash does not match its recorded change.`);
  assertOnSiteTarget(ctx, change.targetUrl, `Experiment ${id}`);
  const typed = change.change as ContentChange;
  // An experiment recorded (before this check existed) from an audit/investigation
  // instruction has no concrete change to approve or export.
  const source = exp.recommendationId ? getRecommendation(ctx.db, ctx.siteId, exp.recommendationId) : null;
  if (source && isInvestigationActionType(source.action_type) && productionFieldsOf(typed).length === 0) {
    throw new AppError('VALIDATION_FAILED', `Experiment ${id} records an investigation instruction ("${source.action_type}" from recommendation ${source.id}), not a concrete change; it cannot be approved or exported.`, {
      details: { experimentId: id, recommendationId: source.id, actionType: source.action_type, reason: 'investigation_not_change' },
      hint: `Cancel it (\`experiments cancel ${id} --reason "no concrete change"\`), record ONE concrete change with \`experiments specify-change ${source.id} ... --by "<your name>"\`, and propose an experiment from the new revision.`,
    });
  }
  // The structured change the experiment recorded, with its source recommendation's labels (a label that disagrees is flagged).
  const structured = structuredChangeOf({ change: (exp.evidence as { structuredChange?: unknown }).structuredChange });
  const labelSource = source ? { ...recommendationLabelSource(source), ...(structured ? { structured } : {}) } : {};
  const warnings = [...actionScopeWarnings(change.actionType as ApprovalActionType, typed, labelSource), ...offSiteFieldWarnings(ctx, typed)];
  return {
    siteId: ctx.siteId,
    subjectType: 'experiment',
    subjectId: exp.id,
    actionType: change.actionType as ApprovalActionType,
    productionBound: true,
    targetUrl: change.targetUrl,
    pageId: exp.pageId,
    title: `${exp.type} ${change.targetUrl}`,
    summary: `Experiment ${exp.id}: ${exp.proposedChange}\n\nHypothesis: ${exp.hypothesis}`,
    change: change.change as ContentChange,
    current: currentStateFor(ctx, exp.pageId, change.targetUrl),
    rollbackPlan: exp.rollbackPlan,
    context: {
      hypothesis: exp.hypothesis,
      primaryMetric: exp.primaryMetric,
      outcomeKind: exp.outcomeKind,
      guardrails: exp.guardrails,
      minObservationDays: exp.minObservationDays,
      risks: exp.risks,
      reviewDate: exp.reviewDate,
      recommendationId: exp.recommendationId,
    },
    isSynthetic: ctx.synthetic || (exp.evidence as { isSynthetic?: boolean }).isSynthetic === true,
    warnings,
  };
}

export function resolveProposal(ctx: AppContext, subjectType: string, subjectId: string): PublishProposal {
  switch (subjectType) {
    case 'draft':
      return draftProposal(ctx, subjectId);
    case 'recommendation':
      return recommendationProposal(ctx, subjectId);
    case 'experiment':
      return experimentProposal(ctx, subjectId);
    default:
      throw new AppError('VALIDATION_FAILED', `Unsupported subject type "${subjectType}". Use one of ${PROPOSAL_SUBJECT_TYPES.join(', ')}.`);
  }
}
