# Private workspace

seo-agent is one public application used with a **private workspace**. The
application (this repository or an installed package) never contains your
data; the workspace never contains application code. Upgrading one never
overwrites the other.

| Public application (repository / package) | Private workspace (default `~/seo-agent-workspace`) |
| --- | --- |
| `src/`, `prompts/`, `migrations/`, `tests/` | `config/sites/<site-id>.yaml`: your real site configuration |
| `docs/`, `config/sites/example.site.yaml` (synthetic) | `secrets/`: API keys and Google credential files (0700) |
| `vault/_template/`: vault templates | `vault/<site-id>/`: your Obsidian-compatible vault |
| synthetic fixtures in `tests/fixtures/` | `data/seo-agent.sqlite`, `data/raw/`, `data/cache/`, `qdrant/` |
| | `reports/`, `exports/`, `logs/`, `backups/`, `diagnostics/` |

Real site configuration, credentials, notes, analytics, databases, crawled
data, drafts, reports, logs, and backups belong only in the workspace. Keep it
outside any Git repository; `init` refuses to create one inside the
application repository (also when the path reaches it through a symbolic
link), and refuses your home directory, the filesystem root, and the system
temporary directory itself (a dedicated folder below them is fine).

## Where the workspace is

Resolution, highest precedence first:

1. `--workspace <dir>` (global CLI flag)
2. `SEO_AGENT_WORKSPACE` environment variable
3. `~/seo-agent-workspace`

