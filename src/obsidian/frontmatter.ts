import { isMap, isNode, isScalar, isSeq, parseDocument, stringify, visit } from 'yaml';
import { ValidationError } from '../core/errors.js';
import { sha256, stableStringify } from '../core/hash.js';
import { GENERATED_END, GENERATED_START, type ParsedNote } from './types.js';

/**
 * Note parsing and serialization.
 *
 * YAML safety: frontmatter is parsed with the `yaml` package's YAML 1.2 core
 * schema, no custom tags, unique keys, and a small alias budget. Any explicit
 * tag (`!!js/function`, `!!python/object`, `!!binary`, `!custom`, even `!!str`)
 * is REJECTED rather than resolved or downgraded to a string, and so is any
 * parser warning. Prototype-polluting keys are rejected. Nothing in a note is
 * ever executed or constructed beyond plain maps, lists, and scalars.
 */

export const MAX_FRONTMATTER_BYTES = 64 * 1024;
export const MAX_NOTE_BYTES = 5 * 1024 * 1024;
const MAX_ALIAS_COUNT = 20;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class NoteFormatError extends ValidationError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, details);
    this.name = 'NoteFormatError';
  }
}

/** Parse YAML text strictly (see module comment). Returns plain JS data. */
export function parseYamlStrict(text: string, source = 'yaml'): unknown {
  if (Buffer.byteLength(text, 'utf8') > MAX_FRONTMATTER_BYTES) {
    throw new NoteFormatError(`${source}: YAML block is larger than ${MAX_FRONTMATTER_BYTES} bytes`);
  }
  const doc = parseDocument(text, { schema: 'core', customTags: [], uniqueKeys: true, prettyErrors: false, strict: true });
  if (doc.errors.length) {
    throw new NoteFormatError(`${source}: invalid YAML (${doc.errors[0]!.message.split('\n')[0]})`, { errors: doc.errors.map((e) => e.code) });
  }
  const tags: string[] = [];
  let aliases = 0;
  visit(doc, {
    Node(_key, node) {
      const tag = (node as { tag?: string }).tag;
      if (tag) tags.push(tag);
    },
    Alias() {
      aliases++;
    },
  });
  if (tags.length) {
    throw new NoteFormatError(`${source}: explicit YAML tags are not allowed (${[...new Set(tags)].join(', ')})`, { tags });
  }
  if (doc.warnings.length) {
    throw new NoteFormatError(`${source}: YAML warning treated as an error (${doc.warnings[0]!.message.split('\n')[0]})`);
  }
  if (aliases > MAX_ALIAS_COUNT) throw new NoteFormatError(`${source}: too many YAML aliases (${aliases})`);
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch (err) {
    throw new NoteFormatError(`${source}: YAML could not be converted safely (${(err as Error).message})`);
  }
  assertNoForbiddenKeys(value, source);
  return value;
}

function assertNoForbiddenKeys(value: unknown, source: string, depth = 0): void {
  if (depth > 32) throw new NoteFormatError(`${source}: YAML nesting is too deep`);
  if (Array.isArray(value)) {
    for (const v of value) assertNoForbiddenKeys(v, source, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    if (value instanceof Uint8Array) throw new NoteFormatError(`${source}: binary YAML values are not allowed`);
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) throw new NoteFormatError(`${source}: forbidden YAML key "${k}"`);
      assertNoForbiddenKeys(v, source, depth + 1);
    }
  }
}

/** Frontmatter must be a mapping (or empty). */
export function parseFrontmatterBlock(yamlText: string, source = 'frontmatter'): Record<string, unknown> {
  if (yamlText.trim() === '') return {};
  // Reject a top-level non-mapping early with a precise message.
  const doc = parseDocument(yamlText, { schema: 'core', customTags: [], uniqueKeys: true, prettyErrors: false });
  if (!doc.errors.length && doc.contents !== null && !isMap(doc.contents)) {
    throw new NoteFormatError(`${source}: frontmatter must be a YAML mapping of properties`);
  }
  const value = parseYamlStrict(yamlText, source);
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new NoteFormatError(`${source}: frontmatter must be a YAML mapping of properties`);
  return value as Record<string, unknown>;
}

export interface SplitNote {
  hasFrontmatter: boolean;
  /** Raw YAML text between the `---` fences (without the fences). */
  frontmatterText: string;
  /** Everything after the closing fence, verbatim. */
  body: string;
}

const FM_OPEN = /^﻿?---[ \t]*\r?\n/;
const FM_CLOSE = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m;

/** Split a note into its frontmatter block and body (body kept verbatim). */
export function splitFrontmatter(raw: string, source = 'note'): SplitNote {
  const open = FM_OPEN.exec(raw);
  if (!open) return { hasFrontmatter: false, frontmatterText: '', body: raw.replace(/^﻿/, '') };
  const rest = raw.slice(open[0].length);
  const close = FM_CLOSE.exec(rest);
  if (!close) throw new NoteFormatError(`${source}: frontmatter starts with '---' but has no closing '---' line`);
  return { hasFrontmatter: true, frontmatterText: rest.slice(0, close.index), body: rest.slice(close.index + close[0].length) };
}

