import path from 'node:path';
import type { Command } from 'commander';
import { budgetTimeZone, type AppContext } from '../../app/context.js';
import { AppError } from '../../core/errors.js';
import { formatMeasured, type Measured } from '../../core/measured.js';
import { addDays, dateInZone, isIsoDate } from '../../core/time.js';
import { DEFAULT_LOCK_NAME, getSiteLock } from '../../jobs/locks.js';
import { assertAiCitationsEnabled, importAiCitations, type AiCitationImportResult } from '../../aeo/import.js';
import { aiCitationStatus, type AiCitationStatus } from '../../aeo/status.js';
import { aiCitationSummary, listAiCitationChecks, type AiCitationCheckView, type AiCitationPeriod, type AiCitationSummary } from '../../aeo/summary.js';
import type { CliRuntime } from '../runtime.js';

/**
 * ai-citations status
 * ai-citations import <file.csv|file.json> [--format --timezone --source --skip-invalid --synthetic]
 * ai-citations list [--from --to | --month] [--engine --grounded-only --limit]
 *
 * Optional AI-citation monitoring (spec 17), gated by features.aiCitations
 * (off by default in every profile). `status` always answers honestly;
 * `import` and `list` refuse with INTEGRATION_DISABLED while the flag is off.
 * Only the explicit manual-import adapter exists: no API-based engine is
 * implemented, nothing makes a network request, and nothing spends money.
 */

/** Default list window: the 90 days ending today in the site's business time zone. */
export const DEFAULT_LIST_DAYS = 90;

function refuseWhileJobHoldsSiteLock(ctx: AppContext): void {
  // `ai-citations import` changes data; like the commands in MUTATING_COMMANDS it never runs alongside a job of the same site.
  const lock = getSiteLock(ctx.db, ctx.siteId, DEFAULT_LOCK_NAME);
  if (!lock || !lock.jobId || Date.parse(lock.expiresAt) <= ctx.clock.now().getTime()) return;
  throw new AppError('LOCKED', `Site ${ctx.siteId} is locked by job ${lock.jobId} (held by ${lock.owner}, lease until ${lock.expiresAt}). "ai-citations import" changes data, so it never runs alongside a job of the same site. Nothing was done.`, {
    hint: `Wait for job ${lock.jobId} to finish (\`npm run cli -- jobs show ${lock.jobId}\`), or cancel it with \`jobs cancel ${lock.jobId}\`, then retry. --dry-run previews still work meanwhile.`,
    details: { command: 'ai-citations import', siteId: ctx.siteId, jobId: lock.jobId, owner: lock.owner, expiresAt: lock.expiresAt },
  });
}

function statusText(s: AiCitationStatus): string {
  return [
    `AI-citation monitoring: ${s.state.toUpperCase()}. ${s.detail}`,
    ...s.collectors.map((c) => `- ${c.id}: ${c.state}. ${c.detail}`),
    `Spending: ${s.spending.detail}`,
    `Stored observations: ${s.stored.total} (${s.stored.grounded} grounded, ${s.stored.ungrounded} ungrounded model responses${s.stored.synthetic ? `, ${s.stored.synthetic} SYNTHETIC` : ''})${s.stored.latestCheckedAt ? `; latest ${s.stored.latestCheckedAt}` : ''}.`,
    `Next step: ${s.nextStep}`,
  ].join('\n');
}

