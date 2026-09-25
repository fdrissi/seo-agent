import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../app/context.js';
import { AppError } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import { recordAudit } from '../database/audit.js';
import type { Db } from '../database/db.js';
import type { GeneratedNote } from '../obsidian/types.js';
import { isWithin, safeFileSegment, safeResolve } from '../security/paths.js';
import { redact } from '../security/redact.js';
import { reportTitle } from './render.js';
import type { Report, ReportKind } from './model.js';

/**
 * Append-only report storage.
 *
 * - Files: <reportsDir>/<site>/<kind>/<start>_<end>-<report id>.{md,json},
 *   created with the exclusive 'wx' flag so an existing report is never
 *   overwritten. A re-run always gets a new report id and new files.
 *   `reportsDir` is `<workspace>/reports` unless workspace.json relocates it
 *   (`paths` block, src/config/paths.ts).
 * - Rows: `reports` table (UPDATE is blocked by a trigger in migration 0009).
 *   `markdown_path` / `json_path` are POSIX paths relative to `reportsDir`
 *   (`<site>/<kind>/<file>`), so a relocated reports folder keeps working.
 *   Rows written before this layout hold workspace-root-relative paths
 *   (`reports/<site>/<kind>/<file>`); they stay readable (see
 *   `reportFileCandidates`). Rows are never rewritten (append-only).
 * - Vault: a GeneratedNote per report ('07 Reports/Weekly', '07 Reports/Monthly',
 *   baseline under '07 Reports') for the integration phase to write via VaultWriter.
 */

export interface StoredReport {
  id: string;
  kind: ReportKind;
  markdownPath: string;
  jsonPath: string;
  /**
   * Display paths: POSIX paths relative to the workspace root when the
   * reports folder is inside the workspace (the default layout, e.g.
   * `reports/<site>/weekly/<file>.md`), otherwise the absolute path of the
   * relocated file. Not the value stored in the reports table.
   */
  relMarkdownPath: string;
  relJsonPath: string;
  /** POSIX paths relative to `paths.reportsDir`, exactly as stored in the reports table. */
  storedMarkdownPath: string;
  storedJsonPath: string;
  contentHash: string;
  generatedAt: string;
  isSynthetic: boolean;
}

export interface ReportRow {
  id: string;
  site_id: string;
  kind: string;
  period_start: string | null;
  period_end: string | null;
  job_id: string | null;
  markdown_path: string | null;
  json_path: string | null;
  content_hash: string;
  summary_json: string | null;
  is_synthetic: number;
  generated_at: string;
}

export function reportFileBase(report: Pick<Report, 'id' | 'period'>): string {
  return safeFileSegment(`${report.period.start}_${report.period.end}-${report.id}`, 160);
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Path of a report file as stored in the reports table: relative to the reports folder. */
function storedPath(ctx: Pick<AppContext, 'paths'>, abs: string): string {
  return toPosix(path.relative(ctx.paths.reportsDir, abs));
}

/** Workspace-relative display path, or the absolute path when the reports folder was relocated outside the workspace. */
function displayPath(ctx: Pick<AppContext, 'paths'>, abs: string): string {
  return isWithin(ctx.paths.root, abs) ? toPosix(path.relative(ctx.paths.root, abs)) : abs;
}

const LEGACY_PREFIX = 'reports/';

/**
 * Absolute locations a stored report path may refer to, in the order they are
 * tried. Every candidate is resolved with safeResolve (absolute paths,
 * traversal, and symlink escapes are rejected):
 * 1. `<reportsDir>/<rel>` - the current layout (relative to the reports folder);
 * 2. legacy rows (`reports/<site>/...`, relative to the workspace root):
 *    `<workspace>/reports/<site>/...`, where they were written;
 * 3. legacy rows whose files were moved along with a relocated reports folder:
 *    `<reportsDir>/<site>/...`.
 */
export function reportFileCandidates(ctx: Pick<AppContext, 'paths'>, rel: string): string[] {
  const out = [safeResolve(ctx.paths.reportsDir, rel)];
  if (rel.startsWith(LEGACY_PREFIX) && rel.length > LEGACY_PREFIX.length) {
    const inner = rel.slice(LEGACY_PREFIX.length);
    out.push(safeResolve(path.join(ctx.paths.root, 'reports'), inner));
    out.push(safeResolve(ctx.paths.reportsDir, inner));
  }
  return [...new Set(out)];
}

export function persistReport(ctx: AppContext, report: Report, rendered: { markdown: string; json: string }): StoredReport {
  if (report.siteId !== ctx.siteId) throw new AppError('VALIDATION_FAILED', `Report site ${report.siteId} does not match context site ${ctx.siteId}`);
  mkdirSync(ctx.paths.reportsDir, { recursive: true, mode: 0o700 });
  const dir = safeResolve(ctx.paths.reportsDir, `${report.siteId}/${report.kind}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = reportFileBase(report);
  const md = safeResolve(dir, `${base}.md`);
  const js = safeResolve(dir, `${base}.json`);
  if (existsSync(md) || existsSync(js)) throw new AppError('CONFLICT', `Report files already exist for ${report.id}; past reports are never rewritten.`);
  const contentHash = sha256(`${rendered.markdown}\n${rendered.json}`);
  writeFileSync(md, rendered.markdown, { flag: 'wx', mode: 0o600 });
  try {
    writeFileSync(js, rendered.json, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    rmSync(md, { force: true });
    throw err;
  }
  // Stored relative to the reports folder (never to the workspace root), so a relocated folder resolves.
  const relMd = storedPath(ctx, md);
  const relJs = storedPath(ctx, js);
  try {
    ctx.db.transaction(() => {
      const job = report.jobId ? ctx.db.get<{ id: string }>('SELECT id FROM jobs WHERE id = ? AND site_id = ?', [report.jobId, ctx.siteId]) : undefined;
      ctx.db.run(
        `INSERT INTO reports (id, site_id, kind, period_start, period_end, job_id, markdown_path, json_path, content_hash, summary_json, is_synthetic, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [report.id, report.siteId, report.kind, report.period.start, report.period.end, job?.id ?? null, relMd, relJs, contentHash, JSON.stringify(redact(report.summary)), report.isSynthetic ? 1 : 0, report.generatedAt],
      );
      recordAudit(ctx.db, {
        siteId: ctx.siteId,
        actor: 'system',
        eventType: 'report.generated',
        subjectType: 'report',
        subjectId: report.id,
        details: { kind: report.kind, period: { start: report.period.start, end: report.period.end }, contentHash, isSynthetic: report.isSynthetic, jobId: report.jobId },
        at: new Date(report.generatedAt),
      });
    });
  } catch (err) {
    // Files were never recorded: remove them so the store and the table stay consistent.
    rmSync(md, { force: true });
    rmSync(js, { force: true });
    throw err;
  }
  return {
    id: report.id,
    kind: report.kind,
    markdownPath: md,
    jsonPath: js,
    relMarkdownPath: displayPath(ctx, md),
    relJsonPath: displayPath(ctx, js),
    storedMarkdownPath: relMd,
    storedJsonPath: relJs,
    contentHash,
    generatedAt: report.generatedAt,
    isSynthetic: report.isSynthetic,
  };
}

