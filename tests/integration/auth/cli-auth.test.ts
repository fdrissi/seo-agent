import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { register, type AuthCommandDeps } from '../../../src/cli/commands/auth.js';
import { credentialPathsFor, tokenStoreFor } from '../../../src/auth/providers.js';
import { loadOAuthClientFile } from '../../../src/auth/client-file.js';
import { REQUIRED_SCOPES } from '../../../src/auth/oauth-flow.js';
import { TOKEN_FORMAT } from '../../../src/auth/token-store.js';
import { diagnoseGoogle, LEAST_PRIVILEGE_GUIDANCE } from '../../../src/auth/diagnose.js';
import { authStatus } from '../../../src/auth/status.js';
import { revokeGoogleAuthorization } from '../../../src/auth/revoke.js';
import { fakeFetch, jsonResponse, match } from '../../helpers/fake-fetch.js';
import { GOOGLE_FIXTURES, ScriptedClient, SYNTHETIC_PROPERTY, googleConfig, googleTestContext, providerFor, reopen, sitesList } from '../google/_helpers.js';
import { runCommand } from '../google/_cli.js';
import { httpGet } from '../../unit/auth/_http.js';
import type { TestContext } from '../../helpers/context.js';
import type { FetchLike } from '../../../src/integrations/types.js';

const ACCESS = 'ya29.synthetic-cli-access-token-0123456789';
const REFRESH = '1//synthetic-cli-refresh-token-abcdefghijklmnopqrstuvwxyz';
const SCOPE = REQUIRED_SCOPES.join(' ');

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

function seedOAuth(c: TestContext, opts: { refresh?: boolean; createdAt?: string } = {}) {
  const clientFile = credentialPathsFor(c).clientFile;
  mkdirSync(path.dirname(clientFile), { recursive: true });
  copyFileSync(path.join(GOOGLE_FIXTURES, 'oauth/client-installed.json'), clientFile);
  const info = loadOAuthClientFile(clientFile);
  tokenStoreFor(c).write({
    format: TOKEN_FORMAT,
    client_id: info.clientId,
    requested_scopes: [...REQUIRED_SCOPES],
    tokens: { access_token: ACCESS, ...(opts.refresh === false ? {} : { refresh_token: REFRESH }), expiry_date: Date.parse('2026-09-24T09:30:00Z'), token_type: 'Bearer', scope: SCOPE },
    obtained_via: 'desktop_loopback_pkce',
    created_at: opts.createdAt ?? '2026-09-16T09:00:00.000Z',
    updated_at: opts.createdAt ?? '2026-09-16T09:00:00.000Z',
    refresh_token_expires_at: null,
  });
}

const reg = (c: TestContext, extra: { fetch?: FetchLike; provider?: AuthCommandDeps['provider'] } = {}) => (program: Parameters<typeof register>[0], cli: Parameters<typeof register>[1]) =>
  register(program, cli, { context: (g) => reopen(c, { ...(extra.fetch ? { fetch: extra.fetch } : {}), ...(g.dryRun ? { dryRun: true } : {}), ...(g.offline ? { offline: true } : {}) }), ...(extra.provider ? { provider: extra.provider } : {}) });

