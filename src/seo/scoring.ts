import { newId } from '../core/ids.js';
import type { Db } from '../database/db.js';
import type { QueryIntent, Route } from '../router/types.js';
import { clamp01, logScale, smoothedRate } from './stats.js';

/**
 * Interpretable opportunity score (0..100).
 *
 *   base  = sum(w_k * c_k) / sum(w_k)          components c_k in 0..1
 *   score = 100 * base * (1 - risk) * (1 - uncertaintyWeight * uncertainty)
 *
 * Components:
 *   relevance  business relevance (commercial page type, observed conversions, intent)
 *   demand     log(1 + impressions) / log(1 + reference impressions)   (measured GSC impressions)
 *   intent     transactional 1, commercial .85, mixed .6, informational .5, unsure .4, navigational .2
 *   outcome    log(1 + E) / log(1 + reference), E = observed converting sessions
 *              shrunk by evidence volume:  E = x * n / (n + k)
 *              (x converting sessions, n sessions, k prior pseudo-sessions).
 *              Prior mass is never counted as conversions: a page with zero
 *              observed conversions has E = 0 however much traffic it has.
 *              1 conversion from 2 sessions => E ~ 0.02, never outranking reliable volume.
 *              The Beta-smoothed RATE p = (x + k * p0) / (n + k) (toward the
 *              site rate p0) is reported next to the raw rate and used only to
 *              size conversion room against the site rate.
 *   evidence   0.5 * min(1, impressions / minImpressions) + 0.3 * min(1, sessions / minSessions) + 0.2 * completeness
 *   room       realistic improvement room for the route (documented per route below)
 *   effort     cheapness of the typical next step (1 = cheap)
 * Penalties:
 *   risk        1 - prod(1 - r_i): protected page .5, branded .2, experiment on this page .3,
 *               site-wide experiment or control page of an experiment .1, suspected technical issue .1
 *   uncertainty 1 - evidence
 *
 * Never used: backlinks, "authority" scores, or search-volume estimates
 * (volume estimates are not demand measurements). Raw counts are always kept
 * next to the score (opportunities.raw_counts_json).
 */

export const SCORING_VERSION = 'scoring@1.1.0';

export interface ScoringParams {
  weights: { relevance: number; demand: number; intent: number; outcome: number; evidence: number; room: number; effort: number };
  uncertaintyWeight: number;
  /** Beta prior strength in pseudo-sessions for conversion smoothing. */
  priorSessions: number;
  minImpressions: number;
  minSessions: number;
  rankingPositionMin: number;
  rankingPositionMax: number;
  commercialPageTypes: readonly string[];
}

export const DEFAULT_SCORING_WEIGHTS: ScoringParams['weights'] = { relevance: 0.15, demand: 0.2, intent: 0.1, outcome: 0.2, evidence: 0.1, room: 0.15, effort: 0.1 };

export function defaultScoringParams(p: { minImpressions: number; minSessions: number; rankingPositionMin: number; rankingPositionMax: number; commercialPageTypes: readonly string[] }): ScoringParams {
  return { weights: { ...DEFAULT_SCORING_WEIGHTS }, uncertaintyWeight: 0.5, priorSessions: 100, ...p };
}

export interface ScoringInput {
  route: Route;
  pageType: string | null;
  isProtected: boolean;
  branded: boolean | null;
  intent: QueryIntent | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  expectedCtr: number | null;
  position: number | null;
  sessions: number | null;
  convertingSessions: number | null;
  primaryEventOccurrences: number | null;
  siteConversionRate: number | null;
  declinePct: number | null;
  gscComplete: boolean;
  ga4Complete: boolean;
  activeExperimentOnPage: boolean;
  /** A site-wide experiment is active, or this page is a comparison page of one. */
  activeExperimentOnSite?: boolean;
  suspectedIssues: number;
  /** Inputs are synthetic (fixture/demo): recorded in rawCounts.dataOrigin. */
  synthetic?: boolean;
  /** Reference volumes across the candidate set (for log scaling). */
  refImpressions: number;
  refConversions: number;
}

export interface ScoreComponent {
  value: number;
  weight: number;
  explanation: string;
}

export interface ScoreResult {
  score: number;
  segment: 'branded' | 'non_branded' | 'unknown';
  components: Record<'relevance' | 'demand' | 'intent' | 'outcome' | 'evidence' | 'room' | 'effort', ScoreComponent>;
  penalties: { risk: { value: number; factors: string[] }; uncertainty: { value: number; weight: number } };
  rawCounts: Record<string, number | null | string>;
  notMeasured: string[];
  version: string;
}

