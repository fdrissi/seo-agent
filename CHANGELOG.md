# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is below 1.0.0, minor versions may contain breaking changes;
they are always listed under **Changed** or **Removed** with upgrade steps.

Every release entry must also state: new or changed database migrations (with
the pre-migration backup reminder), configuration schema changes, new data
sent to external services, and new paid-service usage.

## [Unreleased]

### Fourth round of fixes (2026-09-25)

Fixes from a fourth audit round. Every change is tested offline (296 test
files, 3390 tests, on Node.js 24.21.0 and 26.3.0); no integration was tested
live, and no `docker build` was run. Statuses are in
`docs/FEATURE_STATUS.md` and the requirement-to-test mapping is in
`docs/REQUIREMENTS_TRACEABILITY.md`.

**Upgrade notice.**

- No new database migration, no site-config schema change, and no
  `workspace.json` change.
- Human names are checked more strictly wherever a human decision is
  recorded (`approvals`, `experiments`, `export --as`, `costs reconcile --by`,
  `content mark-reviewed` and `revise-manual`, `vault apply-business --by`,
  `sync ga4 --confirm-rate-scale --as`, `jobs resume --reviewer`,
  `jobs locks --release --as`). Names are asserted, not authenticated, so
  only obvious automation and account names are refused, but the list is
  longer now: the whole names `owner`, `admin`, `administrator`, `root`,
  `node`, `runner`, `daemon`, `www-data`, `ubuntu`, `ec2-user`, `service`,
  `user`, and `default`, look-alike and mixed-script spellings, and
  concatenations such as `claudecode` or `seoagent`. Where `--as` (or `--by`)
  may be omitted, a service-account operating-system user (`node`, `runner`,
  `root`, `daemon`, `www-data`, `ubuntu`, `ec2-user`, `nobody`) is no longer
  used: in the container image (user `node`) and on GitHub-hosted CI (user
  `runner`), pass `--as "<your name>"` (`--by` for `vault apply-business`).
  Scripts that recorded decisions as `owner` must name a person.
- `data import` into a live workspace refuses a synthetic file (`--synthetic`,
  a file that declares itself synthetic, such as a `data export` of a demo
  workspace, or rows marked `is_synthetic = 1`) with `WORKSPACE_UNSAFE`,
  previews included. `doctor` now fails a live workspace whose current Search
  Console or GA4 rows are labeled synthetic (for example from a synthetic
  import that an older version accepted) and names the fix: restore a backup
  from before, or re-import the real files.
- `data export --out` refuses a file inside the vault, `secrets/`, or the
  application repository outside the workspace (`UNSAFE_PATH`).
- The experiment evaluation method is version 3 (GA4 estimates, see
  Changed): an experiment frozen under an earlier version is evaluated with
  a "measurement method changed" caution.
- Recommendations are `recommend@1.4.0`. Report freshness claim ids are now
  `freshness.<source>.<dataset>`.
- New data sent externally: none. New paid-service usage: none.

#### Added

- Router reasons record the measured inputs they rest on (`data.inputs`:
  per-query rows, page totals, GA4 values, coverage, crawl or URL Inspection
  observations, site totals; a value that was not observed is `null`, never
  0). The recommendation's route claims and the site-level measurement and
  low-data claims cite them as one evidence item, so reports show them as
  supported; a route without measured inputs is context.
- A verified GA4 rate whose 0-1 or 0-100 scale rests on an owner assertion
  says so: the report claims, the monthly rate comparison, the baseline rate
  claim, and the dashboard name the assertion (id, author, date) and cite its
  confirmation row, and an info data-quality item
  (`ga4_rate_scale_owner_assertion`) lists it once.
- The content pipeline respects the observation freeze: an item whose target
  page is under an observing experiment is deferred, and `content brief` and
  `content draft` refuse with `CONFLICT` before an approval request or a paid
  draft.
- `doctor` checks a live workspace's database for current Search Console and
  GA4 rows labeled synthetic.

#### Changed

- Every printed `sync ga4 --confirm-rate-scale` command (reports' next
  action and data-quality next steps, the "rate scale unverified" reason,
  router notes, `analyze page`) includes `--as "<your name>"` and runs as
  printed.
- The `content` commands write their notes through the vault renderer: one
  note per item, brief, and draft, and one pipeline note. Content notes
  written by earlier versions under their own paths are reported by
  `vault check` as stale duplicates and marked stale by `vault render`
  (human text kept).
