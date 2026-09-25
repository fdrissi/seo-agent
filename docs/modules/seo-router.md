# seo-router: URL reconciliation, metrics, joins, routing, scoring, recommendations

Owner modules: `src/seo/*`, `src/router/*`, `src/cli/commands/analyze.ts`,
`prompts/router.classify-intent.md`, `prompts/analysis.serp-synthesis.md`.

Everything in this slice runs locally against SQLite. No module here makes a
network request. The only optional external calls go through an injected
`LlmClient` (the LLM Gateway adapter, which does its own budgeting). Spec
sections covered: 1, 4 (ROUTER), 11-12 (aggregation rules), 13, 16
(competitor comparison inputs), 18, 19, and the matching section 31 tests.

```
raw GSC/GA4/crawl rows
  -> reconcile.ts   page identity + alias evidence, page_id on metric rows
  -> metrics.ts     Measured<> aggregates (coverage.ts: zero vs missing vs incomplete)
  -> join.ts        GSC x GA4 at page/period grain
  -> page-analysis  router inputs (benchmarks.ts, intent, technical, experiments)
  -> router/*       ordered rules -> route_decisions
  -> scoring.ts     interpretable score -> opportunities
  -> recommend.ts   one primary action or explicit no-action -> recommendations + claim_evidence
```

## URL reconciliation (`src/seo/url.ts`, `src/seo/reconcile.ts`)

**Identity.** `normalizeUrl` changes only what is equivalent by definition:
scheme/host case, default port, fragment, an empty trailing `?`, known
tracking parameters (`utm_*`, `gclid`, `fbclid`, `srsltid`, and others), and
percent-encoding per RFC 3986 sections 6.2.2.1-6.2.2.2 in the path and query
(`normalizePercentEncoding`: hex digits upper-cased, percent-encoded
unreserved characters `A-Z a-z 0-9 - . _ ~` decoded; reserved characters such
as `%2F`, `%26`, `%3D`, `%2B`, `%20`, `%25` stay encoded, invalid `%`
sequences are left alone, the result is idempotent, and the change is
recorded as `percent_encoding`). So a Search Console URL with lower-case hex
and a GA4 landing path with decoded characters join to one page. It keeps
meaningful query parameters (order unchanged), path case, locale paths, and
trailing slashes. It never merges `www`/non-`www` or `http`/`https`.
`matchesPathPattern` and wildcard alias prefixes compare percent-normalized
forms.

**Pages stored under an older normalization.** `reconcile@1.2.0` first
rewrites, in place (same page id, so no history splits), every stored page
URL that re-normalizes to a different identity, and records the old string
as an identity alias. `pageByUrl` also finds a stored page whose URL
re-normalizes to the requested identity, so `ensurePage` never duplicates it.
When another page already holds the new form, the earlier-seen page keeps the
identity (the URLs are swapped when that is the old-form page), and the other
resolves to it through a `normalized` merge step (never a false
`alias_cycle`). Both are reported in `ReconcileReport.identities`
(`renormalized`, `duplicates`). See "Known limitations" for modules outside
reconciliation.

**Raw URLs are preserved.** Every observed raw URL gets a `url_aliases` row with
its relation and confidence:

| relation | meaning | confidence |
| --- | --- | --- |
| `identical`, `gsc_url` | raw URL equals its normalized identity | established |
| `tracking_params_removed`, `host_case`, `default_port`, `fragment_removed` | safe normalization | established |
| `ga4_path` | GA4 `hostName` + landing path, stored scheme-relative as `//host/path` (GA4 reports no scheme) | established when exactly one known page matches and that page has non-GA4 evidence (crawl, GSC, config); probable when the scheme was taken from `site.url` (re-runs do not upgrade it without new evidence); unverified when http and https pages both exist |
| `redirect` | observed in `crawl_results.redirect_chain_json` (own-site crawls only) | established only when every hop is 301/308 and the final URL returns 2xx on an allowed host; probable for 302/303/307 or unknown hop codes; unverified otherwise (error target, off-site target, final URL never fetched) |
| `canonical` | `rel=canonical` | established only when the target is crawled, returns 2xx, and declares itself canonical (agreement both ways), with no open canonical-conflict issue and no disagreeing Google-selected canonical from URL Inspection; probable for one-way agreement; unverified for chains to a different target, cross-host targets, or conflicts |
| `configured` | `site.urlAliases` (exact URLs, or `prefix*` -> `prefix*` wildcard rules) | established (owner assertion). Wildcard rules apply whenever the mapped page exists, with `configured` precedence: they outrank identity aliases recorded earlier (so the outcome does not depend on which URL was observed first), but not an exact configured alias or a manual alias. |
| `manual` | recorded by the owner | established; never overwritten by automation |

**How redirects are judged.** The crawler stores the FIRST response on the
redirecting row (`status_code` = 301/302/..., `final_url` = the last URL,
`redirect_chain_json` = `[{url, status, location}]`, and `finalStatus` in
`extraction_json`), and stores the final response on the final URL's own row
(no chain). The target is therefore judged by, in order: the final URL's own
latest direct row, `finalStatus` recorded with the redirect, the last chain hop
when it is the final URL, and the redirecting row's own status only when it is
not a 3xx (older row shapes). The redirecting row's 3xx is never read as the
target's status. The evidence records `firstStatus`, `finalStatus`, and the
basis. A redirect target is marked `active` only when it returned 2xx; a
crawler's `gone` is never overwritten. Canonical checks likewise use each URL's
own direct row, never a redirecting row. `tests/integration/seo/crawler-contract.test.ts`
runs the real crawler (offline fixture transport) to pin these row shapes.

Only identity relations and **established** merge evidence are followed during
resolution. Probable and unverified evidence is recorded for review. Weaker
evidence never overwrites stronger evidence (precedence: manual > configured >
established redirect > established canonical > weaker evidence > identity).
Conflicts are listed in the report. If a newer crawl no longer shows a redirect
or canonical, the stale alias is downgraded back to the URL's own identity, with
the old evidence kept in `evidence_json`.

