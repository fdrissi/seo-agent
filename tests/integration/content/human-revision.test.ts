/**
 * B6-06: a human revision path for drafts (`content revise-manual`). SYNTHETIC
 * scenario (fictional bakery planner on example.test); nothing touches the
 * network and no model is called by the human revision itself.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../../src/cli/main.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import type { RuntimeMode } from '../../../src/core/modes.js';
import { createBrief } from '../../../src/content/brief.js';
import { registerContentDepsFactory, resolveContentDeps } from '../../../src/content/deps.js';
import { reviseDraft } from '../../../src/content/draft.js';
import { checkPublicationGate, markHumanReviewed } from '../../../src/content/publication.js';
import { draftAndReview, reviewDraft, reviewWithRevisions, reviseDraftManually } from '../../../src/content/review.js';
import { getDraft, getItem, latestDraft, latestQualityReview } from '../../../src/content/store.js';
import { acquireSiteLock } from '../../../src/jobs/locks.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { FakeApprovalGate, FakeLlm } from '../../fixtures/content/fakes.js';
import { classifyAllInformational, contentConfig, goodDraft, passingReview, researchedSchedulingItem } from '../../fixtures/content/seed.js';

let ctx: TestContext;
beforeEach(() => registerContentDepsFactory(null));
afterEach(() => {
  registerContentDepsFactory(null);
  ctx?.cleanup();
});

const STAT = '73% of bakeries lose 12 hours a week to scheduling.';
const OWNER_FACT = 'Most bakeries start baking at 4am.';
const APPENDIX = '## Unresolved facts (must be resolved before publication)';

/** Writer output that never gets better: an unsupported statistic plus a fact only the owner can confirm. */
const stuckDraft = () => ({ ...goodDraft(`\n\n${STAT}`), factCheckNotes: [{ statement: OWNER_FACT, status: 'needs_owner_input', evidenceIds: [], note: 'owner to confirm' }] });

async function stuckAfterTwoRevisions(mode: RuntimeMode = 'DRAFT') {
  ctx = createTestContext({ config: contentConfig({ profile: 'core', features: { contentDiscovery: true } }), mode });
  const llm = new FakeLlm({ 'content.classify': classifyAllInformational, 'content.draft': stuckDraft, 'content.review': passingReview });
  llm.synthetic = false;
  const approvals = new FakeApprovalGate();
  const deps = { llm, memory: null, approvals, vault: null };
  const itemId = await researchedSchedulingItem(ctx, deps, { synthetic: false });
  const b = await createBrief(ctx, deps, itemId, { useModel: false });
  approvals.approve(b.approvalRequest!.id);
  const r = await draftAndReview(ctx, deps, itemId);
  return { llm, approvals, deps, itemId, r };
}

/** The human's edit: drop the made-up statistic and the appendix, state the owner-confirmed fact in the body. */
function humanBody(modelBody: string): string {
  const cut = modelBody.indexOf(APPENDIX);
  const base = (cut >= 0 ? modelBody.slice(0, cut) : modelBody).replace(STAT, '').trimEnd();
  return `${base}\n\n${OWNER_FACT} Plan the first bake around that start time.\n`;
}

/** The per-problem list a refused human revision reports (details.errors). */
function refusal(fn: () => unknown): { code: string; message: string; errors: string[] } {
  try {
    fn();
  } catch (e) {
    const err = e as { code: string; message: string; details?: { errors?: string[] } };
    return { code: err.code, message: err.message, errors: err.details?.errors ?? [] };
  }
  throw new Error('expected a refusal');
}

const draftCount = () => Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM content_drafts WHERE site_id = ?', [ctx.siteId])!.n);

