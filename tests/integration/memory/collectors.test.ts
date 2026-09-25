import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '../../../src/core/hash.js';
import { collectBusinessNotes, ingestAll } from '../../../src/memory/collectors.js';
import { ingestDocument } from '../../../src/memory/documents.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { installFixtureVault, memoryConfig } from '../../fixtures/memory/setup.js';
import { seedRecords } from '../../fixtures/memory/seed.js';

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

const T = '2026-09-20T10:00:00.000Z';

describe('memory collectors', () => {
  it('ingests business notes: human text only, frontmatter cannot grant trust, validated imports are owner_approved', () => {
    ctx = createTestContext({ config: memoryConfig() });
    const vault = installFixtureVault(ctx);
    let set = collectBusinessNotes(ctx);
    expect(set.complete).toBe(true);
    const offer = set.documents.find((d) => d.sourceRef === '01 Business/Offer.md')!;
    expect(offer.title).toBe('Offer');
    expect(offer.language).toBe('en');
    expect(offer.sourceDate).toBe('2026-09-01');
    expect(offer.text).not.toContain('Generated metrics summary');
    expect(offer.trustClass).toBe('user_reported'); // `approved: true` / `trust: owner_approved` in frontmatter is ignored

    const raw = readFileSync(path.join(vault, '01 Business', 'Offer.md'), 'utf8');
    ctx.db.run(`INSERT INTO business_note_versions (id, site_id, note_path, content_hash, status, imported_at) VALUES ('bnv1', ?, '01 Business/Offer.md', ?, 'imported', ?)`, [ctx.siteId, sha256(raw), T]);
    set = collectBusinessNotes(ctx);
    expect(set.documents.find((d) => d.sourceRef === '01 Business/Offer.md')!.trustClass).toBe('owner_approved');
    expect(set.documents.find((d) => d.sourceRef === '01 Business/Pricing.md')!.trustClass).toBe('user_reported');
  });

  it('reports a missing vault folder without deleting existing business-note documents', () => {
    ctx = createTestContext({ config: memoryConfig() });
    installFixtureVault(ctx);
    ingestAll(ctx);
    rmSync(path.join(ctx.paths.vaultRoot, ctx.siteId, '01 Business'), { recursive: true, force: true });
    const s = ingestAll(ctx);
    expect(s.notes.join(' ')).toMatch(/Vault folder not found/);
    expect(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM memory_documents WHERE source_type = 'business_note' AND status = 'active'`)!.n).toBe(3);
  });

  it('collects every record type with correct trust, status, and record status; never metric sources', () => {
    ctx = createTestContext({ config: memoryConfig() });
    installFixtureVault(ctx);
    seedRecords(ctx);
    const s = ingestAll(ctx);
    expect(s.rejected).toEqual([]);
    const docs = ctx.db.all<{ source_type: string; source_ref: string; trust_class: string; status: string; record_status: string | null }>(
      'SELECT source_type, source_ref, trust_class, status, record_status FROM memory_documents WHERE site_id = ? ORDER BY source_ref',
      [ctx.siteId],
    );
    const by = Object.fromEntries(docs.map((d) => [d.source_ref, d]));
    expect(by['evidence:ev1']).toMatchObject({ source_type: 'source_excerpt', trust_class: 'scraped_untrusted' });
    expect(by['evidence:ev2']).toBeUndefined(); // GSC metric source never embedded
    expect(by['competitor_change:cc1']).toMatchObject({ source_type: 'competitor_finding', trust_class: 'scraped_untrusted' });
    expect(by['content_brief:ci1']).toMatchObject({ source_type: 'brief', trust_class: 'synthetic', status: 'active', record_status: 'approved' });
    expect(by['recommendation:rec1']).toMatchObject({ source_type: 'rejected_proposal', status: 'rejected', record_status: 'rejected' });
    expect(by['content_item:ci2']).toMatchObject({ source_type: 'rejected_proposal', status: 'rejected' });
    expect(by['experiment:exp1']).toMatchObject({ source_type: 'experiment_summary', trust_class: 'first_party_measurement', record_status: 'negative' });
    expect(by['learning:l1']).toMatchObject({ source_type: 'approved_learning', trust_class: 'owner_approved' });
    expect(by['learning:l2']).toBeUndefined();
    expect(by['decision:dec1']).toMatchObject({ source_type: 'decision', trust_class: 'owner_approved' });
    const recText = ctx.db.get<{ text: string }>(`SELECT group_concat(c.text, ' ') AS text FROM memory_chunks c JOIN memory_documents d ON d.id = c.document_id WHERE d.source_ref = 'recommendation:rec1'`)!.text;
    expect(recText).toMatch(/REJECTED/);
    expect(recText).toMatch(/Brand does not compete on being cheap/);
    const briefText = ctx.db.get<{ text: string }>(`SELECT group_concat(c.text, ' ') AS text FROM memory_chunks c JOIN memory_documents d ON d.id = c.document_id WHERE d.source_ref = 'content_brief:ci1'`)!.text;
    expect(briefText).toContain('compact storage'); // latest version only
    expect(briefText).not.toContain('old angle');
  });

  it('is idempotent and propagates deletions of notes and records', () => {
    ctx = createTestContext({ config: memoryConfig() });
    const vault = installFixtureVault(ctx);
    seedRecords(ctx);
    ingestAll(ctx);
    const again = ingestAll(ctx);
    expect(Object.values(again.bySourceType).every((x) => x.created === 0 && x.newVersion === 0 && x.deleted === 0)).toBe(true);

    rmSync(path.join(vault, '01 Business', 'Audience.md'));
    writeFileSync(path.join(vault, '01 Business', 'Pricing.md'), '# Pricing\n\nThe starter organizer is now 55 EUR (synthetic).\n');
    ctx.db.run(`UPDATE learnings SET status = 'rejected' WHERE id = 'l1'`);
    const dry = ingestAll(ctx, { dryRun: true });
    expect(dry.bySourceType.business_note).toMatchObject({ newVersion: 1, deleted: 1 });
    expect(ctx.db.get<{ status: string }>(`SELECT status FROM memory_documents WHERE source_ref = '01 Business/Audience.md'`)!.status).toBe('active');
    const s = ingestAll(ctx);
    expect(s.bySourceType.business_note).toMatchObject({ newVersion: 1, deleted: 1 });
    expect(s.bySourceType.approved_learning).toMatchObject({ deleted: 1 });
    expect(ctx.db.get<{ status: string }>(`SELECT status FROM memory_documents WHERE source_ref = '01 Business/Audience.md'`)!.status).toBe('deleted');
    expect(ctx.db.get<{ version: number }>(`SELECT version FROM memory_documents WHERE source_ref = '01 Business/Pricing.md'`)!.version).toBe(2);
  });

  it('rejects a note that contains a secret and reports it without the value', () => {
    ctx = createTestContext({ config: memoryConfig() });
    const vault = installFixtureVault(ctx);
    writeFileSync(path.join(vault, '01 Business', 'Leaky.md'), '# Access\n\nThe apify token is apify_api_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 (synthetic).\n');
    const s = ingestAll(ctx);
    expect(s.rejected).toHaveLength(1);
    expect(s.rejected[0]).toMatchObject({ sourceRef: '01 Business/Leaky.md', reason: 'secret_detected' });
    expect(JSON.stringify(s)).not.toContain('apify_api_ABCDEF');
    expect(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM memory_chunks WHERE text LIKE '%apify_api_%'`)!.n).toBe(0);
  });
  it('synthetic (demo) workspace: every collected document is labelled synthetic, never owner-approved or measured', () => {
    ctx = createTestContext({ config: memoryConfig({ profile: 'demo' }) });
    expect(ctx.synthetic).toBe(true);
    const vault = installFixtureVault(ctx);
    seedRecords(ctx);
    const raw = readFileSync(path.join(vault, '01 Business', 'Offer.md'), 'utf8');
    ctx.db.run(`INSERT INTO business_note_versions (id, site_id, note_path, content_hash, status, imported_at) VALUES ('bnv1', ?, '01 Business/Offer.md', ?, 'imported', ?)`, [ctx.siteId, sha256(raw), T]);
    const s = ingestAll(ctx);
    expect(s.notes.join(' ')).toMatch(/Synthetic \(demo\) workspace/);
    const docs = ctx.db.all<{ source_ref: string; trust_class: string; record_status: string | null }>('SELECT source_ref, trust_class, record_status FROM memory_documents WHERE site_id = ?', [ctx.siteId]);
    expect(docs.length).toBeGreaterThan(5);
    expect(docs.every((d) => d.trust_class === 'synthetic')).toBe(true);
    // Record statuses (e.g. a negative experiment) are still kept.
    expect(docs.find((d) => d.source_ref === 'experiment:exp1')!.record_status).toBe('negative');
    // Direct ingestion is labelled too.
    const direct = ingestDocument(ctx, { sourceType: 'decision', sourceRef: 'manual:x', title: 'X', text: 'Demo decision (synthetic).', trustClass: 'owner_approved' });
    expect(ctx.db.get<{ trust_class: string }>('SELECT trust_class FROM memory_documents WHERE id = ?', [direct.documentId])!.trust_class).toBe('synthetic');
  });

  it('never ingests vault conflict artifacts (the human note is the source of truth)', () => {
    ctx = createTestContext({ config: memoryConfig() });
    const vault = installFixtureVault(ctx);
    writeFileSync(path.join(vault, '01 Business', 'Pricing.conflict-20260920T101500Z.md'), '# Pricing\n\nA generated version that conflicts with the human note (synthetic).\n');
    const set = collectBusinessNotes(ctx);
    expect(set.documents.map((d) => d.sourceRef)).not.toContain('01 Business/Pricing.conflict-20260920T101500Z.md');
    expect(set.documents).toHaveLength(3);
    expect(set.notes!.join(' ')).toMatch(/1 vault conflict artifact/);
    const s = ingestAll(ctx);
    expect(s.bySourceType.business_note!.collected).toBe(3);
    expect(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM memory_documents WHERE source_ref LIKE '%.conflict-%'`)!.n).toBe(0);
  });

  it('a truncated business-note scan is reported incomplete and deletes nothing', () => {
    ctx = createTestContext({ config: memoryConfig() });
    installFixtureVault(ctx);
    ingestAll(ctx);
    const set = collectBusinessNotes(ctx, { maxBusinessNotes: 2 });
    expect(set.complete).toBe(false);
    expect(set.documents).toHaveLength(2);
    expect(set.notes!.join(' ')).toMatch(/more than 2 notes/);
    const s = ingestAll(ctx, { maxBusinessNotes: 2 });
    expect(s.bySourceType.business_note!.deleted).toBe(0);
    expect(s.notes.join(' ')).toMatch(/deletion propagation was skipped/);
    expect(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM memory_documents WHERE source_type = 'business_note' AND status = 'active'`)!.n).toBe(3);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM memory_tombstones')!.n).toBe(0);
  });

  it('deletion propagation only touches collector-owned namespaces', () => {
    ctx = createTestContext({ config: memoryConfig() });
    installFixtureVault(ctx);
    ingestDocument(ctx, { sourceType: 'decision', sourceRef: 'manual:owner-call-notes', title: 'Owner call', text: 'Decided to pause ads (synthetic).', trustClass: 'owner_approved' });
    ingestDocument(ctx, { sourceType: 'decision', sourceRef: 'decision:dec_missing', title: 'Stale', text: 'A decision whose row is gone (synthetic).', trustClass: 'owner_approved' });
    const s = ingestAll(ctx);
    expect(s.bySourceType.decision!.deleted).toBe(1);
    const status = (ref: string) => ctx.db.get<{ status: string }>('SELECT status FROM memory_documents WHERE source_ref = ?', [ref])!.status;
    expect(status('manual:owner-call-notes')).toBe('active');
    expect(status('decision:dec_missing')).toBe('deleted');
  });
});