export interface GeneratedRegionLocation {
  /** Human-owned text before the start marker (verbatim). */
  prefix: string;
  /** Raw text between the markers. */
  region: string;
  /** Human-owned text after the end marker (verbatim). */
  suffix: string;
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * Locate the single generated region. Returns null when the body has no
 * markers at all; throws when markers are duplicated, unbalanced, or reversed
 * (the note cannot be merged safely).
 */
export function locateGeneratedRegion(body: string, source = 'note'): GeneratedRegionLocation | null {
  const starts = countOccurrences(body, GENERATED_START);
  const ends = countOccurrences(body, GENERATED_END);
  if (starts === 0 && ends === 0) return null;
  if (starts !== 1 || ends !== 1) {
    throw new NoteFormatError(`${source}: expected exactly one generated start and end marker (found ${starts} start, ${ends} end)`);
  }
  const s = body.indexOf(GENERATED_START);
  const e = body.indexOf(GENERATED_END);
  if (e < s) throw new NoteFormatError(`${source}: generated end marker appears before the start marker`);
  return { prefix: body.slice(0, s), region: body.slice(s + GENERATED_START.length, e), suffix: body.slice(e + GENERATED_END.length) };
}

/**
 * Canonical form of generated Markdown for hashing: LF line endings, trailing
 * whitespace removed per line, leading/trailing blank lines removed.
 */
export function normalizeRegion(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

export interface ParsedNoteStructure extends ParsedNote {
  split: SplitNote;
  location: GeneratedRegionLocation | null;
}

/** Parse a note: strict frontmatter, verbatim body, and the generated region (normalized) if present. */
export function parseNoteStructure(raw: string, source = 'note'): ParsedNoteStructure {
  if (Buffer.byteLength(raw, 'utf8') > MAX_NOTE_BYTES) throw new NoteFormatError(`${source}: note is larger than ${MAX_NOTE_BYTES} bytes`);
  const split = splitFrontmatter(raw, source);
  const frontmatter = split.hasFrontmatter ? parseFrontmatterBlock(split.frontmatterText, source) : {};
  const location = locateGeneratedRegion(split.body, source);
  return {
    frontmatter,
    body: split.body,
    raw,
    generatedRegion: location ? normalizeRegion(location.region) : null,
    split,
    location,
  };
}

export function parseNote(raw: string, source = 'note'): ParsedNote {
  const { frontmatter, body, generatedRegion } = parseNoteStructure(raw, source);
  return { frontmatter, body, raw, generatedRegion };
}

/** Serialize properties as an Obsidian-compatible YAML frontmatter block (core schema, no tags). */
export function serializeFrontmatter(fm: Record<string, unknown>): string {
  if (Object.keys(fm).length === 0) return '';
  const yamlText = stringify(fm, { schema: 'core', lineWidth: 0, minContentWidth: 0, indent: 2, sortMapEntries: false, aliasDuplicateObjects: false });
  return `---\n${yamlText}---\n`;
}

/**
 * Normalize a frontmatter value to something that round-trips exactly through
 * YAML and is valid as an Obsidian property: scalars and flat lists only.
 * Strings become single-line; control characters are removed.
 */
export function normalizePropertyValue(value: unknown, key: string): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return singleLine(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) {
    return value.map((v) => {
      if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
        throw new ValidationError(`Frontmatter property "${key}" must be a flat list (nested objects are not valid Obsidian properties)`);
      }
      return normalizePropertyValue(v, key);
    });
  }
  throw new ValidationError(`Frontmatter property "${key}" must be a scalar or a flat list (Obsidian does not support nested properties)`);
}

export function singleLine(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
}

/**
 * Canonical value used for hashing generated properties. Empty values (null,
 * '', []) are equivalent so harmless re-serialization by an editor does not
 * look like a human edit.
 */
function canonicalPropertyValue(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) return value.length === 0 ? null : value.map(canonicalPropertyValue);
  if (value instanceof Date) return value.toISOString();
  return value;
}

/** Keys excluded from the generated-content hash (they change on every write). */
export const VOLATILE_KEYS: ReadonlySet<string> = new Set(['generated_at']);

/**
 * List properties the vault shares with its owner (Obsidian's default list
 * properties). seo-agent adds its own entries (for example the
 * `seo-agent/<kind>` tag) but never owns the whole list: entries a human adds
 * are kept on every update and never count as an edit of generated content.
 * These keys are therefore excluded from the generated-content hash.
 */
export const MERGEABLE_LIST_KEYS: ReadonlySet<string> = new Set(['tags', 'aliases', 'cssclasses']);

/**
 * Hash of the generated part of a note: the generated properties (minus
 * volatile keys and shared list keys) plus the normalized generated region.
 * `includeMergeable` reproduces the hash recorded by earlier versions, which
 * also covered the shared list keys (accepted once so upgrades do not look
 * like edits).
 */
