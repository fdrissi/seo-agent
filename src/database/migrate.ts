import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import { appDirs, appVersion } from '../config/paths.js';
import { MIGRATION_FILE_RE, REBUILD_STEPS, runningBuildMigrationGuard, type BuildMigrationGuard } from '../setup/build-info.js';
import { backupDatabase } from './backup.js';
import type { Db } from './db.js';

/**
 * Forward-only, checksummed migrations from `migrations/NNNN_name.sql`.
 * - Applied migrations must not be edited (checksum mismatch aborts).
 * - A database containing migrations unknown to this application version is
 *   refused (never "downgrade" a live workspace).
 * - Before applying pending migrations to a non-empty database, a verified
 *   pre-migration backup is written.
 * - Safe when several processes migrate at once: each migration re-checks
 *   schema_migrations inside its own BEGIN IMMEDIATE transaction and is
 *   skipped when another process already applied it.
 * - A compiled build (dist/) applies only the migrations it was stamped with
 *   (dist/build-info.json, written by `npm run build`): an older build left in
 *   place after an upgrade never silently applies migrations it does not know.
 */

export interface MigrationFile {
  version: string;
  name: string;
  file: string;
  sql: string;
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
  backupFile: string | null;
}

export function loadMigrations(dir: string = appDirs.migrations()): MigrationFile[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => MIGRATION_FILE_RE.test(f))
    .sort();
  const seen = new Set<string>();
  return files.map((f) => {
    const version = f.slice(0, 4);
    if (seen.has(version)) throw new AppError('MIGRATION_FAILED', `Duplicate migration version ${version}`);
    seen.add(version);
    const sql = readFileSync(path.join(dir, f), 'utf8');
    return { version, name: f.replace(/\.sql$/, ''), file: f, sql, checksum: sha256(sql) };
  });
}

function ensureTable(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    app_version TEXT NOT NULL
  )`);
}

function hasTable(db: Db): boolean {
  return !!db.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'");
}

/**
 * Compare applied migrations with the application's migration files. Read-only:
 * safe on read-only connections and never creates the tracking table.
 */
export function migrationStatus(db: Db, dir?: string): { pending: MigrationFile[]; applied: Array<{ version: string; name: string; checksum: string }>; unknown: string[] } {
  const files = loadMigrations(dir);
  const applied = hasTable(db) ? db.all<{ version: string; name: string; checksum: string }>('SELECT version, name, checksum FROM schema_migrations ORDER BY version') : [];
  const appliedSet = new Map(applied.map((a) => [a.version, a]));
  const fileSet = new Set(files.map((f) => f.version));
  for (const f of files) {
    const a = appliedSet.get(f.version);
    if (a && a.checksum !== f.checksum) {
      throw new AppError('MIGRATION_FAILED', `Migration ${f.file} was modified after being applied (checksum mismatch). Add a new migration instead.`);
    }
  }
  return {
    pending: files.filter((f) => !appliedSet.has(f.version)),
    applied,
    unknown: applied.filter((a) => !fileSet.has(a.version)).map((a) => a.name),
  };
}

export interface MigrateOptions {
  dir?: string;
  backupDir?: string;
  now?: Date;
  /**
   * The migrations the running build may apply. Default: the running compiled
   * build's stamp (null = no restriction when running from the TypeScript
   * sources). Not applied to in-memory databases.
   */
  buildGuard?: BuildMigrationGuard | null;
}

/** Pending migrations a compiled build was not stamped with: refuse before anything (even a backup) is written. */
function assertBuildKnowsPending(db: Db, pending: MigrationFile[], guard: BuildMigrationGuard | null): void {
  if (!guard || db.file === ':memory:') return;
  const known = new Set(guard.known);
  const unknownToBuild = pending.filter((m) => !known.has(m.file));
  if (!unknownToBuild.length) return;
  const names = unknownToBuild.map((m) => m.name);
  throw new AppError(
    'MIGRATION_FAILED',
    `Refusing to apply ${names.length} pending migration(s) that ${guard.build} was not built with: ${names.join(', ')}. The compiled code predates them (or cannot show otherwise), so applying them now could leave the database ahead of the code that uses it. No migration was applied.`,
    // A packaged install (no src/) cannot run `npm run build`: the guard says to reinstall or upgrade instead.
    { hint: guard.hint ?? REBUILD_STEPS, details: { unknownToBuild: names, build: guard.build } },
  );
}

export function migrate(db: Db, opts: MigrateOptions = {}): MigrationResult {
  // migrationStatus is read-only (it tolerates a missing tracking table), so the
  // checks below refuse before anything is written.
  const status = migrationStatus(db, opts.dir);
  if (status.unknown.length) {
    throw new AppError('MIGRATION_FAILED', `Database contains migrations unknown to this application version: ${status.unknown.join(', ')}. Upgrade the application; do not downgrade a live workspace.`);
  }
  const result: MigrationResult = { applied: [], alreadyApplied: status.applied.map((a) => a.name), backupFile: null };
  if (status.pending.length) assertBuildKnowsPending(db, status.pending, opts.buildGuard === undefined ? runningBuildMigrationGuard() : opts.buildGuard);
  ensureTable(db);
  if (status.pending.length === 0) return result;

  const hasData = status.applied.length > 0;
  if (hasData && opts.backupDir && db.file !== ':memory:') {
    const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
    let target = path.join(opts.backupDir, `pre-migration-${stamp}.sqlite`);
    // Two processes upgrading at the same instant must not collide on the backup name.
    if (existsSync(target)) target = path.join(opts.backupDir, `pre-migration-${stamp}-${process.pid}-${randomBytes(3).toString('hex')}.sqlite`);
    result.backupFile = backupDatabase(db, target);
  }

  for (const m of status.pending) {
    try {
      // The pending list was computed before the write lock was taken: another
      // process (a scheduled job started together with a manual command) may have
      // applied this migration meanwhile. Re-check under BEGIN IMMEDIATE.
      const applied = db.transaction(() => {
        const done = db.get<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE version = ?', [m.version]);
        if (done) {
          if (done.checksum !== m.checksum) {
            throw new AppError('MIGRATION_FAILED', `Migration ${m.file} was applied concurrently with a different checksum. Add a new migration instead of editing one.`);
          }
          return false;
        }
        db.exec(m.sql);
        db.run('INSERT INTO schema_migrations (version, name, checksum, applied_at, app_version) VALUES (?, ?, ?, ?, ?)', [
          m.version,
          m.name,
          m.checksum,
          new Date().toISOString(),
          appVersion(),
        ]);
        return true;
      });
      if (applied) result.applied.push(m.name);
      else result.alreadyApplied.push(m.name);
    } catch (err) {
      if (err instanceof AppError && err.code === 'MIGRATION_FAILED') throw err;
      throw new AppError('MIGRATION_FAILED', `Migration ${m.file} failed: ${(err as Error).message}`, {
        cause: err,
        hint: result.backupFile ? `A pre-migration backup was written to ${result.backupFile}. See docs/UPGRADING.md for recovery.` : undefined,
      });
    }
  }
  const fk = db.all('PRAGMA foreign_key_check');
  if (fk.length) throw new AppError('MIGRATION_FAILED', `Foreign key check failed after migration (${fk.length} violations)`);
  return result;
}
