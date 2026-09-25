import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';
import { AppError } from '../core/errors.js';

/**
 * SSRF guard for every generic outbound fetch of untrusted or configured
 * URLs (own-site crawl, competitor pages, sitemaps, robots.txt, Playwright
 * subrequests).
 *
 * Rules:
 * - Only `http:` and `https:` URLs; no embedded credentials.
 * - Hostnames that name local/internal infrastructure are refused before DNS
 *   (localhost, *.local, *.internal, cloud metadata names, single-label names).
 * - IP literals (including decimal/octal/hex/short IPv4 forms, which the
 *   WHATWG URL parser normalizes) and every DNS answer are classified; any
 *   private, loopback, link-local, CGNAT, multicast, reserved, documentation,
 *   unique-local IPv6, IPv4-mapped/NAT64-embedded private IPv4, unspecified,
 *   or cloud metadata address blocks the request.
 * - Non-default ports are refused unless explicitly allowlisted.
 * - Validation returns the resolved addresses so the transport can PIN the
 *   connection to them (see `pinnedLookup`), which defeats DNS rebinding: the
 *   socket never performs a second, unvalidated resolution.
 * - Every redirect hop is validated again by the caller (src/crawler/fetch.ts).
 *
 * Fixed internal adapters (Qdrant, LLM Gateway, Google APIs) never use this
 * guard's fetcher; they talk to their configured endpoints directly.
 *
 * Test-only escape hatch: `testOnlyAllowLoopback` (a constructor option, never
 * read from config or environment) permits exactly 127.0.0.1 on any port so
 * integration tests can use a local node:http server. Every other rule still
 * applies, including metadata and private-range blocking.
 */

export type SsrfBlockReason =
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'credentials_in_url'
  | 'blocked_hostname'
  | 'single_label_host'
  | 'metadata_endpoint'
  | 'blocked_ip'
  | 'blocked_port'
  | 'dns_failure'
  | 'dns_blocked_ip';

export class UnsafeUrlError extends AppError {
  readonly reason: SsrfBlockReason;
  constructor(reason: SsrfBlockReason, message: string, details: Record<string, unknown> = {}) {
    super('UNSAFE_URL', message, {
      details: { reason, ...details },
      hint: 'The crawler only fetches public http(s) destinations on default ports. It never contacts private networks or cloud metadata endpoints.',
    });
    this.name = 'UnsafeUrlError';
    this.reason = reason;
  }
}

