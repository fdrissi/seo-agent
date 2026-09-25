import { existsSync } from 'node:fs';
import type { AppContext } from '../app/context.js';
import { errorMessage, isAppError } from '../core/errors.js';
import type { IntegrationState, IntegrationStatus } from '../integrations/types.js';
import { GoogleApiError, googleErrorFromUnknown, withAuthModeHint, type GoogleErrorKind } from '../integrations/google/errors.js';
import { getMetadata } from '../integrations/google/ga4-client.js';
import { compactMetadata, planGa4Metrics } from '../integrations/google/ga4-metadata.js';
import { discoverGscProperties, type DiscoveredProperty } from '../integrations/google/gsc-properties.js';
import type { GoogleApiClient, GoogleAuthProvider } from '../integrations/google/types.js';
import { loadOAuthClientFile, maskClientId } from './client-file.js';
import { credentialPathsFor, createGoogleAuthProvider, inspectAdc, inspectServiceAccountFile, resolveGoogleAuthMode, ServiceAccountGoogleAuthProvider, tokenStoreFor, type ServiceAccountInfo } from './providers.js';
import { fileMode, type TokenSummary } from './token-store.js';

/**
 * `auth status`: mode, credential presence and token expiry hints (never
 * token values), discovered Search Console properties with permission
 * levels, and a GA4 access check. Network checks are free, read-only calls.
 */

export interface ProblemInfo {
  kind: GoogleErrorKind | 'credentials' | 'config' | 'unknown';
  message: string;
  hint: string | null;
}

export interface AuthStatusReport {
  siteId: string;
  mode: 'oauth' | 'service_account' | 'fixture' | 'invalid';
  modeProblem: string | null;
  oauth: {
    clientFile: string;
    clientFileSource: string;
    clientFileExists: boolean;
    clientValid: boolean;
    clientProblem: string | null;
    clientIdHint: string | null;
    projectId: string | null;
    tokenFileSource: string;
    /** Token presence/expiry summary (never token values). Named to avoid redaction of the whole object. */
    tokenStatus: TokenSummary;
  } | null;
  serviceAccount: (ServiceAccountInfo & { fileMode: string | null; permissionsOk: boolean | null; resolvedType: string | null }) | null;
  /**
   * `checked`: free read-only Google requests were made. `fixture`: the demo profile's synthetic fixtures
   * answered the same checks in-process (no network request; `checked` stays false). Optional for
   * compatibility with reports built before the flag existed.
   */
  network: { checked: boolean; reason: string | null; fixture?: boolean };
  authCheck: { ok: boolean | null; problem: ProblemInfo | null };
  gsc: {
    enabled: boolean;
    configuredProperty: string | null;
    properties: DiscoveredProperty[] | null;
    configuredAccessible: boolean | null;
    configuredPermission: string | null;
    suggestions: string[];
    problem: ProblemInfo | null;
  };
  ga4: {
    enabled: boolean;
    propertyId: string | null;
    access: 'ok' | 'denied' | 'error' | 'not_checked' | 'not_configured';
    primaryEvent: string | null;
    primaryRateAvailable: boolean | null;
    limitations: string[];
    problem: ProblemInfo | null;
  };
  urlInspectionEnabled: boolean;
  synthetic: boolean;
  statuses: IntegrationStatus[];
}

export const SENDS_EXTERNALLY = {
  google_auth: [
    'OAuth: client ID/secret, authorization code, and PKCE verifier to Google\'s token endpoint; refresh token when renewing access',
    'Service account: a signed JWT assertion to Google\'s token endpoint',
  ],
  google_gsc: ['Search Console property ID, date ranges, dimensions, and page-URL filters (URLs of your own site) to Google'],
  google_ga4: ['GA4 property ID and report definitions (dimensions, metrics, filters including configured event names) to Google'],
  google_url_inspection: ['Search Console property ID and the URLs being inspected to Google'],
} as const;

/** Problems that mean the credential itself is unusable (as opposed to missing access to one property). */
const AUTH_PROBLEM_KINDS: ReadonlySet<ProblemInfo['kind']> = new Set(['invalid_grant', 'unauthenticated', 'credentials', 'config']);

