import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { budgetTimeZone, type AppContext } from '../app/context.js';
import { AppError, IntegrationDisabledError, errorMessage } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import { stripControlChars } from '../core/terminal.js';
import { newId } from '../core/ids.js';
import { dateInZone, isIsoDate, isValidTimeZone } from '../core/time.js';
import { recordAudit } from '../database/audit.js';
import { leadingComments, parseCsvRecords } from '../data/csv.js';
import { zoneOffsetMinutes } from '../jobs/dst.js';
import { AI_CITATION_MATCHING_VERSION, classifyObservation, parseCitedUrls } from './matching.js';

/**
 * `ai-citations import <file.csv|file.json>`: the explicit MANUAL-IMPORT
 * adapter for AI-citation observations (spec 17). The owner (or a tool the
 * owner uses) records what an AI search engine answered; this module stores
 * it with provenance. It never contacts an engine, never spends money, and
 * never invents a value.
 *
 * Each row is one observation: query (and optionally the exact prompt),
 * engine, date, location, grounded yes/no AS PROVIDED, the response text,
 * and the URLs the answer actually cited. Stored in `ai_citation_checks`
 * with method 'manual_import':
 * - `response_ref` points to a per-row raw record in the private workspace
 *   (data/raw) holding the response text and the row as supplied.
 * - `brand_mentioned` / `own_site_cited` are computed in code
 *   (src/aeo/matching.ts), never taken from the file; unknown stays NULL.
 * - `is_grounded` is required and taken as provided: this application cannot
 *   verify after the fact whether an answer used live retrieval. An ungrounded
 *   model response is stored with is_grounded = 0 and is never reported as a
 *   live search measurement.
 * - Re-importing the same observation is a no-op (unique grain, migration
 *   0200); a different value for an already stored observation is reported as
 *   a conflict and the stored row is kept.
 * - is_synthetic = 1 when the file declares itself synthetic (JSON
 *   "_synthetic": true, or a leading "# ... SYNTHETIC ..." CSV comment), with
 *   --synthetic, or in the demo profile.
 * - Control characters (ESC, BEL, a lone carriage return, C1 controls) in the
 *   stored text fields (engine, query, prompt, location, response, source) are
 *   replaced with spaces at ingestion (newlines and tabs are kept), so stored
 *   text can never drive a terminal. The raw record keeps the row as supplied.
 */

export const AI_CITATION_IMPORT_VERSION = 'ai-citations-manual-import@1';
export const MAX_AI_CITATION_IMPORT_BYTES = 20_000_000;
export const MAX_AI_CITATION_IMPORT_ROWS = 5_000;
export const MAX_RESPONSE_CHARS = 100_000;

/** Header aliases (after normalization: lower case, `_ . -` as spaces, single spaces). */
const ALIASES: Record<string, string> = {
  engine: 'engine',
  'ai engine': 'engine',
  platform: 'engine',
  assistant: 'engine',
  query: 'query',
  'search query': 'query',
  question: 'query',
  keyword: 'query',
  prompt: 'prompt',
  'exact prompt': 'prompt',
  location: 'location',
  country: 'location',
  market: 'location',
  date: 'date',
  'checked at': 'date',
  checked: 'date',
  'checked date': 'date',
  timestamp: 'date',
  'observed at': 'date',
  timezone: 'timezone',
  'time zone': 'timezone',
  tz: 'timezone',
  grounded: 'grounded',
  'is grounded': 'grounded',
  'live retrieval': 'grounded',
  response: 'response',
  'response text': 'response',
  answer: 'response',
  'answer text': 'response',
  'cited urls': 'cited_urls',
  citations: 'cited_urls',
  'cited sources': 'cited_urls',
  sources: 'cited_urls',
  source: 'source',
  'source label': 'source',
  tool: 'source',
  // Computed in code; a file's own values are ignored (reported as a warning).
  'brand mentioned': '__computed',
  'own site cited': '__computed',
  cited: '__computed',
  mentioned: '__computed',
};

