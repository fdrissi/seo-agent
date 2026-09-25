import { OAuth2Client } from 'google-auth-library';
import type { AppContext } from '../app/context.js';
import { recordAudit } from '../database/audit.js';
import { GoogleApiError, googleErrorFromUnknown } from '../integrations/google/errors.js';
import { resolveGoogleAuthMode, tokenStoreFor, inspectServiceAccountFile, credentialPathsFor } from './providers.js';

/**
 * Revoke the stored OAuth authorization at Google (POST
 * https://oauth2.googleapis.com/revoke) and delete the local token file.
 * Revoking the refresh token also invalidates its access tokens. A 400 from
 * the revoke endpoint means the token was already invalid; the local file is
 * then deleted too.
 */

export interface RevokeResult {
  mode: 'oauth' | 'service_account' | 'fixture';
  remote: 'revoked' | 'already_invalid' | 'not_attempted';
  localTokenDeleted: boolean;
  tokenFile: string | null;
  dryRun: boolean;
  notes: string[];
}

export async function revokeGoogleAuthorization(ctx: AppContext, opts: { localOnly?: boolean; dryRun?: boolean } = {}): Promise<RevokeResult> {
  const mode = resolveGoogleAuthMode(ctx);
  const dryRun = !!(opts.dryRun || ctx.dryRun);
  if (mode === 'fixture') {
    return { mode, remote: 'not_attempted', localTokenDeleted: false, tokenFile: null, dryRun, notes: ['Demo/fixture mode has no Google authorization to revoke.'] };
  }
  if (mode === 'service_account') {
    const sa = inspectServiceAccountFile(credentialPathsFor(ctx).serviceAccountFile);
    return {
      mode,
      remote: 'not_attempted',
      localTokenDeleted: false,
      tokenFile: null,
      dryRun,
      notes: [
        'Service accounts have no user authorization to revoke.',
        `To cut access: remove ${sa.clientEmail ?? 'the service-account email'} from Search Console (Settings > Users and permissions) and GA4 (Admin > Access Management), and disable or delete its key in Google Cloud IAM.`,
        'The local key file is not deleted automatically; delete it yourself after disabling the key.',
      ],
    };
  }
  const store = tokenStoreFor(ctx);
  const stored = store.read();
  if (!stored) {
    return { mode, remote: 'not_attempted', localTokenDeleted: false, tokenFile: store.file, dryRun, notes: ['No local Google token exists; nothing to revoke.'] };
  }
  const token = stored.tokens.refresh_token ?? stored.tokens.access_token ?? null;
  if (dryRun) {
    return {
      mode,
      remote: 'not_attempted',
      localTokenDeleted: false,
      tokenFile: store.file,
      dryRun,
      notes: [opts.localOnly ? 'Would delete the local token file only.' : `Would revoke the stored ${stored.tokens.refresh_token ? 'refresh' : 'access'} token at Google and delete the local token file.`],
    };
  }
  const notes: string[] = [];
  let remote: RevokeResult['remote'] = 'not_attempted';
  if (opts.localOnly || !token) {
    notes.push('Remote revocation was not attempted. The grant stays active at Google until you remove it at https://myaccount.google.com/permissions.');
  } else {
    if (ctx.offline) {
      throw new GoogleApiError({ api: 'oauth', status: 0, kind: 'offline', message: 'Network access is disabled; cannot revoke at Google. Use --local-only to only delete the local token.' });
    }
    const logged = ctx.requests.prepare({ siteId: ctx.siteId, provider: 'google_oauth', endpoint: 'oauth2.revoke', method: 'POST', isPaid: false, params: { tokenKind: stored.tokens.refresh_token ? 'refresh_token' : 'access_token' }, traceId: ctx.runId });
    ctx.requests.markSubmitted(logged.id);
    const client = new OAuth2Client({ transporterOptions: { fetchImplementation: ctx.fetch as unknown as typeof fetch } });
    try {
      await client.revokeToken(token);
      remote = 'revoked';
      ctx.requests.complete(logged.id, { status: 'succeeded', httpStatus: 200 });
    } catch (err) {
      const g = googleErrorFromUnknown('oauth', err);
      ctx.requests.complete(logged.id, { status: 'failed', httpStatus: g.status || null, error: { kind: g.kind, status: g.status } });
      if (g.status === 400) {
        remote = 'already_invalid';
        notes.push('Google reported the token as already invalid or revoked.');
      } else {
        throw new GoogleApiError({ api: 'oauth', status: g.status, kind: g.kind, message: `Revocation failed: ${g.message}. The local token was kept; retry, or use --local-only.` });
      }
    }
  }
  const deleted = store.delete();
  notes.push('Run `npm run cli -- auth google` to reconnect.');
  recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'cli', eventType: 'google.auth.revoked', subjectType: 'google_oauth_token', details: { remote, localTokenDeleted: deleted }, traceId: ctx.runId, at: ctx.clock.now() });
  return { mode, remote, localTokenDeleted: deleted, tokenFile: store.file, dryRun, notes };
}
