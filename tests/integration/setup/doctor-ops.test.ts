import { chmodSync, statSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { siteConfigFile } from '../../../src/config/paths.js';
import { LayeredSecretStore } from '../../../src/config/secrets.js';
import type { SiteConfigInput } from '../../../src/config/site-schema.js';
import { openDatabase } from '../../../src/database/db.js';
import type { BuildFreshness } from '../../../src/setup/build-info.js';
import { buildFreshnessCheck, circuitBreakerChecks, privateDataPermissionChecks, runDoctor, renderDoctorReport, type DoctorOptions, type DoctorReport } from '../../../src/setup/doctor.js';
import { makeWorkspace, runCli, type TestWorkspace } from './helpers.js';

/**
 * doctor: workspace/database permissions (B1-10), compiled-build freshness
 * (B1-05), and open circuit breakers (B1-01 coordination).
 */

const posix = process.platform !== 'win32';
const SITE = 'ops-test';

function writeConfig(ws: TestWorkspace): void {
  const cfg = { profile: 'core', site: { id: SITE, businessName: 'Ops Test (synthetic)', url: 'https://www.example.test/', allowedHostnames: ['www.example.test'] } } as SiteConfigInput;
  writeFileSync(siteConfigFile(ws.paths, SITE), stringify(cfg), { mode: 0o600 });
}

/** A synthetic freshness value of a checkout with its src/ (no real dist/ involved). */
function freshness(over: Partial<BuildFreshness> = {}): BuildFreshness {
  return {
    state: 'fresh',
    hasSources: true,
    appRoot: '/srv/app.invalid',
    distDir: '/srv/app.invalid/dist',
    entry: '/srv/app.invalid/dist/cli/main.js',
    info: { schema: 1, name: 'seo-agent', version: '1.2.3', builtAt: '2026-09-20T08:00:00.000Z', gitRevision: 'abcdef1234567890', gitDirty: false, srcHash: 'h', srcFiles: 10, migrations: ['0001_core.sql'] },
    reasons: [],
    currentVersion: '1.2.3',
    versionMatches: true,
    sourcesMatch: true,
    migrations: { stamped: ['0001_core.sql'], onDisk: ['0001_core.sql'], added: [], removed: [], match: true },
    ...over,
  };
}
const NOT_BUILT = freshness({ state: 'not_built', info: null, versionMatches: null, sourcesMatch: null, migrations: { stamped: null, onDisk: ['0001_core.sql'], added: [], removed: [], match: null } });
const STALE_MIGRATION = freshness({
  state: 'stale',
  reasons: ['migrations/ has 1 migration(s) the build does not know: 0002_new.sql'],
  migrations: { stamped: ['0001_core.sql'], onDisk: ['0001_core.sql', '0002_new.sql'], added: ['0002_new.sql'], removed: [], match: false },
});

let ws: TestWorkspace;
beforeEach(() => {
  ws = makeWorkspace({ migrate: true });
});
afterEach(() => ws.cleanup());

function doctor(opts: Partial<DoctorOptions> = {}): Promise<DoctorReport> {
  return runDoctor({ paths: ws.paths, secrets: new LayeredSecretStore(ws.paths.secretsEnvFile, {}), network: false, node: { version: 'v24.9.0', lts: 'Krypton' }, build: { running: null, dist: NOT_BUILT }, ...opts });
}
const byId = (r: DoctorReport, id: string) => r.checks.filter((c) => c.id === id);

describe.skipIf(!posix)('doctor: private workspace and database permissions', () => {
  it('a fresh workspace passes: 0700 folders and a 0600 database', async () => {
    expect(statSync(ws.paths.dbFile).mode & 0o777).toBe(0o600);
    const r = await doctor();
    expect(byId(r, 'workspace.root-permissions')).toEqual([]);
    expect(byId(r, 'workspace.database-permissions')[0]).toMatchObject({ level: 'ok' });
  });

  it('warns with the exact chmod commands when the workspace, data/, or database is readable by others', async () => {
    chmodSync(ws.paths.root, 0o755);
    chmodSync(ws.paths.dataDir, 0o755);
    chmodSync(ws.paths.dbFile, 0o644);
    const r = await doctor();
    expect(byId(r, 'workspace.root-permissions')[0]).toMatchObject({ level: 'warn', nextStep: `chmod 700 "${ws.paths.root}"` });
    const db = byId(r, 'workspace.database-permissions')[0]!;
    expect(db.level).toBe('warn');
    expect(db.detail).toContain(`${ws.paths.dataDir} (mode 755)`);
    expect(db.detail).toContain(`${ws.paths.dbFile} (mode 644)`);
    expect(db.nextStep).toBe(`chmod 700 "${ws.paths.dataDir}" && chmod 600 "${ws.paths.dbFile}"`);
    // Warnings on a workstation: no workspace check fails.
    expect(r.checks.filter((c) => c.group === 'workspace' && c.level === 'fail')).toEqual([]);
    expect(r.nextSteps).toEqual(expect.arrayContaining([`chmod 700 "${ws.paths.root}"`, db.nextStep]));
    expect(renderDoctorReport(r)).toMatch(/\[WARN\] Database permissions: Accessible by other users/);
  });

  it('--server turns them into failures (CLI exit code 1)', async () => {
    chmodSync(ws.paths.root, 0o750);
    const r = await doctor({ server: true });
    expect(byId(r, 'workspace.root-permissions')[0]).toMatchObject({ level: 'fail', detail: expect.stringContaining('server checklist requires 0700') });
    expect(r.ok).toBe(false);
    // The helper on its own, with a loose database file.
    chmodSync(ws.paths.dbFile, 0o640);
    expect(privateDataPermissionChecks(ws.paths, { server: true }).find((c) => c.id === 'workspace.database-permissions')).toMatchObject({ level: 'fail', nextStep: `chmod 600 "${ws.paths.dbFile}"` });
    expect(privateDataPermissionChecks(ws.paths, { platform: 'win32' })).toEqual([]);

    const cli = await runCli(ws, ['doctor', '--server', '--json']);
    expect(cli.exitCode).toBe(1);
    const report = cli.json<DoctorReport>();
    expect(report.checks.find((c) => c.id === 'workspace.root-permissions')).toMatchObject({ level: 'fail' });
  });
});

describe('doctor: compiled build freshness', () => {
  it('reports a missing dist/ as info, a matching one as ok', () => {
    expect(buildFreshnessCheck({ running: null, dist: NOT_BUILT })).toMatchObject({ id: 'runtime.build', level: 'info', detail: expect.stringContaining('No compiled build') });
    expect(buildFreshnessCheck({ running: null, dist: freshness() })).toMatchObject({ level: 'ok', detail: expect.stringContaining('matches package.json, src/, and migrations/') });
    expect(buildFreshnessCheck({ running: freshness(), dist: freshness() })).toMatchObject({ level: 'ok', detail: expect.stringContaining('This process runs the compiled build') });
    // A stamp made without migrations/ (for example in a container build stage) cannot be compared: info, not ok.
    const noList = freshness({ info: { ...freshness().info!, migrations: null }, migrations: { stamped: null, onDisk: ['0001_core.sql'], added: [], removed: [], match: null } });
    expect(buildFreshnessCheck({ running: noList, dist: noList })).toMatchObject({ level: 'info', detail: expect.stringContaining('stamp has no migration list') });
  });

  it('warns about a stale dist/ that schedulers would run, with the rebuild steps', async () => {
    const r = await doctor({ build: { running: null, dist: STALE_MIGRATION } });
    const c = byId(r, 'runtime.build')[0]!;
    expect(c.level).toBe('warn');
    expect(c.detail).toMatch(/is out of date \(v1\.2\.3, built 2026-09-20T08:00:00\.000Z, Git abcdef123456\): migrations\/ has 1 migration\(s\) the build does not know: 0002_new\.sql/);
    expect(c.nextStep).toMatch(/^Run `npm run build`, then re-run `npm run cli -- schedule instructions`/);
    expect(c.detail).toContain('`schedule instructions` falls back to the sources until it is rebuilt');
    expect(r.nextSteps).toContain(c.nextStep);
    expect(r.checks.filter((x) => x.group === 'runtime' && x.level === 'fail')).toEqual([]);
  });

  it('tells a packaged install or container image (no src/) to reinstall or upgrade, never to run `npm run build` (R3-NF-R5)', () => {
    const packaged = { ...STALE_MIGRATION, hasSources: false, sourcesMatch: null };
    for (const build of [{ running: null, dist: packaged }, { running: packaged, dist: packaged }]) {
      const c = buildFreshnessCheck(build);
      expect(c.nextStep).toMatch(/no src\/ directory .* reinstall or upgrade the seo-agent package/);
      expect(c.nextStep).not.toContain('npm run build');
      expect(c.detail).not.toContain('falls back to the sources');
    }
    expect(buildFreshnessCheck({ running: null, dist: packaged }).detail).toContain('no src/ directory to fall back to');
  });

  it('fails when doctor itself runs from a build that does not match migrations/; only warns for a source-only change', () => {
    expect(buildFreshnessCheck({ running: STALE_MIGRATION, dist: STALE_MIGRATION })).toMatchObject({ level: 'fail', detail: expect.stringContaining('`schedule run` refuses to start from it') });
    const srcOnly = freshness({ state: 'stale', sourcesMatch: false, reasons: ['src/ changed since the build (2026-09-20T08:00:00.000Z)'] });
    expect(buildFreshnessCheck({ running: srcOnly, dist: srcOnly })).toMatchObject({ level: 'warn', detail: expect.stringContaining('It runs the old compiled code') });
    const unstamped = freshness({ state: 'unstamped', info: null, reasons: ['dist/build-info.json is missing'] });
    expect(buildFreshnessCheck({ running: unstamped, dist: unstamped })).toMatchObject({ level: 'fail' });
    expect(buildFreshnessCheck({ running: null, dist: unstamped })).toMatchObject({ level: 'warn', detail: expect.stringContaining('is unstamped (no build stamp)') });
  });

  it('without an injected state it checks the real application and never fails when running from sources', async () => {
    const r = await runDoctor({ paths: ws.paths, secrets: new LayeredSecretStore(ws.paths.secretsEnvFile, {}), network: false, node: { version: 'v24.9.0', lts: 'Krypton' } });
    const c = byId(r, 'runtime.build')[0]!;
    expect(['ok', 'info', 'warn']).toContain(c.level);
  });
});

describe('doctor: open circuit breakers (read-only)', () => {
  it('lists open and half-open breakers with provider, state, next probe, redacted last error, and the reset command', async () => {
    writeConfig(ws);
    // First run registers the site row (doctor never migrates, but records the site like every command).
    const first = await doctor();
    expect(byId(first, 'jobs.breakers')[0]).toMatchObject({ level: 'ok', siteId: SITE, detail: expect.stringContaining('No provider circuit breaker') });

    const db = openDatabase(ws.paths.dbFile);
    try {
      const ins = 'INSERT INTO circuit_breakers (site_id, provider, state, consecutive_failures, opened_at, next_probe_at, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
      db.run(ins, [SITE, 'dataforseo', 'open', 3, '2026-09-24T08:00:00.000Z', '2026-09-24T08:15:00.000Z', 'HTTP 503 from api.example.test; Authorization: Bearer sk-synthetic-leak-000000000000', '2026-09-24T08:00:00.000Z']);
      db.run(ins, [SITE, 'pagespeed', 'half_open', 4, '2026-09-24T07:00:00.000Z', '2026-09-24T07:30:00.000Z', null, '2026-09-24T07:30:00.000Z']);
      db.run(ins, [SITE, 'gsc', 'closed', 0, null, null, null, '2026-09-24T07:30:00.000Z']);
    } finally {
      db.close();
    }
    const direct = openDatabase(ws.paths.dbFile, { readOnly: true });
    let checks;
    try {
      checks = circuitBreakerChecks(direct, SITE);
    } finally {
      direct.close();
    }
    expect(checks.map((c) => c.title)).toEqual(['Circuit breaker dataforseo', 'Circuit breaker pagespeed']);
    expect(checks[0]).toMatchObject({ level: 'warn', siteId: SITE, nextStep: expect.stringMatching(/^npm run cli -- jobs breakers --reset dataforseo --site ops-test /) });
    expect(checks[0]!.detail).toMatch(/^OPEN after 3 consecutive provider failure\(s\) \(opened 2026-09-24T08:00:00\.000Z\); next probe 2026-09-24T08:15:00\.000Z; last error: HTTP 503/);
    expect(checks[0]!.detail).not.toContain('sk-synthetic-leak-000000000000');
    expect(checks[1]!.detail).toMatch(/^HALF-OPEN after 4 .*next probe 2026-09-24T07:30:00\.000Z; last error: none recorded/);

    const r = await doctor();
    expect(byId(r, 'jobs.breakers').map((c) => c.title)).toEqual(['Circuit breaker dataforseo', 'Circuit breaker pagespeed']);
    expect(r.nextSteps.some((s) => s.startsWith('npm run cli -- jobs breakers --reset pagespeed --site ops-test'))).toBe(true);
    // Another site's breakers are never listed.
    expect(circuitBreakerChecksFor('other-site')).toEqual([{ id: 'jobs.breakers', group: 'jobs', siteId: 'other-site', level: 'ok', title: 'Circuit breakers', detail: 'No provider circuit breaker is open or half-open.' }]);
  });
});

function circuitBreakerChecksFor(siteId: string) {
  const db = openDatabase(ws.paths.dbFile, { readOnly: true });
  try {
    return circuitBreakerChecks(db, siteId);
  } finally {
    db.close();
  }
}

