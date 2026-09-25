import type { AppContext } from '../app/context.js';
import { validateApproverName } from '../approvals/approver.js';
import { draftHumanReviewBlocker, type DraftHumanReview } from '../approvals/publisher.js';
import { draftHumanReview, draftPackageRawBody } from '../approvals/subjects.js';
import type { ApprovalCheck } from '../approvals/types.js';
import { AppError, errorMessage } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import { modeAtLeast } from '../core/modes.js';
import { unavailable, type Measured } from '../core/measured.js';
import { gscCoverage } from '../seo/coverage.js';
import { aggregateSearch, type SearchObservation } from '../seo/metrics.js';
import { resolveGscProperty } from '../seo/period.js';
import { normalizeUrl } from '../seo/url.js';
import type { ContentDeps } from './deps.js';
import { audit, getBrief, getDraft, insertQualityReview, latestDraft, latestQualityReview, listItems, setDraftStatus, updateItem, getItem } from './store.js';
import { unverifiedMarkers } from './text.js';

/**
 * HUMAN REVIEW -> EXPORT/PUBLISH WHEN AUTHORIZED -> MEASURE.
 *
 * Publication is a production action: it always requires a named human's
 * recorded acceptance of the exact draft body (`content mark-reviewed`), a
 * valid human `publish_content`/`update_page` approval bound to the exact
 * proposal, EXECUTE mode, zero unresolved facts, and a non-rejected quality
 * verdict. A passing deterministic verdict, an AI review score, or sampling
 * NEVER authorizes publication. The human-acceptance rule is the one `export
 * draft` enforces (draftHumanReview + draftHumanReviewBlocker from the
 * approvals slice), so this check and the export cannot disagree.
 *
 * Approvals for publishing a draft are created ONLY by the approvals
 * workflow (`approvals request draft <id>`), which binds them to its
 * canonical change hash (proposalArtifactHash of the resolved proposal:
 * action, target URL, title, meta, body, slug, links, structured data).
 * This module never creates publication approvals (a competing request with
 * a different hash would invalidate the owner's live approval); it checks
 * the same binding through the injected `proposals` resolver.
 */

export interface PublicationGateResult {
  draftId: string;
  itemId: string;
  allowed: boolean;
  blockers: string[];
  /** Null when the approvals binding could not be resolved (see blockers). */
  binding: PublicationBinding | null;
  bodyHash: string;
  verdict: string | null;
  /**
   * The recorded human acceptance of this exact body, as `export draft` reads
   * it (reviewer, when, review id; `accepted: false` with the reason otherwise).
   */
  humanReview: DraftHumanReview;
  approval: ApprovalCheck | null;
  requiredMode: 'EXECUTE';
  notes: string[];
  note: string;
}

/** The approval binding checked for publication (from the approvals workflow's proposal). */
export interface PublicationBinding {
  subjectType: string;
  actionType: 'publish_content' | 'update_page';
  artifactHash: string;
  targetUrl: string | null;
}

/**
 * The binding the approvals workflow uses for this draft. Returns an honest
 * reason instead of guessing a hash when the resolver is not wired or the
 * approvals workflow would refuse to export the draft.
 */
export function publicationBinding(ctx: AppContext, deps: ContentDeps, draftId: string): { binding: PublicationBinding | null; reason: string | null } {
  if (!deps.proposals) {
    return { binding: null, reason: 'Publication binding unavailable: the approvals proposal resolver is not wired, so the canonical change hash the approvals workflow binds cannot be computed here. Use `approvals request draft <id>` / `approvals show` to inspect the approval.' };
  }
  try {
    const b = deps.proposals.resolve(ctx, draftId);
    return { binding: { subjectType: b.subjectType, actionType: b.actionType, artifactHash: b.artifactHash, targetUrl: b.targetUrl }, reason: null };
  } catch (err) {
    return { binding: null, reason: `The approvals workflow cannot build a publication proposal for this draft: ${errorMessage(err)}` };
  }
}

