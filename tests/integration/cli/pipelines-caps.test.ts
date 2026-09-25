import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../../src/cli/main.js';
import { researchCapLines } from '../../../src/cli/commands/pipelines.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { toMicros } from '../../../src/core/money.js';
import type { TestContext } from '../../helpers/context.js';
import { pipelineContext } from '../pipelines/helpers.js';

/**
 * A8-10 (docs/CLI.md "Money": the cap is printed before anything chargeable is
 * sent): RESEARCH-mode baseline/weekly/monthly print the per-run caps and the
 * remaining DataForSEO / Apify / LLM budget to stderr before the run starts.
 * SYNTHETIC demo-profile workspace, offline.
 */

let ctx: TestContext | undefined;
beforeEach(() => {
  process.env.SEO_AGENT_LOG_LEVEL = 'error';
});
afterEach(() => {
  delete process.env.SEO_AGENT_LOG_LEVEL;
  ctx?.cleanup();
  ctx = undefined;
  process.exitCode = undefined;
});

async function cli(c: TestContext, args: string[]): Promise<{ out: string; err: string; code: number }> {
  let out = '';
  let err = '';
  const runtime = new CliRuntime({ out: (t) => (out += `${t}\n`), err: (t) => (err += `${t}\n`) }, { ...process.env, SEO_AGENT_WORKSPACE: c.paths.root, SEO_AGENT_LOG_LEVEL: 'error' });
  const program = await buildProgram(runtime);
  program.exitOverride();
  process.exitCode = 0;
  try {
    await program.parseAsync(['node', 'seo-agent', '--workspace', c.paths.root, '--site', c.siteId, ...args]);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { out, err, code };
}

describe('RESEARCH-mode pipelines print their spending caps first', () => {
  it('lists per-run caps and remaining budgets, reflecting spend already recorded', () => {
    ctx = pipelineContext({ mode: 'RESEARCH' });
    const r = ctx.budgets.reserve({ siteId: ctx.siteId, provider: 'dataforseo', runId: 'run_synthetic_prior', purpose: 'synthetic prior spend', estimate: { upperBoundMicros: toMicros('0.20'), basis: { source: 'documented', detail: 'synthetic' } } });
    const lines = researchCapLines(ctx, 'weekly');
    expect(lines[0]).toBe('Spending caps for this RESEARCH-mode weekly run (configured ceilings, not price quotes):');
    const text = lines.join('\n');
    expect(text).toMatch(/dataforseo: up to \$0\.50 per run; \$9\.80 of \$10\.00 left this month, \$0\.80 of \$1\.00 left this week/);
    expect(text).toMatch(/llm_gateway: up to \$0\.50 per run; \$\d+\.\d\d of \$\d+\.\d\d left this month/);
    expect(text).toMatch(/apify: up to \$1\.00 per run/);
    expect(text).toMatch(/combined: \$\d+\.\d\d of \$\d+\.\d\d left this month/);
    expect(r).toBeTruthy();
    expect(researchCapLines(ctx, 'baseline').join('\n')).toMatch(/the baseline makes no DataForSEO requests/);
  });

  it('`--mode RESEARCH weekly` prints the caps to stderr before the run; ANALYZE prints none', async () => {
    ctx = pipelineContext();
    const research = await cli(ctx, ['--mode', 'RESEARCH', '--dry-run', '--json', 'weekly']);
    expect(research.err).toMatch(/Spending caps for this RESEARCH-mode weekly run/);
    expect(research.err).toMatch(/dataforseo: up to \$0\.50 per run/);
    expect(research.err).toMatch(/dry run: no paid stage runs/);
    // stdout stays machine-readable.
    expect(() => JSON.parse(research.out)).not.toThrow();
    const analyze = await cli(ctx, ['--dry-run', '--json', 'weekly']);
    expect(analyze.err).not.toMatch(/Spending caps/);
  });
});
