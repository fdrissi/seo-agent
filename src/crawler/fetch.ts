import { KeyedLimiter, sleep as defaultSleep } from '../core/concurrency.js';
import { parseRetryAfter } from '../core/retry.js';
import { redactHeaders, redactString } from '../security/redact.js';
import { isUnsafeUrlError, type SsrfGuard } from '../security/ssrf.js';
import type { HttpTransport, TransportResponse } from './transport.js';
import type { BlockedReason, ContentKind, RedirectHop, SafeFetchResult } from './types.js';

/**
 * SSRF-safe HTTP GET with:
 * - guard validation (scheme, host, DNS, IP ranges, port) of EVERY hop,
 * - manual redirect handling with a maximum and full chain recording,
 *   loop detection, and a stop at redirects to login pages,
 * - a content-type allowlist checked before the body is read,
 * - a byte cap enforced while streaming (the body is abandoned when exceeded),
 * - one overall timeout covering all hops and the body,
 * - honest block reasons for login barriers (401/407), access denials
 *   (403/451, bot challenges), and rate limits (429, 503 + Retry-After).
 *
 * It never retries on its own and never tries to defeat a protection.
 * `SafeFetcher` adds per-host concurrency, politeness delays, and bounded
 * Retry-After handling on top: every rate-limited outcome pushes the host's
 * next request back, and a Retry-After longer than `maxRetryAfterMs` puts the
 * host in a back-off during which NO request is sent (callers get an honest
 * `rate_limited` result with `attempts: 0`).
 */

export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

const CONTENT_TYPES: Record<ContentKind, readonly string[]> = {
  html: ['text/html', 'application/xhtml+xml'],
  xml: ['application/xml', 'text/xml', 'application/rss+xml', 'application/atom+xml', 'application/gzip', 'application/x-gzip', 'application/x-xml'],
  robots: ['text/plain'],
};

const ACCEPT_HEADER: Record<ContentKind, string> = {
  html: 'text/html,application/xhtml+xml;q=0.9',
  xml: 'application/xml,text/xml;q=0.9,application/gzip;q=0.5',
  robots: 'text/plain',
};

/** Response headers worth persisting (redacted). Cookies are never stored. */
export const RELEVANT_HEADERS: readonly string[] = [
  'content-type',
  'content-length',
  'content-language',
  'content-encoding',
  'last-modified',
  'etag',
  'cache-control',
  'expires',
  'x-robots-tag',
  'link',
  'location',
  'retry-after',
  'vary',
  'server',
  'age',
  'www-authenticate',
  'cf-mitigated',
];

const LOGIN_PATH_RE = /(^|\/)(log-?in|sign-?in|signin|logon|auth|authenticate|authorize|sso|session\/new|wp-login\.php|users?\/sign_in|account\/login|oauth2?\/authorize|saml)(\/|$|\.|\?)/i;
const LOGIN_HOST_RE = /^(login|signin|accounts|auth|sso|idp|id)\./i;

/** True when a URL looks like a login/authentication endpoint. */
export function isLoginUrl(url: URL): boolean {
  return LOGIN_PATH_RE.test(url.pathname) || LOGIN_HOST_RE.test(url.hostname);
}

export type HopDecision = { stop: true; blockedReason: BlockedReason | null; note: string; errorCode?: string } | null;

export interface FetchSafelyOptions {
  guard: SsrfGuard;
  transport: HttpTransport;
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  accept: readonly ContentKind[];
  signal?: AbortSignal;
  /** Called before each hop (0 = the requested URL). Return a decision to stop (robots, off-site redirect, ...). */
  beforeHop?: (url: URL, hop: number) => HopDecision | Promise<HopDecision>;
  now?: () => number;
}

function baseMime(contentType: string | null): string | null {
  if (!contentType) return null;
  return contentType.split(';')[0]!.trim().toLowerCase() || null;
}

function charsetOf(contentType: string | null): string | null {
  const m = contentType ? /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType) : null;
  return m ? m[1]!.toLowerCase() : null;
}

