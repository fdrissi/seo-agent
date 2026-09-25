import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchSafely } from '../../../src/crawler/fetch.js';
import { createPinnedTransport, fetchLikeTransport, type HttpTransport } from '../../../src/crawler/transport.js';
import { SsrfGuard } from '../../../src/security/ssrf.js';
import { fakeFetch } from '../../helpers/fake-fetch.js';
import { mapResolver, send, startServer, testFetcher, type TestServer } from './helpers.js';

let server: TestServer;
let flaky = 0;

beforeAll(async () => {
  server = await startServer(async (req, res, url) => {
    switch (url.pathname) {
      case '/ok':
        return send(res, 200, '<html><head><title>OK</title></head><body><p>hello</p></body></html>');
      case '/latin1':
        res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
        return res.end(Buffer.from('<html><body>caf\xe9</body></html>', 'latin1'));
      case '/r1':
        return send(res, 301, '', { location: '/r2' });
      case '/r2':
        return send(res, 302, '', { location: `http://site.test:${server.port}/ok` });
      case '/loop-a':
        return send(res, 302, '', { location: '/loop-b' });
      case '/loop-b':
        return send(res, 302, '', { location: '/loop-a' });
      case '/to-metadata':
        return send(res, 302, '', { location: 'http://169.254.169.254/latest/meta-data/' });
      case '/to-private-host':
        return send(res, 302, '', { location: `http://internal.test:${server.port}/ok` });
      case '/to-localhost':
        return send(res, 302, '', { location: `http://localhost:${server.port}/ok` });
      case '/to-file':
        return send(res, 302, '', { location: 'file:///etc/passwd' });
      case '/to-login':
        return send(res, 302, '', { location: '/login?return_to=%2Fdashboard' });
      case '/auth':
        return send(res, 401, 'auth required', { 'www-authenticate': 'Basic realm="x"' });
      case '/forbidden':
        return send(res, 403, 'no', { 'cf-mitigated': 'challenge' });
      case '/image':
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(Buffer.alloc(10));
      case '/big-declared':
        res.writeHead(200, { 'content-type': 'text/html', 'content-length': '5000000' });
        return res.end('x'.repeat(10)); // lies; body never read
      case '/big-stream': {
        res.writeHead(200, { 'content-type': 'text/html' }); // chunked, no content-length
        let sent = 0;
        const tick = () => {
          if (sent >= 2_000_000 || res.destroyed) return res.end();
          sent += 64_000;
          res.write('y'.repeat(64_000), tick);
        };
        return tick();
      }
      case '/slow-headers':
        await new Promise((r) => setTimeout(r, 1_500));
        return send(res, 200, 'late');
      case '/slow-body': {
        res.writeHead(200, { 'content-type': 'text/html' });
        const iv = setInterval(() => {
          if (res.destroyed) return clearInterval(iv);
          res.write('.');
        }, 100);
        res.on('close', () => clearInterval(iv));
        return;
      }
      case '/rate-limited':
        flaky++;
        if (flaky < 2) return send(res, 429, 'slow down', { 'retry-after': '1' });
        return send(res, 200, '<html><body>finally</body></html>');
      case '/always-429':
        return send(res, 429, 'slow down', { 'retry-after': '3600' });
      case '/always-429-short':
        return send(res, 429, 'slow down', { 'retry-after': '2' });
      default:
        return send(res, 404, 'not found');
    }
  });
});

afterAll(async () => {
  await server.close();
});

const resolver = () => mapResolver({ 'site.test': '127.0.0.1', 'internal.test': '10.1.2.3' });
const u = (p: string) => `${server.origin()}${p}`;

