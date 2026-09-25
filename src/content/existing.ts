import type { AppContext } from '../app/context.js';
import type { BrandAnalysis } from '../router/intent.js';
import { contentBrandAnalyzer } from './classify.js';
import { observationHold } from './freeze.js';
import { audit, listSignals, updateItem } from './store.js';
import { parseHeadings } from './signals.js';
import { containment, contentTokens, lexicalSimilarity, tokenSet, truncate } from './text.js';
import type { ContentDecision, ContentItem, ContentSignal, DemandEvidence, OverlapResult, PageOverlap } from './types.js';

/**
 * CHECK EXISTING CONTENT + DECIDE.
 *
 * For each open item, compare its member queries/questions with our own pages
 * (titles, headings, meta, paths from the latest own-site crawl) and with the
 * pages that already receive Search Console impressions for those queries.
 * Then decide: improve_existing / add_section / create_tool / create_template
 * / create_page / defer / reject, preserving the reason and the rationale
 * (why it deserves to exist, who benefits, business relation, original value,
 * reader's next step). Overlap is reported with uncertainty; lexical
 * similarity is never treated as proof of cannibalization. An item whose
 * target page has an experiment under observation is deferred (freeze.ts).
 */

export const DECISION_RULES_VERSION = 'content-decision@2';

export interface SitePage {
  pageId: string;
  url: string;
  path: string;
  pageType: string | null;
  isProtected: boolean;
  lifecycle: string;
  title: string | null;
  metaDescription: string | null;
  headings: string[];
  textRef: string | null;
  statusCode: number | null;
  crawledAt: string | null;
  tokens: Set<string>;
}

export function loadSitePages(ctx: AppContext): { pages: SitePage[]; crawlAvailable: boolean; gscAvailable: boolean } {
  const pages = ctx.db.all<{ id: string; url: string; path: string; page_type: string | null; is_protected: number; is_excluded: number; lifecycle: string }>(
    `SELECT id, url, path, page_type, is_protected, is_excluded, lifecycle FROM pages WHERE site_id = ? AND lifecycle != 'gone' ORDER BY url`,
    [ctx.siteId],
  );
  const crawlRows = ctx.db.all<{ page_id: string; title: string | null; meta_description: string | null; headings_json: string | null; text_ref: string | null; status_code: number | null; fetched_at: string }>(
    `SELECT cr.page_id, cr.title, cr.meta_description, cr.headings_json, cr.text_ref, cr.status_code, cr.fetched_at
     FROM crawl_results cr JOIN crawls c ON c.id = cr.crawl_id
     WHERE cr.site_id = ? AND c.kind IN ('own_site', 'single_page') AND cr.page_id IS NOT NULL
     ORDER BY cr.fetched_at DESC`,
    [ctx.siteId],
  );
  const latest = new Map<string, (typeof crawlRows)[number]>();
  for (const r of crawlRows) if (!latest.has(r.page_id)) latest.set(r.page_id, r);
  const gscAvailable = !!ctx.db.get<{ one: number }>('SELECT 1 AS one FROM gsc_page_query_daily_current WHERE site_id = ? LIMIT 1', [ctx.siteId]);
  const out: SitePage[] = pages
    .filter((p) => p.is_excluded === 0)
    .map((p) => {
      const cr = latest.get(p.id);
      const headings = cr ? parseHeadings(cr.headings_json).map((h) => h.text) : [];
      const pathWords = p.path.replace(/[-_/]+/g, ' ');
      const tokens = tokenSet([cr?.title ?? '', cr?.meta_description ?? '', ...headings, pathWords].join(' '));
      return {
        pageId: p.id,
        url: p.url,
        path: p.path,
        pageType: p.page_type,
        isProtected: p.is_protected === 1,
        lifecycle: p.lifecycle,
        title: cr?.title ?? null,
        metaDescription: cr?.meta_description ?? null,
        headings,
        textRef: cr?.text_ref ?? null,
        statusCode: cr?.status_code ?? null,
        crawledAt: cr?.fetched_at ?? null,
        tokens,
      };
    });
  return { pages: out, crawlAvailable: latest.size > 0, gscAvailable };
}

