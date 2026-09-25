# Module: release security, licensing preparation, diagnostics, community files

Spec coverage: "Open-source distribution and personal-use requirements"
preamble (licensing and community, public-release security, personal use and
upgrades), section 25 (paid-service documentation), section 26 (security and
untrusted research), section 31 (secret redaction and prompt-injection
fixtures).

## Components

| File | Purpose |
| --- | --- |
| `scripts/scan-secrets.mjs` | Secret scan of the working tree and full Git history. Plain Node ESM, no dependencies. |
| `scripts/lib/secret-rules.mjs` | Detection rules, allowlist logic, fingerprints (shared by the scan and the release check). |
| `scripts/secret-scan-allowlist.json` | Allowlist for synthetic fixtures (markers, path markers, fingerprints). Every entry needs a reason. |
| `scripts/check-licenses.mjs` | Dependency license inventory/check and `THIRD_PARTY_NOTICES.md` generator. |
| `scripts/release-check.mjs` | Read-only release readiness checklist. Never publishes. |
| `scripts/lib/release-rules.mjs` | Forbidden release paths, `.dockerignore` evaluator, Dockerfile stage parser and build-stage input rule (`dockerBuildInputProblems`), sample paths for `.gitignore` checks. |
| `scripts/*.d.mts` | Type declarations so TypeScript tests can import the scripts. |
| `src/security/diagnostics.ts` | Redacted diagnostic bundle (collection, identifier masking, config-shape redaction, local integration inspection, rendering, files). |
| `src/cli/commands/diagnostics.ts` | `diagnostics export`, `diagnostics show <file>`, `diagnostics list`. |
| `src/security/injection-fixtures.ts` | Synthetic prompt-injection payload library with canaries for other modules' tests. |
| `tests/fixtures/security/injection/` | Static copies of the fixtures (kept identical by a test). |
| `.github/` | CI workflow, CODEOWNERS, Dependabot, issue and PR templates. |
| `Dockerfile` | Optional multi-stage, non-root container build relying on the `.dockerignore` allowlist; the build stage copies `scripts/write-build-info.mjs` and `migrations/` so `npm run build` can stamp `dist/build-info.json`. |
| Community/policy docs | `CONTRIBUTING.md`, `SECURITY.md`, `SUPPORT.md`, `CHANGELOG.md`, `LICENSE-NOTICE.md`, `THIRD_PARTY_NOTICES.md`, `docs/RELEASING.md`, `docs/SECURITY_MODEL.md`, `docs/DATA_FLOWS.md`, `docs/UPGRADING.md`, `docs/PRIVACY.md`, `docs/COSTS.md`. |

## Commands

```sh
npm run security:scan                      # tree + history; exit 1 on findings, 2 on error/invalid allowlist/incomplete history
node scripts/scan-secrets.mjs --json       # machine-readable report (never contains values)
node scripts/scan-secrets.mjs --no-history | --include-unreachable | --show-allowlisted | --allowlist FILE
node scripts/scan-secrets.mjs --allow-incomplete-history   # accept a shallow clone's partial history (warns)
npm run licenses:check                     # check; warn if notices are stale
npm run licenses:check -- --write          # regenerate THIRD_PARTY_NOTICES.md (runtime deps)
npm run licenses:check -- --check          # fail if notices are missing/stale (CI)
npm run release:check                      # checklist; exit 1 on blocking problems
npm run release:check -- --strict          # warnings block too (use before a public release)
npm run cli -- diagnostics export [--recent-jobs N] [--site ID] [--dry-run] [--json]
npm run cli -- diagnostics show <file|bare-name> [--json]
npm run cli -- diagnostics list
```

## Secret scan design

- **Candidates.** In a Git repository: `git ls-files -co --exclude-standard`
  (tracked plus untracked-not-ignored files, i.e. everything that could be
  committed). Outside Git: a directory walk that skips `node_modules`, `dist`,
  `.git`, `coverage`. Symlinks, binaries, and files over 5 MB are skipped and
  counted.
