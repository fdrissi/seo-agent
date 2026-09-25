import { z } from 'zod';
import type { EvidenceItem, LlmClient } from '../integrations/llm/types.js';
import type { IntentClassifierHook, IntentHookResult } from './intent.js';
import type { QueryIntent } from './types.js';

/**
 * Optional low-cost model classifier for GENUINELY ambiguous queries
 * (rules returned mixed/unsure). Uses the cheap tier and prompt
 * 'router.classify-intent'. Queries are passed as evidence (data), never as
 * instructions. Search queries are typed by third-party searchers, so they
 * are sent with trust class `user_reported` (unverified text), or `synthetic`
 * for synthetic/demo data; never as first-party measurement. The LLM client
 * handles budgets, token ceilings, schema validation, and bounded repairs;
 * when it is disabled, unconfigured, or over
 * budget, the hook reports that status and the router keeps the rule result
 * (which routes to UNSURE when the decision depends on intent).
 */

export const CLASSIFY_INTENT_PROMPT_ID = 'router.classify-intent';

const intentEnum = z.enum(['informational', 'commercial', 'transactional', 'navigational', 'mixed', 'unsure']);

export const intentClassificationSchema = z.object({
  classifications: z
    .array(
      z.object({
        query: z.string().min(1),
        intent: intentEnum,
        rationale: z.string().max(400),
      }),
    )
    .max(100),
});
export type IntentClassification = z.infer<typeof intentClassificationSchema>;

export interface LlmIntentOptions {
  siteId: string;
  runId: string;
  /** Short, non-secret business context (offer/target customer) to judge relevance. */
  businessContext?: string;
  maxOutputTokens?: number;
  /** The queries come from synthetic (fixture/demo) data. */
  synthetic?: boolean;
}

export function createLlmIntentClassifier(llm: LlmClient, opts: LlmIntentOptions): IntentClassifierHook {
  return async (items) => {
    if (!llm.isConfigured('cheap')) return { ok: false, status: 'not_configured', reason: 'cheap model tier is not configured; ambiguous queries stay unsure' } satisfies IntentHookResult;
    const evidence: EvidenceItem[] = items.map((it, i) => ({
      id: `q${i + 1}`,
      label: 'search query (Search Console, untrusted text)',
      text: JSON.stringify({ query: it.query, ruleIntent: it.ruleIntent, branded: it.branded, ruleSignals: it.signals }),
      trustClass: opts.synthetic ? 'synthetic' : 'user_reported',
    }));
    const res = await llm.structured<IntentClassification>({
      siteId: opts.siteId,
      runId: opts.runId,
      role: 'classifier',
      tier: 'cheap',
      promptId: CLASSIFY_INTENT_PROMPT_ID,
      variables: { queryCount: items.length, businessContext: opts.businessContext ?? '(not provided)', allowedIntents: intentEnum.options.join(', ') },
      evidence,
      schema: intentClassificationSchema,
      schemaName: 'IntentClassification',
      maxOutputTokens: opts.maxOutputTokens ?? Math.min(1_500, 60 + items.length * 60),
    });
    if (!res.ok) return { ok: false, status: res.status, reason: res.reason };
    const asked = new Set(items.map((i) => i.query));
    const results = new Map<string, { intent: QueryIntent; rationale: string }>();
    for (const c of res.value.classifications) {
      // Ignore anything the model returns that was not asked (defensive against injected queries).
      if (asked.has(c.query) && !results.has(c.query)) results.set(c.query, { intent: c.intent, rationale: c.rationale });
    }
    return { ok: true, results };
  };
}