const REQUIRED = ['engine', 'query', 'date', 'grounded'] as const;

export interface AiCitationImportOptions {
  format?: 'csv' | 'json';
  /** IANA zone for dates without a time and for the stored calendar date (default: the site's business time zone). */
  timeZone?: string;
  /** Tool or person that captured the observations, when the file has no source column. */
  sourceLabel?: string;
  /** Import the valid rows and report the import as partial instead of refusing the whole file. */
  skipInvalid?: boolean;
  /** Label the rows synthetic (test or demo data). Also set when the file declares itself synthetic. */
  synthetic?: boolean;
  /** Validate and classify only; write nothing. Implied by ctx.dryRun. */
  preview?: boolean;
}

export interface AiCitationImportRowError {
  row: number;
  errors: string[];
}

export interface AiCitationImportResult {
  file: string;
  format: 'csv' | 'json';
  sha256: string;
  preview: boolean;
  synthetic: boolean;
  method: 'manual_import';
  transformationVersion: string;
  status: 'succeeded' | 'partial' | 'failed' | 'preview';
  rowsRead: number;
  /** Valid rows (after validation, before comparing with stored rows). */
  accepted: number;
  inserted: number;
  /** Rows identical to an already stored observation (re-import). */
  unchanged: number;
  /** Rows whose grain key is already stored with different values; the stored row was kept. */
  conflicts: Array<{ row: number; existingId: string; differs: string[] }>;
  rejected: AiCitationImportRowError[];
  checkIds: string[];
  /** Counts over the valid rows. Ungrounded rows are model responses, not search measurements. */
  grounded: number;
  ungrounded: number;
  brandMentioned: { yes: number; no: number; unknown: number };
  ownSiteCited: { yes: number; no: number; unknown: number };
  dateRange: { start: string; end: string; timeZone: string } | null;
  warnings: string[];
}