- **History.** `git log --all -p --root --text --unified=0 --no-renames
  --diff-merges=first-parent` (no pathspec) streams every added line of every
  commit reachable from any ref (`--include-unreachable` adds the reflog),
  every commit message (including empty and merge commits), and every added
  file name. Parsing is structural: per-file headers are read only between
  `diff --git` and the first `@@`, and the `@@ -a,b +c,d @@` counts decide
  which lines belong to a hunk, so added content such as `++ counter` is still
  scanned. Paths with spaces (git appends a TAB) and C-quoted paths are
  normalized. `--text` stops repository `.gitattributes` (`-diff`, `binary`)
  from hiding content; files containing NUL bytes are treated as binary (name
  rules only), and per-file history content is capped at `--max-bytes`.
  Findings are deduplicated by rule+path+fingerprint and report the oldest
  commit and a commit count. A repository with no commits reports `no-commits`
  and still scans the tree.
- **Completeness.** The scan compares the commits it scanned with
  `git rev-list --all --count` and checks `git rev-parse
  --is-shallow-repository`. A shallow clone or a commit-count mismatch is
  reported as `INCOMPLETE` (status `incomplete`, exit 2, "NOT CLEAN"), never as
  clean; `--allow-incomplete-history` accepts it with a warning. The release
  check fails its secret-scan item on incomplete history.
- **Rules.** PEM/OpenSSH/PGP private keys (including JSON-escaped), Google API
  keys, OAuth client secrets (`GOCSPX-`), refresh tokens (`1//0`), access tokens
  (`ya29.`), service-account `private_key_id`, `client_secret` JSON values,
  Apify tokens, LLM Gateway keys (`llmgtwy_`, the documented shape), `sk-` style
  LLM keys, GitHub/AWS/Slack/Stripe/npm tokens, JWTs, Bearer and Basic
  (decoded to `user:pass`) literals, URL credentials, `.npmrc` `_authToken`,
  high-entropy values assigned to secret-named keys (key must end with the
  secret word; code expressions and placeholders are excluded), `.env` files
  with values, and credential/database file names.
- **Output.** Path, line (or commit), rule, value length, and a 16-hex
  fingerprint `sha256("seo-agent-secret-scan:v1:" + value)`. Never the value or
  the line text. Every report states that exposed credentials must be
  **rotated** and that deletion/history rewriting is not remediation.
- **Allowlist.** A value is treated as synthetic when it contains a marker
  (`fake`, `synthetic`, `example`, `dummy`, `notreal`, `notareal`,
  `placeholder`, `redacted`, `changeme`, `xxxxxxxx`, `your-`): markers of 6+
  characters match anywhere (case-insensitive); shorter ones must be
  lower/UPPER/Capitalized and touch a word boundary or occur twice, so random
  base64 in a real key is not exempted by accident. Path-scoped markers apply
  under `tests/**` (`test`, `mock`, `fixture`, `sample`), and individual values
  can be allowlisted by fingerprint with a reason. Prefer a marker inside the
  value (for example `token=SYNTHETICtok123`) or a value built at test runtime.
  `tests/unit/security/repo-secret-scan.test.ts` runs the working-tree scan on
  the repository in the normal test suite and expects zero findings, so an
  unmarked credential-shaped fixture fails `npm test` before it can fail
  `npm run security:scan` or `release:check`.
- **Fabricated-run heuristic (restricted).** Only for machine-generated token
  rules (`RANDOM_TOKEN_RULES`: Google/Apify/LLM Gateway/`sk-`/GitHub/AWS/Slack/
  Stripe/npm tokens, JWTs, Bearer literals, OAuth secrets), a value with a 10+
  character ascending run (`abcdefghij`) or 10+ identical characters is treated
  as fabricated (practically impossible in random credentials). It never
  applies to human-chosen secrets (URL passwords, secret-named assignments,
  `.env` values, Basic credentials: `Summer12345678!` is a real password) or to
  private keys.
- **Private keys.** Markers are honored only in the BEGIN label (for example
  `-----BEGIN FAKE PRIVATE KEY-----`), PEM header, or comment lines of the
  block, never inside the base64 body. OpenSSH keys (whose bodies always contain
  `AAAA...` runs) and indented PEMs (YAML block scalars, template literals) are
  therefore always reported unless fingerprint-allowlisted. A truncated block
  without an END line only honors its BEGIN label.
- **Allowlist validation.** The allowlist file is validated before any scan and
  the scanner exits 2 on violations: every entry needs a `reason` (10+
  characters), markers need 4+ characters, `ignorePaths` entries must be
  objects whose glob starts with a literal directory (no `**`, `*.json`, or
  whole top-level directories), fingerprints must be 16 hex characters, and
  unknown keys are rejected. CI prints the diff of the allowlist and scan rules
  on every pull request that changes them.

## License check design

