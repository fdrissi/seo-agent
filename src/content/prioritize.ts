import type { AppContext } from '../app/context.js';
import { DECISION_RULES_VERSION } from './existing.js';
import { observationHold } from './freeze.js';
import { audit, countInProduction, updateItem } from './store.js';
import type { ContentDecision, ContentItem, Intent, PrioritizeOutput, ScoreComponents } from './types.js';

/**
 * PRIORITIZE: an interpretable score with documented components and
 * limitations. Raw counts stay in demand_json; smoothing only shrinks thin
 * evidence toward zero (a single signal never outranks broad, observed
 * demand). Deferred/rejected items are scored for transparency but are not
 * selectable.
 *
 * score = 100 x confidence x (0.30 relevance + 0.30 demandAdjusted + 0.15 intent
 *         + 0.15 originalValue + 0.10 effort) x (1 - riskPenalty)
 *
 * originalValue is 1 only when the reader gets something others cannot give
 * (verified product facts, real differentiators, owner data, or a
 * tool/template); search impressions and customer questions are demand, not
 * original value (existing.ts).
 *
 * Branded clusters (queries naming the site's own brand) form a SEPARATE
 * segment ranked after every non-branded item: branded demand mostly reflects
 * existing awareness and is served by existing pages, so it never outranks a
 * non-branded opportunity. Scores are not mixed across segments.
 */

export const SCORING_VERSION = 'content-priority@2';

export const WEIGHTS = { relevance: 0.3, demand: 0.3, intent: 0.15, originalValue: 0.15, effort: 0.1 } as const;

const INTENT_VALUE: Record<Intent, number> = { transactional: 1, commercial: 0.8, informational: 0.6, mixed: 0.6, unsure: 0.3, navigational: 0.1 };
const EFFORT: Record<ContentDecision, number> = { improve_existing: 1, add_section: 0.9, create_page: 0.6, create_template: 0.5, create_tool: 0.4, defer: 0.5, reject: 0 };

/** log10(1+x)/log10(1+ref), capped at 1. */
function logScale(x: number, ref: number): number {
  return Math.min(1, Math.log10(1 + Math.max(0, x)) / Math.log10(1 + ref));
}

export function scoreItem(item: ContentItem, opts: { smoothingK?: number } = {}): ScoreComponents & { score: number } {
  const d = item.demand;
  const k = opts.smoothingK ?? 2;
  const relationStrength = d?.relationStrength ?? 'unknown';
  const relevance = relationStrength === 'strong' ? 1 : relationStrength === 'weak' ? 0.5 : 0;

  let demand = 0;
  let confidence = 0.4;
  const limitations: string[] = [];
  if (d) {
    const gsc = d.gsc.impressions.status === 'observed' ? logScale(d.gsc.impressions.value, 1000) : 0;
    const vol = d.searchVolumeEstimate.max.status === 'observed' ? 0.5 * logScale(d.searchVolumeEstimate.max.value, 1000) : 0;
    const community = 0.3 * Math.min(1, d.community.threads / 5);
    const manual = 0.3 * Math.min(1, d.manualQuestions / 3);
    const gaps = 0.2 * Math.min(1, d.competitorGaps / 3);
    const independentOrigins = Object.keys(d.origins).filter((o) => o !== 'business_knowledge').length;
    demand = Math.min(1, Math.max(gsc, vol, community, manual, gaps) + 0.1 * Math.max(0, independentOrigins - 1));
    if (d.gsc.impressions.status === 'observed') confidence = 1;
    else if (d.searchVolumeEstimate.max.status === 'observed') confidence = 0.7;
    else if (d.community.threads || d.manualQuestions || d.competitorGaps) confidence = 0.5;
    if (confidence < 1) limitations.push('No first-party Search Console measurement: confidence reduced.');
    if (d.searchVolumeEstimate.max.status === 'observed') limitations.push('Search volume is a third-party estimate (discounted by 50%).');
    if (d.community.threads) limitations.push('Community engagement is not search volume (discounted to 30%).');
  } else limitations.push('Demand not validated.');
  const n = d?.signalCount ?? 0;
  const demandAdjusted = demand * (n / (n + k));
  const intentValue = INTENT_VALUE[item.intent ?? 'unsure'];
  const originalValue = d?.originalValueAvailable ? 1 : 0.3;
  const effort = EFFORT[item.decision ?? 'defer'];
  const risk = item.overlap?.cannibalization.risk;
  const riskPenalty = risk === 'high' ? 0.3 : risk === 'medium' && item.decision !== 'improve_existing' ? 0.15 : 0;
  if (riskPenalty) limitations.push('Possible cannibalization risk (uncertain) reduces the score.');
  if (d?.branded) limitations.push('Branded cluster (names the site\'s own brand): ranked in a separate segment after all non-branded items.');
  const base = WEIGHTS.relevance * relevance + WEIGHTS.demand * demandAdjusted + WEIGHTS.intent * intentValue + WEIGHTS.originalValue * originalValue + WEIGHTS.effort * effort;
  const score = Math.round(100 * confidence * base * (1 - riskPenalty) * 10) / 10;
  return {
    score,
    relevance,
    demand: round3(demand),
    demandAdjusted: round3(demandAdjusted),
    intentValue,
    originalValue,
    effort,
    riskPenalty,
    confidence,
    weights: { ...WEIGHTS },
    formula: `100 x confidence(${confidence}) x (0.30 x relevance(${relevance}) + 0.30 x demandAdjusted(${round3(demandAdjusted)}) + 0.15 x intent(${intentValue}) + 0.15 x originalValue(${originalValue}) + 0.10 x effort(${effort})) x (1 - risk(${riskPenalty}))`,
    limitations: [
      ...limitations,
      `Smoothing: demand x n/(n+${k}) with n=${n} signals; raw counts are kept in the demand evidence.`,
      'Scores rank candidates for human review; they are not predictions of traffic or revenue.',
    ],
  };
}