- The vault's draft review package shows internal-link suggestions as
  readable lines and a missing structured-data proposal as "None proposed.",
  like the content pipeline note.
- Experiment windows treat values from sampled or `(other)`-bucketed GA4
  reports as estimates even when the page has a row every day: the window is
  incomplete, and the conversion comparisons and GA4 guardrails are not
  judged.
- Pipelines: a stage whose own note says offline, skipped, or degraded is
  logged at warn with its status and code; the pipeline commands and the
  demo print one shared stage table; a dry run shows `sync_gsc`, `sync_ga4`,
  and `crawl_site` as skipped (`DRY_RUN`, `CRAWL_DRY_RUN`: nothing was
  requested or written) and says whether the credentials were checked
  locally; the demo's interrupt step lists checkpointed stages that did not
  do all of their work apart from the completed ones.
- The resume command shown for a crashed RESEARCH job (`jobs list`,
  `jobs show`, `jobs locks`, the `LOCKED` next step) names `--mode RESEARCH`.
- `doctor`, `schedule run`, and `schedule instructions` tell a packaged
  install or container image without `src/` to reinstall or upgrade, never to
  run `npm run build`.
- With `--offline`, the DataForSEO status is `disabled` (doctor INFO) and
  memory embeddings say the network is disabled for the run, never that a key
  or model is missing.
- Report freshness: one entry per source and dataset with a unique claim id;
  a dataset filled only by an owner import is not also listed as never
  synced.
- `data export` of a demo workspace labels every dataset synthetic (a
  `# SYNTHETIC` CSV comment line, `containsSynthetic`, and a derived
  `is_synthetic` column for recommendations, opportunities, and keywords);
  `data import` honours a `property` column in any file.

#### Fixed

- An own-site DNS or network failure is a transient `CRAWL_NETWORK_ERROR`
  with a retry next step, and `crawl status --network` reports it as
  unreachable, never as an SSRF refusal or a misconfigured `site.url`.
- A `--manual-urls` competitor URL refused by the SSRF guard is recorded only
  as a blocked crawl result and never becomes a tracked competitor page that
  the monthly re-check retries.
- Resuming Apify runs with nothing pending is `ok` in every mode, so the
  content queue gets no spurious OFFLINE note (the demo's content step is
  `[ok]`).
- A synthetic row never supersedes a live row in `data import`, even with
  `--replace`, and a row whose synthetic label changed is a new revision,
  never "unchanged".
- Duplicate freshness claim ids in workspaces that import Search Console data.

#### Security

- Human names: NFKC normalization, mixed-script and look-alike refusal,
  automation words inside concatenated names, reserved whole names, and
  service-account operating-system users (see the upgrade notice).
- Path checks for credentials, relocated workspace folders, forbidden roots,
  and `data export --out` ignore letter case on a case-insensitive volume
  (macOS APFS, Windows NTFS), so `<ws>/Vault/token.json` counts as inside the
  vault.
- Query-parameter redaction stops at `<`, `>`, or a `,` that starts another
  URL, so the text around a masked value stays readable.
- Bidi controls in generated note properties and in model draft bodies under
  human review become visible `[U+XXXX]` markers.

### Third round of fixes (2026-09-25)

Fixes from a third audit round. Every change is tested offline (291 test
files, 3291 tests, on Node.js 24.21.0 and 26.3.0); no integration was tested
live, and no `docker build` was run. Statuses are in
`docs/FEATURE_STATUS.md` and the requirement-to-test mapping is in
`docs/REQUIREMENTS_TRACEABILITY.md`.

**Upgrade notice.**

- No new database migration. No site-config schema change: existing configs
  stay valid. `workspace.json` accepts one more optional `paths` key,
  `reportsDir` (validated like the other relocatable folders).
- The synthetic `config/sites/example.site.yaml` now leaves
  `reporting.businessTimezone` unknown (`null`): a config copied from it
  warns until you set your business's IANA zone.
- `sync ga4 --confirm-rate-scale` now requires `--as "<your name>"` (a
  validated human name; there is no default identity). In this round the
  command printed by the reports' next action and the "rate scale
  unverified" reason still omitted `--as`; the fourth round adds it.
- `vault apply-business` no longer records the anonymous `owner` by default:
  without `--by` it records your operating-system user, and automation names
  are refused.