- Walks `node_modules` recursively (scoped and nested packages). Scope comes
  from `package-lock.json` (`dev`/`devOptional` = development only; otherwise
  runtime; missing from the lockfile = extraneous). Lockfile entries not
  installed on this platform (optional platform binaries) are counted.
- SPDX expressions are parsed (`OR` = most permissive option, `AND` = most
  restrictive, `WITH` exceptions ignored for classification). Categories:
  permissive, weak copyleft (MPL/LGPL/EPL/CDDL), strong copyleft (GPL/AGPL/SSPL/
  EUPL/OSL/CC-BY-SA/NC), unknown, missing.
- Errors: missing/unknown/strong-copyleft **runtime** licenses. Warnings:
  weak copyleft at runtime, problems in dev-only packages, extraneous
  packages, stale notices. `--strict` fails on warnings.
- `THIRD_PARTY_NOTICES.md` is deterministic (no timestamps): summary table,
  per-package copyright lines and verbatim `NOTICE` files, and each distinct
  license text once. Runtime packages only; dev tools are not distributed.
- Current result for this repository: 60 runtime packages, all permissive
  (MIT, ISC, BSD-2/3-Clause, Apache-2.0); two dev-only MPL-2.0 packages
  (lightningcss) reported as informational.

## Release check

Blocking (`FAIL`): no `"files"` allowlist; private paths in `"files"` or the
`npm pack --dry-run --json --ignore-scripts` list; credential patterns in
packed file contents; `.dockerignore` not deny-all first; private sample paths
or real files entering the Docker context; Dockerfile running as root or
copying private paths; `.gitignore` not ignoring critical private paths
(including `.env`, databases, `secrets/secrets.env`, and credential JSON nested
inside every public directory such as `src/`, `tests/`, `docs/`, so a broad
negation like `!src/**` after the deny rules is caught and the negating
pattern is named) or hiding public ones; private files Git would commit; committed non-example
site configs; a real-looking example config; secret-scan findings, an invalid
allowlist, or an INCOMPLETE history scan (shallow clone); runtime
license errors; missing community files; CI using `pull_request_target`,
secrets, write permissions, self-hosted runners, or lacking a `permissions:`
block; inconsistent license files; a published fixture under `tests/fixtures/`
that is not labeled synthetic (a `_synthetic` marker, a header comment, or a
labeled README in its directory or an ancestor); a container build that would not include the
SYNTHETIC runtime fixtures (`demo/`, `google/`, `pipelines/site/`) in both the
build context and the runtime stage (`docker-fixtures`); a Dockerfile build
stage (the stage that runs `npm run build`) that does not COPY, before that
`RUN`, every local file package.json `"build"` runs (`node <file>`,
`tsc -p <file>`) plus `src/` and `migrations/` when it runs the build-stamp
script, or whose inputs `.dockerignore` keeps out of the build context
(`docker-build-inputs`: without `scripts/write-build-info.mjs` `docker build`
fails, and without `migrations/` the image's stamp records
`"migrations": null`, so the container would skip every build/migration
freshness check); packed build output that is not a fresh, stamped
`npm run build` (`npm-pack-build`: `dist/build-info.json` missing from the
package or from `dist/`, a stamp that does not match package.json, `src/`, or
`migrations/`, a stamp without a migration list, a missing bin target, or no
`dist/` at all although package.json ships it). The stamp is compared by
`verifyBuildInfo()` in `scripts/write-build-info.mjs` (the same comparison as
`checkBuildFreshness()`, without importing the compiled code being checked);
the fix it names is `npm run build`.

Forbidden-path rules have no directory exemptions: a `secrets/` or
`workspace/` (`seo-agent-workspace/`, `demo-workspace/`) directory is flagged at
any depth, including inside `src/`, `dist/`, `docs/`, and `tests/`.

Warnings: license not selected; `private: true` missing; no build output in a
package that does not ship one (no bin, no `dist/` in `"files"`); defense-in-depth gaps (see open issues); container image without
`THIRD_PARTY_NOTICES.md` (`docker-notices`); owner placeholders in
`SECURITY.md`/`CODEOWNERS`/issue config; tag-pinned actions; missing changelog
entry; ignored real configs inside the repository.

It always prints the manual owner steps (license choice, placeholders,
rotation, package/image review, SHA pinning, changelog, explicit approval for
any public action) and ends with "Nothing was published, pushed, tagged, or
uploaded".

## Diagnostics design

