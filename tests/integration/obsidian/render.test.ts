import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkVault } from '../../../src/obsidian/check.js';
import { parseNote } from '../../../src/obsidian/frontmatter.js';
import { buildNotes, planRender, renderAll } from '../../../src/obsidian/notes.js';
import { registerSecret } from '../../../src/security/redact.js';
import { GENERATED_END } from '../../../src/obsidian/types.js';
import { extractWikilinks } from '../../../src/obsidian/wikilinks.js';
import { createVaultWriter } from '../../../src/obsidian/writer.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import { findLiveSyntax } from '../../fixtures/obsidian/active-content.js';
import { SEED_IDS, seedSyntheticVaultData } from '../../fixtures/obsidian/seed.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

function setup(opts: { withGsc?: boolean; obsidian?: boolean } = {}) {
  ctx = createTestContext(opts.obsidian === false ? { config: testSiteConfig({ features: { obsidian: false } }) } : {});
  seedSyntheticVaultData(ctx.db, ctx.siteId, { withGsc: opts.withGsc ?? true });
  const writer = createVaultWriter(ctx);
  const read = (rel: string) => readFileSync(path.join(writer.vaultDir, ...rel.split('/')), 'utf8');
  return { ctx, writer, read };
}

function allNotes(vaultDir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.name.endsWith('.md')) out.push(r);
    }
  };
  walk(vaultDir, '');
  return out.sort();
}

