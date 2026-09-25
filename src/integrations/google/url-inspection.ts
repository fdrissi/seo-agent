import type { AppContext } from '../../app/context.js';
import { AppError } from '../../core/errors.js';
import { newId } from '../../core/ids.js';
import type { RetryPolicy } from '../../core/retry.js';
import { addDays, dateInZone } from '../../core/time.js';
import { GoogleApiError } from './errors.js';
import { GSC_TIME_ZONE, Pacer, URL_INSPECTION_MIN_INTERVAL_MS, inspectUrl, urlBelongsToProperty, type GscCallContext, type IndexStatusResult } from './gsc-client.js';
import { configuredGscScope } from '../../seo/coverage.js';
import { assertNetworkAllowed } from './gsc-properties.js';
import type { GoogleApiClient, GoogleAuthProvider } from './types.js';

/**
 * Selective URL Inspection (urlInspection.index.inspect). Results describe the
 * version in Google's index ("indexed_state"); the API cannot run a live test.
 * Nothing here infers "not indexed" from zero impressions or from absence in
 * performance data: only an inspection result says anything about indexing.
 */

/** Documented per-site daily quota (GSC3). */
export const URL_INSPECTION_DAILY_QUOTA = 2_000;

/** Version of the mapping from urlInspection.index.inspect responses to url_inspections rows. */
export const URL_INSPECTION_TRANSFORMATION_VERSION = 'url-inspection@1';

export const INDEXED_STATE_NOTE = "Indexed-state information from Google's index (URL Inspection API). Not a live test of the current page.";

export interface InspectionOutcome {
  url: string;
  status: 'inspected' | 'skipped' | 'failed';
  reason?: string;
  verdict?: string | null;
  coverageState?: string | null;
  indexingState?: string | null;
  robotsTxtState?: string | null;
  pageFetchState?: string | null;
  googleCanonical?: string | null;
  userCanonical?: string | null;
  lastCrawlTime?: string | null;
  inspectionId?: string;
}

export interface InspectUrlsResult {
  /**
   * 'nothing_inspected': no URL was inspected and none failed (every URL was
   * skipped: not under the property, cap or daily quota exhausted, dry run,
   * or no URL given). It is not a success: no indexed state was observed.
   */
  status: 'succeeded' | 'partial' | 'disabled' | 'failed' | 'nothing_inspected';
  property: string | null;
  cap: number;
  inspected: number;
  skipped: number;
  failed: number;
  outcomes: InspectionOutcome[];
  note: string;
  synthetic: boolean;
}

/** Verdict mapping from the contract: PASS = valid, FAIL = error, NEUTRAL = excluded. */
export function describeInspection(o: Pick<InspectionOutcome, 'verdict' | 'coverageState'>): string {
  const v = (o.verdict ?? 'VERDICT_UNSPECIFIED').toUpperCase();
  const label = v === 'PASS' ? 'valid (in Google index)' : v === 'FAIL' ? 'error / invalid' : v === 'NEUTRAL' ? 'excluded' : 'unspecified';
  return `Google's indexed version: ${label}${o.coverageState ? ` (${o.coverageState})` : ''}. Not a live test.`;
}

/**
 * Priority URLs: the configured site URL, then pages with the most Search
 * Console clicks/impressions in the last 28 days (Pacific dates) of the
 * configured property and its primary search type (unsegmented rows only, so
 * country/device rows and other search types are never added in). Pages with
 * no impressions are not labelled as non-indexed; they can be inspected by
 * passing them explicitly.
 */
export function selectPriorityUrls(ctx: AppContext, limit: number): string[] {
  const scope = configuredGscScope(ctx.config);
  const property = scope?.property ?? null;
  const out: string[] = [];
  if (property && urlBelongsToProperty(ctx.config.site.url, property)) out.push(ctx.config.site.url);
  if (scope) {
    const today = dateInZone(ctx.clock.now(), GSC_TIME_ZONE);
    const rows = ctx.db.all<{ page: string }>(
      `SELECT page FROM gsc_page_daily WHERE site_id = ? AND property = ? AND search_type = ? AND segment_key = '' AND is_current = 1 AND date >= ?
       GROUP BY page ORDER BY SUM(clicks) DESC, SUM(impressions) DESC, page ASC LIMIT ?`,
      [ctx.siteId, scope.property, scope.searchType, addDays(today, -28), Math.max(1, limit * 2)],
    );
    for (const r of rows) if (!out.includes(r.page)) out.push(r.page);
  }
  return out.slice(0, Math.max(0, limit));
}

function inspectionsLast24h(ctx: AppContext, property: string): number {
  const since = new Date(ctx.clock.now().getTime() - 86_400_000).toISOString();
  return ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM url_inspections WHERE site_id = ? AND property = ? AND inspected_at >= ? AND is_synthetic = 0', [ctx.siteId, property, since])?.n ?? 0;
}

