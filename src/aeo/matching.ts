import type { SiteConfig } from '../config/site-schema.js';

/**
 * Deterministic, in-code classification of one AI answer observation
 * (spec 17). Nothing here asks a model; numbers stay in code.
 *
 * - A BRAND MENTION is read from the response TEXT only: the site's business
 *   name, a configured brand alias, or one of its allowed hostnames appears
 *   as a whole word (case-insensitive, Unicode-aware). A URL that appears in
 *   the text is a mention, not a citation.
 * - An OWN-SITE CITATION is read from the CITED URLS only: at least one cited
 *   URL is on one of `site.allowedHostnames` (exact hostname; www and non-www
 *   are never merged automatically, subdomains are not assumed).
 * - Unknown stays unknown: no response text gives `brandMentioned = null`,
 *   cited URLs that were not recorded give `ownSiteCited = null`. Only an
 *   explicit empty list ("the engine cited nothing") gives `false`.
 *
 * A mention is not a citation, a citation is not a click, and a click is not
 * a conversion; this module computes the first two and nothing more.
 */

export const AI_CITATION_MATCHING_VERSION = 'ai-citation-matching@1';

/** Terms shorter than this are ignored (a one-letter alias would match almost any text). */
const MIN_TERM_LENGTH = 2;

export interface BrandTerms {
  /** Normalized terms in match order (longest first). */
  terms: string[];
  /** Where each term came from, for explanations. */
  origin: Record<string, 'business_name' | 'brand_alias' | 'hostname'>;
}

function normalizeText(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Lower-case ASCII (punycode) hostname without a trailing dot, or null when it is not a valid hostname. */
export function normalizeHostname(host: string): string | null {
  const h = host.trim().replace(/\.$/, '');
  if (!h || /[\s/@:?#]/.test(h)) return null;
  try {
    return new URL(`http://${h}/`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The site's own hostnames (exact, normalized). */
export function ownHostnames(config: Pick<SiteConfig, 'site'>): string[] {
  return [...new Set(config.site.allowedHostnames.map((h) => normalizeHostname(h)).filter((h): h is string => !!h))];
}

/** Brand terms from site config: business name, brand aliases, and allowed hostnames. Never hardcoded. */
export function brandTerms(config: Pick<SiteConfig, 'site' | 'brand'>): BrandTerms {
  const origin: BrandTerms['origin'] = {};
  const add = (raw: string, kind: BrandTerms['origin'][string]) => {
    const t = normalizeText(raw);
    if (t.length < MIN_TERM_LENGTH || origin[t]) return;
    origin[t] = kind;
  };
  add(config.site.businessName, 'business_name');
  for (const a of config.brand.aliases) add(a, 'brand_alias');
  for (const h of ownHostnames(config)) add(h, 'hostname');
  const terms = Object.keys(origin).sort((a, b) => b.length - a.length || a.localeCompare(b));
  return { terms, origin };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const regexCache = new Map<string, RegExp>();

function termRegExp(term: string): RegExp {
  let re = regexCache.get(term);
  if (!re) {
    // Whole-word match: no letter or digit directly before or after the term; inner spaces match any whitespace run.
    const body = term.split(' ').map(escapeRegExp).join('\\s+');
    re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu');
    regexCache.set(term, re);
  }
  return re;
}

/**
 * Brand terms found in a response text. Returns null when there is no
 * response text (unknown), an empty array when the text mentions none.
 */
export function brandMentionsIn(responseText: string | null | undefined, terms: BrandTerms): string[] | null {
  if (responseText === null || responseText === undefined || responseText.trim() === '') return null;
  const text = responseText.normalize('NFC');
  return terms.terms.filter((t) => termRegExp(t).test(text));
}

export type CitedUrlParse = { ok: true; urls: string[] | null } | { ok: false; errors: string[] };

const NONE_WORDS = new Set(['none', '[]', 'no citations', 'no sources']);

function parseOneUrl(raw: string, errors: string[]): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    errors.push(`cited URL is not an absolute URL (got "${raw.slice(0, 200)}")`);
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    errors.push(`cited URL must use http or https (got "${raw.slice(0, 200)}")`);
    return null;
  }
  if (u.username || u.password) {
    errors.push('cited URL contains credentials (user:password@); remove them before importing');
    return null;
  }
  return u.href;
}

/**
 * Parse the cited URLs of one observation.
 * - `null`, `undefined`, or blank text: not recorded (unknown) -> `urls: null`.
 * - `[]`, or the words "none" / "no citations": the engine cited nothing -> `urls: []`.
 * - An array of URLs, a JSON array string, or text separated by whitespace or `|`.
 * URLs are kept as cited (tracking parameters included); duplicates are removed.
 */
export function parseCitedUrls(value: unknown): CitedUrlParse {
  if (value === null || value === undefined) return { ok: true, urls: null };
  let items: unknown[];
  if (Array.isArray(value)) items = value;
  else if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return { ok: true, urls: null };
    if (NONE_WORDS.has(s.toLowerCase())) return { ok: true, urls: [] };
    if (s.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(s);
        if (!Array.isArray(parsed)) return { ok: false, errors: ['cited_urls looks like JSON but is not an array'] };
        items = parsed;
      } catch {
        return { ok: false, errors: ['cited_urls starts with "[" but is not a valid JSON array'] };
      }
    } else items = s.split(/[\s|]+/).filter(Boolean);
  } else return { ok: false, errors: ['cited_urls must be a list of URLs, a text of URLs separated by spaces or "|", or "none"'] };
  const errors: string[] = [];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string' || item.trim() === '') {
      errors.push('every cited URL must be a non-empty string');
      continue;
    }
    const href = parseOneUrl(item.trim(), errors);
    if (href && !out.includes(href)) out.push(href);
  }
  return errors.length ? { ok: false, errors } : { ok: true, urls: out };
}

/** Cited URLs on the site's own hostnames. Null when the cited URLs were not recorded. */
export function ownCitedUrls(citedUrls: readonly string[] | null, hosts: readonly string[]): string[] | null {
  if (citedUrls === null) return null;
  const own = new Set(hosts);
  return citedUrls.filter((u) => {
    try {
      return own.has(new URL(u).hostname.toLowerCase().replace(/\.$/, ''));
    } catch {
      return false;
    }
  });
}

export interface ObservationClassification {
  /** true / false, or null when no response text was recorded. */
  brandMentioned: boolean | null;
  /** Brand terms found in the response text (null when unknown). */
  matchedBrandTerms: string[] | null;
  /** true / false, or null when the cited URLs were not recorded. */
  ownSiteCited: boolean | null;
  /** Own-site URLs among the cited URLs (null when unknown). */
  ownCitedUrls: string[] | null;
}

/** Classify one observation against the site's brand terms and hostnames. */
export function classifyObservation(input: { responseText: string | null; citedUrls: string[] | null }, config: Pick<SiteConfig, 'site' | 'brand'>): ObservationClassification {
  const matched = brandMentionsIn(input.responseText, brandTerms(config));
  const own = ownCitedUrls(input.citedUrls, ownHostnames(config));
  return {
    brandMentioned: matched === null ? null : matched.length > 0,
    matchedBrandTerms: matched,
    ownSiteCited: own === null ? null : own.length > 0,
    ownCitedUrls: own,
  };
}
