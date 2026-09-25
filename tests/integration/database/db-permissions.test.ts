import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, restrictDatabaseFileModes } from '../../../src/database/db.js';
import { loadMigrations, migrate } from '../../../src/database/migrate.js';
import { initWorkspace } from '../../../src/config/workspace.js';
import { workspacePaths } from '../../../src/config/paths.js';

/**
 * B1-10: the workspace database holds analytics, approvals, and the audit
 * log. A file database opened for writing is created 0600 and its
 * -wal/-shm files follow; looser files from older versions are tightened on
 * open. B1-05 (d): migrate() honours a build guard.
 */

const posix = process.platform !== 'win32';
const modeOf = (f: string) => statSync(f).mode & 0o777;

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-dbmode-'));
  temps.push(d);
  return d;
}

describe.skipIf(!posix)('database file modes (POSIX)', () => {
  it('a new database and its WAL/SHM files are created 0600, whatever the umask would give', () => {
    const file = path.join(tempDir(), 'data', 'seo-agent.sqlite');
    const previous = process.umask(0o022);
    const db = openDatabase(file);
    try {
      db.exec('CREATE TABLE t (id INTEGER)');
      db.run('INSERT INTO t (id) VALUES (1)');
      expect(modeOf(file)).toBe(0o600);
      for (const s of ['-wal', '-shm']) if (existsSync(`${file}${s}`)) expect(modeOf(`${file}${s}`), s).toBe(0o600);
      expect(existsSync(`${file}-wal`)).toBe(true);
    } finally {
      db.close();
      process.umask(previous);
    }
  });

  it('an existing 0644 database and its leftover -wal/-shm files are tightened when opened for writing', () => {
    const file = path.join(tempDir(), 'seo-agent.sqlite');
    const first = openDatabase(file);
    first.exec('CREATE TABLE t (id INTEGER)');
    first.close();
    chmodSync(file, 0o644);
    writeFileSync(`${file}-journal`, '');
    chmodSync(`${file}-journal`, 0o664);
    const db = openDatabase(file);
    try {
      expect(modeOf(file)).toBe(0o600);
      expect(modeOf(`${file}-journal`)).toBe(0o600);
      for (const s of ['-wal', '-shm']) if (existsSync(`${file}${s}`)) expect(modeOf(`${file}${s}`), s).toBe(0o600);
    } finally {
      db.close();
    }
  });

  it('a read-only open changes nothing; in-memory databases are untouched; the helper reports what it changed', () => {
    const file = path.join(tempDir(), 'seo-agent.sqlite');
    openDatabase(file).close();
    chmodSync(file, 0o644);
    const ro = openDatabase(file, { readOnly: true });
    ro.close();
    expect(modeOf(file)).toBe(0o644);
    expect(restrictDatabaseFileModes(file)).toEqual([file]);
    expect(restrictDatabaseFileModes(file)).toEqual([]);
    expect(restrictDatabaseFileModes(':memory:')).toEqual([]);
    expect(restrictDatabaseFileModes(file, 'win32')).toEqual([]);
    openDatabase(':memory:').close();
  });

  it('init and the first migration produce a 0600 workspace database', () => {
    const root = path.join(tempDir(), 'workspace');
    initWorkspace(root);
    const paths = workspacePaths(root);
    const db = openDatabase(paths.dbFile);
    try {
      migrate(db, { backupDir: paths.backupsDir });
    } finally {
      db.close();
    }
    expect(modeOf(paths.dbFile)).toBe(0o600);
    expect(modeOf(paths.dataDir)).toBe(0o700);
  });

  it('init warns (and changes nothing) when an existing workspace or data/ folder is readable by others', () => {
    const root = path.join(tempDir(), 'workspace');
    initWorkspace(root);
    const paths = workspacePaths(root);
    chmodSync(root, 0o755);
    chmodSync(paths.dataDir, 0o750);
    const r = initWorkspace(root);
    expect(r.warnings).toEqual(expect.arrayContaining([`${root} is accessible by other users (mode 755); it holds private data such as the database. Run: chmod 700 "${root}"`, expect.stringContaining(`chmod 700 "${paths.dataDir}"`)]));
    expect(modeOf(root)).toBe(0o755);
  });
});

describe('migrate() with an explicit build guard', () => {
  it('refuses pending migrations the build does not know, before writing anything; applies known ones', () => {
    const file = path.join(tempDir(), 'guard.sqlite');
    const all = loadMigrations();
    const db = openDatabase(file);
    try {
      expect(() => migrate(db, { buildGuard: { build: 'the synthetic build v0.0.0', known: all.slice(0, 1).map((m) => m.file) } })).toThrow(
        expect.objectContaining({ code: 'MIGRATION_FAILED', message: expect.stringContaining(`that the synthetic build v0.0.0 was not built with: ${all[1]!.name}`) }),
      );
      expect(db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'schema_migrations'")).toBeUndefined();
      const r = migrate(db, { buildGuard: { build: 'the synthetic build v0.0.1', known: all.map((m) => m.file) } });
      expect(r.applied).toHaveLength(all.length);
      // Nothing pending: the guard is irrelevant.
      expect(migrate(db, { buildGuard: { build: 'x', known: [] } }).applied).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('an in-memory database is never guarded (dry-run scratch databases, doctor)', () => {
    const db = openDatabase(':memory:');
    try {
      expect(migrate(db, { buildGuard: { build: 'x', known: [] } }).applied.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
