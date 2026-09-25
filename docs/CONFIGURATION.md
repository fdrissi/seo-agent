# Configuration

seo-agent is configured per site with a validated YAML file in your private
workspace, plus environment variables for secrets and a few non-secret
endpoints. Nothing owner-specific (domains, event names, locations,
languages, budgets, prices, model IDs) is hardcoded in the application; it all
lives here.

- Site configuration: `<workspace>/config/sites/<site-id>.yaml`
  (see [WORKSPACE.md](WORKSPACE.md) for the workspace itself).
- Secrets: the process environment or `<workspace>/secrets/secrets.env`
  (mode 0600). Never in the site config, the vault, reports, or chat.
- Synthetic starting point: [`config/sites/example.site.yaml`](../config/sites/example.site.yaml).

Useful commands:

| Command | What it does |
| --- | --- |
| `npm run cli -- config validate` | Validate every site in the workspace (or `--site <id>`); prints field errors and non-fatal warnings. Exit code 1 when any site is invalid. |
| `npm run cli -- config validate --file <path>` | Validate one YAML file anywhere (no workspace needed). |
| `npm run cli -- config show` | Effective non-secret settings and where each value comes from (values of secrets are never shown). In `--json` output `env` is a list of `{ name, source, isSecret, isSet }` records, so every status stays machine-readable. |
| `npm run cli -- config schema` | JSON Schema of the site configuration (for editors and tooling). |
| `npm run cli -- config docs` | Regenerate the reference tables in this document. |

All commands accept `--json` for machine-readable output.

## Override precedence

Highest first:

1. **CLI flags** for the current command (for example `--workspace`, `--site`,
   `--dry-run`, `--offline`, `--mode`).
2. **Environment variables**: the process environment first (for example
   injected by a password manager: `op run -- npm run cli -- <command>`), then
   `<workspace>/secrets/secrets.env`. An empty variable (`CHEAP_MODEL=`) counts
   as unset and does not hide a lower layer.
3. **Site configuration** (`config/sites/<site-id>.yaml`), validated by
   `src/config/site-schema.ts`.
4. **Built-in defaults**: schema defaults, and profile defaults for feature
   flags (`src/config/profiles.ts`).

Concrete cases:

| Setting | Resolution |
| --- | --- |
| Workspace directory | `--workspace` > `SEO_AGENT_WORKSPACE` > `~/seo-agent-workspace`. Only `~` and `~/...` are expanded. |
| Site | `--site` > the only site in the workspace (an error asks for `--site` when there are several). |
| Model IDs | `CHEAP_MODEL` / `REASONING_MODEL` / `EMBEDDING_MODEL` > `models.*` > unset (AI features then report "not configured"; no model is ever guessed). `config show` prints the source of each. |
| Apify actor | `APIFY_CONTENT_ACTOR_ID` only when explicitly set in the environment or secrets file > `research.apify.actorId`. The built-in default never overrides a configured value. `APIFY_CONTENT_ACTOR_BUILD` > `research.apify.build`. |
| Feature flags | `features.<flag>` when set > the profile default. An enabled flag still needs credentials; without them the integration reports `missing_credentials` instead of pretending to work. |
| Budget time zone | `reporting.businessTimezone` > `scheduler.timezone`. |

Public per-site IDs, paths, budgets, caps, and feature flags belong in the
site configuration, not in environment variables.

## Environment variables

Secret values are registered for redaction as soon as they are loaded, so they
are masked in logs, reports, raw responses, audit events, and CLI output.
`secrets.env` uses dotenv syntax: `KEY=value`, optional `export`, `#` comments,
single quotes (literal) or double quotes (escapes `\n`, `\r`, `\t`, `\"`, `\\`).
When the setup wizard stores a value, only that key's line is rewritten (or
appended); comments, the template guidance, and every other line are kept
verbatim, and the file is replaced atomically with mode 0600.
There is no variable expansion and no command substitution; multi-line values
are not supported (keep key files under `secrets/google/` and point to them).

<!-- BEGIN GENERATED: env (npm run cli -- config docs) -->

