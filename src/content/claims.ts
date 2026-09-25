import type { SiteConfig } from '../config/site-schema.js';
import { containment, contentTokens, escapeRegExp, extractNumbers, isQuestion, normalizeText, sentences, stripNonStatisticNumbers, stripUnverifiedMarkers, type NumberMention } from './text.js';

/**
 * Claim-level checks shared by the brief gate and draft quality gates.
 * Everything here is deterministic and explainable; these checks reduce but
 * cannot eliminate fabricated content, so human review stays mandatory.
 */

/** Verbatim-text corpus (quotation checks only; numbers use NumberSupport). */
export interface SupportCorpus {
  texts: string[];
  normalized: string;
}

export function buildCorpus(texts: string[]): SupportCorpus {
  const all = texts.filter(Boolean);
  return { texts: all, normalized: normalizeText(all.join('\n')) };
}

/** Owner-approved statements: product facts, approved claims, differentiators, offer, conversion meanings. */
export function ownerStatements(config: SiteConfig): Array<{ id: string; text: string }> {
  return [
    ...config.business.productFacts.map((f) => ({ id: `fact:${f.id}`, text: f.statement })),
    ...config.business.approvedClaims.map((c, i) => ({ id: `claim:${i + 1}`, text: c })),
    ...config.business.differentiators.map((d, i) => ({ id: `differentiator:${i + 1}`, text: d })),
    ...(config.business.offer ? [{ id: 'offer', text: config.business.offer }] : []),
    ...config.conversions.primaryEvents.map((e) => ({ id: `conversion:${e.name}`, text: e.meaning })),
  ];
}

// ---------------------------------------------------------------------------
// Numbers: claim-level support
// ---------------------------------------------------------------------------

/**
 * A numeric fact that may support a statistic: its value, kind, unit, the
 * source it came from, and the content words of the sentence it appears in.
 */
export interface SupportedNumber {
  value: number;
  kind: NumberMention['kind'];
  unit: string | null;
  sourceId: string;
  context: Set<string>;
}

export interface NumberSupport {
  numbers: SupportedNumber[];
  sourceIds: string[];
}

const contextTokens = (text: string) => new Set(contentTokens(text).filter((t) => !/^\d+$/.test(t)));

/**
 * Build claim-level number support from TRUSTED sources only (the caller
 * decides which sources qualify). Dates, collection windows, times, ids,
 * hashes, and URLs are removed first, so a window such as
 * "2026-08-24..2026-09-20" never supports "24%" or "20 minutes".
 */
export function buildNumberSupport(sources: Array<{ id: string; text: string }>): NumberSupport {
  const numbers: SupportedNumber[] = [];
  for (const src of sources) {
    if (!src.text) continue;
    for (const sentence of sentences(stripNonStatisticNumbers(src.text))) {
      const context = contextTokens(sentence);
      for (const m of extractNumbers(sentence)) numbers.push({ value: m.value, kind: m.kind, unit: m.unit, sourceId: src.id, context });
    }
  }
  return { numbers, sourceIds: sources.map((s) => s.id) };
}

function kindCompatible(m: NumberMention, s: SupportedNumber): boolean {
  switch (m.kind) {
    case 'percent':
      return s.kind === 'percent';
    case 'currency':
      return s.kind === 'currency' && (m.unit === null || s.unit === null || m.unit === s.unit);
    case 'quantity':
      return (s.kind === 'quantity' && s.unit === m.unit) || ((s.kind === 'large' || s.kind === 'decimal') && !!m.unit && s.context.has(m.unit));
    case 'year':
      return s.kind === 'year';
    default:
      return s.kind === 'large' || s.kind === 'decimal' || s.kind === 'quantity';
  }
}

/** The support entry backing a mention (same value, compatible kind/unit, overlapping claim context), if any. */
export function numberSupportFor(m: NumberMention, mentionContext: Set<string>, support: NumberSupport): SupportedNumber | null {
  for (const s of support.numbers) {
    if (s.value !== m.value || !kindCompatible(m, s)) continue;
    if (m.kind === 'year') return s;
    for (const t of mentionContext) if (s.context.has(t)) return s;
  }
  return null;
}

