import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGoogleAuthProvider, inspectAdc, ServiceAccountGoogleAuthProvider } from '../../../src/auth/providers.js';
import { authStatus } from '../../../src/auth/status.js';
import { diagnoseGoogle } from '../../../src/auth/diagnose.js';
import { CredentialsMissingError } from '../../../src/core/errors.js';
import { AuthorizedGoogleApiClient } from '../../../src/integrations/google/http-client.js';
import { syncGsc } from '../../../src/integrations/google/gsc-sync.js';
import { fakeFetch, jsonResponse, match } from '../../helpers/fake-fetch.js';
import { FAST_RETRY, count, googleTestContext, providerFor, SYNTHETIC_PROPERTY } from '../google/_helpers.js';
import type { TestContext } from '../../helpers/context.js';

/**
 * Application Default Credentials in GOOGLE_AUTH_MODE=service_account.
 * google-auth-library reads process.env directly, so each test points
 * CLOUDSDK_CONFIG at a throwaway directory (never the developer's real gcloud
 * config), disables metadata-server detection, and sets a synthetic project ID
 * so no gcloud CLI or metadata request is attempted.
 */

const SA_EMAIL = 'seo-agent-reader@synthetic-project.iam.gserviceaccount.com';
const ENV_KEYS = ['CLOUDSDK_CONFIG', 'METADATA_SERVER_DETECTION', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS'] as const;
let saved: Record<string, string | undefined> = {};
let gcloudDir: string;
let ctx: TestContext | undefined;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  gcloudDir = mkdtempSync(path.join(os.tmpdir(), 'adc-gcloud-'));
  process.env.CLOUDSDK_CONFIG = gcloudDir;
  process.env.METADATA_SERVER_DETECTION = 'none';
  process.env.GOOGLE_CLOUD_PROJECT = 'synthetic-project';
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
});

afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(gcloudDir, { recursive: true, force: true });
});

function writeAdcFile(content: Record<string, unknown>): string {
  const file = path.join(gcloudDir, 'application_default_credentials.json');
  writeFileSync(file, JSON.stringify(content), { mode: 0o600 });
  return file;
}

/** Synthetic user credential of the shape `gcloud auth application-default login` writes. */
const AUTHORIZED_USER = {
  type: 'authorized_user',
  client_id: 'synthetic-adc-client.apps.googleusercontent.com',
  client_secret: 'synthetic-adc-client-secret',
  refresh_token: '1//synthetic-user-refresh-token-000000000000',
  quota_project_id: 'synthetic-project',
};