describe('auth status', () => {
  it('never prints token values (human or JSON) and shows expiry hints', async () => {
    ctx = googleTestContext();
    seedOAuth(ctx);
    const human = await runCommand(reg(ctx), ['auth', 'status', '--no-network']);
    const json = await runCommand(reg(ctx), ['--json', 'auth', 'status', '--no-network']);
    for (const r of [human, json]) {
      expect(r.failed).toBe(false);
      expect(r.out + r.err).not.toContain(ACCESS);
      expect(r.out + r.err).not.toContain(REFRESH);
      expect(r.out + r.err).not.toContain('synthetic-client-secret-not-real');
    }
    expect(human.out).toMatch(/refresh token stored: yes/);
    expect(human.out).toMatch(/access token expires: 2026-09-24T09:30:00.000Z/);
    expect(human.out).toMatch(/7 days after consent/);
    const parsed = JSON.parse(json.out);
    expect(parsed.oauth.tokenStatus).toMatchObject({ present: true, hasRefreshToken: true, fileMode: '600' });
    expect(parsed.statuses.find((s: { id: string }) => s.id === 'google_auth').state).toBe('configured_unverified');
  });

  it('lists accessible Search Console properties with permission levels and checks GA4 access', async () => {
    ctx = googleTestContext({ config: googleConfig({ google: { searchConsoleProperty: 'https://example.test/' } }) });
    seedOAuth(ctx);
    const client = new ScriptedClient((req) => {
      if (req.path === '/webmasters/v3/sites') return sitesList([[SYNTHETIC_PROPERTY, 'siteFullUser'], ['https://www.example.test/', 'SITE_RESTRICTED_USER'], ['http://old.example.net/', 'siteUnverifiedUser']]);
      if (req.path.endsWith('/metadata')) return { body: { metrics: [{ apiName: 'sessions' }], dimensions: [] } };
      return { status: 404, body: {} };
    });
    const r = await runCommand(reg(ctx, { provider: () => providerFor(client) }), ['auth', 'status']);
    expect(r.out).toMatch(/sc-domain:example\.test\s+\[siteFullUser\]/);
    expect(r.out).toMatch(/https:\/\/www\.example\.test\/\s+\[siteRestrictedUser\]/);
    expect(r.out).toMatch(/http:\/\/old\.example\.net\/\s+\[siteUnverifiedUser, cannot read data\]/);
    expect(r.out).toMatch(/NOT accessible/);
    expect(r.out).toMatch(/did you mean: .*sc-domain:example\.test/);
    expect(r.out).toMatch(/GA4 property: 123456789 - access ok/);
    // The primary event rate is not listed: the limitation is surfaced, not hidden.
    expect(r.out).toMatch(/generate_lead: session key-event rate UNAVAILABLE/);
    const check = reopen(ctx);
    expect(check.db.all('SELECT property, permission_level FROM gsc_properties WHERE site_id = ? ORDER BY property', [ctx.siteId])).toHaveLength(3);
    check.db.close();
  });

  it('reports missing credentials honestly without network calls', async () => {
    ctx = googleTestContext();
    const r = await authStatus(ctx, { network: true });
    expect(r.network.checked).toBe(false);
    const auth = r.statuses.find((s) => s.id === 'google_auth')!;
    expect(auth).toMatchObject({ state: 'missing_credentials', networkChecked: false, chargeable: false });
    expect(auth.nextStep).toMatch(/Desktop app/);
    expect(r.statuses.find((s) => s.id === 'google_gsc')!.state).toBe('missing_credentials');
    expect(r.statuses.every((s) => s.sendsExternally.length > 0)).toBe(true);
  });

  it('reports fixture state in the demo profile', async () => {
    ctx = googleTestContext({ config: googleConfig({ profile: 'demo' }), offline: true });
    const r = await authStatus(ctx, { network: true });
    expect(r.mode).toBe('fixture');
    expect(r.statuses.map((s) => s.state)).toEqual(['fixture', 'fixture', 'fixture', 'fixture']);
    expect(r.gsc.properties?.length).toBeGreaterThan(0);
  });

  it('a demo workspace never claims network checks: the fixtures answered in-process (C3-06)', async () => {
    ctx = googleTestContext({ config: googleConfig({ profile: 'demo' }), offline: true });
    const r = await authStatus(ctx, { network: true });
    expect(r.network).toMatchObject({ checked: false, fixture: true });
    expect(r.statuses.every((s) => s.networkChecked === false)).toBe(true);
    const human = await runCommand(reg(ctx), ['auth', 'status']);
    expect(human.failed).toBe(false);
    expect(human.out).toMatch(/Mode: fixture \[SYNTHETIC FIXTURES\]/);
    expect(human.out).toContain('Network checks: none (demo fixtures answered in-process)');
    expect(human.out).not.toMatch(/Network checks: performed/);
    const json = JSON.parse((await runCommand(reg(ctx), ['--json', 'auth', 'status'])).out);
    expect(json.network).toMatchObject({ checked: false, fixture: true });
    // Diagnose still evaluates the fixture answers, and labels them as not network-checked.
    const d = await diagnoseGoogle(ctx, { network: true });
    expect(d.networkChecked).toBe(false);
    expect(d.findings.map((f) => f.code)).not.toContain('NETWORK_NOT_CHECKED');
  });
});