const INTENT_VALUE: Record<QueryIntent, number> = { transactional: 1, commercial: 0.85, mixed: 0.6, informational: 0.5, unsure: 0.4, navigational: 0.2 };
const EFFORT: Partial<Record<Route, [number, string]>> = {
  CTR_OPPORTUNITY: [0.9, 'title/snippet investigation is usually a small change'],
  RANKING_OPPORTUNITY: [0.6, 'targeted audit, possibly a content section'],
  CONVERSION_OPPORTUNITY: [0.5, 'tracking, intent, and conversion-path review'],
  DECLINE: [0.5, 'investigation across technical, demand, and competitor changes'],
  CONTENT_OPPORTUNITY: [0.3, 'overlap check, research, and a brief before any new content'],
  TECHNICAL_BLOCKER: [0.6, 'technical investigation'],
  INDEXING_UNKNOWN: [0.8, 'URL inspection is cheap'],
  INVALID_OR_INCOMPLETE_DATA: [0.7, 'measurement repair'],
};

/**
 * Evidence-shrunk observed conversions and the smoothed rate (see header).
 * `expected` = x * n / (n + k): the observed count shrunk toward zero when the
 * sample is small. The prior is never added as pseudo-conversions.
 * `smoothedRate` = (x + k * p0) / (n + k) when the site rate p0 is known.
 */
export function smoothedConversions(converting: number, sessions: number, siteRate: number | null, priorSessions: number): { expected: number; smoothedRate: number | null } {
  if (sessions <= 0) return { expected: 0, smoothedRate: null };
  const k = Math.max(0, priorSessions);
  const x = Math.max(0, converting);
  const expected = (x * sessions) / (sessions + k);
  return { expected, smoothedRate: siteRate !== null && siteRate >= 0 ? smoothedRate(x, sessions, siteRate, k) : null };
}

function roomFor(i: ScoringInput, p: ScoringParams, smoothed: number | null): [number, string] {
  switch (i.route) {
    case 'RANKING_OPPORTUNITY': {
      if (i.position === null) return [0.4, 'position unknown'];
      const pos = i.position;
      const v = pos <= 10 ? 1 - Math.max(0, pos - p.rankingPositionMin) / 12 : 0.5 - (pos - 10) / 40;
      return [clamp01(v), `position ${pos.toFixed(1)}: ${pos <= 10 ? 'page one, below the top results' : 'page two, harder to move'}`];
    }
    case 'CTR_OPPORTUNITY':
      if (i.ctr === null || i.expectedCtr === null || i.expectedCtr <= 0) return [0.5, 'comparable CTR unknown'];
      return [clamp01(1 - i.ctr / i.expectedCtr), `CTR ${(i.ctr * 100).toFixed(2)}% vs comparable ${(i.expectedCtr * 100).toFixed(2)}%`];
    case 'CONVERSION_OPPORTUNITY':
      if (smoothed === null || !i.siteConversionRate) return [0.5, 'conversion benchmark unknown'];
      return [clamp01(1 - smoothed / i.siteConversionRate), `smoothed rate ${(smoothed * 100).toFixed(2)}% vs site ${(i.siteConversionRate * 100).toFixed(2)}%`];
    case 'DECLINE':
      return i.declinePct === null ? [0.5, 'decline size unknown'] : [clamp01(Math.abs(i.declinePct) / 100), `decline ${i.declinePct}%`];
    case 'CONTENT_OPPORTUNITY':
      return [0.6, 'unknown until research; fixed prior'];
    case 'TECHNICAL_BLOCKER':
      return [1, 'all exposure at risk until fixed'];
    case 'INDEXING_UNKNOWN':
      return [0.5, 'unknown until inspected'];
    default:
      return [0, 'no improvement room for this route'];
  }
}

