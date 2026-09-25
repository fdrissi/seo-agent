import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createAppContext, type AppContext } from '../app/context.js';
import { credentialPathsFor, resolveGoogleAuthMode } from '../auth/providers.js';
import { systemClock, type Clock } from '../core/clock.js';
import { errorMessage, isAppError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { createLogger, silentLogger } from '../core/logger.js';
import { formatUsd } from '../core/money.js';
import type { RuntimeMode } from '../core/modes.js';
import { listSiteIds, loadSiteConfig, parseYamlSafe } from '../config/load.js';
import { appRoot, appVersion, resolveRealPath, siteConfigFile, siteVaultDir, type WorkspacePaths } from '../config/paths.js';
import { LayeredSecretStore, type SecretStore } from '../config/secrets.js';
import { siteConfigWarnings, type SiteConfig } from '../config/site-schema.js';
import { WORKSPACE_FORMAT_VERSION, isRepoPath, readManifest, type WorkspaceManifest } from '../config/workspace.js';
import { crawlerStatus } from '../crawler/status.js';
import type { CrawlerDeps } from '../crawler/deps.js';
import { playwrightAvailability, type PlaywrightLoader } from '../crawler/render.js';
import { openDatabase, type Db } from '../database/db.js';
import { migrationStatus } from '../database/migrate.js';
import { apifyStatus } from '../integrations/apify/status.js';
import { dataforseoStatus } from '../integrations/dataforseo/status.js';
import { googleStatus } from '../integrations/google/status.js';
import { createLlmClient } from '../integrations/llm/gateway.js';
import { llmStatus } from '../integrations/llm/status.js';
import { performanceStatuses } from '../integrations/pagespeed/status.js';
import type { FetchLike, IntegrationId, IntegrationState, IntegrationStatus } from '../integrations/types.js';
import { createDefaultRegistry } from '../jobs/handlers.js';
import { listSiteLocks } from '../jobs/locks.js';
import { describeSchedules } from '../jobs/scheduler.js';
import { listJobs } from '../jobs/store.js';
import { memoryStatus } from '../memory/service.js';
import { vaultIntegrationStatus } from '../obsidian/status.js';
import { redactString } from '../security/redact.js';
import { REINSTALL_STEPS, buildRepairSteps, checkBuildFreshness, runningBuildFreshness, scheduledRunBuildProblem, type BuildFreshness } from './build-info.js';
import { listDrafts } from './draft.js';

/**
 * `doctor` (spec section 29): an honest, read-mostly health check.
 *
 * - Default: NO network requests at all. Every provider adapter gets a fetch
 *   that refuses and records the attempt, so a regression cannot silently go
 *   online.
 * - `--network`: only the slices' free, read-only status checks.
 * - Chargeable checks only with an explicit spend allowance and cap: at most
 *   one minimal LLM Gateway request whose cost upper bound is capped (and
 *   reserved against the budget) by the LLM client. Nothing else is ever
 *   charged by doctor.
 * - Never applies migrations. When the workspace database is missing or not
 *   current, integration checks run against a temporary in-memory database
 *   and say so.
 */

export type CheckLevel = 'ok' | 'info' | 'warn' | 'fail';
export type CheckGroup = 'runtime' | 'workspace' | 'config' | 'database' | 'integrations' | 'jobs' | 'spend';

export interface DoctorCheck {
  id: string;
  group: CheckGroup;
  siteId?: string;
  level: CheckLevel;
  title: string;
  detail: string;
  nextStep?: string;
}

export interface NetworkEntry {
  method: string;
  host: string;
  path: string;
}

export interface DoctorSiteReport {
  siteId: string;
  profile: SiteConfig['profile'];
  database: 'workspace' | 'temporary';
  integrations: IntegrationStatus[];
}

export interface DoctorSpendCheck {
  siteId: string;
  name: string;
  status: 'succeeded' | 'failed' | 'skipped' | 'dry_run';
  capUsd: string;
  cost: string | null;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  generatedAt: string;
  appVersion: string;
  workspace: { root: string; exists: boolean; kind: WorkspaceManifest['kind'] | null };
  network: { requested: boolean; allowed: boolean; requests: NetworkEntry[]; blocked: NetworkEntry[] };
  spend: { allowed: boolean; capUsd: string | null; checks: DoctorSpendCheck[] };
  counts: Record<CheckLevel, number>;
  checks: DoctorCheck[];
  sites: DoctorSiteReport[];
  nextSteps: string[];
}

/**
 * Doctor never runs paid Apify or DataForSEO requests. The owner's explicit commands for them
 * (paid Apify runs need --mode RESEARCH plus --confirm-spend and a cap; the DataForSEO sandbox is free).
 */
export const PAID_TESTS_NOTE =
  'Apify and DataForSEO paid tests are never run by doctor: run one minimal paid Apify test with `npm run cli -- apify test --mode RESEARCH --confirm-spend --max-usd <cap>` (bounded content research: `npm run cli -- apify research --mode RESEARCH --confirm-spend --max-usd <cap>`), or check DataForSEO for free with `npm run cli -- research keyword <query> --sandbox`.';

export interface DoctorOptions {
  paths: WorkspacePaths;
  env?: NodeJS.ProcessEnv;
  secrets?: SecretStore;
  /** Only this site (default: every configured site). */
  siteId?: string | undefined;
  /** Allow free, read-only network checks. */
  network: boolean;
  /** --offline: forbid every network request (overrides network). */
  offline?: boolean;
  /** Allow one chargeable check with this cap (micro-USD). Requires network. */
  spend?: { capMicros: number } | null;
  dryRun?: boolean;
  mode?: RuntimeMode;
  /** The real fetch used when network is allowed (default: global fetch). */
  fetch?: FetchLike;
  clock?: Clock;
  node?: { version: string; lts: string | null };
  crawlerDeps?: CrawlerDeps;
  playwrightLoader?: PlaywrightLoader;
  /**
   * --server: apply the server checklist (docs/DEPLOYMENT.md). A workspace
   * root, data/ directory, or database readable by group or others is then a
   * FAIL instead of a WARN.
   */
  server?: boolean;
  /**
   * Build freshness (default: computed). `running` is the compiled build this
   * process runs from (null when running from the TypeScript sources); `dist`
   * is the application's dist/ that `schedule instructions` would use.
   */
  build?: { running: BuildFreshness | null; dist: BuildFreshness };
}

const STATE_LEVEL: Record<IntegrationState, CheckLevel> = {
  ready: 'ok',
  configured_unverified: 'info',
  fixture: 'info',
  disabled: 'info',
  missing_credentials: 'warn',
  unresolved: 'warn',
  degraded: 'warn',
  unreachable: 'warn',
  misconfigured: 'fail',
  permission_denied: 'fail',
};

export function levelForState(state: IntegrationState): CheckLevel {
  return STATE_LEVEL[state] ?? 'warn';
}

/** Minimum Node major version from package.json engines (never hardcoded here). */
export function requiredNodeMajor(): number | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(appRoot(), 'package.json'), 'utf8')) as { engines?: { node?: string } };
    const m = /(\d+)/.exec(pkg.engines?.node ?? '');
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export function nodeCheck(node: { version: string; lts: string | null }, minMajor: number | null = requiredNodeMajor()): DoctorCheck {
  const v = node.version.replace(/^v/, '');
  const major = Number(v.split('.')[0]);
  const base = { id: 'runtime.node', group: 'runtime' as const, title: 'Node.js version' };
  const schedule = 'Release lines and their Active/Maintenance LTS dates: https://nodejs.org/en/about/previous-releases';
  if (minMajor !== null && major < minMajor) {
    return { ...base, level: 'fail', detail: `Node ${v} is older than the supported minimum (${minMajor}.x, package.json engines).`, nextStep: `Install a current Node.js LTS release (${minMajor} or newer). ${schedule}` };
  }
  if (node.lts) return { ...base, level: 'ok', detail: `Node ${v} is an LTS release ("${node.lts}"). Whether it is in Active or Maintenance LTS depends on the date: ${schedule}` };
  if (major % 2 === 1) return { ...base, level: 'warn', detail: `Node ${v} is an odd-numbered release line, which never becomes LTS.`, nextStep: `Use an Active LTS release. ${schedule}` };
  return { ...base, level: 'warn', detail: `Node ${v} is a "Current" release, not (yet) an LTS release. It is supported by package.json engines, but Active LTS is recommended for a long-running installation.`, nextStep: `Prefer the Active LTS release line. ${schedule}` };
}

