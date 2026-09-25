# Apify: Reddit research adapter

This module has two layers. The first is a generic Apify API v2 client. The second is a typed adapter for the **Reddit Scraper actor `9sHOY9RzPYGjmTHo8`**, which is publicly listed as `harshmaur/reddit-scraper`. The Actor ID is authoritative, and the adapter never substitutes another actor. Spec sections covered: 15, 20 (discovery inputs), 25, 26, 31 and 33.

The adapter finds recurring questions, objections, complaints, comparisons, unmet needs and tool ideas in Reddit posts and comments. It stores them as `content_signals` with origin `apify_reddit`. Every signal is **user-reported evidence**. A signal is not a verified product fact or a representative survey, and Reddit engagement does not measure search volume.

## Status

| Feature | Status | Note |
|---|---|---|
| Generic client: actor, builds, OpenAPI, run start, run get, list runs, dataset items, key-value record | implemented-awaiting-credentials | Tested offline against fakes only; never run against the live API with credentials. See "Next steps" |
| Build pinning, schema storage (hash) and drift detection; README provenance (hashes of the build README and its load-bearing passages, drift between the pinned and the latest build) | implemented-and-tested | Only hashes are stored, never the README text (migration 0250) |
| Output-schema drift: a run whose items the normalizer cannot read (0 normalized items) is quarantined, never completed or reused as research | implemented-and-tested | `tests/integration/apify/runs.test.ts` ("output schema drift") |
| Schema import (`apify import-schema`) | implemented-and-tested | Imported schemas are unverified unless the owner attests them |
| Input builder: schema-validated, limits enforced, AI, MCP and webhooks off, secret scan | implemented-and-tested | |
| Paid run lifecycle: reserve, POST, poll, fetch, normalize or quarantine, reconcile | implemented-awaiting-credentials | Needs `APIFY_TOKEN` and one approved `apify test` run (`--mode RESEARCH`) |
| Content research batches (`apify research`): one bounded run per `research.subreddits` entry (actor field `withinCommunity`), plan hash, total cap split per run | implemented-awaiting-credentials | Fake API only (`tests/integration/apify/cli.test.ts`) |
| Ambiguous-submission reconciliation through list-runs + the run's `INPUT` record | implemented-awaiting-credentials (fakes) | A candidate is adopted only when its `INPUT` record equals the submitted input. The real list output and `INPUT` record have not been observed with credentials |
| Partial-result detection (charge cap reached, failed requests) | implemented-awaiting-credentials (fakes) | The wording of a "charge limit reached" status message is unverified; detection relies mainly on charge vs cap |
| Owner confirmation of a not-accepted submission (`apify runs --confirm-not-accepted`) | implemented-and-tested | Records $0 as `manual`, never as provider-reported |
| Heuristic signal classification | implemented-and-tested | The default for every run. English patterns only (see Limitations) |
| LLM signal classification (prompt `research.reddit-signals`) | implemented-awaiting-credentials (fake LLM) | Used only with `apify research --classify-with-llm --llm-max-usd <cap>`; each call is budget-reserved, and unknown prices or failures fall back to the heuristics and say so |
| Abort of overdue runs | implemented, unverified endpoint | Opt-in only (`--abort-overdue`) |

## Files

| File | Responsibility |
|---|---|
| `src/integrations/apify/client.ts` | Generic HTTP client. Bearer auth. GETs retry with backoff; the paid POST never retries. Typed errors |
| `src/integrations/apify/types.ts` | Lenient zod parsers for Run, RunShort, Actor and Build |
| `src/integrations/apify/input-schema.ts` | Input schema parsing, canonical hash, diff, validation, export detection. Pure functions |
| `src/integrations/apify/schema.ts` | `inspectActor`, `importActorSchema`, `resolveRunnableSchema`, and schema and pricing storage in `apify_actor_schemas` |
| `src/integrations/apify/reddit-adapter.ts` | Actor-specific field policy, input builder, schema compatibility analysis, secret scanning |
| `src/integrations/apify/pricing.ts` | Pricing-record selection, conservative estimate, charge computed from event counts |
| `src/integrations/apify/normalize.ts` | Dataset items to minimized items to classified signals, plus `sources` and `evidence` rows |
| `src/integrations/apify/runs.ts` | `runContentResearch`, `resumeApifyRuns`, ambiguous reconciliation, `confirmNotAccepted`, quarantine, `ingestSyntheticDataset` |
| `src/integrations/apify/status.ts` | `apifyStatus` (honest `IntegrationStatus`) and the list of data sent externally |
| `src/cli/commands/apify.ts` | `apify status / inspect / import-schema / test / research / runs` |
| `migrations/0170_apify_run_tracking.sql` | Additive columns on `apify_runs` (see "Schema additions") |
| `migrations/0171_apify_plan_occurrences.sql` | `apify_runs.plan_json`, `apify_runs.observed_result_items`, and the `apify_signal_occurrences` table |
| `migrations/0250_apify_readme_provenance.sql` | `apify_actor_schemas.provenance_json` (README and output-schema checks, hashes only) and `apify_runs.items_normalized` |

