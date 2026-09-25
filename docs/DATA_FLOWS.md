# Data flows: what leaves your machine

seo-agent is **local-first**: your configuration, credentials, vault, SQLite
database, raw responses, reports, logs, and backups live in your private
workspace on your machine or server.

**Local-first does not mean that external API processing is local.** Every
integration you enable sends requests to a third-party service, which
processes them on its own infrastructure under its own terms and privacy
policy. This page lists, per integration, exactly what is sent. Disabled
integrations send nothing. The Demo profile and `--offline` send nothing.

Provider facts below come from `docs/integration-contracts.md` (primary
documentation retrieved 2026-09-24). Recheck provider terms yourself.

## Summary

| Integration | Enabled by | Receives | Never receives |
| --- | --- | --- | --- |
| LLM Gateway (and the model provider it routes to) | `features.llm` / `features.embeddings` + `LLM_GATEWAY_API_KEY` | prompts with evidence excerpts, embedding input text, model IDs, token limits, your API key (only over `https://`, or plain `http://` to a loopback proxy) | other credentials, raw analytics exports, full vault, personal identifiers (masked before sending unless the site config sets `llm.allowPersonalData: true` with a stated `llm.personalDataReason`) |
| Google OAuth | `auth google` | OAuth client ID/secret, authorization code, refresh token (token requests only) | anything else |
| Google Search Console API | `features.gsc` | your property ID, date ranges, dimensions, filters; URLs you inspect with URL Inspection | other providers' data |
| Google Analytics Data API | `features.ga4` | your GA4 property ID, date ranges, dimensions, metrics, filters | other providers' data |
| PageSpeed Insights | `features.pagespeed` + key | page URLs to test, strategy/categories, API key; Google then loads those pages | anything else |
| Chrome UX Report (CrUX) | `features.pagespeed` + key | page URLs or origins, form factor, API key | anything else |
| DataForSEO | `features.dataforseo` + mode `sandbox`/`live` + credentials | search queries (keywords), location and language codes, device, depth, task IDs, Basic-auth credentials | your analytics, site content, other credentials |
| Apify (Actor `9sHOY9RzPYGjmTHo8`) | `features.apify` + `APIFY_TOKEN` | Actor input: search terms, at most one community per run (`withinCommunity`, from `research.subreddits` with `apify research`), sort, time range, result/comment limits, run caps (memory, timeout, max charge); your token | Google/Gateway/CMS/DataForSEO/database credentials, analytics, site content, vault notes |
| Web crawler (and optional Playwright) | `features.crawl` / `features.playwright` | HTTP requests to your own site and to competitor/approved domains, with the configured User-Agent and your IP address | cookies, credentials, other data |
| Qdrant | `features.qdrant` | embedding vectors plus a metadata payload (ids, site, source type, trust class, status, language, content hash, dates), **stored on your Qdrant server** (localhost by default); `QDRANT_API_KEY` when set, only over `https://` or to a loopback host | chunk text (it stays in your local SQLite database), other credentials |
| Obsidian | never contacted | nothing: the vault is plain files; the Obsidian app is optional | n/a |
| AI-citation monitoring | `features.aiCitations` (manual import only) | nothing: observations come from files you import | n/a |
| Maintainers / telemetry | never | **nothing**: no telemetry, analytics, crash reporting, update checks, or diagnostics upload | n/a |

## Per integration

### LLM Gateway (runtime language models and embeddings)

- **Endpoint:** `LLM_GATEWAY_BASE_URL` (default `https://api.llmgateway.io/v1`), `Authorization: Bearer <LLM_GATEWAY_API_KEY>`.
  The base URL must be `https://`; plain `http://` is accepted only for a
  loopback host (a local proxy), so the key never travels unencrypted over a
  network. Otherwise nothing is sent.
