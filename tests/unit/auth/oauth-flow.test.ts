import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAuthorizationUrl, createOAuth2Client, newOAuthState, REQUIRED_SCOPES, runDesktopOAuthFlow } from '../../../src/auth/oauth-flow.js';
import { OAuthGoogleAuthProvider, tokenStoreFor, credentialPathsFor } from '../../../src/auth/providers.js';
import { TOKEN_FORMAT } from '../../../src/auth/token-store.js';
import { loadOAuthClientFile } from '../../../src/auth/client-file.js';
import { GoogleApiError } from '../../../src/integrations/google/errors.js';
import { fakeFetch, jsonResponse, match } from '../../helpers/fake-fetch.js';
import { GOOGLE_FIXTURES, googleTestContext } from '../../integration/google/_helpers.js';
import type { TestContext } from '../../helpers/context.js';
import { httpGet } from './_http.js';

const ACCESS = 'ya29.synthetic-access-token-flow-0123456789';
const REFRESH = '1//synthetic-refresh-token-flow-abcdefghijklmnopqrstuvwxyz';
const SCOPE = REQUIRED_SCOPES.join(' ');

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

function installClient(c: TestContext): string {
  const dest = credentialPathsFor(c).clientFile;
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(path.join(GOOGLE_FIXTURES, 'oauth/client-installed.json'), dest);
  return dest;
}

describe('authorization URL', () => {
  it('requests only the two read scopes with PKCE S256, offline access, consent, and state', async () => {
    const info = loadOAuthClientFile(path.join(GOOGLE_FIXTURES, 'oauth/client-installed.json'));
    const client = createOAuth2Client(info, async () => new Response('{}'), 'http://127.0.0.1:53682');
    const state = newOAuthState();
    const { url, codeVerifier, codeChallenge } = await buildAuthorizationUrl(client, state);
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = u.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toBe(codeChallenge);
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('state')).toBe(state);
    expect(state.length).toBeGreaterThanOrEqual(43);
    expect(p.get('redirect_uri')).toBe('http://127.0.0.1:53682');
    expect(p.get('scope')!.split(' ').sort()).toEqual(['https://www.googleapis.com/auth/analytics.readonly', 'https://www.googleapis.com/auth/webmasters.readonly']);
    expect(url).not.toMatch(/auth\/webmasters(?!\.readonly)|auth\/analytics(?!\.readonly)/);
    expect(p.get('include_granted_scopes')).toBeNull();
  });
});

