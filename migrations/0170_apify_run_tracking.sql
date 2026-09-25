-- 0170_apify_run_tracking: additive columns for crash-safe Apify run processing.
--
-- apify_runs.status mirrors the remote ActorJobStatus (plus 'submitting',
-- 'ambiguous', 'quarantined'). processing_status records whether this
-- installation finished processing the run (dataset fetched, signals
-- normalized, usage reconciled), so an interrupted process can resume a known
-- run instead of starting a duplicate paid run.
--   pending     -> submission/poll/fetch/normalize still outstanding
--   complete    -> dataset fully fetched and normalized (research usable)
--   quarantined -> partial/failed/timed-out/aborted/rejected: never used as complete research
--   abandoned   -> the paid request was provably never sent (reservation released)

ALTER TABLE apify_runs ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (processing_status IN ('pending', 'complete', 'quarantined', 'abandoned'));
-- Last remote status seen (kept when status becomes 'quarantined').
ALTER TABLE apify_runs ADD COLUMN remote_status TEXT;
ALTER TABLE apify_runs ADD COLUMN status_message TEXT;
ALTER TABLE apify_runs ADD COLUMN reservation_id TEXT REFERENCES budget_reservations(id) ON DELETE SET NULL;
ALTER TABLE apify_runs ADD COLUMN schema_id TEXT;                -- apify_actor_schemas.id validated against
-- Run options sent with the POST (build, timeoutSecs, memoryMbytes, maxItems, maxTotalChargeUsd):
-- used to fingerprint ambiguous submissions against provider run history.
ALTER TABLE apify_runs ADD COLUMN run_options_json TEXT CHECK (run_options_json IS NULL OR json_valid(run_options_json));
ALTER TABLE apify_runs ADD COLUMN purpose TEXT;
ALTER TABLE apify_runs ADD COLUMN submitted_at TEXT;
ALTER TABLE apify_runs ADD COLUMN raw_ref TEXT;                   -- minimized dataset items in the raw store
ALTER TABLE apify_runs ADD COLUMN signals_created INTEGER;        -- NULL = not normalized

CREATE INDEX idx_apify_runs_processing ON apify_runs (site_id, processing_status);
