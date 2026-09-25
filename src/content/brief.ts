import { z } from 'zod';
import type { AppContext } from '../app/context.js';
import type { ApprovalRecord } from '../approvals/types.js';
import { AppError } from '../core/errors.js';
import { hashObject, sha256 } from '../core/hash.js';
import { slugify } from '../core/ids.js';
import type { TrustClass } from '../core/modes.js';
import type { EvidenceItem } from '../integrations/llm/types.js';
import { getOriginalEvidence } from '../memory/evidence.js';
import { buildNumberSupport, ownerStatements, productClaims, prohibitedClaimHits, unsupportedNumbers, WORD_COUNT_RE } from './claims.js';
import { conversionHistory } from './conversion-history.js';
import type { ContentDeps } from './deps.js';
import { demandSummaryLines } from './demand.js';
import { loadSitePages, type SitePage } from './existing.js';
import { assertNotUnderObservation } from './freeze.js';
import { originLabel } from './signals.js';
import { audit, ensureSource, getItem, insertBrief, insertClaimEvidence, insertEvidence, insertQualityReview, latestBrief, listSignals, updateItem } from './store.js';
import { containment, contentTokens, detectInstructionLikeText, isQuestion, lexicalSimilarity, normalizeText, tokenSet, truncate } from './text.js';
import {
  briefSchema,
  TRUST_BY_ORIGIN,
  type BriefGateResult,
  type BriefRecord,
  type CatalogAttribute,
  type ContentBrief,
  type ContentItem,
  type ContentSignal,
  type EvidenceSource,
  type GateIssue,
  type PageType,
  type SignalOrigin,
} from './types.js';

/**
 * BRIEF: deterministic assembly (cluster, intent, overlap, evidence, demand
 * numbers, internal-link candidates, CTA target) plus optional synthesis by
 * the reasoning model (prompt `content.brief`) over a delimited evidence
 * bundle. Numbers are computed in code; the model may only reference them.
 *
 * The deterministic brief gate must pass (all required fields, evidence
 * present, no fabricated facts) before the brief becomes `gate_passed` and a
 * `draft_generation` approval can be requested for its exact hash.
 */

export const BRIEF_PROMPT_ID = 'content.brief';
export const BRIEF_GATE_VERSION = 'brief-gate@2';

export const briefSynthesisSchema = z.object({
  audience: z.string().min(1).max(600),
  primaryQuestion: z.string().min(1).max(300),
  businessPurpose: z.string().min(1).max(800),
  researchFindings: z.array(z.object({ finding: z.string().min(1).max(600), evidenceIds: z.array(z.string()), label: z.enum(['OBSERVED', 'INFERRED', 'HYPOTHESIS']) })).max(15),
  uniqueContribution: z.string().max(1200),
  /** Evidence ids (product facts, approved claims/differentiators, owner notes, validated catalog attributes) backing the unique contribution. */
  uniqueContributionEvidenceIds: z.array(z.string()).max(10).optional(),
  outline: z.array(z.object({ heading: z.string().min(1).max(200), purpose: z.string().max(400), answers: z.array(z.string().max(300)).max(8), evidenceIds: z.array(z.string()) })).min(1).max(15),
  usefulExamples: z.array(z.object({ description: z.string().min(1).max(500), evidenceIds: z.array(z.string()), needsOwnerInput: z.boolean() })).max(8),
  ctaText: z.string().min(1).max(200),
  unresolvedQuestions: z.array(z.object({ question: z.string().min(1).max(300), whyItMatters: z.string().max(400), blocking: z.boolean() })).max(15),
});
export type BriefSynthesis = z.infer<typeof briefSynthesisSchema>;

export interface BriefOptions {
  /** Use the reasoning model for synthesis when configured (default true). */
  useModel?: boolean;
  /** Build and gate the brief without persisting or calling a model. */
  preview?: boolean;
  /** Request the draft_generation approval when the gate passes (default true). */
  requestApproval?: boolean;
  bootstrap?: 'offer_page' | 'supporting_page' | null;
  catalogAttributes?: CatalogAttribute[];
  programmatic?: ContentBrief['programmatic'];
  requestedBy?: string;
  /**
   * Build a new brief version even when the latest gate-passed brief was
   * built from identical inputs (default false: an unchanged brief is reused,
   * so its id/hash and any draft approval bound to it stay valid, and no
   * model call is made).
   */
  force?: boolean;
}

export interface BriefResult {
  brief: ContentBrief;
  gate: BriefGateResult;
  record: BriefRecord | null;
  approvalRequest: ApprovalRecord | null;
  modelStatus: string;
  contentHash: string;
  /** True when the latest gate-passed brief was reused because its inputs are unchanged. */
  reused: boolean;
  /** State of the draft_generation approval for this brief (null when no approval service is wired or the gate failed). */
  approvalStatus: 'approved' | 'pending' | 'already_executed' | 'rejected' | 'requested' | 'not_requested' | 'none' | null;
}

const LOCKED_STAGES = new Set(['approved', 'exported', 'published', 'measuring']);

// ---------------------------------------------------------------------------
// Evidence bundle
// ---------------------------------------------------------------------------

function signalEvidence(s: ContentSignal): EvidenceSource {
  const eng = s.engagement ?? {};
  const metrics: string[] = [];
  if (eng.kind === 'gsc_metrics') metrics.push(`impressions ${String(eng.impressions)}, clicks ${String(eng.clicks)}, weighted position ${String(eng.weightedPosition ?? 'n/a')}`);
  if (eng.kind === 'search_volume_estimate') metrics.push(`search volume estimate ${eng.searchVolume === null ? 'not provided' : String(eng.searchVolume)}`);
  if (s.origin === 'apify_reddit') {
    const up = eng.upVotes ?? eng.upvotes ?? eng.score;
    const cm = eng.commentsCount ?? eng.comments;
    metrics.push(`engagement: ${up ?? 'n/a'} upvotes, ${cm ?? 'n/a'} comments (not search volume)`);
  }
  return {
    id: s.id,
    kind: 'signal',
    origin: s.origin,
    label: `${originLabel(s.origin)}${s.signalType !== 'query' ? ` (${s.signalType})` : ''}`,
    excerpt: truncate(s.text, 400) + (metrics.length ? ` [${metrics.join('; ')}]` : ''),
    url: s.url,
    collectedAt: s.collectedAt,
    trustClass: TRUST_BY_ORIGIN[s.origin as SignalOrigin] ?? 'scraped_untrusted',
    window: s.collectionWindow,
    limitations: s.limitations,
    isSynthetic: s.isSynthetic,
    isSandbox: false,
  };
}

function pickSignals(signals: ContentSignal[], max = 30): ContentSignal[] {
  // Round-robin across origins so one source does not crowd out the others.
  const byOrigin = new Map<string, ContentSignal[]>();
  for (const s of signals) {
    const l = byOrigin.get(s.origin) ?? [];
    l.push(s);
    byOrigin.set(s.origin, l);
  }
  for (const l of byOrigin.values()) {
    l.sort((a, b) => Number((b.engagement?.impressions as number | undefined) ?? 0) - Number((a.engagement?.impressions as number | undefined) ?? 0) || a.id.localeCompare(b.id));
  }
  const out: ContentSignal[] = [];
  const lists = [...byOrigin.values()];
  for (let i = 0; out.length < max && lists.some((l) => l.length > i); i++) for (const l of lists) if (l[i] && out.length < max) out.push(l[i]!);
  return out;
}

