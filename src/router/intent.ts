import type { IntentResult, QueryIntent } from './types.js';

/**
 * Deterministic query-intent rules.
 *
 * - Branded: a configured brand alias (brand.aliases) appears as a token
 *   sequence in the query (case- and diacritic-insensitive). The matched
 *   alias tokens are REMOVED before any lexicon matching, so a brand name
 *   that contains lexicon words ("Best Buy", "Guide Hub", "Example
 *   Widgets") never supplies intent by itself.
 * - Informational: question words / question mark / learning modifiers.
 * - Commercial: comparison and evaluation modifiers.
 * - Transactional: purchase, price, booking, and signup modifiers.
 * - Navigational: login/contact/official modifiers, a query that is only a
 *   brand, or a branded query whose remaining words are all navigational
 *   ("<brand> login", "<brand> opening hours", "<brand> phone number").
 * - Mixed: informational + commercial/transactional signals together.
 * - Unsure: no rule applies. Bare topic queries are NOT forced into a class.
 *
 * Multilingual-safe: built-in lexicons exist for several languages; when the
 * site configures market.languages, only those lexicons are used (plus
 * language-neutral signals such as "?"). A query in a language without a
 * lexicon becomes "unsure" rather than being mis-classified as English.
 * Non-English question words only count as the first token to reduce
 * cross-language collisions.
 *
 * Only genuinely ambiguous results (mixed/unsure) may be sent to the optional
 * low-cost model classifier (see llm-intent.ts).
 */

export const INTENT_RULES_VERSION = 'intent-rules@1.1.0';

export interface IntentLexicon {
  question: string[];
  informational: string[];
  commercial: string[];
  transactional: string[];
  navigational: string[];
}

