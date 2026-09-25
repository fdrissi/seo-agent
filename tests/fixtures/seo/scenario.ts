/**
 * SYNTHETIC multi-page scenario for routing/recommendation tests.
 * example.test domains only; every metric row is is_synthetic = 1.
 *
 *   /guide    healthy informational page (top positions, converting)
 *   /pricing  converting page (tests add an observing experiment after reconciliation)
 *   /broken   page with a CONFIRMED noindex issue
 *   /blue     ambiguous-intent queries at positions 4-20, no conversions
 *   /new      crawled page with zero impressions and no URL inspection
 */
import { testSiteConfig } from '../../helpers/context.js';
import type { SiteConfig } from '../../../src/config/site-schema.js';
import { daily, GA4_PROPERTY, PROPERTY, SeoSeeder } from './seed.js';

export const SCENARIO_START = '2026-07-24'; // two 28-day periods
export const SCENARIO_END = '2026-09-20';
export const HOST = 'https://www.example.test';

export function scenarioConfig(over: Record<string, unknown> = {}): SiteConfig {
  return testSiteConfig({
    google: { searchConsoleProperty: PROPERTY, ga4PropertyId: GA4_PROPERTY } as never,
    conversions: { primaryEvents: [{ name: 'generate_lead', meaning: 'Lead form submitted (synthetic)', kind: 'lead', value: null }] } as never,
    brand: { aliases: ['Acme Widgets'] },
    market: { languages: ['en'] } as never,
    ...over,
  });
}

/** Seeds the scenario. Experiments need page ids, so tests add them after reconciliation. */
export function seedScenario(seed: SeoSeeder, opts: { withBrokenIssue?: boolean } = {}): void {
  const d = (fn: (date: string, i: number) => object) => daily(SCENARIO_START, SCENARIO_END, fn as never);
  seed.gscProperty(d((date) => ({ date, clicks: 120, impressions: 3000, position: 6 })) as never);
  const pages = [
    { path: '/guide', clicks: 40, impressions: 700, position: 2.1, sessions: 38, rate: 0.02 },
    { path: '/pricing', clicks: 6, impressions: 120, position: 3.2, sessions: 6, rate: 0.05 },
    { path: '/broken', clicks: 2, impressions: 50, position: 6, sessions: 2, rate: 0 },
    { path: '/blue', clicks: 4, impressions: 150, position: 9, sessions: 4, rate: 0 },
  ];
  seed.gscPage(pages.flatMap((p) => d((date) => ({ date, page: `${HOST}${p.path}`, clicks: p.clicks, impressions: p.impressions, position: p.position }))) as never);
  seed.gscQuery(
    [
      ...d((date) => ({ date, page: `${HOST}/guide`, query: 'what is a widget', clicks: 30, impressions: 500, position: 1.9 })),
      ...d((date) => ({ date, page: `${HOST}/guide`, query: 'how do widgets work', clicks: 8, impressions: 150, position: 2.4 })),
      ...d((date) => ({ date, page: `${HOST}/pricing`, query: 'acme widgets pricing', clicks: 5, impressions: 90, position: 1.2 })),
      ...d((date) => ({ date, page: `${HOST}/blue`, query: 'blue widgets', clicks: 3, impressions: 120, position: 9 })),
      ...d((date) => ({ date, page: `${HOST}/broken`, query: 'widget tools', clicks: 1, impressions: 40, position: 6 })),
    ] as never,
  );
  seed.batch('gsc', 'gsc_page_daily', PROPERTY, SCENARIO_START, SCENARIO_END); // /new is covered: zero rows = zero impressions
  seed.ga4Landing(
    pages.flatMap((p) => d((date) => ({ date, landingPage: p.path, sessions: p.sessions, rate: p.rate, rateStatus: 'observed', primaryKeyEvents: Math.round(p.sessions * p.rate * 1.5) }))) as never,
  );
  seed.ga4Metadata();
  const crawl = seed.crawl('own_site', { pagesFetched: 5, pagesAttempted: 5 });
  for (const p of ['/guide', '/pricing', '/broken', '/blue', '/new']) seed.crawlResult(crawl, { requestedUrl: `${HOST}${p}`, title: `Synthetic ${p}` });
  if (opts.withBrokenIssue !== false) seed.technicalIssue({ url: `${HOST}/broken`, type: 'accidental_noindex', severity: 'critical', confirmed: true });
}