describe('auth diagnose', () => {
  it('distinguishes API enablement, property access, and testing-mode expiry', async () => {
    ctx = googleTestContext();
    seedOAuth(ctx, { createdAt: '2026-09-15T00:00:00.000Z' });
    const client = new ScriptedClient((req) => {
      if (req.path === '/webmasters/v3/sites') return sitesList([['https://www.example.test/', 'siteOwner']]);
      return { status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Google Analytics Data API has not been used in project 42 before or it is disabled.', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }] } } };
    });
    const d = await diagnoseGoogle(ctx, { network: true, provider: providerFor(client) });
    const codes = d.findings.map((f) => f.code);
    expect(codes).toContain('GA4_API_NOT_ENABLED');
    expect(codes).toContain('GSC_PROPERTY_MISMATCH');
    expect(d.findings.find((f) => f.code === 'GSC_PROPERTY_MISMATCH')!.message).toMatch(/https:\/\/www\.example\.test\//);

    const expired = new ScriptedClient(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }));
    const d2 = await diagnoseGoogle(ctx, { network: true, provider: providerFor(expired) });
    const f = d2.findings.find((x) => x.code === 'REFRESH_INVALID_GRANT')!;
    expect(f.message).toMatch(/Testing.*7 days/);
    expect(f.nextStep).toMatch(/auth google/);

    const denied = new ScriptedClient(() => ({ status: 403, body: { error: { code: 403, message: "User does not have sufficient permission for site 'sc-domain:example.test'.", errors: [{ reason: 'forbidden' }] } } }));
    const d3 = await diagnoseGoogle(ctx, { network: true, provider: providerFor(denied) });
    expect(d3.findings.map((x) => x.code)).toEqual(expect.arrayContaining(['GSC_NO_ACCESS', 'GA4_NO_ACCESS']));
  });

  it('flags wrong property formats offline and recommends least privilege only', async () => {
    ctx = googleTestContext({ config: googleConfig({ google: { searchConsoleProperty: 'https://www.example.test/?x=1/' } }) });
    const d = await diagnoseGoogle(ctx, { network: false });
    expect(d.findings.find((f) => f.code === 'GSC_PROPERTY_FORMAT')!.message).toMatch(/query string/);
    expect(d.findings.map((f) => f.code)).toContain('CLIENT_FILE_MISSING');
    const text = [...LEAST_PRIVILEGE_GUIDANCE, ...d.findings.map((f) => `${f.message} ${f.nextStep ?? ''}`)].join('\n');
    expect(text).toMatch(/Restricted user/);
    expect(text).toMatch(/Viewer/);
    expect(text).not.toMatch(/\b(grant|add|give)\b[^.\n]*\b(Owner|Editor|Administrator)\b(?! is not)/);
  });

  it('CLI exits non-zero when errors are found', async () => {
    ctx = googleTestContext();
    const r = await runCommand(reg(ctx), ['auth', 'diagnose', '--no-network']);
    expect(r.out).toMatch(/ERROR CLIENT_FILE_MISSING/);
    expect(r.exitCode).toBe(1);
  });
});

