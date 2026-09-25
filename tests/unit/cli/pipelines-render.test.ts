import { describe, expect, it } from 'vitest';
import { outputNotes, pipelineHeadline, recommendationSavedSuffix, renderPipelineRun, stageDisplayStatus } from '../../../src/cli/commands/pipelines.js';
import { combineDegradedStages, requestedModelSkippedNote, stageDisplayRows, stageOutputNotes, workflowResultNote } from '../../../src/jobs/workflow-handler.js';
import { HISTORICAL_PERIOD_PRIMARY_ID } from '../../../src/seo/stages.js';
import { spendSummaryText } from '../../../src/workflows/pipelines/common.js';
import type { PipelineRunResult } from '../../../src/workflows/pipelines/handlers.js';

// A8-05 (spec 31, honest statuses): a stage the engine records as "succeeded" but whose own
// output note says skipped/degraded/offline is shown that way, and counted in the headline.
// SYNTHETIC run results only.

function run(over: Partial<PipelineRunResult> = {}): PipelineRunResult {
  return {
    jobId: 'job_synthetic_1',
    type: 'weekly',
    outcome: 'succeeded',
    jobStatus: 'succeeded',
    dryRun: false,
    scratchDatabase: false,
    mode: 'RESEARCH',
    workflow: {
      status: 'succeeded',
      stages: [
        { stage: 'sync_gsc', status: 'succeeded', resumedFromCheckpoint: false },
        { stage: 'crawl_site', status: 'succeeded', resumedFromCheckpoint: false },
        { stage: 'research', status: 'succeeded', resumedFromCheckpoint: false },
        { stage: 'report', status: 'succeeded', resumedFromCheckpoint: false },
      ],
      degraded: [],
      stoppedBy: null,
      failure: null,
      warnings: [],
    },
    degradedStages: [],
    note: null,
    error: null,
    outputs: {},
    ...over,
  };
}

const report = (stageNotes: Array<{ stage: string; status: string; code: string | null; detail: string; nextStep: string | null }>) => ({
  reportId: 'rep_synthetic',
  kind: 'weekly',
  period: { start: '2026-09-14', end: '2026-09-20' },
  isSynthetic: true,
  confidence: 'low',
  warnings: 0,
  accessIssues: 0,
  markdownFile: null,
  vaultNote: null,
  dashboard: null,
  vault: { status: 'skipped', created: 0, updated: 0, conflicts: 0 },
  persisted: true,
  primaryAction: null,
  nextAction: null,
  stageNotes,
});