export const BUILTIN_LEXICONS: Readonly<Record<string, IntentLexicon>> = {
  en: {
    question: ['how', 'what', 'why', 'when', 'where', 'who', 'which', 'whose', 'can', 'does', 'do', 'is', 'are', 'should', 'will', 'could', 'would', 'did'],
    informational: ['guide', 'tutorial', 'meaning', 'definition', 'define', 'example', 'examples', 'ideas', 'tips', 'learn', 'explained', 'history', 'checklist', 'how to', 'what is'],
    commercial: ['best', 'top', 'review', 'reviews', 'vs', 'versus', 'compare', 'comparison', 'alternative', 'alternatives', 'cheapest', 'affordable', 'near me', 'rated'],
    transactional: ['buy', 'price', 'prices', 'pricing', 'cost', 'costs', 'purchase', 'discount', 'coupon', 'deals', 'for sale', 'hire', 'booking', 'quote', 'subscribe', 'sign up', 'signup', 'free trial', 'trial', 'download', 'shop', 'cheap'],
    navigational: ['login', 'log in', 'sign in', 'signin', 'official', 'contact', 'website', 'account', 'dashboard'],
  },
  de: {
    question: ['wie', 'was', 'warum', 'wann', 'wo', 'wer', 'welche', 'welcher', 'welches', 'wieso', 'weshalb', 'kann', 'ist', 'sind', 'gibt'],
    informational: ['anleitung', 'bedeutung', 'definition', 'beispiel', 'beispiele', 'tipps', 'ideen', 'erklärung'],
    commercial: ['beste', 'besten', 'bester', 'vergleich', 'erfahrungen', 'alternative', 'alternativen', 'testsieger'],
    transactional: ['kaufen', 'preis', 'preise', 'kosten', 'bestellen', 'günstig', 'angebot', 'rabatt', 'gutschein', 'buchen', 'mieten'],
    navigational: ['anmelden', 'kontakt'],
  },
  fr: {
    question: ['comment', 'pourquoi', 'quand', 'où', 'qui', 'quel', 'quelle', 'quels', 'quelles', 'quoi'],
    informational: ['guide', 'tutoriel', 'définition', 'exemple', 'exemples', 'conseils', 'idées', 'signification'],
    commercial: ['meilleur', 'meilleure', 'meilleurs', 'avis', 'comparatif', 'comparaison', 'alternative'],
    transactional: ['acheter', 'prix', 'tarif', 'tarifs', 'coût', 'commander', 'promo', 'réduction', 'réserver', 'devis', 'pas cher'],
    navigational: ['connexion', 'contact'],
  },
  es: {
    question: ['cómo', 'qué', 'por qué', 'cuándo', 'dónde', 'quién', 'cuál', 'cuáles'],
    informational: ['guía', 'tutorial', 'significado', 'definición', 'ejemplo', 'ejemplos', 'consejos', 'ideas'],
    commercial: ['mejor', 'mejores', 'opiniones', 'reseña', 'comparativa', 'alternativa'],
    transactional: ['comprar', 'precio', 'precios', 'costo', 'coste', 'barato', 'oferta', 'descuento', 'reservar', 'cotización'],
    navigational: ['iniciar sesión', 'contacto'],
  },
  it: {
    question: ['come', 'perché', 'quando', 'dove', 'chi', 'quale', 'quali', 'cosa'],
    informational: ['guida', 'significato', 'esempio', 'esempi', 'consigli'],
    commercial: ['migliore', 'migliori', 'recensioni', 'confronto', 'alternativa'],
    transactional: ['comprare', 'acquistare', 'prezzo', 'prezzi', 'costo', 'offerta', 'sconto', 'prenotare'],
    navigational: ['accedi', 'contatti'],
  },
  pt: {
    question: ['como', 'porque', 'por que', 'quando', 'onde', 'quem', 'qual', 'quais', 'o que'],
    informational: ['guia', 'significado', 'exemplo', 'exemplos', 'dicas'],
    commercial: ['melhor', 'melhores', 'avaliação', 'comparação', 'alternativa'],
    transactional: ['comprar', 'preço', 'preços', 'custo', 'barato', 'promoção', 'desconto', 'reservar', 'orçamento'],
    navigational: ['entrar', 'contato'],
  },
  nl: {
    question: ['hoe', 'wat', 'waarom', 'wanneer', 'waar', 'wie', 'welke'],
    informational: ['handleiding', 'betekenis', 'voorbeeld', 'voorbeelden', 'tips'],
    commercial: ['beste', 'review', 'vergelijken', 'vergelijking', 'alternatief'],
    transactional: ['kopen', 'prijs', 'prijzen', 'kosten', 'bestellen', 'goedkoop', 'korting', 'boeken'],
    navigational: ['inloggen', 'contact'],
  },
  et: {
    question: ['kuidas', 'mis', 'miks', 'millal', 'kus', 'kes', 'milline', 'millised', 'kas'],
    informational: ['juhend', 'tähendus', 'näide', 'näited', 'nõuanded'],
    commercial: ['parim', 'parimad', 'arvustus', 'võrdlus', 'alternatiiv'],
    transactional: ['osta', 'hind', 'hinnad', 'hinna', 'maksumus', 'telli', 'tellida', 'soodustus', 'broneeri', 'pakkumine'],
    navigational: ['sisselogimine', 'kontakt'],
  },
  fi: {
    question: ['miten', 'mitä', 'mikä', 'miksi', 'milloin', 'missä', 'kuka', 'kuinka'],
    informational: ['opas', 'merkitys', 'esimerkki', 'vinkit'],
    commercial: ['paras', 'parhaat', 'arvostelu', 'vertailu'],
    transactional: ['osta', 'hinta', 'hinnat', 'tilaa', 'halpa', 'tarjous', 'alennus', 'varaa'],
    navigational: ['kirjaudu', 'yhteystiedot'],
  },
  sv: {
    question: ['hur', 'vad', 'varför', 'när', 'vem', 'vilken', 'vilka'],
    informational: ['guide', 'betydelse', 'exempel', 'tips'],
    commercial: ['bästa', 'recension', 'jämförelse', 'alternativ'],
    transactional: ['köpa', 'pris', 'priser', 'kostnad', 'beställa', 'billig', 'rabatt', 'boka'],
    navigational: ['logga in', 'kontakt'],
  },
  pl: {
    question: ['jak', 'dlaczego', 'kiedy', 'gdzie', 'kto', 'który', 'która', 'które', 'czy'],
    informational: ['poradnik', 'znaczenie', 'przykład', 'przykłady', 'porady'],
    commercial: ['najlepszy', 'najlepsze', 'opinie', 'ranking', 'porównanie'],
    transactional: ['kupić', 'kup', 'cena', 'ceny', 'koszt', 'zamówić', 'tani', 'tanie', 'promocja', 'rabat'],
    navigational: ['logowanie', 'kontakt'],
  },
  ru: {
    question: ['как', 'что', 'почему', 'когда', 'где', 'кто', 'какой', 'какая', 'какие', 'зачем'],
    informational: ['инструкция', 'значение', 'пример', 'примеры', 'советы'],
    commercial: ['лучший', 'лучшие', 'отзывы', 'сравнение', 'обзор'],
    transactional: ['купить', 'цена', 'цены', 'стоимость', 'заказать', 'дешево', 'скидка'],
    navigational: ['вход', 'контакты'],
  },
};

