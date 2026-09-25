import type { AppContext } from '../app/context.js';
import type { ApprovalRecord } from '../approvals/types.js';
import { AppError } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import { modeAtLeast } from '../core/modes.js';
import { briefHash } from './brief.js';
import { factNoteSupport, normalizeFactNoteId, ownerStatements } from './claims.js';
import type { ContentDeps } from './deps.js';
import { humanName } from './publication.js';
import { DraftNeedsReviewError, generateDraft, reviseDraft, type DraftModelReview, type DraftOptions, type DraftPreconditions } from './draft.js';
import { AI_REVIEW_DISCLAIMER, computeVerdict, factNoteSources, loadQualityInputs, QUALITY_GATE_VERSION, runAiReview, runDeterministicChecks, type QualityInputs } from './quality.js';
import { audit, briefTemplateId, getBrief, getDraft, getItem, insertDraft, insertQualityReview, latestDraft, latestQualityReview, sameTemplateDrafts, setDraftStatus, siblingDrafts, updateItem } from './store.js';
import { normalizeText, stripUnverifiedMarkers, truncate, unverifiedMarkers } from './text.js';
import {
  factResolutionInputSchema,
  type AiReviewRecord,
  type ContentStage,
  type DraftPackage,
  type DraftRecord,
  type DraftStatus,
  type FactCheckNote,
  type FactResolutionInput,
  type FactResolutionSourceKind,
  type HumanFactResolution,
  type QualityCheck,
  type QualityReason,
  type QualityReviewResult,
  type Verdict,
} from './types.js';

/**
 * Review orchestration: deterministic checks + bounded AI review -> verdict,
 * persisted in quality_reviews, with at most `content.maxAutomatedRevisions`
 * (hard cap 2) automated revision loops. Every verdict still requires human
 * review before publication.
 */

const STATUS_BY_VERDICT: Record<Verdict, DraftStatus> = {
  pass: 'review_passed',
  needs_revision: 'needs_revision',
  needs_human_review: 'needs_human_review',
  reject: 'rejected',
};

export function maxRevisions(ctx: AppContext): number {
  return Math.min(2, ctx.config.content.maxAutomatedRevisions);
}

export interface ReviewOptions {
  useModel?: boolean;
  /** Do not persist, do not call a model. */
  preview?: boolean;
  /** Override sibling drafts used for template-similarity (batch runs pass their siblings). */
  siblings?: QualityInputs['siblings'];
}

/** Draft statuses a (persisted) review may change. Rejected is sticky; superseded/approved/exported/published are final. */
export const REVIEWABLE_DRAFT_STATUSES: readonly DraftStatus[] = ['draft', 'needs_revision', 'needs_human_review', 'review_passed'];
const LOCKED_ITEM_STAGES: readonly ContentStage[] = ['approved', 'exported', 'published', 'measuring', 'rejected'];

/**
 * Why a persisted review of this draft is not allowed (null when it is). Only
 * the latest draft of an item, in a reviewable status, of an item that is not
 * approved/exported/published/measuring/rejected, may have its status and the
 * item stage changed by a review.
 */
export function reviewRefusal(ctx: AppContext, draft: DraftRecord): string | null {
  const latest = latestDraft(ctx.db, ctx.siteId, draft.contentItemId);
  if (latest && latest.id !== draft.id) return `Draft ${draft.id} is not the latest draft of its item (latest: ${latest.id}, v${latest.version}).`;
  if (!REVIEWABLE_DRAFT_STATUSES.includes(draft.status)) {
    return draft.status === 'rejected'
      ? `Draft ${draft.id} was rejected by the quality gate; a reject verdict is final (a human may create a new brief/draft instead).`
      : `Draft ${draft.id} is "${draft.status}"; its status is final and a review cannot change it.`;
  }
  const item = getItem(ctx.db, ctx.siteId, draft.contentItemId);
  if (item && LOCKED_ITEM_STAGES.includes(item.stage)) return `Content item ${item.id} is "${item.stage}"; a review cannot move it back.`;
  return null;
}