**Metric rows.** `UrlReconciler.run()` sets `page_id` on every revision of
`gsc_page_daily`, `gsc_page_query_daily`, and `ga4_landing_daily`. Unresolved rows
keep `page_id = NULL` and are listed with a reason: `not_set` (GA4 `(not set)`
kept as an explicit bucket), `missing_host` (the GA4 row has no hostName),
`host_not_allowed`, `ambiguous_scheme`, `invalid_url`, or `alias_cycle`. The
report also lists **distinct variants**: similar URLs (scheme, www, trailing
slash, case, query order) that stay separate because no evidence connects them.
Page flags `is_protected`/`is_excluded` follow `crawl.protectedPaths` and
`crawl.excludedPaths` (`/x/*` or `/x/` = prefix; `/x` = exact or below `/x/`;
case-sensitive). The run is idempotent and runs in one transaction.
`run({ dryRun: true })` (used by `--dry-run` and by the workflow stage in a
dry-run context) runs it inside a rolled-back transaction and returns the same
report.

## Metrics (`src/seo/metrics.ts`, `src/seo/coverage.ts`)

All readers use `is_current = 1` rows only, always filtered by `site_id`, and
return `Measured<T>`.

- **CTR** = `sum(clicks) / sum(impressions)`. It is never an average of daily
  CTRs. With zero impressions, CTR is `unavailable`, not 0.
- **Position** = impression-weighted average, computed only when all rows share
  the same property, search type, aggregation type, segment key, and date time
  zone. Mixed rows make every metric `unavailable` with the list of mixed
  combinations. GSC position is an aggregate, never a live ranking.
- **Finality.** Non-final dates (`is_final = 0`, or dates coverage marks not
  final) are excluded by default and listed. Excluding them makes the value
  `incomplete` (with its partial value), because the effective window is shorter
  than requested. `incompletePolicy: 'flag'` includes them and also marks the
  result `incomplete`. `compareMeasured` refuses to compare anything that is not
  fully observed, so a shortened or incomplete current window is never compared
  with a completed period.
- **Zero vs missing.** `coverage.ts` derives a state for each date from
  `ingestion_batches`: the dataset, the property, the search type (from
  `request_json.type`/`searchType`/`search_type`, when present), the status, and
  `truncated`, plus row finality and `gsc_data_availability`. A collected, final
  date with no row counts as an observed **zero**. A date never collected is
  **missing**. A date whose batch hit a row limit is **truncated**: a page
  without a row that day is `incomplete`, because its row may have been omitted
  rather than being zero.
- **Coverage is scoped to the slice being aggregated.** GA4 batches count only
  for the channel view in `request_json.view` (a successful `all_organic` sync
  never proves `google_organic` coverage; a failed `google_organic` sync stays
  missing, never zero). Search Console request sets share the dataset, so a
  batch counts only for the segment set it produces: extra dimensions
  (`country`, `device`) give their shape, and a `searchAppearance` filter gives
  exactly `searchAppearance=<value>`. Row finality is read for the same view or
  segment. Batches that record no view or dimensions (older or fixture batches)
  count for any slice.
- **Truncation is per date.** A truncated/partial batch marks only the dates in
  `coverage_json.truncatedDates` and the chunks where pagination stopped
  (`retirement.skippedChunks` with a pagination/quota reason). Only a truncated
  batch without per-date detail marks its whole range. A date is truncated only
  when every batch covering it was truncated on it.
- **Owner imports are coverage too.** `data import` batches (source `import`)
  count for Search Console coverage like syncs, scoped to the search type and
  to the segment shape of the rows they wrote. An import without `--complete`
  is truncated and covers only the dates it has rows for, so a page absent from
  the file on those dates is `incomplete` (a date without any row stays
  missing); with `--complete` the file's whole date range is collected and an
  absent page is an observed zero. A re-import of the same file with
  `--complete` covers its whole range even when every row is unchanged (no
  new revision is written); when invalid rows were skipped the batch is
  partial and the completeness assertion does not apply, and the result
  says so. Dates known only from an import without `--complete` are
  re-collected by the next Search Console sync (`computeGscRange` backfills
  the page dataset over them, once; a date a sync has covered is no longer
  import-only), and an import with `--complete` is not re-collected. Where
  such dates are shown, `analyze page`, the reports, and the headline say
  they come from an owner import without `--complete` (rows absent from the
  file are unknown, not zero), never that a documented API row limit was
  hit (`tests/integration/seo/coverage-import.test.ts`,
  `tests/integration/seo/page-analysis.test.ts`,
  `tests/integration/seo/analyze-cli.test.ts`,
  `tests/integration/reports/weekly.test.ts`).
- **GA4 row loss.** A GA4 date is marked `rowLoss` (`other_row`,
  `thresholding`, `sampling`) when every batch covering it reported
  `dataLossFromOtherRow`, `subjectToThresholding`, or sampling in its stored
  metadata. The date stays collected and final (present rows are real), but a
  landing page without a row on it is `incomplete` with that reason, never an
  observed zero; when every collected date without a row is lossy the value
  has no partial figure at all. Like truncation it is a per-page flag plus a
  site warning, not a site-level failure.
- **Synthetic rows.** Aggregates carry `synthetic: true` when any row read has
  `is_synthetic = 1`. Callers never present such values as observed.
- **Separate datasets.** `gscPropertyMetrics` reads only `gsc_property_daily`.
  Page and query readers read only their own tables. Nothing adds property totals
  to page or query sums. Query rows never stand in for page totals, because
  anonymized queries are omitted from them.