- Built read-only from the workspace: site configs (failures become redacted
  error lines), the secret store (presence only), and the database opened
  read-only.
- **Scope.** `--site ID` restricts the per-site sections (sites, jobs, provider
  requests, reservations, circuit breakers, and log lines attributed to another
  site) to that site; the bundle's `scope` field records the restriction.
  Identifiers of EVERY site are still registered for masking before anything is
  scrubbed: reported sites, sites excluded by `--site`, configs that fail
  validation (read leniently from the raw YAML by path; if the YAML does not
  parse, from URLs, hostnames, identifying `key: value` lines, and identifying
  lists in the raw text), and every site in the database (`sites.name`,
  `sites.base_url`, and recent `config_versions`). It never runs migrations and never writes to the database; it
  works when configuration is invalid or the database is missing.
- Contents: app/Node/OS/SQLite versions, Playwright presence, workspace layout
  with `<WORKSPACE>` placeholders (file counts, sizes, modes), secrets-file
  permission status, environment-variable presence and source, per-site
  feature flags (effective and explicit), configuration shape, local
  integration states, migration status (applied/pending/unknown/checksum
  mismatches, computed without creating tables), per-site job counts and the
  most recent jobs with redacted errors, provider-request and reservation
  counts, circuit-breaker states, row counts per table (and synthetic rows),
  and warn/error log messages.
- Statuses produced by `doctor` (network checks) can be passed in as
  `integrationStatuses`; they appear under `reportedIntegrations` with scrubbed
  details, separate from the local (no-network) inspection.
- Config shape keeps booleans, numbers, zod enums/literals (read from the
  schema), time zones, cron expressions, currency codes, and budget/cap
  amounts. Other strings become `<redacted>`; hostnames, URLs, properties, and
  GA4 IDs become keyed hashes (`<host h:xxxxxxxx>`), so equality is visible
  within one bundle.
- Free text passes through `redactString`, extra credential shapes, exact
  secret values, path placeholders, URL hashing (public API hosts keep only
  scheme and host), emails, registered identifiers (site IDs, hostnames,
  business/brand/competitor/event names, subreddits, DataForSEO login, machine
  hostname, OS user), `sc-domain:` properties, non-loopback IPv4, hostnames with
  common TLDs, and 7+ digit numbers.
- HMAC key: random per export and discarded, so hashes cannot be
  dictionary-reversed across bundles.
- Final self-check: every STRING VALUE in the bundle is searched for every
  registered secret and identifier; leftovers are removed and counted. Object
  keys are never rewritten for identifiers (they are the bundle's own schema;
  the few user-derived keys, such as kept budget record keys and log levels,
  are sanitized when built), so an identifier that equals a key name
  (`database`, `format`, `environment`) cannot corrupt the bundle. Values at
  schema-enum paths (states, statuses, labels) are kept. Registered secrets are
  removed everywhere, keys included.
- Files: `<workspace>/diagnostics/diagnostics-<UTC stamp>-<rand>.json|.md`,
  mode 0600, created with `wx` (never overwrite). The CLI prints both paths,
  tells the user to INSPECT them, and states nothing was uploaded.
  `--dry-run` prints the bundle without writing.

## Injection fixtures

`INJECTION_FIXTURES` (23 fixtures) cover visible competitor text, HTML
comments, hidden elements, meta tags, alt text, JSON-LD with boundary spoofing,
scripts/SSRF targets, unsafe link schemes, chat-template tokens, Reddit posts
and zero-width-hidden comments, SERP JSON fields, nested fake chat/tool-call
objects, vault notes with forged approval frontmatter, Markdown code blocks,
unsafe YAML tags, SQL suggestions, bidi overrides, Unicode tag smuggling,
homoglyphs, base64 payloads, Markdown image exfiltration, and model output
claiming approval. Each has a unique canary, forbidden effects, and the
expected handling. Helpers: `competitorPageHtml()`, `redditDataset()`,
`serpApiResponse()`, `vaultNoteWithFakeApproval()`, `withZeroWidth()`,
`toUnicodeTags()`, `findCanaries()`, `findCanaryLeaks()` (deep search of tool
calls, approvals, config, outbound request logs). The TypeScript source is pure
ASCII (every invisible, bidi, and homoglyph character is a `\u` escape; a test
enforces it), so it cannot hide or reorder its own code (Trojan Source).

