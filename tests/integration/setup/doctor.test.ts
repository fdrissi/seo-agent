import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { siteConfigFile } from '../../../src/config/paths.js';
import { LayeredSecretStore } from '../../../src/config/secrets.js';
import { initWorkspace } from '../../../src/config/workspace.js';
import type { SiteConfigInput } from '../../../src/config/site-schema.js';
import type { FetchLike } from '../../../src/integrations/types.js';
import { databaseSitesKindCheck, runDoctor, renderDoctorReport, type DoctorOptions, type DoctorReport } from '../../../src/setup/doctor.js';
import { openDatabase } from '../../../src/database/db.js';
import { newDraft, saveDraft } from '../../../src/setup/draft.js';
import { fakeFetch } from '../../helpers/fake-fetch.js';
import { TEST_KEY, chatCompletion, fakeGateway } from '../llm/harness.js';
import { makeWorkspace, runCli, type TestWorkspace } from './helpers.js';

/** Synthetic site config (reserved example domains; no real ids). */
function siteConfig(overrides: Partial<SiteConfigInput> = {}): SiteConfigInput {
  return {
    profile: 'core',
    site: { id: 'doctor-test', businessName: 'Doctor Test (synthetic)', url: 'https://www.example.test/', allowedHostnames: ['www.example.test'] },
    google: { searchConsoleProperty: 'sc-domain:example.test', ga4PropertyId: '123456789' },
    ...overrides,
  } as SiteConfigInput;
}

function writeConfig(ws: TestWorkspace, cfg: SiteConfigInput): void {
  writeFileSync(siteConfigFile(ws.paths, cfg.site.id), stringify(cfg), { mode: 0o600 });
}

const ALL_SECRETS = {
  LLM_GATEWAY_API_KEY: TEST_KEY,
  DATAFORSEO_LOGIN: 'synthetic-login@example.test',
  DATAFORSEO_PASSWORD: 'synthetic-dfs-password-000',
  APIFY_TOKEN: 'apify_api_SYNTHETIC000000000000',
  PAGESPEED_API_KEY: 'AIzaSYNTHETIC-pagespeed-key-000',
  QDRANT_API_KEY: 'synthetic-qdrant-key-000000',
};

