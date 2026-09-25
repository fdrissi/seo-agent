# Access setup

This guide walks you through every account, credential, and verification step
seo-agent can use, in the order of spec section 30. Each integration lists the
official links, the exact commands, how to verify it, common errors, and how
to revoke access.

**Read first**

- **Honest status.** No integration has been tested live with real
  credentials by this project. Every adapter was built against the provider's
  documentation and tested offline with synthetic fixtures. Your first live
  run is the first real test; `doctor` and the status commands report exactly
  what they could and could not verify. See [FEATURE_STATUS.md](FEATURE_STATUS.md).
- **Links.** Provider links were retrieved on **2026-09-24** and are recorded
  with their verified behavior in [integration-contracts.md](integration-contracts.md)
  (source IDs such as `OA6` refer to that file). Consoles, prices, quotas, and
  model catalogs change: check the linked page before you rely on a detail.
- **You only need what your profile uses.** Demo needs nothing. Core needs
  Google (and optionally the LLM Gateway). Full adds the LLM Gateway,
  Qdrant, DataForSEO, Apify, and a PageSpeed key. Everything optional can stay
  off; disabled integrations report `disabled` and never break other stages.
- **What leaves your machine** for each integration is listed in
  [DATA_FLOWS.md](DATA_FLOWS.md).

`<workspace>` below means your private workspace directory (default
`~/seo-agent-workspace`; see [WORKSPACE.md](WORKSPACE.md)). Commands run from
the repository root.

## Contents

