import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../../../src/app/context.js';
import { createServices } from '../../../src/app/services.js';
import { approvedResearchDomains, competitorVolatilityTtl, crawlCompetitorPages, isApprovedHost, loadCompetitorText, normalizeDomainEntry } from '../../../src/crawler/competitor.js';
import { SafeFetcher } from '../../../src/crawler/fetch.js';
import { createCrawl, insertResult } from '../../../src/crawler/store.js';
import { competitorPageCheckText } from '../../../src/obsidian/notes-site.js';
import type { RenderContext } from '../../../src/obsidian/render-context.js';
import type { HttpTransport } from '../../../src/crawler/transport.js';
import { SsrfGuard } from '../../../src/security/ssrf.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import { fakeFetch } from '../../helpers/fake-fetch.js';
import { FAKE_PUBLIC_IP, fixture, mapResolver, send, startServer, testFetcher, type TestServer } from './helpers.js';

let server: TestServer;
let guideVersion = 1;

beforeAll(async () => {
  server = await startServer((req, res, url) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const p = url.pathname;
    if (host === 'blocked.test') {
      if (p === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n', { 'content-type': 'text/plain' });
      return send(res, 200, '<html><body>SHOULD NEVER BE FETCHED</body></html>');
    }
    if (host === 'rival.test') {
      if (p === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /private\n', { 'content-type': 'text/plain' });
      if (p === '/best-widgets') return send(res, 200, fixture('pages/competitor-injection.html'));
      if (p === '/guide')
        return send(
          res,
          200,
          guideVersion === 1
            ? '<html><head><title>Rival guide v1</title></head><body><main><h1>Guide</h1><p>Version one of a synthetic competitor guide about widgets.</p></main></body></html>'
            : '<html><head><title>Rival guide v2 (updated)</title></head><body><main><h1>Guide</h1><p>Version two adds a new synthetic comparison section and pricing notes.</p></main></body></html>',
        );
      if (p === '/walled') return send(res, 200, fixture('site/members.html'));
      if (p === '/header-login')
        return send(res, 200, '<html><head><title>Rival pricing</title></head><body><header><form><input type="text" name="u"><input type="password" name="p"><button>Sign in</button></form></header><main><h1>Pricing</h1><p>Short synthetic competitor pricing page.</p></main></body></html>');
      if (p === '/denied') return send(res, 403, 'Just a moment...', { 'cf-mitigated': 'challenge' });
      if (p === '/private/x') return send(res, 200, 'SHOULD NEVER BE FETCHED');
      if (p.startsWith('/p')) return send(res, 200, `<html><head><title>Rival ${p}</title></head><body><p>Synthetic competitor page ${p}.</p></body></html>`);
      return send(res, 404, 'nope');
    }
    return send(res, 404, 'unknown host');
  });
});

afterAll(async () => {
  await server.close();
});

let ctx: TestContext | null = null;
afterEach(() => {
  ctx?.cleanup();
  ctx = null;
  guideVersion = 1;
});

function compCtx(opts: { dryRun?: boolean; offline?: boolean; approvedDomains?: string[]; competitorCacheDays?: number } = {}): TestContext {
  const config = testSiteConfig({
    crawl: { requestDelayMs: 0 },
    research: {
      competitors: [{ domain: 'rival.test', name: 'Rival Widgets (synthetic)' }],
      approvedDomains: opts.approvedDomains ?? ['blocked.test', 'intranet.test'],
      ...(opts.competitorCacheDays !== undefined ? { dataforseo: { cacheDays: { competitor: opts.competitorCacheDays } } } : {}),
    } as never,
  });
  ctx = createTestContext({ config, ...(opts.offline ? {} : { fetch: fakeFetch([]) }), ...(opts.dryRun ? { dryRun: true } : {}) });
  return ctx;
}

const fetcher = () => testFetcher({ resolver: mapResolver({ 'rival.test': '127.0.0.1', 'blocked.test': '127.0.0.1', 'intranet.test': '10.0.0.8', 'other.test': '127.0.0.1' }) });
const at = (host: string, p: string) => `${server.origin(host)}${p}`;

let serpSeq = 0;
/** Store a SYNTHETIC SERP snapshot (as the DataForSEO research would) listing these URLs for the query. */
function seedSerp(c: TestContext, query: string, urls: string[], opts: { sandbox?: boolean } = {}): string {
  const id = `serp_test_${++serpSeq}`;
  c.db.run(
    `INSERT INTO serp_snapshots (id, site_id, keyword_id, query, provider, location_code, language_code, device, depth, parameter_hash, items_count, is_sandbox, collected_at)
     VALUES (?, ?, NULL, ?, 'dataforseo', 2840, 'en', 'desktop', 10, ?, ?, ?, ?)`,
    [id, c.siteId, query, `ph_${id}`, urls.length, opts.sandbox ? 1 : 0, c.clock.now().toISOString()],
  );
  urls.forEach((url, i) =>
    c.db.run(`INSERT INTO serp_results (snapshot_id, site_id, result_type, rank_group, rank_absolute, url, domain, title, is_own_site) VALUES (?, ?, 'organic', ?, ?, ?, ?, 'Synthetic result', 0)`, [
      id,
      c.siteId,
      i + 1,
      i + 1,
      url,
      new URL(url).hostname,
    ]),
  );
  return id;
}

describe('crawlCompetitorPages', () => {
  it('reports a robots-blocked competitor honestly: blocked status, no content, no invented data', async () => {
    const c = compCtx();
    const before = server.hits.length;
    const r = await crawlCompetitorPages(c, [{ url: at('blocked.test', '/page'), query: 'synthetic widgets' }], { fetcher: fetcher() });
    expect(r.status).toBe('failed');
    expect(r.nextStep).toMatch(/blocked or failed/);
    const p = r.pages[0]!;
    expect(p).toMatchObject({ status: 'blocked', blockedReason: 'robots', contentHash: null, title: null, wordCount: null, textRef: null, sourceId: null, changes: [] });
    expect(p.reason).toMatch(/No content was fetched or inferred/);
    expect(server.hits.slice(before).map((h) => `${h.host}${h.path}`)).toEqual(['blocked.test/robots.txt']);
    expect(c.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sources WHERE site_id = ? AND source_type = 'competitor_page'", [c.siteId])!.n).toBe(0);
    expect(c.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM competitor_changes WHERE site_id = ?', [c.siteId])!.n).toBe(0);
    const cp = c.db.get<{ last_content_hash: string | null; last_checked_at: string | null }>('SELECT last_content_hash, last_checked_at FROM competitor_pages WHERE site_id = ?', [c.siteId])!;
    expect(cp.last_content_hash).toBeNull();
    expect(cp.last_checked_at).toBeTruthy();
    const row = c.db.get<{ blocked_reason: string; robots_allowed: number; text_ref: string | null; page_id: string | null }>('SELECT blocked_reason, robots_allowed, text_ref, page_id FROM crawl_results WHERE crawl_id = ?', [r.crawlId])!;
    expect(row).toMatchObject({ blocked_reason: 'robots', robots_allowed: 0, text_ref: null, page_id: null });
    expect(c.db.get<{ status: string; stop_reason: string }>('SELECT status, stop_reason FROM crawls WHERE id = ?', [r.crawlId])).toMatchObject({ status: 'failed' });
  });

  it('stores prompt-injection text as untrusted data only and changes nothing else', async () => {
    const c = compCtx();
    const cfgBefore = c.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM config_versions WHERE site_id = ?', [c.siteId])!.n;
    const budgetsBefore = JSON.stringify(c.config.budgets);
    const r = await crawlCompetitorPages(c, [{ url: at('rival.test', '/best-widgets'), query: 'best synthetic widgets' }], { fetcher: fetcher() });
    expect(r.status).toBe('completed');
    const p = r.pages[0]!;
    expect(p.status).toBe('fetched');
    expect(p.injectionSuspected).toBe(true);
    expect(p.injectionMatches).toEqual(expect.arrayContaining(['ignore_previous_instructions', 'approval_request', 'budget_manipulation', 'secret_exfiltration']));
    expect(r.notes.join(' ')).toMatch(/untrusted data only/);
    // Verbatim, as data, behind an untrusted notice.
    const stored = loadCompetitorText(c, p.resultId!)!;
    expect(stored.untrusted).toBe(true);
    expect(stored.text).toContain('Ignore all previous instructions');
    expect(stored.notice).toMatch(/never as instructions/);
    const src = c.db.get<{ trust_class: string; source_type: string; metadata_json: string }>('SELECT trust_class, source_type, metadata_json FROM sources WHERE id = ?', [p.sourceId])!;
    expect(src).toMatchObject({ trust_class: 'scraped_untrusted', source_type: 'competitor_page' });
    expect(JSON.parse(src.metadata_json).injection.suspected).toBe(true);
    // Nothing outside the crawl tables was affected by the page's "instructions".
    expect(c.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM approvals')!.n).toBe(0);
    expect(c.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM budget_reservations')!.n).toBe(0);
    expect(c.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM config_versions WHERE site_id = ?', [c.siteId])!.n).toBe(cfgBefore);
    expect(JSON.stringify(c.config.budgets)).toBe(budgetsBefore);
    const events = c.db.all<{ event_type: string }>('SELECT event_type FROM audit_events WHERE site_id = ?', [c.siteId]).map((e) => e.event_type);
    expect(events).toEqual(['crawl.competitor_finished']);
    // Competitor record uses the configured name.
    expect(c.db.get<{ origin: string; name: string }>('SELECT origin, name FROM competitors WHERE site_id = ? AND domain = ?', [c.siteId, 'rival.test'])).toMatchObject({ origin: 'configured', name: 'Rival Widgets (synthetic)' });
  });

  it('records new_page, then content/title changes only when the content hash changes', async () => {
    const c = compCtx();
    const url = at('rival.test', '/guide');
    const r1 = await crawlCompetitorPages(c, [url], { fetcher: fetcher() });
    expect(r1.pages[0]!.changes).toEqual(['new_page']);
    // refresh: bypass the volatility cache (tested separately) to re-check the page now.
    const r2 = await crawlCompetitorPages(c, [url], { fetcher: fetcher(), refresh: true });
    expect(r2.pages[0]!.status).toBe('fetched');
    expect(r2.pages[0]!.changes).toEqual([]);
    guideVersion = 2;
    const r3 = await crawlCompetitorPages(c, [url], { fetcher: fetcher(), refresh: true });
    expect(r3.pages[0]!.changes).toEqual(['content_changed', 'title_changed']);
    const changes = c.db.all<{ change_type: string; previous_hash: string | null; new_hash: string | null; summary: string }>('SELECT change_type, previous_hash, new_hash, summary FROM competitor_changes WHERE site_id = ? ORDER BY detected_at, change_type', [c.siteId]);
    expect(changes.map((x) => x.change_type).sort()).toEqual(['content_changed', 'new_page', 'title_changed']);
    const cc = changes.find((x) => x.change_type === 'content_changed')!;
    expect(cc.previous_hash).toBe(r1.pages[0]!.contentHash);
    expect(cc.new_hash).toBe(r3.pages[0]!.contentHash);
    expect(changes.find((x) => x.change_type === 'title_changed')!.summary).toMatch(/Rival guide v1.*Rival guide v2/);
    expect(c.db.get<{ last_content_hash: string }>('SELECT last_content_hash FROM competitor_pages WHERE site_id = ? AND url = ?', [c.siteId, url])!.last_content_hash).toBe(r3.pages[0]!.contentHash);
  });

  it('stops at login walls, bot challenges, robots-disallowed paths, and unsafe destinations', async () => {
    const c = compCtx();
    const before = server.hits.length;
    const r = await crawlCompetitorPages(
      c,
      [at('rival.test', '/walled'), at('rival.test', '/denied'), at('rival.test', '/private/x'), at('intranet.test', '/'), at('rival.test', '/guide')],
      { fetcher: fetcher() },
    );
    const by = (p: string) => r.pages.find((x) => x.url.endsWith(p))!;
    expect(by('/walled')).toMatchObject({ status: 'blocked', blockedReason: 'login_required', httpStatus: 200 });
    // Honest wording: the sign-in page was fetched (HTTP 200) but its text was not stored or used.
    expect(by('/walled').reason).toMatch(/Login barrier \(heuristic\): HTTP 200 .*not stored, analysed, or used/);
    expect(by('/walled').reason).not.toMatch(/No content was fetched/);
    expect(by('/denied')).toMatchObject({ status: 'blocked', blockedReason: 'access_denied', httpStatus: 403 });
    expect(by('/denied').reason).toMatch(/bot-protection challenge/);
    expect(by('/private/x')).toMatchObject({ status: 'blocked', blockedReason: 'robots' });
    expect(r.pages.find((x) => x.url.includes('intranet.test'))).toMatchObject({ status: 'blocked', blockedReason: 'unsafe_url' });
    expect(by('/guide').status).toBe('fetched');
    expect(r.status).toBe('partial');
    // A header sign-in widget on a short page is not a login wall.
    const widget = await crawlCompetitorPages(c, [at('rival.test', '/header-login')], { fetcher: fetcher() });
    expect(widget.pages[0]).toMatchObject({ status: 'fetched', title: 'Rival pricing' });
    const paths = server.hits.slice(before).map((h) => `${h.host}${h.path}`);
    expect(paths).not.toContain('rival.test/private/x');
    expect(paths.some((x) => x.startsWith('intranet.test'))).toBe(false);
    expect(paths.filter((x) => x === 'rival.test/denied')).toHaveLength(1); // no retries around protections
  });

  it('selects at most 5 pages per serious query by default, clamps to the configured max of 10, and skips own-site URLs', async () => {
    const c = compCtx({ dryRun: true });
    const targets = [
      ...Array.from({ length: 7 }, (_, i) => ({ url: at('rival.test', `/p${i}`), query: 'query a' })),
      ...Array.from({ length: 2 }, (_, i) => ({ url: at('rival.test', `/q${i}`), query: 'query b' })),
      { url: 'https://www.example.test/own-page', query: 'query a' },
      { url: 'ftp://rival.test/file', query: 'query b' },
    ];
    const r = await crawlCompetitorPages(c, targets);
    expect(r.status).toBe('dry_run');
    expect(r.maxPerQuery).toBe(5);
    const wouldFetch = r.pages.filter((p) => p.reason?.startsWith('dry run'));
    expect(wouldFetch.filter((p) => p.query === 'query a')).toHaveLength(5);
    expect(wouldFetch.filter((p) => p.query === 'query b')).toHaveLength(2);
    expect(r.pages.filter((p) => p.reason?.includes('per-query limit'))).toHaveLength(2);
    expect(r.pages.find((p) => p.url.includes('www.example.test'))!.reason).toMatch(/own-site/);
    expect(r.pages.find((p) => p.url.startsWith('ftp:'))!.reason).toMatch(/not an http/);
    const clamped = await crawlCompetitorPages(c, Array.from({ length: 12 }, (_, i) => ({ url: at('rival.test', `/p${i}`), query: 'a' })), { maxPerQuery: 12 });
    expect(clamped.maxPerQuery).toBe(10);
    expect(clamped.notes[0]).toMatch(/clamped to 10/);
    expect(clamped.pages.filter((p) => p.reason?.startsWith('dry run'))).toHaveLength(10);
    expect(c.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM crawls')!.n).toBe(0);
  });

  it('does not touch the network offline', async () => {
    const c = compCtx({ offline: true });
    const r = await crawlCompetitorPages(c, [at('rival.test', '/guide')]);
    expect(r.status).toBe('offline');
    expect(r.pages[0]!.status).toBe('skipped');
  });
});

describe('competitor research scope (research.competitors / research.approvedDomains)', () => {
  it('normalizes approved domain entries and matches subdomains only', () => {
    expect(normalizeDomainEntry('https://www.Rival.test/path?q=1')).toBe('rival.test');
    expect(normalizeDomainEntry('*.partner.test:443')).toBe('partner.test');
    expect(normalizeDomainEntry('   ')).toBeNull();
    expect(isApprovedHost('blog.partner.test', ['partner.test'])).toBe(true);
    expect(isApprovedHost('www.partner.test', ['partner.test'])).toBe(true);
    expect(isApprovedHost('notpartner.test', ['partner.test'])).toBe(false);
    const c = compCtx({ approvedDomains: ['https://www.partner.test/'] });
    expect(approvedResearchDomains(c).sort()).toEqual(['partner.test', 'rival.test']);
  });

  it('refuses a manual URL outside the approved scope without any request; the same URL from a SERP (with a query) is allowed', async () => {
    const c = compCtx();
    const before = server.hits.length;
    const r = await crawlCompetitorPages(c, [at('other.test', '/page')], { fetcher: fetcher(), origin: 'manual' });
    expect(r.status).toBe('failed');
    expect(r.pages[0]).toMatchObject({ status: 'blocked', blockedReason: 'not_approved', resultId: null, contentHash: null });
    expect(r.pages[0]!.reason).toMatch(/not in research\.competitors or research\.approvedDomains/);
    expect(r.nextStep).toMatch(/research\.approvedDomains/);
    expect(server.hits.slice(before)).toEqual([]); // not even robots.txt
    expect(c.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM competitors WHERE site_id = ?', [c.siteId])!.n).toBe(0);
    expect(c.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM crawls WHERE site_id = ?', [c.siteId])!.n).toBe(0);
    // The refusal no longer suggests --query as a way around the scope.
    expect(r.pages[0]!.reason).not.toMatch(/pass the shortlisted query/);
    // SERP-discovered (listed in a stored SERP snapshot of the shortlisted query) stays allowed.
    seedSerp(c, 'Synthetic  Widgets', [at('other.test', '/page')]);
    const serp = await crawlCompetitorPages(c, [{ url: at('other.test', '/page'), query: 'synthetic widgets' }], { fetcher: fetcher() });
    expect(serp.pages[0]!.blockedReason).not.toBe('not_approved');
    expect(serp.pages[0]!.scope).toBe('serp_snapshot');
    expect(server.hits.slice(before).some((h) => h.host === 'other.test')).toBe(true);
    expect(c.db.get<{ origin: string }>('SELECT origin FROM competitors WHERE site_id = ? AND domain = ?', [c.siteId, 'other.test'])!.origin).toBe('serp_discovered');
  });

  it('with --query, refuses a URL that no stored SERP snapshot of that query lists (any text can be passed as a query); nothing is fetched (B6-10)', async () => {
    const c = compCtx();
    // A SERP exists for a different query, and a sandbox SERP for this one: neither counts (live context).
    seedSerp(c, 'other synthetic query', [at('other.test', '/page')]);
    seedSerp(c, 'made up query', [at('other.test', '/page')], { sandbox: true });
    const before = server.hits.length;
    const r = await crawlCompetitorPages(c, [{ url: at('other.test', '/page'), query: 'made up query' }], { fetcher: fetcher(), origin: 'serp_discovered' });
    expect(r.status).toBe('failed');
    expect(r.pages[0]).toMatchObject({ status: 'blocked', blockedReason: 'not_approved', query: 'made up query', resultId: null });
    expect(r.pages[0]!.reason).toMatch(/not in a stored live SERP snapshot for the query "made up query"/);
    expect(r.pages[0]!.reason).toMatch(/--manual-urls/);
    expect(r.nextStep).toMatch(/only URLs listed in a stored SERP snapshot/);
    expect(server.hits.slice(before)).toEqual([]); // not even robots.txt
    expect(c.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM competitors WHERE site_id = ?', [c.siteId])!.n).toBe(0);
    expect(c.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM crawls WHERE site_id = ?', [c.siteId])!.n).toBe(0);
    // Approved hosts stay crawlable with any query (the host is in the owner's configured scope).
    const approved = await crawlCompetitorPages(c, [{ url: at('rival.test', '/guide'), query: 'made up query' }], { fetcher: fetcher() });
    expect(approved.pages[0]).toMatchObject({ status: 'fetched', scope: 'approved_domain' });
  });

  it('a sandbox SERP snapshot counts only in a synthetic (demo) context', async () => {
    const c = compCtx({ dryRun: true });
    seedSerp(c, 'synthetic sandbox query', [at('other.test', '/page')], { sandbox: true });
    const live = await crawlCompetitorPages(c, [{ url: at('other.test', '/page'), query: 'synthetic sandbox query' }]);
    expect(live.pages[0]).toMatchObject({ status: 'blocked', blockedReason: 'not_approved' });
    const demo = await crawlCompetitorPages({ ...c, synthetic: true } as AppContext, [{ url: at('other.test', '/page'), query: 'synthetic sandbox query' }]);
    expect(demo.status).toBe('dry_run');
    expect(demo.pages[0]).toMatchObject({ status: 'skipped', scope: 'serp_snapshot' });
  });

  it('--manual-urls crawls a query URL on the owner\'s word: recorded in the audit log and as manual, never as SERP-discovered', async () => {
    const c = compCtx();
    const url = at('other.test', '/page');
    const before = server.hits.length;
    const r = await crawlCompetitorPages(c, [{ url, query: 'synthetic widgets' }], { fetcher: fetcher(), origin: 'manual', manualUrls: true });
    // Requested (the synthetic server answers 404 for this host): in scope, not refused.
    expect(r.pages[0]).toMatchObject({ status: 'failed', httpStatus: 404, blockedReason: null, scope: 'manual_urls', query: 'synthetic widgets' });
    expect(server.hits.slice(before).some((h) => h.host === 'other.test' && h.path === '/page')).toBe(true);
    expect(r.notes.join(' ')).toMatch(/--manual-urls/);
    // The note counts outcomes (C4-11): the page was requested but not fetched (HTTP 404).
    expect(r.notes.join(' ')).toMatch(/0 of 1 manual page\(s\) fetched on the owner's word .*; 0 blocked, 1 failed\./);
    const audit = c.db.all<{ event_type: string; details_json: string; subject_id: string }>("SELECT event_type, details_json, subject_id FROM audit_events WHERE site_id = ? AND event_type = 'crawl.competitor_manual_urls'", [c.siteId]);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.subject_id).toBe(r.crawlId);
    expect(JSON.parse(audit[0]!.details_json)).toMatchObject({ flag: 'manual_urls', pages: [{ url, query: 'synthetic widgets' }] });
    const finished = c.db.get<{ details_json: string }>("SELECT details_json FROM audit_events WHERE site_id = ? AND event_type = 'crawl.competitor_finished'", [c.siteId])!;
    expect(JSON.parse(finished.details_json).manualUrls).toBe(1);
    const extraction = c.db.get<{ extraction_json: string }>('SELECT extraction_json FROM crawl_results WHERE id = ?', [r.pages[0]!.resultId])!;
    expect(JSON.parse(extraction.extraction_json).scope).toBe('manual_urls');
    // The manual page does not gain SERP provenance: a later crawl without a query is still out of scope.
    expect(c.db.get<{ origin: string }>('SELECT origin FROM competitors WHERE site_id = ? AND domain = ?', [c.siteId, 'other.test'])!.origin).toBe('manual');
    const later = await crawlCompetitorPages(c, [url], { fetcher: fetcher(), origin: 'manual', refresh: true });
    expect(later.pages[0]).toMatchObject({ status: 'skipped', blockedReason: 'not_approved' });
    // Even when the caller claims origin 'serp_discovered', a vouched-for URL is recorded as manual.
    const c2 = compCtx();
    await crawlCompetitorPages(c2, [{ url, query: 'synthetic widgets' }], { fetcher: fetcher(), origin: 'serp_discovered', manualUrls: true });
    expect(c2.db.get<{ origin: string }>('SELECT origin FROM competitors WHERE site_id = ? AND domain = ?', [c2.siteId, 'other.test'])!.origin).toBe('manual');
    c2.cleanup();
  });

  it('the monthly re-crawl skips stored manual pages that are no longer approved, but keeps SERP-discovered ones', async () => {
    const c = compCtx({ approvedDomains: ['other.test'] });
    await crawlCompetitorPages(c, [at('other.test', '/manual')], { fetcher: fetcher(), origin: 'manual' });
    await crawlCompetitorPages(c, [{ url: at('rival.test', '/guide'), query: 'synthetic guide' }], { fetcher: fetcher() });
    // The owner removes other.test from the approved domains.
    c.config.research.approvedDomains = [];
    const stored = c.db.all<{ url: string }>('SELECT url FROM competitor_pages WHERE site_id = ? ORDER BY url', [c.siteId]).map((x) => x.url);
    expect(stored).toHaveLength(2);
    const before = server.hits.length;
    const r = await crawlCompetitorPages(c, stored.map((url) => ({ url })), { fetcher: fetcher(), origin: 'manual', refresh: true });
    const manual = r.pages.find((p) => p.url.includes('other.test'))!;
    expect(manual).toMatchObject({ status: 'skipped', blockedReason: 'not_approved' });
    expect(manual.reason).toMatch(/no longer approved/);
    expect(r.pages.find((p) => p.url.includes('rival.test'))!.status).toBe('fetched');
    expect(server.hits.slice(before).some((h) => h.host === 'other.test')).toBe(false);
  });
});

describe('competitor volatility cache (research.dataforseo.cacheDays.competitor)', () => {
  const DAY = 86_400_000;

  it('reuses a fresh snapshot as "cached" (no request) and re-fetches after the TTL', async () => {
    const c = compCtx({ competitorCacheDays: 14 });
    const url = at('rival.test', '/guide');
    const first = await crawlCompetitorPages(c, [{ url, query: 'synthetic guide' }], { fetcher: fetcher() });
    expect(first.pages[0]!.status).toBe('fetched');
    c.clock.advanceMs(3 * DAY);
    const before = server.hits.length;
    const again = await crawlCompetitorPages(c, [{ url, query: 'synthetic guide' }], { fetcher: fetcher() });
    expect(again.status).toBe('completed');
    expect(again.crawlId).toBeNull();
    expect(again.pages[0]).toMatchObject({ status: 'cached', resultId: first.pages[0]!.resultId, contentHash: first.pages[0]!.contentHash, title: 'Rival guide v1', changes: [] });
    expect(again.pages[0]!.cache).toMatchObject({ ttlDays: 14, baseTtlDays: 14, basis: 'base' });
    expect(again.notes.join(' ')).toMatch(/volatility cache/);
    expect(server.hits.slice(before)).toEqual([]);
    // Dry runs report the cache the same way (a read, no request).
    c.dryRun = true;
    expect((await crawlCompetitorPages(c, [{ url, query: 'synthetic guide' }], { fetcher: fetcher() })).pages[0]!.status).toBe('cached');
    c.dryRun = false;
    // --refresh bypasses the cache; past the TTL the page is fetched again.
    expect((await crawlCompetitorPages(c, [{ url, query: 'synthetic guide' }], { fetcher: fetcher(), refresh: true })).pages[0]!.status).toBe('fetched');
    c.clock.advanceMs(15 * DAY);
    expect((await crawlCompetitorPages(c, [{ url, query: 'synthetic guide' }], { fetcher: fetcher() })).pages[0]!.status).toBe('fetched');
  });

  it('halves the TTL for recently changed pages and doubles it for pages unchanged over 3+ checks; cacheDays 0 disables it', async () => {
    const c = compCtx({ competitorCacheDays: 14 });
    const url = at('rival.test', '/guide');
    const page = () => c.db.get<{ id: string }>('SELECT id FROM competitor_pages WHERE site_id = ? AND url = ?', [c.siteId, url])!;
    await crawlCompetitorPages(c, [url], { fetcher: fetcher() });
    expect(competitorVolatilityTtl(c, { id: page().id, url })).toMatchObject({ ttlDays: 14, basis: 'base' }); // new_page is not a change
    guideVersion = 2;
    c.clock.advanceMs(DAY);
    const changed = await crawlCompetitorPages(c, [url], { fetcher: fetcher(), refresh: true });
    expect(changed.pages[0]!.changes).toContain('content_changed');
    expect(competitorVolatilityTtl(c, { id: page().id, url })).toMatchObject({ ttlDays: 7, basis: 'recently_changed' });
    // 8 days later the recently changed page (TTL 7) is due again.
    c.clock.advanceMs(8 * DAY);
    expect((await crawlCompetitorPages(c, [url], { fetcher: fetcher() })).pages[0]!.status).toBe('fetched');
    // Outside the change window with 3 unchanged checks since the change: doubled.
    c.clock.advanceMs(15 * DAY);
    await crawlCompetitorPages(c, [url], { fetcher: fetcher(), refresh: true });
    expect(competitorVolatilityTtl(c, { id: page().id, url })).toMatchObject({ ttlDays: 28, basis: 'stable' });
    c.clock.advanceMs(20 * DAY);
    expect((await crawlCompetitorPages(c, [url], { fetcher: fetcher() })).pages[0]!.status).toBe('cached');
    c.config.research.dataforseo.cacheDays.competitor = 0;
    expect((await crawlCompetitorPages(c, [url], { fetcher: fetcher() })).pages[0]!.status).toBe('fetched');
  });

  it('never reuses a snapshot when the latest check was blocked or failed', async () => {
    const c = compCtx({ competitorCacheDays: 14 });
    const url = at('rival.test', '/guide');
    await crawlCompetitorPages(c, [url], { fetcher: fetcher() });
    // The next check fails (DNS): the stored snapshot is not served as "cached" afterwards.
    const noDns = testFetcher({ resolver: mapResolver({}) });
    const failed = await crawlCompetitorPages(c, [url], { fetcher: noDns, refresh: true });
    expect(failed.pages[0]!.status).toBe('failed');
    expect((await crawlCompetitorPages(c, [url], { fetcher: fetcher() })).pages[0]!.status).toBe('fetched');
  });
});

describe('transient competitor failures are retry-eligible, not SSRF blocks (A8-09)', () => {
  it('maps a DNS failure to failed/dns and keeps blocked/unsafe_url for private destinations', async () => {
    const c = compCtx({ approvedDomains: ['gone.test', 'intranet.test'] });
    const r = await crawlCompetitorPages(c, [at('gone.test', '/x'), at('intranet.test', '/')], { fetcher: fetcher() });
    const gone = r.pages.find((p) => p.url.includes('gone.test'))!;
    expect(gone).toMatchObject({ status: 'failed', failureReason: 'dns', blockedReason: null });
    expect(gone.reason).toMatch(/DNS resolution failed \(transient; retried on the next run\)/);
    expect(r.pages.find((p) => p.url.includes('intranet.test'))).toMatchObject({ status: 'blocked', blockedReason: 'unsafe_url' });
    expect(r.counts).toMatchObject({ failed: 1, blocked: 1 });
    const row = c.db.get<{ blocked_reason: string | null }>('SELECT blocked_reason FROM crawl_results WHERE id = ?', [gone.resultId])!;
    expect(row.blocked_reason).toBe('network_error');
  });

  it('maps a connection error to failed/connection', async () => {
    const c = compCtx({ approvedDomains: ['flaky.test'] });
    const transport: HttpTransport = {
      kind: 'fixture',
      async send(target) {
        if (target.url.pathname === '/robots.txt') {
          const body = new TextEncoder().encode('User-agent: *\nAllow: /\n');
          return { status: 200, headers: new Headers({ 'content-type': 'text/plain' }), body: (async function* () { yield body; })(), close: async () => undefined };
        }
        throw Object.assign(new Error('connect ECONNREFUSED (synthetic)'), { code: 'ECONNREFUSED' });
      },
    };
    const f = new SafeFetcher({ guard: new SsrfGuard({ resolver: mapResolver({ 'flaky.test': FAKE_PUBLIC_IP }) }), transport, userAgent: 'seo-agent-test/1.0 (+synthetic)', timeoutMs: 2_000, maxBytes: 100_000, maxRedirects: 2, perHostConcurrency: 1, delayMs: 0 });
    const r = await crawlCompetitorPages(c, [{ url: 'https://flaky.test/page', query: 'synthetic q' }], { fetcher: f });
    expect(r.pages[0]).toMatchObject({ status: 'failed', failureReason: 'connection', blockedReason: null });
    expect(r.pages[0]!.reason).toMatch(/connection error \(transient/);
  });

  it('demo-profile services crawl competitors with the synthetic competitor fixture (robots/login/access blocks), not a DNS failure', async () => {
    const c = compCtx();
    const demoLike = { ...c, synthetic: true } as AppContext;
    const svc = createServices(demoLike, { googleProvider: null, llm: null });
    const targets = ['competitor-1.example', 'competitor-2.example', 'competitor-3.example', 'competitor-4.example', 'competitor-5.example'].map((h) => ({ url: `https://${h}/widgets-guide`, query: 'how to choose a widget' }));
    // The URLs come from a stored SERP of the query (as in the weekly research stage).
    seedSerp(c, 'how to choose a widget', targets.map((t) => t.url));
    const r = await crawlCompetitorPages(c, targets, { ...svc.competitorCrawler });
    const by = Object.fromEntries(r.pages.map((p) => [new URL(p.url).hostname, p]));
    expect(by['competitor-1.example']).toMatchObject({ status: 'fetched' });
    expect(by['competitor-2.example']).toMatchObject({ status: 'blocked', blockedReason: 'robots' });
    expect(by['competitor-3.example']).toMatchObject({ status: 'blocked', blockedReason: 'login_required' });
    expect(by['competitor-4.example']).toMatchObject({ status: 'blocked', blockedReason: 'access_denied' });
    expect(by['competitor-5.example']).toMatchObject({ status: 'failed', blockedReason: null });
    expect(r.pages.some((p) => p.blockedReason === 'unsafe_url')).toBe(false);
    expect(r.isSynthetic).toBe(true);
    // The own-site fixture crawler is NOT used for competitors in the demo profile.
    expect(svc.competitorCrawler).not.toBe(svc.crawler);
  });
});

describe('SSRF-refused manual competitor URLs are never tracked (D2-ACC-05)', () => {
  // The escape hatch is OFF here: 127.0.0.1 is refused like any other loopback address.
  const strictFetcher = () => testFetcher({ resolver: mapResolver({ 'rival.test': '127.0.0.1', 'loop.test': '127.0.0.1' }), loopback: false });
  const refusedUrls = () => [
    `http://127.0.0.1:${server.port}/admin`, // loopback IP literal (the synthetic server really listens here)
    'http://loop.test/internal', // a hostname whose DNS answer is loopback
    'http://169.254.10.20/latest', // link-local
    'http://169.254.169.254/latest/meta-data/', // cloud metadata address
    'http://metadata.google.internal/computeMetadata/v1/', // cloud metadata hostname
  ];
  const rc = (c: TestContext) => ({ ctx: c }) as unknown as RenderContext;

  it('--manual-urls: loopback, link-local, and metadata URLs are refused before any request and recorded only as crawl results', async () => {
    const c = compCtx();
    const before = server.hits.length;
    const urls = refusedUrls();
    const r = await crawlCompetitorPages(c, urls.map((url) => ({ url, query: 'synthetic widgets' })), { fetcher: strictFetcher(), origin: 'manual', manualUrls: true });
    expect(r.status).toBe('failed');
    expect(r.pages).toHaveLength(urls.length);
    for (const p of r.pages) {
      expect(p).toMatchObject({ status: 'blocked', blockedReason: 'unsafe_url', scope: 'manual_urls', competitorId: null, competitorPageId: null, contentHash: null });
      expect(p.resultId).toBeTruthy();
      expect(p.reason).toMatch(/Refused by the SSRF guard before any request/);
      expect(p.reason).toMatch(/Not tracked as a competitor page/);
    }
    const reasons = r.pages.map((p) => p.reason);
    expect(reasons.filter((x) => /metadata_endpoint/.test(x ?? ''))).toHaveLength(2);
    expect(reasons.some((x) => /link local/.test(x ?? ''))).toBe(true);
    expect(reasons.some((x) => /dns_blocked_ip/.test(x ?? ''))).toBe(true);
    // Nothing was requested (not even robots.txt), and nothing became a tracked competitor or page.
    expect(server.hits.slice(before)).toEqual([]);
    expect(c.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM competitors WHERE site_id = ?', [c.siteId])!.n).toBe(0);
    expect(c.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM competitor_pages WHERE site_id = ?', [c.siteId])!.n).toBe(0);
    // The monthly re-check selects tracked pages only: none of the refused URLs is retried.
    expect(c.db.all('SELECT url FROM competitor_pages WHERE site_id = ?', [c.siteId])).toEqual([]);
    // The refusals are kept as crawl results (blocked unsafe_url, no page, no status, no request).
    const rows = c.db.all<{ requested_url: string; blocked_reason: string; page_id: string | null; status_code: number | null; extraction_json: string }>(
      'SELECT requested_url, blocked_reason, page_id, status_code, extraction_json FROM crawl_results WHERE site_id = ? AND crawl_id = ?',
      [c.siteId, r.crawlId],
    );
    expect(rows).toHaveLength(urls.length);
    for (const row of rows) {
      expect(row).toMatchObject({ blocked_reason: 'unsafe_url', page_id: null, status_code: null });
      expect(JSON.parse(row.extraction_json)).toMatchObject({ scope: 'manual_urls', pageRequested: false });
    }
    // The audit event still lists what the owner vouched for; the outcome note counts them as blocked.
    expect(r.notes.join(' ')).toMatch(/0 of 5 manual page\(s\) fetched on the owner's word .*; 5 blocked\./);
  });

  it('a page tracked before the guard ran first (legacy row) is not re-marked as checked and renders "blocked before any request"', async () => {
    const c = compCtx();
    const url = 'http://169.254.169.254/latest/meta-data/';
    // Legacy state (older builds): competitor + page rows created before the SSRF guard ran, last_checked_at set,
    // and a crawl result that shows the guard refused it (no request, no status).
    c.db.run(`INSERT INTO competitors (id, site_id, domain, name, origin, first_seen_at) VALUES ('comp_legacy', ?, '169.254.169.254', NULL, 'manual', '2026-09-01T09:00:00.000Z')`, [c.siteId]);
    c.db.run(`INSERT INTO competitor_pages (id, site_id, competitor_id, url, first_seen_at, last_checked_at) VALUES ('cpage_legacy', ?, 'comp_legacy', ?, '2026-09-01T09:00:00.000Z', '2026-09-01T09:00:00.000Z')`, [c.siteId, url]);
    const legacyCrawl = createCrawl(c, { kind: 'competitor', config: {}, isSynthetic: false });
    insertResult(c, { crawlId: legacyCrawl, pageId: null, requestedUrl: url, fetch: null, renderMode: 'http', robotsAllowed: null, extraction: null, textRef: null, blockedReason: 'unsafe_url', error: 'Refusing metadata address', depth: 0, discoveredVia: ['competitor'], inSitemap: null, extra: { query: 'synthetic widgets', scope: 'manual_urls' } });
    const text = competitorPageCheckText(rc(c), { url, last_checked_at: '2026-09-01T09:00:00.000Z' });
    expect(text).toMatch(/^blocked before any request \(SSRF guard\)/);
    expect(text).not.toMatch(/last checked/);

    // Re-running it now: refused again, the legacy row is reported but its last_checked_at is not advanced.
    c.clock.advanceMs(86_400_000);
    const r = await crawlCompetitorPages(c, [{ url, query: 'synthetic widgets' }], { fetcher: strictFetcher(), origin: 'manual', manualUrls: true });
    expect(r.pages[0]).toMatchObject({ status: 'blocked', blockedReason: 'unsafe_url', competitorPageId: 'cpage_legacy' });
    expect(c.db.get<{ at: string }>('SELECT last_checked_at AS at FROM competitor_pages WHERE id = ?', ['cpage_legacy'])!.at).toBe('2026-09-01T09:00:00.000Z');
    expect(competitorPageCheckText(rc(c), { url, last_checked_at: '2026-09-01T09:00:00.000Z' })).toMatch(/^blocked before any request \(SSRF guard\)/);
  });

  it('"last checked <date>" only when the page was requested; DNS failures and robots blocks say the page was not fetched', async () => {
    const c = compCtx({ approvedDomains: ['gone.test', 'blocked.test'] });
    const guide = at('rival.test', '/guide');
    await crawlCompetitorPages(c, [guide], { fetcher: fetcher() });
    expect(competitorPageCheckText(rc(c), { url: guide, last_checked_at: null })).toBe('last checked 2026-09-24');
    // A later DNS failure keeps the date of the last real check and names the failed attempt.
    c.clock.advanceMs(2 * 86_400_000);
    await crawlCompetitorPages(c, [guide], { fetcher: testFetcher({ resolver: mapResolver({}) }), refresh: true });
    expect(competitorPageCheckText(rc(c), { url: guide, last_checked_at: null })).toBe('last checked 2026-09-24; latest attempt 2026-09-26: not fetched: DNS resolution failed before any request');
    // Never requested at all.
    const gone = at('gone.test', '/x');
    await crawlCompetitorPages(c, [gone], { fetcher: fetcher() });
    expect(competitorPageCheckText(rc(c), { url: gone, last_checked_at: '2026-09-26T09:00:00.000Z' })).toBe('not fetched: DNS resolution failed before any request (last attempt 2026-09-26)');
    const disallowed = at('blocked.test', '/page');
    await crawlCompetitorPages(c, [disallowed], { fetcher: fetcher() });
    expect(competitorPageCheckText(rc(c), { url: disallowed, last_checked_at: '2026-09-26T09:00:00.000Z' })).toBe('not fetched: disallowed by robots.txt (last attempt 2026-09-26)');
    // No stored crawl result: the recorded value, as before.
    expect(competitorPageCheckText(rc(c), { url: 'https://unknown.test/', last_checked_at: null })).toBe('last checked never');
  });
});
