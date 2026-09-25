import type { FetchLike } from '../../src/integrations/types.js';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export type Route = (req: RecordedRequest) => Response | Promise<Response> | undefined;

/**
 * Programmable fake fetch for adapter tests. Routes are tried in order; the
 * first one returning a Response wins. Unmatched requests throw.
 */
export function fakeFetch(routes: Route[]): FetchLike & { calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const req: RecordedRequest = {
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      body: typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : null,
    };
    calls.push(req);
    for (const r of routes) {
      const res = await r(req);
      if (res) return res;
    }
    throw new Error(`fakeFetch: no route for ${req.method} ${req.url}`);
  }) as FetchLike & { calls: RecordedRequest[] };
  fn.calls = calls;
  return fn;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function match(method: string, urlPattern: RegExp | string, respond: (req: RecordedRequest) => Response | Promise<Response>): Route {
  return (req) => {
    const ok = req.method === method.toUpperCase() && (typeof urlPattern === 'string' ? req.url.startsWith(urlPattern) : urlPattern.test(req.url));
    return ok ? respond(req) : undefined;
  };
}
