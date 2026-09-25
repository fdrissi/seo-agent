-- 0300_ai_citation_manual_import: provenance for AI-citation observations
-- recorded through the explicit manual-import adapter (`ai-citations import`,
-- spec 17). Additive only; existing rows keep NULL, which means "not
-- recorded", never a guessed value.
--
-- Semantics kept from 0005/0200: one row is one AI answer observation per
-- (site, engine, query, prompt, location, method, checked_at). A brand
-- mention is not a citation, a citation is not a click, a click is not a
-- conversion, and an ungrounded model response (is_grounded = 0) is never a
-- live search measurement.

-- Tool or person that captured the observation, as supplied by the owner
-- (for example "manual check" or "visibility tool export"). Free text; the
-- application never claims to have contacted that tool.
ALTER TABLE ai_citation_checks ADD COLUMN source_label TEXT;

-- The calendar date of the observation in checked_date_tz, and whether the
-- source stated an exact instant ('instant') or only a date ('day'). For a
-- day-precision observation checked_at is 12:00 in checked_date_tz so the
-- stored instant stays inside the stated date; the time of day is unknown.
ALTER TABLE ai_citation_checks ADD COLUMN checked_date TEXT;
ALTER TABLE ai_citation_checks ADD COLUMN checked_date_tz TEXT;
ALTER TABLE ai_citation_checks ADD COLUMN checked_at_precision TEXT CHECK (checked_at_precision IS NULL OR checked_at_precision IN ('instant', 'day'));

-- SHA-256 of the stored response text (NULL when no response text was
-- supplied), so a re-import can tell an identical observation from a
-- conflicting one without loading the raw record.
ALTER TABLE ai_citation_checks ADD COLUMN response_sha256 TEXT;

-- Version of the in-code parsing and matching (brand mention from the
-- response text, own-site citation from the cited URLs) that produced
-- brand_mentioned / own_site_cited.
ALTER TABLE ai_citation_checks ADD COLUMN transformation_version TEXT;

-- When the row was recorded in this database (checked_at is when the answer
-- was observed).
ALTER TABLE ai_citation_checks ADD COLUMN collected_at TEXT;

CREATE INDEX idx_ai_citation_checks_site_checked ON ai_citation_checks (site_id, checked_at);