describe('pipeline summary honesty', () => {
  it('keeps a complete run as a bare "succeeded"', () => {
    const r = run();
    expect(pipelineHeadline(r)).toBe('succeeded');
    expect(renderPipelineRun(r)).toMatch(/crawl_site\s+succeeded/);
  });

  it('shows note-skipped/degraded/offline stages in the table and in the headline degraded list', () => {
    const r = run({
      outputs: {
        report: report([
          { stage: 'crawl_site', status: 'skipped', code: 'CRAWL_OFFLINE', detail: 'Own-site crawl offline: network disabled', nextStep: null },
          { stage: 'research', status: 'degraded', code: 'RESEARCH_PARTIAL', detail: 'Research: 15 of 15 competitor pages were not fetched', nextStep: null },
        ]),
        reconcile_costs: { note: { status: 'degraded', code: 'COST_UNKNOWN', detail: 'one charge unknown', nextStep: null } },
      },
    });
    const out = renderPipelineRun(r);
    const headline = out.split('\n')[0]!;
    expect(headline).toBe('Weekly pipeline, job job_synthetic_1 (mode RESEARCH): succeeded (degraded: 2 stage(s) skipped, degraded, or failed: crawl_site (CRAWL_OFFLINE), research (RESEARCH_PARTIAL))');
    expect(out).toMatch(/crawl_site\s+offline\s+CRAWL_OFFLINE: Own-site crawl offline/);
    expect(out).toMatch(/research\s+degraded\s+RESEARCH_PARTIAL: Research: 15 of 15/);
    expect(out).toMatch(/sync_gsc\s+succeeded/);
    // reconcile_costs did not run in this synthetic result, so its note does not add a stage.
    expect(headline).not.toContain('reconcile_costs');
  });

  it('merges engine-degraded stages with note-degraded ones, keeping other notes', () => {
    const r = run({
      workflow: {
        ...run().workflow,
        stages: [...run().workflow.stages, { stage: 'draft', status: 'skipped', resumedFromCheckpoint: false }],
        degraded: [{ stage: 'draft', code: 'MODE_NOT_PERMITTED', reason: 'needs DRAFT' }],
      },
      note: 'degraded: 1 stage(s) skipped or failed: draft (MODE_NOT_PERMITTED); 1 aborted stage(s) did not stop in time; the site lock was held until they settled',
      outputs: { crawl_site: { note: { status: 'degraded', code: 'CRAWL_PARTIAL', detail: 'partial', nextStep: null } } },
    });
    expect(pipelineHeadline(r)).toBe(
      'succeeded (degraded: 2 stage(s) skipped, degraded, or failed: draft (MODE_NOT_PERMITTED), crawl_site (CRAWL_PARTIAL); 1 aborted stage(s) did not stop in time; the site lock was held until they settled)',
    );
    // Engine statuses other than "succeeded" are never overridden.
    expect(renderPipelineRun(r)).toMatch(/draft\s+skipped/);
  });

  it('only engine-degraded stages: the wording is unchanged', () => {
    const r = run({ workflow: { ...run().workflow, degraded: [{ stage: 'draft', code: 'MODE_NOT_PERMITTED', reason: 'x' }] }, note: 'degraded: 1 stage(s) skipped or failed: draft (MODE_NOT_PERMITTED)' });
    expect(pipelineHeadline(r)).toBe('succeeded (degraded: 1 stage(s) skipped or failed: draft (MODE_NOT_PERMITTED))');
  });

  it('does not change non-success outcomes', () => {
    expect(pipelineHeadline(run({ outcome: 'failed' }))).toBe('failed');
    expect(stageDisplayStatus('failed', { status: 'skipped', code: 'OFFLINE', detail: '' })).toBe('failed');
    expect(stageDisplayStatus('succeeded', { status: 'skipped', code: 'INTEGRATION_DISABLED', detail: '' })).toBe('skipped');
    expect(stageDisplayStatus('succeeded', undefined)).toBe('succeeded');
    expect(outputNotes(run()).size).toBe(0);
  });
});

// B2-07: the job record persists the combined list (engine-degraded stages plus stages whose own
// output note says skipped/degraded/offline). The headline and the stage table count that list,
// even for stages whose outputs are not among the summarized outputs.
describe('persisted degradedStages', () => {
  const stored = {
    status: 'succeeded',
    stages: [
      { stage: 'sync_gsc', status: 'succeeded', resumedFromCheckpoint: false },
      { stage: 'crawl_site', status: 'succeeded', resumedFromCheckpoint: false },
      { stage: 'research', status: 'skipped', resumedFromCheckpoint: false },
      { stage: 'report', status: 'succeeded', resumedFromCheckpoint: false },
    ],
    degraded: [{ stage: 'research', code: 'MODE_NOT_PERMITTED', reason: 'requires RESEARCH mode' }],
    degradedStages: [
      { stage: 'research', status: 'skipped', code: 'MODE_NOT_PERMITTED', reason: 'requires RESEARCH mode', source: 'engine' as const },
      { stage: 'sync_gsc', status: 'offline', code: 'OFFLINE', reason: 'Network access is disabled (synthetic)', source: 'output' as const },
    ],
  };

  it('the headline equals the stored job note (what `jobs list` / `jobs show` print), and the table shows the recorded stage', () => {
    const note = workflowResultNote(stored);
    expect(note).toBe('degraded: 2 stage(s) skipped, degraded, or failed: research (MODE_NOT_PERMITTED), sync_gsc (OFFLINE)');
    // sync_gsc's output is not among the summarized outputs: the persisted list still counts it.
    const r = run({ workflow: { ...run().workflow, stages: stored.stages, degraded: stored.degraded }, degradedStages: stored.degradedStages, note });
    expect(pipelineHeadline(r)).toBe(`succeeded (${note})`);
    const out = renderPipelineRun(r);
    expect(out).toMatch(/sync_gsc\s+offline\s+OFFLINE: Network access is disabled/);
    expect(out).toMatch(/research\s+skipped/);
    expect(out).toMatch(/crawl_site\s+succeeded/);
  });

  it('results stored by older versions (no degradedStages) fall back to the engine list', () => {
    const { degradedStages: _omitted, ...legacy } = stored;
    expect(workflowResultNote(legacy)).toBe('degraded: 1 stage(s) skipped or failed: research (MODE_NOT_PERMITTED)');
  });
});

