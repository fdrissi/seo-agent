# Module: setup wizard and doctor

Source: `src/setup/` (wizard, drafts, config files, doctor), CLI in
`src/cli/commands/setup.ts` and `src/cli/commands/doctor.ts`.
Spec: section 3 (business configuration and setup wizard), the setup-profile
preamble, section 29 (`doctor` never spends money silently), and section 30
(first-use experience).

## Commands

```
npm run cli -- setup                          # interactive, resumable wizard (asks only for missing information)
npm run cli -- setup --site <id>              # start or resume the wizard for one site
npm run cli -- setup --update --site <id>     # add missing information to an existing config (diff shown first)
npm run cli -- setup --update --site <id> --only google.searchConsoleProperty,google.ga4PropertyId
npm run cli -- setup --list-steps             # step ids usable with --only
npm run cli -- setup --from <file.yaml>       # non-interactive import of a prepared config
npm run cli -- setup --from <file.yaml> --update [--dry-run]
npm run cli -- setup vault                    # create the site vault from vault/_template (never overwrites)

npm run cli -- doctor                         # no network requests at all
npm run cli -- doctor --network               # plus free, read-only checks
npm run cli -- doctor --allow-spend --max-usd 0.01   # plus ONE capped, chargeable LLM request
npm run cli -- doctor --server                # server checklist: loose workspace/database modes FAIL instead of WARN
```

`npm run setup` and `npm run doctor` are aliases (a test checks that they point
at registered commands). All commands accept the global `--workspace`,
`--site`, `--json`, and `--offline` options.

## Setup wizard (`src/setup/wizard.ts`)

### Flow

1. If the workspace does not exist, the wizard offers to create it (same as
   `init`: never overwrites, then migrates the database).
2. An unfinished draft is offered for resumption (`--site` picks it directly).
3. New config: the site id is asked first, because the draft file is named
   after it; an existing `<id>.yaml` is refused unless `--update` is given.
   From this point every answer is saved.
4. The profiles are explained (Demo / Core / Full: what each enables, derived
   from `PROFILE_DEFAULTS`, which credentials and which paid services it
   needs) and the profile is asked as the first step. Choosing Demo in a live
   workspace writes nothing, removes the draft that held only the site id,
   and points to `npm run demo`, which runs in an isolated demo workspace.
5. Every step that applies to the profile and whose information is missing is
   asked (see "Steps"). Steps already answered (draft) or already present in
   the existing config (update mode) are skipped. `--only` forces specific steps.
6. The whole config is validated with `src/config/site-schema.ts`. Errors are
   printed and the steps behind them are asked again (at most three rounds;
   then the wizard stops with the errors and keeps the draft).
7. The proposed file (new config) or the diff (update) is shown, and the owner
   confirms before anything is written.

### Resumable drafts

Once the site id is known, every validated answer (the profile included) is
saved atomically to `<workspace>/config/sites/.<site-id>.setup-draft.yaml`
(mode 0600). The leading
dot keeps drafts out of the site list. The draft holds completed steps, their
values, and the answers of the step in progress (so an interruption inside a
multi-part answer, for example halfway through a conversion event, resumes at
the next sub-question). Ctrl+C or end of input stops the wizard with exit code
130 and a resume command. An interruption at the site id prompt has saved
nothing, and the wizard says so instead of printing a resume command. The draft
is removed once the config is written.

A draft never contains secrets: every save checks that no configured secret
value appears in it (a secret typed into a visible field is refused).

### Steps

`npm run cli -- setup --list-steps` prints the ids. In order:

| Section | Steps (config paths) |
| --- | --- |
| Profile | `profile` |
| Website identity | `site.businessName`, `site.url`, `site.allowedHostnames` (default: host of the URL; www/non-www never merged automatically), `site.urlAliases` (alias, canonical, evidence) |
| Business | `business.offer`, `business.targetCustomer`, `business.differentiators`, `business.productFacts` (statement, source, verified date; stored facts are kept unless removed, see below), `business.approvedClaims` |
| Target market | `market.countries`, `market.languages`, `market.searchLocations` (location codes only when verified with `research locations`), `market.devices` |
| Reporting and time | `reporting.currency`, `reporting.businessTimezone`, `scheduler.timezone` (default `Europe/Tallinn`, explicitly not the target market) |
| Google access | `google.auth` (GOOGLE_AUTH_MODE and credential guidance; stored in the secrets file, not the config), `google.searchConsoleProperty`, `google.ga4PropertyId` |
| Conversions | `conversions.primaryEvents`, `conversions.secondaryEvents` (exact name, meaning, outcome type, optional value + currency; unknown value stays null) |
| Brand and scope | `brand.aliases`, `crawl.protectedPaths`, `crawl.excludedPaths`, `research.approvedDomains`, `crawl.limits` |
| Research | `research.competitors`, `research.seedTopics`, `research.subreddits`, `research.dataforseo.mode` (only when DataForSEO is enabled; sandbox suggested) |
| Editorial | `editorial.brandVoice`, `business.prohibitedClaims`, `editorial.rules` (default: clear language, no emojis, no em dashes; extra requirements) |
| Features | `features` (profile defaults shown; paid add-ons flagged) |
| Credentials | `credentials` (see "Secrets") |
| Models | `models` (cheap / reasoning / embedding ids) |
| Budgets | `budgets` (defaults shown as ceilings, not quotes) |
| Scheduling | `scheduler.weekly`, `scheduler.monthly` (opt-in preference only) |

