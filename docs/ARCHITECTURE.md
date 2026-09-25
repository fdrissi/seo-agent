# Architecture

seo-agent is a self-hosted, local-first TypeScript application. It measures a
website with first-party data, validates that data, routes cases with
deterministic rules, researches only shortlisted opportunities within budgets,
proposes one evidence-backed action (or an explicit no-action decision), and
requires human approval before anything touches production.

```
MEASURE -> VALIDATE DATA -> ROUTE -> PRIORITIZE -> RESEARCH -> PROPOSE
  -> HUMAN APPROVAL -> VERIFY IMPLEMENTATION -> MEASURE AGAIN -> RECORD LEARNINGS
```

## Public application vs private workspace

| Lives in the repository (public)                | Lives in the private workspace (default `~/seo-agent-workspace`) |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| `src/`, `prompts/`, `migrations/`, `tests/`      | `config/sites/<site-id>.yaml` (real site config)                  |
| `docs/`, `config/sites/example.site.yaml`       | `secrets/` (0700; `secrets.env`, Google credential files)         |
| `vault/_template/` (vault templates)            | `vault/<site-id>/` (Obsidian vault)                               |
| synthetic fixtures in `tests/fixtures/`          | `data/seo-agent.sqlite`, `data/raw/`, `data/cache/`, `qdrant/`    |
|                                                 | `reports/`, `exports/`, `logs/`, `backups/`, `diagnostics/`       |

Workspace resolution: `--workspace` flag > `SEO_AGENT_WORKSPACE` > `~/seo-agent-workspace`.
`init` never overwrites existing files, refuses the file-system root, the home
directory, the system temporary directory, and (by real path) any location
inside the repository. `workspace.json` may relocate workspace folders with a
`paths` block. A demo workspace runs only demo-profile sites and a live
workspace never runs one, checked when every command builds its context.
Upgrades never rewrite a workspace silently: the database changes only
through forward-only, checksummed migrations with a verified pre-migration
backup, and older site configs or workspace manifests are upgraded only by
`config migrate --yes` after the diff is shown (originals are backed up).

## Configuration precedence

1. CLI flags (per command)
2. Environment variables (process env, then `<workspace>/secrets/secrets.env`)
3. Site configuration (`config/sites/<site-id>.yaml`, validated by `src/config/site-schema.ts`)
4. Built-in defaults (profile defaults for feature flags: `src/config/profiles.ts`)

Secrets are only ever in the environment or the protected secrets file.
Public per-site IDs, paths, budgets, caps, and feature flags are in site config.

## Ownership of truth

- **SQLite** (`src/database`, `migrations/`) owns measurements, job state, budgets,
  approvals, provenance, and the audit log.
- **Obsidian-compatible Markdown** (`src/obsidian`) presents records and holds
  human-maintained business facts and decisions in designated notes.
- **Qdrant** (`src/memory`) is a rebuildable search index, never authoritative.

## Module map

