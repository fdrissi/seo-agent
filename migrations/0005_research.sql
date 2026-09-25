-- 0005_research: sources, evidence, claim references, keywords, SERPs,
-- competitors, research cache, DataForSEO tasks, Apify runs/schemas, content
-- signals, AI-citation checks.

-- A source is where information came from; trust_class governs how it may be used.
-- Scraped/user-reported/model-generated sources can never grant themselves trust.
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('gsc', 'ga4', 'crawl', 'serp', 'competitor_page', 'reddit', 'dataforseo', 'pagespeed', 'url_inspection', 'business_note', 'owner_input', 'manual_import', 'llm_output', 'fixture')),
  trust_class TEXT NOT NULL CHECK (trust_class IN ('owner_approved', 'first_party_measurement', 'third_party_data', 'user_reported', 'scraped_untrusted', 'model_generated', 'synthetic')),
  url TEXT,
  title TEXT,
  retrieved_at TEXT NOT NULL,
  published_at TEXT,
  raw_ref TEXT,
  content_hash TEXT,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  UNIQUE (site_id, source_type, url, content_hash)
);
CREATE INDEX idx_sources_site_type ON sources (site_id, source_type, retrieved_at);

-- An evidence item is a specific, checkable piece of a source (a metric
-- observation, an excerpt, a crawl observation), with its date range.
CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('metric', 'excerpt', 'observation', 'absence')),
  summary TEXT NOT NULL,
  excerpt TEXT,
  locator_json TEXT CHECK (locator_json IS NULL OR json_valid(locator_json)),   -- table/row keys, CSS selector, heading path
  value_json TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
  date_range_start TEXT,
  date_range_end TEXT,
  collected_at TEXT NOT NULL,
  transformation_version TEXT
);
CREATE INDEX idx_evidence_source ON evidence (source_id);

