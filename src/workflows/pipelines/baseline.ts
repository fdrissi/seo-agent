import { z } from 'zod';
import type { AppContext } from '../../app/context.js';
import { errorMessage } from '../../core/errors.js';
import { formatUsd, type Micros } from '../../core/money.js';
import { NO_RETRY } from '../../core/retry.js';
import { loadCachedCatalog } from '../../integrations/llm/models.js';
import { planLlmCost } from '../../integrations/llm/plan.js';
import { createSeoStages } from '../../seo/stages.js';
import { defineStage, type EngineStage } from '../stage.js';
import type { CostAllowance } from '../types.js';
import {
  acquireLockStage,
  checkAccessStage,
  crawlSiteStage,
  indexMemoryStage,
  inspectUrlsStage,
  measurementStage,
  note,
  noteSchema,
  paramsOf,
  performanceStage,
  planPeriodStage,
  reportStage,
  syncGa4Stage,
  syncGscStage,
  withNext,
  type PipelineEnv,
} from './common.js';

/**
 * BASELINE (spec section 27):
 *   validate access -> collect available 90-day GSC/GA4 history -> bounded
 *   own-site crawl -> reconcile URLs -> check measurement -> index selected
 *   memory -> dashboard and baseline report (+ vault notes).
 *
 * No paid DataForSEO or Apify request is made. Optional LLM/embedding work is
 * shown as a PROPOSED COST PLAN first and runs only when the owner passes an
 * explicit approval with a cap at least as large as the displayed upper
 * bound (`baseline --approve-cost-plan <usd>`); unknown prices can never be
 * approved this way. The baseline reports blockers, starts no experiments,
 * and publishes nothing.
 */

export const BASELINE_WORKFLOW = 'baseline';

export const BASELINE_STAGE_ORDER = [
  'acquire_lock',
  'check_access',
  'sync_gsc',
  'plan_period',
  'sync_ga4',
  'crawl_site',
  'performance',
  'reconcile_urls',
  'inspect_urls',
  'check_measurement',
  'index_memory',
  'cost_plan',
  'optional_ai',
  'report',
] as const;

const costLine = z.object({
  label: z.string(),
  status: z.enum(['proposed', 'nothing_pending', 'unavailable']),
  upperBoundMicros: z.number().nullable(),
  detail: z.string(),
});
export const costPlanOutput = z.object({
  lines: z.array(costLine),
  /** Sum of proposed upper bounds; null when any proposed line has no verified price (never $0). */
  totalUpperBoundMicros: z.number().nullable(),
  capMicros: z.number().nullable(),
  approved: z.boolean(),
  reason: z.string(),
  display: z.string(),
});
export type CostPlanOutput = z.infer<typeof costPlanOutput>;

/** LLM Gateway allowance for the optional work: the approved cap, never above the per-run budget. */
export function approvedAllowance(app: AppContext, capMicros: number | undefined): CostAllowance[] | null {
  if (capMicros === undefined || app.dryRun) return null;
  return [{ provider: 'llm_gateway', maxMicros: Math.max(0, Math.min(capMicros, app.settings.budgets.llmGateway.perRun)) }];
}

const SCOPE_LABEL: Record<string, string> = {
  run: 'per-run',
  site_service_month: 'LLM Gateway monthly',
  site_service_week: 'LLM Gateway weekly',
  site_combined_month: 'combined monthly (all providers)',
  account_service_month: 'shared account monthly',
};

/**
 * Why the plan's upper bound does not fit what is LEFT of the LLM budgets
 * (this run, the month, the combined monthly ceiling that DataForSEO and Apify
 * spend also count against, the shared account cap), or null when it fits.
 * A limit that cannot be verified (an outstanding charge without an upper
 * bound) never fits.
 */