| Directory | Responsibility |
| --- | --- |
| `src/core` | errors, `Measured<T>`, money (integer micro-USD), ids, hashing, clock, IANA time helpers, bounded concurrency, retry, logger, runtime modes, terminal-safe output (`terminal.ts`: control, bidi, and invisible characters shown as `[U+XXXX]` markers) |
| `src/config` | workspace paths/init (demo/live separation, `workspace.json` path overrides for `vaultDir`, `backupsDir`, `qdrantDir`, `exportsDir`, `reportsDir`; real-path comparisons that ignore letter case on a case-insensitive volume, `isWithinRealPath`), site config schema, config and workspace-format migrations (`config migrate`), profiles, env + secret store, runtime settings |
| `src/database` | `node:sqlite` wrapper (file databases created 0600), migrations (a compiled build applies only the migrations it was stamped with), backup/restore (database, site configs, vault, raw responses, and reports; a backup whose sites do not match the workspace kind is refused), raw-response store, audit log, site registry with append-only `config_activations` |
| `src/app` | `AppContext` (per-site dependencies passed to every module), the concrete service graph per context (`services.ts`), and the central wiring the CLI entry point installs (`wiring.ts`: job handlers, memory LLM client, content dependencies, status provider, SSRF-safe page fetcher) |
| `src/budgets` | reservations (synthetic demo, fixture, and sandbox reservations never use up the shared account cap), reconciliation with a recorded cost basis (provider-reported, computed from usage, manual; a verified $0 is a fixed zero; migration 0310), audited manual settlement with `costs reconcile`, provider-request log, spend reports |
| `src/auth` | Google OAuth desktop loopback flow (PKCE, state), service accounts, token storage, diagnostics |
| `src/integrations/google` | Search Console + GA4 adapters and versioned ingestion (coverage-based backfill, settling not-final page/query rows, GA4 key-event rate scale with owner confirmation; the printed confirmation command is one constant in `rate-scale-command.ts`), URL Inspection |
| `src/integrations/llm` | LLM Gateway (OpenAI-compatible) chat/structured/tools/embeddings, prompt registry, fixture client |
| `src/integrations/dataforseo` | allowlisted DataForSEO endpoints, queued tasks, sandbox (verified-$0 reservations), cache, costs |
| `src/integrations/apify` | generic Apify client + typed adapter for Actor `9sHOY9RzPYGjmTHo8`; bounded content-research batches, one run per community (`apify research`) |
| `src/integrations/pagespeed` | PageSpeed Insights (lab) and CrUX (field) adapters |
| `src/crawler` | SSRF-safe fetcher, robots, sitemaps, extraction, technical checks (versioned findings), heuristic AEO assessment (`crawl aeo`), competitor pages with a freshness TTL (URLs of a query only from its stored SERP, or owner-checked `--manual-urls`), optional Playwright |
| `src/seo` | URL normalization (RFC 3986 percent-encoding) and reconciliation, page types (`pages`; `pages.page_type_source`), metric aggregation and coverage (GA4 row loss, owner imports), GSC/GA4 joins, scoring, competitor comparison (persisted in `competitive_comparisons` by the weekly `compare` stage), internal links and the site-structure summary for reports, recommendations with prior context (experiments, rejections, owner decisions, memory) |
| `src/router` | deterministic routing rules with reason codes (each reason records the measured inputs it rests on, which recommendations cite as evidence) and an `UNSURE` route |
| `src/aeo` | optional AI-citation monitoring (`features.aiCitations`, off by default): manual import of observed AI answers (`ai-citations import`), in-code brand-mention and own-site-citation classification, summary and listing, honest status; no API collector |
| `src/workflows` | stage engine (sequential, bounded parallel, router) with checkpoints and optional paid work; baseline, weekly (including the free `site_structure` stage), monthly, and content-queue pipelines |
| `src/jobs` | durable jobs, per-site leases for jobs and manual commands (`manual-lease.ts`; the holder's process start time is recorded; `jobs locks` inspects them and releases a dead holder's lease), retries, circuit breakers (`jobs breakers`), cancellation, crash recovery, scheduling (never from a stale compiled build) |
| `src/memory` | chunking, embeddings, Qdrant adapter, FTS5, hybrid retrieval, reconciliation; indexing is skipped by policy (not degraded) when Qdrant or embeddings are disabled in the config |
| `src/obsidian` | vault writer (atomic, hash-checked, conflict artifacts), wikilinks, templates, business-note sync, renderers (page notes with AEO and internal-link sections), stale-note marking |
| `src/content` | content farming pipeline (defers items whose target page is under an observing experiment, `freeze.ts`; notes written through the vault renderer), briefs, drafts, quality gates (with the versioned structured-data requirement table), fact-check notes (`fact-notes.ts`, one renderer shared with the vault), human revision (`content revise-manual`) and human acceptance (`content mark-reviewed`; names validated for every caller), publication gate (`content publish-check`, the same human-acceptance rule as `export`) |
| `src/experiments` | experiment lifecycle, one concrete change per recommendation revision (`experiments specify-change`), measurement windows, comparison pages from one Search Console dataset, observational evaluation, learnings |
| `src/approvals` | runtime-mode policy, approval binding, approver names (`approver.ts`: asserted, not authenticated; obvious automation, account, and service-account names refused), publisher interface, manual export (a production-bound draft also needs a recorded human acceptance of its exact body), mark-implemented |
| `src/reports` | baseline/weekly/monthly Markdown + JSON reports, claim labels, site-structure sections (internal links, AEO), one dashboard builder |
| `src/data` | CSV/JSON exchange: `data export` of one dataset at its stored grain (reversible spreadsheet-formula guard; written inside `<workspace>/exports/data` unless `--out`), `data import` of Search Console exports and keyword lists as versioned ingestion batches that count as Search Console coverage (a re-imported `data export` keeps its synthetic label, property, segments, and finality; a demo workspace stores imports as synthetic, and a live workspace refuses a synthetic import; an explicit `--out` is refused inside the vault, `secrets/`, or the repository) |
| `src/setup` | resumable setup wizard (`setup`, `setup --only` step ids and groups), `doctor` (permissions, `--server`, compiled-build freshness, circuit breakers), build-stamp comparison and repair steps (`build-info.ts`: rebuild a checkout, reinstall a packaged install without `src/`) |
| `src/security` | redaction, path safety, SSRF guard, untrusted-content handling, allowlisted runtime tools, diagnostics export |
| `src/cli` | command framework; each area registers commands in `src/cli/commands/<area>.ts` (discovered automatically); manual commands that change data or spend money take the per-site lease while they run and refuse with `LOCKED` while it is held (`MUTATING_COMMANDS`, and `CONDITIONALLY_MUTATING_COMMANDS` for commands that write only with certain options); human output is terminal-safe, `--json` output exact |
| `src/demo` | offline demo using synthetic fixtures in an isolated workspace |
| `scripts/` | release tooling (secret scan, license check, release check; `lib/release-rules.mjs` parses the Dockerfile to check the build stage's inputs), `write-build-info.mjs` (stamps `dist/` after `npm run build`; `verifyBuildInfo` lets the release check test a packed build's freshness without importing `dist/`), `cli-reference.ts` (generates the reference sections of `docs/CLI.md`) |

