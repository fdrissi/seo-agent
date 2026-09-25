import type { AppContext } from '../app/context.js';
import type { ApprovalRecord } from '../approvals/types.js';
import { DEFAULT_WORKERS, mapBounded } from '../core/concurrency.js';
import { errorMessage, isAppError } from '../core/errors.js';
import { hashObject } from '../core/hash.js';
import { modeAtLeast } from '../core/modes.js';
import type { ContentDeps } from './deps.js';
import { generateDraft, type BatchDraftAuthorization } from './draft.js';
import { reviewWithRevisions } from './review.js';
import { audit, countInProduction, getItem, humanAcceptedDraft, latestBrief, latestDraft, siblingDrafts } from './store.js';
import { IN_PRODUCTION_STAGES, type DraftRecord, type Verdict } from './types.js';

/**
 * BOUNDED PARALLEL batch drafts.
 *
 * Default is one item in production at a time. Batch drafting requires ALL of:
 *   - content.batchEnabled: true
 *   - content.pilotApproved: true (the owner allows batch work at all)
 *   - an approved `batch_expansion` approval bound to the exact set of briefs
 *   - DRAFT mode and free production capacity for every item
 *
 * Two human gates, never automated verdicts alone:
 *   1. PILOT: the first approval drafts a small pilot (up to 3 items) and the
 *      run STOPS (status `pilot_complete`). Nothing else is drafted.
 *   2. EXPANSION: only after a named human accepted EVERY pilot draft
 *      (`content mark-reviewed`) is a second `batch_expansion` approval
 *      requested, bound to the remaining briefs and the reviewed pilot draft
 *      bodies. Once a human approves it, re-running drafts the rest.
 *
 * Drafts run with at most `workers` (default 3) concurrent generations;
 * parallelism does not reduce token charges. Deterministic checks run on
 * EVERY item, including cross-item template similarity. Nothing is published.
 */

export const PILOT_SIZE = 3;

export interface BatchItemResult {
  itemId: string;
  status: 'drafted' | 'failed' | 'skipped';
  draftId?: string;
  verdict?: Verdict;
  revisions?: number;
  error?: string;
  phase: 'pilot' | 'expansion';
}

export interface BatchResult {
  status: 'refused' | 'pilot_complete' | 'completed' | 'halted_after_pilot';
  reason: string;
  batchKey: string;
  artifactHash: string;
  approvalRequest: ApprovalRecord | null;
  items: BatchItemResult[];
  pilot: { size: number; passed: boolean | null };
  /** Which phase this run executed or is waiting for. */
  phase: 'pilot' | 'expansion' | null;
  workers: number;
}

export function batchIdentity(ctx: AppContext, itemIds: string[]): { batchKey: string; artifactHash: string; briefs: Array<{ itemId: string; briefId: string; briefHash: string }>; missing: string[] } {
  const sorted = [...new Set(itemIds)].sort();
  const briefs: Array<{ itemId: string; briefId: string; briefHash: string }> = [];
  const missing: string[] = [];
  for (const id of sorted) {
    const b = latestBrief(ctx.db, ctx.siteId, id);
    if (b && (b.status === 'gate_passed' || b.status === 'approved') && b.gate?.passed) briefs.push({ itemId: id, briefId: b.id, briefHash: b.contentHash });
    else missing.push(id);
  }
  return { batchKey: hashObject({ siteId: ctx.siteId, items: sorted }).slice(0, 32), artifactHash: hashObject({ siteId: ctx.siteId, briefs }), briefs, missing };
}

/** The expansion phase is bound to the remaining briefs AND the exact pilot draft bodies a human reviewed. */
export function expansionIdentity(ctx: AppContext, batchKey: string, rest: Array<{ itemId: string; briefId: string; briefHash: string }>, pilotDrafts: DraftRecord[]): { subjectId: string; artifactHash: string; hashInput: BatchDraftAuthorization['hashInput'] } {
  const hashInput = { siteId: ctx.siteId, phase: 'expansion', batchKey, briefs: rest, pilotDrafts: pilotDrafts.map((d) => ({ itemId: d.contentItemId, draftId: d.id, bodyHash: d.bodyHash })) };
  return { subjectId: `${batchKey}:expansion`, artifactHash: hashObject(hashInput), hashInput };
}

