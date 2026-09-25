import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appDirs, siteVaultDir } from '../../../src/config/paths.js';
import { importBusinessNotes, parseBusinessNote, resolveDecisionSubjects } from '../../../src/obsidian/business-sync.js';
import { isRejectingDecision, loadPriorContext } from '../../../src/seo/recommend.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

/**
 * The owner-decision syntax documented in vault/_template/01 Business/Owner
 * Decisions.md must match what the importer (src/obsidian/business-sync.ts)
 * and the recommendation exclusion (src/seo/recommend.ts) actually do.
 * SYNTHETIC: example.test hosts and fixture ids only.
 */

const TEMPLATE = path.join(appDirs.vaultTemplate(), '01 Business', 'Owner Decisions.md');
const template = () => readFileSync(TEMPLATE, 'utf8');
const HOST = 'https://www.example.test';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

function seedPageAndOpportunity(c: TestContext): { pageId: string; oppId: string } {
  const now = c.clock.now().toISOString();
  const pageId = 'page_01JSYNTHPRICING';
  const oppId = 'opp_01JSYNTHRELAUNCH';
  c.db.run(
    `INSERT INTO pages (id, site_id, url, host, path, first_source, is_protected, is_excluded, lifecycle, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'www.example.test', '/pricing', 'fixture', 0, 0, 'active', ?, ?)`,
    [pageId, c.siteId, `${HOST}/pricing`, now, now],
  );
  c.db.run(`INSERT INTO opportunities (id, site_id, kind, route, page_id, status, created_at, updated_at) VALUES (?, ?, 'page', 'CTR_OPPORTUNITY', ?, 'candidate', ?, ?)`, [oppId, c.siteId, pageId, now, now]);
  return { pageId, oppId };
}

/** The indented example bullets inside the template's comment, with placeholders filled for the synthetic site. */
function documentedExamples(oppId: string): string[] {
  return template()
    .split('\n')
    .filter((l) => /^\s{2,}- \d{4}-\d{2}-\d{2}: /.test(l))
    .map((l) => l.trim().replace(/https:\/\/<own-site>/g, HOST).replace(/opp_01J\.\.\./g, oppId));
}

