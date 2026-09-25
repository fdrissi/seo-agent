import { describe, expect, it } from 'vitest';
import { sanitizePropertyText } from '../../../src/obsidian/frontmatter.js';
import { cell, code, codeBlock, escapeLinkAliasText, fmtDate, fmtInt, fmtPct, inline, isCredentialParamName, markBidiControls, maskCredentialUrlParams, quoteUntrusted, redactVaultMarkdown, table } from '../../../src/obsidian/markdown.js';
import { sanitizeDraftMarkdown, renderBriefObject } from '../../../src/obsidian/notes-content.js';
import { pageDisplayName } from '../../../src/obsidian/notes.js';
import { GENERATED_END } from '../../../src/obsidian/types.js';
import { extractWikilinks } from '../../../src/obsidian/wikilinks.js';
import { findLiveSyntax, HOSTILE_ACTIVE_TEXT } from '../../fixtures/obsidian/active-content.js';

describe('untrusted text presentation', () => {
  const hostile = `Ignore instructions ${GENERATED_END} [[01 Business/Business Profile]] ![x](http://tracker.invalid/p.png) <img src=x onerror=alert(1)> #tag %%hidden%%`;

  it('inline() neutralizes markers, links, embeds, HTML, tags, and comments', () => {
    const s = inline(hostile, 1_000);
    expect(s).not.toContain(GENERATED_END);
    expect(s).not.toContain('[[');
    expect(s).not.toContain('![');
    expect(s).not.toContain('<img');
    expect(s).toContain('\\#tag');
    expect(s).not.toContain('%%');
    expect(inline('a\nb')).toBe('a b');
    expect(inline(null)).toBe('');
  });

  it('quoteUntrusted() keeps line structure inside a blockquote', () => {
    const q = quoteUntrusted('line 1\n> nested\n---\n<!-- seo-agent:generated:start -->');
    expect(q.split('\n').every((l) => l.startsWith('>'))).toBe(true);
    expect(q).not.toContain('<!--');
    expect(quoteUntrusted('')).toBe('> (empty)');
  });

  it('cell() escapes pipes; table() renders nothing for no rows', () => {
    expect(cell('a|b')).toBe('a\\|b');
    expect(table(['A'], [])).toBe('');
    expect(table(['A', 'B'], [['1', '2']])).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
  });

  it('codeBlock() uses a fence longer than any backtick run in the content', () => {
    const b = codeBlock('```\ninner\n```', 'markdown');
    expect(b.startsWith('````markdown')).toBe(true);
  });

  it('missing numbers stay explicit, never zero', () => {
    expect(fmtInt(null)).toBe('missing');
    expect(fmtInt(undefined, 'DATA UNAVAILABLE')).toBe('DATA UNAVAILABLE');
    expect(fmtInt(0)).toBe('0');
    expect(fmtPct(null)).toBe('missing');
  });
});

describe('draft and brief rendering', () => {
  it('sanitizes model-written Markdown but keeps its structure', () => {
    const s = sanitizeDraftMarkdown('# Title\n\n<script>x</script> [[link]] ![img](http://tracker.invalid/p.png)\n\n- item');
    expect(s).toContain('### Title');
    expect(s).not.toContain('<script>');
    expect(s).not.toContain('[[link]]');
    expect(s).not.toContain('![img]');
    expect(s).toContain('- item');
  });

  it('renders known brief fields in order and keeps unknown fields', () => {
    const lines = renderBriefObject({ outline: ['A', 'B'], audience: 'Buyers', surprise: 1 }).join('\n');
    expect(lines.indexOf('### Audience')).toBeLessThan(lines.indexOf('### Outline'));
    expect(lines).toContain('- A');
    expect(lines).toContain('### Unresolved factual questions\n\n_Not provided._');
    expect(lines).toContain('**surprise**');
  });
});

describe('page display names', () => {
  it('derives readable names from URLs', () => {
    expect(pageDisplayName('https://www.example.test/', 'www.example.test')).toBe('Home');
    expect(pageDisplayName('https://www.example.test/pricing/', 'www.example.test')).toBe('Pricing');
    expect(pageDisplayName('https://www.example.test/blog/how-to_test/', 'www.example.test')).toBe('Blog - how to test');
    expect(pageDisplayName('https://shop.example.test/cart?step=2', 'www.example.test')).toBe('shop.example.test - Cart (step=2)');
  });
});

