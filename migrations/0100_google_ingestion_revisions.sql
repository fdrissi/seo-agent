-- 0100_google_ingestion_revisions: additive columns for versioned Google
-- ingestion (src/integrations/google). No existing column changes.
--
-- superseded_by_batch_id: the ingestion batch that made this row non-current
-- (NULL while the row is current, and for rows demoted before this migration).
-- Two cases:
--  * a newer revision of the same key was inserted by that batch, or
--  * RETIRED: a later COMPLETE request over the exact same scope (site,
--    property, search type or channel view, dates or period, segment set, page
--    filter) no longer returned this key. No newer revision exists for the key.
-- Either way the row is flipped to is_current = 0 so *_current views stop
-- counting it; it is never deleted and never rewritten as zero. Retirement is
-- skipped when the newer response was truncated, sampled, thresholded, or
-- bucketed into "(other)", because then an absent key proves nothing.
ALTER TABLE gsc_property_daily ADD COLUMN superseded_by_batch_id TEXT REFERENCES ingestion_batches(id) ON DELETE SET NULL;
ALTER TABLE gsc_page_daily ADD COLUMN superseded_by_batch_id TEXT REFERENCES ingestion_batches(id) ON DELETE SET NULL;
ALTER TABLE gsc_page_query_daily ADD COLUMN superseded_by_batch_id TEXT REFERENCES ingestion_batches(id) ON DELETE SET NULL;
ALTER TABLE ga4_landing_daily ADD COLUMN superseded_by_batch_id TEXT REFERENCES ingestion_batches(id) ON DELETE SET NULL;
ALTER TABLE ga4_event_daily ADD COLUMN superseded_by_batch_id TEXT REFERENCES ingestion_batches(id) ON DELETE SET NULL;
ALTER TABLE ga4_period_metrics ADD COLUMN superseded_by_batch_id TEXT REFERENCES ingestion_batches(id) ON DELETE SET NULL;

-- Rows of earlier batches that this batch retired (see above).
ALTER TABLE ingestion_batches ADD COLUMN rows_retired INTEGER NOT NULL DEFAULT 0;

-- Scale of GA4 key-event rates (sessionKeyEventRate:<event>,
-- userKeyEventRate:<event>). The API documentation calls them percentages but
-- does not say whether values are 0-1 or 0-100 (unverified contract).
--   'percent_normalized' = the API was observed to report 0-100 for this
--                          property; the stored value was divided by 100.
--   'undetermined'       = no value above 1 has ever been observed for this
--                          property; the value is stored exactly as reported
--                          and must NOT be treated as a verified fraction.
--   'fraction'           = reserved for a verified 0-1 scale.
-- NULL when the row carries no rate.
ALTER TABLE ga4_landing_daily ADD COLUMN primary_session_rate_scale TEXT CHECK (primary_session_rate_scale IS NULL OR primary_session_rate_scale IN ('fraction', 'percent_normalized', 'undetermined'));
ALTER TABLE ga4_period_metrics ADD COLUMN rate_scale TEXT CHECK (rate_scale IS NULL OR rate_scale IN ('fraction', 'percent_normalized', 'undetermined'));

-- Per-property memory of the detected key-event rate scale, so every later
-- sync (including incremental refreshes where all values are <= 1) stores
-- rates on the same scale. Once 0-100 has been observed it is sticky.
ALTER TABLE ga4_property_metadata ADD COLUMN key_event_rate_scale TEXT CHECK (key_event_rate_scale IS NULL OR key_event_rate_scale IN ('percent_0_100', 'undetermined'));
ALTER TABLE ga4_property_metadata ADD COLUMN key_event_rate_scale_json TEXT CHECK (key_event_rate_scale_json IS NULL OR json_valid(key_event_rate_scale_json));
