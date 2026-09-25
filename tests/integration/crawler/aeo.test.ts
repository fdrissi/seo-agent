import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppContext, type AppContext } from '../../../src/app/context.js';
import { register as registerCrawl } from '../../../src/cli/commands/crawl.js';
import { CliRuntime } from '../../../src/cli/runtime.js';
import { MemorySecretStore } from '../../../src/config/secrets.js';
import { workspacePaths } from '../../../src/config/paths.js';
import { initWorkspace } from '../../../src/config/workspace.js';
import { fixedClock, type Clock } from '../../../src/core/clock.js';
import { newId } from '../../../src/core/ids.js';
import { assessAeoForSite, assessAeoForUrl } from '../../../src/crawler/aeo.js';
import { crawlPage } from '../../../src/crawler/crawl.js';
import { SafeFetcher } from '../../../src/crawler/fetch.js';
import { fixtureTransport } from '../../../src/crawler/transport.js';
import { SsrfGuard } from '../../../src/security/ssrf.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import { fakeFetch } from '../../helpers/fake-fetch.js';
import { FAKE_PUBLIC_IP, fixture, mapResolver } from './helpers.js';

/** SYNTHETIC own site on the reserved www.example.test host, served in-process (no socket). */
function siteFetcher(): SafeFetcher {
  const html = { 'content-type': 'text/html; charset=utf-8' };
  const transport = fixtureTransport((raw) => {
    const u = new URL(raw);
    if (u.pathname === '/robots.txt') return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nAllow: /\n' };
    if (u.pathname === '/guide') return { status: 200, headers: html, body: fixture('pages/aeo-good.html') };
    if (u.pathname === '/widgets') return { status: 200, headers: html, body: fixture('pages/aeo-poor.html') };
    if (u.pathname === '/hidden') return { status: 200, headers: { ...html, 'x-robots-tag': 'noindex' }, body: fixture('pages/aeo-good.html') };
    return undefined;
  });
  return new SafeFetcher({ guard: new SsrfGuard({ resolver: mapResolver({ 'www.example.test': FAKE_PUBLIC_IP }) }), transport, userAgent: 'seo-agent-test/1.0 (+synthetic)', timeoutMs: 2_000, maxBytes: 200_000, maxRedirects: 3, perHostConcurrency: 1, delayMs: 0 });
}

/** SYNTHETIC Search Console page/query rows (is_synthetic = 0 so a core-profile context reads them). */
function insertPageQueries(ctx: AppContext, page: string, rows: Array<[string, number]>): void {
  const batch = newId('batch');
  const now = ctx.clock.now().toISOString();
  ctx.db.run(
    `INSERT INTO ingestion_batches (id, site_id, source, dataset, property, date_start, date_end, request_json, status, transformation_version, is_synthetic, started_at)
     VALUES (?, ?, 'gsc', 'gsc_page_query_daily', 'sc-domain:example.test', '2026-09-01', '2026-09-20', '{}', 'succeeded', 'test@1', 0, ?)`,
    [batch, ctx.siteId, now],
  );
  for (const [query, impressions] of rows) {
    ctx.db.run(
      `INSERT INTO gsc_page_query_daily (site_id, property, search_type, date, date_tz, page, query, clicks, impressions, ctr, position, aggregation_type, is_final, revision, is_current, row_hash, batch_id, collected_at, transformation_version, is_synthetic)
       VALUES (?, 'sc-domain:example.test', 'web', '2026-09-20', 'UTC', ?, ?, 2, ?, 0.01, 7.5, 'byPage', 1, 1, 1, ?, ?, ?, 'test@1', 0)`,
      [ctx.siteId, page, query, impressions, `h-${page}-${query}`, batch, now],
    );
  }
}

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
});

describe('AEO assessment over stored crawl results', () => {
  it('assesses a crawled page against its top Search Console queries and includes observed eligibility', async () => {
    ctx = createTestContext({ fetch: fakeFetch([]) });
    const r = await crawlPage(ctx, 'https://www.example.test/guide', { fetcher: siteFetcher() });
    expect(r.status).toBe('completed');
    insertPageQueries(ctx, 'https://www.example.test/guide', [
      ['widget pricing', 400],
      ['custom widget cost', 150],
    ]);
    const a = assessAeoForUrl(ctx, 'https://www.example.test/guide')!;
    expect(a.url).toBe('https://www.example.test/guide');
    expect(a.answer.status).toBe('ok');
    expect(a.answer.queries.map((q) => q.query)).toEqual(['widget pricing', 'custom widget cost']);
    expect(a.answer.source).toMatchObject({ property: 'sc-domain:example.test', end: '2026-09-20' });
    expect(a.headings.status).toBe('ok');
    expect(a.sections.status).toBe('ok');
    expect(a.evidence).toMatchObject({ status: 'ok', citationLinks: 1 }); // the twitter.com footer link is not a citation
    expect(a.eligibility).toMatchObject({ crawl: 'allowed', indexing: 'no_blocking_directive_observed', snippet: 'no_restriction_observed' });
    expect(a.counts).toEqual({ ok: 4, review: 0, unknown: 0 });
  });

  it('flags a weak page, and reports noindex through the eligibility assessor (now live code)', async () => {
    ctx = createTestContext({ fetch: fakeFetch([]) });
    await crawlPage(ctx, 'https://www.example.test/widgets', { fetcher: siteFetcher() });
    await crawlPage(ctx, 'https://www.example.test/hidden', { fetcher: siteFetcher() });
    const weak = assessAeoForUrl(ctx, 'https://www.example.test/widgets')!;
    expect(weak.answer.status).toBe('unknown'); // no Search Console rows: DATA_UNAVAILABLE, not a guess
    expect(weak.headings.generic).toEqual(expect.arrayContaining(['Introduction', 'More', 'Conclusion']));
    expect(weak.headings.empty).toBe(1);
    expect(weak.sections.backReferences.length).toBe(3);
    expect(weak.evidence.status).toBe('review');
    expect(weak.counts.review).toBe(3);
    const hidden = assessAeoForUrl(ctx, 'https://www.example.test/hidden')!;
    expect(hidden.eligibility).toMatchObject({ indexing: 'blocked_by_noindex', aiFeatures: 'not_eligible' });
    expect(assessAeoForUrl(ctx, 'https://www.example.test/never-crawled')).toBeNull();
  });

  it('assesses the pages of the latest own-site crawl (none yet: an honest note)', () => {
    ctx = createTestContext();
    const r = assessAeoForSite(ctx);
    expect(r).toMatchObject({ crawlId: null, pages: [] });
    expect(r.notes[0]).toMatch(/run `crawl` first/);
  });
});

