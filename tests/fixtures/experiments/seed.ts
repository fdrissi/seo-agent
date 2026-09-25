/**
 * SYNTHETIC test fixtures for the experiments/approvals slice.
 * Every row is fabricated for tests, uses reserved example domains
 * (*.example.test), and is flagged is_synthetic = 1 where the schema allows.
 * Nothing here is real data.
 */
import type { AppContext } from '../../../src/app/context.js';
import { markHumanReviewed } from '../../../src/content/publication.js';
import { insertQualityReview } from '../../../src/content/store.js';
import { sha256 } from '../../../src/core/hash.js';
import type { Db } from '../../../src/database/db.js';
import { addDays, eachDate } from '../../../src/core/time.js';
import { newId } from '../../../src/core/ids.js';
import { testSiteConfig } from '../../helpers/context.js';
import type { SiteConfig } from '../../../src/config/site-schema.js';

export const SITE_URL = 'https://www.example.test/';
export const GSC_PROPERTY = 'sc-domain:example.test';
export const GA4_PROPERTY = '123456789';
export const GSC_TZ = 'America/Los_Angeles';
export const GA4_TZ = 'Europe/Tallinn';

/** Synthetic site config with Search Console, GA4, and one primary event configured. */
export function experimentsSiteConfig(
  overrides: { minImpressions?: number; minSessions?: number; defaultMin?: number; lowTrafficMin?: number; /** null = not configured. */ searchConsoleProperty?: string | null } = {},
): SiteConfig {
  return testSiteConfig({
    google: { searchConsoleProperty: overrides.searchConsoleProperty === undefined ? GSC_PROPERTY : overrides.searchConsoleProperty, ga4PropertyId: GA4_PROPERTY },
    conversions: { primaryEvents: [{ name: 'generate_lead', meaning: 'Synthetic demo form submitted', kind: 'lead' }] },
    experiments: {
      defaultMinObservationDays: overrides.defaultMin ?? 28,
      lowTrafficMinObservationDays: overrides.lowTrafficMin ?? 56,
      minImpressionsForEvaluation: overrides.minImpressions ?? 500,
      minSessionsForConversionEvaluation: overrides.minSessions ?? 200,
    },
  });
}

export function seedPage(db: Db, siteId: string, p: { id?: string; path: string; pageType?: string | null }): { id: string; url: string } {
  const id = p.id ?? newId('page');
  const url = new URL(p.path, SITE_URL).href;
  const now = '2026-01-01T00:00:00.000Z';
  db.run(
    `INSERT INTO pages (id, site_id, url, host, path, first_source, page_type, lifecycle, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 'fixture', ?, 'active', ?, ?)`,
    [id, siteId, url, new URL(url).hostname, new URL(url).pathname, p.pageType ?? 'article', now, now],
  );
  return { id, url };
}

export interface RecommendationSeed {
  id?: string;
  pageId: string | null;
  actionType?: string;
  kind?: string;
  proposedChange?: string | null;
  hypothesis?: string | null;
  risks?: string | null;
  details?: Record<string, unknown>;
  status?: string;
  successCriteria?: string | null;
  query?: string | null;
}

