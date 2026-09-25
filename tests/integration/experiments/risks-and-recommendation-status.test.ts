/**
 * Spec 23 risks and honest recommendation history (B6-07, B5-06):
 * - an experiment is never proposed without stated risks (library and CLI),
 *   and an experiment still carrying the placeholder earlier versions stored
 *   cannot be approved;
 * - the recommendation behind an approved / implemented experiment moves with
 *   it (approved -> implemented) and a later weekly run never marks a
 *   recommendation that an open experiment was proposed from as superseded.
 * SYNTHETIC data only (example.test domains).
 */
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDecisionEffects } from '../../../src/approvals/effects.js';
import { markImplemented } from '../../../src/approvals/implementation.js';
import { ApprovalService } from '../../../src/approvals/service.js';
import { register as registerApprovals } from '../../../src/cli/commands/approvals.js';
import { register as registerExperiments } from '../../../src/cli/commands/experiments.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { proposeFromRecommendation } from '../../../src/experiments/propose.js';
import { getExperiment, RISKS_NOT_STATED_PLACEHOLDER, risksStated } from '../../../src/experiments/repository.js';
import { specifyRecommendationChange } from '../../../src/experiments/specify-change.js';
import { assembleRecommendation, persistRecommendationSet } from '../../../src/seo/recommend.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { exportInExecuteMode, REVISION, stableChecker } from '../../fixtures/experiments/scenario.js';
import { experimentsSiteConfig, htmlPage, seedPage, seedRecommendation } from '../../fixtures/experiments/seed.js';

const NOW = '2026-09-20T09:00:00.000Z';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

function setup(now = NOW) {
  ctx = createTestContext({ config: experimentsSiteConfig(), now });
  const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
  const page = seedPage(ctx.db, ctx.siteId, { path: '/widgets' });
  return { ctx, gate, page };
}

function recStatus(c: TestContext, id: string): string {
  return c.db.get<{ status: string }>('SELECT status FROM recommendations WHERE site_id = ? AND id = ?', [c.siteId, id])!.status;
}

async function runCli(root: string, args: string[]): Promise<{ out: string; err: string; json: any; failed: boolean }> {
  let out = '';
  let err = '';
  const cli = new CliRuntime({ out: (t) => (out += `${t}\n`), err: (t) => (err += `${t}\n`) }, { ...process.env, SEO_AGENT_WORKSPACE: root });
  const program = new Command();
  program.exitOverride().option('-w, --workspace <dir>').option('-s, --site <id>').option('--dry-run').option('--json').option('--mode <mode>').option('--offline').configureOutput({ writeErr: (s) => (err += s), writeOut: (s) => (out += s) });
  registerApprovals(program, cli);
  registerExperiments(program, cli);
  let failed = false;
  const prevExit = process.exitCode;
  try {
    await program.parseAsync(['node', 'seo-agent', '--workspace', root, '--offline', ...args]);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
    failed = true;
  } finally {
    if (process.exitCode) failed = true;
    process.exitCode = prevExit;
  }
  let json: any = null;
  try {
    json = JSON.parse(out);
  } catch {
    json = null;
  }
  return { out, err, json, failed };
}