`~` and `~/...` are expanded to your home directory. Every other location
(logs, database, vault, secrets) is derived from the workspace root at
runtime (`src/config/paths.ts`); nothing needs to be configured separately,
unless you relocate some folders with the optional `paths` block in
`workspace.json` (see [Custom locations](#custom-locations)).

## Layout

```
~/seo-agent-workspace/            0700
  workspace.json                  0600  manifest: format version, kind (live | demo), creating app version, optional "paths" 
  README.md                             what lives here
  .gitignore                            "*" - the workspace must never be committed
  config/sites/<site-id>.yaml           site configuration (validated; see CONFIGURATION.md)
  secrets/                        0700
    README.md                     0600
    secrets.env                   0600  API keys and passwords (dotenv format)
    google/                       0700  OAuth client file, token file, or service-account key
  vault/<site-id>/                      Obsidian-compatible Markdown vault
  data/seo-agent.sqlite           0600  authoritative database (WAL mode; -wal/-shm files 0600 too)
  data/raw/                             raw API responses (redacted, 0600 files)
  data/cache/                           provider response cache
  qdrant/                               Qdrant storage (a rebuildable index)
  reports/  exports/                    generated reports and manual exports
  logs/                                 redacted JSON-lines logs (0600)
  backups/                              backups (database, config, vault, raw, reports), pre-migration and pre-restore backups
  diagnostics/                          redacted diagnostic bundles for bug reports
```

## Creating a workspace: `init`

```sh
npm run cli -- init                                 # ~/seo-agent-workspace
npm run cli -- --workspace /path/to/private init    # or SEO_AGENT_WORKSPACE=/path/to/private
npm run cli -- init --dry-run                       # show what would be created; writes nothing
npm run cli -- init --allow-existing-dir            # a non-empty folder without workspace.json (see below)
```

`init` refuses a directory that already holds files but has no
`workspace.json`, so a private workspace is never mixed with unrelated files
by accident. If that is really what you want, pass `--allow-existing-dir`:
the layout is added next to the existing files and nothing is overwritten.
An empty or new directory, or an existing workspace, needs no flag. (`setup`
creates a missing workspace with the same checks.)

`init` creates the directories and starter files above, then creates the
database and applies all migrations. It is safe to run any number of times.
The output (or `--json`) lists what was created and what already existed,
plus next steps that only name commands available in your build (for
example, copying the synthetic `config/sites/example.site.yaml` to
`config/sites/<site-id>.yaml` when the setup wizard is not available). The
example leaves `reporting.businessTimezone` unknown (`null`), so
`config validate` and every report warn, and reports and budget periods use
`scheduler.timezone`, until you set your business's own IANA zone; the zone
is never inferred.

### Never-overwrite guarantee

- Every file is created only when it does not exist, using an exclusive
  create (`O_EXCL`): if a file appears concurrently, it is left alone and
  reported, never replaced.
- Existing files are never modified, truncated, or deleted, whatever their
  content (your edited `README.md`, your `secrets.env`, your site configs,
  your vault notes).
- A symlink (even a dangling one) at a location `init` would write is treated
  as existing and never followed.
- The only change ever applied to existing entries: the `secrets/` and
  `secrets/google/` directories are tightened to 0700 when they are more
  open, with a warning. An exposed `secrets.env` is reported with the exact
  `chmod 600` command; its mode is not changed for you.
- A workspace written by a **newer** application (higher `formatVersion` in
  `workspace.json`) is refused rather than downgraded, by `init` and by every
  command that opens the workspace (`db migrate`, `costs`, `backup`,
  `restore`, and all per-site commands), so an older application never
  creates or migrates data in a layout it does not understand.
  `workspace status` still reports it (`formatSupported: false`). A database
  containing migrations this application does not know is refused as well.
- A demo workspace and a live workspace are never mixed: initializing a
  demo workspace as live (or the reverse) is refused, and every command that
  works on a site refuses a `profile: demo` site in a live workspace, or a
  core/full site in a demo workspace, before it opens the database
  (`WORKSPACE_UNSAFE`; `doctor` reports it as a failure). Synthetic data
  cannot enter a live workspace by file either: `data import` refuses a
  synthetic file there (`--synthetic`, a file that declares itself
  synthetic such as a `data export` of a demo workspace, or rows marked
  `is_synthetic = 1`) with `WORKSPACE_UNSAFE` before anything is written, and
  `doctor` fails a live workspace whose current Search Console or GA4 rows
  are labeled synthetic. See [DEMO.md](DEMO.md#isolation-and-safety).
- A workspace in an **older** format is refused until `npm run cli -- config
  migrate --yes` upgrades `workspace.json` (see
  [UPGRADING.md](UPGRADING.md#configuration-and-workspace-format-migrations)).
- A corrupt `workspace.json` is reported and left untouched.

Vault templates are copied the same way (`ensureVaultFromTemplate`): only
missing files are created, so human edits in the vault always survive. Every
destination is resolved inside the vault: a symlinked folder that points
outside the vault is never written through, and a file sitting where a
template folder is expected is left alone; both are listed as `skipped`.

## Custom locations

Some folders can live outside the workspace root, for example the vault in
an existing Obsidian folder or backups on another disk. Add an optional
`paths` block to `workspace.json` (edit it by hand; `init` never rewrites
it):

```json
{
  "formatVersion": 1,
  "kind": "live",
  "paths": {
    "vaultDir": "/Users/me/Obsidian/seo-agent",
    "backupsDir": "/Volumes/Backup/seo-agent-backups"
  }
}
```

| Key | Replaces | Notes |
| --- | --- | --- |
| `vaultDir` | `<workspace>/vault` | Each site's vault is `<vaultDir>/<site-id>/`. |
| `backupsDir` | `<workspace>/backups` | Pre-migration, pre-restore, `backup`, and config-migration backups. |
| `qdrantDir` | `<workspace>/qdrant` | The Qdrant storage folder `init` creates and `doctor` checks. The bundled `compose.yaml` mounts `<workspace>/qdrant`; change its volume line to the same folder. |
| `exportsDir` | `<workspace>/exports` | Manual export packages and scheduling instructions. |
| `reportsDir` | `<workspace>/reports` | Report Markdown and JSON files. Report records store paths relative to this folder, so moving it (with its files) keeps every stored report readable; records written by older versions (relative to the workspace root) still resolve, in `<workspace>/reports` or in the relocated folder. |

Precedence, highest first: a key in the `paths` block, then the location
derived from the workspace root (the root itself comes from `--workspace` >
`SEO_AGENT_WORKSPACE` > `~/seo-agent-workspace`). Every key is optional;
config, secrets, the database, raw responses, logs, and diagnostics always
stay under the workspace root. Any other key is refused.

Each value is validated whenever the workspace is opened (symbolic links
resolved): it must be an absolute path (`~` is not expanded), outside the
application repository, not the filesystem root, your home directory, or
the system temporary directory itself, not inside `secrets/`, not the
workspace root itself, and not a folder that contains the workspace. An
invalid block stops every command with `WORKSPACE_UNSAFE` and the list of
problems; there is no silent fallback to the default location. `init`
creates missing relocated folders (0700), `workspace status` lists them, and
`doctor` shows which locations live outside the workspace root.

## Secrets

- Put API keys in `secrets/secrets.env` (see
  [CONFIGURATION.md](CONFIGURATION.md#environment-variables) for the names)
  or inject them as environment variables from a password manager, for
  example `op run -- npm run cli -- <command>`. Environment variables take
  precedence over the file.
- Never paste secrets into a chat, the vault, a site config, an issue, or a
  report. The application reads them programmatically and never prints them;
  loaded secret values are masked in all logs and output.
- The application warns when `secrets.env` or `secrets/` is readable by other
  users.
- `backup` never includes `secrets/`. Back up credentials with your password
  manager.

## Upgrades and migrations

- The database schema changes only through forward-only, checksummed
  migrations (`migrations/NNNN_name.sql`). Editing an applied migration is
  detected (checksum mismatch) and refused.
- Before pending migrations are applied to a database that already holds data,
  a verified backup is written to
  `backups/pre-migration-<timestamp>.sqlite`. Each migration runs in its own
  transaction; a failing migration is rolled back and the error names the
  backup file.
- Migrations run automatically when a command opens the workspace, or
  explicitly with `npm run cli -- db migrate` (`--dry-run` lists what would be
  applied). `npm run cli -- db status` and `workspace status` are read-only.
- Several processes may start at once after an upgrade (a scheduled job and a
  manual command): each migration re-checks `schema_migrations` inside its own
  `BEGIN IMMEDIATE` transaction, so a migration another process already
  applied is skipped instead of failing, and each is applied exactly once.
- `--dry-run` never changes the database: a per-site command run with
  `--dry-run` refuses with `MIGRATION_PENDING` when migrations are pending
  (run `db migrate` first), does not register the site or record a changed
  configuration (it prints a notice instead), and, when the database does not
  exist yet, plans against an empty temporary in-memory database without
  creating the file. A normal run with an unchanged configuration does not
  rewrite the site row either.
- Site configs and `workspace.json` carry a format version. A file in an
  older format is never rewritten implicitly: loading it fails with
  `CONFIG_INVALID` (or `WORKSPACE_UNSAFE` for the manifest) and the next
  step `config migrate`, which shows a diff and writes only with `--yes`,
  after copying the originals to `backups/config/<timestamp>/`. `db migrate`
  lists pending configuration migrations without applying them.
- Upgrading the application never rewrites workspace files. Do not
  auto-update a live installation from a development branch. See
  [UPGRADING.md](UPGRADING.md).

## Backup and restore

```sh
npm run cli -- backup                     # database + site configs + vault + data/raw + reports -> backups/backup-<timestamp>/
npm run cli -- backup --no-vault          # skip the vault copy (likewise --no-raw, --no-reports)
npm run cli -- backup --dry-run           # show what would be written
npm run cli -- restore --from <dir>       # verify only; shows what would be replaced
npm run cli -- restore --from <dir> --confirm
```

- The database copy is a consistent online snapshot (`VACUUM INTO`), checked
  with `PRAGMA integrity_check` and written with mode 0600. An existing backup
  file is never overwritten.
- `backup` also copies the raw provider responses (`data/raw`, which stored
  observations reference as their provenance) and the generated report
  files (`reports/`, which the reports table points to) by default;
  `--no-raw` and `--no-reports` skip them. Without `data/raw`, the raw
  references of restored observations point to files that are not in the
  backup, and `BACKUP.md` says so.
- `backup` lists exactly what it copied: the JSON result has `database`,
  `config`, `vault`, `raw`, and `reports` set to the copied path or `null`
  (plus the sites the database holds), and `BACKUP.md` names the contents
  and what was not included (for example "database (none existed)" or "raw
  provider responses (--no-raw)"). A backup without a database cannot be
  used by `restore`.
- `restore` verifies the backup first and refuses a backup written by a
  newer application version. It keeps demo and live data apart: a backup
  holding a demo site is refused in a live workspace, and one holding a live
  site is refused in a demo workspace (`WORKSPACE_UNSAFE`, in the preview and
  with `--confirm`; nothing is changed). It lists the sites the backup holds
  and warns when they differ from the workspace's `config/sites/`. With
  `--confirm`, it saves the current database
  to `backups/pre-restore-<timestamp>.sqlite` (so the restore itself can be
  undone), then replaces the database atomically.
- `restore` refuses (`LOCKED`) while the live database records unexpired
  site locks or running jobs: a job still running would keep writing to the
  replaced file and those writes would be lost. The unconfirmed preview shows
  the recorded activity. Only when those entries are stale (for example after
  a crash) pass `--force`; the result lists what was forced over. While the
  pre-restore backup and the replacement copy are made, the restore holds the
  database write lock, so no other writer can commit in between; it is
  released just before the file swap.
- Vault, site-config, raw-response, and report copies from the backup are
  restored **beside** the live files in `restored-<timestamp>/`, never over
  them; review and move what you need (raw references resolve against
  `data/raw`).
- `--dry-run` never changes anything. Stop scheduled jobs before restoring;
  the lock and running-job check is a safeguard, not a replacement.

For a complete off-machine backup, copy the whole workspace directory while
no job is running (or use `backup` plus your password manager for
`secrets/`). The Qdrant index can always be rebuilt from SQLite and the vault
(`memory rebuild`).

## Moving a workspace

1. Stop scheduled jobs and any running command.
2. Move or copy the whole directory, preserving permissions
   (for example `rsync -a`).
3. Point the application at it with `SEO_AGENT_WORKSPACE` or `--workspace`.
4. Run `npm run cli -- workspace status` and `npm run cli -- config validate`.

Paths are derived from the workspace root at runtime and report records store
workspace-relative paths, so the workspace does not need to live at a fixed
location. If you installed scheduling, regenerate the instructions
(`npm run cli -- schedule instructions`) and reinstall them so the scheduled
command references the new location.

## Multiple sites

One workspace can hold several sites: add one
`config/sites/<site-id>.yaml` per site. With more than one site, pass
`--site <id>` to commands.

- Every database row, job, budget, evidence record, and retrieval carries the
  site ID, so data stays isolated per site inside the shared database. Each
  site has its own vault folder (`vault/<site-id>/`).
- Budgets are per site; `budgets.accountMonthlyUsd` adds shared ceilings for a
  provider account used by several sites in the same workspace. Account caps
  are workspace-wide: the smallest value declared by any site binds every
  site (see [CONFIGURATION.md](CONFIGURATION.md#scopes-checked-on-every-paid-request)).
- Secrets are per workspace. Sites that must use different credentials, or
  that must be fully separated (for example different clients), belong in
  separate workspaces.
- The demo uses its own isolated demo workspace; synthetic data never mixes
  with live reporting.

## Troubleshooting

| Error code | Meaning and next step |
| --- | --- |
| `WORKSPACE_MISSING` | No `workspace.json` at the resolved location. Run `init`, or check `--workspace` / `SEO_AGENT_WORKSPACE`. |
| `WORKSPACE_UNSAFE` | The location is inside the application repository, your home directory, the filesystem root, or the temp directory itself; a non-empty directory has no `workspace.json` (use `init --allow-existing-dir`); the workspace was written by a newer application or uses an older format (`config migrate`); `workspace.json` is corrupt or its `paths` block is invalid; or a site's profile does not match the workspace kind (demo vs live). Nothing was changed. |
| `WORKSPACE_EXISTS` | A demo workspace was initialized as live (or the reverse). Use a separate directory. |
| `MIGRATION_FAILED` | A migration failed (see the pre-migration backup named in the message), an applied migration file was edited, or the database is newer than the application. |
| `MIGRATION_PENDING` | A `--dry-run` found pending migrations; it never applies them. Run `npm run cli -- db migrate`, then repeat the dry run. |
| `LOCKED` | `restore` found unexpired locks or running jobs in the live database. Stop them (or wait), or pass `--force` if they are stale. |
| `UNSAFE_PATH` | A path would escape its base directory (traversal, absolute path, or symlink). Nothing was written. |