async function buildEvidence(ctx: AppContext, deps: ContentDeps, item: ContentItem, signals: ContentSignal[], pages: SitePage[], opts: BriefOptions, memoryIssues: string[] = []): Promise<EvidenceSource[]> {
  const ev: EvidenceSource[] = pickSignals(signals).map(signalEvidence);
  const d = item.demand;
  if (d) {
    const win = d.window ? { ...d.window } : null;
    const winText = d.window?.start && d.window?.end ? ` over ${d.window.start}..${d.window.end}` : '';
    if (d.gsc.impressions.status === 'observed') {
      ev.push({
        id: 'metric:gsc_impressions',
        kind: 'metric',
        origin: 'gsc_query',
        label: 'Search Console impressions (computed)',
        excerpt: `Search Console impressions for ${d.gsc.queries} visible member quer${d.gsc.queries === 1 ? 'y' : 'ies'}${winText}: ${d.gsc.impressions.value}.`,
        url: null,
        collectedAt: null,
        trustClass: 'first_party_measurement',
        window: win,
        limitations: 'Visible query rows only; byPage rows summed per query; not additive with property totals.',
        isSynthetic: item.isSynthetic,
        isSandbox: false,
      });
    }
    if (d.gsc.clicks.status === 'observed') {
      ev.push({
        id: 'metric:gsc_clicks',
        kind: 'metric',
        origin: 'gsc_query',
        label: 'Search Console clicks (computed)',
        excerpt: `Search Console clicks for the member queries${winText}: ${d.gsc.clicks.value}.`,
        url: null,
        collectedAt: null,
        trustClass: 'first_party_measurement',
        window: win,
        limitations: 'Visible query rows only.',
        isSynthetic: item.isSynthetic,
        isSandbox: false,
      });
    }
    if (d.gsc.weightedPosition.status === 'observed') {
      ev.push({
        id: 'metric:gsc_position',
        kind: 'metric',
        origin: 'gsc_query',
        label: 'Search Console impression-weighted position (computed)',
        excerpt: `Impression-weighted average position for the member queries${winText}: ${d.gsc.weightedPosition.value}.`,
        url: null,
        collectedAt: null,
        trustClass: 'first_party_measurement',
        window: win,
        limitations: 'Average position is an aggregate, not a point-in-time rank.',
        isSynthetic: item.isSynthetic,
        isSandbox: false,
      });
    }
    if (d.searchVolumeEstimate.max.status === 'observed') {
      ev.push({
        id: 'metric:volume_estimate',
        kind: 'metric',
        origin: 'dataforseo',
        label: 'Max monthly search-volume ESTIMATE (third-party estimate, computed)',
        excerpt: `Highest provider search-volume estimate among member keywords: ${d.searchVolumeEstimate.max.value} per month (third-party estimate, not exact demand).`,
        url: null,
        collectedAt: d.searchVolumeEstimate.keywords[0]?.collectedAt ?? null,
        trustClass: 'third_party_data',
        window: null,
        limitations: 'Third-party estimate; not exact demand.',
        isSynthetic: item.isSynthetic,
        isSandbox: false,
      });
    }
    if (d.community.threads) {
      ev.push({
        id: 'metric:community_threads',
        kind: 'metric',
        origin: 'apify_reddit',
        label: 'Community discussion count (computed)',
        excerpt: `Community discussion threads raising this topic: ${d.community.threads} (engagement, not search volume).`,
        url: null,
        collectedAt: null,
        trustClass: 'user_reported',
        window: null,
        limitations: 'User-reported discussions; not a representative survey.',
        isSynthetic: item.isSynthetic,
        isSandbox: false,
      });
    }
  }
  for (const f of ctx.config.business.productFacts) {
    ev.push({
      id: `fact:${f.id}`,
      kind: 'product_fact',
      origin: 'owner',
      label: `Product fact ${f.id}${f.verifiedAt ? ` (verified ${f.verifiedAt})` : ''}`,
      excerpt: f.statement,
      url: f.source && /^https?:/i.test(f.source) ? f.source : null,
      collectedAt: f.verifiedAt,
      trustClass: 'owner_approved',
      window: null,
      limitations: f.source ? `Source: ${f.source}` : 'Owner-provided; source not recorded.',
      isSynthetic: false,
      isSandbox: false,
    });
  }
  ctx.config.business.approvedClaims.forEach((c, i) =>
    ev.push({ id: `claim:${i + 1}`, kind: 'approved_claim', origin: 'owner', label: `Approved claim ${i + 1}`, excerpt: c, url: null, collectedAt: null, trustClass: 'owner_approved', window: null, limitations: 'Owner-approved wording.', isSynthetic: false, isSandbox: false }),
  );
  ctx.config.business.differentiators.forEach((c, i) =>
    ev.push({ id: `differentiator:${i + 1}`, kind: 'approved_claim', origin: 'owner', label: `Differentiator ${i + 1}`, excerpt: c, url: null, collectedAt: null, trustClass: 'owner_approved', window: null, limitations: 'Owner-stated differentiator.', isSynthetic: false, isSandbox: false }),
  );
  if (ctx.config.business.offer) {
    ev.push({ id: 'offer', kind: 'approved_claim', origin: 'owner', label: 'Offer (site config)', excerpt: ctx.config.business.offer, url: null, collectedAt: null, trustClass: 'owner_approved', window: null, limitations: 'Owner-provided offer description.', isSynthetic: false, isSandbox: false });
  }
  if (opts.bootstrap === 'offer_page') {
    const conv = conversionHistory(ctx);
    if (conv.rows > 0) {
      ev.push({
        id: 'metric:ga4_primary_events',
        kind: 'metric',
        origin: 'ga4',
        label: 'Stored GA4 primary-event rows (computed)',
        excerpt: conv.statement,
        url: null,
        collectedAt: null,
        trustClass: 'first_party_measurement',
        window: conv.firstDate && conv.lastDate ? { start: conv.firstDate, end: conv.lastDate, timeZone: null, description: 'Stored GA4 event rows for the primary events' } : null,
        limitations: 'Existing-site conversion history; not attributed to the proposed pages. Rows span channel views and landing pages and are not summed.',
        isSynthetic: item.isSynthetic,
        isSandbox: false,
      });
    }
  }
  const target = item.targetPageId ? pages.find((p) => p.pageId === item.targetPageId) : undefined;
  if (target && !(item.overlap?.pages ?? []).some((o) => o.pageId === target.pageId)) {
    ev.push({
      id: `page:${target.pageId}`,
      kind: 'page',
      origin: 'own_site',
      label: `Target page ${target.url}`,
      excerpt: [target.title ? `Title: ${target.title}` : 'Title not crawled', target.metaDescription ? `Meta: ${target.metaDescription}` : '', target.headings.length ? `Headings: ${target.headings.slice(0, 8).join(' | ')}` : ''].filter(Boolean).join('. '),
      url: target.url,
      collectedAt: target.crawledAt,
      trustClass: 'first_party_measurement',
      window: null,
      limitations: target.crawledAt ? 'Latest own-site crawl observation.' : 'Page known from the registry; not crawled yet.',
      isSynthetic: item.isSynthetic,
      isSandbox: false,
    });
  }
  for (const o of item.overlap?.pages ?? []) {
    const p = pages.find((x) => x.pageId === o.pageId || x.url === o.url);
    ev.push({
      id: `page:${o.pageId || slugify(o.url, 40)}`,
      kind: 'page',
      origin: 'own_site',
      label: `Our page ${o.url}`,
      excerpt: [p?.title ? `Title: ${p.title}` : '', p?.headings.length ? `Headings: ${p.headings.slice(0, 8).join(' | ')}` : '', ...o.evidence].filter(Boolean).join('. '),
      url: o.url,
      collectedAt: p?.crawledAt ?? null,
      trustClass: 'first_party_measurement',
      window: null,
      limitations: 'Own-site crawl/Search Console observation; overlap is heuristic.',
      isSynthetic: item.isSynthetic,
      isSandbox: false,
    });
  }
  for (const a of opts.catalogAttributes ?? []) {
    ev.push({
      id: `attr:${slugify(a.name, 40)}`,
      kind: 'catalog_attribute',
      origin: a.source,
      label: `${a.validated ? 'Validated' : 'UNVERIFIED'} catalog attribute: ${a.name}`,
      excerpt: `${a.name}: ${a.value}`,
      url: null,
      collectedAt: null,
      trustClass: a.validated && (a.source === 'catalog' || a.source === 'owner') ? 'owner_approved' : 'model_generated',
      window: null,
      limitations: a.validated ? 'Validated catalog attribute.' : 'Not validated (image-suggested or model-derived): must stay marked unverified.',
      isSynthetic: false,
      isSandbox: false,
    });
  }
  if (deps.memory) {
    const res = await deps.memory.search({
      siteId: ctx.siteId,
      text: item.primaryQuestion ?? item.title,
      sourceTypes: ['business_note', 'decision', 'approved_learning', 'rejected_proposal', 'experiment_summary'],
      limit: 5,
      contextBudgetTokens: 1500,
    });
    for (const c of res.chunks) {
      if (c.documentStatus === 'deleted') continue;
      // Spec §8: fetch the original supporting evidence before reusing a consequential claim.
      const original = getOriginalEvidence(ctx, c);
      if (original.status === 'missing' || original.status === 'not_found') {
        memoryIssues.push(`Retrieved note "${truncate(c.title, 60)}" (${c.sourceRef}) was not used: ${original.status === 'missing' ? 'its original no longer exists' : 'the chunk is unknown to this site\'s memory store'} (${truncate(original.note, 120)}).`);
        continue;
      }
      const recordStatus = original.recordStatus ?? c.recordStatus;
      const documentStatus = original.documentStatus ?? c.documentStatus;
      const label = `${c.title}${recordStatus ? ` [status: ${recordStatus}]` : ''}${documentStatus !== 'active' ? ` [${documentStatus}]` : ''}`;
      const base = recordStatus === 'rejected' ? 'Rejected proposal: context only, NOT a recommendation.' : `Retrieved note (${c.sourceRef}).`;
      if (original.status === 'changed') {
        // Stale: the original changed after indexing. Kept as context only, never as owner-approved support.
        memoryIssues.push(`Retrieved note "${truncate(c.title, 60)}" (${c.sourceRef}) changed after it was indexed: its old text is context only and supports no claim. Run \`memory sync\` and re-verify.`);
        ev.push({
          id: `mem:${c.chunkId}`,
          kind: 'memory',
          origin: c.sourceType,
          label: `${label} [STALE: changed since indexing]`,
          excerpt: truncate(c.text, 600),
          url: c.sourceUrl,
          collectedAt: c.sourceDate,
          trustClass: c.trustClass === 'synthetic' ? 'synthetic' : 'user_reported',
          window: null,
          limitations: `${base} STALE: the original changed after this text was indexed (${truncate(original.note, 160)}). Not owner-approved support for any claim or number; re-verify against the current note.`,
          isSynthetic: c.trustClass === 'synthetic',
          isSandbox: false,
        });
        continue;
      }
      // Found: the original matches the indexed version. Prefer the original's text (verified), keeping the
      // retrieved passage when it is part of the original (the whole note may be long).
      const origText = original.original?.text ?? null;
      const passageInOriginal = !!origText && normalizeText(origText).includes(normalizeText(c.text));
      const excerpt = origText && !passageInOriginal ? origText : c.text;
      const trustClass = original.trustClass ?? c.trustClass;
      ev.push({
        id: `mem:${c.chunkId}`,
        kind: 'memory',
        origin: c.sourceType,
        label: `${label} [original verified]`,
        excerpt: truncate(excerpt, 600),
        url: original.original?.url ?? c.sourceUrl,
        collectedAt: original.original?.retrievedAt ?? c.sourceDate,
        trustClass,
        window: null,
        limitations: `${base} Checked against the original (${original.original?.kind ?? 'record'} ${original.original?.ref ?? c.sourceRef}).`,
        isSynthetic: trustClass === 'synthetic',
        isSandbox: false,
      });
    }
  }
  return ev;
}

