import { existsSync } from 'node:fs';
import { systemClock, type Clock } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { createLogger, type Logger } from '../core/logger.js';
import { DEFAULT_MODE, type RuntimeMode } from '../core/modes.js';
import { loadSiteConfig, resolveRuntimeSettings, type RuntimeSettings } from '../config/load.js';
import { workspacePaths, type WorkspacePaths } from '../config/paths.js';
import { LayeredSecretStore, type SecretStore } from '../config/secrets.js';
import type { SiteConfig } from '../config/site-schema.js';
import { assertManifestFormatSupported, assertProfileMatchesWorkspace, readManifest } from '../config/workspace.js';
import { BudgetService } from '../budgets/budget-service.js';
import { ProviderRequestLog } from '../budgets/provider-requests.js';
import { openDatabase, type Db } from '../database/db.js';
import { migrate, migrationStatus, type MigrationResult } from '../database/migrate.js';
import { RawStore } from '../database/raw-store.js';
import { ensureSite, siteRegistrationStatus } from '../database/sites.js';
import { offlineFetch, type FetchLike } from '../integrations/types.js';

/**
 * Per-invocation application context for one site. Built by the CLI (and by
 * tests/demo with injected pieces). Modules receive this instead of reaching
 * for globals, so every query/job/budget/retrieval is scoped to `siteId`.
 */
export interface AppContext {
  paths: WorkspacePaths;
  siteId: string;
  config: SiteConfig;
  settings: RuntimeSettings;
  secrets: SecretStore;
  db: Db;
  logger: Logger;
  clock: Clock;
  budgets: BudgetService;
  requests: ProviderRequestLog;
  raw: RawStore;
  /** Network access for provider adapters. `offlineFetch` in demo/offline mode. */
  fetch: FetchLike;
  mode: RuntimeMode;
  dryRun: boolean;
  /** True in demo mode or when --offline: no network requests may be made. */
  offline: boolean;
  /** True when this context operates on synthetic demo data. */
  synthetic: boolean;
  /** Run key for per-run budget caps (job id when running inside a job). */
  runId: string;
}

export interface CreateContextOptions {
  workspaceRoot: string;
  siteId: string;
  config?: SiteConfig;
  secrets?: SecretStore;
  db?: Db;
  logger?: Logger;
  clock?: Clock;
  fetch?: FetchLike;
  mode?: RuntimeMode;
  dryRun?: boolean;
  offline?: boolean;
  runId?: string;
  /** Run pending migrations (with a pre-migration backup). Default true. Ignored when prepareDatabase is 'verify'. */
  migrate?: boolean;
  /**
   * How the database is prepared before use:
   * - 'migrate' (default): apply pending migrations (with a verified backup) and
   *   register/refresh the site row and its configuration version.
   * - 'verify': never write. Fails with MIGRATION_PENDING when the database
   *   has pending migrations, and only reports (via onNotice) when the site is
   *   unregistered or its configuration changed. When the database file does
   *   not exist yet, an empty in-memory database is used instead (nothing is
   *   created on disk). The CLI uses this for --dry-run so a dry run never
   *   creates, migrates, or rewrites the workspace database.
   */
  prepareDatabase?: 'migrate' | 'verify';
  onMigrated?: (r: MigrationResult) => void;
  /** Non-fatal notices about database preparation (e.g. what a dry run did not record). */
  onNotice?: (message: string) => void;
}

export function budgetTimeZone(config: SiteConfig): string {
  return config.reporting.businessTimezone ?? config.scheduler.timezone;
}

