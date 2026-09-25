import type { FetchLike } from '../types.js';
import { parseGoogleError } from './psi.js';

/**
 * Chrome UX Report API adapter (primary field-data source).
 * Contract: docs/integration-contracts.md section 5 (verified 2026-09-24).
 *
 * - POST https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=KEY
 *   body: exactly one of {url} | {origin}, optional formFactor PHONE|DESKTOP|TABLET,
 *   optional metrics[]. A key is REQUIRED ("All API requests must provide a
 *   value for the key parameter").
 * - 404 NOT_FOUND ("chrome ux report data not found") means insufficient data,
 *   not a failure. Fallback: {url, formFactor} -> {origin, formFactor} ->
 *   {origin}. The level that answered is recorded (page / origin / unavailable).
 * - record.metrics is a map; CLS p75 and bin bounds are strings (Number()).
 *   A bin without `end` runs to +infinity. Data is a rolling 28-day window.
 * - Ratings use the documented thresholds; the Core Web Vitals assessment
 *   passes when LCP, INP and CLS p75 are all good; with INP missing it uses LCP
 *   and CLS; with LCP or CLS missing it is not assessable.
 * - Rate limit: 150 queries/min per Google Cloud project (free).
 */

export const CRUX_ENDPOINT = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';
export const CRUX_TOOL_VERSION = 'crux-api-v1';
export type CruxFormFactor = 'PHONE' | 'DESKTOP' | 'TABLET';

export const CRUX_METRICS = [
  'largest_contentful_paint',
  'interaction_to_next_paint',
  'cumulative_layout_shift',
  'first_contentful_paint',
  'experimental_time_to_first_byte',
] as const;

/** [good upper bound, needs-improvement upper bound] per metric (inclusive). */
export const CWV_THRESHOLDS: Record<string, readonly [number, number]> = {
  largest_contentful_paint: [2500, 4000],
  interaction_to_next_paint: [200, 500],
  cumulative_layout_shift: [0.1, 0.25],
  first_contentful_paint: [1800, 3000],
  experimental_time_to_first_byte: [800, 1800],
};

export type Rating = 'good' | 'needs_improvement' | 'poor';

export function rate(metric: string, p75: number | null): Rating | null {
  const t = CWV_THRESHOLDS[metric];
  if (!t || p75 === null) return null;
  if (p75 <= t[0]) return 'good';
  if (p75 <= t[1]) return 'needs_improvement';
  return 'poor';
}

export interface CruxMetric {
  p75: number | null;
  rating: Rating | null;
  histogram: Array<{ start: number; end: number | null; density: number }>;
  fractions?: Record<string, number>;
}

