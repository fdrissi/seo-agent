import { describe, expect, it } from 'vitest';
import {
  choice,
  commaList,
  countryCode,
  decimal,
  ga4EventName,
  ga4PropertyId,
  gscPropertyFormat,
  hostname,
  httpUrl,
  languageCode,
  timeZone,
  yesNo,
} from '../../../src/setup/parse.js';

const value = <T>(r: { ok: true; value: T } | { ok: false; error: string }) => (r.ok ? r.value : `ERR: ${r.error}`);

describe('setup answer parsers', () => {
  it('GA4 property ids are numeric; measurement ids are rejected with a specific hint', () => {
    expect(value(ga4PropertyId('123456789'))).toBe('123456789');
    expect(value(ga4PropertyId('properties/123456789'))).toBe('123456789');
    expect(value(ga4PropertyId(''))).toBeNull();
    expect(value(ga4PropertyId('G-ABC123'))).toMatch(/measurement ID/);
    expect(value(ga4PropertyId('12ab'))).toMatch(/numeric/);
  });

  it('Search Console properties must be exact (domain or URL prefix ending in /), never completed by guessing', () => {
    expect(value(gscPropertyFormat('sc-domain:example.test'))).toBe('sc-domain:example.test');
    expect(value(gscPropertyFormat('https://www.example.test/'))).toBe('https://www.example.test/');
    expect(value(gscPropertyFormat('https://www.example.test'))).toMatch(/end with "\/"/);
    expect(value(gscPropertyFormat('example.test'))).toMatch(/exact property/);
    expect(value(gscPropertyFormat(''))).toBeNull();
  });

  it('time zones must be IANA names, not offsets', () => {
    const tz = timeZone({ optional: true });
    expect(value(tz('Europe/Tallinn'))).toBe('Europe/Tallinn');
    expect(value(tz('+02:00'))).toMatch(/not a UTC offset/);
    expect(value(tz('UTC+2'))).toMatch(/not a UTC offset/);
    expect(value(tz('Mars/Base'))).toMatch(/not a valid IANA/);
    expect(value(tz(''))).toBeNull();
    expect(value(timeZone({ optional: false })(''))).toMatch(/required/);
  });

  it('hostnames are bare and lowercase; URLs are absolute http(s) without credentials', () => {
    expect(value(hostname('WWW.Example.TEST'))).toBe('www.example.test');
    expect(value(hostname('https://www.example.test/'))).toMatch(/not a bare hostname/);
    expect(value(httpUrl('https://www.example.test/'))).toBe('https://www.example.test/');
    expect(value(httpUrl('www.example.test'))).toMatch(/absolute URL/);
    expect(value(httpUrl('https://user:pw@example.test/'))).toMatch(/credentials/);
  });

  it('comma lists validate every item and drop duplicates', () => {
    const countries = commaList(countryCode);
    expect(value(countries('ee, FI, ee'))).toEqual(['EE', 'FI']);
    expect(value(countries('Estonia'))).toMatch(/ISO 3166/);
    expect(value(countries(''))).toEqual([]);
    expect(value(commaList(languageCode)('EN, de-AT'))).toEqual(['en', 'de-AT']);
    expect(value(commaList(hostname, { min: 1 })(''))).toMatch(/at least one/);
  });

  it('GA4 event names keep their exact case', () => {
    expect(value(ga4EventName('Generate_Lead'))).toBe('Generate_Lead');
    expect(value(ga4EventName('1lead'))).toMatch(/not a valid GA4 event name/);
    expect(value(ga4EventName('lead form'))).toMatch(/not a valid GA4 event name/);
  });

  it('decimals stay exact strings; blanks stay unknown when optional', () => {
    expect(value(decimal()('5.00'))).toBe('5.00');
    expect(value(decimal()('$0.5'))).toBe('0.5');
    expect(value(decimal()('-1'))).toMatch(/non-negative/);
    expect(value(decimal()('1e3'))).toMatch(/non-negative/);
    expect(value(decimal({ optional: true })(''))).toBeNull();
  });

  it('choices accept numbers or names; yes/no has an explicit default', () => {
    const c = choice(['demo', 'core', 'full'] as const, 'core');
    expect(value(c(''))).toBe('core');
    expect(value(c('3'))).toBe('full');
    expect(value(c('FULL'))).toBe('full');
    expect(value(c('9'))).toMatch(/Choose one of/);
    expect(value(yesNo(false)(''))).toBe(false);
    expect(value(yesNo(false)('Yes'))).toBe(true);
    expect(value(yesNo(true)('maybe'))).toMatch(/y or n/);
  });
});
