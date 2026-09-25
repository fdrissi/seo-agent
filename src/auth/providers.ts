import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  BaseExternalAccountClient,
  Compute,
  ExternalAccountAuthorizedUserClient,
  ExternalAccountClient,
  GoogleAuth,
  Impersonated,
  JWT,
  UserRefreshClient,
  type AuthClient,
  type OAuth2Client,
} from 'google-auth-library';
import type { AppContext } from '../app/context.js';
import { AppError, CredentialsMissingError, errorMessage } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { appDirs } from '../config/paths.js';
import type { FetchLike } from '../integrations/types.js';
import { AuthorizedGoogleApiClient, type AuthHeaderSource } from '../integrations/google/http-client.js';
import { createFixtureGoogleAuthProvider } from '../integrations/google/fixture-provider.js';
import { GOOGLE_SCOPES, type GoogleApiClient, type GoogleAuthProvider } from '../integrations/google/types.js';
import { googleErrorFromUnknown } from '../integrations/google/errors.js';
import { redactString, registerSecret } from '../security/redact.js';
import { loadOAuthClientFile } from './client-file.js';
import { createOAuth2Client, REQUIRED_SCOPES } from './oauth-flow.js';
import { googleCredentialPaths, type GoogleCredentialPaths } from './paths.js';
import { TokenStore, type StoredGoogleToken } from './token-store.js';

/**
 * GoogleAuthProvider implementations:
 *  - oauth: Desktop OAuth client + stored refresh token (auth google)
 *  - service_account: service-account key (JWT), workload identity federation
 *    (external_account config), or Application Default Credentials
 *  - fixture: synthetic recorded responses (demo profile and tests only)
 */

export const DEFAULT_GOOGLE_TIMEOUT_MS = 60_000;

export class OAuthGoogleAuthProvider implements GoogleAuthProvider {
  readonly mode = 'oauth' as const;

  constructor(
    private readonly deps: { clientFile: string; tokenStore: TokenStore; fetch: FetchLike; logger?: Logger; timeoutMs?: number },
  ) {}

  get tokenStore(): TokenStore {
    return this.deps.tokenStore;
  }

  get clientFile(): string {
    return this.deps.clientFile;
  }

