# Scheduling weekly and monthly runs

Scheduling is **opt-in**. seo-agent never installs a timer, daemon, or crontab
entry on its own. You enable a schedule in the workspace database, then choose
how the scheduler is woken up, and install that yourself.

Enable scheduling only **after a successful manual run** (for example
`npm run cli -- weekly`), so you know credentials, budgets, and reports work.
`schedule enable` enforces this: it refuses until a manual `weekly` or
`baseline` run has succeeded with Search Console and GA4 data. `--force`
enables the schedule anyway (not recommended; the output says it was
forced), and `--dry-run` shows the plan with the same warning.

## 1. Record the schedule (opt in)

```sh
npm run cli -- schedule show                     # current state, next runs, DST notes, config drift
npm run cli -- schedule enable weekly            # cron + time zone from the site config
npm run cli -- schedule enable monthly --catch-up skip
npm run cli -- schedule enable weekly --mode RESEARCH   # allow budgeted external research in unattended runs
npm run cli -- --dry-run schedule enable weekly  # show what would be written, write nothing
npm run cli -- schedule disable weekly
```

- Defaults come from the site config: `scheduler.weekly.cron` (`0 7 * * 1`,
  Mondays 07:00), `scheduler.monthly.cron` (`0 8 2 * *`, the 2nd at 08:00),
  and `scheduler.timezone` (default `Europe/Tallinn`). The scheduler time zone
  says nothing about the website's target market.
- `--cron` accepts standard 5-field cron (minute hour day-of-month month
  day-of-week). `--timezone` must be an IANA name such as `Europe/Tallinn`;
  fixed offsets such as `UTC+2` or `+03:00` are rejected.
- **Modes.** Scheduled jobs run only in `ANALYZE` (default) or `RESEARCH`.
  Drafting and publishing always need an explicit human run. `schedule enable`
  prints the configured spending caps that bound each unattended run
  (ceilings from the site config, not price quotes).
- **Catch-up policy** (after the machine slept or was off through one or more
  slots): `once` (default) runs a single catch-up job at the next tick, no
  matter how many slots were missed; `skip` drops a slot that is more than one
  hour late and waits for the next one.
- If the site config prefers a schedule (`scheduler.weekly.enabled: true`)
  that is not enabled in the database, or the config cron/zone differs from the
  enabled schedule, `schedule show` reports the drift. Re-run
  `schedule enable <type>` to apply config changes.

## 2. How time is handled (IANA zones, daylight saving)

