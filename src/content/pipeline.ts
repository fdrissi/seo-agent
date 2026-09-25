import type { AppContext } from '../app/context.js';
import { withTimeout } from '../core/concurrency.js';
import { AppError, errorMessage, isAppError } from '../core/errors.js';
import type { GeneratedNote } from '../obsidian/types.js';
import type { StageContext, StageDefinition, StageOutcome, StopDecision } from '../workflows/types.js';
import type { ContentDeps } from './deps.js';
import { contentItemNote, pipelineNote } from './notes.js';
import { productionCapacity } from './prioritize.js';
import { CONTENT_WORKFLOW, contentStageAllowances, createContentResearchStages, type ContentStageOptions } from './stages.js';
import { listItems, listSignals } from './store.js';

/**
 * Minimal in-process SEQUENTIAL runner for library use and tests. It honours
 * the StageDefinition contract (prerequisites, validated input/output,
 * evidence checks, timeouts, stopping conditions) but has NO checkpoints or
 * resume (`resumedFromCheckpoint` is always false) and does NOT enforce stage
 * cost allowances (only the LLM gateway's per-run/site budgets apply). The
 * CLI runs content workflows as durable jobs instead (src/content/jobs.ts:
 * checkpoints, `jobs resume`, per-stage allowances). Content state itself is
 * persisted in SQLite by each stage, so re-running is idempotent.
 */
export async function runStagesSequentially(
  app: AppContext,
  stages: StageDefinition[],
  params: Record<string, unknown>,
  jobId = `adhoc-${app.runId}`,
): Promise<{ outcomes: StageOutcome[]; outputs: Record<string, unknown>; stop: (StopDecision & { stage: string }) | null; failed: StageOutcome | null }> {
  const prior: Record<string, unknown> = {};
  const outcomes: StageOutcome[] = [];
  const controller = new AbortController();
  for (const stage of stages) {
    const started = Date.now();
    const sctx: StageContext = { app, jobId, workflow: CONTENT_WORKFLOW, prior, signal: controller.signal, attempt: 1 };
    const missing = stage.prerequisites.filter((p) => !(p in prior));
    if (missing.length) {
      const o: StageOutcome = { stage: stage.name, status: 'failed', resumedFromCheckpoint: false, error: { code: 'VALIDATION_FAILED', message: `Missing prerequisite output(s): ${missing.join(', ')}` }, durationMs: 0 };
      outcomes.push(o);
      return { outcomes, outputs: prior, stop: null, failed: o };
    }
    try {
      const input = stage.input.parse(await stage.buildInput(sctx, params));
      const problems = stage.evidence.check?.(input, sctx) ?? [];
      if (problems.length) {
        const stop: StopDecision = { stop: true, status: 'blocked', reason: `Evidence requirement not met: ${problems.join('; ')}` };
        outcomes.push({ stage: stage.name, status: 'stopped', resumedFromCheckpoint: false, stop, durationMs: Date.now() - started });
        return { outcomes, outputs: prior, stop: { ...stop, stage: stage.name }, failed: null };
      }
      const output = stage.output.parse(await withTimeout(stage.run(input, sctx), stage.timeoutMs, `stage ${stage.name}`));
      prior[stage.name] = output;
      const stop = stage.shouldStop?.(output, sctx) ?? { stop: false };
      outcomes.push({ stage: stage.name, status: stop.stop ? 'stopped' : 'succeeded', resumedFromCheckpoint: false, output, ...(stop.stop ? { stop } : {}), durationMs: Date.now() - started });
      if (stop.stop) return { outcomes, outputs: prior, stop: { ...stop, stage: stage.name }, failed: null };
    } catch (err) {
      const o: StageOutcome = { stage: stage.name, status: 'failed', resumedFromCheckpoint: false, error: { code: isAppError(err) ? err.code : 'INTERNAL', message: errorMessage(err) }, durationMs: Date.now() - started };
      outcomes.push(o);
      return { outcomes, outputs: prior, stop: null, failed: o };
    }
  }
  return { outcomes, outputs: prior, stop: null, failed: null };
}

export interface ResearchRunResult {
  workflow: string;
  status: 'completed' | 'stopped' | 'failed';
  stop: (StopDecision & { stage: string }) | null;
  outcomes: StageOutcome[];
  outputs: Record<string, unknown>;
  notes: GeneratedNote[];
}

/** DISCOVER -> DEDUPLICATE -> CLASSIFY -> CLUSTER -> VALIDATE DEMAND -> CHECK EXISTING -> PRIORITIZE. */
export async function runContentResearch(ctx: AppContext, deps: ContentDeps, params: Record<string, unknown> = {}, opts: Partial<ContentStageOptions> = {}): Promise<ResearchRunResult> {
  if (ctx.dryRun) throw new AppError('POLICY_DENIED', 'The research pipeline writes local state; use previewDiscovery for --dry-run.');
  const stages = createContentResearchStages(deps, { ...opts, allowances: opts.allowances ?? contentStageAllowances(ctx.settings) });
  const r = await runStagesSequentially(ctx, stages, params);
  const items = listItems(ctx.db, ctx.siteId);
  const notes: GeneratedNote[] = [
    pipelineNote(ctx.siteId, items, productionCapacity(ctx), ctx.clock.now().toISOString()),
    ...items.map((i) => contentItemNote(i, listSignals(ctx.db, ctx.siteId, { itemId: i.id }))),
  ];
  return { workflow: CONTENT_WORKFLOW, status: r.failed ? 'failed' : r.stop ? 'stopped' : 'completed', stop: r.stop, outcomes: r.outcomes, outputs: r.outputs, notes };
}
