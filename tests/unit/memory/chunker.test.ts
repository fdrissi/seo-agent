import { describe, expect, it } from 'vitest';
import { CHUNKER_VERSION, chunkContentHash, chunkMarkdown, chunkerOptionsFromConfig, embeddingInput, validateChunkerOptions, type ChunkerOptions } from '../../../src/memory/chunker.js';
import { estimateTokens, truncateToTokens } from '../../../src/memory/tokens.js';
import { testSiteConfig } from '../../helpers/context.js';

const small: ChunkerOptions = { minTokens: 40, targetTokens: 60, maxTokens: 80, overlapTokens: 15 };

function para(words: number, seed: string): string {
  return Array.from({ length: words }, (_, i) => `${seed}${i}`).join(' ') + '.';
}

describe('token estimation (multilingual heuristic)', () => {
  it('counts English roughly 4 chars per token and never below the word count', () => {
    expect(estimateTokens('')).toBe(0);
    const en = 'The quick brown fox jumps over the lazy dog.';
    expect(estimateTokens(en)).toBeGreaterThanOrEqual(9);
    expect(estimateTokens(en)).toBeLessThanOrEqual(15);
  });
  it('counts CJK as one token per character and Cyrillic/accented text more densely than ASCII', () => {
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('こんにちは')).toBe(5);
    const cyr = 'Привет мир';
    expect(estimateTokens(cyr)).toBeGreaterThan(estimateTokens('Privet mir'));
  });
  it('truncates to a token budget', () => {
    const t = para(200, 'w');
    const r = truncateToTokens(t, 50);
    expect(r.truncated).toBe(true);
    expect(estimateTokens(r.text)).toBeLessThanOrEqual(50);
    expect(truncateToTokens('short', 50)).toEqual({ text: 'short', truncated: false });
  });
});

describe('heading-aware markdown chunker', () => {
  it('exposes a versioned algorithm and config-driven options', () => {
    expect(CHUNKER_VERSION).toMatch(/^md-heading-v\d+$/);
    const o = chunkerOptionsFromConfig(testSiteConfig());
    expect(o).toMatchObject({ minTokens: 400, targetTokens: 600, maxTokens: 800 });
    expect(o.overlapTokens).toBeLessThanOrEqual(200);
    expect(() => validateChunkerOptions({ minTokens: 10, targetTokens: 5, maxTokens: 20, overlapTokens: 0 })).toThrow();
  });

  it('tracks heading paths and preserves original text as exact slices', () => {
    const md = `Intro line before any heading.\n\n# Offer\n\n${para(50, 'a')}\n\n## Delivery\n\n${para(50, 'b')}\n\n# FAQ\n\n${para(50, 'c')}\n`;
    const chunks = chunkMarkdown(md, small);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(md.slice(c.start, c.end)).toBe(c.text);
      expect(c.tokenEstimate).toBeLessThanOrEqual(small.maxTokens);
      expect(c.contentHash).toBe(chunkContentHash(c.headingPath, c.text));
    }
    expect(chunks.some((c) => c.headingPath === 'Offer > Delivery')).toBe(true);
    expect(chunks.some((c) => c.headingPath === 'FAQ')).toBe(true);
    // A heading line is never the last line of a chunk.
    for (const c of chunks) expect(c.text.trimEnd().split('\n').pop()).not.toMatch(/^#{1,6}\s/);
  });

  it('does not treat # lines inside fenced code blocks as headings', () => {
    const md = '# Setup\n\n```bash\n# not a heading\necho hi\n```\n\nAfter code.';
    const chunks = chunkMarkdown(md, small);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.headingPath).toBe('Setup');
    expect(chunks[0]!.text).toContain('# not a heading');
  });

  it('merges small sections up to the target and uses the common heading path', () => {
    const md = '# Business\n\n## A\n\nShort a.\n\n## B\n\nShort b.\n\n## C\n\nShort c.';
    const chunks = chunkMarkdown(md, small);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.headingPath).toBe('Business');
    expect(chunks[0]!.text).toBe(md);
  });

  it('splits long sections with modest overlap between consecutive chunks of the same section', () => {
    const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} talks about organizers and trays.`).join(' ');
    const md = `# Long\n\n${sentences}`;
    const chunks = chunkMarkdown(md, small);
    expect(chunks.length).toBeGreaterThan(2);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.start).toBeLessThan(chunks[i - 1]!.end); // overlap
      expect(chunks[i]!.start).toBeGreaterThan(chunks[i - 1]!.start); // progress
      const overlap = md.slice(chunks[i]!.start, chunks[i - 1]!.end);
      expect(estimateTokens(overlap)).toBeLessThanOrEqual(small.overlapTokens + 5);
    }
    for (const c of chunks) expect(c.tokenEstimate).toBeLessThanOrEqual(small.maxTokens);
  });

  it('handles scripts without spaces (CJK) by splitting sentences and characters', () => {
    const md = `# 说明\n\n${'这是一个很长的句子没有空格'.repeat(30)}。${'第二句话也很长'.repeat(20)}。`;
    const chunks = chunkMarkdown(md, { ...small, language: 'zh' });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.tokenEstimate).toBeLessThanOrEqual(small.maxTokens);
      expect(md.slice(c.start, c.end)).toBe(c.text);
    }
  });

  it('is deterministic and hashes normalized content (whitespace-insensitive)', () => {
    const a = chunkMarkdown('# T\n\nHello   world.', small);
    const b = chunkMarkdown('# T\n\nHello world.', small);
    expect(a[0]!.contentHash).toBe(b[0]!.contentHash);
    expect(chunkMarkdown('# T\n\nHello world.', small)[0]!.contentHash).toBe(b[0]!.contentHash);
    expect(embeddingInput('A > B', 'text')).toBe('A > B\n\ntext');
  });

  it('returns no chunks for empty input', () => {
    expect(chunkMarkdown('', small)).toEqual([]);
    expect(chunkMarkdown('\n\n  \n', small)).toEqual([]);
  });
});
