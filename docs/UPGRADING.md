# Upgrading and recovery

The owner and every other user follow the same path: install a **tagged
release**, keep private data in a **separate workspace**, and upgrade with a
backup first. There is no special fork for the owner and no auto-update.

## Rules that protect your data

- **Versioned releases only.** Run live installations from release tags
  (`vX.Y.Z`), never from the development branch. seo-agent has no auto-update
  and must never be configured to pull the development branch automatically
  (no cron `git pull`, no `:latest` image auto-restarts for live sites).
- **The workspace is never overwritten.** Installing or upgrading the
  application never writes to your workspace. `init` only creates missing
  files and reports what it left untouched.
- **Database changes happen only through migrations.** Migrations are
  forward-only and checksummed. Before applying pending migrations to a
  non-empty database, a verified pre-migration backup is written to
  `<workspace>/backups/pre-migration-<timestamp>.sqlite`.
- **No downgrades of a live database.** An older application refuses a
  database that contains migrations it does not know. Recover by restoring a
  backup (below), not by editing the database.
- **Configuration and workspace-format changes happen only through
  `config migrate`.** Site configs (`schemaVersion`) and `workspace.json`
  (`formatVersion`) carry a version. A file in an older format is never
  rewritten on load: the run stops (`CONFIG_INVALID` for a site config,
  `WORKSPACE_UNSAFE` for the manifest) and names `config migrate` as the next
  step. Changes are also announced in `CHANGELOG.md`. Invalid configuration
  stops the run with a field-level error instead of guessing.

## Before you upgrade

1. Read the `CHANGELOG.md` entries between your version and the target
   version: breaking changes, new migrations, config changes, new external
   data flows, new paid usage.
2. Stop scheduled jobs (disable the scheduler entry or `launchd`/`systemd`
   timer) and make sure no job is running:
   `npm run cli -- jobs list`.
3. Take a full backup (database, site configs, vault, raw provider responses,
   and reports; secrets are excluded):
   ```sh
   npm run cli -- backup
   ```
   Back up `<workspace>/secrets/` separately in your password manager.
4. Note your current version: `npm run cli -- --version`.

## Upgrade (Git checkout)

```sh
git fetch --tags
git checkout vX.Y.Z                 # a release tag, never the development branch
npm ci --ignore-scripts
npm run typecheck && npm test       # optional but recommended
npm run cli -- db status            # shows pending migrations
npm run cli -- db migrate           # writes a verified pre-migration backup first; also LISTS pending config migrations
npm run cli -- config migrate       # shows the diff of any config/workspace-format migration; writes nothing
npm run cli -- config migrate --yes # applies it after copying the originals to backups/config/<timestamp>/
npm run cli -- config validate --site <site-id>   # field-level config errors after schema changes
npm run cli -- doctor               # never spends money without an explicit flag
npm run build                       # only if you run the compiled build (dist/) or schedule jobs
npm run cli -- schedule instructions   # re-check the scheduler command; reinstall the snippet if it changed
```

Then run one manual job (for example `npm run cli -- weekly --dry-run`) and
re-enable scheduling only after it succeeds.

**Rebuild after every checkout.** `dist/` is not version-controlled, so
`git checkout <tag> && npm ci` keeps the OLD compiled build. `npm run build`
compiles and then stamps `dist/build-info.json` (version, Git revision, a
hash of `src/`, and the migration list). A compiled build applies only the
migrations it was stamped with (an unstamped build applies none), the CLI
warns at startup when it runs from a stale or unstamped build, `doctor`
reports the build state, `schedule run` refuses to start from a build that is
unstamped or does not match `migrations/`, and `schedule instructions` points
a scheduler at the sources instead of a stale build (see
[SCHEDULING.md](SCHEDULING.md)).

A compiled install without `src/` (an installed package or a container
image) cannot be rebuilt in place. For such an install, the
`MIGRATION_FAILED` hint of a refused migration and the startup warning about
an unstamped or stale build say to reinstall or upgrade the package (or pull
or rebuild the container image) with a complete release whose `dist/`
includes `build-info.json`, then re-run `seo-agent schedule instructions`;
they never suggest `npm run build` there. The `doctor` build check, the
`schedule run` refusal, and the `schedule instructions` fallback note do the
same: a checkout is told to rebuild, a packaged install or container image to
reinstall or upgrade.

