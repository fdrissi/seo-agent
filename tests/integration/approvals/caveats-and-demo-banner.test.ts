/**
 * Honest CLI surfaces for approvals (B2-09, B1-03):
 * - a budget exception raises no limit yet (BudgetService never reads it), so
 *   every show / approve of one says so, in text and in JSON;
 * - in a demo site, `approvals list` and `experiments list` print the
 *   SYNTHETIC DEMO DATA banner and carry `synthetic: true` in JSON.
 * SYNTHETIC data only (example.test domains); the CLI runs --offline.
 */
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { approvalCaveats, BUDGET_EXCEPTION_CAVEAT, isDemoSite, SYNTHETIC_DEMO_BANNER } from '../../../src/approvals/display.js';
import { register as registerApprovals } from '../../../src/cli/commands/approvals.js';
import { register as registerExperiments } from '../../../src/cli/commands/experiments.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import { experimentsSiteConfig, seedPage, seedRecommendation } from '../../fixtures/experiments/seed.js';

async function runCli(root: string, args: string[]): Promise<{ out: string; err: string; json: any; failed: boolean }> {
  let out = '';
  let err = '';
  const cli = new CliRuntime({ out: (t) => (out += `${t}\n`), err: (t) => (err += `${t}\n`) }, { ...process.env, SEO_AGENT_WORKSPACE: root });
  const program = new Command();
  program.exitOverride().option('-w, --workspace <dir>').option('-s, --site <id>').option('--dry-run').option('--json').option('--mode <mode>').option('--offline').configureOutput({ writeErr: (s) => (err += s), writeOut: (s) => (out += s) });
  registerApprovals(program, cli);
  registerExperiments(program, cli);
  let failed = false;
  const prevExit = process.exitCode;
  try {
    await program.parseAsync(['node', 'seo-agent', '--workspace', root, '--offline', ...args]);
  } catch (e) {
    if (!(e instanceof CliExit)) throw e;
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

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

describe('budget exceptions: no success without the caveat', () => {
  it('request, show, approve (text, JSON, dry run) all state that the exception raises no limit', async () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: new Date().toISOString() });
    const root = ctx.paths.root;
    const requested = await runCli(root, ['--json', 'approvals', 'request-budget-exception', '--provider', 'llm_gateway', '--period', '2026-09', '--amount-usd', '2.00', '--reason', 'SYNTHETIC test', '--as', 'Alice']);
    expect(requested.failed).toBe(false);
    expect(requested.json.caveats).toEqual([BUDGET_EXCEPTION_CAVEAT]);
    const id: string = requested.json.approval.id;
    const hash: string = requested.json.approval.artifactHash;

    const showText = await runCli(root, ['approvals', 'show', id]);
    expect(showText.out).toContain(`NOTE: ${BUDGET_EXCEPTION_CAVEAT}`);
    const showJson = await runCli(root, ['--json', 'approvals', 'show', id]);
    expect(showJson.json.caveats).toEqual([BUDGET_EXCEPTION_CAVEAT]);

    const dry = await runCli(root, ['--json', '--dry-run', 'approvals', 'approve', id, '--as', 'Alice', '--confirm', hash.slice(0, 12)]);
    expect(dry.json.caveats).toEqual([BUDGET_EXCEPTION_CAVEAT]);

    const approved = await runCli(root, ['approvals', 'approve', id, '--as', 'Alice', '--confirm', hash.slice(0, 12)]);
    expect(approved.failed).toBe(false);
    expect(approved.out).toMatch(/Approved .* budget_exception on budget:llm_gateway:2026-09/);
    // The result line itself is followed by the caveat (not only the review block above it).
    const result = approved.out.slice(approved.out.indexOf('Approved '));
    expect(result).toContain(`NOTE: ${BUDGET_EXCEPTION_CAVEAT}`);
    expect(BUDGET_EXCEPTION_CAVEAT).toMatch(/do not raise any limit/);

    const approvedJson = await runCli(root, ['--json', 'approvals', 'show', id]);
    expect(approvedJson.json.approval.status).toBe('approved');
    expect(approvedJson.json.caveats).toEqual([BUDGET_EXCEPTION_CAVEAT]);
  });

  it('other approvals carry no budget caveat', async () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: new Date().toISOString() });
    const page = seedPage(ctx.db, ctx.siteId, { path: '/widgets' });
    const rec = seedRecommendation(ctx.db, ctx.siteId, { pageId: page.id });
    const proposed = await runCli(ctx.paths.root, ['--json', 'experiments', 'propose', '--recommendation', rec, '--as', 'Alice']);
    const show = await runCli(ctx.paths.root, ['--json', 'approvals', 'show', proposed.json.approval.id]);
    expect(show.json.caveats).toEqual([]);
    expect(approvalCaveats({ actionType: 'title_meta_change' })).toEqual([]);
    expect(approvalCaveats({ actionType: 'budget_exception' })).toEqual([BUDGET_EXCEPTION_CAVEAT]);
  });
});

describe('demo sites are labeled in approval and experiment listings', () => {
  it('a demo-profile site prints the SYNTHETIC DEMO DATA banner and synthetic: true', async () => {
    ctx = createTestContext({ config: testSiteConfig({ profile: 'demo' }), now: new Date().toISOString() });
    const root = ctx.paths.root;
    for (const args of [['approvals', 'list'], ['approvals', 'list', '--all'], ['experiments', 'list']]) {
      const text = await runCli(root, args);
      expect(text.failed, args.join(' ')).toBe(false);
      expect(text.out.split('\n')[0]).toBe(SYNTHETIC_DEMO_BANNER);
      expect(text.out).toMatch(/^SYNTHETIC DEMO DATA/);
      const json = await runCli(root, ['--json', ...args]);
      expect(json.json).toMatchObject({ synthetic: true, banner: SYNTHETIC_DEMO_BANNER });
    }
  });

  it('a live site has no banner and synthetic: false; a site registered as demo (is_demo = 1) is detected', async () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: new Date().toISOString() });
    const root = ctx.paths.root;
    for (const args of [['approvals', 'list', '--all'], ['experiments', 'list']]) {
      const text = await runCli(root, args);
      expect(text.out).not.toMatch(/SYNTHETIC DEMO DATA/);
      const json = await runCli(root, ['--json', ...args]);
      expect(json.json.synthetic).toBe(false);
      expect(json.json.banner).toBeUndefined();
    }
    expect(isDemoSite({ db: ctx.db, siteId: ctx.siteId })).toBe(false);
    ctx.db.run('UPDATE sites SET is_demo = 1 WHERE id = ?', [ctx.siteId]);
    expect(isDemoSite({ db: ctx.db, siteId: ctx.siteId })).toBe(true);
    expect(isDemoSite({ db: ctx.db, siteId: 'no-such-site', synthetic: true })).toBe(true);
  });
});
