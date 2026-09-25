import type { SiteConfig } from '../config/site-schema.js';
import { normalizedContentHash } from '../core/hash.js';
import { estimateTokens } from './tokens.js';

/**
 * Heading-aware Markdown chunker.
 *
 * - Splits the document into sections by ATX headings (`#` .. `######`),
 *   ignoring `#` lines inside fenced code blocks, and tracks the heading path
 *   (e.g. "Offer > Pricing").
 * - Each section is split into blocks (paragraphs, lists, tables, whole fenced
 *   code blocks). A heading line is glued to the block that follows it, so no
 *   chunk ends with a dangling heading.
 * - Blocks larger than `maxTokens` are split into sentences with
 *   `Intl.Segmenter` (locale-aware, works for scripts without spaces), and
 *   over-long sentences are split on word boundaries (or characters).
 * - Units are packed greedily towards `targetTokens`, never above `maxTokens`.
 *   A section boundary ends the current chunk once it holds at least
 *   `minTokens`; smaller neighbouring sections are merged (the chunk heading
 *   path is then their common ancestor).
 * - Consecutive chunks inside one section share up to `overlapTokens` of
 *   trailing units (modest overlap). No overlap is added across sections.
 * - Chunk text is an exact slice of the original Markdown (original text is
 *   preserved; overlap duplicates the shared slice).
 *
 * Changing this algorithm requires bumping CHUNKER_VERSION: the chunker
 * version is part of the embedding-version identity, so a new version gets a
 * new Qdrant collection and vectors are never mixed.
 */
export const CHUNKER_VERSION = 'md-heading-v1';

export interface ChunkerOptions {
  minTokens: number;
  targetTokens: number;
  maxTokens: number;
  overlapTokens: number;
  /** BCP 47 language for sentence segmentation; 'und' uses the default locale rules. */
  language?: string;
}

export interface Chunk {
  index: number;
  /** Exact slice of the original Markdown. */
  text: string;
  headingPath: string;
  tokenEstimate: number;
  /** Normalized hash of the embedding input (heading path + text). Dedup key for embeddings. */
  contentHash: string;
  start: number;
  end: number;
}

export function chunkerOptionsFromConfig(config: SiteConfig, language?: string): ChunkerOptions {
  const m = config.memory;
  return {
    minTokens: m.chunkMinTokens,
    targetTokens: m.chunkTargetTokens,
    maxTokens: m.chunkMaxTokens,
    overlapTokens: Math.min(m.chunkOverlapTokens, Math.floor(m.chunkMaxTokens / 4)),
    ...(language ? { language } : {}),
  };
}

/** Text actually sent to the embedding model for a chunk (heading context + original text). */
export function embeddingInput(headingPath: string, text: string): string {
  return headingPath ? `${headingPath}\n\n${text}` : text;
}

export function chunkContentHash(headingPath: string, text: string): string {
  return normalizedContentHash(embeddingInput(headingPath, text));
}

interface Section {
  path: string[];
  blocks: Array<{ start: number; end: number }>;
}

interface Unit {
  start: number;
  end: number;
  tokens: number;
  section: number;
}

const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

