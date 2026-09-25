import { ValidationError } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import { safeFileSegment } from '../security/paths.js';
import { REDACTED } from '../security/redact.js';
import { neutralizeMarkers } from './frontmatter.js';
import { escapeLinkAliasText, markBidiControls, redactVaultText } from './markdown.js';

/**
 * Path-aware wikilinks. Generated links always use the full vault path
 * ("Absolute path in vault", see docs/integration-contracts.md, Obsidian
 * links): `[[02 Website/Pages/Pricing|Pricing]]`. Shortest-path links such as
 * `[[Pricing]]` are never generated because they become ambiguous as soon as
 * two notes share a name.
 *
 * Characters that break Obsidian links (`# | ^ : %% [[ ]]`) are kept out of
 * file names and link targets, and new file names carry no backticks (a link
 * target cannot hold a code span). Alias text is untrusted (titles, queries,
 * domains) and is neutralized like body text (`escapeLinkAliasText`): no raw
 * HTML, code span, math, Dataview field, Templater tag, or `%%` comment.
 */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Readable, link-safe file base name (without extension). Secrets and
 * credential URL parameters are redacted first (file names are part of the
 * vault). Leading dots/whitespace (hidden files) and trailing dots/spaces
 * (invalid on Windows) are stripped until the name is stable. Backticks become
 * `'` so a link target never carries a code span (only new names are affected:
 * a note keeps the path recorded in `vault_notes`, see plan.ts).
 */
export function noteFileName(name: string, maxLength = 100): string {
  let s = safeFileSegment(redactVaultText(String(name ?? '')).split(REDACTED).join('REDACTED'), maxLength)
    .replace(/%/g, ' ')
    .replace(/`+/g, "'")
    .replace(/\.conflict-/gi, ' conflict-')
    .replace(/\s+/g, ' ');
  for (let prev: string | null = null; prev !== s; ) {
    prev = s;
    s = s.trim().replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  }
  if (!s) s = 'untitled';
  if (WINDOWS_RESERVED.test(s)) s = `${s} note`;
  return s;
}

/** Deterministic short suffix used to disambiguate colliding file names. */
export function shortHash(value: string, length = 6): string {
  return sha256(value).slice(0, length);
}

/** Join a vault folder and a readable name into a vault-relative note path. */
export function notePath(folder: string, name: string): string {
  const cleanFolder = folder.replace(/^\/+|\/+$/g, '');
  return `${cleanFolder}/${noteFileName(name)}.md`;
}

/** Link target (vault path without the `.md` extension). */
export function wikilinkTarget(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.md$/i, '');
}

const ALIAS_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * Display text safe inside `[[target|alias]]`. Secrets are redacted first;
 * wikilink-breaking characters (`[` `]` `|`, line breaks, control characters)
 * become spaces; bidi embedding, override, and isolate controls (U+202A-U+202E,
 * U+2066-U+2069) become visible `(U+XXXX)` markers (the `[U+XXXX]` markers of
 * body text would break the link), so the alias reads the same as the stored
 * text; the rest is neutralized like body text by `escapeLinkAliasText` (raw
 * HTML as entities, no code spans, math, Dataview fields, Templater tags, or
 * `%%` comments). Idempotent.
 */
export function sanitizeLinkAlias(text: string): string {
  const s = escapeLinkAliasText(
    markBidiControls(neutralizeMarkers(redactVaultText(String(text ?? ''))), (cp) => `(${cp})`)
      .split(REDACTED)
      .join('REDACTED')
      .replace(ALIAS_CONTROL_CHARS, ' ')
      .replace(/[[\]|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  return s || 'untitled';
}

const UNSAFE_TARGET = /[[\]|#^]|%%|[\u0000-\u001f]/;

/** Format a path-aware wikilink. Throws if the target contains link-breaking characters. */
export function formatWikilink(relPath: string, alias?: string): string {
  const target = wikilinkTarget(relPath);
  if (!target || UNSAFE_TARGET.test(target) || target.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new ValidationError(`Unsafe wikilink target: ${JSON.stringify(relPath)}`);
  }
  const base = target.split('/').pop()!;
  // A dotted name such as "rival.example.test" could be read as a file with an
  // extension; keep the explicit .md so the link resolves to the note.
  const linkTarget = base.includes('.') ? `${target}.md` : target;
  return `[[${linkTarget}|${sanitizeLinkAlias(alias ?? base)}]]`;
}

/** Escape a wikilink for use inside a Markdown table cell (`|` must be `\|`). */
export function tableSafeLink(link: string): string {
  return link.replace(/\|/g, '\\|');
}

export interface ParsedWikilink {
  raw: string;
  /** Link target path/name without heading/block subpath. */
  target: string;
  /** `#Heading` or `#^block` part, if any. */
  subpath: string | null;
  alias: string | null;
  embed: boolean;
  /** 1-based line number in the scanned text. */
  line: number;
}

/**
 * Extract wikilinks from Markdown, ignoring fenced code blocks, inline code,
 * HTML comments, and Obsidian `%%` comments. Handles table-escaped pipes
 * (`[[target\|alias]]`).
 */
export function extractWikilinks(markdown: string): ParsedWikilink[] {
  const out: ParsedWikilink[] = [];
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let fence: string | null = null;
  let inHtmlComment = false;
  let inObsidianComment = false;
  lines.forEach((rawLine, i) => {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(rawLine);
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) fence = null;
      return;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      return;
    }
    let line = '';
    let j = 0;
    while (j < rawLine.length) {
      if (inHtmlComment) {
        const end = rawLine.indexOf('-->', j);
        if (end === -1) {
          j = rawLine.length;
          break;
        }
        inHtmlComment = false;
        j = end + 3;
        continue;
      }
      if (inObsidianComment) {
        const end = rawLine.indexOf('%%', j);
        if (end === -1) {
          j = rawLine.length;
          break;
        }
        inObsidianComment = false;
        j = end + 2;
        continue;
      }
      if (rawLine.startsWith('<!--', j)) {
        inHtmlComment = true;
        j += 4;
        continue;
      }
      if (rawLine.startsWith('%%', j)) {
        inObsidianComment = true;
        j += 2;
        continue;
      }
      if (rawLine[j] === '`') {
        const run = /^`+/.exec(rawLine.slice(j))![0];
        const close = rawLine.indexOf(run, j + run.length);
        if (close !== -1) {
          line += ' '.repeat(close + run.length - j);
          j = close + run.length;
          continue;
        }
      }
      line += rawLine[j];
      j++;
    }
    const re = /(!?)\[\[([^\]\n]*?)\]\]/g;
    for (let m = re.exec(line); m; m = re.exec(line)) {
      const inner = m[2]!;
      let targetPart = inner;
      let alias: string | null = null;
      const escapedPipe = inner.indexOf('\\|');
      const pipe = escapedPipe !== -1 ? escapedPipe : inner.indexOf('|');
      if (pipe !== -1) {
        targetPart = inner.slice(0, pipe);
        alias = inner.slice(pipe + (escapedPipe !== -1 ? 2 : 1));
      }
      let subpath: string | null = null;
      const hash = targetPart.indexOf('#');
      if (hash !== -1) {
        subpath = targetPart.slice(hash);
        targetPart = targetPart.slice(0, hash);
      }
      out.push({ raw: m[0], target: targetPart.trim(), subpath, alias, embed: m[1] === '!', line: i + 1 });
    }
  });
  return out;
}
