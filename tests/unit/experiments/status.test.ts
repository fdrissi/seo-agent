import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { canTransition, TRANSITIONS, transitionExperiment } from '../../../src/experiments/status.js';
import { statusHistory } from '../../../src/experiments/repository.js';
import { EXPERIMENT_STATUSES, TERMINAL_STATUSES } from '../../../src/experiments/types.js';

function insertExperiment(ctx: TestContext, id: string, status = 'proposed'): void {
  const now = ctx.clock.now().toISOString();
  ctx.db.run(
    `INSERT INTO experiments (id, site_id, type, hypothesis, evidence_json, proposed_change, change_hash, primary_metric, outcome_kind, guardrail_metrics_json, min_observation_days,
       sample_requirements_json, risks, rollback_plan, status, created_at, updated_at)
     VALUES (?, 'test-site', 'title_meta', 'h', '{}', 'c', ?, 'ctr', 'seo_visibility', '[]', 28, '{}', 'r', 'rb', ?, ?, ?)`,
    [id, 'a'.repeat(64), status, now, now],
  );
}

describe('experiment status machine', () => {
  let ctx: TestContext;
  beforeEach(() => (ctx = createTestContext()));
  afterEach(() => ctx.cleanup());

  it('allows only the documented path and cancellation of non-terminal states', () => {
    expect(canTransition('proposed', 'approved')).toBe(true);
    expect(canTransition('approved', 'awaiting_implementation')).toBe(true);
    expect(canTransition('awaiting_implementation', 'observing')).toBe(true);
    for (const t of ['positive', 'negative', 'inconclusive', 'cancelled'] as const) expect(canTransition('observing', t)).toBe(true);
    expect(canTransition('proposed', 'observing')).toBe(false);
    expect(canTransition('approved', 'observing')).toBe(false);
    expect(canTransition('proposed', 'positive')).toBe(false);
    for (const t of TERMINAL_STATUSES) expect(TRANSITIONS[t]).toEqual([]);
    for (const s of EXPERIMENT_STATUSES) if (!TERMINAL_STATUSES.includes(s)) expect(canTransition(s, 'cancelled')).toBe(true);
  });

  it('records every transition in the append-only history and audit log', () => {
    insertExperiment(ctx, 'exp_a');
    transitionExperiment(ctx.db, ctx.clock, { siteId: 'test-site', experimentId: 'exp_a', to: 'approved', actor: 'owner:Alice', reason: 'ok' });
    transitionExperiment(ctx.db, ctx.clock, { siteId: 'test-site', experimentId: 'exp_a', to: 'cancelled', actor: 'owner:Alice', reason: 'no longer needed' });
    expect(statusHistory(ctx.db, 'test-site', 'exp_a').map((h) => `${h.from}->${h.to}`)).toEqual(['proposed->approved', 'approved->cancelled']);
    expect(() => transitionExperiment(ctx.db, ctx.clock, { siteId: 'test-site', experimentId: 'exp_a', to: 'observing', actor: 'x' })).toThrow(/cannot move from cancelled/);
    expect(() => ctx.db.run(`UPDATE experiment_status_history SET to_status = 'positive'`)).toThrow(/append-only/);
    const audits = ctx.db.all(`SELECT * FROM audit_events WHERE subject_id = 'exp_a' AND event_type = 'experiment.status_changed'`);
    expect(audits).toHaveLength(2);
  });

  it('a concluded outcome can never be relabeled', () => {
    insertExperiment(ctx, 'exp_b', 'negative');
    for (const to of EXPERIMENT_STATUSES) expect(() => transitionExperiment(ctx.db, ctx.clock, { siteId: 'test-site', experimentId: 'exp_b', to, actor: 'x' })).toThrow();
  });
});
