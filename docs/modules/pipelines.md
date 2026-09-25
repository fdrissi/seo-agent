# Module: services, wiring, and pipelines

Source:

- `src/app/services.ts`: concrete service graph per site context, status aggregation.
- `src/app/wiring.ts`: central integration wiring, installed by `src/cli/main.ts#main()`.
- `src/workflows/pipelines/`: baseline, weekly, monthly, and content-queue stage lists and job handlers.
- `src/cli/commands/pipelines.ts`: `baseline`, `weekly`, `monthly`, `content queue`, `content produce`.
- Prompts: `prompts/reports.executive-summary.md`, `prompts/research.reddit-signals.md`.
- Tests: `tests/integration/pipelines/`; fixtures: `tests/fixtures/pipelines/` (synthetic).

Spec coverage: section 27 (baseline, weekly, monthly, content queue, durable
jobs), section 4 (stage contracts), sections 24/25 (modes, budgets), and the
integration hooks the slices left open.

## Services (`createServices(ctx, opts)`)

`createServices` builds the concrete implementation of every slice contract
for ONE context. Inside a workflow stage, build it from the stage context
(`sctx.app`): its budget service is the engine's per-stage guard, so every
paid call (LLM reservations, DataForSEO submissions) is checked against the
stage's cost allowance before the run/site/account budgets.

| Service | Implementation |
| --- | --- |
| `google.provider` | `createGoogleAuthProvider(ctx)`: OAuth or service account per `GOOGLE_AUTH_MODE`; the synthetic fixture provider only for the demo profile. A failure (for example `GOOGLE_AUTH_MODE=fixture` outside the demo) is recorded in `issues`, never thrown. |
| `llm` | LLM Gateway client (`createLlmClient(ctx, { approvals })`, so unknown-price approvals can be verified) when `LLM_GATEWAY_API_KEY` and at least one model are configured; the deterministic SYNTHETIC fixture client in the demo profile (handlers in `src/workflows/pipelines/synthetic-llm.ts`); otherwise `DisabledLlmClient`, whose calls return `{ ok: false, status: 'not_configured' \| 'disabled', reason, nextStep }`. |
| `approvals` | `ApprovalService` (SQLite). |
| `memory` | `createMemoryService(ctx, { llm: null })`: SQLite FTS always, Qdrant when enabled (it degrades to FTS when unreachable). It never spends on embeddings implicitly. `memoryWithEmbeddings()` adds the LLM client and is used only under an explicit allowance (baseline `optional_ai`). |
| `vault` | `createVaultWriter(ctx)` when `features.obsidian`. |
| `crawler` / `competitorCrawler` | Default: the crawler's SSRF-safe fetcher (system DNS, pinned transport). Demo: `fixtureSiteTransport` over `tests/fixtures/pipelines/site` with a synthetic resolver (the SSRF guard still runs; rows are `is_synthetic = 1`, `render_mode = 'fixture'`). |
| `dataforseo` | Client options plus the approval gate; the synthetic fixture transport in the demo profile. |
| `apify.client` | Created only when `features.apify`, `APIFY_TOKEN`, and network access exist. |
| `pageFetcher` / `targetChecker` | `createSsrfSafePageFetcher`: the crawler's `SafeFetcher` for the site's own pages (static URL checks, DNS answers classified, connection pinned, every redirect hop revalidated, off-site redirects refused). |

`collectStatuses(ctx, services, { network })` aggregates every slice's status
reporter: `googleStatus` (after validating `GOOGLE_AUTH_MODE` with
`resolveGoogleAuthMode`), `llmStatus`, `memoryStatus` (Qdrant),
`crawlerStatus` (crawler + Playwright), `performanceStatuses` (PageSpeed +
CrUX), `dataforseoStatus`, `apifyStatus`, and the vault status. `network:
false` makes no request; `network: true` allows only free, read-only checks.
A failing reporter becomes a `misconfigured` status instead of an exception.
`jobsStatus(ctx, registry)` reports registered handlers, job counts, jobs
needing attention, held locks, and schedules. Doctor implementations can use
both.

## Central wiring (`installWiring()`)

