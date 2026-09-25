import type { AppContext } from '../app/context.js';
import { formatMeasured, type Measured } from '../core/measured.js';
import { addDays } from '../core/time.js';
import { describeRowLoss, ga4Coverage, type CoverageSummary, type Ga4RowLoss } from '../seo/coverage.js';
import type { IntegrationStatus } from '../integrations/types.js';
import { code, fmtDate, fmtInt, fmtNum, fmtPct, fmtTimestamp, inline } from './markdown.js';
import type { NotePlan } from './plan.js';

/**
 * Shared state and read helpers for note renderers. All SQL is parameterized
 * and scoped to the context's site. Missing data is rendered explicitly
 * (DATA UNAVAILABLE / missing), never as zero.
 */

export type Row = Record<string, unknown>;

export interface RenderLimits {
  pages: number;
  keywords: number;
  competitors: number;
  sources: number;
  contentItems: number;
  experiments: number;
  decisions: number;
  learnings: number;
}

export const DEFAULT_RENDER_LIMITS: RenderLimits = {
  pages: 1_000,
  keywords: 1_000,
  competitors: 200,
  sources: 500,
  contentItems: 500,
  experiments: 500,
  decisions: 500,
  learnings: 500,
};

export interface RenderContext {
  ctx: AppContext;
  plan: NotePlan;
  limits: RenderLimits;
  /** Trailing window for metric summaries (days, inclusive of the latest available date). */
  windowDays: number;
  gsc: { property: string; searchType: string; configured: boolean } | null;
  ga4: { propertyId: string; configured: boolean } | null;
  nowIso: string;
  integrationStatuses: IntegrationStatus[] | null;
  /** Shown under the integration table when the statuses are incomplete (for example offline checks only). */
  integrationStatusNote: string | null;
  /** Keyword entity key by normalized keyword text (for linking GSC queries). */
  keywordByNormalized: Map<string, string>;
  /** Competitor entity key by normalized domain. */
  competitorByDomain: Map<string, string>;
  /** Per-render memo for derived data shared by several notes (AEO assessments, link suggestions); see notes-site.ts. */
  cache?: Map<string, unknown>;
  /** Notes marked stale in this render (their record no longer exists); set by renderAll before the index is built. */
  staleNotes?: Array<{ relPath: string; noteId: string; kind: string; title: string; status: string; supersededBy?: string | null }>;
}

export function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

export function all(rc: RenderContext, sql: string, params: unknown[] = []): Row[] {
  return rc.ctx.db.all<Row>(sql, params);
}

export function one(rc: RenderContext, sql: string, params: unknown[] = []): Row | undefined {
  return rc.ctx.db.get<Row>(sql, params);
}