describe('renderAll', () => {
  it('renders every note type from SQLite with stable ids and readable, path-aware links', () => {
    const { ctx, writer, read } = setup();
    const r = renderAll(ctx, writer);
    expect(r.status).toBe('rendered');
    expect(r.errors).toEqual([]);
    expect(r.counts.created).toBeGreaterThanOrEqual(16);
    const notes = allNotes(writer.vaultDir);
    for (const expected of [
      '00 Dashboard/Dashboard.md',
      '00 Dashboard/Index.md',
      '02 Website/Pages/Home.md',
      '02 Website/Pages/Pricing.md',
      '02 Website/Pages/Blog - how to test.md',
      '03 Keywords/pricing software.md',
      '04 Competitors/rival.example.test.md',
      '05 Content/Briefs/Brief - How to compare pricing plans.md',
      '05 Content/Drafts/Draft - How to compare pricing plans.md',
      '06 Experiments/2026-09-20 title_meta - Pricing.md',
      '08 Research/Sources/Rival pricing page.md',
      '09 AI Search/AI Citation Checks.md',
      '10 Content Opportunities/How to compare pricing plans.md',
      '11 Content Farm/Pipeline.md',
      '12 Decisions/2026-09-20 Start the pricing title test.md',
      '13 Learnings/Comparison-style titles may lift CTR on pricing pages.md',
    ]) {
      expect(notes).toContain(expected);
    }
    const pricing = parseNote(read('02 Website/Pages/Pricing.md'));
    expect(pricing.frontmatter).toMatchObject({ id: SEED_IDS.pagePricing, type: 'page', site: 'test-site', route: 'CTR_OPPORTUNITY', synthetic: true });
    expect(pricing.frontmatter.source_ids).toContain(SEED_IDS.source);
    const body = pricing.generatedRegion!;
    expect(body).toContain('[[03 Keywords/pricing software|pricing software]]');
    expect(body).toContain('[[04 Competitors/rival.example.test.md|Rival (synthetic)]]');
    expect(body).toContain('[[06 Experiments/2026-09-20 title_meta - Pricing|');
    expect(body).toContain('[[12 Decisions/2026-09-20 Start the pricing title test|');
    expect(body).toContain('[[08 Research/Sources/Rival pricing page|Rival pricing page]]');
    expect(body).toContain('CTR 2.52% (clicks ÷ impressions)');
    expect(body).toContain('these rows are NOT page totals');
    // Every generated wikilink is path-aware (contains a folder).
    for (const n of notes) for (const l of extractWikilinks(read(n))) expect(l.target).toContain('/');

    // Valid links: the vault check finds no broken or ambiguous links.
    const report = checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir: writer.vaultDir });
    expect(report.issues.filter((i) => i.code === 'broken_link' || i.code === 'ambiguous_link')).toEqual([]);
    expect(report.linksChecked).toBeGreaterThan(20);
  });

  it('a second render with unchanged data writes nothing', () => {
    const { ctx, writer } = setup();
    renderAll(ctx, writer);
    ctx.clock.advanceMs(3_600_000);
    const again = renderAll(ctx, writer);
    expect(again.counts).toEqual({ created: 0, updated: 0, unchanged: again.outcomes.length, conflict: 0 });
  });

  it('re-renders changed data while preserving human edits outside the markers', () => {
    const { ctx, writer, read } = setup();
    renderAll(ctx, writer);
    const file = path.join(writer.vaultDir, '02 Website', 'Pages', 'Pricing.md');
    writeFileSync(file, `${read('02 Website/Pages/Pricing.md')}\nOwner note: pricing page redesign planned for Q4.\n`);
    ctx.db.run("UPDATE route_decisions SET route = 'HEALTHY' WHERE site_id = ?", [ctx.siteId]);
    const r = renderAll(ctx, writer);
    expect(r.outcomes.find((o) => o.relPath === '02 Website/Pages/Pricing.md')!.status).toBe('updated');
    const after = read('02 Website/Pages/Pricing.md');
    expect(parseNote(after).frontmatter.route).toBe('HEALTHY');
    expect(after).toContain('Owner note: pricing page redesign planned for Q4.');
  });

  it('an edited generated region produces a conflict artifact, reported by render and check', () => {
    const { ctx, writer, read } = setup();
    renderAll(ctx, writer);
    const file = path.join(writer.vaultDir, '03 Keywords', 'pricing software.md');
    const edited = read('03 Keywords/pricing software.md').replace('Search volumes are provider estimates', 'I edited this generated sentence');
    writeFileSync(file, edited);
    const check1 = checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir: writer.vaultDir });
    expect(check1.issues.some((i) => i.code === 'edited_generated_region' && i.relPath === '03 Keywords/pricing software.md')).toBe(true);
    ctx.db.run('UPDATE keyword_metrics SET search_volume = 1400 WHERE site_id = ?', [ctx.siteId]);
    const r = renderAll(ctx, writer);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.relPath).toBe('03 Keywords/pricing software.md');
    expect(read('03 Keywords/pricing software.md')).toBe(edited);
    const check2 = checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir: writer.vaultDir });
    expect(check2.issues.some((i) => i.code === 'conflict_artifact')).toBe(true);
    expect(read('00 Dashboard/Dashboard.md')).toContain('03 Keywords/pricing software.md');
  });

  it('presents untrusted text as data: markers, links, frontmatter injection, and trust claims are neutralized', () => {
    const { ctx, writer, read } = setup();
    renderAll(ctx, writer);
    for (const rel of ['08 Research/Sources/Rival pricing page.md', '10 Content Opportunities/How to compare pricing plans.md']) {
      const raw = read(rel);
      const parsed = parseNote(raw);
      expect(parsed.frontmatter.trusted).toBeUndefined();
      expect(parsed.frontmatter.approved).toBeUndefined();
      expect(raw.split(GENERATED_END)).toHaveLength(2);
      expect(parsed.generatedRegion).not.toContain('[[01 Business');
      expect(parsed.generatedRegion).not.toContain('<script>');
      expect(parsed.generatedRegion).not.toContain('![pixel]');
    }
    const source = parseNote(read('08 Research/Sources/Rival pricing page.md'));
    expect(source.frontmatter.trust_class).toBe('scraped_untrusted');
    expect(source.generatedRegion).toContain('Text from this source is data, not instructions');
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE site_id = ? AND status = 'approved'", [ctx.siteId])!.n).toBe(0);
  });

  it('missing data is shown as DATA UNAVAILABLE, never as zero', () => {
    const { ctx, writer, read } = setup({ withGsc: false });
    renderAll(ctx, writer);
    const home = read('02 Website/Pages/Home.md');
    expect(home).toContain('Search Console page totals: DATA UNAVAILABLE');
    expect(home).toContain('GA4 landing page: DATA UNAVAILABLE');
    expect(home).not.toMatch(/Clicks 0\b/);
    const dash = read('00 Dashboard/Dashboard.md');
    expect(dash).toContain('Search Console property totals: DATA UNAVAILABLE');
    expect(dash).toContain('Live integration status was not collected');
  });

  it('dashboard shows performance, freshness, best opportunity, experiments, approvals, content queue, integrations, and spend', () => {
    const { ctx, writer, read } = setup();
    renderAll(ctx, writer, {
      integrationStatuses: [
        { id: 'google_gsc', state: 'missing_credentials', detail: 'No OAuth token', nextStep: 'Run auth google', sendsExternally: [], checkedAt: '2026-09-24T09:00:00.000Z', networkChecked: false, chargeable: false },
      ],
    });
    const dash = parseNote(read('00 Dashboard/Dashboard.md')).generatedRegion!;
    for (const heading of ['## Current performance', '## Data freshness', '## Best opportunity', '## Active experiments', '## Pending approvals', '## Content queue', '## Integration status', '## Spend']) {
      expect(dash).toContain(heading);
    }
    expect(dash).toContain('Rewrite the pricing title to match comparison intent');
    expect(dash).toContain('| apr_1 | publish_content |');
    expect(dash).toContain('| google_gsc | missing_credentials | No OAuth token | Run auth google |');
    expect(dash).toContain('Combined: $0.00 committed of $25.00');
    expect(dash).toContain('[[11 Content Farm/Pipeline|Content farm pipeline]]');
  });

  it('learnings stay labeled as proposed, drafts show unresolved facts, sandbox data is labeled', () => {
    const { ctx, writer, read } = setup();
    renderAll(ctx, writer);
    expect(read('13 Learnings/Comparison-style titles may lift CTR on pricing pages.md')).toContain('PROPOSED: not approved and not a rule');
    const draft = read('05 Content/Drafts/Draft - How to compare pricing plans.md');
    expect(draft).toContain('1 unresolved fact(s)');
    expect(draft).toContain('Publication is blocked');
    const kw = parseNote(read('03 Keywords/pricing software.md'));
    expect(kw.frontmatter.sandbox).toBe(true);
    expect(kw.generatedRegion).toContain('SANDBOX DATA');
  });

  it('respects features.obsidian = false with an honest disabled status', () => {
    const { ctx, writer } = setup({ obsidian: false });
    const r = renderAll(ctx, writer);
    expect(r.status).toBe('disabled');
    expect(r.detail).toMatch(/disabled/);
    expect(r.outcomes).toEqual([]);
  });

  it('--only renders a subset and links only to notes that exist', () => {
    const { ctx, writer } = setup();
    const r = renderAll(ctx, writer, { only: ['pages'] });
    expect(r.outcomes.every((o) => o.kind === 'page')).toBe(true);
    const report = checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir: writer.vaultDir });
    expect(report.issues.filter((i) => i.code === 'broken_link')).toEqual([]);
  });

  it('buildNotes previews notes without writing', () => {
    const { ctx, writer } = setup();
    const { notes } = buildNotes(ctx, writer);
    expect(notes.every((n) => n.note && !n.error)).toBe(true);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM vault_notes')!.n).toBe(0);
  });

  it('keeps file paths stable when titles change and disambiguates name collisions', () => {
    const { ctx, writer, read } = setup();
    renderAll(ctx, writer);
    ctx.db.run("UPDATE keywords SET keyword = 'Pricing Software (renamed)' WHERE site_id = ?", [ctx.siteId]);
    ctx.db.run(
      "INSERT INTO keywords (id, site_id, keyword, normalized, language, first_seen_at) VALUES ('kw_collide', ?, 'pricing software', 'pricing software x', 'en', '2026-09-21T00:00:00.000Z')",
      [ctx.siteId],
    );
    const r = renderAll(ctx, writer);
    expect(r.errors).toEqual([]);
    expect(parseNote(read('03 Keywords/pricing software.md')).frontmatter.id).toBe(SEED_IDS.keyword);
    const collide = r.outcomes.find((o) => o.noteId === 'kw_collide')!;
    expect(collide.relPath).toMatch(/^03 Keywords\/pricing software \([0-9a-f]{6}\)\.md$/);
  });
});


