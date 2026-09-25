import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';
import type { FetchLike } from '../integrations/types.js';
import { safeResolve } from '../security/paths.js';
import { pinnedLookup, type ValidatedTarget } from '../security/ssrf.js';

/**
 * HTTP transports used by the SSRF-safe fetcher. The fetcher validates every
 * hop with the SSRF guard BEFORE calling `send`; the transport decides how the
 * connection is made.
 *
 * - `pinned` (production default): undici with a per-request Agent whose
 *   connector `lookup` answers only with the guard-validated addresses. The
 *   socket can never be re-pointed by a second DNS answer (DNS rebinding).
 *   No environment proxy is used.
 * - `injected`: wraps a FetchLike (tests with fakes). The guard still
 *   validates every URL, but no connection pinning is possible, so results
 *   record `pinned: false`.
 * - `fixture`: serves synthetic files (demo/tests). Results are flagged as
 *   fixture data and stored with render_mode='fixture', is_synthetic=1.
 */

export interface TransportInit {
  method: 'GET' | 'HEAD';
  headers: Record<string, string>;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Headers;
  body: AsyncIterable<Uint8Array> | null;
  /** Release the body and the connection. Safe to call more than once. */
  close(): Promise<void>;
}

export interface HttpTransport {
  readonly kind: 'pinned' | 'injected' | 'fixture';
  send(target: ValidatedTarget, init: TransportInit): Promise<TransportResponse>;
}

export interface PinnedTransportOptions {
  connectTimeoutMs?: number;
}

/** Production transport: undici + per-request Agent pinned to validated IPs. */
export function createPinnedTransport(opts: PinnedTransportOptions = {}): HttpTransport {
  return {
    kind: 'pinned',
    async send(target, init) {
      const agent = new Agent({
        connect: {
          // net.connect/tls.connect call this instead of DNS: only validated addresses are returned.
          lookup: pinnedLookup(target) as never,
          timeout: opts.connectTimeoutMs ?? 10_000,
        },
        keepAliveTimeout: 1_000,
        keepAliveMaxTimeout: 1_000,
      });
      let closed = false;
      const destroy = async () => {
        if (closed) return;
        closed = true;
        await agent.destroy().catch(() => undefined);
      };
      try {
        const res = await undiciFetch(target.url.toString(), {
          method: init.method,
          headers: init.headers,
          signal: init.signal,
          redirect: 'manual',
          dispatcher: agent,
        });
        const headers = new Headers();
        res.headers.forEach((v, k) => headers.append(k, v));
        const body = res.body as unknown as (AsyncIterable<Uint8Array> & { cancel?: () => Promise<void> }) | null;
        return {
          status: res.status,
          headers,
          body,
          close: async () => {
            try {
              await body?.cancel?.();
            } catch {
              /* already consumed or errored */
            }
            await destroy();
          },
        };
      } catch (err) {
        await destroy();
        throw err;
      }
    },
  };
}

/** Wrap a FetchLike (tests). The guard still validates; connections are NOT pinned. */
export function fetchLikeTransport(fetchLike: FetchLike, kind: 'injected' | 'fixture' = 'injected'): HttpTransport {
  return {
    kind,
    async send(target, init) {
      const res = await fetchLike(target.url.toString(), { method: init.method, headers: init.headers, signal: init.signal, redirect: 'manual' });
      const body = res.body as unknown as (AsyncIterable<Uint8Array> & { cancel?: () => Promise<void> }) | null;
      return {
        status: res.status,
        headers: res.headers,
        body,
        close: async () => {
          try {
            await body?.cancel?.();
          } catch {
            /* ignore */
          }
        },
      };
    },
  };
}

export interface FixtureResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

/**
 * Synthetic fixture transport: a map of absolute URL -> response, or a
 * resolver function. Unknown URLs return 404. Every result is flagged as
 * fixture data.
 */
export function fixtureTransport(routes: Record<string, FixtureResponse> | ((url: string) => FixtureResponse | undefined)): HttpTransport {
  const lookup = typeof routes === 'function' ? routes : (url: string) => routes[url];
  return {
    kind: 'fixture',
    async send(target) {
      const f = lookup(target.url.toString()) ?? { status: 404, headers: { 'content-type': 'text/plain' }, body: 'not found (fixture)' };
      const bytes = typeof f.body === 'string' ? new TextEncoder().encode(f.body) : (f.body ?? new Uint8Array());
      const headers = new Headers(f.headers ?? {});
      return {
        status: f.status ?? 200,
        headers,
        body: (async function* () {
          if (bytes.length) yield bytes;
        })(),
        close: async () => undefined,
      };
    },
  };
}

const EXT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.gz': 'application/gzip',
};

/**
 * Serve a synthetic site from a directory (demo mode). Path mapping:
 *   /            -> index.html
 *   /robots.txt  -> robots.txt
 *   /a/b         -> a/b.html, or a/b/index.html
 *   /a/b/        -> a/b/index.html
 * Only hosts in `hosts` are served; paths cannot escape `dir`.
 */
export function fixtureSiteTransport(opts: { dir: string; hosts: readonly string[] }): HttpTransport {
  const hosts = new Set(opts.hosts.map((h) => h.toLowerCase()));
  return fixtureTransport((raw) => {
    const u = new URL(raw);
    if (!hosts.has(u.hostname.toLowerCase())) return undefined;
    const p = decodeURIComponent(u.pathname);
    const candidates: string[] = [];
    if (p === '/' || p === '') candidates.push('index.html');
    else if (p.endsWith('/')) candidates.push(`${p.slice(1)}index.html`);
    else {
      const rel = p.slice(1);
      candidates.push(rel, `${rel}.html`, `${rel}/index.html`);
    }
    for (const c of candidates) {
      let abs: string;
      try {
        abs = safeResolve(opts.dir, c);
      } catch {
        return { status: 400, headers: { 'content-type': 'text/plain' }, body: 'bad path' };
      }
      if (existsSync(abs) && statSync(abs).isFile()) {
        const ext = path.extname(abs).toLowerCase();
        return { status: 200, headers: { 'content-type': EXT_TYPES[ext] ?? 'application/octet-stream' }, body: new Uint8Array(readFileSync(abs)) };
      }
    }
    return undefined;
  });
}
