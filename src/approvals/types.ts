/**
 * Approval contract (implemented in src/approvals/service.ts).
 *
 * Approvals are created and decided only through the CLI approval workflow
 * and stored in SQLite. Markdown frontmatter such as `approved: true`, model
 * output, or scraped text can never create or satisfy an approval.
 */

export type ApprovalActionType =
  | 'draft_generation'
  | 'publish_content'
  | 'update_page'
  | 'title_meta_change'
  | 'redirect'
  | 'merge_pages'
  | 'delete_page'
  | 'canonical_change'
  | 'robots_change'
  | 'analytics_change'
  | 'experiment_start'
  | 'paid_request'
  | 'budget_exception'
  | 'batch_expansion'
  | 'learning_promotion';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'executed' | 'invalidated';

export interface ApprovalRecord {
  id: string;
  siteId: string;
  actionType: ApprovalActionType;
  target: string;
  subjectType: string;
  subjectId: string;
  artifactHash: string;
  sourceRevision: string | null;
  summary: string;
  status: ApprovalStatus;
  requestedBy: string;
  requestedAt: string;
  approver: string | null;
  decidedAt: string | null;
  expiresAt: string;
  executedAt: string | null;
}

export interface ApprovalRequestInput {
  siteId: string;
  actionType: ApprovalActionType;
  target: string;
  subjectType: string;
  subjectId: string;
  /** Hash of the exact proposal/diff; any change requires a new approval. */
  artifactHash: string;
  sourceRevision?: string | null;
  summary: string;
  payload?: Record<string, unknown>;
  requestedBy: string;
  /** Default expiry applied by the service when omitted. */
  ttlHours?: number;
}

export type ApprovalCheck =
  | { ok: true; approval: ApprovalRecord }
  | { ok: false; reason: 'none' | 'pending' | 'rejected' | 'expired' | 'already_executed' | 'hash_mismatch' | 'revision_mismatch' | 'invalidated'; approval?: ApprovalRecord };

export interface ApprovalGate {
  /** Create (or return the existing live) pending approval request for an exact proposal. */
  request(input: ApprovalRequestInput): ApprovalRecord;
  /** Check that a valid, unexpired, unexecuted approval exists for exactly this proposal. */
  check(input: { siteId: string; actionType: ApprovalActionType; subjectType: string; subjectId: string; artifactHash: string; sourceRevision?: string | null }): ApprovalCheck;
  /** Atomically mark a valid approval executed (one-time). Throws if not valid. */
  consume(approvalId: string, execution: Record<string, unknown>): ApprovalRecord;
}