## Verified contract usage

Everything below comes from `docs/integration-contracts.md` section 7, retrieved 2026-09-24. Base URL: `https://api.apify.com`, using the canonical `/v2/actors/...` prefix. Every call sends `Authorization: Bearer <APIFY_TOKEN>` when a token exists. The client refuses to put a token into a query string.

| Call | Endpoint | Paid | Contract status |
|---|---|---|---|
| Actor identity and pricing | `GET /v2/actors/{id}` | no | Verified (LIVE) |
| Build and input schema | `GET /v2/actor-builds/{buildId}` (`inputSchema` is a JSON **string**) | no | Verified (LIVE) |
| OpenAPI fallback | `GET /v2/actor-builds/{buildId}/openapi.json`, then `components.schemas.inputSchema` | no | Verified (LIVE) |
| Default build | `GET /v2/actors/{id}/builds/default` | no | Verified (LIVE). Exposed by the client but not used by the flow |
| Start run | `POST /v2/actors/{id}/runs?build&timeout&memory&maxItems&maxTotalChargeUsd&restartOnError=0&waitForFinish=0` | **yes** | Verified (DOCS). `webhooks` is never sent |
| Get run | `GET /v2/actor-runs/{runId}?waitForFinish=0..60` | no | Verified (DOCS) |
| List runs (reconciliation, token check) | `GET /v2/actors/{id}/runs?offset&limit&desc&status&startedAfter` | no | Verified (DOCS). Returns 401 without a token (LIVE) |
| Dataset items | `GET /v2/datasets/{id}/items?format=json&clean=1&offset&limit&fields=...` plus `X-Apify-Pagination-*` headers | no | Verified (DOCS) |
| Run summary | `GET /v2/key-value-stores/{id}/records/RUN-SUMMARY` | no | Verified (README via build) |
| Run input (ambiguous reconciliation only) | `GET /v2/key-value-stores/{id}/records/INPUT` | no | DOCS-inferred: the Run Actor operation says the POST payload "is passed as `INPUT` to the Actor", and the metamorph docs say inputs are stored in the run's default key-value store. **Not observed live.** If it cannot be read, the candidate is never adopted |
| Builds list | `GET /v2/actors/{id}/builds` | no | **Unverified.** Only a fallback for resolving a pinned build number to a build id. The response is parsed defensively |
| Abort | `POST /v2/actor-runs/{runId}/abort` | no | **Unverified.** Opt-in only |

Pricing is parsed from `pricingInfos[].pricingPerEvent.actorChargeEvents`. The contract lists the `ActorChargeEvent` fields, but not the path of the container that holds them. If that path does not parse, the estimate is `unknown` and paid runs are refused. The price is never treated as $0.

## Build pinning, schema storage and drift

1. `apify inspect` uses free reads only. It checks the live identity: the ID must match, and a change of username or name raises a warning. It also reads pricing (the record in force is the latest `startedAt` at or before now), the `latest` tagged build, and the pinned build.
2. For each build it takes the input schema from `build.inputSchema`, falling back to the build's OpenAPI definition. The schema is stored in `apify_actor_schemas` with a canonical `schema_hash`.
   - A build counts as verified when its status is `SUCCEEDED` and its `actId` is the configured actor.
   - Inspect also reconfirms the **output schema** (`actorDefinition.storages.dataset.fields`). The fields the normalizer reads must exist there.
