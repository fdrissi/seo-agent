-- 0320_ga4_rate_scale_confirmation: how the scale of GA4 key-event rates
-- (sessionKeyEventRate:<event>, userKeyEventRate:<event>) was established for
-- a property, when values alone never prove it (spec 12, spec 6).
--
-- The GA4 documentation calls these metrics percentages but does not say
-- whether values are 0-1 or 0-100. A value above 1 proves 0-100 (recorded in
-- ga4_property_metadata.key_event_rate_scale since migration 0100). Nothing in
-- the values alone proves 0-1, and a property whose rates never exceed 1 would
-- otherwise stay 'undetermined' forever. This table records the two other ways
-- the scale is established:
--   owner_assertion      the owner compared a stored value with the GA4
--                        interface and confirmed the scale with
--                        `sync ga4 --confirm-rate-scale fraction|percent --evidence <text>`
--   integer_consistency  the sync proved 0-1 from stored daily rows: on small
--                        rows (1-99 sessions) every nonzero rate x sessions is
--                        a whole number of converting sessions, which is
--                        impossible on a 0-100 scale for rates <= 1
-- Append-only: a later row supersedes an earlier one (the latest row counts).
-- Each confirmation is also written to the audit log.
--
-- When the scale is established, stored rates marked 'undetermined' are
-- re-marked as NEW revisions (the earlier revision is kept, is_current = 0):
--   fraction -> value unchanged, primary_session_rate_scale / rate_scale = 'fraction'
--   percent  -> value / 100,     primary_session_rate_scale / rate_scale = 'percent_normalized'
-- No new collection happened, so the new revision keeps the batch_id and
-- collected_at of the revision it replaces, the replaced revision's
-- superseded_by_batch_id is that same batch, and transformation_version
-- records the confirmation: '<version>+rate-scale@<confirmation id>'.
CREATE TABLE ga4_rate_scale_confirmations (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL,
  scale TEXT NOT NULL CHECK (scale IN ('fraction', 'percent')),
  basis TEXT NOT NULL CHECK (basis IN ('owner_assertion', 'integer_consistency')),
  evidence TEXT NOT NULL CHECK (length(trim(evidence)) > 0),
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  actor TEXT NOT NULL,
  -- Rows re-marked when this confirmation was recorded: {"landingRows": n, "periodRows": n}.
  remarked_json TEXT CHECK (remarked_json IS NULL OR json_valid(remarked_json)),
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  confirmed_at TEXT NOT NULL
);
CREATE INDEX idx_ga4_rate_scale_confirmations ON ga4_rate_scale_confirmations (site_id, property_id, confirmed_at);

CREATE TRIGGER ga4_rate_scale_confirmations_no_update BEFORE UPDATE ON ga4_rate_scale_confirmations
BEGIN SELECT RAISE(ABORT, 'ga4_rate_scale_confirmations is append-only'); END;
CREATE TRIGGER ga4_rate_scale_confirmations_no_delete BEFORE DELETE ON ga4_rate_scale_confirmations
WHEN EXISTS (SELECT 1 FROM sites WHERE id = OLD.site_id)
BEGIN SELECT RAISE(ABORT, 'ga4_rate_scale_confirmations is append-only; rows are removed only with their site'); END;
