# Module: workflows and durable jobs

Source: `src/workflows/`, `src/jobs/`, CLI in `src/cli/commands/jobs.ts` and
`src/cli/commands/schedule.ts`, migration `migrations/0180_jobs_scheduling.sql`.
Operator guide: `docs/SCHEDULING.md`.

This module owns orchestration only. It contains no SEO logic and no provider
adapters; baseline/weekly/monthly pipelines are built elsewhere and plugged in
as stage lists and job handlers.

## Workflow engine (`src/workflows/engine.ts`)

Three patterns from spec section 4.

### SEQUENTIAL: `runSequential(ctx, workflowName, stages, params, { jobId, signal, breakers, heartbeat, rerunAmbiguousPaidStages, abortGraceMs, onOrphanedStage })`

Stages implement the shared `StageDefinition` contract (`src/workflows/types.ts`)
plus optional engine extensions (`src/workflows/stage.ts`, `EngineStage`):

| Field | Meaning |
| --- | --- |
| `idempotent` | Retries happen only when true AND the stage spends no money. |
| `requiredMode` | Minimum runtime mode (spec 24). Lower modes skip the stage (`MODE_NOT_PERMITTED`). |
| `optional` | Skips/failures degrade the workflow (listed in `degraded`) instead of failing it. |
| `optionalPrerequisites` | Earlier stages passed in `ctx.prior` when available, without being required. |
| `providers` | Provider keys checked against circuit breakers before the stage starts. |

Per stage, in order:

1. **Mode gate**, then **prerequisites**: a stage runs only when every required
   predecessor produced a validated output, never on partial data. If the
   output is missing by policy (the predecessor was skipped for runtime mode
   or dry run), the stage is skipped too (`PREREQUISITE_UNSATISFIED`). If it is
   missing because an optional predecessor failed or was unavailable, a
   required stage stops the workflow `blocked` (`PREREQUISITE_UNSATISFIED`)
   rather than letting it end as `succeeded`; an optional stage degrades.
   `validateWorkflow` warns about required stages that depend on optional
   ones.
2. **Build + validate input** with the stage's zod schema. Input validation
   failure fails the stage and stops the chain (`VALIDATION_FAILED`).
   `buildInput` must be side-effect free.
3. **Checkpoint reuse**: the latest `succeeded`/`stopped` checkpoint with an
   output is reused when `stage_version` AND `input_hash` match. The input hash
   covers the validated input and the prior outputs visible to the stage
   (`hashObject({ input, prior })`), so upstream changes cascade. Reuse happens
   before the gates below, so a finished stage is not blocked by a budget it
   already spent or a provider that is now down. A reused checkpoint whose
   `shouldStop` says `needs_review` stops again, unless a human review of that
   exact checkpoint was recorded (see Reviews below).
4. **Dry run**: paid stages (`costAllowance !== 'none'`) are skipped with their
   cap shown (`DRY_RUN`).
5. **Circuit breakers** (`peek`, non-mutating) for declared providers: open ->
   optional stage skipped (`INTEGRATION_UNAVAILABLE`); required stage fails the
   workflow as retryable (nothing was sent) with `failure.retryAfter` = the
   breaker's next probe time, which the job runner honours.
6. **Budget pre-flight**: a paid stage whose provider budget is already
   exhausted (any run/site/week/month/combined/account scope) is not started;
   the workflow stops `blocked` with `BUDGET_EXCEEDED` (optional: degraded).
7. **Evidence**: `evidence.check(input)` problems stop the workflow `blocked`
   with `EVIDENCE_INSUFFICIENT` (optional: degraded). "Collect more evidence"
   is a legitimate outcome, not an error.
8. **Paid in-flight protection**: before each attempt of a paid stage an
   `IN_FLIGHT` marker checkpoint is written. If an earlier run ended while the
   paid stage was in flight (marker, timeout, cancellation, lock loss), the
   stage is not rerun: the workflow stops `blocked` with `AMBIGUOUS_SUBMISSION`
   until a human passes `rerunAmbiguousPaidStages` (`jobs resume <id>
   --rerun-paid-stages`), which is audited.
