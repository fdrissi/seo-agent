# Security model

This document lists the threats seo-agent is designed against, the mitigations,
and where they live in the code. It covers the public application; your
private workspace and provider accounts are your responsibility.

Assets: provider credentials (LLM Gateway, Google OAuth/service account,
DataForSEO, Apify, Qdrant, PageSpeed), first-party analytics data, business
facts, approval records, budgets, the owner's production website, and the
owner's machine.

Trust boundaries: everything fetched or imported (web pages, SERP/API text,
Reddit posts, imported documents, retrieved notes, model output) is
**untrusted data**. Only the owner's CLI actions, validated configuration, and
approval records created through the CLI are trusted.

## 1. Secret exposure

| Threat | Mitigation | Where |
| --- | --- | --- |
| Secrets committed to the repository | Private workspace outside the repo by default; `.gitignore` for `.env`, `secrets/`, credential JSON, workspaces, databases | `src/config/paths.ts`, `src/config/workspace.ts` (refuses a workspace inside the repo), `.gitignore` |
| Secrets in Git history | Secret scan of the working tree **and full history** (every commit, including empty and merge commits; shallow clones are reported INCOMPLETE, never clean) that never prints values; private keys and human-chosen passwords are never exempted by heuristics; the allowlist is validated and its changes are shown in CI; rotation required | `scripts/scan-secrets.mjs`, `scripts/lib/secret-rules.mjs`, `scripts/secret-scan-allowlist.json`, CI `security` job |
| Secrets in logs, reports, raw files, CLI output | Registered-value and shape-based redaction on every output path | `src/security/redact.ts`, `src/core/logger.ts`, `src/cli/runtime.ts#print` |
| Secrets in the vault or given to models | Secret store separate from config/vault; runtime LLM calls never receive secrets; every generated vault note is redacted before it is written (body, title, each generated property value, file name), and credential parameters in URLs (`token=`, `sig=`, `X-Amz-Signature=`, fragment `access_token`) are masked | `src/config/secrets.ts`, `src/security/tools.ts`, `src/security/untrusted.ts`, `src/obsidian/markdown.ts`, `src/obsidian/writer.ts` |
| Credentials sent over an unencrypted network | `LLM_GATEWAY_BASE_URL` must be `https://` (plain `http://` only to a loopback proxy); with `QDRANT_API_KEY` set, a non-loopback `QDRANT_URL` must be `https://`. Otherwise no request is sent (the gateway) or the client is refused and memory stays full-text (Qdrant) | `src/integrations/llm/http.ts`, `src/memory/qdrant.ts` |
| Secrets in bug reports | Redacted diagnostics with identifier hashing (identifiers of every site are masked, including invalid configs and sites excluded by `--site`) and a final self-check; written locally, never uploaded; user must inspect | `src/security/diagnostics.ts`, `src/cli/commands/diagnostics.ts` |
| Secrets in release artifacts | `package.json` `"files"` allowlist, `.dockerignore` deny-all allowlist, release check scans packed file contents and verifies `.gitignore` also covers private files nested inside public directories | `scripts/release-check.mjs`, `scripts/lib/release-rules.mjs` |
| World-readable secret files | 0700 secrets directory, 0600 files, permission warnings | `src/config/workspace.ts`, `src/config/env.ts#checkSecretFilePermissions` |
| World-readable workspace database (analytics, approvals, audit log) | A file database opened for writing is created 0600 and its `-wal`/`-shm` files follow; looser files from older versions are tightened on open; `init` warns about a workspace or `data/` folder readable by others; `doctor` warns with the exact `chmod` commands, and `doctor --server` makes it a failure | `src/database/db.ts`, `src/setup/doctor.ts`, `tests/integration/database/db-permissions.test.ts` |

An exposed credential must be **rotated**. Deleting it or rewriting history is
not remediation.

## 2. SSRF and unsafe network access

