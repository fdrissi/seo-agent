import type { AppContext } from '../app/context.js';
import {
  countEmptyHeadings,
  crawlResultById,
  crawlResultExtraction,
  crawlResultsForCrawl,
  latestCrawlResultForUrl,
  latestOwnCrawlId,
  loadCrawlText,
  parseHeadings,
  structuredDataTypes,
  topGscQueriesForPage,
  type Heading,
  type PageQueryRow,
} from '../seo/crawl-data.js';
import { normalizeUrl } from '../seo/url.js';
import { searchEligibilityForResult, type SearchEligibility } from './eligibility.js';

/**
 * Page-level AEO assessment (spec section 17: clear answers, descriptive
 * headings, self-contained sections, useful evidence, crawl/index/snippet
 * eligibility) over STORED crawl results.
 *
 * Every check is a deterministic HEURISTIC over the crawl snapshot: editorial
 * signals for a human reviewer, not Google ranking rules and not a prediction
 * that a page will be cited by an AI feature or shown as a rich result.
 * Phrase patterns (back-references, citation wording, question words) are
 * English; on other languages they under-report. Factual consistency is not
 * assessed here (drafts go through the content quality gates). Search Console
 * query rows omit anonymized queries, so "top queries" are the visible ones.
 */

export const AEO_VERSION = 'aeo-heuristic@1';
export const AEO_LABEL = 'HEURISTIC';

export type AeoCheckStatus = 'ok' | 'review' | 'unknown';

export interface AeoQueryAnswer {
  query: string;
  impressions: number;
  clicks: number;
  terms: string[];
  matchedTerms: string[];
  /** Share of the query's content terms found in the opening window (0..1). */
  coverage: number;
  answeredNearTop: boolean;
}

export interface AeoAnswerCheck {
  status: AeoCheckStatus;
  /** Words of body text (after the H1 when it is found; headings and questions excluded) treated as "near the top". */
  windowWords: number;
  queries: AeoQueryAnswer[];
  source: { property: string; start: string; end: string } | null;
  summary: string;
}

export interface AeoHeadingCheck {
  status: AeoCheckStatus;
  total: number;
  empty: number;
  generic: string[];
  questionHeadings: Array<{ text: string; answered: boolean | null; detail: string }>;
  summary: string;
}

export interface AeoSectionCheck {
  status: AeoCheckStatus;
  sections: number;
  backReferences: Array<{ heading: string | null; phrase: string }>;
  summary: string;
}

export interface AeoEvidenceCheck {
  status: AeoCheckStatus;
  externalLinks: number | null;
  citationLinks: number;
  citationPhrases: string[];
  numericClaims: number;
  referencesSection: boolean;
  dateModified: string | null;
  summary: string;
}

export interface AeoTextAssessment {
  label: typeof AEO_LABEL;
  version: typeof AEO_VERSION;
  answer: AeoAnswerCheck;
  headings: AeoHeadingCheck;
  sections: AeoSectionCheck;
  evidence: AeoEvidenceCheck;
  caveats: string[];
}

export interface AeoAssessment extends AeoTextAssessment {
  url: string;
  resultId: string;
  crawlId: string;
  fetchedAt: string;
  statusCode: number | null;
  title: string | null;
  isSynthetic: boolean;
  /** Crawl / index / snippet / AI-feature eligibility from observed crawl signals (src/crawler/eligibility.ts). */
  eligibility: SearchEligibility | null;
  counts: { ok: number; review: number; unknown: number };
}

export interface AeoPageInput {
  title: string | null;
  headings: Heading[];
  emptyHeadings: number;
  /** Visible text with one block per line (as stored by the crawler); null when unavailable. */
  text: string | null;
  externalLinks: Array<{ href: string; anchor: string | null }> | null;
  externalLinkCount: number | null;
  dateModified: string | null;
  language: string | null;
  /** Top visible Search Console queries for the page; null when there is no query data. */
  topQueries: PageQueryRow[] | null;
  querySource?: { property: string; start: string; end: string } | null;
}

// ---------------------------------------------------------------------------
// Heuristic patterns (English; labelled as such)
// ---------------------------------------------------------------------------

const ANSWER_WINDOW_WORDS = 120;
const ANSWER_COVERAGE = 0.6;