- `backup` now also copies `data/raw` (raw provider responses) and
  `reports/` by default, so backups are larger; `--no-raw` and
  `--no-reports` skip them. `restore` refuses a demo backup in a live
  workspace and a live backup in a demo workspace.
- Twelve more manual commands take the per-site lease (see Changed), so
  they refuse with `LOCKED` while a job runs.
- `npm run release:check` now fails when the packed `dist/` is missing,
  unstamped, or stale: run `npm run build` first. The Dockerfile build stage
  now copies `scripts/write-build-info.mjs` and `migrations/`.
- New data sent externally: the next Search Console sync re-requests the
  dates that are known only from an owner import without `--complete`
  (same API, same property, read-only, once). New paid-service usage: none.

#### Added

- `jobs locks` shows each site and content lease with its holder and
  whether the holder process is alive; `jobs locks --release <lock> --as
  "<your name>"` removes a lease whose holder process is verified dead
  (audited). A manual lease records its holder process's start time, so a
  reused process id does not count as the holder.
- `backup --no-raw`, `backup --no-reports`.
- `release:check` items `docker-build-inputs` (the Dockerfile build stage
  copies every input `npm run build` needs, checked by parsing the
  Dockerfile) and a failing `npm-pack-build` for an unstamped or stale
  packed build.

#### Changed

- `analyze page`, `analyze route`, `analyze reconcile`, `report build`,
  `vault render`, `content import`, `content measure`, and `apify inspect`
  take the per-site lease; `pages infer-types --apply`,
  `vault import-business --apply`, `research tasks --poll`/`--abandon`, and
  `apify runs --resume`/`--confirm-not-accepted` take it with those options.
- `content publish-check` enforces the same recorded human acceptance as
  `export draft`: an automated pass plus a valid approval is BLOCKED until
  `content mark-reviewed`; the ALLOWED line names who accepted the body,
  when, and the approval.
- `content mark-reviewed` and `content revise-manual` validate the human
  name for every caller, not only the CLI.
- A writer's "verified" fact-check note can be supported only by owner
  statements, first-party measurements (numeric statements only), or the
  target page's text; demand signals, SERP items, retrieved notes, and
  third-party metrics never verify a fact.
- Experiment windows apply the GA4 row-loss rule: a landing row missing on
  a date with `(other)` bucketing, thresholding, or sampling is unknown,
  never zero.
- Memory indexing with Qdrant or embeddings disabled in the config is
  skipped by policy, not degraded.
- Weekly research candidates read one Search Console property and search
  type; an explicit historical period's report says its recommendation was
  for review only; the monthly `ai_visibility` stage reports `null` checks,
  not 0, when disabled or the period is unknown.
- Spend in the run summary, the vault system log, and the report keeps
  provider-reported and computed-from-usage amounts apart; a verified $0 of
  a free sandbox or fixture request is a fixed zero; synthetic reservations
  never use up a shared account cap.
- The setup wizard's `business.productFacts` step asks to keep each stored
  fact; a blank answer never wipes stored facts.
- `workspace.json` can relocate `reportsDir`.

#### Fixed

- `research keyword` exits 1 when every query failed and 2 for a partial,
  skipped, or ambiguous result (never "partial" with exit 0).
- `sync gsc --dry-run` and `sync ga4 --dry-run` check credentials locally
  and fail like the real run without them.
- `jobs cancel` of a job whose process is gone cancels it at once and
  releases its lock; `jobs show` and the demo never print a bare "succeeded"
  for a stage counted as degraded.
- `data import` of a `data export` keeps its synthetic label, property,
  segments, and finality; imports into a demo workspace are synthetic;
  prototype names are refused as datasets; the default export stays inside
  `<workspace>/exports/data`.
- Dates from an owner import without `--complete` are described as such,
  never as an API row limit; a `--complete` re-import with unchanged rows
  still covers its range; such dates are re-collected by the next sync.
- A connection the operating system refuses at once (for example an egress
  firewall) fails the request instead of crashing the process.
- `crawl competitor --manual-urls` never says pages were crawled when every
  URL was blocked; a demo workspace's `auth status` never claims network
  checks; a failed content job keeps its error code (`OFFLINE`).
- A packaged install without `src/` is told to reinstall or upgrade, not to
  run `npm run build`, in the refused-migration hint and startup warning.

#### Security

- `sync ga4 --confirm-rate-scale`, `vault apply-business --by`, and
  `jobs locks --release` accept only named humans.