/**
 * Words that, next to a brand name, mean the searcher wants a page of that
 * brand (contact details, opening hours, sign-in, a store), not new content.
 * Used ONLY for branded queries, in addition to the lexicon's navigational
 * words; filler words may appear between them ("<brand> contact us").
 */
export const BRAND_NAVIGATIONAL_WORDS: Readonly<Record<string, { phrases: readonly string[]; filler: readonly string[] }>> = {
  en: {
    phrases: ['hours', 'opening hours', 'opening times', 'phone', 'phone number', 'telephone', 'number', 'address', 'location', 'locations', 'directions', 'email', 'support', 'help', 'customer service', 'customer support', 'careers', 'jobs', 'app', 'store', 'stores', 'shop', 'near me', 'homepage', 'home page', 'site', 'www', 'com', 'company', 'about', 'about us', 'headquarters', 'register', 'registration', 'portal', 'my account', 'reset password', 'password', 'order status', 'track order'],
    filler: ['us', 'the', 'of', 'for', 'in', 'my', 'a', 'an', 'to', 'page', 'center', 'centre'],
  },
  de: { phrases: ['öffnungszeiten', 'telefon', 'telefonnummer', 'adresse', 'filiale', 'filialen', 'standort', 'standorte', 'impressum', 'karriere', 'jobs', 'hilfe', 'kundenservice', 'login', 'konto', 'app', 'shop', 'in der nähe'], filler: ['die', 'der', 'das', 'von', 'zur', 'zum', 'mein', 'seite'] },
  fr: { phrases: ['horaires', 'téléphone', 'adresse', 'magasin', 'magasins', 'service client', 'recrutement', 'aide', 'compte', 'appli', 'application', 'près de moi'], filler: ['le', 'la', 'les', 'de', 'du', 'des', 'mon'] },
  es: { phrases: ['horario', 'horarios', 'teléfono', 'dirección', 'tienda', 'tiendas', 'atención al cliente', 'empleo', 'ayuda', 'cuenta', 'app', 'cerca de mí'], filler: ['el', 'la', 'los', 'las', 'de', 'del', 'mi'] },
  et: { phrases: ['lahtiolekuajad', 'telefon', 'aadress', 'pood', 'poed', 'klienditugi', 'töökohad', 'abi', 'konto', 'äpp'], filler: [] },
};

/** Result of brand-alias detection and stripping for one query. */
export interface BrandAnalysis {
  branded: boolean;
  matchedAlias: string | null;
  /** Normalized query tokens left after removing every matched alias occurrence. */
  remainingTokens: string[];
  /** Branded and nothing but navigational words (or nothing) remains. */
  navigationalOnly: boolean;
  /** Branded and no token remains at all. */
  brandOnly: boolean;
}

export interface IntentOptions {
  brandAliases: readonly string[];
  /** market.languages from config (BCP 47). Empty = all built-in lexicons. */
  languages?: readonly string[];
  /** Extra lexicons (merged per language) supplied by the caller. */
  extraLexicons?: Record<string, Partial<IntentLexicon>>;
}

/** NFKC, lower-case, collapse whitespace. */
export function normalizeQuery(q: string): string {
  return q.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '');
}

