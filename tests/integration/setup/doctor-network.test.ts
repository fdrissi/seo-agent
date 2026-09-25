/**
 * `doctor --network` with the crawler enabled (SYNTHETIC). The crawler's
 * robots.txt check goes through the production DNS-pinned transport to a local
 * 127.0.0.1 test server; `www.example.test` is mapped to it by a fake resolver
 * with the SSRF guard's test-only loopback escape. Every provider request goes
 * to an injected fake fetch. No real network access.
 */
import { writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { siteConfigFile } from '../../../src/config/paths.js';
import { LayeredSecretStore } from '../../../src/config/secrets.js';
import type { SiteConfigInput } from '../../../src/config/site-schema.js';
import { createPinnedTransport, type HttpTransport } from '../../../src/crawler/transport.js';
import type { FetchLike } from '../../../src/integrations/types.js';
import { SsrfGuard } from '../../../src/security/ssrf.js';
import { runDoctor, type DoctorOptions, type DoctorReport } from '../../../src/setup/doctor.js';
import { mapResolver, send, startServer, type TestServer } from '../crawler/helpers.js';
import { makeWorkspace, type TestWorkspace } from './helpers.js';

let server: TestServer;
beforeAll(async () => {
  server = await startServer((_req, res, url) => {
    if (url.pathname === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /private/\n', { 'content-type': 'text/plain' });
    return send(res, 404, 'not found (synthetic)');
  });
});
afterAll(() => server.close());

let ws: TestWorkspace;
beforeEach(() => {
  ws = makeWorkspace({ migrate: true });
});
afterEach(() => ws.cleanup());

/** Synthetic site on the local test server's port (reserved example domain). Only the crawler is enabled. */
function writeSite(scheme: 'http' | 'https' = 'http'): void {
  const cfg = {
    profile: 'core',
    site: { id: 'doctor-net-test', businessName: 'Doctor Network Test (synthetic)', url: `${scheme}://www.example.test:${server.port}/`, allowedHostnames: ['www.example.test'] },
    google: { searchConsoleProperty: 'sc-domain:example.test', ga4PropertyId: '123456789' },
    features: { crawl: true, playwright: false, gsc: false, ga4: false, pagespeed: false, urlInspection: false, qdrant: false, dataforseo: false },
  } as SiteConfigInput;
  writeFileSync(siteConfigFile(ws.paths, cfg.site.id), stringify(cfg), { mode: 0o600 });
}

/** Provider requests (not the crawler) get a synthetic 503; the crawler never uses this fetch. */
const providerFetch: FetchLike = async () => new Response('unavailable (synthetic)', { status: 503 });

function doctor(crawlerTransport: HttpTransport, opts: Partial<DoctorOptions> = {}): Promise<DoctorReport> {
  const guard = new SsrfGuard({ resolver: mapResolver({ 'www.example.test': '127.0.0.1' }), testOnlyAllowLoopback: true });
  return runDoctor({
    paths: ws.paths,
    secrets: new LayeredSecretStore(ws.paths.secretsEnvFile, {}),
    network: true,
    fetch: providerFetch,
    node: { version: 'v24.9.0', lts: 'Krypton' },
    crawlerDeps: { guard, transport: crawlerTransport },
    ...opts,
  });
}

const crawler = (r: DoctorReport) => r.sites.flatMap((s) => s.integrations).find((s) => (s.id as string) === 'crawler');

describe('doctor --network: crawler robots.txt check', () => {
  it('fetches robots.txt through the DNS-pinned transport and reports the crawler ready', async () => {
    writeSite();
    const before = server.hits.length;
    const r = await doctor(createPinnedTransport({ connectTimeoutMs: 2_000 }));
    expect(crawler(r)).toMatchObject({ state: 'ready', networkChecked: true, chargeable: false });
    expect(crawler(r)!.detail).toMatch(/robots\.txt parsed; start URL allowed/);
    expect(server.hits.slice(before).map((h) => `${h.method} ${h.host}${h.path}`)).toEqual(['GET www.example.test/robots.txt']);
    expect(r.network.requests).toContainEqual({ method: 'GET', host: `www.example.test:${server.port}`, path: '/robots.txt' });
  });

  it('a connection refused synchronously by the operating system (egress firewall) is reported as unreachable, not a crash (C3-01)', async () => {
    // https: the TLS connect path is where a synchronous refusal used to escape as an uncaught socket 'error'.
    writeSite('https');
    // A mismatched address family makes libuv refuse connect() synchronously (EINVAL) before any packet is sent,
    // the same path as EPERM from a firewall. Before the fix this was an uncaught socket 'error'.
    const refused: HttpTransport = { kind: 'pinned', send: (t, init) => createPinnedTransport({ connectTimeoutMs: 2_000 }).send({ ...t, addresses: [{ address: '::1', family: 4 }] }, init) };
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => void uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    try {
      const before = server.hits.length;
      const r = await doctor(refused);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(uncaught).toEqual([]);
      expect(crawler(r)).toMatchObject({ state: 'unreachable', networkChecked: true });
      expect(crawler(r)!.detail).toMatch(/robots\.txt unreachable/);
      expect(server.hits.length).toBe(before); // nothing reached the server
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('without --network the crawler makes no request and says so', async () => {
    writeSite();
    const before = server.hits.length;
    const r = await doctor(createPinnedTransport({ connectTimeoutMs: 2_000 }), { network: false });
    expect(crawler(r)).toMatchObject({ state: 'configured_unverified', networkChecked: false });
    expect(server.hits.length).toBe(before);
    expect(r.network.requests).toEqual([]);
  });
});
