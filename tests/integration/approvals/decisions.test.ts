/**
 * Owner decisions end to end, with NO seeded `decisions` rows (SYNTHETIC data,
 * example.test domains): a human approve/reject writes a decision row, the
 * vault renders it (12 Decisions + page links), and a standing decision in the
 * human-maintained "01 Business/Owner Decisions.md" note is imported into
 * `decisions` and excludes the matching candidate from recommendations.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDecisionEffects } from '../../../src/approvals/effects.js';
import { requestApprovalForSubject } from '../../../src/approvals/requests.js';
import { ApprovalService } from '../../../src/approvals/service.js';
import { siteVaultDir } from '../../../src/config/paths.js';
import { importBusinessNotes, resolveDecisionSubjects } from '../../../src/obsidian/business-sync.js';
import { renderAll } from '../../../src/obsidian/notes.js';
import { createVaultWriter } from '../../../src/obsidian/writer.js';
import { assembleRecommendation, loadPriorContext, type CandidateOpportunity } from '../../../src/seo/recommend.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { experimentsSiteConfig, seedPage, seedRecommendation } from '../../fixtures/experiments/seed.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const NOW = '2026-09-20T09:00:00.000Z';
const fp = { async fingerprint() { return { ok: true as const, fingerprint: 'synthetic-fp', checkedAt: NOW, detail: 'test' }; } };

function cand(pageId: string, url: string, id: string): CandidateOpportunity {
  return {
    id,
    route: 'CTR_OPPORTUNITY',
    pageId,
    url,
    query: null,
    isBranded: false,
    score: 70,
    scoringVersion: 'scoring@1.0.0',
    rawCounts: { impressions: 5000, clicks: 100, position: 5, sessions: 500, convertingSessions: 10 },
    evidenceQuality: 0.9,
    reasons: [{ code: 'QUERY_POSITION_IN_RANGE', detail: 'synthetic' }],
    isProtected: false,
    periodStart: '2026-08-24',
    periodEnd: '2026-09-20',
    synthetic: true,
  };
}

function notesIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
}

describe('owner decisions are recorded, rendered, and respected (no seeded decisions)', () => {
  it('approve/reject -> decisions rows -> vault notes -> owner-decision note excludes the candidate in recommend', async () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: NOW });
    const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM decisions')!.n).toBe(0);
    const widgets = seedPage(ctx.db, ctx.siteId, { path: '/widgets' });
    const pricing = seedPage(ctx.db, ctx.siteId, { path: '/pricing' });

    // 1. A human approves one proposal and rejects another.
    const recA = seedRecommendation(ctx.db, ctx.siteId, { pageId: widgets.id });
    const recB = seedRecommendation(ctx.db, ctx.siteId, { pageId: pricing.id });
    const reqA = await requestApprovalForSubject(ctx, gate, { subjectType: 'recommendation', subjectId: recA, requestedBy: 'owner:Alice', sourceRevision: 'site@1' }, { targetChecker: fp });
    const reqB = await requestApprovalForSubject(ctx, gate, { subjectType: 'recommendation', subjectId: recB, requestedBy: 'owner:Alice', sourceRevision: 'site@1' }, { targetChecker: fp });
    applyDecisionEffects(ctx.db, ctx.clock, gate.approve(ctx.siteId, reqA.approval.id, { approver: 'Alice', confirmHashPrefix: reqA.hashPrefix, note: 'clear improvement' }), 'owner:Alice');
    applyDecisionEffects(ctx.db, ctx.clock, gate.reject(ctx.siteId, reqB.approval.id, { approver: 'Bob', reason: 'pricing copy is owned by legal' }), 'owner:Bob');

    const rows = ctx.db.all<{ subject_type: string; subject_id: string; decision: string; reason: string | null; decided_by: string }>(
      'SELECT subject_type, subject_id, decision, reason, decided_by FROM decisions ORDER BY decision',
    );
    expect(rows).toEqual([
      { subject_type: 'recommendation', subject_id: recA, decision: 'approved', reason: 'clear improvement', decided_by: 'owner:Alice' },
      { subject_type: 'recommendation', subject_id: recB, decision: 'rejected', reason: 'pricing copy is owned by legal', decided_by: 'owner:Bob' },
    ]);

    // 2. The vault renders them: 12 Decisions notes and a decision link on the page note (not "none").
    const writer = createVaultWriter(ctx);
    const rendered = renderAll(ctx, writer);
    expect(rendered.errors).toEqual([]);
    const decisionNotes = notesIn(path.join(writer.vaultDir, '12 Decisions'));
    expect(decisionNotes).toHaveLength(2);
    const texts = decisionNotes.map((f) => readFileSync(path.join(writer.vaultDir, '12 Decisions', f), 'utf8'));
    expect(texts.some((t) => /Decision: \*\*rejected\*\*/.test(t) && /owner:Bob/.test(t) && /pricing copy is owned by legal/.test(t))).toBe(true);
    const pageNote = notesIn(path.join(writer.vaultDir, '02 Website', 'Pages'))
      .map((f) => readFileSync(path.join(writer.vaultDir, '02 Website', 'Pages', f), 'utf8'))
      .find((t) => t.includes(pricing.url));
    expect(pageNote).toBeDefined();
    expect(pageNote).toMatch(/- Decisions: \[\[/);

    // 3. A standing owner decision in the human-maintained business note.
    const businessDir = path.join(siteVaultDir(ctx.paths, ctx.siteId), '01 Business');
    mkdirSync(businessDir, { recursive: true });
    const note = (entries: string[]) =>
      writeFileSync(
        path.join(businessDir, 'Owner Decisions.md'),
        ['---', 'id: owner-decisions', 'type: owner_decisions', `site: ${ctx!.siteId}`, 'approved: true', '---', '# Owner Decisions', '', '## Decisions', '', ...entries.map((e) => `- ${e}`), ''].join('\n'),
      );
    note([
      `2026-09-15: reject ${widgets.url}: the owner keeps the current widget page copy this quarter.`,
      '2026-09-01: We do not target competitor brand queries.',
      '2026-09-02: skip https://elsewhere.example.invalid/page (not our site).',
    ]);
    const imported = importBusinessNotes(ctx, { apply: true, actor: 'owner:Alice' });
    expect(imported.rejected).toBe(0);
    const item = imported.notes.find((n) => n.relPath === '01 Business/Owner Decisions.md')!;
    expect(item.ownerDecisions).toEqual({ rows: 3, inserted: 3, withdrawn: 0, siteWide: 2 });
    const owner = ctx.db.all<{ subject_type: string; subject_id: string; decided_by: string; vault_path: string; decided_at: string }>(
      `SELECT subject_type, subject_id, decided_by, vault_path, decided_at FROM decisions WHERE decided_by = 'owner' ORDER BY decided_at`,
    );
    expect(owner).toEqual([
      { subject_type: 'site', subject_id: ctx.siteId, decided_by: 'owner', vault_path: '01 Business/Owner Decisions.md', decided_at: '2026-09-01T00:00:00.000Z' },
      { subject_type: 'site', subject_id: ctx.siteId, decided_by: 'owner', vault_path: '01 Business/Owner Decisions.md', decided_at: '2026-09-02T00:00:00.000Z' },
      { subject_type: 'page', subject_id: widgets.id, decided_by: 'owner', vault_path: '01 Business/Owner Decisions.md', decided_at: '2026-09-15T00:00:00.000Z' },
    ]);
    // The "approved: true" property authorizes nothing; it is only reported.
    expect(item.ignoredAuthorityKeys).toEqual(['approved']);
    // Idempotent per note revision: importing the same note again adds nothing.
    const again = importBusinessNotes(ctx, { apply: true, actor: 'owner:Alice' });
    expect(again.notes.find((n) => n.relPath === '01 Business/Owner Decisions.md')!.ownerDecisions).toEqual({ rows: 3, inserted: 0, withdrawn: 0, siteWide: 2 });
    expect(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM decisions WHERE decided_by = 'owner'`)!.n).toBe(3);

    // 4. recommend: the owner decision excludes the widget page candidate (subject matches the page id).
    const prior = await loadPriorContext(ctx.db, ctx.siteId, { today: '2026-09-20' });
    const set = assembleRecommendation(ctx.siteId, {
      candidates: [cand(widgets.id, widgets.url, 'opp_widgets'), cand(pricing.id, pricing.url, 'opp_pricing')],
      siteDecision: null,
      prior,
      today: '2026-09-20',
      reviewDays: 28,
      lowTrafficReviewDays: 56,
    });
    const excluded = set.excluded.find((x) => x.pageId === widgets.id);
    expect(excluded?.reason).toMatch(/owner decision "reject https:\/\/www\.example\.test\/widgets: the owner keeps the current widget page copy/);
    expect(set.primary.pageId).not.toBe(widgets.id);

    // 5. The owner removes the entry: the next import withdraws it and the candidate is no longer excluded.
    note(['2026-09-01: We do not target competitor brand queries.']);
    const withdrawn = importBusinessNotes(ctx, { apply: true, actor: 'owner:Alice' });
    expect(withdrawn.notes.find((n) => n.relPath === '01 Business/Owner Decisions.md')!.ownerDecisions).toMatchObject({ rows: 1, inserted: 0, withdrawn: 2 });
    expect(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'vault.owner_decision_withdrawn'`)!.n).toBe(2);
    const prior2 = await loadPriorContext(ctx.db, ctx.siteId, { today: '2026-09-20' });
    const set2 = assembleRecommendation(ctx.siteId, { candidates: [cand(widgets.id, widgets.url, 'opp_widgets')], siteDecision: null, prior: prior2, today: '2026-09-20', reviewDays: 28, lowTrafficReviewDays: 56 });
    expect(set2.excluded.filter((x) => x.pageId === widgets.id)).toEqual([]);
  });

  it('resolves decision subjects to what recommend compares: page id, normalized URL, opportunity id; off-site URLs are ignored', () => {
    ctx = createTestContext({ config: experimentsSiteConfig(), now: NOW });
    const page = seedPage(ctx.db, ctx.siteId, { path: '/widgets' });
    ctx.db.run(
      `INSERT INTO opportunities (id, site_id, kind, route, page_id, status, created_at, updated_at) VALUES ('opp_SYNTHETIC1', ?, 'page', 'CTR_OPPORTUNITY', ?, 'candidate', ?, ?)`,
      [ctx.siteId, page.id, NOW, NOW],
    );
    expect(resolveDecisionSubjects(ctx, 'reject HTTPS://WWW.EXAMPLE.TEST/widgets#top.')).toEqual([{ subjectType: 'page', subjectId: page.id }]);
    expect(resolveDecisionSubjects(ctx, 'defer https://www.example.test/unknown-page?utm_source=x')).toEqual([{ subjectType: 'url', subjectId: 'https://www.example.test/unknown-page' }]);
    expect(resolveDecisionSubjects(ctx, `no action on ${page.id} and opp_SYNTHETIC1; ignore opp_missing`)).toEqual([
      { subjectType: 'page', subjectId: page.id },
      { subjectType: 'opportunity', subjectId: 'opp_SYNTHETIC1' },
    ]);
    expect(resolveDecisionSubjects(ctx, 'reject https://competitor.example.invalid/page')).toEqual([{ subjectType: 'site', subjectId: ctx.siteId }]);
  });
});
