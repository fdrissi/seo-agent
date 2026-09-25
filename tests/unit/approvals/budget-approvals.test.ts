import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { ApprovalService } from '../../../src/approvals/service.js';
import { checkBudgetException, consumePaidRequestApproval, requestBudgetException, requestPaidRequestApproval } from '../../../src/approvals/budget-approvals.js';
import { toMicros } from '../../../src/core/money.js';

describe('spend approvals (paid_request / budget_exception)', () => {
  let ctx: TestContext;
  let gate: ApprovalService;
  beforeEach(() => {
    ctx = createTestContext();
    gate = new ApprovalService(ctx.db, { clock: ctx.clock });
  });
  afterEach(() => ctx.cleanup());

  const req = { siteId: 'test-site', provider: 'dataforseo' as const, endpoint: 'serp/google/organic/task_post', requestHash: 'r'.repeat(64), maxChargeMicros: toMicros('0.05') };

  it('an unknown-price request needs a one-time human approval, which unlocks exactly one reservation', () => {
    expect(() => ctx.budgets.reserve({ siteId: 'test-site', provider: 'dataforseo', runId: 'run1', purpose: 'serp', estimate: { upperBoundMicros: null, basis: { source: 'unknown', detail: 'no verified price' } } })).toThrow(/safe cost upper bound/);
    expect(() => consumePaidRequestApproval(gate, req)).toThrow(/APPROVAL|approval/);
    const a = requestPaidRequestApproval(gate, { ...req, purpose: 'SERP for one shortlisted query', requestedBy: 'system:research' });
    expect(a.summary).toMatch(/at most \$0\.05/);
    gate.approve('test-site', a.id, { approver: 'Alice', confirmHashPrefix: a.artifactHash.slice(0, 10) });
    const approvalId = consumePaidRequestApproval(gate, req);
    expect(approvalId).toBe(a.id);
    const res = ctx.budgets.reserve({ siteId: 'test-site', provider: 'dataforseo', runId: 'run1', purpose: 'serp', estimate: { upperBoundMicros: null, basis: { source: 'unknown', detail: 'no verified price' } }, unknownPriceApprovalId: approvalId });
    expect(res.status).toBe('reserved');
    // One-time: the same approval cannot unlock a second request.
    expect(() => consumePaidRequestApproval(gate, req)).toThrow(/already_executed|already executed/);
  });

  it('an approval for a different request or a different cap does not apply', () => {
    const a = requestPaidRequestApproval(gate, { ...req, purpose: 'p', requestedBy: 'system:research' });
    gate.approve('test-site', a.id, { approver: 'Alice', confirmHashPrefix: a.artifactHash.slice(0, 10) });
    expect(() => consumePaidRequestApproval(gate, { ...req, maxChargeMicros: toMicros('5.00') })).toThrow();
    expect(() => consumePaidRequestApproval(gate, { ...req, requestHash: 's'.repeat(64) })).toThrow();
    // A refused attempt for a different cap leaves the approved request usable for the exact one.
    expect(gate.get(a.id)?.status).toBe('approved');
    expect(consumePaidRequestApproval(gate, req)).toBe(a.id);
  });

  it('a budget exception is explicit, bounded, and checkable; nothing is raised automatically', () => {
    const a = requestBudgetException(gate, { siteId: 'test-site', provider: 'apify', period: '2026-09', extraMicros: toMicros('2.50'), reason: 'Synthetic one-off research', requestedBy: 'owner:Alice' });
    expect(checkBudgetException(gate, { siteId: 'test-site', provider: 'apify', period: '2026-09', extraMicros: toMicros('2.50') })).toMatchObject({ ok: false, reason: 'pending' });
    gate.approve('test-site', a.id, { approver: 'Alice', confirmHashPrefix: a.artifactHash.slice(0, 10) });
    expect(checkBudgetException(gate, { siteId: 'test-site', provider: 'apify', period: '2026-09', extraMicros: toMicros('2.50') }).ok).toBe(true);
    // Probing whether the exception covers another amount is a pure query: it never destroys the approved exception.
    expect(checkBudgetException(gate, { siteId: 'test-site', provider: 'apify', period: '2026-09', extraMicros: toMicros('9.00') })).toMatchObject({ ok: false, reason: 'hash_mismatch' });
    expect(gate.get(a.id)?.status).toBe('approved');
    expect(checkBudgetException(gate, { siteId: 'test-site', provider: 'apify', period: '2026-09', extraMicros: toMicros('2.50') }).ok).toBe(true);
    expect(() => requestBudgetException(gate, { siteId: 'test-site', provider: 'apify', period: 'September', extraMicros: 1, reason: 'x', requestedBy: 'owner:a' })).toThrow(/period/);
    expect(() => requestBudgetException(gate, { siteId: 'test-site', provider: 'apify', period: '2026-09', extraMicros: 0, reason: 'x', requestedBy: 'owner:a' })).toThrow(/positive/);
  });
});
