import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordAudit } from '../../../src/database/audit.js';
import { parseSiteConfig } from '../../../src/config/site-schema.js';
import { assertBackupMatchesWorkspace, backupDatabase, databaseSites, demoLiveMismatches, restoreDatabase, verifyDatabaseFile } from '../../../src/database/backup.js';
import { openDatabase } from '../../../src/database/db.js';
import { ensureSite } from '../../../src/database/sites.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

let ctx: TestContext;
let extra: string;
beforeEach(() => {
  ctx = createTestContext();
  extra = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-bak-'));
});
afterEach(() => {
  ctx.cleanup();
  rmSync(extra, { recursive: true, force: true });
});

const events = (file: string) => {
  const db = openDatabase(file, { readOnly: true });
  try {
    return db.all<{ event_type: string }>('SELECT event_type FROM audit_events WHERE site_id = ? ORDER BY id', ['test-site']).map((r) => r.event_type);
  } finally {
    db.close();
  }
};

describe('backup / verify / restore', () => {
  it('round-trips: restore brings back the backed-up data and saves the pre-restore database first', () => {
    recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'test', eventType: 'before.backup' });
    const backupFile = path.join(ctx.paths.backupsDir, 'manual', 'seo-agent.sqlite');
    backupDatabase(ctx.db, backupFile);
    const v = verifyDatabaseFile(backupFile);
    expect(v.ok).toBe(true);
    expect(v.migrations).toBeGreaterThanOrEqual(9);
    expect(v.sizeBytes).toBeGreaterThan(0);
    expect(statSync(backupFile).mode & 0o777).toBe(0o600);

    recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'test', eventType: 'after.backup' });
    const dbFile = ctx.db.file;
    ctx.db.close();

    const res = restoreDatabase({ backupFile, dbFile, backupsDir: ctx.paths.backupsDir, now: new Date('2026-09-24T10:00:00Z') });
    expect(res.restoredFrom).toBe(backupFile);
    expect(res.preRestoreBackup).toBe(path.join(ctx.paths.backupsDir, 'pre-restore-2026-09-24T10-00-00-000Z.sqlite'));
    expect(events(dbFile)).toContain('before.backup');
    expect(events(dbFile)).not.toContain('after.backup');
    // The restore is reversible: the replaced database (with the later event) was kept.
    expect(events(res.preRestoreBackup!)).toContain('after.backup');
    expect(statSync(res.preRestoreBackup!).mode & 0o777).toBe(0o600);
    expect(existsSync(`${dbFile}.restore-tmp`)).toBe(false);

    // The restored database is fully usable.
    const reopened = openDatabase(dbFile);
    try {
      expect(reopened.get<{ integrity_check: string }>('PRAGMA integrity_check')!.integrity_check).toBe('ok');
      reopened.run("INSERT INTO sites (id, name, base_url, created_at, updated_at) VALUES ('second-site', 'x', 'https://x.example/', 'now', 'now')");
    } finally {
      reopened.close();
    }
  });

  it('refuses to restore over running jobs or unexpired locks (unless forced); expired locks do not block', () => {
    const backupFile = path.join(extra, 'b.sqlite');
    backupDatabase(ctx.db, backupFile);
    const now = new Date('2026-09-24T10:00:00Z');
    ctx.db.run("INSERT INTO site_locks (site_id, lock_name, owner, acquired_at, heartbeat_at, expires_at) VALUES (?, 'old', 'pid:1', ?, ?, ?)", [ctx.siteId, '2026-09-24T08:00:00Z', '2026-09-24T08:00:00Z', '2026-09-24T09:00:00Z']);
    const dbFile = ctx.db.file;
    // Only an expired lease: not activity.
    ctx.db.close();
    const first = restoreDatabase({ backupFile, dbFile, backupsDir: ctx.paths.backupsDir, now });
    expect(first.forcedOver).toBeNull();

    const live = openDatabase(dbFile);
    live.run("INSERT INTO jobs (id, site_id, type, status, created_at, started_at, heartbeat_at) VALUES ('job_synthetic', ?, 'weekly', 'running', ?, ?, ?)", [ctx.siteId, now.toISOString(), now.toISOString(), now.toISOString()]);
    recordAudit(live, { siteId: ctx.siteId, actor: 'test', eventType: 'while.running' });
    live.close();
    let err: unknown;
    try {
      restoreDatabase({ backupFile, dbFile, backupsDir: ctx.paths.backupsDir, now: new Date('2026-09-24T10:05:00Z') });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'LOCKED', details: { runningJobs: [expect.objectContaining({ id: 'job_synthetic', type: 'weekly' })], activeLocks: [] } });
    expect(events(dbFile)).toContain('while.running'); // nothing replaced
    expect(existsSync(`${dbFile}.restore-tmp`)).toBe(false);

    const forced = restoreDatabase({ backupFile, dbFile, backupsDir: ctx.paths.backupsDir, now: new Date('2026-09-24T10:06:00Z'), force: true });
    expect(forced.forcedOver?.runningJobs).toHaveLength(1);
    expect(events(dbFile)).not.toContain('while.running');
    expect(events(forced.preRestoreBackup!)).toContain('while.running');
  });

  it('restores into a workspace with no database (no pre-restore backup needed)', () => {
    const backupFile = path.join(extra, 'b.sqlite');
    backupDatabase(ctx.db, backupFile);
    const target = path.join(extra, 'fresh', 'seo-agent.sqlite');
    const res = restoreDatabase({ backupFile, dbFile: target, backupsDir: path.join(extra, 'backups') });
    expect(res.preRestoreBackup).toBeNull();
    expect(verifyDatabaseFile(target).ok).toBe(true);
  });

  it('never overwrites an existing backup file', () => {
    const f = path.join(extra, 'b.sqlite');
    backupDatabase(ctx.db, f);
    expect(() => backupDatabase(ctx.db, f)).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
  });

  it('verify rejects missing, corrupt, and foreign SQLite files; a bad backup never replaces the live database', () => {
    expect(() => verifyDatabaseFile(path.join(extra, 'missing.sqlite'))).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    const garbage = path.join(extra, 'garbage.sqlite');
    writeFileSync(garbage, 'this is not a database'.repeat(100));
    expect(() => verifyDatabaseFile(garbage)).toThrow();
    const foreign = path.join(extra, 'foreign.sqlite');
    const f = openDatabase(foreign);
    f.exec('CREATE TABLE other (x)');
    f.close();
    expect(() => verifyDatabaseFile(foreign)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));

    recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'test', eventType: 'live.event' });
    const dbFile = ctx.db.file;
    ctx.db.close();
    expect(() => restoreDatabase({ backupFile: foreign, dbFile, backupsDir: ctx.paths.backupsDir })).toThrow();
    expect(events(dbFile)).toContain('live.event');
  });

  describe('demo/live separation (C2-02)', () => {
    /** A SYNTHETIC backup file (same schema as the test database) that also holds a demo site (is_demo = 1). */
    const demoBackup = (): string => {
      const file = path.join(extra, 'demo.sqlite');
      backupDatabase(ctx.db, file);
      const db = openDatabase(file);
      try {
        ensureSite(db, parseSiteConfig({ profile: 'demo', site: { id: 'demo-widgets', businessName: 'Demo Widgets (synthetic)', url: 'https://www.example.com/', allowedHostnames: ['www.example.com'] } }));
      } finally {
        db.close();
      }
      return file;
    };

    it('databaseSites lists the sites of a database file with their demo flag; mismatches are computed per workspace kind', () => {
      const file = demoBackup();
      const sites = databaseSites(file);
      expect(sites).toContainEqual({ id: 'demo-widgets', isDemo: true });
      expect(sites).toContainEqual({ id: ctx.siteId, isDemo: false });
      expect(demoLiveMismatches('live', sites)).toEqual([{ id: 'demo-widgets', isDemo: true }]);
      expect(demoLiveMismatches('demo', sites)).toEqual([{ id: ctx.siteId, isDemo: false }]);
      expect(demoLiveMismatches('live', [{ id: 'a', isDemo: false }])).toEqual([]);
      expect(() => assertBackupMatchesWorkspace('live', [], { backupFile: file })).not.toThrow();
      const foreign = path.join(extra, 'no-sites.sqlite');
      const f = openDatabase(foreign);
      f.exec('CREATE TABLE schema_migrations (version TEXT)');
      f.close();
      expect(databaseSites(foreign)).toEqual([]);
    });

    it('with workspaceKind "live", a backup holding a demo site is refused before anything is touched', () => {
      const file = demoBackup();
      recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'test', eventType: 'live.marker' });
      const dbFile = ctx.db.file;
      ctx.db.close();
      let err: unknown;
      try {
        restoreDatabase({ backupFile: file, dbFile, backupsDir: ctx.paths.backupsDir, workspaceKind: 'live' });
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({ code: 'WORKSPACE_UNSAFE', message: expect.stringContaining('holds demo site(s) demo-widgets'), details: { workspaceKind: 'live', mismatchedSites: [{ id: 'demo-widgets', isDemo: true }] } });
      expect(events(dbFile)).toContain('live.marker');
      expect(existsSync(`${dbFile}.restore-tmp`)).toBe(false);
      expect(existsSync(ctx.paths.backupsDir) ? readdirSync(ctx.paths.backupsDir).filter((f) => f.startsWith('pre-restore-')) : []).toEqual([]);
    });

    it('with workspaceKind "demo", a backup holding a live site is refused; a matching kind restores', () => {
      const liveBackup = path.join(extra, 'live.sqlite');
      backupDatabase(ctx.db, liveBackup);
      const dbFile = ctx.db.file;
      ctx.db.close();
      expect(() => restoreDatabase({ backupFile: liveBackup, dbFile, backupsDir: ctx.paths.backupsDir, workspaceKind: 'demo' })).toThrow(
        expect.objectContaining({ code: 'WORKSPACE_UNSAFE', message: expect.stringContaining('is a demo workspace') }),
      );
      const ok = restoreDatabase({ backupFile: liveBackup, dbFile, backupsDir: ctx.paths.backupsDir, workspaceKind: 'live' });
      expect(ok.restoredFrom).toBe(liveBackup);
    });
  });
});
