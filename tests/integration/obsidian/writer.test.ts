import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkVault } from '../../../src/obsidian/check.js';
import { parseNote } from '../../../src/obsidian/frontmatter.js';
import { listTempFiles } from '../../../src/obsidian/fs-safe.js';
import { GENERATED_END, GENERATED_START, type GeneratedNote } from '../../../src/obsidian/types.js';
import { createVaultWriter, type FileVaultWriter } from '../../../src/obsidian/writer.js';
import { extractWikilinks } from '../../../src/obsidian/wikilinks.js';
import { registerSecret } from '../../../src/security/redact.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

let ctx: TestContext;
let writer: FileVaultWriter;

const note = (overrides: Partial<GeneratedNote> = {}): GeneratedNote => ({
  relPath: '02 Website/Pages/Pricing.md',
  noteId: 'page_pricing',
  kind: 'page',
  title: 'Pricing',
  frontmatter: { source_ids: ['page_pricing'], url: 'https://www.example.test/pricing/' },
  body: '# Pricing\n\n- Clicks 10',
  ...overrides,
});

const abs = (rel: string) => path.join(writer.vaultDir, ...rel.split('/'));
const read = (rel: string) => readFileSync(abs(rel), 'utf8');

beforeEach(() => {
  ctx = createTestContext();
  writer = createVaultWriter(ctx);
});
afterEach(() => ctx.cleanup());

