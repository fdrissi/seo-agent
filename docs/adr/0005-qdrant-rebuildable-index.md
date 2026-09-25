# ADR 0005: Qdrant is a rebuildable index; SQLite FTS5 is the fallback

- Status: Accepted
- Date: 2026-09-24

## Context

The spec requires Qdrant as the vector database, self-hosted with Docker
Compose, but also that the application keeps working when an optional
integration fails, that Qdrant is not authoritative, and that incompatible
vectors are never mixed. Embeddings cost money and depend on a model that may
change.

## Decision

- SQLite owns documents, chunks (original text, headings, provenance, content
  hash), embedding versions, an embedding cache, and tombstones. Qdrant holds
  only vectors plus a filter payload (no chunk text).
- One Qdrant collection per embedding version, named from provider, model,
  dimensions, and chunker version (`collectionNameFor`). A model or dimension
  change means a new collection or an explicit reindex; mismatched vectors
  are refused.
- Every point carries `site_id`, and every query must include the site filter
  (`assertSiteScoped`); results are post-filtered again.
- Retrieval fuses SQLite FTS5, Qdrant semantic search, and wikilink neighbors
  with reciprocal rank fusion (k = 60) under a fixed context budget.
- If Qdrant is disabled, down, or unauthorized, retrieval continues with FTS5
  only and reports `degraded`.
- `memory rebuild` and `memory reconcile` restore Qdrant from SQLite and the
  embedding cache without paid calls when the cache is complete.

## Consequences

- Losing Qdrant storage loses nothing: delete `<workspace>/qdrant` and
  rebuild. Backups only need SQLite.
- Core and Demo profiles run with full-text memory and no Docker.
- Superseded history is searchable only through FTS (Qdrant holds current
  chunks only).
- Two stores must be reconciled; deletion propagation uses tombstones and is
  tested across several edits between syncs.

## Alternatives considered

- Qdrant as the source of truth: backups and site isolation would depend on
  a service the Core profile does not run.
- SQLite-only vector search (an extension): would need a native extension
  (ADR 0001, ADR 0010) and does not meet the Qdrant requirement.
- A hosted vector service: excluded by the spec.

## References

- `src/memory/*.ts`, `compose.yaml`
- `tests/integration/memory/retrieval.test.ts`, `tests/integration/memory/indexer.test.ts`, `tests/integration/memory/deletion-propagation.test.ts`, `tests/e2e/honest-status.test.ts`
- `docs/modules/memory.md`
