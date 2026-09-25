-- Multilingual full-text fallback for memory (spec section 8: chunking and
-- retrieval must be multilingual; full-text search is the fallback when
-- Qdrant fails and the only mode of automated flows).
--
-- memory_chunks_fts (unicode61) does not segment scripts written without
-- spaces: a whole Chinese/Japanese/Thai run becomes one token, so a word in
-- the middle of a sentence never matches. This second external-content FTS5
-- index uses the trigram tokenizer (SQLite >= 3.34; case-insensitive), which
-- matches any substring of three or more characters. Retrieval routes queries
-- containing Han, Hiragana, Katakana, Hangul, or Thai characters to it and
-- fuses its ranking as another Reciprocal Rank Fusion list.
--
-- It is kept in sync exactly like memory_chunks_fts: by triggers on
-- memory_chunks (insert, delete, update of text/heading_path).

CREATE VIRTUAL TABLE memory_chunks_fts_trigram USING fts5(
  text, heading_path,
  content = 'memory_chunks',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER memory_chunks_trigram_ai AFTER INSERT ON memory_chunks BEGIN
  INSERT INTO memory_chunks_fts_trigram (rowid, text, heading_path) VALUES (new.rowid, new.text, new.heading_path);
END;
CREATE TRIGGER memory_chunks_trigram_ad AFTER DELETE ON memory_chunks BEGIN
  INSERT INTO memory_chunks_fts_trigram (memory_chunks_fts_trigram, rowid, text, heading_path) VALUES ('delete', old.rowid, old.text, old.heading_path);
END;
CREATE TRIGGER memory_chunks_trigram_au AFTER UPDATE OF text, heading_path ON memory_chunks BEGIN
  INSERT INTO memory_chunks_fts_trigram (memory_chunks_fts_trigram, rowid, text, heading_path) VALUES ('delete', old.rowid, old.text, old.heading_path);
  INSERT INTO memory_chunks_fts_trigram (rowid, text, heading_path) VALUES (new.rowid, new.text, new.heading_path);
END;

-- Index the chunks that already exist.
INSERT INTO memory_chunks_fts_trigram (memory_chunks_fts_trigram) VALUES ('rebuild');