describe('generated notes', () => {
  it('creates a note with stable frontmatter, markers, and a human area', () => {
    const out = writer.writeGenerated(note());
    expect(out.status).toBe('created');
    const parsed = parseNote(read(out.relPath));
    expect(parsed.frontmatter).toMatchObject({ id: 'page_pricing', type: 'page', site: 'test-site', generated_at: '2026-09-24T09:00:00.000Z', source_ids: ['page_pricing'], title: 'Pricing' });
    expect(parsed.generatedRegion).toBe('# Pricing\n\n- Clicks 10');
    expect(read(out.relPath)).toContain('## Notes');
    const row = ctx.db.get<{ note_id: string; ownership: string; last_generated_hash: string; generated_keys_json: string }>('SELECT * FROM vault_notes WHERE site_id = ? AND rel_path = ?', [ctx.siteId, out.relPath])!;
    expect(row.note_id).toBe('page_pricing');
    expect(row.ownership).toBe('generated');
    expect(JSON.parse(row.generated_keys_json)).toContain('url');
  });

  it('unchanged content is a no-op (no write, file bytes identical)', () => {
    writer.writeGenerated(note());
    const before = read('02 Website/Pages/Pricing.md');
    ctx.clock.advanceMs(86_400_000);
    const out = writer.writeGenerated(note());
    expect(out.status).toBe('unchanged');
    expect(read('02 Website/Pages/Pricing.md')).toBe(before);
  });

  it('preserves human text outside the markers and human-added properties verbatim', () => {
    writer.writeGenerated(note());
    const original = read('02 Website/Pages/Pricing.md');
    const edited = original
      .replace('---\n<!-- seo-agent', '---\nHuman intro written above the region.\r\n\n<!-- seo-agent')
      .replace('tags:\n', 'my_rating: 5\nmy_links:\n  - "[[02 Website/Pages/Pricing|self]]"\ntags:\n')
      .concat('\nMy own analysis. Keep this.\n- [ ] follow up\n');
    writeFileSync(abs('02 Website/Pages/Pricing.md'), edited);
    ctx.clock.advanceMs(60_000);
    const out = writer.writeGenerated(note({ body: '# Pricing\n\n- Clicks 12' }));
    expect(out.status).toBe('updated');
    const after = read('02 Website/Pages/Pricing.md');
    const parsed = parseNote(after);
    expect(parsed.generatedRegion).toBe('# Pricing\n\n- Clicks 12');
    expect(parsed.frontmatter.my_rating).toBe(5);
    expect(parsed.frontmatter.my_links).toEqual(['[[02 Website/Pages/Pricing|self]]']);
    expect(parsed.frontmatter.generated_at).toBe('2026-09-24T09:01:00.000Z');
    expect(after).toContain('Human intro written above the region.\r\n\n<!-- seo-agent');
    expect(after.endsWith('\nMy own analysis. Keep this.\n- [ ] follow up\n')).toBe(true);
  });

  it('writes a conflict artifact instead of overwriting when the generated region was edited', () => {
    writer.writeGenerated(note());
    const edited = read('02 Website/Pages/Pricing.md').replace('- Clicks 10', '- Clicks 10 (I think this is wrong)');
    writeFileSync(abs('02 Website/Pages/Pricing.md'), edited);
    const out = writer.writeGenerated(note({ body: '# Pricing\n\n- Clicks 99' }));
    expect(out.status).toBe('conflict');
    expect(out.conflictPath).toMatch(/^02 Website\/Pages\/Pricing\.conflict-20260924T090000Z\.md$/);
    expect(read('02 Website/Pages/Pricing.md')).toBe(edited);
    const artifact = parseNote(read(out.conflictPath!));
    expect(artifact.frontmatter).toMatchObject({ type: 'vault_conflict', conflict_for: '02 Website/Pages/Pricing.md', conflict_note_id: 'page_pricing' });
    expect(artifact.generatedRegion).toBeNull();
    expect(artifact.raw).toContain('- Clicks 99');
    expect(artifact.raw).toContain('(I think this is wrong)');
    const row = ctx.db.get<{ conflict_path: string }>('SELECT conflict_path FROM vault_notes WHERE site_id = ? AND rel_path = ?', [ctx.siteId, '02 Website/Pages/Pricing.md'])!;
    expect(row.conflict_path).toBe(out.conflictPath);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE site_id = ? AND event_type = 'vault.conflict'", [ctx.siteId])!.n).toBe(1);

    // Re-rendering the same proposal does not pile up artifacts.
    ctx.clock.advanceMs(3_600_000);
    const again = writer.writeGenerated(note({ body: '# Pricing\n\n- Clicks 99' }));
    expect(again.status).toBe('conflict');
    expect(again.conflictPath).toBe(out.conflictPath);
    expect(readdirSync(abs('02 Website/Pages')).filter((f) => f.includes('.conflict-'))).toHaveLength(1);
  });

  it('treats an edited generated property as a conflict, and a new human property as fine', () => {
    writer.writeGenerated(note());
    writeFileSync(abs('02 Website/Pages/Pricing.md'), read('02 Website/Pages/Pricing.md').replace('url: https://www.example.test/pricing/', 'url: https://evil.invalid/'));
    expect(writer.writeGenerated(note({ body: 'changed' })).status).toBe('conflict');
  });

  it('never overwrites a human file that occupies the path, or a note whose markers were removed', () => {
    mkdirSync(abs('03 Keywords'), { recursive: true });
    writeFileSync(abs('03 Keywords/pricing.md'), '# My own keyword note\n');
    const out = writer.writeGenerated(note({ relPath: '03 Keywords/pricing.md', noteId: 'kw_1', kind: 'keyword' }));
    expect(out.status).toBe('conflict');
    expect(read('03 Keywords/pricing.md')).toBe('# My own keyword note\n');

    writer.writeGenerated(note());
    writeFileSync(abs('02 Website/Pages/Pricing.md'), read('02 Website/Pages/Pricing.md').replace(GENERATED_START, '').replace(GENERATED_END, ''));
    const o2 = writer.writeGenerated(note({ body: 'new' }));
    expect(o2.status).toBe('conflict');
    expect(o2.reason).toMatch(/markers are missing/);
  });

  it('conflicts on unparseable notes (unsafe YAML tags) without executing or overwriting anything', () => {
    writer.writeGenerated(note());
    const hostile = read('02 Website/Pages/Pricing.md').replace('tags:\n', 'evil: !!js/function "function(){ return 1 }"\ntags:\n');
    writeFileSync(abs('02 Website/Pages/Pricing.md'), hostile);
    const out = writer.writeGenerated(note({ body: 'new' }));
    expect(out.status).toBe('conflict');
    expect(out.reason).toMatch(/cannot be parsed/);
    expect(read('02 Website/Pages/Pricing.md')).toBe(hostile);
  });

  it('untracked note with the same id (e.g. after a DB restore) is adopted only when identical', () => {
    writer.writeGenerated(note());
    ctx.db.run('DELETE FROM vault_notes WHERE site_id = ?', [ctx.siteId]);
    expect(writer.writeGenerated(note()).status).toBe('unchanged');
    ctx.db.run('DELETE FROM vault_notes WHERE site_id = ?', [ctx.siteId]);
    expect(writer.writeGenerated(note({ body: 'different' })).status).toBe('conflict');
  });

  it('recreates a deleted note and respects detached (human-owned) notes', () => {
    const out = writer.writeGenerated(note());
    writeFileSync(abs(out.relPath), read(out.relPath).replace('- Clicks 10', '- Clicks 10 edited'));
    writer.resolveConflict(out.relPath, 'detach');
    const detached = writer.writeGenerated(note({ body: 'regenerated' }));
    expect(detached.status).toBe('unchanged');
    expect(detached.reason).toMatch(/detached/);
    expect(read(out.relPath)).toContain('- Clicks 10 edited');
  });

  it('resolve --use-generated backs up the note and lets the next render replace the region', () => {
    writer.writeGenerated(note());
    writeFileSync(abs('02 Website/Pages/Pricing.md'), read('02 Website/Pages/Pricing.md').replace('- Clicks 10', '- Clicks 10 edited') + '\nKeep me.\n');
    expect(writer.writeGenerated(note({ body: '# Pricing\n\n- Clicks 11' })).status).toBe('conflict');
    const r = writer.resolveConflict('02 Website/Pages/Pricing.md', 'use_generated');
    expect(r.backupPath).toBe('14 System Logs/Conflicts/02 Website - Pages - Pricing.backup-20260924T090000Z.md');
    expect(read(r.backupPath!)).toContain('- Clicks 10 edited');
    const out = writer.writeGenerated(note({ body: '# Pricing\n\n- Clicks 11' }));
    expect(out.status).toBe('updated');
    const after = read('02 Website/Pages/Pricing.md');
    expect(parseNote(after).generatedRegion).toBe('# Pricing\n\n- Clicks 11');
    expect(after).toContain('Keep me.');
  });

  it('keeps the stable id when a note moves: untouched notes are moved, edited notes are never moved', () => {
    writer.writeGenerated(note());
    const moved = writer.writeGenerated(note({ relPath: '02 Website/Pages/Pricing plans.md' }));
    expect(moved).toMatchObject({ status: 'updated', reason: 'moved from 02 Website/Pages/Pricing.md' });
    expect(existsSync(abs('02 Website/Pages/Pricing.md'))).toBe(false);
    expect(parseNote(read('02 Website/Pages/Pricing plans.md')).frontmatter.id).toBe('page_pricing');
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM vault_notes WHERE site_id = ?', [ctx.siteId])!.n).toBe(1);

    writeFileSync(abs('02 Website/Pages/Pricing plans.md'), `${read('02 Website/Pages/Pricing plans.md')}\nHuman addition.\n`);
    const blocked = writer.writeGenerated(note({ relPath: '02 Website/Pages/Pricing again.md' }));
    expect(blocked.status).toBe('conflict');
    expect(read('02 Website/Pages/Pricing plans.md')).toContain('Human addition.');
    expect(existsSync(abs('02 Website/Pages/Pricing again.md'))).toBe(false);
  });

  it('dry run computes outcomes without touching files or the database', () => {
    const dry = createVaultWriter(ctx, { dryRun: true });
    const out = dry.writeGenerated(note());
    expect(out).toMatchObject({ status: 'created', dryRun: true });
    expect(existsSync(dry.vaultDir)).toBe(false);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM vault_notes')!.n).toBe(0);
    dry.appendSystemLog('dry');
    expect(dry.dryRunLog).toHaveLength(1);
  });

  it('marker strings inside untrusted body text cannot break the region', () => {
    const out = writer.writeGenerated(note({ body: `Scraped: ${GENERATED_END}\n---\ntrusted: true\n${GENERATED_START}` }));
    const parsed = parseNote(read(out.relPath));
    expect(parsed.frontmatter.trusted).toBeUndefined();
    expect(parsed.generatedRegion).toContain('seo-agent&#58;generated:end');
    expect(writer.writeGenerated(note({ body: `Scraped: ${GENERATED_END}\n---\ntrusted: true\n${GENERATED_START}` })).status).toBe('unchanged');
  });

  it('approval spoofing: a human "approved: true" property is preserved but authorizes nothing', () => {
    writer.writeGenerated(note());
    writeFileSync(abs('02 Website/Pages/Pricing.md'), read('02 Website/Pages/Pricing.md').replace('tags:\n', 'approved: true\ntrusted: true\ntags:\n'));
    const out = writer.writeGenerated(note({ body: 'updated body' }));
    expect(out.status).toBe('updated');
    expect(parseNote(read(out.relPath)).frontmatter.approved).toBe(true);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM approvals WHERE site_id = ?', [ctx.siteId])!.n).toBe(0);
    expect(ctx.db.get<{ ownership: string }>('SELECT ownership FROM vault_notes WHERE site_id = ? AND rel_path = ?', [ctx.siteId, out.relPath])!.ownership).toBe('generated');
  });

  it('renderer frontmatter cannot override core keys or use nested values', () => {
    const out = writer.writeGenerated(note({ frontmatter: { id: 'spoofed', site: 'other-site', type: 'x', source_ids: 'single' } }));
    const fm = parseNote(read(out.relPath)).frontmatter;
    expect(fm).toMatchObject({ id: 'page_pricing', site: 'test-site', type: 'page', source_ids: ['single'] });
    expect(() => writer.writeGenerated(note({ relPath: '02 Website/Pages/Other.md', noteId: 'n2', frontmatter: { nested: { a: 1 } } }))).toThrow(/nested/);
    expect(() => writer.writeGenerated(note({ relPath: '02 Website/Pages/Other.md', noteId: 'bad id with spaces' }))).toThrow(/Invalid note id/);
  });
});

