import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkVault } from '../../../src/obsidian/check.js';
import { parseNote } from '../../../src/obsidian/frontmatter.js';
import { renderAll } from '../../../src/obsidian/notes.js';
import { STALE_BANNER_TITLE, STALE_CONTENT_HEADING } from '../../../src/obsidian/stale.js';
import { GENERATED_END } from '../../../src/obsidian/types.js';
import { createVaultWriter } from '../../../src/obsidian/writer.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { SEED_IDS, seedSyntheticVaultData } from '../../fixtures/obsidian/seed.js';

/** SYNTHETIC vault data (tests/fixtures/obsidian/seed.ts): stale generated notes when their record disappears. */

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const KEYWORD_NOTE = '03 Keywords/pricing software.md';
const DECISION_NOTE = '12 Decisions/2026-09-20 Start the pricing title test.md';

function setup() {
  ctx = createTestContext();
  seedSyntheticVaultData(ctx.db, ctx.siteId);
  const writer = createVaultWriter(ctx);
  const abs = (rel: string) => path.join(writer.vaultDir, ...rel.split('/'));
  const read = (rel: string) => readFileSync(abs(rel), 'utf8');
  const first = renderAll(ctx, writer);
  expect(first.errors).toEqual([]);
  expect(first.stale).toEqual([]);
  return { ctx, writer, abs, read };
}

/** Simulate migration 0203 merging a keyword away (the row is deleted; dependents cascade). */
function mergeKeywordAway(c: TestContext): void {
  c.db.run('DELETE FROM keywords WHERE site_id = ? AND id = ?', [c.siteId, SEED_IDS.keyword]);
  expect(c.db.get('SELECT 1 AS x FROM keywords WHERE id = ?', [SEED_IDS.keyword])).toBeUndefined();
}

function addHumanText(abs: string, text: string): void {
  writeFileSync(abs, `${readFileSync(abs, 'utf8')}\n${text}\n`);
}

