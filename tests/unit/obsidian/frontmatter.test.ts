import { describe, expect, it } from 'vitest';
import {
  composeRegion,
  generatedContentHash,
  locateGeneratedRegion,
  neutralizeMarkers,
  normalizePropertyValue,
  normalizeRegion,
  parseFrontmatterBlock,
  parseNote,
  parseNoteStructure,
  parseYamlStrict,
  serializeFrontmatter,
  splitFrontmatter,
} from '../../../src/obsidian/frontmatter.js';
import { GENERATED_END, GENERATED_START } from '../../../src/obsidian/types.js';

describe('strict YAML parsing (unsafe tags rejected)', () => {
  it.each([
    ['js function tag', 'a: !!js/function "function(){}"'],
    ['python object tag', 'a: !!python/object/apply:os.system ["ls"]'],
    ['custom local tag', 'a: !foo bar'],
    ['binary tag', 'a: !!binary aGVsbG8='],
    ['even an explicit str tag', 'a: !!str 12'],
    ['tag on a mapping', 'a: !!map {b: 1}'],
  ])('rejects %s', (_label, yaml) => {
    expect(() => parseYamlStrict(yaml)).toThrow(/explicit YAML tags are not allowed/);
  });

  it('rejects prototype-polluting keys and does not pollute Object.prototype', () => {
    expect(() => parseYamlStrict('__proto__: {polluted: true}')).toThrow(/forbidden YAML key/);
    expect(() => parseYamlStrict('a:\n  constructor: 1')).toThrow(/forbidden YAML key/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects duplicate keys and invalid YAML', () => {
    expect(() => parseYamlStrict('a: 1\na: 2')).toThrow(/invalid YAML/);
    expect(() => parseYamlStrict('a: [1, 2')).toThrow(/invalid YAML/);
  });

  it('limits aliases (billion laughs)', () => {
    const lines = ['a: &a [x, x, x, x, x, x, x, x, x]'];
    for (let i = 0; i < 30; i++) lines.push(`k${i}: *a`);
    expect(() => parseYamlStrict(lines.join('\n'))).toThrow(/alias/i);
  });

  it('parses plain YAML 1.2 core values without type coercion surprises', () => {
    const v = parseYamlStrict('s: yes\nd: 2026-09-24T09:00:00.000Z\nn: 12\nq: "12"\nl: [a, b]\nnil: null') as Record<string, unknown>;
    expect(v).toEqual({ s: 'yes', d: '2026-09-24T09:00:00.000Z', n: 12, q: '12', l: ['a', 'b'], nil: null });
  });

  it('frontmatter must be a mapping', () => {
    expect(() => parseFrontmatterBlock('- a\n- b')).toThrow(/mapping/);
    expect(() => parseFrontmatterBlock('just a string')).toThrow(/mapping/);
    expect(parseFrontmatterBlock('')).toEqual({});
  });
});

describe('splitting and regions', () => {
  it('splits frontmatter and keeps the body verbatim (CRLF, BOM)', () => {
    const raw = '\uFEFF---\r\nid: x\r\n---\r\nBody line\r\n';
    const s = splitFrontmatter(raw);
    expect(s.hasFrontmatter).toBe(true);
    expect(parseFrontmatterBlock(s.frontmatterText)).toEqual({ id: 'x' });
    expect(s.body).toBe('Body line\r\n');
  });

  it('handles notes without frontmatter and empty frontmatter', () => {
    expect(splitFrontmatter('# Hello\n').hasFrontmatter).toBe(false);
    const empty = splitFrontmatter('---\n---\ntext');
    expect(empty.hasFrontmatter).toBe(true);
    expect(empty.body).toBe('text');
  });

  it('throws on unterminated frontmatter', () => {
    expect(() => splitFrontmatter('---\nid: x\nno closing fence')).toThrow(/no closing/);
  });

  it('locates exactly one generated region and rejects malformed markers', () => {
    const body = `before\n${GENERATED_START}\ninside\n${GENERATED_END}\nafter`;
    const loc = locateGeneratedRegion(body)!;
    expect(loc.prefix).toBe('before\n');
    expect(normalizeRegion(loc.region)).toBe('inside');
    expect(loc.suffix).toBe('\nafter');
    expect(locateGeneratedRegion('no markers')).toBeNull();
    expect(() => locateGeneratedRegion(`${GENERATED_START}\n${GENERATED_START}\n${GENERATED_END}`)).toThrow(/exactly one/);
    expect(() => locateGeneratedRegion(`${GENERATED_END}\n${GENERATED_START}`)).toThrow(/before the start/);
    expect(() => locateGeneratedRegion(`${GENERATED_START}\nonly start`)).toThrow(/exactly one/);
  });

  it('parseNote exposes the normalized generated region', () => {
    const raw = `---\nid: n1\n---\n${composeRegion('# T\n\nbody  ')}\n\n## Notes\n`;
    const p = parseNote(raw);
    expect(p.frontmatter.id).toBe('n1');
    expect(p.generatedRegion).toBe('# T\n\nbody');
  });

  it('rejects unsafe tags inside a note', () => {
    expect(() => parseNoteStructure('---\nid: !!js/undefined x\n---\nbody')).toThrow(/tags/);
  });
});

describe('serialization and hashing', () => {
  it('round-trips generated properties through YAML exactly', () => {
    const fm = {
      id: 'page_1',
      type: 'page',
      generated_at: '2026-09-24T09:00:00.000Z',
      source_ids: ['a', 'b'],
      link: '[[02 Website/Pages/Pricing|Pricing]]',
      numeric_string: '12',
      boolish: 'true',
      empty: [],
      nothing: null,
      n: 0.1234,
    };
    const text = serializeFrontmatter(fm);
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('link: "[[02 Website/Pages/Pricing|Pricing]]"');
    const back = parseFrontmatterBlock(splitFrontmatter(`${text}body`).frontmatterText);
    expect(back).toEqual(fm);
  });

  it('normalizes property values to flat, single-line Obsidian properties', () => {
    expect(normalizePropertyValue('a\nb\r\nc', 'k')).toBe('a b c');
    expect(normalizePropertyValue(new Date('2026-01-01T00:00:00Z'), 'k')).toBe('2026-01-01T00:00:00.000Z');
    expect(normalizePropertyValue(Number.NaN, 'k')).toBeNull();
    expect(() => normalizePropertyValue({ nested: true }, 'k')).toThrow(/nested/);
    expect(() => normalizePropertyValue([{ nested: true }], 'k')).toThrow(/flat list/);
  });

  it('hash ignores generated_at and whitespace/line-ending noise but detects content edits', () => {
    const a = generatedContentHash({ id: 'x', generated_at: '2026-01-01', source_ids: [] }, 'line 1\nline 2');
    const b = generatedContentHash({ id: 'x', generated_at: '2027-01-01', source_ids: null }, '\r\nline 1  \r\nline 2\n\n');
    const c = generatedContentHash({ id: 'x', generated_at: '2026-01-01', source_ids: [] }, 'line 1\nline 2 edited');
    const d = generatedContentHash({ id: 'y', generated_at: '2026-01-01', source_ids: [] }, 'line 1\nline 2');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });

  it('neutralizes marker strings in untrusted text', () => {
    const s = neutralizeMarkers(`x ${GENERATED_END} y ${GENERATED_START}`);
    expect(s).not.toContain(GENERATED_END);
    expect(s).not.toContain(GENERATED_START);
    expect(locateGeneratedRegion(s)).toBeNull();
  });
});
