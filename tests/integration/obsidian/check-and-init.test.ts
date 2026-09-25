import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appDirs, siteVaultDir } from '../../../src/config/paths.js';
import { importBusinessNotes } from '../../../src/obsidian/business-sync.js';
import { checkVault } from '../../../src/obsidian/check.js';
import { parseNote } from '../../../src/obsidian/frontmatter.js';
import { initSiteVault } from '../../../src/obsidian/template.js';
import { VAULT_FOLDERS } from '../../../src/obsidian/types.js';
import { createVaultWriter } from '../../../src/obsidian/writer.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

let ctx: TestContext;
let vaultDir: string;
beforeEach(() => {
  ctx = createTestContext();
  vaultDir = siteVaultDir(ctx.paths, ctx.siteId);
});
afterEach(() => ctx.cleanup());

const init = (dryRun = false) => initSiteVault({ templateDir: appDirs.vaultTemplate(), vaultRoot: ctx.paths.vaultRoot, siteId: ctx.siteId, businessName: 'Test Co (synthetic)', dryRun });

describe('vault init from the template', () => {
  it('creates the full folder tree, business templates, and Templates/ without plugins', () => {
    const r = init();
    for (const f of VAULT_FOLDERS) expect(existsSync(path.join(vaultDir, ...f.split('/')))).toBe(true);
    for (const f of ['README.md', '01 Business/Business Profile.md', '01 Business/Customer Questions.md', '01 Business/Owner Decisions.md', 'Templates/Page Note.md', 'Templates/Keyword Note.md', 'Templates/Competitor Note.md', 'Templates/Experiment Idea.md', 'Templates/Decision Note.md', 'Templates/Learning Note.md', 'Templates/Content Brief.md']) {
      expect(r.created).toContain(f);
    }
    expect(readdirSync(vaultDir)).not.toContain('.obsidian');
    const profile = parseNote(readFileSync(path.join(vaultDir, '01 Business', 'Business Profile.md'), 'utf8'));
    expect(profile.frontmatter).toMatchObject({ id: 'business-profile', type: 'business_profile', site: 'test-site' });
    // Obsidian placeholders in Templates/ are left for Obsidian.
    expect(readFileSync(path.join(vaultDir, 'Templates', 'Page Note.md'), 'utf8')).toContain('{{title}}');
    expect(readFileSync(path.join(vaultDir, 'README.md'), 'utf8')).toContain('# Test Co (synthetic): seo-agent vault');
    expect(r.created.some((c) => c.endsWith('.gitkeep'))).toBe(false);
  });

  it('never overwrites existing files and is idempotent', () => {
    init();
    const profile = path.join(vaultDir, '01 Business', 'Business Profile.md');
    writeFileSync(profile, 'MY EDITS');
    const again = init();
    expect(readFileSync(profile, 'utf8')).toBe('MY EDITS');
    expect(again.created).toEqual([]);
    expect(again.existing).toContain('01 Business/Business Profile.md');
  });

  it('dry run writes nothing', () => {
    const r = init(true);
    expect(r.dryRun).toBe(true);
    expect(r.created.length).toBeGreaterThan(10);
    expect(existsSync(vaultDir)).toBe(false);
  });

  it('refuses to write through a symlinked folder in the vault', () => {
    mkdirSync(vaultDir, { recursive: true });
    const outside = path.join(ctx.paths.root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, path.join(vaultDir, '01 Business'));
    expect(() => init()).toThrow(/symlink/i);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('the fresh template imports cleanly and passes the vault check', () => {
    init();
    const imp = importBusinessNotes(ctx, { apply: true });
    expect(imp.rejected).toBe(0);
    expect(imp.notes.map((n) => n.noteType).sort()).toEqual(['business_profile', 'customer_questions', 'owner_decisions']);
    const report = checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir });
    expect(report.counts.errors).toBe(0);
    expect(report.issues.filter((i) => i.code === 'missing_folder')).toEqual([]);
  });
});

