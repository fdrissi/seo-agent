# Experiments, approvals, publishing, and mark-implemented

Spec sections 23 (experiments), 24 (approvals and production boundaries), 25
(spend approvals), 26 (untrusted input cannot touch approvals), 28 (append-only
history), 31 (tests).

Code: `src/approvals/**`, `src/experiments/**`, CLI modules
`src/cli/commands/{approvals,experiments,export}.ts`, migrations
`migrations/0190_experiments_approvals.sql` and
`migrations/0191_experiments_append_only.sql`.

## 1. Runtime-mode policy (`src/approvals/policy.ts`)

The policy is enforced in code. The only inputs are the typed runtime mode
(from the CLI `--mode` flag) and an `ApprovalCheck` produced by the approval
service from SQLite. It takes no free text: model output, Markdown frontmatter
(`approved: true`), and scraped text cannot influence it. An LLM instruction is
not an access-control mechanism.

| Mode | Allowed |
| --- | --- |
| `ANALYZE` (default) | reads, authorized budgeted first-party reads, local reports and records (evaluations, annotations, mark-implemented records, approval *requests*, non-production exports) |
| `RESEARCH` | plus budgeted external research (`external_research`) |
| `DRAFT` | plus local review artifacts, each only with the configured approval (`generate_draft` needs `draft_generation`; `batch_drafts` needs `batch_expansion`) |
| `EXECUTE` | plus production actions. Each one also needs a valid approval of the same action type for the exact proposal. |

Production actions: `publish_content`, `update_page`, `title_meta_change`,
`redirect`, `merge_pages`, `delete_page`, `canonical_change`, `robots_change`,
`analytics_change`. Use `assertAllowed(ctx.mode, action, { approval })`.
Unknown actions and modes are denied. An approval for one action type never
authorizes another. An executed approval never authorizes a second execution.

## 2. Approvals (`src/approvals/service.ts`, implements `ApprovalGate`)

**Binding.** An approval binds site, action type, target, subject
(type and id), artifact hash, source revision, requester, approver, decision
time, expiry, and one-time execution state.

**Artifact hash.** `computeArtifactHash({ actionType, target, change })` is a
canonical-JSON SHA-256 (`src/approvals/artifact.ts`, version 1). It covers
everything that would go live. It excludes timestamps, statuses, and the
record id.

**Expiry.** The default TTL is 168 hours (7 days). `--ttl-hours` accepts up
to 720. Expiry is applied lazily on every read and write, is audited, and
covers both pending and approved-but-unexecuted approvals.

**Deciding.** Only `approvals approve|reject` decide an approval. Both need a
human name: `--as <name>`, or the OS user when `--as` is omitted, unless the
OS user is a service account (`node`, `runner`, `root`, `daemon`,
`www-data`, `ubuntu`, `ec2-user`, `nobody`): then the command is refused and
asks for `--as` (the container image runs as `node`, GitHub-hosted CI as
`runner`). Names are asserted, not authenticated, so only names that
obviously denote automation or an account are refused (`system`,
`scheduler`, `llm`, `model`, `agent`, `assistant`, `bot`, `claude`, `gpt`,
`agent007`, `claudecode`, `claude's`, the whole names `owner`, `admin`,
`root`, `node`, `runner`, `user`, `default`, ..., after NFKC normalization,
and look-alike or mixed-script spellings; `src/approvals/approver.ts`).
Approving also requires
`--confirm <prefix>`: at least the first 8 hex characters of the artifact
hash.

**Review surface.**
- `approvals show` and `approvals approve` print the complete exact change.
  Nothing is truncated; multi-line fields are printed in full.
- `approvals approve` prints the full review even when `--confirm` is given.
  Without `--confirm` it prints the review and refuses.