function importText(r: AiCitationImportResult): string {
  const lines = [
    `${r.preview ? 'DRY RUN (nothing written): ' : ''}AI-citation observations from ${path.basename(r.file)} (${r.format}${r.synthetic ? ', SYNTHETIC' : ''}, method manual_import): ${r.accepted} of ${r.rowsRead} row(s) valid; status ${r.status}.`,
    r.preview ? '' : `Stored: ${r.inserted} new, ${r.unchanged} unchanged, ${r.conflicts.length} conflicting (kept the stored row).`,
    r.accepted ? `Grounded: ${r.grounded}; ungrounded model responses (not search measurements): ${r.ungrounded}.` : '',
    r.accepted ? `Brand mentioned in the response text: ${r.brandMentioned.yes} yes, ${r.brandMentioned.no} no, ${r.brandMentioned.unknown} unknown. Own site cited: ${r.ownSiteCited.yes} yes, ${r.ownSiteCited.no} no, ${r.ownSiteCited.unknown} unknown.` : '',
    r.accepted ? 'A brand mention is not a citation, a citation is not a click, and a click is not a conversion.' : '',
    r.dateRange ? `Dates: ${r.dateRange.start} to ${r.dateRange.end} (${r.dateRange.timeZone}).` : '',
    ...r.warnings.map((w) => `Note: ${w}`),
    ...r.conflicts.slice(0, 20).map((c) => `  row ${c.row}: differs from stored ${c.existingId} (${c.differs.join(', ')})`),
    ...r.rejected.slice(0, 20).map((e) => `  row ${e.row}: ${e.errors.join('; ')}`),
    r.rejected.length > 20 ? `  ... ${r.rejected.length - 20} more invalid row(s) (see --json)` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function m<T>(x: Measured<T>, fmt: (v: T) => string): string {
  return formatMeasured(x, fmt);
}

export function summaryText(s: AiCitationSummary): string {
  const head = `AI-citation summary ${s.period.start} to ${s.period.end} (${s.period.timeZone}): ${s.status.toUpperCase()}${s.containsSynthetic ? ' [contains SYNTHETIC rows]' : ''}.`;
  if (s.status !== 'observed') return [head, `Brand mentions: ${m(s.brandMentions, String)}`, ...s.notes.map((n) => `Note: ${n}`)].join('\n');
  return [
    head,
    `Observations: ${s.checks.total} (${s.checks.grounded} grounded; ${s.checks.ungroundedExcluded} ungrounded model responses excluded from every number).`,
    `Brand mentioned in grounded answers: ${m(s.brandMentions, (v) => `${v.mentioned} yes, ${v.notMentioned} no, ${v.unknown} unknown`)}.`,
    `Own site cited by grounded answers: ${m(s.ownSiteCitations, (v) => `${v.cited} yes, ${v.notCited} no, ${v.unknown} unknown`)}.`,
    `Mentioned but not cited: ${m(s.mentionedNotCited, String)}. Cited but not mentioned: ${m(s.citedNotMentioned, String)}.`,
    `Clicks: ${m(s.clicks, String)}.`,
    `Conversions: ${m(s.conversions, String)}.`,
    ...s.byEngine.map((e) => `- ${e.engine}: ${e.grounded} grounded (${e.brandMentioned} mention, ${e.ownSiteCited} own-site citation${e.brandMentionUnknown || e.ownSiteCitationUnknown ? `; unknown: ${e.brandMentionUnknown} mention, ${e.ownSiteCitationUnknown} citation` : ''}), ${e.ungroundedExcluded} ungrounded excluded`),
    ...(s.ownCitedUrls.length ? ['Own-site URLs cited:', ...s.ownCitedUrls.slice(0, 20).map((u) => `  ${u.url} (${u.observations})`)] : []),
    ...s.semantics.map((x) => `Rule: ${x}`),
    ...s.notes.map((n) => `Note: ${n}`),
  ].join('\n');
}

function yn(v: boolean | null): string {
  return v === null ? 'unknown' : v ? 'yes' : 'no';
}

function checkLine(c: AiCitationCheckView): string {
  const where = c.location ? ` [${c.location}]` : '';
  const kind = c.isGrounded ? 'grounded' : 'UNGROUNDED model response (not a search measurement)';
  const cited = c.citedUrls === null ? 'cited URLs not recorded' : `${c.citedUrls.length} cited URL(s), ${c.ownCitedUrls?.length ?? 0} own`;
  return `${c.date} ${c.engine}${where}: "${c.query.slice(0, 120)}" - ${kind}; brand mentioned: ${yn(c.brandMentioned)}; own site cited: ${yn(c.ownSiteCited)}; ${cited}${c.isSynthetic ? ' [SYNTHETIC]' : ''} (${c.id})`;
}

function listPeriod(ctx: AppContext, opts: { from?: string; to?: string; month?: string }): AiCitationPeriod | string {
  if (opts.month) {
    if (opts.from || opts.to) throw new AppError('VALIDATION_FAILED', 'Use either --month or --from/--to, not both.');
    return opts.month;
  }
  const tz = budgetTimeZone(ctx.config);
  const to = opts.to ?? dateInZone(ctx.clock.now(), tz);
  if (!isIsoDate(to)) throw new AppError('VALIDATION_FAILED', `--to must be YYYY-MM-DD (got "${to}")`);
  const from = opts.from ?? addDays(to, -(DEFAULT_LIST_DAYS - 1));
  if (!isIsoDate(from)) throw new AppError('VALIDATION_FAILED', `--from must be YYYY-MM-DD (got "${from}")`);
  return { start: from, end: to, timeZone: tz };
}

export function register(program: Command, cli: CliRuntime): void {
  const ai = program
    .command('ai-citations')
    .description('Optional AI-citation monitoring (features.aiCitations, off by default): explicit manual import of observed AI answers; no API engine is implemented');

  ai.command('status')
    .description('Show whether AI-citation monitoring is enabled, which collectors exist (manual import only; no API engine), and what is stored; no network')
    .action(
      cli.action(async (_opts: Record<string, never>, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          cli.print(g, aiCitationStatus(ctx), statusText);
        } finally {
          ctx.db.close();
        }
      }),
    );

  ai.command('import <file>')
    .description('Import observed AI answers from CSV/JSON (columns: engine, query, date, grounded; optional prompt, location, timezone, response, cited_urls, source). Brand mention and own-site citation are computed in code; nothing is fetched or charged')
    .option('--format <format>', 'csv | json (default: by file extension)')
    .option('--timezone <iana>', "time zone of dates without a time (default: the site's business time zone)")
    .option('--source <label>', 'tool or person that captured the observations, when the file has no source column')
    .option('--skip-invalid', 'import the valid rows and report the import as partial (default: refuse the whole file)')
    .option('--synthetic', 'label the imported rows synthetic (test or demo data)')
    .action(
      cli.action(async (file: string, opts: { format?: string; timezone?: string; source?: string; skipInvalid?: boolean; synthetic?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        if (opts.format && opts.format !== 'csv' && opts.format !== 'json') throw new AppError('VALIDATION_FAILED', '--format must be csv or json');
        const ctx = cli.context(g);
        try {
          assertAiCitationsEnabled(ctx);
          if (!ctx.dryRun) refuseWhileJobHoldsSiteLock(ctx);
          const r = importAiCitations(ctx, file, {
            ...(opts.format ? { format: opts.format as 'csv' | 'json' } : {}),
            ...(opts.timezone ? { timeZone: opts.timezone } : {}),
            ...(opts.source ? { sourceLabel: opts.source } : {}),
            skipInvalid: !!opts.skipInvalid,
            synthetic: !!opts.synthetic,
            preview: ctx.dryRun,
          });
          cli.print(g, r, importText);
          if (r.status === 'failed') process.exitCode = 1;
          else if (r.status === 'partial') process.exitCode = 2;
        } finally {
          ctx.db.close();
        }
      }),
    );

  ai.command('list')
    .description(`List stored AI-citation observations with a summary that keeps mention, citation, click, and conversion apart (default: the last ${DEFAULT_LIST_DAYS} days)`)
    .option('--from <date>', 'first observation date (YYYY-MM-DD)')
    .option('--to <date>', "last observation date (YYYY-MM-DD; default: today in the site's business time zone)")
    .option('--month <yyyy-mm>', 'one calendar month instead of --from/--to')
    .option('--engine <name>', 'only this engine')
    .option('--grounded-only', 'hide ungrounded model responses from the list (they never count in the summary)')
    .option('--limit <n>', 'maximum observations listed (the summary always covers the whole period)', '50')
    .action(
      cli.action(async (opts: { from?: string; to?: string; month?: string; engine?: string; groundedOnly?: boolean; limit: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const limit = Number(opts.limit);
        if (!Number.isInteger(limit) || limit < 1) throw new AppError('VALIDATION_FAILED', '--limit must be a positive integer');
        const ctx = cli.context(g);
        try {
          assertAiCitationsEnabled(ctx);
          const period = listPeriod(ctx, opts);
          const listed = listAiCitationChecks(ctx, period, { engine: opts.engine ?? null, groundedOnly: !!opts.groundedOnly, limit });
          const summary = aiCitationSummary(ctx, listed.period);
          const result = { period: listed.period, total: listed.total, shown: listed.checks.length, summary, checks: listed.checks };
          cli.print(g, result, (r: typeof result) =>
            [
              summaryText(r.summary),
              '',
              r.total ? `Observations (${r.shown} of ${r.total}${opts.engine ? `, engine ${opts.engine}` : ''}${opts.groundedOnly ? ', grounded only' : ''}):` : 'No stored observations match.',
              ...r.checks.map(checkLine),
            ].join('\n'),
          );
        } finally {
          ctx.db.close();
        }
      }),
    );
}
