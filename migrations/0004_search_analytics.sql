-- 0004_search_analytics: versioned Search Console and GA4 ingestion.
--
-- Versioned ingestion: each sync writes an ingestion batch. A metric row is
-- inserted as a NEW revision only when its values changed (row_hash differs);
-- the previous revision is flagged is_current = 0. Re-running a sync therefore
-- never double counts, and *_current views expose the latest revision.
--
-- Property totals, page totals, and page/query detail are SEPARATE datasets.
-- They are never summed together: GSC aggregates by property and by page
-- differently, and anonymized queries are omitted from query rows.

CREATE TABLE ingestion_batches (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('gsc', 'ga4', 'import')),
  dataset TEXT NOT NULL,                     -- target table name
  property TEXT NOT NULL,
  date_start TEXT NOT NULL,
  date_end TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),     -- dimensions, filters, search type, aggregation type, data state
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  rows_received INTEGER NOT NULL DEFAULT 0,
  rows_new_revision INTEGER NOT NULL DEFAULT 0,
  rows_unchanged INTEGER NOT NULL DEFAULT 0,
  api_pages INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),     -- hit a documented row limit
  coverage_json TEXT CHECK (coverage_json IS NULL OR json_valid(coverage_json)),   -- warnings (anonymized queries, row limits, thresholding)
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),   -- source-reported report metadata
  raw_refs_json TEXT CHECK (raw_refs_json IS NULL OR json_valid(raw_refs_json)),
  transformation_version TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json))
);
CREATE INDEX idx_batches_site_dataset ON ingestion_batches (site_id, dataset, started_at);

CREATE TABLE gsc_properties (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  property TEXT NOT NULL,                    -- exact: 'sc-domain:example.com' or 'https://www.example.com/'
  permission_level TEXT,
  discovered_at TEXT NOT NULL,
  PRIMARY KEY (site_id, property)
);

-- Data availability as reported by the API (never assumed).
CREATE TABLE gsc_data_availability (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  property TEXT NOT NULL,
  search_type TEXT NOT NULL,
  first_incomplete_date TEXT,                -- dates >= this are incomplete
  latest_final_date TEXT,
  latest_any_date TEXT,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  checked_at TEXT NOT NULL
);
CREATE INDEX idx_gsc_avail ON gsc_data_availability (site_id, property, search_type, checked_at);

-- GRAIN: one row per (site, property, search_type, date) per revision.
-- UNIQUE current key: (site_id, property, search_type, date).
-- Aggregation type: byProperty. Dates are in the Search Console reporting
-- time zone (date_tz, America/Los_Angeles per Google documentation).
CREATE TABLE gsc_property_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  property TEXT NOT NULL,
  search_type TEXT NOT NULL,
  date TEXT NOT NULL,
  date_tz TEXT NOT NULL,
  clicks INTEGER NOT NULL CHECK (clicks >= 0),
  impressions INTEGER NOT NULL CHECK (impressions >= 0),
  ctr REAL,                                  -- as reported; recompute from clicks/impressions for aggregates
  position REAL,                             -- as reported (impression-weighted average)
  aggregation_type TEXT NOT NULL,
  is_final INTEGER NOT NULL CHECK (is_final IN (0, 1)),
  revision INTEGER NOT NULL,
  is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
  row_hash TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES ingestion_batches(id) ON DELETE CASCADE,
  collected_at TEXT NOT NULL,
  transformation_version TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  UNIQUE (site_id, property, search_type, date, revision)
);
CREATE UNIQUE INDEX uq_gsc_property_daily_current ON gsc_property_daily (site_id, property, search_type, date) WHERE is_current = 1;