export function checkPublicationGate(ctx: AppContext, deps: ContentDeps, draftId: string): PublicationGateResult {
  const draft = getDraft(ctx.db, ctx.siteId, draftId);
  if (!draft) throw new AppError('NOT_FOUND', `Draft ${draftId} not found for site ${ctx.siteId}`);
  const blockers: string[] = [];
  const notes: string[] = [];
  const latest = latestDraft(ctx.db, ctx.siteId, draft.contentItemId);
  if (latest && latest.id !== draft.id) blockers.push(`A newer draft (${latest.id}) exists; only the latest draft can be published.`);
  if (['superseded', 'rejected', 'needs_revision', 'draft'].includes(draft.status)) blockers.push(`Draft status is "${draft.status}"; it must be reviewed and not rejected.`);
  const bodyHash = sha256(draft.pkg.body);
  // The same rule `export draft` enforces (assertDraftHumanAccepted): the draft's latest review must be a named
  // human's acceptance of the exact body that would be exported. An automated verdict ('pass' included) never counts.
  const humanReview = draftHumanReview(ctx, draftId, draftPackageRawBody(draft.pkg as unknown as Record<string, unknown>) ?? draft.pkg.body);
  const humanBlocker = draftHumanReviewBlocker({ subjectType: 'draft', productionBound: true, humanReview });
  if (humanBlocker) {
    blockers.push(
      `${draft.status === 'needs_human_review' ? 'Draft awaits human review' : 'No recorded human acceptance of this exact body'}: ${humanBlocker}. \`export draft\` refuses a draft without it (automated quality verdicts never count): a named reviewer reads the draft and runs \`content mark-reviewed ${draftId} --as "<name>" --confirm ${humanReview.bodyHash.slice(0, 12)}\`.`,
    );
  }
  if (bodyHash !== draft.bodyHash) blockers.push('Draft body changed after its hash was recorded; re-review it.');
  const review = latestQualityReview(ctx.db, ctx.siteId, 'draft', draftId);
  if (!review) blockers.push('No quality review recorded for this draft.');
  else if (review.verdict === 'reject' || review.verdict === 'needs_revision') blockers.push(`Latest quality verdict is "${review.verdict}".`);
  const markers = unverifiedMarkers(draft.pkg.body);
  if (draft.unresolvedFacts > 0 || markers.length) blockers.push(`${Math.max(draft.unresolvedFacts, markers.length)} unresolved fact(s) marked [[UNVERIFIED: ...]] must be resolved first: a human confirms each with a source or removes it (\`content revise-manual ${draftId} --body-file <edited.md> --as <name> --resolutions <file.json> --mode DRAFT\`).`);
  if (draft.pkg.isSynthetic) blockers.push('Draft is based on synthetic/fixture data and can never be published.');
  const brief = getBrief(ctx.db, ctx.siteId, draft.briefId);
  if (brief?.brief.isSynthetic) blockers.push('Brief uses synthetic/fixture evidence.');
  let approval: ApprovalCheck | null = null;
  const { binding, reason } = publicationBinding(ctx, deps, draftId);
  if (!deps.approvals) blockers.push('Approval service not wired: publication cannot be authorized.');
  else if (!binding) blockers.push(reason!);
  else {
    approval = deps.approvals.check({ siteId: ctx.siteId, actionType: binding.actionType, subjectType: binding.subjectType, subjectId: draftId, artifactHash: binding.artifactHash });
    if (!approval.ok && approval.reason === 'revision_mismatch') {
      notes.push(`Approval ${approval.approval?.id ?? ''} is bound to a source revision; \`export draft ${draftId}\` verifies that revision before anything is written.`.replace('  ', ' '));
    } else if (!approval.ok) {
      blockers.push(`No valid ${binding.actionType} approval for this exact proposal (${approval.reason}). Request one with \`approvals request draft ${draftId}\`; a human approves it with \`approvals approve <id>\`.`);
    }
  }
  if (!modeAtLeast(ctx.mode, 'EXECUTE')) blockers.push(`Runtime mode ${ctx.mode}: publishing is a production action and requires EXECUTE mode.`);
  return {
    draftId,
    itemId: draft.contentItemId,
    allowed: blockers.length === 0,
    blockers,
    binding,
    bodyHash,
    verdict: review?.verdict ?? null,
    humanReview,
    approval,
    requiredMode: 'EXECUTE',
    notes,
    note: 'Human review is required for publication: a named human accepts the exact body (`content mark-reviewed`) and a human approves the exact proposal. Quality verdicts, AI review scores, and sampling never authorize publishing.',
  };
}