describe('untrusted text end to end', () => {
  it('scraped evidence, content signals, brief fields, and draft bodies never become links, fields, fences, or queries', () => {
    const { ctx, writer, read } = setup();
    const r = renderAll(ctx, writer);
    expect(r.errors).toEqual([]);
    for (const rel of [
      '08 Research/Sources/Rival pricing page.md',
      '10 Content Opportunities/How to compare pricing plans.md',
      '05 Content/Briefs/Brief - How to compare pricing plans.md',
      '05 Content/Drafts/Draft - How to compare pricing plans.md',
    ]) {
      const region = parseNote(read(rel)).generatedRegion!;
      expect({ rel, live: findLiveSyntax(region) }).toEqual({ rel, live: [] });
      // The hostile text is still shown (as data), not dropped.
      expect(region).toContain('verify your account');
      expect(region).toContain('dataviewjs');
    }
    const report = checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir: writer.vaultDir });
    expect(report.issues.filter((i) => i.code === 'broken_link' || i.code === 'ambiguous_link')).toEqual([]);
  });

  it('a hostile scraped source title is inert in the title property and the heading', () => {
    const { ctx, writer, read } = setup();
    ctx.db.run("UPDATE sources SET title = ? WHERE site_id = ? AND id = ?", ['[[01 Business/Business Profile]] [verify](obsidian://open?vault=x) Rival', ctx.siteId, SEED_IDS.source]);
    const r = renderAll(ctx, writer);
    expect(r.errors).toEqual([]);
    const src = r.outcomes.find((o) => o.noteId === SEED_IDS.source)!;
    const parsed = parseNote(read(src.relPath));
    expect(String(parsed.frontmatter.title)).not.toContain('[[');
    expect(String(parsed.frontmatter.title)).not.toContain('](');
    expect(String(parsed.frontmatter.title)).not.toContain('obsidian://');
    expect(parsed.generatedRegion).not.toContain('[[01 Business');
    expect(findLiveSyntax(parsed.generatedRegion!.replace(/\[\[[^\]]*\]\]/g, ''))).toEqual([]);
  });
});

