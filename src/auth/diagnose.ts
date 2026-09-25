import type { AppContext } from '../app/context.js';
import { validateGscPropertyFormat } from '../integrations/google/gsc-client.js';
import type { GoogleAuthProvider } from '../integrations/google/types.js';
import { SERVICE_ACCOUNT_KEYS_PATH } from '../integrations/google/errors.js';
import { REQUIRED_SCOPES } from './oauth-flow.js';
import { authStatus, type AuthStatusReport, type ProblemInfo } from './status.js';

/**
 * Permission diagnostics. Distinguishes: missing API enablement, missing
 * property access, testing-mode 7-day refresh-token expiry (OAuth invalid_grant),
 * a rejected service-account token request (service-account invalid_grant),
 * wrong property formats, missing scopes, and weak file permissions. Always
 * recommends least privilege; never asks for owner/editor/administrator.
 */

export interface DiagnosticFinding {
  code: string;
  severity: 'ok' | 'info' | 'warning' | 'error';
  message: string;
  nextStep?: string;
}

export interface DiagnoseReport {
  siteId: string;
  mode: AuthStatusReport['mode'];
  networkChecked: boolean;
  findings: DiagnosticFinding[];
  leastPrivilege: string[];
  status: AuthStatusReport;
}

export const LEAST_PRIVILEGE_GUIDANCE: readonly string[] = [
  'OAuth scopes: only https://www.googleapis.com/auth/webmasters.readonly and https://www.googleapis.com/auth/analytics.readonly are requested. Never grant the read/write scopes.',
  'Search Console: add the authorized Google account or service-account email as a Restricted user first (Settings > Users and permissions); use Full user only if a read is refused. Owner is not required for these read-only APIs.',
  'GA4: grant the Viewer role on the specific property (Admin > Access Management). Editor and Administrator are not needed. A Viewer with "No Revenue Metrics" restrictions still works; revenue is then reported as unavailable.',
  'Google Cloud: enable only the Google Search Console API and the Google Analytics Data API in the project. No project Owner/Editor role and no domain-wide delegation is needed to read analytics.',
];

/**
 * A service account's token request was rejected (invalid_grant). There is no
 * refresh token, consent screen, or Testing publishing status in this mode, so
 * the OAuth guidance of REFRESH_INVALID_GRANT never applies.
 */
export function serviceAccountTokenRejected(p: ProblemInfo): DiagnosticFinding {
  return {
    code: 'SA_TOKEN_REJECTED',
    severity: 'error',
    message: `Google rejected the service-account token request (invalid_grant): ${p.message.replace(/\.\s*$/, '')}. Common causes: the key was disabled or deleted, the service account was disabled or deleted, the system clock is wrong (signed token requests carry timestamps), or the workload identity configuration is stale.`,
    nextStep: `Check ${SERVICE_ACCOUNT_KEYS_PATH}: confirm the account and key are enabled, or create a new key (or regenerate the workload identity configuration) and point GOOGLE_APPLICATION_CREDENTIALS at it (mode 0600). Sync the system clock. Then run \`npm run cli -- auth diagnose\` again.`,
  };
}

