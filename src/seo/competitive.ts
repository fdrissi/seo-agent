import { z } from 'zod';
import { newId } from '../core/ids.js';
import type { Db } from '../database/db.js';
import type { EvidenceItem, LlmClient, LlmFailureStatus } from '../integrations/llm/types.js';
import { CRAWL_RESULT_COLS, loadCrawlText, parseHeadings, structuredDataTypes, latestCrawlResultForUrl, type CrawlResultRow, type Heading, type TextStore } from './crawl-data.js';
import { normalizeUrl } from './url.js';

/**
 * Deterministic competitor/SERP comparison INPUTS (no causal claims).
 *
 * Compares our page with crawled competitor pages on: intent/page type,
 * topic coverage (heading topic terms, not headings to copy), examples,
 * tools/templates, original data, cited evidence, freshness, FAQ-style
 * answers, and buyer concerns (pricing, shipping, returns, warranty,
 * objections). It records what OUR page does better as well as gaps. Word
 * count is reported for context only: longer is never treated as better.
 *
 * Competitors are always selected for ONE search query (never mixed across
 * queries) and, when a SERP snapshot is used, for the configured location,
 * language, and device. The weekly `compare` stage runs this for the top
 * researched candidates, persists the result (competitive_comparisons), and
 * runs the optional synthesis when a reasoning model and budget allow.
 *
 * Competitor text is untrusted data. It never becomes instructions; the
 * optional LLM synthesis passes it only inside evidence items marked
 * `scraped_untrusted`.
 */

export const COMPETITIVE_VERSION = 'competitive@1.1.0';
export const SERP_SYNTHESIS_PROMPT_ID = 'analysis.serp-synthesis';

/** Buyer concerns compared on every page (spec section 19). Detected by keyword heuristics, never scored as ranking causes. */
export const BUYER_CONCERN_SIGNALS = ['pricing', 'shipping', 'returns', 'warranty', 'objections'] as const;
export type BuyerConcernSignal = (typeof BUYER_CONCERN_SIGNALS)[number];
export type ComparedSignal = 'examples' | 'tools' | 'originalData' | 'evidence' | 'faq' | 'freshness' | BuyerConcernSignal;

export type PageTypeGuess = 'article' | 'product' | 'category' | 'tool' | 'offer' | 'comparison' | 'list' | 'faq' | 'other';

export interface SignalPresence {
  present: boolean | null;
  evidence: string[];
}

export interface PageFeatures {
  url: string;
  crawlResultId: string;
  fetchedAt: string;
  statusCode: number | null;
  accessible: boolean;
  inaccessibleReason: string | null;
  title: string | null;
  headings: Heading[];
  /** Reported for context only; never scored as "better". */
  wordCount: number | null;
  textAvailable: boolean;
  pageType: { guess: PageTypeGuess; signals: string[] };
  intentSignals: string[];
  topicTerms: string[];
  signals: {
    examples: SignalPresence;
    tools: SignalPresence;
    originalData: SignalPresence;
    evidence: SignalPresence & { externalLinks: number | null };
    freshness: { dateModified: string | null; datePublished: string | null; visibleUpdated: string | null };
    faq: SignalPresence;
    /** Buyer concerns addressed on the page (keyword heuristics over title, headings, and text). */
    buyerConcerns: Record<BuyerConcernSignal, SignalPresence>;
  };
  structuredDataTypes: string[];
}

/** The localized SERP a comparison is scoped to (configured location, language, device). */
export interface SerpScope {
  locationCode?: number | null;
  languageCode?: string | null;
  device?: string | null;
}

export interface ComparisonInputs {
  version: string;
  query: string | null;
  ourPage: PageFeatures | null;
  competitors: PageFeatures[];
  inaccessibleCompetitors: Array<{ url: string; reason: string }>;
  topicCoverage: {
    consensusTopics: Array<{ topic: string; competitorCount: number; weCover: boolean | null }>;
    gapTopics: string[];
    ourUniqueTopics: string[];
  };
  signalComparison: Array<{ signal: ComparedSignal; ours: boolean | null; competitorsWith: number; competitorsTotal: number }>;
  pageTypeMix: Record<string, number>;
  intentAlignment: { ours: PageTypeGuess | null; dominantCompetitor: PageTypeGuess | null; aligned: boolean | null };
  ourAdvantages: string[];
  gaps: string[];
  caveats: string[];
  /**
   * Set by buildComparisonInputs: any compared page comes from a synthetic
   * crawl (fixture/demo transport), the SERP snapshot is sandbox data, or the
   * context is synthetic. Differences are then SYNTHETIC, never OBSERVED.
   */
  synthetic?: boolean;
  /** Set by buildComparisonInputs: how the competitor pages were selected (one query only). */
  selection?: {
    method: 'result_ids' | 'urls' | 'serp_snapshot' | 'query_tagged_crawl' | 'latest_query_tagged_crawl' | 'none';
    serpSnapshot: { id: string; collectedAt: string; locationCode: number | null; languageCode: string | null; device: string; isSandbox: boolean } | null;
    scope: SerpScope | null;
  };
}

