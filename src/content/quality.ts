import type { AppContext } from '../app/context.js';
import { parseJson } from '../database/db.js';
import { OUTPUT_TRUNCATION_ID, type EvidenceItem, type LlmClient } from '../integrations/llm/types.js';
import type { TrustClass } from '../core/modes.js';
import {
  buildCorpus,
  buildNumberSupport,
  claimPatternSet,
  factNoteSupport,
  factVerificationSources,
  ownerStatements,
  patternHits,
  productClaims,
  prohibitedClaimHits,
  quotations,
  quoteSupported,
  sentenceSupportedByOwner,
  unsupportedNumbers,
  WORD_COUNT_RE,
} from './claims.js';
import { loadSitePages, type SitePage } from './existing.js';
import { listSignals } from './store.js';
import { missingRequiredProperties, STRUCTURED_DATA_REQUIREMENTS_VERSION, structuredDataRequirement, SUPPORTED_SCHEMA_TYPES, typedNodes } from './structured-data-requirements.js';
import {
  containment,
  contentTokens,
  detectInstructionLikeText,
  findPhoneNumbers,
  jaccard,
  lexicalSimilarity,
  normalizeText,
  sentences,
  shingles,
  stripUnverifiedMarkers,
  tokenSet,
  truncate,
  unverifiedMarkers,
  words,
} from './text.js';
import {
  aiReviewOutputSchema,
  type AiReviewRecord,
  type ContentBrief,
  type DraftPackage,
  type CheckConsequence,
  type QualityCheck,
  type QualityFinding,
  type QualityReason,
  type Verdict,
} from './types.js';

/**
 * QUALITY GATES: deterministic validation + source checks + a bounded AI
 * review (prompt `content.review`). The AI review can only make a verdict
 * stricter; it never overrides a deterministic failure and it is not a
 * guarantee that hallucinations are absent. Human review and a
 * `publish_content` approval are always required for publication.
 *
 * Verdict rules (computeVerdict):
 * - any reject-level finding -> reject;
 * - any revise-level finding -> needs_revision (needs_human_review once the
 *   automated revision limit is reached, or at once for a human-authored
 *   version: automated revisions never rewrite a human's text);
 * - any human-level finding, any check that could NOT run (not_checked:
 *   e.g. no own-page text to compare, a content language without fabrication
 *   patterns), an unavailable or PARTIAL AI review -> at best
 *   needs_human_review. A review is PARTIAL when the gateway truncated or
 *   omitted any context item, evidence sources beyond the review bound were
 *   not sent, or the reviewer's output was cut off: runAiReview forces its
 *   verdict to needs_human_review, lists every part not reviewed in full
 *   (`notReviewed`), and its findings only inform the human reviewer (they
 *   never trigger automated revisions);
 * - pass only when every check ran and passed and a complete AI review found
 *   nothing. Even then a human reviews before publication.
 * Every finding carries evidence references: a brief field (brief.outline.2),
 * a package field (pkg.structuredDataProposal), owner configuration
 * (business.productFacts), a source id, or a draft locator (draft.quote:"...").
 */

/** Draft locator for a finding: a short verbatim quote from the draft. */
export function draftQuote(text: string): string {
  return `draft.quote:"${truncate(text.replace(/\s+/g, ' ').trim(), 80)}"`;
}

export const REVIEW_PROMPT_ID = 'content.review';
/** quality-gates@3: a "verified" fact-check note needs resolvable evidence that states it, or a named human's confirmation with a source. */
export const QUALITY_GATE_VERSION = 'quality-gates@3';
/** Evidence sources one bounded AI review sends at most; the rest are recorded as not reviewed. */
export const AI_REVIEW_MAX_SOURCES = 25;

export const AI_REVIEW_DISCLAIMER = 'An LLM review is an additional check, not a guarantee that hallucinations or errors are absent. Human review is required for publication.';

export interface SourceText {
  id: string;
  kind: 'reddit' | 'competitor' | 'manual' | 'other';
  text: string;
  /** Untrusted third-party/user text (default true). */
  untrusted?: boolean;
  /** Instruction-like spans flagged when the signal was collected. */
  instructionLikeText?: string[];
}

export interface QualityInputs {
  brief: ContentBrief;
  pkg: DraftPackage;
  sitePages: SitePage[];
  ownPageTexts: Array<{ url: string; pageId: string; text: string }>;
  sourceTexts: SourceText[];
  siblings: Array<{ draftId: string; itemId: string; body: string; templateId: string | null }>;
}

// ---------------------------------------------------------------------------
// Input loading
// ---------------------------------------------------------------------------

export function rawText(payload: unknown): string | null {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    const o = payload as Record<string, unknown>;
    for (const k of ['text', 'visibleText', 'content', 'body']) if (typeof o[k] === 'string') return o[k] as string;
  }
  return null;
}

/**
 * Full context of an Apify Reddit signal. The Apify writer stores only the
 * post title (or a short text) on the signal; the post body lives in the raw
 * dataset referenced by the signal's source row(s) (`sources.raw_ref`, item
 * key in `metadata_json.itemKey`), with evidence rows as a fallback. Repeat
 * occurrences are linked through `apify_signal_occurrences`.
 */
export function redditContextTexts(ctx: AppContext, signal: { id: string; sourceId: string | null; engagement: Record<string, unknown> | null }, rawCache: Map<string, unknown> = new Map()): string[] {
  const sourceIds = new Set<string>();
  if (signal.sourceId) sourceIds.add(signal.sourceId);
  try {
    for (const r of ctx.db.all<{ source_id: string | null }>('SELECT source_id FROM apify_signal_occurrences WHERE site_id = ? AND signal_id = ?', [ctx.siteId, signal.id])) if (r.source_id) sourceIds.add(r.source_id);
  } catch {
    /* occurrence table unavailable: use the signal's own source only */
  }
  const out: string[] = [];
  for (const sid of sourceIds) {
    const src = ctx.db.get<{ raw_ref: string | null; metadata_json: string | null }>('SELECT raw_ref, metadata_json FROM sources WHERE site_id = ? AND id = ?', [ctx.siteId, sid]);
    if (!src) continue;
    let found = false;
    const meta = parseJson<Record<string, unknown>>(src.metadata_json, {}) ?? {};
    const itemKey = typeof meta.itemKey === 'string' ? meta.itemKey : null;
    if (src.raw_ref && itemKey) {
      try {
        if (!rawCache.has(src.raw_ref)) rawCache.set(src.raw_ref, ctx.raw.load(src.raw_ref));
        const payload = rawCache.get(src.raw_ref) as { items?: unknown } | null;
        const items = Array.isArray(payload?.items) ? (payload!.items as Array<Record<string, unknown>>) : [];
        const item = items.find((i) => i && i.key === itemKey);
        const text = item ? (typeof item.context === 'string' ? item.context : [item.title, item.body, item.text].filter((x) => typeof x === 'string').join('\n')) : '';
        if (text) {
          out.push(text);
          found = true;
        }
      } catch {
        /* unreadable raw file: fall back to evidence rows */
      }
    }
    if (!found) {
      for (const e of ctx.db.all<{ excerpt: string | null }>('SELECT excerpt FROM evidence WHERE site_id = ? AND source_id = ?', [ctx.siteId, sid])) if (e.excerpt) out.push(e.excerpt);
    }
  }
  // Legacy/fixture shape: a body stored on the signal's engagement.
  if (typeof signal.engagement?.body === 'string') out.push(signal.engagement.body as string);
  return [...new Set(out)];
}