function builtFrom(f: BuildFreshness): string {
  return f.info ? `v${f.info.version}, built ${f.info.builtAt}${f.info.gitRevision ? `, Git ${f.info.gitRevision.slice(0, 12)}${f.info.gitDirty ? ' with uncommitted changes' : ''}` : ''}` : 'no build stamp';
}

function compareNotes(f: BuildFreshness): string {
  const notes: string[] = [];
  if (f.sourcesMatch === null) notes.push('src/ is not present here, so the sources were not compared');
  if (f.migrations.match === null) notes.push(f.info && !f.info.migrations ? 'the stamp has no migration list (migrations/ was missing at build time), so migrations were not compared' : 'migrations were not compared');
  return notes.length ? ` Note: ${notes.join('; ')}.` : '';
}

/**
 * Is the compiled build (dist/) current? `running` is the build this process
 * runs from (null when running from the TypeScript sources); `dist` is the
 * application's dist/ that `schedule instructions` would point a scheduler at.
 */
export function buildFreshnessCheck(build: { running: BuildFreshness | null; dist: BuildFreshness }): DoctorCheck {
  const base = { id: 'runtime.build', group: 'runtime' as const, title: 'Compiled build (dist/)' };
  const r = build.running;
  if (r) {
    if (r.state === 'fresh') {
      const notes = compareNotes(r);
      return { ...base, level: notes ? 'info' : 'ok', detail: `This process runs the compiled build in ${r.distDir} (${builtFrom(r)}); it matches package.json${r.sourcesMatch ? ', src/,' : ''}${r.migrations.match ? ' and migrations/' : ''}.${notes}` };
    }
    const problem = scheduledRunBuildProblem(r);
    return {
      ...base,
      level: problem ? 'fail' : 'warn',
      detail: `This process runs ${r.state === 'unstamped' ? 'an unstamped' : 'an out-of-date'} compiled build in ${r.distDir} (${builtFrom(r)}): ${r.reasons.join('; ')}. ${problem ? '`schedule run` refuses to start from it, and it applies no migration it was not built with.' : 'It runs the old compiled code.'}`,
      // A checkout is rebuilt; a packaged install or container image (no src/) is reinstalled or upgraded.
      nextStep: buildRepairSteps(r),
    };
  }
  const d = build.dist;
  if (d.state === 'not_built') {
    return { ...base, level: 'info', detail: `No compiled build (${d.entry} does not exist); commands run from the TypeScript sources through tsx. For unattended scheduling a built install is preferred: \`npm run build\`.` };
  }
  if (d.state === 'fresh') {
    const notes = compareNotes(d);
    return { ...base, level: notes ? 'info' : 'ok', detail: `${d.distDir} (${builtFrom(d)}) matches package.json, src/, and migrations/; scheduled commands can use it.${notes}` };
  }
  const repair = buildRepairSteps(d);
  const fallback = repair === REINSTALL_STEPS ? 'and this installation has no src/ directory to fall back to, so it must be reinstalled or upgraded' : 'and `schedule instructions` falls back to the sources until it is rebuilt';
  return {
    ...base,
    level: 'warn',
    detail: `${d.distDir} is ${d.state === 'unstamped' ? 'unstamped' : 'out of date'} (${builtFrom(d)}): ${d.reasons.join('; ')}. A scheduler that runs dist/cli/main.js executes old code; \`schedule run\` refuses a build that is unstamped or does not match migrations/, ${fallback}.`,
    nextStep: repair,
  };
}

function defaultBuildState(): { running: BuildFreshness | null; dist: BuildFreshness } {
  const running = runningBuildFreshness();
  return { running, dist: running ?? checkBuildFreshness({ appRoot: appRoot() }) };
}

interface BreakerRow {
  provider: string;
  state: 'open' | 'half_open';
  consecutive_failures: number;
  opened_at: string | null;
  next_probe_at: string | null;
  last_error: string | null;
}

/**
 * Open and half-open provider circuit breakers of one site (read-only SQL on
 * `circuit_breakers`), with the command that resets one after the cause is fixed.
 */
export function circuitBreakerChecks(db: Db, siteId: string): DoctorCheck[] {
  const rows = db.all<BreakerRow>(
    "SELECT provider, state, consecutive_failures, opened_at, next_probe_at, last_error FROM circuit_breakers WHERE site_id = ? AND state IN ('open', 'half_open') ORDER BY provider",
    [siteId],
  );
  if (!rows.length) return [{ id: 'jobs.breakers', group: 'jobs', siteId, level: 'ok', title: 'Circuit breakers', detail: 'No provider circuit breaker is open or half-open.' }];
  return rows.map((r) => {
    const provider = /^[A-Za-z0-9_.-]+$/.test(r.provider) ? r.provider : JSON.stringify(r.provider);
    return {
      id: 'jobs.breakers',
      group: 'jobs' as const,
      siteId,
      level: 'warn' as const,
      title: `Circuit breaker ${r.provider}`,
      detail: `${r.state === 'open' ? 'OPEN' : 'HALF-OPEN'} after ${r.consecutive_failures} consecutive provider failure(s)${r.opened_at ? ` (opened ${r.opened_at})` : ''}; next probe ${r.next_probe_at ?? 'not scheduled'}; last error: ${r.last_error ? redactString(r.last_error).slice(0, 300) : 'none recorded'}. Requests to ${r.provider} are refused until a probe succeeds.`,
      nextStep: `npm run cli -- jobs breakers --reset ${provider} --site ${siteId}   (after fixing the cause; \`npm run cli -- jobs breakers\` lists all breakers)`,
    };
  });
}

function modeOf(p: string): number | null {
  try {
    return statSync(p).mode & 0o777;
  } catch {
    return null;
  }
}

