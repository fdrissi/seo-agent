# Google: authentication, Search Console, and GA4 ingestion

Status (2026-09-25): implemented and tested **offline** against synthetic fixtures and
recorded-shape responses. **Nothing in this module has been tested live against a real
Google account.** The first live run needs your own Google Cloud project, OAuth client or
service account, and property access (see "Access setup" below).

Code: `src/auth/**`, `src/integrations/google/**`, `src/cli/commands/auth.ts`,
`src/cli/commands/sync.ts`. Tests: `tests/{unit,integration}/{auth,google}/**`.
Synthetic fixtures: `tests/fixtures/google/**`. API contracts: `docs/integration-contracts.md`
sections 2 (Search Console), 3 (GA4 Data API), and 4 (OAuth / google-auth-library).

## Commands

```bash
npm run cli -- auth google            # guided OAuth desktop flow (browser + 127.0.0.1 loopback, PKCE)
npm run cli -- auth status            # mode, credential/token presence and expiry hints, properties, GA4 access
npm run cli -- auth status --no-network
npm run cli -- auth diagnose          # permission diagnostics + least-privilege guidance (exit 1 on errors)
npm run cli -- auth revoke            # revoke at Google and delete the local token (--local-only to skip Google)

npm run cli -- sync gsc               # 90 days initially, then incremental refresh plus backfill of uncollected dates
npm run cli -- sync gsc --days 28 --segments country,device --top-pages 20 --inspect 5
npm run cli -- sync ga4               # landing pages (google_organic, all_organic), events, period metrics
npm run cli -- sync ga4 --checklist   # manual conversion-verification checklist (no request)
npm run cli -- sync ga4 --confirm-rate-scale fraction|percent --evidence "<what you compared>" --as "<your name>"
                                      # record the key-event rate scale (audited; no request)
npm run cli -- sync inspect [urls...] # URL Inspection (indexed state, not a live test); exit 2 when nothing was inspected
```

All commands accept the global `--site`, `--json`, `--dry-run`, and `--offline` options.
`--dry-run` makes no Google request and writes nothing; it prints the planned date ranges,
datasets, and a minimum request count. It first checks, without a network call, that the
auth provider's credential resolves (`src/integrations/google/credentials-check.ts`): the
OAuth client file and stored token, or the service-account key file. A missing credential
fails the dry run exactly like the real run (`CREDENTIALS_MISSING`, same hint, exit 3), so
a dry run never shows a plan that the real sync cannot execute, and the optional
`sync_gsc`/`sync_ga4` stages of a pipeline dry run fail with that code instead of a bare
`succeeded`. The plan's `credentialCheck` says `ok` (resolved locally; property access is
still only verified by the real run), `fixture` (synthetic demo provider), or `unverified`
(Application Default Credentials from a metadata server, which only the real run can
resolve; also a warning). Google reads are free (quota-limited): no budget reservation is
made, and every request is still logged in `provider_requests` with `is_paid = 0`.

## Design

### Authentication (`src/auth`)

- **OAuth desktop flow** (`oauth-flow.ts`, `loopback.ts`) follows the installed-app guidance
  [OA1] and the official PKCE sample [OA26]:
  - A one-shot HTTP listener binds **only to `127.0.0.1`** on an ephemeral port; the redirect URI
    is `http://127.0.0.1:<port>` with no path. It accepts exactly one callback, then closes; it
    also closes on timeout (default 300 s). Other paths get 404, unexpected `Host` headers get 400
    (DNS-rebinding guard), and later requests get 410.
  - `state` is 32 random bytes (base64url) compared in constant time. A mismatch rejects the
    callback and aborts the flow (fail closed).
  - PKCE S256 via `OAuth2Client.generateCodeVerifierAsync()` [OA23].
  - `access_type=offline`, `prompt=consent`, and **only** `webmasters.readonly` and
    `analytics.readonly`. No `include_granted_scopes` (not supported for installed apps [OA1]).
  - The owner opens the printed URL in a browser. Nobody is asked to paste an authorization code
    or token anywhere; the redirect delivers the code to the listener.
  - Granted scopes are compared to the requested ones; a missing scope is reported.
- **OAuth client file**: `GOOGLE_OAUTH_CLIENT_FILE` or `<workspace>/secrets/google/oauth-client.json`.
  Only a Desktop client (top-level `installed` key) is accepted; a `web` client or a
  service-account key is rejected with the fix. The top-level key was not verified in primary
  docs [OA contract "Unverified"], so the check fails closed with a clear message.
- **Token storage** (`token-store.ts`): `GOOGLE_TOKEN_FILE` or
  `<workspace>/secrets/google/token.json`. Atomic writes (temp file in the same directory, fsync,
  rename), file mode 0600, the default directory is kept at 0700. Refreshed tokens are persisted
  from the library's `'tokens'` event; the stored refresh token is kept because the refresh-path
  event usually lacks it [OA25]. Token values are registered with the redactor when loaded and are
  never returned by `auth status` (only presence, expiry time, scopes, age, and hints).