`src/cli/main.ts#main()` installs it once before any command runs (tests that
call `buildProgram()` directly keep injecting their own fakes, or call
`installWiring()` themselves). It registers:

- `registerMemoryLlmFactory`: the LLM client above for the memory commands
  (paid memory operations still need their explicit `--allow-paid`).
- `registerContentDepsFactory`: LLM client, FTS memory, approval gate, vault writer.
- `registerIntegrationStatusProvider`: offline `collectStatuses` for `vault render` and the dashboard.
- `registerSitePageFetcherFactory` (new hook in `src/approvals/page-fetch.ts`):
  approval target rechecks and live verification use the SSRF-safe fetcher.
- Job handlers: `baseline`, `weekly`, `monthly`, `content.queue`, plus the
  content slice's `content.research` / `content.production`, so `jobs resume`
  and `schedule run` can continue them.

## Pipelines

Every stage is a full `StageDefinition` (zod input/output, prerequisites,
evidence requirement, timeout, retry, cost allowance, stopping conditions,
next states) and runs through `runSequential` inside a durable job
(`workflowJobHandler`): per-site lock (the content queue uses its own
`content` lock), a checkpoint per stage, resume from the last successful
stage, cooperative cancellation, circuit breakers for the declared providers
(`google`, `crawler`, `pagespeed`, `dataforseo`, `apify`, `llm_gateway`).

Degradation rules:

- Optional stages THROW when they cannot do their work (missing credentials,
  provider down, disabled integration). The engine records them as degraded,
  the job result says `succeeded (degraded: ...)`, and the report lists them.
- Partial work is returned with a `note` (`degraded`/`skipped`, code, detail,
  next step).
- The `report` stage collects both: engine checkpoints of this job (skipped,
  failed) and stage notes. They go into `ReportBuildInput.pipeline`, which the
  report turns into data-quality items (and blockers in the baseline) with an
  actionable next step. A missing provider never corrupts the report.
- A stage declares a cost allowance only when its paid call can actually
  happen in this run. Required stages whose paid work is optional
  (`route_and_score` with the intent hook, the content queue's `classify` /
  `cluster`, the baseline `report` summary) are marked `paidWorkOptional`:
  when the budget is exhausted (or the circuit breaker of the provider only
  that paid work needs is open), the engine runs them WITHOUT an allowance
  (every reservation is refused), lists them as degraded (`BUDGET_EXCEEDED` /
  `INTEGRATION_UNAVAILABLE`), and they record a note; an exhausted or $0 LLM
  budget never stops a pipeline blocked. `effectiveAllowance` narrows a
  declared allowance to what the validated input needs (the baseline report
  needs its LLM allowance only when `optional_ai` approved the summary).
  Stages check `stageMayPay(ctx, provider)` before a paid call.

### Baseline (`baseline`)

`acquire_lock -> check_access -> sync_gsc (initial history, default 90 days) ->
plan_period -> sync_ga4 (initial history + the exact baseline period at period
grain) -> crawl_site -> performance (priority pages only) -> reconcile_urls ->
inspect_urls (priority URLs, capped) -> check_measurement -> index_memory (FTS;
no paid call) -> cost_plan -> optional_ai -> report`.

- No DataForSEO or Apify stage exists in the baseline; it starts no
  experiments and publishes nothing.
- `cost_plan` shows a PROPOSED COST PLAN for optional LLM/embedding work
  (pending embeddings from the memory plan, one optional model-generated
  executive summary priced with `planLlmCost` from the cached catalog). It is
  approved only when the owner passes `--approve-cost-plan <usd>` with a cap
  covering the displayed upper bound, the bound is below the LLM per-run
  budget, it fits what is LEFT of the LLM budgets (this run, the month, the
  combined monthly ceiling that DataForSEO and Apify spend also count against,
  and the shared account cap; `remainingBudgetProblem`), and every price is
  verified. Unknown prices, and limits made unverifiable by an outstanding
  charge without an upper bound, are never approved (and never counted as $0).
  Dry runs never execute it.
- `optional_ai` declares an LLM allowance equal to the approved cap (never
  above the per-run budget). The `report` uses that allowance only when
  `optional_ai` approved the summary in this run; an exhausted LLM budget
  skips the summary and the report stays deterministic (never blocked).
