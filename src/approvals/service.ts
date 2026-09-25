import { systemClock, type Clock } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { recordAudit } from '../database/audit.js';
import { parseJson, type Db } from '../database/db.js';
import { risksStated } from '../experiments/repository.js';
import { isSecretKey, REDACTED, redact } from '../security/redact.js';
import { validateApproverName, ownerActor } from './approver.js';
import { hashPrefix, shortRef } from './artifact.js';
import { isProductionActionType } from './policy.js';
import type { ApprovalActionType, ApprovalCheck, ApprovalGate, ApprovalRecord, ApprovalRequestInput, ApprovalStatus } from './types.js';

/**
 * SQLite-backed approval service (implements ApprovalGate).
 *
 * Binding: site, action type, target, subject, artifact/diff hash, source
 * revision, approver, expiration, one-time execution. Invariants:
 * - Approvals are only ever decided by `approve`/`reject`, which require a
 *   named human and a typed confirmation of the artifact hash prefix. The CLI
 *   (`approvals approve|reject`) is the only caller. Markdown, model output,
 *   or scraped text is never read here.
 * - A new request for the same subject/action with a different artifact hash
 *   invalidates any live approval for the old proposal.
 * - `check` is a pure query (apart from lazy, time-based expiry, which
 *   `readOnly` computes without writing): probing a different hash or
 *   revision never destroys an approval. Owners of a proposal whose CURRENT
 *   hash they know (export) call `checkCurrent`, which first invalidates live
 *   approvals for any other hash (verified evidence), with the reason
 *   recorded. A differing, unverified source revision is only refused, unless
 *   the owner explicitly states it is stale (`invalidateStaleRevision`).
 * - Every approve/reject also writes an owner decision row (`decisions`).
 * - A production approval that is not bound to a source revision can only be
 *   approved when the approver explicitly acknowledges that
 *   (`acknowledgeUnboundRevision`, CLI `--accept-unbound-revision`).
 * - An experiment whose risks are not stated (empty, or the placeholder
 *   earlier versions stored) cannot be approved (spec 23): it is rejected and
 *   proposed again with `--risks`.
 * - `consume` is an atomic `approved -> executed` transition inside a
 *   `BEGIN IMMEDIATE` transaction guarded by `WHERE status = 'approved'`, so
 *   only one execution can ever win, even across processes.
 * - Every transition is written to the append-only audit log.
 * - Migration 0190 adds triggers that make the binding, decision, execution,
 *   and terminal states immutable at the database level as well.
 */

export const DEFAULT_APPROVAL_TTL_HOURS = 168; // 7 days
export const MAX_APPROVAL_TTL_HOURS = 720; // 30 days
export const MIN_CONFIRM_PREFIX_LENGTH = 8;

export const APPROVAL_ACTION_TYPES: readonly ApprovalActionType[] = [
  'draft_generation',
  'publish_content',
  'update_page',
  'title_meta_change',
  'redirect',
  'merge_pages',
  'delete_page',
  'canonical_change',
  'robots_change',
  'analytics_change',
  'experiment_start',
  'paid_request',
  'budget_exception',
  'batch_expansion',
  'learning_promotion',
];

export const APPROVAL_STATUSES: readonly ApprovalStatus[] = ['pending', 'approved', 'rejected', 'expired', 'executed', 'invalidated'];

interface ApprovalRow {
  id: string;
  site_id: string;
  action_type: ApprovalActionType;
  target: string;
  subject_type: string;
  subject_id: string;
  artifact_hash: string;
  source_revision: string | null;
  summary: string;
  payload_json: string | null;
  status: ApprovalStatus;
  requested_by: string;
  requested_at: string;
  approver: string | null;
  decided_at: string | null;
  decision_note: string | null;
  expires_at: string;
  executed_at: string | null;
  execution_json: string | null;
  invalidated_reason: string | null;
}

export interface ApprovalDetail extends ApprovalRecord {
  payload: Record<string, unknown> | null;
  decisionNote: string | null;
  invalidatedReason: string | null;
  execution: Record<string, unknown> | null;
  hashPrefix: string;
}

export interface ApprovalServiceOptions {
  clock?: Clock;
  defaultTtlHours?: number;
}

