import type { FetchLike } from '../types.js';
import { GoogleApiError, googleErrorFromResponse, googleErrorFromUnknown, type GoogleApiName } from './errors.js';
import type { GoogleApiClient, GoogleRequest, GoogleResponse } from './types.js';

/**
 * Authorized Google HTTP client built on the injected FetchLike (never the
 * global fetch), so demo/offline mode and tests control all network access.
 * Credentials come from google-auth-library clients (OAuth2Client, JWT,
 * GoogleAuth/ADC) via `getRequestHeaders`, which refreshes tokens as needed.
 */

export interface AuthHeaderSource {
  getRequestHeaders(url: string): Promise<Headers | Record<string, string>>;
  /** Drop the cached access token after a 401 so the next call refreshes. Returns false when a refresh is impossible. */
  invalidate?(): Promise<boolean> | boolean;
}

/** Hosts that may receive Google bearer tokens. Anything else is refused. */
export const GOOGLE_API_HOSTS: ReadonlySet<string> = new Set([
  'searchconsole.googleapis.com',
  'www.googleapis.com',
  'analyticsdata.googleapis.com',
]);

export function apiNameForUrl(url: string): GoogleApiName {
  if (url.includes('analyticsdata.googleapis.com')) return 'ga4';
  if (url.includes('/urlInspection/')) return 'url_inspection';
  return 'gsc';
}

export function buildUrl(req: Pick<GoogleRequest, 'url' | 'params'>): string {
  const u = new URL(req.url);
  for (const [k, v] of Object.entries(req.params ?? {})) u.searchParams.set(k, String(v));
  return u.toString();
}

export class AuthorizedGoogleApiClient implements GoogleApiClient {
  constructor(
    private readonly source: AuthHeaderSource,
    private readonly fetchImpl: FetchLike,
    private readonly opts: { timeoutMs?: number } = {},
  ) {}

  async request<T>(req: GoogleRequest): Promise<GoogleResponse<T>> {
    const url = buildUrl(req);
    const host = new URL(url).hostname;
    const api = apiNameForUrl(url);
    if (new URL(url).protocol !== 'https:' || !GOOGLE_API_HOSTS.has(host)) {
      throw new GoogleApiError({ api, status: 0, kind: 'invalid_argument', message: `Refusing to send Google credentials to a non-Google host (${host})` });
    }
    return this.send<T>(req, url, api, false);
  }

  private async send<T>(req: GoogleRequest, url: string, api: GoogleApiName, retried: boolean): Promise<GoogleResponse<T>> {
    let authHeaders: Headers | Record<string, string>;
    try {
      authHeaders = await this.source.getRequestHeaders(url);
    } catch (err) {
      throw googleErrorFromUnknown(api, err);
    }
    const headers = new Headers(authHeaders);
    headers.set('accept', 'application/json');
    const method = req.method ?? (req.data === undefined ? 'GET' : 'POST');
    if (req.data !== undefined) headers.set('content-type', 'application/json');
    const signals = [req.signal, this.opts.timeoutMs ? AbortSignal.timeout(this.opts.timeoutMs) : undefined].filter((s): s is AbortSignal => !!s);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        ...(req.data !== undefined ? { body: JSON.stringify(req.data) } : {}),
        ...(signals.length ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}),
      });
    } catch (err) {
      throw googleErrorFromUnknown(api, err);
    }
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k !== 'set-cookie') outHeaders[k] = v;
    });
    if (res.status === 401 && !retried && this.source.invalidate) {
      const canRetry = await this.source.invalidate();
      if (canRetry) return this.send<T>(req, url, api, true);
    }
    if (!res.ok) throw googleErrorFromResponse(api, res.status, data, res.headers);
    return { status: res.status, data: data as T, headers: outHeaders };
  }
}
