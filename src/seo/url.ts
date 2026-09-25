/**
 * Conservative URL normalization for identity and joins.
 *
 * Normalizes only what is safe by definition: scheme/host case, default
 * ports, fragments, an empty trailing `?`, well-known tracking parameters,
 * and percent-encoding as RFC 3986 section 6.2.2.1-6.2.2.2 defines it
 * (hex digits uppercased, percent-encoded unreserved characters
 * ALPHA / DIGIT / "-" / "." / "_" / "~" decoded; reserved characters such
 * as %2F stay encoded). It PRESERVES meaningful query parameters (and their
 * order and reserved-character encoding), path case, locale paths, and
 * trailing-slash differences. It never merges www/non-www or http/https:
 * those become aliases only with recorded evidence (redirects, canonicals,
 * configuration). See src/seo/reconcile.ts.
 */

export const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'gclid',
  'gbraid',
  'wbraid',
  'dclid',
  'fbclid',
  'msclkid',
  'yclid',
  'twclid',
  'ttclid',
  'li_fat_id',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
  '_hsenc',
  '_hsmi',
  'srsltid',
]);

export function isTrackingParam(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith('utm_') || TRACKING_PARAMS.has(n);
}

export type NormalizationChange = 'host_case' | 'default_port' | 'fragment_removed' | 'tracking_params_removed' | 'scheme_case' | 'empty_query_removed' | 'percent_encoding';

const UNRESERVED_CHAR = /^[A-Za-z0-9._~-]$/;

/**
 * Percent-encoding normalization (RFC 3986 6.2.2.1-6.2.2.2): a triplet that
 * encodes an unreserved character (ALPHA / DIGIT / "-" / "." / "_" / "~") is
 * decoded, every other triplet gets uppercase hex digits. Reserved and
 * non-ASCII bytes (e.g. %2F, %3D, %26, %D0) stay encoded, and a "%" that does
 * not start a valid triplet is left as it is. Applied to a path or query
 * string (or a URL prefix whose host needs no percent-encoding).
 */
export function normalizePercentEncoding(s: string): string {
  if (!s.includes('%')) return s;
  return s.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex: string) => {
    const ch = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED_CHAR.test(ch) ? ch : `%${hex.toUpperCase()}`;
  });
}

export interface NormalizedUrl {
  /** Normalized identity URL. */
  url: string;
  host: string;
  /** Path plus meaningful query string (identity within the host). */
  pathWithQuery: string;
  path: string;
  removedParams: string[];
  changes: NormalizationChange[];
}

export function tryParseUrl(input: string, base?: string): URL | null {
  try {
    return base ? new URL(input, base) : new URL(input);
  } catch {
    return null;
  }
}