- Credential paths that reach the vault or the repository through a symlink
  are refused, and the token store re-checks before writing.
- Percent-encoded emails and IPv6 addresses are masked in model-bound and
  memory text; a credential query value containing `)` or `'` is masked
  whole.
- Bidi controls in vault text become visible `[U+XXXX]` markers; control
  characters in `data import` and `ai-citations import` text are replaced
  before storing; `schedule run` ticks, the `Fatal:` line, and
  `data export --out -` on a terminal are terminal-safe.
- `vault render` draft notes show a writer's "verified" as model-claimed and
  ignore forged human confirmations.

### Second round of fixes (2026-09-25)

Fixes from a second audit round. Every change is tested offline (283 test
files, 3115 tests, on Node.js 24.21.0 and 26.3.0); no integration was tested
live. Statuses are in `docs/FEATURE_STATUS.md` and the requirement-to-test
mapping is in `docs/REQUIREMENTS_TRACEABILITY.md`.

**Upgrade notice: database and build.**

- New migrations (forward-only, additive; a verified pre-migration backup is
  written automatically, but take your own `npm run backup` first and stop
  any scheduler): `0300_ai_citation_manual_import`, `0310_cost_provenance`
  (back-fills the basis of existing reconciled cost rows from the ledger and
  flags rows of synthetic provider requests or demo sites; nothing is
  guessed), and `0320_ga4_rate_scale_confirmation` (append-only).
- The workspace database is now created with mode 0600 (with its
  `-wal`/`-shm` files); looser files from older versions are tightened when
  they are next opened for writing.
- `npm run build` now stamps `dist/build-info.json`. Rebuild after every
  checkout: a compiled build applies only the migrations it was stamped
  with, `schedule run` refuses an unstamped or mismatched build, and
  `schedule instructions` never points a scheduler at a stale build. Re-run
  `schedule instructions` after upgrading.
- URL identities now normalize percent-encoding (RFC 3986). Run
  `npm run cli -- analyze reconcile` once after upgrading, before the next
  crawl (see `docs/UPGRADING.md`).
- No site-config schema change: existing configs stay valid.
- New data sent externally: the Search Console sync re-requests page/query
  rows stored as not final once their dates are final (also for pages that
  left the top N), and the weekly and monthly jobs request country/device
  page totals for the report period when `market.countries` or
  `market.devices` is set. Same API, same property, read-only.
- New paid-service usage: none.

#### Added

- Commands: `ai-citations status`, `ai-citations import`, `ai-citations
  list` (optional AI-citation monitoring by manual import, off by default);
  `content revise-manual` (a human-edited draft body as a new version, DRAFT
  mode, no model call); `jobs breakers [--reset <provider>]`.
- Flags: `sync ga4 --confirm-rate-scale fraction|percent --evidence <text>
  [--as <name>]` (record the GA4 key-event rate scale; no GA4 request,
  audited); `doctor --server`; `crawl competitor --manual-urls`;
  `data import --unguard`; `setup --only` accepts step groups (for example
  `conversions`).
- Weekly `site_structure` stage (free, read-only): internal-link suggestions,
  potential orphans, and page-level AEO checks in the weekly report. Page
  notes and the `09 AI Search` note show AEO checks and internal links; the
  monthly report shows page-level AEO checks.
- `vault render` marks a generated note stale in place when its record no
  longer exists.
- `scripts/cli-reference.ts` generates the reference sections of
  `docs/CLI.md`; the alias test compares every option table with the
  registered flags.

#### Changed

- Manual commands that change data or spend money take the per-site lease
  while they run (also `memory sync/rebuild/reconcile`, `content bootstrap`,
  `models test`, `costs reconcile`, `apify import-schema`, and `memory search
  --allow-paid`), so a scheduled job never starts in the middle of a long
  manual crawl. A foreground pipeline refused with `LOCKED` closes the job it
  created as `cancelled`.
- `<pipeline> --resume <jobId> --dry-run` is refused before anything runs.
- A production-bound draft export needs a named human's recorded acceptance
  of the exact body (`content mark-reviewed`) in addition to the approval.
- Experiments: risks must be stated; a specified revision is typed by its
  structured change; comparison pages and metrics come from one Search
  Console property, search type, and segment; the recommendation behind an
  experiment moves with it and is never superseded while the experiment is
  open.
