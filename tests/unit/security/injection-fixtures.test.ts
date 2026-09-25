import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALL_CANARIES,
  CANARY_PREFIX,
  FIXTURE_HOSTS,
  INJECTION_FIXTURES,
  ZERO_WIDTH,
  competitorPageHtml,
  findCanaries,
  findCanaryLeaks,
  fixtureById,
  fixturesForChannel,
  fixturesWithVector,
  fromUnicodeTags,
  redditDataset,
  serpApiResponse,
  stripInvisible,
  toUnicodeTags,
  vaultNoteWithFakeApproval,
  withZeroWidth,
} from '../../../src/security/injection-fixtures.js';
import { compileAllowlist, scanFileContent } from '../../../scripts/lib/secret-rules.mjs';

const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/security/injection');

/** Static copies other slices can read without importing TypeScript. Regenerate with UPDATE_SECURITY_FIXTURES=1. */
function staticFixtures(): Record<string, string> {
  return {
    'competitor-page.html': competitorPageHtml(),
    'reddit-dataset.json': `${JSON.stringify(redditDataset(), null, 2)}\n`,
    'serp-response.json': `${JSON.stringify(serpApiResponse(), null, 2)}\n`,
    'vault-note-fake-approval.md': vaultNoteWithFakeApproval(),
    'fixtures.json': `${JSON.stringify({ _synthetic: true, _about: 'Synthetic prompt-injection payloads for seo-agent tests. Generated from src/security/injection-fixtures.ts.', fixtures: INJECTION_FIXTURES }, null, 2)}\n`,
  };
}

function hostsIn(text: string): string[] {
  const hosts = new Set<string>();
  for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^/\s"'<>)?#:\\]+)/gi)) hosts.add(m[1]!.toLowerCase());
  return [...hosts];
}