interface ParsedRow {
  rowNo: number;
  engine: string;
  query: string;
  prompt: string | null;
  location: string | null;
  checkedAt: string;
  checkedDate: string;
  timeZone: string;
  precision: 'instant' | 'day';
  isGrounded: 0 | 1;
  response: string | null;
  citedUrls: string[] | null;
  sourceLabel: string | null;
  brandMentioned: 0 | 1 | null;
  ownSiteCited: 0 | 1 | null;
  matchedBrandTerms: string[] | null;
  ownCitedUrls: string[] | null;
  supplied: Record<string, unknown>;
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[_.\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The field a column maps to, or undefined. Own keys only: `constructor`, `__proto__`, `toString`, ... are unknown columns (reported as ignored). */
function aliasFor(column: string): string | undefined {
  const k = normalizeHeader(column);
  return Object.hasOwn(ALIASES, k) ? ALIASES[k] : undefined;
}

function readInput(file: string, format?: 'csv' | 'json'): { text: string; format: 'csv' | 'json'; abs: string } {
  const abs = path.resolve(file);
  let size: number;
  try {
    size = statSync(abs).size;
  } catch {
    throw new AppError('NOT_FOUND', `Import file not found: ${abs}`);
  }
  if (size > MAX_AI_CITATION_IMPORT_BYTES) throw new AppError('VALIDATION_FAILED', `Import file is larger than ${MAX_AI_CITATION_IMPORT_BYTES} bytes; split it.`);
  const ext = path.extname(abs).toLowerCase();
  const fmt = format ?? (ext === '.json' ? 'json' : ext === '.csv' ? 'csv' : null);
  if (!fmt) throw new AppError('VALIDATION_FAILED', `Cannot tell the format of ${path.basename(abs)}; pass --format csv or --format json.`);
  return { text: readFileSync(abs, 'utf8'), format: fmt, abs };
}

interface RawRecords {
  records: Array<Record<string, unknown>>;
  /** CSV: comment and blank lines before the header, so row numbers match the file's lines. */
  leadingLines: number;
  declaredSynthetic: boolean;
  unknownColumns: string[];
  ignoredComputed: string[];
  columns: Set<string>;
}

function readRecords(text: string, format: 'csv' | 'json'): RawRecords {
  let raw: Array<Record<string, unknown>>;
  let declaredSynthetic = false;
  let leadingLines = 0;
  if (format === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new AppError('VALIDATION_FAILED', `Invalid JSON: ${errorMessage(err)}`);
    }
    const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    declaredSynthetic = obj?._synthetic === true;
    const list = Array.isArray(parsed) ? parsed : Array.isArray(obj?.checks) ? obj!.checks : Array.isArray(obj?.rows) ? obj!.rows : null;
    if (!list) throw new AppError('VALIDATION_FAILED', 'JSON import must be an array of observation objects, or an object with a "checks" (or "rows") array.');
    raw = (list as unknown[]).map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : { __invalid: true }));
  } else {
    declaredSynthetic = leadingComments(text).some((c) => /\bsynthetic\b/i.test(c));
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    while (leadingLines < lines.length && (lines[leadingLines]!.startsWith('#') || lines[leadingLines]!.trim() === '')) leadingLines++;
    raw = parseCsvRecords(text).records;
  }
  if (raw.length > MAX_AI_CITATION_IMPORT_ROWS) throw new AppError('VALIDATION_FAILED', `Import has ${raw.length} rows; the limit is ${MAX_AI_CITATION_IMPORT_ROWS}. Split the file.`);
  const unknown = new Set<string>();
  const computed = new Set<string>();
  const columns = new Set<string>();
  const records = raw.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === '_synthetic' || k === '__invalid') continue;
      const key = aliasFor(k);
      if (!key) {
        unknown.add(k);
        continue;
      }
      if (key === '__computed') {
        computed.add(k);
        continue;
      }
      columns.add(key);
      out[key] = v;
    }
    if (Object.hasOwn(r, '__invalid')) out.__invalid = true;
    return out;
  });
  return { records, leadingLines, declaredSynthetic, unknownColumns: [...unknown], ignoredComputed: [...computed], columns };
}

/** Untrusted text as stored: control characters (ESC, BEL, a lone CR, ...) become spaces; newlines and tabs are kept. */
function clean(v: string): string {
  return stripControlChars(v.replace(/\r\n/g, '\n'));
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return clean(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

const TEXT_FIELDS = ['engine', 'query', 'prompt', 'location', 'timezone', 'date', 'response', 'source'] as const;

/** Rows whose text fields had control characters replaced (for the import notice). */
function rowHasControlChars(r: Record<string, unknown>): boolean {
  return TEXT_FIELDS.some((k) => {
    const v = r[k];
    if (typeof v !== 'string') return false;
    const s = v.replace(/\r\n/g, '\n');
    return clean(s) !== s;
  });
}

function parseGrounded(v: unknown): 0 | 1 | null | 'invalid' {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = String(v).trim().toLowerCase();
  if (s === '') return null;
  if (['1', 'true', 'yes', 'y', 'grounded'].includes(s)) return 1;
  if (['0', 'false', 'no', 'n', 'ungrounded', 'not grounded'].includes(s)) return 0;
  return 'invalid';
}

/** UTC instant of 12:00 wall-clock time on `date` in `timeZone` (offsets read from the IANA database, never hardcoded). */
export function noonInZone(date: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, 12, 0, 0);
  let t = wall - zoneOffsetMinutes(new Date(wall), timeZone) * 60_000;
  // A second pass settles the offset when the first guess crossed a transition.
  t = wall - zoneOffsetMinutes(new Date(t), timeZone) * 60_000;
  return new Date(t);
}

const INSTANT_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL_TIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

function parseWhen(raw: string | null, timeZone: string, now: Date, errors: string[]): { checkedAt: string; checkedDate: string; precision: 'instant' | 'day' } | null {
  const s = (raw ?? '').trim();
  if (!s) {
    errors.push('date is required (YYYY-MM-DD, or an ISO timestamp with Z or a UTC offset)');
    return null;
  }
  const today = dateInZone(now, timeZone);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && isIsoDate(s)) {
    if (s > today) {
      errors.push(`date ${s} is in the future (${timeZone})`);
      return null;
    }
    return { checkedAt: noonInZone(s, timeZone).toISOString(), checkedDate: s, precision: 'day' };
  }
  if (INSTANT_RE.test(s)) {
    const ms = Date.parse(s.replace(' ', 'T'));
    if (Number.isNaN(ms) || !isIsoDate(s.slice(0, 10))) {
      errors.push(`date is not a valid timestamp (got "${s}")`);
      return null;
    }
    if (ms > now.getTime() + 5 * 60_000) {
      errors.push(`timestamp ${s} is in the future`);
      return null;
    }
    const at = new Date(ms);
    return { checkedAt: at.toISOString(), checkedDate: dateInZone(at, timeZone), precision: 'instant' };
  }
  if (LOCAL_TIME_RE.test(s)) errors.push(`timestamp "${s}" has no time zone; add Z or a UTC offset (for example +03:00), or give only the date`);
  else errors.push(`date must be YYYY-MM-DD or an ISO timestamp with Z or a UTC offset (got "${s.slice(0, 60)}")`);
  return null;
}

