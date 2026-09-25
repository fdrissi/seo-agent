import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { buildWeeklyReport } from '../../../src/reports/build.js';
import { getReport, latestReport, listReports, persistReport, readReportFile, resolveReportFile, type ReportRow } from '../../../src/reports/storage.js';
import { reportsTestConfig, seedWeeklyScenario, insertRow } from '../../fixtures/reports/seed.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

describe('append-only report storage', () => {
  it('writes <workspace>/reports/<site>/<kind>/<period>-<id>.{md,json} and a reports row', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const b = await buildWeeklyReport(ctx, { statuses: null });
    const s = b.stored!;
    expect(s.markdownPath).toBe(path.join(ctx.paths.reportsDir, ctx.siteId, 'weekly', `2026-09-14_2026-09-20-${b.report.id}.md`));
    expect(s.jsonPath.endsWith(`2026-09-14_2026-09-20-${b.report.id}.json`)).toBe(true);
    // Display path: workspace-relative in the default layout (unchanged for callers such as the demo).
    expect(s.relMarkdownPath).toBe(`reports/${ctx.siteId}/weekly/2026-09-14_2026-09-20-${b.report.id}.md`);
    // Stored path: relative to the reports folder, so a relocated folder still resolves.
    expect(s.storedMarkdownPath).toBe(`${ctx.siteId}/weekly/2026-09-14_2026-09-20-${b.report.id}.md`);
    expect(s.storedJsonPath).toBe(`${ctx.siteId}/weekly/2026-09-14_2026-09-20-${b.report.id}.json`);
    expect(statSync(s.markdownPath).mode & 0o077).toBe(0);
    const row = getReport(ctx.db, ctx.siteId, b.report.id)!;
    expect(row.kind).toBe('weekly');
    expect(row.period_start).toBe('2026-09-14');
    expect(row.markdown_path).toBe(s.storedMarkdownPath);
    expect(row.json_path).toBe(s.storedJsonPath);
    expect(JSON.parse(row.summary_json!).confidence).toBe(b.report.summary.confidence);
    expect(readReportFile(ctx, row, 'md')).toBe(b.markdown);
    expect(JSON.parse(readReportFile(ctx, row, 'json')).id).toBe(b.report.id);
    const audit = ctx.db.all<{ event_type: string; subject_id: string }>(`SELECT event_type, subject_id FROM audit_events WHERE event_type = 'report.generated'`);
    expect(audit.map((a) => a.subject_id)).toContain(b.report.id);
  });

  it('a re-run creates a new report id and file; the first report stays unchanged', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const first = await buildWeeklyReport(ctx, { statuses: null });
    const firstMd = readFileSync(first.stored!.markdownPath, 'utf8');
    const firstJson = readFileSync(first.stored!.jsonPath, 'utf8');
    const firstMtime = statSync(first.stored!.markdownPath).mtimeMs;
    ctx.clock.advanceMs(60_000);
    const second = await buildWeeklyReport(ctx, { statuses: null });
    expect(second.report.id).not.toBe(first.report.id);
    expect(second.stored!.markdownPath).not.toBe(first.stored!.markdownPath);
    expect(readFileSync(first.stored!.markdownPath, 'utf8')).toBe(firstMd);
    expect(readFileSync(first.stored!.jsonPath, 'utf8')).toBe(firstJson);
    expect(statSync(first.stored!.markdownPath).mtimeMs).toBe(firstMtime);
    const rows = listReports(ctx.db, ctx.siteId, { kind: 'weekly' });
    expect(rows.map((r) => r.id)).toEqual([second.report.id, first.report.id]);
    expect(latestReport(ctx.db, ctx.siteId, 'weekly')?.id).toBe(second.report.id);
    expect(second.note.relPath).not.toBe(first.note.relPath);
  });

  it('blocks UPDATE on the reports table and never overwrites existing report files', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const b = await buildWeeklyReport(ctx, { statuses: null });
    expect(() => ctx!.db.run('UPDATE reports SET content_hash = ? WHERE id = ?', ['tampered', b.report.id])).toThrow(/append-only/);
    // Re-persisting the same report object (same id) is refused and leaves the original intact.
    const before = readFileSync(b.stored!.markdownPath, 'utf8');
    expect(() => persistReport(ctx!, b.report, { markdown: 'overwrite attempt', json: '{}' })).toThrow(/never rewritten/);
    expect(readFileSync(b.stored!.markdownPath, 'utf8')).toBe(before);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reports')?.n).toBe(1);
  });

  it('removes written files when the reports row cannot be inserted', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const b = await buildWeeklyReport(ctx, { statuses: null, persist: false });
    // Pre-insert a row with the same id to force a primary-key conflict.
    insertRow(ctx.db, 'reports', { id: b.report.id, site_id: ctx.siteId, kind: 'weekly', content_hash: 'x', generated_at: b.report.generatedAt });
    expect(() => persistReport(ctx!, b.report, { markdown: b.markdown, json: b.json })).toThrow();
    const dir = path.join(ctx.paths.reportsDir, ctx.siteId, 'weekly');
    expect(existsSync(path.join(dir, `2026-09-14_2026-09-20-${b.report.id}.md`))).toBe(false);
  });

  it('does not write anything in dry-run mode', async () => {
    ctx = createTestContext({ config: reportsTestConfig(), dryRun: true });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const b = await buildWeeklyReport(ctx, { statuses: null });
    expect(b.stored).toBeNull();
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reports')?.n).toBe(0);
    expect(existsSync(path.join(ctx.paths.reportsDir, ctx.siteId))).toBe(false);
  });

  it('returns a vault note for 07 Reports/Weekly with frontmatter', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const b = await buildWeeklyReport(ctx, { statuses: null });
    expect(b.note.relPath.startsWith('07 Reports/Weekly/2026-09-20 Weekly report rpt_')).toBe(true);
    expect(b.note.relPath.endsWith('.md')).toBe(true);
    expect(b.note.noteId).toBe(b.report.id);
    expect(b.note.frontmatter).toMatchObject({ type: 'report', report_kind: 'weekly', period_start: '2026-09-14', period_end: '2026-09-20', is_synthetic: false });
    expect(b.note.body).toBe(b.markdown);
  });
});

