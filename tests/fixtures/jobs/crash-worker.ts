/**
 * SYNTHETIC TEST FIXTURE (not application code).
 *
 * Child process used by tests/integration/jobs/crash-recovery.test.ts: runs a
 * three-stage workflow job against an existing temporary workspace and kills
 * its own process with SIGKILL inside stage 2, leaving the job "running" with
 * a held site lock, exactly like a real crash or a laptop losing power.
 *
 * Usage: node --import <tsx loader> crash-worker.ts <workspaceRoot> <siteId> <jobId> <markerFile> [paidStage]
 */
import { appendFileSync } from 'node:fs';
import { createAppContext } from '../../../src/app/context.js';
import { silentLogger } from '../../../src/core/logger.js';
import { MemorySecretStore } from '../../../src/config/secrets.js';
import { JobRegistry } from '../../../src/jobs/registry.js';
import { JobRunner } from '../../../src/jobs/runner.js';
import { workflowJobHandler } from '../../../src/jobs/workflow-handler.js';
import { crashStages } from './crash-stages.js';

const [workspaceRoot, siteId, jobId, markerFile, paidStage] = process.argv.slice(2);
if (!workspaceRoot || !siteId || !jobId || !markerFile) {
  process.stderr.write('usage: crash-worker <workspaceRoot> <siteId> <jobId> <markerFile>\n');
  process.exit(2);
}

const ctx = createAppContext({ workspaceRoot, siteId, secrets: new MemorySecretStore({}), offline: true, logger: silentLogger, migrate: false });
const stages = crashStages({
  onStage: (name) => appendFileSync(markerFile, `${name}\n`),
  crashIn: 'analysis',
  crash: () => process.kill(process.pid, 'SIGKILL'),
  ...(paidStage ? { paidStage } : {}),
});
const registry = new JobRegistry().register(workflowJobHandler({ type: 'weekly', description: 'synthetic crash test', workflow: 'weekly', stages }));
const runner = new JobRunner({ registry, heartbeatMs: 50, leaseMs: 60_000 });
await runner.runJob(ctx, jobId);
appendFileSync(markerFile, 'finished-without-crash\n');