// ---------------------------------------------------------------------------
// Deterministic brief
// ---------------------------------------------------------------------------

function pageTypeFor(item: ContentItem, target: SitePage | undefined, opts: BriefOptions): PageType {
  if (opts.bootstrap === 'offer_page') return 'offer';
  switch (item.decision) {
    case 'create_tool':
      return 'tool';
    case 'create_template':
      return 'template';
    case 'improve_existing':
    case 'add_section': {
      const t = target?.pageType;
      return t && (['article', 'guide', 'faq_section', 'comparison', 'tool', 'template', 'offer', 'category', 'product', 'landing'] as string[]).includes(t) ? (t as PageType) : 'other';
    }
    default: {
      const hints = item.demand?.formatHints ?? [];
      if (item.intent === 'commercial' && hints.includes('comparison')) return 'comparison';
      if (hints.includes('guide')) return 'guide';
      return 'article';
    }
  }
}

function offerPage(ctx: AppContext, pages: SitePage[]): SitePage | undefined {
  return pages.find((p) => p.pageType === 'offer') ?? pages.find((p) => p.path === '/' || p.url === ctx.config.site.url);
}

export function buildDeterministicBrief(ctx: AppContext, item: ContentItem, signals: ContentSignal[], evidence: EvidenceSource[], pages: SitePage[], opts: BriefOptions): ContentBrief {
  const cfg = ctx.config;
  const target = item.targetPageId ? pages.find((p) => p.pageId === item.targetPageId) : undefined;
  const pageType = pageTypeFor(item, target, opts);
  const primaryQuestion = item.primaryQuestion ?? item.title;
  const evIds = new Set(evidence.map((e) => e.id));
  // Competitor headings are topic prompts, never outline headings (do not copy competitor structure).
  const questions = [...new Set(signals.filter((s) => s.origin !== 'competitor_gap' && isQuestion(s.text)).map((s) => s.text.trim()))];
  const fallbackQueries = opts.bootstrap === 'offer_page' ? [primaryQuestion, ...(cfg.business.offer ? [cfg.business.offer] : []), ...cfg.research.seedTopics] : [primaryQuestion];
  const queries = [...new Set((signals.length ? signals.map((s) => s.text.trim()) : fallbackQueries).filter(Boolean))].slice(0, 25);
  const itemTokens = tokenSet([item.title, primaryQuestion, ...queries].join(' '));
  const facts = cfg.business.productFacts.filter((f) => opts.bootstrap === 'offer_page' || [...tokenSet(f.statement)].some((t) => itemTokens.has(t)));
  const offer = offerPage(ctx, pages);
  const primaryEvent = cfg.conversions.primaryEvents[0] ?? null;
  const decision = item.decision ?? 'defer';
  const baseUrl = cfg.site.url.replace(/\/+$/, '');
  const proposedUrl = decision === 'improve_existing' || decision === 'add_section' ? (target?.url ?? null) : opts.bootstrap === 'offer_page' && offer ? offer.url : `${baseUrl}/${slugify(item.title, 60)}/`;

  const unresolved: ContentBrief['unresolvedQuestions'] = [];
  if (!cfg.business.targetCustomer) unresolved.push({ question: 'Who exactly is the target customer for this page?', whyItMatters: 'business.targetCustomer is not configured; audience and examples depend on it.', blocking: false });
  if (!facts.length) unresolved.push({ question: 'Which verified product facts apply to this topic?', whyItMatters: 'Without supplied facts the draft may not describe the product at all; any product statement would be unverified.', blocking: false });
  if (!primaryEvent) unresolved.push({ question: 'What is the primary conversion for readers of this page?', whyItMatters: 'conversions.primaryEvents is empty; the CTA cannot be tied to a measured outcome.', blocking: false });
  if (!cfg.market.languages.length) unresolved.push({ question: 'Which language should this content use?', whyItMatters: 'market.languages is empty; language cannot be verified.', blocking: false });
  if (item.overlap?.status === 'partial') unresolved.push({ question: 'Confirm no existing page already covers this question.', whyItMatters: item.overlap.statusReason, blocking: false });
  if (item.overlap?.cannibalization.risk === 'medium' || item.overlap?.cannibalization.risk === 'high') unresolved.push({ question: 'Could this compete with an existing page?', whyItMatters: item.overlap.cannibalization.explanation, blocking: false });
  if (item.isSynthetic || evidence.some((e) => e.isSynthetic)) unresolved.push({ question: 'This brief uses SYNTHETIC fixture data.', whyItMatters: 'Synthetic data must never be used for real publication.', blocking: false });
  for (const a of opts.catalogAttributes ?? []) if (!a.validated) unresolved.push({ question: `Is "${a.name}: ${a.value}" correct?`, whyItMatters: `Attribute from ${a.source} is not validated; it must stay marked unverified.`, blocking: false });

  const d = item.demand;
  const findings: ContentBrief['researchFindings'] = [];
  if (d?.gsc.impressions.status === 'observed' && evIds.has('metric:gsc_impressions')) findings.push({ finding: evidence.find((e) => e.id === 'metric:gsc_impressions')!.excerpt, evidenceIds: ['metric:gsc_impressions'], label: 'OBSERVED' });
  if (d?.gsc.weightedPosition.status === 'observed' && evIds.has('metric:gsc_position')) findings.push({ finding: evidence.find((e) => e.id === 'metric:gsc_position')!.excerpt, evidenceIds: ['metric:gsc_position'], label: 'OBSERVED' });
  // A provider search-volume figure is a third-party estimate: INFERRED, never an observed demand measurement.
  if (evIds.has('metric:volume_estimate')) findings.push({ finding: evidence.find((e) => e.id === 'metric:volume_estimate')!.excerpt, evidenceIds: ['metric:volume_estimate'], label: 'INFERRED' });
  if (evIds.has('metric:community_threads')) findings.push({ finding: evidence.find((e) => e.id === 'metric:community_threads')!.excerpt, evidenceIds: ['metric:community_threads'], label: 'OBSERVED' });
  // Questions in people's own words (never owner-provided topics). Only manual customer-question imports are
  // customers; Reddit posters (collected via Apify) are unverified community users, never called customers.
  const customerAsked = signals.filter((s) => s.origin === 'manual').slice(0, 3);
  if (customerAsked.length) findings.push({ finding: `Customers raise this question in their own words (${originLabel('manual')}).`, evidenceIds: customerAsked.map((s) => s.id).filter((id) => evIds.has(id)), label: 'OBSERVED' });
  const communityAsked = signals.filter((s) => s.origin === 'apify_reddit').slice(0, 3);
  if (communityAsked.length) {
    findings.push({
      finding: 'Users in community discussions (Reddit, via Apify) raise this question in their own words. They are unverified posters, not known customers, and the posts are user-reported, not measured demand.',
      evidenceIds: communityAsked.map((s) => s.id).filter((id) => evIds.has(id)),
      label: 'OBSERVED',
    });
  }
  const ownerTopics = signals.filter((s) => s.origin === 'business_knowledge').slice(0, 3);
  if (ownerTopics.length) {
    findings.push({
      finding: `The owner lists this as a business topic (site config / business notes): ${ownerTopics.map((s) => `"${truncate(s.text, 80)}"`).join(', ')}. This is owner-provided relevance, not a customer question or demand evidence.`,
      evidenceIds: ownerTopics.map((s) => s.id).filter((id) => evIds.has(id)),
      label: 'OBSERVED',
    });
  }
  const competitorQs = signals.filter((s) => s.origin === 'competitor_gap' && isQuestion(s.text) && evIds.has(s.id)).slice(0, 5);
  if (competitorQs.length) {
    findings.push({
      finding: `Competitor pages cover related questions (topic prompt, do not copy): ${competitorQs.map((s) => `"${truncate(s.text, 80)}"`).join(', ')}. Use them only to check that the reader's needs are covered in our own words; they are not required sections.`,
      evidenceIds: competitorQs.map((s) => s.id),
      label: 'OBSERVED',
    });
  }
  for (const o of (item.overlap?.pages ?? []).slice(0, 2)) {
    const id = `page:${o.pageId || slugify(o.url, 40)}`;
    if (evIds.has(id)) findings.push({ finding: `Existing page ${o.url} overlaps (${o.confidence} confidence): ${o.evidence[0] ?? 'heuristic overlap'}`, evidenceIds: [id], label: 'INFERRED' });
  }
  if (opts.bootstrap === 'offer_page') {
    if (target && evIds.has(`page:${target.pageId}`)) findings.push({ finding: `Current offer page: ${target.url}${target.title ? ` (title "${truncate(target.title, 80)}")` : ''}.`, evidenceIds: [`page:${target.pageId}`], label: 'OBSERVED' });
    for (const f of facts.slice(0, 3)) findings.push({ finding: `Owner-verified product fact: "${truncate(f.statement, 160)}"`, evidenceIds: [`fact:${f.id}`], label: 'OBSERVED' });
    // Same query as the bootstrap's conversion_data readiness check: stated when rows exist, never assumed.
    const conv = conversionHistory(ctx);
    if (conv.rows > 0 && evIds.has('metric:ga4_primary_events')) findings.push({ finding: conv.statement, evidenceIds: ['metric:ga4_primary_events'], label: 'OBSERVED' });
    else findings.push({ finding: conv.statement, evidenceIds: [], label: 'DATA_UNAVAILABLE' });
  }
  if (!findings.some((f) => f.label !== 'DATA_UNAVAILABLE') && signals[0] && evIds.has(signals[0].id)) findings.push({ finding: `Signal: "${truncate(signals[0].text, 160)}" (${originLabel(signals[0].origin)}).`, evidenceIds: [signals[0].id], label: 'OBSERVED' });

  const outline: ContentBrief['outline'] = [];
  const signalFor = (text: string) => signals.find((s) => s.text.trim() === text);
  const verb = decision === 'improve_existing' ? 'Update on the existing page' : decision === 'add_section' ? 'New section on the existing page' : null;
  outline.push({
    heading: verb ? `${verb}: ${truncate(primaryQuestion, 100)}` : truncate(primaryQuestion, 140),
    purpose: 'Answer the primary question directly in the opening lines.',
    answers: [primaryQuestion],
    evidenceIds: [signalFor(primaryQuestion)?.id ?? signals[0]?.id].filter((x): x is string => !!x && evIds.has(x)),
  });
  for (const q of questions.filter((x) => lexicalSimilarity(x, primaryQuestion) < 0.8).slice(0, 6)) {
    const origin = signalFor(q)?.origin;
    const askedBy = origin === 'manual' ? 'customers ask' : origin === 'apify_reddit' ? 'community users ask (Reddit, via Apify)' : 'readers ask';
    outline.push({ heading: truncate(q, 140), purpose: `Answer a related question ${askedBy}.`, answers: [q], evidenceIds: [signalFor(q)?.id].filter((x): x is string => !!x && evIds.has(x)) });
  }
  // Owner-approved original value for this topic: verified product facts first, then real differentiators.
  const diffIds = cfg.business.differentiators.map((d, i) => ({ d, id: `differentiator:${i + 1}` })).filter(({ d }) => opts.bootstrap === 'offer_page' || [...tokenSet(d)].some((t) => itemTokens.has(t)));
  const ownerPoints = [...facts.map((f) => ({ text: f.statement, id: `fact:${f.id}` })), ...diffIds.map((x) => ({ text: x.d, id: x.id }))].filter((p) => evIds.has(p.id));
  if (ownerPoints.length) {
    outline.push({
      heading: `How ${cfg.site.businessName.replace(/\s*\(.*?\)\s*/g, ' ').trim()} fits`,
      purpose: 'Connect the answer to verified product facts and owner-approved differentiators only.',
      answers: ownerPoints.slice(0, 4).map((p) => p.text),
      evidenceIds: ownerPoints.slice(0, 4).map((p) => p.id),
    });
  }
  outline.push({ heading: 'Next step', purpose: 'Give the reader one clear next step.', answers: [item.readerNextStep ?? 'Next step not defined.'], evidenceIds: [] });

  const examples: ContentBrief['usefulExamples'] = ownerPoints.length
    ? ownerPoints.slice(0, 2).map((p) => ({ description: `Worked example showing how "${truncate(p.text, 100)}" applies to the reader's situation.`, evidenceIds: [p.id], needsOwnerInput: false }))
    : [{ description: 'Owner to supply one real example (customer scenario, screenshot, or data) that answers the primary question.', evidenceIds: [], needsOwnerInput: true }];

  const linkTargets: ContentBrief['internalLinks'] = [];
  const addLink = (p: SitePage, reason: string) => {
    if (linkTargets.some((l) => l.targetUrl === p.url) || p.url === proposedUrl) return;
    const verified = (p.lifecycle === 'active' || p.lifecycle === 'unknown') && p.statusCode !== null && p.statusCode >= 200 && p.statusCode < 300;
    linkTargets.push({ targetUrl: p.url, anchorSuggestion: truncate(p.title ?? p.path, 60), reason: verified ? reason : `${reason} (not verified: no successful crawl result recorded)`, verified });
  };
  if (offer) addLink(offer, 'Offer page: supports the reader next step.');
  for (const o of item.overlap?.pages ?? []) {
    const p = pages.find((x) => x.pageId === o.pageId);
    if (p && p.pageId !== item.targetPageId) addLink(p, 'Related existing page with topic overlap.');
  }
  for (const p of pages) {
    if (linkTargets.length >= 5) break;
    const shared = [...p.tokens].filter((t) => itemTokens.has(t));
    if (shared.length >= 2) addLink(p, `Shares topic terms: ${shared.slice(0, 4).join(', ')}.`);
  }

  // Unique contribution: only what the reader gets from US (facts, differentiators, owner data, a tool/template),
  // with the backing evidence ids. Search impressions and customer questions are demand, not original value.
  const ucIds = [...facts.map((f) => `fact:${f.id}`), ...diffIds.map((x) => x.id), ...(opts.catalogAttributes ?? []).filter((a) => a.validated && (a.source === 'catalog' || a.source === 'owner')).map((a) => `attr:${slugify(a.name, 40)}`)].filter((id) => evIds.has(id));
  const toolOrTemplate = decision === 'create_tool' || decision === 'create_template';
  const ucParts: string[] = [];
  if (facts.length) ucParts.push(`verified product facts (${facts.map((f) => f.id).join(', ')})`);
  if (diffIds.length) ucParts.push(`real differentiators ("${truncate(diffIds[0]!.d, 80)}")`);
  if (toolOrTemplate) ucParts.push(`a practical ${decision === 'create_tool' ? 'tool' : 'template'} the reader can use directly`);
  const uniqueContribution = ucParts.length ? `Use ${ucParts.join('; ')}.` : '';
  const audience = cfg.business.targetCustomer
    ? `${cfg.business.targetCustomer} who ask "${truncate(primaryQuestion, 120)}".`
    : `People asking "${truncate(primaryQuestion, 120)}" (target customer not configured; confirm).`;
  const decisionLabel = decision.replace(/_/g, ' ');

  return {
    schemaVersion: 1,
    contentItemId: item.id,
    siteId: ctx.siteId,
    language: cfg.market.languages[0] ?? 'und',
    audience,
    primaryQuestion,
    queryCluster: { clusterId: item.clusterId, label: item.title, queries, signalCount: signals.length, origins: [...new Set(signals.map((s) => s.origin))].sort() },
    intent: item.intent ?? 'unsure',
    decision,
    proposedUrl,
    targetPageUrl: target?.url ?? null,
    pageType,
    existingPageOverlap: {
      status: item.overlap?.status ?? 'unavailable',
      pages: (item.overlap?.pages ?? []).map((p) => ({ url: p.url, confidence: p.confidence, score: p.score, evidence: p.evidence })),
      cannibalizationRisk: `${item.overlap?.cannibalization.risk ?? 'unknown'}: ${item.overlap?.cannibalization.explanation ?? 'not checked'}`,
      uncertainty: item.overlap?.uncertainty ?? 'Existing content not checked.',
    },
    businessPurpose: `${decisionLabel[0]!.toUpperCase()}${decisionLabel.slice(1)}. ${item.businessRelation ?? ''} Reader next step: ${item.readerNextStep ?? 'not defined'}`.trim(),
    researchFindings: findings,
    evidenceSources: evidence,
    uniqueContribution,
    uniqueContributionEvidenceIds: ucIds,
    outline,
    usefulExamples: examples,
    internalLinks: linkTargets,
    cta: {
      text: `Next step: ${item.readerNextStep ?? 'visit the offer page'}`,
      targetUrl: offer?.url ?? null,
      conversionEvent: primaryEvent?.name ?? null,
      rationale: primaryEvent ? `Ties to primary conversion "${primaryEvent.name}" (${primaryEvent.meaning}).` : 'No primary conversion configured; CTA cannot be tied to a measured outcome.',
    },
    unresolvedQuestions: unresolved,
    productFactIds: facts.map((f) => f.id),
    catalogAttributes: opts.catalogAttributes ?? [],
    programmatic: opts.programmatic ?? { isProgrammatic: false, templateId: null, differentiatingData: [] },
    demandSummary: d ? demandSummaryLines(d) : [],
    rationale: {
      whyExists: item.whyExists ?? '',
      whoBenefits: item.whoBenefits ?? '',
      businessRelation: item.businessRelation ?? '',
      originalValue: item.originalValue ?? '',
      readerNextStep: item.readerNextStep ?? '',
    },
    generatedBy: { synthesized: false, promptVersion: null, model: null, note: 'Deterministic brief assembled in code from stored evidence.' },
    isSynthetic: item.isSynthetic || evidence.some((e) => e.isSynthetic),
    bootstrap: opts.bootstrap ?? null,
  };
}