describe('crawl CLI: aeo and competitor policy', () => {
  let root: string;
  const out: string[] = [];
  const err: string[] = [];

  async function run(...args: string[]): Promise<{ stdout: string; json: any }> {
    out.length = 0;
    err.length = 0;
    const cli = new CliRuntime({ out: (t) => out.push(t), err: (t) => err.push(t) }, { HOME: root });
    const program = new Command().option('-w, --workspace <dir>').option('-s, --site <id>').option('--dry-run').option('--json').option('--mode <mode>').option('--offline').exitOverride();
    registerCrawl(program, cli);
    try {
      await program.parseAsync(['node', 'seo-agent', '--workspace', root, ...args]);
    } catch {
      /* CliExit after rendering an error */
    }
    const stdout = out.join('\n');
    let json: any = null;
    try {
      json = JSON.parse(stdout);
    } catch {
      json = null;
    }
    return { stdout, json };
  }

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  function workspace(): { root: string; clock: Clock } {
    root = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-cli-aeo-'));
    initWorkspace(root, { allowInsideRepo: true });
    const cfg = testSiteConfig({ research: { approvedDomains: ['partner.test'] } as never });
    writeFileSync(path.join(workspacePaths(root).sitesDir, `${cfg.site.id}.yaml`), stringify(cfg));
    return { root, clock: fixedClock('2026-09-24T09:00:00.000Z') };
  }

  it('crawl aeo <url> reads stored results only; crawl aeo without a URL lists the latest crawl; unknown URL is NOT_FOUND', async () => {
    const w = workspace();
    const cfg = testSiteConfig({ research: { approvedDomains: ['partner.test'] } as never });
    const app = createAppContext({ workspaceRoot: w.root, siteId: cfg.site.id, config: cfg, secrets: new MemorySecretStore({}), clock: w.clock, offline: false, fetch: fakeFetch([]) });
    await crawlPage(app, 'https://www.example.test/widgets', { fetcher: siteFetcher() });
    app.db.close();
    const one = await run('--json', 'crawl', 'aeo', 'https://www.example.test/widgets');
    expect(one.json).toMatchObject({ label: 'HEURISTIC', url: 'https://www.example.test/widgets', headings: { status: 'review' } });
    const human = await run('crawl', 'aeo', 'https://www.example.test/widgets');
    expect(human.stdout).toMatch(/AEO assessment \(HEURISTIC/);
    expect(human.stdout).toMatch(/REVIEW headings: Headings to review/);
    expect(human.stdout).toMatch(/eligibility \(observed signals\): crawl allowed/);
    expect(human.stdout).toMatch(/not Google ranking rules/);
    const site = await run('--json', 'crawl', 'aeo');
    expect(site.json.pages).toEqual([]); // single-page crawls are not an own-site crawl
    expect(site.json.notes[0]).toMatch(/run `crawl` first/);
    const missing = await run('--json', 'crawl', 'aeo', 'https://www.example.test/never');
    expect(missing.json.error.code).toBe('NOT_FOUND');
  });

  it('crawl page includes an aeo field (null when nothing was fetched)', async () => {
    workspace();
    const r = await run('--json', '--offline', 'crawl', 'page', 'https://www.example.test/guide');
    expect(r.json.status).toBe('offline');
    expect(r.json).toHaveProperty('aeo', null);
  });

  it('crawl competitor needs --mode RESEARCH (policy external_research); a dry run is allowed in ANALYZE', async () => {
    workspace();
    const denied = await run('--json', 'crawl', 'competitor', 'https://www.partner.test/a');
    expect(denied.json.error.code).toBe('POLICY_DENIED');
    expect(denied.json.error.message).toMatch(/requires --mode RESEARCH/);
    const dry = await run('--json', '--dry-run', 'crawl', 'competitor', 'https://www.partner.test/a', 'https://other.test/b');
    expect(dry.json.status).toBe('dry_run');
    const by = Object.fromEntries(dry.json.pages.map((p: { url: string }) => [new URL(p.url).hostname, p]));
    expect(by['www.partner.test'].reason).toMatch(/^dry run: would fetch/);
    expect(by['other.test']).toMatchObject({ status: 'blocked', blockedReason: 'not_approved' });
    const offline = await run('--json', '--offline', '--mode', 'RESEARCH', 'crawl', 'competitor', 'https://www.partner.test/a');
    expect(offline.json.status).toBe('offline');
  });
});
