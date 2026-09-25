import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../core/errors.js';
import type { Db } from './db.js';

/**
 * Consistent online backup via `VACUUM INTO` (works under WAL while other
 * readers are active). The result is verified with `PRAGMA integrity_check`.
 * Never overwrites an existing backup file.
 */
export function backupDatabase(db: Db, destFile: string): string {
  mkdirSync(path.dirname(destFile), { recursive: true, mode: 0o700 });
  if (existsSync(destFile)) throw new AppError('CONFLICT', `Backup target already exists: ${destFile}`);
  db.raw.prepare('VACUUM INTO ?').run(destFile);
  restrictMode(destFile);
  verifyDatabaseFile(destFile);
  return destFile;
}

/** Backups contain private data: owner read/write only (POSIX). */
function restrictMode(file: string): void {
  if (process.platform !== 'win32' && existsSync(file)) chmodSync(file, 0o600);
}

export interface VerifyResult {
  ok: true;
  migrations: number;
  sizeBytes: number;
}

export function verifyDatabaseFile(file: string): VerifyResult {
  if (!existsSync(file)) throw new AppError('NOT_FOUND', `Database file not found: ${file}`);
  const check = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = check.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
    const first = rows[0] ? Object.values(rows[0])[0] : undefined;
    if (first !== 'ok') throw new AppError('VALIDATION_FAILED', `Integrity check failed for ${file}: ${String(first)}`);
    let migrations = 0;
    try {
      const r = check.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number } | undefined;
      migrations = Number(r?.n ?? 0);
    } catch {
      throw new AppError('VALIDATION_FAILED', `${file} is not a seo-agent database (no schema_migrations table)`);
    }
    return { ok: true, migrations, sizeBytes: statSync(file).size };
  } finally {
    check.close();
  }
}

/** A site recorded in a database file (sites.is_demo = 1: a demo site with synthetic data). */
export interface DatabaseSite {
  id: string;
  isDemo: boolean;
}

/** Sites recorded in a database file, read-only; [] when it has no sites table. */
export function databaseSites(file: string): DatabaseSite[] {
  if (!existsSync(file)) throw new AppError('NOT_FOUND', `Database file not found: ${file}`);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sites'").get()) return [];
    return (db.prepare('SELECT id, is_demo FROM sites ORDER BY id').all() as Array<{ id: string; is_demo: number }>).map((r) => ({ id: r.id, isDemo: r.is_demo === 1 }));
  } finally {
    db.close();
  }
}

/**
 * Sites that do not belong in a workspace of this kind (demo/live separation,
 * spec 29): demo sites (synthetic data) in a live workspace, or live sites in
 * a demo workspace. Empty when everything matches.
 */
export function demoLiveMismatches(kind: 'live' | 'demo', sites: DatabaseSite[]): DatabaseSite[] {
  return sites.filter((s) => (kind === 'live' ? s.isDemo : !s.isDemo));
}

/**
 * Refuse (WORKSPACE_UNSAFE) a backup whose sites do not match the workspace
 * kind: a demo backup never replaces a live database (its synthetic rows would
 * enter live reporting and live account caps), and a live backup never goes
 * into a demo workspace (a demo refresh deletes it). Nothing is changed.
 */
export function assertBackupMatchesWorkspace(kind: 'live' | 'demo', sites: DatabaseSite[], where: { backupFile: string; workspaceRoot?: string }): void {
  const wrong = demoLiveMismatches(kind, sites);
  if (!wrong.length) return;
  const ids = wrong.map((s) => s.id).join(', ');
  const target = where.workspaceRoot ?? 'this workspace';
  if (kind === 'live') {
    throw new AppError('WORKSPACE_UNSAFE', `Backup ${where.backupFile} holds demo site(s) ${ids} (synthetic data), but ${target} is a live workspace. Synthetic demo data never replaces or mixes with live data; the live database was not changed.`, {
      details: { workspaceKind: kind, mismatchedSites: wrong, backupSites: sites },
      hint: 'Choose a backup of this live workspace (its BACKUP.md and `restore --from <dir>` list the sites it holds). A demo backup can only be restored into a demo workspace (`npm run demo` creates one).',
    });
  }
  throw new AppError('WORKSPACE_UNSAFE', `Backup ${where.backupFile} holds live (non-demo) site(s) ${ids}, but ${target} is a demo workspace. Real data never belongs in a demo workspace (a demo refresh deletes it); the database was not changed.`, {
    details: { workspaceKind: kind, mismatchedSites: wrong, backupSites: sites },
    hint: 'Restore it into a live workspace instead: `npm run cli -- --workspace <dir> init`, then `npm run cli -- --workspace <dir> restore --from <backup dir> --confirm`.',
  });
}

export interface DatabaseActivity {
  /** Unexpired site_locks leases (a job or command is working on the site). */
  activeLocks: Array<{ site_id: string; lock_name: string; owner: string; expires_at: string }>;
  /** Jobs recorded as running. A crashed process can leave a stale row; `jobs` commands recover those. */
  runningJobs: Array<{ id: string; site_id: string; type: string; heartbeat_at: string | null }>;
}