-- GRAIN: one row per (site, property, search_type, date, page, segment_key) per revision.
-- segment_key = '' when no optional dimension was requested, otherwise a
-- canonical 'country=est;device=MOBILE;searchAppearance=...' string.
-- Aggregation type: byPage. Page totals are NOT additive with property totals.
CREATE TABLE gsc_page_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  property TEXT NOT NULL,
  search_type TEXT NOT NULL,
  date TEXT NOT NULL,
  date_tz TEXT NOT NULL,
  page TEXT NOT NULL,                        -- raw URL as reported by GSC
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  segment_key TEXT NOT NULL DEFAULT '',
  country TEXT,
  device TEXT,
  search_appearance TEXT,
  clicks INTEGER NOT NULL CHECK (clicks >= 0),
  impressions INTEGER NOT NULL CHECK (impressions >= 0),
  ctr REAL,
  position REAL,
  aggregation_type TEXT NOT NULL,
  is_final INTEGER NOT NULL CHECK (is_final IN (0, 1)),
  revision INTEGER NOT NULL,
  is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
  row_hash TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES ingestion_batches(id) ON DELETE CASCADE,
  collected_at TEXT NOT NULL,
  transformation_version TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  UNIQUE (site_id, property, search_type, date, page, segment_key, revision)
);
CREATE UNIQUE INDEX uq_gsc_page_daily_current ON gsc_page_daily (site_id, property, search_type, date, page, segment_key) WHERE is_current = 1;
CREATE INDEX idx_gsc_page_daily_page ON gsc_page_daily (site_id, page_id, date) WHERE is_current = 1;

-- GRAIN: one row per (site, property, search_type, date, page, query, segment_key) per revision.
-- Targeted detail for shortlisted pages. Visible query rows omit anonymized
-- queries and are subject to row limits: NEVER sum them as page or site totals.
CREATE TABLE gsc_page_query_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  property TEXT NOT NULL,
  search_type TEXT NOT NULL,
  date TEXT NOT NULL,
  date_tz TEXT NOT NULL,
  page TEXT NOT NULL,
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  query TEXT NOT NULL,
  segment_key TEXT NOT NULL DEFAULT '',
  country TEXT,
  device TEXT,
  clicks INTEGER NOT NULL CHECK (clicks >= 0),
  impressions INTEGER NOT NULL CHECK (impressions >= 0),
  ctr REAL,
  position REAL,
  aggregation_type TEXT NOT NULL,
  is_final INTEGER NOT NULL CHECK (is_final IN (0, 1)),
  revision INTEGER NOT NULL,
  is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
  row_hash TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES ingestion_batches(id) ON DELETE CASCADE,
  collected_at TEXT NOT NULL,
  transformation_version TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  UNIQUE (site_id, property, search_type, date, page, query, segment_key, revision)
);
CREATE UNIQUE INDEX uq_gsc_pq_daily_current ON gsc_page_query_daily (site_id, property, search_type, date, page, query, segment_key) WHERE is_current = 1;
CREATE INDEX idx_gsc_pq_query ON gsc_page_query_daily (site_id, query, date) WHERE is_current = 1;
CREATE INDEX idx_gsc_pq_page ON gsc_page_query_daily (site_id, page_id, date) WHERE is_current = 1;

CREATE TABLE ga4_property_metadata (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL,
  time_zone TEXT,
  currency_code TEXT,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),   -- available dimensions/metrics (getMetadata)
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (site_id, property_id)
);

-- GRAIN: one row per (site, property, date, channel_view, landing_page, host_name, segment_key) per revision.
-- channel_view: 'google_organic' (session source google / medium organic;
-- comparable with GSC) or 'all_organic' (session default channel group
-- Organic Search). Both use SESSION-scoped acquisition dimensions.
-- Additive across dates: sessions, engaged_sessions, event counts, revenue.
-- NOT additive: users (see ga4_period_metrics) and rates.
CREATE TABLE ga4_landing_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL,
  date TEXT NOT NULL,
  date_tz TEXT NOT NULL,                     -- GA4 property time zone
  channel_view TEXT NOT NULL CHECK (channel_view IN ('google_organic', 'all_organic')),
  landing_page TEXT NOT NULL,                -- raw landingPagePlusQueryString; '(not set)' kept explicitly
  host_name TEXT NOT NULL DEFAULT '',
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  segment_key TEXT NOT NULL DEFAULT '',
  sessions INTEGER NOT NULL CHECK (sessions >= 0),
  engaged_sessions INTEGER CHECK (engaged_sessions IS NULL OR engaged_sessions >= 0),
  key_events REAL,                           -- all key events (occurrences)
  primary_event_name TEXT,
  primary_key_events REAL,                   -- keyEvents:<primary event> (occurrences, repeatable)
  primary_key_events_status TEXT NOT NULL DEFAULT 'missing' CHECK (primary_key_events_status IN ('observed', 'missing', 'unavailable', 'incomplete')),
  primary_session_rate REAL,                 -- sessionKeyEventRate:<primary event> (0..1) as reported
  primary_session_rate_status TEXT NOT NULL DEFAULT 'missing' CHECK (primary_session_rate_status IN ('observed', 'missing', 'unavailable', 'incomplete')),
  revenue_micros INTEGER,                    -- source currency micros; NULL = unavailable
  revenue_currency TEXT,
  revenue_status TEXT NOT NULL DEFAULT 'missing' CHECK (revenue_status IN ('observed', 'missing', 'unavailable', 'incomplete')),
  metric_names_json TEXT CHECK (metric_names_json IS NULL OR json_valid(metric_names_json)),   -- exact API metric names used
  is_complete INTEGER NOT NULL CHECK (is_complete IN (0, 1)),
  revision INTEGER NOT NULL,
  is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
  row_hash TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES ingestion_batches(id) ON DELETE CASCADE,
  collected_at TEXT NOT NULL,
  transformation_version TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  UNIQUE (site_id, property_id, date, channel_view, landing_page, host_name, segment_key, revision)
);
CREATE UNIQUE INDEX uq_ga4_landing_current ON ga4_landing_daily (site_id, property_id, date, channel_view, landing_page, host_name, segment_key) WHERE is_current = 1;
CREATE INDEX idx_ga4_landing_page ON ga4_landing_daily (site_id, page_id, date) WHERE is_current = 1;

