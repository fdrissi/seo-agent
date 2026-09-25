-- 0150_llm_gateway: LLM Gateway model-catalog cache (capabilities + verified
-- prices with retrieval time) and additive llm_calls columns for call outcome,
-- attempt grouping, reservation link, and synthetic labelling.
-- Additive only: no existing column or row is changed.

-- One row per successful GET /v1/models retrieval.
-- Grain: (site_id, base_url, retrieved_at). The latest row per (site_id, base_url)
-- is the current catalog; older snapshots are kept (bounded) to explain price changes.
CREATE TABLE llm_model_catalog_snapshots (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  base_url TEXT NOT NULL,                    -- non-secret gateway base URL
  authenticated INTEGER NOT NULL CHECK (authenticated IN (0, 1)),  -- 1 = key-filtered catalog
  model_count INTEGER NOT NULL CHECK (model_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),  -- entries that failed to parse
  raw_ref TEXT,                              -- raw response in the private workspace
  provider_request_id TEXT REFERENCES provider_requests(id) ON DELETE SET NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  retrieved_at TEXT NOT NULL
);
CREATE INDEX idx_llm_catalog_snapshots_site ON llm_model_catalog_snapshots (site_id, base_url, retrieved_at);

-- Parsed capabilities per model per snapshot.
-- Grain / unique key: (snapshot_id, model_id). NULL capability = not reported (unknown), never false.
CREATE TABLE llm_model_capabilities (
  snapshot_id TEXT NOT NULL REFERENCES llm_model_catalog_snapshots(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  is_embedding INTEGER NOT NULL CHECK (is_embedding IN (0, 1)),
  context_length INTEGER,
  max_output INTEGER,
  structured_outputs INTEGER CHECK (structured_outputs IS NULL OR structured_outputs IN (0, 1)),
  json_output INTEGER CHECK (json_output IS NULL OR json_output IN (0, 1)),
  tools INTEGER CHECK (tools IS NULL OR tools IN (0, 1)),
  reasoning INTEGER CHECK (reasoning IS NULL OR reasoning IN (0, 1)),
  prompt_price TEXT,                         -- verbatim catalog string (USD per token per contract)
  completion_price TEXT,
  deprecated_at TEXT,
  deactivated_at TEXT,
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  retrieved_at TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, model_id)
);
CREATE INDEX idx_llm_model_capabilities_site_model ON llm_model_capabilities (site_id, model_id, retrieved_at);

-- llm_calls: one row per HTTP request to the gateway (initial, tool round, or
-- repair attempt). Rows of one logical call share call_group_id.
ALTER TABLE llm_calls ADD COLUMN call_group_id TEXT;
ALTER TABLE llm_calls ADD COLUMN attempt INTEGER;                 -- 1-based request sequence within the group
ALTER TABLE llm_calls ADD COLUMN status TEXT CHECK (status IS NULL OR status IN ('succeeded', 'invalid_output', 'needs_review', 'tool_round', 'provider_error', 'ambiguous', 'skipped'));
ALTER TABLE llm_calls ADD COLUMN response_format TEXT CHECK (response_format IS NULL OR response_format IN ('json_schema', 'json_object', 'prompt', 'text', 'embedding'));
ALTER TABLE llm_calls ADD COLUMN reservation_id TEXT;
ALTER TABLE llm_calls ADD COLUMN run_id TEXT;
ALTER TABLE llm_calls ADD COLUMN http_status INTEGER;
ALTER TABLE llm_calls ADD COLUMN error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json));
ALTER TABLE llm_calls ADD COLUMN is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1));
CREATE INDEX idx_llm_calls_group ON llm_calls (call_group_id);
CREATE INDEX idx_llm_calls_trace ON llm_calls (trace_id);