describe('auth revoke', () => {
  it('revokes the refresh token at Google and deletes the local token', async () => {
    let revoked = '';
    const fetch = fakeFetch([
      match('POST', 'https://oauth2.googleapis.com/revoke', (req) => {
        revoked = new URL(req.url).searchParams.get('token') ?? new URLSearchParams(req.body ?? '').get('token') ?? '';
        return new Response('', { status: 200 });
      }),
    ]);
    ctx = googleTestContext({ fetch });
    seedOAuth(ctx);
    const r = await runCommand(reg(ctx, { fetch }), ['--json', 'auth', 'revoke']);
    const parsed = JSON.parse(r.out);
    expect(parsed).toMatchObject({ remote: 'revoked', localTokenDeleted: true });
    expect(revoked).toBe(REFRESH);
    expect(r.out).not.toContain(REFRESH);
    expect(tokenStoreFor(ctx).exists()).toBe(false);
  });

  it('treats a 400 as already invalid, keeps the token on network failure, and supports --local-only', async () => {
    ctx = googleTestContext({ fetch: fakeFetch([match('POST', 'https://oauth2.googleapis.com/revoke', () => jsonResponse({ error: 'invalid_token' }, 400))]) });
    seedOAuth(ctx);
    expect(await revokeGoogleAuthorization(ctx)).toMatchObject({ remote: 'already_invalid', localTokenDeleted: true });

    seedOAuth(ctx);
    const failing = reopen(ctx, {
      fetch: async () => {
        throw new Error('ECONNRESET synthetic');
      },
    });
    await expect(revokeGoogleAuthorization(failing)).rejects.toThrow(/Revocation failed/);
    expect(tokenStoreFor(ctx).exists()).toBe(true);
    const local = await revokeGoogleAuthorization(failing, { localOnly: true });
    expect(local).toMatchObject({ remote: 'not_attempted', localTokenDeleted: true });
    expect(local.notes.join(' ')).toMatch(/myaccount\.google\.com\/permissions/);
    failing.db.close();
  });

  it('dry run changes nothing', async () => {
    ctx = googleTestContext();
    seedOAuth(ctx);
    const r = await revokeGoogleAuthorization(ctx, { dryRun: true });
    expect(r).toMatchObject({ dryRun: true, remote: 'not_attempted', localTokenDeleted: false });
    expect(tokenStoreFor(ctx).exists()).toBe(true);
  });
});

describe('auth google', () => {
  it('prints the consent URL, receives the redirect on 127.0.0.1, and stores the token without echoing it', async () => {
    const fetch = fakeFetch([match('POST', 'https://oauth2.googleapis.com/token', () => jsonResponse({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3599, scope: SCOPE, token_type: 'Bearer' }))]);
    ctx = googleTestContext({ fetch });
    seedOAuth(ctx);
    tokenStoreFor(ctx).delete();
    const r = await runCommand(reg(ctx, { fetch }), ['auth', 'google', '--timeout', '15'], {
      onErr: (text) => {
        const m = /(https:\/\/accounts\.google\.com\/\S+)/.exec(text);
        if (!m) return;
        const u = new URL(m[1]!);
        void httpGet(`${u.searchParams.get('redirect_uri')}/?code=synthetic-cli-code&state=${encodeURIComponent(u.searchParams.get('state')!)}&scope=${encodeURIComponent(SCOPE)}`);
      },
    });
    expect(r.failed).toBe(false);
    expect(r.err).toMatch(/never need to copy or paste a code or token/);
    expect(r.err).toMatch(/listening on 127\.0\.0\.1 only/);
    expect(r.out).toMatch(/Google authorization stored/);
    expect(r.out + r.err).not.toContain(ACCESS);
    expect(r.out + r.err).not.toContain(REFRESH);
    expect(tokenStoreFor(ctx).read()!.tokens.refresh_token).toBe(REFRESH);
  });

  it('dry run validates the client without starting a listener; service-account mode explains what to grant', async () => {
    ctx = googleTestContext();
    seedOAuth(ctx);
    const dry = await runCommand(reg(ctx), ['--dry-run', 'auth', 'google']);
    expect(dry.out).toMatch(/Dry run: would start a one-shot listener on http:\/\/127\.0\.0\.1/);
    ctx.cleanup();
    ctx = googleTestContext({ secrets: { GOOGLE_AUTH_MODE: 'service_account' } });
    const sa = await runCommand(reg(ctx), ['auth', 'google']);
    expect(sa.out).toMatch(/no browser authorization is needed/);
    expect(sa.out).toMatch(/Viewer role in GA4/);
  });

  it('refuses a Web client with an actionable error', async () => {
    ctx = googleTestContext();
    const clientFile = credentialPathsFor(ctx).clientFile;
    mkdirSync(path.dirname(clientFile), { recursive: true });
    copyFileSync(path.join(GOOGLE_FIXTURES, 'oauth/client-web.json'), clientFile);
    const r = await runCommand(reg(ctx), ['auth', 'google', '--timeout', '10']);
    expect(r.failed).toBe(true);
    expect(r.err).toMatch(/Desktop app/);
  });
});