/**
 * Problem summary for an error. `mode` selects mode-specific guidance: a
 * service account has no refresh token, consent screen, or Testing status, so
 * its credential errors never get OAuth re-authorization hints.
 */
function problemOf(err: unknown, mode?: AuthStatusReport['mode']): ProblemInfo {
  const authMode = mode === 'service_account' || mode === 'oauth' || mode === 'fixture' ? mode : undefined;
  if (err instanceof GoogleApiError) {
    const g = withAuthModeHint(err, authMode);
    return { kind: g.kind, message: g.message, hint: g.hint ?? null };
  }
  if (isAppError(err)) return { kind: err.code === 'CREDENTIALS_MISSING' ? 'credentials' : err.code === 'CONFIG_INVALID' || err.code === 'CONFIG_MISSING' ? 'config' : 'unknown', message: err.message, hint: err.hint ?? null };
  const g = googleErrorFromUnknown('auth', err, authMode ? { authMode } : {});
  return { kind: g.kind, message: g.message, hint: g.hint ?? null };
}

function stateForProblem(p: ProblemInfo): IntegrationState {
  switch (p.kind) {
    case 'credentials':
    case 'invalid_grant':
    case 'unauthenticated':
      return 'missing_credentials';
    case 'config':
    case 'invalid_argument':
    case 'not_found':
      return 'misconfigured';
    case 'api_not_enabled':
    case 'permission_denied':
    case 'insufficient_scopes':
      return 'permission_denied';
    case 'rate_limited':
    case 'quota_exhausted':
      return 'degraded';
    case 'offline':
      return 'configured_unverified';
    default:
      return 'unreachable';
  }
}

