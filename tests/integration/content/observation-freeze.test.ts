/**
 * D2-ACC-04: one meaningful change per target page (spec 18 EXPERIMENT_ACTIVE,
 * spec 23). While an experiment is observing a page, the content pipeline
 * defers items that would change that page (CHECK EXISTING / PRIORITIZE:
 * "target page under observation until <review date>", not selectable), and
 * `content brief` / `content draft` refuse with CONFLICT before a draft
 * approval is requested or a model draft is paid for. The hint names the
 * experiment and its review date. SYNTHETIC scenario on example.test domains.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../../src/cli/main.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { registerContentDepsFactory } from '../../../src/content/deps.js';
import { observationHold } from '../../../src/content/freeze.js';
import { prioritizeItems } from '../../../src/content/prioritize.js';
import { getItem, listItems, updateItem } from '../../../src/content/store.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { FakeApprovalGate, FakeLlm, FakeVault } from '../../fixtures/content/fakes.js';
import { classifyAllInformational, contentConfig, goodDraft, passingReview, seedSchedulingScenario } from '../../fixtures/content/seed.js';

let ctx: TestContext;
let approvals: FakeApprovalGate;
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

beforeEach(() => {
  ctx = createTestContext({ config: contentConfig() });
  approvals = new FakeApprovalGate();
  llm = new FakeLlm({ 'content.classify': classifyAllInformational, 'content.draft': () => goodDraft(), 'content.review': passingReview });
  registerContentDepsFactory(() => ({ llm, memory: null, approvals, vault: new FakeVault(ctx.siteId) }));
});
afterEach(() => {
  registerContentDepsFactory(null);
  ctx.cleanup();
});

const REVIEW_DATE = '2026-11-01';

/** A SYNTHETIC experiment whose change is live on the page and being measured. */
function observe(pageUrl: string, status = 'observing'): string {
  const page = ctx.db.get<{ id: string }>('SELECT id FROM pages WHERE site_id = ? AND url = ?', [ctx.siteId, pageUrl])!;
  const id = `exp_synthetic_${Math.random().toString(36).slice(2, 10)}`;
  const at = ctx.clock.now().toISOString();
  ctx.db.run(
    `INSERT INTO experiments (id, site_id, page_id, recommendation_id, type, hypothesis, evidence_json, proposed_change, change_hash, primary_metric, outcome_kind, guardrail_metrics_json, min_observation_days, sample_requirements_json, risks, rollback_plan, review_date, status, implemented_at, observation_start, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'title_meta', 'A clearer title raises CTR (synthetic)', '[]', 'New title (synthetic)', 'chg_syn', 'ctr', 'seo_visibility', '[]', 28, '{}', 'Lower lead quality', 'Restore the previous title', ?, ?, ?, '2026-09-18', ?, ?)`,
    [id, ctx.siteId, page.id, REVIEW_DATE, status, at, at, at],
  );
  return id;
}

const HOME = 'https://www.example.test/';

function schedulingItem() {
  return listItems(ctx.db, ctx.siteId).find((i) => i.targetPageId && i.overlap?.pages.some((p) => p.url === HOME))!;
}

