import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseNote } from '../../../src/obsidian/frontmatter.js';
import { renderAll } from '../../../src/obsidian/notes.js';
import { extractWikilinks, formatWikilink, noteFileName, notePath, sanitizeLinkAlias, shortHash, tableSafeLink, wikilinkTarget } from '../../../src/obsidian/wikilinks.js';
import { createVaultWriter } from '../../../src/obsidian/writer.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { SEED_IDS, seedSyntheticVaultData } from '../../fixtures/obsidian/seed.js';

describe('path-aware wikilinks', () => {
  it('formats full vault paths with an alias (never shortest-path links)', () => {
    expect(formatWikilink('02 Website/Pages/Pricing.md', 'Pricing')).toBe('[[02 Website/Pages/Pricing|Pricing]]');
    expect(formatWikilink('02 Website/Pages/Pricing.md')).toBe('[[02 Website/Pages/Pricing|Pricing]]');
    expect(wikilinkTarget('03 Keywords/best shoes.md')).toBe('03 Keywords/best shoes');
  });

  it('keeps the .md extension for dotted names so they are not read as another file type', () => {
    expect(formatWikilink('04 Competitors/rival.example.test.md')).toBe('[[04 Competitors/rival.example.test.md|rival.example.test]]');
  });

  it('sanitizes aliases and rejects link-breaking targets', () => {
    expect(sanitizeLinkAlias('Pricing | Plans [[x]]\nnext')).toBe('Pricing Plans x next');
    expect(sanitizeLinkAlias('')).toBe('untitled');
    expect(() => formatWikilink('02 Website/Pages/A|B.md')).toThrow(/Unsafe/);
    expect(() => formatWikilink('02 Website/../secret.md')).toThrow(/Unsafe/);
    expect(() => formatWikilink('02 Website/Pages/Heading#x.md')).toThrow(/Unsafe/);
  });

  it('escapes pipes for table cells', () => {
    expect(tableSafeLink('[[a/b|c]]')).toBe('[[a/b\\|c]]');
  });
});

describe('readable file names', () => {
  it('removes characters that break links or paths', () => {
    expect(noteFileName('What is SEO? A/B test: #1 [guide] | 100%')).toBe('What is SEO A B test 1 guide 100');
    expect(noteFileName('../../etc/passwd')).toBe('etc passwd');
    expect(noteFileName('...')).toBe('untitled');
    expect(noteFileName('CON')).toBe('CON note');
    expect(noteFileName('trailing dots...')).toBe('trailing dots');
    expect(noteFileName('x.conflict-1')).toBe('x conflict-1');
  });

  it('builds note paths and deterministic short hashes', () => {
    expect(notePath('03 Keywords', 'pricing: software')).toBe('03 Keywords/pricing software.md');
    expect(shortHash('page_1')).toHaveLength(6);
    expect(shortHash('page_1')).toBe(shortHash('page_1'));
  });
});

describe('extractWikilinks', () => {
  it('extracts targets, aliases, subpaths, embeds, and table-escaped pipes', () => {
    const md = [
      'See [[02 Website/Pages/Pricing|Pricing]] and [[Notes#Heading]].',
      '| [[03 Keywords/a b\\|a b]] | x |',
      '![[image.png]]',
      '[[#Local heading]]',
    ].join('\n');
    const links = extractWikilinks(md);
    expect(links.map((l) => l.target)).toEqual(['02 Website/Pages/Pricing', 'Notes', '03 Keywords/a b', 'image.png', '']);
    expect(links[0]!.alias).toBe('Pricing');
    expect(links[1]!.subpath).toBe('#Heading');
    expect(links[2]!.alias).toBe('a b');
    expect(links[3]!.embed).toBe(true);
    expect(links[0]!.line).toBe(1);
  });

  it('ignores links in code blocks, inline code, and comments', () => {
    const md = ['```', '[[in fence]]', '```', 'text `[[inline code]]` <!-- [[html comment]] --> %% [[obsidian comment]] %%', '<!--', '[[multi-line comment]]', '-->', '[[real]]'].join('\n');
    expect(extractWikilinks(md).map((l) => l.target)).toEqual(['real']);
  });
});