export async function authStatus(ctx: AppContext, opts: { network: boolean; provider?: GoogleAuthProvider }): Promise<AuthStatusReport> {
  const now = ctx.clock.now().toISOString();
  const features = ctx.settings.features;
  const report: AuthStatusReport = {
    siteId: ctx.siteId,
    mode: 'invalid',
    modeProblem: null,
    oauth: null,
    serviceAccount: null,
    network: { checked: false, reason: null },
    authCheck: { ok: null, problem: null },
    gsc: { enabled: features.gsc, configuredProperty: ctx.config.google.searchConsoleProperty, properties: null, configuredAccessible: null, configuredPermission: null, suggestions: [], problem: null },
    ga4: { enabled: features.ga4, propertyId: ctx.config.google.ga4PropertyId, access: ctx.config.google.ga4PropertyId ? 'not_checked' : 'not_configured', primaryEvent: ctx.config.conversions.primaryEvents[0]?.name ?? null, primaryRateAvailable: null, limitations: [], problem: null },
    urlInspectionEnabled: features.urlInspection,
    synthetic: false,
    statuses: [],
  };
  let credentialsPresent = false;
  try {
    report.mode = opts.provider?.mode ?? resolveGoogleAuthMode(ctx);
  } catch (err) {
    report.modeProblem = errorMessage(err);
  }
  report.synthetic = report.mode === 'fixture';

  if (report.mode === 'oauth') {
    const paths = credentialPathsFor(ctx);
    const store = tokenStoreFor(ctx, paths);
    const o: NonNullable<AuthStatusReport['oauth']> = {
      clientFile: paths.clientFile,
      clientFileSource: paths.clientFileSource,
      clientFileExists: existsSync(paths.clientFile),
      clientValid: false,
      clientProblem: null,
      clientIdHint: null,
      projectId: null,
      tokenFileSource: paths.tokenFileSource,
      tokenStatus: store.summary(),
    };
    try {
      const info = loadOAuthClientFile(paths.clientFile);
      o.clientValid = true;
      o.clientIdHint = maskClientId(info.clientId);
      o.projectId = info.projectId;
    } catch (err) {
      o.clientProblem = errorMessage(err);
    }
    report.oauth = o;
    credentialsPresent = o.clientValid && o.tokenStatus.valid;
  } else if (report.mode === 'service_account') {
    const paths = credentialPathsFor(ctx);
    const sa = paths.serviceAccountFile ? inspectServiceAccountFile(paths.serviceAccountFile) : opts.provider instanceof ServiceAccountGoogleAuthProvider ? opts.provider.describe() : inspectAdc();
    const mode = sa.keyFile && sa.exists ? fileMode(sa.keyFile) : null;
    report.serviceAccount = { ...sa, fileMode: mode === null ? null : mode.toString(8).padStart(3, '0'), permissionsOk: mode === null || process.platform === 'win32' ? null : (mode & 0o077) === 0, resolvedType: null };
    credentialsPresent = sa.ok;
  } else if (report.mode === 'fixture') {
    credentialsPresent = true;
  }

  const wantNetwork = opts.network && report.mode !== 'invalid' && credentialsPresent;
  if (!opts.network) report.network.reason = 'Network checks were not requested.';
  else if (report.mode === 'invalid') report.network.reason = 'Auth mode is invalid.';
  else if (!credentialsPresent) report.network.reason = 'Credentials are missing or invalid; no Google request was made.';
  else if (ctx.offline && report.mode !== 'fixture') report.network.reason = 'Offline mode: no Google request was made.';

  if (wantNetwork && !(ctx.offline && report.mode !== 'fixture')) {
    if (report.mode === 'fixture') {
      // Demo fixtures answer in-process: no request leaves the machine, so the checks are not "network checked".
      report.network.fixture = true;
      report.network.reason = 'Demo fixtures answered in-process; no network request was made.';
    } else report.network.checked = true;
    let provider: GoogleAuthProvider | null = null;
    let client: GoogleApiClient | null = null;
    try {
      provider = opts.provider ?? createGoogleAuthProvider(ctx);
      client = await provider.getClient();
    } catch (err) {
      report.authCheck = { ok: false, problem: problemOf(err, report.mode) };
    }
    // ADC: report the credential type and identity google-auth-library actually resolved.
    if (provider instanceof ServiceAccountGoogleAuthProvider && provider.resolvedIdentity && report.serviceAccount) {
      report.serviceAccount.resolvedType = provider.resolvedIdentity.type;
      report.serviceAccount.clientEmail = provider.resolvedIdentity.clientEmail ?? report.serviceAccount.clientEmail;
    }
    if (provider && client) {
      if (features.gsc || features.urlInspection) {
        try {
          const d = await discoverGscProperties(ctx, provider, { client });
          report.gsc.properties = d.properties;
          report.gsc.configuredAccessible = d.configured.property ? d.configured.accessible : null;
          report.gsc.configuredPermission = d.configured.permissionLevel;
          report.gsc.suggestions = d.configured.suggestions;
          report.authCheck = { ok: true, problem: null };
        } catch (err) {
          const p = problemOf(err, report.mode);
          report.gsc.problem = p;
          if (AUTH_PROBLEM_KINDS.has(p.kind)) report.authCheck = { ok: false, problem: p };
        }
      }
      if (features.ga4 && report.ga4.propertyId && report.authCheck.ok !== false) {
        try {
          const { metadata } = await getMetadata({ ctx, client, synthetic: report.synthetic }, report.ga4.propertyId);
          report.ga4.access = 'ok';
          const plan = planGa4Metrics(compactMetadata(metadata), { primary: ctx.config.conversions.primaryEvents.map((e) => e.name), secondary: ctx.config.conversions.secondaryEvents.map((e) => e.name) });
          report.ga4.primaryRateAvailable = plan.primaryEvent ? plan.primaryRateMetric !== null : null;
          report.ga4.limitations = plan.limitations.map((l) => `${l.metric}: ${l.reason}`);
          report.authCheck = { ok: true, problem: null };
        } catch (err) {
          const p = problemOf(err, report.mode);
          report.ga4.problem = p;
          report.ga4.access = p.kind === 'permission_denied' || p.kind === 'api_not_enabled' || p.kind === 'insufficient_scopes' ? 'denied' : 'error';
          if (AUTH_PROBLEM_KINDS.has(p.kind)) report.authCheck = { ok: false, problem: p };
        }
      }
    }
  }
  report.statuses = buildStatuses(report, now);
  return report;
}