export function seedRecommendation(db: Db, siteId: string, r: RecommendationSeed): string {
  const id = r.id ?? newId('rec');
  const now = '2026-09-01T00:00:00.000Z';
  db.run(
    `INSERT INTO recommendations (id, site_id, kind, action_type, title, page_id, query, diagnosis, proposed_change, hypothesis, success_criteria, risks, review_date, details_json, status,
       prompt_version, model_id, scoring_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      siteId,
      r.kind ?? 'primary',
      r.actionType ?? 'rewrite_title_meta',
      'Synthetic: rewrite title and meta description',
      r.pageId,
      r.query ?? null,
      'Synthetic diagnosis: CTR below comparable pages.',
      r.proposedChange === undefined ? 'Change the title to "Synthetic Widget Guide 2026" and the meta description to "A synthetic description for tests."' : r.proposedChange,
      r.hypothesis === undefined ? 'A clearer title raises CTR without hurting lead quality.' : r.hypothesis,
      r.successCriteria === undefined ? 'CTR improves by at least 10% relative to comparison pages.' : r.successCriteria,
      r.risks === undefined ? 'Title change could reduce relevance for secondary queries.' : r.risks,
      JSON.stringify(r.details ?? { proposedTitle: 'Synthetic Widget Guide 2026', proposedMetaDescription: 'A synthetic description for tests.' }),
      r.status ?? 'proposed',
      'recommend@1+abcd1234',
      'synthetic-model',
      'scoring@1',
      now,
      now,
    ],
  );
  return id;
}

function batch(db: Db, siteId: string, source: 'gsc' | 'ga4', dataset: string, property: string, start: string, end: string): string {
  const id = newId('batch');
  db.run(
    `INSERT INTO ingestion_batches (id, site_id, source, dataset, property, date_start, date_end, request_json, status, transformation_version, is_synthetic, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 'succeeded', 'fixture@1', 1, '2026-01-01T00:00:00.000Z')`,
    [id, siteId, source, dataset, property, start, end],
  );
  return id;
}

export interface GscSeries {
  pageUrl: string;
  pageId?: string | null;
  start: string;
  end: string;
  clicks: (date: string, i: number) => number;
  impressions: (date: string, i: number) => number;
  position?: (date: string, i: number) => number;
  isFinal?: (date: string) => boolean;
  segmentKey?: string;
  /** Search Console property (default GSC_PROPERTY). */
  property?: string;
  /** Search type (default 'web'). */
  searchType?: string;
}

/** Page-level daily GSC rows (current revision) plus property-level rows so coverage is known. */
export function seedGscPage(db: Db, siteId: string, s: GscSeries): void {
  const property = s.property ?? GSC_PROPERTY;
  const b = batch(db, siteId, 'gsc', 'gsc_page_daily', property, s.start, s.end);
  eachDate(s.start, s.end).forEach((d, i) => {
    const clicks = s.clicks(d, i);
    const impressions = s.impressions(d, i);
    if (impressions === 0 && clicks === 0) return; // GSC omits zero rows
    db.run(
      `INSERT INTO gsc_page_daily (site_id, property, search_type, date, date_tz, page, page_id, segment_key, clicks, impressions, ctr, position, aggregation_type, is_final, revision, is_current, row_hash, batch_id, collected_at, transformation_version, is_synthetic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'byPage', ?, 1, 1, ?, ?, '2026-01-01T00:00:00.000Z', 'fixture@1', 1)`,
      [
        siteId,
        property,
        s.searchType ?? 'web',
        d,
        GSC_TZ,
        s.pageUrl,
        s.pageId ?? null,
        s.segmentKey ?? '',
        clicks,
        impressions,
        impressions ? clicks / impressions : null,
        s.position ? s.position(d, i) : 8,
        s.isFinal ? (s.isFinal(d) ? 1 : 0) : 1,
        `h-${d}-${s.pageUrl}`,
        b,
      ],
    );
  });
}

/** Property-level daily totals marking which dates have (final) data. */
export function seedGscProperty(db: Db, siteId: string, start: string, end: string, isFinal: (d: string) => boolean = () => true): void {
  const b = batch(db, siteId, 'gsc', 'gsc_property_daily', GSC_PROPERTY, start, end);
  for (const d of eachDate(start, end)) {
    db.run(
      `INSERT INTO gsc_property_daily (site_id, property, search_type, date, date_tz, clicks, impressions, ctr, position, aggregation_type, is_final, revision, is_current, row_hash, batch_id, collected_at, transformation_version, is_synthetic)
       VALUES (?, ?, 'web', ?, ?, 1000, 50000, 0.02, 12, 'byProperty', ?, 1, 1, ?, ?, '2026-01-01T00:00:00.000Z', 'fixture@1', 1)`,
      [siteId, GSC_PROPERTY, d, GSC_TZ, isFinal(d) ? 1 : 0, `p-${d}`, b],
    );
  }
}

export interface Ga4Series {
  landingPage: string;
  pageId?: string | null;
  start: string;
  end: string;
  sessions: (date: string, i: number) => number;
  /** Reported sessionKeyEventRate:<primary> for the day (0..1), or null = unavailable. */
  rate: (date: string, i: number) => number | null;
  engaged?: (date: string, i: number) => number | null;
}

export function seedGa4Landing(db: Db, siteId: string, s: Ga4Series): void {
  const b = batch(db, siteId, 'ga4', 'ga4_landing_daily', GA4_PROPERTY, s.start, s.end);
  eachDate(s.start, s.end).forEach((d, i) => {
    const sessions = s.sessions(d, i);
    const rate = s.rate(d, i);
    const engaged = s.engaged ? s.engaged(d, i) : Math.round(sessions * 0.6);
    db.run(
      `INSERT INTO ga4_landing_daily (site_id, property_id, date, date_tz, channel_view, landing_page, host_name, page_id, segment_key, sessions, engaged_sessions, key_events,
         primary_event_name, primary_key_events, primary_key_events_status, primary_session_rate, primary_session_rate_status, revenue_micros, revenue_currency, revenue_status,
         metric_names_json, is_complete, revision, is_current, row_hash, batch_id, collected_at, transformation_version, is_synthetic)
       VALUES (?, ?, ?, ?, 'google_organic', ?, 'www.example.test', ?, '', ?, ?, NULL, 'generate_lead', ?, ?, ?, ?, NULL, NULL, 'unavailable', NULL, 1, 1, 1, ?, ?, '2026-01-01T00:00:00.000Z', 'fixture@1', 1)`,
      [
        siteId,
        GA4_PROPERTY,
        d,
        GA4_TZ,
        s.landingPage,
        s.pageId ?? null,
        sessions,
        engaged,
        rate === null ? null : Math.round(rate * sessions),
        rate === null ? 'unavailable' : 'observed',
        rate,
        rate === null ? 'unavailable' : 'observed',
        `g-${d}-${s.landingPage}`,
        b,
      ],
    );
  });
}

/** GSC series with a flat baseline and a multiplied level after `changeDate` (exclusive). */
export function stepSeries(changeDate: string, before: number, after: number): (d: string) => number {
  return (d) => (d > changeDate ? after : before);
}

export interface DraftSeed {
  targetPageId?: string | null;
  status?: string;
  unresolvedFacts?: number;
  pkg?: Record<string, unknown>;
}

export function seedDraft(db: Db, siteId: string, s: DraftSeed = {}): { draftId: string; itemId: string; briefId: string } {
  const itemId = newId('ci');
  const briefId = newId('brief');
  const draftId = newId('draft');
  const now = '2026-09-01T00:00:00.000Z';
  db.run(
    `INSERT INTO content_items (id, site_id, title, primary_question, stage, target_page_id, is_synthetic, created_at, updated_at) VALUES (?, ?, 'Synthetic widget sizing guide', 'How to size a synthetic widget?', 'in_review', ?, 1, ?, ?)`,
    [itemId, siteId, s.targetPageId ?? null, now, now],
  );
  db.run(`INSERT INTO content_briefs (id, site_id, content_item_id, version, status, brief_json, content_hash, created_at) VALUES (?, ?, ?, 1, 'approved', ?, 'bh1', ?)`, [
    briefId,
    siteId,
    itemId,
    JSON.stringify({ proposedUrl: new URL('/guides/synthetic-widget-sizing', SITE_URL).href }),
    now,
  ]);
  const pkg = s.pkg ?? {
    title: 'How to Size a Synthetic Widget',
    metaDescription: 'A synthetic guide to sizing widgets, written for tests.',
    slug: 'guides/synthetic-widget-sizing',
    // `body`, as in content drafts (DraftPackage.body); body_hash = SHA-256 of it.
    body:
      '# How to size a synthetic widget\n\nMeasure the synthetic mounting surface before ordering any widget, because the fixture sizes vary by region.\n\n## Steps\n\n- Measure width\n- Measure depth\n\nCompare the measured width against the synthetic size table and pick the next larger size when in doubt.\n',
    sourceLedger: [{ id: 'src1', url: 'https://docs.example.test/widgets' }],
    factCheckNotes: [],
  };
  const body = typeof pkg.body === 'string' ? pkg.body : typeof pkg.bodyMarkdown === 'string' ? pkg.bodyMarkdown : '';
  db.run(
    `INSERT INTO content_drafts (id, site_id, content_item_id, brief_id, brief_version, brief_hash, version, status, package_json, body_hash, unresolved_facts, created_at)
     VALUES (?, ?, ?, ?, 1, 'bh1', 1, ?, ?, ?, ?, ?)`,
    [draftId, siteId, itemId, briefId, s.status ?? 'review_passed', JSON.stringify(pkg), sha256(body), s.unresolvedFacts ?? 0, now],
  );
  return { draftId, itemId, briefId };
}

/**
 * Record a named human's acceptance of a seeded draft's exact body through the
 * real content workflow (`content mark-reviewed`): a synthetic automated
 * 'pass' review first (mark-reviewed requires a quality review), then the
 * human acceptance confirmed by the body-hash prefix.
 */
export function acceptDraftAsHuman(ctx: AppContext, draftId: string, reviewer = 'Alice'): { reviewId: string; bodyHash: string } {
  const row = ctx.db.get<{ package_json: string }>('SELECT package_json FROM content_drafts WHERE site_id = ? AND id = ?', [ctx.siteId, draftId])!;
  const pkg = JSON.parse(row.package_json) as { body?: string };
  const bodyHash = sha256(pkg.body ?? '');
  insertQualityReview(ctx.db, {
    siteId: ctx.siteId,
    subjectType: 'draft',
    subjectId: draftId,
    verdict: 'pass',
    deterministic: { synthetic: true, note: 'SYNTHETIC automated review for tests' },
    aiReview: null,
    reasons: [],
    revisionRound: 0,
    now: ctx.clock.now().toISOString(),
  });
  const r = markHumanReviewed(ctx, draftId, { reviewer, confirmHashPrefix: bodyHash.slice(0, 12) });
  return { reviewId: r.reviewId, bodyHash };
}

export function seedCrawlResult(db: Db, siteId: string, c: { pageId: string; url: string; fetchedAt: string; title: string; metaDescription: string }): string {
  const crawlId = newId('crawl');
  db.run(`INSERT INTO crawls (id, site_id, kind, status, is_synthetic, started_at) VALUES (?, ?, 'own_site', 'completed', 1, ?)`, [crawlId, siteId, c.fetchedAt]);
  const id = newId('cr');
  db.run(
    `INSERT INTO crawl_results (id, crawl_id, site_id, page_id, requested_url, final_url, status_code, fetched_at, render_mode, title, meta_description, canonical_url)
     VALUES (?, ?, ?, ?, ?, ?, 200, ?, 'fixture', ?, ?, ?)`,
    [id, crawlId, siteId, c.pageId, c.url, c.url, c.fetchedAt, c.title, c.metaDescription, c.url],
  );
  return id;
}

/** Synthetic HTML page. */
export function htmlPage(p: { title: string; description: string; body?: string; canonical?: string }): string {
  return `<!doctype html><html><head><title>${p.title}</title><meta name="description" content="${p.description}">${p.canonical ? `<link rel="canonical" href="${p.canonical}">` : ''}</head><body><nav>Synthetic nav</nav><main><h1>${p.title}</h1>${p.body ?? '<p>Synthetic body text for tests.</p>'}</main></body></html>`;
}

export { addDays };