0. [Where credentials go (never in a chat)](#0-where-credentials-go-never-in-a-chat)
1. [Node.js, Docker, and dependencies](#1-nodejs-docker-and-dependencies)
2. [LLM Gateway](#2-llm-gateway)
3. [Google: Search Console, GA4, and PageSpeed](#3-google-search-console-ga4-and-pagespeed)
4. [DataForSEO](#4-dataforseo)
5. [Apify (Reddit Scraper actor 9sHOY9RzPYGjmTHo8)](#5-apify-reddit-scraper-actor-9shoy9rzpygjmtho8)
6. [Qdrant, the Obsidian vault, and memory retrieval](#6-qdrant-the-obsidian-vault-and-memory-retrieval)
7. [First run: doctor, cost plan, baseline, recommendation, draft, implementation](#7-first-run-doctor-cost-plan-baseline-recommendation-draft-implementation)
8. [Scheduling, only after a successful manual run](#8-scheduling-only-after-a-successful-manual-run)
9. [Revocation and removal summary](#9-revocation-and-removal-summary)
10. [First-month checklist](#10-first-month-checklist)

---

## 0. Where credentials go (never in a chat)

Never paste an API key, password, token, OAuth client secret, or
service-account key into a chat with a coding agent, an issue, the vault, a
site config, or a report. seo-agent reads credentials programmatically and
never prints them; loaded values are masked in logs and output.

Use one of these, and only these:

| Credential | Where it goes |
| --- | --- |
| API keys and passwords (`LLM_GATEWAY_API_KEY`, `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`, `APIFY_TOKEN`, `PAGESPEED_API_KEY`, `QDRANT_API_KEY`) | `<workspace>/secrets/secrets.env` (dotenv format, mode 0600), edited by you in a local editor, **or** entered through the setup wizard's hidden input (`npm run setup`), **or** injected as environment variables by a password manager (for example `op run -- npm run cli -- <command>`; the environment wins over the file) |
| Google OAuth Desktop client JSON | `<workspace>/secrets/google/oauth-client.json` (mode 0600), or any path you set in `GOOGLE_OAUTH_CLIENT_FILE` |
| Google OAuth token | written by `auth google` to `<workspace>/secrets/google/token.json` (0600); you never handle it |
| Google service-account key or workload-identity config | `<workspace>/secrets/google/service-account.json` (0600), path in `GOOGLE_APPLICATION_CREDENTIALS` |

`init` creates `secrets/` (0700) and a commented `secrets.env` template. The
variable names are listed in [CONFIGURATION.md](CONFIGURATION.md#environment-variables)
and `.env.example`. Public, non-secret values (property IDs, model IDs,
budgets, feature flags) belong in the site config, not in `secrets.env`.
Google credential files inside the vault or the repository are refused.

`doctor` checks the permissions and prints the exact `chmod` command when a
file or directory is too open:

```sh
chmod 700 <workspace>/secrets <workspace>/secrets/google
chmod 600 <workspace>/secrets/secrets.env
```

If a credential ever reaches a chat, commit, log, or issue: rotate it at the
provider immediately (see section 9). Deleting the text is not remediation.

---

## 1. Node.js, Docker, and dependencies

**Official links:** Node.js release lines and LTS dates:
https://nodejs.org/en/about/previous-releases (QN39). Docker and Docker Compose:
https://docs.docker.com/ (needed only for Qdrant).

On 2026-09-24, Node **24** is the Active LTS line (Maintenance LTS from
2026-10-20), Node 22 is Maintenance LTS, and Node 26 is "Current" (LTS from
2026-10-28) (QN39, QN40). The repository pins **24** in `.nvmrc`;
`package.json` requires Node 24 or newer. A newer Current release runs, but
`doctor` warns and recommends an Active LTS line for a long-running
installation.

Steps:

```sh
# Node 24 LTS, for example with nvm (https://github.com/nvm-sh/nvm):
nvm install 24
nvm use                       # reads .nvmrc

# Dependencies: exact versions from package-lock.json, no install-time scripts
npm ci --ignore-scripts

# Docker (Full profile, for Qdrant): install Docker Desktop or Docker Engine
# with the Compose plugin from docs.docker.com, then:
docker compose version
```

Verify:

```sh
node --version                # v24.x
npm run demo                  # offline end-to-end check, no credentials, zero network requests
npm run doctor                # "Node.js version" check; no network, no spending
```

Common errors:

| Symptom | Fix |
| --- | --- |
| `npm ci` refuses: lockfile out of sync | You edited `package.json`. Restore it, or pin the exact new version and regenerate the lockfile deliberately. |
| `doctor`: Node is a "Current" release | Works, but switch to the Active LTS line for unattended use. |
| npm `EBADENGINE` warning, or `doctor` reports an unsupported Node version | Node older than 24. Install Node 24. |
| `docker compose` not found | Install the Compose plugin (Compose v2); the legacy `docker-compose` binary is not used by these docs. |

Removal: nothing to revoke. Uninstall Node/Docker with your platform's tools.

---

## 2. LLM Gateway

Used for AI analysis (cheap and reasoning tiers), drafting, and embeddings.
Optional in Core (reports stay fully deterministic without it); part of Full.
Base URL `https://api.llmgateway.io/v1` (OpenAI-compatible).

**Official links (LG IDs in integration-contracts.md):**

- Quick start: https://docs.llmgateway.io/quick-start (LG1)
- API keys, projects, limits: https://docs.llmgateway.io/learn/api-keys (LG3), https://docs.llmgateway.io/features/api-keys (LG14)
- Embeddings: https://docs.llmgateway.io/features/embeddings (LG2)
- Billing (prepaid credits): https://docs.llmgateway.io/learn/billing (LG25)
- Rate and spend limits: https://docs.llmgateway.io/resources/rate-limits (LG13)
- Model catalog (public JSON): https://api.llmgateway.io/v1/models (LG8)

What the documentation says (2026-09-24): keys belong to a **project**; each
key can have an all-time spend limit, a **recurring** spend limit (1 hour to
12 months), and a TTL; IAM rules can allow or deny models, providers, and
pricing (LG3). Billing is prepaid credits with a 5% platform fee on top-ups
and a 1.5% international card fee (LG25). **Dev plans return 403 for
embeddings** (LG13).

Steps:

1. In the LLM Gateway dashboard, create a **dedicated project** for this
   installation and an **API key** in it. Set a **recurring spend limit** on
   the key (for example monthly, at or below `budgets.llmGateway.monthlyUsd`).
   This provider-side cap is your backstop: provider billing can lag, so
   seo-agent's own reservations cannot guarantee zero overshoot. Optionally
   restrict the key with IAM rules to the models you choose in step 3.
2. Put the key in `<workspace>/secrets/secrets.env` yourself
   (`LLM_GATEWAY_API_KEY=...`) or enter it through `npm run setup`
   (hidden input). Never paste it into a chat.
3. Choose models from the live catalog. Model IDs are never hardcoded or
   guessed:

   ```sh
   npm run cli -- models list                 # free GET /v1/models: capabilities and verified prices
   npm run cli -- models list --embedding     # embedding models only
   npm run cli -- models list --chat --filter <text>
   ```

   Set the three tiers, preferably in the site config (they are public,
   per-site values):

   ```sh
   npm run cli -- setup --update --site <site-id> --only models
   ```

   This writes `models.cheap`, `models.reasoning`, `models.embedding`. The
   environment variables `CHEAP_MODEL`, `REASONING_MODEL`, `EMBEDDING_MODEL`
   override them when set. If you use embeddings, also set
   `models.embeddingDimensions` to the model's documented output size so
   responses are verified (the value is checked, never sent as a shortening
   request).
4. If a model shows `unknown_price`, its calls are skipped (unknown cost is
   never treated as $0). Verify the price on the provider's pages and add it
   to `llm.pricingOverrides` in the site config, or pick another model.

Verify:

```sh
npm run cli -- models check                   # free: every configured model must be OK; exit 2 on a problem
npm run doctor -- --network                   # free read-only checks, including the key's usage and limit
# Optional, CHARGEABLE: one minimal request with a hard cap shown before sending
npm run cli -- models test --confirm-spend --max-usd 0.01
npm run cli -- models test --confirm-spend --max-usd 0.01 --tier embedding   # confirms embedding access
npm run cli -- --dry-run models test --confirm-spend --max-usd 0.01          # preview (makes only the free catalog request)
npm run costs                                  # the test appears as actual, estimated, or unknown spend
```

`doctor --allow-spend --max-usd 0.01` runs the same single capped request as
part of doctor. Nothing else in doctor can spend money.

Common errors:

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `missing_credentials` | `LLM_GATEWAY_API_KEY` not set | Add it to `secrets.env` or your password-manager environment. |
| `LLM_GATEWAY_BASE_URL must use https` | The base URL is plain `http://` to a non-loopback host, so the key would travel unencrypted. No request was sent. | Use an `https://` URL (the default), or `http://127.0.0.1:<port>/...` for a local proxy. |
| 401 `invalid_api_key` | Key wrong, inactive, expired, **or its usage limit was reached** (LG14) | Check the key and its limit in the dashboard; rotate if needed. |
| 403 `permission_denied` | IAM rule blocks the model/provider | Allow the model in the key's IAM rules, or choose another model. |
| 403 on embeddings | Dev plans do not include embeddings (LG13) | Change plan, or leave `features.embeddings` off (memory uses full-text search). |
| `invalid_model` | Model ID not in the catalog (or a chat model used for embeddings) | Pick an ID from `models list`; nothing is substituted automatically. |
| `unknown_price` / `BUDGET_UNKNOWN_PRICE` | No verified price | Set `llm.pricingOverrides` after checking the price. |
| 429 | Rate limit or the account's daily/monthly spend cap (LG13) | Wait, or raise the provider limit deliberately. |
| `BUDGET_EXCEEDED` | seo-agent's own ceiling would be exceeded | Nothing was sent. Raise `budgets.llmGateway.*` only if you decide to. |
| Ambiguous / unresolved charge | A timeout after submission | Check the gateway usage log for that time, then `npm run cli -- costs --unresolved`. Nothing is retried automatically. |

Revoke or rotate: create a new key (with a usage limit), update
`secrets.env`, run `models check`, then delete the old key in the dashboard.
Archiving the project makes its keys inactive (LG22).

---

## 3. Google: Search Console, GA4, and PageSpeed

Search Console and GA4 are read with **read-only scopes only**:
`https://www.googleapis.com/auth/webmasters.readonly` and
`https://www.googleapis.com/auth/analytics.readonly`. No sitemap submission,
indexing request, property change, or GA4 configuration change is ever made.

Choose one authentication path:

- **OAuth Desktop flow** (`GOOGLE_AUTH_MODE=oauth`, the default): best on a
  machine where you can open a browser. Sections 3.1 to 3.5.
- **Service account** (`GOOGLE_AUTH_MODE=service_account`): for unattended
  servers. Sections 3.1, 3.6, 3.4, 3.5.

**Official links:**

- Google Cloud console: https://console.cloud.google.com/
- Google Auth Platform: https://console.developers.google.com/auth/overview,
  Clients: https://console.developers.google.com/auth/clients (OA1),
  Branding: https://console.developers.google.com/auth/branding (OA7),
  navigation: https://support.google.com/cloud/answer/15544987 (OA5),
  Audience: https://support.google.com/cloud/answer/15549945 (OA6)
- Installed-app OAuth (loopback, PKCE): https://developers.google.com/identity/protocols/oauth2/native-app (OA1)
- Refresh-token expiration: https://developers.google.com/identity/protocols/oauth2 (OA2)
- Search Console API: https://developers.google.com/webmaster-tools/v1/searchanalytics/query (GSC1),
  authorizing: https://developers.google.com/webmaster-tools/v1/how-tos/authorizing (GSC12),
  limits: https://developers.google.com/webmaster-tools/limits (GSC3)
- Search Console users and permissions: https://support.google.com/webmasters/answer/7687615 (OA8)
- GA4 Data API: https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart (GA1),
  schema: https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema (GA3)
- GA4 add users and roles: https://support.google.com/analytics/answer/9305788 (OA14),
  https://support.google.com/analytics/answer/9305587 (OA15)
- PageSpeed Insights API: https://developers.google.com/speed/docs/insights/v5/get-started (PS2);
  CrUX API: https://developer.chrome.com/docs/crux/api (PS9)
- Remove an app's access to your account: https://myaccount.google.com/permissions

### 3.1 Google Cloud project and APIs

1. In the Google Cloud console, create (or pick) a project dedicated to this
   installation. No billing features are used by the Search Console or GA4
   reads; check your organization's policies anyway.
2. APIs & Services > Library: enable **Google Search Console API** and
   **Google Analytics Data API**. Nothing else is needed for Core.
   (PageSpeed needs two more, see 3.7.)

### 3.2 Google Auth Platform: branding, audience, test users, data access

1. **Branding:** app name, user support email, developer contact (OA7).
2. **Audience** (OA6):
   - **Internal** if your project belongs to a Google Workspace / Cloud
     Organization and only its members authorize. Internal apps are limited
     to organization members.
   - Otherwise **External**. A new External app starts in **Testing**: add
     the Google account(s) that will authorize as **test users** (up to 100).
3. **Data Access:** add exactly the two read-only scopes above. Do not add the
   read/write `webmasters` or `analytics` scopes.

**Testing-mode limitation (read this).** For an External app in Testing,
"Authorizations by a test user will expire seven days from the time of
consent", and the refresh token expires with them (OA2, OA6). Scheduled
syncs then fail with `invalid_grant` until you run `auth google` again. One
authorization in Testing does **not** last forever. For unattended use:

- use an **Internal** app (Workspace organizations only), or
- publish the External app to **In production**. Google may require
  verification for these scopes; this project did not verify the scopes'
  sensitivity class, so do not assume the review is skipped; or
- use the **service-account path** (3.6), which has no refresh-token expiry.

Other documented reasons a refresh token stops working (OA2): you revoked
access, it was unused for six months, an administrator restricted the
services (`admin_policy_enforced`) or an admin-set session length expired, or
more than 100 refresh tokens exist for your account and this client (the
oldest is invalidated without warning).

### 3.3 Desktop OAuth client and authorization (`auth google`)

1. Google Auth Platform > **Clients** > Create client > application type
   **Desktop app** (OA1). A "Web application" client is refused
   (`CLIENT_NOT_DESKTOP`).
2. Download the client JSON and save it as
   `<workspace>/secrets/google/oauth-client.json` (or set
   `GOOGLE_OAUTH_CLIENT_FILE`). Then:

   ```sh
   chmod 600 <workspace>/secrets/google/oauth-client.json
   npm run cli -- --dry-run auth google       # validates the client file, starts no listener
   npm run cli -- auth google                 # prints the consent URL
   ```

3. Open the printed URL in a browser on the **same machine**, sign in with a
   test user (Testing) or an organization member (Internal), and approve the
   two read-only permissions. Google redirects to a one-shot listener bound
   only to `127.0.0.1`; it validates `state` and uses PKCE (S256). You never
   copy an authorization code or token. The token is stored in
   `<workspace>/secrets/google/token.json` (0600). The listener waits 300
   seconds by default (`--timeout <seconds>`).

On a headless server the browser and the listener cannot be on the same
machine; use the service-account path instead.

### 3.4 Select the exact properties

```sh
npm run cli -- auth status                     # free sites.list + GA4 getMetadata; never prints tokens
npm run cli -- setup --update --site <site-id> --only google.searchConsoleProperty,google.ga4PropertyId
```

- **Search Console:** copy one property **exactly** as `auth status` lists it:
  `sc-domain:example.com` for a Domain property, or
  `https://www.example.com/` (scheme, host, trailing slash) for a URL-prefix
  property. The property is never constructed from your site URL. When
  credentials are present, the wizard offers the readable properties as a
  numbered list and accepts only an exact listed value.
- **GA4:** the **numeric** property ID (GA4 Admin > Property details), not a
  measurement ID (`G-...`) or a Universal Analytics ID (`UA-...`).

### 3.5 Grant least-privilege access (if the authorizing identity lacks it)

Grant the Google account you authorized with (or the service-account email)
the smallest role that allows the reads:

- **Search Console** (OA8): property > Settings > Users and permissions >
  Add user > **Restricted** user. Use Full user only if a read is refused.
  Owner is never required.
- **GA4** (OA14, OA15): Admin > Access Management (property level) > + >
  Add users > **Viewer**. Note that the Viewer role can carry data
  restrictions ("No Cost Metrics", "No Revenue Metrics"); revenue is then
  reported as unavailable, not zero.

No domain-wide delegation and no Google Cloud project-owner role is needed.

Verify:

```sh
npm run cli -- auth diagnose                   # API enablement, property access, Testing expiry, formats, scopes; exit 1 on errors
npm run cli -- sync gsc --dry-run              # checks credentials locally (CREDENTIALS_MISSING, exit 3, without them), then planned date ranges and datasets; no request
npm run cli -- sync gsc                        # 90 days initially, then incremental refresh (free, quota-limited)
npm run cli -- sync ga4                        # google_organic and all_organic landing pages, events, period metrics
npm run doctor -- --network
```

### 3.6 Service-account path (unattended servers)

1. In the same project: IAM & Admin > Service accounts > Create. Grant it
   **no project roles**; reading analytics needs none.
2. Credentials, in order of preference:
   - **Workload identity federation** where your host supports it
     (`gcloud iam workload-identity-pools create-cred-config ...`): no
     long-lived private key. The google-auth-library README recommends it
     for non-Google Cloud environments (OA22).
   - On Google Cloud with an attached service account: Application Default
     Credentials; omit `GOOGLE_APPLICATION_CREDENTIALS`.
   - Otherwise a JSON key: save it as
     `<workspace>/secrets/google/service-account.json` and `chmod 600` it.
3. In `<workspace>/secrets/secrets.env` (or the environment):

   ```sh
   GOOGLE_AUTH_MODE=service_account
   GOOGLE_APPLICATION_CREDENTIALS=<absolute path to your workspace>/secrets/google/service-account.json
   ```

   Replace the placeholder with the real absolute path (the file does no
   variable expansion).

   A personal `gcloud auth application-default login` credential is refused
   in this mode (`SA_ADC_REFUSED`), so your own identity is never used
   silently.
4. `npm run cli -- auth status` prints the service-account email. Grant that
   email access separately: Search Console **Restricted** (or Full) user on
   the exact property, GA4 **Viewer** on the property (3.5).
   Honest caveat: Google documents adding a service account to Search Console
   only for the Indexing API, as a delegated owner (OA9). Adding it as a
   Restricted user is common practice but no official page confirms it. Start
   with Restricted and escalate only if reads are refused; `auth diagnose`
   reports the exact failure.

Verify with `auth diagnose`, `sync gsc --dry-run`, `sync gsc`, `sync ga4`.

### 3.7 PageSpeed Insights and CrUX (optional)

Performance checks run only for priority pages or material changes, and are
cached. They are free Google APIs but need a key (keyless PageSpeed calls were
observed failing with HTTP 429 on 2026-09-24).

1. In the Google Cloud project, enable **PageSpeed Insights API** and
   **Chrome UX Report API**.
2. APIs & Services > Credentials > Create credentials > API key. Restrict the
   key to those two APIs.
3. Put `PAGESPEED_API_KEY=...` in `secrets.env`; set `features.pagespeed: true`
   in the site config (off in Core, on in Full).

Verify: `npm run cli -- perf status --network` (one free CrUX origin query),
`npm run cli -- perf priority`, then `npm run cli -- perf check <priority URL>`.

### 3.8 Validate conversion reporting (manual checklist)

seo-agent never submits forms, creates test leads or purchases, or edits GA4
settings. Conversions are validated by you:

1. Configure the primary event(s) with their exact GA4 names and business
   meaning (unknown values stay unknown):
   `npm run cli -- setup --update --site <site-id> --only conversions.primaryEvents,conversions.secondaryEvents`.
2. Print the checklist and work through it:
   `npm run cli -- sync ga4 --checklist` (no GA4 request). It asks you to:
   - confirm the exact, case-sensitive event name exists and is marked as a
     **key event** in GA4 Admin (a human action);
   - confirm the event fires once per completed conversion, on completion,
     not on page load or a button click alone;
   - verify firing in **GA4 DebugView using a staging/preview environment or
     debug mode**, never by creating fake production records;
   - document your consent-mode behavior (denied consent can make events
     modelled or missing);
   - compare GA4 counts with your system of record (CRM, orders, bookings)
     for the same dates in the GA4 property time zone, and record the
     difference rather than forcing agreement;
   - after at least one real conversion, run `sync ga4` and confirm the
     per-event session key-event rate is available.
3. Record the verification date and outcome in your vault's `01 Business`
   notes, and in the site config: set `verifiedAt` (YYYY-MM-DD) and
   `verificationNote` on the event under `conversions.primaryEvents` in
   `<workspace>/config/sites/<site-id>.yaml`, then run
   `npm run cli -- config validate`. The setup wizard does not ask for these
   two fields. Until `verifiedAt` is recorded, reports keep a caveat
   on every primary-event figure (occurrences, rates, converting sessions,
   users) and list the event as not yet verified by the owner. Re-verify
   after tracking, form, or consent changes.

4. Establish the scale of the key-event rate. GA4 does not document whether
   `sessionKeyEventRate:<event>` is reported as a fraction (0-1) or a
   percentage (0-100). Until a stored value above 1 settles it, conversions
   are "not assessed": reports show the rate only as an unverified raw value,
   the router notes `RATE_SCALE_UNVERIFIED`, and the next action asks you to
   confirm the scale. Compare one stored value (for example the daily value
   of a page in `npm run cli -- analyze page <url>` or
   `npm run cli -- data export ga4-landing`) with the same page, date, and
   channel in the GA4 interface, then record it:
   `npm run cli -- sync ga4 --confirm-rate-scale fraction --evidence "GA4 UI shows 2.5% for /pricing on 2026-09-15; stored 0.025" --as "<your name>"`
   (use `percent` when the stored value is 2.5). `--as <name>` is required:
   the confirmation is recorded as your assertion (asserted, not
   authenticated), and automation or account names (`system`, `scheduler`,
   `claude`, `agent007`, `owner`, `root`, `node`, ...) are refused. The
   command printed by the reports' next action has the same form. This
   sends no GA4 request, is audited, and re-marks the stored
   rates, older days included. A `fraction` confirmation is refused once a
   value above 1 has been seen. On sites with few sessions the sync can also
   prove the 0-1 scale on its own from small daily rows, and says so.
5. With several primary events, only the first one listed under
   `conversions.primaryEvents` gets a conversion rate; the others are stored
   as event counts, and the sync result, the checklist, and reports say so.
   List the event that should drive conversion decisions first.

If the per-event rate metric is unavailable, reports say so and never
substitute "any key event" silently.

### 3.9 Common errors

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `CLIENT_NOT_DESKTOP` | A Web client was downloaded | Create a **Desktop app** client. |
| `*_API_NOT_ENABLED` | API disabled in the project that owns the client or service account | Enable it (3.1) and wait a few minutes. |
| `GSC_PROPERTY_MISMATCH` / `GSC_PROPERTY_FORMAT` | Property string differs (scheme, `www`, trailing slash, `sc-domain:`) | Copy the exact string from `auth status`. |
| `GSC_NO_ACCESS` / `GA4_NO_ACCESS` / `GSC_UNVERIFIED_USER` | Identity lacks access | Restricted user (Search Console), Viewer (GA4). |
| `REFRESH_INVALID_GRANT` | Testing 7-day expiry, revoked, unused six months, or over 100 tokens | `auth google` again; for unattended use see 3.2 or 3.6. |
| `GA4_PROPERTY_FORMAT` | `G-...` or `UA-...` used | Use the numeric GA4 property ID. |
| `PRIMARY_EVENT_NOT_KEY_EVENT` | Primary event is not a key event | Mark it in GA4 Admin; follow 3.8. |
| `*_QUOTA_EXHAUSTED` | Google quota reached | Wait, then sync again. A sync that stops at a quota is recorded as `partial` with the dates it did not collect. The next sync checks coverage of the whole history window and re-requests every date that was never collected (a "Backfill: ... re-requested from <date>" warning), not only the recent refresh days. It stays `partial` until no known gap is left. |
| `SA_TOKEN_REJECTED` | Google rejected the service-account token request (`invalid_grant`), which is not the OAuth Testing expiry | Check that the key and the service account still exist and are enabled, that the system clock is correct, and that a workload identity configuration is current; then `auth diagnose`. |
| `SA_ADC_REFUSED` | A user credential was found in service-account mode | Point `GOOGLE_APPLICATION_CREDENTIALS` at a service-account or workload-identity file. |
| `GOOGLE_AUTH_MODE=fixture` refused | Fixture mode is only for the demo profile | Use `oauth` or `service_account`. |

### 3.10 Revoke or reconnect

- OAuth: `npm run cli -- auth revoke` revokes the refresh token at Google and
  deletes the local token; `--local-only` deletes only the file (then also
  remove the app at https://myaccount.google.com/permissions). Reconnect with
  `npm run cli -- auth google`.
- OAuth client secret: add a new secret or create a new Desktop client,
  re-authorize, then delete the old secret or client.
- Service account: remove its email from Search Console and GA4, then disable
  or delete its keys (IAM > Service accounts > Keys). Rotate keys by creating
  a new key, switching the file, verifying with `auth status`, then deleting
  the old key.
- PageSpeed key: create a new restricted key, update `secrets.env`, delete
  the old key.

---

## 4. DataForSEO

Selective, budgeted SERP research and keyword-volume estimates (Full). The
default process is: Search Console shortlist, local filtering, three to five
serious queries, targeted SERP research, then the relevant competitor pages.
Backlinks, Labs exports, and AI-visibility endpoints are disabled by default
and need a feature flag plus an approval for the exact request.

**Official links (DF IDs):**

- Authentication: https://docs.dataforseo.com/v3/auth/ (DF1); API docs: https://docs.dataforseo.com/v3/ (DF2)
- API credentials page: https://app.dataforseo.com/api-access (DF1)
- Pricing: https://dataforseo.com/pricing (DF3); July 2026 price update: https://dataforseo.com/update/pricing-update-in-dataforseo-apis (DF35)
- Sandbox: https://docs.dataforseo.com/v3/appendix/sandbox/ (DF14)
- Trial credit: https://dataforseo.com/help-center/how-does-your-free-unlimited-trial-work (DF37)
- Errors: https://docs.dataforseo.com/v3/appendix/errors/ (DF13)

**Funding and access (verify on the pricing page before paying):** pricing is
pay-as-you-go; the documented **minimum payment is $50** (DF3); registration
gives a **$1 credit for testing**, and creating multiple trial accounts
violates the terms (DF37). The minimum payment is outside seo-agent's budgets:
a $10/month research ceiling does not mean you only pay $10.

Steps:

1. Create **dedicated API credentials** on the API Access page. The API
   password is auto-generated and is **not** your account password (DF1).
2. Put `DATAFORSEO_LOGIN=...` and `DATAFORSEO_PASSWORD=...` in `secrets.env`
   or your password-manager environment.
3. In the site config: `features.dataforseo: true` (Full default) and
   `research.dataforseo.mode: sandbox`. Find location codes instead of
   guessing them, then add them to `market.searchLocations` with a
   `languageCode`:

   ```sh
   npm run cli -- research locations "<city or country name>" --country <iso2>
   npm run cli -- setup --update --site <site-id> --only market.searchLocations,research.dataforseo.mode
   ```

4. **Sandbox first** (free; results are labeled SYNTHETIC and never used in
   recommendations):

   ```sh
   npm run cli -- research status --network              # free user_data call only
   npm run cli -- research keyword "<query>" --sandbox --wait 120
   ```

5. Review prices: `research status` lists the price basis for each endpoint.
   Documented prices count as unknown 90 days after verification (from
   2026-12-23 for the current values); then set
   `research.dataforseo.pricingOverrides` after checking the pricing page, or
   paid requests are skipped with `BUDGET_UNKNOWN_PRICE`.
6. **One budgeted live request**, only when the plan and caps are acceptable:

   ```sh
   # set research.dataforseo.mode: live in the site config, then:
   npm run cli -- research keyword "<query>" --dry-run                  # cost plan, caps, cache hits; no request
   npm run cli -- --mode RESEARCH research keyword "<query>" --allow-spend --wait 120
   npm run cli -- research tasks                                        # task ids persisted before the POST
   npm run costs
   ```

   A paid run needs both `--mode RESEARCH` and `--allow-spend`; without them
   it prints the plan, sends nothing paid, and exits with code 3.
7. Consider a provider-side cost limit in the DataForSEO dashboard
   (`40203 cost limit exceeded` is its documented error).

Common errors (codes from DF13):

| Code / status | Meaning | Fix |
| --- | --- | --- |
| `missing_credentials` | Login or password missing | Add both to `secrets.env`. |
| 40100 | Not authorized | Use the API password from the API Access page, not the account password. |
| 40104 | Account verification required | Complete verification in the dashboard. |
| 40200 / 40210 | Payment required / insufficient funds | Fund the account (minimum payment applies). Nothing is charged by seo-agent for a rejected task. |
| 40201 | Account paused | Resolve in the dashboard. |
| 40203 | Your provider-side cost limit was reached | Raise it deliberately or wait. |
| 40202 / 40209 | Rate limit / too many simultaneous queries | Wait; seo-agent also rate-limits itself. |
| `BUDGET_UNKNOWN_PRICE` | No price newer than 90 days | Set `pricingOverrides` after checking the pricing page. |
| Ambiguous task | A POST timed out; the provider may have accepted it | `research tasks --poll` (free) reconciles it; it is never resubmitted. `--abandon <taskId>` only after checking the dashboard; its charge stays reserved. |

Revoke or rotate: regenerate the API password on the API Access page, update
`secrets.env`, verify with `research status --network`. To stop all use, set
`features.dataforseo: false`.

---

## 5. Apify (Reddit Scraper actor 9sHOY9RzPYGjmTHo8)

Finds recurring questions, objections, comparisons, and unmet needs in Reddit
posts through the actor with ID **`9sHOY9RzPYGjmTHo8`** (publicly listed as
`harshmaur/reddit-scraper`). The actor ID is authoritative; no other actor is
substituted. Results are user-reported evidence, not verified facts or search
volume.

**Official links (AP IDs):**

- Actor listing: https://apify.com/harshmaur/reddit-scraper (AP14); input schema: https://apify.com/harshmaur/reddit-scraper/input-schema (AP15)
- Owner-provided reference: https://console.apify.com/actors/9sHOY9RzPYGjmTHo8/info/readme?build=latest
- API: get actor https://docs.apify.com/api/v2/actor-get (AP9); run actor https://docs.apify.com/api/v2/actors-runs-post (AP10); dataset items https://docs.apify.com/api/v2/dataset-items-get (AP12)
- Runs and builds: https://docs.apify.com/platform/actors/running/runs-and-builds (AP13)

**Pricing (as documented 2026-09-24, see [COSTS.md](COSTS.md)):**
pay-per-event, about $0.02 per actor start plus about $0.002 per saved result
on the free tier; optional AI add-ons cost extra and are forced off by the
adapter. Plan tiers and platform usage apply. `apify inspect` shows the
pricing record currently in force; re-check it before a paid run.

Steps:

1. Create an Apify account and an API token (Apify Console > Settings >
   API & Integrations). Put `APIFY_TOKEN=...` in `secrets.env` or your
   password-manager environment.
2. Enable the feature: `features.apify: true` (Full default).
3. Inspect the actor (free reads: identity, pricing, builds, input schema
   stored with its hash, output fields, schema drift):

   ```sh
   npm run cli -- apify inspect
   ```

   If the build API is not accessible, export the build's input schema from
   the Apify console and import it:
   `npm run cli -- apify import-schema <file> --build <number>` (add
   `--attest` only if you exported it from exactly that build; otherwise it
   stays unverified and runs are refused).
4. **Pin the verified build number** in the site config:
   `research.apify.build: "<number>"` (or `APIFY_CONTENT_ACTOR_BUILD`).
   Runs are refused for an unpinned build or when the pinned build's schema
   drifted since verification.
5. **Unnecessary features stay disabled.** The input builder sends only
   fields from the verified schema, forces AI-analysis add-ons off, explicitly
   disables MCP/app delivery, never sets webhooks, and scans the input for
   secrets (Google, LLM Gateway, CMS, DataForSEO, or database credentials are
   never sent). Review the caps: `research.apify.maxItems`,
   `maxCommentsPerPost`, `timeRange`, `maxRunSeconds`, `maxTotalChargeUsd`,
   and `budgets.apify.*`.
6. Verify, then **approve one minimal test** (5 posts, no comments; the cap
   is printed first and is also the run's provider-side charge cap):

   ```sh
   npm run cli -- apify status --network                               # free reads: token, actor, pinned build
   npm run cli -- apify test                                           # shows the plan and cap, spends nothing, exit 2
   npm run cli -- --mode RESEARCH apify test --confirm-spend --max-usd 0.05 --term "<topic>"
   npm run cli -- apify runs
   npm run costs
   ```

   A paid run needs `--mode RESEARCH` as well as `--confirm-spend`; in the
   default ANALYZE mode it is refused before anything is sent. `--max-usd`
   must not exceed `research.apify.maxTotalChargeUsd`. If a live pricing
   re-read would change the input, nothing is sent.
7. **Content research** after the test succeeded. Search terms come from
   `research.seedTopics`, and communities from `research.subreddits`: one
   bounded run per community (the actor's `withinCommunity` field), or one
   run across Reddit with `--all-reddit`. Preview first, then start exactly
   the previewed plan:

   ```sh
   npm run cli -- apify research                                       # plan only: runs, communities, per-run caps, plan hash (exit 2)
   npm run cli -- --mode RESEARCH apify research --confirm-spend --max-usd 0.20 --plan <hash>
   ```

   `--max-usd` is the total cap across all runs of the batch, split per run.
   Signals are classified by free English heuristics. The LLM classifier runs
   only when you ask for it with `--classify-with-llm --llm-max-usd <cap>`;
   each call is reserved through the LLM Gateway budget, and an unknown price
   makes those items fall back to the heuristics. The `content queue`
   pipeline never starts a new paid Apify run; it only collects runs that are
   already pending.
8. After the first real run, record what you observed (charged-event keys,
   `usageTotalUsd`, dataset fields) in
   [integration-contracts.md](integration-contracts.md); those details are
   still unverified.

Common errors:

| Status | Meaning | Fix |
| --- | --- | --- |
| `missing_credentials` | `APIFY_TOKEN` not set | Add it. |
| `misconfigured`: token rejected (401) | Wrong or revoked token | Create a new token. |
| `permission_denied` (403) | Token lacks access | Check the token and your plan. |
| `misconfigured`: actor id | The configured actor is not `9sHOY9RzPYGjmTHo8` | Restore the ID; substitution needs owner approval. |
| Unpinned build / schema never verified / schema drift | Runs are refused | `apify inspect`, review, pin the build. |
| Run quarantined | Failed, timed out, aborted, partially fetched, or stopped by the charge cap | Quarantined results are never used as research; the charge is still reconciled. |
| Ambiguous start | The run start timed out | `apify runs --resume` reconciles it through run history without a second POST. `--confirm-not-accepted <id>` records $0 only after you checked the Apify console. |

Revoke or rotate: create a new token, update `secrets.env`, run
`apify status --network`, then delete the old token in the Apify console.
Datasets and runs stay in your Apify account under its retention; delete
them there if needed.

---

## 6. Qdrant, the Obsidian vault, and memory retrieval

### 6.1 Qdrant (Full profile)

Qdrant is a **rebuildable search index**. SQLite in your workspace stays
authoritative; if Qdrant is down, retrieval falls back to SQLite full-text
search and reports `degraded`. A search that is full-text only by choice
(for example `memory search` without `--allow-paid`, or a process that has no
LLM client for query embeddings) says so in its detail but is not degraded,
and it never marks a healthy Qdrant as degraded in `memory status`.

**Official links:** https://qdrant.tech/documentation/quickstart/ (QN1),
installation https://qdrant.tech/documentation/installation/ (QN7),
security https://qdrant.tech/documentation/security/ (QN6).

```sh
# from the repository root; storage goes to <workspace>/qdrant
SEO_AGENT_WORKSPACE=<workspace> docker compose up -d qdrant
npm run cli -- memory status --network         # free read-only health check; expects Qdrant ready
```

`compose.yaml` pins `qdrant/qdrant:v1.19.1` and binds ports to `127.0.0.1`
only. Qdrant has no authentication or TLS by default: never expose it beyond
localhost without an API key, TLS, and a firewall (see
[DEPLOYMENT.md](DEPLOYMENT.md#qdrant-on-a-server)). Two details are
unverified: the healthcheck assumes `bash` exists in the image (if the
container shows unhealthy while `memory status --network` succeeds, remove
the healthcheck block) and the telemetry-disable key name.

Enable semantic memory: `features.qdrant: true`, `features.embeddings: true`
(Full defaults), `EMBEDDING_MODEL` or `models.embedding`, and
`models.embeddingDimensions` (section 2).

### 6.2 The vault in Obsidian (optional)

The vault is plain Markdown and works without Obsidian or community plugins.

```sh
npm run cli -- setup vault                     # creates <workspace>/vault/<site-id> from the template; never overwrites
npm run cli -- vault render                    # generates notes from the database
npm run cli -- vault check                     # links, conflicts, malformed notes
```

To browse it: install Obsidian (https://obsidian.md/help/ is the official
help, QN31-QN37), choose **Open folder as vault**, and select
`<workspace>/vault/<site-id>`. Keep the default link settings or set "New link
format" to "Absolute path in vault". Keep Dataview JavaScript queries and
Templater's "trigger on new file creation" off. Edit business facts only in
`01 Business`; text outside generated markers is preserved, and an edited
generated region produces a conflict artifact instead of being overwritten.
Import your business-note changes with
`npm run cli -- vault import-business` (validate and preview), then
`vault import-business --apply` (record the notes), `vault apply-business`
(show the config diff and its hash), and
`vault apply-business --confirm <diff-hash>` (recorded as your
operating-system user, or pass `--by "<your name>"`; automation and account
names such as `system`, `claude`, `owner`, or `root` are refused, and so is
a service-account operating-system user such as `node` in the container or
`runner` on CI, so pass `--by` there).

Two behaviors were not checked inside the Obsidian app itself (see
FEATURE_STATUS): resolution of links to file names containing dots, and how
the Properties editor re-saves generated properties.

### 6.3 Test memory retrieval

```sh
npm run cli -- memory sync                     # ingest business notes and records; full-text index (no spend)
npm run cli -- memory search "your business question" --json
npm run cli -- --dry-run memory sync           # with embeddings configured: chunks, cache hits, cost basis, caps
npm run cli -- memory sync --allow-paid        # paid embeddings, budget-reserved (optionally --max-embed N)
npm run cli -- memory search "your business question" --allow-paid --json
```

Check that results carry source paths, trust classes, and (with Qdrant)
`method: "hybrid"`; `memory evidence <chunkId>` shows the original source
behind a retrieved chunk.

Common errors:

| Symptom | Fix |
| --- | --- |
| `unreachable` / `fetch failed` | Start Qdrant; check `QDRANT_URL`. |
| `permission_denied` (401/403) | `QDRANT_API_KEY` does not match the server key. |
| `QDRANT_API_KEY would be sent over plain HTTP` | With an API key, a non-loopback `QDRANT_URL` must be `https://` (Qdrant TLS or a TLS reverse proxy). The client is refused and memory search stays full-text only until then. `http://127.0.0.1:6333` is fine for a local Qdrant. |
| Dimension mismatch refused | Set `models.embeddingDimensions` to the real size, then `memory sync --allow-paid`. |
| `fts_only`: "query embedding is a paid call" | Add `--allow-paid` to `memory search`. |
| Document rejected for credential-like content | Remove the secret from the note, rotate the credential, sync again. |

Revoke or reset: change the Qdrant server key and `QDRANT_API_KEY` together,
then `docker compose up -d qdrant`. To remove all vectors, stop Qdrant and
delete `<workspace>/qdrant`; `memory rebuild` restores the index from SQLite
and the embedding cache (no paid calls when the cache is complete).

More: [modules/memory.md](modules/memory.md), [modules/obsidian.md](modules/obsidian.md).

---

## 7. First run: doctor, cost plan, baseline, recommendation, draft, implementation

### 7.1 Doctor

```sh
npm run doctor                                 # no network at all; exit 1 on any failing check
npm run doctor -- --network                    # free, read-only provider checks only
npm run --silent doctor -- --json > doctor.json   # machine-readable result (--silent keeps npm's banner out of the file)
```

Fix every `FAIL` line first; each one prints its next step. `doctor` never
spends money unless you add `--allow-spend --max-usd <cap>`, which allows one
minimal LLM Gateway request whose cap is printed first.

### 7.2 Review the first cost plan and run the baseline

```sh
npm run cli -- --dry-run baseline              # runs against a temporary copy of the database; shows the PROPOSED COST PLAN
npm run baseline                               # no paid DataForSEO/Apify, no experiments, nothing published
```

The baseline validates access, collects up to 90 days of Search Console and
GA4 history, crawls your site within `crawl.maxPages`, reconciles URLs,
checks measurement, indexes memory (full-text), and writes the baseline
report and dashboard. Optional LLM/embedding work (embeddings for memory, a
model-written executive summary) runs only if you approve the displayed plan:

```sh
npm run baseline -- --approve-cost-plan 0.05   # cap in USD; must cover the displayed upper bound
```

Unknown prices are never approved. Then read the result:

```sh
npm run cli -- report show baseline
npm run costs
```

The dashboard is `<workspace>/vault/<site-id>/00 Dashboard/Dashboard.md`.
Blockers (missing access, incomplete data, missing conversion definitions)
are listed with next steps; fix measurement before optimizing.

### 7.3 Review a recommendation

```sh
npm run weekly                                 # ANALYZE mode: no paid research
npm run cli -- --mode RESEARCH weekly          # adds budgeted DataForSEO research for shortlisted queries
npm run cli -- report show weekly
npm run cli -- analyze page <url>              # metrics, joins, route, issues for one page (no network)
```

The weekly report contains one prioritized action or an explicit decision to
wait, with the exact page and queries, measurements, evidence links, the
diagnosis, the proposed change, a hypothesis, success criteria, risks, and a
review date. Claims are labeled OBSERVED, INFERRED, HYPOTHESIS,
RECOMMENDATION, or DATA UNAVAILABLE. "Leave unchanged", "repair measurement
first", and "collect more evidence" are valid outcomes.

To act on a recommendation, turn it into an experiment bound to your site's
current source revision (a Git commit or CMS revision you supply), then
approve it after reviewing the exact change:

```sh
npm run cli -- experiments propose --recommendation <rec-id> --revision <your-site-revision>
npm run cli -- approvals list
npm run cli -- approvals show <approval-id>    # exact change and its artifact hash
npm run cli -- approvals approve <approval-id> --as "<your name>" --confirm <first 8+ characters of the hash>
```

To decline: `npm run cli -- approvals reject <approval-id> --reason "<why>"`.

Names you give with `--as` (or `--by`) are recorded as asserted, not
authenticated. Obvious automation and account names (for example `system`,
`claude`, `owner`, `admin`, `root`, `node`, `runner`) are refused. Where
`--as` may be omitted, your operating-system user is recorded, unless it is a
service account (`node` in the container image, `runner` on GitHub-hosted CI,
`root`, and similar): then the command is refused and asks for
`--as "<your name>"`.

Some recommendations are an investigation rather than a change ("compare
the intent of the top results, then propose ONE specific change"). They
cannot become an experiment or an export as they are, because there is no
exact change to approve. Do the investigation, then record the one change
you decided on as a new revision of the recommendation, and propose the
experiment from the new id it prints:

```sh
npm run cli -- experiments specify-change <rec-id> --title "<new title>" [--meta "<new meta description>"] --by "<your name>"
#   or: --section-file <section.md>, or --redirect-to <absolute URL>; add --hypothesis "<...>" if the recommendation has none
npm run cli -- experiments propose --recommendation <new-rec-id> --revision <your-site-revision>
```

Nothing is approved or deployed by `specify-change`; the previous revision is
marked superseded and its open approvals are invalidated.

### 7.4 Approve a draft

Drafting needs features.contentDiscovery (Full) and an LLM connection.

```sh
npm run cli -- content queue                   # discovery as a durable job; never drafts or publishes
npm run cli -- content list
npm run cli -- content brief <item-id>         # deterministic brief + gate; requests a draft approval bound to the brief hash
npm run cli -- approvals show <approval-id>
npm run cli -- approvals approve <approval-id> --as "<your name>" --confirm <hash-prefix>
npm run cli -- --mode DRAFT content produce <item-id> --use-model   # draft + quality review (durable, checkpointed)
npm run cli -- content show <item-id>
```

Read the draft note in `05 Content/Drafts/`. Unresolved facts are marked and
block publication. When you accept the exact body:

```sh
npm run cli -- content mark-reviewed <draft-id> --as "<your name>" --confirm <body-hash-prefix>
npm run cli -- approvals request draft <draft-id> --revision <your-site-revision>
npm run cli -- approvals approve <approval-id> --as "<your name>" --confirm <hash-prefix>
npm run cli -- content publish-check <draft-id>
```

Your recorded acceptance is required, not optional: `export draft` refuses
a production-bound draft unless its latest review is a named human's
acceptance of its exact body (automated `pass` verdicts never count), and
`content publish-check` names what the export enforces. If you edit the body
yourself (for example after the two automated revision rounds, or to resolve
`[[UNVERIFIED: ...]]` markers with sources), record the edit as a new draft
version and accept that version:
`npm run cli -- --mode DRAFT content revise-manual <draft-id> --body-file <edited.md> --as "<your name>" --resolutions <file.json>`.

### 7.5 Record a real implementation

Nothing is published automatically. Export the approved change, deploy
exactly that package yourself, then record when it really went live:

```sh
npm run cli -- --mode EXECUTE export experiment <experiment-id> --revision <your-site-revision>
#   (or: export draft <draft-id>, export recommendation <rec-id>)
#   -> <workspace>/exports/<site-id>/<date>-<subject>/ with checklist.md, diff.md, rollback.md
# ... deploy the change in your CMS or repository ...
npm run cli -- experiments mark-implemented <experiment-id> \
  --at 2026-10-01T14:30:00+03:00 --revision <deployed-revision> --url <live URL>
#   (drafts: add --subject-type draft; recommendations: --subject-type recommendation)
```

The export rechecks the target page and consumes the approval exactly once.
`--dry-run` shows the package it would write and writes, consumes, and
invalidates nothing. If `--revision` differs from the revision the approval
is bound to, the export is refused and the approval is left untouched. Only
when you state that this is the site's current revision with
`--invalidate-stale` is the stale approval invalidated (recorded), so that
you can request a new one.
`mark-implemented` needs the actual time with an explicit zone (not in the
future, not before the approval), the deployed revision, and the approved
URL; it snapshots before/after, fetches the live page to verify what went
live, and starts the observation window at `--at`. Approval or draft time
never starts it. Then let it observe: `npm run cli -- experiments review`
evaluates due experiments; low-traffic pages need long windows and may end
`inconclusive`. See [FIRST_MONTH.md](FIRST_MONTH.md).

---

## 8. Scheduling, only after a successful manual run

Enable scheduling only after `baseline` and at least one `weekly` run
succeeded by hand, so you know credentials, budgets, and reports work.
Scheduling is opt-in and nothing is installed for you. `schedule enable`
checks this: it refuses until a manual `weekly` or `baseline` run has
succeeded with Search Console and GA4 data. `--force` overrides the check,
which is not recommended.

```sh
npm run cli -- schedule enable weekly          # cron and IANA zone from the site config (default Mondays 07:00, Europe/Tallinn)
npm run cli -- schedule enable monthly
npm run cli -- schedule show                   # next runs in the schedule's time zone, DST notes, drift
npm run cli -- schedule instructions --platform launchd   # or systemd, cron, server; prints snippets, installs nothing
```

Unattended jobs run in ANALYZE (default) or RESEARCH mode only; drafting and
publishing always need you. A sleeping or offline laptop cannot run jobs.
With the OAuth Testing audience, scheduled syncs stop after 7 days (3.2).
Full guide: [SCHEDULING.md](SCHEDULING.md).

---

## 9. Revocation and removal summary

Rotation order is always: issue the new credential, update the workspace,
verify, then revoke the old one. After rotating, run `npm run doctor` and
check the provider's usage history for activity you did not cause.

| Integration | Revoke / rotate | Verify afterwards |
| --- | --- | --- |
| LLM Gateway key | New key with a usage limit, update `secrets.env`, delete the old key in the dashboard | `models check` |
| Google OAuth | `auth revoke` (or remove the app at myaccount.google.com/permissions), then `auth google` | `auth status` |
| Google OAuth client | New secret or new Desktop client, re-authorize, delete the old one | `auth diagnose` |
| Google service account | Remove its email from Search Console and GA4; delete or rotate keys in IAM | `auth diagnose` |
| PageSpeed key | New API-restricted key, delete the old one | `perf status --network` |
| DataForSEO | Regenerate the API password on the API Access page | `research status --network` |
| Apify token | New token, delete the old one in the Apify console | `apify status --network` |
| Qdrant API key | Change server key and `QDRANT_API_KEY` together, restart Qdrant | `memory status --network` |

To remove everything: disable schedules and uninstall any OS timer you
installed, stop Qdrant, export what you want to keep, delete the workspace
directory (backups included), and revoke every credential above. Provider-side
copies (Apify datasets, DataForSEO task results, LLM provider logs) follow
each provider's retention; delete them in their consoles if needed. See
[PRIVACY.md](PRIVACY.md#retention-and-purge) and
[SECURITY_MODEL.md](SECURITY_MODEL.md#credential-rotation).

---

## 10. First-month checklist

Month one is about a **working, trustworthy loop**, not a result. The
week-by-week plan, with the exact commands for each step, is in
[FIRST_MONTH.md](FIRST_MONTH.md). At the end of the fourth week, check each
row:

| Item | Done when | Commands |
| --- | --- | --- |
| Baseline and tracking | The baseline report exists. The primary conversion event is verified with the manual checklist (3.8) and the result is recorded in `01 Business`. There are no open data-quality blockers, or each one has an owner and a plan. | `baseline`, `report show baseline`, `sync ga4 --checklist` |
| One researched opportunity | One recommendation was reviewed against its evidence (exact page and queries, measurements, claim labels) and then approved or rejected with a reason. "Repair measurement first" or "collect more evidence" also count when the evidence says so. | `weekly` (or `--mode RESEARCH weekly`), `report show weekly`, `analyze page`, `approvals approve` / `approvals reject` |
| One approved implementation | The approved package was exported, deployed exactly as approved, and recorded at the real deployment time and revision. The live verification result is `match`, or a mismatch was fixed. | `--mode EXECUTE export ...`, `experiments mark-implemented` |
| Sufficient observation | The experiment is observing and nobody has touched the page. The evaluation date is noted, and interfering changes are annotated. The window is at least 28 days from the real implementation date (56 for low-traffic pages) and also waits for enough impressions and sessions. | `experiments review`, `experiments annotate` |
| No forced results | Nothing was concluded early. A review before the window ends records "collecting", and a window that ends without enough evidence records **inconclusive**, not negative. No second change was stacked on the page to "get a result", and nothing was re-tested until it looked favorable. | `experiments review` (without `--conclude` until the window has ended) |
| Operations | Weekly runs succeed. Spend was reviewed in `costs` and in each provider's dashboard. A backup exists. Scheduling was enabled only after a successful manual run (section 8). | `costs`, `backup`, `schedule show` |

Most first experiments are not conclusive after four weeks, and that is the
expected outcome. seo-agent never manufactures a change or a win to fill a
month. Month one succeeds when this loop works; results, if any, come later.
