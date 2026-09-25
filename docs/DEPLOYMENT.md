# Deployment and operations

seo-agent is a local command-line application with a private workspace. It
opens no inbound port, runs no web server, and needs no maintainer service.
You can run it on your own computer or on a continuously running server you
control. This page covers choosing between them, scheduling, protecting
Qdrant, backups and retention, credential rotation, and updates.

Honest status: the container image and the CI workflow were written and
statically checked but never built or executed in this project, and no
deployment has been exercised against live providers (see
[FEATURE_STATUS.md](FEATURE_STATUS.md)). Treat a first server deployment as
a test.

## Local machine or continuously running server

| | Local machine (laptop or desktop) | Continuously running server (small VM, home server) |
| --- | --- | --- |
| Best for | Getting started, manual weekly runs, sites where a missed slot is fine | Dependable scheduled weekly and monthly runs |
| Google auth | OAuth Desktop flow works (browser and CLI on the same machine) | **Service account** (or workload identity). The OAuth loopback flow needs a local browser, and an External app in Testing expires after 7 days |
| Scheduling | launchd (macOS), systemd user timer, or cron tick; nothing runs while the machine sleeps or is off | systemd timer tick or the `schedule run` foreground daemon under a service manager |
| Qdrant | `docker compose up -d qdrant`, bound to 127.0.0.1 | Same host and localhost binding preferred; see [Qdrant on a server](#qdrant-on-a-server) if it must be remote |
| Obsidian | Open the vault folder directly | Sync or copy the vault to a machine with Obsidian, or read the Markdown on the server; the vault works without Obsidian |
| Risk to watch | Missed runs while asleep | The server holds credentials with spending power: harden it, restrict SSH, keep the workspace 0700 |

Both use the same installation path: a tagged release, `npm ci
--ignore-scripts`, a private workspace outside the repository
([UPGRADING.md](UPGRADING.md), [WORKSPACE.md](WORKSPACE.md)). For unattended
use, prefer a built install (`npm run build`, then `node dist/cli/main.js`);
`schedule instructions` warns when its commands would run TypeScript sources
through `tsx`. Rebuild after every checkout: `npm run build` stamps
`dist/build-info.json`, `schedule run` refuses a compiled build that is
unstamped or does not match `migrations/`, and `schedule instructions` never
points a scheduler at a stale build ([SCHEDULING.md](SCHEDULING.md)).

### Server checklist

1. A dedicated unprivileged user owns the application and the workspace
   (`chmod 700` on the workspace and `data/`; `secrets/` 0700, `secrets.env`,
   `secrets/google/*`, and `data/seo-agent.sqlite` with its `-wal`/`-shm`
   files 0600). `doctor` checks these modes and prints the exact `chmod`
   commands; `npm run doctor -- --server` applies this checklist strictly:
   a workspace, `data/` directory, or database readable by other users is a
   failure, not a warning.
2. Credentials come from `<workspace>/secrets/secrets.env` or environment
   variables injected by your secret manager or service manager, never from
   unit files, plists, crontabs, shell history, or the repository.
3. Google: service-account or workload-identity credentials with Restricted
   (Search Console) and Viewer (GA4) access only
   ([ACCESS_SETUP.md](ACCESS_SETUP.md#36-service-account-path-unattended-servers)).
4. Outbound network only: seo-agent needs HTTPS to the providers you enable
   and HTTP(S) to your own site for crawling. It opens no listening port
   (the OAuth loopback listener is temporary and bound to 127.0.0.1, and is
   not used with service accounts).
5. Provider-side spend limits are set (LLM Gateway key limit, DataForSEO cost
   limit, Apify run caps), because application checks cannot guarantee zero
   overshoot when provider billing lags.
6. `npm run doctor -- --server` and `npm run doctor -- --network` pass, then one manual
   `baseline` and one manual `weekly` succeed before scheduling is enabled
   (`schedule enable` refuses without a successful manual run unless you pass
   `--force`).
7. Keep demo and live data apart: a demo workspace (`npm run demo`) refuses
   non-demo sites, and a live workspace refuses a demo-profile site, so
   synthetic fixtures never mix with real data. `doctor` reports a mix as
   `FAIL`, including current Search Console or GA4 rows labeled synthetic
   in a live database, and `data import` refuses a synthetic file in a live
   workspace.
8. Commands that record a human decision (approvals, experiments, exports,
   `vault apply-business`) record the operating-system user when `--as`
   (`--by`) is omitted. On a server that is the service user, not you, so
   pass `--as "<your name>"` (`--by` for `vault apply-business`); `costs
   reconcile`, `jobs resume --reviewed`, and `sync ga4 --confirm-rate-scale`
   always require a name. The common service-account users (`node`,
   `runner`, `root`, `daemon`, `www-data`, `ubuntu`, `ec2-user`, `nobody`)
   are refused as the default outright, and account names are refused as
   values. The name is recorded as asserted, not authenticated.

### Optional container image

The `Dockerfile` builds a multi-stage image on `node:24-bookworm-slim`,
installs with `npm ci --ignore-scripts`, runs as the non-root `node` user,
and expects your workspace as a mounted volume at `/workspace` (it is never
baked into the image):

```sh
docker build -t seo-agent:vX.Y.Z .
docker run --rm -v "$HOME/seo-agent-workspace:/workspace" seo-agent:vX.Y.Z doctor
docker run --rm -v "$HOME/seo-agent-workspace:/workspace" seo-agent:vX.Y.Z weekly
```

The image also contains the SYNTHETIC, labeled fixtures under
`tests/fixtures/` (reserved example domains only), because `demo` and the
Demo profile read them at run time; `docker run ... demo --dir /workspace/demo`
therefore works without a repository checkout. If the fixture directory is
missing, `demo` refuses with `CONFIG_MISSING` and a next step instead of
failing later. `npm run release:check` checks that `.dockerignore` and the
package allowlist keep shipping them.

Inside the container the operating-system user is `node`, which is refused
as a human approver: pass `--as "<your name>"` (`--by` for
`vault apply-business`) to commands that record a decision.

Not verified: the image was never built here, the base image is not pinned
by digest, and running the OAuth Desktop flow inside a container is not
supported (use a service account). If seo-agent runs in a container and
Qdrant runs through `compose.yaml`, the container's `127.0.0.1` is not the
host's: put both on a private Docker network, point `QDRANT_URL` at the
Qdrant service, and enable the Qdrant API key.

## Scheduling

Scheduling is opt-in and never installed for you. Enable it only after a
successful manual run. Everything (IANA time zones, daylight saving, the
periodic-tick and daemon patterns, launchd/systemd/cron snippets, catch-up
after sleep, automatic resume, and paid stages that are never rerun blindly)
is in [SCHEDULING.md](SCHEDULING.md). In short:

```sh
npm run cli -- schedule enable weekly
npm run cli -- schedule enable monthly
npm run cli -- schedule instructions --platform systemd   # or launchd, cron, server
npm run cli -- schedule show
```

Unattended jobs run in ANALYZE or RESEARCH mode only; drafting and
publishing always need a human. Stop the scheduler before upgrades and
restores.

## Qdrant on a server

`compose.yaml` pins `qdrant/qdrant:v1.19.1`, stores data in
`<workspace>/qdrant`, and binds ports 6333 and 6334 to **127.0.0.1 only**.
Self-hosted Qdrant has no authentication or TLS by default. Keep it on the
same host as seo-agent whenever possible. If it must be reachable from
another machine:

1. **API key.** Uncomment `QDRANT__SERVICE__API_KEY` in `compose.yaml` (or
   put it in a `compose.override.yaml` next to it) and set the same value as
   `QDRANT_API_KEY` in `<workspace>/secrets/secrets.env`; never write the
   value into the compose file. Optionally add a read-only key for other
   consumers.
2. **TLS.** Enable Qdrant TLS (`QDRANT__SERVICE__ENABLE_TLS` with certificate
   and key) or put a TLS reverse proxy in front, and use an `https://`
   `QDRANT_URL`. seo-agent refuses to send an API key over plain HTTP to a
   non-loopback host: the Qdrant client is not created and memory search
   stays full-text only until the URL is `https://`.
3. **Network.** Private network or VPN only; firewall 6333/6334 so only the
   application host can connect. Never publish them on `0.0.0.0` on a public
   interface.
4. **Health endpoints** (`/healthz`, `/livez`, `/readyz`) stay
   unauthenticated and reveal only liveness.
5. Verify with `npm run cli -- memory status --network`.

Qdrant is a rebuildable index ([adr/0005](adr/0005-qdrant-rebuildable-index.md)):
losing its storage loses nothing that `memory rebuild` cannot restore from
SQLite and the embedding cache. More: [modules/memory.md](modules/memory.md).

## Backups, restore, retention, and purge

**Backups.**

```sh
npm run backup                                  # database (consistent snapshot), site configs, vault, data/raw, reports -> <workspace>/backups/
npm run cli -- backup --no-vault                # also --no-raw, --no-reports
npm run cli -- restore --from <backup-dir>      # verify only; shows what would change
npm run cli -- restore --from <backup-dir> --confirm
```

- `backup` excludes `secrets/`: keep credentials in your password manager.
- `restore` saves the current database first, refuses to run over recorded
  locks or running jobs (stop the scheduler first), refuses a demo backup in a
  live workspace (and a live backup in a demo workspace), and restores vault,
  configs, raw responses, and reports **beside** the live files for you to
  review.
- For an off-machine copy, copy the whole workspace directory while no job
  runs, and store it encrypted: it contains analytics, drafts, and business
  notes.
- Migrations write their own verified pre-migration backup.
- Test a restore occasionally on a copy (`--workspace <copy>`).

Details: [WORKSPACE.md](WORKSPACE.md#backup-and-restore) and the recovery
procedures in [UPGRADING.md](UPGRADING.md#recovery-procedures).

**Retention and purge.** Version 0.1.0 deletes nothing automatically. Raw API
responses, caches, reports, exports, logs, diagnostics, and old backups can be
removed by you; the vector index is rebuildable; the audit log and metric
history are append-only by design. Backups keep deleted data alive, so purge
them too. Provider-side copies (Apify datasets, DataForSEO task results, LLM
provider logs) follow each provider's retention. The full table is in
[PRIVACY.md](PRIVACY.md#retention-and-purge).

## Credential rotation

Rotate immediately after any possible exposure (pasted, logged, committed,
shared in an uninspected diagnostic bundle), when someone with access
leaves, and periodically. Order: issue the new credential, update the
workspace, verify, then revoke the old one. Deleting an exposed value is not
remediation.

| Credential | Verify after rotating |
| --- | --- |
| `LLM_GATEWAY_API_KEY` | `npm run cli -- models check` |
| Google OAuth token / client secret | `npm run cli -- auth status`, `auth diagnose` |
| Google service-account key | `npm run cli -- auth diagnose` |
| `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | `npm run cli -- research status --network` |
| `APIFY_TOKEN` | `npm run cli -- apify status --network` |
| `QDRANT_API_KEY` (server and client together) | `npm run cli -- memory status --network` |
| `PAGESPEED_API_KEY` | `npm run cli -- perf status --network` |

Where to rotate each one: [ACCESS_SETUP.md](ACCESS_SETUP.md#9-revocation-and-removal-summary)
and [SECURITY_MODEL.md](SECURITY_MODEL.md#credential-rotation). Afterwards
run `npm run doctor`, check each provider's usage history for activity you
did not cause, and run `npm run security:scan` if the old value could have
reached a repository.

## Dependency and application updates

- Live installations change only through **tagged releases**; there is no
  auto-update and no scheduled `git pull`. Upgrade steps (stop scheduling,
  back up, check out the tag, `npm ci --ignore-scripts`, `db migrate`,
  `config validate`, `doctor`, one manual run, re-enable scheduling) are in
  [UPGRADING.md](UPGRADING.md).
- Dependencies are pinned to exact versions with a committed lockfile and
  installed without install scripts. Dependabot proposes weekly updates after
  a 7-day cooldown; each goes through CI and review, and runtime dependency
  changes regenerate `THIRD_PARTY_NOTICES.md`
  ([SECURITY_MODEL.md](SECURITY_MODEL.md#dependency-updates),
  [adr/0010](adr/0010-supply-chain-posture.md)).
- Keep Node on an LTS line (`doctor` reports it) and apply OS and Docker
  security updates on servers.
- Update the Qdrant image deliberately: re-check the contract, change the tag
  in `compose.yaml`, then `memory status --network` (the index can always be
  rebuilt).

## What leaves the machine

Only requests to the providers you enable and to the websites you crawl. No
telemetry goes to the maintainers. Per-integration details:
[DATA_FLOWS.md](DATA_FLOWS.md).
