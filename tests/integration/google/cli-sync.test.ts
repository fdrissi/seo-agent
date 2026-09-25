import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../../../src/app/context.js';
import { OAuthGoogleAuthProvider, ServiceAccountGoogleAuthProvider } from '../../../src/auth/providers.js';
import { TOKEN_FORMAT, TokenStore } from '../../../src/auth/token-store.js';
import { register } from '../../../src/cli/commands/sync.js';
import { confirmRateScale } from '../../../src/integrations/google/ga4-metadata.js';
import { createFixtureGoogleAuthProvider } from '../../../src/integrations/google/fixture-provider.js';
import type { GoogleAuthProvider } from '../../../src/integrations/google/types.js';
import { GOOGLE_FIXTURES, SYNTHETIC_GA4, SYNTHETIC_PROPERTY, googleConfig, googleTestContext, reopen } from './_helpers.js';
import { runCommand } from './_cli.js';
import type { TestContext } from '../../helpers/context.js';

const NOW = '2026-09-24T09:00:00.000Z';
let ctx: TestContext;
afterEach(() => ctx?.cleanup());

function reg(c: TestContext) {
  const provider = createFixtureGoogleAuthProvider(GOOGLE_FIXTURES, { gscProperty: SYNTHETIC_PROPERTY, ga4PropertyId: SYNTHETIC_GA4, clock: c.clock });
  return (program: Parameters<typeof register>[0], cli: Parameters<typeof register>[1]) =>
    register(program, cli, { context: (g) => reopen(c, { ...(g.dryRun ? { dryRun: true } : {}) }), provider: () => provider });
}

/** The CLI with the provider the real command builds (createGoogleAuthProvider: OAuth, no credentials in a test workspace) or the given one. */
function regLive(c: TestContext, provider?: (ctx: AppContext) => GoogleAuthProvider) {
  return (program: Parameters<typeof register>[0], cli: Parameters<typeof register>[1]) =>
    register(program, cli, { context: (g) => reopen(c, { ...(g.dryRun ? { dryRun: true } : {}) }), ...(provider ? { provider } : {}) });
}

const confirmations = (c: TestContext) => c.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ga4_rate_scale_confirmations WHERE site_id = ?', [c.siteId])!.n;

