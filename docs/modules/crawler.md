# Crawler, technical checks, and performance adapters

Covers spec sections 16 (crawling and technical checks), 17 (performance and
AEO eligibility signals), 26 (SSRF and untrusted content) and the matching
section-31 tests.

| Area | Code |
| --- | --- |
| SSRF guard | `src/security/ssrf.ts` |
| Transports (DNS-pinned undici, fake, fixture) | `src/crawler/transport.ts` |
| Safe fetcher (limits, redirects, politeness) | `src/crawler/fetch.ts` |
| robots.txt / sitemaps / trap guards | `src/crawler/robots.ts`, `sitemaps.ts`, `traps.ts` |
| HTML extraction (cheerio) | `src/crawler/extract.ts`, `similarity.ts`, `untrusted.ts` |
| Own-site crawl, single page | `src/crawler/crawl.ts` (`crawlSite`, `crawlPage`) |
| Competitor pages | `src/crawler/competitor.ts` (`crawlCompetitorPages`) |
| Technical checks | `src/crawler/checks.ts` (`runTechnicalChecks`) |
| Crawl/index/snippet eligibility | `src/crawler/eligibility.ts` |
| Optional Playwright | `src/crawler/render.ts`, SSRF-enforcing proxy `src/crawler/render-proxy.ts` |
| Status | `src/crawler/status.ts` (`crawlerStatus`) |
| PageSpeed Insights + CrUX | `src/integrations/pagespeed/*` (`checkPerformance`, `pagespeedStatus`, `cruxStatus`) |
| CLI | `src/cli/commands/crawl.ts`, `src/cli/commands/perf.ts` |
| Schema additions | `migrations/0120_crawler.sql` |

## Data flow

```
crawlSite(ctx)
  -> SSRF-validate site.url
  -> robots.txt (per origin, memoized)            -> crawl_robots
  -> sitemaps (robots Sitemap: + /sitemap.xml)     -> crawl_sitemaps
  -> breadth-first crawl of allowedHostnames
       excluded? trap? robots? cap? -> fetch (SSRF-safe) -> extract
       -> crawl_results (+ text in raw store), pages, internal_links
  -> runTechnicalChecks(ctx, crawlId)              -> technical_issues
  -> audit event crawl.finished
```

Every row carries `site_id`; all SQL is parameterized. Visible text is stored
through `ctx.raw` (private workspace `data/raw/`), never in SQLite or the vault.

## SSRF guard (`src/security/ssrf.ts`)

Applied to every generic outbound request: own-site pages, robots.txt,
sitemaps, competitor pages, and every Playwright connection (through the
render proxy, see below).

- Only `http:`/`https:`; URLs with embedded credentials are refused.
- Hostnames refused before DNS: `localhost` and `*.localhost`, `*.local`,
  `*.internal`, `*.localdomain`, `*.home.arpa`, reverse-DNS zones, Docker/Kubernetes
  internal names, cloud metadata names (`metadata.google.internal`,
  `metadata.goog`, `metadata`, `instance-data*`), and single-label names (they
  resolve through local search domains).
- IP literals and every DNS answer are classified. Refused: unspecified,
  loopback, RFC 1918 private, link-local, CGNAT `100.64/10`, multicast,
  reserved/broadcast, documentation and benchmarking ranges, IETF protocol
  assignments, IPv6 unique-local `fc00::/7`, link-local, site-local, multicast,
  anything outside `2000::/3`, 6to4/Teredo, IPv4-compatible, IPv4-mapped
  (`::ffff:a.b.c.d`, always refused) and NAT64-embedded private addresses, plus
  explicit metadata addresses (`169.254.169.254`, `169.254.170.2`,
  `100.100.100.200`, `168.63.129.16`, `fd00:ec2::254`, ...). Decimal, octal,
  hex and short IPv4 forms are normalized by the WHATWG URL parser first and
  are therefore classified too.
- If ANY resolved address is refused, the request is refused (mixed answers
  cannot smuggle a private address).
- Ports: only the scheme default, unless allowlisted per host (`host:port`) or
  globally. The configured `site.url` port is allowlisted for the site's own
  hostnames.