export function remainingBudgetProblem(app: Pick<AppContext, 'budgets' | 'siteId'>, runId: string, totalMicros: number): string | null {
  const checks = app.budgets.checkLimits({ siteId: app.siteId, provider: 'llm_gateway', runId, amountMicros: totalMicros });
  for (const c of checks) {
    const label = SCOPE_LABEL[c.scope] ?? c.scope;
    if ((c.unboundedUnknownCount ?? 0) > 0) return `the ${label} budget cannot be verified while ${c.unboundedUnknownCount} approved charge(s) without an upper bound are outstanding; reconcile them first (\`npm run cli -- costs --unresolved\`).`;
    if (c.committedMicros + c.requestedMicros > c.limitMicros) {
      const left = Math.max(0, c.limitMicros - c.committedMicros);
      return `the upper bound ${formatUsd(totalMicros)} does not fit the remaining ${label} budget (${formatUsd(left)} of ${formatUsd(c.limitMicros)} left); wait for the next period or raise the ceiling in the site config budgets (never automatic).`;
    }
  }
  return null;
}

function costPlanStage(env: PipelineEnv): EngineStage {
  return defineStage({
    name: 'cost_plan',
    version: 'cost_plan@2',
    description: 'Proposed cost plan for optional LLM/embedding work (conservative upper bounds from verified prices; unknown stays unknown). Nothing runs without an explicit approval with a cap.',
    input: z.object({ capMicros: z.number().nullable(), dryRun: z.boolean() }),
    output: costPlanOutput,
    prerequisites: ['index_memory'],
    evidence: { requirement: 'Pending memory chunks, the cached gateway model catalog, llm.pricingOverrides, and budgets.' },
    timeoutMs: 60_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    idempotent: true,
    stoppingConditions: ['Never stops: an unapproved plan is shown and skipped.'],
    next: ['optional_ai'],
    buildInput: (sctx, params) => ({ capMicros: paramsOf(params).approveCostPlanMicros ?? null, dryRun: sctx.app.dryRun }),
    run: async (input, sctx) => {
      const app = sctx.app;
      const svc = env.services(app);
      const lines: CostPlanOutput['lines'] = [];
      // 1. Embeddings for pending memory chunks.
      if (!svc.embeddingsAvailable) {
        lines.push({ label: 'Embeddings for memory (semantic retrieval)', status: 'unavailable', upperBoundMicros: null, detail: 'Embeddings are not configured or disabled (features.embeddings, EMBEDDING_MODEL, LLM_GATEWAY_API_KEY); memory stays full-text only.' });
      } else {
        try {
          const paid = svc.memoryWithEmbeddings().plan().paid;
          if (!paid.required) lines.push({ label: 'Embeddings for memory', status: 'nothing_pending', upperBoundMicros: 0, detail: paid.note });
          else lines.push({ label: `Embed ${paid.items} pending memory chunk(s), about ${paid.estimatedTokens} tokens`, status: 'proposed', upperBoundMicros: paid.estimatedCostMicros, detail: `${paid.priceBasis}. ${paid.note}` });
        } catch (err) {
          lines.push({ label: 'Embeddings for memory', status: 'unavailable', upperBoundMicros: null, detail: `Embedding plan unavailable: ${errorMessage(err)}` });
        }
      }
      // 2. Optional model-generated executive summary (one cheap call).
      if (!svc.llm.isConfigured('cheap')) {
        lines.push({ label: 'Model-generated executive summary (optional)', status: 'unavailable', upperBoundMicros: null, detail: 'No cheap model is configured; the report stays fully deterministic.' });
      } else if (svc.llm.synthetic) {
        lines.push({ label: 'Model-generated executive summary (SYNTHETIC fixture client)', status: 'proposed', upperBoundMicros: 0, detail: 'Demo: the fixture client calls no provider, so the cost is exactly $0.' });
      } else {
        const catalog = loadCachedCatalog(app);
        if (!catalog) lines.push({ label: 'Model-generated executive summary (optional)', status: 'proposed', upperBoundMicros: null, detail: 'No cached gateway model catalog (run `npm run cli -- models list`); the price is unknown.' });
        else {
          const plan = planLlmCost(app, catalog, [{ label: 'executive summary', tier: 'cheap', requests: 1, inputTokensPerRequest: 4_000, maxOutputTokens: 400 }]);
          const l = plan.lines[0]!;
          lines.push({ label: `Model-generated executive summary (1 request, ${l.modelId ?? 'cheap model'})`, status: 'proposed', upperBoundMicros: l.upperBoundMicros, detail: l.detail });
        }
      }
      const proposed = lines.filter((l) => l.status === 'proposed');
      const total: Micros | null = proposed.some((l) => l.upperBoundMicros === null) ? null : proposed.reduce((s, l) => s + (l.upperBoundMicros ?? 0), 0);
      let approved = false;
      let reason: string;
      let blocked: string | null = null;
      if (!proposed.length) reason = 'Nothing optional to run (no pending embeddings and no model summary available).';
      else if (input.dryRun) reason = 'Dry run: the cost plan is shown but never executed.';
      else if (input.capMicros === null) reason = 'Not approved: pass --approve-cost-plan <usd> with a cap at least as large as the displayed upper bound to run it.';
      else if (total === null) reason = 'Not approved: at least one proposed line has no verified price (unknown is never treated as $0); configure a verified price (llm.pricingOverrides) or refresh `models list`.';
      else if (total > input.capMicros) reason = `Not approved: the upper bound ${formatUsd(total)} exceeds the approved cap ${formatUsd(input.capMicros)}.`;
      else if (total > app.settings.budgets.llmGateway.perRun) reason = `Not approved: the upper bound ${formatUsd(total)} exceeds the LLM Gateway per-run budget ${formatUsd(app.settings.budgets.llmGateway.perRun)}.`;
      else if ((blocked = remainingBudgetProblem(app, sctx.jobId, total))) reason = `Not approved: ${blocked}`;
      else {
        approved = true;
        reason = `Approved by the owner with cap ${formatUsd(input.capMicros)} (upper bound ${formatUsd(total)}); budgets are still enforced per request.`;
      }
      const display = [
        'PROPOSED COST PLAN (optional LLM/embedding work; estimates, not price quotes):',
        ...lines.map((l) => `  - ${l.label}: ${l.status === 'proposed' ? (l.upperBoundMicros === null ? 'UNKNOWN price' : `up to ${formatUsd(l.upperBoundMicros)}`) : l.status.replace('_', ' ')} (${l.detail})`),
        `  Total upper bound: ${proposed.length ? (total === null ? 'UNKNOWN' : formatUsd(total)) : 'nothing to run'}.`,
        approved ? `  ${reason}` : proposed.length && total !== null && !input.dryRun ? `  To run it: npm run cli -- baseline --approve-cost-plan ${(total / 1_000_000).toFixed(6)}` : `  ${reason}`,
      ].join('\n');
      return { lines, totalUpperBoundMicros: total, capMicros: input.capMicros, approved, reason, display };
    },
  });
}

