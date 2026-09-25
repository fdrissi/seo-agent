import type { Command } from 'commander';
import type { AppContext } from '../../app/context.js';
import { AppError } from '../../core/errors.js';
import { recordAudit } from '../../database/audit.js';
import { loadOAuthClientFile, maskClientId } from '../../auth/client-file.js';
import { diagnoseGoogle, renderDiagnose } from '../../auth/diagnose.js';
import { DEFAULT_FLOW_TIMEOUT_MS, REQUIRED_SCOPES, runDesktopOAuthFlow, type DesktopFlowResult } from '../../auth/oauth-flow.js';
import { createGoogleAuthProvider, credentialPathsFor, inspectAdc, inspectServiceAccountFile, resolveGoogleAuthMode, tokenStoreFor } from '../../auth/providers.js';
import { revokeGoogleAuthorization, type RevokeResult } from '../../auth/revoke.js';
import { authStatus, renderAuthStatus } from '../../auth/status.js';
import type { GoogleAuthProvider } from '../../integrations/google/types.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';

/**
 * `auth google | status | revoke | diagnose`.
 * The OAuth flow prints a URL for the owner to open in a browser; the code
 * returns to a 127.0.0.1-only listener. Nothing is ever pasted into a chat,
 * and no token value is ever printed.
 */

export interface AuthCommandDeps {
  context?: (g: GlobalOptions) => AppContext;
  provider?: (ctx: AppContext) => GoogleAuthProvider;
}

function renderFlowResult(r: DesktopFlowResult): string {
  return [
    'Google authorization stored.',
    `Token file: ${r.tokenFile} (mode 0600)`,
    `Refresh token stored: ${r.hasRefreshToken ? 'yes' : 'NO'}`,
    `Granted scopes: ${r.grantedScopes.join(' ') || 'unknown'}`,
    ...(r.missingScopes.length ? [`MISSING scopes: ${r.missingScopes.join(' ')}`] : []),
    ...r.warnings.map((w) => `Note: ${w}`),
    'Next: `npm run cli -- auth status` to list your Search Console properties and check GA4 access.',
  ].join('\n');
}

function renderRevoke(r: RevokeResult): string {
  return [
    `Mode: ${r.mode}${r.dryRun ? ' (dry run)' : ''}`,
    `Remote revocation: ${r.remote}`,
    `Local token deleted: ${r.localTokenDeleted ? 'yes' : 'no'}${r.tokenFile ? ` (${r.tokenFile})` : ''}`,
    ...r.notes.map((n) => `Note: ${n}`),
  ].join('\n');
}