/** Sibling drafts for the template-similarity check: latest draft of every other item (rejected included) plus every draft sharing the programmatic template. */
export function reviewSiblings(ctx: AppContext, draft: DraftRecord): QualityInputs['siblings'] {
  const out = new Map<string, QualityInputs['siblings'][number]>();
  for (const d of siblingDrafts(ctx.db, ctx.siteId, draft.contentItemId)) out.set(d.id, { draftId: d.id, itemId: d.contentItemId, body: d.pkg.body, templateId: briefTemplateId(ctx.db, ctx.siteId, d.briefId) });
  const tpl = briefTemplateId(ctx.db, ctx.siteId, draft.briefId);
  if (tpl) for (const d of sameTemplateDrafts(ctx.db, ctx.siteId, draft.contentItemId, tpl)) if (!out.has(d.id)) out.set(d.id, { draftId: d.id, itemId: d.contentItemId, body: d.pkg.body, templateId: tpl });
  return [...out.values()];
}

export async function reviewDraft(ctx: AppContext, deps: ContentDeps, draftId: string, opts: ReviewOptions = {}): Promise<QualityReviewResult> {
  const draft = getDraft(ctx.db, ctx.siteId, draftId);
  if (!draft) throw new AppError('NOT_FOUND', `Draft ${draftId} not found for site ${ctx.siteId}`);
  const brief = getBrief(ctx.db, ctx.siteId, draft.briefId);
  if (!brief) throw new AppError('NOT_FOUND', `Brief ${draft.briefId} for draft ${draftId} not found`);
  const preview = opts.preview || ctx.dryRun;
  const refusal = reviewRefusal(ctx, draft);
  if (refusal && !preview) {
    throw new AppError('CONFLICT', refusal, { hint: `Use --dry-run to preview the quality checks without changing draft or item state (\`content review ${draftId} --dry-run\`).` });
  }
  const siblings = [...(opts.siblings ?? []), ...reviewSiblings(ctx, draft).filter((x) => !(opts.siblings ?? []).some((o) => o.draftId === x.draftId || o.itemId === x.itemId))];
  const inputs = loadQualityInputs(ctx, brief.brief, draft.pkg, siblings.filter((s) => s.itemId !== draft.contentItemId));
  const checks = runDeterministicChecks(ctx, inputs, { revisionRound: draft.revisionRound });
  const ai = await runAiReview(ctx, deps.llm, inputs, checks, { ...(opts.useModel !== undefined ? { useModel: opts.useModel } : {}), preview: !!preview });
  const { verdict, reasons, revisionLimitReached } = computeVerdict(checks, ai, draft.revisionRound, maxRevisions(ctx), { humanAuthored: !!draft.pkg.humanRevision });
  let reviewId: string | null = null;
  if (!preview) {
    const now = ctx.clock.now().toISOString();
    reviewId = ctx.db.transaction(() => {
      const id = insertQualityReview(ctx.db, {
        siteId: ctx.siteId,
        subjectType: 'draft',
        subjectId: draftId,
        verdict,
        deterministic: { gateVersion: QUALITY_GATE_VERSION, checks },
        aiReview: ai,
        reasons,
        revisionRound: draft.revisionRound,
        now,
      });
      setDraftStatus(ctx.db, ctx.siteId, draftId, STATUS_BY_VERDICT[verdict]);
      const item = getItem(ctx.db, ctx.siteId, draft.contentItemId);
      if (item) {
        if (verdict === 'reject') {
          updateItem(ctx.db, ctx.siteId, item.id, { stage: 'rejected', decisionReason: `${item.decisionReason ?? ''} | [quality gate] draft ${draftId} rejected: ${truncate(reasons.filter((r) => r.consequence === 'reject').map((r) => r.message).join('; '), 400)}`.trim() }, now);
        } else updateItem(ctx.db, ctx.siteId, item.id, { stage: verdict === 'needs_revision' ? 'quality_checked' : 'in_review' }, now);
      }
      audit(ctx.db, ctx.siteId, 'content.quality_review', 'content_draft', draftId, { verdict, revisionRound: draft.revisionRound, reasons: reasons.map((r) => r.code), aiReview: ai.status }, ctx.clock.now());
      return id;
    });
  }
  return {
    reviewId,
    subjectType: 'draft',
    subjectId: draftId,
    verdict,
    checks,
    aiReview: ai,
    reasons,
    revisionRound: draft.revisionRound,
    revisionLimitReached,
    humanReviewRequiredForPublication: true,
  };
}

export interface DraftCycleResult {
  drafts: DraftRecord[];
  reviews: QualityReviewResult[];
  finalDraft: DraftRecord;
  finalReview: QualityReviewResult;
  approvalConsumed: ApprovalRecord | null;
  preconditions: DraftPreconditions;
  revisionsUsed: number;
}