- Credential files inside the vault or inside the application repository are refused.
- **Service accounts** (`GOOGLE_AUTH_MODE=service_account`):
  - `GOOGLE_APPLICATION_CREDENTIALS` with `type: service_account`: the JSON is validated and a
    `JWT` client is built directly (the contract's "safer path"; `GoogleAuth({keyFile})` is
    deprecated because it does not validate the credential type [OA24]).
  - `type: external_account` (workload identity federation): `ExternalAccountClient.fromJSON`.
    The service-account email is read from `service_account_impersonation_url` so status can
    tell you which identity to grant.
  - No file: Application Default Credentials via `GoogleAuth` (attached service account on
    Google Cloud, workload identity). The ADC chain is resolved in `getClient()` **before any
    token request**, and the credential type google-auth-library actually loaded is checked.
    User credentials (`authorized_user`, for example the file written by
    `gcloud auth application-default login`, and `external_account_authorized_user`) are refused
    with `CONFIG_INVALID` pointing to `GOOGLE_AUTH_MODE=oauth`, so the owner's personal identity
    (often carrying the broad `cloud-platform` scope) is never used silently. Accepted:
    `service_account`, `external_account`, `impersonated_service_account`, and the metadata
    server (`gce_metadata`). `auth status` inspects the ADC source offline (process-environment
    `GOOGLE_APPLICATION_CREDENTIALS`, then gcloud's `application_default_credentials.json` under
    `CLOUDSDK_CONFIG` or `~/.config/gcloud`, then the metadata server) and, after a network check,
    reports the resolved credential type and service-account email.
  - No domain-wide delegation and no Google Cloud project-owner role is used or needed.
- **Fixture mode** is used automatically for the `demo` profile and only there.
  `GOOGLE_AUTH_MODE=fixture` in a non-demo site is refused so synthetic data cannot mix with live
  reporting.
- Every google-auth-library HTTP call goes through the context's injected `fetch`
  (`transporterOptions.fetchImplementation`), so offline/demo mode and tests control all
  network access.
- API calls use `AuthorizedGoogleApiClient`: bearer headers come from
  `getRequestHeaders()` (which refreshes as needed), requests go through the injected `fetch`, a
  401 triggers one refresh-and-retry, and credentials are **only ever sent over HTTPS to**
  `searchconsole.googleapis.com`, `www.googleapis.com`, or `analyticsdata.googleapis.com`.

### Error handling and retries

`errors.ts` accepts both documented error shapes (legacy `errors[].reason` for Search Console
[GSC14] and google.rpc `status`/`details` for GA4 [GA27]) and classifies them as
`api_not_enabled`, `permission_denied`, `insufficient_scopes`, `unauthenticated`,
`invalid_grant`, `credentials`, `config`, `rate_limited`, `quota_exhausted`,
`invalid_argument`, `not_found`, `server_error`, `network`, `offline`, or `unknown`. Each kind
has an actionable hint.

- Errors thrown before any HTTP response (credential providers, JWT signing, ADC discovery) keep
  their meaning: an `AppError` such as `CredentialsMissingError` becomes kind `credentials`
  (code `CREDENTIALS_MISSING`, original hint kept); `CONFIG_INVALID` and unusable private keys
  (OpenSSL decoder errors, `ERR_OSSL_*`) become kind `config`. `auth status` then reports
  `missing_credentials` / `misconfigured`, not `unreachable`.
