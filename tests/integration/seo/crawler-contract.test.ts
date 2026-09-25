/**
 * Contract test between the crawler's stored rows and this slice (SYNTHETIC).
 * Runs the real crawler offline over an in-memory fixture site (no network;
 * example.test only), then reconciles URLs and routes pages. It pins the
 * row shapes this slice depends on: redirecting rows keep the FIRST status
 * (3xx) and the final URL gets its own row; technical issues use the crawler's
 * own vocabulary (broken_internal_link, sitemap_url_not_ok, ...).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { crawlSite } from '../../../src/crawler/crawl.js';
import { SafeFetcher } from '../../../src/crawler/fetch.js';
import { fixtureTransport, type FixtureResponse } from '../../../src/crawler/transport.js';
import { SsrfGuard } from '../../../src/security/ssrf.js';
import { prepareSiteAnalysis, routeAllPages } from '../../../src/seo/page-analysis.js';
import { UrlReconciler } from '../../../src/seo/reconcile.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { daily, PROPERTY, SeoSeeder } from '../../fixtures/seo/seed.js';
import { scenarioConfig } from '../../fixtures/seo/scenario.js';

const O = 'https://www.example.test';
const html = (title: string, body: string, canonical?: string) =>
  `<html><head><title>${title}</title>${canonical ? `<link rel="canonical" href="${canonical}">` : ''}</head><body><h1>${title}</h1><p>Synthetic fixture page with enough words to be treated as content by the crawler here.</p>${body}</body></html>`;
const page = (title: string, body = '', canonical?: string): FixtureResponse => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html(title, body, canonical) });

const ROUTES: Record<string, FixtureResponse> = {
  [`${O}/robots.txt`]: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nAllow: /\n' },
  [`${O}/`]: page('Home', ['/old-guide', '/docs', '/retired', '/dead'].map((p) => `<a href="${p}">${p}</a>`).join(' '), `${O}/`),
  [`${O}/old-guide`]: { status: 301, headers: { location: `${O}/guide` } },
  [`${O}/guide`]: page('Guide', '', `${O}/guide`),
  [`${O}/docs`]: { status: 308, headers: { location: `${O}/docs/` } },
  [`${O}/docs/`]: page('Docs', '', `${O}/docs/`),
  [`${O}/retired`]: { status: 301, headers: { location: `${O}/retired-target` } },
  [`${O}/retired-target`]: { status: 410, headers: { 'content-type': 'text/plain' }, body: 'gone' },
  [`${O}/dead`]: { status: 404, headers: { 'content-type': 'text/plain' }, body: 'not found' },
};

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

async function crawlFixtureSite(): Promise<void> {
  const fetcher = new SafeFetcher({
    guard: new SsrfGuard({ resolver: async () => [{ address: '93.184.216.34', family: 4 }] }), // fake public answer; no connection is made
    transport: fixtureTransport(ROUTES),
    userAgent: 'seo-agent-test/1.0',
    timeoutMs: 1000,
    maxBytes: 100_000,
    maxRedirects: 5,
    perHostConcurrency: 1,
    delayMs: 0,
  });
  const r = await crawlSite(ctx, { fetcher, useSitemaps: false, maxPages: 20 });
  expect(r.status).toBe('completed');
}

describe('crawler rows -> reconciliation -> routing (contract)', () => {
  it('merges permanent redirects stored by the real crawler and routes gone pages to TECHNICAL_BLOCKER', async () => {
    ctx = createTestContext({ config: scenarioConfig({ crawl: { requestDelayMs: 0 } }) });
    await crawlFixtureSite();
    const redirectRow = ctx.db.get<{ status_code: number; final_url: string }>('SELECT status_code, final_url FROM crawl_results WHERE site_id = ? AND requested_url = ?', [ctx.siteId, `${O}/old-guide`])!;
    // The crawler stores the FIRST status on the redirecting row.
    expect(redirectRow).toEqual({ status_code: 301, final_url: `${O}/guide` });

    const seed = new SeoSeeder(ctx.db, ctx.siteId);
    const d = (fn: (date: string) => object) => daily('2026-08-24', '2026-09-20', fn as never);
    seed.gscPage(
      [
        ...d((date) => ({ date, page: `${O}/old-guide`, clicks: 3, impressions: 60, position: 5 })),
        ...d((date) => ({ date, page: `${O}/guide`, clicks: 10, impressions: 200, position: 3 })),
        ...d((date) => ({ date, page: `${O}/dead`, clicks: 2, impressions: 40, position: 7 })),
        ...d((date) => ({ date, page: `${O}/retired`, clicks: 1, impressions: 30, position: 9 })),
      ] as never,
    );
    seed.gscProperty(d((date) => ({ date, clicks: 20, impressions: 400, position: 4 })) as never);
    seed.ga4Landing(d((date) => ({ date, landingPage: '/guide', sessions: 12, rate: 0.05, rateStatus: 'observed' })) as never);
    seed.ga4Metadata();

    const report = new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run();
    expect(report.redirects.established).toBe(2); // /old-guide -> /guide (301), /docs -> /docs/ (308)
    expect(report.redirects.unverified).toBe(1); // /retired -> 410
    const rec = new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock);
    const guide = rec.resolve(`${O}/guide`);
    expect(rec.resolve(`${O}/old-guide`)).toMatchObject({ status: 'resolved', pageId: guide.status === 'resolved' ? guide.pageId : 'x' });
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(DISTINCT page_id) AS n FROM gsc_page_daily WHERE site_id = ? AND page LIKE '%guide'", [ctx.siteId])!.n).toBe(1);

    const deps = { db: ctx.db, siteId: ctx.siteId, config: ctx.config, clock: ctx.clock };
    const site = prepareSiteAnalysis(deps);
    expect(site.gsc.property).toBe(PROPERTY);
    const run = await routeAllPages(deps, site, { persist: false });
    const byPath = Object.fromEntries(run.analyses.map((a) => [a.page.url.replace(O, ''), a]));
    // Clicks of the old URL count toward /guide.
    expect(byPath['/guide']!.bundle.gsc!.clicks).toEqual({ status: 'observed', value: 13 * 28 });
    expect(byPath['/old-guide']).toBeUndefined();
    // A crawler-confirmed 404 (broken_internal_link + own 404 response) is a TECHNICAL_BLOCKER, not HEALTHY.
    const dead = byPath['/dead']!;
    expect(dead.bundle.input.technical.latestCrawlStatus).toBe(404);
    expect(dead.decision.route).toBe('TECHNICAL_BLOCKER');
    expect(dead.decision.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['CONFIRMED_TECHNICAL_ISSUE', 'CRAWL_HTTP_ERROR']));
    expect(dead.decision.reasons.some((r) => r.detail.startsWith('broken_internal_link'))).toBe(true);
    // The 410 target is a blocker too (its redirect source is not merged into it).
    expect(byPath['/retired-target']!.decision.route).toBe('TECHNICAL_BLOCKER');
    // The redirecting URL keeps its own search data and is routed: its redirect leads to a 410.
    const retired = byPath['/retired']!;
    expect(retired.page.lifecycle).toBe('redirected');
    expect(retired.bundle.input.technical.latestCrawlStatus).toBe(301);
    expect(retired.decision.route).toBe('TECHNICAL_BLOCKER');
    expect(retired.decision.reasons.find((r) => r.code === 'CRAWL_HTTP_ERROR')!.detail).toMatch(/redirect_to_http_410.*redirects \(HTTP 301\) to https:\/\/www\.example\.test\/retired-target, which returned HTTP 410/);
    // A clean permanent redirect's source is not routed on its own.
    expect(byPath['/docs']).toBeUndefined();
  });
});
