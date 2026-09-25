import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppContext, type CreateContextOptions } from '../../../src/app/context.js';
import { fixedClock } from '../../../src/core/clock.js';
import { memoryLogger } from '../../../src/core/logger.js';
import { MemorySecretStore } from '../../../src/config/secrets.js';
import { workspacePaths } from '../../../src/config/paths.js';
import { initWorkspace } from '../../../src/config/workspace.js';
import { openDatabase } from '../../../src/database/db.js';
import { ensureSite, siteRegistrationStatus } from '../../../src/database/sites.js';
import { testSiteConfig } from '../../helpers/context.js';

// Spec 29: --dry-run shows what would happen "without external requests, spending, or writes".
// The CLI builds dry-run contexts with prepareDatabase 'verify'.

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-ctx-'));
  initWorkspace(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const config = testSiteConfig();
const build = (extra: Partial<CreateContextOptions> = {}) =>
  createAppContext({ workspaceRoot: root, siteId: config.site.id, config, secrets: new MemorySecretStore({}), clock: fixedClock('2026-09-24T09:00:00.000Z'), logger: memoryLogger(), offline: true, ...extra });
const snapshot = () => {
  const db = openDatabase(workspacePaths(root).dbFile, { readOnly: true });
  try {
    return {
      migrations: db.all('SELECT version FROM schema_migrations ORDER BY version'),
      sites: db.all('SELECT * FROM sites'),
      versions: db.all('SELECT site_id, version, config_hash FROM config_versions ORDER BY site_id, version'),
    };
  } finally {
    db.close();
  }
};

describe("createAppContext prepareDatabase: 'verify' (dry runs)", () => {
  it('never creates a missing database: uses an empty in-memory one and reports it', () => {
    const notices: string[] = [];
    const ctx = build({ prepareDatabase: 'verify', dryRun: true, onNotice: (m) => notices.push(m) });
    expect(ctx.db.file).toBe(':memory:');
    expect(ctx.budgets.report(ctx.siteId).combined.committedMicros).toBe(0);
    ctx.db.close();
    expect(notices).toEqual([expect.stringContaining('does not exist yet')]);
    expect(existsSync(workspacePaths(root).dbFile)).toBe(false);
  });

  it('refuses pending migrations without applying them or writing a backup', () => {
    build().db.close(); // normal run: migrate + register
    const db = openDatabase(workspacePaths(root).dbFile);
    const last = db.get<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')!.version;
    db.run('DELETE FROM schema_migrations WHERE version = ?', [last]);
    db.close();
    const before = snapshot();
    let err: unknown;
    try {
      build({ prepareDatabase: 'verify', dryRun: true });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'MIGRATION_PENDING', details: { pending: [expect.stringMatching(new RegExp(`^${last}_`))] } });
    expect(snapshot()).toEqual(before);
    expect(existsSync(workspacePaths(root).backupsDir) ? readdirSync(workspacePaths(root).backupsDir) : []).toEqual([]);
  });

  it('refuses a database written by a newer application', () => {
    build().db.close();
    const db = openDatabase(workspacePaths(root).dbFile);
    db.run("INSERT INTO schema_migrations (version, name, checksum, applied_at, app_version) VALUES ('9999', '9999_future', 'x', 'now', '9.9.9')");
    db.close();
    expect(() => build({ prepareDatabase: 'verify' })).toThrow(expect.objectContaining({ code: 'MIGRATION_FAILED' }));
  });

  it('uses a current database without registering the site; configuration drift is only reported', () => {
    build().db.close(); // a normal run migrates and registers the site
    const registered = snapshot();
    expect(registered.sites).toHaveLength(1);

    const notices: string[] = [];
    const ctx = build({ prepareDatabase: 'verify', dryRun: true, onNotice: (m) => notices.push(m) });
    expect(ctx.dryRun).toBe(true);
    expect(ctx.budgets.report(ctx.siteId).siteId).toBe(config.site.id);
    ctx.db.close();
    expect(notices).toEqual([]);
    expect(snapshot()).toEqual(registered);

    const changed = testSiteConfig({ budgets: { combinedMonthlyUsd: '24.00' } });
    const ctx2 = createAppContext({ workspaceRoot: root, siteId: changed.site.id, config: changed, secrets: new MemorySecretStore({}), logger: memoryLogger(), offline: true, prepareDatabase: 'verify', onNotice: (m) => notices.push(m) });
    ctx2.db.close();
    expect(notices).toEqual([expect.stringContaining('changed since it was last recorded')]);
    expect(snapshot()).toEqual(registered);

    const other = testSiteConfig({ site: { id: 'other-site', businessName: 'Other (synthetic)', url: 'https://other.example.test/', allowedHostnames: ['other.example.test'] } });
    const ctx3 = createAppContext({ workspaceRoot: root, siteId: other.site.id, config: other, secrets: new MemorySecretStore({}), logger: memoryLogger(), offline: true, prepareDatabase: 'verify', onNotice: (m) => notices.push(m) });
    ctx3.db.close();
    expect(notices[1]).toContain('"other-site" is not registered');
    expect(snapshot()).toEqual(registered);
  });

  it("the default ('migrate') applies migrations and registers the site, reporting what it applied", () => {
    const applied: string[][] = [];
    const ctx = build({ onMigrated: (r) => applied.push(r.applied) });
    expect(applied).toHaveLength(1);
    expect(siteRegistrationStatus(ctx.db, config)).toBe('current');
    ctx.db.close();
  });
});

describe('ensureSite', () => {
  it('does not rewrite the site row when nothing changed', () => {
    const ctx = build();
    const before = ctx.db.get('SELECT * FROM sites WHERE id = ?', [config.site.id]);
    const again = ensureSite(ctx.db, config, { now: new Date('2027-01-01T00:00:00Z') });
    expect(again.configChanged).toBe(false);
    expect(ctx.db.get('SELECT * FROM sites WHERE id = ?', [config.site.id])).toEqual(before);
    const changed = testSiteConfig({ budgets: { combinedMonthlyUsd: '24.00' } });
    const r = ensureSite(ctx.db, changed, { now: new Date('2027-01-02T00:00:00Z') });
    expect(r).toMatchObject({ configChanged: true, configVersion: 2 });
    expect(r.site).toMatchObject({ active_config_version: 2, updated_at: '2027-01-02T00:00:00.000Z' });
    // Switching back to a known version re-activates it (a write, because the active version changes).
    expect(ensureSite(ctx.db, config, { now: new Date('2027-01-03T00:00:00Z') }).site).toMatchObject({ active_config_version: 1, updated_at: '2027-01-03T00:00:00.000Z' });
    ctx.db.close();
  });
});
