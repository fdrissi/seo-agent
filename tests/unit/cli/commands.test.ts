import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../../src/cli/main.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { appDirs, workspacePaths } from '../../../src/config/paths.js';
import { BudgetExceededError } from '../../../src/core/errors.js';
import { BudgetService } from '../../../src/budgets/budget-service.js';
import { recordAudit } from '../../../src/database/audit.js';
import { openDatabase } from '../../../src/database/db.js';
import { REDACTED, registerSecret } from '../../../src/security/redact.js';

let tmp: string;
let ws: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-cli-'));
  ws = path.join(tmp, 'workspace');
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

interface CliRun {
  out: string;
  err: string;
  exitCode: number | undefined;
  json<T = any>(): T;
}

async function cli(...args: string[]): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const runtime = new CliRuntime({ out: (t) => void out.push(t), err: (t) => void err.push(t) }, { ...process.env, HOME: tmp, SEO_AGENT_WORKSPACE: ws });
  const program = await buildProgram(runtime);
  program.exitOverride();
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'seo-agent', ...args]);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
  }
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : undefined;
  process.exitCode = undefined;
  const stdout = out.join('\n');
  return { out: stdout, err: err.join('\n'), exitCode, json: () => JSON.parse(stdout) };
}

const withSite = () => copyFileSync(appDirs.exampleSiteConfig(), path.join(workspacePaths(ws).sitesDir, 'example-site.yaml'));
const auditTypes = () => {
  const db = openDatabase(workspacePaths(ws).dbFile, { readOnly: true });
  try {
    return db.all<{ event_type: string }>('SELECT event_type FROM audit_events ORDER BY id').map((r) => r.event_type);
  } finally {
    db.close();
  }
};

describe('init', () => {
  it('creates the workspace from SEO_AGENT_WORKSPACE and is idempotent', async () => {
    const first = await cli('init', '--json');
    expect(first.exitCode).toBeUndefined();
    const r1 = first.json();
    expect(r1.root).toBe(ws);
    expect(r1.created.length).toBeGreaterThan(10);
    expect(r1.migrationsApplied.length).toBeGreaterThanOrEqual(9);
    expect(existsSync(workspacePaths(ws).dbFile)).toBe(true);

    writeFileSync(path.join(ws, 'README.md'), 'owner notes - keep');
    const r2 = (await cli('init', '--json')).json();
    expect(r2.created).toEqual([]);
    expect(r2.migrationsApplied).toEqual([]);
    expect(r2.preMigrationBackup).toBeNull();
    expect(readFileSync(path.join(ws, 'README.md'), 'utf8')).toBe('owner notes - keep');

    const human = await cli('init');
    expect(human.out).toContain('Created 0 item(s)');
    expect(human.out).toContain('Database already up to date.');
    // Next steps only name commands that exist in this build.
    const program = await buildProgram(new CliRuntime({ out: () => undefined, err: () => undefined }, {}));
    const names = new Set(program.commands.map((c) => c.name()));
    expect(r2.nextSteps).toHaveLength(3);
    for (const step of r2.nextSteps as string[]) {
      const m = /npm run cli -- ([a-z-]+)/.exec(step);
      if (m) expect(names.has(m[1]!)).toBe(true);
    }
  });

  it('--dry-run writes nothing', async () => {
    const r = await cli('init', '--dry-run', '--json');
    expect(r.json()).toMatchObject({ dryRun: true, migrationsApplied: [] });
    expect(r.json().pendingMigrations.length).toBeGreaterThanOrEqual(9);
    expect(existsSync(ws)).toBe(false);
  });

  it('workspace status and db status report the schema in JSON mode', async () => {
    await cli('init');
    const status = (await cli('workspace', 'status', '--json')).json();
    expect(status).toMatchObject({ root: ws, exists: true, sites: [], schema: { pending: [], unknown: [] } });
    expect((await cli('db', 'status', '--json')).json()).toMatchObject({ database: 'present', pending: [], unknown: [] });
    expect((await cli('db', 'migrate', '--dry-run', '--json')).json()).toEqual({ dryRun: true, wouldApply: [], unknown: [] });
  });

  it('commands that need a workspace fail with an actionable error when it is missing', async () => {
    const r = await cli('costs', '--json');
    expect(r.exitCode).toBe(1);
    expect(r.json()).toMatchObject({ ok: false, error: { code: 'WORKSPACE_MISSING', hint: expect.stringContaining('init') } });
    const human = await cli('db', 'status');
    expect(human.err).toContain('Error [WORKSPACE_MISSING]');
    expect(human.err).toContain('Next step:');
  });
});