function limited(value: string | null, name: string, max: number, errors: string[]): string | null {
  if (value !== null && value.length > max) {
    errors.push(`${name} is longer than ${max} characters`);
    return null;
  }
  return value;
}

function emptyResult(input: { abs: string; format: 'csv' | 'json'; text: string }, preview: boolean, synthetic: boolean): AiCitationImportResult {
  return {
    file: input.abs,
    format: input.format,
    sha256: sha256(input.text),
    preview,
    synthetic,
    method: 'manual_import',
    transformationVersion: `${AI_CITATION_IMPORT_VERSION}+${AI_CITATION_MATCHING_VERSION}`,
    status: preview ? 'preview' : 'failed',
    rowsRead: 0,
    accepted: 0,
    inserted: 0,
    unchanged: 0,
    conflicts: [],
    rejected: [],
    checkIds: [],
    grounded: 0,
    ungrounded: 0,
    brandMentioned: { yes: 0, no: 0, unknown: 0 },
    ownSiteCited: { yes: 0, no: 0, unknown: 0 },
    dateRange: null,
    warnings: [],
  };
}

/** Refuse unless features.aiCitations is on (off by default in every profile). */
export function assertAiCitationsEnabled(ctx: Pick<AppContext, 'settings'>): void {
  if (!ctx.settings.features.aiCitations) {
    throw new IntegrationDisabledError(
      'aiCitations',
      'optional AI-citation monitoring is off (features.aiCitations is false by default in every profile). Set features.aiCitations: true in the site config to record manually imported observations; nothing is collected automatically',
    );
  }
}

