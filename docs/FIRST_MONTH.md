# Your first month

A realistic plan for the first four weeks with a live site. The goal of month
one is a **working, trustworthy loop**, not a result: a verified baseline and
tracking, one researched opportunity, one approved change that is really
live, and enough time to observe it. Commands are explained in
[ACCESS_SETUP.md](ACCESS_SETUP.md) and [CLI.md](CLI.md).

## Ground rules

- **Measurement comes first.** If the baseline reports incomplete data,
  broken joins, or an unverified conversion event, repairing that is the
  first "opportunity". Recommendations built on broken measurement are not
  worth implementing.
- **One meaningful change per page at a time.** Stacking changes makes every
  result uninterpretable. seo-agent refuses a second experiment on a page
  that is under observation unless you record a critical fix.
- **A weekly report is not a weekly experiment.** Most weeks the right output
  is "keep observing" or "no action". seo-agent never manufactures a change
  to look busy, and neither should you.
- **Observation takes weeks.** The default minimum window is 28 days
  (`experiments.defaultMinObservationDays`), 56 days for low-traffic pages
  (`experiments.lowTrafficMinObservationDays`), and evaluation also needs
  enough impressions and sessions (500 and 200 by default). A change made in
  week three **cannot** be judged at the end of week four.
- **Before/after is observational.** Even a clear movement is evidence, not
  proof of cause: seasonality, Google updates, and other site changes
  interfere. Record them with `experiments annotate`.
- **Budgets are ceilings.** Paid research runs only when you choose
  RESEARCH mode or an explicit spend flag. See [COSTS.md](COSTS.md).

## Week 0: access and baseline (setup day)

Goal: every enabled integration reports an honest status, and the baseline
exists.

- [ ] Run `npm run demo` once to see the whole loop on synthetic data.
- [ ] `npm run cli -- init`, `npm run setup`, credentials in
      `<workspace>/secrets/secrets.env` (never in a chat).
- [ ] Google: `auth google` (or the service-account path), exact Search
      Console property and numeric GA4 property ID, `auth diagnose` clean.
- [ ] `npm run cli -- setup vault`, then `npm run doctor` and
      `npm run doctor -- --network`: no `FAIL` lines left.
