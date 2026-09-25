import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { planWorkspaceConfigMigrations } from '../../config/config-migrations.js';
import type { WorkspacePaths } from '../../config/paths.js';
import { openDatabase } from '../../database/db.js';
import { loadMigrations, migrate, migrationStatus } from '../../database/migrate.js';
import type { CliRuntime } from '../runtime.js';

/**
 * Site configs and workspace.json at another format version (read-only; never migrated here).
 * Empty when everything is current, so the command's output is unchanged in the usual case.
 */
function outdatedConfigFiles(paths: WorkspacePaths): Array<{ file: string; kind: string; status: string; fromVersion: number | null; toVersion: number }> {
  try {
    return planWorkspaceConfigMigrations(paths)
      .filter((p) => p.fromVersion !== null && p.fromVersion !== p.toVersion)
      .map((p) => ({ file: p.file, kind: p.kind, status: p.status, fromVersion: p.fromVersion, toVersion: p.toVersion }));
  } catch {
    return [];
  }
}

function configMigrationLines(pending: ReturnType<typeof outdatedConfigFiles>): string[] {
  if (!pending.length) return [];
  return [
    `Configuration migrations pending (not applied by db migrate): ${pending.map((p) => `${p.file} (${p.fromVersion} -> ${p.toVersion}${p.status === 'pending' ? '' : `, ${p.status}`})`).join(', ')}`,
    'Review them with: npm run cli -- config migrate   (shows a diff; --yes applies after a backup)',
  ];
}

export function register(program: Command, cli: CliRuntime): void {
  const db = program.command('db').description('Database schema status and migrations');
  db.command('status')
    .description('Show applied and pending migrations (read-only)')
    .action(
      cli.action(async (_o: unknown, cmd: Command) => {
        const g = cli.globals(cmd);
        const paths = cli.requireWorkspace(g);
        const render = (r: { database: string; applied: string[]; pending: string[]; unknown: string[] }) =>
          [
            r.database === 'missing' ? 'Database: not created yet (run `npm run cli -- init` or `db migrate`)' : '',
            `Applied: ${r.applied.length}`,
            `Pending: ${r.pending.join(', ') || 'none'}`,
            r.unknown.length ? `UNKNOWN (database newer than app): ${r.unknown.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('\n');
        if (!existsSync(paths.dbFile)) {
          cli.print(g, { database: 'missing', applied: [], pending: loadMigrations().map((m) => m.name), unknown: [] }, render);
          return;
        }
        const d = openDatabase(paths.dbFile, { readOnly: true });
        try {
          const s = migrationStatus(d);
          cli.print(g, { database: 'present', applied: s.applied.map((a) => a.name), pending: s.pending.map((p) => p.name), unknown: s.unknown }, render);
        } finally {
          d.close();
        }
      }),
    );
  db.command('migrate')
    .description('Apply pending migrations (a verified pre-migration backup is written first); --dry-run lists them')
    .action(
      cli.action(async (_o: unknown, cmd: Command) => {
        const g = cli.globals(cmd);
        const paths = cli.requireWorkspace(g);
        if (g.dryRun) {
          let pending = loadMigrations().map((m) => m.name);
          let unknown: string[] = [];
          if (existsSync(paths.dbFile)) {
            const ro = openDatabase(paths.dbFile, { readOnly: true });
            try {
              const s = migrationStatus(ro);
              pending = s.pending.map((m) => m.name);
              unknown = s.unknown;
            } finally {
              ro.close();
            }
          }
          const pendingConfig = outdatedConfigFiles(paths);
          cli.print(g, { dryRun: true, wouldApply: pending, unknown, ...(pendingConfig.length ? { pendingConfigMigrations: pendingConfig } : {}) }, (x) =>
            [
              x.wouldApply.length ? `Would apply: ${x.wouldApply.join(', ')}` : 'Up to date.',
              x.unknown.length ? `UNKNOWN (database newer than app): ${x.unknown.join(', ')}` : '',
              ...configMigrationLines(pendingConfig),
            ]
              .filter(Boolean)
              .join('\n'),
          );
          return;
        }
        const d = openDatabase(paths.dbFile);
        try {
          const r = migrate(d, { backupDir: paths.backupsDir });
          // Configuration files are only reported here (read-only); `config migrate` changes them.
          const pendingConfig = outdatedConfigFiles(paths);
          cli.print(g, { ...r, ...(pendingConfig.length ? { pendingConfigMigrations: pendingConfig } : {}) }, (x) =>
            [x.applied.length ? `Applied: ${x.applied.join(', ')}${x.backupFile ? `\nBackup: ${x.backupFile}` : ''}` : 'Up to date.', ...configMigrationLines(pendingConfig)].join('\n'),
          );
        } finally {
          d.close();
        }
      }),
    );
}