const STOP = new Set(
  'about above after again also and any are because been before being between both but can could does doing down during each every few for from further have having here how into its just more most much must never nor not now off once only other our ours out over own same should some such than that the their them then there these they this those through too under until very was were what when where which while who whom why will with would you your yours guide best what how vs versus review reviews complete ultimate introduction conclusion summary overview table contents faq faqs frequently asked questions'.split(
    ' ',
  ),
);

function topicTermsFromHeadings(headings: Heading[]): string[] {
  const terms = new Set<string>();
  for (const h of headings) {
    if (h.level < 2 || h.level > 3) continue;
    for (const t of h.text.normalize('NFKC').toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (t.length >= 4 && !STOP.has(t) && !/^\d+$/.test(t)) terms.add(t);
    }
  }
  return [...terms].sort();
}

function find(text: string, re: RegExp, max = 3): string[] {
  const out: string[] = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) && out.length < max) {
    const start = Math.max(0, m.index - 40);
    out.push(text.slice(start, m.index + m[0].length + 40).replace(/\s+/g, ' ').trim());
  }
  return out;
}

const RE = {
  examples: /\b(for example|for instance|e\.g\.|example:|case study|worked example|sample)\b/i,
  tools: /\b(calculator|template|generator|checklist download|interactive|estimator|configurator|planner|tool)\b/i,
  originalData: /\b(we surveyed|our survey|our data|our research|we analy[sz]ed|we tested|our tests?|our study|respondents|original research|dataset we)\b/i,
  citations: /\b(according to|source:|sources:|study by|research by|cited|reference[sd]?:)\b/i,
  updated: /\b(updated|last updated|reviewed)\s*(on|:)?\s*(\d{4}-\d{2}-\d{2}|\w+ \d{1,2},? \d{4}|\d{1,2} \w+ \d{4})/i,
  pricing: /\b(price|pricing|per month|\/mo|buy now|add to cart|free trial|get a quote|book a demo)\b/i,
  comparison: /\b(vs\.?|versus|compared to|comparison|alternatives?)\b/i,
  howto: /\b(how to|step \d|step-by-step|steps)\b/i,
};

/** Buyer-concern heuristics (English keyword rules; a miss means "not detected", not "absent"). */
const BUYER_RE: Record<BuyerConcernSignal, RegExp> = {
  pricing: /\b(prices?|pricing|costs?|per (month|year|user|seat)|\/mo|free trial|discounts?|quotes?|plans and pricing|how much)\b/i,
  shipping: /\b(shipping|delivery|delivered|dispatch(ed)?|ships (in|within)|lead times?|free returns and shipping|courier)\b/i,
  returns: /\b(return policy|returns|refunds?|money[- ]back|cancel anytime|cancellation policy|exchanges?)\b/i,
  warranty: /\b(warrant(y|ies)|guarantee[sd]?|guaranty)\b/i,
  objections: /\b(is it worth|worth (it|the (money|price))|downsides?|drawbacks?|pros and cons|disadvantages?|limitations|common concerns?|objections?|who (it|this) is not for|not (right|suitable) for)\b/i,
};

const BUYER_LABEL: Record<BuyerConcernSignal, string> = {
  pricing: 'pricing/cost information',
  shipping: 'shipping/delivery information',
  returns: 'returns/refund information',
  warranty: 'warranty/guarantee information',
  objections: 'answers to buyer objections (downsides, limitations, who it is not for)',
};

/**
 * Deterministic page-type guess from structured data, URL, and wording
 * (also used by `pages infer-types`, recorded as page_type_source 'inferred').
 */
export function guessPageType(row: Pick<CrawlResultRow, 'final_url' | 'requested_url' | 'title' | 'headings_json' | 'structured_data_json'>, text: string | null): { guess: PageTypeGuess; signals: string[] } {
  const url = row.final_url ?? row.requested_url;
  const headingText = parseHeadings(row.headings_json).map((h) => h.text).join('\n');
  const hay = `${row.title ?? ''}\n${headingText}\n${text ?? ''}`;
  const sd = structuredDataTypes(row.structured_data_json);
  const types = sd.types.map((t) => t.toLowerCase());
  const u = url.toLowerCase();
  const signals: string[] = [];
  let guess: PageTypeGuess = 'other';
  if (types.includes('product') || types.includes('offer')) {
    guess = 'product';
    signals.push('structured data Product/Offer');
  } else if (types.includes('softwareapplication') || types.includes('webapplication')) {
    guess = 'tool';
    signals.push('structured data SoftwareApplication/WebApplication');
  } else if (types.includes('faqpage')) {
    guess = 'faq';
    signals.push('structured data FAQPage');
  } else if (types.includes('article') || types.includes('blogposting') || types.includes('newsarticle') || types.includes('howto')) {
    guess = 'article';
    signals.push('structured data Article/BlogPosting/HowTo');
  } else if (types.includes('itemlist') || types.includes('collectionpage')) {
    guess = 'category';
    signals.push('structured data ItemList/CollectionPage');
  }
  if (guess === 'other') {
    if (RE.comparison.test(hay) && /\b(vs|versus|alternatives?)\b/i.test(`${row.title ?? ''} ${u}`)) {
      guess = 'comparison';
      signals.push('comparison wording in title/URL');
    } else if (/\/(blog|articles?|guides?|news|learn)\//.test(u)) {
      guess = 'article';
      signals.push('URL path suggests an article');
    } else if (/\/(pricing|plans|product|products|shop|services?)(\/|$)/.test(u) || RE.pricing.test(hay)) {
      guess = 'offer';
      signals.push('pricing/purchase wording or URL');
    } else if (/^\s*(\d+|top \d+)\b/i.test(row.title ?? '')) {
      guess = 'list';
      signals.push('numbered-list title');
    }
  }
  return { guess, signals };
}