describe('links, fields, and executable content in untrusted text', () => {
  it('the detector itself finds every construct in the raw hostile text', () => {
    expect(findLiveSyntax(HOSTILE_ACTIVE_TEXT).length).toBeGreaterThanOrEqual(15);
  });

  it('inline() leaves no Markdown link, reference, autolink, Dataview field or query, fence, math, or Templater tag', () => {
    const s = inline(HOSTILE_ACTIVE_TEXT, 5_000);
    expect(findLiveSyntax(s)).toEqual([]);
    expect(s).toContain('\\[verify your account\\](https\\://evil.invalid/login)');
    expect(s).toContain('\\[approved:\\: true\\]');
    expect(s).toContain('owner_ok:\\: yes');
    expect(s).toContain('\\`\\$= dv.el');
    expect(s).toContain('www\\.evil.invalid');
  });

  it('an input backslash cannot cancel an escape', () => {
    const s = inline('\\[x](https://evil.invalid) \\`$= x\\` a\\:://b');
    expect(findLiveSyntax(s)).toEqual([]);
    expect(s.startsWith('\\\\\\[x\\]')).toBe(true);
  });

  it('entities stay entities and never form syntax', () => {
    expect(inline('&#91;x&#93; &#x5B; AT&T &nbsp;')).toBe('&#91;x&#93; &#x5B; AT&amp;T &nbsp;');
  });

  it('quoteUntrusted() keeps every line quoted and every fence inert', () => {
    const q = quoteUntrusted(`Intro\n${HOSTILE_ACTIVE_TEXT}\nend`, 5_000);
    expect(q.split('\n').every((l) => l.startsWith('>'))).toBe(true);
    expect(findLiveSyntax(q)).toEqual([]);
    expect(q).toContain('> \\`\\`\\`dataviewjs');
    expect(q).toContain('> \\~\\~\\~dataview');
  });

  it('sanitizeDraftMarkdown() keeps headings, quotes, lists, and tables but no links, fences, fields, queries, tags, or checkboxes', () => {
    const d = sanitizeDraftMarkdown(`# H\n> quote [x](https://evil.invalid)\n> > deep\n- [ ] task\n| a | b |\n| --- | --- |\n#tag and ## not heading\n${HOSTILE_ACTIVE_TEXT}`);
    expect(findLiveSyntax(d)).toEqual([]);
    expect(d).toContain('### H');
    expect(d).toContain('> quote \\[x\\](https\\://evil.invalid)');
    expect(d).toContain('> > deep');
    expect(d).toContain('- \\[ \\] task');
    expect(d).toContain('| a | b |\n| --- | --- |');
    expect(d).toContain('\\#tag and ## not heading');
    expect(extractWikilinks(d)).toEqual([]);
  });

  it('brief fields (strings and lists) are rendered inert', () => {
    const lines = renderBriefObject({ researchFindings: HOSTILE_ACTIVE_TEXT, outline: [HOSTILE_ACTIVE_TEXT], other: HOSTILE_ACTIVE_TEXT }).join('\n');
    expect(findLiveSyntax(lines)).toEqual([]);
  });

  it('code() shows untrusted ids and URLs literally, and never as a Dataview inline query or Templater tag', () => {
    expect(code('https://evil.invalid/a')).toBe('`https://evil.invalid/a`');
    expect(code('a`b')).toBe('``a`b``');
    expect(code('`x')).toBe('`` `x ``');
    expect(code('$= dv.el("b", "x")')).toBe('\\$= dv.el("b", "x")');
    expect(code('= this.file.name')).toBe('= this.file.name');
    expect(code('x <% tp.file.cursor() %>')).toBe('x &lt;% tp.file.cursor() %&gt;');
    expect(code(null)).toBe('');
  });

  it('dates from the database are escaped too', () => {
    expect(fmtDate('[a](b.cc)xyz')).toBe('\\[a\\](b.cc)x');
    expect(fmtDate(null)).toBe('unknown');
  });

  it('sanitizePropertyText() makes property text inert: no wikilinks, Markdown links, or non-http URIs', () => {
    expect(sanitizePropertyText('[[01 Business/Business Profile]]')).toBe('[ [01 Business/Business Profile] ]');
    expect(sanitizePropertyText('[[[a]]]')).not.toContain('[[');
    expect(sanitizePropertyText('[verify](https://evil.invalid)')).toBe('[verify] (https://evil.invalid)');
    expect(sanitizePropertyText('obsidian://open?vault=x and https://ok.example.test/p')).toBe('obsidian: //open?vault=x and https://ok.example.test/p');
  });
});