Blank answers to optional questions mean "unknown" and stay `null`/empty;
nothing is invented. Invalid answers are re-asked with the specific problem
(for example a GA4 measurement id `G-...` instead of the numeric property id,
a UTC offset instead of an IANA zone, a URL where a bare hostname is needed).

Re-asking a step that holds stored entries never silently drops them.
`business.productFacts`, `conversions.primaryEvents`, and
`conversions.secondaryEvents` (for example with
`setup --update --only business.productFacts`) first list the stored entries
and ask `Keep "<statement or event name>"? [Y/n]` for each; a blank answer
keeps it. Kept entries stay exactly as stored (product facts keep their ids,
so briefs and drafts that cite a fact id still point at the same fact), and
new entries are appended after them. A new product fact gets a fresh
`fact-N` id that no stored fact had, including one removed in this run.
Removing an entry takes an explicit `n`, the wizard says how many will be
removed, and the diff shown before writing names them; nothing is written
until the owner confirms. Product facts drive the claim-support gates, so
losing them would weaken content checks. The other list steps (for example
`business.differentiators`, `business.approvedClaims`, `site.urlAliases`)
replace the stored list with the answers given; the diff shows the change
before anything is written.

### Search Console property and model ids

- The property is never constructed from the site URL. When Google credentials
  are present (and not `--offline`), the wizard asks before making one free
  `sites.list` request through the google slice (`discoverGscProperties`) and
  offers the readable properties by number; only an exact listed property is
  accepted. Without authorization the owner can type the exact property or
  leave it for `setup --update --only google.searchConsoleProperty` after
  `auth google`.
- Model ids are never hardcoded. Environment overrides (`CHEAP_MODEL`, ...)
  skip the questions. With `LLM_GATEWAY_API_KEY` present the wizard asks before
  one free `GET /v1/models` (llm slice `discoverModels`) and then only accepts
  ids in the catalog with the right kind (chat vs embedding); a model without a
  verified price is accepted with a note that its calls are skipped until
  `llm.pricingOverrides` holds a verified price.
- Both helpers run against a throwaway in-memory database, so an unfinished
  setup never registers the site or caches anything in the workspace database.

### Secrets

Secrets are stored separately from the site config. For each credential the
enabled features need (`secretNeeds`: LLM Gateway key, DataForSEO login and
password when its mode is not `disabled`, Apify token, PageSpeed key, optional
Qdrant key) and that is not already set, the owner chooses:

1. enter it now: hidden input (never echoed, no readline history), written by
   `SecretStore.set` to `<workspace>/secrets/secrets.env` (atomic, mode 0600);
2. inject it through the environment (for example a password manager);
3. skip for now.

Secret values never reach the draft, the site config, the vault, the output,
or `--json` results (only key names). Nobody is ever asked to paste a secret
into a chat. Google credentials are files: the wizard stores
`GOOGLE_AUTH_MODE` (and optionally the service-account file path) and points to
`auth google` for the OAuth flow.

### Writing the config

- New config: written only when valid, with a create-only atomic write (an
  existing file is never replaced), mode 0600, with a header comment.
- `--update`: the diff against the current file is shown and confirmed. Only
  answered keys change; unchanged sections are copied verbatim so comments and
  formatting survive (if that splice ever parsed to a different value, the plain
  re-serialization is used). A copy of the previous file goes to
  `<workspace>/backups/config/<id>-<timestamp>.yaml`, and the write fails if the
  file changed after the diff was computed.
- The proposed text and the existing text are checked for configured secret
  values before anything is displayed or written.

### Non-interactive import (`setup --from`)

The file must validate against the schema, must not contain unknown keys
(typos would silently disable settings; secrets never belong there), must not
contain a configured secret value, and must not use the demo profile in a live
workspace. Its text is kept verbatim. An existing config is only replaced with
`--update` (diff shown, backup kept); `--dry-run` shows the plan and writes
nothing. A missing workspace is created first.

### Testing hooks

