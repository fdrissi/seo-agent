# DataForSEO adapter

Code: `src/integrations/dataforseo/`. CLI: `src/cli/commands/research.ts`.
Tests: `tests/unit/dataforseo/`, `tests/integration/dataforseo/`, fixtures in
`tests/fixtures/dataforseo/`.
Contract: `docs/integration-contracts.md` section 6 (source IDs DF1-DF42,
retrieved 2026-09-24).

**Status: implemented and tested offline. Awaiting credentials.** No live
DataForSEO request has been made. All tests use a fake transport with
synthetic fixtures. No real response, price, or ranking has been observed
through this code.

## What it does

The adapter handles selective external search research, as spec section 14
describes:

```
GSC shortlist -> local filtering -> at most research.seriousQueriesPerRun serious queries
  -> targeted Google organic SERP research -> top crawl.competitorPagesPerQuery competitor pages
```

It also provides optional Google Ads search-volume estimates. Three endpoint
families are disabled by default: Backlinks, DataForSEO Labs, and AI
visibility.

| Export | Purpose |
| --- | --- |
| `createDataForSeoClient(ctx, opts)` | Creates the client: HTTP Basic auth, live or sandbox host, endpoint allowlist, and free GETs with bounded retries |
| `researchShortlist(ctx, candidates, opts)` | The default process above. Returns selected and filtered queries, per-query outcomes, competitor URLs, a cost plan, and blockers |
| `researchSerps(ctx, queries, opts)` | Targeted SERP research for explicit queries: cache, then an open task, then a budgeted submission |
| `researchKeywordVolumes(ctx, keywords, opts)` | Search-volume estimates. Labeled as estimates. A missing volume stays missing |
| `pollPendingTasks(ctx, opts)` | Resumes queued or ambiguous tasks using free GETs only. It never resubmits |
| `dataforseoStatus(ctx, { network })` | Reports status honestly. The network check calls only the free `appendix/user_data` endpoint (DF15) |
| `callGatedEndpoint(ctx, client, input)` | Calls Backlinks, Labs, or LLM-mentions endpoints. Needs the feature flag and an approval |
| `latestSerpSnapshot`, `serpResultsForRecommendation`, `competitorUrlsForQuery`, `latestOwnRank`, `keywordVolumeEstimates`, `assertUsableForRecommendations` | Read helpers for other modules. They exclude sandbox and fixture data |
| `createSyntheticDataForSeoFetch(opts)` | Synthetic fixture transport for the offline demo (client mode `fixture`) |
| `listTasks`, `abandonAmbiguousTask`, `waitForTasks` | Task inspection and owner actions |

Dependencies are injected as parameters: `ApprovalGate` via `opts.approvals`,
and `fetch` or a pre-built client via options. The integration phase wires
them to the concrete implementations.

## Verified contract usage

The hosts are `https://api.dataforseo.com/v3` (live) and
`https://sandbox.dataforseo.com/v3` (sandbox), per DF2 and DF14. The sandbox
also requires Basic auth (DF42). Every request carries
`Authorization: Basic base64(login:password)` (DF1). Credentials never appear
in URLs or request bodies.

Allowlist (`endpoints.ts`). Any other path is refused with `POLICY_DENIED`:

| Endpoint | Paid | Source |
| --- | --- | --- |
| POST `serp/google/organic/task_post` (at most 100 tasks) | yes, $0.0006 per 10-result page | DF4, DF30 |
| GET `serp/google/organic/tasks_ready` (20/min, enforced in-process) | free | DF5 |
| GET `serp/google/organic/task_get/advanced/{id}` and `/regular/{id}` | free | DF6, DF7 |
| POST `serp/google/organic/live/advanced` (1 task; used only when `research.dataforseo.queue: live`) | yes, $0.002 per page | DF9, DF30 |
| GET `serp/google/locations[/{country}]`, `serp/google/languages` | free | DF11, DF12 |
| POST `keywords_data/google_ads/search_volume/task_post` | yes, $0.06 per task (up to 1000 keywords) | DF17, DF31 |
| GET `keywords_data/google_ads/search_volume/tasks_ready`, `task_get/{id}` | free | DF19, DF20 |
| POST `keywords_data/google_ads/search_volume/live` (12/min, enforced in-process) | yes, $0.09 per task | DF18, DF31 |
| GET `keywords_data/google_ads/locations[/{country}]`, `languages` | free | DF21, DF22 |
| GET `appendix/user_data` | free | DF15 |
| POST `backlinks/summary/live` (gated) | yes, $0.024 per request + $0.000036 per row | DF28, DF32 |
| POST `dataforseo_labs/google/ranked_keywords/live` (gated) | yes, $0.012 per task + $0.00012 per item | DF29, DF33 |
| POST `ai_optimization/llm_mentions/search_mentions/live` (gated) | price UNVERIFIED | DF27, DF34 |