- DNS rebinding: validation returns the resolved addresses and the production
  transport creates a per-request undici `Agent` whose connector `lookup`
  answers only with those addresses (`pinnedLookup`). The socket never performs
  a second resolution; a lookup for any other hostname fails closed. No
  environment proxy is used. The lookup answers asynchronously (like
  `dns.lookup`), so a connection the operating system refuses at once (EPERM
  from an egress firewall, ENETUNREACH) becomes an ordinary network error on
  the request (robots.txt `unreachable` in `doctor --network` and
  `crawl status --network`) instead of an uncaught socket error that ended
  the process. Tests cover this path with a real socket whose `connect()`
  fails synchronously before any packet is sent; the transport has not been
  exercised against a real firewall in tests.
- Redirects are followed manually; every hop goes through the static checks,
  the caller's hop policy (robots, allowed hosts, exclusions) and then DNS
  validation again.
- Test-only escape hatch: `new SsrfGuard({ testOnlyAllowLoopback: true })`
  permits exactly `127.0.0.1` on any port so tests can use a local
  `node:http` server. It is a constructor option only (never read from config
  or environment), every other rule still applies, and crawl results note when
  it is enabled.
- Fixed adapters (Qdrant, LLM Gateway, Google APIs, PSI/CrUX) do not use the
  crawler fetcher; they call their configured endpoints through their own
  clients.

## Fetcher (`src/crawler/fetch.ts`)

`fetchSafely(url, opts)` performs one GET with no retries; `SafeFetcher`
adds per-host scheduling.

- Content-type allowlist checked before the body is read: HTML
  (`text/html`, `application/xhtml+xml`), XML for sitemaps (incl. gzip), plain
  text for robots.txt. Anything else is `unsupported_content`. A response with
  no Content-Type is read (bounded) and must look like markup to count as HTML.
- Byte cap (`crawl.maxBytes`): refused from `Content-Length`, and enforced while
  streaming (the download is abandoned) - `too_large`. Decompressed bytes are
  counted, so compression bombs are bounded too.
- One overall timeout (`crawl.timeoutMs`) covering all hops and the body -
  `timeout`.
- Manual redirects (max `crawl.maxRedirects`), full chain recorded
  (`redirect_chain_json`), loop detection, and a stop at redirects to login
  pages.
- Barriers are recorded, never bypassed: 401/407 and login redirects/forms -
  `login_required`; 403/451 and bot challenges (`cf-mitigated`) -
  `access_denied`; 429 and 503 with Retry-After - `rate_limited`.
- `SafeFetcher`: `KeyedLimiter` per host (`crawl.perHostConcurrency`), a minimum
  delay between request starts per host (`crawl.requestDelayMs`, raised by
  robots.txt `Crawl-delay`, capped at 60 s), and bounded Retry-After handling.
  Every rate-limited outcome (429, or 503 with Retry-After) pushes the host's
  next request back by the Retry-After (or an exponential backoff), up to 2
  retries. A Retry-After longer than 60 s is not waited for: the host enters a
  back-off until that time and NO further request is sent to it. Queued and
  later URLs get `rate_limited` rows ("not requested") without a request. A
  per-host streak of 3 give-ups also stops requests to that host.
- User-Agent comes from `crawl.userAgent`; robots groups match its product
  token (text before the first `/`).
- Only relevant response headers are stored, redacted; cookies never.

## Discovery

- robots.txt (robots-parser): 2xx parsed; 4xx other than 429 means no
  restrictions; 429, 5xx, timeouts, network errors, DNS failures, oversize or
  unexpected content types mean the origin is treated as disallowed for this
  crawl (never guessed as allowed; state `unreachable`, with the fetch error
  code kept in `RobotsInfo.errorCode`). An unsafe origin (an SSRF policy
  refusal, state `unsafe`) is never contacted. A DNS failure is never
  reported as unsafe: it is a transient network problem.

## DNS and network failures of the own-site crawl

