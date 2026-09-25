import { z } from 'zod';
import type { AppContext } from '../app/context.js';
import type { TrustClass } from '../core/modes.js';
import type { EvidenceItem, LlmClient } from '../integrations/llm/types.js';
import { IntentClassifierRules, type BrandAnalysis } from '../router/intent.js';
import { brandMatcher } from './signals.js';
import { contentTokens } from './text.js';
import { INTENTS, TRUST_BY_ORIGIN, type Candidate, type Classification, type ClassifyOutput, type Intent, type SignalOrigin } from './types.js';

/**
 * CLASSIFY (ROUTER pattern): deterministic rules route obvious intents; a
 * cheap model call handles only genuinely ambiguous candidates, in bounded
 * batches. Candidate text is passed to the model ONLY as untrusted evidence,
 * never inside the prompt template. Without a configured model, ambiguous
 * candidates become `unsure` (never force-classified).
 */

export const CLASSIFY_PROMPT_ID = 'content.classify';
export const CLASSIFY_RULES_VERSION = 'intent-rules@2';
export const CLASSIFY_BATCH_SIZE = 25;

interface Rule {
  id: string;
  intent: Exclude<Intent, 'mixed' | 'unsure'>;
  re: RegExp;
}

/** Default English rules. Other languages fall through to the model or `unsure` (documented). */
export const DEFAULT_INTENT_RULES: Rule[] = [
  { id: 'txn_purchase', intent: 'transactional', re: /\b(buy|order|purchase|for sale|shop|checkout|coupon|discount|promo code|deal|deals)\b/i },
  { id: 'txn_price', intent: 'transactional', re: /\b(price|prices|pricing|cost|costs|quote|how much|cheap|cheapest|fee|fees)\b/i },
  { id: 'txn_action', intent: 'transactional', re: /\b(hire|book|booking|subscribe|subscription|sign up|signup|free trial|trial|download|near me|install)\b/i },
  { id: 'com_best', intent: 'commercial', re: /\b(best|top \d*|recommended|recommend|worth it)\b/i },
  { id: 'com_compare', intent: 'commercial', re: /\b(vs\.?|versus|compare|comparison|compared|alternative|alternatives|pros and cons|difference between)\b/i },
  { id: 'com_review', intent: 'commercial', re: /\b(review|reviews|rating|ratings)\b/i },
  { id: 'nav_account', intent: 'navigational', re: /\b(login|log in|sign in|my account|customer service|contact number|official site|official website)\b/i },
  { id: 'info_question', intent: 'informational', re: /^(how|what|why|when|where|who|which|can|could|should|is|are|does|do|will|would)\b/i },
  { id: 'info_learning', intent: 'informational', re: /\b(guide|tutorial|examples?|meaning|definition|define|ideas|tips|checklist|explained|learn|steps|how to|what is|ways to)\b/i },
];

const FORMAT_RULES: Array<{ hint: Classification['formatHints'][number]; re: RegExp }> = [
  { hint: 'tool', re: /\b(calculator|calculate|estimator|estimate|generator|converter|checker|planner tool|tool)\b/i },
  { hint: 'template', re: /\b(template|templates|sample|spreadsheet|printable|example document|swipe file)\b/i },
  { hint: 'checklist', re: /\b(checklist|check list)\b/i },
  { hint: 'comparison', re: /\b(vs\.?|versus|compare|comparison|alternative|alternatives)\b/i },
  { hint: 'guide', re: /\b(how to|guide|tutorial|step by step)\b/i },
];

export function formatHints(text: string): Classification['formatHints'] {
  return FORMAT_RULES.filter((r) => r.re.test(text)).map((r) => r.hint);
}

/**
 * Pure rule classification. Returns null when the case is ambiguous.
 *
 * With `brand` (brand-alias analysis, see router/intent.ts), the matched
 * alias tokens are stripped BEFORE the rules run, so words inside a brand
 * name ("Example Widgets", "Guide Hub", "Best Buy") never supply intent. A
 * branded query whose remaining words are only navigational (contact, login,
 * hours, phone...) or nothing is navigational. Without `brand`, the legacy
 * `isBranded` heuristic applies (short branded query without a question).
 */
