import { newId } from '../core/ids.js';
import { valueOf, type Measured } from '../core/measured.js';
import type { Db } from '../database/db.js';
import type { Period } from '../seo/metrics.js';
import { normalizeQuery } from './intent.js';
import { reasonInputsData, rulesVersionFor, type RuleId } from './rules.js';
import { ROUTE_NEXT_STEP, type IntentResult, type ReasonCode, type RouteDecision, type RouterThresholds } from './types.js';

export * from './types.js';
export { DEFAULT_RULE_ORDER, PREREQUISITE_RULES, RULES_VERSION, deriveSignals, evaluateRoute, resolveRuleOrder, ruleOrderFromConfig, rulesVersionFor, thresholdsFromConfig, type RuleId } from './rules.js';
export { classifyQueries, IntentClassifierRules, INTENT_RULES_VERSION, normalizeQuery, type IntentClassifierHook, type IntentOptions } from './intent.js';
export { createLlmIntentClassifier, CLASSIFY_INTENT_PROMPT_ID } from './llm-intent.js';

export interface SiteRouteInput {
  siteId: string;
  period: Period;
  gsc: 'complete' | 'incomplete' | 'missing' | 'unresolved';
  gscDetail: string;
  ga4: 'complete' | 'incomplete' | 'missing' | 'unresolved' | 'not_configured';
  ga4Detail: string;
  conversionDefinition: 'configured' | 'missing';
  totalImpressions: Measured<number>;
  windowDays: number;
  notSetShare: Measured<number>;
}

/**
 * Site-level prerequisite routing. Returns INVALID_OR_INCOMPLETE_DATA or
 * LOW_DATA when a site-wide condition applies, otherwise null (no site-level
 * constraint; pages are routed individually).
 */
export function routeSite(input: SiteRouteInput, t: RouterThresholds, order?: readonly RuleId[]): RouteDecision | null {
  const reasons: ReasonCode[] = [];
  // Coverage reasons rest on the recorded ingestion coverage; property and conversion-definition reasons on configuration only (no inputs).
  if (input.gsc === 'unresolved') reasons.push({ code: 'GSC_PROPERTY_UNRESOLVED', detail: input.gscDetail });
  else if (input.gsc === 'missing') reasons.push({ code: 'GSC_DATA_MISSING', detail: input.gscDetail, data: reasonInputsData(input.period, 'gsc', 'ingestion_batches', { values: { coverage: 'missing' } }) });
  else if (input.gsc === 'incomplete') reasons.push({ code: 'GSC_DATA_INCOMPLETE', detail: input.gscDetail, data: reasonInputsData(input.period, 'gsc', 'ingestion_batches', { values: { coverage: 'incomplete' } }) });
  if (input.ga4 === 'unresolved' || (input.ga4 === 'not_configured' && t.requireConversionDefinition)) reasons.push({ code: 'GA4_PROPERTY_UNRESOLVED', detail: input.ga4Detail });
  else if (input.ga4 === 'missing') reasons.push({ code: 'GA4_DATA_MISSING', detail: input.ga4Detail, data: reasonInputsData(input.period, 'ga4', 'ingestion_batches', { values: { coverage: 'missing' } }) });
  else if (input.ga4 === 'incomplete') reasons.push({ code: 'GA4_DATA_INCOMPLETE', detail: input.ga4Detail, data: reasonInputsData(input.period, 'ga4', 'ingestion_batches', { values: { coverage: 'incomplete' } }) });
  if (input.conversionDefinition === 'missing' && t.requireConversionDefinition) reasons.push({ code: 'MISSING_CONVERSION_DEFINITION', detail: 'conversions.primaryEvents is empty' });
  const ns = valueOf(input.notSetShare);
  if (ns !== undefined && ns > t.notSetShareMax) reasons.push({ code: 'GA4_NOT_SET_SHARE_HIGH', detail: `${(ns * 100).toFixed(1)}% of google_organic sessions have landing page "(not set)"`, data: reasonInputsData(input.period, 'ga4', 'ga4_landing_daily_current', { values: { notSetShare: ns, threshold: t.notSetShareMax } }) });
  const base = {
    subjectType: 'site' as const,
    siteId: input.siteId,
    pageId: null,
    query: null,
    notes: [] as ReasonCode[],
    decidedBy: 'rule' as const,
    rulesVersion: rulesVersionFor(t, order),
    period: input.period,
    inputsSummary: { ...input, totalImpressions: valueOf(input.totalImpressions) ?? input.totalImpressions, notSetShare: valueOf(input.notSetShare) ?? input.notSetShare },
  };
  if (reasons.length) {
    return { ...base, route: 'INVALID_OR_INCOMPLETE_DATA', reasons, trace: [{ rule: 'invalid_data', matched: true, route: 'INVALID_OR_INCOMPLETE_DATA', reasons }], nextStep: ROUTE_NEXT_STEP.INVALID_OR_INCOMPLETE_DATA };
  }
  const total = valueOf(input.totalImpressions);
  if (total !== undefined && total < t.lowDataSiteMaxImpressions) {
    const r: ReasonCode[] = [
      { code: 'SITE_LOW_DATA', detail: `${total} impressions (property totals) over ${input.windowDays} days < ${t.lowDataSiteMaxImpressions}`, data: reasonInputsData(input.period, 'gsc', 'gsc_property_daily_current', { values: { totalImpressions: total, windowDays: input.windowDays, lowDataSiteMaxImpressions: t.lowDataSiteMaxImpressions } }) },
    ];
    return { ...base, route: 'LOW_DATA', reasons: r, trace: [{ rule: 'invalid_data', matched: false, reasons: [] }, { rule: 'low_data', matched: true, route: 'LOW_DATA', reasons: r }], nextStep: `${ROUTE_NEXT_STEP.LOW_DATA} Produce an offer-page brief, one useful supporting-page brief, and measurement/technical-readiness checks; no historical conversion evidence is assumed.` };
  }
  return null;
}