describe('noteFileName never yields a hidden or unsafe name (A9-03)', () => {
  it('strips leading dots and whitespace repeatedly after separators collapse', () => {
    expect(noteFileName('. . . x')).toBe('x');
    expect(noteFileName('../../../../../x')).toBe('x');
    expect(noteFileName('../../../../../outside/pwned')).toBe('outside pwned');
    expect(noteFileName('.. .. .. x')).toBe('x');
    expect(noteFileName(' . .\u200B. hidden')).toBe('hidden');
    expect(noteFileName('.obsidian/plugins')).toBe('obsidian plugins');
    expect(noteFileName('. . .')).toBe('untitled');
    expect(noteFileName('trailing dots . . .')).toBe('trailing dots');
    for (const n of ['. . . x', '../../../../../x', '.. .. .. x', '...', ' .', './.', '.\t.\n.x']) {
      const out = noteFileName(n);
      expect(out.startsWith('.'), JSON.stringify(n)).toBe(false);
      expect(out.startsWith(' '), JSON.stringify(n)).toBe(false);
      expect(notePath('03 Keywords', n).split('/').every((seg) => !seg.startsWith('.'))).toBe(true);
    }
  });

  it('redacts secrets and credential URL parameters from names and aliases', () => {
    expect(noteFileName('reset (access_token=synthetictoken123456)')).toBe('reset (access_token=REDACTED)');
    // A closing parenthesis ends a masked value (src/security/redact.ts), so the name keeps it.
    expect(noteFileName('map (key=value123&sig=abc)')).toBe('map (key=REDACTED&sig=REDACTED)');
    expect(sanitizeLinkAlias('pricing ?token=synthetictoken123456')).toBe('pricing ?token=REDACTED');
    expect(noteFileName('download (token=synthetictoken123456&page=2)')).toBe('download (token=REDACTED&page=2)');
  });
});

/**
 * SYNTHETIC hostile titles (reserved .invalid domain): raw HTML, code spans with
 * Dataview inline queries, math, a Dataview inline field, a Templater tag, and
 * an Obsidian comment. Such text reaches wikilink aliases from imported or
 * Reddit content titles, Search Console queries, and scraped source titles.
 */
const HOSTILE_TITLE = 'Guide <iframe src="https://evil.invalid/x"></iframe><img src=x onerror=alert(1)> `$= dv.el("b", "x")` and ``= this.file.name`` $\\href{https://evil.invalid}{x}$ owner_ok:: yes <% tp.file.cursor() %> %%hidden%% \\';

/** Every alias of every `[[target|alias]]` / `[[target\\|alias]]` in a Markdown text. */
function aliasesOf(markdown: string): string[] {
  const out: string[] = [];
  for (const m of markdown.matchAll(/\[\[([^\]\n]*?)\]\]/g)) {
    const inner = m[1]!;
    const escaped = inner.indexOf('\\|');
    const pipe = escaped !== -1 ? escaped : inner.indexOf('|');
    if (pipe !== -1) out.push(inner.slice(pipe + (escaped !== -1 ? 2 : 1)));
  }
  return out;
}