describe('content pipeline respects the observation freeze (D2-ACC-04)', () => {
  it('CHECK EXISTING / PRIORITIZE defer an item whose target page is under observation; content brief refuses with CONFLICT and requests no approval', async () => {
    seedSchedulingScenario(ctx);
    const expId = observe(HOME);
    const disc = JSON.parse((await cli(['--json', 'content', 'discover'])).out);
    expect(disc.status).toBe('stopped'); // no selectable item: the only improve_existing candidates are held

    const item = schedulingItem();
    expect(item).toMatchObject({ decision: 'defer', stage: 'deferred' });
    expect(item.decisionReason).toContain(`Target page under observation until ${REVIEW_DATE}: experiment ${expId}`);
    const wouldBe = /Once it concludes, this item would be: (improve existing|add section) \(Existing page https:\/\/www\.example\.test\/ /.exec(item.decisionReason ?? '')?.[1];
    expect(wouldBe).toBeDefined();
    expect(disc.ranked.find((r: { itemId: string }) => r.itemId === item.id)).toMatchObject({ decision: 'defer', selectable: false });

    const brief = await cli(['--json', 'content', 'brief', item.id]);
    expect(brief.code).toBe(1);
    const err = JSON.parse(brief.out).error;
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toMatch(new RegExp(`Refusing to build a brief for .* content item ${item.id}: Target page under observation until ${REVIEW_DATE}`));
    expect(err.hint).toContain(`Experiment ${expId} (review date ${REVIEW_DATE}) is observing ${HOME}`);
    expect(err.hint).toContain(`experiments show ${expId}`);
    expect(err.hint).toContain('export --critical-fix');
    // Nothing was requested, stored, or paid for.
    expect(approvals.records).toEqual([]);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM content_briefs WHERE site_id = ?', [ctx.siteId])!.n).toBe(0);
    expect(llm.calls).toHaveLength(0);
    // Same refusal in a dry run.
    expect(JSON.parse((await cli(['--json', '--dry-run', 'content', 'brief', item.id])).out).error.code).toBe('CONFLICT');

    // After the experiment concludes, the next discovery decides again.
    ctx.db.run("UPDATE experiments SET status = 'inconclusive' WHERE id = ?", [expId]);
    await cli(['--json', 'content', 'discover']);
    expect(getItem(ctx.db, ctx.siteId, item.id)).toMatchObject({ decision: wouldBe!.replace(' ', '_'), stage: 'prioritized' });
    expect(JSON.parse((await cli(['--json', 'content', 'brief', item.id])).out).gate.passed).toBe(true);
  });

  it('an experiment that starts observing after discovery: brief refused before the approval request; draft refused before any model call (approval not consumed)', async () => {
    seedSchedulingScenario(ctx);
    await cli(['--json', 'content', 'discover']);
    const item = schedulingItem();
    expect(item.decision).toBe('improve_existing');
    const b = JSON.parse((await cli(['--json', 'content', 'brief', item.id])).out);
    expect(b.gate.passed).toBe(true);
    approvals.approve(b.approvalRequest.id);
    const requestsBefore = approvals.records.length;

    const expId = observe(HOME);
    expect(observationHold(ctx, item)).toMatchObject({ until: REVIEW_DATE, experiments: [{ id: expId, reviewDate: REVIEW_DATE }] });

    // Brief: refused (no new version, no new approval request).
    const rebrief = await cli(['--json', 'content', 'brief', item.id, '--force']);
    expect(JSON.parse(rebrief.out).error.code).toBe('CONFLICT');
    expect(approvals.records).toHaveLength(requestsBefore);

    // Draft preview: the observation precondition fails.
    const dry = await cli(['--dry-run', '--mode', 'DRAFT', 'content', 'draft', item.id, '--use-model']);
    expect(dry.out).toMatch(/would NOT run/);
    expect(dry.out).toMatch(new RegExp(`FAIL observation: Target page under observation until ${REVIEW_DATE}: experiment ${expId}`));

    // Draft: CONFLICT before any job or model call; the approval stays unused.
    const draft = await cli(['--json', '--mode', 'DRAFT', 'content', 'draft', item.id, '--use-model']);
    expect(draft.code).toBe(1);
    const err = JSON.parse(draft.out).error;
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toContain(`Draft refused: Target page under observation until ${REVIEW_DATE}`);
    expect(err.hint).toContain(`Experiment ${expId} (review date ${REVIEW_DATE})`);
    expect(llm.callsFor('content.draft')).toHaveLength(0);
    expect(approvals.records.find((r) => r.id === b.approvalRequest.id)!.status).toBe('approved');
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE site_id = ? AND type = 'content.production' AND params_json LIKE '%\"draft\"%'", [ctx.siteId])!.n).toBe(0);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM content_drafts WHERE site_id = ?', [ctx.siteId])!.n).toBe(0);
  });

  it('PRIORITIZE defers an item whose target page came under observation after CHECK EXISTING (never selectable; audited)', async () => {
    seedSchedulingScenario(ctx);
    await cli(['--json', 'content', 'discover']);
    const item = schedulingItem();
    expect(item.decision).toBe('improve_existing');
    const expId = observe(HOME);
    const out = prioritizeItems(ctx, [item]);
    expect(out.ranked).toEqual([expect.objectContaining({ itemId: item.id, decision: 'defer', selectable: false })]);
    expect(out.topItemId).toBeNull();
    const after = getItem(ctx.db, ctx.siteId, item.id)!;
    expect(after).toMatchObject({ decision: 'defer', stage: 'deferred' });
    expect(after.decisionReason).toMatch(new RegExp(`^\\[content-decision@\\d+\\] Target page under observation until ${REVIEW_DATE}: experiment ${expId}`));
    const audit = ctx.db.get<{ details_json: string }>("SELECT details_json FROM audit_events WHERE site_id = ? AND event_type = 'content.decision' AND subject_id = ? ORDER BY rowid DESC LIMIT 1", [ctx.siteId, item.id]);
    expect(JSON.parse(audit!.details_json)).toMatchObject({ previous: 'improve_existing', decision: 'defer', observing: [expId] });
  });

  it('a queued (not yet observing) experiment and a page without experiments do not hold the item', async () => {
    seedSchedulingScenario(ctx);
    await cli(['--json', 'content', 'discover']);
    const item = schedulingItem();
    expect(observationHold(ctx, item)).toBeNull();
    observe(HOME, 'proposed');
    expect(observationHold(ctx, item)).toBeNull();
    expect(observationHold(ctx, { targetPageId: null })).toBeNull();
    updateItem(ctx.db, ctx.siteId, item.id, { stage: 'prioritized' }, ctx.clock.now().toISOString());
    expect(JSON.parse((await cli(['--json', 'content', 'brief', item.id])).out).gate.passed).toBe(true);
  });
});
