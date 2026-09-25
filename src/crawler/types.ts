/**
 * Shared crawler types. `BlockedReason` mirrors the CHECK constraint on
 * crawl_results.blocked_reason (migrations/0003_pages_crawl.sql).
 */

export const BLOCKED_REASONS = [
  'robots',
  'login_required',
  'access_denied',
  'unsafe_url',
  'too_large',
  'unsupported_content',
  'rate_limited',
  'timeout',
  'network_error',
  'excluded',
  'budget',
  'crawl_trap',
] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

/** Content kinds the fetcher may accept. Anything else is refused before reading the body. */
export type ContentKind = 'html' | 'xml' | 'robots';

export interface RedirectHop {
  url: string;
  status: number;
  location: string;
}

export interface SafeFetchResult {
  requestedUrl: string;
  /** Last URL requested (after redirects). Null when nothing was requested. */
  finalUrl: string | null;
  /** Status of the last response received (a 3xx when redirects were not followed to the end). */
  status: number | null;
  /** Status of the very first response (e.g. 301 for a redirecting URL). */
  firstStatus: number | null;
  redirectChain: RedirectHop[];
  contentType: string | null;
  /** Relevant response headers, lower-cased and redacted (never cookies). */
  headers: Record<string, string>;
  /** Raw body bytes (2xx accepted responses only). */
  body: Uint8Array | null;
  /** Decoded text for html/robots/xml (null for gzip payloads and when not read). */
  text: string | null;
  bytes: number | null;
  blockedReason: BlockedReason | null;
  /** Machine-readable error, e.g. 'redirect_loop', 'too_many_redirects', 'unsafe_url:dns_blocked_ip'. */
  errorCode: string | null;
  error: string | null;
  /** Parsed Retry-After in ms for 429/503 responses. */
  retryAfterMs: number | null;
  durationMs: number;
  /** True when the connection was pinned to validated addresses (undici transport). */
  pinned: boolean;
  /** Whether the response came from a fixture transport (synthetic data). */
  fixture: boolean;
  /** Number of attempts including rate-limit retries. */
  attempts: number;
  /** A human-readable note when a hop hook stopped the fetch. */
  note: string | null;
}

export interface CrawlCounts {
  attempted: number;
  fetched: number;
  blocked: number;
  failed: number;
  skipped: number;
}