function assertInertAlias(alias: string): void {
  expect(alias, alias).not.toMatch(/[<>`$\\]/);
  expect(alias, alias).not.toContain('::');
  expect(alias, alias).not.toContain('%%');
  expect(alias, alias).not.toMatch(/&(?![a-zA-Z][a-zA-Z0-9]*;|#\d+;|#[xX][0-9a-fA-F]+;)/);
}

describe('wikilink aliases are neutralized like body text (B4A2-03)', () => {
  it('escapes raw HTML and removes code spans, math, Dataview fields, Templater tags, and comments', () => {
    const a = sanitizeLinkAlias(HOSTILE_TITLE);
    assertInertAlias(a);
    expect(a).toContain('&lt;iframe src="https://evil.invalid/x"&gt;&lt;/iframe&gt;');
    expect(a).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(a).toContain("'&#36;= dv.el(\"b\", \"x\")'");
    expect(a).toContain("'= this.file.name'");
    expect(a).toContain('&#36;&#92;href{https://evil.invalid}{x}&#36;');
    expect(a).toContain('owner_ok: : yes');
    expect(a).toContain('&lt;% tp.file.cursor() %&gt;');
    expect(a).toContain('% %hidden% %');
    expect(a.endsWith('&#92;')).toBe(true);
    // Still free of wikilink-breaking characters, and idempotent.
    expect(sanitizeLinkAlias('a [[b]] | c\nd')).toBe('a b c d');
    expect(sanitizeLinkAlias(a)).toBe(a);
    expect(sanitizeLinkAlias('Tom &amp; Jerry & co')).toBe('Tom &amp; Jerry &amp; co');
    expect(sanitizeLinkAlias('%%%')).toBe('% % %');
    // Generated-region markers cannot be spelled in an alias.
    expect(sanitizeLinkAlias('seo-agent:generated:end')).not.toContain('seo-agent:generated');
  });

  it('formatWikilink and tableSafeLink carry the neutralized alias; the link still parses', () => {
    const link = formatWikilink('10 Content Opportunities/Guide.md', HOSTILE_TITLE);
    const parsed = extractWikilinks(link);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.target).toBe('10 Content Opportunities/Guide');
    assertInertAlias(parsed[0]!.alias!);
    const cellLink = extractWikilinks(`| ${tableSafeLink(link)} | x |`);
    expect(cellLink).toHaveLength(1);
    assertInertAlias(cellLink[0]!.alias!);
  });

  it('bidi embedding, override, and isolate controls become visible (U+XXXX) markers in aliases (C4-10)', () => {
    // SYNTHETIC: a right-to-left override would display "exe.txt" as "txt.exe".
    const spoof = 'invoice \u202Etxt.exe\u202C \u2067x\u2069';
    const a = sanitizeLinkAlias(spoof);
    expect(a).toBe('invoice (U+202E)txt.exe(U+202C) (U+2067)x(U+2069)');
    expect(sanitizeLinkAlias(a)).toBe(a); // idempotent
    expect(sanitizeLinkAlias('\u202A\u202B\u202D\u2066\u2068')).toBe('(U+202A)(U+202B)(U+202D)(U+2066)(U+2068)');
    // Legitimate right-to-left text and its marks are kept.
    expect(sanitizeLinkAlias('שלום \u200Fعالم\u200E')).toBe('שלום \u200Fعالم\u200E');
    const link = formatWikilink('03 Keywords/invoice txt.exe.md', spoof);
    expect(link).toBe('[[03 Keywords/invoice txt.exe.md|invoice (U+202E)txt.exe(U+202C) (U+2067)x(U+2069)]]');
    expect(extractWikilinks(link)).toHaveLength(1);
    expect(extractWikilinks(tableSafeLink(link))[0]!.alias).toBe('invoice (U+202E)txt.exe(U+202C) (U+2067)x(U+2069)');
    // File names drop the controls entirely (they are default-ignorable code points).
    expect(noteFileName(spoof)).toBe('invoice txt.exe x');
  });

  it('new note file names (link targets) carry no backticks', () => {
    expect(noteFileName('use `code` here')).toBe("use 'code' here");
    expect(noteFileName('``= this.file.name``')).not.toContain('`');
  });
});