export interface ContentSignalInput {
  siteId: string;
  signalId: string;
  text: string;
  origin: string;
  signalType: string;
  /** How many independent sources/occurrences carry this signal. */
  occurrences: number;
  /** Business vocabulary from config (offer, differentiators, seed topics, product facts). */
  businessTerms: readonly string[];
  /** Explicit owner decision recorded in the decisions table, if any. */
  ownerDecision?: 'irrelevant' | null;
}

function termTokens(s: string): Set<string> {
  return new Set(normalizeQuery(s).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3));
}

/** Route a content-discovery signal. Relevance is never auto-dismissed: unclear relevance -> UNSURE. */
export function routeContentSignal(input: ContentSignalInput, intent: IntentResult, t: RouterThresholds): RouteDecision {
  const base = {
    subjectType: 'content_signal' as const,
    siteId: input.siteId,
    pageId: null,
    query: input.text,
    notes: [] as ReasonCode[],
    rulesVersion: rulesVersionFor(t),
    period: null,
    trace: [],
    inputsSummary: { signalId: input.signalId, origin: input.origin, signalType: input.signalType, occurrences: input.occurrences, intent: intent.intent, branded: intent.branded },
  };
  if (input.ownerDecision === 'irrelevant') {
    return { ...base, route: 'IRRELEVANT', reasons: [{ code: 'OUT_OF_SCOPE', detail: 'owner decision marks this topic as outside business scope' }], decidedBy: 'owner', nextStep: ROUTE_NEXT_STEP.IRRELEVANT };
  }
  const decidedBy = intent.decidedBy === 'model' ? ('model' as const) : ('rule' as const);
  if (intent.ambiguous) {
    return { ...base, route: 'UNSURE', reasons: [{ code: intent.intent === 'mixed' ? 'MIXED_INTENT' : 'AMBIGUOUS_INTENT', detail: `signal intent is ${intent.intent}` }], decidedBy, nextStep: ROUTE_NEXT_STEP.UNSURE };
  }
  const terms = new Set<string>();
  for (const b of input.businessTerms) for (const tok of termTokens(b)) terms.add(tok);
  const overlap = [...termTokens(input.text)].filter((tok) => terms.has(tok));
  if (terms.size === 0 || overlap.length === 0) {
    return { ...base, route: 'UNSURE', reasons: [{ code: 'AMBIGUOUS_INTENT', detail: terms.size === 0 ? 'no business vocabulary configured to judge relevance' : 'no overlap with configured business vocabulary; relevance unclear (not auto-dismissed)' }], decidedBy, nextStep: ROUTE_NEXT_STEP.UNSURE };
  }
  const reasons: ReasonCode[] = [{ code: 'UNCOVERED_DEMAND_QUERIES', detail: `relevant to business terms: ${overlap.slice(0, 5).join(', ')}` }];
  if (input.occurrences >= 2) reasons.unshift({ code: 'RECURRING_CUSTOMER_QUESTION', detail: `${input.occurrences} occurrences across sources (engagement is not search volume)` });
  return { ...base, route: 'CONTENT_OPPORTUNITY', reasons, decidedBy, nextStep: ROUTE_NEXT_STEP.CONTENT_OPPORTUNITY };
}

