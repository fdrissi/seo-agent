import { ValidationError } from '../core/errors.js';
import { parseCsv } from '../content/import.js';

/**
 * CSV helpers for `data export` / `data import` (RFC 4180).
 *
 * Spreadsheet formula guard (export): a TEXT cell that starts with `=`, `+`,
 * `-`, `@`, a tab, or a carriage return is prefixed with `'` so a spreadsheet
 * never evaluates untrusted text (queries, page URLs, titles) as a formula.
 * A text cell that already starts with `'` is prefixed too, so the guard is
 * reversible: `unguardCell` removes exactly the one apostrophe the guard
 * added, and a stored `'-x` round-trips as `'-x` (exported `''-x`). Numbers
 * are never altered.
 *
 * Unguarding is only correct for files this application wrote: a third-party
 * file (a Search Console or keyword-tool export) is never guarded, and a real
 * query or keyword may start with an apostrophe. `parseCsvRecords` therefore
 * unguards only when asked to, or (by default) when the file carries the
 * export marker comment (`# seo-agent data-export@...`, see EXPORT_MARKER).
 */

const FORMULA_START = /^[=+\-@\t\r]/;
/** What the guard prefixes: a formula start, or an apostrophe (so the prefix is always removable). */
const GUARDED_START = /^[=+\-@\t\r']/;

/**
 * Leading comment that identifies a CSV written by `data export`
 * (`# seo-agent data-export@1 ...`). parseCsvRecords skips leading `#` lines;
 * a file with this marker is unguarded on import by default.
 */
export const EXPORT_MARKER = 'seo-agent data-export@';

export type CellValue = string | number | null | undefined;

function guard(v: string): string {
  return GUARDED_START.test(v) ? `'${v}` : v;
}

/** Remove the formula-guard apostrophe that `csvCell` added (exact for files this application wrote). */
export function unguardCell(v: string): string {
  return v.length > 1 && v.startsWith("'") && GUARDED_START.test(v.slice(1)) ? v.slice(1) : v;
}

export function csvCell(v: CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  const s = guard(v);
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: readonly string[], rows: ReadonlyArray<Record<string, CellValue>>): string {
  const lines = [columns.map((c) => csvCell(c)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** Leading lines starting with '#' (comments, e.g. a SYNTHETIC fixture label) before the header row. */
export function leadingComments(text: string): string[] {
  const out: string[] = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (line.startsWith('#')) out.push(line.slice(1).trim());
    else if (line.trim() === '') continue;
    else break;
  }
  return out;
}

/** True when the CSV carries the `data export` marker comment (EXPORT_MARKER). */
export function hasExportMarker(text: string): boolean {
  return leadingComments(text).some((c) => c.startsWith(EXPORT_MARKER));
}

export interface ParseCsvOptions {
  /**
   * Remove the export formula guard from every cell: `true` always, `false`
   * never, or a function deciding from the (trimmed, lower-cased) header and
   * the leading comments. Default: only when the file has the export marker.
   */
  unguard?: boolean | ((header: readonly string[], comments: readonly string[]) => boolean);
}

export interface ParsedCsv {
  header: string[];
  records: Array<Record<string, string>>;
  /** Whether the formula guard was removed from the cells. */
  unguarded: boolean;
  /** Cells that start with an apostrophe followed by a guarded character (what a formula guard would look like). */
  guardLikeCells: number;
}

/** Parse CSV text into records keyed by the (trimmed, lower-cased) header. Leading '#' comment lines are skipped. */
export function parseCsvRecords(text: string, opts: ParseCsvOptions = {}): ParsedCsv {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let skip = 0;
  while (skip < lines.length && (lines[skip]!.startsWith('#') || lines[skip]!.trim() === '')) skip++;
  const rows = parseCsv(lines.slice(skip).join('\n'));
  if (!rows.length) return { header: [], records: [], unguarded: false, guardLikeCells: 0 };
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const dup = header.find((h, i) => h !== '' && header.indexOf(h) !== i);
  if (dup) throw new ValidationError(`CSV header repeats the column "${dup}"`);
  const comments = leadingComments(text);
  const u = opts.unguard;
  const unguard = typeof u === 'function' ? u(header, comments) : u ?? comments.some((c) => c.startsWith(EXPORT_MARKER));
  let guardLikeCells = 0;
  const cell = (v: string): string => {
    const plain = unguardCell(v);
    if (plain !== v) guardLikeCells++;
    return unguard ? plain : v;
  };
  const records = rows.slice(1).map((r) => {
    if (r.length > header.length && r.slice(header.length).some((x) => x.trim() !== '')) throw new ValidationError(`CSV row has more fields than the header (${r.length} > ${header.length})`);
    return Object.fromEntries(header.map((h, i) => [h, cell(r[i] ?? '')]));
  });
  return { header, records, unguarded: unguard, guardLikeCells };
}
