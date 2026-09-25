import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../app/context.js';
import { AppError, errorMessage } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import { newId } from '../core/ids.js';
import { stripControlChars } from '../core/terminal.js';
import { readManifest } from '../config/workspace.js';
import { addDays, dateInZone, isIsoDate } from '../core/time.js';
import { upsertKeyword } from '../integrations/dataforseo/store.js';
import { GSC_TIME_ZONE } from '../integrations/google/gsc-client.js';
import { GSC_ASSUMED_INCOMPLETE_DAYS, segmentKeyOf } from '../integrations/google/gsc-sync.js';
import { VERSIONED_KEYS, emptyCounts, finishBatch, startBatch, tally, upsertRevision, type BatchCounts, type SqlValue, type VersionedTable } from '../integrations/google/versioned.js';
import { segmentShapeOf } from '../seo/coverage.js';
import { EXPORT_MARKER, leadingComments, parseCsvRecords } from './csv.js';
import { EXPORT_DATASETS } from './export.js';

/**
 * `data import <dataset> <file.csv|json>`: bring metrics or keyword lists
 * from other tools in WITH provenance, instead of adding integrations
 * (spec 2: "Provide CSV/JSON import/export").
 *
 * - Every import is an ingestion batch with source 'import' (startBatch), the
 *   stored file's raw_ref (data/raw in the private workspace), and the import
 *   transformation version. Metric rows go through upsertRevision, so a
 *   re-import of the same file never double counts and a changed value
 *   becomes a new revision.
 * - Rows are imported at the stored DAILY grain only. A Search Console UI
 *   export of Pages or Queries is aggregated over its date range (no Date
 *   column) and is refused instead of being stored as if it were one day.
 * - Nothing is guessed: a CTR above 1 without a % sign is stored as NULL
 *   (scale unknown), missing positions stay NULL, invalid rows are rejected
 *   with their row number (all-or-nothing unless --skip-invalid).
 * - Rows collected by a Google sync are kept; the file's value supersedes
 *   them only with --replace.
 * - Completeness of a file cannot be verified: unless the owner asserts it
 *   (--complete), the batch is flagged truncated so dates or pages without
 *   rows are never read as zeros.
 * - is_synthetic = 0 (owner data) unless the file declares itself synthetic
 *   (JSON "_synthetic": true or "containsSynthetic": true, a leading
 *   "# ... SYNTHETIC ..." CSV comment, or any row with is_synthetic = 1),
 *   --synthetic is passed, or the workspace is a demo (ctx.synthetic). A file
 *   that mixes is_synthetic = 1 and 0 rows is refused unless --synthetic
 *   labels every row synthetic: synthetic rows never become live data.
 * - A LIVE workspace refuses a synthetic import (WORKSPACE_UNSAFE, before
 *   anything is written, also as a preview), as `restore` refuses a demo
 *   backup: synthetic files (for example a `data export` of a demo workspace)
 *   belong in a demo workspace. The workspace kind is the manifest kind, as
 *   createAppContext and `restore` read it.
 * - A synthetic row never supersedes a non-synthetic current row (kept, even
 *   with --replace): defense in depth for a workspace without a manifest.
 * - A `property` column is honoured in ANY file: a row whose non-empty
 *   property is another Search Console property is rejected unless --property
 *   names it, so another property's rows are never stored under this one.
 * - A file written by `data export` (recognized by the export marker comment,
 *   exactly the column layout of an export dataset, or the JSON export
 *   envelope) also keeps its finality: a row that was not final (is_final = 0)
 *   stays not final. In any file, the segment columns (segment_key,
 *   search_appearance, country, device) keep a breakdown row in its own
 *   segment: it never becomes a page total, and a file with visible query rows
 *   is never imported as page or property totals.
 * - Control characters (ESC, BEL, a lone carriage return, C1 controls) in cell
 *   text are replaced with spaces before anything is stored (newlines and tabs
 *   are kept), so stored text can never drive the terminal.
 * - The batch records the dates it saw per segment shape
 *   (coverage_json.importScope), including rows that were unchanged or kept
 *   from a Google sync, so a re-import with --complete covers its date range
 *   even when it writes no new revision (src/seo/coverage.ts).
 * - Cell text is kept exactly as written. The spreadsheet formula guard of
 *   `data export` (a leading apostrophe; see csv.ts) is removed only from a
 *   file recognized as a seo-agent data export (the export marker comment, or
 *   exactly the column layout of an export dataset), or with --unguard. A
 *   genuine leading apostrophe in a third-party file is never stripped.
 * - Column names are matched against the alias tables as own keys only: a
 *   column named `constructor`, `__proto__`, `toString`, ... is reported as
 *   ignored like any other unknown column.
 */

export const DATA_IMPORT_VERSION = 'data-import@1';
export const MAX_IMPORT_BYTES = 50_000_000;
export const MAX_IMPORT_ROWS = 500_000;
/** Imported keyword volumes are provider estimates; they are treated as fresh for this many days. */
export const IMPORTED_VOLUME_TTL_DAYS = 30;

const SEARCH_TYPES = ['web', 'image', 'video', 'news', 'discover', 'googleNews'] as const;
const INTENTS = ['informational', 'commercial', 'transactional', 'navigational', 'mixed', 'unsure'] as const;

interface GscImportDef {
  kind: 'gsc';
  table: Extract<VersionedTable, 'gsc_property_daily' | 'gsc_page_daily' | 'gsc_page_query_daily'>;
  required: string[];
  aggregationType: 'byProperty' | 'byPage';
  segments: boolean;
  description: string;
}
interface KeywordImportDef {
  kind: 'keywords';
  required: string[];
  description: string;
}

export const IMPORT_DATASETS: Record<string, GscImportDef | KeywordImportDef> = {
  'gsc-property': {
    kind: 'gsc',
    table: 'gsc_property_daily',
    required: ['date', 'clicks', 'impressions'],
    aggregationType: 'byProperty',
    segments: false,
    description: 'Search Console property totals per day (e.g. the "Dates" export): date, clicks, impressions[, ctr, position]',
  },
  'gsc-pages': {
    kind: 'gsc',
    table: 'gsc_page_daily',
    required: ['date', 'page', 'clicks', 'impressions'],
    aggregationType: 'byPage',
    segments: true,
    description: 'Search Console page totals per day: date, page, clicks, impressions[, ctr, position, country, device]',
  },
  'gsc-queries': {
    kind: 'gsc',
    table: 'gsc_page_query_daily',
    required: ['date', 'page', 'query', 'clicks', 'impressions'],
    aggregationType: 'byPage',
    segments: true,
    description: 'Search Console page/query rows per day: date, page, query, clicks, impressions[, ctr, position, country, device]',
  },
  keywords: {
    kind: 'keywords',
    required: ['keyword'],
    description: 'Keyword list: keyword[, language, intent, branded, search_volume, location_code] (volumes are stored as provider estimates)',
  },
};

