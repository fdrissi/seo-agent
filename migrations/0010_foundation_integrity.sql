-- 0010_foundation_integrity: integrity fixes reported during slice integration.
--
-- 1. Reports are append-only: UPDATE was blocked in 0009; DELETE is blocked here.
--    Past reports are never rewritten or removed to make predictions look correct.
CREATE TRIGGER reports_no_delete BEFORE DELETE ON reports
BEGIN SELECT RAISE(ABORT, 'reports are append-only'); END;

-- 2. keywords: UNIQUE (site_id, normalized, language) treats NULL languages as
--    distinct in SQLite, so the same keyword without a language could be stored
--    twice. Enforce uniqueness with NULL treated as "no language".
CREATE UNIQUE INDEX uq_keywords_site_norm_lang ON keywords (site_id, normalized, COALESCE(language, ''));