/** Ranking segment: branded clusters are kept apart from (and after) non-branded opportunities. */
export function segmentOf(item: ContentItem): 'branded' | 'non_branded' {
  return item.demand?.branded ? 'branded' : 'non_branded';
}

/** Sort order used everywhere items are ranked: non-branded first, then score (descending). */
export function compareForPriority(a: ContentItem, b: ContentItem): number {
  const seg = Number(segmentOf(a) === 'branded') - Number(segmentOf(b) === 'branded');
  return seg || scoreItem(b).score - scoreItem(a).score || a.id.localeCompare(b.id);
}

export function isSelectable(item: ContentItem): boolean {
  return !!item.decision && !['defer', 'reject'].includes(item.decision) && item.intent !== 'unsure';
}

export function productionCapacity(ctx: AppContext, excludeItemId?: string): PrioritizeOutput['capacity'] {
  const c = ctx.config.content;
  const inProduction = countInProduction(ctx.db, ctx.siteId, excludeItemId);
  return { maxInProduction: c.maxInProduction, inProduction, available: Math.max(0, c.maxInProduction - inProduction), batchEnabled: c.batchEnabled, pilotApproved: c.pilotApproved };
}

export function prioritizeItems(ctx: AppContext, items: ContentItem[]): PrioritizeOutput {
  const now = ctx.clock.now().toISOString();
  const ranked: PrioritizeOutput['ranked'] = [];
  ctx.db.transaction(() => {
    for (const original of items) {
      // A target page under observation (an experiment started after CHECK EXISTING) defers the item: never selectable.
      const hold = isSelectable(original) ? observationHold(ctx, original) : null;
      const item: ContentItem = hold ? { ...original, decision: 'defer', stage: 'deferred', decisionReason: `[${DECISION_RULES_VERSION}] ${hold.reason} Once it concludes, this item would be: ${(original.decision ?? 'none').replace(/_/g, ' ')}.` } : original;
      const s = scoreItem(item);
      const selectable = isSelectable(item);
      const stage = selectable ? 'prioritized' : item.stage;
      updateItem(ctx.db, ctx.siteId, item.id, { priorityScore: s.score, stage, ...(hold ? { decision: 'defer', decisionReason: item.decisionReason } : {}), ...(item.demand ? { demand: { ...item.demand, scoring: s } } : {}) }, now);
      if (hold) audit(ctx.db, ctx.siteId, 'content.decision', 'content_item', item.id, { previous: original.decision, previousReason: original.decisionReason, decision: 'defer', reason: hold.reason, observing: hold.experiments.map((e) => e.id), rulesVersion: DECISION_RULES_VERSION }, ctx.clock.now());
      ranked.push({ itemId: item.id, title: item.title, decision: item.decision ?? 'defer', score: s.score, selectable, segment: segmentOf(item) });
    }
  });
  // Selectable first; within that, non-branded before branded (separate segment), then score.
  ranked.sort((a, b) => Number(b.selectable) - Number(a.selectable) || Number(a.segment === 'branded') - Number(b.segment === 'branded') || (b.score ?? -1) - (a.score ?? -1) || a.itemId.localeCompare(b.itemId));
  return { ranked, capacity: productionCapacity(ctx), topItemId: ranked.find((r) => r.selectable)?.itemId ?? null, scoringVersion: SCORING_VERSION };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
