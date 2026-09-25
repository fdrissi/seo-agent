import { afterEach, describe, expect, it } from 'vitest';
import { createBrief } from '../../../src/content/brief.js';
import type { ContentDeps } from '../../../src/content/deps.js';
import { CONTENT_PRODUCTION_JOB, CONTENT_RESEARCH_JOB, registerContentJobHandlers, runContentProductionJob, runContentResearchJob } from '../../../src/content/jobs.js';
import { runStagesSequentially } from '../../../src/content/pipeline.js';
import { contentStageAllowances, createContentProductionStages, createContentResearchStages } from '../../../src/content/stages.js';
import { latestBrief, latestDraft, listItems, listSignals } from '../../../src/content/store.js';
import { createDefaultRegistry } from '../../../src/jobs/handlers.js';
import { validateWorkflow } from '../../../src/workflows/engine.js';
import { CheckpointStore } from '../../../src/workflows/checkpoints.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { FakeApprovalGate, FakeLlm } from '../../fixtures/content/fakes.js';
import { classifyAllInformational, contentConfig, goodDraft, passingReview, researchedSchedulingItem, seedSchedulingScenario } from '../../fixtures/content/seed.js';

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

function makeDeps(): { deps: ContentDeps; llm: FakeLlm; approvals: FakeApprovalGate } {
  const llm = new FakeLlm({ 'content.classify': classifyAllInformational, 'content.draft': () => goodDraft(), 'content.review': passingReview });
  const approvals = new FakeApprovalGate();
  return { deps: { llm, memory: null, approvals, vault: null }, llm, approvals };
}