export const IMPORT_DATASET_NAMES = Object.keys(IMPORT_DATASETS);

/** Header aliases (after normalization: lower case, `_ . -` as spaces, single spaces). */
const GSC_ALIASES: Record<string, string> = {
  date: 'date',
  day: 'date',
  page: 'page',
  url: 'page',
  'page url': 'page',
  'landing page': 'page',
  'top pages': 'page',
  address: 'page',
  query: 'query',
  queries: 'query',
  'top queries': 'query',
  'search query': 'query',
  clicks: 'clicks',
  'url clicks': 'clicks',
  impressions: 'impressions',
  ctr: 'ctr',
  'url ctr': 'ctr',
  position: 'position',
  'average position': 'position',
  'avg position': 'position',
  'search type': 'search_type',
  searchtype: 'search_type',
  type: 'search_type',
  country: 'country',
  device: 'device',
  // Segment columns (a `data export` of gsc-pages / gsc-queries, or an API export with the searchAppearance dimension).
  'segment key': 'segment_key',
  'search appearance': 'search_appearance',
  searchappearance: 'search_appearance',
  'is synthetic': 'is_synthetic',
  // The Search Console property a row belongs to (a `data export`, or any other file that names it): checked against the target property.
  property: 'property',
};

/** Columns honoured only in a file recognized as a seo-agent `data export` (their meaning is this application's own). */
const GSC_EXPORT_ALIASES: Record<string, string> = {
  'is final': 'is_final',
};