Due times are computed by [croner](https://github.com/hexagon/croner)
(pinned `croner@10.0.1`) in the schedule's IANA time zone. No UTC offset is
stored or hardcoded; offsets come from the time zone database at run time.

Example, weekly `0 7 * * 1` in `Europe/Tallinn` across the end of summer time
on 2026-10-25 (verified by `tests/unit/jobs/schedule-time.test.ts`):

| Local run | UTC instant |
| --- | --- |
| Mon 2026-10-19 07:00 (GMT+3) | 2026-10-19T04:00:00Z |
| Mon 2026-10-26 07:00 (GMT+2) | 2026-10-26T05:00:00Z |

Wall-clock times inside a daylight-saving transition are reported by
`schedule show` / `schedule enable` as DST notes. With the installed croner
version (behaviour measured in tests, not assumed):

- a time that does not exist (clocks move forward, e.g. 03:30 on 2027-03-28 in
  Tallinn) runs once, shifted forward by the gap (04:30 local);
- a time that occurs twice (clocks move back, e.g. 03:30 on 2026-10-25) runs
  once, at the first occurrence.

The default weekly/monthly times are not affected by either case.

## 3. Wake the scheduler

Something must call the scheduler. Two supported patterns:

**A. Periodic tick (recommended for laptops and most servers).** The operating
system runs `schedule run --once` every 15 minutes (configurable). Each tick
enqueues due schedules (each slot at most once, even with several tick
processes) and runs due jobs one at a time per site. The OS timer only
controls how often seo-agent looks; the machine's own time zone does not matter.

**B. Foreground daemon (continuously running server).** `schedule run` stays in
the foreground and ticks every 60 seconds (`--tick-seconds`). Run it under a
service manager. Ctrl+C / SIGTERM stops it; a job that was running is left
`interrupted`, and the first tick after the next start resumes it from its
checkpoints (see section 5 for the limits). Use A or B, not both (they are
safe together but redundant).

Print exact, path-resolved snippets for this installation:

```sh
npm run cli -- schedule instructions                      # launchd, systemd, cron, server daemon
npm run cli -- schedule instructions --platform launchd   # one platform
npm run cli -- schedule instructions --interval 30        # tick every 30 minutes
npm run cli -- schedule instructions --write              # also save snippets under <workspace>/exports/scheduling/ (still not installed)
```

The generated commands use absolute paths to `node` and the application, pass
`--workspace` and `--site`, and never contain secrets. Prefer a built install
(`npm run build`) for unattended use; when the command would run the
TypeScript sources through `tsx`, the output warns about it.

**Keep the compiled build in step with the sources.** `dist/` is not
version-controlled, so `git checkout <tag> && npm ci` keeps an OLD build.
`npm run build` therefore stamps `dist/build-info.json` (version, Git
revision, a hash of `src/`, and the list of migrations), and:

- `schedule instructions` uses `dist/cli/main.js` only when its stamp matches
  the checked-out version, `src/`, and `migrations/`. A stale or unstamped
  build is refused: the snippet runs the TypeScript sources instead, and the
  output says why, loudly.
- `schedule run` refuses to start (`CONFLICT`, nothing enqueued or run) from
  a compiled build that has no stamp or does not match `migrations/`, before
  it opens the workspace database. A change to `src/` alone only warns.
- The CLI warns at startup when it runs from a stale or unstamped build, a
  compiled build applies only the migrations it was stamped with, and
  `doctor` reports the build state.
- Each of these messages names the repair that works for the install: a
  checkout is told to run `npm run build`; a packaged install or container
  image without `src/` is told to reinstall or upgrade the package (or pull
  or rebuild the image), never to run `npm run build`.

After every upgrade: `npm run build`, then re-run `schedule instructions`
and reinstall the printed snippet if its command changed
(see [UPGRADING.md](UPGRADING.md)).

### macOS (launchd user agent)

The snippet is a LaunchAgent with `StartInterval` (tick) and `RunAtLoad`.
Install steps printed by the command:

```sh
mkdir -p ~/Library/LaunchAgents
# save the plist as ~/Library/LaunchAgents/local.seo-agent.<site>.plist
plutil -lint ~/Library/LaunchAgents/local.seo-agent.<site>.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.seo-agent.<site>.plist
launchctl print gui/$(id -u)/local.seo-agent.<site>        # verify
launchctl bootout gui/$(id -u)/local.seo-agent.<site>      # uninstall
```

A LaunchAgent only runs while you are logged in, and nothing runs while the Mac
sleeps or is shut down. launchd does not wake the Mac for this agent.

### Linux (systemd user timer)

A `Type=oneshot` service plus a timer with `OnCalendar=*:0/15`,
`Persistent=true` (a tick missed while the machine was off runs at the next
boot) and a small randomized delay. Install with
`systemctl --user daemon-reload && systemctl --user enable --now seo-agent-<site>.timer`.
On a server without an interactive login, `loginctl enable-linger "$USER"`
keeps user timers running. Verify with `systemctl --user list-timers` and
`journalctl --user -u seo-agent-<site>.service`.

### cron

One crontab line (`*/15 * * * *`) that `cd`s into the application and runs the
tick with absolute paths, appending output to `<workspace>/logs/scheduler-cron.log`.
cron does not run entries that were due while the machine was off or asleep;
the next tick catches up. On macOS prefer launchd.

### Continuously running server

A system service (`/etc/systemd/system/seo-agent-<site>-daemon.service`)
running `schedule run` with `Restart=on-failure`, an unprivileged `User=`,
`NoNewPrivileges=true`, and `PrivateTmp=true`. No inbound port is opened.
Keep the workspace private (directory mode `0700`).

> Unit, plist, and crontab syntax follows `launchd.plist(5)`,
> `systemd.timer(5)`, `systemd.service(5)`, and `crontab(5)`. The generated
> plist was validated with `plutil -lint` on macOS during development; the
> systemd and cron snippets were not executed on a Linux host in this
> environment. Check them against the man pages on your machine
> (`systemd-analyze --user verify` is included in the install steps).

## 4. A sleeping or offline laptop cannot run jobs

Nothing can run while the computer is asleep, powered off, or offline (network
requests fail and are reported honestly). When it wakes, the next tick runs a
missed slot once (catch-up `once`) or skips it (`skip`). For dependable weekly
and monthly runs, use an always-on machine or a small server.

## 5. Operating scheduled jobs

```sh
npm run cli -- jobs list                     # newest first; flags jobs that look interrupted
npm run cli -- jobs show <job-id>            # runs (pid, host), checkpointed stage results, errors
npm run cli -- jobs resume                   # recover interrupted jobs and continue from checkpoints
npm run cli -- jobs resume <job-id>          # one job (also re-runs a failed job once more)
npm run cli -- jobs resume <job-id> --reviewed <stage> --reviewer "<your name>"   # continue a job waiting for human review
npm run cli -- jobs cancel <job-id>          # queued: immediately; running: at the next stage boundary/heartbeat
npm run cli -- jobs locks                    # site and content leases, their holders, and whether each holder process is alive
npm run cli -- jobs locks --release <lock> --as "<your name>"   # remove a lease whose holder process is verified dead on this machine
```

- Runs of one site never overlap: a job runs only while it holds the site lock
  (a lease renewed by heartbeats). A tick that finds the previous weekly job
  still queued, running, or interrupted skips the slot and says why.
- Manual commands that change data or spend money (`sync`, `crawl`,
  `research keyword`, `export`, `apify test`, `apify research`, `data import`,
  `memory sync`, and others; the full list is in
  [CLI.md](CLI.md#conventions-network-money-modes-and-exit-codes)) hold the
  same lease while they run. While a job (or another such command) holds it,
  they refuse with `LOCKED` and do nothing; while such a command runs, a
  scheduled job of the site does not start: it stays queued and runs at a
  later tick, once the command has released the lease. `--dry-run` previews
  and read-only commands neither take nor check the lease. A manual lease
  records its holder process's start time, so a process id reused after a
  crash or reboot does not count as the holder; an expired lease of a dead
  holder no longer blocks, and `jobs locks --release <lock> --as "<your
  name>"` removes one whose holder process is verified dead on this machine
  (audited; automation names are refused). The scheduler's "locked" note
  names `jobs locks`, not `jobs resume`, when a manual command holds the
  lease. Content jobs use a
  separate `content` lock (a documented exception whose spending is still
  bounded by the shared, atomically reserved budgets).
- A pipeline you start in the foreground (`npm run weekly`) while the lock is
  held is refused with `LOCKED`, and the job it created is closed as
  `cancelled`, so nothing is left queued for an unattended tick. Run it again
  when the lock is free.
- A process that dies (crash, kill, power loss) leaves its job `running`; the
  next tick or `jobs resume` marks it `interrupted` (its process on this host
  is gone, or, for a process on another host, its heartbeat is stale) and
  continues from the last successful stage. A job whose process is still
  alive on this machine is never marked interrupted just because its
  heartbeat is old (a laptop that just woke up has not heartbeated yet); only
  after 6 hours without a heartbeat is it treated as hung. `jobs cancel` on
  such a crashed job (recorded `running`, but its process on this host is
  gone) marks it `interrupted` and then `cancelled` in one audited step and
  releases its site lock at once, so it no longer blocks `restore` or the
  next run; a job whose process is alive is still cancelled cooperatively at
  its next stage boundary or heartbeat.
- **Automatic resume.** A scheduled job that was interrupted (daemon stopped,
  crash, reboot, lost lock) is resumed by the next tick, from its checkpoints,
  without any command. This stops after 3 interruptions in a row of the same
  job: the tick then prints `ATTENTION: ...`, `schedule show` marks the
  schedule `BLOCKED: previous weekly job ... is interrupted and is not resumed
  automatically`, and new weekly slots are skipped until you run
  `jobs resume <job-id>` or `jobs cancel <job-id>`. A job you started by hand
  (for example `weekly` in a terminal, then Ctrl+C) is never resumed
  automatically and blocks the schedule in the same, visible way.
- A **paid** stage that was interrupted mid-flight is never rerun blindly,
  including by automatic resume: the provider may already have accepted and
  charged the request. The job stops with `AMBIGUOUS_SUBMISSION`. Reconcile
  first (`costs --unresolved`, provider history), then run
  `jobs resume <job-id> --rerun-paid-stages`.
- A stage that ignores cancellation or its timeout keeps the site lock held
  until it really stops (`jobs list` says so), so the next job never overlaps
  it.
- A job that stopped for **human review** is `waiting`. After reviewing the
  output, `jobs resume <job-id> --reviewed <stage> --reviewer "<your name>"`
  records the review in the audit log (as `owner:<your name>`) and continues
  with the next stage. `--reviewer` is required, and automation and account
  names such as `cli`, `system`, `scheduler`, `owner`, `root`, or `runner`
  are refused, so a script cannot record a human review by accident (names
  are asserted, not authenticated). A plain `jobs resume` stops at the same
  review again.
- A job refused because a provider's circuit breaker is open is retried no
  earlier than the breaker's next probe time. `npm run cli -- jobs breakers`
  lists open and half-open breakers with the next probe time and the last
  error; after fixing the cause, `jobs breakers --reset <provider>` closes
  one (audited). A run with network access disabled (`--offline`, the demo)
  never opens a breaker, so an offline trial cannot block the next real run.
- A run that completed but skipped stages (runtime mode, dry run, an optional
  provider that failed, a stage whose own note says skipped, degraded, or
  offline) is shown as `succeeded (degraded: N stage(s) ...)`, never as a
  bare `succeeded`; `jobs list`, `jobs show`, `schedule run`, and `--json`
  (`degradedStages`) count the same stages, and the job log records such a
  stage at warn level with its status and code. In a pipeline dry run the
  Search Console and GA4 syncs and the own-site crawl request and write
  nothing, so they are shown as skipped (`DRY_RUN`, `CRAWL_DRY_RUN`). A
  required stage whose prerequisite failed stops the job as `failed`
  (blocked) instead.
- `weekly --resume <job-id> --dry-run` (and the same for the other pipelines)
  is refused before anything runs: resuming continues a real job, which never
  runs against a dry run's throwaway database copy. Resume it for real, or
  preview a new run with `--dry-run` alone.
- Resuming a job that was enqueued in RESEARCH (or higher) mode requires the
  same `--mode` on the command line: `jobs resume` runs jobs only up to the
  invoking mode. `jobs list`, `jobs show`, `jobs locks`, and the `LOCKED`
  next step of a new run print the full command for such a job, for example
  `npm run cli -- --mode RESEARCH jobs resume <job-id>`.
- If a schedule's job type has no handler in the installed build, the slot is
  skipped with that explanation (`schedule show` lists handler availability).

## 6. Data sent externally

The scheduler, job runner, and these commands make no network requests. The
jobs they start run the configured pipelines, which call only the integrations
enabled for the site (see each module's documentation and `docs/ACCESS_SETUP.md`).
Secrets stay in `<workspace>/secrets/secrets.env` or a password-manager-injected
environment; never put them in plist, unit, or crontab files.

## 7. Uninstall

Disable the schedules (`schedule disable weekly`, `schedule disable monthly`)
and remove the OS timer or service with the uninstall steps printed by
`schedule instructions`. Disabling a schedule does not remove an installed
timer; the tick then simply finds nothing due.
