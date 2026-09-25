/**
 * SYNTHETIC TEST FIXTURES for the reports module. Not real measurements.
 * Reserved domains only (example.test / *.invalid). Every number here is
 * invented for tests; rows are inserted directly into the fixed schema.
 */
import type { Db } from '../../../src/database/db.js';
import { addDays, eachDate } from '../../../src/core/time.js';
import { testSiteConfig } from '../../helpers/context.js';
import type { SiteConfig, SiteConfigInput } from '../../../src/config/site-schema.js';

export const GSC_PROPERTY = 'sc-domain:example.test';
export const GA4_PROPERTY = '123456';
export const PRIMARY_EVENT = 'generate_lead';
export const SITE_URL = 'https://www.example.test';

/** Weekly period used by the scenario: complete data through 2026-09-20. */
export const WEEK = { start: '2026-09-14', end: '2026-09-20' };
export const PREV_WEEK = { start: '2026-09-07', end: '2026-09-13' };

export function reportsTestConfig(overrides: Partial<SiteConfigInput> = {}): SiteConfig {
  return testSiteConfig({
    google: { searchConsoleProperty: GSC_PROPERTY, ga4PropertyId: GA4_PROPERTY },
    conversions: { primaryEvents: [{ name: PRIMARY_EVENT, meaning: 'Demo form submitted (synthetic)', kind: 'lead' }] },
    brand: { aliases: ['Test Co'] },
    reporting: { businessTimezone: 'Europe/Tallinn', currency: 'EUR' },
    ...overrides,
  });
}

let seq = 0;
export function sid(prefix: string): string {
  seq++;
  return `${prefix}_t${String(seq).padStart(5, '0')}`;
}

/** Insert one row; column names come from test code only. */
export function insertRow(db: Db, table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
}

const COLLECTED = '2026-09-22T06:00:00.000Z';

/**
 * Like the real syncs, a batch records its slice in request_json: GSC batches
 * the search `type` (default 'web'), GA4 batches the channel `view` (none by
 * default: such a batch never proves coverage of any view).
 */
export function seedBatch(db: Db, siteId: string, b: { source: 'gsc' | 'ga4'; dataset: string; property: string; start: string; end: string; status?: string; truncated?: number; coverage?: unknown; metadata?: unknown; synthetic?: number; view?: string; searchType?: string; request?: Record<string, unknown> }): string {
  const id = sid('batch');
  const request = b.request ?? (b.source === 'gsc' ? { type: b.searchType ?? 'web', synthetic: true } : { ...(b.view ? { view: b.view } : {}), synthetic: true });
  insertRow(db, 'ingestion_batches', {
    id,
    site_id: siteId,
    source: b.source,
    dataset: b.dataset,
    property: b.property,
    date_start: b.start,
    date_end: b.end,
    request_json: JSON.stringify(request),
    status: b.status ?? 'succeeded',
    truncated: b.truncated ?? 0,
    coverage_json: b.coverage === undefined ? null : JSON.stringify(b.coverage),
    metadata_json: b.metadata === undefined ? null : JSON.stringify(b.metadata),
    transformation_version: 'test@1',
    is_synthetic: b.synthetic ?? 0,
    started_at: COLLECTED,
    finished_at: COLLECTED,
  });
  return id;
}

export function seedPage(db: Db, siteId: string, path: string): string {
  const id = sid('page');
  insertRow(db, 'pages', { id, site_id: siteId, url: `${SITE_URL}${path}`, host: 'www.example.test', path, first_source: 'fixture', first_seen_at: COLLECTED, last_seen_at: COLLECTED });
  return id;
}

const gscCommon = (siteId: string, batchId: string, synthetic: number, searchType = 'web', property = GSC_PROPERTY) => ({
  site_id: siteId,
  property,
  search_type: searchType,
  date_tz: 'America/Los_Angeles',
  revision: 1,
  is_current: 1,
  batch_id: batchId,
  collected_at: COLLECTED,
  transformation_version: 'test@1',
  is_synthetic: synthetic,
});