export function isUnsafeUrlError(err: unknown): err is UnsafeUrlError {
  return err instanceof UnsafeUrlError;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** DNS resolver: returns every address for a hostname. Injectable for tests. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
  const res = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  return res.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

// ---------------------------------------------------------------------------
// IP parsing and classification
// ---------------------------------------------------------------------------

export type IpCategory =
  | 'public'
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'cgnat'
  | 'multicast'
  | 'reserved'
  | 'documentation'
  | 'benchmarking'
  | 'unique_local'
  | 'site_local'
  | 'metadata'
  | 'ipv4_embedding'
  | 'not_global_unicast'
  | 'invalid';

export interface IpClassification {
  address: string;
  version: 4 | 6 | 0;
  category: IpCategory;
  allowed: boolean;
  /** Range label, e.g. "10.0.0.0/8 (private)". */
  range?: string;
  /** For IPv4-mapped / NAT64 IPv6: the embedded IPv4 classification. */
  embedded?: IpClassification;
}

/** Strict dotted-quad parser (the URL parser has already normalized other IPv4 forms). */
export function parseIPv4(input: string): number[] | null {
  const parts = input.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Parse IPv6 (optionally bracketed, optional zone id, optional trailing dotted IPv4) into 8 hextets. */
export function parseIPv6(input: string): number[] | null {
  let s = input.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':')) return null;
  let tailV4: number[] | null = null;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    tailV4 = parseIPv4(tail);
    if (!tailV4) return null;
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const dbl = s.split('::');
  if (dbl.length > 2) return null;
  const parseGroups = (g: string): number[] | null => {
    if (g === '') return [];
    const out: number[] = [];
    for (const h of g.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return null;
      out.push(parseInt(h, 16));
    }
    return out;
  };
  const head = parseGroups(dbl[0]!);
  const rest = dbl.length === 2 ? parseGroups(dbl[1]!) : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (dbl.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  if (tailV4) {
    groups[6] = (tailV4[0]! << 8) | tailV4[1]!;
    groups[7] = (tailV4[2]! << 8) | tailV4[3]!;
  }
  return groups;
}

function v4ToInt(o: number[]): number {
  return ((o[0]! << 24) >>> 0) + (o[1]! << 16) + (o[2]! << 8) + o[3]!;
}

interface V4Range {
  base: number;
  bits: number;
  category: IpCategory;
  label: string;
}

function v4range(cidr: string, category: IpCategory): V4Range {
  const [ip, bits] = cidr.split('/');
  return { base: v4ToInt(parseIPv4(ip!)!), bits: Number(bits), category, label: `${cidr} (${category.replace(/_/g, ' ')})` };
}

/** IANA IPv4 special-purpose registry plus private/shared space (RFC 1918, 6598, 5735, 6890). */
const V4_BLOCKED: V4Range[] = [
  v4range('0.0.0.0/8', 'unspecified'),
  v4range('10.0.0.0/8', 'private'),
  v4range('100.64.0.0/10', 'cgnat'),
  v4range('127.0.0.0/8', 'loopback'),
  v4range('169.254.0.0/16', 'link_local'),
  v4range('172.16.0.0/12', 'private'),
  v4range('192.0.0.0/24', 'reserved'),
  v4range('192.0.2.0/24', 'documentation'),
  v4range('192.31.196.0/24', 'reserved'),
  v4range('192.52.193.0/24', 'reserved'),
  v4range('192.88.99.0/24', 'reserved'),
  v4range('192.168.0.0/16', 'private'),
  v4range('192.175.48.0/24', 'reserved'),
  v4range('198.18.0.0/15', 'benchmarking'),
  v4range('198.51.100.0/24', 'documentation'),
  v4range('203.0.113.0/24', 'documentation'),
  v4range('224.0.0.0/4', 'multicast'),
  v4range('240.0.0.0/4', 'reserved'),
];

/** Well-known cloud/container metadata and host-agent addresses (some are in public space). */
export const METADATA_IPS: ReadonlySet<string> = new Set([
  '169.254.169.254', // AWS, GCP, Azure, OpenStack, DigitalOcean, Oracle IMDS
  '169.254.169.123', // AWS time sync
  '169.254.169.250', // AWS
  '169.254.170.2', // AWS ECS task metadata
  '169.254.170.23', // AWS EKS pod identity
  '100.100.100.200', // Alibaba Cloud
  '168.63.129.16', // Azure WireServer (public range)
  '192.0.0.192', // Oracle Cloud (legacy)
  'fd00:ec2::254', // AWS IMDS over IPv6
  'fd00:ec2::23', // AWS EKS pod identity over IPv6
]);

function inV4Range(ip: number, r: V4Range): boolean {
  if (r.bits === 0) return true;
  const mask = r.bits === 32 ? 0xffffffff : (~((1 << (32 - r.bits)) - 1)) >>> 0;
  return ((ip & mask) >>> 0) === ((r.base & mask) >>> 0);
}

function classifyV4(octets: number[]): IpClassification {
  const address = octets.join('.');
  if (METADATA_IPS.has(address)) return { address, version: 4, category: 'metadata', allowed: false, range: `${address} (cloud metadata endpoint)` };
  const n = v4ToInt(octets);
  for (const r of V4_BLOCKED) {
    if (inV4Range(n, r)) return { address, version: 4, category: r.category, allowed: false, range: r.label };
  }
  return { address, version: 4, category: 'public', allowed: true };
}

function hextetsToString(h: number[]): string {
  // Compressed canonical-ish form (RFC 5952 style longest zero run).
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (h[i] === 0) {
      let j = i;
      while (j < 8 && h[j] === 0) j++;
      if (j - i > bestLen && j - i > 1) {
        bestStart = i;
        bestLen = j - i;
      }
      i = j;
    } else i++;
  }
  const parts = h.map((x) => x.toString(16));
  if (bestStart < 0) return parts.join(':');
  const left = parts.slice(0, bestStart).join(':');
  const right = parts.slice(bestStart + bestLen).join(':');
  return `${left}::${right}`;
}