- [ ] `npm run cli -- --dry-run baseline`: read the proposed cost plan.
- [ ] `npm run baseline` (add `--approve-cost-plan <usd>` only if you want
      the optional LLM/embedding work and the plan's prices are verified).
- [ ] Read `npm run cli -- report show baseline` and the dashboard
      (`<workspace>/vault/<site-id>/00 Dashboard/Dashboard.md`).

## Week 1: tracking and data quality

Goal: you trust the numbers, or you know exactly what is wrong with them.

- [ ] Work through `npm run cli -- sync ga4 --checklist`: the primary event
      exists with its exact name, is a key event, fires once per real
      conversion on completion, is verified in GA4 DebugView on a staging or
      debug setup (never with fake production leads or purchases), and
      roughly matches your system of record. Record the outcome in
      `01 Business` and set `verifiedAt` (and `verificationNote`) on the
      event under `conversions.primaryEvents` in the site config; until then,
      reports keep a caveat on every primary-event figure.
- [ ] Confirm the GA4 key-event rate scale when the report asks for it
      (the next action names it): compare one stored rate with the GA4
      interface, then run
      `npm run cli -- sync ga4 --confirm-rate-scale fraction|percent --evidence "<what you compared>" --as "<your name>"`
      (details in [ACCESS_SETUP.md](ACCESS_SETUP.md#38-validate-conversion-reporting-manual-checklist)).
      Until the scale is known, conversions are "not assessed" and pages are
      routed on their search signals only.
- [ ] Fix every data-quality blocker the baseline listed (missing primary
      event, high `(not set)` share, access errors, crawl blockers). Re-run
      the affected sync or crawl afterwards.
- [ ] Fill in the business notes in `01 Business` (offer, customers,
      approved claims, prohibited claims), then
      `npm run cli -- vault import-business` (preview),
      `vault import-business --apply` (record), `vault apply-business`
      (review the config diff), and `vault apply-business --confirm <diff-hash>`.
- [ ] First `npm run weekly` in ANALYZE mode (no paid research). Read the
      report. "Repair measurement first" or "collect more evidence" are
      normal outcomes this week.
- [ ] Check `npm run costs`.

## Week 2: one researched opportunity

Goal: one shortlisted opportunity with real evidence, or a documented reason
to wait.

- [ ] If DataForSEO is set up and its sandbox test passed, run
      `npm run cli -- --mode RESEARCH weekly`. Research is limited to
      `research.seriousQueriesPerRun` shortlisted queries and the budget
      ceilings; competitor pages blocked by robots.txt or logins are recorded,
      never bypassed. Without DataForSEO, the analysis still uses your own
      Search Console, GA4, and crawl data.
- [ ] Read the primary recommendation: exact page and queries, measurements,
      evidence links, diagnosis, proposed change, hypothesis, success
      criteria, risks, review date. Check the claim labels: OBSERVED facts
      versus HYPOTHESIS.
- [ ] Look at the page yourself (`npm run cli -- analyze page <url>`). Would
      a knowledgeable human agree the change is useful for visitors?
- [ ] If the recommendation is an investigation ("compare ..., then
      propose ONE specific change"), do the investigation first and record
      the one change you chose:
      `npm run cli -- experiments specify-change <id> --title "..." --by "<your name>"`
      (or `--meta`, `--section-file`, `--redirect-to`). Use the new
      recommendation id it prints below.
- [ ] If yes: `npm run cli -- experiments propose --recommendation <id>
      --revision <your-site-revision>`, then review with
      `approvals show <approval-id>` and approve with
      `approvals approve <approval-id> --as "<your name>" --confirm <hash-prefix>`.
      If no: `approvals reject <approval-id> --reason "<why>"`. The rejection
      is remembered, so the idea is not proposed again as new.
- [ ] Optional content track (Full profile): `content queue`, review the
      prioritized items, and create at most one brief. Do not draft or
      publish content just because it was discovered.

## Week 3: one approved implementation

Goal: the approved change is live, exactly as approved, and recorded with the
real deployment time.

- [ ] `npm run cli -- --mode EXECUTE export experiment <id> --revision <rev>`:
      rechecks the page, consumes the approval once, writes the package with
      `checklist.md`, `diff.md`, and rollback files.
- [ ] Deploy exactly that package in your CMS or repository. Nothing is
      published by seo-agent.
- [ ] `npm run cli -- experiments mark-implemented <id> --at <actual time
      with zone> --revision <deployed revision> --url <live URL>`. The
      observation window starts at `--at`, never at approval or draft time.
      Check the live verification result (`match`, `partial`, `mismatch`, or
      `unverified`) and fix a mismatch before observing.
- [ ] Record other changes that could interfere (template changes, campaigns,
      outages): `npm run cli -- experiments annotate ...`.
- [ ] After at least one successful manual `weekly` run, enable scheduling if
      you want it: `schedule enable weekly`, `schedule enable monthly`, then
      `schedule instructions` ([SCHEDULING.md](SCHEDULING.md)). `schedule
      enable` refuses until such a run is recorded (`--force` overrides it,
      which is not recommended). With a
      Google OAuth app in Testing, authorizations expire after 7 days, so
      use an Internal or published app or a service account first.

## Week 4: observe, do not force a result

Goal: data keeps flowing, the experiment is untouched, and nothing is
concluded early.

- [ ] Weekly runs continue. `npm run cli -- experiments review` shows the
      experiment as collecting evidence. That is the expected state.
- [ ] Do not edit the page under observation. Critical broken functionality
      can override the freeze, but record it (`--critical-fix` or
      `experiments annotate --overrides-freeze`).
- [ ] The first `monthly` run (or `npm run monthly`) summarizes organic and
      conversion performance, experiments, data quality, API usage, and any
      proposed learnings, with observed results kept apart from attribution
      assumptions.
- [ ] Review spend: `npm run costs`, plus each provider's own dashboard.
- [ ] Take a backup: `npm run backup` (secrets stay in your password manager).

## After four weeks

Most first experiments are **not** conclusive by now, and that is fine:

- The window runs at least 28 days from the real implementation date (56 for
  low-traffic pages), and evaluation waits for enough impressions and
  sessions. Reviews before then record "collecting".
- When the window ends without enough evidence, `experiments review
  --conclude` records **inconclusive**, not negative. Zero extra signups in
  a small sample does not prove failure, and a CTR gain with worse lead
  quality is not a business win.
- Do not re-run the same test until it looks favorable; a re-test needs a
  documented reason.
- Learnings are proposed with their evidence and scope and need your
  approval; they never become universal SEO rules automatically.

While the experiment observes, useful parallel work is: measurement repairs,
experiments on **other** pages (independent page experiments may run
concurrently), one content brief through human review, and keeping business
notes current.

## End-of-month checklist

| Item | Done when |
| --- | --- |
| Baseline and tracking | Baseline report exists; primary conversion verified with the checklist; no open data-quality blockers, or each one has an owner and a plan |
| One researched opportunity | One recommendation reviewed against evidence, approved or rejected with a reason |
| One approved implementation | Exported, deployed exactly, recorded with `mark-implemented` at the real time and revision, live verification checked |
| Sufficient observation | Experiment observing and untouched; evaluation date noted; interfering changes annotated |
| Operations | Weekly runs succeed; spend reviewed; a backup exists; scheduling enabled only after a successful manual run |

Month one succeeds when this loop works. Results, if any, come later.
