import { describe, expect, it } from 'vitest';
import { classifyIp, checkHostname, parseIPv6, pinnedLookup, SsrfGuard, UnsafeUrlError } from '../../../src/security/ssrf.js';
import { FAKE_PUBLIC_IP, mapResolver } from '../../integration/crawler/helpers.js';

const publicGuard = () => new SsrfGuard({ resolver: mapResolver({ 'www.example.com': FAKE_PUBLIC_IP }) });

async function reasonFor(guard: SsrfGuard, url: string): Promise<string | null> {
  const r = await guard.check(url);
  return r.ok ? null : r.error.reason;
}

describe('classifyIp', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'metadata'],
    ['169.254.170.2', 'metadata'],
    ['169.254.10.10', 'link_local'],
    ['100.64.0.1', 'cgnat'],
    ['100.100.100.200', 'metadata'],
    ['168.63.129.16', 'metadata'],
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['240.0.0.1', 'reserved'],
    ['198.18.0.1', 'benchmarking'],
    ['192.0.2.1', 'documentation'],
    ['203.0.113.9', 'documentation'],
    ['192.0.0.8', 'reserved'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link_local'],
    ['fc00::1', 'unique_local'],
    ['fd12:3456::1', 'unique_local'],
    ['fd00:ec2::254', 'metadata'],
    ['fec0::1', 'site_local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['0:0:0:0:0:ffff:a9fe:a9fe', 'metadata'],
    ['::ffff:10.0.0.1', 'private'],
    ['64:ff9b::a9fe:a9fe', 'metadata'],
    ['64:ff9b::7f00:1', 'loopback'],
    ['::127.0.0.1', 'ipv4_embedding'],
    ['2002:7f00:1::1', 'ipv4_embedding'],
    ['2001:0:4136:e378::1', 'reserved'],
    ['100::1', 'reserved'],
  ])('blocks %s as %s', (ip, category) => {
    const c = classifyIp(ip);
    expect(c.allowed).toBe(false);
    expect(c.category).toBe(category);
  });

  it('refuses IPv4-mapped IPv6 even when the embedded address is public', () => {
    const c = classifyIp('::ffff:8.8.8.8');
    expect(c.allowed).toBe(false);
    expect(c.embedded?.allowed).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '2a00:1450:4001::200e'])('allows public %s', (ip) => {
    expect(classifyIp(ip).allowed).toBe(true);
  });

  it('parses compressed and embedded IPv6 forms', () => {
    expect(parseIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIPv6('[fe80::1%eth0]')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('1::2::3')).toBeNull();
    expect(classifyIp('not-an-ip').allowed).toBe(false);
  });
});

describe('hostname rules', () => {
  it.each([
    ['localhost', 'blocked_hostname'],
    ['LOCALHOST.', 'blocked_hostname'],
    ['api.localhost', 'blocked_hostname'],
    ['printer.local', 'blocked_hostname'],
    ['db.internal', 'blocked_hostname'],
    ['router.home.arpa', 'blocked_hostname'],
    ['metadata.google.internal', 'metadata_endpoint'],
    ['metadata.goog', 'metadata_endpoint'],
    ['metadata', 'metadata_endpoint'],
    ['instance-data.ec2.internal', 'metadata_endpoint'],
    ['intranet', 'single_label_host'],
    ['host.docker.internal', 'blocked_hostname'],
  ])('%s -> %s', (host, reason) => {
    expect(checkHostname(host)?.reason).toBe(reason);
  });
  it('allows normal public hostnames', () => {
    expect(checkHostname('www.example.com')).toBeNull();
  });
});