- **GA4.** Sessions, event occurrences, and revenue are additive across dates.
  The primary-event session conversion rate is
  `sum(rate_i * sessions_i) / sum(sessions_i)`. It is computed only when every
  row with sessions has an observed `primary_session_rate`, all rows report one
  configured primary event, and every rate is within 0..1. Otherwise it is
  `unavailable` with the reason. Event occurrences (`primary_key_events`,
  `key_events`) are reported separately and are never divided by sessions. The
  "any key event" rate is never substituted. Revenue is summed only for a single
  known currency.
- **Users** come only from `ga4_period_metrics` for exactly the requested period
  and landing page. Daily rows and sub-periods are never summed, and the reason
  says so.

## Join (`src/seo/join.ts`)

GSC and GA4 are each aggregated to one row per page per period (GA4
`channel_view = 'google_organic'`, session-scoped acquisition) and then joined on
`page_id`. Query rows are never joined to GA4 rows, so conversions cannot be
multiplied by the number of keywords.

- **Date boundaries** are explicit: GSC days are `America/Los_Angeles` (from the
  row `date_tz`), and GA4 days are in the property time zone (from the row
  `date_tz` or `ga4_property_metadata`). The join does not shift dates.
- **Clicks vs sessions** reports the ratio and a direction, and lists reasons as
  either `observed_condition` or `possible`. An observed condition exists in the
  data (different time zones, recorded URL variants, `(not set)` sessions,
  incomplete data), but it is not claimed as the cause. Possible reasons are
  general causes that were not checked: consent/blocking, attribution
  differences, click/session cardinality, and search-type scope. The note always
  says causes are not asserted.
- **Query-level impact** (`queryImpactHypotheses`) reports only the query's share
  of visible query clicks next to the page-level outcome, labeled `HYPOTHESIS`.
  No conversions are attributed to a query.

## Router (`src/router/*`)

The ordered rules follow spec section 18. The default order is
`invalid_data, technical_blocker, experiment_active, healthy, ranking, ctr,
conversion, decline, content, indexing_unknown, low_data, irrelevant`. A site
can set its own order with `router.ruleOrder` (each rule id at most once;
unknown or duplicate ids fail validation, missing rules are appended in the
default order). The prerequisite rules `invalid_data`, `technical_blocker`,
and `experiment_active` always run first, in that order, whatever the
configured order says. The first matching rule decides the route. Every
rule's outcome is kept in `trace`. Observations that do not decide the route are
kept as `notes` (for example `SUSPECTED_TECHNICAL_ISSUE`,
`CTR_BENCHMARK_UNAVAILABLE`, `INTENT_DECIDED_BY_MODEL`, `RATE_SCALE_UNVERIFIED`,
`SEARCH_METRICS_NOT_OBSERVED`). If nothing matches, the route is `UNSURE` /
`NO_RULE_MATCHED` (with `SEARCH_METRICS_NOT_OBSERVED` when page search totals
were not observed).

**Reasons record their measured inputs.** A reason that rests on measured
values carries them in `data.inputs` (`ReasonInputs` in
`src/router/types.ts`, stored in `route_decisions.reason_codes_json`): the
source (`gsc`, `ga4`, `crawl`, `url_inspection`), the current-revision view or
table the values come from, the routing window, and the observed values the
rule compared. Query reasons (`QUERY_POSITION_IN_RANGE`, `MIXED_INTENT` /
`AMBIGUOUS_INTENT`, `BUSINESS_EVIDENCE_COMMERCIAL_INTENT`,
`CTR_BELOW_COMPARABLE`, `UNCOVERED_DEMAND_QUERIES`,
`NO_RANKING_CANDIDATE_WITH_BUSINESS_EVIDENCE`, `CTR_NOT_WEAK`) record per-query
rows with position, impressions, and clicks (at most 20, from
`gsc_page_query_daily_current`); page, GA4, decline, low-data, and site-level
reasons record their totals and rates; coverage reasons (`GSC_DATA_MISSING`,
`GA4_DATA_INCOMPLETE`, ...) the recorded coverage state (`ingestion_batches`);
technical and URL Inspection reasons their observation (no routing window). A
value that was not observed is `null`, never 0, and a reason with nothing
observed records no inputs. Reasons that rest on configuration
(`EXCLUDED_PATH`, `MISSING_CONVERSION_DEFINITION`,
`BUSINESS_EVIDENCE_PAGE_TYPE`), records (`EXPERIMENT_*`), a policy
(`NEVER_AUTO_DELETE_OR_REDIRECT`), or the absence of a match
(`NO_RULE_MATCHED`, `CONVERSIONS_NOT_ASSESSED`) carry none. `reasonInputs(r)`
reads them defensively (older stored reasons have none).

**Rate scale unverified is not a measurement failure.** When GA4 reported the
primary-event session rate but its 0-1 vs 0-100 scale is not established
(stored scale `undetermined`), `buildPageRouteInput` sets
`measurement.rateScaleUnverified` instead of `primaryRateGap`. The page is not
routed to INVALID_OR_INCOMPLETE_DATA for it: the `invalid_data` rule adds a
`RATE_SCALE_UNVERIFIED` note naming
`npm run cli -- sync ga4 --confirm-rate-scale fraction|percent --evidence "<what you compared>" --as "<your name>"`
(`CONFIRM_RATE_SCALE_COMMAND` in `src/integrations/google/rate-scale-command.ts`,
the one definition every message uses; `--as` is required), conversions are `unmeasured` (so
CONVERSION_OPPORTUNITY, conversion declines, and converting sessions as
business evidence are unavailable; HEALTHY says `CONVERSIONS_NOT_ASSESSED`),
and the technical, CTR, ranking (commercial intent or page type as business
evidence), click-decline, content, and indexing rules run as usual. A rate that
GA4 did not report for rows with sessions is still a measurement gap
(`PRIMARY_RATE_UNAVAILABLE`). See [google.md](google.md) for how the scale is
established.