/**
 * Workspace root, data/, and the database (with its -wal/-shm/-journal files)
 * must not be accessible by group or others: they hold analytics, approvals,
 * and the audit log. WARN on a workstation, FAIL with --server.
 */
export function privateDataPermissionChecks(paths: WorkspacePaths, opts: { server?: boolean; platform?: NodeJS.Platform } = {}): DoctorCheck[] {
  if ((opts.platform ?? process.platform) === 'win32') return [];
  const level: CheckLevel = opts.server ? 'fail' : 'warn';
  const checks: DoctorCheck[] = [];
  const rootMode = modeOf(paths.root);
  if (rootMode !== null && rootMode & 0o077) {
    checks.push({
      id: 'workspace.root-permissions',
      group: 'workspace',
      level,
      title: 'Workspace directory permissions',
      detail: `${paths.root} is accessible by other users (mode ${rootMode.toString(8)}). It holds private site data.${opts.server ? ' The server checklist requires 0700.' : ''}`,
      nextStep: `chmod 700 "${paths.root}"`,
    });
  }
  const problems: string[] = [];
  const fixes: string[] = [];
  const dataMode = modeOf(paths.dataDir);
  if (dataMode !== null && dataMode & 0o077) {
    problems.push(`${paths.dataDir} (mode ${dataMode.toString(8)})`);
    fixes.push(`chmod 700 "${paths.dataDir}"`);
  }
  const dbFiles = [paths.dbFile, ...['-wal', '-shm', '-journal'].map((s) => `${paths.dbFile}${s}`)];
  const loose = dbFiles.filter((f) => {
    const m = modeOf(f);
    if (m !== null && m & 0o077) {
      problems.push(`${f} (mode ${m.toString(8)})`);
      return true;
    }
    return false;
  });
  if (loose.length) fixes.push(`chmod 600 ${loose.map((f) => `"${f}"`).join(' ')}`);
  checks.push(
    problems.length
      ? {
          id: 'workspace.database-permissions',
          group: 'workspace',
          level,
          title: 'Database permissions',
          detail: `Accessible by other users: ${problems.join('; ')}. The database holds analytics, approvals, and the audit log.${loose.length ? ' seo-agent restores 0600 on the database files whenever it opens the database for writing; directories are never re-permissioned automatically.' : ''}${opts.server ? ' The server checklist requires data/ 0700 and the database 0600.' : ''}`,
          nextStep: fixes.join(' && '),
        }
      : { id: 'workspace.database-permissions', group: 'workspace', level: 'ok', title: 'Database permissions', detail: 'data/ is private and the database files are 0600 (or absent).' },
  );
  return checks;
}

function permissionChecks(paths: WorkspacePaths, server = false): DoctorCheck[] {
  if (process.platform === 'win32') {
    return [{ id: 'workspace.permissions', group: 'workspace', level: 'info', title: 'Secret file permissions', detail: 'POSIX permission checks are not available on Windows; keep the workspace in your user profile.' }];
  }
  const problems: string[] = [];
  const fixes: string[] = [];
  const dirMust = (p: string) => {
    const m = modeOf(p);
    if (m !== null && m & 0o077) {
      problems.push(`${p} is accessible by other users (mode ${m.toString(8)})`);
      fixes.push(`chmod 700 "${p}"`);
    }
  };
  const fileMust = (p: string) => {
    const m = modeOf(p);
    if (m !== null && m & 0o077) {
      problems.push(`${p} is accessible by other users (mode ${m.toString(8)})`);
      fixes.push(`chmod 600 "${p}"`);
    }
  };
  dirMust(paths.secretsDir);
  dirMust(paths.googleDir);
  fileMust(paths.secretsEnvFile);
  if (existsSync(paths.googleDir)) {
    for (const name of readdirSync(paths.googleDir)) {
      const p = path.join(paths.googleDir, name);
      try {
        if (lstatSync(p).isFile()) fileMust(p);
      } catch {
        /* vanished */
      }
    }
  }
  for (const d of listDrafts(paths)) fileMust(d.file);
  const checks: DoctorCheck[] = [];
  checks.push(
    problems.length
      ? { id: 'workspace.permissions', group: 'workspace', level: 'fail', title: 'Secret file permissions', detail: problems.join('; '), nextStep: fixes.join(' && ') }
      : { id: 'workspace.permissions', group: 'workspace', level: 'ok', title: 'Secret file permissions', detail: 'secrets/ and secrets/google/ are 0700; secrets.env, Google credential files, and setup drafts are 0600 (or absent).' },
  );
  checks.push(...privateDataPermissionChecks(paths, { server }));
  return checks;
}

