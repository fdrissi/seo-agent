import { describe, expect, it } from 'vitest';
import { describeUrlDifference, isAllowedHost, landingPathToUrl, matchesPathPattern, normalizePercentEncoding, normalizeUrl } from '../../../src/seo/url.js';

describe('normalizeUrl (conservative identity)', () => {
  it('removes tracking parameters but preserves meaningful ones in order and encoding', () => {
    const n = normalizeUrl('https://www.example.test/shop?utm_source=x&color=red&gclid=abc&size=M%2FL')!;
    expect(n.url).toBe('https://www.example.test/shop?color=red&size=M%2FL');
    expect(n.removedParams).toEqual(['utm_source', 'gclid']);
    expect(n.changes).toContain('tracking_params_removed');
  });

  it('keeps meaningful query parameters as distinct identities', () => {
    expect(normalizeUrl('https://www.example.test/p?id=1')!.url).not.toBe(normalizeUrl('https://www.example.test/p?id=2')!.url);
    expect(normalizeUrl('https://www.example.test/p?lang=de')!.url).not.toBe(normalizeUrl('https://www.example.test/p')!.url);
  });

  it('preserves path case, trailing slash, and locale paths', () => {
    expect(normalizeUrl('https://www.example.test/About')!.url).toBe('https://www.example.test/About');
    expect(normalizeUrl('https://www.example.test/about')!.url).not.toBe(normalizeUrl('https://www.example.test/About')!.url);
    expect(normalizeUrl('https://www.example.test/docs/')!.url).not.toBe(normalizeUrl('https://www.example.test/docs')!.url);
    expect(normalizeUrl('https://www.example.test/en/pricing')!.url).not.toBe(normalizeUrl('https://www.example.test/de/pricing')!.url);
  });

  it('never merges www/non-www or http/https', () => {
    expect(normalizeUrl('https://example.test/')!.url).not.toBe(normalizeUrl('https://www.example.test/')!.url);
    expect(normalizeUrl('http://www.example.test/')!.url).not.toBe(normalizeUrl('https://www.example.test/')!.url);
  });

  it('normalizes only definitional equivalences: host/scheme case, default port, fragment, empty query', () => {
    const n = normalizeUrl('HTTPS://WWW.Example.TEST:443/a?#frag')!;
    expect(n.url).toBe('https://www.example.test/a');
    expect(n.changes).toEqual(expect.arrayContaining(['host_case', 'scheme_case', 'default_port', 'fragment_removed', 'empty_query_removed']));
    expect(normalizeUrl('http://www.example.test:8080/a')!.url).toBe('http://www.example.test:8080/a');
  });

  it('normalizes percent-encoding hex case: lower-, upper-case and unencoded non-ASCII paths are one identity (B3-05)', () => {
    const lower = normalizeUrl('https://www.example.test/ru/%d0%bf%d1%80%d0%b8%d0%b2%d0%b5%d1%82?q=%c3%a9')!;
    const upper = normalizeUrl('https://www.example.test/ru/%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82?q=%C3%A9')!;
    const unencoded = normalizeUrl('https://www.example.test/ru/привет?q=é')!;
    expect(lower.url).toBe('https://www.example.test/ru/%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82?q=%C3%A9');
    expect(upper.url).toBe(lower.url);
    expect(unencoded.url).toBe(lower.url);
    expect(lower.path).toBe('/ru/%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82');
    expect(lower.pathWithQuery).toBe('/ru/%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82?q=%C3%A9');
    // Only an actual rewrite is recorded (the parser's own serialization of "привет" is not a change).
    expect(lower.changes).toEqual(['percent_encoding']);
    expect(upper.changes).toEqual([]);
    expect(unencoded.changes).toEqual([]);
  });

  it('decodes percent-encoded unreserved characters and keeps reserved ones encoded (RFC 3986 6.2.2.2)', () => {
    const n = normalizeUrl('https://www.example.test/%7Euser/%41b%2Dc%2E%5F?name=%7ejo%2e&dir=a%2fb&eq=%3d&amp=%26&plus=%2b&sp=%20&pct=%25')!;
    expect(n.url).toBe('https://www.example.test/~user/Ab-c._?name=~jo.&dir=a%2Fb&eq=%3D&amp=%26&plus=%2B&sp=%20&pct=%25');
    expect(n.changes).toEqual(['percent_encoding']);
    // Reserved characters stay distinct from their decoded form: "/a%2Fb" is not "/a/b".
    expect(normalizeUrl('https://www.example.test/a%2fb')!.url).toBe('https://www.example.test/a%2Fb');
    expect(normalizeUrl('https://www.example.test/a%2Fb')!.url).not.toBe(normalizeUrl('https://www.example.test/a/b')!.url);
    expect(normalizeUrl('https://www.example.test/p?x=a%26b')!.url).not.toBe(normalizeUrl('https://www.example.test/p?x=a&b')!.url);
    expect(normalizeUrl('https://www.example.test/%7Euser')!.url).toBe(normalizeUrl('https://www.example.test/~user')!.url);
  });

  it('leaves invalid percent sequences alone, stays idempotent, and still removes encoded tracking parameter names', () => {
    const bad = normalizeUrl('https://www.example.test/100%/x%zz?q=50%')!;
    expect(bad.url).toBe('https://www.example.test/100%/x%zz?q=50%');
    expect(bad.changes).toEqual([]);
    for (const raw of ['https://www.example.test/%d0%bf/%7e?x=%2f', 'https://www.example.test/a%2Eb/%2e%2ehidden', 'https://www.example.test/100%/x%zz']) {
      const once = normalizeUrl(raw)!;
      expect(normalizeUrl(once.url)!.url).toBe(once.url);
      expect(normalizeUrl(once.url)!.changes).toEqual([]);
    }
    const t = normalizeUrl('https://www.example.test/p?utm%5Fsource=x&k=%e2%82%ac')!;
    expect(t.url).toBe('https://www.example.test/p?k=%E2%82%AC');
    expect(t.removedParams).toEqual(['utm_source']);
    expect(t.changes).toEqual(['tracking_params_removed', 'percent_encoding']);
  });

  it('normalizePercentEncoding: uppercase hex, decode only unreserved triplets', () => {
    expect(normalizePercentEncoding('/%d0%bf%2f%7e%41%30%2d%2e%5f%3a')).toBe('/%D0%BF%2F~A0-._%3A');
    expect(normalizePercentEncoding('/plain/path')).toBe('/plain/path');
    expect(normalizePercentEncoding('/50%/%g1')).toBe('/50%/%g1');
  });

  it('rejects non-http(s) and garbage', () => {
    expect(normalizeUrl('ftp://example.test/')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('url helpers', () => {
  it('describes why two URLs stay distinct', () => {
    expect(describeUrlDifference('http://example.test/a/', 'https://www.example.test/a')).toEqual(['scheme', 'www', 'trailing_slash']);
    expect(describeUrlDifference('https://www.example.test/A', 'https://www.example.test/a')).toEqual(['path_case']);
    expect(describeUrlDifference('https://www.example.test/p?a=1&b=2', 'https://www.example.test/p?b=2&a=1')).toEqual(['query_order']);
    expect(describeUrlDifference('https://www.example.test/p?utm_source=x', 'https://www.example.test/p')).toEqual([]);
    // Percent-encoding variants are the same identity, not a difference.
    expect(describeUrlDifference('https://www.example.test/%d0%bf', 'https://www.example.test/%D0%BF')).toEqual([]);
    expect(describeUrlDifference('https://www.example.test/%7Ea', 'https://www.example.test/~a')).toEqual([]);
  });

  it('resolves GA4 landing paths only with a host', () => {
    expect(landingPathToUrl('/pricing?utm_medium=x', 'www.example.test')).toBe('https://www.example.test/pricing');
    expect(landingPathToUrl('(not set)', 'www.example.test')).toBeNull();
    expect(landingPathToUrl('/pricing', '')).toBeNull();
  });

  it('matches configured path patterns case-sensitively', () => {
    expect(matchesPathPattern('/admin/users', '/admin/*')).toBe(true);
    expect(matchesPathPattern('/admin', '/admin')).toBe(true);
    expect(matchesPathPattern('/admin/x', '/admin')).toBe(true);
    expect(matchesPathPattern('/administrator', '/admin')).toBe(false);
    expect(matchesPathPattern('/Admin', '/admin')).toBe(false);
    // Percent-encoding differences between a configured pattern and a path are not path differences.
    expect(matchesPathPattern('/~team/docs', '/%7eteam/*')).toBe(true);
    expect(matchesPathPattern('/%D0%BF/x', '/%d0%bf')).toBe(true);
    expect(matchesPathPattern('/a%2Fb', '/a/b')).toBe(false);
    expect(isAllowedHost('https://WWW.example.test/x', ['www.example.test'])).toBe(true);
    expect(isAllowedHost('https://example.test/x', ['www.example.test'])).toBe(false);
  });
});