**Absent GA4 rows under row loss.** A page without a GA4 landing row on a
collected date whose report(s) reported `(other)` bucketing, thresholding, or
sampling has `incomplete` sessions (never an observed 0), so no join gap
(`JOIN_UNRESOLVED`, clicks with 0 sessions) is inferred from it.

| Route | Condition (thresholds from `config.router` unless noted) |
| --- | --- |
| INVALID_OR_INCOMPLETE_DATA | property unresolved; GSC/GA4 data missing or not final for the window; GA4 not configured; no `conversions.primaryEvents`; primary-event rate not observed although there are sessions; broken joins (`JOIN_UNRESOLVED`): GA4 google_organic sessions for this page's host+path that could not be joined to any page (both http and https identities exist without merge evidence, or no hostName), a **probable** redirect/canonical variant of this page that carries its own traffic (totals may be split), or at least 20 clicks but 0 matched sessions (not applied when a confirmed access failure explains the zero sessions; then it is a note); `(not set)` share above 20% |
| TECHNICAL_BLOCKER | a **confirmed**, non-heuristic, open `technical_issues` row that is critical, or of at least medium severity and an access/indexability failure in the crawler's vocabulary (`broken_internal_link` and `sitemap_url_not_ok` on this URL, `redirect_loop`, `redirect_chain_too_long`, `access_blocked`, `robots_blocked_*`, `accidental_noindex`, `canonical_target_not_ok`); the page's own latest direct own-site crawl returned 404/410 (`CRAWL_HTTP_ERROR`), or 5xx in two consecutive crawls; the URL's latest crawl is a redirect to a 404/410; or a URL Inspection indexed-state showing `BLOCKED_*`, robots `DISALLOWED`, or a failed page fetch. Unconfirmed issues, a single 5xx, and confirmed low/info observations (e.g. an intentional member-area login wall) become notes, worded "not confirmed" or "observed, but not an access/indexability blocker". |
| EXPERIMENT_ACTIVE | an experiment on the page that is `observing` (the review date is flagged when due), `approved`, or `awaiting_implementation`. Site-wide experiments (`page_id` NULL) and experiments that use the page as a comparison (control) page add notes (`EXPERIMENT_SITE_WIDE`, `EXPERIMENT_CONTROL_PAGE`) and recommendation exclusions instead. |
| HEALTHY | sufficient exposure with **observed** page impressions (incomplete or missing Search Console page totals never conclude "leave unchanged": the rule declines with a `SEARCH_METRICS_NOT_OBSERVED` note and the page falls through to LOW_DATA or UNSURE), no decline, CTR not credibly weak, conversions not poor, no 4-20 query candidate with business evidence or ambiguous intent, and no relevant (non-navigational, non-branded) uncovered demand beyond `rankingPositionMax` (that page is evaluated as CONTENT_OPPORTUNITY). Leave unchanged. `SUFFICIENT_EXPOSURE` states the observed impressions and sessions, or a metric's status and reason, never an unknown value as 0. The conversion reason says what was checked: `CONVERSIONS_NOT_POOR` only when conversion performance was actually assessed as satisfactory, otherwise `CONVERSIONS_NOT_ASSESSED` with the reason (too few sessions, no measured rate, an unverified rate scale, no benchmark). |
| RANKING_OPPORTUNITY | queries with position in `[rankingPositionMin, rankingPositionMax]` and at least `minImpressionsForOpportunity` impressions, plus business evidence (conversions on the page, a commercial page type from `router.commercialPageTypes`, or commercial/transactional intent). A shortlist heuristic, not an instruction to edit. |
| CTR_OPPORTUNITY | a query's Wilson 95% upper bound for CTR is below `healthyCtrRatio` x this site's CTR at a comparable position, computed separately for branded and non-branded queries, with the page itself excluded |
| CONVERSION_OPPORTUNITY | at least `experiments.minSessionsForConversionEvaluation` sessions and a Wilson upper bound below 0.5 x the site's primary-event rate (other pages) |
| DECLINE | clicks down by at least `declineThresholdPct`% versus the previous period of the same length, with enough previous impressions and a drop larger than 2*sqrt(previous) as a noise guard; also converting sessions (from 5 or more) |
| CONTENT_OPPORTUNITY | relevant, non-navigational queries beyond `rankingPositionMax` with at least `minImpressionsForOpportunity` impressions (check overlap first). Reached for pages with plenty of exposure too: HEALTHY declines when such non-branded demand exists, so a page with 5,000 impressions and a 400-impression query at position 34 is a content opportunity, not "leave unchanged". |
| INDEXING_UNKNOWN | observed zero impressions and no URL Inspection record, or an inspection verdict other than PASS. Never delete or redirect automatically. |
| LOW_DATA | site property impressions over 28 days below `lowDataSiteMaxImpressions` (bootstrap), or the page is below evidence thresholds |
| IRRELEVANT | owner-excluded path (`crawl.excludedPaths`). Excluded pages skip every other rule, because explicit configuration beats inferred signals. |
| UNSURE | ranking candidates without business evidence whose intent is mixed or unclear, or no rule matched |

Every threshold is site configuration under `router.*` (see
[CONFIGURATION.md](../CONFIGURATION.md)): besides the position band,
impression, low-data, decline, and CTR thresholds, also
`router.conversionPoorRatio` (default 0.5), `router.notSetShareMax` (20%
`(not set)` share), `router.requireConversionDefinition` (true),
`router.commercialPageTypes` (`offer`, `product`, `category`, `tool`),
`router.minClicksForJoinCheck` (20), `router.minPreviousConversionsForDecline`
(5), and `router.ruleOrder`. The defaults live in `DEFAULT_THRESHOLD_EXTRAS`;
a missing or invalid value falls back to the documented default, never to a
guess. `rules_version` is `router-rules@1.1.0+<hash of thresholds and order>`,
so changing a threshold or the order also changes the recorded version.