export async function runBatchDrafts(ctx: AppContext, deps: ContentDeps, opts: { itemIds: string[]; workers?: number; requestedBy?: string }): Promise<BatchResult> {
  const workers = Math.max(1, Math.min(opts.workers ?? DEFAULT_WORKERS, DEFAULT_WORKERS));
  const id = batchIdentity(ctx, opts.itemIds);
  const base = { batchKey: id.batchKey, artifactHash: id.artifactHash, approvalRequest: null as ApprovalRecord | null, items: [] as BatchItemResult[], pilot: { size: 0, passed: null as boolean | null }, phase: null as BatchResult['phase'], workers };
  const refuse = (reason: string, extra: Partial<BatchResult> = {}): BatchResult => ({ ...base, ...extra, status: 'refused', reason });
  const c = ctx.config.content;
  if (!c.batchEnabled || !c.pilotApproved) {
    return refuse(`Batch expansion is disabled: requires content.batchEnabled: true AND content.pilotApproved: true (currently ${c.batchEnabled}/${c.pilotApproved}) plus an approved batch_expansion request. Default is one item in production at a time.`);
  }
  if (!modeAtLeast(ctx.mode, 'DRAFT')) return refuse(`Runtime mode ${ctx.mode} cannot create drafts; DRAFT is required.`);
  if (id.missing.length) return refuse(`Items without a gate-passed brief: ${id.missing.join(', ')}.`);
  if (!id.briefs.length) return refuse('No items given.');
  const others = countInProduction(ctx.db, ctx.siteId) - id.briefs.filter((b) => IN_PRODUCTION_STAGES.includes(getItem(ctx.db, ctx.siteId, b.itemId)?.stage ?? 'discovered')).length;
  if (others + id.briefs.length > c.maxInProduction) {
    return refuse(`Capacity: ${others} item(s) already in production + ${id.briefs.length} requested exceeds content.maxInProduction=${c.maxInProduction}.`);
  }
  if (!deps.approvals) return refuse('Approval service not wired: batch expansion cannot be authorized.');
  const approvals = deps.approvals;
  const requestedBy = opts.requestedBy ?? 'seo-agent';
  const ids = id.briefs.map((b) => b.itemId);
  const pilotIds = ids.slice(0, PILOT_SIZE);
  const restBriefs = id.briefs.slice(PILOT_SIZE);
  const pilotSize = pilotIds.length;

  const generated = new Map<string, DraftRecord>();
  const runPhase = async (itemIds: string[], phase: BatchItemResult['phase'], auth: BatchDraftAuthorization): Promise<BatchItemResult[]> => {
    // 1) bounded parallel generation
    const gen = await mapBounded(itemIds, workers, async (itemId) => (await generateDraft(ctx, deps, itemId, { batch: auth, requestedBy })).draft);
    gen.forEach((g, i) => {
      if (g.ok) generated.set(itemIds[i]!, g.value);
    });
    // 2) deterministic checks (+ bounded AI review and revisions) on every item, with batch siblings
    const results = await mapBounded(itemIds, workers, async (itemId, i): Promise<BatchItemResult> => {
      const g = gen[i]!;
      if (!g.ok) return { itemId, status: 'failed', error: isAppError(g.error) ? `${g.error.code}: ${g.error.message}` : errorMessage(g.error), phase };
      const siblings = [
        ...[...generated.entries()].filter(([other]) => other !== itemId).map(([other, d]) => ({ draftId: d.id, itemId: other, body: d.pkg.body, templateId: null })),
        ...siblingDrafts(ctx.db, ctx.siteId, itemId)
          .filter((d) => !generated.has(d.contentItemId))
          .map((d) => ({ draftId: d.id, itemId: d.contentItemId, body: d.pkg.body, templateId: null })),
      ];
      const cycle = await reviewWithRevisions(ctx, deps, g.value.id, { siblings });
      const final = cycle.reviews[cycle.reviews.length - 1]!;
      const finalDraft = cycle.drafts[cycle.drafts.length - 1] ?? g.value;
      generated.set(itemId, finalDraft);
      return { itemId, status: 'drafted', draftId: finalDraft.id, verdict: final.verdict, revisions: cycle.drafts.length, phase };
    });
    return results.map((r, i) => (r.ok ? r.value : { itemId: itemIds[i]!, status: 'failed', error: errorMessage(r.error), phase }));
  };
  const done = (status: BatchResult['status'], reason: string, items: BatchItemResult[], extra: Partial<BatchResult> = {}): BatchResult => {
    audit(ctx.db, ctx.siteId, 'content.batch_finished', 'content_batch', id.batchKey, { status, phase: extra.phase ?? null, items: items.map((i) => ({ itemId: i.itemId, status: i.status, verdict: i.verdict })) }, ctx.clock.now());
    return { ...base, ...extra, status, reason: `${reason} Every draft still requires human review; nothing was published.`, items };
  };

  // ------------------------------------------------------------------ pilot
  const pilotCheck = approvals.check({ siteId: ctx.siteId, actionType: 'batch_expansion', subjectType: 'content_batch', subjectId: id.batchKey, artifactHash: id.artifactHash });
  if (!pilotCheck.ok && pilotCheck.reason !== 'already_executed') {
    const request =
      ctx.dryRun || pilotCheck.reason === 'rejected'
        ? null
        : approvals.request({
            siteId: ctx.siteId,
            actionType: 'batch_expansion',
            target: `content-batch:${id.batchKey}`,
            subjectType: 'content_batch',
            subjectId: id.batchKey,
            artifactHash: id.artifactHash,
            summary: `Pilot of ${pilotSize} content draft(s) for a batch of ${id.briefs.length}; the run stops after the pilot for human review.`,
            payload: { phase: 'pilot', briefs: id.briefs, pilotItems: pilotIds, workers },
            requestedBy,
          });
    return refuse(`No valid batch_expansion approval for this exact batch (${pilotCheck.reason}).${request ? ` Approve with: npm run cli -- approvals approve ${request.id}` : ''}`, { approvalRequest: request, phase: 'pilot' });
  }
  if (pilotCheck.ok) {
    if (ctx.dryRun) return refuse(`dry run: the pilot of ${pilotSize} item(s) would run (all preconditions satisfied); nothing generated.`, { phase: 'pilot' });
    approvals.consume(pilotCheck.approval.id, { action: 'batch_expansion', phase: 'pilot', batchKey: id.batchKey, items: pilotIds, at: ctx.clock.now().toISOString() });
    audit(ctx.db, ctx.siteId, 'content.batch_started', 'content_batch', id.batchKey, { phase: 'pilot', approvalId: pilotCheck.approval.id, items: pilotSize, workers }, ctx.clock.now());
    const auth: BatchDraftAuthorization = { approvalId: pilotCheck.approval.id, subjectId: id.batchKey, artifactHash: id.artifactHash, hashInput: { siteId: ctx.siteId, briefs: id.briefs }, capacityReserved: true };
    const pilot = await runPhase(pilotIds, 'pilot', auth);
    const pilotPassed = pilot.every((r) => r.status === 'drafted' && r.verdict !== 'reject');
    const items = [...pilot, ...restBriefs.map((b) => ({ itemId: b.itemId, status: 'skipped' as const, phase: 'expansion' as const, error: pilotPassed ? 'awaiting human review of the pilot' : 'halted after pilot' }))];
    if (!pilotPassed) {
      return done('halted_after_pilot', `Pilot of ${pilotSize} item(s) did not pass (rejected or failed drafts). ${restBriefs.length} remaining item(s) were not drafted; review the pilot results first.`, items, { pilot: { size: pilotSize, passed: false }, phase: 'pilot' });
    }
    if (!restBriefs.length) return done('completed', `Pilot of ${pilotSize} item(s) drafted; the batch has no further items.`, items, { pilot: { size: pilotSize, passed: true }, phase: 'pilot' });
    return done(
      'pilot_complete',
      `Pilot of ${pilotSize} item(s) drafted and STOPPED. Automated verdicts do not authorize expansion: a named human must accept every pilot draft (content mark-reviewed <draft-id> --as <name> --confirm <hash>), then re-run this batch to request the expansion approval for the remaining ${restBriefs.length} item(s).`,
      items,
      { pilot: { size: pilotSize, passed: true }, phase: 'pilot' },
    );
  }

  // ------------------------------------------------------------ expansion
  // The pilot approval was already used: evaluate the pilot drafts.
  const pilotDrafts: DraftRecord[] = [];
  const problems: string[] = [];
  for (const itemId of pilotIds) {
    const d = latestDraft(ctx.db, ctx.siteId, itemId);
    if (!d || d.pkg.authorization.kind !== 'batch' || d.pkg.authorization.batchKey !== id.batchKey) problems.push(`${itemId}: no pilot draft from this batch`);
    else if (d.status === 'rejected' || getItem(ctx.db, ctx.siteId, itemId)?.stage === 'rejected') problems.push(`${itemId}: pilot draft ${d.id} was rejected`);
    else if (!humanAcceptedDraft(ctx.db, ctx.siteId, d.id, d.bodyHash)) problems.push(`${itemId}: pilot draft ${d.id} (${d.status}) has not been accepted by a named human (content mark-reviewed ${d.id})`);
    else pilotDrafts.push(d);
  }
  if (problems.length) {
    return refuse(`The pilot approval for this batch was already used. Expansion requires every pilot draft to pass and be human-accepted: ${problems.join('; ')}.`, { pilot: { size: pilotSize, passed: null }, phase: 'expansion' });
  }
  if (!restBriefs.length) return refuse('The pilot covered the whole batch; there is nothing to expand.', { pilot: { size: pilotSize, passed: true }, phase: 'expansion' });
  const exp = expansionIdentity(ctx, id.batchKey, restBriefs, pilotDrafts);
  const expCheck = approvals.check({ siteId: ctx.siteId, actionType: 'batch_expansion', subjectType: 'content_batch', subjectId: exp.subjectId, artifactHash: exp.artifactHash });
  if (!expCheck.ok) {
    const request =
      ctx.dryRun || expCheck.reason === 'rejected' || expCheck.reason === 'already_executed'
        ? null
        : approvals.request({
            siteId: ctx.siteId,
            actionType: 'batch_expansion',
            target: `content-batch:${id.batchKey}`,
            subjectType: 'content_batch',
            subjectId: exp.subjectId,
            artifactHash: exp.artifactHash,
            summary: `Expand the reviewed pilot (${pilotSize} human-accepted draft(s)) to ${restBriefs.length} more content draft(s).`,
            payload: { phase: 'expansion', briefs: restBriefs, pilotDrafts: exp.hashInput.pilotDrafts, workers },
            requestedBy,
          });
    return refuse(
      expCheck.reason === 'already_executed'
        ? 'The expansion approval for this batch was already used.'
        : `Pilot reviewed by a human. Expansion needs a second batch_expansion approval bound to the remaining briefs and the reviewed pilot drafts (${expCheck.reason}).${request ? ` Approve with: npm run cli -- approvals approve ${request.id}` : ''}`,
      { approvalRequest: request, pilot: { size: pilotSize, passed: true }, phase: 'expansion', artifactHash: exp.artifactHash },
    );
  }
  if (ctx.dryRun) return refuse(`dry run: expansion of ${restBriefs.length} item(s) would run; nothing generated.`, { pilot: { size: pilotSize, passed: true }, phase: 'expansion' });
  approvals.consume(expCheck.approval.id, { action: 'batch_expansion', phase: 'expansion', batchKey: id.batchKey, items: restBriefs.map((b) => b.itemId), at: ctx.clock.now().toISOString() });
  audit(ctx.db, ctx.siteId, 'content.batch_started', 'content_batch', id.batchKey, { phase: 'expansion', approvalId: expCheck.approval.id, items: restBriefs.length, workers }, ctx.clock.now());
  for (const d of pilotDrafts) generated.set(d.contentItemId, d);
  const auth: BatchDraftAuthorization = { approvalId: expCheck.approval.id, subjectId: exp.subjectId, artifactHash: exp.artifactHash, hashInput: exp.hashInput, capacityReserved: true };
  const expanded = await runPhase(
    restBriefs.map((b) => b.itemId),
    'expansion',
    auth,
  );
  return done('completed', `Expansion drafted ${expanded.filter((x) => x.status === 'drafted').length} of ${restBriefs.length} item(s) after human review of the pilot.`, expanded, { pilot: { size: pilotSize, passed: true }, phase: 'expansion', artifactHash: exp.artifactHash });
}