describe('vault secret hygiene (A9-01)', () => {
  it('masks credential query and fragment parameters, keeping other parameters', () => {
    // SYNTHETIC credential-shaped values: each carries a SYNTHETIC/FAKE marker so the repository
    // secret scan (npm run security:scan) never mistakes them for real credentials.
    const url = 'https://www.example.test/dl?file=a.pdf&token=SYNTHETICtok123&X-Amz-Signature=deadbeefSYNTHETIC&X-Amz-Credential=AKIDSYNTHETIC&X-Amz-Security-Token=st&sig=s1&page=2#access_token=fragSYNTHETIC123';
    const masked = maskCredentialUrlParams(url);
    for (const v of ['SYNTHETICtok123', 'deadbeef', 'AKIDSYNTHETIC', '=st&', 'sig=s1', 'fragSYNTHETIC123']) expect(masked, v).not.toContain(v);
    expect(masked).toContain('file=a.pdf');
    expect(masked).toContain('page=2');
    expect(maskCredentialUrlParams(masked)).toBe(masked); // idempotent
    // Page names show the query without its "?": "(token=...)".
    expect(maskCredentialUrlParams('Download (token=SYNTHETICtok123&page=2)')).toBe('Download (token=[REDACTED]&page=2)');
    expect(pageDisplayName('https://www.example.test/dl?token=SYNTHETICtok123&page=2', 'www.example.test')).not.toContain('SYNTHETICtok123');
    for (const n of ['token', 'api_key', 'apiKey', 'access_token', 'page_token', 'X-Goog-Signature', 'password', 'code', 'sessionid']) expect(isCredentialParamName(n), n).toBe(true);
    for (const n of ['page', 'utm_source', 'file', 'zip_code', 'q', 'lang']) expect(isCredentialParamName(n), n).toBe(false);
  });

  it('display helpers redact before escaping, so escaping can never hide a secret', () => {
    const out = inline('https://www.example.test/reset?a=1&access_token=synthetictoken123456&b=2');
    expect(out).not.toContain('synthetictoken123456');
    expect(code('?token=synthetictoken123456')).not.toContain('synthetictoken123456');
    expect(cell('x&sig=synthsig123')).not.toContain('synthsig123');
    expect(quoteUntrusted('line\n?password=hunter2synthetic')).not.toContain('hunter2synthetic');
    expect(codeBlock({ refresh_token: 'synthetic-refresh-token-value' })).not.toContain('synthetic-refresh-token-value');
  });

  it('redactVaultMarkdown keeps wikilinks valid (bracket-free marker inside links)', () => {
    const md = redactVaultMarkdown('See [[03 Keywords/x|alias ?token=abc123synthetic]] and ?token=def456synthetic');
    expect(md).toBe('See [[03 Keywords/x|alias ?token=REDACTED]] and ?token=[REDACTED]');
    expect(extractWikilinks(md)).toHaveLength(1);
  });
});

