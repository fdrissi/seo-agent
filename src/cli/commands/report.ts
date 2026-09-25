import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import { forTerminal } from '../../core/terminal.js';
import type { IntegrationId, IntegrationStatus } from '../../integrations/types.js';
import { buildReportOfKind, type BuiltReport } from '../../reports/build.js';
import { buildDashboard } from '../../reports/dashboard.js';
import { isReportKind, REPORT_KINDS, type ReportKind } from '../../reports/model.js';
import { getReport, latestReport, listReports, readReportFile, type ReportRow } from '../../reports/storage.js';
import { redactString } from '../../security/redact.js';
import type { CliRuntime } from '../runtime.js';

/**
 * report list | report show <kind> [--latest|--id] | report build <kind> --from-db | report dashboard
 *
 * `report build --from-db` re-renders from the CURRENT database state without
 * running any sync, and always creates a NEW report (past reports are never
 * rewritten). It makes no network requests and spends nothing.
 *
 * `report show` and `report dashboard` print stored Markdown that quotes
 * untrusted text (page titles, queries, model output): it is redacted and
 * printed terminal-safe (control, bidi, and invisible characters as visible
 * `[U+XXXX]` markers; src/core/terminal.ts). The stored files are unchanged.
 */

const STATES = ['ready', 'configured_unverified', 'disabled', 'missing_credentials', 'misconfigured', 'degraded', 'unreachable', 'permission_denied', 'fixture'] as const;

const statusSchema = z.object({
  id: z.string().min(1),
  state: z.enum(STATES),
  detail: z.string().default(''),
  nextStep: z.string().optional(),
  sendsExternally: z.array(z.string()).default([]),
  checkedAt: z.string().default(''),
  networkChecked: z.boolean().default(false),
  chargeable: z.boolean().default(false),
});