/** A fetch that records every call and fails it: any call in a "no network" test is a bug. */
function recordingFetch(): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const f: FetchLike = async (input, init) => {
    calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${String(input)}`);
    throw new Error('network access in a no-network doctor test');
  };
  return Object.assign(f, { calls });
}

let ws: TestWorkspace;
beforeEach(() => {
  ws = makeWorkspace({ migrate: true });
});
afterEach(() => ws.cleanup());

function doctor(opts: Partial<DoctorOptions> & { env?: NodeJS.ProcessEnv } = {}): Promise<DoctorReport> {
  const env = opts.env ?? {};
  return runDoctor({ paths: ws.paths, secrets: new LayeredSecretStore(ws.paths.secretsEnvFile, env), network: false, node: { version: 'v24.9.0', lts: 'Krypton' }, ...opts });
}

const byId = (r: DoctorReport, id: string) => r.checks.filter((c) => c.id === id);
const integration = (r: DoctorReport, id: string) => r.sites.flatMap((s) => s.integrations).find((s) => s.id === id);

describe('doctor: no network unless asked', () => {
  const fullConfig = () =>
    siteConfig({
      profile: 'full',
      features: { playwright: false },
      research: { dataforseo: { mode: 'sandbox' } } as SiteConfigInput['research'],
      models: { cheap: 'synthetic-cheap-structured', reasoning: 'synthetic-reasoner', embedding: 'synthetic-embed-small' } as SiteConfigInput['models'],
    });

  it('makes zero network requests by default, even with every credential configured (CLI, global fetch spy)', async () => {
    writeConfig(ws, fullConfig());
    const spy = recordingFetch();
    globalThis.fetch = spy as typeof fetch;
    const r = await runCli(ws, ['doctor', '--json'], ALL_SECRETS);
    expect(spy.calls).toEqual([]);
    const report = r.json<DoctorReport>();
    expect(report.network).toMatchObject({ requested: false, allowed: false, requests: [], blocked: [] });
    const statuses = report.sites.flatMap((s) => s.integrations);
    expect(statuses.length).toBeGreaterThan(8);
    for (const s of statuses) {
      expect(s.networkChecked).toBe(false);
      expect(s.chargeable).toBe(false);
    }
    expect(report.spend).toMatchObject({ allowed: false, checks: [] });
    expect(byId(report, 'qdrant.health')[0]?.detail).toContain('Not checked (no network)');
    // No secret value reaches the output.
    for (const v of Object.values(ALL_SECRETS)) expect(r.out + r.err).not.toContain(v);
  });

  it('the injected provider fetch is never called either, and --offline overrides --network', async () => {
    writeConfig(ws, fullConfig());
    const f = recordingFetch();
    const r1 = await doctor({ env: ALL_SECRETS, fetch: f });
    const r2 = await doctor({ env: ALL_SECRETS, fetch: f, network: true, offline: true });
    expect(f.calls).toEqual([]);
    expect(r1.network.blocked).toEqual([]);
    expect(r2.network.allowed).toBe(false);
    expect(byId(r2, 'runtime.offline')).toHaveLength(1);
  });

  it('--network performs only free, read-only requests', async () => {
    writeConfig(
      ws,
      siteConfig({
        features: { crawl: false, dataforseo: true, qdrant: true },
        research: { dataforseo: { mode: 'sandbox' } } as SiteConfigInput['research'],
        models: { cheap: 'synthetic-cheap-structured', reasoning: 'synthetic-reasoner' } as SiteConfigInput['models'],
      }),
    );
    const gw = fakeGateway();
    const other = fakeFetch([() => new Response('unavailable (synthetic)', { status: 503 })]);
    const calls: Array<{ method: string; url: string }> = [];
    const f: FetchLike = async (input, init) => {
      calls.push({ method: (init?.method ?? 'GET').toUpperCase(), url: String(input) });
      return String(input).startsWith('https://api.llmgateway.io/') ? gw.fetch(input, init) : other(input, init);
    };
    const r = await doctor({ env: ALL_SECRETS, fetch: f, network: true });
    expect(calls.length).toBeGreaterThan(0);
    expect(r.network.requests).toHaveLength(calls.length);
    for (const c of calls) {
      expect(c.method).toBe('GET');
      expect(c.url).not.toMatch(/chat\/completions|embeddings|task_post|\/runs(\?|$)/);
    }
    expect(gw.chatBodies).toEqual([]);
    expect(integration(r, 'llm_gateway')).toMatchObject({ networkChecked: true, chargeable: false });
    expect(['ready', 'degraded']).toContain(integration(r, 'llm_gateway')!.state);
    // A failing free check is reported honestly, never as ready.
    expect(integration(r, 'qdrant')!.state).toBe('unreachable');
    expect(r.spend).toMatchObject({ allowed: false, checks: [] });
    // The report never stores query strings (they can carry API keys).
    expect(JSON.stringify(r.network)).not.toContain('?');
  });
});

describe('doctor: demo sites', () => {
  it('a demo-profile site never touches the network, even with --network, and reports fixtures', async () => {
    const demo = makeWorkspace({ init: false });
    try {
      initWorkspace(demo.root, { kind: 'demo' });
      writeConfig(demo, siteConfig({ profile: 'demo' }));
      const f = recordingFetch();
      const r = await runDoctor({ paths: demo.paths, secrets: new LayeredSecretStore(demo.paths.secretsEnvFile, {}), network: true, fetch: f, node: { version: 'v24.9.0', lts: 'Krypton' } });
      expect(f.calls).toEqual([]);
      expect(r.network.requests).toEqual([]);
      expect(integration(r, 'google_auth')?.state).toBe('fixture');
      expect(integration(r, 'llm_gateway')?.state).toBe('fixture');
      expect(byId(r, 'config.demo-in-live')).toEqual([]);
    } finally {
      demo.cleanup();
    }
  });
});

describe('doctor: chargeable checks', () => {
  beforeEach(() => {
    writeConfig(ws, siteConfig({ features: { crawl: false }, models: { cheap: 'synthetic-cheap-structured', reasoning: 'synthetic-reasoner' } as SiteConfigInput['models'] }));
  });

  it('refuses --allow-spend without --max-usd (and the reverse) before doing anything', async () => {
    const spy = recordingFetch();
    globalThis.fetch = spy as typeof fetch;
    const a = await runCli(ws, ['doctor', '--allow-spend'], { LLM_GATEWAY_API_KEY: TEST_KEY });
    expect(a.exitCode).toBe(1);
    expect(a.err).toContain('--max-usd');
    const b = await runCli(ws, ['doctor', '--max-usd', '0.01'], { LLM_GATEWAY_API_KEY: TEST_KEY });
    expect(b.exitCode).toBe(1);
    expect(b.err).toContain('--allow-spend');
    expect(spy.calls).toEqual([]);
  });

  it('with an explicit cap: displays it, sends exactly one minimal capped request, and reports the cost', async () => {
    const gw = fakeGateway({ chat: [() => chatCompletion('OK', { usage: { prompt_tokens: 700, completion_tokens: 2, total_tokens: 702, cost: 0.000106 } })] });
    globalThis.fetch = gw.fetch as typeof fetch;
    const r = await runCli(ws, ['doctor', '--allow-spend', '--max-usd', '0.01'], { LLM_GATEWAY_API_KEY: TEST_KEY });
    expect(r.err).toContain('capped at $0.01');
    expect(gw.chatBodies).toHaveLength(1);
    expect(gw.chatBodies[0].max_tokens ?? gw.chatBodies[0].max_completion_tokens).toBe(16);
    expect(r.out).toContain('Spending: allowed for one minimal LLM request, cap $0.01.');
    expect(r.out).toMatch(/doctor-test: succeeded, cost \$0\.000106/);
    expect(r.out).not.toContain(TEST_KEY);
  });

  it('--dry-run shows the planned chargeable check without sending it', async () => {
    const gw = fakeGateway();
    const r = await doctor({ env: { LLM_GATEWAY_API_KEY: TEST_KEY }, fetch: gw.fetch, spend: { capMicros: 10_000 }, dryRun: true });
    expect(gw.chatBodies).toEqual([]);
    expect(r.spend.checks).toEqual([expect.objectContaining({ status: 'dry_run', capUsd: '$0.01' })]);
    // Paid Apify tests are the owner's explicit command, with the RESEARCH mode the policy requires.
    const spendDetail = byId(r, 'spend')[0]!.detail;
    expect(spendDetail).toContain('npm run cli -- apify test --mode RESEARCH --confirm-spend --max-usd <cap>');
    expect(spendDetail).toContain('apify research --mode RESEARCH');
    expect(spendDetail).not.toMatch(/`apify test --confirm-spend/);
  });

  it('skips the chargeable check (nothing spent) when the LLM is not configured', async () => {
    const f = recordingFetch();
    const r = await doctor({ fetch: f, spend: { capMicros: 10_000 } });
    expect(f.calls).toEqual([]);
    expect(r.spend.checks[0]).toMatchObject({ status: 'skipped', cost: null });
    expect(r.spend.checks[0]!.detail).toContain('Nothing was spent');
  });
});

