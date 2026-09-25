-- 0190_experiments_approvals: append-only experiment evaluations and
-- defense-in-depth triggers for approvals and experiment history.
-- Additive only: no existing table or column is altered or dropped.

-- Every evaluation of an experiment is recorded. Re-evaluating never rewrites
-- a past row (UPDATE is blocked), so an outcome can never be quietly replaced
-- by a more favorable later computation. DELETE is allowed only so that site
-- purge/retention (ON DELETE CASCADE) keeps working.
-- GRAIN: one row per evaluation run per experiment.
CREATE TABLE experiment_evaluations (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,                 -- 1, 2, 3 ... per experiment
  evaluated_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('collecting', 'positive', 'negative', 'inconclusive', 'data_unavailable')),
  concluded INTEGER NOT NULL CHECK (concluded IN (0, 1)),          -- 1 = this evaluation set the experiment's terminal status
  after_conclusion INTEGER NOT NULL DEFAULT 0 CHECK (after_conclusion IN (0, 1)),   -- 1 = re-evaluation of an already concluded experiment (informational only)
  reasons_json TEXT NOT NULL CHECK (json_valid(reasons_json)),
  windows_json TEXT CHECK (windows_json IS NULL OR json_valid(windows_json)),
  seo_json TEXT CHECK (seo_json IS NULL OR json_valid(seo_json)),
  conversion_json TEXT CHECK (conversion_json IS NULL OR json_valid(conversion_json)),
  guardrails_json TEXT CHECK (guardrails_json IS NULL OR json_valid(guardrails_json)),
  interference_json TEXT CHECK (interference_json IS NULL OR json_valid(interference_json)),
  significance_json TEXT NOT NULL CHECK (json_valid(significance_json)),
  method TEXT NOT NULL,
  method_version TEXT NOT NULL,
  frozen_versions_json TEXT CHECK (frozen_versions_json IS NULL OR json_valid(frozen_versions_json)),
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  actor TEXT NOT NULL,
  UNIQUE (experiment_id, sequence)
);
CREATE INDEX idx_experiment_evaluations_site ON experiment_evaluations (site_id, evaluated_at);
CREATE TRIGGER experiment_evaluations_no_update BEFORE UPDATE ON experiment_evaluations
BEGIN SELECT RAISE(ABORT, 'experiment_evaluations is append-only'); END;

-- Status history is an append-only event log.
CREATE TRIGGER experiment_status_history_no_update BEFORE UPDATE ON experiment_status_history
BEGIN SELECT RAISE(ABORT, 'experiment_status_history is append-only'); END;

-- An approval's binding can never be edited to match a different proposal.
CREATE TRIGGER approvals_binding_immutable BEFORE UPDATE OF site_id, action_type, target, subject_type, subject_id, artifact_hash, source_revision, requested_by, requested_at ON approvals
WHEN NEW.site_id IS NOT OLD.site_id
  OR NEW.action_type IS NOT OLD.action_type
  OR NEW.target IS NOT OLD.target
  OR NEW.subject_type IS NOT OLD.subject_type
  OR NEW.subject_id IS NOT OLD.subject_id
  OR NEW.artifact_hash IS NOT OLD.artifact_hash
  OR NEW.source_revision IS NOT OLD.source_revision
  OR NEW.requested_by IS NOT OLD.requested_by
  OR NEW.requested_at IS NOT OLD.requested_at
BEGIN SELECT RAISE(ABORT, 'approval binding is immutable; request a new approval instead'); END;

-- Terminal approval states never change; approved can only become executed,
-- expired, or invalidated; pending can only be decided, expire, or be invalidated.
CREATE TRIGGER approvals_status_transitions BEFORE UPDATE OF status ON approvals
WHEN NEW.status IS NOT OLD.status AND NOT (
     (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'expired', 'invalidated'))
  OR (OLD.status = 'approved' AND NEW.status IN ('executed', 'expired', 'invalidated'))
)
BEGIN SELECT RAISE(ABORT, 'invalid approval status transition'); END;

-- Once recorded, the approver and decision time are fixed.
CREATE TRIGGER approvals_decision_immutable BEFORE UPDATE OF approver, decided_at ON approvals
WHEN (OLD.approver IS NOT NULL AND NEW.approver IS NOT OLD.approver)
  OR (OLD.decided_at IS NOT NULL AND NEW.decided_at IS NOT OLD.decided_at)
BEGIN SELECT RAISE(ABORT, 'approval decision is immutable'); END;

-- Once executed, the execution record is fixed.
CREATE TRIGGER approvals_execution_immutable BEFORE UPDATE OF executed_at, execution_json ON approvals
WHEN OLD.executed_at IS NOT NULL AND (NEW.executed_at IS NOT OLD.executed_at OR NEW.execution_json IS NOT OLD.execution_json)
BEGIN SELECT RAISE(ABORT, 'approval execution record is immutable'); END;

-- The exact, structured proposed change of an experiment. experiments.change_hash
-- is the artifact hash of this row's (action_type, target_url, change_json), the
-- same hash an approval must bind. The change is immutable: a different change
-- is a different experiment (and needs a new approval).
CREATE TABLE experiment_changes (
  experiment_id TEXT PRIMARY KEY REFERENCES experiments(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  target_url TEXT NOT NULL,
  change_json TEXT NOT NULL CHECK (json_valid(change_json)),
  change_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_experiment_changes_hash ON experiment_changes (site_id, change_hash);
CREATE TRIGGER experiment_changes_no_update BEFORE UPDATE ON experiment_changes
BEGIN SELECT RAISE(ABORT, 'experiment_changes is immutable; propose a new experiment instead'); END;