export function seedGscProperty(db: Db, siteId: string, opts: { dates: string[]; clicks: number; impressions: number; position: number; isFinal?: number; synthetic?: number; batchId?: string; searchType?: string }): string {
  const searchType = opts.searchType ?? 'web';
  const batchId = opts.batchId ?? seedBatch(db, siteId, { source: 'gsc', dataset: 'gsc_property_daily', property: GSC_PROPERTY, start: opts.dates[0]!, end: opts.dates[opts.dates.length - 1]!, synthetic: opts.synthetic ?? 0, searchType });
  for (const date of opts.dates) {
    insertRow(db, 'gsc_property_daily', { ...gscCommon(siteId, batchId, opts.synthetic ?? 0, searchType), date, clicks: opts.clicks, impressions: opts.impressions, ctr: opts.clicks / opts.impressions, position: opts.position, aggregation_type: 'byProperty', is_final: opts.isFinal ?? 1, row_hash: sid('h') });
  }
  return batchId;
}

export function seedGscPages(db: Db, siteId: string, opts: { dates: string[]; pages: Array<{ url: string; pageId?: string | null; clicks: number; impressions: number; position: number; segmentKey?: string; country?: string; device?: string }>; batchId?: string; searchType?: string; property?: string; synthetic?: number }): string {
  const searchType = opts.searchType ?? 'web';
  const property = opts.property ?? GSC_PROPERTY;
  const batchId = opts.batchId ?? seedBatch(db, siteId, { source: 'gsc', dataset: 'gsc_page_daily', property, start: opts.dates[0]!, end: opts.dates[opts.dates.length - 1]!, searchType, synthetic: opts.synthetic ?? 0 });
  for (const date of opts.dates) {
    for (const p of opts.pages) {
      insertRow(db, 'gsc_page_daily', {
        ...gscCommon(siteId, batchId, opts.synthetic ?? 0, searchType, property),
        date,
        page: p.url,
        page_id: p.pageId ?? null,
        segment_key: p.segmentKey ?? '',
        country: p.country ?? null,
        device: p.device ?? null,
        clicks: p.clicks,
        impressions: p.impressions,
        ctr: p.clicks / p.impressions,
        position: p.position,
        aggregation_type: 'byPage',
        is_final: 1,
        row_hash: sid('h'),
      });
    }
  }
  return batchId;
}

export function seedGscPageQueries(db: Db, siteId: string, opts: { dates: string[]; rows: Array<{ url: string; pageId?: string | null; query: string; clicks: number; impressions: number; position: number }>; synthetic?: number }): string {
  const batchId = seedBatch(db, siteId, { source: 'gsc', dataset: 'gsc_page_query_daily', property: GSC_PROPERTY, start: opts.dates[0]!, end: opts.dates[opts.dates.length - 1]!, coverage: { warnings: ['anonymized queries omitted (synthetic warning)'] }, synthetic: opts.synthetic ?? 0 });
  for (const date of opts.dates) {
    for (const r of opts.rows) {
      insertRow(db, 'gsc_page_query_daily', {
        ...gscCommon(siteId, batchId, opts.synthetic ?? 0),
        date,
        page: r.url,
        page_id: r.pageId ?? null,
        query: r.query,
        segment_key: '',
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.clicks / r.impressions,
        position: r.position,
        aggregation_type: 'byPage',
        is_final: 1,
        row_hash: sid('h'),
      });
    }
  }
  return batchId;
}

export interface Ga4Row {
  channel: 'google_organic' | 'all_organic';
  landingPage: string;
  pageId?: string | null;
  sessions: number;
  engaged?: number | null;
  keyEvents?: number | null;
  primary?: number | null;
  primaryStatus?: 'observed' | 'missing' | 'unavailable' | 'incomplete';
  rate?: number | null;
  rateStatus?: 'observed' | 'missing' | 'unavailable' | 'incomplete';
  /** primary_session_rate_scale marker (migration 0100); omitted = NULL (legacy 0..1 column contract). */
  rateScale?: 'fraction' | 'percent_normalized' | 'undetermined' | null;
  hostName?: string;
  revenueMicros?: number | null;
}