describe('SsrfGuard.validate', () => {
  it.each([
    ['http://2130706433/', 'blocked_ip'], // decimal-encoded 127.0.0.1
    ['http://0x7f000001/', 'blocked_ip'], // hex
    ['http://0177.0.0.1/', 'blocked_ip'], // octal
    ['http://017700000001/', 'blocked_ip'], // octal dword
    ['http://127.1/', 'blocked_ip'], // short form
    ['http://0/', 'blocked_ip'],
    ['http://[::1]/', 'blocked_ip'],
    ['http://[::ffff:127.0.0.1]/', 'blocked_ip'],
    ['http://[::ffff:a9fe:a9fe]/latest/meta-data/', 'metadata_endpoint'],
    ['http://169.254.169.254/latest/meta-data/', 'metadata_endpoint'],
    ['http://[fd00:ec2::254]/', 'metadata_endpoint'],
    ['http://10.0.0.5/admin', 'blocked_ip'],
    ['http://192.168.0.1/', 'blocked_ip'],
    ['http://100.64.1.1/', 'blocked_ip'],
    ['http://localhost/', 'blocked_hostname'],
    ['http://localhost.:80/', 'blocked_hostname'],
    ['http://metadata.google.internal/computeMetadata/v1/', 'metadata_endpoint'],
    ['http://intranet/', 'single_label_host'],
    ['file:///etc/passwd', 'unsupported_scheme'],
    ['ftp://www.example.com/', 'unsupported_scheme'],
    ['gopher://www.example.com:70/', 'unsupported_scheme'],
    ['javascript:alert(1)', 'unsupported_scheme'],
    ['data:text/html,<script>1</script>', 'unsupported_scheme'],
    ['http://user:pass@www.example.com/', 'credentials_in_url'],
    ['http://www.example.com:8080/', 'blocked_port'],
    ['http://www.example.com:22/', 'blocked_port'],
    ['not a url', 'invalid_url'],
  ])('refuses %s (%s)', async (url, reason) => {
    expect(await reasonFor(publicGuard(), url)).toBe(reason);
  });

  it('accepts a public host on a default port and returns the validated addresses', async () => {
    const t = await publicGuard().validate('https://www.example.com/path?q=1');
    expect(t.addresses).toEqual([{ address: FAKE_PUBLIC_IP, family: 4 }]);
    expect(t.port).toBe(443);
    expect(t.hostname).toBe('www.example.com');
  });

  it('allows explicitly allowlisted non-default ports only', async () => {
    const resolver = mapResolver({ 'www.example.com': FAKE_PUBLIC_IP, 'other.example.com': FAKE_PUBLIC_IP });
    const g = new SsrfGuard({ resolver, allowedHostPorts: ['www.example.com:8443'] });
    expect((await g.check('https://www.example.com:8443/')).ok).toBe(true);
    expect(await reasonFor(g, 'https://other.example.com:8443/')).toBe('blocked_port');
    const g2 = new SsrfGuard({ resolver, allowedPorts: [8080] });
    expect((await g2.check('http://other.example.com:8080/')).ok).toBe(true);
  });

  it('revalidates DNS answers: private, mixed, metadata, IPv6 loopback, and failures are refused', async () => {
    const resolver = mapResolver({
      'private.example.com': '10.0.0.7',
      'mixed.example.com': [FAKE_PUBLIC_IP, '192.168.1.10'],
      'meta.example.com': '169.254.169.254',
      'v6.example.com': '::1',
      'mapped.example.com': '::ffff:127.0.0.1',
      'empty.example.com': [],
      'nip.example.com': '127.0.0.1',
    });
    const g = new SsrfGuard({ resolver });
    expect(await reasonFor(g, 'http://private.example.com/')).toBe('dns_blocked_ip');
    expect(await reasonFor(g, 'http://mixed.example.com/')).toBe('dns_blocked_ip');
    expect(await reasonFor(g, 'http://meta.example.com/')).toBe('metadata_endpoint');
    expect(await reasonFor(g, 'http://v6.example.com/')).toBe('dns_blocked_ip');
    expect(await reasonFor(g, 'http://mapped.example.com/')).toBe('dns_blocked_ip');
    expect(await reasonFor(g, 'http://empty.example.com/')).toBe('dns_failure');
    expect(await reasonFor(g, 'http://unknown.example.com/')).toBe('dns_failure');
    expect(await reasonFor(g, 'http://nip.example.com/')).toBe('dns_blocked_ip');
  });

  it('times out slow DNS', async () => {
    const g = new SsrfGuard({ resolver: () => new Promise(() => undefined), dnsTimeoutMs: 50 });
    expect(await reasonFor(g, 'http://slow.example.com/')).toBe('dns_failure');
  });

  it('throws a typed UnsafeUrlError with code UNSAFE_URL', async () => {
    await expect(publicGuard().validate('http://127.0.0.1/')).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(publicGuard().validate('http://127.0.0.1/')).rejects.toMatchObject({ code: 'UNSAFE_URL' });
  });
});

