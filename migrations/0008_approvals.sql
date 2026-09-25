-- 0008_approvals: human approvals bound to exact proposals.
-- An approval binds website, action type, target, artifact/diff hash, source
-- revision, approver, expiration, and one-time execution state. Changing the
-- proposal (hash or revision) invalidates the approval. Approvals are created
-- only through the CLI approval workflow, never from Markdown frontmatter.

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('draft_generation', 'publish_content', 'update_page', 'title_meta_change', 'redirect', 'merge_pages', 'delete_page', 'canonical_change', 'robots_change', 'analytics_change', 'experiment_start', 'paid_request', 'budget_exception', 'batch_expansion', 'learning_promotion')),
  target TEXT NOT NULL,                      -- URL, content item id, or provider/endpoint
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,               -- hash of the exact proposal/diff
  source_revision TEXT,                      -- site/source revision the proposal was made against
  summary TEXT NOT NULL,
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executed', 'invalidated')),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  approver TEXT,
  decided_at TEXT,
  decision_note TEXT,
  expires_at TEXT NOT NULL,
  executed_at TEXT,
  execution_json TEXT CHECK (execution_json IS NULL OR json_valid(execution_json)),
  invalidated_reason TEXT,
  CHECK (status NOT IN ('approved', 'executed') OR (approver IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status != 'executed' OR executed_at IS NOT NULL)
);
CREATE INDEX idx_approvals_site_status ON approvals (site_id, status);
CREATE INDEX idx_approvals_subject ON approvals (subject_type, subject_id);
-- At most one live (pending/approved) approval per exact proposal.
CREATE UNIQUE INDEX uq_approvals_live ON approvals (site_id, action_type, subject_type, subject_id, artifact_hash) WHERE status IN ('pending', 'approved');
