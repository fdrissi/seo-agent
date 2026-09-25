import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { ApprovalService } from '../../../src/approvals/service.js';
import { applyDecisionEffects } from '../../../src/approvals/effects.js';
import { markImplemented } from '../../../src/approvals/implementation.js';
import type { PageFetcher, PageFetchResult } from '../../../src/approvals/page-fetch.js';
import { proposeFromRecommendation } from '../../../src/experiments/propose.js';
import { getExperiment } from '../../../src/experiments/repository.js';
import { requestApprovalForSubject } from '../../../src/approvals/requests.js';
import { exportInExecuteMode, REVISION, stableChecker } from '../../fixtures/experiments/scenario.js';
import { acceptDraftAsHuman, experimentsSiteConfig, htmlPage, seedCrawlResult, seedDraft, seedPage, seedRecommendation } from '../../fixtures/experiments/seed.js';

const PROPOSE = '2026-09-10T08:00:00.000Z';
const APPROVE = '2026-09-11T09:00:00.000Z';
const EXPORT = '2026-09-11T10:00:00.000Z';
const NOW = '2026-09-14T09:00:00.000Z';

function fetcherReturning(html: string | null, status = 200): PageFetcher & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string): Promise<PageFetchResult> => {
    calls.push(url);
    if (html === null) return { ok: false, reason: 'offline', detail: 'offline in test' };
    if (status >= 400) return { ok: false, reason: 'http_error', detail: `HTTP ${status}`, status };
    return { ok: true, page: { requestedUrl: url, finalUrl: url, status, contentType: 'text/html', html, fetchedAt: NOW, redirectChain: [] } };
  }) as PageFetcher & { calls: string[] };
  f.calls = calls;
  return f;
}

/** Propose (bound to a revision) -> approve -> export in EXECUTE mode (the normal path), unless told otherwise. */
async function setup(opts: { approve?: boolean; exportIt?: boolean } = {}) {
  const ctx = createTestContext({ config: experimentsSiteConfig(), now: PROPOSE });
  const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
  const page = seedPage(ctx.db, ctx.siteId, { path: '/widgets' });
  seedCrawlResult(ctx.db, ctx.siteId, { pageId: page.id, url: page.url, fetchedAt: '2026-09-01T00:00:00.000Z', title: 'Old Synthetic Title', metaDescription: 'Old synthetic description.' });
  const rec = seedRecommendation(ctx.db, ctx.siteId, { pageId: page.id });
  const r = await proposeFromRecommendation(ctx, gate, { recommendationId: rec, requestedBy: 'owner:Alice', sourceRevision: REVISION }, { targetChecker: stableChecker });
  let exportDir: string | null = null;
  if (opts.approve !== false) {
    ctx.clock.set(APPROVE);
    const a = gate.approve(ctx.siteId, r.approval.id, { approver: 'Alice', confirmHashPrefix: r.approval.artifactHash.slice(0, 12) });
    applyDecisionEffects(ctx.db, ctx.clock, a, 'owner:Alice');
    if (opts.exportIt !== false) {
      ctx.clock.set(EXPORT);
      exportDir = (await exportInExecuteMode(ctx, gate, 'experiment', r.experiment.id)).result!.exportDir;
    }
  }
  ctx.clock.set(NOW);
  return { ctx, gate, page, expId: r.experiment.id, approvalId: r.approval.id, exportDir };
}

const matching = htmlPage({ title: 'Synthetic Widget Guide 2026', description: 'A synthetic description for tests.' });