The `backlinks/`, `dataforseo_labs/`, `ai_optimization/`, `serp/google/ai_mode/`
and `serp/ai_summary` prefixes return `INTEGRATION_DISABLED` unless their flag
(`dataforseoBacklinks`, `dataforseoLabsExports` or `dataforseoAiVisibility`)
is on. Every profile keeps these flags off. With a flag on, a call also needs
an `ApprovalGate` approval bound to the exact endpoint, request body (including
the row `limit`), row bound, price bound and mode. If the approval is missing,
the adapter creates a pending approval request and sends nothing.

An approval is consumed **once, before the request is sent**: after the budget
reservation and before the POST. Two concurrent calls holding the same
approval therefore cannot both send. If `consume` fails (already used,
expired), nothing is sent, the reservation is released, and
`APPROVAL_INVALID` is raised with the audit event
`dataforseo.approval_consume_failed`. If the request then provably was not
sent (connection refused) or was rejected without a charge, the audit event
`dataforseo.approval_consumed_without_execution` records it and the error
hint says so. The next run creates a new approval request for the same
request, which the owner can approve again.

**Row bounds.** Backlinks, Labs and LLM mentions are priced per request plus
per row. The estimate is the request price plus the row price × `maxRows`
(a positive integer). The provider has to enforce the same bound:

- `dataforseo_labs/google/ranked_keywords/live` and
  `ai_optimization/llm_mentions/search_mentions/live` bound rows with the task's
  `limit` field. When the caller omits it, the adapter adds `limit = maxRows`
  before hashing and approval, so the approved body is exactly what is sent.
  An explicit `limit` must be an integer from 1 to `maxRows`.
- `backlinks/summary/live` returns one summary item per target, so no `limit`
  is sent. The estimate still assumes up to `maxRows` rows, which is
  conservative.

### Errors inside HTTP 200 (DF13)

The adapter checks for errors in three places:

- **HTTP status.** 401, 402 and 404 mean the request was not accepted, so the
  reservation is released or reconciled. For any other non-200 status on a
  POST, the outcome is **ambiguous**.
- **Response-level `status_code`.** Anything other than 20000 fails the
  request. A 5xxxx code on a POST is treated as ambiguous.
- **Task-level `status_code`.**
  - 20100, 40601 and 40602 mean queued or pending.
  - 20000 means ready.
  - 40102 means no results. This is stored as an empty observation, not a failure.
  - 40106 means partial results. The data is kept and flagged.
  - 40403 means the results expired.
  - Any other code is a failure. Codes are mapped to typed `AppError` codes in `envelope.ts`.

**Free GETs check the task level too.** Location/language lookups,
`tasks_ready` and `user_data` require at least one task, and every task must
be 20000. A task-level error inside HTTP 200 raises `DataForSeoApiError`
(level `task`). It is never read as an empty result, never cached, and never
reported as a successful status check. A lookup that returns an empty list
is not cached either. Research then continues with the location marked
`unverified`, so paid submissions are skipped (`DATA_UNAVAILABLE`), and the
next run looks the codes up again. `user_data` task errors map to
`permission_denied` (40100, 40104, 40201, 40204, 40207), `degraded` (40200,
40210, 40203), `unreachable` (5xxxx, 40202, 40209) or `misconfigured` (any
other code). They never map to `ready`.

**`--offline` is not a configuration problem.** In an offline run (outside the
demo) with DataForSEO otherwise usable, `dataforseoStatus` reports `disabled`
("network access disabled (--offline)", doctor INFO) with the next step "Run
without --offline", not `misconfigured`; nothing is sent and the credentials
are not judged. The offline blocker of `inspectDataForSeoSetup` is tagged
`offline: true`. Real configuration problems (feature off, mode `disabled`,
missing credentials) are still reported first. The dashboard written by an
offline `vault render` shows the same status.

