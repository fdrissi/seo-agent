import { chmodSync, closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

/**
 * SQLite access via Node's built-in `node:sqlite` (no native build step).
 * - WAL journal, foreign keys ON, busy timeout for concurrent CLI processes.
 * - Parameterized queries only: callers pass values separately from SQL.
 * - Synchronous transactions (BEGIN IMMEDIATE) with nested savepoints.
 * - The database holds private data (analytics, approvals, audit log): a file
 *   database opened for writing is created with mode 0600, and the file and
 *   its -wal/-shm/-journal companions are tightened to 0600 on every open
 *   (POSIX only; `restore` and backups use 0600 as well).
 */

/** Companion files SQLite keeps next to a database file. */
export const DATABASE_COMPANION_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

function isFileDatabase(file: string): boolean {
  return file !== '' && file !== ':memory:' && !file.startsWith('file:');
}

/**
 * Restrict a database file and its -wal/-shm/-journal companions to owner
 * read/write (0600). Files that do not exist, or that this user may not
 * chmod, are skipped. Returns the files whose mode was changed.
 */
export function restrictDatabaseFileModes(file: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32' || !isFileDatabase(file)) return [];
  const changed: string[] = [];
  for (const p of [file, ...DATABASE_COMPANION_SUFFIXES.map((s) => `${file}${s}`)]) {
    try {
      const st = statSync(p);
      if (!st.isFile() || (st.mode & 0o077) === 0) continue;
      chmodSync(p, 0o600);
      changed.push(p);
    } catch {
      /* missing, or not ours to change: doctor reports the mode */
    }
  }
  return changed;
}

export type SqlParams = readonly unknown[] | Record<string, unknown>;
export type Row = Record<string, unknown>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

function toSqlValue(v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  if (v instanceof Uint8Array) return v;
  if (v instanceof Date) return v.toISOString();
  // Objects/arrays are stored as JSON text.
  return JSON.stringify(v);
}

export class Db {
  readonly raw: DatabaseSync;
  readonly file: string;
  readonly readOnly: boolean;
  private readonly cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(file: string, opts: { readOnly?: boolean } = {}) {
    this.file = file;
    this.readOnly = opts.readOnly ?? false;
    const onDisk = isFileDatabase(file) && !this.readOnly;
    if (file !== ':memory:' && !this.readOnly) mkdirSync(path.dirname(file), { recursive: true });
    if (onDisk && process.platform !== 'win32') {
      // Create a new database file as 0600 before SQLite does (SQLite would create it 0644
      // under the usual umask); SQLite gives its -wal/-shm files the database file's mode.
      try {
        closeSync(openSync(file, 'wx', 0o600));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      restrictDatabaseFileModes(file);
    }
    this.raw = new DatabaseSync(file, { readOnly: opts.readOnly ?? false, enableForeignKeyConstraints: true });
    this.raw.exec('PRAGMA busy_timeout = 5000');
    if (!opts.readOnly && file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    if (!opts.readOnly) this.raw.exec('PRAGMA synchronous = NORMAL');
    // WAL mode may have created (or found older, looser) -wal/-shm files.
    if (onDisk) restrictDatabaseFileModes(file);
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  private bind(params?: SqlParams): SQLInputValue[] | [Record<string, SQLInputValue>] {
    if (params === undefined) return [];
    if (Array.isArray(params)) return params.map(toSqlValue);
    const obj: Record<string, SQLInputValue> = {};
    for (const [k, v] of Object.entries(params)) obj[k] = toSqlValue(v);
    return [obj];
  }

  run(sql: string, params?: SqlParams): RunResult {
    const r = this.stmt(sql).run(...(this.bind(params) as SQLInputValue[]));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Row>(sql: string, params?: SqlParams): T | undefined {
    return this.stmt(sql).get(...(this.bind(params) as SQLInputValue[])) as T | undefined;
  }

  all<T = Row>(sql: string, params?: SqlParams): T[] {
    return this.stmt(sql).all(...(this.bind(params) as SQLInputValue[])) as T[];
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /**
   * Run `fn` atomically. Nested calls use savepoints. `fn` must be synchronous:
   * awaiting inside a SQLite transaction would let unrelated work interleave.
   * An async callback is rejected and everything it wrote before its first
   * `await` is rolled back.
   *
   * The outermost level uses BEGIN IMMEDIATE: the write lock is taken before
   * `fn` reads anything, so check-then-write sequences (budget reservations,
   * locks) are atomic across connections and processes. Other writers wait up
   * to the busy timeout.
   */
  transaction<T>(fn: () => T): T {
    const outer = this.depth === 0;
    const sp = `sp_${this.depth}`;
    this.raw.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    let finished = false;
    try {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        // Avoid an unhandled rejection from the orphaned promise; the caller gets this error instead.
        (result as unknown as Promise<unknown>).then(undefined, () => undefined);
        throw new Error('Db.transaction callback must be synchronous');
      }
      this.raw.exec(outer ? 'COMMIT' : `RELEASE ${sp}`);
      finished = true;
      this.depth--;
      return result;
    } catch (err) {
      if (!finished) {
        this.depth--;
        try {
          this.raw.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
        } catch {
          /* already rolled back */
        }
        // Keep the depth counter consistent with SQLite's view if the outer transaction vanished.
        if (outer || !this.raw.isTransaction) this.depth = 0;
      }
      throw err;
    }
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  close(): void {
    this.cache.clear();
    if (this.raw.isOpen) this.raw.close();
  }
}

export function openDatabase(file: string, opts: { readOnly?: boolean } = {}): Db {
  return new Db(file, opts);
}

/** Serialize a value for a JSON TEXT column (null stays null). */
export function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