export function scoreOpportunity(i: ScoringInput, p: ScoringParams): ScoreResult {
  const n = i.sessions ?? 0;
  const x = i.convertingSessions ?? 0;
  const conv = i.sessions !== null && i.convertingSessions !== null ? smoothedConversions(x, n, i.siteConversionRate, p.priorSessions) : null;

  let relevance = 0.5;
  const relWhy: string[] = [];
  if (i.pageType && p.commercialPageTypes.includes(i.pageType)) {
    relevance = 1;
    relWhy.push(`commercial page type "${i.pageType}"`);
  } else if (i.intent) {
    relevance = { transactional: 0.85, commercial: 0.85, mixed: 0.6, informational: 0.5, unsure: 0.5, navigational: 0.3 }[i.intent];
    relWhy.push(`intent ${i.intent}`);
  }
  if ((i.convertingSessions ?? 0) > 0 && relevance < 0.9) {
    relevance = 0.9;
    relWhy.push('conversions observed on the page');
  }
  const demand = i.impressions === null ? 0 : logScale(i.impressions, Math.max(i.refImpressions, i.impressions));
  const intent = i.intent ? INTENT_VALUE[i.intent] : 0.4;
  const outcome = conv === null ? 0 : logScale(conv.expected, Math.max(i.refConversions, conv.expected, 1));
  const completeness = (i.gscComplete ? 0.5 : 0) + (i.ga4Complete ? 0.5 : 0);
  const evidence = clamp01(0.5 * Math.min(1, (i.impressions ?? 0) / Math.max(1, p.minImpressions)) + 0.3 * Math.min(1, n / Math.max(1, p.minSessions)) + 0.2 * completeness);
  const [room, roomWhy] = roomFor(i, p, conv?.smoothedRate ?? null);
  const [effort, effortWhy] = EFFORT[i.route] ?? [0.5, 'default'];

  const riskFactors: Array<[number, string]> = [];
  if (i.isProtected) riskFactors.push([0.5, 'protected page (explicit owner review required)']);
  if (i.branded) riskFactors.push([0.2, 'branded query (brand SERP sensitivity)']);
  if (i.activeExperimentOnPage) riskFactors.push([0.3, 'experiment active or pending on this page']);
  if (i.activeExperimentOnSite) riskFactors.push([0.1, 'site-wide experiment active, or this page is an experiment comparison page']);
  if (i.suspectedIssues > 0) riskFactors.push([0.1, `${i.suspectedIssues} unconfirmed technical issue(s)`]);
  const risk = 1 - riskFactors.reduce((a, [r]) => a * (1 - r), 1);
  const uncertainty = 1 - evidence;

  const w = p.weights;
  const comps = {
    relevance: { value: relevance, weight: w.relevance, explanation: relWhy.join('; ') || 'no relevance signal; neutral' },
    demand: { value: demand, weight: w.demand, explanation: i.impressions === null ? 'impressions unavailable' : `${i.impressions} impressions (log-scaled vs ${Math.max(i.refImpressions, i.impressions)})` },
    intent: { value: intent, weight: w.intent, explanation: i.intent ?? 'intent unknown' },
    outcome: {
      value: outcome,
      weight: w.outcome,
      explanation:
        conv === null
          ? 'conversions unavailable'
          : `raw ${x} converting session(s) / ${n} sessions; evidence-shrunk ${conv.expected.toFixed(2)} (x * n / (n + ${p.priorSessions}))${conv.smoothedRate === null ? '; no site rate for rate smoothing' : `; smoothed rate ${(conv.smoothedRate * 100).toFixed(2)}% vs site ${((i.siteConversionRate ?? 0) * 100).toFixed(2)}%`}`,
    },
    evidence: { value: evidence, weight: w.evidence, explanation: `impressions ${i.impressions ?? 'n/a'}/${p.minImpressions}, sessions ${i.sessions ?? 'n/a'}/${p.minSessions}, completeness ${completeness}` },
    room: { value: room, weight: w.room, explanation: roomWhy },
    effort: { value: effort, weight: w.effort, explanation: effortWhy },
  };
  const totalW = Object.values(comps).reduce((a, c) => a + c.weight, 0) || 1;
  const base = Object.values(comps).reduce((a, c) => a + c.value * c.weight, 0) / totalW;
  const score = Math.round(100 * base * (1 - risk) * (1 - p.uncertaintyWeight * uncertainty) * 100) / 100;

  const round = (v: number) => Math.round(v * 1e4) / 1e4;
  for (const c of Object.values(comps)) c.value = round(c.value);
  return {
    score,
    segment: i.branded === null ? 'unknown' : i.branded ? 'branded' : 'non_branded',
    components: comps,
    penalties: { risk: { value: round(risk), factors: riskFactors.map(([, why]) => why) }, uncertainty: { value: round(uncertainty), weight: p.uncertaintyWeight } },
    rawCounts: {
      impressions: i.impressions,
      clicks: i.clicks,
      ctr: i.ctr,
      position: i.position,
      sessions: i.sessions,
      convertingSessions: i.convertingSessions,
      rawConversionRate: i.sessions && i.convertingSessions !== null ? Math.round((i.convertingSessions / i.sessions) * 1e6) / 1e6 : null,
      smoothedConversionRate: conv?.smoothedRate === null || conv === null ? null : Math.round(conv.smoothedRate * 1e6) / 1e6,
      shrunkConvertingSessions: conv === null ? null : Math.round(conv.expected * 1e4) / 1e4,
      siteConversionRate: i.siteConversionRate,
      primaryEventOccurrences: i.primaryEventOccurrences,
      priorSessions: p.priorSessions,
      dataOrigin: i.synthetic ? 'SYNTHETIC' : 'measured',
    },
    notMeasured: ['backlinks', 'domain/page authority', 'search-volume estimates (not demand measurements)'],
    version: SCORING_VERSION,
  };
}