/**
 * Statistic-like numbers in `text` that no trusted source supports at claim
 * level. A question that restates a known customer/search question (e.g. an
 * outline heading quoting a discovered question) is not a claim; any other
 * sentence, including an invented question such as "Why do 73% of X fail?",
 * is checked. Visibly marked [[UNVERIFIED: ...]] statements are excluded
 * (they block publication separately).
 */
/** A sentence that explicitly calls its number an estimate (third-party volume estimates may support it). */
export const ESTIMATE_RE = /\b(?:estimat\w*|geschätzt\w*|schätzung\w*)/i;

export function unsupportedNumbers(text: string, support: NumberSupport, opts: { knownQuestions?: string[]; estimateSupport?: NumberSupport } = {}): NumberMention[] {
  const known = (opts.knownQuestions ?? []).map((q) => normalizeText(q)).filter((q) => q.length >= 8);
  const isKnownQuestion = (sentence: string) => {
    if (!sentence.trim().endsWith('?') || !known.length) return false;
    const n = normalizeText(sentence);
    return known.some((q) => n === q || n.includes(q) || (q.includes(n) && n.length >= 8));
  };
  const clean = stripNonStatisticNumbers(
    stripUnverifiedMarkers(text)
      // ordered-list prefixes and "Step 3" style labels are structure, not statistics
      .replace(/^\s*\d+[.)]\s+/gm, '')
      .replace(/\bstep\s+\d+\b/gi, 'step'),
    { keepYear: true },
  );
  const out: NumberMention[] = [];
  for (const sentence of sentences(clean)) {
    if (isKnownQuestion(sentence)) continue;
    // Third-party estimates support a number only when the sentence itself calls it an estimate.
    const estimates = opts.estimateSupport && ESTIMATE_RE.test(sentence) ? opts.estimateSupport : null;
    for (const m of extractNumbers(sentence)) {
      const window = sentence.slice(Math.max(0, m.index - 80), m.index + m.raw.length + 80);
      const ctxTokens = contextTokens(window);
      if (numberSupportFor(m, ctxTokens, support)) continue;
      if (estimates && numberSupportFor(m, ctxTokens, estimates)) continue;
      out.push(m);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Product / business claims
// ---------------------------------------------------------------------------

/** Case-sensitive so "US" (the country) is not mistaken for "us". */
const FIRST_PARTY_RE = /\b(?:[Ww]e|[Ww]e're|[Ww]e've|[Oo]ur|[Oo]urs|us)\b/;
const CLAIM_VERB_RE =
  /\b(offers|offered|offering|(?<!\b(?:the|an|our|this|that|your|its|special|current|configured)\s+(?:[\w-]+\s+)?)offer|provides?|supports?|includes?|integrat\w*|guarantee\w*|deliver\w*|ships?|costs?|pric\w*|free|availab\w*|works? with|compatible|features?|allows?|lets? you|enables?|exports?|imports?|syncs?|automat\w*|certifi\w*|award\w*|trusted by|used by|rated|refunds?|warrant\w*|saves?|reduces?|increases?|forecasts?|predicts?|faster|cheaper|better than|only|first|leading|#1|number one|unlimited|secure|compliant|encrypt\w*|runs? on|comes? with|connects? to)\b/i;

/** Generic product nouns that refer to the owner's offering when used with a determiner ("the app", "this tool"). */
const GENERIC_PRODUCT_NOUNS = ['app', 'application', 'tool', 'product', 'service', 'software', 'platform', 'plugin', 'extension', 'solution', 'subscription'];
const SUBJECT_STOP = /^(?:is|are|was|were|has|have|can|will|lets?|helps?|that|which|who|for|to|with|and|or|in|on|by)$/i;

/**
 * Product nouns taken from owner statements: the leading noun phrase of each
 * product fact ("The dashboard exports ..." -> "dashboard") and of the offer
 * ("Booking software that ..." -> "booking software", "software").
 */
export function productNouns(config: SiteConfig, extra: string[] = []): string[] {
  const out = new Set<string>(GENERIC_PRODUCT_NOUNS);
  const lead = (text: string) => {
    const words = text.replace(/\(.*?\)/g, ' ').trim().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}-]/gu, ''));
    let i = 0;
    while (i < words.length && /^(?:the|a|an|our|this|its)$/i.test(words[i]!)) i++;
    const phrase: string[] = [];
    for (; i < words.length && phrase.length < 3; i++) {
      const w = words[i]!;
      if (!w || SUBJECT_STOP.test(w) || CLAIM_VERB_RE.test(w)) break;
      phrase.push(w.toLowerCase());
    }
    if (phrase.length) {
      out.add(phrase[phrase.length - 1]!);
      if (phrase.length > 1) out.add(phrase.join(' '));
    }
  };
  for (const f of config.business.productFacts) lead(f.statement);
  if (config.business.offer) lead(config.business.offer);
  for (const e of extra) if (e.trim()) out.add(e.trim().toLowerCase());
  return [...out].filter((n) => n.length >= 2);
}