describe('vault check', () => {
  it('reports a missing vault honestly', () => {
    const r = checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir });
    expect(r.exists).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.detail).toMatch(/vault init/);
  });

  it('detects broken, ambiguous, and valid wikilinks (path-aware and shortest-path)', () => {
    init();
    mkdirSync(path.join(vaultDir, '03 Keywords'), { recursive: true });
    writeFileSync(path.join(vaultDir, '03 Keywords', 'Shoes.md'), '# Shoes\n');
    mkdirSync(path.join(vaultDir, '04 Competitors'), { recursive: true });
    writeFileSync(path.join(vaultDir, '04 Competitors', 'Shoes.md'), '# Shoes too\n');
    writeFileSync(
      path.join(vaultDir, '12 Decisions', 'Mine.md'),
      [
        '# Mine',
        '[[03 Keywords/Shoes|ok path link]]',
        '[[03 Keywords/Missing|broken]]',
        '[[Shoes]]',
        '[[Nowhere]]',
        '[[README]]',
        '[[#Local heading]]',
        '`[[in code]]`',
        '| [[03 Keywords/Shoes\\|table link]] |',
        '[[04 Competitors/rival.example.test.md|dotted]]',
      ].join('\n'),
    );
    const r = checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir });
    const mine = r.issues.filter((i) => i.relPath === '12 Decisions/Mine.md');
    expect(mine.filter((i) => i.code === 'broken_link').map((i) => i.target).sort()).toEqual(['03 Keywords/Missing', '04 Competitors/rival.example.test.md', 'Nowhere']);
    expect(mine.filter((i) => i.code === 'ambiguous_link').map((i) => i.target)).toEqual(['Shoes']);
    expect(r.ok).toBe(false);
  });

  it('reports malformed notes (unsafe YAML), duplicate ids, symlinks, and leftover temp files', () => {
    init();
    writeFileSync(path.join(vaultDir, '13 Learnings', 'Bad.md'), '---\nid: !!js/function "x"\n---\nbody');
    writeFileSync(path.join(vaultDir, '13 Learnings', 'Dup1.md'), '---\nid: same\n---\n');
    writeFileSync(path.join(vaultDir, '13 Learnings', 'Dup2.md'), '---\nid: same\n---\n');
    symlinkSync(path.join(ctx.paths.root, 'README.md'), path.join(vaultDir, '13 Learnings', 'Link.md'));
    writeFileSync(path.join(vaultDir, '13 Learnings', '.Note.md.tmp-123-abcdef'), 'partial');
    const r = checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir });
    const codes = new Set(r.issues.map((i) => i.code));
    for (const c of ['malformed_note', 'duplicate_id', 'symlink', 'temp_file'] as const) expect(codes.has(c)).toBe(true);
  });

  it('reports tracked notes that are missing or whose generated region was edited', () => {
    const writer = createVaultWriter(ctx);
    writer.writeGenerated({ relPath: '02 Website/Pages/A.md', noteId: 'a', kind: 'page', title: 'A', frontmatter: {}, body: 'one' });
    writer.writeGenerated({ relPath: '02 Website/Pages/B.md', noteId: 'b', kind: 'page', title: 'B', frontmatter: {}, body: 'two' });
    const a = path.join(vaultDir, '02 Website', 'Pages', 'A.md');
    writeFileSync(a, readFileSync(a, 'utf8').replace('one', 'one (edited)'));
    rmSync(path.join(vaultDir, '02 Website', 'Pages', 'B.md'));
    const r = checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir });
    expect(r.issues.find((i) => i.relPath === '02 Website/Pages/A.md' && i.code === 'edited_generated_region')).toBeTruthy();
    expect(r.issues.find((i) => i.relPath === '02 Website/Pages/B.md' && i.code === 'missing_tracked_note')).toBeTruthy();
  });
});