describe('fetchSafely against a local server (DNS-pinned undici transport)', () => {
  it('fetches allowed HTML, sends the configured user agent, and records the pinned connection', async () => {
    const f = testFetcher({ resolver: resolver() });
    const r = await f.fetch(u('/ok'), { accept: ['html'] });
    expect(r.status).toBe(200);
    expect(r.text).toContain('hello');
    expect(r.pinned).toBe(true);
    expect(r.blockedReason).toBeNull();
    expect(server.hits.at(-1)!.userAgent).toBe('seo-agent-test/1.0 (+synthetic tests)');
    expect(server.hits.at(-1)!.host).toBe('site.test');
  });

  it('decodes declared charsets', async () => {
    const r = await testFetcher({ resolver: resolver() }).fetch(u('/latin1'), { accept: ['html'] });
    expect(r.text).toContain('café');
  });

  it('records the full redirect chain and validates every hop', async () => {
    const r = await testFetcher({ resolver: resolver() }).fetch(u('/r1'), { accept: ['html'] });
    expect(r.status).toBe(200);
    expect(r.firstStatus).toBe(301);
    expect(r.finalUrl).toBe(u('/ok'));
    expect(r.redirectChain).toEqual([
      { url: u('/r1'), status: 301, location: u('/r2') },
      { url: u('/r2'), status: 302, location: u('/ok') },
    ]);
  });

  it('detects redirect loops and enforces the redirect maximum', async () => {
    const loop = await testFetcher({ resolver: resolver() }).fetch(u('/loop-a'), { accept: ['html'] });
    expect(loop.errorCode).toBe('redirect_loop');
    expect(loop.redirectChain).toHaveLength(2);
    const tooMany = await testFetcher({ resolver: resolver(), maxRedirects: 1 }).fetch(u('/r1'), { accept: ['html'] });
    expect(tooMany.errorCode).toBe('too_many_redirects');
  });

  it.each([
    ['/to-metadata', 'unsafe_url:metadata_endpoint'],
    ['/to-private-host', 'unsafe_url:dns_blocked_ip'],
    ['/to-localhost', 'unsafe_url:blocked_hostname'],
    ['/to-file', 'unsafe_url:unsupported_scheme'],
  ])('blocks a redirect to an unsafe destination (%s)', async (path, code) => {
    const before = server.hits.length;
    const r = await testFetcher({ resolver: resolver() }).fetch(u(path), { accept: ['html'] });
    expect(r.blockedReason).toBe('unsafe_url');
    expect(r.errorCode).toBe(code);
    expect(r.redirectChain).toHaveLength(1);
    expect(r.body).toBeNull();
    expect(server.hits.length - before).toBe(1); // only the first hop reached the server
  });

  it('stops at login barriers and access denials without trying to bypass them', async () => {
    const f = testFetcher({ resolver: resolver() });
    const login = await f.fetch(u('/to-login'), { accept: ['html'] });
    expect(login.blockedReason).toBe('login_required');
    expect(login.finalUrl).toContain('/login');
    expect(server.hits.some((h) => h.path.startsWith('/login'))).toBe(false);
    expect((await f.fetch(u('/auth'), { accept: ['html'] })).blockedReason).toBe('login_required');
    const denied = await f.fetch(u('/forbidden'), { accept: ['html'] });
    expect(denied.blockedReason).toBe('access_denied');
    expect(denied.note).toMatch(/bot-protection challenge/);
  });

  it('refuses content types outside the allowlist before reading the body', async () => {
    const r = await testFetcher({ resolver: resolver() }).fetch(u('/image'), { accept: ['html'] });
    expect(r.blockedReason).toBe('unsupported_content');
    expect(r.body).toBeNull();
  });

  it('enforces the byte cap from Content-Length and while streaming', async () => {
    const f = testFetcher({ resolver: resolver(), maxBytes: 100_000 });
    const declared = await f.fetch(u('/big-declared'), { accept: ['html'] });
    expect(declared.blockedReason).toBe('too_large');
    expect(declared.note).toMatch(/Content-Length/);
    const streamed = await f.fetch(u('/big-stream'), { accept: ['html'] });
    expect(streamed.blockedReason).toBe('too_large');
    expect(streamed.bytes).toBeGreaterThan(100_000);
    expect(streamed.bytes).toBeLessThan(2_000_000);
    expect(streamed.body).toBeNull();
  });

  it('enforces the overall timeout for slow headers and slow bodies', async () => {
    const f = testFetcher({ resolver: resolver(), timeoutMs: 400 });
    const a = await f.fetch(u('/slow-headers'), { accept: ['html'] });
    expect(a.blockedReason).toBe('timeout');
    const b = await f.fetch(u('/slow-body'), { accept: ['html'] });
    expect(b.blockedReason).toBe('timeout');
    expect(b.durationMs).toBeLessThan(2_500);
  });

  it('honours Retry-After on 429 and retries within bounds', async () => {
    flaky = 0;
    const f = testFetcher({ resolver: resolver() });
    const r = await f.fetch(u('/rate-limited'), { accept: ['html'] });
    expect(r.status).toBe(200);
    expect(r.attempts).toBe(2);
    expect(f.waits.some((w) => w.reason === 'retry_after' && w.ms === 1000)).toBe(true);
  });

  it('gives up honestly when Retry-After exceeds the limit and sends that host nothing more until then', async () => {
    const f = testFetcher({ resolver: resolver(), maxRetryAfterMs: 5_000 });
    const r = await f.fetch(u('/always-429'), { accept: ['html'] });
    expect(r.blockedReason).toBe('rate_limited');
    expect(r.retryAfterMs).toBe(3_600_000);
    expect(r.note).toMatch(/exceeds/);
    const host = new URL(u('/')).host;
    expect(f.rateLimitedStreak(host)).toBe(1);
    expect(f.hostBackoff(host)).toMatchObject({ note: expect.stringMatching(/Retry-After 3600s/) });
    // A later request to the same host is not sent at all, and nothing sleeps for an hour.
    const before = server.hits.length;
    const next = await f.fetch(u('/ok'), { accept: ['html'] });
    expect(server.hits.length).toBe(before);
    expect(next).toMatchObject({ blockedReason: 'rate_limited', attempts: 0, status: null });
    expect(next.note).toMatch(/Not requested: .* rate-limit back-off/);
    expect(f.slept.every((ms) => ms < 5_000)).toBe(true);
    expect(f.backoffHosts().map((b) => b.host)).toEqual([host]);
  });

  it('pushes the host back after exhausting rate-limit retries', async () => {
    const f = testFetcher({ resolver: resolver() });
    const first = await f.fetch(u('/always-429-short'), { accept: ['html'] });
    expect(first.blockedReason).toBe('rate_limited');
    expect(first.attempts).toBe(3);
    expect(first.note).toMatch(/gave up after 3 attempts/);
    // Every rate-limited outcome (including the final one) pushed the next request back.
    expect(f.waits.filter((w) => w.reason === 'retry_after' && w.ms === 2_000)).toHaveLength(3);
    await f.fetch(u('/ok'), { accept: ['html'] });
    expect(f.slept.at(-1)).toBeGreaterThan(0);
  });

  it('spaces requests to the same host by the politeness delay', async () => {
    const f = testFetcher({ resolver: resolver(), delayMs: 500, perHostConcurrency: 1 });
    await Promise.all([f.fetch(u('/ok'), { accept: ['html'] }), f.fetch(u('/ok'), { accept: ['html'] }), f.fetch(u('/ok'), { accept: ['html'] })]);
    const polite = f.waits.filter((w) => w.reason === 'politeness');
    expect(polite.length).toBe(2);
  });
});