Free GETs are retried with backoff on rate-limit (40202, 40209) and server
(5xxxx) errors, at the response level and at the task level. Paid POSTs are
**never** retried.

**Transient `task_get` errors never cost a second POST.** A task that is
already paid can fail on `task_get` with a transient task-level code: 5xxxx
server errors, 40202 or 40209 rate limits, an account-level error, or an
undocumented code. It stays `queued` or `ready`, the error goes into
`PollSummary.errors`, and the next poll fetches it for free. Standard results
can be fetched for 30 days (DF6, DF7, DF38). Only these codes mark a task
`failed` and let the same parameters be researched again:

- 40101 and 40103 (task failed, resubmit)
- 40000, 40006, 405xx and 40402 (invalid request)
- 40105 and 40400 (deleted or not found)
- 40401 (task not found) after 3 days
- 40403 (results expired), which marks the task `expired`
- a transient error that persists past the 30-day window

## Task lifecycle (standard queue preferred)

1. **Cache.** Look for a valid `research_cache` entry first. Then look for an
   **open task** with the same parameter hash (`submitting`, `queued`, `ready`
   or `ambiguous`) and reuse it. Nothing is ever submitted twice.
2. **Estimate.** Compute a conservative upper bound (see Costs).
3. **Reserve.** Call `ctx.budgets.reserve` against the run, weekly, monthly,
   combined and account caps, with provider `dataforseo`. An approved unknown
   price reserves its provisional hold (see Costs). Sandbox and fixture calls
   are free, but they still take the budget path: a verified-$0 reservation
   (price basis `fixed_zero`) before the request, reconciled at an actual $0
   and flagged synthetic (the provider request is `is_synthetic = 1`,
   `is_paid = 0`). This $0 is a **fixed zero**, not an amount computed from
   usage at list price: `costs`, the report and the dashboard count it apart
   ("Fixed zero, not computed"; `fixedZeroCount` in `costs --json`), and
   `data export costs` gives it `amount_basis` `fixed_zero`. (The stored
   reconcile source stays `computed_from_usage` because the migration 0310
   `cost_basis` CHECK has no separate value; the ledger usage carries
   `priceBasis: "fixed_zero"`.) Synthetic reservations never count against
   a shared account cap (`budgets.accountMonthlyUsd`); they still count
   toward the per-site limits. A sample cost in a sandbox response is kept for audit
   only; an ambiguous sandbox submission is still $0, a rejected one
   releases its reservation, and a sandbox request is refused like any other
   while a limit is already overspent. If a gated or unknown-price request
   has an approval, it is consumed at this point, after the reservation and
   before anything is sent.
4. **Record before sending.** `ctx.requests.prepare` writes the
   `provider_requests` row. Then `dataforseo_tasks` rows are inserted with
   status **`submitting`**. Both happen **before** the POST. The local task id
   is sent as the provider `tag` on `task_post`. Live endpoints do not document
   `tag`, so it is never sent there.
5. **POST once.** Then persist the result immediately:
   - Store each remote task id and its task-level cost, matched by `data.tag`
     or by position.
   - Set the status to `queued`. For live endpoints, set it to `ready` and
     store the result at once, because live results cannot be fetched again
     (DF38).
6. **Reconcile.** Call `ctx.budgets.reconcile` with the **sum of task-level
   costs**. The response-level `cost` is stored in the usage JSON for audit
   only and is never added (see Costs).
7. **Poll.** `pollPendingTasks` calls `tasks_ready` once per endpoint family,
   then `task_get` for tasks that are ready. It falls back to a direct
   `task_get` after 10 minutes. Results go into `serp_snapshots` or
   `keyword_metrics`.

### Ambiguous submissions

A timeout, a network error after sending, HTTP 5xx, an unparseable body, or a
task missing from the response marks the tasks **`ambiguous`**. When that
happens:

- The provider request becomes `ambiguous` and the reservation becomes
  `unresolved`, still counted at its estimate.
- The tasks are never resubmitted. Later runs reuse them.
- `pollPendingTasks` tries to reconcile them by matching the tag in
  `tasks_ready`. If a task is found, it is fetched normally. Its charge stays
  unresolved, because `task_get` does not report the posting charge and the
  adapter never assumes $0.