// ---------------------------------------------------------------------------
// Human review
// ---------------------------------------------------------------------------

/**
 * Record a named human reviewer's acceptance of the EXACT draft body
 * (confirmed by a body-hash prefix). Allowed only when no reject- or
 * revise-level findings remain and no facts are unresolved. This is not a
 * publication approval: publishing still needs the approvals workflow.
 */
export function markHumanReviewed(ctx: AppContext, draftId: string, opts: { reviewer: string; confirmHashPrefix: string; note?: string }): { draftId: string; status: 'review_passed'; reviewId: string; reviewer: string } {
  const draft = getDraft(ctx.db, ctx.siteId, draftId);
  if (!draft) throw new AppError('NOT_FOUND', `Draft ${draftId} not found for site ${ctx.siteId}`);
  const reviewer = humanName(opts.reviewer, 'reviewer', 'record a human review');
  if (ctx.dryRun) throw new AppError('POLICY_DENIED', 'mark-reviewed records a human decision; it does not run with --dry-run.');
  const latest = latestDraft(ctx.db, ctx.siteId, draft.contentItemId);
  if (latest?.id !== draft.id) throw new AppError('CONFLICT', `A newer draft (${latest?.id}) exists; review that one.`);
  if (!['needs_human_review', 'review_passed'].includes(draft.status)) throw new AppError('POLICY_DENIED', `Draft status is "${draft.status}"; only drafts awaiting human review can be accepted.`);
  const bodyHash = sha256(draft.pkg.body);
  if (bodyHash !== draft.bodyHash) throw new AppError('CONFLICT', 'Draft body changed after its hash was recorded; re-review it.');
  const prefix = opts.confirmHashPrefix.trim().toLowerCase();
  if (prefix.length < 8 || !bodyHash.startsWith(prefix)) throw new AppError('VALIDATION_FAILED', `Confirm the exact body you reviewed: pass --confirm with at least the first 8 characters of the body hash (${bodyHash.slice(0, 12)}...).`);
  const review = latestQualityReview(ctx.db, ctx.siteId, 'draft', draftId);
  if (!review) throw new AppError('POLICY_DENIED', 'Run the quality review first (`content review <draft-id>`).');
  const blocking = review.reasons.filter((r) => r.consequence === 'reject' || r.consequence === 'revise');
  const humanRevisionHint = { hint: `Edit the body (and resolve each [[UNVERIFIED: ...]] marker with a source) in a human revision: \`npm run cli -- content revise-manual ${draftId} --body-file <edited.md> --as <name> [--resolutions <file.json>] --mode DRAFT\`; or reject the item.` };
  if (blocking.length) throw new AppError('POLICY_DENIED', `Quality findings still require revision or rejection: ${blocking.map((r) => r.code).join(', ')}.`, humanRevisionHint);
  const markers = unverifiedMarkers(draft.pkg.body);
  if (draft.unresolvedFacts > 0 || markers.length) throw new AppError('POLICY_DENIED', `${Math.max(draft.unresolvedFacts, markers.length)} unresolved fact(s) must be resolved before a draft can pass review.`, humanRevisionHint);
  const now = ctx.clock.now().toISOString();
  const reviewId = ctx.db.transaction(() => {
    const id = insertQualityReview(ctx.db, {
      siteId: ctx.siteId,
      subjectType: 'draft',
      subjectId: draftId,
      verdict: 'pass',
      deterministic: { humanReview: { reviewer, bodyHash, previousVerdict: review.verdict, note: opts.note ?? null } },
      aiReview: null,
      reasons: [{ code: 'human_review', message: `Accepted by ${reviewer} after human review of body ${bodyHash.slice(0, 12)}.`, consequence: 'human', evidenceRefs: [review.id], fix: 'Publication still requires an approval through the approvals workflow.' }],
      revisionRound: draft.revisionRound,
      now,
    });
    setDraftStatus(ctx.db, ctx.siteId, draftId, 'review_passed');
    updateItem(ctx.db, ctx.siteId, draft.contentItemId, { stage: 'in_review' }, now);
    audit(ctx.db, ctx.siteId, 'content.human_review', 'content_draft', draftId, { reviewer, bodyHash, previousVerdict: review.verdict }, ctx.clock.now(), `owner:${reviewer}`);
    return id;
  });
  return { draftId, status: 'review_passed', reviewId, reviewer };
}

