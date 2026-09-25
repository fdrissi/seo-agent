import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { normalizedContentHash } from '../core/hash.js';
import { stripControlChars } from '../core/terminal.js';
import { isLoginUrl } from './fetch.js';
import { simhash64, SIMHASH_MIN_WORDS } from './similarity.js';
import { scanForInjection } from './untrusted.js';

/**
 * HTML extraction with cheerio. Parsing only: scripts are never executed and
 * JSON-LD is parsed with JSON.parse inside try/catch. Everything extracted is
 * DATA from an untrusted document. Extracted text (title, headings, anchors,
 * alt text, visible text, meta description) never keeps C0/C1 control
 * characters: an entity such as `&#x1b;` decodes to ESC, which would otherwise
 * be stored and later reach an operator's terminal as an escape sequence.
 */

export interface ExtractOptions {
  /** Final URL of the document (base for relative URLs). */
  url: string;
  /** Response headers, lower-case keys. */
  headers?: Record<string, string>;
  /** Hostnames treated as internal for link classification. */
  internalHosts: readonly string[];
  maxLinks?: number;
  maxImages?: number;
  maxTextChars?: number;
}

export interface RobotsDirectives {
  noindex: boolean;
  nofollow: boolean;
  nosnippet: boolean;
  noarchive: boolean;
  noimageindex: boolean;
  maxSnippet: number | null;
  unavailableAfter: string | null;
  /** Where each directive came from, e.g. "meta:robots", "meta:googlebot", "header", "header:googlebot". */
  sources: string[];
}

export interface ExtractedLink {
  href: string;
  anchorText: string;
  rel: string | null;
  nofollow: boolean;
  internal: boolean;
  context: string | null;
  inNavigation: boolean;
}

export interface ExtractedImage {
  src: string | null;
  alt: string | null;
  altStatus: 'present' | 'empty' | 'missing';
  /** Reasons the image may be decorative (so missing/empty alt may be fine). */
  decorativeHints: string[];
  inLink: boolean;
  linkHasText: boolean;
  width: string | null;
  height: string | null;
  context: string | null;
}

export interface StructuredDataBlock {
  index: number;
  valid: boolean;
  types: string[];
  error: string | null;
  bytes: number;
  /** Parsed value when small enough to store; never executed. */
  data: unknown;
  truncated: boolean;
}

export interface HreflangEntry {
  lang: string;
  href: string;
  source: 'html' | 'header';
}

export interface PageExtraction {
  title: string | null;
  titleCount: number;
  metaDescription: string | null;
  metaDescriptionCount: number;
  metaRobots: string | null;
  xRobotsTag: string | null;
  robots: RobotsDirectives;
  canonical: string | null;
  canonicals: string[];
  headerCanonicals: string[];
  hreflang: HreflangEntry[];
  headings: Array<{ level: number; text: string }>;
  h1Count: number;
  text: string;
  textTruncated: boolean;
  wordCount: number;
  language: string | null;
  languageSource: 'html_lang' | 'content_language_header' | null;
  links: ExtractedLink[];
  linksTruncated: boolean;
  internalLinkCount: number;
  externalLinkCount: number;
  images: ExtractedImage[];
  structuredData: StructuredDataBlock[];
  structuredDataTypes: string[];
  microdataTypes: string[];
  /** Any password input anywhere in the document (a hint only, never a barrier by itself). */
  loginForm: boolean;
  passwordInputs: number;
  /** Password inputs outside site chrome (header/nav/footer/aside/dialogs) and hidden containers. */
  contentPasswordInputs: number;
  loginFormInContent: boolean;
  metaRefresh: { delaySeconds: number; url: string | null } | null;
  scriptCount: number;
  /** Raw HTML looks like a client-rendered shell (little text, app root, many scripts). */
  jsShellSuspected: boolean;
  contentHash: string | null;
  simhash: string | null;
  injection: { suspected: boolean; matches: string[] };
}