**Page types.** `pages.page_type` is business evidence for the router
(commercial page types), for scoring (relevance), and for offer-page
detection. Every type records where it came from (`pages.page_type_source`,
migration 0211), with the precedence **owner > config > inferred**:

- `owner`: set with `pages set-type <url> <type>` (`auto` removes it). It
  always wins.
- `config`: URL reconciliation applies `site.pageTypes` (path glob to type,
  first match wins) on every run. A config type never overrides an owner
  type.
- `inferred`: `pages infer-types` previews guesses from the latest own-site
  crawl (structured data, URL, wording); `--apply` records them. Inferred
  types never override owner or config types.

`pages list` shows each page's type and its source. Pages without a type
are not commercial evidence; nothing assumes a type that nobody set.

**Which pages are routed.** Every page except (a) pages whose own URL resolves
to another page through established merge evidence (configured alias or
wildcard, permanent redirect, agreeing canonical, manual alias): their metric
rows already count toward the target, so routing them would report false
zeros; they are listed in `SiteRouteRun.merged`; and (b) redirected pages,
unless the redirect was not merged because its target returned 4xx/5xx (that
URL keeps its own search data and needs a technical fix).

**Site-level row-limit truncation** is a coverage warning, not a site-level
INVALID decision (nobody can repair a documented API row ceiling). Each page
without a row on a truncated date gets an `incomplete` aggregate of its own,
so its impressions are never read as zero (no INDEXING_UNKNOWN from them).

`routeSite` issues site-level INVALID_OR_INCOMPLETE_DATA or LOW_DATA decisions.
The LOW_DATA next step is an offer-page brief, one useful supporting-page brief,
and measurement/technical-readiness checks. `routeContentSignal` never
auto-dismisses a signal: unclear relevance goes to UNSURE, and IRRELEVANT is
used only after an owner decision. In the content pipeline, a signal whose
business relevance is `none` is **deferred** for owner review, never
rejected automatically.

**Intent.** The deterministic rules in `router/intent.ts` work as follows:

- Brand aliases from `brand.aliases` mark a query as branded. Matching is
  token-bounded, ignores case and diacritics, and also accepts spacing variants.
- Question words and `?` mean informational. Commercial and transactional
  modifiers set those intents. Informational plus commercial signals means
  `mixed`.
- Bare topic queries are `unsure`; they are not forced into a class.
- Lexicons exist for en, de, fr, es, it, pt, nl, et, fi, sv, pl, and ru. When
  `market.languages` is set, only those lexicons are used. A language without a
  lexicon yields `unsure`.
- Non-English question words count only as the first token.

The optional hook (`createLlmIntentClassifier`: cheap tier, prompt
`router.classify-intent`) receives only the mixed or unsure queries, passed as
evidence items with trust class `user_reported` (text typed by third-party
searchers; `synthetic` for demo data), never `first_party_measurement`. Results are stored with `decidedBy = 'model'` in
`route_decisions.decided_by` and `keywords.intent_source`. A model answer of
"unsure" stays unsure. If the hook is not configured or fails, the rule result
stands.

## Scoring (`src/seo/scoring.ts`)

```
base  = sum(w_k * c_k) / sum(w_k)                    c_k in 0..1
score = 100 * base * (1 - risk) * (1 - 0.5 * uncertainty)
```

| component | weight | definition |
| --- | --- | --- |
| relevance | .15 | 1 for a commercial page type. Otherwise by intent (transactional/commercial .85, mixed .6, informational/unsure .5, navigational .3). At least .9 when the page has conversions. |
| demand | .20 | `log(1+impressions)/log(1+max page impressions on the site)`. Uses measured GSC impressions; search-volume estimates are not used. |
| intent | .10 | transactional 1, commercial .85, mixed .6, informational .5, unsure .4, navigational .2 |
| outcome | .20 | `log(1+E)/log(1+max page converting sessions)`, with `E = x*n/(n+k)`: the observed converting sessions `x` shrunk by evidence volume (`n` sessions, `k = 100` pseudo-sessions). Prior mass is never counted as conversions, so zero observed conversions give `E = 0` at any traffic. The Beta-smoothed rate `p = (x + k*p0)/(n + k)` (toward the site rate `p0`) is reported and used only for conversion room. |
| evidence | .10 | `0.5*min(1, impr/minImpr) + 0.3*min(1, sessions/minSessions) + 0.2*completeness` |
| room | .15 | ranking: 1 at the minimum position, falling to .5 at 10, then .25 at 20. CTR: `1 - ctr/comparable`. Conversion: `1 - smoothed/site`. Decline: `abs(decline%)/100`. Content: .6 prior. Technical: 1. Indexing: .5. |
| effort | .10 | cheapness of the next step (title/snippet .9, inspection .8, audit .6, review .5, new content .3) |

Penalties:

- Risk = `1 - prod(1 - r_i)`, where the factors are: protected page .5, branded
  .2, experiment on the page .3, site-wide experiment or control page of an
  experiment .1, unconfirmed technical issue .1.
- Uncertainty = `1 - evidence`.

Examples (unit-tested): 1 conversion from 2 sessions gives `E ~= 0.02` and
cannot outrank 30 conversions from 1,000 sessions; 0 conversions from 5,000
sessions give outcome 0, below 3 conversions from 200 sessions.

Raw counts are stored unchanged in `opportunities.raw_counts_json`: raw rate,
smoothed rate, `shrunkConvertingSessions`, the prior, and `dataOrigin`
(`measured` or `SYNTHETIC`). Branded and non-branded
opportunities are ranked separately with `shortlist()`. Backlinks and "authority"
are never scored; `notMeasured` lists them. `scoring_version` is
`scoring@1.1.0`. Opportunities are upserted per (site, route, page, query,
period, scoring version). When a page is routed again, its other open
(candidate/shortlisted) opportunities for the same period are archived with
`status_reason = 'superseded: page re-routed to <ROUTE> ...'`; a full routing run
also archives open opportunities of pages it no longer routes (merged or
redirected).

