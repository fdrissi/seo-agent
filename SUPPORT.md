# Support policy

seo-agent is self-hosted, community-supported software. Support is **best
effort**: there is no service-level agreement, no guaranteed response time,
and no paid support tier.

## There is no hosted service

- The maintainers do not operate a backend, shared OAuth application, shared
  API keys, or telemetry. Nothing is sent to the maintainers by the application.
- Every installation uses its **own** accounts, credentials, budgets, and
  infrastructure. Maintainers cannot see your data, cannot reset your
  credentials, and cannot recover a lost workspace or database; keep backups
  (`npm run cli -- backup`, see `docs/UPGRADING.md`).
- Costs charged by third-party providers are between you and the provider
  (see `docs/COSTS.md`).

## Supported environments

| Component | Supported |
| --- | --- |
| seo-agent | the latest released minor version (see `CHANGELOG.md`); upgrade before reporting |
| Node.js | **24 LTS** (the version in `.nvmrc`). Node 26 is tested in CI as informational until it becomes LTS (scheduled 2026-10-28), then it joins the supported list. End-of-life Node versions are unsupported. |
| npm | the version bundled with the supported Node.js release |
| OS | macOS and Linux. Windows and the optional container image are best effort. |
| Qdrant | the version pinned in `compose.yaml` |

Running a live installation from the development branch is not supported. Use
tagged releases (see `docs/UPGRADING.md`).

## In scope

- Installation, workspace initialization, configuration, and upgrades following
  the documentation.
- Bugs in the application, its adapters, migrations, reports, and CLI.
- Documentation errors, including integration setup steps in
  `docs/ACCESS_SETUP.md` and verified contracts in
  `docs/integration-contracts.md`.
- Security issues: follow `SECURITY.md` (never a public issue).

## Out of scope

- Your provider accounts: Google Cloud/OAuth consent configuration decisions,
  billing disputes, quota increases, DataForSEO/Apify/LLM Gateway account
  issues. Contact the provider.
- SEO strategy, ranking or revenue outcomes. The tool never promises them.
- Custom forks, modified deployments, or recovering data without backups.
- Integrations that are not implemented (for example a CMS publisher for a
  platform that has not been configured). Feature requests are welcome.

## How to get help

1. Read `README.md`, `docs/ACCESS_SETUP.md`, and `docs/UPGRADING.md`.
2. Run `npm run cli -- doctor` (it never spends money without an explicit flag).
3. Search existing issues.
4. Open a bug report using the template. Attach only a **redacted** diagnostic
   bundle that you have **inspected**: `npm run cli -- diagnostics export`
   writes it to `<workspace>/diagnostics/` and never uploads anything.

Never paste secrets, tokens, credential files, or private data into an issue.
If you did, rotate the credential immediately (see `SECURITY.md`).
