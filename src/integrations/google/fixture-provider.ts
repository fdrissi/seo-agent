import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { systemClock, type Clock } from '../../core/clock.js';
import { AppError } from '../../core/errors.js';
import { addDays, dateInZone, eachDate } from '../../core/time.js';
import { googleErrorFromResponse } from './errors.js';
import { apiNameForUrl, buildUrl } from './http-client.js';
import { GSC_TIME_ZONE, canReadData, normalizePermissionLevel, validateSearchAnalyticsRequest, type GscFilter, type GscQueryRequest } from './gsc-client.js';
import type { Ga4FilterExpression, Ga4Metadata, Ga4RunReportRequest } from './ga4-client.js';
import type { GoogleApiClient, GoogleAuthProvider, GoogleRequest, GoogleResponse } from './types.js';

/**
 * FIXTURE provider: serves SYNTHETIC recorded responses for the offline demo
 * and tests. Data comes from clearly labelled files in tests/fixtures/google
 * (`"_synthetic": true`, example.com/example.test domains). Responses follow
 * the documented response shapes and are generated deterministically from the
 * fixture definitions for any requested date range, so pagination, fresh vs
 * final data, revisions (partial recent days), anonymized queries, "(not set)"
 * rows, thresholding metadata, and missing per-event metrics can be exercised.
 *
 * Every row ingested through this provider is stored with is_synthetic = 1.
 * It never touches the network and never represents live data.
 */

export interface FixtureFailureRule {
  /** Matched against `${METHOD} ${url}`. */
  match: RegExp;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** How many times this rule fires (default: always). */
  times?: number;
}

export interface FixtureProviderOptions {
  gscProperty?: string | null;
  ga4PropertyId?: string | null;
  clock?: Clock;
  /** GA4 metadata fixture relative to the fixtures dir (default ga4/metadata.json). */
  ga4MetadataFile?: string;
  /** GA4 dataset fixture relative to the fixtures dir (default ga4/dataset.json). */
  ga4DatasetFile?: string;
  /** GSC dataset fixture relative to the fixtures dir (default gsc/dataset.json). */
  gscDatasetFile?: string;
  /** Casing of the Search Console metadata key (the wire casing is unverified). */
  gscMetadataCasing?: 'camel' | 'snake' | 'none';
  failures?: FixtureFailureRule[];
  /** Shallow overrides of the GA4 dataset fixture (e.g. restrictedMetrics, dataLossFromOtherRow). */
  ga4DatasetOverrides?: Record<string, unknown>;
  /** Force the reported GA4 remaining token quota (tests of the quota guard). */
  ga4QuotaRemaining?: { tokensPerHour?: number; tokensPerDay?: number };
}

interface GscDataset {
  _synthetic: true;
  defaultHostPrefix?: string;
  freshness: { firstIncompleteLagDays: number; latestLagDays: number; partialFactorByLag: Record<string, number> };
  anonymizedShare: number;
  propertyImpressionDedup: number;
  countries: [string, number][];
  devices: [string, number][];
  pages: { path: string; dailyImpressions: number; ctr: number; position: number; searchAppearance?: string | null; queries: { query: string; share: number; ctr: number; position: number }[] }[];
}

interface Ga4Dataset {
  _synthetic: true;
  timeZone: string;
  currencyCode: string;
  subjectToThresholding: boolean;
  dataLossFromOtherRow: boolean;
  freshness: { partialFactorByLag: Record<string, number> };
  userRepeatFactor: number;
  hosts: [string, number][];
  channels: { source: string; medium: string; group: string; share: number }[];
  keyEvents: string[];
  eventValues: Record<string, number>;
  landingPages: { path: string; dailySessions: number; engagedRate: number; events: Record<string, number> }[];
  restrictedMetrics?: string[];
  incompatibleMetrics?: string[];
  propertyQuota: { tokensPerDay: number; tokensPerHour: number; tokensPerProjectPerHour: number };
  tokensPerRequest: number;
}

function hash01(s: string): number {
  return Number.parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16) / 0x1_0000_0000;
}