export interface CruxRecord {
  level: 'page' | 'origin';
  key: { url?: string; origin?: string; formFactor?: string };
  metrics: Record<string, CruxMetric>;
  collectionPeriod: { firstDate: string | null; lastDate: string | null };
  normalizedUrl: string | null;
  cwvAssessment: 'pass' | 'fail' | 'not_assessable';
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function date(d: unknown): string | null {
  if (!d || typeof d !== 'object') return null;
  const o = d as { year?: number; month?: number; day?: number };
  if (!o.year || !o.month || !o.day) return null;
  return `${String(o.year).padStart(4, '0')}-${String(o.month).padStart(2, '0')}-${String(o.day).padStart(2, '0')}`;
}

export function assessCwv(metrics: Record<string, CruxMetric>): 'pass' | 'fail' | 'not_assessable' {
  const lcp = metrics.largest_contentful_paint?.rating ?? null;
  const cls = metrics.cumulative_layout_shift?.rating ?? null;
  const inp = metrics.interaction_to_next_paint?.rating ?? null;
  if (!lcp || !cls) return 'not_assessable';
  const ratings = inp ? [lcp, cls, inp] : [lcp, cls];
  return ratings.every((r) => r === 'good') ? 'pass' : 'fail';
}

/** Parse a queryRecord response body. Pure. */
export function parseCruxResponse(body: unknown, level: 'page' | 'origin'): CruxRecord {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const record = (b.record && typeof b.record === 'object' ? b.record : {}) as Record<string, unknown>;
  const key = (record.key && typeof record.key === 'object' ? record.key : {}) as CruxRecord['key'];
  const metricsRaw = (record.metrics && typeof record.metrics === 'object' && !Array.isArray(record.metrics) ? record.metrics : {}) as Record<string, unknown>;
  const metrics: Record<string, CruxMetric> = {};
  for (const [name, raw] of Object.entries(metricsRaw)) {
    const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const p75 = num((m.percentiles as Record<string, unknown> | undefined)?.p75);
    const hist = Array.isArray(m.histogram) ? m.histogram : [];
    const metric: CruxMetric = {
      p75,
      rating: rate(name, p75),
      histogram: hist.map((h) => {
        const o = (h && typeof h === 'object' ? h : {}) as Record<string, unknown>;
        return { start: num(o.start) ?? 0, end: num(o.end), density: num(o.density) ?? 0 };
      }),
    };
    if (m.fractions && typeof m.fractions === 'object') metric.fractions = m.fractions as Record<string, number>;
    metrics[name] = metric;
  }
  const cp = (record.collectionPeriod && typeof record.collectionPeriod === 'object' ? record.collectionPeriod : {}) as Record<string, unknown>;
  const norm = (b.urlNormalizationDetails && typeof b.urlNormalizationDetails === 'object' ? b.urlNormalizationDetails : null) as { normalizedUrl?: string } | null;
  return {
    level,
    key,
    metrics,
    collectionPeriod: { firstDate: date(cp.firstDate), lastDate: date(cp.lastDate) },
    normalizedUrl: norm?.normalizedUrl ?? null,
    cwvAssessment: assessCwv(metrics),
  };
}

export type CruxQueryOutcome =
  | { status: 'ok'; httpStatus: number; record: CruxRecord; body: unknown }
  | { status: 'not_found'; httpStatus: 404; body: unknown }
  | { status: 'error'; httpStatus: number | null; message: string; reason: string | null; body: unknown };

export interface CruxQuery {
  url?: string;
  origin?: string;
  formFactor?: CruxFormFactor;
  metrics?: readonly string[];
}

export async function queryCruxRecord(fetch: FetchLike, apiKey: string, q: CruxQuery, opts: { endpoint?: string; timeoutMs?: number } = {}): Promise<CruxQueryOutcome> {
  const body: Record<string, unknown> = q.url ? { url: q.url } : { origin: q.origin };
  if (q.formFactor) body.formFactor = q.formFactor;
  body.metrics = [...(q.metrics ?? CRUX_METRICS)];
  const endpoint = `${opts.endpoint ?? CRUX_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (err) {
    return { status: 'error', httpStatus: null, message: (err as Error).message ?? String(err), reason: null, body: null };
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (res.status === 404) return { status: 'not_found', httpStatus: 404, body: parsed };
  if (!res.ok) {
    const e = parseGoogleError(parsed, res.status);
    return { status: 'error', httpStatus: res.status, message: e.message, reason: e.reason ?? e.status, body: parsed };
  }
  return { status: 'ok', httpStatus: res.status, record: parseCruxResponse(parsed, q.url ? 'page' : 'origin'), body: parsed };
}

export interface CruxFieldResult {
  scope: 'page' | 'origin' | 'unavailable';
  formFactor: CruxFormFactor | null;
  record: CruxRecord | null;
  attempts: Array<{ level: 'page' | 'origin'; formFactor: CruxFormFactor | null; status: string; httpStatus: number | null }>;
  error: { httpStatus: number | null; message: string; reason: string | null } | null;
  lastBody: unknown;
  reason: string | null;
}

export function publicOrigin(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

export interface CruxAttemptInfo {
  level: 'page' | 'origin';
  formFactor: CruxFormFactor | null;
  query: { url?: string; origin?: string; formFactor?: CruxFormFactor };
}

/**
 * Documented fallback chain; 404 is "insufficient data", any other error stops the chain.
 * `onAttempt` is called before EACH HTTP request (up to three) and returns a
 * callback for its outcome, so every outbound request can be logged separately.
 */
export async function queryCruxWithFallback(
  fetch: FetchLike,
  apiKey: string,
  url: string,
  formFactor: CruxFormFactor,
  opts: { endpoint?: string; timeoutMs?: number; onAttempt?: (a: CruxAttemptInfo) => (outcome: CruxQueryOutcome) => void } = {},
): Promise<CruxFieldResult> {
  const origin = publicOrigin(url);
  const steps: Array<{ q: CruxQuery; level: 'page' | 'origin'; ff: CruxFormFactor | null }> = [
    { q: { url, formFactor }, level: 'page', ff: formFactor },
    { q: { origin, formFactor }, level: 'origin', ff: formFactor },
    { q: { origin }, level: 'origin', ff: null },
  ];
  const out: CruxFieldResult = { scope: 'unavailable', formFactor: null, record: null, attempts: [], error: null, lastBody: null, reason: null };
  const { onAttempt, ...queryOpts } = opts;
  for (const s of steps) {
    const done = onAttempt?.({ level: s.level, formFactor: s.ff, query: { ...(s.q.url ? { url: s.q.url } : { origin: s.q.origin! }), ...(s.q.formFactor ? { formFactor: s.q.formFactor } : {}) } });
    const r = await queryCruxRecord(fetch, apiKey, s.q, queryOpts);
    done?.(r);
    out.attempts.push({ level: s.level, formFactor: s.ff, status: r.status, httpStatus: r.httpStatus });
    out.lastBody = r.body;
    if (r.status === 'ok') {
      out.scope = s.level;
      out.formFactor = s.ff;
      out.record = r.record;
      return out;
    }
    if (r.status === 'error') {
      out.error = { httpStatus: r.httpStatus, message: r.message, reason: r.reason };
      out.reason = `CrUX API error: ${r.message}`;
      return out;
    }
  }
  out.reason = 'CrUX has insufficient real-user data for this URL and its origin (404 at every level). Field data unavailable.';
  return out;
}
