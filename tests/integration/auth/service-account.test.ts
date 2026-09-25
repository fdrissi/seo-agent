import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGoogleAuthProvider, inspectServiceAccountFile, ServiceAccountGoogleAuthProvider } from '../../../src/auth/providers.js';
import { authStatus } from '../../../src/auth/status.js';
import { diagnoseGoogle } from '../../../src/auth/diagnose.js';
import { fakeFetch, jsonResponse, match } from '../../helpers/fake-fetch.js';
import { googleTestContext, SYNTHETIC_PROPERTY } from '../google/_helpers.js';
import type { TestContext } from '../../helpers/context.js';
import { redactString } from '../../../src/security/redact.js';

const SA_EMAIL = 'seo-agent-reader@synthetic-project.iam.gserviceaccount.com';
let ctx: TestContext;
afterEach(() => ctx?.cleanup());

/** Throwaway key generated per test run (never committed). */
function writeKey(c: TestContext, mode = 0o600, overrides: Record<string, unknown> = {}): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const file = path.join(c.paths.googleDir, 'service-account.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ type: 'service_account', project_id: 'synthetic-project', private_key_id: 'synthetic', private_key: privateKey, client_email: SA_EMAIL, client_id: '1', token_uri: 'https://oauth2.googleapis.com/token', ...overrides }), { mode });
  return file;
}

