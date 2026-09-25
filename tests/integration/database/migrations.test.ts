import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appDirs, appVersion } from '../../../src/config/paths.js';
import { verifyDatabaseFile } from '../../../src/database/backup.js';
import { openDatabase, type Db } from '../../../src/database/db.js';
import { loadMigrations, migrate, migrationStatus } from '../../../src/database/migrate.js';

let dir: string;
let migDir: string;
let backupDir: string;
const dbs: Db[] = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-mig-'));
  migDir = path.join(dir, 'migrations');
  backupDir = path.join(dir, 'backups');
  mkdirSync(migDir);
});
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  rmSync(dir, { recursive: true, force: true });
});
const open = (name = 'db.sqlite') => {
  const d = openDatabase(path.join(dir, name));
  dbs.push(d);
  return d;
};
const writeMig = (file: string, sql: string) => writeFileSync(path.join(migDir, file), sql);

describe('application migrations', () => {
  it('apply cleanly to a fresh database with foreign keys intact, then report nothing pending', () => {
    const db = open();
    const files = loadMigrations();
    expect(files.length).toBeGreaterThanOrEqual(9);
    expect(files.map((f) => f.version)).toEqual([...files.map((f) => f.version)].sort());
    const r = migrate(db, { backupDir, now: new Date('2026-09-24T09:00:00Z') });
    expect(r.applied).toEqual(files.map((f) => f.name));
    expect(r.backupFile).toBeNull(); // fresh database: nothing to back up
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations')!.n).toBe(files.length);
    expect(db.get<{ app_version: string }>('SELECT app_version FROM schema_migrations LIMIT 1')!.app_version).toBe(appVersion());
    for (const t of ['sites', 'audit_events', 'budget_reservations', 'cost_ledger', 'provider_requests', 'gsc_property_daily', 'reports']) {
      expect(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).toBeDefined();
    }
    const again = migrate(db, { backupDir });
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toHaveLength(files.length);
    expect(existsSync(backupDir)).toBe(false);
  });

  it('every migration file is checksummed and uses the NNNN_name.sql convention', () => {
    const names = readdirSync(appDirs.migrations()).filter((f) => f.endsWith('.sql'));
    expect(names.every((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))).toBe(true);
    for (const m of loadMigrations()) expect(m.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('migration safety', () => {
  it('detects a migration edited after it was applied (checksum mismatch)', () => {
    writeMig('0001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    const db = open();
    migrate(db, { dir: migDir });
    appendFileSync(path.join(migDir, '0001_init.sql'), '\n-- sneaky edit\n');
    expect(() => migrationStatus(db, migDir)).toThrow(expect.objectContaining({ code: 'MIGRATION_FAILED', message: expect.stringContaining('checksum mismatch') }));
    expect(() => migrate(db, { dir: migDir })).toThrow(/checksum mismatch/);
  });

  it('refuses a database that contains migrations unknown to this application (newer version)', () => {
    writeMig('0001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    const db = open();
    migrate(db, { dir: migDir });
    db.run("INSERT INTO schema_migrations (version, name, checksum, applied_at, app_version) VALUES ('9999', '9999_from_the_future', 'x', '2027-01-01T00:00:00Z', '9.9.9')");
    expect(migrationStatus(db, migDir).unknown).toEqual(['9999_from_the_future']);
    writeMig('0002_next.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);');
    expect(() => migrate(db, { dir: migDir })).toThrow(expect.objectContaining({ code: 'MIGRATION_FAILED', message: expect.stringContaining('unknown to this application') }));
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'b'")).toBeUndefined();
  });

  it('writes a verified pre-migration backup before applying pending migrations to a non-empty database', () => {
    writeMig('0001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT);');
    const db = open();
    migrate(db, { dir: migDir, backupDir });
    db.run('INSERT INTO a (v) VALUES (?)', ['precious']);
    writeMig('0002_add.sql', 'ALTER TABLE a ADD COLUMN w TEXT;');
    const r = migrate(db, { dir: migDir, backupDir, now: new Date('2026-09-24T09:00:00Z') });
    expect(r.applied).toEqual(['0002_add']);
    expect(r.backupFile).toBe(path.join(backupDir, 'pre-migration-2026-09-24T09-00-00-000Z.sqlite'));
    expect(verifyDatabaseFile(r.backupFile!).migrations).toBe(1);
    const snap = openDatabase(r.backupFile!, { readOnly: true });
    dbs.push(snap);
    expect(snap.all('SELECT v FROM a')).toEqual([{ v: 'precious' }]);
    expect(snap.all("SELECT name FROM pragma_table_info('a')").map((c) => (c as { name: string }).name)).toEqual(['id', 'v']);
  });

  it('rolls back a failing migration atomically and points to the backup', () => {
    writeMig('0001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    const db = open();
    migrate(db, { dir: migDir, backupDir });
    writeMig('0002_broken.sql', 'CREATE TABLE half_done (id INTEGER); INSERT INTO no_such_table VALUES (1);');
    try {
      migrate(db, { dir: migDir, backupDir });
      throw new Error('expected failure');
    } catch (err) {
      expect(err).toMatchObject({ code: 'MIGRATION_FAILED' });
      expect((err as { hint?: string }).hint).toContain('pre-migration backup');
    }
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'half_done'")).toBeUndefined();
    expect(migrationStatus(db, migDir).pending.map((p) => p.name)).toEqual(['0002_broken']);
  });

  it('rejects duplicate migration versions and ignores non-migration files', () => {
    writeMig('0001_a.sql', 'SELECT 1;');
    writeMig('README.md', 'not sql');
    writeMig('01_short.sql', 'SELECT 1;');
    expect(loadMigrations(migDir).map((m) => m.file)).toEqual(['0001_a.sql']);
    writeMig('0001_b.sql', 'SELECT 1;');
    expect(() => loadMigrations(migDir)).toThrow(/Duplicate migration version 0001/);
    expect(loadMigrations(path.join(dir, 'missing'))).toEqual([]);
  });

  it('two processes migrating at once: a migration applied by the other connection is skipped, not re-run', () => {
    writeMig('0001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    writeMig('0002_next.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);');
    const a = open();
    const b = open(); // same file, second connection (stands in for a second process)
    // B computes its pending list, then A commits everything before B takes the write lock.
    const originalTransaction = b.transaction.bind(b);
    let raced = false;
    b.transaction = (<T>(fn: () => T): T => {
      if (!raced) {
        raced = true;
        expect(migrate(a, { dir: migDir, backupDir }).applied).toEqual(['0001_init', '0002_next']);
      }
      return originalTransaction(fn);
    }) as typeof b.transaction;
    const r = migrate(b, { dir: migDir, backupDir });
    expect(raced).toBe(true);
    expect(r.applied).toEqual([]);
    expect(r.alreadyApplied).toEqual(['0001_init', '0002_next']);
    expect(b.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations')!.n).toBe(2);
  });

  it('two processes migrating at once: they interleave per migration, each applied exactly once, in order', () => {
    writeMig('0001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    const a = open();
    const b = open();
    migrate(a, { dir: migDir, backupDir });
    writeMig('0002_next.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);');
    writeMig('0003_last.sql', 'CREATE TABLE c (id INTEGER PRIMARY KEY);');
    // A applies 0002 between B's status read and B's first transaction; B then applies only 0003.
    const originalTransaction = b.transaction.bind(b);
    let raced = false;
    b.transaction = (<T>(fn: () => T): T => {
      if (!raced) {
        raced = true;
        const originalA = a.transaction.bind(a);
        let first = true;
        // Let A apply only its first pending migration, then stop (as if it were still running).
        a.transaction = (<U>(f: () => U): U => {
          if (!first) throw new Error('synthetic: A paused');
          first = false;
          return originalA(f);
        }) as typeof a.transaction;
        expect(() => migrate(a, { dir: migDir, backupDir, now: new Date('2026-09-24T09:00:00Z') })).toThrow(/A paused/);
        a.transaction = originalA as typeof a.transaction;
      }
      return originalTransaction(fn);
    }) as typeof b.transaction;
    const r = migrate(b, { dir: migDir, backupDir, now: new Date('2026-09-24T09:00:00Z') });
    expect(r.applied).toEqual(['0003_last']);
    expect(r.alreadyApplied).toContain('0002_next');
    expect(b.all<{ version: string }>('SELECT version FROM schema_migrations ORDER BY applied_at, version').map((x) => x.version)).toEqual(['0001', '0002', '0003']);
    // Both processes wrote a pre-migration backup stamped with the same instant without colliding.
    const backups = readdirSync(backupDir).filter((f) => f.startsWith('pre-migration-2026-09-24T09-00-00-000Z'));
    expect(backups).toHaveLength(2);
    expect(backups).toContain('pre-migration-2026-09-24T09-00-00-000Z.sqlite');
    for (const f of backups) expect(verifyDatabaseFile(path.join(backupDir, f)).ok).toBe(true);
  });

  it('migrationStatus is read-only (safe on read-only connections, never creates tables)', () => {
    writeMig('0001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    const rw = open();
    rw.exec('CREATE TABLE unrelated (x)');
    const ro = openDatabase(rw.file, { readOnly: true });
    dbs.push(ro);
    expect(migrationStatus(ro, migDir)).toMatchObject({ applied: [], unknown: [] });
    expect(migrationStatus(ro, migDir).pending.map((p) => p.name)).toEqual(['0001_init']);
    expect(rw.get("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'")).toBeUndefined();
  });
});