- `tasks_ready` only lists tasks from the last 3 days. After 4 days a note
  says so.
- The owner can run `research tasks --abandon <id>` after checking the
  DataForSEO dashboard. This unblocks research for those parameters. The
  reservation stays unresolved until the owner settles it from the
  dashboard's billing history with
  `costs reconcile <reservation-id> --actual-usd <amount> --evidence "..." --by "<name>"`
  (or `--not-charged`), which is audited.

A `submitting` row older than 15 minutes (a crash during the POST) becomes
ambiguous.

A local **wait** timeout is different from a POST timeout. With `--wait` or
`waitMs`, the adapter only polls. When the wait ends, the tasks stay `queued`
and the next run resumes them.

## Costs

The adapter looks up each price key in this order:

1. `research.dataforseo.pricingOverrides["<key>"]`, which is owner-verified.
   The basis is `verified_config`.
2. The documented price in `pricing.ts`: DF30-DF33, verified 2026-09-24,
   basis `documented`. This price is used only while it is at most
   **90 days** old (`DOCUMENTED_PRICE_MAX_AGE_DAYS`). After that it counts as
   unknown, so stale pricing is never carried forward.
3. If neither exists, the price is **unknown**. The request is skipped with
   `BUDGET_UNKNOWN_PRICE`. It can run only when an `ApprovalGate` approval
   exists for the exact request. That approval id is passed to
   `budgets.reserve`.

An approved unknown price is still **held at a conservative provisional
bound, never $0**. The estimate keeps `upperBoundMicros: null`, and
`provisionalMicros` sets the hold. It is one of:

- the last documented price, when the price is stale, × pages (× 5 with
  search operators) or × tasks
- the unverified DF34 static figures for LLM mentions: $0.1 per request and
  $0.001 per row, above the $0.05 the calculator shows

Either way it is multiplied by `PROVISIONAL_SAFETY_FACTOR` (2), because prices
rose about 20% on 2026-07-01 (DF35). The reservation holds this amount against
the per-run, weekly, monthly and combined caps. If the submission is ambiguous
or its cost goes unreported, the reservation stays `unresolved` at the hold,
so later runs cannot spend it again. The approval summary states the hold, and
the hold is part of the approved hash. If no bound can be formed at all (for
example, no safe row limit), no approval is requested and even an approved
request is refused. Configured `pricingOverrides` always take precedence.

**Override keys.** `research.dataforseo.pricingOverrides` is keyed by the
price keys below. The config schema describes the keys "by endpoint key", so
the four per-task endpoint keys are accepted as aliases:

| Alias | Price key |
| --- | --- |
| `serp/google/organic/task_post` | `serp.google.organic.standard` |
| `serp/google/organic/live/advanced` | `serp.google.organic.live` |
| `keywords_data/google_ads/search_volume/task_post` | `keywords.google_ads.search_volume.standard` |
| `keywords_data/google_ads/search_volume/live` | `keywords.google_ads.search_volume.live` |

Row-priced endpoints have two prices, so they need the price keys. Any other
key is **ignored and reported**. It appears in `research status` under
"Pricing warning" (`DataForSeoStatus.pricingWarnings`) and in the warnings of
every research result. It is never ignored silently.

Price keys:

- `serp.google.organic.standard`
- `serp.google.organic.priority`
- `serp.google.organic.live`
- `keywords.google_ads.search_volume.standard`
- `keywords.google_ads.search_volume.live`
- `backlinks.request`
- `backlinks.row`
- `labs.google.task`
- `labs.google.item`
- `ai_optimization.llm_mentions.request`
- `ai_optimization.llm_mentions.row`

Upper bounds:

- **SERP:** base price × ceil(depth / 10) × 5 when the query contains search
  operators (DF4, DF10). The adapter never sends the paid extras
  (`calculate_rectangles`, `load_async_ai_overview`,
  `people_also_ask_click_depth`, `max_crawl_pages`) or `priority`. The local
  shortlist filters out queries with search operators by default.
- **Search volume:** a fixed price per task.
- **Gated endpoints:** the request price plus the row price × `maxRows`. The
  provider enforces the same bound (see Row bounds above).

The actual cost is the sum of the task-level `cost` fields. If any task cost
is missing, the actual cost is `null` (unknown), never 0. The response-level
total is used only when the response contains no tasks. A charge above the
estimate is recorded truthfully, and the budget service flags the overshoot.