**Limitations.** The weights are editorial defaults, not fitted values. The
ranking room function is a heuristic. The CTR and conversion benchmarks come
from the site's own data, so a small site often has no benchmark; the router
then refuses to infer weakness. Wilson bounds are screening aids, not
significance tests.

## Competitor comparison (`src/seo/competitive.ts`) and internal links (`src/seo/internal-links.ts`)

**Competitor comparison.**

- Competitor pages are selected in this order: explicit crawl result IDs,
  explicit URLs, the latest non-sandbox SERP snapshot for the query, or the
  latest competitor crawl.
- For our page and each competitor, it extracts: page type (from structured
  data, URL, and title), intent signals, H2/H3 topic terms, examples,
  tools/templates, original data, cited evidence and external links, freshness
  dates, and FAQ structure.
- It reports consensus topic terms, gap terms (research prompts, not headings to
  copy), **what our page does better**, and a page-type alignment check.
- Word count is shown only for context. Inaccessible competitors (login, robots,
  access denied) are listed and not compared. No causal claims are made.
- `synthesizeComparison` (optional, reasoning tier, prompt
  `analysis.serp-synthesis`) passes page content only as evidence. Competitor
  content, anything derived from it, AND our own crawled page content are
  marked `scraped_untrusted` (page text can contain third-party or injected
  text); `synthetic` when the site is synthetic. Template
  variables hold only code-computed counts, enums, and the query. The output is
  schema-validated, with each statement labeled OBSERVED, INFERRED, or
  HYPOTHESIS.

**Internal links.**

- Each suggestion is `{sourcePage, destination, passage, proposedAnchor, reason}`.
- A suggestion is made when the source page's extracted text already contains a
  destination phrase (its top GSC queries, H1, or title) as a whole word, and
  the source does not already link to the destination in that crawl.
- Potential orphans are reported only relative to the latest own-site crawl,
  with a coverage note (status, pages fetched, stop reason). After a
  `completed` crawl, a known page (from GSC, GA4, config) that no crawled page
  links to is a potential orphan. After a `partial` crawl (page/depth caps,
  transient failures), only pages that crawl fetched are assessed; the others
  are listed as `notAssessable` (outside coverage), never as orphans.
  `inboundInternalLinkCount` is labeled as a count from one crawl, not an
  authority score.

## Recommendations (`src/seo/recommend.ts`)