const BLOCK_ELEMENTS = 'p,div,section,article,main,header,footer,aside,nav,li,ul,ol,dl,dt,dd,h1,h2,h3,h4,h5,h6,blockquote,pre,table,tr,td,th,figure,figcaption,address,form,fieldset,details,summary,hr';
const NOISE_ELEMENTS = 'script,style,noscript,template,svg,canvas,iframe,object,embed,head,[hidden],[aria-hidden="true"],nav,[role="navigation"],header,[role="banner"],footer,[role="contentinfo"],aside,[role="complementary"],dialog';
const NAV_CONTAINERS = 'nav,[role="navigation"],header,footer,[role="banner"],[role="contentinfo"]';
const SITE_CHROME = 'header,nav,footer,aside,dialog,[role="banner"],[role="navigation"],[role="contentinfo"],[role="complementary"],[role="dialog"],[hidden],[aria-hidden="true"],template,noscript';
const SKIP_SCHEMES = /^(javascript|mailto|tel|sms|data|blob|about|file|ftp|intent|whatsapp|skype):/i;
const MAX_JSONLD_STORE_BYTES = 20_000;

/** Collapse whitespace; C0/C1 control characters (ESC, BEL, CSI, ...) become spaces first. */
export function collapse(s: string): string {
  return stripControlChars(s).replace(/\s+/g, ' ').trim();
}

function absolutize(href: string, base: string): URL | null {
  try {
    const u = new URL(href.trim(), base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u;
  } catch {
    return null;
  }
}

/** Parse a robots directive string (meta content or X-Robots-Tag) into flags. */
export function parseRobotsDirectives(values: Array<{ value: string; source: string }>): RobotsDirectives {
  const out: RobotsDirectives = { noindex: false, nofollow: false, nosnippet: false, noarchive: false, noimageindex: false, maxSnippet: null, unavailableAfter: null, sources: [] };
  for (const { value, source } of values) {
    // X-Robots-Tag may scope rules to a crawler: "googlebot: noindex, nofollow".
    let scope = source;
    let rest = value;
    const scoped = /^\s*([a-z0-9_-]+)\s*:\s*(?!\s*\d)(.*)$/i.exec(value);
    if (scoped && !/^(max-snippet|max-image-preview|max-video-preview|unavailable_after)$/i.test(scoped[1]!)) {
      scope = `${source}:${scoped[1]!.toLowerCase()}`;
      rest = scoped[2]!;
    }
    const s = scope.toLowerCase();
    // Only generic rules and Google's crawler tokens are applied to the flags; other crawlers' rules are recorded only.
    const applies = !s.includes(':') || /:(googlebot|robots|googlebot-news)$/.test(s);
    for (const tokRaw of rest.split(',')) {
      const tok = tokRaw.trim().toLowerCase();
      if (!tok) continue;
      if (!applies) continue;
      if (tok === 'noindex' || tok === 'none') out.noindex = true;
      if (tok === 'nofollow' || tok === 'none') out.nofollow = true;
      if (tok === 'nosnippet') out.nosnippet = true;
      if (tok === 'noarchive') out.noarchive = true;
      if (tok === 'noimageindex') out.noimageindex = true;
      const ms = /^max-snippet\s*:\s*(-?\d+)$/.exec(tok);
      if (ms) {
        const n = Number(ms[1]);
        out.maxSnippet = out.maxSnippet === null ? n : n === -1 ? out.maxSnippet : out.maxSnippet === -1 ? n : Math.min(out.maxSnippet, n);
      }
      const ua = /^unavailable_after\s*:\s*(.+)$/.exec(tokRaw.trim());
      if (ua) out.unavailableAfter = ua[1]!.trim();
    }
    if (!out.sources.includes(scope)) out.sources.push(scope);
  }
  return out;
}

/** Parse an HTTP Link header into entries. */
export function parseLinkHeader(value: string | undefined | null): Array<{ url: string; rel: string[]; hreflang: string | null }> {
  if (!value) return [];
  const out: Array<{ url: string; rel: string[]; hreflang: string | null }> = [];
  const re = /<([^>]*)>\s*((?:;\s*[^;,]+(?:=(?:"[^"]*"|[^;,]*))?)*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    const params = m[2] ?? '';
    const rel = /;\s*rel\s*=\s*"?([^";,]+)"?/i.exec(params)?.[1]?.toLowerCase().split(/\s+/) ?? [];
    const hreflang = /;\s*hreflang\s*=\s*"?([^";,]+)"?/i.exec(params)?.[1] ?? null;
    out.push({ url: m[1]!.trim(), rel, hreflang });
  }
  return out;
}