describe('rendered index and table notes never carry raw HTML or code spans from untrusted titles (B4A2-03)', () => {
  let ctx: TestContext | undefined;
  afterEach(() => {
    ctx?.cleanup();
    ctx = undefined;
  });

  function allNotes(dir: string, rel = ''): string[] {
    const out: string[] = [];
    for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...allNotes(dir, r));
      else if (e.name.endsWith('.md')) out.push(r);
    }
    return out;
  }

  it('content, source, keyword, and competitor titles are inert in every alias and every generated region', () => {
    ctx = createTestContext();
    seedSyntheticVaultData(ctx.db, ctx.siteId);
    ctx.db.run('UPDATE content_items SET title = ? WHERE site_id = ? AND id = ?', [`Content ${HOSTILE_TITLE}`, ctx.siteId, SEED_IDS.contentItem]);
    ctx.db.run('UPDATE sources SET title = ? WHERE site_id = ? AND id = ?', [`Source ${HOSTILE_TITLE}`, ctx.siteId, SEED_IDS.source]);
    ctx.db.run('UPDATE keywords SET keyword = ? WHERE site_id = ? AND id = ?', [`query ${HOSTILE_TITLE}`, ctx.siteId, SEED_IDS.keyword]);
    ctx.db.run('UPDATE competitors SET name = ? WHERE site_id = ? AND id = ?', [`Rival ${HOSTILE_TITLE}`, ctx.siteId, SEED_IDS.competitor]);
    const writer = createVaultWriter(ctx);
    const r = renderAll(ctx, writer);
    expect(r.errors).toEqual([]);
    const notes = allNotes(writer.vaultDir);
    const read = (rel: string) => readFileSync(path.join(writer.vaultDir, ...rel.split('/')), 'utf8');
    // The index and the content-farm table link to the hostile-titled notes.
    const index = notes.find((n) => n === '00 Dashboard/Index.md')!;
    expect(index).toBeDefined();
    const indexAliases = aliasesOf(read(index));
    expect(indexAliases.some((a) => a.startsWith('Content Guide &lt;iframe'))).toBe(true);
    expect(indexAliases.some((a) => a.startsWith('Source Guide &lt;iframe'))).toBe(true);
    const tableNote = notes.find((n) => n.startsWith('11 Content Farm/'))!;
    expect(read(tableNote)).toMatch(/\| \[\[10 Content Opportunities\/[^\]]*\\\|Content Guide &lt;iframe/);
    let aliasCount = 0;
    for (const rel of notes) {
      const raw = read(rel);
      for (const a of aliasesOf(raw)) {
        assertInertAlias(a);
        aliasCount++;
      }
      const region = parseNote(raw).generatedRegion ?? '';
      expect({ rel, iframe: region.includes('<iframe'), img: region.includes('<img'), templater: region.includes('<%') }).toEqual({ rel, iframe: false, img: false, templater: false });
      // Body text shows backticks backslash-escaped (inline()); an unescaped one would open a code span / inline query.
      expect({ rel, codeSpan: region.split('\n').filter((l) => /(^|[^\\])`+(\$=|= this)/.test(l)) }).toEqual({ rel, codeSpan: [] });
      // New file names derived from the hostile titles carry no backticks, `<`, or `>`.
      expect(rel).not.toMatch(/[`<>]/);
    }
    expect(aliasCount).toBeGreaterThan(10);
  });

  it('a keyword with bidi controls shows visible markers in its H1, body, and every alias, never the raw controls (C4-10)', () => {
    ctx = createTestContext();
    seedSyntheticVaultData(ctx.db, ctx.siteId);
    // SYNTHETIC imported keyword with a right-to-left override and an isolate.
    ctx.db.run('UPDATE keywords SET keyword = ? WHERE site_id = ? AND id = ?', ['query \u202Etxt.exe\u202C \u2067x\u2069', ctx.siteId, SEED_IDS.keyword]);
    const writer = createVaultWriter(ctx);
    expect(renderAll(ctx, writer).errors).toEqual([]);
    const read = (rel: string) => readFileSync(path.join(writer.vaultDir, ...rel.split('/')), 'utf8');
    const rel = ctx.db.get<{ rel_path: string }>('SELECT rel_path FROM vault_notes WHERE site_id = ? AND note_id = ?', [ctx.siteId, SEED_IDS.keyword])!.rel_path;
    expect(rel).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    const region = parseNote(read(rel)).generatedRegion!;
    expect(region).toContain('# query \\[U+202E\\]txt.exe\\[U+202C\\] \\[U+2067\\]x\\[U+2069\\]');
    const indexAliases = aliasesOf(read('00 Dashboard/Index.md'));
    expect(indexAliases).toContain('query (U+202E)txt.exe(U+202C) (U+2067)x(U+2069)');
    for (const note of allNotes(writer.vaultDir)) {
      const body = parseNote(read(note)).body;
      expect({ note, bidi: /[\u202A-\u202E\u2066-\u2069]/.test(body) }).toEqual({ note, bidi: false });
    }
  });
});
