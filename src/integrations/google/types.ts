/**
 * Google transport contract. The auth module (src/auth) produces an
 * authorized client using the official google-auth-library (OAuth desktop
 * loopback flow or service account). Search Console and GA4 adapters use only
 * this interface so they can be tested with recorded fixtures.
 */

export const GOOGLE_SCOPES = {
  searchConsole: 'https://www.googleapis.com/auth/webmasters.readonly',
  analytics: 'https://www.googleapis.com/auth/analytics.readonly',
} as const;

export interface GoogleRequest {
  url: string;
  method?: 'GET' | 'POST';
  params?: Record<string, string | number | boolean>;
  data?: unknown;
  signal?: AbortSignal;
}

export interface GoogleResponse<T> {
  status: number;
  data: T;
  headers: Record<string, string>;
}

export interface GoogleApiClient {
  request<T>(req: GoogleRequest): Promise<GoogleResponse<T>>;
}

export interface GoogleAuthProvider {
  readonly mode: 'oauth' | 'service_account' | 'fixture';
  /** Returns an authorized client or throws CredentialsMissingError / PERMISSION_DENIED. */
  getClient(): Promise<GoogleApiClient>;
}