/** One ingestion batch per channel view (as the real GA4 sync writes them); returns the batch ids by view. */
export function seedGa4Landing(db: Db, siteId: string, opts: { dates: string[]; rows: Ga4Row[]; synthetic?: number; batchId?: string; metadata?: unknown; complete?: number }): Record<string, string> {
  const batches: Record<string, string> = {};
  for (const view of [...new Set(opts.rows.map((r) => r.channel))]) {
    batches[view] = opts.batchId ?? seedBatch(db, siteId, { source: 'ga4', dataset: 'ga4_landing_daily', property: GA4_PROPERTY, start: opts.dates[0]!, end: opts.dates[opts.dates.length - 1]!, metadata: opts.metadata, synthetic: opts.synthetic ?? 0, view });
  }
  for (const date of opts.dates) {
    for (const r of opts.rows) {
      const batchId = batches[r.channel]!;
      insertRow(db, 'ga4_landing_daily', {
        site_id: siteId,
        property_id: GA4_PROPERTY,
        date,
        date_tz: 'Europe/Tallinn',
        channel_view: r.channel,
        landing_page: r.landingPage,
        host_name: r.hostName ?? 'www.example.test',
        page_id: r.pageId ?? null,
        segment_key: '',
        sessions: r.sessions,
        engaged_sessions: r.engaged === undefined ? r.sessions : r.engaged,
        key_events: r.keyEvents === undefined ? (r.primary ?? 0) : r.keyEvents,
        primary_event_name: PRIMARY_EVENT,
        primary_key_events: r.primary ?? null,
        primary_key_events_status: r.primaryStatus ?? (r.primary === null || r.primary === undefined ? 'missing' : 'observed'),
        primary_session_rate: r.rate ?? null,
        primary_session_rate_status: r.rateStatus ?? (r.rate === null || r.rate === undefined ? 'missing' : 'observed'),
        primary_session_rate_scale: r.rate === null || r.rate === undefined ? null : (r.rateScale ?? null),
        revenue_micros: r.revenueMicros ?? null,
        revenue_currency: r.revenueMicros === undefined || r.revenueMicros === null ? null : 'EUR',
        revenue_status: r.revenueMicros === undefined || r.revenueMicros === null ? 'unavailable' : 'observed',
        is_complete: opts.complete ?? 1,
        revision: 1,
        is_current: 1,
        row_hash: sid('h'),
        batch_id: batchId,
        collected_at: COLLECTED,
        transformation_version: 'test@1',
        is_synthetic: opts.synthetic ?? 0,
      });
    }
  }
  return batches;
}

export function seedGa4Period(db: Db, siteId: string, opts: { start: string; end: string; channel: 'google_organic' | 'all_organic'; metric: string; value: number | null; status?: string; rateScale?: 'fraction' | 'percent_normalized' | 'undetermined' | null; landingPage?: string; synthetic?: number }): void {
  const batchId = seedBatch(db, siteId, { source: 'ga4', dataset: 'ga4_period_metrics', property: GA4_PROPERTY, start: opts.start, end: opts.end, view: opts.channel, synthetic: opts.synthetic ?? 0 });
  insertRow(db, 'ga4_period_metrics', {
    site_id: siteId,
    property_id: GA4_PROPERTY,
    period_start: opts.start,
    period_end: opts.end,
    date_tz: 'Europe/Tallinn',
    channel_view: opts.channel,
    landing_page: opts.landingPage ?? '',
    metric: opts.metric,
    value: opts.value,
    value_status: opts.status ?? (opts.value === null ? 'unavailable' : 'observed'),
    rate_scale: opts.rateScale ?? null,
    is_complete: 1,
    revision: 1,
    is_current: 1,
    row_hash: sid('h'),
    batch_id: batchId,
    collected_at: COLLECTED,
    transformation_version: 'test@1',
    is_synthetic: opts.synthetic ?? 0,
  });
}

export interface WeeklyScenario {
  pricingPageId: string;
  guidePageId: string;
  propertyBatchId: string;
}

/**
 * Standard synthetic weekly scenario (complete data 2026-09-07 .. 2026-09-20):
 * - GSC property totals: 10 clicks / 200 impressions / pos 8.0 per day this week
 *   (70 clicks for the week), 8 / 180 / 9.0 per day the week before.
 * - GSC page rows: /pricing 6 clicks, /blog/guide 3 clicks per day (63/week;
 *   never to be added to the 70 property clicks).
 * - Page/query rows for /pricing: 'test co pricing' (branded) 2 clicks and
 *   'seo tool pricing' 3 clicks per day.
 * - GA4 Google organic: /pricing 5 + /blog/guide 2 sessions per day (49/week),
 *   primary-event rate 0.2 on /pricing and 0 on the guide (7 converting sessions).
 * - GA4 all organic: 9 + 4 sessions per day (91/week).
 * - Daily totalUsers rows only (6/day): the weekly user count must stay unavailable.
 */