/** Persist a routing decision. Reason codes and non-routing notes are both kept. */
export function persistRouteDecision(db: Db, d: RouteDecision, opts: { jobId?: string | null; now: Date }): string {
  const id = newId('route');
  const reasonCodes = [...d.reasons.map((r) => ({ ...r, kind: 'reason' })), ...d.notes.map((r) => ({ ...r, kind: 'note' }))];
  db.run(
    `INSERT INTO route_decisions (id, site_id, job_id, subject_type, page_id, query, route, reason_codes_json, inputs_json, decided_by, rules_version, period_start, period_end, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      d.siteId,
      opts.jobId ?? null,
      d.subjectType,
      d.pageId,
      d.query,
      d.route,
      JSON.stringify(reasonCodes),
      JSON.stringify({ summary: d.inputsSummary, trace: d.trace, nextStep: d.nextStep }),
      d.decidedBy,
      d.rulesVersion,
      d.period?.start ?? null,
      d.period?.end ?? null,
      opts.now.toISOString(),
    ],
  );
  return id;
}

/**
 * Record query intent/branding on `keywords` (language unknown -> NULL).
 * An existing keyword row for the same normalized query is reused whatever
 * its language (a language-NULL row is preferred, then the oldest row), so a
 * query researched with a language (DataForSEO) is not duplicated as a
 * language-NULL row. Manual and SERP-derived intents are never overwritten.
 */
export function persistQueryIntents(db: Db, siteId: string, intents: readonly IntentResult[], now: Date): { inserted: number; updated: number } {
  let inserted = 0;
  let updated = 0;
  db.transaction(() => {
    for (const i of intents) {
      const existing = db.get<{ id: string; intent_source: string | null }>(
        'SELECT id, intent_source FROM keywords WHERE site_id = ? AND normalized = ? ORDER BY (language IS NULL) DESC, first_seen_at ASC, id ASC LIMIT 1',
        [siteId, i.normalized],
      );
      const source = i.decidedBy === 'model' ? 'model' : 'rule';
      if (!existing) {
        db.run(
          `INSERT INTO keywords (id, site_id, keyword, normalized, language, is_branded, intent, intent_source, first_seen_at, origins_json) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
          [newId('kw'), siteId, i.query, i.normalized, i.branded ? 1 : 0, i.intent, source, now.toISOString(), JSON.stringify(['gsc_query'])],
        );
        inserted++;
      } else if (existing.intent_source === null || existing.intent_source === 'rule' || existing.intent_source === 'model') {
        db.run('UPDATE keywords SET is_branded = ?, intent = ?, intent_source = ? WHERE id = ?', [i.branded ? 1 : 0, i.intent, source, existing.id]);
        updated++;
      }
    }
  });
  return { inserted, updated };
}
