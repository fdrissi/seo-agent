/**
 * An audit/investigation recommendation is an instruction, not a change: it can
 * never become an experiment, an approval, or a production export. The owner
 * records ONE concrete change (`experiments specify-change`) as a new
 * recommendation revision, which then goes through the normal workflow.
 * SYNTHETIC data only (example.test domains).
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command, CommanderError } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { computeArtifactHash } from '../../../src/approvals/artifact.js';
import { changeFromRecommendation, getRecommendation, INVESTIGATION_ACTION_TYPES } from '../../../src/approvals/change.js';
import { applyDecisionEffects } from '../../../src/approvals/effects.js';
import { exportSubject } from '../../../src/approvals/export.js';
import { markImplemented } from '../../../src/approvals/implementation.js';
import { requestApprovalForSubject } from '../../../src/approvals/requests.js';
import { ApprovalService } from '../../../src/approvals/service.js';
import { proposeFromRecommendation } from '../../../src/experiments/propose.js';
import { getExperimentChange } from '../../../src/experiments/repository.js';
import { specifyRecommendationChange } from '../../../src/experiments/specify-change.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { register as registerExperiments } from '../../../src/cli/commands/experiments.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { exportInExecuteMode, REVISION, stableChecker } from '../../fixtures/experiments/scenario.js';
import { experimentsSiteConfig, htmlPage, seedPage, seedRecommendation } from '../../fixtures/experiments/seed.js';

const NOW = '2026-09-20T09:00:00.000Z';
const AUDIT_TEXT = 'Compare intent and snippet against the top results for the shortlisted queries, then propose ONE specific change for approval.';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

function setup() {
  ctx = createTestContext({ config: experimentsSiteConfig(), now: NOW });
  const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
  const page = seedPage(ctx.db, ctx.siteId, { path: '/widgets' });
  const audit = seedRecommendation(ctx.db, ctx.siteId, { pageId: page.id, actionType: 'targeted_seo_audit', proposedChange: AUDIT_TEXT, details: { score: 71, route: 'RANKING_OPPORTUNITY' } });
  return { ctx, gate, page, audit };
}

async function runCli(root: string, args: string[]): Promise<{ out: string; err: string; json: any; failed: boolean }> {
  let out = '';
  let err = '';
  const cli = new CliRuntime({ out: (t) => (out += `${t}\n`), err: (t) => (err += `${t}\n`) }, { ...process.env, SEO_AGENT_WORKSPACE: root });
  const program = new Command();
  program.exitOverride().option('-w, --workspace <dir>').option('-s, --site <id>').option('--dry-run').option('--json').option('--mode <mode>').option('--offline').configureOutput({ writeErr: (s) => (err += s), writeOut: (s) => (out += s) });
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

describe('an audit recommendation is not a change', () => {
  it('cannot become an experiment, an approval request, or a production export (every investigation type)', async () => {
    const s = setup();
    await expect(proposeFromRecommendation(s.ctx, s.gate, { recommendationId: s.audit, requestedBy: 'owner:Alice' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringMatching(/is an investigation \("targeted_seo_audit"\), not a concrete change; it cannot become an experiment/),
      hint: expect.stringMatching(/experiments specify-change/),
    });
    await expect(requestApprovalForSubject(s.ctx, s.gate, { subjectType: 'recommendation', subjectId: s.audit, requestedBy: 'owner:Alice' })).rejects.toThrow(/is an investigation/);
    s.ctx.mode = 'EXECUTE';
    await expect(exportSubject(s.ctx, s.gate, { subjectType: 'recommendation', subjectId: s.audit, actor: 'owner:Alice', allowUnverifiedTarget: true }, { targetChecker: stableChecker })).rejects.toThrow(/is an investigation/);
    await expect(exportSubject(s.ctx, s.gate, { subjectType: 'recommendation', subjectId: s.audit, actor: 'owner:Alice', dryRun: true })).rejects.toThrow(/is an investigation/);
    expect(s.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM experiments')!.n).toBe(0);
    expect(s.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM approvals')!.n).toBe(0);
    // Every investigation action type, the *_investigation family, and secondary observations are refused alike.
    for (const actionType of [...INVESTIGATION_ACTION_TYPES, 'backlink_investigation', 'observation:title_snippet_investigation']) {
      const id = seedRecommendation(s.ctx.db, s.ctx.siteId, { pageId: s.page.id, actionType, proposedChange: AUDIT_TEXT, details: {} });
      await expect(proposeFromRecommendation(s.ctx, s.gate, { recommendationId: id, requestedBy: 'owner:Alice' }), actionType).rejects.toThrow(/is an investigation/);
    }
    // Loose keys in details do not count: only a structured details_json.change does.
    const loose = seedRecommendation(s.ctx.db, s.ctx.siteId, { pageId: s.page.id, actionType: 'targeted_seo_audit', proposedChange: AUDIT_TEXT, details: { change: { kind: 'title' } } });
    await expect(proposeFromRecommendation(s.ctx, s.gate, { recommendationId: loose, requestedBy: 'owner:Alice' })).rejects.toThrow(/is an investigation/);
  });

  it('an experiment recorded earlier from an audit instruction cannot be approved or exported', async () => {
    const s = setup();
    // Simulate a legacy experiment: proposed from a free-text change, whose recommendation is an audit.
    const rec = seedRecommendation(s.ctx.db, s.ctx.siteId, { pageId: s.page.id, actionType: 'rewrite_copy', proposedChange: AUDIT_TEXT, details: {} });
    const r = await proposeFromRecommendation(s.ctx, s.gate, { recommendationId: rec, requestedBy: 'owner:Alice', sourceRevision: REVISION });
    s.ctx.db.run(`UPDATE recommendations SET action_type = 'targeted_seo_audit' WHERE id = ?`, [rec]);
    await expect(requestApprovalForSubject(s.ctx, s.gate, { subjectType: 'experiment', subjectId: r.experiment.id, requestedBy: 'owner:Alice', sourceRevision: REVISION })).rejects.toThrow(
      /records an investigation instruction .* not a concrete change/,
    );
    s.gate.approve(s.ctx.siteId, r.approval.id, { approver: 'Alice', confirmHashPrefix: r.approval.artifactHash.slice(0, 12) });
    await expect(exportInExecuteMode(s.ctx, s.gate, 'experiment', r.experiment.id)).rejects.toThrow(/not a concrete change; it cannot be approved or exported/);
    expect(s.gate.get(r.approval.id)?.status).toBe('approved');
  });
});

describe('experiments specify-change', () => {
  it('records ONE concrete change as a new, audited recommendation revision with a new hash; the revision is testable end to end', async () => {
    const s = setup();
    // A (manually requested) live approval on the audit is invalidated by the new revision.
    const stale = s.gate.request({ siteId: s.ctx.siteId, actionType: 'update_page', target: s.page.url, subjectType: 'recommendation', subjectId: s.audit, artifactHash: 'a'.repeat(64), summary: 'x', requestedBy: 'owner:Alice' });
    const r = specifyRecommendationChange(s.ctx, { recommendationId: s.audit, by: 'Alice', title: 'Synthetic Widget Guide 2026', metaDescription: 'A synthetic description for tests.', note: 'after the audit' });
    expect(r.supersededId).toBe(s.audit);
    expect(r.change).toEqual({ kind: 'title', proposedTitle: 'Synthetic Widget Guide 2026', proposedMetaDescription: 'A synthetic description for tests.' });
    expect(r.actionType).toBe('title_meta_change');
    expect(r.invalidatedApprovals).toBe(1);
    expect(s.gate.get(stale.id)?.status).toBe('invalidated');
    const next = getRecommendation(s.ctx.db, s.ctx.siteId, r.recommendation.id)!;
    // The revision is typed by its concrete change; the audit label is kept only in details.originalActionType.
    expect(next).toMatchObject({ status: 'proposed', action_type: 'title_meta_change', page_id: s.page.id, kind: 'primary' });
    expect(next.proposed_change).toBe(`On ${s.page.url}, change the title to "Synthetic Widget Guide 2026" and the meta description to "A synthetic description for tests.".`);
    const details = JSON.parse(next.details_json!);
    expect(details).toMatchObject({ change: r.change, revisionOf: s.audit, specifiedBy: 'owner:Alice', originalActionType: 'targeted_seo_audit', originalProposedChange: AUDIT_TEXT, specificationNote: 'after the audit', score: 71 });
    expect(getRecommendation(s.ctx.db, s.ctx.siteId, s.audit)!.status).toBe('superseded');
    const audit = s.ctx.db.get<{ actor: string; details_json: string }>(`SELECT actor, details_json FROM audit_events WHERE event_type = 'recommendation.change_specified'`)!;
    expect(audit.actor).toBe('owner:Alice');
    expect(JSON.parse(audit.details_json)).toMatchObject({ revisionOf: s.audit, changeHash: r.changeHash });
    // The superseded audit cannot be specified again; the revision can be proposed.
    expect(() => specifyRecommendationChange(s.ctx, { recommendationId: s.audit, by: 'Alice', title: 'Other' })).toThrow(/is superseded/);

    // Proposing hashes the STRUCTURED change as the exact change.
    const p = await proposeFromRecommendation(s.ctx, s.gate, { recommendationId: next.id, requestedBy: 'owner:Alice', sourceRevision: REVISION }, { targetChecker: stableChecker });
    const change = getExperimentChange(s.ctx.db, s.ctx.siteId, p.experiment.id)!;
    expect(change.change).toMatchObject({ title: 'Synthetic Widget Guide 2026', metaDescription: 'A synthetic description for tests.' });
    expect(change.actionType).toBe('title_meta_change');
    expect(p.experiment.type).toBe('title_meta');
    expect(p.experiment.changeHash).toBe(r.changeHash);
    expect(p.experiment.changeHash).toBe(computeArtifactHash({ actionType: 'title_meta_change', target: s.page.url, change: changeFromRecommendation(next) as Record<string, unknown> }));
    expect((p.experiment.evidence as { structuredChange: unknown }).structuredChange).toEqual(r.change);

    // ... and it goes through approval, EXECUTE export, and a verified implementation.
    const approved = s.gate.approve(s.ctx.siteId, p.approval.id, { approver: 'Alice', confirmHashPrefix: p.approval.artifactHash.slice(0, 12) });
    applyDecisionEffects(s.ctx.db, s.ctx.clock, approved, 'owner:Alice');
    const exported = await exportInExecuteMode(s.ctx, s.gate, 'experiment', p.experiment.id);
    expect(exported.status).toBe('exported');
    s.ctx.clock.set('2026-09-21T09:00:00.000Z');
    const live = htmlPage({ title: 'Synthetic Widget Guide 2026', description: 'A synthetic description for tests.' });
    const impl = await markImplemented(
      s.ctx,
      s.gate,
      { subjectType: 'experiment', subjectId: p.experiment.id, implementedAt: '2026-09-20T12:00:00Z', revision: 'r2', recordedBy: 'Alice' },
      { fetcher: async (url) => ({ ok: true, page: { requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', html: live, fetchedAt: NOW, redirectChain: [] } }) },
    );
    expect(impl.verification.status).toBe('match');
  });

  it('validates the recorder and the change: a named human, exactly ONE change, plain text, safe redirects', () => {
    const s = setup();
    expect(() => specifyRecommendationChange(s.ctx, { recommendationId: s.audit, by: 'claude', title: 'x' })).toThrow(/reserved for automation/);
    expect(() => specifyRecommendationChange(s.ctx, { recommendationId: s.audit, by: '', title: 'x' })).toThrow(/explicit human approver name/);
    expect(() => specifyRecommendationChange(s.ctx, { recommendationId: s.audit, by: 'Alice' })).toThrow(/exactly one concrete change/);
    expect(() => specifyRecommendationChange(s.ctx, { recommendationId: s.audit, by: 'Alice', title: 'x', redirectTo: 'https://www.example.test/new' })).toThrow(/ONE change; got title\/meta \+ redirect/);
    expect(() => specifyRecommendationChange(s.ctx, { recommendationId: s.audit, by: 'Alice', title: 'line one\nline two' })).toThrow(/single line/);
    expect(() => specifyRecommendationChange(s.ctx, { recommendationId: s.audit, by: 'Alice', redirectTo: 'javascript:alert(1)' })).toThrow(/plain http\(s\) URL/);
    expect(() => specifyRecommendationChange(s.ctx, { recommendationId: s.audit, by: 'Alice', redirectTo: s.page.url })).toThrow(/cannot redirect to itself/);
    expect(getRecommendation(s.ctx.db, s.ctx.siteId, s.audit)!.status).toBe('proposed');
    const off = specifyRecommendationChange(s.ctx, { recommendationId: s.audit, by: 'Alice', redirectTo: 'https://partner.example.invalid/widgets' });
    expect(off.change).toEqual({ kind: 'redirect', redirectTo: 'https://partner.example.invalid/widgets' });
    expect(off.actionType).toBe('redirect');
    expect(off.warnings.join(' ')).toMatch(/outside the site's allowedHostnames/);
    // A no-action decision has nothing to specify.
    const none = seedRecommendation(s.ctx.db, s.ctx.siteId, { pageId: s.page.id, kind: 'no_action', actionType: 'none', proposedChange: null, details: {} });
    expect(() => specifyRecommendationChange(s.ctx, { recommendationId: none, by: 'Alice', title: 'x' })).toThrow(/proposes no change/);
  });

  it('a secondary observation without a hypothesis can be specified with one; without it the experiment is refused', async () => {
    const s = setup();
    const obs = seedRecommendation(s.ctx.db, s.ctx.siteId, { pageId: s.page.id, kind: 'secondary', actionType: 'observation:title_snippet_investigation', proposedChange: null, hypothesis: null, details: {} });
    const without = specifyRecommendationChange(s.ctx, { recommendationId: obs, by: 'Alice', metaDescription: 'Synthetic meta.' });
    expect(without.change).toEqual({ kind: 'meta_description', proposedMetaDescription: 'Synthetic meta.' });
    expect(without.warnings.join(' ')).toMatch(/states no hypothesis/);
    await expect(proposeFromRecommendation(s.ctx, s.gate, { recommendationId: without.recommendation.id, requestedBy: 'owner:Alice' })).rejects.toThrow(/no hypothesis/);
    const withH = specifyRecommendationChange(s.ctx, { recommendationId: without.recommendation.id, by: 'Alice', metaDescription: 'Synthetic meta, clearer.', hypothesis: 'A clearer meta description raises CTR.' });
    expect(withH.recommendation.hypothesis).toBe('A clearer meta description raises CTR.');
    const p = await proposeFromRecommendation(s.ctx, s.gate, { recommendationId: withH.recommendation.id, requestedBy: 'owner:Alice' });
    expect(p.experiment.type).toBe('title_meta');
    expect(getExperimentChange(s.ctx.db, s.ctx.siteId, p.experiment.id)!.change).toMatchObject({ metaDescription: 'Synthetic meta, clearer.' });
  });

  it('CLI: specify-change needs --by (a human), reads --section-file, and prints the next step', async () => {
    const s = setup();
    const root = s.ctx.paths.root;
    const noBy = await runCli(root, ['experiments', 'specify-change', s.audit, '--title', 'x']);
    expect(noBy.failed).toBe(true);
    expect(noBy.err).toMatch(/--by/);
    const bot = await runCli(root, ['experiments', 'specify-change', s.audit, '--title', 'x', '--by', 'bot']);
    expect(bot.failed).toBe(true);
    expect(bot.err).toMatch(/reserved for automation/);
    const dry = await runCli(root, ['--dry-run', 'experiments', 'specify-change', s.audit, '--title', 'Dry title', '--by', 'Alice']);
    expect(dry.failed).toBe(false);
    expect(dry.out).toMatch(/Dry run: would record a title change/);
    expect(getRecommendation(s.ctx.db, s.ctx.siteId, s.audit)!.status).toBe('proposed');
    const file = path.join(root, 'section.md');
    writeFileSync(file, '## Synthetic sizing table\n\nPick the next larger synthetic size when in doubt.\n');
    const ok = await runCli(root, ['--json', 'experiments', 'specify-change', s.audit, '--section-file', file, '--by', 'Alice']);
    expect(ok.failed).toBe(false);
    expect(ok.json.change).toEqual({ kind: 'section', proposedSectionMarkdown: '## Synthetic sizing table\n\nPick the next larger synthetic size when in doubt.' });
    expect(ok.json.actionType).toBe('update_page');
    const human = await runCli(root, ['experiments', 'specify-change', ok.json.recommendation.id, '--redirect-to', 'https://www.example.test/widgets-new', '--by', 'Alice']);
    expect(human.failed).toBe(false);
    expect(human.out).toMatch(/Next: npm run cli -- experiments propose --recommendation rec_/);
  });
});
