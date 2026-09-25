-- 0180_jobs_scheduling: additive columns/indexes for durable jobs and opt-in
-- schedules (jobs-workflows slice). Additive only; no existing data changes.
--
-- schedules.mode: runtime mode a scheduled job is enqueued with. Unattended
--   scheduled jobs may only run in ANALYZE or RESEARCH mode; they never draft
--   or publish (DRAFT/EXECUTE always need an explicit human invocation).
-- schedules.catch_up: what the scheduler does when it wakes after missing one
--   or more due runs (sleeping/offline machine): 'once' enqueues a single
--   catch-up run, 'skip' drops missed runs and waits for the next slot.
-- schedules.last_job_id / last_note: outcome of the most recent due slot
--   (enqueued job, or why nothing was enqueued), for `schedule show`.

ALTER TABLE schedules ADD COLUMN mode TEXT NOT NULL DEFAULT 'ANALYZE' CHECK (mode IN ('ANALYZE', 'RESEARCH'));
ALTER TABLE schedules ADD COLUMN catch_up TEXT NOT NULL DEFAULT 'once' CHECK (catch_up IN ('once', 'skip'));
ALTER TABLE schedules ADD COLUMN last_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE schedules ADD COLUMN last_note TEXT;

-- Due-job lookup (runner picks queued jobs whose next_attempt_at has passed).
CREATE INDEX idx_jobs_due ON jobs (site_id, status, next_attempt_at);
CREATE INDEX idx_job_runs_job ON job_runs (job_id, attempt);
CREATE INDEX idx_checkpoints_site_job ON checkpoints (site_id, job_id, stage);