describe('test-only loopback escape hatch', () => {
  const resolver = mapResolver({ 'site.test': '127.0.0.1', 'other.test': '127.0.0.2', 'meta.test': '169.254.169.254', 'priv.test': '10.0.0.1' });
  it('is off by default', async () => {
    expect(await reasonFor(new SsrfGuard({ resolver }), 'http://site.test/')).toBe('dns_blocked_ip');
    expect(await reasonFor(new SsrfGuard({ resolver }), 'http://127.0.0.1:8080/')).toBe('blocked_ip');
  });
  it('permits exactly 127.0.0.1 (any port) and nothing else', async () => {
    const g = new SsrfGuard({ resolver, testOnlyAllowLoopback: true });
    expect((await g.check('http://site.test:54321/')).ok).toBe(true);
    expect((await g.check('http://127.0.0.1:54321/')).ok).toBe(true);
    expect(await reasonFor(g, 'http://other.test/')).toBe('dns_blocked_ip');
    expect(await reasonFor(g, 'http://meta.test/')).toBe('metadata_endpoint');
    expect(await reasonFor(g, 'http://priv.test/')).toBe('dns_blocked_ip');
    expect(await reasonFor(g, 'http://[::1]:5000/')).toBe('blocked_ip');
    expect(await reasonFor(g, 'http://169.254.169.254/')).toBe('metadata_endpoint');
    expect(await reasonFor(g, 'http://localhost:5000/')).toBe('blocked_hostname');
    expect(g.describe().testOnlyAllowLoopback).toBe(true);
  });
  it('does not open non-default ports for non-loopback answers', async () => {
    const g = new SsrfGuard({ resolver: mapResolver({ 'www.example.com': FAKE_PUBLIC_IP }), testOnlyAllowLoopback: true });
    expect(await reasonFor(g, 'http://www.example.com:8080/')).toBe('blocked_port');
  });
});

describe('pinnedLookup', () => {
  it('answers only with validated addresses and fails closed for other hosts', async () => {
    const g = publicGuard();
    const target = await g.validate('https://www.example.com/');
    const lookup = pinnedLookup(target);
    const all = await new Promise<unknown>((resolve, reject) => lookup('www.example.com', { all: true }, (err, addr) => (err ? reject(err) : resolve(addr))));
    expect(all).toEqual([{ address: FAKE_PUBLIC_IP, family: 4 }]);
    const single = await new Promise<unknown>((resolve, reject) => lookup('www.example.com', {}, (err, addr, fam) => (err ? reject(err) : resolve([addr, fam]))));
    expect(single).toEqual([FAKE_PUBLIC_IP, 4]);
    await expect(new Promise((resolve, reject) => lookup('evil.example.com', {}, (err, addr) => (err ? reject(err) : resolve(addr))))).rejects.toThrow(/unexpected lookup/);
    await expect(new Promise((resolve, reject) => lookup('www.example.com', { family: 6 }, (err, addr) => (err ? reject(err) : resolve(addr))))).rejects.toThrow(/no validated IPv6/);
  });

  it('never calls back synchronously, on the success or the error paths (C3-01)', async () => {
    // A synchronous answer lets net/tls.connect() start (and fail) the connection before undici attaches
    // its 'error' listener, which crashes the process on EPERM/ENETUNREACH instead of rejecting.
    const target = await publicGuard().validate('https://www.example.com/');
    const lookup = pinnedLookup(target);
    const cases: Array<[string, unknown]> = [
      ['www.example.com', { all: true }],
      ['www.example.com', {}],
      ['www.example.com', { family: 4 }],
      ['www.example.com', { family: 6 }], // no validated IPv6 address: error path
      ['evil.example.com', {}], // unexpected hostname: error path
    ];
    for (const [host, options] of cases) {
      let returned = false;
      let calledBeforeReturn = false;
      const answered = new Promise<void>((resolve) => {
        lookup(host, options, () => {
          calledBeforeReturn = !returned;
          resolve();
        });
      });
      returned = true;
      await answered;
      expect(calledBeforeReturn, `${host} ${JSON.stringify(options)}`).toBe(false);
    }
    // The (hostname, callback) form used by some callers is asynchronous too.
    let returned = false;
    let sync = true;
    const done = new Promise<unknown[]>((resolve) => (lookup as unknown as (h: string, cb: (...a: unknown[]) => void) => void)('www.example.com', (...a) => {
      sync = !returned;
      resolve(a);
    }));
    returned = true;
    expect(await done).toEqual([null, FAKE_PUBLIC_IP, 4]);
    expect(sync).toBe(false);
  });
});
