import type { AppContext } from '../../app/context.js';
import { ValidationError } from '../../core/errors.js';
import type { RetryPolicy } from '../../core/retry.js';
import { callGoogle } from './request.js';
import type { GoogleApiClient } from './types.js';

/**
 * GA4 Data API v1beta (read-only): runReport, getMetadata, checkCompatibility.
 * Contract: docs/integration-contracts.md section 3.
 */

export const GA4_BASE_URL = 'https://analyticsdata.googleapis.com/v1beta';
/** Documented maximum rows per runReport request. */
export const GA4_MAX_LIMIT = 250_000;

export interface Ga4StringFilter {
  matchType: 'EXACT' | 'BEGINS_WITH' | 'ENDS_WITH' | 'CONTAINS' | 'FULL_REGEXP' | 'PARTIAL_REGEXP';
  value: string;
  caseSensitive?: boolean;
}

export interface Ga4FilterExpression {
  andGroup?: { expressions: Ga4FilterExpression[] };
  orGroup?: { expressions: Ga4FilterExpression[] };
  notExpression?: Ga4FilterExpression;
  filter?: {
    fieldName: string;
    stringFilter?: Ga4StringFilter;
    inListFilter?: { values: string[]; caseSensitive?: boolean };
    emptyFilter?: Record<string, never>;
  };
}

export interface Ga4RunReportRequest {
  dateRanges: { startDate: string; endDate: string; name?: string }[];
  dimensions?: { name: string }[];
  metrics: { name: string }[];
  dimensionFilter?: Ga4FilterExpression;
  metricFilter?: Ga4FilterExpression;
  offset?: string;
  limit?: string;
  keepEmptyRows?: boolean;
  returnPropertyQuota?: boolean;
  currencyCode?: string;
}

export interface Ga4QuotaStatus {
  consumed?: number;
  remaining?: number;
}

export type Ga4PropertyQuota = Partial<Record<'tokensPerDay' | 'tokensPerHour' | 'concurrentRequests' | 'serverErrorsPerProjectPerHour' | 'potentiallyThresholdedRequestsPerHour' | 'tokensPerProjectPerHour', Ga4QuotaStatus>>;

export interface Ga4ResponseMetadata {
  dataLossFromOtherRow?: boolean;
  samplingMetadatas?: { samplesReadCount?: string; samplingSpaceSize?: string }[];
  dataTruncationReasons?: { dataTruncationDateRanges?: { startDate: string; endDate: string }[]; dataTruncationType?: string; dataTruncationMessage?: string; dataTruncationDate?: string }[];
  schemaRestrictionResponse?: { activeMetricRestrictions?: { metricName: string; restrictedMetricTypes?: string[] }[] };
  currencyCode?: string;
  timeZone?: string;
  emptyReason?: string;
  subjectToThresholding?: boolean;
}

export interface Ga4Row {
  dimensionValues?: { value?: string }[];
  metricValues?: { value?: string }[];
}

export interface Ga4RunReportResponse {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string; type?: string }[];
  rows?: Ga4Row[];
  rowCount?: number;
  metadata?: Ga4ResponseMetadata;
  propertyQuota?: Ga4PropertyQuota;
  kind?: string;
}

export interface Ga4MetricMetadata {
  apiName: string;
  uiName?: string;
  type?: string;
  blockedReasons?: string[];
  deprecatedApiNames?: string[];
  customDefinition?: boolean;
  category?: string;
}

export interface Ga4Metadata {
  name?: string;
  dimensions?: { apiName: string; uiName?: string; deprecatedApiNames?: string[]; customDefinition?: boolean; category?: string }[];
  metrics?: Ga4MetricMetadata[];
}

export interface Ga4CompatibilityResponse {
  dimensionCompatibilities?: { dimensionMetadata?: { apiName?: string }; compatibility?: string }[];
  metricCompatibilities?: { metricMetadata?: { apiName?: string }; compatibility?: string }[];
}

/** Validate a numeric GA4 property ID (rejects UA- and G- measurement IDs). */
export function ga4PropertyName(id: string): string {
  if (!/^\d+$/.test(id)) {
    throw new ValidationError(
      /^UA-/i.test(id)
        ? `"${id}" is a Universal Analytics ID; the GA4 Data API needs the numeric GA4 property ID.`
        : /^G-/i.test(id)
          ? `"${id}" is a measurement ID; use the numeric GA4 property ID (GA4 Admin > Property details).`
          : `GA4 property ID must be numeric (got "${id}").`,
    );
  }
  return `properties/${id}`;
}

export function ga4DateToIso(v: string): string | null {
  return /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null;
}

export interface ParsedGa4Row {
  dims: Record<string, string>;
  metrics: Record<string, number | null>;
}

