import { describe, expect, it } from 'vitest';
import { classifyGoogleError, googleErrorFromResponse, googleErrorFromUnknown, parseGoogleErrorBody } from '../../../src/integrations/google/errors.js';
import { AuthorizedGoogleApiClient } from '../../../src/integrations/google/http-client.js';
import { AppError, CredentialsMissingError } from '../../../src/core/errors.js';
import { fakeFetch, jsonResponse, match } from '../../helpers/fake-fetch.js';

describe('Google error parsing', () => {
  it('parses the legacy Search Console shape and the google.rpc shape', () => {
    const legacy = parseGoogleErrorBody(403, { error: { code: 403, message: 'Access Not Configured', errors: [{ domain: 'usageLimits', reason: 'accessNotConfigured', message: 'x' }] } });
    expect(legacy.reasons).toEqual(['accessNotConfigured']);
    expect(classifyGoogleError(legacy)).toBe('api_not_enabled');
    const rpc = parseGoogleErrorBody(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'API disabled', details: [{ reason: 'SERVICE_DISABLED', metadata: { activationUrl: 'https://console.developers.google.com/apis/api/analyticsdata.googleapis.com/overview?project=1' } }] } });
    expect(classifyGoogleError(rpc)).toBe('api_not_enabled');
    expect(rpc.activationUrl).toMatch(/console\.developers\.google\.com/);
  });

  it('classifies permission, scope, quota, auth, and server errors', () => {
    const k = (status: number, body: unknown) => classifyGoogleError(parseGoogleErrorBody(status, body));
    expect(k(403, { error: { code: 403, message: "User does not have sufficient permission for site 'x'.", errors: [{ reason: 'forbidden' }] } })).toBe('permission_denied');
    expect(k(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Request had insufficient authentication scopes.', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } })).toBe('insufficient_scopes');
    expect(k(403, { error: { code: 403, message: 'Quota exceeded', errors: [{ reason: 'quotaExceeded' }] } })).toBe('quota_exhausted');
    expect(k(403, { error: { code: 403, message: 'Search Analytics load quota exceeded.' } })).toBe('quota_exhausted');
    expect(k(403, { error: { code: 403, message: 'Daily Limit Exceeded', errors: [{ reason: 'dailyLimitExceeded' }] } })).toBe('quota_exhausted');
    expect(k(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Exhausted property tokens per hour' } })).toBe('quota_exhausted');
    // Short-term limits keep the short backoff.
    expect(k(403, { error: { code: 403, message: 'User Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } })).toBe('rate_limited');
    expect(k(429, { error: { code: 429, message: 'Rate limit', errors: [{ reason: 'rateLimitExceeded' }] } })).toBe('rate_limited');
    expect(k(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user'", errors: [{ reason: 'rateLimitExceeded' }] } })).toBe('rate_limited');
    expect(classifyGoogleError(parseGoogleErrorBody(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Exhausted concurrent requests quota.' } }), 'ga4')).toBe('rate_limited');
    // GA4: any other RESOURCE_EXHAUSTED waits for the hourly/daily reset (contract section 3).
    expect(classifyGoogleError(parseGoogleErrorBody(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted.' } }), 'ga4')).toBe('quota_exhausted');
    expect(classifyGoogleError(parseGoogleErrorBody(429, { error: { code: 429, message: 'Too many requests' } }), 'gsc')).toBe('rate_limited');
    expect(k(401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'x' } })).toBe('unauthenticated');
    expect(k(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })).toBe('invalid_grant');
    expect(k(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Field foo is not a valid metric.' } })).toBe('invalid_argument');
    expect(k(503, { error: { code: 503, message: 'backendError' } })).toBe('server_error');
    expect(k(404, 'Not found')).toBe('not_found');
  });

  it('marks only short-term rate limits, server errors, and network failures as retryable', () => {
    expect(googleErrorFromResponse('gsc', 429, {}, { 'retry-after': '7' })).toMatchObject({ retryable: true, retryAfterMs: 7000 });
    expect(googleErrorFromResponse('gsc', 403, { error: { code: 403, message: 'Search Analytics load quota exceeded.' } })).toMatchObject({ kind: 'quota_exhausted', retryable: false, code: 'RATE_LIMITED' });
    expect(googleErrorFromResponse('ga4', 429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Exhausted property tokens per day.' } })).toMatchObject({ kind: 'quota_exhausted', retryable: false });
    expect(googleErrorFromResponse('ga4', 500, {}).retryable).toBe(true);
    expect(googleErrorFromResponse('ga4', 403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'no' } }).retryable).toBe(false);
    expect(googleErrorFromResponse('gsc', 400, { error: { code: 400, message: 'bad' } }).retryable).toBe(false);
    // B1-01: an offline refusal (nothing was sent) has its own code, so it never counts as a provider-health failure.
    expect(googleErrorFromUnknown('gsc', Object.assign(new Error('Network access is disabled'), { code: 'OFFLINE' }))).toMatchObject({ kind: 'offline', retryable: false, code: 'OFFLINE' });
    expect(googleErrorFromUnknown('gsc', new Error('ECONNRESET')).retryable).toBe(true);
  });

  it('classifies only real transport failures as network; credential and key problems keep their meaning', () => {
    const fetchFailed = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }) });
    expect(googleErrorFromUnknown('gsc', fetchFailed)).toMatchObject({ kind: 'network', retryable: true });
    expect(googleErrorFromUnknown('gsc', new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toMatchObject({ kind: 'network', retryable: true });
    const gaxiosLike = Object.assign(new Error('request to https://oauth2.googleapis.com/token failed'), { name: 'GaxiosError', code: 'ENOTFOUND' });
    expect(googleErrorFromUnknown('auth', gaxiosLike)).toMatchObject({ kind: 'network', retryable: true });

    const missing = new CredentialsMissingError('google_auth', ['GOOGLE_APPLICATION_CREDENTIALS'], 'Set GOOGLE_APPLICATION_CREDENTIALS to a key file (synthetic hint).');
    const g = googleErrorFromUnknown('gsc', missing);
    expect(g).toMatchObject({ kind: 'credentials', retryable: false, code: 'CREDENTIALS_MISSING', hint: 'Set GOOGLE_APPLICATION_CREDENTIALS to a key file (synthetic hint).' });
    expect(g.message).toMatch(/^Google authorization: google_auth: missing credentials/);
    expect(googleErrorFromUnknown('gsc', new AppError('CONFIG_INVALID', 'wrong credential type', { hint: 'use oauth' }))).toMatchObject({ kind: 'config', retryable: false, code: 'CONFIG_INVALID', hint: 'use oauth' });

    const badKey = Object.assign(new Error('error:1E08010C:DECODER routines::unsupported'), { code: 'ERR_OSSL_UNSUPPORTED' });
    expect(googleErrorFromUnknown('gsc', badKey)).toMatchObject({ kind: 'config', retryable: false, code: 'CONFIG_INVALID' });
    expect(googleErrorFromUnknown('gsc', new Error('error:1E08010C:DECODER routines::unsupported')).kind).toBe('config');
    expect(googleErrorFromUnknown('gsc', new Error('Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started for more information.'))).toMatchObject({ kind: 'credentials', retryable: false });
    // Anything else without an HTTP response is unknown and NOT retried.
    expect(googleErrorFromUnknown('gsc', new Error('something unexpected'))).toMatchObject({ kind: 'unknown', retryable: false });
  });

  it('gives actionable hints', () => {
    expect(googleErrorFromResponse('ga4', 403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'no access' } }).hint).toMatch(/Viewer role/);
    expect(googleErrorFromResponse('gsc', 403, { error: { code: 403, message: 'no', errors: [{ reason: 'forbidden' }] } }).hint).toMatch(/Owner is not required/);
    expect(googleErrorFromResponse('ga4', 404, { error: { code: 404, message: 'no property' } }).hint).toMatch(/numeric GA4 property ID/);
  });
});

describe('AuthorizedGoogleApiClient', () => {
  const source = { getRequestHeaders: async () => new Headers({ authorization: 'Bearer ya29.synthetic-http-client-token-000000' }) };

  it('refuses non-Google or non-HTTPS hosts before attaching credentials', async () => {
    const fetch = fakeFetch([]);
    const c = new AuthorizedGoogleApiClient(source, fetch);
    await expect(c.request({ url: 'https://attacker.example.com/webmasters/v3/sites' })).rejects.toThrow(/non-Google host/);
    await expect(c.request({ url: 'http://searchconsole.googleapis.com/webmasters/v3/sites' })).rejects.toThrow(/non-Google host/);
    expect(fetch.calls).toHaveLength(0);
  });

  it('never retries or relabels a credential error thrown while getting auth headers', async () => {
    const fetch = fakeFetch([]);
    const missing = new CredentialsMissingError('google_auth', ['GOOGLE_APPLICATION_CREDENTIALS'], 'Service-account mode found no Application Default Credentials (synthetic).');
    const c = new AuthorizedGoogleApiClient({ getRequestHeaders: async () => { throw missing; } }, fetch);
    const err = await c.request({ url: 'https://searchconsole.googleapis.com/webmasters/v3/sites' }).catch((e) => e);
    expect(err).toMatchObject({ name: 'GoogleApiError', code: 'CREDENTIALS_MISSING', kind: 'credentials', retryable: false, hint: 'Service-account mode found no Application Default Credentials (synthetic).' });
    const bad = new AuthorizedGoogleApiClient({ getRequestHeaders: async () => { throw new Error('error:1E08010C:DECODER routines::unsupported'); } }, fetch);
    expect(await bad.request({ url: 'https://searchconsole.googleapis.com/webmasters/v3/sites' }).catch((e) => e)).toMatchObject({ kind: 'config', retryable: false, code: 'CONFIG_INVALID' });
    expect(fetch.calls).toHaveLength(0);
  });

  it('sends JSON bodies and maps errors', async () => {
    const fetch = fakeFetch([
      match('POST', /searchAnalytics\/query/, (req) => jsonResponse({ echo: JSON.parse(req.body ?? '{}'), ct: req.headers['content-type'] })),
      match('GET', /sites$/, () => jsonResponse({ error: { code: 403, message: 'nope', errors: [{ reason: 'forbidden' }] } }, 403)),
    ]);
    const c = new AuthorizedGoogleApiClient(source, fetch);
    const res = await c.request<{ echo: unknown; ct: string }>({ url: 'https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.test/searchAnalytics/query', method: 'POST', data: { a: 1 } });
    expect(res.data).toEqual({ echo: { a: 1 }, ct: 'application/json' });
    await expect(c.request({ url: 'https://searchconsole.googleapis.com/webmasters/v3/sites' })).rejects.toMatchObject({ kind: 'permission_denied', status: 403 });
  });
});
