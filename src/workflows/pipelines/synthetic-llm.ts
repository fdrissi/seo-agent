import type { FixtureHandler, FixtureRequestView } from '../../integrations/llm/fixture-client.js';

/**
 * Deterministic SYNTHETIC fixture handlers for the offline demo (and tests).
 *
 * They are registered with `createFixtureLlmClient` only when the context is
 * synthetic (demo profile). Every output is plainly labeled as a synthetic
 * fixture, derived only from the request's own evidence with simple keyword
 * rules; nothing here is a model answer. Prompt ids without a handler return
 * `needs_review` from the fixture client (never an invented answer), so the
 * callers degrade honestly (for example: content briefs fall back to the
 * deterministic brief, drafts are refused).
 *
 * Covered prompt ids (the ones the demo pipelines can reach):
 * - router.classify-intent  (weekly routing, ambiguous query intent)
 * - content.classify        (content queue, ambiguous candidates)
 * - research.reddit-signals (Apify signal classification)
 * - reports.executive-summary (optional report summary, text)
 * - content.draft           (a clearly marked placeholder package; every fact needs owner input)
 * - content.review          (never a pass: states that no AI review was performed)
 *
 * content.brief and analysis.serp-synthesis deliberately have no handler: the
 * brief falls back to the deterministic brief, and no synthesis is invented
 * (the weekly `compare` stage does not call the synthesis with the demo
 * fixture client and records "synthesis skipped: <reason>" instead).
 */

export const SYNTHETIC_LABEL = 'SYNTHETIC fixture (demo): keyword rules, not a model answer';

type Intent = 'informational' | 'commercial' | 'transactional' | 'navigational' | 'mixed' | 'unsure';

/** Tiny keyword heuristic used only to produce deterministic synthetic fixtures. */
export function syntheticIntent(text: string): Intent {
  const t = ` ${text.toLowerCase()} `;
  if (/\b(buy|price|pricing|cost|cheap|order|subscription|discount)\b/.test(t)) return 'transactional';
  if (/\b(best|vs|versus|review|compare|comparison|alternative|top)\b/.test(t)) return 'commercial';
  if (/\b(how|what|why|when|guide|checklist|steps|tips|clean|maintenance)\b/.test(t)) return 'informational';
  if (/\b(login|contact|support|account)\b/.test(t)) return 'navigational';
  return 'unsure';
}

function evidenceQuery(text: string): string | null {
  try {
    const v = JSON.parse(text) as { query?: unknown };
    return typeof v.query === 'string' ? v.query : null;
  } catch {
    return null;
  }
}

const routerClassifyIntent: FixtureHandler = (req: FixtureRequestView) => ({
  classifications: req.evidence
    .map((e) => evidenceQuery(e.text))
    .filter((q): q is string => !!q)
    .slice(0, 100)
    .map((query) => ({ query, intent: syntheticIntent(query), rationale: SYNTHETIC_LABEL })),
});

const contentClassify: FixtureHandler = (req: FixtureRequestView) => ({
  items: req.evidence.map((e) => {
    const intent = syntheticIntent(e.text);
    return { id: e.id, intent, confidence: intent === 'unsure' ? 'low' : 'medium', rationale: SYNTHETIC_LABEL };
  }),
});

function redditSignalType(text: string): 'question' | 'objection' | 'complaint' | 'comparison' | 'unmet_need' | 'tool_idea' | null {
  const t = text.toLowerCase();
  if (/\b(vs|versus|compared to|better than|alternative)\b/.test(t)) return 'comparison';
  if (/\b(wish|would love|missing|no way to|can't find)\b/.test(t)) return 'unmet_need';
  if (/\b(calculator|template|tool|spreadsheet|generator)\b/.test(t)) return 'tool_idea';
  if (/\b(too expensive|not worth|overpriced|doubt|skeptical)\b/.test(t)) return 'objection';
  if (/\b(broken|annoying|terrible|hate|problem|issue|doesn't work)\b/.test(t)) return 'complaint';
  if (t.includes('?') || /\b(how|what|why|which|anyone know)\b/.test(t)) return 'question';
  return null;
}

const redditSignals: FixtureHandler = (req: FixtureRequestView) => ({
  items: req.evidence.map((e) => ({ id: e.id, signalType: redditSignalType(e.text) })),
});

const executiveSummary: FixtureHandler = (req: FixtureRequestView) => {
  const kind = String(req.variables.report_kind ?? 'report');
  const start = String(req.variables.period_start ?? '?');
  const end = String(req.variables.period_end ?? '?');
  return `SYNTHETIC fixture summary (no model was called) for the ${kind} report ${start} to ${end}, built from ${req.evidence.length} computed claim(s). Read the labeled claims below for the actual figures. Next step: review the prioritized action and the data-quality warnings.`;
};

/**
 * Synthetic draft package (demo only). It is plainly marked as a placeholder
 * written by the fixture client, contains no factual claims, and flags every
 * fact as needing owner input, so the quality gates and the human review can
 * never mistake it for a publishable article.
 */
const contentDraft: FixtureHandler = (req: FixtureRequestView) => {
  const topic = (req.evidence[0]?.label ?? String(req.variables.intent ?? 'the topic')).replace(/\s+/g, ' ').slice(0, 80);
  const target = String(req.variables.target_page_url ?? 'none');
  const sections = req.evidence.slice(0, 3).map((e, i) => `## Section ${i + 1}: ${e.label.replace(/[#\n]/g, ' ').slice(0, 80)}\n\nOwner input needed: explain this point using verified product facts. (Synthetic placeholder text.)`);
  return {
    titleOptions: [`[SYNTHETIC DEMO] ${topic}`],
    metaDescription: `SYNTHETIC demo draft placeholder about ${topic}; not written by a model and not publishable.`,
    slugSuggestion: 'synthetic-demo-draft',
    bodyMarkdown: [
      `# [SYNTHETIC DEMO] ${topic}`,
      '',
      '> SYNTHETIC DEMO DRAFT: produced by the offline fixture client from the approved brief structure. It is not model output, contains no verified facts, and must not be published.',
      '',
      ...sections,
    ].join('\n'),
    internalLinkSuggestions: target !== 'none' && /^https?:\/\//.test(target) ? [{ targetUrl: target, anchor: 'related page', placement: 'end' }] : [],
    structuredDataProposal: null,
    sourceLedger: [],
    factCheckNotes: [{ statement: 'Every section of this synthetic draft', status: 'needs_owner_input' as const, evidenceIds: [], note: 'SYNTHETIC placeholder: replace with verified facts before any review for publication.' }],
  };
};

/** Synthetic AI review: never a pass. It states that no AI review was performed and requires human review. */
const contentReview: FixtureHandler = () => ({
  verdict: 'needs_human_review',
  issues: [],
  coverageGaps: ['SYNTHETIC fixture review: no AI review was performed.'],
  summary: 'SYNTHETIC fixture client: no model reviewed this draft. A human must review it; this is not a quality assessment.',
});

/** Handlers keyed by prompt id. */
export function syntheticLlmHandlers(): Record<string, FixtureHandler> {
  return {
    'router.classify-intent': routerClassifyIntent,
    'content.classify': contentClassify,
    'research.reddit-signals': redditSignals,
    'reports.executive-summary': executiveSummary,
    'content.draft': contentDraft,
    'content.review': contentReview,
  };
}