/**
 * Review a draft and, when allowed, run automated revision loops up to the cap.
 * When a revision's model output needs human review (it failed validation
 * after the controlled repairs), the loop stops and `modelReview` carries the
 * call id and raw output for the reviewer; the draft keeps its last verdict.
 */
export async function reviewWithRevisions(
  ctx: AppContext,
  deps: ContentDeps,
  draftId: string,
  opts: ReviewOptions & { revise?: boolean } = {},
): Promise<{ drafts: DraftRecord[]; reviews: QualityReviewResult[]; modelReview?: DraftModelReview }> {
  const drafts: DraftRecord[] = [];
  const reviews: QualityReviewResult[] = [];
  let current = getDraft(ctx.db, ctx.siteId, draftId);
  if (!current) throw new AppError('NOT_FOUND', `Draft ${draftId} not found`);
  let review = await reviewDraft(ctx, deps, current.id, opts);
  reviews.push(review);
  const cap = maxRevisions(ctx);
  while (opts.revise !== false && review.verdict === 'needs_revision' && current.revisionRound < cap && !opts.preview && !ctx.dryRun) {
    try {
      current = await reviseDraft(ctx, deps, current.id, review.reasons);
    } catch (err) {
      if (err instanceof DraftNeedsReviewError) return { drafts, reviews, modelReview: err.review };
      throw err;
    }
    drafts.push(current);
    review = await reviewDraft(ctx, deps, current.id, opts);
    reviews.push(review);
  }
  return { drafts, reviews };
}

/** Full authorized draft cycle: generate -> review -> bounded automated revisions. */
export async function draftAndReview(ctx: AppContext, deps: ContentDeps, itemId: string, opts: DraftOptions & ReviewOptions & { revise?: boolean } = {}): Promise<DraftCycleResult> {
  const gen = await generateDraft(ctx, deps, itemId, opts);
  const cycle = await reviewWithRevisions(ctx, deps, gen.draft.id, opts);
  const drafts = [gen.draft, ...cycle.drafts];
  const finalDraft = getDraft(ctx.db, ctx.siteId, drafts[drafts.length - 1]!.id)!;
  return {
    drafts,
    reviews: cycle.reviews,
    finalDraft,
    finalReview: cycle.reviews[cycle.reviews.length - 1]!,
    approvalConsumed: gen.approvalConsumed,
    preconditions: gen.preconditions,
    revisionsUsed: cycle.drafts.length,
  };
}

export function latestDraftForItem(ctx: AppContext, itemId: string): DraftRecord | null {
  return latestDraft(ctx.db, ctx.siteId, itemId);
}

/**
 * The latest persisted quality review of a draft as a QualityReviewResult
 * (used after a durable job ran the review). Null when none is stored.
 */
export function storedReviewResult(ctx: AppContext, draftId: string): QualityReviewResult | null {
  const row = latestQualityReview(ctx.db, ctx.siteId, 'draft', draftId);
  if (!row) return null;
  const det = row.checks as { checks?: QualityCheck[] } | QualityCheck[] | null;
  const checks = Array.isArray(det) ? det : (det?.checks ?? []);
  const reasons = (row.reasons ?? []) as QualityReason[];
  const ai = (row.aiReview as AiReviewRecord | null) ?? { status: 'skipped', reason: 'not recorded with this review', output: null, droppedIssues: 0, promptVersion: null, model: null, costMicros: null, disclaimer: '' };
  return {
    reviewId: row.id,
    subjectType: 'draft',
    subjectId: draftId,
    verdict: row.verdict,
    checks,
    aiReview: ai,
    reasons,
    revisionRound: row.revisionRound,
    revisionLimitReached: reasons.some((r) => r.code === 'revision_limit'),
    humanReviewRequiredForPublication: true,
  };
}

// ---------------------------------------------------------------------------
// Human revision (`content revise-manual`)
// ---------------------------------------------------------------------------

/** Largest edited body accepted from a human (characters). */
export const MAX_HUMAN_BODY_CHARS = 500_000;

