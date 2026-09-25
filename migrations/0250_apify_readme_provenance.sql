-- 0250_apify_readme_provenance: additive provenance for Apify actor builds and runs.
--
-- apify_actor_schemas.provenance_json: what `apify inspect` retrieved with the
-- build besides its input schema, as JSON:
--   {
--     "readme": { "sha256": "<hex>", "retrievedAt": "<ISO-8601 UTC>", "length": <chars>,
--                 "passages": { "<key>": "<sha256 of the normalized passage>" | null } } | null,
--     "outputSchema": { "checkedAt": "<ISO-8601 UTC>", "fieldCount": <n>,
--                       "missingRequired": ["dataType", ...], "missingUsed": [...] } | null
--   }
-- README passages are the load-bearing parts of the actor documentation
-- (maxPostsCount semantics, RUN-SUMMARY fields, dedupe key). Only hashes are
-- stored, never the README text itself. NULL = not retrieved (legacy rows,
-- imports).
ALTER TABLE apify_actor_schemas ADD COLUMN provenance_json TEXT CHECK (provenance_json IS NULL OR json_valid(provenance_json));

-- apify_runs.items_normalized: dataset items that passed normalization (posts
-- and comments with a dataType and id). NULL = not normalized yet (or a run
-- recorded before this migration). A completed run with 0 normalized items is
-- never reused as research.
ALTER TABLE apify_runs ADD COLUMN items_normalized INTEGER;