describe('DNS rebinding protection', () => {
  it('pins the socket to the validated address: the resolver is consulted once per hop, never by the socket', async () => {
    const answers = [['127.0.0.1'], ['10.9.9.9']];
    let i = 0;
    const calls: string[] = [];
    const rebinding = mapResolver({ 'site.test': () => answers[Math.min(i++, answers.length - 1)]! }, calls);
    const f = testFetcher({ resolver: rebinding });
    const first = await f.fetch(u('/ok'), { accept: ['html'] });
    expect(first.status).toBe(200);
    expect(calls).toEqual(['site.test']); // the connection used the pinned 127.0.0.1 without a second lookup
    // The next request re-resolves and gets the rebinding answer: refused before any connection.
    const before = server.hits.length;
    const second = await f.fetch(u('/ok'), { accept: ['html'] });
    expect(second.blockedReason).toBe('unsafe_url');
    expect(second.errorCode).toBe('unsafe_url:dns_blocked_ip');
    expect(server.hits.length).toBe(before);
  });

  it('never connects when validation fails, even with a permissive fake transport', async () => {
    const fake = fakeFetch([() => new Response('should not be reached', { status: 200, headers: { 'content-type': 'text/html' } })]);
    const guard = new SsrfGuard({ resolver: mapResolver({ 'evil.example.com': '169.254.169.254' }) });
    const r = await fetchSafely('http://evil.example.com/', { guard, transport: fetchLikeTransport(fake), userAgent: 't', timeoutMs: 1000, maxBytes: 1000, maxRedirects: 3, accept: ['html'] });
    expect(r.blockedReason).toBe('unsafe_url');
    expect(fake.calls).toHaveLength(0);
    expect(r.pinned).toBe(false);
  });

  it('the pinned transport refuses to connect a hop whose hostname differs from the validated target', async () => {
    const guard = new SsrfGuard({ resolver: mapResolver({ 'site.test': '127.0.0.1' }), testOnlyAllowLoopback: true });
    const target = await guard.validate(u('/ok'));
    const tampered = { ...target, url: new URL(`http://other.test:${server.port}/ok`) };
    await expect(createPinnedTransport().send(tampered, { method: 'GET', headers: {}, signal: AbortSignal.timeout(2000) })).rejects.toThrow();
  });

  it('a connection the operating system refuses synchronously rejects the request instead of crashing the process (C3-01)', async () => {
    // An address whose family label does not match makes libuv fail connect() synchronously (EINVAL) before any
    // packet is sent: the same code path as EPERM from an egress firewall or ENETUNREACH. With a synchronous
    // lookup this emitted 'error' on a socket with no listener yet (uncaught exception); now it is a rejection.
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => void uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    try {
      const guard = new SsrfGuard({ resolver: mapResolver({ 'site.test': '127.0.0.1' }), testOnlyAllowLoopback: true });
      for (const scheme of ['http', 'https'] as const) {
        const target = await guard.validate(`${scheme}://site.test:${server.port}/ok`);
        const refused = { ...target, addresses: [{ address: '::1', family: 4 as const }] };
        await expect(createPinnedTransport().send(refused, { method: 'GET', headers: {}, signal: AbortSignal.timeout(2000) })).rejects.toThrow();
      }
      // Through the fetcher the failure is an ordinary network error result.
      const syncFail: HttpTransport = { kind: 'pinned', send: (t, init) => createPinnedTransport().send({ ...t, addresses: [{ address: '::1', family: 4 }] }, init) };
      const r = await testFetcher({ resolver: mapResolver({ 'site.test': '127.0.0.1' }), transport: syncFail }).fetch(u('/ok'), { accept: ['html'] });
      expect(r.status).toBeNull();
      expect(r.errorCode).toBe('network_error');
      await new Promise((resolve) => setTimeout(resolve, 50)); // let any stray socket 'error' surface
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });
});

describe('content sniffing without a Content-Type', () => {
  it('accepts markup and refuses binary bodies', async () => {
    const guard = new SsrfGuard({ resolver: mapResolver({ 'www.example.com': '93.184.216.34' }) });
    const base = { guard, userAgent: 't', timeoutMs: 1000, maxBytes: 10_000, maxRedirects: 2, accept: ['html'] as const };
    const html = fakeFetch([() => new Response(new TextEncoder().encode('<!doctype html><html><body>ok</body></html>'), { status: 200, headers: {} }) /* bytes: no implicit Content-Type */]);
    const bin = fakeFetch([() => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]), { status: 200, headers: {} })]);
    const a = await fetchSafely('https://www.example.com/', { ...base, transport: fetchLikeTransport(html) });
    const b = await fetchSafely('https://www.example.com/', { ...base, transport: fetchLikeTransport(bin) });
    expect(a.blockedReason).toBeNull();
    expect(a.text).toContain('ok');
    expect(b.blockedReason).toBe('unsupported_content');
    expect(b.body).toBeNull();
  });
});
