-- 0210_competitive_comparisons: deep SERP/competitor comparison results of the
-- weekly `compare` stage (spec section 19: inspect the localized SERP and the
-- competing pages of the best candidates; record what our page does better).
-- Additive only: one new table and its indexes.
--
-- Grain: one row per (site, run, query, our page). A run is the weekly job id
-- (or the run id of a manual invocation). Unique key: (site_id, run_id, query,
-- page_id); a comparison whose own page has no page identity uses
-- page_id NULL, and the unique index treats NULL as '' so it is still unique.
--
-- The deterministic comparison (signal table, topic coverage, page-type mix,
-- what our page does better, observed gaps, caveats) is computed in code from
-- crawled pages: competitor pages are untrusted third-party content captured
-- at their fetch time, and observed differences are never ranking causes.
-- The optional model synthesis (prompt analysis.serp-synthesis, reasoning
-- tier) is stored separately with its status; when it did not run,
-- synthesis_status is 'skipped' and synthesis_reason says why.
-- is_synthetic = 1 for fixture/demo/sandbox data (never an observation).
CREATE TABLE competitive_comparisons (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,                        -- weekly job id (checkpointed run) or manual run id
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  query TEXT NOT NULL,                         -- the single search query the competitors were selected for
  page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  page_url TEXT NOT NULL,                      -- our page (normalized identity URL)
  opportunity_id TEXT REFERENCES opportunities(id) ON DELETE SET NULL,
  serp_snapshot_id TEXT REFERENCES serp_snapshots(id) ON DELETE SET NULL,
  location_code INTEGER,                       -- localized SERP scope (configured market.searchLocations)
  language_code TEXT,
  device TEXT,
  competitors_compared INTEGER NOT NULL CHECK (competitors_compared >= 0),
  competitors_inaccessible INTEGER NOT NULL CHECK (competitors_inaccessible >= 0),
  our_crawl_result_id TEXT REFERENCES crawl_results(id) ON DELETE SET NULL,
  inputs_json TEXT NOT NULL CHECK (json_valid(inputs_json)),                 -- deterministic comparison summary
  our_advantages_json TEXT NOT NULL CHECK (json_valid(our_advantages_json)), -- what our page does better
  gaps_json TEXT NOT NULL CHECK (json_valid(gaps_json)),                     -- observed differences, not causes
  caveats_json TEXT NOT NULL CHECK (json_valid(caveats_json)),
  synthesis_status TEXT NOT NULL CHECK (synthesis_status IN ('ok', 'skipped', 'failed')),
  synthesis_reason TEXT,                       -- why the synthesis was skipped or failed
  synthesis_json TEXT CHECK (synthesis_json IS NULL OR json_valid(synthesis_json)),
  llm_call_id TEXT,
  prompt_version TEXT,
  model_id TEXT,
  comparison_version TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_competitive_comparisons_grain ON competitive_comparisons (site_id, run_id, query, COALESCE(page_id, ''));
CREATE INDEX idx_competitive_comparisons_site_created ON competitive_comparisons (site_id, created_at);
CREATE INDEX idx_competitive_comparisons_page ON competitive_comparisons (site_id, page_id, created_at);