9. **Run** with a per-attempt timeout (`AbortSignal`). Stages must pass
   `ctx.signal` to their I/O because a JavaScript promise cannot be killed.
   After a timeout or cancellation the engine waits up to `abortGraceMs`
   (default 5 s) for the attempt to actually stop, so a retry never overlaps
   it. An attempt still running after the grace period is **orphaned**: it is
   listed in `result.orphaned`, never retried (at stage or job level), and
   handed to `onOrphanedStage`. The job runner uses that hook to keep the
   site lock held until the stage settles. Retries use exponential backoff
   with jitter (`src/core/retry.ts`) only for idempotent, non-paid stages and
   transient errors; paid stages always use `NO_RETRY`.
10. **Validate output** (never retried on failure), evaluate `shouldStop`,
    check the stop status is one of the stage's declared `next` states
    (`INVALID_TRANSITION` otherwise), persist the checkpoint.
11. **Log** the outcome. A stage whose output carries a `note` that says it
    did not do all of its work (status `skipped` or `degraded`; `offline`
    when the code says so, as `jobs show` displays it) is logged at warn
    level with that status, code, and detail, for example `Stage crawl_site
    offline: CRAWL_OFFLINE: ...` or `Stage sync_gsc skipped: DRY_RUN: ...`,
    like an engine-level skip. Only a clean output (no note, or a
    `succeeded` note) is logged as `Stage <name> succeeded`. A reused
    checkpoint's log line names the status it recorded.

Definition checks (`validateWorkflow`): unique names, earlier-only
prerequisites, each stage's `next` includes the following stage, the last
stage lists a terminal state (`done`, `completed_early`, `blocked`,
`needs_review`, `no_action`), non-negative integer allowances; warnings for
retries declared on paid or non-idempotent stages.

**Cost allowance**: every reservation a stage makes through `ctx.app.budgets`
(proxied) or `toolsOf(ctx).budget` is checked against the stage cap before the
budget service checks run/site/service/account limits; `runId` is forced to
the job id so per-run caps apply per job. A stage declaring `'none'` cannot
reserve (`POLICY_DENIED`). An unknown price (no upper bound, or a basis of
`unknown`, the same rule as the budget service) cannot be checked against a
stage cap and needs an explicit approval id. It is counted separately
(`unknownPriceReservations`), never as $0, and it is logged separately from
`reservedMicros`. After one, every further reservation for that provider in
the stage also needs an explicit approval id, because the cap can no longer be
verified.

