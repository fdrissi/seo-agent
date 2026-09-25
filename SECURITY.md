# Security policy

seo-agent is self-hosted software. Every installation runs on its owner's
machine or server with the owner's own credentials. There is no
maintainer-hosted backend, shared credential, or telemetry endpoint to attack,
so most reports concern the code itself or its documentation.

## Reporting a vulnerability

**Do not open a public issue, pull request, or discussion for a
vulnerability.**

- Preferred: GitHub private vulnerability reporting ("Report a vulnerability"
  on the repository's Security tab), once the owner enables it.
- Alternative contact: `<SECURITY_CONTACT>`

> OWNER ACTION REQUIRED: replace `<SECURITY_CONTACT>` with a monitored
> address (or remove the line if you rely only on private vulnerability
> reporting) and enable private vulnerability reporting before the repository
> becomes public. `npm run release:check` warns while the placeholder remains.

Please include the affected version or commit, a description of the impact,
and reproduction steps **using synthetic data** (example.com / *.test domains,
fixtures from `tests/fixtures/`). Do not send real credentials, real site data,
or another person's data. If you need to show an exposed credential pattern,
describe its shape instead of pasting it.

What to expect (best effort; this is a community project without a paid
security team):

- acknowledgement within 7 days;
- an initial assessment within 21 days;
- coordinated disclosure: a fix and advisory before public details, normally
  within 90 days, sooner for actively exploited issues. We credit reporters who
  want credit.

## If you exposed a credential

If you pasted an API key, token, OAuth client secret, refresh token, service
account key, or password anywhere public (issue, commit, log, chat):

1. **Rotate it immediately** at the provider (revoke and reissue). Deleting the
   comment, file, or commit, or rewriting Git history, is **not** remediation:
   the value may already be cloned, cached, or indexed.
2. Put the new value only in `<workspace>/secrets/secrets.env` (mode 0600) or a
   password-manager-injected environment variable.
3. Check the provider's usage/billing history for unexpected activity.

`npm run security:scan` scans the working tree and the full Git history for
credential patterns without printing them.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest released minor (currently `0.1.x`, pre-1.0) | Yes |
| Older releases | No; upgrade using `docs/UPGRADING.md` |
| Unreleased development branch | No; never run a live installation from it |

Supported runtime: the Node.js versions in `SUPPORT.md` (currently Node 24 LTS).

## Scope

In scope (examples):

- **Secret handling**: credentials printed, logged, written to reports, the
  vault, diagnostics bundles, or release artifacts; redaction bypasses;
  insecure file permissions on the secrets directory.
- **SSRF and network safety**: the crawler reaching private, loopback,
  link-local, or cloud-metadata addresses, unsafe schemes, redirect or DNS
  rebinding bypasses, unsafe browser subrequests.
- **Prompt injection**: untrusted content (scraped pages, Reddit posts, API
  text, imported or retrieved notes) changing system prompts, tools, budgets,
  permissions, configuration, or approval records; escaping untrusted-data
  blocks; invoking tools outside the allowlist.
- **Approval and policy bypass**: production actions without a valid human
  approval bound to the exact proposal, approval spoofing via Markdown or model
  output, replay of one-time approvals.
- **Budget bypass**: paid requests without reservation, blind retries of paid
  POSTs, unknown costs recorded as zero.
- **Path traversal / symlink escape** in vault, export, raw-store, workspace,
  or diagnostics writes.
- **Unsafe parsing/execution**: YAML tags, executing imported Markdown code
  blocks, SQL or shell suggested by a model.
- **Supply chain and CI**: workflow privilege escalation, secret exposure in
  CI, dependency confusion in this repository's configuration.
- **Release artifacts**: private workspace data or credentials able to enter
  the npm package or container image.

Out of scope:

- Vulnerabilities in third-party services (Google, LLM Gateway, DataForSEO,
  Apify, Qdrant, Reddit) or their SDKs; report those to the vendor.
- Findings that require an attacker who already controls your machine, your
  workspace, or your provider accounts.
- Your own deployment choices outside the documented defaults (for example
  exposing Qdrant publicly without authentication after reading the warning).
- Rate limits, cost overruns caused by manually raised budgets, SEO outcomes.

See `docs/SECURITY_MODEL.md` for the threat model and where each mitigation
lives in the code.