describe('content workflows on the durable engine', () => {
  it('stage definitions validate against the engine (prerequisites, optional prerequisites, next states)', () => {
    ctx = createTestContext({ config: contentConfig() });
    const { deps } = makeDeps();
    const allowances = contentStageAllowances(ctx.settings);
    for (const stages of [createContentResearchStages(deps, { allowances }), createContentProductionStages(deps, { allowances })]) {
      expect(validateWorkflow(stages).errors).toEqual([]);
    }
    const validate = createContentResearchStages(deps, { allowances }).find((s) => s.name === 'validate_demand')!;
    expect(validate.optionalPrerequisites).toEqual(['discover', 'classify']);
    // Stage subsets used by `content brief` / `content draft` / `content review` are valid workflows too.
    for (const subset of [['brief'], ['draft', 'quality_review'], ['quality_review'], ['brief', 'draft', 'quality_review']] as const) {
      const stages = createContentProductionStages(deps, { allowances, stages: subset });
      expect(stages.map((s) => s.name)).toEqual([...subset]);
      expect(validateWorkflow(stages).errors, subset.join(',')).toEqual([]);
    }
  });

  it('runs research as a durable job: every stage is checkpointed and dependencies are built per stage context', async () => {
    ctx = createTestContext({ config: contentConfig() });
    seedSchedulingScenario(ctx);
    const { deps } = makeDeps();
    const seenRunIds: string[] = [];
    const run = await runContentResearchJob(ctx, {}, (app) => {
      seenRunIds.push(app.runId);
      return deps;
    });
    expect(run.outcome).toBe('succeeded');
    expect(run.workflowStatus).toBe('succeeded');
    expect(run.stages.map((s) => s.stage)).toEqual(['discover', 'dedupe', 'classify', 'cluster', 'validate_demand', 'check_existing', 'prioritize']);
    // Stage contexts carry the job id as run id (budget reservations are attributed to the job).
    expect(new Set(seenRunIds)).toEqual(new Set([run.jobId]));
    const checkpoints = new CheckpointStore(ctx.db, ctx.clock).list(ctx.siteId, run.jobId);
    expect(checkpoints.filter((c) => c.status === 'succeeded').map((c) => c.stage)).toEqual(expect.arrayContaining(['discover', 'prioritize']));
    expect((run.outputs.prioritize as { ranked: unknown[] }).ranked.length).toBeGreaterThan(0);
    // validate_demand received discover's per-source status through its optional prerequisite.
    const item = listItems(ctx.db, ctx.siteId).find((i) => listSignals(ctx.db, ctx.siteId, { itemId: i.id }).some((s) => s.text === 'how to schedule bakery production'))!;
    expect(item.demand?.sourceCollection?.gsc_query?.status).toBe('collected');
  });

  it('registers content job types so `jobs resume` can continue them', () => {
    registerContentJobHandlers();
    registerContentJobHandlers(); // idempotent
    const registry = createDefaultRegistry();
    expect(registry.has(CONTENT_RESEARCH_JOB)).toBe(true);
    expect(registry.has(CONTENT_PRODUCTION_JOB)).toBe(true);
  });

  it('production stops at the brief (needs_review) until a human approves; a re-run reuses the unchanged brief and drafts', async () => {
    ctx = createTestContext({ config: contentConfig(), mode: 'DRAFT' });
    const { deps, approvals, llm } = makeDeps();
    const itemId = await researchedSchedulingItem(ctx, deps);

    const first = await runContentProductionJob(ctx, { itemId }, deps);
    expect(first.outcome).toBe('waiting');
    expect(first.stoppedBy).toMatchObject({ stage: 'brief', status: 'needs_review' });
    expect(first.stoppedBy?.reason).toMatch(/approvals approve/);
    expect(llm.callsFor('content.draft')).toHaveLength(0);
    const brief1 = latestBrief(ctx.db, ctx.siteId, itemId)!;
    const pending = approvals.records.find((a) => a.actionType === 'draft_generation' && a.subjectId === brief1.id)!;
    expect(pending.status).toBe('pending');

    approvals.approve(pending.id);
    const second = await runContentProductionJob(ctx, { itemId }, deps);
    // Same brief (inputs unchanged): the approval stays bound, the draft is generated, then human review is required.
    expect(latestBrief(ctx.db, ctx.siteId, itemId)!.id).toBe(brief1.id);
    expect((second.outputs.brief as { reused: boolean }).reused).toBe(true);
    expect(second.stages.find((s) => s.stage === 'draft')?.status).toBe('succeeded');
    expect(second.stoppedBy).toMatchObject({ stage: 'quality_review', status: 'needs_review' });
    expect(latestDraft(ctx.db, ctx.siteId, itemId)?.briefId).toBe(brief1.id);
    expect(llm.callsFor('content.draft')).toHaveLength(1);
  });

  it('in-process runner: the brief stage stops awaiting approval instead of failing the draft stage', async () => {
    ctx = createTestContext({ config: contentConfig(), mode: 'DRAFT' });
    const { deps, approvals } = makeDeps();
    const itemId = await researchedSchedulingItem(ctx, deps);
    const stages = createContentProductionStages(deps, { allowances: contentStageAllowances(ctx.settings), useModel: false });
    const r1 = await runStagesSequentially(ctx, stages, { itemId });
    expect(r1.failed).toBeNull();
    expect(r1.stop).toMatchObject({ stage: 'brief', status: 'needs_review' });
    const b1 = latestBrief(ctx.db, ctx.siteId, itemId)!;
    approvals.approve(approvals.records.find((a) => a.subjectId === b1.id)!.id);
    const r2 = await runStagesSequentially(ctx, stages, { itemId });
    expect(r2.failed).toBeNull();
    expect(r2.outcomes.map((o) => [o.stage, o.status])).toEqual([
      ['brief', 'succeeded'],
      ['draft', 'succeeded'],
      ['quality_review', 'stopped'],
    ]);
    expect(latestBrief(ctx.db, ctx.siteId, itemId)!.version).toBe(b1.version);
    // Re-briefing an unchanged item is a no-op; --force builds a new version.
    const again = await createBrief(ctx, deps, itemId, { useModel: false });
    expect(again.reused).toBe(true);
    expect(again.approvalStatus).toBe('already_executed');
    const forced = await createBrief(ctx, deps, itemId, { useModel: false, force: true });
    expect(forced.reused).toBe(false);
    expect(forced.record!.version).toBe(b1.version + 1);
  });
});
