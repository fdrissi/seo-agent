import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { register } from '../../../src/cli/commands/diagnostics.js';
import { CliRuntime } from '../../../src/cli/runtime.js';
import { loadMigrations } from '../../../src/database/migrate.js';
import { MemorySecretStore } from '../../../src/config/secrets.js';
import { ensureSite } from '../../../src/database/sites.js';
import { buildDiagnosticBundle, gatherDiagnostics, readDiagnosticsFile, renderDiagnosticsMarkdown, writeDiagnosticsBundle, type DiagnosticBundle } from '../../../src/security/diagnostics.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';

// SYNTHETIC identifiers (reserved TLDs) and runtime-generated fake secrets.
const rand = (n: number) => randomBytes(n).toString('base64url').replace(/[-_]/g, 'q').slice(0, n);
const SECRETS = {
  LLM_GATEWAY_API_KEY: `llmgtwy_${rand(32)}`,
  APIFY_TOKEN: `apify_api_${rand(36)}`,
  DATAFORSEO_LOGIN: 'dfs-owner@synthetic-shop.test',
  DATAFORSEO_PASSWORD: rand(16),
  PAGESPEED_API_KEY: `AIza${rand(35)}`,
  QDRANT_API_KEY: rand(28),
} as const;

const LEAKS = [
  'synthetic-shop.test',
  'www.synthetic-shop',
  '987654321',
  'dfs-owner',
  'owner@',
  'sc-domain:',
  'rival-one.example',
  'unlisted-host.invalid',
  '203.0.113.7',
  'synthetic_lead_submit',
  'Synthetic Shop (fixture)',
  'SynthShop',
  '/pricing?utm',
];

function syntheticConfig() {
  return testSiteConfig({
    profile: 'full',
    site: { id: 'synthetic-shop', businessName: 'Synthetic Shop (fixture)', url: 'https://www.synthetic-shop.test/', allowedHostnames: ['www.synthetic-shop.test'] },
    google: { searchConsoleProperty: 'sc-domain:synthetic-shop.test', ga4PropertyId: '987654321' },
    conversions: { primaryEvents: [{ name: 'synthetic_lead_submit', meaning: 'Synthetic lead form', kind: 'lead' }] },
    brand: { aliases: ['SynthShop'] },
    business: { offer: 'Synthetic offer. Contact owner@synthetic-shop.test' },
    research: { competitors: [{ domain: 'rival-one.example', name: 'Rival One (synthetic)' }], dataforseo: { mode: 'sandbox' } },
  });
}

function seed(ctx: TestContext): void {
  const now = '2026-09-24T09:00:00.000Z';
  const insertJob = (id: string, status: string, error: unknown) =>
    ctx.db.run('INSERT INTO jobs (id, site_id, type, status, mode, dry_run, attempt, max_attempts, error_json, created_at) VALUES (?, ?, ?, ?, ?, 0, 1, 3, ?, ?)', [id, ctx.siteId, 'weekly', status, 'ANALYZE', error ? JSON.stringify(error) : null, now]);
  insertJob('job_a', 'succeeded', null);
  insertJob('job_b', 'failed', {
    code: 'PROVIDER_ERROR',
    message:
      `fetch https://www.synthetic-shop.test/pricing?utm=1 failed for sc-domain:synthetic-shop.test (GA4 987654321) login dfs-owner@synthetic-shop.test ` +
      `token ${SECRETS.APIFY_TOKEN} Authorization: Bearer ${SECRETS.LLM_GATEWAY_API_KEY} host api.unlisted-host.invalid ip 203.0.113.7 file ${ctx.paths.dbFile} event synthetic_lead_submit`,
  });
  insertJob('job_c', 'running', null);
  ctx.db.run('INSERT INTO provider_requests (id, site_id, provider, endpoint, method, is_paid, request_hash, status, is_synthetic, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1, ?)', ['pr_1', ctx.siteId, 'dataforseo', 'serp.organic.task_post', 'POST', 'h1', 'ambiguous', now]);
  ctx.db.run(
    'INSERT INTO budget_reservations (id, site_id, provider, purpose, estimated_usd_micros, status, cost_status, period_month, period_week, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['res_1', ctx.siteId, 'dataforseo', 'serp research', 6000, 'reserved', 'estimated', '2026-09', '2026-W39', now, now],
  );
  ctx.db.run('INSERT INTO circuit_breakers (site_id, provider, state, consecutive_failures, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
    ctx.siteId,
    'crawler',
    'open',
    5,
    `competitor rival-one.example returned 403 for https://rival-one.example/x (key=${SECRETS.QDRANT_API_KEY})`,
    now,
  ]);
  writeFileSync(
    path.join(ctx.paths.logsDir, 'seo-agent.log'),
    [
      JSON.stringify({ at: now, level: 'info', msg: 'started' }),
      JSON.stringify({ at: now, level: 'error', msg: `GSC request for https://www.synthetic-shop.test/ failed; user dfs-owner@synthetic-shop.test`, site: ctx.siteId }),
      'not json',
    ].join('\n') + '\n',
  );
}

