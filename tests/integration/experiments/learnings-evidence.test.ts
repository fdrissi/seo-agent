/**
 * A learning needs a measured result behind it (SYNTHETIC data): a concluded
 * evaluation whose primary verdict is not insufficient_data or
 * data_unavailable. The approval payload and `approvals show` carry the
 * result, effect, and windows; mismatching statements are flagged.
 */
import { Command, CommanderError } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalService } from '../../../src/approvals/service.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { register as registerApprovals } from '../../../src/cli/commands/approvals.js';
import { register as registerExperiments } from '../../../src/cli/commands/experiments.js';
import { evaluateExperiment } from '../../../src/experiments/evaluate.js';
import { learningEvidenceFromExperiment, listLearnings } from '../../../src/experiments/learnings.js';
import { buildScenario, type Scenario } from '../../fixtures/experiments/scenario.js';

let s: Scenario | undefined;
afterEach(() => {
  s?.ctx.cleanup();
  s = undefined;
});

async function runCli(root: string, args: string[]): Promise<{ out: string; err: string; json: any; failed: boolean }> {
  let out = '';
  let err = '';
  const cli = new CliRuntime({ out: (t) => (out += `${t}\n`), err: (t) => (err += `${t}\n`) }, { ...process.env, SEO_AGENT_WORKSPACE: root });
  const program = new Command();
  program.exitOverride().option('-w, --workspace <dir>').option('-s, --site <id>').option('--dry-run').option('--json').option('--mode <mode>').option('--offline').configureOutput({ writeErr: (x) => (err += x), writeOut: (x) => (out += x) });
  registerApprovals(program, cli);
  registerExperiments(program, cli);
  let failed = false;
  const prevExit = process.exitCode;
  try {
    await program.parseAsync(['node', 'seo-agent', '--workspace', root, '--offline', ...args]);
  } catch (e) {
    if (!(e instanceof CliExit) && !(e instanceof CommanderError)) throw e;
    failed = true;
  } finally {
    if (process.exitCode) failed = true;
    process.exitCode = prevExit;
  }
  let json: any = null;
  try {
    json = JSON.parse(out);
  } catch {
    json = null;
  }
  return { out, err, json, failed };
}

describe('learning evidence rules (A7-05)', () => {
  it('refuses a learning while the experiment is only collecting, or concluded without a measured result', async () => {
    s = await buildScenario({ treated: { before: { clicks: 1, impressions: 5 }, after: { clicks: 0, impressions: 4 } } });
    evaluateExperiment(s.ctx, s.experimentId, { actor: 'system:test' });
    expect(() => learningEvidenceFromExperiment(s!.ctx.db, s!.ctx.siteId, s!.experimentId)).toThrow(/has no concluded evaluation; a learning needs a concluded, measured result/);
    const concluded = evaluateExperiment(s.ctx, s.experimentId, { actor: 'owner:Alice', conclude: true });
    expect(concluded.result).toBe('inconclusive');
    expect(concluded.seo?.primary.verdict).toBe('insufficient_data');
    expect(() => learningEvidenceFromExperiment(s!.ctx.db, s!.ctx.siteId, s!.experimentId)).toThrow(/concluded inconclusive without a measured primary result \(seo_visibility: insufficient_data\)/);
    // The CLI refuses too, and records nothing.
    const cli = await runCli(s.ctx.paths.root, ['experiments', 'propose-learning', s.experimentId, '--statement', 'Rewriting homepage copy increases clicks by 30%', '--scope', 'site:test-site; page:/widgets', '--as', 'Alice']);
    expect(cli.failed).toBe(true);
    expect(cli.err).toMatch(/without a measured primary result/);
    expect(listLearnings(s.ctx.db, s.ctx.siteId)).toEqual([]);
  });

  it('a concluded, measured result: the approval carries result/effect/windows, approvals show renders them, and a mismatching statement is flagged', async () => {
    s = await buildScenario();
    const ev = evaluateExperiment(s.ctx, s.experimentId, { actor: 'system:test' }); // no gate: no automatic learning
    expect(ev.result).toBe('positive');
    const { evidence, summary } = learningEvidenceFromExperiment(s.ctx.db, s.ctx.siteId, s.experimentId);
    expect(summary).toMatchObject({ evaluationId: ev.evaluationId, result: 'positive', concluded: true, metric: 'ctr', verdict: 'positive', comparisonPages: 3, isSynthetic: true });
    expect(summary.effect).toBeCloseTo(0.5, 5);
    expect(summary.windows).toMatchObject({ source: 'gsc', baseline: expect.stringMatching(/^2026-\d\d-\d\d\.\.2026-06-30$/), observation: expect.stringMatching(/^2026-07-02\.\./) });
    expect(evidence).toMatchObject({ experimentId: s.experimentId, evaluationResult: 'positive' });

    const r = await runCli(s.ctx.paths.root, ['--json', 'experiments', 'propose-learning', s.experimentId, '--statement', 'The title change decreased CTR by 50%.', '--scope', 'site:test-site; page:/widgets; change type:title_meta', '--as', 'Alice']);
    expect(r.failed).toBe(false);
    expect(r.json.statementFlags.join(' ')).toMatch(/claims a decrease\/deterioration, but the recorded effect is \+50\.0%/);
    const approvalId = r.json.approval.id as string;
    const payload = new ApprovalService(s.ctx.db).detail(s.ctx.siteId, approvalId).payload!;
    expect(payload.evidenceSummary).toMatchObject({ result: 'positive', metric: 'ctr' });
    expect((payload.statementFlags as string[]).length).toBeGreaterThan(0);
    const show = await runCli(s.ctx.paths.root, ['approvals', 'show', approvalId]);
    expect(show.out).toMatch(/Measured evidence:/);
    expect(show.out).toMatch(/evaluation: {2}eval_\S+ result positive \(concluded\) \[SYNTHETIC\]/);
    expect(show.out).toMatch(/windows: {5}gsc baseline 2026-\d\d-\d\d\.\.2026-06-30 vs observation 2026-07-02\.\./);
    expect(show.out).toMatch(/Statement flags/);
  });

  it('the automatically proposed learning of a concluded experiment carries the same evidence summary', async () => {
    s = await buildScenario();
    const ev = evaluateExperiment(s.ctx, s.experimentId, { actor: 'system:test', gate: s.gate });
    const payload = s.gate.detail(s.ctx.siteId, ev.learning!.approvalId).payload!;
    expect(payload.evidenceSummary).toMatchObject({ result: 'positive', concluded: true, metric: 'ctr', verdict: 'positive' });
    expect(payload.statementFlags).toEqual([]);
  });
});
