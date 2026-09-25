import type { AppContext } from '../../app/context.js';
import { ENV_ALLOWED_VALUES } from '../../config/env.js';
import type { SecretStore } from '../../config/secrets.js';
import { ValidationError } from '../../core/errors.js';
import { sleep } from '../../core/concurrency.js';
import type { RetryPolicy } from '../../core/retry.js';
import { callGoogle } from './request.js';
import type { GoogleApiClient } from './types.js';

/**
 * Search Console API (read-only). Contract: docs/integration-contracts.md
 * section 2. Only sites.list, searchAnalytics.query and urlInspection.index.inspect
 * are used. No sitemap submission, indexing requests, property changes, or
 * removals exist in this module.
 */

/** Search Console reports daily data in Pacific time (America/Los_Angeles per Google docs). */
export const GSC_TIME_ZONE = 'America/Los_Angeles';

/** Documented hosts that serve the webmasters/v3 paths (the GSC_BASE_URL allowlist in src/config/env.ts). */
export const GSC_HOSTS = ENV_ALLOWED_VALUES.GSC_BASE_URL as readonly ['https://searchconsole.googleapis.com', 'https://www.googleapis.com'];
export const GSC_DEFAULT_BASE = 'https://searchconsole.googleapis.com';
export const URL_INSPECTION_ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

/**
 * Client-side pacing that keeps sequential calls under the documented
 * per-site/per-user limits (Search Analytics 1,200 QPM; URL Inspection 600 QPM).
 * The separate Search Analytics load quota cannot be predicted; it is handled
 * by backoff and an early stop.
 */
export const GSC_SEARCH_ANALYTICS_MIN_INTERVAL_MS = 55;
export const URL_INSPECTION_MIN_INTERVAL_MS = 110;

export class Pacer {
  private last = 0;
  constructor(readonly minIntervalMs: number) {}
  async wait(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const delta = this.last + this.minIntervalMs - Date.now();
    if (delta > 0) await sleep(delta);
    this.last = Date.now();
  }
}

/** Documented row limits (GSC1, GSC2, GSC19). */
export const GSC_MAX_ROW_LIMIT = 25_000;
export const GSC_DAILY_ROW_CEILING = 50_000;

export type GscDimension = 'query' | 'page' | 'country' | 'device' | 'searchAppearance' | 'date' | 'hour';
export type GscSearchType = 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews';
export type GscOperator = 'equals' | 'notEquals' | 'contains' | 'notContains' | 'includingRegex' | 'excludingRegex';
export type GscAggregation = 'auto' | 'byPage' | 'byProperty' | 'byNewsShowcasePanel';

export interface GscFilter {
  dimension: 'query' | 'page' | 'country' | 'device' | 'searchAppearance';
  operator?: GscOperator;
  expression: string;
}

export interface GscQueryRequest {
  startDate: string;
  endDate: string;
  dimensions?: GscDimension[];
  type?: GscSearchType;
  dimensionFilterGroups?: { groupType?: 'and'; filters: GscFilter[] }[];
  aggregationType?: GscAggregation;
  rowLimit?: number;
  startRow?: number;
  dataState?: 'final' | 'all' | 'hourly_all';
}

export interface GscRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscQueryResponse {
  rows?: GscRow[];
  responseAggregationType?: string;
  metadata?: { first_incomplete_date?: string; first_incomplete_hour?: string; firstIncompleteDate?: string; firstIncompleteHour?: string };
}

export interface GscSiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

export type GscPermission = 'siteOwner' | 'siteFullUser' | 'siteRestrictedUser' | 'siteUnverifiedUser' | 'unknown';

/** Normalize `siteOwner` / `SITE_OWNER` style values (docs disagree on casing). */
export function normalizePermissionLevel(p: string | undefined | null): GscPermission {
  const k = String(p ?? '').replace(/_/g, '').toLowerCase();
  switch (k) {
    case 'siteowner':
      return 'siteOwner';
    case 'sitefulluser':
      return 'siteFullUser';
    case 'siterestricteduser':
      return 'siteRestrictedUser';
    case 'siteunverifieduser':
      return 'siteUnverifiedUser';
    default:
      return 'unknown';
  }
}

/** A permission level that can read Search Analytics data. */
export function canReadData(p: GscPermission): boolean {
  return p === 'siteOwner' || p === 'siteFullUser' || p === 'siteRestrictedUser';
}

