import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { ApprovalService, DEFAULT_APPROVAL_TTL_HOURS } from '../../../src/approvals/service.js';
import type { ApprovalRequestInput } from '../../../src/approvals/types.js';
import { AppError } from '../../../src/core/errors.js';
import { sha256 } from '../../../src/core/hash.js';
import { openDatabase } from '../../../src/database/db.js';

const H1 = sha256('proposal-1');
const H2 = sha256('proposal-2');

function req(overrides: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
  return {
    siteId: 'test-site',
    actionType: 'title_meta_change',
    target: 'https://www.example.test/widgets',
    subjectType: 'experiment',
    subjectId: 'exp_1',
    artifactHash: H1,
    sourceRevision: 'rev-a',
    summary: 'Synthetic: change title',
    requestedBy: 'owner:alice',
    ...overrides,
  };
}

function audit(ctx: TestContext, id: string): string[] {
  return ctx.db.all<{ event_type: string }>(`SELECT event_type FROM audit_events WHERE subject_type = 'approval' AND subject_id = ? ORDER BY id`, [id]).map((r) => r.event_type);
}

describe('ApprovalService', () => {
  let ctx: TestContext;
  let gate: ApprovalService;
  beforeEach(() => {
    ctx = createTestContext();
    gate = new ApprovalService(ctx.db, { clock: ctx.clock });
  });
  afterEach(() => ctx.cleanup());

  const check = (overrides: Partial<{ artifactHash: string; sourceRevision: string | null }> = {}) =>
    gate.check({ siteId: 'test-site', actionType: 'title_meta_change', subjectType: 'experiment', subjectId: 'exp_1', artifactHash: H1, sourceRevision: 'rev-a', ...overrides });

  it('binds site, action, target, subject, hash, revision, requester, and a default expiry', () => {
    const a = gate.request(req());
    expect(a.status).toBe('pending');
    expect(a.artifactHash).toBe(H1);
    expect(a.sourceRevision).toBe('rev-a');
    expect(new Date(a.expiresAt).getTime() - new Date(a.requestedAt).getTime()).toBe(DEFAULT_APPROVAL_TTL_HOURS * 3_600_000);
    expect(check()).toMatchObject({ ok: false, reason: 'pending' });
    // Idempotent for the same exact proposal.
    expect(gate.request(req()).id).toBe(a.id);
  });

  it('approval requires a named human and the typed hash prefix', () => {
    const a = gate.request(req());
    expect(() => gate.approve('test-site', a.id, { approver: 'system', confirmHashPrefix: H1.slice(0, 12) })).toThrow(/reserved for automation/);
    expect(() => gate.approve('test-site', a.id, { approver: 'Alice', confirmHashPrefix: H1.slice(0, 4) })).toThrow(/Confirmation does not match/);
    expect(() => gate.approve('test-site', a.id, { approver: 'Alice', confirmHashPrefix: H2.slice(0, 12) })).toThrow(/Confirmation does not match/);
    const ok = gate.approve('test-site', a.id, { approver: 'Alice', confirmHashPrefix: H1.slice(0, 12) });
    expect(ok.status).toBe('approved');
    expect(ok.approver).toBe('Alice');
    expect(check()).toMatchObject({ ok: true });
    // Cannot approve twice or re-decide.
    expect(() => gate.approve('test-site', a.id, { approver: 'Alice', confirmHashPrefix: H1.slice(0, 12) })).toThrow(/only pending/);
    expect(() => gate.reject('test-site', a.id, { approver: 'Alice', reason: 'x' })).toThrow(/only pending/);
  });

  it('check is a pure query; checkCurrent (the proposal owner) invalidates a live approval for a changed hash; so does a re-request', () => {
    const a = gate.request(req());
    gate.approve('test-site', a.id, { approver: 'Alice', confirmHashPrefix: H1.slice(0, 10) });
    // Probing another hash never destroys the approval.
    expect(check({ artifactHash: H2 })).toMatchObject({ ok: false, reason: 'hash_mismatch' });
    expect(gate.detail('test-site', a.id).status).toBe('approved');
    expect(check()).toMatchObject({ ok: true });
    // The owner knows H2 is the CURRENT proposal: H1's approval is stale.
    const c = gate.checkCurrent({ siteId: 'test-site', actionType: 'title_meta_change', subjectType: 'experiment', subjectId: 'exp_1', artifactHash: H2, sourceRevision: 'rev-a' });
    expect(c).toMatchObject({ ok: false, reason: 'hash_mismatch' });
    const after = gate.detail('test-site', a.id);
    expect(after.status).toBe('invalidated');
    expect(after.invalidatedReason).toMatch(/proposal changed/);
    expect(check()).toMatchObject({ ok: false, reason: 'invalidated' });

    // Re-requesting with a new hash also invalidates the previous live request.
    const b = gate.request(req({ artifactHash: H2 }));
    const c2 = gate.request(req({ artifactHash: H1 }));
    expect(gate.detail('test-site', b.id).status).toBe('invalidated');
    expect(c2.status).toBe('pending');
    expect(audit(ctx, a.id)).toEqual(['approval.requested', 'approval.approved', 'approval.invalidated']);
  });

  it('a changed source revision: check and checkCurrent refuse without side effects; only an explicit stale statement invalidates', () => {
    const a = gate.request(req());
    gate.approve('test-site', a.id, { approver: 'Alice', confirmHashPrefix: H1.slice(0, 10) });
    expect(check({ sourceRevision: null })).toMatchObject({ ok: false, reason: 'revision_mismatch' });
    expect(check({ sourceRevision: 'rev-b' })).toMatchObject({ ok: false, reason: 'revision_mismatch' });
    expect(gate.detail('test-site', a.id).status).toBe('approved');
    const current = (sourceRevision: string | null, invalidateStaleRevision = false) =>
      gate.checkCurrent({ siteId: 'test-site', actionType: 'title_meta_change', subjectType: 'experiment', subjectId: 'exp_1', artifactHash: H1, sourceRevision }, { invalidateStaleRevision, actor: 'owner:Alice' });
    expect(current(null)).toMatchObject({ ok: false, reason: 'revision_mismatch' });
    expect(gate.detail('test-site', a.id).status).toBe('approved');
    expect(current('rev-a')).toMatchObject({ ok: true });
    // An unverified, typed revision (e.g. a typo) never destroys the approval.
    expect(current('rev-a-typo')).toMatchObject({ ok: false, reason: 'revision_mismatch' });
    expect(gate.detail('test-site', a.id).status).toBe('approved');
    expect(audit(ctx, a.id)).not.toContain('approval.invalidated');
    expect(current('rev-a')).toMatchObject({ ok: true });
    // The owner states the site changed: now it is invalidated, with the reason and actor recorded.
    current('rev-b', true);
    const d = gate.detail('test-site', a.id);
    expect(d.status).toBe('invalidated');
    expect(d.invalidatedReason).toMatch(/source revision changed: rev-a -> rev-b \(stated by owner:Alice with --invalidate-stale\)/);
  });

  it('a read-only check computes expiry without writing anything', () => {
    const a = gate.request(req({ ttlHours: 1 }));
    gate.approve('test-site', a.id, { approver: 'Alice', confirmHashPrefix: H1.slice(0, 10) });
    const before = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_events')!.n;
    ctx.clock.advanceMs(2 * 3_600_000);
    expect(gate.check({ siteId: 'test-site', actionType: 'title_meta_change', subjectType: 'experiment', subjectId: 'exp_1', artifactHash: H1, sourceRevision: 'rev-a' }, { readOnly: true })).toMatchObject({ ok: false, reason: 'expired' });
    expect(ctx.db.get<{ status: string }>('SELECT status FROM approvals WHERE id = ?', [a.id])!.status).toBe('approved');
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_events')!.n).toBe(before);
  });

  it('every human decision is also recorded as an owner decision row', () => {
    const a = gate.request(req());
    gate.approve('test-site', a.id, { approver: 'Alice', confirmHashPrefix: H1.slice(0, 10), note: 'looks right' });
    const b = gate.request(req({ subjectId: 'exp_2' }));
    gate.reject('test-site', b.id, { approver: 'Bob', reason: 'wrong page' });
    const rows = ctx.db.all<{ subject_type: string; subject_id: string; decision: string; reason: string | null; decided_by: string; vault_path: string | null }>(
      'SELECT subject_type, subject_id, decision, reason, decided_by, vault_path FROM decisions ORDER BY decided_at, subject_id',
    );
    expect(rows).toEqual([
      { subject_type: 'experiment', subject_id: 'exp_1', decision: 'approved', reason: 'looks right', decided_by: 'owner:Alice', vault_path: null },
      { subject_type: 'experiment', subject_id: 'exp_2', decision: 'rejected', reason: 'wrong page', decided_by: 'owner:Bob', vault_path: null },
    ]);
    // A refused decision (wrong confirmation) records nothing.
    const c = gate.request(req({ subjectId: 'exp_3' }));
    expect(() => gate.approve('test-site', c.id, { approver: 'Alice', confirmHashPrefix: 'deadbeefdead' })).toThrow();
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM decisions WHERE subject_id = 'exp_3'")!.n).toBe(0);
  });

  it('a production approval that is not bound to a source revision needs an explicit acknowledgment; others do not', () => {
    const a = gate.request(req({ sourceRevision: null }));
    expect(() => gate.approve('test-site', a.id, { approver: 'Alice', confirmHashPrefix: H1.slice(0, 10) })).toThrow(/not bound to a source revision/);
    expect(gate.detail('test-site', a.id).status).toBe('pending');
    gate.approve('test-site', a.id, { approver: 'Alice', confirmHashPrefix: H1.slice(0, 10), acknowledgeUnboundRevision: true });
    expect(gate.detail('test-site', a.id).status).toBe('approved');
    // Non-production approvals (spend, learnings, drafts generation) have no source revision to bind.
    const l = gate.request(req({ actionType: 'learning_promotion', subjectType: 'learning', subjectId: 'l1', sourceRevision: null }));
    expect(gate.approve('test-site', l.id, { approver: 'Alice', confirmHashPrefix: H1.slice(0, 10) }).status).toBe('approved');
  });

  it('the confirmation hint never reveals the hash prefix', () => {
    const a = gate.request(req());
    try {
      gate.approve('test-site', a.id, { approver: 'Alice', confirmHashPrefix: '00000000' });
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as AppError).hint ?? '').not.toContain(H1.slice(0, 8));
    }
  });

  it('findLive returns the live approval for the exact binding only', () => {
    const a = gate.request(req());
    const binding = { siteId: 'test-site', actionType: 'title_meta_change' as const, subjectType: 'experiment', subjectId: 'exp_1', artifactHash: H1, sourceRevision: 'rev-a' };
    expect(gate.findLive(binding)?.id).toBe(a.id);
    expect(gate.findLive({ ...binding, sourceRevision: 'rev-b' })).toBeNull();
    expect(gate.findLive({ ...binding, artifactHash: H2 })).toBeNull();
  });

  it('approvals expire (pending and approved) and expired approvals cannot be approved or consumed', () => {
    const a = gate.request(req({ ttlHours: 2 }));
    ctx.clock.advanceMs(3 * 3_600_000);
    expect(() => gate.approve('test-site', a.id, { approver: 'Alice', confirmHashPrefix: H1.slice(0, 10) })).toThrow(/expired/);
    const b = gate.request(req({ ttlHours: 1 }));
    gate.approve('test-site', b.id, { approver: 'Alice', confirmHashPrefix: H1.slice(0, 10) });
    ctx.clock.advanceMs(2 * 3_600_000);
    expect(check()).toMatchObject({ ok: false, reason: 'expired' });
    expect(() => gate.consume(b.id, { kind: 'test' })).toThrow(AppError);
    expect(audit(ctx, b.id)).toContain('approval.expired');
    expect(() => gate.request(req({ ttlHours: 10_000 }))).toThrow(/ttlHours/);
  });

  it('one-time execution: the second consume fails and is audited', () => {
    const a = gate.request(req());
    gate.approve('test-site', a.id, { approver: 'Alice', confirmHashPrefix: H1.slice(0, 10) });
    const done = gate.consume(a.id, { kind: 'test', actor: 'owner:Alice' });
    expect(done.status).toBe('executed');
    expect(done.executedAt).not.toBeNull();
    expect(() => gate.consume(a.id, { kind: 'test' })).toThrow(/already executed/);
    expect(check()).toMatchObject({ ok: false, reason: 'already_executed' });
    expect(audit(ctx, a.id)).toEqual(['approval.requested', 'approval.approved', 'approval.executed', 'approval.consume_refused']);
  });

  it('pending or rejected approvals cannot be consumed', () => {
    const a = gate.request(req());
    expect(() => gate.consume(a.id, {})).toThrow(/status is pending/);
    gate.reject('test-site', a.id, { approver: 'Alice', reason: 'Not now' });
    expect(() => gate.consume(a.id, {})).toThrow(/status is rejected/);
    expect(check()).toMatchObject({ ok: false, reason: 'rejected' });
    expect(() => gate.reject('test-site', gate.request(req({ artifactHash: H2 })).id, { approver: 'Alice', reason: '  ' })).toThrow(/reason is required/);
  });

  it('two connections racing to consume: exactly one wins', () => {
    const a = gate.request(req());
    gate.approve('test-site', a.id, { approver: 'Alice', confirmHashPrefix: H1.slice(0, 10) });
    // Second connection to the same database file.
    const other = openDatabase(ctx.db.file);
    try {
      const gate2 = new ApprovalService(other, { clock: ctx.clock });
      const results = [gate, gate2].map((g) => {
        try {
          g.consume(a.id, { kind: 'race' });
          return 'won';
        } catch {
          return 'lost';
        }
      });
      expect(results.sort()).toEqual(['lost', 'won']);
    } finally {
      other.close();
    }
  });

  it('the database refuses edits of an approval binding or reversal of terminal states', () => {
    const a = gate.request(req());
    gate.approve('test-site', a.id, { approver: 'Alice', confirmHashPrefix: H1.slice(0, 10) });
    expect(() => ctx.db.run('UPDATE approvals SET artifact_hash = ? WHERE id = ?', [H2, a.id])).toThrow(/binding is immutable/);
    expect(() => ctx.db.run('UPDATE approvals SET approver = ? WHERE id = ?', ['Mallory', a.id])).toThrow(/decision is immutable/);
    gate.consume(a.id, {});
    expect(() => ctx.db.run(`UPDATE approvals SET status = 'approved' WHERE id = ?`, [a.id])).toThrow(/invalid approval status transition/);
    expect(() => ctx.db.run(`UPDATE approvals SET execution_json = '{"forged":true}' WHERE id = ?`, [a.id])).toThrow(/execution record is immutable/);
  });

  it('findAuthorizing returns approved or executed approvals for the exact hash only', () => {
    const a = gate.request(req());
    expect(gate.findAuthorizing({ siteId: 'test-site', subjectType: 'experiment', subjectId: 'exp_1', artifactHash: H1 })).toBeNull();
    gate.approve('test-site', a.id, { approver: 'Alice', confirmHashPrefix: H1.slice(0, 10) });
    expect(gate.findAuthorizing({ siteId: 'test-site', subjectType: 'experiment', subjectId: 'exp_1', artifactHash: H1 })?.id).toBe(a.id);
    expect(gate.findAuthorizing({ siteId: 'test-site', subjectType: 'experiment', subjectId: 'exp_1', artifactHash: H2 })).toBeNull();
    gate.consume(a.id, {});
    expect(gate.findAuthorizing({ siteId: 'test-site', subjectType: 'experiment', subjectId: 'exp_1', artifactHash: H1 })?.status).toBe('executed');
  });

  it('approvals are site-scoped', () => {
    const a = gate.request(req());
    expect(() => gate.approve('other-site', a.id, { approver: 'Alice', confirmHashPrefix: H1.slice(0, 10) })).toThrow(/not found/);
    expect(gate.list('other-site')).toHaveLength(0);
  });
  it('model-originated requests are refused and payload prose is stored exactly (secret-named keys masked)', () => {
    expect(() => gate.request(req({ requestedBy: 'llm:reasoning' }))).toThrow(/cannot originate from model output/);
    expect(() => gate.request(req({ requestedBy: 'model' }))).toThrow(/cannot originate from model output/);
    const a = gate.request(req({ payload: { change: { bodyMarkdown: 'Basic principles of synthetic widgets' }, apiKey: 'should-not-be-stored' } }));
    const d = gate.detail('test-site', a.id);
    expect((d.payload as { change: { bodyMarkdown: string } }).change.bodyMarkdown).toBe('Basic principles of synthetic widgets');
    expect((d.payload as { apiKey: string }).apiKey).toBe('[REDACTED]');
  });
});