describe('vault render marks notes stale when their record no longer exists', () => {
  it('marks the note stale in place (status + banner), keeps human text and the last content, and is idempotent', () => {
    const { ctx, writer, abs, read } = setup();
    const before = parseNote(read(KEYWORD_NOTE));
    expect(before.frontmatter.status).toBeUndefined();
    addHumanText(abs(KEYWORD_NOTE), 'My own research notes about this keyword (human).');
    mergeKeywordAway(ctx);

    const r = renderAll(ctx, writer);
    expect(r.errors).toEqual([]);
    expect(r.stale).toEqual([expect.objectContaining({ relPath: KEYWORD_NOTE, noteId: SEED_IDS.keyword, kind: 'keyword', status: 'updated' })]);
    expect(r.detail).toContain('1 stale note(s) (record no longer exists)');

    const raw = read(KEYWORD_NOTE);
    const after = parseNote(raw);
    expect(after.frontmatter).toMatchObject({ id: SEED_IDS.keyword, type: 'keyword', status: 'stale', title: before.frontmatter.title });
    expect(String(after.frontmatter.stale_reason)).toContain(`keyword record ${SEED_IDS.keyword} no longer exists`);
    expect(after.frontmatter.last_generated_at).toBe(before.frontmatter.generated_at);
    expect(after.frontmatter.tags).toEqual(expect.arrayContaining(['seo-agent/keyword', 'seo-agent/stale']));
    // Generated properties that described the deleted record are gone.
    for (const k of Object.keys(before.frontmatter)) {
      if (['id', 'type', 'site', 'generated_at', 'source_ids', 'title', 'tags', 'synthetic'].includes(k)) continue;
      expect(after.frontmatter).not.toHaveProperty(k);
    }
    const region = after.generatedRegion!;
    expect(region.startsWith(`> [!warning] ${STALE_BANNER_TITLE}`)).toBe(true);
    expect(region).toContain(STALE_CONTENT_HEADING);
    // The last generated content is kept below the banner, for reference.
    expect(region).toContain(before.generatedRegion!.split('\n').find((l) => l.startsWith('# '))!);
    // Human text outside the markers is untouched.
    expect(raw.slice(raw.indexOf(GENERATED_END))).toContain('My own research notes about this keyword (human).');

    // The index lists it; the page note no longer links to the deleted keyword; the vault checks clean.
    expect(read('00 Dashboard/Index.md')).toContain('## Stale notes (1)');
    expect(read('00 Dashboard/Index.md')).toContain('[[03 Keywords/pricing software|');
    expect(parseNote(read('02 Website/Pages/Pricing.md')).generatedRegion).not.toContain('[[03 Keywords/pricing software');
    const check = checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir: writer.vaultDir });
    expect(check.issues.filter((i) => i.severity === 'error')).toEqual([]);

    // Re-rendering changes nothing (no timestamps in the stale content; no second write).
    const again = renderAll(ctx, writer);
    expect(again.stale).toEqual([expect.objectContaining({ relPath: KEYWORD_NOTE, status: 'unchanged' })]);
    expect(read(KEYWORD_NOTE)).toBe(raw);
    expect(again.counts.created + again.counts.updated + again.counts.conflict).toBe(0);
  });

  it('a withdrawn owner decision leaves a stale decision note, never a deleted one', () => {
    const { ctx, writer, read } = setup();
    ctx.db.run('DELETE FROM decisions WHERE site_id = ? AND id = ?', [ctx.siteId, SEED_IDS.decision]);
    const r = renderAll(ctx, writer);
    expect(r.stale?.map((s) => [s.relPath, s.kind, s.status])).toEqual([[DECISION_NOTE, 'decision', 'updated']]);
    expect(parseNote(read(DECISION_NOTE)).frontmatter.status).toBe('stale');
  });

  it('an edited generated region is never overwritten: a conflict artifact is created instead', () => {
    const { ctx, writer, abs, read } = setup();
    const edited = read(KEYWORD_NOTE).replace('## Search volume estimates', '## Search volume estimates (my edit)');
    writeFileSync(abs(KEYWORD_NOTE), edited);
    mergeKeywordAway(ctx);
    const r = renderAll(ctx, writer);
    const s = r.stale!.find((x) => x.relPath === KEYWORD_NOTE)!;
    expect(s.status).toBe('conflict');
    expect(s.conflictPath).toMatch(/^03 Keywords\/pricing software\.conflict-.*\.md$/);
    expect(read(KEYWORD_NOTE)).toBe(edited);
    expect(read(s.conflictPath!)).toContain(STALE_BANNER_TITLE);
    expect(read('00 Dashboard/Index.md')).toContain('(not marked: the generated content was edited; see the conflict artifact)');
    // A second render does not pile up conflict artifacts (the stale proposal is deterministic).
    renderAll(ctx, writer);
    expect(readdirSync(path.dirname(abs(KEYWORD_NOTE))).filter((f) => f.includes('.conflict-'))).toHaveLength(1);
  });

  it('detached (human-owned) notes, other render kinds, and dry runs are never changed', () => {
    const { ctx, writer, read } = setup();
    mergeKeywordAway(ctx);
    const original = read(KEYWORD_NOTE);
    // --only pages: keyword notes are not checked.
    expect(renderAll(ctx, writer, { only: ['pages'] }).stale).toEqual([]);
    expect(read(KEYWORD_NOTE)).toBe(original);
    // Dry run: reported, nothing written.
    const dry = renderAll(ctx, createVaultWriter(ctx, { dryRun: true }));
    expect(dry.stale).toEqual([expect.objectContaining({ relPath: KEYWORD_NOTE, status: 'updated' })]);
    expect(read(KEYWORD_NOTE)).toBe(original);
    // Detached: seo-agent no longer updates the note at all.
    writer.resolveConflict(KEYWORD_NOTE, 'detach');
    expect(renderAll(ctx, writer).stale).toEqual([]);
    expect(read(KEYWORD_NOTE)).toBe(original);
  });

  it('a note whose record still exists but is beyond a render limit is not stale; a restored record un-stales its note', () => {
    const { ctx, writer, read } = setup();
    const limited = renderAll(ctx, writer, { limits: { keywords: 0 } });
    expect(limited.stale).toEqual([]);
    // Remove, render (stale), restore the same id, render: normal content again, stale properties removed.
    const row = ctx.db.get<Record<string, unknown>>('SELECT * FROM keywords WHERE id = ?', [SEED_IDS.keyword])!;
    mergeKeywordAway(ctx);
    renderAll(ctx, writer);
    expect(parseNote(read(KEYWORD_NOTE)).frontmatter.status).toBe('stale');
    const cols = Object.keys(row);
    ctx.db.run(`INSERT INTO keywords (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
    const restored = renderAll(ctx, writer);
    expect(restored.stale).toEqual([]);
    const note = parseNote(read(KEYWORD_NOTE));
    expect(note.frontmatter.status).toBeUndefined();
    expect(note.frontmatter.stale_reason).toBeUndefined();
    expect(note.generatedRegion).not.toContain(STALE_BANNER_TITLE);
  });
});