Result: `EngineResult` (`succeeded | failed | stopped | cancelled`) with
per-stage outcomes, validated outputs, `degraded`, `skippedRequired`
(non-optional stages skipped by policy), `orphaned`, `stoppedBy`, `failure`
(including whether a job-level retry is safe and `retryAfter`), and warnings.
`summarizeWorkflow()` gives the output-free summary stored on the job;
`workflowJobSummary()` (`src/jobs/workflow-handler.ts`) adds
`degradedStages`, the combined list of stages that did not do all of their
work: the engine's `degraded` list plus stages the engine recorded as
`succeeded` whose own output note (or the report's stage notes) says
skipped/degraded/offline. `workflowResultNote()` turns the stored result into
the one-line note that the CLI prints next to the status: `succeeded
(degraded: N stage(s) skipped or failed: ...)` (engine stages only) or
`succeeded (degraded: N stage(s) skipped, degraded, or failed: ...)` (output
notes counted), or `nothing ran`. `jobs list`, `jobs show`, `jobs resume`,
`schedule run`, the pipeline commands' headline, and their `--json`
(`degradedStages`, `note`) count the same list and never show a degraded run
as a bare `succeeded`. Results stored by older versions (no
`degradedStages`) fall back to the engine list.

### Reviews (`src/workflows/reviews.ts`)

A stage that stops with `needs_review` leaves the job `waiting`. Resuming does
not help by itself, because the engine reuses the stopped checkpoint and
re-applies `shouldStop` to it. `jobs resume <id> --reviewed <stage>
--reviewer <name>` calls `recordStageReview()`. `--reviewer` is required and
validated like an approver name (automation and account names such as
`cli`, `system`, `scheduler`, `owner`, `root`, or `runner` are refused; names
are asserted, not authenticated), and the review is recorded as
`owner:<name>`. That appends a
`workflow.stage_reviewed` audit event whose subject is the exact checkpoint.
It is accepted only when the job is `waiting` on `needs_review` at that
stage. On resume the engine checks `isCheckpointReviewed()` and continues
past the stop. The review covers that checkpoint only: if the stage reruns
(new input or version), the new output needs a new review.

### BOUNDED PARALLEL: `runBoundedParallel(items, workers = 3, fn, { keyOf, perKeyLimit, signal })`

Built on `mapBounded` and `KeyedLimiter` from `src/core/concurrency.ts`: at
most `workers` items (1-16) run at once, optionally with a stricter per-key
limit (per provider/host). Failures are captured per item. Parallelism
shortens wall-clock time only; it does not reduce token charges or provider
costs, and every paid call still reserves budget.

### ROUTER: `routeWith(rules, item, { unsureRoute, ambiguousClassifier, allowedRoutes, minConfidence })`

Deterministic rules first (the first matching decisive rule wins); non-decisive
rules only suggest candidates. The cheap-model hook is called only when no
decisive rule matched, and its answer is accepted only inside the allowed /
hinted route set (and above `minConfidence`); otherwise, and when it fails, the
item gets the explicit `unsureRoute`. `routeAll` classifies ambiguous items
with bounded concurrency. The SEO rules themselves live in `src/router`.

### Checkpoints (`src/workflows/checkpoints.ts`)

Table `checkpoints` (grain: one row per job, stage, attempt, plus attempt-0
rows for gate decisions). Outputs are stored as plain JSON in the private
database and are not passed through secret redaction (redaction rewrites
values under keys such as `session`, which would corrupt measurements); stages
must never put secrets in outputs. Error records are redacted inside
`CheckpointStore.save()`, whatever built them (thrown errors, validation
issues, evidence problems, gate reasons). Outputs that are not JSON
round-trippable (e.g. `Date` objects) are flagged and not reused.

## Durable jobs (`src/jobs/`)

- `enqueue(ctx, type, params, opts)` (`store.ts`, re-exported from
  `runner.ts`): `jobs` row with site, mode, dry-run flag, max attempts, trace id;
  optional validation against the handler's params schema.
- `JobRegistry` + `createDefaultRegistry()` (`handlers.ts`): handlers keyed by
  job type. `workflowJobHandler()` adapts a stage list to a handler and maps
  workflow results to job statuses (`succeeded`; `stopped` no_action /
  completed_early -> `succeeded`; needs_review -> `waiting`; blocked -> `failed`,
  not retried; failed -> `failed` or scheduled retry).
- `JobRunner`:
  - **Per-site lock** (`locks.ts`, table `site_locks`): lease (default 90 s)
    renewed by heartbeats (15 s); expired leases are taken over atomically and
    audited (`lock.takeover`). The holder is the pair (owner, job): one runner
    running two jobs of a site at once gets the lock for the first only, and
    renew/release match both. An expired lease is NOT taken over while its
    job is still `running` in a process that is alive on this host (a laptop
    that just woke up), until `localStaleAfterMs` (default 6 h). A runner that
    loses its lock aborts its job (`LOCKED`) and leaves it `interrupted`. A
    locked site returns `locked` without consuming an attempt.
  - **Orphaned work**: `JobHandlerContext.keepLockUntilSettled(promise)`.
    When a stage ignores its abort signal past the grace period, the run's
    status is recorded, but the lock stays held (its lease keeps being
    renewed, audited as `lock.held_for_orphaned_work` /
    `lock.released_after_orphaned_work`) until the stage settles. The job is
    not retried meanwhile, and no other job of the site (or new run of the
    same job) starts. `runner.settled()` waits for it; `jobs resume` and
    `schedule run --once` wait before exiting.
  - **Guarded writes**: the heartbeat and the final status update are
    conditioned on `status = 'running' AND lock_owner = <this runner> AND
    attempt = <this run>`. A slow run that was declared stale and taken over
    stops at its next heartbeat. If it finishes first, its result is
    discarded: its `job_runs` row is closed as `interrupted` with
    `SUPERSEDED`, audited as `job.run_superseded`. It can never overwrite the
    newer run's result.
  - **Runs**: one `job_runs` row per attempt with pid and hostname.
  - **Retry/backoff**: a failed run is retried after exponential backoff (1 min
    base, 30 min max) only when the outcome is retryable; thrown errors are
    retried only for handlers marked `idempotent`. A failed outcome may carry
    `retryAfter` (an open circuit breaker's next probe); the retry is never
    scheduled before it. `max_attempts` counts failed runs; interrupted runs
    do not count.
  - **Cancellation**: `requestCancel()` cancels non-running jobs immediately and
    sets `cancel_requested` for running ones; the runner polls it (1 s) and
    checks it on every heartbeat/stage boundary, aborting the handler's signal
    with `CANCELLED`. With `opts.holder` (`jobs cancel` passes
    `JobRunner.runningJobHolder`, the check `jobs list` uses), a running job
    whose process on this host no longer exists never reaches that check: it
    is marked interrupted and then cancelled in one transaction (its run
    closed as `interrupted`, its site lock released, audited `job.interrupted`
    and `job.cancelled`), so `restore` is no longer blocked by it. A running
    job that only appears interrupted (a stale heartbeat on another host, a
    hung local process) gets `cancel_requested`, and the result says so and
    names `jobs resume <id>`, which then closes it as cancelled without
    running it.
  - **Crash recovery**: `recoverInterrupted()` marks `running` jobs as
    `interrupted` and releases their lock when their process on this host no
    longer exists, or, for a run on another host, when the heartbeat is
    older than the lease. A live process on this host is judged on its pid,
    not its heartbeat age, until `localStaleAfterMs`. `resume()` continues
    them; workflow jobs reuse their checkpoints. A real SIGKILL crash is
    exercised in `tests/integration/jobs/crash-recovery.test.ts`.
  - **Automatic resume** (`drain(ctx, { autoResume, scheduledOnly })`, used
    by the scheduler tick with `scheduledOnly: true`): interrupted jobs that
    pass `autoResumeDecision()` are resumed oldest first together with due
    queued jobs. To pass, a job must have been started by the scheduler
    (`params.trigger = 'schedule'`) and have fewer than
    `DEFAULT_MAX_AUTO_RESUMES` (3) consecutive interrupted runs. With
    `scheduledOnly`, a due queued job that a human started in the foreground
    (for example a retry a `weekly` run left queued) is never run unattended.
    These jobs, and interrupted ones that do not pass, are returned in
    `needsAttention`. The engine's `AMBIGUOUS_SUBMISSION` gate still applies,
    so a paid stage that was in flight is never rerun automatically.
  - **Dry run is sticky**: the handler context is built with `dryRun =
    ctx.dryRun || job.dryRun`, so a job created for real never runs non-dry
    from a dry-run invocation. The pipeline commands also refuse `--dry-run`
    with `--resume <jobId>` (`VALIDATION_FAILED`, nothing run or changed):
    resuming continues a real job, which must not run against the throwaway
    database copy that dry runs use.
  - **Mode ceiling**: `maxMode` refuses jobs above it (the unattended scheduler
    uses RESEARCH; `jobs resume` uses the invoking `--mode`). Every resume
    hint therefore names the job's mode when it is above ANALYZE
    (`resumeJobCommand()` in `store.ts`: `npm run cli -- --mode RESEARCH jobs
    resume <id>`): the `INTERRUPTED` error of a recovered job, the automatic
    resume refusals, and the "appears interrupted" lines of `jobs list`,
    `jobs show`, and `jobs locks` (whose `--json` carries the lease job's
    `jobMode`).
  - Result and error JSON are redacted before storage.
- `CircuitBreakers` (`circuit-breaker.ts`, table `circuit_breakers`): per site
  and provider; opens after N consecutive provider-health failures (default 3;
  timeouts, provider/network errors, rate limits; not
  budget/policy/credential errors, and never `OFFLINE`: a Google request
  refused because network access is disabled has code `OFFLINE`, not
  `INTEGRATION_UNAVAILABLE`), refuses during the cooldown (default 15 min),
  then allows one half-open probe; success closes, failure re-opens. `peek()`
  is read-only (used by the engine gate), `execute()`/`canRequest()` perform
  the probe transition. An open breaker for an optional provider degrades
  only the stages that declare it. A run with network access disabled
  (`--offline`, demo mode) gets breakers with the `offline` option: it still
  sees open breakers but records no failure or success and consumes no probe,
  so an offline trial never blocks a later real run. `reset(provider, actor)`
  is audited (`circuit.reset`, with the previous state). The open-breaker
  hint points to `jobs breakers`.
- `enqueueAndRun()` runs a foreground job (e.g. `baseline`, `weekly` commands)
  with the same durability rules. When the lock is held, the job it just
  enqueued is closed as `cancelled` with code `LOCKED`
  (`closeUnstartedJob()`, audited `job.cancelled`), and the result says that
  nothing was left queued. A command the operator ran now never turns into an
  unattended run on a later scheduler tick. `keepQueuedIfLocked` restores the
  old behaviour. The next step follows the holder: a job that is alive ->
  wait for it; a manual command -> wait, or `jobs locks --release` once its
  process is gone; a job whose run appears interrupted
  (`JobRunner.interruptedLockHolder()`: the job is still `running` but the
  check `jobs list` uses says its process on this host is gone, or its
  heartbeat is stale) -> it can never finish by itself, so the error says
  its run was interrupted and the hint is to resume it with
  `npm run cli -- --mode <job mode> jobs resume <id>` (`--mode` only above
  ANALYZE) or cancel it (`lockedRefusalError(heldBy, jobId, holder)`). The
  pipeline commands' `--resume` gives the same next step when a job it
  resumes finds such a holder.

## Scheduler (`src/jobs/scheduler.ts`, `dst.ts`, `instructions.ts`)

See `docs/SCHEDULING.md`. Summary: opt-in `schedules` rows (migration 0001 plus
0180 columns `mode`, `catch_up`, `last_job_id`, `last_note`); croner computes
next runs in the schedule's IANA zone (`mode: '5-part'`); `schedulerTick()`
enqueues each due slot once with a compare-and-set on `next_run_at` (a slot
another tick process claimed first is listed in `handledElsewhere`; the
`afterPlan` hook lets tests force two ticks to interleave), collapses missed
slots per the catch-up policy, and skips honestly (no handler, previous run
active). It then drains the queue with `scheduledOnly`: only jobs the
scheduler enqueued run, interrupted scheduled jobs are resumed, and the rest
are reported in `needsAttention`. `blockingJob()` counts running and
interrupted jobs of the type and jobs the scheduler queued; a queued job a
human started never makes a slot be skipped. `blockingJob()` and
`describeSchedules().blockedBy` explain what blocks a schedule, marked
`BLOCKED:` when a human must act. `runSchedulerDaemon()` is the foreground
loop; its output in the CLI is redacted like all other output;
`dstNotesForCron()` reports schedules inside DST gaps/overlaps using offsets
read from the time zone database; `buildSchedulingInstructions()` generates
launchd/systemd/cron/server snippets that are never installed automatically.

## CLI

`jobs list [--status s1,s2] [--type t] [--limit n]`, `jobs show <id>`,
`jobs resume [id] [--rerun-paid-stages] [--reviewed <stage> --reviewer <name>]`, `jobs cancel <id>`,
`jobs locks [--release <lock> --as <name>]` (each lease with its holder, heartbeat,
expiry, and whether the holder process is alive, gone, or cannot be checked
from this host; `--release` removes a lease only when its holder process is
verified dead, audited as `lock.released_dead_holder` by `owner:<name>`;
`--as` is validated by `validateApproverName`, so automation and account
names are refused; a lease of a job still recorded as running is left to `jobs cancel`
or `jobs resume`),
`jobs breakers [--reset <provider>]` (open and half-open breakers first, with
the next probe time and last error; `--reset` closes one after the cause is
fixed, audited as `circuit.reset` by `cli`; `--dry-run` previews it; an
unknown provider is refused with `NOT_FOUND`),
`schedule show [--upcoming n]`,
`schedule instructions [--platform launchd,systemd,cron,server|all] [--interval m] [--write]`,
`schedule enable <weekly|monthly> [--cron expr] [--timezone iana] [--catch-up once|skip] [--force]` (global `--mode ANALYZE|RESEARCH`; refuses until a manual weekly or baseline run succeeded with Search Console and GA4 data, unless `--force`),
`schedule disable <weekly|monthly>`,
`schedule run [--once] [--tick-seconds n] [--all-sites]`.
All support `--json`; `--dry-run` previews enable/disable/cancel/resume/run,
`jobs breakers --reset`, and `jobs locks --release` without writing.
`jobs show` prints each checkpointed stage with the status the job result
counts for it (`degradedStages`): a stage recorded as succeeded whose own
output note says offline is shown as `offline (OFFLINE)`, never as a bare
`succeeded`; `--json` carries it as `displayStatus` next to the raw status.

**Site lock and manual commands.** Manual commands that change data or spend
money (`MUTATING_COMMANDS` in `src/cli/runtime.ts`: the `sync` commands,
`crawl`, `crawl page`, `crawl competitor`, `research keyword`, `perf check`,
`analyze page/route/reconcile`, `report build`, `vault render`,
`content brief/draft/review/batch/bootstrap/import/measure`,
`experiments review`, `export`, `apify test/research/import-schema/inspect`,
`data import`, `pages set-type`, `memory sync/rebuild/reconcile`,
`models test`, `costs reconcile`; and, in `CONDITIONALLY_MUTATING_COMMANDS`,
only with the options that make them write or spend: `memory search
--allow-paid`, `pages infer-types --apply`, `vault import-business --apply`,
`research tasks --poll|--abandon`, `apify runs --resume|--confirm-not-accepted`)
take the same per-site `site` lease a job holds, through the jobs lock API
(`src/jobs/manual-lease.ts`, `ManualSiteLease`). The lease is acquired
atomically when the command's context is built, renewed by heartbeats
(`MANUAL_LEASE_MS` 90 s, `MANUAL_HEARTBEAT_MS` 15 s), and released when the
command's database connection closes or, at the latest, when its action
ends (also on failure). Its owner is
`manual(<command>)@<host>:<pid>:<nonce>;start=<ms>` (the process start time;
owners written before it was recorded have no `;start=` part and still
parse), and it has no job id. So:

- while a job or another manual command holds the lease, the command refuses
  with `LOCKED`, naming the holder and a next step that follows what this
  host can tell about the holder's process (`manualHolderHint`: gone, alive,
  or on another host; `jobs locks`, `jobs locks --release`);
- while the command runs, a scheduled or foreground job of the same site
  finds the lease held and does not start (the scheduler leaves its job
  queued for the next tick; a foreground pipeline closes its new job as
  `cancelled`);
- an expired manual lease is not taken over while the command's process is
  still alive on this host: the pid exists and, when the owner recorded it,
  the process with that pid started at the recorded time
  (`processStartedAt`, read with `ps -o etime=`, 60 s tolerance), so a pid
  reused after a crash or reboot does not keep the site locked. A live holder
  that never renews is treated as hung once a contender saw its lease
  expired and unrenewed `MANUAL_LOCAL_STALE_AFTER_MS` (4 heartbeats, 60 s)
  earlier; the sighting is audited once per owner and heartbeat
  (`lock.unrenewed_seen`) by the refused command or runner. The window
  starts at the sighting, not at the last heartbeat, because a heartbeat
  also ages while a laptop sleeps and an awake holder renews within one
  heartbeat. The heartbeat-age bound of 6 h (`LOCAL_HEARTBEAT_AGE_LIMIT_MS`)
  still applies as well. Holders on another host, dead processes, and reused
  pids may be taken over once the lease expired (`leaseHolderAliveReason`).

`--dry-run` previews and read-only commands never take or check the lease.
`ai-citations import` checks the job lock itself. Every registered command is
classified in `tests/integration/cli/site-lock.test.ts`, so a new paying or
data-changing command cannot be missed. Content jobs use a separate
`content` lock, a documented exception: a content job and a weekly job of
the same site may run at the same time, and their spending stays bounded
because every paid request reserves its upper bound atomically against the
same budgets (`content bootstrap` honours both locks).

## Verified contract usage

No external HTTP APIs are used by this module. The only third-party library
contract is croner 10.0.1: `new Cron(pattern, { timezone, paused: true, mode: '5-part' })`,
`nextRun(date)`, `nextRuns(n, date)`, `match(date)`, checked against the
installed type declarations (`node_modules/croner/dist/croner.d.ts`) and
exercised by tests, including DST behaviour in Europe/Tallinn. The croner README
states that times in a DST gap are skipped; the installed version was measured
to shift them forward by the gap instead, so the application reports the
computed behaviour rather than either claim (`dstNotesForCron`).

## Data sent externally

None. Jobs started by the runner call whatever integrations their pipelines use.

## Limitations

- A stage that ignores `ctx.signal` keeps running in the background after its
  timeout or cancellation. The engine waits up to the grace period. After
  that, the runner holds the site lock until the stage settles, and the
  in-flight protection keeps a paid stage from being rerun blindly. The hold
  only lives in the process that ran the stage. If that process exits, the
  stage dies with it and the lease runs out. If the machine sleeps during a
  hold, another process may take the lock over after wake-up, because the
  lock's job is no longer `running`.
- Automatic resume applies only to jobs the scheduler enqueued, and stops
  after 3 consecutive interruptions (`DEFAULT_MAX_AUTO_RESUMES`; configurable
  per tick with `autoResume`, not yet from site config).
- Recorded reviews are audit events. Deleting audit history would also
  "un-review" a waiting job (it would stop for review again, which is the
  safe direction).
- A JOB's process on this host is trusted by pid for up to 6 hours without a
  heartbeat (`localStaleAfterMs`): `job_runs` records the pid and host but no
  process start time. In the rare case that a crashed job's pid was reused
  after a reboot, the job stays `running` (and `jobs cancel` only requests
  cancellation) until then; `jobs show` displays the recorded pid and host.
  Manual-command leases record the start time and are not affected.
- The process start time is read with `ps` (macOS, Linux). Where `ps` is
  missing (Windows, minimal containers) only the pid is checked; the
  sighting window still ends a live holder's hold after a few heartbeats.
- A sighting recorded just before the machine went to sleep again (within
  one heartbeat after waking, before the holder renewed) is still counted
  after the next wake-up, so that lease can be taken over right away.
- Circuit-breaker thresholds, lock lease, heartbeat, and backoff are code
  defaults configurable through `JobRunner` options, not site config yet.
- The daemon reads site configuration once at start; restart it after
  configuration changes.
- Paid-stage in-flight detection covers crashes, timeouts, cancellations, and
  lock loss of this job. Provider-side reconciliation of ambiguous requests is
  done by the budget/provider-request modules (`costs --unresolved`).
- launchd/systemd/cron snippets follow the man pages; only the plist was
  validated (`plutil -lint`) during development.

## Integration status

The pipelines are registered: `installWiring()` (`src/app/wiring.ts`, run by
the CLI entry point) calls `registerPipelineJobHandlers()` (`baseline`,
`weekly`, `monthly`, `content.queue`) and `registerContentJobHandlers()`
(`content.research`, `content.production`, `content.batch`), which add their
factories with `addDefaultHandler`, so every `createDefaultRegistry()`
(`src/jobs/handlers.ts`) holds them and `jobs resume` and `schedule run` can
continue those jobs. The pipeline commands run them with `enqueueAndRun`
(see [pipelines.md](pipelines.md)). A job type without a registered handler
fails with an honest "no handler registered" status, and the scheduler skips
its slots.
Adapters called from stages use `toolsOf(ctx).breakers?.execute(provider, fn)`,
pass `ctx.signal` to requests, record `jobId` on provider requests, and
reserve through `ctx.app.budgets` (stage-capped). No credentials are needed
for this module.