function optionalAiStage(env: PipelineEnv, allowance: CostAllowance[] | null): EngineStage {
  return defineStage({
    name: 'optional_ai',
    version: 'optional_ai@1',
    description: 'Run the approved optional work only: embeddings for pending memory chunks (paid, budgeted). Skipped with a stated reason when the cost plan was not approved.',
    input: z.object({ approved: z.boolean(), embed: z.boolean(), summary: z.boolean() }),
    output: z.object({ ran: z.boolean(), embedded: z.number(), costMicros: z.number().nullable(), llmSummaryApproved: z.boolean(), detail: z.string(), note: noteSchema }),
    prerequisites: ['cost_plan'],
    evidence: { requirement: 'An approved cost plan (explicit owner flag with a cap covering the displayed upper bound).' },
    timeoutMs: 30 * 60_000,
    retry: NO_RETRY,
    costAllowance: allowance && allowance.length ? allowance : 'none',
    optional: true,
    providers: ['llm_gateway'],
    stoppingConditions: ['Not approved: nothing runs. Budget or unknown price: the embedding batch stops and is reported.'],
    next: ['report'],
    buildInput: (sctx) => {
      const plan = sctx.prior.cost_plan as CostPlanOutput;
      return {
        approved: plan.approved,
        embed: plan.lines.some((l) => l.status === 'proposed' && l.label.startsWith('Embed')),
        summary: plan.lines.some((l) => l.status === 'proposed' && l.label.startsWith('Model-generated')),
      };
    },
    run: async (input, sctx) => {
      const plan = sctx.prior.cost_plan as CostPlanOutput;
      if (!input.approved || !allowance?.length) {
        return { ran: false, embedded: 0, costMicros: null, llmSummaryApproved: false, detail: plan.reason, note: plan.lines.some((l) => l.status === 'proposed') ? note('skipped', `Optional LLM/embedding work not run: ${plan.reason}`, 'COST_PLAN_NOT_APPROVED', 'Review the proposed cost plan, then re-run with --approve-cost-plan <usd>.') : null };
      }
      let embedded = 0;
      let cost: number | null = 0;
      const details: string[] = [];
      if (input.embed) {
        const r = await env.services(sctx.app).memoryWithEmbeddings().sync({ allowPaid: true, skipIngest: true, signal: sctx.signal });
        embedded = r.index.embedded;
        cost = r.index.costMicros;
        details.push(`embeddings: ${r.index.status}, ${r.index.embedded} embedded, ${r.index.cacheHits} cache hit(s)${r.index.degraded ? ` (degraded: ${r.index.degradedReason})` : ''}`);
      }
      return {
        ran: true,
        embedded,
        costMicros: cost,
        llmSummaryApproved: input.summary,
        detail: details.join('; ') || 'model summary approved for the report stage',
        note: cost === null ? note('degraded', 'Embedding charges are not reported yet (cost unknown, reservation kept).', 'COST_UNKNOWN', 'Check `npm run cli -- costs`.') : null,
      };
    },
  });
}