function prefixMatch(h: number[], prefix: number[], bits: number): boolean {
  let remaining = bits;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const take = Math.min(16, remaining);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if (((h[i]! & mask) >>> 0) !== ((prefix[i] ?? 0) & mask)) return false;
    remaining -= take;
  }
  return true;
}

interface V6Range {
  prefix: number[];
  bits: number;
  category: IpCategory;
  label: string;
}

function v6range(cidr: string, category: IpCategory): V6Range {
  const [ip, bits] = cidr.split('/');
  return { prefix: parseIPv6(ip!)!, bits: Number(bits), category, label: `${cidr} (${category.replace(/_/g, ' ')})` };
}

/** Blocked subranges of 2000::/3 (global unicast). Everything outside 2000::/3 is blocked too. */
const V6_BLOCKED_GLOBAL: V6Range[] = [
  v6range('2001::/23', 'reserved'), // IETF protocol assignments incl. Teredo 2001::/32 (embeds IPv4)
  v6range('2001:db8::/32', 'documentation'),
  v6range('2002::/16', 'ipv4_embedding'), // 6to4 (embeds IPv4)
  v6range('3fff::/20', 'documentation'),
];

const V6_SPECIAL: V6Range[] = [
  v6range('64:ff9b:1::/48', 'reserved'), // local-use NAT64
  v6range('100::/64', 'reserved'), // discard-only
  v6range('5f00::/16', 'reserved'), // SRv6 SIDs
  v6range('fc00::/7', 'unique_local'),
  v6range('fe80::/10', 'link_local'),
  v6range('fec0::/10', 'site_local'),
  v6range('ff00::/8', 'multicast'),
];

function classifyV6(h: number[]): IpClassification {
  const address = hextetsToString(h);
  if (METADATA_IPS.has(address)) return { address, version: 6, category: 'metadata', allowed: false, range: `${address} (cloud metadata endpoint)` };
  const allZeroPrefix96 = h.slice(0, 6).every((x) => x === 0);
  if (allZeroPrefix96 && h[6] === 0 && h[7] === 0) return { address, version: 6, category: 'unspecified', allowed: false, range: ':: (unspecified)' };
  if (allZeroPrefix96 && h[6] === 0 && h[7] === 1) return { address, version: 6, category: 'loopback', allowed: false, range: '::1 (loopback)' };
  const embeddedV4 = (): number[] => [h[6]! >> 8, h[6]! & 0xff, h[7]! >> 8, h[7]! & 0xff];
  // IPv4-mapped ::ffff:0:0/96 and NAT64 well-known prefix 64:ff9b::/96: classify the embedded IPv4.
  const mapped = h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff;
  const nat64 = prefixMatch(h, parseIPv6('64:ff9b::')!, 96);
  if (mapped || nat64) {
    const inner = classifyV4(embeddedV4());
    const label = mapped ? '::ffff:0:0/96 (IPv4-mapped)' : '64:ff9b::/96 (NAT64)';
    // Mapped addresses are always refused: a socket to ::ffff:a.b.c.d is an IPv4 connection
    // and legitimate public sites never publish them in DNS.
    return { address, version: 6, category: inner.allowed ? 'ipv4_embedding' : inner.category, allowed: false, range: `${label} embedding ${inner.address}`, embedded: inner };
  }
  // IPv4-compatible (deprecated) ::a.b.c.d and anything else with a zero /96 prefix.
  if (allZeroPrefix96) return { address, version: 6, category: 'ipv4_embedding', allowed: false, range: '::/96 (IPv4-compatible, deprecated)' };
  for (const r of V6_SPECIAL) if (prefixMatch(h, r.prefix, r.bits)) return { address, version: 6, category: r.category, allowed: false, range: r.label };
  if (!prefixMatch(h, parseIPv6('2000::')!, 3)) return { address, version: 6, category: 'not_global_unicast', allowed: false, range: 'outside 2000::/3 (not global unicast)' };
  for (const r of V6_BLOCKED_GLOBAL) if (prefixMatch(h, r.prefix, r.bits)) return { address, version: 6, category: r.category, allowed: false, range: r.label };
  return { address, version: 6, category: 'public', allowed: true };
}

