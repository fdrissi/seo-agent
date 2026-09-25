import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { listSiteIds } from '../../config/load.js';
import { manifestPathOverrides, resolveWorkspaceDir, workspacePaths } from '../../config/paths.js';
import { WORKSPACE_FORMAT_VERSION, initWorkspace, readManifest } from '../../config/workspace.js';
import { openDatabase } from '../../database/db.js';
import { loadMigrations, migrate, migrationStatus } from '../../database/migrate.js';
import type { CliRuntime } from '../runtime.js';

export function register(program: Command, cli: CliRuntime): void {
  program
    .command('init')
    .description('Create a private workspace (never overwrites existing files; safe to re-run)')
    .option('--allow-inside-repo', 'allow a workspace inside the application repository (not recommended)')
    .option('--allow-existing-dir', 'allow a non-empty directory without workspace.json (the layout is added next to the existing files; nothing is overwritten)')
    .action(
      cli.action(async (opts: { allowInsideRepo?: boolean; allowExistingDir?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const root = resolveWorkspaceDir(g.workspace, cli.env);
        const dryRun = !!g.dryRun;
        // Refuses the filesystem root, the home directory, and the temp directory itself; a non-empty
        // directory without workspace.json needs --allow-existing-dir.
        const result = initWorkspace(root, { allowInsideRepo: !!opts.allowInsideRepo, allowExistingDir: !!opts.allowExistingDir, dryRun, env: cli.env });
        const paths = workspacePaths(root);
        let migrated: string[] = [];
        let pendingMigrations: string[] = [];
        let backupFile: string | null = null;
        if (dryRun) {
          if (existsSync(paths.dbFile)) {
            const db = openDatabase(paths.dbFile, { readOnly: true });
            try {
              pendingMigrations = migrationStatus(db).pending.map((m) => m.name);
            } finally {
              db.close();
            }
          } else pendingMigrations = loadMigrations().map((m) => m.name);
        } else {
          const db = openDatabase(paths.dbFile);
          try {
            const r = migrate(db, { backupDir: paths.backupsDir });
            migrated = r.applied;
            backupFile = r.backupFile;
          } finally {
            db.close();
          }
        }
        // Only point at commands this build actually provides.
        const available = new Set((cmd.parent?.commands ?? []).map((c) => c.name()));
        const nextSteps = [
          available.has('setup')
            ? 'npm run cli -- setup            # create your site configuration (resumable wizard)'
            : `Copy config/sites/example.site.yaml to ${paths.sitesDir}/<site-id>.yaml, edit it, then run: npm run cli -- config validate`,
          'Put credentials in secrets/secrets.env (never in chat or the vault); see docs/ACCESS_SETUP.md',
          available.has('doctor')
            ? 'npm run cli -- doctor           # verify configuration without spending money'
            : 'npm run cli -- config show      # effective settings and their sources (no network, no spending)',
        ];
        cli.print(g, { ...result, dryRun, migrationsApplied: migrated, pendingMigrations, preMigrationBackup: backupFile, nextSteps }, (r) =>
          [
            `Workspace: ${r.root}${dryRun ? ' (dry run: nothing was written)' : ''}`,
            dryRun
              ? `Would create ${r.created.length} item(s); ${r.existing.length} existing item(s) would be left untouched.`
              : `Created ${r.created.length} item(s); left ${r.existing.length} existing item(s) untouched.`,
            dryRun
              ? pendingMigrations.length
                ? `Would apply ${pendingMigrations.length} database migration(s).`
                : 'Database already up to date.'
              : migrated.length
                ? `Database initialized (${migrated.length} migrations).${backupFile ? ` Pre-migration backup: ${backupFile}` : ''}`
                : 'Database already up to date.',
            ...r.warnings.map((w: string) => `Warning: ${w}`),
            '',
            'Next steps:',
            ...nextSteps.map((step, i) => `  ${i + 1}. ${step}`),
          ].join('\n'),
        );
      }),
    );

  const ws = program.command('workspace').description('Workspace information');
  ws.command('status')
    .description('Show workspace location, sites, and schema status (read-only)')
    .action(
      cli.action(async (_opts: unknown, cmd: Command) => {
        const g = cli.globals(cmd);
        const paths = cli.workspace(g);
        const manifest = readManifest(paths);
        let schema: { applied: number; pending: string[]; unknown: string[] } | null = null;
        if (manifest && existsSync(paths.dbFile)) {
          const db = openDatabase(paths.dbFile, { readOnly: true });
          try {
            const s = migrationStatus(db);
            schema = { applied: s.applied.length, pending: s.pending.map((p) => p.name), unknown: s.unknown };
          } finally {
            db.close();
          }
        }
        // A workspace written by a newer application is reported, and every other command refuses it.
        const formatSupported = !manifest || manifest.formatVersion <= WORKSPACE_FORMAT_VERSION;
        const relocated = manifest ? manifestPathOverrides(paths.root) : {};
        const result = { root: paths.root, exists: !!manifest, manifest, formatSupported, supportedFormatVersion: WORKSPACE_FORMAT_VERSION, sites: manifest ? listSiteIds(paths) : [], schema, relocated };
        cli.print(g, result, (r) =>
          r.exists
            ? [
                `Workspace: ${r.root}`,
                r.formatSupported
                  ? ''
                  : `UNSUPPORTED: workspace format ${r.manifest.formatVersion} is newer than this application supports (${r.supportedFormatVersion}). Upgrade the application; other commands refuse this workspace.`,
                r.manifest.formatVersion < r.supportedFormatVersion
                  ? `OLDER FORMAT: workspace format ${r.manifest.formatVersion}; this application uses ${r.supportedFormatVersion}. Run \`npm run cli -- config migrate\` to review the upgrade.`
                  : '',
                `Kind: ${r.manifest.kind}`,
                ...Object.entries(r.relocated as Record<string, string>).map(([k, v]) => `Relocated (workspace.json paths.${k}): ${v}`),
                `Sites: ${r.sites.join(', ') || '(none)'}`,
                `Schema: ${r.schema ? `${r.schema.applied} applied, ${r.schema.pending.length} pending${r.schema.unknown.length ? `, ${r.schema.unknown.length} UNKNOWN (database is newer than this application)` : ''}` : 'no database yet'}`,
              ]
                .filter(Boolean)
                .join('\n')
            : `No workspace at ${r.root}. Run: npm run cli -- init`,
        );
      }),
    );
}