export function seedWeeklyScenario(db: Db, siteId: string, opts: { gaRateStatus?: 'observed' | 'unavailable'; skipProperty?: boolean; rateScale?: 'fraction' | 'percent_normalized' | 'undetermined' | null } = {}): WeeklyScenario {
  const pricingPageId = seedPage(db, siteId, '/pricing');
  const guidePageId = seedPage(db, siteId, '/blog/guide');
  const cur = eachDate(WEEK.start, WEEK.end);
  const prev = eachDate(PREV_WEEK.start, PREV_WEEK.end);
  let propertyBatchId = '';
  if (!opts.skipProperty) {
    propertyBatchId = seedGscProperty(db, siteId, { dates: cur, clicks: 10, impressions: 200, position: 8 });
    seedGscProperty(db, siteId, { dates: prev, clicks: 8, impressions: 180, position: 9 });
  }
  seedGscPages(db, siteId, {
    dates: [...prev, ...cur],
    pages: [
      { url: `${SITE_URL}/pricing`, pageId: pricingPageId, clicks: 6, impressions: 100, position: 5 },
      { url: `${SITE_URL}/blog/guide`, pageId: guidePageId, clicks: 3, impressions: 150, position: 12 },
    ],
  });
  seedGscPageQueries(db, siteId, {
    dates: cur,
    rows: [
      { url: `${SITE_URL}/pricing`, pageId: pricingPageId, query: 'test co pricing', clicks: 2, impressions: 20, position: 1.5 },
      { url: `${SITE_URL}/pricing`, pageId: pricingPageId, query: 'seo tool pricing', clicks: 3, impressions: 60, position: 6 },
    ],
  });
  const rateStatus = opts.gaRateStatus ?? 'observed';
  const rate = (r: number) => (rateStatus === 'observed' ? { rate: r, rateStatus, rateScale: opts.rateScale ?? null } : { rate: null, rateStatus });
  seedGa4Landing(db, siteId, {
    dates: [...prev, ...cur],
    rows: [
      { channel: 'google_organic', landingPage: '/pricing', pageId: pricingPageId, sessions: 5, primary: 1, ...rate(0.2) },
      { channel: 'google_organic', landingPage: '/blog/guide', pageId: guidePageId, sessions: 2, primary: 0, ...rate(0) },
      { channel: 'all_organic', landingPage: '/pricing', pageId: pricingPageId, sessions: 9, primary: 1, ...rate(0.15) },
      { channel: 'all_organic', landingPage: '/blog/guide', pageId: guidePageId, sessions: 4, primary: 0, ...rate(0) },
    ],
  });
  for (const d of cur) seedGa4Period(db, siteId, { start: d, end: d, channel: 'google_organic', metric: 'totalUsers', value: 6 });
  return { pricingPageId, guidePageId, propertyBatchId };
}

export function seedRecommendation(db: Db, siteId: string, opts: { pageId: string | null; title?: string; kind?: string; query?: string | null; createdAt?: string; jobId?: string | null; status?: string }): string {
  const id = sid('rec');
  insertRow(db, 'recommendations', {
    id,
    site_id: siteId,
    job_id: opts.jobId ?? null,
    kind: opts.kind ?? 'primary',
    action_type: 'rewrite_title_meta',
    title: opts.title ?? 'Rewrite the pricing page title for "seo tool pricing" (synthetic)',
    page_id: opts.pageId,
    query: opts.query === undefined ? 'seo tool pricing' : opts.query,
    diagnosis: 'Position around 6 with CTR below comparable pages (synthetic diagnosis).',
    proposed_change: 'Put the plan comparison in the title and meta description (synthetic).',
    hypothesis: 'A clearer title raises CTR for non-branded pricing queries (synthetic).',
    success_criteria: 'CTR for the query rises over 28 days without fewer leads (synthetic).',
    risks: 'Branded CTR could drop (synthetic).',
    review_date: '2026-10-22',
    status: opts.status ?? 'proposed',
    created_at: opts.createdAt ?? '2026-09-23T08:00:00.000Z',
    updated_at: opts.createdAt ?? '2026-09-23T08:00:00.000Z',
  });
  return id;
}