export function classifyByRules(
  text: string,
  opts: { isBranded?: (t: string) => boolean; rules?: Rule[]; brand?: (t: string) => BrandAnalysis } = {},
): { intent: Intent; confidence: Classification['confidence']; matched: string[]; rationale: string } | null {
  const rules = opts.rules ?? DEFAULT_INTENT_RULES;
  const analysis = opts.brand?.(text) ?? null;
  if (analysis?.branded) {
    if (analysis.brandOnly) return { intent: 'navigational', confidence: 'high', matched: ['brand_only'], rationale: `Only the brand name ("${analysis.matchedAlias}"): navigational.` };
    if (analysis.navigationalOnly) {
      return { intent: 'navigational', confidence: 'high', matched: ['brand_navigational'], rationale: `Brand name plus navigational words only ("${analysis.remainingTokens.join(' ')}"): the searcher wants an existing page of the brand.` };
    }
  }
  // Rules match the text OUTSIDE the brand alias (brand tokens removed).
  const subject = analysis?.branded ? analysis.remainingTokens.join(' ') : text;
  const matched = rules.filter((r) => r.re.test(subject));
  const intents = new Set(matched.map((r) => r.intent));
  const ids = matched.map((r) => r.id);
  const tokens = contentTokens(text);
  const branded = analysis ? analysis.branded : (opts.isBranded?.(text) ?? false);

  if (!analysis && branded && tokens.length <= 2 && !intents.has('informational')) {
    return { intent: 'navigational', confidence: 'high', matched: [...ids, 'brand_only'], rationale: 'Short branded query without a question: navigational.' };
  }
  const brandNote = analysis?.branded ? ` (brand "${analysis.matchedAlias}" removed before matching)` : '';
  if (intents.size === 1) {
    const intent = [...intents][0]!;
    return { intent, confidence: matched.length >= 2 ? 'high' : 'medium', matched: ids, rationale: `Matched ${intent} rule(s): ${ids.join(', ')}${brandNote}.` };
  }
  if (intents.size === 2 && intents.has('informational') && intents.has('commercial')) {
    return { intent: 'commercial', confidence: 'medium', matched: ids, rationale: `Question about options or evaluation ("best", "vs", "review"): commercial investigation${brandNote}.` };
  }
  if (intents.size === 2 && intents.has('informational') && intents.has('transactional') && matched.every((r) => r.id !== 'txn_purchase' && r.id !== 'txn_action')) {
    return { intent: 'commercial', confidence: 'medium', matched: ids, rationale: `Pricing/cost question: researching before a purchase (commercial)${brandNote}.` };
  }
  return null;
}

/** Brand-alias analysis for the site's configured aliases and languages (shared with the router rules). */
export function contentBrandAnalyzer(ctx: Pick<AppContext, 'config'>): (text: string) => BrandAnalysis {
  const rules = new IntentClassifierRules({ brandAliases: ctx.config.brand.aliases, languages: ctx.config.market.languages });
  return (text: string) => rules.brandAnalysis(text);
}

const TRUST_ORDER: TrustClass[] = ['owner_approved', 'first_party_measurement', 'third_party_data', 'user_reported', 'scraped_untrusted', 'model_generated', 'synthetic'];

/** The least-trusted class among a candidate's origins (evidence is labeled conservatively). */
export function candidateTrust(origins: string[]): TrustClass {
  let worst = 0;
  for (const o of origins) {
    const t = TRUST_BY_ORIGIN[o as SignalOrigin] ?? 'scraped_untrusted';
    worst = Math.max(worst, TRUST_ORDER.indexOf(t));
  }
  return TRUST_ORDER[worst]!;
}

export const classifyModelSchema = z.object({
  items: z.array(z.object({ id: z.string(), intent: z.enum(INTENTS), confidence: z.enum(['high', 'medium', 'low']), rationale: z.string().max(500) })),
});

export interface ClassifyOptions {
  /** Use the cheap model for ambiguous candidates when configured (default true). */
  useModel?: boolean;
  /** Intents already known for candidates attached to existing items (by candidate key). */
  knownIntents?: Map<string, Intent>;
}