/** Moved to common.ts (shared by baseline, weekly, monthly, and the content queue); re-exported for compatibility. */
export { indexMemoryStage } from './common.js';

export interface BaselineStageOptions {
  /** Explicit cost-plan approval cap (USD micros); from job params. */
  approveCostPlanMicros?: number;
}

export function createBaselineStages(env: PipelineEnv, app: AppContext, opts: BaselineStageOptions = {}): EngineStage[] {
  const allowance = approvedAllowance(app, opts.approveCostPlanMicros);
  const [reconcile] = createSeoStages({});
  const cfg = app.config.google;
  return [
    acquireLockStage('check_access'),
    checkAccessStage(env, 'sync_gsc', ['acquire_lock']),
    syncGscStage(env, { next: 'plan_period', prerequisites: ['check_access'], days: (a) => a.config.google.gsc.initialHistoryDays ?? cfg.gsc.initialHistoryDays }),
    planPeriodStage('baseline', 'sync_ga4', ['check_access'], ['sync_gsc']),
    syncGa4Stage(env, { next: 'crawl_site', prerequisites: ['plan_period'], days: (a) => a.config.google.ga4.initialHistoryDays ?? cfg.ga4.initialHistoryDays }),
    crawlSiteStage(env, 'performance', ['check_access']),
    performanceStage(env, 'reconcile_urls', ['check_access']),
    withNext(reconcile as unknown as EngineStage, ['inspect_urls']),
    inspectUrlsStage(env, 'check_measurement', ['reconcile_urls']),
    measurementStage('check_measurement', 'index_memory', ['plan_period', 'reconcile_urls']),
    indexMemoryStage(env, 'cost_plan', ['check_measurement'], { paidEmbeddingHint: 'semantic vectors need the approved cost plan (`baseline --approve-cost-plan <usd>`)' }),
    costPlanStage(env),
    optionalAiStage(env, allowance),
    reportStage(env, { kind: 'baseline', earlierStages: BASELINE_STAGE_ORDER.filter((s) => s !== 'report'), prerequisites: ['check_access', 'plan_period'], next: 'done', llmAllowance: allowance }),
  ];
}