function buildStatuses(r: AuthStatusReport, checkedAt: string): IntegrationStatus[] {
  const net = r.network.checked;
  const mk = (id: IntegrationStatus['id'], state: IntegrationState, detail: string, nextStep?: string): IntegrationStatus => ({
    id,
    state,
    detail,
    ...(nextStep ? { nextStep } : {}),
    sendsExternally: [...SENDS_EXTERNALLY[id as keyof typeof SENDS_EXTERNALLY]],
    checkedAt,
    networkChecked: net,
    chargeable: false,
  });

  // google_auth
  let auth: IntegrationStatus;
  if (r.mode === 'invalid') auth = mk('google_auth', 'misconfigured', r.modeProblem ?? 'Invalid GOOGLE_AUTH_MODE', 'Set GOOGLE_AUTH_MODE to oauth or service_account.');
  else if (r.mode === 'fixture') auth = mk('google_auth', 'fixture', 'Demo profile: synthetic Google fixtures, never live data.');
  else if (r.mode === 'oauth') {
    const o = r.oauth!;
    if (!o.clientFileExists) auth = mk('google_auth', 'missing_credentials', `OAuth client file not found (${o.clientFile}).`, 'Create a "Desktop app" OAuth client in Google Auth Platform > Clients and save its JSON there (chmod 600), then run `npm run cli -- auth google`.');
    else if (!o.clientValid) auth = mk('google_auth', 'misconfigured', o.clientProblem ?? 'Invalid OAuth client file.', 'Download the JSON of a "Desktop app" OAuth client.');
    else if (!o.tokenStatus.present) auth = mk('google_auth', 'missing_credentials', 'No Google token stored yet.', 'Run `npm run cli -- auth google` and approve read-only access in your browser.');
    else if (!o.tokenStatus.valid) auth = mk('google_auth', 'misconfigured', o.tokenStatus.problem ?? 'Token file is unreadable.', 'Delete the token file and run `npm run cli -- auth google`.');
    else if (r.authCheck.ok === false && r.authCheck.problem) auth = mk('google_auth', stateForProblem(r.authCheck.problem), r.authCheck.problem.message, r.authCheck.problem.hint ?? undefined);
    else if (r.authCheck.ok) auth = mk('google_auth', 'ready', `OAuth desktop client ${o.clientIdHint ?? ''}; token refresh verified by a read-only call.`);
    else auth = mk('google_auth', 'configured_unverified', `OAuth client and token present${o.tokenStatus.hasRefreshToken ? ' (refresh token stored)' : ' (NO refresh token)'}; not verified over the network.`, o.tokenStatus.hints[0]);
  } else {
    const sa = r.serviceAccount!;
    const adcFrom = sa.adcOrigin === 'gcloud_file' ? `gcloud's ${sa.keyFile}` : sa.adcOrigin === 'env_file' ? `${sa.keyFile} (process environment)` : 'the metadata server (attached service account), if any';
    if (sa.source === 'key_file' && !sa.exists) auth = mk('google_auth', 'missing_credentials', sa.problem ?? 'Service-account key file missing.', 'Set GOOGLE_APPLICATION_CREDENTIALS to the key or workload identity config file (mode 0600).');
    else if (!sa.ok) auth = mk('google_auth', 'misconfigured', sa.problem ?? 'Invalid service-account credentials.', sa.source === 'adc' ? 'Use GOOGLE_AUTH_MODE=oauth for user authorization, or set GOOGLE_APPLICATION_CREDENTIALS to a service-account key or workload identity config.' : undefined);
    else if (r.authCheck.ok === false && r.authCheck.problem) auth = mk('google_auth', stateForProblem(r.authCheck.problem), r.authCheck.problem.message, r.authCheck.problem.hint ?? undefined);
    else if (r.authCheck.ok)
      auth = mk('google_auth', 'ready', sa.source === 'adc' ? `Application Default Credentials resolved to ${sa.resolvedType ?? 'an unknown credential type'} for ${sa.clientEmail ?? 'an unreported identity'}; a token was obtained.` : `Service account ${sa.clientEmail ?? '(unknown identity)'} obtained a token.`);
    else auth = mk('google_auth', 'configured_unverified', sa.source === 'adc' ? `Service-account mode via Application Default Credentials from ${adcFrom}${sa.type ? ` (${sa.type}${sa.clientEmail ? ` ${sa.clientEmail}` : ''})` : ''}; not verified over the network.` : `Service-account credentials for ${sa.clientEmail ?? 'unknown identity'}; not verified over the network.`, sa.permissionsOk === false ? `chmod 600 "${sa.keyFile}"` : undefined);
  }
  const authBlocked = auth.state === 'missing_credentials' || auth.state === 'misconfigured';

  // google_gsc
  let gsc: IntegrationStatus;
  if (!r.gsc.enabled) gsc = mk('google_gsc', 'disabled', 'features.gsc is off.');
  else if (!r.gsc.configuredProperty) gsc = mk('google_gsc', 'misconfigured', 'No Search Console property configured.', 'Run `npm run cli -- auth status` to list accessible properties, then set google.searchConsoleProperty exactly.');
  else if (r.mode === 'fixture') gsc = mk('google_gsc', 'fixture', `Synthetic Search Console fixtures for ${r.gsc.configuredProperty}.`);
  else if (authBlocked) gsc = mk('google_gsc', auth.state, `Blocked until Google access works: ${auth.detail}`, auth.nextStep);
  else if (r.gsc.problem) gsc = mk('google_gsc', stateForProblem(r.gsc.problem), r.gsc.problem.message, r.gsc.problem.hint ?? undefined);
  else if (r.gsc.configuredAccessible === true) gsc = mk('google_gsc', 'ready', `Property ${r.gsc.configuredProperty} accessible (${r.gsc.configuredPermission}).`);
  else if (r.gsc.configuredAccessible === false)
    gsc = mk('google_gsc', 'permission_denied', `Property ${r.gsc.configuredProperty} is not readable by this identity.`, r.gsc.suggestions.length ? `Did you mean: ${r.gsc.suggestions.join(', ')}? Property strings must match exactly.` : 'Grant Restricted or Full user access in Search Console, or configure an accessible property.');
  else gsc = mk('google_gsc', 'configured_unverified', `Property ${r.gsc.configuredProperty} configured; access not verified${r.network.reason ? ` (${r.network.reason})` : ''}.`);

  // google_ga4
  let ga4: IntegrationStatus;
  if (!r.ga4.enabled) ga4 = mk('google_ga4', 'disabled', 'features.ga4 is off.');
  else if (!r.ga4.propertyId) ga4 = mk('google_ga4', 'misconfigured', 'No GA4 property configured.', 'Set google.ga4PropertyId to the numeric GA4 property ID (GA4 Admin > Property details).');
  else if (r.mode === 'fixture') ga4 = mk('google_ga4', 'fixture', `Synthetic GA4 fixtures for property ${r.ga4.propertyId}.`);
  else if (authBlocked) ga4 = mk('google_ga4', auth.state, `Blocked until Google access works: ${auth.detail}`, auth.nextStep);
  else if (r.ga4.problem) ga4 = mk('google_ga4', stateForProblem(r.ga4.problem), r.ga4.problem.message, r.ga4.problem.hint ?? undefined);
  else if (r.ga4.access === 'ok')
    ga4 = mk('google_ga4', r.ga4.primaryRateAvailable === false ? 'degraded' : 'ready', r.ga4.primaryRateAvailable === false ? `Property ${r.ga4.propertyId} accessible, but the primary-event conversion rate is unavailable.` : `Property ${r.ga4.propertyId} accessible.`, r.ga4.primaryRateAvailable === false ? 'Mark the primary event as a key event in GA4 (a human action), then re-run `auth status`. See `npm run cli -- sync ga4 --checklist`.' : undefined);
  else ga4 = mk('google_ga4', 'configured_unverified', `Property ${r.ga4.propertyId} configured; access not verified${r.network.reason ? ` (${r.network.reason})` : ''}.`);

  // google_url_inspection
  let ui: IntegrationStatus;
  if (!r.urlInspectionEnabled) ui = mk('google_url_inspection', 'disabled', 'features.urlInspection is off.');
  else if (!r.gsc.configuredProperty) ui = mk('google_url_inspection', 'misconfigured', 'Needs google.searchConsoleProperty.');
  else ui = mk('google_url_inspection', gsc.state === 'disabled' ? 'configured_unverified' : gsc.state, `Uses the Search Console authorization; reports Google's indexed state only (not a live test). ${gsc.detail}`, gsc.nextStep);
  return [auth, gsc, ga4, ui];
}

