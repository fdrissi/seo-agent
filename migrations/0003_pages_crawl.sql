-- 0003_pages_crawl: page identity, URL aliases (with evidence), crawls, content
-- snapshots, internal links, technical issues, performance checks, URL inspection.

-- A page is a normalized URL identity for this site. Raw variants are aliases.
-- www/non-www, http/https, trailing slash, and case are NOT merged unless an
-- alias row records the evidence.
CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  url TEXT NOT NULL,                         -- normalized identity URL
  host TEXT NOT NULL,
  path TEXT NOT NULL,
  first_source TEXT NOT NULL CHECK (first_source IN ('crawl', 'sitemap', 'gsc', 'ga4', 'config', 'manual', 'fixture')),
  page_type TEXT,                            -- 'offer' | 'article' | 'category' | 'product' | 'tool' | 'other'
  language TEXT,
  is_protected INTEGER NOT NULL DEFAULT 0 CHECK (is_protected IN (0, 1)),
  is_excluded INTEGER NOT NULL DEFAULT 0 CHECK (is_excluded IN (0, 1)),
  lifecycle TEXT NOT NULL DEFAULT 'unknown' CHECK (lifecycle IN ('active', 'redirected', 'gone', 'unknown')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (site_id, url)
);
CREATE INDEX idx_pages_site_path ON pages (site_id, path);

-- Alias evidence. Grain: one row per (site, raw alias URL).
CREATE TABLE url_aliases (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  alias_url TEXT NOT NULL,                   -- raw URL exactly as observed
  relation TEXT NOT NULL CHECK (relation IN ('identical', 'tracking_params_removed', 'host_case', 'default_port', 'fragment_removed', 'redirect', 'canonical', 'configured', 'manual', 'ga4_path', 'gsc_url')),
  confidence TEXT NOT NULL CHECK (confidence IN ('established', 'probable', 'unverified')),
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, alias_url)
);
CREATE INDEX idx_url_aliases_page ON url_aliases (page_id);