`runSetupWizard({ io, paths, secrets, services, ... })` takes a `PromptIO`:
`createTerminalPromptIO()` (node:readline/promises; lines are queued so piped
input works; output is muted while a secret is typed) or `ScriptedPromptIO`
(answers by question key, simulated interruptions). The CLI's
`setupCliDeps` exposes the prompt IO and the discovery helpers for tests.

## Doctor (`src/setup/doctor.ts`)

`runDoctor(opts)` returns a `DoctorReport` (`--json`) with checks at levels
`ok`, `info`, `warn`, `fail`, per-site integration statuses, the network
requests made (method, host, path; never query strings), spending, and
deduplicated next steps (failures first). Exit code 1 when any check fails.

| Area | Checks |
| --- | --- |
| Runtime | Node version against `package.json` engines; LTS vs Current vs odd release line from `process.release.lts` (Active vs Maintenance LTS depends on the date, so the release schedule link is given); compiled build freshness (`runtime.build`, see below); Playwright importability (optional) |
| Workspace | manifest and format version, writability, permissions (`secrets/` and `secrets/google/` 0700; `secrets.env`, Google credential files, and setup drafts 0600; exact `chmod` commands; a failure), private data permissions (the workspace root and `data/` 0700, the database and its `-wal`/`-shm`/`-journal` files 0600: WARN, FAIL with `--server`, with the `chmod` commands), all private data locations outside the application repository |
| Configuration | every site config validates, non-fatal warnings (including `llm.allowPersonalData` with its reason and a live DataForSEO queue without a justification), unfinished setup drafts (with the resume command), demo/live separation (`FAIL` for a demo-profile site in a live workspace and for a live site in a demo workspace, because every command refuses them), `GOOGLE_AUTH_MODE` via `resolveGoogleAuthMode` |
| Database | migrations current, pending (next step `db migrate`), or unknown (newer database). The sites recorded in the database must match the workspace kind (`database.demo-live`: `FAIL` for a demo site in a live workspace's database, for example one restored by an older version, and for a live site in a demo workspace's database). A live workspace also fails when current Search Console or GA4 rows are labeled synthetic (`is_synthetic = 1` in `gsc_*` / `ga4_*`, for example from a synthetic `data import` that an older version accepted; `data import` now refuses one in a live workspace): the detail names the tables, sites, and batches, and the next step is to restore a backup taken before those rows arrived (or, for rows from an import, to re-import the owner's real file, which supersedes the synthetic revision of the same key). Doctor never migrates: without a current database the integration checks use a temporary in-memory database and say so |
| Integrations (per site) | `googleStatus` (auth, Search Console, GA4, URL Inspection), `crawlerStatus` (crawler, Playwright, last crawl), `performanceStatuses` (PageSpeed, CrUX), `llmStatus`, `memoryStatus` (Qdrant, including the free health check with `--network`), `dataforseoStatus`, `apifyStatus`, the vault status (presence, with `setup vault` as next step) |
| Jobs | schedules (`describeSchedules`: enabled without a registered handler, drift, blocked by an interrupted job), open/interrupted/failed jobs, active locks, open and half-open provider circuit breakers (read-only SQL on `circuit_breakers`: provider, state, failures, next probe time, redacted last error; next step `jobs breakers --reset <provider>`) |

### Compiled build freshness

`npm run build` runs `tsc -p tsconfig.build.json` and then
`scripts/write-build-info.mjs`, which writes `dist/build-info.json`: package
version, Git revision (when available), a sha256 over `src/**/*.ts`, and the
sorted `migrations/` list. The script refuses to stamp a `dist/` whose compiled
files are older than their sources. `src/setup/build-info.ts` compares the
stamp with the files on disk (`fresh`, `stale`, `unstamped`, `not_built`):

- `schedule instructions` uses `dist/cli/main.js` only when it is fresh;
  otherwise it falls back to the sources and prints a WARNING naming the
  reasons and the repair steps.
- `schedule run` refuses to start from a compiled build that is unstamped or
  whose stamp does not match `migrations/` (before any database is opened).
- The CLI entry point prints a WARNING when it runs from a stale or unstamped
  compiled build.
- `migrate()` running compiled applies only migrations listed in the stamp
  (none for an unstamped build), and refuses before writing anything.
- doctor: `runtime.build` is ok when the build matches, info without a
  `dist/`, warn for a stale `dist/`, and fail when doctor itself runs from a
  build that `schedule run` would refuse.

Every one of these messages names the repair from `buildRepairSteps`: a
checkout (with `src/`) is told to run `npm run build` and re-run `schedule
instructions`; a packaged install or container image (no `src/`, which cannot
be rebuilt in place) is told to reinstall or upgrade the package or pull or
rebuild the image (`REINSTALL_STEPS`), never to run `npm run build`. For such
an install, the `schedule instructions` warning also says that the fallback
commands (which point at the sources) cannot run either.

State to level: `ready` ok; `configured_unverified`, `disabled`, `fixture`
info; `missing_credentials`, `degraded`, `unreachable`, `unresolved` warn;
`misconfigured`, `permission_denied` fail. A failing status check is reported
as `degraded` with its error, never as success.

### Network and spending

- Default: no network. Every provider adapter receives a fetch that refuses
  and records the attempt, so a regression cannot silently go online (tests
  also replace the global fetch and assert zero calls).
- `--network`: only the slices' free, read-only checks (models list and key
  budget, `sites.list` and GA4 metadata, DataForSEO `user_data`, Apify reads,
  Qdrant health, a CrUX origin query, the site's robots.txt).
- `--allow-spend --max-usd <cap>`: the cap is printed before anything runs.
  At most ONE chargeable request is made in the whole run: a minimal
  cheap-tier LLM Gateway completion (prompt `system.connection-test`, 16 output
  tokens) whose cost upper bound is capped and reserved by the LLM client. It
  runs only when the LLM connection is configured; the actual cost is reported,
  and an unreported cost is shown as unknown (kept reserved), never $0. Apify
  and DataForSEO paid tests are never run by doctor (`apify test ...` and
  `research keyword --sandbox` exist for that). `--allow-spend` without
  `--max-usd` (or the reverse) is refused before any check. `--dry-run` shows
  the planned chargeable request without sending it. `--offline` overrides all
  network use. It is a per-run switch, not a configuration problem: with
  configured credentials, DataForSEO is reported `disabled` (info, "Run
  without --offline") and memory embeddings say the network is disabled for
  this run, never that a key or model is missing
  (`tests/integration/dataforseo/status.test.ts`,
  `tests/integration/memory/status.test.ts`).
- A DNS failure during the `--network` crawler check is `unreachable` (warn)
  with a retry next step, never `misconfigured`
  (`tests/integration/crawler/crawl-site.test.ts`).

## Data sent externally

The wizard sends nothing unless the owner agrees to a lookup: one Search
Console `sites.list` request to Google, or one `GET /v1/models` to the LLM
Gateway. Doctor sends nothing by default; with `--network` it makes the free
status requests listed above (credentials go only to their own provider); with
`--allow-spend` one short connectivity prompt (no site data) goes to the LLM
Gateway.

## Limitations

- The terminal hidden input relies on muting readline's echo; it was tested
  with synthetic TTY streams, not with every terminal emulator.
- `--update` re-asks fields that are empty in the existing config (an empty
  competitor list is indistinguishable from "not asked yet"); `--only` limits
  the questions.
- Doctor cannot tell Active from Maintenance LTS offline; it links to the
  official release schedule.
- Live behaviour of the Google and LLM Gateway lookups inside the wizard is
  tested only with injected fakes (no credentials in this environment).

## Tests

- `tests/unit/setup/`: answer parsers, terminal/scripted prompt IO (hidden
  input never echoed on a TTY, piped input, end-of-input), config splicing and
  error-to-step mapping, doctor helpers (Node check, state levels, network
  guard), credential needs per profile.
- `tests/integration/setup/wizard.test.ts`: create flow, resume after
  interruption (including mid-answer), only-missing prompts in update mode,
  `--only`, invalid input re-prompted, whole-config validation re-asks, secrets
  stored only via hidden input in the 0600 file and never in the draft, config,
  or output, refusal of a secret typed into a visible field, no overwrite of an
  existing config, declined updates, property discovery (exact choice only),
  model verification, offline mode.
- `tests/integration/setup/setup-cli.test.ts`: `setup --from` (valid, invalid,
  unknown keys, secret values, no overwrite without `--update`, diff and
  backup, dry run, demo refusal, workspace creation), the interactive CLI with
  an injected prompt IO, exit code 130 on interruption, `setup vault`.
- `tests/integration/setup/build-info.test.ts`: the build script and the
  runtime hash the same sources and list the same migrations, stamping and its
  refusals, stale/unstamped/fresh detection, the `schedule run` refusal (CLI),
  the migration guard, and the startup warning.
- `tests/integration/setup/doctor-ops.test.ts`: workspace/data/database
  permissions (WARN, FAIL with `--server`), the build freshness check, and the
  circuit-breaker listing.
- `tests/integration/setup/doctor.test.ts`: zero network requests without
  `--network` even with every credential configured, `--network` performs only
  GET requests and no chargeable endpoint, spending flags and the capped single
  request, dry run, honest missing-credential statuses with next steps,
  permissions/drafts/invalid configs/auth mode, no migration and no database
  creation, missing workspace, vault/jobs/schedules.