function locationCheck(paths: WorkspacePaths): DoctorCheck {
  const locations: Array<[string, string]> = [
    ['workspace', paths.root],
    ['site configs', paths.sitesDir],
    ['secrets', paths.secretsDir],
    ['vaults', paths.vaultRoot],
    ['database', paths.dbFile],
    ['raw responses', paths.rawDir],
    ['qdrant storage', paths.qdrantDir],
    ['reports', paths.reportsDir],
    ['exports', paths.exportsDir],
    ['backups', paths.backupsDir],
    ['logs', paths.logsDir],
  ];
  // isRepoPath compares with symlinks resolved, so a workspace reached through a symlink into the repository is caught.
  const inside = locations.filter(([, p]) => isRepoPath(p));
  const realRoot = resolveRealPath(paths.root);
  const outsideRoot = locations.filter(([, p]) => {
    const real = resolveRealPath(p);
    return real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`);
  });
  if (inside.length) {
    return {
      id: 'workspace.locations',
      group: 'workspace',
      level: 'warn',
      title: 'Private data locations',
      detail: `Inside the application repository (could be committed or packaged): ${inside.map(([n, p]) => `${n} (${p})`).join(', ')}.`,
      nextStep: 'Move the workspace outside the repository (default ~/seo-agent-workspace; set SEO_AGENT_WORKSPACE).',
    };
  }
  const names = locations.slice(1).map(([n]) => n).join(', ');
  return {
    id: 'workspace.locations',
    group: 'workspace',
    level: 'ok',
    title: 'Private data locations',
    detail: `Outside the application repository: ${names} live under ${paths.root}${outsideRoot.length ? `, except ${outsideRoot.map(([n, p]) => `${n} (${p})`).join(', ')}` : ''}.`,
  };
}

export type DbState = { state: 'missing' } | { state: 'current'; applied: number } | { state: 'pending'; pending: string[] } | { state: 'unknown'; unknown: string[] } | { state: 'error'; message: string };

function databaseState(paths: WorkspacePaths): DbState {
  if (!existsSync(paths.dbFile)) return { state: 'missing' };
  let db: Db | null = null;
  try {
    db = openDatabase(paths.dbFile, { readOnly: true });
    const s = migrationStatus(db);
    if (s.unknown.length) return { state: 'unknown', unknown: s.unknown };
    if (s.pending.length) return { state: 'pending', pending: s.pending.map((m) => m.name) };
    return { state: 'current', applied: s.applied.length };
  } catch (err) {
    return { state: 'error', message: errorMessage(err) };
  } finally {
    db?.close();
  }
}

function databaseCheck(s: DbState): DoctorCheck {
  const base = { id: 'database.migrations', group: 'database' as const, title: 'Database schema' };
  switch (s.state) {
    case 'missing':
      return { ...base, level: 'warn', detail: 'The workspace database does not exist yet.', nextStep: 'npm run cli -- db migrate   (or `npm run cli -- init`)' };
    case 'current':
      return { ...base, level: 'ok', detail: `Up to date (${s.applied} migrations applied).` };
    case 'pending':
      return { ...base, level: 'warn', detail: `${s.pending.length} pending migration(s): ${s.pending.join(', ')}. doctor never migrates.`, nextStep: 'npm run cli -- db migrate   (a verified pre-migration backup is written first)' };
    case 'unknown':
      return { ...base, level: 'fail', detail: `The database contains migrations unknown to this application version (${s.unknown.join(', ')}): it was written by a newer version.`, nextStep: 'Upgrade the application (docs/UPGRADING.md); never downgrade a live workspace.' };
    default:
      return { ...base, level: 'fail', detail: `The database could not be read: ${s.message}`, nextStep: 'See docs/UPGRADING.md (recovery) and `npm run cli -- restore`.' };
  }
}

/** Versioned Search Console and GA4 metric tables (each has is_current and is_synthetic). Fixed identifiers. */
const SYNTHETIC_CHECK_TABLES = ['gsc_property_daily', 'gsc_page_daily', 'gsc_page_query_daily', 'ga4_landing_daily', 'ga4_event_daily', 'ga4_period_metrics'] as const;

interface SyntheticCurrentRows {
  table: string;
  siteId: string;
  rows: number;
  /** Up to five batches that wrote them, with their source ('import', 'gsc', 'ga4'). */
  batches: Array<{ id: string; source: string | null }>;
}

/** Current rows labeled synthetic (is_synthetic = 1) per table and site; a table or column this schema lacks is skipped. */
function syntheticCurrentRows(db: Db): SyntheticCurrentRows[] {
  const out: SyntheticCurrentRows[] = [];
  for (const table of SYNTHETIC_CHECK_TABLES) {
    try {
      for (const g of db.all<{ site_id: string; n: number }>(`SELECT site_id, COUNT(*) AS n FROM ${table} WHERE is_current = 1 AND is_synthetic = 1 GROUP BY site_id ORDER BY site_id`)) {
        const batches = db.all<{ id: string; source: string | null }>(
          `SELECT DISTINCT t.batch_id AS id, b.source AS source FROM ${table} t LEFT JOIN ingestion_batches b ON b.id = t.batch_id WHERE t.site_id = ? AND t.is_current = 1 AND t.is_synthetic = 1 ORDER BY t.batch_id LIMIT 5`,
          [g.site_id],
        );
        out.push({ table, siteId: g.site_id, rows: g.n, batches });
      }
    } catch {
      /* table or column absent in this schema version: nothing to check */
    }
  }
  return out;
}

/**
 * Demo/live separation of the database contents (spec 29): the sites
 * recorded in the workspace database must match the manifest kind. A demo
 * site (sites.is_demo = 1, synthetic data) in a live workspace, or a live site
 * in a demo workspace, usually comes from restoring a backup of the other
 * kind. A live workspace also fails when current Search Console or GA4 rows
 * are labeled synthetic (is_synthetic = 1), for example from a synthetic
 * `data import` that an older version accepted. Read-only; null when the
 * database is missing or unreadable (the schema check reports that).
 */
export function databaseSitesKindCheck(paths: WorkspacePaths, kind: WorkspaceManifest['kind'], s: DbState): DoctorCheck | null {
  if (s.state !== 'current' && s.state !== 'pending') return null;
  let rows: Array<{ id: string; is_demo: number }>;
  let synthetic: SyntheticCurrentRows[] = [];
  let db: Db | null = null;
  try {
    db = openDatabase(paths.dbFile, { readOnly: true });
    if (!db.get("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'sites'")) return null;
    rows = db.all<{ id: string; is_demo: number }>('SELECT id, is_demo FROM sites ORDER BY id');
    if (kind === 'live') synthetic = syntheticCurrentRows(db);
  } catch (err) {
    return { id: 'database.demo-live', group: 'database', level: 'warn', title: 'Demo/live data', detail: `Could not read the sites recorded in the database: ${errorMessage(err)}` };
  } finally {
    db?.close();
  }
  if (!rows.length) return null;
  const base = { id: 'database.demo-live', group: 'database' as const };
  if (kind === 'live') {
    const demo = rows.filter((r) => r.is_demo === 1).map((r) => r.id);
    if (demo.length) {
      return {
        ...base,
        level: 'fail',
        title: 'Demo data in a live workspace',
        detail: `The database records demo site(s) ${demo.join(', ')} (sites.is_demo = 1: synthetic data) although this is a live workspace. This usually means a demo backup was restored here; synthetic rows never belong in live reporting.`,
        nextStep: `Restore a backup of this live workspace (\`npm run cli -- restore --from <backup dir> --confirm\`; \`restore --from <dir>\` without --confirm lists a backup's sites). A restore saves the database it replaced as ${path.join(paths.backupsDir, 'pre-restore-<time>.sqlite')}.`,
      };
    }
    if (synthetic.length) {
      const total = synthetic.reduce((n, x) => n + x.rows, 0);
      const where = synthetic.map((x) => `${x.table} ${x.rows} (site ${x.siteId})`).join(', ');
      const batches = [...new Map(synthetic.flatMap((x) => x.batches).map((b) => [b.id, b])).values()];
      const fromImport = batches.some((b) => b.source === 'import');
      return {
        ...base,
        level: 'fail',
        title: 'Synthetic data in a live workspace',
        detail: `${total} current Search Console/GA4 row(s) in this live workspace's database are labeled synthetic (is_synthetic = 1): ${where}. Written by batch(es) ${batches.map((b) => `${b.id}${b.source ? ` (${b.source})` : ''}`).join(', ')}${fromImport ? '; a synthetic `data import` (for example a `data export` of a demo workspace) is refused in a live workspace now, but an older version accepted it' : ''}. Live reports built on these rows are marked SYNTHETIC; synthetic rows never belong in live reporting.`,
        nextStep: `Restore a backup of this live workspace taken before the synthetic rows arrived (\`npm run cli -- restore --from <backup dir> --confirm\`; \`restore --from <dir>\` without --confirm lists a backup's sites). A restore saves the database it replaced as ${path.join(paths.backupsDir, 'pre-restore-<time>.sqlite')}.${fromImport ? " Without such a backup, re-import the owner's real file(s) with `data import` (without --synthetic): a live row supersedes the synthetic revision of the same key; keys that only the synthetic file had stay synthetic until a restore." : ''}`,
      };
    }
  } else {
    const live = rows.filter((r) => r.is_demo !== 1).map((r) => r.id);
    if (live.length) {
      return {
        ...base,
        level: 'fail',
        title: 'Live data in a demo workspace',
        detail: `The database records live (non-demo) site(s) ${live.join(', ')} although this is a demo workspace; a demo refresh deletes this workspace.`,
        nextStep: 'Move the data to a live workspace: `npm run cli -- --workspace <dir> init`, then `npm run cli -- --workspace <dir> restore --from <backup dir> --confirm`.',
      };
    }
  }
  return { ...base, level: 'ok', title: 'Demo/live data', detail: `The ${rows.length} site(s) recorded in the database match this ${kind} workspace (${kind === 'live' ? 'no demo site and no current Search Console/GA4 row labeled synthetic' : 'demo sites only'}).` };
}

