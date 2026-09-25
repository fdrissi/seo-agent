/**
 * D2-ACC-02: one writer for content notes. The `content` commands render the
 * content notes through the vault renderer (`renderAll` with only the content
 * kinds), so `content discover`, `content brief`, `content draft`, and
 * `vault render` produce exactly one note per item, brief, and draft and one
 * pipeline note. Content notes written by earlier versions of the commands
 * (their own paths and `content-item-*` / `content-brief-*` ids) are reported
 * by `vault check` as stale duplicates and marked stale by `vault render`.
 * SYNTHETIC scenario (tests/fixtures/content/seed.ts) on example.test domains.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../../src/cli/main.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { registerContentDepsFactory } from '../../../src/content/deps.js';
import { getItem, latestBrief, listItems } from '../../../src/content/store.js';
import { checkVault } from '../../../src/obsidian/check.js';
import { parseNote } from '../../../src/obsidian/frontmatter.js';
import { SUPERSEDED_BANNER_TITLE } from '../../../src/obsidian/stale.js';
import { GENERATED_END } from '../../../src/obsidian/types.js';
import { createVaultWriter } from '../../../src/obsidian/writer.js';
import { siteVaultDir } from '../../../src/config/paths.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { FakeApprovalGate, FakeLlm } from '../../fixtures/content/fakes.js';
import { classifyAllInformational, contentConfig, goodDraft, passingReview, seedSchedulingScenario } from '../../fixtures/content/seed.js';

let ctx: TestContext;
let approvals: FakeApprovalGate;
let llm: FakeLlm;

async function cli(args: string[]): Promise<{ out: string; err: string; code: number }> {
  let out = '';
  let err = '';
  const runtime = new CliRuntime({ out: (t) => (out += `${t}\n`), err: (t) => (err += `${t}\n`) }, { ...process.env, SEO_AGENT_WORKSPACE: ctx.paths.root });
  const program = await buildProgram(runtime);
  program.exitOverride();
  process.exitCode = 0;
  try {
    await program.parseAsync(['node', 'seo-agent', '--workspace', ctx.paths.root, ...args]);
  } catch (e) {
    if (!(e instanceof CliExit) && !(e as { code?: string }).code?.startsWith('commander.')) throw e;
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { out, err, code };
}

beforeEach(() => {
  ctx = createTestContext({ config: contentConfig() });
  approvals = new FakeApprovalGate();
  llm = new FakeLlm({ 'content.classify': classifyAllInformational, 'content.draft': () => goodDraft(), 'content.review': passingReview });
  // The real file-backed vault writer of the command's context (what the CLI wires by default).
  registerContentDepsFactory((c) => ({ llm, memory: null, approvals, vault: createVaultWriter(c) }));
});
afterEach(() => {
  registerContentDepsFactory(null);
  ctx.cleanup();
});

const vaultDir = () => siteVaultDir(ctx.paths, ctx.siteId);
const abs = (rel: string) => path.join(vaultDir(), ...rel.split('/'));
const read = (rel: string) => readFileSync(abs(rel), 'utf8');

/** Markdown notes in a vault folder (not recursive), excluding conflict artifacts. */
function notesIn(folder: string): string[] {
  const dir = abs(folder);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !/\.conflict-/.test(e.name))
    .map((e) => `${folder}/${e.name}`)
    .sort();
}

/** Every Markdown note in the vault (recursive). */
function allNotes(dir = vaultDir(), rel = ''): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return allNotes(path.join(dir, e.name), r);
    return e.isFile() && e.name.endsWith('.md') ? [r] : [];
  });
}

async function discoverAndBrief(): Promise<{ itemId: string; approvalId: string }> {
  seedSchedulingScenario(ctx);
  const disc = JSON.parse((await cli(['--json', 'content', 'discover'])).out);
  expect(disc.status).toBe('completed');
  expect(disc.notes.written).toBe(true);
  const item = listItems(ctx.db, ctx.siteId).find((i) => i.decision === 'improve_existing')!;
  expect(item).toBeDefined();
  const brief = JSON.parse((await cli(['--json', 'content', 'brief', item.id])).out);
  expect(brief.gate.passed).toBe(true);
  expect(brief.approvalRequest.status).toBe('pending');
  expect(brief.notes).toMatchObject({ written: true });
  return { itemId: item.id, approvalId: brief.approvalRequest.id };
}

