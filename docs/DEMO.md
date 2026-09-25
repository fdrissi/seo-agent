# Offline demo

`npm run demo` runs the real pipelines of seo-agent end to end on **synthetic
fixtures**, in an **isolated demo workspace**, with **no credentials** and **zero
external network requests**. Everything it produces describes a fictional
business ("Example Widgets (SYNTHETIC DEMO)") on reserved example domains and is
labeled SYNTHETIC. Nothing it produces is a real measurement.

Spec coverage: section 29 (demo mode), section 31 (offline demo acceptance and
honest statuses), and the preamble's Demo profile and new-user acceptance test.

## Run it

```sh
npm run demo                                   # default directory: <os tmpdir>/seo-agent-demo
npm run demo -- --dir /path/to/empty-or-demo-dir
npm run demo -- --json                         # machine-readable result (DemoResult)
npm run demo -- --dry-run                      # checks the directory and prints the plan; writes nothing
npm run demo -- --approver "Your Name"         # name of the explicit demo approver persona
npm run demo -- --start-at 2026-09-20T09:00:00Z   # start of the simulated timeline
```

It takes a few seconds. The exit code is 0 when every step completed (some may
be reported as degraded), 1 otherwise. A step's status uses the same degraded
list as `jobs show` (the engine's stage results plus the stages' own notes),
so a job with an offline or skipped stage is shown `[degraded]`, never `[ok]`
next to an OFFLINE headline. In a normal run the baseline and resume steps are
`[degraded]` (the PageSpeed checks are offline in the demo, the baseline's
optional AI work is not approved, and blocked competitor pages degrade the
research stage), and the result line names them:
`Result: demo completed (11 steps, degraded: baseline, resume).`

## Isolation and safety

- The demo runs only in its own directory (`--dir`, default
  `<os.tmpdir()>/seo-agent-demo`). It **ignores** `--workspace` and
  `SEO_AGENT_WORKSPACE` and says so.
- The directory becomes a normal workspace whose manifest says `kind: "demo"`,
  plus a marker file `.seo-agent-demo.json`. The site is registered with
  `is_demo = 1` and every provider/metric row is flagged `is_synthetic = 1`.
- It refuses, without changing anything: a live workspace (manifest kind
  `live`), a non-empty directory that is not a previous demo, a symbolic link,
  the application repository, your home directory, the filesystem root, and
  the system temp directory itself.
- Running it again **refreshes** a previous demo: it removes only the entries
  the demo creates (workspace folders, manifest, demo site copy, marker).
  Anything else in the directory is left untouched and listed in the output.
- Before a refresh removes anything, it checks those folders for data the
  demo did not create and **aborts** (`WORKSPACE_UNSAFE`, nothing changed,
  `--dry-run` included) when it finds any, listing the paths (never values):
  a site config other than the demo site (or a demo site file whose profile
  is no longer `demo`), a setup draft, a site in the database that is not
  flagged `is_demo = 1`, a value in `secrets/secrets.env`, or a file in
  `secrets/google/`. Move such files to a live workspace, or run the demo in
  another directory with `--dir`.
- No credentials are read: the demo uses an empty in-memory secret store, never
  your environment or `secrets.env`. The context's network access is disabled
  (`offlineFetch`) and wrapped by a counter; the result reports the number of
  external requests (always 0 in a successful run).
- Demo and live workspaces are kept apart **at run time, in both
  directions**. Every command that works on a site compares the site's
  profile with the workspace manifest `kind` before it opens the database:
  a `profile: demo` config in a live workspace (for example one copied into
  `config/sites/` by hand) is refused with `WORKSPACE_UNSAFE` and nothing is
  written, and so is a core/full config in a demo workspace. `setup --from`
  and the setup wizard refuse both combinations too, `doctor` reports them
  as failures (`config.demo-in-live`, `config.live-in-demo`), and
  `GOOGLE_AUTH_MODE=fixture` is rejected outside the demo profile. The demo
  database is a separate file in the demo directory.
