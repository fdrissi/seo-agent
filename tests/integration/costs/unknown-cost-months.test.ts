/**
 * B3-09: unknown LLM charges are counted in the BUDGET month (business time
 * zone), like the budget reservations themselves, never by the UTC month of
 * created_at. SYNTHETIC rows; offline.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { siteBudgetTimeZone, unknownCostCounts } from '../../../src/reports/queries.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

let n = 0;
function llmCall(t: TestContext, createdAt: string, extra: { reservationId?: string; synthetic?: boolean } = {}): void {
  n++;
  t.db.run(
    `INSERT INTO llm_calls (id, site_id, trace_id, role, tier, prompt_id, prompt_version, model_requested, max_output_tokens, cost_status, validation_status, reservation_id, is_synthetic, created_at)
     VALUES (?, ?, 'trace', 'analyst', 'reasoning', 'p', 'p@1', 'model-under-test', 100, 'unknown', 'valid', ?, ?, ?)`,
    [`llm_${n}`, t.siteId, extra.reservationId ?? null, extra.synthetic ? 1 : 0, createdAt],
  );
}

describe('unknownCostCounts month buckets', () => {
  it('counts an unknown-cost LLM call just after local midnight on the 1st in the new local month, not the UTC month', () => {
    // Europe/Tallinn is UTC+3 in September: 2026-08-31T21:30Z is 2026-09-01 00:30 local.
    ctx = createTestContext({ now: '2026-08-31T21:30:00.000Z', config: testSiteConfig({ reporting: { businessTimezone: 'Europe/Tallinn' } }) });
    expect(siteBudgetTimeZone(ctx.db, ctx.siteId)).toBe('Europe/Tallinn');
    // With a reservation: bucketed by the reservation's budget month.
    const r = ctx.budgets.reserve({ siteId: ctx.siteId, provider: 'llm_gateway', runId: 'run_1', purpose: 'SYNTHETIC call', estimate: { upperBoundMicros: 10_000, basis: { source: 'verified_config', detail: 'synthetic' } } });
    expect(r.periodMonth).toBe('2026-09');
    llmCall(ctx, '2026-08-31T21:30:00.000Z', { reservationId: r.id });
    // Without a reservation: bucketed by the local month of created_at.
    llmCall(ctx, '2026-08-31T21:45:00.000Z');
    // Late on Aug 31 local (20:30 UTC = 23:30 local): still August.
    llmCall(ctx, '2026-08-31T20:30:00.000Z');
    // Synthetic fixture calls never count.
    llmCall(ctx, '2026-09-10T10:00:00.000Z', { synthetic: true });

    expect(unknownCostCounts(ctx.db, ctx.siteId, '2026-09').llmUnknown).toBe(2);
    expect(unknownCostCounts(ctx.db, ctx.siteId, '2026-08').llmUnknown).toBe(1);
    // An explicit zone overrides the site's zone (UTC would have put all three in August).
    expect(unknownCostCounts(ctx.db, ctx.siteId, '2026-08', 'UTC').llmUnknown).toBe(2);
    expect(unknownCostCounts(ctx.db, ctx.siteId, '2026-09', 'UTC').llmUnknown).toBe(1); // the reservation-linked call keeps its budget month
  });

  it('follows the scheduler zone when no business zone is set, and counts a reservation-linked call in its reservation month', () => {
    // America/Los_Angeles: 2026-10-01T05:00Z is 2026-09-30 22:00 local.
    ctx = createTestContext({ now: '2026-10-01T05:00:00.000Z', config: testSiteConfig({ scheduler: { timezone: 'America/Los_Angeles' } }) });
    expect(siteBudgetTimeZone(ctx.db, ctx.siteId)).toBe('America/Los_Angeles');
    const r = ctx.budgets.reserve({ siteId: ctx.siteId, provider: 'llm_gateway', runId: 'run_1', purpose: 'SYNTHETIC call', estimate: { upperBoundMicros: 10_000, basis: { source: 'verified_config', detail: 'synthetic' } } });
    expect(r.periodMonth).toBe('2026-09');
    // The call row was written a little later (after local midnight), but its charge belongs to the reservation's month.
    llmCall(ctx, '2026-10-01T07:05:00.000Z', { reservationId: r.id });
    llmCall(ctx, '2026-10-01T05:10:00.000Z');
    expect(unknownCostCounts(ctx.db, ctx.siteId, '2026-09').llmUnknown).toBe(2);
    expect(unknownCostCounts(ctx.db, ctx.siteId, '2026-10').llmUnknown).toBe(0);
  });
});
