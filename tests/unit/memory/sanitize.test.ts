import { describe, expect, it } from 'vitest';
import { redactPersonalIdentifiers, sanitizeForMemory } from '../../../src/memory/sanitize.js';

/** Synthetic identifiers only (reserved example domains and documentation address ranges). */
const mask = (text: string, opts: Parameters<typeof redactPersonalIdentifiers>[1] = {}) => redactPersonalIdentifiers(text, opts);

describe('redactPersonalIdentifiers: percent-encoded emails (C4-09)', () => {
  it('masks emails encoded in page URLs and query strings', () => {
    const cases: Array<[string, string]> = [
      ['https://www.example.test/thanks?email=jane%40example.com&step=2', 'https://www.example.test/thanks?email=[EMAIL]&step=2'],
      ['/signup?e=jane.doe%2Bnews%40mail.example.org', '/signup?e=[EMAIL]'],
      ['/confirm?u=JANE%2bNEWS%40EXAMPLE.COM', '/confirm?u=[EMAIL]'],
      ['double encoded: ?to=jane%2540example.net', 'double encoded: ?to=[EMAIL]'],
      ['plain jane@example.com still masked', 'plain [EMAIL] still masked'],
    ];
    for (const [input, expected] of cases) {
      const r = mask(input);
      expect(r.text, input).toBe(expected);
      expect(r.redactions.email, input).toBe(1);
    }
  });

  it('leaves percent signs and encoded text that are not emails alone', () => {
    const text = 'CTR rose 40% (from 2%40 visits is not an email); /search?q=desk%20organizer&page=2';
    expect(mask(text).text).toBe(text);
  });

  it('masks encoded emails in memory content too', () => {
    const r = sanitizeForMemory('Top page: https://www.example.test/unsubscribe?email=someone%40example.com had 40 clicks.');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe('Top page: https://www.example.test/unsubscribe?email=[EMAIL] had 40 clicks.');
      expect(r.piiRedactions.email).toBe(1);
    }
  });
});

describe('redactPersonalIdentifiers: IPv6 addresses (C4-09)', () => {
  it('masks full, compressed, bracketed, zoned, and IPv4-mapped forms', () => {
    const cases: Array<[string, string]> = [
      ['client 2001:0db8:85a3:0000:0000:8a2e:0370:7334 hit /', 'client [IP] hit /'],
      ['from 2001:db8::1 at noon', 'from [IP] at noon'],
      ['loopback ::1 only', 'loopback [IP] only'],
      ['link-local fe80::1ff:fe23:4567:890a%eth0', 'link-local [IP]%eth0'],
      ['http://[2001:db8:0:1::5]:8080/path', 'http://[[IP]]:8080/path'],
      ['mapped ::ffff:192.0.2.128 seen', 'mapped [IP] seen'],
      ['prefix 2001:db8:: route', 'prefix [IP] route'],
      ['end of sentence 2001:db8::7.', 'end of sentence [IP].'],
    ];
    for (const [input, expected] of cases) {
      const r = mask(input);
      expect(r.text, input).toBe(expected);
      expect(r.redactions.ip_address, input).toBe(1);
    }
  });

  it('does not touch clock times, ISO timestamps, hashes, MAC-like strings, or code', () => {
    const keep = [
      'Published 2026-09-24T10:30:00Z and updated at 10:30:00.',
      'Duration 01:02:03:04 and ratio 16:9.',
      'sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      'git 3f2a9c1 and etag "a1b2c3d4e5f6"',
      'fingerprint SHA256:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89',
      'MAC 00:1a:2b:3c:4d:5e',
      'std::string and Foo::bar() and a C++ scope ::',
      'opening hours 10:00-12:00 and 14:00::break',
    ];
    for (const text of keep) {
      const r = mask(text);
      expect(r.text, text).toBe(text);
      expect(r.redactions.ip_address ?? 0, text).toBe(0);
    }
  });

  it('keeps IPv4 masking and phone masking working alongside IPv6', () => {
    const r = mask('v4 192.0.2.10, v6 2001:db8::2, call +33 6 12 34 56 78', { phones: true });
    expect(r.text).toBe('v4 [IP], v6 [IP], call [PHONE]');
    expect(r.redactions).toMatchObject({ ip_address: 2, phone: 1 });
  });
});