export function generatedContentHash(generatedProps: Record<string, unknown>, region: string, opts: { includeMergeable?: boolean } = {}): string {
  const props: Record<string, unknown> = {};
  for (const key of Object.keys(generatedProps).sort()) {
    if (VOLATILE_KEYS.has(key)) continue;
    if (!opts.includeMergeable && MERGEABLE_LIST_KEYS.has(key)) continue;
    props[key] = canonicalPropertyValue(generatedProps[key]);
  }
  return sha256(stableStringify({ props, region: normalizeRegion(region) }));
}

/**
 * Union of the generator's entries and the entries already on disk for a
 * shared list property (generator entries first, human entries kept in their
 * order). Returns null when the value on disk is not a list or a scalar.
 */
export function mergeListProperty(generated: unknown, onDisk: unknown): unknown[] | null {
  const asList = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : v === null || v === undefined || v === '' ? [] : typeof v === 'object' ? null : [v]);
  const g = asList(generated);
  const d = asList(onDisk);
  if (!g || !d) return null;
  const out = [...g];
  for (const x of d) if (!out.some((y) => JSON.stringify(y) === JSON.stringify(x))) out.push(x);
  return out;
}

/**
 * Make a generated text property inert in Obsidian's Properties view: no
 * wikilinks (`[[`), no Markdown links (`](`), and no clickable URI for any
 * scheme other than http(s) (for example `obsidian://`). Readable text stays.
 */
export function sanitizePropertyText(text: string): string {
  return text
    .replace(/\[(?=\[)/g, '[ ')
    .replace(/\](?=\])/g, '] ')
    .replace(/\](?=\()/g, '] ')
    .replace(/\b([a-z][a-z0-9+.-]*):\/\//gi, (m, scheme: string) => (/^https?$/i.test(scheme) ? m : `${scheme}: //`));
}

const SCALAR_TYPES = new Set(['string', 'number', 'boolean']);

/**
 * Edit an existing frontmatter block in place: set `set` (generated values),
 * delete `remove` (generated keys no longer produced), and leave everything
 * else as the human wrote it: comments, key order, quoting, and human
 * properties. Unchanged values keep their original nodes. Returns the new
 * YAML text (without fences), or null when the block cannot be edited safely;
 * callers must verify the result by parsing it again.
 */
export function editFrontmatterText(yamlText: string, set: Record<string, unknown>, remove: readonly string[]): string | null {
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(yamlText, { schema: 'core', customTags: [], uniqueKeys: true, prettyErrors: false, strict: true });
  } catch {
    return null;
  }
  if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) return null;
  const map = doc.contents;
  for (const key of remove) {
    if (Object.prototype.hasOwnProperty.call(set, key)) continue;
    const idx = map.items.findIndex((p) => isScalar(p.key) && p.key.value === key);
    if (idx === -1) continue;
    const removed = map.items[idx]!;
    map.items.splice(idx, 1);
    // Keep a comment written above a removed generated key.
    const comment = isNode(removed.key) ? removed.key.commentBefore : undefined;
    if (comment) {
      const next = map.items[idx];
      if (next && isNode(next.key)) next.key.commentBefore = next.key.commentBefore ? `${comment}\n${next.key.commentBefore}` : comment;
      else map.comment = map.comment ? `${map.comment}\n${comment}` : comment;
    }
  }
  for (const [key, value] of Object.entries(set)) {
    const cur = map.get(key, true);
    const curJs = isNode(cur) ? (cur.toJSON() as unknown) : cur;
    if (cur !== undefined && JSON.stringify(curJs ?? null) === JSON.stringify(value ?? null)) continue;
    if (isScalar(cur) && (value === null || SCALAR_TYPES.has(typeof value)) && (cur.value === null || value === null || typeof cur.value === typeof value)) {
      cur.value = value;
      continue;
    }
    const node = doc.createNode(value);
    if (isSeq(cur) && isSeq(node)) node.flow = cur.flow;
    map.set(key, node);
  }
  return doc.toString({ lineWidth: 0, minContentWidth: 0, indent: 2, flowCollectionPadding: false });
}

/** Pick `keys` from `fm` (missing keys become undefined, which hash as empty). */
export function pickProps(fm: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = Object.prototype.hasOwnProperty.call(fm, k) ? fm[k] : undefined;
  return out;
}

/**
 * Make text safe to place inside a generated region: marker strings are
 * neutralized so untrusted content can never close the region early or open a
 * second one, and NUL bytes are removed.
 */
export function neutralizeMarkers(text: string): string {
  return text.replace(/\u0000/g, '').replace(/seo-agent:generated/gi, 'seo-agent&#58;generated');
}

/** Compose a full region block (markers + body). */
export function composeRegion(body: string): string {
  return `${GENERATED_START}\n${normalizeRegion(body)}\n${GENERATED_END}`;
}