- Recommendations (`recommend@1.3.0`): owner decisions resolved on page, URL,
  query, keyword, opportunity, recommendation, and experiment subjects;
  standing vault decisions apply whatever their age; a rejected proposal
  stays rejected under a new id; two memory searches; what was consulted is
  recorded in `details.priorContext`.
- Routing (`router-rules@1.1.0`): an unverified GA4 rate scale is a
  `RATE_SCALE_UNVERIFIED` note (conversions not assessed), never a reason to
  route a page to INVALID_OR_INCOMPLETE_DATA; HEALTHY needs observed page
  impressions.
- An exhausted LLM budget never blocks a pipeline; `cost_plan` checks what
  is left of the budgets. The report period drives the join check and the
  routing window; a historical weekly period saves nothing.
- `crawl competitor --query` fetches only URLs listed in a stored SERP
  snapshot of that query (or on approved hosts) unless `--manual-urls`.
- Costs: provider-reported and computed-from-usage amounts are shown apart;
  demo workspaces and demo listings are labeled SYNTHETIC DEMO DATA;
  sandbox and fixture research take a verified-$0 reservation.

#### Fixed

- GA4: the key-event rate scale can be established (value above 1, owner
  confirmation, or an integer-consistency proof) and stored rates are
  re-marked; a landing page absent on a date with `(other)` bucketing,
  thresholding, or sampling is incomplete, never 0; extra primary events are
  reported as not rated; a missing `rowCount` is never 0.
- Search Console: owner imports count as coverage (`--complete` makes an
  absence a real zero); not-final page/query rows are settled; a short last
  page at the page guard is not truncation.
- URL identities: percent-encoding normalized; old-form pages rewritten in
  place.
- Jobs: offline runs never open a circuit breaker; `jobs list`, `jobs show`,
  `--json`, and the headline count the same degraded stages; unknown LLM
  charges are counted in the budget month.
- Content: a writer's "verified" fact-check note needs cited evidence; the
  demo narrates the final draft's verdict; Reddit posters are never called
  customers; imports ignore prototype-named columns and strip control
  characters; the CSV formula guard round-trips.
- Technical findings record their checks version (`technical-checks@1`).
- The setup wizard asks the site ID first, so every later answer is saved.
- Owner-facing hints name only real commands and options (checked by a
  test).

#### Security

- Untrusted text never reaches the terminal as escape sequences: control,
  bidi, and invisible characters are shown as `[U+XXXX]` markers (JSON output
  and the JSON log keep the exact text).
- Template variables are scanned for injection text; report claims that
  embed searcher-typed text reach the summary model as `user_reported`.
- The workspace database is 0600; `doctor --server` fails on a workspace or
  database readable by others.

### Audit fixes (2026-09-24)

One set of fixes from an audit of 0.1.0 against the build specification.
Every change is tested offline; no integration was tested live. Statuses
are in `docs/FEATURE_STATUS.md` and the requirement-to-test mapping is in
`docs/REQUIREMENTS_TRACEABILITY.md`.

**Upgrade notice: database and configuration.**

- New migrations (forward-only, additive; a verified pre-migration backup is
  written automatically, but take your own `npm run backup` first and stop
  any scheduler before upgrading): `0200_metric_grains` (removes exact
  duplicate observations, keeping the earliest, and adds the missing unique
  keys), `0201_observation_provenance`, `0202_config_activations`,
  `0203_keyword_language_dedup` (merges research-language duplicates of the
  same keyword), `0210_competitive_comparisons`, `0211_page_type_source`,
  `0220_memory_fts_trigram`, `0221_embedding_returned_model`, and
  `0250_apify_readme_provenance`. `0200` and `0203` delete duplicate rows,
  so the backup matters.
- Configuration migration: `config migrate` (new) upgrades site configs and
  `workspace.json` written in an older format. It shows the diff, writes
  only with `--yes`, and copies the originals to `backups/config/<timestamp>/`
  first. Nothing migrates automatically: an older format is refused with a
  pointer to the command. This release does not change the format (site
  config `schemaVersion` and workspace `formatVersion` stay 1), so existing
  files need no migration; run `npm run cli -- config migrate` to confirm.