3. The pin lives in configuration: `research.apify.build` in the site config, or `APIFY_CONTENT_ACTOR_BUILD`. It must be an immutable **build number** such as `0.0.513`. Tags such as `latest` move between builds, so they are never run. A run is allowed only when the most recent stored schema row for the pinned number has `verified = 1`.
4. Drift checks:
   - When the latest build's schema hash differs from the pinned build's, inspect reports the added, removed and changed fields. It also runs an adapter-compatibility analysis on the newer schema, and it writes an `apify.schema_drift` audit event.
   - The pinned build keeps running unchanged. To upgrade, change the pin; the new build must be inspected and verified first.
   - A changed hash for the **same immutable build id** is stored unverified, and runs are refused.
   - Before every paid run, the pinned build's schema is re-read (free read). A hash mismatch refuses the run.
5. `apify import-schema <file>` accepts three formats: a raw input schema, a build JSON (`{data: build}` or a bare build), or a build `openapi.json`.
   - **An example input is rejected.** An example cannot establish the complete field set.
   - Imports are stored `verified = 0`, which means the integration is unresolved, and runs stay refused. A later `apify inspect` of the same build verifies the import.
   - The owner can attest an import with `--build <n> --attest`, which writes an `apify.schema_imported_attested` audit event. Imports carry no pricing, so paid runs still need a live pricing read.

## Input policy (Reddit adapter)

The adapter builds input **only from fields present in the stored verified schema**. It then validates the input against that schema: types, enums, ranges, patterns, `isSecret` and `required`. Any field outside the schema is rejected.

- **Set by the adapter:**

  | Field | Value |
  |---|---|
  | `searchTerms` | From the request or `research.seedTopics`. Never hardcoded |
  | `searchPosts` | `true` |
  | `searchComments` | `false` |
  | `maxCommentsCount` | `0` |
  | `searchCommunities` | `false` |
  | `maxCommunitiesCount` | `0` |
  | `includeNSFW` | `false` |
  | `searchSort` | `relevance` by default |
  | `searchTime` | `research.apify.timeRange`, or a narrower per-run range |
  | `postedAfter` / `postedBefore` | Optional; must lie inside the configured time window |
  | `startUrls` / `subredditUrls` | `[]` (direct-URL inputs are not used) |
  | `mcpTarget` / `mcpTool` / `mcpServerUrl` | `""` (delivery explicitly off) |
  | `withinCommunity` | Optional |
  | `maxPostsCount` | `floor(maxItems / terms)` |
  | `crawlCommentsPerPost` / `maxCommentsPerPost` | From `research.apify.maxCommentsPerPost` (possibly lowered by the `fit` cap policy) |

  The actor docs disagree on whether `maxPostsCount` is a total or a per-keyword limit. Splitting `maxItems` across terms keeps the post bound under either reading.
- **Forced off when present:** `aiAnalysis`, the 9 AI flag booleans, and `customLabels: {}`.
- **Unknown risky fields** (names or text that look like AI add-ons, delivery, webhooks or integrations):
  - A boolean is forced to `false` only when its default is already off **and** its name/title is not negated. A negated toggle (for example `skipAiEnrichment`, `disableWebhookDelivery`, a title starting "No AI") or one that defaults to `true` **blocks the run**: `false` could switch the feature on, and its polarity cannot be verified automatically.
  - Objects become `{}` and lists `[]`. A string with an empty default stays unset. Anything else blocks the run.
- **MCP delivery, explicitly disabled:** the plain-string activation fields `mcpTarget`, `mcpTool` and `mcpServerUrl` are sent as `""` (the schema says "Leave empty to scrape only"). `mcpConnector` is a platform resource reference, and whether an explicit empty value passes platform validation is unverified, so it stays unset (its default is empty). `mcpServerToken` is a secret and is never set. Options that are inert without a connector (`mcpMode`, `mcpComments`, `mcpCommentsPerPost`, `mcpMessage`, `mcpArguments`, `mcpMaxItems`) stay unset. A delivery activation field with a non-empty default is blanked, or blocks the run when it cannot be.
- **Direct-URL inputs off:** `startUrls: []` and `subredditUrls: []` are set explicitly. Sort, time range and community apply only to `searchTerms` (contract section 7), `startUrls` can target user profiles, and the result and cost bounds are computed from search terms only. So `startUrls`, `subredditUrls` and `fastMode` can never be set through `extraInput`.
- **`extraInput`** accepts only the narrowing filters `onlyWithFlair`, `commentedAfter` and `commentedBefore`. Any other field is rejected, including unmapped schema fields (review a field before adding it to `EXTRA_INPUT_FILTER_FIELDS`).
- **AI event pricing:** `analyzed_item` / `custom_label` are priced at 0 only when at least one of their trigger fields exists in the schema and every existing trigger is explicitly off in the input. Otherwise they are priced once per result.
- **Webhooks:** the input schema has no webhook field, and the run's `webhooks` query parameter is never sent.
- **Secrets:** the input is scanned before anything is written or sent. The scan looks for:
  - configured secret values (LLM Gateway, DataForSEO, Apify, Qdrant, PageSpeed, and the Google credential paths)
  - credential shapes, detected with `redactString`
  - fields with secret-like names
  - private workspace and database paths

  A hit returns `rejected`. Findings name the field path, never the value.
