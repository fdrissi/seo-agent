# ADR 0004: Versioned ingestion revisions with a current view

- Status: Accepted
- Date: 2026-09-24

## Context

Search Console and GA4 revise recent data for days after the fact, and a
report or experiment must be reproducible against what was known at the
time. Re-running a sync must not double count, a row that disappears from a
later response is not proof of zero, and property totals must never be added
to page or page/query rows (spec sections 6, 11, 12).

## Decision

- Each metric table has a documented grain and a unique "current" key
  (`VERSIONED_KEYS` in `src/integrations/google/versioned.ts`), enforced by a
  partial unique index `... WHERE is_current = 1`.
- Every sync runs inside an `ingestion_batches` row that records the request
  (dimensions, filters, date range), completeness, truncation, and the
  transformation version.
- A row is inserted as a **new revision** only when its content hash changed;
  the previous revision is flipped to `is_current = 0` first. Unchanged rows
  are left alone, so a re-run never double counts.
- Keys that a later **complete** request over the same scope no longer
  returns are retired (`is_current = 0`, `superseded_by_batch_id`), never
  deleted and never rewritten as zero. Retirement is skipped when the later
  response was truncated, sampled, thresholded, or bucketed.
- Readers use the `*_current` views; history stays queryable.
- Property totals, page totals, and page/query detail are separate tables.

## Consequences

- Delayed revisions are visible (revision 2, 3, ...) and auditable.
- Experiments can freeze measurement versions and later re-evaluations append
  rather than overwrite (ADR 0007 and `experiment_evaluations`).
- Storage grows with revisions; recent days churn most. Acceptable at
  single-site scale.
- Rows that vanish on thresholded GA4 properties stay current and are
  counted as `staleRowsRetained` with a warning, because absence proves
  nothing there.

## Alternatives considered

- Upsert in place: loses history and silently changes past reports.
- Delete-and-reload a date range: double counting on partial failure,
  invented zeros for vanished rows.
- Append-only raw events with aggregation at query time: heavy for the
  expected volumes and still needs a current-view rule.

## References

- `src/integrations/google/versioned.ts`, `migrations/0004_search_analytics.sql`, `migrations/0100_google_ingestion_revisions.sql`
- `tests/integration/google/gsc-sync.test.ts`, `tests/integration/google/ga4-sync.test.ts`, `tests/integration/database/schema-invariants.test.ts`
- `docs/modules/google.md` (Versioned ingestion)