export function register(program: Command, cli: CliRuntime, deps: AuthCommandDeps = {}): void {
  const ctxFor = (g: GlobalOptions) => (deps.context ? deps.context(g) : cli.context(g));
  const providerFor = (ctx: AppContext) => (deps.provider ? deps.provider(ctx) : createGoogleAuthProvider(ctx));
  const auth = program.command('auth').description('Google authorization: authorize, status, revoke, and permission diagnostics (read-only scopes only)');

  auth
    .command('google')
    .description('Authorize read-only Search Console + GA4 access via the local OAuth desktop flow (browser + 127.0.0.1 loopback, PKCE)')
    .option('--timeout <seconds>', 'how long to wait for the browser redirect', String(DEFAULT_FLOW_TIMEOUT_MS / 1000))
    .action(
      cli.action(async (opts: { timeout: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = ctxFor(g);
        try {
          const mode = resolveGoogleAuthMode(ctx);
          if (mode === 'fixture') {
            cli.print(g, { mode, message: 'Demo profile: synthetic fixtures are used; no Google authorization is needed or performed.' }, (r) => r.message);
            return;
          }
          if (mode === 'service_account') {
            const keyFile = credentialPathsFor(ctx).serviceAccountFile;
            // Without a configured key file, show what Application Default Credentials would load (user credentials are refused).
            const sa = keyFile ? inspectServiceAccountFile(keyFile) : inspectAdc();
            cli.print(
              g,
              { mode, serviceAccount: sa, message: 'Service-account mode needs no browser authorization.' },
              () =>
                [
                  'Service-account mode (GOOGLE_AUTH_MODE=service_account): no browser authorization is needed.',
                  sa.clientEmail ? `Grant ${sa.clientEmail} Restricted/Full user access in Search Console and the Viewer role in GA4.` : 'Grant the service-account identity Restricted/Full user access in Search Console and the Viewer role in GA4.',
                  ...(sa.problem ? [`Problem: ${sa.problem}`] : []),
                  'Then run `npm run cli -- auth status`.',
                ].join('\n'),
            );
            return;
          }
          const paths = credentialPathsFor(ctx);
          const store = tokenStoreFor(ctx, paths);
          const timeoutSeconds = Number(opts.timeout);
          if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 3600) throw new AppError('VALIDATION_FAILED', '--timeout must be between 10 and 3600 seconds');
          if (g.dryRun) {
            const info = loadOAuthClientFile(paths.clientFile);
            cli.print(
              g,
              { dryRun: true, clientFile: paths.clientFile, clientIdHint: maskClientId(info.clientId), tokenFile: store.file, scopes: REQUIRED_SCOPES, redirect: 'http://127.0.0.1:<ephemeral port>', pkce: 'S256', accessType: 'offline', prompt: 'consent' },
              (r) => `Dry run: would start a one-shot listener on ${r.redirect}, print a consent URL for scopes ${r.scopes.join(' ')} (PKCE S256, offline access), and store the token at ${r.tokenFile} (0600). Nothing was started.`,
            );
            return;
          }
          if (ctx.offline) throw new AppError('INTEGRATION_UNAVAILABLE', 'Authorization needs network access to Google; remove --offline.');
          const result = await runDesktopOAuthFlow({
            clientFile: paths.clientFile,
            tokenStore: store,
            fetch: ctx.fetch,
            clock: ctx.clock,
            timeoutMs: timeoutSeconds * 1000,
            onAuthUrl: (url, info) => {
              cli.io.err(
                [
                  'Open this URL in your browser and approve READ-ONLY access to Search Console and Google Analytics:',
                  '',
                  url,
                  '',
                  `Waiting for Google to redirect to ${info.redirectUri} (listening on 127.0.0.1 only; times out in ${Math.round(info.timeoutMs / 1000)}s).`,
                  'You never need to copy or paste a code or token: the redirect delivers it to this process.',
                ].join('\n'),
              );
            },
          });
          recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'cli', eventType: 'google.auth.authorized', subjectType: 'google_oauth_token', details: { hasRefreshToken: result.hasRefreshToken, grantedScopes: result.grantedScopes, missingScopes: result.missingScopes }, traceId: ctx.runId, at: ctx.clock.now() });
          cli.print(g, result, renderFlowResult);
        } finally {
          ctx.db.close();
        }
      }),
    );

  auth
    .command('status')
    .description('Show auth mode, credential presence and expiry hints (never token values), accessible Search Console properties, and GA4 access')
    .option('--no-network', 'skip the free read-only Google calls (sites.list, GA4 getMetadata)')
    .action(
      cli.action(async (opts: { network: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = ctxFor(g);
        try {
          let provider: GoogleAuthProvider | undefined;
          try {
            provider = deps.provider ? providerFor(ctx) : undefined;
          } catch {
            provider = undefined;
          }
          const report = await authStatus(ctx, { network: opts.network, ...(provider ? { provider } : {}) });
          cli.print(g, report, renderAuthStatus);
        } finally {
          ctx.db.close();
        }
      }),
    );

  auth
    .command('revoke')
    .description('Revoke the stored Google authorization at Google and delete the local token (reconnect with `auth google`)')
    .option('--local-only', 'only delete the local token file; do not contact Google')
    .action(
      cli.action(async (opts: { localOnly?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = ctxFor(g);
        try {
          const r = await revokeGoogleAuthorization(ctx, { localOnly: !!opts.localOnly, dryRun: !!g.dryRun });
          cli.print(g, r, renderRevoke);
        } finally {
          ctx.db.close();
        }
      }),
    );

  auth
    .command('diagnose')
    .description('Diagnose Google permissions: API enablement, property access, testing-mode token expiry, property formats, least privilege')
    .option('--no-network', 'skip the free read-only Google calls')
    .action(
      cli.action(async (opts: { network: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = ctxFor(g);
        try {
          let provider: GoogleAuthProvider | undefined;
          try {
            provider = deps.provider ? providerFor(ctx) : undefined;
          } catch {
            provider = undefined;
          }
          const report = await diagnoseGoogle(ctx, { network: opts.network, ...(provider ? { provider } : {}) });
          cli.print(g, report, renderDiagnose);
          if (report.findings.some((f) => f.severity === 'error')) process.exitCode = 1;
        } finally {
          ctx.db.close();
        }
      }),
    );
}