export function extractFeatures(row: CrawlResultRow, text: string | null): PageFeatures {
  const url = row.final_url ?? row.requested_url;
  const accessible = row.blocked_reason === null && row.status_code !== null && row.status_code >= 200 && row.status_code < 300;
  const headings = parseHeadings(row.headings_json);
  const sd = structuredDataTypes(row.structured_data_json);
  const headingText = headings.map((h) => h.text).join('\n');
  const hay = `${row.title ?? ''}\n${headingText}\n${text ?? ''}`;
  const has = (re: RegExp) => (text === null && !re.test(`${row.title ?? ''}\n${headingText}`) ? null : re.test(hay));
  const intentSignals: string[] = [];
  if (RE.pricing.test(hay)) intentSignals.push('pricing_or_purchase');
  if (RE.comparison.test(hay)) intentSignals.push('comparison');
  if (RE.howto.test(hay)) intentSignals.push('how_to');
  if (headings.some((h) => h.text.trim().endsWith('?'))) intentSignals.push('question_answer');

  const types = sd.types.map((t) => t.toLowerCase());
  const pageType = guessPageType(row, text);
  const buyerConcerns = Object.fromEntries(
    BUYER_CONCERN_SIGNALS.map((k) => [k, { present: has(BUYER_RE[k]), evidence: find(hay, BUYER_RE[k]) }]),
  ) as Record<BuyerConcernSignal, SignalPresence>;
  const updated = text ? RE.updated.exec(text) : null;
  return {
    url,
    crawlResultId: row.id,
    fetchedAt: row.fetched_at,
    statusCode: row.status_code,
    accessible,
    inaccessibleReason: accessible ? null : row.blocked_reason ?? (row.status_code ? `HTTP ${row.status_code}` : row.error ?? 'not fetched'),
    title: row.title,
    headings,
    wordCount: row.word_count,
    textAvailable: text !== null,
    pageType,
    intentSignals,
    topicTerms: topicTermsFromHeadings(headings),
    signals: {
      examples: { present: has(RE.examples), evidence: text ? find(text, RE.examples) : [] },
      tools: { present: sd.types.some((t) => /SoftwareApplication|WebApplication/i.test(t)) ? true : has(RE.tools), evidence: find(hay, RE.tools) },
      originalData: { present: has(RE.originalData), evidence: text ? find(text, RE.originalData) : [] },
      evidence: { present: (row.links_external ?? 0) > 0 || (has(RE.citations) ?? false) ? true : text === null && row.links_external === null ? null : false, evidence: text ? find(text, RE.citations) : [], externalLinks: row.links_external },
      freshness: { dateModified: sd.dateModified, datePublished: sd.datePublished, visibleUpdated: updated ? updated[3] ?? null : null },
      faq: { present: types.includes('faqpage') || headings.filter((h) => h.text.trim().endsWith('?')).length >= 2, evidence: headings.filter((h) => h.text.trim().endsWith('?')).slice(0, 3).map((h) => h.text) },
      buyerConcerns,
    },
    structuredDataTypes: sd.types,
  };
}

function freshest(f: PageFeatures): string | null {
  const c = [f.signals.freshness.dateModified, f.signals.freshness.visibleUpdated, f.signals.freshness.datePublished].filter((x): x is string => !!x).map((x) => Date.parse(x)).filter((x) => !Number.isNaN(x));
  return c.length ? new Date(Math.max(...c)).toISOString().slice(0, 10) : null;
}