/** Import AI answer observations from a CSV or JSON file (manual-import adapter). */
export function importAiCitations(ctx: AppContext, file: string, opts: AiCitationImportOptions = {}): AiCitationImportResult {
  assertAiCitationsEnabled(ctx);
  const defaultZone = opts.timeZone ?? budgetTimeZone(ctx.config);
  if (!isValidTimeZone(defaultZone)) throw new AppError('VALIDATION_FAILED', `--timezone must be an IANA time zone name such as "Europe/Tallinn" (got "${defaultZone}")`);
  const defaultSource = opts.sourceLabel?.trim() ? opts.sourceLabel.trim().slice(0, 200) : null;
  const input = readInput(file, opts.format);
  const parsed = readRecords(input.text, input.format);
  const preview = !!opts.preview || ctx.dryRun;
  const synthetic = !!opts.synthetic || parsed.declaredSynthetic || ctx.synthetic;
  const result = emptyResult(input, preview, synthetic);
  result.rowsRead = parsed.records.length;
  const warnings: string[] = [];
  if (parsed.unknownColumns.length) warnings.push(`Ignored columns: ${parsed.unknownColumns.join(', ')}.`);
  if (parsed.ignoredComputed.length) warnings.push(`Ignored columns ${parsed.ignoredComputed.join(', ')}: brand mention and own-site citation are computed in code from the response text and the cited URLs, never taken from the file.`);
  const missingCols = REQUIRED.filter((c) => !parsed.columns.has(c));
  if (parsed.records.length && missingCols.length) {
    throw new AppError('VALIDATION_FAILED', `The file is missing required column(s): ${missingCols.join(', ')}. Required: engine, query, date, grounded; optional: prompt, location, timezone, response, cited_urls, source.`, {
      hint: 'grounded must be stated per row (yes/no): whether the answer came from live retrieval cannot be verified after the fact, so it is never guessed.',
    });
  }
  const controlRows = parsed.records.filter(rowHasControlChars).length;
  if (controlRows) warnings.push(`${controlRows} row(s) contained control characters (for example ESC, BEL, or a lone carriage return) in their text; each was replaced with a space before storing, so stored text can never drive a terminal.`);
  const now = ctx.clock.now();
  const rows: ParsedRow[] = [];
  const seen = new Map<string, number>();
  parsed.records.forEach((r, i) => {
    // CSV: the file line of the row when no quoted field spans lines (header = first non-comment line); JSON: 1-based index.
    const rowNo = input.format === 'csv' ? parsed.leadingLines + i + 2 : i + 1;
    const errors: string[] = [];
    if (r.__invalid) errors.push('not an object');
    const engine = (text(r.engine) ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!engine) errors.push('engine is required (for example the AI search product the answer came from)');
    else if (engine.length > 100) errors.push('engine is longer than 100 characters');
    const query = (text(r.query) ?? '').replace(/\s+/g, ' ').trim();
    if (!query) errors.push('query is required');
    else if (query.length > 1_000) errors.push('query is longer than 1000 characters');
    const promptRaw = text(r.prompt)?.trim() || null;
    const prompt = limited(promptRaw, 'prompt', 20_000, errors);
    const location = limited(text(r.location)?.replace(/\s+/g, ' ').trim() || null, 'location', 200, errors);
    const zone = text(r.timezone)?.trim() || defaultZone;
    if (!isValidTimeZone(zone)) errors.push(`timezone must be an IANA time zone name (got "${zone}")`);
    const when = isValidTimeZone(zone) ? parseWhen(text(r.date), zone, now, errors) : null;
    const grounded = parseGrounded(r.grounded);
    if (grounded === null) errors.push('grounded is required (yes/no): state whether the answer used live search retrieval');
    else if (grounded === 'invalid') errors.push(`grounded must be yes or no (got "${String(r.grounded).slice(0, 40)}")`);
    if (r.response !== undefined && r.response !== null && typeof r.response !== 'string') errors.push('response must be text');
    const responseRaw = typeof r.response === 'string' ? clean(r.response) : null;
    const response = responseRaw !== null && responseRaw.trim() !== '' ? limited(responseRaw, 'response', MAX_RESPONSE_CHARS, errors) : null;
    const cited = parseCitedUrls(r.cited_urls);
    if (!cited.ok) errors.push(...cited.errors);
    const sourceLabel = text(r.source)?.trim().slice(0, 200) || defaultSource;
    if (errors.length || !when || grounded === null || grounded === 'invalid' || !cited.ok) {
      result.rejected.push({ row: rowNo, errors: errors.length ? errors : ['invalid row'] });
      return;
    }
    const key = JSON.stringify([engine, query, prompt ?? '', location ?? '', when.checkedAt]);
    const dupOf = seen.get(key);
    if (dupOf !== undefined) {
      result.rejected.push({ row: rowNo, errors: [`duplicate of row ${dupOf} (same engine, query, prompt, location, and time)`] });
      return;
    }
    seen.set(key, rowNo);
    const c = classifyObservation({ responseText: response, citedUrls: cited.urls }, ctx.config);
    rows.push({
      rowNo,
      engine,
      query,
      prompt,
      location,
      checkedAt: when.checkedAt,
      checkedDate: when.checkedDate,
      timeZone: zone,
      precision: when.precision,
      isGrounded: grounded,
      response,
      citedUrls: cited.urls,
      sourceLabel,
      brandMentioned: c.brandMentioned === null ? null : c.brandMentioned ? 1 : 0,
      ownSiteCited: c.ownSiteCited === null ? null : c.ownSiteCited ? 1 : 0,
      matchedBrandTerms: c.matchedBrandTerms,
      ownCitedUrls: c.ownCitedUrls,
      supplied: Object.fromEntries(Object.entries(r).filter(([k]) => k !== '__invalid')),
    });
  });
  result.accepted = rows.length;
  for (const row of rows) {
    if (row.isGrounded) result.grounded++;
    else result.ungrounded++;
    result.brandMentioned[row.brandMentioned === null ? 'unknown' : row.brandMentioned ? 'yes' : 'no']++;
    result.ownSiteCited[row.ownSiteCited === null ? 'unknown' : row.ownSiteCited ? 'yes' : 'no']++;
  }
  if (rows.length) {
    const dates = rows.map((r) => r.checkedDate).sort();
    const zones = [...new Set(rows.map((r) => r.timeZone))];
    result.dateRange = { start: dates[0]!, end: dates[dates.length - 1]!, timeZone: zones.length === 1 ? zones[0]! : 'mixed' };
  }
  if (result.ungrounded) warnings.push(`${result.ungrounded} row(s) are ungrounded model responses (grounded = no): they are stored for reference and never reported as live search measurements.`);
  if (result.brandMentioned.unknown) warnings.push(`${result.brandMentioned.unknown} row(s) have no response text: brand mention is unknown (NULL), not "no".`);
  if (result.ownSiteCited.unknown) warnings.push(`${result.ownSiteCited.unknown} row(s) have no cited_urls: own-site citation is unknown (NULL), not "no". Write "none" when the answer cited nothing.`);
  if (rows.some((r) => r.precision === 'day')) warnings.push('Rows with a date but no time are stored at day precision (checked_at is 12:00 in their time zone; the time of day is unknown).');
  result.warnings = warnings;
  if (!rows.length) {
    if (!preview) result.status = 'failed';
    if (!result.rejected.length && !parsed.records.length) result.warnings.push('The file has no data rows; nothing was imported.');
    return result;
  }
  if (result.rejected.length && !opts.skipInvalid) {
    result.status = preview ? 'preview' : 'failed';
    result.warnings.push(`${result.rejected.length} invalid row(s): nothing was imported. Fix them, or pass --skip-invalid to import the ${rows.length} valid row(s).`);
    return result;
  }

  const existing = (row: ParsedRow) =>
    ctx.db.get<{ id: string; is_grounded: number; cited_urls_json: string | null; response_sha256: string | null; source_label: string | null }>(
      `SELECT id, is_grounded, cited_urls_json, response_sha256, source_label FROM ai_citation_checks
        WHERE site_id = ? AND engine = ? AND query = ? AND COALESCE(prompt, '') = ? AND COALESCE(location, '') = ? AND method = 'manual_import' AND checked_at = ?`,
      [ctx.siteId, row.engine, row.query, row.prompt ?? '', row.location ?? '', row.checkedAt],
    );
  const differences = (row: ParsedRow, ex: NonNullable<ReturnType<typeof existing>>): string[] => {
    const d: string[] = [];
    if (ex.is_grounded !== row.isGrounded) d.push('grounded');
    if ((ex.cited_urls_json ?? null) !== (row.citedUrls === null ? null : JSON.stringify(row.citedUrls))) d.push('cited_urls');
    if ((ex.response_sha256 ?? null) !== (row.response === null ? null : sha256(row.response))) d.push('response');
    return d;
  };

  if (preview) {
    for (const row of rows) {
      const ex = existing(row);
      if (!ex) continue;
      const d = differences(row, ex);
      if (d.length) result.conflicts.push({ row: row.rowNo, existingId: ex.id, differs: d });
      else result.unchanged++;
    }
    if (result.conflicts.length) result.warnings.push(`${result.conflicts.length} row(s) differ from observations already stored for the same engine, query, prompt, location, and time; the stored rows would be kept.`);
    return result;
  }

  const collectedAt = now.toISOString();
  const fileName = path.basename(input.abs);
  ctx.db.transaction(() => {
    for (const row of rows) {
      const ex = existing(row);
      if (ex) {
        const d = differences(row, ex);
        if (d.length) result.conflicts.push({ row: row.rowNo, existingId: ex.id, differs: d });
        else result.unchanged++;
        continue;
      }
      const id = newId('aic');
      const responseRef = ctx.raw.save({
        siteId: ctx.siteId,
        provider: 'ai-citations',
        kind: 'manual-import',
        at: now,
        payload: {
          observationId: id,
          method: 'manual_import',
          synthetic,
          file: fileName,
          fileSha256: result.sha256,
          row: row.rowNo,
          sourceLabel: row.sourceLabel,
          engine: row.engine,
          query: row.query,
          prompt: row.prompt,
          location: row.location,
          checkedAt: row.checkedAt,
          checkedDate: row.checkedDate,
          timeZone: row.timeZone,
          precision: row.precision,
          isGrounded: row.isGrounded === 1,
          response: row.response,
          citedUrls: row.citedUrls,
          classification: { version: AI_CITATION_MATCHING_VERSION, matchedBrandTerms: row.matchedBrandTerms, ownCitedUrls: row.ownCitedUrls },
          supplied: row.supplied,
        },
      });
      ctx.db.run(
        `INSERT INTO ai_citation_checks (id, site_id, engine, query, prompt, location, method, is_grounded, response_ref, cited_urls_json, brand_mentioned, own_site_cited, is_synthetic, checked_at,
                                         source_label, checked_date, checked_date_tz, checked_at_precision, response_sha256, transformation_version, collected_at)
         VALUES (?, ?, ?, ?, ?, ?, 'manual_import', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          ctx.siteId,
          row.engine,
          row.query,
          row.prompt,
          row.location,
          row.isGrounded,
          responseRef,
          row.citedUrls === null ? null : JSON.stringify(row.citedUrls),
          row.brandMentioned,
          row.ownSiteCited,
          synthetic ? 1 : 0,
          row.checkedAt,
          row.sourceLabel,
          row.checkedDate,
          row.timeZone,
          row.precision,
          row.response === null ? null : sha256(row.response),
          result.transformationVersion,
          collectedAt,
        ],
      );
      result.inserted++;
      result.checkIds.push(id);
    }
    recordAudit(ctx.db, {
      siteId: ctx.siteId,
      actor: 'cli',
      eventType: 'ai_citations.imported',
      subjectType: 'ai_citation_checks',
      at: now,
      details: {
        file: fileName,
        sha256: result.sha256,
        method: 'manual_import',
        synthetic,
        rowsRead: result.rowsRead,
        inserted: result.inserted,
        unchanged: result.unchanged,
        conflicts: result.conflicts.length,
        rejected: result.rejected.length,
        transformationVersion: result.transformationVersion,
      },
    });
  });
  if (result.unchanged) result.warnings.push(`${result.unchanged} row(s) were already stored with the same values (re-import); nothing changed for them.`);
  if (result.conflicts.length) result.warnings.push(`${result.conflicts.length} row(s) differ from observations already stored for the same engine, query, prompt, location, and time; the stored rows were kept (an observation is never overwritten).`);
  result.status = result.rejected.length || result.conflicts.length ? 'partial' : 'succeeded';
  return result;
}