const KEYWORD_ALIASES: Record<string, string> = {
  keyword: 'keyword',
  keywords: 'keyword',
  term: 'keyword',
  'search term': 'keyword',
  query: 'keyword',
  language: 'language',
  lang: 'language',
  'language code': 'language',
  intent: 'intent',
  'search intent': 'intent',
  branded: 'is_branded',
  'is branded': 'is_branded',
  brand: 'is_branded',
  'search volume': 'search_volume',
  volume: 'search_volume',
  'avg monthly searches': 'search_volume',
  'monthly searches': 'search_volume',
  'location code': 'location_code',
  'is synthetic': 'is_synthetic',
};

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[_.\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The field a column maps to, or undefined (own keys only: `constructor`, `toString`, ... are not columns). */
function aliasFor(aliases: Record<string, string>, column: string): string | undefined {
  const k = normalizeHeader(column);
  return Object.hasOwn(aliases, k) ? aliases[k] : undefined;
}

/** A CSV written by `data export`: the export marker comment, or exactly the column layout of an export dataset. */
function exportedBySeoAgent(header: readonly string[], comments: readonly string[]): string | null {
  if (comments.some((c) => c.startsWith(EXPORT_MARKER))) return 'export marker comment';
  for (const [name, def] of Object.entries(EXPORT_DATASETS)) {
    const cols: readonly string[] = def.columns;
    if (cols.length === header.length && cols.every((c, i) => c === header[i])) return `column layout of the ${name} export`;
  }
  return null;
}

/** A JSON file written by `data export`: its envelope (transformationVersion data-export@..., containsSynthetic), or rows with exactly the columns of an export dataset. */
function jsonExportedBySeoAgent(obj: Record<string, unknown> | null, list: readonly unknown[]): string | null {
  if (obj && typeof obj.transformationVersion === 'string' && obj.transformationVersion.startsWith('data-export@')) return 'data export JSON envelope';
  if (obj && typeof obj.containsSynthetic === 'boolean') return 'data export JSON envelope (containsSynthetic)';
  const first = list.find((x) => x && typeof x === 'object' && !Array.isArray(x)) as Record<string, unknown> | undefined;
  if (!first) return null;
  const keys = Object.keys(first);
  for (const [name, def] of Object.entries(EXPORT_DATASETS)) {
    const cols: readonly string[] = def.columns;
    if (cols.length === keys.length && cols.every((c) => keys.includes(c))) return `columns of the ${name} export`;
  }
  return null;
}

export interface ImportRowError {
  row: number;
  errors: string[];
}

export interface DataImportOptions {
  format?: 'csv' | 'json';
  /** Search Console property (default: google.searchConsoleProperty; never guessed). */
  property?: string | null;
  /** Search type when the file has no search type column (default 'web'). */
  searchType?: string;
  /** Supersede rows collected by a Google sync (default: keep them and skip the file's row). */
  replace?: boolean;
  /** Import the valid rows and record the batch as partial instead of refusing the whole file. */
  skipInvalid?: boolean;
  /** The owner asserts the file is complete for its date range (absent rows are real zeros). */
  complete?: boolean;
  /** Label the rows synthetic (test/demo data). Also set when the file declares itself synthetic. */
  synthetic?: boolean;
  /** Tool the keyword volumes come from (stored as provider `import:<name>`). */
  provider?: string | null;
  /** Validate and count only; write nothing. Implied by ctx.dryRun. */
  preview?: boolean;
  /**
   * CSV: remove the spreadsheet formula guard (a leading apostrophe) that
   * `data export` adds. Default: only for a file recognized as a seo-agent
   * data export; true forces it (a file exported by an older version or
   * re-saved without the marker), false never removes it.
   */
  unguard?: boolean;
}

export interface DataImportResult {
  dataset: string;
  file: string;
  format: 'csv' | 'json';
  sha256: string;
  preview: boolean;
  synthetic: boolean;
  batchId: string | null;
  rawRef: string | null;
  status: 'succeeded' | 'partial' | 'failed' | 'preview';
  rowsRead: number;
  accepted: number;
  rejected: ImportRowError[];
  /** Keys whose current row came from a Google sync and was kept (see --replace). */
  skippedExisting: number;
  /** Keys whose current row is non-synthetic (live) and was kept: a synthetic row never supersedes one, even with --replace. */
  keptNonSynthetic: number;
  counts: BatchCounts;
  keywords?: { created: number; matchedExisting: number; volumes: number };
  dateRange: { start: string; end: string } | null;
  warnings: string[];
}

function readInput(file: string, format?: 'csv' | 'json'): { text: string; format: 'csv' | 'json'; abs: string } {
  const abs = path.resolve(file);
  let size: number;
  try {
    size = statSync(abs).size;
  } catch {
    throw new AppError('NOT_FOUND', `Import file not found: ${abs}`);
  }
  if (size > MAX_IMPORT_BYTES) throw new AppError('VALIDATION_FAILED', `Import file is larger than ${MAX_IMPORT_BYTES} bytes; split it.`);
  const ext = path.extname(abs).toLowerCase();
  const fmt = format ?? (ext === '.json' ? 'json' : ext === '.csv' ? 'csv' : null);
  if (!fmt) throw new AppError('VALIDATION_FAILED', `Cannot tell the format of ${path.basename(abs)}; pass --format csv or --format json.`);
  return { text: readFileSync(abs, 'utf8'), format: fmt, abs };
}

interface ReadRecords {
  records: Array<Record<string, string>>;
  declaredSynthetic: boolean;
  unknownColumns: string[];
  columns: string[];
  guardNote: string | null;
  /** Why the file is recognized as a seo-agent `data export` (null: not recognized). */
  exportBasis: string | null;
  /** Cells whose text had control characters replaced with spaces. */
  controlCells: number;
}

/**
 * Records with normalized header keys mapped through `aliases` (and, for a
 * file recognized as a seo-agent export, `exportAliases`); unknown columns are
 * reported, never guessed. Control characters in cell text become spaces.
 */
function readRecords(text: string, format: 'csv' | 'json', aliases: Record<string, string>, unguardOpt?: boolean, exportAliases: Record<string, string> = {}): ReadRecords {
  let raw: Array<Record<string, unknown>>;
  let declaredSynthetic = false;
  let guardNote: string | null = null;
  let exportBasis: string | null = null;
  if (format === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new AppError('VALIDATION_FAILED', `Invalid JSON: ${errorMessage(err)}`);
    }
    const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    // A `data export` JSON says whether any of its rows is synthetic (containsSynthetic).
    declaredSynthetic = obj?._synthetic === true || obj?.containsSynthetic === true;
    const list = Array.isArray(parsed) ? parsed : Array.isArray(obj?.rows) ? obj!.rows : Array.isArray(obj?.data) ? obj!.data : null;
    if (!list) throw new AppError('VALIDATION_FAILED', 'JSON import must be an array of row objects, or an object with a "rows" (or "data") array.');
    exportBasis = jsonExportedBySeoAgent(obj, list as unknown[]);
    raw = (list as unknown[]).map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : { __invalid: true }));
  } else {
    declaredSynthetic = leadingComments(text).some((c) => /\bsynthetic\b/i.test(c));
    let basis: string | null = null;
    const csv = parseCsvRecords(text, {
      unguard: (header, comments) => {
        exportBasis = exportedBySeoAgent(header, comments);
        basis = unguardOpt === true ? '--unguard' : unguardOpt === false ? null : exportBasis;
        return basis !== null;
      },
    });
    raw = csv.records;
    if (csv.guardLikeCells) {
      guardNote = csv.unguarded
        ? `Removed the spreadsheet formula guard (a leading apostrophe added by \`data export\`) from ${csv.guardLikeCells} cell(s) (${basis}).`
        : `${csv.guardLikeCells} cell(s) start with an apostrophe followed by =, +, -, @, or another apostrophe; they were kept exactly as written because the file is not recognized as a seo-agent data export. If the file came from \`data export\` (for example of an older version), re-import it with --unguard.`;
    }
  }
  if (raw.length > MAX_IMPORT_ROWS) throw new AppError('VALIDATION_FAILED', `Import has ${raw.length} rows; the limit is ${MAX_IMPORT_ROWS}. Split the file.`);
  // Own keys only (a spread copies own properties): `constructor`, `__proto__`, ... stay unknown.
  const map = exportBasis ? { ...aliases, ...exportAliases } : aliases;
  const unknown = new Set<string>();
  const columns = new Set<string>();
  let controlCells = 0;
  const records = raw.map((r) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === '_synthetic' || k === '__invalid') continue;
      const key = aliasFor(map, k);
      if (!key) {
        unknown.add(k);
        continue;
      }
      columns.add(key);
      const s = (v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v)).replace(/\r\n/g, '\n');
      const clean = stripControlChars(s);
      if (clean !== s) controlCells++;
      out[key] = clean.trim();
    }
    if (Object.hasOwn(r, '__invalid')) out.__invalid = '1';
    return out;
  });
  return { records, declaredSynthetic, unknownColumns: [...unknown], columns: [...columns], guardNote, exportBasis, controlCells };
}

function controlCellsNote(n: number): string | null {
  return n ? `${n} cell(s) contained control characters (for example ESC, BEL, or a lone carriage return); each was replaced with a space before storing, so stored text can never drive a terminal.` : null;
}

/**
 * The kind of the workspace an import writes to, read as createAppContext and
 * `restore` read it: the workspace manifest kind. A workspace without a
 * manifest (a library caller) is a demo only for a synthetic (demo-profile)
 * context; otherwise it is treated as live.
 */
function workspaceKind(ctx: AppContext): 'live' | 'demo' {
  return readManifest(ctx.paths)?.kind ?? (ctx.synthetic ? 'demo' : 'live');
}

/**
 * The synthetic label of an import: --synthetic, a file that declares itself
 * synthetic (JSON `_synthetic` / `containsSynthetic`, a "# ... synthetic"
 * CSV comment), a row with is_synthetic = 1, or a demo workspace. A LIVE
 * workspace refuses a synthetic import (WORKSPACE_UNSAFE) before anything is
 * written, like `restore` refuses a demo backup: synthetic data never mixes
 * with live data. A file that mixes synthetic and non-synthetic rows is
 * refused unless --synthetic labels every row synthetic.
 */