function statusToCheck(s: IntegrationStatus, siteId: string): DoctorCheck {
  return {
    id: `integration.${s.id}`,
    group: 'integrations',
    siteId,
    level: levelForState(s.state),
    title: s.id,
    detail: `${s.state}: ${s.detail}${s.networkChecked ? ' (network checked)' : ''}`,
    ...(s.nextStep ? { nextStep: s.nextStep } : {}),
  };
}

async function safeStatuses(id: IntegrationId, ctx: AppContext, fn: () => Promise<IntegrationStatus[]>): Promise<IntegrationStatus[]> {
  try {
    return await fn();
  } catch (err) {
    return [
      {
        id,
        state: 'degraded',
        detail: `The status check itself failed: ${errorMessage(err)}`,
        ...(isAppError(err) && err.hint ? { nextStep: err.hint } : {}),
        sendsExternally: [],
        checkedAt: ctx.clock.now().toISOString(),
        networkChecked: false,
        chargeable: false,
      },
    ];
  }
}

interface NetworkLog {
  requests: NetworkEntry[];
  blocked: NetworkEntry[];
}

function describeRequest(input: string | URL, init?: RequestInit): NetworkEntry {
  const method = (init?.method ?? 'GET').toUpperCase();
  try {
    const u = new URL(String(input));
    // Host and path only: query strings can carry API keys.
    return { method, host: u.host, path: u.pathname };
  } catch {
    return { method, host: '(invalid url)', path: '' };
  }
}

/** A fetch that records every request and refuses all of them unless network checks are allowed. */
export function doctorFetch(allowed: boolean, base: FetchLike, log: NetworkLog): FetchLike {
  return async (input, init) => {
    const entry = describeRequest(input, init);
    if (!allowed) {
      log.blocked.push(entry);
      throw Object.assign(new Error(`doctor: network access is disabled (attempted ${entry.method} ${entry.host}${entry.path}); pass --network for free read-only checks`), { code: 'OFFLINE' });
    }
    log.requests.push(entry);
    return base(input, init);
  };
}

async function siteChecks(
  opts: DoctorOptions,
  siteId: string,
  config: SiteConfig,
  secrets: SecretStore,
  dbState: DbState,
  fetchFn: FetchLike,
  netAllowed: boolean,
  checks: DoctorCheck[],
  spend: DoctorReport['spend'],
  log: NetworkLog,
): Promise<DoctorSiteReport> {
  const clock = opts.clock ?? systemClock;
  const useWorkspaceDb = dbState.state === 'current';
  const tempDb = useWorkspaceDb ? null : openDatabase(':memory:');
  // Logs go to the workspace log file only (the report is the output). A temporary database's
  // own migration messages are not logged at all: they describe a throwaway database.
  const fileLogger = createLogger({ file: path.join(opts.paths.logsDir, 'seo-agent.log'), console: false, base: { site: siteId, component: 'doctor' } });
  const ctx = createAppContext({
    workspaceRoot: opts.paths.root,
    siteId,
    config,
    secrets,
    clock,
    logger: tempDb ? silentLogger : fileLogger,
    fetch: fetchFn,
    // Demo (synthetic) sites never touch the network, whatever the flags say.
    offline: !!opts.offline || config.profile === 'demo',
    ...(opts.mode ? { mode: opts.mode } : {}),
    dryRun: !!opts.dryRun,
    runId: newId('run_doctor'),
    ...(tempDb ? { db: tempDb, prepareDatabase: 'migrate' as const } : { prepareDatabase: opts.dryRun ? ('verify' as const) : ('migrate' as const), migrate: false }),
  });
  ctx.logger = fileLogger;
  const statuses: IntegrationStatus[] = [];
  const add = (list: IntegrationStatus[]) => {
    for (const s of list) {
      statuses.push(s);
      checks.push(statusToCheck(s, siteId));
    }
  };
  try {
    if (!useWorkspaceDb) {
      checks.push({
        id: 'database.temporary',
        group: 'database',
        siteId,
        level: 'info',
        title: 'Integration checks without the workspace database',
        detail: 'The workspace database is missing or not current, so these checks used a temporary empty database: stored details (verified Apify schema, pending DataForSEO tasks, last crawl, jobs) are not reflected.',
      });
    }
    const network = netAllowed;
    // Google auth mode (GOOGLE_AUTH_MODE validation).
    try {
      const mode = resolveGoogleAuthMode(ctx);
      let detail = `GOOGLE_AUTH_MODE resolves to "${mode}" (${secrets.sourceOf('GOOGLE_AUTH_MODE')}).`;
      if (mode !== 'fixture') {
        const cp = credentialPathsFor(ctx);
        detail += mode === 'oauth' ? ` OAuth client file: ${cp.clientFile}; token file: ${cp.tokenFile}.` : ` Service-account credentials: ${cp.serviceAccountFile ?? 'Application Default Credentials'}.`;
      }
      checks.push({ id: 'google.auth-mode', group: 'config', siteId, level: 'ok', title: 'Google auth mode', detail });
    } catch (err) {
      checks.push({ id: 'google.auth-mode', group: 'config', siteId, level: 'fail', title: 'Google auth mode', detail: errorMessage(err), ...(isAppError(err) && err.hint ? { nextStep: err.hint } : {}) });
    }
    add(await safeStatuses('google_auth', ctx, () => googleStatus(ctx, { network })));
    add(
      await safeStatuses('crawler', ctx, async () => {
        const r = await crawlerStatus(ctx, { network, ...(opts.crawlerDeps ?? {}), ...(opts.playwrightLoader ? { playwrightLoader: opts.playwrightLoader } : {}) });
        // The crawler uses its own SSRF-safe transport (not the provider fetch); record its robots.txt check too.
        if (r.crawler.networkChecked) log.requests.push({ method: 'GET', host: new URL(config.site.url).host, path: '/robots.txt' });
        if (r.lastCrawl) {
          checks.push({ id: 'crawler.last', group: 'integrations', siteId, level: 'info', title: 'Last crawl', detail: `${r.lastCrawl.kind} crawl ${r.lastCrawl.status} (started ${r.lastCrawl.startedAt}; ${r.lastCrawl.pagesFetched} pages fetched, ${r.lastCrawl.pagesBlocked} blocked${r.lastCrawl.stopReason ? `; stopped: ${r.lastCrawl.stopReason}` : ''}).` });
        }
        return [r.crawler as IntegrationStatus, r.playwright];
      }),
    );
    add(await safeStatuses('pagespeed', ctx, () => performanceStatuses(ctx, { network })));
    add(await safeStatuses('llm_gateway', ctx, async () => [await llmStatus(ctx, { network })]));
    add(
      await safeStatuses('qdrant', ctx, async () => {
        const m = await memoryStatus(ctx, { network });
        if (!network && ctx.settings.features.qdrant && !ctx.offline) {
          checks.push({ id: 'qdrant.health', group: 'integrations', siteId, level: 'info', title: 'Qdrant health', detail: `Not checked (no network). \`doctor --network\` makes one free GET to ${ctx.settings.qdrantUrl}.` });
        } else if (m.qdrant.health) {
          checks.push({ id: 'qdrant.health', group: 'integrations', siteId, level: m.qdrant.health.ok ? 'ok' : 'warn', title: 'Qdrant health', detail: m.qdrant.health.ok ? `Reachable at ${m.qdrant.url}.` : `Not reachable at ${m.qdrant.url}: ${m.qdrant.health.detail}`, ...(m.qdrant.health.ok ? {} : { nextStep: 'docker compose up -d qdrant' }) });
        }
        for (const w of m.qdrant.warnings) checks.push({ id: 'qdrant.warning', group: 'integrations', siteId, level: 'warn', title: 'Qdrant', detail: w });
        return [m.integration];
      }),
    );
    add(await safeStatuses('dataforseo', ctx, async () => [await dataforseoStatus(ctx, { network })]));
    add(await safeStatuses('apify', ctx, async () => [await apifyStatus(ctx, { network })]));
    add(
      await safeStatuses('obsidian', ctx, async () => {
        const vaultDir = siteVaultDir(ctx.paths, siteId);
        const st = vaultIntegrationStatus(ctx, vaultDir);
        // Presence: a missing vault gets the exact setup command (plain Markdown; Obsidian itself is optional).
        if (st.state === 'degraded' && !existsSync(vaultDir)) return [{ ...st, detail: `No vault at ${vaultDir} yet (plain Markdown; Obsidian itself is optional).`, nextStep: `npm run cli -- setup vault --site ${siteId}   (never overwrites)` }];
        return [st];
      }),
    );

    if (useWorkspaceDb) jobChecks(ctx, checks);

    if (spend.allowed && opts.spend && !spend.checks.length) {
      spend.checks.push(await llmSpendCheck(ctx, statuses, opts.spend.capMicros, !!opts.dryRun));
    }
  } finally {
    ctx.db.close();
  }
  return { siteId, profile: config.profile, database: useWorkspaceDb ? 'workspace' : 'temporary', integrations: statuses };
}

