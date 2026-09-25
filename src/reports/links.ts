import { markControlChars } from '../core/terminal.js';
import { redactString } from '../security/redact.js';

/**
 * Link rendering for reports and the dashboard.
 *
 * Reports are standard Markdown by default: record references render as
 * inline code (`table:id`) and external URLs as Markdown links. Obsidian
 * wikilinks are optional and layered on through a resolver function (the
 * integration phase passes one built on `VaultWriter.link`).
 */

export type LinkTargetKind =
  | 'page'
  | 'experiment'
  | 'recommendation'
  | 'opportunity'
  | 'content_item'
  | 'report'
  | 'approval'
  | 'source'
  | 'vault_note';

export interface LinkTarget {
  kind: LinkTargetKind;
  id: string;
  label: string;
  /** External URL (http/https only are rendered as links). */
  url?: string | null;
  /** Vault-relative path when the target is a known note. */
  notePath?: string | null;
}

/** Returns Markdown for the link, or null to fall back to the default rendering. */
export type LinkResolver = (target: LinkTarget) => string | null;

/**
 * Escape text for inline Markdown (untrusted DB text must not become markup or links).
 *
 * Secrets are redacted on the RAW text first: escaping inserts backslashes
 * (e.g. `my_secret` -> `my\_secret`), after which neither a registered secret
 * value nor a credential-shape pattern would match any more.
 *
 * Line breaks of any kind (CRLF, LF, and a lone CR, which would let a later
 * line overwrite this one on a terminal) become one space. Every other C0/C1
 * control character (ESC of an ANSI/OSC sequence, BEL, CSI, ...) becomes a
 * visible `[U+XXXX]` marker, which is then escaped like any other text, so a
 * report printed with `report show` or opened in a pager cannot rewrite the
 * screen.
 */
export function escapeMd(text: string): string {
  return markControlChars(redactString(text).replace(/(?:\r\n|\r|\n)+/g, ' '))
    .replace(/([\\`*_[\]<>|#~])/g, '\\$1')
    .replace(/%%/g, '%\\%')
    .trim();
}

export function isHttpUrl(u: string | null | undefined): u is string {
  if (!u) return false;
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Encode a URL for use inside a Markdown link destination (control characters are percent-encoded too). */
function mdDestination(u: string): string {
  return u.replace(/[()\s<>\u0000-\u001F\u007F-\u009F]/g, (c) => encodeURIComponent(c));
}

export const defaultLinkResolver: LinkResolver = (t) => {
  if (isHttpUrl(t.url)) return `[${escapeMd(t.label)}](${mdDestination(t.url)})`;
  return `${escapeMd(t.label)} (\`${t.kind}:${redactString(t.id).replace(/`/g, '')}\`)`;
};

/** Redact every free-text field of a link target before any resolver sees it (resolvers may alter characters). */
function redactTarget(t: LinkTarget): LinkTarget {
  const out: LinkTarget = { ...t, id: redactString(t.id), label: redactString(t.label) };
  if (t.url) out.url = redactString(t.url);
  return out;
}

/** Render a link using `resolver`, falling back to the default standard-Markdown rendering. */
export function renderLink(target: LinkTarget, resolver?: LinkResolver): string {
  const safe = redactTarget(target);
  let custom: string | null = null;
  try {
    custom = resolver ? resolver(safe) : null;
  } catch {
    // A resolver that cannot link this target (e.g. VaultWriter.link: the note is neither on disk nor planned)
    // falls back to the standard rendering instead of failing the whole report or dashboard.
    custom = null;
  }
  return custom ?? defaultLinkResolver(safe) ?? escapeMd(safe.label);
}

/**
 * Wikilink resolver factory. `link` is typically `VaultWriter.link`;
 * `notePath` maps a target to its vault-relative note path (or null when the
 * record has no note, in which case the default rendering is used).
 */
export function wikiLinkResolver(opts: {
  link: (toRelPath: string, alias?: string) => string;
  notePath: (t: LinkTarget) => string | null;
}): LinkResolver {
  return (t) => {
    const p = t.notePath ?? opts.notePath(t);
    if (!p) return null;
    const alias = t.label.replace(/[|[\]#^]/g, ' ').replace(/\s+/g, ' ').trim();
    return opts.link(p, alias || undefined);
  };
}