export function listReports(db: Db, siteId: string, opts: { kind?: ReportKind; limit?: number } = {}): ReportRow[] {
  return db.all<ReportRow>(
    `SELECT * FROM reports WHERE site_id = ? AND (? IS NULL OR kind = ?) ORDER BY generated_at DESC, id DESC LIMIT ?`,
    [siteId, opts.kind ?? null, opts.kind ?? null, opts.limit ?? 50],
  );
}

export function latestReport(db: Db, siteId: string, kind: ReportKind): ReportRow | undefined {
  return listReports(db, siteId, { kind, limit: 1 })[0];
}

export function getReport(db: Db, siteId: string, id: string): ReportRow | undefined {
  return db.get<ReportRow>('SELECT * FROM reports WHERE site_id = ? AND id = ?', [siteId, id]);
}

/**
 * Absolute path of a stored report file: resolved inside the reports folder
 * (`paths.reportsDir`, which workspace.json may relocate); legacy
 * workspace-root-relative rows are still found. Traversal is rejected.
 */
export function resolveReportFile(ctx: Pick<AppContext, 'paths'>, row: ReportRow, format: 'md' | 'json'): string {
  const rel = format === 'md' ? row.markdown_path : row.json_path;
  if (!rel) throw new AppError('NOT_FOUND', `Report ${row.id} has no ${format} file recorded.`);
  const candidates = reportFileCandidates(ctx, rel);
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new AppError('NOT_FOUND', `Report file is missing: ${rel} (looked in ${ctx.paths.reportsDir})`, {
      hint: 'Restore the reports folder from a backup (or move it to the location workspace.json names); reports are never regenerated in place.',
    });
  }
  return found;
}

/** Read a stored report file (see resolveReportFile; traversal is rejected). */
export function readReportFile(ctx: AppContext, row: ReportRow, format: 'md' | 'json'): string {
  return readFileSync(resolveReportFile(ctx, row, format), 'utf8');
}

export function vaultFolderFor(kind: ReportKind): string {
  return kind === 'weekly' ? '07 Reports/Weekly' : kind === 'monthly' ? '07 Reports/Monthly' : '07 Reports';
}

/** Vault-relative note path for a report id (stable; used by the dashboard for links). */
export function reportNotePath(kind: ReportKind, periodEnd: string | null, id: string): string {
  const kindTitle = kind.charAt(0).toUpperCase() + kind.slice(1);
  const file = safeFileSegment(`${periodEnd ?? ''} ${kindTitle} report ${id}`.trim(), 150);
  return `${vaultFolderFor(kind)}/${file}.md`;
}

/** Vault note for a report. Each report id gets its own note (never rewritten by later runs). */
export function toVaultNote(report: Report, markdown: string): GeneratedNote {
  return {
    relPath: reportNotePath(report.kind, report.period.end, report.id),
    noteId: report.id,
    kind: `report_${report.kind}`,
    title: reportTitle(report),
    frontmatter: {
      type: 'report',
      report_id: report.id,
      report_kind: report.kind,
      site: report.siteId,
      period_start: report.period.start,
      period_end: report.period.end,
      generated_at: report.generatedAt,
      confidence: report.data.confidence?.level ?? null,
      is_synthetic: report.isSynthetic,
      tags: ['seo-agent/report', `seo-agent/report/${report.kind}`],
      ...(report.isSynthetic ? { watermark: report.watermark } : {}),
    },
    body: markdown,
  };
}
