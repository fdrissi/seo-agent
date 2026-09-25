import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Db, json, openDatabase, parseJson } from '../../../src/database/db.js';

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-db-'));
  db = openDatabase(path.join(dir, 'nested', 'test.sqlite'));
  db.exec(`CREATE TABLE parent (id TEXT PRIMARY KEY);
           CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id), v TEXT);
           CREATE TABLE kv (k TEXT PRIMARY KEY, v)`);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const count = (table: string) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;

describe('Db connection settings', () => {
  it('enables foreign keys, WAL, and a busy timeout; creates parent directories', () => {
    expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')!.foreign_keys).toBe(1);
    expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')!.journal_mode).toBe('wal');
    expect(db.get<{ timeout: number }>('PRAGMA busy_timeout')!.timeout).toBe(5000);
    expect(() => db.run('INSERT INTO child (parent_id) VALUES (?)', ['missing'])).toThrow(/FOREIGN KEY/);
    expect(db.readOnly).toBe(false);
  });

  it('read-only connections cannot write', () => {
    db.run('INSERT INTO parent (id) VALUES (?)', ['p1']);
    const ro = openDatabase(db.file, { readOnly: true });
    try {
      expect(ro.readOnly).toBe(true);
      expect(ro.get<{ n: number }>('SELECT COUNT(*) AS n FROM parent')!.n).toBe(1);
      expect(() => ro.run('INSERT INTO parent (id) VALUES (?)', ['p2'])).toThrow(/readonly/i);
    } finally {
      ro.close();
    }
  });
});

describe('parameter binding (parameterized SQL only)', () => {
  it('converts booleans, dates, objects, and undefined; supports named params', () => {
    db.run('INSERT INTO kv (k, v) VALUES (?, ?)', ['bool', true]);
    db.run('INSERT INTO kv (k, v) VALUES (?, ?)', ['date', new Date('2026-09-24T00:00:00Z')]);
    db.run('INSERT INTO kv (k, v) VALUES (?, ?)', ['obj', { a: [1, 2] }]);
    db.run('INSERT INTO kv (k, v) VALUES (?, ?)', ['undef', undefined]);
    db.run('INSERT INTO kv (k, v) VALUES (:k, :v)', { k: 'named', v: 42 });
    const rows = Object.fromEntries(db.all<{ k: string; v: unknown }>('SELECT k, v FROM kv').map((r) => [r.k, r.v]));
    expect(rows).toEqual({ bool: 1, date: '2026-09-24T00:00:00.000Z', obj: '{"a":[1,2]}', undef: null, named: 42 });
  });

  it('treats injected SQL as data', () => {
    const evil = "x'); DROP TABLE kv; --";
    db.run('INSERT INTO kv (k, v) VALUES (?, ?)', [evil, 1]);
    expect(db.get<{ k: string }>('SELECT k FROM kv WHERE k = ?', [evil])!.k).toBe(evil);
    expect(count('kv')).toBe(1);
  });

  it('run returns changes and lastInsertRowid as numbers', () => {
    db.run('INSERT INTO parent (id) VALUES (?)', ['p']);
    const r = db.run('INSERT INTO child (parent_id, v) VALUES (?, ?)', ['p', 'x']);
    expect(r).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(db.run('UPDATE child SET v = ? WHERE parent_id = ?', ['y', 'none']).changes).toBe(0);
  });
});

