import { parseYamlSafe } from '../config/load.js';
import { GENERATED_END, GENERATED_START } from '../obsidian/types.js';

/**
 * Markdown helpers for memory ingestion: YAML frontmatter, generated-region
 * stripping, and wikilink extraction/normalization.
 *
 * Frontmatter is parsed with the safe YAML core schema (no custom tags). It is
 * used only for descriptive metadata (title, language, date). Properties such
 * as `approved: true` or `trust: owner_approved` are ignored: Markdown can
 * never grant trust or authorize anything.
 */

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  /** Body without the frontmatter block. */
  body: string;
  frontmatterError: string | null;
}

const FM_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseMarkdown(raw: string): ParsedMarkdown {
  const text = raw.replace(/^﻿/, '');
  const m = FM_RE.exec(text);
  if (!m) return { frontmatter: {}, body: text, frontmatterError: null };
  const body = text.slice(m[0].length);
  try {
    const parsed = parseYamlSafe(m[1] ?? '', 'frontmatter');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { frontmatter: parsed as Record<string, unknown>, body, frontmatterError: null };
    return { frontmatter: {}, body, frontmatterError: null };
  } catch (err) {
    return { frontmatter: {}, body, frontmatterError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Remove seo-agent generated regions (they present SQLite records that are
 * ingested from their authoritative tables instead). Human-written content
 * outside the markers is kept verbatim.
 */
export function stripGeneratedRegions(body: string): { text: string; removed: number } {
  let removed = 0;
  let out = body;
  while (true) {
    const start = out.indexOf(GENERATED_START);
    if (start < 0) break;
    const end = out.indexOf(GENERATED_END, start + GENERATED_START.length);
    if (end < 0) {
      // Unterminated region: drop to the end to be safe (never ingest half a generated block as human text).
      out = out.slice(0, start);
      removed++;
      break;
    }
    out = out.slice(0, start) + out.slice(end + GENERATED_END.length);
    removed++;
  }
  return { text: out.replace(/\n{3,}/g, '\n\n'), removed };
}

/**
 * Remove invisible comments (HTML `<!-- -->` and Obsidian `%% %%`) outside
 * fenced code blocks: they are not part of the note's readable content.
 */
export function stripComments(body: string): string {
  const parts = body.split(/(^[ \t]{0,3}(?:`{3,}|~{3,})[\s\S]*?^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*$)/m);
  return parts
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/<!--[\s\S]*?-->/g, '').replace(/%%[\s\S]*?%%/g, '')))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+/, '');
}

/** Normalize a link target or document key: NFC, lowercase, no alias/heading/block, no ".md", "/" separators. */
export function normalizeLinkKey(target: string): string {
  let t = target.normalize('NFC').replace(/\\\|/g, '|');
  const pipe = t.indexOf('|');
  if (pipe >= 0) t = t.slice(0, pipe);
  const hash = t.indexOf('#');
  if (hash >= 0) t = t.slice(0, hash);
  t = t.replace(/\\/g, '/').trim();
  try {
    if (/%[0-9a-f]{2}/i.test(t)) t = decodeURIComponent(t);
  } catch {
    /* keep as is */
  }
  t = t.replace(/^\.?\/+/, '').replace(/\.md$/i, '');
  return t.toLowerCase().replace(/\s+/g, ' ').trim();
}

const WIKILINK_RE = /!?\[\[([^[\]\n]+?)\]\]/g;
const MD_LINK_RE = /\[[^\]\n]*\]\(([^)\s]+\.md)(?:#[^)\s]*)?\)/gi;

/** Extract normalized link targets from Markdown (wikilinks and relative .md links). Counts duplicates. */
export function extractLinks(markdown: string): Map<string, number> {
  const out = new Map<string, number>();
  const add = (raw: string) => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return; // external URL
    const key = normalizeLinkKey(raw);
    if (!key) return; // e.g. same-note heading link [[#Heading]]
    out.set(key, (out.get(key) ?? 0) + 1);
  };
  for (const m of markdown.matchAll(WIKILINK_RE)) add(m[1]!);
  for (const m of markdown.matchAll(MD_LINK_RE)) add(m[1]!);
  return out;
}

/**
 * Keys by which other notes can link to a document: the full vault path
 * without ".md" and the basename (Obsidian's "shortest path" form), plus any
 * extra aliases (e.g. a record's vault note path).
 */
export function documentLinkKeys(sourceRef: string, aliases: readonly string[] = []): string[] {
  const keys = new Set<string>();
  for (const ref of [sourceRef, ...aliases]) {
    if (!ref) continue;
    const full = normalizeLinkKey(ref);
    if (!full) continue;
    keys.add(full);
    const base = full.split('/').pop();
    if (base) keys.add(base);
  }
  return [...keys];
}

/** First H1 heading, if any. */
export function firstHeading(body: string): string | null {
  const m = /^#[ \t]+(.+?)[ \t#]*$/m.exec(body);
  return m ? m[1]!.trim() : null;
}

/** Read a string-ish frontmatter value. */
export function fmString(fm: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = fm[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}