/** Common English function words dropped from queries before matching. */
const STOPWORDS = new Set(
  'a an and are as at be by can could do does for from how i in is it its me my of on or our should the their them there these this to was we what when where which who why will with you your vs versus near best top'.split(' '),
);

const GENERIC_HEADING =
  /^(introduction|intro|overview|summary|conclusion|conclusions|final thoughts|wrapping up|wrap[- ]up|the end|more|more info(rmation)?|details|misc(ellaneous)?|other|others|general|info(rmation)?|content|contents|main|background|basics|the basics|faq|faqs|questions|q ?& ?a|tl;? ?dr|read more|learn more|click here|untitled|heading|title|section|section \d+|part \d+|chapter \d+|step \d+|\d+)$/i;

const QUESTION_HEADING = /\?\s*$|^(how|what|why|when|where|which|who|whom|whose|can|could|should|would|is|are|does|do|did|will)\b/i;

const BACK_REFERENCE =
  /\b(as (?:mentioned|noted|discussed|described|explained|shown|stated|outlined|covered|seen) (?:above|earlier|before|previously)|(?:mentioned|noted|discussed|described|explained|shown|outlined) (?:above|earlier|previously)|see (?:above|the (?:previous|preceding|last) section)|in the (?:previous|preceding|last|above) (?:section|chapter|paragraph)|as we (?:saw|said|discussed|mentioned) (?:above|earlier|before)|the aforementioned|like i said)\b/gi;

const CITATION_PHRASE = /\b(according to|sources?:|cited (?:by|in)|citation|et al\.|peer[- ]reviewed|(?:a|the|this|one) (?:study|survey|report) (?:by|from|of|published)|data (?:from|by|published)|research (?:by|from)|published (?:by|in))/gi;

const NUMERIC_CLAIM = /\b\d+(?:[.,]\d+)?\s?%|\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s?(?:million|billion|thousand)\b/gi;

const REFERENCES_HEADING = /^(references|sources|citations|bibliography|further reading|methodology)$/i;

/** Hosts whose links are sharing/profile links rather than citations. */
const NON_CITATION_HOSTS = /(^|\.)(facebook|twitter|x|linkedin|instagram|youtube|tiktok|pinterest|reddit|whatsapp|t)\.(com|me)$/i;

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function words(s: string): string[] {
  return collapse(s).split(' ').filter(Boolean);
}

function stem(t: string): string {
  return t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t;
}

function terms(s: string): string[] {
  return [
    ...new Set(
      s
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
        .map(stem),
    ),
  ];
}

function firstSentence(text: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(collapse(text));
  return m ? m[1]! : collapse(text);
}

interface Section {
  heading: Heading | null;
  body: string;
}

/** Split visible text into sections at heading lines (headings are matched in document order). */
export function splitSections(text: string, headings: Heading[]): Section[] {
  const lines = text.split('\n').map(collapse).filter(Boolean);
  const sections: Section[] = [{ heading: null, body: '' }];
  let next = 0;
  for (const line of lines) {
    let matched = -1;
    for (let j = next; j < Math.min(headings.length, next + 5); j++) {
      if (collapse(headings[j]!.text).toLowerCase() === line.toLowerCase()) {
        matched = j;
        break;
      }
    }
    if (matched >= 0) {
      sections.push({ heading: headings[matched]!, body: '' });
      next = matched + 1;
      continue;
    }
    const cur = sections[sections.length - 1]!;
    cur.body = cur.body ? `${cur.body}\n${line}` : line;
  }
  return sections;
}

/**
 * The opening window: body text (headings excluded, so a heading that merely
 * repeats the query is not an answer) after the H1 when it is found, else from
 * the start.
 */
function openingWindow(sections: Section[], maxWords: number): string {
  const h1 = sections.findIndex((s) => s.heading?.level === 1);
  const from = h1 >= 0 ? h1 : 0;
  const out: string[] = [];
  for (let i = from; i < sections.length && out.length < maxWords; i++) out.push(...words(sections[i]!.body));
  return out.slice(0, maxWords).join(' ');
}

/** Statements (not questions) of the window: only these can answer a query. */
function statements(window: string): string[] {
  return window.split(/(?<=[.!?])\s+/).filter((s) => !/\?\s*$/.test(s.trim()));
}