describe('config validate', () => {
  /**
   * The shipped example leaves reporting.businessTimezone as null (unknown, never inferred), which is
   * reported as a warning with its next step. No other warning is expected from the example.
   */
  const otherThanUnknownZone = (warnings: string[]) => warnings.filter((w) => !w.startsWith('reporting.businessTimezone: unknown;'));

  it('validates the shipped example config file', async () => {
    const r = await cli('config', 'validate', '--file', appDirs.exampleSiteConfig(), '--json');
    expect(r.exitCode).toBeUndefined();
    const json = r.json<{ warnings: string[] }>();
    expect(json).toEqual({ ok: true, file: appDirs.exampleSiteConfig(), siteId: 'example-site', profile: 'core', warnings: expect.any(Array) });
    expect(otherThanUnknownZone(json.warnings)).toEqual([]);
  });

  it('validates workspace sites and reports invalid ones with field errors and exit code 1', async () => {
    await cli('init');
    withSite();
    writeFileSync(path.join(workspacePaths(ws).sitesDir, 'broken-site.yaml'), 'site:\n  id: broken-site\n  businessName: x\n  url: ftp://example.com/\n  allowedHostnames: []\nscheduler: {timezone: "+02:00"}\n');
    const r = await cli('config', 'validate', '--json');
    expect(r.exitCode).toBe(1);
    const results = r.json<Array<{ siteId: string; ok: boolean; warnings?: string[]; details?: { errors: string[] } }>>();
    const example = results.find((x) => x.siteId === 'example-site');
    expect(example).toMatchObject({ ok: true, warnings: expect.any(Array) });
    expect(otherThanUnknownZone(example?.warnings ?? [])).toEqual([]);
    const broken = results.find((x) => x.siteId === 'broken-site')!;
    expect(broken.ok).toBe(false);
    expect(broken.details!.errors.join('\n')).toMatch(/site\.url/);
    expect(broken.details!.errors.join('\n')).toMatch(/scheduler\.timezone/);
  });

  it('prints warnings for unknown keys', async () => {
    const file = path.join(tmp, 'typo.yaml');
    writeFileSync(file, `${readFileSync(appDirs.exampleSiteConfig(), 'utf8')}\nfeaturs: {llm: true}\n`);
    const r = await cli('config', 'validate', '--file', file);
    expect(r.out).toContain('OK:');
    expect(r.out).toContain('warning: featurs: unknown key');
  });

  it('config docs prints the generated reference used in docs/CONFIGURATION.md', async () => {
    const r = await cli('config', 'docs');
    expect(r.out).toContain('<!-- BEGIN GENERATED: fields');
    expect(r.out).toContain('`budgets.combinedMonthlyUsd`');
    expect(r.out).toContain('<!-- END GENERATED: env -->');
  });

  it('reports an out-of-range budget as CONFIG_INVALID with the field path (not an internal error)', async () => {
    const file = path.join(tmp, 'huge.yaml');
    writeFileSync(file, readFileSync(appDirs.exampleSiteConfig(), 'utf8').replace(/combinedMonthlyUsd: "?[0-9.]+"?/, 'combinedMonthlyUsd: "99999999999"'));
    const r = await cli('config', 'validate', '--file', file, '--json');
    expect(r.exitCode).toBe(1);
    const err = r.json().error;
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.details.errors.join('\n')).toMatch(/budgets\.combinedMonthlyUsd: Amount must be at most/);
  });

  it('warns every site when sites sharing a workspace declare different shared account caps', async () => {
    await cli('init');
    withSite();
    const example = readFileSync(appDirs.exampleSiteConfig(), 'utf8');
    const second = example.replace(/example-site/g, 'second-site').replace(/example\.com/g, 'second.example.test');
    writeFileSync(path.join(workspacePaths(ws).sitesDir, 'second-site.yaml'), second.replace('combinedMonthlyUsd: "25.00"', 'combinedMonthlyUsd: "25.00"\n  accountMonthlyUsd: { apify: "2.00" }'));
    const r = await cli('config', 'validate', '--json');
    const results = r.json<Array<{ siteId: string; ok: boolean; warnings: string[] }>>();
    expect(results.every((x) => x.ok)).toBe(true);
    for (const x of results) expect(x.warnings.join('\n')).toMatch(/accountMonthlyUsd\.apify: sites in this workspace disagree .*the smallest \(\$2\.00\) applies to every site/);
  });

  it('prints the JSON Schema', async () => {
    const schema = (await cli('config', 'schema')).json();
    expect(schema.type).toBe('object');
    expect(schema.properties.site).toBeDefined();
  });
});

