-- Embedding-space identity (spec section 8: "Never mix incompatible vectors").
--
-- The model id the provider REPORTS in each embeddings response is stored:
-- - on embedding_versions: the returned id that created the version (the
--   space its collection holds). A later batch whose returned id differs is
--   refused, so a gateway that re-routes to another provider or advances a
--   moving alias ("-latest") cannot mix vectors of the same dimensions.
-- - on embedding_cache: the returned id per cached vector (provenance).
--
-- NULL means unknown (rows written before this migration, or a response that
-- did not name its model). A version whose returned id is NULL adopts the id
-- of its next successful batch.

ALTER TABLE embedding_versions ADD COLUMN returned_model_id TEXT;
ALTER TABLE embedding_cache ADD COLUMN returned_model_id TEXT;
