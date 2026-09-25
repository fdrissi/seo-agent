import type { AppContext } from '../app/context.js';
import type { ApprovalCheck, ApprovalRecord } from '../approvals/types.js';
import { AppError, type ErrorCode } from '../core/errors.js';
import { hashObject, sha256 } from '../core/hash.js';
import { slugify } from '../core/ids.js';
import { modeAtLeast, type TrustClass } from '../core/modes.js';
import type { EvidenceItem, StructuredResult } from '../integrations/llm/types.js';
import { redactString } from '../security/redact.js';
import { briefHash } from './brief.js';
import { factNoteSupport, factVerificationSources, normalizeFactNoteId } from './claims.js';
import type { ContentDeps } from './deps.js';
import { loadSitePages } from './existing.js';
import { observationHint, observationHold } from './freeze.js';
import { rawText } from './quality.js';
import { structuredDataPromptRules } from './structured-data-requirements.js';
import { audit, countInProduction, getBrief, getDraft, getItem, insertDraft, latestBrief, latestDraft, updateItem } from './store.js';
import { escapeRegExp, normalizeText, truncate, unverifiedMarkers } from './text.js';
import {
  draftModelOutputSchema,
  type BriefRecord,
  type ContentBrief,
  type ContentItem,
  type DraftAuthorization,
  type DraftModelOutput,
  type DraftPackage,
  type DraftRecord,
  type FactCheckNote,
  type QualityReason,
} from './types.js';

/**
 * DRAFT: generated ONLY when
 *   1. the runtime mode is DRAFT or EXECUTE,
 *   2. the latest brief passed its deterministic gate and its stored hash
 *      still matches its content,
 *   3. a valid `draft_generation` approval is bound to that exact brief hash
 *      (or an approved batch covers it), and
 *   4. production capacity allows it (content.maxInProduction, default 1).
 *
 * The approved brief version and hash are attached to the draft. The package
 * contains body, title options, meta description, slug, internal-link
 * suggestions, a structured-data proposal (visible content only), a source
 * ledger, and fact-check notes. Unresolved facts are visibly marked
 * `[[UNVERIFIED: ...]]` and block publication. The writer model cannot grant
 * a statement "verified" status on its own word: a "verified" note stands only
 * when a cited product fact or trusted evidence item states it
 * (`resolveFactCheckNotes`); otherwise it is downgraded and marked. Drafts are
 * local review artifacts: nothing is published. A human revises a draft with
 * `content revise-manual` (src/content/review.ts#reviseDraftManually).
 */

export const DRAFT_PROMPT_ID = 'content.draft';
export const DRAFT_DISCLAIMER = 'Review artifact only. NOT approved for publication. Publication requires human review and a publish_content approval bound to this exact draft; unresolved facts must be resolved first.';

export interface PreconditionCheck {
  id: 'item' | 'mode' | 'brief_gate' | 'brief_integrity' | 'approval' | 'capacity' | 'model' | 'synthetic' | 'observation';
  ok: boolean;
  detail: string;
}

export interface DraftPreconditions {
  ok: boolean;
  code: ErrorCode | null;
  checks: PreconditionCheck[];
  item: ContentItem | null;
  brief: BriefRecord | null;
  approval: ApprovalCheck | null;
  capacity: { inProduction: number; maxInProduction: number };
}