describe('service-account mode with Application Default Credentials', () => {
  it('reports missing credentials honestly (not "unreachable") and never retries them', async () => {
    const fetch = fakeFetch([]);
    ctx = googleTestContext({ fetch, secrets: { GOOGLE_AUTH_MODE: 'service_account' } });
    const provider = createGoogleAuthProvider(ctx);
    const r = await authStatus(ctx, { network: true, provider });
    expect(r.serviceAccount).toMatchObject({ source: 'adc', adcOrigin: 'metadata_server', ok: true });
    const byId = Object.fromEntries(r.statuses.map((s) => [s.id, s]));
    expect(byId.google_auth).toMatchObject({ state: 'missing_credentials', networkChecked: true });
    expect(byId.google_auth!.nextStep).toMatch(/GOOGLE_APPLICATION_CREDENTIALS/);
    expect(byId.google_gsc!.state).toBe('missing_credentials');
    expect(byId.google_ga4!.state).toBe('missing_credentials');
    expect(fetch.calls).toHaveLength(0);

    await expect(syncGsc(ctx, { provider, days: 2, retry: FAST_RETRY })).rejects.toMatchObject({ code: 'CREDENTIALS_MISSING' });
    expect(count(ctx, 'SELECT COUNT(*) AS n FROM provider_requests WHERE site_id = ?', [ctx.siteId])).toBe(0);
    expect(fetch.calls).toHaveLength(0);
  });

  it('keeps a credential error raised while signing a request: no retries, missing_credentials status', async () => {
    const fetch = fakeFetch([]);
    ctx = googleTestContext({ fetch, secrets: { GOOGLE_AUTH_MODE: 'service_account' } });
    let headerCalls = 0;
    const client = new AuthorizedGoogleApiClient(
      {
        getRequestHeaders: async () => {
          headerCalls++;
          throw new CredentialsMissingError('google_auth', ['GOOGLE_APPLICATION_CREDENTIALS'], 'Set GOOGLE_APPLICATION_CREDENTIALS (synthetic hint).');
        },
      },
      fetch,
    );
    const err = await syncGsc(ctx, { provider: providerFor(client, 'service_account'), days: 2, retry: FAST_RETRY }).catch((e) => e);
    expect(err).toMatchObject({ code: 'CREDENTIALS_MISSING', kind: 'credentials', retryable: false, hint: 'Set GOOGLE_APPLICATION_CREDENTIALS (synthetic hint).' });
    expect(headerCalls).toBe(1);
    const logged = ctx.db.all<{ status: string; error_json: string }>('SELECT status, error_json FROM provider_requests WHERE site_id = ?', [ctx.siteId]);
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!.error_json)).toMatchObject({ kind: 'credentials', attempts: 1 });

    const r = await authStatus(ctx, { network: true, provider: providerFor(client, 'service_account') });
    const byId = Object.fromEntries(r.statuses.map((s) => [s.id, s]));
    expect(byId.google_auth!.state).toBe('missing_credentials');
    expect(byId.google_auth!.nextStep).toBe('Set GOOGLE_APPLICATION_CREDENTIALS (synthetic hint).');
    expect(byId.google_gsc!.state).toBe('missing_credentials');
    expect(fetch.calls).toHaveLength(0);
  });

  it('refuses a gcloud authorized_user credential before any token request', async () => {
    const file = writeAdcFile(AUTHORIZED_USER);
    const fetch = fakeFetch([]); // any token request would fail loudly
    const provider = new ServiceAccountGoogleAuthProvider({ keyFile: null, fetch });
    const err = await provider.getClient().catch((e) => e);
    expect(err).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(err.message).toMatch(/USER credential \(authorized_user\)/);
    expect(err.hint).toMatch(/GOOGLE_AUTH_MODE=oauth/);
    expect(fetch.calls).toHaveLength(0);
    expect(provider.resolvedIdentity).toBeNull();

    // Status and diagnose detect it offline, without making a request.
    expect(inspectAdc()).toMatchObject({ source: 'adc', adcOrigin: 'gcloud_file', keyFile: file, type: 'authorized_user', ok: false });
    ctx = googleTestContext({ fetch, secrets: { GOOGLE_AUTH_MODE: 'service_account' } });
    const s = await authStatus(ctx, { network: true });
    expect(s.network.checked).toBe(false);
    const auth = s.statuses.find((x) => x.id === 'google_auth')!;
    expect(auth.state).toBe('misconfigured');
    expect(auth.detail).toMatch(/USER credential/);
    expect(auth.nextStep).toMatch(/GOOGLE_AUTH_MODE=oauth/);
    const d = await diagnoseGoogle(ctx, { network: false });
    expect(d.findings.map((f) => f.code)).toContain('SA_ADC_REFUSED');
    expect(JSON.stringify(s)).not.toContain(AUTHORIZED_USER.refresh_token);
    expect(JSON.stringify(s)).not.toContain(AUTHORIZED_USER.client_secret);
    expect(fetch.calls).toHaveLength(0);
  });

  it('accepts a service-account ADC file and reports the resolved identity', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    writeAdcFile({ type: 'service_account', project_id: 'synthetic-project', private_key_id: 'synthetic', private_key: privateKey, client_email: SA_EMAIL, client_id: '1', token_uri: 'https://oauth2.googleapis.com/token' });
    let grantType = '';
    const fetch = fakeFetch([
      match('POST', 'https://oauth2.googleapis.com/token', (req) => {
        grantType = new URLSearchParams(req.body ?? '').get('grant_type') ?? '';
        return jsonResponse({ access_token: 'ya29.synthetic-adc-service-account-token-222222', expires_in: 3600, token_type: 'Bearer' });
      }),
      match('GET', 'https://searchconsole.googleapis.com/webmasters/v3/sites', () => jsonResponse({ siteEntry: [{ siteUrl: SYNTHETIC_PROPERTY, permissionLevel: 'siteRestrictedUser' }] })),
      match('GET', /analyticsdata\.googleapis\.com\/v1beta\/properties\/123456789\/metadata/, () => jsonResponse({ name: 'properties/123456789/metadata', dimensions: [], metrics: [{ apiName: 'sessions' }, { apiName: 'sessionKeyEventRate:generate_lead' }] })),
    ]);
    ctx = googleTestContext({ fetch, secrets: { GOOGLE_AUTH_MODE: 'service_account' } });
    const r = await authStatus(ctx, { network: true });
    expect(grantType).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer'); // a service-account JWT, not a user refresh token
    expect(r.serviceAccount).toMatchObject({ source: 'adc', adcOrigin: 'gcloud_file', type: 'service_account', resolvedType: 'service_account', clientEmail: SA_EMAIL });
    const auth = r.statuses.find((x) => x.id === 'google_auth')!;
    expect(auth.state).toBe('ready');
    expect(auth.detail).toMatch(new RegExp(`resolved to service_account for ${SA_EMAIL.replace(/\./g, '\\.')}`));
    expect(JSON.stringify(r)).not.toMatch(/BEGIN PRIVATE KEY/);
  });
});
