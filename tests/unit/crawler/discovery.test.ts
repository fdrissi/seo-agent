import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { fetchRobots, parseRobots, RobotsPolicy, userAgentToken } from '../../../src/crawler/robots.js';
import { decodeXmlEntities, discoverSitemaps, parseSitemapXml } from '../../../src/crawler/sitemaps.js';
import { fixtureTransport, type FixtureResponse } from '../../../src/crawler/transport.js';
import { isCalendarLike, matchesAnyPath, matchesPathPattern, TrapDetector } from '../../../src/crawler/traps.js';
import { FAKE_PUBLIC_IP, mapResolver, testFetcher } from '../../integration/crawler/helpers.js';

const ORIGIN = 'https://www.example.com';

function fetcherFor(routes: Record<string, FixtureResponse>, extra: Record<string, string> = {}) {
  return testFetcher({ resolver: mapResolver({ 'www.example.com': FAKE_PUBLIC_IP, ...extra }), transport: fixtureTransport(routes), loopback: false });
}

describe('robots.txt', () => {
  const text = 'User-agent: *\nDisallow: /private/\nAllow: /private/open\nCrawl-delay: 3\n\nUser-agent: seo-agent\nDisallow: /no-agent/\n\nSitemap: https://www.example.com/sm.xml\nSitemap: https://www.example.com/sm.xml\n';

  it('derives the product token from the user agent', () => {
    expect(userAgentToken('seo-agent/0.1 (+self-hosted; respects robots.txt)')).toBe('seo-agent');
    expect(userAgentToken('MyBot')).toBe('mybot');
  });

  it('applies the matching group, sitemaps, and crawl-delay', () => {
    const p = parseRobots(ORIGIN, text, 'seo-agent/0.1');
    const policy = new RobotsPolicy(p, p.parser, 'seo-agent');
    expect(policy.isAllowed(`${ORIGIN}/no-agent/x`).allowed).toBe(false);
    expect(policy.isAllowed(`${ORIGIN}/private/x`).allowed).toBe(true); // seo-agent group has its own rules
    const other = parseRobots(ORIGIN, text, 'otherbot/1.0');
    const otherPolicy = new RobotsPolicy(other, other.parser, 'otherbot');
    const d = otherPolicy.isAllowed(`${ORIGIN}/private/x`);
    expect(d.allowed).toBe(false);
    expect(d.line).toBe(2);
    expect(otherPolicy.isAllowed(`${ORIGIN}/private/open`).allowed).toBe(true);
    expect(other.crawlDelayMs).toBe(3000);
    expect(p.sitemaps).toEqual(['https://www.example.com/sm.xml']);
    expect(otherPolicy.isAllowed('https://other.example.com/').allowed).toBe(false);
    expect(otherPolicy.isAllowed(`${ORIGIN}/robots.txt`).allowed).toBe(true);
  });

  it.each([
    [{ status: 200, headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nDisallow: /\n' }, 'parsed', false],
    [{ status: 404, headers: { 'content-type': 'text/html' }, body: 'nope' }, 'not_found', true],
    [{ status: 410, body: '' }, 'not_found', true],
    [{ status: 500, body: '' }, 'unreachable', false],
    [{ status: 429, body: '' }, 'unreachable', false],
    [{ status: 503, headers: { 'retry-after': '99999' }, body: '' }, 'unreachable', false],
  ] as const)('fetch outcome %# -> %s (home allowed: %s)', async (resp, state, homeAllowed) => {
    const f = fetcherFor({ [`${ORIGIN}/robots.txt`]: resp as FixtureResponse });
    const policy = await fetchRobots(f, ORIGIN);
    expect(policy.info.state).toBe(state);
    expect(policy.isAllowed(`${ORIGIN}/`).allowed).toBe(homeAllowed);
  });

  it('treats an unsafe robots destination as fully disallowed', async () => {
    const f = testFetcher({ resolver: mapResolver({ 'www.example.com': '10.0.0.1' }), transport: fixtureTransport({}), loopback: false });
    const policy = await fetchRobots(f, ORIGIN);
    expect(policy.info.state).toBe('unsafe');
    expect(policy.isAllowed(`${ORIGIN}/`).allowed).toBe(false);
  });
});

describe('sitemaps', () => {
  it('parses urlset, sitemapindex, entities, and ignores DOCTYPE entity declarations', () => {
    const urlset = parseSitemapXml('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc> https://www.example.com/a?x=1&amp;y=2 </loc><lastmod>2026-01-01</lastmod></url><url><loc>https://www.example.com/b</loc></url></urlset>');
    expect(urlset.kind).toBe('urlset');
    expect(urlset.entries).toEqual([
      { loc: 'https://www.example.com/a?x=1&y=2', lastmod: '2026-01-01' },
      { loc: 'https://www.example.com/b', lastmod: null },
    ]);
    const idx = parseSitemapXml('<sitemapindex><sitemap><loc>https://www.example.com/s1.xml</loc></sitemap></sitemapindex>');
    expect(idx).toEqual({ kind: 'sitemapindex', entries: [{ loc: 'https://www.example.com/s1.xml', lastmod: null }] });
    const bomb = parseSitemapXml('<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><urlset><url><loc>https://www.example.com/&lol2;</loc></url></urlset>');
    expect(bomb.entries[0]!.loc).toBe('https://www.example.com/&lol2;');
    expect(parseSitemapXml('<html><body>not xml</body></html>').kind).toBe('unknown');
    expect(decodeXmlEntities('a&#38;b&#x26;c&lt;')).toBe('a&b&c<');
  });

  it('follows robots Sitemap lines and /sitemap.xml with bounded traversal, gzip, and off-host filtering', async () => {
    const xml = (locs: string[]) => `<urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join('')}</urlset>`;
    const routes: Record<string, FixtureResponse> = {
      [`${ORIGIN}/robots.txt`]: { headers: { 'content-type': 'text/plain' }, body: `User-agent: *\nDisallow: /blocked/\nSitemap: ${ORIGIN}/index.xml\nSitemap: https://cdn.example.net/remote.xml` },
      [`${ORIGIN}/index.xml`]: { headers: { 'content-type': 'application/xml' }, body: `<sitemapindex><sitemap><loc>${ORIGIN}/a.xml</loc></sitemap><sitemap><loc>${ORIGIN}/b.xml.gz</loc></sitemap><sitemap><loc>${ORIGIN}/c.xml</loc></sitemap><sitemap><loc>${ORIGIN}/blocked/d.xml</loc></sitemap></sitemapindex>` },
      [`${ORIGIN}/a.xml`]: { headers: { 'content-type': 'text/xml' }, body: xml([`${ORIGIN}/p1`, `${ORIGIN}/p2`, 'https://offsite.example.org/x', `${ORIGIN}/p1`]) },
      [`${ORIGIN}/b.xml.gz`]: { headers: { 'content-type': 'application/gzip' }, body: gzipSync(xml([`${ORIGIN}/g1`, `${ORIGIN}/g2`])) },
      [`${ORIGIN}/c.xml`]: { headers: { 'content-type': 'application/xml' }, body: xml([`${ORIGIN}/c1`]) },
      [`${ORIGIN}/sitemap.xml`]: { status: 404, body: '' },
    };
    const f = fetcherFor(routes, { 'cdn.example.net': FAKE_PUBLIC_IP });
    const robots = await fetchRobots(f, ORIGIN);
    const d = await discoverSitemaps(f, { origin: ORIGIN, robots, allowedHostnames: ['www.example.com'], limits: { maxFiles: 10, maxUrls: 100, maxBytes: 100_000 } });
    expect(d.urls.map((u) => u.loc)).toEqual([`${ORIGIN}/p1`, `${ORIGIN}/p2`, `${ORIGIN}/g1`, `${ORIGIN}/g2`, `${ORIGIN}/c1`]);
    expect(d.skippedOffHost).toBe(1);
    const rec = (u: string) => d.files.find((x) => x.url === u)!;
    expect(rec('https://cdn.example.net/remote.xml').reason).toMatch(/outside allowedHostnames/);
    expect(rec(`${ORIGIN}/b.xml.gz`).gzip).toBe(true);
    expect(rec(`${ORIGIN}/blocked/d.xml`).reason).toMatch(/not allowed/);
    expect(rec(`${ORIGIN}/sitemap.xml`).status).toBe('skipped');
    expect(rec(`${ORIGIN}/index.xml`).kind).toBe('sitemapindex');
  });

  it('enforces max files, max URLs, and gzip size limits with recorded reasons', async () => {
    const many = `<urlset>${Array.from({ length: 50 }, (_, i) => `<url><loc>${ORIGIN}/u${i}</loc></url>`).join('')}</urlset>`;
    const bigGz = gzipSync(`<urlset>${'<url><loc>https://www.example.com/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz</loc></url>'.repeat(5_000)}</urlset>`);
    const routes: Record<string, FixtureResponse> = {
      [`${ORIGIN}/robots.txt`]: { headers: { 'content-type': 'text/plain' }, body: `Sitemap: ${ORIGIN}/big.xml.gz\nSitemap: ${ORIGIN}/many.xml\nSitemap: ${ORIGIN}/third.xml\nSitemap: ${ORIGIN}/fourth.xml` },
      [`${ORIGIN}/big.xml.gz`]: { headers: { 'content-type': 'application/gzip' }, body: bigGz },
      [`${ORIGIN}/many.xml`]: { headers: { 'content-type': 'application/xml' }, body: many },
      [`${ORIGIN}/third.xml`]: { headers: { 'content-type': 'application/xml' }, body: many },
    };
    const f = fetcherFor(routes);
    const robots = await fetchRobots(f, ORIGIN);
    const d = await discoverSitemaps(f, { origin: ORIGIN, robots, allowedHostnames: ['www.example.com'], limits: { maxFiles: 3, maxUrls: 20, maxBytes: 50_000 } });
    expect(bigGz.length).toBeLessThan(50_000);
    expect(d.files.find((x) => x.url.endsWith('big.xml.gz'))!.reason).toMatch(/gzip sitemap skipped: decompressed size exceeds the byte limit/);
    expect(d.urls).toHaveLength(20);
    expect(d.truncated).toBe(true);
    expect(d.files.find((x) => x.url.endsWith('third.xml'))!.reason).toMatch(/max sitemap URLs/);
    expect(d.files.find((x) => x.url.endsWith('fourth.xml'))!.reason).toMatch(/max sitemap (files|URLs)/);
    expect(d.notes.join(' ')).toMatch(/truncated/);
  });

  it('bounds nested sitemap index depth', async () => {
    const routes: Record<string, FixtureResponse> = {
      [`${ORIGIN}/robots.txt`]: { status: 404, body: '' },
      [`${ORIGIN}/sitemap.xml`]: { headers: { 'content-type': 'application/xml' }, body: `<sitemapindex><sitemap><loc>${ORIGIN}/l1.xml</loc></sitemap></sitemapindex>` },
      [`${ORIGIN}/l1.xml`]: { headers: { 'content-type': 'application/xml' }, body: `<sitemapindex><sitemap><loc>${ORIGIN}/l2.xml</loc></sitemap></sitemapindex>` },
      [`${ORIGIN}/l2.xml`]: { headers: { 'content-type': 'application/xml' }, body: `<sitemapindex><sitemap><loc>${ORIGIN}/l3.xml</loc></sitemap></sitemapindex>` },
    };
    const f = fetcherFor(routes);
    const robots = await fetchRobots(f, ORIGIN);
    const d = await discoverSitemaps(f, { origin: ORIGIN, robots, allowedHostnames: ['www.example.com'], limits: { maxFiles: 10, maxUrls: 10, maxBytes: 10_000, maxDepth: 1 } });
    expect(d.files.find((x) => x.url.endsWith('l1.xml'))!.reason).toMatch(/deeper than 1/);
    expect(d.files.some((x) => x.url.endsWith('l2.xml'))).toBe(false);
    expect(d.notes[0]).toMatch(/no Sitemap: lines/);
  });
});

describe('crawler traps', () => {
  it('refuses repeated path segments, session ids, long URLs, and too many parameters', () => {
    const t = new TrapDetector();
    expect(t.check('https://www.example.com/a/b/a/b/a/b').trap).toBe(true);
    expect(t.check('https://www.example.com/x/x/x').trap).toBe(true);
    expect(t.check('https://www.example.com/a/b/a/b').trap).toBe(false);
    expect(t.check('https://www.example.com/p;jsessionid=ABC').trap).toBe(true);
    expect(t.check('https://www.example.com/p?PHPSESSID=abc').trap).toBe(true);
    expect(t.check(`https://www.example.com/${'a'.repeat(2100)}`).trap).toBe(true);
    expect(t.check('https://www.example.com/s?a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9').trap).toBe(true);
    expect(t.check(`https://www.example.com/${Array.from({ length: 16 }, (_, i) => `s${i}`).join('/')}`).trap).toBe(true);
    expect(t.hits.length).toBe(7);
  });

  it('caps query-string variants per path (parameter explosion)', () => {
    const t = new TrapDetector({ maxQueryVariantsPerPath: 3 });
    const res = ['red', 'blue', 'green', 'pink'].map((c) => t.check(`https://www.example.com/filter?color=${c}`).trap);
    expect(res).toEqual([false, false, false, true]);
    expect(t.check('https://www.example.com/filter?color=red').trap).toBe(false); // already accepted variant
  });

  it('caps calendar-like URL templates', () => {
    const t = new TrapDetector({ maxCalendarVariantsPerTemplate: 3 });
    const res = [1, 2, 3, 4, 5].map((m) => t.check(`https://www.example.com/calendar/2026/${m}`));
    expect(res.map((r) => r.trap)).toEqual([false, false, false, true, true]);
    expect((res[3] as { reason: string }).reason).toMatch(/calendar/);
    expect(isCalendarLike(new URL('https://www.example.com/events?date=2026-10-01'))).toBe(true);
    expect(isCalendarLike(new URL('https://www.example.com/blog/2024/05/my-post'))).toBe(true);
    expect(isCalendarLike(new URL('https://www.example.com/blog/my-post'))).toBe(false);
  });

  it('caps numeric URL templates (pagination/ID explosions)', () => {
    const t = new TrapDetector({ maxNumericTemplateVariants: 2 });
    expect([1, 2, 3].map((p) => t.check(`https://www.example.com/list/page/${p}`).trap)).toEqual([false, false, true]);
  });

  it('matches excluded/protected path patterns', () => {
    expect(matchesPathPattern('/admin', '/admin')).toBe(true);
    expect(matchesPathPattern('/admin/users', '/admin')).toBe(true);
    expect(matchesPathPattern('/administrator', '/admin')).toBe(false);
    expect(matchesPathPattern('/tmp/x/y', '/tmp/*')).toBe(true);
    expect(matchesPathPattern('/files/a.pdf', '*.pdf')).toBe(true);
    expect(matchesAnyPath('/cart', ['/checkout', '/cart'])).toBe('/cart');
    expect(matchesAnyPath('/blog', ['/checkout'])).toBeNull();
  });
});
