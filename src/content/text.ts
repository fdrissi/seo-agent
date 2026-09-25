import { sha256 } from '../core/hash.js';

/**
 * Deterministic text utilities for the content pipeline: normalization,
 * hashing, tokenization, lexical similarity, n-gram overlap, number
 * extraction, and instruction-like text detection.
 *
 * Tokenization is Unicode-aware (letters and digits of any script). Stopword
 * removal and suffix stripping are English defaults; for other languages they
 * degrade gracefully (fewer stopwords removed), which is documented as a
 * limitation in docs/modules/content.md.
 */

/** Lowercase, NFKC, strip punctuation, collapse whitespace. Used for exact dedup. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/'/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizedTextHash(text: string): string {
  return sha256(normalizeText(text));
}

const STOPWORDS = new Set(
  (
    'a an the and or but if then else of to in on at by for with from as is are was were be been being do does did doing have has had having ' +
    'i me my we our ours us you your yours he she it its they them their this that these those there here what which who whom whose ' +
    'how why when where can could should would will shall may might must not no nor so than too very just also about into over under ' +
    'again further once all any both each few more most other some such only own same s t don dont im ive youre its get got use using ' +
    'vs versus per via up down out off am'
  ).split(/\s+/),
);

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token);
}

/** All word tokens (lowercased, Unicode letters/digits). */
export function words(text: string): string[] {
  return (text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? []).map((w) => w.replace(/'/g, ''));
}

/**
 * Light suffix stripping (English): plural/verb suffixes, doubled final
 * consonants, and a final "e", so plan/planning/plans and
 * schedule/scheduling/schedules share a stem. Other languages pass through
 * mostly unchanged (documented limitation).
 */
export function stem(token: string): string {
  if (token.length <= 3 || /\d/.test(token)) return token;
  let t = token;
  for (const suf of ['ing', 'edly', 'ed', 'ies', 'es', 'ly', 's']) {
    if (t.endsWith(suf) && t.length - suf.length >= 3 && !(suf === 's' && t.endsWith('ss'))) {
      const base = t.slice(0, -suf.length);
      t = suf === 'ies' ? `${base}y` : base;
      break;
    }
  }
  if (t.length >= 4 && /([b-df-hj-np-tv-z])\1$/.test(t) && !/(ll|ss|zz)$/.test(t)) t = t.slice(0, -1);
  if (t.length >= 4 && t.endsWith('e')) t = t.slice(0, -1);
  return t;
}

/** Content tokens: stopwords removed, stemmed. */
export function contentTokens(text: string): string[] {
  return words(text)
    .filter((w) => !isStopword(w) && w.length > 1)
    .map(stem);
}

export function tokenSet(text: string): Set<string> {
  return new Set(contentTokens(text));
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** |a ∩ b| / |a| : how much of `a` is contained in `b`. */
export function containment<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / a.size;
}

/** Word n-gram shingles over raw (non-stemmed) words. */
export function shingles(text: string, n: number): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  if (w.length < n) {
    if (w.length > 0 && n > 1 && w.length === n - 1) return out;
    return out;
  }
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}

/** Content-token bigrams for lexical similarity of short texts (queries/questions). */
export function tokenBigrams(text: string): Set<string> {
  const t = contentTokens(text);
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) out.add(`${t[i]} ${t[i + 1]}`);
  return out;
}

/**
 * Lexical similarity for short texts: weighted token Jaccard plus bigram
 * overlap. Returns [0, 1].
 */
export function lexicalSimilarity(a: string, b: string): number {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  const j = jaccard(ta, tb);
  const ba = tokenBigrams(a);
  const bb = tokenBigrams(b);
  const bj = ba.size && bb.size ? jaccard(ba, bb) : j;
  return Math.min(1, 0.75 * j + 0.25 * bj);
}

