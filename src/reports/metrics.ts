import { rateToFraction } from '../seo/metrics.js';

/**
 * Pure metric arithmetic used by the report builders. Everything numerical in
 * a report is computed here (or by SQL SUM over additive columns), never by a
 * model. These helpers encode the metric semantics from the spec:
 *
 * - CTR = clicks / impressions from summed counts (never averaged percentages).
 * - Positions are aggregated with impression weighting over compatible rows.
 * - Ratios are aggregated from compatible counts (session-weighted rates).
 * - Users are never summed across days or segments.
 * - Missing values are never turned into zero.
 */

export function ctr(clicks: number, impressions: number): number | null {
  if (!Number.isFinite(clicks) || !Number.isFinite(impressions) || impressions <= 0) return null;
  return clicks / impressions;
}

export interface PositionObservation {
  position: number | null;
  impressions: number;
}

/** Impression-weighted mean position; null when no row has both a position and impressions. */
export function weightedPosition(rows: readonly PositionObservation[]): number | null {
  let num = 0;
  let den = 0;
  for (const r of rows) {
    if (r.position === null || !Number.isFinite(r.position) || r.impressions <= 0) continue;
    num += r.position * r.impressions;
    den += r.impressions;
  }
  return den > 0 ? num / den : null;
}

/** Weighted position from pre-aggregated sums (SUM(position*impressions), SUM(impressions with a position)). */
export function weightedPositionFromSums(weightedSum: number | null, weightImpressions: number | null): number | null {
  if (weightedSum === null || weightImpressions === null || weightImpressions <= 0) return null;
  return weightedSum / weightImpressions;
}

export interface RateObservation {
  rate: number | null;
  sessions: number;
  /** Stored key-event rate scale marker (see seo/metrics.rateScaleClass); 'undetermined' is never a fraction. */
  scale?: string | null;
}

/**
 * Session-weighted aggregate of daily session rates. Returns null if any row
 * lacks a rate (a partial aggregate would silently change the denominator) or
 * any rate's scale is 'undetermined' (0-1 vs 0-100 not established).
 */
export function sessionWeightedRate(rows: readonly RateObservation[]): { rate: number; convertingSessions: number; sessions: number } | null {
  if (rows.length === 0) return null;
  let conv = 0;
  let sessions = 0;
  for (const r of rows) {
    if (r.rate === null || !Number.isFinite(r.rate)) return null;
    const f = rateToFraction(r.rate, r.scale);
    if (f === null) return null;
    conv += f * r.sessions;
    sessions += r.sessions;
  }
  if (sessions <= 0) return null;
  return { rate: conv / sessions, convertingSessions: conv, sessions };
}

/** Relative change; null when the previous value is zero/absent (undefined growth). */
export function pctChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || !Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return (current - previous) / previous;
}

export function share(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return part / whole;
}

/** Normalize a query or alias for brand matching (case/diacritics/whitespace-insensitive). */
export function normalizeForBrand(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Branded when any configured alias appears as a whole-word sequence in the
 * query. Returns null when no aliases are configured (classification unknown).
 */
export function isBrandedQuery(query: string, aliases: readonly string[]): boolean | null {
  const normAliases = aliases.map(normalizeForBrand).filter(Boolean);
  if (normAliases.length === 0) return null;
  const norm = normalizeForBrand(query);
  const padded = ` ${norm} `;
  const tokens = new Set(norm.split(' ').filter(Boolean));
  return normAliases.some((a) => {
    if (padded.includes(` ${a} `)) return true; // whole-word (multi-word) match
    const compact = a.replace(/ /g, '');
    return compact !== a && tokens.has(compact); // "Example Co" also matches the token "exampleco"
  });
}

/**
 * Parse a GSC/GA4 segment key such as 'country=est;device=MOBILE' into its
 * dimension map. The "shape" is the sorted list of dimension names.
 */
export function parseSegmentKey(key: string): { dims: Record<string, string>; shape: string } {
  const dims: Record<string, string> = {};
  for (const part of key.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    dims[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return { dims, shape: Object.keys(dims).sort().join(';') };
}

export interface SegmentAggregateInput {
  segmentKey: string;
  clicks: number;
  impressions: number;
  positionWeighted: number | null;
  positionImpressions: number | null;
}

export interface SegmentAggregate {
  value: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}

/**
 * Aggregate segment rows by one dimension using a SINGLE consistent segment
 * shape (the one with the fewest dimensions that contains `dimension`), so
 * rows from different requests (e.g. 'device' and 'country;device') are never
 * double counted.
 */
export function aggregateByDimension(rows: readonly SegmentAggregateInput[], dimension: string): { shape: string | null; values: SegmentAggregate[] } {
  const parsed = rows.map((r) => ({ r, ...parseSegmentKey(r.segmentKey) }));
  const shapes = [...new Set(parsed.filter((p) => dimension in p.dims).map((p) => p.shape))];
  if (shapes.length === 0) return { shape: null, values: [] };
  shapes.sort((a, b) => a.split(';').length - b.split(';').length || a.localeCompare(b));
  const shape = shapes[0]!;
  const acc = new Map<string, { clicks: number; impressions: number; pw: number; pi: number }>();
  for (const p of parsed) {
    if (p.shape !== shape) continue;
    const v = p.dims[dimension] ?? '';
    const a = acc.get(v) ?? { clicks: 0, impressions: 0, pw: 0, pi: 0 };
    a.clicks += p.r.clicks;
    a.impressions += p.r.impressions;
    if (p.r.positionWeighted !== null && p.r.positionImpressions !== null) {
      a.pw += p.r.positionWeighted;
      a.pi += p.r.positionImpressions;
    }
    acc.set(v, a);
  }
  const values = [...acc.entries()]
    .map(([value, a]) => ({ value, clicks: a.clicks, impressions: a.impressions, ctr: ctr(a.clicks, a.impressions), position: weightedPositionFromSums(a.pw, a.pi) }))
    .sort((x, y) => y.clicks - x.clicks || y.impressions - x.impressions || x.value.localeCompare(y.value));
  return { shape, values };
}

// ---------------------------------------------------------------------------
// Formatting (human-readable; JSON keeps raw numbers)
// ---------------------------------------------------------------------------

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a';
  return intFmt.format(Math.round(n));
}

export function fmtPct(r: number | null | undefined, digits = 2): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return 'n/a';
  return `${(r * 100).toFixed(digits)}%`;
}

export function fmtSignedPct(r: number | null | undefined): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return 'n/a';
  const s = (r * 100).toFixed(1);
  return r > 0 ? `+${s}%` : `${s}%`;
}

export function fmtPos(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return 'n/a';
  return p.toFixed(1);
}

export function round(n: number | null, digits = 6): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