No Google Ads account is needed (DF36).

## Cache

`research_cache` keys hash the following fields together:

- site
- logical endpoint
- location code
- language code
- device
- parameter hash
- mode (`live`, `sandbox` or `fixture`)

Sandbox data therefore never satisfies a live request, and a desktop SERP
never satisfies a mobile one. TTLs come from site config:

| Data | Setting | Default |
| --- | --- | --- |
| SERP | `cacheDays.serp` | 7 days |
| Keyword volume (per keyword) | `cacheDays.keywordVolume` | 30 days |
| Competitor research through gated endpoints | `cacheDays.competitor` | 14 days |
| Location and language lookups | fixed | 30 days |

A TTL of 0 disables caching. Cache entries point at stored observations
(`db:serp_snapshots:<id>` and `db:keyword_metrics:<id>`) or at raw responses.

## Locations, languages, devices

`market.searchLocations[].locationCode` is **verified** against the free lookup
endpoint for the kind of request (SERP or Google Ads). If an entry has no
code, its `name` must exactly and uniquely match one `location_name`.
Otherwise the adapter fails with candidates and never guesses. The language
code is verified the same way.

When `market.countries` holds exactly one ISO alpha-2 code, the adapter
fetches the smaller per-country list. Devices come from `market.devices`:
desktop or mobile. `tablet` is not supported and is skipped with a note.

If the lookups are unavailable (offline or dry run), the settings are marked
`unverified` and paid submissions are skipped.

To find codes, run `research locations <name> --country <iso2>` (free). The
name can also be given as `--search <name>`.

## Stored data (fixed schema, migration 0005)

| Table | Contents |
| --- | --- |
| `dataforseo_tasks` | One row per task, created before the POST. Holds the remote id, tag, parameter hash, task-level cost, API status, `is_sandbox`, and `params_json` (task body and meta, no credentials). `serp_snapshots.dataforseo_task_id` stores the **local** task id |
| `serp_snapshots` | Query, location, language, device, depth, parameter hash, and `features_json` (item types, partial/no-results flags, transformation version). `collected_at` is the provider SERP datetime, since SERP data is captured when the task is set (DF38). Has `is_sandbox` |
| `serp_results` | Every top-level item. `is_own_site` compares the URL host exactly against `site.allowedHostnames` |
| `rankings` | A point-in-time own-site organic rank. NULL means "not found within depth". There is no row when a partial result makes absence unknown. This is **not** GSC average position |
| `keywords` | Upserted with an origin trail and `is_branded` from `brand.aliases` (NULL when no aliases are configured). One row per query: research reuses the existing row of the same normalized query (exact language first, then the language-less Search Console row) instead of adding a language duplicate; migration 0203 merged earlier duplicates. The request language stays on `serp_snapshots` and `keyword_metrics`. In sandbox or fixture mode, only keywords the owner **requested** are upserted: the SERP query, or the keywords in the volume request. A keyword that appears only in the provider's dummy response is never added. These rows have the origin `dataforseo_sandbox` or `dataforseo_fixture` in `origins_json`. The keyword text is real because the owner asked for it. Its metrics stay flagged `is_sandbox = 1` in `serp_snapshots` and `keyword_metrics` |
| `keyword_metrics` | `search_volume` is an ESTIMATE; NULL means the provider returned none. `competition` = `competition_index / 100`. `monthly_json` holds monthly searches. CPC is **not** persisted, because its currency is not verified in the contract; it stays in the raw response. Has `is_sandbox` |
| `competitors` and `competitor_pages` | SERP-discovered domains (`origin = 'serp_discovered'`) and the top-N pages to crawl |
| `sources` | One provenance row per snapshot: `third_party_data`, or `synthetic` for sandbox data |

Raw responses go to the workspace raw store (redacted, mode 0600).

**Sandbox and fixture results** are stored with `is_sandbox = 1`, and
`provider_requests.is_synthetic = 1`. They are never written to `rankings`,
`competitors` or `competitor_pages`, because those tables have no sandbox flag.
`keywords` has no sandbox flag either. It only gets requested keywords (see
above). A consumer that must tell research-only keywords apart can filter
`origins_json` for `dataforseo_sandbox` or `dataforseo_fixture`.
The read helpers in `queries.ts` exclude them. `serpResultsForRecommendation`
throws for a sandbox snapshot in a real workspace. In a synthetic demo
workspace (`ctx.synthetic`), all data is synthetic and labeled, so the helpers
include it.