function jobChecks(ctx: AppContext, checks: DoctorCheck[]): void {
  const siteId = ctx.siteId;
  try {
    const overview = describeSchedules(ctx, createDefaultRegistry());
    for (const v of overview.schedules) {
      if (v.enabled && !v.handlerRegistered) {
        checks.push({ id: `schedule.${v.jobType}`, group: 'jobs', siteId, level: 'warn', title: `${v.jobType} schedule`, detail: `Enabled, but no ${v.jobType} job handler is registered in this build; due slots are skipped.`, nextStep: `npm run cli -- schedule disable ${v.jobType}   (until the pipeline is available)` });
      } else if (v.enabled) {
        checks.push({ id: `schedule.${v.jobType}`, group: 'jobs', siteId, level: 'ok', title: `${v.jobType} schedule`, detail: `Enabled; next run ${v.nextRunLocal ?? 'not computed yet'} (${v.schedule?.timezone ?? overview.configTimezone}). Something must run \`schedule run\` for it to fire.` });
      } else {
        checks.push({ id: `schedule.${v.jobType}`, group: 'jobs', siteId, level: 'info', title: `${v.jobType} schedule`, detail: `Not enabled (scheduling is opt-in${v.configPreference.enabled ? '; the site config prefers it' : ''}).` });
      }
      for (const d of v.drift) checks.push({ id: `schedule.${v.jobType}.drift`, group: 'jobs', siteId, level: 'info', title: `${v.jobType} schedule`, detail: d });
      if (v.blockedBy && !v.blockedBy.autoResume) {
        checks.push({ id: `schedule.${v.jobType}.blocked`, group: 'jobs', siteId, level: 'warn', title: `${v.jobType} schedule`, detail: v.blockedBy.detail, nextStep: `npm run cli -- jobs resume ${v.blockedBy.jobId}   (or jobs cancel ${v.blockedBy.jobId})` });
      }
    }
    const open = listJobs(ctx.db, siteId, { status: ['interrupted', 'waiting', 'running', 'queued'], limit: 50 });
    const failed = listJobs(ctx.db, siteId, { status: 'failed', limit: 5 });
    const interrupted = open.filter((j) => j.status === 'interrupted');
    const locks = listSiteLocks(ctx.db, siteId);
    const parts = [`${open.length} open job(s)`, `${interrupted.length} interrupted`, `${failed.length} recent failure(s)`, `${locks.length} active lock(s)`];
    checks.push({
      id: 'jobs.state',
      group: 'jobs',
      siteId,
      level: interrupted.length ? 'warn' : 'ok',
      title: 'Jobs',
      detail: `${parts.join(', ')}.${failed[0] ? ` Latest failure: ${failed[0].type} ${failed[0].id} (${failed[0].error?.message ?? 'no message'}).` : ''}`,
      ...(interrupted[0] ? { nextStep: `npm run cli -- jobs resume ${interrupted[0].id}   (resumes from its last checkpoint)` } : {}),
    });
  } catch (err) {
    checks.push({ id: 'jobs.state', group: 'jobs', siteId, level: 'warn', title: 'Jobs', detail: `Could not read job state: ${errorMessage(err)}` });
  }
  try {
    checks.push(...circuitBreakerChecks(ctx.db, siteId));
  } catch (err) {
    checks.push({ id: 'jobs.breakers', group: 'jobs', siteId, level: 'warn', title: 'Circuit breakers', detail: `Could not read circuit breakers: ${errorMessage(err)}` });
  }
}

