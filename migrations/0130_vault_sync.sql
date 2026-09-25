-- 0130_vault_sync: additive columns for vault conflict detection and the
-- business-note sync workflow (src/obsidian). No existing column changes.
--
-- vault_notes.generated_keys_json: the frontmatter keys the generator owned at
-- the last write. Needed to hash exactly the generated properties on disk, so a
-- human edit to a generated property is detected (conflict artifact) while
-- human-added properties are preserved and never cause a conflict.
ALTER TABLE vault_notes ADD COLUMN generated_keys_json TEXT CHECK (generated_keys_json IS NULL OR json_valid(generated_keys_json));
ALTER TABLE vault_notes ADD COLUMN conflict_detected_at TEXT;

-- business_note_versions: per-note version number and the explicit, human
-- confirmed application of a version to the site configuration. Frontmatter in
-- the note can never set these; only `vault apply-business --confirm <hash>`.
ALTER TABLE business_note_versions ADD COLUMN note_type TEXT;
ALTER TABLE business_note_versions ADD COLUMN version INTEGER;
ALTER TABLE business_note_versions ADD COLUMN applied_config_version INTEGER;
ALTER TABLE business_note_versions ADD COLUMN applied_at TEXT;
ALTER TABLE business_note_versions ADD COLUMN applied_by TEXT;
CREATE INDEX idx_business_note_versions_path ON business_note_versions (site_id, note_path, imported_at);
