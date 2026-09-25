-- 0007_experiments: experiments, status history, measurements, external-change
-- annotations, decisions, learnings.

CREATE TABLE experiments (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  recommendation_id TEXT REFERENCES recommendations(id) ON DELETE SET NULL,
  type TEXT NOT NULL,                        -- 'title_meta' | 'content_section' | 'internal_links' | 'technical' | 'new_page' | 'other'
  hypothesis TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  proposed_change TEXT NOT NULL,
  change_hash TEXT NOT NULL,
  baseline_json TEXT CHECK (baseline_json IS NULL OR json_valid(baseline_json)),
  primary_metric TEXT NOT NULL,
  outcome_kind TEXT NOT NULL CHECK (outcome_kind IN ('seo_visibility', 'conversion', 'both')),
  guardrail_metrics_json TEXT NOT NULL CHECK (json_valid(guardrail_metrics_json)),
  min_observation_days INTEGER NOT NULL CHECK (min_observation_days > 0),
  sample_requirements_json TEXT NOT NULL CHECK (json_valid(sample_requirements_json)),
  risks TEXT NOT NULL,
  rollback_plan TEXT NOT NULL,
  review_date TEXT,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'awaiting_implementation', 'observing', 'positive', 'negative', 'inconclusive', 'cancelled')),
  frozen_versions_json TEXT CHECK (frozen_versions_json IS NULL OR json_valid(frozen_versions_json)),   -- prompt/model/scoring/measurement versions
  implemented_at TEXT,                       -- actual deployment time; starts the observation window
  source_revision TEXT,
  before_snapshot_ref TEXT,
  after_snapshot_ref TEXT,
  observation_start TEXT,
  observation_end TEXT,
  comparison_pages_json TEXT CHECK (comparison_pages_json IS NULL OR json_valid(comparison_pages_json)),
  outcome_json TEXT CHECK (outcome_json IS NULL OR json_valid(outcome_json)),
  approval_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_experiments_site_status ON experiments (site_id, status);
CREATE INDEX idx_experiments_page ON experiments (site_id, page_id, status);

CREATE TABLE experiment_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  at TEXT NOT NULL
);

-- Grain: one row per (experiment, window, period, method version).
CREATE TABLE experiment_measurements (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  window_kind TEXT NOT NULL CHECK (window_kind IN ('baseline', 'observation', 'comparison')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  metrics_json TEXT NOT NULL CHECK (json_valid(metrics_json)),
  method TEXT NOT NULL,
  method_version TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  UNIQUE (experiment_id, window_kind, period_start, period_end, method_version)
);

-- External or shared changes that can interfere with measurement.
CREATE TABLE change_annotations (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  scope TEXT NOT NULL CHECK (scope IN ('page', 'template', 'site', 'external')),
  kind TEXT NOT NULL CHECK (kind IN ('site_change', 'template_change', 'critical_fix', 'algorithm_update', 'tracking_change', 'seasonality', 'outage', 'campaign', 'other')),
  occurred_at TEXT NOT NULL,
  description TEXT NOT NULL,
  source TEXT,
  overrides_freeze INTEGER NOT NULL DEFAULT 0 CHECK (overrides_freeze IN (0, 1)),
  recorded_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_annotations_site ON change_annotations (site_id, occurred_at);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  vault_path TEXT
);
CREATE INDEX idx_decisions_subject ON decisions (site_id, subject_type, subject_id);

-- Proposed learnings need evidence and scope; they never become universal rules automatically.
CREATE TABLE learnings (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  statement TEXT NOT NULL,
  scope TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  experiment_id TEXT REFERENCES experiments(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected', 'superseded')),
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