describe('an experiment states its risks (spec 23)', () => {
  it('propose is refused with VALIDATION_FAILED when neither the recommendation nor --risks states risks; nothing is recorded', async () => {
    const s = setup();
    const count = (table: string) => s.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;
    for (const risks of [null, '   ', RISKS_NOT_STATED_PLACEHOLDER]) {
      const rec = seedRecommendation(s.ctx.db, s.ctx.siteId, { pageId: s.page.id, risks });
      await expect(proposeFromRecommendation(s.ctx, s.gate, { recommendationId: rec, requestedBy: 'owner:Alice' })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        message: expect.stringMatching(/states no risks and none were given/),
        hint: expect.stringMatching(/--risks/),
      });
    }
    expect(count('experiments')).toBe(0);
    expect(count('approvals')).toBe(0);
    // --risks states them: the experiment records exactly those risks.
    const rec = seedRecommendation(s.ctx.db, s.ctx.siteId, { pageId: s.page.id, risks: null });
    const p = await proposeFromRecommendation(s.ctx, s.gate, { recommendationId: rec, requestedBy: 'owner:Alice', risks: 'SYNTHETIC: the new title may lose secondary queries.' });
    expect(p.experiment.risks).toBe('SYNTHETIC: the new title may lose secondary queries.');
    expect(p.warnings.join(' ')).not.toMatch(/did not state risks/);
    expect(risksStated(p.experiment.risks)).toBe(true);
    expect(risksStated(RISKS_NOT_STATED_PLACEHOLDER)).toBe(false);
    expect(risksStated('  ')).toBe(false);
  });

  it('approvals approve refuses an experiment whose risks are still the placeholder (or empty); reject + re-propose with --risks works', async () => {
    const s = setup();
    const rec = seedRecommendation(s.ctx.db, s.ctx.siteId, { pageId: s.page.id });
    const p = await proposeFromRecommendation(s.ctx, s.gate, { recommendationId: rec, requestedBy: 'owner:Alice', sourceRevision: REVISION });
    // An experiment recorded by an earlier version, with the placeholder instead of risks.
    for (const legacy of [RISKS_NOT_STATED_PLACEHOLDER, '']) {
      s.ctx.db.run('UPDATE experiments SET risks = ? WHERE id = ?', [legacy, p.experiment.id]);
      expect(() => s.gate.approve(s.ctx.siteId, p.approval.id, { approver: 'Alice', confirmHashPrefix: p.approval.artifactHash.slice(0, 12) })).toThrow(/Not approved: experiment .* states no risks/);
      expect(s.gate.get(p.approval.id)?.status).toBe('pending');
    }
    expect(s.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM decisions WHERE decision = 'approved'")!.n).toBe(0);
    // The way out: reject (cancels the proposed experiment), then propose again with the risks stated.
    const rejected = s.gate.reject(s.ctx.siteId, p.approval.id, { approver: 'Alice', reason: 'risks not stated' });
    applyDecisionEffects(s.ctx.db, s.ctx.clock, rejected, 'owner:Alice');
    expect(getExperiment(s.ctx.db, s.ctx.siteId, p.experiment.id).status).toBe('cancelled');
    const again = await proposeFromRecommendation(s.ctx, s.gate, { recommendationId: rec, requestedBy: 'owner:Alice', sourceRevision: REVISION, risks: 'SYNTHETIC: relevance loss for secondary queries.' });
    const approved = s.gate.approve(s.ctx.siteId, again.approval.id, { approver: 'Alice', confirmHashPrefix: again.approval.artifactHash.slice(0, 12) });
    expect(approved.status).toBe('approved');
  });

  it('a secondary observation (no risks) can be specified with --risks; without them the revision warns and the experiment is refused', async () => {
    const s = setup();
    const obs = seedRecommendation(s.ctx.db, s.ctx.siteId, { pageId: s.page.id, kind: 'secondary', actionType: 'observation:title_snippet_investigation', proposedChange: null, hypothesis: null, risks: null, details: {} });
    const hypothesis = 'SYNTHETIC: a clearer title raises CTR.';
    const without = specifyRecommendationChange(s.ctx, { recommendationId: obs, by: 'Alice', title: 'Synthetic title', hypothesis });
    expect(without.recommendation.risks).toBeNull();
    expect(without.warnings.join(' ')).toMatch(/states no risks; an experiment is refused without them/);
    await expect(proposeFromRecommendation(s.ctx, s.gate, { recommendationId: without.recommendation.id, requestedBy: 'owner:Alice' })).rejects.toThrow(/states no risks/);
    const withRisks = specifyRecommendationChange(s.ctx, { recommendationId: without.recommendation.id, by: 'Alice', title: 'Synthetic title', risks: 'SYNTHETIC: may lose secondary queries.' });
    expect(withRisks.recommendation.risks).toBe('SYNTHETIC: may lose secondary queries.');
    expect(JSON.parse(withRisks.recommendation.details_json!)).toMatchObject({ originalRisks: null, risksBy: 'owner:Alice' });
    expect(withRisks.warnings.join(' ')).not.toMatch(/states no risks/);
    const p = await proposeFromRecommendation(s.ctx, s.gate, { recommendationId: withRisks.recommendation.id, requestedBy: 'owner:Alice' });
    expect(p.experiment.risks).toBe('SYNTHETIC: may lose secondary queries.');
    // A plain-text line only.
    expect(() => specifyRecommendationChange(s.ctx, { recommendationId: withRisks.recommendation.id, by: 'Alice', title: 'Other', risks: 'a\u0007b' })).toThrow(/single line of plain text/);
  });

  it('CLI: experiments propose without risks fails as its help promises; approvals approve refuses a placeholder', async () => {
    const s = setup(new Date().toISOString());
    const root = s.ctx.paths.root;
    const noRisks = seedRecommendation(s.ctx.db, s.ctx.siteId, { pageId: s.page.id, risks: null });
    const refused = await runCli(root, ['experiments', 'propose', '--recommendation', noRisks, '--as', 'Alice']);
    expect(refused.failed).toBe(true);
    expect(refused.err).toMatch(/states no risks/);
    expect(refused.err).toMatch(/--risks/);
    const ok = await runCli(root, ['--json', 'experiments', 'propose', '--recommendation', noRisks, '--as', 'Alice', '--risks', 'SYNTHETIC: title may lose secondary queries.', '--revision', REVISION]);
    expect(ok.failed).toBe(false);
    expect(ok.json.experiment.risks).toBe('SYNTHETIC: title may lose secondary queries.');
    s.ctx.db.run('UPDATE experiments SET risks = ? WHERE id = ?', [RISKS_NOT_STATED_PLACEHOLDER, ok.json.experiment.id]);
    const approve = await runCli(root, ['approvals', 'approve', ok.json.approval.id, '--as', 'Alice', '--confirm', ok.json.approval.artifactHash.slice(0, 12)]);
    expect(approve.failed).toBe(true);
    expect(approve.err).toMatch(/states no risks/);
    expect(s.gate.get(ok.json.approval.id)?.status).toBe('pending');
  });
});

