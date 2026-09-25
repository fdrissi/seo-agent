import { afterEach, describe, expect, it } from 'vitest';
import { matchesPageTypePattern, pageTypeRules, UrlReconciler } from '../../../src/seo/reconcile.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import { SeoSeeder } from '../../fixtures/seo/seed.js';

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

function setup(over: { site?: Record<string, unknown>; crawl?: Record<string, unknown> } = {}) {
  ctx = createTestContext({
    config: testSiteConfig({ ...(over.crawl ? { crawl: over.crawl } : {}), site: { allowedHostnames: ['www.example.test', 'example.test'], ...(over.site ?? {}) } } as never),
  });
  const seed = new SeoSeeder(ctx.db, ctx.siteId);
  const rec = new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock);
  return { seed, rec };
}

const pageIdOf = (rec: UrlReconciler, url: string) => {
  const r = rec.resolve(url);
  return r.status === 'resolved' ? r.pageId : null;
};

describe('URL reconciliation', () => {
  it('preserves raw URLs, merges only safe normalizations, and keeps meaningful variants distinct', () => {
    const { seed, rec } = setup();
    const raws = [
      'https://www.example.test/pricing?utm_source=news&utm_medium=email',
      'https://WWW.example.test/pricing',
      'https://www.example.test/pricing#plans',
      'https://www.example.test/pricing?plan=team',
      'https://www.example.test/Pricing',
      'https://www.example.test/pricing/',
      'https://www.example.test/de/pricing',
      'https://example.test/pricing',
      'http://www.example.test/pricing',
    ];
    seed.gscPage(raws.map((page) => ({ date: '2026-09-01', page, clicks: 1, impressions: 10, position: 3 })));
    const report = rec.run();
    expect(report.metricRows.gscPage).toMatchObject({ distinctRaw: 9, resolved: 9, unresolved: 0 });
    const base = pageIdOf(rec, 'https://www.example.test/pricing');
    expect(base).not.toBeNull();
    expect(pageIdOf(rec, raws[0]!)).toBe(base);
    expect(pageIdOf(rec, raws[1]!)).toBe(base);
    expect(pageIdOf(rec, raws[2]!)).toBe(base);
    for (const distinct of raws.slice(3)) expect(pageIdOf(rec, distinct)).not.toBe(base);
    expect(new Set(raws.slice(3).map((r) => pageIdOf(rec, r))).size).toBe(6);

    const aliases = ctx.db.all<{ alias_url: string; relation: string; confidence: string }>('SELECT alias_url, relation, confidence FROM url_aliases WHERE site_id = ? ORDER BY alias_url', [ctx.siteId]);
    expect(aliases.find((a) => a.alias_url === raws[0])).toMatchObject({ relation: 'tracking_params_removed', confidence: 'established' });
    expect(aliases.find((a) => a.alias_url === raws[1])).toMatchObject({ relation: 'host_case' });
    expect(aliases.find((a) => a.alias_url === raws[2])).toMatchObject({ relation: 'fragment_removed' });
    expect(aliases.find((a) => a.alias_url === raws[3])).toMatchObject({ relation: 'gsc_url', confidence: 'established' });

    // Metric rows carry the resolved page id; raw page strings are untouched.
    const rows = ctx.db.all<{ page: string; page_id: string }>('SELECT page, page_id FROM gsc_page_daily WHERE site_id = ?', [ctx.siteId]);
    expect(rows.map((r) => r.page).sort()).toEqual([...raws].sort());
    expect(rows.find((r) => r.page === raws[0])!.page_id).toBe(base);

    // Look-alikes without evidence are reported, not merged.
    expect(report.distinctVariants.length).toBeGreaterThan(0);
    expect(report.distinctVariants.flatMap((v) => v.differences)).toEqual(expect.arrayContaining(['www', 'scheme', 'trailing_slash', 'path_case']));
  });

  it('is idempotent: re-running does not duplicate pages or aliases', () => {
    const { seed, rec } = setup();
    seed.gscPage([{ date: '2026-09-01', page: 'https://www.example.test/a?utm_source=x', clicks: 1, impressions: 10, position: 2 }]);
    rec.run();
    const count = () => ctx.db.get<{ p: number; a: number }>('SELECT (SELECT COUNT(*) FROM pages WHERE site_id = ?) AS p, (SELECT COUNT(*) FROM url_aliases WHERE site_id = ?) AS a', [ctx.siteId, ctx.siteId])!;
    const first = count();
    const second = rec.run();
    expect(count()).toEqual(first);
    expect(second.pagesCreated).toBe(0);
  });

  it('merges www/non-www or http/https only on permanent redirect evidence', () => {
    const { seed, rec } = setup();
    const crawl = seed.crawl('own_site');
    seed.crawlResult(crawl, { requestedUrl: 'http://example.test/guide', finalUrl: 'https://www.example.test/guide', status: 200, redirectChain: [{ url: 'http://example.test/guide', status: 301 }, { url: 'https://example.test/guide', status: 308 }, { url: 'https://www.example.test/guide', status: 200 }] });
    seed.crawlResult(crawl, { requestedUrl: 'https://www.example.test/promo', finalUrl: 'https://www.example.test/sale', status: 200, redirectChain: [{ url: 'https://www.example.test/promo', status: 302 }, { url: 'https://www.example.test/sale', status: 200 }] });
    seed.gscPage([
      { date: '2026-09-01', page: 'http://example.test/guide', clicks: 2, impressions: 20, position: 4 },
      { date: '2026-09-01', page: 'https://www.example.test/guide', clicks: 5, impressions: 50, position: 3 },
      { date: '2026-09-01', page: 'https://www.example.test/promo', clicks: 1, impressions: 10, position: 9 },
    ]);
    const report = rec.run();
    expect(report.redirects).toMatchObject({ established: 1, probable: 1 });
    const guide = pageIdOf(rec, 'https://www.example.test/guide');
    expect(pageIdOf(rec, 'http://example.test/guide')).toBe(guide);
    expect(pageIdOf(rec, 'https://example.test/guide')).toBe(guide);
    // Temporary redirect: recorded as probable evidence, NOT merged.
    expect(pageIdOf(rec, 'https://www.example.test/promo')).not.toBe(pageIdOf(rec, 'https://www.example.test/sale'));
    const promoAlias = ctx.db.get<{ relation: string; confidence: string }>('SELECT relation, confidence FROM url_aliases WHERE site_id = ? AND alias_url = ?', [ctx.siteId, 'https://www.example.test/promo'])!;
    expect(promoAlias).toEqual({ relation: 'redirect', confidence: 'probable' });
    const lifecycle = ctx.db.get<{ lifecycle: string }>('SELECT lifecycle FROM pages WHERE site_id = ? AND url = ?', [ctx.siteId, 'http://example.test/guide'])!;
    expect(lifecycle.lifecycle).toBe('redirected');
    const rows = ctx.db.all<{ page_id: string }>("SELECT DISTINCT page_id FROM gsc_page_daily WHERE site_id = ? AND page LIKE '%/guide'", [ctx.siteId]);
    expect(rows).toEqual([{ page_id: guide }]);
  });

  it('downgrades stale redirect evidence when a newer crawl no longer redirects', () => {
    const { seed, rec } = setup();
    const c1 = seed.crawl('own_site', { startedAt: '2026-09-01T00:00:00Z' });
    seed.crawlResult(c1, { requestedUrl: 'https://www.example.test/old', finalUrl: 'https://www.example.test/new', status: 200, redirectChain: [{ url: 'https://www.example.test/old', status: 301 }, { url: 'https://www.example.test/new', status: 200 }], fetchedAt: '2026-09-01T00:00:00Z' });
    rec.run();
    expect(pageIdOf(rec, 'https://www.example.test/old')).toBe(pageIdOf(rec, 'https://www.example.test/new'));
    const c2 = seed.crawl('own_site', { startedAt: '2026-09-10T00:00:00Z' });
    seed.crawlResult(c2, { requestedUrl: 'https://www.example.test/old', status: 200, fetchedAt: '2026-09-10T00:00:00Z' });
    const r2 = rec.run();
    expect(r2.redirects.stale).toBe(1);
    expect(pageIdOf(rec, 'https://www.example.test/old')).not.toBe(pageIdOf(rec, 'https://www.example.test/new'));
  });

  it('merges on rel=canonical only when both pages agree, and never across different canonical targets', () => {
    const { seed, rec } = setup();
    const crawl = seed.crawl('own_site');
    // Agreement both ways: /shoes?color=red -> /shoes, /shoes self-canonical.
    seed.crawlResult(crawl, { requestedUrl: 'https://www.example.test/shoes?color=red', canonical: 'https://www.example.test/shoes' });
    seed.crawlResult(crawl, { requestedUrl: 'https://www.example.test/shoes', canonical: 'https://www.example.test/shoes' });
    // One-way: target declares no canonical.
    seed.crawlResult(crawl, { requestedUrl: 'https://www.example.test/a?v=2', canonical: 'https://www.example.test/a' });
    seed.crawlResult(crawl, { requestedUrl: 'https://www.example.test/a' });
    // Chain to a different target: never merged.
    seed.crawlResult(crawl, { requestedUrl: 'https://www.example.test/b?v=2', canonical: 'https://www.example.test/b' });
    seed.crawlResult(crawl, { requestedUrl: 'https://www.example.test/b', canonical: 'https://www.example.test/c' });
    // Google-selected canonical disagrees.
    seed.crawlResult(crawl, { requestedUrl: 'https://www.example.test/d?v=2', canonical: 'https://www.example.test/d' });
    seed.crawlResult(crawl, { requestedUrl: 'https://www.example.test/d', canonical: 'https://www.example.test/d' });
    seed.inspection({ url: 'https://www.example.test/d?v=2', googleCanonical: 'https://www.example.test/d?v=2' });
    const report = rec.run();
    expect(pageIdOf(rec, 'https://www.example.test/shoes?color=red')).toBe(pageIdOf(rec, 'https://www.example.test/shoes'));
    expect(pageIdOf(rec, 'https://www.example.test/a?v=2')).not.toBe(pageIdOf(rec, 'https://www.example.test/a'));
    expect(pageIdOf(rec, 'https://www.example.test/b?v=2')).not.toBe(pageIdOf(rec, 'https://www.example.test/b'));
    expect(pageIdOf(rec, 'https://www.example.test/d?v=2')).not.toBe(pageIdOf(rec, 'https://www.example.test/d'));
    expect(report.canonicals.established).toBe(1);
    expect(report.canonicals.probable).toBe(1);
    const b = ctx.db.get<{ confidence: string; evidence_json: string }>('SELECT confidence, evidence_json FROM url_aliases WHERE site_id = ? AND alias_url = ?', [ctx.siteId, 'https://www.example.test/b?v=2'])!;
    expect(b.confidence).toBe('unverified');
    expect(b.evidence_json).toMatch(/different canonical targets are never merged/);
  });

  it('applies configured aliases (exact and wildcard) as owner evidence', () => {
    const { seed, rec } = setup({
      site: {
        urlAliases: [
          { alias: 'https://www.example.test/old-pricing', canonical: 'https://www.example.test/pricing', evidence: 'owner: moved in 2026' },
          { alias: 'http://legacy.example.test/*', canonical: 'https://www.example.test/*', evidence: 'owner: legacy host retired' },
        ],
      },
    });
    seed.gscPage([
      { date: '2026-09-01', page: 'https://www.example.test/old-pricing', clicks: 1, impressions: 10, position: 5 },
      { date: '2026-09-01', page: 'https://www.example.test/pricing', clicks: 3, impressions: 30, position: 4 },
      { date: '2026-09-01', page: 'http://legacy.example.test/pricing', clicks: 1, impressions: 5, position: 6 },
    ]);
    const report = rec.run();
    expect(report.configured.applied).toBe(1);
    const pricing = pageIdOf(rec, 'https://www.example.test/pricing');
    expect(pageIdOf(rec, 'https://www.example.test/old-pricing')).toBe(pricing);
    expect(pageIdOf(rec, 'http://legacy.example.test/pricing')).toBe(pricing);
    expect(report.unresolved).toEqual([]);
  });

  it('never lets weaker automatic evidence overwrite a manual alias', () => {
    const { seed, rec } = setup();
    const target = seed.page('https://www.example.test/target');
    ctx.db.run("INSERT INTO url_aliases (id, site_id, page_id, alias_url, relation, confidence, evidence_json, source, created_at, updated_at) VALUES ('alias_manual', ?, ?, 'https://www.example.test/x', 'manual', 'established', '{}', 'owner', ?, ?)", [ctx.siteId, target, seed.now, seed.now]);
    const crawl = seed.crawl('own_site');
    seed.crawlResult(crawl, { requestedUrl: 'https://www.example.test/x', finalUrl: 'https://www.example.test/y', redirectChain: [{ url: 'https://www.example.test/x', status: 302 }, { url: 'https://www.example.test/y', status: 200 }] });
    const report = rec.run();
    expect(pageIdOf(rec, 'https://www.example.test/x')).toBe(target);
    expect(report.conflicts.some((c) => c.aliasUrl === 'https://www.example.test/x' && c.kept.relation === 'manual')).toBe(true);
  });

  it('resolves GA4 landing paths only with hostName and keeps "(not set)" explicit', () => {
    const { seed, rec } = setup();
    seed.gscPage([{ date: '2026-09-01', page: 'https://www.example.test/pricing', clicks: 1, impressions: 10, position: 5 }]);
    seed.ga4Landing([
      { date: '2026-09-01', landingPage: '/pricing?utm_source=x', hostName: 'www.example.test', sessions: 5 },
      { date: '2026-09-01', landingPage: '/pricing', hostName: '', sessions: 3 },
      { date: '2026-09-01', landingPage: '(not set)', hostName: 'www.example.test', sessions: 2 },
      { date: '2026-09-01', landingPage: '/pricing', hostName: 'staging.example.invalid', sessions: 1 },
      { date: '2026-09-01', landingPage: '/new-page', hostName: 'www.example.test', sessions: 4 },
    ]);
    const report = rec.run();
    const pricing = pageIdOf(rec, 'https://www.example.test/pricing');
    const rows = ctx.db.all<{ landing_page: string; host_name: string; page_id: string | null }>('SELECT landing_page, host_name, page_id FROM ga4_landing_daily WHERE site_id = ? ORDER BY landing_page, host_name', [ctx.siteId]);
    const find = (l: string, h: string) => rows.find((r) => r.landing_page === l && r.host_name === h)!;
    expect(find('/pricing?utm_source=x', 'www.example.test').page_id).toBe(pricing);
    expect(find('/pricing', '').page_id).toBeNull();
    expect(find('(not set)', 'www.example.test').page_id).toBeNull();
    expect(find('/pricing', 'staging.example.invalid').page_id).toBeNull();
    expect(find('/new-page', 'www.example.test').page_id).not.toBeNull();
    const reasons = Object.fromEntries(report.unresolved.map((u) => [u.raw, u.reason]));
    expect(reasons).toMatchObject({ '/pricing': 'missing_host', 'www.example.test (not set)': 'not_set', 'staging.example.invalid /pricing': 'host_not_allowed' });
    const newAlias = () => ctx.db.get<{ relation: string; confidence: string }>('SELECT relation, confidence FROM url_aliases WHERE site_id = ? AND alias_url = ?', [ctx.siteId, '//www.example.test/new-page'])!;
    expect(newAlias()).toEqual({ relation: 'ga4_path', confidence: 'probable' });
    expect(ctx.db.get<{ confidence: string }>('SELECT confidence FROM url_aliases WHERE site_id = ? AND alias_url = ?', [ctx.siteId, '//www.example.test/pricing?utm_source=x'])!.confidence).toBe('established');
    // Re-running without new evidence does not upgrade the assumed scheme.
    rec.run();
    expect(newAlias().confidence).toBe('probable');
    // Independent evidence (a crawl of the https URL) upgrades it.
    const crawl = seed.crawl('own_site');
    seed.crawlResult(crawl, { requestedUrl: 'https://www.example.test/new-page' });
    rec.run();
    expect(newAlias().confidence).toBe('established');
  });

  it('refuses to guess the scheme when both http and https pages exist without evidence', () => {
    const { seed, rec } = setup();
    seed.gscPage([
      { date: '2026-09-01', page: 'https://www.example.test/x', clicks: 1, impressions: 10, position: 5 },
      { date: '2026-09-01', page: 'http://www.example.test/x', clicks: 1, impressions: 10, position: 5 },
    ]);
    seed.ga4Landing([{ date: '2026-09-01', landingPage: '/x', hostName: 'www.example.test', sessions: 5 }]);
    const report = rec.run();
    expect(report.unresolved.find((u) => u.dataset === 'ga4_landing_daily')!.reason).toBe('ambiguous_scheme');
  });

  it('reports GSC URLs on hosts outside allowedHostnames as unresolved', () => {
    const { seed, rec } = setup();
    seed.gscPage([{ date: '2026-09-01', page: 'https://blog.example.test/post', clicks: 1, impressions: 10, position: 5 }]);
    const report = rec.run();
    expect(report.unresolved).toEqual([expect.objectContaining({ dataset: 'gsc_page_daily', reason: 'host_not_allowed', rows: 1 })]);
  });

  it('merges clean 301/308 migrations stored in the crawler row shape (first status on the redirecting row)', () => {
    const { seed, rec } = setup();
    const crawl = seed.crawl('own_site');
    // http -> https -> www, as the crawler stores it: redirecting row status 301, final row 200.
    seed.crawlerRedirect(crawl, 'http://example.test/guide', 'https://www.example.test/guide', {
      hops: [
        { url: 'http://example.test/guide', status: 301, location: 'https://example.test/guide' },
        { url: 'https://example.test/guide', status: 308, location: 'https://www.example.test/guide' },
      ],
    });
    // /docs -> /docs/ (trailing slash).
    seed.crawlerRedirect(crawl, 'https://www.example.test/docs', 'https://www.example.test/docs/', { hops: [{ url: 'https://www.example.test/docs', status: 308, location: 'https://www.example.test/docs/' }] });
    // A permanent redirect to a dead page is never merged.
    seed.crawlerRedirect(crawl, 'https://www.example.test/old', 'https://www.example.test/gone', { finalStatus: 410 });
    // An incomplete chain (final URL never fetched) is never merged.
    seed.crawlerRedirect(crawl, 'https://www.example.test/stuck', 'https://www.example.test/elsewhere', { finalStatus: null });
    seed.gscPage([
      { date: '2026-09-01', page: 'http://example.test/guide', clicks: 2, impressions: 20, position: 4 },
      { date: '2026-09-01', page: 'https://www.example.test/guide', clicks: 5, impressions: 50, position: 3 },
      { date: '2026-09-01', page: 'https://www.example.test/docs', clicks: 1, impressions: 9, position: 7 },
      { date: '2026-09-01', page: 'https://www.example.test/old', clicks: 1, impressions: 12, position: 8 },
    ]);
    const report = rec.run();
    expect(report.redirects).toMatchObject({ established: 2, unverified: 2 });
    const guide = pageIdOf(rec, 'https://www.example.test/guide');
    expect(pageIdOf(rec, 'http://example.test/guide')).toBe(guide);
    expect(pageIdOf(rec, 'https://example.test/guide')).toBe(guide);
    expect(pageIdOf(rec, 'https://www.example.test/docs')).toBe(pageIdOf(rec, 'https://www.example.test/docs/'));
    expect(ctx.db.all<{ page_id: string }>("SELECT DISTINCT page_id FROM gsc_page_daily WHERE site_id = ? AND page LIKE '%/guide'", [ctx.siteId])).toEqual([{ page_id: guide }]);
    // Redirect to a 410: recorded, not merged, judged by the final URL's own row (not the redirect's 301).
    const old = ctx.db.get<{ relation: string; confidence: string; evidence_json: string }>('SELECT relation, confidence, evidence_json FROM url_aliases WHERE site_id = ? AND alias_url = ?', [ctx.siteId, 'https://www.example.test/old'])!;
    expect(old).toMatchObject({ relation: 'redirect', confidence: 'unverified' });
    expect(JSON.parse(old.evidence_json)).toMatchObject({ firstStatus: 301, finalStatus: 410, note: expect.stringMatching(/redirect target returned 410 \(final URL's own crawl row/) });
    expect(pageIdOf(rec, 'https://www.example.test/old')).not.toBe(pageIdOf(rec, 'https://www.example.test/gone'));
    expect(ctx.db.get<{ lifecycle: string }>('SELECT lifecycle FROM pages WHERE site_id = ? AND url = ?', [ctx.siteId, 'https://www.example.test/gone'])!.lifecycle).not.toBe('active');
    const stuck = ctx.db.get<{ confidence: string; evidence_json: string }>('SELECT confidence, evidence_json FROM url_aliases WHERE site_id = ? AND alias_url = ?', [ctx.siteId, 'https://www.example.test/stuck'])!;
    expect(stuck.confidence).toBe('unverified');
    expect(JSON.parse(stuck.evidence_json).note).toMatch(/no status/);
  });

  it('judges canonical targets by their own response, never by a redirecting row', () => {
    const { seed, rec } = setup();
    const crawl = seed.crawl('own_site');
    // /old 301 -> /shoes (crawler shape); /shoes?color=red declares /shoes canonical; /shoes is self-canonical.
    seed.crawlerRedirect(crawl, 'https://www.example.test/old', 'https://www.example.test/shoes');
    seed.crawlResult(crawl, { requestedUrl: 'https://www.example.test/shoes?color=red', canonical: 'https://www.example.test/shoes' });
    const report = rec.run();
    expect(report.canonicals.established).toBe(1);
    expect(pageIdOf(rec, 'https://www.example.test/shoes?color=red')).toBe(pageIdOf(rec, 'https://www.example.test/shoes'));
  });

  it('applies same-host wildcard aliases regardless of observation order and stays idempotent', () => {
    const { seed, rec } = setup({ site: { urlAliases: [{ alias: 'https://www.example.test/old/*', canonical: 'https://www.example.test/new/*', evidence: 'owner: section moved' }] } });
    seed.gscPage([{ date: '2026-09-01', page: 'https://www.example.test/old/a', clicks: 1, impressions: 10, position: 5 }]);
    rec.run();
    // The target page does not exist yet: /old/a keeps its own identity (and gets an identity alias).
    expect(ctx.db.get<{ relation: string }>('SELECT relation FROM url_aliases WHERE site_id = ? AND alias_url = ?', [ctx.siteId, 'https://www.example.test/old/a'])!.relation).toBe('gsc_url');
    const oldOwn = pageIdOf(rec, 'https://www.example.test/old/a');
    // The target appears later: the owner's wildcard rule now merges /old/a despite its identity alias.
    seed.gscPage([{ date: '2026-09-02', page: 'https://www.example.test/new/a', clicks: 4, impressions: 40, position: 3 }]);
    rec.run();
    const target = pageIdOf(rec, 'https://www.example.test/new/a');
    expect(target).not.toBe(oldOwn);
    const r = rec.resolve('https://www.example.test/old/a?utm_source=mail');
    expect(r).toMatchObject({ status: 'resolved', pageId: target });
    expect(r.status === 'resolved' && r.steps.some((st) => st.relation === 'configured')).toBe(true);
    const rows = () => ctx.db.all<{ page: string; page_id: string }>('SELECT page, page_id FROM gsc_page_daily WHERE site_id = ? ORDER BY page', [ctx.siteId]);
    expect(rows().every((x) => x.page_id === target)).toBe(true);
    const snapshot = JSON.stringify(rows());
    rec.run();
    expect(JSON.stringify(rows())).toBe(snapshot);
    // A manual alias still outranks the wildcard rule.
    ctx.db.run("UPDATE url_aliases SET relation = 'manual', confidence = 'established', page_id = ?, source = 'owner' WHERE site_id = ? AND alias_url = ?", [oldOwn, ctx.siteId, 'https://www.example.test/old/a']);
    expect(pageIdOf(rec, 'https://www.example.test/old/a')).toBe(oldOwn);
  });

  it('dry run computes the report without writing anything', () => {
    const { seed, rec } = setup();
    seed.gscPage([{ date: '2026-09-01', page: 'https://www.example.test/a?utm_source=x', clicks: 1, impressions: 10, position: 2 }]);
    const report = rec.run({ dryRun: true });
    expect(report.pagesCreated).toBe(1);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pages WHERE site_id = ?', [ctx.siteId])!.n).toBe(0);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM url_aliases WHERE site_id = ?', [ctx.siteId])!.n).toBe(0);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM gsc_page_daily WHERE site_id = ? AND page_id IS NOT NULL', [ctx.siteId])!.n).toBe(0);
  });

  it('applies protected and excluded path flags from configuration', () => {
    const { seed, rec } = setup({ crawl: { protectedPaths: ['/pricing'], excludedPaths: ['/admin/*'] } });
    seed.gscPage([
      { date: '2026-09-01', page: 'https://www.example.test/pricing', clicks: 1, impressions: 10, position: 5 },
      { date: '2026-09-01', page: 'https://www.example.test/admin/login', clicks: 1, impressions: 10, position: 5 },
    ]);
    rec.run();
    const flags = ctx.db.all<{ path: string; is_protected: number; is_excluded: number }>('SELECT path, is_protected, is_excluded FROM pages WHERE site_id = ? ORDER BY path', [ctx.siteId]);
    expect(flags).toEqual([
      { path: '/admin/login', is_protected: 0, is_excluded: 1 },
      { path: '/pricing', is_protected: 1, is_excluded: 0 },
    ]);
  });
});

describe('page types (site.pageTypes, owner > config > inferred) (A6-03)', () => {
  const pageTypes = () => ctx.db.all<{ path: string; page_type: string | null; page_type_source: string | null }>('SELECT path, page_type, page_type_source FROM pages WHERE site_id = ? ORDER BY path', [ctx.siteId]);

  it('reads the schema shape and a map, and matches globs', () => {
    expect(pageTypeRules([{ match: '/products/*', type: 'Product' }, { match: '', type: 'x' }, { match: '/a', type: '' }])).toEqual([{ pattern: '/products/*', type: 'product' }]);
    expect(pageTypeRules({ '/pricing': 'offer' })).toEqual([{ pattern: '/pricing', type: 'offer' }]);
    expect(matchesPageTypePattern('/products/widget', '/products/*')).toBe(true);
    expect(matchesPageTypePattern('/pricing', '/pricing')).toBe(true);
    expect(matchesPageTypePattern('/pricing-old', '/pricing')).toBe(false);
    expect(matchesPageTypePattern('/shop/eu/widget', '/shop/*/widget')).toBe(true);
    expect(matchesPageTypePattern('/shop/eu/x/widget', '/shop/*/widget')).toBe(false);
    expect(matchesPageTypePattern('/shop/eu/x/widget', '/shop/**/widget')).toBe(true);
  });

  it('applies configured page types on every run, keeps owner types, and clears removed config types', () => {
    const { seed, rec } = setup({ site: { pageTypes: [{ match: '/pricing', type: 'offer' }, { match: '/products/*', type: 'product' }] } });
    seed.gscPage([
      { date: '2026-09-01', page: 'https://www.example.test/pricing', clicks: 1, impressions: 10, position: 5 },
      { date: '2026-09-01', page: 'https://www.example.test/products/widget', clicks: 1, impressions: 10, position: 5 },
      { date: '2026-09-01', page: 'https://www.example.test/blog/post', clicks: 1, impressions: 10, position: 5 },
    ]);
    const first = rec.run();
    expect(pageTypes()).toEqual([
      { path: '/blog/post', page_type: null, page_type_source: null },
      { path: '/pricing', page_type: 'offer', page_type_source: 'config' },
      { path: '/products/widget', page_type: 'product', page_type_source: 'config' },
    ]);
    expect(first.pageTypes).toMatchObject({ rules: 2, applied: 2, commercialPages: 2 });
    // Owner overrides the config type; an inferred type is replaced by nothing but a config rule.
    ctx.db.run("UPDATE pages SET page_type = 'tool', page_type_source = 'owner' WHERE site_id = ? AND path = '/pricing'", [ctx.siteId]);
    ctx.db.run("UPDATE pages SET page_type = 'article', page_type_source = 'inferred' WHERE site_id = ? AND path = '/blog/post'", [ctx.siteId]);
    const second = rec.run();
    expect(second.pageTypes).toMatchObject({ ownerKept: 1, applied: 0 });
    expect(pageTypes().find((p) => p.path === '/pricing')).toEqual({ path: '/pricing', page_type: 'tool', page_type_source: 'owner' });
    expect(pageTypes().find((p) => p.path === '/blog/post')).toEqual({ path: '/blog/post', page_type: 'article', page_type_source: 'inferred' });
    // The rule for /products/* is removed from the config: its config type is cleared; owner/inferred stay.
    const cfg = { ...ctx.config, site: { ...ctx.config.site, pageTypes: [{ match: '/blog/*', type: 'article' }] } };
    const third = new UrlReconciler(ctx.db, ctx.siteId, cfg, ctx.clock).run();
    expect(third.pageTypes).toMatchObject({ cleared: 1, applied: 1 });
    expect(pageTypes()).toEqual([
      { path: '/blog/post', page_type: 'article', page_type_source: 'config' },
      { path: '/pricing', page_type: 'tool', page_type_source: 'owner' },
      { path: '/products/widget', page_type: null, page_type_source: null },
    ]);
  });

  it('counts commercial pages with router.commercialPageTypes and never writes in a dry run', () => {
    ctx = createTestContext({ config: testSiteConfig({ site: { allowedHostnames: ['www.example.test'], pageTypes: [{ match: '/services/*', type: 'service' }] }, router: { commercialPageTypes: ['service'] } as never }) });
    const seed = new SeoSeeder(ctx.db, ctx.siteId);
    seed.gscPage([{ date: '2026-09-01', page: 'https://www.example.test/services/audit', clicks: 1, impressions: 10, position: 5 }]);
    const rec = new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock);
    const dry = rec.run({ dryRun: true });
    expect(dry.pageTypes).toMatchObject({ applied: 1, commercialPages: 1 });
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pages WHERE site_id = ?', [ctx.siteId])!.n).toBe(0);
    rec.run();
    expect(pageTypes()).toEqual([{ path: '/services/audit', page_type: 'service', page_type_source: 'config' }]);
  });
});

describe('percent-encoding identities (RFC 3986 6.2.2) (B3-05)', () => {
  // SYNTHETIC: example.test only. "/ru/%d0%bf%d1%80%d0%b8" is "/ru/при" with lowercase hex (as some CMSs emit it).
  const LOWER = 'https://www.example.test/ru/%d0%bf%d1%80%d0%b8';
  const UPPER = 'https://www.example.test/ru/%D0%BF%D1%80%D0%B8';
  const pageCount = () => ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pages WHERE site_id = ?', [ctx.siteId])!.n;

  it('joins lowercase-hex GSC URLs and decoded GA4 landing paths to one page', () => {
    const { seed, rec } = setup();
    seed.gscPage([
      { date: '2026-09-01', page: LOWER, clicks: 4, impressions: 40, position: 3 },
      { date: '2026-09-01', page: 'https://www.example.test/%7Eteam/', clicks: 1, impressions: 10, position: 5 },
    ]);
    seed.ga4Landing([
      { date: '2026-09-01', landingPage: '/ru/при', hostName: 'www.example.test', sessions: 6 },
      { date: '2026-09-01', landingPage: '/~team/', hostName: 'www.example.test', sessions: 2 },
    ]);
    const report = rec.run();
    expect(report.metricRows.gscPage).toMatchObject({ resolved: 2, unresolved: 0 });
    expect(report.metricRows.ga4Landing).toMatchObject({ resolved: 2, unresolved: 0 });
    expect(pageCount()).toBe(2);
    const ru = pageIdOf(rec, UPPER);
    expect(ru).not.toBeNull();
    expect(pageIdOf(rec, LOWER)).toBe(ru);
    expect(ctx.db.get<{ page_id: string }>('SELECT page_id FROM gsc_page_daily WHERE site_id = ? AND page = ?', [ctx.siteId, LOWER])!.page_id).toBe(ru);
    expect(ctx.db.get<{ page_id: string }>("SELECT page_id FROM ga4_landing_daily WHERE site_id = ? AND landing_page = '/ru/при'", [ctx.siteId])!.page_id).toBe(ru);
    const team = ctx.db.get<{ id: string; url: string }>("SELECT id, url FROM pages WHERE site_id = ? AND path = '/~team/'", [ctx.siteId])!;
    expect(team.url).toBe('https://www.example.test/~team/');
    expect(ctx.db.get<{ page_id: string }>("SELECT page_id FROM ga4_landing_daily WHERE site_id = ? AND landing_page = '/~team/'", [ctx.siteId])!.page_id).toBe(team.id);
    // The raw GSC string is preserved as an identity alias recording the percent-encoding change.
    const alias = ctx.db.get<{ relation: string; confidence: string; evidence_json: string }>('SELECT relation, confidence, evidence_json FROM url_aliases WHERE site_id = ? AND alias_url = ?', [ctx.siteId, LOWER])!;
    expect(alias).toMatchObject({ relation: 'gsc_url', confidence: 'established' });
    expect(JSON.parse(alias.evidence_json).changes).toEqual(['percent_encoding']);
    expect(report.identities).toEqual({ renormalized: 0, duplicates: [] });
  });

  it('keeps a page stored with the old (lowercase-hex) identity: same page id, URL re-normalized in place, no split', () => {
    const { seed, rec } = setup();
    // A page and its GSC rows written by an earlier version that kept the hex case as received.
    const legacyId = seed.page(LOWER, { firstSource: 'gsc' });
    seed.gscPage([{ date: '2026-09-01', page: LOWER, clicks: 4, impressions: 40, position: 3 }]);
    ctx.db.run('UPDATE gsc_page_daily SET page_id = ? WHERE site_id = ?', [legacyId, ctx.siteId]);
    seed.ga4Landing([{ date: '2026-09-01', landingPage: '/ru/при', hostName: 'www.example.test', sessions: 6 }]);

    // Before any run, lookups by the new identity fall back to the stored page (never a new one).
    expect(pageIdOf(rec, UPPER)).toBe(legacyId);
    expect(rec.observe(UPPER, 'crawl').status).toBe('resolved');
    expect(pageCount()).toBe(1);

    const report = rec.run();
    expect(report.identities).toEqual({ renormalized: 1, duplicates: [] });
    expect(pageCount()).toBe(1);
    expect(ctx.db.get<{ url: string; path: string }>('SELECT url, path FROM pages WHERE id = ?', [legacyId])).toEqual({ url: UPPER, path: '/ru/%D0%BF%D1%80%D0%B8' });
    expect(pageIdOf(rec, LOWER)).toBe(legacyId);
    expect(pageIdOf(rec, UPPER)).toBe(legacyId);
    expect(ctx.db.get<{ page_id: string }>('SELECT page_id FROM gsc_page_daily WHERE site_id = ?', [ctx.siteId])!.page_id).toBe(legacyId);
    expect(ctx.db.get<{ page_id: string }>('SELECT page_id FROM ga4_landing_daily WHERE site_id = ?', [ctx.siteId])!.page_id).toBe(legacyId);
    // The old string stays resolvable as an identity alias.
    expect(ctx.db.get<{ page_id: string; relation: string }>('SELECT page_id, relation FROM url_aliases WHERE site_id = ? AND alias_url = ?', [ctx.siteId, LOWER])).toMatchObject({ page_id: legacyId });
    // Idempotent.
    const again = rec.run();
    expect(again.identities).toEqual({ renormalized: 0, duplicates: [] });
    expect(again.pagesCreated).toBe(0);
    expect(pageCount()).toBe(1);
  });

  it('when a newer page already holds the new identity, the older page keeps it (with its history) and the newer one resolves to it', () => {
    const { seed, rec } = setup();
    const legacyId = seed.page(LOWER, { firstSource: 'gsc' });
    const newerId = seed.page(UPPER, { firstSource: 'crawl' });
    ctx.db.run("UPDATE pages SET first_seen_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", [legacyId]);
    seed.gscPage([{ date: '2026-09-01', page: LOWER, clicks: 4, impressions: 40, position: 3 }]);
    seed.ga4Landing([{ date: '2026-09-01', landingPage: '/ru/при', hostName: 'www.example.test', sessions: 6 }]);
    const report = rec.run();
    expect(pageCount()).toBe(2);
    expect(ctx.db.get<{ url: string }>('SELECT url FROM pages WHERE id = ?', [legacyId])!.url).toBe(UPPER);
    expect(ctx.db.get<{ url: string }>('SELECT url FROM pages WHERE id = ?', [newerId])!.url).toBe(LOWER);
    expect(report.identities!.renormalized).toBe(1);
    expect(report.identities!.duplicates).toEqual([expect.objectContaining({ duplicatePageId: newerId, duplicateUrl: LOWER, pageId: legacyId, pageUrl: UPPER })]);
    for (const u of [LOWER, UPPER]) expect(pageIdOf(rec, u)).toBe(legacyId);
    const resolvedDup = rec.resolve(LOWER);
    expect(resolvedDup.status).toBe('resolved');
    expect(ctx.db.get<{ page_id: string }>('SELECT page_id FROM gsc_page_daily WHERE site_id = ?', [ctx.siteId])!.page_id).toBe(legacyId);
    expect(ctx.db.get<{ page_id: string }>('SELECT page_id FROM ga4_landing_daily WHERE site_id = ?', [ctx.siteId])!.page_id).toBe(legacyId);
    // Not reported as a look-alike without evidence: it is the same identity.
    expect(report.distinctVariants).toEqual([]);
    // A second run changes nothing and reports the duplicate again for review.
    const again = rec.run();
    expect(again.identities!.renormalized).toBe(0);
    expect(again.identities!.duplicates.map((d) => d.duplicatePageId)).toEqual([newerId]);
    expect(ctx.db.get<{ url: string }>('SELECT url FROM pages WHERE id = ?', [legacyId])!.url).toBe(UPPER);
  });

  it('when the page holding the new identity is older, it keeps the identity and the stored-old page resolves to it', () => {
    const { seed, rec } = setup();
    const olderId = seed.page(UPPER, { firstSource: 'ga4' });
    const legacyId = seed.page(LOWER, { firstSource: 'gsc' });
    ctx.db.run("UPDATE pages SET first_seen_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", [olderId]);
    seed.gscPage([{ date: '2026-09-01', page: LOWER, clicks: 4, impressions: 40, position: 3 }]);
    const report = rec.run();
    expect(ctx.db.get<{ url: string }>('SELECT url FROM pages WHERE id = ?', [olderId])!.url).toBe(UPPER);
    expect(ctx.db.get<{ url: string }>('SELECT url FROM pages WHERE id = ?', [legacyId])!.url).toBe(LOWER);
    expect(report.identities).toEqual({ renormalized: 0, duplicates: [expect.objectContaining({ duplicatePageId: legacyId, pageId: olderId })] });
    expect(pageIdOf(rec, LOWER)).toBe(olderId);
    expect(ctx.db.get<{ page_id: string }>('SELECT page_id FROM gsc_page_daily WHERE site_id = ?', [ctx.siteId])!.page_id).toBe(olderId);
  });

  it('matches configured wildcard aliases and path flags across percent-encoding variants', () => {
    const { seed, rec } = setup({
      site: { urlAliases: [{ alias: 'https://www.example.test/%7eold/*', canonical: 'https://www.example.test/new/*', evidence: 'owner: section moved (synthetic)' }] },
      crawl: { protectedPaths: ['/%d0%bf/*'], excludedPaths: [] },
    });
    seed.gscPage([
      { date: '2026-09-01', page: 'https://www.example.test/new/x', clicks: 1, impressions: 10, position: 5 },
      { date: '2026-09-01', page: 'https://www.example.test/~old/x', clicks: 1, impressions: 10, position: 5 },
      { date: '2026-09-01', page: 'https://www.example.test/%D0%BF/y', clicks: 1, impressions: 10, position: 5 },
    ]);
    rec.run();
    expect(pageIdOf(rec, 'https://www.example.test/~old/x')).toBe(pageIdOf(rec, 'https://www.example.test/new/x'));
    expect(ctx.db.get<{ is_protected: number }>("SELECT is_protected FROM pages WHERE site_id = ? AND path = '/%D0%BF/y'", [ctx.siteId])!.is_protected).toBe(1);
  });
});