export interface ManualRevisionInput {
  /** The complete edited body (Markdown), exactly as it should be stored and hashed. */
  body: string;
  /** Named author of this version (recorded on the draft and as the audit actor). */
  reviewer: string;
  /**
   * One entry per resolved fact. Every `[[UNVERIFIED: ...]]` marker the edited
   * body no longer contains needs one, with a source.
   */
  resolutions?: FactResolutionInput[];
  note?: string | null;
  /** Sibling drafts for the template-similarity check (default: reviewSiblings). */
  siblings?: QualityInputs['siblings'];
}

export interface ManualRevisionResult {
  /** True under --dry-run: nothing was stored. */
  preview: boolean;
  /** The validated author name (recorded on the version and as the audit actor `owner:<name>`). */
  reviewer: string;
  previousDraftId: string;
  /** The stored human-authored version (null in a preview). */
  draft: DraftRecord | null;
  pkg: DraftPackage;
  bodyHash: string;
  /** Deterministic gates on the edited version (no model call). */
  review: QualityReviewResult;
  markersBefore: string[];
  markersAfter: string[];
  removedMarkers: string[];
  addedMarkers: string[];
  resolutions: HumanFactResolution[];
  warnings: string[];
}

/** Distinct `[[UNVERIFIED: ...]]` marker texts (normalized comparison), in order of appearance. */
function distinctMarkers(text: string): string[] {
  const out = new Map<string, string>();
  for (const m of unverifiedMarkers(text)) {
    const k = normalizeText(m);
    if (k && !out.has(k)) out.set(k, m);
  }
  return [...out.values()];
}

/** Whether a statement appears (outside markers) in a normalized body, on word boundaries. */
function bodyContains(normalizedPlainBody: string, statement: string): boolean {
  const n = normalizeText(statement);
  return !!n && ` ${normalizedPlainBody} `.includes(` ${n} `);
}

/** Classify a resolution source: a configured product fact, another owner statement, a brief evidence id, or text the human supplied. */
function resolutionSource(ctx: AppContext, source: string, evidenceIds: ReadonlySet<string>, productFactIds: ReadonlySet<string>): { kind: FactResolutionSourceKind; id: string | null } {
  const id = normalizeFactNoteId(source, productFactIds);
  if (id.startsWith('fact:') && productFactIds.has(id.slice('fact:'.length))) return { kind: 'product_fact', id };
  if (ownerStatements(ctx.config).some((s) => s.id === id)) return { kind: 'owner_statement', id };
  if (evidenceIds.has(id)) return { kind: 'brief_evidence', id };
  return { kind: 'human_supplied', id: null };
}

/**
 * Record a human-edited body as a NEW draft version (spec 21/22: unresolved
 * facts are resolved by a human, never by the model). The edited body is
 * stored exactly as given; its `[[UNVERIFIED: ...]]` markers are recounted;
 * every marker the edit removed needs a resolution (`confirmed`: the statement
 * stays, unmarked, with the source that confirms it; `removed`: the statement
 * is gone from the body) or the revision is refused; the deterministic quality
 * gates re-run on the new version (no model call: the AI review is recorded
 * as skipped, so the best verdict is needs_human_review). The version records
 * its author (`pkg.humanRevision`), the previous draft supersedes, and the
 * change is audited with the author as actor. Automated revisions never
 * rewrite a human-authored version; publication still needs `content
 * mark-reviewed`, an approval, and `export draft`.
 *
 * Refused unless the runtime mode is DRAFT or higher (a local review artifact)
 * and the draft is the latest, reviewable version of an item that is not
 * approved/exported/published/measuring/rejected. Under --dry-run
 * (`ctx.dryRun`) it validates and runs the gates but stores nothing.
 */