function fromProblem(area: 'GSC' | 'GA4' | 'AUTH', p: ProblemInfo, mode?: AuthStatusReport['mode']): DiagnosticFinding {
  if (mode === 'service_account' && p.kind === 'invalid_grant') return serviceAccountTokenRejected(p);
  switch (p.kind) {
    case 'api_not_enabled':
      return { code: `${area}_API_NOT_ENABLED`, severity: 'error', message: `${area === 'GA4' ? 'Google Analytics Data API' : 'Google Search Console API'} is not enabled in the Google Cloud project: ${p.message}`, nextStep: p.hint ?? undefined };
    case 'permission_denied':
      return { code: `${area}_NO_ACCESS`, severity: 'error', message: `The authorized identity has no access: ${p.message}`, nextStep: p.hint ?? undefined };
    case 'insufficient_scopes':
      return { code: 'SCOPES_MISSING', severity: 'error', message: `The authorization lacks a required read-only scope: ${p.message}`, nextStep: p.hint ?? undefined };
    case 'invalid_grant':
      return {
        code: 'REFRESH_INVALID_GRANT',
        severity: 'error',
        message: 'Google rejected the stored refresh token (invalid_grant). Common causes: the OAuth app is External with publishing status "Testing" (refresh tokens expire 7 days after consent), access was revoked, the token was unused for 6 months, or more than 100 refresh tokens were issued for this client.',
        nextStep: 'Run `npm run cli -- auth google` to re-authorize. For long-lived unattended access, publish the app to "In production", use an Internal app in a Workspace organization, or switch to a service account.',
      };
    case 'unauthenticated':
      return { code: `${area}_UNAUTHENTICATED`, severity: 'error', message: p.message, nextStep: p.hint ?? undefined };
    case 'not_found':
    case 'invalid_argument':
      return area === 'GA4'
        ? { code: 'GA4_PROPERTY_FORMAT', severity: 'error', message: `GA4 rejected the property: ${p.message}`, nextStep: 'Use the numeric GA4 property ID from GA4 Admin > Property details, not a measurement ID (G-...) or a Universal Analytics ID (UA-...).' }
        : { code: `${area}_REQUEST_INVALID`, severity: 'error', message: p.message, nextStep: p.hint ?? undefined };
    case 'rate_limited':
      return { code: `${area}_RATE_LIMITED`, severity: 'warning', message: p.message, nextStep: p.hint ?? undefined };
    case 'quota_exhausted':
      return { code: `${area}_QUOTA_EXHAUSTED`, severity: 'warning', message: p.message, nextStep: p.hint ?? undefined };
    case 'credentials':
      return { code: 'CREDENTIALS_MISSING', severity: 'error', message: p.message, nextStep: p.hint ?? undefined };
    case 'config':
      return { code: 'CREDENTIALS_UNUSABLE', severity: 'error', message: p.message, nextStep: p.hint ?? undefined };
    case 'offline':
      return { code: 'OFFLINE', severity: 'info', message: 'Offline mode: network checks were skipped.' };
    default:
      return { code: `${area}_ERROR`, severity: 'error', message: p.message, nextStep: p.hint ?? undefined };
  }
}