-- Source-to-claim references. Claim labels follow the reporting contract.
CREATE TABLE claim_evidence (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('recommendation', 'opportunity', 'brief', 'draft', 'report', 'experiment', 'learning', 'quality_review')),
  subject_id TEXT NOT NULL,
  claim_key TEXT NOT NULL,                   -- stable key within the subject
  claim_text TEXT NOT NULL,
  claim_label TEXT NOT NULL CHECK (claim_label IN ('OBSERVED', 'INFERRED', 'HYPOTHESIS', 'RECOMMENDATION', 'DATA_UNAVAILABLE')),
  evidence_id TEXT REFERENCES evidence(id) ON DELETE SET NULL,
  support TEXT NOT NULL CHECK (support IN ('supports', 'contradicts', 'context', 'missing')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_claim_evidence_subject ON claim_evidence (subject_type, subject_id);

CREATE TABLE keyword_clusters (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  intent TEXT,
  method TEXT NOT NULL,                      -- 'lexical' | 'embedding' | 'serp_overlap' | 'manual'
  method_version TEXT NOT NULL,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE keywords (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  normalized TEXT NOT NULL,
  language TEXT,
  is_branded INTEGER CHECK (is_branded IS NULL OR is_branded IN (0, 1)),
  intent TEXT CHECK (intent IS NULL OR intent IN ('informational', 'commercial', 'transactional', 'navigational', 'mixed', 'unsure')),
  intent_source TEXT CHECK (intent_source IS NULL OR intent_source IN ('rule', 'model', 'manual', 'serp')),
  cluster_id TEXT REFERENCES keyword_clusters(id) ON DELETE SET NULL,
  first_seen_at TEXT NOT NULL,
  origins_json TEXT CHECK (origins_json IS NULL OR json_valid(origins_json)),
  UNIQUE (site_id, normalized, language)
);

-- Search-volume ESTIMATES (not exact demand). Grain: (site, keyword, provider, location, language, collected_at).
CREATE TABLE keyword_metrics (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  keyword_id TEXT NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  location_code INTEGER,
  language_code TEXT,
  search_volume INTEGER,                     -- NULL = not provided
  competition REAL,
  cpc_micros INTEGER,
  cpc_currency TEXT,
  monthly_json TEXT CHECK (monthly_json IS NULL OR json_valid(monthly_json)),
  is_sandbox INTEGER NOT NULL DEFAULT 0 CHECK (is_sandbox IN (0, 1)),
  raw_ref TEXT,
  collected_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_keyword_metrics_kw ON keyword_metrics (keyword_id, collected_at);

CREATE TABLE serp_snapshots (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  keyword_id TEXT REFERENCES keywords(id) ON DELETE SET NULL,
  query TEXT NOT NULL,
  provider TEXT NOT NULL,
  location_code INTEGER,
  language_code TEXT,
  device TEXT NOT NULL,
  depth INTEGER,
  parameter_hash TEXT NOT NULL,
  features_json TEXT CHECK (features_json IS NULL OR json_valid(features_json)),
  items_count INTEGER,
  is_sandbox INTEGER NOT NULL DEFAULT 0 CHECK (is_sandbox IN (0, 1)),
  raw_ref TEXT,
  dataforseo_task_id TEXT,
  collected_at TEXT NOT NULL
);
CREATE INDEX idx_serp_snapshots_query ON serp_snapshots (site_id, query, collected_at);

CREATE TABLE serp_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id TEXT NOT NULL REFERENCES serp_snapshots(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  result_type TEXT NOT NULL,
  rank_group INTEGER,
  rank_absolute INTEGER,
  url TEXT,
  domain TEXT,
  title TEXT,
  description TEXT,
  is_own_site INTEGER NOT NULL DEFAULT 0 CHECK (is_own_site IN (0, 1)),
  UNIQUE (snapshot_id, rank_absolute, result_type, url)
);

-- A point-in-time observed SERP position (NOT the GSC aggregate average position).
CREATE TABLE rankings (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  keyword_id TEXT REFERENCES keywords(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  snapshot_id TEXT NOT NULL REFERENCES serp_snapshots(id) ON DELETE CASCADE,
  rank_absolute INTEGER,                     -- NULL = not found within depth
  observed_at TEXT NOT NULL
);

CREATE TABLE competitors (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  name TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('configured', 'serp_discovered', 'manual')),
  first_seen_at TEXT NOT NULL,
  notes TEXT,
  UNIQUE (site_id, domain)
);

CREATE TABLE competitor_pages (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  competitor_id TEXT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  last_crawl_result_id TEXT REFERENCES crawl_results(id) ON DELETE SET NULL,
  last_content_hash TEXT,
  first_seen_at TEXT NOT NULL,
  last_checked_at TEXT,
  UNIQUE (site_id, url)
);

CREATE TABLE competitor_changes (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  competitor_page_id TEXT NOT NULL REFERENCES competitor_pages(id) ON DELETE CASCADE,
  change_type TEXT NOT NULL,                 -- 'content_changed' | 'title_changed' | 'status_changed' | 'new_page' | 'removed'
  previous_hash TEXT,
  new_hash TEXT,
  summary TEXT,
  detected_at TEXT NOT NULL
);

-- Paid research cache. Keys include endpoint, locale, device, and parameter hash.
CREATE TABLE research_cache (
  cache_key TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  location_code INTEGER,
  language_code TEXT,
  device TEXT,
  parameter_hash TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  is_sandbox INTEGER NOT NULL DEFAULT 0 CHECK (is_sandbox IN (0, 1)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_research_cache_site ON research_cache (site_id, provider, expires_at);

-- DataForSEO tasks: task IDs are persisted immediately; an existing task is
-- polled rather than resubmitted after a local timeout.
CREATE TABLE dataforseo_tasks (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  provider_request_id TEXT REFERENCES provider_requests(id) ON DELETE SET NULL,
  endpoint TEXT NOT NULL,
  remote_task_id TEXT,
  tag TEXT,
  parameter_hash TEXT NOT NULL,
  params_json TEXT NOT NULL CHECK (json_valid(params_json)),
  status TEXT NOT NULL CHECK (status IN ('submitting', 'queued', 'ready', 'fetched', 'failed', 'ambiguous', 'expired')),
  api_status_code INTEGER,
  api_status_message TEXT,
  cost_usd_micros INTEGER,                   -- task-level cost as reported; NULL = unknown
  is_sandbox INTEGER NOT NULL DEFAULT 0 CHECK (is_sandbox IN (0, 1)),
  raw_ref TEXT,
  submitted_at TEXT,
  ready_at TEXT,
  fetched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_dfs_tasks_status ON dataforseo_tasks (site_id, status);
CREATE INDEX idx_dfs_tasks_param ON dataforseo_tasks (site_id, endpoint, parameter_hash);

-- Apify actor schemas: tested schema + pinned build; drift detected by hash.
CREATE TABLE apify_actor_schemas (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  actor_name TEXT,
  build_id TEXT,
  build_number TEXT,
  build_tag TEXT,
  input_schema_json TEXT CHECK (input_schema_json IS NULL OR json_valid(input_schema_json)),
  schema_hash TEXT,
  pricing_json TEXT CHECK (pricing_json IS NULL OR json_valid(pricing_json)),
  source TEXT NOT NULL CHECK (source IN ('api', 'import', 'fixture')),
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  fetched_at TEXT NOT NULL,
  UNIQUE (actor_id, build_id, schema_hash)
);

CREATE TABLE apify_runs (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  provider_request_id TEXT REFERENCES provider_requests(id) ON DELETE SET NULL,
  actor_id TEXT NOT NULL,
  build TEXT,
  remote_run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('submitting', 'READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMING-OUT', 'TIMED-OUT', 'ABORTING', 'ABORTED', 'ambiguous', 'quarantined')),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),   -- validated, credential-free input
  input_hash TEXT NOT NULL,
  dataset_id TEXT,
  items_fetched INTEGER NOT NULL DEFAULT 0,
  max_items INTEGER,
  max_total_charge_usd_micros INTEGER,
  usage_total_usd_micros INTEGER,            -- NULL = not yet reported
  charged_events_json TEXT CHECK (charged_events_json IS NULL OR json_valid(charged_events_json)),
  quarantine_reason TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_apify_runs_status ON apify_runs (site_id, status);
CREATE INDEX idx_apify_runs_input ON apify_runs (site_id, actor_id, input_hash);

-- Discovery signals for content farming. Engagement is not search volume.
CREATE TABLE content_signals (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK (origin IN ('gsc_query', 'dataforseo', 'apify_reddit', 'competitor_gap', 'business_knowledge', 'manual', 'fixture')),
  signal_type TEXT NOT NULL,                 -- 'question' | 'objection' | 'complaint' | 'comparison' | 'unmet_need' | 'tool_idea' | 'query'
  text TEXT NOT NULL,
  normalized_hash TEXT NOT NULL,
  url TEXT,
  posted_at TEXT,
  collected_at TEXT NOT NULL,
  collection_window_json TEXT CHECK (collection_window_json IS NULL OR json_valid(collection_window_json)),
  engagement_json TEXT CHECK (engagement_json IS NULL OR json_valid(engagement_json)),
  limitations TEXT NOT NULL,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  apify_run_id TEXT REFERENCES apify_runs(id) ON DELETE SET NULL,
  content_item_id TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  UNIQUE (site_id, origin, normalized_hash)
);

-- Optional, separately budgeted AI-citation monitoring. A brand mention is not
-- a citation, a citation is not a click, a click is not a conversion.
CREATE TABLE ai_citation_checks (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  engine TEXT NOT NULL,
  query TEXT NOT NULL,
  prompt TEXT,
  location TEXT,
  method TEXT NOT NULL CHECK (method IN ('grounded_api', 'manual_import')),
  is_grounded INTEGER NOT NULL CHECK (is_grounded IN (0, 1)),
  response_ref TEXT,
  cited_urls_json TEXT CHECK (cited_urls_json IS NULL OR json_valid(cited_urls_json)),
  brand_mentioned INTEGER CHECK (brand_mentioned IS NULL OR brand_mentioned IN (0, 1)),
  own_site_cited INTEGER CHECK (own_site_cited IS NULL OR own_site_cited IN (0, 1)),
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  checked_at TEXT NOT NULL
);
