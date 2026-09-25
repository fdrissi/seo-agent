-- 0140_memory_links_state: additive memory tables (memory slice).
--
-- memory_document_keys: the keys a wikilink can use to reach a memory document
--   (vault path without ".md", note basename, record reference). Lowercased
--   and whitespace-normalized. Grain: one row per (document, key).
--
-- memory_links: wikilinks found in a memory document's current version, used
--   by hybrid retrieval as a transparent relationship signal. Rebuilt on every
--   document version change. Grain: one row per (document, normalized target).
--
-- memory_retrieval_state: last retrieval method and degraded status per site,
--   recorded even when no embedding version exists yet (memory_index_state
--   requires an embedding version, so "embeddings not configured" could not be
--   recorded there). Grain: one row per site.

CREATE TABLE memory_document_keys (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES memory_documents(id) ON DELETE CASCADE,
  link_key TEXT NOT NULL,
  PRIMARY KEY (document_id, link_key)
);
CREATE INDEX idx_memory_document_keys_key ON memory_document_keys (site_id, link_key);

CREATE TABLE memory_links (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  from_document_id TEXT NOT NULL REFERENCES memory_documents(id) ON DELETE CASCADE,
  target_key TEXT NOT NULL,
  link_count INTEGER NOT NULL DEFAULT 1 CHECK (link_count > 0),
  PRIMARY KEY (from_document_id, target_key)
);
CREATE INDEX idx_memory_links_target ON memory_links (site_id, target_key);

CREATE TABLE memory_retrieval_state (
  site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  last_method TEXT NOT NULL CHECK (last_method IN ('hybrid', 'fts_only')),
  degraded INTEGER NOT NULL DEFAULT 0 CHECK (degraded IN (0, 1)),
  degraded_reason TEXT,
  embedding_version_id TEXT REFERENCES embedding_versions(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);