export function createAppContext(opts: CreateContextOptions): AppContext {
  const paths = workspacePaths(opts.workspaceRoot);
  const config = opts.config ?? loadSiteConfig(paths, opts.siteId);
  // Demo/live separation is enforced here, before any database is opened or written:
  // a demo-profile site never runs in a live workspace, and a core/full site never
  // runs in a demo workspace. Workspaces without a manifest (library callers) are not checked.
  const manifest = readManifest(paths);
  if (manifest) {
    assertManifestFormatSupported(manifest, paths.root);
    assertProfileMatchesWorkspace(manifest.kind, config.profile, { root: paths.root, siteId: config.site.id });
  }
  const secrets = opts.secrets ?? new LayeredSecretStore(paths.secretsEnvFile);
  const settings = resolveRuntimeSettings(config, secrets);
  const clock = opts.clock ?? systemClock;
  const logger = opts.logger ?? createLogger({ file: `${paths.logsDir}/seo-agent.log`, base: { site: opts.siteId } });
  const ownsDb = !opts.db;
  const verifyOnly = opts.prepareDatabase === 'verify';
  // A dry run must not create the workspace database: when it does not exist yet, plan against
  // an empty, freshly migrated in-memory database that is discarded afterwards.
  const scratch = verifyOnly && ownsDb && !existsSync(paths.dbFile);
  const db = opts.db ?? openDatabase(scratch ? ':memory:' : paths.dbFile);
  const synthetic = config.profile === 'demo';
  try {
    if (scratch) {
      migrate(db);
      ensureSite(db, config, { source: synthetic ? 'demo' : 'file', now: clock.now() });
      opts.onNotice?.(`Dry run: the workspace database ${paths.dbFile} does not exist yet, so this dry run uses an empty temporary database and writes nothing. Run \`npm run cli -- db migrate\` (or \`init\`) to create it.`);
    } else if (verifyOnly) {
      verifyDatabaseReady(db, config, opts.onNotice);
    } else {
      if (opts.migrate !== false) {
        const r = migrate(db, { backupDir: paths.backupsDir, now: clock.now() });
        if (r.applied.length) {
          logger.info(`Applied ${r.applied.length} migration(s)`, { applied: r.applied, backup: r.backupFile });
          opts.onMigrated?.(r);
        }
      }
      ensureSite(db, config, { source: synthetic ? 'demo' : 'file', now: clock.now() });
    }
  } catch (err) {
    // Do not leak a connection we opened when the context cannot be built.
    if (ownsDb) db.close();
    throw err;
  }
  const offline = opts.offline ?? synthetic;
  return {
    paths,
    siteId: config.site.id,
    config,
    settings,
    secrets,
    db,
    logger,
    clock,
    budgets: new BudgetService(db, { limits: settings.budgets, timeZone: budgetTimeZone(config), clock, siteId: config.site.id }),
    requests: new ProviderRequestLog(db, clock),
    raw: new RawStore(paths.rawDir),
    fetch: offline ? offlineFetch : (opts.fetch ?? ((input, init) => fetch(input, init))),
    mode: opts.mode ?? DEFAULT_MODE,
    dryRun: opts.dryRun ?? false,
    offline,
    synthetic,
    runId: opts.runId ?? newId('run'),
  };
}

/**
 * Read-only readiness check used for dry runs: the schema must be current and
 * nothing is written. Site registration drift is reported, not fixed.
 */
function verifyDatabaseReady(db: Db, config: SiteConfig, onNotice?: (message: string) => void): void {
  const status = migrationStatus(db);
  if (status.unknown.length) {
    throw new AppError('MIGRATION_FAILED', `Database contains migrations unknown to this application version: ${status.unknown.join(', ')}.`, {
      hint: 'Upgrade the application; do not downgrade a live workspace.',
    });
  }
  if (status.pending.length) {
    throw new AppError('MIGRATION_PENDING', `The database has ${status.pending.length} pending migration(s) (${status.pending.map((m) => m.name).join(', ')}); --dry-run never changes the database.`, {
      details: { pending: status.pending.map((m) => m.name) },
      hint: 'Run `npm run cli -- db migrate` (a verified backup is written first), then repeat the dry run.',
    });
  }
  const reg = siteRegistrationStatus(db, config);
  if (reg === 'missing') onNotice?.(`Dry run: site "${config.site.id}" is not registered in the database yet; it was not registered (a normal run registers it).`);
  else if (reg === 'changed') onNotice?.(`Dry run: the configuration of site "${config.site.id}" changed since it was last recorded; the new version was not recorded (a normal run records it).`);
}
