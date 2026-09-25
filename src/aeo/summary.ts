import { budgetTimeZone, type AppContext } from '../app/context.js';
import { AppError } from '../core/errors.js';
import { incomplete, observed, unavailable, type Measured } from '../core/measured.js';
import { addDays, dateInZone, isIsoDate, isValidTimeZone } from '../core/time.js';
import { ownCitedUrls, ownHostnames } from './matching.js';

/**
 * Reading stored AI-citation observations (spec 17) without conflating what
 * they measure:
 *
 * - A brand mention is not a citation: mentions and own-site citations are
 *   counted separately, and "mentioned but not cited" is its own number.
 * - A citation is not a click, and a click is not a conversion: no stored
 *   source measures clicks or conversions from AI answers, so both are
 *   always DATA_UNAVAILABLE here, never 0.
 * - An ungrounded model response is never a live search measurement: rows
 *   with is_grounded = 0 are counted only as "excluded" and contribute to no
 *   visibility number.
 * - Unknown stays unknown: a row without response text has an unknown brand
 *   mention, a row without recorded cited URLs has an unknown citation; such
 *   counts are reported as incomplete, never folded into "no".
 * - Disabled is not zero: with features.aiCitations off the summary says
 *   "disabled" and reports no numbers.
 */

export const AI_CITATION_SEMANTICS: readonly string[] = [
  'A brand mention is not a citation: the brand appearing in an answer does not mean the answer cited the site.',
  'A citation is not a click: no stored source measures clicks from AI answers.',
  'A click is not a conversion: conversions come from GA4 and are never attributed to AI answers here.',
  'An ungrounded model response is never a live search measurement: ungrounded rows are excluded from every visibility number.',
];

export interface AiCitationPeriod {
  /** First calendar date (YYYY-MM-DD), inclusive. */
  start: string;
  /** Last calendar date (YYYY-MM-DD), inclusive. */
  end: string;
  /** IANA zone the dates are in (default: the site's business time zone). */
  timeZone?: string;
}

export interface AiCitationCheckView {
  id: string;
  engine: string;
  query: string;
  prompt: string | null;
  location: string | null;
  method: string;
  isGrounded: boolean;
  /** What the row is: a grounded answer observation, or a model response that is not a search measurement. */
  kind: 'grounded_answer_observation' | 'ungrounded_model_response';
  checkedAt: string;
  /** Calendar date of the observation (stated date for day-precision rows, else the date of checked_at in the period zone). */
  date: string;
  checkedAtPrecision: 'instant' | 'day' | null;
  sourceLabel: string | null;
  responseRef: string | null;
  /** null = not recorded (unknown); [] = the answer cited nothing. */
  citedUrls: string[] | null;
  ownCitedUrls: string[] | null;
  /** null = unknown (no response text recorded). */
  brandMentioned: boolean | null;
  /** null = unknown (cited URLs not recorded). */
  ownSiteCited: boolean | null;
  isSynthetic: boolean;
}

export interface AiCitationEngineBreakdown {
  engine: string;
  grounded: number;
  ungroundedExcluded: number;
  brandMentioned: number;
  brandMentionUnknown: number;
  ownSiteCited: number;
  ownSiteCitationUnknown: number;
}

export interface AiCitationSummary {
  status: 'disabled' | 'no_data' | 'observed';
  enabled: boolean;
  period: { start: string; end: string; timeZone: string };
  containsSynthetic: boolean;
  checks: { total: number; grounded: number; ungroundedExcluded: number };
  /** Grounded observations whose response text mentions the brand (never from ungrounded rows). */
  brandMentions: Measured<{ mentioned: number; notMentioned: number; unknown: number }>;
  /** Grounded observations whose cited URLs include an own-site URL. */
  ownSiteCitations: Measured<{ cited: number; notCited: number; unknown: number }>;
  /**
   * Grounded observations with BOTH response text and recorded cited URLs:
   * the only rows mentionedNotCited / citedNotMentioned are counted over.
   */
  mentionCitationKnown: number;
  /** Grounded observations that mention the brand but do not cite the site (only rows with response text and recorded cited URLs). */
  mentionedNotCited: Measured<number>;
  /** Grounded observations that cite the site without mentioning the brand. */
  citedNotMentioned: Measured<number>;
  /** Always unavailable: a citation is not a click. */
  clicks: Measured<number>;
  /** Always unavailable: a click is not a conversion. */
  conversions: Measured<number>;
  byEngine: AiCitationEngineBreakdown[];
  /** Own-site URLs cited by grounded answers, with the number of observations citing each. */
  ownCitedUrls: Array<{ url: string; observations: number }>;
  sourceLabels: string[];
  semantics: readonly string[];
  notes: string[];
}