export async function classifyCandidates(ctx: AppContext, llm: LlmClient | null, candidates: Candidate[], opts: ClassifyOptions = {}): Promise<ClassifyOutput> {
  const isBranded = brandMatcher(ctx);
  const brand = contentBrandAnalyzer(ctx);
  const out: Classification[] = [];
  const ambiguous: Candidate[] = [];
  for (const c of candidates) {
    const hints = formatHints(c.text);
    const r = classifyByRules(c.text, { isBranded, brand });
    if (r) {
      out.push({ key: c.key, intent: r.intent, source: 'rule', confidence: r.confidence, matchedRules: r.matched, formatHints: hints, rationale: r.rationale });
      continue;
    }
    const known = opts.knownIntents?.get(c.key);
    if (known && known !== 'unsure') {
      out.push({ key: c.key, intent: known, source: 'rule', confidence: 'medium', matchedRules: ['existing_item_intent'], formatHints: hints, rationale: 'Rules were ambiguous; reused the intent already recorded for this content item.' });
      continue;
    }
    ambiguous.push(c);
  }

  let modelCalls = 0;
  let modelStatus = 'not_needed';
  let promptVersion: string | null = null;
  const modelEnabled = opts.useModel !== false && !!llm && ctx.settings.features.llm && llm.isConfigured('cheap') && !ctx.dryRun;
  const resolved = new Map<string, Classification>();
  if (ambiguous.length) {
    if (!modelEnabled) {
      modelStatus = !llm
        ? 'unavailable: LLM client not wired'
        : ctx.dryRun
          ? 'skipped: dry run'
          : opts.useModel === false
            ? 'skipped: model disabled for this run'
            : !ctx.settings.features.llm
              ? 'disabled: features.llm is false'
              : 'not_configured: set CHEAP_MODEL (or models.cheap) to classify ambiguous intent';
    } else {
      modelStatus = 'completed';
      for (let i = 0; i < ambiguous.length; i += CLASSIFY_BATCH_SIZE) {
        const chunk = ambiguous.slice(i, i + CLASSIFY_BATCH_SIZE);
        const evidence: EvidenceItem[] = chunk.map((c) => ({ id: c.key, label: `Candidate ${c.key} (${c.origins.join(', ')})`, text: c.text, trustClass: candidateTrust(c.origins) }));
        const res = await llm!.structured({
          siteId: ctx.siteId,
          runId: ctx.runId,
          role: 'classifier',
          tier: 'cheap',
          promptId: CLASSIFY_PROMPT_ID,
          variables: {
            allowed_intents: INTENTS.join(', '),
            candidate_ids: chunk.map((c) => c.key).join(', '),
            site_name: ctx.config.site.businessName,
            languages: ctx.config.market.languages.join(', ') || 'unspecified',
          },
          evidence,
          schema: classifyModelSchema,
          schemaName: 'ContentIntentClassification',
          maxOutputTokens: ctx.config.llm.maxOutputTokensCheap,
        });
        modelCalls++;
        if (!res.ok) {
          modelStatus = `${res.status}: ${res.reason}`;
          continue;
        }
        promptVersion = res.promptVersion;
        const allowed = new Set(chunk.map((c) => c.key));
        for (const item of res.value.items) {
          if (!allowed.has(item.id) || resolved.has(item.id)) continue; // unknown/duplicate ids from the model are ignored
          resolved.set(item.id, {
            key: item.id,
            intent: item.intent,
            source: 'model',
            confidence: item.confidence,
            matchedRules: [],
            formatHints: formatHints(chunk.find((c) => c.key === item.id)!.text),
            rationale: `Model (${res.model}, ${res.promptVersion}): ${item.rationale}`.slice(0, 600),
          });
        }
      }
    }
  }
  for (const c of ambiguous) {
    out.push(
      resolved.get(c.key) ?? {
        key: c.key,
        intent: 'unsure',
        source: 'fallback',
        confidence: 'low',
        matchedRules: [],
        formatHints: formatHints(c.text),
        rationale: `Rules could not determine intent; ${modelStatus === 'completed' ? 'model returned no classification for this candidate' : `model ${modelStatus}`}. Needs human classification before a brief.`,
      },
    );
  }
  const order = new Map(candidates.map((c, i) => [c.key, i]));
  out.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
  return { candidates, classifications: out, ambiguousCount: ambiguous.length, modelCalls, modelStatus, promptVersion };
}
