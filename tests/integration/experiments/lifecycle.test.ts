import { afterEach, describe, expect, it } from 'vitest';
import { buildScenario, exportInExecuteMode, REVISION, seedScenarioData, stableChecker, T, type Scenario } from '../../fixtures/experiments/scenario.js';
import { evaluateExperiment, reviewExperiments } from '../../../src/experiments/evaluate.js';
import { getExperiment, listEvaluations, statusHistory } from '../../../src/experiments/repository.js';
import { recordAnnotation } from '../../../src/experiments/annotations.js';
import { proposeFromRecommendation } from '../../../src/experiments/propose.js';
import { transitionExperiment } from '../../../src/experiments/status.js';
import { experimentsSiteConfig, seedRecommendation } from '../../fixtures/experiments/seed.js';
import { listLearnings } from '../../../src/experiments/learnings.js';
import { weekdayCounts } from '../../../src/experiments/windows.js';
import { EVALUATION_METHOD_VERSION } from '../../../src/experiments/method.js';
import { applyDecisionEffects } from '../../../src/approvals/effects.js';
import { markImplemented } from '../../../src/approvals/implementation.js';
import { requestApprovalForSubject } from '../../../src/approvals/requests.js';
import { ApprovalService } from '../../../src/approvals/service.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

function approveNow(s: { ctx: TestContext; gate: ApprovalService }, approvalId: string): string[] {
  const d = s.gate.detail(s.ctx.siteId, approvalId);
  const a = s.gate.approve(s.ctx.siteId, approvalId, { approver: 'Alice', confirmHashPrefix: d.hashPrefix, acknowledgeUnboundRevision: d.sourceRevision === null });
  return applyDecisionEffects(s.ctx.db, s.ctx.clock, a, 'owner:Alice');
}