**Notes for the release that adds migrations 0300-0320.**

- `0300_ai_citation_manual_import` (import provenance for AI-citation
  observations), `0310_cost_provenance` (the basis of every cost amount;
  existing reconciled rows are back-filled from the ledger, rows of synthetic
  provider requests or demo sites are flagged synthetic, nothing is guessed),
  and `0320_ga4_rate_scale_confirmation` (an append-only table; update and
  delete are blocked by triggers). All are additive.
- URL identities now normalize percent-encoding (RFC 3986). The weekly
  `reconcile_urls` stage (or `npm run cli -- analyze reconcile`) rewrites
  stored page URLs in place, but modules that look pages up by exact URL do
  not know the old form yet, so the first crawl after the upgrade can create
  a new-form duplicate of a page whose URL has lower-case percent hex or
  encoded unreserved characters. Run `npm run cli -- analyze reconcile` right
  after upgrading and before the next crawl; the reconcile report lists any
  duplicate it resolved (`identities.duplicates`).
- GA4 key-event rates stay "undetermined" until the scale is established;
  confirm it once with
  `sync ga4 --confirm-rate-scale fraction|percent --evidence "<what you compared>" --as "<your name>"`
  (see [ACCESS_SETUP.md](ACCESS_SETUP.md#38-validate-conversion-reporting-manual-checklist)).
  Stored rates are re-marked as new revisions, older days included.

**Behavior changes without a migration (fourth round of fixes).**

- Human names are checked more strictly: the whole names `owner`, `admin`,
  `root`, `node`, `runner`, `user`, `default`, and similar, look-alike and
  mixed-script spellings, and concatenations such as `claudecode` are
  refused, and a service-account operating-system user (`node`, `runner`,
  `root`, ...) is no longer used when `--as` is omitted. Scripts, the
  container (`node`), and CI (`runner`) must pass `--as "<your name>"`
  (`--by` for `vault apply-business`).
- `data import` refuses synthetic files in a live workspace. If `doctor`
  now fails with current Search Console/GA4 rows labeled synthetic (for
  example from a synthetic import that an older version accepted), restore a backup from
  before that import, or re-import the real files: a live row supersedes the
  synthetic revision of the same key, but keys that only the synthetic file
  had stay synthetic until a restore.
- `data export --out` refuses the vault, `secrets/`, and the application
  repository outside the workspace.
- Experiments frozen under evaluation method version 2 or earlier are
  evaluated with a "measurement method changed" caution (version 3 treats
  sampled or `(other)`-bucketed GA4 values as estimates).

## Configuration and workspace-format migrations

`config migrate` upgrades every site config in `config/sites/` and
`workspace.json` that is in an older format, using the ordered
`vN -> vN+1` transforms shipped with the application
(`src/config/config-migrations.ts`; there are none yet, because version 1
is the first format):

- Without `--yes` (or with `--dry-run`) it shows the plan and a unified diff
  per file and writes nothing.
- With `--yes` it first copies every original to
  `<workspace>/backups/config/<timestamp>/` (`workspace.json`,
  `sites/<site-id>.yaml`; mode 0600, never overwriting an earlier backup),
  then replaces each file atomically with mode 0600. Comments and layout of
  unchanged sections are kept; the result must validate before it is
  written, and a file edited after the diff was shown is not overwritten.
- If any file cannot be migrated by this version (no migration path, a newer
  format, or a result that does not validate), nothing is written and the
  command exits 1 with the reasons.
- `db migrate` and `db migrate --dry-run` list pending configuration
  migrations (read-only) so an upgrade does not miss them.

To undo a configuration migration, copy the files back from
`backups/config/<timestamp>/` (and use the previous release).

## Upgrade (optional container image)

```sh
docker build -t seo-agent:vX.Y.Z .       # from the checked-out tag
docker run --rm -v "$HOME/seo-agent-workspace:/workspace" seo-agent:vX.Y.Z db migrate
docker run --rm -v "$HOME/seo-agent-workspace:/workspace" seo-agent:vX.Y.Z doctor
```

The workspace is a mounted volume; it is never baked into or replaced by the
image. Keep the previous image tag until the new one has run successfully.
The image runs as the `node` user, a service account: commands that record a
human decision need `--as "<your name>"` there (`--by` for
`vault apply-business`).

## Recovery procedures

### A. A migration failed during upgrade

Symptoms: `Error [MIGRATION_FAILED]: Migration NNNN_x.sql failed ...` with a
hint naming the pre-migration backup.

1. Do not edit the database or the migration file.
2. Keep the failed state for diagnosis:
   `npm run cli -- diagnostics export` (redacted; inspect before sharing).
3. Restore the pre-migration backup. `restore` expects a backup directory, so
   place the file in one:
   ```sh
   mkdir -p ~/seo-agent-workspace/backups/restore-premigration
   cp ~/seo-agent-workspace/backups/pre-migration-<timestamp>.sqlite \
      ~/seo-agent-workspace/backups/restore-premigration/seo-agent.sqlite
   npm run cli -- restore --from ~/seo-agent-workspace/backups/restore-premigration            # verifies only
   npm run cli -- restore --from ~/seo-agent-workspace/backups/restore-premigration --confirm  # replaces the live DB
   ```
   The current (failed) database is saved as `pre-restore-<timestamp>.sqlite`
   first, so the restore itself is reversible.
4. Check out your **previous** release tag, `npm ci --ignore-scripts`, and run
   `npm run cli -- db status`: it must show no unknown migrations.
5. Report the failure with the redacted diagnostics (see `SUPPORT.md`).

This procedure is exercised end to end by `tests/e2e/new-user.test.ts`
(upgrade with `db migrate`, automatic migration by a normal command, a
failing migration, restore of the pre-migration backup, `db status` on the
previous release).

### B. The application refuses the database ("migrations unknown to this application version")

You are running an older application against a newer database. Either check
out the newer release again, or restore a backup taken before the upgrade
(procedure A, step 3) and then run the older release.

### C. "Migration ... was modified after being applied (checksum mismatch)"

The application files were changed locally or the checkout is corrupted.
Re-checkout the release tag (`git checkout vX.Y.Z -- migrations/` or a fresh
clone). Never "fix" a checksum in the database.

### D. Restore a regular backup

```sh
ls ~/seo-agent-workspace/backups/                    # backup-<timestamp>/ directories
npm run cli -- restore --from ~/seo-agent-workspace/backups/backup-<timestamp>
npm run cli -- restore --from ~/seo-agent-workspace/backups/backup-<timestamp> --confirm
```

- The live database is replaced only with `--confirm`, after the backup passes
  an integrity check; the previous database is saved first.
- Vault, site-config, raw-response, and report copies are restored
  **beside** the live files (`<workspace>/restored-<timestamp>/`), never over
  them. Compare and move what you need by hand, so human edits are never
  silently overwritten.
- A demo backup is never restored into a live workspace (and a live backup
  never into a demo workspace); `restore` lists the backup's sites and warns
  when they differ from `config/sites/`.
- Secrets are not in backups: restore them from your password manager.

### E. Corrupted or lost database

1. `npm run cli -- restore --from <latest backup dir>` (procedure D).
2. If there is no usable backup: move the damaged file aside, run
   `npm run cli -- init` (creates a fresh, migrated database without touching
   other files), then re-sync available history (`sync gsc`, `sync ga4`, or
   `baseline`). Measurements older than the providers' retention windows and
   local decisions/approvals cannot be recovered without a backup.
3. The Qdrant index is rebuildable: `npm run cli -- memory rebuild`.

### F. Vault conflicts after an upgrade

Generated notes never overwrite human edits; conflicting versions are written
as conflict artifacts next to the note. Review and merge them manually.

### G. Roll back the application only

If a new release misbehaves but did not add migrations, check out the
previous tag and `npm ci --ignore-scripts`. If it did add migrations, restore
the pre-migration backup first (procedure A).

## After upgrading

- Re-run `npm run cli -- doctor`.
- Re-enable scheduling after one successful manual run.
- Keep the pre-migration backup until you are confident in the new version;
  then prune old backups according to your retention policy
  (`docs/PRIVACY.md`).