/** Map columns by header index; metric strings converted by MetricHeader.type. */
export function parseReportRows(resp: Ga4RunReportResponse): ParsedGa4Row[] {
  const dh = resp.dimensionHeaders ?? [];
  const mh = resp.metricHeaders ?? [];
  return (resp.rows ?? []).map((row) => {
    const dims: Record<string, string> = {};
    dh.forEach((h, i) => (dims[h.name] = row.dimensionValues?.[i]?.value ?? ''));
    const metrics: Record<string, number | null> = {};
    mh.forEach((h, i) => {
      const raw = row.metricValues?.[i]?.value;
      if (raw === undefined || raw === null || raw === '') {
        metrics[h.name] = null;
        return;
      }
      const n = h.type === 'TYPE_INTEGER' ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
      metrics[h.name] = Number.isFinite(n) ? n : null;
    });
    return { dims, metrics };
  });
}

export interface Ga4CallContext {
  ctx: AppContext;
  client: GoogleApiClient;
  synthetic: boolean;
  retry?: RetryPolicy;
}

export async function getMetadata(c: Ga4CallContext, propertyId: string): Promise<{ metadata: Ga4Metadata; rawRef: string | null }> {
  const name = ga4PropertyName(propertyId);
  const res = await callGoogle<Ga4Metadata>(c.ctx, c.client, {
    provider: 'google_ga4',
    endpoint: 'properties.getMetadata',
    request: { url: `${GA4_BASE_URL}/${name}/metadata`, method: 'GET' },
    synthetic: c.synthetic,
    rawKind: 'ga4-metadata',
    ...(c.retry ? { retry: c.retry } : {}),
  });
  return { metadata: res.data ?? {}, rawRef: res.rawRef };
}

export async function checkCompatibility(c: Ga4CallContext, propertyId: string, body: { dimensions?: { name: string }[]; metrics?: { name: string }[]; dimensionFilter?: Ga4FilterExpression }): Promise<{ response: Ga4CompatibilityResponse; rawRef: string | null }> {
  const name = ga4PropertyName(propertyId);
  const res = await callGoogle<Ga4CompatibilityResponse>(c.ctx, c.client, {
    provider: 'google_ga4',
    endpoint: 'properties.checkCompatibility',
    request: { url: `${GA4_BASE_URL}/${name}:checkCompatibility`, method: 'POST', data: body },
    synthetic: c.synthetic,
    rawKind: 'ga4-check-compatibility',
    ...(c.retry ? { retry: c.retry } : {}),
  });
  return { response: res.data ?? {}, rawRef: res.rawRef };
}

export async function runReport(c: Ga4CallContext, propertyId: string, body: Ga4RunReportRequest, rawKind = 'ga4-run-report'): Promise<{ response: Ga4RunReportResponse; rawRef: string | null }> {
  const name = ga4PropertyName(propertyId);
  if (!body.metrics.length) throw new ValidationError('GA4 runReport needs at least one metric');
  if ((body.dimensions?.length ?? 0) > 9) throw new ValidationError('GA4 runReport allows at most nine dimensions');
  const res = await callGoogle<Ga4RunReportResponse>(c.ctx, c.client, {
    provider: 'google_ga4',
    endpoint: 'properties.runReport',
    request: { url: `${GA4_BASE_URL}/${name}:runReport`, method: 'POST', data: body },
    synthetic: c.synthetic,
    rawKind,
    ...(c.retry ? { retry: c.retry } : {}),
  });
  return { response: res.data ?? {}, rawRef: res.rawRef };
}

export interface PagedReport {
  rows: ParsedGa4Row[];
  pages: number;
  rawRefs: string[];
  /** Total rows GA4 reported (the latest reported value); null when no response reported one. Never defaulted to 0. */
  rowCount: number | null;
  metadata: Ga4ResponseMetadata[];
  lastQuota: Ga4PropertyQuota | null;
  stoppedForQuota: boolean;
  stoppedAtMaxPages: boolean;
  metricTypes: Record<string, string>;
  /** Rows were returned without a rowCount: completeness was judged by a short or empty page instead. */
  rowCountMissing?: boolean;
  /** Data-quality notes about paging (e.g. a missing rowCount). */
  warnings?: string[];
}

export interface QuotaReserve {
  tokensPerHour: number;
  tokensPerDay: number;
}

export const DEFAULT_QUOTA_RESERVE: QuotaReserve = { tokensPerHour: 500, tokensPerDay: 2_000 };

