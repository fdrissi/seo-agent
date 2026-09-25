-- 0120_crawler: additive crawl detail used by technical checks.
-- * crawl_results gains discovery context (depth, how the URL was found,
--   sitemap membership), a 64-bit SimHash for SUSPECTED near-duplicate
--   detection, and extraction details that have no dedicated column
--   (multiple canonicals, header canonicals, robots directive flags, login
--   form, injection flags, external links sample). Existing rows keep NULLs.
-- * crawl_robots: one row per (crawl, origin) robots.txt outcome.
-- * crawl_sitemaps: one row per (crawl, sitemap file) with bounded traversal
--   results and skip reasons.

ALTER TABLE crawl_results ADD COLUMN depth INTEGER;
ALTER TABLE crawl_results ADD COLUMN discovered_via_json TEXT CHECK (discovered_via_json IS NULL OR json_valid(discovered_via_json));
ALTER TABLE crawl_results ADD COLUMN in_sitemap INTEGER CHECK (in_sitemap IS NULL OR in_sitemap IN (0, 1));
ALTER TABLE crawl_results ADD COLUMN text_simhash TEXT;
ALTER TABLE crawl_results ADD COLUMN extraction_json TEXT CHECK (extraction_json IS NULL OR json_valid(extraction_json));

-- GRAIN: one row per (crawl, origin).
CREATE TABLE crawl_robots (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  crawl_id TEXT NOT NULL REFERENCES crawls(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('parsed', 'not_found', 'unreachable', 'unsafe', 'not_fetched')),
  http_status INTEGER,
  allow_all INTEGER NOT NULL CHECK (allow_all IN (0, 1)),
  disallow_all INTEGER NOT NULL CHECK (disallow_all IN (0, 1)),
  sitemaps_json TEXT CHECK (sitemaps_json IS NULL OR json_valid(sitemaps_json)),
  crawl_delay_ms INTEGER,
  note TEXT,
  raw_ref TEXT,
  fetched_at TEXT NOT NULL,
  UNIQUE (crawl_id, origin)
);
CREATE INDEX idx_crawl_robots_site ON crawl_robots (site_id, fetched_at);

-- GRAIN: one row per (crawl, sitemap file URL).
CREATE TABLE crawl_sitemaps (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  crawl_id TEXT NOT NULL REFERENCES crawls(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('robots', 'default', 'index')),
  kind TEXT CHECK (kind IS NULL OR kind IN ('urlset', 'sitemapindex', 'unknown')),
  status TEXT NOT NULL CHECK (status IN ('parsed', 'skipped', 'failed')),
  http_status INTEGER,
  is_gzip INTEGER NOT NULL DEFAULT 0 CHECK (is_gzip IN (0, 1)),
  urls_found INTEGER NOT NULL DEFAULT 0,
  child_sitemaps INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  fetched_at TEXT NOT NULL,
  UNIQUE (crawl_id, url)
);
CREATE INDEX idx_crawl_sitemaps_site ON crawl_sitemaps (site_id, fetched_at);