describe('doctor: honest status and next steps', () => {
  it('reports missing credentials honestly with exact next steps and never claims ready', async () => {
    writeConfig(ws, siteConfig({ profile: 'full', research: { dataforseo: { mode: 'sandbox' } } as SiteConfigInput['research'] }));
    const r = await doctor();
    const states = Object.fromEntries(r.sites[0]!.integrations.map((s) => [s.id, s.state]));
    expect(states).toMatchObject({
      google_auth: 'missing_credentials',
      google_gsc: 'missing_credentials',
      google_ga4: 'missing_credentials',
      llm_gateway: 'missing_credentials',
      dataforseo: 'missing_credentials',
      apify: 'missing_credentials',
      pagespeed: 'missing_credentials',
      crux: 'missing_credentials',
    });
    expect(Object.values(states)).not.toContain('ready');
    expect(byId(r, 'integration.google_auth')[0]).toMatchObject({ level: 'warn', nextStep: expect.stringContaining('auth google') });
    expect(r.nextSteps.join('\n')).toContain('LLM_GATEWAY_API_KEY');
    expect(r.nextSteps.join('\n')).toContain('APIFY_TOKEN');
    const text = renderDoctorReport(r);
    expect(text).toContain('[WARN] llm_gateway: missing_credentials');
    expect(text).toContain('Next steps:');
  });

  it('flags readable secret files, unfinished drafts, invalid auth mode, and invalid configs', async () => {
    writeConfig(ws, siteConfig());
    writeFileSync(siteConfigFile(ws.paths, 'broken-site'), 'site:\n  id: broken-site\n  businessName: x\n  url: ftp://example.test/\n  allowedHostnames: []\n');
    if (process.platform !== 'win32') chmodSync(ws.paths.secretsEnvFile, 0o644);
    const d = newDraft('draft-site', 'create', new Date('2026-09-24T09:00:00Z'));
    saveDraft(ws.paths, d, new Date('2026-09-24T09:00:00Z'));
    const r = await doctor({ env: { GOOGLE_AUTH_MODE: 'bogus' } });
    if (process.platform !== 'win32') expect(byId(r, 'workspace.permissions')[0]).toMatchObject({ level: 'fail', nextStep: expect.stringContaining('chmod 600') });
    expect(byId(r, 'config.draft')[0]).toMatchObject({ level: 'warn', nextStep: expect.stringContaining('setup --site draft-site') });
    const broken = r.checks.find((c) => c.id === 'config.site' && c.siteId === 'broken-site')!;
    expect(broken.level).toBe('fail');
    expect(broken.detail).toContain('site.url');
    expect(byId(r, 'google.auth-mode')[0]).toMatchObject({ level: 'fail', detail: expect.stringContaining('bogus') });
    expect(r.ok).toBe(false);
  });

  it('never migrates: without a database it reports the next step and creates nothing', async () => {
    const fresh = makeWorkspace();
    try {
      writeConfig(fresh, siteConfig());
      const r = await runDoctor({ paths: fresh.paths, secrets: new LayeredSecretStore(fresh.paths.secretsEnvFile, {}), network: false, node: { version: 'v24.9.0', lts: 'Krypton' } });
      expect(byId(r, 'database.migrations')[0]).toMatchObject({ level: 'warn', nextStep: expect.stringContaining('db migrate') });
      expect(byId(r, 'database.temporary')).toHaveLength(1);
      expect(r.sites[0]!.database).toBe('temporary');
      expect(existsSync(fresh.paths.dbFile)).toBe(false);
    } finally {
      fresh.cleanup();
    }
  });

  it('reports a missing workspace with the init command (CLI exit code 1)', async () => {
    const fresh = makeWorkspace({ init: false });
    try {
      const r = await runCli(fresh, ['doctor']);
      expect(r.exitCode).toBe(1);
      expect(r.out).toContain('[FAIL] Workspace: No workspace');
      expect(r.out).toContain('npm run cli -- init');
    } finally {
      fresh.cleanup();
    }
  });

  it('checks the vault, jobs, and schedules of a configured site', async () => {
    writeConfig(ws, siteConfig());
    const r = await doctor();
    expect(integration(r, 'obsidian')).toMatchObject({ state: 'degraded', nextStep: expect.stringContaining('setup vault --site doctor-test') });
    expect(byId(r, 'jobs.state')[0]).toMatchObject({ level: 'ok' });
    expect(byId(r, 'schedule.weekly')[0]).toMatchObject({ level: 'info', detail: expect.stringContaining('opt-in') });
    expect(r.sites[0]!.database).toBe('workspace');
  });
});