export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Split into sentences (keeps markdown headings/list items as separate units). */
export function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"'(\[])/u))
    .map((s) => s.replace(/^\s*(?:[#>*-]+|\d+[.)])\s*/, '').trim())
    .filter((s) => s.length > 0);
}

export function isQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t.endsWith('?') || /^(how|what|why|when|where|who|which|can|could|should|is|are|does|do|will|would)\b/.test(t);
}

export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function countWords(text: string): number {
  return words(text).length;
}

// ---------------------------------------------------------------------------
// Numbers and statistics
// ---------------------------------------------------------------------------

export interface NumberMention {
  raw: string;
  value: number;
  kind: 'percent' | 'currency' | 'quantity' | 'decimal' | 'large' | 'year';
  /** Normalized unit: '%' for percents, the currency symbol/code, a stemmed unit word for quantities; null when unitless. */
  unit: string | null;
  index: number;
}

const UNIT_WORDS =
  'x|times|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|users?|customers?|clients?|people|companies|businesses|downloads|visitors|sessions|seconds?|ms|kg|g|km|m|cm|mm|mb|gb|tb|lbs?|inch(?:es)?|in|ft|feet|miles?|steps?|reviews?|stars?|installs?|countries|languages|integrations|teams?|employees|members|percent|pct';

const UNIT_ALIASES: Record<string, string> = { hrs: 'hour', hr: 'hour', mins: 'minut', min: 'minut', secs: 'second', sec: 'second', lbs: 'lb', feet: 'ft', inches: 'inch', times: 'x', percent: '%', pct: '%' };

function normalizeUnit(raw: string): string {
  const u = raw.trim().toLowerCase();
  if (UNIT_ALIASES[u]) return UNIT_ALIASES[u]!;
  if (/^[$€£¥]$/.test(u)) return u;
  if (/^(usd|dollars?)$/.test(u)) return '$';
  if (/^(eur|euros?)$/.test(u)) return '€';
  if (/^(gbp|pounds?)$/.test(u)) return '£';
  return stem(u);
}

/**
 * Extract statistic-like numbers: percentages, currency amounts, quantities
 * with units, decimals, numbers >= 13, and years. Small standalone integers
 * (list counts, "3 steps") are ignored unless they carry a unit/percent/currency.
 */
export function extractNumbers(text: string): NumberMention[] {
  const out: NumberMention[] = [];
  const seen = new Set<number>();
  const push = (m: RegExpExecArray, kind: NumberMention['kind'], numStr: string, unit: string | null) => {
    if (seen.has(m.index)) return;
    const value = parseNumber(numStr);
    if (value === null) return;
    seen.add(m.index);
    out.push({ raw: m[0].trim(), value, kind, unit, index: m.index });
  };
  const NUM = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?';
  // [regex, kind, number group, unit group (or a fixed unit)]
  const patterns: Array<[RegExp, NumberMention['kind'], number, number | string | null]> = [
    [new RegExp(`([$€£¥]|USD|EUR|GBP)\\s?(${NUM})(?:\\s?(?:k|m|bn|million|billion))?`, 'gi'), 'currency', 2, 1],
    [new RegExp(`\\b(${NUM})\\s?(USD|EUR|GBP|dollars?|euros?|pounds?)\\b`, 'gi'), 'currency', 1, 2],
    [/\b(\d+(?:[.,]\d+)?)\s?(?:%|percent\b)/gi, 'percent', 1, '%'],
    [new RegExp(`\\b(${NUM})\\s?(${UNIT_WORDS})\\b`, 'gi'), 'quantity', 1, 2],
    [/\b(\d+\.\d+)\b/g, 'decimal', 1, null],
    [/\b((?:19|20)\d{2})\b/g, 'year', 1, null],
    [/\b(\d{1,3}(?:,\d{3})+|\d{2,})\b/g, 'large', 1, null],
  ];
  for (const [re, kind, group, unitSpec] of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const numStr = m[group] ?? m[0];
      const inside = () => out.some((o) => m!.index >= o.index && m!.index < o.index + o.raw.length);
      if (kind === 'large') {
        const v = parseNumber(numStr);
        if (v === null || v < 13) continue;
        // Skip if this digit run is inside an already-captured mention.
        if (inside()) continue;
        if (/^(?:19|20)\d{2}$/.test(numStr)) continue;
      }
      if ((kind === 'decimal' || kind === 'year') && inside()) continue;
      const unit = typeof unitSpec === 'number' ? normalizeUnit(m[unitSpec] ?? '') || null : unitSpec;
      push(m, kind, numStr, unit);
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

export function parseNumber(s: string): number | null {
  const cleaned = s.replace(/,(?=\d{3}\b)/g, '').replace(/,/g, '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const ISO_DATE_RANGE_RE = /\b((?:19|20)\d{2})-\d{2}-\d{2}(?:T[\d:.]+Z?)?\s*(?:\.\.|–|—|\bto\b|-)\s*(?:19|20)\d{2}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/gi;
const ISO_DATE_RE = /\b((?:19|20)\d{2})-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?\b/g;
const DMY_DATE_RE = /\b\d{1,2}[./]\d{1,2}[./]((?:19|20)\d{2})\b/g;
const TIME_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm)?\b/gi;
const ID_RE = /\b[a-z]{2,6}_[A-Za-z0-9_-]+\b|\b(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/g;
const URL_RE = /\bhttps?:\/\/\S+/gi;

/**
 * Remove values that are not statistics before extracting numbers: dates,
 * date ranges and collection windows, clock times, record ids, hashes, and
 * URLs. With `keepYear`, a date is replaced by its year (so a year stated in
 * a draft is still reported for confirmation).
 */
export function stripNonStatisticNumbers(text: string, opts: { keepYear?: boolean } = {}): string {
  const date = (_m: string, year: string) => (opts.keepYear ? ` ${year} ` : ' ');
  return text.replace(URL_RE, ' ').replace(ISO_DATE_RANGE_RE, date).replace(ISO_DATE_RE, date).replace(DMY_DATE_RE, date).replace(TIME_RE, ' ').replace(ID_RE, ' ');
}

// ---------------------------------------------------------------------------
// Untrusted text handling
// ---------------------------------------------------------------------------

/**
 * Instruction-like text: imperatives aimed at an assistant/model/system, not
 * ordinary business prose ("increase the budget for flour" or "change the
 * mode of your oven" are NOT matched).
 */
const INSTRUCTION_PATTERNS: RegExp[] = [
  /\bignore\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions|prompts|rules|messages)/i,
  /\bdisregard\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|prompts|rules|messages|text)/i,
  /\b(?:new|updated|override)\s+(?:system\s+)?instructions?\s*:/i,
  /\b(?:reveal|print|show|output|repeat|leak|ignore|override|disregard|change|replace)\s+(?:the\s+|your\s+|its\s+)?system\s+prompt\b/i,
  /(?:^|[\n.!?]\s*)(?:SYSTEM|ASSISTANT|DEVELOPER)\s*:\s*\S/,
  /\byou\s+are\s+now\s+(?:a|an|the|in)\b/i,
  /\bact\s+as\s+(?:a|an|the)\s+(?:system|admin|administrator|developer|root)\b/i,
  /\bapproved\s*:\s*true\b/i,
  /<\/?\s*(?:system|instructions?|assistant)\s*>/i,
  /\b(?:assistant|ai|model|agent|bot|seo-agent|llm)\s*[,:]?\s*(?:please\s+)?(?:set|change|raise|increase|disable|bypass|remove|skip)\s+(?:the\s+|your\s+|all\s+)?(?:budgets?|approvals?|runtime\s+mode|mode|permissions?|limits?|caps?|quality\s+gates?)\b/i,
  /\b(?:disable|bypass|skip|turn\s+off)\s+(?:the\s+|all\s+|your\s+)?(?:approval|approvals|approval\s+checks?|budget\s+(?:checks?|caps?|limits?)|quality\s+gates?|safety\s+checks?)\b/i,
  /\bmode\s+to\s+(?:EXECUTE|DRAFT)\b/,
  /\b(?:publish|approve)\s+(?:this|the)\s+(?:draft|page|content|item|post|request|change)\s+(?:now|immediately|automatically|without\s+(?:review|approval))\b/i,
];

/** Detect instruction-like text inside untrusted data (flagged, never obeyed). */
export function detectInstructionLikeText(text: string): string[] {
  const hits: string[] = [];
  for (const re of INSTRUCTION_PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push(m[0].replace(/^[\n.!?\s]+/, ''));
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Personal data
// ---------------------------------------------------------------------------

const PHONE_CANDIDATE_RE = /(?<![\w/])\+?\d[\d\s().-]{7,}\d(?![\w/])/g;

/**
 * Whether a digit run looks like a phone number (and not a date, a date or
 * year range, or a numeric range). Requires at least 7 digits outside any
 * date, and a leading "+" / country code, phone-like grouping, or 9-15 bare
 * digits.
 */
export function looksLikePhone(candidate: string): boolean {
  const m = candidate.trim();
  const withoutDates = m
    .replace(/\b(?:19|20)\d{2}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\b/g, ' ')
    .replace(/\b\d{1,2}[.-]\d{1,2}[.-](?:19|20)\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ');
  const digits = withoutDates.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return false;
  // Numeric or year ranges such as "1000-2000" or "2019-2026".
  const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(m);
  if (range && range[1]!.length === range[2]!.length && !range[1]!.startsWith('0') && Number(range[2]) > Number(range[1])) return false;
  // Thousands grouping ("1 000 000", "1.250.000") is a number, not a phone.
  if (/^[1-9]\d{0,2}(?:[ .]\d{3})+$/.test(m)) return false;
  if (m.startsWith('+') || m.startsWith('00')) return true;
  if (/[\s().-]/.test(withoutDates.trim())) return /\d{2,}[\s().-]+\d{2,}/.test(withoutDates);
  return digits.length >= 9;
}

/** Phone-number-like spans in text (dates and ranges excluded). */
export function findPhoneNumbers(text: string): string[] {
  return [...text.matchAll(PHONE_CANDIDATE_RE)].map((m) => m[0]).filter(looksLikePhone);
}

/** Replace phone-number-like spans; returns the text and the number of replacements. */
export function redactPhoneNumbers(text: string, replacement = '[phone removed]'): { text: string; count: number } {
  let count = 0;
  const out = text.replace(PHONE_CANDIDATE_RE, (m) => {
    if (!looksLikePhone(m)) return m;
    count++;
    return replacement;
  });
  return { text: out, count };
}

/** Extract `[[UNVERIFIED: ...]]` markers. */
export function unverifiedMarkers(text: string): string[] {
  return [...text.matchAll(/\[\[UNVERIFIED:\s*([^\]]*?)\s*\]\]/g)].map((m) => m[1]!.trim());
}

export function stripUnverifiedMarkers(text: string): string {
  return text.replace(/\[\[UNVERIFIED:[^\]]*\]\]/g, ' ');
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
