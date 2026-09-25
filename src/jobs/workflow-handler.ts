import type { z } from 'zod';
import { runSequential, summarizeWorkflow } from '../workflows/engine.js';
import type { EngineResult, EngineStage } from '../workflows/stage.js';
import { jobFailed, jobSucceeded, jobWaiting, type JobHandler, type JobHandlerContext, type JobOutcome } from './types.js';

/**
 * Adapter that runs a SEQUENTIAL workflow as a durable job. Checkpoints are
 * keyed by job id, so `jobs resume <id>` continues from the last successful
 * stage. The job-level retry decision comes from the engine: a failed stage
 * is retried at job level only when it is idempotent, spends no money, and
 * failed transiently.
 *
 * Workflow status -> job status:
 *   succeeded                         -> succeeded (degraded and skipped required stages listed in the
 *                                                  result, plus `degradedStages`: those and the stages
 *                                                  whose own output note says skipped/degraded/offline;
 *                                                  CLI output says "succeeded (degraded: ...)")
 *   stopped: completed_early/no_action -> succeeded (a legitimate "no change" outcome)
 *   stopped: needs_review             -> waiting   (human review needed. After the review, continue with
 *                                                  `jobs resume <id> --reviewed <stage>`, which records an
 *                                                  audited review of that exact checkpoint; a plain resume
 *                                                  stops at the same review again)
 *   stopped: blocked                  -> failed    (not retried; e.g. budget exhausted, evidence missing,
 *                                                  a required stage whose prerequisite failed, or a paid
 *                                                  stage interrupted mid-flight awaiting reconciliation)
 *   failed                            -> failed or retry (per engine retryability; never before an open
 *                                                  circuit breaker's next probe)
 *   cancelled                         -> cancelled (via the runner's abort signal)
 *
 * Stages that ignore their abort signal past the grace period are handed to
 * the runner (`keepLockUntilSettled`), which keeps the site lock until they
 * settle so no other job of the site overlaps them.
 */

export interface WorkflowJobHandlerSpec<P extends Record<string, unknown>> {
  type: string;
  description: string;
  workflow: string;
  stages: readonly EngineStage[] | ((params: P, ctx: JobHandlerContext) => readonly EngineStage[]);
  paramsSchema?: z.ZodType<P>;
  lockName?: string;
  maxAttempts?: number;
  /** How long an aborted stage may take to stop before it is treated as orphaned (default: engine default). */
  abortGraceMs?: number;
}

/** An honest note a stage carried in its OUTPUT (status skipped/degraded), although the engine recorded it as run. */
export interface StageOutputNote {
  status: string;
  code: string | null;
  detail: string;
}

/**
 * One stage that did not do all of its work: skipped or failed according to
 * the engine (`source: 'engine'`), or recorded as succeeded by the engine
 * while its own output note says skipped/degraded/offline (`source:
 * 'output'`). Persisted on workflow job results as `degradedStages`, so
 * `jobs list`, `jobs show`, `--json`, and the text headline all count the
 * same stages.
 */
export interface DegradedStageSummary {
  stage: string;
  /**
   * Display status: skipped | failed | degraded (engine; degraded = the stage ran without its optional
   * paid work), or skipped | degraded | offline (output note).
   */
  status: string;
  code: string;
  reason: string;
  source: 'engine' | 'output';
}

const MAX_REASON = 500;

/**
 * Honest notes carried in stage OUTPUTS: a stage the engine records as
 * "succeeded" may still say it was skipped or degraded (for example the
 * own-site crawl offline, research with every competitor page blocked, a
 * disabled integration). Sources: the report's stage notes (all stages before
 * the report), then the `note` of each stage output.
 */
export function stageOutputNotes(outputs: Record<string, unknown>): Map<string, StageOutputNote> {
  const notes = new Map<string, StageOutputNote>();
  const report = outputs.report as { stageNotes?: unknown } | null | undefined;
  if (report && typeof report === 'object' && Array.isArray(report.stageNotes)) {
    for (const raw of report.stageNotes as Array<{ stage?: unknown; status?: unknown; code?: unknown; detail?: unknown } | null>) {
      if (!raw || typeof raw.stage !== 'string' || (raw.status !== 'skipped' && raw.status !== 'degraded')) continue;
      if (!notes.has(raw.stage)) notes.set(raw.stage, { status: raw.status, code: typeof raw.code === 'string' ? raw.code : null, detail: typeof raw.detail === 'string' ? raw.detail : '' });
    }
  }
  for (const [stage, out] of Object.entries(outputs)) {
    const n = (out as { note?: { status?: unknown; code?: unknown; detail?: unknown } | null } | null)?.note;
    if (n && typeof n === 'object' && (n.status === 'skipped' || n.status === 'degraded') && !notes.has(stage)) {
      notes.set(stage, { status: n.status, code: typeof n.code === 'string' ? n.code : null, detail: typeof n.detail === 'string' ? n.detail : '' });
      continue;
    }
    const m = notes.has(stage) ? null : requestedModelSkippedNote(stage, out);
    if (m) notes.set(stage, m);
  }
  return notes;
}

