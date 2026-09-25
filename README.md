# seo-agent

A self-hosted, local-first SEO, AEO (answer-engine optimization), and content
intelligence agent. It measures your website with first-party data, checks
that the data is trustworthy, routes each page through deterministic rules,
researches only a short list of opportunities within budgets you set, and
proposes one evidence-backed action per cycle, or an explicit decision to
change nothing. A human approves every production change.

```
MEASURE -> VALIDATE DATA -> ROUTE -> PRIORITIZE -> RESEARCH -> PROPOSE
  -> HUMAN APPROVAL -> VERIFY IMPLEMENTATION -> MEASURE AGAIN -> RECORD LEARNINGS
```

> **Status: version 0.1.0, pre-release.** Every integration is implemented
> and tested offline against synthetic fixtures (296 offline test files with
> 3390 tests, all passing on 2026-09-25 on Node.js 24 and 26). **No
> integration has been tested live with real credentials**: not Google, the
> LLM Gateway, DataForSEO, Apify, PageSpeed/CrUX, or a running Qdrant. The
> first live run may surface response details the fixtures do not model.
> See [docs/FEATURE_STATUS.md](docs/FEATURE_STATUS.md) for the honest status
> of every feature, including what is still incomplete.

## What it is, and what it is not

It is:

- **One reusable application** that each installer runs on their own machine
  or server, with their own accounts, API keys, Google credentials, budgets,
  and infrastructure.
- **Evidence first.** Numbers are computed in code, never by a model. Every
  report claim is labeled `OBSERVED`, `INFERRED`, `HYPOTHESIS`,
  `RECOMMENDATION`, or `DATA UNAVAILABLE`, with source links. Missing data is
  reported as missing, never as zero.
- **Human-gated.** Drafts, exports, and experiments need an approval bound to
  the exact proposal (artifact hash, source revision, expiry, one-time use).
  Writing `approved: true` in a Markdown note authorizes nothing. The name
  you give with `--as` is recorded as asserted, not authenticated: obvious
  automation and account names (`owner`, `root`, `node`, `runner`, ...) are
  refused, so on a server or in the container pass `--as "<your name>"`.
- **Budget-bounded.** Every paid request is estimated, reserved against
  per-run, per-site, per-service, and account ceilings, then reconciled.
  Unknown cost is never counted as $0, and paid requests are never retried
  blindly.

It is not:

- **Not a SaaS.** There is no hosted service, no maintainer-operated backend,
  no shared credentials, and no mandatory account with this project.
- **No telemetry.** The application sends nothing to the maintainers. It only
  contacts the providers you enable (see
  [docs/DATA_FLOWS.md](docs/DATA_FLOWS.md)). Local-first does not mean that
  external API processing is local: enabled providers receive the data listed
  there.
- **Not an autopilot.** It does not publish, redirect, merge, delete, or change
  canonical, robots, or analytics settings on its own. Version 1 ships a
  manual-export publisher only; you deploy the exported change and record it
  with `experiments mark-implemented`.
- **No promises.** It never promises rankings, traffic, revenue, or AI
  citations. Before/after comparisons are observational, not proof of cause.

## Public application, private workspace

The repository holds code, prompts, migrations, tests, documentation, vault
templates, and synthetic fixtures. Everything real lives in a **private
workspace outside the repository** (default `~/seo-agent-workspace`):

| In the repository (public) | In your private workspace |
| --- | --- |
| `src/`, `prompts/`, `migrations/`, `tests/`, `docs/` | `config/sites/<site-id>.yaml` (your site config) |
| `config/sites/example.site.yaml` (synthetic) | `secrets/` (0700: `secrets.env`, Google credential files) |
| `vault/_template/` | `vault/<site-id>/` (your Obsidian-compatible vault) |
| synthetic fixtures in `tests/fixtures/` | `data/seo-agent.sqlite`, raw responses, cache, `qdrant/` |
| | `reports/`, `exports/`, `logs/`, `backups/`, `diagnostics/` |

Workspace location: `--workspace` > `SEO_AGENT_WORKSPACE` >
`~/seo-agent-workspace`. `init` never overwrites existing files, and upgrades
never rewrite your workspace. Details: [docs/WORKSPACE.md](docs/WORKSPACE.md).