The crawler fetches URLs derived from untrusted content. Threats: requests to
loopback, private, link-local, or cloud-metadata addresses (for example
`169.254.169.254`), unsafe schemes (`file:`, `javascript:`, `data:`), redirects
or DNS answers that point to blocked networks, and headless-browser
subrequests.

Mitigations: a single SSRF guard validates scheme, host, and every resolved
address, re-validates after DNS resolution and after each redirect, caps
redirects, size, and time, and applies to optional browser subrequests. Local
services such as Qdrant are reached only through their fixed adapters, never
through the generic crawler. Callback listeners (OAuth loopback) bind to
`127.0.0.1` only.

A DNS lookup that fails is reported as a failed fetch, not as an unsafe
address: only an address that resolved into a blocked range is recorded as
blocked. For the own-site crawl such a failure is a transient
`CRAWL_NETWORK_ERROR` with a retry next step (and `crawl status --network`
reports it as unreachable), never an SSRF refusal or a `site.url` problem. A
competitor URL given with `--manual-urls` that the guard refuses (loopback,
link-local, cloud metadata) is refused before any request, recorded only as
a blocked crawl result, and never becomes a tracked competitor page that the
monthly re-check would retry. A competitor URL requested without a shortlisted query is fetched
only when its host is a configured competitor (`research.competitors`) or
listed in `research.approvedDomains`; anything else is recorded as
`not_approved` and never fetched.

Where: `src/security/ssrf.ts`, `src/crawler/`, `src/auth/` (loopback flow),
`src/memory/` (fixed Qdrant adapter). Qdrant is exposed on localhost only by
default; remote deployments need an API key, `https://`, and network
controls.

## 3. Prompt injection

Threat: scraped pages, Reddit posts, API text, imported documents, and
retrieved notes contain instructions ("ignore previous instructions", fake
system messages, hidden text, zero-width or Unicode-tag smuggling, fake
approvals, requests to call tools, fetch URLs, raise budgets, or reveal
secrets).

Mitigations:

- Untrusted text is sanitized (invisible characters, chat-template tokens,
  spoofed boundary markers) and placed in randomly delimited data blocks
  labeled with their trust class; it is never concatenated into instructions.
  The invisible-character set covers every default-ignorable code point,
  including zero-width and bidi controls, variation selectors, Hangul
  fillers, and the Unicode tag characters U+E0000 to U+E007F used for
  "ASCII smuggling".