/**
 * Content-research model use that was REQUESTED but did not happen: the
 * classify stage's `modelStatus` or the cluster stage's `semanticStatus`
 * starts with "skipped:" (src/content/stages.ts). "skipped: model disabled
 * for this run" means the model was not requested (no --use-model) and is not
 * counted; cluster reports "not requested" then. A dry run is a skip, not a
 * degradation; everything else (budget exhausted or a $0 share, provider
 * unavailable, model not configured) degrades the stage.
 */
export function requestedModelSkippedNote(stage: string, out: unknown): StageOutputNote | null {
  if (!out || typeof out !== 'object') return null;
  const field = stage === 'classify' ? 'modelStatus' : stage === 'cluster' ? 'semanticStatus' : null;
  if (!field) return null;
  const status = (out as Record<string, unknown>)[field];
  if (typeof status !== 'string' || !status.startsWith('skipped:') || status === 'skipped: model disabled for this run') return null;
  const what = stage === 'classify' ? 'the requested cheap model was not used for ambiguous intents (rules only)' : 'the requested semantic (embedding) clustering was not used (lexical clustering only)';
  const text = status.slice('skipped:'.length).trim();
  const explicit = /^([A-Z][A-Z0-9_]+):/.exec(text)?.[1] ?? null;
  const code = explicit ?? (/dry run/i.test(text) ? 'DRY_RUN' : /budget exhausted/i.test(text) ? 'BUDGET_EXCEEDED' : /provider unavailable/i.test(text) ? 'INTEGRATION_UNAVAILABLE' : 'MODEL_SKIPPED');
  return { status: code === 'DRY_RUN' ? 'skipped' : 'degraded', code, detail: `${stage}: ${what}: ${text}` };
}

/** Display status of a stage: the engine status, unless the stage "succeeded" but its own output note says skipped/degraded/offline. */
export function noteDisplayStatus(engineStatus: string, note: StageOutputNote | undefined): string {
  if (engineStatus !== 'succeeded' || !note) return engineStatus;
  if (note.code && /OFFLINE/.test(note.code)) return 'offline';
  return note.status;
}

/** How a stage is displayed in a stage table (the pipeline commands and the demo print the same rows). */
export interface StageDisplayRow {
  stage: string;
  /** The engine's status of the stage. */
  status: string;
  /**
   * Display status: the engine status, unless the engine recorded the stage as
   * "succeeded" while it did not do all of its work (its own output note, or
   * the combined degraded list) -- then skipped, degraded, or offline.
   */
  shown: string;
  /** Code behind a display status that differs from the engine status (null otherwise, or when the note has no code). */
  code: string | null;
  /** "CODE: first line of the detail" (detail at most 160 characters) when `shown` differs from the engine status; '' otherwise. */
  reason: string;
}

/**
 * One display row per stage, in stage order: the single implementation of
 * the stage table used by `baseline`/`weekly`/`monthly`/`content queue`
 * (src/cli/commands/pipelines.ts) and the demo (src/demo/run.ts), so a stage
 * the headline counts as degraded is never shown as a bare "succeeded".
 *
 * A stage the engine recorded as "succeeded" is overlaid, in order of
 * precedence, with: its own output note (`outputNotes`); an output-sourced
 * entry of the combined degraded list (stages whose outputs were not among
 * the summarized ones); an engine-sourced entry (the stage ran without its
 * optional paid work, e.g. an LLM budget exhausted at run time), shown
 * "degraded". Stages the engine recorded as skipped or failed keep their
 * engine status.
 */
