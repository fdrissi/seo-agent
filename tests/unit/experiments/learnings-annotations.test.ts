import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { ApprovalService } from '../../../src/approvals/service.js';
import { applyDecisionEffects } from '../../../src/approvals/effects.js';
import { checkStatementAgainstEffect, getLearning, learningApprovalPayload, learningEvidenceSummary, proposeLearning, validateLearningScope, type LearningEvidenceSummary } from '../../../src/experiments/learnings.js';
import { renderApproval } from '../../../src/cli/commands/approvals.js';
import { parseInstant, recordAnnotation } from '../../../src/experiments/annotations.js';
import { seedPage } from '../../fixtures/experiments/seed.js';

describe('learnings', () => {
  let ctx: TestContext;
  let gate: ApprovalService;
  beforeEach(() => {
    ctx = createTestContext();
    gate = new ApprovalService(ctx.db, { clock: ctx.clock });
  });
  afterEach(() => ctx.cleanup());

  it('refuse universal scopes and require evidence', () => {
    for (const s of ['all sites', 'Universal', 'global SEO rule', '*', 'every website', 'always', '']) expect(() => validateLearningScope(s)).toThrow();
    expect(validateLearningScope('site:test-site; page type: article')).toBe('site:test-site; page type: article');
    expect(() => proposeLearning(ctx.db, ctx.clock, gate, { siteId: 'test-site', statement: 'x', scope: 'site:test-site', evidence: [], requestedBy: 'owner:a' })).toThrow(/evidence/);
    expect(() => proposeLearning(ctx.db, ctx.clock, gate, { siteId: 'test-site', statement: 'x', scope: 'site:test-site', evidence: {}, requestedBy: 'owner:a' })).toThrow(/evidence/);
  });

  it('stay proposed until a human approves the learning_promotion approval; rejection is recorded', () => {
    const a = proposeLearning(ctx.db, ctx.clock, gate, { siteId: 'test-site', statement: 'Synthetic observation', scope: 'site:test-site; page:/w', evidence: { evaluationId: 'e1' }, requestedBy: 'system:review' });
    expect(a.learning.status).toBe('proposed');
    expect(a.approval).toMatchObject({ actionType: 'learning_promotion', status: 'pending', subjectType: 'learning' });
    const approved = gate.approve('test-site', a.approval.id, { approver: 'Alice', confirmHashPrefix: a.approval.artifactHash.slice(0, 10) });
    applyDecisionEffects(ctx.db, ctx.clock, approved, 'owner:Alice');
    expect(getLearning(ctx.db, 'test-site', a.learning.id)).toMatchObject({ status: 'approved', approvedBy: 'Alice', scope: 'site:test-site; page:/w' });

    const b = proposeLearning(ctx.db, ctx.clock, gate, { siteId: 'test-site', statement: 'Another', scope: 'site:test-site', evidence: ['e2'], requestedBy: 'system:review' });
    const rejected = gate.reject('test-site', b.approval.id, { approver: 'Alice', reason: 'Too narrow evidence' });
    applyDecisionEffects(ctx.db, ctx.clock, rejected, 'owner:Alice');
    expect(getLearning(ctx.db, 'test-site', b.learning.id).status).toBe('rejected');
  });

  it('an approval for a learning that was edited afterwards does not promote the edited text', () => {
    const a = proposeLearning(ctx.db, ctx.clock, gate, { siteId: 'test-site', statement: 'Original', scope: 'site:test-site', evidence: ['e'], requestedBy: 'system:review' });
    ctx.db.run(`UPDATE learnings SET statement = 'Edited to be universal' WHERE id = ?`, [a.learning.id]);
    const approved = gate.approve('test-site', a.approval.id, { approver: 'Alice', confirmHashPrefix: a.approval.artifactHash.slice(0, 10) });
    const notes = applyDecisionEffects(ctx.db, ctx.clock, approved, 'owner:Alice');
    expect(notes.join(' ')).toMatch(/changed since the approval/);
    expect(getLearning(ctx.db, 'test-site', a.learning.id).status).toBe('proposed');
  });
});

