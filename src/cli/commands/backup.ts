import type { Command } from 'commander';
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { listSiteIds } from '../../config/load.js';
import type { WorkspacePaths } from '../../config/paths.js';
import { readManifest } from '../../config/workspace.js';
import { AppError } from '../../core/errors.js';
import { openDatabase } from '../../database/db.js';
import {
  assertBackupMatchesWorkspace,
  backupDatabase,
  databaseActivity,
  databaseSites,
  restoreDatabase,
  verifyDatabaseFile,
  type DatabaseActivity,
  type DatabaseSite,
} from '../../database/backup.js';
import { loadMigrations } from '../../database/migrate.js';
import type { CliRuntime } from '../runtime.js';

/**
 * Parts of the workspace copied next to the database, by their path inside a
 * backup directory. `restore` copies each one BESIDE the live files
 * (`restored-<time>/<part>`), never over them.
 *
 * - vault: the Obsidian vault.
 * - config/sites: site configs.
 * - data/raw: raw provider responses; observations and ingestion batches
 *   reference them (raw_ref, raw_refs_json as `raw:<path>` relative to data/raw).
 * - reports: generated report files that the reports table points to.
 */
export const BACKUP_PARTS = ['vault', path.join('config', 'sites'), path.join('data', 'raw'), 'reports'] as const;

/** Sites of a backup compared with the workspace's site configs (warnings only; demo/live mismatches are refused). */
function siteDifferences(paths: WorkspacePaths, sites: DatabaseSite[], backupDir: string): string[] {
  const configured = listSiteIds(paths);
  const inBackup = sites.map((s) => s.id);
  const warnings: string[] = [];
  const unconfigured = inBackup.filter((id) => !configured.includes(id));
  const missing = configured.filter((id) => !inBackup.includes(id));
  if (unconfigured.length) {
    const hasConfigCopy = existsSync(path.join(backupDir, 'config', 'sites'));
    warnings.push(
      `The backup holds site(s) with no config in ${paths.sitesDir}: ${unconfigured.join(', ')}. Commands run only configured sites${hasConfigCopy ? '; the backup\'s site configs are restored beside the live files for review' : ''}.`,
    );
  }
  if (missing.length) warnings.push(`Configured site(s) with no data in the backup: ${missing.join(', ')}. After a restore their data starts empty (the next command registers the site again).`);
  return warnings;
}

const describeSites = (sites: DatabaseSite[]) => (sites.length ? sites.map((s) => `${s.id} (${s.isDemo ? 'demo, synthetic' : 'live'})`).join(', ') : 'none');

/** Migrations recorded in a backup that this application does not know (backup is from a newer version). */
function unknownMigrationsIn(file: string): string[] {
  const known = new Set(loadMigrations().map((m) => m.version));
  const db = openDatabase(file, { readOnly: true });
  try {
    return db
      .all<{ version: string; name: string }>('SELECT version, name FROM schema_migrations ORDER BY version')
      .filter((r) => !known.has(r.version))
      .map((r) => r.name);
  } finally {
    db.close();
  }
}

/** Locks/running jobs recorded in the live database (read-only), or null when there is no database. */
function liveActivity(dbFile: string): DatabaseActivity | null {
  if (!existsSync(dbFile)) return null;
  const db = openDatabase(dbFile, { readOnly: true });
  try {
    return databaseActivity(db.raw);
  } finally {
    db.close();
  }
}