/** Merge validated model synthesis into the deterministic brief; unknown evidence ids are dropped. */
export function mergeSynthesis(base: ContentBrief, s: BriefSynthesis, meta: { promptVersion: string; model: string }): { brief: ContentBrief; dropped: string[] } {
  const known = new Set(base.evidenceSources.map((e) => e.id));
  const dropped: string[] = [];
  const keep = (ids: string[], where: string) =>
    ids.filter((id) => {
      if (known.has(id)) return true;
      dropped.push(`${where}: unknown evidence id "${truncate(id, 40)}"`);
      return false;
    });
  const findings = s.researchFindings
    .map((f, i) => ({ ...f, evidenceIds: keep(f.evidenceIds, `finding ${i + 1}`) }))
    .filter((f, i) => {
      if (f.evidenceIds.length) return true;
      dropped.push(`finding ${i + 1} removed: no valid evidence reference`);
      return false;
    });
  const primaryQuestion = lexicalSimilarity(s.primaryQuestion, base.primaryQuestion) >= 0.3 ? s.primaryQuestion : base.primaryQuestion;
  if (primaryQuestion !== s.primaryQuestion) dropped.push('primaryQuestion: model rewrite drifted from the discovered question; kept the original');
  const unresolved = [...base.unresolvedQuestions];
  for (const q of s.unresolvedQuestions) if (!unresolved.some((u) => lexicalSimilarity(u.question, q.question) >= 0.8)) unresolved.push(q);
  return {
    brief: {
      ...base,
      audience: s.audience,
      primaryQuestion,
      businessPurpose: s.businessPurpose,
      // Code-computed findings stay: metrics (observed or estimated), explicit absence statements, competitor topic prompts.
      researchFindings: [...base.researchFindings.filter((f) => f.label === 'DATA_UNAVAILABLE' || f.evidenceIds.some((id) => id.startsWith('metric:')) || /topic prompt, do not copy/.test(f.finding)), ...findings],
      uniqueContribution: s.uniqueContribution,
      uniqueContributionEvidenceIds: keep(s.uniqueContributionEvidenceIds ?? [], 'uniqueContribution'),
      outline: s.outline.map((o, i) => ({ ...o, evidenceIds: keep(o.evidenceIds, `outline ${i + 1}`) })),
      usefulExamples: s.usefulExamples.length ? s.usefulExamples.map((e, i) => ({ ...e, evidenceIds: keep(e.evidenceIds, `example ${i + 1}`) })) : base.usefulExamples,
      cta: { ...base.cta, text: s.ctaText },
      unresolvedQuestions: unresolved,
      generatedBy: { synthesized: true, promptVersion: meta.promptVersion, model: meta.model, note: 'Model synthesis over a delimited evidence bundle; numbers computed in code; validated by the brief gate.' },
    },
    dropped,
  };
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export function runBriefGate(ctx: AppContext, brief: ContentBrief, extra: { dropped?: string[] } = {}): BriefGateResult {
  const issues: GateIssue[] = [];
  const err = (code: string, field: string, message: string) => issues.push({ code, field, message, severity: 'error' });
  const warn = (code: string, field: string, message: string) => issues.push({ code, field, message, severity: 'warning' });

  const parsed = briefSchema.safeParse(brief);
  if (!parsed.success) for (const i of parsed.error.issues.slice(0, 10)) err('schema', i.path.join('.'), i.message);

  const text = (v: string | undefined | null) => (v ?? '').trim().length >= 3;
  if (!text(brief.audience)) err('missing_field', 'audience', 'Audience is required.');
  if (!text(brief.primaryQuestion)) err('missing_field', 'primaryQuestion', 'Primary question is required.');
  if (!text(brief.businessPurpose)) err('missing_field', 'businessPurpose', 'Business purpose is required.');
  if (!text(brief.uniqueContribution)) err('missing_field', 'uniqueContribution', 'Unique contribution is required: without original value the page would be generic. Add product facts, examples, data, or a tool idea.');
  if (!text(brief.cta.text)) err('missing_field', 'cta', 'A call to action is required.');
  if (!brief.queryCluster.queries.length) err('missing_field', 'queryCluster', 'Query cluster has no members.');
  if (brief.intent === 'unsure') err('intent_unresolved', 'intent', 'Intent is unresolved; classify before briefing.');
  if (brief.intent === 'navigational') err('not_actionable', 'intent', 'Navigational queries are not content opportunities.');
  if (brief.decision === 'defer' || brief.decision === 'reject') err('not_actionable', 'decision', `Decision is "${brief.decision}"; no content should be produced.`);
  if (!brief.proposedUrl && !brief.targetPageUrl) err('missing_field', 'proposedUrl', 'Proposed URL or target page is required.');
  if (brief.existingPageOverlap.status === 'unavailable') {
    if (brief.bootstrap === 'offer_page') warn('existing_check_missing', 'existingPageOverlap', 'Existing pages not checked (no crawl/GSC data).');
    else err('existing_check_missing', 'existingPageOverlap', 'Existing-content check unavailable: crawl the site or sync Search Console before briefing new content.');
  }
  if (!brief.outline.length || brief.outline.length < 2) err('missing_field', 'outline', 'Outline needs at least two sections.');
  if (brief.outline.some((o) => !o.heading.trim())) err('missing_field', 'outline', 'Every outline section needs a heading.');
  const contentSections = brief.outline.filter((o) => !/^next step$/i.test(o.heading.trim()));
  if (brief.outline.length >= 2 && contentSections.length < 2) {
    err('outline_too_thin', 'outline', `Outline has ${contentSections.length} content section(s) besides "Next step": a page needs at least two sections that answer the reader (add related questions or a section built on product facts/examples).`);
  }
  if (!brief.usefulExamples.length) err('missing_field', 'usefulExamples', 'At least one useful example is required.');
  else if (brief.usefulExamples.every((e) => e.needsOwnerInput)) {
    err('examples_need_owner_input', 'usefulExamples', 'Every example still needs owner input: a placeholder is not a useful example. Ask the owner for one real example (customer scenario, data, screenshot) or add product facts it can be built on, then rebuild the brief.');
  }
  if (!brief.internalLinks.length) warn('no_internal_links', 'internalLinks', 'No internal link candidates found.');
  for (const l of brief.internalLinks) if (!l.verified) warn('unverified_internal_link', 'internalLinks', `${l.targetUrl} is not verified by a successful crawl.`);
  if (!brief.cta.targetUrl) warn('cta_without_target', 'cta', 'CTA has no verified target page.');

  // Evidence.
  const evidenceIds = new Set(brief.evidenceSources.map((e) => e.id));

  // Unique contribution must rest on original value: product facts, approved claims/differentiators, owner-approved
  // notes/data, or validated catalog attributes (or be a tool/template itself). Search impressions and the existence
  // of customer questions are demand evidence, not something the reader gets from us.
  if (text(brief.uniqueContribution)) {
    const qualifying = brief.evidenceSources.filter(isOriginalValueEvidence);
    const qualIds = new Set(qualifying.map((e) => e.id));
    const unknownCited = (brief.uniqueContributionEvidenceIds ?? []).filter((id) => !evidenceIds.has(id));
    for (const id of unknownCited) warn('unknown_evidence_id', 'uniqueContributionEvidenceIds', `Unknown evidence id "${truncate(id, 40)}" cited for the unique contribution.`);
    const cited = (brief.uniqueContributionEvidenceIds ?? []).filter((id) => qualIds.has(id));
    const nonQualifying = (brief.uniqueContributionEvidenceIds ?? []).filter((id) => evidenceIds.has(id) && !qualIds.has(id));
    const ucTokens = new Set(contentTokens(brief.uniqueContribution));
    const inline = qualifying.filter((e) => brief.uniqueContribution.includes(e.id));
    const restated = qualifying.filter((e) => {
      const t = new Set(contentTokens(e.excerpt));
      return t.size >= 2 && containment(t, ucTokens) >= 0.6;
    });
    const toolOrTemplate = brief.decision === 'create_tool' || brief.decision === 'create_template';
    if (!cited.length && !inline.length && !restated.length && !toolOrTemplate) {
      err(
        'unique_contribution_unsupported',
        'uniqueContribution',
        `The unique contribution cites no original value (product facts, approved claims/differentiators, owner-approved notes/data, or validated catalog attributes)${nonQualifying.length ? `; cited ${nonQualifying.join(', ')} are demand or research evidence, not original value` : ''}. Search impressions and customer questions show demand; they are not something the reader gets from this page.`,
      );
    }
  }
  if (!brief.evidenceSources.length) err('no_evidence', 'evidenceSources', 'No evidence sources.');
  if (brief.evidenceSources.length && brief.evidenceSources.every((e) => e.trustClass === 'model_generated')) err('no_evidence', 'evidenceSources', 'Only model-generated evidence; real sources are required.');
  if (brief.evidenceSources.some((e) => e.isSandbox)) err('sandbox_evidence', 'evidenceSources', 'Sandbox research data cannot support a real brief.');
  if (brief.evidenceSources.some((e) => e.isSynthetic)) warn('synthetic_evidence', 'evidenceSources', 'SYNTHETIC fixture evidence: never for real publication.');
  if (!brief.researchFindings.some((f) => f.label !== 'DATA_UNAVAILABLE')) err('no_findings', 'researchFindings', 'At least one evidence-backed research finding is required.');
  brief.researchFindings.forEach((f, i) => {
    if (f.label === 'DATA_UNAVAILABLE' && !f.evidenceIds.length) return; // explicit statement of absent data
    const valid = f.evidenceIds.filter((id) => evidenceIds.has(id));
    if (!valid.length) err('finding_without_evidence', `researchFindings.${i}`, `Finding "${truncate(f.finding, 80)}" has no valid evidence reference.`);
    // A finding describes the evidence it cites: numbers must match that evidence at claim level (dates/windows excluded).
    // Cited third-party estimates support a number only in a sentence that calls it an estimate.
    const cited = brief.evidenceSources.filter((e) => valid.includes(e.id));
    const support = buildNumberSupport(cited.filter((e) => !isEstimateEvidence(e)).map((e) => ({ id: e.id, text: e.excerpt })));
    const estimateSupport = buildNumberSupport(cited.filter(isEstimateEvidence).map((e) => ({ id: e.id, text: e.excerpt })));
    for (const n of unsupportedNumbers(f.finding, support, { estimateSupport })) if (n.kind !== 'year') err('unsupported_number', `researchFindings.${i}`, `Number "${n.raw}" is not stated for this claim in the referenced evidence${estimateSupport.numbers.some((x) => x.value === n.value) ? ' (a third-party estimate supports it only when the sentence calls it an estimate)' : ''}.`);
  });

  // No fabricated facts elsewhere: numbers need claim-level support from owner statements or owner-approved /
  // first-party evidence (never Reddit, competitor, scraped, or stale memory text). Third-party search-volume
  // ESTIMATES support a number only in a sentence that explicitly calls it an estimate.
  const trusted = brief.evidenceSources.filter((e) => !e.isSandbox && !isEstimateEvidence(e) && (e.trustClass === 'owner_approved' || e.trustClass === 'first_party_measurement'));
  const allSupport = buildNumberSupport([
    ...ownerStatements(ctx.config),
    ...trusted.map((e) => ({ id: e.id, text: e.excerpt })),
    ...brief.demandSummary.filter((d) => d.label === 'OBSERVED').map((d, i) => ({ id: `demand:${i}`, text: `${d.metric}: ${d.value}` })),
    ...brief.catalogAttributes.filter((a) => a.validated && (a.source === 'catalog' || a.source === 'owner')).map((a) => ({ id: `attr:${a.name}`, text: `${a.name} ${a.value}` })),
  ]);
  const estimateSupport = buildNumberSupport([
    ...brief.evidenceSources.filter((e) => !e.isSandbox && isEstimateEvidence(e)).map((e) => ({ id: e.id, text: e.excerpt })),
    ...brief.demandSummary.filter((d) => d.label === 'INFERRED' && /estimate/i.test(d.metric)).map((d, i) => ({ id: `demand_estimate:${i}`, text: `${d.metric}: ${d.value}` })),
  ]);
  const freeText: Array<[string, string]> = [
    ['primaryQuestion', brief.primaryQuestion],
    ['uniqueContribution', brief.uniqueContribution],
    ['audience', brief.audience],
    ['businessPurpose', brief.businessPurpose],
    ['cta', brief.cta.text],
    ...brief.outline.flatMap((o, i) => [[`outline.${i}`, [o.heading, o.purpose, ...o.answers].join('\n')]] as Array<[string, string]>),
    ...brief.usefulExamples.map((e, i) => [`usefulExamples.${i}`, e.description] as [string, string]),
  ];
  // Outline headings/answers may quote discovered questions verbatim (with their numbers); those are not claims.
  const knownQuestions = [...brief.queryCluster.queries, ...brief.evidenceSources.filter((e) => e.kind === 'signal').map((e) => e.excerpt.replace(/\s*\[[^\]]*\]\s*$/, ''))];
  for (const [field, t] of freeText) {
    for (const n of unsupportedNumbers(t, allSupport, { knownQuestions, estimateSupport })) if (n.kind !== 'year') err('unsupported_number', field, `Number "${n.raw}" is not supported at claim level by owner facts or trusted evidence in the bundle.`);
    for (const c of productClaims(t, ctx.config)) if (!c.supportedBy) err('unsupported_product_claim', field, `Product/business claim not backed by product facts or approved claims: "${truncate(c.clause, 100)}".`);
    for (const p of prohibitedClaimHits(t, ctx.config)) err('prohibited_claim', field, `Contains a prohibited claim: "${p}".`);
    if (WORD_COUNT_RE.test(t)) err('word_count_target', field, 'Arbitrary word-count targets are not allowed; cover the questions instead.');
  }
  const knownFacts = new Set(ctx.config.business.productFacts.map((f) => f.id));
  for (const id of brief.productFactIds) if (!knownFacts.has(id)) err('unknown_product_fact', 'productFactIds', `Unknown product fact id "${id}".`);

  if (brief.programmatic.isProgrammatic) {
    if (!brief.programmatic.differentiatingData.length) err('pseo_without_distinct_data', 'programmatic', 'Programmatic page without real differentiating data: mere name substitution is not allowed.');
    for (const dd of brief.programmatic.differentiatingData) if (!dd.evidenceIds.some((id) => evidenceIds.has(id))) err('pseo_data_without_evidence', 'programmatic', `Differentiating field "${dd.field}" has no evidence.`);
  }
  const unvalidated = brief.catalogAttributes.filter((a) => !a.validated);
  if (unvalidated.length) warn('unvalidated_catalog_attributes', 'catalogAttributes', `Unvalidated attributes must stay marked unverified: ${unvalidated.map((a) => a.name).join(', ')}.`);
  for (const q of brief.unresolvedQuestions) if (q.blocking) err('blocking_question', 'unresolvedQuestions', `Blocking question: ${q.question}`);
  if (brief.decision === 'create_page' && brief.existingPageOverlap.cannibalizationRisk.startsWith('high')) warn('cannibalization_risk', 'existingPageOverlap', 'High cannibalization risk for a new page (uncertain).');
  for (const d of extra.dropped ?? []) warn('model_output_dropped', 'synthesis', d);
  // Competitor headings are topic prompts: an outline that copies them builds a competitor's structure into our page.
  const competitorTexts = brief.evidenceSources.filter((e) => e.origin === 'competitor_gap').map((e) => e.excerpt.replace(/\s*\[[^\]]*\]\s*$/, ''));
  brief.outline.forEach((o, i) => {
    if (competitorTexts.some((t) => lexicalSimilarity(t, o.heading) >= 0.8)) warn('competitor_heading_copied', `outline.${i}`, `Outline heading "${truncate(o.heading, 80)}" repeats a competitor heading; use competitor headings as topic prompts only (in our own words). It is not required answer coverage.`);
  });
  // Stale memory is never support: surface it so the owner re-verifies.
  for (const e of brief.evidenceSources.filter((x) => x.kind === 'memory' && /STALE/.test(x.label))) warn('stale_memory_evidence', 'evidenceSources', `${e.label}: the original changed after indexing; its text supports no claim. Run \`memory sync\`.`);
  const injected = detectInstructionLikeText([brief.primaryQuestion, ...brief.queryCluster.queries, ...brief.outline.flatMap((o) => o.answers)].join('\n'));
  if (injected.length) warn('instruction_like_text', 'queryCluster', `Research text contains instruction-like content (${injected.map((i) => `"${truncate(i, 40)}"`).join(', ')}); it is treated as data and never followed. Consider rephrasing the primary question.`);

  return { passed: !issues.some((i) => i.severity === 'error'), issues, checkedAt: ctx.clock.now().toISOString(), gateVersion: BRIEF_GATE_VERSION };
}