describe('desktop OAuth flow (loopback + PKCE), offline with a fake token endpoint', () => {
  it('exchanges the code with the verifier and stores the token 0600 without returning it', async () => {
    let tokenBody = '';
    const fetch = fakeFetch([
      match('POST', 'https://oauth2.googleapis.com/token', (req) => {
        tokenBody = req.body ?? '';
        return jsonResponse({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3599, scope: SCOPE, token_type: 'Bearer' });
      }),
    ]);
    ctx = googleTestContext({ fetch });
    installClient(ctx);
    const store = tokenStoreFor(ctx);
    let redirect = '';
    let authUrl = '';
    const result = await runDesktopOAuthFlow({
      clientFile: credentialPathsFor(ctx).clientFile,
      tokenStore: store,
      fetch,
      clock: ctx.clock,
      timeoutMs: 5_000,
      onAuthUrl: (url, info) => {
        authUrl = url;
        redirect = info.redirectUri;
        const state = new URL(url).searchParams.get('state')!;
        // Simulated browser redirect to the loopback listener.
        void httpGet(`${info.redirectUri}/?code=synthetic-auth-code&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(SCOPE)}`);
      },
    });
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(new URL(authUrl).searchParams.get('redirect_uri')).toBe(redirect);
    const form = new URLSearchParams(tokenBody);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('synthetic-auth-code');
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(form.get('redirect_uri')).toBe(redirect);
    expect(result).toMatchObject({ hasRefreshToken: true, missingScopes: [], redirectHost: '127.0.0.1' });
    expect(JSON.stringify(result)).not.toContain(ACCESS);
    expect(JSON.stringify(result)).not.toContain(REFRESH);
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(store.file)).mode & 0o777).toBe(0o700);
    const stored = store.read()!;
    expect(stored).toMatchObject({ format: TOKEN_FORMAT, obtained_via: 'desktop_loopback_pkce' });
    expect(stored.tokens.refresh_token).toBe(REFRESH);
  });

  it('warns when a read scope was not granted', async () => {
    const fetch = fakeFetch([match('POST', 'https://oauth2.googleapis.com/token', () => jsonResponse({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3599, scope: REQUIRED_SCOPES[0], token_type: 'Bearer' }))]);
    ctx = googleTestContext({ fetch });
    installClient(ctx);
    const result = await runDesktopOAuthFlow({
      clientFile: credentialPathsFor(ctx).clientFile,
      tokenStore: tokenStoreFor(ctx),
      fetch,
      timeoutMs: 5_000,
      onAuthUrl: (url, info) => void httpGet(`${info.redirectUri}/?code=c&state=${encodeURIComponent(new URL(url).searchParams.get('state')!)}`),
    });
    expect(result.missingScopes).toEqual([REQUIRED_SCOPES[1]]);
    expect(result.warnings.join(' ')).toMatch(/Not granted/);
  });

  it('rejects a forged callback and stores nothing', async () => {
    const fetch = fakeFetch([]);
    ctx = googleTestContext({ fetch });
    installClient(ctx);
    const store = tokenStoreFor(ctx);
    await expect(
      runDesktopOAuthFlow({
        clientFile: credentialPathsFor(ctx).clientFile,
        tokenStore: store,
        fetch,
        timeoutMs: 5_000,
        onAuthUrl: (_url, info) => void httpGet(`${info.redirectUri}/?code=attacker&state=forged-state-value-000000000000000`),
      }),
    ).rejects.toThrow(/state mismatch/);
    expect(fetch.calls).toHaveLength(0);
    expect(store.exists()).toBe(false);
  });
});