export function normalizeQuery(q: string): string {
  return q.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function normalizeDomain(d: string): string {
  return d.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
}

/** Pick the Search Console property and search type used for summaries. */
export function pickGsc(ctx: AppContext): RenderContext['gsc'] {
  const searchType = ctx.config.google.gsc.searchTypes[0] ?? 'web';
  const configured = ctx.config.google.searchConsoleProperty;
  if (configured) return { property: configured, searchType, configured: true };
  const row = ctx.db.get<{ property: string }>(
    'SELECT property, COUNT(*) AS n FROM gsc_page_daily_current WHERE site_id = ? AND search_type = ? GROUP BY property ORDER BY n DESC, property LIMIT 1',
    [ctx.siteId, searchType],
  );
  return row ? { property: row.property, searchType, configured: false } : null;
}

export function pickGa4(ctx: AppContext): RenderContext['ga4'] {
  const configured = ctx.config.google.ga4PropertyId;
  if (configured) return { propertyId: configured, configured: true };
  const row = ctx.db.get<{ property_id: string }>(
    'SELECT property_id, COUNT(*) AS n FROM ga4_landing_daily_current WHERE site_id = ? GROUP BY property_id ORDER BY n DESC, property_id LIMIT 1',
    [ctx.siteId],
  );
  return row ? { propertyId: row.property_id, configured: false } : null;
}

export interface GscWindowSummary {
  available: boolean;
  reason?: string;
  start?: string;
  end?: string;
  dateTz?: string;
  daysWithRows?: number;
  clicks?: number;
  impressions?: number;
  ctr?: number | null;
  position?: number | null;
  allFinal?: boolean;
  collectedAt?: string | null;
  synthetic?: boolean;
}

/** Aggregate additive GSC rows over the trailing window ending at the latest available date. */
export function gscWindow(rc: RenderContext, table: 'gsc_page_daily_current' | 'gsc_property_daily_current', filter: { pageId?: string }): GscWindowSummary {
  if (!rc.gsc) return { available: false, reason: 'no Search Console property is configured or ingested' };
  const pageClause = table === 'gsc_page_daily_current' ? " AND page_id = ? AND segment_key = ''" : '';
  const pageParams = table === 'gsc_page_daily_current' ? [filter.pageId] : [];
  const latest = one(rc, `SELECT MAX(date) AS d FROM ${table} WHERE site_id = ? AND property = ? AND search_type = ?${pageClause}`, [rc.ctx.siteId, rc.gsc.property, rc.gsc.searchType, ...pageParams]);
  const end = str(latest?.d);
  if (!end) return { available: false, reason: `no Search Console rows for property ${rc.gsc.property} (${rc.gsc.searchType})` };
  const start = addDays(end, -(rc.windowDays - 1));
  const agg = one(
    rc,
    `SELECT SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(position * impressions) AS pw, COUNT(DISTINCT date) AS days,
            MIN(is_final) AS min_final, MAX(collected_at) AS collected, MAX(date_tz) AS tz, MAX(is_synthetic) AS syn
       FROM ${table} WHERE site_id = ? AND property = ? AND search_type = ?${pageClause} AND date BETWEEN ? AND ?`,
    [rc.ctx.siteId, rc.gsc.property, rc.gsc.searchType, ...pageParams, start, end],
  );
  const clicks = num(agg?.clicks) ?? 0;
  const impressions = num(agg?.impressions) ?? 0;
  const pw = num(agg?.pw);
  return {
    available: true,
    start,
    end,
    dateTz: str(agg?.tz) ?? 'unknown',
    daysWithRows: num(agg?.days) ?? 0,
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : null,
    position: impressions > 0 && pw !== null ? pw / impressions : null,
    allFinal: num(agg?.min_final) === 1,
    collectedAt: str(agg?.collected),
    synthetic: num(agg?.syn) === 1,
  };
}

export function renderGscWindow(rc: RenderContext, s: GscWindowSummary, label: string): string[] {
  if (!s.available) return [`- ${label}: DATA UNAVAILABLE (${inline(s.reason)})`];
  const lines = [
    `- ${label} (${inline(s.start)} to ${inline(s.end)}, Search Console dates in ${inline(s.dateTz)}; rows on ${s.daysWithRows} of ${rc.windowDays} days):`,
    `  - Clicks ${fmtInt(s.clicks)} · Impressions ${fmtInt(s.impressions)} · CTR ${s.ctr === null ? 'n/a (no impressions)' : fmtPct(s.ctr)} (clicks ÷ impressions) · Avg position ${s.position === null ? 'n/a' : fmtNum(s.position, 1)} (impression-weighted)`,
    `  - Freshness: latest date ${inline(s.end)}; collected ${fmtTimestamp(s.collectedAt)}; ${s.allFinal ? 'all days final' : 'includes non-final (fresh) days that may still change'}`,
  ];
  if ((s.daysWithRows ?? 0) < rc.windowDays) lines.push('  - Days without rows are missing from the export (Search Console omits days without impressions); they are not recorded as zero.');
  if (s.synthetic) lines.push('  - SYNTHETIC fixture rows.');
  return lines;
}

export interface Ga4ChannelSummary {
  channel: string;
  /** Sum of the rows in the window (0 when the page has none: read `sessionsMeasured` for what that means). */
  sessions: number;
  /**
   * Page summaries only: the sessions with their status. Collected dates without
   * a landing row are an observed zero only when GA4 reported no row loss for
   * them; where it reported "(other)" bucketing, thresholding, or sampling, a
   * missing row is unknown, so the value is incomplete (never presented as 0).
   */
  sessionsMeasured?: Measured<number>;
  engaged: Measured<number>;
  primaryKeyEvents: Measured<number>;
  primaryEventName: string | null;
  complete: boolean;
  collectedAt: string | null;
  synthetic: boolean;
}

export interface Ga4WindowSummary {
  available: boolean;
  reason?: string;
  start?: string;
  end?: string;
  dateTz?: string;
  channels: Ga4ChannelSummary[];
}

/**
 * How a page's missing landing rows read on the collected dates of a window,
 * with the same rule as seo/metrics.aggregateGa4: a collected, final date
 * without a row is a zero only when GA4 reported no row loss for it.
 */
/** Per-render memo of GA4 coverage by view and window (shared by every page note of one render). */
const coverageMemo = new WeakMap<RenderContext, Map<string, CoverageSummary>>();

function cachedGa4Coverage(rc: RenderContext, channel: string, start: string, end: string): CoverageSummary {
  let memo = coverageMemo.get(rc);
  if (!memo) {
    memo = new Map();
    coverageMemo.set(rc, memo);
  }
  const key = `${rc.ga4!.propertyId}|${channel}|${start}|${end}`;
  let c = memo.get(key);
  if (!c) {
    c = ga4Coverage(rc.ctx.db, rc.ctx.siteId, { propertyId: rc.ga4!.propertyId, start, end, channelView: channel, segmentKey: '' });
    memo.set(key, c);
  }
  return c;
}

function pageAbsence(rc: RenderContext, pageId: string, channel: 'google_organic' | 'all_organic', start: string, end: string): { rowDates: Set<string>; lossDates: string[]; reasons: Ga4RowLoss[]; zeroDates: number; missingDates: number; covered: boolean } {
  const coverage = cachedGa4Coverage(rc, channel, start, end);
  const rowDates = new Set(
    all(rc, `SELECT DISTINCT date FROM ga4_landing_daily_current WHERE site_id = ? AND property_id = ? AND page_id = ? AND channel_view = ? AND segment_key = '' AND date BETWEEN ? AND ?`, [rc.ctx.siteId, rc.ga4!.propertyId, pageId, channel, start, end]).map((r) => String(r.date)),
  );
  const lossDates: string[] = [];
  const reasons = new Set<Ga4RowLoss>();
  let zeroDates = 0;
  let missingDates = 0;
  for (const [d, c] of Object.entries(coverage.byDate)) {
    if (rowDates.has(d)) continue;
    if (c.state === 'missing') missingDates++;
    else if (c.state !== 'final' || c.truncated) continue;
    else if (c.rowLoss?.length) {
      lossDates.push(d);
      for (const r of c.rowLoss) reasons.add(r);
    } else zeroDates++;
  }
  return { rowDates, lossDates: lossDates.sort(), reasons: [...reasons], zeroDates, missingDates, covered: coverage.missing.length < Object.keys(coverage.byDate).length };
}

function absenceReason(a: { lossDates: string[]; reasons: Ga4RowLoss[] }): string {
  return `no landing row on ${a.lossDates.length} collected date(s) (e.g. ${a.lossDates[0]}) where GA4 reported ${describeRowLoss(a.reasons)}; a missing row there is unknown, not zero`;
}

/** Sessions and primary key events per channel view (google_organic and all_organic kept distinct). */
export function ga4Window(rc: RenderContext, filter: { pageId?: string }): Ga4WindowSummary {
  if (!rc.ga4) return { available: false, reason: 'no GA4 property is configured or ingested', channels: [] };
  const pageClause = filter.pageId ? ' AND page_id = ?' : '';
  const pageParams = filter.pageId ? [filter.pageId] : [];
  const latest = one(rc, `SELECT MAX(date) AS d FROM ga4_landing_daily_current WHERE site_id = ? AND property_id = ? AND segment_key = ''${pageClause}`, [rc.ctx.siteId, rc.ga4.propertyId, ...pageParams]);
  const end = str(latest?.d);
  if (!end && filter.pageId) return pageWithoutRows(rc, filter.pageId);
  if (!end) return { available: false, reason: `no GA4 landing-page rows for property ${rc.ga4.propertyId}`, channels: [] };
  const start = addDays(end, -(rc.windowDays - 1));
  const rows = all(
    rc,
    `SELECT channel_view, SUM(sessions) AS sessions, SUM(engaged_sessions) AS engaged, COUNT(engaged_sessions) AS engaged_n, COUNT(*) AS n,
            SUM(CASE WHEN primary_key_events_status = 'observed' THEN primary_key_events END) AS pke,
            SUM(CASE WHEN primary_key_events_status = 'observed' THEN 1 ELSE 0 END) AS pke_obs,
            MAX(primary_event_name) AS ev, MIN(is_complete) AS complete, MAX(collected_at) AS collected, MAX(date_tz) AS tz, MAX(is_synthetic) AS syn
       FROM ga4_landing_daily_current
      WHERE site_id = ? AND property_id = ? AND segment_key = ''${pageClause} AND date BETWEEN ? AND ?
      GROUP BY channel_view ORDER BY channel_view`,
    [rc.ctx.siteId, rc.ga4.propertyId, ...pageParams, start, end],
  );
  let tz = 'unknown';
  const channels = rows.map((r): Ga4ChannelSummary => {
    tz = str(r.tz) ?? tz;
    const n = num(r.n) ?? 0;
    const engagedN = num(r.engaged_n) ?? 0;
    const obs = num(r.pke_obs) ?? 0;
    const engaged: Measured<number> =
      engagedN === n ? { status: 'observed', value: num(r.engaged) ?? 0 } : engagedN === 0 ? { status: 'missing', reason: 'engaged sessions not reported' } : { status: 'incomplete', reason: `reported on ${engagedN} of ${n} rows`, partialValue: num(r.engaged) ?? 0 };
    const pke: Measured<number> =
      obs === n && n > 0
        ? { status: 'observed', value: num(r.pke) ?? 0 }
        : obs === 0
          ? { status: 'missing', reason: 'primary key event not observed (not configured, not marked as a key event, or not collected)' }
          : { status: 'incomplete', reason: `observed on ${obs} of ${n} rows`, partialValue: num(r.pke) ?? 0 };
    const channel = String(r.channel_view);
    const sessions = num(r.sessions) ?? 0;
    let sessionsMeasured: Measured<number> | undefined;
    if (filter.pageId && (channel === 'google_organic' || channel === 'all_organic')) {
      const a = pageAbsence(rc, filter.pageId, channel, start, end);
      sessionsMeasured = a.lossDates.length ? { status: 'incomplete', reason: absenceReason(a), partialValue: sessions } : { status: 'observed', value: sessions };
    }
    return {
      channel,
      sessions,
      ...(sessionsMeasured ? { sessionsMeasured } : {}),
      engaged,
      primaryKeyEvents: pke,
      primaryEventName: str(r.ev),
      complete: num(r.complete) === 1,
      collectedAt: str(r.collected),
      synthetic: num(r.syn) === 1,
    };
  });
  return { available: true, start, end, dateTz: tz, channels };
}

/**
 * A page with no GA4 landing row at all in the site's latest window: an
 * observed zero only on collected dates without row loss; unknown where GA4
 * reported "(other)" bucketing, thresholding, or sampling; DATA UNAVAILABLE
 * when nothing was collected.
 */
function pageWithoutRows(rc: RenderContext, pageId: string): Ga4WindowSummary {
  const ga4 = rc.ga4!;
  const siteLatest = str(one(rc, `SELECT MAX(date) AS d FROM ga4_landing_daily_current WHERE site_id = ? AND property_id = ? AND segment_key = ''`, [rc.ctx.siteId, ga4.propertyId])?.d);
  const unavailableSummary: Ga4WindowSummary = { available: false, reason: `no GA4 landing-page rows for property ${ga4.propertyId}`, channels: [] };
  if (!siteLatest) return unavailableSummary;
  const start = addDays(siteLatest, -(rc.windowDays - 1));
  const channels: Ga4ChannelSummary[] = [];
  for (const channel of ['all_organic', 'google_organic'] as const) {
    const a = pageAbsence(rc, pageId, channel, start, siteLatest);
    if (!a.covered) continue;
    let sessionsMeasured: Measured<number>;
    if (a.lossDates.length && a.zeroDates === 0) sessionsMeasured = { status: 'incomplete', reason: absenceReason(a) };
    else if (a.lossDates.length || a.missingDates) {
      const parts = [a.lossDates.length ? absenceReason(a) : '', a.missingDates ? `${a.missingDates} date(s) not collected` : ''].filter(Boolean);
      sessionsMeasured = { status: 'incomplete', reason: parts.join('; '), partialValue: 0 };
    } else sessionsMeasured = { status: 'observed', value: 0 };
    channels.push({
      channel,
      sessions: 0,
      sessionsMeasured,
      // No landing row at all: engaged sessions and key events share the sessions' status (a zero only where sessions are).
      engaged: sessionsMeasured,
      primaryKeyEvents: sessionsMeasured,
      primaryEventName: null,
      complete: true,
      collectedAt: null,
      synthetic: false,
    });
  }
  if (!channels.length) return unavailableSummary;
  const tz = str(one(rc, 'SELECT time_zone FROM ga4_property_metadata WHERE site_id = ? AND property_id = ?', [rc.ctx.siteId, ga4.propertyId])?.time_zone) ?? 'unknown';
  return { available: true, start, end: siteLatest, dateTz: tz, channels };
}

export function renderGa4Window(s: Ga4WindowSummary, label: string): string[] {
  if (!s.available) return [`- ${label}: DATA UNAVAILABLE (${inline(s.reason)})`];
  const lines = [`- ${label} (${inline(s.start)} to ${inline(s.end)}, GA4 property time zone ${inline(s.dateTz)}; session-scoped acquisition):`];
  for (const c of s.channels) {
    const channelLabel = c.channel === 'google_organic' ? 'Google organic (comparable with Search Console)' : c.channel === 'all_organic' ? 'All organic search' : c.channel;
    lines.push(
      `  - ${inline(channelLabel)}: sessions ${c.sessionsMeasured ? formatMeasured(c.sessionsMeasured, (v) => fmtInt(v)) : fmtInt(c.sessions)} · engaged sessions ${formatMeasured(c.engaged, (v) => fmtInt(v))} · primary key events${c.primaryEventName ? ` (${inline(c.primaryEventName)})` : ''} ${formatMeasured(c.primaryKeyEvents, (v) => fmtNum(v, 0))}${c.complete ? '' : ' · includes incomplete days'}${c.synthetic ? ' · SYNTHETIC' : ''}`,
    );
  }
  if (!s.channels.length) lines.push('  - No rows in the window.');
  lines.push('  - Google organic and all-organic figures are separate views of overlapping sessions; never add them together.');
  return lines;
}

/** Entity key for a decision/claim subject, when that subject has a note. */
export function subjectKey(rc: RenderContext, subjectType: string, subjectId: string): string | null {
  switch (subjectType) {
    case 'page':
      return `page:${subjectId}`;
    case 'experiment':
      return `experiment:${subjectId}`;
    case 'learning':
      return `learning:${subjectId}`;
    case 'decision':
      return `decision:${subjectId}`;
    case 'content_item':
    case 'content':
    case 'opportunity_content':
      return `content:${subjectId}`;
    case 'brief': {
      const r = one(rc, 'SELECT content_item_id FROM content_briefs WHERE site_id = ? AND id = ?', [rc.ctx.siteId, subjectId]);
      return r ? `brief:${String(r.content_item_id)}` : null;
    }
    case 'draft': {
      const r = one(rc, 'SELECT content_item_id FROM content_drafts WHERE site_id = ? AND id = ?', [rc.ctx.siteId, subjectId]);
      return r ? `draft:${String(r.content_item_id)}` : null;
    }
    case 'recommendation': {
      const r = one(rc, 'SELECT page_id FROM recommendations WHERE site_id = ? AND id = ?', [rc.ctx.siteId, subjectId]);
      return r?.page_id ? `page:${String(r.page_id)}` : null;
    }
    case 'opportunity': {
      const r = one(rc, 'SELECT page_id FROM opportunities WHERE site_id = ? AND id = ?', [rc.ctx.siteId, subjectId]);
      return r?.page_id ? `page:${String(r.page_id)}` : null;
    }
    case 'source':
      return `source:${subjectId}`;
    case 'keyword':
      return `keyword:${subjectId}`;
    case 'competitor':
      return `competitor:${subjectId}`;
    default:
      return null;
  }
}

/** Link to a subject's note, or a plain description when it has no note. */
export function subjectLink(rc: RenderContext, subjectType: string, subjectId: string): string {
  const key = subjectKey(rc, subjectType, subjectId);
  if (key && rc.plan.has(key)) return rc.plan.link(key);
  return `${inline(subjectType)} ${code(subjectId, 80)}`;
}

export function dateRange(start: unknown, end: unknown): string {
  const s = str(start);
  const e = str(end);
  if (!s && !e) return 'date range not recorded';
  return `${fmtDate(s)} to ${fmtDate(e)}`;
}