- **Sent for chat/structured calls:** the versioned prompt template and its
  variables, plus an evidence bundle: numbers computed by code (never raw
  exports), short excerpts of crawled page text (yours and competitors'),
  SERP snippets, redacted Reddit excerpts, retrieved vault/business-note
  excerpts, and approved business facts from your configuration. Also the
  model ID, token ceilings, and provider parameters.
- **Sent for embeddings:** the text of chunks being indexed (business notes,
  source excerpts, briefs, experiment summaries, learnings). Secrets are
  rejected, and personal identifiers (emails, phone-like numbers, user
  handles, IP addresses, analytics ids) are masked before embedding.
- **Onward processing:** LLM Gateway routes the request to an upstream model
  provider. That provider's data-retention and training policies apply; check
  them for the models you select.
- **Personal identifiers are masked before sending.** Emails, phone-like
  numbers, user handles (`u/...`, `@...`), IP addresses, and analytics client
  or user ids in evidence, tool results, data-block labels, and embedding
  inputs are replaced with placeholders. Chat and structured-output requests
  send them unmasked only when the site config sets
  `llm.allowPersonalData: true` **and** a non-empty `llm.personalDataReason`;
  the request record then says so, and `config validate` repeats the reason
  as a warning. Embedding inputs stay masked either way. See
  [PRIVACY.md](PRIVACY.md#personal-data-and-language-models).
- **Not sent:** your other credentials, full raw analytics datasets, or the
  whole vault. Secret redaction runs on evidence before it is sent.

### Google (OAuth, Search Console, GA4, URL Inspection, PageSpeed, CrUX)

- **OAuth:** the desktop loopback flow sends your OAuth client ID/secret,
  the authorization code, PKCE verifier, and later the refresh token to
  Google's token endpoint. Requested scopes are read-only
  (`webmasters.readonly`, `analytics.readonly`). A service-account setup
  instead signs a JWT with your service-account key locally and exchanges it.
- **Search Console:** API requests for **your** property (exact property ID,
  date ranges, dimensions, filters, row limits). Page/query requests filter by
  one of your page URLs at a time; pages whose rows were stored as not final
  are requested again once Google reports those dates final. With
  `market.countries` or `market.devices` set, the weekly and monthly jobs also
  request country/device page totals for the report period. URL Inspection
  sends the URLs you inspect. No sitemap submission, indexing requests, or
  property changes.
- **GA4 Data API:** requests for **your** numeric property ID (dimensions,
  metrics, date ranges, filters, metadata/compatibility checks).
- **PageSpeed Insights:** the URLs you test; Google's infrastructure then
  fetches and renders those pages. **CrUX:** URLs or origins and form factor.
  Both use your API key.
- Google already holds the analytics data being read; responses are stored
  locally in your workspace.

### DataForSEO

- **Endpoint:** `https://api.dataforseo.com/v3` (live) or
  `https://sandbox.dataforseo.com/v3` (sandbox; synthetic data), HTTP Basic
  auth with your API login and password.
- **Sent:** the keywords/queries you research, location and language codes,
  device, SERP depth, and task IDs when collecting results. Only shortlisted
  queries are sent (three to five serious queries per run by default).
- **Not sent:** your analytics numbers, site content, or other credentials.
- Results are cached locally (SERPs about 7 days, keyword volumes about 30
  days) to avoid repeat requests.

### Apify (Reddit Scraper Actor `9sHOY9RzPYGjmTHo8`)

- **Endpoint:** `https://api.apify.com`, `Authorization: Bearer <APIFY_TOKEN>`.
- **Sent:** the Actor input (search terms, sort, time range, result and
  comment limits, and at most one community per run) and run options (build,
  memory, timeout, `maxTotalChargeUsd`). `apify research` starts one bounded
  run per entry of `research.subreddits` and sends that name in the actor's
  `withinCommunity` field; `--all-reddit` (or an empty list) sends none.
  `apify test` sends no community. The direct-URL inputs (`startUrls`,
  `subredditUrls`) are always sent empty. AI add-ons, webhooks, and outbound
  delivery are disabled in the input where the Actor supports it.
- The LLM signal classifier is off by default. With
  `apify research --classify-with-llm`, the normalized, personal-data-minimized
  post and comment excerpts go to the LLM Gateway (see above) as untrusted
  evidence.
- The Actor then queries Reddit on your behalf; Apify stores the run and its
  dataset in **your** Apify account under your plan's retention.
- **Not sent:** any other credential, analytics, site content, or vault notes.
- Author/profile fields are not requested or retained (see `docs/PRIVACY.md`).

### Web crawler and optional Playwright

- Requests go directly from your machine to your site and to competitor or
  approved research domains, respecting robots.txt, rate limits, and size/time
  caps. Target servers see your IP address and the configured User-Agent.
- No cookies, credentials, or form submissions are sent. Login walls and
  access denials stop the crawl.
- Private, loopback, link-local, and metadata addresses are blocked (SSRF
  guard).

### Qdrant

- **Stored in Qdrant:** one point per indexed chunk: the embedding vector
  plus a metadata payload: ids (site, document, chunk, embedding version,
  chunker version), source type, trust class, status, record status, access
  scope, language, superseded flag, content hash, occurrence, document
  version, and the source date (`MemoryPointPayload` in
  `src/memory/qdrant.ts`). **No chunk text is stored in Qdrant:** the text
  stays in your local SQLite database, which memory search reads after
  Qdrant returns matching ids. A vector is derived from the chunk text, so
  treat the collection as private data all the same.
- Default `QDRANT_URL=http://127.0.0.1:6333`: the vectors and metadata stay
  on your machine (Docker Compose).
- If you point `QDRANT_URL` at a remote server, that server stores the same
  vectors and metadata; protect it with `QDRANT_API_KEY`, TLS, and network controls. With an
  API key, a non-loopback `QDRANT_URL` must use `https://`: the client refuses
  to send the key over plain HTTP, and memory search stays full-text only
  until that is fixed.
- **The Qdrant server itself (third-party software, not seo-agent) may send
  anonymized usage statistics to its vendor unless telemetry is disabled.**
  `compose.yaml` tries to disable it with an environment setting whose exact
  key name was NOT verified against Qdrant's current documentation. To be sure:
  check the Qdrant documentation for your image version, confirm the setting in
  the server's startup log or configuration, and/or block the container's
  outbound internet access (for example an `internal: true` Docker network, or
  a host firewall rule), since seo-agent only needs to reach Qdrant, not the
  other way round. seo-agent sends no telemetry of its own.

### AI-citation observations (optional)

`ai-citations import` reads a file you captured yourself and sends nothing:
there is no API collector, so no AI search engine is contacted and nothing is
charged. See [PRIVACY.md](PRIVACY.md#ai-citation-observations-optional).

### Obsidian

The vault is standard Markdown in your workspace. seo-agent never contacts
Obsidian. If **you** enable Obsidian Sync, iCloud, Dropbox, or Git sync on the
vault, that service receives the vault contents. Secrets are never written to
the vault.

## Things that are never sent anywhere by seo-agent

- Telemetry, usage analytics, crash reports, or update checks.
- Diagnostic bundles (`diagnostics export` writes redacted files locally; you
  decide whether to attach them to an issue after inspecting them).
- Your workspace, database, backups, or logs.

## Installation-time network access (not the application)

`npm ci` downloads packages from the npm registry, `docker compose` pulls the
Qdrant image, and the optional container build pulls a Node.js base image.
Those registries see your IP address and the requested package/image names.
