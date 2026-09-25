/**
 * Offline demo acceptance (spec 29 "Demo mode", spec 31 "Acceptance requires
 * an offline demo that ingests fixtures, generates the vault, routes
 * opportunities, produces a sourced recommendation and draft workflow,
 * records an experiment, enforces budgets, and resumes interrupted work").
 *
 * The whole demo runs in a temporary directory with the global fetch
 * throwing (tests/setup.ts); every assertion reads the demo's own artifacts.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initWorkspace, readManifest } from '../../src/config/workspace.js';
import { workspacePaths } from '../../src/config/paths.js';
import { applySyntheticDeployment, DEMO_APPROVER, DEMO_INTERRUPT_STAGE, DEMO_MARKER_FILE, runDemo, type DemoResult } from '../../src/demo/index.js';
import { DEMO_PRICED_RUN_ID, DEMO_SYNTHETIC_RISKS } from '../../src/demo/run.js';
import { workflowDegradedStages } from '../../src/jobs/workflow-handler.js';
import { DEMO_START, openReadOnly, runCli, scalar, tempDir, type TempDir } from './helpers.js';

let tmp: TempDir | undefined;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
});

function step(r: DemoResult, id: string) {
  const s = r.steps.find((x) => x.id === id);
  if (!s) throw new Error(`demo step ${id} missing: ${r.steps.map((x) => x.id).join(', ')}`);
  return s;
}

describe('offline demo (acceptance)', () => {
  it('runs every step offline in an isolated demo workspace and leaves the expected artifacts', async () => {
    tmp = tempDir('demo');
    const dir = path.join(tmp.root, 'demo');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await runDemo({ dir, startAt: DEMO_START });
    const failed = r.steps.filter((s) => s.status === 'failed');
    expect(failed.map((s) => `${s.id}: ${s.lines.join(' | ')}`)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.synthetic).toBe(true);
    expect(r.steps.map((s) => s.id)).toEqual(['workspace', 'baseline', 'interrupt', 'resume', 'routing', 'recommendation', 'content', 'experiment', 'budgets', 'vault', 'isolation']);

    // Zero external network: the context fetch was never used and the global fetch never called.
    expect(r.network.externalRequests).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.network.dataforseoFixtureRequests).toBeGreaterThan(0);

    // Isolated demo workspace: manifest kind demo + marker + demo-profile config.
    const paths = workspacePaths(dir);
    expect(readManifest(paths)?.kind).toBe('demo');
    expect(existsSync(path.join(dir, DEMO_MARKER_FILE))).toBe(true);
    expect(readFileSync(r.workspace.configFile, 'utf8')).toMatch(/^profile: demo$/m);

    const db = openReadOnly(paths.dbFile);
    try {
      const site = r.site.id;
      expect(scalar(db, 'SELECT is_demo FROM sites WHERE id = ?', site)).toBe(1);

      // 1. Ingest fixtures (versioned, synthetic) and crawl the fixture site in-process.
      const baseline = step(r, 'baseline').data as { jobId: string; ingest: Record<string, number>; paidResearchRequests: number; experiments: number; publications: number };
      expect(scalar(db, 'SELECT COUNT(*) FROM jobs WHERE id = ? AND status = ?', baseline.jobId, 'succeeded')).toBe(1);
      expect(baseline.ingest.gscPageRows).toBeGreaterThan(0);
      expect(baseline.ingest.ga4LandingRows).toBeGreaterThan(0);
      expect(baseline.ingest.crawledPages).toBeGreaterThan(3);
      expect(scalar(db, 'SELECT COUNT(*) FROM gsc_page_daily WHERE site_id = ? AND is_synthetic = 0', site)).toBe(0);
      expect(scalar(db, "SELECT COUNT(*) FROM crawl_results WHERE site_id = ? AND render_mode != 'fixture'", site)).toBe(0);
      // Delayed revisions: a later sync stored new revisions; the current view has one row per key.
      expect(scalar(db, 'SELECT COUNT(*) FROM gsc_page_daily WHERE site_id = ? AND revision > 1', site)).toBeGreaterThan(0);
      expect(
        scalar(
          db,
          `SELECT COUNT(*) FROM (SELECT property, search_type, date, page, segment_key, COUNT(*) AS n FROM gsc_page_daily_current WHERE site_id = ? GROUP BY 1, 2, 3, 4, 5 HAVING n > 1)`,
          site,
        ),
      ).toBe(0);
      // Baseline: no paid research, no experiment, nothing published.
      expect(baseline).toMatchObject({ paidResearchRequests: 0, experiments: 0, publications: 0 });
      // C3-03: the step status and data use the combined degraded list (engine + stage output notes), as `jobs show`
      // does: the offline performance checks make the baseline "degraded", never "[ok]" next to an OFFLINE headline.
      const baselineStep = step(r, 'baseline');
      expect(baselineStep.status).toBe('degraded');
      const baselineDegraded = (baselineStep.data as { degraded: Array<{ stage: string; status: string; code: string }> }).degraded;
      expect(baselineDegraded).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'performance', status: 'offline', code: 'OFFLINE' })]));
      // The same stages the job record lists (what `jobs show` prints).
      const jobResult = JSON.parse((db.prepare('SELECT result_json FROM jobs WHERE id = ?').get(baseline.jobId) as { result_json: string }).result_json) as { degradedStages?: Array<{ stage: string }> };
      expect(baselineDegraded.map((d) => d.stage).sort()).toEqual((jobResult.degradedStages ?? []).map((d) => d.stage).sort());
      // Stage lines render through noteDisplayStatus: never "performance succeeded".
      const baselineText = baselineStep.lines.join('\n');
      expect(baselineText).toMatch(/^ {2}performance\s+offline\s+OFFLINE: /m);
      expect(baselineText).not.toMatch(/^ {2}performance\s+succeeded/m);
      expect(baselineText).toMatch(/Stages that did not do all of their work \(\d+\): .*performance offline \(OFFLINE\)/);

      // 2. Interrupted weekly job, resumed from its checkpoints without redoing completed work.
      const interrupt = step(r, 'interrupt').data as { jobId: string; completedBefore: string[]; checkpointedBefore: string[]; degradedBefore: Array<{ stage: string; status: string; code: string }> };
      const resume = step(r, 'resume').data as { jobId: string; fromCheckpoint: string[]; rerun: string[]; nothingRedone: boolean };
      expect(resume.jobId).toBe(interrupt.jobId);
      expect(interrupt.checkpointedBefore).toContain('research');
      // D3-06: checkpointed stages that did not do all of their work (offline performance checks, research with
      // blocked competitors) are listed apart with their codes, never as "Completed".
      expect(interrupt.completedBefore).not.toContain('research');
      expect(interrupt.completedBefore).not.toContain('performance');
      expect(interrupt.completedBefore).toEqual(expect.arrayContaining(['sync_gsc', 'sync_ga4', 'crawl_site', 'route_and_score']));
      expect(interrupt.degradedBefore).toEqual(
        expect.arrayContaining([
          { stage: 'performance', status: 'offline', code: 'OFFLINE' },
          { stage: 'research', status: 'degraded', code: 'COMPETITOR_BLOCKED' },
        ]),
      );
      expect([...interrupt.completedBefore, ...interrupt.degradedBefore.map((d) => d.stage)].sort()).toEqual([...interrupt.checkpointedBefore].sort());
      const interruptText = step(r, 'interrupt').lines.join('\n');
      const completedLine = interruptText.split('\n').find((l) => l.startsWith('Completed and checkpointed before the interruption: '))!;
      expect(completedLine).toBeDefined();
      expect(completedLine).not.toMatch(/\b(performance|research)\b/);
      expect(interruptText).toMatch(/^Checkpointed before the interruption but degraded, offline, or skipped [^:]*: .*performance offline \(OFFLINE\).*research degraded \(COMPETITOR_BLOCKED\)\.$/m);
      expect(resume.fromCheckpoint).toEqual(expect.arrayContaining(['sync_gsc', 'sync_ga4', 'crawl_site', 'route_and_score', 'research']));
      expect(resume.rerun[0]).toBe(DEMO_INTERRUPT_STAGE);
      expect(resume.nothingRedone).toBe(true);
      expect(step(r, 'resume').status).toBe('degraded');
      expect((step(r, 'resume').data as { degraded: Array<{ stage: string; code: string }> }).degraded).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'performance', code: 'OFFLINE' })]));
      const runs = db.prepare('SELECT status FROM job_runs WHERE job_id = ? ORDER BY attempt').all(interrupt.jobId) as Array<{ status: string }>;
      expect(runs.map((x) => x.status)).toEqual(['interrupted', 'succeeded']);
      expect(scalar(db, "SELECT COUNT(*) FROM checkpoints WHERE job_id = ? AND stage = 'research' AND status = 'succeeded'", interrupt.jobId)).toBe(1);
      expect(scalar(db, 'SELECT COUNT(*) FROM jobs WHERE id = ? AND status = ?', interrupt.jobId, 'succeeded')).toBe(1);

      // 3. Routing with reason codes.
      const routes = db.prepare('SELECT route, reason_codes_json FROM route_decisions WHERE site_id = ? AND job_id = ?').all(site, interrupt.jobId) as Array<{ route: string; reason_codes_json: string }>;
      expect(routes.length).toBeGreaterThan(0);
      expect(routes.every((x) => JSON.parse(x.reason_codes_json).length > 0)).toBe(true);
      expect(routes.some((x) => ['RANKING_OPPORTUNITY', 'CTR_OPPORTUNITY', 'CONTENT_OPPORTUNITY'].includes(x.route))).toBe(true);

      // 4. Sourced recommendation: claim labels with evidence; research labeled sandbox; blocked competitors recorded.
      const rec = step(r, 'recommendation').data as { recommendationId: string; labelCounts: Record<string, number>; evidencedClaims: number; blocked: Array<{ url: string; reason: string }>; researchSandbox: boolean };
      expect(scalar(db, 'SELECT COUNT(*) FROM recommendations WHERE site_id = ? AND id = ?', site, rec.recommendationId)).toBe(1);
      expect(rec.labelCounts.OBSERVED).toBeGreaterThan(0);
      expect(rec.labelCounts.RECOMMENDATION).toBeGreaterThan(0);
      expect(rec.evidencedClaims).toBeGreaterThan(0);
      expect(rec.researchSandbox).toBe(true);
      expect(rec.blocked.map((b) => b.reason)).toEqual(expect.arrayContaining(['robots', 'login_required']));
      const weeklyMd = readFileSync(r.paths.weeklyReport!, 'utf8');
      expect(weeklyMd).toMatch(/SYNTHETIC DEMO DATA/);
      expect(weeklyMd).toMatch(/\*\*OBSERVED\*\*/);
      expect(weeklyMd).toMatch(/Sources: `/);
      expect(existsSync(r.paths.weeklyReport!.replace(/\.md$/, '.json'))).toBe(true);
      // The fake injection line on a competitor page changed nothing.
      expect(scalar(db, "SELECT COUNT(*) FROM approvals WHERE site_id = ? AND requested_by LIKE '%competitor%'", site)).toBe(0);

      // 5. Content workflow: Apify fixture signals, brief, approval by the explicit demo persona, draft, review.
      const content = step(r, 'content').data as {
        apify: { signals: number };
        brief: { briefId: string; approvalId: string };
        draftApproval: { approver: string };
        draft: { draftId: string; firstVersion: number; finalDraftId: string; finalVersion: number; revisions: number; maxRevisions: number; verdict: string; stages: string[] };
      };
      expect(content.apify.signals).toBeGreaterThan(0);
      expect(scalar(db, 'SELECT COUNT(*) FROM content_signals WHERE site_id = ? AND is_synthetic = 0', site)).toBe(0);
      expect(scalar(db, 'SELECT COUNT(*) FROM content_briefs WHERE site_id = ? AND id = ?', site, content.brief.briefId)).toBe(1);
      const approval = db.prepare('SELECT action_type, status, approver FROM approvals WHERE id = ?').get(content.brief.approvalId) as { action_type: string; status: string; approver: string };
      expect(approval.action_type).toBe('draft_generation');
      expect(approval.approver).toBe(DEMO_APPROVER);
      expect(['approved', 'executed']).toContain(approval.status);
      expect(content.draft.stages).toEqual(['brief', 'draft', 'quality_review']);
      expect(content.draft.verdict).not.toBe('pass');
      const draft = db.prepare('SELECT package_json FROM content_drafts WHERE site_id = ? ORDER BY created_at DESC LIMIT 1').get(site) as { package_json: string };
      expect(draft.package_json).toMatch(/SYNTHETIC DEMO DRAFT/);
      expect(scalar(db, "SELECT COUNT(*) FROM quality_reviews WHERE site_id = ? AND subject_type = 'draft'", site)).toBeGreaterThan(0);
      expect(scalar(db, "SELECT COUNT(*) FROM publications WHERE site_id = ? AND subject_type = 'draft'", site)).toBe(0);
      // B6-12: the narrated verdict belongs to the FINAL draft version, and the automated revisions are stated.
      const finalDraft = db.prepare('SELECT id, version, revision_round FROM content_drafts WHERE site_id = ? AND id = ?').get(site, content.draft.finalDraftId) as { id: string; version: number; revision_round: number };
      expect(finalDraft.version).toBe(content.draft.finalVersion);
      expect(content.draft.revisions).toBe(finalDraft.revision_round);
      expect(content.draft.finalVersion - content.draft.firstVersion).toBe(content.draft.revisions);
      expect(content.draft.maxRevisions).toBeLessThanOrEqual(2);
      expect(content.draft.revisions).toBeLessThanOrEqual(content.draft.maxRevisions);
      if (content.draft.revisions > 0) expect(content.draft.finalDraftId).not.toBe(content.draft.draftId);
      const finalReview = db.prepare("SELECT verdict FROM quality_reviews WHERE site_id = ? AND subject_type = 'draft' AND subject_id = ? ORDER BY rowid DESC LIMIT 1").get(site, finalDraft.id) as { verdict: string };
      expect(finalReview.verdict).toBe(content.draft.verdict);
      // D1-R05: the demo has no pending Apify run (only the synthetic dataset, already processed), so the content
      // queue's apify_signals stage is not an offline skip, and the content step is [ok] like its jobs.
      const queueJobId = (step(r, 'content').data as { queue: { jobId: string; degraded: unknown[] } }).queue.jobId;
      const apifySignals = JSON.parse((db.prepare("SELECT output_json FROM checkpoints WHERE job_id = ? AND stage = 'apify_signals' AND status = 'succeeded'").get(queueJobId) as { output_json: string }).output_json);
      expect(apifySignals).toMatchObject({ status: 'ok', detail: 'No pending Apify runs.', note: null });
      const contentText = step(r, 'content').lines.join('\n');
      expect(contentText).toContain(`Automated revisions before the stop: ${content.draft.revisions} (max ${content.draft.maxRevisions})`);
      expect(contentText).toContain(`Final draft ${finalDraft.id} (v${finalDraft.version}, revision round ${finalDraft.revision_round}`);
      expect(contentText).toContain(`quality review verdict ${content.draft.verdict}`);

      // C3-03 / D1-R05: every step that reports jobs takes its status from the jobs' combined degraded lists
      // (what `jobs show` prints): [degraded] exactly when one of its jobs has a stage that did not do all of its
      // work, [ok] otherwise; and the step's data carries the same lists as the job records.
      const recordedDegraded = (jobId: string) => workflowDegradedStages(JSON.parse((db.prepare('SELECT result_json FROM jobs WHERE id = ?').get(jobId) as { result_json: string }).result_json));
      const contentData = step(r, 'content').data as { queue: { jobId: string; degraded: unknown[] }; brief: { jobId: string; degraded: unknown[] }; draft: { jobId: string; degraded: unknown[] } };
      const stepJobs: Record<string, Array<{ jobId: string; degraded: unknown }>> = {
        baseline: [{ jobId: baseline.jobId, degraded: (baselineStep.data as { degraded: unknown }).degraded }],
        resume: [{ jobId: resume.jobId, degraded: (step(r, 'resume').data as { degraded: unknown }).degraded }],
        content: [contentData.queue, contentData.brief, contentData.draft],
      };
      for (const [id, jobs] of Object.entries(stepJobs)) {
        const lists = jobs.map((j) => recordedDegraded(j.jobId));
        jobs.forEach((j, i) => expect(j.degraded, `${id} job ${j.jobId}`).toEqual(lists[i]));
        const total = lists.flat();
        expect(step(r, id).status, `${id}: ${JSON.stringify(total)}`).toBe(total.length ? 'degraded' : 'ok');
      }
      expect(step(r, 'content').status).toBe('ok');
      expect(recordedDegraded(contentData.queue.jobId)).toEqual([]);

      // 6. Experiment: an audit recommendation is never tested as a change. The demo persona records ONE concrete
      //    synthetic title/meta change as a new revision; that revision is proposed -> approved -> (export) -> observing.
      const expData = step(r, 'experiment').data as {
        specified?: { from: string; to: string; kind: string };
        proposed: { recommendationId: string };
        experiment: { id: string; status: string; history: string[]; implementedAt: string; exportDir: string; publicationId: string; verification: string };
      };
      const exp = expData.experiment;
      const tested = db.prepare('SELECT action_type, details_json, status FROM recommendations WHERE id = ?').get(expData.proposed.recommendationId) as { action_type: string; details_json: string; status: string };
      if (expData.specified) {
        expect(expData.proposed.recommendationId).toBe(expData.specified.to);
        expect(JSON.parse(tested.details_json).change).toMatchObject({ kind: 'title' });
        expect((db.prepare('SELECT status FROM recommendations WHERE id = ?').get(expData.specified.from) as { status: string }).status).toBe('superseded');
        expect(tested.status).not.toBe('superseded');
      }
      const change = JSON.parse((db.prepare('SELECT change_json FROM experiment_changes WHERE experiment_id = ?').get(exp.id) as { change_json: string }).change_json);
      expect(change.title).toMatch(/SYNTHETIC/);
      expect(exp.verification).toBe('match');
      expect(exp.status).toBe('observing');
      expect(exp.history).toEqual(['proposed', 'approved', 'awaiting_implementation', 'observing']);
      const row = db.prepare('SELECT implemented_at, observation_start FROM experiments WHERE id = ?').get(exp.id) as { implemented_at: string; observation_start: string };
      expect(row.implemented_at).toBe(exp.implementedAt);
      expect(row.observation_start).toBe(exp.implementedAt);
      expect(scalar(db, 'SELECT COUNT(*) FROM publications WHERE id = ? AND implemented_at = ?', exp.publicationId, exp.implementedAt)).toBe(1);
      expect(existsSync(path.join(exp.exportDir, 'manifest.json'))).toBe(true);
      expect(readFileSync(path.join(exp.exportDir, 'README.md'), 'utf8')).toMatch(/SYNTHETIC/);

      // 7. Budgets: a synthetic priced run goes through reserve -> reconcile until a lowered per-run cap stops it;
      //    an unknown price is denied. Both denials are audited (exactly two), nothing is sent for them.
      const budgets = step(r, 'budgets').data as { overBudget: { code: string; stoppedAtAttempt: number }; unknownPrice: { code: string }; requestsPrepared: number; pricedRun: { reconciled: number } };
      expect(budgets.overBudget.code).toBe('BUDGET_EXCEEDED');
      expect(budgets.unknownPrice.code).toBe('BUDGET_UNKNOWN_PRICE');
      expect(budgets.requestsPrepared).toBe(0);
      expect(scalar(db, "SELECT COUNT(*) FROM audit_events WHERE site_id = ? AND event_type = 'budget.denied'", site)).toBe(2);
      expect(scalar(db, "SELECT COUNT(*) FROM budget_reservations WHERE site_id = ? AND run_id = 'demo-budget-check'", site)).toBe(0);
      const reconciledSynthetic = scalar(
        db,
        `SELECT COUNT(*) FROM budget_reservations r JOIN provider_requests p ON p.id = r.provider_request_id
         WHERE r.site_id = ? AND r.run_id = ? AND r.status = 'reconciled' AND r.cost_status = 'actual' AND p.is_synthetic = 1`,
        site,
        DEMO_PRICED_RUN_ID,
      );
      expect(reconciledSynthetic).toBeGreaterThan(0);
      expect(reconciledSynthetic).toBe(budgets.pricedRun.reconciled);
      expect(budgets.overBudget.stoppedAtAttempt).toBe(reconciledSynthetic + 1);
      // The cap stop left no reservation behind for the refused task.
      expect(scalar(db, "SELECT COUNT(*) FROM budget_reservations WHERE site_id = ? AND run_id = ? AND status != 'reconciled'", site, DEMO_PRICED_RUN_ID)).toBe(0);
      // B1-03 / B2-03: every cost row of the demo is flagged synthetic, and the fixture-priced amounts are recorded
      // as computed from usage at list price (never as a provider-reported charge).
      expect(scalar(db, 'SELECT COUNT(*) FROM budget_reservations WHERE site_id = ?', site)).toBeGreaterThan(0);
      expect(scalar(db, 'SELECT COUNT(*) FROM budget_reservations WHERE site_id = ? AND is_synthetic = 0', site)).toBe(0);
      expect(scalar(db, 'SELECT COUNT(*) FROM cost_ledger WHERE site_id = ? AND is_synthetic = 0', site)).toBe(0);
      expect(scalar(db, "SELECT COUNT(*) FROM budget_reservations WHERE site_id = ? AND run_id = ? AND cost_basis = 'computed_from_usage'", site, DEMO_PRICED_RUN_ID)).toBe(budgets.pricedRun.reconciled);
      const budgetText = step(r, 'budgets').lines.join('\n');
      expect(budgetText).toContain('recorded as computed from usage at list price, not provider-reported and flagged synthetic');
      expect(budgetText).toMatch(/Spend this month \[SYNTHETIC DEMO DATA: no real charges; only the fixture prices above\]: .*dataforseo \$0\.00 provider-reported, \$0\.\d+ computed/);
      expect((step(r, 'budgets').data as { spend: unknown }).spend).toMatchObject({ synthetic: true, containsSynthetic: true, nonSyntheticCostRows: 0 });
    } finally {
      db.close();
    }

    // 8. Vault: dashboard, page notes, reports, experiment and draft notes; no broken links.
    const vault = r.workspace.vaultDir;
    const dashboard = readFileSync(path.join(vault, '00 Dashboard', 'Dashboard.md'), 'utf8');
    expect(dashboard).toMatch(/SYNTHETIC DEMO DATA/);
    expect(dashboard).toMatch(/Best opportunity/);
    expect(readdirSync(path.join(vault, '02 Website', 'Pages')).length).toBeGreaterThan(3);
    expect(readdirSync(path.join(vault, '07 Reports', 'Weekly')).some((f) => f.endsWith('.md'))).toBe(true);
    expect(readdirSync(path.join(vault, '06 Experiments')).some((f) => f.endsWith('.md'))).toBe(true);
    expect(r.paths.draft && existsSync(r.paths.draft)).toBe(true);
    const vaultData = step(r, 'vault').data as { check: { counts: { errors: number } } };
    expect(vaultData.check.counts.errors).toBe(0);

    // 9. Isolation checks passed, and they cover the cost tables.
    expect(step(r, 'isolation').data).toMatchObject({ attempted: [], nonSynthetic: {}, isDemoSite: true, checkedTables: expect.arrayContaining(['provider_requests', 'budget_reservations', 'cost_ledger']) });

    // 10. DEMO.md follow-up: `costs` in the demo workspace is labeled synthetic in text and JSON (B1-03).
    const costsText = await runCli(['--workspace', dir, 'costs']);
    expect(costsText.code, costsText.err).toBe(0);
    expect(costsText.out.split('\n')[0]).toMatch(/^SYNTHETIC DEMO DATA: no real charges/);
    expect(costsText.out).toContain(`Spend for ${r.site.id}`);
    expect(costsText.out).toMatch(/^Combined: .*\[SYNTHETIC\]$/m);
    const costsJson = await runCli(['--workspace', dir, '--json', 'costs']);
    expect(costsJson.code, costsJson.err).toBe(0);
    const spend = costsJson.json<{ synthetic: boolean; siteId: string; periodMonth: string; costBasis: Array<{ provider: string; computedMicros: number; syntheticMicros: number }>; providers: Array<{ provider: string; committedMicros: number }> }>();
    expect(spend).toMatchObject({ synthetic: true, siteId: r.site.id });
    const unresolvedJson = await runCli(['--workspace', dir, '--json', 'costs', '--unresolved']);
    expect(unresolvedJson.json()).toMatchObject({ synthetic: true, report: { synthetic: true } });
    // When the command runs in the demo's budget month, the fixture amounts show as computed and synthetic, never as provider-reported.
    const db2 = openReadOnly(paths.dbFile);
    try {
      const demoMonth = (db2.prepare('SELECT period_month AS m FROM budget_reservations WHERE site_id = ? AND run_id = ? LIMIT 1').get(r.site.id, DEMO_PRICED_RUN_ID) as { m: string }).m;
      if (spend.periodMonth === demoMonth) {
        const dfs = spend.costBasis.find((b) => b.provider === 'dataforseo')!;
        expect(dfs.computedMicros).toBeGreaterThan(0);
        expect(dfs.syntheticMicros).toBe(spend.providers.find((p) => p.provider === 'dataforseo')!.committedMicros);
      }
    } finally {
      db2.close();
    }
  });

  it('the CLI prints a SYNTHETIC-labeled walkthrough, supports --json and --dry-run, and refreshes a previous demo', async () => {
    tmp = tempDir('demo-cli');
    const dir = path.join(tmp.root, 'demo');
    const dry = await runCli(['demo', '--dir', dir, '--dry-run', '--json']);
    expect(dry.code).toBe(0);
    expect(dry.json()).toMatchObject({ dryRun: true, synthetic: true, action: 'create a new demo workspace' });
    expect(existsSync(dir)).toBe(false);

    const human = await runCli(['demo', '--dir', dir, '--start-at', DEMO_START], { SEO_AGENT_WORKSPACE: path.join(tmp.root, 'not-used') });
    expect(human.code).toBe(0);
    expect(human.err).toMatch(/ignores --workspace/);
    expect(existsSync(path.join(tmp.root, 'not-used'))).toBe(false);
    expect(human.out).toMatch(/SYNTHETIC DEMO DATA/);
    const stepLines = human.out.split('\n').filter((l) => /^\s*\d+\. \[/.test(l));
    expect(stepLines).toHaveLength(11);
    for (const l of stepLines) expect(l).toMatch(/\[SYNTHETIC\]$/);
    expect(human.out).toMatch(/External network requests: 0/);
    expect(human.out).toMatch(/Result: demo completed/);
    expect(human.out).toContain(path.join(dir, 'vault', 'demo-widgets'));

    // Re-running refreshes the previous demo; files the demo did not create are left untouched.
    writeFileSync(path.join(dir, 'my-notes.txt'), 'kept');
    const again = await runCli(['demo', '--dir', dir, '--start-at', DEMO_START, '--json']);
    expect(again.code).toBe(0);
    const res = again.json<DemoResult>();
    expect(res.ok).toBe(true);
    expect(res.workspace.refreshed).toBe(true);
    expect(res.workspace.untouched).toEqual(['my-notes.txt']);
    expect(readFileSync(path.join(dir, 'my-notes.txt'), 'utf8')).toBe('kept');
    // One demo run's data only (the refresh replaced the previous database).
    const db = openReadOnly(workspacePaths(dir).dbFile);
    try {
      expect(scalar(db, "SELECT COUNT(*) FROM jobs WHERE type = 'baseline'")).toBe(1);
    } finally {
      db.close();
    }
  });

  it('the experiment step states a labeled SYNTHETIC risk when the recommendation it tests states none (NF-09)', async () => {
    tmp = tempDir('demo-risks');
    const dir = path.join(tmp.root, 'demo');
    let stripped = 0;
    const r = await runDemo({
      dir,
      startAt: DEMO_START,
      onStep: (s) => {
        if (s.id !== 'content') return; // right before the experiment step
        // SYNTHETIC: every proposed recommendation states no risks (like secondary observations and simple-draft primaries).
        const w = new DatabaseSync(workspacePaths(dir).dbFile);
        try {
          stripped = Number(w.prepare("UPDATE recommendations SET risks = NULL WHERE status = 'proposed'").run().changes);
        } finally {
          w.close();
        }
      },
    });
    expect(stripped).toBeGreaterThan(0);
    const exp = step(r, 'experiment');
    expect(exp.status, exp.lines.join('\n')).toBe('ok');
    expect(r.ok).toBe(true);
    expect((exp.data as { syntheticRisks?: string }).syntheticRisks).toBe(DEMO_SYNTHETIC_RISKS);
    expect(DEMO_SYNTHETIC_RISKS).toMatch(/^SYNTHETIC demo risk: .*demo data only\.$/);
    expect(exp.lines.join('\n')).toMatch(/states no risks, and an experiment is never proposed without them: the labeled demo persona states a SYNTHETIC risk/);
    const db = openReadOnly(workspacePaths(dir).dbFile);
    try {
      const id = (exp.data as { experiment: { id: string } }).experiment.id;
      expect((db.prepare('SELECT risks, status FROM experiments WHERE id = ?').get(id) as { risks: string; status: string })).toEqual({ risks: DEMO_SYNTHETIC_RISKS, status: 'observing' });
    } finally {
      db.close();
    }
  });

  it('the synthetic deployment only edits the demo\'s own site copy, and only machine-applicable title/meta changes', () => {
    tmp = tempDir('demo-deploy');
    const site = path.join(tmp.root, 'site');
    mkdirSync(path.join(site, 'blog'), { recursive: true });
    const page = '<!doctype html>\n<!-- SYNTHETIC fixture page -->\n<html><head><title>Old title</title>\n<meta name="description" content="Old description"></head><body><h1>x</h1></body></html>\n';
    writeFileSync(path.join(site, 'blog', 'guide.html'), page);
    const applied = applySyntheticDeployment(site, 'https://www.example.com/', 'https://www.example.com/blog/guide', { title: 'New <synthetic> title', metaDescription: 'New "synthetic" description' });
    expect(applied.applied).toEqual(['title', 'meta description']);
    const html = readFileSync(path.join(site, 'blog', 'guide.html'), 'utf8');
    expect(html).toContain('<title>New &lt;synthetic&gt; title</title>');
    expect(html).toContain('<meta name="description" content="New &quot;synthetic&quot; description">');
    expect(html).toContain('demo deployment applied');
    // Free-text instructions, other hosts, and unknown pages change nothing.
    writeFileSync(path.join(site, 'blog', 'guide.html'), page);
    expect(applySyntheticDeployment(site, 'https://www.example.com/', 'https://www.example.com/blog/guide', { instructions: 'audit the page' }).applied).toEqual([]);
    expect(applySyntheticDeployment(site, 'https://www.example.com/', 'https://other.example/blog/guide', { title: 'x' }).applied).toEqual([]);
    expect(applySyntheticDeployment(site, 'https://www.example.com/', 'https://www.example.com/../../etc/passwd', { title: 'x' }).applied).toEqual([]);
    expect(readFileSync(path.join(site, 'blog', 'guide.html'), 'utf8')).toBe(page);
  });

  it('never touches a live workspace, a non-empty foreign directory, or the application repository', async () => {
    tmp = tempDir('demo-refuse');
    const live = path.join(tmp.root, 'live');
    initWorkspace(live, { kind: 'live' });
    const before = readdirSync(live).sort();
    const r1 = await runCli(['demo', '--dir', live]);
    expect(r1.code).toBe(1);
    expect(r1.err).toMatch(/live workspace/);
    expect(readdirSync(live).sort()).toEqual(before);

    const foreign = path.join(tmp.root, 'photos');
    mkdirSync(foreign);
    writeFileSync(path.join(foreign, 'holiday.jpg'), 'not a workspace');
    const r2 = await runCli(['demo', '--dir', foreign]);
    expect(r2.code).toBe(1);
    expect(r2.err).toMatch(/not a seo-agent demo workspace/);
    expect(readdirSync(foreign)).toEqual(['holiday.jpg']);

    const repoDir = path.resolve('tests', 'e2e', '.demo-should-not-exist');
    const r3 = await runCli(['demo', '--dir', repoDir, '--dry-run']);
    expect(r3.code).toBe(1);
    expect(r3.err).toMatch(/inside the application repository/);
    expect(existsSync(repoDir)).toBe(false);
  });
});
