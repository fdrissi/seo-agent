import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { AppError, ValidationError } from '../core/errors.js';

/**
 * One-shot loopback listener for the OAuth desktop flow (Google "loopback IP
 * address" redirect). It binds ONLY to 127.0.0.1 on an ephemeral port,
 * accepts exactly one callback (or times out), validates `state` with a
 * constant-time comparison, and closes itself. The browser gets a short
 * HTML page asking the user to return to the terminal; codes and tokens are
 * never displayed or requested from the user.
 */

export const LOOPBACK_HOST = '127.0.0.1';

export interface LoopbackCallback {
  code: string;
  /** Scopes echoed by Google on the callback, when present. */
  scope: string | null;
}

export interface LoopbackServer {
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  /** `http://127.0.0.1:<port>` with no path, as documented for Desktop clients. */
  readonly redirectUri: string;
  address(): AddressInfo;
  waitForCallback(): Promise<LoopbackCallback>;
  close(): Promise<void>;
  readonly closed: boolean;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab); // keep timing roughly uniform
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function page(title: string, body: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;line-height:1.5"><h1>${esc(title)}</h1><p>${esc(body)}</p></body></html>`;
}

function reply(res: ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    connection: 'close',
  });
  res.end(page(title, body));
}

export async function startLoopbackServer(opts: { expectedState: string; timeoutMs: number }): Promise<LoopbackServer> {
  if (!opts.expectedState || opts.expectedState.length < 16) throw new ValidationError('OAuth state must be a high-entropy value');
  let settled = false;
  let resolveCb!: (v: LoopbackCallback) => void;
  let rejectCb!: (e: unknown) => void;
  const result = new Promise<LoopbackCallback>((res, rej) => {
    resolveCb = res;
    rejectCb = rej;
  });
  // Avoid unhandled rejections when the caller has not attached yet.
  result.catch(() => undefined);

  let port = 0;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (settled) {
      reply(res, 410, 'Already completed', 'This authorization attempt has already finished. Return to the terminal.');
      return;
    }
    if (req.method !== 'GET') {
      reply(res, 405, 'Method not allowed', 'Only the Google redirect is accepted here.');
      return;
    }
    // DNS-rebinding guard: only the literal loopback host is accepted.
    if (req.headers.host !== `${LOOPBACK_HOST}:${port}`) {
      reply(res, 400, 'Bad request', 'Unexpected Host header.');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}:${port}`);
    if (url.pathname !== '/') {
      reply(res, 404, 'Not found', 'Nothing here.');
      return;
    }
    const error = url.searchParams.get('error');
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!state || !constantTimeEqual(state, opts.expectedState)) {
      settle(() => rejectCb(new ValidationError('OAuth state mismatch: the callback was rejected (possible CSRF or a stale browser tab). Run `auth google` again.')));
      reply(res, 400, 'Authorization rejected', 'The request could not be verified (state mismatch). Return to the terminal and start again.');
      return;
    }
    if (error) {
      settle(() => rejectCb(new AppError('PERMISSION_DENIED', `Google authorization was not granted (${error}).`, { hint: 'Run `npm run cli -- auth google` again and approve both read-only permissions.' })));
      reply(res, 400, 'Authorization not granted', 'Google reported that authorization was not granted. You can close this tab and return to the terminal.');
      return;
    }
    if (!code) {
      settle(() => rejectCb(new ValidationError('The OAuth callback did not include an authorization code.')));
      reply(res, 400, 'Authorization failed', 'No authorization code was received. Return to the terminal.');
      return;
    }
    settle(() => resolveCb({ code, scope: url.searchParams.get('scope') }));
    reply(res, 200, 'Authorization received', 'seo-agent received the authorization. You can close this tab and return to the terminal.');
  });

  const doClose = (): Promise<void> =>
    new Promise((resolve) => {
      if (closed) return resolve();
      closed = true;
      if (timer) clearTimeout(timer);
      server.close(() => resolve());
      server.closeIdleConnections?.();
      setTimeout(() => server.closeAllConnections?.(), 250).unref();
    });

  function settle(fn: () => void): void {
    if (settled) return;
    settled = true;
    fn();
    // Close after the response has been flushed.
    setImmediate(() => void doClose());
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  port = addr.port;
  timer = setTimeout(() => settle(() => rejectCb(new AppError('TIMEOUT', `No OAuth callback received within ${Math.round(opts.timeoutMs / 1000)}s; the local listener was closed.`, { hint: 'Run `npm run cli -- auth google` again and complete the consent in your browser.' }))), opts.timeoutMs);
  timer.unref();

  return {
    host: LOOPBACK_HOST,
    port,
    redirectUri: `http://${LOOPBACK_HOST}:${port}`,
    address: () => addr,
    waitForCallback: () => result,
    close: doClose,
    get closed() {
      return closed;
    },
  };
}