function collectLdTypes(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 12 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 500)) collectLdTypes(v, into, depth + 1);
    return;
  }
  const obj = value as Record<string, unknown>;
  const t = obj['@type'];
  if (typeof t === 'string') into.add(t);
  else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') into.add(x);
  for (const [k, v] of Object.entries(obj)) if (k !== '@context' && typeof v === 'object') collectLdTypes(v, into, depth + 1);
}

/** Parse JSON-LD text safely: JSON.parse only, never evaluated. */
export function parseJsonLd(raw: string, index: number): StructuredDataBlock {
  const cleaned = raw
    .replace(/^\s*<!--/, '')
    .replace(/-->\s*$/, '')
    .replace(/^\s*\/\/\s*<!\[CDATA\[/, '')
    .replace(/\/\/\s*\]\]>\s*$/, '')
    .trim();
  const bytes = Buffer.byteLength(cleaned);
  try {
    const data: unknown = JSON.parse(cleaned);
    const types = new Set<string>();
    collectLdTypes(data, types);
    const small = bytes <= MAX_JSONLD_STORE_BYTES;
    return { index, valid: true, types: [...types], error: null, bytes, data: small ? data : null, truncated: !small };
  } catch (err) {
    return { index, valid: false, types: [], error: `Invalid JSON-LD: ${(err as Error).message.slice(0, 200)}`, bytes, data: null, truncated: false };
  }
}

export function countWords(text: string): number {
  if (!text) return 0;
  let n = 0;
  const seg = new Intl.Segmenter(undefined, { granularity: 'word' });
  for (const s of seg.segment(text)) if (s.isWordLike) n++;
  return n;
}

function contextSnippet($: CheerioAPI, el: Element, anchor: string, max = 200): string | null {
  const block = $(el).closest('p,li,td,th,dd,blockquote,figcaption,h1,h2,h3,h4,h5,h6');
  const text = collapse((block.length ? block : $(el).parent()).text());
  if (!text) return null;
  if (text.length <= max) return text;
  const i = anchor ? text.indexOf(anchor) : -1;
  if (i < 0) return `${text.slice(0, max)}...`;
  const start = Math.max(0, i - Math.floor((max - anchor.length) / 2));
  return `${start > 0 ? '...' : ''}${text.slice(start, start + max)}${start + max < text.length ? '...' : ''}`;
}

function metaContent($: CheerioAPI, names: string[]): Array<{ name: string; content: string }> {
  const out: Array<{ name: string; content: string }> = [];
  $('meta').each((_, el) => {
    const name = ($(el).attr('name') ?? '').trim().toLowerCase();
    if (names.includes(name)) out.push({ name, content: ($(el).attr('content') ?? '').trim() });
  });
  return out;
}