CREATE TABLE crawls (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('own_site', 'competitor', 'single_page')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed', 'cancelled')),
  config_json TEXT CHECK (config_json IS NULL OR json_valid(config_json)),
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  pages_attempted INTEGER NOT NULL DEFAULT 0,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  pages_blocked INTEGER NOT NULL DEFAULT 0,
  pages_failed INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_crawls_site ON crawls (site_id, started_at);

-- Content snapshot per fetched URL per crawl. Grain: (crawl, requested URL).
CREATE TABLE crawl_results (
  id TEXT PRIMARY KEY,
  crawl_id TEXT NOT NULL REFERENCES crawls(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  requested_url TEXT NOT NULL,
  final_url TEXT,
  status_code INTEGER,
  redirect_chain_json TEXT CHECK (redirect_chain_json IS NULL OR json_valid(redirect_chain_json)),
  content_type TEXT,
  bytes INTEGER,
  fetched_at TEXT NOT NULL,
  render_mode TEXT NOT NULL DEFAULT 'http' CHECK (render_mode IN ('http', 'playwright', 'fixture')),
  headers_json TEXT CHECK (headers_json IS NULL OR json_valid(headers_json)),   -- redacted, relevant headers only
  robots_allowed INTEGER CHECK (robots_allowed IS NULL OR robots_allowed IN (0, 1)),
  meta_robots TEXT,
  x_robots_tag TEXT,
  canonical_url TEXT,
  hreflang_json TEXT CHECK (hreflang_json IS NULL OR json_valid(hreflang_json)),
  title TEXT,
  meta_description TEXT,
  headings_json TEXT CHECK (headings_json IS NULL OR json_valid(headings_json)),
  word_count INTEGER,
  language TEXT,
  text_ref TEXT,                             -- extracted visible text in the raw store
  content_hash TEXT,
  structured_data_json TEXT CHECK (structured_data_json IS NULL OR json_valid(structured_data_json)),
  images_json TEXT CHECK (images_json IS NULL OR json_valid(images_json)),
  links_internal INTEGER,
  links_external INTEGER,
  render_discrepancies_json TEXT CHECK (render_discrepancies_json IS NULL OR json_valid(render_discrepancies_json)),
  blocked_reason TEXT CHECK (blocked_reason IS NULL OR blocked_reason IN ('robots', 'login_required', 'access_denied', 'unsafe_url', 'too_large', 'unsupported_content', 'rate_limited', 'timeout', 'network_error', 'excluded', 'budget', 'crawl_trap')),
  error TEXT,
  UNIQUE (crawl_id, requested_url)
);
CREATE INDEX idx_crawl_results_page ON crawl_results (site_id, page_id, fetched_at);
CREATE INDEX idx_crawl_results_final ON crawl_results (site_id, final_url);

-- Links observed in a crawl. Grain: (crawl, source result, target URL, anchor).
CREATE TABLE internal_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  crawl_id TEXT NOT NULL REFERENCES crawls(id) ON DELETE CASCADE,
  source_result_id TEXT NOT NULL REFERENCES crawl_results(id) ON DELETE CASCADE,
  source_page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  target_url TEXT NOT NULL,
  target_page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  anchor_text TEXT NOT NULL DEFAULT '',
  rel TEXT,
  is_nofollow INTEGER NOT NULL DEFAULT 0 CHECK (is_nofollow IN (0, 1)),
  context_snippet TEXT,
  UNIQUE (crawl_id, source_result_id, target_url, anchor_text)
);
CREATE INDEX idx_internal_links_target ON internal_links (site_id, target_page_id);

CREATE TABLE technical_issues (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  crawl_id TEXT REFERENCES crawls(id) ON DELETE SET NULL,
  page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  issue_type TEXT NOT NULL,                  -- 'broken_internal_link' | 'redirect_chain' | 'canonical_conflict' | 'accidental_noindex' | 'missing_title' | ...
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  is_heuristic INTEGER NOT NULL DEFAULT 0 CHECK (is_heuristic IN (0, 1)),   -- editorial heuristic, not a ranking rule
  confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),         -- confirmed blocker vs suspicion
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (site_id, url, issue_type)
);

-- Lab (Lighthouse) and field (CrUX) data are separate rows with explicit scope.
CREATE TABLE performance_checks (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('psi_lab', 'psi_field', 'crux_api', 'lighthouse_local', 'fixture')),
  data_kind TEXT NOT NULL CHECK (data_kind IN ('lab', 'field')),
  field_scope TEXT CHECK (field_scope IS NULL OR field_scope IN ('page', 'origin', 'unavailable')),
  device TEXT NOT NULL CHECK (device IN ('mobile', 'desktop', 'phone', 'tablet', 'all')),
  metrics_json TEXT NOT NULL CHECK (json_valid(metrics_json)),
  tool_version TEXT,
  cache_key TEXT NOT NULL,
  raw_ref TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  checked_at TEXT NOT NULL
);
CREATE INDEX idx_perf_site_url ON performance_checks (site_id, url, checked_at);
CREATE INDEX idx_perf_cache ON performance_checks (cache_key, checked_at);

-- URL Inspection API = Google's indexed-state information, NOT a live test.
CREATE TABLE url_inspections (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  property TEXT NOT NULL,
  url TEXT NOT NULL,
  inspection_kind TEXT NOT NULL DEFAULT 'indexed_state' CHECK (inspection_kind IN ('indexed_state')),
  verdict TEXT,
  coverage_state TEXT,
  indexing_state TEXT,
  robots_txt_state TEXT,
  page_fetch_state TEXT,
  google_canonical TEXT,
  user_canonical TEXT,
  last_crawl_time TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  raw_ref TEXT,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  inspected_at TEXT NOT NULL
);
CREATE INDEX idx_url_inspections_url ON url_inspections (site_id, url, inspected_at);
