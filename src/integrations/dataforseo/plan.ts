import type { AppContext } from '../../app/context.js';
import type { LimitCheck } from '../../budgets/types.js';
import type { DataForSeoMode } from './client.js';
import type { BudgetCaps, CostPlan, PlanItem } from './types.js';

function cap(c: LimitCheck | undefined): { limitMicros: number; committedMicros: number; remainingMicros: number } | null {
  if (!c) return null;
  return { limitMicros: c.limitMicros, committedMicros: c.committedMicros, remainingMicros: Math.max(0, c.limitMicros - c.committedMicros) };
}

/** Current caps for DataForSEO at this site (no writes). */
export function budgetCaps(ctx: AppContext, amountMicros = 0): { caps: BudgetCaps; checks: LimitCheck[] } {
  const checks = ctx.budgets.checkLimits({ siteId: ctx.siteId, provider: 'dataforseo', runId: ctx.runId, amountMicros });
  const by = (s: LimitCheck['scope']) => checks.find((c) => c.scope === s);
  const zero = { limitMicros: 0, committedMicros: 0, remainingMicros: 0 };
  return {
    caps: {
      perRun: cap(by('run')) ?? zero,
      weekly: cap(by('site_service_week')),
      monthly: cap(by('site_service_month')) ?? zero,
      combinedMonthly: cap(by('site_combined_month')) ?? zero,
    },
    checks,
  };
}

/** Build a cost plan: cache hits, reused tasks, submissions, total upper bound, caps, and a dry budget check. */
export function buildCostPlan(ctx: AppContext, input: { mode: DataForSeoMode | null; isSandbox: boolean; queue: 'standard' | 'live'; items: PlanItem[] }): CostPlan {
  const submits = input.items.filter((i) => i.action === 'submit');
  const unknownPrice = submits.some((i) => i.estimateMicros === null);
  const total = unknownPrice ? null : submits.reduce((s, i) => s + (i.estimateMicros ?? 0), 0);
  // Sandbox/fixture submissions reserve a verified $0 through the same budget path (tasks.ts), so they are
  // checked with a $0 request: only a limit that is already overspent refuses them.
  const { caps, checks } = budgetCaps(ctx, input.isSandbox ? 0 : (total ?? 0));
  const violated = submits.length === 0 ? null : (checks.find((c) => c.committedMicros + c.requestedMicros > c.limitMicros) ?? null);
  return {
    provider: 'dataforseo',
    mode: input.mode,
    isSandbox: input.isSandbox,
    queue: input.queue,
    items: input.items,
    cacheHits: input.items.filter((i) => i.action === 'cache_hit').length,
    openTasks: input.items.filter((i) => i.action === 'reuse_open_task').length,
    submissions: submits.length,
    totalEstimateMicros: total,
    unknownPrice,
    caps,
    budgetOk: !violated && !(unknownPrice && !input.isSandbox),
    violated,
  };
}
