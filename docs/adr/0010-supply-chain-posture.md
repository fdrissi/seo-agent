# ADR 0010: Supply-chain posture: few pinned dependencies, no install scripts

- Status: Accepted
- Date: 2026-09-24

## Context

The application holds API keys with spending power, Google credentials, and
private analytics. A compromised dependency would run with the same access.
The spec asks for pinned, compatible dependency versions, a committed
lockfile, dependency license checks, least-privilege CI, and review of
changes to workflows, authentication, publishing, and budgets.

## Decision

- **Few runtime dependencies**, each justified: `cheerio` (HTML parsing),
  `commander` (CLI), `croner` (IANA-zone cron), `fast-xml-parser` (sitemaps),
  `google-auth-library` (spec-mandated Google auth), `robots-parser`,
  `undici` (DNS-pinned transport), `yaml`, `zod`. Development only:
  `typescript`, `tsx`, `vitest`, `@types/node`. SQLite is built into Node
  (ADR 0001); HTTP adapters use fetch (ADR 0009).
- **Exact versions** in `package.json` (no ranges) and a committed
  `package-lock.json`. Installs use `npm ci --ignore-scripts` locally, in CI,
  and in the Dockerfile, so no install-time code runs.
- **Licenses**: `npm run licenses:check` verifies direct and transitive
  licenses and regenerates `THIRD_PARTY_NOTICES.md`; CI fails if it is stale.
- **Updates**: Dependabot opens weekly PRs with a 7-day cooldown for newly
  published versions; nothing is merged or deployed automatically. Live
  installations change only through tagged releases (`docs/UPGRADING.md`).
- **CI**: `permissions: contents: read`, push and pull-request triggers only,
  GitHub-hosted runners, fixtures only, no secrets. `CODEOWNERS` covers
  `.github/`, `src/auth`, `src/approvals` (publishing and export),
  `src/budgets`, and other sensitive paths (integrations, workflows, jobs,
  security, secret handling).
- **Release hygiene**: `npm run security:scan` scans the tree and full Git
  history without printing values; `npm run release:check` verifies the
  package and container allowlists; `package.json` stays `private: true`.

## Consequences

- Smaller attack surface and reproducible installs.
- Known open items (see FEATURE_STATUS): GitHub Actions are pinned by tag,
  not commit SHA; the Dockerfile base image is not digest-pinned; the CI
  workflow and the container build were never executed; `@OWNER` in
  `CODEOWNERS` is a placeholder until the owner sets it.
- Optional Playwright is not a dependency; installing it is an explicit
  owner decision that changes the lockfile.

## Alternatives considered

- Version ranges with automatic minor updates: convenient, but a compromised
  release would be installed without review.
- Vendoring dependencies: harder to update and audit at this size.

## References

- `package.json`, `package-lock.json`, `.github/workflows/ci.yml`, `.github/dependabot.yml`, `.github/CODEOWNERS`, `Dockerfile`
- `scripts/check-licenses.mjs`, `scripts/scan-secrets.mjs`, `scripts/release-check.mjs`
- `tests/integration/security/check-licenses.test.ts`, `tests/integration/security/release-check.test.ts`, `tests/unit/security/release-rules.test.ts`
- `docs/SECURITY_MODEL.md` sections 8 and 9, `docs/RELEASING.md`
