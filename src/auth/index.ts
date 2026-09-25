/**
 * Google authentication: OAuth desktop loopback flow (PKCE + state), token
 * storage, service accounts / ADC, status, revocation, and diagnostics.
 */
export { runDesktopOAuthFlow, buildAuthorizationUrl, createOAuth2Client, REQUIRED_SCOPES, type DesktopFlowResult } from './oauth-flow.js';
export { startLoopbackServer, LOOPBACK_HOST, type LoopbackServer } from './loopback.js';
export { TokenStore, type StoredGoogleToken, type TokenSummary } from './token-store.js';
export { loadOAuthClientFile, parseOAuthClientJson } from './client-file.js';
export { googleCredentialPaths, type GoogleCredentialPaths } from './paths.js';
export {
  createGoogleAuthProvider,
  resolveGoogleAuthMode,
  OAuthGoogleAuthProvider,
  ServiceAccountGoogleAuthProvider,
  inspectServiceAccountFile,
  inspectAdc,
  resolveAdcClient,
  tokenStoreFor,
  credentialPathsFor,
} from './providers.js';
export { authStatus, renderAuthStatus, type AuthStatusReport } from './status.js';
export { diagnoseGoogle, renderDiagnose, LEAST_PRIVILEGE_GUIDANCE, type DiagnoseReport, type DiagnosticFinding } from './diagnose.js';
export { revokeGoogleAuthorization, type RevokeResult } from './revoke.js';
