-- 0001_core: sites, configuration versions, append-only audit log, durable jobs.
-- Conventions (all migrations):
--   * Every business row carries site_id (website isolation from day one).
--   * Timestamps are ISO-8601 UTC TEXT; calendar dates are 'YYYY-MM-DD' TEXT in
--     an explicitly recorded time zone.
--   * Money: *_usd_micros INTEGER (1 USD = 1,000,000). NULL means unknown, never 0.
--   * JSON columns are TEXT validated with json_valid().

CREATE TABLE sites (
  id TEXT PRIMARY KEY,                       -- site slug, e.g. 'example-site'
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  active_config_version INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Every validated configuration that was active is retained (non-secret content only).
CREATE TABLE config_versions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  config_hash TEXT NOT NULL,
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  source TEXT NOT NULL CHECK (source IN ('setup', 'file', 'business_note_sync', 'migration', 'demo')),
  created_at TEXT NOT NULL,
  UNIQUE (site_id, version),
  UNIQUE (site_id, config_hash)
);

-- Append-only event history. UPDATE/DELETE are blocked by triggers.
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT REFERENCES sites(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,                       -- 'system' | 'owner:<name>' | 'cli' | 'scheduler'
  event_type TEXT NOT NULL,                  -- e.g. 'approval.approved', 'budget.reserved'
  subject_type TEXT,
  subject_id TEXT,
  trace_id TEXT,
  details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json))
);
CREATE INDEX idx_audit_site_at ON audit_events (site_id, at);
CREATE INDEX idx_audit_subject ON audit_events (subject_type, subject_id);
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;

-- Durable jobs. One row per logical job; attempts are job_runs.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                        -- 'baseline' | 'weekly' | 'monthly' | 'sync_gsc' | ...
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  mode TEXT NOT NULL DEFAULT 'ANALYZE' CHECK (mode IN ('ANALYZE', 'RESEARCH', 'DRAFT', 'EXECUTE')),
  params_json TEXT CHECK (params_json IS NULL OR json_valid(params_json)),
  dry_run INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0, 1)),
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  parent_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  trace_id TEXT,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  heartbeat_at TEXT,
  lock_owner TEXT
);
CREATE INDEX idx_jobs_site_status ON jobs (site_id, status);
CREATE INDEX idx_jobs_type ON jobs (site_id, type, created_at);

CREATE TABLE job_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  pid INTEGER,
  hostname TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  UNIQUE (job_id, attempt)
);

-- Persisted workflow stage results. Grain: one row per (job, stage, attempt);
-- the latest succeeded row per (job, stage) is the resume checkpoint.
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  workflow TEXT NOT NULL,
  stage TEXT NOT NULL,
  stage_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'skipped', 'stopped')),
  input_hash TEXT,
  output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
  output_ref TEXT,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  attempt INTEGER NOT NULL DEFAULT 1,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_checkpoints_job_stage ON checkpoints (job_id, stage, created_at);

-- Non-overlapping per-site runs. A lock with an expired lease may be taken over.
CREATE TABLE site_locks (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  lock_name TEXT NOT NULL,
  owner TEXT NOT NULL,
  job_id TEXT,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (site_id, lock_name)
);

CREATE TABLE circuit_breakers (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('closed', 'open', 'half_open')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT,
  next_probe_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_id, provider)
);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL,                    -- IANA zone; never a fixed UTC offset
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, job_type)
);