function importSynthetic(ctx: AppContext, parsed: ReadRecords, opts: DataImportOptions, fileName: string): { synthetic: boolean; syntheticRows: number; note: string | null } {
  let yes = 0;
  let no = 0;
  for (const r of parsed.records) {
    const v = parseFlag(r.is_synthetic);
    if (v === 1) yes++;
    else if (v === 0) no++;
  }
  const fileReasons = [
    opts.synthetic ? '--synthetic was passed' : '',
    yes ? `${yes} row(s) of the file are marked is_synthetic = 1` : '',
    parsed.declaredSynthetic ? 'the file declares itself synthetic (a "# ... SYNTHETIC" comment, or "_synthetic" / "containsSynthetic" in JSON, as a `data export` of a demo workspace writes it)' : '',
  ].filter(Boolean);
  if (fileReasons.length && workspaceKind(ctx) === 'live') {
    throw new AppError(
      'WORKSPACE_UNSAFE',
      `${fileName} is synthetic (${fileReasons.join('; ')}), but ${ctx.paths.root} is a live workspace. Synthetic data never mixes with live data or replaces the owner's rows; nothing was imported.`,
      {
        details: { workspaceKind: 'live', reasons: fileReasons, syntheticRows: yes, file: fileName },
        hint: 'Import synthetic (test, fixture, or demo) files into a demo workspace instead: `npm run demo` creates one, then `npm run cli -- --workspace <demo dir> data import <dataset> <file>`. A `data export` of a demo workspace is labeled synthetic and can only be imported there.',
      },
    );
  }
  if (yes && no && !opts.synthetic) {
    throw new AppError(
      'VALIDATION_FAILED',
      `The file mixes synthetic rows (is_synthetic = 1: ${yes} row(s)) with non-synthetic rows (${no} row(s)). Synthetic data is never mixed into live data: split the file, or pass --synthetic to label every row synthetic. Nothing was imported.`,
    );
  }
  const synthetic = !!opts.synthetic || parsed.declaredSynthetic || ctx.synthetic || yes > 0;
  const reasons = [
    yes ? `${yes} row(s) of the file are marked is_synthetic = 1` : '',
    parsed.declaredSynthetic ? 'the file declares itself synthetic' : '',
    ctx.synthetic ? 'this is a demo workspace' : '',
  ].filter(Boolean);
  const note = synthetic && !opts.synthetic && reasons.length ? `Every row is stored as SYNTHETIC (${reasons.join('; ')}): synthetic rows are labeled and never counted as live data.` : null;
  return { synthetic, syntheticRows: yes, note };
}

function parseCount(v: string | undefined, name: string, errors: string[]): number | null {
  if (v === undefined || v === '') {
    errors.push(`${name} is required`);
    return null;
  }
  const s = v.replace(/[\s ]/g, '').replace(/,(?=\d{3}(\D|$))/g, '');
  if (!/^\d+(\.0+)?$/.test(s)) {
    errors.push(`${name} must be a non-negative whole number (got "${v}")`);
    return null;
  }
  return Number.parseInt(s, 10);
}

function parseOptionalNumber(v: string | undefined, name: string, errors: string[], check: (n: number) => boolean, rule: string): number | null {
  if (v === undefined || v === '') return null;
  const n = Number(v.replace(/[\s ]/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || !check(n)) {
    errors.push(`${name} ${rule} (got "${v}")`);
    return null;
  }
  return n;
}

/** CTR as a fraction: "5.2%" -> 0.052, 0.052 -> 0.052; a bare value above 1 has an unknown scale and is stored as NULL. */
function parseCtr(v: string | undefined, errors: string[], warnings: Set<string>): number | null {
  if (v === undefined || v === '') return null;
  const pct = v.trim().endsWith('%');
  const n = Number(v.replace('%', '').replace(/[\s ]/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) {
    errors.push(`ctr must be a non-negative number or percentage (got "${v}")`);
    return null;
  }
  if (pct) return n / 100;
  if (n > 1) {
    warnings.add('Some CTR values are above 1 without a % sign: their scale is unknown, so CTR was stored as NULL for those rows (reports recompute CTR from clicks and impressions).');
    return null;
  }
  return n;
}

function httpUrl(v: string | undefined): boolean {
  if (!v) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseBool(v: string | undefined): 0 | 1 | null | 'invalid' {
  if (v === undefined || v === '') return null;
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'branded'].includes(s)) return 1;
  if (['0', 'false', 'no', 'n', 'non-branded', 'nonbranded'].includes(s)) return 0;
  return 'invalid';
}

/** A 0/1 flag column of a `data export` (is_synthetic, is_final): 1/true, 0/false, empty = not stated. */
function parseFlag(v: string | undefined): 0 | 1 | null | 'invalid' {
  if (v === undefined || v === '') return null;
  const s = v.trim().toLowerCase();
  if (s === '1' || s === 'true') return 1;
  if (s === '0' || s === 'false') return 0;
  return 'invalid';
}

function firstIncompleteDate(ctx: AppContext, property: string, searchType: string): { date: string; basis: string } {
  const av = ctx.db.get<{ first_incomplete_date: string | null; latest_final_date: string | null; checked_at: string }>(
    'SELECT first_incomplete_date, latest_final_date, checked_at FROM gsc_data_availability WHERE site_id = ? AND property = ? AND search_type = ? ORDER BY checked_at DESC LIMIT 1',
    [ctx.siteId, property, searchType],
  );
  if (av?.first_incomplete_date) return { date: av.first_incomplete_date, basis: `Search Console data availability checked ${av.checked_at} (first incomplete date)` };
  if (av?.latest_final_date) return { date: addDays(av.latest_final_date, 1), basis: `Search Console data availability checked ${av.checked_at} (day after the latest final date)` };
  const today = dateInZone(ctx.clock.now(), GSC_TIME_ZONE);
  return { date: addDays(today, -(GSC_ASSUMED_INCOMPLETE_DAYS - 1)), basis: `assumption: the last ${GSC_ASSUMED_INCOMPLETE_DAYS - 1} day(s) before today (${GSC_TIME_ZONE}) may still change` };
}

function emptyResult(dataset: string, input: { abs: string; format: 'csv' | 'json'; text: string }, preview: boolean, synthetic: boolean): DataImportResult {
  return {
    dataset,
    file: input.abs,
    format: input.format,
    sha256: sha256(input.text),
    preview,
    synthetic,
    batchId: null,
    rawRef: null,
    status: preview ? 'preview' : 'failed',
    rowsRead: 0,
    accepted: 0,
    rejected: [],
    skippedExisting: 0,
    keptNonSynthetic: 0,
    counts: emptyCounts(),
    dateRange: null,
    warnings: [],
  };
}

/** Store the imported file in the private raw store and return its raw_ref. */
function storeRaw(ctx: AppContext, dataset: string, input: { abs: string; format: string; text: string }): string {
  return ctx.raw.save({ siteId: ctx.siteId, provider: 'import', kind: dataset, payload: { fileName: path.basename(input.abs), format: input.format, sha256: sha256(input.text), bytes: Buffer.byteLength(input.text), content: input.text }, at: ctx.clock.now() });
}

/** True for a dataset name `data import` accepts (own keys only: `__proto__`, `constructor`, `toString`, ... are not datasets). */
export function isImportDataset(dataset: string): boolean {
  return Object.hasOwn(IMPORT_DATASETS, dataset);
}

/** Parse a stored segment key ('country=usa;device=MOBILE;searchAppearance=...'); null when it is not one. */
function parseSegmentKey(key: string): { country?: string; device?: string; searchAppearance?: string } | null {
  const out: { country?: string; device?: string; searchAppearance?: string } = {};
  for (const part of key.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) return null;
    const name = part.slice(0, i);
    const value = part.slice(i + 1);
    if ((name !== 'country' && name !== 'device' && name !== 'searchAppearance') || !value || out[name] !== undefined) return null;
    out[name] = value;
  }
  return out;
}