async function llmSpendCheck(ctx: AppContext, statuses: IntegrationStatus[], capMicros: number, dryRun: boolean): Promise<DoctorSpendCheck> {
  const cap = formatUsd(capMicros);
  const base = { siteId: ctx.siteId, name: 'LLM Gateway minimal completion (cheap tier)', capUsd: cap };
  const llm = statuses.find((s) => s.id === 'llm_gateway');
  if (!llm || !['ready', 'configured_unverified', 'degraded'].includes(llm.state) || !ctx.settings.models.cheap) {
    return { ...base, status: 'skipped', cost: null, detail: `Not run: the LLM Gateway is ${llm?.state ?? 'not checked'}${ctx.settings.models.cheap ? '' : ' and CHEAP_MODEL is not set'}. Nothing was spent.` };
  }
  if (dryRun) return { ...base, status: 'dry_run', cost: null, detail: `Dry run: would send one minimal request to ${ctx.settings.models.cheap} with its cost upper bound capped at ${cap}. Nothing was sent.` };
  const client = createLlmClient(ctx, { maxCostPerRequestMicros: capMicros });
  const r = await client.text({ siteId: ctx.siteId, runId: ctx.runId, role: 'extractor', tier: 'cheap', promptId: 'system.connection-test', variables: {}, evidence: [], maxOutputTokens: 16 });
  if (r.ok) {
    return { ...base, status: 'succeeded', cost: r.costMicros === null ? 'unknown (kept reserved until reconciled; never counted as $0; settle it from the gateway usage log: `npm run cli -- costs --unresolved` lists it with its `costs reconcile` command)' : formatUsd(r.costMicros), detail: `Model ${r.model} answered (${r.usage.inputTokens ?? '?'} input / ${r.usage.outputTokens ?? '?'} output tokens).` };
  }
  return { ...base, status: 'failed', cost: null, detail: `[${r.status}] ${r.reason}${r.nextStep ? ` Next step: ${r.nextStep}` : ''}` };
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const clock = opts.clock ?? systemClock;
  const paths = opts.paths;
  const checks: DoctorCheck[] = [];
  const netRequested = opts.network || !!opts.spend;
  const netAllowed = netRequested && !opts.offline;
  const log: NetworkLog = { requests: [], blocked: [] };
  const baseFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const fetchFn = doctorFetch(netAllowed, baseFetch, log);
  const spend: DoctorReport['spend'] = { allowed: !!opts.spend && netAllowed, capUsd: opts.spend ? formatUsd(opts.spend.capMicros) : null, checks: [] };
  const sites: DoctorSiteReport[] = [];

  // Runtime
  checks.push(nodeCheck(opts.node ?? { version: process.version, lts: (process.release as { lts?: string }).lts ?? null }));
  try {
    checks.push(buildFreshnessCheck(opts.build ?? defaultBuildState()));
  } catch (err) {
    checks.push({ id: 'runtime.build', group: 'runtime', level: 'warn', title: 'Compiled build (dist/)', detail: `Could not check the compiled build: ${errorMessage(err)}` });
  }
  const pw = await playwrightAvailability(opts.playwrightLoader);
  checks.push({ id: 'runtime.playwright', group: 'runtime', level: 'info', title: 'Playwright (optional)', detail: pw.available ? pw.detail : pw.detail.replace(/^optional-disabled: /, ''), ...(pw.available || !pw.nextStep ? {} : { nextStep: pw.nextStep }) });
  if (opts.offline && opts.network) checks.push({ id: 'runtime.offline', group: 'runtime', level: 'info', title: 'Network', detail: '--offline overrides --network: no network checks were made.' });

  // Workspace
  let manifest: WorkspaceManifest | null = null;
  try {
    manifest = readManifest(paths);
  } catch (err) {
    checks.push({ id: 'workspace.manifest', group: 'workspace', level: 'fail', title: 'Workspace', detail: errorMessage(err), ...(isAppError(err) && err.hint ? { nextStep: err.hint } : {}) });
  }
  const exists = !!manifest;
  if (!manifest) {
    if (!checks.some((c) => c.id === 'workspace.manifest')) {
      checks.push({ id: 'workspace.manifest', group: 'workspace', level: 'fail', title: 'Workspace', detail: `No workspace at ${paths.root}.`, nextStep: 'npm run cli -- init   (or `npm run demo` to try the synthetic demo in its own workspace)' });
    }
  } else if (manifest.formatVersion > WORKSPACE_FORMAT_VERSION) {
    checks.push({ id: 'workspace.manifest', group: 'workspace', level: 'fail', title: 'Workspace', detail: `Workspace format ${manifest.formatVersion} is newer than this application supports (${WORKSPACE_FORMAT_VERSION}).`, nextStep: 'Upgrade the application (docs/UPGRADING.md); never downgrade a live workspace.' });
    manifest = null;
  } else if (manifest.formatVersion < WORKSPACE_FORMAT_VERSION) {
    checks.push({ id: 'workspace.manifest', group: 'workspace', level: 'fail', title: 'Workspace', detail: `Workspace format ${manifest.formatVersion} is older than this application uses (${WORKSPACE_FORMAT_VERSION}); commands refuse it until it is migrated.`, nextStep: 'npm run cli -- config migrate   (shows the diff; `--yes` applies it after a backup)' });
    manifest = null;
  } else {
    checks.push({ id: 'workspace.manifest', group: 'workspace', level: 'ok', title: 'Workspace', detail: `${paths.root} (${manifest.kind} workspace, format ${manifest.formatVersion}).` });
    try {
      accessSync(paths.root, constants.W_OK);
      checks.push({ id: 'workspace.writable', group: 'workspace', level: 'ok', title: 'Workspace writable', detail: 'The workspace directory is writable.' });
    } catch {
      checks.push({ id: 'workspace.writable', group: 'workspace', level: 'fail', title: 'Workspace writable', detail: `${paths.root} is not writable by this user.`, nextStep: `Fix ownership/permissions of ${paths.root}.` });
    }
    checks.push(...permissionChecks(paths, !!opts.server));
    checks.push(locationCheck(paths));
  }

  if (manifest) {
    const secrets = opts.secrets ?? new LayeredSecretStore(paths.secretsEnvFile, opts.env ?? process.env);
    // Config
    const allIds = listSiteIds(paths);
    const ids = opts.siteId ? [opts.siteId] : allIds;
    for (const d of listDrafts(paths)) {
      checks.push({ id: 'config.draft', group: 'config', siteId: d.siteId, level: 'warn', title: 'Unfinished setup', detail: `An unfinished setup draft exists for "${d.siteId}" (${d.answered} step(s) answered).`, nextStep: `npm run cli -- setup --site ${d.siteId}${d.mode === 'update' ? ' --update' : ''}   (resumes where it stopped)` });
    }
    if (!allIds.length) {
      checks.push({ id: 'config.sites', group: 'config', level: 'fail', title: 'Site configuration', detail: 'No site is configured in this workspace.', nextStep: 'npm run cli -- setup   (or `setup --from <file.yaml>` to import a prepared config)' });
    }
    const dbState = databaseState(paths);
    checks.push(databaseCheck(dbState));
    const kindCheck = databaseSitesKindCheck(paths, manifest.kind, dbState);
    if (kindCheck) checks.push(kindCheck);
    for (const id of ids) {
      if (opts.siteId && !allIds.includes(id)) {
        checks.push({ id: 'config.site', group: 'config', siteId: id, level: 'fail', title: 'Site configuration', detail: `No site config for "${id}" (${siteConfigFile(paths, id)}).`, nextStep: `npm run cli -- setup --site ${id}` });
        continue;
      }
      let config: SiteConfig;
      try {
        config = loadSiteConfig(paths, id);
      } catch (err) {
        const errors = (isAppError(err) ? (err.details as { errors?: string[] } | undefined)?.errors : undefined) ?? [];
        checks.push({ id: 'config.site', group: 'config', siteId: id, level: 'fail', title: 'Site configuration', detail: `${errorMessage(err)}${errors.length ? `: ${errors.join('; ')}` : ''}`, nextStep: `Fix ${siteConfigFile(paths, id)} (\`npm run cli -- config validate\` lists the fields), or run \`npm run cli -- setup --update --site ${id}\`.` });
        continue;
      }
      let warnings: string[] = [];
      try {
        const file = siteConfigFile(paths, id);
        warnings = siteConfigWarnings(parseYamlSafe(readFileSync(file, 'utf8'), file), config);
      } catch {
        warnings = [];
      }
      checks.push({ id: 'config.site', group: 'config', siteId: id, level: 'ok', title: 'Site configuration', detail: `Valid (profile ${config.profile}).` });
      for (const w of warnings) checks.push({ id: 'config.warning', group: 'config', siteId: id, level: 'warn', title: 'Site configuration', detail: w });
      // Demo/live separation: every command refuses these combinations (createAppContext), so doctor reports them as failures.
      if (config.profile === 'demo' && manifest.kind === 'live') {
        checks.push({ id: 'config.demo-in-live', group: 'config', siteId: id, level: 'fail', title: 'Demo profile in a live workspace', detail: 'This site uses the demo profile (synthetic fixtures) inside a live workspace; every command refuses to run it, so synthetic data never enters live reporting.', nextStep: `Remove ${siteConfigFile(paths, id)} from this live workspace and use \`npm run demo\` (isolated demo workspace), or switch it to a core/full profile with real settings.` });
        continue;
      }
      if (config.profile !== 'demo' && manifest.kind === 'demo') {
        checks.push({ id: 'config.live-in-demo', group: 'config', siteId: id, level: 'fail', title: 'Live profile in a demo workspace', detail: `This site uses the ${config.profile} profile inside a demo workspace; every command refuses to run it, and a demo refresh would refuse to delete it.`, nextStep: `Create a live workspace (\`npm run cli -- --workspace <dir> init\`) and move ${siteConfigFile(paths, id)} there with \`setup --from\`.` });
        continue;
      }
      try {
        sites.push(await siteChecks(opts, id, config, secrets, dbState, fetchFn, netAllowed, checks, spend, log));
      } catch (err) {
        checks.push({ id: 'integrations.site', group: 'integrations', siteId: id, level: 'fail', title: 'Integration checks', detail: `Could not run the integration checks: ${errorMessage(err)}`, ...(isAppError(err) && err.hint ? { nextStep: err.hint } : {}) });
      }
    }
    for (const w of secrets.warnings()) {
      if (!checks.some((c) => c.id === 'workspace.permissions' && c.level === 'fail')) checks.push({ id: 'workspace.secrets', group: 'workspace', level: 'warn', title: 'Secrets file', detail: w });
    }
  }

  // Spending summary
  if (opts.spend && !netAllowed) {
    checks.push({ id: 'spend', group: 'spend', level: 'info', title: 'Chargeable checks', detail: `Not run: network access is disabled (--offline). Cap was ${formatUsd(opts.spend.capMicros)}; nothing was spent.` });
  } else if (spend.allowed) {
    checks.push({
      id: 'spend',
      group: 'spend',
      level: spend.checks.some((c) => c.status === 'failed') ? 'warn' : 'info',
      title: 'Chargeable checks',
      detail: `Allowed with a cap of ${spend.capUsd} for at most one minimal LLM Gateway request. ${spend.checks.length ? spend.checks.map((c) => `${c.siteId}: ${c.status}${c.cost ? `, cost ${c.cost}` : ''}. ${c.detail}`).join(' ') : 'No site was checked; nothing was spent.'} ${PAID_TESTS_NOTE}`,
    });
  } else {
    checks.push({ id: 'spend', group: 'spend', level: 'info', title: 'Chargeable checks', detail: 'None run; doctor never spends money without --allow-spend --max-usd <cap>.' });
  }

  const counts: Record<CheckLevel, number> = { ok: 0, info: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[c.level]++;
  const nextSteps: string[] = [];
  for (const level of ['fail', 'warn'] as const) {
    for (const c of checks) {
      if (c.level === level && c.nextStep && !nextSteps.includes(c.nextStep)) nextSteps.push(c.nextStep);
    }
  }
  if (manifest && !netAllowed && !opts.offline) nextSteps.push('npm run cli -- doctor --network   (free, read-only connectivity checks; never spends money)');
  return {
    ok: counts.fail === 0,
    generatedAt: clock.now().toISOString(),
    appVersion: appVersion(),
    workspace: { root: paths.root, exists, kind: manifest?.kind ?? null },
    network: { requested: netRequested, allowed: netAllowed, requests: log.requests, blocked: log.blocked },
    spend,
    counts,
    checks,
    sites,
    nextSteps,
  };
}

const LABEL: Record<CheckLevel, string> = { ok: 'OK  ', info: 'INFO', warn: 'WARN', fail: 'FAIL' };

export function renderDoctorReport(r: DoctorReport): string {
  const lines: string[] = [`seo-agent doctor (v${r.appVersion}) - workspace ${r.workspace.root}`];
  lines.push(
    r.network.allowed
      ? `Network: free read-only checks, ${r.network.requests.length} request(s)${r.network.requests.length ? `: ${[...new Set(r.network.requests.map((q) => `${q.method} ${q.host}`))].join(', ')}` : ''}.`
      : `Network: not used${r.network.blocked.length ? ` (${r.network.blocked.length} attempted request(s) were blocked)` : ''}. Pass --network for free, read-only checks.`,
  );
  lines.push(r.spend.allowed ? `Spending: allowed for one minimal LLM request, cap ${r.spend.capUsd}.` : 'Spending: none. Chargeable checks need --allow-spend --max-usd <cap>.');
  const groups: Array<[string, (c: DoctorCheck) => boolean]> = [
    ['Runtime and workspace', (c) => !c.siteId && ['runtime', 'workspace', 'database'].includes(c.group)],
    ['Configuration', (c) => !c.siteId && c.group === 'config'],
  ];
  const siteIds = [...new Set(r.checks.filter((c) => c.siteId).map((c) => c.siteId!))];
  const render = (c: DoctorCheck) => {
    lines.push(`  [${LABEL[c.level]}] ${c.title}: ${c.detail}`);
    if (c.nextStep && (c.level === 'fail' || c.level === 'warn')) lines.push(`         next: ${c.nextStep}`);
  };
  for (const [title, pred] of groups) {
    const cs = r.checks.filter(pred);
    if (!cs.length) continue;
    lines.push('', `${title}:`);
    cs.forEach(render);
  }
  for (const id of siteIds) {
    const site = r.sites.find((s) => s.siteId === id);
    lines.push('', `Site ${id}${site ? ` (profile ${site.profile})` : ''}:`);
    r.checks.filter((c) => c.siteId === id).forEach(render);
  }
  const spend = r.checks.filter((c) => c.group === 'spend');
  if (spend.length) {
    lines.push('', 'Spending:');
    spend.forEach(render);
  }
  lines.push('', `Summary: ${r.counts.ok} ok, ${r.counts.info} info, ${r.counts.warn} warning(s), ${r.counts.fail} failure(s).`);
  if (r.nextSteps.length) {
    lines.push('', 'Next steps:');
    r.nextSteps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  }
  return lines.join('\n');
}