function tokens(s: string): string[] {
  return s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function containsPhrase(queryTokens: string[], phrase: string): boolean {
  return phraseSpans(queryTokens, phrase).length > 0;
}

/** Every [start, end) token span where `phrase` occurs in `queryTokens`. */
function phraseSpans(queryTokens: string[], phrase: string): Array<[number, number]> {
  const pt = tokens(normalizeQuery(phrase));
  const out: Array<[number, number]> = [];
  if (pt.length === 0) return out;
  outer: for (let i = 0; i + pt.length <= queryTokens.length; i++) {
    for (let j = 0; j < pt.length; j++) if (queryTokens[i + j] !== pt[j]) continue outer;
    out.push([i, i + pt.length]);
  }
  return out;
}

interface CompiledLexicon {
  lang: string;
  lex: IntentLexicon;
}

export class IntentClassifierRules {
  private readonly lexicons: CompiledLexicon[];
  private readonly aliases: Array<{ raw: string; tokens: string[]; compact: string }>;
  /** Navigational phrases (lexicon + brand extras) and filler words for the active languages. */
  private readonly brandNav: { phrases: string[]; filler: Set<string> };
  readonly unmatchedLanguages: string[] = [];

  constructor(private readonly opts: IntentOptions) {
    const wanted = (opts.languages ?? []).map((l) => l.toLowerCase().split(/[-_]/)[0]!).filter(Boolean);
    const langs = wanted.length ? [...new Set(wanted)] : Object.keys(BUILTIN_LEXICONS);
    this.lexicons = [];
    for (const lang of langs) {
      const base = BUILTIN_LEXICONS[lang];
      const extra = opts.extraLexicons?.[lang];
      if (!base && !extra) {
        this.unmatchedLanguages.push(lang);
        continue;
      }
      const merge = (k: keyof IntentLexicon) => [...(base?.[k] ?? []), ...(extra?.[k] ?? [])];
      this.lexicons.push({ lang, lex: { question: merge('question'), informational: merge('informational'), commercial: merge('commercial'), transactional: merge('transactional'), navigational: merge('navigational') } });
    }
    const navPhrases = new Set<string>();
    const filler = new Set<string>();
    for (const { lang, lex } of this.lexicons) {
      for (const p of lex.navigational) navPhrases.add(p);
      for (const p of BRAND_NAVIGATIONAL_WORDS[lang]?.phrases ?? []) navPhrases.add(p);
      for (const f of BRAND_NAVIGATIONAL_WORDS[lang]?.filler ?? []) filler.add(fold(normalizeQuery(f)));
    }
    this.brandNav = { phrases: [...navPhrases], filler };
    this.aliases = opts.brandAliases
      .map((a) => normalizeQuery(a))
      .filter((a) => a.length >= 2)
      .map((a) => ({ raw: a, tokens: tokens(fold(a)), compact: fold(a).replace(/[^\p{L}\p{N}]+/gu, '') }));
  }

  /** Every alias occurrence as a token span; the first matching alias (config order) names the brand. */
  private brandSpans(folded: string[]): { alias: string | null; spans: Array<[number, number]> } {
    let alias: string | null = null;
    const spans: Array<[number, number]> = [];
    for (const a of this.aliases) {
      const found: Array<[number, number]> = a.tokens.length ? phraseSpans(folded, a.tokens.join(' ')) : [];
      // Spacing variants ("widget hub" vs "WidgetHub"): adjacent query tokens joined must EQUAL the compact alias.
      if (a.compact.length >= 5) {
        for (let i = 0; i < folded.length; i++) {
          let joined = '';
          for (let j = i; j < folded.length && joined.length < a.compact.length; j++) {
            joined += folded[j];
            if (joined === a.compact) found.push([i, j + 1]);
          }
        }
      }
      if (found.length) {
        alias ??= a.raw;
        spans.push(...found);
      }
    }
    return { alias, spans };
  }

  /**
   * Detect brand aliases and strip their tokens. Lexicon and rule matching run
   * on the REMAINING tokens only, so words inside a brand name never supply
   * intent. A branded query whose remaining tokens are only navigational words
   * (plus filler) or nothing at all is navigational.
   */
  brandAnalysis(query: string): BrandAnalysis {
    const qt = tokens(normalizeQuery(query));
    const ft = qt.map(fold);
    const { alias, spans } = this.brandSpans(ft);
    if (!alias) return { branded: false, matchedAlias: null, remainingTokens: qt, navigationalOnly: false, brandOnly: false };
    const covered = new Set<number>();
    for (const [s, e] of spans) for (let i = s; i < e; i++) covered.add(i);
    const remainingTokens = qt.filter((_, i) => !covered.has(i));
    const remFolded = remainingTokens.map(fold);
    const brandOnly = remainingTokens.length === 0;
    let navigationalOnly = brandOnly;
    if (!brandOnly) {
      const nav = new Set<number>();
      for (const p of this.brandNav.phrases) for (const [s, e] of phraseSpans(remFolded, fold(normalizeQuery(p)))) for (let i = s; i < e; i++) nav.add(i);
      navigationalOnly = nav.size > 0 && remFolded.every((t, i) => nav.has(i) || this.brandNav.filler.has(t));
    }
    return { branded: true, matchedAlias: alias, remainingTokens, navigationalOnly, brandOnly };
  }

  classify(query: string): IntentResult {
    const normalized = normalizeQuery(query);
    const brand = this.brandAnalysis(normalized);
    // Lexicon matching sees only the tokens OUTSIDE the matched brand alias.
    const qt = brand.remainingTokens;
    const ft = qt.map(fold);
    const signals: string[] = [];
    const cats = new Set<'informational' | 'commercial' | 'transactional' | 'navigational'>();
    const matchedBrand = brand.matchedAlias;
    const branded = brand.branded;
    if (branded) signals.push(`brand:${matchedBrand}`);
    if (/[?？]\s*$/.test(normalized) || normalized.startsWith('¿')) {
      signals.push('question_mark');
      cats.add('informational');
    }
    const has = (phrase: string) => containsPhrase(qt, phrase) || containsPhrase(ft, fold(phrase));
    for (const { lang, lex } of this.lexicons) {
      for (const w of lex.question) {
        const wt = tokens(normalizeQuery(w));
        const first = wt.length > 0 && wt.every((t, i) => qt[i] === t || ft[i] === fold(t));
        const anywhere = lang === 'en' && wt.length === 1 && ['how', 'what', 'why', 'when', 'where', 'who', 'which'].includes(wt[0]!) && has(w);
        if (first || anywhere) {
          signals.push(`question:${lang}:${w}`);
          cats.add('informational');
        }
      }
      for (const k of ['informational', 'commercial', 'transactional', 'navigational'] as const) {
        for (const w of lex[k]) {
          if (has(w)) {
            signals.push(`${k}:${lang}:${w}`);
            cats.add(k);
          }
        }
      }
    }
    if (brand.navigationalOnly && !brand.brandOnly) signals.push('brand_navigational');
    const brandNavigational = brand.brandOnly || (brand.navigationalOnly && !signals.includes('question_mark'));
    let intent: QueryIntent;
    const nonNav = [...cats].filter((c) => c !== 'navigational');
    if (brandNavigational || (cats.has('navigational') && nonNav.length === 0)) intent = 'navigational';
    else if (nonNav.length === 0) intent = 'unsure';
    else if (cats.has('informational') && (cats.has('commercial') || cats.has('transactional'))) intent = 'mixed';
    else if (cats.has('transactional')) intent = 'transactional';
    else if (cats.has('commercial')) intent = 'commercial';
    else intent = 'informational';
    return {
      query,
      normalized,
      intent,
      branded,
      matchedBrandAlias: matchedBrand,
      signals: [...new Set(signals)],
      decidedBy: 'rule',
      ambiguous: intent === 'mixed' || intent === 'unsure',
    };
  }
}

/** Result of the optional model classifier for ambiguous queries. */
export type IntentHookResult = { ok: true; results: Map<string, { intent: QueryIntent; rationale: string }> } | { ok: false; status: string; reason: string };

/** Optional hook used ONLY for queries the rules left mixed/unsure. */
export type IntentClassifierHook = (items: Array<{ query: string; ruleIntent: QueryIntent; signals: string[]; branded: boolean }>) => Promise<IntentHookResult>;

export interface ClassifyOutcome {
  results: IntentResult[];
  hook: { called: boolean; sent: number; resolved: number; status: string; reason?: string };
}

/**
 * Classify queries with deterministic rules, then (optionally) ask the hook
 * about the ambiguous ones only. Model answers are recorded with
 * decidedBy = 'model'; a model "unsure"/"mixed" stays ambiguous.
 */
export async function classifyQueries(queries: readonly string[], opts: IntentOptions & { hook?: IntentClassifierHook; maxHookQueries?: number }): Promise<ClassifyOutcome> {
  const rules = new IntentClassifierRules(opts);
  const results = queries.map((q) => rules.classify(q));
  const ambiguous = results.filter((r) => r.ambiguous).slice(0, opts.maxHookQueries ?? 25);
  if (!opts.hook || ambiguous.length === 0) {
    return { results, hook: { called: false, sent: 0, resolved: 0, status: opts.hook ? 'not_needed' : 'not_configured' } };
  }
  const out = await opts.hook(ambiguous.map((r) => ({ query: r.query, ruleIntent: r.intent, signals: r.signals, branded: r.branded })));
  if (!out.ok) return { results, hook: { called: true, sent: ambiguous.length, resolved: 0, status: out.status, reason: out.reason } };
  let resolved = 0;
  const final = results.map((r) => {
    const m = r.ambiguous ? out.results.get(r.query) : undefined;
    if (!m) return r;
    resolved++;
    return { ...r, intent: m.intent, decidedBy: 'model' as const, ambiguous: m.intent === 'mixed' || m.intent === 'unsure', rationale: m.rationale, signals: [...r.signals, `model:${m.intent}`] };
  });
  return { results: final, hook: { called: true, sent: ambiguous.length, resolved, status: 'ok' } };
}