describe('report storage with a relocated reports folder (workspace.json paths)', () => {
  let outside: string | undefined;
  afterEach(() => {
    if (outside) rmSync(outside, { recursive: true, force: true });
    outside = undefined;
  });

  /** The context as workspacePaths() returns it when workspace.json relocates reportsDir. */
  function relocated(base: TestContext): TestContext {
    outside = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-reports-elsewhere-'));
    return { ...base, paths: { ...base.paths, reportsDir: path.join(outside, 'reports') } } as TestContext;
  }

  it('writes into the relocated folder, stores paths relative to it, and reads them back', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const moved = relocated(ctx);
    const b = await buildWeeklyReport(moved, { statuses: null });
    const s = b.stored!;
    expect(s.markdownPath).toBe(path.join(moved.paths.reportsDir, ctx.siteId, 'weekly', `2026-09-14_2026-09-20-${b.report.id}.md`));
    expect(existsSync(s.markdownPath)).toBe(true);
    // Nothing is written under the workspace's default reports folder.
    expect(existsSync(path.join(ctx.paths.root, 'reports', ctx.siteId))).toBe(false);
    const row = getReport(ctx.db, ctx.siteId, b.report.id)!;
    expect(row.markdown_path).toBe(`${ctx.siteId}/weekly/2026-09-14_2026-09-20-${b.report.id}.md`);
    expect(row.markdown_path!.startsWith('reports/')).toBe(false);
    // The display path of a folder outside the workspace is absolute (never a ../ path).
    expect(s.relMarkdownPath).toBe(s.markdownPath);
    expect(readReportFile(moved, row, 'md')).toBe(b.markdown);
    expect(JSON.parse(readReportFile(moved, row, 'json')).id).toBe(b.report.id);
    // With the default location the relocated file is not found, and nothing else is read in its place.
    expect(() => readReportFile(ctx!, row, 'md')).toThrow(/Report file is missing/);
  });

  it('keeps reading legacy rows stored relative to the workspace root, before and after relocation', () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const legacyRel = `reports/${ctx.siteId}/weekly/2026-08-31_2026-09-06-rpt_legacy.md`;
    const legacyAbs = path.join(ctx.paths.root, ...legacyRel.split('/'));
    mkdirSync(path.dirname(legacyAbs), { recursive: true });
    writeFileSync(legacyAbs, '# legacy report (synthetic)\n');
    insertRow(ctx.db, 'reports', { id: 'rpt_legacy', site_id: ctx.siteId, kind: 'weekly', markdown_path: legacyRel, json_path: null, content_hash: 'x', generated_at: '2026-09-07T00:00:00.000Z' });
    const row = getReport(ctx.db, ctx.siteId, 'rpt_legacy')!;
    // Default layout: found where it was written.
    expect(readReportFile(ctx, row, 'md')).toBe('# legacy report (synthetic)\n');
    // Relocated, files left at the old location: still found there.
    const moved = relocated(ctx);
    expect(resolveReportFile(moved, row, 'md')).toBe(legacyAbs);
    // Relocated and the files moved along with the folder: found in the new folder.
    const movedAbs = path.join(moved.paths.reportsDir, ctx.siteId, 'weekly', '2026-08-31_2026-09-06-rpt_legacy.md');
    mkdirSync(path.dirname(movedAbs), { recursive: true });
    renameSync(legacyAbs, movedAbs);
    expect(resolveReportFile(moved, row, 'md')).toBe(movedAbs);
    expect(readReportFile(moved, row, 'md')).toBe('# legacy report (synthetic)\n');
    // No json file was recorded for this row.
    expect(() => readReportFile(moved, row, 'json')).toThrow(/no json file recorded/);
  });

  it('rejects traversal and absolute paths in stored rows (resolved inside the reports folder only)', () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const base: Omit<ReportRow, 'markdown_path'> = { id: 'rpt_bad', site_id: ctx.siteId, kind: 'weekly', period_start: null, period_end: null, job_id: null, json_path: null, content_hash: 'x', summary_json: null, is_synthetic: 0, generated_at: '2026-09-07T00:00:00.000Z' };
    writeFileSync(path.join(ctx.paths.root, 'outside.md'), 'not a report');
    expect(() => readReportFile(ctx!, { ...base, markdown_path: '../outside.md' }, 'md')).toThrow(/escapes its base directory/);
    expect(() => readReportFile(ctx!, { ...base, markdown_path: 'reports/../../outside.md' }, 'md')).toThrow(/escapes its base directory/);
    expect(() => readReportFile(ctx!, { ...base, markdown_path: path.join(ctx!.paths.root, 'outside.md') }, 'md')).toThrow(/Absolute paths are not allowed/);
  });
});
