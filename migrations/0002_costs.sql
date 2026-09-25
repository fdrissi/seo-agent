-- 0002_costs: provider requests, budget reservations, cost ledger, LLM call records.
-- Report actual, estimated, reserved, and unknown amounts separately.
-- Unresolved charges stay reserved until reconciled. Missing usage is never $0.

-- Every outbound provider request (paid or not). Paid POSTs are never blindly
-- retried: a timeout marks the request 'ambiguous' until reconciled against
-- provider history.
CREATE TABLE provider_requests (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                    -- 'llm_gateway' | 'dataforseo' | 'apify' | 'google_gsc' | 'google_ga4' | 'pagespeed' | 'crux' | 'qdrant'
  endpoint TEXT NOT NULL,                    -- logical endpoint key, never a credential-bearing URL
  method TEXT NOT NULL,
  is_paid INTEGER NOT NULL DEFAULT 0 CHECK (is_paid IN (0, 1)),
  request_hash TEXT NOT NULL,                -- hash of canonical, redacted parameters
  idempotency_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'submitted', 'succeeded', 'failed', 'ambiguous', 'reconciled', 'skipped')),
  external_id TEXT,                          -- provider task/run id, persisted immediately
  http_status INTEGER,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  raw_ref TEXT,
  reservation_id TEXT,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  trace_id TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),  -- fixtures/sandbox
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  completed_at TEXT
);
CREATE INDEX idx_provider_requests_site ON provider_requests (site_id, provider, created_at);
CREATE INDEX idx_provider_requests_external ON provider_requests (provider, external_id);
CREATE INDEX idx_provider_requests_status ON provider_requests (status);

-- Atomic reservations against run/site/service/account limits.
-- estimated_usd_micros is a conservative upper bound; actual is filled on reconcile.
CREATE TABLE budget_reservations (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  run_id TEXT,                               -- job id or ad-hoc run key for per-run caps
  purpose TEXT NOT NULL,
  estimated_usd_micros INTEGER NOT NULL CHECK (estimated_usd_micros >= 0),
  actual_usd_micros INTEGER CHECK (actual_usd_micros IS NULL OR actual_usd_micros >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'reconciled', 'released', 'unresolved')),
  cost_status TEXT NOT NULL CHECK (cost_status IN ('estimated', 'actual', 'unknown')),
  price_basis_json TEXT CHECK (price_basis_json IS NULL OR json_valid(price_basis_json)),
  period_month TEXT NOT NULL,                -- 'YYYY-MM' in the site's budget time zone
  period_week TEXT NOT NULL,                 -- 'YYYY-Www'
  provider_request_id TEXT REFERENCES provider_requests(id) ON DELETE SET NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_reservations_site_period ON budget_reservations (site_id, provider, period_month, status);
CREATE INDEX idx_reservations_week ON budget_reservations (site_id, provider, period_week, status);
CREATE INDEX idx_reservations_run ON budget_reservations (run_id);
CREATE INDEX idx_reservations_account ON budget_reservations (provider, period_month, status);

-- Cost ledger. One actual/estimated entry per provider request per source so
-- response-level and task-level totals are never double counted.
CREATE TABLE cost_ledger (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  reservation_id TEXT REFERENCES budget_reservations(id) ON DELETE SET NULL,
  provider_request_id TEXT REFERENCES provider_requests(id) ON DELETE SET NULL,
  amount_usd_micros INTEGER,                 -- NULL = unknown
  amount_status TEXT NOT NULL CHECK (amount_status IN ('actual', 'estimated', 'unknown')),
  source TEXT NOT NULL CHECK (source IN ('provider_reported', 'gateway_reported', 'computed_from_usage', 'estimate', 'manual')),
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  period_month TEXT NOT NULL,
  period_week TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  CHECK ((amount_status = 'unknown') = (amount_usd_micros IS NULL))
);
CREATE UNIQUE INDEX uq_cost_ledger_request ON cost_ledger (provider_request_id) WHERE provider_request_id IS NOT NULL;
CREATE INDEX idx_cost_ledger_site_period ON cost_ledger (site_id, provider, period_month);

-- LLM call metadata: prompt version, model, token ceilings, evidence bundle, usage.
CREATE TABLE llm_calls (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  provider_request_id TEXT REFERENCES provider_requests(id) ON DELETE SET NULL,
  trace_id TEXT NOT NULL,
  role TEXT NOT NULL,                        -- 'extractor' | 'analyst' | 'synthesizer' | 'writer' | 'reviewer' | 'embedder'
  tier TEXT NOT NULL CHECK (tier IN ('cheap', 'reasoning', 'embedding')),
  prompt_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model_requested TEXT NOT NULL,
  model_returned TEXT,
  params_json TEXT CHECK (params_json IS NULL OR json_valid(params_json)),
  max_output_tokens INTEGER NOT NULL,
  input_tokens INTEGER,                      -- NULL = not reported
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  cost_usd_micros INTEGER,                   -- NULL = unknown
  cost_status TEXT NOT NULL CHECK (cost_status IN ('actual', 'estimated', 'unknown')),
  schema_name TEXT,
  validation_status TEXT NOT NULL CHECK (validation_status IN ('valid', 'repaired', 'invalid', 'not_applicable', 'error')),
  repair_attempts INTEGER NOT NULL DEFAULT 0 CHECK (repair_attempts BETWEEN 0 AND 2),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  truncation_json TEXT CHECK (truncation_json IS NULL OR json_valid(truncation_json)),
  evidence_bundle_hash TEXT,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_llm_calls_site ON llm_calls (site_id, created_at);
