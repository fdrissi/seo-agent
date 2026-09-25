import { REDACTED, redactString } from '../security/redact.js';
import { neutralizeMarkers } from './frontmatter.js';

/**
 * Markdown presentation helpers for generated notes. Standard Markdown first;
 * Obsidian features (wikilinks, callouts) degrade to readable text elsewhere.
 *
 * Every string that comes from the database (page titles, scraped excerpts,
 * provider text, model output) is passed through `inline` / `quoteUntrusted`
 * / `code`, which neutralize, in addition to the generated-region markers:
 * - links of every form: wikilinks and embeds, Markdown links and images
 *   (`[text](url)`, `![alt](url)`), reference links and definitions
 *   (`[ref][1]`, `[1]: url`), angle-bracket autolinks, and bare-URL
 *   autolinks (`https://...`, `obsidian://...`, `www....`);
 * - active content: raw HTML, fenced code blocks (```` ``` ```` / `~~~`, so
 *   no `dataview`/`dataviewjs` block can be formed), inline code spans (so no
 *   Dataview inline `= ...` / `$= ...` query), Dataview inline fields
 *   (`[key:: value]`, `key:: value`), Templater tags (`<% %>`), math (`$`),
 *   tags, and `%%` comments.
 * Untrusted text is presented as data, never as instructions, links, or code.
 * Bidi embedding, override, and isolate controls, which could make the text a
 * reader sees differ from the stored text, are shown as visible `[U+XXXX]`
 * markers (`markBidiControls`, the same markers as src/core/terminal.ts).
 *
 * Secrets never enter the vault: every such helper first applies
 * `redactVaultText` (registered secret values, credential shapes, and
 * credential-bearing URL parameters such as `?token=` / `&sig=`), BEFORE
 * Markdown escaping, so escaping can never hide a secret from the redactor.
 */

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Bidi embedding and override controls (U+202A LRE, U+202B RLE, U+202C PDF,
 * U+202D LRO, U+202E RLO) and isolate controls (U+2066 LRI, U+2067 RLI,
 * U+2068 FSI, U+2069 PDI). The marks U+200E (LRM), U+200F (RLM), and U+061C
 * (ALM) are not included: legitimate right-to-left text uses them, and they
 * cannot reverse or reorder a run of text.
 */
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;

/**
 * Replace every bidi embedding, override, and isolate control with a visible
 * marker, so text written to the vault reads the same as the stored text.
 * `marker` receives the code point as `U+XXXX`; the default gives the
 * `[U+XXXX]` markers of src/core/terminal.ts. Text that must stay free of
 * square brackets (a wikilink alias) passes its own format. Idempotent.
 */
export function markBidiControls(text: string, marker: (codePoint: string) => string = (cp) => `[${cp}]`): string {
  return String(text).replace(BIDI_CONTROLS, (ch) => marker(`U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`));
}

// ---------------------------------------------------------------- secret hygiene

/** Parameter names whose value is a credential when the whole name, or its last `_`/`-`/`.` segment, matches. */
const CREDENTIAL_PARAM_SUFFIX = /^(?:token|tokens|key|apikey|secret|secrets|signature|sig|password|passwd|passphrase|credential|credentials|session|sessionid|jwt|otp|hmac|bearer)$/i;
/** Names that are credentials only as the whole parameter name. */
const CREDENTIAL_PARAM_EXACT = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth|auth[_-]?token|authorization|client[_-]?secret|code|pwd|pass|sid|ticket|nonce|security[_-]?token|private[_-]?token|reset[_-]?token|magic|magic[_-]?link|login[_-]?token|oauth[_-]?token|oauth[_-]?verifier)$/i;

/** True when a URL query/fragment parameter name carries a credential (token, key, signature, password, ...). */
export function isCredentialParamName(name: string): boolean {
  let n = name;
  try {
    n = decodeURIComponent(name);
  } catch {
    /* keep raw */
  }
  n = n.trim();
  if (!n) return false;
  if (CREDENTIAL_PARAM_EXACT.test(n) || CREDENTIAL_PARAM_SUFFIX.test(n)) return true;
  const last = n.split(/[_.\-]/).filter(Boolean).pop() ?? '';
  return last !== n && CREDENTIAL_PARAM_SUFFIX.test(last);
}