describe('Owner Decisions template documents the importer syntax exactly', () => {
  it('the template itself is a valid owner_decisions note with no decisions (the documentation is inside a comment)', () => {
    const p = parseBusinessNote('01 Business/Owner Decisions.md', template().replace('{{site_id}}', 'test-site'), { siteId: 'test-site' });
    expect(p.errors).toEqual([]);
    expect(p.valid).toBe(true);
    expect(p.noteType).toBe('owner_decisions');
    expect(p.data).toMatchObject({ decisions: [] });
  });

  it('the documented examples import as rejecting decisions on the named page and opportunity', () => {
    ctx = createTestContext();
    const { pageId, oppId } = seedPageAndOpportunity(ctx);
    const examples = documentedExamples(oppId);
    expect(examples).toHaveLength(2);
    const dir = path.join(siteVaultDir(ctx.paths, ctx.siteId), '01 Business');
    mkdirSync(dir, { recursive: true });
    const note = template().replace('{{site_id}}', ctx.siteId).replace(/## Decisions\s*$/, `## Decisions\n\n${examples.join('\n')}\n`);
    writeFileSync(path.join(dir, 'Owner Decisions.md'), note);
    const r = importBusinessNotes(ctx, { apply: true, actor: 'owner:test' });
    expect(r.rejected).toBe(0);
    const rows = ctx.db.all<{ subject_type: string; subject_id: string; decision: string; decided_at: string; decided_by: string }>('SELECT subject_type, subject_id, decision, decided_at, decided_by FROM decisions WHERE site_id = ? ORDER BY subject_type', [ctx.siteId]);
    expect(rows.map((x) => [x.subject_type, x.subject_id])).toEqual([
      ['opportunity', oppId],
      ['page', pageId],
    ]);
    for (const row of rows) {
      expect(isRejectingDecision(row.decision)).toBe(true);
      expect(row.decided_by).toBe('owner');
      expect(row.decided_at).toBe('2026-09-01T00:00:00.000Z');
    }
  });

  it('subjects: an own-site URL (trailing punctuation dropped), page_ and opp_ ids; off-site URLs and queries alone are site-wide', () => {
    ctx = createTestContext();
    const { pageId, oppId } = seedPageAndOpportunity(ctx);
    const site = { subjectType: 'site', subjectId: ctx.siteId };
    expect(resolveDecisionSubjects(ctx, `reject ${HOST}/pricing: we keep the current copy`)).toEqual([{ subjectType: 'page', subjectId: pageId }]);
    // An unknown page on the site: the normalized URL is the subject.
    expect(resolveDecisionSubjects(ctx, `skip ${HOST}/not-yet-crawled.`)).toEqual([{ subjectType: 'url', subjectId: `${HOST}/not-yet-crawled` }]);
    expect(resolveDecisionSubjects(ctx, `defer ${pageId} and ${oppId}`)).toEqual([
      { subjectType: 'page', subjectId: pageId },
      { subjectType: 'opportunity', subjectId: oppId },
    ]);
    // Ids that do not exist for this site are not subjects.
    expect(resolveDecisionSubjects(ctx, 'reject page_01JDOESNOTEXIST')).toEqual([site]);
    // A host that is not in site.allowedHostnames is off-site (also a host variant without www).
    expect(resolveDecisionSubjects(ctx, 'reject https://rival.example.test/pricing: competitor')).toEqual([site]);
    expect(resolveDecisionSubjects(ctx, 'reject https://example.test/pricing')).toEqual([site]);
    // Queries are never subjects.
    expect(resolveDecisionSubjects(ctx, 'reject the query "pricing software": not our audience')).toEqual([site]);
  });

  it('every rejecting word the template lists excludes; the same words later in the sentence do not', () => {
    const t = template();
    const words = ['reject', 'rejected', 'declined', 'deny', 'denied', 'dismiss', 'dismissed', 'defer', 'deferred', 'skip', 'skipped', 'no action', 'no_action', 'no-action', "won't", 'wont', "won't do", 'wont_do', 'not now', 'not_now', 'not-now'];
    for (const w of words) {
      expect(t).toContain(w);
      expect(isRejectingDecision(`${w} ${HOST}/pricing: reason`)).toBe(true);
      expect(isRejectingDecision(`${w.toUpperCase()} ${HOST}/pricing`)).toBe(true);
    }
    // Documented exception: "decline" followed by more text is not a rejecting decision.
    expect(t).toContain('Write "declined", not "decline"');
    expect(isRejectingDecision(`decline ${HOST}/pricing: reason`)).toBe(false);
    expect(t).toContain('"approved: investigate the traffic decline" is not a rejection');
    expect(isRejectingDecision('approved: investigate the traffic decline')).toBe(false);
  });

  it('documents that decisions in this note apply whatever their age until the bullet is deleted; only approval/rejection decisions use the 180-day window (NF-05)', () => {
    const t = template().replace(/\s+/g, ' ');
    expect(t).toContain('a decision in this note applies whatever its age (the date in the bullet does not make it expire) until you delete the bullet.');
    expect(t).toContain('A deleted bullet is withdrawn on the next `npm run cli -- vault import-business --apply`');
    expect(t).toContain('Only decisions recorded from approvals or rejections');
    expect(t).toContain('use the 180-day window');
    // The stale rule (every owner decision expires after 180 days) is gone.
    expect(t).not.toMatch(/recommendation step considers decisions from the last 180 days/);
  });

  it('the weekly recommendation step: decisions from this note apply whatever their age; approval/rejection decisions use the last 180 days, as documented', async () => {
    ctx = createTestContext();
    const { pageId, oppId } = seedPageAndOpportunity(ctx);
    // Decisions recorded from approvals or rejections (vault_path NULL): the 180-day window.
    const insert = (id: string, date: string) =>
      ctx!.db.run(`INSERT INTO decisions (id, site_id, subject_type, subject_id, decision, decided_by, decided_at) VALUES (?, ?, 'page', ?, 'reject', 'owner', ?)`, [id, ctx!.siteId, pageId, `${date}T00:00:00.000Z`]);
    insert('dec_inside', '2026-03-29'); // 180 days before 2026-09-25
    insert('dec_outside', '2026-03-28');
    // A standing decision imported from the note two years ago (vault_path set): still applies.
    const dir = path.join(siteVaultDir(ctx.paths, ctx.siteId), '01 Business');
    mkdirSync(dir, { recursive: true });
    const withBullet = (bullets: string[]) => template().replace('{{site_id}}', ctx!.siteId).replace(/## Decisions\s*$/, `## Decisions\n\n${bullets.join('\n')}\n`);
    writeFileSync(path.join(dir, 'Owner Decisions.md'), withBullet([`- 2024-09-01: defer ${oppId}: revisit after the relaunch`]));
    expect(importBusinessNotes(ctx, { apply: true, actor: 'owner:test' }).rejected).toBe(0);
    const vaultDecision = ctx.db.get<{ id: string; vault_path: string | null; decided_at: string }>('SELECT id, vault_path, decided_at FROM decisions WHERE site_id = ? AND subject_type = ? AND subject_id = ?', [ctx.siteId, 'opportunity', oppId])!;
    expect(vaultDecision.vault_path).toBe('01 Business/Owner Decisions.md');
    expect(vaultDecision.decided_at).toBe('2024-09-01T00:00:00.000Z');

    const prior = await loadPriorContext(ctx.db, ctx.siteId, { today: '2026-09-25' });
    expect(prior.decisions.map((d) => d.id).sort()).toEqual(['dec_inside', vaultDecision.id].sort());

    // Deleting the bullet withdraws the decision on the next --apply.
    writeFileSync(path.join(dir, 'Owner Decisions.md'), withBullet([]));
    expect(importBusinessNotes(ctx, { apply: true, actor: 'owner:test' }).rejected).toBe(0);
    const after = await loadPriorContext(ctx.db, ctx.siteId, { today: '2026-09-25' });
    expect(after.decisions.map((d) => d.id)).toEqual(['dec_inside']);
  });
});