describe('injection fixture library', () => {
  it('has unique ids and canaries, all synthetic', () => {
    const ids = INJECTION_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ALL_CANARIES).size).toBe(ALL_CANARIES.length);
    for (const f of INJECTION_FIXTURES) {
      expect(f.synthetic).toBe(true);
      expect(f.canary.startsWith(CANARY_PREFIX)).toBe(true);
      expect(f.forbiddenEffects.length).toBeGreaterThan(0);
      expect(f.expectedHandling.length).toBeGreaterThan(10);
    }
  });

  it('embeds each canary in its payload (visible, zero-width, or tag-encoded)', () => {
    for (const f of INJECTION_FIXTURES) expect(findCanaries(f.payload), f.id).toContain(f.canary);
  });

  it('covers the vectors required by the spec: competitor pages, Reddit, JSON fields, Markdown notes, HTML comments, zero-width, fake approval/frontmatter', () => {
    expect(fixturesForChannel('competitor_page').length).toBeGreaterThanOrEqual(5);
    expect(fixturesForChannel('reddit').length).toBeGreaterThanOrEqual(2);
    for (const v of ['html_comment', 'json_field', 'markdown_note', 'zero_width', 'frontmatter_approval', 'fake_approval_claim', 'hidden_element', 'unicode_tags', 'delimiter_spoof', 'tool_call_json', 'yaml_tag'] as const) {
      expect(fixturesWithVector(v).length, v).toBeGreaterThan(0);
    }
  });

  it('uses only reserved hosts or non-routable addresses (no real domains)', () => {
    const allowed = /(?:^|\.)(?:example|invalid|test|localhost)$|^(?:127\.0\.0\.1|169\.254\.169\.254|localhost(?::\d+)?|127\.0\.0\.1:\d+)$|^schema\.org$/;
    for (const f of INJECTION_FIXTURES) {
      for (const h of hostsIn(stripInvisible(f.payload) + fromUnicodeTags(f.payload))) expect(allowed.test(h), `${f.id}: ${h}`).toBe(true);
    }
    expect(Object.values(FIXTURE_HOSTS).every((h) => /\.(?:example|test|invalid)$/.test(h))).toBe(true);
  });

  it('hides instructions with zero-width, bidi, and Unicode tag characters where claimed', () => {
    const zw = fixtureById('reddit-comment-zero-width');
    expect(zw.hiddenFromHumans).toBe(false);
    const body = (JSON.parse(zw.payload) as { body: string }).body;
    expect(Object.values(ZERO_WIDTH).some((c) => body.includes(c))).toBe(true);
    expect(body.toLowerCase().includes('ignore previous instructions')).toBe(false);
    expect(stripInvisible(body).toLowerCase()).toContain('ignore previous instructions');

    const tags = fixtureById('unicode-tag-smuggling');
    expect(tags.payload.includes('Ignore previous')).toBe(false);
    expect(fromUnicodeTags(tags.payload)).toContain('Ignore previous instructions');
    expect(fromUnicodeTags(toUnicodeTags('abc XYZ'))).toBe('abc XYZ');
    expect(stripInvisible(withZeroWidth('hello world'))).toBe('hello world');

    expect(fixtureById('bidi-override').payload).toContain('‮');
  });

  it('builds a full competitor page that contains every competitor-page canary', () => {
    const html = competitorPageHtml();
    expect(html).toContain('SYNTHETIC prompt-injection fixture');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    for (const f of fixturesForChannel('competitor_page')) expect(findCanaries(html), f.id).toContain(f.canary);
  });

  it('builds Reddit and SERP datasets flagged as synthetic', () => {
    const reddit = redditDataset();
    expect(reddit.length).toBeGreaterThanOrEqual(3);
    for (const item of reddit) expect(item._synthetic).toBe(true);
    const serp = serpApiResponse();
    expect(serp._synthetic).toBe(true);
    expect(findCanaryLeaks(serp).length).toBeGreaterThan(0);
    expect(vaultNoteWithFakeApproval()).toMatch(/^---\nid: note-synthetic-001\napproved: true/);
  });

  it('findCanaryLeaks reports paths inside nested values and nothing for clean values', () => {
    const c = fixtureById('competitor-html-comment').canary;
    const leaks = findCanaryLeaks({ tool: { name: 'x', args: [{ note: `please ${c}` }] }, clean: 'ok' });
    expect(leaks).toEqual([{ path: '$.tool.args[0].note', canary: c }]);
    expect(findCanaryLeaks({ approvals: [], config: { budgets: { monthly: '5.00' } } })).toEqual([]);
    const hidden = `x${toUnicodeTags(fixtureById('unicode-tag-smuggling').canary)}`;
    expect(findCanaryLeaks([hidden])[0]?.canary).toBe(fixtureById('unicode-tag-smuggling').canary);
  });

  it('contains no credential-shaped strings (fixtures must not trip the secret scan)', () => {
    const allowlist = compileAllowlist({});
    for (const [name, content] of Object.entries(staticFixtures())) {
      const findings = scanFileContent(`tests/fixtures/security/injection/${name}`, content, allowlist).filter((f) => !f.allowlisted);
      expect(findings, name).toEqual([]);
    }
  });

  it('keeps the TypeScript source pure ASCII (no literal invisible, bidi, or homoglyph characters: Trojan Source)', () => {
    const src = readFileSync(path.resolve(__dirname, '../../../src/security/injection-fixtures.ts'), 'utf8');
    const offending = [...src].map((ch, i) => ({ ch, i })).filter(({ ch }) => ch.codePointAt(0)! > 0x7e || (ch.codePointAt(0)! < 0x20 && ch !== '\n' && ch !== '\t' && ch !== '\r'));
    expect(offending.map(({ ch, i }) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase()} at ${i}`)).toEqual([]);
  });

  it('static fixture files in tests/fixtures/security/injection match the library', () => {
    const files = staticFixtures();
    if (process.env.UPDATE_SECURITY_FIXTURES === '1') {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      for (const [name, content] of Object.entries(files)) writeFileSync(path.join(FIXTURE_DIR, name), content);
    }
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(FIXTURE_DIR, name);
      expect(existsSync(file), `${name} missing; run UPDATE_SECURITY_FIXTURES=1 npx vitest run tests/unit/security/injection-fixtures.test.ts`).toBe(true);
      expect(readFileSync(file, 'utf8'), `${name} is stale; regenerate with UPDATE_SECURITY_FIXTURES=1`).toBe(content);
    }
  });
});