/** Dates seen per segment shape (sorted), as recorded on an import batch (coverage_json.importScope). */
function datesByShape(rows: ReadonlyArray<{ date: string; shape: string }>): Record<string, string[]> {
  const m = new Map<string, Set<string>>();
  for (const r of rows) {
    let set = m.get(r.shape);
    if (!set) m.set(r.shape, (set = new Set()));
    set.add(r.date);
  }
  return Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, [...v].sort()]));
}

export function importDataset(ctx: AppContext, dataset: string, file: string, opts: DataImportOptions = {}): DataImportResult {
  const def = isImportDataset(dataset) ? IMPORT_DATASETS[dataset] : undefined;
  if (!def) throw new AppError('VALIDATION_FAILED', `Unknown import dataset "${dataset}". Use one of: ${IMPORT_DATASET_NAMES.join(', ')}.`);
  const input = readInput(file, opts.format);
  return def.kind === 'gsc' ? importGsc(ctx, dataset, def, input, opts) : importKeywords(ctx, dataset, def, input, opts);
}

function importGsc(ctx: AppContext, dataset: string, def: GscImportDef, input: { abs: string; format: 'csv' | 'json'; text: string }, opts: DataImportOptions): DataImportResult {
  const property = opts.property ?? ctx.config.google.searchConsoleProperty;
  if (!property) throw new AppError('VALIDATION_FAILED', 'No Search Console property: pass --property or set google.searchConsoleProperty. A property is never guessed.');
  const defaultType = opts.searchType ?? 'web';
  if (!(SEARCH_TYPES as readonly string[]).includes(defaultType)) throw new AppError('VALIDATION_FAILED', `--search-type must be one of ${SEARCH_TYPES.join(', ')}`);
  const parsed = readRecords(input.text, input.format, GSC_ALIASES, opts.unguard, GSC_EXPORT_ALIASES);
  const preview = !!opts.preview || ctx.dryRun;
  const labels = importSynthetic(ctx, parsed, opts, path.basename(input.abs));
  const synthetic = labels.synthetic;
  const result = emptyResult(dataset, input, preview, synthetic);
  result.rowsRead = parsed.records.length;
  const warnings = new Set<string>();
  if (parsed.unknownColumns.length) warnings.add(`Ignored columns: ${parsed.unknownColumns.join(', ')}.`);
  if (parsed.guardNote) warnings.add(parsed.guardNote);
  if (labels.note) warnings.add(labels.note);
  const controlNote = controlCellsNote(parsed.controlCells);
  if (controlNote) warnings.add(controlNote);
  const missingCols = def.required.filter((c) => !parsed.columns.includes(c));
  if (parsed.records.length && missingCols.length) {
    const aggregated = missingCols.includes('date');
    throw new AppError(
      'VALIDATION_FAILED',
      aggregated
        ? `The file has no date column. ${dataset} is stored at daily grain; a Search Console export aggregated over a date range (for example the UI "Pages" or "Queries" export) cannot be imported as if it were one day. Export it with the Date dimension (per day), for example through the Search Console API, Looker Studio, or the BigQuery bulk export.`
        : `The file is missing required column(s): ${missingCols.join(', ')}. Expected: ${def.description}.`,
    );
  }
  const hasValue = (col: string) => parsed.records.some((r) => !!r[col]);
  if (!def.segments && (parsed.columns.includes('country') || parsed.columns.includes('device') || hasValue('segment_key') || hasValue('search_appearance'))) {
    throw new AppError('VALIDATION_FAILED', `${dataset} holds property totals without segments; import country/device/search-appearance breakdowns as gsc-pages rows instead.`);
  }
  // Grains are never mixed: visible query rows are never page or property totals, and page rows are never property totals.
  if (!def.required.includes('query') && hasValue('query')) {
    throw new AppError('VALIDATION_FAILED', `The file has query rows. Visible page/query rows omit anonymized queries and are never ${def.table === 'gsc_page_daily' ? 'page' : 'property'} totals: import the file as gsc-queries. Nothing was imported.`);
  }
  if (!def.required.includes('page') && hasValue('page')) {
    throw new AppError('VALIDATION_FAILED', 'The file has page rows. Page totals are never property totals (Search Console aggregates by page and by property differently): import the file as gsc-pages. Nothing was imported.');
  }
  const fromExport = parsed.exportBasis !== null;
  const fileTypes = [...new Set(parsed.records.map((r) => (r.search_type ? r.search_type : defaultType)))];
  const cutoff = firstIncompleteDate(ctx, property, fileTypes.length === 1 ? fileTypes[0]! : defaultType);
  const today = dateInZone(ctx.clock.now(), GSC_TIME_ZONE);
  type Row = { key: Record<string, SqlValue>; values: Record<string, SqlValue>; date: string; searchType: string; shape: string };
  let exportedNotFinal = 0;
  const rows: Row[] = [];
  const seen = new Map<string, number>();
  parsed.records.forEach((r, i) => {
    const rowNo = input.format === 'csv' ? i + 2 : i + 1;
    const errors: string[] = [];
    if (r.__invalid) errors.push('not an object');
    const date = r.date ?? '';
    if (!isIsoDate(date)) errors.push(`date must be YYYY-MM-DD (got "${date}")`);
    else if (date > today) errors.push(`date ${date} is in the future (${GSC_TIME_ZONE})`);
    const searchType = r.search_type ? r.search_type : defaultType;
    if (!(SEARCH_TYPES as readonly string[]).includes(searchType)) errors.push(`search type must be one of ${SEARCH_TYPES.join(', ')} (got "${searchType}")`);
    const clicks = parseCount(r.clicks, 'clicks', errors);
    const impressions = parseCount(r.impressions, 'impressions', errors);
    if (clicks !== null && impressions !== null && clicks > impressions) errors.push(`clicks (${clicks}) exceed impressions (${impressions})`);
    const position = parseOptionalNumber(r.position, 'position', errors, (n) => n >= 1, 'must be a number >= 1');
    const ctr = parseCtr(r.ctr, errors, warnings);
    const page = r.page ?? '';
    if (def.required.includes('page') && !httpUrl(page)) errors.push(`page must be an absolute http(s) URL (got "${page}")`);
    const query = r.query ?? '';
    if (def.required.includes('query') && !query) errors.push('query is required');
    // The segment: the country/device/search_appearance columns and, when the file states it, its segment_key (they must agree).
    const stated = r.segment_key ? parseSegmentKey(r.segment_key) : {};
    if (stated === null) errors.push(`segment_key must be like "country=usa;device=MOBILE" or "searchAppearance=<value>" (got "${r.segment_key}")`);
    const pick = (column: string | undefined, fromKey: string | undefined, name: string, norm: (v: string) => string): string | null => {
      const a = column ? norm(column) : null;
      const b = fromKey ? norm(fromKey) : null;
      if (a !== null && b !== null && a !== b) errors.push(`${name} "${column}" does not match the segment_key "${r.segment_key}"`);
      return a ?? b;
    };
    const country = pick(r.country, stated?.country, 'country', (v) => v.toLowerCase());
    if (country !== null && !/^[a-z]{3}$/.test(country)) errors.push(`country must be an ISO 3166-1 alpha-3 code as the Search Console API reports it (got "${r.country ?? stated?.country}")`);
    const device = pick(r.device, stated?.device, 'device', (v) => v.toUpperCase());
    if (device !== null && !['DESKTOP', 'MOBILE', 'TABLET'].includes(device)) errors.push(`device must be DESKTOP, MOBILE, or TABLET (got "${r.device ?? stated?.device}")`);
    const searchAppearance = pick(r.search_appearance, stated?.searchAppearance, 'search_appearance', (v) => v);
    if (searchAppearance !== null && /[;=]/.test(searchAppearance)) errors.push(`search_appearance must not contain ";" or "=" (got "${searchAppearance}")`);
    // A file that names the property of a row (a seo-agent export, or any file with a property column): another property's rows are never stored under this one.
    if (r.property && r.property !== property) {
      errors.push(`property "${r.property}" differs from the target property "${property}": the file attributes this row to another Search Console property (pass --property ${r.property} to import it under that property)`);
    }
    const exportedFinal = fromExport ? parseFlag(r.is_final) : null;
    if (exportedFinal === 'invalid') errors.push(`is_final must be 0 or 1 (got "${r.is_final}")`);
    if (parseFlag(r.is_synthetic) === 'invalid') errors.push(`is_synthetic must be 0 or 1 (got "${r.is_synthetic}")`);
    if (errors.length) {
      result.rejected.push({ row: rowNo, errors });
      return;
    }
    const metrics = { clicks, impressions, ctr, position };
    // A row the exporting workspace had not finalized keeps its not-final values: it never becomes final here.
    const isFinal = date < cutoff.date && exportedFinal !== 0 ? 1 : 0;
    let key: Record<string, SqlValue>;
    let values: Record<string, SqlValue>;
    let segmentKey = '';
    if (def.table === 'gsc_property_daily') {
      key = { property, search_type: searchType, date };
      values = { date_tz: GSC_TIME_ZONE, ...metrics, aggregation_type: def.aggregationType, is_final: isFinal };
    } else {
      segmentKey = segmentKeyOf({ country, device, searchAppearance });
      key = def.table === 'gsc_page_daily' ? { property, search_type: searchType, date, page, segment_key: segmentKey } : { property, search_type: searchType, date, page, query, segment_key: segmentKey };
      values = { date_tz: GSC_TIME_ZONE, country, device, ...(def.table === 'gsc_page_daily' ? { search_appearance: searchAppearance } : {}), ...metrics, aggregation_type: def.aggregationType, is_final: isFinal };
    }
    const k = JSON.stringify(VERSIONED_KEYS[def.table].map((c) => key[c] ?? null));
    const dupOf = seen.get(k);
    if (dupOf !== undefined) {
      result.rejected.push({ row: rowNo, errors: [`duplicate of row ${dupOf} (same ${VERSIONED_KEYS[def.table].join(', ')}); rows are never summed`] });
      return;
    }
    seen.set(k, rowNo);
    if (exportedFinal === 0) exportedNotFinal++;
    rows.push({ key, values, date, searchType, shape: segmentShapeOf(segmentKey) });
  });
  const searchTypes = [...new Set(rows.map((r) => r.searchType))];
  if (searchTypes.length > 1) {
    throw new AppError('VALIDATION_FAILED', `The file mixes search types (${searchTypes.join(', ')}). Import one search type per file (each is a separate dataset slice and is never summed with another).`);
  }
  result.accepted = rows.length;
  if (rows.some((r) => r.values.is_final === 0 && r.date >= cutoff.date)) warnings.add(`Rows on or after ${cutoff.date} are stored as not final (${cutoff.basis}); reports exclude them from totals and comparisons.`);
  if (exportedNotFinal) warnings.add(`${exportedNotFinal} row(s) were not final in the exporting workspace (is_final = 0): they are stored as not final, since their values may still change at the source.`);
  const segmentRows = rows.filter((r) => r.shape !== '').length;
  if (segmentRows) warnings.add(`${segmentRows} row(s) are a country/device/search-appearance breakdown: they are stored in their own segment and are never added to the no-segment ${def.table === 'gsc_page_daily' ? 'page' : 'page/query'} rows.`);
  if (!opts.complete) warnings.add('Completeness not asserted (--complete): the batch is flagged as possibly incomplete, so dates or pages without rows are never read as zeros, and a Search Console sync re-requests dates known only from such imports (within its history window).');
  if (rows.length) {
    const dates = rows.map((r) => r.date).sort();
    result.dateRange = { start: dates[0]!, end: dates[dates.length - 1]! };
  }
  result.warnings = [...warnings];
  if (!rows.length) {
    if (!preview) result.status = 'failed';
    if (!result.rejected.length && !parsed.records.length) result.warnings.push('The file has no data rows; nothing was imported.');
    return result;
  }
  if (result.rejected.length && !opts.skipInvalid) {
    result.status = preview ? 'preview' : 'failed';
    result.warnings.push(`${result.rejected.length} invalid row(s): nothing was imported. Fix them, or pass --skip-invalid to import the ${rows.length} valid row(s) as a partial batch.`);
    return result;
  }
  const keyCols = VERSIONED_KEYS[def.table];
  const existingCurrent = (key: Record<string, SqlValue>): { source: string | null; is_synthetic: number } | null =>
    ctx.db.get<{ source: string | null; is_synthetic: number }>(
      `SELECT b.source, t.is_synthetic FROM ${def.table} t LEFT JOIN ingestion_batches b ON b.id = t.batch_id WHERE t.site_id = ? AND t.is_current = 1 AND ${keyCols.map((c) => `t.${c} = ?`).join(' AND ')}`,
      [ctx.siteId, ...keyCols.map((c) => key[c] ?? null)],
    ) ?? null;
  // Which current rows the file's row may not supersede: a non-synthetic (live) row is never replaced by a
  // synthetic one, even with --replace; a row collected by a Google sync is replaced only with --replace.
  const keepReason = (key: Record<string, SqlValue>): 'non_synthetic' | 'google_sync' | null => {
    const cur = existingCurrent(key);
    if (!cur) return null;
    if (synthetic && cur.is_synthetic !== 1) return 'non_synthetic';
    if (cur.source && cur.source !== 'import' && !opts.replace) return 'google_sync';
    return null;
  };
  const keptNote = (n: number) => `${n} row(s) were kept: their current row is non-synthetic (live) data, and a synthetic row never supersedes live data (also not with --replace).`;
  if (preview) {
    for (const r of rows) {
      const why = keepReason(r.key);
      if (why === 'non_synthetic') result.keptNonSynthetic++;
      else if (why === 'google_sync') result.skippedExisting++;
    }
    if (result.keptNonSynthetic) result.warnings.push(keptNote(result.keptNonSynthetic));
    return result;
  }
  const rawRef = storeRaw(ctx, dataset, input);
  result.rawRef = rawRef;
  const batchId = startBatch(ctx, {
    source: 'import',
    dataset: def.table,
    property,
    dateStart: result.dateRange!.start,
    dateEnd: result.dateRange!.end,
    // `type` is the Search Console search type (as the GSC sync records it), so coverage checks scope this batch correctly.
    request: { type: searchTypes[0], importedDataset: dataset, file: path.basename(input.abs), sha256: result.sha256, format: input.format, aggregationType: def.aggregationType, completeness: opts.complete ? 'owner_asserted' : 'not_asserted', replace: !!opts.replace, rawRef },
    transformationVersion: DATA_IMPORT_VERSION,
    synthetic,
  });
  result.batchId = batchId;
  const counts = emptyCounts();
  const meta = { batchId, collectedAt: ctx.clock.now().toISOString(), transformationVersion: DATA_IMPORT_VERSION, isSynthetic: synthetic };
  try {
    ctx.db.transaction(() => {
      for (const r of rows) {
        const why = keepReason(r.key);
        if (why === 'non_synthetic') {
          result.keptNonSynthetic++;
          continue;
        }
        if (why === 'google_sync') {
          result.skippedExisting++;
          continue;
        }
        tally(counts, upsertRevision(ctx.db, def.table, ctx.siteId, r.key, r.values, meta));
      }
    });
  } catch (err) {
    finishBatch(ctx, batchId, { status: 'failed', counts, apiPages: 0, truncated: false, rawRefs: [rawRef], error: err });
    throw err;
  }
  if (result.skippedExisting) result.warnings.push(`${result.skippedExisting} row(s) already collected by a Google sync were kept (pass --replace to supersede them with the file's values).`);
  if (result.keptNonSynthetic) result.warnings.push(keptNote(result.keptNonSynthetic));
  const status = result.rejected.length ? 'partial' : 'succeeded';
  // A partial batch (invalid rows skipped) is not complete for its range, whatever the owner asserted.
  if (opts.complete && status === 'partial') {
    result.warnings.push(`Completeness (--complete) was NOT applied: ${result.rejected.length} invalid row(s) were skipped, so the file is not complete for its date range and dates or pages without rows stay unknown, not zero. Fix the rows and re-import with --complete.`);
  }
  finishBatch(ctx, batchId, {
    status,
    counts,
    apiPages: 0,
    truncated: !opts.complete,
    coverage: {
      warnings: [`Owner-supplied import of ${path.basename(input.abs)}${opts.complete ? ' (completeness asserted by the owner)' : '; completeness not asserted: absent rows are unknown, not zero'}.`, ...(result.rejected.length ? [`${result.rejected.length} invalid row(s) were skipped`] : [])],
      finality: cutoff,
      rejectedRows: result.rejected.slice(0, 50),
      skippedExisting: result.skippedExisting,
      keptNonSynthetic: result.keptNonSynthetic,
      // Every date the file had a valid row for, per segment shape (rows written, unchanged, or kept from a Google sync):
      // coverage uses it, so a re-import that writes no new revision still covers what it saw (src/seo/coverage.ts).
      importScope: { datesByShape: datesByShape(rows) },
    },
    metadata: { importedDataset: dataset, file: path.basename(input.abs), sha256: result.sha256, rowsRead: result.rowsRead },
    rawRefs: [rawRef],
  });
  result.counts = counts;
  result.status = status;
  return result;
}