/** Pure comparison of already-extracted features. */
export function compareFeatures(ours: PageFeatures | null, competitorsAll: PageFeatures[], query: string | null): ComparisonInputs {
  const competitors = competitorsAll.filter((c) => c.accessible);
  const inaccessible = competitorsAll.filter((c) => !c.accessible).map((c) => ({ url: c.url, reason: c.inaccessibleReason ?? 'not accessible' }));
  const total = competitors.length;
  const counts = new Map<string, number>();
  for (const c of competitors) for (const t of new Set(c.topicTerms)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const threshold = Math.max(2, Math.ceil(total / 2));
  const ourTerms = new Set(ours?.topicTerms ?? []);
  const ourText = ours ? `${ours.title ?? ''} ${ours.headings.map((h) => h.text).join(' ')}`.toLocaleLowerCase() : '';
  const consensus = [...counts.entries()]
    .filter(([, n]) => n >= threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([topic, n]) => ({ topic, competitorCount: n, weCover: ours ? ourTerms.has(topic) || ourText.includes(topic) : null }));
  const gapTopics = consensus.filter((c) => c.weCover === false).map((c) => c.topic);
  const ourUnique = ours && total > 0 ? [...ourTerms].filter((t) => !counts.has(t)) : [];

  const sig = (k: 'examples' | 'tools' | 'originalData' | 'evidence' | 'faq') => ({
    signal: k,
    ours: ours ? ours.signals[k].present : null,
    competitorsWith: competitors.filter((c) => c.signals[k].present === true).length,
    competitorsTotal: total,
  });
  // Buyer concerns: pages extracted before this signal existed (no buyerConcerns) count as unknown.
  const buyer = (f: PageFeatures, k: BuyerConcernSignal): boolean | null => f.signals.buyerConcerns?.[k]?.present ?? null;
  const buyerSig = (k: BuyerConcernSignal) => ({ signal: k, ours: ours ? buyer(ours, k) : null, competitorsWith: competitors.filter((c) => buyer(c, k) === true).length, competitorsTotal: total });
  const ourFresh = ours ? freshest(ours) : null;
  const compFresh = competitors.map(freshest).filter((x): x is string => !!x);
  const newerThanOurs = ourFresh ? compFresh.filter((d) => d > ourFresh).length : compFresh.length;
  const signalComparison: ComparisonInputs['signalComparison'] = [
    sig('examples'),
    sig('tools'),
    sig('originalData'),
    sig('evidence'),
    sig('faq'),
    { signal: 'freshness', ours: ourFresh !== null ? true : ours ? false : null, competitorsWith: compFresh.length, competitorsTotal: total },
    ...BUYER_CONCERN_SIGNALS.map(buyerSig),
  ];

  const pageTypeMix: Record<string, number> = {};
  for (const c of competitors) pageTypeMix[c.pageType.guess] = (pageTypeMix[c.pageType.guess] ?? 0) + 1;
  const dominant = (Object.entries(pageTypeMix).sort((a, b) => b[1] - a[1])[0]?.[0] as PageTypeGuess | undefined) ?? null;
  const intentAlignment = { ours: ours?.pageType.guess ?? null, dominantCompetitor: dominant, aligned: ours && dominant ? ours.pageType.guess === dominant : null };

  const advantages: string[] = [];
  const gaps: string[] = [];
  const label: Record<string, string> = { examples: 'concrete examples', tools: 'a tool/template/calculator', originalData: 'original data or first-hand testing', evidence: 'cited sources or external evidence links', faq: 'question-and-answer sections', ...BUYER_LABEL };
  for (const s of signalComparison) {
    if (s.signal === 'freshness' || total === 0) continue;
    if (s.ours === true && s.competitorsWith < Math.ceil(total / 2)) advantages.push(`Our page has ${label[s.signal]}; only ${s.competitorsWith} of ${total} compared competitor pages do.`);
    if (s.ours === false && s.competitorsWith >= Math.ceil(total / 2)) gaps.push(`${s.competitorsWith} of ${total} compared competitor pages show ${label[s.signal]}; ours does not (observed difference, not a ranking cause).`);
  }
  if (ourUnique.length) advantages.push(`Our headings cover topic terms no compared competitor heading covers: ${ourUnique.slice(0, 8).join(', ')}.`);
  if (ourFresh && total && newerThanOurs === 0 && compFresh.length) advantages.push(`Our page shows a more recent date (${ourFresh}) than every dated competitor page.`);
  if (ourFresh && newerThanOurs > 0) gaps.push(`${newerThanOurs} competitor page(s) show a more recent date than ours (${ourFresh}); dates alone do not show useful updates.`);
  if (gapTopics.length) gaps.push(`Topic terms in most compared competitor headings but absent from our title/headings: ${gapTopics.slice(0, 8).join(', ')} (research these topics; do not copy headings).`);
  if (intentAlignment.aligned === false) gaps.push(`Page-type mismatch: most compared results look like "${dominant}" pages; ours looks like "${intentAlignment.ours}". Check whether the intent matches before editing.`);

  const caveats = [
    'Observed differences are inputs for a human/analyst; no feature is claimed to cause any ranking.',
    'Word count is reported only for context; longer content is not treated as better.',
    'Gap topics are research prompts, not headings to copy; copying competitor structure is not recommended.',
    'Competitor pages are untrusted third-party content captured at the listed fetch time.',
    'Signals (including buyer concerns: pricing, shipping, returns, warranty, objections) are keyword heuristics over the crawled text; "not detected" does not prove absence.',
  ];
  if (inaccessible.length) caveats.push(`${inaccessible.length} competitor page(s) were not accessible (e.g. robots, login, access denied) and were not compared; access barriers were not bypassed.`);
  if (ours && !ours.textAvailable) caveats.push('Our page text was unavailable; signals rely on title, headings, and structured data only.');
  if (total === 0) caveats.push('No accessible competitor pages: no comparison was made.');
  return {
    version: COMPETITIVE_VERSION,
    query,
    ourPage: ours,
    competitors,
    inaccessibleCompetitors: inaccessible,
    topicCoverage: { consensusTopics: consensus, gapTopics, ourUniqueTopics: ourUnique },
    signalComparison,
    pageTypeMix,
    intentAlignment,
    ourAdvantages: advantages,
    gaps,
    caveats,
  };
}

export interface BuildComparisonOptions {
  ourUrl: string;
  /** The ONE search query the competitors were selected for (competitors are never mixed across queries). */
  query?: string | null;
  competitorResultIds?: string[];
  competitorUrls?: string[];
  maxCompetitors?: number;
  /** Localized SERP scope: the snapshot must match these (configured location, language, device) when given. */
  serp?: SerpScope | null;
  /** Accept DataForSEO sandbox snapshots (synthetic demo/test contexts only); the result is then synthetic. */
  allowSandbox?: boolean;
  /** The context is synthetic (AppContext.synthetic): the result is synthetic. */
  synthetic?: boolean;
}

/** Latest competitor crawl result per URL among results tagged with exactly this query (the crawler records the query). */
function queryTaggedCompetitorRows(db: Db, siteId: string, query: string, max: number): CrawlResultRow[] {
  const rows = db.all<CrawlResultRow>(
    `SELECT ${CRAWL_RESULT_COLS} FROM crawl_results cr JOIN crawls c ON c.id = cr.crawl_id
      WHERE cr.site_id = ? AND c.kind = 'competitor' AND cr.extraction_json IS NOT NULL AND json_valid(cr.extraction_json) AND json_extract(cr.extraction_json, '$.query') = ?
      ORDER BY cr.fetched_at DESC, cr.id DESC`,
    [siteId, query],
  );
  const seen = new Set<string>();
  const out: CrawlResultRow[] = [];
  for (const r of rows) {
    const k = normalizeUrl(r.requested_url)?.url ?? r.requested_url;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Build comparison inputs from the database. Competitor pages are selected
 * (in order): explicit crawl result ids, explicit URLs, or for ONE query:
 * the latest SERP snapshot of that query matching the given SERP scope
 * (location, language, device; sandbox snapshots only when allowed), else
 * the competitor crawl results tagged with that query. Without a query, the
 * query of the most recent query-tagged competitor crawl result is used, so
 * competitors from different queries are never mixed.
 */
export function buildComparisonInputs(db: Db, text: TextStore | null, siteId: string, opts: BuildComparisonOptions): ComparisonInputs {
  const max = opts.maxCompetitors ?? 10;
  const ourNorm = normalizeUrl(opts.ourUrl)?.url ?? opts.ourUrl;
  const ourRow = latestCrawlResultForUrl(db, siteId, ourNorm, ['own_site', 'single_page']) ?? latestCrawlResultForUrl(db, siteId, opts.ourUrl, ['own_site', 'single_page']);
  const ours = ourRow ? extractFeatures(ourRow, loadCrawlText(text, ourRow.text_ref)) : null;
  let query = opts.query?.trim() ? opts.query.trim() : null;
  let rows: CrawlResultRow[] = [];
  let method: NonNullable<ComparisonInputs['selection']>['method'] = 'none';
  let snapshot: NonNullable<ComparisonInputs['selection']>['serpSnapshot'] = null;
  const extraCaveats: string[] = [];
  const scope = opts.serp ?? null;
  if (opts.competitorResultIds?.length) {
    method = 'result_ids';
    rows = opts.competitorResultIds
      .map((id) => db.get<CrawlResultRow>(`SELECT ${CRAWL_RESULT_COLS} FROM crawl_results cr JOIN crawls c ON c.id = cr.crawl_id WHERE cr.site_id = ? AND cr.id = ? AND c.kind = 'competitor'`, [siteId, id]))
      .filter((r): r is CrawlResultRow => !!r);
  } else if (opts.competitorUrls?.length) {
    method = 'urls';
    rows = opts.competitorUrls.map((u) => latestCrawlResultForUrl(db, siteId, u, ['competitor'])).filter((r): r is CrawlResultRow => !!r);
  } else {
    if (!query) {
      // No query: scope to the query of the most recent query-tagged competitor result (never mix queries).
      const latest = db.get<{ q: string }>(
        `SELECT json_extract(cr.extraction_json, '$.query') AS q FROM crawl_results cr JOIN crawls c ON c.id = cr.crawl_id
          WHERE cr.site_id = ? AND c.kind = 'competitor' AND cr.extraction_json IS NOT NULL AND json_valid(cr.extraction_json) AND json_extract(cr.extraction_json, '$.query') IS NOT NULL
          ORDER BY cr.fetched_at DESC, cr.id DESC LIMIT 1`,
        [siteId],
      );
      if (latest?.q) {
        query = latest.q;
        method = 'latest_query_tagged_crawl';
        extraCaveats.push(`No query was given: the comparison is scoped to the query of the most recent competitor crawl ("${query}") so competitors of different queries are never mixed.`);
      } else {
        extraCaveats.push('No query was given and no competitor crawl result is tagged with a query: no competitors were selected (competitors of different queries are never mixed).');
      }
    }
    if (query && method === 'none') {
      const where = ['site_id = ?', 'query = ?'];
      const params: unknown[] = [siteId, query];
      if (!opts.allowSandbox) where.push('is_sandbox = 0');
      if (scope?.locationCode !== undefined && scope.locationCode !== null) {
        where.push('location_code = ?');
        params.push(scope.locationCode);
      }
      if (scope?.languageCode) {
        where.push('language_code = ?');
        params.push(scope.languageCode);
      }
      if (scope?.device) {
        where.push('device = ?');
        params.push(scope.device);
      }
      const snap = db.get<{ id: string; collected_at: string; location_code: number | null; language_code: string | null; device: string; is_sandbox: number }>(
        `SELECT id, collected_at, location_code, language_code, device, is_sandbox FROM serp_snapshots WHERE ${where.join(' AND ')} ORDER BY collected_at DESC, id DESC LIMIT 1`,
        params,
      );
      if (snap) {
        method = 'serp_snapshot';
        snapshot = { id: snap.id, collectedAt: snap.collected_at, locationCode: snap.location_code, languageCode: snap.language_code, device: snap.device, isSandbox: snap.is_sandbox === 1 };
        const urls = db
          .all<{ url: string }>("SELECT url FROM serp_results WHERE snapshot_id = ? AND site_id = ? AND is_own_site = 0 AND url IS NOT NULL AND result_type = 'organic' ORDER BY rank_absolute LIMIT ?", [snap.id, siteId, max])
          .map((r) => r.url);
        rows = urls.map((u) => latestCrawlResultForUrl(db, siteId, u, ['competitor'])).filter((r): r is CrawlResultRow => !!r);
        if (snapshot.isSandbox) extraCaveats.push('The SERP snapshot is DataForSEO sandbox/fixture data (synthetic), not a real search result.');
      } else {
        rows = queryTaggedCompetitorRows(db, siteId, query, max);
        method = rows.length ? 'query_tagged_crawl' : 'none';
        const scoped = [scope?.locationCode != null ? `location ${scope.locationCode}` : null, scope?.languageCode ? `language ${scope.languageCode}` : null, scope?.device ? `device ${scope.device}` : null].filter(Boolean).join(', ');
        extraCaveats.push(`No${opts.allowSandbox ? '' : ' live'} SERP snapshot for "${query}"${scoped ? ` (${scoped})` : ''}: ${rows.length ? 'competitor pages crawled for this query were used instead; their SERP locality is not verified' : 'no competitor pages were selected'}.`);
      }
    } else if (query && method === 'latest_query_tagged_crawl') {
      rows = queryTaggedCompetitorRows(db, siteId, query, max);
    }
  }
  const selected = rows.slice(0, max).filter((r) => (normalizeUrl(r.final_url ?? r.requested_url)?.url ?? '') !== ourNorm);
  const competitors = selected.map((r) => extractFeatures(r, loadCrawlText(text, r.text_ref)));
  const resultIds = [...(ourRow ? [ourRow.id] : []), ...selected.map((r) => r.id)];
  const syntheticCrawl = resultIds.length
    ? (db.get<{ s: number | null }>(`SELECT MAX(c.is_synthetic) AS s FROM crawl_results cr JOIN crawls c ON c.id = cr.crawl_id WHERE cr.site_id = ? AND cr.id IN (${resultIds.map(() => '?').join(', ')})`, [siteId, ...resultIds])?.s ?? 0) === 1
    : false;
  const out = compareFeatures(ours, competitors, query);
  out.caveats.push(...extraCaveats);
  out.synthetic = opts.synthetic === true || syntheticCrawl || snapshot?.isSandbox === true;
  if (out.synthetic) out.caveats.push('SYNTHETIC: the compared pages or the SERP come from fixture/demo/sandbox data; differences are not observations of real pages.');
  out.selection = { method, serpSnapshot: snapshot, scope };
  return out;
}

// ---------------------------------------------------------------------------
// Persistence (competitive_comparisons; grain: site, run, query, our page)
// ---------------------------------------------------------------------------

export interface ComparisonSynthesisRecord {
  status: 'ok' | 'skipped' | 'failed';
  /** Why the synthesis was skipped or failed ("synthesis skipped: <reason>"). */
  reason: string | null;
  synthesis?: SerpSynthesis | null;
  callId?: string | null;
  promptVersion?: string | null;
  model?: string | null;
}

export interface ComparisonRecordInput {
  siteId: string;
  runId: string;
  jobId?: string | null;
  query: string;
  pageId: string | null;
  pageUrl: string;
  opportunityId?: string | null;
  inputs: ComparisonInputs;
  synthesis: ComparisonSynthesisRecord;
  now: Date;
}

/** Compact, JSON-safe summary of the deterministic comparison (no page text). */
export function comparisonSummary(inputs: ComparisonInputs): Record<string, unknown> {
  return {
    version: inputs.version,
    query: inputs.query,
    ourPage: inputs.ourPage ? { url: inputs.ourPage.url, crawlResultId: inputs.ourPage.crawlResultId, fetchedAt: inputs.ourPage.fetchedAt, pageType: inputs.ourPage.pageType.guess, textAvailable: inputs.ourPage.textAvailable } : null,
    competitors: inputs.competitors.map((c) => ({ url: c.url, crawlResultId: c.crawlResultId, fetchedAt: c.fetchedAt, pageType: c.pageType.guess })),
    inaccessibleCompetitors: inputs.inaccessibleCompetitors,
    signalComparison: inputs.signalComparison,
    pageTypeMix: inputs.pageTypeMix,
    intentAlignment: inputs.intentAlignment,
    topicCoverage: { consensusTopics: inputs.topicCoverage.consensusTopics.slice(0, 20), gapTopics: inputs.topicCoverage.gapTopics.slice(0, 20), ourUniqueTopics: inputs.topicCoverage.ourUniqueTopics.slice(0, 20) },
    selection: inputs.selection ?? null,
    synthetic: inputs.synthetic === true,
  };
}

/**
 * Persist one comparison (idempotent per grain: a rerun of the same run
 * replaces its own row). Returns the row id.
 */
export function persistComparison(db: Db, r: ComparisonRecordInput): string {
  const id = newId('cmp');
  const snap = r.inputs.selection?.serpSnapshot ?? null;
  const scope = r.inputs.selection?.scope ?? null;
  db.transaction(() => {
    db.run('DELETE FROM competitive_comparisons WHERE site_id = ? AND run_id = ? AND query = ? AND COALESCE(page_id, \'\') = ?', [r.siteId, r.runId, r.query, r.pageId ?? '']);
    db.run(
      `INSERT INTO competitive_comparisons (id, site_id, run_id, job_id, query, page_id, page_url, opportunity_id, serp_snapshot_id, location_code, language_code, device,
         competitors_compared, competitors_inaccessible, our_crawl_result_id, inputs_json, our_advantages_json, gaps_json, caveats_json,
         synthesis_status, synthesis_reason, synthesis_json, llm_call_id, prompt_version, model_id, comparison_version, is_synthetic, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        r.siteId,
        r.runId,
        r.jobId ?? null,
        r.query,
        r.pageId,
        r.pageUrl,
        r.opportunityId ?? null,
        snap?.id ?? null,
        snap?.locationCode ?? scope?.locationCode ?? null,
        snap?.languageCode ?? scope?.languageCode ?? null,
        snap?.device ?? scope?.device ?? null,
        r.inputs.competitors.length,
        r.inputs.inaccessibleCompetitors.length,
        r.inputs.ourPage?.crawlResultId ?? null,
        JSON.stringify(comparisonSummary(r.inputs)),
        JSON.stringify(r.inputs.ourAdvantages),
        JSON.stringify(r.inputs.gaps),
        JSON.stringify(r.inputs.caveats),
        r.synthesis.status,
        r.synthesis.reason,
        r.synthesis.synthesis ? JSON.stringify(r.synthesis.synthesis) : null,
        r.synthesis.callId ?? null,
        r.synthesis.promptVersion ?? null,
        r.synthesis.model ?? null,
        r.inputs.version,
        r.inputs.synthetic ? 1 : 0,
        r.now.toISOString(),
      ],
    );
  });
  return id;
}

// ---------------------------------------------------------------------------
// Optional LLM synthesis (reasoning tier)
// ---------------------------------------------------------------------------

const labelEnum = z.enum(['OBSERVED', 'INFERRED', 'HYPOTHESIS']);
export const serpSynthesisSchema = z.object({
  summary: z.string().max(1500),
  intentAssessment: z.object({ text: z.string().max(600), label: labelEnum }),
  ourAdvantages: z.array(z.object({ text: z.string().max(400), label: labelEnum })).max(8),
  gapsWorthResearching: z.array(z.object({ topic: z.string().max(120), rationale: z.string().max(400), label: labelEnum })).max(8),
  caveats: z.array(z.string().max(300)).max(8),
});
export type SerpSynthesis = z.infer<typeof serpSynthesisSchema>;

export type SynthesisResult = { ok: true; synthesis: SerpSynthesis; callId: string; model: string; promptVersion: string } | { ok: false; status: LlmFailureStatus | 'no_competitors'; reason: string };

function featureSummary(f: PageFeatures): string {
  return JSON.stringify({
    url: f.url,
    fetchedAt: f.fetchedAt,
    title: f.title,
    headings: f.headings.slice(0, 40).map((h) => `h${h.level}: ${h.text.slice(0, 160)}`),
    pageType: f.pageType,
    intentSignals: f.intentSignals,
    signals: {
      examples: f.signals.examples.present,
      tools: f.signals.tools.present,
      originalData: f.signals.originalData.present,
      evidence: f.signals.evidence.present,
      faq: f.signals.faq.present,
      freshness: f.signals.freshness,
      buyerConcerns: Object.fromEntries(BUYER_CONCERN_SIGNALS.map((k) => [k, f.signals.buyerConcerns?.[k]?.present ?? null])),
    },
    wordCountContextOnly: f.wordCount,
  });
}

/**
 * Optional synthesis of the deterministic comparison by the reasoning tier.
 * Numbers and signal tables are computed in code and passed as variables;
 * page content is passed only as evidence: competitor content AND our own
 * crawled content as `scraped_untrusted` (or `synthetic` for demo data). The
 * analysed search query is searcher-typed text and is passed as evidence item
 * `query` (`user_reported`, or `synthetic` for demo data), never as a variable.
 */
export async function synthesizeComparison(llm: LlmClient, inputs: ComparisonInputs, opts: { siteId: string; runId: string; maxOutputTokens?: number; synthetic?: boolean }): Promise<SynthesisResult> {
  if (inputs.competitors.length === 0) return { ok: false, status: 'no_competitors', reason: 'no accessible competitor pages to synthesize' };
  if (!llm.isConfigured('reasoning')) return { ok: false, status: 'not_configured', reason: 'reasoning model tier is not configured; deterministic comparison inputs are still available' };
  const evidence: EvidenceItem[] = [];
  // The analysed search query is text typed by searchers (a Search Console query in the weekly
  // `compare` stage): it is untrusted data, so it travels as an evidence item inside the delimited
  // data blocks, never as a template variable in the instruction part of the prompt.
  evidence.push({
    id: 'query',
    label: 'analysed search query (typed by searchers, e.g. a Search Console query; untrusted text)',
    text: JSON.stringify({ query: inputs.query ?? null, ...(inputs.query ? {} : { note: 'no query was specified for this comparison' }) }),
    trustClass: opts.synthetic ? 'synthetic' : 'user_reported',
  });
  // Our page's crawled text/headings are page content (it can contain third-party or injected text), not a measurement.
  if (inputs.ourPage) evidence.push({ id: 'our-page', label: 'our page (own-site crawl; page content is untrusted data)', text: featureSummary(inputs.ourPage), trustClass: opts.synthetic ? 'synthetic' : 'scraped_untrusted', url: inputs.ourPage.url, retrievedAt: inputs.ourPage.fetchedAt });
  inputs.competitors.forEach((c, i) => evidence.push({ id: `competitor-${i + 1}`, label: 'competitor page (third-party, untrusted)', text: featureSummary(c), trustClass: 'scraped_untrusted', url: c.url, retrievedAt: c.fetchedAt }));
  // Code-computed comparison, but it contains terms derived from competitor headings: passed as untrusted data.
  evidence.push({
    id: 'deterministic-comparison',
    label: 'deterministic comparison computed in code (contains terms derived from untrusted competitor headings)',
    text: JSON.stringify({ consensusTopics: inputs.topicCoverage.consensusTopics.slice(0, 20), gapTopics: inputs.topicCoverage.gapTopics.slice(0, 20), ourUniqueTopics: inputs.topicCoverage.ourUniqueTopics.slice(0, 20), ourAdvantages: inputs.ourAdvantages, gaps: inputs.gaps, caveats: inputs.caveats }),
    trustClass: 'scraped_untrusted',
  });
  const res = await llm.structured<SerpSynthesis>({
    siteId: opts.siteId,
    runId: opts.runId,
    role: 'analyst',
    tier: 'reasoning',
    promptId: SERP_SYNTHESIS_PROMPT_ID,
    // Variables hold only code-computed counts/enums; no page text and no query text (evidence item `query`).
    variables: {
      competitorCount: inputs.competitors.length,
      signalTable: JSON.stringify(inputs.signalComparison),
      pageTypeMix: JSON.stringify(inputs.pageTypeMix),
      ourPageType: inputs.intentAlignment.ours ?? 'unknown',
    },
    evidence,
    schema: serpSynthesisSchema,
    schemaName: 'SerpSynthesis',
    ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
  });
  if (!res.ok) return { ok: false, status: res.status, reason: res.reason };
  return { ok: true, synthesis: res.value, callId: res.callId, model: res.model, promptVersion: res.promptVersion };
}