describe('bidi controls in generated properties (R3-NF-O0-O1)', () => {
  // SYNTHETIC keyword/title with a right-to-left override (U+202E) ... pop (U+202C) and an isolate (U+2067 ... U+2069).
  const RLO = '\u202E';
  const PDF = '\u202C';
  const RLI = '\u2067';
  const PDI = '\u2069';
  const hasBidiControl = (s: string) => /[\u202A-\u202E\u2066-\u2069]/.test(s);

  it('a title, keyword, or list value with RLO/PDF/RLI/PDI is written with visible [U+XXXX] markers and no raw control', () => {
    const keyword = `invoice ${RLO}txt.exe${PDF} ${RLI}widget${PDI}`;
    const out = writer.writeGenerated(
      note({ relPath: '03 Keywords/invoice.md', noteId: 'kw_bidi', kind: 'keyword', title: keyword, frontmatter: { source_ids: ['kw_bidi'], keyword, aliases: [keyword] }, body: '# invoice' }),
    );
    expect(out.status).toBe('created');
    const raw = read(out.relPath);
    const fmText = raw.slice(0, raw.indexOf('\n---\n', 4));
    expect(hasBidiControl(fmText)).toBe(false);
    const fm = parseNote(raw).frontmatter;
    const marked = 'invoice [U+202E]txt.exe[U+202C] [U+2067]widget[U+2069]';
    expect(fm).toMatchObject({ title: marked, keyword: marked, aliases: [marked] });
    // Unchanged on a re-render (marking is idempotent), and the markers never form a link in a property.
    expect(writer.writeGenerated(note({ relPath: '03 Keywords/invoice.md', noteId: 'kw_bidi', kind: 'keyword', title: keyword, frontmatter: { source_ids: ['kw_bidi'], keyword, aliases: [keyword] }, body: '# invoice' })).status).toBe('unchanged');
    const bracketed = writer.writeGenerated(note({ relPath: '03 Keywords/bracket.md', noteId: 'kw_bracket', kind: 'keyword', title: `[${RLO}[Private]${PDF}](x)`, frontmatter: { source_ids: ['kw_bracket'] }, body: '# bracket' }));
    const title = String(parseNote(read(bracketed.relPath)).frontmatter.title);
    expect(title).not.toMatch(/\[\[|\]\(/);
    expect(title).toContain('[U+202E]');
    expect(extractWikilinks(title)).toEqual([]);
  });
});

describe('path safety', () => {
  it.each([
    ['../outside.md'],
    ['02 Website/../../outside.md'],
    ['/tmp/outside.md'],
    ['01 Business/Business Profile.md'],
    ['Templates/Page Note.md'],
    ['.obsidian/app.md'],
    ['14 System Logs/2026-09-24.md'],
  ])('rejects writing %s', (relPath) => {
    expect(() => writer.writeGenerated(note({ relPath }))).toThrow();
    expect(existsSync(path.join(ctx.paths.root, 'outside.md'))).toBe(false);
  });

  it('rejects a symlinked folder that escapes the vault (nothing is written outside)', () => {
    mkdirSync(writer.vaultDir, { recursive: true });
    const outside = path.join(ctx.paths.root, 'outside-dir');
    mkdirSync(outside);
    symlinkSync(outside, abs('03 Keywords'));
    expect(() => writer.writeGenerated(note({ relPath: '03 Keywords/k.md', noteId: 'k' }))).toThrow(/symlink|outside/i);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('rejects a symlinked note file pointing outside the vault', () => {
    mkdirSync(abs('03 Keywords'), { recursive: true });
    const secret = path.join(ctx.paths.root, 'secret.md');
    writeFileSync(secret, 'SECRET');
    symlinkSync(secret, abs('03 Keywords/k.md'));
    expect(() => writer.writeGenerated(note({ relPath: '03 Keywords/k.md', noteId: 'k' }))).toThrow(/symlink|outside/i);
    expect(() => writer.readNote('03 Keywords/k.md')).toThrow(/symlink|outside/i);
    expect(readFileSync(secret, 'utf8')).toBe('SECRET');
  });
});

describe('atomic writes through the writer', () => {
  it('a failure during an update leaves the previous note intact and no temp files', () => {
    const out = writer.writeGenerated(note());
    const before = read(out.relPath);
    const failing = createVaultWriter(ctx, {
      atomicHooks: {
        afterTempWrite: () => {
          throw new Error('disk full (simulated)');
        },
      },
    });
    expect(() => failing.writeGenerated(note({ body: 'new body' }))).toThrow(/disk full/);
    expect(read(out.relPath)).toBe(before);
    expect(listTempFiles(abs('02 Website/Pages'))).toEqual([]);
    // The database still describes the file on disk, so the next write succeeds normally.
    expect(writer.writeGenerated(note({ body: 'new body' })).status).toBe('updated');
  });

  it('a failure while creating leaves no file at all', () => {
    const failing = createVaultWriter(ctx, {
      atomicHooks: {
        afterTempWrite: () => {
          throw new Error('crash');
        },
      },
    });
    expect(() => failing.writeGenerated(note())).toThrow(/crash/);
    expect(existsSync(abs('02 Website/Pages/Pricing.md'))).toBe(false);
    expect(readdirSync(abs('02 Website/Pages'))).toEqual([]);
  });
});

describe('links and system log', () => {
  it('link() requires an existing or planned target', () => {
    expect(() => writer.link('02 Website/Pages/Missing.md')).toThrow(/neither an existing note nor being generated/);
    writer.plan('02 Website/Pages/Planned.md');
    expect(writer.link('02 Website/Pages/Planned.md', 'Planned')).toBe('[[02 Website/Pages/Planned|Planned]]');
    writer.writeGenerated(note());
    expect(writer.link('02 Website/Pages/Pricing', 'Pricing')).toBe('[[02 Website/Pages/Pricing|Pricing]]');
    expect(() => writer.link('../x.md')).toThrow();
  });

  it('appends redacted, single-line entries to a daily note in the business time zone', () => {
    registerSecret('super-secret-token-value');
    writer.appendSystemLog('first entry with super-secret-token-value and Bearer abcdefghijklmnop');
    writer.appendSystemLog('second\nentry <!-- seo-agent:generated:start -->');
    const log = read('14 System Logs/2026-09-24.md');
    expect(log).toContain('type: system_log');
    expect(log).not.toContain('super-secret-token-value');
    expect(log).not.toContain('abcdefghijklmnop');
    expect(log).toContain('[REDACTED]');
    expect(log).toContain('- 2026-09-24T09:00:00.000Z second entry');
    expect(log).not.toContain(GENERATED_START);
    const lines = log.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(2);
    // Append-only: earlier content remains as a prefix.
    const before = read('14 System Logs/2026-09-24.md');
    writer.appendSystemLog('third');
    expect(read('14 System Logs/2026-09-24.md').startsWith(before)).toBe(true);
  });
});


const PRICING = '02 Website/Pages/Pricing.md';
const frontmatterLines = (text: string) => text.slice(0, text.indexOf('\n---\n', 4)).split('\n');
const trackedRow = () =>
  ctx.db.get<{ last_generated_hash: string | null; pending_generated_hash: string | null; last_written_at: string | null; generated_keys_json: string | null; last_written_hash: string | null; conflict_path: string | null }>(
    'SELECT * FROM vault_notes WHERE site_id = ? AND rel_path = ?',
    [ctx.siteId, PRICING],
  )!;
const editedRegionIssues = () => checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir: writer.vaultDir }).issues.filter((i) => i.code === 'edited_generated_region');
const conflictFiles = () => readdirSync(abs('02 Website/Pages')).filter((f) => f.includes('.conflict-'));

describe('human frontmatter is edited in place, never re-serialized', () => {
  it('keeps YAML comments, key order, quoting, and custom keys verbatim; only generated values change', () => {
    writer.writeGenerated(note());
    const edited = read(PRICING).replace('tags:\n', '# my private reminder: call vendor\nmy_prop: "0012"\nreviewed: yes # checked by hand\nflow_list: [a, b]\ntags:\n');
    writeFileSync(abs(PRICING), edited);
    ctx.clock.advanceMs(60_000);
    expect(writer.writeGenerated(note({ body: '# Pricing\n\n- Clicks 12' })).status).toBe('updated');
    const after = read(PRICING);
    expect(after).toContain('# my private reminder: call vendor\nmy_prop: "0012"\nreviewed: yes # checked by hand\nflow_list: [a, b]\ntags:\n');
    const before = frontmatterLines(edited);
    const now = frontmatterLines(after);
    expect(now).toHaveLength(before.length);
    expect(before.filter((l, i) => l !== now[i])).toEqual(['generated_at: 2026-09-24T09:00:00.000Z']);
    expect(parseNote(after).frontmatter).toMatchObject({ my_prop: '0012', reviewed: 'yes', flow_list: ['a', 'b'], generated_at: '2026-09-24T09:01:00.000Z' });
  });

  it('a comment written above a generated key that is no longer generated is kept', () => {
    writer.writeGenerated(note({ frontmatter: { source_ids: ['page_pricing'], url: 'https://www.example.test/pricing/', route: 'CTR_OPPORTUNITY' } }));
    writeFileSync(abs(PRICING), read(PRICING).replace('route: CTR_OPPORTUNITY\n', '# why the route matters to me\nroute: CTR_OPPORTUNITY\n'));
    expect(writer.writeGenerated(note({ body: 'no route now' })).status).toBe('updated');
    const after = read(PRICING);
    expect(after).toContain('# why the route matters to me');
    expect(parseNote(after).frontmatter.route).toBeUndefined();
  });
});

describe('shared list properties (tags, aliases, cssclasses)', () => {
  it('a human tag, alias, or cssclass is kept and never counts as an edit of generated content', () => {
    writer.writeGenerated(note());
    writeFileSync(
      abs(PRICING),
      read(PRICING)
        .replace('  - seo-agent/page\n', '  - seo-agent/page\n  - my/tag\n')
        .replace('tags:\n', 'aliases:\n  - Price page\ncssclasses:\n  - wide\ntags:\n'),
    );
    expect(editedRegionIssues()).toEqual([]);
    expect(writer.writeGenerated(note()).status).toBe('unchanged');
    ctx.clock.advanceMs(60_000);
    const out = writer.writeGenerated(note({ body: 'new body' }));
    expect(out.status).toBe('updated');
    const fm = parseNote(read(PRICING)).frontmatter;
    expect(fm.tags).toEqual(['seo-agent/page', 'my/tag']);
    expect(fm.aliases).toEqual(['Price page']);
    expect(fm.cssclasses).toEqual(['wide']);
    expect(conflictFiles()).toEqual([]);
    expect(writer.writeGenerated(note({ body: 'new body' })).status).toBe('unchanged');
  });

  it('a removed generator tag is restored on the next update, and a scalar tags value becomes a merged list', () => {
    writer.writeGenerated(note());
    writeFileSync(abs(PRICING), read(PRICING).replace('tags:\n  - seo-agent/page\n', 'tags: mine\n'));
    expect(editedRegionIssues()).toEqual([]);
    expect(writer.writeGenerated(note({ body: 'changed' })).status).toBe('updated');
    expect(parseNote(read(PRICING)).frontmatter.tags).toEqual(['seo-agent/page', 'mine']);
  });

  it('the dashboard cssclasses are shared the same way', () => {
    const dash = { relPath: '00 Dashboard/Dashboard.md', noteId: 'dashboard-test-site', kind: 'dashboard', title: 'Dashboard', frontmatter: { cssclasses: ['seo-agent-dashboard'] }, body: 'v1' };
    writer.writeGenerated(dash);
    writeFileSync(abs(dash.relPath), read(dash.relPath).replace('  - seo-agent-dashboard\n', '  - seo-agent-dashboard\n  - my-wide-layout\n'));
    expect(writer.writeGenerated({ ...dash, body: 'v2' }).status).toBe('updated');
    expect(parseNote(read(dash.relPath)).frontmatter.cssclasses).toEqual(['seo-agent-dashboard', 'my-wide-layout']);
  });
});

describe('crash consistency between the file write and the database update', () => {
  const crashAfterRename = () =>
    createVaultWriter(ctx, {
      atomicHooks: {
        afterCommit: () => {
          throw new Error('crash after rename (simulated)');
        },
      },
    });

  it('a crash after the rename is not mistaken for a human edit: the same data is adopted without a conflict', () => {
    writer.writeGenerated(note());
    expect(() => crashAfterRename().writeGenerated(note({ body: 'v2' }))).toThrow(/crash after rename/);
    expect(parseNote(read(PRICING)).generatedRegion).toBe('v2');
    expect(trackedRow().pending_generated_hash).not.toBeNull();
    expect(editedRegionIssues()).toEqual([]);

    expect(writer.writeGenerated(note({ body: 'v2' })).status).toBe('unchanged');
    expect(trackedRow().pending_generated_hash).toBeNull();
    expect(conflictFiles()).toEqual([]);
    expect(writer.writeGenerated(note({ body: 'v2' })).status).toBe('unchanged');
  });

  it('after a crash, changed data updates the note normally', () => {
    writer.writeGenerated(note());
    writeFileSync(abs(PRICING), `${read(PRICING)}\nHuman text.\n`);
    expect(() => crashAfterRename().writeGenerated(note({ body: 'v2' }))).toThrow(/crash after rename/);
    const out = writer.writeGenerated(note({ body: 'v3' }));
    expect(out.status).toBe('updated');
    expect(parseNote(read(PRICING)).generatedRegion).toBe('v3');
    expect(read(PRICING)).toContain('Human text.');
    expect(conflictFiles()).toEqual([]);
  });

  it('a database error after the rename (simulated with a trigger) is recovered the same way', () => {
    writer.writeGenerated(note());
    ctx.db.exec(`CREATE TRIGGER fail_after_rename BEFORE UPDATE ON vault_notes
      WHEN NEW.pending_generated_hash IS NULL AND OLD.pending_generated_hash IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'database unavailable (simulated)'); END`);
    expect(() => writer.writeGenerated(note({ body: 'v2' }))).toThrow(/database unavailable/);
    expect(parseNote(read(PRICING)).generatedRegion).toBe('v2');
    ctx.db.exec('DROP TRIGGER fail_after_rename');
    expect(writer.writeGenerated(note({ body: 'v2' })).status).toBe('unchanged');
    expect(writer.writeGenerated(note({ body: 'v3' })).status).toBe('updated');
    expect(conflictFiles()).toEqual([]);
  });

  it('a crash after creating a new note is adopted on the next run', () => {
    expect(() => crashAfterRename().writeGenerated(note())).toThrow(/crash after rename/);
    expect(existsSync(abs(PRICING))).toBe(true);
    expect(writer.writeGenerated(note()).status).toBe('unchanged');
    expect(trackedRow().last_generated_hash).not.toBeNull();
    expect(writer.writeGenerated(note({ body: 'v2' })).status).toBe('updated');
  });

  it('a note written after the database was last recorded (restored backup) is a conflict with an honest reason', () => {
    writer.writeGenerated(note());
    const saved = trackedRow();
    ctx.clock.advanceMs(3_600_000);
    writer.writeGenerated(note({ body: 'v2' }));
    ctx.db.run('UPDATE vault_notes SET last_generated_hash = ?, last_written_hash = ?, last_written_at = ?, generated_keys_json = ? WHERE site_id = ? AND rel_path = ?', [
      saved.last_generated_hash,
      saved.last_written_hash,
      saved.last_written_at,
      saved.generated_keys_json,
      ctx.siteId,
      PRICING,
    ]);
    // Same content as on disk: adopted.
    expect(writer.writeGenerated(note({ body: 'v2' })).status).toBe('unchanged');
    ctx.db.run('UPDATE vault_notes SET last_generated_hash = ?, last_written_hash = ?, last_written_at = ?, generated_keys_json = ? WHERE site_id = ? AND rel_path = ?', [
      saved.last_generated_hash,
      saved.last_written_hash,
      saved.last_written_at,
      saved.generated_keys_json,
      ctx.siteId,
      PRICING,
    ]);
    const out = writer.writeGenerated(note({ body: 'v3' }));
    expect(out.status).toBe('conflict');
    expect(out.reason).toMatch(/after the database last recorded it/);
    expect(parseNote(read(PRICING)).generatedRegion).toBe('v2');
  });
});

describe('resolve backups are never lost', () => {
  it('notes with the same name in different folders, resolved in the same second, get separate backups', () => {
    const page = writer.writeGenerated(note());
    const kw = writer.writeGenerated(note({ relPath: '03 Keywords/Pricing.md', noteId: 'kw_pricing', kind: 'keyword', body: 'keyword body' }));
    writeFileSync(abs(page.relPath), read(page.relPath).replace('- Clicks 10', 'PAGE EDIT'));
    writeFileSync(abs(kw.relPath), read(kw.relPath).replace('keyword body', 'KEYWORD EDIT'));
    const a = writer.resolveConflict(page.relPath, 'use_generated');
    const b = writer.resolveConflict(kw.relPath, 'use_generated');
    expect(a.backupPath).toBe('14 System Logs/Conflicts/02 Website - Pages - Pricing.backup-20260924T090000Z.md');
    expect(b.backupPath).toBe('14 System Logs/Conflicts/03 Keywords - Pricing.backup-20260924T090000Z.md');
    expect(read(a.backupPath!)).toContain('PAGE EDIT');
    expect(read(b.backupPath!)).toContain('KEYWORD EDIT');

    const again = writer.resolveConflict(page.relPath, 'use_generated');
    expect(again.backupPath).toBe('14 System Logs/Conflicts/02 Website - Pages - Pricing.backup-20260924T090000Z-2.md');
    expect(read(again.backupPath!)).toContain('PAGE EDIT');

    expect(writer.writeGenerated(note({ body: 'regenerated' })).status).toBe('updated');
    expect(writer.writeGenerated(note({ relPath: '03 Keywords/Pricing.md', noteId: 'kw_pricing', kind: 'keyword', body: 'regenerated keyword' })).status).toBe('updated');
    expect(read(a.backupPath!)).toContain('PAGE EDIT');
    expect(read(b.backupPath!)).toContain('KEYWORD EDIT');
  });

  it('if the backup cannot be written, resolve fails before changing the database', () => {
    writer.writeGenerated(note());
    writeFileSync(abs(PRICING), read(PRICING).replace('- Clicks 10', 'EDIT'));
    expect(writer.writeGenerated(note({ body: 'proposed' })).status).toBe('conflict');
    const before = trackedRow();
    mkdirSync(abs('14 System Logs'), { recursive: true });
    writeFileSync(abs('14 System Logs/Conflicts'), 'a file where the backup folder should be');
    expect(() => writer.resolveConflict(PRICING, 'use_generated')).toThrow();
    expect(trackedRow()).toEqual(before);
    expect(writer.writeGenerated(note({ body: 'proposed' })).status).toBe('conflict');
    expect(read(PRICING)).toContain('EDIT');
  });
});

describe('generated properties from untrusted data', () => {
  it('are inert: no wikilinks, Markdown links, or non-http URIs', () => {
    const out = writer.writeGenerated(
      note({
        title: '[[01 Business/Business Profile]] Pricing',
        frontmatter: { source_ids: ['[[x]]'], url: 'obsidian://open?vault=x', summary: '[verify](https://evil.invalid)', keep: 'https://www.example.test/pricing/' },
      }),
    );
    const fm = parseNote(read(out.relPath)).frontmatter;
    expect(fm.title).toBe('[ [01 Business/Business Profile] ] Pricing');
    expect(fm.url).toBe('obsidian: //open?vault=x');
    expect(fm.summary).toBe('[verify] (https://evil.invalid)');
    expect(fm.keep).toBe('https://www.example.test/pricing/');
    expect(fm.source_ids).toEqual(['[ [x] ]']);
    expect(fm.id).toBe('page_pricing');
    const report = checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir: writer.vaultDir });
    expect(report.issues.filter((i) => i.code === 'broken_link')).toEqual([]);
  });
});