function assessAnswer(input: AeoPageInput, sections: Section[]): AeoAnswerCheck {
  const base = { windowWords: ANSWER_WINDOW_WORDS, source: input.querySource ?? null };
  if (!input.text) return { ...base, status: 'unknown', queries: [], summary: 'No stored page text: the opening answer could not be assessed.' };
  if (!input.topQueries?.length) {
    return { ...base, status: 'unknown', queries: [], summary: 'DATA_UNAVAILABLE: no Search Console query rows for this page, so there are no queries to check the opening answer against.' };
  }
  const window = openingWindow(sections, ANSWER_WINDOW_WORDS);
  const stmts = statements(window);
  const windowTerms = new Set(terms(stmts.join(' ')));
  const hasStatement = stmts.some((s) => words(s).length >= 8);
  const queries: AeoQueryAnswer[] = [];
  for (const q of input.topQueries) {
    const t = terms(q.query);
    if (!t.length) continue;
    const matched = t.filter((x) => windowTerms.has(x));
    const coverage = matched.length / t.length;
    queries.push({ query: q.query, impressions: q.impressions, clicks: q.clicks, terms: t, matchedTerms: matched, coverage: Math.round(coverage * 100) / 100, answeredNearTop: hasStatement && coverage >= ANSWER_COVERAGE });
  }
  if (!queries.length) return { ...base, status: 'unknown', queries, summary: 'The top queries have no content terms to match (heuristic).' };
  const answered = queries.filter((q) => q.answeredNearTop).length;
  const status: AeoCheckStatus = answered === queries.length ? 'ok' : 'review';
  return {
    ...base,
    status,
    queries,
    summary:
      status === 'ok'
        ? `The first ${ANSWER_WINDOW_WORDS} words address all ${queries.length} top quer${queries.length === 1 ? 'y' : 'ies'} (heuristic term coverage >= ${ANSWER_COVERAGE * 100}% with a complete sentence).`
        : `${queries.length - answered} of ${queries.length} top quer${queries.length === 1 ? 'y is' : 'ies are'} not clearly addressed by a statement in the first ${ANSWER_WINDOW_WORDS} words of body text${hasStatement ? '' : ' (no complete sentence near the top)'}; consider answering it directly under the H1 (heuristic).`,
  };
}

function assessHeadings(input: AeoPageInput, sections: Section[]): AeoHeadingCheck {
  const hs = input.headings;
  if (!hs.length && !input.emptyHeadings) return { status: 'unknown', total: 0, empty: 0, generic: [], questionHeadings: [], summary: 'No headings recorded for this page.' };
  const generic = hs.filter((h) => h.level > 1 && GENERIC_HEADING.test(collapse(h.text))).map((h) => h.text);
  const questionHeadings: AeoHeadingCheck['questionHeadings'] = [];
  for (const h of hs) {
    if (!QUESTION_HEADING.test(collapse(h.text))) continue;
    const sec = sections.find((s) => s.heading === h);
    if (!sec) {
      questionHeadings.push({ text: h.text, answered: null, detail: 'heading not found in the stored text; not assessed' });
      continue;
    }
    const first = firstSentence(sec.body);
    const answered = words(first).length >= 6 && !/\?\s*$/.test(first);
    questionHeadings.push({ text: h.text, answered, detail: answered ? 'followed by a direct statement' : sec.body ? 'the section does not open with a direct statement' : 'the section is empty' });
  }
  const unanswered = questionHeadings.filter((q) => q.answered === false).length;
  const status: AeoCheckStatus = generic.length || input.emptyHeadings || unanswered ? 'review' : 'ok';
  const parts = [
    generic.length ? `${generic.length} generic heading(s) (${generic.slice(0, 5).map((g) => `"${g}"`).join(', ')})` : null,
    input.emptyHeadings ? `${input.emptyHeadings} empty heading(s)` : null,
    unanswered ? `${unanswered} question heading(s) not answered right below` : null,
  ].filter(Boolean);
  return {
    status,
    total: hs.length + input.emptyHeadings,
    empty: input.emptyHeadings,
    generic,
    questionHeadings,
    summary: status === 'ok' ? `${hs.length} heading(s) look descriptive; question headings are answered directly (heuristic).` : `Headings to review: ${parts.join('; ')} (heuristic).`,
  };
}

