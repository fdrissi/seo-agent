# Module: weekly action plans and notifications

Source:

- `src/plans/render.ts`: the plan (status `action`, `n/a`, or `blocked`), rendered from the weekly report; pure.
- `src/plans/folder.ts`: the plans folder (location checks, the dedicated-folder rule, the `.gitignore`).
- `src/plans/publish.ts`: the follow-ups of a settled weekly job: write the plan, then notify; audit events; `followUpsOf` for the run output.
- `src/jobs/settled.ts`: the settled-job listener that `JobRunner.runJob` calls; installed by `src/app/wiring.ts`.
- `src/integrations/telegram/`: Bot API client (`sendMessage`, `getMe`, `getUpdates`) and the `telegram` status.
- `src/cli/commands/plans.ts` (`plans list`, `plans write`), `src/cli/commands/notify.ts` (`notify chats`, `notify test`).
- `src/setup/doctor.ts`: the `telegram` status and the `plans.folder` check.
- Tests: `tests/unit/plans/`, `tests/unit/integrations/telegram.test.ts`, `tests/integration/plans/weekly-plan.test.ts`, `tests/integration/cli/plans-notify.test.ts`, `tests/integration/setup/doctor-telegram.test.ts`.

## When a plan is written

`JobRunner.runJob` calls the settled-job listener after every run it
returns, whatever started it: `npm run weekly`, `jobs resume`, or a
scheduler tick. For a `weekly` job whose run ended `succeeded`, `waiting`
(a stage needs a human review), or `failed`, the listener writes the plan and
then sends the notification. Nothing happens for other job types, for runs
that settle later (a scheduled retry, an interruption, a lock wait), for
dry runs, or for an explicit historical period (`weekly --from/--to`, a
review of the past).

Both steps are follow-ups: an error in either is recorded as an audit event
(`action_plan.failed`, `notification.failed`) and logged, and the job's
recorded outcome never changes. The pipeline commands read those events back
into `followUps` ("After the run" in the text output).

## What a plan says

The plan is built from the weekly report's JSON (the report stays the
authoritative record), the job's error and degraded stages, and the site's
concluded experiments:

| Report decision | Plan status |
| --- | --- |
| `primary`, `repair_measurement` | `action` |
| `no_action`, `wait`, `collect_more_evidence` | `n/a` |
| run failed, waiting for a review, or no readable report | `blocked` |

Exact values (page URL, query, action type, ids, report path) are in the YAML
front matter for machines. The body quotes untrusted text through the vault's
escaping helpers, so a page title or query can never become a link, HTML, or
a code block, and the whole file is redacted. An `action` plan lists the
pages under observation as "Do not change these pages"; every plan except a
`blocked` one lists the experiments already tested.

## The plans folder

`actionPlans.dir` (absolute or `~/...`) or `<workspace>/plans/<site-id>`. The
folder is refused when it is the filesystem root, the home directory, the
system temp directory itself, inside the application folder, or inside the
workspace's `secrets/`, `data/`, or vault. A new or empty folder gets a
`.gitignore` that starts with `# seo-agent action plans` and ignores `*`
(itself included), so no repository around the folder ever sees a plan. An
existing folder is used only with that marker file and its `*` rule; a
folder holding other files is refused rather than hidden from Git. Plan
files are `YYYY-Www.md` (ISO week of the job's finish time in the business
time zone), then `-2`, `-3`, ... created with a no-overwrite atomic write
(mode 0600).

## Notifications

Telegram only, off by default. The message is plain text without link
previews: site ID, ISO week, plan status, and plan file name, plus the
action title when `includeActionTitle` is true. It is never sent for
synthetic data, dry runs, or `--offline`. One attempt per message; the
token (part of the URL path) is removed from every error message.
`notify chats` lists the chats that wrote to the bot (from `getUpdates`,
without confirming updates or showing message text), and `notify test`
sends one fixed message.
