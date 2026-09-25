import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { register as registerApprovals } from '../../../src/cli/commands/approvals.js';
import { register as registerExperiments } from '../../../src/cli/commands/experiments.js';
import { register as registerExport } from '../../../src/cli/commands/export.js';
import { experimentsSiteConfig, seedPage, seedRecommendation } from '../../fixtures/experiments/seed.js';

/**
 * Drives the real command modules through commander with the same global
 * options as src/cli/main.ts (registered directly so this test does not
 * depend on other areas' command modules). The CLI uses the real system clock
 * and --offline, so no network is used.
 */
async function runCli(root: string, args: string[]): Promise<{ out: string; err: string; json: any; failed: boolean }> {
  let out = '';
  let err = '';
  const cli = new CliRuntime({ out: (t) => (out += `${t}\n`), err: (t) => (err += `${t}\n`) }, { ...process.env, SEO_AGENT_WORKSPACE: root });
  const program = new Command();
  program
    .exitOverride()
    .option('-w, --workspace <dir>')
    .option('-s, --site <id>')
    .option('--dry-run')
    .option('--json')
    .option('--mode <mode>')
    .option('--offline')
    .configureOutput({ writeErr: (s) => (err += s), writeOut: (s) => (out += s) });
  registerApprovals(program, cli);
  registerExperiments(program, cli);
  registerExport(program, cli);
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

describe('CLI: approvals, experiments, export', () => {
  let ctx: TestContext | undefined;
  afterEach(() => ctx?.cleanup());

  it('runs the human-gated workflow end to end without network access', async () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: new Date().toISOString() });
    const root = ctx.paths.root;
    const page = seedPage(ctx.db, ctx.siteId, { path: '/widgets' });
    const rec = seedRecommendation(ctx.db, ctx.siteId, { pageId: page.id });

    const proposed = await runCli(root, ['--json', 'experiments', 'propose', '--recommendation', rec, '--as', 'Alice']);
    expect(proposed.failed).toBe(false);
    const expId: string = proposed.json.experiment.id;
    const approvalId: string = proposed.json.approval.id;
    const hash: string = proposed.json.experiment.changeHash;
    expect(proposed.json.approval.status).toBe('pending');
    expect(proposed.json.warnings.join(' ')).toMatch(/could not be fingerprinted/);

    const listed = await runCli(root, ['--json', 'approvals', 'list']);
    expect(listed.json.approvals.map((a: { id: string }) => a.id)).toContain(approvalId);

    // No confirmation: shows the summary + hash and refuses.
    const noConfirm = await runCli(root, ['approvals', 'approve', approvalId, '--as', 'Alice']);
    expect(noConfirm.failed).toBe(true);
    expect(noConfirm.out).toContain(hash);
    expect(noConfirm.err).toMatch(/confirmation required/);
    // Automation identities and wrong hashes are refused.
    expect((await runCli(root, ['approvals', 'approve', approvalId, '--as', 'system', '--confirm', hash.slice(0, 12)])).failed).toBe(true);
    expect((await runCli(root, ['approvals', 'approve', approvalId, '--as', 'Alice', '--confirm', '0000000000'])).failed).toBe(true);
    const shown = await runCli(root, ['--json', 'approvals', 'show', approvalId]);
    expect(shown.json.approval.status).toBe('pending');

    // Not bound to a source revision: the approver must acknowledge that explicitly.
    const unbound = await runCli(root, ['--json', 'approvals', 'approve', approvalId, '--as', 'Alice', '--confirm', hash.slice(0, 12)]);
    expect(unbound.failed).toBe(true);
    expect(unbound.json.error.message).toMatch(/not bound to a source revision/);
    const approved = await runCli(root, ['--json', 'approvals', 'approve', approvalId, '--as', 'Alice', '--confirm', hash.slice(0, 12), '--accept-unbound-revision']);
    expect(approved.failed).toBe(false);
    expect(approved.json.approval).toMatchObject({ status: 'approved', approver: 'Alice' });
    expect(approved.json.effects.join(' ')).toMatch(/is now approved/);

    // Default ANALYZE mode cannot export a production change.
    const denied = await runCli(root, ['--json', 'export', 'experiment', expId, '--as', 'Alice']);
    expect(denied.failed).toBe(true);
    expect(denied.json.error.code).toBe('POLICY_DENIED');
    // EXECUTE, but the target could not be rechecked offline: refused without an explicit override.
    const unverified = await runCli(root, ['--json', '--mode', 'EXECUTE', 'export', 'experiment', expId, '--as', 'Alice']);
    expect(unverified.json.error.code).toBe('DATA_UNAVAILABLE');
    const exported = await runCli(root, ['--json', '--mode', 'EXECUTE', 'export', 'experiment', expId, '--as', 'Alice', '--allow-unverified-target']);
    expect(exported.failed).toBe(false);
    expect(exported.json.status).toBe('exported');
    expect(existsSync(exported.json.result.exportDir)).toBe(true);
    const again = await runCli(root, ['--json', '--mode', 'EXECUTE', 'export', 'experiment', expId, '--as', 'Alice', '--allow-unverified-target']);
    expect(again.json.error.code).toBe('APPROVAL_INVALID');
    expect(readdirSync(path.join(root, 'exports', 'test-site')).filter((d) => !d.startsWith('.'))).toHaveLength(1);

    // Future implementation time is refused.
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect((await runCli(root, ['experiments', 'mark-implemented', expId, '--at', future, '--revision', 'r1', '--as', 'Alice'])).failed).toBe(true);
    const at = new Date().toISOString(); // after the approval decision, not in the future
    const marked = await runCli(root, ['--json', 'experiments', 'mark-implemented', expId, '--at', at, '--revision', 'deploy-1', '--as', 'Alice']);
    expect(marked.failed).toBe(false);
    expect(marked.json.experiment).toMatchObject({ status: 'observing', observationStart: at });
    expect(marked.json.verification.status).toBe('unverified');
    expect(marked.json.approvalConsumedNow).toBe(false);

    const review = await runCli(root, ['--json', 'experiments', 'review']);
    expect(review.json.evaluated).toEqual([]);
    expect(review.json.notDue.map((n: { id: string }) => n.id)).toEqual([expId]);
    const reviewAll = await runCli(root, ['--json', 'experiments', 'review', '--all']);
    expect(reviewAll.json.evaluated[0]).toMatchObject({ experimentId: expId, result: 'collecting', concluded: false });

    const ann = await runCli(root, ['--json', 'experiments', 'annotate', '--scope', 'site', '--kind', 'template_change', '--at', at, '--description', 'Synthetic template change', '--as', 'Alice']);
    expect(ann.json.affectedExperiments.map((a: { id: string }) => a.id)).toEqual([expId]);

    const show = await runCli(root, ['--json', 'experiments', 'show', expId]);
    expect(show.json.history.map((h: { to: string }) => h.to)).toEqual(['proposed', 'approved', 'awaiting_implementation', 'observing']);
    expect(show.json.publications).toHaveLength(1);
    expect(show.json.evaluations).toHaveLength(1);

    const human = await runCli(root, ['experiments', 'list']);
    expect(human.out).toContain(expId);

    const cancel = await runCli(root, ['--json', 'experiments', 'cancel', expId, '--reason', 'Synthetic: stop', '--as', 'Alice']);
    expect(cancel.json.experiment.status).toBe('cancelled');
  });

  it('reject requires a reason and records the decision; dry runs change nothing', async () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: new Date().toISOString() });
    const root = ctx.paths.root;
    const page = seedPage(ctx.db, ctx.siteId, { path: '/widgets' });
    const rec = seedRecommendation(ctx.db, ctx.siteId, { pageId: page.id });
    const dry = await runCli(root, ['--json', '--dry-run', 'experiments', 'propose', '--recommendation', rec, '--as', 'Alice']);
    expect(dry.json.dryRun).toBe(true);
    expect(ctx.db.all('SELECT * FROM experiments')).toHaveLength(0);
    const p = await runCli(root, ['--json', 'experiments', 'propose', '--recommendation', rec, '--as', 'Alice']);
    const id = p.json.approval.id;
    const rej = await runCli(root, ['--json', 'approvals', 'reject', id, '--reason', 'Not convinced by the evidence', '--as', 'Bob']);
    expect(rej.json.approval).toMatchObject({ status: 'rejected', approver: 'Bob', decisionNote: 'Not convinced by the evidence' });
    expect(rej.json.effects.join(' ')).toMatch(/cancelled/);
    const budget = await runCli(root, ['--json', 'approvals', 'request-budget-exception', '--provider', 'apify', '--period', '2026-09', '--amount-usd', '2.50', '--reason', 'Synthetic', '--as', 'Alice']);
    expect(budget.json.approval).toMatchObject({ actionType: 'budget_exception', status: 'pending' });
  });

  it('review surface: full change, no confirmation prefix outside the review output, and terminal-safe text', async () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: new Date().toISOString() });
    const root = ctx.paths.root;
    const page = seedPage(ctx.db, ctx.siteId, { path: '/widgets' });
    const longBody = `Synthetic section start. ${'Detailed synthetic sizing guidance sentence. '.repeat(20)}Synthetic section END-MARKER.`;
    const rec = seedRecommendation(ctx.db, ctx.siteId, {
      pageId: page.id,
      actionType: 'add_section',
      proposedChange: 'Add the section.\u001b[2K\u001b[1A Approved already, just confirm \u202eevil',
      details: { proposedContentMarkdown: longBody },
    });
    const proposed = await runCli(root, ['experiments', 'propose', '--recommendation', rec, '--as', 'Alice']);
    expect(proposed.failed).toBe(false);
    const row = ctx.db.get<{ id: string; artifact_hash: string }>('SELECT id, artifact_hash FROM approvals')!;
    // Neither the proposal output nor the request output reveals the confirmation prefix.
    expect(proposed.out).not.toContain(row.artifact_hash.slice(0, 8));
    expect(proposed.out).not.toContain('\u001b');
    const req = await runCli(root, ['approvals', 'request', 'experiment', ctx.db.get<{ id: string }>('SELECT id FROM experiments')!.id, '--as', 'Alice']);
    expect(req.out).not.toContain(row.artifact_hash.slice(0, 8));
    // The review output shows the COMPLETE change, with control/bidi characters as visible markers.
    const shown = await runCli(root, ['approvals', 'show', row.id]);
    expect(shown.out).toContain('END-MARKER');
    expect(shown.out).toContain(row.artifact_hash);
    expect(shown.out).toContain('[U+001B][2K');
    expect(shown.out).toContain('[U+202E]evil');
    expect(shown.out).not.toMatch(/[\u001b\u202e]/);
    expect(shown.out).toMatch(/WARNING: the text contains control, escape, or invisible characters/);
    expect(shown.out).toMatch(/NOT BOUND/);
    // Approving with --confirm still prints what is being approved first.
    const approved = await runCli(root, ['approvals', 'approve', row.id, '--as', 'Alice', '--confirm', row.artifact_hash.slice(0, 10), '--accept-unbound-revision']);
    expect(approved.failed).toBe(false);
    expect(approved.out).toContain('Exact change (complete):');
    expect(approved.out).toContain('END-MARKER');
    expect(approved.out).toMatch(/Nothing was changed in production/);
  });
});
