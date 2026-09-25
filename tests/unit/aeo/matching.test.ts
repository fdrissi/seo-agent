/**
 * In-code classification of AI answer observations (spec 17). SYNTHETIC
 * brand "Qwertle Tools" on reserved *.test hostnames (tests/fixtures/aeo).
 */
import { describe, expect, it } from 'vitest';
import { brandMentionsIn, brandTerms, classifyObservation, normalizeHostname, ownCitedUrls, ownHostnames, parseCitedUrls } from '../../../src/aeo/matching.js';
import { noonInZone } from '../../../src/aeo/import.js';
import { dateInZone } from '../../../src/core/time.js';
import { aeoSiteConfig } from '../../fixtures/aeo/config.js';

const config = aeoSiteConfig();
const terms = brandTerms(config);

describe('brand terms (from site config only)', () => {
  it('uses the business name, brand aliases, and allowed hostnames, longest first', () => {
    expect(terms.terms).toEqual(['www.qwertle.test', 'qwertle tools', 'qwertle.test', 'qwertle']);
    expect(terms.origin).toEqual({ 'qwertle tools': 'business_name', qwertle: 'brand_alias', 'www.qwertle.test': 'hostname', 'qwertle.test': 'hostname' });
  });

  it('ignores one-character aliases and duplicates', () => {
    const t = brandTerms(aeoSiteConfig()).terms;
    const withShort = brandTerms({ ...config, brand: { aliases: ['Q', 'qwertle', 'QWERTLE'] } }).terms;
    expect(withShort).toEqual(t);
  });
});

describe('brand mention (response text only)', () => {
  it('matches whole words case-insensitively, across whitespace runs', () => {
    expect(brandMentionsIn('Try QWERTLE   TOOLS today.', terms)).toEqual(['qwertle tools', 'qwertle']);
    expect(brandMentionsIn('Qwertle, for example.', terms)).toEqual(['qwertle']);
  });

  it('does not match inside another word', () => {
    expect(brandMentionsIn('Qwertleish apps and preqwertle vendors', terms)).toEqual([]);
  });

  it('is unknown (null), never "no", when there is no response text', () => {
    expect(brandMentionsIn(null, terms)).toBeNull();
    expect(brandMentionsIn('   ', terms)).toBeNull();
    expect(brandMentionsIn('No vendor named.', terms)).toEqual([]);
  });

  it('counts the site hostname in the text as a mention', () => {
    expect(brandMentionsIn('See www.qwertle.test/pricing for details.', terms)).toContain('www.qwertle.test');
  });
});

describe('cited URLs', () => {
  it('keeps "not recorded" (null) apart from "cited nothing" ([])', () => {
    expect(parseCitedUrls(undefined)).toEqual({ ok: true, urls: null });
    expect(parseCitedUrls(null)).toEqual({ ok: true, urls: null });
    expect(parseCitedUrls('  ')).toEqual({ ok: true, urls: null });
    expect(parseCitedUrls('none')).toEqual({ ok: true, urls: [] });
    expect(parseCitedUrls('[]')).toEqual({ ok: true, urls: [] });
    expect(parseCitedUrls([])).toEqual({ ok: true, urls: [] });
  });

  it('accepts whitespace, "|", JSON-array text, and arrays; removes duplicates; keeps URLs as cited', () => {
    expect(parseCitedUrls('https://a.example.com/x https://b.example.com/y|https://a.example.com/x')).toEqual({ ok: true, urls: ['https://a.example.com/x', 'https://b.example.com/y'] });
    expect(parseCitedUrls('["https://a.example.com/?utm_source=ai"]')).toEqual({ ok: true, urls: ['https://a.example.com/?utm_source=ai'] });
    expect(parseCitedUrls(['https://a.example.com/x'])).toEqual({ ok: true, urls: ['https://a.example.com/x'] });
  });

  it('rejects relative, non-http, credential-bearing, and non-string entries', () => {
    const bad = (v: unknown) => {
      const r = parseCitedUrls(v);
      expect(r.ok).toBe(false);
      return r.ok ? [] : r.errors;
    };
    expect(bad('/relative/path')[0]).toMatch(/absolute URL/);
    expect(bad('ftp://files.example.com/a')[0]).toMatch(/http or https/);
    expect(bad('https://user:pw@example.com/a')[0]).toMatch(/credentials/);
    expect(bad([42])[0]).toMatch(/non-empty string/);
    expect(bad('[not json')[0]).toMatch(/JSON array/);
    expect(bad({ url: 'https://example.com' })[0]).toMatch(/list of URLs/);
  });
});

describe('own-site citation (cited URLs only)', () => {
  it('matches the exact allowed hostnames: www and non-www are not merged, subdomains are not assumed', () => {
    const hosts = ownHostnames(config);
    expect(hosts).toEqual(['www.qwertle.test', 'qwertle.test']);
    expect(ownCitedUrls(['https://www.qwertle.test/a', 'https://qwertle.test/b', 'https://blog.qwertle.test/c', 'https://www.example.com/'], hosts)).toEqual(['https://www.qwertle.test/a', 'https://qwertle.test/b']);
    expect(ownCitedUrls(['https://qwertle.test/b'], ['www.qwertle.test'])).toEqual([]);
    expect(ownCitedUrls(null, hosts)).toBeNull();
  });

  it('normalizes hostnames (case, trailing dot) and refuses garbage', () => {
    expect(normalizeHostname('WWW.Qwertle.Test.')).toBe('www.qwertle.test');
    expect(normalizeHostname('bad host')).toBeNull();
    expect(normalizeHostname('')).toBeNull();
  });
});

describe('classifyObservation: a mention is not a citation', () => {
  it('a URL written in the response text is a mention, not a citation', () => {
    const c = classifyObservation({ responseText: 'Read https://www.qwertle.test/guide first.', citedUrls: [] }, config);
    expect(c).toMatchObject({ brandMentioned: true, ownSiteCited: false, ownCitedUrls: [] });
  });

  it('a citation without a mention stays a citation without a mention', () => {
    const c = classifyObservation({ responseText: 'Use a dedicated app.', citedUrls: ['https://qwertle.test/pricing'] }, config);
    expect(c).toMatchObject({ brandMentioned: false, ownSiteCited: true, ownCitedUrls: ['https://qwertle.test/pricing'] });
  });

  it('keeps unknown inputs unknown', () => {
    expect(classifyObservation({ responseText: null, citedUrls: null }, config)).toEqual({ brandMentioned: null, matchedBrandTerms: null, ownSiteCited: null, ownCitedUrls: null });
  });
});

describe('noonInZone (day-precision observations)', () => {
  it('stores an instant that stays inside the stated date in that zone, across DST changes', () => {
    for (const [date, zone] of [
      ['2026-09-12', 'Europe/Tallinn'],
      ['2026-03-29', 'Europe/Tallinn'],
      ['2026-11-01', 'America/New_York'],
      ['2026-06-30', 'Pacific/Auckland'],
      ['2026-01-15', 'UTC'],
    ] as const) {
      const at = noonInZone(date, zone);
      expect(dateInZone(at, zone)).toBe(date);
      const wall = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
      expect(wall).toBe('12:00');
    }
  });
});
