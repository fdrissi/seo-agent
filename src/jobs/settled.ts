import type { AppContext } from '../app/context.js';
import { errorMessage } from '../core/errors.js';
import type { RunJobResult } from './runner.js';

/**
 * One listener called by `JobRunner.runJob` after every run it returns
 * (manual runs, `jobs resume`, and scheduler ticks alike), once the job row
 * holds its final status for this run and the site lock is released. The
 * application installs it in src/app/wiring.ts (weekly action plans and
 * notifications); library callers and tests run without one.
 *
 * A listener's failure never changes the job's recorded outcome: it is
 * logged, and the run result is returned unchanged.
 */

export type JobSettledListener = (ctx: AppContext, result: RunJobResult) => Promise<unknown>;

let listener: JobSettledListener | null = null;

export function registerJobSettledListener(fn: JobSettledListener | null): void {
  listener = fn;
}

export async function notifyJobSettled(ctx: AppContext, result: RunJobResult): Promise<void> {
  if (!listener) return;
  try {
    await listener(ctx, result);
  } catch (err) {
    ctx.logger.warn(`Follow-up after job ${result.job.id} failed: ${errorMessage(err)}`);
  }
}
