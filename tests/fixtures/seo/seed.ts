/**
 * SYNTHETIC FIXTURE DATA for seo/router tests. Uses reserved example domains
 * (*.test / *.invalid) only. Every metric row is flagged is_synthetic = 1.
 * Nothing here is real site data.
 */
import { newId } from '../../../src/core/ids.js';
import { eachDate } from '../../../src/core/time.js';
import type { Db } from '../../../src/database/db.js';

export const SYNTHETIC_LABEL = { _synthetic: true, note: 'Synthetic seo-router test fixture; example.test domains only.' } as const;
export const GSC_TZ = 'America/Los_Angeles';
export const GA4_TZ = 'Europe/Tallinn';
export const PROPERTY = 'sc-domain:example.test';
export const GA4_PROPERTY = '123456789';

let counter = 0;
const uniq = () => `${Date.now().toString(36)}-${(counter++).toString(36)}`;

export interface GscRowIn {
  date: string;
  page?: string;
  query?: string;
  clicks: number;
  impressions: number;
  position?: number | null;
  isFinal?: boolean;
  segmentKey?: string;
  aggregationType?: string;
  searchType?: string;
  property?: string;
  revision?: number;
  isCurrent?: boolean;
}

export interface Ga4RowIn {
  date: string;
  landingPage: string;
  hostName?: string;
  sessions: number;
  engagedSessions?: number | null;
  keyEvents?: number | null;
  eventName?: string | null;
  primaryKeyEvents?: number | null;
  primaryKeyEventsStatus?: 'observed' | 'missing' | 'unavailable' | 'incomplete';
  rate?: number | null;
  rateStatus?: 'observed' | 'missing' | 'unavailable' | 'incomplete';
  revenueMicros?: number | null;
  revenueCurrency?: string | null;
  revenueStatus?: 'observed' | 'missing' | 'unavailable' | 'incomplete';
  isComplete?: boolean;
  channelView?: 'google_organic' | 'all_organic';
  segmentKey?: string;
  propertyId?: string;
}

export class SeoSeeder {
  readonly now: string;
  constructor(
    readonly db: Db,
    readonly siteId: string,
    now = '2026-09-24T00:00:00.000Z',
  ) {
    this.now = now;
  }

  batch(source: 'gsc' | 'ga4', dataset: string, property: string, start: string, end: string, opts: { status?: string; truncated?: boolean; request?: Record<string, unknown>; metadata?: Record<string, unknown> } = {}): string {
    const id = newId('batch');
    this.db.run(
      `INSERT INTO ingestion_batches (id, site_id, source, dataset, property, date_start, date_end, request_json, status, truncated, metadata_json, transformation_version, is_synthetic, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fixture@1', 1, ?, ?)`,
      [id, this.siteId, source, dataset, property, start, end, JSON.stringify({ ...SYNTHETIC_LABEL, ...(opts.request ?? { type: 'web', dataState: 'final' }) }), opts.status ?? 'succeeded', opts.truncated ? 1 : 0, opts.metadata ? JSON.stringify(opts.metadata) : null, this.now, this.now],
    );
    return id;
  }

  gscPage(rows: GscRowIn[], batchId?: string): void {
    const b = batchId ?? this.autoBatch('gsc', 'gsc_page_daily', rows[0]?.property ?? PROPERTY, rows);
    for (const r of rows) {
      this.db.run(
        `INSERT INTO gsc_page_daily (site_id, property, search_type, date, date_tz, page, segment_key, clicks, impressions, ctr, position, aggregation_type, is_final, revision, is_current, row_hash, batch_id, collected_at, transformation_version, is_synthetic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fixture@1', 1)`,
        [this.siteId, r.property ?? PROPERTY, r.searchType ?? 'web', r.date, GSC_TZ, r.page!, r.segmentKey ?? '', r.clicks, r.impressions, r.impressions ? r.clicks / r.impressions : null, r.position ?? null, r.aggregationType ?? 'byPage', r.isFinal === false ? 0 : 1, r.revision ?? 1, r.isCurrent === false ? 0 : 1, uniq(), b, this.now],
      );
    }
  }