- Only real transport failures are `network`: a fetch `TypeError`, a `TimeoutError`, or a
  socket/DNS code (`ECONN*`, `ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, `UND_ERR_*`) anywhere in the
  cause chain. Anything else without an HTTP response is `unknown` and not retried.
- Quota errors are split [GSC3, GA23, contract sections 2 and 3]:
  - `rate_limited` (short-term): `rateLimitExceeded`, `userRateLimitExceeded`, messages about
    per-minute/per-second limits, GA4 concurrent-requests exhaustion, and other 429s outside GA4.
  - `quota_exhausted` (long-term): `quotaExceeded`, `dailyLimitExceeded`, the Search Analytics
    load-quota message "quota exceeded", messages about hourly/daily/token quotas, and any other
    GA4 429 `RESOURCE_EXHAUSTED` (the contract says back off until the hourly or daily reset).

Retries (`request.ts`): exponential backoff with jitter (default 4 attempts, 1 s base, 60 s cap,
`Retry-After` honoured) **only** for `rate_limited`, 5xx, and `network`. These are free,
idempotent reads; this module makes no paid or non-idempotent calls. `quota_exhausted` is
**not** retried within the run: it cannot recover in seconds, extra attempts add load while the
load quota is exhausted, and GA4 counts client errors toward its 10,000-per-15-minutes limit.
Permission, scope, API-enablement, credential, configuration, and bad-request errors are never
retried. When a quota is exhausted (or a short-term limit outlives the retries), the sync stops,
marks the result `partial`, keeps everything already committed, and tells you when to retry
(Search Console load quota: wait at least 15 minutes, and if it recurs immediately the daily
quota is exhausted [GSC3]; GA4: hourly/daily reset [GA23]).

### Search Console ingestion (`gsc-*.ts`)

- **Property discovery** (`sites.list` [GSC4]): the configured
  `google.searchConsoleProperty` must match an accessible entry **exactly** and have a
  data-reading permission (owner, full, or restricted). Properties are never constructed or
  guessed; if it does not match, the error lists near matches (same host with a different scheme,
  `www`, or `sc-domain:`) for you to copy. Both permission casings (`siteOwner` / `SITE_OWNER`) are
  accepted [GSC5, GSC9]. Discovered properties are stored in `gsc_properties`.
- **Hosts**: default `https://searchconsole.googleapis.com` (discovery doc, preferred) with
  optional `GSC_BASE_URL=https://www.googleapis.com`; any other value is refused. `GSC_BASE_URL`
  is a documented environment key read through the layered store (environment, then
  `secrets.env`) with this host allowlist, never from `process.env` directly.
  URL Inspection always uses `https://searchconsole.googleapis.com/v1/urlInspection/index:inspect`.
- **Dates**: `startDate`/`endDate` are Pacific dates (`America/Los_Angeles`, stored in
  `date_tz`). The sync ends **yesterday** (Pacific). Initial history is
  `google.gsc.initialHistoryDays` (default 90). Later syncs start at the earlier of
  "day after the last final date" and "yesterday minus `refreshRecentDays - 1`" (default 10), so
  gaps are filled and delayed revisions are captured. History is capped at 486 days (16 months
  retention [GSC26]).
- **Coverage-based backfill**: before each incremental sync, the coverage of every
  unsegmented dataset (property, page, page/query) is checked over the whole history window.
  Dates that were never collected, or whose collection was interrupted (for example a sync that
  stopped at a quota), are re-requested from the first gap, with a "Backfill: ... re-requested
  from <date>" warning. Documented row limits are not gaps. A sync with known gaps left in its
  target window stays `partial` and lists them (`gaps`) until a later sync collects them. GA4
  ingestion does the same per slice (landing views, events, period metrics).
- **Three separate datasets** (never summed together):

  | Table | Request | Aggregation |
  |---|---|---|
  | `gsc_property_daily` | dimensions `[date]` | `byProperty` (`auto` for discover/googleNews, where byProperty is invalid [GSC1]) |
  | `gsc_page_daily` | `[date, page]`, one day per request by default (Google's coverage recommendation [GSC2]) | `byPage` |
  | `gsc_page_query_daily` | `[date, page, query]` with `page equals <url>` for the top N pages (`pageQueryTopPages`, default 50) | `byPage` |

  Optional segments only when requested (`--segments`): `country`/`device` add those dimensions
  (segment key `country=usa;device=MOBILE`); `searchAppearance` is first queried alone, then one
  request set per value filters `searchAppearance equals <value>` (segment key
  `searchAppearance=VIDEO`) as documented [GSC2].
- **Pagination**: `rowLimit` 25,000, `startRow` raised by `rowLimit` until a response has zero
  rows [GSC2]; a page guard (default 40 pages) marks truncation (`stoppedAtMaxPages`) only when
  the last page fetched before the guard was full: a short last page proves the end. Dates
  reaching the documented 50,000 rows/day ceiling are flagged as truncated.
- **Freshness**: every request uses `dataState: "all"` and reads `first_incomplete_date` in
  **both** casings (`first_incomplete_date` / `firstIncompleteDate`; the wire casing is
  unverified [GSC contract]). Rows on or after that date get `is_final = 0`. If Google reports no
  such date, the last 4 days (Pacific, today included) are conservatively treated as not final and
  a warning is recorded. Each sync writes a `gsc_data_availability` row (first incomplete date,
  latest final date, latest date with data, source `api` / `assumed`).
- **Settling not-final page/query rows**: the page/query request set is the top N pages PLUS
  pages that still have current `is_final = 0` rows for dates Google now reports as final
  (dates before the first incomplete date) inside the history window. A page that left the top N
  is re-requested only over those dates (up to `pageQueryTopPages` such pages per sync, earliest
  first; reason `settle_not_final` in the plan and coverage); a top page with such rows before
  the refresh start is requested from its earliest not-final date. Retirement follows each
  page's actual request range. Rows still not final for final dates after the sync set
  `GscDatasetResult.notFinalRows` (`{pages, rows}`), add a warning, and make the sync `partial`
  (never a silent `succeeded`); the dry-run plan says so too.
- **Missing vs zero**: Search Console omits days with no data [GSC1]. Omitted days are **not**
  stored as zeros; they are listed in the batch `coverage_json.datesWithoutRows`. A returned row
  with 0 clicks is stored as an observed 0.
- **Anonymized queries**: visible query rows omit anonymized queries and any filter drops them
  [GSC19]. For each detailed page the batch coverage records the page total, the sum of visible
  query rows, and the difference labelled as an **estimate** of "anonymized + row-limit" traffic.
- **CTR / position**: stored as reported. Aggregates must recompute CTR from clicks/impressions
  and weight position by impressions (downstream `src/seo`).
- **Quota awareness**: Search Analytics calls are paced at >= 55 ms (below 1,200 QPM per site and
  per user [GSC3]); URL Inspection at >= 110 ms (below 600 QPM). The load quota cannot be
  predicted; it is handled by backoff and an early stop.
- **Read-only**: no sitemap submission, indexing requests, property changes, or removals exist in
  this code.

### URL Inspection (`url-inspection.ts`)

- Only for priority URLs: explicit URLs, or the site URL plus the top pages by Search Console
  clicks in the last 28 days. Capped per run by `google.gsc.urlInspectionMaxPerRun` (default 20)
  and by the remaining documented daily quota (2,000 per site per day, counted from stored live
  inspections in the last 24 hours).
- Priority URLs are ranked only from the configured property, the primary search type, and
  unsegmented rows. URLs outside the property are skipped. Results are stored in
  `url_inspections` with `inspection_kind = 'indexed_state'` and a `transformation_version`: the
  API reports the version in Google's index and cannot run a live test [GSC7].
- A run in which no URL was inspected and none failed (every URL skipped: property, per-run cap,
  daily quota, dry run) has status `nothing_inspected`, never `succeeded`; `sync inspect` exits 2
  and names the skip reasons.
- Nothing infers "not indexed" from zero impressions or absence from performance data. Only an
  inspection result is used to describe indexing.

### GA4 ingestion (`ga4-*.ts`)

- **Calls**: `getMetadata`, one tiny probe `runReport` (yesterday, `sessions`, limit 1) to read
  the property time zone and currency from `ResponseMetaData`, `checkCompatibility` for the
  landing-page dimensions, then the reports below. Metadata (dimension/metric names, types,
  blocked reasons), time zone, and currency are cached in `ga4_property_metadata`.
- **Views** (session-scoped acquisition dimensions only; event-scoped `source`/`medium`/
  `defaultChannelGroup` are never used with session metrics [GA31]):
  - `google_organic`: `sessionSource = "google"` AND `sessionMedium = "organic"` (comparable
    with Search Console).
  - `all_organic`: `sessionDefaultChannelGroup = "Organic Search"`.
- **`ga4_landing_daily`**: dimensions `date`, `landingPagePlusQueryString`, `hostName`;
  metrics `sessions`, `engagedSessions`, `keyEvents`, plus, only when getMetadata lists them,
  `keyEvents:<primary>` and `sessionKeyEventRate:<primary>`, and `totalRevenue` (else
  `purchaseRevenue`) when not blocked. Revenue is stored as integer micros in the GA4 currency
  (`revenue_currency`), never as USD API cost.
- **Primary-event rules**:
  - `sessionKeyEventRate:<event>` is documented and listed only for key events [GA3]. If it is
    missing, `primary_session_rate_status = 'unavailable'`, the value is NULL, the limitation is
    reported, and the conversion checklist is printed. The "any key event" rate is **not**
    substituted and event counts are **never** divided by sessions.
  - `keyEvents:<event>` is **not documented** as an API name [GA contract]; it is used only when
    getMetadata lists it. Otherwise, if the event is listed as a key event, a separate report of
    `keyEvents` filtered by `eventName = <primary>` is used and labelled
    `ALTERNATIVE: ...` in `metric_names_json`; if neither is possible the count is `unavailable`.
    Rows returned by the alternative report are `observed`. A landing row it does **not** return
    is a zero (`observed`, 0) only when that report is complete; if it is subject to
    thresholding, has `dataLossFromOtherRow`, is sampled, has `dataTruncationReasons`, or stopped
    paging, the value is NULL with status `incomplete`, and the reasons are in
    `coverage_json.primaryKeyEventsAlternative`.
  - Blocked metrics (`NO_REVENUE_METRICS`) return zeros in GA4 [GA9], so they are not requested;
    revenue restricted by `schemaRestrictionResponse` is stored as `unavailable`, not 0.
  - The scale of `sessionKeyEventRate` / `userKeyEventRate` (0-1 or 0-100) is undocumented
    [GA contract]. A sync first fetches every report, then decides the scale from **all** rate
    values before writing any row, so rows of one sync are never on mixed scales. A value above
    1 proves 0-100: every rate is divided by 100 and marked `percent_normalized`
    (`ga4_landing_daily.primary_session_rate_scale`, `ga4_period_metrics.rate_scale`). The
    finding is persisted per property (`ga4_property_metadata.key_event_rate_scale`) and is
    sticky, so a later sync where every value is <= 1 still normalizes. Otherwise rates are
    stored exactly as reported and marked `undetermined`: consumers must not treat them as
    verified fractions, and reports never show an `undetermined` rate as an OBSERVED percentage
    or derive converting sessions or users from it (the raw value appears only as INFERRED).
    The first sync after migration 0100 creates one new revision for rows that carry a rate,
    because the scale marker is part of the stored values.
  - **Establishing the scale when no value exceeds 1** (migration 0320,
    `ga4_rate_scale_confirmations`, append-only, each row also an audit event):
    - **Owner assertion**: compare one stored value (for example a page's daily rate in
      `analyze page <url>` or `data export`) with the same page, date, and channel in the GA4
      interface, then run
      `npm run cli -- sync ga4 --confirm-rate-scale fraction --evidence "GA4 shows 2.5% ...; stored 0.025" --as "<your name>"`
      (or `percent` when the stored value is 2.5). `--evidence` is required and kept in the audit
      log (`google.ga4.rate_scale_confirmed`). `--as <name>` is required and records who
      confirmed (`owner:<name>`): there is no default identity, and names reserved for
      automation or accounts (cli, system, scheduler, model, agent, claude, agent007, owner,
      root, node, runner, ...) are refused, as for approvers; the name is asserted, not
      authenticated. `confirmRateScale` itself refuses an owner assertion by such an identity
      (also the anonymous `owner` and `owner:owner`), so
      no other caller can bypass the check (the sync's integer-consistency proof below is
      recorded by `system` with its own basis). `--dry-run` shows what would be re-marked. No
      GA4 request is made. A `fraction` confirmation is refused once a value above 1 was
      observed.
    - **Integer consistency** (automatic, never a guess): a session key-event rate is
      converting sessions / sessions, so on a daily row with 1-99 sessions and a rate in
      (0, 1], `rate x sessions` is a whole number >= 1 on a 0-1 scale and a fraction of one
      session on a 0-100 scale, which is impossible. After writing its rows, a sync whose scale
      is still undetermined checks the stored daily rows: at least 5 such rows consistent with
      0-1 and none inconsistent prove 0-1, recorded as a confirmation (basis
      `integer_consistency`, actor `system`). Anything else decides nothing.
    - A value above 1 always wins: a later 0-100 observation overrides a 0-1 confirmation and
      the sync reports the contradiction.
    - Once the scale is established, later syncs mark rates `fraction` (0-1, stored as reported)
      or `percent_normalized` (0-100, divided by 100), and the rates earlier syncs stored as
      `undetermined` (a proven 0-100 included) are **re-marked as new revisions**: the earlier
      revision stays (is_current = 0, `superseded_by_batch_id` = its own batch: no new
      collection happened), and the new revision keeps the batch and collection time and
      records the reason in `transformation_version` (`<version>+rate-scale:<scale>@<id>`).
      Older days of an analysis window become usable at once; reports, benchmarks, routing, and
      experiment windows (the `primarySessionRate` guardrail included) read the re-marked rows.
  - **Several primary events**: only the first entry of `conversions.primaryEvents` gets
    `sessionKeyEventRate`, `userKeyEventRate`, and `keyEvents:<event>`; converting sessions,
    routing, the conversion benchmark, and experiment conversion metrics follow it. The other
    primary events are stored as event counts only. The sync reports this as a limitation
    ("primary event(s) X are not used for conversion rates"), the checklist starts with it, and
    reports add a `config_primary_events_not_rated` data-quality warning.
- **`ga4_event_daily`**: `eventCount` and `keyEvents` for the configured primary and secondary
  events, per day, for `all_traffic`, `google_organic`, and `all_organic` (all landing pages,
  `landing_page = ''`) and per landing page for the organic views. `key_event_count` is NULL for
  events GA4 does not list as key events. Events with no rows are reported as "not triggered or
  not tracked", never stored as zero.
- **`ga4_period_metrics`** (non-additive metrics at period grain): `totalUsers`, `sessions`,
  `sessionKeyEventRate:<primary>`, and `userKeyEventRate:<primary>` for the last 7 and 28
  complete days (`--periods`), site-level for all three views and per landing page for the
  organic views. Daily users are never stored or summed. A missing primary rate is stored as an
  explicit `unavailable` row.
- **"(not set)"** landing pages and host names are kept as explicit buckets and counted in
  coverage.
- **Report metadata** retained in `ingestion_batches.metadata_json`: time zone, currency,
  `subjectToThresholding`, `dataLossFromOtherRow`, sampling metadata and ratio,
  `dataTruncationReasons`, schema restrictions, `emptyReason`, `rowCount`, metric types, and the
  last `propertyQuota`. Warnings are in `coverage_json`.
- **Pagination**: `limit` (default 100,000; documented max 250,000) and `offset` raised by the
  rows received until `offset >= rowCount` or an empty page [GA4, GA24]. A missing `rowCount`
  is never read as 0: it stays `null` (the last reported value is kept), and paging continues
  until a short or empty page (`rowCountMissing` and a warning on the result). Reaching the page
  guard before such a page sets `stoppedAtMaxPages` and a warning, so the report is incomplete,
  never silently complete.
- **Quota awareness**: `returnPropertyQuota: true` on every report; the sync stops (status
  `partial`) when remaining tokens fall below the reserve (500/hour, 2,000/day by default).
  Requests are sequential (well under 10 concurrent requests per property).
- **Freshness**: GA4 does not report a processing-complete date. Dates from yesterday (property
  time zone) onward are marked `is_complete = 0`; this is a conservative assumption, not a
  documented guarantee. The sync ends yesterday; `refreshRecentDays` (default 4) re-fetches
  recent days so late data creates new revisions.

### Versioned ingestion (both sources)

Each request set is an `ingestion_batches` row (request, status, rows received / new revision /
unchanged / retired, API pages, truncation, coverage, metadata, raw references, transformation
version `gsc-ingest@1` / `ga4-ingest@1`, `is_synthetic`). Each observation is upserted by its
table's current key: unchanged row hash and the same synthetic label = no write; a changed hash or
a changed `is_synthetic` label = previous revision `is_current = 0` (with
`superseded_by_batch_id`) and a new revision inserted. The label is compared next to the hash,
not inside it, so the row-hash formula (and every stored hash) is unchanged; a live observation
with the values of a synthetic current row therefore replaces it instead of staying labeled
synthetic. Re-running a sync never double counts, and the `*_current` views expose the latest
revision.

**Rows that disappear** (Google revised the data, GA4 late attribution, a page lost all
impressions): when a request finishes **complete**, current rows inside that request's exact
scope that it did not return are **retired**: `is_current = 0`,
`superseded_by_batch_id = <retiring batch>`, counted in `ingestion_batches.rows_retired`. They
are never deleted and never rewritten as zero. Scopes (migration `0100`):

| Table | Scope retired by one request |
|---|---|
| `gsc_property_daily` | property, search type, the requested dates |
| `gsc_page_daily` | property, search type, the chunk's dates, the request's segment set (`''`, the exact `country`/`device` shape, or one `searchAppearance=<value>`) |
| `gsc_page_query_daily` | property, search type, the requested dates, the page filter, the segment shape |
| `ga4_landing_daily` | property, channel view, the requested dates |
| `ga4_event_daily` | property, channel view, the requested dates, the configured event names, site-level (`''`) vs per-landing rows |
| `ga4_period_metrics` | property, exact period, channel view, the requested metrics, site-level vs per-landing rows |

Retirement is **skipped** when the response proves nothing about absent rows: pagination
stopped at the page guard, the GSC 50,000 rows/day ceiling was reached, rows were malformed,
GA4 paging stopped at the quota reserve, or the GA4 report is subject to thresholding, has
`dataLossFromOtherRow`, is sampled, or has `dataTruncationReasons`. Those rows stay current and
are counted as `staleRowsRetained` in `coverage_json.retirement` with the reasons (a warning is
also printed). A retired key that comes back later gets a new revision after the retired one.
Search appearance values stored earlier but no longer reported by discovery are re-queried so
their rows can be retired.

The same GA4 metadata decides how an **absent landing row** is read. Each batch keeps
`subjectToThresholding`, `dataLossFromOtherRow`, and sampling in `metadata_json`;
`seo/coverage.ga4Coverage` marks a collected date `rowLoss` when every report covering it
reported one of them. A landing page without a row on such a date is `incomplete` (with the
reason), never an observed 0 sessions: in `analyze page`, the router (no join gap is inferred
from it), report totals, and vault page notes. A present row is a real row. A date also
covered by one report without row loss keeps the zero. Like row-limit truncation, row loss is
a per-page flag and a coverage warning, not a site-wide measurement failure. Owner imports
(`data import`) count as Search Console coverage in the same way: an import without
`--complete` covers only the dates it has rows for, and those dates stay truncated, so a page
absent from the file is incomplete; with `--complete` its absence on the file's dates is a zero.
Because a date covered only by an import without `--complete` counts as truncated rather than
missing, the coverage-based backfill does not ask the Search Console sync to re-collect it;
dates without import rows stay missing and are backfilled as before. Raw responses are stored
in the workspace raw store (`data/raw`) and referenced from each batch. `page_id` is left NULL
for the URL-reconciliation layer.

### Status and diagnostics

- `googleStatus(ctx, { network })` returns `IntegrationStatus` rows for `google_auth`,
  `google_gsc`, `google_ga4`, and `google_url_inspection` (`ready`, `configured_unverified`,
  `missing_credentials`, `misconfigured`, `permission_denied`, `degraded`, `disabled`, or
  `fixture`). Network checks are free read-only calls (`sites.list`, GA4 `getMetadata`) and are
  never chargeable.
- `auth diagnose` distinguishes: missing API enablement (`*_API_NOT_ENABLED`, with Google's
  activation link when provided), missing property access (`GSC_NO_ACCESS`, `GA4_NO_ACCESS`,
  `GSC_UNVERIFIED_USER`), `invalid_grant` including the 7-day Testing expiry
  (`REFRESH_INVALID_GRANT`), wrong property formats (`GSC_PROPERTY_FORMAT`,
  `GSC_PROPERTY_MISMATCH` with exact near matches, `GA4_PROPERTY_FORMAT` for `G-`/`UA-` IDs),
  missing or broader-than-needed scopes, token/key file permissions, a primary event that is
  not a key event, missing credentials (`CREDENTIALS_MISSING`), unusable credentials
  (`CREDENTIALS_UNUSABLE`), exhausted quotas (`*_QUOTA_EXHAUSTED`), a rejected service-account
  token request (`SA_TOKEN_REJECTED`: disabled or deleted key or account, a wrong system clock, or
  a stale workload identity configuration; never reported as the OAuth Testing expiry), and an ADC
  user credential in service-account mode (`SA_ADC_REFUSED`). It always recommends least privilege and never asks for owner, editor, or
  administrator rights.

## Data sent to Google

| Integration | Sent externally |
|---|---|
| OAuth | Client ID and secret, authorization code, PKCE verifier (token exchange); refresh token (renewal); token (revocation) |
| Service account | A signed JWT assertion to Google's token endpoint (the private key never leaves the machine) |
| Search Console | Property ID, date ranges, dimensions, filters (URLs of your own site for page detail), URLs being inspected |
| GA4 | Property ID and report definitions (dimensions, metrics, filters including the configured event names) |

Nothing is sent to any maintainer service. Raw responses stay in your private workspace.

## Access setup (step by step)

Use the Google account that should own the access. Official consoles:
Google Cloud console (https://console.cloud.google.com/) and Google Auth Platform
(https://console.developers.google.com/auth/overview).

1. **Create or pick a Google Cloud project** for this installation.
2. **Enable the two APIs** (APIs & Services > Library): "Google Search Console API" and
   "Google Analytics Data API". Nothing else is needed.
3. **Configure Google Auth Platform** (OAuth path):
   - Branding: app name, user support email, developer contact.
   - Audience: **Internal** if you use a Google Workspace organization and only its members
     authorize; otherwise **External**. For External in **Testing**, add your Google account as a
     test user (up to 100).
   - Data Access: add `https://www.googleapis.com/auth/webmasters.readonly` and
     `https://www.googleapis.com/auth/analytics.readonly`. Do not add the read/write scopes.
   - **Testing limitation**: for an External app in Testing, authorizations (and refresh tokens)
     **expire 7 days after consent** [OA2, OA6]. Scheduled syncs then fail with
     `invalid_grant` until you run `auth google` again. For unattended use, publish the app to
     "In production" (Google may require verification for these scopes; this was not checked), use
     an Internal app, or use a service account. One authorization in Testing does not last
     forever.
4. **Create the client**: Clients > Create client > application type **Desktop app**. Download
   the JSON and save it as `<workspace>/secrets/google/oauth-client.json` (or set
   `GOOGLE_OAUTH_CLIENT_FILE`), then `chmod 600` it. Do not paste it into any chat.
5. **Authorize**: `npm run cli -- auth google`. Open the printed URL in your browser, approve
   both read-only permissions, and wait for "Authorization received". The code returns to the
   local 127.0.0.1 listener; you never copy a code or token.
6. **Pick properties**: `npm run cli -- auth status` lists the Search Console properties you can
   access with their permission level. Copy one **exactly** into `google.searchConsoleProperty`
   (`sc-domain:example.com` or `https://www.example.com/` with the trailing slash). Put the
   **numeric** GA4 property ID (GA4 Admin > Property details; not `G-...`) into
   `google.ga4PropertyId`.
7. **Grant least-privilege access** (if the authorizing account or service account lacks it):
   - Search Console: Settings > Users and permissions > Add user > **Restricted** (use Full only
     if a read is refused). Owner is not required.
   - GA4: Admin > Access Management > + > Add users > **Viewer** on the property.
8. **Validate**: `npm run cli -- auth diagnose`, then `npm run cli -- sync gsc --dry-run`,
   `npm run cli -- sync gsc`, `npm run cli -- sync ga4`.
9. **Validate conversion reporting**: configure `conversions.primaryEvents` with exact GA4 event
   names, mark the primary event as a key event in GA4 (a human action), and follow
   `npm run cli -- sync ga4 --checklist`. Never create fake production leads or purchases.
   Record the result as `verifiedAt` (YYYY-MM-DD) and `verificationNote` on the event in the site
   config; reports caveat every primary-event figure until then.

**Service-account path** (unattended servers):

1. In the same project: IAM & Admin > Service accounts > Create (no project roles are needed for
   reading analytics). Prefer **workload identity federation** where your host supports it
   (`gcloud iam workload-identity-pools create-cred-config ...`) to avoid long-lived keys;
   otherwise create a JSON key.
2. Store the key or credential configuration outside the vault and repository, for example
   `<workspace>/secrets/google/service-account.json`, `chmod 600`, and set
   `GOOGLE_AUTH_MODE=service_account` and `GOOGLE_APPLICATION_CREDENTIALS=<path>` in the
   environment or `<workspace>/secrets/secrets.env`. On Google Cloud with an attached service
   account you can omit `GOOGLE_APPLICATION_CREDENTIALS` (Application Default Credentials).
3. Grant the service-account email separately: Search Console (Restricted/Full user on the exact
   property) and GA4 (Viewer). `auth status` prints the email to grant. Note: Google documents
   adding a service account to Search Console only for the Indexing API (as a delegated owner);
   adding it as a regular user is common practice but not confirmed by an official page. Start
   with Restricted and only escalate if reads are refused.
4. No domain-wide delegation. Rotate or disable keys in IAM; revoke by removing the email from
   Search Console and GA4 and disabling the key.

**Revocation / reconnection**: `npm run cli -- auth revoke` revokes the stored refresh token at
Google (`POST https://oauth2.googleapis.com/revoke`) and deletes the local token; `--local-only`
only deletes the file (then also remove the app at https://myaccount.google.com/permissions).
Reconnect with `auth google`.

**Common errors**

| Symptom | Meaning | Fix |
|---|---|---|
| `CLIENT_NOT_DESKTOP` | You downloaded a Web client | Create a Desktop app client |
| `*_API_NOT_ENABLED` | API disabled in the project that owns the client/service account | Enable it, wait a few minutes |
| `GSC_PROPERTY_MISMATCH` | Property string differs (scheme, `www`, slash, `sc-domain:`) | Copy the exact string from `auth status` |
| `GSC_NO_ACCESS` / `GA4_NO_ACCESS` | Identity lacks access | Restricted user (GSC) / Viewer (GA4) |
| `REFRESH_INVALID_GRANT` | Testing 7-day expiry, revoked, unused 6 months, or >100 tokens | `auth google`; publish/Internal/service account for unattended use |
| `SA_TOKEN_REJECTED` | Service-account token request rejected (`invalid_grant`) | Check that the key and account exist and are enabled, the clock, and the workload identity config |
| `GA4_PROPERTY_FORMAT` | Measurement ID or UA ID used | Numeric GA4 property ID |
| `PRIMARY_EVENT_NOT_KEY_EVENT` | Primary event not a key event | Mark it in GA4 Admin; run the checklist |

## Fixture provider (demo and tests)

`createFixtureGoogleAuthProvider(fixturesDir, options)` serves synthetic responses in the
documented shapes from `tests/fixtures/google` (every file carries `"_synthetic": true`; the
provider refuses unlabelled files). Responses are generated deterministically for any date range:
recent days are partial and change as the clock advances (delayed revisions), anonymized query
share is excluded from query rows, byProperty totals are below the sum of page totals, GA4 users
are non-additive, a `(not set)` landing page exists, thresholding metadata is set, and
`metadata-no-primary.json` removes the per-event metrics and blocks revenue. Rows ingested through
it are `is_synthetic = 1`. It never uses the network and never represents live data.

## Verified vs unverified

Verified in primary documentation on 2026-09-24 (not live-tested): the endpoints, request and
response fields, limits, and quotas cited above (see `docs/integration-contracts.md`).

Unverified and handled defensively (recheck with credentials):

- Search Console metadata casing on the wire (both accepted), error shape on
  `searchconsole.googleapis.com` (both accepted), whether `rows` is omitted or empty (both
  accepted), the status/reason of load-quota errors (message match plus 429/403 reasons; see the
  short-term vs exhausted split above), and GA4 quota error messages (matched on
  "concurrent" / "per hour" / "per day" / "tokens"; any other GA4 429 is treated as exhausted).
- `keyEvents:<event>` as an API name (runtime detection only), the `sessionKeyEventRate` scale
  (stored as reported and marked `undetermined` unless >1 is observed, now or in an earlier sync
  of the property, the owner confirms it, or the integer-consistency check proves 0-1), metric-count limits per GA4 request (at most 6
  metrics are requested), compatibility of key-event/revenue metrics with landing-page
  dimensions (checked with `checkCompatibility` at runtime).
- Desktop client JSON top-level key (`installed`), whether `access_type`/`prompt` matter for
  Desktop clients (sent as the library README recommends), sensitivity/verification class of the
  two scopes, and whether a service account can be added to Search Console as a Restricted user.
- GA4 processing latency (dates from yesterday are treated as incomplete by assumption).

## Limitations

- No live Google request has been made by this code. The first real sync may surface response
  details the fixtures do not model.
- Page/query detail covers only the top N pages; it is a sample, not a site total.
- Search Console `hour` data and `discover`/`googleNews` specific aggregations are not ingested.
- The sync stores rows with `page_id = NULL`; URL reconciliation (`src/seo/reconcile.ts`, the
  pipelines' `reconcile_urls` stage or `analyze reconcile`) links them to `pages.id`.
- The OAuth listener needs the browser and the CLI on the same machine. For a headless server,
  use the service-account path.
- Retirement of vanished rows is skipped whenever a GA4 report is flagged
  `subjectToThresholding` (which Google says can be true even when nothing is missing). On
  properties that are always thresholded, rows GA4 stops returning stay current; each sync
  counts them as `staleRowsRetained` and warns, but cannot prove they are gone.
- Page/query rows of a page that drops out of the top N are re-requested only to settle rows
  stored as not final (above); final rows of such a page are not re-requested, so they are not
  retired (they stay the latest observation for that page). The same holds for segment shapes
  or events that are no longer requested. When more pages hold not-final rows than the per-sync
  limit, the rest wait for the next sync, which stays `partial` meanwhile.
- `PagedReport.warnings` and `rowCountMissing` from the GA4 client are not yet copied into the
  GA4 sync's coverage reasons; truncation is surfaced through `stoppedAtMaxPages`.
- The key-event rate scale is decided per property for both `sessionKeyEventRate:<event>` and
  `userKeyEventRate:<event>` together (both are documented as percentages); a property whose
  rates never exceed 1 keeps the `undetermined` marker until the owner confirms the scale
  (`sync ga4 --confirm-rate-scale`) or its small daily rows prove 0-1. While it is
  undetermined, conversions are "not assessed": the router notes `RATE_SCALE_UNVERIFIED` and
  routes on search signals (it never routes a page to INVALID_OR_INCOMPLETE_DATA for this).
- The integer-consistency check assumes GA4 reports the per-row rate as converting sessions /
  sessions of that row; if GA4 estimates the counts, rows stop being whole numbers and the check
  simply decides nothing.
- A `doctor` check for extra primary events is not implemented; the limitation appears in the
  sync result, the checklist, and reports.
- In service-account mode on Google Cloud, ADC token requests (and the email lookup for status)
  go to the metadata server through google-auth-library's own transport, not the injected
  `fetch`; offline mode still blocks the sync before any such call.