/** Rank within branded and non-branded groups separately. */
export function shortlist<T extends { result: ScoreResult }>(items: readonly T[], perSegment: number): { nonBranded: T[]; branded: T[]; unknown: T[] } {
  const by = (seg: ScoreResult['segment']) => items.filter((x) => x.result.segment === seg).sort((a, b) => b.result.score - a.result.score).slice(0, perSegment);
  return { nonBranded: by('non_branded'), branded: by('branded'), unknown: by('unknown') };
}

export type OpportunityKind = 'page' | 'page_query' | 'content' | 'technical' | 'measurement' | 'internal_link';

export function opportunityKindFor(route: Route, hasQuery: boolean): OpportunityKind {
  if (route === 'TECHNICAL_BLOCKER' || route === 'INDEXING_UNKNOWN') return 'technical';
  if (route === 'INVALID_OR_INCOMPLETE_DATA') return 'measurement';
  if (route === 'CONTENT_OPPORTUNITY') return 'content';
  return hasQuery ? 'page_query' : 'page';
}

export interface OpportunityRecord {
  siteId: string;
  routeDecisionId: string | null;
  route: Route;
  kind: OpportunityKind;
  pageId: string | null;
  query: string | null;
  isBranded: boolean | null;
  result: ScoreResult | null;
  status: 'candidate' | 'shortlisted' | 'archived' | 'deferred';
  statusReason: string | null;
  periodStart: string | null;
  periodEnd: string | null;
}

/**
 * Insert or update an opportunity for (site, route, page, query, period,
 * scoring version). Re-running scoring for the same period never duplicates.
 */
export function persistOpportunity(db: Db, o: OpportunityRecord, now: Date): string {
  const version = o.result?.version ?? SCORING_VERSION;
  const existing = db.get<{ id: string }>(
    `SELECT id FROM opportunities WHERE site_id = ? AND route = ? AND page_id IS ? AND query IS ? AND period_start IS ? AND period_end IS ? AND scoring_version IS ? AND status IN ('candidate', 'shortlisted', 'archived', 'deferred')`,
    [o.siteId, o.route, o.pageId, o.query, o.periodStart, o.periodEnd, version],
  );
  const ts = now.toISOString();
  const components = o.result ? JSON.stringify({ components: o.result.components, penalties: o.result.penalties, segment: o.result.segment, notMeasured: o.result.notMeasured }) : null;
  const raw = o.result ? JSON.stringify(o.result.rawCounts) : null;
  if (existing) {
    db.run(
      `UPDATE opportunities SET route_decision_id = ?, kind = ?, is_branded = ?, score = ?, score_components_json = ?, raw_counts_json = ?, status = ?, status_reason = ?, updated_at = ? WHERE id = ?`,
      [o.routeDecisionId, o.kind, o.isBranded === null ? null : o.isBranded ? 1 : 0, o.result?.score ?? null, components, raw, o.status, o.statusReason, ts, existing.id],
    );
    return existing.id;
  }
  const id = newId('opp');
  db.run(
    `INSERT INTO opportunities (id, site_id, route_decision_id, kind, route, page_id, query, is_branded, score, score_components_json, raw_counts_json, scoring_version, status, status_reason, period_start, period_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, o.siteId, o.routeDecisionId, o.kind, o.route, o.pageId, o.query, o.isBranded === null ? null : o.isBranded ? 1 : 0, o.result?.score ?? null, components, raw, version, o.status, o.statusReason, o.periodStart, o.periodEnd, ts, ts],
  );
  return id;
}