export interface CheckInput {
  siteId: string;
  actionType: ApprovalActionType;
  subjectType: string;
  subjectId: string;
  artifactHash: string;
  sourceRevision?: string | null;
}

/**
 * Mask values under secret-named keys without rewriting ordinary text. The
 * approval payload is what a human reviews, so prose must stay exact; the
 * artifact hash is always computed from the unmodified proposal.
 */
function maskSecretKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecretKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = isSecretKey(k) && v !== null && v !== undefined && v !== '' ? REDACTED : maskSecretKeys(v);
    return out;
  }
  return value;
}

/** Automated model output may never request (let alone decide) an approval. */
const MODEL_REQUESTER = /^(llm|model|assistant|ai|gpt|claude)(\b|:|$)/i;

function toRecord(r: ApprovalRow): ApprovalRecord {
  return {
    id: r.id,
    siteId: r.site_id,
    actionType: r.action_type,
    target: r.target,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    artifactHash: r.artifact_hash,
    sourceRevision: r.source_revision,
    summary: r.summary,
    status: r.status,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at,
    approver: r.approver,
    decidedAt: r.decided_at,
    expiresAt: r.expires_at,
    executedAt: r.executed_at,
  };
}

function toDetail(r: ApprovalRow): ApprovalDetail {
  return {
    ...toRecord(r),
    payload: parseJson<Record<string, unknown> | null>(r.payload_json, null),
    decisionNote: r.decision_note,
    invalidatedReason: r.invalidated_reason,
    execution: parseJson<Record<string, unknown> | null>(r.execution_json, null),
    hashPrefix: hashPrefix(r.artifact_hash),
  };
}

const LIVE = `status IN ('pending', 'approved')`;

export class ApprovalService implements ApprovalGate {
  private readonly clock: Clock;
  private readonly defaultTtlHours: number;

  constructor(
    private readonly db: Db,
    opts: ApprovalServiceOptions = {},
  ) {
    this.clock = opts.clock ?? systemClock;
    this.defaultTtlHours = opts.defaultTtlHours ?? DEFAULT_APPROVAL_TTL_HOURS;
    if (!(this.defaultTtlHours > 0 && this.defaultTtlHours <= MAX_APPROVAL_TTL_HOURS)) throw new RangeError(`defaultTtlHours must be in (0, ${MAX_APPROVAL_TTL_HOURS}]`);
  }

  private nowIso(): string {
    return this.clock.now().toISOString();
  }

  private row(id: string): ApprovalRow | undefined {
    return this.db.get<ApprovalRow>('SELECT * FROM approvals WHERE id = ?', [id]);
  }

  private audit(siteId: string, actor: string, eventType: string, approvalId: string, details: Record<string, unknown>): void {
    recordAudit(this.db, { siteId, actor, eventType, subjectType: 'approval', subjectId: approvalId, details, at: this.clock.now() });
  }

  // ---------------------------------------------------------------- reads

  get(id: string): ApprovalRecord | null {
    const r = this.row(id);
    return r ? toRecord(r) : null;
  }

  /** Full record including payload/execution, scoped to a site. */
  detail(siteId: string, id: string): ApprovalDetail {
    this.expireStale(siteId);
    const r = this.row(id);
    if (!r || r.site_id !== siteId) throw new AppError('NOT_FOUND', `Approval ${id} not found for site ${siteId}.`);
    return toDetail(r);
  }

  list(siteId: string, opts: { statuses?: readonly ApprovalStatus[]; subjectType?: string; subjectId?: string; limit?: number } = {}): ApprovalDetail[] {
    this.expireStale(siteId);
    const where = ['site_id = ?'];
    const params: unknown[] = [siteId];
    if (opts.statuses?.length) {
      where.push(`status IN (${opts.statuses.map(() => '?').join(', ')})`);
      params.push(...opts.statuses);
    }
    if (opts.subjectType) {
      where.push('subject_type = ?');
      params.push(opts.subjectType);
    }
    if (opts.subjectId) {
      where.push('subject_id = ?');
      params.push(opts.subjectId);
    }
    params.push(opts.limit ?? 200);
    return this.db.all<ApprovalRow>(`SELECT * FROM approvals WHERE ${where.join(' AND ')} ORDER BY requested_at DESC, id DESC LIMIT ?`, params).map(toDetail);
  }

