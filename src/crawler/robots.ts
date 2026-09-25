import robotsParserModule from 'robots-parser';
import type { SafeFetcher } from './fetch.js';

/**
 * robots.txt handling (robots-parser). Semantics follow Google's documented
 * behaviour for robots.txt fetch outcomes, applied conservatively:
 *   2xx            -> parse the rules
 *   4xx (not 429)  -> no robots.txt: crawling allowed
 *   429, 5xx, timeout, network error, DNS failure, oversize -> treat the
 *                     origin as fully disallowed for this crawl (never guess
 *                     "allowed"); state 'unreachable' (transient)
 *   unsafe URL     -> nothing is fetched from that origin at all (SSRF policy;
 *                     a DNS failure is NOT an unsafe URL: it is transient)
 * The robots.txt URL itself is always fetchable. Crawl-delay is honoured as a
 * minimum per-host delay (capped at 60 s).
 */

interface RobotsParserInstance {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getMatchingLineNumber(url: string, ua?: string): number;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
}

// robots-parser is CommonJS; under NodeNext the default import is module.exports.
const robotsParser = ((robotsParserModule as unknown as { default?: unknown }).default ?? robotsParserModule) as (url: string, contents: string) => RobotsParserInstance;

export const ROBOTS_MAX_BYTES = 512_000;
export const MAX_CRAWL_DELAY_MS = 60_000;

export type RobotsState = 'parsed' | 'not_found' | 'unreachable' | 'unsafe' | 'not_fetched';

export interface RobotsInfo {
  origin: string;
  robotsUrl: string;
  state: RobotsState;
  httpStatus: number | null;
  allowAll: boolean;
  disallowAll: boolean;
  sitemaps: string[];
  crawlDelayMs: number | null;
  note: string;
  bytes: number | null;
  fetchedAt: string;
  /** Raw robots.txt text (bounded) for the raw store; never executed. */
  text: string | null;
  /**
   * Machine-readable fetch error behind an 'unreachable' or 'unsafe' state
   * (e.g. 'unsafe_url:dns_failure', 'network_error', 'timeout',
   * 'unsafe_url:blocked_ip'); null/absent when robots.txt was answered.
   */
  errorCode?: string | null;
}

/** Fetch error codes of a robots.txt check that are transient network problems (retry later), not policy blocks. */
export const TRANSIENT_ROBOTS_ERROR_CODES: ReadonlySet<string> = new Set(['unsafe_url:dns_failure', 'network_error', 'timeout']);

/** True when robots.txt could not be fetched because of a transient network/DNS problem (not an HTTP answer, not an SSRF refusal). */
export function isTransientRobotsFailure(info: Pick<RobotsInfo, 'state' | 'errorCode'>): boolean {
  return info.state === 'unreachable' && !!info.errorCode && TRANSIENT_ROBOTS_ERROR_CODES.has(info.errorCode);
}

export interface RobotsDecision {
  allowed: boolean;
  /** 1-based matching line in robots.txt, when a rule matched. */
  line: number | null;
  reason: string;
}

/** The product token robots.txt groups are matched against, e.g. "seo-agent" for "seo-agent/0.1 (...)". */
export function userAgentToken(userAgent: string): string {
  return (userAgent.trim().split(/[\/\s]/)[0] || '*').toLowerCase();
}

export function originOf(url: string | URL): string {
  const u = typeof url === 'string' ? new URL(url) : url;
  return `${u.protocol}//${u.host}`;
}

/** Build RobotsInfo from already-fetched robots.txt text (pure; used by tests and fixtures). */
export function parseRobots(origin: string, text: string, userAgent: string, fetchedAt = new Date().toISOString(), httpStatus: number | null = 200): RobotsInfo & { parser: RobotsParserInstance } {
  const robotsUrl = `${origin}/robots.txt`;
  const parser = robotsParser(robotsUrl, text);
  const token = userAgentToken(userAgent);
  const delay = parser.getCrawlDelay(token);
  return {
    origin,
    robotsUrl,
    state: 'parsed',
    httpStatus,
    allowAll: false,
    disallowAll: false,
    sitemaps: [...new Set(parser.getSitemaps())],
    crawlDelayMs: typeof delay === 'number' && Number.isFinite(delay) && delay > 0 ? Math.min(MAX_CRAWL_DELAY_MS, Math.round(delay * 1000)) : null,
    note: 'robots.txt parsed',
    bytes: text.length,
    fetchedAt,
    text: text.slice(0, ROBOTS_MAX_BYTES),
    parser,
  };
}

export class RobotsPolicy {
  constructor(
    readonly info: RobotsInfo,
    private readonly parser: RobotsParserInstance | null,
    private readonly token: string,
  ) {}