function assessSections(input: AeoPageInput, sections: Section[]): AeoSectionCheck {
  if (!input.text) return { status: 'unknown', sections: 0, backReferences: [], summary: 'No stored page text: sections could not be assessed.' };
  const backReferences: AeoSectionCheck['backReferences'] = [];
  for (const s of sections) {
    for (const m of s.body.matchAll(BACK_REFERENCE)) backReferences.push({ heading: s.heading?.text ?? null, phrase: m[0] });
  }
  const headed = sections.filter((s) => s.heading).length;
  const status: AeoCheckStatus = backReferences.length ? 'review' : 'ok';
  return {
    status,
    sections: headed,
    backReferences: backReferences.slice(0, 20),
    summary: backReferences.length
      ? `${backReferences.length} back-reference(s) such as "${backReferences[0]!.phrase}": a section that relies on earlier text is harder to quote on its own (heuristic, English phrases).`
      : `No back-references ("as mentioned above", ...) found across ${headed} section(s) (heuristic, English phrases).`,
  };
}

function assessEvidence(input: AeoPageInput): AeoEvidenceCheck {
  const text = input.text ?? '';
  const citationPhrases = [...new Set([...text.matchAll(CITATION_PHRASE)].map((m) => m[0].toLowerCase()))].slice(0, 10);
  const numericClaims = [...text.matchAll(NUMERIC_CLAIM)].length;
  const referencesSection = input.headings.some((h) => REFERENCES_HEADING.test(collapse(h.text)));
  let citationLinks = 0;
  for (const l of input.externalLinks ?? []) {
    try {
      if (!NON_CITATION_HOSTS.test(new URL(l.href).hostname)) citationLinks++;
    } catch {
      /* not an absolute URL */
    }
  }
  const base = { externalLinks: input.externalLinkCount, citationLinks, citationPhrases, numericClaims, referencesSection, dateModified: input.dateModified };
  if (!input.text) return { ...base, status: 'unknown', summary: 'No stored page text: evidence could not be assessed.' };
  const supported = citationLinks > 0 || citationPhrases.length > 0 || referencesSection;
  if (supported) {
    return {
      ...base,
      status: 'ok',
      summary: `Evidence signals present: ${[citationLinks ? `${citationLinks} outbound citation-type link(s)` : null, citationPhrases.length ? `source wording (${citationPhrases.slice(0, 3).join(', ')})` : null, referencesSection ? 'a references/sources section' : null].filter(Boolean).join('; ')} (heuristic; presence, not accuracy).`,
    };
  }
  return {
    ...base,
    status: 'review',
    summary: numericClaims
      ? `${numericClaims} figure(s) (percentages or large numbers) with no outbound source link or source wording: support them with a source (heuristic).`
      : 'No outbound sources, source wording, or references section; fine for pages that make no factual claims, otherwise add evidence (heuristic).',
  };
}

/** Pure, deterministic assessment of one page snapshot (no database, no network). */
export function assessAeoPage(input: AeoPageInput): AeoTextAssessment {
  const sections = input.text ? splitSections(input.text, input.headings) : [];
  const caveats = [
    `${AEO_LABEL}: deterministic editorial checks over the stored crawl snapshot (${AEO_VERSION}); not Google ranking rules, not a prediction of AI citations, featured snippets, or rich results.`,
    `Phrase patterns (question words, back-references, source wording) are English${input.language && !/^en\b/i.test(input.language) ? `; this page's language is "${input.language}", so they under-report` : ''}.`,
    'Factual consistency is not assessed here (new drafts are checked by the content quality gates).',
  ];
  if (input.topQueries?.length) caveats.push('Top queries are the visible Search Console rows (anonymized queries are omitted); matching is lexical, without synonyms.');
  return {
    label: AEO_LABEL,
    version: AEO_VERSION,
    answer: assessAnswer(input, sections),
    headings: assessHeadings(input, sections),
    sections: assessSections(input, sections),
    evidence: assessEvidence(input),
    caveats,
  };
}

function isSyntheticCrawl(ctx: AppContext, crawlId: string): boolean {
  return ctx.db.get<{ s: number }>('SELECT is_synthetic AS s FROM crawls WHERE id = ? AND site_id = ?', [crawlId, ctx.siteId])?.s === 1;
}