// B5-01: the dry-run note follows the EFFECTIVE dry run, never merely the use of a scratch database.
describe('dry-run note', () => {
  const NOTHING_WRITTEN = /nothing was written to the workspace/;
  it('a dry run against a scratch copy says nothing was written', () => {
    expect(renderPipelineRun(run({ dryRun: true, scratchDatabase: true }))).toMatch(NOTHING_WRITTEN);
  });
  it('a scratch copy that was NOT a dry run never claims nothing was written', () => {
    const out = renderPipelineRun(run({ dryRun: false, scratchDatabase: true }));
    expect(out).not.toMatch(NOTHING_WRITTEN);
    expect(out).toMatch(/WARNING: .*NOT a dry run/);
    expect(out.split('\n')[0]).not.toMatch(/DRY RUN/);
  });
  it('a normal run prints no dry-run note', () => {
    expect(renderPipelineRun(run())).not.toMatch(/Dry run|NOT a dry run/);
  });
});


// C5-03: spend in the run summary keeps provider-reported and computed-from-usage amounts apart, and tags
// synthetic amounts; the vault system log uses the same wording (spendSummaryText). SYNTHETIC amounts only.
describe('spend summary line', () => {
  const entry = (over: Record<string, unknown> = {}) => ({ provider: 'dataforseo', actualMicros: 4_500, reservedMicros: 0, estimatedMicros: 1_000, unknownCount: 0, reportedMicros: 0, computedMicros: 4_500, computedCount: 3, syntheticMicros: 0, syntheticCount: 0, ...over });
  const withSpend = (reconcile: Record<string, unknown>) => renderPipelineRun(run({ outputs: { reconcile_costs: { unresolvedReservations: [], ...reconcile } } }));

  it('prints "$R provider-reported, $C computed from usage", reserved and estimated-only, never "actual"', () => {
    const out = withSpend({ spend: [entry(), entry({ provider: 'llm_gateway', actualMicros: 150_210, reportedMicros: 150_000, computedMicros: 210, computedCount: 1, estimatedMicros: 0, unknownCount: 1 })], spendDemo: false });
    const line = out.split('\n').find((l) => l.startsWith('Spend this month'))!;
    expect(line).toBe('Spend this month: dataforseo $0.00 provider-reported, $0.0045 computed from usage, $0.00 reserved, $0.001 estimated-only; llm_gateway $0.15 provider-reported, $0.00021 computed from usage, $0.00 reserved, $0.00 estimated-only, 1 unknown');
    expect(line).not.toMatch(/actual/);
    expect(line).not.toContain('SYNTHETIC');
  });

  it('tags synthetic (fixture/sandbox) amounts per provider, and a demo site on the whole line', () => {
    const syn = withSpend({ spend: [entry({ syntheticMicros: 4_500, syntheticCount: 4 })], spendDemo: false }).split('\n').find((l) => l.startsWith('Spend this month'))!;
    expect(syn).toBe('Spend this month: dataforseo $0.00 provider-reported, $0.0045 computed from usage, $0.00 reserved, $0.001 estimated-only [SYNTHETIC: no real charges] ($0.0045 of it from 4 fixture/sandbox/demo reservation(s))');
    const demo = withSpend({ spend: [entry({ syntheticMicros: 4_500, syntheticCount: 4 })], spendDemo: true }).split('\n').find((l) => l.startsWith('Spend this month'))!;
    expect(demo).toBe('Spend this month [SYNTHETIC: no real charges]: dataforseo $0.00 provider-reported, $0.0045 computed from usage, $0.00 reserved, $0.001 estimated-only');
  });

  it('a checkpoint of an older version (no split recorded) never calls the total provider-reported', () => {
    const line = withSpend({ spend: [{ provider: 'apify', actualMicros: 20_000, reservedMicros: 0, estimatedMicros: 0, unknownCount: 0 }] }).split('\n').find((l) => l.startsWith('Spend this month'))!;
    expect(line).toBe('Spend this month: apify $0.02 reconciled (provider-reported/computed split not recorded), $0.00 reserved, $0.00 estimated-only');
    expect(spendSummaryText([{ provider: 'apify', actualMicros: 0, reservedMicros: 0, estimatedMicros: 0, unknownCount: 0 }], { demo: true })).toMatch(/^Spend this month \[SYNTHETIC: no real charges\]: /);
  });
});