/** Read other processes' recorded activity (locks and running jobs) from an open connection. */
export function databaseActivity(raw: DatabaseSync, now: Date = new Date()): DatabaseActivity {
  const has = (table: string) => !!raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return {
    activeLocks: has('site_locks')
      ? (raw.prepare('SELECT site_id, lock_name, owner, expires_at FROM site_locks WHERE expires_at > ? ORDER BY site_id, lock_name').all(now.toISOString()) as DatabaseActivity['activeLocks'])
      : [],
    runningJobs: has('jobs') ? (raw.prepare("SELECT id, site_id, type, heartbeat_at FROM jobs WHERE status = 'running' ORDER BY created_at").all() as DatabaseActivity['runningJobs']) : [],
  };
}

function activityError(activity: DatabaseActivity): AppError {
  const parts = [
    ...activity.activeLocks.map((l) => `lock ${l.site_id}/${l.lock_name} held by ${l.owner} until ${l.expires_at}`),
    ...activity.runningJobs.map((j) => `job ${j.id} (${j.type}, site ${j.site_id}) is running`),
  ];
  return new AppError('LOCKED', `Refusing to restore while the database is in use: ${parts.join('; ')}. Writes made by a running job after the restore would be lost.`, {
    details: { ...activity },
    hint: 'Stop scheduled jobs and running commands, wait for locks to expire, then retry. If these entries are stale (a crashed process), re-run with --force.',
  });
}

/**
 * Restore a backup over the live database file. The caller must have closed
 * its own connections. The current database is first copied to a pre-restore
 * backup so the restore itself is reversible.
 *
 * Refuses (AppError LOCKED) while other work is recorded in the live database
 * (unexpired site_locks or running jobs) unless `force` is set, and holds the
 * database write lock while the pre-restore backup and the replacement copy
 * are made, so no other writer can commit changes that would be lost. The
 * lock is released immediately before the file swap; a process that still
 * has the old file open keeps writing to the replaced file, which is why
 * running work is refused first.
 *
 * With `workspaceKind`, a backup whose sites do not match the workspace kind
 * (demo sites into a live workspace, live sites into a demo workspace) is
 * refused with WORKSPACE_UNSAFE before anything is touched. The `restore`
 * command always passes it.
 */
export function restoreDatabase(opts: { backupFile: string; dbFile: string; backupsDir: string; now?: Date; force?: boolean; workspaceKind?: 'live' | 'demo' }): {
  restoredFrom: string;
  preRestoreBackup: string | null;
  forcedOver: DatabaseActivity | null;
} {
  verifyDatabaseFile(opts.backupFile);
  if (opts.workspaceKind) assertBackupMatchesWorkspace(opts.workspaceKind, databaseSites(opts.backupFile), { backupFile: opts.backupFile });
  const now = opts.now ?? new Date();
  let preRestore: string | null = null;
  let forcedOver: DatabaseActivity | null = null;
  const tmp = `${opts.dbFile}.restore-tmp`;
  const prepareReplacement = () => {
    mkdirSync(path.dirname(opts.dbFile), { recursive: true, mode: 0o700 });
    rmSync(tmp, { force: true });
    try {
      copyFileSync(opts.backupFile, tmp);
      restrictMode(tmp);
      verifyDatabaseFile(tmp);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  };
  if (existsSync(opts.dbFile)) {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    preRestore = path.join(opts.backupsDir, `pre-restore-${stamp}.sqlite`);
    mkdirSync(opts.backupsDir, { recursive: true, mode: 0o700 });
    const lock = new DatabaseSync(opts.dbFile);
    const reader = new DatabaseSync(opts.dbFile);
    try {
      lock.exec('PRAGMA busy_timeout = 5000');
      reader.exec('PRAGMA busy_timeout = 5000');
      reader.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      // Take the write lock first, then check for recorded activity under it (no check-then-act gap).
      lock.exec('BEGIN IMMEDIATE');
      try {
        const activity = databaseActivity(lock, now);
        if (activity.activeLocks.length || activity.runningJobs.length) {
          if (!opts.force) throw activityError(activity);
          forcedOver = activity;
        }
        // WAL readers are not blocked by the write lock: this snapshot includes every committed write.
        reader.prepare('VACUUM INTO ?').run(preRestore);
        restrictMode(preRestore);
        verifyDatabaseFile(preRestore);
        prepareReplacement();
      } finally {
        if (lock.isTransaction) lock.exec('ROLLBACK');
      }
    } finally {
      reader.close();
      lock.close();
    }
  } else {
    prepareReplacement();
  }
  for (const suffix of ['-wal', '-shm']) rmSync(`${opts.dbFile}${suffix}`, { force: true });
  renameSync(tmp, opts.dbFile);
  verifyDatabaseFile(opts.dbFile);
  return { restoredFrom: opts.backupFile, preRestoreBackup: preRestore, forcedOver };
}