| Variable | Secret | Default | Purpose |
| --- | --- | --- | --- |
| `LLM_GATEWAY_API_KEY` | yes | - | LLM Gateway API key (chat and embeddings). |
| `LLM_GATEWAY_BASE_URL` | no | `https://api.llmgateway.io/v1` | OpenAI-compatible LLM Gateway base URL. |
| `CHEAP_MODEL` | no | - | Overrides `models.cheap` (extraction/classification model ID). |
| `REASONING_MODEL` | no | - | Overrides `models.reasoning` (synthesis/prioritization model ID). |
| `EMBEDDING_MODEL` | no | - | Overrides `models.embedding`. |
| `GOOGLE_AUTH_MODE` | no | `oauth` | `oauth` (desktop loopback flow) or `service_account`. |
| `GOOGLE_OAUTH_CLIENT_FILE` | no | - | Path to the OAuth desktop client JSON (keep it under `secrets/google/`). |
| `GOOGLE_TOKEN_FILE` | no | - | Path to the stored OAuth token file (keep it under `secrets/google/`). |
| `GOOGLE_APPLICATION_CREDENTIALS` | no | - | Path to a service-account key file (service_account mode). |
| `DATAFORSEO_LOGIN` | yes | - | DataForSEO API login (account identifier). The Basic authorization header built from it is always redacted. |
| `DATAFORSEO_PASSWORD` | yes | - | DataForSEO API password. |
| `APIFY_TOKEN` | yes | - | Apify API token. |
| `APIFY_CONTENT_ACTOR_ID` | no | `9sHOY9RzPYGjmTHo8` | Overrides `research.apify.actorId` only when explicitly set. |
| `APIFY_CONTENT_ACTOR_BUILD` | no | - | Overrides `research.apify.build` (pinned, verified build). |
| `QDRANT_URL` | no | `http://127.0.0.1:6333` | Local Qdrant endpoint. |
| `QDRANT_API_KEY` | yes | - | Qdrant API key, when Qdrant is protected. |
| `PAGESPEED_API_KEY` | yes | - | PageSpeed Insights / CrUX API key. |
| `SEO_AGENT_WORKSPACE` | no | - | Private workspace directory (overridden by `--workspace`). |
| `SEO_AGENT_LOG_LEVEL` | no | - | `debug`, `info` (default), `warn`, or `error`. Unknown values fall back to `info`. |
| `GSC_BASE_URL` | no | - | Optional Search Console API host: `https://searchconsole.googleapis.com` (used when unset) or `https://www.googleapis.com`. Any other value is refused. |

<!-- END GENERATED: env -->