- New optional site-config fields, all with defaults (existing configs stay
  valid): `site.pageTypes`, the `router.*` thresholds
  (`conversionPoorRatio`, `notSetShareMax`, `requireConversionDefinition`,
  `commercialPageTypes`, `minClicksForJoinCheck`,
  `minPreviousConversionsForDecline`) and `router.ruleOrder`,
  `llm.allowPersonalData` with `llm.personalDataReason`,
  `conversions.primaryEvents[].verifiedAt` and `verificationNote`, and
  `research.dataforseo.liveQueueJustification`. `workspace.json` may carry a
  `paths` block. `GSC_BASE_URL` is now a documented environment key
  (Google hosts only).
- New data sent externally: `apify research` sends one community name per
  run in the actor's `withinCommunity` field (from `research.subreddits`);
  `apify research --classify-with-llm` sends normalized,
  personal-data-minimized Reddit excerpts to the LLM Gateway; the weekly
  `compare` stage sends page and competitor summaries to the reasoning model
  (`analysis.serp-synthesis`) when one is configured. Personal identifiers in
  model-bound data are now masked unless `llm.allowPersonalData` is set.
- New paid-service usage: `apify research` (Apify runs, `--mode RESEARCH`,
  `--confirm-spend`, and a total `--max-usd` required),
  `--classify-with-llm --llm-max-usd` (LLM Gateway), and the weekly SERP
  synthesis (LLM Gateway, at most 10% of `budgets.llmGateway.perRun`, only
  with a configured reasoning model). All are budget-reserved.

#### Added

- Commands: `config migrate`; `pages list`, `pages set-type`,
  `pages infer-types` (page types with provenance: owner > `site.pageTypes` >
  inferred); `experiments specify-change` (record one concrete change for an
  investigation recommendation); `costs reconcile` (settle an unresolved or
  unknown charge from provider history, audited); `apify research`
  (bounded content research, one run per community); `crawl aeo` (heuristic
  AEO assessment, also in `crawl page`); `data export` and `data import`
  (CSV/JSON at the stored grain; Search Console exports and keyword lists as
  versioned `import` batches).
- Flags: `init --allow-existing-dir`, `export --invalidate-stale`,
  `schedule enable --force`, `crawl competitor --refresh`,
  `experiments propose --segment`, `apify research --classify-with-llm`.
- Weekly `compare` stage: deep comparison of up to three researched
  candidates with their localized SERP competitors, stored in
  `competitive_comparisons` and attached to the primary recommendation.
- Free `index_memory` stage in the weekly, monthly, and content-queue
  pipelines.
- Versioned structured-data requirement table for the content quality gate
  (`docs/integration-contracts.md`).
- `docs/ACCESS_SETUP.md` section 10: the first-month checklist.

#### Changed

- Manual commands that change data or spend money refuse with `LOCKED` while
  a job holds the site lock (`--dry-run` still works). Content jobs keep
  their separate `content` lock.
- `schedule enable` refuses until a manual weekly or baseline run succeeded
  with Search Console and GA4 data, unless `--force`.
- `jobs resume --reviewed` requires `--reviewer <name>`; automation names are
  refused for reviewers and approvers.
- `crawl competitor`, `apify test`, and `apify research` need
  `--mode RESEARCH`. `analyze compare` requires `--query` (or explicit
  `--competitor` URLs).
- `export --dry-run` writes, consumes, and invalidates nothing; a revision
  mismatch is refused instead of invalidating the approval.
- `content brief`, `content draft`, `content review`, and `content batch` run
  as durable, checkpointed jobs.
- `--mode RESEARCH` pipelines print their spending caps before starting;
  pipeline summaries never show a degraded run as a bare "succeeded".
- Every command's `--help` lists the global options.
- Search Console and GA4 syncs backfill every date of the history window
  that was never collected (a quota stop stays `partial` until then);
  `sync inspect` reports `nothing_inspected` (exit 2) when nothing was
  inspected.
- Demo and live data are separated at run time in both directions, and
  `doctor` reports a mix as `FAIL`. `init` refuses the file-system root, the
  home directory, the temporary directory, and (by real path) the
  repository.
- The container image ships the synthetic demo fixtures.

#### Fixed

- Measurement and reports: scoped Search Console aggregates; enforced metric
  grains and observation provenance; recorded configuration activations; one
  keyword row per query; an undetermined GA4 rate scale is never an OBSERVED
  percentage; users who triggered the primary event reported per period;
  page users never borrowed from another host; per-claim SYNTHETIC flags;
  owner conversion-verification caveat; unknown business time zone labeled;
  competitor changes are DATA UNAVAILABLE without a check; one dashboard
  builder.