- `check_measurement` checks the latest 28 complete days (current
  measurement health). The baseline report period (`initialHistoryDays`
  ending at the latest complete date) can start a few days before the first
  date the initial Search Console sync collects (that window ends yesterday
  in Pacific time); the report shows those dates as not collected.
- `inspect_urls` with `features.urlInspection` off (or a per-run cap of 0)
  records a skipped `INTEGRATION_DISABLED` note with the next step, never a
  silent success. When URL Inspection ran but inspected nothing
  (`nothing_inspected`), the stage records a degraded `NOTHING_INSPECTED`
  note (`nothingInspectedNote`) whose next step depends on why every URL was
  skipped: no priority URL selected, dry run, URLs outside the configured
  Search Console property, the daily quota, or the per-run cap. It is never
  reported as a success.
- `report` (every pipeline) passes the run's status note to the dashboard:
  when `check_access` made no network checks (offline or demo runs), the
  dashboard's integration table carries "Offline checks only during this run
  (configuration and stored credentials)." (`offlineStatusNote`); a run with
  network checks makes no such claim.

### Weekly (`weekly`)

`acquire_lock -> check_access -> resume_pending (free polling of DataForSEO
tasks and Apify runs) -> sync_gsc -> plan_period -> sync_ga4 (exact report
period and comparison period) -> crawl_site -> performance -> validate_joins ->
review_experiments (evaluate due experiments) -> reconcile_urls ->
route_and_score (+ cheap-model intent hook when configured) -> research ->
compare -> index_memory -> retrieve_memory -> recommend -> site_structure ->
report -> reconcile_costs`.

- The report period (`plan_period`) drives the other windows. `validate_joins`
  checks exactly the report period. `route_and_score` routes over 28 days
  ending at the report period end (never after the latest date complete in
  Search Console and GA4). For an explicit historical period (`weekly --from
  D --to D` ending before the latest complete date) routing covers that
  window, but route decisions and the recommendation are NOT saved and no
  earlier proposal is superseded: a past period never replaces the current
  recommendation. The `route_and_score` and `recommend` notes
  (`HISTORICAL_PERIOD`) say so in the report. The recommendation assembled for
  that period is shown for review only: the CLI summary prints "(not saved:
  explicit historical period; review only)" ("(not saved: dry run)" only for a
  dry run), and the report's prioritized action is a `review_only` claim that
  names it (not a generic "Wait"), unless a recommendation recorded for that
  period at the time exists, which is then shown with a note.
- `sync_gsc` also fetches country/device segment rows (page totals only,
  `syncGsc` `segments`) bounded to the report period, when `market.countries`
  or `market.devices` is set, so the report shows country/device context.
  Dates whose final segment rows are already stored are not requested again,
  and periods starting more than 93 days back are left to an explicit `sync
  gsc --segments country,device --days N`. A segment failure degrades only
  that context (`SEGMENTS_UNAVAILABLE`), never the sync.
- `route_and_score` attaches the cheap-model intent hook only when a cheap
  model is configured, outside dry runs, with a positive 10% share of
  `budgets.llmGateway.perRun`, and when the LLM budget is not already
  exhausted (`intentHookPlan`). Otherwise it declares no allowance, routes by
  rules only, and records a `BUDGET_EXCEEDED` note when a configured model
  could not be used. A budget exhausted after the stages were built (resume)
  is handled by the engine (`paidWorkOptional`).
- `research` requires RESEARCH mode (`--mode RESEARCH`); lower modes skip it
  with `MODE_NOT_PERMITTED`. Its evidence check requires shortlisted
  opportunities with Search Console query evidence. Page-level candidates
  get the top 3 queries of their page from `gsc_page_query_daily` of ONE
  Search Console slice (`researchCandidatePlan`): the configured property and
  its primary search type (`configuredGscScope`); without a configured
  property, the only property with data (`resolveGscProperty`); when several
  properties have data the fallback is skipped and the reason is recorded in
  the research warnings and note, so rows of different properties or search
  types are never summed. It calls
  `researchShortlist` (local filtering, `research.seriousQueriesPerRun`, cache
  and open tasks first, budget reservation per request, `allowPaid` only
  inside this budgeted stage) and crawls the relevant competitor pages. Its
  allowance is the DataForSEO per-run budget. An exhausted budget stops it
  before any request (`BUDGET_EXCEEDED`); the report is still produced. Pages
  blocked by robots.txt, logins, or access denials are recorded as blocked
  and never bypassed. Sandbox/fixture competitor URLs are not crawled for a
  real site.