## What is sent externally

These are sent to `api.dataforseo.com`, or to `sandbox.dataforseo.com` in
sandbox mode:

- The API login and password, in the Basic auth header only.
- The search queries selected for SERP research, with location code, language
  code, device and depth.
- The keyword lists for search-volume estimates, with location and language codes.
- Task tags, which are random local ids containing no site or personal data.
- For gated endpoints, only the approved request body.

Nothing else from the workspace is sent. That includes GSC or GA4 metrics,
page content, vault notes, and other credentials.

## Policy and safety

- **Paid requests** need all four of the following:
  - explicit authorization (`allowPaid`; the CLI flag is `--allow-spend`)
  - runtime mode RESEARCH or higher, chosen explicitly with `--mode RESEARCH`.
    The default mode is ANALYZE, and the CLI never raises it on its own.
  - verified location and language
  - a successful budget reservation
- **Dry runs** make no network requests and no writes. They show cache hits,
  reused tasks, submissions, the total upper bound, per-run, weekly, monthly
  and combined caps, and a budget check.
- **Credentials** are registered for redaction: the login, the password, and
  the base64 Basic token. Tests check that none of them appear in logs, raw
  files, database tables, or results.
- **Offline and demo contexts** allow only the synthetic fixture transport.
- **Provider text** (titles, snippets) is untrusted data. It is stored
  verbatim and never interpreted.
- **Selective research.** The plan warns when
  `research.seriousQueriesPerRun` is above five (the spec's band is three to
  five serious queries). `research.dataforseo.queue: live` is used only with
  a non-empty `research.dataforseo.liveQueueJustification`; without one the
  standard queue is used and the plan says so. With one, the live queue and
  its reason are shown in the plan and audited, and `config validate` warns
  about a live queue without a reason.
- **Site lock.** `research keyword` takes the per-site lease while it runs
  and refuses with `LOCKED` while a job or another manual command holds it
  (`--dry-run` neither takes nor checks it).

## CLI

```
npm run cli -- research keyword "<query>" ["<query>" ...] --dry-run      # plan, caps, cache hits; no requests
npm run cli -- research keyword "<query>" --sandbox --wait 120           # free sandbox (synthetic)
npm run cli -- --mode RESEARCH research keyword "<query>" --allow-spend [--volume] [--device mobile] [--location <code>] [--competitors <n>] [--wait <s>]
npm run cli -- research tasks [--poll] [--all] [--abandon <taskId>]
npm run cli -- research locations [<name> | --search <name>] --country <iso2> [--kind serp|keywords] [--sandbox] [--limit <n>]
npm run cli -- research status [--network] [--sandbox]
```

`research keyword` runs in the mode you choose. The default is ANALYZE, and
the command never raises it. A paid (non-sandbox) run needs both
`--mode RESEARCH` and `--allow-spend`. If either is missing, the run prints
the plan and caps, names the missing flags, sends nothing paid, and exits with
code 3. A `--dry-run` in ANALYZE mode shows the plan and says which flags a
real run needs. `--sandbox` is free and needs neither flag. Owner-provided
queries still go through local filtering and the `seriousQueriesPerRun` cap.

The overall status is `completed` (every query cached or fetched), `pending`
(the rest still queued or ambiguous), `partial` (some results, some queries
not researched), `failed` (no query was fetched, cached or queued and at
least one failed), `skipped` (nothing was attempted) or `planned` (dry run).
The search-volume part (`--volume`) uses the same values. Exit codes of
`research keyword`:

| Code | When |
| --- | --- |
| 0 | `completed`, `pending` (standard-queue tasks collected later), or a dry-run plan |
| 1 | `failed`: no query produced a result |
| 2 | `partial`, every query `skipped` (for example `DATA_UNAVAILABLE` when the location could not be verified, or all filtered), an ambiguous submission, or a search-volume part that did not complete |
| 3 | a precondition refused paid work: missing `--mode RESEARCH` / `--allow-spend`, `BUDGET_EXCEEDED`, `BUDGET_UNKNOWN_PRICE` |