- Demo data cannot be moved into a live workspace by file either: every
  `data export` of the demo workspace is labeled synthetic (a `# SYNTHETIC`
  CSV comment line, `containsSynthetic` in JSON), and `data import` in a live
  workspace refuses a synthetic file with `WORKSPACE_UNSAFE` before anything
  is written. `doctor` fails a live workspace whose current Search Console or
  GA4 rows are labeled synthetic.
- The demo runs on a **synthetic clock**: it starts two days in the past (or at
  `--start-at`) and advances about one day and one hour through the steps, so
  every simulated timestamp stays in the past.

## What it runs

Each step uses the same code paths as the real commands (`baseline`,
`weekly`, `content queue`, `content produce`, `approvals`, `experiments`,
`export`, `costs`, `vault render`), with fixture adapters injected through the
normal service options (`src/app/services.ts`).

| # | Step | What it demonstrates |
| --- | --- | --- |
| 1 | workspace | Isolated demo workspace, fictional site config (`tests/fixtures/demo/site.yaml`), vault from the template, a private copy of the synthetic site. |
| 2 | baseline | Durable baseline job: GSC/GA4 fixture ingestion (versioned rows), in-process crawl of the synthetic site, URL reconciliation, measurement checks, full-text memory index, the proposed cost plan (shown, not executed), baseline report and dashboard. No paid research, no experiment, nothing published. |
| 3 | interrupt | One simulated day later, the weekly job runs in RESEARCH mode and is **interrupted** (simulated Ctrl+C) while `retrieve_memory` runs. Recent Search Console days come back revised and are stored as new revisions (no double counting). Stages checkpointed before the interruption that did not do all of their work (`performance` offline, `research` degraded by blocked competitors) are listed apart with their codes, never as completed. |
| 4 | resume | The same job resumes from its checkpoints: completed stages (including the budgeted research) are reused, not redone. The step verifies that no new DataForSEO request, paid submission, budget reservation, ingestion batch, crawl, or competitor request happened. |
| 5 | routing | Deterministic routes with reason codes for every page of the run. |
| 6 | recommendation | One primary recommendation (or an explicit no-action decision). With the fixture data it is a `targeted_seo_audit` for "best widget for small teams" on /blog/how-to-choose-a-widget: a RANKING_OPPORTUNITY with commercial intent as business evidence. Conversions are not assessed because the synthetic GA4 rate scale is unverified. The weekly report's claims carry the labels OBSERVED, INFERRED, HYPOTHESIS, RECOMMENDATION and DATA UNAVAILABLE (every claim marked [SYNTHETIC]), with evidence links. Research uses the synthetic DataForSEO transport (flagged sandbox, never usable for real recommendations). Competitor pages blocked by robots.txt, a login barrier, or an access denial are recorded as blocked and never bypassed. A fake injection line on a competitor page is handled as untrusted data. |
| 7 | content | Synthetic Apify dataset (`tests/fixtures/demo/apify/dataset.json`, ingested with `ingestSyntheticDataset`) -> content queue job (discover ... prioritize) -> content production job: brief, draft approval, draft, quality review. The step states how many automated revisions ran (at most 2) and reports the verdict of the FINAL draft version (`needs_human_review`), not of the first draft. |
| 8 | experiment | `proposed -> approved -> awaiting_implementation -> observing` for the weekly primary recommendation. That recommendation is an investigation (`targeted_seo_audit`), not a change, so the labeled demo persona first records ONE concrete SYNTHETIC title and meta description change as a new recommendation revision with `experiments specify-change` (the investigation revision is superseded). The experiment is proposed from that revision and bound to a synthetic source revision; when the recommendation states no risks, the demo persona states a labeled SYNTHETIC risk, because an experiment is never proposed without one. The demo persona approves it. An EXECUTE-mode manual export follows (target recheck, one-time approval consumption, export package). A synthetic deployment then edits the demo's own site copy (`<demo>/demo-site/`), and `mark-implemented` records the publication at a synthetic implementation time with live verification `match`. The observation window starts at that time. |
| 9 | budgets | A SYNTHETIC priced DataForSEO run with its per-run cap lowered for this run only: fixture tasks are reserved and reconciled at the labeled synthetic fixture price (recorded as computed from usage at list price, not provider-reported, and flagged synthetic), until the cap stops the next task with `BUDGET_EXCEEDED` before anything is prepared. A model call without a verified price is denied with `BUDGET_UNKNOWN_PRICE`. Both denials are in the audit log. `costs` in the demo workspace prints "SYNTHETIC DEMO DATA: no real charges" (and `"synthetic": true` with `--json`). |
| 10 | vault | Entity notes and the dashboard are re-rendered; `vault check` finds no broken links. |
| 11 | isolation | External requests (0), rows not flagged synthetic (none), site registered as demo. |