## Key contracts (read before implementing a module)

- `src/app/context.ts` — `AppContext`: `db`, `config`, `settings`, `secrets`, `budgets`,
  `requests`, `raw`, `fetch`, `clock`, `logger`, `mode`, `dryRun`, `offline`, `synthetic`, `runId`.
  Every function that touches data takes `ctx` (or an explicit `siteId` + `db`).
- `src/integrations/types.ts` — `IntegrationStatus`, `FetchLike`, `offlineFetch`.
- `src/integrations/llm/types.ts` — `LlmClient` (structured/text/embed) and evidence bundles.
- `src/integrations/google/types.ts` — `GoogleApiClient`, `GoogleAuthProvider`.
- `src/memory/types.ts` — `MemoryRetriever`, `RetrievalQuery/Result`.
- `src/obsidian/types.ts` — `VaultWriter`, `GeneratedNote`, generated-region markers, vault folders.
- `src/workflows/types.ts` — `StageDefinition` (schemas, prerequisites, evidence, timeout, retry, cost allowance, stopping conditions, next states).
- `src/approvals/types.ts` — `ApprovalGate`.
- `src/budgets/budget-service.ts` — `reserve` / `reconcile` / `release` / `markUnresolved` / `report`.
- `src/budgets/provider-requests.ts` — outbound request log incl. ambiguous submissions.
- `migrations/*.sql` — the schema; every metric table documents its grain and unique key
  (migration 0200 added the unique keys that were missing, 0201 the provenance columns;
  `tests/integration/database/schema-invariants.test.ts` checks both by introspection).

## Conventions

- TypeScript strict, ESM, NodeNext resolution: import local files with the `.js` suffix.
- `node:sqlite` via `Db` (`run/get/all/transaction`). Parameterized SQL only. Transactions are synchronous.
- Money: integer USD micros (`src/core/money.ts`). Unknown cost is `null`, never `0`.
- Missing vs zero: use `Measured<T>` (`src/core/measured.ts`) and `*_status` columns.
- Dates: `YYYY-MM-DD` strings with an explicit IANA zone; timestamps ISO-8601 UTC.
- Time zones: IANA names only; never hardcode UTC offsets.
- Every business row, job, budget, evidence record, and retrieval carries `site_id`.
- Paid provider calls: cache -> estimate upper bound -> `budgets.reserve` -> `requests.prepare` ->
  submit with provider-side limits -> persist external id immediately -> `budgets.reconcile`.
  Never blindly retry a paid POST; mark `ambiguous` and reconcile.
- Offline/demo: `ctx.fetch` is `offlineFetch`; adapters must surface `fixture`/`offline`
  status instead of pretending success. Synthetic rows set `is_synthetic = 1`.
- All logs, raw files, reports, and CLI output pass through `src/security/redact.ts`.
- Untrusted text (scraped pages, Reddit, API text, retrieved notes) is data, never instructions.
- Vault writes go through `VaultWriter` (path traversal and symlink escape are rejected).
- Claim labels in reports: `OBSERVED`, `INFERRED`, `HYPOTHESIS`, `RECOMMENDATION`, `DATA_UNAVAILABLE`.

## Runtime prompts

Runtime prompt templates live in `prompts/<id>.md` with YAML frontmatter
(`id`, `version`, `role`, `tier`, `description`, `output_schema`) and `## System` /
`## User` sections using `{{variable}}` placeholders. Evidence is injected by the
LLM client inside clearly delimited untrusted-data blocks. The recorded
prompt version is `<id>@<version>+<sha256[0:8]>`.

## Tests

- `tests/unit/<area>/`, `tests/integration/<area>/`, `tests/e2e/`, fixtures in `tests/fixtures/<area>/`.
- `tests/setup.ts` blocks the real network; use `tests/helpers/fake-fetch.ts`.
- `tests/helpers/context.ts#createTestContext()` gives a temp workspace, migrated DB, synthetic site.
- Fixtures are synthetic and labeled (`"_synthetic": true` or a header comment); use `example.com`,
  `*.test`, or `*.invalid` domains. Never commit real data or third-party scraped datasets.
- Live tests that could spend money would require an explicit opt-in env flag and be skipped by default; none exists yet (every test is offline).