// NF-12: the reason a recommendation was not saved is the real one.
describe('recommendation not-saved reason', () => {
  it('an explicit historical period is review only, not a dry run', () => {
    const out = renderPipelineRun(run({ outputs: { recommend: { primaryId: HISTORICAL_PERIOD_PRIMARY_ID, kind: 'primary', title: 'Improve the pricing page title (synthetic)', saved: false, note: { code: 'HISTORICAL_PERIOD', detail: 'Recommendation not saved (explicit historical report period).' } } } }));
    expect(out).toContain('Recommendation: primary: Improve the pricing page title (synthetic) (not saved: explicit historical period; review only)');
    expect(out).not.toContain('dry run');
  });

  it('only a dry run says dry run; a saved recommendation has no suffix', () => {
    const dry = renderPipelineRun(run({ dryRun: true, outputs: { recommend: { primaryId: 'dry-run', kind: 'no_action', title: 'No action (synthetic)', saved: false } } }));
    expect(dry).toContain('Recommendation: no_action: No action (synthetic) (not saved: dry run)');
    expect(recommendationSavedSuffix({ primaryId: 'rec_1', saved: true }, false)).toBe('');
    expect(recommendationSavedSuffix({ primaryId: HISTORICAL_PERIOD_PRIMARY_ID, saved: false }, true)).toBe(' (not saved: explicit historical period; review only)');
    expect(recommendationSavedSuffix({ primaryId: 'x', saved: false, note: { code: 'OTHER', detail: 'synthetic reason' } }, false)).toBe(' (not saved: synthetic reason)');
  });
});