describe('link targets are never left dangling', () => {
  it('--only does not link to a note whose file was deleted (even though it is still tracked)', () => {
    const { ctx, writer } = setup();
    renderAll(ctx, writer);
    unlinkSync(path.join(writer.vaultDir, '03 Keywords', 'pricing software.md'));
    ctx.db.run("UPDATE route_decisions SET route = 'HEALTHY' WHERE site_id = ?", [ctx.siteId]);
    const r = renderAll(ctx, writer, { only: ['pages'] });
    expect(r.outcomes.find((o) => o.relPath === '02 Website/Pages/Pricing.md')!.status).toBe('updated');
    const report = checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir: writer.vaultDir });
    expect(report.issues.filter((i) => i.code === 'broken_link' && i.relPath === '02 Website/Pages/Pricing.md')).toEqual([]);
  });

  it('a note that fails to build is withdrawn: no other note links to it', () => {
    const { ctx, writer } = setup();
    // A malformed (non-integer) money amount makes the keyword note fail to build.
    ctx.db.run('UPDATE keyword_metrics SET cpc_micros = 1.5 WHERE site_id = ?', [ctx.siteId]);
    const r = renderAll(ctx, writer);
    expect(r.errors.map((e) => e.key)).toEqual([`keyword:${SEED_IDS.keyword}`]);
    expect(r.withdrawn).toEqual([{ key: `keyword:${SEED_IDS.keyword}`, relPath: '03 Keywords/pricing software.md', reason: 'failed to build' }]);
    const report = checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir: writer.vaultDir });
    expect(report.issues.filter((i) => i.code === 'broken_link')).toEqual([]);
    expect(report.linksChecked).toBeGreaterThan(10);
  });

  it('a new note that fails to write is withdrawn, and notes that already linked to it are rewritten', () => {
    const { ctx, writer } = setup();
    mkdirSync(writer.vaultDir, { recursive: true });
    const outside = path.join(ctx.paths.root, 'outside-keywords');
    mkdirSync(outside);
    symlinkSync(outside, path.join(writer.vaultDir, '03 Keywords'));
    const r = renderAll(ctx, writer);
    expect(r.withdrawn.map((w) => w.key)).toEqual([`keyword:${SEED_IDS.keyword}`]);
    expect(r.errors.map((e) => e.key)).toEqual([`keyword:${SEED_IDS.keyword}`]);
    expect(readdirSync(outside)).toEqual([]);
    rmSync(path.join(writer.vaultDir, '03 Keywords'));
    const report = checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir: writer.vaultDir });
    expect(report.issues.filter((i) => i.code === 'broken_link')).toEqual([]);
    // The page note was written before the keyword failed and was rewritten without the link.
    const pricing = parseNote(readFileSync(path.join(writer.vaultDir, '02 Website', 'Pages', 'Pricing.md'), 'utf8')).generatedRegion!;
    expect(pricing).not.toContain('[[03 Keywords/');
    expect(pricing).toContain('pricing software');
  });
});