  gscQuery(rows: GscRowIn[], batchId?: string): void {
    const b = batchId ?? this.autoBatch('gsc', 'gsc_page_query_daily', rows[0]?.property ?? PROPERTY, rows);
    for (const r of rows) {
      this.db.run(
        `INSERT INTO gsc_page_query_daily (site_id, property, search_type, date, date_tz, page, query, segment_key, clicks, impressions, ctr, position, aggregation_type, is_final, revision, is_current, row_hash, batch_id, collected_at, transformation_version, is_synthetic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fixture@1', 1)`,
        [this.siteId, r.property ?? PROPERTY, r.searchType ?? 'web', r.date, GSC_TZ, r.page!, r.query!, r.segmentKey ?? '', r.clicks, r.impressions, r.impressions ? r.clicks / r.impressions : null, r.position ?? null, r.aggregationType ?? 'byPage', r.isFinal === false ? 0 : 1, r.revision ?? 1, r.isCurrent === false ? 0 : 1, uniq(), b, this.now],
      );
    }
  }

  gscProperty(rows: GscRowIn[], batchId?: string): void {
    const b = batchId ?? this.autoBatch('gsc', 'gsc_property_daily', rows[0]?.property ?? PROPERTY, rows);
    for (const r of rows) {
      this.db.run(
        `INSERT INTO gsc_property_daily (site_id, property, search_type, date, date_tz, clicks, impressions, ctr, position, aggregation_type, is_final, revision, is_current, row_hash, batch_id, collected_at, transformation_version, is_synthetic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'byProperty', ?, ?, ?, ?, ?, ?, 'fixture@1', 1)`,
        [this.siteId, r.property ?? PROPERTY, r.searchType ?? 'web', r.date, GSC_TZ, r.clicks, r.impressions, r.impressions ? r.clicks / r.impressions : null, r.position ?? null, r.isFinal === false ? 0 : 1, r.revision ?? 1, r.isCurrent === false ? 0 : 1, uniq(), b, this.now],
      );
    }
  }

  ga4Landing(rows: Ga4RowIn[], batchId?: string, eventNameDefault = 'generate_lead'): void {
    const b = batchId ?? this.autoBatch('ga4', 'ga4_landing_daily', rows[0]?.propertyId ?? GA4_PROPERTY, rows);
    for (const r of rows) {
      const rate = r.rate === undefined ? null : r.rate;
      this.db.run(
        `INSERT INTO ga4_landing_daily (site_id, property_id, date, date_tz, channel_view, landing_page, host_name, segment_key, sessions, engaged_sessions, key_events, primary_event_name, primary_key_events, primary_key_events_status, primary_session_rate, primary_session_rate_status, revenue_micros, revenue_currency, revenue_status, is_complete, revision, is_current, row_hash, batch_id, collected_at, transformation_version, is_synthetic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, 'fixture@1', 1)`,
        [
          this.siteId,
          r.propertyId ?? GA4_PROPERTY,
          r.date,
          GA4_TZ,
          r.channelView ?? 'google_organic',
          r.landingPage,
          r.hostName ?? 'www.example.test',
          r.segmentKey ?? '',
          r.sessions,
          r.engagedSessions === undefined ? r.sessions : r.engagedSessions,
          r.keyEvents === undefined ? null : r.keyEvents,
          r.eventName === undefined ? eventNameDefault : r.eventName,
          r.primaryKeyEvents === undefined ? null : r.primaryKeyEvents,
          r.primaryKeyEventsStatus ?? (r.primaryKeyEvents === undefined || r.primaryKeyEvents === null ? 'missing' : 'observed'),
          rate,
          r.rateStatus ?? (rate === null ? 'missing' : 'observed'),
          r.revenueMicros ?? null,
          r.revenueCurrency ?? null,
          r.revenueStatus ?? 'missing',
          r.isComplete === false ? 0 : 1,
          uniq(),
          b,
          this.now,
        ],
      );
    }
  }

  ga4Period(p: { start: string; end: string; metric: string; value: number | null; landingPage?: string; status?: string; channelView?: string }): void {
    const b = this.batch('ga4', 'ga4_period_metrics', GA4_PROPERTY, p.start, p.end);
    this.db.run(
      `INSERT INTO ga4_period_metrics (site_id, property_id, period_start, period_end, date_tz, channel_view, landing_page, metric, value, value_status, is_complete, revision, is_current, row_hash, batch_id, collected_at, transformation_version, is_synthetic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, ?, 'fixture@1', 1)`,
      [this.siteId, GA4_PROPERTY, p.start, p.end, GA4_TZ, p.channelView ?? 'google_organic', p.landingPage ?? '', p.metric, p.value, p.status ?? (p.value === null ? 'missing' : 'observed'), uniq(), b, this.now],
    );
  }

  ga4Metadata(timeZone = GA4_TZ): void {
    this.db.run('INSERT OR REPLACE INTO ga4_property_metadata (site_id, property_id, time_zone, currency_code, fetched_at) VALUES (?, ?, ?, ?, ?)', [this.siteId, GA4_PROPERTY, timeZone, 'EUR', this.now]);
  }

