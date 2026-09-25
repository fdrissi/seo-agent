-- 0200_metric_grains: define the grain and enforce the unique key of every
-- metric/observation table that did not have one (spec section 6: "Define
-- the grain and unique key of every metric table"; "Re-running a sync must
-- not double-count rows").
--
-- Each block documents the grain, removes exact duplicates of that grain
-- (keeping the earliest row and re-pointing references to it), and then adds
-- the unique index. Nullable key columns are wrapped in COALESCE so that
-- NULLs cannot bypass uniqueness (SQLite treats NULLs as distinct).

-- ---------------------------------------------------------------------------
-- serp_snapshots. Grain: one SERP observation per (site, query, provider,
-- location, language, device, depth, collected_at). A DataForSEO task yields
-- exactly one snapshot: UNIQUE (site_id, dataforseo_task_id) when the task id
-- is recorded (fixture/manual snapshots have none).
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _dup_serp AS
SELECT s.id AS loser,
       (SELECT s2.id FROM serp_snapshots s2
         WHERE s2.site_id = s.site_id AND s2.dataforseo_task_id = s.dataforseo_task_id
         ORDER BY s2.collected_at, s2.rowid LIMIT 1) AS survivor
  FROM serp_snapshots s
 WHERE s.dataforseo_task_id IS NOT NULL;
DELETE FROM _dup_serp WHERE loser = survivor;
UPDATE research_cache
   SET payload_ref = 'db:serp_snapshots:' || (SELECT survivor FROM _dup_serp WHERE 'db:serp_snapshots:' || loser = research_cache.payload_ref)
 WHERE payload_ref IN (SELECT 'db:serp_snapshots:' || loser FROM _dup_serp);
DELETE FROM rankings WHERE snapshot_id IN (SELECT loser FROM _dup_serp);
DELETE FROM serp_results WHERE snapshot_id IN (SELECT loser FROM _dup_serp);
DELETE FROM serp_snapshots WHERE id IN (SELECT loser FROM _dup_serp);
DROP TABLE _dup_serp;
CREATE UNIQUE INDEX uq_serp_snapshots_task ON serp_snapshots (site_id, dataforseo_task_id) WHERE dataforseo_task_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- rankings. Grain: one point-in-time own-site rank per (SERP snapshot,
-- keyword). A live rank from one SERP, never the GSC average position.
-- ---------------------------------------------------------------------------
DELETE FROM rankings
 WHERE rowid NOT IN (SELECT MIN(rowid) FROM rankings GROUP BY snapshot_id, COALESCE(keyword_id, ''));
CREATE UNIQUE INDEX uq_rankings_snapshot_keyword ON rankings (snapshot_id, COALESCE(keyword_id, ''));

-- ---------------------------------------------------------------------------
-- keyword_metrics. Search-volume ESTIMATES. Grain (documented in 0005, now
-- enforced): (site, keyword, provider, location, language, collected_at).
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _dup_kwm AS
SELECT m.id AS loser,
       (SELECT m2.id FROM keyword_metrics m2
         WHERE m2.site_id = m.site_id AND m2.keyword_id = m.keyword_id AND m2.provider = m.provider
           AND COALESCE(m2.location_code, -1) = COALESCE(m.location_code, -1)
           AND COALESCE(m2.language_code, '') = COALESCE(m.language_code, '')
           AND m2.collected_at = m.collected_at
         ORDER BY m2.rowid LIMIT 1) AS survivor
  FROM keyword_metrics m;
DELETE FROM _dup_kwm WHERE loser = survivor;
UPDATE research_cache
   SET payload_ref = 'db:keyword_metrics:' || (SELECT survivor FROM _dup_kwm WHERE 'db:keyword_metrics:' || loser = research_cache.payload_ref)
 WHERE payload_ref IN (SELECT 'db:keyword_metrics:' || loser FROM _dup_kwm);
DELETE FROM keyword_metrics WHERE id IN (SELECT loser FROM _dup_kwm);
DROP TABLE _dup_kwm;
CREATE UNIQUE INDEX uq_keyword_metrics_grain ON keyword_metrics (site_id, keyword_id, provider, COALESCE(location_code, -1), COALESCE(language_code, ''), collected_at);

-- ---------------------------------------------------------------------------
-- url_inspections. Grain: one URL Inspection result (Google's indexed state,
-- not a live test) per (site, property, URL, inspected_at).
-- ---------------------------------------------------------------------------
DELETE FROM url_inspections
 WHERE rowid NOT IN (SELECT MIN(rowid) FROM url_inspections GROUP BY site_id, property, url, inspected_at);
CREATE UNIQUE INDEX uq_url_inspections_grain ON url_inspections (site_id, property, url, inspected_at);

-- ---------------------------------------------------------------------------
-- performance_checks. Grain: one lab or field observation per (site, URL,
-- source, device, checked_at). psi_lab = one Lighthouse run; psi_field and
-- crux_api = one read of a rolling 28-day field window (see 0201 for its
-- date range). The daily cache key (source|device|UTC day|url) is a lookup
-- aid, not the grain: a forced re-run on the same day is a new observation.
-- ---------------------------------------------------------------------------
DELETE FROM performance_checks
 WHERE rowid NOT IN (SELECT MIN(rowid) FROM performance_checks GROUP BY site_id, url, source, device, checked_at);
CREATE UNIQUE INDEX uq_performance_checks_grain ON performance_checks (site_id, url, source, device, checked_at);

-- ---------------------------------------------------------------------------
-- ai_citation_checks. Grain: one AI answer observation per (site, engine,
-- query, prompt, location, method, checked_at). Ungrounded model responses
-- are stored with is_grounded = 0 and are never live search measurements.
-- ---------------------------------------------------------------------------
DELETE FROM ai_citation_checks
 WHERE rowid NOT IN (SELECT MIN(rowid) FROM ai_citation_checks GROUP BY site_id, engine, query, COALESCE(prompt, ''), COALESCE(location, ''), method, checked_at);
CREATE UNIQUE INDEX uq_ai_citation_checks_grain ON ai_citation_checks (site_id, engine, query, COALESCE(prompt, ''), COALESCE(location, ''), method, checked_at);

-- ---------------------------------------------------------------------------
-- competitor_changes. Grain: one detected change per (competitor page,
-- change type, new content hash, detected_at).
-- ---------------------------------------------------------------------------
DELETE FROM competitor_changes
 WHERE rowid NOT IN (SELECT MIN(rowid) FROM competitor_changes GROUP BY site_id, competitor_page_id, change_type, COALESCE(new_hash, ''), detected_at);
CREATE UNIQUE INDEX uq_competitor_changes_grain ON competitor_changes (site_id, competitor_page_id, change_type, COALESCE(new_hash, ''), detected_at);
