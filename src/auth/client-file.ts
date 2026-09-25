import { existsSync, readFileSync } from 'node:fs';
import { AppError, CredentialsMissingError } from '../core/errors.js';
import { registerSecret } from '../security/redact.js';

/**
 * OAuth client file (downloaded from Google Auth Platform > Clients). Only a
 * "Desktop app" client is accepted: its JSON has a top-level "installed" key.
 * (The top-level key was not verified in primary docs, see
 * docs/integration-contracts.md section 4; the check fails closed with a clear
 * message.) A "web" client is rejected because the loopback flow needs a
 * Desktop client.
 */

export interface OAuthClientInfo {
  clientId: string;
  clientSecret: string | null;
  projectId: string | null;
  type: 'installed';
}

export function loadOAuthClientFile(file: string): OAuthClientInfo {
  if (!existsSync(file)) {
    throw new CredentialsMissingError(
      'google_auth',
      ['OAuth client file'],
      `Create a "Desktop app" OAuth client in Google Auth Platform > Clients, download its JSON, and save it as ${file} (chmod 600), or set GOOGLE_OAUTH_CLIENT_FILE. See docs/modules/google.md.`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new AppError('CONFIG_INVALID', `OAuth client file ${file} is not valid JSON.`, { hint: 'Download the client JSON again from Google Auth Platform > Clients.' });
  }
  return parseOAuthClientJson(json, file);
}

export function parseOAuthClientJson(json: unknown, source = 'OAuth client JSON'): OAuthClientInfo {
  const obj = (json ?? {}) as Record<string, unknown>;
  if (obj.web && !obj.installed) {
    throw new AppError('CONFIG_INVALID', `${source} is a "Web application" client. The local loopback flow needs a "Desktop app" client.`, {
      hint: 'In Google Auth Platform > Clients, create a client with application type "Desktop app" and download its JSON.',
    });
  }
  if (obj.type === 'service_account') {
    throw new AppError('CONFIG_INVALID', `${source} is a service-account key, not an OAuth client.`, {
      hint: 'For service-account mode set GOOGLE_AUTH_MODE=service_account and GOOGLE_APPLICATION_CREDENTIALS to the key file instead.',
    });
  }
  const inst = obj.installed as Record<string, unknown> | undefined;
  if (!inst || typeof inst !== 'object') {
    throw new AppError('CONFIG_INVALID', `${source} does not contain an "installed" (Desktop app) client.`, {
      hint: 'Download the JSON of a "Desktop app" OAuth client from Google Auth Platform > Clients.',
    });
  }
  const clientId = typeof inst.client_id === 'string' ? inst.client_id.trim() : '';
  if (!clientId) throw new AppError('CONFIG_INVALID', `${source} has no client_id.`);
  const clientSecret = typeof inst.client_secret === 'string' && inst.client_secret ? inst.client_secret : null;
  registerSecret(clientSecret);
  return { clientId, clientSecret, projectId: typeof inst.project_id === 'string' ? inst.project_id : null, type: 'installed' };
}

/** Show enough of a client ID to recognise it, never the whole value. */
export function maskClientId(clientId: string): string {
  const [head] = clientId.split('.');
  const h = head ?? clientId;
  return h.length <= 8 ? `${h.slice(0, 2)}...` : `${h.slice(0, 6)}...${h.slice(-4)}`;
}
