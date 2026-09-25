import { OAuthGoogleAuthProvider, ServiceAccountGoogleAuthProvider } from '../../auth/providers.js';
import { AppError, CredentialsMissingError } from '../../core/errors.js';
import type { GoogleAuthProvider } from './types.js';

/**
 * Offline credential check for dry runs (spec 29 `--dry-run`, spec 31 honest
 * status): does the auth provider's credential resolve, without a network
 * call and without writing anything?
 *
 * It throws the SAME error the real run's `provider.getClient()` throws when
 * the credential is missing or unusable (CREDENTIALS_MISSING for a missing
 * OAuth client file, token, or service-account key file; CONFIG_INVALID for
 * an unusable one), so `sync gsc --dry-run` fails (exit 3) exactly like
 * `sync gsc` instead of printing a plan that the real run cannot execute,
 * and an optional pipeline stage run as a dry run is failed/degraded with
 * that code instead of a bare 'succeeded'.
 *
 * What it cannot know offline is reported, never assumed:
 *  - 'fixture'    synthetic fixture provider (demo profile, tests);
 *  - 'ok'         the credential resolves locally (access to the property is
 *                 still only verified by the real run);
 *  - 'unverified' Application Default Credentials from the metadata server,
 *                 or a provider this check does not know: resolved only by
 *                 the real run.
 */
export interface OfflineCredentialCheck {
  status: 'ok' | 'fixture' | 'unverified';
  /** Plain-language note for the dry-run plan. */
  note: string;
}

export function checkCredentialsOffline(provider: GoogleAuthProvider): OfflineCredentialCheck {
  if (provider.mode === 'fixture') return { status: 'fixture', note: 'Credentials: SYNTHETIC fixture provider (no credentials are used).' };
  if (provider instanceof OAuthGoogleAuthProvider) {
    // Reads the OAuth client file and the stored token only (no token refresh, no request):
    // the same checks, and the same errors, as getClient().
    provider.authorizedClient();
    return { status: 'ok', note: 'Credentials: the OAuth client file and stored token resolve (checked locally without a network call; property access is verified by the real run).' };
  }
  if (provider instanceof ServiceAccountGoogleAuthProvider) {
    const info = provider.describe();
    if (info.source === 'key_file') {
      if (!info.ok) {
        // Same errors as ServiceAccountGoogleAuthProvider.getClient().
        throw info.exists
          ? new AppError('CONFIG_INVALID', info.problem ?? 'Invalid service-account credential file', { hint: 'Point GOOGLE_APPLICATION_CREDENTIALS to a service-account key or workload identity federation config (mode 0600).' })
          : new CredentialsMissingError('google_auth', ['GOOGLE_APPLICATION_CREDENTIALS file'], info.problem ?? undefined);
      }
      return { status: 'ok', note: `Credentials: the service-account credential file resolves${info.clientEmail ? ` (${info.clientEmail})` : ''} (checked locally without a network call; property access is verified by the real run).` };
    }
    if (!info.ok) {
      throw new AppError('CONFIG_INVALID', info.problem ?? 'Application Default Credentials resolve to an unsupported credential.', {
        hint: 'Use GOOGLE_AUTH_MODE=oauth for user authorization (`npm run cli -- auth google`), or set GOOGLE_APPLICATION_CREDENTIALS to a service-account key or workload identity config (mode 0600). Then run `npm run cli -- auth diagnose`.',
      });
    }
    if (info.adcOrigin === 'metadata_server') {
      return {
        status: 'unverified',
        note: 'Credentials NOT verified: service-account mode found no credential file, so Application Default Credentials would come from the metadata server of an attached service account; only the real run can tell whether they resolve (off Google Cloud it fails with CREDENTIALS_MISSING).',
      };
    }
    return { status: 'ok', note: `Credentials: Application Default Credentials resolve to a credential file${info.clientEmail ? ` (${info.clientEmail})` : ''} (checked locally without a network call; property access is verified by the real run).` };
  }
  return { status: 'unverified', note: `Credentials NOT verified: the ${provider.mode} auth provider cannot be checked without a network call; the real run resolves them.` };
}