export function loadQualityInputs(ctx: AppContext, brief: ContentBrief, pkg: DraftPackage, siblings: QualityInputs['siblings'] = []): QualityInputs {
  const { pages } = loadSitePages(ctx);
  const ownPageTexts: QualityInputs['ownPageTexts'] = [];
  let budget = 2_000_000;
  for (const p of pages) {
    if (!p.textRef || budget <= 0) continue;
    try {
      const t = rawText(ctx.raw.load(p.textRef));
      if (t) {
        ownPageTexts.push({ url: p.url, pageId: p.pageId, text: t });
        budget -= t.length;
      }
    } catch {
      /* unreadable raw file: skipped, duplication check reports partial coverage */
    }
  }
  const sourceTexts: SourceText[] = [];
  const rawCache = new Map<string, unknown>();
  const signals = listSignals(ctx.db, ctx.siteId, { itemId: brief.contentItemId });
  for (const s of signals) {
    const flagged = Array.isArray(s.engagement?.instructionLikeText) ? (s.engagement!.instructionLikeText as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    if (s.origin === 'apify_reddit' || s.origin === 'competitor_gap' || s.origin === 'manual') {
      const kind: SourceText['kind'] = s.origin === 'apify_reddit' ? 'reddit' : s.origin === 'manual' ? 'manual' : 'competitor';
      sourceTexts.push({ id: s.id, kind, text: s.text, untrusted: true, ...(flagged.length ? { instructionLikeText: flagged } : {}) });
      if (s.origin === 'apify_reddit') {
        redditContextTexts(ctx, s, rawCache).forEach((t, i) => {
          if (t.trim() !== s.text.trim()) sourceTexts.push({ id: `${s.id}:context${i ? `:${i + 1}` : ''}`, kind: 'reddit', text: t, untrusted: true });
        });
      }
    }
    const crId = s.engagement?.crawlResultId;
    if (typeof crId === 'string') {
      const cr = ctx.db.get<{ text_ref: string | null }>('SELECT text_ref FROM crawl_results WHERE site_id = ? AND id = ?', [ctx.siteId, crId]);
      if (cr?.text_ref) {
        try {
          const t = rawText(ctx.raw.load(cr.text_ref));
          if (t) sourceTexts.push({ id: `crawl:${crId}`, kind: 'competitor', text: t, untrusted: true });
        } catch {
          /* skipped */
        }
      }
    }
  }
  for (const e of brief.evidenceSources) {
    if (e.kind === 'memory' || (e.kind === 'signal' && !sourceTexts.some((s) => s.id === e.id))) {
      sourceTexts.push({ id: e.id, kind: 'other', text: e.excerpt, untrusted: e.trustClass === 'scraped_untrusted' || e.trustClass === 'user_reported' });
    }
  }
  return { brief, pkg, sitePages: pages, ownPageTexts, sourceTexts, siblings };
}

/**
 * Sources that may support a statistic in a draft: owner-approved statements
 * (product facts, approved claims, differentiators, offer, conversion
 * meanings), validated catalog attributes, programmatic differentiating data,
 * and owner-approved or first-party evidence excerpts that the draft's
 * source ledger actually cites (including the target page's current text for
 * improve/add-section drafts), and statements a named human confirmed with a
 * source in a human revision (`content revise-manual`). Untrusted
 * Reddit/competitor text, unrelated own-site pages, dates/windows, ids,
 * engagement counts, and the writer model's own "verified" claims never
 * support a statistic.
 */
export function draftNumberSources(ctx: AppContext, q: QualityInputs): Array<{ id: string; text: string }> {
  const { brief, pkg } = q;
  const cited = new Set<string>([...pkg.sourceLedger.flatMap((l) => l.evidenceIds), ...pkg.factCheckNotes.filter((n) => n.status === 'verified').flatMap((n) => n.evidenceIds)]);
  const out: Array<{ id: string; text: string }> = [...ownerStatements(ctx.config)];
  pkg.factCheckNotes.forEach((n, i) => {
    const h = n.humanResolution;
    if (n.status === 'verified' && h?.action === 'confirmed' && h.reviewer.trim() && h.source.trim()) out.push({ id: `human_confirmed:${i}`, text: n.statement });
  });
  for (const a of brief.catalogAttributes) if (a.validated && (a.source === 'catalog' || a.source === 'owner')) out.push({ id: `attr:${a.name}`, text: `${a.name} ${a.value}` });
  for (const d of brief.programmatic.differentiatingData) out.push({ id: `pseo:${d.field}`, text: `${d.field} ${d.value}` });
  for (const e of brief.evidenceSources) {
    if (!cited.has(e.id) || e.isSandbox) continue;
    if (e.trustClass === 'owner_approved' || e.trustClass === 'first_party_measurement') out.push({ id: e.id, text: e.excerpt });
  }
  if ((brief.decision === 'improve_existing' || brief.decision === 'add_section') && brief.targetPageUrl) {
    const target = q.ownPageTexts.find((p) => normUrl(p.url) === normUrl(brief.targetPageUrl!));
    if (target && (cited.has('target_page_text') || cited.has(`page:${target.pageId}`))) out.push({ id: 'target_page_text', text: target.text });
  }
  return out;
}

/**
 * Sources that may back a "verified" fact-check note (see factNoteSupport):
 * owner statements, first-party measurements (numeric statements only), and
 * the target page's current text for improve/add-section drafts; never demand
 * signals, SERP, or retrieved notes (factVerificationSources).
 */
export function factNoteSources(ctx: AppContext, q: Pick<QualityInputs, 'brief' | 'ownPageTexts'>): Map<string, string> {
  const { brief } = q;
  const extra: Array<{ id: string; text: string }> = [];
  if ((brief.decision === 'improve_existing' || brief.decision === 'add_section') && brief.targetPageUrl) {
    const target = q.ownPageTexts.find((p) => normUrl(p.url) === normUrl(brief.targetPageUrl!));
    if (target) extra.push({ id: 'target_page_text', text: target.text });
  }
  return factVerificationSources(ctx.config, brief.evidenceSources, extra);
}

/** Instruction-like spans flagged in untrusted sources (stored flags plus detection on the source text). */
function untrustedInstructionSentences(q: QualityInputs): Array<{ sourceId: string; text: string }> {
  const out: Array<{ sourceId: string; text: string }> = [];
  for (const s of q.sourceTexts) {
    if (s.untrusted === false) continue;
    for (const f of s.instructionLikeText ?? []) out.push({ sourceId: s.id, text: f });
    for (const sent of sentences(s.text)) if (detectInstructionLikeText(sent).length) out.push({ sourceId: s.id, text: sent });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic checks
// ---------------------------------------------------------------------------

const FILLER = [
  "in today's fast-paced world",
  'in today’s fast-paced world',
  'in the ever-evolving',
  'it is important to note that',
  "it's important to note that",
  'unlock the power',
  'unlock the full potential',
  'delve into',
  'game-changer',
  'game changer',
  'look no further',
  'in conclusion,',
  'at the end of the day',
  'when it comes to',
  'navigating the complex',
  'a testament to',
  'seamlessly',
  'elevate your',
  'embark on a journey',
  'without further ado',
];

const HIDDEN_RE = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px)?\b|<[^>]+\bhidden\b[^>]*>/i;
const DATE_REFRESH_RE = /\b(?:last\s+updated|updated\s+(?:on|in|for)?|refreshed|revised|(?:20\d{2})\s+update)\b[^.\n]{0,25}?(?:\b(?:19|20)\d{2}\b|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}[/.-]\d{1,2})/i;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const HANDLE_RE = /(?:^|\s)(?:\/?u\/[A-Za-z0-9_-]{3,}|@[A-Za-z0-9_]{3,})\b/;
const AGGRESSIVE_CTA_RE = /\b(buy now|act now|limited time|don't miss out|hurry|last chance|order today)\b/i;
const CATALOG_SPEC_RE = /\b\d+(?:[.,]\d+)?\s?(?:cm|mm|kg|g|lbs?|inch(?:es)?|ml|l|oz|mah|watts?|volts?|hours? of battery)\b|\bmade (?:of|from) [a-z ]{3,30}|\b(?:waterproof|water-resistant|stainless steel|100% cotton|organic cotton|genuine leather|aluminium|aluminum|merino wool|polyester)\b/gi;
const DATE_KEY_RE = /^date(?:Modified|Published)$/;

const SEVERITY: Record<QualityFinding['consequence'], number> = { info: 0, human: 1, revise: 2, reject: 3 };

interface CheckBuilder {
  fail(detail: string, fix: string, refs?: string[], consequence?: CheckConsequence): void;
  warn(detail: string, fix: string, refs?: string[], consequence?: 'human' | 'info'): void;
  findings: QualityFinding[];
  done(passMessage: string, opts?: { notChecked?: boolean }): QualityCheck;
}

function check(id: string, title: string): CheckBuilder {
  const findings: QualityFinding[] = [];
  return {
    findings,
    fail(detail, fix, refs = [], consequence = 'revise') {
      findings.push({ level: 'fail', consequence, detail, evidenceRefs: refs, fix });
    },
    warn(detail, fix, refs = [], consequence = 'info') {
      findings.push({ level: 'warn', consequence, detail, evidenceRefs: refs, fix });
    },
    done(passMessage, opts = {}) {
      const failed = findings.some((f) => f.level === 'fail');
      const warned = findings.some((f) => f.level === 'warn');
      // A check that could not run is never "pass" (and never "warn": its warnings explain why it did not run).
      const status: QualityCheck['status'] = failed ? 'fail' : opts.notChecked ? 'not_checked' : warned ? 'warn' : 'pass';
      const consequence = findings.reduce<QualityFinding['consequence']>((m, f) => (SEVERITY[f.consequence] > SEVERITY[m] ? f.consequence : m), 'info');
      return { id, title, status, consequence, message: findings.length ? `${findings.length} finding(s)` : passMessage, findings };
    },
  };
}

function internalUrl(href: string, ctx: AppContext): string | null {
  if (/^(mailto:|tel:|#)/i.test(href)) return null;
  if (href.startsWith('/')) {
    try {
      return new URL(href, ctx.config.site.url).toString();
    } catch {
      return null;
    }
  }
  try {
    const u = new URL(href);
    return ctx.config.site.allowedHostnames.map((h) => h.toLowerCase()).includes(u.hostname.toLowerCase()) ? u.toString() : null;
  } catch {
    return null;
  }
}

const normUrl = (u: string) => u.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();

export function runDeterministicChecks(ctx: AppContext, q: QualityInputs, opts: { revisionRound: number } = { revisionRound: 0 }): QualityCheck[] {
  const { brief, pkg } = q;
  const body = pkg.body;
  const plain = stripUnverifiedMarkers(body);
  const bodyTokens = tokenSet(plain);
  const cfg = ctx.config;
  const out: QualityCheck[] = [];
  const allText = [plain, pkg.titleOptions.join('\n'), pkg.metaDescription].join('\n');

  // 1. Intent and business relevance
  {
    const c = check('intent_business_relevance', 'Intent and business relevance');
    if (brief.decision === 'defer' || brief.decision === 'reject' || brief.intent === 'navigational' || brief.intent === 'unsure') c.fail(`Brief decision/intent (${brief.decision}/${brief.intent}) is not actionable.`, 'Do not draft this item.', ['brief.decision', 'brief.intent']);
    const topic = new Set(contentTokens([brief.primaryQuestion, ...brief.queryCluster.queries.slice(0, 10)].join(' ')));
    const cov = containment(topic, bodyTokens);
    if (cov < 0.3) c.fail(`Body covers only ${Math.round(cov * 100)}% of the query cluster's terms.`, 'Answer the primary question and cluster queries directly.', ['brief.primaryQuestion', 'brief.queryCluster.queries']);
    const biz = new Set(contentTokens([cfg.business.offer ?? '', ...cfg.business.differentiators, ...cfg.business.productFacts.map((f) => f.statement)].join(' ')));
    const hasCta = !!brief.cta.targetUrl && body.includes(brief.cta.targetUrl);
    if (biz.size && containment(biz, bodyTokens) === 0 && !hasCta) c.warn('Body does not connect to the business offer or link the CTA target.', 'Connect the answer to the offer where genuinely relevant.', ['business.offer', 'business.productFacts', 'brief.cta.targetUrl']);
    out.push(c.done('Addresses the cluster and relates to the business.'));
  }

  // 2. Product-fact consistency (incl. catalog attributes)
  {
    const c = check('product_fact_consistency', 'Product-fact consistency and claim-level evidence');
    for (const f of productClaims(allText, cfg)) {
      if (!f.supportedBy) c.fail(`Unsupported product/business claim: "${truncate(f.clause, 140)}" (closest owner statement match ${Math.round(f.bestContainment * 100)}%).`, 'Remove it, rephrase to a supplied product fact, or mark it [[UNVERIFIED: ...]] for owner confirmation.', [draftQuote(f.clause), 'business.productFacts', 'business.approvedClaims']);
    }
    for (const p of prohibitedClaimHits(allText, cfg)) c.fail(`Prohibited claim present: "${p}".`, 'Remove the prohibited claim.', [draftQuote(p), 'business.prohibitedClaims']);
    const attrs = brief.catalogAttributes;
    if (attrs.length || brief.pageType === 'product' || brief.pageType === 'category') {
      const validated = attrs.filter((a) => a.validated && (a.source === 'catalog' || a.source === 'owner'));
      const validatedText = normalizeText(validated.map((a) => `${a.name} ${a.value}`).join(' '));
      for (const m of plain.matchAll(CATALOG_SPEC_RE)) {
        if (!validatedText.includes(normalizeText(m[0]))) c.fail(`Specification "${m[0]}" is not a validated catalog attribute.`, 'Use validated catalog attributes only; mark others [[UNVERIFIED: ...]].', [draftQuote(m[0]), 'brief.catalogAttributes']);
      }
      for (const a of attrs.filter((x) => !x.validated || x.source === 'image' || x.source === 'model')) {
        if (normalizeText(plain).includes(normalizeText(a.value))) c.fail(`Unvalidated attribute "${a.name}: ${a.value}" (${a.source}) is stated as fact.`, 'Keep it marked [[UNVERIFIED: ...]] until validated; images cannot establish hidden specifications.', [draftQuote(a.value), 'brief.catalogAttributes']);
      }
    }
    out.push(c.done('Product statements match supplied facts/approved claims.'));
  }

  // Verbatim corpus for quotations (sources may be quoted with attribution; Reddit quotes are flagged).
  const corpus = buildCorpus([...brief.evidenceSources.map((e) => e.excerpt), ...ownerStatements(cfg).map((o) => o.text), ...q.sourceTexts.map((s) => s.text), ...q.ownPageTexts.map((p) => p.text)]);
  // Claim-level number support: trusted sources only (see draftNumberSources).
  const numberSupport = buildNumberSupport(draftNumberSources(ctx, q));

  // 3. Unsupported numbers/statistics
  {
    const c = check('unsupported_numbers', 'Unsupported numbers and statistics');
    const seen = new Set<string>();
    const knownQuestions = [brief.primaryQuestion, ...brief.queryCluster.queries, ...brief.evidenceSources.filter((e) => e.kind === 'signal').map((e) => e.excerpt.replace(/\s*\[[^\]]*\]\s*$/, ''))];
    for (const n of unsupportedNumbers(allText, numberSupport, { knownQuestions })) {
      if (seen.has(n.raw)) continue;
      seen.add(n.raw);
      if (n.kind === 'year') c.warn(`Year "${n.raw}" is not supported by evidence.`, 'Confirm the date is correct and meaningful.', [draftQuote(n.raw)], 'human');
      else
        c.fail(
          `Unsupported ${n.kind} "${n.raw}": no supplied owner fact, validated attribute, or owner-approved/first-party evidence excerpt cited in the source ledger states this value for this claim (same value, unit, and topic).`,
          'Remove the number, cite the supporting evidence id in the source ledger, or mark it [[UNVERIFIED: ...]]. Research text (Reddit, competitors), dates, and engagement counts never support a statistic.',
          [draftQuote(n.raw), 'pkg.sourceLedger', 'business.productFacts'],
        );
    }
    out.push(c.done('Every statistic is supported at claim level by owner facts or cited first-party evidence.'));
  }

  // 4. Quotations
  {
    const c = check('unsupported_quotes', 'Quotations');
    for (const quote of quotations(stripUnverifiedMarkers(body))) {
      if (!quoteSupported(quote, corpus)) c.fail(`Quotation not found verbatim in any source: "${truncate(quote, 100)}".`, 'Remove fabricated quotes; only quote verbatim sources with attribution.', [draftQuote(quote), 'brief.evidenceSources']);
      else {
        const src = q.sourceTexts.find((s) => normalizeText(s.text).includes(normalizeText(quote)));
        if (src?.kind === 'reddit') c.warn(`Verbatim quote from a Reddit post (${src.id}); check attribution, privacy, and platform terms.`, 'Prefer paraphrased insight in your own words; never include usernames.', [src.id, draftQuote(quote)], 'human');
      }
    }
    out.push(c.done('No unsupported quotations.'));
  }

  // 5. Expertise, first-hand experience, testimonials, promises
  {
    const c = check('expertise_and_promises', 'Unsupported expertise, experience, testimonials, and promises');
    const set = claimPatternSet(brief.language);
    if (!set) {
      // Applying English patterns to another language would report "pass" without checking anything.
      c.warn(
        `No fabrication patterns exist for content language "${brief.language || 'unknown'}": first-hand experience, credentials, testimonials, guarantees, and outcome promises were NOT checked.`,
        'A human reviewer checks the draft for invented tests, credentials, testimonials, guarantees, and promises.',
        ['brief.language'],
        'human',
      );
      out.push(c.done('Not checked: no pattern set for this language.', { notChecked: true }));
    } else {
      for (const h of patternHits(allText, [...set.experience, ...set.promise])) {
        if (sentenceSupportedByOwner(h.sentence, cfg)) continue;
        c.fail(`Unsupported ${h.label}: "${truncate(h.sentence, 140)}".`, 'Remove it or back it with an owner-approved fact; never invent tests, credentials, testimonials, or guarantees.', [draftQuote(h.sentence), 'business.productFacts', 'business.approvedClaims']);
      }
      out.push(c.done(`No unsupported expertise or promises (${set.language} patterns).`));
    }
  }

  // 6. Duplication against our own site
  {
    const c = check('duplication_own_site', 'Duplication against our site');
    const bodySh = shingles(plain, 5);
    let compared = 0;
    for (const p of q.ownPageTexts) {
      if (brief.decision === 'improve_existing' && brief.targetPageUrl && normUrl(p.url) === normUrl(brief.targetPageUrl)) continue;
      compared++;
      const share = containment(bodySh, shingles(p.text, 5));
      if (share >= 0.3) c.fail(`${Math.round(share * 100)}% of the draft's 5-word sequences already appear on ${p.url}.`, 'Remove duplicated passages; link to the existing page instead.', [p.url]);
      else if (share >= 0.15) c.warn(`${Math.round(share * 100)}% overlap with ${p.url}.`, 'Check whether the overlap is necessary.', [p.url], 'human');
    }
    if (!compared) c.warn('Duplication against our own site was NOT checked: no stored own-page text to compare against (crawl text unavailable).', 'Crawl the site (stores page text), then review again; until then a human checks for duplicated passages.', ['crawl_results.text_ref'], 'human');
    out.push(c.done(compared ? `Compared against ${compared} own page text(s).` : 'No stored own-page text to compare against (crawl text unavailable).', { notChecked: !compared }));
  }

  // 7. Copying / light paraphrase of sources (Reddit, competitors)
  {
    const c = check('copying_sources', 'Copying or light paraphrase of sources');
    const noQuotes = plain.replace(/"[^"\n]*"|“[^”\n]*”/g, ' ').replace(/^>.*$/gm, ' ');
    const bodyEight = shingles(noQuotes, 8);
    const bodySentences = sentences(noQuotes).filter((s) => words(s).length >= 8);
    for (const s of q.sourceTexts.filter((x) => x.kind !== 'other' || x.text.length > 200)) {
      const srcEight = shingles(s.text, 8);
      let shared = 0;
      for (const x of bodyEight) if (srcEight.has(x)) shared++;
      const share = bodyEight.size ? shared / bodyEight.size : 0;
      if (share >= 0.2) c.fail(`${Math.round(share * 100)}% of the draft's 8-word sequences are copied from source ${s.id} (${s.kind}): substantial copying.`, 'Discard and rewrite from scratch: use research to identify needs, then answer independently.', [s.id], 'reject');
      else if (shared > 0) c.fail(`${shared} copied 8-word passage(s) from source ${s.id} (${s.kind}).`, 'Rewrite copied passages in original words.', [s.id]);
      const srcSentences = sentences(s.text).filter((x) => words(x).length >= 8);
      for (const bs of bodySentences) {
        const bt = shingles(bs, 3);
        for (const ss of srcSentences) {
          const j = jaccard(bt, shingles(ss, 3));
          if (j >= 0.5 && j < 1) {
            c.fail(`Light paraphrase of source ${s.id}: "${truncate(bs, 100)}" ~ "${truncate(ss, 100)}" (trigram overlap ${Math.round(j * 100)}%).`, 'Do not lightly paraphrase sources; write an independent answer.', [s.id, draftQuote(bs)]);
            break;
          }
        }
      }
    }
    out.push(c.done('No copied or lightly paraphrased source passages.'));
  }

  // 8. Cannibalization (with uncertainty)
  {
    const c = check('cannibalization', 'Potential cannibalization (uncertain)');
    // For improve_existing, overlap with the target page is the point; only multi-page signals matter then.
    const risk = brief.existingPageOverlap.cannibalizationRisk;
    if (/^(medium|high)/.test(risk) && (!brief.decision.startsWith('improve') || /two or more/i.test(risk))) c.warn(`Brief flagged cannibalization risk: ${brief.existingPageOverlap.cannibalizationRisk}`, 'A human should confirm the page will not compete with existing pages. Similarity is not proof.', ['brief.existingPageOverlap', ...brief.existingPageOverlap.pages.slice(0, 3).map((p) => p.url)], 'human');
    if (brief.decision.startsWith('create_')) {
      for (const p of q.sitePages) {
        if (!p.title) continue;
        for (const t of pkg.titleOptions) {
          const s = lexicalSimilarity(t, p.title);
          if (s >= 0.7) {
            c.warn(`Title option "${truncate(t, 60)}" is ${Math.round(s * 100)}% similar to existing page "${truncate(p.title, 60)}" (${p.url}).`, 'Differentiate the page or improve the existing one instead (similarity is not proof of cannibalization).', [p.url, 'pkg.titleOptions'], 'human');
            break;
          }
        }
      }
    }
    out.push(c.done('No cannibalization signals found (heuristic).'));
  }

  // 9. Original contribution
  {
    const c = check('original_contribution', 'Useful original contribution');
    if (!brief.uniqueContribution.trim()) c.fail('Brief has no unique contribution.', 'Supply product facts, examples, data, or a tool before drafting.', ['brief.uniqueContribution']);
    const contribution = new Set(
      contentTokens([brief.uniqueContribution, ...brief.usefulExamples.filter((e) => !e.needsOwnerInput).map((e) => e.description), ...cfg.business.productFacts.filter((f) => brief.productFactIds.includes(f.id)).map((f) => f.statement)].join(' ')),
    );
    const factHit = cfg.business.productFacts.some((f) => sentences(plain).some((s) => containment(tokenSet(f.statement), tokenSet(s)) >= 0.6));
    if (contribution.size && containment(contribution, bodyTokens) < 0.2 && !factHit) c.fail('The draft does not use the brief\'s unique contribution (facts, examples, data): it reads as generic content.', 'Build the answer around the supplied facts, examples, or tool.', ['brief.uniqueContribution', 'brief.usefulExamples', 'business.productFacts']);
    out.push(c.done('Uses the brief\'s original contribution.'));
  }

  // 10. Answer coverage
  {
    const c = check('answer_coverage', 'Answer coverage against the brief');
    const headings = [...body.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1]!.trim());
    // Competitor headings are topic prompts, never requirements: the draft is not asked to mirror a competitor's structure.
    const competitorTexts = brief.evidenceSources.filter((e) => e.origin === 'competitor_gap').map((e) => e.excerpt.replace(/\s*\[[^\]]*\]\s*$/, ''));
    const competitorIds = new Set(brief.evidenceSources.filter((e) => e.origin === 'competitor_gap').map((e) => e.id));
    brief.outline.forEach((o, i) => {
      if (/^next step$/i.test(o.heading.trim())) return;
      const fromCompetitor = (o.evidenceIds.length > 0 && o.evidenceIds.every((id) => competitorIds.has(id))) || competitorTexts.some((t) => lexicalSimilarity(t, o.heading) >= 0.8);
      if (fromCompetitor) return;
      const sectionTokens = new Set(contentTokens([o.heading, ...o.answers].join(' ')));
      const byHeading = headings.some((h) => lexicalSimilarity(h, o.heading) >= 0.4);
      if (!byHeading && containment(sectionTokens, bodyTokens) < 0.5) c.fail(`Outline section not covered: "${truncate(o.heading, 90)}".`, 'Cover every outline question or explain why it was dropped.', [`brief.outline.${i}`]);
    });
    const first = words(plain).slice(0, 120).join(' ');
    const pq = new Set(contentTokens(brief.primaryQuestion));
    if (pq.size && containment(pq, tokenSet(first)) < 0.4) c.fail('The primary question is not answered near the start.', 'Answer the primary question in the opening lines.', ['brief.primaryQuestion', draftQuote(first)]);
    out.push(c.done('Covers the brief outline and answers the primary question early.'));
  }

  // 11. Internal links
  {
    const c = check('internal_links', 'Internal-link validity');
    const known = new Map(q.sitePages.map((p) => [normUrl(p.url), p]));
    const links = [...body.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)].map((m) => ({ anchor: m[1]!, href: m[2]! }));
    for (const l of links) {
      const url = internalUrl(l.href, ctx);
      if (!url) continue;
      const page = known.get(normUrl(url));
      if (!page) c.fail(`Internal link to unknown page: ${l.href}.`, 'Link only to existing pages recorded by the crawl/page registry.', [l.href]);
      else if (page.lifecycle === 'gone' || page.lifecycle === 'redirected' || (page.statusCode !== null && page.statusCode >= 300)) c.fail(`Internal link to non-200/retired page: ${l.href}.`, 'Link to the live destination.', [l.href]);
    }
    pkg.internalLinkSuggestions.forEach((s, i) => {
      if (!s.verified) c.warn(`Suggested link ${s.targetUrl} is not a verified page.`, 'Replace with a verified page.', [s.targetUrl, `pkg.internalLinkSuggestions.${i}`]);
    });
    out.push(c.done('Internal links resolve to known pages.'));
  }

  // 12. CTA appropriateness
  {
    const c = check('cta', 'CTA presence and appropriateness');
    const ctaTokens = new Set(contentTokens(brief.cta.text));
    let ctaPath: string | null = null;
    try {
      ctaPath = brief.cta.targetUrl ? new URL(brief.cta.targetUrl).pathname : null;
    } catch {
      ctaPath = null;
    }
    const hasTarget = brief.cta.targetUrl ? body.includes(brief.cta.targetUrl) || (!!ctaPath && ctaPath !== '/' && body.includes(ctaPath)) : false;
    if (!hasTarget && containment(ctaTokens, bodyTokens) < 0.4) c.fail('The call to action from the brief is missing.', 'Add one clear next step that matches the brief CTA.', ['brief.cta']);
    out.push(c.done('CTA present.'));
    const tone = check('cta_tone', 'CTA appropriateness for the intent');
    const aggressive = AGGRESSIVE_CTA_RE.exec(plain);
    if (brief.intent === 'informational' && aggressive) tone.warn('Aggressive sales CTA on informational content.', 'Use a helpful next step instead of pressure tactics.', [draftQuote(aggressive[0]), 'brief.intent'], 'human');
    out.push(tone.done('CTA tone matches the intent.'));
  }

  // 13. Metadata
  {
    const c = check('metadata', 'Metadata accuracy (titles, meta description, slug)');
    if (!pkg.titleOptions.length) c.fail('No title options.', 'Provide 1-5 title options.', ['pkg.titleOptions']);
    pkg.titleOptions.forEach((t, i) => {
      if (t.length > 65) c.warn(`Title option is ${t.length} characters (editorial heuristic, not a ranking rule): "${truncate(t, 70)}".`, 'Consider a shorter title.', [`pkg.titleOptions.${i}`]);
    });
    if (pkg.metaDescription.length < 50 || pkg.metaDescription.length > 160) c.warn(`Meta description is ${pkg.metaDescription.length} characters (editorial heuristic 50-160).`, 'Adjust length if it truncates poorly.', ['pkg.metaDescription']);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pkg.slugSuggestion) || pkg.slugSuggestion.length > 80) c.fail(`Slug "${pkg.slugSuggestion}" is not a clean lowercase-hyphen slug (max 80).`, 'Use lowercase words separated by hyphens.', ['pkg.slugSuggestion']);
    if (brief.decision.startsWith('create_')) {
      const clash = q.sitePages.find((p) => p.path.replace(/^\/+|\/+$/g, '').split('/').pop() === pkg.slugSuggestion);
      if (clash) c.fail(`Slug "${pkg.slugSuggestion}" already exists at ${clash.url}.`, 'Choose a distinct slug or improve the existing page.', ['pkg.slugSuggestion', clash.url]);
    }
    const metaTopic = containment(new Set(contentTokens(brief.primaryQuestion)), tokenSet(pkg.metaDescription + ' ' + pkg.titleOptions.join(' ')));
    if (metaTopic < 0.2) c.warn('Titles/meta description barely reflect the primary question.', 'Describe the page accurately.', ['pkg.titleOptions', 'pkg.metaDescription', 'brief.primaryQuestion']);
    out.push(c.done('Metadata is well-formed and accurate.'));
  }

  // 14. Structured data: accuracy against visible content, current feature requirements, and real dates only.
  {
    const c = check('structured_data', 'Structured-data proposal accuracy and feature requirements');
    const sd = pkg.structuredDataProposal;
    const ref = 'pkg.structuredDataProposal';
    if (sd) {
      const nodes = typedNodes(sd.jsonLd, sd.type);
      const types = nodes.length ? [...new Set(nodes.map((n) => n.type))] : [sd.type];
      for (const t of types) if (!SUPPORTED_SCHEMA_TYPES.has(t)) c.fail(`Structured-data type "${t}" is not in the supported allowlist.`, 'Propose only types that describe the visible content.', [ref]);
      for (const { type, node } of nodes) {
        const req = structuredDataRequirement(type);
        if (!req) continue;
        const src = `${req.source}${req.verifiedAt ? ` (verified ${req.verifiedAt})` : ' (unverified)'}`;
        if (req.richResult === 'deprecated') {
          c.warn(`${type} markup creates no rich result: ${req.note}`, `Drop the ${type} proposal unless it serves another documented purpose; never present it as a rich-result opportunity.`, [ref, src], 'human');
        } else if (req.richResult === 'restricted') {
          c.warn(`${type} markup is a restricted rich result: ${req.note}`, 'Keep it only when the page qualifies; say that no rich result is expected otherwise.', [ref, src], 'human');
        } else if (req.richResult === 'none') {
          c.warn(`${type} markup has no Google rich-result feature: ${req.note}`, 'Keep it only if it accurately describes the page.', [ref, src]);
        }
        const missing = req.richResult === 'eligible' ? missingRequiredProperties(node, req) : [];
        if (missing.length) c.fail(`${type} proposal lacks required properties (${missing.join(', ')}) per ${STRUCTURED_DATA_REQUIREMENTS_VERSION}: ${req.note}`, 'Add the required properties from visible content and owner facts, or drop the proposal.', [ref, src]);
      }
      const hasRating = JSON.stringify(sd.jsonLd).match(/"(aggregateRating|review|Review|AggregateRating)"/);
      if (hasRating) c.fail('Review/rating markup without supplied review evidence.', 'Never add ratings or reviews that are not real and visible.', [ref]);
      const strings: string[] = [];
      const dates: Array<{ key: string; value: string }> = [];
      const walk = (v: unknown, key: string) => {
        if (typeof v === 'string') {
          if (DATE_KEY_RE.test(key)) dates.push({ key, value: v });
          if (!key.startsWith('@') && !/url|image|logo|id|date|inLanguage|sameAs/i.test(key) && v.length >= 20) strings.push(v);
        } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
        else if (v !== null && v !== undefined && DATE_KEY_RE.test(key)) dates.push({ key, value: String(v) });
      };
      walk(sd.jsonLd, '');
      for (const str of strings) if (containment(tokenSet(str), bodyTokens) < 0.6) c.fail(`Structured data text is not visible on the page: "${truncate(str, 90)}".`, 'Structured data must describe visible content only.', [ref]);
      const price = JSON.stringify(sd.jsonLd).match(/"price"\s*:\s*"?([\d.,]+)/);
      const ownerPrice = (v: number) => buildNumberSupport(ownerStatements(cfg)).numbers.some((x) => x.value === v && x.kind === 'currency');
      if (price && !ownerPrice(Number(price[1]!.replace(/,/g, '')))) c.fail(`Price ${price[1]} in structured data is not a supplied product fact.`, 'Use only verified prices.', [ref, 'business.productFacts']);
      if (types.includes('FAQPage')) c.warn('FAQ markup proposal: FAQ rich results are not guaranteed (and are no longer shown by Google).', 'Keep the Q&A only if it is visible and genuinely useful.', [ref]);
      // Dates: never proposed by the model for new content; for an update a human confirms the change is substantive.
      if (dates.length) {
        if (brief.decision.startsWith('create_')) {
          for (const d of dates) c.fail(`${d.key} "${truncate(d.value, 30)}" proposed for new content: publication and modification dates are set by a human at publication, never by the draft (fake freshness).`, `Remove ${d.key} from the proposal.`, [ref]);
        } else {
          const published = dates.find((d) => d.key === 'datePublished')?.value;
          const modified = dates.find((d) => d.key === 'dateModified')?.value;
          const t = (v: string | undefined) => (v ? Date.parse(v) : Number.NaN);
          if (published && modified && Number.isFinite(t(published)) && Number.isFinite(t(modified)) && t(modified) < t(published)) {
            c.fail(`dateModified (${modified}) is earlier than datePublished (${published}).`, 'Use the real dates; dateModified can never precede datePublished.', [ref]);
          }
          for (const d of dates.filter((x) => !Number.isFinite(t(x.value)))) c.fail(`${d.key} "${truncate(d.value, 30)}" is not a valid date.`, 'Use an ISO 8601 date set by a human.', [ref]);
          if (modified) c.warn(`dateModified ${modified} on an update: only valid after a substantive, verified change.`, 'A human confirms the change is substantive and sets the real modification date at publication.', [ref, 'brief.decision'], 'human');
        }
      }
    }
    out.push(c.done(sd ? 'Structured data matches visible content and current feature requirements.' : 'No structured-data proposal.'));
  }

  // 15. Brand voice and readability (language-independent)
  {
    const c = check('brand_voice', 'Brand voice and readability');
    const voiceText = [body, pkg.titleOptions.join('\n'), pkg.metaDescription].join('\n');
    const emoji = EMOJI_RE.exec(voiceText);
    if (cfg.editorial.avoidEmojis && emoji) c.fail('Contains emojis (editorial.avoidEmojis is true).', 'Remove emojis.', ['editorial.avoidEmojis', draftQuote(emoji[0])]);
    if (cfg.editorial.avoidEmDashes && voiceText.includes('—')) {
      const at = voiceText.indexOf('—');
      c.fail('Contains em dashes (editorial.avoidEmDashes is true).', 'Replace em dashes with commas, periods, or parentheses.', ['editorial.avoidEmDashes', draftQuote(voiceText.slice(Math.max(0, at - 30), at + 30))]);
    }
    const sents = sentences(plain).filter((x) => !/^#/.test(x));
    const avg = sents.length ? sents.reduce((a, x) => a + words(x).length, 0) / sents.length : 0;
    if (avg > 28) c.warn(`Average sentence length is ${avg.toFixed(1)} words (readability heuristic).`, 'Shorten long sentences.', ['draft.body']);
    for (const para of body.split(/\n{2,}/)) if (words(para).length > 200) {
      c.warn('A paragraph exceeds 200 words (readability heuristic).', 'Break long paragraphs up.', [draftQuote(para)]);
      break;
    }
    out.push(c.done('Respects brand voice and readability heuristics.'));
  }

  // 15b. Content language
  {
    const c = check('language', 'Content language');
    const set = claimPatternSet(brief.language);
    if (!set) {
      c.warn(`No language-identification heuristic for "${brief.language || 'unknown'}": the draft language was NOT checked.`, `A human confirms the draft is written in ${brief.language || 'the configured language'}.`, ['brief.language'], 'human');
      out.push(c.done('Not checked: no heuristic for this language.', { notChecked: true }));
    } else {
      const w = words(plain);
      const fw = new Set(set.functionWords);
      const common = w.filter((x) => fw.has(x)).length;
      if (w.length > 50 && common / w.length < 0.05) c.warn(`Text does not look like ${set.language} although the brief language is ${brief.language}.`, 'Write in the configured language.', ['brief.language', draftQuote(plain.slice(0, 80))], 'human');
      out.push(c.done(`Looks like ${set.language} (function-word heuristic).`));
    }
  }

  // 16. Privacy
  {
    const c = check('privacy', 'Privacy');
    const email = EMAIL_RE.exec(body);
    if (email) c.fail('Contains an email address.', 'Remove personal contact details.', [draftQuote(email[0])]);
    const phones = findPhoneNumbers(stripUnverifiedMarkers(body));
    if (phones.length) c.fail(`Contains a phone-number-like sequence (${phones.slice(0, 3).map((p) => `"${truncate(p, 30)}"`).join(', ')}).`, 'Remove personal phone numbers.', phones.slice(0, 3).map((p) => draftQuote(p)));
    const handle = HANDLE_RE.exec(body);
    if (handle) c.fail('Contains a username/handle (e.g. u/... or @...).', 'Never include usernames from sources.', [draftQuote(handle[0])]);
    out.push(c.done('No personal identifiers.'));
  }

  // 17. Prohibited practices
  {
    const c = check('prohibited_practices', 'Prohibited practices (stuffing, filler, word counts, fake refresh, hidden text, injected instructions)');
    const w = words(plain);
    const normBody = ` ${normalizeText(plain)} `;
    for (const q of [...new Set([...brief.queryCluster.queries.slice(0, 3), brief.primaryQuestion].map((x) => normalizeText(x)))]) {
      if (q.split(' ').filter(Boolean).length < 2 || !w.length) continue;
      const occurrences = normBody.split(` ${q} `).length - 1;
      // Heuristic: 4+ exact repetitions and more than one per ~75 words.
      if (occurrences >= 4 && occurrences > w.length / 75) c.fail(`Keyword stuffing: exact phrase "${q}" repeated ${occurrences} times in ${w.length} words.`, 'Use the phrase naturally; write for the reader.', [draftQuote(q), 'brief.queryCluster.queries']);
    }
    const counts = new Map<string, number>();
    for (const t of contentTokens(plain)) counts.set(t, (counts.get(t) ?? 0) + 1);
    const heavy = [...counts.entries()].filter(([, n]) => n >= 8 && n / Math.max(1, w.length) > 0.08);
    if (heavy.length) c.fail(`Keyword stuffing heuristic: ${heavy.map(([t, n]) => `"${t}" is ${((n / w.length) * 100).toFixed(1)}% of words`).join(', ')}.`, 'Vary wording; remove repetition.', heavy.slice(0, 3).map(([t]) => draftQuote(t)));
    const lower = plain.toLowerCase();
    const filler = FILLER.filter((f) => lower.includes(f));
    if (filler.length >= 2) c.fail(`Generic filler phrases: ${filler.map((f) => `"${f}"`).join(', ')}.`, 'Remove filler; be specific.', filler.slice(0, 3).map((f) => draftQuote(f)));
    else if (filler.length === 1) c.warn(`Generic filler phrase: "${filler[0]}".`, 'Remove filler; be specific.', [draftQuote(filler[0]!)]);
    const wordCount = WORD_COUNT_RE.exec(plain);
    if (wordCount) c.warn('Mentions a word count; arbitrary word-count targets are not a quality measure.', 'Remove word-count references.', [draftQuote(wordCount[0])]);
    const refresh = DATE_REFRESH_RE.exec(plain) ?? pkg.titleOptions.map((t) => DATE_REFRESH_RE.exec(t)).find((m) => !!m) ?? null;
    if (refresh) {
      if (brief.decision.startsWith('create_')) c.fail('Claims an update/refresh date on new content (fake freshness).', 'Remove "updated" labels; dates are set at publication by a human.', [draftQuote(refresh[0])]);
      else c.warn('Adds an "updated" date label; only valid after a substantive, verified change.', 'A human must confirm the change is substantive before dating it.', [draftQuote(refresh[0]), 'brief.decision'], 'human');
    }
    const hidden = HIDDEN_RE.exec(body);
    if (hidden) c.fail('Contains hidden-text markup (hidden text is a spam practice).', 'Never hide text from readers.', [draftQuote(hidden[0])], 'reject');
    // Instruction-like text: reject only when the draft reproduces a span flagged in an untrusted
    // source; otherwise a human reviewer decides (ordinary prose can resemble an instruction).
    const flagged = untrustedInstructionSentences(q);
    for (const sent of sentences(allText)) {
      const hits = detectInstructionLikeText(sent);
      if (!hits.length) continue;
      const four = shingles(sent, 4);
      const nsent = normalizeText(sent);
      const src = flagged.find((f) => {
        const nf = normalizeText(f.text);
        if (hits.some((h) => nf.includes(normalizeText(h)))) return true;
        for (const g of shingles(f.text, 4)) if (four.has(g)) return true;
        return nf.length >= 12 && nsent.includes(nf);
      });
      if (src) {
        c.fail(`Reproduces instruction-like text from untrusted source ${src.sourceId}: ${hits.map((i) => `"${truncate(i, 60)}"`).join(', ')}.`, 'Discard this draft; untrusted text must never be followed or reproduced as instructions.', [src.sourceId, draftQuote(sent)], 'reject');
      } else {
        c.fail(`Instruction-like text (not found in any untrusted source): ${hits.map((i) => `"${truncate(i, 60)}"`).join(', ')} in "${truncate(sent, 120)}".`, 'A human reviewer confirms it is ordinary prose or removes it.', [draftQuote(sent)], 'human');
      }
    }
    out.push(c.done('No prohibited practices detected.'));
  }

  // 17b. Source ledger: every cited reference must exist in the evidence bundle / supplied facts.
  {
    const c = check('source_ledger', 'Source ledger and claim-level evidence');
    pkg.sourceLedger.forEach((l, i) => {
      if (l.status === 'unknown_reference') c.fail(`Ledger entry cites evidence that is not in the approved evidence bundle: "${truncate(l.claim, 100)}".`, 'Cite only evidence ids from the brief or supplied product facts; otherwise mark the claim unverified.', [`pkg.sourceLedger.${i}`, 'brief.evidenceSources']);
    });
    const claims = productClaims(allText, cfg).filter((x) => x.supportedBy);
    if (claims.length && !pkg.sourceLedger.some((l) => l.factIds.length || l.evidenceIds.length)) c.warn('Product statements appear in the body but the source ledger cites no facts or evidence.', 'List each factual claim with its supporting fact/evidence ids.', ['pkg.sourceLedger', draftQuote(claims[0]!.clause)], 'human');
    out.push(c.done(pkg.sourceLedger.length ? 'Ledger references resolve to supplied evidence.' : 'No ledger entries.'));
  }

  // 18. Unresolved facts. A "verified" note is the writer model's claim: it counts only when a
  // cited product fact or trusted evidence item states it, or a named human confirmed it with a source.
  {
    const c = check('unresolved_facts', 'Unresolved facts (block publication)');
    const markers = unverifiedMarkers(body);
    if (markers.length) {
      c.warn(
        `${markers.length} unresolved fact(s) are marked [[UNVERIFIED: ...]]; publication is blocked until resolved.`,
        'The owner confirms each marked statement with a source or removes it, in a human revision: `npm run cli -- content revise-manual <draft-id> --body-file <edited.md> --as <name> --resolutions <file.json> --mode DRAFT`.',
        ['pkg.unresolvedFacts', ...markers.slice(0, 3).map((m) => draftQuote(m))],
        'human',
      );
    }
    const markedNorm = normalizeText(markers.join(' '));
    const sources = factNoteSources(ctx, q);
    pkg.factCheckNotes.forEach((n, i) => {
      if (n.status === 'verified') {
        const h = n.humanResolution;
        if (h) {
          if (!h.reviewer?.trim() || !h.source?.trim()) c.fail(`Fact confirmed without a named reviewer or a source: "${truncate(n.statement, 100)}".`, 'A human confirmation needs the reviewer name and a source (`content revise-manual --resolutions`).', [`pkg.factCheckNotes.${i}`, draftQuote(n.statement)], 'human');
          return;
        }
        const support = factNoteSupport(n.statement, n.evidenceIds, sources);
        if (!support.supported) {
          c.fail(
            `Fact-check note is "verified" on the writer model's word only: ${support.reason}: "${truncate(n.statement, 100)}".`,
            'A model cannot verify its own statement: cite a product fact or trusted evidence id whose text states it, or mark the statement [[UNVERIFIED: ...]] so the owner resolves it with a source (`content revise-manual --resolutions`).',
            [`pkg.factCheckNotes.${i}`, draftQuote(n.statement), ...support.resolvable],
          );
        }
        return;
      }
      if (!markedNorm.includes(normalizeText(n.statement).slice(0, 40))) {
        c.fail(`Unverified statement is not visibly marked: "${truncate(n.statement, 100)}".`, 'Mark it [[UNVERIFIED: ...]] or remove it.', [`pkg.factCheckNotes.${i}`, draftQuote(n.statement)]);
      }
    });
    out.push(c.done('No unresolved facts.'));
  }

  // 19. Programmatic / template similarity
  {
    const c = check('template_similarity', 'Programmatic SEO: distinct value vs. name substitution');
    const mine = shingles(plain, 3);
    for (const s of q.siblings) {
      const other = stripUnverifiedMarkers(s.body);
      const j = jaccard(mine, shingles(other, 3));
      if (j >= 0.6) {
        const a = new Set(words(plain));
        const b = new Set(words(other));
        const onlyA = [...a].filter((x) => !b.has(x)).slice(0, 6);
        const onlyB = [...b].filter((x) => !a.has(x)).slice(0, 6);
        c.fail(`Near-identical to draft ${s.draftId} (item ${s.itemId}): ${Math.round(j * 100)}% shared 3-word sequences; differences are limited to substituted terms (${onlyA.join(', ') || 'none'} vs ${onlyB.join(', ') || 'none'}).`, 'Programmatic pages need distinct user value and real differentiated data; mere city/product-name substitution is not allowed.', [s.draftId], 'reject');
      } else if (j >= 0.4) {
        c.warn(`Similar to draft ${s.draftId} (${Math.round(j * 100)}% shared 3-word sequences).`, 'Confirm each page offers distinct value.', [s.draftId], 'human');
      }
    }
    if (brief.programmatic.isProgrammatic) {
      if (!brief.programmatic.differentiatingData.length) c.fail('Programmatic page without differentiating data.', 'Add real, distinct data per page or do not publish.', ['brief.programmatic'], 'reject');
      brief.programmatic.differentiatingData.forEach((d, i) => {
        if (!normalizeText(plain).includes(normalizeText(d.value))) c.fail(`Differentiating data "${d.field}: ${d.value}" does not appear in the page.`, 'Show the distinct data that justifies this page.', [`brief.programmatic.differentiatingData.${i}`]);
      });
    }
    out.push(c.done(q.siblings.length ? `Compared with ${q.siblings.length} sibling draft(s).` : 'No sibling drafts to compare.'));
  }

  void opts;
  return out;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/** Status label for display: a partial review is never shown as a completed (full) review. */
export function aiReviewStatusLabel(ai: Pick<AiReviewRecord, 'status' | 'partialReview'>): string {
  return ai.status === 'completed' && ai.partialReview ? 'PARTIAL (not a full review)' : ai.status;
}

/** The parts a partial AI review did not see in full (recorded parts, or the raw truncation records of older reviews). */
function partialParts(ai: AiReviewRecord): Array<{ id: string; label: string; detail: string }> {
  if (ai.notReviewed?.length) return ai.notReviewed;
  return (ai.truncation ?? []).map((t) => ({ id: t.evidenceId, label: t.evidenceId, detail: t.keptTokens > 0 ? `truncated: about ${t.keptTokens} of ${t.originalTokens} estimated tokens seen` : 'not seen (omitted)' }));
}

/** Command a human runs to edit a draft and resolve its unresolved facts (named in fix texts). */
export const HUMAN_REVISION_COMMAND = 'npm run cli -- content revise-manual <draft-id> --body-file <edited.md> --as <name> [--resolutions <file.json>] --mode DRAFT';

export interface VerdictOptions {
  /**
   * The draft version was written by a human (`content revise-manual`):
   * automated revisions never rewrite it, so revise-level findings go to the
   * human (needs_human_review) instead of an automated revision loop.
   */
  humanAuthored?: boolean;
}

export function computeVerdict(checks: QualityCheck[], ai: AiReviewRecord, revisionRound: number, maxRevisions: number, opts: VerdictOptions = {}): { verdict: Verdict; reasons: QualityReason[]; revisionLimitReached: boolean } {
  const reasons: QualityReason[] = [];
  for (const c of checks) {
    let actionable = 0;
    for (const f of c.findings) {
      if (f.consequence === 'info') continue; // editorial heuristics: informational only
      actionable++;
      reasons.push({ code: c.id, message: f.detail, consequence: f.consequence, evidenceRefs: f.evidenceRefs, fix: f.fix });
    }
    // A check that could not run is never silently skipped: the best possible verdict is needs_human_review.
    if (c.status === 'not_checked' && actionable === 0) {
      reasons.push({ code: c.id, message: `Check not run: ${c.title} (${c.message}).`, consequence: 'human', evidenceRefs: [`check:${c.id}`], fix: 'A human reviewer covers this check, or supply the missing input and review again.' });
    }
  }
  const partial = ai.status === 'completed' && !!ai.output && !!ai.partialReview;
  if (partial) {
    const parts = partialParts(ai);
    const ids = parts.map((p) => p.id);
    reasons.push({
      code: 'ai_review_partial',
      message: `AI review was PARTIAL, not a full review: the reviewer did not see ${parts.length} part(s) of the draft/brief/evidence in full (${parts
        .slice(0, 5)
        .map((p) => `${p.label} [${p.id}]: ${p.detail}`)
        .join('; ')}${parts.length > 5 ? `; and ${parts.length - 5} more` : ''}). Its verdict is forced to needs_human_review and its findings only inform the human reviewer.`,
      consequence: 'human',
      evidenceRefs: ['aiReview.truncation', ...ids.slice(0, 10).map((id) => `evidence:${id}`)],
      fix: 'A human reviews the whole draft, including every part listed here; a partial AI review never counts as a complete review.',
    });
  }
  if (ai.status === 'completed' && ai.output) {
    for (const i of ai.output.issues) {
      if (i.severity === 'minor') continue;
      // A partial review never drives automated revisions: its findings go to the human reviewer.
      const consequence: CheckConsequence = partial ? 'human' : i.severity === 'critical' ? 'revise' : 'human';
      reasons.push({ code: `ai_${i.category}`, message: `AI review${partial ? ' (PARTIAL)' : ''} (${i.severity}): ${i.explanation}${i.quote ? ` [quote: "${truncate(i.quote, 80)}"]` : ''}`, consequence, evidenceRefs: ['ai_review', ...(i.quote ? [draftQuote(i.quote)] : [])], fix: i.suggestedFix });
    }
    if (partial) {
      const modelVerdict = ai.modelVerdict ?? ai.output.verdict;
      if (modelVerdict !== 'pass') reasons.push({ code: 'ai_verdict', message: `AI reviewer suggested "${modelVerdict}" after a PARTIAL review: ${truncate(ai.output.summary, 200)}`, consequence: 'human', evidenceRefs: ['ai_review'], fix: 'Human reviewer decides; a partial AI review never rejects, approves, or triggers automated revisions.' });
    } else {
      if (ai.output.verdict === 'reject' || ai.output.verdict === 'needs_human_review') reasons.push({ code: 'ai_verdict', message: `AI reviewer suggested "${ai.output.verdict}": ${truncate(ai.output.summary, 200)}`, consequence: 'human', evidenceRefs: ['ai_review'], fix: 'Human reviewer decides; an AI verdict alone never rejects or approves.' });
      if (ai.output.verdict === 'needs_revision' && !ai.output.issues.some((i) => i.severity === 'critical')) reasons.push({ code: 'ai_verdict', message: `AI reviewer requested revision: ${truncate(ai.output.summary, 200)}`, consequence: 'revise', evidenceRefs: ['ai_review'], fix: 'Address the AI review issues.' });
    }
  } else {
    reasons.push({ code: 'ai_review_unavailable', message: `AI review ${ai.status}: ${ai.reason}`, consequence: 'human', evidenceRefs: ['aiReview'], fix: 'A human reviewer must cover factual accuracy and usefulness.' });
  }
  let verdict: Verdict;
  let revisionLimitReached = false;
  if (reasons.some((r) => r.consequence === 'reject')) verdict = 'reject';
  else if (reasons.some((r) => r.consequence === 'revise')) {
    if (opts.humanAuthored) {
      verdict = 'needs_human_review';
      reasons.push({
        code: 'human_revision_findings',
        message: 'This version was written by a human: automated revisions never rewrite it, so the remaining revise-level findings go back to the author.',
        consequence: 'human',
        evidenceRefs: ['pkg.humanRevision'],
        fix: `Fix the findings in another human revision: \`${HUMAN_REVISION_COMMAND}\`; or reject the item.`,
      });
    } else if (revisionRound < maxRevisions) verdict = 'needs_revision';
    else {
      verdict = 'needs_human_review';
      revisionLimitReached = true;
      reasons.push({
        code: 'revision_limit',
        message: `Automated revision limit reached (${maxRevisions}); remaining issues need a human.`,
        consequence: 'human',
        evidenceRefs: ['draft.revisionRound'],
        fix: `A human edits the body and resolves each [[UNVERIFIED: ...]] marker with a source: \`${HUMAN_REVISION_COMMAND}\`; or reject the item.`,
      });
    }
  } else if (reasons.some((r) => r.consequence === 'human')) verdict = 'needs_human_review';
  else verdict = 'pass';
  return { verdict, reasons, revisionLimitReached };
}

// ---------------------------------------------------------------------------
// Bounded AI review
// ---------------------------------------------------------------------------

export async function runAiReview(ctx: AppContext, llm: LlmClient | null, q: QualityInputs, checks: QualityCheck[], opts: { useModel?: boolean; preview?: boolean } = {}): Promise<AiReviewRecord> {
  const unavailable = (status: AiReviewRecord['status'], reason: string): AiReviewRecord => ({ status, reason, output: null, droppedIssues: 0, promptVersion: null, model: null, costMicros: null, disclaimer: AI_REVIEW_DISCLAIMER });
  if (opts.useModel === false) return unavailable('skipped', 'AI review disabled for this run');
  if (opts.preview || ctx.dryRun) return unavailable('skipped', 'dry run / preview (no paid calls)');
  if (!llm) return unavailable('unavailable', 'LLM client not wired');
  if (!ctx.settings.features.llm) return unavailable('unavailable', 'features.llm is false');
  if (!llm.isConfigured('reasoning')) return unavailable('unavailable', 'REASONING_MODEL not configured');
  const findings = checks.filter((c) => c.status === 'fail' || c.status === 'warn').flatMap((c) => c.findings.map((f) => `${c.id}: ${f.detail}`));
  // Bounded review: at most AI_REVIEW_MAX_SOURCES evidence sources are sent; the rest are recorded as NOT reviewed.
  const sources = q.brief.evidenceSources;
  const sentSources = sources.slice(0, AI_REVIEW_MAX_SOURCES);
  const unsentSources = sources.slice(AI_REVIEW_MAX_SOURCES);
  const evidence: EvidenceItem[] = [
    { id: 'draft_body', label: 'Draft body under review', text: q.pkg.body, trustClass: 'model_generated' },
    { id: 'draft_meta', label: 'Draft titles and meta description', text: `Titles: ${q.pkg.titleOptions.join(' | ')}\nMeta: ${q.pkg.metaDescription}`, trustClass: 'model_generated' },
    {
      id: 'brief',
      label: 'Approved brief (summary)',
      text: JSON.stringify({ audience: q.brief.audience, primaryQuestion: q.brief.primaryQuestion, outline: q.brief.outline.map((o) => o.heading), uniqueContribution: q.brief.uniqueContribution, cta: q.brief.cta.text, unresolvedQuestions: q.brief.unresolvedQuestions.map((u) => u.question) }),
      trustClass: 'model_generated',
    },
    { id: 'deterministic_findings', label: 'Deterministic check findings (computed by code)', text: findings.join('\n') || 'none', trustClass: 'first_party_measurement' },
    ...sentSources.map((e) => ({ id: e.id, label: e.label, text: e.excerpt, trustClass: e.trustClass as TrustClass })),
  ];
  const res = await llm.structured({
    siteId: ctx.siteId,
    runId: ctx.runId,
    role: 'reviewer',
    tier: 'reasoning',
    promptId: REVIEW_PROMPT_ID,
    variables: {
      language: q.brief.language,
      brand_voice: ctx.config.editorial.brandVoice,
      page_type: q.brief.pageType,
      intent: q.brief.intent,
      decision: q.brief.decision,
      revision_round: q.pkg.revisionRound,
    },
    evidence,
    schema: aiReviewOutputSchema,
    schemaName: 'ContentQualityReview',
    maxOutputTokens: Math.min(ctx.config.llm.maxOutputTokensReasoning, 4000),
  });
  if (!res.ok) return unavailable('unavailable', `${res.status}: ${res.reason}`);
  // Bounded: quotes must exist in the draft; unverifiable issues are dropped (counted).
  const bodyNorm = normalizeText(`${q.pkg.body} ${q.pkg.titleOptions.join(' ')} ${q.pkg.metaDescription}`);
  const issues = res.value.issues.filter((i) => !i.quote.trim() || bodyNorm.includes(normalizeText(i.quote)));
  // Record context truncation (spec 9): a reviewer that saw a truncated draft/brief/evidence, or whose
  // own output was cut off, did NOT review everything, and the record says exactly which parts.
  const truncation = (res.truncation ?? []).map((t) => ({ evidenceId: t.evidenceId, originalTokens: t.originalTokens, keptTokens: t.keptTokens, note: t.note }));
  const outputCut = truncation.some((t) => t.evidenceId === OUTPUT_TRUNCATION_ID) || (res as { outputTruncated?: boolean }).outputTruncated === true;
  const labels = new Map(evidence.map((e) => [e.id, e.label]));
  const notReviewed: Array<{ id: string; label: string; detail: string }> = [
    ...truncation
      .filter((t) => t.evidenceId !== OUTPUT_TRUNCATION_ID)
      .map((t) => ({
        id: t.evidenceId,
        label: labels.get(t.evidenceId) ?? t.evidenceId,
        detail: t.keptTokens > 0 ? `truncated by the gateway: the reviewer saw about ${t.keptTokens} of about ${t.originalTokens} estimated tokens` : `omitted by the gateway: the reviewer did not see it (about ${t.originalTokens} estimated tokens)`,
      })),
    ...unsentSources.map((e) => ({ id: e.id, label: e.label, detail: `not sent: the AI review includes at most ${AI_REVIEW_MAX_SOURCES} evidence sources` })),
    ...(outputCut ? [{ id: OUTPUT_TRUNCATION_ID, label: 'AI reviewer output', detail: 'cut off at the output token limit: the review itself is incomplete' }] : []),
  ];
  const partial = notReviewed.length > 0;
  const output = { ...res.value, issues: issues.slice(0, 30) };
  if (partial) {
    // Never describe a truncated source as fully reviewed: the verdict is forced and the summary says so.
    const listed = notReviewed.slice(0, 5).map((n) => `${n.label} [${n.id}]`).join(', ');
    output.verdict = 'needs_human_review';
    output.summary = `PARTIAL REVIEW, not a full review (not seen in full: ${listed}${notReviewed.length > 5 ? `, and ${notReviewed.length - 5} more` : ''}). Model summary: ${res.value.summary}`;
  }
  return {
    status: 'completed',
    reason: partial
      ? `PARTIAL review (${res.model}, ${res.promptVersion}); verdict forced to needs_human_review. Not reviewed in full: ${notReviewed
          .slice(0, 5)
          .map((n) => `${n.label} [${n.id}]: ${n.detail}`)
          .join('; ')}${notReviewed.length > 5 ? `; and ${notReviewed.length - 5} more` : ''}`
      : `completed (${res.model}, ${res.promptVersion})`,
    output,
    droppedIssues: res.value.issues.length - issues.length,
    promptVersion: res.promptVersion,
    model: res.model,
    costMicros: res.costMicros,
    disclaimer: AI_REVIEW_DISCLAIMER,
    partialReview: partial,
    truncation,
    ...(partial ? { notReviewed, modelVerdict: res.value.verdict } : {}),
  };
}
