-- 0203_keyword_language_dedup: one keyword row per query.
--
-- keywords is unique on (site_id, normalized, COALESCE(language, '')). Search
-- Console queries carry no language (NULL) while DataForSEO research stored
-- the request language (e.g. 'en'), so the same query became two keyword
-- rows (two vault notes, split page links and SERP data). The request
-- language already lives on serp_snapshots.language_code and
-- keyword_metrics.language_code; the keyword row does not need it.
--
-- From now on src/integrations/dataforseo/store.ts reuses the existing row
-- (exact language first, then NULL). This migration merges existing
-- duplicates into the NULL-language row when the other row is
--   (a) the only language-tagged row for that normalized query, or
--   (b) in the site's primary market language (active configuration:
--       market.languages[0], else the single search location's language).
-- Rows in other languages stay separate (a different language is a
-- different keyword). Child rows are re-pointed to the surviving row, then
-- the merged rows are deleted.

CREATE TEMP TABLE _kw_primary AS
SELECT site_id,
       CASE WHEN instr(lang, '-') > 0 THEN substr(lang, 1, instr(lang, '-') - 1) ELSE lang END AS base
  FROM (
    SELECT s.id AS site_id,
           lower(replace(COALESCE(
             json_extract(c.config_json, '$.market.languages[0]'),
             CASE WHEN json_array_length(c.config_json, '$.market.searchLocations') = 1 THEN json_extract(c.config_json, '$.market.searchLocations[0].languageCode') END
           ), '_', '-')) AS lang
      FROM sites s
      JOIN config_versions c ON c.site_id = s.id AND c.version = s.active_config_version
  );

CREATE TEMP TABLE _kw_merge AS
SELECT l.id AS loser, n.id AS survivor, l.site_id AS site_id
  FROM keywords l
  JOIN keywords n ON n.site_id = l.site_id AND n.normalized = l.normalized AND n.language IS NULL
  LEFT JOIN _kw_primary p ON p.site_id = l.site_id
 WHERE l.language IS NOT NULL
   AND (
     (SELECT COUNT(*) FROM keywords o WHERE o.site_id = l.site_id AND o.normalized = l.normalized AND o.language IS NOT NULL) = 1
     OR (p.base IS NOT NULL AND p.base = CASE WHEN instr(lower(replace(l.language, '_', '-')), '-') > 0
                                              THEN substr(lower(replace(l.language, '_', '-')), 1, instr(lower(replace(l.language, '_', '-')), '-') - 1)
                                              ELSE lower(replace(l.language, '_', '-')) END)
   );

-- Keep what the merged rows knew: origins (union), intent, branding, cluster,
-- and the earliest first_seen_at. The survivor's own values win when set.
UPDATE keywords
   SET origins_json = (
         SELECT json_group_array(value) FROM (
           SELECT DISTINCT j.value AS value
             FROM keywords k2, json_each(COALESCE(k2.origins_json, '[]')) j
            WHERE k2.id = keywords.id OR k2.id IN (SELECT loser FROM _kw_merge WHERE survivor = keywords.id)
         )
       ),
       intent = COALESCE(intent, (SELECT l.intent FROM keywords l JOIN _kw_merge m ON m.loser = l.id WHERE m.survivor = keywords.id AND l.intent IS NOT NULL LIMIT 1)),
       intent_source = CASE WHEN intent IS NULL
                            THEN (SELECT l.intent_source FROM keywords l JOIN _kw_merge m ON m.loser = l.id WHERE m.survivor = keywords.id AND l.intent IS NOT NULL LIMIT 1)
                            ELSE intent_source END,
       is_branded = COALESCE(is_branded, (SELECT l.is_branded FROM keywords l JOIN _kw_merge m ON m.loser = l.id WHERE m.survivor = keywords.id AND l.is_branded IS NOT NULL LIMIT 1)),
       cluster_id = COALESCE(cluster_id, (SELECT l.cluster_id FROM keywords l JOIN _kw_merge m ON m.loser = l.id WHERE m.survivor = keywords.id AND l.cluster_id IS NOT NULL LIMIT 1)),
       first_seen_at = min(first_seen_at, (SELECT MIN(l.first_seen_at) FROM keywords l JOIN _kw_merge m ON m.loser = l.id WHERE m.survivor = keywords.id))
 WHERE id IN (SELECT survivor FROM _kw_merge);

-- Re-point child rows. serp_snapshots has no uniqueness on keyword_id.
UPDATE serp_snapshots
   SET keyword_id = (SELECT survivor FROM _kw_merge WHERE loser = serp_snapshots.keyword_id)
 WHERE keyword_id IN (SELECT loser FROM _kw_merge);

-- keyword_metrics / rankings: a row that would duplicate the survivor's grain
-- (0200 unique keys) is left on the merged row and removed with it; research
-- cache entries that pointed at such a row are re-pointed to the survivor's
-- identical-grain row first.
UPDATE research_cache
   SET payload_ref = 'db:keyword_metrics:' || (
         SELECT m2.id
           FROM keyword_metrics m1
           JOIN _kw_merge k ON k.loser = m1.keyword_id
           JOIN keyword_metrics m2 ON m2.site_id = m1.site_id AND m2.keyword_id = k.survivor AND m2.provider = m1.provider
                                  AND COALESCE(m2.location_code, -1) = COALESCE(m1.location_code, -1)
                                  AND COALESCE(m2.language_code, '') = COALESCE(m1.language_code, '')
                                  AND m2.collected_at = m1.collected_at
          WHERE 'db:keyword_metrics:' || m1.id = research_cache.payload_ref)
 WHERE payload_ref IN (
         SELECT 'db:keyword_metrics:' || m1.id
           FROM keyword_metrics m1
           JOIN _kw_merge k ON k.loser = m1.keyword_id
           JOIN keyword_metrics m2 ON m2.site_id = m1.site_id AND m2.keyword_id = k.survivor AND m2.provider = m1.provider
                                  AND COALESCE(m2.location_code, -1) = COALESCE(m1.location_code, -1)
                                  AND COALESCE(m2.language_code, '') = COALESCE(m1.language_code, '')
                                  AND m2.collected_at = m1.collected_at);

UPDATE OR IGNORE keyword_metrics
   SET keyword_id = (SELECT survivor FROM _kw_merge WHERE loser = keyword_metrics.keyword_id)
 WHERE keyword_id IN (SELECT loser FROM _kw_merge);

UPDATE OR IGNORE rankings
   SET keyword_id = (SELECT survivor FROM _kw_merge WHERE loser = rankings.keyword_id)
 WHERE keyword_id IN (SELECT loser FROM _kw_merge);

DELETE FROM keyword_metrics WHERE keyword_id IN (SELECT loser FROM _kw_merge);
DELETE FROM rankings WHERE keyword_id IN (SELECT loser FROM _kw_merge);

-- One audit event per affected site (audit_events is append-only; INSERT is allowed).
INSERT INTO audit_events (site_id, at, actor, event_type, subject_type, subject_id, details_json)
SELECT site_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'migration', 'keywords.language_duplicates_merged', 'migration', '0203_keyword_language_dedup',
       json_object('mergedRows', COUNT(*), 'mergedIds', json_group_array(loser), 'rule', 'merged into the NULL-language row of the same normalized query')
  FROM _kw_merge
 GROUP BY site_id;

DELETE FROM keywords WHERE id IN (SELECT loser FROM _kw_merge);

DROP TABLE _kw_merge;
DROP TABLE _kw_primary;