function assertNoLeaks(text: string, ctx: TestContext): void {
  for (const v of Object.values(SECRETS)) expect(text, 'secret value leaked').not.toContain(v);
  for (const leak of LEAKS) expect(text, `identifier leaked: ${leak}`).not.toContain(leak);
  expect(text).not.toContain(ctx.paths.root);
}

describe('diagnostics bundle (library)', () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestContext({ config: syntheticConfig(), secrets: { ...SECRETS } });
    seed(ctx);
  });
  afterEach(() => ctx.cleanup());

  it('contains counts, flags, integration states, and migration status but no secrets or identifiers', () => {
    const bundle = buildDiagnosticBundle({ paths: ctx.paths, secrets: new MemorySecretStore({ ...SECRETS }), sites: [{ siteId: ctx.siteId, config: ctx.config }], db: ctx.db, now: new Date('2026-09-24T10:00:00Z') });
    const text = JSON.stringify(bundle);
    assertNoLeaks(text, ctx);

    expect(bundle.format).toBe('seo-agent-diagnostics');
    expect(bundle.redaction.selfCheck.passed).toBe(true);
    expect(bundle.workspace.root).toBe('<WORKSPACE>');
    expect(bundle.environment.find((e) => e.key === 'LLM_GATEWAY_API_KEY')).toMatchObject({ set: true, isSecret: true });

    const counts = Object.fromEntries(bundle.database.tableCounts.map((t) => [t.table, t.rows]));
    expect(counts.jobs).toBe(3);
    expect(counts.sites).toBe(1);
    expect(counts.provider_requests).toBe(1);
    expect(bundle.database.tableCounts.find((t) => t.table === 'provider_requests')?.syntheticRows).toBe(1);
    expect(bundle.database.migrations?.pending).toEqual([]);
    expect(bundle.database.migrations?.applied.length).toBe(loadMigrations().length);

    const failed = bundle.database.jobs.recent.find((j) => j.status === 'failed');
    expect(failed?.error?.code).toBe('PROVIDER_ERROR');
    expect(failed?.error?.message).toContain('<url h:');
    expect(failed?.error?.message).toContain('<WORKSPACE>/data/seo-agent.sqlite');
    expect(bundle.database.providerRequests).toEqual([expect.objectContaining({ provider: 'dataforseo', status: 'ambiguous', synthetic: true, count: 1 })]);
    expect(bundle.database.budgetReservations[0]).toMatchObject({ provider: 'dataforseo', status: 'reserved', estimatedMicros: 6000, actualMicros: null });
    expect(bundle.database.circuitBreakers[0]?.lastError).not.toContain('rival-one');

    const site = bundle.sites[0]!;
    expect(site.label).toMatch(/^site-1 \(h:[0-9a-f]{8}\)$/);
    expect(site.features.dataforseo).toEqual({ effective: true, explicit: null });
    const states = Object.fromEntries(site.integrations.map((i) => [i.id, i.state]));
    expect(states.dataforseo).toBe('fixture');
    expect(states.google_gsc).toBe('missing_credentials');

    expect(bundle.logs.levels).toMatchObject({ info: 1, error: 1, unparsed: 1 });
    expect(bundle.logs.recentProblems[0]?.msg).toContain('<url h:');
  });

  it('includes doctor-reported integration statuses with scrubbed details', () => {
    const bundle = buildDiagnosticBundle({
      paths: ctx.paths,
      secrets: new MemorySecretStore({ ...SECRETS }),
      sites: [{ siteId: ctx.siteId, config: ctx.config }],
      db: ctx.db,
      integrationStatuses: [
        {
          id: 'google_gsc',
          state: 'permission_denied',
          detail: 'User dfs-owner@synthetic-shop.test lacks access to sc-domain:synthetic-shop.test',
          nextStep: 'Grant access in Search Console for https://www.synthetic-shop.test/',
          sendsExternally: [],
          checkedAt: '2026-09-24T09:00:00.000Z',
          networkChecked: true,
          chargeable: false,
        },
      ],
    });
    expect(bundle.reportedIntegrations).toHaveLength(1);
    expect(bundle.reportedIntegrations[0]).toMatchObject({ id: 'google_gsc', state: 'permission_denied', source: 'reported-by-doctor', networkChecked: true });
    assertNoLeaks(JSON.stringify(bundle), ctx);
  });

  it('works without a database and with an invalid site config (honest status, still redacted)', () => {
    writeFileSync(path.join(ctx.paths.sitesDir, 'broken-site.yaml'), stringify({ site: { id: 'private-other-site', businessName: 'X', url: 'https://www.private-other.test/', allowedHostnames: ['www.private-other.test'] } }));
    const bundle = gatherDiagnostics({ paths: { ...ctx.paths, dbFile: path.join(ctx.paths.dataDir, 'missing.sqlite') }, env: { HOME: ctx.paths.root, ...SECRETS } });
    const text = JSON.stringify(bundle);
    assertNoLeaks(text, ctx);
    expect(text).not.toContain('private-other');
    expect(bundle.database.present).toBe(false);
    const broken = bundle.sites.find((s) => s.configStatus === 'invalid');
    expect(broken?.configErrors.length).toBeGreaterThan(0);
  });
});