describe('OAuth provider', () => {
  function seed(c: TestContext, expiry: number) {
    installClient(c);
    const info = loadOAuthClientFile(credentialPathsFor(c).clientFile);
    tokenStoreFor(c).write({
      format: TOKEN_FORMAT,
      client_id: info.clientId,
      requested_scopes: [...REQUIRED_SCOPES],
      tokens: { access_token: ACCESS, refresh_token: REFRESH, expiry_date: expiry, token_type: 'Bearer', scope: SCOPE },
      obtained_via: 'desktop_loopback_pkce',
      created_at: '2026-09-20T00:00:00.000Z',
      updated_at: '2026-09-20T00:00:00.000Z',
      refresh_token_expires_at: null,
    });
  }

  it('sends the bearer token only to Google API hosts', async () => {
    const fetch = fakeFetch([match('GET', 'https://searchconsole.googleapis.com/webmasters/v3/sites', (req) => jsonResponse({ siteEntry: [], auth: req.headers.authorization }))]);
    ctx = googleTestContext({ fetch });
    seed(ctx, Date.now() + 3_600_000);
    const provider = new OAuthGoogleAuthProvider({ clientFile: credentialPathsFor(ctx).clientFile, tokenStore: tokenStoreFor(ctx), fetch });
    const client = await provider.getClient();
    const res = await client.request<{ auth: string }>({ url: 'https://searchconsole.googleapis.com/webmasters/v3/sites', method: 'GET' });
    expect(res.data.auth).toBe(`Bearer ${ACCESS}`);
    await expect(client.request({ url: 'https://evil.example.com/collect', method: 'GET' })).rejects.toThrow(/non-Google host/);
  });

  it('refreshes an expired token and persists it via the tokens event, keeping the refresh token', async () => {
    const NEW = 'ya29.synthetic-refreshed-access-token-5555555';
    let refreshBody = '';
    const fetch = fakeFetch([
      match('POST', 'https://oauth2.googleapis.com/token', (req) => {
        refreshBody = req.body ?? '';
        return jsonResponse({ access_token: NEW, expires_in: 3599, scope: SCOPE, token_type: 'Bearer' });
      }),
      match('GET', 'https://searchconsole.googleapis.com/webmasters/v3/sites', (req) => jsonResponse({ auth: req.headers.authorization })),
    ]);
    ctx = googleTestContext({ fetch });
    seed(ctx, Date.now() - 1_000);
    const store = tokenStoreFor(ctx);
    const provider = new OAuthGoogleAuthProvider({ clientFile: credentialPathsFor(ctx).clientFile, tokenStore: store, fetch });
    const res = await (await provider.getClient()).request<{ auth: string }>({ url: 'https://searchconsole.googleapis.com/webmasters/v3/sites', method: 'GET' });
    expect(res.data.auth).toBe(`Bearer ${NEW}`);
    expect(new URLSearchParams(refreshBody).get('grant_type')).toBe('refresh_token');
    const stored = store.read()!;
    expect(stored.tokens.access_token).toBe(NEW);
    expect(stored.tokens.refresh_token).toBe(REFRESH);
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
  });

  it('maps invalid_grant to an actionable re-authorization error mentioning the Testing 7-day expiry', async () => {
    const fetch = fakeFetch([match('POST', 'https://oauth2.googleapis.com/token', () => jsonResponse({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400))]);
    ctx = googleTestContext({ fetch });
    seed(ctx, Date.now() - 1_000);
    const provider = new OAuthGoogleAuthProvider({ clientFile: credentialPathsFor(ctx).clientFile, tokenStore: tokenStoreFor(ctx), fetch });
    const err = await (await provider.getClient()).request({ url: 'https://searchconsole.googleapis.com/webmasters/v3/sites', method: 'GET' }).catch((e) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.kind).toBe('invalid_grant');
    expect(err.code).toBe('CREDENTIALS_MISSING');
    expect(err.hint).toMatch(/7 days after consent/);
  });

  it('retries once after a 401 by refreshing', async () => {
    let apiCalls = 0;
    const fetch = fakeFetch([
      match('POST', 'https://oauth2.googleapis.com/token', () => jsonResponse({ access_token: 'ya29.synthetic-after-401-token-77777777', expires_in: 3599, token_type: 'Bearer' })),
      match('GET', 'https://searchconsole.googleapis.com/webmasters/v3/sites', () => {
        apiCalls++;
        return apiCalls === 1 ? jsonResponse({ error: { code: 401, message: 'Request had invalid authentication credentials.' } }, 401) : jsonResponse({ siteEntry: [] });
      }),
    ]);
    ctx = googleTestContext({ fetch });
    seed(ctx, Date.now() + 3_600_000);
    const provider = new OAuthGoogleAuthProvider({ clientFile: credentialPathsFor(ctx).clientFile, tokenStore: tokenStoreFor(ctx), fetch });
    const res = await (await provider.getClient()).request({ url: 'https://searchconsole.googleapis.com/webmasters/v3/sites', method: 'GET' });
    expect(res.status).toBe(200);
    expect(apiCalls).toBe(2);
  });

  it('fails honestly without a token', async () => {
    ctx = googleTestContext();
    installClient(ctx);
    const provider = new OAuthGoogleAuthProvider({ clientFile: credentialPathsFor(ctx).clientFile, tokenStore: tokenStoreFor(ctx), fetch: fakeFetch([]) });
    await expect(provider.getClient()).rejects.toMatchObject({ code: 'CREDENTIALS_MISSING', hint: expect.stringMatching(/auth google/) });
  });
});