function importKeywords(ctx: AppContext, dataset: string, _def: KeywordImportDef, input: { abs: string; format: 'csv' | 'json'; text: string }, opts: DataImportOptions): DataImportResult {
  const parsed = readRecords(input.text, input.format, KEYWORD_ALIASES, opts.unguard);
  const preview = !!opts.preview || ctx.dryRun;
  const labels = importSynthetic(ctx, parsed, opts, path.basename(input.abs));
  const synthetic = labels.synthetic;
  const result = emptyResult(dataset, input, preview, synthetic);
  result.rowsRead = parsed.records.length;
  const warnings: string[] = [];
  if (parsed.unknownColumns.length) warnings.push(`Ignored columns: ${parsed.unknownColumns.join(', ')}.`);
  if (parsed.guardNote) warnings.push(parsed.guardNote);
  if (labels.note) warnings.push(labels.note);
  const controlNote = controlCellsNote(parsed.controlCells);
  if (controlNote) warnings.push(controlNote);
  if (parsed.records.length && !parsed.columns.includes('keyword')) throw new AppError('VALIDATION_FAILED', 'The file has no keyword column (keyword, term, or query).');
  const provider = `import:${(opts.provider ?? 'file').trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '_') || 'file'}`;
  type Row = { keyword: string; language: string | null; intent: string | null; branded: 0 | 1 | null; volume: number | null; location: number | null };
  const rows: Row[] = [];
  const seen = new Map<string, number>();
  parsed.records.forEach((r, i) => {
    const rowNo = input.format === 'csv' ? i + 2 : i + 1;
    const errors: string[] = [];
    if (r.__invalid) errors.push('not an object');
    const keyword = (r.keyword ?? '').replace(/\s+/g, ' ').trim();
    if (!keyword) errors.push('keyword is required');
    else if (keyword.length > 300) errors.push('keyword is longer than 300 characters');
    const language = r.language ? r.language.trim().toLowerCase().replace(/_/g, '-') : null;
    if (language !== null && !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(language)) errors.push(`language must be a BCP 47 code such as "en" or "et" (got "${r.language}")`);
    const intent = r.intent ? r.intent.trim().toLowerCase() : null;
    if (intent !== null && !(INTENTS as readonly string[]).includes(intent)) errors.push(`intent must be one of ${INTENTS.join(', ')} (got "${r.intent}")`);
    const branded = parseBool(r.is_branded);
    if (branded === 'invalid') errors.push(`branded must be yes/no (got "${r.is_branded}")`);
    const volume = r.search_volume ? parseCount(r.search_volume, 'search_volume', errors) : null;
    const location = parseOptionalNumber(r.location_code, 'location_code', errors, (n) => Number.isInteger(n) && n > 0, 'must be a positive integer');
    if (location !== null && volume === null) errors.push('location_code only applies to a search_volume value');
    if (parseFlag(r.is_synthetic) === 'invalid') errors.push(`is_synthetic must be 0 or 1 (got "${r.is_synthetic}")`);
    if (errors.length) {
      result.rejected.push({ row: rowNo, errors });
      return;
    }
    const k = JSON.stringify([keyword.normalize('NFC').toLowerCase(), language, location]);
    const dupOf = seen.get(k);
    if (dupOf !== undefined) {
      result.rejected.push({ row: rowNo, errors: [`duplicate of row ${dupOf} (same keyword, language, and location)`] });
      return;
    }
    seen.set(k, rowNo);
    rows.push({ keyword, language, intent, branded: branded === 'invalid' ? null : branded, volume, location });
  });
  result.accepted = rows.length;
  result.warnings = warnings;
  if (!rows.length) {
    if (!preview) result.status = 'failed';
    return result;
  }
  if (result.rejected.length && !opts.skipInvalid) {
    result.status = preview ? 'preview' : 'failed';
    result.warnings.push(`${result.rejected.length} invalid row(s): nothing was imported. Fix them, or pass --skip-invalid to import the ${rows.length} valid row(s).`);
    return result;
  }
  if (preview) return result;
  const rawRef = storeRaw(ctx, dataset, input);
  result.rawRef = rawRef;
  const now = ctx.clock.now().toISOString();
  const day = now.slice(0, 10);
  const batchId = startBatch(ctx, {
    source: 'import',
    dataset: 'keywords',
    property: provider,
    dateStart: day,
    dateEnd: day,
    request: { importedDataset: dataset, file: path.basename(input.abs), sha256: result.sha256, format: input.format, provider, rawRef },
    transformationVersion: DATA_IMPORT_VERSION,
    synthetic,
  });
  result.batchId = batchId;
  const hasTv = ctx.db.all<{ name: string }>('PRAGMA table_info(keyword_metrics)').some((c) => c.name === 'transformation_version');
  const expires = new Date(ctx.clock.now().getTime() + IMPORTED_VOLUME_TTL_DAYS * 86_400_000).toISOString();
  const stats = { created: 0, matchedExisting: 0, volumes: 0 };
  const counts = emptyCounts();
  try {
    ctx.db.transaction(() => {
      for (const r of rows) {
        const before = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM keywords WHERE site_id = ?', [ctx.siteId])?.n ?? 0;
        const id = upsertKeyword(ctx, { keyword: r.keyword, language: r.language, origin: 'import' });
        const after = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM keywords WHERE site_id = ?', [ctx.siteId])?.n ?? 0;
        if (after > before) stats.created++;
        else stats.matchedExisting++;
        counts.received++;
        if (r.intent !== null) ctx.db.run(`UPDATE keywords SET intent = ?, intent_source = 'manual' WHERE id = ? AND site_id = ?`, [r.intent, id, ctx.siteId]);
        if (r.branded !== null) ctx.db.run('UPDATE keywords SET is_branded = ? WHERE id = ? AND site_id = ?', [r.branded, id, ctx.siteId]);
        if (r.volume !== null) {
          const cols = ['id', 'site_id', 'keyword_id', 'provider', 'location_code', 'language_code', 'search_volume', 'is_sandbox', 'raw_ref', 'collected_at', 'expires_at', ...(hasTv ? ['transformation_version'] : [])];
          const vals: SqlValue[] = [newId('kwm'), ctx.siteId, id, provider, r.location, r.language, r.volume, 0, rawRef, now, expires, ...(hasTv ? [DATA_IMPORT_VERSION] : [])];
          // The same estimate recorded twice at the same instant is one observation (unique grain), never a duplicate.
          const res = ctx.db.run(`INSERT INTO keyword_metrics (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT DO NOTHING`, vals);
          if (res.changes > 0) stats.volumes++;
        }
      }
    });
  } catch (err) {
    finishBatch(ctx, batchId, { status: 'failed', counts, apiPages: 0, truncated: false, rawRefs: [rawRef], error: err });
    throw err;
  }
  counts.newRevisions = stats.created;
  counts.unchanged = stats.matchedExisting;
  const status = result.rejected.length ? 'partial' : 'succeeded';
  finishBatch(ctx, batchId, {
    status,
    counts,
    apiPages: 0,
    truncated: false,
    coverage: { warnings: [`Owner-supplied keyword list ${path.basename(input.abs)}; search volumes are ${provider} estimates, not exact demand.`], rejectedRows: result.rejected.slice(0, 50) },
    metadata: { importedDataset: dataset, file: path.basename(input.abs), sha256: result.sha256, rowsRead: result.rowsRead, keywords: stats },
    rawRefs: [rawRef],
  });
  result.counts = counts;
  result.keywords = stats;
  result.status = status;
  return result;
}
