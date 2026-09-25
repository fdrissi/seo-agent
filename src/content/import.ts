import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../app/context.js';
import { AppError, ValidationError } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import { stripControlChars } from '../core/terminal.js';
import { ensureSource, upsertSignal } from './store.js';
import { detectInstructionLikeText, redactPhoneNumbers } from './text.js';
import { DEFAULT_LIMITATIONS, SIGNAL_TYPES, type ContentSignal, type SignalInput } from './types.js';

/**
 * Manual customer-question import (`content import <file>`), CSV or JSON.
 *
 * Accepted columns/fields (case-insensitive): text|question (required),
 * type|signal_type, url|source_url, posted_at|date, count|frequency, notes,
 * source. Imported text is untrusted data: instruction-like text is flagged
 * (never obeyed) and email addresses / phone numbers are removed before
 * storage so they cannot reach a model. C0/C1 control characters (e.g. the
 * ESC of an ANSI escape sequence) are replaced with spaces before validation,
 * so they are never stored or printed. Columns and JSON fields that are not
 * accepted (including names such as `constructor` or `__proto__`) are
 * reported as ignored, never guessed.
 */

export const MAX_IMPORT_BYTES = 2_000_000;
export const MAX_IMPORT_ROWS = 2_000;

const rowSchema = z.object({
  text: z.string().trim().min(3, 'text must have at least 3 characters').max(500, 'text must be at most 500 characters'),
  type: z.enum(SIGNAL_TYPES).default('question'),
  url: z
    .string()
    .trim()
    .nullable()
    .default(null)
    .refine((u) => u === null || u === '' || /^https?:\/\/[^\s]+$/i.test(u), 'url must be an http(s) URL'),
  postedAt: z
    .string()
    .trim()
    .nullable()
    .default(null)
    .refine((d) => d === null || d === '' || !Number.isNaN(Date.parse(d)), 'posted_at must be an ISO date'),
  count: z.coerce.number().int().min(1).nullable().default(null),
  notes: z.string().trim().max(1000).nullable().default(null),
  source: z.string().trim().max(200).nullable().default(null),
});

export interface ImportRowError {
  row: number;
  errors: string[];
}

export interface ImportResult {
  file: string;
  format: 'csv' | 'json';
  rowsRead: number;
  accepted: number;
  rejected: ImportRowError[];
  redactions: number;
  instructionLikeRows: number[];
  signals: ContentSignal[];
  preview: boolean;
  /** Columns (CSV) or fields (JSON) that are not accepted and were ignored, as written in the file. */
  ignoredColumns: string[];
}

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, embedded newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (inQuotes) throw new ValidationError('CSV has an unterminated quoted field');
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const ALIASES: Record<string, string> = {
  text: 'text',
  question: 'text',
  type: 'type',
  signal_type: 'type',
  url: 'url',
  source_url: 'url',
  posted_at: 'postedAt',
  postedat: 'postedAt',
  date: 'postedAt',
  count: 'count',
  frequency: 'count',
  notes: 'notes',
  source: 'source',
};

/**
 * The accepted field for a column name, or undefined. Own properties only: a
 * column named after an Object.prototype member (`constructor`, `__proto__`,
 * `toString`, ...) is not a known column.
 */
function aliasOf(name: string): string | undefined {
  const k = name.trim().toLowerCase();
  return Object.hasOwn(ALIASES, k) ? ALIASES[k] : undefined;
}

/** Untrusted text as stored: control characters (ESC, BEL, a lone CR, ...) become spaces; newlines and tabs are kept. */
function cleanValue(v: unknown): unknown {
  return typeof v === 'string' ? stripControlChars(v.replace(/\r\n/g, '\n')) : v;
}

function normalizeRecord(rec: Record<string, unknown>, ignored?: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(rec)) {
    const key = aliasOf(k);
    if (!key) {
      ignored?.add(k);
      continue;
    }
    const v = cleanValue(raw);
    out[key] = typeof v === 'string' && v.trim() === '' ? null : v;
  }
  return out;
}