export function stageDisplayRows(
  stages: ReadonlyArray<{ stage: string; status: string }>,
  combinedDegraded: ReadonlyArray<DegradedStageSummary>,
  outputNotes: ReadonlyMap<string, StageOutputNote> = new Map(),
): StageDisplayRow[] {
  const recorded = new Map<string, DegradedStageSummary>();
  const engine = new Map<string, DegradedStageSummary>();
  for (const d of combinedDegraded) {
    const into = d.source === 'engine' ? engine : recorded;
    if (!into.has(d.stage)) into.set(d.stage, d);
  }
  return stages.map((s) => {
    let note: StageOutputNote | undefined;
    if (s.status === 'succeeded') {
      const rec = recorded.get(s.stage);
      const eng = engine.get(s.stage);
      note =
        outputNotes.get(s.stage) ??
        (rec ? { status: rec.status === 'offline' ? 'skipped' : rec.status, code: rec.code, detail: rec.reason } : eng ? { status: 'degraded', code: eng.code, detail: eng.reason } : undefined);
    }
    const shown = noteDisplayStatus(s.status, note);
    const differs = shown !== s.status && note !== undefined;
    return {
      stage: s.stage,
      status: s.status,
      shown,
      code: differs ? (note!.code ?? null) : null,
      reason: differs ? `${note!.code ? `${note!.code}: ` : ''}${note!.detail.split('\n')[0]!.slice(0, 160)}` : '',
    };
  });
}

/**
 * The combined list of stages that did not do all of their work: the
 * engine's degraded list, then stages the engine recorded as succeeded whose
 * output note says skipped/degraded/offline. `extra` lists (e.g. persisted
 * earlier) are merged first; each stage appears once.
 */
export function combineDegradedStages(
  stages: ReadonlyArray<{ stage: string; status: string }>,
  engineDegraded: ReadonlyArray<{ stage: string; code: string; reason: string }>,
  notes: ReadonlyMap<string, StageOutputNote>,
  extra: ReadonlyArray<DegradedStageSummary> = [],
): DegradedStageSummary[] {
  const out: DegradedStageSummary[] = [];
  const seen = new Set<string>();
  const add = (d: DegradedStageSummary) => {
    if (seen.has(d.stage)) return;
    seen.add(d.stage);
    out.push({ ...d, reason: d.reason.length > MAX_REASON ? `${d.reason.slice(0, MAX_REASON)}...` : d.reason });
  };
  for (const d of extra) add(d);
  const statusOf = new Map(stages.map((s) => [s.stage, s.status]));
  // A stage the engine ran without its optional paid work (e.g. an LLM budget exhausted at run time) is "degraded", never "succeeded".
  for (const d of engineDegraded) {
    const st = statusOf.get(d.stage);
    add({ stage: d.stage, status: st === 'succeeded' ? 'degraded' : (st ?? 'skipped'), code: d.code, reason: d.reason, source: 'engine' });
  }
  const engineSet = new Set(engineDegraded.map((d) => d.stage));
  for (const s of stages) {
    if (s.status !== 'succeeded' || engineSet.has(s.stage)) continue;
    const n = notes.get(s.stage);
    if (!n) continue;
    add({ stage: s.stage, status: noteDisplayStatus('succeeded', n), code: n.code ?? n.status, reason: n.detail, source: 'output' });
  }
  return out;
}

/**
 * "degraded: N stage(s) ..." for a combined list, or null when it is empty.
 * Wording: "skipped or failed" when only the engine degraded stages, "skipped,
 * degraded, or failed" when a stage's own output note is counted.
 */
export function degradedStagesNote(list: ReadonlyArray<{ stage: string; code: string; source?: string }>): string | null {
  if (!list.length) return null;
  const withNotes = list.some((d) => d.source === 'output');
  const shown = list.slice(0, 6).map((d) => `${d.stage} (${d.code})`).join(', ');
  return `degraded: ${list.length} stage(s) ${withNotes ? 'skipped, degraded, or failed' : 'skipped or failed'}: ${shown}${list.length > 6 ? ', ...' : ''}`;
}

function isDegradedSummaryList(v: unknown): v is DegradedStageSummary[] {
  return Array.isArray(v) && v.every((d) => d && typeof d === 'object' && typeof (d as { stage?: unknown }).stage === 'string' && typeof (d as { code?: unknown }).code === 'string');
}

/**
 * The combined degraded list of a stored workflow job result: the persisted
 * `degradedStages` when present, else (results stored by older versions) the
 * engine's `degraded` list only. Empty for non-workflow results.
 */