- Only the review output (`show`/`approve`) prints the confirmation prefix.
  Other outputs (`approvals request`, `experiments propose`, budget
  exceptions, error hints, the service's own messages) point to
  `approvals show` instead. Typing the prefix therefore means the approver
  looked at the review.
- All human output is rendered terminal-safe (`src/approvals/display.ts`).
  C0/C1 control characters (including ANSI escapes and carriage returns),
  bidi controls, and zero-width characters become visible `[U+XXXX]`
  markers, and the review adds a warning when any are present. The stored
  proposal and its hash are never altered.
- A `budget_exception` approval raises no limit yet (see §6). `approvals
  show`, `approvals approve` (also `--dry-run`), and
  `approvals request-budget-exception` print that caveat as a `NOTE:` line
  and return it in JSON as `caveats` (empty for other action types).
- An experiment is approved only with its risks stated: `approvals approve`
  refuses (`VALIDATION_FAILED`) an experiment whose risks are empty or the
  placeholder earlier versions stored ("Not stated by the recommendation").
  Reject it and propose again with `--risks`.
- In a demo site (demo profile, synthetic context, or `sites.is_demo = 1`),
  `approvals list [--all]` and `experiments list` print a
  `SYNTHETIC DEMO DATA` banner first and return `synthetic: true` (with the
  `banner` text) in JSON; a live site returns `synthetic: false`.

**Source revision.** A production approval without a source revision
(`--revision` was not given at request/propose time) can only be approved
with `--accept-unbound-revision`. The review shows
"source revision: NOT BOUND ...", and the acknowledgment is recorded in the
`approval.approved` audit event (`unboundRevisionAcknowledged: true`). At
export, an unbound approval adds a warning to the result and the package
README. A `--revision` supplied at export cannot be verified against an
unbound approval, and the warning says so. Non-production approvals (spend,
learnings, draft generation) have no revision to bind.

**Requests.** A request grants nothing. System code may create pending
requests: an experiment proposal, an auto-proposed learning, or a paid-request
adapter. Requester identities that look like model output (`llm:*`, `model`,
...) are refused. The runtime LLM tool allowlist (llm slice) must never
expose request, approve, or consume.

**Invalidation.**
- `check()` is a pure query. Apart from lazy, time-based expiry it never
  changes anything, so callers can probe freely. For example,
  `checkBudgetException` for another amount does not destroy the approved
  exception, and a paid-request check for another cap does not either.
- The owner of a proposal knows its current hash and calls
  `checkCurrent()`. The export is that owner. `checkCurrent()` first
  invalidates live approvals for any other artifact hash ("proposal
  changed") and a live approval bound to a different source revision than
  the one supplied ("source revision changed"). Then it checks.
- A new request for the same subject and action with a new hash or revision
  also invalidates the old live approval.
- The reason is stored in `invalidated_reason` and audited.
- A missing revision, when the approval is bound to one, is refused without
  invalidating.

**Target recheck.** At request time the target page is fingerprinted when it
can be fetched: title, meta description, canonical, robots meta, H1s, and main
visible text, or `absent:404` for a page that does not exist yet. Immediately
before execution the page is fingerprinted again.
- A different fingerprint invalidates the approval and refuses execution.
- An unverifiable recheck (offline, or no fingerprint captured) refuses
  unless `--allow-unverified-target` is passed. That choice is recorded in
  the approval execution and in the package README.
- The recheck compares against the fingerprint STORED on the approval.
  `requestApprovalForSubject` reports that stored value, never a freshly
  computed one.
- Re-requesting online while an identical request is still pending, either
  without a fingerprint or with an outdated one, replaces that request. The
  old one is invalidated with the reason, and the new one carries the
  current fingerprint.
- An already approved approval is never modified. The re-request reports
  its stored fingerprint (possibly null) and warns that the export will need
  `--allow-unverified-target`, or that the recheck will refuse.

**One-time execution.** `consume()` performs
`UPDATE ... SET status='executed' WHERE id=? AND status='approved' AND expires_at > now`
inside `BEGIN IMMEDIATE`. A second consume fails with `APPROVAL_INVALID` and
is audited. Concurrent consumers in separate processes: exactly one wins
(tested with 4 processes).

**Audit.** The append-only `audit_events` table records these events:
`approval.requested`, `approval.approved`, `approval.rejected`,
`approval.expired`, `approval.invalidated`, `approval.executed`,
`approval.consume_refused`, `approval.target_recheck`. Freeze overrides add
`experiment.freeze_override_requested` (proposal) and `export.freeze_override`
(export).

**Database defense in depth (migration 0190).** Triggers enforce:
- The binding columns are immutable.
- Terminal statuses never change. The only allowed paths are
  pending -> approved/rejected/expired/invalidated and
  approved -> executed/expired/invalidated.
- The approver, decision time, and execution record are immutable once set.

**Decision effects** (`src/approvals/effects.ts`, run by the CLI after a
decision). They apply only while the approval still binds the subject's
current hash:
- experiment: proposed -> approved; a rejection cancels the experiment.
  The page is re-checked at decision time. If another experiment holds it
  (possible only after a recorded critical-fix override), the approver gets
  a warning.
- learning: proposed -> approved or rejected
- recommendation: proposed -> approved or rejected
- draft: `review_passed` -> `approved`

The next step printed for every production approval is always the
EXECUTE-mode export, followed by the deployment and `mark-implemented`.

## 3. Publisher interface and manual export (`src/approvals/publisher.ts`, `export.ts`)

```ts
interface Publisher {
  kind: 'manual_export' | 'git_patch' | 'cms_adapter';
  prepare(proposal): PreparedArtifact;           // exact artifact + hash, pure
  publish(approved: ApprovedPublication): Promise<PublishResult>;
}
```

Version 1 ships one complete publisher, `ManualExportPublisher`. It never
touches production (`liveChange: false`). `createPublisher(kind)` throws
`INTEGRATION_UNAVAILABLE` for every other kind (`wordpress`, `webflow`,
`cms_adapter`, `git_patch`, ...). Those are documented placeholders: a CMS or
Git adapter is built only after the owner's actual platform is configured and
its API verified. No generic CMS behavior is invented.

`export <draft|recommendation|experiment> <id>` writes a package to
`<workspace>/exports/<site>/<YYYY-MM-DD in business TZ>-<subject-slug>/`.
Packages are written to a temp directory and renamed atomically. An existing
package is never overwritten (a `-2` suffix is added instead), and paths are
checked with `safeResolve`.

| File | Content |
| --- | --- |
| `README.md` | binding, approval, recheck result, summary, warnings; `[SYNTHETIC DEMO DATA]` banner when applicable |
| `content.md` / `content.html` | proposed content; the HTML is a conservative Markdown conversion with everything escaped, unsafe links dropped, and raw HTML never passed through |
| `head-snippet.html` | proposed title, meta description, canonical, robots, JSON-LD |
| `metadata.json` | exact change, artifact hash (+version), context (source ledger, fact-check notes, hypothesis...) |
| `diff.md` | field table (current vs proposed) plus a sentence-level text diff against the latest crawl snapshot. Says "current state UNAVAILABLE" when there is none. |
| `rollback.md` / `rollback.json` | previous values and snapshot ref, rollback plan |
| `checklist.md` | review, implement exactly, note revision/time, the exact `mark-implemented` command, freeze reminder |
| `manifest.json` | SHA-256 of every file, approval id, approver, recheck, synthetic flag |

**Production-bound exports** need all of the following, in order:
1. `--mode EXECUTE`.
2. A valid approval for the exact artifact hash, and for the source revision
   when the approval is bound to one (`--revision`). The export uses
   `checkCurrent`, so stale approvals are invalidated with the reason.
3. One meaningful change per page. If another experiment is **observing**
   the target page, the export is refused. The only exception is
   `--critical-fix "<reason>"` for critical broken functionality. The reason
   is recorded in the approval execution (`criticalFixReason`,
   `freezeOverriddenFor`), in the `export.freeze_override` audit event, and
   in the package README. `mark-implemented` later turns it into a
   `critical_fix` annotation at the actual deployment time. Other open
   experiments on the page (proposed, approved, or awaiting implementation)
   produce warnings.
4. An unchanged target recheck.

The approval is consumed and the package written in one database
transaction: if the write fails, the approval stays unexecuted.

**Other rules:**
- Drafts must have passed review (`review_passed`/`approved`) and have zero
  unresolved facts.
- **A production-bound draft export also needs a named human's recorded
  acceptance of the exact draft body**, in addition to the approval (spec
  sections 22 and 24). The draft's latest quality review must be a
  `content mark-reviewed` acceptance of the SHA-256 of the stored body
  (content's `humanAcceptedDraft`): automated `pass` verdicts, an acceptance
  of an earlier body, and a later automated re-review do not count. Without
  it the export is refused with `POLICY_DENIED` (`details.reason:
  "human_review_required"`), also on dry runs, and the hint names the exact
  `content mark-reviewed <id> --as "<your name>" --confirm <prefix>`
  command; nothing is written and the approval is not consumed. Accepting
  the body does not change the artifact, so the same approval then exports.
  `export.ts` checks right after the mode check, `publishSync` checks again
  (`assertDraftHumanAccepted`, `draftHumanReviewBlocker`), and
  `metadata.json` records who accepted the body. The export body and
  artifact hash are unchanged by this rule. `approvals request` warns (the
  warning is not stored) when no human acceptance exists yet; approving an
  unaccepted draft no longer moves it to status `approved` (a note gives the
  next step instead), because `content mark-reviewed` refuses `approved`
  drafts; and `experiments mark-implemented --deployed-without-export` on
  a draft without a human review records it with a visible warning. A draft
  that an earlier version moved to `approved` without an acceptance cannot
  be accepted any more and needs a new draft version.
- Every proposal target (draft `proposedUrl`/`targetUrl`/slug,
  recommendation `targetUrl` or page, experiment target) must be an absolute
  http(s) URL on `site.allowedHostnames`. Anything else is refused at
  request, propose, and export time, so an off-site target, possibly
  model-produced, can never become a bound approval target. Off-site
  redirect or canonical values are allowed but always produce a warning.
- **No-action records.** A recommendation is a no-action record only by its
  kind (`no_action`, `collect_more_evidence`). Such a record exports in any
  mode without an approval. It may explain itself in text, but it is
  refused if it carries structured production fields (title, meta, body,
  canonical, robots, redirect, links, structured data, slug).
- **Fail closed.** A `primary`/`secondary`/`repair_measurement`
  recommendation with an empty, `none`, or `no_action` action type is still
  a production change. It maps to the type implied by its structured change
  (redirect > robots > canonical > body/links/structured data >
  title/meta), with `update_page` as the default. It needs EXECUTE and an
  approval.
- **A structured change types the approval.** When a recommendation carries
  `details_json.change` (recorded by `experiments specify-change`), its
  approval action type is implied by that change (title/meta ->
  `title_meta_change`, section -> `update_page`, redirect -> `redirect`),
  whatever the row's label says. A title specified for a
  `repair_measurement` recommendation is approved and exported as
  `title_meta_change`, never `analytics_change`.
- When the change reaches beyond its action type, a warning is added for the
  reviewer: robots, canonical, or redirect fields under another type; a
  title or meta description under a type that does not set them (e.g.
  `analytics_change`); page content, links, or structured data under
  `title_meta_change`; and a source label (the row's `action_type` or
  `details_json.originalActionType`) that does not match the structured
  change kind. Investigation labels are the designed path to a specified
  change and are not flagged.
- Credential-like strings in content trigger a warning but are left
  unaltered.
- `--dry-run` writes and consumes nothing.

## 4. mark-implemented (`src/approvals/implementation.ts`)

`experiments mark-implemented <id> --at <ISO with zone> --revision <rev> [--url] [--subject-type experiment|draft|recommendation] [--critical-fix <reason>] [--deployed-without-export <reason>] [--as <name>]`

**Validation:**
- `--at` needs an explicit zone and cannot be in the future.
- An approval must exist for the exact artifact hash. Experiments use
  `experiments.change_hash`; drafts and recommendations recompute the hash
  from the current record. A pending, expired, or invalidated approval, or
  one for a different hash, is refused with the reason.
- **One approval authorizes exactly one implementation record.**
  - Normal path: the approval was executed by the EXECUTE-mode manual export
    (`execution.kind = 'manual_export'`, which rechecked the target), and no
    publication references it yet.
  - An approval already referenced by a publication is refused. So is an
    approval executed by anything else. Request a new approval instead.
  - Migration 0191 enforces this in the database too: a second
    `publications` row with the same `approval_id` is refused.
- **Approved but never exported.** The EXECUTE gate and the pre-execution
  recheck did not run, so recording is refused by default. A change that is
  already live without an export can be recorded explicitly with
  `--deployed-without-export "<reason>"`. That path requires `--mode EXECUTE`
  (it consumes a production approval outside the export) and records
  `recheck: 'skipped'` in three places: the approval execution
  (`kind: 'mark_implemented_without_export'`), the publication
  (`verification_json.preExecution`), and the audit log.
- `--at` cannot be earlier than the approval decision.
- The URL must equal the approved target.
- The recorder must be a human.
- **Observation freeze.** Another experiment observing the same page blocks
  recording unless a critical-fix reason exists. The reason comes from
  `--critical-fix`, or else from the one recorded at export or at proposal
  (a warning says which). The page-scoped `critical_fix` annotation
  (`overrides_freeze = 1`) is written here, at the ACTUAL deployment time
  (`--at`). This is what flags the running experiment. Other open
  experiments on the page produce warnings.

**Snapshots:**
- Before: the latest successful crawl result at or before `--at`
  (`crawl_result:<id>`), else the export package's `rollback.json`.
- After: the live page, fetched now and stored in the raw store (`raw:...`).

**Verification:** the live page is compared with the machine-checkable parts
of the artifact: title, meta description, canonical, robots, redirect target,
404/410 for deletions, and up to 5 normalized body fragments.
- `match` sets `verified_live = 1`.
- `partial` and `mismatch` are recorded with the per-check details. They are
  never hidden.
- Offline, unreachable, or free-text-only changes are `unverified`, and no
  after-snapshot is invented.

**Records**, all in one transaction:
- a `publications` row: method `manual_export`, export path, actual
  `implemented_at`, deployment revision, before/after refs, verification,
  rollback info
- the approval is consumed only on the explicit `--deployed-without-export`
  path. `preExecution` (exported, export dir, recheck status) is returned and
  stored
- experiments move approved -> awaiting_implementation (if needed) ->
  observing, with `implemented_at = observation_start = --at`. Approval or
  draft time never starts the window. The review date is set to
  `--at + min days + 7`.
- drafts become `published`; recommendations become `implemented`

## 5. Experiments (`src/experiments`)

**Record.** Every spec 23 field is stored:
- id, site, page, type, hypothesis, evidence
- the exact change, with its hash and structured form in the immutable
  `experiment_changes` table
- baseline (trailing 4 complete weeks), primary metric, `outcome_kind`
  (`seo_visibility`/`conversion`/`both`), guardrails
- minimum observation days: `experiments.defaultMinObservationDays`, or
  `lowTrafficMinObservationDays` when baseline impressions are below
  `minImpressionsForEvaluation` or unavailable
- sample requirements, risks, rollback plan, review date. Risks are
  required: `experiments propose` is refused (`VALIDATION_FAILED`) when
  neither the recommendation nor `--risks` states them, and nothing is
  recorded
- frozen versions: prompt, model, scoring, measurement method, config
  version/hash, artifact-hash version

**Status machine.** proposed -> approved -> awaiting_implementation ->
observing -> positive | negative | inconclusive. Any non-terminal status can
move to cancelled. Terminal statuses never change. Every transition goes to
`experiment_status_history` (UPDATE blocked by trigger) and to the audit log.

**One meaningful change per page** (`src/experiments/freeze.ts`). Every
open experiment holds its page: proposed, approved, awaiting
implementation, or observing. Experiments are matched by page id or
normalized target URL.
- **Proposing.** A second proposal on a held page is refused. This includes
  a page whose first experiment is only `proposed`. The only exception is
  `--critical-fix "<reason>"`. At proposal time the intent is recorded only
  in the experiment evidence (`freezeOverride`) and in the
  `experiment.freeze_override_requested` audit event. A proposal changes
  nothing on the page, so it writes no change annotation and does not flag
  the running experiment.
- **Implementing.** The blocking `critical_fix` annotation is written by
  `mark-implemented` at the real deployment time.
- **Other paths.** Approval effects warn about the overlap. Exports refuse
  while another experiment observes the page (see §3). Requests for drafts
  and recommendations warn.
- Different pages may run experiments concurrently.

**No re-testing until favorable.** A prior test is any experiment with this
exact change hash, or with a change of the same type on the same page, that
concluded (positive, negative, or inconclusive) or was cancelled after it
went live (`implemented_at` set, or any evaluation recorded). If a prior
test exists, the proposal is refused unless `--retest-reason` is given. So
neither rewording the change nor cancelling an unfavorable live experiment
bypasses the guard. Prior tests are recorded in the evidence as
`{ experimentId, status, match: 'exact_change' | 'same_page_and_type', wentLive }`,
together with the reason. An experiment cancelled before it went live is
not a prior test.

**Annotations.** `experiments annotate` takes a scope (page, template, site,
external), a kind (site_change, template_change, critical_fix,
algorithm_update, tracking_change, seasonality, outage, campaign, other), and
a zone-qualified past time. The output lists the affected active experiments.

### Evaluation method (`src/experiments/evaluate.ts`, `observational_before_after_did` v3)

1. **Windows.** Windows are computed per data source, in that source's own
   reporting zone (GSC `date_tz`, GA4 property zone). The implementation date
   is excluded. Observation runs from the day after up to the latest complete
   date. The baseline is the same length immediately before. Both are whole
   weeks, so the weekday counts are identical (weekday matching). GSC and
   GA4 boundaries are never shifted into each other.
2. **Metrics.** Only current-revision rows (`*_current` views) are used, with
   the same `segment_key`, search type, and channel view in both windows
   (segment matching).
   - GSC: CTR = sum(clicks) / sum(impressions); position is
     impression-weighted.
   - GA4 conversion rate: converting sessions are estimated as
     sum(reported sessionKeyEventRate x sessions), and the rate is that
     estimate divided by sessions. Key-event counts are occurrences and are
     never divided by sessions.
   - Missing is not zero, and coverage comes from the same dataset as the
     metric. Property totals never stand in for page rows.
   - A date is covered only when the page-level dataset has at least one
     current row for it: `gsc_page_daily` or `ga4_landing_daily`, with the
     same property, search type or channel view, and `segment_key`. On a
     covered date, a page without a row is an observed zero (both APIs omit
     all-zero rows).
   - A date without any page-level row is missing, even when property
     totals exist. This happens when the page sync lags or runs on another
     cadence. A whole-site zero day is also treated as missing
     (conservative).
   - If the latest ingestion batch covering a date hit a row limit
     (`ingestion_batches.truncated = 1`; GSC lists the dates in
     `coverage_json.truncatedDates`), that date is uncertain for the
     identity: it has fewer distinct pages with rows than it represents.
     Such dates are reported in `truncatedDates` and make the window
     incomplete, never zero. Batches for other search types, channel views,
     or segments do not count. When the identity has no row at all in such a
     window, its clicks and impressions (GSC) or sessions, key events, and
     revenue (GA4) are unknown (`null`), never 0.
   - GA4 row loss: GA4 can leave rows out of a report ("(other)" bucketing,
     thresholding, sampling; the batch's stored response metadata). When
     EVERY landing-page report covering a covered date said so (the same
     rule as `seo/coverage.ga4Coverage`, which the router, analysis, reports,
     and vault use), a page without a row that day is unknown, not zero.
     Such dates are reported in `rowLossDates` (with `rowLossReasons`) and
     are handled like `truncatedDates`: the window is incomplete, its
     primary session key-event rate and revenue are never `observed` (so no
     converting-session estimate is made), and the sums of a window with
     some rows cover only the dates with rows. One covering report of the
     same channel view without row loss proves the absence (observed zero).
   - GA4 estimates: sampling and "(other)" bucketing also affect rows that
     ARE present. A sampled report returns estimates. With "(other)"
     bucketing, some `landingPagePlusQueryString` variants of a page can be
     counted in the "(other)" row, so the page total can be partial. A
     covered date is an estimate date for the identity, whether or not it
     has a row, when:
     - every covering landing-page report of the channel view was sampled
       or bucketed rows into "(other)"; or
     - a current row of the identity that day came from such a report
       (`ga4_landing_daily.batch_id`). An earlier clean report does not make
       it exact; a later report that re-states the row replaces its batch.
     Such dates are reported in `estimateDates` (with `estimateReasons`:
     `sampling`, `other_row`). They make the window incomplete with a reason
     that names sampling or "(other)". The primary session key-event rate
     and revenue are never `observed`, so no converting-session estimate is
     made. The sums stay, as estimates of an incomplete window.
     Thresholding alone does not make a present row an estimate: GA4
     withholds whole rows, and it sets the flag even when nothing is
     withheld. It only makes absent rows unknown (`rowLossDates`).
   - At evaluation, a GA4 window (treated or comparison) with truncated,
     row-loss, or estimate days gives no comparable value. Every conversion
     comparison is `DATA_UNAVAILABLE` with `insufficient_data`. GA4
     guardrails are `unavailable` (never `ok` or `breached`). The evaluation
     reasons carry a "GA4 data caveat" naming the affected windows and
     reasons: "incomplete, not zero" for possibly missing rows (also
     `conversion.sample.absentRowsUnknown`), and "estimated, not exact" with
     sampling or "(other)" named for estimate days (also
     `conversion.sample.estimatedValues`). Unknown converting sessions are
     never reported as 0 in the sufficiency reasons.
   - Method v2 introduced the missing-row rule (v1 counted those rows as
     zero). Method v3 added the estimate rule (v2 used sampled or
     "(other)"-bucketed values as exact when the page had a row every day).
     Experiments frozen on an older version say that the method changed.
   - The observation window ends at the latest final PAGE-LEVEL date. For
     GSC, API-reported availability (`gsc_data_availability`) can only lower
     that date, never extend it.
3. **Effect.** The direction-adjusted relative change of the treated page
   minus the pooled relative change of unchanged comparison pages
   (difference-in-differences style). Comparison pages are the most visible
   pages of the same type without active experiments, 5 by default. They are
   ranked on the SAME Search Console dataset the experiment measures: one
   property, the configured search type, and `segment_key` `''` unless the
   experiment measures a segment (`comparisonScope`). The property is the
   configured one; else the property recorded at proposal; else the only
   property with page data (`resolveMeasuredGscProperty`). When no property
   is configured and several have page data, no comparison page is
   selected, the proposal warns, and the GSC baseline is recorded as
   unavailable with the reason: rows are never ranked or summed across
   properties. Treated and comparison metrics at evaluation use the same
   resolution (the recorded property wins when none is configured), and an
   ambiguous property makes the Search Console metrics unavailable with the
   reason.
   Comparison pages that changed during the windows are excluded. A change
   counts when it is a page annotation, another experiment's implementation,
   or a recorded draft/recommendation implementation (a `publications` row).
   With no comparison pages the result is a plain before/after comparison,
   and the output says so.
4. **Sufficiency.**
   - The minimum complete-data days must be reached. Before that the result
     is `collecting` and is never concluded early.
   - SEO outcomes need at least `minImpressionsPerWindow` in each window.
   - Conversion outcomes need at least `minSessionsPerWindow` sessions and at
     least 10 converting sessions in the larger window (recorded per
     experiment). Missing or unavailable measurement is never read as zero.
   - Insufficient data stays `collecting` until `maxObservationDays`
     (3x the minimum), or until `--conclude`. Either one concludes
     `inconclusive`, never `negative`.
5. **Verdict.**
   - The meaningful-effect threshold is `minRelativeEffect`: 10% by default,
     stored per experiment.
   - SEO visibility and conversion outcomes are assessed separately.
   - A mixed result is `inconclusive`.
   - A visibility gain with a breached guardrail (default: the primary
     conversion rate may not fall more than 20%) is `inconclusive` and
     "not treated as a win".
   - Guardrails without data are reported as unverified.
6. **Interference.** Every evaluation lists the items whose dates fall in
   the windows (baseline and observation): annotations, other experiments'
   implementations, and recorded implementations of drafts and
   recommendations (`publications`). These are blocking and downgrade
   positive/negative to `inconclusive`:
   - another change on the same page, including a publication on the treated
     page during the baseline
   - site- or template-scope `site_change`, `template_change`, `outage`, or
     `critical_fix`
   - `tracking_change` when conversions are involved

   External, algorithm, seasonality, and campaign items are flagged only.
7. **Significance.** No significance test is implemented. Every evaluation
   stores and prints this statement. Nothing is labeled significant, and
   results are observational, not causal.
8. **Append-only history.** Every evaluation, including `collecting` ones,
   dry runs excepted, is appended to `experiment_evaluations`. Re-evaluating
   a concluded experiment is stored as `after_conclusion = 1` and never
   changes the recorded outcome.
   - `experiment_measurements` keeps the first measurement per
     window/method/source.
   - When revised source data changes a recomputed window, the evaluation
     says so explicitly. It lists the windows in `measurementRevisions` and
     adds a reason. The evaluation row holds the current values. The
     revision is never silently ignored.
   - Database triggers enforce all of this:
     - 0190 blocks UPDATE on `experiment_evaluations` and
       `experiment_status_history`.
     - 0191 blocks UPDATE and DELETE on `experiment_measurements`.
     - 0191 blocks deleting single rows of `experiment_evaluations`,
       `experiment_status_history`, and `experiment_changes`.
     - Deleting the parent experiment or site still cascades.
9. **Frozen method.** If the frozen measurement version differs from the
   current one, the evaluation says so.
10. **Due experiments.** `experiments review` evaluates observing experiments
    that are due: the minimum days have passed since the actual
    implementation (business zone), or the review date has been reached.
    `--all` includes the rest; `--id` targets specific experiments.

**Learnings.** A concluded positive or negative result proposes a learning.
Its scope is bounded to the site, page, change type, and observed window, and
its evidence is the evaluation. It creates a pending `learning_promotion`
approval and stays `proposed` until a human approves it. Universal scopes
("all sites", "global", "*", ...) and learnings without evidence are refused.
If a learning is edited after the request, the approval does not promote it.

## 6. Spend approvals (`src/approvals/budget-approvals.ts`)

- `paid_request`: one unknown-price request. The approval binds the provider,
  the endpoint, the canonical request hash, and the maximum accepted charge,
  or "no known upper bound", which the summary states. It is consumed once.
  Its id is what `BudgetService.reserve({ unknownPriceApprovalId })` accepts.
- `budget_exception`: a one-time, bounded exception bound to provider (or
  `combined`), period (`YYYY-MM` / `YYYY-Www`), and amount. CLI:
  `approvals request-budget-exception`.
  **Limitation:** the foundation `BudgetService` does not yet accept an
  exception when checking limits. An approved exception is recorded and
  checkable (`checkBudgetException`) but raises no limit (see the foundation
  change request). Every CLI surface that requests, shows, or approves one
  says so (`BUDGET_EXCEPTION_CAVEAT` in `src/approvals/display.ts`: a
  `NOTE:` line in text, `caveats` in JSON).
- Both checks are pure. Checking another amount or cap never invalidates an
  approved exception or paid-request approval.

## 7. What is sent externally

This slice makes no third-party calls and sends no credentials. It sends
only read-only `GET` requests to the site's own `allowedHostnames`, with no
cookies or auth headers, and redirects are followed only within those hosts:
- to fingerprint the target when an approval is requested or an experiment
  proposed
- to recheck the target right before export
- to verify the live page at mark-implemented

With `--offline` or in demo mode, nothing is fetched and results are
`unverifiable`/`unverified`. The fetcher (`src/approvals/page-fetch.ts`) is
injectable (`PageFetcher`). At integration, swap in the crawler's SSRF-safe
fetcher with DNS revalidation.

## 8. Integration contracts for other slices

- **Recommendations** (`recommendations.details_json`, optional,
  machine-checkable): `proposedTitle`, `proposedMetaDescription`,
  `proposedContentMarkdown` / `proposedSectionMarkdown`, `proposedCanonical`,
  `proposedRobots`, `redirectTo`, `internalLinks`, `structuredData`,
  `targetUrl`, `rollbackPlan`, `evidence`. Without them, `proposed_change`
  text is still approved exactly but can only be verified by a human.
- **Drafts** (`content_drafts.package_json`): `bodyMarkdown | body | markdown`,
  `selectedTitle | title | titleOptions[]`, `metaDescription`,
  `slug | slugSuggestion`, `internalLinks`, `structuredData`, `sourceLedger`,
  `factCheckNotes`, `proposedUrl`.
- **Crawler:** `crawl_results.text_ref` raw payload may be a string or
  `{ text }`.
- **Router:** an experiment with status `observing` means `EXPERIMENT_ACTIVE`
  for its page. `proposed`/`approved`/`awaiting_implementation` also hold the
  page. Use `pageFreeze(db, siteId, { pageId, url })` from
  `src/experiments/freeze.ts`.
- **Approval gate users:** `ApprovalGate.check` is a pure query. Only the
  owner of a proposal whose current hash it knows should call
  `ApprovalService.checkCurrent`, which invalidates stale live approvals.
- **Recommendations:** `kind` decides no-action (`no_action`,
  `collect_more_evidence`). A production kind with an empty or `none`
  `action_type` is treated as a production change (fail closed).
- **Metrics helpers:** `latestCompleteGscDate(db, siteId, property, searchType, segmentKey = '')`
  and `latestCompleteGa4Date(..., channelView, segmentKey = '')` are
  page-level. `PageIdentity.pageCount` is the number of pages an identity
  stands for.
- **Weekly/monthly jobs:** call
  `reviewExperiments(ctx, { gate: new ApprovalService(ctx.db, { clock: ctx.clock }), actor: 'system:weekly' })`.
- **Content drafting:** call
  `assertAllowed(ctx.mode, 'generate_draft', { approval: gate.check(...) })`
  with a `draft_generation` approval.

## 9. CLI

```
npm run cli -- experiments specify-change <rec-id> --by "<name>" (--title "..." [--meta "..."] | --meta "..." | --section-file <file.md> | --redirect-to <url>) [--note ...] [--hypothesis ...]
npm run cli -- experiments propose --recommendation <id> [--primary-metric ctr] [--outcome-kind seo_visibility|conversion|both] [--min-days N] [--segment <segment-key>] [--revision <rev>] [--risks ...] [--retest-reason ...] [--critical-fix ...] [--as <name>]
npm run cli -- approvals list [--all|--status pending approved ...] [--subject experiment:<id>]
npm run cli -- approvals show <approval-id>
npm run cli -- approvals request <draft|recommendation|experiment|learning> <id> [--revision <rev>] [--ttl-hours N]
npm run cli -- approvals approve <approval-id> --as "<name>" --confirm <hash-prefix from approvals show> [--accept-unbound-revision] [--note ...]
npm run cli -- approvals reject <approval-id> --reason "<why>" [--as "<name>"]
npm run cli -- approvals request-budget-exception --provider apify --period 2026-09 --amount-usd 2.50 --reason "..."
npm run cli -- export <draft|recommendation|experiment> <id> --mode EXECUTE [--revision <rev> [--invalidate-stale]] [--allow-unverified-target] [--critical-fix <reason>]
npm run cli -- experiments mark-implemented <id> --at 2026-09-20T14:30:00+03:00 --revision <deploy> [--url ...] [--subject-type ...] [--critical-fix ...]
npm run cli -- --mode EXECUTE experiments mark-implemented <id> ... --deployed-without-export "<why the export was skipped>"
npm run cli -- experiments review [--all] [--id ...] [--conclude] [--json] [--dry-run]
npm run cli -- experiments annotate --scope site --kind template_change --at <iso> --description "..."
npm run cli -- experiments show|list|cancel|learnings|propose-learning ...
```

- **Investigation recommendations** ("compare the intent of the top results,
  then propose ONE specific change") carry an instruction, not a change.
  They cannot become an experiment, an approval request, or a production
  export (every investigation type is refused with a next step).
  `experiments specify-change` records the one concrete change as a new
  recommendation revision with a new artifact hash (audited; the recorder
  must be a named human); the previous revision is superseded and its open
  approvals are invalidated. Nothing is approved or deployed by it. The
  revision's `action_type` is the approval type implied by its structured
  change; the label it was specified from is kept only in
  `details_json.originalActionType` (the first one, across re-specifications),
  which `recommend` still matches rejected ideas and decisions on.
- **Recommendation status follows its experiment.** Approving an experiment
  moves its source recommendation from `proposed` to `approved`;
  `mark-implemented` moves it to `implemented`. A weekly run supersedes only
  still-`proposed` recommendations that no open experiment (proposed,
  approved, awaiting implementation, observing) was proposed from, so the
  recommendation being tested is never recorded as superseded.
- **`export --dry-run`** writes, consumes, invalidates, and audits nothing.
  A `--revision` that differs from the approval's bound revision is refused
  and leaves the approval untouched; `--invalidate-stale` (with `--revision`)
  states that this is the site's current revision, so the stale approval is
  invalidated and recorded.
- **Measured scope.** An experiment is measured at page level (optionally one
  Search Console segment with `--segment`). Query-level success criteria are
  rewritten to the page-level measure and the evaluation carries a scope
  caveat. The minimum observation period is rounded up to whole weeks, and
  a window shorter than the minimum is never evaluated.
- **Frozen measurement configuration.** The measurement-relevant config
  subset (primary conversion event, Search Console property, brand aliases,
  and similar) is frozen with a hash at proposal. Drift is flagged: a changed
  conversion event makes the conversion outcome inconclusive, a changed
  property makes a visibility outcome inconclusive.
- **Learnings** need a concluded, measured result; the approval carries the
  result, effect, and windows.
- **Live verification** after `mark-implemented` compares every approved
  paragraph with the live main text, records the coverage, and flags
  unapproved injected content; a sample of fragments is never enough for
  `match`.
- **Owner decisions.** Every `approvals approve` / `approvals reject` records a
  row in `decisions` on its subject, which the vault renders and `recommend`
  respects. Approver names are validated; automation and account names are
  refused.

## 10. Limitations (honest status)

- **Fingerprint rechecks.** Pages with dynamic main content (dates, counters,
  rotating blocks) can change their fingerprint. The safe outcome is to
  refuse and re-approve, which can happen more often than necessary.
- **Page fetcher.** The fetcher restricts hosts and schemes but does no DNS
  revalidation, because the configured site is the owner's own. At
  integration, replace it with the crawler's SSRF-safe fetcher.
- **Evaluation.** Comparison-page selection is heuristic (top impressions,
  same page type). Seasonality is handled only through comparison pages and
  weekday matching, not year-over-year. GA4 converting sessions are an
  estimate from the reported rate. No significance test exists.
- **Markdown conversion** is deliberately limited (no tables, nested lists,
  or images). The human reviews it before pasting.
- **Budget exceptions** are not yet enforced by `BudgetService` (see §6).
- **Output redaction.** Human CLI output passes through the foundation
  redactor. Ordinary prose such as "Basic plan" or "Authorization: required"
  is no longer masked (fixed in the redactor), while real credentials still
  are. The stored payload and the export package keep the exact text.
- **Coverage heuristics.** Truncation per date compares the number of
  distinct pages with rows (page id, or URL for unreconciled rows) with the
  number of pages an identity stands for. An unreconciled page seen under
  two alias URLs can mask a missing comparison page on a truncated date. On
  a very large site where every day hits the GSC row ceiling, a low-traffic
  treated page stays "incomplete" and eventually concludes `inconclusive`.
  That is honest, but slow.
- **Batch relevance.** Batches are matched by search type, channel view,
  and dimensions (GSC unsegmented = only `date,page` with no filters).
  Batches whose request lacks those fields are treated as relevant
  (conservative).
- **Unbound revisions.** A revision is required only in the sense that
  approving without one needs `--accept-unbound-revision`. The tool cannot
  read the site's real revision itself, so the human supplies it.
- **Not live-tested.** No live site or CMS was used. Every behavior is tested
  offline with synthetic fixtures and fake fetchers.

## 11. Access and credentials

This slice needs no credentials. To use it for real:

1. Configure the Search Console property, GA4 property, and primary event in
   the site config, and run the Google sync. Evaluations need ingested data.
   Without it they report `DATA UNAVAILABLE` or `collecting`.
2. Run online, without `--offline`, so target rechecks and live verification
   can fetch your own pages.
3. Pass your deployment or CMS revision with `--revision` when proposing or
   requesting approvals, so a later site change invalidates the approval.
4. Export in EXECUTE mode, deploy exactly that package, then record the real
   deployment with `mark-implemented` using the actual time and revision.

## 12. Tests

- `tests/unit/approvals/*`
  - policy matrix, including that ANALYZE cannot publish
  - approver identity
  - service: pure `check` versus `checkCurrent` invalidation (hash and
    revision), unbound-revision acknowledgment, no prefix in hints,
    `findLive`, expiry, one-time execution, two-connection race, DB
    triggers, model requesters
  - publisher: no-overwrite, tamper detection, path safety, placeholder
    factory, Markdown and diff
  - fetcher and verification
  - spend approvals, including that probing another amount or cap does not
    destroy an approval
- `tests/unit/experiments/*`
  - weekday-matched windows and time zones
  - status machine and append-only history
  - metrics: missing vs zero from the page-level dataset (page rows missing
    while property totals exist), truncated batches (GSC dates list,
    segment and search-type relevance, GA4), GA4 row loss (thresholding,
    "(other)", sampling; channel-view relevance; comparison groups; unknown
    totals without any row), GA4 estimates with the page present every day
    (sampled and "(other)" reports make the window incomplete, a clean or
    thresholded report stays observed, row provenance, comparison groups),
    page-level window cap and availability, GA4
    segment coverage, CTR and position weighting, GA4 rate handling, alias
    matching
  - learnings scope and approval, annotations
- `tests/integration/approvals/*`
  - export: mode enforcement, Markdown `approved: true` spoofing, package
    contents and hashes, second export refused, hash-change invalidation,
    revision binding and changed-revision invalidation, unbound-revision
    acknowledgment, target change, unverifiable override, dry run,
    unresolved facts, fail-closed empty action type, no-action records with
    production fields, off-site targets, re-request fingerprint replacement
  - mark-implemented: future time, before approval, missing approval, wrong
    hash, wrong URL, rollback records, live match, mismatch, offline,
    never-exported approval (refused, explicit EXECUTE escape hatch with a
    skipped recheck), one approval -> one publication (code and DB trigger),
    approvals executed by something else
  - concurrent consume across 4 processes
  - CLI end to end
  - `caveats-and-demo-banner.test.ts`: budget-exception caveat on request,
    show, approve (text, JSON, dry run); demo banner and `synthetic` flag on
    `approvals list` / `experiments list`
  - `draft-human-review.test.ts`: a production-bound draft export without a
    human acceptance of the exact body is refused with the next step (dry run
    and real run; nothing written, approval not consumed); after acceptance
    the same approval exports with the same artifact hash and `metadata.json`
    names the reviewer; a later automated re-review or a changed body no
    longer counts; the publisher backstop; only production-bound drafts are
    gated; the `--deployed-without-export` warning
- `tests/integration/experiments/comparison-scope.test.ts`: comparison pages
  ranked only on the configured property, search type, and unsegmented rows;
  the only property with page data used when none is configured; several
  properties and none configured select and sum nothing; evaluation keeps
  the property recorded at proposal after a second property's rows appear
- `tests/integration/experiments/ga4-row-loss.test.ts`: a treated page
  without GA4 rows on thresholded days leaves the conversion guardrail
  `unavailable` (not `ok`) with the caveat in the verdict; comparison pages
  without rows on such days make a conversion outcome `insufficient_data`
  instead of a biased effect; sampled or "(other)"-bucketed reports with
  every page present leave the conversion guardrail `unavailable` and the
  conversion outcome unjudged, with a caveat naming sampling or "(other)"
  (also for one sampled comparison page, and in a recorded evaluation)
- `tests/integration/experiments/specified-action-type.test.ts`: a title
  specified for a `repair_measurement` recommendation is approved as
  `title_meta_change`; first original label kept; legacy revisions typed by
  their structured change; label/scope mismatch warnings
- `tests/integration/experiments/risks-and-recommendation-status.test.ts`:
  propose refused without risks (library and CLI), approval refused for the
  legacy placeholder, recommendation `approved`/`implemented` with its
  experiment, weekly supersede skips recommendations of open experiments
- `tests/integration/experiments/lifecycle.test.ts`
  - observation starts at implemented_at
  - positive result with a learning proposal
  - append-only re-evaluation
  - minimum period, insufficient evidence, and the low-traffic period
  - unrelated site-change interference and non-blocking flags
  - guardrail breach is not a win
  - zero extra signups in a small sample is not a failure
  - segment matching
  - overlapping experiment refused (including a merely proposed one) unless
    a critical-fix override is given. The override flags the running
    experiment only at the real deployment time: export refusal and
    override, then the mark-implemented annotation
  - draft/recommendation export on a page under observation
  - concurrent experiments on different pages
  - re-test guard: exact change, reworded same-type change, cancelled after
    going live, cancelled before going live
  - publications as interference (treated page blocks, comparison page
    excluded)
  - measurement revisions, and DELETE/UPDATE guards on the history tables
  - review and dry run, frozen versions