export interface PropertyFormatCheck {
  ok: boolean;
  kind: 'domain' | 'url_prefix' | 'invalid';
  problems: string[];
  notes: string[];
}

/** Validate the exact property string format. Never used to construct a property. */
export function validateGscPropertyFormat(property: string): PropertyFormatCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  if (property.startsWith('sc-domain:')) {
    const host = property.slice('sc-domain:'.length);
    if (!/^[a-z0-9.-]+$/i.test(host) || host.includes('..') || host.startsWith('.') || host.endsWith('.')) problems.push('Domain property must look like "sc-domain:example.com" (no scheme, path, or trailing slash).');
    if (/^www\./i.test(host)) notes.push('Domain properties are usually registered without "www." (e.g. "sc-domain:example.com"); use the exact string listed by `auth status`.');
    return { ok: problems.length === 0, kind: 'domain', problems, notes };
  }
  if (/^https?:\/\//i.test(property)) {
    try {
      const u = new URL(property);
      if (!property.endsWith('/')) problems.push('URL-prefix properties must end with "/" (e.g. "https://www.example.com/").');
      if (u.search || u.hash) problems.push('URL-prefix properties must not contain a query string or fragment.');
    } catch {
      problems.push('URL-prefix property is not a valid URL.');
    }
    return { ok: problems.length === 0, kind: 'url_prefix', problems, notes };
  }
  problems.push('Use "sc-domain:example.com" for a Domain property or a URL prefix such as "https://www.example.com/".');
  return { ok: false, kind: 'invalid', problems, notes };
}

/** Whether a fully qualified URL belongs to a property (URL Inspection requires it). */
export function urlBelongsToProperty(url: string, property: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (property.startsWith('sc-domain:')) {
    const domain = property.slice('sc-domain:'.length).toLowerCase();
    const host = u.hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  }
  return url.startsWith(property);
}

/**
 * Suggest accessible properties that plausibly correspond to a configured one
 * (same registrable host, different scheme/www/type). Suggestions only: the
 * owner picks the exact string; nothing is constructed or auto-selected.
 */
export function similarProperties(configured: string, accessible: string[]): string[] {
  const hostOf = (p: string): string | null => {
    if (p.startsWith('sc-domain:')) return p.slice(10).toLowerCase();
    try {
      return new URL(p).hostname.toLowerCase();
    } catch {
      return null;
    }
  };
  const bare = (h: string | null) => (h ?? '').replace(/^www\./, '');
  const target = bare(hostOf(configured));
  if (!target) return [];
  return accessible.filter((p) => p !== configured && (bare(hostOf(p)) === target || bare(hostOf(p)).endsWith(`.${target}`) || target.endsWith(`.${bare(hostOf(p))}`)));
}