-- GRAIN: one row per (site, property, date, channel_view, event_name, landing_page) per revision.
-- landing_page = '' means all landing pages. event_count = occurrences.
CREATE TABLE ga4_event_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL,
  date TEXT NOT NULL,
  date_tz TEXT NOT NULL,
  channel_view TEXT NOT NULL CHECK (channel_view IN ('google_organic', 'all_organic', 'all_traffic')),
  event_name TEXT NOT NULL,
  landing_page TEXT NOT NULL DEFAULT '',
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  key_event_count REAL,
  is_complete INTEGER NOT NULL CHECK (is_complete IN (0, 1)),
  revision INTEGER NOT NULL,
  is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
  row_hash TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES ingestion_batches(id) ON DELETE CASCADE,
  collected_at TEXT NOT NULL,
  transformation_version TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  UNIQUE (site_id, property_id, date, channel_view, event_name, landing_page, revision)
);
CREATE UNIQUE INDEX uq_ga4_event_current ON ga4_event_daily (site_id, property_id, date, channel_view, event_name, landing_page) WHERE is_current = 1;

-- Non-additive metrics fetched at PERIOD grain (users, period-level rates).
-- GRAIN: one row per (site, property, period_start, period_end, channel_view, landing_page, metric) per revision.
CREATE TABLE ga4_period_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  date_tz TEXT NOT NULL,
  channel_view TEXT NOT NULL CHECK (channel_view IN ('google_organic', 'all_organic', 'all_traffic')),
  landing_page TEXT NOT NULL DEFAULT '',
  metric TEXT NOT NULL,                      -- exact API metric name, e.g. 'totalUsers', 'sessionKeyEventRate:generate_lead'
  value REAL,
  value_status TEXT NOT NULL CHECK (value_status IN ('observed', 'missing', 'unavailable', 'incomplete')),
  is_complete INTEGER NOT NULL CHECK (is_complete IN (0, 1)),
  revision INTEGER NOT NULL,
  is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
  row_hash TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES ingestion_batches(id) ON DELETE CASCADE,
  collected_at TEXT NOT NULL,
  transformation_version TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  UNIQUE (site_id, property_id, period_start, period_end, channel_view, landing_page, metric, revision)
);
CREATE UNIQUE INDEX uq_ga4_period_current ON ga4_period_metrics (site_id, property_id, period_start, period_end, channel_view, landing_page, metric) WHERE is_current = 1;

CREATE VIEW gsc_property_daily_current AS SELECT * FROM gsc_property_daily WHERE is_current = 1;
CREATE VIEW gsc_page_daily_current AS SELECT * FROM gsc_page_daily WHERE is_current = 1;
CREATE VIEW gsc_page_query_daily_current AS SELECT * FROM gsc_page_query_daily WHERE is_current = 1;
CREATE VIEW ga4_landing_daily_current AS SELECT * FROM ga4_landing_daily WHERE is_current = 1;
CREATE VIEW ga4_event_daily_current AS SELECT * FROM ga4_event_daily WHERE is_current = 1;
CREATE VIEW ga4_period_metrics_current AS SELECT * FROM ga4_period_metrics WHERE is_current = 1;