/**
 * Mask the values of credential-bearing parameters in URLs and query strings
 * (`?token=`, `&key=`, `access_token=`, `X-Amz-Signature=`, `sig=`,
 * `password=`, `#access_token=`, ...). Names and other parameters stay.
 */
export function maskCredentialUrlParams(text: string): string {
  // A parameter starts after ?, &, #, ; or at a word boundary such as "(" or whitespace (page names show a
  // query string as "(token=...)" without its "?").
  return String(text).replace(/(^|[?&#;(\s,])([A-Za-z0-9_.%[\]-]{1,64})=([^&#\s"'<>|`()[\]]*)/g, (m, sep: string, name: string, value: string) => {
    if (!value || value === 'REDACTED' || m.endsWith(`=${REDACTED}`) || !isCredentialParamName(name)) return m;
    return `${sep}${name}=${REDACTED}`;
  });
}

/**
 * Secret redaction for anything written to the vault: registered secret
 * values and credential shapes (src/security/redact.ts), then credential URL
 * parameters. Idempotent.
 */
export function redactVaultText(text: string): string {
  return maskCredentialUrlParams(redactString(String(text)));
}

/**
 * True when a vault-relative path still contains a secret: a registered
 * secret value, a credential shape, or an unmasked credential parameter.
 * Already-masked values (the bracket-free `REDACTED` marker used in file
 * names) do not count.
 */
export function vaultPathLeaksSecret(relPath: string): boolean {
  return String(relPath)
    .split('/')
    .some((seg) => {
      const probe = seg.replace(/\.md$/i, '').split('REDACTED').join('');
      return redactVaultText(probe) !== probe;
    });
}

/**
 * `redactVaultText` for a whole generated Markdown body. Wikilinks are handled
 * on their own so a masked value can never break the `[[target|alias]]`
 * syntax: the target (a vault path, already redacted when it was planned) is
 * kept as is, and the alias is redacted with a bracket-free marker
 * (`REDACTED`). A link whose target itself still leaks a secret is replaced by
 * its redacted alias as plain text.
 */
export function redactVaultMarkdown(markdown: string): string {
  const text = String(markdown);
  const re = /(!?\[\[)([^\]\n]*?)(\]\])/g;
  const bare = (s: string) => redactVaultText(s).split(REDACTED).join('REDACTED');
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    out += redactVaultText(text.slice(last, at));
    const inner = m[2]!;
    const escaped = inner.indexOf('\\|');
    const pipe = escaped !== -1 ? escaped : inner.indexOf('|');
    const sep = escaped !== -1 ? '\\|' : '|';
    const target = pipe === -1 ? inner : inner.slice(0, pipe);
    const alias = pipe === -1 ? null : inner.slice(pipe + sep.length);
    if (vaultPathLeaksSecret(target.split('#')[0]!)) out += bare(alias ?? target.split('/').pop() ?? '').replace(/[[\]|]/g, ' ');
    else out += `${m[1]}${target}${alias === null ? '' : `${sep}${bare(alias).replace(/[[\]|]/g, ' ')}`}${m[3]}`;
    last = at + m[0].length;
  }
  out += redactVaultText(text.slice(last));
  return out;
}

/** Escape text for a single line of Markdown (no raw HTML, links, embeds, code, queries, or tags). */
export function inline(value: unknown, maxLength = 500): string {
  if (value === null || value === undefined) return '';
  let s = markBidiControls(neutralizeMarkers(redactVaultText(String(value))).replace(CONTROL_CHARS, '')).replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (s.length > maxLength) s = `${s.slice(0, maxLength - 1)}…`;
  return escapeMarkdownText(s);
}

/**
 * Backslash-escape everything in untrusted text that Markdown, Obsidian, or a
 * common plugin could turn into a link, embed, code block, query, field, tag,
 * comment, or HTML. Backslashes are escaped first so the input cannot cancel
 * the escapes added here. The rendered text reads the same as the input.
 */
export function escapeMarkdownText(s: string): string {
  return s.replace(UNTRUSTED_SYNTAX, (m) => (m === '&' ? '&amp;' : m === '<' ? '&lt;' : m === '>' ? '&gt;' : `\\${m}`));
}