describe('database demo/live check (C2-02)', () => {
  const addSite = (id: string, isDemo: 0 | 1) => {
    const db = openDatabase(ws.paths.dbFile);
    try {
      db.run('INSERT INTO sites (id, name, base_url, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, `${id} (synthetic)`, 'https://www.example.test/', isDemo, '2026-09-24T09:00:00Z', '2026-09-24T09:00:00Z']);
    } finally {
      db.close();
    }
  };

  it('is silent without sites, ok when the database matches the manifest kind, and fails a live site in a demo workspace', () => {
    const current = { state: 'current', applied: 33 } as const;
    expect(databaseSitesKindCheck(ws.paths, 'live', current)).toBeNull();
    expect(databaseSitesKindCheck(ws.paths, 'live', { state: 'missing' })).toBeNull();
    addSite('live-one', 0);
    expect(databaseSitesKindCheck(ws.paths, 'live', current)).toMatchObject({ id: 'database.demo-live', level: 'ok' });
    expect(databaseSitesKindCheck(ws.paths, 'demo', current)).toMatchObject({
      level: 'fail',
      title: 'Live data in a demo workspace',
      detail: expect.stringContaining('live (non-demo) site(s) live-one'),
      nextStep: expect.stringContaining('restore --from <backup dir> --confirm'),
    });
    addSite('demo-one', 1);
    expect(databaseSitesKindCheck(ws.paths, 'live', current)).toMatchObject({ level: 'fail', title: 'Demo data in a live workspace', detail: expect.stringContaining('demo site(s) demo-one') });
  });

  it('runDoctor reports it with the database checks', async () => {
    addSite('demo-one', 1);
    const r = await doctor();
    expect(byId(r, 'database.demo-live')).toEqual([expect.objectContaining({ level: 'fail', group: 'database' })]);
    expect(r.ok).toBe(false);
    expect(renderDoctorReport(r)).toContain('[FAIL] Demo data in a live workspace');
  });
});