function splitSections(md: string): Section[] {
  const sections: Section[] = [{ path: [], blocks: [] }];
  const stack: Array<{ level: number; title: string }> = [];
  let fence: string | null = null;
  let blockStart = -1;
  let blockEnd = -1;
  let pendingHeading: { start: number; end: number } | null = null;

  const current = () => sections[sections.length - 1]!;
  const closeBlock = () => {
    if (blockStart >= 0) {
      const start = pendingHeading ? pendingHeading.start : blockStart;
      current().blocks.push({ start, end: blockEnd });
      pendingHeading = null;
    }
    blockStart = -1;
    blockEnd = -1;
  };

  let pos = 0;
  const lines = md.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const lineStart = pos;
    const lineEnd = pos + line.length; // exclusive, without '\n'
    pos = lineEnd + 1;
    const content = line.replace(/\r$/, '');
    const contentEnd = lineStart + content.length;

    if (fence) {
      if (blockStart < 0) blockStart = lineStart;
      blockEnd = contentEnd;
      const f = FENCE_RE.exec(content);
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && content.trim() === f[1]) fence = null;
      continue;
    }
    const f = FENCE_RE.exec(content);
    if (f) {
      if (blockStart < 0) blockStart = lineStart;
      blockEnd = contentEnd;
      fence = f[1]!;
      continue;
    }
    const h = HEADING_RE.exec(content);
    if (h) {
      closeBlock();
      if (pendingHeading) {
        // Heading directly followed by another heading: keep it as its own block in the previous section.
        current().blocks.push(pendingHeading);
        pendingHeading = null;
      }
      const level = h[1]!.length;
      const title = h[2]!.trim();
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title });
      sections.push({ path: stack.map((s) => s.title).filter(Boolean), blocks: [] });
      pendingHeading = { start: lineStart, end: contentEnd };
      continue;
    }
    if (content.trim() === '') {
      closeBlock();
      continue;
    }
    if (blockStart < 0) blockStart = lineStart;
    blockEnd = contentEnd;
  }
  closeBlock();
  if (pendingHeading) current().blocks.push(pendingHeading);
  return sections.filter((s) => s.blocks.length > 0);
}

function segmenter(language: string | undefined, granularity: 'sentence' | 'word'): Intl.Segmenter {
  try {
    return new Intl.Segmenter(language && language !== 'und' ? language : undefined, { granularity });
  } catch {
    return new Intl.Segmenter(undefined, { granularity });
  }
}

/** Split [start,end) of md into units no larger than maxTokens (sentences, then words/characters). */
function splitLarge(md: string, start: number, end: number, maxTokens: number, language: string | undefined, section: number): Unit[] {
  const text = md.slice(start, end);
  const out: Unit[] = [];
  const sentences = [...segmenter(language, 'sentence').segment(text)];
  for (const s of sentences) {
    const sStart = start + s.index;
    const sEnd = sStart + s.segment.length;
    const tok = estimateTokens(s.segment);
    if (tok <= maxTokens) {
      out.push({ start: sStart, end: sEnd, tokens: tok, section });
      continue;
    }
    // Over-long sentence: accumulate word segments.
    let pieceStart = sStart;
    let pieceEnd = sStart;
    for (const w of segmenter(language, 'word').segment(s.segment)) {
      const wEnd = sStart + w.index + w.segment.length;
      const candidate = md.slice(pieceStart, wEnd);
      if (estimateTokens(candidate) > maxTokens && pieceEnd > pieceStart) {
        out.push({ start: pieceStart, end: pieceEnd, tokens: estimateTokens(md.slice(pieceStart, pieceEnd)), section });
        pieceStart = pieceEnd;
      }
      // A single "word" larger than maxTokens (e.g. a long CJK run or a base64 blob): split by characters.
      if (estimateTokens(md.slice(pieceStart, wEnd)) > maxTokens) {
        let cStart = pieceStart;
        let cEnd = pieceStart;
        for (const ch of md.slice(pieceStart, wEnd)) {
          const next = cEnd + ch.length;
          if (estimateTokens(md.slice(cStart, next)) > maxTokens && cEnd > cStart) {
            out.push({ start: cStart, end: cEnd, tokens: estimateTokens(md.slice(cStart, cEnd)), section });
            cStart = cEnd;
          }
          cEnd = next;
        }
        pieceStart = cStart;
      }
      pieceEnd = wEnd;
    }
    if (pieceEnd > pieceStart) out.push({ start: pieceStart, end: pieceEnd, tokens: estimateTokens(md.slice(pieceStart, pieceEnd)), section });
  }
  return out.filter((u) => md.slice(u.start, u.end).trim() !== '');
}