describe('learning evidence rules (statement vs recorded effect)', () => {
  const summary = (o: Partial<LearningEvidenceSummary> = {}): LearningEvidenceSummary => ({
    evaluationId: 'eval_1',
    result: 'positive',
    concluded: true,
    metric: 'ctr',
    verdict: 'positive',
    effect: 0.12,
    treatedChange: 0.15,
    comparisonPages: 3,
    windows: { baseline: '2026-06-03..2026-06-30', observation: '2026-07-02..2026-07-29', source: 'gsc' },
    isSynthetic: true,
    ...o,
  });

  it('accepts a statement that matches the recorded direction and size', () => {
    expect(checkStatementAgainstEffect('On this page, the title change was followed by a 12% CTR increase relative to comparison pages.', summary())).toEqual([]);
    // The treated-page change alone (15%) is also an accurate size.
    expect(checkStatementAgainstEffect('CTR rose about 15% on the treated page.', summary())).toEqual([]);
  });

  it('flags a claimed direction or size that mismatches the recorded effect, and causal language', () => {
    expect(checkStatementAgainstEffect('Rewriting the title decreased CTR.', summary()).join(' ')).toMatch(/claims a decrease\/deterioration, but the recorded effect is \+12\.0%/);
    expect(checkStatementAgainstEffect('Rewriting homepage copy increases clicks by 30%', summary({ metric: 'clicks', effect: -0.04, treatedChange: -0.02, verdict: 'no_meaningful_change' })).join(' ')).toMatch(
      /claims an increase\/improvement, but the recorded effect is -4\.0%.*directional change, but the verdict was no meaningful change.*claims 30\.0%/,
    );
    expect(checkStatementAgainstEffect('Title rewrites increase CTR by 50%.', summary()).join(' ')).toMatch(/claims 50\.0%, but the recorded effect is \+12\.0% \(treated page alone \+15\.0%\)/);
    expect(checkStatementAgainstEffect('The new title caused a significant CTR increase.', summary()).join(' ')).toMatch(/causal or significance language/);
    expect(checkStatementAgainstEffect('Clicks increased.', summary({ effect: null, treatedChange: null })).join(' ')).toMatch(/no effect was measured/);
    // Average position improves when it goes down: only better/worse wording is judged.
    expect(checkStatementAgainstEffect('Average position improved.', summary({ metric: 'position', effect: 0.1 }))).toEqual([]);
    expect(checkStatementAgainstEffect('Average position got worse.', summary({ metric: 'position', effect: 0.1 })).join(' ')).toMatch(/claims a decrease/);
  });

  it('the approval payload carries the result, effect, and windows, and says so when there is no measured result', () => {
    const evidence = {
      experimentId: 'exp_1',
      evaluationId: 'eval_1',
      evaluationResult: 'positive',
      concluded: true,
      metric: 'ctr',
      verdict: 'positive',
      effect: 0.12,
      treated: { baseline: 0.02, observation: 0.023, improvement: 0.15 },
      control: { baseline: 0.025, observation: 0.0258, improvement: 0.03, pages: 3 },
      windowSource: 'gsc',
      windows: { gsc: { ok: true, windows: { baseline: { start: '2026-06-03', end: '2026-06-30' }, observation: { start: '2026-07-02', end: '2026-07-29' } } } },
      isSynthetic: true,
    };
    expect(learningEvidenceSummary(evidence)).toEqual(summary());
    const payload = learningApprovalPayload({ statement: 'CTR fell 40%.', scope: 'site:test-site; page:/widgets', experimentId: 'exp_1', evidence });
    expect(payload.evidenceSummary).toEqual(summary());
    expect((payload.statementFlags as string[]).join(' ')).toMatch(/claims a decrease/);
    expect(learningApprovalPayload({ statement: 'x', scope: 'site:a', experimentId: null, evidence: { note: 'free text' } })).toMatchObject({ evidenceSummary: null, statementFlags: [expect.stringMatching(/no measured result/)] });
  });

  it('approvals show renders the measured evidence and the statement flags', () => {
    const ctx = createTestContext();
    try {
      const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
      const r = proposeLearning(ctx.db, ctx.clock, gate, {
        siteId: ctx.siteId,
        statement: 'Title rewrites increase CTR by 50%.',
        scope: 'site:test-site; page:https://www.example.test/widgets; change type:title_meta',
        evidence: { experimentId: 'exp_1', evaluationId: 'eval_1', evaluationResult: 'positive', concluded: true, metric: 'ctr', verdict: 'positive', effect: 0.12, treated: { improvement: 0.15 }, control: { pages: 3 }, isSynthetic: true },
        requestedBy: 'owner:Alice',
      });
      const text = renderApproval(gate.detail(ctx.siteId, r.approval.id));
      expect(text).toMatch(/Measured evidence:\n  evaluation:  eval_1 result positive \(concluded\) \[SYNTHETIC\]/);
      expect(text).toMatch(/primary:     ctr verdict positive; effect \+12\.0% \(treated page alone \+15\.0%, 3 comparison page\(s\)\)/);
      expect(text).toMatch(/Statement flags .*\n  - The statement claims 50\.0%/);
      const bare = proposeLearning(ctx.db, ctx.clock, gate, { siteId: ctx.siteId, statement: 'Something.', scope: 'site:test-site', evidence: { note: 'x' }, requestedBy: 'owner:Alice' });
      expect(renderApproval(gate.detail(ctx.siteId, bare.approval.id))).toMatch(/NONE RECORDED: this learning carries no evaluation result/);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('change annotations', () => {
  let ctx: TestContext;
  beforeEach(() => (ctx = createTestContext()));
  afterEach(() => ctx.cleanup());

  it('validate scope, kind, zone-qualified time, and page requirement; future changes are refused', () => {
    const base = { siteId: 'test-site', scope: 'site' as const, kind: 'site_change' as const, occurredAt: '2026-09-20T10:00:00Z', description: 'Synthetic nav change', recordedBy: 'owner:Alice' };
    expect(recordAnnotation(ctx.db, ctx.clock, base).annotation.occurredAt).toBe('2026-09-20T10:00:00.000Z');
    expect(() => recordAnnotation(ctx.db, ctx.clock, { ...base, occurredAt: '2026-09-20' })).toThrow(/explicit zone/);
    expect(() => recordAnnotation(ctx.db, ctx.clock, { ...base, occurredAt: '2027-01-01T00:00:00Z' })).toThrow(/future/);
    expect(() => recordAnnotation(ctx.db, ctx.clock, { ...base, scope: 'page' })).toThrow(/needs a page/);
    expect(() => recordAnnotation(ctx.db, ctx.clock, { ...base, kind: 'bogus' as never })).toThrow(/Unknown annotation kind/);
    const p = seedPage(ctx.db, 'test-site', { path: '/w' });
    const r = recordAnnotation(ctx.db, ctx.clock, { ...base, scope: 'page', kind: 'critical_fix', pageId: p.id, overridesFreeze: true });
    expect(r.annotation).toMatchObject({ scope: 'page', overridesFreeze: true, pageId: p.id });
    expect(parseInstant('2026-09-20T13:00:00+03:00', 'x')).toBe('2026-09-20T10:00:00.000Z');
  });
});
