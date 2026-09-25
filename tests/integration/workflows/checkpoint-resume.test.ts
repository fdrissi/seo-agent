import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../../src/core/errors.js';
import { enqueue } from '../../../src/jobs/store.js';
import { runSequential } from '../../../src/workflows/engine.js';
import { CheckpointStore } from '../../../src/workflows/checkpoints.js';
import type { EngineStage } from '../../../src/workflows/stage.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { chain, stage } from '../../unit/workflows/_stages.js';

/**
 * Resume from the last successful checkpoint: stages whose version and input
 * hash match are reused; everything else reruns.
 */
describe('workflow checkpoints and resume', () => {
  let ctx: TestContext;
  let jobId: string;
  let counts: Record<string, number>;
  let crashStage2: boolean;

  const build = (opts: { v1?: string; out1?: z.ZodType } = {}): EngineStage[] =>
    chain([
      stage('research', {
        version: opts.v1 ?? '1',
        input: z.object({ topic: z.string() }),
        ...(opts.out1 ? { output: opts.out1 } : {}),
        buildInput: (_c, params) => ({ topic: String(params.topic) }),
        run: async (i: { topic: string }) => {
          counts.research = (counts.research ?? 0) + 1;
          return { value: i.topic.length };
        },
      }),
      stage('analysis', {
        prerequisites: ['research'],
        input: z.object({ n: z.number() }),
        buildInput: (c) => ({ n: (c.prior.research as { value: number }).value }),
        run: async (i: { n: number }) => {
          counts.analysis = (counts.analysis ?? 0) + 1;
          if (crashStage2) throw new AppError('INTERNAL', 'simulated crash in stage 2');
          return { value: i.n * 2 };
        },
      }),
      stage('brief', {
        prerequisites: ['analysis'],
        run: async () => {
          counts.brief = (counts.brief ?? 0) + 1;
          return { value: 99 };
        },
      }),
    ]);

  beforeEach(() => {
    ctx = createTestContext();
    jobId = enqueue(ctx, 'test-workflow', { topic: 'boots' }).id;
    counts = {};
    crashStage2 = false;
  });
  afterEach(() => ctx.cleanup());

  it('after stage 2 fails, resuming the same job skips stage 1 and continues', async () => {
    crashStage2 = true;
    const first = await runSequential(ctx, 'wf', build(), { topic: 'boots' }, { jobId });
    expect(first.status).toBe('failed');
    expect(counts).toEqual({ research: 1, analysis: 1 });

    crashStage2 = false;
    const second = await runSequential(ctx, 'wf', build(), { topic: 'boots' }, { jobId });
    expect(second.status).toBe('succeeded');
    expect(counts).toEqual({ research: 1, analysis: 2, brief: 1 });
    expect(second.stages.map((s) => [s.stage, s.resumedFromCheckpoint])).toEqual([
      ['research', true],
      ['analysis', false],
      ['brief', false],
    ]);
    expect(second.outputs).toEqual({ research: { value: 5 }, analysis: { value: 10 }, brief: { value: 99 } });

    const history = new CheckpointStore(ctx.db, ctx.clock).list(ctx.siteId, jobId);
    expect(history.map((h) => [h.stage, h.status, h.attempt])).toEqual([
      ['research', 'succeeded', 1],
      ['analysis', 'failed', 1],
      ['analysis', 'succeeded', 2],
      ['brief', 'succeeded', 1],
    ]);
  });

  it('a completed workflow re-run reuses every checkpoint', async () => {
    await runSequential(ctx, 'wf', build(), { topic: 'boots' }, { jobId });
    const again = await runSequential(ctx, 'wf', build(), { topic: 'boots' }, { jobId });
    expect(again.stages.every((s) => s.resumedFromCheckpoint)).toBe(true);
    expect(counts).toEqual({ research: 1, analysis: 1, brief: 1 });
  });

  it('an input-hash change invalidates the checkpoint and cascades to dependents', async () => {
    await runSequential(ctx, 'wf', build(), { topic: 'boots' }, { jobId });
    const changed = await runSequential(ctx, 'wf', build(), { topic: 'winter boots' }, { jobId });
    expect(changed.stages.map((s) => s.resumedFromCheckpoint)).toEqual([false, false, false]);
    // research reran (new topic) -> analysis input changed -> reran; brief sees a changed prior output -> reran.
    expect(counts).toEqual({ research: 2, analysis: 2, brief: 2 });
    expect(changed.outputs.analysis).toEqual({ value: 24 });
  });

  it('a stage version bump invalidates its checkpoint', async () => {
    await runSequential(ctx, 'wf', build(), { topic: 'boots' }, { jobId });
    const bumped = await runSequential(ctx, 'wf', build({ v1: '2' }), { topic: 'boots' }, { jobId });
    expect(bumped.stages[0]!.resumedFromCheckpoint).toBe(false);
    expect(counts.research).toBe(2);
  });

  it('a stored output that no longer matches the output schema is rerun with a warning', async () => {
    await runSequential(ctx, 'wf', build(), { topic: 'boots' }, { jobId });
    const stricter = z.object({ value: z.number(), extra: z.string() });
    const withNewSchema = build({ out1: stricter });
    withNewSchema[0] = { ...withNewSchema[0]!, run: async () => ((counts.research = (counts.research ?? 0) + 1), { value: 5, extra: 'x' }) };
    const r = await runSequential(ctx, 'wf', withNewSchema, { topic: 'boots' }, { jobId });
    expect(r.stages[0]!.resumedFromCheckpoint).toBe(false);
    expect(r.warnings.join()).toMatch(/no longer matches the output schema/);
  });

  it('outputs that are not JSON round-trippable are flagged and not reused', async () => {
    const withDate = chain([
      stage('dated', {
        output: z.object({ at: z.date() }),
        run: async () => {
          counts.dated = (counts.dated ?? 0) + 1;
          return { at: new Date('2026-09-24T00:00:00Z') };
        },
      }),
    ]);
    const r1 = await runSequential(ctx, 'wf', withDate, {}, { jobId });
    expect(r1.warnings.join()).toMatch(/not JSON round-trippable/);
    const r2 = await runSequential(ctx, 'wf', withDate, {}, { jobId });
    expect(r2.stages[0]!.resumedFromCheckpoint).toBe(false);
    expect(counts.dated).toBe(2);
  });

  it('checkpoints are isolated per job and site', async () => {
    await runSequential(ctx, 'wf', build(), { topic: 'boots' }, { jobId });
    const other = enqueue(ctx, 'test-workflow', { topic: 'boots' }).id;
    const r = await runSequential(ctx, 'wf', build(), { topic: 'boots' }, { jobId: other });
    expect(r.stages.some((s) => s.resumedFromCheckpoint)).toBe(false);
    expect(new CheckpointStore(ctx.db, ctx.clock).list('another-site', jobId)).toEqual([]);
  });
});