/** One supported claim (evidence item) and one URL-only claim (a source URL that does not support it). */
export function seedRecommendationEvidence(db: Db, siteId: string, recId: string): void {
  const src1 = sid('src');
  insertRow(db, 'sources', { id: src1, site_id: siteId, source_type: 'gsc', trust_class: 'first_party_measurement', url: null, title: 'GSC page/query rows (synthetic)', retrieved_at: COLLECTED, content_hash: sid('c') });
  const ev1 = sid('ev');
  insertRow(db, 'evidence', { id: ev1, site_id: siteId, source_id: src1, kind: 'metric', summary: 'seo tool pricing: 21 clicks / 420 impressions, position 6 (synthetic)', excerpt: null, collected_at: COLLECTED });
  insertRow(db, 'claim_evidence', { id: sid('ce'), site_id: siteId, subject_type: 'recommendation', subject_id: recId, claim_key: 'ctr_gap', claim_text: 'The query has a CTR gap versus comparable pages.', claim_label: 'OBSERVED', evidence_id: ev1, support: 'supports', created_at: COLLECTED });
  const src2 = sid('src');
  insertRow(db, 'sources', { id: src2, site_id: siteId, source_type: 'competitor_page', trust_class: 'scraped_untrusted', url: 'https://competitor.invalid/pricing', title: 'Competitor pricing page (synthetic)', retrieved_at: COLLECTED, content_hash: sid('c') });
  const ev2 = sid('ev');
  insertRow(db, 'evidence', { id: ev2, site_id: siteId, source_id: src2, kind: 'observation', summary: 'Competitor page fetched (synthetic)', excerpt: null, collected_at: COLLECTED });
  insertRow(db, 'claim_evidence', { id: sid('ce'), site_id: siteId, subject_type: 'recommendation', subject_id: recId, claim_key: 'competitor_titles', claim_text: 'Competitors mention plan comparisons in titles.', claim_label: 'OBSERVED', evidence_id: ev2, support: 'missing', created_at: COLLECTED });
}

export function seedExperiment(db: Db, siteId: string, opts: { pageId: string | null; status: string; implementedAt?: string | null; minDays?: number; minImpressions?: number }): string {
  const id = sid('exp');
  insertRow(db, 'experiments', {
    id,
    site_id: siteId,
    page_id: opts.pageId,
    type: 'title_meta',
    hypothesis: 'Synthetic hypothesis',
    evidence_json: '[]',
    proposed_change: 'Synthetic change',
    change_hash: sid('ch'),
    primary_metric: 'ctr',
    outcome_kind: 'seo_visibility',
    guardrail_metrics_json: '[]',
    min_observation_days: opts.minDays ?? 28,
    sample_requirements_json: JSON.stringify({ minImpressions: opts.minImpressions ?? 500 }),
    risks: 'Synthetic risk',
    rollback_plan: 'Restore previous title (synthetic)',
    review_date: '2026-10-15',
    status: opts.status,
    implemented_at: opts.implementedAt ?? null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-10T00:00:00.000Z',
  });
  return id;
}

export function seedContent(db: Db, siteId: string): string {
  const item = sid('ci');
  insertRow(db, 'content_items', { id: item, site_id: siteId, title: 'Guide to pricing tiers (synthetic)', stage: 'in_review', priority_score: 0.7, created_at: COLLECTED, updated_at: COLLECTED });
  const brief = sid('brief');
  insertRow(db, 'content_briefs', { id: brief, site_id: siteId, content_item_id: item, version: 1, status: 'approved', brief_json: '{}', content_hash: 'h', created_at: COLLECTED });
  const draft = sid('draft');
  insertRow(db, 'content_drafts', { id: draft, site_id: siteId, content_item_id: item, brief_id: brief, brief_version: 1, brief_hash: 'h', version: 1, status: 'needs_human_review', package_json: '{}', body_hash: 'b', unresolved_facts: 1, created_at: COLLECTED });
  insertRow(db, 'quality_reviews', { id: sid('qr'), site_id: siteId, subject_type: 'draft', subject_id: draft, verdict: 'needs_human_review', deterministic_json: '{}', reasons_json: '[]', created_at: COLLECTED });
  return item;
}

export function seedApproval(db: Db, siteId: string): string {
  const id = sid('appr');
  insertRow(db, 'approvals', {
    id,
    site_id: siteId,
    action_type: 'title_meta_change',
    target: `${SITE_URL}/pricing`,
    subject_type: 'recommendation',
    subject_id: 'rec_x',
    artifact_hash: sid('ah'),
    summary: 'Change pricing title (synthetic)',
    status: 'pending',
    requested_by: 'system',
    requested_at: '2026-09-23T08:00:00.000Z',
    expires_at: '2026-10-23T08:00:00.000Z',
  });
  return id;
}

export { addDays, eachDate };
