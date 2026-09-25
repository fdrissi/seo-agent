import http from 'node:http';
import net from 'node:net';
import type { SsrfGuard, ValidatedTarget } from '../security/ssrf.js';

/**
 * SSRF-enforcing local forward proxy for the optional Playwright renderer.
 *
 * Chromium is launched with this proxy, so EVERY connection the browser makes
 * for page loads, subresources, XHR/fetch, redirect hops and WebSockets goes
 * through it. Playwright's `route()` does not see redirect hops or WebSockets.
 * For each request the proxy:
 * - validates the destination with the SSRF guard (scheme, host rules, DNS,
 *   every resolved address, port);
 * - connects ONLY to an address the guard validated. The browser never
 *   resolves the destination itself, so this is DNS-pinned like the HTTP
 *   fetcher;
 * - never follows redirects. A 3xx goes back to the browser, and the browser's
 *   next request comes through the proxy and is validated again;
 * - refuses plain-HTTP WebSocket upgrades. Secure WebSockets (and all HTTPS)
 *   arrive as CONNECT tunnels and are validated by destination;
 * - enforces a request cap.
 *
 * It listens on 127.0.0.1 on an ephemeral port only for the lifetime of one
 * render. It needs no credentials because it only forwards to guard-validated
 * public destinations, which any local process can already reach directly.
 */

export interface GuardedProxyOptions {
  guard: SsrfGuard;
  /** Maximum proxied requests + tunnels; later ones are refused. Default 600. */
  maxRequests?: number;
  connectTimeoutMs?: number;
  /** Idle timeout for client and upstream sockets. Default 30 s. */
  idleTimeoutMs?: number;
}

export interface GuardedProxy {
  /** Proxy URL for the browser, e.g. http://127.0.0.1:54321 */
  server: string;
  port: number;
  /** Refused destinations (URL or host:port) with the guard's reason. */
  blocked: Array<{ url: string; reason: string }>;
  /** Requests/tunnels that passed the guard. */
  allowed: number;
  close(): Promise<void>;
}

export type GuardedProxyFactory = (opts: GuardedProxyOptions) => Promise<GuardedProxy>;

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

function stripHopByHop(headers: http.IncomingHttpHeaders | http.OutgoingHttpHeaders): Record<string, string | string[] | number> {
  const listed = String(headers.connection ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const out: Record<string, string | string[] | number> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (HOP_BY_HOP.includes(key) || listed.includes(key)) continue;
    out[k] = v as string | string[] | number;
  }
  return out;
}

/** Parse a CONNECT authority ("host:port", "[v6]:port"). */
export function parseAuthority(authority: string): { host: string; port: number } | null {
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:[\]\s/]+):(\d{1,5})$/.exec(authority.trim());
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host: m[1]!, port };
}

export async function startGuardedProxy(opts: GuardedProxyOptions): Promise<GuardedProxy> {
  const maxRequests = opts.maxRequests ?? 600;
  const idle = opts.idleTimeoutMs ?? 30_000;
  const connectTimeout = opts.connectTimeoutMs ?? 10_000;
  const sockets = new Set<net.Socket>();
  const state = { blocked: [] as Array<{ url: string; reason: string }>, allowed: 0, seen: 0 };

  const track = (s: net.Socket) => {
    sockets.add(s);
    s.setTimeout(idle, () => s.destroy());
    s.on('close', () => sockets.delete(s));
    s.on('error', () => s.destroy());
  };
  const refuse = (url: string, reason: string) => {
    if (state.blocked.length < 500) state.blocked.push({ url: url.slice(0, 500), reason });
  };
  /** Count + validate one destination; returns the validated target or null (already recorded). */
  const admit = async (url: string, label: string): Promise<ValidatedTarget | null> => {
    state.seen++;
    if (state.seen > maxRequests) {
      refuse(label, 'subrequest cap reached');
      return null;
    }
    const check = await opts.guard.check(url);
    if (!check.ok) {
      refuse(label, check.error.reason);
      return null;
    }
    state.allowed++;
    return check.target;
  };

  const server = http.createServer();
  server.on('connection', track);

  // Plain HTTP requests in absolute form ("GET http://host/path").
  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    void (async () => {
      let url: URL;
      try {
        url = new URL(req.url ?? '');
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain', connection: 'close' });
        res.end('Proxy requests must use an absolute http:// URL.');
        return;
      }
      if (url.protocol !== 'http:') {
        refuse(url.toString(), 'unsupported_scheme');
        res.writeHead(400, { 'content-type': 'text/plain', connection: 'close' });
        res.end('Only http:// requests are proxied directly; https uses CONNECT.');
        return;
      }
      const target = await admit(url.toString(), url.toString());
      if (!target) {
        res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' });
        res.end('Blocked by the seo-agent SSRF guard.');
        return;
      }
      const addr = target.addresses[0]!;
      const headers = stripHopByHop(req.headers);
      headers.host = url.host;
      const upstream = http.request({
        host: addr.address,
        family: addr.family,
        port: target.port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        setHost: false,
        timeout: connectTimeout,
        agent: false,
      });
      upstream.on('socket', track);
      upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
      upstream.on('response', (up) => {
        // Redirects are passed back unchanged: the browser's next hop is validated again.
        res.writeHead(up.statusCode ?? 502, stripHopByHop(up.headers));
        up.pipe(res);
      });
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain', connection: 'close' });
        res.end();
      });
      req.pipe(upstream);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500, { connection: 'close' });
      res.end();
    });
  });

  // Plain-HTTP WebSocket upgrades are refused outright.
  server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket) => {
    track(socket);
    refuse(req.url ?? '(upgrade)', 'websocket_upgrade_refused');
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });

  // HTTPS / WSS tunnels: validate the destination, then connect to the validated address only.
  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    track(client);
    void (async () => {
      const auth = parseAuthority(req.url ?? '');
      if (!auth) {
        refuse(req.url ?? '(connect)', 'invalid_url');
        client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      // Port 80 tunnels carry plain ws:// traffic; everything else is TLS.
      const scheme = auth.port === 80 ? 'http' : 'https';
      const target = await admit(`${scheme}://${auth.host}:${auth.port}/`, `${auth.host}:${auth.port}`);
      if (!target) {
        client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const addr = target.addresses[0]!;
      const upstream = net.connect({ host: addr.address, port: auth.port, family: addr.family });
      track(upstream);
      const timer = setTimeout(() => upstream.destroy(new Error('connect timeout')), connectTimeout);
      upstream.once('connect', () => {
        clearTimeout(timer);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.once('error', () => {
        clearTimeout(timer);
        if (client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        else client.destroy();
      });
      client.once('close', () => upstream.destroy());
    })().catch(() => client.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    server: `http://127.0.0.1:${port}`,
    port,
    blocked: state.blocked,
    get allowed() {
      return state.allowed;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