  isAllowed(url: string | URL): RobotsDecision {
    const u = typeof url === 'string' ? new URL(url) : url;
    if (u.pathname === '/robots.txt') return { allowed: true, line: null, reason: 'robots.txt itself is always fetchable' };
    if (originOf(u) !== this.info.origin) return { allowed: false, line: null, reason: `robots.txt for ${this.info.origin} does not cover ${originOf(u)}` };
    if (this.info.disallowAll) return { allowed: false, line: null, reason: this.info.note };
    if (this.info.allowAll || !this.parser) return { allowed: true, line: null, reason: this.info.note };
    const allowed = this.parser.isAllowed(u.toString(), this.token);
    const line = this.parser.getMatchingLineNumber(u.toString(), this.token);
    if (allowed === undefined) return { allowed: false, line: null, reason: 'URL not covered by this robots.txt' };
    return {
      allowed,
      line: typeof line === 'number' && line > 0 ? line : null,
      reason: allowed ? 'allowed by robots.txt' : `disallowed by robots.txt${typeof line === 'number' && line > 0 ? ` (line ${line})` : ''} for user-agent token "${this.token}"`,
    };
  }
}

function stateInfo(origin: string, state: RobotsState, note: string, extra: Partial<RobotsInfo> = {}): RobotsInfo {
  return {
    origin,
    robotsUrl: `${origin}/robots.txt`,
    state,
    httpStatus: null,
    allowAll: state === 'not_found',
    disallowAll: state === 'unreachable' || state === 'unsafe' || state === 'not_fetched',
    sitemaps: [],
    crawlDelayMs: null,
    note,
    bytes: null,
    fetchedAt: new Date().toISOString(),
    text: null,
    ...extra,
  };
}

/** Fetch and interpret robots.txt for one origin through the SSRF-safe fetcher. */
export async function fetchRobots(fetcher: SafeFetcher, origin: string, opts: { signal?: AbortSignal; now?: () => Date } = {}): Promise<RobotsPolicy> {
  const token = userAgentToken(fetcher.userAgent);
  const at = (opts.now?.() ?? new Date()).toISOString();
  const robotsUrl = `${origin}/robots.txt`;
  const r = await fetcher.fetch(robotsUrl, { accept: ['robots'], ...(opts.signal ? { signal: opts.signal } : {}) });
  const base = { httpStatus: r.status, fetchedAt: at, bytes: r.bytes, errorCode: r.errorCode };
  if (r.blockedReason === 'unsafe_url' && r.errorCode === 'unsafe_url:dns_failure') {
    // DNS resolution failed (resolver error, timeout, empty answer): a transient network problem, not an SSRF refusal.
    return new RobotsPolicy(stateInfo(origin, 'unreachable', `robots.txt unreachable (${r.error ?? 'DNS resolution failed'}; transient network/DNS problem): treating the origin as disallowed for this crawl`, base), null, token);
  }
  if (r.blockedReason === 'unsafe_url') {
    return new RobotsPolicy(stateInfo(origin, 'unsafe', `robots.txt not fetched: ${r.error ?? 'unsafe destination'}`, base), null, token);
  }
  if (r.status !== null && r.status >= 200 && r.status < 300 && r.text !== null && !r.blockedReason) {
    const parsed = parseRobots(origin, r.text, fetcher.userAgent, at, r.status);
    const { parser, ...info } = parsed;
    return new RobotsPolicy({ ...info, bytes: r.bytes }, parser, token);
  }
  if (r.status !== null && r.status >= 400 && r.status < 500 && r.status !== 429) {
    return new RobotsPolicy(stateInfo(origin, 'not_found', `robots.txt returned HTTP ${r.status}: treated as no restrictions (documented crawler behaviour)`, base), null, token);
  }
  if (r.blockedReason === 'too_large') {
    return new RobotsPolicy(stateInfo(origin, 'unreachable', `robots.txt exceeded the size limit; treating the origin as disallowed for this crawl`, base), null, token);
  }
  if (r.blockedReason === 'unsupported_content') {
    return new RobotsPolicy(stateInfo(origin, 'unreachable', `robots.txt has an unexpected content type (${r.contentType ?? 'none'}); treating the origin as disallowed for this crawl`, base), null, token);
  }
  const why = r.status !== null ? `HTTP ${r.status}` : (r.errorCode ?? r.blockedReason ?? 'unknown error');
  return new RobotsPolicy(stateInfo(origin, 'unreachable', `robots.txt unreachable (${why}): treating the origin as disallowed for this crawl`, base), null, token);
}

/** Per-crawl memoized robots policies (one fetch per origin). */
export class RobotsCache {
  private readonly cache = new Map<string, Promise<RobotsPolicy>>();
  constructor(
    private readonly fetcher: SafeFetcher,
    private readonly opts: { signal?: AbortSignal; now?: () => Date; onFetched?: (p: RobotsPolicy) => void } = {},
  ) {}

  get(origin: string): Promise<RobotsPolicy> {
    let p = this.cache.get(origin);
    if (!p) {
      p = fetchRobots(this.fetcher, origin, this.opts).then((policy) => {
        if (policy.info.crawlDelayMs) this.fetcher.setHostDelay(new URL(origin).host, policy.info.crawlDelayMs);
        this.opts.onFetched?.(policy);
        return policy;
      });
      this.cache.set(origin, p);
    }
    return p;
  }

  async isAllowed(url: string | URL): Promise<RobotsDecision> {
    const u = typeof url === 'string' ? new URL(url) : url;
    return (await this.get(originOf(u))).isAllowed(u);
  }

  policies(): Promise<RobotsPolicy[]> {
    return Promise.all([...this.cache.values()]);
  }
}
