import { JobRegistry } from './registry.js';
import type { JobHandler } from './types.js';

/**
 * Job handlers available to the CLI (`jobs resume`, `schedule run`).
 *
 * The baseline/weekly/monthly pipelines are implemented by other modules and
 * are registered here during integration, e.g.:
 *
 *   registry.register(workflowJobHandler({ type: 'weekly', workflow: 'weekly', stages: weeklyStages, ... }));
 *
 * Until a type is registered, jobs of that type fail with an honest
 * "no handler registered" status and the scheduler does not enqueue them.
 */

const extraHandlers: Array<() => JobHandler<any>> = [];

/** Register an additional handler factory for every default registry created afterwards (integration hook). */
export function addDefaultHandler(factory: () => JobHandler<any>): void {
  extraHandlers.push(factory);
}

export function createDefaultRegistry(): JobRegistry {
  const registry = new JobRegistry();
  for (const f of extraHandlers) {
    const h = f();
    if (!registry.has(h.type)) registry.register(h);
  }
  return registry;
}