export function computeOverlap(item: ContentItem, signals: ContentSignal[], site: { pages: SitePage[]; crawlAvailable: boolean; gscAvailable: boolean }): OverlapResult {
  const members = [...new Set([item.title, item.primaryQuestion ?? '', ...signals.map((s) => s.text)].filter(Boolean))];
  const memberTokens = members.map((m) => tokenSet(m));

  // Search Console: pages already receiving impressions for these queries.
  interface GscAgg {
    pageId: string | null;
    impressions: number;
    clicks: number;
    posW: number;
    posI: number;
    queries: Set<string>;
  }
  const gscByPage = new Map<string, GscAgg>();
  let totalImpr = 0;
  const pagesPerQuery = new Map<string, Set<string>>();
  for (const s of signals.filter((x) => x.origin === 'gsc_query')) {
    const list = (s.engagement?.pages as Array<{ page: string; pageId: string | null; impressions: number; clicks: number; position: number | null }> | undefined) ?? [];
    for (const p of list) {
      const g = gscByPage.get(p.page) ?? { pageId: p.pageId, impressions: 0, clicks: 0, posW: 0, posI: 0, queries: new Set<string>() };
      g.impressions += p.impressions;
      g.clicks += p.clicks;
      if (p.position !== null && p.impressions > 0) {
        g.posW += p.position * p.impressions;
        g.posI += p.impressions;
      }
      g.queries.add(s.text);
      gscByPage.set(p.page, g);
      totalImpr += p.impressions;
      const set = pagesPerQuery.get(s.text) ?? new Set<string>();
      if (p.impressions > 0) set.add(p.page);
      pagesPerQuery.set(s.text, set);
    }
  }

  const byUrl = new Map(site.pages.map((p) => [p.url, p]));
  const byId = new Map(site.pages.map((p) => [p.pageId, p]));
  const overlaps: PageOverlap[] = [];
  const considered = new Set<string>();
  const consider = (page: SitePage | null, url: string, gsc: GscAgg | null) => {
    const key = page?.pageId ?? url;
    if (considered.has(key)) return;
    considered.add(key);
    let lexical = 0;
    const headingMatches: string[] = [];
    if (page) {
      for (const mt of memberTokens) if (mt.size) lexical = Math.max(lexical, containment(mt, page.tokens));
      for (const h of page.headings) if (members.some((m) => lexicalSimilarity(m, h) >= 0.5)) headingMatches.push(h);
      if (page.title && members.some((m) => lexicalSimilarity(m, page.title!) >= 0.5)) headingMatches.unshift(`title: ${page.title}`);
    }
    const share = gsc && totalImpr > 0 ? gsc.impressions / totalImpr : 0;
    const position = gsc && gsc.posI > 0 ? Math.round((gsc.posW / gsc.posI) * 100) / 100 : null;
    const score = Math.max(lexical * 0.6 + (headingMatches.length ? 0.3 : 0), gsc ? share * 0.8 + (position !== null && position <= 20 ? 0.2 : 0) : 0);
    if (score < 0.3) return;
    let confidence: PageOverlap['confidence'] = 'low';
    if ((gsc && share >= 0.5 && position !== null && position <= 20) || (headingMatches.length && lexical >= 0.8)) confidence = 'high';
    else if (lexical >= 0.6 || share >= 0.2 || headingMatches.length) confidence = 'medium';
    const evidence: string[] = [];
    if (gsc) evidence.push(`OBSERVED: ${gsc.impressions} impressions / ${gsc.clicks} clicks for ${gsc.queries.size} member quer${gsc.queries.size === 1 ? 'y' : 'ies'}${position !== null ? `, avg position ${position}` : ''} (${Math.round(share * 100)}% of this item's visible impressions)`);
    if (page) evidence.push(`INFERRED: ${Math.round(lexical * 100)}% of the closest member's terms appear in title/headings/meta/path`);
    for (const h of headingMatches.slice(0, 3)) evidence.push(`OBSERVED: similar heading "${truncate(h, 80)}"`);
    if (page?.isProtected) evidence.push('Protected page: changes need explicit owner review.');
    overlaps.push({
      pageId: page?.pageId ?? gsc?.pageId ?? '',
      url: page?.url ?? url,
      pageType: page?.pageType ?? null,
      gscImpressions: gsc ? gsc.impressions : null,
      gscClicks: gsc ? gsc.clicks : null,
      gscPosition: position,
      lexicalSimilarity: Math.round(lexical * 1000) / 1000,
      headingMatches: headingMatches.slice(0, 5),
      score: Math.round(score * 1000) / 1000,
      confidence,
      evidence,
    });
  };
  for (const [url, g] of gscByPage) consider((g.pageId ? byId.get(g.pageId) : undefined) ?? byUrl.get(url) ?? null, url, g);
  for (const p of site.pages) consider(p, p.url, gscByPage.get(p.url) ?? null);
  overlaps.sort((a, b) => b.score - a.score);

  const status: OverlapResult['status'] = site.crawlAvailable && site.gscAvailable ? 'complete' : site.crawlAvailable || site.gscAvailable ? 'partial' : 'unavailable';
  const statusReason =
    status === 'complete'
      ? 'Checked against the latest own-site crawl and Search Console page/query rows.'
      : status === 'partial'
        ? site.crawlAvailable
          ? 'Checked against the latest crawl only; no Search Console page/query rows stored.'
          : 'Checked against Search Console rows only; no own-site crawl stored (page titles/headings unknown).'
        : 'No own-site crawl and no Search Console page/query rows: existing coverage could not be checked.';

  const multiPageQueries = [...pagesPerQuery.entries()].filter(([, set]) => set.size >= 2);
  const highPages = overlaps.filter((o) => o.confidence === 'high');
  let risk: OverlapResult['cannibalization']['risk'] = 'low';
  let explanation = 'No existing page shows strong overlap with this item.';
  if (status === 'unavailable') {
    risk = 'unknown';
    explanation = 'Unknown: no crawl or Search Console data to compare against.';
  } else if (multiPageQueries.length) {
    risk = 'medium';
    explanation = `${multiPageQueries.length} member quer${multiPageQueries.length === 1 ? 'y receives' : 'ies receive'} impressions on two or more of our pages (e.g. "${truncate(multiPageQueries[0]![0], 60)}"). This MAY indicate competing pages, but can also be legitimate (different sections or intents); inspect before merging or adding a page.`;
  } else if (highPages.length >= 2) {
    risk = 'medium';
    explanation = 'Two or more existing pages closely match this topic; a new page could compete with them. Lexical similarity alone does not prove cannibalization.';
  } else if (highPages.length === 1) {
    risk = 'medium';
    explanation = `Existing page ${highPages[0]!.url} closely matches this topic; creating a separate page could compete with it.`;
  }
  return {
    status,
    statusReason,
    pages: overlaps.slice(0, 10),
    cannibalization: { risk, explanation },
    uncertainty:
      'Overlap scores combine term containment in titles/headings/meta/paths with the share of visible Search Console impressions. They are heuristics: a single similarity threshold is not proof of cannibalization, and missing crawl or query data lowers confidence.',
  };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export function businessTerms(ctx: AppContext): Set<string> {
  const b = ctx.config.business;
  const text = [b.offer ?? '', b.targetCustomer ?? '', ...b.differentiators, ...b.productFacts.map((f) => f.statement), ...b.approvedClaims, ...ctx.config.research.seedTopics].join(' ');
  return new Set(contentTokens(text).filter((t) => t.length >= 3));
}

export interface DecisionResult {
  decision: ContentDecision;
  reason: string;
  targetPageId: string | null;
  whyExists: string;
  whoBenefits: string;
  businessRelation: string;
  originalValue: string;
  readerNextStep: string;
  relationStrength: 'strong' | 'weak' | 'none' | 'unknown';
  originalValueAvailable: boolean;
  /** The item's question is about the site's own brand (kept in a separate, lower-priority segment). */
  branded: boolean;
}

/**
 * Whether an item is a branded cluster: its primary question/title names a
 * configured brand alias, or most of its signals do.
 */
export function isBrandedItem(item: Pick<ContentItem, 'title' | 'primaryQuestion'>, signals: Array<Pick<ContentSignal, 'text'>>, brand: (t: string) => BrandAnalysis): boolean {
  if (brand(item.primaryQuestion ?? item.title).branded || brand(item.title).branded) return true;
  if (!signals.length) return false;
  const n = signals.filter((s) => brand(s.text).branded).length;
  return n * 2 > signals.length;
}

export function decide(ctx: AppContext, item: ContentItem, signals: ContentSignal[], demand: DemandEvidence, overlap: OverlapResult, formatHintsList: string[] = []): DecisionResult {
  const cfg = ctx.config;
  const branded = isBrandedItem(item, signals, contentBrandAnalyzer(ctx));
  const terms = businessTerms(ctx);
  const itemText = [item.title, item.primaryQuestion ?? '', ...signals.map((s) => s.text)].join(' ');
  const itemTokens = new Set(contentTokens(itemText));
  const shared = [...itemTokens].filter((t) => terms.has(t));
  const siteImpressions = demand.gsc.impressions.status === 'observed' && demand.gsc.impressions.value > 0;
  const ownerOrigins = signals.some((s) => s.origin === 'manual' || s.origin === 'business_knowledge');
  let relationStrength: DecisionResult['relationStrength'];
  if (terms.size === 0) relationStrength = siteImpressions || ownerOrigins ? 'weak' : 'unknown';
  else if (shared.length >= 2 || (shared.length >= 1 && (siteImpressions || ownerOrigins))) relationStrength = 'strong';
  else if (shared.length === 1 || siteImpressions || ownerOrigins) relationStrength = 'weak';
  else relationStrength = 'none';

  const businessRelation =
    relationStrength === 'unknown'
      ? 'Business relation unknown: configure business.offer, differentiators, productFacts, or research.seedTopics.'
      : [
          shared.length ? `Shares terms with the configured offer/facts/topics: ${shared.slice(0, 8).join(', ')}.` : '',
          siteImpressions ? 'The site already receives Search Console impressions for these queries (OBSERVED).' : '',
          ownerOrigins ? 'Raised by customers or owner-maintained knowledge (manual import / business notes).' : '',
          relationStrength === 'none' ? 'No overlap with the configured offer, product facts, differentiators, or seed topics.' : '',
        ]
          .filter(Boolean)
          .join(' ');

  // Original value is something the READER gets that others cannot give: verified product facts, real
  // differentiators, owner data, or a practical tool/template. Search Console impressions (how searchers
  // reach us) and the mere existence of customer questions are demand evidence, not original value.
  const facts = cfg.business.productFacts.filter((f) => [...tokenSet(f.statement)].some((t) => itemTokens.has(t)));
  const diffs = cfg.business.differentiators.filter((d) => [...tokenSet(d)].some((t) => itemTokens.has(t)));
  const valueParts: string[] = [];
  if (facts.length) valueParts.push(`verified product facts (${facts.map((f) => f.id).join(', ')})`);
  if (diffs.length) valueParts.push(`real differentiators ("${truncate(diffs[0]!, 80)}")`);
  if (formatHintsList.includes('tool') || formatHintsList.includes('template') || formatHintsList.includes('checklist')) valueParts.push('a practical tool/template format requested by searchers');
  const originalValueAvailable = valueParts.length > 0;
  const originalValue = originalValueAvailable
    ? `Available: ${valueParts.join('; ')}.`
    : 'None identified yet: no matching product facts, differentiators, owner data, or tool/template idea (search impressions and customer questions show demand, not original value). Needs owner input (real examples, data, product facts) before a page is worth creating.';

  const question = item.primaryQuestion ?? item.title;
  const originList = Object.keys(demand.origins).join(', ');
  const whoBenefits = cfg.business.targetCustomer
    ? `${cfg.business.targetCustomer}, asking "${truncate(question, 100)}" (seen via ${originList}).`
    : `People asking "${truncate(question, 100)}" (seen via ${originList}). Target customer is not configured (business.targetCustomer); confirm the audience.`;

  const primary = cfg.conversions.primaryEvents[0];
  const conversionStep = primary ? primary.meaning : null;
  const intent = item.intent ?? 'unsure';
  const readerNextStep =
    intent === 'transactional' || intent === 'commercial'
      ? conversionStep
        ? `Evaluate the offer, then: ${conversionStep}.`
        : 'Evaluate the offer (primary conversion event not configured in conversions.primaryEvents).'
      : conversionStep
        ? `Apply the answer, then continue to the related offer page (${conversionStep} when relevant).`
        : 'Apply the answer, then continue to the related offer page (primary conversion event not configured).';

  const whyParts = [demand.statusReason];
  if (demand.community.threads) whyParts.push(`${demand.community.threads} community discussion thread(s) (engagement, not search volume).`);
  if (demand.manualQuestions) whyParts.push(`${demand.manualQuestions} manually supplied customer question(s).`);
  if (demand.competitorGaps) whyParts.push(`${demand.competitorGaps} competitor gap signal(s).`);
  const whyExists = whyParts.join(' ');

  const base = { whyExists, whoBenefits, businessRelation, originalValue, readerNextStep, relationStrength, originalValueAvailable, branded };
  const make = (decision: ContentDecision, reason: string, targetPageId: string | null = null): DecisionResult => ({ ...base, decision, reason, targetPageId });

  if (intent === 'navigational') return make('reject', 'Navigational/brand query: searchers want an existing page (home, login, contact), not new content.');
  // Relevance is never auto-dismissed: vocabulary overlap is a weak test, so "no overlap" goes to an owner decision.
  if (relationStrength === 'none') {
    return make('defer', 'Owner review needed: no term overlap with the configured offer, product facts, differentiators, or seed topics, and no site impressions for these queries. Relevance is not dismissed automatically; confirm whether it relates to the business (it may use different vocabulary), or reject it explicitly.');
  }
  if (relationStrength === 'unknown') return make('defer', 'Business scope unknown: configure business.offer / differentiators / productFacts / research.seedTopics so relevance can be judged.');
  if (intent === 'unsure') return make('defer', 'Intent unresolved by rules and no model classification: classify manually (or configure CHEAP_MODEL) before briefing.');
  if (overlap.status === 'unavailable') return make('defer', 'Existing content could not be checked (no own-site crawl or Search Console page data). Run `crawl` and/or `sync gsc` first.');
  if (demand.status === 'unvalidated') return make('defer', 'No external demand evidence (only business knowledge). Collect customer questions or search data first.');

  const high = overlap.pages.find((p) => p.confidence === 'high');
  if (high) {
    const why = high.gscImpressions !== null ? `already receives ${high.gscImpressions} impressions for these queries${high.gscPosition !== null ? ` (avg position ${high.gscPosition})` : ''}` : `closely matches this topic (term overlap ${Math.round(high.lexicalSimilarity * 100)}%)`;
    return make('improve_existing', `Existing page ${high.url} ${why}; improving it is preferred over creating a competing page.`, high.pageId || null);
  }
  const medium = overlap.pages.find((p) => p.confidence === 'medium');
  if (medium) return make('add_section', `Existing page ${medium.url} covers the broader topic but not this specific question; add a focused section instead of a new page.`, medium.pageId || null);

  if (formatHintsList.includes('tool')) return make('create_tool', 'Searchers ask for a calculation/generator; an interactive tool can answer this better than an article.');
  if (formatHintsList.includes('template') || formatHintsList.includes('checklist')) return make('create_template', 'Searchers ask for a reusable template/checklist; a downloadable or copyable template is the useful format.');

  if (demand.status === 'weak' && demand.signalCount <= 1) return make('defer', 'Single weak signal: collect more evidence before creating content (no page per question by default).');
  if (!originalValueAvailable) return make('defer', 'No original contribution available yet (no product facts, differentiators, owner data, or tool/template idea): a new page would be generic.');
  return make('create_page', 'No existing page covers this validated question; a distinct page with original contribution is justified.');
}

/**
 * A decision that would change a page with an experiment under observation is
 * deferred (spec 18/23: one meaningful change per page at a time), keeping the
 * target page and saying what it would otherwise be. The next discovery after
 * the experiment concludes decides again.
 */
export function holdForObservation(ctx: AppContext, d: DecisionResult): DecisionResult {
  if (!d.targetPageId || d.decision === 'defer' || d.decision === 'reject') return d;
  const hold = observationHold(ctx, { targetPageId: d.targetPageId });
  if (!hold) return d;
  return { ...d, decision: 'defer', reason: `${hold.reason} Once it concludes, this item would be: ${d.decision.replace(/_/g, ' ')} (${d.reason})` };
}

/** Run overlap + decision for items, persisting results and decision history. */
export function checkExistingAndDecide(ctx: AppContext, items: ContentItem[]): { decisions: Record<string, number>; status: OverlapResult['status'] } {
  const now = ctx.clock.now().toISOString();
  const site = loadSitePages(ctx);
  const decisions: Record<string, number> = {};
  let status: OverlapResult['status'] = 'unavailable';
  ctx.db.transaction(() => {
    for (const item of items) {
      const signals = listSignals(ctx.db, ctx.siteId, { itemId: item.id });
      const demand = item.demand;
      if (!demand) continue;
      const overlap = computeOverlap(item, signals, site);
      status = overlap.status;
      const hints = demand.formatHints ?? [];
      const d = holdForObservation(ctx, decide(ctx, item, signals, demand, overlap, hints));
      const stage = d.decision === 'defer' ? 'deferred' : d.decision === 'reject' ? 'rejected' : 'existing_checked';
      updateItem(
        ctx.db,
        ctx.siteId,
        item.id,
        {
          stage,
          decision: d.decision,
          decisionReason: `[${DECISION_RULES_VERSION}] ${d.reason}`,
          targetPageId: d.targetPageId,
          whyExists: d.whyExists,
          whoBenefits: d.whoBenefits,
          businessRelation: d.businessRelation,
          originalValue: d.originalValue,
          readerNextStep: d.readerNextStep,
          overlap,
          demand: { ...demand, relationStrength: d.relationStrength, originalValueAvailable: d.originalValueAvailable, branded: d.branded },
        },
        now,
      );
      if (item.decision !== d.decision) {
        audit(ctx.db, ctx.siteId, 'content.decision', 'content_item', item.id, { previous: item.decision, previousReason: item.decisionReason, decision: d.decision, reason: d.reason, rulesVersion: DECISION_RULES_VERSION }, ctx.clock.now());
      }
      decisions[d.decision] = (decisions[d.decision] ?? 0) + 1;
    }
  });
  return { decisions, status: items.length ? status : site.crawlAvailable && site.gscAvailable ? 'complete' : site.crawlAvailable || site.gscAvailable ? 'partial' : 'unavailable' };
}