describe('the recommendation behind an experiment keeps an honest status', () => {
  const weekly = (siteId: string) =>
    assembleRecommendation(siteId, { candidates: [], siteDecision: null, routeCounts: { HEALTHY: 3 }, prior: { activeExperiments: [], concludedExperiments: [], decisions: [], rejectedRecommendations: [], learnings: [], memory: { status: 'not_configured', items: [] } }, today: '2026-09-24', reviewDays: 28, lowTrafficReviewDays: 56 });

  it('proposed experiment: the next weekly does not supersede its recommendation; approval -> approved; implementation -> implemented', async () => {
    const s = setup();
    const tested = seedRecommendation(s.ctx.db, s.ctx.siteId, { pageId: s.page.id });
    const other = seedPage(s.ctx.db, s.ctx.siteId, { path: '/other' });
    const untouched = seedRecommendation(s.ctx.db, s.ctx.siteId, { pageId: other.id });
    const p = await proposeFromRecommendation(s.ctx, s.gate, { recommendationId: tested, requestedBy: 'owner:Alice', sourceRevision: REVISION }, { targetChecker: stableChecker });

    // A weekly run while the experiment awaits approval: only the untested proposal is superseded.
    const first = persistRecommendationSet(s.ctx.db, s.ctx.siteId, weekly(s.ctx.siteId), { now: s.ctx.clock.now() });
    expect(first.superseded).toBe(1);
    expect(recStatus(s.ctx, untouched)).toBe('superseded');
    expect(recStatus(s.ctx, tested)).toBe('proposed');

    // Approving the experiment approves the recommendation it tests.
    const approved = s.gate.approve(s.ctx.siteId, p.approval.id, { approver: 'Alice', confirmHashPrefix: p.approval.artifactHash.slice(0, 12) });
    const notes = applyDecisionEffects(s.ctx.db, s.ctx.clock, approved, 'owner:Alice');
    expect(notes.join(' ')).toMatch(new RegExp(`Recommendation ${tested} marked approved \\(tested as experiment ${p.experiment.id}\\)`));
    expect(recStatus(s.ctx, tested)).toBe('approved');

    // Implemented: the recommendation is implemented, and later weekly runs leave it alone.
    await exportInExecuteMode(s.ctx, s.gate, 'experiment', p.experiment.id);
    s.ctx.clock.set('2026-09-21T09:00:00.000Z');
    const live = htmlPage({ title: 'Synthetic Widget Guide 2026', description: 'A synthetic description for tests.' });
    await markImplemented(
      s.ctx,
      s.gate,
      { subjectType: 'experiment', subjectId: p.experiment.id, implementedAt: '2026-09-20T12:00:00Z', revision: 'r2', recordedBy: 'Alice' },
      { fetcher: async (url) => ({ ok: true, page: { requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', html: live, fetchedAt: NOW, redirectChain: [] } }) },
    );
    expect(getExperiment(s.ctx.db, s.ctx.siteId, p.experiment.id).status).toBe('observing');
    expect(recStatus(s.ctx, tested)).toBe('implemented');
    persistRecommendationSet(s.ctx.db, s.ctx.siteId, weekly(s.ctx.siteId), { now: s.ctx.clock.now() });
    expect(recStatus(s.ctx, tested)).toBe('implemented');
  });

  it('a still-proposed recommendation of an observing (or awaiting) experiment is kept; a cancelled experiment no longer holds it', () => {
    const s = setup();
    const now = s.ctx.clock.now().toISOString();
    const expFor = (recId: string, status: string) =>
      s.ctx.db.run(
        `INSERT INTO experiments (id, site_id, page_id, recommendation_id, type, hypothesis, evidence_json, proposed_change, change_hash, primary_metric, outcome_kind, guardrail_metrics_json, min_observation_days, sample_requirements_json, risks, rollback_plan, status, created_at, updated_at)
         VALUES (?, ?, NULL, ?, 'title_meta', 'SYNTHETIC hypothesis', '{}', 'SYNTHETIC change', 'hash', 'clicks', 'seo_visibility', '[]', 28, '{}', 'SYNTHETIC risk', 'revert', ?, ?, ?)`,
        [`exp_${status}`, s.ctx.siteId, recId, status, now, now],
      );
    const recs: Record<string, string> = {};
    for (const status of ['proposed', 'approved', 'awaiting_implementation', 'observing', 'cancelled', 'negative']) {
      recs[status] = seedRecommendation(s.ctx.db, s.ctx.siteId, { pageId: s.page.id });
      expFor(recs[status]!, status);
    }
    const free = seedRecommendation(s.ctx.db, s.ctx.siteId, { pageId: s.page.id });
    const saved = persistRecommendationSet(s.ctx.db, s.ctx.siteId, weekly(s.ctx.siteId), { now: s.ctx.clock.now() });
    expect(saved.superseded).toBe(3);
    for (const status of ['proposed', 'approved', 'awaiting_implementation', 'observing']) expect(recStatus(s.ctx, recs[status]!), status).toBe('proposed');
    for (const id of [recs.cancelled!, recs.negative!, free]) expect(recStatus(s.ctx, id)).toBe('superseded');
  });
});
