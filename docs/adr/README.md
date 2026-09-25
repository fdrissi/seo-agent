# Architectural decision records

Each record states one decision, why it was made, what it costs, and what was
rejected. Records are append-only: a changed decision gets a new record that
supersedes the old one (the old record's status is updated to point at it).

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-node-sqlite.md) | Use Node's built-in `node:sqlite` instead of native SQLite bindings | Accepted |
| [0002](0002-private-workspace-outside-repo.md) | Keep all real data in a private workspace outside the repository | Accepted |
| [0003](0003-integer-micro-usd.md) | Store money as integer micro-USD; unknown cost is `null`, never 0 | Accepted |
| [0004](0004-versioned-ingestion-revisions.md) | Versioned ingestion revisions with a current view | Accepted |
| [0005](0005-qdrant-rebuildable-index.md) | Qdrant is a rebuildable index; SQLite FTS5 is the fallback | Accepted |
| [0006](0006-deterministic-router-first.md) | Deterministic router first; models only for genuine ambiguity | Accepted |
| [0007](0007-approvals-bound-to-artifact-hash.md) | Approvals are bound to the exact artifact hash and revision | Accepted |
| [0008](0008-manual-export-publisher-v1.md) | Manual-export publisher only in version 1 | Accepted |
| [0009](0009-fetch-based-adapters.md) | Fetch-based adapters over vendor SDKs | Accepted |
| [0010](0010-supply-chain-posture.md) | Supply-chain posture: few pinned dependencies, no install scripts | Accepted |

Template for a new record: copy any record, keep the headings (Status,
Context, Decision, Consequences, Alternatives considered, References), and add
a row above.