## Setup profiles

| Profile | What it enables | Credentials | Money |
| --- | --- | --- | --- |
| **Demo** | The whole pipeline on synthetic fixtures in an isolated demo workspace | None | None; zero network requests |
| **Core** | Google Search Console + GA4 ingestion, own-site crawling, SQLite, Markdown reports and vault; AI analysis once a model connection is configured | Google (OAuth or service account); LLM Gateway optional | Free Google APIs (quota-limited); LLM calls only if you configure them |
| **Full** | Core plus LLM Gateway, embeddings and Qdrant memory, DataForSEO, Apify, PageSpeed/CrUX, optional Playwright rendering | Google, LLM Gateway, DataForSEO, Apify, PageSpeed key; Docker for Qdrant | Paid providers, always within your configured ceilings |

Optional integrations that are disabled or unavailable degrade only their own
stage and say so; they never break unrelated workflows or produce invented
data. The feature table per profile is in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md#setup-profiles).

## Quickstart: the offline demo

Requirements: **Node.js 24 LTS** (`.nvmrc` says `24`; `package.json` requires
Node 24 or newer; newer "Current" releases run but `doctor` recommends an
Active LTS line) and npm. The offline suite was verified on Node.js 24.21.0
and 26.3.0. Docker is only needed for Qdrant in the Full profile.

```sh
nvm use                 # or install Node 24 LTS another way
npm ci --ignore-scripts # exact locked versions, no install-time scripts
npm run demo            # offline demo: a few seconds, no credentials, no network
```

The demo creates an isolated workspace in `<os tmpdir>/seo-agent-demo` and runs
the real code paths on a fictional business (labeled SYNTHETIC everywhere):
baseline ingestion, vault generation, a weekly job that is interrupted and
resumed from its checkpoints, deterministic routing, a sourced recommendation,
the content brief/draft/quality-review workflow with a draft approval, an
experiment through `mark-implemented`, and budget denials. It prints where to
look (vault, reports, export package). The demo's weekly report ends with
the same first step a live site usually needs: confirming the GA4 key-event
rate scale before conversions are assessed. See [docs/DEMO.md](docs/DEMO.md).

## First run for a live site

The exact command sequence, from a fresh checkout. Each step is explained in
[docs/ACCESS_SETUP.md](docs/ACCESS_SETUP.md), which also covers creating the
Google Cloud project, the OAuth client, and every provider account.

```sh
# 0. Install (Node 24 LTS) and, optionally, watch the demo
npm ci --ignore-scripts
npm run demo

# 1. Create your private workspace (outside this repository; never overwrites)
npm run cli -- init

# 2. Describe your site (interactive, resumable; asks only for missing answers)
npm run setup

# 3. Credentials: edit <workspace>/secrets/secrets.env yourself (mode 0600) or
#    inject variables from a password manager. Never paste secrets into a chat.
#    Save the Google "Desktop app" OAuth client JSON as
#    <workspace>/secrets/google/oauth-client.json and chmod 600 it, then:
npm run cli -- auth google
npm run cli -- auth status        # lists the Search Console properties you can read
npm run cli -- setup --update --site <site-id> --only google.searchConsoleProperty,google.ga4PropertyId

# 4. Vault and health checks (doctor never spends money)
npm run cli -- setup vault
npm run doctor
npm run doctor -- --network       # free, read-only provider checks

# 5. Baseline: 90 days of GSC/GA4 history, bounded crawl, reports. No paid research.
npm run cli -- --dry-run baseline # shows the plan and the proposed cost plan
npm run baseline                  # add --approve-cost-plan <usd> only after reviewing it
npm run cli -- report show baseline

# 5b. Conversions: work through the checklist, then confirm the GA4 key-event
#     rate scale once (compare one stored rate with the GA4 interface; no request)
npm run cli -- sync ga4 --checklist
npm run cli -- sync ga4 --confirm-rate-scale fraction --evidence "<what you compared>" --as "<your name>"   # or: percent

# 6. Weekly cycle, then review the one recommendation (or no-action decision)
npm run weekly                    # add --mode RESEARCH for budgeted DataForSEO research
npm run cli -- report show weekly
npm run costs
```