// C1-11: requested model use that did not happen, and stages the engine ran without their paid work, are "degraded".
describe('degraded content-research stages', () => {
  const stages = [
    { stage: 'classify', status: 'succeeded', resumedFromCheckpoint: false },
    { stage: 'cluster', status: 'succeeded', resumedFromCheckpoint: false },
  ];

  it('an engine-degraded stage that "succeeded" is shown degraded in the table, as the headline counts it', () => {
    const r = run({ type: 'content.queue', workflow: { ...run().workflow, stages, degraded: [{ stage: 'classify', code: 'BUDGET_EXCEEDED', reason: 'llm_gateway budget exhausted (synthetic)' }] } });
    const out = renderPipelineRun(r);
    expect(out.split('\n')[0]).toContain('classify (BUDGET_EXCEEDED)');
    expect(out).toMatch(/classify\s+degraded\s+BUDGET_EXCEEDED: llm_gateway budget exhausted \(synthetic\)/);
    expect(out).toMatch(/cluster\s+succeeded/);
    expect(combineDegradedStages(stages, r.workflow.degraded, new Map())[0]).toMatchObject({ stage: 'classify', status: 'degraded', source: 'engine' });
  });

  it('classify modelStatus / cluster semanticStatus "skipped: ..." count as degraded only when the model was requested', () => {
    const outputs = {
      classify: { modelStatus: 'skipped: BUDGET_EXCEEDED: budgets.llmGateway.perRun leaves no allowance for the cheap-model intent classification (its share of the per-run LLM budget is $0)' },
      cluster: { semanticStatus: 'skipped: LLM budget exhausted (synthetic); rules only' },
    };
    const notes = stageOutputNotes(outputs);
    expect(notes.get('classify')).toMatchObject({ status: 'degraded', code: 'BUDGET_EXCEEDED' });
    expect(notes.get('cluster')).toMatchObject({ status: 'degraded', code: 'BUDGET_EXCEEDED' });
    const r = run({ type: 'content.queue', workflow: { ...run().workflow, stages }, outputs });
    expect(pipelineHeadline(r)).toBe('succeeded (degraded: 2 stage(s) skipped, degraded, or failed: classify (BUDGET_EXCEEDED), cluster (BUDGET_EXCEEDED))');
    expect(renderPipelineRun(r)).toMatch(/classify\s+degraded\s+BUDGET_EXCEEDED: classify: the requested cheap model was not used/);
    // Not requested (no --use-model / --semantic), or not needed: nothing is counted.
    expect(requestedModelSkippedNote('classify', { modelStatus: 'skipped: model disabled for this run' })).toBeNull();
    expect(requestedModelSkippedNote('classify', { modelStatus: 'not_needed' })).toBeNull();
    expect(requestedModelSkippedNote('cluster', { semanticStatus: 'not requested' })).toBeNull();
    expect(requestedModelSkippedNote('brief', { modelStatus: 'skipped: whatever' })).toBeNull();
    // A dry run is a skip, not a degradation; an engine-dropped provider is unavailable.
    expect(requestedModelSkippedNote('classify', { modelStatus: 'skipped: DRY_RUN: dry run: no paid call is made' })).toMatchObject({ status: 'skipped', code: 'DRY_RUN' });
    expect(requestedModelSkippedNote('classify', { modelStatus: 'skipped: LLM provider unavailable (breaker open); rules only' })).toMatchObject({ status: 'degraded', code: 'INTEGRATION_UNAVAILABLE' });
    expect(requestedModelSkippedNote('classify', { modelStatus: 'skipped: no LLM allowance for this stage in this run' })).toMatchObject({ status: 'degraded', code: 'MODEL_SKIPPED' });
  });
});