export function register(program: Command, cli: CliRuntime): void {
  program
    .command('backup')
    .description('Back up the database, site configs, vault, raw provider responses (data/raw), and reports into <workspace>/backups (secrets excluded)')
    .option('--no-vault', 'skip the vault copy')
    .option('--no-raw', 'skip data/raw (raw provider responses that observations reference as their provenance)')
    .option('--no-reports', 'skip reports/ (generated report files the reports table points to)')
    .action(
      cli.action(async (opts: { vault?: boolean; raw?: boolean; reports?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const paths = cli.requireWorkspace(g);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const dest = path.join(paths.backupsDir, `backup-${stamp}`);
        // Only non-empty sources count as backed up, so the result never claims content that was not there.
        const hasContent = (dir: string) => existsSync(dir) && readdirSync(dir).length > 0;
        const includeVault = opts.vault !== false && hasContent(paths.vaultRoot);
        const includeConfig = hasContent(paths.sitesDir);
        const includeRaw = opts.raw !== false && hasContent(paths.rawDir);
        const includeReports = opts.reports !== false && hasContent(paths.reportsDir);
        if (g.dryRun) {
          cli.print(
            g,
            {
              dryRun: true,
              dir: dest,
              database: existsSync(paths.dbFile) ? paths.dbFile : null,
              config: includeConfig ? paths.sitesDir : null,
              vault: includeVault ? paths.vaultRoot : null,
              raw: includeRaw ? paths.rawDir : null,
              reports: includeReports ? paths.reportsDir : null,
              secretsIncluded: false,
            },
            (r) =>
              `Dry run: would write a backup to ${r.dir} (database: ${r.database ? 'yes' : 'none'}, config: ${r.config ? 'yes' : 'none'}, vault: ${r.vault ? 'yes' : 'no'}, raw responses: ${r.raw ? 'yes' : 'no'}, reports: ${r.reports ? 'yes' : 'no'}). Secrets are never included.`,
          );
          return;
        }
        if (existsSync(dest)) throw new AppError('CONFLICT', `Backup directory already exists: ${dest}`);
        mkdirSync(dest, { recursive: true, mode: 0o700 });
        const result: { dir: string; database: string | null; config: string | null; vault: string | null; raw: string | null; reports: string | null; sites: DatabaseSite[]; secretsIncluded: false } = {
          dir: dest,
          database: null,
          config: null,
          vault: null,
          raw: null,
          reports: null,
          sites: [],
          secretsIncluded: false,
        };
        if (existsSync(paths.dbFile)) {
          const db = openDatabase(paths.dbFile);
          try {
            result.database = backupDatabase(db, path.join(dest, 'seo-agent.sqlite'));
          } finally {
            db.close();
          }
          result.sites = databaseSites(result.database);
        }
        const copy = (enabled: boolean, from: string, part: string): string | null => {
          if (!enabled) return null;
          const to = path.join(dest, part);
          cpSync(from, to, { recursive: true });
          return to;
        };
        result.config = copy(includeConfig, paths.sitesDir, path.join('config', 'sites'));
        result.vault = copy(includeVault, paths.vaultRoot, 'vault');
        result.raw = copy(includeRaw, paths.rawDir, path.join('data', 'raw'));
        result.reports = copy(includeReports, paths.reportsDir, 'reports');
        // Describe only what was actually copied.
        const contents = [
          result.database ? 'database' : null,
          result.config ? 'site configs' : null,
          result.vault ? 'vault' : null,
          result.raw ? 'raw provider responses (data/raw)' : null,
          result.reports ? 'reports' : null,
        ].filter((x): x is string => x !== null);
        const missing = [
          result.database ? null : 'database (none existed)',
          result.config ? null : 'site configs (none existed)',
          result.vault ? null : opts.vault === false ? 'vault (--no-vault)' : 'vault (empty or missing)',
          result.raw ? null : opts.raw === false ? 'raw provider responses (--no-raw)' : 'raw provider responses (data/raw empty or missing)',
          result.reports ? null : opts.reports === false ? 'reports (--no-reports)' : 'reports (empty or missing)',
        ].filter((x): x is string => x !== null);
        const rawSkipped = opts.raw === false && hasContent(paths.rawDir);
        writeFileSync(
          path.join(dest, 'BACKUP.md'),
          [
            `# seo-agent backup ${stamp}`,
            '',
            `Contains: ${contents.length ? contents.join(', ') : 'nothing (the workspace had no database, site configs, vault, raw responses, or reports)'}.`,
            ...(missing.length ? [`Not included: ${missing.join(', ')}.`] : []),
            ...(result.database ? [`Sites in the database: ${describeSites(result.sites)}.`] : []),
            ...(rawSkipped ? ['Without data/raw, the raw-response references (raw_ref) of restored observations point to files that are not in this backup.'] : []),
            'Secrets are NOT included: back up secrets/ separately with your password manager.',
            result.database
              ? `Restore: npm run cli -- restore --from "${dest}" --confirm (the database is replaced after the current one is saved; vault, site configs, raw responses, and reports are copied beside the live files, never over them).`
              : 'This backup has no database, so `restore` cannot use it.',
            '',
          ].join('\n'),
          { mode: 0o600 },
        );
        cli.print(g, result, (r: typeof result) =>
          [
            `Backup written to ${r.dir}`,
            `Contains: ${contents.join(', ') || 'nothing'}${missing.length ? ` (not included: ${missing.join(', ')})` : ''}.`,
            ...(r.database ? [`Sites in the database: ${describeSites(r.sites)}.`] : []),
            'Secrets are not included; back them up separately.',
          ].join('\n'),
        );
      }),
    );

  program
    .command('restore')
    .description('Restore the database from a backup (current database is saved first; a demo backup never replaces a live database); vault, config, raw responses, and reports are restored beside, never over, live files')
    .requiredOption('--from <dir>', 'backup directory created by `backup`')
    .option('--confirm', 'required: confirm replacing the live database')
    .option('--force', 'restore even though locks or running jobs are recorded (only when they are stale, e.g. after a crash)')
    .action(
      cli.action(async (opts: { from: string; confirm?: boolean; force?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const paths = cli.requireWorkspace(g);
        const dbBackup = path.join(opts.from, 'seo-agent.sqlite');
        if (!existsSync(dbBackup)) {
          throw new AppError('NOT_FOUND', `${opts.from} contains no database backup (seo-agent.sqlite).`, {
            hint: 'Choose a backup directory whose BACKUP.md lists "database". The live database was not changed.',
          });
        }
        const verified = verifyDatabaseFile(dbBackup);
        const unknown = unknownMigrationsIn(dbBackup);
        if (unknown.length) {
          throw new AppError('MIGRATION_FAILED', `Backup ${dbBackup} was written by a newer application version (unknown migrations: ${unknown.join(', ')}).`, {
            hint: 'Upgrade the application before restoring this backup. The live database was not changed.',
          });
        }
        // Demo/live separation: a backup whose sites do not match the workspace kind is refused,
        // in the preview as well as with --confirm (nothing is changed either way).
        const kind = readManifest(paths)?.kind ?? 'live';
        const sites = databaseSites(dbBackup);
        assertBackupMatchesWorkspace(kind, sites, { backupFile: dbBackup, workspaceRoot: paths.root });
        const siteWarnings = siteDifferences(paths, sites, opts.from);
        const besideParts = BACKUP_PARTS.filter((part) => {
          const src = path.join(opts.from, part);
          return existsSync(src) && readdirSync(src).length > 0;
        });
        const siteLines = (r: { sites: DatabaseSite[]; siteWarnings: string[] }) => [`Sites in the backup: ${describeSites(r.sites)}.`, ...r.siteWarnings.map((w) => `Warning: ${w}`)];
        if (!opts.confirm || g.dryRun) {
          const activity = liveActivity(paths.dbFile);
          const inUse = !!activity && (activity.activeLocks.length > 0 || activity.runningJobs.length > 0);
          cli.print(g, { verified, wouldReplace: paths.dbFile, confirmed: false, dryRun: !!g.dryRun, activity, workspaceKind: kind, sites, siteWarnings, wouldRestoreBeside: besideParts }, (r) =>
            [
              r.dryRun
                ? `Dry run: backup verified (${r.verified.migrations} migrations); would replace ${r.wouldReplace} after saving the current database. Nothing was changed.`
                : `Backup verified (${r.verified.migrations} migrations). Re-run with --confirm to replace ${r.wouldReplace}. The current database will be backed up first.`,
              ...siteLines(r),
              r.wouldRestoreBeside.length ? `Also copied beside the live files (never over them): ${r.wouldRestoreBeside.join(', ')}.` : '',
              inUse ? `Warning: the live database records ${activity!.activeLocks.length} active lock(s) and ${activity!.runningJobs.length} running job(s); restore will refuse until they finish (or --force if they are stale).` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          );
          return;
        }
        const res = restoreDatabase({ backupFile: dbBackup, dbFile: paths.dbFile, backupsDir: paths.backupsDir, force: !!opts.force, workspaceKind: kind });
        const restoredBeside: string[] = [];
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        for (const part of besideParts) {
          const target = path.join(paths.root, `restored-${stamp}`, part);
          cpSync(path.join(opts.from, part), target, { recursive: true, errorOnExist: true, force: false });
          restoredBeside.push(target);
        }
        cli.print(g, { ...res, restoredBeside, workspaceKind: kind, sites, siteWarnings }, (r) =>
          [
            `Database restored from ${r.restoredFrom}.`,
            r.preRestoreBackup ? `Previous database saved to ${r.preRestoreBackup}.` : '',
            r.forcedOver ? `Forced over ${r.forcedOver.activeLocks.length} lock(s) and ${r.forcedOver.runningJobs.length} running job(s) recorded in the previous database.` : '',
            ...siteLines(r),
            r.restoredBeside.length
              ? `Vault, config, raw-response, and report copies restored beside the live files (review and move manually; raw_ref references resolve against data/raw):\n  ${r.restoredBeside.join('\n  ')}`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }),
    );
}