function commonPrefix(paths: string[][]): string[] {
  if (!paths.length) return [];
  const first = paths[0]!;
  let n = first.length;
  for (const p of paths.slice(1)) {
    let i = 0;
    while (i < n && i < p.length && p[i] === first[i]) i++;
    n = i;
  }
  return first.slice(0, n);
}

export function validateChunkerOptions(o: ChunkerOptions): void {
  if (!(o.minTokens > 0 && o.minTokens <= o.targetTokens && o.targetTokens <= o.maxTokens)) {
    throw new RangeError('chunker: require 0 < minTokens <= targetTokens <= maxTokens');
  }
  if (o.overlapTokens < 0 || o.overlapTokens >= o.maxTokens) throw new RangeError('chunker: overlapTokens must be >= 0 and < maxTokens');
}

export function chunkMarkdown(markdown: string, opts: ChunkerOptions): Chunk[] {
  validateChunkerOptions(opts);
  const md = markdown.replace(/\r\n/g, '\n');
  const sections = splitSections(md);

  const units: Unit[] = [];
  sections.forEach((sec, si) => {
    for (const b of sec.blocks) {
      const tok = estimateTokens(md.slice(b.start, b.end));
      if (tok <= opts.maxTokens) units.push({ start: b.start, end: b.end, tokens: tok, section: si });
      else units.push(...splitLarge(md, b.start, b.end, opts.maxTokens, opts.language, si));
    }
  });

  const chunks: Chunk[] = [];
  let cur: Unit[] = [];
  let curTok = 0;
  let overlapCount = 0; // leading units in `cur` that are overlap from the previous chunk

  const tokensOf = (us: Unit[]) => (us.length ? estimateTokens(md.slice(us[0]!.start, us[us.length - 1]!.end)) : 0);

  const emit = (withOverlap: boolean) => {
    if (cur.length === 0 || cur.length === overlapCount) {
      cur = [];
      curTok = 0;
      overlapCount = 0;
      return;
    }
    const start = cur[0]!.start;
    const end = cur[cur.length - 1]!.end;
    const text = md.slice(start, end);
    const secIdx = [...new Set(cur.map((u) => u.section))];
    const paths = secIdx.map((i) => sections[i]!.path);
    const common = commonPrefix(paths);
    const headingPath = (common.length ? common : paths[0] ?? []).join(' > ');
    chunks.push({ index: chunks.length, text, headingPath, tokenEstimate: estimateTokens(text), contentHash: chunkContentHash(headingPath, text), start, end });
    if (withOverlap && opts.overlapTokens > 0) {
      const tail: Unit[] = [];
      let tailTok = 0;
      for (let i = cur.length - 1; i >= overlapCount; i--) {
        const u = cur[i]!;
        if (tailTok + u.tokens > opts.overlapTokens) break;
        tail.unshift(u);
        tailTok += u.tokens;
      }
      // Never let the overlap be the whole chunk (guarantees progress).
      if (tail.length && tail.length < cur.length - overlapCount) {
        cur = tail;
        curTok = tokensOf(tail);
        overlapCount = tail.length;
        return;
      }
    }
    cur = [];
    curTok = 0;
    overlapCount = 0;
  };

  for (const u of units) {
    if (cur.length) {
      const sameSection = cur[cur.length - 1]!.section === u.section;
      if (!sameSection && curTok >= opts.minTokens) emit(false);
    }
    if (cur.length) {
      const combined = tokensOf([...cur, u]);
      if (combined > opts.maxTokens || (combined > opts.targetTokens && curTok >= opts.minTokens)) {
        const sameSection = cur[cur.length - 1]!.section === u.section;
        emit(sameSection);
        // Drop the overlap if it cannot fit together with the next unit.
        if (cur.length && tokensOf([...cur, u]) > opts.maxTokens) {
          cur = [];
          curTok = 0;
          overlapCount = 0;
        }
      }
    }
    cur.push(u);
    curTok = tokensOf(cur);
  }
  emit(false);
  return chunks;
}
