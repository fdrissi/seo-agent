import { describe, expect, it } from 'vitest';
import { hashObject, normalizedContentHash, sha256, stableStringify } from '../../../src/core/hash.js';
import { newId, newTraceId, slugify, ulid, uuid } from '../../../src/core/ids.js';

describe('ids', () => {
  it('ulid is 26 Crockford base32 chars with a sortable time prefix', () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
    expect(ulid(0).slice(0, 10)).toBe('0000000000');
  });

  it('ids are unique and self-describing', () => {
    const ids = new Set(Array.from({ length: 2_000 }, () => newId('job')));
    expect(ids.size).toBe(2_000);
    for (const id of ids) expect(id).toMatch(/^job_[0-9A-Z]{26}$/);
    expect(newTraceId()).toMatch(/^trace_/);
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('slugify produces stable, file-safe slugs', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
    expect(slugify('  Crème brûlée & café  ')).toBe('creme-brulee-cafe');
    expect(slugify('../../etc/passwd')).toBe('etc-passwd');
    expect(slugify('!!!')).toBe('untitled');
    expect(slugify('a'.repeat(200)).length).toBe(80);
    expect(slugify('abc def ghi', 7)).toBe('abc-def');
  });
});

describe('hashing', () => {
  it('sha256 matches the known vector', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256(new TextEncoder().encode('abc'))).toBe(sha256('abc'));
  });

  it('stableStringify sorts keys recursively and drops undefined', () => {
    expect(stableStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(stableStringify([{ b: 2, a: 1 }])).toBe('[{"a":1,"b":2}]');
    expect(stableStringify(new Date('2026-09-24T00:00:00Z'))).toBe('"2026-09-24T00:00:00.000Z"');
    expect(stableStringify(null)).toBe('null');
  });

  it('hashObject is stable across key order and changes with values', () => {
    const a = hashObject({ site: 'x', params: { depth: 10, q: 'seo' } });
    const b = hashObject({ params: { q: 'seo', depth: 10 }, site: 'x' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashObject({ site: 'x', params: { depth: 20, q: 'seo' } })).not.toBe(a);
    // Array order is meaningful.
    expect(hashObject([1, 2])).not.toBe(hashObject([2, 1]));
    // Pinned value: changing canonicalization would silently invalidate stored hashes.
    expect(hashObject({ b: 1, a: 'x' })).toBe(sha256('{"a":"x","b":1}'));
  });

  it('normalizedContentHash ignores whitespace and Unicode normalization differences only', () => {
    const composed = 'Café  menu\n\n text ';
    const decomposed = ' Café menu text';
    expect(normalizedContentHash(composed)).toBe(normalizedContentHash(decomposed));
    expect(normalizedContentHash('Cafe menu text')).not.toBe(normalizedContentHash(composed));
  });
});