describe('content notes have one writer: the vault renderer (D2-ACC-02)', () => {
  it('content discover, content brief, content draft, then vault render: exactly one note per item, brief, and draft, one pipeline note, no stale approval text', async () => {
    const { itemId, approvalId } = await discoverAndBrief();
    approvals.approve(approvalId);
    const draft = await cli(['--json', '--mode', 'DRAFT', 'content', 'draft', itemId, '--use-model']);
    expect(draft.code).toBe(0);
    expect(JSON.parse(draft.out).notes).toMatchObject({ written: true });

    const render = await cli(['--json', 'vault', 'render']);
    expect(render.code).toBe(0);
    const summary = JSON.parse(render.out);
    expect(summary.conflicts).toEqual([]);
    expect(summary.stale).toEqual([]);

    const items = listItems(ctx.db, ctx.siteId);
    // One opportunity note per item, and each carries the item id as its note id.
    const opportunities = notesIn('10 Content Opportunities');
    expect(opportunities).toHaveLength(items.length);
    expect(opportunities.map((p) => parseNote(read(p)).frontmatter.id).sort()).toEqual(items.map((i) => i.id).sort());
    // One brief note and one draft note for the item (every version is listed inside it).
    const title = getItem(ctx.db, ctx.siteId, itemId)!.title;
    expect(notesIn('05 Content/Briefs')).toEqual([`05 Content/Briefs/Brief - ${title}.md`]);
    expect(parseNote(read(`05 Content/Briefs/Brief - ${title}.md`)).frontmatter).toMatchObject({ id: `${itemId}.brief`, type: 'brief', brief_id: latestBrief(ctx.db, ctx.siteId, itemId)!.id });
    expect(notesIn('05 Content/Drafts')).toEqual([`05 Content/Drafts/Draft - ${title}.md`]);
    expect(parseNote(read(`05 Content/Drafts/Draft - ${title}.md`)).frontmatter).toMatchObject({ id: `${itemId}.draft`, type: 'draft' });
    // One pipeline note.
    expect(notesIn('11 Content Farm')).toEqual(['11 Content Farm/Pipeline.md']);

    // No note of the old parallel set, no duplicate ids, and no approval text that goes stale.
    const everything = allNotes();
    for (const rel of everything) {
      const raw = read(rel);
      expect(raw, rel).not.toMatch(/^id: "?content-(item|brief|draft|pipeline)-/m);
      expect(raw, rel).not.toMatch(/Draft approval: requested/);
    }
    const check = checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir: vaultDir() });
    expect(check.issues.filter((i) => i.code === 'duplicate_id' || i.code === 'stale_duplicate')).toEqual([]);
  });

  it('vault check flags a legacy content note as a stale duplicate; vault render marks it stale in place (human text kept, old approval text removed)', async () => {
    const { itemId, approvalId } = await discoverAndBrief();
    const item = getItem(ctx.db, ctx.siteId, itemId)!;
    const brief = latestBrief(ctx.db, ctx.siteId, itemId)!;
    const currentBrief = `05 Content/Briefs/Brief - ${item.title}.md`;
    expect(existsSync(abs(currentBrief))).toBe(true);

    // A brief note exactly as an earlier version of `content brief` wrote it (own path, own id, tracked).
    const legacyRel = `05 Content/Briefs/${item.title} ${item.id.slice(-6)} brief v${brief.version}.md`;
    const writer = createVaultWriter(ctx);
    expect(
      writer.writeGenerated({
        relPath: legacyRel,
        noteId: `content-brief-${brief.id}`,
        kind: 'content_brief',
        title: `Brief v${brief.version}: ${item.title}`,
        frontmatter: { id: `content-brief-${brief.id}`, kind: 'content_brief', site: ctx.siteId, content_item_id: item.id, brief_id: brief.id, version: brief.version, status: 'gate_passed' },
        body: `# Brief v${brief.version}: ${item.title}\n\n- Draft approval: requested (${approvalId}); approve via CLI`,
      }).status,
    ).toBe('created');
    writeFileSync(abs(legacyRel), `${read(legacyRel)}\nMy own notes on this brief (human).\n`);
    // An untracked legacy pipeline note (for example restored from a backup).
    writeFileSync(abs('11 Content Farm/Content Pipeline.md'), `---\nid: content-pipeline-${ctx.siteId}\ntype: content_pipeline\nsite: ${ctx.siteId}\n---\n# Content pipeline\n`);

    const before = JSON.parse((await cli(['--json', 'vault', 'check'])).out);
    const dup = before.issues.filter((i: { code: string }) => i.code === 'stale_duplicate');
    expect(dup).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'warning', relPath: legacyRel, target: currentBrief, detail: expect.stringMatching(/Stale duplicate: this content brief note \(id "content-brief-\w+"\) was written by an earlier version of the `content` commands.*The current note for the same record is 05 Content\/Briefs\/Brief - .*then delete this file/) }),
        expect.objectContaining({ severity: 'warning', relPath: '11 Content Farm/Content Pipeline.md', target: '11 Content Farm/Pipeline.md' }),
      ]),
    );
    expect(dup).toHaveLength(2);
    const human = await cli(['vault', 'check']);
    expect(human.out).toContain(`[warning] stale_duplicate ${legacyRel}: Stale duplicate`);

    const render = JSON.parse((await cli(['--json', 'vault', 'render'])).out);
    expect(render.stale).toEqual([expect.objectContaining({ relPath: legacyRel, kind: 'content_brief', status: 'updated', supersededBy: currentBrief })]);
    expect(render.detail).toContain('1 legacy duplicate content note(s) marked stale');
    const raw = read(legacyRel);
    const marked = parseNote(raw);
    expect(marked.frontmatter).toMatchObject({ id: `content-brief-${brief.id}`, type: 'content_brief', status: 'stale', superseded_by: currentBrief, content_item_id: item.id });
    expect(marked.frontmatter).not.toHaveProperty('brief_id');
    expect(marked.generatedRegion).toContain(SUPERSEDED_BANNER_TITLE);
    expect(marked.generatedRegion).toContain(`[[05 Content/Briefs/Brief - ${item.title}|`);
    expect(marked.generatedRegion).not.toMatch(/Draft approval: requested/);
    expect(raw.slice(raw.indexOf(GENERATED_END))).toContain('My own notes on this brief (human).');
    // The index lists it as a duplicate of the current note; the untracked note is left alone.
    expect(read('00 Dashboard/Index.md')).toMatch(/duplicate of \[\[05 Content\/Briefs\/Brief - /);
    expect(read('11 Content Farm/Content Pipeline.md')).toContain('# Content pipeline');

    // Idempotent: a second render (here through a content command) changes nothing.
    const again = JSON.parse((await cli(['--json', 'content', 'brief', itemId])).out);
    expect(again.notes.detail).toContain('1 legacy duplicate content note(s) marked stale');
    expect(read(legacyRel).replace(/^generated_at: .*$/m, '')).toBe(raw.replace(/^generated_at: .*$/m, ''));

    // Still reported until the owner deletes it; gone from the report afterwards.
    const after = checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir: vaultDir() });
    expect(after.issues.find((i) => i.relPath === legacyRel)?.detail).toMatch(/and is marked stale \(`vault render` removed its old generated content\)\. The current note for the same record is 05 Content\/Briefs\/Brief - /);
    expect(after.issues.filter((i) => i.code === 'stale_duplicate').map((i) => i.relPath).sort()).toEqual([legacyRel, '11 Content Farm/Content Pipeline.md'].sort());
    unlinkSync(abs(legacyRel));
    unlinkSync(abs('11 Content Farm/Content Pipeline.md'));
    expect(checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir: vaultDir() }).issues.filter((i) => i.code === 'stale_duplicate')).toEqual([]);
  });

  it('a legacy note whose current note does not exist yet names the render step', () => {
    const legacyRel = '10 Content Opportunities/Some item 123456.md';
    mkdirSync(abs('10 Content Opportunities'), { recursive: true });
    writeFileSync(abs(legacyRel), '---\nid: content-item-ci_legacy123456\ntype: content_item\ncontent_item_id: ci_legacy123456\n---\n# Some item\n');
    const r = checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir: vaultDir() });
    const issue = r.issues.find((i) => i.code === 'stale_duplicate')!;
    expect(issue).toMatchObject({ severity: 'warning', relPath: legacyRel });
    expect(issue.target).toBeUndefined();
    expect(issue.detail).toMatch(/run `npm run cli -- vault render --only content` to create it \(id "ci_legacy123456"\), then copy any text/);
  });
});