/**
 * Neutralize untrusted display text for a wikilink alias (`[[target|alias]]`),
 * matching what `inline` does for body text without backslash escapes: an
 * alias is shown by viewers that do not parse `[[...]]` (plain CommonMark/GFM)
 * as ordinary inline Markdown, while a backslash inside an alias could escape
 * the closing `]]` or a table pipe. So, in one pass (an entity added here is
 * never re-escaped, and the function is idempotent):
 * - `<` `>` become `&lt;` `&gt;` (no raw HTML, autolink, or Templater `<% %>`),
 *   and `&` not starting an entity becomes `&amp;`;
 * - `$` becomes `&#36;` (no math) and `\` becomes `&#92;`;
 * - backticks become `'` (no code span, so no Dataview `= ...` / `$= ...`
 *   inline query can form);
 * - `::` becomes `: :` (no Dataview inline field) and `%%` becomes `% %`
 *   (no Obsidian comment).
 * Wikilink-breaking characters (`[` `]` `|`, line breaks) are the caller's job
 * (`sanitizeLinkAlias` in wikilinks.ts replaces them with spaces).
 */
export function escapeLinkAliasText(s: string): string {
  return String(s).replace(LINK_ALIAS_SYNTAX, (m) => {
    switch (m) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '$':
        return '&#36;';
      case '\\':
        return '&#92;';
      case ':':
        return ': ';
      case '%':
        return '% ';
      default:
        return "'";
    }
  });
}