function subjectPattern(config: SiteConfig, extraNouns: string[] = []): { test(s: string): boolean } {
  const names = [config.site.businessName, ...config.brand.aliases]
    .map((n) => n.replace(/\(.*?\)/g, '').trim())
    .filter((n) => n.length >= 2)
    .map(escapeRegExp);
  const nameRe = names.length ? new RegExp(`\\b(?:${names.join('|')})\\b`, 'i') : null;
  const nouns = productNouns(config, extraNouns).map(escapeRegExp).join('|');
  const nounRe = new RegExp(`\\b(?:the|this|our|its)\\s+(?:[\\w-]+\\s+)?(?:${nouns})\\b`, 'i');
  return { test: (s: string) => FIRST_PARTY_RE.test(s) || nounRe.test(s) || (nameRe?.test(s) ?? false) };
}

const PRONOUN_START_RE = /^(?:it|it's|they|they're)\b/i;

export interface ClaimFinding {
  sentence: string;
  clause: string;
  supportedBy: string | null;
  bestContainment: number;
}

/**
 * Find clauses that make claims about the business/product and check each
 * against owner-approved statements. A sentence is about the business when
 * it uses first-person plural, the business name or an alias, a product noun
 * from the owner's facts/offer or a generic product noun with a determiner
 * ("the dashboard", "the app", "this tool"), or starts with "It"/"They" right
 * after such a sentence.
 */
export function productClaims(text: string, config: SiteConfig, opts: { extraProductNouns?: string[] } = {}): ClaimFinding[] {
  const subject = subjectPattern(config, opts.extraProductNouns ?? []);
  const statements = ownerStatements(config).map((s) => ({ ...s, tokens: new Set(contentTokens(s.text)) }));
  const nameTokens = new Set(contentTokens([config.site.businessName, ...config.brand.aliases].join(' ')));
  const out: ClaimFinding[] = [];
  // Quoted text (e.g. a customer's question) is quotation, not a claim; quotes are checked separately.
  // Markdown links keep only their anchor text.
  const unquoted = stripUnverifiedMarkers(text)
    .replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, '$1')
    .replace(/"[^"\n]*"|\u201c[^\u201d\n]*\u201d/g, ' "" ');
  let previousFirstParty = false;
  for (const sentence of sentences(unquoted)) {
    // Questions (e.g. customer questions quoted in an outline) are not claims.
    if (isQuestion(sentence)) {
      previousFirstParty = false;
      continue;
    }
    const firstParty: boolean = subject.test(sentence) || (previousFirstParty && PRONOUN_START_RE.test(sentence));
    previousFirstParty = firstParty;
    if (!firstParty) continue;
    const clauses = sentence.split(/[,;:]|\s(?:and|but|while|plus|also|which|so that|so)\s/i).map((c) => c.trim()).filter(Boolean);
    for (const clause of clauses) {
      if (!CLAIM_VERB_RE.test(clause)) continue;
      const tokens = new Set(contentTokens(clause).filter((t) => !nameTokens.has(t)));
      if (tokens.size === 0) continue;
      let best = 0;
      let by: string | null = null;
      for (const s of statements) {
        const c = containment(tokens, s.tokens);
        const reverse = s.tokens.size ? containment(s.tokens, tokens) : 0;
        const score = Math.max(c, reverse >= 0.8 ? reverse : 0);
        if (score > best) {
          best = score;
          by = s.id;
        }
      }
      out.push({ sentence, clause, supportedBy: best >= 0.6 ? by : null, bestContainment: Math.round(best * 100) / 100 });
    }
  }
  return out;
}

