# Command-line reference

Every command below exists in this build. The reference sections were
regenerated from the registered command tree (`buildProgram()` in
`src/cli/main.ts`) with `npx tsx scripts/cli-reference.ts` on 2026-09-25.
`tests/unit/cli/aliases.test.ts` fails when a registered command is missing
from this page, when this page documents a command that does not exist, when
an option table differs from the options the command registers, or when an
npm alias points at a command that does not exist.
`npm run cli -- <command> --help` always shows the authoritative help for
your installed version.

Run commands from the repository root:

```sh
npm run cli -- <command> [subcommand] [options]
```

After `npm run build`, the same commands are available as
`node dist/cli/main.js <command>` (the `seo-agent` bin in `package.json`).

## Contents

- [Global options](#global-options)
- [Conventions: network, money, modes, and exit codes](#conventions-network-money-modes-and-exit-codes)
- [npm convenience aliases](#npm-convenience-aliases)
- [Spec section 29 command checklist](#spec-section-29-command-checklist)
- Reference: [Getting started and workspace](#getting-started-and-workspace),
  [Google access and ingestion](#google-access-and-ingestion),
  [Crawling and performance](#crawling-and-performance),
  [Pipelines](#pipelines-durable-jobs),
  [Pages, analysis, and research](#pages-analysis-and-research),
  [Content pipeline](#content-pipeline),
  [Memory and vault](#memory-and-vault),
  [Experiments, approvals, and export](#experiments-approvals-and-export),
  [Reports, data exchange, and costs](#reports-data-exchange-and-costs),
  [Jobs and scheduling](#jobs-and-scheduling),
  [Backup, restore, and diagnostics](#backup-restore-and-diagnostics)
- [How this reference is maintained](#how-this-reference-is-maintained)

## Global options

These options belong to the root program and work before or after the
command name (`npm run cli -- --json costs` and `npm run cli -- costs --json`
are equivalent). The `--help` of every command and subcommand lists them
under "Global Options", so `npm run cli -- sync gsc --help` shows `--site`,
`--dry-run`, `--json`, `--mode`, and `--offline` too.

| Option | Meaning |
| --- | --- |
| `-w, --workspace <dir>` | Private workspace directory. Precedence: `--workspace` > `SEO_AGENT_WORKSPACE` > `~/seo-agent-workspace`. |
| `-s, --site <id>` | Site id. Optional when the workspace has exactly one site. |
| `--dry-run` | Show what would happen without external requests, spending, or writes, where the command supports it. Pipelines run against a temporary copy of the database. |
| `--json` | Machine-readable JSON output (always redacted). |
| `--mode <mode>` | Runtime mode: `ANALYZE` (default), `RESEARCH`, `DRAFT`, `EXECUTE`. See below. |
| `--offline` | Forbid every network request for this invocation. |
| `-V, --version` | Print the application version. |
| `-h, --help` | Help for the program or any command. |

Environment variables (`SEO_AGENT_WORKSPACE`, `SEO_AGENT_LOG_LEVEL`, provider
credentials) are listed in [CONFIGURATION.md](CONFIGURATION.md#environment-variables).
Set `SEO_AGENT_DEBUG=1` to print stack traces of unexpected errors (still
redacted).

## Conventions: network, money, modes, and exit codes

**Network.** Status commands make no request unless you pass `--network`,
and then only free, read-only checks. `--offline` overrides everything.

**Money.** Nothing chargeable runs without an explicit flag that you type
yourself, and the cap is printed before anything is sent:

| Chargeable action | Required flags |
| --- | --- |
| One minimal LLM Gateway test request | `models test --confirm-spend --max-usd <cap>` or `doctor --allow-spend --max-usd <cap>` |
| DataForSEO research | `--mode RESEARCH research keyword ... --allow-spend` (`--sandbox` is free) |
| Apify test run | `--mode RESEARCH apify test --confirm-spend --max-usd <cap>` |
| Apify content research | `--mode RESEARCH apify research --confirm-spend --max-usd <total cap>`. Without the flags the command only prints the plan (runs, communities, per-run caps, plan hash). `--plan <hash>` starts only the exact plan you previewed. |
| LLM classification of Apify signals | `apify research ... --classify-with-llm --llm-max-usd <cap per request>`. Without it, signals are classified by the free English heuristics. |
| Embeddings | `memory sync --allow-paid`, `memory rebuild --allow-paid`, `memory search --allow-paid` |
| Model calls in the content pipeline | `--use-model` on `content` commands |
| Optional AI work in the baseline | `baseline --approve-cost-plan <usd>` |
| Weekly and monthly research | `--mode RESEARCH weekly` / `--mode RESEARCH monthly` (bounded by the configured budgets). Before the run starts, the per-run caps and the remaining DataForSEO, Apify, LLM, and combined budgets are printed to stderr, so `--json` output stays clean. |

Every paid request is still budget-reserved against the per-run, site,
service, and account ceilings in the site config. Unknown cost is never
recorded as $0. Budgets are ceilings, not price quotes (see
[COSTS.md](COSTS.md)). A charge that stays `unresolved` (for example an
ambiguous submission whose provider never reported a cost) is settled by a
named human from the provider's billing history with
[`costs reconcile`](#costs-reconcile). A charge is recorded as $0 only with the
explicit `--not-charged` statement.

**Runtime modes** (spec section 24). `ANALYZE` and `RESEARCH` may make
authorized, budgeted read requests and write local files; `RESEARCH` is
required for external research: paid DataForSEO and Apify runs
(`research keyword --allow-spend`, `apify test`, `apify research`, research
stages of `weekly` and `monthly`) and fetching competitor pages
(`crawl competitor`). In `ANALYZE` these commands refuse with
`POLICY_DENIED` before anything is sent. `DRAFT` creates local review artifacts
after the configured approval. `EXECUTE` is required for production-bound
exports and additionally needs a valid human approval bound to the exact
proposal. No command publishes to a live site: v1 ships a manual-export
publisher only. `jobs resume` runs jobs only up to the invoking mode, so a
job enqueued in RESEARCH mode is resumed with
`npm run cli -- --mode RESEARCH jobs resume <job-id>` (the hints print it).

**Human names.** Options that record a human decision (`--as`, `--by`,
`--reviewer`) are validated names. A name is asserted, not authenticated:
obvious automation and account names are refused (for example `system`,
`claude`, `agent007`, `claudecode`, `owner`, `admin`, `root`, `node`,
`runner`, look-alike or mixed-script spellings). Where the option may be
omitted, the operating-system user is recorded unless it is a service
account (`node` in the container image, `runner` on GitHub-hosted CI, `root`,
and similar); then the command is refused and asks for `--as "<your name>"`.
See [SECURITY_MODEL.md](SECURITY_MODEL.md#4-approval-spoofing-and-unauthorized-production-changes).

**Exit codes.**

| Code | Meaning |
| --- | --- |
| 0 | Success, including degraded pipeline runs that say so and jobs waiting for a human review. |
| 1 | Error, failed or interrupted job, locked site (`LOCKED`), (doctor) at least one failing check, or `research keyword` whose every query failed (status `failed`). |
| 2 | Partial result or a problem found: `sync` with partial data, `sync inspect` that inspected nothing (`nothing_inspected`), `data import` with skipped rows, `ai-citations import` with skipped rows or rows that conflict with stored observations, `models check` with a model problem, `research keyword` with a partial, skipped, or ambiguous result (for example one query from the cache and one failed, or every query skipped because the location could not be verified), `apify test` or `apify research` shown without `--confirm-spend` (plan only). |
| 3 | Refused for a missing precondition: `CREDENTIALS_MISSING`, `INTEGRATION_DISABLED`, `BUDGET_EXCEEDED`, or a paid research run without its flags (`research keyword` also exits 3 when a query was refused by policy, the budget, or an unknown price). |
| 130 | The setup wizard was interrupted (Ctrl+C or end of input); the draft is kept for resuming. |

**Site lock.** A `baseline`, `weekly`, or `monthly` job holds its site's lock
(a lease renewed by heartbeats) while it runs. Manual commands that change
data or spend money take the same lease themselves while they run, and refuse
with `LOCKED` for as long as a live lease exists:
`sync gsc`, `sync ga4`, `sync inspect`, `crawl`, `crawl page`,
`crawl competitor`, `research keyword`, `perf check`, `analyze page`,
`analyze route`, `analyze reconcile`, `report build`, `vault render`,
`content brief`, `content draft`, `content review`, `content batch`,
`content bootstrap`, `content import`, `content measure`,
`experiments review`, `export`, `apify test`, `apify research`,
`apify import-schema`, `apify inspect`, `data import`, `pages set-type`,
`memory sync`, `memory rebuild`, `memory reconcile`, `models test`, and
`costs reconcile`.
They do nothing, and the message names the holder and the next step
(`jobs show`, wait, or `jobs cancel`; for another manual command's lease,
`jobs locks`). Some commands take the lease only with the options that make
them write or spend: `memory search` with `--allow-paid` (a query embedding
that is not cached is a paid request), `pages infer-types` and
`vault import-business` with `--apply`, `research tasks` with `--poll` or
`--abandon`, and `apify runs` with `--resume` or `--confirm-not-accepted`;
without them they only preview or list, and are not refused.
`ai-citations import` checks the lock itself and refuses with `LOCKED` while
a job holds it. `--dry-run` previews and read-only commands neither take nor
check the lease.

Because a manual command holds the lease while it runs (90-second lease,
renewed every 15 seconds; `src/jobs/manual-lease.ts`), a scheduled or
foreground job of the same site cannot start in the middle of a long manual
crawl: the scheduler leaves its job queued for the next tick, and a
foreground pipeline refused with `LOCKED` closes the job it just created as
`cancelled`, so nothing is left queued. Two manual commands never hold the
lease at once. The lease is released when the command ends, also when it
fails. An expired lease (from a crashed holder, or a holder on another host)
no longer blocks anything, but an expired lease whose holder process is still
alive on this machine (a laptop that just woke up and has not renewed it yet)
is not taken over. For a manual command's lease, "alive" means the same
process: the lease records the process's start time, so a process id that
another process reused after a crash or reboot does not count. A live holder
that has still not renewed its lease 60 seconds (four heartbeats) after a
refused command or scheduler tick first saw it expired counts as hung, and
the next attempt takes the lease over (the sighting is audited as
`lock.unrenewed_seen`). `jobs locks` shows each lease and whether its holder
process is alive; `jobs locks --release <lock> --as "<your name>"` removes a
lease whose holder process is verified dead on this machine (audited as
`lock.released_dead_holder`; automation names are refused). The lists are
`MUTATING_COMMANDS` and `CONDITIONALLY_MUTATING_COMMANDS` in
`src/cli/runtime.ts` (`npx tsx scripts/cli-reference.ts --site-lock` prints
them), and `tests/integration/cli/site-lock.test.ts` fails when a new command
is not classified.

One documented exception: content jobs (`content queue`, `content produce`)
hold a separate `content` lock. They can run beside a weekly job of the same
site, and a running content job does not make most manual commands refuse
(only the site lock does). Two exceptions check the `content` lock too:
`content bootstrap` takes it while it runs (it creates content items and
briefs), and `content revise-manual` refuses while a job holds the site or
the content lock (it writes a draft version). Two content jobs never overlap. Spending stays bounded when a content job and a
weekly job run together, because every paid request reserves its upper bound
atomically against the same per-run, site, service, and account budgets.
Neither job can overspend by racing the other.

**Known discrepancy.** The help text of `report build --statuses` mentions
saved `doctor --json` output, but `--statuses` (on `report build` and
`report dashboard`) expects a JSON array of statuses (or an object with a
top-level `statuses` or `integrations` array), while `doctor --json` nests
them per site. Extract them first, for example
`npm run --silent doctor -- --json > doctor.json` then
`jq '.sites[0].integrations' doctor.json > statuses.json`. The `baseline`,
`weekly`, and `monthly` pipelines collect statuses themselves and are not
affected.

## npm convenience aliases

Each alias runs the same entry point as `npm run cli --`. Pass extra options
after `--`, for example `npm run sync:gsc -- --days 28 --dry-run`. Aliases
never embed options: spending flags, `--mode`, and overrides are always typed
by you (the alias test enforces this).

| Alias | Runs |
| --- | --- |
| `npm run demo` | `demo` |
| `npm run init-workspace` | `init` |
| `npm run setup` | `setup` |
| `npm run doctor` | `doctor` |
| `npm run baseline` | `baseline` |
| `npm run weekly` | `weekly` |
| `npm run monthly` | `monthly` |
| `npm run costs` | `costs` |
| `npm run sync:gsc` | `sync gsc` |
| `npm run sync:ga4` | `sync ga4` |
| `npm run crawl` | `crawl` |
| `npm run memory:sync` | `memory sync` |
| `npm run memory:search` | `memory search` (add the query: `npm run memory:search -- "question"`) |
| `npm run jobs` | `jobs list` |
| `npm run jobs:resume` | `jobs resume` |
| `npm run approvals` | `approvals list` |
| `npm run export` | `export` (add the subject: `npm run export -- draft <id>`) |
| `npm run backup` | `backup` |

Development scripts: `npm run typecheck`, `npm test`
(`test:unit`, `test:integration`, `test:e2e`), `npm run check`,
`npm run build`, `npm run security:scan`, `npm run licenses:check`,
`npm run release:check` (see [RELEASING.md](RELEASING.md)).

## Spec section 29 command checklist

| Spec command | Command in this build |
| --- | --- |
| setup | [`setup`](#setup) |
| doctor | [`doctor`](#doctor) |
| demo | [`demo`](#demo) |
| auth google / auth status | [`auth google`](#auth-google), [`auth status`](#auth-status) |
| sync gsc / sync ga4 | [`sync gsc`](#sync-gsc), [`sync ga4`](#sync-ga4) |
| crawl | [`crawl`](#crawl) |
| baseline / weekly / monthly | [`baseline`](#baseline), [`weekly`](#weekly), [`monthly`](#monthly) |
| research keyword | [`research keyword`](#research-keyword) |
| analyze page | [`analyze page`](#analyze-page) |
| apify inspect / apify test | [`apify inspect`](#apify-inspect), [`apify test`](#apify-test) |
| content discover / brief / draft / review | [`content discover`](#content-discover), [`content brief`](#content-brief), [`content draft`](#content-draft), [`content review`](#content-review) |
| experiments list / review / mark-implemented | [`experiments list`](#experiments-list), [`experiments review`](#experiments-review), [`experiments mark-implemented`](#experiments-mark-implemented) |
| approvals list / approve / reject | [`approvals list`](#approvals-list), [`approvals approve`](#approvals-approve), [`approvals reject`](#approvals-reject) |
| memory sync / search / rebuild | [`memory sync`](#memory-sync), [`memory search`](#memory-search), [`memory rebuild`](#memory-rebuild) |
| costs | [`costs`](#costs) |
| jobs list / jobs resume | [`jobs list`](#jobs-list), [`jobs resume`](#jobs-resume) |
| export / backup / restore | [`export`](#export), [`backup`](#backup), [`restore`](#restore) |

Every one of them accepts the global `--site`, `--dry-run` (where it makes
sense), and `--json` options.

## Getting started and workspace

<!-- generated reference: see "How this reference is maintained" -->

### `demo`

Offline demo on SYNTHETIC fixtures in an isolated demo workspace (no credentials, no network): baseline, interrupted + resumed weekly job, routing, sourced recommendation, content draft workflow, experiment, budget denials

```sh
npm run cli -- demo [options]
```

| Option | Meaning |
| --- | --- |
| `--dir <dir>` | demo directory (default <os tmpdir>/seo-agent-demo); a previous demo there is refreshed, anything else is refused |
| `--approver <name>` | name of the explicit demo approver persona that records the demo approvals (default "Demo Approver - synthetic persona") |
| `--start-at <iso>` | start of the simulated demo timeline (ISO-8601 with zone; default: two days ago) |

### `init`

Create a private workspace (never overwrites existing files; safe to re-run)

```sh
npm run cli -- init [options]
```

| Option | Meaning |
| --- | --- |
| `--allow-inside-repo` | allow a workspace inside the application repository (not recommended) |
| `--allow-existing-dir` | allow a non-empty directory without workspace.json (the layout is added next to the existing files; nothing is overwritten) |

### `workspace`

Workspace information

Subcommands: `status`.

#### `workspace status`

Show workspace location, sites, and schema status (read-only)

```sh
npm run cli -- workspace status
```

No command-specific options (global options apply).

### `setup`

Resumable setup wizard: asks only for missing information and saves after every answer (`setup vault` creates the site vault)

```sh
npm run cli -- setup [options] [target]
```

| Option | Meaning |
| --- | --- |
| `--from <yaml>` | import a prepared site config non-interactively (validated; unknown keys and secret values are refused) |
| `--update` | change an existing site config: the diff is shown before anything is written |
| `--only <steps>` | comma-separated wizard step ids or groups to ask (again), e.g. google.searchConsoleProperty or conversions (both conversion event steps) |
| `--list-steps` | list the wizard step ids and step groups, and exit |

`--only` accepts these wizard step ids and step groups (comma-separated; a group asks every step in it). `setup --list-steps` prints the same list.

| Step id | Section | Site config fields |
| --- | --- | --- |
| `profile` | Profile | `profile` |
| `site.businessName` | Website identity | `site.businessName` |
| `site.url` | Website identity | `site.url` |
| `site.allowedHostnames` | Website identity | `site.allowedHostnames` |
| `site.urlAliases` | Website identity | `site.urlAliases` |
| `business.offer` | Business | `business.offer` |
| `business.targetCustomer` | Business | `business.targetCustomer` |
| `business.differentiators` | Business | `business.differentiators` |
| `business.productFacts` | Business | `business.productFacts` |
| `business.approvedClaims` | Business | `business.approvedClaims` |
| `market.countries` | Target market | `market.countries` |
| `market.languages` | Target market | `market.languages` |
| `market.searchLocations` | Target market | `market.searchLocations` |
| `market.devices` | Target market | `market.devices` |
| `reporting.currency` | Reporting and time | `reporting.currency` |
| `reporting.businessTimezone` | Reporting and time | `reporting.businessTimezone` |
| `scheduler.timezone` | Reporting and time | `scheduler.timezone` |
| `google.auth` | Google access |  |
| `google.searchConsoleProperty` | Google access | `google.searchConsoleProperty` |
| `google.ga4PropertyId` | Google access | `google.ga4PropertyId` |
| `conversions.primaryEvents` | Conversions | `conversions.primaryEvents` |
| `conversions.secondaryEvents` | Conversions | `conversions.secondaryEvents` |
| `brand.aliases` | Brand and scope | `brand.aliases` |
| `crawl.protectedPaths` | Brand and scope | `crawl.protectedPaths` |
| `crawl.excludedPaths` | Brand and scope | `crawl.excludedPaths` |
| `research.approvedDomains` | Brand and scope | `research.approvedDomains` |
| `crawl.limits` | Brand and scope | `crawl.maxPages`, `crawl.maxDepth`, `crawl.requestDelayMs` |
| `research.competitors` | Research | `research.competitors` |
| `research.seedTopics` | Research | `research.seedTopics` |
| `research.subreddits` | Research | `research.subreddits` |
| `research.dataforseo.mode` | Research | `research.dataforseo.mode` |
| `editorial.brandVoice` | Editorial | `editorial.brandVoice` |
| `business.prohibitedClaims` | Editorial | `business.prohibitedClaims` |
| `editorial.rules` | Editorial | `editorial.avoidEmojis`, `editorial.avoidEmDashes`, `editorial.requirements` |
| `features` | Features | `features` |
| `credentials` | Credentials |  |
| `models` | Models | `models.cheap`, `models.reasoning`, `models.embedding` |
| `budgets` | Budgets | `budgets` |
| `scheduler.weekly` | Scheduling | `scheduler.weekly` |
| `scheduler.monthly` | Scheduling | `scheduler.monthly` |

| Step group | Steps |
| --- | --- |
| `site` | `site.businessName`, `site.url`, `site.allowedHostnames`, `site.urlAliases` |
| `business` | `business.offer`, `business.targetCustomer`, `business.differentiators`, `business.productFacts`, `business.approvedClaims`, `business.prohibitedClaims` |
| `market` | `market.countries`, `market.languages`, `market.searchLocations`, `market.devices` |
| `reporting` | `reporting.currency`, `reporting.businessTimezone` |
| `scheduler` | `scheduler.timezone`, `scheduler.weekly`, `scheduler.monthly` |
| `google` | `google.auth`, `google.searchConsoleProperty`, `google.ga4PropertyId` |
| `conversions` | `conversions.primaryEvents`, `conversions.secondaryEvents` |
| `brand` | `brand.aliases` |
| `crawl` | `crawl.protectedPaths`, `crawl.excludedPaths`, `crawl.limits` |
| `research` | `research.approvedDomains`, `research.competitors`, `research.seedTopics`, `research.subreddits`, `research.dataforseo.mode` |
| `research.dataforseo` | `research.dataforseo.mode` |
| `editorial` | `editorial.brandVoice`, `editorial.rules` |

### `doctor`

Check runtime, workspace, config, migrations, and every integration; no network by default and never spends money without --allow-spend --max-usd

```sh
npm run cli -- doctor [options]
```

| Option | Meaning |
| --- | --- |
| `--network` | also run free, read-only network checks (never chargeable) |
| `--allow-spend` | allow ONE chargeable check (a minimal LLM Gateway request); requires --max-usd |
| `--max-usd <cap>` | cost cap for the chargeable check, e.g. 0.01 |
| `--server` | apply the server checklist (docs/DEPLOYMENT.md): a workspace, data/ directory, or database readable by other users is a failure, not a warning |

### `config`

Validate and inspect site configuration

Subcommands: `validate`, `show`, `migrate`, `docs`, `schema`.

#### `config validate`

Validate a site config (workspace site, or --file) and list non-fatal warnings

```sh
npm run cli -- config validate [options]
```

| Option | Meaning |
| --- | --- |
| `--file <path>` | validate a specific YAML file |

#### `config show`

Show effective (non-secret) settings and where each override comes from

```sh
npm run cli -- config show
```

No command-specific options (global options apply).

#### `config migrate`

Upgrade site configs and workspace.json written in an older format: shows the diff; writes only with --yes (originals are copied to backups/config/<timestamp>/ first)

```sh
npm run cli -- config migrate [options]
```

| Option | Meaning |
| --- | --- |
| `--yes` | apply the shown migration (without it, nothing is written) |

#### `config docs`

Print the generated configuration reference (field table, profiles, environment variables) used in docs/CONFIGURATION.md

```sh
npm run cli -- config docs
```

No command-specific options (global options apply).

#### `config schema`

Print the JSON Schema of the site configuration

```sh
npm run cli -- config schema
```

No command-specific options (global options apply).

### `db`

Database schema status and migrations

Subcommands: `status`, `migrate`.

#### `db status`

Show applied and pending migrations (read-only)

```sh
npm run cli -- db status
```

No command-specific options (global options apply).

#### `db migrate`

Apply pending migrations (a verified pre-migration backup is written first); --dry-run lists them

```sh
npm run cli -- db migrate
```

No command-specific options (global options apply).

## Google access and ingestion

<!-- generated reference: see "How this reference is maintained" -->

### `auth`

Google authorization: authorize, status, revoke, and permission diagnostics (read-only scopes only)

Subcommands: `google`, `status`, `revoke`, `diagnose`.

#### `auth google`

Authorize read-only Search Console + GA4 access via the local OAuth desktop flow (browser + 127.0.0.1 loopback, PKCE)

```sh
npm run cli -- auth google [options]
```

| Option | Meaning |
| --- | --- |
| `--timeout <seconds>` | how long to wait for the browser redirect (default: `300`) |

#### `auth status`

Show auth mode, credential presence and expiry hints (never token values), accessible Search Console properties, and GA4 access

```sh
npm run cli -- auth status [options]
```

| Option | Meaning |
| --- | --- |
| `--no-network` | skip the free read-only Google calls (sites.list, GA4 getMetadata) |

#### `auth revoke`

Revoke the stored Google authorization at Google and delete the local token (reconnect with `auth google`)

```sh
npm run cli -- auth revoke [options]
```

| Option | Meaning |
| --- | --- |
| `--local-only` | only delete the local token file; do not contact Google |

#### `auth diagnose`

Diagnose Google permissions: API enablement, property access, testing-mode token expiry, property formats, least privilege

```sh
npm run cli -- auth diagnose [options]
```

| Option | Meaning |
| --- | --- |
| `--no-network` | skip the free read-only Google calls |

### `sync`

Ingest Google data (read-only): Search Console, GA4, URL Inspection

Subcommands: `gsc`, `ga4`, `inspect`.

#### `sync gsc`

Sync Search Console property totals, page totals, and top-page query detail (versioned; re-runs never double count)

```sh
npm run cli -- sync gsc [options]
```

| Option | Meaning |
| --- | --- |
| `--days <n>` | history window ending yesterday (Pacific time); default: 90 days initially, then incremental refresh |
| `--search-types <list>` | comma-separated search types (web, image, video, news, discover, googleNews); default from site config |
| `--segments <list>` | optional segment dimensions, only when needed (country, device, searchAppearance) |
| `--top-pages <n>` | pages that receive page/query detail (default google.gsc.pageQueryTopPages) |
| `--no-page-query` | skip the targeted page/query detail |
| `--inspect <n>` | afterwards, URL-inspect up to n priority URLs (bounded by google.gsc.urlInspectionMaxPerRun) |

#### `sync ga4`

Sync GA4 landing-page views (google_organic, all_organic), event counts, and period-grain users/rates

```sh
npm run cli -- sync ga4 [options]
```

| Option | Meaning |
| --- | --- |
| `--days <n>` | history window ending yesterday (property time zone); default: 90 days initially, then incremental refresh |
| `--periods <list>` | comma-separated period windows in days for non-additive metrics (default 7,28) |
| `--checklist` | print the manual conversion-verification checklist and exit (no GA4 request) |
| `--confirm-rate-scale <scale>` | record the scale GA4 uses for key-event rates (fraction = 0-1, percent = 0-100) after comparing a stored value with the GA4 interface, re-mark stored rates, and exit (no GA4 request; audited) |
| `--evidence <text>` | with --confirm-rate-scale: what you compared (kept in the audit log), e.g. "GA4 UI shows 2.5% for /pricing on 2026-09-15; stored 0.025" |
| `--as <name>` | with --confirm-rate-scale (required): your name; recorded as asserted, not authenticated (obvious automation or account names such as system, claude, agent007, owner, or root are refused) |

#### `sync inspect`

URL-inspect priority URLs (or the given URLs): Google's indexed state, not a live test

```sh
npm run cli -- sync inspect [options] [urls...]
```

| Option | Meaning |
| --- | --- |
| `--top <n>` | number of priority URLs when none are given (bounded by google.gsc.urlInspectionMaxPerRun) |

## Crawling and performance

<!-- generated reference: see "How this reference is maintained" -->

### `crawl`

Bounded own-site crawl (robots.txt respected, SSRF-safe) followed by technical checks

Subcommands: `page`, `aeo`, `competitor`, `status`, `issues`.

```sh
npm run cli -- crawl [options]
```

| Option | Meaning |
| --- | --- |
| `--max-pages <n>` | override crawl.maxPages for this run |
| `--max-depth <n>` | override crawl.maxDepth for this run |
| `--no-sitemaps` | do not discover sitemaps |
| `--render` | render JavaScript-dependent pages with Playwright (optional; needs features.playwright and the playwright package) |
| `--no-checks` | skip technical checks after the crawl |

#### `crawl page`

Fetch and analyse one own-site URL (no link following), including the heuristic AEO assessment

```sh
npm run cli -- crawl page [options] <url>
```

| Option | Meaning |
| --- | --- |
| `--render` | also render with Playwright when available and the raw HTML looks JavaScript-dependent |

#### `crawl aeo`

Heuristic AEO assessment from stored crawl results (answer near the top for the page's top Search Console queries, headings, self-contained sections, evidence, crawl/index/snippet eligibility); no network

```sh
npm run cli -- crawl aeo [options] [url]
```

| Option | Meaning |
| --- | --- |
| `--limit <n>` | pages assessed from the latest own-site crawl when no URL is given (default: `50`) |

#### `crawl competitor`

Fetch selected competitor pages for a serious query (needs --mode RESEARCH; robots.txt respected; stored as untrusted data). Without --query only research.competitors / research.approvedDomains hosts are fetched; with --query only URLs listed in a stored SERP snapshot of that query (or on approved hosts) are fetched; fresh snapshots are reused (research.dataforseo.cacheDays.competitor)

```sh
npm run cli -- crawl competitor [options] <urls...>
```

| Option | Meaning |
| --- | --- |
| `--query <query>` | the shortlisted query these pages rank for (URLs must be in a stored SERP snapshot of it, or on an approved host) |
| `--manual-urls` | with --query: crawl URLs you checked yourself even though no stored SERP snapshot of the query lists them (recorded in the audit log as manual) |
| `--max-per-query <n>` | pages per query (default crawl.competitorPagesPerQuery; capped at crawl.competitorPagesPerQueryMax) |
| `--refresh` | re-fetch even when a snapshot is within the volatility TTL |

#### `crawl status`

Crawler and Playwright status (use --network for a free robots.txt reachability check)

```sh
npm run cli -- crawl status [options]
```

| Option | Meaning |
| --- | --- |
| `--network` | fetch the site robots.txt to verify reachability |

#### `crawl issues`

List open technical issues from crawls (heuristics and suspicions are labelled)

```sh
npm run cli -- crawl issues [options]
```

| Option | Meaning |
| --- | --- |
| `--all` | include resolved and ignored issues |
| `--limit <n>` | maximum rows (default: `100`) |

### `perf`

Performance checks (PageSpeed Insights lab + CrUX field data) for priority pages; explicit and cached

Subcommands: `check`, `priority`, `status`.

#### `perf check`

Run an explicit, cached performance check for one own-site priority page or materially changed page (free Google APIs; no budget spend)

```sh
npm run cli -- perf check [options] <url>
```

| Option | Meaning |
| --- | --- |
| `--device <device>` | mobile or desktop (default: `mobile`) |
| `--reason <reason>` | priority_page (must be listed by `perf priority`) \| material_change (needs a crawl-detected change) \| manual (needs --justification) (default: `priority_page`) |
| `--justification <text>` | why this check is needed (required with --reason manual; recorded for every reason) |
| `--force` | ignore today's cached result |
| `--no-psi` | skip PageSpeed Insights (lab) |
| `--no-crux` | skip the CrUX API (field) |

#### `perf priority`

List the priority pages eligible for `perf check --reason priority_page` (no network)

```sh
npm run cli -- perf priority [options]
```

| Option | Meaning |
| --- | --- |
| `--limit <n>` | maximum pages (default: `10`) |

#### `perf status`

PageSpeed Insights / CrUX status (use --network for one free CrUX origin query)

```sh
npm run cli -- perf status [options]
```

| Option | Meaning |
| --- | --- |
| `--network` | verify the key with one CrUX origin query |

## Pipelines (durable jobs)

<!-- generated reference: see "How this reference is maintained" -->

### `baseline`

Baseline: validate access -> 90-day GSC/GA4 history -> bounded own-site crawl -> reconcile URLs -> check measurement -> index memory -> cost plan -> baseline report + dashboard. No paid DataForSEO/Apify, no experiments, nothing published.

```sh
npm run cli -- baseline [options]
```

| Option | Meaning |
| --- | --- |
| `--resume <jobId>` | continue an existing job from its last successful checkpoint (completed stages are not redone) |
| `--rerun-paid-stages` | with --resume: explicitly rerun a paid stage interrupted mid-flight (only after reconciling it: `costs --unresolved`, provider history) |
| `--approve-cost-plan <usd>` | explicitly approve the displayed optional LLM/embedding cost plan up to this cap in USD (e.g. 0.05); unknown prices are never approved |
| `--crawl-max-pages <n>` | bound the own-site crawl below crawl.maxPages |
| `--from <date>` | explicit report period start (YYYY-MM-DD, business time zone) |
| `--to <date>` | explicit report period end (YYYY-MM-DD) |

### `weekly`

Weekly: site lock -> fresh complete data -> joins -> experiments review -> routing -> shortlist -> budgeted research (only with --mode RESEARCH) -> memory -> one recommendation or no-action -> report/dashboard -> cost reconciliation

```sh
npm run cli -- weekly [options]
```

| Option | Meaning |
| --- | --- |
| `--resume <jobId>` | continue an existing job from its last successful checkpoint (completed stages are not redone) |
| `--rerun-paid-stages` | with --resume: explicitly rerun a paid stage interrupted mid-flight (only after reconciling it: `costs --unresolved`, provider history) |
| `--from <date>` | explicit report period start (YYYY-MM-DD) |
| `--to <date>` | explicit report period end (YYYY-MM-DD) |
| `--research-max-queries <n>` | lower research.seriousQueriesPerRun for this run (never raises it) |
| `--research-wait <seconds>` | poll queued SERP tasks up to this long (free GETs; default 90) |

### `monthly`

Monthly: organic + conversion performance, experiments, published-content cohorts, competitor changes (RESEARCH mode), optional AI visibility, API usage, data quality, learnings; observed results kept apart from attribution assumptions

```sh
npm run cli -- monthly [options]
```

| Option | Meaning |
| --- | --- |
| `--resume <jobId>` | continue an existing job from its last successful checkpoint (completed stages are not redone) |
| `--rerun-paid-stages` | with --resume: explicitly rerun a paid stage interrupted mid-flight (only after reconciling it: `costs --unresolved`, provider history) |
| `--from <date>` | explicit report period start (YYYY-MM-DD) |
| `--to <date>` | explicit report period end (YYYY-MM-DD) |

## Pages, analysis, and research

<!-- generated reference: see "How this reference is maintained" -->

### `analyze`

Analyze pages locally: URL reconciliation, metrics, GSC/GA4 joins, routing, scoring, recommendations (no network)

Subcommands: `page`, `reconcile`, `route`, `links`, `compare`.

#### `analyze page`

Metrics, joins, route, technical issues, and a recommendation preview for one page

```sh
npm run cli -- analyze page [options] <url>
```

| Option | Meaning |
| --- | --- |
| `--days <n>` | analysis window length in days (default 28) |
| `--end <date>` | window end date YYYY-MM-DD (default: latest date final in Search Console and complete in GA4) |
| `--search-type <type>` | Search Console search type (default: first configured, usually web) |
| `--save` | record the route decision and opportunity (ignored with --dry-run) |

#### `analyze reconcile`

Reconcile raw GSC/GA4/crawl URLs to page identities with recorded alias evidence

```sh
npm run cli -- analyze reconcile
```

No command-specific options (global options apply).

#### `analyze route`

Route and score every page; prints branded and non-branded shortlists and one recommendation

```sh
npm run cli -- analyze route [options]
```

| Option | Meaning |
| --- | --- |
| `--days <n>` | analysis window length in days (default 28) |
| `--end <date>` | window end date YYYY-MM-DD |
| `--search-type <type>` | Search Console search type |
| `--limit <n>` | shortlist size per segment (default 5) |
| `--save` | persist route decisions, opportunities, and the recommendation (ignored with --dry-run) |

#### `analyze links`

Internal-link suggestions (source, destination, passage, anchor, reason) and potential orphans relative to crawl coverage

```sh
npm run cli -- analyze links [options]
```

| Option | Meaning |
| --- | --- |
| `--url <url...>` | destination page URL(s) (default: pages with open opportunities, else top pages by impressions) |
| `--max <n>` | maximum suggestions per destination (default 5) |

#### `analyze compare`

Deterministic competitor comparison inputs for one of our pages and ONE query (intent, page type, topics, examples, tools, original data, evidence, freshness, buyer concerns)

```sh
npm run cli -- analyze compare [options] <url>
```

| Option | Meaning |
| --- | --- |
| `--query <q>` | search query whose latest SERP snapshot (configured location, language, device) selects the competitor pages; required unless --competitor is given |
| `--competitor <url...>` | explicit competitor page URLs (must already be crawled) |
| `--max <n>` | maximum competitor pages (default 10) |

### `pages`

Page identities and page types (owner > site.pageTypes config > inferred); local only, no network

Subcommands: `list`, `set-type`, `infer-types`.

#### `pages list`

List pages with their page type, its source (owner/config/inferred), and protected/excluded flags

```sh
npm run cli -- pages list [options]
```

| Option | Meaning |
| --- | --- |
| `--type <type>` | only pages of this page type (use "none" for pages without a type) |
| `--source <source>` | only types from this source: owner, config, inferred, or none |
| `--limit <n>` | maximum pages (default 200) |

#### `pages set-type`

Set the page type of one page as the owner (page_type_source "owner"; wins over site.pageTypes and inferred types). Type "auto" removes the owner type.

```sh
npm run cli -- pages set-type <url> <type>
```

No command-specific options (global options apply).

#### `pages infer-types`

Guess page types for untyped pages from their latest own-site crawl (structured data, URL, wording); preview unless --apply (recorded as "inferred"; never overrides owner or config types)

```sh
npm run cli -- pages infer-types [options]
```

| Option | Meaning |
| --- | --- |
| `--apply` | record the guesses as page_type_source "inferred" (ignored with --dry-run) |
| `--limit <n>` | maximum pages examined (default 500) |

### `research`

Selective, budgeted DataForSEO research (SERPs, keyword volume estimates)

Subcommands: `keyword`, `tasks`, `locations`, `status`.

#### `research keyword`

Research SERPs for explicit queries (cache first, budgeted, standard queue); --dry-run shows the cost plan and caps

```sh
npm run cli -- research keyword [options] <query...>
```

| Option | Meaning |
| --- | --- |
| `--sandbox` | use the free DataForSEO sandbox (synthetic data, never used in recommendations) |
| `--allow-spend` | permit paid DataForSEO requests within the configured caps |
| `--volume` | also request Google Ads search-volume estimates (one paid task for all queries) |
| `--device <device>` | desktop or mobile (default: first supported device in market.devices) |
| `--location <code>` | use the configured market.searchLocations entry with this location code |
| `--competitors <n>` | competitor pages to return per query (up to crawl.competitorPagesPerQueryMax) |
| `--wait <seconds>` | poll standard-queue tasks for up to N seconds (free; never resubmits) (default: `0`) |

#### `research tasks`

List pending and ambiguous DataForSEO tasks; --poll resumes them with free GETs (never resubmits)

```sh
npm run cli -- research tasks [options]
```

| Option | Meaning |
| --- | --- |
| `--poll` | poll tasks_ready / task_get now and store finished results |
| `--all` | include fetched, failed, and expired tasks |
| `--abandon <taskId>` | give up on an AMBIGUOUS task after checking the DataForSEO dashboard (its charge stays reserved) |

#### `research locations`

Look up supported DataForSEO locations (free) to configure market.searchLocations without guessing codes

```sh
npm run cli -- research locations [options] [search]
```

| Option | Meaning |
| --- | --- |
| `--search <name>` | same as the [search] argument |
| `--country <iso2>` | two-letter country code to narrow the list (recommended; the full list is large) |
| `--kind <kind>` | serp or keywords (default: `serp`) |
| `--sandbox` | use the sandbox host (synthetic lookup data) |
| `--limit <n>` | maximum rows to print (default: `50`) |

#### `research status`

DataForSEO integration status (never chargeable; --network calls the free user_data endpoint)

```sh
npm run cli -- research status [options]
```

| Option | Meaning |
| --- | --- |
| `--network` | verify credentials with the free user_data endpoint |
| `--sandbox` | check against the sandbox host |

### `apify`

Apify Reddit Scraper actor 9sHOY9RzPYGjmTHo8: status, inspect, schema import, test run, content research, runs

Subcommands: `status`, `inspect`, `import-schema`, `test`, `research`, `runs`.

#### `apify status`

Honest integration status (no request unless --network; network checks are free reads)

```sh
npm run cli -- apify status [options]
```

| Option | Meaning |
| --- | --- |
| `--network` | perform free read-only network checks (token, actor, pinned build) |

#### `apify inspect`

Free reads: live identity, pricing, builds, input schema (stored with hash), and schema drift

```sh
npm run cli -- apify inspect [options]
```

| Option | Meaning |
| --- | --- |
| `--build <build>` | also inspect this build number (default: the pinned build) |

#### `apify import-schema`

Import the actor's exported input schema (raw schema, build JSON, or build openapi.json). Stored unverified unless --attest

```sh
npm run cli -- apify import-schema [options] <file>
```

| Option | Meaning |
| --- | --- |
| `--build <number>` | build number the schema was exported from, e.g. 0.0.513 |
| `--attest` | owner attestation that the file is exactly the input schema of --build (recorded in the audit log) |

#### `apify test`

One minimal PAID test run (5 posts, no comments). Requires --mode RESEARCH, --confirm-spend and --max-usd; the cap is shown before starting

```sh
npm run cli -- apify test [options]
```

| Option | Meaning |
| --- | --- |
| `--confirm-spend` | explicitly allow this paid run |
| `--max-usd <usd>` | provider-side charge cap for this run (must not exceed research.apify.maxTotalChargeUsd) |
| `--term <text>` | search term (default: first research.seedTopics entry) |
| `--no-reuse` | do not reuse an identical completed run |

#### `apify research`

PAID content research with the configured limits (research.apify maxItems/maxCommentsPerPost/timeRange; terms from research.seedTopics). One bounded run per community (research.subreddits). Shows the plan first; needs --mode RESEARCH, --confirm-spend and --max-usd (total cap across all runs)

```sh
npm run cli -- apify research [options]
```

| Option | Meaning |
| --- | --- |
| `--term <text>` | search term (repeatable; default: research.seedTopics) |
| `--community <name>` | subreddit name, "name" or "r/name" (repeatable; default: research.subreddits); one run per community |
| `--all-reddit` | ignore research.subreddits: one run across all of Reddit |
| `--confirm-spend` | explicitly allow the paid runs shown in the plan |
| `--max-usd <usd>` | TOTAL provider-side charge cap across all runs of this batch (split per run; each run also within research.apify.maxTotalChargeUsd) |
| `--plan <hash>` | only start if the batch plan hash equals this one (as shown by a previous preview) |
| `--max-items <n>` | lower research.apify.maxItems for these runs |
| `--max-comments-per-post <n>` | lower research.apify.maxCommentsPerPost for these runs |
| `--time-range <range>` | narrow research.apify.timeRange (hour, day, week, month, year, all) |
| `--classify-with-llm` | classify signals with the LLM classifier (prompt research.reddit-signals) instead of the English heuristics; needs --llm-max-usd |
| `--llm-max-usd <usd>` | per-request LLM cost cap for --classify-with-llm (reserved through the LLM Gateway budget; unknown prices are refused) |
| `--no-reuse` | do not reuse identical completed runs |

#### `apify runs`

List Apify runs for this site; --resume reconciles ambiguous submissions and finishes pending runs (never starts a new paid run)

```sh
npm run cli -- apify runs [options]
```

| Option | Meaning |
| --- | --- |
| `--resume` | poll/fetch/normalize pending runs and re-check unresolved charges |
| `--wait` | with --resume: wait for running runs to finish (polls with backoff) |
| `--abort-overdue` | with --resume: request abort of runs far past their timeout (abort endpoint unverified) |
| `--confirm-not-accepted <id>` | owner confirmation (after checking the Apify console) that a quarantined ambiguous submission never started: records $0 as a manual confirmation |
| `--limit <n>` | rows to list (default: `50`) |

### `models`

LLM Gateway models: list verified capabilities, check configured models, run an explicit paid test

Subcommands: `list`, `check`, `test`.

#### `models list`

List models from the LLM Gateway catalog (free GET /v1/models) with capabilities and verified prices

```sh
npm run cli -- models list [options]
```

| Option | Meaning |
| --- | --- |
| `--refresh` | ignore the cached catalog and query the gateway |
| `--embedding` | show only embedding models |
| `--chat` | show only chat models |
| `--filter <text>` | show only ids containing this text |

#### `models check`

Verify configured CHEAP_MODEL / REASONING_MODEL / EMBEDDING_MODEL against the catalog: existence, capabilities, prices, key budget (free)

```sh
npm run cli -- models check [options]
```

| Option | Meaning |
| --- | --- |
| `--refresh` | ignore the cached catalog and query the gateway |

#### `models test`

CHARGEABLE: send one minimal request to the configured model; requires --confirm-spend and --max-usd <cap>

```sh
npm run cli -- models test [options]
```

| Option | Meaning |
| --- | --- |
| `--tier <tier>` | cheap \| reasoning \| embedding (default: `cheap`) |
| `--confirm-spend` | acknowledge that this sends a paid request |
| `--max-usd <cap>` | hard cap for this request's cost upper bound, e.g. 0.01 |
| `--max-output-tokens <n>` | max output tokens for the test completion (default: `16`) |

## Content pipeline

<!-- generated reference: see "How this reference is maintained" -->

### `content`

Content farming pipeline: research-to-value discovery, briefs, gated drafts, quality review (nothing is published automatically)

Subcommands: `discover`, `import`, `list`, `show`, `brief`, `draft`, `batch`, `review`, `bootstrap`, `mark-reviewed`, `revise-manual`, `publish-check`, `measure`, `produce`, `queue`.

#### `content discover`

DISCOVER -> DEDUPLICATE -> CLASSIFY -> CLUSTER -> VALIDATE DEMAND -> CHECK EXISTING -> PRIORITIZE

```sh
npm run cli -- content discover [options]
```

| Option | Meaning |
| --- | --- |
| `--gsc-days <n>` | Search Console lookback in days (default: `28`) |
| `--max-queries <n>` | maximum Search Console queries to collect (default: `200`) |
| `--use-model` | allow the cheap model for ambiguous intent (spends money; shows the cap) |
| `--semantic` | also use embeddings for clustering (requires --use-model, features.embeddings) |

#### `content import`

Import manually supplied customer questions (CSV with a text/question column, or JSON)

```sh
npm run cli -- content import [options] <file>
```

| Option | Meaning |
| --- | --- |
| `--format <format>` | csv \| json (default: by file extension) |

#### `content list`

List content items by priority

```sh
npm run cli -- content list [options]
```

| Option | Meaning |
| --- | --- |
| `--stage <stage>` | filter by stage (discovered, deduplicated, classified, clustered, demand_validated, existing_checked, prioritized, briefed, drafted, quality_checked, in_review, approved, exported, published, measuring, deferred, rejected) |
| `--limit <n>` | maximum rows (default: `50`) |

#### `content show`

Show a content item with its rationale, demand evidence, signals, brief, and draft status

```sh
npm run cli -- content show <item-id>
```

No command-specific options (global options apply).

#### `content brief`

Build the brief and run the deterministic brief gate; on pass, request the draft approval bound to the brief hash

```sh
npm run cli -- content brief [options] <item-id>
```

| Option | Meaning |
| --- | --- |
| `--use-model` | allow the reasoning model to synthesize the brief (spends money; shows the cap) |
| `--no-approval-request` | do not create the pending draft approval request |
| `--catalog <file>` | JSON array of catalog attributes [{name, value, source: catalog\|owner\|image\|model, validated}] for product/category pages |
| `--programmatic <file>` | JSON {templateId, differentiatingData: [{field, value, evidenceIds}]} for a programmatic page (requires real distinct data) |
| `--force` | build a new brief version even when the inputs are unchanged (the draft approval must then be requested again) |

#### `content draft`

Generate a draft package (requires --mode DRAFT, a gate-passed brief, a draft approval bound to its hash, and --use-model); runs quality gates with at most 2 automated revisions

```sh
npm run cli -- content draft [options] <item-id>
```

| Option | Meaning |
| --- | --- |
| `--use-model` | required: allow the reasoning model (spends money; shows the cap) |

#### `content batch`

BOUNDED PARALLEL batch drafts (max 3 workers). A first batch_expansion approval drafts a pilot of up to 3 and STOPS; after a human accepts every pilot draft (mark-reviewed), a second approval expands to the rest. Requires content.batchEnabled, content.pilotApproved, --mode DRAFT, and --use-model

```sh
npm run cli -- content batch [options] <item-ids...>
```

| Option | Meaning |
| --- | --- |
| `--workers <n>` | concurrent drafts (1-3) (default: `3`) |
| `--use-model` | required: allow model spend (shows the cap) |

#### `content review`

Run deterministic quality gates (+ bounded AI review with --use-model); --revise allows automated revision loops (max 2, needs --mode DRAFT)

```sh
npm run cli -- content review [options] <draft-id>
```

| Option | Meaning |
| --- | --- |
| `--use-model` | allow the reasoning model for AI review/revisions (spends money; shows the cap) |
| `--revise` | run automated revisions while the verdict is needs_revision (max 2 total) |

#### `content bootstrap`

Low-data bootstrap: offer-page brief + one supporting-page brief + measurement/technical readiness checks

```sh
npm run cli -- content bootstrap [options]
```

| Option | Meaning |
| --- | --- |
| `--force` | run even when the site is not low-data |
| `--use-model` | allow the reasoning model for brief synthesis (spends money; shows the cap) |

#### `content mark-reviewed`

Record that a named human reviewed and accepts this exact draft body (needs --as and --confirm <body-hash-prefix>); publication still needs an approval

```sh
npm run cli -- content mark-reviewed [options] <draft-id>
```

| Option | Meaning |
| --- | --- |
| `--as <name>` | reviewer name (recorded in the audit log) (required) |
| `--confirm <hash-prefix>` | first 8+ characters of the draft body hash you reviewed (required) |
| `--note <text>` | review note |

#### `content revise-manual`

Record a human-edited body as a new draft version (needs --mode DRAFT; no model call): [[UNVERIFIED: ...]] markers are recounted, the deterministic quality gates re-run, and every removed marker needs a resolution with a source (--resolutions)

```sh
npm run cli -- content revise-manual [options] <draft-id>
```

| Option | Meaning |
| --- | --- |
| `--body-file <file>` | Markdown file with the complete edited body (stored exactly as written) (required) |
| `--as <name>` | author name (recorded on the draft version and in the audit log) (required) |
| `--resolutions <file>` | JSON array, one entry per removed marker: [{"marker", "action": "confirmed"\|"removed", "source", "statement"?, "note"?}] |
| `--note <text>` | revision note |

#### `content publish-check`

Show content-side publication blockers for a draft (human review, unresolved facts, synthetic data, verdict, approval, EXECUTE mode)

```sh
npm run cli -- content publish-check <draft-id>
```

No command-specific options (global options apply).

#### `content measure`

Move published items to measuring and report observational Search Console metrics since the recorded implementation date

```sh
npm run cli -- content measure
```

No command-specific options (global options apply).

#### `content produce`

Durable content production for one item: brief (reused when unchanged) -> draft (needs --mode DRAFT and a human draft approval) -> quality review; checkpointed and resumable, per-stage LLM allowances enforced. Never publishes.

```sh
npm run cli -- content produce [options] [item-id]
```

| Option | Meaning |
| --- | --- |
| `--use-model` | allow model calls (spends money within per-stage allowances and budgets) |
| `--resume <jobId>` | continue an existing production job from its last successful checkpoint |

#### `content queue`

Content discovery queue as a durable job (features.contentDiscovery; own "content" lock): resume Apify runs, discover -> dedupe -> classify -> cluster -> validate demand -> check existing -> prioritize, vault notes. Never drafts or publishes.

```sh
npm run cli -- content queue [options]
```

| Option | Meaning |
| --- | --- |
| `--resume <jobId>` | continue an existing job from its last successful checkpoint (completed stages are not redone) |
| `--rerun-paid-stages` | with --resume: explicitly rerun a paid stage interrupted mid-flight (only after reconciling it: `costs --unresolved`, provider history) |
| `--gsc-days <n>` | Search Console lookback in days (default: `28`) |
| `--max-queries <n>` | maximum Search Console queries to collect (default: `200`) |
| `--use-model` | allow the cheap model for ambiguous intent (spends money within per-stage allowances) |
| `--semantic` | also use embeddings for clustering (requires --use-model) |

## Memory and vault

<!-- generated reference: see "How this reference is maintained" -->

### `memory`

Vector memory and hybrid retrieval (SQLite FTS5 + Qdrant). Qdrant is a rebuildable index; SQLite is authoritative.

Subcommands: `sync`, `search`, `rebuild`, `reconcile`, `status`, `evidence`.

#### `memory sync`

Ingest business notes and records, propagate deletions, and index vectors (embedding cache first)

```sh
npm run cli -- memory sync [options]
```

| Option | Meaning |
| --- | --- |
| `--allow-paid` | allow paid embedding calls for texts without cached vectors (budget-reserved by the LLM client; caps shown) |
| `--skip-ingest` | only index what is already in SQLite |
| `--max-embed <n>` | cap the number of new (paid) embeddings in this run |

#### `memory search`

Hybrid memory search (full-text + semantic + wikilinks, fused with RRF k=60)

```sh
npm run cli -- memory search [options] <query...>
```

| Option | Meaning |
| --- | --- |
| `--limit <n>` | maximum results (default 8, max 50) |
| `--type <type...>` | source types: business_note, source_excerpt, competitor_finding, brief, experiment_summary, rejected_proposal, approved_learning, decision, report_summary, fixture |
| `--trust <class...>` | trust classes: owner_approved, first_party_measurement, third_party_data, user_reported, scraped_untrusted, model_generated, synthetic |
| `--language <code>` | only this document language |
| `--include-superseded` | also return superseded/deleted material (clearly labelled) |
| `--include-owner-only` | also return owner-only documents |
| `--budget <tokens>` | context budget in estimated tokens (default memory.contextBudgetTokens) |
| `--allow-paid` | allow a paid query embedding when the query vector is not cached |

#### `memory rebuild`

Rebuild this site's vectors from SQLite + the embedding cache (no paid calls when the cache is complete; --dry-run shows the plan)

```sh
npm run cli -- memory rebuild [options]
```

| Option | Meaning |
| --- | --- |
| `--allow-paid` | allow paid embedding calls for texts missing from the cache |

#### `memory reconcile`

Compare Qdrant points for this site with SQLite; delete orphans and restore missing points from the cache (--dry-run reports only)

```sh
npm run cli -- memory reconcile
```

No command-specific options (global options apply).

#### `memory status`

Memory, embedding, and Qdrant status (no network unless --network; never chargeable)

```sh
npm run cli -- memory status [options]
```

| Option | Meaning |
| --- | --- |
| `--network` | perform a free read-only Qdrant health check |

#### `memory evidence`

Show the original supporting source for a retrieved chunk (re-check before reusing a consequential claim)

```sh
npm run cli -- memory evidence <chunkId>
```

No command-specific options (global options apply).

### `vault`

Obsidian-compatible Markdown vault: init, render, check, business-note sync

Subcommands: `init`, `render`, `check`, `import-business`, `apply-business`, `business-history`, `resolve`.

#### `vault init`

Create the site vault from the template (never overwrites existing files)

```sh
npm run cli -- vault init
```

No command-specific options (global options apply).

#### `vault render`

Regenerate notes from SQLite; human text outside generated markers is preserved and edited notes get conflict artifacts

```sh
npm run cli -- vault render [options]
```

| Option | Meaning |
| --- | --- |
| `--only <kinds>` | comma-separated subset: dashboard, index, pages, keywords, competitors, experiments, decisions, learnings, sources, content, ai_search |

#### `vault check`

Check broken or ambiguous wikilinks, conflicts, edited generated regions, and malformed notes

```sh
npm run cli -- vault check
```

No command-specific options (global options apply).

#### `vault import-business`

Validate human notes in "01 Business" and show the config diff; --apply records versions (never changes the config)

```sh
npm run cli -- vault import-business [options]
```

| Option | Meaning |
| --- | --- |
| `--apply` | record new note versions in the database (rejected notes are recorded with their errors) |

#### `vault apply-business`

Show the site-config diff of the recorded business profile; with --confirm <diff-hash>, write it as a new config version

```sh
npm run cli -- vault apply-business [options]
```

| Option | Meaning |
| --- | --- |
| `--confirm <diffHash>` | the diff hash shown by the preview; binds the change to exactly the reviewed diff |
| `--by <name>` | the named human confirming (recorded in the audit log as asserted, not authenticated; defaults to your operating-system user unless it is a service account such as node or runner; obvious automation or account names such as system, claude, owner, or root are refused) |

#### `vault business-history`

List recorded versions of business notes

```sh
npm run cli -- vault business-history [options]
```

| Option | Meaning |
| --- | --- |
| `--note <path>` | vault-relative note path, e.g. "01 Business/Business Profile.md" |

#### `vault resolve`

Resolve a vault conflict: --use-generated (back up, then let the next render replace the generated region) or --detach (keep the note as human-owned)

```sh
npm run cli -- vault resolve [options] <relPath>
```

| Option | Meaning |
| --- | --- |
| `--use-generated` | accept regeneration of the generated region; text outside the markers is preserved |
| `--detach` | stop generating this note; it becomes human-owned |

## Experiments, approvals, and export

<!-- generated reference: see "How this reference is maintained" -->

### `experiments`

Experiment lifecycle: propose, approve (via approvals), implement, observe, evaluate

Subcommands: `list`, `show`, `propose`, `specify-change`, `review`, `mark-implemented`, `annotate`, `cancel`, `learnings`, `propose-learning`.

#### `experiments list`

List experiments

```sh
npm run cli -- experiments list [options]
```

| Option | Meaning |
| --- | --- |
| `--status <status...>` | filter by status (proposed, approved, awaiting_implementation, observing, positive, negative, inconclusive, cancelled) |

#### `experiments show`

Show an experiment with its exact change, status history, evaluations, and publications

```sh
npm run cli -- experiments show <id>
```

No command-specific options (global options apply).

#### `experiments propose`

Propose an experiment from a recommendation and request approval for its exact change

```sh
npm run cli -- experiments propose [options]
```

| Option | Meaning |
| --- | --- |
| `--recommendation <id>` | recommendation id (required) |
| `--primary-metric <metric>` | clicks \| impressions \| ctr \| position \| primarySessionRate \| primaryKeyEvents \| sessions \| engagedSessionRate \| revenue |
| `--outcome-kind <kind>` | seo_visibility \| conversion \| both |
| `--min-days <n>` | minimum observation days (default from site config; longer for low-traffic pages) |
| `--comparison-pages <n>` | number of unchanged comparison pages (default 5) |
| `--min-effect <fraction>` | smallest meaningful relative effect, e.g. 0.1 for 10% |
| `--revision <rev>` | current source revision of the site (bound into the approval) |
| `--risks <text>` | risks (required when the recommendation does not state them) |
| `--rollback-plan <text>` | rollback plan (default derived from the change type) |
| `--retest-reason <text>` | documented reason to re-test a change that was already concluded |
| `--critical-fix <reason>` | override the one-change-per-page freeze for critical broken functionality (recorded) |
| `--ttl-hours <n>` | approval expiry in hours |
| `--segment <segment-key>` | Search Console segment_key to measure in both windows (default: unsegmented page totals) |
| `--as <name>` | who proposes (default: OS user) |

#### `experiments specify-change`

Record ONE concrete change for a recommendation (e.g. after an audit) as a new recommendation revision; nothing is approved or deployed

```sh
npm run cli -- experiments specify-change [options] <recommendation-id>
```

| Option | Meaning |
| --- | --- |
| `--by <name>` | the human recording the change (automation names are refused) (required) |
| `--title <text>` | new page title (may be combined with --meta as one title/meta change) |
| `--meta <text>` | new meta description |
| `--section-file <file>` | Markdown file with ONE content section to publish on the page |
| `--redirect-to <url>` | redirect the page to this absolute URL |
| `--note <text>` | why this is the change (recorded) |
| `--hypothesis <text>` | the hypothesis to test (required for an experiment when the recommendation states none) |

#### `experiments review`

Evaluate due observing experiments (observational before/after with comparison pages); every evaluation is recorded

```sh
npm run cli -- experiments review [options]
```

| Option | Meaning |
| --- | --- |
| `--id <id...>` | only these experiments (evaluated even if not yet due) |
| `--all` | also evaluate observing experiments that are not yet due (records a "collecting" evaluation) |
| `--conclude` | conclude experiments past their minimum period even with insufficient evidence (-> inconclusive) |
| `--as <name>` | who concludes (with --conclude; default: OS user) |

#### `experiments mark-implemented`

Record that a human deployed an approved change; starts the observation window at the actual implementation time

```sh
npm run cli -- experiments mark-implemented [options] <id>
```

| Option | Meaning |
| --- | --- |
| `--at <iso>` | when the change actually went live, ISO-8601 with zone (e.g. 2026-09-20T14:30:00Z) (required) |
| `--revision <rev>` | deployment/source revision (commit, CMS revision) (required) |
| `--url <url>` | live URL (must equal the approved target) |
| `--subject-type <type>` | experiment (default), draft, or recommendation (default: `experiment`) |
| `--critical-fix <reason>` | record a critical fix on a page with an experiment under observation (flags that experiment; defaults to the reason given at export/proposal) |
| `--deployed-without-export <reason>` | the change went live without the EXECUTE-mode export (no pre-execution recheck ran); needs --mode EXECUTE, recorded |
| `--as <name>` | who records it (default: OS user) |

#### `experiments annotate`

Record an external or site change that can interfere with experiments

```sh
npm run cli -- experiments annotate [options]
```

| Option | Meaning |
| --- | --- |
| `--scope <scope>` | page \| template \| site \| external (required) |
| `--kind <kind>` | site_change \| template_change \| critical_fix \| algorithm_update \| tracking_change \| seasonality \| outage \| campaign \| other (required) |
| `--at <iso>` | when it happened, ISO-8601 with zone (required) |
| `--description <text>` | what changed (required) |
| `--page <url-or-id>` | page (required for --scope page) |
| `--source <text>` | reference, e.g. a deploy id or announcement URL |
| `--overrides-freeze` | this change overrode an observation freeze (critical fix) |
| `--as <name>` | who records it (default: OS user) |

#### `experiments cancel`

Cancel an experiment that has not concluded (recorded with a reason)

```sh
npm run cli -- experiments cancel [options] <id>
```

| Option | Meaning |
| --- | --- |
| `--reason <text>` | why (required) |
| `--as <name>` | who cancels (default: OS user) |

#### `experiments learnings`

List proposed/approved learnings (scoped; never universal rules)

```sh
npm run cli -- experiments learnings [options]
```

| Option | Meaning |
| --- | --- |
| `--status <status>` | proposed \| approved \| rejected \| superseded |

#### `experiments propose-learning`

Propose a scoped learning backed by an experiment evaluation (needs approval to be promoted)

```sh
npm run cli -- experiments propose-learning [options] <experiment-id>
```

| Option | Meaning |
| --- | --- |
| `--statement <text>` | what was observed (required) |
| `--scope <text>` | where it applies, e.g. "site:<id>; page type: article; change: title rewrite" (required) |
| `--as <name>` | who proposes (default: OS user) |

### `approvals`

Human approvals bound to exact proposals (list, show, request, approve, reject)

Subcommands: `list`, `show`, `request`, `approve`, `reject`, `request-budget-exception`.

#### `approvals list`

List approvals (default: pending and approved)

```sh
npm run cli -- approvals list [options]
```

| Option | Meaning |
| --- | --- |
| `--status <status...>` | filter by status (pending, approved, rejected, expired, executed, invalidated) |
| `--all` | include every status |
| `--subject <type:id>` | only approvals for one subject, e.g. experiment:exp_123 |

#### `approvals show`

Show an approval: binding, exact change, hash, and history

```sh
npm run cli -- approvals show <id>
```

No command-specific options (global options apply).

#### `approvals request`

Request approval for the exact current proposal of a draft, recommendation, experiment, or learning (grants nothing by itself)

```sh
npm run cli -- approvals request [options] <subject-type> <id>
```

| Option | Meaning |
| --- | --- |
| `--revision <rev>` | source revision the proposal was reviewed against (bound into the approval) |
| `--ttl-hours <n>` | expiry in hours (default 168, max 720) |
| `--as <name>` | who is requesting (default: OS user unless it is a service account; recorded as asserted, not authenticated) |

#### `approvals approve`

Approve a pending request as a named human; requires typing the artifact-hash prefix shown by `approvals show`

```sh
npm run cli -- approvals approve [options] <id>
```

| Option | Meaning |
| --- | --- |
| `--as <name>` | your name (default: OS user unless it is a service account such as node or runner); recorded as asserted, not authenticated; obvious automation or account names are refused |
| `--confirm <hash-prefix>` | first 8+ characters of the artifact hash, typed to confirm you reviewed this exact proposal |
| `--note <text>` | optional decision note |
| `--accept-unbound-revision` | approve a production change that is not bound to a source revision (recorded) |

#### `approvals reject`

Reject a pending request as a named human

```sh
npm run cli -- approvals reject [options] <id>
```

| Option | Meaning |
| --- | --- |
| `--reason <text>` | why the proposal is rejected (recorded) (required) |
| `--as <name>` | your name (default: OS user unless it is a service account such as node or runner); recorded as asserted, not authenticated; obvious automation or account names are refused |

#### `approvals request-budget-exception`

Request a one-time, bounded exception to a configured budget cap (decided with `approvals approve`)

```sh
npm run cli -- approvals request-budget-exception [options]
```

| Option | Meaning |
| --- | --- |
| `--provider <provider>` | llm_gateway, dataforseo, apify, pagespeed or combined (required) |
| `--period <key>` | budget period: YYYY-MM (month) or YYYY-Www (ISO week) (required) |
| `--amount-usd <amount>` | extra amount above the cap, decimal USD (e.g. "2.50") (required) |
| `--reason <text>` | why the exception is needed (required) |
| `--as <name>` | who is requesting (default: OS user unless it is a service account; recorded as asserted, not authenticated) |

### `export`

Write a manual export package for a draft, recommendation, experiment (production-bound exports need --mode EXECUTE and an approval)

```sh
npm run cli -- export [options] <subject-type> <id>
```

| Option | Meaning |
| --- | --- |
| `--revision <rev>` | current source revision (required when the approval is bound to one); a mismatch is refused, never silently invalidates the approval |
| `--invalidate-stale` | with --revision: state that this is the site's CURRENT revision, so an approval bound to a different revision is stale and is invalidated (recorded) |
| `--allow-unverified-target` | proceed when the target cannot be rechecked (offline); recorded in the approval and package |
| `--critical-fix <reason>` | critical broken functionality only: export although another experiment is observing the page (recorded; flags it) |
| `--as <name>` | who executes the export (default: OS user) |

## Reports, data exchange, and costs

<!-- generated reference: see "How this reference is maintained" -->

### `report`

Generated reports (append-only): list, show, rebuild from the database, dashboard

Subcommands: `list`, `show`, `build`, `dashboard`.

#### `report list`

List generated reports (newest first)

```sh
npm run cli -- report list [options]
```

| Option | Meaning |
| --- | --- |
| `--kind <kind>` | filter by kind (baseline, weekly, monthly) |
| `--limit <n>` | maximum rows (default: `20`) |

#### `report show`

Print a stored report (the latest of that kind unless --id is given)

```sh
npm run cli -- report show [options] <kind>
```

| Option | Meaning |
| --- | --- |
| `--latest` | show the most recent report of this kind (default) |
| `--id <id>` | show a specific report id |
| `--format <format>` | md or json (with --json the JSON report is printed) (default: `md`) |

#### `report build`

Build a NEW report from the current database state (no sync, no network, no spend)

```sh
npm run cli -- report build [options] <kind>
```

| Option | Meaning |
| --- | --- |
| `--from-db` | required: build only from data already in the database |
| `--from <date>` | period start (YYYY-MM-DD, business time zone) |
| `--to <date>` | period end (YYYY-MM-DD, business time zone) |
| `--statuses <file>` | JSON file with integration statuses (e.g. saved `doctor --json` output); without it the report says access was not checked |
| `--top <n>` | top-N rows per table (default: `10`) |
| `--job <id>` | associate the report with an existing job id |

#### `report dashboard`

Print the static dashboard note (00 Dashboard/Dashboard.md) without writing the vault

```sh
npm run cli -- report dashboard [options]
```

| Option | Meaning |
| --- | --- |
| `--statuses <file>` | JSON file with integration statuses |

### `data`

CSV/JSON exchange: export one dataset at its stored grain, or import Search Console exports and keyword lists with provenance

Subcommands: `export`, `import`.

#### `data export`

Export one dataset (gsc-property, gsc-pages, gsc-queries, ga4-landing, ga4-events, ga4-period, recommendations, opportunities, costs, keywords) as CSV or JSON; current revisions only, never aggregated or mixed

```sh
npm run cli -- data export [options] <dataset>
```

| Option | Meaning |
| --- | --- |
| `--format <format>` | csv \| json (default: `csv`) |
| `--from <date>` | first date (YYYY-MM-DD) to include |
| `--to <date>` | last date (YYYY-MM-DD) to include |
| `--out <file>` | output file, or "-" for standard output (default: <workspace>/exports/data/<site>-<dataset>-<from>-<to>.<format>); never a symbolic link, a file in the application repository outside the workspace, the vault, or secrets/ |

#### `data import`

Import a file as a versioned ingestion batch (source "import"): gsc-property = Search Console property totals per day (e.g. the "Dates" export): date, clicks, impressions[, ctr, position]; gsc-pages = Search Console page totals per day: date, page, clicks, impressions[, ctr, position, country, device]; gsc-queries = Search Console page/query rows per day: date, page, query, clicks, impressions[, ctr, position, country, device]; keywords = Keyword list: keyword[, language, intent, branded, search_volume, location_code] (volumes are stored as provider estimates)

```sh
npm run cli -- data import [options] <dataset> <file>
```

| Option | Meaning |
| --- | --- |
| `--format <format>` | csv \| json (default: by file extension) |
| `--property <property>` | Search Console property (default: google.searchConsoleProperty; never guessed) |
| `--search-type <type>` | search type when the file has no search type column (default: `web`) |
| `--replace` | let the file's values supersede rows collected by a Google sync (default: keep them) |
| `--skip-invalid` | import the valid rows and record the batch as partial (default: refuse the whole file) |
| `--complete` | assert the file is complete for its date range, so dates or pages without rows are real zeros |
| `--synthetic` | label the imported rows synthetic (test or demo data) |
| `--provider <name>` | tool the keyword search volumes come from (stored as provider import:<name>) |
| `--unguard` | CSV written by `data export` but not recognized as one: remove its spreadsheet formula guard (one leading apostrophe). Recognized exports are unguarded automatically; other files are kept exactly as written |

### `ai-citations`

Optional AI-citation monitoring (features.aiCitations, off by default): explicit manual import of observed AI answers; no API engine is implemented

Subcommands: `status`, `import`, `list`.

#### `ai-citations status`

Show whether AI-citation monitoring is enabled, which collectors exist (manual import only; no API engine), and what is stored; no network

```sh
npm run cli -- ai-citations status
```

No command-specific options (global options apply).

#### `ai-citations import`

Import observed AI answers from CSV/JSON (columns: engine, query, date, grounded; optional prompt, location, timezone, response, cited_urls, source). Brand mention and own-site citation are computed in code; nothing is fetched or charged

```sh
npm run cli -- ai-citations import [options] <file>
```

| Option | Meaning |
| --- | --- |
| `--format <format>` | csv \| json (default: by file extension) |
| `--timezone <iana>` | time zone of dates without a time (default: the site's business time zone) |
| `--source <label>` | tool or person that captured the observations, when the file has no source column |
| `--skip-invalid` | import the valid rows and report the import as partial (default: refuse the whole file) |
| `--synthetic` | label the imported rows synthetic (test or demo data) |

#### `ai-citations list`

List stored AI-citation observations with a summary that keeps mention, citation, click, and conversion apart (default: the last 90 days)

```sh
npm run cli -- ai-citations list [options]
```

| Option | Meaning |
| --- | --- |
| `--from <date>` | first observation date (YYYY-MM-DD) |
| `--to <date>` | last observation date (YYYY-MM-DD; default: today in the site's business time zone) |
| `--month <yyyy-mm>` | one calendar month instead of --from/--to |
| `--engine <name>` | only this engine |
| `--grounded-only` | hide ungrounded model responses from the list (they never count in the summary) |
| `--limit <n>` | maximum observations listed (the summary always covers the whole period) (default: `50`) |

### `costs`

Show actual, estimated, reserved, and unknown spend against configured budgets; reconcile unresolved charges

Subcommands: `reconcile`.

```sh
npm run cli -- costs [options]
```

| Option | Meaning |
| --- | --- |
| `--unresolved` | list reservations that are still reserved or unresolved, with the command that reconciles each |

#### `costs reconcile`

Settle an unresolved or unknown charge from the provider billing/usage history (audited; needs a named human and evidence)

```sh
npm run cli -- costs reconcile [options] <reservation-id>
```

| Option | Meaning |
| --- | --- |
| `--actual-usd <amount>` | the charged amount shown in the provider history, decimal USD (e.g. "0.0132") |
| `--not-charged` | the provider history shows NO charge for this request (recorded as $0 only with this explicit statement) |
| `--evidence <note>` | what the provider history shows (e.g. "billing page, 2026-09-21 14:02 UTC: task 0921-xxxx charged $0.0012") (required) |
| `--by <name>` | the human reconciling (automation names are refused) (required) |

## Jobs and scheduling

<!-- generated reference: see "How this reference is maintained" -->

### `jobs`

Durable jobs: list, inspect, resume after interruption, and cancel; site locks

Subcommands: `list`, `show`, `resume`, `cancel`, `locks`, `breakers`.

#### `jobs list`

List jobs for the site (newest first)

```sh
npm run cli -- jobs list [options]
```

| Option | Meaning |
| --- | --- |
| `--status <statuses>` | filter by status, comma-separated (queued, running, waiting, succeeded, failed, cancelled, interrupted) |
| `--type <type>` | filter by job type |
| `--limit <n>` | maximum number of jobs (default: `20`) |

#### `jobs show`

Show a job with its runs (pid, host) and checkpointed stage results

```sh
npm run cli -- jobs show <id>
```

No command-specific options (global options apply).

#### `jobs resume`

Recover interrupted jobs and continue them from their last successful checkpoint (all interrupted jobs and due retries when no id is given)

```sh
npm run cli -- jobs resume [options] [id]
```

| Option | Meaning |
| --- | --- |
| `--rerun-paid-stages` | with a job id: explicitly rerun paid stages that were interrupted mid-flight. Only after reconciling them (`costs --unresolved`, provider history): the provider may already have charged the earlier request |
| `--reviewed <stage>` | with a job id and --reviewer: record (audited) that you reviewed the output of the stage the job is waiting on, and continue past it |
| `--reviewer <name>` | the human who reviewed (required with --reviewed; recorded as owner:<name>; automation names such as cli, system, or scheduler are refused) |

#### `jobs cancel`

Cancel a job: immediately when not running; a running job stops at its next cooperative check, and a running job whose process on this machine is gone is marked interrupted and cancelled at once

```sh
npm run cli -- jobs cancel <id>
```

No command-specific options (global options apply).

#### `jobs locks`

Show the site's locks (job and manual-command leases) and whether each holder process is alive; --release <lock> --as <name> removes a lease whose holder is verified dead (audited)

```sh
npm run cli -- jobs locks [options]
```

| Option | Meaning |
| --- | --- |
| `--release <lock>` | lock to release (site or content); only when its holder process is verified dead on this machine (no such process, or its pid now belongs to another process) |
| `--as <name>` | the human releasing the lease (required with --release; recorded as owner:<name>; automation names such as cli, system, or scheduler are refused) |

#### `jobs breakers`

Show the persisted circuit breakers of the site (open and half-open first, with the next probe time and last error); --reset <provider> closes one (audited)

```sh
npm run cli -- jobs breakers [options]
```

| Option | Meaning |
| --- | --- |
| `--reset <provider>` | forget the breaker state of this provider (e.g. google, crawler) after fixing the cause; recorded in the audit log |

### `schedule`

Opt-in scheduling of weekly/monthly jobs (IANA time zones, DST-aware); installation is always manual

Subcommands: `show`, `instructions`, `enable`, `disable`, `run`.

#### `schedule show`

Show schedules, next runs in the schedule time zone, DST notes, and configuration drift

```sh
npm run cli -- schedule show [options]
```

| Option | Meaning |
| --- | --- |
| `--upcoming <n>` | number of upcoming runs to list (default: `3`) |

#### `schedule instructions`

Print exact launchd / systemd / cron / server-daemon snippets (nothing is installed)

```sh
npm run cli -- schedule instructions [options]
```

| Option | Meaning |
| --- | --- |
| `--platform <platforms>` | comma-separated: launchd, systemd, cron, server, or all (default: `all`) |
| `--interval <minutes>` | how often the OS timer runs the scheduler tick (5, 10, 15, 20, 30, 60) (default: `15`) |
| `--write` | also write the snippets to <workspace>/exports/scheduling/ for review (still not installed) |

#### `schedule enable`

Opt in: record a weekly or monthly schedule (cron and IANA zone from site config unless overridden). Jobs run in the --mode given (ANALYZE default, or RESEARCH). Requires a successful manual weekly or baseline run with Search Console and GA4 data first (or --force).

```sh
npm run cli -- schedule enable [options] <jobType>
```

| Option | Meaning |
| --- | --- |
| `--cron <expr>` | 5-field cron expression evaluated in the schedule time zone |
| `--timezone <iana>` | IANA time zone (default: site config scheduler.timezone) |
| `--catch-up <policy>` | after missed slots (sleep/offline): "once" runs one catch-up, "skip" waits for the next slot (default: `once`) |
| `--force` | enable even though no successful manual weekly/baseline run with Search Console and GA4 data is recorded (not recommended) |

#### `schedule disable`

Disable a weekly or monthly schedule (does not uninstall any OS timer you installed)

```sh
npm run cli -- schedule disable <jobType>
```

No command-specific options (global options apply).

#### `schedule run`

Foreground scheduler: enqueue due jobs and run them (non-overlapping per site). Use --once for a single tick from launchd/systemd/cron.

```sh
npm run cli -- schedule run [options]
```

| Option | Meaning |
| --- | --- |
| `--once` | run a single tick and exit |
| `--tick-seconds <n>` | seconds between ticks in daemon mode (default: `60`) |
| `--all-sites` | serve every site configured in the workspace |
| `--max-ticks <n>` | stop after n ticks (testing) |

## Backup, restore, and diagnostics

<!-- generated reference: see "How this reference is maintained" -->

### `backup`

Back up the database, site configs, vault, raw provider responses (data/raw), and reports into <workspace>/backups (secrets excluded)

```sh
npm run cli -- backup [options]
```

| Option | Meaning |
| --- | --- |
| `--no-vault` | skip the vault copy |
| `--no-raw` | skip data/raw (raw provider responses that observations reference as their provenance) |
| `--no-reports` | skip reports/ (generated report files the reports table points to) |

### `restore`

Restore the database from a backup (current database is saved first; a demo backup never replaces a live database); vault, config, raw responses, and reports are restored beside, never over, live files

```sh
npm run cli -- restore [options]
```

| Option | Meaning |
| --- | --- |
| `--from <dir>` | backup directory created by `backup` (required) |
| `--confirm` | required: confirm replacing the live database |
| `--force` | restore even though locks or running jobs are recorded (only when they are stale, e.g. after a crash) |

### `diagnostics`

Redacted diagnostic bundle for bug reports (written locally; never uploaded)

Subcommands: `export`, `show`, `list`.

#### `diagnostics export`

Write a redacted diagnostic bundle (JSON + Markdown) to <workspace>/diagnostics/. With --site, only that site is reported (other sites stay masked). Inspect it before sharing.

```sh
npm run cli -- diagnostics export [options]
```

| Option | Meaning |
| --- | --- |
| `--recent-jobs <n>` | number of recent jobs per site to include (0-200) (default: `20`) |

#### `diagnostics show`

Print a diagnostic bundle (JSON or Markdown). A bare file name is looked up in <workspace>/diagnostics/.

```sh
npm run cli -- diagnostics show <file>
```

No command-specific options (global options apply).

#### `diagnostics list`

List exported diagnostic bundles in <workspace>/diagnostics/

```sh
npm run cli -- diagnostics list
```

No command-specific options (global options apply).

## How this reference is maintained

The reference sections above are generated from the registered commander
tree by `npx tsx scripts/cli-reference.ts` (read-only: it builds the command
tree, runs no command action, and prints Markdown): the description, usage
line, and option table of every command and subcommand, with default values
as registered, and the `setup --only` step ids and groups. Local temporary
and home directories in computed defaults are replaced by `<os tmpdir>` and
`~`. Hand-written notes are limited to the sections before the reference.

When you add or change a command or an option, regenerate the reference
sections (replace everything from "Getting started and workspace" up to this
section with the script's output) and update the site-lock paragraph from
`npx tsx scripts/cli-reference.ts --site-lock`.
`tests/unit/cli/aliases.test.ts` checks that every registered command appears
on this page, that no unregistered command is documented, that every option
table lists exactly the registered flags, and that every npm alias maps to a
registered command; `tests/unit/cli/cli-reference.test.ts` checks the
generator; `tests/unit/docs/status-docs.test.ts` checks the site-lock list.
Module documents in [modules/](modules/) explain each area's behavior in
depth.
