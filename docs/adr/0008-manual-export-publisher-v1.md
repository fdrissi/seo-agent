# ADR 0008: Manual-export publisher only in version 1

- Status: Accepted
- Date: 2026-09-24

## Context

The spec asks for a complete manual-export and `mark-implemented` workflow in
version 1, a publisher interface, and a CMS-specific draft or Git-patch
adapter only after the actual platform is configured. It forbids inventing
generic WordPress or Webflow behavior or calling placeholder adapters
complete. No owner platform was configured or verified during the build.

## Decision

- `Publisher` interface (`prepare`, `publish`) in `src/approvals/publisher.ts`
  with exactly one implementation, `ManualExportPublisher`, which never
  touches production (`liveChange: false`).
- `export <draft|recommendation|experiment> <id>` writes an atomic,
  never-overwritten package under `<workspace>/exports/<site>/`: README,
  content (Markdown and escaped HTML), head snippet, metadata with the exact
  change and artifact hash, diff against the latest crawl, rollback files,
  checklist, and a manifest of file hashes. Production-bound exports need
  EXECUTE mode, a valid bound approval, one change per page, and an
  unchanged target recheck.
- The human deploys the package and records it with
  `experiments mark-implemented --at <time with zone> --revision <rev>`,
  which validates the approval, snapshots before/after, verifies the live
  page where the change is machine-checkable, and starts the observation
  window at the actual deployment time.
- `createPublisher()` throws `INTEGRATION_UNAVAILABLE` for `wordpress`,
  `webflow`, `cms_adapter`, and `git_patch`.

## Consequences

- Nothing can publish on its own; every change passes a human.
- The owner does the deployment step by hand; free-text changes (for example
  an audit instruction) are verified manually and recorded as `unverified`.
- A future adapter plugs into the same interface and approvals, after its
  platform API is verified and documented in `integration-contracts.md`.

## Alternatives considered

- A generic CMS adapter: would invent behavior for platforms nobody verified.
- Git patches against a guessed repository layout: same problem.

## References

- `src/approvals/publisher.ts`, `src/approvals/export.ts`, `src/approvals/implementation.ts`, `src/approvals/verify.ts`
- `tests/unit/approvals/publisher.test.ts`, `tests/integration/approvals/export.test.ts`, `tests/integration/approvals/mark-implemented.test.ts`
- `docs/modules/experiments-approvals.md` sections 3 and 4