- **Limits:**
  - Per-run overrides can only **lower** the `research.apify.*` values (`maxItems`, `maxCommentsPerPost`, `maxRunSeconds`, `maxTotalChargeUsd`).
  - **Time range is a ceiling too.** A run may pass a narrower `timeRange` (order: hour, day, week, month, year, all), never a broader one. The earliest allowed date is derived from the run's range and the clock (`week` on 2026-09-24 gives 2026-09-17; `all` is unbounded). `postedAfter`, `postedBefore`, `commentedAfter` and `commentedBefore` must be on or after it; `postedAfter` may not be in the future, and `postedBefore` may not precede `postedAfter`. This matters because setting `postedAfter` makes the actor ignore `searchTime`. Date filters are day-granular (UTC), so the effective window can start up to one day before the exact boundary. A build without `searchTime` gets the window as `postedAfter`.
  - The run `timeout` is set to `maxRunSeconds`.
  - `memory` is `research.apify.memoryMbytes` and must be a power of 2.
  - `maxItems` is set to the result bound. It is an extra guard only: the docs say it applies only to pay-per-result actors, and this actor is pay-per-event.

## Cost and budget flow

The steps below follow spec section 25.

1. **Reuse.** An identical input that completed within the reuse window (168 h by default, `--no-reuse` disables it) is reused without spend. An identical run still in flight (same `input_hash`, `processing_status = 'pending'`) is **resumed**, never duplicated. The duplicate check runs again inside the reservation transaction, so concurrent identical requests start only one run.
2. **Free reads.** The pinned build's schema hash is re-verified and pricing is re-read. If the live pricing read fails, stored pricing younger than 168 h is used. Otherwise the price is unknown.
3. **Estimate.** The estimate is a conservative upper bound for PAY_PER_EVENT pricing:
   - One-time `init`: counted `ceil(memory GB)` times, because its description says "per GB" (unverified).
   - Primary `result`: counted once per possible result (posts plus comments). The **highest** tier price is used, because the account's tier mapping is unverified.
   - AI events: count 0 only because their triggers are forced off.
   - Any unrecognized event: counted once per result. An item limit is not assumed to bound every charge.
4. **Cap policy.** When the conservative estimate exceeds the cap, `capPolicy` decides:
   - `fit` (default): the comment bound (then the post bound) is lowered until the estimate fits under the cap, and the plan reports `boundsLowered` plus a warning. With the default config (50 posts, 10 comments per post, $1.00 cap) the estimate is $1.12, so comments per post become 8 (estimate $0.92). A run can then not be truncated by the cap at the conservative price.
   - `refuse`: the run is rejected.
   - `accept_truncation`: the bounds are kept, the plan says `truncationPossible: true`, and a run stopped by the cap is quarantined as partial.
5. **Cap and reservation.** The provider-side cap `maxTotalChargeUsd` is `min(estimate, configured cap, --max-usd)`. The same amount is reserved with `ctx.budgets.reserve` (provider `apify`) against the run, site, service, combined and account limits. An unknown price throws `BUDGET_UNKNOWN_PRICE`, and the run is refused.
   - `expectedPlan` binds a paid run to a plan the owner already saw. The cap may not exceed the one shown and the input must hash the same; otherwise nothing is sent and `confirmation_required` is returned. `apify test` uses this: the cap printed before the run is passed as the run's cap, and if live pricing changes the input (bounds re-fitted), the run is not started.
6. **Before the POST**, one transaction writes:
   - the `budget_reservations` row
   - the `provider_requests` row (paid, `idempotency_key = input_hash`)
   - an `apify_runs` row with status `submitting`, the exact input body, the run options, and the plan facts (`plan_json`: estimate, cost terms, cap, whether truncation was possible, bounds, time window)

   The request is then marked `submitted`, and the POST is sent.