const COUNTRY_RE = /^[a-z]{3}$/i;
const DEVICES = new Set(['DESKTOP', 'MOBILE', 'TABLET']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Client-side validation of documented request rules (GSC1, GSC2). */
export function validateSearchAnalyticsRequest(req: GscQueryRequest): void {
  const errors: string[] = [];
  if (!DATE_RE.test(req.startDate) || !DATE_RE.test(req.endDate)) errors.push('startDate and endDate must be YYYY-MM-DD');
  else if (req.endDate < req.startDate) errors.push('endDate must be >= startDate');
  const dims = req.dimensions ?? [];
  if (new Set(dims).size !== dims.length) errors.push('dimensions must not repeat');
  if (dims.includes('hour') && req.dataState !== 'hourly_all') errors.push('the hour dimension requires dataState "hourly_all"');
  if (dims.includes('searchAppearance') && dims.length > 1) errors.push('searchAppearance must be queried alone; then filter on one value and add other dimensions');
  if (req.rowLimit !== undefined && (!Number.isInteger(req.rowLimit) || req.rowLimit < 1 || req.rowLimit > GSC_MAX_ROW_LIMIT)) errors.push(`rowLimit must be 1..${GSC_MAX_ROW_LIMIT}`);
  if (req.startRow !== undefined && (!Number.isInteger(req.startRow) || req.startRow < 0)) errors.push('startRow must be a non-negative integer');
  const filters = (req.dimensionFilterGroups ?? []).flatMap((g) => {
    if (g.groupType && g.groupType !== 'and') errors.push('groupType supports only "and"');
    return g.filters;
  });
  for (const f of filters) {
    if (f.expression.length > 4096) errors.push('filter expression exceeds 4096 characters');
    if (f.dimension === 'country' && (f.operator ?? 'equals') === 'equals' && !COUNTRY_RE.test(f.expression)) errors.push('country filters use ISO 3166-1 alpha-3 codes');
    if (f.dimension === 'device' && (f.operator ?? 'equals') === 'equals' && !DEVICES.has(f.expression.toUpperCase())) errors.push('device must be DESKTOP, MOBILE, or TABLET');
  }
  const pageInvolved = dims.includes('page') || filters.some((f) => f.dimension === 'page');
  if (req.aggregationType === 'byProperty') {
    if (pageInvolved) errors.push('aggregationType byProperty is not allowed when grouping or filtering by page');
    if (req.type === 'discover' || req.type === 'googleNews') errors.push('aggregationType byProperty is not supported for discover or googleNews');
  }
  if (req.aggregationType === 'byNewsShowcasePanel') {
    const ok = filters.some((f) => f.dimension === 'searchAppearance' && f.expression === 'NEWS_SHOWCASE') && (req.type === 'discover' || req.type === 'googleNews') && !pageInvolved;
    if (!ok) errors.push('byNewsShowcasePanel requires a NEWS_SHOWCASE searchAppearance filter, type discover/googleNews, and no page group or filter');
  }
  if (errors.length) throw new ValidationError(`Invalid Search Analytics request: ${errors.join('; ')}`, { errors });
}

/** byProperty is invalid for discover/googleNews (GSC1); fall back to auto there. */
export function propertyAggregationFor(type: GscSearchType): GscAggregation {
  return type === 'discover' || type === 'googleNews' ? 'auto' : 'byProperty';
}

/** Read first_incomplete_date in either documented casing (unverified on the wire). */
export function firstIncompleteDateOf(resp: GscQueryResponse): string | null {
  const m = resp.metadata;
  return m?.first_incomplete_date ?? m?.firstIncompleteDate ?? null;
}

export function normalizeAggregation(value: string | undefined, requested: GscAggregation | undefined): string {
  const v = (value ?? '').replace(/_/g, '').toLowerCase();
  if (v === 'byproperty') return 'byProperty';
  if (v === 'bypage') return 'byPage';
  if (v === 'bynewsshowcasepanel') return 'byNewsShowcasePanel';
  if (v === 'auto') return 'auto';
  return requested ?? 'auto';
}

export interface GscCallContext {
  ctx: AppContext;
  client: GoogleApiClient;
  synthetic: boolean;
  baseUrl?: string;
  retry?: RetryPolicy;
  /** Paces Search Analytics / URL Inspection calls (quota awareness). */
  pacer?: Pacer;
}

/**
 * Only documented Search Console hosts are accepted for the base URL.
 * Precedence: an explicit value (tests, callers), then GSC_BASE_URL through
 * the layered secret/env store (process env > workspace secrets.env), then
 * the default host. The process environment is never read directly.
 */
export function resolveGscBaseUrl(explicit?: string | null, secrets?: Pick<SecretStore, 'get'> | null): string {
  const candidate = (explicit ?? secrets?.get('GSC_BASE_URL') ?? GSC_DEFAULT_BASE).replace(/\/+$/, '');
  if (!(GSC_HOSTS as readonly string[]).includes(candidate)) {
    throw new ValidationError(`GSC base URL must be one of ${GSC_HOSTS.join(', ')} (got ${candidate})`);
  }
  return candidate;
}

export async function listSites(c: GscCallContext): Promise<{ sites: GscSiteEntry[]; rawRef: string | null }> {
  const base = resolveGscBaseUrl(c.baseUrl, c.ctx.secrets);
  const res = await callGoogle<{ siteEntry?: GscSiteEntry[] }>(c.ctx, c.client, {
    provider: 'google_gsc',
    endpoint: 'sites.list',
    request: { url: `${base}/webmasters/v3/sites`, method: 'GET' },
    synthetic: c.synthetic,
    rawKind: 'gsc-sites-list',
    ...(c.retry ? { retry: c.retry } : {}),
  });
  return { sites: Array.isArray(res.data?.siteEntry) ? res.data.siteEntry : [], rawRef: res.rawRef };
}

export async function querySearchAnalytics(c: GscCallContext, property: string, body: GscQueryRequest): Promise<{ response: GscQueryResponse; rawRef: string | null }> {
  validateSearchAnalyticsRequest(body);
  const base = resolveGscBaseUrl(c.baseUrl, c.ctx.secrets);
  await c.pacer?.wait();
  const res = await callGoogle<GscQueryResponse>(c.ctx, c.client, {
    provider: 'google_gsc',
    endpoint: 'searchanalytics.query',
    request: { url: `${base}/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`, method: 'POST', data: body },
    synthetic: c.synthetic,
    rawKind: 'gsc-searchanalytics',
    rawContext: { property },
    ...(c.retry ? { retry: c.retry } : {}),
  });
  return { response: res.data ?? {}, rawRef: res.rawRef };
}

export interface PaginatedGscResult {
  rows: GscRow[];
  pages: number;
  rawRefs: string[];
  responseAggregationType: string | undefined;
  firstIncompleteDate: string | null;
  metadataSeen: boolean;
  /**
   * Stopped because maxPages was reached while the last page was full
   * (rowLimit rows), so more rows may exist. A last page with fewer rows than
   * rowLimit proves the end and is not truncation.
   */
  stoppedAtMaxPages: boolean;
}

/**
 * Documented pagination (GSC2): re-run the same query raising startRow by
 * rowLimit until a response has 0 rows. `maxPages` guards against runaway
 * loops; hitting it is reported as truncation only when the last page was
 * full: a page with fewer than rowLimit rows already proves the end.
 */
export async function queryAllPages(c: GscCallContext, property: string, body: Omit<GscQueryRequest, 'startRow'>, opts: { rowLimit?: number; maxPages?: number } = {}): Promise<PaginatedGscResult> {
  const rowLimit = opts.rowLimit ?? GSC_MAX_ROW_LIMIT;
  const maxPages = opts.maxPages ?? 40;
  const out: PaginatedGscResult = { rows: [], pages: 0, rawRefs: [], responseAggregationType: undefined, firstIncompleteDate: null, metadataSeen: false, stoppedAtMaxPages: false };
  let startRow = 0;
  let lastPageRows = 0;
  while (true) {
    if (out.pages >= maxPages) {
      // A short last page proved the end; only a full last page leaves rows possibly unread.
      out.stoppedAtMaxPages = lastPageRows >= rowLimit;
      break;
    }
    const { response, rawRef } = await querySearchAnalytics(c, property, { ...body, rowLimit, startRow });
    out.pages++;
    if (rawRef) out.rawRefs.push(rawRef);
    if (response.metadata) out.metadataSeen = true;
    const fid = firstIncompleteDateOf(response);
    if (fid && (!out.firstIncompleteDate || fid < out.firstIncompleteDate)) out.firstIncompleteDate = fid;
    out.responseAggregationType ??= response.responseAggregationType;
    const rows = Array.isArray(response.rows) ? response.rows : [];
    lastPageRows = rows.length;
    if (rows.length === 0) break;
    out.rows.push(...rows);
    startRow += rowLimit;
  }
  return out;
}

export interface InspectRequest {
  inspectionUrl: string;
  siteUrl: string;
  languageCode?: string;
}

export interface IndexStatusResult {
  sitemap?: string[];
  referringUrls?: string[];
  verdict?: string;
  coverageState?: string;
  robotsTxtState?: string;
  indexingState?: string;
  lastCrawlTime?: string;
  pageFetchState?: string;
  googleCanonical?: string;
  userCanonical?: string;
  crawledAs?: string;
}

export interface InspectResponse {
  inspectionResult?: {
    inspectionResultLink?: string;
    indexStatusResult?: IndexStatusResult;
    ampResult?: unknown;
    mobileUsabilityResult?: unknown;
    richResultsResult?: unknown;
  };
}

export async function inspectUrl(c: GscCallContext, body: InspectRequest): Promise<{ response: InspectResponse; rawRef: string | null }> {
  await c.pacer?.wait();
  const res = await callGoogle<InspectResponse>(c.ctx, c.client, {
    provider: 'google_gsc',
    endpoint: 'urlInspection.index.inspect',
    request: { url: URL_INSPECTION_ENDPOINT, method: 'POST', data: body },
    synthetic: c.synthetic,
    rawKind: 'gsc-url-inspection',
    ...(c.retry ? { retry: c.retry } : {}),
  });
  return { response: res.data ?? {}, rawRef: res.rawRef };
}