`RECOMMEND_VERSION` is `recommend@1.4.0` (1.4.0: route claims cite an evidence item built from the router's recorded inputs).

`loadPriorContext` reads, BEFORE recommending (spec section 19): active
experiments, experiments concluded in the last 180 days (`positive`,
`negative`, `inconclusive`, `cancelled`), owner `decisions`, recommendations
rejected in the last 180 days, and learnings. Standing owner decisions
imported from a vault note (`vault_path` set, for example
`01 Business/Owner Decisions.md`) apply whatever their age; every other
record uses the 180-day lookback.

It also runs TWO searches on an injected `MemoryRetriever`, so the owner's
knowledge is never crowded out by history:

- history: `rejected_proposal`, `experiment_summary`, `decision`,
  `approved_learning` (`PRIOR_HISTORY_SOURCE_TYPES`);
- owner knowledge: `business_note` (the vault's `01 Business/**` notes,
  including the standing entries of the owner-decisions note) and `decision`
  (`OWNER_KNOWLEDGE_SOURCE_TYPES`).

The weekly `recommend` stage builds the query from this run's candidates
(`priorMemoryQuery`: the default terms plus the queries and URL paths of the
five best-scored candidates). The result carries `status`, `method`,
`searched`, and a labeled `detail`: `detailKind` `policy` (a deliberate
choice, for example full-text only by policy, which is not degraded),
`degraded`, or `error`; degraded or failing memory is reported, never
hidden. A rejected recommendation, concluded experiment, or decision that the
memory search returns from OUTSIDE the lookback window is re-read from SQLite
(the source of truth) and used for exclusion too. Rejected and negative items
keep their record status, so they are never mistaken for recommendations.

`decisions` rows are written by real events, never seeded: every human
`approvals approve` / `approvals reject` records a decision on its subject,
and standing decisions the owner writes in the vault note
`01 Business/Owner Decisions.md` are imported by `vault import-business` /
`vault apply-business` (the note's template documents exactly the syntax the
importer reads; `tests/integration/obsidian/owner-decisions-template.test.ts`).
Decisions are rendered in `12 Decisions` and linked from their pages.
`resolveDecisionTarget` resolves each decision subject to what candidates are
compared on:

| Subject | Matches a candidate with |
| --- | --- |
| `page`, `url` | the same page id or normalized URL |
| `query`, `keyword` | the same normalized query |
| `opportunity` | the same opportunity id, or the opportunity's page and action (its query and action when it has no page) |
| `recommendation` | the recommendation's page and action (its query and action when it has no page); a revision recorded by `experiments specify-change` is compared on the label it was specified from |
| `experiment` | the experiment's page and a similar experiment type |
| `site` (site-wide, free text) | nothing: site-wide decisions are knowledge only and never exclude a candidate |

So a proposal the owner rejected under an old recommendation or opportunity
id stays rejected when a later run proposes the same change under a new id.

`assembleRecommendation` returns ONE primary item plus at most 3 secondary
observations. It checks, in order:

1. Site-level INVALID -> `repair_measurement`.
2. Page measurement problems -> `repair_measurement`.
3. Confirmed technical blocker -> technical investigation.
4. Low-data site -> `collect_more_evidence` (bootstrap).
5. Otherwise the best non-branded optimization opportunity (branded only when
   nothing else remains) becomes the primary action.
6. If the score is below 20 or evidence quality is below .35 ->
   `collect_more_evidence`. Exception: an INDEXING_UNKNOWN page with zero
   impressions has weak evidence by construction, so it becomes the primary
   action as the free URL Inspection check instead of "keep measuring". When
   there is no candidate, it returns `no_action` (settled routes) or
   `collect_more_evidence`.

Candidates are excluded, with the reason recorded, when the page has an active
experiment, the page is a comparison (control) page of an active experiment
(page-changing routes), a site-wide experiment is active (page-changing routes:
ranking, CTR, conversion, content; investigations and inspections still go
ahead, and when everything is held back the primary is "Monitor site-wide
experiment X"), an owner decision rejected the idea (resolved as in the table
above), a recommendation with the same action was rejected for the same page
(or, for a recommendation without a page, for the same query; a rejected
secondary observation suppresses the same action too), or a similar
experiment concluded `negative`, `inconclusive`, or `cancelled` on the same
page (or, for an experiment without a page, on the query of its source
recommendation): no re-testing until new evidence. Owner decisions are free
text read by their leading verb only (`rejected`, `declined`, `deferred`,
`no_action`, `won't do`, `not now`, `dismissed`, ...; see
`isRejectingDecision`): "approved: investigate the traffic decline" is not a
rejection.

The primary item's `details.priorContext` records what was consulted: the
counts of active and concluded experiments, decisions, rejected
recommendations, and learnings; up to 10 excluded candidates with their
reasons; up to 10 standing site-wide owner decisions (marked "owner
knowledge; never excludes a specific candidate"); and the memory status,
detail, `detailKind`, method, searched source types, and up to 12 returned
references with their record status. The weekly `retrieve_memory` output
carries `detailKind` too.

Candidates come from the current routing run only: the `recommend` workflow
stage receives them from `route_and_score` (never re-queried by period, so an
earlier run's stale opportunity is never recommended), and dry runs assemble
from the in-memory run.

Claims use the labels OBSERVED (with first-party `sources`/`evidence` rows),
INFERRED (route reasons), HYPOTHESIS (expected effect; query-level impact),
RECOMMENDATION, and DATA_UNAVAILABLE (missing metrics, never zero).

**The routing rationale is sourced.** The `<key>.route` claim ("Routed to
<ROUTE>: <reasons>"), for action routes (`draftFor`) and for the no-action
decisions of a single page (`pageRouteDraft`: HEALTHY, EXPERIMENT_ACTIVE,
IRRELEVANT, UNSURE, LOW_DATA), and the site-level `primary.measurement` and
`primary.low_data` observations are built by `reasonsClaim`: they are stored as
`supports` with ONE evidence item (`reasonsEvidence`, kind `observation`)
holding the reasons' recorded inputs (per-query rows with position and
impressions, totals, rates, crawl or URL Inspection observations; the codes
without inputs are listed as `notMeasured`), the date range, and a locator
(`gsc_page_query_daily_current` when query rows are involved, else the inputs'
view, plus the page, query, and `route_decisions`). When no reason has a
measured input (experiment records, configuration, intent only, no rule
matched, or reasons stored before inputs were recorded), the claim is stored
with support `context` and no evidence. The run's route counts
(`primary.routes`) and a running site-wide experiment (`primary.experiment`)
are records, not measurements, and are `context` too: an OBSERVED or INFERRED
claim is never `supports` without an evidence item
(`tests/integration/seo/route-claim-evidence.test.ts`). The weekly report
therefore shows the route claim as supported instead of "Evidence status:
MISSING".

**Synthetic data** (rows with `is_synthetic = 1`, or `AppContext.synthetic` in
the demo profile) is never presented as a real measurement: `markSynthetic`
keeps an observed figure OBSERVED with the synthetic flag and the `[SYNTHETIC]`
text marker (as the report sections do; a value is never placed under
DATA_UNAVAILABLE), prefixes inferences with `Based on SYNTHETIC data:`, and
adds `[SYNTHETIC]` to titles. Evidence items of observed figures and of
inferences (for example the route claim's router inputs) are marked synthetic,
so their sources are written with `source_type = 'fixture'` and
`trust_class = 'synthetic'`. The CLI prints a SYNTHETIC banner and `SYNTHETIC` instead of `OBSERVED`.
`persistRecommendationSet` writes `recommendations` and `claim_evidence`, marks
earlier still-`proposed` recommendations `superseded` (approved, rejected, and
implemented ones are untouched), and marks the chosen opportunity `recommended`.

## CLI

```
npm run cli -- analyze page <url> [--days 28] [--end YYYY-MM-DD] [--search-type web] [--save] [--json] [--dry-run]
npm run cli -- analyze reconcile [--json] [--dry-run]
npm run cli -- analyze route [--days 28] [--limit 5] [--save] [--json] [--dry-run]
npm run cli -- analyze links [--url <url>...] [--max 5] [--json]
npm run cli -- analyze compare <url> [--query <q>] [--competitor <url>...] [--json]
```

- `analyze page` reconciles URLs first. It then prints Search Console and GA4
  metrics (labeled), the join with its date boundaries and mismatch reasons, the
  top queries with intent, the route with reason codes, open technical issues and
  the latest inspection, the score, and a recommendation preview.
- `--save` records the route decision and opportunity for one page, or for
  `analyze route`, decisions, opportunities, and the recommendation set.
- `--dry-run` writes nothing.
- None of these commands spend money or use the network.
- `analyze compare` shows the deterministic comparison for one page and ONE
  query (`--query` is required unless explicit `--competitor` URLs are
  given). It never calls a model.
- The weekly pipeline runs the same comparison as its `compare` stage (after
  `research`, so only in RESEARCH mode with researched queries): for up to 3
  researched candidates with usable competitor pages, our page is compared
  with the competitors of that one query in the localized SERP (configured
  location, language, device). Results are stored in `competitive_comparisons`
  (migration 0210, one row per site, run, query, and page) and attached to
  the primary recommendation. The optional model synthesis
  (`analysis.serp-synthesis`, reasoning tier) runs only with a configured,
  non-fixture reasoning model, outside dry runs, and within 10% of
  `budgets.llmGateway.perRun`; otherwise the row records
  `synthesis_status: skipped` with the reason, and the deterministic
  comparison is still complete.

Workflow stages (`src/seo/stages.ts`): `reconcile_urls -> route_and_score ->
recommend`. They define schemas, prerequisites, `NO_RETRY`, and a cost allowance
(`none` unless an intent hook is injected; an intent hook REQUIRES a non-empty
`intentCostAllowance`, otherwise `createSeoStages` throws, because the engine
rejects an empty allowance). In a dry-run context no stage writes:
reconciliation is rolled back, routing does not persist, and the recommendation
is assembled but not saved. Note that a dry-run routing stage sees the
database as it was before the (rolled-back) reconciliation.

## Verified contract usage (docs/integration-contracts.md, retrieved 2026-09-24)

- **GSC:**
  - Dates are Pacific (America/Los_Angeles); `ctr` is 0..1; `position` is an
    average, so rows are combined by impression weighting.
  - `byPage` aggregates by canonical URI; `byProperty` is separate.
  - Anonymized queries never appear as rows, so query rows are never summed as
    totals.
  - Days with no data are omitted, so zeros come only from coverage.
  - `first_incomplete_date` / `firstIncompleteDate` define freshness; the
    ingestion slice stores these in `gsc_data_availability`, and coverage reads
    them.
- **GA4:**
  - `landingPagePlusQueryString` and `hostName` resolve landing pages.
  - `sessionKeyEventRate:<event>` is the per-event session rate, and
    `keyEvents` counts occurrences.
  - `totalUsers` is a distinct count and is not additive.
  - `(not set)` landing means a session without a `page_view`.
  - Session-scoped `sessionSource`/`sessionMedium` define `google_organic`.
- **Unverified and handled defensively:** whether `sessionKeyEventRate` is
  returned as 0..1 or 0..100. Rows with a rate above 1 make the rate
  `unavailable` instead of being guessed. The ingestion slice must store the
  rate as a 0..1 fraction.
- **URL Inspection:** the indexed version only, not a live test. PASS, FAIL, and
  NEUTRAL are read from `verdict`; `BLOCKED_*` from `indexingState`; failure
  states from `pageFetchState`.

## Data sent externally

The `analyze` commands send nothing. The weekly pipeline sends the following
only when an LLM client and the models are configured:

- `router.classify-intent` (cheap tier) sends the text of ambiguous search
  queries (as `user_reported` evidence), their rule signals, the branded flag,
  and an optional short business context string to the LLM Gateway.
- `analysis.serp-synthesis` (reasoning tier, weekly `compare` stage in RESEARCH
  mode, capped at 10% of `budgets.llmGateway.perRun`) sends summaries of our
  crawled page and competitor pages (URL, title, up to 40 headings, detected
  signals, dates, word count) and the computed comparison.

No analytics identifiers, secrets, or raw metric tables are sent.

## Next steps / access

This slice needs no credentials. It uses data that the GSC, GA4, crawl, and
URL Inspection slices ingest. For live use:

1. Configure `google.searchConsoleProperty`, `google.ga4PropertyId`, and
   `conversions.primaryEvents` (otherwise pages route to
   INVALID_OR_INCOMPLETE_DATA).
2. Configure `brand.aliases` and `market.languages`.
3. Run `analyze reconcile` after each sync or crawl.
4. The weekly pipeline wires `createLlmIntentClassifier` (route stage) and
   `synthesizeComparison` (`compare` stage) with the LLM Gateway client when
   the models are configured. This needs `CHEAP_MODEL`, `REASONING_MODEL`,
   and `LLM_GATEWAY_API_KEY`; see docs/ACCESS_SETUP.md. Without them, routing
   and the comparison stay deterministic and say so.

## Known limitations

- Routing uses page-level byPage totals for segment `''`. Country and device
  segments are compatible only with themselves; per-segment routing is not
  implemented.
- The CTR benchmark needs at least 2 other units and `minImpressionsForOpportunity`
  impressions per position bucket. Small sites often have none.
- Relevance of content signals uses token overlap with business terms. Unclear
  relevance goes to UNSURE, so owner review is expected.
- `crawl_results` JSON shapes (`headings_json`, `redirect_chain_json`,
  `structured_data_json`, the `text_ref` payload) are read leniently, because
  the crawler slice owns their exact shape. The redirect/status shapes are
  pinned by `tests/integration/seo/crawler-contract.test.ts`.
- Temporarily redirected URLs (302/307, probable evidence) are neither merged
  nor routed; their search data stays on their own page identity.
- A 5xx is confirmed only after two consecutive own-site crawls observed it.
- Join issues from `unverified` redirect/canonical evidence are not raised
  (that evidence contradicts equivalence); only `probable` variants with their
  own traffic count as possible splits.
- Owner decisions are free text (no structured vocabulary in the schema); only
  the leading verb is interpreted. Site-wide (subject-less) decisions are
  recorded in `details.priorContext.standingOwnerDecisions` and searched as
  owner knowledge, but nothing parses their free text to exclude a query or
  page.
- Rejected content ideas (`content_items` in stage `rejected`) are memory
  context only; they are not matched against recommendation candidates.
- Pages stored under the older percent-encoding form are rewritten by
  `reconcile_urls`, but modules that look pages up by exact URL (crawler
  store, DataForSEO store, PageSpeed, business-note sync, page analysis,
  publications) do not know the old form. The weekly pipeline crawls before
  it reconciles, so the first crawl after upgrading can create a new-form
  duplicate: reconcile then keeps the older page as the identity and
  resolves the duplicate to it (`ReconcileReport.identities.duplicates`),
  but crawl results and internal links written by that one crawl stay on
  the duplicate id.