describe('generated notes never carry secrets (A9-01)', () => {
  it('redacts the body, the title, and every generated property value; wikilink aliases stay valid links', () => {
    const secret = `synthetic-vault-secret-${Date.now()}`;
    registerSecret(secret);
    const r = writer.writeGenerated(
      note({
        title: `Pricing ${secret}`,
        frontmatter: { source_ids: ['page_pricing'], url: `https://www.example.test/pricing/?utm_source=x&access_token=synthetictoken123456&sig=abcdef0123`, tags: [`seo-agent/${secret}`] },
        body: `# Pricing ${secret}\n\n- Link: [[03 Keywords/pricing software|pricing ${secret}]]\n- URL: https://www.example.test/dl?token=synthetictoken654321&page=2\n`,
      }),
    );
    expect(r.status).toBe('created');
    const raw = read('02 Website/Pages/Pricing.md');
    for (const v of [secret, 'synthetictoken123456', 'abcdef0123', 'synthetictoken654321']) expect(raw, v).not.toContain(v);
    expect(raw).toContain('utm_source=x');
    expect(raw).toContain('page=2');
    const parsed = parseNote(raw);
    expect(String(parsed.frontmatter.title)).toBe('Pricing [REDACTED]');
    const links = extractWikilinks(raw);
    expect(links).toHaveLength(1);
    expect(links[0]!.alias).toBe('pricing REDACTED');
    // Stable: the same input is unchanged on the next write.
    expect(writer.writeGenerated(note({ title: `Pricing ${secret}`, frontmatter: { source_ids: ['page_pricing'], url: `https://www.example.test/pricing/?utm_source=x&access_token=synthetictoken123456&sig=abcdef0123`, tags: [`seo-agent/${secret}`] }, body: `# Pricing ${secret}\n\n- Link: [[03 Keywords/pricing software|pricing ${secret}]]\n- URL: https://www.example.test/dl?token=synthetictoken654321&page=2\n` })).status).toBe('unchanged');
  });

  it('refuses a note path that contains a secret-like value (callers must plan names through noteFileName)', () => {
    const secret = `synthetic-path-secret-${Date.now()}`;
    registerSecret(secret);
    expect(() => writer.writeGenerated(note({ relPath: `02 Website/Pages/Pricing ${secret}.md` }))).toThrow(/secret-like value/);
    expect(existsSync(abs(`02 Website/Pages/Pricing ${secret}.md`))).toBe(false);
  });
});