describe('mark-implemented validation', () => {
  let ctx: TestContext | undefined;
  afterEach(() => ctx?.cleanup());

  it('refuses a future implementation time', async () => {
    const s = await setup();
    ctx = s.ctx;
    await expect(
      markImplemented(s.ctx, s.gate, { subjectType: 'experiment', subjectId: s.expId, implementedAt: '2026-09-15T00:00:00Z', revision: 'r1', recordedBy: 'Alice' }, { fetcher: fetcherReturning(matching) }),
    ).rejects.toThrow(/in the future/);
  });

  it('refuses an implementation time before the approval decision', async () => {
    const s = await setup();
    ctx = s.ctx;
    await expect(
      markImplemented(s.ctx, s.gate, { subjectType: 'experiment', subjectId: s.expId, implementedAt: '2026-09-11T08:59:00Z', revision: 'r1', recordedBy: 'Alice' }, { fetcher: fetcherReturning(matching) }),
    ).rejects.toThrow(/before the approval decision/);
  });

  it('refuses when no approval exists (pending does not count)', async () => {
    const s = await setup({ approve: false });
    ctx = s.ctx;
    await expect(
      markImplemented(s.ctx, s.gate, { subjectType: 'experiment', subjectId: s.expId, implementedAt: '2026-09-12T10:00:00Z', revision: 'r1', recordedBy: 'Alice' }, { fetcher: fetcherReturning(matching) }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(getExperiment(s.ctx.db, s.ctx.siteId, s.expId).status).toBe('proposed');
    expect(s.ctx.db.all('SELECT * FROM publications')).toHaveLength(0);
  });

  it('refuses timestamps without an explicit zone, the wrong URL, a missing revision, and automation recorders', async () => {
    const s = await setup();
    ctx = s.ctx;
    const base = { subjectType: 'experiment', subjectId: s.expId, implementedAt: '2026-09-12T10:00:00Z', revision: 'r1', recordedBy: 'Alice' };
    const f = { fetcher: fetcherReturning(matching) };
    await expect(markImplemented(s.ctx, s.gate, { ...base, implementedAt: '2026-09-12 10:00' }, f)).rejects.toThrow(/explicit zone/);
    await expect(markImplemented(s.ctx, s.gate, { ...base, url: 'https://www.example.test/other' }, f)).rejects.toThrow(/not the approved target/);
    await expect(markImplemented(s.ctx, s.gate, { ...base, revision: ' ' }, f)).rejects.toThrow(/revision is required/);
    await expect(markImplemented(s.ctx, s.gate, { ...base, recordedBy: 'scheduler' }, f)).rejects.toThrow(/reserved for automation/);
  });

  it('records the publication with before/after snapshots, rollback info, and a verified live match', async () => {
    const s = await setup();
    ctx = s.ctx;
    const fetcher = fetcherReturning(matching);
    const r = await markImplemented(s.ctx, s.gate, { subjectType: 'experiment', subjectId: s.expId, implementedAt: '2026-09-12T10:00:00+03:00', revision: 'deploy-7', recordedBy: 'Alice' }, { fetcher });
    expect(fetcher.calls).toEqual([s.page.url]);
    expect(r.implementedAt).toBe('2026-09-12T07:00:00.000Z');
    expect(r.approvalConsumedNow).toBe(false); // consumed by the EXECUTE-mode export
    expect(r.preExecution).toEqual({ exported: true, exportDir: s.exportDir, recheck: 'unchanged', deployedWithoutExport: null });
    expect(r.verification.status).toBe('match');
    expect(r.beforeSnapshotRef).toMatch(/^crawl_result:/);
    expect(r.afterSnapshotRef).toMatch(/^raw:/);
    const pub = s.ctx.db.get<Record<string, unknown>>('SELECT * FROM publications WHERE id = ?', [r.publicationId])!;
    expect(pub).toMatchObject({ subject_type: 'experiment', subject_id: s.expId, approval_id: s.approvalId, implemented_at: '2026-09-12T07:00:00.000Z', source_revision: 'deploy-7', verified_live: 1, method: 'manual_export', export_path: s.exportDir });
    expect(JSON.parse(pub.verification_json as string).preExecution).toMatchObject({ exported: true, recheck: 'unchanged' });
    const rollback = JSON.parse(pub.rollback_json as string);
    expect(rollback.previous).toMatchObject({ title: 'Old Synthetic Title', metaDescription: 'Old synthetic description.' });
    expect(rollback.plan).toMatch(/Restore the previous title/);
    // After-snapshot is stored in the raw store.
    const stored = s.ctx.raw.load<{ html: string }>(r.afterSnapshotRef!);
    expect(stored?.html).toContain('Synthetic Widget Guide 2026');
    // Approval is now executed (one-time) and the experiment is observing from the actual time.
    expect(s.gate.get(s.approvalId)?.status).toBe('executed');
    const e = getExperiment(s.ctx.db, s.ctx.siteId, s.expId);
    expect(e).toMatchObject({ status: 'observing', observationStart: '2026-09-12T07:00:00.000Z', implementedAt: '2026-09-12T07:00:00.000Z', sourceRevision: 'deploy-7' });
    // Recording it again is refused.
    await expect(markImplemented(s.ctx, s.gate, { subjectType: 'experiment', subjectId: s.expId, implementedAt: '2026-09-12T08:00:00Z', revision: 'deploy-8', recordedBy: 'Alice' }, { fetcher })).rejects.toThrow(/already has a recorded implementation/);
  });

  it('compares every approved paragraph, records the coverage, and flags injected content (never "match" on a sample)', async () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: PROPOSE });
    const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
    const page = seedPage(ctx.db, ctx.siteId, { path: '/widgets' });
    const paras = Array.from({ length: 12 }, (_, i) => `Synthetic approved paragraph ${i + 1} describes the widget sizing guide in enough detail for this test.`);
    const rec = seedRecommendation(ctx.db, ctx.siteId, { pageId: page.id, actionType: 'content_rewrite', details: { proposedContentMarkdown: paras.join('\n\n') } });
    const r = await proposeFromRecommendation(ctx, gate, { recommendationId: rec, requestedBy: 'owner:Alice', sourceRevision: REVISION }, { targetChecker: stableChecker });
    ctx.clock.set(APPROVE);
    applyDecisionEffects(ctx.db, ctx.clock, gate.approve(ctx.siteId, r.approval.id, { approver: 'Alice', confirmHashPrefix: r.approval.artifactHash.slice(0, 12) }), 'owner:Alice');
    ctx.clock.set(EXPORT);
    await exportInExecuteMode(ctx, gate, 'experiment', r.experiment.id);
    ctx.clock.set(NOW);
    // Live: only 5 of the 12 approved paragraphs (the ones the old 5-fragment sampler looked at), plus an injected spam paragraph.
    const kept = [0, 2, 5, 8, 11].map((i) => `<p>${paras[i]}</p>`).join('');
    const live = htmlPage({ title: 'Widgets', description: 'D', body: `${kept}<p>Cheap synthetic pills available at spam.example.invalid, click now</p>` }).replace('<h1>Widgets</h1>', '');
    const impl = await markImplemented(ctx, gate, { subjectType: 'experiment', subjectId: r.experiment.id, implementedAt: '2026-09-12T10:00:00Z', revision: 'r1', recordedBy: 'Alice' }, { fetcher: fetcherReturning(live) });
    expect(impl.verification.status).toBe('partial');
    expect(impl.verification.coverage).toMatchObject({ scope: 'full', paragraphs: { total: 12, found: 5 }, unapproved: { status: 'found' } });
    expect(impl.verification.reason).toMatch(/^partial: 5\/12 paragraphs found, 1 unapproved block\(s\)/);
    expect(impl.warnings.join(' ')).toMatch(/not in the approved artifact \(possible unapproved or injected content\): "cheap synthetic pills/);
    const pub = ctx.db.get<{ verified_live: number; verification_json: string }>('SELECT verified_live, verification_json FROM publications')!;
    expect(pub.verified_live).toBe(0);
    expect(JSON.parse(pub.verification_json).coverage).toMatchObject({ paragraphs: { total: 12, found: 5 }, unapproved: { status: 'found' } });
    const audit = JSON.parse(ctx.db.get<{ details_json: string }>(`SELECT details_json FROM audit_events WHERE event_type = 'implementation.recorded'`)!.details_json);
    expect(audit.coverage).toEqual({ summary: expect.stringMatching(/^partial: 5\/12/), paragraphs: { total: 12, found: 5 }, unapproved: 'found' });
  });

  it('records a live mismatch instead of hiding it', async () => {
    const s = await setup();
    ctx = s.ctx;
    const wrong = htmlPage({ title: 'Something Else Entirely', description: 'A synthetic description for tests.' });
    const r = await markImplemented(s.ctx, s.gate, { subjectType: 'experiment', subjectId: s.expId, implementedAt: '2026-09-12T10:00:00Z', revision: 'r1', recordedBy: 'Alice' }, { fetcher: fetcherReturning(wrong) });
    expect(r.verification.status).toBe('partial');
    expect(r.verification.checks.find((c) => c.name === 'title')).toMatchObject({ pass: false, observed: 'Something Else Entirely' });
    expect(r.warnings.join(' ')).toMatch(/Live verification: partial/);
    const pub = s.ctx.db.get<{ verified_live: number; verification_json: string }>('SELECT verified_live, verification_json FROM publications')!;
    expect(pub.verified_live).toBe(0);
    expect(JSON.parse(pub.verification_json).status).toBe('partial');
  });

  it('offline: verification is honestly "unverified" and no after-snapshot is invented', async () => {
    const s = await setup();
    ctx = s.ctx;
    const r = await markImplemented(s.ctx, s.gate, { subjectType: 'experiment', subjectId: s.expId, implementedAt: '2026-09-12T10:00:00Z', revision: 'r1', recordedBy: 'Alice' });
    expect(r.verification.status).toBe('unverified');
    expect(r.verification.reason).toMatch(/offline/);
    expect(r.afterSnapshotRef).toBeNull();
    expect(s.ctx.db.get<{ verified_live: number }>('SELECT verified_live FROM publications')!.verified_live).toBe(0);
  });

  it('refuses when the approved artifact hash differs from the recorded change', async () => {
    const s = await setup({ exportIt: false });
    ctx = s.ctx;
    // Simulate an approval that was for a different artifact: invalidate and create one for another hash.
    s.gate.invalidate(s.ctx.siteId, s.approvalId, 'test: replaced', 'owner:Alice');
    const other = s.gate.request({ siteId: s.ctx.siteId, actionType: 'title_meta_change', target: s.page.url, subjectType: 'experiment', subjectId: s.expId, artifactHash: 'b'.repeat(64), sourceRevision: REVISION, summary: 'other', requestedBy: 'owner:Alice' });
    s.gate.approve(s.ctx.siteId, other.id, { approver: 'Alice', confirmHashPrefix: 'bbbbbbbbbbbb' });
    await expect(
      markImplemented(s.ctx, s.gate, { subjectType: 'experiment', subjectId: s.expId, implementedAt: '2026-09-14T08:00:00Z', revision: 'r1', recordedBy: 'Alice' }, { fetcher: fetcherReturning(matching) }),
    ).rejects.toThrow(/different artifact/);
  });
  it('an approval that expired before implementation must be re-requested (same exact hash) and re-approved', async () => {
    const s = await setup({ exportIt: false });
    ctx = s.ctx;
    s.ctx.clock.set('2026-09-19T10:00:00.000Z'); // 8 days after approval: the 7-day approval has expired unused
    await expect(
      markImplemented(s.ctx, s.gate, { subjectType: 'experiment', subjectId: s.expId, implementedAt: '2026-09-19T09:00:00Z', revision: 'r1', recordedBy: 'Alice' }, { fetcher: fetcherReturning(matching) }),
    ).rejects.toThrow(/is expired/);
    expect(s.gate.get(s.approvalId)?.status).toBe('expired');
    const again = await requestApprovalForSubject(s.ctx, s.gate, { subjectType: 'experiment', subjectId: s.expId, requestedBy: 'owner:Alice', sourceRevision: REVISION }, { targetChecker: stableChecker });
    expect(again.artifactHash).toBe(getExperiment(s.ctx.db, s.ctx.siteId, s.expId).changeHash);
    expect(again.approval.id).not.toBe(s.approvalId);
    s.gate.approve(s.ctx.siteId, again.approval.id, { approver: 'Alice', confirmHashPrefix: again.hashPrefix });
    await exportInExecuteMode(s.ctx, s.gate, 'experiment', s.expId);
    s.ctx.clock.set('2026-09-19T12:00:00.000Z');
    const r = await markImplemented(s.ctx, s.gate, { subjectType: 'experiment', subjectId: s.expId, implementedAt: '2026-09-19T11:00:00Z', revision: 'r2', recordedBy: 'Alice' }, { fetcher: fetcherReturning(matching) });
    expect(r.approvalId).toBe(again.approval.id);
    expect(r.experiment?.observationStart).toBe('2026-09-19T11:00:00.000Z');
  });

  it('a never-exported approval is refused unless the owner records a deployment without export in EXECUTE mode (recheck marked skipped)', async () => {
    const s = await setup({ exportIt: false });
    ctx = s.ctx;
    const base = { subjectType: 'experiment', subjectId: s.expId, implementedAt: '2026-09-12T10:00:00Z', revision: 'r1', recordedBy: 'Alice' };
    const f = { fetcher: fetcherReturning(matching) };
    await expect(markImplemented(s.ctx, s.gate, base, f)).rejects.toThrow(/was never exported/);
    // The explicit escape hatch still needs EXECUTE mode (it consumes a production approval without the export gate).
    await expect(markImplemented(s.ctx, s.gate, { ...base, deployedWithoutExport: 'Synthetic: deployed from the CMS directly' }, f)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(s.gate.get(s.approvalId)?.status).toBe('approved');
    expect(s.ctx.db.all('SELECT * FROM publications')).toHaveLength(0);
    s.ctx.mode = 'EXECUTE';
    const r = await markImplemented(s.ctx, s.gate, { ...base, deployedWithoutExport: 'Synthetic: deployed from the CMS directly' }, f);
    expect(r.approvalConsumedNow).toBe(true);
    expect(r.preExecution).toEqual({ exported: false, exportDir: null, recheck: 'skipped', deployedWithoutExport: 'Synthetic: deployed from the CMS directly' });
    expect(r.warnings.join(' ')).toMatch(/pre-execution target recheck was skipped/);
    expect(s.gate.detail(s.ctx.siteId, s.approvalId).execution).toMatchObject({ kind: 'mark_implemented_without_export', recheck: 'skipped' });
    expect(JSON.parse(s.ctx.db.get<{ verification_json: string }>('SELECT verification_json FROM publications')!.verification_json).preExecution.recheck).toBe('skipped');
  });

  it('one approval authorizes exactly one implementation record (drafts and recommendations too)', async () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: PROPOSE });
    const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
    const { draftId } = seedDraft(ctx.db, ctx.siteId);
    acceptDraftAsHuman(ctx, draftId);
    const req = await requestApprovalForSubject(ctx, gate, { subjectType: 'draft', subjectId: draftId, requestedBy: 'owner:Alice', sourceRevision: REVISION }, { targetChecker: stableChecker });
    ctx.clock.set(APPROVE);
    gate.approve(ctx.siteId, req.approval.id, { approver: 'Alice', confirmHashPrefix: req.hashPrefix });
    ctx.clock.set(EXPORT);
    await exportInExecuteMode(ctx, gate, 'draft', draftId);
    ctx.clock.set(NOW);
    const first = await markImplemented(ctx, gate, { subjectType: 'draft', subjectId: draftId, implementedAt: '2026-09-12T10:00:00Z', revision: 'cms-1', recordedBy: 'Alice' });
    expect(first.approvalId).toBe(req.approval.id);
    await expect(markImplemented(ctx, gate, { subjectType: 'draft', subjectId: draftId, implementedAt: '2026-09-13T10:00:00Z', revision: 'cms-2', recordedBy: 'Bob' })).rejects.toThrow(
      /already authorized publication/,
    );
    expect(ctx.db.all('SELECT * FROM publications')).toHaveLength(1);
    // The database refuses a second publication for the same approval as well.
    expect(() =>
      ctx!.db.run(
        `INSERT INTO publications (id, site_id, subject_type, subject_id, approval_id, url, method, implemented_at, recorded_by, created_at) VALUES ('pub_x', ?, 'draft', ?, ?, 'https://www.example.test/x', 'manual_export', ?, 'owner:Bob', ?)`,
        [ctx!.siteId, draftId, req.approval.id, NOW, NOW],
      ),
    ).toThrow(/one approval authorizes one implementation/);
  });

  it('an approval executed by something other than an export is not reusable for an implementation record', async () => {
    const s = await setup({ exportIt: false });
    ctx = s.ctx;
    s.gate.consume(s.approvalId, { kind: 'some_other_execution', actor: 'owner:Alice' });
    await expect(
      markImplemented(s.ctx, s.gate, { subjectType: 'experiment', subjectId: s.expId, implementedAt: '2026-09-12T10:00:00Z', revision: 'r1', recordedBy: 'Alice' }, { fetcher: fetcherReturning(matching) }),
    ).rejects.toThrow(/was already used \(some_other_execution/);
  });
});
