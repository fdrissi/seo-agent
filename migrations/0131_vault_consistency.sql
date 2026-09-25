-- 0131_vault_consistency: additive schema for vault write consistency and the
-- business-note sync history (src/obsidian). No existing column changes.
--
-- vault_notes.pending_generated_hash / pending_generated_keys_json: the hash
-- (and owned keys) of the generated content a write is about to commit. Set
-- before the file is replaced and cleared by the database update that follows,
-- so a crash between the two is recognized on the next render instead of being
-- reported as a human edit.
ALTER TABLE vault_notes ADD COLUMN pending_generated_hash TEXT;
ALTER TABLE vault_notes ADD COLUMN pending_generated_keys_json TEXT CHECK (pending_generated_keys_json IS NULL OR json_valid(pending_generated_keys_json));

-- business_note_revisions: every time `vault import-business --apply` records
-- the current content of a business note. business_note_versions keeps one row
-- per distinct content (UNIQUE site_id, note_path, content_hash), so a note that
-- returns to earlier content (A -> B -> A) is recorded here as a new revision
-- that points at the existing version row.
CREATE TABLE business_note_revisions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  note_path TEXT NOT NULL,
  revision INTEGER NOT NULL,
  version_id TEXT NOT NULL REFERENCES business_note_versions(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  UNIQUE (site_id, note_path, revision)
);
CREATE INDEX idx_business_note_revisions_version ON business_note_revisions (site_id, version_id);

-- business_profile_applications: every explicit, confirmed application of a
-- business profile version to the site config (`vault apply-business --confirm`).
-- Append-only history; business_note_versions.applied_* hold the latest one.
CREATE TABLE business_profile_applications (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES business_note_versions(id) ON DELETE CASCADE,
  revision_id TEXT REFERENCES business_note_revisions(id) ON DELETE CASCADE,
  note_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  diff_hash TEXT NOT NULL,
  config_version INTEGER NOT NULL,
  config_changed INTEGER NOT NULL CHECK (config_changed IN (0, 1)),
  changes_json TEXT CHECK (changes_json IS NULL OR json_valid(changes_json)),
  applied_at TEXT NOT NULL,
  applied_by TEXT NOT NULL
);
CREATE INDEX idx_business_profile_applications_version ON business_profile_applications (site_id, version_id, applied_at);
CREATE TRIGGER business_profile_applications_no_update BEFORE UPDATE ON business_profile_applications
BEGIN SELECT RAISE(ABORT, 'business_profile_applications is append-only'); END;
