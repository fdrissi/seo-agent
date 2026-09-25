# Contributing to seo-agent

Thank you for helping. seo-agent is a self-hosted, local-first tool that other
people run against their real websites and paid accounts, so correctness,
honesty about data, and security matter more than feature count.

Read `AGENTS.md` (rules that are easy to break) and `docs/ARCHITECTURE.md`
(module boundaries and shared contracts) before changing code.

## Licensing of contributions

seo-agent is licensed under the MIT License (see `LICENSE`). By submitting a
contribution you agree that it is licensed under the same MIT License
(inbound = outbound). The owner has not yet decided whether contributions also
require a Developer Certificate of Origin sign-off (`git commit -s`) or a
Contributor License Agreement. Until that decision is published here, outside
pull requests may be reviewed but will not be merged.

## Development setup

Requirements: Node.js 24 LTS (see `.nvmrc`), npm, Git. Docker is only needed
for Qdrant or the optional container build.

```sh
nvm use                       # or install the Node version in .nvmrc
npm ci --ignore-scripts       # lockfile install, no install-time scripts
npm run typecheck
npm test                      # offline, synthetic fixtures only
npm run demo                  # synthetic demo in an isolated workspace
```

Recommended npm hardening (per user or per machine):

```sh
npm config set ignore-scripts true
npm config set min-release-age 7    # npm 11+: skip versions published in the last 7 days
npm config get min-release-age      # must print 7
```

npm reads `min-release-age` (days). A `minimumReleaseAge` line in `.npmrc` is
the pnpm setting (minutes) and is ignored by npm, which only prints
`npm warn Unknown user config "minimumReleaseAge"`; if you see that warning,
your release-age hardening is not in effect for npm.

Your private workspace (default `~/seo-agent-workspace`) must stay **outside**
the repository. Never point `--workspace` at a directory inside the clone.

## Tests are offline and synthetic

- `tests/setup.ts` makes the global `fetch` throw. Inject `FetchLike` fakes
  (`tests/helpers/fake-fetch.ts`) or use local `node:http` servers bound to
  `127.0.0.1`.
- Use `createTestContext()` (`tests/helpers/context.ts`) for database-backed
  tests: it creates a temporary workspace, migrated SQLite database, and a
  synthetic site.
- Fixtures live in `tests/fixtures/<area>/`, are clearly labeled synthetic
  (`"_synthetic": true` or a header comment), and use `example.com`, `*.test`,
  or `*.invalid`.
- Secret-shaped test values must be generated at test runtime or contain a
  marker such as `FAKE` or `SYNTHETIC`, so `npm run security:scan` stays clean.
- Prompt-injection tests should import the synthetic payloads from
  `src/security/injection-fixtures.ts` (or `tests/fixtures/security/injection/`).
- Live tests that could spend money require an explicit opt-in environment
  flag, are skipped by default, and never run in CI.

## Never commit real data

Do not commit, paste, or attach: real site configurations, credentials,
`.env` files, OAuth or service-account JSON, vault notes, SQLite databases,
raw API responses, crawled or scraped datasets, reports, logs, backups, or
diagnostic bundles. `.gitignore`, the `package.json` `"files"` allowlist, and
the `.dockerignore` allowlist protect the common paths, and
`npm run release:check` verifies them, but you are the first line of defense.

If you commit a secret by mistake, **rotate it first** (see `SECURITY.md`);
removing it from Git history is not enough.

## Coding rules (summary)

- TypeScript strict, ESM, `.js` suffix on local imports; parameterized SQL only.
- Every business row, job, budget, evidence record, and retrieval carries
  `site_id`.
- Money is integer USD micros; unknown cost is `null`, never `0`. Missing is not
  zero.
- IANA time zones only; no hardcoded UTC offsets.
- No owner-specific domains, event names, locations, languages, budgets,
  prices, or model IDs in application logic: they belong in site config.
- Never fabricate success: missing credentials, disabled features, offline
  mode, sandbox data, and failures produce honest, actionable statuses.
- Paid calls go through budget reservation and the provider-request log; never
  blindly retry a paid POST.
- Production actions require a valid human approval bound to the exact
  proposal. Markdown `approved: true` authorizes nothing.
- Untrusted text is data, never instructions. Runtime LLM calls get no shell,
  no unrestricted SQL, and no secrets.
- Schema changes are new forward-only migrations; never edit an applied one.
- CLI commands live in `src/cli/commands/<area>.ts` and export
  `register(program, cli)`.

## Before opening a pull request

```sh
npm run typecheck
npm test
npm run security:scan
npm run licenses:check    # if dependencies changed; commit the regenerated THIRD_PARTY_NOTICES.md
npm run release:check     # if packaging, Docker, .gitignore, or CI changed
```

Fill in the pull request template checklist honestly.

## Review rules for sensitive areas

Changes to these areas need focused review by a code owner (see
`.github/CODEOWNERS`) and a short impact statement in the PR description:

- `.github/workflows` and other CI configuration;
- authentication and secret handling (`src/auth`, `src/config/secrets.ts`,
  `src/security`);
- approvals, publishing, export, and mark-implemented (`src/approvals`,
  publisher/export code);
- budget enforcement, paid provider adapters, and workflow budget pre-flight
  (`src/budgets`, `src/integrations/*`, `src/workflows`, `src/jobs`);
- the secret-scan allowlist and rules (`scripts/secret-scan-allowlist.json`,
  `scripts/lib/secret-rules.mjs`): CI prints their diff on every pull request;
- release tooling and packaging (`scripts/`, `package.json`,
  `package-lock.json`, `Dockerfile`, `.dockerignore`, `.gitignore`);
- database migrations.

Reviewers look for: least privilege, no new secret exposure paths, honest
statuses, budget reservation before any paid call, approval binding, tests that
cover the failure paths, and documentation of any new data sent externally
(`docs/DATA_FLOWS.md`) or new costs (`docs/COSTS.md`).

CI runs only on GitHub-hosted runners with read-only permissions and no
secrets. Maintainers never run contributor code on machines that hold
production credentials.

## Dependencies

Add a dependency only when it clearly beats a small amount of local code. Pin
exact versions, check the license (`npm run licenses:check`), prefer packages
without install scripts, and explain the choice in the PR. Dependabot proposes
updates weekly with a cooldown; review changelogs before merging.