describe('counts and synthetic labels', () => {
  it('the content-farm active count uses every item, not only the listed ones', () => {
    const { ctx, writer, read } = setup();
    for (const n of [1, 2]) {
      ctx.db.run(
        `INSERT INTO content_items (id, site_id, title, stage, is_synthetic, created_at, updated_at) VALUES (?, ?, ?, 'drafted', 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
        [`ci_extra_${n}`, ctx.siteId, `Older drafted item ${n}`],
      );
    }
    renderAll(ctx, writer, { limits: { contentItems: 1 } });
    const farm = read('11 Content Farm/Pipeline.md');
    expect(farm).toContain('Active production items (briefed through exported): **3** · configured limit: 1 · OVER LIMIT');
    expect(farm).toContain('Showing the 1 most recently updated items');
  });

  it('synthetic performance checks and crawls are labeled inline', () => {
    const { ctx, writer, read } = setup();
    ctx.db.run(
      `INSERT INTO performance_checks (id, site_id, page_id, url, source, data_kind, field_scope, device, metrics_json, cache_key, is_synthetic, checked_at)
       VALUES ('perf_1', ?, ?, 'https://www.example.test/pricing/', 'fixture', 'lab', NULL, 'mobile', '{"lcp_ms":2100}', 'ck1', 1, '2026-09-20T08:00:00.000Z')`,
      [ctx.siteId, SEED_IDS.pagePricing],
    );
    renderAll(ctx, writer);
    const pricing = parseNote(read('02 Website/Pages/Pricing.md')).generatedRegion!;
    expect(pricing).toContain('| Kind | Device | Source | Checked | Metrics | Synthetic |');
    expect(pricing).toMatch(/\| lab \| mobile \| fixture \| 2026-09-20 \| lcp_ms: 2100 \| SYNTHETIC \|/);
    expect(pricing).toContain('(fixture) · SYNTHETIC crawl · HTTP 200');
    expect(parseNote(read('00 Dashboard/Dashboard.md')).generatedRegion!).toMatch(/\| crawl \/ own site \| completed \| - \| [^|]+ \| yes \|/);
  });
});

// ---------------------------------------------------------------------------
// Secrets never enter the vault (spec section 26; AGENTS.md). Credential-shaped
// values are generated at runtime (never committed), all data is SYNTHETIC.

function randomToken(n: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(randomBytes(n), (b) => alphabet[b % alphabet.length]).join('');
}

function allVaultText(vaultDir: string): { names: string[]; content: string } {
  const names: string[] = [];
  const parts: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      names.push(r);
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else parts.push(readFileSync(path.join(d, e.name), 'utf8'));
    }
  };
  walk(vaultDir, '');
  return { names, content: parts.join('\n') };
}

describe('secrets never enter the vault (A9-01)', () => {
  it('a keyword and page URLs carrying a registered secret, a ya29 token, an AIza key, and token=/sig= params never appear in vault files or file names', () => {
    const registered = `ZZSYNTH${randomToken(20)}`;
    registerSecret(registered);
    const ya29 = `ya29.${randomToken(32)}`;
    const aiza = `AIza${randomToken(35)}`;
    const tokenParam = randomToken(24);
    const sigParam = randomToken(18);
    const { ctx, writer } = setup();
    ctx.db.run("INSERT INTO keywords (id, site_id, keyword, normalized, language, first_seen_at) VALUES ('kw_secret', ?, ?, ?, 'en', '2026-09-21T00:00:00.000Z')", [ctx.siteId, `widget ${registered} pricing`, `widget ${registered.toLowerCase()} pricing`]);
    const pages: Array<[string, string]> = [
      ['page_reset', `https://www.example.test/reset?access_token=${ya29}`],
      ['page_map', `https://www.example.test/store-map?key=${aiza}`],
      ['page_dl', `https://www.example.test/download?file=guide.pdf&token=${tokenParam}&sig=${sigParam}`],
      ['page_reg', `https://www.example.test/partner/${registered}/offer`],
    ];
    for (const [id, url] of pages) {
      const u = new URL(url);
      ctx.db.run(
        `INSERT INTO pages (id, site_id, url, host, path, first_source, page_type, language, is_protected, lifecycle, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, 'www.example.test', ?, 'fixture', 'other', 'en', 0, 'active', '2026-09-21T00:00:00.000Z', '2026-09-21T00:00:00.000Z')`,
        [id, ctx.siteId, url, `${u.pathname}${u.search}`],
      );
    }
    const r = renderAll(ctx, writer);
    expect(r.status).toBe('rendered');
    expect(r.errors).toEqual([]);
    const created = r.outcomes.filter((o) => ['kw_secret', 'page_reset', 'page_map', 'page_dl', 'page_reg'].includes(o.noteId));
    expect(created).toHaveLength(5);
    const { names, content } = allVaultText(writer.vaultDir);
    for (const secret of [registered, ya29, aiza, tokenParam, sigParam]) {
      expect(names.join('\n'), `file name leaks ${secret.slice(0, 6)}`).not.toContain(secret);
      expect(names.join('\n').toLowerCase()).not.toContain(secret.toLowerCase());
      expect(content, `vault content leaks ${secret.slice(0, 6)}`).not.toContain(secret);
    }
    // The notes still exist and stay readable: the secret parts are masked, not the whole note.
    expect(content).toContain('widget [REDACTED] pricing');
    expect(content).toMatch(/access_token=\\?\[REDACTED\\?\]/);
    expect(content).toContain('file=guide.pdf');
    const kw = created.find((o) => o.noteId === 'kw_secret')!;
    expect(kw.relPath).toBe('03 Keywords/widget REDACTED pricing.md');
    // Wikilinks to the masked notes are intact (the index links every note).
    const check = checkVault({ db: ctx.db, siteId: ctx.siteId, vaultDir: writer.vaultDir });
    expect(check.issues.filter((i) => i.severity === 'error')).toEqual([]);
    // Re-rendering is stable (no churn from redaction).
    const again = renderAll(ctx, writer);
    expect(again.outcomes.filter((o) => o.status !== 'unchanged').map((o) => `${o.relPath}: ${o.status} ${o.reason ?? ''}`)).toEqual([]);
  });

  it('a note tracked under a path written before redaction is moved to a redacted path', () => {
    const registered = `ZZSYNTH${randomToken(20)}`;
    const { ctx, writer } = setup();
    ctx.db.run("INSERT INTO keywords (id, site_id, keyword, normalized, language, first_seen_at) VALUES ('kw_legacy', ?, ?, ?, 'en', '2026-09-21T00:00:00.000Z')", [ctx.siteId, `legacy ${registered} term`, `legacy ${registered.toLowerCase()} term`]);
    renderAll(ctx, writer); // not registered yet: the old behavior wrote the value into the name
    expect(readdirSync(path.join(writer.vaultDir, '03 Keywords')).join('\n')).toContain(registered);
    registerSecret(registered);
    const r = renderAll(ctx, writer);
    expect(r.errors).toEqual([]);
    const { names, content } = allVaultText(writer.vaultDir);
    expect(names.join('\n')).not.toContain(registered);
    expect(content).not.toContain(registered);
    expect(r.outcomes.find((o) => o.noteId === 'kw_legacy')!.relPath).toBe('03 Keywords/legacy REDACTED term.md');
  });
});

describe('untrusted names can never make a hidden file or abort the render (A9-03)', () => {
  it("titles such as '. . . x', '../../../../../x', and '.. .. .. x' become visible, safe names; the render completes", () => {
    const { ctx, writer } = setup();
    const hostile = ['. . . widget', '../../../../../outside/pwned', '.. .. .. widget two', ' . .hidden', '.obsidian/plugins/evil'];
    hostile.forEach((kw, i) => {
      ctx.db.run("INSERT INTO keywords (id, site_id, keyword, normalized, language, first_seen_at) VALUES (?, ?, ?, ?, 'en', '2026-09-21T00:00:00.000Z')", [`kw_hostile_${i}`, ctx.siteId, kw, `hostile ${i}`]);
    });
    const r = renderAll(ctx, writer);
    expect(r.status).toBe('rendered');
    expect(r.errors).toEqual([]);
    const paths = hostile.map((_, i) => r.outcomes.find((o) => o.noteId === `kw_hostile_${i}`)!.relPath);
    expect(paths).toEqual(['03 Keywords/widget.md', '03 Keywords/outside pwned.md', '03 Keywords/widget two.md', '03 Keywords/hidden.md', '03 Keywords/obsidian plugins evil.md']);
    const { names } = allVaultText(writer.vaultDir);
    expect(names.every((n) => n.split('/').every((seg) => !seg.startsWith('.')))).toBe(true);
    expect(readdirSync(path.dirname(writer.vaultDir)).some((n) => n.includes('pwned'))).toBe(false);
  });

  it('a path that is still unsafe (e.g. a tampered tracked path) falls back to a note-id-based name with a per-note error; the render completes', () => {
    const { ctx, writer, read } = setup();
    ctx.db.run("INSERT INTO keywords (id, site_id, keyword, normalized, language, first_seen_at) VALUES ('kw_tampered', ?, 'tampered keyword', 'tampered keyword', 'en', '2026-09-21T00:00:00.000Z')", [ctx.siteId]);
    ctx.db.run("INSERT INTO vault_notes (site_id, rel_path, note_id, kind, ownership) VALUES (?, '03 Keywords/.. .. x.md', 'kw_tampered', 'keyword', 'generated')", [ctx.siteId]);
    const r = renderAll(ctx, writer);
    expect(r.status).toBe('rendered');
    expect(r.errors).toEqual([{ key: 'keyword:kw_tampered', relPath: '03 Keywords/note kw_tampered.md', error: expect.stringMatching(/unsafe note name replaced by a note-id-based name \(.*Hidden files/) }]);
    expect(parseNote(read('03 Keywords/note kw_tampered.md')).frontmatter.id).toBe('kw_tampered');
    // Every other note was still written.
    expect(r.counts.created).toBeGreaterThanOrEqual(16);
    const { names } = allVaultText(writer.vaultDir);
    expect(names.every((n) => n.split('/').every((seg) => !seg.startsWith('.')))).toBe(true);
    // The plan records the problem per note.
    const { rc } = planRender(ctx, writer);
    expect(rc.plan.errors).toEqual([]); // the tracked row now points at the safe path
  });
});