function readFixture<T>(dir: string, rel: string): T {
  const file = path.join(dir, rel);
  if (!existsSync(file)) throw new AppError('CONFIG_MISSING', `Google fixture file not found: ${file}`);
  const data = JSON.parse(readFileSync(file, 'utf8')) as { _synthetic?: unknown };
  if (data._synthetic !== true) throw new AppError('CONFIG_INVALID', `Fixture ${file} is not labelled "_synthetic": true; refusing to serve it.`);
  return data as T;
}

function err(status: number, message: string, reason?: string, rpcStatus?: string): { status: number; body: unknown } {
  return { status, body: { error: { code: status, message, ...(reason ? { errors: [{ domain: 'global', reason, message }] } : {}), ...(rpcStatus ? { status: rpcStatus } : {}) } } };
}

class FixtureResponseError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`fixture error ${status}`);
  }
}

// ---------------------------------------------------------------------------
// Search Console simulator

interface GscAtom {
  date: string;
  page: string;
  query: string | null; // null = anonymized
  country: string;
  device: string;
  searchAppearance: string | null;
  impressions: number;
  clicks: number;
  position: number;
}

class GscSimulator {
  private readonly cache = new Map<string, GscAtom[]>();

  constructor(
    private readonly ds: GscDataset,
    private readonly clock: Clock,
    private readonly casing: 'camel' | 'snake' | 'none',
  ) {}

  today(): string {
    return dateInZone(this.clock.now(), GSC_TIME_ZONE);
  }

  firstIncompleteDate(): string {
    return addDays(this.today(), -this.ds.freshness.firstIncompleteLagDays);
  }