describe('human revision path (content revise-manual)', () => {
  it('turns the dead end after two automated revisions into a publishable path: new human-authored version, markers recounted, gates re-run, audited', async () => {
    const { deps, approvals, llm, itemId, r } = await stuckAfterTwoRevisions();
    const stuck = r.finalDraft;
    // The dead end: limit reached, a marker and a revise-level finding remain, and the fix names the real command.
    expect(r.revisionsUsed).toBe(2);
    expect(stuck.status).toBe('needs_human_review');
    expect(stuck.unresolvedFacts).toBe(1);
    const limit = r.finalReview.reasons.find((x) => x.code === 'revision_limit')!;
    expect(limit.fix).toMatch(/content revise-manual <draft-id> --body-file/);
    expect(() => markHumanReviewed(ctx, stuck.id, { reviewer: 'Alice', confirmHashPrefix: stuck.bodyHash.slice(0, 8) })).toThrow(/require revision or rejection/);
    const writerCalls = llm.callsFor('content.draft').length;

    const body = humanBody(stuck.pkg.body);
    // Removing a marker without a resolution is refused and stores nothing.
    const before = draftCount();
    const missing = refusal(() => reviseDraftManually(ctx, stuck.id, { body, reviewer: 'Alice' }));
    expect(missing.code).toBe('VALIDATION_FAILED');
    expect(missing.message).toMatch(/Nothing was recorded/);
    expect(missing.errors).toEqual([expect.stringMatching(/^Marker removed without a resolution: "Most bakeries start baking at 4am\."/)]);
    // "removed" while the statement is still in the body, an unknown marker, and a resolution without a source are refused.
    expect(refusal(() => reviseDraftManually(ctx, stuck.id, { body, reviewer: 'Alice', resolutions: [{ marker: OWNER_FACT, action: 'removed', source: 'owner' }] })).errors).toEqual([expect.stringMatching(/resolved as removed, but .* still appears/)]);
    expect(refusal(() => reviseDraftManually(ctx, stuck.id, { body, reviewer: 'Alice', resolutions: [{ marker: OWNER_FACT, action: 'confirmed', source: 'owner' }, { marker: 'Something never marked.', action: 'removed', source: 'x' }] })).errors).toEqual([expect.stringMatching(/is not an unresolved fact of draft/)]);
    // "confirmed" requires the statement in the body, unmarked.
    expect(refusal(() => reviseDraftManually(ctx, stuck.id, { body: body.replace(OWNER_FACT, 'Bakeries start early.'), reviewer: 'Alice', resolutions: [{ marker: OWNER_FACT, action: 'confirmed', source: 'owner' }] })).errors).toEqual([expect.stringMatching(/Confirmed statement not found unmarked/)]);
    expect(refusal(() => reviseDraftManually(ctx, stuck.id, { body, reviewer: 'Alice', resolutions: [{ marker: OWNER_FACT, action: 'confirmed', source: '  ' }] })).message).toMatch(/Invalid fact resolutions/);
    // A named author and DRAFT mode are required.
    expect(() => reviseDraftManually(ctx, stuck.id, { body, reviewer: ' ', resolutions: [] })).toThrow(/named author/);
    (ctx as { mode: RuntimeMode }).mode = 'ANALYZE';
    expect(() => reviseDraftManually(ctx, stuck.id, { body, reviewer: 'Alice', resolutions: [{ marker: OWNER_FACT, action: 'confirmed', source: 'owner' }] })).toThrow(/needs DRAFT mode/);
    (ctx as { mode: RuntimeMode }).mode = 'DRAFT';
    expect(draftCount()).toBe(before);

    const resolutions = [{ marker: OWNER_FACT, action: 'confirmed' as const, source: 'Owner interview 2026-09-20 (production log)', note: 'checked the last 4 weeks' }];
    // --dry-run validates and runs the gates but stores nothing.
    ctx.dryRun = true;
    const preview = reviseDraftManually(ctx, stuck.id, { body, reviewer: 'Alice', resolutions });
    ctx.dryRun = false;
    expect(preview.preview).toBe(true);
    expect(preview.draft).toBeNull();
    expect(preview.review.reviewId).toBeNull();
    expect(draftCount()).toBe(before);
    // An id-like source that resolves to nothing is recorded as human-supplied text, with a warning.
    ctx.dryRun = true;
    const bogus = reviseDraftManually(ctx, stuck.id, { body, reviewer: 'Alice', resolutions: [{ marker: OWNER_FACT, action: 'confirmed', source: 'fact:does-not-exist' }] });
    ctx.dryRun = false;
    expect(bogus.resolutions[0]!.sourceKind).toBe('human_supplied');
    expect(bogus.warnings.join(' ')).toMatch(/looks like an id/);
    expect(draftCount()).toBe(before);

    const done = reviseDraftManually(ctx, stuck.id, { body, reviewer: 'Alice', resolutions, note: 'removed the made-up statistic' });
    const v = done.draft!;
    expect(v.version).toBe(stuck.version + 1);
    expect(v.pkg.body).toBe(body);
    expect(v.bodyHash).toBe(done.bodyHash);
    expect(v.unresolvedFacts).toBe(0);
    expect(v.revisionRound).toBe(stuck.revisionRound);
    expect(v.promptVersion).toBeNull();
    expect(v.modelId).toBeNull();
    expect(done.removedMarkers).toEqual([OWNER_FACT]);
    expect(v.pkg.humanRevision).toMatchObject({ reviewer: 'Alice', previousDraftId: stuck.id, previousBodyHash: stuck.bodyHash, note: 'removed the made-up statistic' });
    expect(v.pkg.factCheckNotes.find((n) => n.statement === OWNER_FACT)).toMatchObject({ status: 'verified', humanResolution: { action: 'confirmed', source: 'Owner interview 2026-09-20 (production log)', sourceKind: 'human_supplied', reviewer: 'Alice' } });
    expect(v.pkg.publicationBlockers.join(' ')).not.toMatch(/unresolved fact/);
    expect(getDraft(ctx.db, ctx.siteId, stuck.id)!.status).toBe('superseded');
    expect(latestDraft(ctx.db, ctx.siteId, itemId)!.id).toBe(v.id);
    // Gates re-ran on the edited body (no model call): no revise-level findings remain; a human still reviews.
    expect(llm.callsFor('content.draft')).toHaveLength(writerCalls);
    expect(done.review.aiReview.status).toBe('skipped');
    expect(done.review.verdict).toBe('needs_human_review');
    expect(done.review.reasons.filter((x) => x.consequence === 'revise' || x.consequence === 'reject')).toEqual([]);
    expect(v.status).toBe('needs_human_review');
    expect(latestQualityReview(ctx.db, ctx.siteId, 'draft', v.id)?.id).toBe(done.review.reviewId);
    expect(getItem(ctx.db, ctx.siteId, itemId)!.stage).toBe('in_review');
    // Audited with the author as actor.
    const ev = ctx.db.get<{ actor: string; details_json: string }>(`SELECT actor, details_json FROM audit_events WHERE event_type = 'content.draft_human_revision' AND subject_id = ?`, [v.id])!;
    expect(ev.actor).toBe('owner:Alice');
    expect(JSON.parse(ev.details_json)).toMatchObject({ previousDraftId: stuck.id, bodyHash: v.bodyHash, markersBefore: 1, markersAfter: 0, removedMarkers: [OWNER_FACT], resolutions: [{ action: 'confirmed', sourceKind: 'human_supplied' }] });

    // A named human can now accept the exact body; the publication gate no longer lists unresolved facts.
    expect(markHumanReviewed(ctx, v.id, { reviewer: 'Alice', confirmHashPrefix: v.bodyHash.slice(0, 10) }).status).toBe('review_passed');
    const { deps: wired } = await resolveContentDeps(ctx, { ...deps, approvals });
    const gate = checkPublicationGate(ctx, wired, v.id);
    expect(gate.blockers.join(' ')).not.toMatch(/unresolved fact|awaits human review|Latest quality verdict/);
    expect(gate.blockers.join(' ')).toMatch(/approval/);
  });

  it('never hands a human-authored version back to the model, and keeps unresolved markers blocking', async () => {
    const { deps, llm, r } = await stuckAfterTwoRevisions();
    const stuck = r.finalDraft;
    // The human keeps the marker (the fact stays unresolved) and adds an unsupported product claim.
    const body = `${stuck.pkg.body.replace(STAT, '').trimEnd()}\n\nOur planner integrates with Salesforce.\n`;
    const done = reviseDraftManually(ctx, stuck.id, { body, reviewer: 'Editor' });
    const v = done.draft!;
    expect(v.unresolvedFacts).toBe(1);
    expect(done.review.verdict).toBe('needs_human_review'); // never needs_revision for a human's text
    expect(done.review.reasons.map((x) => x.code)).toEqual(expect.arrayContaining(['product_fact_consistency', 'human_revision_findings', 'unresolved_facts']));
    // A later review applies the same rule, automated revision refuses, and the revision loop does not call the writer.
    const calls = llm.callsFor('content.draft').length;
    const again = await reviewDraft(ctx, deps, v.id, { useModel: true });
    expect(again.verdict).toBe('needs_human_review');
    await expect(reviseDraft(ctx, deps, v.id, again.reasons)).rejects.toMatchObject({ code: 'POLICY_DENIED', message: expect.stringMatching(/human-authored/) });
    await expect(reviewWithRevisions(ctx, deps, v.id, { revise: true })).resolves.toMatchObject({ drafts: [] });
    expect(llm.callsFor('content.draft')).toHaveLength(calls);
    // Still blocked for a human acceptance: revise-level findings and an unresolved fact remain.
    expect(() => markHumanReviewed(ctx, v.id, { reviewer: 'Editor', confirmHashPrefix: v.bodyHash.slice(0, 8) })).toThrow(/content revise-manual|require revision/);
    // Only the latest version can be revised by a human.
    expect(() => reviseDraftManually(ctx, stuck.id, { body, reviewer: 'Editor' })).toThrow(/not the latest draft/);
  });

  it('lets a human resolve a legacy self-certified "verified" note (stored before the evidence check) by removing the statement', async () => {
    const { r } = await stuckAfterTwoRevisions();
    const stuck = r.finalDraft;
    // Simulate a draft stored before the fix: an unmarked statement whose note claims "verified" without evidence.
    const legacyClaim = 'Food safety law requires a daily fridge temperature log.';
    const pkg = { ...stuck.pkg, body: `${stuck.pkg.body}\n\n${legacyClaim}\n`, factCheckNotes: [...stuck.pkg.factCheckNotes, { statement: legacyClaim, status: 'verified' as const, evidenceIds: [], note: '' }] };
    const { sha256 } = await import('../../../src/core/hash.js');
    ctx.db.run('UPDATE content_drafts SET package_json = ?, body_hash = ? WHERE id = ?', [JSON.stringify(pkg), sha256(pkg.body), stuck.id]);
    const body = humanBody(pkg.body).replace(`${legacyClaim}\n`, '').replace(legacyClaim, '');
    const done = reviseDraftManually(ctx, stuck.id, {
      body,
      reviewer: 'Alice',
      resolutions: [
        { marker: OWNER_FACT, action: 'confirmed', source: 'fact:pf-templates' }, // a product fact that does not state it: recorded, with a warning
        { marker: legacyClaim, action: 'removed', source: 'Could not find the regulation; removed' },
      ],
    });
    expect(done.warnings.join(' ')).toMatch(/fact:pf-templates/);
    expect(done.resolutions.map((x) => [x.action, x.sourceKind])).toEqual([['confirmed', 'product_fact'], ['removed', 'human_supplied']]);
    expect(done.draft!.pkg.factCheckNotes.some((n) => n.statement === legacyClaim)).toBe(false);
    expect(done.review.checks.find((c) => c.id === 'unresolved_facts')!.status).toBe('pass');
  });
});

