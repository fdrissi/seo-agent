import type { AppContext } from '../app/context.js';
import { AppError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { recordAudit } from '../database/audit.js';
import { ownerActor, validateApproverName } from '../approvals/approver.js';
import { computeArtifactHash } from '../approvals/artifact.js';
import {
  actionScopeWarnings,
  changeFromRecommendation,
  getRecommendation,
  impliedActionType,
  isNoActionRecommendation,
  pickString,
  recommendationDetails,
  structuredChangeOf,
  type RecommendationRow,
  type StructuredChange,
} from '../approvals/change.js';
import { assertAllowed } from '../approvals/policy.js';
import { ApprovalService } from '../approvals/service.js';
import { assertOnSiteTarget } from '../approvals/subjects.js';
import { getPage } from './repository.js';

/**
 * `experiments specify-change <recommendation-id>`: record ONE concrete change
 * for a recommendation, typically an audit/investigation whose proposed_change
 * is an instruction ("compare intent ... then propose ONE specific change").
 *
 * The change is recorded as a NEW recommendation revision (a new row with a
 * structured `details_json.change` and therefore a new artifact hash); the
 * previous row is marked `superseded` and its live approvals are invalidated.
 * Nothing is approved or deployed here: the new revision still needs its own
 * experiment proposal or approval request, reviewed by a human.
 *
 * The revision's action_type is the approval action type implied by its
 * structured change (e.g. title_meta_change for a title, update_page for a
 * section, redirect), never the label of the recommendation it was specified
 * from: a title recorded for a `repair_measurement` recommendation is
 * approved and exported as a title/meta change, not as an analytics change.
 * The first original label is kept in `details_json.originalActionType`.
 *
 * Allowed changes (one per revision):
 *   --title "<new title>" [--meta "<new meta description>"]   (a title/meta snippet change)
 *   --meta "<new meta description>"                           (meta description only)
 *   --section-file <file.md>                                  (one content section, Markdown)
 *   --redirect-to <absolute URL>                              (a redirect of the page)
 */

export const MAX_TITLE_CHARS = 300;
export const MAX_META_CHARS = 1_000;
export const MAX_SECTION_CHARS = 100_000;

export interface SpecifyChangeInput {
  recommendationId: string;
  /** The human recording the change (validated like an approver name). */
  by: string;
  title?: string | null;
  metaDescription?: string | null;
  /** Markdown of ONE section (the CLI reads it from --section-file). */
  sectionMarkdown?: string | null;
  redirectTo?: string | null;
  /** Optional note on why this is the change (recorded in the revision details). */
  note?: string | null;
  /**
   * The hypothesis to test, when the source recommendation has none (e.g. a
   * secondary observation) or the owner states it more precisely. Recorded as
   * the revision's hypothesis; the original is kept in the details.
   */
  hypothesis?: string | null;
  /**
   * The risks of the change, when the source recommendation states none (e.g.
   * a secondary observation) or the owner states them more precisely.
   * Recorded as the revision's risks; the original is kept in the details.
   * An experiment is never proposed without risks (spec 23).
   */
  risks?: string | null;
}

export interface SpecifyChangeResult {
  recommendation: RecommendationRow;
  supersededId: string;
  change: StructuredChange;
  targetUrl: string;
  actionType: string;
  /** Artifact hash of the new revision's exact change (what an approval will bind). */
  changeHash: string;
  invalidatedApprovals: number;
  warnings: string[];
}

function clean(v: string | null | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  const t = v.replace(/\r\n?/g, '\n').trim();
  return t ? t : undefined;
}

function assertPlainLine(v: string, label: string, max: number): void {
  if (v.length > max) throw new AppError('VALIDATION_FAILED', `${label} is ${v.length} characters; at most ${max} are allowed.`);
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new AppError('VALIDATION_FAILED', `${label} must be a single line of plain text (no control characters or line breaks).`);
}

/** Build the one structured change from the flags (exactly one change; title may carry a meta description). */
export function structuredChangeFromInput(input: Pick<SpecifyChangeInput, 'title' | 'metaDescription' | 'sectionMarkdown' | 'redirectTo'>): StructuredChange {
  const title = clean(input.title);
  const meta = clean(input.metaDescription);
  const section = clean(input.sectionMarkdown);
  const redirect = clean(input.redirectTo);
  const groups = [title || meta ? 'title/meta' : null, section ? 'section' : null, redirect ? 'redirect' : null].filter(Boolean);
  if (groups.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'Specify exactly one concrete change: --title (optionally with --meta), --meta, --section-file, or --redirect-to.');
  }
  if (groups.length > 1) {
    throw new AppError('VALIDATION_FAILED', `One recommendation revision records ONE change; got ${groups.join(' + ')}. Record them as separate revisions/experiments.`);
  }
  if (title) assertPlainLine(title, 'The title', MAX_TITLE_CHARS);
  if (meta) assertPlainLine(meta, 'The meta description', MAX_META_CHARS);
  if (title) return { kind: 'title', proposedTitle: title, ...(meta ? { proposedMetaDescription: meta } : {}) };
  if (meta) return { kind: 'meta_description', proposedMetaDescription: meta };
  if (section) {
    if (section.length > MAX_SECTION_CHARS) throw new AppError('VALIDATION_FAILED', `The section is ${section.length} characters; at most ${MAX_SECTION_CHARS} are allowed.`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(section)) throw new AppError('VALIDATION_FAILED', 'The section Markdown contains control characters.');
    return { kind: 'section', proposedSectionMarkdown: section };
  }
  let u: URL;
  try {
    u = new URL(redirect!);
  } catch {
    throw new AppError('VALIDATION_FAILED', `The redirect target "${redirect}" is not an absolute URL.`);
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) throw new AppError('VALIDATION_FAILED', `The redirect target "${redirect}" must be a plain http(s) URL.`);
  return { kind: 'redirect', redirectTo: u.href };
}