  private factor(date: string, key: string): number | null {
    const lag = Math.round((Date.parse(`${this.today()}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
    if (lag < this.ds.freshness.latestLagDays) return null;
    const partial = this.ds.freshness.partialFactorByLag[String(lag)] ?? 1;
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekly = weekday === 0 || weekday === 6 ? 0.78 : 1.06;
    return partial * weekly * (0.8 + 0.4 * hash01(`${date}|${key}`));
  }

  private atoms(date: string, base: string): GscAtom[] {
    const cacheKey = `${date}|${base}|${this.today()}`;
    const hit = this.cache.get(cacheKey);
    if (hit) return hit;
    const out: GscAtom[] = [];
    for (const p of this.ds.pages) {
      const f = this.factor(date, p.path);
      if (f === null) continue;
      const page = `${base}${p.path}`;
      const parts = [...p.queries.map((q) => ({ query: q.query as string | null, share: q.share, ctr: q.ctr, position: q.position })), { query: null, share: this.ds.anonymizedShare, ctr: p.ctr, position: p.position + 3 }];
      for (const q of parts) {
        for (const [country, cs] of this.ds.countries) {
          for (const [device, dvs] of this.ds.devices) {
            const impressions = p.dailyImpressions * q.share * cs * dvs * f;
            const jitter = 0.85 + 0.3 * hash01(`${date}|${p.path}|${q.query}|${country}|${device}`);
            out.push({
              date,
              page,
              query: q.query,
              country,
              device,
              searchAppearance: p.searchAppearance ?? null,
              impressions,
              clicks: impressions * q.ctr * jitter * (device === 'DESKTOP' ? 1.1 : 0.95),
              position: Math.max(1, q.position + (hash01(`${date}|pos|${p.path}|${q.query}`) - 0.5) * 1.2 + (device === 'MOBILE' ? 0.3 : 0)),
            });
          }
        }
      }
    }
    this.cache.set(cacheKey, out);
    return out;
  }

  query(property: string, body: GscQueryRequest): unknown {
    try {
      validateSearchAnalyticsRequest(body);
    } catch (e) {
      throw new FixtureResponseError(400, err(400, e instanceof Error ? e.message : String(e), 'badRequest').body);
    }
    const base = property.startsWith('sc-domain:') ? `https://${this.ds.defaultHostPrefix ?? 'www.'}${property.slice(10)}` : property.replace(/\/+$/, '');
    const dims = body.dimensions ?? [];
    const filters: GscFilter[] = (body.dimensionFilterGroups ?? []).flatMap((g) => g.filters);
    const dataState = (body.dataState ?? 'final').toLowerCase();
    const fid = this.firstIncompleteDate();
    const dates = eachDate(body.startDate, body.endDate).filter((d) => dataState === 'all' || d < fid);
    const groups = new Map<string, { keys: string[]; clicks: number; impressions: number; posWeighted: number }>();
    const pageInvolved = dims.includes('page') || filters.some((f) => f.dimension === 'page');
    const byProperty = !pageInvolved;
    for (const date of dates) {
      for (const a of this.atoms(date, base)) {
        if (a.query === null && (dims.includes('query') || filters.length > 0)) continue; // anonymized queries are omitted from rows and whenever a filter is applied
        if (dims.includes('searchAppearance') && !a.searchAppearance) continue;
        if (!filters.every((f) => matchGscFilter(f, a))) continue;
        const keys = dims.map((d) => {
          switch (d) {
            case 'date':
              return a.date;
            case 'page':
              return a.page;
            case 'query':
              return a.query ?? '';
            case 'country':
              return a.country;
            case 'device':
              return a.device;
            case 'searchAppearance':
              return a.searchAppearance ?? '';
            default:
              return '';
          }
        });
        const k = keys.join('\u0000');
        const g = groups.get(k) ?? { keys, clicks: 0, impressions: 0, posWeighted: 0 };
        g.clicks += a.clicks;
        g.impressions += a.impressions;
        g.posWeighted += a.position * a.impressions;
        groups.set(k, g);
      }
    }
    let rows = [...groups.values()]
      .map((g) => {
        // byProperty counts one impression per search for the property, so it is lower than the sum of pages.
        const impressions = Math.round(byProperty ? g.impressions * this.ds.propertyImpressionDedup : g.impressions);
        const clicks = Math.min(Math.round(g.clicks), impressions);
        return { keys: g.keys, clicks, impressions, ctr: impressions > 0 ? clicks / impressions : 0, position: g.impressions > 0 ? Math.round((g.posWeighted / g.impressions) * 100) / 100 : 0 };
      })
      .filter((r) => r.impressions > 0);
    const dateIdx = dims.indexOf('date');
    rows.sort((a, b) => (dateIdx >= 0 ? a.keys[dateIdx]!.localeCompare(b.keys[dateIdx]!) : 0) || b.clicks - a.clicks || b.impressions - a.impressions || a.keys.join('|').localeCompare(b.keys.join('|')));
    const startRow = body.startRow ?? 0;
    const rowLimit = body.rowLimit ?? 1000;
    rows = rows.slice(startRow, startRow + rowLimit);
    const out: Record<string, unknown> = { responseAggregationType: pageInvolved ? 'byPage' : 'byProperty' };
    if (rows.length) out.rows = rows;
    if (dataState === 'all' && dims.includes('date') && body.endDate >= fid && this.casing !== 'none') {
      out.metadata = this.casing === 'camel' ? { firstIncompleteDate: fid } : { first_incomplete_date: fid };
    }
    return out;
  }
}

function matchGscFilter(f: GscFilter, a: GscAtom): boolean {
  const value = f.dimension === 'page' ? a.page : f.dimension === 'query' ? (a.query ?? '') : f.dimension === 'country' ? a.country : f.dimension === 'device' ? a.device : (a.searchAppearance ?? '');
  const op = f.operator ?? 'equals';
  const caseSensitive = f.dimension === 'page' || f.dimension === 'query';
  const v = caseSensitive ? value : value.toLowerCase();
  const e = caseSensitive ? f.expression : f.expression.toLowerCase();
  switch (op) {
    case 'equals':
      return v === e;
    case 'notEquals':
      return v !== e;
    case 'contains':
      return value.toLowerCase().includes(f.expression.toLowerCase());
    case 'notContains':
      return !value.toLowerCase().includes(f.expression.toLowerCase());
    case 'includingRegex':
      return new RegExp(f.expression).test(value);
    case 'excludingRegex':
      return !new RegExp(f.expression).test(value);
  }
}

// ---------------------------------------------------------------------------
// GA4 simulator

interface Ga4Atom {
  dims: Record<string, string>;
  sessions: number;
  engaged: number;
  users: number;
  events: Record<string, number>;
  convSessions: Record<string, number>;
  revenue: number;
}

class Ga4Simulator {
  private consumed = 0;
  private readonly metricsByName: Map<string, { type: string | null; blocked: boolean }>;
  private readonly dimNames: Set<string>;

  constructor(
    private readonly ds: Ga4Dataset,
    private readonly metadata: Ga4Metadata,
    private readonly clock: Clock,
    private readonly quotaOverride?: { tokensPerHour?: number; tokensPerDay?: number },
  ) {
    this.metricsByName = new Map((metadata.metrics ?? []).map((m) => [m.apiName, { type: m.type ?? null, blocked: (m.blockedReasons ?? []).includes('NO_REVENUE_METRICS') }]));
    this.dimNames = new Set((metadata.dimensions ?? []).map((d) => d.apiName));
  }

  today(): string {
    return dateInZone(this.clock.now(), this.ds.timeZone);
  }

  getMetadata(propertyId: string): unknown {
    return { ...this.metadata, name: `properties/${propertyId}/metadata` };
  }

  checkCompatibility(body: { dimensions?: { name: string }[]; metrics?: { name: string }[] }): unknown {
    for (const d of body.dimensions ?? []) if (!this.dimNames.has(d.name)) throw new FixtureResponseError(400, err(400, `Field ${d.name} is not a valid dimension.`, undefined, 'INVALID_ARGUMENT').body);
    const incompatible = new Set(this.ds.incompatibleMetrics ?? []);
    return {
      dimensionCompatibilities: [...this.dimNames].map((apiName) => ({ dimensionMetadata: { apiName }, compatibility: 'COMPATIBLE' })),
      metricCompatibilities: [...this.metricsByName.keys()].map((apiName) => ({ metricMetadata: { apiName }, compatibility: incompatible.has(apiName) ? 'INCOMPATIBLE' : 'COMPATIBLE' })),
    };
  }

  private resolveDate(v: string): string {
    const today = this.today();
    if (v === 'today') return today;
    if (v === 'yesterday') return addDays(today, -1);
    const m = /^(\d+)daysAgo$/.exec(v);
    if (m) return addDays(today, -Number(m[1]));
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    throw new FixtureResponseError(400, err(400, `Invalid date ${v}`, undefined, 'INVALID_ARGUMENT').body);
  }

  private atoms(date: string): Ga4Atom[] {
    const lag = Math.round((Date.parse(`${this.today()}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
    if (lag < 0) return [];
    const partial = this.ds.freshness.partialFactorByLag[String(lag)] ?? 1;
    const out: Ga4Atom[] = [];
    for (const lp of this.ds.landingPages) {
      const f = partial * (0.8 + 0.4 * hash01(`${date}|${lp.path}`)) * ([0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()) ? 0.8 : 1.05);
      for (const ch of this.ds.channels) {
        for (const [host, hs] of this.ds.hosts) {
          const sessions = lp.dailySessions * ch.share * hs * f;
          const events: Record<string, number> = {};
          const convSessions: Record<string, number> = {};
          for (const [e, rate] of Object.entries(lp.events)) {
            const j = 0.7 + 0.6 * hash01(`${date}|${lp.path}|${ch.source}|${e}`);
            events[e] = sessions * rate * j;
            convSessions[e] = Math.min(sessions, events[e]! * 0.9);
          }
          out.push({
            dims: {
              date: date.replace(/-/g, ''),
              landingPagePlusQueryString: lp.path,
              landingPage: lp.path.replace(/\?.*$/, ''),
              hostName: host,
              sessionSource: ch.source,
              sessionMedium: ch.medium,
              sessionSourceMedium: `${ch.source} / ${ch.medium}`,
              sessionDefaultChannelGroup: ch.group,
            },
            sessions,
            engaged: sessions * lp.engagedRate,
            users: sessions * 0.88,
            events,
            convSessions,
            revenue: Object.entries(this.ds.eventValues).reduce((s, [e, v]) => s + (events[e] ?? 0) * v, 0),
          });
        }
      }
    }
    return out;
  }

  runReport(body: Ga4RunReportRequest): unknown {
    const dims = (body.dimensions ?? []).map((d) => d.name);
    const metrics = body.metrics.map((m) => m.name);
    for (const d of dims) if (!this.dimNames.has(d)) throw new FixtureResponseError(400, err(400, `Field ${d} is not a valid dimension.`, undefined, 'INVALID_ARGUMENT').body);
    for (const m of metrics) if (!this.metricsByName.has(m)) throw new FixtureResponseError(400, err(400, `Field ${m} is not a valid metric.`, undefined, 'INVALID_ARGUMENT').body);
    const range = body.dateRanges[0];
    if (!range) throw new FixtureResponseError(400, err(400, 'dateRanges is required', undefined, 'INVALID_ARGUMENT').body);
    const start = this.resolveDate(range.startDate);
    const end = this.resolveDate(range.endDate);
    const usesEvent = dims.includes('eventName') || filterUses(body.dimensionFilter, 'eventName');
    type Group = { dims: Record<string, string>; dates: Set<string>; sessions: number; engaged: number; users: number; eventCount: number; keyEvents: number; perEvent: Record<string, number>; conv: Record<string, number>; convAny: number; revenue: number };
    const groups = new Map<string, Group>();
    const keySet = new Set(this.ds.keyEvents);
    for (const date of start <= end ? eachDate(start, end) : []) {
      for (const a of this.atoms(date)) {
        const variants: Array<{ dims: Record<string, string>; event: string | null }> = usesEvent ? Object.keys(a.events).map((e) => ({ dims: { ...a.dims, eventName: e }, event: e })) : [{ dims: a.dims, event: null }];
        for (const v of variants) {
          if (body.dimensionFilter && !evalGa4Filter(body.dimensionFilter, v.dims)) continue;
          const key = dims.map((d) => v.dims[d] ?? '(not set)').join('\u0000');
          const g = groups.get(key) ?? { dims: Object.fromEntries(dims.map((d) => [d, v.dims[d] ?? '(not set)'])), dates: new Set<string>(), sessions: 0, engaged: 0, users: 0, eventCount: 0, keyEvents: 0, perEvent: {}, conv: {}, convAny: 0, revenue: 0 };
          g.dates.add(date);
          if (v.event) {
            const n = a.events[v.event] ?? 0;
            g.sessions += a.convSessions[v.event] ?? 0;
            g.users += (a.convSessions[v.event] ?? 0) * 0.95;
            g.eventCount += n;
            if (keySet.has(v.event)) g.keyEvents += n;
            g.perEvent[v.event] = (g.perEvent[v.event] ?? 0) + n;
          } else {
            g.sessions += a.sessions;
            g.engaged += a.engaged;
            g.users += a.users;
            let convAny = 0;
            for (const [e, n] of Object.entries(a.events)) {
              g.eventCount += n;
              g.perEvent[e] = (g.perEvent[e] ?? 0) + n;
              if (keySet.has(e)) {
                g.keyEvents += n;
                g.conv[e] = (g.conv[e] ?? 0) + (a.convSessions[e] ?? 0);
                convAny = Math.max(convAny, a.convSessions[e] ?? 0);
              }
            }
            g.convAny += convAny;
            g.revenue += a.revenue;
          }
          groups.set(key, g);
        }
      }
    }
    const restricted = new Set(this.ds.restrictedMetrics ?? []);
    const valueOf = (g: Group, m: string): number => {
      const meta = this.metricsByName.get(m);
      if (meta?.blocked || restricted.has(m)) return 0; // blocked metrics report zeros (documented)
      const sessions = Math.round(g.sessions);
      switch (m) {
        case 'sessions':
          return sessions;
        case 'engagedSessions':
          return Math.round(g.engaged);
        case 'eventCount':
          return Math.round(g.eventCount);
        case 'keyEvents':
          return Math.round(g.keyEvents);
        case 'totalUsers':
        case 'activeUsers':
          // Distinct users are NOT additive: returning users overlap across days.
          return Math.round(g.users * (1 - this.ds.userRepeatFactor * (1 - 1 / Math.max(1, g.dates.size))));
        case 'sessionKeyEventRate':
          return sessions > 0 ? Math.round((Math.min(g.convAny, g.sessions) / g.sessions) * 1e6) / 1e6 : 0;
        case 'totalRevenue':
        case 'purchaseRevenue':
          return Math.round(g.revenue * 100) / 100;
        default: {
          const userRate = /^userKeyEventRate:(.+)$/.exec(m);
          if (userRate) {
            const distinct = g.users * (1 - this.ds.userRepeatFactor * (1 - 1 / Math.max(1, g.dates.size)));
            return distinct > 0 ? Math.round(Math.min(1, ((g.conv[userRate[1]!] ?? 0) * 0.9) / distinct) * 1e6) / 1e6 : 0;
          }
          const rate = /^sessionKeyEventRate:(.+)$/.exec(m);
          if (rate) return sessions > 0 ? Math.round((Math.min(g.conv[rate[1]!] ?? 0, g.sessions) / g.sessions) * 1e6) / 1e6 : 0;
          const ke = /^keyEvents:(.+)$/.exec(m);
          if (ke) return keySet.has(ke[1]!) ? Math.round(g.perEvent[ke[1]!] ?? 0) : 0;
          return 0;
        }
      }
    };
    let rows = [...groups.values()]
      .map((g) => ({ g, values: metrics.map((m) => valueOf(g, m)) }))
      .filter((r) => body.keepEmptyRows || r.values.some((v) => v !== 0));
    rows.sort((a, b) => (a.g.dims.date ?? '').localeCompare(b.g.dims.date ?? '') || (b.values[0] ?? 0) - (a.values[0] ?? 0) || dims.map((d) => a.g.dims[d]).join('|').localeCompare(dims.map((d) => b.g.dims[d]).join('|')));
    const rowCount = rows.length;
    const offset = Number(body.offset ?? 0);
    const limit = Math.min(Number(body.limit ?? 10_000), 250_000);
    rows = rows.slice(offset, offset + limit);
    this.consumed += this.ds.tokensPerRequest;
    const q = this.ds.propertyQuota;
    const remainingHour = this.quotaOverride?.tokensPerHour ?? Math.max(0, q.tokensPerHour - this.consumed);
    const remainingDay = this.quotaOverride?.tokensPerDay ?? Math.max(0, q.tokensPerDay - this.consumed);
    const restrictedRequested = metrics.filter((m) => restricted.has(m));
    return {
      dimensionHeaders: dims.map((name) => ({ name })),
      metricHeaders: metrics.map((name) => ({ name, type: this.metricsByName.get(name)?.type ?? 'TYPE_FLOAT' })),
      ...(rows.length ? { rows: rows.map((r) => ({ dimensionValues: dims.map((d) => ({ value: r.g.dims[d] ?? '' })), metricValues: r.values.map((v) => ({ value: String(v) })) })) } : {}),
      rowCount,
      metadata: {
        currencyCode: this.ds.currencyCode,
        timeZone: this.ds.timeZone,
        ...(this.ds.subjectToThresholding ? { subjectToThresholding: true } : {}),
        ...(this.ds.dataLossFromOtherRow ? { dataLossFromOtherRow: true } : {}),
        ...(restrictedRequested.length ? { schemaRestrictionResponse: { activeMetricRestrictions: restrictedRequested.map((metricName) => ({ metricName, restrictedMetricTypes: ['REVENUE_DATA'] })) } } : {}),
      },
      ...(body.returnPropertyQuota
        ? {
            propertyQuota: {
              tokensPerDay: { consumed: this.ds.tokensPerRequest, remaining: remainingDay },
              tokensPerHour: { consumed: this.ds.tokensPerRequest, remaining: remainingHour },
              concurrentRequests: { consumed: 0, remaining: 10 },
              serverErrorsPerProjectPerHour: { consumed: 0, remaining: 10 },
              potentiallyThresholdedRequestsPerHour: { consumed: 0, remaining: 120 },
              tokensPerProjectPerHour: { consumed: this.ds.tokensPerRequest, remaining: Math.max(0, q.tokensPerProjectPerHour - this.consumed) },
            },
          }
        : {}),
      kind: 'analyticsData#runReport',
    };
  }
}

function filterUses(expr: Ga4FilterExpression | undefined, field: string): boolean {
  if (!expr) return false;
  if (expr.filter) return expr.filter.fieldName === field;
  if (expr.andGroup) return expr.andGroup.expressions.some((e) => filterUses(e, field));
  if (expr.orGroup) return expr.orGroup.expressions.some((e) => filterUses(e, field));
  if (expr.notExpression) return filterUses(expr.notExpression, field);
  return false;
}

export function evalGa4Filter(expr: Ga4FilterExpression, dims: Record<string, string>): boolean {
  if (expr.andGroup) return expr.andGroup.expressions.every((e) => evalGa4Filter(e, dims));
  if (expr.orGroup) return expr.orGroup.expressions.some((e) => evalGa4Filter(e, dims));
  if (expr.notExpression) return !evalGa4Filter(expr.notExpression, dims);
  const f = expr.filter;
  if (!f) return true;
  const raw = dims[f.fieldName] ?? '(not set)';
  if (f.emptyFilter) return raw === '' || raw === '(not set)';
  if (f.inListFilter) {
    const cs = f.inListFilter.caseSensitive ?? false;
    return f.inListFilter.values.some((v) => (cs ? v === raw : v.toLowerCase() === raw.toLowerCase()));
  }
  if (f.stringFilter) {
    const cs = f.stringFilter.caseSensitive ?? false;
    const v = cs ? raw : raw.toLowerCase();
    const e = cs ? f.stringFilter.value : f.stringFilter.value.toLowerCase();
    switch (f.stringFilter.matchType) {
      case 'EXACT':
        return v === e;
      case 'BEGINS_WITH':
        return v.startsWith(e);
      case 'ENDS_WITH':
        return v.endsWith(e);
      case 'CONTAINS':
        return v.includes(e);
      case 'FULL_REGEXP':
        return new RegExp(`^(?:${f.stringFilter.value})$`, cs ? '' : 'i').test(raw);
      case 'PARTIAL_REGEXP':
        return new RegExp(f.stringFilter.value, cs ? '' : 'i').test(raw);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Client and provider

export class FixtureGoogleApiClient implements GoogleApiClient {
  readonly calls: Array<{ method: string; url: string; body: unknown }> = [];
  private readonly failures: Array<FixtureFailureRule & { used: number }>;
  private readonly sites: { siteUrl: string; permissionLevel: string }[];
  private readonly inspections: { byPath: Record<string, Record<string, unknown>>; default: Record<string, unknown> };

  constructor(
    private readonly gsc: GscSimulator,
    private readonly ga4: Ga4Simulator,
    sites: { siteUrl: string; permissionLevel: string }[],
    inspections: { byPath: Record<string, Record<string, unknown>>; default: Record<string, unknown> },
    private readonly ga4PropertyId: string | null,
    private readonly clock: Clock,
    failures: FixtureFailureRule[],
  ) {
    this.sites = sites;
    this.inspections = inspections;
    this.failures = failures.map((f) => ({ ...f, used: 0 }));
  }

  async request<T>(req: GoogleRequest): Promise<GoogleResponse<T>> {
    const url = buildUrl(req);
    const method = req.method ?? (req.data === undefined ? 'GET' : 'POST');
    this.calls.push({ method, url, body: req.data ?? null });
    const api = apiNameForUrl(url);
    for (const f of this.failures) {
      if (f.match.test(`${method} ${url}`) && (f.times === undefined || f.used < f.times)) {
        f.used++;
        throw googleErrorFromResponse(api, f.status, f.body, f.headers ?? {});
      }
    }
    try {
      const data = this.route(method, new URL(url), req.data);
      return { status: 200, data: JSON.parse(JSON.stringify(data)) as T, headers: { 'content-type': 'application/json', 'x-seo-agent-fixture': 'synthetic' } };
    } catch (e) {
      if (e instanceof FixtureResponseError) throw googleErrorFromResponse(api, e.status, e.body);
      throw e;
    }
  }

  private route(method: string, u: URL, body: unknown): unknown {
    const p = u.pathname;
    if (method === 'GET' && p === '/webmasters/v3/sites') return { siteEntry: this.sites };
    const sa = /^\/webmasters\/v3\/sites\/([^/]+)\/searchAnalytics\/query$/.exec(p);
    if (method === 'POST' && sa) {
      const property = decodeURIComponent(sa[1]!);
      this.assertGscAccess(property);
      return this.gsc.query(property, body as GscQueryRequest);
    }
    if (method === 'POST' && p === '/v1/urlInspection/index:inspect') {
      const b = body as { inspectionUrl: string; siteUrl: string };
      this.assertGscAccess(b.siteUrl);
      const target = new URL(b.inspectionUrl);
      const found = this.inspections.byPath[`${target.pathname}${target.search}`] ?? this.inspections.default;
      const { lastCrawlDaysAgo, ...rest } = found as { lastCrawlDaysAgo?: number } & Record<string, unknown>;
      const indexStatusResult: Record<string, unknown> = { ...rest, ...(typeof lastCrawlDaysAgo === 'number' ? { lastCrawlTime: new Date(this.clock.now().getTime() - lastCrawlDaysAgo * 86_400_000).toISOString() } : {}) };
      if (indexStatusResult.verdict === 'PASS' && !('googleCanonical' in indexStatusResult)) indexStatusResult.googleCanonical = b.inspectionUrl;
      return { inspectionResult: { inspectionResultLink: 'https://search.google.com/search-console/inspect?synthetic=1', indexStatusResult } };
    }
    const ga = /^\/v1beta\/properties\/(\d+)(\/metadata|:runReport|:checkCompatibility)$/.exec(p);
    if (ga) {
      if (this.ga4PropertyId && ga[1] !== this.ga4PropertyId && ga[1] !== '0') {
        throw new FixtureResponseError(403, err(403, 'User does not have sufficient permissions for this property.', undefined, 'PERMISSION_DENIED').body);
      }
      if (ga[2] === '/metadata' && method === 'GET') return this.ga4.getMetadata(ga[1]!);
      if (ga[2] === ':runReport' && method === 'POST') return this.ga4.runReport(body as Ga4RunReportRequest);
      if (ga[2] === ':checkCompatibility' && method === 'POST') return this.ga4.checkCompatibility(body as { dimensions?: { name: string }[] });
    }
    throw new FixtureResponseError(404, err(404, `No synthetic fixture for ${method} ${p}`, 'notFound').body);
  }

  private assertGscAccess(property: string): void {
    const s = this.sites.find((x) => x.siteUrl === property);
    if (!s || !canReadData(normalizePermissionLevel(s.permissionLevel))) {
      throw new FixtureResponseError(403, err(403, `User does not have sufficient permission for site '${property}'.`, 'forbidden').body);
    }
  }
}

export class FixtureGoogleAuthProvider implements GoogleAuthProvider {
  readonly mode = 'fixture' as const;
  constructor(readonly client: FixtureGoogleApiClient, readonly fixturesDir: string) {}
  async getClient(): Promise<GoogleApiClient> {
    return this.client;
  }
}

export function createFixtureGoogleAuthProvider(fixturesDir: string, opts: FixtureProviderOptions = {}): FixtureGoogleAuthProvider {
  const clock = opts.clock ?? systemClock;
  const sitesFile = readFixture<{ siteEntry: { siteUrl: string; permissionLevel: string }[] }>(fixturesDir, 'gsc/sites.json');
  const sites = [...sitesFile.siteEntry];
  if (opts.gscProperty && !sites.some((s) => s.siteUrl === opts.gscProperty)) sites.push({ siteUrl: opts.gscProperty, permissionLevel: 'siteFullUser' });
  const gscDs = readFixture<GscDataset>(fixturesDir, opts.gscDatasetFile ?? 'gsc/dataset.json');
  const inspections = readFixture<{ byPath: Record<string, Record<string, unknown>>; default: Record<string, unknown> }>(fixturesDir, 'gsc/inspections.json');
  const ga4Ds = { ...readFixture<Ga4Dataset>(fixturesDir, opts.ga4DatasetFile ?? 'ga4/dataset.json'), ...(opts.ga4DatasetOverrides ?? {}) } as Ga4Dataset;
  const ga4Meta = readFixture<Ga4Metadata & { _synthetic: true }>(fixturesDir, opts.ga4MetadataFile ?? 'ga4/metadata.json');
  const gsc = new GscSimulator(gscDs, clock, opts.gscMetadataCasing ?? 'camel');
  const ga4 = new Ga4Simulator(ga4Ds, ga4Meta, clock, opts.ga4QuotaRemaining);
  const client = new FixtureGoogleApiClient(gsc, ga4, sites, inspections, opts.ga4PropertyId ?? null, clock, opts.failures ?? []);
  return new FixtureGoogleAuthProvider(client, fixturesDir);
}