describe('config show --json', () => {
  it('keeps every environment status readable and never includes secret values', async () => {
    await cli('init');
    withSite();
    const secret = 'synthetic-show-secret-0123456789';
    writeFileSync(workspacePaths(ws).secretsEnvFile, `# keep\nAPIFY_TOKEN=${secret}\n`, { mode: 0o600 });
    const r = await cli('config', 'show', '--json');
    expect(r.exitCode).toBeUndefined();
    expect(r.out).not.toContain(secret);
    expect(r.out).not.toContain(REDACTED);
    const env = r.json().env as Array<{ name: string; source: string; isSecret: boolean; isSet: boolean }>;
    const by = Object.fromEntries(env.map((e) => [e.name, e]));
    expect(by.APIFY_TOKEN).toEqual({ name: 'APIFY_TOKEN', source: 'secrets-file', isSecret: true, isSet: true });
    expect(by.LLM_GATEWAY_API_KEY).toEqual({ name: 'LLM_GATEWAY_API_KEY', source: expect.any(String), isSecret: true, isSet: expect.any(Boolean) });
    expect(by.GOOGLE_AUTH_MODE).toMatchObject({ isSecret: false, isSet: true });
    for (const e of env) {
      expect(typeof e.isSecret).toBe('boolean');
      expect(typeof e.isSet).toBe('boolean');
      expect(['env', 'secrets-file', 'default', 'unset']).toContain(e.source);
    }
    expect(r.json().googleAuthMode).toMatch(/^(oauth|service_account)$/);
    const human = await cli('config', 'show');
    expect(human.out).toContain('APIFY_TOKEN: set (secrets-file) [secret]');
    expect(human.out).not.toContain(secret);
  });
});