  /** Authorized OAuth2Client with refreshed tokens persisted via the 'tokens' event. */
  authorizedClient(): { oauth: OAuth2Client; stored: StoredGoogleToken } {
    const info = loadOAuthClientFile(this.deps.clientFile);
    const stored = this.deps.tokenStore.read();
    if (!stored) {
      throw new CredentialsMissingError('google_auth', ['Google OAuth token'], 'Run `npm run cli -- auth google` to authorize read-only access in your browser.');
    }
    if (stored.client_id !== info.clientId) {
      throw new AppError('CONFIG_INVALID', 'The stored Google token was issued to a different OAuth client than the configured client file.', {
        hint: 'Run `npm run cli -- auth google` again with the current client file (or restore the matching client file).',
      });
    }
    if (!stored.tokens.refresh_token && typeof stored.tokens.expiry_date === 'number' && stored.tokens.expiry_date <= Date.now()) {
      throw new CredentialsMissingError('google_auth', ['refresh token'], 'The stored access token expired and no refresh token is available. Run `npm run cli -- auth google`.');
    }
    const oauth = createOAuth2Client(info, this.deps.fetch);
    oauth.setCredentials(stored.tokens);
    oauth.on('tokens', (t) => {
      try {
        this.deps.tokenStore.merge(t);
      } catch (err) {
        this.deps.logger?.warn('Could not persist refreshed Google token', { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return { oauth, stored };
  }

  async getClient(): Promise<GoogleApiClient> {
    const { oauth } = this.authorizedClient();
    const source: AuthHeaderSource = {
      getRequestHeaders: (url) => oauth.getRequestHeaders(url),
      invalidate: () => {
        if (!oauth.credentials.refresh_token) return false;
        oauth.setCredentials({ ...oauth.credentials, access_token: null, expiry_date: null });
        return true;
      },
    };
    return new AuthorizedGoogleApiClient(source, this.deps.fetch, { timeoutMs: this.deps.timeoutMs ?? DEFAULT_GOOGLE_TIMEOUT_MS });
  }
}

export interface ServiceAccountInfo {
  source: 'key_file' | 'adc';
  keyFile: string | null;
  exists: boolean;
  type: string | null;
  /** Identity to grant access to in Search Console / GA4 (not a secret). */
  clientEmail: string | null;
  projectId: string | null;
  ok: boolean;
  problem: string | null;
  /**
   * ADC only: where Application Default Credentials would come from, as far as
   * can be told without a network call ('env_file' = GOOGLE_APPLICATION_CREDENTIALS
   * in the process environment, 'gcloud_file' = gcloud's
   * application_default_credentials.json, 'metadata_server' = no file, so an
   * attached service account on Google Cloud or nothing at all).
   */
  adcOrigin?: 'env_file' | 'gcloud_file' | 'metadata_server';
}

/** Credential types that are a USER identity and are refused in service-account mode. */
export const USER_CREDENTIAL_TYPES: ReadonlySet<string> = new Set(['authorized_user', 'external_account_authorized_user']);
/** ADC credential types accepted in service-account mode (a service-account identity is used). */
const ADC_SERVICE_TYPES: ReadonlySet<string> = new Set(['service_account', 'external_account', 'impersonated_service_account', 'gce_metadata', 'gdch_service_account']);

function adcUserCredentialProblem(type: string, where: string): string {
  return `GOOGLE_AUTH_MODE=service_account resolved Application Default Credentials to a USER credential (${type}) from ${where}, for example the file written by \`gcloud auth application-default login\`. It is refused so a personal Google identity (often with the broad cloud-platform scope) is never used silently.`;
}
const ADC_USER_HINT =
  'Use GOOGLE_AUTH_MODE=oauth for user authorization (`npm run cli -- auth google`, read-only scopes only), or set GOOGLE_APPLICATION_CREDENTIALS to a service-account key or workload identity config (mode 0600), or run on a host with an attached service account.';

/** gcloud's well-known ADC file location (same rules as google-auth-library). */
export function gcloudAdcFile(env: NodeJS.ProcessEnv = process.env): string | null {
  let dir = env.CLOUDSDK_CONFIG;
  if (!dir) {
    if (process.platform === 'win32') dir = env.APPDATA ? path.join(env.APPDATA, 'gcloud') : undefined;
    else dir = env.HOME ? path.join(env.HOME, '.config', 'gcloud') : undefined;
  }
  return dir ? path.join(dir, 'application_default_credentials.json') : null;
}

/**
 * Offline inspection of what Application Default Credentials would load,
 * following google-auth-library's order: GOOGLE_APPLICATION_CREDENTIALS in the
 * process environment, then gcloud's well-known file, then the metadata
 * server. Reads only the credential type and service-account email.
 */
export function inspectAdc(env: NodeJS.ProcessEnv = process.env): ServiceAccountInfo {
  const envFile = env.GOOGLE_APPLICATION_CREDENTIALS || env.google_application_credentials || null;
  const wellKnown = gcloudAdcFile(env);
  const file = envFile ?? (wellKnown && existsSync(wellKnown) ? wellKnown : null);
  if (!file) return { source: 'adc', keyFile: null, exists: false, type: null, clientEmail: null, projectId: null, ok: true, problem: null, adcOrigin: 'metadata_server' };
  const origin = envFile ? 'env_file' : 'gcloud_file';
  const info = inspectServiceAccountFile(file);
  const out: ServiceAccountInfo = { ...info, source: 'adc', adcOrigin: origin };
  if (info.type && USER_CREDENTIAL_TYPES.has(info.type)) return { ...out, ok: false, problem: adcUserCredentialProblem(info.type, file) };
  if (info.type === 'impersonated_service_account') {
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      // inspectServiceAccountFile already parsed it successfully.
    }
    const url = typeof json.service_account_impersonation_url === 'string' ? json.service_account_impersonation_url : '';
    const m = /serviceAccounts\/([^:/]+):generateAccessToken/.exec(url);
    return { ...out, ok: true, problem: null, clientEmail: m ? decodeURIComponent(m[1]!) : null };
  }
  return out;
}

export interface ResolvedAdcIdentity {
  /** Credential type actually loaded by google-auth-library ('gce_metadata' for the metadata server). */
  type: string;
  clientEmail: string | null;
}

export function inspectServiceAccountFile(file: string | null): ServiceAccountInfo {
  if (!file) return { source: 'adc', keyFile: null, exists: false, type: null, clientEmail: null, projectId: null, ok: true, problem: null };
  const base: ServiceAccountInfo = { source: 'key_file', keyFile: file, exists: existsSync(file), type: null, clientEmail: null, projectId: null, ok: false, problem: null };
  if (!base.exists) return { ...base, problem: `GOOGLE_APPLICATION_CREDENTIALS points to a missing file: ${file}` };
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return { ...base, problem: `${file} is not valid JSON.` };
  }
  const type = typeof json.type === 'string' ? json.type : null;
  base.type = type;
  base.projectId = typeof json.project_id === 'string' ? json.project_id : null;
  if (type === 'service_account') {
    base.clientEmail = typeof json.client_email === 'string' ? json.client_email : null;
    if (!base.clientEmail || typeof json.private_key !== 'string') return { ...base, problem: 'Service-account key is missing client_email or private_key.' };
    return { ...base, ok: true };
  }
  if (type === 'external_account') {
    const url = typeof json.service_account_impersonation_url === 'string' ? json.service_account_impersonation_url : '';
    const m = /serviceAccounts\/([^:/]+):generateAccessToken/.exec(url);
    base.clientEmail = m ? decodeURIComponent(m[1]!) : null;
    return { ...base, ok: true };
  }
  if (type === 'authorized_user') {
    return { ...base, problem: 'This is a user credential (authorized_user), not a service account. Use GOOGLE_AUTH_MODE=oauth for user authorization.' };
  }
  return { ...base, problem: `Unsupported credential type "${type ?? 'unknown'}" (expected service_account or external_account).` };
}

export class ServiceAccountGoogleAuthProvider implements GoogleAuthProvider {
  readonly mode = 'service_account' as const;
  /** ADC only: the credential type and identity google-auth-library actually resolved (set by getClient). */
  resolvedIdentity: ResolvedAdcIdentity | null = null;

  constructor(private readonly deps: { keyFile: string | null; fetch: FetchLike; timeoutMs?: number; env?: NodeJS.ProcessEnv }) {}

  describe(): ServiceAccountInfo {
    return this.deps.keyFile ? inspectServiceAccountFile(this.deps.keyFile) : inspectAdc(this.deps.env);
  }

  async getClient(): Promise<GoogleApiClient> {
    const transporterOptions = { fetchImplementation: this.deps.fetch as unknown as typeof fetch };
    const scopes = [...REQUIRED_SCOPES];
    let source: AuthHeaderSource;
    if (this.deps.keyFile) {
      const info = inspectServiceAccountFile(this.deps.keyFile);
      if (!info.ok) {
        throw info.exists
          ? new AppError('CONFIG_INVALID', info.problem ?? 'Invalid service-account credential file', { hint: 'Point GOOGLE_APPLICATION_CREDENTIALS to a service-account key or workload identity federation config (mode 0600).' })
          : new CredentialsMissingError('google_auth', ['GOOGLE_APPLICATION_CREDENTIALS file'], info.problem ?? undefined);
      }
      const json = JSON.parse(readFileSync(info.keyFile!, 'utf8')) as Record<string, unknown>;
      if (info.type === 'service_account') {
        registerSecret(json.private_key as string);
        const jwt = new JWT({ email: json.client_email as string, key: json.private_key as string, scopes, transporterOptions });
        source = serviceAccountHeaderSource((url) => jwt.getRequestHeaders(url));
      } else {
        const ext = ExternalAccountClient.fromJSON({ ...(json as object), scopes, transporterOptions } as Parameters<typeof ExternalAccountClient.fromJSON>[0]);
        if (!ext) throw new AppError('CONFIG_INVALID', 'Workload identity federation config could not be loaded.', { hint: 'Regenerate the credential configuration with `gcloud iam workload-identity-pools create-cred-config`.' });
        ext.scopes = scopes;
        source = serviceAccountHeaderSource(() => ext.getRequestHeaders());
      }
    } else {
      // Application Default Credentials: attached service account on Google Cloud, workload identity, etc.
      // The credential is resolved NOW so its type can be checked before any token request:
      // gcloud's application-default login file holds a personal user credential and is refused.
      const auth = new GoogleAuth({ scopes, clientOptions: { transporterOptions } });
      const resolved = await resolveAdcClient(auth);
      this.resolvedIdentity = resolved.identity;
      const client = resolved.client;
      source = serviceAccountHeaderSource((url) => client.getRequestHeaders(url));
    }
    return new AuthorizedGoogleApiClient(source, this.deps.fetch, { timeoutMs: this.deps.timeoutMs ?? DEFAULT_GOOGLE_TIMEOUT_MS });
  }
}

/**
 * Header source for service-account credentials. A rejected token request
 * (invalid_grant, 401) is re-issued with service-account guidance (disabled or
 * deleted key or account, clock skew, stale workload identity config) instead
 * of the OAuth refresh-token / Testing-mode hint. Other errors pass through.
 */
function serviceAccountHeaderSource(get: (url: string) => Promise<Headers | Record<string, string>>): AuthHeaderSource {
  return {
    getRequestHeaders: async (url) => {
      try {
        return await get(url);
      } catch (err) {
        const g = googleErrorFromUnknown('auth', err, { authMode: 'service_account' });
        throw g.kind === 'invalid_grant' || g.kind === 'unauthenticated' ? g : err;
      }
    },
  };
}

function adcTypeOf(auth: GoogleAuth, client: AuthClient): string {
  const json = (auth as unknown as { jsonContent?: { type?: unknown } | null }).jsonContent;
  if (json && typeof json.type === 'string') return json.type;
  if (client instanceof UserRefreshClient) return 'authorized_user';
  if (client instanceof ExternalAccountAuthorizedUserClient) return 'external_account_authorized_user';
  if (client instanceof Compute) return 'gce_metadata';
  if (client instanceof Impersonated) return 'impersonated_service_account';
  if (client instanceof BaseExternalAccountClient) return 'external_account';
  if (client instanceof JWT) return 'service_account';
  return 'unknown';
}

/** Resolve ADC and refuse user credentials before any token is requested. */
export async function resolveAdcClient(auth: GoogleAuth): Promise<{ client: AuthClient; identity: ResolvedAdcIdentity }> {
  let client: AuthClient;
  try {
    client = await auth.getClient();
  } catch (err) {
    if (/Could not load the default credentials/i.test(errorMessage(err))) {
      throw new CredentialsMissingError('google_auth', ['GOOGLE_APPLICATION_CREDENTIALS'], 'Service-account mode found no Application Default Credentials. Set GOOGLE_APPLICATION_CREDENTIALS to a key file or workload identity config (mode 0600), or run on a host with an attached service account.');
    }
    const g = googleErrorFromUnknown('auth', err);
    if (g.kind === 'network' || g.kind === 'offline') throw g;
    throw new AppError('CONFIG_INVALID', `Application Default Credentials could not be loaded: ${redactString(errorMessage(err))}`, {
      hint: 'Check the ADC source: GOOGLE_APPLICATION_CREDENTIALS, gcloud\'s application_default_credentials.json, or the attached service account. Then run `npm run cli -- auth diagnose`.',
      cause: err,
    });
  }
  const type = adcTypeOf(auth, client);
  if (USER_CREDENTIAL_TYPES.has(type) || client instanceof UserRefreshClient || client instanceof ExternalAccountAuthorizedUserClient) {
    throw new AppError('CONFIG_INVALID', adcUserCredentialProblem(type, 'the Application Default Credentials chain'), { hint: ADC_USER_HINT, details: { credentialType: type } });
  }
  if (!ADC_SERVICE_TYPES.has(type)) {
    throw new AppError('CONFIG_INVALID', `Application Default Credentials resolved to an unsupported credential type (${type}); service-account mode needs a service account.`, { hint: ADC_USER_HINT, details: { credentialType: type } });
  }
  const json = (auth as unknown as { jsonContent?: { client_email?: unknown; private_key?: unknown } | null }).jsonContent;
  if (json && typeof json.private_key === 'string') registerSecret(json.private_key);
  let clientEmail: string | null = json && typeof json.client_email === 'string' ? json.client_email : null;
  if (!clientEmail) {
    try {
      const creds = await auth.getCredentials();
      clientEmail = typeof creds.client_email === 'string' ? creds.client_email : null;
    } catch {
      clientEmail = null; // identity unknown; the token request itself still decides access
    }
  }
  return { client, identity: { type, clientEmail } };
}

export type GoogleAuthModeSetting = 'oauth' | 'service_account' | 'fixture';

/** Resolve the configured auth mode. Fixture mode is only valid for the synthetic demo profile. */
export function resolveGoogleAuthMode(ctx: AppContext): GoogleAuthModeSetting {
  if (ctx.synthetic) return 'fixture';
  const raw = (ctx.secrets.get('GOOGLE_AUTH_MODE') ?? 'oauth').trim().toLowerCase();
  if (raw === 'fixture') {
    throw new AppError('CONFIG_INVALID', 'GOOGLE_AUTH_MODE=fixture is only allowed with the demo profile; fixture data must never mix with live reporting.', {
      hint: 'Use GOOGLE_AUTH_MODE=oauth or service_account, or run `npm run demo`.',
    });
  }
  if (raw === 'service_account') return 'service_account';
  if (raw === 'oauth' || raw === '') return 'oauth';
  throw new AppError('CONFIG_INVALID', `Unknown GOOGLE_AUTH_MODE "${raw}".`, { hint: 'Use GOOGLE_AUTH_MODE=oauth (default) or GOOGLE_AUTH_MODE=service_account.' });
}

export function defaultGoogleFixturesDir(): string {
  return path.join(appDirs.fixtures(), 'google');
}

/**
 * The Demo profile reads synthetic Google fixtures shipped with the
 * application. A missing directory (for example an image built without
 * tests/fixtures) is reported as an actionable error, never a raw ENOENT.
 */
export function assertGoogleFixturesDir(dir: string): string {
  if (!existsSync(dir)) {
    throw new AppError('CONFIG_MISSING', `The synthetic Google fixtures of the Demo profile are missing from this installation (${dir}).`, {
      hint: 'They ship in tests/fixtures/google with the npm package and the container image. Reinstall the application, or rebuild the image from a current checkout (the Dockerfile copies tests/fixtures), then retry.',
      details: { fixturesDir: dir },
    });
  }
  return dir;
}

export function credentialPathsFor(ctx: AppContext): GoogleCredentialPaths {
  return googleCredentialPaths(ctx.paths, ctx.secrets);
}

export function tokenStoreFor(ctx: AppContext, paths: GoogleCredentialPaths = credentialPathsFor(ctx)): TokenStore {
  return new TokenStore(paths.tokenFile, ctx.clock, paths.tokenFileSource === 'default', ctx.paths);
}

/** Build the provider for this context (fixture provider in the demo profile). */
export function createGoogleAuthProvider(ctx: AppContext, opts: { fixturesDir?: string } = {}): GoogleAuthProvider {
  const mode = resolveGoogleAuthMode(ctx);
  if (mode === 'fixture') {
    return createFixtureGoogleAuthProvider(assertGoogleFixturesDir(opts.fixturesDir ?? defaultGoogleFixturesDir()), {
      gscProperty: ctx.config.google.searchConsoleProperty,
      ga4PropertyId: ctx.config.google.ga4PropertyId,
      clock: ctx.clock,
    });
  }
  const paths = credentialPathsFor(ctx);
  if (mode === 'service_account') return new ServiceAccountGoogleAuthProvider({ keyFile: paths.serviceAccountFile, fetch: ctx.fetch });
  return new OAuthGoogleAuthProvider({ clientFile: paths.clientFile, tokenStore: tokenStoreFor(ctx, paths), fetch: ctx.fetch, logger: ctx.logger });
}

export { GOOGLE_SCOPES };