With several sites in one workspace, add `--site <id>` to each command.
Enable scheduling only after a successful manual run
([docs/SCHEDULING.md](docs/SCHEDULING.md)). What to expect in the first four
weeks: [docs/FIRST_MONTH.md](docs/FIRST_MONTH.md).

## Paid services: budgets are ceilings, not quotes

Several optional providers charge money (LLM Gateway, DataForSEO, Apify).
The per-site starting budgets (LLM Gateway $5/month including embeddings,
DataForSEO $1/week and $10/month, Apify $10/month, a combined variable API
ceiling of $25/month) are **spending limits you configure**. They are not
verified prices, not a promise that your workload fits, and not your total
cost. Deposits and minimum payments (for example DataForSEO's documented $50
minimum payment), top-up fees, subscriptions, infrastructure, and taxes are
outside these budgets. There are no automatic top-ups or budget increases.
Also set provider-side limits where available: provider billing can lag, so
application checks cannot guarantee zero overshoot. Details:
[docs/COSTS.md](docs/COSTS.md).

## Documentation

| Topic | Document |
| --- | --- |
| Accounts, credentials, verification, revocation for every integration | [docs/ACCESS_SETUP.md](docs/ACCESS_SETUP.md) |
| Every command and option, npm aliases | [docs/CLI.md](docs/CLI.md) |
| What is implemented, tested, awaiting credentials, or incomplete | [docs/FEATURE_STATUS.md](docs/FEATURE_STATUS.md) |
| Spec requirements mapped to code and tests | [docs/REQUIREMENTS_TRACEABILITY.md](docs/REQUIREMENTS_TRACEABILITY.md) |
| Your first month | [docs/FIRST_MONTH.md](docs/FIRST_MONTH.md) |
| Local machine or server, backups, rotation, updates | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| Scheduling (opt-in) | [docs/SCHEDULING.md](docs/SCHEDULING.md) |
| Site configuration reference and precedence | [docs/CONFIGURATION.md](docs/CONFIGURATION.md) |
| Workspace layout, backup, restore | [docs/WORKSPACE.md](docs/WORKSPACE.md) |
| Costs and paid-service requirements | [docs/COSTS.md](docs/COSTS.md) |
| What leaves your machine | [docs/DATA_FLOWS.md](docs/DATA_FLOWS.md), [docs/PRIVACY.md](docs/PRIVACY.md) |
| Security model and threat handling | [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) |
| Upgrades, migrations, recovery | [docs/UPGRADING.md](docs/UPGRADING.md) |
| Architecture and module map | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/modules/](docs/modules/) |
| Architectural decision records | [docs/adr/](docs/adr/README.md) |
| Verified provider contracts (retrieved 2026-09-24) | [docs/integration-contracts.md](docs/integration-contracts.md) |
| Offline demo | [docs/DEMO.md](docs/DEMO.md) |
| Releasing | [docs/RELEASING.md](docs/RELEASING.md) |

## Development

```sh
npm run typecheck        # tsc --noEmit (strict)
npm test                 # all tests, offline: the global fetch throws in tests
npm run check            # both
npm run build            # compile to dist/ and stamp dist/build-info.json (rebuild after every checkout)
npm run security:scan    # working tree + Git history, never prints values
npx tsx scripts/cli-reference.ts   # regenerate the reference sections of docs/CLI.md
```

Tests never reach the network and never use real credentials. There are no
automated live tests; the only chargeable actions are CLI commands that you
run with an explicit spend flag and a displayed cap. Contributor rules:
[CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## License

seo-agent is released under the [MIT License](LICENSE), Copyright (c) 2026
Fadel Drissi Toubbali. The license covers only this project's own code,
prompts, documentation, and templates. It does not cover, and cannot grant
rights to, the third-party services and APIs the application connects to, the
data you collect through them, or third-party dependencies, which keep their
own licenses (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[LICENSE-NOTICE.md](LICENSE-NOTICE.md)).

## Security and support

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md);
never in a public issue. If a credential was exposed anywhere, rotate it at
the provider: deleting the text is not remediation. For bug reports, attach a
redacted bundle from `npm run cli -- diagnostics export` only after inspecting
it. Support policy: [SUPPORT.md](SUPPORT.md). Changes:
[CHANGELOG.md](CHANGELOG.md).