describe('costs --json', () => {
  it('returns the spend report shape with actual/reserved/estimated/unknown kept separate', async () => {
    await cli('init');
    withSite();
    const first = (await cli('costs', '--json')).json();
    expect(first).toMatchObject({ siteId: 'example-site', timeZone: 'Europe/Tallinn', combined: { committedMicros: 0, limitMicros: 25_000_000, remainingMicros: 25_000_000, remainingVerified: true } });
    expect(first.periodMonth).toMatch(/^\d{4}-\d{2}$/);
    expect(first.periodWeek).toMatch(/^\d{4}-W\d{2}$/);
    expect(first.providers.map((p: { provider: string }) => p.provider)).toEqual(['llm_gateway', 'dataforseo', 'apify', 'pagespeed']);
    for (const p of first.providers) {
      expect(Object.keys(p).sort()).toEqual(
        ['actualMicros', 'committedMicros', 'estimatedMicros', 'limitMicros', 'provider', 'remainingMicros', 'remainingVerified', 'reservedMicros', 'unboundedUnknownCount', 'unknownCount', ...(p.provider === 'dataforseo' ? ['weekly'] : [])].sort(),
      );
    }
    expect(first.notes.length).toBeGreaterThan(0);

    // Add an ambiguous (unresolved) charge directly and check it is surfaced, not zeroed.
    const db = openDatabase(workspacePaths(ws).dbFile);
    try {
      const svc = new BudgetService(db, {
        limits: { llmGateway: { monthly: 5_000_000, perRun: 500_000 }, dataforseo: { weekly: 1_000_000, monthly: 10_000_000, perRun: 500_000 }, apify: { monthly: 10_000_000, perRun: 1_000_000 }, pagespeed: { monthly: 0, perRun: 0 }, combinedMonthly: 25_000_000, accountMonthly: {} },
        timeZone: 'Europe/Tallinn',
      });
      const r = svc.reserve({ siteId: 'example-site', provider: 'apify', runId: 'run_cli', purpose: 'synthetic', estimate: { upperBoundMicros: 400_000, basis: { source: 'verified_config', detail: 'synthetic' } } });
      svc.markUnresolved(r.id, 'timeout after submit');
    } finally {
      db.close();
    }
    const withOpen = (await cli('costs', '--unresolved', '--json')).json();
    expect(withOpen.report.providers.find((p: { provider: string }) => p.provider === 'apify')).toMatchObject({ reservedMicros: 400_000, unknownCount: 1, actualMicros: 0 });
    expect(withOpen.open).toHaveLength(1);
    expect(withOpen.open[0]).toMatchObject({ status: 'unresolved', cost_status: 'unknown', unbounded: false });
    const human = await cli('costs');
    expect(human.out).toContain('Spend for example-site');
    expect(human.out).toContain('$0.40');
  });

  it('marks remaining budget as unverified while an approved charge without an upper bound is outstanding', async () => {
    await cli('init');
    withSite();
    await cli('costs'); // registers the site row
    const db = openDatabase(workspacePaths(ws).dbFile);
    try {
      const svc = new BudgetService(db, {
        limits: { llmGateway: { monthly: 5_000_000, perRun: 500_000 }, dataforseo: { weekly: 1_000_000, monthly: 10_000_000, perRun: 500_000 }, apify: { monthly: 10_000_000, perRun: 1_000_000 }, pagespeed: { monthly: 0, perRun: 0 }, combinedMonthly: 25_000_000, accountMonthly: {} },
        timeZone: 'Europe/Tallinn',
      });
      svc.reserve({ siteId: 'example-site', provider: 'apify', runId: 'run_cli', purpose: 'synthetic unbounded', estimate: { upperBoundMicros: null, basis: { source: 'unknown', detail: 'synthetic' } }, unknownPriceApprovalId: 'appr_synthetic' });
    } finally {
      db.close();
    }
    const r = (await cli('costs', '--unresolved', '--json')).json();
    expect(r.report.providers.find((p: { provider: string }) => p.provider === 'apify')).toMatchObject({ unknownCount: 1, unboundedUnknownCount: 1, remainingVerified: false });
    expect(r.report.combined).toMatchObject({ remainingVerified: false, unboundedUnknownCount: 1 });
    expect(r.open[0]).toMatchObject({ unbounded: true, cost_status: 'unknown' });
    const human = await cli('costs', '--unresolved');
    expect(human.out).toContain('at most $10.00 (unverified)');
    expect(human.out).toContain('NO upper bound');
    expect(human.out).toContain('amount unknown (no upper bound)');
  });
});