/** Parsed import rows (normalized field names) and the columns/fields that were ignored. */
export function parseImportRecords(content: string, format: 'csv' | 'json'): { records: Array<Record<string, unknown>>; ignoredColumns: string[] } {
  const ignored = new Set<string>();
  if (format === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new ValidationError(`Invalid JSON: ${(err as Error).message}`);
    }
    const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { questions?: unknown }).questions) ? (parsed as { questions: unknown[] }).questions : null;
    if (!list) throw new ValidationError('JSON import must be an array, or an object with a "questions" array');
    const records = list.map((x) => (typeof x === 'string' ? { text: cleanValue(x) } : x && typeof x === 'object' && !Array.isArray(x) ? normalizeRecord(x as Record<string, unknown>, ignored) : { text: '' }));
    return { records, ignoredColumns: [...ignored] };
  }
  const rows = parseCsv(content);
  if (!rows.length) return { records: [], ignoredColumns: [] };
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  if (!header.some((h) => aliasOf(h) === 'text')) throw new ValidationError('CSV header must include a "text" or "question" column');
  const records = rows.slice(1).map((r) => normalizeRecord(Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])), ignored));
  // A column is reported even when the file has no data rows.
  for (const h of header) if (h !== '' && !aliasOf(h)) ignored.add(h);
  return { records, ignoredColumns: [...ignored] };
}

export function parseImportContent(content: string, format: 'csv' | 'json'): Array<Record<string, unknown>> {
  return parseImportRecords(content, format).records;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** Remove email addresses and phone numbers (dates, date ranges, and numeric ranges are kept). */
export function scrubPersonalData(text: string): { text: string; redactions: number } {
  let n = 0;
  const noEmail = text.replace(EMAIL_RE, () => {
    n++;
    return '[email removed]';
  });
  const phones = redactPhoneNumbers(noEmail);
  return { text: phones.text, redactions: n + phones.count };
}

export function importManualQuestions(ctx: AppContext, file: string, opts: { format?: 'csv' | 'json'; preview?: boolean } = {}): ImportResult {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    throw new AppError('NOT_FOUND', `Import file not found: ${file}`);
  }
  if (size > MAX_IMPORT_BYTES) throw new ValidationError(`Import file is larger than ${MAX_IMPORT_BYTES} bytes`);
  const content = readFileSync(file, 'utf8');
  const format = opts.format ?? (path.extname(file).toLowerCase() === '.json' ? 'json' : 'csv');
  const { records, ignoredColumns } = parseImportRecords(content, format);
  if (records.length > MAX_IMPORT_ROWS) throw new ValidationError(`Import has ${records.length} rows; the maximum is ${MAX_IMPORT_ROWS}`);

  const now = ctx.clock.now().toISOString();
  const rejected: ImportRowError[] = [];
  const inputs: SignalInput[] = [];
  const instructionLikeRows: number[] = [];
  let redactions = 0;
  records.forEach((rec, idx) => {
    const parsed = rowSchema.safeParse(rec);
    if (!parsed.success) {
      rejected.push({ row: idx + 1, errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'row'}: ${i.message}`) });
      return;
    }
    const r = parsed.data;
    const scrub = scrubPersonalData(r.text);
    redactions += scrub.redactions;
    const injected = detectInstructionLikeText(scrub.text);
    if (injected.length) instructionLikeRows.push(idx + 1);
    inputs.push({
      origin: 'manual',
      signalType: r.type,
      text: scrub.text,
      url: r.url || null,
      postedAt: r.postedAt || null,
      collectionWindow: { start: null, end: r.postedAt ? r.postedAt.slice(0, 10) : now.slice(0, 10), timeZone: null, description: `Manual import ${path.basename(file)} on ${now.slice(0, 10)}${r.source ? ` (source: ${r.source})` : ''}.` },
      engagement: {
        kind: 'manual',
        reportedCount: r.count,
        notes: r.notes,
        importSource: r.source,
        importRow: idx + 1,
        ...(injected.length ? { instructionLikeText: injected } : {}),
        ...(scrub.redactions ? { personalDataRemoved: scrub.redactions } : {}),
      },
      limitations: DEFAULT_LIMITATIONS.manual + (r.count ? ` Reported frequency (${r.count}) is as supplied by the importer and unverified.` : ''),
    });
  });

  const signals: ContentSignal[] = [];
  if (!opts.preview && inputs.length) {
    ctx.db.transaction(() => {
      const sourceId = ensureSource(ctx.db, {
        siteId: ctx.siteId,
        sourceType: 'manual_import',
        trustClass: 'user_reported',
        url: `manual-import://${path.basename(file)}`,
        title: `Manual question import ${path.basename(file)}`,
        contentHash: sha256(content),
        retrievedAt: now,
        metadata: { rows: records.length, accepted: inputs.length, format },
      });
      for (const input of inputs) signals.push(upsertSignal(ctx.db, ctx.siteId, { ...input, sourceId }, now));
    });
  }
  return { file: path.basename(file), format, rowsRead: records.length, accepted: inputs.length, rejected, redactions, instructionLikeRows, signals, preview: !!opts.preview, ignoredColumns };
}