export class DraftRefusedError extends AppError {
  constructor(
    code: ErrorCode,
    message: string,
    readonly preconditions: DraftPreconditions,
    readonly approvalRequest: ApprovalRecord | null,
    hint?: string,
  ) {
    super(code, message, {
      details: {
        checks: preconditions.checks,
        errors: preconditions.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`),
        ...(approvalRequest ? { approvalRequest: { id: approvalRequest.id, status: approvalRequest.status, expiresAt: approvalRequest.expiresAt } } : {}),
      },
      ...(hint ? { hint } : {}),
    });
    this.name = 'DraftRefusedError';
  }
}

/** Stored for the human reviewer when the writer's output needs review (bounded, secrets redacted). */
export interface DraftModelReview {
  status: 'needs_review';
  reason: string;
  callId: string | null;
  lastRawOutput: string | null;
  rawOutputTruncated: boolean;
}

const MAX_STORED_RAW_OUTPUT = 20_000;

/**
 * The writer's output failed validation after the gateway's controlled repair
 * attempts (at most two): the task goes to HUMAN REVIEW (spec §9), not to a
 * provider failure. Nothing is persisted as a draft and the draft approval is
 * NOT consumed. The durable draft stage turns this into a `needs_review` stop
 * with the call id and the last raw output stored for the reviewer.
 */
export class DraftNeedsReviewError extends AppError {
  constructor(
    message: string,
    readonly review: DraftModelReview,
  ) {
    super('VALIDATION_FAILED', message, {
      details: { status: 'needs_review', callId: review.callId, rawOutputChars: review.lastRawOutput?.length ?? 0 },
      hint: 'The model output did not validate after the controlled repair attempts. A human reviews the stored raw output (call id in the job checkpoint / audit log); re-run `npm run cli -- content produce <item-id> --mode DRAFT --use-model` to try again (the draft approval was not used).',
    });
    this.name = 'DraftNeedsReviewError';
  }
}

/**
 * Map a failed writer call to an error with an honest code. Only real
 * provider failures are PROVIDER_ERROR (those count toward the provider's
 * circuit breaker); budget, configuration, and credential problems are local.
 */
export function writerFailure(res: Extract<StructuredResult<unknown>, { ok: false }>): AppError {
  const message = `Draft generation failed (${res.status}): ${res.reason}`;
  const details: Record<string, unknown> = { status: res.status, ...(res.callId ? { callId: res.callId } : {}), ...(res.approvalId ? { approvalId: res.approvalId } : {}), ...(res.reservationId ? { reservationId: res.reservationId } : {}) };
  const hint = res.nextStep ? { hint: res.nextStep } : {};
  switch (res.status) {
    case 'needs_review': {
      const raw = res.lastRawOutput ? redactString(res.lastRawOutput) : null;
      return new DraftNeedsReviewError(`Draft output needs human review: ${res.reason}`, {
        status: 'needs_review',
        reason: res.reason,
        callId: res.callId ?? null,
        lastRawOutput: raw ? raw.slice(0, MAX_STORED_RAW_OUTPUT) : null,
        rawOutputTruncated: !!raw && raw.length > MAX_STORED_RAW_OUTPUT,
      });
    }
    case 'budget_exceeded':
      return new AppError('BUDGET_EXCEEDED', message, { details, ...hint });
    case 'budget_unknown_price':
      return new AppError('BUDGET_UNKNOWN_PRICE', message, { details, ...hint });
    case 'invalid_model':
    case 'unsupported':
      return new AppError('CONFIG_INVALID', message, { details, ...hint });
    case 'not_configured':
      return new AppError('CREDENTIALS_MISSING', message, { details, ...hint });
    case 'disabled':
      return new AppError('INTEGRATION_DISABLED', message, { details, ...hint });
    case 'provider_error':
    default:
      // A possibly accepted (and billed) submission is never retried blindly.
      return new AppError(res.ambiguous ? 'AMBIGUOUS_SUBMISSION' : 'PROVIDER_ERROR', message, { details: { ...details, ...(res.ambiguous ? { ambiguous: true } : {}) }, ...hint });
  }
}

/**
 * Authorization through an approved `batch_expansion` request. It is never
 * trusted as given: the approval must exist for exactly `subjectId` +
 * `artifactHash` (approved, or already executed by the batch run that
 * consumed it), `hashObject(hashInput)` must equal `artifactHash`, and the
 * item's CURRENT latest brief id/hash must be listed in `hashInput.briefs`.
 */
export interface BatchDraftAuthorization {
  approvalId: string;
  /** Approval subject id (the batch key, or `<batchKey>:expansion` for the expansion phase). */
  subjectId: string;
  artifactHash: string;
  hashInput: { siteId: string; briefs: Array<{ itemId: string; briefId: string; briefHash: string }>; [k: string]: unknown };
  /** The batch runner reserved capacity for every item (only honoured when the authorization verifies). */
  capacityReserved: boolean;
}

export interface DraftOptions {
  /** Batch authorization (verified here). When absent, the item's own draft approval is required. */
  batch?: BatchDraftAuthorization;
  /** Evaluate preconditions only (no model call, no writes, no approval requests). */
  preview?: boolean;
  requestedBy?: string;
}

export function checkDraftPreconditions(ctx: AppContext, deps: ContentDeps, itemId: string, opts: DraftOptions = {}): DraftPreconditions {
  const checks: PreconditionCheck[] = [];
  const item = getItem(ctx.db, ctx.siteId, itemId);
  checks.push(
    !item
      ? { id: 'item', ok: false, detail: `Content item ${itemId} not found.` }
      : !item.decision || item.decision === 'defer' || item.decision === 'reject'
        ? { id: 'item', ok: false, detail: `Item decision is "${item.decision ?? 'none'}".` }
        : ['approved', 'exported', 'published', 'measuring', 'rejected'].includes(item.stage)
          ? { id: 'item', ok: false, detail: `Item stage is "${item.stage}".` }
          : { id: 'item', ok: true, detail: `Item "${truncate(item.title, 60)}" (${item.decision}).` },
  );
  checks.push(
    modeAtLeast(ctx.mode, 'DRAFT')
      ? { id: 'mode', ok: true, detail: `Runtime mode ${ctx.mode}.` }
      : { id: 'mode', ok: false, detail: `Runtime mode ${ctx.mode} cannot create drafts; DRAFT (or EXECUTE) is required.` },
  );
  const brief = item ? latestBrief(ctx.db, ctx.siteId, itemId) : null;
  const gateOk = !!brief && (brief.status === 'gate_passed' || brief.status === 'approved') && !!brief.gate?.passed;
  checks.push(
    !brief
      ? { id: 'brief_gate', ok: false, detail: 'No brief exists for this item.' }
      : gateOk
        ? { id: 'brief_gate', ok: true, detail: `Brief v${brief.version} passed its gate.` }
        : { id: 'brief_gate', ok: false, detail: `Brief v${brief.version} status is "${brief.status}" (gate ${brief.gate?.passed ? 'passed' : 'not passed'}).` },
  );
  const integrity = !!brief && briefHash(brief.brief) === brief.contentHash;
  checks.push(brief ? { id: 'brief_integrity', ok: integrity, detail: integrity ? `Brief hash ${brief.contentHash.slice(0, 12)} verified.` : 'Stored brief content no longer matches its recorded hash.' } : { id: 'brief_integrity', ok: false, detail: 'No brief.' });

  let approval: ApprovalCheck | null = null;
  let batchVerified = false;
  if (opts.batch) {
    const v = verifyBatchAuthorization(ctx, deps, itemId, brief, opts.batch);
    batchVerified = v.ok;
    checks.push({ id: 'approval', ok: v.ok, detail: v.detail });
  } else if (!deps.approvals) {
    checks.push({ id: 'approval', ok: false, detail: 'Approval service not wired: drafts cannot be authorized.' });
  } else if (brief) {
    approval = deps.approvals.check({ siteId: ctx.siteId, actionType: 'draft_generation', subjectType: 'content_brief', subjectId: brief.id, artifactHash: brief.contentHash });
    checks.push(
      approval.ok
        ? { id: 'approval', ok: true, detail: `Approval ${approval.approval.id} by ${approval.approval.approver ?? 'unknown'} is valid for this brief hash.` }
        : { id: 'approval', ok: false, detail: approvalDetail(approval) },
    );
  } else checks.push({ id: 'approval', ok: false, detail: 'No brief to approve.' });

  const inProduction = countInProduction(ctx.db, ctx.siteId, itemId);
  const max = ctx.config.content.maxInProduction;
  const capOk = (batchVerified && opts.batch?.capacityReserved) || inProduction < max;
  checks.push({ id: 'capacity', ok: !!capOk, detail: capOk ? `${inProduction} other item(s) in production (max ${max}).` : `${inProduction} item(s) already in production (content.maxInProduction=${max}). Finish, publish, or reject them first; batch expansion requires content.batchEnabled, content.pilotApproved, and a batch_expansion approval.` });

  const llm = deps.llm;
  const modelOk = !!llm && ctx.settings.features.llm && llm.isConfigured('reasoning');
  checks.push({ id: 'model', ok: modelOk, detail: modelOk ? 'Reasoning model configured.' : !llm ? 'LLM client not wired.' : !ctx.settings.features.llm ? 'features.llm is false.' : 'REASONING_MODEL is not configured.' });
  const synthetic = !!item?.isSynthetic || !!brief?.brief.isSynthetic;
  checks.push({ id: 'synthetic', ok: !synthetic || ctx.synthetic, detail: synthetic ? (ctx.synthetic ? 'Synthetic demo data (demo context).' : 'Synthetic fixture data cannot be drafted outside the demo workspace.') : 'Real data.' });
  // One change per page at a time: no paid draft for a page whose experiment is still observing (spec 18/23).
  const hold = item ? observationHold(ctx, item) : null;
  checks.push(
    hold
      ? { id: 'observation', ok: false, detail: `${hold.reason} ${observationHint(hold)}` }
      : { id: 'observation', ok: true, detail: item?.targetPageId ? 'No experiment is observing the target page.' : 'No existing target page (nothing under observation).' },
  );

  const failed = checks.filter((c) => !c.ok);
  const code: ErrorCode | null = !failed.length
    ? null
    : failed.some((c) => c.id === 'item')
      ? 'NOT_FOUND'
      : failed.some((c) => c.id === 'observation')
        ? 'CONFLICT'
        : failed.some((c) => c.id === 'mode' || c.id === 'brief_gate' || c.id === 'brief_integrity' || c.id === 'capacity' || c.id === 'synthetic')
        ? 'POLICY_DENIED'
        : failed.some((c) => c.id === 'approval')
          ? 'APPROVAL_REQUIRED'
          : 'INTEGRATION_UNAVAILABLE';
  return { ok: !failed.length, code, checks, item, brief, approval, capacity: { inProduction, maxInProduction: max } };
}

/** Verify a batch authorization against the approval service and the item's current brief. */
export function verifyBatchAuthorization(ctx: AppContext, deps: ContentDeps, itemId: string, brief: BriefRecord | null, auth: BatchDraftAuthorization): { ok: boolean; detail: string } {
  if (!deps.approvals) return { ok: false, detail: 'Approval service not wired: the batch authorization cannot be verified.' };
  if (auth.hashInput?.siteId !== ctx.siteId || hashObject(auth.hashInput) !== auth.artifactHash) return { ok: false, detail: 'Batch authorization does not match its approved artifact hash (forged or altered).' };
  const c = deps.approvals.check({ siteId: ctx.siteId, actionType: 'batch_expansion', subjectType: 'content_batch', subjectId: auth.subjectId, artifactHash: auth.artifactHash });
  const approval = c.ok ? c.approval : c.reason === 'already_executed' ? (c.approval ?? null) : null;
  if (!approval) return { ok: false, detail: `No approved batch_expansion approval for batch ${auth.subjectId.slice(0, 12)} (${c.ok ? 'ok' : c.reason}).` };
  if (approval.id !== auth.approvalId) return { ok: false, detail: `Batch authorization names approval ${auth.approvalId}, but the approval bound to this batch is ${approval.id}.` };
  const listed = auth.hashInput.briefs.find((b) => b.itemId === itemId);
  if (!listed) return { ok: false, detail: `Item ${itemId} is not part of the approved batch.` };
  if (!brief || brief.id !== listed.briefId || brief.contentHash !== listed.briefHash) {
    return { ok: false, detail: `The item's current brief${brief ? ` (v${brief.version}, ${brief.contentHash.slice(0, 12)})` : ''} is not the brief approved in the batch (${listed.briefHash.slice(0, 12)}); the batch approval does not cover it.` };
  }
  return { ok: true, detail: `Covered by approved batch ${auth.subjectId.slice(0, 12)} (approval ${approval.id} by ${approval.approver ?? 'unknown'}), bound to this exact brief hash.` };
}

function approvalDetail(a: Extract<ApprovalCheck, { ok: false }>): string {
  switch (a.reason) {
    case 'none':
      return 'No draft_generation approval exists for this exact brief hash.';
    case 'pending':
      return `Approval ${a.approval?.id ?? ''} is pending a human decision.`.replace('  ', ' ');
    case 'rejected':
      return 'The draft approval was rejected.';
    case 'expired':
      return 'The draft approval expired.';
    case 'already_executed':
      return 'The draft approval was already used (one-time). Request a new approval to generate another draft; automated revisions of the existing draft use `content review <draft-id> --revise`.';
    case 'hash_mismatch':
      return 'The approval was granted for a different brief version (hash mismatch).';
    case 'revision_mismatch':
      return 'The approval was granted against a different source revision.';
    case 'invalidated':
      return 'The approval was invalidated.';
  }
}

// ---------------------------------------------------------------------------
// Writer call and package assembly
// ---------------------------------------------------------------------------

interface WriterResult {
  output: DraftModelOutput;
  promptVersion: string;
  model: string;
  callId: string;
  costMicros: number | null;
  truncated: string[];
  synthetic: boolean;
  /** The target page's current text as sent to the writer (improve/add-section), or null. */
  targetPageText: string | null;
}

async function callWriter(ctx: AppContext, deps: ContentDeps, brief: ContentBrief, revision: { previousBody: string; reasons: QualityReason[]; round: number } | null): Promise<WriterResult> {
  const llm = deps.llm!;
  const evidence: EvidenceItem[] = [
    {
      id: 'brief',
      label: `Approved brief for item ${brief.contentItemId}`,
      text: JSON.stringify({
        audience: brief.audience,
        primaryQuestion: brief.primaryQuestion,
        queries: brief.queryCluster.queries.slice(0, 15),
        intent: brief.intent,
        decision: brief.decision,
        pageType: brief.pageType,
        businessPurpose: brief.businessPurpose,
        uniqueContribution: brief.uniqueContribution,
        outline: brief.outline,
        usefulExamples: brief.usefulExamples,
        internalLinks: brief.internalLinks.filter((l) => l.verified),
        cta: brief.cta,
        unresolvedQuestions: brief.unresolvedQuestions,
        researchFindings: brief.researchFindings,
        catalogAttributes: brief.catalogAttributes,
        programmatic: brief.programmatic,
      }),
      trustClass: 'model_generated',
    },
    ...brief.evidenceSources.map((e) => ({
      id: e.id,
      label: `${e.label}${e.isSynthetic ? ' [SYNTHETIC]' : ''}`,
      text: `${e.excerpt}\nLimitations: ${e.limitations}`,
      trustClass: e.trustClass as TrustClass,
      ...(e.url ? { url: e.url } : {}),
    })),
  ];
  let targetPageText: string | null = null;
  if ((brief.decision === 'improve_existing' || brief.decision === 'add_section') && brief.targetPageUrl) {
    const { pages } = loadSitePages(ctx);
    const target = pages.find((p) => p.url === brief.targetPageUrl);
    if (target?.textRef) {
      try {
        const t = rawText(ctx.raw.load(target.textRef));
        if (t) {
          targetPageText = truncate(t, 8000);
          evidence.push({ id: 'target_page_text', label: `Current text of ${target.url}`, text: targetPageText, trustClass: 'first_party_measurement', url: target.url });
        }
      } catch {
        /* unreadable raw text: the writer works from the brief */
      }
    }
  }
  if (revision) {
    evidence.push({ id: 'previous_draft', label: `Previous draft (revision round ${revision.round - 1})`, text: revision.previousBody, trustClass: 'model_generated' });
    evidence.push({
      id: 'quality_findings',
      label: 'Quality gate findings to fix (computed by code)',
      text: revision.reasons.map((r) => `- [${r.code}] ${r.message} Fix: ${r.fix}`).join('\n'),
      trustClass: 'first_party_measurement',
    });
  }
  const cfg = ctx.config;
  const res = await llm.structured({
    siteId: ctx.siteId,
    runId: ctx.runId,
    role: 'writer',
    tier: 'reasoning',
    promptId: DRAFT_PROMPT_ID,
    variables: {
      business_name: cfg.site.businessName,
      language: brief.language,
      brand_voice: cfg.editorial.brandVoice,
      avoid_emojis: cfg.editorial.avoidEmojis ? 'yes' : 'no',
      avoid_em_dashes: cfg.editorial.avoidEmDashes ? 'yes' : 'no',
      editorial_requirements: cfg.editorial.requirements.join('; ') || 'none',
      prohibited_claims: cfg.business.prohibitedClaims.join('; ') || 'none',
      page_type: brief.pageType,
      decision: brief.decision,
      intent: brief.intent,
      proposed_url: brief.proposedUrl ?? 'none',
      target_page_url: brief.targetPageUrl ?? 'none',
      product_fact_ids: brief.productFactIds.map((id) => `fact:${id}`).join(', ') || 'none',
      allowed_evidence_ids: evidence.map((e) => e.id).join(', '),
      revision_round: revision?.round ?? 0,
      structured_data_rules: structuredDataPromptRules(),
    },
    evidence,
    schema: draftModelOutputSchema,
    schemaName: 'ContentDraftPackage',
    maxOutputTokens: cfg.llm.maxOutputTokensReasoning,
  });
  if (!res.ok) {
    const err = writerFailure(res);
    if (err instanceof DraftNeedsReviewError) {
      audit(ctx.db, ctx.siteId, 'content.draft_needs_review', 'content_item', brief.contentItemId, { reason: err.review.reason, callId: err.review.callId, revisionRound: revision?.round ?? 0, rawOutputChars: err.review.lastRawOutput?.length ?? 0, rawOutputExcerpt: err.review.lastRawOutput?.slice(0, 2000) ?? null }, ctx.clock.now());
    }
    throw err;
  }
  return { output: res.value, promptVersion: res.promptVersion, model: res.model, callId: res.callId, costMicros: res.costMicros, truncated: res.truncation.map((t) => t.evidenceId), synthetic: llm.synthetic, targetPageText };
}

/**
 * Fact-check notes as stored. Unknown evidence ids are dropped (a bare
 * configured product-fact id is kept as `fact:<id>`). A "verified" status is
 * the writer model's claim only: it stands when a cited product fact, owner
 * statement, or trusted evidence item states the statement
 * (`factNoteSupport`); otherwise the note is downgraded to "unverified" with
 * the reason, so markUnresolved marks it `[[UNVERIFIED: ...]]` and it blocks
 * publication until an owner resolves it.
 */
export function resolveFactCheckNotes(
  notes: DraftModelOutput['factCheckNotes'],
  opts: { knownIds: ReadonlySet<string>; sources: ReadonlyMap<string, string>; productFactIds: ReadonlySet<string> },
): FactCheckNote[] {
  return notes.map((n) => {
    const cited = [...new Set(n.evidenceIds.map((id) => normalizeFactNoteId(id, opts.productFactIds)))];
    const evidenceIds = cited.filter((id) => opts.knownIds.has(id) || opts.sources.has(id));
    const note: FactCheckNote = { statement: n.statement, status: n.status, evidenceIds, note: n.note };
    if (n.status !== 'verified') return note;
    const support = factNoteSupport(n.statement, evidenceIds, opts.sources);
    if (support.supported) return note;
    const dropped = cited.filter((id) => !evidenceIds.includes(id));
    const reason = `The writer model called this "verified", but ${support.reason}${dropped.length ? ` (ids outside the approved bundle were dropped: ${dropped.join(', ')})` : ''}. Downgraded to unverified by code; an owner confirms it with a source.`;
    return { ...note, status: 'unverified', downgraded: { from: 'verified', reason } };
  });
}

/**
 * Ensure every unresolved statement is visibly marked; returns the marked
 * body. A "verified" note without any evidence id is treated as unresolved
 * (a model's word is not evidence); a human-confirmed note is not.
 */
export function markUnresolved(body: string, notes: DraftPackage['factCheckNotes'], brief: ContentBrief): string {
  let out = body;
  const appendix: string[] = [];
  const pending = notes.filter((n) => n.statement.trim() && !n.humanResolution && (n.status !== 'verified' || n.evidenceIds.length === 0));
  for (const n of pending) {
    const stmt = n.statement.trim();
    if (unverifiedMarkers(out).some((m) => normalizeText(m) === normalizeText(stmt))) continue;
    const idx = out.indexOf(stmt);
    if (idx >= 0) out = `${out.slice(0, idx)}[[UNVERIFIED: ${stmt}]]${out.slice(idx + stmt.length)}`;
    else appendix.push(`- [[UNVERIFIED: ${stmt}]]${n.note ? ` (${n.note})` : ''}`);
  }
  for (const a of brief.catalogAttributes.filter((x) => !x.validated || x.source === 'image' || x.source === 'model')) {
    const re = new RegExp(`(?<!UNVERIFIED: [^\\]]{0,200})${escapeRegExp(a.value)}`, 'i');
    if (re.test(out)) out = out.replace(re, (m) => `[[UNVERIFIED: ${m}]]`);
  }
  if (appendix.length) out = `${out.trimEnd()}\n\n## Unresolved facts (must be resolved before publication)\n\n${appendix.join('\n')}\n`;
  return out;
}

function resolveSiteUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString().replace(/\/+$/, '').toLowerCase();
  } catch {
    return href.replace(/\/+$/, '').toLowerCase();
  }
}

function assemblePackage(ctx: AppContext, brief: BriefRecord, w: WriterResult, revisionRound: number, authorization: DraftAuthorization): DraftPackage {
  const { pages } = loadSitePages(ctx);
  const known = new Set(pages.filter((p) => p.lifecycle !== 'gone' && (p.statusCode === null || (p.statusCode >= 200 && p.statusCode < 300))).map((p) => p.url.replace(/\/+$/, '').toLowerCase()));
  const evidenceIds = new Set([...brief.brief.evidenceSources.map((e) => e.id), 'brief', 'target_page_text']);
  const factIds = new Set(ctx.config.business.productFacts.map((f) => f.id));
  const o = w.output;
  const sources = factVerificationSources(ctx.config, brief.brief.evidenceSources, w.targetPageText ? [{ id: 'target_page_text', text: w.targetPageText }] : []);
  const notes = resolveFactCheckNotes(o.factCheckNotes, { knownIds: evidenceIds, sources, productFactIds: factIds });
  const body = markUnresolved(o.bodyMarkdown, notes, brief.brief);
  const markers = [...new Set(unverifiedMarkers(body))];
  const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(o.slugSuggestion) ? o.slugSuggestion : slugify(o.slugSuggestion, 80);
  const isSynthetic = brief.brief.isSynthetic || w.synthetic;
  const blockers = [
    'Human review required (quality verdicts and AI review never authorize publication).',
    'A publish_content approval bound to this exact draft (body hash) is required.',
    ...(markers.length ? [`${markers.length} unresolved fact(s) marked [[UNVERIFIED: ...]] must be resolved.`] : []),
    ...(isSynthetic ? ['Synthetic/fixture content: never publish.'] : []),
  ];
  return {
    schemaVersion: 1,
    contentItemId: brief.contentItemId,
    briefId: brief.id,
    briefVersion: brief.version,
    briefHash: brief.contentHash,
    language: brief.brief.language,
    body,
    titleOptions: o.titleOptions.map((t) => t.trim()).filter(Boolean),
    metaDescription: o.metaDescription.trim(),
    slugSuggestion: slug,
    internalLinkSuggestions: o.internalLinkSuggestions.map((l) => ({ ...l, verified: known.has(resolveSiteUrl(l.targetUrl, ctx.config.site.url)) })),
    structuredDataProposal: o.structuredDataProposal
      ? { ...o.structuredDataProposal, note: 'Proposal only: must describe visible content and meet the current feature requirements (structured-data requirements table); rich results are never guaranteed, FAQ and How-to rich results are no longer shown, and dates are set by a human at publication.' }
      : null,
    sourceLedger: o.sourceLedger.map((l) => {
      const ev = l.evidenceIds.filter((id) => evidenceIds.has(id));
      const facts = l.factIds.map((f) => f.replace(/^fact:/, '')).filter((f) => factIds.has(f));
      return { claim: l.claim, evidenceIds: ev, factIds: facts, status: ev.length + facts.length === l.evidenceIds.length + l.factIds.length && ev.length + facts.length > 0 ? 'supported' : 'unknown_reference' };
    }),
    factCheckNotes: notes,
    unresolvedFacts: markers,
    publicationBlockers: blockers,
    generatedBy: { promptVersion: w.promptVersion, model: w.model, callId: w.callId, costMicros: w.costMicros, synthetic: w.synthetic, truncatedEvidence: w.truncated },
    revisionRound,
    authorization,
    disclaimer: DRAFT_DISCLAIMER,
    isSynthetic,
  };
}

// ---------------------------------------------------------------------------
// Generate / revise
// ---------------------------------------------------------------------------

export interface GenerateDraftResult {
  draft: DraftRecord;
  approvalConsumed: ApprovalRecord | null;
  preconditions: DraftPreconditions;
}

/**
 * Throw the DraftRefusedError generateDraft would raise when a precondition
 * fails (creating the pending draft approval request exactly as it would).
 * Returns the passing preconditions otherwise. No model call.
 */
export function assertDraftReady(ctx: AppContext, deps: ContentDeps, itemId: string, opts: DraftOptions = {}): DraftPreconditions {
  const pre = checkDraftPreconditions(ctx, deps, itemId, opts);
  if (!pre.ok) {
    let approvalRequest: ApprovalRecord | null = null;
    const approvalFailed = pre.checks.find((c) => c.id === 'approval' && !c.ok);
    const onlyApproval = pre.checks.filter((c) => !c.ok).every((c) => c.id === 'approval' || c.id === 'mode' || c.id === 'model');
    // Create (or return) the pending request so a human can approve this exact brief. Never in preview/dry-run.
    if (approvalFailed && onlyApproval && deps.approvals && pre.brief && pre.item && !opts.preview && !ctx.dryRun && pre.approval && !pre.approval.ok && ['none', 'pending', 'already_executed', 'expired', 'hash_mismatch'].includes(pre.approval.reason)) {
      approvalRequest = deps.approvals.request({
        siteId: ctx.siteId,
        actionType: 'draft_generation',
        target: itemId,
        subjectType: 'content_brief',
        subjectId: pre.brief.id,
        artifactHash: pre.brief.contentHash,
        summary: `Generate a draft for "${truncate(pre.item.title, 80)}" from brief v${pre.brief.version}.`,
        payload: { briefVersion: pre.brief.version, itemId },
        requestedBy: opts.requestedBy ?? 'seo-agent',
      });
    }
    const held = pre.checks.find((c) => c.id === 'observation' && !c.ok);
    const hold = held && pre.item ? observationHold(ctx, pre.item) : null;
    const first = held ?? pre.checks.find((c) => !c.ok)!;
    throw new DraftRefusedError(
      pre.code ?? 'POLICY_DENIED',
      hold ? `Draft refused: ${hold.reason}` : `Draft refused: ${first.detail}`,
      pre,
      approvalRequest,
      hold
        ? observationHint(hold)
        : approvalRequest
          ? `Approve with: npm run cli -- approvals approve ${approvalRequest.id}  (then re-run with --mode DRAFT)`
          : pre.checks.some((c) => c.id === 'mode' && !c.ok)
            ? 'Re-run with --mode DRAFT after the draft approval is granted.'
            : undefined,
    );
  }
  return pre;
}

export async function generateDraft(ctx: AppContext, deps: ContentDeps, itemId: string, opts: DraftOptions = {}): Promise<GenerateDraftResult> {
  const pre = assertDraftReady(ctx, deps, itemId, opts);
  if (opts.preview || ctx.dryRun) throw new AppError('POLICY_DENIED', 'Draft generation does not run in --dry-run/preview; use checkDraftPreconditions to inspect readiness.', { details: { checks: pre.checks } });

  const brief = pre.brief!;
  const w = await callWriter(ctx, deps, brief.brief, null);
  const authorization: DraftAuthorization = opts.batch
    ? { kind: 'batch', approvalId: opts.batch.approvalId, batchKey: opts.batch.subjectId, artifactHash: opts.batch.artifactHash }
    : { kind: 'item', approvalId: pre.approval && pre.approval.ok ? pre.approval.approval.id : '', briefId: brief.id, briefHash: brief.contentHash };
  const pkg = assemblePackage(ctx, brief, w, 0, authorization);

  // One-time execution: consume the item approval before persisting (a consumed approval without a
  // stored draft is safe; a stored draft without a consumed approval is not).
  let consumed: ApprovalRecord | null = null;
  if (!opts.batch && pre.approval?.ok) {
    consumed = deps.approvals!.consume(pre.approval.approval.id, { action: 'draft_generation', itemId, briefId: brief.id, briefHash: brief.contentHash, at: ctx.clock.now().toISOString() });
  }
  const now = ctx.clock.now().toISOString();
  const draft = ctx.db.transaction(() => {
    const d = insertDraft(ctx.db, {
      siteId: ctx.siteId,
      itemId,
      briefId: brief.id,
      briefVersion: brief.version,
      briefHash: brief.contentHash,
      pkg,
      bodyHash: sha256(pkg.body),
      unresolvedFacts: pkg.unresolvedFacts.length,
      revisionRound: 0,
      promptVersion: w.promptVersion,
      modelId: w.model,
      now,
    });
    updateItem(ctx.db, ctx.siteId, itemId, { stage: 'drafted' }, now);
    audit(ctx.db, ctx.siteId, 'content.draft_created', 'content_draft', d.id, { itemId, briefId: brief.id, briefVersion: brief.version, briefHash: brief.contentHash, authorization, unresolvedFacts: pkg.unresolvedFacts.length, verifiedClaimsDowngraded: pkg.factCheckNotes.filter((n) => n.downgraded).length, model: w.model, promptVersion: w.promptVersion, costMicros: w.costMicros }, ctx.clock.now());
    return d;
  });
  return { draft, approvalConsumed: consumed, preconditions: pre };
}

/**
 * Automated revision (bounded by content.maxAutomatedRevisions, at most 2).
 * Requires DRAFT mode, the same (unchanged, still latest) brief, and proof
 * that generation was authorized for exactly that brief/batch.
 */
export async function reviseDraft(ctx: AppContext, deps: ContentDeps, draftId: string, reasons: QualityReason[]): Promise<DraftRecord> {
  const draft = getDraft(ctx.db, ctx.siteId, draftId);
  if (!draft) throw new AppError('NOT_FOUND', `Draft ${draftId} not found`);
  const latestDraftOfItem = latestDraft(ctx.db, ctx.siteId, draft.contentItemId);
  if (latestDraftOfItem && latestDraftOfItem.id !== draft.id) throw new AppError('CONFLICT', `Draft ${draftId} is not the latest draft of its item (latest: ${latestDraftOfItem.id}); only the latest draft can be revised.`);
  if (draft.pkg.humanRevision) throw new AppError('POLICY_DENIED', `Draft ${draftId} v${draft.version} was written by ${draft.pkg.humanRevision.reviewer}; automated revisions never rewrite a human-authored version.`, { hint: `Edit it again with \`npm run cli -- content revise-manual ${draftId} --body-file <edited.md> --as <name> --mode DRAFT\`.` });
  if (draft.status !== 'needs_revision') throw new AppError('POLICY_DENIED', `Draft ${draftId} is "${draft.status}"; only drafts whose latest quality verdict is needs_revision are revised automatically.`);
  const item = getItem(ctx.db, ctx.siteId, draft.contentItemId);
  if (item && ['approved', 'exported', 'published', 'measuring', 'rejected'].includes(item.stage)) throw new AppError('CONFLICT', `Content item ${item.id} is "${item.stage}"; it cannot be revised automatically.`);
  const max = Math.min(2, ctx.config.content.maxAutomatedRevisions);
  if (draft.revisionRound >= max) {
    throw new AppError('POLICY_DENIED', `Automated revision limit reached (${max}); a human must edit or reject this draft.`, {
      hint: `Edit the body and resolve each [[UNVERIFIED: ...]] marker with a source: \`npm run cli -- content revise-manual ${draftId} --body-file <edited.md> --as <name> [--resolutions <file.json>] --mode DRAFT\`.`,
    });
  }
  if (!modeAtLeast(ctx.mode, 'DRAFT')) throw new AppError('POLICY_DENIED', `Runtime mode ${ctx.mode} cannot revise drafts; DRAFT is required.`);
  const brief = getBrief(ctx.db, ctx.siteId, draft.briefId);
  const latest = latestBrief(ctx.db, ctx.siteId, draft.contentItemId);
  if (!brief || !latest || latest.id !== brief.id || brief.contentHash !== draft.briefHash || briefHash(brief.brief) !== brief.contentHash) {
    throw new AppError('POLICY_DENIED', 'The brief changed since this draft was authorized; a new draft approval is required.');
  }
  if (!deps.approvals) throw new AppError('APPROVAL_REQUIRED', 'Approval service not wired: cannot verify the draft authorization.');
  const auth = draft.pkg.authorization;
  const check =
    auth.kind === 'batch'
      ? deps.approvals.check({ siteId: ctx.siteId, actionType: 'batch_expansion', subjectType: 'content_batch', subjectId: auth.batchKey, artifactHash: auth.artifactHash })
      : deps.approvals.check({ siteId: ctx.siteId, actionType: 'draft_generation', subjectType: 'content_brief', subjectId: brief.id, artifactHash: brief.contentHash });
  const authorized = check.ok || (check.reason === 'already_executed' && !!check.approval);
  if (!authorized) throw new AppError('APPROVAL_REQUIRED', `No valid authorization for this brief (${check.ok ? 'ok' : check.reason}).`);
  if (!deps.llm || !ctx.settings.features.llm || !deps.llm.isConfigured('reasoning')) throw new AppError('INTEGRATION_UNAVAILABLE', 'Reasoning model not configured: automated revision unavailable.');
  if (ctx.dryRun) throw new AppError('POLICY_DENIED', 'Revisions are not generated in --dry-run.');

  const round = draft.revisionRound + 1;
  const w = await callWriter(ctx, deps, brief.brief, { previousBody: draft.pkg.body, reasons: reasons.filter((r) => r.consequence !== 'human'), round });
  const pkg = assemblePackage(ctx, brief, w, round, auth);
  const now = ctx.clock.now().toISOString();
  return ctx.db.transaction(() => {
    const d = insertDraft(ctx.db, {
      siteId: ctx.siteId,
      itemId: draft.contentItemId,
      briefId: brief.id,
      briefVersion: brief.version,
      briefHash: brief.contentHash,
      pkg,
      bodyHash: sha256(pkg.body),
      unresolvedFacts: pkg.unresolvedFacts.length,
      revisionRound: round,
      promptVersion: w.promptVersion,
      modelId: w.model,
      now,
    });
    updateItem(ctx.db, ctx.siteId, draft.contentItemId, { stage: 'drafted' }, now);
    audit(ctx.db, ctx.siteId, 'content.draft_revised', 'content_draft', d.id, { previousDraftId: draftId, revisionRound: round, reasons: reasons.map((r) => r.code), unresolvedFacts: pkg.unresolvedFacts.length, verifiedClaimsDowngraded: pkg.factCheckNotes.filter((n) => n.downgraded).length, model: w.model, costMicros: w.costMicros }, ctx.clock.now());
    return d;
  });
}