describe('CLI: diagnostics export / show / list', () => {
  let ctx: TestContext;
  let out: string[];
  let err: string[];
  let cli: CliRuntime;

  const run = async (...args: string[]) => {
    const program = new Command();
    program.exitOverride();
    program
      .option('-w, --workspace <dir>')
      .option('-s, --site <id>')
      .option('--dry-run')
      .option('--json')
      .option('--mode <mode>')
      .option('--offline');
    register(program, cli);
    await program.parseAsync(['node', 'seo-agent', '--workspace', ctx.paths.root, ...args]);
  };

  beforeEach(() => {
    ctx = createTestContext({ config: syntheticConfig(), secrets: { ...SECRETS } });
    seed(ctx);
    out = [];
    err = [];
    cli = new CliRuntime({ out: (t) => out.push(t), err: (t) => err.push(t) }, { HOME: ctx.paths.root, ...SECRETS });
  });
  afterEach(() => {
    ctx.cleanup();
    process.exitCode = undefined;
  });

  it('writes redacted JSON + Markdown (mode 0600), prints the paths and an INSPECT warning, uploads nothing', async () => {
    await run('diagnostics', 'export');
    const text = out.join('\n');
    expect(text).toContain('INSPECT both files');
    expect(text).toContain('Nothing was uploaded');
    const files = readdirSync(ctx.paths.diagnosticsDir).sort();
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.endsWith('.json'))).toBe(true);
    expect(files.some((f) => f.endsWith('.md'))).toBe(true);
    for (const f of files) {
      const p = path.join(ctx.paths.diagnosticsDir, f);
      expect(text).toContain(p);
      if (process.platform !== 'win32') expect((statSync(p).mode & 0o777).toString(8)).toBe('600');
      assertNoLeaks(readFileSync(p, 'utf8'), ctx);
    }
    const bundle = JSON.parse(readFileSync(path.join(ctx.paths.diagnosticsDir, files.find((f) => f.endsWith('.json'))!), 'utf8')) as DiagnosticBundle;
    expect(bundle.database.tableCounts.find((t) => t.table === 'jobs')?.rows).toBe(3);
    const md = readFileSync(path.join(ctx.paths.diagnosticsDir, files.find((f) => f.endsWith('.md'))!), 'utf8');
    expect(md).toContain('# seo-agent diagnostics (redacted)');
    expect(md).toContain('INSPECT this file');
    expect(md).toContain('| jobs | 3 |');
  });

  it('--json reports uploaded:false and file paths', async () => {
    await run('--json', 'diagnostics', 'export');
    const r = JSON.parse(out.join('\n')) as { uploaded: boolean; written: boolean; jsonFile: string; markdownFile: string };
    expect(r).toMatchObject({ uploaded: false, written: true });
    expect(existsSync(r.jsonFile)).toBe(true);
    expect(existsSync(r.markdownFile)).toBe(true);
  });

  it('--dry-run writes nothing', async () => {
    await run('--dry-run', 'diagnostics', 'export');
    expect(existsSync(ctx.paths.diagnosticsDir) ? readdirSync(ctx.paths.diagnosticsDir) : []).toEqual([]);
    const text = out.join('\n');
    expect(text).toContain('Dry run: nothing was written');
    // The bundle preview is redacted; only the final local hint names the (local) target directory.
    assertNoLeaks(text.slice(0, text.indexOf('Dry run: nothing was written')), ctx);
  });

  it('show prints a bundle by bare name; list enumerates bundles; non-bundles are rejected', async () => {
    await run('diagnostics', 'export');
    const json = readdirSync(ctx.paths.diagnosticsDir).find((f) => f.endsWith('.json'))!;
    out.length = 0;
    await run('diagnostics', 'show', json);
    expect(out.join('\n')).toContain('# seo-agent diagnostics (redacted)');
    out.length = 0;
    await run('diagnostics', 'list');
    expect(out.join('\n')).toContain(json);

    const notBundle = path.join(ctx.paths.root, 'README.md');
    out.length = 0;
    await expect(run('diagnostics', 'show', notBundle)).rejects.toThrow();
    expect(err.join('\n')).toContain('not a seo-agent diagnostics bundle');
  });

  it('rejects path traversal in bare-name lookups', async () => {
    await expect(run('diagnostics', 'show', '..')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Regressions: several sites, --site scoping, invalid configs, key collisions.
// Site "bravo" uses the reserved .localhost TLD, which the generic hostname
// rule does NOT mask, so these tests prove its identifiers are registered.

const BRAVO_ID = 'bravo-site';
const BRAVO_LEAKS = ['bravo-widgets', 'Bravo Widgets', 'bravo_quote_request', 'Rival Bravo', 'rival-bravo', 'bravowidgetfans', BRAVO_ID];

function bravoConfig() {
  return testSiteConfig({
    profile: 'full',
    site: { id: BRAVO_ID, businessName: 'Bravo Widgets Synthetic Ltd', url: 'https://shop.bravo-widgets.localhost/', allowedHostnames: ['shop.bravo-widgets.localhost'] },
    conversions: { primaryEvents: [{ name: 'bravo_quote_request', meaning: 'Synthetic quote request', kind: 'lead' }] },
    research: { competitors: [{ domain: 'rival-bravo.localhost', name: 'Rival Bravo Synthetic' }], subreddits: ['bravowidgetfans'] },
  });
}

/** Add site bravo: config file + DB rows (jobs, breaker, requests, log line) whose free text names bravo's identifiers. */
function addBravo(ctx: TestContext, opts: { dbConfigVersions: boolean }): void {
  const cfg = bravoConfig();
  writeFileSync(path.join(ctx.paths.sitesDir, `${BRAVO_ID}.yaml`), stringify(cfg));
  const now = '2026-09-24T09:30:00.000Z';
  if (opts.dbConfigVersions) ensureSite(ctx.db, cfg, { source: 'file', now: new Date(now) });
  else ctx.db.run('INSERT INTO sites (id, name, base_url, is_demo, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)', [BRAVO_ID, 'db label only', 'https://db-only.invalid/', now, now]);
  const leakText = 'crawl of shop.bravo-widgets.localhost failed for Bravo Widgets Synthetic Ltd; event bravo_quote_request; competitor Rival Bravo Synthetic (rival-bravo.localhost); r/bravowidgetfans';
  ctx.db.run('INSERT INTO jobs (id, site_id, type, status, mode, dry_run, attempt, max_attempts, error_json, created_at) VALUES (?, ?, ?, ?, ?, 0, 1, 3, ?, ?)', ['job_bravo', BRAVO_ID, 'weekly', 'failed', 'ANALYZE', JSON.stringify({ code: 'PROVIDER_ERROR', message: leakText }), now]);
  ctx.db.run('INSERT INTO circuit_breakers (site_id, provider, state, consecutive_failures, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [BRAVO_ID, 'crawler', 'open', 3, leakText, now]);
  ctx.db.run('INSERT INTO provider_requests (id, site_id, provider, endpoint, method, is_paid, request_hash, status, is_synthetic, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 1, ?)', ['pr_bravo', BRAVO_ID, 'apify', 'acts/run', 'POST', 'hb', 'failed', now]);
  writeFileSync(path.join(ctx.paths.logsDir, 'seo-agent.log'), `${readFileSync(path.join(ctx.paths.logsDir, 'seo-agent.log'), 'utf8')}${JSON.stringify({ at: now, level: 'error', msg: leakText, site: BRAVO_ID })}\n`);
}

function assertNoBravo(text: string): void {
  for (const leak of BRAVO_LEAKS) expect(text, `bravo identifier leaked: ${leak}`).not.toContain(leak);
}

describe('diagnostics: several sites, --site scoping, invalid configs (regressions)', () => {
  let ctx: TestContext;
  const env = () => ({ HOME: ctx.paths.root, ...SECRETS });
  beforeEach(() => {
    ctx = createTestContext({ config: syntheticConfig(), secrets: { ...SECRETS } });
    seed(ctx);
  });
  afterEach(() => ctx.cleanup());

  it('--site restricts per-site database and log sections to the selected site and masks the others', () => {
    addBravo(ctx, { dbConfigVersions: true });
    const bundle = gatherDiagnostics({ paths: ctx.paths, env: env(), siteId: ctx.siteId });
    const text = JSON.stringify(bundle);
    assertNoBravo(text);
    assertNoLeaks(text, ctx);
    expect(bundle.scope).toEqual({ restrictedToSelectedSites: true, sitesReported: 1, otherSitesExcluded: 1 });
    expect(bundle.sites).toHaveLength(1);
    const labels = new Set([...bundle.database.jobs.recent, ...bundle.database.jobs.byStatus, ...bundle.database.providerRequests, ...bundle.database.circuitBreakers].map((r) => r.site));
    expect(labels).toEqual(new Set([bundle.sites[0]!.label]));
    expect(bundle.database.jobs.recent).toHaveLength(3);
    expect(bundle.database.providerRequests.map((r) => r.provider)).toEqual(['dataforseo']);
    expect(bundle.logs.levels.otherSites).toBe(1);
    expect(renderDiagnosticsMarkdown(bundle)).toContain('other site(s) excluded');
  });

  it("without --site reports every site and still masks every site's identifiers", () => {
    addBravo(ctx, { dbConfigVersions: true });
    const bundle = gatherDiagnostics({ paths: ctx.paths, env: env() });
    const text = JSON.stringify(bundle);
    assertNoBravo(text);
    assertNoLeaks(text, ctx);
    expect(bundle.scope.restrictedToSelectedSites).toBe(false);
    expect(bundle.sites).toHaveLength(2);
    expect(new Set(bundle.database.jobs.recent.map((j) => j.site)).size).toBe(2);
    const bravoJob = bundle.database.jobs.recent.find((j) => j.error?.message?.includes('crawl of'));
    expect(bravoJob?.error?.message).toMatch(/<(?:host|url|name|event|site) h:[0-9a-f]{8}>/);
  });

  it('masks the identifiers of a site whose config FAILS VALIDATION (read leniently from the YAML)', () => {
    addBravo(ctx, { dbConfigVersions: false });
    const file = path.join(ctx.paths.sitesDir, `${BRAVO_ID}.yaml`);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nunknownTopLevel: true\n`.replace(/^budgets:/m, 'budgetsOld:') + 'budgets: not-an-object\n');
    for (const siteId of [undefined, ctx.siteId]) {
      const bundle = gatherDiagnostics({ paths: ctx.paths, env: env(), ...(siteId ? { siteId } : {}) });
      const text = JSON.stringify(bundle);
      assertNoBravo(text);
      if (!siteId) expect(bundle.sites.find((x) => x.configStatus === 'invalid')?.configErrors.length).toBeGreaterThan(0);
    }
  });

  it('masks the identifiers of a site whose YAML does not even parse (text fallback)', () => {
    addBravo(ctx, { dbConfigVersions: false });
    const file = path.join(ctx.paths.sitesDir, `${BRAVO_ID}.yaml`);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nbroken: [unclosed\n  - : :\n`);
    const bundle = gatherDiagnostics({ paths: ctx.paths, env: env() });
    assertNoBravo(JSON.stringify(bundle));
    expect(bundle.sites.find((x) => x.configStatus === 'invalid')).toBeDefined();
  });

  it('masks a site known only to the database (config file deleted) from sites/config_versions rows', () => {
    addBravo(ctx, { dbConfigVersions: true });
    unlinkSync(path.join(ctx.paths.sitesDir, `${BRAVO_ID}.yaml`));
    for (const siteId of [undefined, ctx.siteId]) {
      const bundle = gatherDiagnostics({ paths: ctx.paths, env: env(), ...(siteId ? { siteId } : {}) });
      assertNoBravo(JSON.stringify(bundle));
    }
  });

  it('CLI: --site export files contain nothing about other sites', async () => {
    addBravo(ctx, { dbConfigVersions: true });
    const out: string[] = [];
    const cli = new CliRuntime({ out: (t) => out.push(t), err: () => undefined }, env());
    const program = new Command();
    program.exitOverride();
    program.option('-w, --workspace <dir>').option('-s, --site <id>').option('--dry-run').option('--json').option('--mode <mode>').option('--offline');
    register(program, cli);
    await program.parseAsync(['node', 'seo-agent', '--workspace', ctx.paths.root, '--site', ctx.siteId, 'diagnostics', 'export']);
    const files = readdirSync(ctx.paths.diagnosticsDir);
    expect(files).toHaveLength(2);
    for (const f of files) assertNoBravo(readFileSync(path.join(ctx.paths.diagnosticsDir, f), 'utf8'));
  });
});

describe('diagnostics: identifiers that collide with bundle key names (regression)', () => {
  let ctx: TestContext;
  afterEach(() => ctx.cleanup());

  it('keeps the bundle structure intact, renders, and round-trips through show', () => {
    const colliding = ['environment', 'database', 'Format', 'valid', 'sites', 'redaction', 'workspace', 'logs'];
    ctx = createTestContext({
      config: testSiteConfig({ profile: 'full', research: { subreddits: colliding }, brand: { aliases: ['Installed', 'Research'] } }),
      secrets: { ...SECRETS },
    });
    ctx.db.run('INSERT INTO jobs (id, site_id, type, status, mode, dry_run, attempt, max_attempts, error_json, created_at) VALUES (?, ?, ?, ?, ?, 0, 1, 3, ?, ?)', ['job_x', ctx.siteId, 'weekly', 'failed', 'ANALYZE', JSON.stringify({ code: 'X', message: 'spam from r/environment and r/database' }), '2026-09-24T09:00:00.000Z']);
    const bundle = buildDiagnosticBundle({ paths: ctx.paths, secrets: new MemorySecretStore({ ...SECRETS }), sites: [{ siteId: ctx.siteId, config: ctx.config }], db: ctx.db });
    for (const k of ['format', 'formatVersion', 'environment', 'sites', 'database', 'logs', 'redaction', 'workspace']) expect(Object.keys(bundle), k).toContain(k);
    expect(bundle.format).toBe('seo-agent-diagnostics');
    expect(bundle.sites[0]?.configStatus).toBe('valid');
    expect(bundle.database.present).toBe(true);
    expect(Array.isArray(bundle.environment)).toBe(true);
    const msg = bundle.database.jobs.recent[0]?.error?.message ?? '';
    expect(msg).not.toMatch(/r\/environment|r\/database/);
    expect(() => renderDiagnosticsMarkdown(bundle)).not.toThrow();
    const written = writeDiagnosticsBundle(bundle, ctx.paths.diagnosticsDir);
    const read = readDiagnosticsFile(written.jsonFile);
    expect(read.kind).toBe('json');
  });
});