`tests/unit/security/injection-pipeline.test.ts` runs every fixture, the full
competitor page, the Reddit/SERP datasets, and the forged vault note through
`renderEvidenceBundle` in `src/security/untrusted.ts` and asserts that every
canary stays inside a genuine data block (payloads cannot close a block early),
zero-width/bidi characters and Unicode tag characters (U+E0000..U+E007F,
"strips Unicode tag characters (ASCII smuggling)") are removed, and no canary appears in the
`prompts/system.*.md` templates, the runtime tool specs, or the site config.

## Data sent externally

None. The scripts and diagnostics are offline. `release-check` runs
`npm pack --dry-run --ignore-scripts` (local; no registry request) and `git`
commands on the local repository. Diagnostics are written locally and never
uploaded. CI runs on GitHub-hosted runners with the repository contents only.

## Limitations

- Secret detection is pattern-based: it cannot find every credential format
  (for example a short random password in an unusual variable name). Use it as
  a gate, not a guarantee.
- The history scan covers refs and (optionally) the reflog of the local clone,
  not other clones, forks, or CI caches.
- Diagnostics masking is heuristic for free text; hostnames with uncommon
  generic TLDs are masked only when they come from configuration (valid or
  not) or the database. The user must inspect the bundle before sharing.
- The Dockerfile's optional notices COPY (`THIRD_PARTY_NOTICES.m[d]`) relies on
  BuildKit/classic-builder handling of a wildcard that matches nothing when
  another source exists; this was not verified with a real Docker build.
- The Dockerfile parser behind `docker-build-inputs` handles stages
  (including `FROM <stage>` inheritance), line continuations, flags, and the
  JSON form of COPY/ADD; it ignores `COPY --from` (not the build context) and
  heredocs, and does not check COPY destinations. The build-stage fix itself
  was checked by simulating the build context (tests copy what the build
  stage's COPY lines would bring in and run the stamp script), not with a real
  Docker build.
- `.dockerignore` evaluation reimplements Docker's pattern semantics (`*`, `**`,
  `?`, `[...]`, `!`, last match wins, parent exclusion); exotic patterns may
  differ slightly. Build the image and list its files before releasing.
- GitHub Actions are tag-pinned until the owner verifies commit SHAs.
- Human approver and reviewer names are asserted, not authenticated: whoever
  runs the CLI can type any name. `src/approvals/approver.ts` refuses only
  obvious automation and account names (NFKC-normalized; mixed-script and
  look-alike spellings, "claudecode"-style concatenations, "agent007",
  "claude's", and the whole names owner, admin, root, node, runner, user, ...).
  The Docker image runs as the `node` user and GitHub-hosted CI as `runner`;
  both are service accounts, so without `--as "<your name>"` (`--by` for
  `vault apply-business`) a decision there is refused instead of being recorded
  under the container or runner account.
- Path checks that keep credentials, relocated workspace folders, and
  `data export --out` files out of the vault, `secrets/`, and the application
  repository compare real paths: symbolic links resolved with the operating
  system's realpath (canonical letter case), and letter case ignored on a
  case-insensitive volume (macOS APFS, Windows NTFS), so `<ws>/Vault/token.json`
  counts as inside `<ws>/vault`. Case sensitivity is probed once per device;
  a volume that cannot be probed is assumed case-insensitive on macOS and
  Windows and case-sensitive elsewhere. Unicode normalization differences in
  file names that do not exist yet are folded to NFC only.
- Query-parameter redaction masks a secret-named value up to `&`, whitespace,
  `"`, `#`, `<`, `>`, or a `,` that starts another URL. A raw `<`, `>`, or
  `,https://` inside a secret (never produced by URL encoding) would leave the
  rest of that value visible.

## Next steps for the owner (no credentials needed)

1. ~~Choose a license and apply it~~: done, MIT (`LICENSE`, recorded in `LICENSE-NOTICE.md`).
2. ~~Replace the owner placeholders~~: done (`@fdrissi`, `fdrissi/seo-agent`,
   GitHub private vulnerability reporting in `SECURITY.md`). Branch protection
   is on: the "Protect main" repository ruleset blocks direct pushes, force
   pushes, and deletion of `main`, and requires a pull request with code-owner
   approval plus passing `typecheck + tests (Node 24)` and
   `secret scan, licenses, release check` checks. Admins can bypass only
   through a pull request.
3. Pin actions and the base image (`docs/RELEASING.md`).
4. Run `npm run release:check -- --strict` and approve any public action
   explicitly.