export function acceptsContentType(contentType: string | null, kinds: readonly ContentKind[]): boolean {
  const mime = baseMime(contentType);
  // Missing Content-Type: robots.txt/sitemaps are often served without one; HTML is sniffed after a bounded read.
  if (!mime) return true;
  for (const k of kinds) {
    if (CONTENT_TYPES[k].includes(mime)) return true;
    if (k === 'xml' && mime.endsWith('+xml')) return true;
    if (k === 'robots' && mime.startsWith('text/')) return true; // robots.txt is plain text; some hosts mislabel it
  }
  return false;
}

/** Decode bytes using the declared charset, a sniffed <meta charset>, or UTF-8. */
export function decodeBody(bytes: Uint8Array, contentType: string | null, sniffHtml: boolean): string {
  let label = charsetOf(contentType);
  if (!label && sniffHtml) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
    const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
    if (m) label = m[1]!.toLowerCase();
  }
  try {
    return new TextDecoder(label ?? 'utf-8', { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

export function relevantHeaders(headers: Headers): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of RELEVANT_HEADERS) {
    const v = headers.get(name);
    if (v !== null) picked[name] = v.length > 2_000 ? `${v.slice(0, 2_000)}...` : v;
  }
  return redactHeaders(picked);
}

function looksLikeMarkup(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml') || head.startsWith('<head') || head.startsWith('<body') || head.startsWith('<!--');
}

async function readBounded(res: TransportResponse, maxBytes: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; read: number }> {
  if (!res.body) return { ok: true, bytes: new Uint8Array() };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > maxBytes) return { ok: false, read: total }; // leaving the loop cancels the stream
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, bytes: out };
}

function emptyResult(requestedUrl: string, started: number, now: () => number, transport: HttpTransport): SafeFetchResult {
  return {
    requestedUrl,
    finalUrl: null,
    status: null,
    firstStatus: null,
    redirectChain: [],
    contentType: null,
    headers: {},
    body: null,
    text: null,
    bytes: null,
    blockedReason: null,
    errorCode: null,
    error: null,
    retryAfterMs: null,
    durationMs: Math.max(0, now() - started),
    pinned: transport.kind === 'pinned',
    fixture: transport.kind === 'fixture',
    attempts: 1,
    note: null,
  };
}