export function normalizeUrl(input: string, base?: string): NormalizedUrl | null {
  const raw = input.trim();
  const u = tryParseUrl(raw, base);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null;
  const changes: NormalizationChange[] = [];

  const rawHost = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(raw)?.[1]?.replace(/^.*@/, '') ?? '';
  const rawHostNoPort = rawHost.replace(/:\d+$/, '');
  if (rawHostNoPort && rawHostNoPort !== rawHostNoPort.toLowerCase()) changes.push('host_case');
  const rawScheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1];
  if (rawScheme && rawScheme !== rawScheme.toLowerCase()) changes.push('scheme_case');
  if (/:(80|443)$/.test(rawHost) && u.port === '') changes.push('default_port');
  if (u.hash) {
    u.hash = '';
    changes.push('fragment_removed');
  } else if (/#$/.test(raw)) changes.push('fragment_removed');

  const removed: string[] = [];
  if (u.search) {
    const kept: string[] = [];
    // Split manually to preserve the exact encoding and order of meaningful parameters.
    for (const part of u.search.slice(1).split('&')) {
      if (part === '') continue;
      const name = decodeURIComponentSafe(part.split('=')[0] ?? '');
      if (isTrackingParam(name)) removed.push(name);
      else kept.push(part);
    }
    u.search = kept.length ? `?${kept.join('&')}` : '';
    if (removed.length) changes.push('tracking_params_removed');
  } else if ((raw.split('#')[0] ?? '').endsWith('?')) {
    // "https://h/p?" and "https://h/p?#x": an empty query carries no information.
    u.search = '';
    changes.push('empty_query_removed');
  }

  // Percent-encoding case and encoded unreserved characters are equivalent by
  // definition (RFC 3986 6.2.2.1-6.2.2.2): "/%d0%bf", "/%D0%BF" and "/п" (which
  // the URL parser serializes as "/%D0%BF") are one identity, as are "/%7Ea"
  // and "/~a". Decoding never produces a separator ("/", "?", "&", "=", "#"),
  // so the path and query structure cannot change.
  let percentChanged = false;
  const pathBefore = u.pathname;
  const pathNorm = normalizePercentEncoding(pathBefore);
  if (pathNorm !== pathBefore) {
    u.pathname = pathNorm;
    // Defensive: keep the parsed path if the parser would reinterpret the normalized one.
    if (u.pathname === pathNorm) percentChanged = true;
    else u.pathname = pathBefore;
  }
  if (u.search) {
    const searchBefore = u.search;
    const searchNorm = normalizePercentEncoding(searchBefore);
    if (searchNorm !== searchBefore) {
      u.search = searchNorm;
      if (u.search === searchNorm) percentChanged = true;
      else u.search = searchBefore;
    }
  }
  if (percentChanged) changes.push('percent_encoding');

  const path = u.pathname || '/';
  let url = u.toString();
  // WHATWG URL keeps a bare "?" when search is set to ""; strip it defensively.
  if (url.endsWith('?')) url = url.slice(0, -1);
  return {
    url,
    host: u.hostname,
    path,
    pathWithQuery: `${path}${u.search}`,
    removedParams: removed,
    changes,
  };
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/** True when the URL's host is one of the site's allowed hostnames (exact match, case-insensitive). */
export function isAllowedHost(url: string, allowedHostnames: readonly string[]): boolean {
  const u = tryParseUrl(url);
  if (!u) return false;
  const host = u.hostname.toLowerCase();
  return allowedHostnames.some((h) => h.toLowerCase() === host);
}

/**
 * GA4 landing pages are paths (landingPagePlusQueryString) without host.
 * Resolve against a hostname only when that host is known for the row.
 */
export function landingPathToUrl(landingPath: string, host: string, scheme: 'https' | 'http' = 'https'): string | null {
  if (!landingPath || landingPath === '(not set)' || !landingPath.startsWith('/') || !host) return null;
  return normalizeUrl(`${scheme}://${host}${landingPath}`)?.url ?? null;
}

/** Remove only the query string and fragment (for display, not identity). */
export function stripQuery(url: string): string {
  const u = tryParseUrl(url);
  if (!u) return url;
  u.search = '';
  u.hash = '';
  return u.toString();
}

export type UrlDifference = 'scheme' | 'www' | 'host' | 'port' | 'trailing_slash' | 'path_case' | 'path' | 'query' | 'query_order';

/**
 * Explain why two URLs are NOT the same identity after conservative
 * normalization. Used in reconciliation reports so a human can see exactly
 * which evidence would be needed before treating them as one page.
 * Returns [] when the normalized identities are equal.
 */
export function describeUrlDifference(a: string, b: string): UrlDifference[] {
  const na = normalizeUrl(a);
  const nb = normalizeUrl(b);
  if (!na || !nb) return ['path'];
  if (na.url === nb.url) return [];
  const ua = new URL(na.url);
  const ub = new URL(nb.url);
  const out: UrlDifference[] = [];
  if (ua.protocol !== ub.protocol) out.push('scheme');
  if (ua.hostname !== ub.hostname) {
    const strip = (h: string) => h.replace(/^www\./, '');
    out.push(strip(ua.hostname) === strip(ub.hostname) ? 'www' : 'host');
  }
  if (ua.port !== ub.port) out.push('port');
  if (ua.pathname !== ub.pathname) {
    const trim = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);
    if (trim(ua.pathname) === trim(ub.pathname)) out.push('trailing_slash');
    else if (ua.pathname.toLowerCase() === ub.pathname.toLowerCase()) out.push('path_case');
    else out.push('path');
  }
  if (ua.search !== ub.search) {
    const sortQ = (s: string) => s.slice(1).split('&').filter(Boolean).sort().join('&');
    out.push(sortQ(ua.search) === sortQ(ub.search) ? 'query_order' : 'query');
  }
  return out;
}

/**
 * Match a path against a configured path pattern (crawl.protectedPaths /
 * crawl.excludedPaths):
 *   "/admin/*" or "/admin/" -> prefix match
 *   "/pricing"              -> exact match, or the path is below "/pricing/"
 * Matching is case-sensitive, like URL paths; percent-encoding differences
 * (hex case, encoded unreserved characters) are not path differences.
 */
export function matchesPathPattern(path: string, pattern: string): boolean {
  // Percent-encoding variants of one path are the same path (see normalizePercentEncoding).
  const p = normalizePercentEncoding(pattern.trim());
  path = normalizePercentEncoding(path);
  if (!p) return false;
  if (p.endsWith('*')) return path.startsWith(p.slice(0, -1));
  if (p.endsWith('/')) return path.startsWith(p);
  return path === p || path.startsWith(`${p}/`);
}
