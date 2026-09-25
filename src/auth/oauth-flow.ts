import { randomBytes } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { AppError } from '../core/errors.js';
import { systemClock, type Clock } from '../core/clock.js';
import type { FetchLike } from '../integrations/types.js';
import { GOOGLE_SCOPES } from '../integrations/google/types.js';
import { googleErrorFromUnknown } from '../integrations/google/errors.js';
import { loadOAuthClientFile, type OAuthClientInfo } from './client-file.js';
import { startLoopbackServer } from './loopback.js';
import { TOKEN_FORMAT, type StoredGoogleToken, type TokenStore } from './token-store.js';

/**
 * Guided local OAuth desktop flow (installed-app guidance):
 *   loopback redirect on 127.0.0.1:<ephemeral port>, cryptographic `state`,
 *   PKCE S256 (generateCodeVerifierAsync), access_type=offline, prompt=consent,
 *   and ONLY the two read-only scopes. The owner opens the printed URL in a
 *   browser; the authorization code arrives at the local listener. Nobody is
 *   ever asked to paste a code or token anywhere.
 */

export const REQUIRED_SCOPES: readonly string[] = [GOOGLE_SCOPES.searchConsole, GOOGLE_SCOPES.analytics];
export const DEFAULT_FLOW_TIMEOUT_MS = 5 * 60_000;

export function createOAuth2Client(info: OAuthClientInfo, fetchImpl: FetchLike, redirectUri?: string): OAuth2Client {
  return new OAuth2Client({
    clientId: info.clientId,
    ...(info.clientSecret ? { clientSecret: info.clientSecret } : {}),
    ...(redirectUri ? { redirectUri } : {}),
    // Route every google-auth-library HTTP call through the injected fetch
    // (offline/demo mode and tests control network access).
    transporterOptions: { fetchImplementation: fetchImpl as unknown as typeof fetch },
  });
}

export function newOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

/** Build the consent URL. The client must have been constructed with the loopback redirectUri. */
export async function buildAuthorizationUrl(client: OAuth2Client, state: string): Promise<{ url: string; codeVerifier: string; codeChallenge: string }> {
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  if (!codeChallenge) throw new AppError('INTERNAL', 'PKCE code challenge could not be generated');
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [...REQUIRED_SCOPES],
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
  });
  return { url, codeVerifier, codeChallenge };
}

export interface DesktopFlowOptions {
  clientFile: string;
  tokenStore: TokenStore;
  fetch: FetchLike;
  /** Show the consent URL to the owner (print it). Called once the listener is ready. */
  onAuthUrl: (url: string, info: { redirectUri: string; timeoutMs: number }) => void | Promise<void>;
  timeoutMs?: number;
  clock?: Clock;
}

export interface DesktopFlowResult {
  tokenFile: string;
  redirectHost: '127.0.0.1';
  hasRefreshToken: boolean;
  grantedScopes: string[];
  missingScopes: string[];
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  warnings: string[];
}

export async function runDesktopOAuthFlow(opts: DesktopFlowOptions): Promise<DesktopFlowResult> {
  const clock = opts.clock ?? systemClock;
  const info = loadOAuthClientFile(opts.clientFile);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS;
  const state = newOAuthState();
  const server = await startLoopbackServer({ expectedState: state, timeoutMs });
  try {
    const client = createOAuth2Client(info, opts.fetch, server.redirectUri);
    const { url, codeVerifier } = await buildAuthorizationUrl(client, state);
    await opts.onAuthUrl(url, { redirectUri: server.redirectUri, timeoutMs });
    const cb = await server.waitForCallback();
    let tokens;
    let raw: Record<string, unknown> = {};
    try {
      const r = await client.getToken({ code: cb.code, codeVerifier, redirect_uri: server.redirectUri });
      tokens = r.tokens;
      raw = (r.res?.data ?? {}) as Record<string, unknown>;
    } catch (err) {
      throw googleErrorFromUnknown('oauth', err);
    }
    if (!tokens.access_token) throw new AppError('PROVIDER_ERROR', 'Google did not return an access token.', { hint: 'Run `npm run cli -- auth google` again.' });
    const granted = (tokens.scope ?? cb.scope ?? '').split(/\s+/).filter(Boolean);
    const missingScopes = REQUIRED_SCOPES.filter((s) => !granted.includes(s));
    const now = clock.now();
    const refreshExpiresIn = typeof raw.refresh_token_expires_in === 'number' ? raw.refresh_token_expires_in : null;
    const record: StoredGoogleToken = {
      format: TOKEN_FORMAT,
      client_id: info.clientId,
      requested_scopes: [...REQUIRED_SCOPES],
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? null,
        expiry_date: tokens.expiry_date ?? null,
        token_type: tokens.token_type ?? 'Bearer',
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      },
      obtained_via: 'desktop_loopback_pkce',
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      refresh_token_expires_at: refreshExpiresIn !== null ? new Date(now.getTime() + refreshExpiresIn * 1000).toISOString() : null,
    };
    opts.tokenStore.write(record);
    const warnings: string[] = [];
    if (!tokens.refresh_token) warnings.push('Google returned no refresh token; access ends when the access token expires. Remove the app under https://myaccount.google.com/permissions and run `auth google` again.');
    if (missingScopes.length) warnings.push(`Not granted: ${missingScopes.join(', ')}. Re-run \`auth google\` and keep both read-only permissions checked; affected syncs will fail with a permission error.`);
    if (record.refresh_token_expires_at) warnings.push(`Google granted time-based access that ends at ${record.refresh_token_expires_at}.`);
    warnings.push('If the OAuth app is External with publishing status "Testing", this authorization expires 7 days after consent.');
    return {
      tokenFile: opts.tokenStore.file,
      redirectHost: '127.0.0.1',
      hasRefreshToken: !!tokens.refresh_token,
      grantedScopes: granted.sort(),
      missingScopes,
      accessTokenExpiresAt: typeof tokens.expiry_date === 'number' ? new Date(tokens.expiry_date).toISOString() : null,
      refreshTokenExpiresAt: record.refresh_token_expires_at,
      warnings,
    };
  } finally {
    await server.close();
  }
}