/** One SSRF-safe GET (no retries). See module doc. */
export async function fetchSafely(requestedUrl: string, opts: FetchSafelyOptions): Promise<SafeFetchResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const result = emptyResult(requestedUrl, started, now, opts.transport);
  const finish = (): SafeFetchResult => {
    result.durationMs = Math.max(0, now() - started);
    if (result.error) result.error = redactString(result.error);
    return result;
  };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`timed out after ${opts.timeoutMs}ms`));
  }, opts.timeoutMs);
  const onOuterAbort = () => controller.abort(opts.signal?.reason ?? new Error('aborted'));
  if (opts.signal?.aborted) onOuterAbort();
  else opts.signal?.addEventListener('abort', onOuterAbort, { once: true });

  const accept = opts.accept.map((k) => ACCEPT_HEADER[k]).join(',');
  const visited = new Set<string>();
  let current = requestedUrl;
  let open: TransportResponse | null = null;

  try {
    for (let hop = 0; ; hop++) {
      const refuse = (err: { reason: string; message: string }): SafeFetchResult => {
        result.finalUrl = current;
        result.blockedReason = 'unsafe_url';
        result.errorCode = `unsafe_url:${err.reason}`;
        // A DNS failure is transient (errorCode unsafe_url:dns_failure), not a refusal: say so for redirect hops too.
        result.error = hop === 0 ? err.message : err.reason === 'dns_failure' ? `Redirect target did not resolve (transient DNS problem): ${err.message}` : `Redirect to a refused destination: ${err.message}`;
        return finish();
      };
      // 1. Static SSRF checks for this hop (scheme, credentials, host names, IP literals, port).
      let staticUrl: URL;
      try {
        staticUrl = opts.guard.checkStatic(current).url;
      } catch (err) {
        if (isUnsafeUrlError(err)) return refuse(err);
        throw err;
      }
      result.finalUrl = staticUrl.toString();

      // 2. Caller policy for this hop (robots, off-site redirects, ...), before any DNS lookup.
      const decision = opts.beforeHop ? await opts.beforeHop(staticUrl, hop) : null;
      if (decision) {
        result.blockedReason = decision.blockedReason;
        result.note = decision.note;
        if (decision.errorCode) result.errorCode = decision.errorCode;
        return finish();
      }

      // 3. Full validation: resolve DNS and classify every answer; the transport pins to these addresses.
      const check = await opts.guard.check(current);
      if (!check.ok) return refuse(check.error);
      const target = check.target;
      const urlStr = target.url.toString();
      visited.add(urlStr);
      result.finalUrl = urlStr;

      // 4. Request.
      open = await opts.transport.send(target, {
        method: 'GET',
        headers: { 'user-agent': opts.userAgent, accept, 'accept-language': '*' },
        signal: controller.signal,
      });
      const status = open.status;
      result.status = status;
      if (result.firstStatus === null) result.firstStatus = status;
      result.headers = relevantHeaders(open.headers);
      result.contentType = open.headers.get('content-type');

      // 5. Redirects: record, validate next hop on the next loop iteration.
      const location = open.headers.get('location');
      if (REDIRECT_STATUSES.has(status) && location) {
        await open.close();
        open = null;
        let next: URL;
        try {
          next = new URL(location, urlStr);
        } catch {
          result.errorCode = 'invalid_redirect';
          result.error = `Invalid redirect Location header: ${location.slice(0, 200)}`;
          return finish();
        }
        next.hash = '';
        result.redirectChain.push({ url: urlStr, status, location: next.toString() });
        if (visited.has(next.toString())) {
          result.errorCode = 'redirect_loop';
          result.error = `Redirect loop detected at ${next.toString()}`;
          return finish();
        }
        if (result.redirectChain.length > opts.maxRedirects) {
          result.errorCode = 'too_many_redirects';
          result.error = `More than ${opts.maxRedirects} redirects`;
          return finish();
        }
        if (isLoginUrl(next)) {
          result.finalUrl = next.toString();
          result.blockedReason = 'login_required';
          result.note = 'Redirected to a login page; stopped without following it.';
          return finish();
        }
        current = next.toString();
        continue;
      }

      // 6. Final response.
      if (status === 401 || status === 407) {
        result.blockedReason = 'login_required';
        result.note = `HTTP ${status}: authentication required; not attempted.`;
        return finish();
      }
      if (status === 403 || status === 451) {
        result.blockedReason = 'access_denied';
        const challenge = open.headers.get('cf-mitigated');
        result.note = challenge ? `HTTP ${status} with a bot-protection challenge (${challenge}); not attempted.` : `HTTP ${status}: access denied; not attempted.`;
        return finish();
      }
      if (status === 429 || status === 503) {
        const ra = parseRetryAfter(open.headers.get('retry-after'), new Date(now()));
        result.retryAfterMs = ra ?? null;
        if (status === 429 || ra !== undefined) {
          result.blockedReason = 'rate_limited';
          result.note = `HTTP ${status}${ra !== undefined ? ` (Retry-After ${Math.round(ra / 1000)}s)` : ''}`;
        }
        return finish();
      }
      if (status < 200 || status >= 300) return finish();

      if (!acceptsContentType(result.contentType, opts.accept)) {
        result.blockedReason = 'unsupported_content';
        result.note = `Content-Type ${baseMime(result.contentType) ?? '(none)'} is not in the allowlist (${opts.accept.join(', ')}).`;
        return finish();
      }
      const declared = Number(open.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        result.blockedReason = 'too_large';
        result.bytes = declared;
        result.note = `Content-Length ${declared} exceeds the ${opts.maxBytes}-byte limit; body not read.`;
        return finish();
      }
      const read = await readBounded(open, opts.maxBytes);
      if (!read.ok) {
        result.blockedReason = 'too_large';
        result.bytes = read.read;
        result.note = `Body exceeded the ${opts.maxBytes}-byte limit while streaming; download abandoned.`;
        return finish();
      }
      result.body = read.bytes;
      result.bytes = read.bytes.byteLength;
      const isGzip = read.bytes[0] === 0x1f && read.bytes[1] === 0x8b;
      if (!baseMime(result.contentType) && opts.accept.includes('html') && !opts.accept.includes('robots') && !opts.accept.includes('xml') && !looksLikeMarkup(read.bytes)) {
        result.blockedReason = 'unsupported_content';
        result.note = 'No Content-Type and the body does not look like HTML.';
        result.body = null;
        return finish();
      }
      if (!isGzip) result.text = decodeBody(read.bytes, result.contentType, opts.accept.includes('html'));
      return finish();
    }
  } catch (err) {
    if (isUnsafeUrlError(err)) {
      result.blockedReason = 'unsafe_url';
      result.errorCode = `unsafe_url:${err.reason}`;
      result.error = err.message;
    } else if (timedOut) {
      result.blockedReason = 'timeout';
      result.errorCode = 'timeout';
      result.error = `Timed out after ${opts.timeoutMs}ms`;
    } else if (opts.signal?.aborted) {
      result.errorCode = 'cancelled';
      result.error = 'Cancelled';
    } else {
      result.blockedReason = 'network_error';
      result.errorCode = 'network_error';
      const e = err as Error & { cause?: { code?: string; message?: string } };
      result.error = `${e.message ?? String(err)}${e.cause?.code ? ` (${e.cause.code})` : e.cause?.message ? ` (${e.cause.message})` : ''}`;
    }
    return finish();
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
    if (open) await open.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Polite, per-host scheduled fetcher
// ---------------------------------------------------------------------------

export interface SafeFetcherOptions {
  guard: SsrfGuard;
  transport: HttpTransport;
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  perHostConcurrency: number;
  /** Minimum delay between request starts to the same host. */
  delayMs: number;
  /** Retries after 429/503 (bounded). Default 2. */
  maxRateLimitRetries?: number;
  /** Longest Retry-After the fetcher will honor by waiting; longer means give up. Default 60s. */
  maxRetryAfterMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface FetchRequestOptions {
  accept: readonly ContentKind[];
  beforeHop?: FetchSafelyOptions['beforeHop'];
  signal?: AbortSignal;
}

function hostKey(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '(invalid)';
  }
}

export class SafeFetcher {
  readonly guard: SsrfGuard;
  readonly transport: HttpTransport;
  readonly userAgent: string;
  readonly opts: Required<Omit<SafeFetcherOptions, 'guard' | 'transport' | 'sleep' | 'now'>>;
  private readonly limiter: KeyedLimiter;
  private readonly nextAt = new Map<string, number>();
  private readonly hostDelay = new Map<string, number>();
  private readonly rateLimitStreak = new Map<string, number>();
  private readonly backoffUntil = new Map<string, { until: number; note: string }>();
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  /** Delays actually waited (ms), for transparency and tests. */
  readonly waits: Array<{ host: string; ms: number; reason: 'politeness' | 'retry_after' | 'backoff' }> = [];

  constructor(opts: SafeFetcherOptions) {
    this.guard = opts.guard;
    this.transport = opts.transport;
    this.userAgent = opts.userAgent;
    this.opts = {
      userAgent: opts.userAgent,
      timeoutMs: opts.timeoutMs,
      maxBytes: opts.maxBytes,
      maxRedirects: opts.maxRedirects,
      perHostConcurrency: opts.perHostConcurrency,
      delayMs: opts.delayMs,
      maxRateLimitRetries: opts.maxRateLimitRetries ?? 2,
      maxRetryAfterMs: opts.maxRetryAfterMs ?? 60_000,
    };
    this.limiter = new KeyedLimiter(() => Math.max(1, opts.perHostConcurrency));
    this.sleepFn = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
  }

  /** Raise the politeness delay for a host (e.g. robots.txt Crawl-delay). Never lowers the configured delay. */
  setHostDelay(host: string, ms: number): void {
    this.hostDelay.set(host.toLowerCase(), Math.max(this.opts.delayMs, ms));
  }

  delayFor(host: string): number {
    return this.hostDelay.get(host.toLowerCase()) ?? this.opts.delayMs;
  }

  /** Consecutive rate-limited responses for a host (reset by any other outcome). */
  rateLimitedStreak(host: string): number {
    return this.rateLimitStreak.get(host.toLowerCase()) ?? 0;
  }

  private async waitTurn(host: string, signal?: AbortSignal): Promise<void> {
    const now = this.now();
    const start = Math.max(now, this.nextAt.get(host) ?? 0);
    this.nextAt.set(host, start + this.delayFor(host));
    const wait = start - now;
    if (wait > 0) {
      this.waits.push({ host, ms: wait, reason: 'politeness' });
      await this.sleepFn(wait, signal);
    }
  }

  private pushBack(host: string, ms: number, reason: 'retry_after' | 'backoff'): void {
    const until = this.now() + ms;
    this.nextAt.set(host, Math.max(this.nextAt.get(host) ?? 0, until));
    this.waits.push({ host, ms, reason });
  }

  /**
   * When a host asked us to back off for longer than we are willing to wait
   * (Retry-After above `maxRetryAfterMs`), no further request is sent to it
   * until that time has passed. Returns the active back-off, or null.
   */
  hostBackoff(host: string): { until: number; note: string } | null {
    const key = host.toLowerCase();
    const b = this.backoffUntil.get(key);
    if (!b) return null;
    if (this.now() >= b.until) {
      this.backoffUntil.delete(key);
      return null;
    }
    return b;
  }

  /** Hosts currently in a long back-off (for transparency and tests). */
  backoffHosts(): Array<{ host: string; until: number; note: string }> {
    return [...this.backoffUntil.entries()].filter(([, b]) => this.now() < b.until).map(([host, b]) => ({ host, ...b }));
  }

  private notRequested(url: string, host: string, attempts: number, backoff: { until: number; note: string }): SafeFetchResult {
    const r = emptyResult(url, this.now(), this.now, this.transport);
    r.blockedReason = 'rate_limited';
    r.retryAfterMs = Math.max(0, backoff.until - this.now());
    r.attempts = attempts;
    r.note = `Not requested: ${host} is in a rate-limit back-off (${backoff.note}).`;
    return r;
  }

  async fetch(url: string, req: FetchRequestOptions): Promise<SafeFetchResult> {
    const host = hostKey(url);
    return this.limiter.run(
      host,
      async () => {
        for (let attempt = 1; ; attempt++) {
          // A host that asked for a long back-off gets no request at all (checked before waiting).
          const backoff = this.hostBackoff(host);
          if (backoff) return this.notRequested(url, host, attempt - 1, backoff);
          await this.waitTurn(host, req.signal);
          const r = await fetchSafely(url, {
            guard: this.guard,
            transport: this.transport,
            userAgent: this.userAgent,
            timeoutMs: this.opts.timeoutMs,
            maxBytes: this.opts.maxBytes,
            maxRedirects: this.opts.maxRedirects,
            accept: req.accept,
            ...(req.beforeHop ? { beforeHop: req.beforeHop } : {}),
            ...(req.signal ? { signal: req.signal } : {}),
            now: this.now,
          });
          r.attempts = attempt;
          const retryable = r.blockedReason === 'rate_limited' || (r.status === 503 && !r.blockedReason);
          if (!retryable) {
            this.rateLimitStreak.set(host, 0);
            return r;
          }
          const wait = r.retryAfterMs ?? 2_000 * 2 ** (attempt - 1);
          const waitReason = r.retryAfterMs !== null ? 'retry_after' : 'backoff';
          if (wait > this.opts.maxRetryAfterMs) {
            // The host asked for more than we will wait: stop sending it requests until then.
            this.rateLimitStreak.set(host, this.rateLimitedStreak(host) + 1);
            const note = `HTTP ${r.status ?? '?'} with Retry-After ${Math.round(wait / 1000)}s, above the ${Math.round(this.opts.maxRetryAfterMs / 1000)}s limit`;
            this.backoffUntil.set(host, { until: this.now() + wait, note });
            r.note = `${r.note ? `${r.note}; ` : ''}Retry-After ${Math.round(wait / 1000)}s exceeds the ${Math.round(this.opts.maxRetryAfterMs / 1000)}s limit; not retried, and no further requests go to ${host} until then`;
            return r;
          }
          // Every rate-limited outcome pushes the host's next allowed request back.
          this.pushBack(host, wait, waitReason);
          if (attempt > this.opts.maxRateLimitRetries) {
            this.rateLimitStreak.set(host, this.rateLimitedStreak(host) + 1);
            r.note = `${r.note ? `${r.note}; ` : ''}gave up after ${attempt} attempts`;
            return r;
          }
        }
      },
      req.signal,
    );
  }
}

export type { RedirectHop };
