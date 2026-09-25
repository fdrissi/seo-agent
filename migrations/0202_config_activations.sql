-- 0202_config_activations: which configuration version was active when.
--
-- config_versions keeps one row per distinct configuration hash, so a return
-- to an earlier configuration (A -> B -> A) reused the old version number and
-- left no trace. config_activations is an append-only history of every change
-- of sites.active_config_version (src/database/sites.ts ensureSite), each
-- also recorded as a 'config.activated' audit event. Experiment and report
-- config provenance is reconstructed from it, not from version numbers.
-- Grain: one row per activation (site, activated_at, version).
CREATE TABLE config_activations (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  previous_version INTEGER,                  -- NULL = first activation recorded for the site
  config_hash TEXT,                          -- NULL only for rows back-filled without a recorded hash
  source TEXT NOT NULL CHECK (source IN ('setup', 'file', 'business_note_sync', 'migration', 'demo')),
  activated_at TEXT NOT NULL                 -- version refers to config_versions (site_id, version)
);
CREATE INDEX idx_config_activations_site ON config_activations (site_id, activated_at);

CREATE TRIGGER config_activations_no_update BEFORE UPDATE ON config_activations
BEGIN SELECT RAISE(ABORT, 'config_activations is append-only'); END;

CREATE TRIGGER config_activations_no_delete BEFORE DELETE ON config_activations
WHEN EXISTS (SELECT 1 FROM sites WHERE id = OLD.site_id)
BEGIN SELECT RAISE(ABORT, 'config_activations is append-only; rows are removed only with their site'); END;

-- Back-fill from existing history. Every recorded version was activated when
-- it was created (ensureSite activates a new version immediately).
INSERT INTO config_activations (id, site_id, version, previous_version, config_hash, source, activated_at)
SELECT 'cfgact_mig_' || cv.site_id || '_' || cv.version,
       cv.site_id,
       cv.version,
       (SELECT MAX(p.version) FROM config_versions p WHERE p.site_id = cv.site_id AND p.version < cv.version),
       cv.config_hash,
       cv.source,
       cv.created_at
  FROM config_versions cv;

-- A site whose active version is not its newest version returned to an
-- earlier configuration at some unrecorded time; the latest evidence of that
-- is sites.updated_at. Recorded with source 'migration' (inferred).
INSERT INTO config_activations (id, site_id, version, previous_version, config_hash, source, activated_at)
SELECT 'cfgact_mig_return_' || s.id,
       s.id,
       s.active_config_version,
       (SELECT MAX(v.version) FROM config_versions v WHERE v.site_id = s.id),
       (SELECT c.config_hash FROM config_versions c WHERE c.site_id = s.id AND c.version = s.active_config_version),
       'migration',
       s.updated_at
  FROM sites s
 WHERE s.active_config_version IS NOT NULL
   AND s.active_config_version <> (SELECT MAX(v.version) FROM config_versions v WHERE v.site_id = s.id);