export function extractPage(html: string, opts: ExtractOptions): PageExtraction {
  const $ = cheerio.load(html);
  const headers = opts.headers ?? {};
  const internalHosts = new Set(opts.internalHosts.map((h) => h.toLowerCase()));
  const maxLinks = opts.maxLinks ?? 5_000;
  const maxImages = opts.maxImages ?? 500;
  const maxTextChars = opts.maxTextChars ?? 500_000;

  // Base URL (<base href>) only when it is a valid http(s) URL.
  let base = opts.url;
  const baseHref = $('base[href]').first().attr('href');
  if (baseHref) {
    const b = absolutize(baseHref, opts.url);
    if (b) base = b.toString();
  }

  // Title and meta.
  const titles = $('title');
  const titleText = titles.length ? collapse(titles.first().text()) : null;
  const descs = metaContent($, ['description']);
  const robotsMetas = metaContent($, ['robots', 'googlebot', 'googlebot-news']);
  const xRobots = headers['x-robots-tag'] ?? null;
  const robots = parseRobotsDirectives([
    ...robotsMetas.map((m) => ({ value: m.content, source: `meta:${m.name}` })),
    ...(xRobots ? xRobots.split(/,(?=\s*[a-z0-9_-]+\s*:\s*(?!\s*\d))/i).map((v) => ({ value: v, source: 'header' })) : []),
  ]);

  // Canonicals and hreflang (HTML + Link header).
  const canonicals: string[] = [];
  const hreflang: HreflangEntry[] = [];
  $('link[rel]').each((_, el) => {
    const rels = ($(el).attr('rel') ?? '').toLowerCase().split(/\s+/);
    const href = $(el).attr('href');
    if (!href) return;
    const abs = absolutize(href, base);
    if (rels.includes('canonical') && abs) canonicals.push(abs.toString());
    const hl = $(el).attr('hreflang');
    if (rels.includes('alternate') && hl && abs) hreflang.push({ lang: hl.trim(), href: abs.toString(), source: 'html' });
  });
  const headerCanonicals: string[] = [];
  for (const l of parseLinkHeader(headers['link'])) {
    const abs = absolutize(l.url, opts.url);
    if (!abs) continue;
    if (l.rel.includes('canonical')) headerCanonicals.push(abs.toString());
    if (l.rel.includes('alternate') && l.hreflang) hreflang.push({ lang: l.hreflang, href: abs.toString(), source: 'header' });
  }

  // Headings.
  const headings: Array<{ level: number; text: string }> = [];
  $('h1,h2,h3,h4,h5,h6').each((_, el) => {
    const level = Number((el as Element).tagName.slice(1));
    const text = collapse($(el).text());
    if (headings.length < 500) headings.push({ level, text });
  });

  // Links (before noise removal, so navigation links are included and flagged).
  const links: ExtractedLink[] = [];
  let linksTruncated = false;
  let internalLinkCount = 0;
  let externalLinkCount = 0;
  $('a[href], area[href]').each((_, node) => {
    const el = node as Element;
    const raw = ($(el).attr('href') ?? '').trim();
    if (!raw || raw.startsWith('#') || SKIP_SCHEMES.test(raw)) return;
    const abs = absolutize(raw, base);
    if (!abs) return;
    const internal = internalHosts.has(abs.hostname.toLowerCase());
    if (internal) internalLinkCount++;
    else externalLinkCount++;
    if (links.length >= maxLinks) {
      linksTruncated = true;
      return;
    }
    let anchor = collapse($(el).text());
    if (!anchor) anchor = collapse($(el).find('img[alt]').first().attr('alt') ?? '');
    if (!anchor) anchor = collapse($(el).attr('aria-label') ?? $(el).attr('title') ?? '');
    const rel = $(el).attr('rel')?.trim() || null;
    links.push({
      href: abs.toString(),
      anchorText: anchor.slice(0, 300),
      rel,
      nofollow: !!rel && /\b(nofollow|ugc|sponsored)\b/i.test(rel),
      internal,
      context: contextSnippet($, el, anchor),
      inNavigation: $(el).closest(NAV_CONTAINERS).length > 0,
    });
  });

  // Images and alt text (missing vs empty distinguished; decorative context recorded).
  const images: ExtractedImage[] = [];
  $('img').each((_, node) => {
    if (images.length >= maxImages) return;
    const el = node as Element;
    const $el = $(el);
    const srcRaw = $el.attr('src') ?? $el.attr('data-src') ?? $el.attr('srcset')?.split(',')[0]?.trim().split(/\s+/)[0];
    const src = srcRaw ? (absolutize(srcRaw, base)?.toString() ?? (srcRaw.startsWith('data:') ? 'data:(inline)' : null)) : null;
    const rawAlt = $el.attr('alt');
    const altAttr = rawAlt === undefined ? undefined : stripControlChars(rawAlt);
    const altStatus: ExtractedImage['altStatus'] = altAttr === undefined ? 'missing' : altAttr.trim() === '' ? 'empty' : 'present';
    const hints: string[] = [];
    const role = ($el.attr('role') ?? '').toLowerCase();
    if (role === 'presentation' || role === 'none') hints.push(`role="${role}"`);
    if (($el.attr('aria-hidden') ?? '').toLowerCase() === 'true') hints.push('aria-hidden="true"');
    if (altStatus === 'empty') hints.push('alt="" marks the image as decorative');
    const w = $el.attr('width') ?? null;
    const h = $el.attr('height') ?? null;
    if ((w !== null && Number(w) <= 2) || (h !== null && Number(h) <= 2)) hints.push('tiny dimensions (spacer or tracking pixel)');
    if (src && /(spacer|pixel|blank|transparent|divider)\.(gif|png|svg|webp)/i.test(src)) hints.push('file name suggests a spacer/divider');
    const link = $el.closest('a');
    const inLink = link.length > 0;
    const linkHasText = inLink && collapse(link.text()).length > 0;
    if (linkHasText) hints.push('inside a link that already has text');
    const figcaption = collapse($el.closest('figure').find('figcaption').first().text());
    if (figcaption) hints.push('figure has a caption');
    images.push({
      src,
      alt: altAttr === undefined ? null : altAttr,
      altStatus,
      decorativeHints: hints,
      inLink,
      linkHasText,
      width: w,
      height: h,
      context: figcaption || contextSnippet($, el, '', 120),
    });
  });

  // Structured data: JSON-LD parsed (never executed) + microdata/RDFa type hints.
  const structuredData: StructuredDataBlock[] = [];
  $('script').each((_, node) => {
    const type = ($(node).attr('type') ?? '').toLowerCase().split(';')[0]!.trim();
    if (type !== 'application/ld+json') return;
    if (structuredData.length >= 50) return;
    structuredData.push(parseJsonLd($(node).text(), structuredData.length));
  });
  const sdTypes = new Set<string>();
  for (const b of structuredData) for (const t of b.types) sdTypes.add(t);
  const microdataTypes = new Set<string>();
  $('[itemtype]').each((_, el) => {
    for (const t of ($(el).attr('itemtype') ?? '').split(/\s+/)) if (t) microdataTypes.add(t);
  });
  $('[typeof]').each((_, el) => {
    for (const t of ($(el).attr('typeof') ?? '').split(/\s+/)) if (t) microdataTypes.add(t);
  });

  // Login forms. `loginForm` is any password input (a hint only); `loginFormInContent` counts only
  // password inputs outside site chrome (header/nav/footer/aside/dialogs) and hidden containers,
  // so a site-wide sign-in widget does not make a public page look like a login wall.
  const passwords = $('input[type="password" i]');
  const passwordInputs = passwords.length;
  const loginForm = passwordInputs > 0;
  const contentPasswordInputs = passwords.filter((_, el) => {
    const $el = $(el);
    if ($el.closest(SITE_CHROME).length > 0) return false;
    return $el.parents().filter((_, p) => /display\s*:\s*none|visibility\s*:\s*hidden/i.test($(p).attr('style') ?? '')).length === 0;
  }).length;

  // Meta refresh.
  let metaRefresh: PageExtraction['metaRefresh'] = null;
  $('meta[http-equiv]').each((_, el) => {
    if (metaRefresh || ($(el).attr('http-equiv') ?? '').toLowerCase() !== 'refresh') return;
    const content = $(el).attr('content') ?? '';
    const m = /^\s*(\d+)\s*(?:[;,]\s*url\s*=\s*['"]?([^'"]+)['"]?)?/i.exec(content);
    if (m) metaRefresh = { delaySeconds: Number(m[1]), url: m[2] ? (absolutize(m[2], base)?.toString() ?? null) : null };
  });
  const scriptCount = $('script').length;

  // Language.
  const htmlLang = ($('html').attr('lang') ?? '').trim();
  const contentLanguage = (headers['content-language'] ?? '').split(',')[0]?.trim() ?? '';
  const language = htmlLang || contentLanguage || null;
  const languageSource = htmlLang ? 'html_lang' : contentLanguage ? 'content_language_header' : null;

  // Visible text: remove non-content and navigation noise, keep block separation.
  const $body = $('body'); // cheerio always creates <body> for documents
  $body.find(NOISE_ELEMENTS).remove();
  $body.find('[style]').each((_, el) => {
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test($(el).attr('style') ?? '')) $(el).remove();
  });
  $body.find('br').replaceWith('\n');
  $body.find(BLOCK_ELEMENTS).each((_, el) => {
    $(el).append('\n');
  });
  let text = $body
    .text()
    .split('\n')
    .map((l) => collapse(l))
    .filter(Boolean)
    .join('\n');
  const textTruncated = text.length > maxTextChars;
  if (textTruncated) text = text.slice(0, maxTextChars);
  const wordCount = countWords(text);
  const appRoot = $('#root, #app, #__next, #__nuxt, [data-reactroot], app-root').length > 0;
  const jsShellSuspected = wordCount < 50 && (appRoot || scriptCount >= 5);

  return {
    title: titleText,
    titleCount: titles.length,
    metaDescription: descs[0] ? stripControlChars(descs[0].content).trim() : null,
    metaDescriptionCount: descs.length,
    metaRobots: robotsMetas.length ? robotsMetas.map((m) => (m.name === 'robots' ? m.content : `${m.name}: ${m.content}`)).join(', ') : null,
    xRobotsTag: xRobots,
    robots,
    canonical: canonicals[0] ?? headerCanonicals[0] ?? null,
    canonicals,
    headerCanonicals,
    hreflang,
    headings,
    h1Count: headings.filter((h) => h.level === 1).length,
    text,
    textTruncated,
    wordCount,
    language,
    languageSource,
    links,
    linksTruncated,
    internalLinkCount,
    externalLinkCount,
    images,
    structuredData,
    structuredDataTypes: [...sdTypes],
    microdataTypes: [...microdataTypes],
    loginForm,
    passwordInputs,
    contentPasswordInputs,
    loginFormInContent: contentPasswordInputs > 0,
    metaRefresh,
    scriptCount,
    jsShellSuspected,
    contentHash: text ? normalizedContentHash(text) : null,
    simhash: wordCount >= SIMHASH_MIN_WORDS ? simhash64(text) : null,
    injection: scanForInjection(text),
  };
}