/** Load integration statuses from a JSON file: an array, or an object with `statuses`/`integrations`. */
export function loadStatusesFile(file: string): IntegrationStatus[] {
  const abs = path.resolve(file);
  if (!existsSync(abs)) throw new AppError('NOT_FOUND', `Statuses file not found: ${abs}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new AppError('VALIDATION_FAILED', `Statuses file is not valid JSON: ${(err as Error).message}`);
  }
  const list = Array.isArray(raw) ? raw : ((raw as { statuses?: unknown; integrations?: unknown })?.statuses ?? (raw as { integrations?: unknown })?.integrations);
  const parsed = z.array(statusSchema).safeParse(list);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Statuses file must contain an array of integration statuses ({ id, state, detail, nextStep? }).', { details: { errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) } });
  }
  return parsed.data.map((s) => ({ ...s, id: s.id as IntegrationId, ...(s.nextStep ? { nextStep: s.nextStep } : {}) }) as IntegrationStatus);
}

function requireKind(kind: string): ReportKind {
  if (!isReportKind(kind)) throw new AppError('VALIDATION_FAILED', `Unknown report kind "${kind}". Use one of: ${REPORT_KINDS.join(', ')}.`);
  return kind;
}

function rowView(r: ReportRow) {
  const summary = r.summary_json ? (JSON.parse(r.summary_json) as { confidence?: string; primaryAction?: { title?: string } | null }) : null;
  return {
    id: r.id,
    kind: r.kind,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    generatedAt: r.generated_at,
    isSynthetic: r.is_synthetic === 1,
    confidence: summary?.confidence ?? null,
    primaryAction: summary?.primaryAction?.title ?? null,
    markdownPath: r.markdown_path,
    jsonPath: r.json_path,
    contentHash: r.content_hash,
  };
}

function buildResultView(b: BuiltReport, dryRun: boolean) {
  return {
    ok: true,
    dryRun,
    id: b.report.id,
    kind: b.report.kind,
    period: { start: b.report.period.start, end: b.report.period.end, label: b.report.period.label },
    isSynthetic: b.report.isSynthetic,
    confidence: b.report.summary.confidence,
    primaryAction: b.report.summary.primaryAction,
    nextAction: b.report.summary.nextAction,
    claimCounts: b.report.summary.claimCounts,
    markdownPath: b.stored?.markdownPath ?? null,
    jsonPath: b.stored?.jsonPath ?? null,
    vaultNote: b.note.relPath,
    contractIssues: b.issues,
  };
}

export function register(program: Command, cli: CliRuntime): void {
  const report = program.command('report').description('Generated reports (append-only): list, show, rebuild from the database, dashboard');

  report
    .command('list')
    .description('List generated reports (newest first)')
    .option('--kind <kind>', `filter by kind (${REPORT_KINDS.join(', ')})`)
    .option('--limit <n>', 'maximum rows', '20')
    .action(
      cli.action(async (opts: { kind?: string; limit: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const kind = opts.kind ? requireKind(opts.kind) : undefined;
        const limit = Math.max(1, Math.min(500, Number.parseInt(opts.limit, 10) || 20));
        const ctx = cli.context(g);
        try {
          const rows = listReports(ctx.db, ctx.siteId, { ...(kind ? { kind } : {}), limit }).map(rowView);
          cli.print(g, { siteId: ctx.siteId, reports: rows }, (r: { reports: ReturnType<typeof rowView>[] }) =>
            r.reports.length
              ? ['id                              kind      period                     generated                 confidence  synthetic', ...r.reports.map((x) => `${x.id.padEnd(31)} ${x.kind.padEnd(9)} ${`${x.periodStart} to ${x.periodEnd}`.padEnd(26)} ${x.generatedAt.padEnd(25)} ${(x.confidence ?? 'n/a').padEnd(11)} ${x.isSynthetic ? 'SYNTHETIC' : ''}`)].join('\n')
              : 'No reports yet. Run `baseline`, `weekly`, or `monthly`, or `report build <kind> --from-db`.',
          );
        } finally {
          ctx.db.close();
        }
      }),
    );

  report
    .command('show <kind>')
    .description('Print a stored report (the latest of that kind unless --id is given)')
    .option('--latest', 'show the most recent report of this kind (default)')
    .option('--id <id>', 'show a specific report id')
    .option('--format <format>', 'md or json (with --json the JSON report is printed)', 'md')
    .action(
      cli.action(async (kindArg: string, opts: { latest?: boolean; id?: string; format: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const kind = requireKind(kindArg);
        if (opts.format !== 'md' && opts.format !== 'json') throw new AppError('VALIDATION_FAILED', '--format must be md or json');
        const ctx = cli.context(g);
        try {
          const row = opts.id ? getReport(ctx.db, ctx.siteId, opts.id) : latestReport(ctx.db, ctx.siteId, kind);
          if (!row) throw new AppError('NOT_FOUND', opts.id ? `Report ${opts.id} not found for site ${ctx.siteId}.` : `No ${kind} report exists yet for site ${ctx.siteId}.`, { hint: `Run \`${kind}\` or \`report build ${kind} --from-db\`.` });
          if (row.kind !== kind) throw new AppError('VALIDATION_FAILED', `Report ${row.id} is a ${row.kind} report, not ${kind}.`);
          if (g.json || opts.format === 'json') cli.print({ ...g, json: true }, JSON.parse(readReportFile(ctx, row, 'json')));
          else cli.io.out(forTerminal(redactString(readReportFile(ctx, row, 'md'))));
        } finally {
          ctx.db.close();
        }
      }),
    );

  report
    .command('build <kind>')
    .description('Build a NEW report from the current database state (no sync, no network, no spend)')
    .option('--from-db', 'required: build only from data already in the database')
    .option('--from <date>', 'period start (YYYY-MM-DD, business time zone)')
    .option('--to <date>', 'period end (YYYY-MM-DD, business time zone)')
    .option('--statuses <file>', 'JSON file with integration statuses (e.g. saved `doctor --json` output); without it the report says access was not checked')
    .option('--top <n>', 'top-N rows per table', '10')
    .option('--job <id>', 'associate the report with an existing job id')
    .action(
      cli.action(async (kindArg: string, opts: { fromDb?: boolean; from?: string; to?: string; statuses?: string; top: string; job?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const kind = requireKind(kindArg);
        if (!opts.fromDb) {
          throw new AppError('VALIDATION_FAILED', '`report build` only re-renders from the current database; pass --from-db.', { hint: `To sync fresh data and build, run \`${kind}\` instead.` });
        }
        if ((opts.from && !opts.to) || (!opts.from && opts.to)) throw new AppError('VALIDATION_FAILED', 'Pass both --from and --to, or neither.');
        const statuses = opts.statuses ? loadStatusesFile(opts.statuses) : null;
        const ctx = cli.context(g);
        try {
          const built = await buildReportOfKind(ctx, kind, {
            statuses,
            ...(opts.from && opts.to ? { period: { start: opts.from, end: opts.to } } : {}),
            topN: Number.parseInt(opts.top, 10) || 10,
            jobId: opts.job ?? null,
          });
          cli.print(g, buildResultView(built, ctx.dryRun), (r: ReturnType<typeof buildResultView>) =>
            [
              `${r.dryRun ? 'DRY RUN (nothing written): ' : ''}${r.kind} report ${r.id} for ${r.period.start} to ${r.period.end}${r.isSynthetic ? ' [SYNTHETIC DEMO DATA]' : ''}`,
              r.markdownPath ? `Markdown: ${r.markdownPath}` : '',
              r.jsonPath ? `JSON:     ${r.jsonPath}` : '',
              `Vault note (written by the vault sync): ${r.vaultNote}`,
              `Evidence confidence: ${r.confidence}`,
              `Prioritized action: ${r.primaryAction ? r.primaryAction.title : 'none'}`,
              `Next action: ${r.nextAction ?? 'none'}`,
              r.contractIssues.length ? `WARNING: ${r.contractIssues.length} report contract issue(s); see --json output.` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          );
        } finally {
          ctx.db.close();
        }
      }),
    );

  report
    .command('dashboard')
    .description('Print the static dashboard note (00 Dashboard/Dashboard.md) without writing the vault')
    .option('--statuses <file>', 'JSON file with integration statuses')
    .action(
      cli.action(async (opts: { statuses?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const statuses = opts.statuses ? loadStatusesFile(opts.statuses) : null;
        const ctx = cli.context(g);
        try {
          const note = buildDashboard(ctx, { statuses });
          if (g.json) cli.print(g, note);
          else cli.io.out(forTerminal(redactString(note.body)));
        } finally {
          ctx.db.close();
        }
      }),
    );
}