export function workflowDegradedStages(result: unknown): DegradedStageSummary[] {
  if (!result || typeof result !== 'object') return [];
  const r = result as { degraded?: unknown; degradedStages?: unknown; stages?: unknown };
  if (isDegradedSummaryList(r.degradedStages)) return r.degradedStages;
  if (!Array.isArray(r.degraded)) return [];
  const stages = Array.isArray(r.stages) ? (r.stages as Array<{ stage: string; status: string }>) : [];
  return combineDegradedStages(stages, r.degraded as Array<{ stage: string; code: string; reason: string }>, new Map());
}

/**
 * One-line honest summary of a workflow job result for CLI output, e.g.
 * "degraded: 2 stage(s) skipped or failed: draft (MODE_NOT_PERMITTED), ...".
 * Counts the combined list (engine-degraded stages plus stages whose own
 * output note says skipped/degraded/offline) when the result carries it.
 * Returns null for non-workflow results or a complete run.
 */
export function workflowResultNote(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { degraded?: unknown; stages?: unknown; orphaned?: unknown };
  if (!Array.isArray(r.degraded) || !Array.isArray(r.stages)) return null;
  const notes: string[] = [];
  const stages = r.stages as Array<{ status?: string }>;
  if (stages.length && !stages.some((s) => s.status === 'succeeded' || s.status === 'stopped')) notes.push('nothing ran: every stage was skipped or failed');
  const degraded = degradedStagesNote(workflowDegradedStages(result));
  if (degraded) notes.push(degraded);
  if (Array.isArray(r.orphaned) && r.orphaned.length) notes.push(`${r.orphaned.length} aborted stage(s) did not stop in time; the site lock was held until they settled`);
  return notes.length ? notes.join('; ') : null;
}

/** Output-free job summary of a workflow result, with the combined `degradedStages` list. */
export function workflowJobSummary(r: EngineResult): Record<string, unknown> {
  const summary = summarizeWorkflow(r);
  const stages = r.stages.map((s) => ({ stage: s.stage, status: s.status }));
  return { ...summary, degradedStages: combineDegradedStages(stages, r.degraded, stageOutputNotes(r.outputs ?? {})) };
}

export function workflowOutcome(r: EngineResult): JobOutcome {
  const summary = workflowJobSummary(r);
  switch (r.status) {
    case 'succeeded':
      return jobSucceeded(summary);
    case 'stopped': {
      const d = r.stoppedBy?.decision;
      const reason = d?.reason ?? 'workflow stopped';
      if (d?.status === 'needs_review') {
        return jobWaiting(`${reason} (after the review, continue with \`jobs resume ${r.jobId} --reviewed ${r.stoppedBy?.stage ?? '<stage>'}\`)`, summary);
      }
      if (d?.status === 'blocked') return jobFailed({ code: r.stoppedBy?.code ?? 'BLOCKED', message: `Blocked at stage ${r.stoppedBy?.stage}: ${reason}` }, false, summary);
      return jobSucceeded(summary);
    }
    case 'cancelled':
      return jobFailed({ code: 'CANCELLED', message: 'Workflow cancelled' }, false, summary);
    case 'failed':
    default: {
      const f = r.failure;
      return jobFailed(
        { code: f?.code ?? 'INTERNAL', message: f ? `Stage ${f.stage} failed: ${f.message}` : 'Workflow failed' },
        f?.retryable ?? false,
        summary,
        f?.retryAfter ? { retryAfter: f.retryAfter } : {},
      );
    }
  }
}

export function workflowJobHandler<P extends Record<string, unknown>>(spec: WorkflowJobHandlerSpec<P>): JobHandler<P> {
  const handler: JobHandler<P> = {
    type: spec.type,
    description: spec.description,
    idempotent: false,
    async run(ctx, params) {
      const stages = typeof spec.stages === 'function' ? spec.stages(params, ctx) : spec.stages;
      const result = await runSequential(ctx.app, spec.workflow, stages, params, {
        jobId: ctx.job.id,
        signal: ctx.signal,
        breakers: ctx.breakers,
        heartbeat: ctx.heartbeat,
        rerunAmbiguousPaidStages: ctx.overrides.rerunAmbiguousPaidStages,
        onOrphanedStage: (work, info) => ctx.keepLockUntilSettled(work, `stage ${info.stage} (attempt ${info.attempt})`),
        ...(spec.abortGraceMs !== undefined ? { abortGraceMs: spec.abortGraceMs } : {}),
      });
      return workflowOutcome(result);
    },
  };
  if (spec.paramsSchema) handler.paramsSchema = spec.paramsSchema;
  if (spec.lockName) handler.lockName = spec.lockName;
  if (spec.maxAttempts) handler.maxAttempts = spec.maxAttempts;
  return handler;
}
