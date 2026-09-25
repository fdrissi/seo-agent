-- 0171_apify_plan_occurrences: additive schema for the Apify research slice.
--
-- apify_runs.plan_json: plan facts fixed at submission (conservative estimate,
-- per-result/one-time cost terms, provider cap, whether the cap could stop the
-- run early, bounds, enforced time window). Used after a restart to decide
-- whether a SUCCEEDED run was cut short by its charge cap (quarantined as
-- partial) without depending on pricing that may have changed since.
ALTER TABLE apify_runs ADD COLUMN plan_json TEXT CHECK (plan_json IS NULL OR json_valid(plan_json));
-- Posts/comments seen in the fetched dataset (lower bound on charged results):
-- provider usage below what this activity implies is treated as preliminary.
ALTER TABLE apify_runs ADD COLUMN observed_result_items INTEGER;

-- Every occurrence (Reddit post/comment) that supports an apify_reddit content
-- signal, including repeats of the same normalized text from other items or
-- later runs. COUNT(*) per signal is its recurrence; each row links the
-- supporting example (source + evidence excerpt). Engagement is not search volume.
CREATE TABLE apify_signal_occurrences (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  signal_id TEXT NOT NULL REFERENCES content_signals(id) ON DELETE CASCADE,
  apify_run_id TEXT REFERENCES apify_runs(id) ON DELETE SET NULL,
  item_key TEXT NOT NULL,                    -- `${dataType}:${id}` of the dataset item
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  evidence_id TEXT REFERENCES evidence(id) ON DELETE SET NULL,
  url TEXT,
  posted_at TEXT,
  collected_at TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  UNIQUE (site_id, signal_id, item_key)
);
CREATE INDEX idx_apify_signal_occurrences_signal ON apify_signal_occurrences (site_id, signal_id);