export function quotaLow(q: Ga4PropertyQuota | null | undefined, reserve: QuotaReserve): string | null {
  if (!q) return null;
  const hour = q.tokensPerHour?.remaining;
  const day = q.tokensPerDay?.remaining;
  const proj = q.tokensPerProjectPerHour?.remaining;
  if (typeof day === 'number' && day < reserve.tokensPerDay) return `tokensPerDay remaining ${day} < reserve ${reserve.tokensPerDay}`;
  if (typeof hour === 'number' && hour < reserve.tokensPerHour) return `tokensPerHour remaining ${hour} < reserve ${reserve.tokensPerHour}`;
  if (typeof proj === 'number' && proj < reserve.tokensPerHour) return `tokensPerProjectPerHour remaining ${proj} < reserve ${reserve.tokensPerHour}`;
  return null;
}

/**
 * Offset/limit pagination (no page token): raise offset by the rows received
 * and stop when offset >= rowCount or a page is empty. All other request
 * parameters stay identical across pages. Stops early when the returned
 * property quota falls below the reserve. A missing rowCount is never read as
 * 0: when rows arrive without one, paging continues until a short
 * (rows < limit) or empty page proves the end, and hitting maxPages first is
 * reported as stoppedAtMaxPages (incomplete).
 */
export async function runReportAll(c: Ga4CallContext, propertyId: string, body: Omit<Ga4RunReportRequest, 'offset' | 'limit'>, opts: { limit?: number; maxPages?: number; reserve?: QuotaReserve; rawKind?: string } = {}): Promise<PagedReport> {
  const limit = Math.min(opts.limit ?? 100_000, GA4_MAX_LIMIT);
  const maxPages = opts.maxPages ?? 50;
  const out: PagedReport = { rows: [], pages: 0, rawRefs: [], rowCount: null, metadata: [], lastQuota: null, stoppedForQuota: false, stoppedAtMaxPages: false, metricTypes: {}, rowCountMissing: false, warnings: [] };
  let offset = 0;
  while (true) {
    if (out.pages >= maxPages) {
      out.stoppedAtMaxPages = true;
      if (out.rowCountMissing) out.warnings!.push(`GA4 returned rows without a rowCount and paging stopped at the page guard (${maxPages} pages) before a short page proved the end; the report may be incomplete.`);
      break;
    }
    const { response, rawRef } = await runReport(c, propertyId, { ...body, returnPropertyQuota: true, offset: String(offset), limit: String(limit) }, opts.rawKind);
    out.pages++;
    if (rawRef) out.rawRefs.push(rawRef);
    if (response.metadata) out.metadata.push(response.metadata);
    if (response.propertyQuota) out.lastQuota = response.propertyQuota;
    for (const h of response.metricHeaders ?? []) if (h.type) out.metricTypes[h.name] = h.type;
    const reported = typeof response.rowCount === 'number' && Number.isFinite(response.rowCount) ? response.rowCount : null;
    // Keep the latest reported total; a page without one never turns it into 0.
    if (reported !== null) out.rowCount = reported;
    const rows = parseReportRows(response);
    if (reported === null && out.rowCount === null && rows.length > 0 && !out.rowCountMissing) {
      out.rowCountMissing = true;
      out.warnings!.push('GA4 returned rows without a rowCount; paging continued until a short or empty page instead of trusting a total.');
    }
    out.rows.push(...rows);
    offset += rows.length;
    if (rows.length === 0) break;
    if (out.rowCount !== null ? offset >= out.rowCount : rows.length < limit) break;
    if (opts.reserve && quotaLow(out.lastQuota, opts.reserve)) {
      out.stoppedForQuota = true;
      break;
    }
  }
  return out;
}

/** Merge per-page response metadata into one summary retained with the batch. */
export function summarizeMetadata(list: Ga4ResponseMetadata[]): Record<string, unknown> {
  const first = list[0] ?? {};
  const sampling = list.flatMap((m) => m.samplingMetadatas ?? []);
  return {
    timeZone: first.timeZone ?? null,
    currencyCode: first.currencyCode ?? null,
    subjectToThresholding: list.some((m) => m.subjectToThresholding === true),
    dataLossFromOtherRow: list.some((m) => m.dataLossFromOtherRow === true),
    samplingMetadatas: sampling.length ? sampling : null,
    samplingRatio: sampling.length
      ? sampling.map((s) => {
          const read = Number(s.samplesReadCount);
          const space = Number(s.samplingSpaceSize);
          return Number.isFinite(read) && Number.isFinite(space) && space > 0 ? read / space : null;
        })
      : null,
    dataTruncationReasons: list.flatMap((m) => m.dataTruncationReasons ?? []),
    schemaRestrictions: list.flatMap((m) => m.schemaRestrictionResponse?.activeMetricRestrictions ?? []),
    emptyReason: list.map((m) => m.emptyReason).find((r) => !!r) ?? null,
  };
}