/** Evidence that is a third-party estimate (search-volume figures): never exact demand, never plain number support. */
function isEstimateEvidence(e: EvidenceSource): boolean {
  return e.trustClass === 'third_party_data' || e.origin === 'dataforseo';
}

/**
 * Evidence that is ORIGINAL VALUE for a reader: owner product facts, approved claims/differentiators/offer,
 * owner-approved notes/data (verified against their original), and validated catalog attributes.
 */
export function isOriginalValueEvidence(e: EvidenceSource): boolean {
  if (e.isSandbox || (e.isSynthetic && e.trustClass !== 'owner_approved')) return false;
  if (e.kind === 'product_fact' || e.kind === 'approved_claim') return true;
  if (e.kind === 'catalog_attribute') return e.trustClass === 'owner_approved';
  if (e.kind === 'memory') return e.trustClass === 'owner_approved' && !/STALE/.test(e.label);
  return false;
}

/** Canonical brief hash bound by the draft approval. */
export function briefHash(brief: ContentBrief): string {
  return hashObject(brief);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Throws the error createBrief would raise before doing any work (unknown item, non-actionable decision, locked stage). */
export function assertBriefable(ctx: AppContext, itemId: string): ContentItem {
  const item = getItem(ctx.db, ctx.siteId, itemId);
  if (!item) throw new AppError('NOT_FOUND', `Content item ${itemId} not found for site ${ctx.siteId}`);
  // One change per page at a time: no brief (and so no draft approval request) while the target page is observed.
  if (!LOCKED_STAGES.has(item.stage)) assertNotUnderObservation(ctx, item, 'brief');
  if (!item.decision || item.decision === 'defer' || item.decision === 'reject') {
    throw new AppError('POLICY_DENIED', `Content item ${itemId} has decision "${item.decision ?? 'none'}"; no brief is produced.`, {
      details: { reason: item.decisionReason },
      hint: item.decisionReason ?? 'Run `content discover` to evaluate the item first.',
    });
  }
  if (LOCKED_STAGES.has(item.stage)) throw new AppError('CONFLICT', `Content item ${itemId} is ${item.stage}; a new brief would not change approved/published work.`);
  return item;
}

export async function createBrief(ctx: AppContext, deps: ContentDeps, itemId: string, opts: BriefOptions = {}): Promise<BriefResult> {
  const item = assertBriefable(ctx, itemId);
  const preview = opts.preview || ctx.dryRun;
  const signals = listSignals(ctx.db, ctx.siteId, { itemId });
  const { pages } = loadSitePages(ctx);
  const memoryIssues: string[] = [];
  const evidence = await buildEvidence(ctx, deps, item, signals, pages, opts, memoryIssues);
  let brief = buildDeterministicBrief(ctx, item, signals, evidence, pages, opts);
  // Retrieved notes that could not be verified against their original are stated, never silently reused.
  for (const m of memoryIssues) brief.researchFindings.push({ finding: m, evidenceIds: [], label: 'DATA_UNAVAILABLE' });
  let dropped: string[] = [];
  let modelStatus = 'not requested';
  let promptVersion: string | null = null;
  let modelId: string | null = null;

  const llm = deps.llm;
  const modelAvailable = !!llm && ctx.settings.features.llm && llm.isConfigured('reasoning');
  // Inputs of this brief: the deterministic assembly plus whether synthesis is requested/possible.
  // Collection timestamps are refreshed by every discovery run; they are not a change of evidence.
  const inputsHash = hashObject({
    gate: BRIEF_GATE_VERSION,
    deterministic: { ...brief, evidenceSources: brief.evidenceSources.map(({ collectedAt: _c, ...e }) => e) },
    modelRequested: opts.useModel !== false,
    modelAvailable,
  });

  // Reuse the latest gate-passed brief when nothing changed: same id/hash, approvals stay bound, no model spend.
  const latest = latestBrief(ctx.db, ctx.siteId, itemId);
  if (!opts.force && latest && (latest.status === 'gate_passed' || latest.status === 'approved') && latest.gate?.passed && latest.gate.inputsHash === inputsHash && briefHash(latest.brief) === latest.contentHash) {
    const approval = preview ? { record: null, status: approvalState(ctx, deps, latest) } : ensureDraftApproval(ctx, deps, item, latest, opts);
    if (!preview) audit(ctx.db, ctx.siteId, 'content.brief_reused', 'content_brief', latest.id, { itemId, version: latest.version, contentHash: latest.contentHash, approvalStatus: approval.status }, ctx.clock.now());
    return { brief: latest.brief, gate: latest.gate, record: latest, approvalRequest: approval.record, modelStatus: 'reused: inputs unchanged since this brief was built (no model call)', contentHash: latest.contentHash, reused: true, approvalStatus: approval.status };
  }

  if (opts.useModel === false) modelStatus = 'skipped: deterministic brief requested';
  else if (preview) modelStatus = 'skipped: dry run / preview (no paid calls)';
  else if (!llm) modelStatus = 'unavailable: LLM client not wired; deterministic brief only';
  else if (!ctx.settings.features.llm) modelStatus = 'disabled: features.llm is false; deterministic brief only';
  else if (!llm.isConfigured('reasoning')) modelStatus = 'not_configured: set REASONING_MODEL; deterministic brief only';
  else {
    const bundle: EvidenceItem[] = brief.evidenceSources.map((e) => ({
      id: e.id,
      label: `${e.label}${e.isSynthetic ? ' [SYNTHETIC]' : ''}`,
      text: `${e.excerpt}\nLimitations: ${e.limitations}`,
      trustClass: e.trustClass as TrustClass,
      ...(e.url ? { url: e.url } : {}),
      ...(e.collectedAt ? { retrievedAt: e.collectedAt } : {}),
    }));
    const primarySignal = signals.find((s) => s.text.trim() === brief.primaryQuestion.trim()) ?? signals[0];
    const res = await llm.structured({
      siteId: ctx.siteId,
      runId: ctx.runId,
      role: 'synthesizer',
      tier: 'reasoning',
      promptId: BRIEF_PROMPT_ID,
      variables: {
        business_name: ctx.config.site.businessName,
        target_customer: ctx.config.business.targetCustomer ?? 'not configured',
        language: brief.language,
        decision: brief.decision,
        intent: brief.intent,
        page_type: brief.pageType,
        proposed_url: brief.proposedUrl ?? 'none',
        target_page_url: brief.targetPageUrl ?? 'none',
        primary_signal_id: primarySignal?.id ?? 'none',
        cta_target: brief.cta.targetUrl ?? 'none',
        primary_conversion: ctx.config.conversions.primaryEvents[0]?.meaning ?? 'not configured',
        allowed_evidence_ids: brief.evidenceSources.map((e) => e.id).join(', '),
        product_fact_ids: brief.productFactIds.map((id) => `fact:${id}`).join(', ') || 'none',
      },
      evidence: bundle,
      schema: briefSynthesisSchema,
      schemaName: 'ContentBriefSynthesis',
      maxOutputTokens: ctx.config.llm.maxOutputTokensReasoning,
    });
    if (res.ok) {
      const merged = mergeSynthesis(brief, res.value, { promptVersion: res.promptVersion, model: res.model });
      brief = merged.brief;
      dropped = merged.dropped;
      promptVersion = res.promptVersion;
      modelId = res.model;
      modelStatus = `completed (${res.model}, ${res.promptVersion}${res.truncation.length ? `, ${res.truncation.length} evidence item(s) truncated` : ''})`;
    } else modelStatus = `${res.status}: ${res.reason}; deterministic brief used`;
  }

  const gate: BriefGateResult = { ...runBriefGate(ctx, brief, { dropped }), inputsHash };
  const contentHash = briefHash(brief);
  if (preview) return { brief, gate, record: null, approvalRequest: null, modelStatus, contentHash, reused: false, approvalStatus: null };

  const now = ctx.clock.now().toISOString();
  const record = ctx.db.transaction(() => {
    const rec = insertBrief(ctx.db, { siteId: ctx.siteId, itemId, brief, contentHash, gate, status: gate.passed ? 'gate_passed' : 'gate_failed', promptVersion, modelId, now });
    persistBriefProvenance(ctx, rec);
    insertQualityReview(ctx.db, {
      siteId: ctx.siteId,
      subjectType: 'brief',
      subjectId: rec.id,
      verdict: gate.passed ? 'pass' : 'needs_revision',
      deterministic: { gate },
      aiReview: null,
      reasons: gate.issues.filter((i) => i.severity === 'error').map((i) => ({ code: i.code, message: i.message, consequence: 'revise', evidenceRefs: [i.field], fix: 'Resolve the missing/unsupported field and rebuild the brief.' })),
      revisionRound: 0,
      now,
    });
    const nextStage = ['existing_checked', 'prioritized', 'briefed', 'deferred'].includes(item.stage) ? 'briefed' : item.stage;
    updateItem(ctx.db, ctx.siteId, itemId, { stage: nextStage }, now);
    audit(ctx.db, ctx.siteId, 'content.brief_created', 'content_brief', rec.id, { itemId, version: rec.version, gatePassed: gate.passed, contentHash, modelStatus }, ctx.clock.now());
    return rec;
  });

  const approval = gate.passed ? ensureDraftApproval(ctx, deps, item, record, opts) : { record: null, status: null };
  return { brief, gate, record, approvalRequest: approval.record, modelStatus, contentHash, reused: false, approvalStatus: approval.status };
}

/** Current draft_generation approval state for a brief (read-only). */
function approvalState(ctx: AppContext, deps: ContentDeps, rec: BriefRecord): BriefResult['approvalStatus'] {
  if (!deps.approvals) return null;
  const c = deps.approvals.check({ siteId: ctx.siteId, actionType: 'draft_generation', subjectType: 'content_brief', subjectId: rec.id, artifactHash: rec.contentHash });
  if (c.ok) return 'approved';
  if (c.reason === 'pending' || c.reason === 'already_executed' || c.reason === 'rejected') return c.reason;
  return 'none';
}

/**
 * Request (or return) the pending draft_generation approval bound to this
 * exact brief hash. An approval that was already used for a draft, or that a
 * human rejected, is not re-requested automatically.
 */
function ensureDraftApproval(ctx: AppContext, deps: ContentDeps, item: ContentItem, rec: BriefRecord, opts: BriefOptions): { record: ApprovalRecord | null; status: BriefResult['approvalStatus'] } {
  if (!deps.approvals) return { record: null, status: null };
  const c = deps.approvals.check({ siteId: ctx.siteId, actionType: 'draft_generation', subjectType: 'content_brief', subjectId: rec.id, artifactHash: rec.contentHash });
  if (c.ok) return { record: c.approval, status: 'approved' };
  if (c.reason === 'pending') return { record: c.approval ?? null, status: 'pending' };
  if (c.reason === 'already_executed') return { record: c.approval ?? null, status: 'already_executed' };
  // A human rejected drafting this exact brief: never re-request automatically.
  if (c.reason === 'rejected') return { record: c.approval ?? null, status: 'rejected' };
  if (opts.requestApproval === false) return { record: null, status: 'not_requested' };
  const record = deps.approvals.request({
    siteId: ctx.siteId,
    actionType: 'draft_generation',
    target: item.id,
    subjectType: 'content_brief',
    subjectId: rec.id,
    artifactHash: rec.contentHash,
    sourceRevision: null,
    summary: `Generate a draft for "${truncate(item.title, 80)}" from brief v${rec.version} (${rec.brief.decision.replace(/_/g, ' ')}).`,
    payload: { briefVersion: rec.version, itemId: item.id, decision: rec.brief.decision, proposedUrl: rec.brief.proposedUrl },
    requestedBy: opts.requestedBy ?? 'seo-agent',
  });
  return { record, status: 'requested' };
}

const SOURCE_TYPE_BY_ORIGIN: Record<string, string> = {
  gsc_query: 'gsc',
  dataforseo: 'dataforseo',
  apify_reddit: 'reddit',
  competitor_gap: 'competitor_page',
  business_knowledge: 'business_note',
  manual: 'manual_import',
  fixture: 'fixture',
  owner: 'owner_input',
  own_site: 'crawl',
};

/** Record sources, evidence, and source-to-claim references for a brief (provenance). */
function persistBriefProvenance(ctx: AppContext, rec: BriefRecord): void {
  const now = ctx.clock.now().toISOString();
  const evidenceRowByBriefId = new Map<string, string>();
  for (const e of rec.brief.evidenceSources) {
    const sourceType = e.kind === 'memory' ? 'business_note' : e.kind === 'catalog_attribute' ? 'owner_input' : (SOURCE_TYPE_BY_ORIGIN[e.origin] ?? 'fixture');
    const trust = (e.isSynthetic ? 'synthetic' : e.trustClass) as TrustClass;
    const sourceId = ensureSource(ctx.db, {
      siteId: ctx.siteId,
      sourceType: e.isSynthetic ? 'fixture' : sourceType,
      trustClass: trust,
      url: e.url ?? `content-evidence://${e.id}`,
      title: e.label,
      contentHash: sha256(e.excerpt),
      retrievedAt: e.collectedAt ?? now,
      metadata: { briefId: rec.id, evidenceId: e.id, limitations: e.limitations },
    });
    const evidenceId = insertEvidence(ctx.db, {
      siteId: ctx.siteId,
      sourceId,
      kind: e.kind === 'metric' ? 'metric' : e.kind === 'page' ? 'observation' : 'excerpt',
      summary: truncate(`${e.label}: ${e.excerpt}`, 300),
      excerpt: truncate(e.excerpt, 1000),
      locator: { briefId: rec.id, evidenceId: e.id },
      dateStart: e.window?.start ?? null,
      dateEnd: e.window?.end ?? null,
      collectedAt: now,
    });
    evidenceRowByBriefId.set(e.id, evidenceId);
  }
  rec.brief.researchFindings.forEach((f, i) => {
    for (const id of f.evidenceIds) {
      insertClaimEvidence(ctx.db, {
        siteId: ctx.siteId,
        subjectType: 'brief',
        subjectId: rec.id,
        claimKey: `finding_${i + 1}`,
        claimText: truncate(f.finding, 500),
        label: f.label,
        evidenceId: evidenceRowByBriefId.get(id) ?? null,
        support: evidenceRowByBriefId.has(id) ? 'supports' : 'missing',
        createdAt: now,
      });
    }
  });
}

/** Content tokens of a brief's topic (for other modules). */
export function briefTopicTokens(brief: ContentBrief): Set<string> {
  return new Set(contentTokens([brief.primaryQuestion, ...brief.queryCluster.queries].join(' ')));
}