export function renderAuthStatus(r: AuthStatusReport): string {
  const lines: string[] = [`Google access for site ${r.siteId}`, `Mode: ${r.mode}${r.modeProblem ? ` (${r.modeProblem})` : ''}${r.synthetic ? ' [SYNTHETIC FIXTURES]' : ''}`];
  if (r.oauth) {
    const t = r.oauth.tokenStatus;
    lines.push(`OAuth client file: ${r.oauth.clientFile} (${r.oauth.clientFileSource}) ${r.oauth.clientValid ? `valid Desktop client ${r.oauth.clientIdHint ?? ''}` : r.oauth.clientFileExists ? `INVALID: ${r.oauth.clientProblem}` : 'MISSING'}`);
    lines.push(`Token file: ${t.file} (${r.oauth.tokenFileSource}) ${t.present ? `present, mode ${t.fileMode}${t.permissionsOk === false ? ' (TOO OPEN)' : ''}` : 'not present'}`);
    if (t.valid) {
      lines.push(`  refresh token stored: ${t.hasRefreshToken ? 'yes' : 'NO'}; access token expires: ${t.accessTokenExpiresAt ?? 'unknown'}${t.accessTokenExpired ? ' (expired; refreshed on next use)' : ''}`);
      lines.push(`  granted scopes: ${t.grantedScopes.join(' ') || 'unknown'}; authorized ${t.createdAt} (${t.ageDays} day(s) ago)`);
    }
    for (const h of t.hints) lines.push(`  hint: ${h}`);
  }
  if (r.serviceAccount) {
    const sa = r.serviceAccount;
    lines.push(
      `Service account: ${
        sa.source === 'adc'
          ? `Application Default Credentials (${sa.adcOrigin === 'metadata_server' ? 'no credential file; metadata server if on Google Cloud' : `${sa.keyFile}, ${sa.type ?? 'unknown type'}`}${sa.resolvedType ? `; resolved: ${sa.resolvedType}` : ''})`
          : `${sa.keyFile} (${sa.type ?? 'unknown type'}${sa.fileMode ? `, mode ${sa.fileMode}` : ''})`
      }`,
    );
    if (sa.clientEmail) lines.push(`  identity to grant read access: ${sa.clientEmail}`);
    if (sa.problem) lines.push(`  problem: ${sa.problem}`);
  }
  lines.push(
    `Network checks: ${
      r.network.fixture ? 'none (demo fixtures answered in-process)' : r.network.checked ? 'performed (free read-only calls)' : `not performed${r.network.reason ? ` - ${r.network.reason}` : ''}`
    }`,
  );
  if (r.gsc.properties) {
    lines.push('Search Console properties accessible to this identity:');
    if (!r.gsc.properties.length) lines.push('  (none)');
    for (const p of r.gsc.properties) lines.push(`  ${p.siteUrl === r.gsc.configuredProperty ? '*' : ' '} ${p.siteUrl}  [${p.permissionLevel}${p.canReadData ? '' : ', cannot read data'}]`);
  }
  lines.push(`Configured Search Console property: ${r.gsc.configuredProperty ?? '(not set)'}${r.gsc.configuredAccessible === null ? '' : r.gsc.configuredAccessible ? ' - accessible' : ' - NOT accessible'}`);
  if (r.gsc.suggestions.length) lines.push(`  did you mean: ${r.gsc.suggestions.join(', ')}`);
  if (r.gsc.problem) lines.push(`  problem: ${r.gsc.problem.message}${r.gsc.problem.hint ? `\n  next: ${r.gsc.problem.hint}` : ''}`);
  lines.push(`GA4 property: ${r.ga4.propertyId ?? '(not set)'} - access ${r.ga4.access}`);
  if (r.ga4.primaryEvent) lines.push(`  primary event ${r.ga4.primaryEvent}: session key-event rate ${r.ga4.primaryRateAvailable === null ? 'not checked' : r.ga4.primaryRateAvailable ? 'available' : 'UNAVAILABLE'}`);
  if (r.ga4.problem) lines.push(`  problem: ${r.ga4.problem.message}${r.ga4.problem.hint ? `\n  next: ${r.ga4.problem.hint}` : ''}`);
  lines.push('', 'Integration status:');
  for (const s of r.statuses) lines.push(`  ${s.id}: ${s.state} - ${s.detail}${s.nextStep ? `\n    next: ${s.nextStep}` : ''}`);
  return lines.join('\n');
}