export function reviseDraftManually(ctx: AppContext, draftId: string, input: ManualRevisionInput): ManualRevisionResult {
  const draft = getDraft(ctx.db, ctx.siteId, draftId);
  if (!draft) throw new AppError('NOT_FOUND', `Draft ${draftId} not found for site ${ctx.siteId}`);
  // A named human (automation names such as system, scheduler, claude, or agent are refused), for every caller.
  const reviewer = humanName(input.reviewer, 'author', 'author a human revision');
  const preview = !!ctx.dryRun;
  if (!preview && !modeAtLeast(ctx.mode, 'DRAFT')) {
    throw new AppError('POLICY_DENIED', `Runtime mode ${ctx.mode} cannot create a draft version: a human revision is a local review artifact and needs DRAFT mode (it calls no model and uses no approval).`, {
      hint: `Re-run with --mode DRAFT, or preview with --dry-run.`,
    });
  }
  const refusal = reviewRefusal(ctx, draft);
  if (refusal) throw new AppError('CONFLICT', refusal);
  if (sha256(draft.pkg.body) !== draft.bodyHash) throw new AppError('CONFLICT', `Draft ${draftId}: the stored body no longer matches its recorded hash, so it cannot be the base of a human revision.`);
  const brief = getBrief(ctx.db, ctx.siteId, draft.briefId);
  if (!brief) throw new AppError('NOT_FOUND', `Brief ${draft.briefId} for draft ${draftId} not found`);
  if (brief.contentHash !== draft.briefHash || briefHash(brief.brief) !== brief.contentHash) {
    throw new AppError('CONFLICT', `The brief this draft was written from (${brief.id}) no longer matches its recorded hash; a human revision is checked against that exact brief.`);
  }

  const body = (input.body ?? '').replace(/^﻿/, '');
  if (!body.trim()) throw new AppError('VALIDATION_FAILED', 'The edited body is empty.');
  if (body.length > MAX_HUMAN_BODY_CHARS) throw new AppError('VALIDATION_FAILED', `The edited body has ${body.length} characters; at most ${MAX_HUMAN_BODY_CHARS} are accepted.`);
  const parsed = factResolutionInputSchema.array().max(500).safeParse(input.resolutions ?? []);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new AppError('VALIDATION_FAILED', `Invalid fact resolutions (${errors.length} problem(s)); each entry is {"marker", "action": "confirmed"|"removed", "source", "statement"?, "note"?}.`, { details: { errors } });
  }
  const provided = parsed.data;
  if (body === draft.pkg.body && !provided.length) throw new AppError('VALIDATION_FAILED', 'The edited body is identical to the current draft and no fact resolution was given: nothing to record.');

  const siblings = (input.siblings ?? reviewSiblings(ctx, draft)).filter((s) => s.itemId !== draft.contentItemId);
  const baseInputs = loadQualityInputs(ctx, brief.brief, draft.pkg, siblings);
  const sources = factNoteSources(ctx, baseInputs);
  const productFactIds = new Set(ctx.config.business.productFacts.map((f) => f.id));
  const briefEvidenceIds = new Set(brief.brief.evidenceSources.map((e) => e.id));

  const before = distinctMarkers(draft.pkg.body);
  const after = distinctMarkers(body);
  const beforeNorm = new Set(before.map(normalizeText));
  const afterNorm = new Set(after.map(normalizeText));
  const removed = before.filter((m) => !afterNorm.has(normalizeText(m)));
  const added = after.filter((m) => !beforeNorm.has(normalizeText(m)));

  // Unresolved facts of the current version: its markers, its unverified notes, and "verified" notes no evidence backs.
  const open = new Map<string, string>();
  for (const m of before) open.set(normalizeText(m), m);
  for (const n of draft.pkg.factCheckNotes) {
    if (n.humanResolution) continue;
    const k = normalizeText(n.statement);
    const unconfirmed = n.status !== 'verified' || !factNoteSupport(n.statement, n.evidenceIds, sources).supported;
    if (k && unconfirmed && !open.has(k)) open.set(k, n.statement);
  }

  const plain = normalizeText(stripUnverifiedMarkers(body));
  const at = ctx.clock.now().toISOString();
  const errors: string[] = [];
  const warnings: string[] = [];
  const resolved = new Map<string, { resolution: HumanFactResolution; sourceId: string | null }>();
  const attempted = new Set<string>();
  for (const r of provided) {
    const k = normalizeText(r.marker);
    const label = `"${truncate(r.marker, 80)}"`;
    if (attempted.has(k)) {
      errors.push(`Duplicate resolution for ${label}.`);
      continue;
    }
    attempted.add(k);
    if (!open.has(k)) {
      errors.push(`${label} is not an unresolved fact of draft ${draftId} (neither one of its [[UNVERIFIED: ...]] markers nor an unconfirmed fact-check note).`);
      continue;
    }
    if (afterNorm.has(k)) {
      errors.push(`${label} is still marked [[UNVERIFIED: ...]] in the edited body; remove the marker or drop this resolution.`);
      continue;
    }
    const statement = r.statement ?? open.get(k)!;
    const present = bodyContains(plain, statement);
    if (r.action === 'confirmed' && !present) {
      errors.push(`Confirmed statement not found unmarked in the edited body: "${truncate(statement, 100)}". Put the confirmed wording in the body, or give that wording as "statement".`);
      continue;
    }
    if (r.action === 'removed' && present) {
      errors.push(`${label} is resolved as removed, but "${truncate(statement, 100)}" still appears in the edited body.`);
      continue;
    }
    const src = resolutionSource(ctx, r.source.trim(), briefEvidenceIds, productFactIds);
    if (r.action === 'confirmed' && src.id) {
      const support = factNoteSupport(statement, [src.id], sources);
      if (!support.supported) warnings.push(`Source ${src.id} for "${truncate(statement, 80)}": ${support.reason}. Recorded as ${reviewer}'s confirmation.`);
    } else if (!src.id && /^[a-z_]+:[\w.-]+$/i.test(r.source.trim()) && !/^https?:/i.test(r.source.trim())) {
      warnings.push(`Source "${truncate(r.source.trim(), 60)}" looks like an id but is not a configured product fact, owner statement, or evidence id of the brief; recorded as text ${reviewer} supplied.`);
    }
    resolved.set(k, { resolution: { marker: open.get(k)!, action: r.action, statement, source: r.source.trim(), sourceKind: src.kind, note: r.note?.trim() || null, reviewer, at }, sourceId: src.id });
  }
  for (const m of removed) {
    if (!attempted.has(normalizeText(m))) errors.push(`Marker removed without a resolution: "${truncate(m, 100)}". Each removed [[UNVERIFIED: ...]] marker needs an entry {"marker", "action": "confirmed"|"removed", "source"} in --resolutions.`);
  }
  if (errors.length) {
    throw new AppError('VALIDATION_FAILED', `Human revision of draft ${draftId} refused: ${errors.length} problem(s) with the fact resolutions. Nothing was recorded.`, {
      details: { errors, removedMarkers: removed, openFacts: [...open.values()] },
      hint: 'Pass --resolutions <file.json>: a JSON array with one entry per removed [[UNVERIFIED: ...]] marker, e.g. [{"marker": "<marker text>", "action": "confirmed", "source": "fact:<id> | <URL> | <document> | owner confirmation <date>"}] or "action": "removed" when the statement was deleted. Keep a marker in the body to leave that fact unresolved.',
    });
  }

  // Fact-check notes of the new version.
  const notes: FactCheckNote[] = [];
  const noted = new Set<string>();
  for (const n of draft.pkg.factCheckNotes) {
    const k = normalizeText(n.statement);
    noted.add(k);
    const r = resolved.get(k);
    if (r?.resolution.action === 'removed') continue;
    if (r) {
      notes.push({ ...n, statement: r.resolution.statement, status: 'verified', evidenceIds: [...new Set([...n.evidenceIds, ...(r.sourceId ? [r.sourceId] : [])])], humanResolution: r.resolution });
    } else if (n.status === 'verified' && !n.humanResolution && afterNorm.has(k)) {
      // A model-claimed "verified" statement the human marked [[UNVERIFIED: ...]] is unverified now.
      notes.push({ ...n, status: 'unverified', downgraded: n.downgraded ?? { from: 'verified', reason: `marked [[UNVERIFIED: ...]] by ${reviewer} in a human revision` } });
    } else notes.push(n);
  }
  for (const [k, r] of resolved) {
    if (!noted.has(k) && r.resolution.action === 'confirmed') notes.push({ statement: r.resolution.statement, status: 'verified', evidenceIds: r.sourceId ? [r.sourceId] : [], note: r.resolution.note ?? '', humanResolution: r.resolution });
  }

  const unresolvedFacts = [...new Set(unverifiedMarkers(body))];
  const blockers = draft.pkg.publicationBlockers.filter((b) => !/unresolved fact\(s\) marked \[\[UNVERIFIED/.test(b));
  if (unresolvedFacts.length) blockers.splice(Math.min(2, blockers.length), 0, `${unresolvedFacts.length} unresolved fact(s) marked [[UNVERIFIED: ...]] must be resolved.`);
  const resolutions = [...resolved.values()].map((r) => r.resolution);
  const pkg: DraftPackage = {
    ...draft.pkg,
    body,
    factCheckNotes: notes,
    unresolvedFacts,
    publicationBlockers: blockers,
    humanRevision: { reviewer, at, previousDraftId: draft.id, previousVersion: draft.version, previousBodyHash: draft.bodyHash, note: input.note?.trim() || null, resolutions, markersBefore: before, markersAfter: after, addedMarkers: added },
  };
  const bodyHash = sha256(body);

  // Deterministic gates on the new version. No model call: the AI review is recorded as skipped.
  const checks = runDeterministicChecks(ctx, { ...baseInputs, pkg }, { revisionRound: draft.revisionRound });
  const ai: AiReviewRecord = {
    status: 'skipped',
    reason: `human revision: deterministic gates only (no model call); run \`content review <draft-id> --use-model\` for a bounded AI review`,
    output: null,
    droppedIssues: 0,
    promptVersion: null,
    model: null,
    costMicros: null,
    disclaimer: AI_REVIEW_DISCLAIMER,
  };
  const { verdict, reasons, revisionLimitReached } = computeVerdict(checks, ai, draft.revisionRound, maxRevisions(ctx), { humanAuthored: true });

  let stored: DraftRecord | null = null;
  let reviewId: string | null = null;
  if (!preview) {
    const now = at;
    const out = ctx.db.transaction(() => {
      const d = insertDraft(ctx.db, {
        siteId: ctx.siteId,
        itemId: draft.contentItemId,
        briefId: draft.briefId,
        briefVersion: draft.briefVersion,
        briefHash: draft.briefHash,
        pkg,
        bodyHash,
        unresolvedFacts: unresolvedFacts.length,
        revisionRound: draft.revisionRound,
        promptVersion: null,
        modelId: null,
        now,
      });
      const id = insertQualityReview(ctx.db, {
        siteId: ctx.siteId,
        subjectType: 'draft',
        subjectId: d.id,
        verdict,
        deterministic: { gateVersion: QUALITY_GATE_VERSION, checks, humanRevision: { reviewer, previousDraftId: draft.id } },
        aiReview: ai,
        reasons,
        revisionRound: draft.revisionRound,
        now,
      });
      setDraftStatus(ctx.db, ctx.siteId, d.id, STATUS_BY_VERDICT[verdict]);
      const item = getItem(ctx.db, ctx.siteId, draft.contentItemId);
      if (item) {
        if (verdict === 'reject') {
          updateItem(ctx.db, ctx.siteId, item.id, { stage: 'rejected', decisionReason: `${item.decisionReason ?? ''} | [quality gate] human revision ${d.id} rejected: ${truncate(reasons.filter((r) => r.consequence === 'reject').map((r) => r.message).join('; '), 400)}`.trim() }, now);
        } else updateItem(ctx.db, ctx.siteId, item.id, { stage: verdict === 'needs_revision' ? 'quality_checked' : 'in_review' }, now);
      }
      const actor = `owner:${reviewer}`;
      audit(
        ctx.db,
        ctx.siteId,
        'content.draft_human_revision',
        'content_draft',
        d.id,
        {
          previousDraftId: draft.id,
          previousVersion: draft.version,
          previousBodyHash: draft.bodyHash,
          bodyHash,
          markersBefore: before.length,
          markersAfter: after.length,
          removedMarkers: removed,
          addedMarkers: added,
          resolutions: resolutions.map((r) => ({ marker: r.marker, action: r.action, source: r.source, sourceKind: r.sourceKind })),
          verdict,
          note: pkg.humanRevision!.note,
        },
        ctx.clock.now(),
        actor,
      );
      audit(ctx.db, ctx.siteId, 'content.quality_review', 'content_draft', d.id, { verdict, revisionRound: draft.revisionRound, reasons: reasons.map((r) => r.code), aiReview: ai.status, humanRevision: true }, ctx.clock.now());
      return { d: getDraft(ctx.db, ctx.siteId, d.id)!, id };
    });
    stored = out.d;
    reviewId = out.id;
  }

  return {
    preview,
    reviewer,
    previousDraftId: draft.id,
    draft: stored,
    pkg,
    bodyHash,
    review: {
      reviewId,
      subjectType: 'draft',
      subjectId: stored?.id ?? draft.id,
      verdict,
      checks,
      aiReview: ai,
      reasons,
      revisionRound: draft.revisionRound,
      revisionLimitReached,
      humanReviewRequiredForPublication: true,
    },
    markersBefore: before,
    markersAfter: after,
    removedMarkers: removed,
    addedMarkers: added,
    resolutions,
    warnings,
  };
}