describe('experiment lifecycle (synthetic data)', () => {
  let s: Scenario | undefined;
  afterEach(() => s?.ctx.cleanup());

  it('observation starts at the actual implementation time, not approval or proposal time', async () => {
    s = await buildScenario();
    const e = getExperiment(s.ctx.db, s.ctx.siteId, s.experimentId);
    expect(e.status).toBe('observing');
    expect(e.implementedAt).toBe(T.implementedAt);
    expect(e.observationStart).toBe(T.implementedAt);
    expect(e.observationStart).not.toBe(T.approveAt);
    expect(e.observationStart).not.toBe(e.createdAt);
    expect(e.sourceRevision).toBe('deploy-42');
    expect(statusHistory(s.ctx.db, s.ctx.siteId, s.experimentId).map((h) => h.to)).toEqual(['proposed', 'approved', 'awaiting_implementation', 'observing']);
    // The evaluation window starts the day after the implementation date in the GSC reporting zone.
    const ev = evaluateExperiment(s.ctx, s.experimentId, { dryRun: true });
    const w = ev.windows.gsc;
    expect(w?.ok).toBe(true);
    if (w?.ok) {
      expect(w.windows.implementationDate).toBe('2026-07-01');
      expect(w.windows.observation.start).toBe('2026-07-02');
      expect(w.windows.baseline.end).toBe('2026-06-30');
    }
  });

  it('evaluates a clear CTR gain vs comparison pages as positive, records it, and proposes a scoped learning pending approval', async () => {
    s = await buildScenario();
    const ev = evaluateExperiment(s.ctx, s.experimentId, { gate: s.gate, actor: 'system:test' });
    expect(ev.result).toBe('positive');
    expect(ev.concluded).toBe(true);
    expect(ev.seo?.primary.metric).toBe('ctr');
    expect(ev.seo?.primary.control?.pages).toBe(3);
    expect(ev.seo?.primary.effect).toBeCloseTo(0.5, 5);
    expect(ev.significance.tested).toBe(false);
    expect(ev.significance.statement).toMatch(/No significance test/);
    expect(ev.isSynthetic).toBe(true);
    // Weekday-matched, equal-length windows.
    const w = ev.windows.gsc;
    expect(w?.ok && w.windows.weekdayMatched).toBe(true);
    if (w?.ok) {
      expect(w.windows.baseline.days).toBe(w.windows.observation.days);
      expect(weekdayCounts(w.windows.baseline)).toEqual(weekdayCounts(w.windows.observation));
    }
    expect(getExperiment(s.ctx.db, s.ctx.siteId, s.experimentId).status).toBe('positive');
    // Guardrail (conversion rate) observed and ok.
    expect(ev.guardrails.map((g) => `${g.metric}:${g.status}`)).toEqual(['primarySessionRate:ok']);
    // Learning is proposed, scoped, and awaits a human approval.
    expect(ev.learning).not.toBeNull();
    const learnings = listLearnings(s.ctx.db, s.ctx.siteId);
    expect(learnings).toHaveLength(1);
    expect(learnings[0]!.status).toBe('proposed');
    expect(learnings[0]!.scope).toMatch(/^site:test-site; page:https:\/\/www\.example\.test\/widgets/);
    expect(learnings[0]!.statement).toMatch(/observational, not proof of causality/);
  });

  it('re-evaluation is appended and informational: it never overwrites the concluded outcome', async () => {
    s = await buildScenario();
    evaluateExperiment(s.ctx, s.experimentId, { actor: 'system:test' });
    const first = listEvaluations(s.ctx.db, s.ctx.siteId, s.experimentId);
    expect(first).toHaveLength(1);
    // New (worse) data revision arrives; re-evaluate.
    s.ctx.db.run(`UPDATE gsc_page_daily SET clicks = 5 WHERE page_id = ? AND date > '2026-07-01'`, [s.page.id]);
    const again = evaluateExperiment(s.ctx, s.experimentId, { actor: 'system:test' });
    expect(again.afterConclusion).toBe(true);
    expect(again.concluded).toBe(false);
    expect(again.result).toBe('negative');
    const all = listEvaluations(s.ctx.db, s.ctx.siteId, s.experimentId);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ sequence: 1, result: 'positive', concluded: true });
    expect(all[1]).toMatchObject({ sequence: 2, result: 'negative', afterConclusion: true, concluded: false });
    expect(getExperiment(s.ctx.db, s.ctx.siteId, s.experimentId).status).toBe('positive');
    // The first-recorded measurement is kept, and the revision is stated, not silently ignored.
    expect(again.measurementRevisions).toContain('gsc observation 2026-07-02..2026-09-16');
    expect(again.reasons.join(' ')).toMatch(/source data was revised since the first recorded measurement/);
    const obs = s.ctx.db.get<{ metrics_json: string }>(`SELECT metrics_json FROM experiment_measurements WHERE experiment_id = ? AND window_kind = 'observation' AND method_version = ?`, [s.experimentId, `${EVALUATION_METHOD_VERSION}:gsc`])!;
    expect(JSON.parse(obs.metrics_json).metrics.clicks).toBe(30 * 77);
    expect(() => s!.ctx.db.run(`UPDATE experiment_evaluations SET result = 'negative' WHERE sequence = 1`)).toThrow(/append-only/);
  });

  it('experiment history cannot be deleted row by row, only together with its experiment', async () => {
    s = await buildScenario();
    evaluateExperiment(s.ctx, s.experimentId, { actor: 'system:test' });
    const db = s.ctx.db;
    expect(() => db.run('DELETE FROM experiment_evaluations WHERE experiment_id = ?', [s!.experimentId])).toThrow(/append-only/);
    expect(() => db.run('DELETE FROM experiment_status_history WHERE experiment_id = ?', [s!.experimentId])).toThrow(/append-only/);
    expect(() => db.run('DELETE FROM experiment_measurements WHERE experiment_id = ?', [s!.experimentId])).toThrow(/append-only/);
    expect(() => db.run(`UPDATE experiment_measurements SET metrics_json = '{}' WHERE experiment_id = ?`, [s!.experimentId])).toThrow(/append-only/);
    expect(() => db.run('DELETE FROM experiment_changes WHERE experiment_id = ?', [s!.experimentId])).toThrow(/immutable/);
    // Deleting the experiment itself (retention/purge) still cascades.
    db.run('DELETE FROM experiments WHERE id = ?', [s.experimentId]);
    for (const t of ['experiment_evaluations', 'experiment_status_history', 'experiment_measurements', 'experiment_changes']) {
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE experiment_id = ?`, [s.experimentId])!.n, t).toBe(0);
    }
  });

  it('before the minimum observation period it keeps collecting (never a premature result)', async () => {
    s = await buildScenario();
    s.ctx.clock.set('2026-07-20T09:00:00.000Z');
    s.ctx.db.run(`DELETE FROM gsc_page_daily WHERE date > '2026-07-17'`);
    s.ctx.db.run(`DELETE FROM gsc_property_daily WHERE date > '2026-07-17'`);
    s.ctx.db.run(`DELETE FROM ga4_landing_daily WHERE date > '2026-07-17'`);
    const ev = evaluateExperiment(s.ctx, s.experimentId, { actor: 'system:test', conclude: true });
    expect(ev.result).toBe('collecting');
    expect(ev.concluded).toBe(false);
    expect(ev.reasons.join(' ')).toMatch(/minimum observation period not reached: the weekday-matched window covers 14 of 28 day\(s\) \(16 complete data day\(s\)/);
    // The window is not formed until it is at least the minimum (whole weeks).
    expect(ev.windows.gsc).toMatchObject({ ok: false, reason: 'less_than_min', availableObservationDays: 16, minDays: 28 });
    expect(getExperiment(s.ctx.db, s.ctx.siteId, s.experimentId).status).toBe('observing');
  });

  it('insufficient evidence on a low-traffic page: collecting, then inconclusive (not negative)', async () => {
    s = await buildScenario({ treated: { before: { clicks: 1, impressions: 5 }, after: { clicks: 0, impressions: 4 } } });
    const e = getExperiment(s.ctx.db, s.ctx.siteId, s.experimentId);
    expect(e.minObservationDays).toBe(56); // low traffic -> longer configured period
    const ev = evaluateExperiment(s.ctx, s.experimentId, { actor: 'system:test' });
    expect(ev.result).toBe('collecting');
    expect(ev.seo?.primary.verdict).toBe('insufficient_data');
    expect(ev.reasons.join(' ')).toMatch(/impressions .* < required 500/);
    const concluded = evaluateExperiment(s.ctx, s.experimentId, { actor: 'owner:Alice', conclude: true });
    expect(concluded.result).toBe('inconclusive');
    expect(getExperiment(s.ctx.db, s.ctx.siteId, s.experimentId).status).toBe('inconclusive');
    expect(listEvaluations(s.ctx.db, s.ctx.siteId, s.experimentId).map((x) => x.result)).toEqual(['collecting', 'inconclusive']);
  });

  it('flags an unrelated site change during the windows and refuses to attribute the result', async () => {
    s = await buildScenario();
    recordAnnotation(s.ctx.db, s.ctx.clock, {
      siteId: s.ctx.siteId,
      scope: 'site',
      kind: 'site_change',
      occurredAt: '2026-07-20T10:00:00Z',
      description: 'Synthetic: new site-wide navigation deployed',
      recordedBy: 'owner:Alice',
    });
    recordAnnotation(s.ctx.db, s.ctx.clock, { siteId: s.ctx.siteId, scope: 'external', kind: 'algorithm_update', occurredAt: '2026-08-05T00:00:00Z', description: 'Synthetic core update', recordedBy: 'owner:Alice' });
    const ev = evaluateExperiment(s.ctx, s.experimentId, { actor: 'system:test' });
    expect(ev.interference.items.map((i) => `${i.kind}:${i.blocking}`)).toEqual(['site_change:true', 'algorithm_update:false']);
    expect(ev.result).toBe('inconclusive');
    expect(ev.reasons.join(' ')).toMatch(/interference during the measurement windows/);
  });

  it('a non-blocking external annotation is flagged but does not change a clear result', async () => {
    s = await buildScenario();
    recordAnnotation(s.ctx.db, s.ctx.clock, { siteId: s.ctx.siteId, scope: 'external', kind: 'seasonality', occurredAt: '2026-08-01T00:00:00Z', description: 'Synthetic holiday season', recordedBy: 'owner:Alice' });
    const ev = evaluateExperiment(s.ctx, s.experimentId, { actor: 'system:test' });
    expect(ev.interference.items).toHaveLength(1);
    expect(ev.interference.blocking).toBe(false);
    expect(ev.result).toBe('positive');
  });

  it('a CTR gain with a breached conversion guardrail is not a win', async () => {
    s = await buildScenario({ ga4: { sessionsBefore: 25, sessionsAfter: 25, rateBefore: 0.08, rateAfter: 0.02 } });
    const ev = evaluateExperiment(s.ctx, s.experimentId, { actor: 'system:test' });
    expect(ev.seo?.primary.verdict).toBe('positive');
    expect(ev.guardrails[0]).toMatchObject({ metric: 'primarySessionRate', status: 'breached' });
    expect(ev.result).toBe('inconclusive');
    expect(ev.reasons.join(' ')).toMatch(/not treated as a win/);
  });

  it('zero extra conversions in a small sample is not a failure', async () => {
    s = await buildScenario({
      recommendation: { actionType: 'improve_cta_conversion' },
      propose: { primaryMetric: 'primarySessionRate' },
      ga4: { sessionsBefore: 3, sessionsAfter: 3, rateBefore: 0.02, rateAfter: 0 },
      config: { minSessions: 50 },
    });
    const e = getExperiment(s.ctx.db, s.ctx.siteId, s.experimentId);
    expect(e.outcomeKind).toBe('conversion');
    const ev = evaluateExperiment(s.ctx, s.experimentId, { actor: 'system:test', conclude: true });
    expect(ev.conversion?.primary.verdict).toBe('insufficient_data');
    expect(ev.result).toBe('inconclusive');
    expect(ev.result).not.toBe('negative');
    expect(ev.reasons.join(' ')).toMatch(/not evidence of failure|sessions .* < required/);
  });

  it('segment matching: segmented rows are never mixed into the unsegmented comparison', async () => {
    s = await buildScenario();
    // Add a large, synthetic MOBILE-segment series only after the change; it must not affect the '' segment.
    const { seedGscPage } = await import('../../fixtures/experiments/seed.js');
    seedGscPage(s.ctx.db, s.ctx.siteId, { pageUrl: s.page.url, pageId: s.page.id, start: '2026-07-02', end: T.dataEnd, clicks: () => 500, impressions: () => 600, segmentKey: 'device=MOBILE' });
    const ev = evaluateExperiment(s.ctx, s.experimentId, { dryRun: true });
    expect(ev.seo?.primary.treated.observation).toBeCloseTo(0.03, 6);
  });

  it('one meaningful change per page: an overlapping experiment is refused unless a critical-fix override is given; the running experiment is flagged at the real deployment time', async () => {
    s = await buildScenario();
    const rec2 = seedRecommendation(s.ctx.db, s.ctx.siteId, {
      pageId: s.page.id,
      actionType: 'add_section',
      proposedChange: 'Add a synthetic sizing FAQ section.',
      details: { proposedContentMarkdown: 'Synthetic FAQ content that is long enough to be checked on the live page later on.' },
    });
    s.ctx.clock.set('2026-08-01T10:00:00.000Z'); // during the running experiment's observation window
    await expect(proposeFromRecommendation(s.ctx, s.gate, { recommendationId: rec2, requestedBy: 'owner:Alice' })).rejects.toThrow(/already has an open experiment .*observing/);
    const r = await proposeFromRecommendation(s.ctx, s.gate, { recommendationId: rec2, requestedBy: 'owner:Alice', criticalFixReason: 'Checkout button broken on this page', sourceRevision: REVISION }, { targetChecker: stableChecker });
    expect(r.experiment.evidence.freezeOverride).toMatchObject({ reason: 'Checkout button broken on this page', heldBy: [{ experimentId: s.experimentId, status: 'observing' }] });
    // A proposal changes nothing on the page: no change annotation, the running experiment is not flagged.
    expect(s.ctx.db.all('SELECT * FROM change_annotations')).toHaveLength(0);
    const auditTypes = s.ctx.db.all<{ event_type: string }>(`SELECT event_type FROM audit_events WHERE subject_id = ?`, [r.experiment.id]).map((a) => a.event_type);
    expect(auditTypes).toContain('experiment.freeze_override_requested');
    s.ctx.clock.set(T.evaluateAt);
    expect(evaluateExperiment(s.ctx, s.experimentId, { dryRun: true }).result).toBe('positive');

    s.ctx.clock.set('2026-08-01T12:00:00.000Z');
    const notes = approveNow(s, r.approval.id);
    expect(notes.join(' ')).toMatch(/page is also held by .*observing.*Critical-fix override recorded at proposal/);
    // Export refuses while the page is under observation, unless the critical fix is restated (recorded).
    await expect(exportInExecuteMode(s.ctx, s.gate, 'experiment', r.experiment.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(s.gate.get(r.approval.id)?.status).toBe('approved');
    const exp2 = await exportInExecuteMode(s.ctx, s.gate, 'experiment', r.experiment.id, { criticalFixReason: 'Checkout button broken on this page' });
    expect(exp2.criticalFixReason).toBe('Checkout button broken on this page');
    expect(s.gate.detail(s.ctx.siteId, r.approval.id).execution).toMatchObject({ kind: 'manual_export', criticalFixReason: 'Checkout button broken on this page', freezeOverriddenFor: [s.experimentId] });

    // Deployed on 2026-08-03: mark-implemented writes the critical_fix annotation at that time (reason taken from the export).
    s.ctx.clock.set('2026-08-04T09:00:00.000Z');
    const impl = await markImplemented(s.ctx, s.gate, { subjectType: 'experiment', subjectId: r.experiment.id, implementedAt: '2026-08-03T10:00:00Z', revision: 'deploy-43', recordedBy: 'Alice' });
    expect(impl.warnings.join(' ')).toMatch(/critical-fix reason recorded at export/);
    const anns = s.ctx.db.all<{ occurred_at: string; kind: string; overrides_freeze: number; page_id: string }>('SELECT occurred_at, kind, overrides_freeze, page_id FROM change_annotations');
    expect(anns).toEqual([{ occurred_at: '2026-08-03T10:00:00.000Z', kind: 'critical_fix', overrides_freeze: 1, page_id: s.page.id }]);
    s.ctx.clock.set(T.evaluateAt);
    const ev = evaluateExperiment(s.ctx, s.experimentId, { dryRun: true });
    expect(ev.interference.items.filter((i) => i.blocking).map((i) => i.kind).sort()).toEqual(['critical_fix', 'overlapping_experiment']);
    expect(ev.result).toBe('inconclusive');
  });

  it('a proposed (not yet approved) experiment already holds its page', async () => {
    const ctx = createTestContext({ config: experimentsSiteConfig(), now: T.proposeAt });
    const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
    s = { ctx, gate } as Scenario;
    const { page } = seedScenarioData(ctx);
    const rec1 = seedRecommendation(ctx.db, ctx.siteId, { pageId: page.id });
    const first = await proposeFromRecommendation(ctx, gate, { recommendationId: rec1, requestedBy: 'owner:Alice' });
    const rec2 = seedRecommendation(ctx.db, ctx.siteId, { pageId: page.id, actionType: 'add_section', proposedChange: 'Add a synthetic FAQ.', details: {} });
    await expect(proposeFromRecommendation(ctx, gate, { recommendationId: rec2, requestedBy: 'owner:Alice' })).rejects.toThrow(new RegExp(`${first.experiment.id} \\(proposed\\)`));
    // Rejecting the first proposal cancels it and frees the page.
    const rejected = gate.reject(ctx.siteId, first.approval.id, { approver: 'Alice', reason: 'Synthetic: not now' });
    applyDecisionEffects(ctx.db, ctx.clock, rejected, 'owner:Alice');
    const second = await proposeFromRecommendation(ctx, gate, { recommendationId: rec2, requestedBy: 'owner:Alice' });
    expect(second.experiment.status).toBe('proposed');
  });

  it('a draft/recommendation export for a page under observation is refused unless a critical fix is recorded', async () => {
    s = await buildScenario();
    s.ctx.clock.set('2026-08-01T10:00:00.000Z');
    const rec = seedRecommendation(s.ctx.db, s.ctx.siteId, {
      pageId: s.page.id,
      actionType: 'rewrite_title_meta',
      proposedChange: 'Change the title to "Another Synthetic Title".',
      details: { proposedTitle: 'Another Synthetic Title' },
    });
    const req = await requestApprovalForSubject(s.ctx, s.gate, { subjectType: 'recommendation', subjectId: rec, requestedBy: 'owner:Alice', sourceRevision: REVISION }, { targetChecker: stableChecker });
    expect(req.warnings.join(' ')).toMatch(/experiment under observation/);
    approveNow(s, req.approval.id);
    await expect(exportInExecuteMode(s.ctx, s.gate, 'recommendation', rec)).rejects.toThrow(/under observation/);
    expect(s.gate.get(req.approval.id)?.status).toBe('approved');
    const out = await exportInExecuteMode(s.ctx, s.gate, 'recommendation', rec, { criticalFixReason: 'Synthetic: title renders broken markup' });
    expect(out.status).toBe('exported');
    expect(out.pageHeldBy).toEqual([{ id: s.experimentId, status: 'observing' }]);
    const audit = s.ctx.db.all<{ event_type: string }>(`SELECT event_type FROM audit_events WHERE subject_type = 'recommendation' AND subject_id = ?`, [rec]).map((a) => a.event_type);
    expect(audit).toContain('export.freeze_override');
  });

  it('multiple pages can run experiments concurrently', async () => {
    s = await buildScenario();
    const other = s.comparison[0]!;
    const rec = seedRecommendation(s.ctx.db, s.ctx.siteId, { pageId: other.id });
    const r = await proposeFromRecommendation(s.ctx, s.gate, { recommendationId: rec, requestedBy: 'owner:Alice' });
    expect(r.experiment.status).toBe('proposed');
  });

  it('repeated testing of the same change until favorable is refused; a documented re-test keeps prior outcomes', async () => {
    s = await buildScenario({ treated: { before: { clicks: 20, impressions: 1000 }, after: { clicks: 20, impressions: 1000 } } });
    const ev = evaluateExperiment(s.ctx, s.experimentId, { actor: 'system:test' });
    expect(ev.result).toBe('inconclusive');
    const rec = seedRecommendation(s.ctx.db, s.ctx.siteId, { pageId: s.page.id });
    await expect(proposeFromRecommendation(s.ctx, s.gate, { recommendationId: rec, requestedBy: 'owner:Alice' })).rejects.toThrow(/This exact change was already tested/);
    // Rewording the same kind of change on the same page does not bypass the guard.
    const reworded = seedRecommendation(s.ctx.db, s.ctx.siteId, {
      pageId: s.page.id,
      proposedChange: 'Change the title to "Reworded Synthetic Widget Guide".',
      details: { proposedTitle: 'Reworded Synthetic Widget Guide' },
    });
    await expect(proposeFromRecommendation(s.ctx, s.gate, { recommendationId: reworded, requestedBy: 'owner:Alice' })).rejects.toThrow(/A title_meta change on this page was already tested/);
    const r = await proposeFromRecommendation(s.ctx, s.gate, { recommendationId: rec, requestedBy: 'owner:Alice', retestReason: 'Synthetic: first test overlapped an outage' });
    expect(r.experiment.evidence.priorTests).toEqual([{ experimentId: s.experimentId, status: 'inconclusive', match: 'exact_change', wentLive: true }]);
    expect(r.experiment.evidence.retestReason).toBe('Synthetic: first test overlapped an outage');
  });

  it('cancelling a live experiment with unfavorable data does not allow an unrecorded re-test', async () => {
    s = await buildScenario();
    s.ctx.clock.set('2026-08-01T10:00:00.000Z');
    transitionExperiment(s.ctx.db, s.ctx.clock, { siteId: s.ctx.siteId, experimentId: s.experimentId, to: 'cancelled', actor: 'owner:Alice', reason: 'Synthetic: looks unfavorable' });
    const rec = seedRecommendation(s.ctx.db, s.ctx.siteId, { pageId: s.page.id });
    await expect(proposeFromRecommendation(s.ctx, s.gate, { recommendationId: rec, requestedBy: 'owner:Alice' })).rejects.toThrow(/already tested .*cancelled after going live/);
    const r = await proposeFromRecommendation(s.ctx, s.gate, { recommendationId: rec, requestedBy: 'owner:Alice', retestReason: 'Synthetic: tracking was broken during the first test' });
    expect(r.experiment.evidence.priorTests).toEqual([{ experimentId: s.experimentId, status: 'cancelled', match: 'exact_change', wentLive: true }]);
  });

  it('an experiment cancelled before it went live is not a prior test', async () => {
    s = await buildScenario({ implement: false });
    transitionExperiment(s.ctx.db, s.ctx.clock, { siteId: s.ctx.siteId, experimentId: s.experimentId, to: 'cancelled', actor: 'owner:Alice', reason: 'Synthetic: not now' });
    const rec = seedRecommendation(s.ctx.db, s.ctx.siteId, { pageId: s.page.id });
    const r = await proposeFromRecommendation(s.ctx, s.gate, { recommendationId: rec, requestedBy: 'owner:Alice' });
    expect(r.experiment.evidence.priorTests).toEqual([]);
  });

  it('recorded implementations of drafts/recommendations count as interference: treated page blocks, comparison pages are excluded', async () => {
    s = await buildScenario();
    const pub = (id: string, pageId: string, url: string, at: string) =>
      s!.ctx.db.run(
        `INSERT INTO publications (id, site_id, subject_type, subject_id, approval_id, url, page_id, method, implemented_at, recorded_by, created_at)
         VALUES (?, ?, 'recommendation', ?, NULL, ?, ?, 'manual_export', ?, 'owner:Alice', ?)`,
        [id, s!.ctx.siteId, `rec_${id}`, url, pageId, at, at],
      );
    const c1 = s.comparison[0]!;
    pub('pub_c1', c1.id, c1.url, '2026-07-10T10:00:00.000Z');
    const ev = evaluateExperiment(s.ctx, s.experimentId, { dryRun: true });
    expect(ev.interference.items).toMatchObject([{ source: 'publication', id: 'pub_c1', blocking: false }]);
    expect(ev.interference.excludedComparisonPages).toEqual([c1.id]);
    expect(ev.seo?.primary.control?.pages).toBe(2);
    expect(ev.result).toBe('positive');
    // A recorded change on the treated page, even during the baseline window, prevents attribution.
    pub('pub_t', s.page.id, s.page.url, '2026-06-20T10:00:00.000Z');
    const ev2 = evaluateExperiment(s.ctx, s.experimentId, { dryRun: true });
    expect(ev2.interference.items.find((i) => i.id === 'pub_t')).toMatchObject({ blocking: true, kind: 'recorded_change' });
    expect(ev2.result).toBe('inconclusive');
  });

  it('review evaluates observing experiments, lists those awaiting implementation, and supports dry runs', async () => {
    s = await buildScenario();
    const dry = reviewExperiments(s.ctx, { dryRun: true });
    expect(dry.evaluated).toHaveLength(1);
    expect(listEvaluations(s.ctx.db, s.ctx.siteId, s.experimentId)).toHaveLength(0);
    const real = reviewExperiments(s.ctx, { actor: 'system:test' });
    expect(real.evaluated[0]!.result).toBe('positive');
    expect(listEvaluations(s.ctx.db, s.ctx.siteId, s.experimentId)).toHaveLength(1);
  });

  it('records frozen versions and flags a changed measurement method', async () => {
    s = await buildScenario();
    const e = getExperiment(s.ctx.db, s.ctx.siteId, s.experimentId);
    expect(e.frozenVersions).toMatchObject({ promptVersion: 'recommend@1+abcd1234', modelId: 'synthetic-model', scoringVersion: 'scoring@1', measurementMethodVersion: EVALUATION_METHOD_VERSION });
    s.ctx.db.run(`UPDATE experiments SET frozen_versions_json = json_set(frozen_versions_json, '$.measurementMethodVersion', '0') WHERE id = ?`, [s.experimentId]);
    const ev = evaluateExperiment(s.ctx, s.experimentId, { dryRun: true });
    expect(ev.reasons.join(' ')).toMatch(/measurement method changed since the experiment started/);
  });
});