7. **After the POST:**
   - The run id is persisted immediately.
   - A 4xx response (other than 408) means the submission was rejected: the reservation is released.
   - A timeout, a network error after sending, a 5xx, or an unreadable 2xx makes the submission **ambiguous**. The reservation becomes `unresolved` and stays held, and the POST is never retried.
8. **Polling:** `GET run?waitForFinish=60` with backoff, until a terminal status or a local deadline (`timeout + 180 s`). After completion there is a 10 s wait and a re-read to get stable usage.
9. **Reconciliation** (after the dataset is fetched, so usage can be checked against what the run did):
   - `usageTotalUsd` is reconciled as `provider_reported`, unless it contradicts the observed activity: $0 for a run that ran, or less than the cheapest price of the results already fetched. Such figures are treated as preliminary.
   - Without it, `chargedEventCounts` is used only when every charged event has a flat price (`computed_from_usage`) **and** the counts are consistent: not empty, the one-time `init` present for a run that ran, and at least as many `result` events as posts/comments already fetched. The contract warns that counts can be preliminary right after a run ends.
   - Otherwise the reservation stays **`unresolved`**. It is never recorded as $0, and `apify runs --resume` re-checks it (using the stored `observed_result_items`).
   - A charge above the reservation (for example after a price change) is recorded truthfully, and the overshoot is flagged.

Limitation: Apify bills with a delay, and polling cannot guarantee zero overshoot. The provider-side `maxTotalChargeUsd` is the effective hard cap.

## Run lifecycle and recovery

`apify_runs.status` mirrors the remote status. It can also be `submitting`, `ambiguous` or `quarantined`. `processing_status` records how far local processing got:

| processing_status | Meaning |
|---|---|
| `pending` | Submission, polling, fetching or normalizing is still outstanding |
| `complete` | The dataset was fully fetched and normalized. The research is usable |
| `quarantined` | The run was FAILED, TIMED-OUT, ABORTED, rejected, probably not accepted, partially fetched, stopped by its charge cap, reported failed requests, or has a RUN-SUMMARY that disagrees with the dataset. **Never used as complete research.** Minimized items go to the raw store for inspection only |
| `abandoned` | The paid POST was provably never sent: the process stopped before `markSubmitted`. The reservation is released |

**Partial SUCCEEDED runs are quarantined**, not treated as complete research:

- RUN-SUMMARY `itemsTotal` above the dataset total.
- RUN-SUMMARY `requests.failed > 0` (coverage incomplete).
- **Charge cap reached:** fewer results than the planned bound were charged while the charge is within one result price (highest tier) of the provider cap. The charge is `usageTotalUsd`, or the low/high range implied by tiered `chargedEventCounts`. When only the high end of that range reaches the cap, the run is quarantined as "partial (unverifiable)". When no usage is known at all, the run is quarantined as unverifiable only if the plan allowed truncation. A status message mentioning a charge/spending limit also counts (heuristic: the platform's exact wording is unverified).

`resumeApifyRuns` (CLI: `apify runs --resume [--wait] [--abort-overdue]`) handles every pending row.
It first reads the database. With no pending row and no unresolved charge it returns `ok` ("No pending Apify
runs.") in every mode, contacting nothing: nothing needed Apify, so a dry run, offline or demo mode, or a
missing token is not reported as skipped work (the content queue's `apify_signals` stage then adds no note).
With work outstanding, a dry run, offline mode, and a missing token return `dry_run`, `offline`, and
`missing_credentials` and contact nothing. Otherwise:

- **Stale `submitting` row:** if the request is still `prepared`, the row is marked abandoned. Otherwise it becomes ambiguous.
- **Ambiguous row:** the tool lists runs that started from 5 minutes before the submission up to the grace window after it. It skips runs of another build, runs whose origin is not `API`, and **every run already linked to any site of the workspace** (by `apify_runs.remote_run_id` or a recorded start request's `external_id`). The Apify account and token are shared by all sites, so this check is workspace-wide and reads only provider run ids.
- **Fingerprint and proof:** each remaining candidate is pre-filtered on `stats.inputBodyLen`, `options.maxTotalChargeUsd`, `timeoutSecs` and `memoryMbytes`. It is then **verified by its `INPUT` record** in the run's default key-value store: every submitted field must be present with an equal value, and any extra field must equal the verified schema default (whether the platform fills defaults into `INPUT` is unverified).
  - Exactly one verified match: the run is adopted and no second POST is sent. The exception is when another pending ambiguous submission (any site) has the identical input: then nobody adopts it automatically.
  - Several possible matches, or a candidate whose `INPUT` cannot be read (unverifiable), or candidates that do not match: the row stays ambiguous and the reservation stays held for a manual check.
  - No candidate at all after the 30-minute grace window: the submission was **probably** not accepted. The row is quarantined, but the reservation stays **unresolved**: an absence in list-runs is an inference, not a provider-reported $0. After checking the Apify console, the owner runs `apify runs --confirm-not-accepted <id>`. That re-checks list-runs when online (and refuses if an unlinked run appeared in the window), then records $0 with source `manual` and the evidence in `usage_json`.
- **Polling and processing:** runs that are still going are polled, finished runs are processed, and `unresolved` charges are re-checked.

## Normalization and personal data

- The dataset is requested with `fields=`, an allowlist of non-personal post and comment fields. The same allowlist is enforced again locally.
- `user_profile` and `community` items, NSFW posts, and deleted or removed items are dropped. Items are deduplicated on `dataType:id`.
- In the text, `u/handles`, `@handles`, e-mail addresses, phone-like numbers and credential shapes are masked. Links that are not http(s), or that point to user profiles, are dropped.
- Each stored signal carries:
  - the source link and posting date
  - the collection window (build, remote run, searchTime, postedAfter/Before, search term, community)
  - engagement, labeled "Engagement is not search volume."
  - a limitations text
  - a `sources` row (`reddit`, trust class `user_reported`, or `synthetic`)
  - an `evidence` excerpt

  Signals are deduplicated per site on the normalized text hash. **Recurrence is kept:** every supporting item (the first one and each repeat of the same normalized text from another post, comment or later run) gets a row in `apify_signal_occurrences` with its own `sources` link and `evidence` excerpt. `COUNT(*)` per signal is its recurrence, and `signalOccurrences(db, siteId, signalId)` returns the count and example links. Re-processing the same item is idempotent.
- Classification uses deterministic English heuristics by default. The `llmSignalClassifier` runs only when the owner asks for it (`apify research --classify-with-llm --llm-max-usd <cap>`); it sends only minimized text, as untrusted `user_reported` evidence, with personal identifiers masked. Items the model skips, calls with an unknown price, and failed calls fall back to the heuristics, and the output says how many runs used which method. Unclassified items are counted but not stored as signals.
- Item text is data only. Prompt-injection text is stored verbatim as data and can never change configuration, budgets, prompts or approvals (covered by tests).
- The adapter only reads. It never comments, sends messages, impersonates anyone, or creates mentions or backlinks.

## Data sent externally

- `APIFY_TOKEN` goes to `api.apify.com` in the Authorization header only.
- The actor input goes to Apify: search terms, an optional community, sort, time range and date filters, and result and comment limits.
- The actor queries Reddit with that input on your behalf. Apify stores the run and its dataset under your account, subject to your plan's retention.
- **Never sent:** Google, LLM Gateway, CMS, DataForSEO or database credentials, analytics data, site content, or vault notes. The secret scan enforces this.

## CLI

```
npm run cli -- apify status [--network]           # honest status; --network = free reads only
npm run cli -- apify inspect [--build 0.0.513]    # identity, pricing, builds, schema (stored), output fields, drift
npm run cli -- apify import-schema <file> [--build <n>] [--attest]
npm run cli -- --mode RESEARCH apify test --confirm-spend --max-usd 0.05 [--term "<topic>"] [--no-reuse]
npm run cli -- apify research [--term <t>...] [--community <name>... | --all-reddit]      # plan only (exit 2)
npm run cli -- --mode RESEARCH apify research --confirm-spend --max-usd <total> --plan <hash> [--classify-with-llm --llm-max-usd <cap>]
npm run cli -- apify runs [--resume [--wait] [--abort-overdue]] [--limit N]
npm run cli -- apify runs --confirm-not-accepted <apify-run-id>   # owner confirmation after checking the Apify console
```

- `apify test` without `--confirm-spend`, or with `--dry-run`, shows the plan and the cap, spends nothing, and exits with code 2.
- With `--confirm-spend`, `--max-usd` is required. The cap, the estimate and the budgets are printed before the run starts, and the run is bound to them: the printed cap is the run's cap, and if a live pricing re-read would change the input, nothing is sent (`confirmation_required`, exit 2).
- A test run uses 5 posts and no comments.
- A paid `apify test` or `apify research` also needs `--mode RESEARCH` (policy `external_research`); in ANALYZE mode it is refused before anything is sent.
- `apify research` takes its terms from `research.seedTopics` and its communities from `research.subreddits` (or `--term`/`--community`), and runs one bounded run per community with the configured `research.apify` limits (`--max-items`, `--max-comments-per-post`, and `--time-range` can only narrow them). Without `--confirm-spend` it prints the plan and a plan hash and exits 2. `--max-usd` is the total cap across the batch, split per run (each run also within `research.apify.maxTotalChargeUsd`). `--plan <hash>` refuses to start if the plan changed since you saw it.
- Site lease: `apify test`, `apify research`, `apify import-schema`, and `apify inspect` (it stores the fetched input schema and may pin a build) take the per-site lease while they run and refuse with `LOCKED` while a job or another manual command holds it; `apify runs` takes it only with `--resume` or `--confirm-not-accepted` (a plain listing is not refused). `--dry-run` previews neither take nor check it. See [CLI.md](../CLI.md#conventions-network-money-modes-and-exit-codes).
- `--json` works on every command.

## Programmatic API

`src/integrations/apify/index.ts` exports:

- `createApifyClient(ctx)`
- `inspectActor(ctx, {build?})`
- `importActorSchema(ctx, file, {build?, attest?})`
- `runContentResearch(ctx, opts)`
- `planContentResearchBatch(ctx, opts)` and `runContentResearchBatch(ctx, opts, plan)` (one run per community, bound to the shown plan)
- `resumeApifyRuns(ctx, opts)`
- `apifyStatus(ctx, {network})`
- `listApifyRuns(ctx)`
- `confirmNotAccepted(ctx, apifyRunId)`
- `signalOccurrences(db, siteId, signalId)`
- `ingestSyntheticDataset(ctx, items, meta)` for the demo: rows are flagged `is_synthetic = 1`, and no network or budget is involved
- `llmSignalClassifier(llm, {siteId, runId, promptId})`

`runContentResearch` needs RESEARCH mode or `explicitSpendConfirmation: true`. Options include `capPolicy` (`fit` by default) and `expectedPlan` (see "Cost and budget flow"). It returns an honest status for every precondition instead of throwing: `disabled`, `misconfigured`, `offline`, `missing_credentials`, `confirmation_required`, `rejected`, `budget_exceeded`, `budget_unknown_price`, `submission_rejected`, `ambiguous`, `running`, `quarantined`, `abandoned`, `reused`, `dry_run` or `completed`.

## Schema additions (migration 0170, additive)

`apify_runs` gains these columns: `processing_status`, `remote_status`, `status_message`, `reservation_id`, `schema_id`, `run_options_json`, `purpose`, `submitted_at`, `raw_ref` and `signals_created`. A new index covers `(site_id, processing_status)`.

These columns let an interrupted process resume a known run instead of paying twice. They also keep the remote status when a row is quarantined, and let an ambiguous submission be fingerprinted against provider history.

Migration 0171 (additive) adds:

- `apify_runs.plan_json`: plan facts fixed at submission, used after a restart to decide whether a SUCCEEDED run was cut short by its cap without depending on pricing that changed since.
- `apify_runs.observed_result_items`: posts/comments seen in the fetched dataset, a lower bound on charged results used to reject preliminary usage figures.
- `apify_signal_occurrences` (`site_id`, `signal_id`, `apify_run_id`, `item_key`, `source_id`, `evidence_id`, `url`, `posted_at`, `collected_at`, `is_synthetic`; unique per site, signal and item).

`apify_actor_schemas` has no `site_id` on purpose. A schema belongs to an actor build, not to a website. The pin itself lives in each site's config.

## Limitations

- The heuristic classifier is **English-pattern based**. For other languages, use `apify research --classify-with-llm --llm-max-usd <cap>` (paid) or review the signals yourself.
- The actor docs conflict on whether `maxPostsCount` is a total or per-keyword limit. The adapter splits `maxItems` across terms to stay safe.
- Reddit serves at most about 1,000 items per listing, so the `max*` limits are ceilings, not guarantees.
- The `init` price's "per GB" semantics, the account's tier mapping, and the pricing record currently in force are unverified. The estimates are conservative to cover this.
- The list-runs output for a non-owner token, the real `chargedEventCounts` keys, and real dataset and RUN-SUMMARY contents have **not** been observed with credentials.
- A RUN-SUMMARY whose `itemsTotal` exceeds the dataset total, or that reports failed requests, causes quarantine. Skipped targets (for example `date_window_unreached`) only produce warnings.
- The `INPUT` record comparison, the charge-limit status wording, and the consistency rules for usage figures are based on the documented contract, not on observed runs. They fail closed: an unverifiable candidate is never adopted, and implausible usage stays unresolved.
- An unresolved charge that is truly $0 for a run that never really started (for example ABORTED before start with empty counts) stays held until the owner settles it: `apify runs --confirm-not-accepted` for a submission Apify never accepted, or `costs reconcile <reservation-id> --not-charged --evidence "..." --by "<name>"` after checking the Apify console.
- Cross-site checks: the linked-run set and the competing-claimant check read `apify_runs` across sites (provider run ids and input hashes only), because the Apify account is shared by the workspace.
- Abort and builds-list are not in the verified contract. They are opt-in or fallback only.

## Next steps for credentials and access

1. Create an Apify account and an API token (Apify console > Settings > API & Integrations). Put it in `<workspace>/secrets/secrets.env` as `APIFY_TOKEN=...` (mode 0600), or inject it as an environment variable. Never paste it into chat.
2. Enable the feature: `features.apify: true`, or use the Full profile.
3. Run `npm run cli -- apify inspect`. Review the identity, pricing, input schema, output fields and adapter compatibility.
4. Pin the verified build number: set `research.apify.build: "<n>"` in `config/sites/<site>.yaml`.
5. Check the caps: `research.apify.maxItems`, `maxCommentsPerPost`, `timeRange`, `maxRunSeconds`, `maxTotalChargeUsd`, and `budgets.apify.*`.
6. Run `npm run cli -- apify status --network`. It uses free reads only and confirms the token, the actor and the pinned build.
7. Run a single approved test: `npm run cli -- --mode RESEARCH apify test --confirm-spend --max-usd 0.05 --term "<topic>"`. Then preview and run content research: `npm run cli -- apify research`, then `--mode RESEARCH apify research --confirm-spend --max-usd <total> --plan <hash>`.
8. Then run `npm run cli -- costs`, and record what you observe in `docs/integration-contracts.md`:
   - the real `chargedEventCounts` keys and `usageTotalUsd` (and whether they change in the ~10 s after completion)
   - the dataset fields
   - the list-runs output
   - the run's `INPUT` record in its default key-value store (does it equal the POST body exactly, or does the platform add schema defaults?)
   - the run's `statusMessage` if a run is ever stopped by its `maxTotalChargeUsd` cap (the exact wording is unverified; see "Run lifecycle")
9. If the build API is ever inaccessible, export the build's input schema from the Apify console and run `apify import-schema <file> --build <n>`. Add `--attest` only if you exported it from exactly that build.

## Integration notes

These are for the integration phase.

- The LLM classifier uses the prompt template `prompts/research.reddit-signals.md` (variable `allowedTypes`, output `{items:[{id, signalType|null}]}`) and is wired only by `apify research --classify-with-llm`.
- The content pipeline (section 20) reads `content_signals WHERE origin = 'apify_reddit'`. It should exclude `is_synthetic = 1` rows from real recommendations.
- Doctor/status should call `apifyStatus(ctx, {network})`.
- Workflows should call `resumeApifyRuns(ctx)` on startup or crash recovery, before scheduling new research.

## Tests

- `tests/unit/apify/*` covers the client, input schema, adapter, pricing and normalization.
- `tests/integration/apify/*` covers inspect, import-schema, runs, status and the CLI.
- The fixtures are synthetic and labeled: `tests/fixtures/apify/*.json`, plus `fake-apify.ts`, an in-memory fake of the Apify routes above (it stores each run's `INPUT` record and can reject an unknown token with 401 `invalid-token`). Links in the dataset fixture use the reserved domain `reddit.example.test`, never `reddit.com`.
- Section-31 failure modes covered: a SUCCEEDED run stopped by the cap, RUN-SUMMARY failed requests, empty or contradictory usage figures, the time-range ceiling, URL inputs, a matching-input run owned by another site, a same-length foreign run with a different or missing `INPUT`, competing ambiguous claimants, owner confirmation, the cap binding of `apify test`, and a rejected token.
