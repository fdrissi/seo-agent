/**
 * Test helpers for crawler tests (SYNTHETIC). Local node:http servers bind to
 * 127.0.0.1 only; hostnames like `site.test` are mapped to 127.0.0.1 by a fake
 * resolver, and the SSRF guard's TEST-ONLY loopback escape hatch is enabled
 * explicitly per test. No real network access.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeFetcher } from '../../../src/crawler/fetch.js';
import { createPinnedTransport, type HttpTransport } from '../../../src/crawler/transport.js';
import { SsrfGuard, type Resolver } from '../../../src/security/ssrf.js';

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/crawler');

/** A public address used ONLY as a fake DNS answer where no connection is made (fake/fixture transports). */
export const FAKE_PUBLIC_IP = '93.184.216.34';

export function fixture(rel: string): string {
  return readFileSync(path.join(FIXTURES, rel), 'utf8');
}

export function mapResolver(map: Record<string, string | string[] | (() => string[])>, calls: string[] = []): Resolver & { calls: string[] } {
  const fn = (async (hostname: string) => {
    calls.push(hostname);
    const v = map[hostname];
    if (v === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    const list = typeof v === 'function' ? v() : Array.isArray(v) ? v : [v];
    return list.map((address) => ({ address, family: address.includes(':') ? (6 as const) : (4 as const) }));
  }) as Resolver & { calls: string[] };
  fn.calls = calls;
  return fn;
}

export interface Hit {
  method: string;
  path: string;
  host: string;
  userAgent: string;
}

export interface TestServer {
  port: number;
  hits: Hit[];
  origin(host?: string): string;
  close(): Promise<void>;
}

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => unknown;

export async function startServer(handler: Handler): Promise<TestServer> {
  const hits: Hit[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    hits.push({ method: req.method ?? 'GET', path: `${url.pathname}${url.search}`, host: (req.headers.host ?? '').replace(/:\d+$/, ''), userAgent: String(req.headers['user-agent'] ?? '') });
    try {
      await handler(req, res, url);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    }
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    hits,
    origin: (host = 'site.test') => `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

export function send(res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

export interface TestFetcherOptions {
  resolver: Resolver;
  transport?: HttpTransport;
  loopback?: boolean;
  delayMs?: number;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  perHostConcurrency?: number;
  userAgent?: string;
  maxRetryAfterMs?: number;
}

/** Fetcher with an instant sleep that records requested waits. */
export function testFetcher(o: TestFetcherOptions): SafeFetcher & { slept: number[] } {
  const slept: number[] = [];
  const f = new SafeFetcher({
    guard: new SsrfGuard({ resolver: o.resolver, testOnlyAllowLoopback: o.loopback ?? true }),
    transport: o.transport ?? createPinnedTransport({ connectTimeoutMs: 2_000 }),
    userAgent: o.userAgent ?? 'seo-agent-test/1.0 (+synthetic tests)',
    timeoutMs: o.timeoutMs ?? 3_000,
    maxBytes: o.maxBytes ?? 200_000,
    maxRedirects: o.maxRedirects ?? 5,
    perHostConcurrency: o.perHostConcurrency ?? 2,
    delayMs: o.delayMs ?? 0,
    ...(o.maxRetryAfterMs !== undefined ? { maxRetryAfterMs: o.maxRetryAfterMs } : {}),
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  });
  return Object.assign(f, { slept });
}