A hostname that does not resolve (resolver error, timeout, empty answer; the
guard's `dns_failure`) is a transient network/DNS problem, not an SSRF
refusal, the same rule as the competitor crawler:

- `crawlSite` / `crawlPage` fail with `stopReason` "DNS resolution failed for
  <host> (transient network/DNS problem)", `failureCode:
  'CRAWL_NETWORK_ERROR'`, and a retry next step (check the network and DNS,
  re-run, `crawl status --network`). The baseline/weekly `crawl_site` stage
  carries that next step as its hint. A DNS failure after the start check
  (robots.txt or the start page) gets the same code and next step; page
  fetches that fail DNS are recorded as `network_error` (re-crawl later).
- A real SSRF refusal of the start URL keeps `failureCode:
  'CRAWL_START_URL_REFUSED'` and the "site.url must be a public http(s) URL"
  next step.
- `crawl status --network` / `doctor --network`: DNS failures, connection
  errors and timeouts are `unreachable` (doctor WARN) with the retry next
  step; only an SSRF refusal of site.url is `misconfigured` (doctor FAIL).
- Sitemaps: robots `Sitemap:` lines plus `/sitemap.xml`; sitemap indexes are
  followed breadth-first with `crawl.maxSitemapFiles`, `crawl.maxSitemapUrls`,
  nesting depth 3 and the byte cap. gzip is decompressed with a hard output cap,
  otherwise skipped with a reason. XML is parsed without entity expansion
  (DOCTYPE stripped; only predefined and numeric entities decoded in `<loc>`).
  Sitemap files and URLs outside `site.allowedHostnames` are skipped and counted.
- Trap guards (`TrapDetector`): URL length, path depth, repeated path segments,
  session-id parameters, too many query parameters, too many query variants per
  path, calendar-like URL templates, numeric template explosions. Hits are
  recorded as `crawl_trap` and reported as a coverage limit, not a site defect.
- `crawl.excludedPaths` (prefix or `*` glob) are recorded as `excluded` and never
  requested. Non-HTML file extensions are recorded as links but not fetched.
- Page-level `meta robots nofollow` is respected for link discovery.

## Extraction (`src/crawler/extract.ts`)

Title (and count), meta description, meta robots (`robots`, `googlebot`),
X-Robots-Tag (crawler-scoped rules parsed; other crawlers' rules recorded but
not applied), canonicals from HTML and the `Link` header (all of them, for
conflict checks), hreflang (HTML + header), h1-h6, visible text (scripts,
styles, templates, hidden elements, nav/header/footer/aside removed, block
structure kept), word count (`Intl.Segmenter`, works for non-Latin scripts),
declared language, internal/external links with anchor, rel/nofollow, context
snippet and a navigation flag, images with alt status (`missing` vs `empty` vs
`present`) and decorative hints, JSON-LD parsed with `JSON.parse` only (never
executed; invalid blocks reported), microdata/RDFa types, login forms, meta
refresh, a client-rendered-shell hint, content hash, SimHash, and an
instruction-like-text flag.

Login walls (`loginBarrierAssessment`) are a heuristic. A 2xx page counts as
a barrier (`login_required`, links not followed) only when all three hold:

- a password input in the main content. Inputs in header, nav, footer, aside,
  dialogs or hidden containers do not count, so a site-wide sign-in widget
  never blocks a public page;
- a sign-in signal: a login-like URL path or host, title, or H1/H2;
- fewer than 250 words of main content.

Anything else is kept as a hint (`loginForm`, `loginHint`). Barrier rows record
`barrierDetection: login_form_heuristic` and the signals, and are never
reported as confirmed.

## Storage

- `crawls`: one row per run (`own_site`, `single_page`, `competitor`) with the
  plan in `config_json`, counts, status, stop reason and `is_synthetic`. Status
  is `completed` only when the frontier was exhausted. It is `partial` when a
  cap left URLs unvisited, sitemap discovery was truncated, or URLs were left
  unfetched because of rate limits, timeouts or network errors (the stop
  reason counts them). Other statuses are `failed` and `cancelled`.
- `crawl_results`: one row per requested URL. A redirecting URL keeps the first
  status and the chain, and `extraction_json.finalStatus` holds the status of
  the final response when the chain was followed to the end. The final URL of
  a completed chain on an allowed host gets its own row (and `pages` row) from
  the same response, with no second request. This includes non-2xx finals such
  as 404, 410 and 5xx, so a redirect to a dead page is visible. Blocked or
  skipped URLs are rows with `blocked_reason` and an explanation in `error`.
- Migration `0120_crawler.sql` (additive): `crawl_results.depth`,
  `discovered_via_json`, `in_sitemap`, `text_simhash`, `extraction_json`; tables
  `crawl_robots` (per crawl/origin) and `crawl_sitemaps` (per crawl/file).
- Migration `0201_observation_provenance.sql` (additive):
  `crawl_results.transformation_version` (the extractor version) and
  `crawl_results.raw_ref`, a reference to a bounded, redacted raw response
  (status, redirect chain, relevant headers, body SHA-256, a bounded text
  body; binary bodies are stored as a hash only). Technical issues record
  their checks version (`CHECKS_VERSION` = `technical-checks@1` in
  `src/crawler/checks.ts`) when a finding is opened and again whenever it is
  observed again (`ON CONFLICT DO UPDATE`; an owner's `ignored` status is
  kept). Rows written earlier keep `NULL` (unknown) until the finding is
  seen again; the `resolved` update does not touch the version.
- `pages`: upserted by normalized URL (`src/seo/url.ts`), `lifecycle` from the
  observed status, `is_protected` / `is_excluded` from config. The crawler does
  not create `url_aliases`; reconciliation reads redirect chains and canonicals.
- `internal_links`: own-site links only; `target_page_id` resolved after the
  crawl.

## Technical checks (`runTechnicalChecks`)

Upserted into `technical_issues` (unique per site/url/type); `ignored` stays
ignored. Resolution is conservative:

- An open issue is marked `resolved` only when its URL was actually observed
  again and the issue was not found. Observed means 2xx content, a redirect,
  404/410 or another definitive 4xx. After a timeout, network error, rate
  limit, 5xx, 401/403/407/451 barrier, heuristic login wall, robots/excluded/trap
  skip, oversize or unsupported response, the URL's open issues are left
  unchanged. A robots-blocked row can resolve only robots-derived issues.
- Cross-page issues (broken links, internal redirects, canonical targets,
  duplicates, hreflang reciprocity, sitemap/robots membership) are resolved
  only after a COMPLETE own-site crawl (`completed`, started from `site.url`,
  sitemaps on). A partial, capped, rate-limited or single-page crawl reports
  them but never resolves them, and the summary says so.

| Issue type | Meaning | Flags |
| --- | --- | --- |
| `broken_internal_link` | linked URL returned 4xx/5xx, directly or at the end of its redirect chain (`viaRedirect`, `finalStatus`) | confirmed for 404/410 |
| `internal_link_unreachable` | linked URL timed out / network error | suspicion |
| `redirect_chain`, `redirect_loop` | redirect problems (chain detail includes the final status) | loops confirmed |
| `redirect_chain_too_long` | chain exceeded this crawler's `crawl.maxRedirects` | suspicion (medium): a local cap, not proof search engines give up |
| `internal_link_to_redirect` | internal links point at a redirect that ends in a non-error response | info |
| `canonical_multiple`, `canonical_header_conflict`, `canonical_target_not_ok`, `canonical_noindex_conflict`, `canonical_cross_domain` | conflicting canonical signals | target 404/410 (directly or after its redirects) confirmed |
| `accidental_noindex` | noindex on a protected, sitemap-listed or internally linked page | confirmed (observed), intent unverified |
| `robots_blocked_in_sitemap`, `robots_blocked_protected` | robots.txt blocks a listed/protected URL | confirmed |
| `sitemap_url_not_ok` | sitemap lists a non-200 URL | 404/410 (directly or after redirects) confirmed |
| `access_blocked` | login/access barrier on an own URL (`detection`: `http_status`, `login_redirect`, `login_form_heuristic`) | confirmed only for 401/403/407/451; login redirects and sign-in forms are suspicions; info unless protected/in sitemap |
| `snippet_restricted` | nosnippet / max-snippet:0 (also blocks AI Overviews/AI Mode input) | info |
| `missing_title`, `multiple_titles`, `missing_meta_description` | observed metadata gaps | missing description is low severity |
| `title_length`, `meta_description_length`, `missing_h1`, `duplicate_title`, `duplicate_meta_description` | EDITORIAL HEURISTICS, not ranking rules | `is_heuristic = 1` |
| `suspected_duplicate_content`, `suspected_near_duplicate` | same text hash / SimHash distance <= 3 | always suspected (`confirmed = 0`) |
| `image_missing_alt`, `linked_image_without_text` | alt problems with decorative context | info when all images look decorative |
| `hreflang_missing_return`, `hreflang_missing_self`, `hreflang_invalid_code`, `hreflang_target_not_ok` | hreflang reciprocity and validity | |
| `server_error` | 5xx on an own URL | suspicion (may be transient) |
| `content_requires_javascript[_suspected]` | raw HTML is an app shell; rendered comparison when available | suspected is a heuristic |
| `structured_data_invalid_json`, `meta_refresh` | observed | |

Never claimed: that a 200 page is indexed (see `assessSearchEligibility`: "no
blocking directive observed"), that low word count means low quality, or that a
duplicate title justifies deletion. `confirmed = 1` means the blocker was
observed, not that it is a mistake: noindex may be intentional and needs owner
confirmation; nothing is changed without approval.

## Competitor pages (`crawlCompetitorPages`)

- Targets are grouped by query; default `crawl.competitorPagesPerQuery` (5),
  requests above `crawl.competitorPagesPerQueryMax` (10) are clamped and noted.
  Own-site URLs are skipped.
- Full SSRF validation, then robots.txt, then one fetch. Blocked pages
  (`robots`, `access_denied`, `unsafe_url`, ...) produce a `blocked` outcome
  with the reason and "No content was fetched or inferred". A heuristic login
  wall (HTTP 200 sign-in page, same rules as above) is reported as "Login
  barrier (heuristic)", and its text is not stored, analysed or used. If
  nothing could be fetched, the run is `failed` with a next step.
- Text is stored verbatim in the raw store as untrusted data;
  `sources` gets a `competitor_page` row with `trust_class = scraped_untrusted`.
  Instruction-like text is flagged (`injectionSuspected`) and never acted upon;
  tests verify that approvals, budgets and configuration are untouched.
- `competitor_pages` keeps the latest content hash; `competitor_changes`
  records `new_page`, `content_changed`, `title_changed`, `status_changed` (a
  block is not treated as a change).
- **Runtime mode.** `crawl competitor` needs `--mode RESEARCH` (policy
  `external_research`); a `--dry-run` preview is allowed in ANALYZE.
- **Scope.** A URL given without a query (manual) is fetched only when its
  host is a configured competitor (`research.competitors`) or listed in
  `research.approvedDomains` (subdomains match), or when the stored page was
  discovered in a SERP. Anything else is `not_approved` and never fetched;
  the monthly re-check skips stored manual pages that are no longer approved.
- **Scope with a query.** A query is a claim, not evidence: any text can be
  passed with `--query`. A URL given with a query is fetched only when a stored
  SERP snapshot of that query (compared after normalization: NFC, collapsed
  whitespace, lower case) lists it, or when its host is approved. Only live
  snapshots count; DataForSEO sandbox snapshots count only in synthetic (demo)
  contexts. Anything else is `not_approved` and never fetched (no request, not
  even `robots.txt`). A URL admitted by a stored SERP is recorded as
  SERP-discovered; one admitted only by an approved host is recorded as
  manual. Each outcome carries `scope`: `serp_snapshot`, `approved_domain`,
  `stored_serp_page`, or `manual_urls`.
- **`--manual-urls`.** With `--query`, the owner can vouch for URLs they
  checked by hand that no stored SERP of the query lists. Such pages are
  crawled with scope `manual_urls` (stored on each crawl result), recorded as
  manual competitors (never as SERP-discovered, so they gain no SERP
  provenance for later re-crawls without a query), listed in the audit event
  `crawl.competitor_manual_urls` before anything is fetched, and counted in
  `crawl.competitor_finished`. The result note is written after the fetches
  and counts outcomes ("N of M manual page(s) fetched on the owner's word
  ...; K blocked[, F failed]"), so a run where every URL was refused never
  says pages were crawled. `--manual-urls` without `--query` is rejected
  (`VALIDATION_FAILED`).
- **Freshness TTL.** A page whose last successful snapshot is younger than
  `research.dataforseo.cacheDays.competitor` is reused as `cached` (no
  request). The TTL is halved for pages that changed within the last window
  and doubled for pages unchanged over three or more checks; `0` disables
  reuse, and `--refresh` bypasses it. A snapshot whose latest check was
  blocked or failed is never reused.
- **Failures.** A DNS resolution or connection failure is `failed` with
  `failureReason` `dns` or `connection` and stays eligible for retry; only a
  real SSRF policy block (a private or otherwise unsafe destination) is
  `blocked` with `unsafe_url`.
- **Refused destinations are never tracked.** The SSRF guard (scheme, host,
  DNS answers) runs before a URL becomes a competitor: a URL refused by
  policy (loopback, private, link-local, metadata, blocked port, including
  `--manual-urls` URLs) is recorded only as a crawl result (`blocked`,
  `unsafe_url`, no request), never as a `competitors` or `competitor_pages`
  row, so the monthly re-check never retries it. A page tracked before this
  rule keeps its row, but a refusal does not advance its `last_checked_at`.
  Every competitor crawl result records `pageRequested` (whether a request for
  the page itself was sent); the vault's competitor notes write "last checked
  <date>" only for a check that requested the page, and "blocked before any
  request (SSRF guard)" or "not fetched: ..." otherwise
  (`competitorPageCheckText` in `src/obsidian/notes-site.ts`).

## Optional Playwright (`src/crawler/render.ts`)

Playwright is not a dependency. `import('playwright')` is attempted lazily; if
it fails, rendering reports `optional_disabled` and the raw crawl continues.
When available (and `features.playwright` is on and `--render` is passed),
only pages whose raw HTML looks like a client-rendered shell are rendered (max
10 per crawl) in a fresh context (downloads off, service workers blocked).

Playwright's `route()` is called only for the first URL of a redirect chain,
and never for WebSockets. Route interception alone therefore cannot stop a
page script or subresource that is redirected to `169.254.169.254` or a
private IP. The renderer uses these layers:

1. The top-level URL passes the SSRF guard before a browser is launched.
2. **SSRF-enforcing proxy** (`render-proxy.ts`). Chromium is launched with
   `proxy: { server: http://127.0.0.1:<ephemeral>, bypass: '<-loopback>' }`,
   which removes Chromium's implicit proxy bypass for loopback. Every plain
   HTTP request, every CONNECT tunnel (HTTPS and WSS), and every redirect hop
   is a new request to the proxy. The proxy validates it with the guard and
   connects only to the validated address, so connections are DNS-pinned like
   the HTTP fetcher. It never follows redirects, refuses plain-HTTP WebSocket
   upgrades, and enforces a request cap. The launch flag
   `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` stops WebRTC
   from sending UDP outside the proxy. If the proxy cannot start, nothing is
   rendered.
3. `context.route('**/*')` validates each request before it is sent, enforces
   the subrequest cap, and skips media, fonts, WebSockets, event streams and
   manifests.
4. `context.on('request')` re-validates every redirect hop
   (`request.redirectedFrom()`). A refused hop closes the page and discards the
   render: status `blocked`, and no HTML is kept.
5. `context.routeWebSocket(/.*/)` (Playwright 1.48 and later) closes every
   WebSocket.

The final page URL is validated again before any HTML is returned.
`RenderResult.protections` lists the layers that were active; an older
Playwright without `routeWebSocket` or request events still gets layers 1 to 3.

Raw-vs-rendered discrepancies (title, description, canonical, robots, h1, word
count, links, structured data types) are stored in `render_discrepancies_json`,
with the disclaimer that a local Chromium render is not equivalent to
Googlebot. A discarded or failed render is noted in the crawl result.

Verification status: the proxy is tested offline as a real HTTP/CONNECT proxy
against a local server. It passes allowed requests, returns redirects
unfollowed, and refuses metadata, private, DNS-private, loopback-name,
bad-port and over-cap destinations. Layers 3 to 5 are tested with a fake
Playwright that simulates redirect hops the way Playwright documents them
(request events but no `route()` call). Playwright is not installed in this
repository, so none of this has been run against a real Chromium. The
`<-loopback>` bypass rule, the WebRTC flag, and `routeWebSocket` rely on
documented Playwright and Chromium behaviour and need a live check after
installing Playwright.

## Performance (`src/integrations/pagespeed`)

Verified contract usage (docs/integration-contracts.md section 5, 2026-09-24):

- PSI `GET https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed`
  with `url`, `strategy` (always sent; the default would be desktop), repeated
  `category`, optional `key`. Lab data from `lighthouseResult` (scores 0-1 shown
  as 0-100, audit `numericValue`s, `lighthouseVersion`, `configSettings.formFactor`,
  `runWarnings`); a `runtimeError` discards the numbers.
- Field scope from PSI: `loadingExperience` is page-level unless
  `origin_fallback` is true; `originLoadingExperience` is origin-level; no
  metrics means unavailable. Stored with `field_scope` page / origin / unavailable.
- CrUX `POST https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=`
  with exactly one of `url`/`origin`, `formFactor`, and the recommended metrics.
  Fallback url+formFactor -> origin+formFactor -> origin; 404 means
  insufficient data (unavailable), not an error. CLS strings parsed with
  `Number()`, open-ended bins kept. Ratings use the documented thresholds and
  the documented CWV assessment rules (INP missing -> LCP+CLS; LCP or CLS
  missing -> not assessable).
- INP is never derived from lab data (`lab.inp` is always null; TBT is labelled
  a lab proxy). Lighthouse scores carry a disclaimer that they are diagnostics,
  not business outcomes or ranking explanations.

Behaviour: `checkPerformance(ctx, url, { reason, justification? })` needs an
own-site URL and never iterates the site. The reason is ENFORCED
(`justifyPerformanceCheck`); unjustified checks fail with `VALIDATION_FAILED`
before any request:

- `priority_page` (the CLI default): the URL must be one of
  `selectPriorityPages(ctx, 10)`. Those are the site root, protected pages, and
  the top pages by GSC clicks over the latest 28 days (`perf priority` lists
  them).
- `material_change`: `detectMaterialChange` must find evidence. The two latest
  own-site crawl observations of the URL must differ in content hash, HTTP
  status or title. A change that was already checked for that device on an
  earlier UTC day needs `force`; a same-day repeat is served from the cache.
- `manual`: an explicit exception that requires a written `justification`
  (`--reason manual --justification "<why>"`).

The justification (reason, detail, evidence) is returned in the result and
stored in every `performance_checks.metrics_json`. The reason and detail are
also part of the (hashed) `provider_requests` parameters. A
`perf.check_requested` audit event records the full justification whenever
requests are about to be made.

Results are cached per source + url + device + UTC day (CrUX refreshes daily);
`force` re-runs. A cached lab row whose Lighthouse run failed (`runtimeError`)
is served as a FAILED lab result, with its error and a `--force` hint, never as
a good cached result. Rows: `psi_lab` (lab), `psi_field` and `crux_api` (field)
in `performance_checks`, each with device, timestamp, tool version, cache key
and raw reference. Every HTTP request is logged in `provider_requests`
(`is_paid = 0`). The CrUX fallback chain logs one row per attempt: url +
formFactor, then origin + formFactor, then origin. A 404 "no data" answer is
logged as `succeeded` with `http_status = 404`. Both APIs are free, so no
budget reservation is made. PSI is retried once on 5xx, and on 429 only when a
key is configured (a keyless 429 means quota 0, so retrying is pointless).

Unverified (kept configurable/defensive, see the contract's "Unverified" list):
PSI field keys other than `FIRST_CONTENTFUL_PAINT_MS`,
`INTERACTION_TO_NEXT_PAINT` (`LARGEST_CONTENTFUL_PAINT_MS`,
`CUMULATIVE_LAYOUT_SHIFT_SCORE` are stored with `keyVerified: false`; PSI CLS
scaling is undocumented, so CrUX is preferred for CLS and CWV assessment); PSI
responses without any field data; quota numbers; CrUX error shapes other than
404; enum casing.

## CLI

```
npm run cli -- crawl [--max-pages N] [--max-depth N] [--no-sitemaps] [--render] [--no-checks] [--dry-run] [--json]
npm run cli -- crawl page <url> [--render]                     # includes the heuristic AEO assessment
npm run cli -- crawl aeo [url] [--limit N]                     # AEO assessment from stored crawl results; no network
npm run cli -- --mode RESEARCH crawl competitor <urls...> --query "<query>" [--manual-urls] [--max-per-query N] [--refresh]
npm run cli -- crawl status [--network]
npm run cli -- crawl issues [--all]
npm run cli -- perf check <url> [--device mobile|desktop] [--reason priority_page|material_change|manual] [--justification "<why>"] [--force] [--no-psi] [--no-crux]
npm run cli -- perf priority
npm run cli -- perf status [--network]
```

`--dry-run` shows the bounded plan / the exact PSI request (without the key)
and makes no requests or writes; `--offline` produces an honest `offline`
status. None of these commands spend money. While a baseline, weekly, or
monthly job (or another manual command) holds the site lease, `crawl`,
`crawl page`, `crawl competitor`, and `perf check` refuse with `LOCKED`; while
they run they hold the lease themselves, so a scheduled job does not start in
the middle of a long crawl (see [CLI.md](../CLI.md)).

**AEO assessment** (`src/crawler/aeo.ts`, spec section 17). `crawl aeo`
reads stored crawl results only (no request): for one URL, or for the pages
of the latest own-site crawl (`--limit`, default 50). `crawl page` includes
the same assessment for the page it just fetched. Deterministic heuristics
check whether the page answers its top Search Console queries near the top,
whether headings are descriptive and question headings are answered,
whether sections are self-contained (no back-references), whether figures
cite evidence, and the observed crawl, index, and snippet eligibility.
Without Search Console queries the answer check is DATA UNAVAILABLE, not a
guess. The phrase patterns are English; on other languages they
under-report and say so. The same assessment is shown on the vault page
notes and the `09 AI Search` note (`src/obsidian/notes-site.ts`), in the
monthly report, and in the weekly report when the weekly `site_structure`
stage supplied it (`src/reports/sections-site.ts`): the heuristic checks are
INFERRED, crawl/index/snippet eligibility is OBSERVED, and factual
consistency is DATA UNAVAILABLE (the heuristics do not verify facts; new
drafts are checked by the content quality gates). Without an own-site crawl
every AEO claim is DATA UNAVAILABLE, never 0.

## Data sent externally

- Crawler: HTTP GET requests with the configured User-Agent to your own site
  (robots.txt, sitemaps, pages) and, for competitor research only, to the
  selected competitor pages and their robots.txt. No cookies, credentials, or
  API keys. DNS lookups for those hostnames go to the system resolver.
- Playwright (optional): the page and the subresources that pass the SSRF
  guard, loaded by a local headless Chromium through the local guarded proxy.
- PSI: the URL checked and `PAGESPEED_API_KEY`, to Google. Google fetches the
  URL and runs Lighthouse on its infrastructure.
- CrUX: the URL or origin, form factor, metric names, and the key, to Google.

## Limitations

- Crawling is HTTP-first; JavaScript-only content is visible only with the
  optional Playwright render, which is not Googlebot. The render's SSRF layers
  have not been exercised against a real Chromium in this repository (see
  "Verification status" above).
- Login-wall detection on 2xx pages is a heuristic (see Extraction). Unusual
  sign-in pages with long body text are not treated as walls; they are
  crawled as content and flagged only as a hint.
- Trap guards and caps bound coverage; "orphan" or "broken" verdicts apply only
  to what was crawled.
- Duplicate detection is exact-hash plus SimHash on extracted text: suspicion
  only.
- Language is the declared `html lang` / `Content-Language`; no statistical
  language detection.
- PSI may stop embedding CrUX data (announced by Google); CrUX is the primary
  field source.
- In offline/demo mode the crawler only runs with an injected fixture transport
  (`fixtureSiteTransport`), and such crawls are flagged synthetic.

## Credentials and access (next steps)

1. Crawling needs no credentials. Check reachability with
   `npm run cli -- crawl status --network`, then run `npm run cli -- crawl --dry-run`
   and `npm run cli -- crawl`.
2. Performance: create a Google Cloud API key, enable **PageSpeed Insights API**
   and **Chrome UX Report API** for its project, restrict the key to those two
   APIs, and put `PAGESPEED_API_KEY=...` in `<workspace>/secrets/secrets.env`
   (never in chat or the vault). Set `features.pagespeed: true` (it is off in
   the core profile). Verify with `npm run cli -- perf status --network` (one
   free CrUX query), then `npm run cli -- perf check <priority URL>`. Keyless PSI
   is documented as possible but was observed failing with HTTP 429 (quota 0).
3. Rendering (optional): `npm install playwright`, `npx playwright install chromium`,
   set `features.playwright: true`, run `npm run cli -- crawl --render`. Before
   relying on it, verify the SSRF layers against a real browser on a test page
   you control. The page should redirect a script request to a private
   address (for example `10.0.0.1`) and open a WebSocket. Check that the crawl
   result lists both under `blockedSubrequests` and that
   `RenderResult.protections` includes `guarded_proxy`, `redirect_hop_check`
   and `websocket_block`.
