import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../../src/cli/main.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { registerContentDepsFactory } from '../../../src/content/deps.js';
import { resolveProposal } from '../../../src/approvals/subjects.js';
import { proposalArtifactHash } from '../../../src/approvals/publisher.js';
import { createBrief } from '../../../src/content/brief.js';
import { markHumanReviewed } from '../../../src/content/publication.js';
import { draftAndReview } from '../../../src/content/review.js';
import { listItems } from '../../../src/content/store.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { FakeApprovalGate, FakeLlm, FakeVault } from '../../fixtures/content/fakes.js';
import { classifyAllInformational, contentConfig, goodDraft, passingReview, researchedSchedulingItem, seedSchedulingScenario } from '../../fixtures/content/seed.js';
import type { SiteConfig } from '../../../src/config/site-schema.js';

let ctx: TestContext;
let approvals: FakeApprovalGate;
let vault: FakeVault;
let llm: FakeLlm;

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

function setup(config: SiteConfig = contentConfig()) {
  ctx = createTestContext({ config });
  approvals = new FakeApprovalGate();
  vault = new FakeVault(ctx.siteId);
  llm = new FakeLlm({ 'content.classify': classifyAllInformational, 'content.draft': () => goodDraft(), 'content.review': passingReview });
  registerContentDepsFactory(() => ({ llm, memory: null, approvals, vault }));
}

beforeEach(() => registerContentDepsFactory(null));

/** Latest checkpoint status per stage of a job, in order. */
function jobStages(jobId: string): Array<[string, string]> {
  const rows = ctx.db.all<{ stage: string; status: string }>('SELECT stage, status FROM checkpoints WHERE job_id = ? ORDER BY rowid', [jobId]);
  const last = new Map<string, string>();
  for (const r of rows) last.set(r.stage, r.status);
  return [...last.entries()];
}
afterEach(() => {
  registerContentDepsFactory(null);
  ctx?.cleanup();
});