describe('service-account mode', () => {
  it('reports configured_unverified status with the identity to grant, without network', async () => {
    ctx = googleTestContext({ secrets: { GOOGLE_AUTH_MODE: 'service_account' } });
    ctx.secrets.set('GOOGLE_APPLICATION_CREDENTIALS', writeKey(ctx));
    const r = await authStatus(ctx, { network: false });
    expect(r.mode).toBe('service_account');
    expect(r.serviceAccount).toMatchObject({ type: 'service_account', clientEmail: SA_EMAIL, ok: true, permissionsOk: true });
    const auth = r.statuses.find((s) => s.id === 'google_auth')!;
    expect(auth.state).toBe('configured_unverified');
    expect(auth.networkChecked).toBe(false);
    expect(auth.chargeable).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/BEGIN PRIVATE KEY/);
  });

  it('signs a JWT, gets a token through the injected fetch, and calls Search Console', async () => {
    let assertion = '';
    const fetch = fakeFetch([
      match('POST', 'https://oauth2.googleapis.com/token', (req) => {
        assertion = new URLSearchParams(req.body ?? '').get('assertion') ?? '';
        return jsonResponse({ access_token: 'ya29.synthetic-service-account-token-111111', expires_in: 3600, token_type: 'Bearer' });
      }),
      match('GET', 'https://searchconsole.googleapis.com/webmasters/v3/sites', (req) => jsonResponse({ siteEntry: [{ siteUrl: SYNTHETIC_PROPERTY, permissionLevel: 'siteRestrictedUser' }], seenAuth: req.headers.authorization })),
      match('GET', /analyticsdata\.googleapis\.com\/v1beta\/properties\/123456789\/metadata/, () => jsonResponse({ name: 'properties/123456789/metadata', dimensions: [], metrics: [{ apiName: 'sessions' }, { apiName: 'sessionKeyEventRate:generate_lead' }] })),
    ]);
    ctx = googleTestContext({ fetch, secrets: { GOOGLE_AUTH_MODE: 'service_account' } });
    ctx.secrets.set('GOOGLE_APPLICATION_CREDENTIALS', writeKey(ctx));
    const provider = createGoogleAuthProvider(ctx);
    expect(provider.mode).toBe('service_account');
    const r = await authStatus(ctx, { network: true, provider });
    expect(assertion.split('.')).toHaveLength(3); // signed JWT bearer assertion
    const claims = JSON.parse(Buffer.from(assertion.split('.')[1]!, 'base64url').toString('utf8'));
    expect(claims.iss).toBe(SA_EMAIL);
    expect(claims.scope.split(' ').sort()).toEqual(['https://www.googleapis.com/auth/analytics.readonly', 'https://www.googleapis.com/auth/webmasters.readonly']);
    expect(r.gsc.configuredAccessible).toBe(true);
    expect(r.ga4.access).toBe('ok');
    expect(r.statuses.find((s) => s.id === 'google_auth')!.state).toBe('ready');
    expect(r.statuses.find((s) => s.id === 'google_gsc')!.state).toBe('ready');
    expect(r.statuses.find((s) => s.id === 'google_ga4')!.state).toBe('ready');
    // The private key is registered for redaction.
    const key = JSON.parse(readFileSync(ctx.secrets.get('GOOGLE_APPLICATION_CREDENTIALS')!, 'utf8')).private_key as string;
    expect(redactString(key)).not.toContain('PRIVATE KEY-----\nMII');
  });

  it('diagnoses a missing key, a user credential, and loose permissions', async () => {
    ctx = googleTestContext({ secrets: { GOOGLE_AUTH_MODE: 'service_account', GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/synthetic-key.json' } });
    let d = await diagnoseGoogle(ctx, { network: false });
    expect(d.findings.map((f) => f.code)).toContain('SA_KEY_MISSING');
    expect(d.status.statuses.find((s) => s.id === 'google_auth')!.state).toBe('missing_credentials');
    const loose = writeKey(ctx, 0o644);
    ctx.secrets.set('GOOGLE_APPLICATION_CREDENTIALS', loose);
    d = await diagnoseGoogle(ctx, { network: false });
    expect(d.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['SA_KEY_OK', 'SA_KEY_PERMISSIONS', 'SA_GRANT_ACCESS']));
    expect(inspectServiceAccountFile(writeKey(ctx, 0o600, { type: 'authorized_user' }))).toMatchObject({ ok: false, problem: expect.stringMatching(/oauth/i) });
  });

  it('explains a rejected service-account token (invalid_grant) without OAuth refresh-token or Testing-mode guidance', async () => {
    const fetch = fakeFetch([
      match('POST', 'https://oauth2.googleapis.com/token', () => jsonResponse({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, 400)),
      match('GET', /searchconsole\.googleapis\.com/, () => jsonResponse({ siteEntry: [] })),
      match('GET', /analyticsdata\.googleapis\.com/, () => jsonResponse({ name: 'properties/123456789/metadata', dimensions: [], metrics: [] })),
    ]);
    ctx = googleTestContext({ fetch, secrets: { GOOGLE_AUTH_MODE: 'service_account' } });
    ctx.secrets.set('GOOGLE_APPLICATION_CREDENTIALS', writeKey(ctx));
    const d = await diagnoseGoogle(ctx, { network: true, provider: createGoogleAuthProvider(ctx) });
    const codes = d.findings.map((f) => f.code);
    expect(codes).toContain('SA_TOKEN_REJECTED');
    expect(codes).not.toContain('REFRESH_INVALID_GRANT');
    const f = d.findings.find((x) => x.code === 'SA_TOKEN_REJECTED')!;
    expect(f.severity).toBe('error');
    expect(f.message).toMatch(/key was disabled or deleted/);
    expect(f.message).toMatch(/service account was disabled or deleted/);
    expect(f.message).toMatch(/clock/);
    expect(f.message).toMatch(/workload identity/);
    expect(f.nextStep).toMatch(/IAM & Admin > Service accounts > .* > Keys/);
    // The status hint (auth status / doctor) gets the same service-account guidance.
    const auth = d.status.statuses.find((s) => s.id === 'google_auth')!;
    expect(auth.state).toBe('missing_credentials');
    expect(auth.nextStep).toMatch(/Service accounts > .* > Keys/);
    expect(d.status.statuses.find((s) => s.id === 'google_gsc')!.detail).toMatch(/^Blocked until Google access works: /);
    // Nothing tells a service-account user to re-consent or mentions refresh tokens / Testing status.
    const text = JSON.stringify({ findings: d.findings, statuses: d.status.statuses.map((s) => ({ detail: s.detail, nextStep: s.nextStep })), authCheck: d.status.authCheck });
    expect(text).not.toMatch(/refresh token/i);
    expect(text).not.toMatch(/Testing/);
    expect(text).not.toMatch(/auth google/);
  });

  it('keeps the OAuth invalid_grant guidance for OAuth-mode errors (mode-specific hints)', async () => {
    const { GoogleApiError, googleErrorFromResponse, withAuthModeHint, hintForKind } = await import('../../../src/integrations/google/errors.js');
    const oauth = googleErrorFromResponse('gsc', 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    expect(oauth.hint).toMatch(/Testing.*7 days/);
    const sa = withAuthModeHint(oauth, 'service_account');
    expect(sa).toBeInstanceOf(GoogleApiError);
    expect(sa.kind).toBe('invalid_grant');
    expect(sa.code).toBe(oauth.code);
    expect(sa.message).toBe(oauth.message);
    expect(sa.hint).not.toMatch(/Testing|refresh token|auth google/);
    expect(sa.hint).toMatch(/Keys/);
    expect(withAuthModeHint(oauth, 'oauth')).toBe(oauth);
    expect(hintForKind('permission_denied', 'ga4', null, 'service_account')).toBe(hintForKind('permission_denied', 'ga4'));
  });

  it('parses workload identity federation configs for the identity to grant', () => {
    ctx = googleTestContext();
    const file = path.join(ctx.paths.googleDir, 'wif.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ type: 'external_account', audience: '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q', subject_token_type: 'urn:ietf:params:oauth:token-type:jwt', token_url: 'https://sts.googleapis.com/v1/token', service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA_EMAIL}:generateAccessToken`, credential_source: { file: '/var/run/token' } }), { mode: 0o600 });
    expect(inspectServiceAccountFile(file)).toMatchObject({ ok: true, type: 'external_account', clientEmail: SA_EMAIL });
    expect(inspectServiceAccountFile(null)).toMatchObject({ source: 'adc', ok: true });
    expect(new ServiceAccountGoogleAuthProvider({ keyFile: null, fetch: fakeFetch([]) }).describe().source).toBe('adc');
  });
});