interface Row {
  id: string;
  engine: string;
  query: string;
  prompt: string | null;
  location: string | null;
  method: string;
  is_grounded: number;
  response_ref: string | null;
  cited_urls_json: string | null;
  brand_mentioned: number | null;
  own_site_cited: number | null;
  is_synthetic: number;
  checked_at: string;
  source_label: string | null;
  checked_date: string | null;
  checked_at_precision: 'instant' | 'day' | null;
}

function flag(v: number | null): boolean | null {
  return v === null || v === undefined ? null : v === 1;
}

function parseCited(json: string | null): string[] | null {
  if (json === null) return null;
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

/** Resolve a period: explicit dates, a 'YYYY-MM' month, or 'YYYY-MM-DD..YYYY-MM-DD'. */
export function resolveAiCitationPeriod(ctx: Pick<AppContext, 'config'>, period: AiCitationPeriod | string): Required<AiCitationPeriod> {
  const timeZone = (typeof period === 'object' ? period.timeZone : undefined) ?? budgetTimeZone(ctx.config);
  if (!isValidTimeZone(timeZone)) throw new AppError('VALIDATION_FAILED', `Period time zone must be an IANA name (got "${timeZone}")`);
  let start: string;
  let end: string;
  if (typeof period === 'string') {
    const month = /^(\d{4})-(\d{2})$/.exec(period);
    const range = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(period);
    if (month) {
      start = `${period}-01`;
      if (!isIsoDate(start)) throw new AppError('VALIDATION_FAILED', `Invalid month "${period}"`);
      const nextMonth = Number(month[2]) === 12 ? `${Number(month[1]) + 1}-01-01` : `${month[1]}-${String(Number(month[2]) + 1).padStart(2, '0')}-01`;
      end = addDays(nextMonth, -1);
    } else if (range) {
      start = range[1]!;
      end = range[2]!;
    } else throw new AppError('VALIDATION_FAILED', `Period must be YYYY-MM or YYYY-MM-DD..YYYY-MM-DD (got "${period}")`);
  } else {
    start = period.start;
    end = period.end;
  }
  if (!isIsoDate(start) || !isIsoDate(end)) throw new AppError('VALIDATION_FAILED', `Period dates must be YYYY-MM-DD (got ${start}..${end})`);
  if (start > end) throw new AppError('VALIDATION_FAILED', `Period start ${start} is after its end ${end}`);
  return { start, end, timeZone };
}

/** Rows in the period (by observation date), newest first. SQL is scoped by site_id and uses loose UTC bounds; the exact date filter runs in code. */
function rowsInPeriod(ctx: AppContext, p: Required<AiCitationPeriod>, filter: { engine?: string | null } = {}): Array<Row & { date: string }> {
  const from = `${addDays(p.start, -2)}T00:00:00.000Z`;
  const to = `${addDays(p.end, 3)}T00:00:00.000Z`;
  const params: Array<string | number> = [ctx.siteId, from, to];
  let engineSql = '';
  if (filter.engine) {
    engineSql = ' AND engine = ?';
    params.push(filter.engine.replace(/\s+/g, ' ').trim().toLowerCase());
  }
  const rows = ctx.db.all<Row>(
    `SELECT id, engine, query, prompt, location, method, is_grounded, response_ref, cited_urls_json, brand_mentioned, own_site_cited, is_synthetic, checked_at,
            source_label, checked_date, checked_at_precision
       FROM ai_citation_checks
      WHERE site_id = ? AND checked_at >= ? AND checked_at < ?${engineSql}
      ORDER BY checked_at DESC, id`,
    params,
  );
  const out: Array<Row & { date: string }> = [];
  for (const r of rows) {
    const date = r.checked_at_precision === 'day' && r.checked_date ? r.checked_date : dateInZone(new Date(r.checked_at), p.timeZone);
    if (date >= p.start && date <= p.end) out.push({ ...r, date });
  }
  return out;
}

function toView(r: Row & { date: string }, hosts: string[]): AiCitationCheckView {
  const cited = parseCited(r.cited_urls_json);
  return {
    id: r.id,
    engine: r.engine,
    query: r.query,
    prompt: r.prompt,
    location: r.location,
    method: r.method,
    isGrounded: r.is_grounded === 1,
    kind: r.is_grounded === 1 ? 'grounded_answer_observation' : 'ungrounded_model_response',
    checkedAt: r.checked_at,
    date: r.date,
    checkedAtPrecision: r.checked_at_precision,
    sourceLabel: r.source_label,
    responseRef: r.response_ref,
    citedUrls: cited,
    ownCitedUrls: ownCitedUrls(cited, hosts),
    brandMentioned: flag(r.brand_mentioned),
    ownSiteCited: flag(r.own_site_cited),
    isSynthetic: r.is_synthetic === 1,
  };
}

export interface ListAiCitationOptions {
  engine?: string | null;
  groundedOnly?: boolean;
  limit?: number;
}

/** Stored observations in a period, newest first (grounded and ungrounded, each labeled by kind). */
export function listAiCitationChecks(ctx: AppContext, period: AiCitationPeriod | string, opts: ListAiCitationOptions = {}): { period: Required<AiCitationPeriod>; total: number; checks: AiCitationCheckView[] } {
  const p = resolveAiCitationPeriod(ctx, period);
  const hosts = ownHostnames(ctx.config);
  const rows = rowsInPeriod(ctx, p, { engine: opts.engine ?? null }).filter((r) => !opts.groundedOnly || r.is_grounded === 1);
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : rows.length;
  return { period: p, total: rows.length, checks: rows.slice(0, limit).map((r) => toView(r, hosts)) };
}

function countMeasure<T>(value: T, unknown: number, reason: string): Measured<T> {
  return unknown ? incomplete(reason, value) : observed(value);
}

/**
 * Summary of the AI-citation observations recorded in a period. Numbers come
 * from grounded observations only; ungrounded rows are counted as excluded.
 */
export function aiCitationSummary(ctx: AppContext, period: AiCitationPeriod | string): AiCitationSummary {
  const p = resolveAiCitationPeriod(ctx, period);
  const enabled = ctx.settings.features.aiCitations;
  const clicks = unavailable<number>('a citation is not a click: no stored source measures clicks from AI answers');
  const conversions = unavailable<number>('a click is not a conversion: conversions from AI answers are not measured or attributed');
  const base = {
    enabled,
    period: p,
    clicks,
    conversions,
    semantics: AI_CITATION_SEMANTICS,
  };
  if (!enabled) {
    const reason = 'optional AI-citation monitoring is disabled (features.aiCitations is false; off by default in every profile)';
    return {
      ...base,
      status: 'disabled',
      containsSynthetic: false,
      checks: { total: 0, grounded: 0, ungroundedExcluded: 0 },
      mentionCitationKnown: 0,
      brandMentions: unavailable(reason),
      ownSiteCitations: unavailable(reason),
      mentionedNotCited: unavailable(reason),
      citedNotMentioned: unavailable(reason),
      byEngine: [],
      ownCitedUrls: [],
      sourceLabels: [],
      notes: ['AI visibility is not measured while monitoring is disabled; that is DATA_UNAVAILABLE, not zero.'],
    };
  }
  const hosts = ownHostnames(ctx.config);
  const rows = rowsInPeriod(ctx, p);
  const grounded = rows.filter((r) => r.is_grounded === 1);
  const ungrounded = rows.length - grounded.length;
  const notes: string[] = [];
  if (!rows.length) {
    const reason = `no AI-citation observations were recorded for ${p.start} to ${p.end}`;
    return {
      ...base,
      status: 'no_data',
      containsSynthetic: false,
      checks: { total: 0, grounded: 0, ungroundedExcluded: 0 },
      mentionCitationKnown: 0,
      brandMentions: unavailable(reason),
      ownSiteCitations: unavailable(reason),
      mentionedNotCited: unavailable(reason),
      citedNotMentioned: unavailable(reason),
      byEngine: [],
      ownCitedUrls: [],
      sourceLabels: [],
      notes: ['Nothing is collected automatically: observations appear only after `ai-citations import`. No observation is not the same as zero visibility.'],
    };
  }
  const mentioned = grounded.filter((r) => r.brand_mentioned === 1).length;
  const notMentioned = grounded.filter((r) => r.brand_mentioned === 0).length;
  const mentionUnknown = grounded.length - mentioned - notMentioned;
  const cited = grounded.filter((r) => r.own_site_cited === 1).length;
  const notCited = grounded.filter((r) => r.own_site_cited === 0).length;
  const citationUnknown = grounded.length - cited - notCited;
  const bothKnown = grounded.filter((r) => r.brand_mentioned !== null && r.own_site_cited !== null);
  const eitherUnknown = grounded.length - bothKnown.length;
  const onlyUngrounded = 'only ungrounded model responses were recorded in this period; they are not live search measurements';
  const byEngineMap = new Map<string, AiCitationEngineBreakdown>();
  for (const r of rows) {
    const e = byEngineMap.get(r.engine) ?? { engine: r.engine, grounded: 0, ungroundedExcluded: 0, brandMentioned: 0, brandMentionUnknown: 0, ownSiteCited: 0, ownSiteCitationUnknown: 0 };
    if (r.is_grounded !== 1) e.ungroundedExcluded++;
    else {
      e.grounded++;
      if (r.brand_mentioned === 1) e.brandMentioned++;
      if (r.brand_mentioned === null) e.brandMentionUnknown++;
      if (r.own_site_cited === 1) e.ownSiteCited++;
      if (r.own_site_cited === null) e.ownSiteCitationUnknown++;
    }
    byEngineMap.set(r.engine, e);
  }
  const urlCounts = new Map<string, number>();
  for (const r of grounded) for (const u of new Set(ownCitedUrls(parseCited(r.cited_urls_json), hosts) ?? [])) urlCounts.set(u, (urlCounts.get(u) ?? 0) + 1);
  if (ungrounded) notes.push(`${ungrounded} ungrounded model response(s) were excluded from every number: an ungrounded model response is not a live search measurement.`);
  if (mentionUnknown) notes.push(`${mentionUnknown} grounded observation(s) have no response text, so their brand mention is unknown (not "no").`);
  if (citationUnknown) notes.push(`${citationUnknown} grounded observation(s) have no recorded cited URLs, so their own-site citation is unknown (not "no").`);
  if (rows.some((r) => r.method === 'manual_import')) notes.push('Manually imported observations are owner-supplied samples of AI answers, not a complete or representative measurement of AI search visibility.');
  return {
    ...base,
    status: 'observed',
    containsSynthetic: rows.some((r) => r.is_synthetic === 1),
    checks: { total: rows.length, grounded: grounded.length, ungroundedExcluded: ungrounded },
    mentionCitationKnown: bothKnown.length,
    brandMentions: grounded.length ? countMeasure({ mentioned, notMentioned, unknown: mentionUnknown }, mentionUnknown, `${mentionUnknown} grounded observation(s) have no response text`) : unavailable(onlyUngrounded),
    ownSiteCitations: grounded.length ? countMeasure({ cited, notCited, unknown: citationUnknown }, citationUnknown, `${citationUnknown} grounded observation(s) have no recorded cited URLs`) : unavailable(onlyUngrounded),
    mentionedNotCited: grounded.length
      ? countMeasure(bothKnown.filter((r) => r.brand_mentioned === 1 && r.own_site_cited === 0).length, eitherUnknown, `${eitherUnknown} grounded observation(s) lack response text or cited URLs`)
      : unavailable(onlyUngrounded),
    citedNotMentioned: grounded.length
      ? countMeasure(bothKnown.filter((r) => r.own_site_cited === 1 && r.brand_mentioned === 0).length, eitherUnknown, `${eitherUnknown} grounded observation(s) lack response text or cited URLs`)
      : unavailable(onlyUngrounded),
    byEngine: [...byEngineMap.values()].sort((a, b) => a.engine.localeCompare(b.engine)),
    ownCitedUrls: [...urlCounts].map(([url, observations]) => ({ url, observations })).sort((a, b) => b.observations - a.observations || a.url.localeCompare(b.url)),
    sourceLabels: [...new Set(rows.map((r) => r.source_label).filter((s): s is string => !!s))].sort(),
    notes,
  };
}