- Personal identifiers in model-bound data are masked unless the site config
  explicitly allows them with a stated reason (see
  [PRIVACY.md](PRIVACY.md#personal-data-and-language-models)).
- Runtime tools are allowlisted and typed; there is no shell, no unrestricted
  SQL, no URL fetching by the model, and no access to secrets or policies.
- Budgets, approvals, runtime modes, and configuration are enforced in code;
  model output cannot change them. Structured outputs are schema-validated
  with bounded repair.
- Heuristic injection signals are logged for review (never relied on as a
  boundary). Template variables are scanned too, not only evidence.
- Text typed by searchers (Search Console queries) and titles derived from it
  are untrusted: a report claim that embeds such text reaches the
  executive-summary model as `user_reported`, never as a code-computed
  measurement, and the SERP synthesis prompt carries the query only as
  evidence, never in its instructions.
- Untrusted text never reaches the operator's terminal as escape sequences:
  every human output path (CLI output, errors, hints, stderr notices, console
  log lines) shows control, bidi, and invisible characters as visible
  `[U+XXXX]` markers (`src/core/terminal.ts`), while `--json` output and the
  JSON log file keep the exact text. Imports strip C0/C1 control characters
  before storage.
- Tests use the synthetic fixture library with unique canaries to assert that
  no injected content reaches tool calls, approvals, configuration, or
  outbound requests.

Where: `src/security/untrusted.ts`, `src/security/tools.ts`,
`src/integrations/llm/`, `src/approvals/`, `src/budgets/`,
`src/security/injection-fixtures.ts`, `tests/fixtures/security/injection/`.

The `unicode-tag-smuggling` fixture and
`tests/unit/llm/untrusted.test.ts` ("every default-ignorable code point is
stripped") check the invisible-character coverage.

## 4. Approval spoofing and unauthorized production changes

Threat: a Markdown note saying `approved: true`, model output claiming an
approval, a replayed approval, or a changed proposal executing under an old
approval.

Mitigations: approvals exist only in SQLite, are created and decided through
the CLI, and are bound to site, action type, target, artifact hash, source
revision, approver, expiry, and one-time execution. Any change to the proposal
invalidates the approval; the target is rechecked before execution. The default
runtime mode is `ANALYZE`; production actions need `EXECUTE` plus a valid
approval.

Approver and reviewer names are validated (`validateApproverName` and
`resolveApprover` in `src/approvals/approver.ts`). A name is asserted, not
authenticated: whoever runs the CLI can type any name, so the checks catch
accidents and obvious automation, not a determined operator. They refuse
obvious automation and anonymous account names: the name is normalized with
NFKC (fullwidth and other compatibility forms), names whose letters mix
scripts and look-alike spellings (Cyrillic, Greek, Armenian, or small-capital
letters, combining marks) are compared by their skeleton, automation words
inside concatenated names (`claudecode`, `seoagent`, `GitHub-Actions`),
version-numbered tokens (`agent007`, `gpt4o`), and an apostrophe suffix
(`claude's`) are refused, as are the whole names `owner`, `admin`,
`administrator`, `root`, `node`, `runner`, `daemon`, `www-data`, `ubuntu`,
`ec2-user`, `service`, `user`, and `default` and the automation names `cli`,
`system`, `scheduler`, `model`, `agent`, or `claude`. Real names such as
Alice, Kai, José, or O'Brien pass. Where `--as` may be omitted, the
operating-system user is used unless it is a service account (`node`,
`runner`, `root`, `daemon`, `www-data`, `ubuntu`, `ec2-user`, `nobody`): the
container image runs as `node` and GitHub-hosted CI as `runner`, so there a
decision without `--as "<your name>"` (`--by` for `vault apply-business`) is
refused instead of being recorded under the account. The anonymous `owner`
is refused at every gate, including `sync ga4 --confirm-rate-scale`. The
gates that check it:
`approvals approve` / `reject` / `request`, `jobs resume --reviewed` (which
requires `--reviewer`), `jobs locks --release` (requires `--as`),
`experiments specify-change --by` and the other `experiments` decisions,
`costs reconcile --by`, `export --as`, `sync ga4 --confirm-rate-scale`
(requires `--as`: the scale is recorded as a named human's assertion),
`vault apply-business --by` (no anonymous `owner` default: without `--by`
the operating-system user is recorded unless it is a service account, and an
explicit name is validated even in the preview), and `content mark-reviewed` and
`content revise-manual`, whose names are checked inside
`markHumanReviewed` and `reviseDraftManually` for every caller, not only the
CLI (`tests/integration/approvals/human-actor-names.test.ts`,
`tests/unit/approvals/approver.test.ts`,
`tests/integration/google/cli-sync.test.ts`). A production-bound draft
export also needs a named human's recorded acceptance of the exact draft body
(`content mark-reviewed`, bound to the body hash); automated review verdicts
never count, and the publisher checks it again before writing.
`content publish-check` applies the same rule, so an automated pass plus a
valid approval is reported BLOCKED until a named human accepted the body;
its ALLOWED line names who accepted the body, when, and which approval
covers it. The live verification
after `mark-implemented` compares the full page body with the approved
change and reports its coverage instead of matching a fragment.

Where: `src/approvals/`, `src/core/modes.ts`, `migrations/0008_approvals.sql`,
fixture `vault-note-fake-approval`.

## 5. Path traversal and symlink escape

Threat: note titles, URLs, or imported names such as `../../.ssh/config` or a
symlink inside the vault redirect writes outside the workspace.

Mitigations: every vault, export, raw-store, workspace, and diagnostics write
resolves paths through `safeResolve` (rejects absolute paths, `..`, NUL bytes,
and symlinks that escape the base) and uses atomic, non-overwriting writes
where applicable. Diagnostics use `wx` + mode 0600. Note and file names built
from untrusted text never become hidden (dot-prefixed) names, even after
separators collapse, so a crafted keyword or title cannot hide a note or
abort a vault render. The
workspace guard compares real paths (symlinks resolved), so a symlink cannot
place a workspace inside the application repository, and `init` refuses the
file-system root, your home directory, and the system temporary directory
as a workspace. On a case-insensitive volume (macOS APFS, Windows NTFS) the
comparisons also ignore letter case, probed once per device
(`isWithinRealPath`, `isCaseInsensitivePath` in `src/config/paths.ts`), so
`<ws>/Vault/token.json` counts as inside the vault and `<ws>/SECRETS/` as
`secrets/`; credential paths, relocated workspace folders, forbidden roots,
and `data export --out` use them. An explicit `data export --out` is refused
inside the vault, `secrets/`, or the application repository outside the
workspace, and never written through a symbolic link. Site configuration YAML and setup value paths reject the
prototype keys `__proto__`, `constructor`, and `prototype`.

Where: `src/security/paths.ts`, `src/config/paths.ts`, `src/auth/paths.ts`,
`src/cli/commands/data.ts` (`exportTarget`), `src/obsidian/`,
`src/security/diagnostics.ts`.

## 6. Unsafe parsing and execution

YAML is parsed with the core schema and no custom tags; imported Markdown code
blocks are never executed; model-suggested SQL or shell is never run; scraped
scripts run only inside an isolated optional browser context (Playwright is an
optional dependency).

Where: `src/config/load.ts#parseYamlSafe`, `src/crawler/`, fixtures
`yaml-unsafe-tags`, `markdown-code-block-shell`, `sql-suggestion`.

## 7. Paid-service abuse and cost overruns

Threat: injected content or bugs trigger paid requests, duplicate paid jobs
after a timeout, or silent overspend.

Mitigations: cache first, conservative estimate, atomic reservation against
run/site/service/account limits, provider-side caps where supported, the
provider-request log with ambiguous-submission handling, no blind retries of
paid POSTs, unknown costs kept unknown and reserved. `doctor` never spends
money without an explicit flag. See `docs/COSTS.md`.

Where: `src/budgets/`, provider adapters in `src/integrations/`.

## 8. Supply chain

Threats: a compromised or typosquatted dependency, malicious install scripts,
a freshly published malicious version, compromised CI actions.

Mitigations:

- Exact dependency versions and a committed lockfile; `npm ci` in CI.
- Install scripts disabled: `npm ci --ignore-scripts` in CI and the
  Dockerfile. Contributors are encouraged to set `ignore-scripts=true` in their
  npm config (the project runs without install scripts).
- Release-age hardening: set `min-release-age=7` (npm 11+, value in days) in
  your user npm config so versions published in the last 7 days are not
  installed; Dependabot uses a matching 7-day `cooldown`.
  **Check that it is actually in effect:** `npm config get min-release-age`
  must print `7`. A `minimumReleaseAge` entry in `.npmrc` is the pnpm key (in
  minutes) and has **no effect in npm**: npm only prints
  `npm warn Unknown user config "minimumReleaseAge"` and installs freshly
  published versions anyway. If you see that warning, add
  `min-release-age=7` (keep the pnpm key only if you also use pnpm).
- `npm run licenses:check` inventories every installed package (direct and
  transitive) and flags unknown/copyleft licenses.
- Weekly Dependabot PRs for npm and GitHub Actions, reviewed like any change.
- Actions are to be pinned by full commit SHA (currently tag-pinned; see the
  TODO in `docs/RELEASING.md`), and the base image by digest.
- Few runtime dependencies; Playwright is optional and not installed by
  default.

## 9. CI and contributor code

Threats: a pull request exfiltrating secrets or using a write token; untrusted
code running on the owner's machine.

Mitigations: workflow-level `permissions: contents: read`, triggers `push` and
`pull_request` only (never `pull_request_target`), no secrets referenced, no
production credentials anywhere in CI, GitHub-hosted runners only, and
`persist-credentials: false` on checkout. Maintainers never run contributor
code on machines holding production credentials. `CODEOWNERS` requires review
for workflows, auth, approvals, publishing/export, budgets, security helpers,
release tooling, and migrations. `npm run release:check` fails if a workflow
uses `pull_request_target`, secrets, write permissions, or self-hosted runners.

Where: `.github/workflows/ci.yml`, `.github/CODEOWNERS`,
`scripts/release-check.mjs#checkWorkflows`.

## 10. Local services and deployment

Services bind to localhost by default (Qdrant, OAuth callback). A server
deployment must add authentication (Qdrant API key) and network controls
(firewall, private network, TLS termination). The optional container runs as a
non-root user with the workspace mounted as a volume, never baked in.

## Operational guidance

### Credential rotation

Rotate a credential immediately when it may have been exposed (pasted, logged,
committed, shared in a diagnostic bundle you did not inspect), when someone
with access leaves, and periodically (for example every 90 days). The order is
always: **issue the new credential, update the workspace, verify, then revoke
the old one.**

| Credential | Rotate | Update |
| --- | --- | --- |
| `LLM_GATEWAY_API_KEY` | Create a new key in the LLM Gateway dashboard (with a usage limit), then delete the old key | `<workspace>/secrets/secrets.env` or your password manager |
| Google OAuth refresh token | Run `npm run cli -- auth revoke` (or remove the app's access in your Google account), then `npm run cli -- auth google`. Google also exposes token revocation at `https://oauth2.googleapis.com/revoke` (OA1) | token file under `<workspace>/secrets/google/` (written by the CLI) |
| Google OAuth client secret | Add a new secret or create a new Desktop client in Google Cloud Console, re-authorize, then delete the old secret/client | `GOOGLE_OAUTH_CLIENT_FILE` |
| Google service-account key | Create a new key for the service account, switch `GOOGLE_APPLICATION_CREDENTIALS`, verify with `auth status`, then delete the old key (prefer workload identity where available) | key file under `<workspace>/secrets/google/` (0600) |
| `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | Regenerate the API password in the DataForSEO dashboard API Access page (the API password differs from the account password) | secrets file |
| `APIFY_TOKEN` | Create a new token in the Apify Console, then revoke the old one | secrets file |
| `QDRANT_API_KEY` | Set a new key in the Qdrant configuration and restart Qdrant | secrets file and Qdrant config |
| `PAGESPEED_API_KEY` | Create a new, API-restricted key in Google Cloud Console, then delete the old one | secrets file |

After rotating: run `npm run cli -- doctor`, check each provider's usage/billing
history for activity you did not cause, and run `npm run security:scan` if the
old value could have reached the repository.

### Dependency updates

1. Dependabot opens weekly PRs (npm and GitHub Actions) after a 7-day cooldown.
2. Read the changelog/release notes; be suspicious of new install scripts,
   new maintainers, or unexpected new dependencies.
3. CI must pass (typecheck, offline tests, secret scan, license check, release
   check). Run `npm run licenses:check -- --write` and commit the regenerated
   `THIRD_PARTY_NOTICES.md` when the runtime dependency set changes.
4. Install locally with `npm ci --ignore-scripts`; never `npm install` a new
   package without pinning the exact version.
5. Live installations pick up dependency updates only through a tagged release
   (see `docs/UPGRADING.md`).

### Backups, retention, and purge

See `docs/UPGRADING.md` (backup/restore and recovery) and `docs/PRIVACY.md`
(retention and purge).

## Reporting

See `SECURITY.md`.