/** `&` not starting an entity, `< > $ \`, backticks, a colon or percent sign followed by another one. */
const LINK_ALIAS_SYNTAX = /&(?![a-zA-Z][a-zA-Z0-9]*;|#\d+;|#[xX][0-9a-fA-F]+;)|[<>$\\`]|:(?=:)|%(?=%)/g;

/**
 * One pass, so an escape added here can never combine with the input or with
 * another escape. Matches (each is replaced by an entity or a backslash escape):
 * - `\` (escaped first so the input cannot cancel an escape) and `&` not starting an entity;
 * - `<` `>` (raw HTML, autolinks, Templater `<% %>`);
 * - `[` `]` (wikilinks, embeds, Markdown/reference links and definitions,
 *   Dataview `[key:: value]`, callout markers, task checkboxes);
 * - backticks and runs of `~` (code spans, fences, Dataview inline queries);
 * - `$` (math);
 * - the 2nd+ colon of `::` (Dataview `key:: value`) and a colon before `//`
 *   (bare-URL autolinks for every scheme, including `obsidian://`);
 * - the dot of `www.` (GFM `www.` autolinks);
 * - `#` starting a tag;
 * - the 2nd+ `%` of `%%` (Obsidian comments).
 */
const UNTRUSTED_SYNTAX = /\\|&(?![a-zA-Z][a-zA-Z0-9]*;|#\d+;|#[xX][0-9a-fA-F]+;)|[<>[\]`$]|~(?=~)|(?<=~)~|(?<=:):|:(?=\/\/)|(?<=\bwww)\.|(?<=^|\s)#(?=[^\s#])|(?<=%)%/gi;

/**
 * Untrusted single-line text (a URL, id, hash, path) as an inline code span:
 * shown literally, never a link. The fence is longer than any backtick run in
 * the text. Text that would form a Dataview inline query (it starts with `=`
 * or `$`) or a Templater tag is shown as escaped plain text instead.
 */
export function code(value: unknown, maxLength = 500): string {
  if (value === null || value === undefined) return '';
  let s = markBidiControls(neutralizeMarkers(redactVaultText(String(value))).replace(CONTROL_CHARS, '')).replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (s === '') return '';
  if (s.length > maxLength) s = `${s.slice(0, maxLength - 1)}…`;
  if (/^[=$]/.test(s) || s.includes('<%') || s.includes('%>')) return inline(s, maxLength);
  const longest = Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

/** Escape text for a Markdown table cell. */
export function cell(value: unknown, maxLength = 200): string {
  const s = inline(value, maxLength).replace(/\|/g, '\\|');
  return s === '' ? ' ' : s;
}

/** A raw (already safe) Markdown fragment for a table cell, e.g. a wikilink. */
export function rawCell(markdown: string): string {
  return markdown.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

export function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '';
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  return [head, sep, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

/**
 * Multi-line untrusted text as a blockquote. Each line is escaped like
 * `inline`, so fences (```` ``` ````, `~~~`), code spans, links, and fields
 * inside the quote stay plain text.
 */
export function quoteUntrusted(value: unknown, maxLength = 1_500): string {
  if (value === null || value === undefined || String(value).trim() === '') return '> (empty)';
  let s = markBidiControls(neutralizeMarkers(redactVaultText(String(value))).replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, ''));
  if (s.length > maxLength) s = `${s.slice(0, maxLength - 1)}…`;
  return s
    .split('\n')
    .map((l) => `> ${escapeMarkdownText(l.replace(/^\s*>+/, '').trim())}`.trimEnd())
    .join('\n');
}

/**
 * JSON (or any value) in a fenced code block with a fence that cannot be
 * closed by the content. Bidi controls are kept here (no `markBidiControls`):
 * the conflict backup of a human-edited note (writer.ts) is a code block, and
 * it must keep the human's text, including right-to-left formatting.
 */
export function codeBlock(value: unknown, lang = 'json'): string {
  const text = neutralizeMarkers(redactVaultText(typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'null'));
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

export function bulletList(items: string[], empty = '_None recorded._'): string {
  return items.length ? items.map((i) => `- ${i}`).join('\n') : empty;
}

/** Integer with thousands separators; missing stays explicit. */
export function fmtInt(n: number | null | undefined, missingText = 'missing'): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return missingText;
  return Math.round(n).toLocaleString('en-US');
}

export function fmtNum(n: number | null | undefined, digits = 1, missingText = 'missing'): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return missingText;
  return n.toFixed(digits);
}

export function fmtPct(ratio: number | null | undefined, digits = 2, missingText = 'missing'): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return missingText;
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function fmtDate(iso: string | null | undefined, missingText = 'unknown'): string {
  if (!iso) return missingText;
  return inline(String(iso).slice(0, 10));
}

export function fmtTimestamp(iso: string | null | undefined, missingText = 'unknown'): string {
  if (!iso) return missingText;
  return inline(String(iso).replace('T', ' ').replace(/\.\d+Z$/, 'Z'), 60);
}

export function yesNo(v: number | boolean | null | undefined, unknown = 'unknown'): string {
  if (v === null || v === undefined) return unknown;
  return v ? 'yes' : 'no';
}

/** Callout (Obsidian) that renders as a plain blockquote in standard Markdown. */
export function callout(kind: 'warning' | 'info' | 'note' | 'danger', title: string, lines: string[] = []): string {
  return [`> [!${kind}] ${title}`, ...lines.map((l) => `> ${l}`)].join('\n');
}

export function syntheticBanner(): string {
  return callout('warning', 'SYNTHETIC DEMO DATA', ['This note presents clearly labeled synthetic fixtures. It is not real site data.']);
}

/** Render a flat JSON object as a bullet list of key/value pairs (unknown shapes stay readable). */
export function describeJson(value: unknown, maxItems = 25): string {
  if (value === null || value === undefined) return '_Not recorded._';
  if (typeof value !== 'object') return inline(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '_None recorded._';
    const items = value.slice(0, maxItems).map((v) => (v !== null && typeof v === 'object' ? `- ${summarizeObject(v as Record<string, unknown>)}` : `- ${inline(v)}`));
    if (value.length > maxItems) items.push(`- … ${value.length - maxItems} more`);
    return items.join('\n');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '_None recorded._';
  const items = entries.slice(0, maxItems).map(([k, v]) => `- **${inline(k, 80)}**: ${v !== null && typeof v === 'object' ? summarizeValue(v) : inline(v)}`);
  if (entries.length > maxItems) items.push(`- … ${entries.length - maxItems} more`);
  return items.join('\n');
}

function summarizeValue(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => (x !== null && typeof x === 'object' ? summarizeObject(x as Record<string, unknown>) : inline(x, 120))).join('; ') || '(empty)';
  return summarizeObject(v as Record<string, unknown>);
}

function summarizeObject(o: Record<string, unknown>): string {
  return (
    Object.entries(o)
      .slice(0, 8)
      .map(([k, v]) => `${inline(k, 60)}: ${v !== null && typeof v === 'object' ? inline(JSON.stringify(v), 160) : inline(v, 160)}`)
      .join(', ') || '(empty)'
  );
}

export function parseJsonSafe<T = unknown>(text: unknown): T | null {
  if (typeof text !== 'string' || text === '') return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