/** Main-content word count below which a sign-in page counts as a wall rather than content. */
export const LOGIN_WALL_MAX_WORDS = 250;
const LOGINISH = /(?:\b(?:log ?in|sign ?in|logon|anmelden|connexion|accedi|inloggen|logga in|kirjaudu|sisene|password)\b|iniciar sesi)/i;

export interface LoginBarrierAssessment {
  /** True only when every signal agrees (see loginBarrierAssessment). */
  barrier: boolean;
  /** Signals that were present, e.g. "password form in main content", "sign-in title". */
  signals: string[];
  /** Human-readable note when a password form was seen but the page is NOT treated as a barrier. */
  hint: string | null;
}

/**
 * Heuristic login-wall detection for a page that returned 2xx HTML. A page is
 * a barrier only when ALL of these hold:
 * - a password input in the main content (not in header/nav/footer/aside,
 *   dialogs, or hidden containers - a site-wide sign-in widget does not count);
 * - a sign-in signal: a login-like URL path/host, title, or H1/H2;
 * - little other content (main-content word count < LOGIN_WALL_MAX_WORDS).
 * Anything else is recorded as a hint only. This is a heuristic: callers must
 * not report it as a verified access failure.
 */
export function loginBarrierAssessment(x: PageExtraction, url: URL): LoginBarrierAssessment {
  const signals: string[] = [];
  if (!x.loginForm) return { barrier: false, signals, hint: null };
  if (x.loginFormInContent) signals.push('password form in main content');
  const urlSignal = isLoginUrl(url);
  const titleSignal = LOGINISH.test(x.title ?? '');
  const headingSignal = x.headings.some((h) => h.level <= 2 && LOGINISH.test(h.text));
  if (urlSignal) signals.push('login-like URL');
  if (titleSignal) signals.push('sign-in title');
  if (headingSignal) signals.push('sign-in heading');
  const little = x.wordCount < LOGIN_WALL_MAX_WORDS;
  if (little) signals.push(`${x.wordCount} words of main content`);
  const barrier = x.loginFormInContent && (urlSignal || titleSignal || headingSignal) && little;
  if (barrier) return { barrier, signals, hint: null };
  const why = !x.loginFormInContent
    ? 'only in site chrome (header/nav/footer/aside/dialog) or hidden'
    : !(urlSignal || titleSignal || headingSignal)
      ? 'without a sign-in URL, title, or heading'
      : `with ${x.wordCount} words of other content`;
  return { barrier: false, signals, hint: `Password input seen ${why}; not treated as a login barrier.` };
}

/** Heuristic login-barrier check (see loginBarrierAssessment). */
export function isLoginBarrier(x: PageExtraction, url: URL): boolean {
  return loginBarrierAssessment(x, url).barrier;
}

export type { AnyNode };