// R3-NF-P1: one stage table for the pipeline commands and the demo (stageDisplayRows). A stage the engine ran
// without its optional paid work (an engine-sourced degraded entry on a "succeeded" stage) is "degraded" in both,
// never a bare "succeeded" next to a headline that counts it. SYNTHETIC run results only.
describe('shared stage display rows (pipeline commands and demo)', () => {
  const stages = [
    { stage: 'sync_gsc', status: 'succeeded', resumedFromCheckpoint: false },
    { stage: 'performance', status: 'succeeded', resumedFromCheckpoint: true },
    { stage: 'optional_ai', status: 'succeeded', resumedFromCheckpoint: false },
    { stage: 'draft', status: 'skipped', resumedFromCheckpoint: false },
    { stage: 'report', status: 'succeeded', resumedFromCheckpoint: false },
  ];
  const engineDegraded = { stage: 'optional_ai', status: 'degraded', code: 'BUDGET_EXCEEDED', reason: 'llm_gateway budget exhausted at run time (synthetic)', source: 'engine' as const };
  const degradedStages = [
    engineDegraded,
    { stage: 'draft', status: 'skipped', code: 'MODE_NOT_PERMITTED', reason: 'needs DRAFT', source: 'engine' as const },
    // Recorded on the job; performance's output is not among the summarized outputs.
    { stage: 'performance', status: 'offline', code: 'OFFLINE', reason: '3 of 3 performance check(s) did not complete (offline; synthetic)', source: 'output' as const },
  ];
  const mixed = () =>
    run({
      type: 'baseline',
      workflow: { ...run().workflow, stages, degraded: [{ stage: 'optional_ai', code: 'BUDGET_EXCEEDED', reason: engineDegraded.reason }, { stage: 'draft', code: 'MODE_NOT_PERMITTED', reason: 'needs DRAFT' }] },
      degradedStages,
      outputs: { report: report([{ stage: 'sync_gsc', status: 'skipped', code: 'GSC_OFFLINE', detail: 'Search Console not contacted (offline; synthetic)', nextStep: null }]) },
    });

  it('an engine-degraded "succeeded" stage is "degraded" in renderPipelineRun and in the demo stage table', async () => {
    const { stageLine } = await import('../../../src/demo/run.js');
    // Only the engine-sourced entry: no output note, nothing recorded from outputs (the case the demo used to miss).
    const r = run({
      type: 'baseline',
      workflow: { ...run().workflow, stages: [{ stage: 'optional_ai', status: 'succeeded', resumedFromCheckpoint: false }], degraded: [] },
      degradedStages: [engineDegraded],
    });
    expect(stageDisplayRows(r.workflow.stages, r.degradedStages)).toEqual([
      { stage: 'optional_ai', status: 'succeeded', shown: 'degraded', code: 'BUDGET_EXCEEDED', reason: 'BUDGET_EXCEEDED: llm_gateway budget exhausted at run time (synthetic)' },
    ]);
    const cli = renderPipelineRun(r);
    expect(cli).toMatch(/^ {2}optional_ai\s+degraded\s+BUDGET_EXCEEDED: llm_gateway budget exhausted at run time \(synthetic\)$/m);
    expect(cli).not.toMatch(/optional_ai\s+succeeded/);
    const demo = stageLine(r);
    expect(demo).toEqual(['  optional_ai          degraded  BUDGET_EXCEEDED: llm_gateway budget exhausted at run time (synthetic)']);
  });

  it('both renderers show the same status and reason for every stage', async () => {
    const { stageLine } = await import('../../../src/demo/run.js');
    const r = mixed();
    const rows = stageDisplayRows(r.workflow.stages, r.degradedStages, stageOutputNotes(r.outputs));
    expect(rows.map((x) => [x.stage, x.shown, x.code])).toEqual([
      ['sync_gsc', 'offline', 'GSC_OFFLINE'],
      ['performance', 'offline', 'OFFLINE'],
      ['optional_ai', 'degraded', 'BUDGET_EXCEEDED'],
      // Engine statuses other than "succeeded" are never overridden (the reason is the engine's own).
      ['draft', 'skipped', null],
      ['report', 'succeeded', null],
    ]);
    const cliTable = renderPipelineRun(r).split('\n').filter((l) => /^ {2}\S/.test(l) && stages.some((s) => l.trim().startsWith(`${s.stage} `)));
    const demoTable = stageLine(r);
    expect(cliTable).toHaveLength(stages.length);
    // Same shown status and reason per row; only the column padding differs.
    const norm = (l: string) => l.replace(/\s+/g, ' ').trim();
    expect(cliTable.map(norm)).toEqual(demoTable.map(norm));
    expect(demoTable.map(norm)).toEqual([
      'sync_gsc offline GSC_OFFLINE: Search Console not contacted (offline; synthetic)',
      'performance offline (from checkpoint) OFFLINE: 3 of 3 performance check(s) did not complete (offline; synthetic)',
      'optional_ai degraded BUDGET_EXCEEDED: llm_gateway budget exhausted at run time (synthetic)',
      'draft skipped',
      'report succeeded',
    ]);
    // The headline counts the same stages the table marks.
    expect(pipelineHeadline(r)).toContain('optional_ai (BUDGET_EXCEEDED)');
  });
});