  private autoBatch(source: 'gsc' | 'ga4', dataset: string, property: string, rows: Array<{ date: string }>): string {
    const dates = rows.map((r) => r.date).sort();
    return this.batch(source, dataset, property, dates[0] ?? '2026-01-01', dates[dates.length - 1] ?? '2026-01-01');
  }

  page(url: string, opts: { pageType?: string | null; lifecycle?: string; firstSource?: string; excluded?: boolean; protected?: boolean } = {}): string {
    const u = new URL(url);
    const id = newId('page');
    this.db.run(
      `INSERT INTO pages (id, site_id, url, host, path, first_source, page_type, is_protected, is_excluded, lifecycle, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, this.siteId, u.toString(), u.hostname, u.pathname, opts.firstSource ?? 'fixture', opts.pageType ?? null, opts.protected ? 1 : 0, opts.excluded ? 1 : 0, opts.lifecycle ?? 'active', this.now, this.now],
    );
    return id;
  }

  /** A crawl row; synthetic (is_synthetic = 1) unless `synthetic: false` (tests of the non-synthetic code path only; the data stays fixture data). */
  crawl(kind: 'own_site' | 'competitor' | 'single_page' = 'own_site', opts: { status?: string; pagesFetched?: number; pagesAttempted?: number; stopReason?: string | null; startedAt?: string; synthetic?: boolean } = {}): string {
    const id = newId('crawl');
    this.db.run(
      `INSERT INTO crawls (id, site_id, kind, status, pages_attempted, pages_fetched, stop_reason, is_synthetic, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, this.siteId, kind, opts.status ?? 'completed', opts.pagesAttempted ?? opts.pagesFetched ?? 0, opts.pagesFetched ?? 0, opts.stopReason ?? null, opts.synthetic === false ? 0 : 1, opts.startedAt ?? this.now, opts.startedAt ?? this.now],
    );
    return id;
  }

  crawlResult(
    crawlId: string,
    r: {
      requestedUrl: string;
      finalUrl?: string | null;
      status?: number | null;
      redirectChain?: unknown;
      canonical?: string | null;
      title?: string | null;
      headings?: Array<{ level: number; text: string }>;
      textRef?: string | null;
      wordCount?: number | null;
      structuredData?: unknown;
      linksExternal?: number | null;
      blockedReason?: string | null;
      pageId?: string | null;
      metaRobots?: string | null;
      fetchedAt?: string;
      /** Competitor crawls: the search query the page was crawled for (stored in extraction_json like the crawler does). */
      query?: string | null;
    },
  ): string {
    const id = newId('cr');
    this.db.run(
      `INSERT INTO crawl_results (id, crawl_id, site_id, page_id, requested_url, final_url, status_code, redirect_chain_json, fetched_at, render_mode, canonical_url, title, headings_json, word_count, text_ref, structured_data_json, links_external, blocked_reason, meta_robots, extraction_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'fixture', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        crawlId,
        this.siteId,
        r.pageId ?? null,
        r.requestedUrl,
        r.finalUrl === undefined ? r.requestedUrl : r.finalUrl,
        r.status === undefined ? 200 : r.status,
        r.redirectChain === undefined ? null : JSON.stringify(r.redirectChain),
        r.fetchedAt ?? this.now,
        r.canonical ?? null,
        r.title ?? null,
        r.headings ? JSON.stringify(r.headings) : null,
        r.wordCount ?? null,
        r.textRef ?? null,
        r.structuredData === undefined ? null : JSON.stringify(r.structuredData),
        r.linksExternal ?? null,
        r.blockedReason ?? null,
        r.metaRobots ?? null,
        r.query === undefined ? null : JSON.stringify({ query: r.query, untrusted: true, _synthetic: true }),
      ],
    );
    return id;
  }

  /**
   * A redirect exactly as the crawler stores it (src/crawler/crawl.ts handleFetch +
   * src/crawler/store.ts insertResult): the redirecting row keeps the FIRST status
   * (e.g. 301) with the hop list [{url, status, location}] and `finalStatus` in
   * extraction_json; the final URL gets its own row with the final response and no
   * chain. `finalStatus: null` = the chain did not complete (no final row).
   */
  crawlerRedirect(crawlId: string, from: string, to: string, opts: { hops?: Array<{ url: string; status: number; location: string }>; finalStatus?: number | null; fetchedAt?: string; canonical?: string | null } = {}): { redirectRowId: string; finalRowId: string | null } {
    const hops = opts.hops ?? [{ url: from, status: 301, location: to }];
    const finalStatus = opts.finalStatus === undefined ? 200 : opts.finalStatus;
    const redirectRowId = this.crawlResult(crawlId, { requestedUrl: from, finalUrl: to, status: hops[0]!.status, redirectChain: hops, fetchedAt: opts.fetchedAt ?? this.now });
    this.db.run('UPDATE crawl_results SET extraction_json = ? WHERE id = ?', [JSON.stringify({ fetchErrorCode: null, finalStatus }), redirectRowId]);
    if (finalStatus === null) return { redirectRowId, finalRowId: null };
    const finalRowId = this.crawlResult(crawlId, { requestedUrl: to, finalUrl: to, status: finalStatus, canonical: finalStatus >= 200 && finalStatus < 300 ? (opts.canonical === undefined ? to : opts.canonical) : null, fetchedAt: opts.fetchedAt ?? this.now });
    return { redirectRowId, finalRowId };
  }

  internalLink(crawlId: string, sourceResultId: string, targetUrl: string, anchor: string, ids: { sourcePageId?: string | null; targetPageId?: string | null } = {}): void {
    this.db.run(
      'INSERT INTO internal_links (site_id, crawl_id, source_result_id, source_page_id, target_url, target_page_id, anchor_text) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [this.siteId, crawlId, sourceResultId, ids.sourcePageId ?? null, targetUrl, ids.targetPageId ?? null, anchor],
    );
  }

  technicalIssue(i: { url: string; pageId?: string | null; type: string; severity?: string; confirmed?: boolean; heuristic?: boolean; status?: string; detail?: Record<string, unknown> }): void {
    this.db.run(
      `INSERT INTO technical_issues (id, site_id, page_id, url, issue_type, severity, is_heuristic, confirmed, detail_json, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId('issue'), this.siteId, i.pageId ?? null, i.url, i.type, i.severity ?? 'high', i.heuristic ? 1 : 0, i.confirmed ? 1 : 0, JSON.stringify(i.detail ?? { message: `synthetic ${i.type}` }), i.status ?? 'open', this.now, this.now],
    );
  }