/** Deterministic, human-readable description of the concrete change (the revision's proposed_change). */
export function describeStructuredChange(c: StructuredChange, targetUrl: string): string {
  switch (c.kind) {
    case 'title':
      return `On ${targetUrl}, change the title to "${c.proposedTitle}"${c.proposedMetaDescription ? ` and the meta description to "${c.proposedMetaDescription}"` : ''}.`;
    case 'meta_description':
      return `On ${targetUrl}, change the meta description to "${c.proposedMetaDescription}".`;
    case 'section':
      return `On ${targetUrl}, publish the specified content section (${c.proposedSectionMarkdown!.split('\n').length} line(s) of Markdown; exact text in the structured change).`;
    case 'redirect':
      return `Redirect ${targetUrl} to ${c.redirectTo}.`;
  }
}

export function specifyRecommendationChange(ctx: AppContext, input: SpecifyChangeInput): SpecifyChangeResult {
  assertAllowed(ctx.mode, 'propose_experiment');
  const by = validateApproverName(input.by);
  const actor = ownerActor(by);
  const rec = getRecommendation(ctx.db, ctx.siteId, input.recommendationId);
  if (!rec) throw new AppError('NOT_FOUND', `Recommendation ${input.recommendationId} not found for site ${ctx.siteId}.`);
  if (!['proposed', 'approved'].includes(rec.status)) {
    throw new AppError('CONFLICT', `Recommendation ${rec.id} is ${rec.status}; only a proposed or approved recommendation can be specified.`, {
      hint: rec.status === 'superseded' ? 'Specify the latest revision instead (`approvals list` / the vault note show it).' : undefined,
    });
  }
  if (isNoActionRecommendation(rec)) throw new AppError('VALIDATION_FAILED', `Recommendation ${rec.id} is a "${rec.kind}" decision; it proposes no change to specify.`);
  const details = recommendationDetails(rec);
  const page = rec.page_id ? getPage(ctx.db, ctx.siteId, rec.page_id) : null;
  const targetUrl = pickString(details, 'targetUrl') ?? page?.url;
  if (!targetUrl) throw new AppError('VALIDATION_FAILED', `Recommendation ${rec.id} has no page or target URL.`);
  assertOnSiteTarget(ctx, targetUrl, `Recommendation ${rec.id}`);

  const change = structuredChangeFromInput(input);
  const warnings: string[] = [];
  if (change.kind === 'redirect') {
    if (change.redirectTo === new URL(targetUrl).href) throw new AppError('VALIDATION_FAILED', 'A page cannot redirect to itself.');
    try {
      assertOnSiteTarget(ctx, change.redirectTo!, 'Redirect');
    } catch {
      warnings.push(`The redirect target ${change.redirectTo} is outside the site's allowedHostnames; confirm this cross-domain redirect is intended.`);
    }
  }
  const hypothesisIn = clean(input.hypothesis);
  if (hypothesisIn) assertPlainLine(hypothesisIn.replace(/\n/g, ' '), 'The hypothesis', 2_000);
  const risksIn = clean(input.risks);
  if (risksIn) assertPlainLine(risksIn.replace(/\n/g, ' '), 'The risks', 2_000);
  const previous = structuredChangeOf(details);
  if (previous && JSON.stringify(previous) === JSON.stringify(change) && (!hypothesisIn || hypothesisIn === rec.hypothesis?.trim()) && (!risksIn || risksIn === rec.risks?.trim())) {
    throw new AppError('CONFLICT', `Recommendation ${rec.id} already specifies exactly this change.`);
  }

  const hypothesis = hypothesisIn ?? rec.hypothesis?.trim() ?? null;
  if (!hypothesis) warnings.push(`Recommendation ${rec.id} states no hypothesis; an experiment needs one. Re-run with --hypothesis "<what you expect and why>" before proposing an experiment.`);
  const now = ctx.clock.now().toISOString();
  const id = newId('rec');
  const risks = risksIn ?? (rec.risks?.trim() || null);
  if (!risks) warnings.push(`Recommendation ${rec.id} states no risks; an experiment is refused without them. State them when proposing: \`experiments propose --recommendation ${id} --risks "<what could go wrong>"\`.`);
  const proposedChange = describeStructuredChange(change, targetUrl);
  // The label of the recommendation the FIRST revision was specified from (kept across re-specifications).
  const originalActionType = typeof details.originalActionType === 'string' && details.originalActionType.trim() ? details.originalActionType : rec.action_type;
  const newDetails: Record<string, unknown> = {
    ...details,
    change,
    revisionOf: rec.id,
    specifiedBy: actor,
    specifiedAt: now,
    originalActionType,
    originalProposedChange: rec.proposed_change,
    ...(hypothesisIn ? { originalHypothesis: rec.hypothesis, hypothesisBy: actor } : {}),
    ...(risksIn ? { originalRisks: rec.risks, risksBy: actor } : {}),
    ...(clean(input.note) ? { specificationNote: clean(input.note) } : {}),
  };
  const draft: RecommendationRow = { ...rec, id, proposed_change: proposedChange, hypothesis, risks, details_json: JSON.stringify(newDetails), status: 'proposed', created_at: now };
  const exact = changeFromRecommendation(draft);
  // The revision is typed by its structured change; the source label is kept only in details.originalActionType.
  const actionType = impliedActionType(exact);
  // A non-investigation source label that disagrees with the change (e.g. repair_measurement vs a title) is shown to the owner.
  warnings.push(...actionScopeWarnings(actionType, exact, { labels: [originalActionType], structured: change }));
  const changeHash = computeArtifactHash({ actionType, target: targetUrl, change: exact as Record<string, unknown> });
  const gate = new ApprovalService(ctx.db, { clock: ctx.clock });

  const invalidated = ctx.db.transaction(() => {
    const jobId = ctx.db.get<{ job_id: string | null }>('SELECT job_id FROM recommendations WHERE site_id = ? AND id = ?', [ctx.siteId, rec.id])?.job_id ?? null;
    ctx.db.run(
      `INSERT INTO recommendations (id, site_id, job_id, opportunity_id, kind, action_type, title, page_id, query, diagnosis, proposed_change, hypothesis, success_criteria, risks, review_date,
         details_json, status, prompt_version, model_id, scoring_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?)`,
      [
        id,
        ctx.siteId,
        jobId,
        rec.opportunity_id,
        rec.kind,
        actionType,
        rec.title,
        rec.page_id,
        rec.query,
        rec.diagnosis,
        proposedChange,
        hypothesis,
        rec.success_criteria,
        risks,
        rec.review_date,
        JSON.stringify(newDetails),
        rec.prompt_version,
        rec.model_id,
        rec.scoring_version,
        now,
        now,
      ],
    );
    const changed = ctx.db.run(`UPDATE recommendations SET status = 'superseded', updated_at = ? WHERE site_id = ? AND id = ? AND status IN ('proposed', 'approved')`, [now, ctx.siteId, rec.id]).changes;
    if (changed !== 1) throw new AppError('CONFLICT', `Recommendation ${rec.id} changed concurrently; retry.`);
    const n = gate.invalidateSubject(ctx.siteId, 'recommendation', rec.id, `superseded by recommendation ${id} (concrete change specified by ${actor})`, { actor });
    recordAudit(ctx.db, {
      siteId: ctx.siteId,
      actor,
      eventType: 'recommendation.change_specified',
      subjectType: 'recommendation',
      subjectId: id,
      details: { revisionOf: rec.id, originalActionType, previousActionType: rec.action_type, change, targetUrl, actionType, changeHash, invalidatedApprovals: n, hypothesisStatedBySpecifier: !!hypothesisIn, risksStatedBySpecifier: !!risksIn },
      at: ctx.clock.now(),
    });
    return n;
  });
  const recommendation = getRecommendation(ctx.db, ctx.siteId, id)!;
  return { recommendation, supersededId: rec.id, change, targetUrl, actionType, changeHash, invalidatedApprovals: invalidated, warnings };
}