A provider or network failure (`PROVIDER_ERROR`, `TIMEOUT`,
`INTEGRATION_UNAVAILABLE`, `RATE_LIMITED`) carries a next step: check
credentials and connectivity with the free `research status --network`, and
see `research tasks --all` for the provider message. A failed task is never
resubmitted automatically; re-running the command sends a new, budgeted
request. An error that already has a specific hint (insufficient funds,
invalid credentials) keeps it.

The numeric options `--competitors`, `--location`, `--wait` and `--limit` must
be whole numbers. Anything else fails with `VALIDATION_FAILED` and is never
passed on as NaN.

## Limitations and unverified items

- **Not live-tested.** No credentials were used. Response shapes come from the
  documentation and synthetic fixtures.
- **`task_get` on an unfinished task.** The response code is undocumented.
  40601 and 40602 are treated as pending. 40401 is treated as pending for up
  to 3 days, then as failed.
- **Sandbox search-volume path.** The sandbox appendix shows a legacy
  `keywords_data/google/...` path. The adapter uses the documented host-swap
  rule with the `google_ads` path, which is unverified.
- **Google Ads `tasks_ready` items.** The contract does not list their fields.
  The adapter matches on `id` and `tag`. If `tag` is absent, ambiguous volume
  tasks cannot be reconciled automatically and stay ambiguous.
- **LLM-mentions pricing** is unverified (DF34 is inconsistent). These calls
  always need an approval for an unknown price. The budget holds the static
  figures × 2 until the provider reports the actual cost.
- **Row-limit field names.** The `limit` field of `ranked_keywords/live` and
  `llm_mentions/search_mentions/live` comes from their endpoint pages (DF29,
  DF27). docs/integration-contracts.md does not restate it. If the provider
  rejects it (40501/40506), the task fails and the reported cost (normally $0)
  is recorded. The claim that `backlinks/summary/live` returns a single row is
  the documented purpose of a summary endpoint (DF28). The estimate still
  assumes `maxRows` rows.
- **Provisional holds** use a fixed 2× safety factor over stale or unverified
  figures. That is a policy choice, not a provider guarantee. Set
  `pricingOverrides` to replace it with a verified price.
- **Documented prices expire** after 90 days, on 2026-12-23 for the current
  values. Re-verify at https://dataforseo.com/pricing and set
  `pricingOverrides`.
- **Rate limits** (`tasks_ready` 20/min, Google Ads live 12/min) are enforced
  in-process only. Concurrent processes rely on the per-site job lock.
  `X-RateLimit-*` headers are logged at debug level when present.
- **Duplicate submissions across processes.** Two processes researching the
  same query at the same moment could both submit. The jobs module's per-site
  lock prevents overlapping runs.
- **Charges of ambiguous tasks** that are later found stay `unresolved`. The
  provider does not report the posting charge on `task_get`. Settle them from
  the dashboard's billing history with `costs reconcile` (a named human and
  evidence required; audited).
- **CPC** is not persisted until its currency is verified.

## Next steps for credentials and access (owner)

1. Create API credentials at https://app.dataforseo.com/api-access. The API
   password is auto-generated and is not the account password (DF1). Review
   the minimum payment ($50) and the $1 trial credit (DF3, DF37).
2. Put `DATAFORSEO_LOGIN=` and `DATAFORSEO_PASSWORD=` in
   `<workspace>/secrets/secrets.env` (mode 0600), or inject them from a
   password manager. Never paste them into chat, the vault, or the site config.
3. In the site config:
   - set `features.dataforseo: true` (the `full` profile default)
   - set `research.dataforseo.mode: sandbox`
   - add `market.searchLocations` with a `languageCode`
   - find the `locationCode` with `research locations <name> --country <iso2>`
4. Run `research status --network`. It makes only the free user_data call.
   Then run `research keyword "<query>" --sandbox --wait 120`.
5. Review the prices in `research status`. Set `pricingOverrides` if a price
   has changed or is older than 90 days. Then switch to `mode: live` and
   review the plan with `research keyword "<query>" --dry-run`. Run with
   `--mode RESEARCH --allow-spend` only when the plan and caps are acceptable.
   Check `research status` for "Pricing warning" lines: an unrecognized
   `pricingOverrides` key is ignored.
6. Consider setting a provider-side spending limit in the DataForSEO
   dashboard. Local checks cannot guarantee zero overshoot when provider
   billing is delayed.