export async function diagnoseGoogle(ctx: AppContext, opts: { network: boolean; provider?: GoogleAuthProvider }): Promise<DiagnoseReport> {
  const s = await authStatus(ctx, opts);
  const f: DiagnosticFinding[] = [];
  if (s.mode === 'invalid') f.push({ code: 'AUTH_MODE_INVALID', severity: 'error', message: s.modeProblem ?? 'Invalid GOOGLE_AUTH_MODE', nextStep: 'Set GOOGLE_AUTH_MODE=oauth (default) or GOOGLE_AUTH_MODE=service_account.' });
  if (s.mode === 'fixture') f.push({ code: 'FIXTURE_MODE', severity: 'info', message: 'Demo profile: synthetic fixtures only. Nothing here reflects a real Google account.' });

  if (s.oauth) {
    const o = s.oauth;
    if (!o.clientFileExists) f.push({ code: 'CLIENT_FILE_MISSING', severity: 'error', message: `OAuth client file not found: ${o.clientFile}`, nextStep: 'Google Auth Platform > Clients > Create client > "Desktop app"; download the JSON to that path (chmod 600) or set GOOGLE_OAUTH_CLIENT_FILE.' });
    else if (!o.clientValid) f.push({ code: /Web application/.test(o.clientProblem ?? '') ? 'CLIENT_NOT_DESKTOP' : 'CLIENT_FILE_INVALID', severity: 'error', message: o.clientProblem ?? 'Invalid OAuth client file', nextStep: 'Create a "Desktop app" OAuth client and download its JSON.' });
    else f.push({ code: 'CLIENT_FILE_OK', severity: 'ok', message: `Desktop OAuth client ${o.clientIdHint ?? ''} loaded.` });
    const t = o.tokenStatus;
    if (!t.present) f.push({ code: 'TOKEN_MISSING', severity: 'error', message: 'No stored Google authorization.', nextStep: 'Run `npm run cli -- auth google`.' });
    else if (!t.valid) f.push({ code: 'TOKEN_FILE_INVALID', severity: 'error', message: t.problem ?? 'Token file unreadable', nextStep: 'Delete the token file and run `npm run cli -- auth google`.' });
    else {
      if (t.permissionsOk === false) f.push({ code: 'TOKEN_FILE_PERMISSIONS', severity: 'warning', message: `Token file mode is ${t.fileMode}; it must be readable only by you.`, nextStep: `chmod 600 "${t.file}"` });
      if (!t.hasRefreshToken) f.push({ code: 'TOKEN_NO_REFRESH', severity: 'warning', message: 'No refresh token is stored; access ends when the access token expires.', nextStep: 'Re-run `npm run cli -- auth google` (offline access with prompt=consent).' });
      const missing = t.grantedScopes.length ? REQUIRED_SCOPES.filter((sc) => !t.grantedScopes.includes(sc)) : [];
      if (missing.length) f.push({ code: 'SCOPES_MISSING', severity: 'error', message: `Scopes not granted: ${missing.join(', ')}`, nextStep: 'Re-run `npm run cli -- auth google` and keep both read-only permissions checked.' });
      const extra = t.grantedScopes.filter((sc) => !REQUIRED_SCOPES.includes(sc));
      if (extra.length) f.push({ code: 'SCOPES_BROADER_THAN_NEEDED', severity: 'warning', message: `The token carries scopes this tool does not need: ${extra.join(', ')}`, nextStep: 'Revoke (`auth revoke`) and re-authorize with `auth google`, which requests only the two read-only scopes.' });
      if ((t.ageDays ?? 0) >= 6 && s.authCheck.ok !== true) f.push({ code: 'TESTING_MODE_EXPIRY_RISK', severity: 'info', message: `The authorization is ${t.ageDays} day(s) old. External apps in "Testing" status lose refresh tokens 7 days after consent.`, nextStep: 'Run `npm run cli -- auth diagnose` with network access to confirm the refresh still works.' });
    }
  }
  if (s.serviceAccount) {
    const sa = s.serviceAccount;
    if (sa.source === 'adc' && !sa.ok) {
      f.push({ code: 'SA_ADC_REFUSED', severity: 'error', message: sa.problem ?? 'Application Default Credentials cannot be used in service-account mode.', nextStep: 'Use GOOGLE_AUTH_MODE=oauth for user authorization, or set GOOGLE_APPLICATION_CREDENTIALS to a service-account key or workload identity config (mode 0600).' });
    } else if (sa.source === 'adc') {
      const from = sa.adcOrigin === 'gcloud_file' ? `gcloud's file ${sa.keyFile}` : sa.adcOrigin === 'env_file' ? `${sa.keyFile} (GOOGLE_APPLICATION_CREDENTIALS in the process environment)` : 'the metadata server (attached service account on Google Cloud), if available';
      f.push({
        code: 'SA_USING_ADC',
        severity: 'info',
        message: `Service-account mode without a configured key file: Application Default Credentials from ${from}${sa.resolvedType ? `, resolved to ${sa.resolvedType}` : sa.type ? ` (${sa.type})` : ''}${sa.clientEmail ? ` for ${sa.clientEmail}` : ''}. User credentials (authorized_user) are refused in this mode.`,
      });
    } else if (!sa.exists) f.push({ code: 'SA_KEY_MISSING', severity: 'error', message: sa.problem ?? 'Key file missing', nextStep: 'Set GOOGLE_APPLICATION_CREDENTIALS to the key or workload identity configuration file (mode 0600, outside the vault and repository).' });
    else if (!sa.ok) f.push({ code: 'SA_KEY_INVALID', severity: 'error', message: sa.problem ?? 'Invalid credential file' });
    else f.push({ code: 'SA_KEY_OK', severity: 'ok', message: `${sa.type} credentials for ${sa.clientEmail ?? 'an external identity'}.` });
    if (sa.permissionsOk === false) f.push({ code: 'SA_KEY_PERMISSIONS', severity: 'warning', message: `Credential file mode is ${sa.fileMode}.`, nextStep: `chmod 600 "${sa.keyFile}"` });
    if (sa.clientEmail) f.push({ code: 'SA_GRANT_ACCESS', severity: 'info', message: `Grant ${sa.clientEmail} access separately: Search Console (Restricted/Full user on the exact property) and GA4 (Viewer on the property).` });
    if (sa.type === 'service_account') f.push({ code: 'SA_KEY_ROTATION', severity: 'info', message: 'Service-account keys are long-lived secrets. Prefer workload identity federation where available; otherwise rotate keys and keep them out of the vault and repository.' });
  }

  const property = ctx.config.google.searchConsoleProperty;
  if (s.gsc.enabled) {
    if (!property) f.push({ code: 'GSC_PROPERTY_NOT_CONFIGURED', severity: 'warning', message: 'google.searchConsoleProperty is not set.', nextStep: 'Run `npm run cli -- auth status` to list accessible properties and copy one exactly.' });
    else {
      const fmt = validateGscPropertyFormat(property);
      for (const p of fmt.problems) f.push({ code: 'GSC_PROPERTY_FORMAT', severity: 'error', message: `${property}: ${p}` });
      for (const n of fmt.notes) f.push({ code: 'GSC_PROPERTY_FORMAT_NOTE', severity: 'info', message: `${property}: ${n}` });
    }
  }
  if (s.ga4.enabled && !s.ga4.propertyId) f.push({ code: 'GA4_PROPERTY_NOT_CONFIGURED', severity: 'warning', message: 'google.ga4PropertyId is not set.', nextStep: 'Copy the numeric property ID from GA4 Admin > Property details.' });
  if (s.ga4.enabled && !ctx.config.conversions.primaryEvents.length) f.push({ code: 'PRIMARY_EVENT_NOT_CONFIGURED', severity: 'warning', message: 'No primary conversion event is configured; no conversion rate will be reported.', nextStep: 'Add conversions.primaryEvents with the exact GA4 event name and its business meaning.' });

  // Fixture answers (demo profile) are evaluated like live ones; they are labelled synthetic, never network-checked.
  if (s.network.checked || s.network.fixture) {
    if (s.authCheck.ok === false && s.authCheck.problem) f.push(fromProblem('AUTH', s.authCheck.problem, s.mode));
    if (s.gsc.problem && s.gsc.problem !== s.authCheck.problem) f.push(fromProblem('GSC', s.gsc.problem, s.mode));
    if (s.gsc.properties) {
      const match = property ? s.gsc.properties.find((p) => p.siteUrl === property) : undefined;
      if (property && !match) {
        f.push(
          s.gsc.suggestions.length
            ? { code: 'GSC_PROPERTY_MISMATCH', severity: 'error', message: `"${property}" is not in the accessible list, but similar properties are: ${s.gsc.suggestions.join(', ')}.`, nextStep: 'Copy the exact property string (scheme, www, trailing slash, or sc-domain:). Properties are never guessed.' }
            : { code: 'GSC_PROPERTY_NO_ACCESS', severity: 'error', message: `"${property}" is not accessible to this identity.`, nextStep: 'Add the identity as a Restricted user of that property in Search Console, or configure an accessible property.' },
        );
      } else if (match && match.permissionLevel === 'siteUnverifiedUser') {
        f.push({ code: 'GSC_UNVERIFIED_USER', severity: 'error', message: `"${property}" is listed as siteUnverifiedUser, which has no access to data.`, nextStep: 'Have an owner add this identity under Settings > Users and permissions (Restricted user is the least privilege to try first).' });
      } else if (match && match.permissionLevel === 'siteOwner') {
        f.push({ code: 'GSC_MORE_PRIVILEGE_THAN_NEEDED', severity: 'info', message: `This identity is an owner of "${property}". Read-only syncing works; a Restricted or Full user is enough for a dedicated identity.` });
      } else if (match) f.push({ code: 'GSC_PROPERTY_OK', severity: 'ok', message: `"${property}" accessible as ${match.permissionLevel}.` });
    }
    if (s.ga4.problem && s.ga4.problem !== s.authCheck.problem) f.push(fromProblem('GA4', s.ga4.problem, s.mode));
    if (s.ga4.access === 'ok') {
      f.push({ code: 'GA4_ACCESS_OK', severity: 'ok', message: `GA4 property ${s.ga4.propertyId} accessible.` });
      if (s.ga4.primaryRateAvailable === false) {
        f.push({ code: 'PRIMARY_EVENT_NOT_KEY_EVENT', severity: 'warning', message: `GA4 does not list sessionKeyEventRate:${s.ga4.primaryEvent}. The event is probably not marked as a key event. The primary conversion rate will be reported as unavailable (no substitute rate is used).`, nextStep: 'Mark the event as a key event in GA4 Admin (a human action), then verify with `npm run cli -- sync ga4 --checklist`.' });
      }
    }
  } else {
    f.push({ code: 'NETWORK_NOT_CHECKED', severity: 'info', message: s.network.reason ?? 'Network checks were not performed.' });
  }
  return { siteId: ctx.siteId, mode: s.mode, networkChecked: s.network.checked, findings: f, leastPrivilege: [...LEAST_PRIVILEGE_GUIDANCE], status: s };
}

export function renderDiagnose(r: DiagnoseReport): string {
  const icon = { ok: 'OK   ', info: 'INFO ', warning: 'WARN ', error: 'ERROR' } as const;
  const lines = [`Google permission diagnostics for ${r.siteId} (mode ${r.mode}, network ${r.networkChecked ? 'checked' : r.status.network.fixture ? 'none: demo fixtures answered in-process' : 'not checked'})`, ''];
  for (const x of r.findings) {
    lines.push(`${icon[x.severity]} ${x.code}: ${x.message}`);
    if (x.nextStep) lines.push(`      next: ${x.nextStep}`);
  }
  lines.push('', 'Least privilege:');
  for (const l of r.leastPrivilege) lines.push(`  - ${l}`);
  return lines.join('\n');
}