/** Assess one stored crawl result of this site (null when the result does not exist). */
export function assessAeoForResult(ctx: AppContext, resultId: string): AeoAssessment | null {
  const row = crawlResultById(ctx.db, ctx.siteId, resultId);
  if (!row) return null;
  const url = row.final_url ?? row.requested_url;
  const extraction = crawlResultExtraction(ctx.db, ctx.siteId, resultId);
  const sd = structuredDataTypes(row.structured_data_json);
  const property = ctx.config.google.searchConsoleProperty ?? null;
  const searchType = ctx.config.google.gsc.searchTypes[0] ?? 'web';
  const q = topGscQueriesForPage(ctx.db, ctx.siteId, { pageId: row.page_id, url }, { property, searchType, windowDays: 28, limit: 5, includeSynthetic: ctx.synthetic });
  const fetchedOk = row.status_code !== null && row.status_code >= 200 && row.status_code < 300 && !row.blocked_reason;
  const text = fetchedOk ? loadCrawlText(ctx.raw, row.text_ref) : null;
  const assessed = assessAeoPage({
    title: row.title,
    headings: parseHeadings(row.headings_json),
    emptyHeadings: countEmptyHeadings(row.headings_json),
    text,
    externalLinks: extraction?.externalLinks ?? null,
    externalLinkCount: row.links_external,
    dateModified: sd.dateModified,
    language: row.language,
    topQueries: q?.rows ?? null,
    querySource: q ? { property: q.property, start: q.start, end: q.end } : null,
  });
  const checks = [assessed.answer, assessed.headings, assessed.sections, assessed.evidence];
  if (!fetchedOk) assessed.caveats.push(`The stored result is not a successful fetch (${row.blocked_reason ?? `HTTP ${row.status_code ?? 'none'}`}); content checks are unknown.`);
  return {
    ...assessed,
    url,
    resultId: row.id,
    crawlId: row.crawl_id,
    fetchedAt: row.fetched_at,
    statusCode: row.status_code,
    title: row.title,
    isSynthetic: isSyntheticCrawl(ctx, row.crawl_id),
    eligibility: searchEligibilityForResult(ctx, row.id),
    counts: { ok: checks.filter((c) => c.status === 'ok').length, review: checks.filter((c) => c.status === 'review').length, unknown: checks.filter((c) => c.status === 'unknown').length },
  };
}

/** Assess the latest own-site (or single-page) crawl result for a URL; null when the URL was never crawled. */
export function assessAeoForUrl(ctx: AppContext, url: string): AeoAssessment | null {
  const n = normalizeUrl(url)?.url;
  const row = (n ? latestCrawlResultForUrl(ctx.db, ctx.siteId, n, ['own_site', 'single_page']) : undefined) ?? latestCrawlResultForUrl(ctx.db, ctx.siteId, url, ['own_site', 'single_page']);
  return row ? assessAeoForResult(ctx, row.id) : null;
}

export interface AeoSiteAssessment {
  crawlId: string | null;
  pages: AeoAssessment[];
  /** Pages of the crawl not assessed because of `limit`. */
  notAssessed: number;
  notes: string[];
}

/** Assess the successfully fetched HTML pages of the latest own-site crawl (bounded by `limit`). */
export function assessAeoForSite(ctx: AppContext, opts: { limit?: number } = {}): AeoSiteAssessment {
  const crawlId = latestOwnCrawlId(ctx.db, ctx.siteId);
  if (!crawlId) return { crawlId: null, pages: [], notAssessed: 0, notes: ['No completed own-site crawl yet: run `crawl` first.'] };
  const rows = crawlResultsForCrawl(ctx.db, ctx.siteId, crawlId).filter((r) => r.status_code !== null && r.status_code >= 200 && r.status_code < 300 && !r.blocked_reason && r.text_ref);
  const limit = Math.max(1, opts.limit ?? 50);
  const pages = rows.slice(0, limit).map((r) => assessAeoForResult(ctx, r.id)).filter((a): a is AeoAssessment => !!a);
  pages.sort((a, b) => b.counts.review - a.counts.review || a.url.localeCompare(b.url));
  return { crawlId, pages, notAssessed: Math.max(0, rows.length - limit), notes: [] };
}