export async function inspectUrls(
  ctx: AppContext,
  provider: GoogleAuthProvider,
  urls: string[],
  opts: { client?: GoogleApiClient; max?: number; languageCode?: string; retry?: RetryPolicy; pacingMs?: number } = {},
): Promise<InspectUrlsResult> {
  const synthetic = provider.mode === 'fixture';
  const property = ctx.config.google.searchConsoleProperty;
  const base: InspectUrlsResult = { status: 'succeeded', property, cap: 0, inspected: 0, skipped: 0, failed: 0, outcomes: [], note: INDEXED_STATE_NOTE, synthetic };
  if (!ctx.settings.features.urlInspection) {
    return { ...base, status: 'disabled', note: 'URL Inspection is disabled by the site feature flags (features.urlInspection).' };
  }
  if (!property) {
    throw new AppError('CONFIG_MISSING', 'No Search Console property is configured (google.searchConsoleProperty).', { hint: 'Run `npm run cli -- auth status` and copy an accessible property exactly into the site config.' });
  }
  const configuredCap = ctx.config.google.gsc.urlInspectionMaxPerRun;
  const quotaLeft = Math.max(0, URL_INSPECTION_DAILY_QUOTA - inspectionsLast24h(ctx, property));
  const cap = Math.min(opts.max ?? configuredCap, configuredCap, quotaLeft);
  const result: InspectUrlsResult = { ...base, cap };
  const unique = [...new Set(urls)];
  const toInspect: string[] = [];
  for (const url of unique) {
    if (!urlBelongsToProperty(url, property)) {
      result.outcomes.push({ url, status: 'skipped', reason: `Not under the Search Console property ${property}` });
    } else if (toInspect.length >= cap) {
      result.outcomes.push({ url, status: 'skipped', reason: cap === quotaLeft && quotaLeft < configuredCap ? 'Daily URL Inspection quota budget reached' : `Per-run cap reached (urlInspectionMaxPerRun=${configuredCap})` });
    } else toInspect.push(url);
  }
  if (toInspect.length && !(ctx.dryRun)) {
    assertNetworkAllowed(ctx, provider, 'url_inspection');
    const client = opts.client ?? (await provider.getClient());
    const pacer = new Pacer(opts.pacingMs ?? (synthetic ? 0 : URL_INSPECTION_MIN_INTERVAL_MS));
    const c: GscCallContext = { ctx, client, synthetic, pacer, ...(opts.retry ? { retry: opts.retry } : {}) };
    for (const url of toInspect) {
      try {
        const { response, rawRef } = await inspectUrl(c, { inspectionUrl: url, siteUrl: property, ...(opts.languageCode ? { languageCode: opts.languageCode } : {}) });
        const s: IndexStatusResult = response.inspectionResult?.indexStatusResult ?? {};
        const inspectedAt = ctx.clock.now().toISOString();
        let id = newId('urli');
        // Grain (migration 0200): one result per (site, property, URL, inspected_at); an identical-instant repeat is not a new observation.
        const ins = ctx.db.run(
          `INSERT INTO url_inspections (id, site_id, page_id, property, url, inspection_kind, verdict, coverage_state, indexing_state, robots_txt_state, page_fetch_state,
             google_canonical, user_canonical, last_crawl_time, result_json, raw_ref, is_synthetic, inspected_at, transformation_version)
           VALUES (?, ?, NULL, ?, ?, 'indexed_state', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (site_id, property, url, inspected_at) DO NOTHING`,
          [
            id,
            ctx.siteId,
            property,
            url,
            s.verdict ?? null,
            s.coverageState ?? null,
            s.indexingState ?? null,
            s.robotsTxtState ?? null,
            s.pageFetchState ?? null,
            s.googleCanonical ?? null,
            s.userCanonical ?? null,
            s.lastCrawlTime ?? null,
            JSON.stringify(response.inspectionResult ?? {}),
            rawRef,
            synthetic ? 1 : 0,
            inspectedAt,
            URL_INSPECTION_TRANSFORMATION_VERSION,
          ],
        );
        if (ins.changes === 0) {
          id = ctx.db.get<{ id: string }>('SELECT id FROM url_inspections WHERE site_id = ? AND property = ? AND url = ? AND inspected_at = ?', [ctx.siteId, property, url, inspectedAt])?.id ?? id;
        }
        result.outcomes.push({
          url,
          status: 'inspected',
          verdict: s.verdict ?? null,
          coverageState: s.coverageState ?? null,
          indexingState: s.indexingState ?? null,
          robotsTxtState: s.robotsTxtState ?? null,
          pageFetchState: s.pageFetchState ?? null,
          googleCanonical: s.googleCanonical ?? null,
          userCanonical: s.userCanonical ?? null,
          lastCrawlTime: s.lastCrawlTime ?? null,
          inspectionId: id,
        });
      } catch (err) {
        const g = err instanceof GoogleApiError ? err : null;
        result.outcomes.push({ url, status: 'failed', reason: err instanceof Error ? err.message : String(err) });
        // Permission/auth/quota problems apply to every remaining URL: stop early.
        if (g && (g.kind === 'permission_denied' || g.kind === 'api_not_enabled' || g.kind === 'rate_limited' || g.kind === 'quota_exhausted' || g.kind === 'invalid_grant' || g.kind === 'unauthenticated' || g.kind === 'credentials' || g.kind === 'config' || g.kind === 'offline')) {
          const rest = toInspect.slice(toInspect.indexOf(url) + 1);
          for (const r of rest) result.outcomes.push({ url: r, status: 'skipped', reason: `Stopped after ${g.kind}` });
          break;
        }
      }
    }
  } else if (toInspect.length) {
    for (const url of toInspect) result.outcomes.push({ url, status: 'skipped', reason: 'Dry run: no request made' });
  }
  result.inspected = result.outcomes.filter((o) => o.status === 'inspected').length;
  result.failed = result.outcomes.filter((o) => o.status === 'failed').length;
  result.skipped = result.outcomes.filter((o) => o.status === 'skipped').length;
  result.status = result.failed > 0 ? (result.inspected > 0 ? 'partial' : 'failed') : result.inspected > 0 ? 'succeeded' : 'nothing_inspected';
  if (result.status === 'nothing_inspected') {
    result.note = `Nothing was inspected: ${result.outcomes.length ? `all ${result.outcomes.length} URL(s) were skipped (see reasons)` : 'no URL was given or selected'}. No indexed state was observed. ${INDEXED_STATE_NOTE}`;
  }
  return result;
}