/** Classify an IP address string (IPv4 dotted quad or IPv6, brackets allowed). */
export function classifyIp(input: string): IpClassification {
  const s = input.trim().replace(/^\[|\]$/g, '');
  const v4 = parseIPv4(s);
  if (v4) return classifyV4(v4);
  const v6 = parseIPv6(s);
  if (v6) return classifyV6(v6);
  return { address: input, version: 0, category: 'invalid', allowed: false, range: 'not an IP address' };
}

export function isIpLiteral(host: string): boolean {
  const s = host.replace(/^\[|\]$/g, '');
  return isIP(s) !== 0;
}

// ---------------------------------------------------------------------------
// Hostname rules
// ---------------------------------------------------------------------------

const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.com',
  'instance-data',
  'instance-data.ec2.internal',
  'kubernetes',
  'kubernetes.default',
  'kubernetes.default.svc',
  'host.docker.internal',
  'gateway.docker.internal',
]);

const BLOCKED_SUFFIXES: readonly string[] = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa', '.in-addr.arpa', '.ip6.arpa', '.intranet', '.corp', '.lan'];

export function normalizeHostname(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

/** Pure hostname check (no DNS). Returns a block reason or null. */
export function checkHostname(hostname: string, extraBlocked: readonly string[] = []): { reason: SsrfBlockReason; detail: string } | null {
  const h = normalizeHostname(hostname);
  if (!h) return { reason: 'invalid_url', detail: 'empty hostname' };
  if (h === 'metadata.google.internal' || h === 'metadata.goog' || h === 'metadata' || h === 'instance-data' || h.startsWith('instance-data.') || h === 'metadata.azure.com') {
    return { reason: 'metadata_endpoint', detail: `${h} is a cloud metadata hostname` };
  }
  if (BLOCKED_HOSTNAMES.has(h) || extraBlocked.map(normalizeHostname).includes(h)) return { reason: 'blocked_hostname', detail: `${h} is a local/internal hostname` };
  for (const suffix of BLOCKED_SUFFIXES) if (h.endsWith(suffix)) return { reason: 'blocked_hostname', detail: `${h} uses the internal/local suffix ${suffix}` };
  if (!isIpLiteral(h) && !h.includes('.')) return { reason: 'single_label_host', detail: `${h} is a single-label hostname (resolved through local search domains)` };
  return null;
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

export interface SsrfGuardOptions {
  resolver?: Resolver;
  /** Non-default ports allowed for any host (e.g. [8443]). Default: none. */
  allowedPorts?: readonly number[];
  /** Non-default ports allowed for specific hosts, as "host:port" (e.g. the configured site URL). */
  allowedHostPorts?: readonly string[];
  /** Additional hostnames to refuse. */
  blockedHostnames?: readonly string[];
  /** DNS resolution timeout. */
  dnsTimeoutMs?: number;
  /**
   * TEST-ONLY escape hatch: permit exactly 127.0.0.1 (any port) so integration
   * tests can use a local node:http server. Never set from config or env.
   */
  testOnlyAllowLoopback?: boolean;
}

export interface ValidatedTarget {
  url: URL;
  hostname: string;
  port: number;
  /** Addresses validated for this request; the transport must connect only to these. */
  addresses: ResolvedAddress[];
  /** True when the host was an IP literal (no DNS lookup was needed). */
  ipLiteral: boolean;
}

export interface GuardDescription {
  allowedSchemes: string[];
  allowedPorts: number[];
  allowedHostPorts: string[];
  testOnlyAllowLoopback: boolean;
  dnsPinning: true;
}

const TEST_LOOPBACK = '127.0.0.1';

function defaultPort(protocol: string): number {
  return protocol === 'https:' ? 443 : 80;
}

export class SsrfGuard {
  private readonly resolver: Resolver;
  private readonly allowedPorts: Set<number>;
  private readonly allowedHostPorts: Set<string>;
  private readonly blockedHostnames: readonly string[];
  private readonly dnsTimeoutMs: number;
  readonly testOnlyAllowLoopback: boolean;

  constructor(opts: SsrfGuardOptions = {}) {
    this.resolver = opts.resolver ?? systemResolver;
    this.allowedPorts = new Set(opts.allowedPorts ?? []);
    this.allowedHostPorts = new Set((opts.allowedHostPorts ?? []).map((s) => s.toLowerCase()));
    this.blockedHostnames = opts.blockedHostnames ?? [];
    this.dnsTimeoutMs = opts.dnsTimeoutMs ?? 5_000;
    this.testOnlyAllowLoopback = opts.testOnlyAllowLoopback === true;
  }

  describe(): GuardDescription {
    return {
      allowedSchemes: ['http:', 'https:'],
      allowedPorts: [...this.allowedPorts],
      allowedHostPorts: [...this.allowedHostPorts],
      testOnlyAllowLoopback: this.testOnlyAllowLoopback,
      dnsPinning: true,
    };
  }

  private addressAllowed(c: IpClassification): boolean {
    if (c.allowed) return true;
    return this.testOnlyAllowLoopback && c.version === 4 && c.address === TEST_LOOPBACK;
  }

  private portAllowed(hostname: string, port: number, protocol: string): boolean {
    if (port === defaultPort(protocol)) return true;
    return this.allowedPorts.has(port) || this.allowedHostPorts.has(`${hostname}:${port}`);
  }

  /**
   * Synchronous checks that need no DNS: URL syntax, scheme, credentials,
   * hostname rules, IP-literal classification, port. Throws UnsafeUrlError.
   */
  checkStatic(input: string | URL): { url: URL; hostname: string; port: number; ipLiteral: boolean; portDeferred: boolean } {
    let url: URL;
    try {
      url = typeof input === 'string' ? new URL(input) : new URL(input.toString());
    } catch {
      throw new UnsafeUrlError('invalid_url', `Not a valid absolute URL: ${String(input).slice(0, 200)}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new UnsafeUrlError('unsupported_scheme', `Only http and https URLs are allowed (got ${url.protocol})`, { scheme: url.protocol });
    }
    if (url.username || url.password) {
      throw new UnsafeUrlError('credentials_in_url', 'URLs with embedded credentials are refused');
    }
    const hostname = normalizeHostname(url.hostname);
    const port = url.port ? Number(url.port) : defaultPort(url.protocol);
    const ipLiteral = isIpLiteral(hostname);
    if (ipLiteral) {
      const c = classifyIp(hostname);
      if (!this.addressAllowed(c)) {
        throw new UnsafeUrlError(c.category === 'metadata' ? 'metadata_endpoint' : 'blocked_ip', `Refusing ${c.category.replace(/_/g, ' ')} address ${c.address} (${c.range ?? ''})`, {
          address: c.address,
          category: c.category,
        });
      }
    } else {
      const bad = checkHostname(hostname, this.blockedHostnames);
      if (bad) throw new UnsafeUrlError(bad.reason, `Refusing host: ${bad.detail}`, { hostname });
    }
    let portDeferred = false;
    if (!this.portAllowed(hostname, port, url.protocol)) {
      if (this.testOnlyAllowLoopback) portDeferred = true; // allowed only if every address is the test loopback
      else throw new UnsafeUrlError('blocked_port', `Port ${port} is not allowed (only default ports unless allowlisted)`, { hostname, port });
    }
    return { url, hostname, port, ipLiteral, portDeferred };
  }

  /** Full validation: static checks + DNS resolution + classification of every resolved address. */
  async validate(input: string | URL): Promise<ValidatedTarget> {
    const s = this.checkStatic(input);
    let addresses: ResolvedAddress[];
    if (s.ipLiteral) {
      const bare = s.hostname;
      addresses = [{ address: bare, family: isIP(bare) === 6 ? 6 : 4 }];
    } else {
      try {
        addresses = await withDnsTimeout(this.resolver(s.hostname), this.dnsTimeoutMs);
      } catch (err) {
        throw new UnsafeUrlError('dns_failure', `DNS resolution failed for ${s.hostname}: ${(err as Error).message ?? String(err)}`, { hostname: s.hostname });
      }
      if (!addresses.length) throw new UnsafeUrlError('dns_failure', `DNS returned no addresses for ${s.hostname}`, { hostname: s.hostname });
      const blocked = addresses.map((a) => classifyIp(a.address)).filter((c) => !this.addressAllowed(c));
      if (blocked.length) {
        const first = blocked[0]!;
        throw new UnsafeUrlError(
          first.category === 'metadata' ? 'metadata_endpoint' : 'dns_blocked_ip',
          `${s.hostname} resolves to a refused ${first.category.replace(/_/g, ' ')} address ${first.address} (${first.range ?? ''})`,
          { hostname: s.hostname, blocked: blocked.map((b) => ({ address: b.address, category: b.category })) },
        );
      }
    }
    if (s.portDeferred && !addresses.every((a) => a.address === TEST_LOOPBACK)) {
      throw new UnsafeUrlError('blocked_port', `Port ${s.port} is not allowed (only default ports unless allowlisted)`, { hostname: s.hostname, port: s.port });
    }
    // Normalize family from the address itself (never trust the resolver's label).
    addresses = addresses.map((a) => ({ address: a.address.replace(/^\[|\]$/g, ''), family: isIP(a.address.replace(/^\[|\]$/g, '')) === 6 ? 6 : 4 }));
    return { url: s.url, hostname: s.hostname, port: s.port, addresses, ipLiteral: s.ipLiteral };
  }

  /** Validate without throwing. */
  async check(input: string | URL): Promise<{ ok: true; target: ValidatedTarget } | { ok: false; error: UnsafeUrlError }> {
    try {
      return { ok: true, target: await this.validate(input) };
    } catch (err) {
      if (err instanceof UnsafeUrlError) return { ok: false, error: err };
      throw err;
    }
  }
}

async function withDnsTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;

/**
 * A `net.connect`-compatible lookup that answers ONLY with the addresses
 * validated for `target`. Used as the undici connector's `lookup`, so the
 * socket cannot be re-pointed by a second (rebinding) DNS answer. A lookup
 * for any other hostname fails closed.
 *
 * Every answer (success and error) is delivered asynchronously, like
 * `dns.lookup`. A synchronous answer would make `net`/`tls.connect()` start
 * the connection before it returns; a connection refused synchronously by the
 * operating system (EPERM from an egress firewall, ENETUNREACH, EINVAL) would
 * then emit 'error' before undici attaches its listener and crash the process
 * instead of rejecting the request.
 */
export function pinnedLookup(target: ValidatedTarget): (hostname: string, options: unknown, callback: LookupCallback) => void {
  return (hostname, options, callback) => {
    const rawCb = (typeof options === 'function' ? options : callback) as LookupCallback;
    const cb: LookupCallback = (err, address, family) => {
      process.nextTick(() => (family === undefined ? rawCb(err, address) : rawCb(err, address, family)));
    };
    const opts = (typeof options === 'object' && options !== null ? options : {}) as { all?: boolean; family?: number | string };
    if (normalizeHostname(hostname) !== target.hostname) {
      const err = Object.assign(new Error(`SSRF guard: unexpected lookup for ${hostname} (pinned to ${target.hostname})`), { code: 'ENOTFOUND' }) as NodeJS.ErrnoException;
      cb(err, '', 0);
      return;
    }
    const fam = opts.family === 'IPv6' || opts.family === 6 ? 6 : opts.family === 'IPv4' || opts.family === 4 ? 4 : 0;
    const list = target.addresses.filter((a) => fam === 0 || a.family === fam);
    if (!list.length) {
      const err = Object.assign(new Error(`SSRF guard: no validated ${fam ? `IPv${fam} ` : ''}address for ${hostname}`), { code: 'ENOTFOUND' }) as NodeJS.ErrnoException;
      cb(err, '', 0);
      return;
    }
    if (opts.all) cb(null, list.map((a) => ({ address: a.address, family: a.family })));
    else cb(null, list[0]!.address, list[0]!.family);
  };
}