- `compare` (spec section 19, deep analysis) compares our page with the
  competitors of ONE researched query in the localized SERP (configured
  location, language, device) for up to 3 researched candidates with usable
  competitor pages. Each comparison is stored in `competitive_comparisons`
  and attached to the primary recommendation. The optional model synthesis
  runs only with a configured, non-fixture reasoning model, outside dry
  runs, within 10% of `budgets.llmGateway.perRun`; otherwise the stage records
  "synthesis skipped: <reason>" and the deterministic comparison is still
  complete. In ANALYZE mode there is no research, so there is no comparison.
- `index_memory` ingests new, changed, and deleted records into the
  full-text index before `retrieve_memory`, without any paid call. When
  `features.qdrant` or `features.embeddings` is off in the site config (e.g.
  the Core profile) memory is full-text only by policy: the stage records an
  informational note (`MEMORY_FTS_ONLY_POLICY`, status succeeded, never in
  the degraded list) whose next step names the flags. It is degraded
  (`MEMORY_FTS_ONLY`) only when an enabled path fails or is not configured
  (no embedding model or client, Qdrant down, offline), with the hint that
  vectors need an explicit paid embedding run.
- `recommend` (SEO slice) returns one primary action or an explicit
  no-action / repair-measurement / collect-more-evidence decision plus at most
  three secondary observations, after consulting previous experiments,
  decisions, rejected proposals, and learnings. Its memory query is built
  from this run's candidates (`priorMemoryQuery`), and the primary item
  records what was consulted in `details.priorContext` (see
  [seo-router.md](seo-router.md#recommendations-srcseorecommendts)).
- `site_structure` (optional, free, read-only; `src/workflows/pipelines/site-structure.ts`)
  builds the report's site-structure summary from stored crawl results:
  internal-link suggestions for up to 10 destinations (this run's candidate
  pages with optimization or discovery routes, best score first; without
  candidates, the top Search Console pages of the configured property and
  search type), potential orphans relative to the latest own-site crawl, and
  page-level heuristic AEO checks (up to 50 pages). Without a crawl it
  records a degraded `CRAWL_MISSING` note; after a partial crawl orphan
  status is "not assessable" outside the known coverage (`CRAWL_PARTIAL`),
  both with a next step. The `report` stage passes the validated output as
  `ReportBuildInput.siteStructure`, so the weekly report shows internal
  links and the AEO section from it. Missing data is DATA UNAVAILABLE, never
  0; synthetic crawls are flagged.
- `reconcile_costs` polls pending tasks/runs again (free), lists unresolved
  reservations, and reports spend with actual, reserved, estimated, and
  unknown kept separate. Each `spend` entry carries the cost basis of
  `BudgetService.report` (`reportedMicros`, `computedMicros`,
  `computedCount`, `syntheticMicros`, `syntheticCount`; absent in older
  checkpoints) and the output says whether the spend is a demo's
  (`spendDemo`). The CLI summary and the vault system log print "$R
  provider-reported, $C computed from usage, $X reserved, $E estimated-only"
  per provider (never "actual"), with `[SYNTHETIC: no real charges]` on a
  demo line or on a provider whose amounts include fixture/sandbox
  reservations (`spendSummaryText`).

### Monthly (`monthly`)

`acquire_lock -> check_access -> resume_pending -> sync_gsc (+ country/device
segment rows for the month, as in the weekly) -> plan_period (calendar month)
-> sync_ga4 (month + previous month at period grain) -> validate_joins (the
reviewed month) -> review_experiments -> content_cohorts -> competitor_changes
(RESEARCH mode; re-check tracked competitor pages) -> ai_visibility (grounded
observations recorded with `ai-citations import`; disabled by default) ->
index_memory (free) -> report -> reconcile_costs`. Without a competitor check
in the period, the report shows competitor changes as DATA UNAVAILABLE, never
as "no changes".

`ai_visibility` builds its note from `aiCitationStatus` (`src/aeo/status.ts`):
disabled, it says AI visibility is DATA_UNAVAILABLE (not zero) and how to
enable the feature and record observations with `ai-citations import`;
enabled without observations in the month, it says the same; with only
ungrounded observations it says they are excluded. There is no API
collector, so nothing is spent. Its output `checksInPeriod` is null when
monitoring is disabled or the report period is unknown (not measured, never
0); with a known period it counts the recorded observations.

The monthly report keeps observed results apart from attribution
assumptions (its own section) and includes cohorts, competitor changes, API
usage, data quality, and proposed learnings.

### Content queue (`content.queue`)

`queue_gate (features.contentDiscovery; otherwise no_action) -> index_memory
(free) -> apify_signals
(resume pending runs; no new paid run) -> discover -> dedupe -> classify ->
cluster -> validate_demand -> check_existing -> prioritize -> queue_notes`.

The research stages declare an LLM allowance only where a paid call can
happen in this run (`contentQueueModelPlan`, `contentQueueAllowances`):
`discover` never (full-text memory), `classify` only with `--use-model`, a
configured cheap model, and a positive share of `budgets.llmGateway.perRun`,
`cluster` only with `--semantic`, `features.embeddings`, a configured
embedding model, and a positive share. With an allowance they are
`paidWorkOptional`: an exhausted LLM budget runs them by rules / lexical
clustering only (degraded), never blocking the queue. Requested model use
that cannot happen (a $0 share: `BUDGET_EXCEEDED`; no model:
`CONFIG_MISSING`; a feature flag off: `INTEGRATION_DISABLED`; a dry run:
`DRY_RUN`) is decided when the stages are built, as the weekly
`intentHookPlan` does, and stated in the stage's model status ("skipped:
<CODE>: <detail>"); the job counts it as degraded (a dry run as skipped), so
the headline, `degradedStages`, and the stage table show it.

It never drafts or publishes. `content produce <item-id>` runs the content
slice's production workflow (brief -> draft -> quality review) as a durable,
checkpointed job with per-stage LLM allowances; drafting still needs `--mode
DRAFT` and a human draft approval bound to the brief hash, and the job waits
(`needs_review`) until then.

## CLI

```
npm run cli -- baseline [--approve-cost-plan <usd>] [--crawl-max-pages N] [--from D --to D] [--resume <jobId>] [--rerun-paid-stages]
npm run cli -- weekly  [--from D --to D] [--research-max-queries N] [--research-wait <s>] [--resume <jobId>] [--rerun-paid-stages]
npm run cli -- monthly [--from D --to D] [--resume <jobId>]
npm run cli -- content queue [--gsc-days N] [--max-queries N] [--use-model] [--semantic] [--resume <jobId>]
npm run cli -- content produce <item-id> [--use-model] | --resume <jobId>
```

Global flags: `--mode` (weekly research needs RESEARCH), `--json`, `--dry-run`.

- With `--mode RESEARCH` (or higher), `baseline`, `weekly`, and `monthly`
  print the per-run caps and the remaining DataForSEO, Apify, LLM, and
  combined budgets to stderr before the run starts (`researchCapLines`).
- The summary lists every stage status. A run with skipped, degraded, or
  offline stages is shown as `succeeded (degraded: ...)`, never as a bare
  `succeeded`.
- While a job holds the site lock, manual data-changing commands refuse with
  `LOCKED`, and while such a manual command runs it holds the same lease, so
  a pipeline does not start meanwhile (see [CLI.md](../CLI.md)); the content
  queue and `content produce` use their own `content` lock.

- `--dry-run` executes the workflow against a temporary copy of the database
  (`VACUUM INTO` a scratch file that is deleted afterwards). Paid stages are
  skipped by the engine, report/vault writers run in dry-run mode, status
  checks make no request, and nothing is written to the workspace database.
  Stages that ran but requested and wrote nothing say so in their output
  note, never a bare `succeeded`: `sync_gsc` and `sync_ga4` are skipped with
  `DRY_RUN` (`syncDryRunNote`: "Dry run: nothing was requested or written."
  plus the offline credential check; credentials that cannot be verified
  offline, such as Application Default Credentials from a metadata server,
  are stated as unverified with `auth diagnose` as the next step),
  and `crawl_site` with `CRAWL_DRY_RUN`, like the `performance` stage's
  dry-run checks (`DRY_RUN`). The stage table, the headline,
  `degradedStages`, `jobs show`, and the report's stage statuses count them
  alike. Missing credentials still fail the sync
  stages with `CREDENTIALS_MISSING`, as in a real run.
- `--resume <jobId>` continues a job of the same type from its last successful
  checkpoint (completed stages are reused, not redone). A job of another type
  is refused without changes. `jobs resume <id>` works for every pipeline
  type once the wiring is installed.
- `--resume <jobId>` with `--dry-run` is refused with `VALIDATION_FAILED`
  before anything runs or any spending cap is printed
  (`assertNoDryRunResume`): resuming continues a REAL job, which must never
  run against the throwaway database copy of a dry run (its charges,
  reports, and lock would be lost with the copy). As a second guard, the
  runner builds the handler context with `dryRun = ctx.dryRun || job.dryRun`.
  The summary's dry-run note follows the effective dry run; a run on a
  scratch database that was not a dry run prints a WARNING instead of
  claiming that nothing was written.
- A new foreground run that finds the site lock held (a job, or a manual
  command that holds the lease) is closed as `cancelled` with code `LOCKED`,
  so nothing is left queued for a later scheduler tick; run the command
  again when the lock is free. When the job holding the lock appears
  interrupted (for example a `weekly` killed mid-run: its process on this
  host is gone), the next step is not to wait: resume it with
  `npm run cli -- --mode <job mode> jobs resume <id>` (`--mode` only above
  ANALYZE; a RESEARCH job is otherwise refused as not runnable) or cancel it
  with `jobs cancel <id>`.
- The headline, `--json` (`degradedStages`), `jobs list`, and `jobs show`
  count the same degraded stages: the engine's degraded list plus stages
  whose own note says skipped, degraded, or offline, plus content-research
  stages whose requested model use was skipped (`classify` `modelStatus` /
  `cluster` `semanticStatus` starting with "skipped:", other than "skipped:
  model disabled for this run", which means it was not requested;
  `requestedModelSkippedNote`). A stage the engine ran without its optional
  paid work (budget exhausted at run time) is `degraded` in `degradedStages`
  and in the stage table, never a bare "succeeded".
- Exit code 1 when the job failed, was interrupted, or is locked; 0 for
  succeeded (degraded runs say so) and for jobs waiting on a human review.

## Cross-slice changes (minimal, backward compatible)

- `src/integrations/google/ga4-sync.ts`: new `periods` option (explicit
  `{start, end}` periods fetched at period grain in addition to
  `periodWindows`), validated, deduplicated, listed in the dry-run plan. The
  weekly and monthly pipelines request exactly the report period and its
  comparison period, so period-level users are available for the report.
- `src/approvals/page-fetch.ts`: `registerSitePageFetcherFactory` hook;
  `sitePageFetcherFromContext` uses the registered SSRF-safe fetcher.
- `src/reports/env.ts` / `build.ts`: optional `ReportBuildInput.pipeline`
  (stage outcomes -> data-quality items).
- `src/cli/main.ts`: `main()` installs the wiring.

## Tests (`tests/integration/pipelines/`)

All offline, all synthetic (`example.com` / `*.example` reserved domains).

- `baseline.test.ts`: end to end over the fixture Google provider, fixture
  site crawl, fixture LLM; no paid research, no experiments, no publications;
  report, vault note, and dashboard written; cost plan shown, not run. Missing
  credentials (core profile): Google stages degrade with `CREDENTIALS_MISSING`,
  the report lists the blockers, nothing is ingested.
- `budget-period.test.ts`: an exhausted LLM budget never blocks the weekly
  (rule-only routing with a note, both when decided at build time and by the
  engine at run time), the content queue (`--use-model`: classify by rules,
  shown degraded in the stage table; with a $0 per-run LLM budget classify
  says `BUDGET_EXCEEDED` and the job is degraded), or the baseline (approved
  plan: summary skipped, report produced);
  `cost_plan` refuses a plan that does not fit the remaining month or the
  combined ceiling; a historical `weekly --from/--to` routes over its window
  and saves or supersedes nothing, and the CLI summary and the report's
  prioritized action say "review only", never "dry run" or "Wait"; the weekly and monthly join checks cover
  the report period; the weekly report shows country/device context;
  `inspect_urls` off is a skipped `INTEGRATION_DISABLED` note; next steps for
  `OFFLINE` and `INTEGRATION_UNAVAILABLE`.
- `weekly.test.ts`: RESEARCH-mode run with research, blocked competitor pages
  (robots, 403) recorded honestly; ANALYZE mode skips research with an
  actionable status; budget exhaustion stops research before any request and
  still produces the report; a simulated crash in `retrieve_memory` resumes
  from checkpoints without redoing completed stages (no new provider calls,
  paid submissions, reservations, ingestion batches, crawls, or competitor
  requests); missing credentials; the Core profile (weekly and baseline) has
  no `MEMORY_FTS_ONLY` degraded entry; spend in the stage output, CLI
  summary, and vault system log keeps provider-reported and computed amounts
  apart and tags synthetic ones; research candidates read one property and
  search type (two search types, two properties, no configured property).
- `pipelines-more.test.ts`: workflow definitions validate; default registry;
  monthly (`ai_visibility` `checksInPeriod` null when disabled or the period
  is unknown); content queue (disabled -> no_action; never drafts); cost plan
  approval (fixture summary generated) and refusal of unknown prices; dry run
  on a scratch database; CLI (`baseline --json`, `weekly`, resume guards,
  `content queue`, `content produce` waiting for approval).
- `inspect-and-dashboard.test.ts`: `nothingInspectedNote` next steps by skip
  reason, the degraded `inspect_urls` note in a dry run and in a baseline
  report, and the offline caveat on the dashboard only when the run made no
  network checks.
- `site-structure-report.test.ts`: the weekly `site_structure` stage runs
  after `recommend` and its output reaches the report builder
  (`siteStructure`) and the rendered weekly Markdown; the baseline passes
  none.
- `services.test.ts`: services never throw for missing integrations; disabled
  LLM client; gateway selection; demo services; invalid `GOOGLE_AUTH_MODE`;
  offline `collectStatuses`; `jobsStatus`; wiring registrations; SSRF-safe
  fetcher (refused hosts, private DNS answers, off-site redirects, 404
  mapping); `syncGa4` explicit periods.

## Limitations and open items

- Nothing here was run against live providers. Live behavior depends on the
  slices' adapters (see their module docs).
- The synthetic DataForSEO SERP fixture carries a fixed 2026-01-01 datetime,
  so fixture cache entries are already expired and a second demo week
  resubmits synthetic tasks (free, flagged). Live SERPs use their real time.
- `content brief`, `content draft`, `content review`, and `content batch`
  now run as durable content jobs, like `content produce`; only their
  `--dry-run` previews run in-process.
- The weekly `site_structure` stage reads the latest completed or partial
  own-site crawl (`crawl_site` is only an optional prerequisite). When this
  run's crawl was skipped or failed, it uses an earlier crawl; the report
  names the crawl id each claim is relative to.
- The acquire_lock check is verified on the first run of a job; on resume its
  checkpoint is reused (the runner re-acquires the lock for every run).
- The weekly routing intent hook makes the route stage a paid stage when a
  cheap model is configured and the LLM budget is available: an interruption
  during that stage requires `--rerun-paid-stages` after reconciliation. A
  stage that runs without any allowance (budget exhausted, allowance narrowed
  to none) writes no in-flight marker and never needs it.
- The historical-period recommendation is identified by the recommend
  stage's note text (`HISTORICAL_PERIOD`) when the report is built; a report
  rebuilt later from the database alone (no pipeline stage outcomes) cannot
  know it and shows the generic prioritized action.