- Routing and recommendations: configurable thresholds and rule order;
  `CONVERSIONS_NOT_ASSESSED`; a zero-impression INDEXING_UNKNOWN page gets
  the free URL Inspection as primary action; owner decisions recorded from
  approvals and the owner-decisions note; SYNTHETIC labels in `analyze`.
- Content: publication measurement and low-data detection scoped correctly;
  memory evidence re-verified before reuse; writer output that needs review
  stops for a human; real original value required by the brief gate; brand
  tokens stripped; `not_checked` checks (including non-English drafts)
  force human review; real freshness dates only; competitor headings never
  copied; volumes shown as estimates; no-overlap relevance deferred, never
  auto-rejected; evidence references on every finding.
- Experiments: page-level measured scope stated; windows never shorter than
  the minimum; frozen measurement configuration with drift flags; learnings
  need a measured result; full-body live verification with coverage.
- Research: output-schema and README drift detection for the Apify actor;
  competitor snapshot TTL; `research.approvedDomains` enforced; DNS failures
  recorded as `failed`, not unsafe; warning above five serious queries per
  run; the live DataForSEO queue needs a justification; the heuristic signal
  classifier is the default.
- Memory and LLM: honest embedding costs; full-text only by policy is not
  degraded; truncation surfaced; trigram full-text search for Chinese,
  Japanese, Korean, and Thai; strict embedding model identity.
- Redaction no longer garbles ordinary status prose; release check verifies
  fixture labels and the container fixtures; service-account token failures
  are diagnosed as `SA_TOKEN_REJECTED`.

#### Security

- `LLM_GATEWAY_BASE_URL` must be `https://` (plain `http://` only to a
  loopback proxy); `QDRANT_API_KEY` is never sent over plain HTTP to a
  non-loopback host.
- Generated vault notes are redacted (body, title, properties, file names,
  credential URL parameters); untrusted names can no longer create hidden
  files or abort a vault render.
- Personal identifiers are masked in model-bound data unless explicitly
  allowed with a stated reason (`docs/PRIVACY.md`).
- Every default-ignorable invisible character, including Unicode tag
  characters, is stripped from untrusted text.
- Site configuration YAML and setup value paths reject prototype keys.

## [0.1.0] - Unreleased

First version under development. Not yet released, tagged, or published;
release requires the owner's explicit approval (see `docs/RELEASING.md`).

### Added

- Public application / private workspace separation with `init`, configurable
  workspace paths, and never-overwrite initialization.
- Validated per-site configuration, Demo/Core/Full setup profiles, layered
  secret store, and forward-only checksummed SQLite migrations with verified
  pre-migration backups.
- Budget reservations and provider-request log with ambiguous-submission
  handling; unknown costs are recorded as unknown, never zero.
- Public-release security tooling:
  - `npm run security:scan`: secret scan of the working tree and full Git
    history (every commit, including empty and merge commits; shallow clones
    are reported as incomplete, never clean) that never prints values,
    validates its allowlist, and requires rotation of exposed credentials.
  - `npm run licenses:check`: dependency license check and generated
    `THIRD_PARTY_NOTICES.md`.
  - `npm run release:check`: read-only release readiness checklist (package
    and container allowlists, `.gitignore` protections, example config, secret
    scan, licenses, CI hardening).
  - `npm run cli -- diagnostics export|show|list`: redacted diagnostic bundle
    for bug reports (`--site` limits it to one site; identifiers of every site
    are masked), written locally and never uploaded.
  - Synthetic prompt-injection fixture library for tests.
- Community files: `CONTRIBUTING.md`, `SECURITY.md`, `SUPPORT.md`, issue and
  pull request templates, `CODEOWNERS`, Dependabot configuration, and
  least-privilege CI.
- Documentation: security model, data flows, privacy, costs, upgrading, and
  releasing.
- Optional container build (`Dockerfile`) that runs as a non-root user and
  expects the private workspace as a mounted volume.

### Security

- CI uses read-only permissions, no secrets, GitHub-hosted runners only, and
  installs dependencies with `--ignore-scripts`.

### License

- Released under the MIT License (`LICENSE`), Copyright (c) 2026 Fadel Drissi
  Toubbali. `package.json` declares `"license": "MIT"`; `private: true` is kept,
  so the package is not published to npm without a separate owner decision.