  /** Audit history of one approval (oldest first). */
  history(siteId: string, id: string): Array<{ at: string; actor: string; eventType: string; details: unknown }> {
    return this.db
      .all<{ at: string; actor: string; event_type: string; details_json: string | null }>(
        `SELECT at, actor, event_type, details_json FROM audit_events WHERE site_id = ? AND subject_type = 'approval' AND subject_id = ? ORDER BY id`,
        [siteId, id],
      )
      .map((e) => ({ at: e.at, actor: e.actor, eventType: e.event_type, details: parseJson(e.details_json, null) }));
  }

  // --------------------------------------------------------------- request

  request(input: ApprovalRequestInput): ApprovalRecord {
    if (!input.siteId) throw new AppError('VALIDATION_FAILED', 'Approval request needs a site id.');
    if (!APPROVAL_ACTION_TYPES.includes(input.actionType)) throw new AppError('VALIDATION_FAILED', `Unknown approval action type "${String(input.actionType)}".`);
    for (const [k, v] of [
      ['target', input.target],
      ['subjectType', input.subjectType],
      ['subjectId', input.subjectId],
      ['artifactHash', input.artifactHash],
      ['summary', input.summary],
      ['requestedBy', input.requestedBy],
    ] as const) {
      if (typeof v !== 'string' || !v.trim()) throw new AppError('VALIDATION_FAILED', `Approval request field "${k}" is required.`);
    }
    if (!/^[0-9a-f]{16,128}$/.test(input.artifactHash)) throw new AppError('VALIDATION_FAILED', 'artifactHash must be a lowercase hex digest of the exact proposal.');
    if (MODEL_REQUESTER.test(input.requestedBy.trim())) throw new AppError('POLICY_DENIED', 'Approval requests cannot originate from model output; runtime LLM tools never expose approval creation.');
    const ttl = input.ttlHours ?? this.defaultTtlHours;
    if (!(ttl > 0 && ttl <= MAX_APPROVAL_TTL_HOURS)) throw new AppError('VALIDATION_FAILED', `ttlHours must be greater than 0 and at most ${MAX_APPROVAL_TTL_HOURS}.`);
    const revision = input.sourceRevision ?? null;

    this.expireStale(input.siteId);
    return this.db.transaction(() => {
      const now = this.clock.now();
      const same = this.db.all<ApprovalRow>(
        `SELECT * FROM approvals WHERE site_id = ? AND action_type = ? AND subject_type = ? AND subject_id = ? AND ${LIVE} ORDER BY requested_at DESC`,
        [input.siteId, input.actionType, input.subjectType, input.subjectId],
      );
      for (const r of same) {
        if (r.artifact_hash === input.artifactHash && r.source_revision === revision) return toRecord(r); // idempotent
        const reason =
          r.artifact_hash !== input.artifactHash
            ? `proposal changed: artifact hash ${shortRef(r.artifact_hash)} -> ${shortRef(input.artifactHash)}`
            : `source revision changed: ${r.source_revision ?? '(none)'} -> ${revision ?? '(none)'}`;
        this.invalidateRow(r, reason, 'system');
      }
      const id = newId('apr');
      const expiresAt = new Date(now.getTime() + Math.round(ttl * 3_600_000)).toISOString();
      this.db.run(
        `INSERT INTO approvals (id, site_id, action_type, target, subject_type, subject_id, artifact_hash, source_revision, summary, payload_json,
           status, requested_by, requested_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [
          id,
          input.siteId,
          input.actionType,
          input.target,
          input.subjectType,
          input.subjectId,
          input.artifactHash,
          revision,
          input.summary,
          input.payload ? JSON.stringify(maskSecretKeys(input.payload)) : null,
          input.requestedBy,
          now.toISOString(),
          expiresAt,
        ],
      );
      this.audit(input.siteId, input.requestedBy, 'approval.requested', id, {
        actionType: input.actionType,
        target: input.target,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        artifactHash: input.artifactHash,
        sourceRevision: revision,
        expiresAt,
      });
      return toRecord(this.row(id)!);
    });
  }

  // -------------------------------------------------------------- decisions

  /**
   * Approve a pending request. Requires a named human (validated) and the
   * typed artifact-hash prefix (at least 8 hex characters) as confirmation
   * that the approver saw the exact proposal.
   */
  approve(siteId: string, id: string, input: { approver: string; confirmHashPrefix: string; note?: string | null; acknowledgeUnboundRevision?: boolean }): ApprovalRecord {
    const approver = validateApproverName(input.approver);
    const prefix = (input.confirmHashPrefix ?? '').trim().toLowerCase();
    this.expireStale(siteId);
    return this.db.transaction(() => {
      const r = this.row(id);
      if (!r || r.site_id !== siteId) throw new AppError('NOT_FOUND', `Approval ${id} not found for site ${siteId}.`);
      if (r.status !== 'pending') {
        throw new AppError('APPROVAL_INVALID', `Approval ${id} is ${r.status}; only pending approvals can be approved.`, {
          details: { status: r.status, invalidatedReason: r.invalidated_reason },
          hint: r.status === 'expired' || r.status === 'invalidated' ? 'Request a new approval for the current proposal.' : undefined,
        });
      }
      if (prefix.length < MIN_CONFIRM_PREFIX_LENGTH || !/^[0-9a-f]+$/.test(prefix) || !r.artifact_hash.startsWith(prefix)) {
        throw new AppError('VALIDATION_FAILED', `Confirmation does not match the artifact hash of approval ${id}.`, {
          hint: `Review the exact proposal with \`approvals show ${id}\` and pass --confirm with at least the first ${MIN_CONFIRM_PREFIX_LENGTH} characters of the artifact hash printed there.`,
        });
      }
      const unbound = r.source_revision === null && isProductionActionType(r.action_type);
      if (unbound && input.acknowledgeUnboundRevision !== true) {
        throw new AppError('VALIDATION_FAILED', `Approval ${id} is not bound to a source revision: a later change of the site would not invalidate it.`, {
          details: { approvalId: id, sourceRevision: null },
          hint: `Either re-request it bound to the current revision (\`approvals request ${r.subject_type} ${r.subject_id} --revision <rev>\`), or approve it knowingly with --accept-unbound-revision (recorded).`,
        });
      }
      if (r.subject_type === 'experiment') {
        const exp = this.db.get<{ risks: string | null }>('SELECT risks FROM experiments WHERE site_id = ? AND id = ?', [siteId, r.subject_id]);
        if (exp && !risksStated(exp.risks)) {
          throw new AppError('VALIDATION_FAILED', `Not approved: experiment ${r.subject_id} states no risks. An experiment is approved only with its risks stated.`, {
            details: { approvalId: id, experimentId: r.subject_id, reason: 'risks_not_stated' },
            hint: `Reject it (\`approvals reject ${id} --reason "risks not stated"\`, which cancels the proposed experiment) and propose it again with \`experiments propose --recommendation <id> --risks "<what could go wrong>"\`.`,
          });
        }
      }
      const at = this.nowIso();
      this.db.run(`UPDATE approvals SET status = 'approved', approver = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'pending'`, [approver, at, input.note ?? null, id]);
      this.recordDecision(r, 'approved', input.note ?? null, approver, at);
      this.audit(siteId, ownerActor(approver), 'approval.approved', id, {
        actionType: r.action_type,
        target: r.target,
        subjectType: r.subject_type,
        subjectId: r.subject_id,
        artifactHash: r.artifact_hash,
        sourceRevision: r.source_revision,
        ...(unbound ? { unboundRevisionAcknowledged: true } : {}),
        expiresAt: r.expires_at,
        note: input.note ?? null,
      });
      return toRecord(this.row(id)!);
    });
  }

  reject(siteId: string, id: string, input: { approver: string; reason: string }): ApprovalRecord {
    const approver = validateApproverName(input.approver);
    const reason = (input.reason ?? '').trim();
    if (!reason) throw new AppError('VALIDATION_FAILED', 'A rejection reason is required (--reason).');
    this.expireStale(siteId);
    return this.db.transaction(() => {
      const r = this.row(id);
      if (!r || r.site_id !== siteId) throw new AppError('NOT_FOUND', `Approval ${id} not found for site ${siteId}.`);
      if (r.status !== 'pending') throw new AppError('APPROVAL_INVALID', `Approval ${id} is ${r.status}; only pending approvals can be rejected.`, { details: { status: r.status } });
      const at = this.nowIso();
      this.db.run(`UPDATE approvals SET status = 'rejected', approver = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'pending'`, [approver, at, reason, id]);
      this.recordDecision(r, 'rejected', reason, approver, at);
      this.audit(siteId, ownerActor(approver), 'approval.rejected', id, { actionType: r.action_type, target: r.target, subjectType: r.subject_type, subjectId: r.subject_id, reason });
      return toRecord(this.row(id)!);
    });
  }

  /**
   * Every human decision is also an owner decision record (`decisions`), in the
   * same transaction as the approval: it is what the vault's 12 Decisions notes,
   * page/experiment decision links, and decision memory present. The row
   * records the decision; it never authorizes anything (approvals do).
   * vault_path stays NULL: the decision note is generated from this row, it is
   * not a human-maintained source note.
   */
  private recordDecision(r: ApprovalRow, decision: 'approved' | 'rejected', reason: string | null, approver: string, at: string): void {
    this.db.run('INSERT INTO decisions (id, site_id, subject_type, subject_id, decision, reason, decided_by, decided_at, vault_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)', [
      newId('dec'),
      r.site_id,
      r.subject_type,
      r.subject_id,
      decision,
      reason,
      ownerActor(approver),
      at,
    ]);
  }

  // ----------------------------------------------------------- invalidation

  private invalidateRow(r: ApprovalRow, reason: string, actor: string): void {
    const changed = this.db.run(`UPDATE approvals SET status = 'invalidated', invalidated_reason = ? WHERE id = ? AND ${LIVE}`, [reason, r.id]).changes;
    if (changed) this.audit(r.site_id, actor, 'approval.invalidated', r.id, { reason, previousStatus: r.status, artifactHash: r.artifact_hash, sourceRevision: r.source_revision });
  }

  /** Invalidate one live approval (e.g. the target changed before execution). */
  invalidate(siteId: string, id: string, reason: string, actor = 'system'): ApprovalRecord {
    return this.db.transaction(() => {
      const r = this.row(id);
      if (!r || r.site_id !== siteId) throw new AppError('NOT_FOUND', `Approval ${id} not found for site ${siteId}.`);
      this.invalidateRow(r, reason, actor);
      return toRecord(this.row(id)!);
    });
  }

  /**
   * Invalidate every live approval for a subject whose proposal changed.
   * `exceptHash` keeps approvals for the still-current proposal.
   */
  invalidateSubject(siteId: string, subjectType: string, subjectId: string, reason: string, opts: { exceptHash?: string; actionType?: ApprovalActionType; actor?: string } = {}): number {
    return this.db.transaction(() => {
      const rows = this.db.all<ApprovalRow>(
        `SELECT * FROM approvals WHERE site_id = ? AND subject_type = ? AND subject_id = ? AND ${LIVE}${opts.actionType ? ' AND action_type = ?' : ''}`,
        opts.actionType ? [siteId, subjectType, subjectId, opts.actionType] : [siteId, subjectType, subjectId],
      );
      let n = 0;
      for (const r of rows) {
        if (opts.exceptHash && r.artifact_hash === opts.exceptHash) continue;
        this.invalidateRow(r, reason, opts.actor ?? 'system');
        n++;
      }
      return n;
    });
  }

  /** Mark live approvals past their expiry as expired (audited). Returns the count. */
  expireStale(siteId?: string): number {
    const now = this.nowIso();
    const rows = this.db.all<ApprovalRow>(
      `SELECT * FROM approvals WHERE ${LIVE} AND expires_at <= ?${siteId ? ' AND site_id = ?' : ''}`,
      siteId ? [now, siteId] : [now],
    );
    if (!rows.length) return 0;
    return this.db.transaction(() => {
      let n = 0;
      for (const r of rows) {
        const changed = this.db.run(`UPDATE approvals SET status = 'expired' WHERE id = ? AND ${LIVE} AND expires_at <= ?`, [r.id, now]).changes;
        if (changed) {
          this.audit(r.site_id, 'system', 'approval.expired', r.id, { previousStatus: r.status, expiresAt: r.expires_at });
          n++;
        }
      }
      return n;
    });
  }

  // ------------------------------------------------------------------ check

  /**
   * Is there a valid, unexpired, unexecuted approval for exactly this
   * proposal? A pure query: it never invalidates anything (only lazy,
   * time-based expiry is applied), so callers may probe freely, e.g. whether
   * a budget exception covers a different amount.
   */
  check(input: CheckInput, opts: { readOnly?: boolean } = {}): ApprovalCheck {
    // readOnly (dry runs): lazy expiry is computed, never written.
    if (!opts.readOnly) this.expireStale(input.siteId);
    const now = this.nowIso();
    const rows = this.db
      .all<ApprovalRow>(`SELECT * FROM approvals WHERE site_id = ? AND action_type = ? AND subject_type = ? AND subject_id = ? ORDER BY requested_at DESC, id DESC`, [
        input.siteId,
        input.actionType,
        input.subjectType,
        input.subjectId,
      ])
      .map((r) => (opts.readOnly && (r.status === 'pending' || r.status === 'approved') && r.expires_at <= now ? { ...r, status: 'expired' as const } : r));
    if (!rows.length) return { ok: false, reason: 'none' };
    const exact = rows.filter((r) => r.artifact_hash === input.artifactHash);
    if (!exact.length) return { ok: false, reason: 'hash_mismatch', approval: toRecord(rows[0]!) };
    const approved = exact.find((r) => r.status === 'approved');
    if (approved) {
      if (approved.source_revision !== null) {
        const given = input.sourceRevision;
        if (given === undefined || given === null || given === '' || given !== approved.source_revision) {
          return { ok: false, reason: 'revision_mismatch', approval: toRecord(approved) };
        }
      }
      return { ok: true, approval: toRecord(approved) };
    }
    const latest = exact[0]!;
    const reason = (
      {
        pending: 'pending',
        rejected: 'rejected',
        expired: 'expired',
        executed: 'already_executed',
        invalidated: 'invalidated',
        approved: 'pending', // unreachable
      } as const
    )[latest.status];
    return { ok: false, reason, approval: toRecord(latest) };
  }

  /**
   * For the OWNER of a proposal that knows its current artifact hash, e.g. the
   * export: live approvals for any other hash are stale (the proposal changed:
   * verified evidence, computed from the current proposal) and are invalidated
   * with the reason recorded; then `check`.
   *
   * A supplied source revision that differs from the bound one is NOT verified
   * evidence (it is typed by a human and checked against nothing), so by default
   * it is refused (`revision_mismatch`) without touching the approval. Only
   * `invalidateStaleRevision` (CLI `export --invalidate-stale`, the owner
   * stating the site really changed) invalidates it.
   */
  checkCurrent(input: CheckInput, opts: { invalidateStaleRevision?: boolean; actor?: string } = {}): ApprovalCheck {
    this.expireStale(input.siteId);
    this.db.transaction(() => {
      const live = this.db.all<ApprovalRow>(
        `SELECT * FROM approvals WHERE site_id = ? AND action_type = ? AND subject_type = ? AND subject_id = ? AND ${LIVE}`,
        [input.siteId, input.actionType, input.subjectType, input.subjectId],
      );
      const given = input.sourceRevision ?? null;
      for (const r of live) {
        if (r.artifact_hash !== input.artifactHash) {
          this.invalidateRow(r, `proposal changed: artifact hash ${shortRef(r.artifact_hash)} -> ${shortRef(input.artifactHash)}`, 'system');
        } else if (opts.invalidateStaleRevision && r.source_revision !== null && given !== null && given !== '' && given !== r.source_revision) {
          this.invalidateRow(r, `source revision changed: ${r.source_revision} -> ${given} (stated by ${opts.actor ?? 'the owner'} with --invalidate-stale)`, opts.actor ?? 'system');
        }
      }
    });
    return this.check(input);
  }

  /** The live (pending/approved) approval for exactly this binding, if any. */
  findLive(input: CheckInput): ApprovalDetail | null {
    this.expireStale(input.siteId);
    const r = this.db.get<ApprovalRow>(
      `SELECT * FROM approvals WHERE site_id = ? AND action_type = ? AND subject_type = ? AND subject_id = ? AND artifact_hash = ? AND ${LIVE}
         AND source_revision IS ? ORDER BY requested_at DESC LIMIT 1`,
      [input.siteId, input.actionType, input.subjectType, input.subjectId, input.artifactHash, input.sourceRevision ?? null],
    );
    return r ? toDetail(r) : null;
  }

  // ---------------------------------------------------------------- consume

  /**
   * One-time execution: atomically move `approved -> executed`. A second call,
   * or a concurrent call from another process, fails with APPROVAL_INVALID.
   */
  consume(approvalId: string, execution: Record<string, unknown>): ApprovalRecord {
    const r0 = this.row(approvalId);
    if (!r0) throw new AppError('NOT_FOUND', `Approval ${approvalId} not found.`);
    this.expireStale(r0.site_id);
    let won = false;
    const result = this.db.transaction(() => {
      const at = this.nowIso();
      const changed = this.db.run(
        `UPDATE approvals SET status = 'executed', executed_at = ?, execution_json = ? WHERE id = ? AND status = 'approved' AND expires_at > ?`,
        [at, JSON.stringify(redact(execution)), approvalId, at],
      ).changes;
      const r = this.row(approvalId)!;
      if (changed === 1) {
        won = true;
        this.audit(r.site_id, typeof execution.actor === 'string' ? execution.actor : 'system', 'approval.executed', approvalId, {
          actionType: r.action_type,
          target: r.target,
          artifactHash: r.artifact_hash,
          execution,
        });
      }
      return r;
    });
    if (!won) {
      recordAudit(this.db, {
        siteId: result.site_id,
        actor: typeof execution.actor === 'string' ? execution.actor : 'system',
        eventType: 'approval.consume_refused',
        subjectType: 'approval',
        subjectId: approvalId,
        details: { status: result.status },
        at: this.clock.now(),
      });
      const reason = result.status === 'executed' ? 'already executed (one-time approval)' : `status is ${result.status}`;
      throw new AppError('APPROVAL_INVALID', `Approval ${approvalId} cannot be executed: ${reason}.`, {
        details: { status: result.status },
        hint: 'Request and approve a new approval for the exact current proposal.',
      });
    }
    return toRecord(result);
  }

  /**
   * Check the exact binding (pure) and consume. `consume` is atomic on its own
   * (guarded by `status = 'approved'`) and the binding columns are immutable,
   * so a concurrent change between the two steps cannot be exploited.
   */
  consumeFor(input: CheckInput, execution: Record<string, unknown>): ApprovalRecord {
    const c = this.check(input);
    if (!c.ok) {
      throw new AppError(c.reason === 'none' ? 'APPROVAL_REQUIRED' : 'APPROVAL_INVALID', `No valid approval for this exact proposal (${c.reason}).`, {
        details: { reason: c.reason, ...(c.approval ? { approvalId: c.approval.id } : {}) },
      });
    }
    return this.consume(c.approval.id, execution);
  }

  /**
   * The approval (approved or already executed) that authorized exactly this
   * artifact, if any. Used by mark-implemented; an expired, never-executed
   * approval does not count.
   */
  findAuthorizing(input: { siteId: string; subjectType: string; subjectId: string; artifactHash: string; actionType?: ApprovalActionType }): ApprovalDetail | null {
    this.expireStale(input.siteId);
    const r = this.db.get<ApprovalRow>(
      `SELECT * FROM approvals WHERE site_id = ? AND subject_type = ? AND subject_id = ? AND artifact_hash = ? AND status IN ('approved', 'executed')
       ${input.actionType ? 'AND action_type = ?' : ''} ORDER BY COALESCE(executed_at, decided_at) DESC LIMIT 1`,
      input.actionType ? [input.siteId, input.subjectType, input.subjectId, input.artifactHash, input.actionType] : [input.siteId, input.subjectType, input.subjectId, input.artifactHash],
    );
    return r ? toDetail(r) : null;
  }

  /** Latest approval for a subject (any status), for diagnostics. */
  latestForSubject(siteId: string, subjectType: string, subjectId: string): ApprovalDetail | null {
    this.expireStale(siteId);
    const r = this.db.get<ApprovalRow>(`SELECT * FROM approvals WHERE site_id = ? AND subject_type = ? AND subject_id = ? ORDER BY requested_at DESC, id DESC LIMIT 1`, [siteId, subjectType, subjectId]);
    return r ? toDetail(r) : null;
  }
}