describe('sync CLI (synthetic fixtures)', () => {
  it('sync gsc --json returns machine-readable results labelled synthetic', async () => {
    ctx = googleTestContext({ now: NOW });
    const r = await runCommand(reg(ctx), ['--json', 'sync', 'gsc', '--days', '5', '--top-pages', '2']);
    expect(r.failed).toBe(false);
    const parsed = JSON.parse(r.out);
    expect(parsed).toMatchObject({ status: 'succeeded', synthetic: true, property: SYNTHETIC_PROPERTY, timeZone: 'America/Los_Angeles' });
    expect(parsed.datasets.map((d: { dataset: string }) => d.dataset)).toEqual(['gsc_property_daily', 'gsc_page_daily', 'gsc_page_query_daily']);
  });

  it('sync gsc human output explains separate datasets; dry run writes nothing', async () => {
    ctx = googleTestContext({ now: NOW });
    const human = await runCommand(reg(ctx), ['sync', 'gsc', '--days', '3', '--no-page-query']);
    expect(human.out).toMatch(/SYNTHETIC FIXTURES/);
    expect(human.out).toMatch(/never summed together/);
    const dry = await runCommand(reg(ctx), ['--dry-run', 'sync', 'gsc', '--segments', 'country,device']);
    expect(dry.out).toMatch(/DRY_RUN/);
    expect(dry.out).toMatch(/no Google request was made/);
  });

  it('validates options', async () => {
    ctx = googleTestContext({ now: NOW });
    const bad = await runCommand(reg(ctx), ['sync', 'gsc', '--segments', 'browser']);
    expect(bad.failed).toBe(true);
    expect(bad.err).toMatch(/Unknown segment "browser"/);
    const badDays = await runCommand(reg(ctx), ['sync', 'ga4', '--days', '0']);
    expect(badDays.failed).toBe(true);
  });

  it('sync ga4 reports limitations and the checklist is available offline', async () => {
    ctx = googleTestContext({ now: NOW, config: googleConfig({ conversions: { primaryEvents: [{ name: 'book_demo', meaning: 'Demo booked (synthetic)', kind: 'booking' }] } }) });
    const r = await runCommand(reg(ctx), ['sync', 'ga4', '--days', '3', '--periods', '7']);
    expect(r.out).toMatch(/session key-event rate metric: UNAVAILABLE/);
    expect(r.out).toMatch(/sessionKeyEventRate:book_demo/);
    expect(r.out).toMatch(/conversion verification checklist/i);
    const cl = await runCommand(reg(ctx), ['sync', 'ga4', '--checklist']);
    expect(cl.out).toMatch(/Primary event "book_demo"/);
    expect(cl.out).toMatch(/never submits forms/);
  });

  it('sync ga4 --confirm-rate-scale records an audited owner assertion, re-marks stored rates, and sends no GA4 request', async () => {
    ctx = googleTestContext({ now: NOW });
    await runCommand(reg(ctx), ['sync', 'ga4', '--days', '3', '--periods', '7']);
    const scales = () => ctx.db.all<{ s: string }>('SELECT DISTINCT primary_session_rate_scale AS s FROM ga4_landing_daily_current WHERE site_id = ? AND primary_session_rate IS NOT NULL', [ctx.siteId]).map((r) => r.s);
    expect(scales()).toEqual(['undetermined']);
    const requests = () => ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM provider_requests WHERE site_id = ? AND provider = 'google_ga4'", [ctx.siteId])!.n;
    const before = requests();

    // Dry run: nothing recorded, nothing re-marked.
    const dry = await runCommand(reg(ctx), ['--dry-run', '--json', 'sync', 'ga4', '--confirm-rate-scale', 'fraction', '--evidence', 'GA4 UI shows 6.00% for /pricing on 2026-09-20; stored 0.06', '--as', 'Test Owner']);
    expect(dry.failed).toBe(false);
    expect(JSON.parse(dry.out)).toMatchObject({ dryRun: true, confirmationId: null, scale: 'fraction', basis: 'owner_assertion', remarked: { landingRows: expect.any(Number) } });
    expect(scales()).toEqual(['undetermined']);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ga4_rate_scale_confirmations WHERE site_id = ?', [ctx.siteId])!.n).toBe(0);

    const r = await runCommand(reg(ctx), ['sync', 'ga4', '--confirm-rate-scale', 'fraction', '--evidence', 'GA4 UI shows 6.00% for /pricing on 2026-09-20; stored 0.06', '--as', 'Test Owner']);
    expect(r.failed).toBe(false);
    expect(r.out).toMatch(/GA4 key-event rate scale confirmed: fraction \(0-1: 0\.025 means 2\.5%\) for property 123456789 \(owner assertion\); confirmation ga4rs_/);
    expect(r.out).toMatch(/Re-marked [1-9]\d* daily landing-page rate row\(s\) and [1-9]\d* period rate row\(s\)/);
    expect(scales()).toEqual(['fraction']);
    expect(requests()).toBe(before);
    const audit = ctx.db.get<{ actor: string; details_json: string }>("SELECT actor, details_json FROM audit_events WHERE site_id = ? AND event_type = 'google.ga4.rate_scale_confirmed'", [ctx.siteId])!;
    expect(audit.actor).toBe('owner:Test Owner');
    expect(JSON.parse(audit.details_json)).toMatchObject({ scale: 'fraction', basis: 'owner_assertion', evidence: 'GA4 UI shows 6.00% for /pricing on 2026-09-20; stored 0.06' });
    // The assertion is append-only.
    expect(() => ctx.db.run('UPDATE ga4_rate_scale_confirmations SET scale = ?', ['percent'])).toThrow(/append-only/);

    // Validation: evidence is required, the scale is one of two words, --evidence alone is refused.
    const noEvidence = await runCommand(reg(ctx), ['sync', 'ga4', '--confirm-rate-scale', 'percent', '--as', 'Test Owner']);
    expect(noEvidence.failed).toBe(true);
    expect(noEvidence.err).toMatch(/needs --evidence/);
    const bad = await runCommand(reg(ctx), ['sync', 'ga4', '--confirm-rate-scale', '0-1', '--evidence', 'GA4 UI shows 6.00% for /pricing']);
    expect(bad.failed).toBe(true);
    expect(bad.err).toMatch(/Unknown rate scale "0-1"/);
    const stray = await runCommand(reg(ctx), ['sync', 'ga4', '--evidence', 'GA4 UI shows 6.00% for /pricing']);
    expect(stray.failed).toBe(true);
    expect(stray.err).toMatch(/only used with --confirm-rate-scale/);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ga4_rate_scale_confirmations WHERE site_id = ?', [ctx.siteId])!.n).toBe(1);

    // The next sync says which scale it used and why.
    const next = await runCommand(reg(ctx), ['sync', 'ga4', '--days', '3', '--periods', '7']);
    expect(next.out).toMatch(/Key-event rate scale: 0-1 reported by GA4, stored as reported \(recorded owner confirmation ga4rs_/);
  });

  it('sync ga4 names the confirm option while the rate scale is undetermined, and lists unused primary events as a limitation', async () => {
    ctx = googleTestContext({
      now: NOW,
      config: googleConfig({ conversions: { primaryEvents: [{ name: 'generate_lead', meaning: 'Lead form (synthetic)', kind: 'lead' }, { name: 'purchase', meaning: 'Purchase (synthetic)', kind: 'purchase' }] } }),
    });
    const r = await runCommand(reg(ctx), ['sync', 'ga4', '--days', '3', '--periods', '7']);
    expect(r.out).toMatch(/Key-event rate scale: UNDETERMINED .*--confirm-rate-scale fraction\|percent --evidence/);
    expect(r.out).toMatch(/sessionKeyEventRate:purchase: primary event\(s\) "purchase" are not used for conversion rates: only the first configured primary event "generate_lead"/);
    const cl = await runCommand(reg(ctx), ['sync', 'ga4', '--checklist']);
    expect(cl.out).toMatch(/LIMITATION: primary event\(s\) "purchase" are not used for conversion rates/);
    expect(cl.out).toMatch(/--confirm-rate-scale fraction --evidence/);
  });

  it('sync inspect uses priority URLs and labels indexed state', async () => {
    ctx = googleTestContext({ now: NOW });
    await runCommand(reg(ctx), ['sync', 'gsc', '--days', '3', '--no-page-query']);
    const r = await runCommand(reg(ctx), ['sync', 'inspect', '--top', '2']);
    expect(r.out).toMatch(/inspected 2/);
    expect(r.out).toMatch(/Not a live test/);
  });

  it('sync inspect reports nothing_inspected with a notice and a non-zero exit when every URL is skipped', async () => {
    ctx = googleTestContext({ now: NOW });
    const r = await runCommand(reg(ctx), ['sync', 'inspect', 'https://other.example.invalid/a', 'https://other.example.invalid/b']);
    expect(r.out).toMatch(/URL Inspection: nothing_inspected/);
    expect(r.out).toMatch(/inspected 0, skipped 2, failed 0/);
    expect(r.out).toMatch(/NOTICE: nothing was inspected/);
    expect(r.out).toMatch(/Not under the Search Console property/);
    expect(r.exitCode).toBe(2);
    const json = await runCommand(reg(ctx), ['--json', 'sync', 'inspect', 'https://other.example.invalid/a']);
    expect(JSON.parse(json.out)).toMatchObject({ status: 'nothing_inspected', inspected: 0, failed: 0 });
    expect(json.exitCode).toBe(2);
    // A real inspection still exits 0.
    const ok = await runCommand(reg(ctx), ['sync', 'inspect', 'https://www.example.test/']);
    expect(ok.out).toMatch(/URL Inspection: succeeded/);
    expect(ok.exitCode).toBeUndefined();
  });
});

describe('sync dry runs check credentials offline (C3-04)', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const batches = (c: TestContext) => c.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ingestion_batches WHERE site_id = ?', [c.siteId])!.n;

  it('without credentials, `sync gsc --dry-run` and `sync ga4 --dry-run` fail exactly like the real run (CREDENTIALS_MISSING, exit 3); nothing is requested or written', async () => {
    ctx = googleTestContext({ now: NOW }); // its fetch throws on any request
    for (const api of ['gsc', 'ga4'] as const) {
      const real = await runCommand(regLive(ctx), ['sync', api, '--days', '3']);
      const dry = await runCommand(regLive(ctx), ['--dry-run', 'sync', api, '--days', '3']);
      for (const r of [real, dry]) {
        expect(r.failed, api).toBe(true);
        expect(r.exitCode, api).toBe(3);
        expect(r.err).toMatch(/Error \[CREDENTIALS_MISSING\]: google_auth: missing credentials \(OAuth client file\)/);
        expect(r.err).toMatch(/Next step: Create a "Desktop app" OAuth client/);
      }
      expect(dry.err, api).toBe(real.err); // the same message and hint
      expect(dry.out).not.toMatch(/DRY_RUN|Planned/);
      const json = await runCommand(regLive(ctx), ['--dry-run', '--json', 'sync', api]);
      expect(json.exitCode).toBe(3);
      expect(JSON.parse(json.out)).toMatchObject({ ok: false, error: { code: 'CREDENTIALS_MISSING' } });
    }
    expect(batches(ctx)).toBe(0);
  });

  it('a missing service-account key file fails the dry run too; ADC from a metadata server is reported as not verified, never as checked', async () => {
    ctx = googleTestContext({ now: NOW });
    const missingKey = await runCommand(regLive(ctx, (c) => new ServiceAccountGoogleAuthProvider({ keyFile: path.join(c.paths.googleDir, 'missing-key.json'), fetch: c.fetch })), ['--dry-run', 'sync', 'gsc']);
    expect(missingKey.exitCode).toBe(3);
    expect(missingKey.err).toMatch(/CREDENTIALS_MISSING.*GOOGLE_APPLICATION_CREDENTIALS file/);
    const home = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-adc-'));
    tmpDirs.push(home);
    const adc = await runCommand(regLive(ctx, (c) => new ServiceAccountGoogleAuthProvider({ keyFile: null, fetch: c.fetch, env: { HOME: home } })), ['--dry-run', '--json', 'sync', 'ga4']);
    expect(adc.failed).toBe(false);
    const plan = JSON.parse(adc.out);
    expect(plan).toMatchObject({ status: 'dry_run', plan: { credentialCheck: 'unverified' } });
    expect(plan.warnings.join(' ')).toMatch(/Credentials NOT verified: .*metadata server/);
  });

  it('with a resolvable OAuth client file and stored token, the dry run plans (credentials checked locally) and makes no request', async () => {
    ctx = googleTestContext({ now: NOW });
    mkdirSync(ctx.paths.googleDir, { recursive: true });
    const clientFile = path.join(ctx.paths.googleDir, 'oauth-client.json');
    // SYNTHETIC OAuth client and token (never valid anywhere).
    writeFileSync(clientFile, JSON.stringify({ installed: { client_id: 'synthetic-client.apps.example.invalid', client_secret: 'synthetic-secret', project_id: 'synthetic' } }), { mode: 0o600 });
    const tokenFile = path.join(ctx.paths.googleDir, 'token.json');
    const store = new TokenStore(tokenFile, ctx.clock);
    store.write({ format: TOKEN_FORMAT, client_id: 'synthetic-client.apps.example.invalid', requested_scopes: [], tokens: { refresh_token: 'synthetic-refresh-token', access_token: 'synthetic-access-token' }, obtained_via: 'desktop_loopback_pkce', created_at: NOW, updated_at: NOW, refresh_token_expires_at: null });
    const provider = (c: AppContext) => new OAuthGoogleAuthProvider({ clientFile, tokenStore: new TokenStore(tokenFile, c.clock), fetch: c.fetch });
    for (const api of ['gsc', 'ga4'] as const) {
      const dry = await runCommand(regLive(ctx, provider), ['--dry-run', '--json', 'sync', api]);
      expect(dry.failed, dry.err).toBe(false);
      expect(JSON.parse(dry.out)).toMatchObject({ status: 'dry_run', plan: { credentialCheck: 'ok' } });
    }
    const human = await runCommand(regLive(ctx, provider), ['--dry-run', 'sync', 'gsc']);
    expect(human.out).toMatch(/Credentials: the OAuth client file and stored token resolve \(checked locally without a network call/);
    expect(batches(ctx)).toBe(0);
  });

  it('fixture (demo) dry runs keep planning', async () => {
    ctx = googleTestContext({ now: NOW });
    const r = await runCommand(reg(ctx), ['--dry-run', '--json', 'sync', 'gsc']);
    expect(JSON.parse(r.out)).toMatchObject({ status: 'dry_run', synthetic: true, plan: { credentialCheck: 'fixture' } });
    const g = await runCommand(reg(ctx), ['--dry-run', '--json', 'sync', 'ga4']);
    expect(JSON.parse(g.out)).toMatchObject({ status: 'dry_run', plan: { credentialCheck: 'fixture' } });
  });
});

describe('sync ga4 --confirm-rate-scale needs a named human (C1-13)', () => {
  const EVIDENCE = 'GA4 UI shows 6.00% for /pricing on 2026-09-20; stored 0.06';

  it('refuses a confirmation without --as, and automation names, before recording anything', async () => {
    ctx = googleTestContext({ now: NOW });
    const none = await runCommand(reg(ctx), ['sync', 'ga4', '--confirm-rate-scale', 'fraction', '--evidence', EVIDENCE]);
    expect(none.failed).toBe(true);
    expect(none.err).toMatch(/--confirm-rate-scale needs --as "<your name>"/);
    const blank = await runCommand(reg(ctx), ['sync', 'ga4', '--confirm-rate-scale', 'fraction', '--evidence', EVIDENCE, '--as', '  ']);
    expect(blank.err).toMatch(/needs --as/);
    const dryNone = await runCommand(reg(ctx), ['--dry-run', 'sync', 'ga4', '--confirm-rate-scale', 'fraction', '--evidence', EVIDENCE]);
    expect(dryNone.failed).toBe(true);
    // D3-01: the anonymous "owner", generic account names, look-alike and concatenated automation names too.
    for (const name of ['cli', 'system', 'scheduler', 'model', 'agent', 'claude', 'Claude Agent', 'owner:scheduler', 'owner', 'Owner', 'owner:owner', 'root', 'node', '\u0421laude', '\uff43\uff4c\uff41\uff55\uff44\uff45', 'claudecode', 'agent007']) {
      const r = await runCommand(reg(ctx), ['sync', 'ga4', '--confirm-rate-scale', 'fraction', '--evidence', EVIDENCE, '--as', name]);
      expect(r.failed, name).toBe(true);
      expect(r.err, name).toMatch(/VALIDATION_FAILED/);
    }
    const stray = await runCommand(reg(ctx), ['sync', 'ga4', '--as', 'Test Owner', '--days', '3']);
    expect(stray.err).toMatch(/--as is only used with --confirm-rate-scale/);
    expect(confirmations(ctx)).toBe(0);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE site_id = ? AND event_type = 'google.ga4.rate_scale_confirmed'", [ctx.siteId])!.n).toBe(0);
  });

  it('confirmRateScale itself refuses an owner assertion by an automation identity or the anonymous "owner" (no bypass through the library)', () => {
    ctx = googleTestContext({ now: NOW });
    for (const actor of ['system', 'owner:system', 'owner:scheduler', 'cli', 'owner:model', 'agent', 'owner:claude', '', 'owner', 'owner:owner', 'Owner', 'owner:root', 'owner:\u0421laude', 'owner:seoagent']) {
      expect(() => confirmRateScale(ctx, SYNTHETIC_GA4, { scale: 'fraction', evidence: EVIDENCE, actor }), actor).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    }
    expect(confirmations(ctx)).toBe(0);
    const ok = confirmRateScale(ctx, SYNTHETIC_GA4, { scale: 'fraction', evidence: EVIDENCE, actor: 'owner:Test Owner' });
    expect(ok.confirmationId).toMatch(/^ga4rs_/);
    // The sync's integer-consistency proof is recorded by the system (not an owner assertion).
    expect(() => confirmRateScale(ctx, SYNTHETIC_GA4, { scale: 'fraction', basis: 'integer_consistency', evidence: 'Proven by the GA4 sync from stored daily rows (synthetic).', actor: 'system' })).not.toThrow();
  });
});