### The demo approver

Two approvals are recorded by an explicit, labeled demo persona (default
"Demo Approver - synthetic persona", or `--approver <name>`): the draft
approval bound to the brief hash, and the experiment approval bound to the
change hash. The name is validated like any human approver name (automation
names are refused), and the demo refuses to do this outside a demo workspace
with the demo profile. In a real workspace only you decide approvals:
`npm run cli -- approvals show <id>` then
`npm run cli -- approvals approve <id> --as "<your name>" --confirm <hash prefix>`.

### Honest limits of the demo

- The LLM is the deterministic **fixture client**
  (`src/workflows/pipelines/synthetic-llm.ts`). It calls no model; its outputs
  are keyword rules and are labeled SYNTHETIC. The demo draft is a marked
  placeholder with a flagged unresolved fact, so the quality review returns
  `needs_human_review` (never `pass`) and nothing can be published.
- The weekly primary recommendation of the fixture data is a targeted SEO
  audit: an investigation, not a machine-applicable edit. To show the whole
  experiment lifecycle, the labeled demo persona records one SYNTHETIC
  title/meta change for it with `experiments specify-change`. The demo
  applies that change to its own site copy and `mark-implemented` verifies
  it against the fixture (`match`). This is an illustration only. In a real
  workspace you decide the concrete change, and measurement problems come
  first: the demo's own next action asks you to confirm the GA4 rate scale
  before optimizing (see [FIRST_MONTH.md](FIRST_MONTH.md)).
- The synthetic GA4 fixture reports key-event rates that never exceed 1 and
  are not whole numbers of converting sessions, so their 0-1 vs 0-100 scale
  stays undetermined. Conversions are "not assessed": the router adds a
  `RATE_SCALE_UNVERIFIED` note, HEALTHY says `CONVERSIONS_NOT_ASSESSED`, and
  pages are routed on their search signals, never to
  INVALID_OR_INCOMPLETE_DATA for this. The weekly next action is
  `npm run cli -- sync ga4 --confirm-rate-scale fraction|percent --evidence "<what you compared>" --as "<your name>"`
  (pick `fraction` or `percent`; `--as` is required). The demo never
  confirms the scale on your behalf.
- Research data comes from the synthetic DataForSEO transport and is stored as
  sandbox data. Report evidence confidence for synthetic data is `NONE` by
  design.
- Nothing here was run against a live provider. See each module document for
  the live-access status of its adapter.

## Where to look

The walkthrough prints the paths. In the demo directory:

- `vault/demo-widgets/` - the Obsidian-compatible vault (plain Markdown; open
  the folder in Obsidian if you like): `00 Dashboard/Dashboard.md`, pages,
  keywords, competitors, reports under `07 Reports/`, experiments,
  briefs/drafts under `05 Content/`, the content farm pipeline.
- `reports/demo-widgets/{baseline,weekly}/` - Markdown + JSON reports.
- `exports/demo-widgets/` - the manual export package of the experiment.
- `data/seo-agent.sqlite` - the demo database.
- `config/sites/demo-widgets.yaml` - the demo site configuration.

You can explore the demo workspace with the normal CLI, for example:

```sh
npm run cli -- --workspace /tmp/seo-agent-demo jobs list
npm run cli -- --workspace /tmp/seo-agent-demo report show weekly --latest
npm run cli -- --workspace /tmp/seo-agent-demo approvals list --all
npm run cli -- --workspace /tmp/seo-agent-demo experiments list
npm run cli -- --workspace /tmp/seo-agent-demo costs
```

(Use the directory printed by the demo; on macOS the temporary directory is
under `/var/folders/...`.) Follow-up commands on the demo workspace use the
same demo-profile fixtures, with one difference: they crawl the bundled
fixture site (`tests/fixtures/pipelines/site`), not the demo's private copy.

## After the demo

Set up your own private workspace (outside the repository):

```sh
npm run cli -- init                 # creates ~/seo-agent-workspace (or --workspace / SEO_AGENT_WORKSPACE)
npm run setup                       # interactive, resumable; or: npm run cli -- setup --from my-site.yaml
npm run doctor                      # honest status of every integration, no network by default
npm run baseline                    # first baseline (no paid research)
```

Credentials go only into `<workspace>/secrets/secrets.env` (mode 0600) or a
password-manager-injected environment, never into a chat, the vault, or the
site config.

## Implementation and tests

- Code: `src/demo/` (`workspace.ts` isolation and refresh, `fixtures.ts`
  in-process fixture adapters, `run.ts` the steps, `render.ts` the
  walkthrough) and `src/cli/commands/demo.ts`.
- Fixtures: `tests/fixtures/demo/` (site config, competitor pages, Apify
  dataset, empty/small new sites), plus the shared synthetic
  `tests/fixtures/google` and `tests/fixtures/pipelines/site`.
- `tests/e2e/demo-routing.test.ts` - pins the demo's weekly primary
  recommendation (`primary/targeted_seo_audit`) and checks that fixture pages
  with sessions are never routed to INVALID_OR_INCOMPLETE_DATA for the
  unverified rate scale.
- `tests/e2e/demo.test.ts` - the acceptance test: runs the whole demo offline
  in a temporary directory and checks every step's artifacts (database rows,
  report files, vault notes, export package, zero network), the CLI output
  (every step labeled SYNTHETIC, `--json`, `--dry-run`, refresh), and the
  refusals (live workspace, foreign directory, repository).
- `tests/e2e/honest-status.test.ts` - no credentials, Qdrant down (full-text
  fallback, degraded), a failed Apify run (quarantined, charge reconciled), an
  empty site (no invented metrics, repair/wait decision, low-data bootstrap), a
  small new site (LOW_DATA route), a blocked competitor crawl (robots, login,
  403), and budget exhaustion (research stopped before any request, actionable
  next step, report still produced).
- `tests/e2e/new-user.test.ts` - the new-user acceptance test: demo, `init`
  of a separate live workspace, `setup --from` YAML, integrations enabled by a
  reviewed config update, secrets and human vault edits, then a simulated
  upgrade through the CLI (temporary extra migrations in a temporary copy of
  the migrations directory, selected with the test-only
  `SEO_AGENT_MIGRATIONS_DIR`, which is honored only under the test runner):
  `db migrate` writes a verified, private pre-migration backup; a normal
  command applies the next migration automatically; a failing migration is
  recovered with docs/UPGRADING.md procedure A; config, secrets file, and
  vault notes are byte-identical afterwards; reinstall steps never overwrite;
  the previous version refuses the upgraded database; the secret appears only
  in the secrets file and not in the diagnostic export.
- `tests/e2e/demo-isolation.test.ts` and
  `tests/integration/workspace/demo-live-separation.test.ts` - demo/live
  separation in both directions: a demo config hand-placed in a live
  workspace is refused by `sync gsc` and `baseline` with zero rows written, a
  core config is refused in a demo workspace (import, wizard, commands,
  doctor), and a demo refresh aborts before deleting a user-added config, a
  non-demo database site, secrets, or Google credential files.