describe('content CLI', () => {
  it('imports, discovers, lists, briefs, refuses drafts without DRAFT mode/approval, drafts once approved, reviews, and checks publication', async () => {
    setup();
    seedSchedulingScenario(ctx);
    const csv = path.join(ctx.paths.root, 'questions.csv');
    writeFileSync(csv, 'question\n"How do I schedule bakery production for early mornings?"\n');

    const dryImport = await cli(['--dry-run', 'content', 'import', csv]);
    expect(dryImport.out).toMatch(/DRY RUN: 1 of 1 row\(s\) valid/);
    const imp = await cli(['content', 'import', csv]);
    expect(imp.out).toMatch(/1 of 1 row\(s\) imported/);

    const dry = await cli(['--dry-run', 'content', 'discover']);
    expect(dry.out).toMatch(/DRY RUN: nothing written, no model calls/);
    expect(listItems(ctx.db, ctx.siteId)).toHaveLength(0);

    const disc = await cli(['--json', 'content', 'discover']);
    expect(disc.code).toBe(0);
    const d = JSON.parse(disc.out);
    expect(d.model).toMatch(/Deterministic only/);
    // Runs as a durable job: checkpointed stages, resumable with `jobs resume <id>`.
    expect(d.jobId).toMatch(/^job_/);
    expect(d.status).toBe('completed');
    expect(d.stages.map((x: { stage: string }) => x.stage)).toContain('prioritize');
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM checkpoints WHERE job_id = ?', [d.jobId])!.n).toBeGreaterThanOrEqual(7);
    expect(d.notes.written).toBe(true);
    expect(llm.calls).toHaveLength(0); // no --use-model: no spend
    // One writer: the content notes are rendered by the vault renderer (same notes, paths, and ids as `vault render`).
    expect(d.notes.detail).toMatch(/content notes rendered \(same as `vault render --only content`\)/);
    expect(vault.written.some((n) => n.relPath === '11 Content Farm/Pipeline.md' && n.noteId === `content-farm-${ctx.siteId}`)).toBe(true);
    expect(vault.written.some((n) => n.relPath === '11 Content Farm/Content Pipeline.md')).toBe(false);
    expect(vault.written.filter((n) => /^content-(item|brief|draft|pipeline)-/.test(n.noteId))).toEqual([]);

    // Human output of a re-run (idempotent) names the job and the enforced stage allowances.
    const again = await cli(['content', 'discover', '--use-model']);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/Content research \(job job_\w+\): completed/);
    expect(again.out).toMatch(/Per-stage allowances enforced by the workflow engine/);

    const list = await cli(['content', 'list']);
    expect(list.out).toMatch(/improve_existing/);
    const item = listItems(ctx.db, ctx.siteId).find((i) => i.decision === 'improve_existing')!;

    const show = await cli(['content', 'show', item.id]);
    expect(show.out).toMatch(/Why this deserves to exist/);

    const brief = await cli(['--json', 'content', 'brief', item.id]);
    const b = JSON.parse(brief.out);
    expect(b.gate.passed).toBe(true);
    // Durable path (same as `content produce`): a checkpointed content.production job with only the brief stage.
    expect(b.jobId).toMatch(/^job_/);
    expect(jobStages(b.jobId)).toEqual([['brief', 'succeeded']]);
    expect(ctx.db.get<{ type: string; status: string }>('SELECT type, status FROM jobs WHERE id = ?', [b.jobId])).toMatchObject({ type: 'content.production', status: 'succeeded' });
    expect(b.approvalRequest.status).toBe('pending');
    expect(vault.written.some((n) => n.relPath.startsWith('05 Content/Briefs/Brief - ') && n.noteId === `${item.id}.brief` && n.kind === 'brief')).toBe(true);
    expect(vault.written.some((n) => / brief v\d+\.md$/.test(n.relPath))).toBe(false);

    // No --use-model: refused with the cap shown.
    const noSpend = await cli(['--mode', 'DRAFT', 'content', 'draft', item.id]);
    expect(noSpend.code).toBe(1);
    expect(noSpend.err).toMatch(/--use-model/);
    expect(noSpend.err).toMatch(/LLM spend cap: \$0\.50 per run/);

    // ANALYZE mode (default): refused.
    const analyze = await cli(['--json', 'content', 'draft', item.id, '--use-model']);
    expect(JSON.parse(analyze.out).error.code).toBe('POLICY_DENIED');
    expect(analyze.code).toBe(1);

    // Dry run shows every precondition without spending.
    const dryDraft = await cli(['--dry-run', '--mode', 'DRAFT', 'content', 'draft', item.id, '--use-model']);
    expect(dryDraft.out).toMatch(/would NOT run/);
    expect(dryDraft.out).toMatch(/FAIL approval/);

    // DRAFT mode but pending approval: refused (APPROVAL_REQUIRED).
    const pending = await cli(['--json', '--mode', 'DRAFT', 'content', 'draft', item.id, '--use-model']);
    expect(JSON.parse(pending.out).error.code).toBe('APPROVAL_REQUIRED');
    expect(llm.callsFor('content.draft')).toHaveLength(0);

    approvals.approve(b.approvalRequest.id);
    const ok = await cli(['--json', '--mode', 'DRAFT', 'content', 'draft', item.id, '--use-model']);
    expect(ok.code).toBe(0);
    const draft = JSON.parse(ok.out);
    expect(draft.review.verdict).toBe('pass');
    expect(draft.jobId).toMatch(/^job_/);
    expect(jobStages(draft.jobId)).toEqual([['draft', 'succeeded'], ['quality_review', 'stopped']]);
    // Refusals happen before any job is created (no job for the ANALYZE/pending attempts above).
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE site_id = ? AND type = 'content.production'", [ctx.siteId])!.n).toBe(2);
    expect(draft.approvalConsumed).toBe(b.approvalRequest.id);
    expect(draft.publicationBlockers.join(' ')).toMatch(/Human review required/);
    expect(vault.written.some((n) => n.relPath.startsWith('05 Content/Drafts/Draft - ') && n.noteId === `${item.id}.draft` && n.kind === 'draft')).toBe(true);
    expect(vault.written.filter((n) => /^content-(item|brief|draft|pipeline)-/.test(n.noteId))).toEqual([]);

    const review = await cli(['--json', 'content', 'review', draft.draftId]);
    const rv = JSON.parse(review.out);
    expect(rv.review.verdict).toBe('needs_human_review'); // no --use-model: AI review skipped
    expect(rv.review.aiReview.status).toBe('skipped');
    expect(rv.jobId).toMatch(/^job_/);
    expect(jobStages(rv.jobId)).toEqual([['quality_review', 'stopped']]);

    // Re-running `content brief` on an unchanged item reuses the brief (no new version, approval already used).
    const rebrief = JSON.parse((await cli(['--json', 'content', 'brief', item.id])).out);
    expect(rebrief.reused).toBe(true);
    expect(rebrief.briefId).toBe(b.briefId);
    expect(rebrief.approvalStatus).toBe('already_executed');

    const pub = await cli(['content', 'publish-check', draft.draftId]);
    expect(pub.out).toMatch(/BLOCKED/);
    expect(pub.out).toMatch(/approvals request draft/);
    expect(pub.code).toBe(1);

    const bad = await cli(['content', 'mark-reviewed', draft.draftId, '--as', 'Alice', '--confirm', 'deadbeef']);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/Confirm the exact body/);
  });

  it('content import names the columns it ignored (not recognized, not stored) in the human output (NF-14)', async () => {
    setup();
    const csv = path.join(ctx.paths.root, 'questions-misnamed.csv');
    writeFileSync(csv, 'question,sourse,Customer Email\n"How do I plan early bakery shifts?",forum,someone@example.test\n');
    const dry = await cli(['--dry-run', 'content', 'import', csv]);
    expect(dry.out).toMatch(/DRY RUN: 1 of 1 row\(s\) valid/);
    expect(dry.out).toMatch(/Ignored columns \(not recognized, not stored\): sourse, customer email\./);
    const json = JSON.parse((await cli(['--dry-run', '--json', 'content', 'import', csv])).out);
    expect(json.ignoredColumns).toEqual(['sourse', 'customer email']);
    const imp = await cli(['content', 'import', csv]);
    expect(imp.out).toMatch(/Ignored columns \(not recognized, not stored\): sourse, customer email\./);
    // Recognized columns only: no ignored-columns line.
    const clean = path.join(ctx.paths.root, 'questions-clean.csv');
    writeFileSync(clean, 'question,source\n"How do I plan weekend bakery shifts?",forum\n');
    expect((await cli(['content', 'import', clean])).out).not.toMatch(/Ignored columns/);
  });

  it('publish-check: an automated pass plus a valid approval is BLOCKED; after mark-reviewed the ALLOWED line names who accepted the body and when (NF-02)', async () => {
    ctx = createTestContext({ config: contentConfig({ profile: 'core', features: { contentDiscovery: true } }), mode: 'DRAFT' });
    approvals = new FakeApprovalGate();
    vault = new FakeVault(ctx.siteId);
    llm = new FakeLlm({ 'content.classify': classifyAllInformational, 'content.draft': () => goodDraft(), 'content.review': passingReview });
    llm.synthetic = false;
    registerContentDepsFactory(() => ({ llm, memory: null, approvals, vault }));
    const deps = { llm, memory: null, approvals, vault: null };
    const itemId = await researchedSchedulingItem(ctx, deps, { synthetic: false });
    const brief = await createBrief(ctx, deps, itemId, { useModel: false });
    approvals.approve(brief.approvalRequest!.id);
    const r = await draftAndReview(ctx, deps, itemId);
    expect(r.finalReview.verdict).toBe('pass');
    const id = r.finalDraft.id;
    const proposal = resolveProposal(ctx, 'draft', id);
    approvals.grant({ siteId: ctx.siteId, actionType: proposal.actionType, subjectType: 'draft', subjectId: id, artifactHash: proposalArtifactHash(proposal) });

    const blocked = await cli(['--mode', 'EXECUTE', 'content', 'publish-check', id]);
    expect(blocked.code).toBe(1);
    expect(blocked.out).toMatch(new RegExp(`Publication BLOCKED for draft ${id}:\\n  - No recorded human acceptance of this exact body: the latest review \\(qrv_\\w+, verdict pass\\) is automated`));
    expect(blocked.out).toContain(`content mark-reviewed ${id} --as "<name>" --confirm ${r.finalDraft.bodyHash.slice(0, 12)}`);
    expect(blocked.out).not.toMatch(/ALLOWED/);

    const accepted = markHumanReviewed(ctx, id, { reviewer: 'Alice', confirmHashPrefix: r.finalDraft.bodyHash.slice(0, 12) });
    const allowed = await cli(['--mode', 'EXECUTE', 'content', 'publish-check', id]);
    expect(allowed.code).toBe(0);
    expect(allowed.out).toContain(`Publication ALLOWED for draft ${id}:\n  - Body accepted by Alice at 2026-09-24T09:00:00.000Z (\`content mark-reviewed\`, review ${accepted.reviewId}, body hash ${r.finalDraft.bodyHash.slice(0, 12)}).\n  - ${proposal.actionType} approval apr_`);
    expect(allowed.out).toMatch(/approval apr_\d+ of this exact proposal approved by owner:test at 2026-09-24T09:00:00\.000Z\./);
    const json = JSON.parse((await cli(['--json', '--mode', 'EXECUTE', 'content', 'publish-check', id])).out);
    expect(json.humanReview).toMatchObject({ accepted: true, reviewer: 'Alice', reviewId: accepted.reviewId });
  });

  it('reports the disabled content-discovery feature honestly (exit code 3)', async () => {
    setup(contentConfig({ profile: 'core' }));
    const r = await cli(['content', 'discover']);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/contentDiscovery is disabled/);
  });

  it('refuses batch drafting while batch expansion is disabled (the batch runs as a durable content.batch job)', async () => {
    setup();
    const r = await cli(['--mode', 'DRAFT', 'content', 'batch', 'ci_a', 'ci_b', '--use-model']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/refused/);
    expect(r.out).toMatch(/content job job_/);
    expect(ctx.db.get<{ type: string }>("SELECT type FROM jobs WHERE site_id = ? AND type = 'content.batch'", [ctx.siteId])?.type).toBe('content.batch');
  });

  it('runs the low-data bootstrap and prints readiness checks', async () => {
    setup();
    const r = await cli(['content', 'bootstrap']);
    expect(r.out).toMatch(/Low-data: YES/);
    expect(r.out).toMatch(/No historical conversion evidence/);
    expect(r.out).toMatch(/measurement\/gsc_property/);
  });
});