  inspection(i: { url: string; pageId?: string | null; verdict?: string | null; coverageState?: string | null; indexingState?: string | null; robotsTxtState?: string | null; pageFetchState?: string | null; googleCanonical?: string | null; inspectedAt?: string }): void {
    this.db.run(
      `INSERT INTO url_inspections (id, site_id, page_id, property, url, verdict, coverage_state, indexing_state, robots_txt_state, page_fetch_state, google_canonical, is_synthetic, inspected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [newId('insp'), this.siteId, i.pageId ?? null, PROPERTY, i.url, i.verdict ?? null, i.coverageState ?? null, i.indexingState ?? null, i.robotsTxtState ?? null, i.pageFetchState ?? null, i.googleCanonical ?? null, i.inspectedAt ?? this.now],
    );
  }

  experiment(e: { pageId: string | null; status: string; type?: string; observationEnd?: string | null; reviewDate?: string | null; updatedAt?: string; comparisonPages?: Array<{ pageId: string; url: string }> }): string {
    const id = newId('exp');
    this.db.run(
      `INSERT INTO experiments (id, site_id, page_id, type, hypothesis, evidence_json, proposed_change, change_hash, primary_metric, outcome_kind, guardrail_metrics_json, min_observation_days, sample_requirements_json, risks, rollback_plan, review_date, status, observation_end, comparison_pages_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'synthetic hypothesis', '{}', 'synthetic change', 'hash', 'clicks', 'seo_visibility', '[]', 28, '{}', 'none', 'revert', ?, ?, ?, ?, ?, ?)`,
      [id, this.siteId, e.pageId, e.type ?? 'title_meta', e.reviewDate ?? null, e.status, e.observationEnd ?? null, e.comparisonPages ? JSON.stringify(e.comparisonPages) : null, this.now, e.updatedAt ?? this.now],
    );
    return id;
  }

  decision(d: { subjectType: string; subjectId: string; decision: string; reason?: string; decidedAt?: string }): void {
    this.db.run('INSERT INTO decisions (id, site_id, subject_type, subject_id, decision, reason, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      newId('dec'),
      this.siteId,
      d.subjectType,
      d.subjectId,
      d.decision,
      d.reason ?? null,
      'owner:test',
      d.decidedAt ?? this.now,
    ]);
  }
}

/** Build one row per date for [start, end] with a row factory. */
export function daily<T>(start: string, end: string, fn: (date: string, i: number) => T): T[] {
  return eachDate(start, end).map(fn);
}