The application warns (without printing values) when `secrets.env` or the
`secrets/` directory is readable by other users, and prints the `chmod`
command that fixes it. When the application itself stores a secret (for
example the setup wizard's hidden prompts), the secret store replaces
`secrets.env` atomically (write a new 0600 file, then rename) and keeps every
other entry.

## Setup profiles

`profile` selects defaults for the feature flags. Explicit `features.<flag>`
values always win.

- **demo**: offline, synthetic fixtures only; no credentials and no paid or
  network requests. Use a separate demo workspace.
- **core**: Google data ingestion, crawling, SQLite, and Markdown reporting.
  AI analysis runs when a model connection is configured.
- **full**: the complete stack (LLM Gateway, Qdrant, Obsidian-compatible
  memory, DataForSEO, Apify, performance checks).

Paid add-ons (AI citations, DataForSEO backlinks, Labs exports, AI visibility)
are off in every profile until you enable them explicitly.

<!-- BEGIN GENERATED: profiles (npm run cli -- config docs) -->

| Feature | demo | core | full | What it enables |
| --- | --- | --- | --- | --- |
| `gsc` | on | on | on | Google Search Console ingestion (read-only). |
| `ga4` | on | on | on | Google Analytics 4 Data API ingestion (read-only). |
| `crawl` | on | on | on | Direct HTTP crawl of the own site (robots.txt respected, SSRF-safe). |
| `playwright` | off | off | on | Optional browser rendering when direct HTML is insufficient (requires Playwright to be installed). |
| `pagespeed` | on | off | on | PageSpeed Insights (lab) and CrUX (field) performance checks. |
| `urlInspection` | on | off | on | Search Console URL Inspection for a bounded number of URLs per run. |
| `llm` | on | on | on | LLM Gateway analysis. Effective only when a model connection is configured. |
| `embeddings` | on | off | on | Embedding calls for vector memory (billed against the LLM Gateway budget). |
| `qdrant` | off | off | on | Qdrant vector index (rebuildable; full-text fallback when disabled or down). |
| `obsidian` | on | on | on | Obsidian-compatible Markdown vault output (works without launching Obsidian). |
| `dataforseo` | on | off | on | DataForSEO research requests (budgeted; mode set in research.dataforseo.mode). |
| `apify` | on | off | on | Apify content-research actor runs (budgeted; pinned build required). |
| `contentDiscovery` | on | off | on | Content discovery/research queue (never drafts or publishes automatically). |
| `aiCitations` | off | off | off | Optional AI-search citation checks. Off in every profile until explicitly enabled. |
| `dataforseoBacklinks` | off | off | off | Paid DataForSEO backlinks add-on. Off until explicitly approved. |
| `dataforseoLabsExports` | off | off | off | Paid DataForSEO Labs exports. Off until explicitly approved. |
| `dataforseoAiVisibility` | off | off | off | Paid DataForSEO AI-visibility add-on. Off until explicitly approved. |

<!-- END GENERATED: profiles -->

## Budgets

Budgets are **configured spending ceilings, not price quotes** and not a
promise that a workload fits. Subscriptions, infrastructure, taxes,
deposits/minimum commitments, and one-time costs are reported separately and
are not covered by these ceilings. Nothing is ever topped up, upgraded, or
increased automatically.

Amounts are decimal USD strings (`"5.00"`, at most 6 fractional digits). Plain
YAML numbers (`5`, `0.25`) are accepted and converted to the same exact
decimal; exponents, negative values, and amounts above one billion
(`1000000000`, a sanity ceiling that keeps sums exact) are rejected with the
field path. Internally every amount
is an integer number of micro-USD (1 USD = 1,000,000), so no floating-point
comparison ever decides whether a request fits.

Starting defaults per site (spec section 25): LLM Gateway $5/month (including
embeddings), DataForSEO $1/week and $10/month, Apify $10/month, combined
variable API ceiling $25/month. PageSpeed defaults to $0 (the API is normally
free; a $0 ceiling admits only zero-cost requests).

### Scopes checked on every paid request

Before a paid request the caller estimates a conservative **upper bound**
(maximum output/reasoning tokens, per-task price, actor charge cap) and
**reserves** it. A reservation succeeds only when every applicable scope has
room for it:

| Scope | Limit | Counted reservations |
| --- | --- | --- |
| `run` | `budgets.<service>.perRunUsd` | same site, service, and run (job) id |
| `site_service_month` | `budgets.<service>.monthlyUsd` | same site and service, calendar month |
| `site_service_week` | `budgets.dataforseo.weeklyUsd` | same site, DataForSEO, ISO week |
| `site_combined_month` | `budgets.combinedMonthlyUsd` | same site, all services, calendar month |
| `account_service_month` | the **smallest** `budgets.accountMonthlyUsd.<provider>` declared by any site in the workspace | all sites in the workspace database for that provider (shared account limits) |

Provider keys for `accountMonthlyUsd` are `llm_gateway`, `dataforseo`,
`apify`, and `pagespeed`.

Shared account caps are **workspace-wide**. A provider account is shared by
every site that uses the same credentials, so the cap that applies to a
reservation is the smallest value declared by the reserving site's own config
or by the active recorded configuration of any other site registered in the
workspace database. A site that declares no cap (or a larger one) is still
bound by it. `config validate` warns every site when sites disagree, and when
sites that share account caps use different budget time zones: the account
month is counted per reservation in the reserving site's zone, so near a month
boundary two sites may disagree about which month a charge belongs to. Use
one budget time zone for sites that share a provider account.

Months and ISO weeks are computed in the **budget time zone**
(`reporting.businessTimezone`, else `scheduler.timezone`), so a monthly cap
resets at local midnight, including across daylight-saving changes.

The check and the insert happen in one `BEGIN IMMEDIATE` SQLite transaction:
parallel workers, separate CLI processes, and scheduled jobs cannot both pass
the same check and overspend (covered by
`tests/integration/budgets/parallel-reservations.test.ts`). Denials are
recorded in the append-only audit log (`budget.denied`) and the command exits
with code 3.

### Unknown prices, reconciliation, and what counts

- **Unknown price**: when no safe upper bound exists (no verified price in
  `research.dataforseo.pricingOverrides` / `llm.pricingOverrides`, no
  provider-reported price), the request is refused with `BUDGET_UNKNOWN_PRICE`
  unless it carries a specific human approval. An approved unknown-price
  reservation is recorded with cost status `unknown` (counted in the unknown
  charges), never as an ordinary estimate and never as $0:
  - **With an approved maximum charge** (the LLM Gateway's
    `unknownPriceMaxChargeMicros`, DataForSEO's provisional hold): that amount
    is reserved against every scope like any other reservation, until
    reconciled.
  - **With no upper bound at all**: the amount cannot be counted, so it is
    accepted only while every scope still has room (a spent cap stays closed)
    and no other unbounded charge is outstanding in the same scope. While it is
    outstanding, the affected limits cannot be verified: further reservations
    in those scopes (including other services under the combined ceiling) need
    their own explicit approval, and `costs` shows the remaining budget as
    "at most ... (unverified)" (`remainingVerified: false`,
    `unboundedUnknownCount` in JSON). Reconciling it restores normal checks.
- **Reconcile**: after the call, provider-reported (or usage-computed) cost
  replaces the estimate. Actual cost above the estimate is recorded truthfully
  as an overshoot and counts in full.
- **Unresolved**: when the provider does not report a charge, or a paid POST
  timed out after submission (ambiguous), the full estimate **stays reserved**
  until it is reconciled against provider history. Paid POSTs are never
  retried blindly.
- **Release**: only a reservation whose request was definitely never
  accepted (cache hit, validation failure before submission) can be released.

- **Integer micros only**: estimates and reconciled actual amounts must be
  non-negative integers of micro-USD (or `null` for an unknown actual);
  anything else is rejected before it is stored.

Committed spend per reservation: reserved or unresolved count their estimate
(the approved hold for an unknown price); reconciled counts the actual;
released counts nothing. `npm run cli -- costs` reports **actual**,
**reserved** (outstanding estimates and holds), **estimated** (reconciled
without an actual), and the **number of unknown charges** separately, plus
remaining budget per service, week, and combined. `costs --unresolved` lists
the open reservations with their cost status (amount known, held at an
approved maximum, or unbounded). The cost ledger holds one
entry per provider request (or per reservation when no request id exists), so
re-running reconciliation never double counts.

Application checks cannot guarantee zero overshoot when provider billing is
delayed. Where a provider offers key-level or run-level caps (for example an
LLM Gateway key budget, Apify `maxTotalChargeUsd`), set them as well.

## Validation rules

Errors (the config is rejected, with the field path):

- Required site identity: `site.id` (lowercase slug, 2-63 characters),
  `site.businessName`, `site.url` (absolute `http`/`https` URL),
  `site.allowedHostnames` (at least one).
- IANA time zone names only (`Europe/Tallinn`, `America/Los_Angeles`, `UTC`).
  Raw UTC offsets such as `+02:00` are rejected because they ignore daylight
  saving.
- Exact Google property formats: `sc-domain:example.com` or a URL-prefix
  property ending in `/`; numeric GA4 property ID (not the `G-` measurement ID).
- Numeric ranges and enums shown in the reference below; `schemaVersion` must
  be 1.
- Cross-field: `memory.chunkMinTokens <= chunkTargetTokens <= chunkMaxTokens`;
  `router.rankingPositionMin <= rankingPositionMax`;
  `crawl.competitorPagesPerQuery <= competitorPagesPerQueryMax`;
  `budgets.combinedMonthlyUsd` may not be zero while service budgets are
  positive.
- YAML is parsed with the YAML 1.2 core schema: custom or language tags
  (`!!js/function`, `!!binary`, `!custom`, ...) and duplicate keys are
  rejected, and alias expansion is bounded.

Warnings (`config validate` prints them; the config still loads):

- Unknown keys, which would otherwise be ignored silently (typos such as
  `featurs:`).
- `site.allowedHostnames` does not include the host of `site.url`, or lists a
  URL instead of a bare hostname.
- A per-run ceiling above the monthly ceiling, a DataForSEO weekly ceiling
  above its monthly ceiling, a combined ceiling above the sum of service
  ceilings, or an unknown provider key in `accountMonthlyUsd`.
- Workspace-wide: sites that declare different `accountMonthlyUsd` values for
  the same provider (the smallest applies to all of them), or sites sharing
  account caps with different budget time zones.
- `memory.chunkOverlapTokens` not smaller than `chunkTargetTokens`, and a
  low-traffic observation window shorter than the default window.

## Minimal configuration

```yaml
# <workspace>/config/sites/example-site.yaml  (synthetic example)
site:
  id: example-site
  businessName: Example Analytics Co
  url: https://www.example.com/
  allowedHostnames: [www.example.com]
```

Everything else takes the documented defaults below. Unknown business facts,
conversion values, prices, and targets stay `null` or empty; the application
never invents them.

## Field reference

Generated from the schema descriptions in `src/config/site-schema.ts`.
"required" inside a list item or optional object means required within that
item. A test (`tests/unit/config/configuration-doc.test.ts`) fails when this
reference drifts from the schema; regenerate it with
`npm run cli -- config docs`.

<!-- BEGIN GENERATED: fields (npm run cli -- config docs) -->

### Top-level fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `schemaVersion` | 1 | `1` | Site configuration format version. Currently 1. |
| `profile` | "demo" \| "core" \| "full" | `"core"` | Setup profile: demo (fixtures only), core (Google + crawl + SQLite + Markdown), full (all integrations). |

### `site`

Website identity. Required.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `site.id` | string | **required** | Stable site identifier used in every database row, job, budget, and vector. |
| `site.businessName` | string | **required** | Business or brand name shown in reports. |
| `site.url` | string | **required** | Canonical site URL including scheme, e.g. "https://www.example.com/". |
| `site.allowedHostnames` | list of string | **required** | Hostnames treated as this site. www/non-www are NOT merged automatically. |
| `site.urlAliases` | list of objects | `[]` | Known URL aliases with the evidence establishing equivalence. |
| `site.urlAliases[].alias` | string | **required** | Alias URL (as reported by a data source). |
| `site.urlAliases[].canonical` | string | **required** | Canonical URL the alias is equivalent to. |
| `site.urlAliases[].evidence` | string or null | `null` | Evidence establishing the equivalence (redirect, canonical tag, owner statement). |
| `site.pageTypes` | list of objects | `[]` | Owner-declared page types by URL path (first matching rule wins). Empty by default. |
| `site.pageTypes[].match` | string | **required** | URL-path glob matched against the normalized path; "*" is a wildcard, e.g. "/products/*". First matching rule wins. |
| `site.pageTypes[].type` | string | **required** | Page type assigned to matching pages, e.g. "product", "offer", "category", "tool", "article". |

### `business`

Business facts used for relevance and drafting. Unknown facts stay null/empty.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `business.offer` | string or null | `null` | What the business sells or offers. Null when not yet provided. |
| `business.targetCustomer` | string or null | `null` | Who the offer is for. Null when not yet provided. |
| `business.differentiators` | list of string | `[]` | Real, verifiable differentiators. Never invented. |
| `business.productFacts` | list of objects | `[]` | Verified product facts that drafts may cite. |
| `business.productFacts[].id` | string | **required** | Stable identifier used to cite this fact from briefs and drafts. |
| `business.productFacts[].statement` | string | **required** | The verified product fact, stated plainly. |
| `business.productFacts[].source` | string or null | `null` | Where this fact is verified (URL, document, or "owner"). |
| `business.productFacts[].verifiedAt` | string or null | `null` | When the fact was last verified (YYYY-MM-DD). Null when never verified. |
| `business.approvedClaims` | list of string | `[]` | Marketing claims the owner has approved for use. |
| `business.prohibitedClaims` | list of string | `[]` | Claims that must never appear in drafts or recommendations. |

### `market`

Target market. Never inferred from the scheduler time zone.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `market.countries` | list of string | `[]` | Target countries (ISO 3166-1 alpha-2 or alpha-3). |
| `market.languages` | list of string | `[]` | Content/target languages (BCP 47). |
| `market.searchLocations` | list of objects | `[]` | Search locations used for external research requests. |
| `market.searchLocations[].name` | string or null | `null` | Human label, e.g. "Estonia". |
| `market.searchLocations[].locationCode` | number or null | `null` | Provider location code (resolved during setup; never guessed). |
| `market.searchLocations[].languageCode` | string | **required** | Language code for research requests, e.g. "et" or "en". |
| `market.devices` | list of "desktop" \| "mobile" \| "tablet" | `["desktop","mobile"]` | Devices considered for research and reporting. |

### `reporting`

Reporting preferences. The business time zone (or the scheduler zone when null) also defines budget periods.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `reporting.currency` | string or null | `null` | Reporting currency (ISO 4217). Unknown stays null. |
| `reporting.businessTimezone` | string or null | `null` | Business timezone for reports. Not inferred from the scheduler timezone. |

### `scheduler`

Local/server scheduling preferences. IANA time zones only; DST is handled by the scheduler.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `scheduler.timezone` | string | `"Europe/Tallinn"` | Scheduler timezone. Does NOT imply the website's target market. |
| `scheduler.weekly` | object | - | Weekly job schedule. |
| `scheduler.weekly.enabled` | boolean | `false` | Run the weekly job on schedule (installation is opt-in). |
| `scheduler.weekly.cron` | string | `"0 7 * * 1"` | Cron expression evaluated in scheduler.timezone. |
| `scheduler.monthly` | object | - | Monthly job schedule. |
| `scheduler.monthly.enabled` | boolean | `false` | Run the monthly job on schedule (installation is opt-in). |
| `scheduler.monthly.cron` | string | `"0 8 2 * *"` | Cron expression evaluated in scheduler.timezone. |

### `google`

Google data sources. Credentials live in the secret store, never here.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `google.searchConsoleProperty` | string or null | `null` | Exact Search Console property, discovered via `auth status`; never constructed by guessing. |
| `google.ga4PropertyId` | string or null | `null` | Numeric GA4 property ID (not the "G-" measurement ID). |
| `google.gsc` | object | - | Search Console ingestion limits. |
| `google.gsc.initialHistoryDays` | number | `90` | Days of history fetched on the first sync. |
| `google.gsc.refreshRecentDays` | number | `10` | Recent days re-fetched on each sync to capture revisions. |
| `google.gsc.searchTypes` | list of "web" \| "image" \| "video" \| "news" \| "discover" \| "googleNews" | `["web"]` | Search types synced. Each is a separate dataset. |
| `google.gsc.pageQueryTopPages` | number | `50` | Targeted page/query detail is fetched only for this many top pages. |
| `google.gsc.urlInspectionMaxPerRun` | number | `20` | Maximum URL Inspection requests per run. |
| `google.ga4` | object | - | GA4 ingestion limits. |
| `google.ga4.initialHistoryDays` | number | `90` | Days of history fetched on the first sync. |
| `google.ga4.refreshRecentDays` | number | `4` | Recent days re-fetched on each sync to capture revisions. |

### `conversions`

Conversion definitions. Event names are exact and case-sensitive.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `conversions.primaryEvents` | list of objects | `[]` | Primary conversion events (the business outcomes that count). |
| `conversions.primaryEvents[].name` | string | **required** | Exact GA4 event name, e.g. "generate_lead". Case-sensitive. |
| `conversions.primaryEvents[].meaning` | string | **required** | What this event means for the business, e.g. "Demo request form submitted". |
| `conversions.primaryEvents[].kind` | "purchase" \| "lead" \| "signup" \| "booking" \| "subscription" \| "other" | `"other"` | Business outcome category of the event. |
| `conversions.primaryEvents[].value` | object or null | - | Configured business value per conversion when known. Leave null when unknown; never guessed. |
| `conversions.primaryEvents[].value.amount` | string | **required** | Configured value per conversion as a decimal string, e.g. "120.00". |
| `conversions.primaryEvents[].value.currency` | string | **required** | ISO 4217 currency code of the configured value, e.g. "EUR". |
| `conversions.primaryEvents[].verifiedAt` | string or null | `null` | When the owner last verified that this event fires for the stated business outcome (YYYY-MM-DD). Null when never verified. |
| `conversions.primaryEvents[].verificationNote` | string or null | `null` | How the event was verified (e.g. "test submission seen in GA4 DebugView"). Null when not recorded. |
| `conversions.secondaryEvents` | list of objects | `[]` | Secondary events reported separately, never mixed into primary conversions. |
| `conversions.secondaryEvents[].name` | string | **required** | Exact GA4 event name, e.g. "generate_lead". Case-sensitive. |
| `conversions.secondaryEvents[].meaning` | string | **required** | What this event means for the business, e.g. "Demo request form submitted". |
| `conversions.secondaryEvents[].kind` | "purchase" \| "lead" \| "signup" \| "booking" \| "subscription" \| "other" | `"other"` | Business outcome category of the event. |
| `conversions.secondaryEvents[].value` | object or null | - | Configured business value per conversion when known. Leave null when unknown; never guessed. |
| `conversions.secondaryEvents[].value.amount` | string | **required** | Configured value per conversion as a decimal string, e.g. "120.00". |
| `conversions.secondaryEvents[].value.currency` | string | **required** | ISO 4217 currency code of the configured value, e.g. "EUR". |
| `conversions.secondaryEvents[].verifiedAt` | string or null | `null` | When the owner last verified that this event fires for the stated business outcome (YYYY-MM-DD). Null when never verified. |
| `conversions.secondaryEvents[].verificationNote` | string or null | `null` | How the event was verified (e.g. "test submission seen in GA4 DebugView"). Null when not recorded. |

### `brand`

Branded-query classification.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `brand.aliases` | list of string | `[]` | Brand spellings used to classify branded queries. |

### `crawl`

Crawler limits. The crawler is bounded and never fetches private network addresses.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `crawl.protectedPaths` | list of string | `[]` | Paths that must never be proposed for deletion, redirect, or noindex without explicit owner review. |
| `crawl.excludedPaths` | list of string | `[]` | Paths the crawler skips. |
| `crawl.maxPages` | number | `200` | Maximum pages fetched per own-site crawl. |
| `crawl.maxDepth` | number | `6` | Maximum link depth from the start URL. |
| `crawl.maxSitemapUrls` | number | `5000` | Maximum URLs read from sitemaps. |
| `crawl.maxSitemapFiles` | number | `20` | Maximum sitemap files fetched (including indexes). |
| `crawl.requestDelayMs` | number | `1000` | Delay between requests to the same host, in milliseconds. |
| `crawl.perHostConcurrency` | number | `2` | Concurrent requests per host. |
| `crawl.timeoutMs` | number | `15000` | Per-request timeout in milliseconds. |
| `crawl.maxBytes` | number | `5000000` | Maximum response body size in bytes. |
| `crawl.maxRedirects` | number | `5` | Maximum redirects followed (each hop is re-validated for SSRF). |
| `crawl.userAgent` | string | `"seo-agent/0.1 (+self-hosted; respects robots.txt)"` | User-Agent sent by the crawler. |
| `crawl.competitorPagesPerQuery` | number | `5` | Competitor pages crawled per shortlisted query. |
| `crawl.competitorPagesPerQueryMax` | number | `10` | Hard ceiling for competitorPagesPerQuery. |

### `research`

External research settings. Paid research is budgeted and limited to shortlisted opportunities.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `research.approvedDomains` | list of string | `[]` | Domains approved for research crawling beyond SERP competitors. |
| `research.competitors` | list of objects | `[]` | Known competitors. |
| `research.competitors[].domain` | string | **required** | Competitor domain, e.g. "competitor.example". |
| `research.competitors[].name` | string or null | `null` | Optional display name. |
| `research.seedTopics` | list of string | `[]` | Seed topics for content discovery. |
| `research.subreddits` | list of string | `[]` | Optional relevant subreddits for community research. |
| `research.seriousQueriesPerRun` | number | `3` | Shortlisted queries that may receive paid SERP research per run. The spec asks for 3-5; values above 5 are accepted (hard maximum 10) but produce a warning. |
| `research.dataforseo` | object | - | DataForSEO settings. |
| `research.dataforseo.mode` | "disabled" \| "sandbox" \| "live" | `"disabled"` | "sandbox" returns synthetic data that is never used in recommendations. |
| `research.dataforseo.queue` | "standard" \| "live" | `"standard"` | Prefer standard queued tasks; live only when latency justifies the cost. |
| `research.dataforseo.liveQueueJustification` | string or null | `null` | Why the more expensive live queue is needed (recorded with the decision). Null when not given; queue "live" without a justification produces a warning. |
| `research.dataforseo.serpDepth` | number | `10` | SERP results requested per query (billing may depend on depth). |
| `research.dataforseo.cacheDays` | object | - | Cache lifetimes that avoid repeat paid requests. |
| `research.dataforseo.cacheDays.serp` | number | `7` | Days a SERP snapshot is reused before a paid refresh. |
| `research.dataforseo.cacheDays.keywordVolume` | number | `30` | Days keyword volume data is reused. |
| `research.dataforseo.cacheDays.competitor` | number | `14` | Days crawled competitor pages and gated competitor-endpoint responses are reused before a refresh. Pages with a recently detected change are refreshed sooner. |
| `research.dataforseo.pricingOverrides` | map of string | `{}` | Verified per-task prices by endpoint key (USD). Without a verified price, paid calls require approval. |
| `research.apify` | object | - | Apify content-research actor settings. |
| `research.apify.actorId` | string | `"9sHOY9RzPYGjmTHo8"` | Authoritative Actor ID. Do not substitute another actor without approval. |
| `research.apify.build` | string or null | `null` | Pinned, verified build (tag or number). Null until verified via `apify inspect`. |
| `research.apify.maxItems` | number | `50` | Maximum dataset items per run. |
| `research.apify.maxCommentsPerPost` | number | `10` | Maximum comments collected per post. |
| `research.apify.timeRange` | "hour" \| "day" \| "week" \| "month" \| "year" \| "all" | `"month"` | Time range of collected posts. |
| `research.apify.maxRunSeconds` | number | `300` | Provider-side run timeout in seconds. |
| `research.apify.maxTotalChargeUsd` | string | `"1.00"` | Provider-side maximum total charge per run (USD), where the actor supports it. |
| `research.apify.memoryMbytes` | number | `512` | Run memory in MB (affects compute-unit and possibly start charges; 512 matches the actor default per docs/integration-contracts.md). |

### `editorial`

Editorial rules applied by quality gates.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `editorial.brandVoice` | string | `"Clear, direct, specific. Plain language. No hype."` | Brand voice guidance for drafts. |
| `editorial.requirements` | list of string | `[]` | Additional editorial requirements. |
| `editorial.avoidEmojis` | boolean | `true` | Drafts avoid emojis. |
| `editorial.avoidEmDashes` | boolean | `true` | Drafts avoid em dashes. |

### `models`

Model IDs. No model is hardcoded; unset means AI features report "not configured".

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `models.cheap` | string or null | `null` | Model ID for extraction/classification. Overridden by CHEAP_MODEL. |
| `models.reasoning` | string or null | `null` | Model ID for synthesis/prioritization. Overridden by REASONING_MODEL. |
| `models.embedding` | string or null | `null` | Embedding model ID. Overridden by EMBEDDING_MODEL. |
| `models.embeddingDimensions` | number or null | `null` | Verified embedding dimensions; discovered on first use when null. |

### `llm`

LLM call limits.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `llm.maxOutputTokensCheap` | number | `1500` | Output token ceiling for cheap-tier calls (bounds the cost estimate). |
| `llm.maxOutputTokensReasoning` | number | `6000` | Output token ceiling for reasoning-tier calls. |
| `llm.maxInputTokens` | number | `24000` | Input token ceiling per call (evidence is truncated with a recorded note). |
| `llm.maxRepairAttempts` | number | `2` | Bounded repair attempts for malformed structured output. |
| `llm.requestTimeoutMs` | number | `120000` | Per-request timeout in milliseconds. |
| `llm.allowPersonalData` | boolean | `false` | Whether evidence sent to the LLM Gateway may include personal data (names, emails, phone numbers, user handles). Default false. Setting it to true requires llm.personalDataReason. |
| `llm.personalDataReason` | string or null | `null` | Why personal data may be sent to the LLM Gateway (required when llm.allowPersonalData is true; echoed in warnings). |
| `llm.pricingOverrides` | map of object | `{}` | Verified per-model prices when the gateway does not report them. |
| `llm.pricingOverrides.<key>.inputPerMillionUsd` | string | **required** | Verified USD price per 1M input tokens. |
| `llm.pricingOverrides.<key>.outputPerMillionUsd` | string | **required** | Verified USD price per 1M output tokens. |

### `memory`

Vector memory and retrieval settings.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `memory.chunkMinTokens` | number | `400` | Minimum chunk size in tokens. |
| `memory.chunkTargetTokens` | number | `600` | Target chunk size in tokens. |
| `memory.chunkMaxTokens` | number | `800` | Maximum chunk size in tokens. |
| `memory.chunkOverlapTokens` | number | `60` | Overlap between consecutive chunks in tokens. |
| `memory.contextBudgetTokens` | number | `6000` | Token budget for retrieved memory in one prompt. |
| `memory.qdrantCollectionPrefix` | string | `"seo_agent"` | Prefix for Qdrant collection names. |

### `budgets`

Configured spending ceilings, not price quotes. No automatic top-ups or increases.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `budgets.llmGateway` | object | - | LLM Gateway budget. |
| `budgets.llmGateway.monthlyUsd` | string | `"5.00"` | Monthly ceiling for LLM Gateway calls, including embeddings. |
| `budgets.llmGateway.perRunUsd` | string | `"0.50"` | Ceiling per run (job) for LLM Gateway calls. |
| `budgets.dataforseo` | object | - | DataForSEO budget. |
| `budgets.dataforseo.weeklyUsd` | string | `"1.00"` | Weekly ceiling (ISO week in the budget time zone). |
| `budgets.dataforseo.monthlyUsd` | string | `"10.00"` | Monthly ceiling. |
| `budgets.dataforseo.perRunUsd` | string | `"0.50"` | Ceiling per run (job). |
| `budgets.apify` | object | - | Apify budget. |
| `budgets.apify.monthlyUsd` | string | `"10.00"` | Monthly ceiling for Apify actor runs. |
| `budgets.apify.perRunUsd` | string | `"1.00"` | Ceiling per run (job). |
| `budgets.pagespeed` | object | - | PageSpeed budget. |
| `budgets.pagespeed.monthlyUsd` | string | `"0.00"` | Monthly ceiling (PageSpeed Insights is normally free; keep 0 unless a paid quota applies). |
| `budgets.pagespeed.perRunUsd` | string | `"0.00"` | Ceiling per run (job). |
| `budgets.combinedMonthlyUsd` | string | `"25.00"` | Combined variable API ceiling for this site. |
| `budgets.accountMonthlyUsd` | map of string | `{}` | Shared provider-account ceilings across all sites in this workspace, keyed by provider. |

### `features`

Explicit feature flags. Unset flags inherit from the setup profile. Integrations also require credentials.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `features.gsc` | boolean | profile default | Google Search Console ingestion (read-only). |
| `features.ga4` | boolean | profile default | Google Analytics 4 Data API ingestion (read-only). |
| `features.crawl` | boolean | profile default | Direct HTTP crawl of the own site (robots.txt respected, SSRF-safe). |
| `features.playwright` | boolean | profile default | Optional browser rendering when direct HTML is insufficient (requires Playwright to be installed). |
| `features.pagespeed` | boolean | profile default | PageSpeed Insights (lab) and CrUX (field) performance checks. |
| `features.urlInspection` | boolean | profile default | Search Console URL Inspection for a bounded number of URLs per run. |
| `features.llm` | boolean | profile default | LLM Gateway analysis. Effective only when a model connection is configured. |
| `features.embeddings` | boolean | profile default | Embedding calls for vector memory (billed against the LLM Gateway budget). |
| `features.qdrant` | boolean | profile default | Qdrant vector index (rebuildable; full-text fallback when disabled or down). |
| `features.obsidian` | boolean | profile default | Obsidian-compatible Markdown vault output (works without launching Obsidian). |
| `features.dataforseo` | boolean | profile default | DataForSEO research requests (budgeted; mode set in research.dataforseo.mode). |
| `features.apify` | boolean | profile default | Apify content-research actor runs (budgeted; pinned build required). |
| `features.contentDiscovery` | boolean | profile default | Content discovery/research queue (never drafts or publishes automatically). |
| `features.aiCitations` | boolean | profile default | Optional AI-search citation checks. Off in every profile until explicitly enabled. |
| `features.dataforseoBacklinks` | boolean | profile default | Paid DataForSEO backlinks add-on. Off until explicitly approved. |
| `features.dataforseoLabsExports` | boolean | profile default | Paid DataForSEO Labs exports. Off until explicitly approved. |
| `features.dataforseoAiVisibility` | boolean | profile default | Paid DataForSEO AI-visibility add-on. Off until explicitly approved. |

### `content`

Content pipeline limits. Nothing is published automatically.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `content.maxInProduction` | number | `1` | Maximum content pieces in production at once. |
| `content.batchEnabled` | boolean | `false` | Allow approved batch drafting (bounded parallel). |
| `content.pilotApproved` | boolean | `false` | Owner approved the content pilot; required before batch drafting. |
| `content.maxAutomatedRevisions` | number | `2` | Automated revision rounds before a human must review. |

### `experiments`

Experiment evaluation thresholds.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `experiments.defaultMinObservationDays` | number | `28` | Minimum observation window before evaluating an experiment. |
| `experiments.lowTrafficMinObservationDays` | number | `56` | Minimum observation window for low-traffic pages. |
| `experiments.minImpressionsForEvaluation` | number | `500` | Impressions required before search outcomes are evaluated. |
| `experiments.minSessionsForConversionEvaluation` | number | `200` | Sessions required before conversion outcomes are evaluated. |

### `router`

Deterministic router thresholds.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `router.rankingPositionMin` | number | `4` | Lower bound of the "striking distance" average position band. |
| `router.rankingPositionMax` | number | `20` | Upper bound of the "striking distance" average position band. |
| `router.minImpressionsForOpportunity` | number | `100` | Impressions required before a page/query is an opportunity. |
| `router.lowDataSiteMaxImpressions` | number | `500` | Sites below this 28-day impression total take the low-data bootstrap route. |
| `router.declineThresholdPct` | number | `25` | Percent decline that routes a page to the decline review. |
| `router.healthyCtrRatio` | number | `0.8` | Observed/expected CTR ratio at or above which a page counts as healthy. |
| `router.commercialPageTypes` | list of string | `["offer","product","category","tool"]` | Page types (see site.pageTypes) treated as commercial for conversion routing and scoring. |
| `router.conversionPoorRatio` | number | `0.5` | A commercial page whose conversion rate is below this share of the site rate routes to conversion review (0-1). |
| `router.notSetShareMax` | number | `0.2` | Maximum share of GA4 sessions with landing page "(not set)" before page-level conversion routing is treated as unreliable (0-1). |
| `router.requireConversionDefinition` | boolean | `true` | Conversion routes require at least one configured primary conversion event; without one the router reports data unavailable instead. |
| `router.minClicksForJoinCheck` | number | `20` | Search Console clicks a page needs before a missing GA4 landing-page join is treated as a data problem. |
| `router.minPreviousConversionsForDecline` | number | `5` | Conversions required in the previous period before a conversion decline is routed. |
| `router.ruleOrder` | list of "invalid_data" \| "technical_blocker" \| "experiment_active" \| "healthy" \| "ranking" \| "ctr" \| "conversion" \| "decline" \| "content" \| "indexing_unknown" \| "low_data" \| "irrelevant" or null | `null` | Optional evaluation order of the router rules (each at most once). Null uses the built-in order. |

<!-- END GENERATED: fields -->