/**
 * A named human for a human decision recorded by the content module (review
 * acceptance, human revision). Every caller goes through it, not only the CLI:
 * names that denote automation (system, scheduler, claude, agent, ...) are
 * refused by the approvals slice's validateApproverName, so no unattended
 * process can record a "named human" decision.
 */
export function humanName(raw: string | null | undefined, role: 'reviewer' | 'author', action: string): string {
  if (!(raw ?? '').trim()) throw new AppError('VALIDATION_FAILED', `A named ${role} is required (--as <name>).`);
  try {
    return validateApproverName(raw);
  } catch (err) {
    if (err instanceof AppError && /reserved for automation/.test(err.message)) {
      throw new AppError(err.code, err.message.replace(/cannot approve or reject anything\.$/, `cannot ${action}.`), { hint: `Only a named human can ${action}: pass --as "<your name>".` });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Measure
// ---------------------------------------------------------------------------

export interface ContentMeasurement {
  itemId: string;
  draftId: string;
  url: string;
  implementedAt: string;
  verifiedLive: boolean;
  window: { start: string; end: string | null };
  clicks: Measured<number>;
  impressions: Measured<number>;
  /** Scope of the Search Console rows: one property and search type, joined on the page (not the raw URL). */
  scope?: { property: string | null; searchType: string; pageId: string | null; matchedUrls: string[]; join: 'page_id' | 'exact_url' | 'none' };
  note: string;
}

interface GscPageRow {
  date: string;
  date_tz: string;
  property: string;
  search_type: string;
  aggregation_type: string;
  segment_key: string;
  clicks: number;
  impressions: number;
  position: number | null;
  is_final: number;
  is_synthetic: number;
}

/** Page id for a published URL: the publication's page_id, the page registry, or an ESTABLISHED alias. */
function resolvePublishedPage(ctx: AppContext, pub: { page_id: string | null; url: string }): { pageId: string | null; urls: string[] } {
  let pageId = pub.page_id;
  const norm = normalizeUrl(pub.url)?.url ?? pub.url;
  if (!pageId) pageId = ctx.db.get<{ id: string }>('SELECT id FROM pages WHERE site_id = ? AND (url = ? OR url = ?)', [ctx.siteId, norm, pub.url])?.id ?? null;
  if (!pageId) pageId = ctx.db.get<{ page_id: string }>(`SELECT page_id FROM url_aliases WHERE site_id = ? AND alias_url IN (?, ?) AND confidence = 'established'`, [ctx.siteId, pub.url, norm])?.page_id ?? null;
  if (!pageId) return { pageId: null, urls: [...new Set([pub.url, norm])] };
  const pageUrl = ctx.db.get<{ url: string }>('SELECT url FROM pages WHERE site_id = ? AND id = ?', [ctx.siteId, pageId])?.url;
  const aliases = ctx.db.all<{ alias_url: string }>(`SELECT alias_url FROM url_aliases WHERE site_id = ? AND page_id = ? AND confidence = 'established'`, [ctx.siteId, pageId]).map((r) => r.alias_url);
  return { pageId, urls: [...new Set([...(pageUrl ? [pageUrl] : []), ...aliases])] };
}

/**
 * Items with a recorded publication (mark-implemented) move to `measuring`.
 * Search Console page metrics after the ACTUAL implementation date are
 * reported as observational data; draft creation or approval never starts a
 * measurement window, and before/after differences are not causal proof.
 *
 * Scope (spec §6: no double counting, property rows not additive):
 * - ONE Search Console property (configured, or the only one with data);
 *   without one the metrics are DATA_UNAVAILABLE, never a sum across
 *   properties;
 * - the configured search type (first of google.gsc.searchTypes);
 * - rows joined on the page id (reconciled rows) or its ESTABLISHED aliases,
 *   not on the raw publication URL (an unreconciled URL falls back to an
 *   exact-URL match, stated in the note);
 * - final dates only: when non-final dates fall in the window the values are
 *   `incomplete` with their partial value, never `observed`. Missing,
 *   incomplete, and zero stay distinct.
 */
export function measurePublishedContent(ctx: AppContext): ContentMeasurement[] {
  const rows = ctx.db.all<{ id: string; subject_id: string; url: string; page_id: string | null; implemented_at: string; verified_live: number; content_item_id: string }>(
    `SELECT p.id, p.subject_id, p.url, p.page_id, p.implemented_at, p.verified_live, d.content_item_id
     FROM publications p JOIN content_drafts d ON d.id = p.subject_id AND d.site_id = p.site_id
     WHERE p.site_id = ? AND p.subject_type = 'draft' ORDER BY p.implemented_at`,
    [ctx.siteId],
  );
  const out: ContentMeasurement[] = [];
  const now = ctx.clock.now().toISOString();
  const searchType = ctx.config.google.gsc.searchTypes[0] ?? 'web';
  const prop = resolveGscProperty(ctx.db, ctx.siteId, ctx.config.google.searchConsoleProperty);
  for (const r of rows) {
    const start = r.implemented_at.slice(0, 10);
    const causality = 'Observational only; before/after changes are not proof of causality.';
    const live = r.verified_live ? '' : 'Publication not verified live. ';
    const target = resolvePublishedPage(ctx, r);
    let m: ContentMeasurement;
    if (!prop.property) {
      const reason = `Search Console property not resolved (${'reason' in prop ? prop.reason : 'unresolved'}); totals of different properties are never added together.`;
      m = {
        itemId: r.content_item_id,
        draftId: r.subject_id,
        url: r.url,
        implementedAt: r.implemented_at,
        verifiedLive: r.verified_live === 1,
        window: { start, end: null },
        clicks: unavailable(reason),
        impressions: unavailable(reason),
        scope: { property: null, searchType, pageId: target.pageId, matchedUrls: target.urls, join: 'none' },
        note: `${live}DATA_UNAVAILABLE: set google.searchConsoleProperty. ${causality}`,
      };
    } else {
      const property = prop.property;
      // Data horizon for this property/search type (any stored date, final or not).
      const horizon = ctx.db.get<{ d: string | null }>(`SELECT MAX(date) AS d FROM gsc_page_daily_current WHERE site_id = ? AND property = ? AND search_type = ? AND segment_key = ''`, [ctx.siteId, property, searchType])?.d ?? null;
      const placeholders = target.urls.map(() => '?').join(', ');
      const urlJoin = target.urls.length ? `(page_id IS NULL AND page IN (${placeholders}))` : '0';
      const join = target.pageId ? `(page_id = ? OR ${urlJoin})` : urlJoin;
      const obsRows = horizon && horizon >= start
        ? ctx.db.all<GscPageRow>(
            `SELECT date, date_tz, property, search_type, aggregation_type, segment_key, clicks, impressions, position, is_final, is_synthetic
               FROM gsc_page_daily_current
              WHERE site_id = ? AND property = ? AND search_type = ? AND segment_key = '' AND date BETWEEN ? AND ? AND ${join}
              ORDER BY date`,
            [ctx.siteId, property, searchType, start, horizon, ...(target.pageId ? [target.pageId] : []), ...target.urls],
          )
        : [];
      const obs: SearchObservation[] = obsRows.map((x) => ({
        date: x.date,
        dateTz: x.date_tz,
        property: x.property,
        searchType: x.search_type,
        aggregationType: x.aggregation_type,
        segmentKey: x.segment_key ?? '',
        clicks: x.clicks,
        impressions: x.impressions,
        position: x.position,
        isFinal: x.is_final === 1,
        isSynthetic: x.is_synthetic === 1,
      }));
      let clicks: Measured<number>;
      let impressions: Measured<number>;
      let end: string | null = null;
      if (!horizon || horizon < start) {
        const reason = `No Search Console page data collected for ${property} (${searchType}) since the recorded implementation date (not zero: missing).`;
        clicks = { status: 'missing', reason };
        impressions = { status: 'missing', reason };
      } else {
        const coverage = gscCoverage(ctx.db, ctx.siteId, { dataset: 'gsc_page_daily', property, searchType, start, end: horizon, segmentKey: '' });
        // Non-final dates are excluded from the value; their presence makes the result `incomplete` (with partialValue).
        const agg = aggregateSearch(obs, { incompletePolicy: 'exclude', coverage });
        clicks = agg.clicks;
        impressions = agg.impressions;
        end = agg.datesWithRows[agg.datesWithRows.length - 1] ?? null;
        if (agg.synthetic) {
          const syn = 'SYNTHETIC rows (fixture/demo): not a real measurement.';
          clicks = clicks.status === 'observed' ? { status: 'incomplete', reason: syn, partialValue: clicks.value } : clicks;
          impressions = impressions.status === 'observed' ? { status: 'incomplete', reason: syn, partialValue: impressions.value } : impressions;
        }
      }
      const joinKind: 'page_id' | 'exact_url' = target.pageId ? 'page_id' : 'exact_url';
      m = {
        itemId: r.content_item_id,
        draftId: r.subject_id,
        url: r.url,
        implementedAt: r.implemented_at,
        verifiedLive: r.verified_live === 1,
        window: { start, end },
        clicks,
        impressions,
        scope: { property, searchType, pageId: target.pageId, matchedUrls: target.urls, join: joinKind },
        note: `${live}Search Console ${property} (${searchType}${prop.basis === 'data' ? '; the only property with data, not configured' : ''}), ${target.pageId ? `page ${target.pageId} and its established aliases` : 'exact URL only (not yet reconciled to a known page)'}; final dates only. ${causality}`,
      };
    }
    out.push(m);
    const item = getItem(ctx.db, ctx.siteId, r.content_item_id);
    if (item && ['approved', 'exported', 'published', 'in_review'].includes(item.stage)) {
      updateItem(ctx.db, ctx.siteId, item.id, { stage: 'measuring' }, now);
      audit(ctx.db, ctx.siteId, 'content.measuring', 'content_item', item.id, { publicationId: r.id, implementedAt: r.implemented_at }, ctx.clock.now());
    }
  }
  return out;
}

export function publishedItemCount(ctx: AppContext): number {
  return listItems(ctx.db, ctx.siteId, { stages: ['published', 'measuring'] }).length;
}
