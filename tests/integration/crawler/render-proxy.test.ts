/**
 * The SSRF-enforcing proxy used by the optional Playwright renderer, tested
 * offline as a real HTTP proxy against a local 127.0.0.1 server (SYNTHETIC).
 * The guard's TEST-ONLY loopback escape hatch permits exactly 127.0.0.1.
 */
import http from 'node:http';
import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseAuthority, startGuardedProxy, type GuardedProxy } from '../../../src/crawler/render-proxy.js';
import { SsrfGuard } from '../../../src/security/ssrf.js';
import { FAKE_PUBLIC_IP, mapResolver, send, startServer, type TestServer } from './helpers.js';

let server: TestServer;
let proxy: GuardedProxy | null = null;

beforeAll(async () => {
  server = await startServer((_req, res, url) => {
    if (url.pathname === '/ok') return send(res, 200, '<html><body>proxied synthetic page</body></html>');
    if (url.pathname === '/to-metadata') return send(res, 302, '', { location: 'http://169.254.169.254/latest/meta-data/' });
    if (url.pathname === '/to-internal') return send(res, 302, '', { location: `http://internal.test:${server.port}/ok` });
    return send(res, 404, 'nope');
  });
});
afterAll(async () => {
  await server.close();
});
afterEach(async () => {
  await proxy?.close();
  proxy = null;
});

// public.test maps to a public address that is never connected to (refused on its port before any connection).
const guard = () => new SsrfGuard({ resolver: mapResolver({ 'site.test': '127.0.0.1', 'internal.test': '10.1.2.3', 'public.test': FAKE_PUBLIC_IP }), testOnlyAllowLoopback: true });

/** GET an absolute URL through the proxy (what Chromium does for http://). */
function viaProxy(p: GuardedProxy, target: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const req = http.request({ host: '127.0.0.1', port: p.port, method: 'GET', path: target, headers: { host: u.host, ...headers }, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, ...(res.headers.location ? { location: res.headers.location } : {}) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Open a CONNECT tunnel (what Chromium does for https:// and wss://). Returns the status line and the socket. */
function connect(p: GuardedProxy, authority: string): Promise<{ statusLine: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: p.port }, () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    let buf = '';
    const onData = (c: Buffer) => {
      buf += c.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end >= 0) {
        socket.off('data', onData);
        resolve({ statusLine: buf.slice(0, buf.indexOf('\r\n')), socket });
      }
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

describe('guarded render proxy', () => {
  it('forwards allowed plain-HTTP requests to the validated address only', async () => {
    proxy = await startGuardedProxy({ guard: guard() });
    expect(proxy.server).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const before = server.hits.length;
    const r = await viaProxy(proxy, `http://site.test:${server.port}/ok`);
    expect(r.status).toBe(200);
    expect(r.body).toContain('proxied synthetic page');
    expect(server.hits.slice(before).map((h) => `${h.host}${h.path}`)).toEqual(['site.test/ok']);
    expect(proxy.allowed).toBe(1);
  });

  it('passes redirects back and refuses the next hop when it targets metadata or private addresses', async () => {
    proxy = await startGuardedProxy({ guard: guard() });
    const hop = await viaProxy(proxy, `http://site.test:${server.port}/to-metadata`);
    expect(hop.status).toBe(302); // never followed by the proxy itself
    const next = await viaProxy(proxy, hop.location!);
    expect(next.status).toBe(403);
    expect(next.body).toMatch(/SSRF guard/);
    const hop2 = await viaProxy(proxy, `http://site.test:${server.port}/to-internal`);
    const before = server.hits.length;
    const next2 = await viaProxy(proxy, hop2.location!);
    expect(next2.status).toBe(403);
    expect(server.hits.length).toBe(before); // no connection was made for the refused hop
    expect(proxy.blocked.map((b) => b.reason)).toEqual(['metadata_endpoint', 'dns_blocked_ip']);
  });

  it('validates CONNECT tunnels by destination and pins them to the validated address', async () => {
    proxy = await startGuardedProxy({ guard: guard() });
    for (const bad of ['169.254.169.254:443', '10.0.0.1:443', `internal.test:443`, 'localhost:443', '[::1]:443', 'public.test:22']) {
      const r = await connect(proxy, bad);
      expect(r.statusLine, bad).toMatch(/^HTTP\/1\.1 403/);
      r.socket.destroy();
    }
    expect(proxy.blocked.map((b) => b.reason)).toEqual(['metadata_endpoint', 'blocked_ip', 'dns_blocked_ip', 'blocked_hostname', 'blocked_ip', 'blocked_port']);
    // An allowed tunnel reaches the (test-loopback) server; the proxy only relays bytes.
    const ok = await connect(proxy, `site.test:${server.port}`);
    expect(ok.statusLine).toBe('HTTP/1.1 200 Connection Established');
    const reply = await new Promise<string>((resolve) => {
      let body = '';
      ok.socket.on('data', (c) => (body += c.toString('utf8')));
      ok.socket.on('end', () => resolve(body));
      ok.socket.write(`GET /ok HTTP/1.1\r\nHost: site.test:${server.port}\r\nConnection: close\r\n\r\n`);
    });
    expect(reply).toMatch(/^HTTP\/1\.1 200/);
    expect(reply).toContain('proxied synthetic page');
  });

  it('refuses plain WebSocket upgrades, non-http schemes, and requests over the cap', async () => {
    proxy = await startGuardedProxy({ guard: guard(), maxRequests: 1 });
    const ws = await new Promise<number>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: proxy!.port, path: `http://site.test:${server.port}/socket`, headers: { host: `site.test:${server.port}`, connection: 'Upgrade', upgrade: 'websocket' }, agent: false });
      req.on('response', (res) => resolve(res.statusCode ?? 0));
      req.on('upgrade', () => resolve(101));
      req.on('error', () => resolve(-1));
      req.end();
    });
    expect([403, -1]).toContain(ws);
    const ftp = await viaProxy(proxy, 'ftp://site.test/file');
    expect(ftp.status).toBe(400);
    expect((await viaProxy(proxy, `http://site.test:${server.port}/ok`)).status).toBe(200);
    expect((await viaProxy(proxy, `http://site.test:${server.port}/ok`)).status).toBe(403); // cap of 1 reached
    expect(proxy.blocked.map((b) => b.reason)).toEqual(['websocket_upgrade_refused', 'unsupported_scheme', 'subrequest cap reached']);
  });

  it('parses CONNECT authorities strictly', () => {
    expect(parseAuthority('example.com:443')).toEqual({ host: 'example.com', port: 443 });
    expect(parseAuthority('[2001:db8::1]:8443')).toEqual({ host: '[2001:db8::1]', port: 8443 });
    expect(parseAuthority('example.com')).toBeNull();
    expect(parseAuthority('example.com:0')).toBeNull();
    expect(parseAuthority('a/b:443')).toBeNull();
  });
});
