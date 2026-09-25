/**
 * Presentation of a draft package's internal-link suggestions and
 * structured-data proposal, shared by the content pipeline's draft note
 * (src/content/notes.ts) and the vault renderer (`vault render`,
 * src/obsidian/notes-content.ts), so both show them the same way.
 * Dependency-free on purpose (no imports): the vault renderer imports it
 * without loading the content pipeline.
 *
 * `fmt` lets a caller neutralize untrusted text the way it presents text: the
 * vault renderer shows the URL as a literal code span (it reads exactly as
 * stored, never escaped as `https\://www\.` and never a live link) and the
 * anchor and placement through its Markdown escaping. The default leaves the
 * text as it is.
 */

export interface PackageLineFormat {
  /** A target URL (shown literally). */
  url: (text: string) => string;
  /** Other stored text (anchor, placement, note). */
  text: (text: string) => string;
}

export const PLAIN_PACKAGE_FORMAT: PackageLineFormat = { url: (s) => s, text: (s) => s };

/** Shown instead of a structured-data proposal when the package has none. */
export const NO_STRUCTURED_DATA_PROPOSAL = '_None proposed._';

export interface InternalLinkSuggestionLike {
  targetUrl: string;
  anchor: string;
  placement: string;
  /** False (or missing) means the target was not verified against a stored own-site page. */
  verified?: boolean;
}

/** True when a stored value has the shape of an internal-link suggestion (a stored package may be older or malformed). */
export function isInternalLinkSuggestion(v: unknown): v is InternalLinkSuggestionLike {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o.targetUrl === 'string' && o.targetUrl.trim() !== '' && typeof o.anchor === 'string' && typeof o.placement === 'string' && (o.verified === undefined || typeof o.verified === 'boolean');
}

/** `- <targetUrl> ("<anchor>", <placement>)`, with ` **UNVERIFIED**` unless the target was verified. */
export function internalLinkSuggestionLine(l: InternalLinkSuggestionLike, fmt: PackageLineFormat = PLAIN_PACKAGE_FORMAT): string {
  return `- ${fmt.url(l.targetUrl)} ("${fmt.text(l.anchor)}", ${fmt.text(l.placement)})${l.verified ? '' : ' **UNVERIFIED**'}`;
}
