-- 0191_experiments_append_only: complete the append-only guarantees of 0190
-- and bind one publication to one approval. Additive only: triggers, no
-- table or column is altered.

-- Experiment history rows can no longer be deleted one by one (e.g. to drop an
-- unfavorable evaluation). They are removed only together with their parent:
-- when the experiment or the whole site is deleted, ON DELETE CASCADE runs
-- after the parent row is gone, so the WHEN clause is false and the cascade
-- proceeds. Site purge and experiment deletion therefore keep working.
CREATE TRIGGER experiment_evaluations_no_delete BEFORE DELETE ON experiment_evaluations
WHEN EXISTS (SELECT 1 FROM experiments WHERE id = OLD.experiment_id) AND EXISTS (SELECT 1 FROM sites WHERE id = OLD.site_id)
BEGIN SELECT RAISE(ABORT, 'experiment_evaluations is append-only; rows are removed only with their experiment or site'); END;

CREATE TRIGGER experiment_status_history_no_delete BEFORE DELETE ON experiment_status_history
WHEN EXISTS (SELECT 1 FROM experiments WHERE id = OLD.experiment_id) AND EXISTS (SELECT 1 FROM sites WHERE id = OLD.site_id)
BEGIN SELECT RAISE(ABORT, 'experiment_status_history is append-only; rows are removed only with their experiment or site'); END;

CREATE TRIGGER experiment_changes_no_delete BEFORE DELETE ON experiment_changes
WHEN EXISTS (SELECT 1 FROM experiments WHERE id = OLD.experiment_id) AND EXISTS (SELECT 1 FROM sites WHERE id = OLD.site_id)
BEGIN SELECT RAISE(ABORT, 'experiment_changes is immutable; rows are removed only with their experiment or site'); END;

-- Measurements keep the FIRST recorded values per (experiment, window,
-- period, method version). Later evaluations report revised source data in
-- their own (append-only) evaluation rows instead of rewriting these.
CREATE TRIGGER experiment_measurements_no_update BEFORE UPDATE ON experiment_measurements
BEGIN SELECT RAISE(ABORT, 'experiment_measurements is append-only'); END;

CREATE TRIGGER experiment_measurements_no_delete BEFORE DELETE ON experiment_measurements
WHEN EXISTS (SELECT 1 FROM experiments WHERE id = OLD.experiment_id) AND EXISTS (SELECT 1 FROM sites WHERE id = OLD.site_id)
BEGIN SELECT RAISE(ABORT, 'experiment_measurements is append-only; rows are removed only with their experiment or site'); END;

-- One approval authorizes exactly one recorded implementation. A trigger
-- (instead of a UNIQUE index) so that the migration itself can never fail on
-- a workspace that already holds duplicate rows; new duplicates are refused.
CREATE TRIGGER publications_one_per_approval BEFORE INSERT ON publications
WHEN NEW.approval_id IS NOT NULL AND EXISTS (SELECT 1 FROM publications WHERE approval_id = NEW.approval_id)
BEGIN SELECT RAISE(ABORT, 'this approval already authorized a publication; one approval authorizes one implementation'); END;