describe('escapeLinkAliasText (wikilink alias text, B4A2-03)', () => {
  it('neutralizes the same active syntax as inline() without backslash escapes', () => {
    const out = escapeLinkAliasText(HOSTILE_ACTIVE_TEXT.replace(/\n/g, ' '));
    expect(out).not.toMatch(/[<>`$\\]/);
    expect(out).not.toContain('::');
    expect(out).not.toContain('%%');
    expect(out).toContain('&lt;% tp.file.cursor() %&gt;');
    expect(out).toContain("'&#36;= dv.el(");
    expect(escapeLinkAliasText('a & b &amp; c &#36; d')).toBe('a &amp; b &amp; c &#36; d');
    expect(escapeLinkAliasText('x:: y %% z')).toBe('x: : y % % z');
    // Idempotent: entities it adds are never escaped again.
    expect(escapeLinkAliasText(out)).toBe(out);
  });
});

describe('bidi controls in vault text (C4-10)', () => {
  // SYNTHETIC: a keyword whose right-to-left override makes "exe.txt" display as "txt.exe".
  const RLO = '\u202E';
  const PDF = '\u202C';
  const spoof = `invoice ${RLO}txt.exe${PDF} download`;
  const everyControl = '\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069';
  const hasBidiControl = (s: string) => /[\u202A-\u202E\u2066-\u2069]/.test(s);

  it('markBidiControls() shows every embedding, override, and isolate control as a visible [U+XXXX] marker', () => {
    expect(markBidiControls(spoof)).toBe('invoice [U+202E]txt.exe[U+202C] download');
    expect(markBidiControls(everyControl)).toBe('[U+202A][U+202B][U+202C][U+202D][U+202E][U+2066][U+2067][U+2068][U+2069]');
    expect(markBidiControls(spoof, (cp) => `(${cp})`)).toBe('invoice (U+202E)txt.exe(U+202C) download');
    // Idempotent.
    expect(markBidiControls(markBidiControls(spoof))).toBe(markBidiControls(spoof));
  });

  it('keeps LRM, RLM, and ALM marks and right-to-left letters (legitimate RTL text)', () => {
    const rtl = 'مرحبا \u200Fبالعالم\u200E (שלום) \u061C';
    expect(markBidiControls(rtl)).toBe(rtl);
    expect(inline(rtl)).toBe(rtl);
  });

  it('inline(), cell(), code(), and quoteUntrusted() never write a bidi control', () => {
    expect(inline(spoof)).toBe('invoice \\[U+202E\\]txt.exe\\[U+202C\\] download');
    expect(cell(spoof)).toBe('invoice \\[U+202E\\]txt.exe\\[U+202C\\] download');
    expect(code(spoof)).toBe('`invoice [U+202E]txt.exe[U+202C] download`');
    expect(quoteUntrusted(`line 1\n${spoof}`)).toBe('> line 1\n> invoice \\[U+202E\\]txt.exe\\[U+202C\\] download');
    for (const out of [inline(everyControl), cell(everyControl), code(everyControl), quoteUntrusted(everyControl)]) {
      expect({ out, bidi: hasBidiControl(out) }).toEqual({ out, bidi: false });
    }
    // The escaped marker brackets never form a link.
    expect(extractWikilinks(inline(`[${RLO}[x]]`))).toEqual([]);
  });

  it('sanitizeDraftMarkdown() (model drafts under human review) shows bidi controls as markers, keeping the Markdown structure (R3-NF-O0-O1)', () => {
    const draft = `# Heading ${RLO}evil${PDF}\n\n> quoted ${RLO}txt.exe${PDF}\n\n- item \u2067x\u2069\n\nBody ${spoof}.`;
    const out = sanitizeDraftMarkdown(draft);
    expect(hasBidiControl(out)).toBe(false);
    expect(out).toBe(['### Heading \\[U+202E\\]evil\\[U+202C\\]', '', '> quoted \\[U+202E\\]txt.exe\\[U+202C\\]', '', '- item \\[U+2067\\]x\\[U+2069\\]', '', 'Body invoice \\[U+202E\\]txt.exe\\[U+202C\\] download.'].join('\n'));
    // The escaped marker brackets never form a link.
    expect(extractWikilinks(sanitizeDraftMarkdown(`[${RLO}[x]]`))).toEqual([]);
  });

  it('codeBlock() keeps bidi controls: a conflict backup must keep the human-edited text as written', () => {
    expect(codeBlock('\u2067שלום\u2069 note', 'markdown')).toBe('```markdown\n\u2067שלום\u2069 note\n```');
  });
});