describe('--dry-run never changes the database', () => {
  const dbFile = () => workspacePaths(ws).dbFile;
  const count = (sql: string) => {
    const db = openDatabase(dbFile(), { readOnly: true });
    try {
      return db.get<{ n: number }>(sql)!.n;
    } finally {
      db.close();
    }
  };

  it('refuses with MIGRATION_PENDING when migrations are pending, writing no backup and applying nothing', async () => {
    await cli('init');
    withSite();
    // Simulate an upgrade: the newest migration is not applied yet.
    const db = openDatabase(dbFile());
    const last = db.get<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')!.version;
    db.run('DELETE FROM schema_migrations WHERE version = ?', [last]);
    db.close();
    const before = readdirSync(workspacePaths(ws).backupsDir);
    const r = await cli('--dry-run', 'costs', '--json');
    expect(r.exitCode).toBe(1);
    expect(r.json()).toMatchObject({ ok: false, error: { code: 'MIGRATION_PENDING', hint: expect.stringContaining('db migrate') } });
    expect(r.err).not.toContain('Database migrated');
    expect(readdirSync(workspacePaths(ws).backupsDir)).toEqual(before);
    expect(count(`SELECT COUNT(*) AS n FROM schema_migrations WHERE version = '${last}'`)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM sites')).toBe(0);
  });

  it('never creates a missing database: plans against an empty temporary one and says so', async () => {
    await cli('init');
    withSite();
    rmSync(dbFile());
    const r = await cli('--dry-run', 'costs', '--json');
    expect(r.exitCode).toBeUndefined();
    expect(r.json()).toMatchObject({ siteId: 'example-site', combined: { committedMicros: 0 } });
    expect(r.err).toContain('does not exist yet');
    expect(existsSync(dbFile())).toBe(false);
    expect(readdirSync(path.dirname(dbFile())).filter((f) => f.startsWith('seo-agent.sqlite'))).toEqual([]);
  });

  it('runs against a current database without registering the site or recording config versions', async () => {
    await cli('init');
    withSite();
    const r = await cli('--dry-run', 'costs', '--json');
    expect(r.exitCode).toBeUndefined();
    expect(r.json()).toMatchObject({ siteId: 'example-site' });
    expect(r.err).toContain('not registered');
    expect(count('SELECT COUNT(*) AS n FROM sites')).toBe(0);
    // A normal run registers it once; later normal runs with the same config do not rewrite the row.
    await cli('costs');
    const snapshot = () => {
      const db = openDatabase(dbFile(), { readOnly: true });
      try {
        return { site: db.get('SELECT * FROM sites'), versions: db.all('SELECT version, config_hash FROM config_versions') };
      } finally {
        db.close();
      }
    };
    const registered = snapshot();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await cli('costs');
    expect(snapshot()).toEqual(registered);
    // A changed config is reported by a dry run but not recorded.
    const file = path.join(workspacePaths(ws).sitesDir, 'example-site.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/combinedMonthlyUsd: "?[0-9.]+"?/, 'combinedMonthlyUsd: "24.00"'));
    const dry = await cli('--dry-run', 'costs', '--json');
    expect(dry.exitCode).toBeUndefined();
    expect(dry.err).toContain('configuration of site "example-site" changed');
    expect(snapshot()).toEqual(registered);
  });
});

describe('workspace format guard', () => {
  it('refuses every workspace command on a workspace written by a newer application, and status reports it', async () => {
    const paths = workspacePaths(ws);
    mkdirSync(ws, { recursive: true });
    writeFileSync(paths.manifest, JSON.stringify({ formatVersion: 2, createdAt: '2027-01-01T00:00:00.000Z', createdByAppVersion: '9.9.9', kind: 'live', note: 'synthetic newer workspace' }));
    for (const args of [['db', 'migrate'], ['db', 'status'], ['costs'], ['backup'], ['config', 'validate']]) {
      const r = await cli(...args, '--json');
      expect(r.exitCode).toBe(1);
      expect(r.json()).toMatchObject({ ok: false, error: { code: 'WORKSPACE_UNSAFE', details: { formatVersion: 2, supported: 1 } } });
    }
    expect(existsSync(paths.dbFile)).toBe(false);
    expect(existsSync(paths.backupsDir)).toBe(false);
    const status = (await cli('workspace', 'status', '--json')).json();
    expect(status).toMatchObject({ exists: true, formatSupported: false, supportedFormatVersion: 1 });
    expect((await cli('workspace', 'status')).out).toContain('UNSUPPORTED: workspace format 2');
    expect((await cli('init', '--json')).json()).toMatchObject({ ok: false, error: { code: 'WORKSPACE_UNSAFE' } });
  });
});

describe('backup and restore', () => {
  it('round-trips the database; restore requires --confirm and saves the current database first', async () => {
    await cli('init');
    withSite();
    await cli('costs'); // registers the site row
    const db = openDatabase(workspacePaths(ws).dbFile);
    recordAudit(db, { siteId: 'example-site', actor: 'test', eventType: 'marker.before' });
    db.close();

    expect((await cli('backup', '--dry-run', '--json')).json()).toMatchObject({ dryRun: true, secretsIncluded: false });
    expect(readdirSync(workspacePaths(ws).backupsDir).filter((f) => f.startsWith('backup-'))).toEqual([]);

    const backup = (await cli('backup', '--json')).json();
    expect(backup.secretsIncluded).toBe(false);
    expect(existsSync(path.join(backup.dir, 'seo-agent.sqlite'))).toBe(true);
    expect(existsSync(path.join(backup.dir, 'config', 'sites', 'example-site.yaml'))).toBe(true);
    expect(readdirSync(backup.dir)).not.toContain('secrets');
    expect(readFileSync(path.join(backup.dir, 'BACKUP.md'), 'utf8')).toContain('--confirm');

    const db2 = openDatabase(workspacePaths(ws).dbFile);
    recordAudit(db2, { siteId: 'example-site', actor: 'test', eventType: 'marker.after' });
    db2.close();

    const unconfirmed = (await cli('restore', '--from', backup.dir, '--json')).json();
    expect(unconfirmed).toMatchObject({ confirmed: false, wouldReplace: workspacePaths(ws).dbFile });
    expect((await cli('restore', '--from', backup.dir, '--confirm', '--dry-run', '--json')).json()).toMatchObject({ confirmed: false, dryRun: true });
    expect(auditTypes()).toContain('marker.after');

    const restored = (await cli('restore', '--from', backup.dir, '--confirm', '--json')).json();
    expect(restored.restoredFrom).toBe(path.join(backup.dir, 'seo-agent.sqlite'));
    expect(existsSync(restored.preRestoreBackup)).toBe(true);
    expect(restored.restoredBeside).toHaveLength(1);
    expect(existsSync(path.join(restored.restoredBeside[0], 'example-site.yaml'))).toBe(true);
    expect(auditTypes()).toContain('marker.before');
    expect(auditTypes()).not.toContain('marker.after');
    // Live config was not overwritten; the copy sits beside it.
    expect(existsSync(path.join(workspacePaths(ws).sitesDir, 'example-site.yaml'))).toBe(true);
  });

  it('BACKUP.md and the JSON result describe only what was actually copied', async () => {
    await cli('init');
    rmSync(workspacePaths(ws).dbFile);
    const r = (await cli('backup', '--json')).json();
    expect(r).toMatchObject({ database: null, config: null, vault: null, secretsIncluded: false });
    const md = readFileSync(path.join(r.dir, 'BACKUP.md'), 'utf8');
    expect(md).toContain('Contains: nothing');
    expect(md).toContain('Not included: database (none existed), site configs (none existed), vault (empty or missing)');
    expect(md).not.toContain('restore --from');
    const restore = await cli('restore', '--from', r.dir, '--confirm', '--json');
    expect(restore.json()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', message: expect.stringContaining('contains no database backup') } });

    await cli('init'); // recreates the database
    withSite();
    const full = (await cli('backup', '--no-vault', '--json')).json();
    expect(full.database).toBe(path.join(full.dir, 'seo-agent.sqlite'));
    expect(full.config).toBe(path.join(full.dir, 'config', 'sites'));
    const fullMd = readFileSync(path.join(full.dir, 'BACKUP.md'), 'utf8');
    expect(fullMd).toContain('Contains: database, site configs.');
    expect(fullMd).toContain('vault (--no-vault)');
  });

  it('restore refuses while locks or running jobs are recorded, unless --force', async () => {
    await cli('init');
    withSite();
    await cli('costs'); // registers the site row
    const backup = (await cli('backup', '--json')).json();
    const db = openDatabase(workspacePaths(ws).dbFile);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    db.run('INSERT INTO site_locks (site_id, lock_name, owner, job_id, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, NULL, ?, ?, ?)', ['example-site', 'weekly', 'pid:synthetic', future, future, future]);
    recordAudit(db, { siteId: 'example-site', actor: 'test', eventType: 'marker.live' });
    db.close();

    const preview = (await cli('restore', '--from', backup.dir, '--json')).json();
    expect(preview.activity.activeLocks).toHaveLength(1);
    expect((await cli('restore', '--from', backup.dir)).out).toContain('restore will refuse');

    const refused = await cli('restore', '--from', backup.dir, '--confirm', '--json');
    expect(refused.exitCode).toBe(1);
    expect(refused.json()).toMatchObject({ ok: false, error: { code: 'LOCKED', hint: expect.stringContaining('--force') } });
    expect(auditTypes()).toContain('marker.live'); // live database untouched

    const forced = (await cli('restore', '--from', backup.dir, '--confirm', '--force', '--json')).json();
    expect(forced.forcedOver.activeLocks).toHaveLength(1);
    expect(auditTypes()).not.toContain('marker.live');
    expect(existsSync(forced.preRestoreBackup)).toBe(true);
  });

  it('includes data/raw and reports/ by default, lists them in BACKUP.md and the result, and restores them beside the live files (C2-05)', async () => {
    await cli('init');
    withSite();
    await cli('costs'); // registers the site row
    const paths = workspacePaths(ws);
    // SYNTHETIC raw response (what observations reference as raw:<path>) and a generated report file.
    const rawRel = path.join('example-site', 'dataforseo', '2026-09-24', 'task-post-raw_synthetic.json');
    mkdirSync(path.dirname(path.join(paths.rawDir, rawRel)), { recursive: true });
    writeFileSync(path.join(paths.rawDir, rawRel), '{"_synthetic":true,"payload":{"ok":1}}');
    mkdirSync(path.join(paths.reportsDir, 'example-site', 'weekly'), { recursive: true });
    writeFileSync(path.join(paths.reportsDir, 'example-site', 'weekly', '2026-09-14_2026-09-20-rep_synthetic.md'), '# SYNTHETIC weekly report');

    expect((await cli('backup', '--dry-run', '--json')).json()).toMatchObject({ dryRun: true, raw: paths.rawDir, reports: paths.reportsDir });
    const b = (await cli('backup', '--json')).json();
    expect(b).toMatchObject({ raw: path.join(b.dir, 'data', 'raw'), reports: path.join(b.dir, 'reports'), sites: [{ id: 'example-site', isDemo: false }], secretsIncluded: false });
    expect(readFileSync(path.join(b.dir, 'data', 'raw', rawRel), 'utf8')).toContain('_synthetic');
    expect(existsSync(path.join(b.dir, 'reports', 'example-site', 'weekly', '2026-09-14_2026-09-20-rep_synthetic.md'))).toBe(true);
    const md = readFileSync(path.join(b.dir, 'BACKUP.md'), 'utf8');
    expect(md).toContain('Contains: database, site configs, raw provider responses (data/raw), reports.');
    expect(md).toContain('Sites in the database: example-site (live).');
    expect((await cli('backup')).out).toContain('Contains: database, site configs, raw provider responses (data/raw), reports');

    // Opt-outs: nothing of them is copied, and BACKUP.md says so (and what that means for provenance).
    const lean = (await cli('backup', '--no-raw', '--no-reports', '--json')).json();
    expect(lean).toMatchObject({ raw: null, reports: null });
    expect(existsSync(path.join(lean.dir, 'data'))).toBe(false);
    expect(existsSync(path.join(lean.dir, 'reports'))).toBe(false);
    const leanMd = readFileSync(path.join(lean.dir, 'BACKUP.md'), 'utf8');
    expect(leanMd).toContain('raw provider responses (--no-raw), reports (--no-reports)');
    expect(leanMd).toContain('raw-response references (raw_ref) of restored observations point to files that are not in this backup');

    // Restore: the preview lists what goes beside the live files; the live raw file is never overwritten.
    writeFileSync(path.join(paths.rawDir, rawRel), '{"live":true}');
    const preview = (await cli('restore', '--from', b.dir, '--json')).json();
    expect(preview).toMatchObject({ confirmed: false, workspaceKind: 'live', sites: [{ id: 'example-site', isDemo: false }], siteWarnings: [] });
    expect(preview.wouldRestoreBeside).toEqual(expect.arrayContaining([path.join('data', 'raw'), 'reports', path.join('config', 'sites')]));
    const restored = (await cli('restore', '--from', b.dir, '--confirm', '--json')).json();
    const beside = restored.restoredBeside as string[];
    expect(beside.some((p) => p.endsWith(path.join('data', 'raw')))).toBe(true);
    expect(beside.some((p) => p.endsWith(`${path.sep}reports`))).toBe(true);
    const rawCopy = beside.find((p) => p.endsWith(path.join('data', 'raw')))!;
    expect(readFileSync(path.join(rawCopy, rawRel), 'utf8')).toContain('_synthetic');
    expect(readFileSync(path.join(paths.rawDir, rawRel), 'utf8')).toBe('{"live":true}');
  });

  it("restore lists the backup's sites and warns when they differ from config/sites (C2-02)", async () => {
    await cli('init');
    withSite();
    await cli('costs'); // registers the site row
    const backup = (await cli('backup', '--json')).json();
    const paths = workspacePaths(ws);
    // The workspace now configures a different site than the backup holds.
    const yaml = readFileSync(path.join(paths.sitesDir, 'example-site.yaml'), 'utf8').replace(/id: example-site/, 'id: other-site');
    writeFileSync(path.join(paths.sitesDir, 'other-site.yaml'), yaml);
    rmSync(path.join(paths.sitesDir, 'example-site.yaml'));
    const preview = (await cli('restore', '--from', backup.dir, '--json')).json();
    expect(preview.sites).toEqual([{ id: 'example-site', isDemo: false }]);
    expect(preview.siteWarnings).toEqual([
      expect.stringContaining('The backup holds site(s) with no config in'),
      expect.stringContaining('Configured site(s) with no data in the backup: other-site.'),
    ]);
    expect(preview.siteWarnings[0]).toContain(': example-site.');
    const human = await cli('restore', '--from', backup.dir);
    expect(human.out).toContain('Sites in the backup: example-site (live).');
    expect(human.out).toContain('Warning: Configured site(s) with no data in the backup: other-site.');
    const done = (await cli('restore', '--from', backup.dir, '--confirm', '--json')).json();
    expect(done.siteWarnings).toHaveLength(2);
  });

  it('refuses to restore a backup written by a newer application version', async () => {
    await cli('init');
    const backup = (await cli('backup', '--json')).json();
    const b = openDatabase(path.join(backup.dir, 'seo-agent.sqlite'));
    b.run("INSERT INTO schema_migrations (version, name, checksum, applied_at, app_version) VALUES ('9998', '9998_future', 'x', 'now', '9.9.9')");
    b.close();
    const r = await cli('restore', '--from', backup.dir, '--confirm', '--json');
    expect(r.exitCode).toBe(1);
    expect(r.json()).toMatchObject({ ok: false, error: { code: 'MIGRATION_FAILED' } });
  });
});

describe('error rendering', () => {
  it('redacts secrets from error messages and sets a non-zero exit code (human and JSON)', async () => {
    const secret = 'synthetic-cli-secret-0123456789';
    registerSecret(secret);
    const file = path.join(tmp, `${secret}.yaml`);
    const human = await cli('config', 'validate', '--file', file);
    expect(human.exitCode).toBe(1);
    expect(human.err).toContain('Error [CONFIG_MISSING]');
    expect(human.err).toContain(REDACTED);
    expect(human.err + human.out).not.toContain(secret);
    const json = await cli('config', 'validate', '--file', file, '--json');
    expect(json.exitCode).toBe(1);
    expect(json.json()).toMatchObject({ ok: false, error: { code: 'CONFIG_MISSING' } });
    expect(json.out).not.toContain(secret);
  });

  it('maps budget/credential errors to exit code 3 and unknown errors to INTERNAL', () => {
    const out: string[] = [];
    const runtime = new CliRuntime({ out: (t) => void out.push(t), err: (t) => void out.push(t) }, {});
    expect(() => runtime.fail(new BudgetExceededError('over the cap', { scope: 'run' }), true)).toThrow(CliExit);
    expect(process.exitCode).toBe(3);
    expect(JSON.parse(out.pop()!)).toMatchObject({ ok: false, error: { code: 'BUDGET_EXCEEDED' } });
    expect(() => runtime.fail(new Error('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), true)).toThrow(CliExit);
    expect(process.exitCode).toBe(1);
    const internal = JSON.parse(out.pop()!);
    expect(internal).toEqual({ ok: false, error: { code: 'INTERNAL', message: `Authorization: Bearer ${REDACTED}` } });
  });

  it('print() redacts secret-named fields in JSON and secrets in human output', () => {
    const out: string[] = [];
    const runtime = new CliRuntime({ out: (t) => void out.push(t), err: () => undefined }, {});
    runtime.print({ json: true }, { apiKey: 'sk-abcdefghijklmnopqrstuvwx', ok: true });
    expect(JSON.parse(out[0]!)).toEqual({ apiKey: REDACTED, ok: true });
    runtime.print({}, { t: 'x' }, () => 'token=sk-abcdefghijklmnopqrstuvwx');
    expect(out[1]).not.toContain('sk-abcdefghijklmnopqrstuvwx');
  });
});