describe('content revise-manual and publish-check (CLI)', () => {
  async function cli(args: string[]): Promise<{ out: string; err: string; code: number }> {
    let out = '';
    let err = '';
    const runtime = new CliRuntime({ out: (t) => (out += `${t}\n`), err: (t) => (err += `${t}\n`) }, { ...process.env, SEO_AGENT_WORKSPACE: ctx.paths.root });
    const program = await buildProgram(runtime);
    program.exitOverride();
    process.exitCode = 0;
    try {
      await program.parseAsync(['node', 'seo-agent', '--workspace', ctx.paths.root, ...args]);
    } catch (e) {
      if (!(e instanceof CliExit) && !(e as { code?: string }).code?.startsWith('commander.')) throw e;
    }
    const code = Number(process.exitCode ?? 0);
    process.exitCode = 0;
    return { out, err, code };
  }

  it('records a human revision from files, previews with --dry-run, refuses without DRAFT mode or while a content job holds the lock, and publish-check names what export enforces', async () => {
    const { deps, approvals, llm, r } = await stuckAfterTwoRevisions();
    registerContentDepsFactory(() => ({ llm, memory: null, approvals, vault: null }));
    void deps;
    const stuck = r.finalDraft;
    const bodyFile = path.join(ctx.paths.root, 'edited.md');
    const resFile = path.join(ctx.paths.root, 'resolutions.json');
    writeFileSync(bodyFile, humanBody(stuck.pkg.body));
    writeFileSync(resFile, JSON.stringify([{ marker: OWNER_FACT, action: 'confirmed', source: 'Owner interview 2026-09-20' }]));

    // Missing resolutions: refused with each problem listed.
    const bad = await cli(['--mode', 'DRAFT', 'content', 'revise-manual', stuck.id, '--body-file', bodyFile, '--as', 'Alice']);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/Marker removed without a resolution/);
    // Malformed resolutions file.
    const malformed = path.join(ctx.paths.root, 'bad.json');
    writeFileSync(malformed, JSON.stringify([{ marker: OWNER_FACT, action: 'kept' }]));
    const badFile = await cli(['--json', '--mode', 'DRAFT', 'content', 'revise-manual', stuck.id, '--body-file', bodyFile, '--as', 'Alice', '--resolutions', malformed]);
    expect(JSON.parse(badFile.out).error.code).toBe('VALIDATION_FAILED');
    // ANALYZE (default mode): refused.
    const analyze = await cli(['--json', 'content', 'revise-manual', stuck.id, '--body-file', bodyFile, '--as', 'Alice', '--resolutions', resFile]);
    expect(JSON.parse(analyze.out).error.code).toBe('POLICY_DENIED');
    // A running content job holds the "content" lock: refused with LOCKED, nothing done.
    const lock = acquireSiteLock(ctx.db, { siteId: ctx.siteId, lockName: 'content', owner: 'runner:test', jobId: 'job_synthetic_running', leaseMs: 3_600_000, now: new Date() });
    expect(lock.acquired).toBe(true);
    const locked = await cli(['--json', '--mode', 'DRAFT', 'content', 'revise-manual', stuck.id, '--body-file', bodyFile, '--as', 'Alice', '--resolutions', resFile]);
    expect(JSON.parse(locked.out).error).toMatchObject({ code: 'LOCKED', details: { lockName: 'content', jobId: 'job_synthetic_running' } });
    ctx.db.run(`DELETE FROM site_locks WHERE site_id = ? AND lock_name = 'content'`, [ctx.siteId]);
    expect(draftCount()).toBe(3);

    const dry = await cli(['--dry-run', '--mode', 'DRAFT', 'content', 'revise-manual', stuck.id, '--body-file', bodyFile, '--as', 'Alice', '--resolutions', resFile]);
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/DRY RUN: human revision of draft .* is valid; nothing was stored/);
    expect(draftCount()).toBe(3);

    const ok = await cli(['--json', '--mode', 'DRAFT', 'content', 'revise-manual', stuck.id, '--body-file', bodyFile, '--as', 'Alice', '--resolutions', resFile, '--note', 'edited by hand']);
    expect(ok.code).toBe(0);
    const x = JSON.parse(ok.out);
    expect(x).toMatchObject({ dryRun: false, previousDraftId: stuck.id, status: 'needs_human_review', author: 'Alice', markersBefore: 1, markersAfter: 0, removedMarkers: [OWNER_FACT] });
    expect(x.review.verdict).toBe('needs_human_review');
    expect(getDraft(ctx.db, ctx.siteId, x.draftId)!.pkg.humanRevision?.reviewer).toBe('Alice');

    const human = await cli(['content', 'mark-reviewed', x.draftId, '--as', 'Alice', '--confirm', x.bodyHash.slice(0, 12)]);
    expect(human.code).toBe(0);
    // B6-11: publish-check says what `export draft` itself enforces (human acceptance included) and what only it reports.
    const pub = await cli(['content', 'publish-check', x.draftId]);
    expect(pub.out).toMatch(/`export draft` itself enforces: EXECUTE mode; a named human's recorded acceptance of this exact body/);
    expect(pub.out).toMatch(/exportable draft status .*zero recorded unresolved facts; a valid approval bound to this exact proposal/);
    expect(pub.out).toMatch(/does NOT check that this is the latest draft/);
    expect(pub.out).not.toMatch(/the other content-side blockers above \(latest draft, quality verdict, human review, synthetic data\)/);
  });
});