export function prohibitedClaimHits(text: string, config: SiteConfig): string[] {
  const norm = normalizeText(text);
  const hits: string[] = [];
  for (const p of config.business.prohibitedClaims) {
    const np = normalizeText(p);
    if (!np) continue;
    if (norm.includes(np)) {
      hits.push(p);
      continue;
    }
    const pt = new Set(contentTokens(p));
    if (pt.size >= 2) {
      for (const s of sentences(text)) {
        if (containment(pt, new Set(contentTokens(s))) >= 0.9) {
          hits.push(p);
          break;
        }
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Quotations, expertise, promises
// ---------------------------------------------------------------------------

export function quotations(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"\n]{12,})"|“([^”\n]{12,})”/g)) {
    const q = (m[1] ?? m[2] ?? '').trim();
    if (q.split(/\s+/).length >= 5) out.push(q);
  }
  for (const m of text.matchAll(/^>\s?(.+)$/gm)) {
    const q = m[1]!.trim();
    if (q.split(/\s+/).length >= 5 && !/^\[!/.test(q)) out.push(q);
  }
  return out;
}

export function quoteSupported(quote: string, corpus: SupportCorpus): boolean {
  const nq = normalizeText(quote);
  return nq.length > 0 && corpus.normalized.includes(nq);
}

export const EXPERIENCE_PATTERNS: Array<{ id: string; re: RegExp; label: string }> = [
  { id: 'first_hand_test', re: /\b(we|i|our team)\s+(tested|tried|measured|benchmarked|reviewed|evaluated|used)\b/i, label: 'first-hand testing/experience claim' },
  { id: 'in_our_experience', re: /\b(in (my|our) experience|from (my|our) experience|hands-on|after (testing|using) (it|them|this))\b/i, label: 'first-hand experience claim' },
  { id: 'credentials', re: /\b(certified|accredited|licensed|award[- ]winning|phd|board[- ]certified|\d+\+?\s+years of experience|industry experts?|leading experts?)\b/i, label: 'credential/expertise claim' },
  { id: 'testimonial', re: /\b(one of our (customers|clients)|a (happy|satisfied) (customer|client)|customers (say|love|tell us)|testimonial|as .{2,40} (said|told us))\b/i, label: 'testimonial or attributed customer statement' },
];

export const PROMISE_PATTERNS: Array<{ id: string; re: RegExp; label: string }> = [
  { id: 'guarantee', re: /\b(guarantee[sd]?|guaranteed|risk[- ]free|no risk|100% (safe|secure|accurate|effective))\b/i, label: 'guarantee' },
  { id: 'ranking_promise', re: /\b(rank (#?1|first|higher)|top of google|first page of google|will (rank|go viral))\b/i, label: 'ranking/outcome promise' },
  { id: 'outcome_promise', re: /\b(will (double|triple|increase|boost|skyrocket)|ensures? (you|that you) (get|achieve|succeed)|always works|never fails)\b/i, label: 'outcome promise' },
  { id: 'superlative', re: /\b(best in the world|world[- ]class|number one|#1|the only (tool|solution|product|service)|unbeatable)\b/i, label: 'unsupported superlative' },
];

/**
 * Per-language pattern sets for the fabrication checks (first-hand
 * experience, credentials, testimonials, guarantees, outcome promises) and a
 * function-word list for a light language-identification heuristic. A
 * content language WITHOUT a set is never reported as "pass": the quality
 * gate marks those checks not_checked and routes the draft to a human.
 * Like the router lexicons, each set is small and explicit; extend it per
 * language rather than applying English patterns to other languages.
 */
export interface ClaimPatternSet {
  language: string;
  experience: Array<{ id: string; re: RegExp; label: string }>;
  promise: Array<{ id: string; re: RegExp; label: string }>;
  /** Very common words of the language (language-identification heuristic). */
  functionWords: string[];
}

export const CLAIM_PATTERN_SETS: Readonly<Record<string, ClaimPatternSet>> = {
  en: {
    language: 'English',
    experience: EXPERIENCE_PATTERNS,
    promise: PROMISE_PATTERNS,
    functionWords: ['the', 'and', 'to', 'of', 'a', 'in', 'is', 'you', 'for', 'it', 'that', 'with'],
  },
  de: {
    language: 'German',
    experience: [
      { id: 'first_hand_test', re: /\b(?:wir|ich|unser team)\b[^.!?\n]{0,80}\b(?:getestet|ausprobiert|gemessen|verglichen|geprüft|bewertet)/i, label: 'first-hand testing/experience claim' },
      { id: 'in_our_experience', re: /\b(?:(?:meiner|unserer) erfahrung nach|aus (?:eigener|unserer|meiner) erfahrung|selbst getestet|praxistest)/i, label: 'first-hand experience claim' },
      { id: 'credentials', re: /\b(?:zertifiziert\w*|akkreditiert\w*|preisgekrönt\w*|ausgezeichnet (?:mit|als)|\d+\+?\s+jahre?n? erfahrung|(?:führende[nr]?\s+|branchen)experten?)/i, label: 'credential/expertise claim' },
      { id: 'testimonial', re: /\b(?:eine?[nr]? (?:zufriedene[rn]?|glückliche[rn]?) (?:kunde|kundin|kunden)|unsere kunden (?:sagen|lieben|berichten)|kundenstimme\w*|erfahrungsbericht\w*)/i, label: 'testimonial or attributed customer statement' },
    ],
    promise: [
      { id: 'guarantee', re: /\b(?:garantier\w*|garantie\w*|risikofrei|ohne risiko|100\s?% (?:sicher|genau|wirksam))/i, label: 'guarantee' },
      { id: 'ranking_promise', re: /\b(?:platz (?:1|eins) (?:bei|in) google|erste seite (?:bei|von) google)/i, label: 'ranking/outcome promise' },
      { id: 'outcome_promise', re: /\b(?:funktioniert immer|scheitert nie|(?:verdoppel|verdreifach)\w* (?:garantiert|sicher))/i, label: 'outcome promise' },
      { id: 'superlative', re: /\b(?:weltbeste[nrs]?|weltklasse|nummer eins|die einzige (?:lösung|software|app))/i, label: 'unsupported superlative' },
    ],
    functionWords: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'zu', 'den', 'mit', 'sie', 'von', 'ein', 'eine', 'auf', 'für', 'es', 'im', 'sich', 'dem', 'auch', 'wir', 'ich', 'sind', 'wie'],
  },
};

/** The pattern set for a BCP 47 language tag (by primary subtag), or null when none exists. */
export function claimPatternSet(language: string | null | undefined): ClaimPatternSet | null {
  const primary = (language ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
  return CLAIM_PATTERN_SETS[primary] ?? null;
}

export function patternHits(text: string, patterns: Array<{ id: string; re: RegExp; label: string }>): Array<{ id: string; label: string; match: string; sentence: string }> {
  const hits: Array<{ id: string; label: string; match: string; sentence: string }> = [];
  for (const s of sentences(stripUnverifiedMarkers(text))) {
    for (const p of patterns) {
      const m = p.re.exec(s);
      if (m) hits.push({ id: p.id, label: p.label, match: m[0], sentence: s });
    }
  }
  return hits;
}

/** Whether a sentence is covered by an owner-approved statement (for expertise/promise exceptions). */
export function sentenceSupportedByOwner(sentence: string, config: SiteConfig): boolean {
  const tokens = new Set(contentTokens(sentence));
  if (!tokens.size) return false;
  return ownerStatements(config).some((s) => {
    const st = new Set(contentTokens(s.text));
    return st.size > 0 && containment(st, tokens) >= 0.8;
  });
}

/** Word-count targets ("2,000-word article", "at least 1500 words"). */
export const WORD_COUNT_RE = /\b\d[\d,.]*\s*(?:\+\s*)?(?:-\s*)?words?\b|\bword[- ]count\b/i;

// ---------------------------------------------------------------------------
// Fact-check notes: a model cannot verify its own statement
// ---------------------------------------------------------------------------

/**
 * Trust classes whose evidence can confirm a fact-check statement. User
 * reports (Reddit, imports), scraped competitor text, model output, and
 * synthetic fixtures never confirm a fact. A trust class alone is not enough:
 * see factVerificationSources for the evidence KINDS that can verify.
 */
export const VERIFYING_TRUST_CLASSES: ReadonlySet<string> = new Set(['owner_approved', 'first_party_measurement', 'third_party_data']);

/** Share of a statement's content words that the cited evidence must contain for a "verified" note to stand. */
export const FACT_NOTE_MIN_OVERLAP = 0.5;

/**
 * Id prefix of first-party measurement sources (computed brief metrics such as
 * `metric:gsc_impressions`). They can back only a numeric measurement
 * statement: one that states a number, which the metric must state too.
 */
export const MEASUREMENT_SOURCE_PREFIX = 'metric:';

/** Whether a verification source id is a first-party measurement (numeric statements only). */
export function isMeasurementSourceId(id: string): boolean {
  return id.startsWith(MEASUREMENT_SOURCE_PREFIX);
}

/** A brief evidence item as factVerificationSources reads it (`kind` as in evidenceSourceSchema). */
export interface VerificationEvidence {
  id: string;
  excerpt: string;
  trustClass: string;
  isSandbox: boolean;
  kind?: string;
}

/**
 * Whether one brief evidence item can verify a fact. A demand signal is not
 * evidence of a product fact: its excerpt is the searcher's or poster's own
 * words (a Search Console query, a DataForSEO keyword, an Apify post, an
 * imported question), so a note that merely restated a query would otherwise
 * pass the lexical overlap test. Allowed, by kind:
 * - `product_fact`, `approved_claim`, `catalog_attribute`: owner statements
 *   (owner_approved trust only; unvalidated catalog values are model_generated);
 * - `metric`: first-party measurements only (first_party_measurement trust,
 *   `metric:` ids), and factNoteSupport uses them only for numeric measurement
 *   statements; third-party estimates and engagement counts never verify.
 * Everything else is refused: `signal` (every origin: gsc_query, dataforseo,
 * apify, manual), `page` (own-site observations mix page headings with
 * query-overlap notes; the target page's current text is passed separately as
 * `target_page_text`), and `memory` (retrieved notes, SERP, and other
 * third-party material). An item without a `kind` counts only when it is
 * owner-approved.
 */
function verifiesFacts(e: VerificationEvidence): boolean {
  if (e.isSandbox || !VERIFYING_TRUST_CLASSES.has(e.trustClass)) return false;
  switch (e.kind) {
    case 'product_fact':
    case 'approved_claim':
    case 'catalog_attribute':
      return e.trustClass === 'owner_approved';
    case 'metric':
      return e.trustClass === 'first_party_measurement' && isMeasurementSourceId(e.id);
    case undefined:
      return e.trustClass === 'owner_approved';
    default:
      return false;
  }
}

/**
 * Sources that can back a "verified" fact-check note, by id: owner statements
 * (`fact:<id>`, `claim:<n>`, `differentiator:<n>`, `offer`, `conversion:<name>`),
 * the brief evidence items verifiesFacts accepts (owner statements and
 * first-party measurements; never demand signals, SERP, memory, or other
 * third-party items), and `extra` sources (the target page's current text for
 * improve/add-section drafts).
 */
export function factVerificationSources(
  config: SiteConfig,
  evidence: ReadonlyArray<VerificationEvidence>,
  extra: ReadonlyArray<{ id: string; text: string }> = [],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of ownerStatements(config)) out.set(s.id, s.text);
  for (const e of evidence) if (verifiesFacts(e) && !out.has(e.id)) out.set(e.id, e.excerpt);
  for (const x of extra) if (x.text) out.set(x.id, x.text);
  return out;
}

/** A cited id as stored: a bare configured product-fact id (`pf-export`) becomes `fact:pf-export`. */
export function normalizeFactNoteId(id: string, productFactIds: ReadonlySet<string>): string {
  const t = id.trim();
  return !t.startsWith('fact:') && productFactIds.has(t) ? `fact:${t}` : t;
}

export interface FactNoteSupport {
  /** Cited ids that resolve to a verification source. */
  resolvable: string[];
  /** Share of the statement's content words found in the resolvable sources' text (0..1). */
  overlap: number;
  /** Numbers in the statement that no resolvable source states. */
  missingNumbers: string[];
  supported: boolean;
  /** Why the note is not supported (null when supported). */
  reason: string | null;
}

/**
 * Whether cited evidence really backs a statement: at least one cited id
 * resolves to a verification source, the sources contain at least
 * FACT_NOTE_MIN_OVERLAP of the statement's content words, and every number in
 * the statement appears in them. A heuristic that errs toward "unverified":
 * an unsupported note is marked for a human, never trusted on the model's word.
 */
export function factNoteSupport(statement: string, evidenceIds: readonly string[], sources: ReadonlyMap<string, string>): FactNoteSupport {
  const stmt = new Set(contentTokens(statement));
  // A first-party measurement backs only a numeric measurement statement (one that states a number).
  const numeric = [...stmt].some((t) => /\d/.test(t));
  const known = [...new Set(evidenceIds.filter((id) => sources.has(id)))];
  const resolvable = known.filter((id) => numeric || !isMeasurementSourceId(id));
  if (!resolvable.length) {
    const reason = known.length
      ? `the cited first-party measurement(s) (${known.join(', ')}) can back only a numeric measurement statement, and this statement states no number`
      : evidenceIds.length
        ? `none of the cited ids (${evidenceIds.join(', ')}) is a product fact, owner statement, first-party measurement, or the target page text of the approved bundle (demand signals, SERP, and retrieved notes never verify a fact)`
        : 'no evidence id was cited';
    return { resolvable, overlap: 0, missingNumbers: [], supported: false, reason };
  }
  const cited = new Set(resolvable.flatMap((id) => contentTokens(sources.get(id) ?? '')));
  const overlap = Math.round(containment(stmt, cited) * 100) / 100;
  const missingNumbers = [...stmt].filter((t) => /\d/.test(t) && !cited.has(t));
  const supported = stmt.size > 0 && overlap >= FACT_NOTE_MIN_OVERLAP && missingNumbers.length === 0;
  const reason = supported
    ? null
    : !stmt.size
      ? 'the statement has no content words to compare with the evidence'
      : missingNumbers.length
        ? `the cited evidence (${resolvable.join(', ')}) does not state ${missingNumbers.map((n) => `"${n}"`).join(', ')}`
        : `the cited evidence (${resolvable.join(', ')}) contains only ${Math.round(overlap * 100)}% of the statement's content words (at least ${Math.round(FACT_NOTE_MIN_OVERLAP * 100)}% required)`;
  return { resolvable, overlap, missingNumbers, supported, reason };
}