describe('transactions', () => {
  it('commits on success and rolls back everything on error', () => {
    db.transaction(() => db.run('INSERT INTO parent (id) VALUES (?)', ['ok']));
    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO parent (id) VALUES (?)', ['rolled-back']);
        throw new Error('fail after write');
      }),
    ).toThrow('fail after write');
    expect(db.all('SELECT id FROM parent')).toEqual([{ id: 'ok' }]);
    expect(db.inTransaction).toBe(false);
  });

  it('nested calls use savepoints: an inner failure rolls back only the inner work', () => {
    const result = db.transaction(() => {
      db.run('INSERT INTO parent (id) VALUES (?)', ['outer']);
      expect(db.inTransaction).toBe(true);
      try {
        db.transaction(() => {
          db.run('INSERT INTO parent (id) VALUES (?)', ['inner']);
          db.transaction(() => db.run('INSERT INTO parent (id) VALUES (?)', ['inner-inner']));
          throw new Error('inner failed');
        });
      } catch {
        /* handled by the outer transaction */
      }
      db.transaction(() => db.run('INSERT INTO parent (id) VALUES (?)', ['inner-ok']));
      return 'done';
    });
    expect(result).toBe('done');
    expect(db.all<{ id: string }>('SELECT id FROM parent ORDER BY id').map((r) => r.id)).toEqual(['inner-ok', 'outer']);
  });

  it('an outer failure rolls back committed savepoints too', () => {
    expect(() =>
      db.transaction(() => {
        db.transaction(() => db.run('INSERT INTO parent (id) VALUES (?)', ['sp']));
        throw new Error('outer failed');
      }),
    ).toThrow('outer failed');
    expect(count('parent')).toBe(0);
  });

  it('rejects async callbacks and rolls back their synchronous writes', async () => {
    let lateWriteError: unknown;
    expect(() =>
      db.transaction((async () => {
        db.run('INSERT INTO parent (id) VALUES (?)', ['before-await']);
        await Promise.resolve();
        try {
          db.run('INSERT INTO parent (id) VALUES (?)', ['after-await']);
        } catch (err) {
          lateWriteError = err;
        }
      }) as unknown as () => void),
    ).toThrow('Db.transaction callback must be synchronous');
    await new Promise((r) => setTimeout(r, 5));
    expect(db.all('SELECT id FROM parent WHERE id = ?', ['before-await'])).toEqual([]);
    expect(db.inTransaction).toBe(false);
    void lateWriteError; // the orphaned continuation is outside any transaction; it must not crash the process
  });

  it('keeps its depth consistent when COMMIT itself fails (deferred constraint)', () => {
    expect(() =>
      db.transaction(() => {
        db.exec('PRAGMA defer_foreign_keys = ON');
        db.run('INSERT INTO child (parent_id, v) VALUES (?, ?)', ['ghost', 'x']);
      }),
    ).toThrow(/FOREIGN KEY/);
    expect(db.inTransaction).toBe(false);
    expect(db.raw.isTransaction).toBe(false);
    expect(count('child')).toBe(0);
    // A following transaction must start a real transaction, not a savepoint.
    db.transaction(() => db.run('INSERT INTO parent (id) VALUES (?)', ['after']));
    expect(count('parent')).toBe(1);
    expect(db.raw.isTransaction).toBe(false);
  });

  it('uses BEGIN IMMEDIATE: a second connection cannot write while a transaction is open', () => {
    const other = openDatabase(db.file);
    try {
      other.exec('PRAGMA busy_timeout = 50');
      db.transaction(() => {
        db.run('INSERT INTO parent (id) VALUES (?)', ['locked']);
        expect(() => other.run('INSERT INTO parent (id) VALUES (?)', ['blocked'])).toThrow(/locked|busy/i);
        expect(() => other.transaction(() => 1)).toThrow(/locked|busy/i);
        // WAL readers still see the last committed state.
        expect(other.get<{ n: number }>('SELECT COUNT(*) AS n FROM parent')!.n).toBe(0);
      });
      expect(other.get<{ n: number }>('SELECT COUNT(*) AS n FROM parent')!.n).toBe(1);
      expect(other.inTransaction).toBe(false);
    } finally {
      other.close();
    }
  });
});

describe('json helpers', () => {
  it('json keeps null as null and parseJson falls back on bad input', () => {
    expect(json(null)).toBeNull();
    expect(json(undefined)).toBeNull();
    expect(json({ a: 1 })).toBe('{"a":1}');
    expect(parseJson('{"a":1}', {})).toEqual({ a: 1 });
    expect(parseJson('not json', { fallback: true })).toEqual({ fallback: true });
    expect(parseJson(null, [])).toEqual([]);
    expect(parseJson('', 0)).toBe(0);
  });
});
