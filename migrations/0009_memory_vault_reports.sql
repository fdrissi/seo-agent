-- 0009_memory_vault_reports: memory documents/chunks with FTS5, embedding
-- versions and cache, vector index status, tombstones, vault note ownership,
-- business-note sync history, generated reports.
--
-- SQLite is authoritative. Qdrant is a rebuildable index: every vector can be
-- regenerated from memory_chunks + embedding_cache without new paid calls.

CREATE TABLE memory_documents (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('business_note', 'source_excerpt', 'competitor_finding', 'brief', 'experiment_summary', 'rejected_proposal', 'approved_learning', 'decision', 'report_summary', 'fixture')),
  source_ref TEXT NOT NULL,                  -- vault-relative note path, source id, or record id
  source_url TEXT,
  title TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'und',
  trust_class TEXT NOT NULL CHECK (trust_class IN ('owner_approved', 'first_party_measurement', 'third_party_data', 'user_reported', 'scraped_untrusted', 'model_generated', 'synthetic')),
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'rejected', 'deleted')),
  record_status TEXT,                        -- e.g. experiment outcome 'negative', proposal 'rejected' (kept visible at retrieval)
  access_scope TEXT NOT NULL DEFAULT 'site' CHECK (access_scope IN ('site', 'owner_only')),
  version INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT NOT NULL,
  source_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (site_id, source_type, source_ref)
);

CREATE TABLE memory_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES memory_documents(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  heading_path TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,                        -- original text preserved
  token_estimate INTEGER NOT NULL,
  content_hash TEXT NOT NULL,                -- normalized content hash
  chunker_version TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'und',
  document_version INTEGER NOT NULL,
  superseded INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (document_id, document_version, chunk_index)
);
CREATE INDEX idx_memory_chunks_site ON memory_chunks (site_id, superseded);
CREATE INDEX idx_memory_chunks_hash ON memory_chunks (content_hash);

-- Full-text index over chunks (external content; kept in sync by triggers).
CREATE VIRTUAL TABLE memory_chunks_fts USING fts5(
  text, heading_path,
  content = 'memory_chunks',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER memory_chunks_ai AFTER INSERT ON memory_chunks BEGIN
  INSERT INTO memory_chunks_fts (rowid, text, heading_path) VALUES (new.rowid, new.text, new.heading_path);
END;
CREATE TRIGGER memory_chunks_ad AFTER DELETE ON memory_chunks BEGIN
  INSERT INTO memory_chunks_fts (memory_chunks_fts, rowid, text, heading_path) VALUES ('delete', old.rowid, old.text, old.heading_path);
END;
CREATE TRIGGER memory_chunks_au AFTER UPDATE OF text, heading_path ON memory_chunks BEGIN
  INSERT INTO memory_chunks_fts (memory_chunks_fts, rowid, text, heading_path) VALUES ('delete', old.rowid, old.text, old.heading_path);
  INSERT INTO memory_chunks_fts (rowid, text, heading_path) VALUES (new.rowid, new.text, new.heading_path);
END;

-- Embedding space identity. Changing model or dimensions requires a new
-- version (and a separate Qdrant collection); vectors are never mixed.
CREATE TABLE embedding_versions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  chunker_version TEXT NOT NULL,
  collection_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_at TEXT NOT NULL,
  UNIQUE (provider, model_id, dimensions, chunker_version)
);

-- Dedup cache: one embedding per (embedding version, normalized content hash).
CREATE TABLE embedding_cache (
  embedding_version_id TEXT NOT NULL REFERENCES embedding_versions(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  vector BLOB NOT NULL,                      -- float32 little-endian
  created_at TEXT NOT NULL,
  PRIMARY KEY (embedding_version_id, content_hash)
);

-- Per-chunk vector index status.
CREATE TABLE chunk_index_status (
  chunk_id TEXT NOT NULL REFERENCES memory_chunks(id) ON DELETE CASCADE,
  embedding_version_id TEXT NOT NULL REFERENCES embedding_versions(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  point_id TEXT NOT NULL,                    -- UUID used as the Qdrant point id
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'indexed', 'failed', 'deleted')),
  error TEXT,
  indexed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chunk_id, embedding_version_id)
);
CREATE INDEX idx_chunk_index_status ON chunk_index_status (site_id, embedding_version_id, status);

-- Deletion propagation: tombstones are processed against Qdrant and kept for audit.
CREATE TABLE memory_tombstones (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  document_id TEXT,
  chunk_id TEXT,
  point_id TEXT,
  embedding_version_id TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  propagated_at TEXT
);
CREATE INDEX idx_tombstones_pending ON memory_tombstones (site_id, propagated_at);

CREATE TABLE memory_index_state (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  embedding_version_id TEXT NOT NULL REFERENCES embedding_versions(id) ON DELETE CASCADE,
  last_sync_at TEXT,
  last_reconcile_at TEXT,
  degraded INTEGER NOT NULL DEFAULT 0 CHECK (degraded IN (0, 1)),
  degraded_reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_id, embedding_version_id)
);

-- Vault note ownership and content hashes for conflict detection.
CREATE TABLE vault_notes (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  note_id TEXT NOT NULL,                     -- stable id stored in frontmatter
  kind TEXT NOT NULL,
  ownership TEXT NOT NULL CHECK (ownership IN ('generated', 'human', 'mixed')),
  last_written_hash TEXT,                    -- hash of the file content we last wrote
  last_generated_hash TEXT,                  -- hash of the generated sections we last wrote
  last_written_at TEXT,
  conflict_path TEXT,
  PRIMARY KEY (site_id, rel_path),
  UNIQUE (site_id, note_id)
);

-- Validated imports of human-maintained business notes, with version history.
CREATE TABLE business_note_versions (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  note_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  parsed_json TEXT CHECK (parsed_json IS NULL OR json_valid(parsed_json)),
  status TEXT NOT NULL CHECK (status IN ('imported', 'rejected', 'pending_review')),
  validation_errors_json TEXT CHECK (validation_errors_json IS NULL OR json_valid(validation_errors_json)),
  imported_at TEXT NOT NULL,
  UNIQUE (site_id, note_path, content_hash)
);

-- Generated reports. Append-only: past reports are never rewritten.
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('baseline', 'weekly', 'monthly', 'ad_hoc')),
  period_start TEXT,
  period_end TEXT,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  markdown_path TEXT,
  json_path TEXT,
  content_hash TEXT NOT NULL,
  summary_json TEXT CHECK (summary_json IS NULL OR json_valid(summary_json)),
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  generated_at TEXT NOT NULL
);
CREATE INDEX idx_reports_site ON reports (site_id, kind, generated_at);
CREATE TRIGGER reports_no_update BEFORE UPDATE ON reports
BEGIN SELECT RAISE(ABORT, 'reports are append-only'); END;
