import type { Command } from 'commander';
import type { AppContext } from '../../app/context.js';
import { ownerActor, validateApproverName } from '../../approvals/approver.js';
import { AppError, ValidationError } from '../../core/errors.js';
import { createGoogleAuthProvider } from '../../auth/providers.js';
import { ga4ConversionChecklist } from '../../integrations/google/ga4-checklist.js';
import { confirmRateScale, type ConfirmedRateScale, type ConfirmRateScaleResult } from '../../integrations/google/ga4-metadata.js';
import { syncGa4, type SyncGa4Result } from '../../integrations/google/ga4-sync.js';
import type { GscSearchType } from '../../integrations/google/gsc-client.js';
import { syncGsc, type GscSegment, type SyncGscResult } from '../../integrations/google/gsc-sync.js';
import type { GoogleAuthProvider } from '../../integrations/google/types.js';
import { describeInspection, inspectUrls, selectPriorityUrls, type InspectUrlsResult } from '../../integrations/google/url-inspection.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';

/**
 * `sync gsc | ga4 | inspect`. Google reads are free (quota-limited) and
 * read-only; nothing here submits sitemaps, requests indexing, or changes
 * any Google setting.
 */

export interface SyncCommandDeps {
  context?: (g: GlobalOptions) => AppContext;
  provider?: (ctx: AppContext) => GoogleAuthProvider;
}

const SEARCH_TYPES: readonly GscSearchType[] = ['web', 'image', 'video', 'news', 'discover', 'googleNews'];
const SEGMENTS: readonly GscSegment[] = ['country', 'device', 'searchAppearance'];

function parseList<T extends string>(raw: string | undefined, allowed: readonly T[], label: string): T[] | undefined {
  if (!raw) return undefined;
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const i of items) if (!allowed.includes(i as T)) throw new ValidationError(`Unknown ${label} "${i}". Allowed: ${allowed.join(', ')}`);
  return items as T[];
}

const RATE_SCALES = ['fraction', 'percent'] as const;

function parseRateScale(raw: string): ConfirmedRateScale {
  const v = raw.trim().toLowerCase();
  if ((RATE_SCALES as readonly string[]).includes(v)) return v as ConfirmedRateScale;
  throw new ValidationError(`Unknown rate scale "${raw}". Use fraction (GA4 reports key-event rates as 0-1, e.g. 0.025 for 2.5%) or percent (0-100, e.g. 2.5 for 2.5%).`);
}

export function renderRateScaleConfirmation(r: ConfirmRateScaleResult): string {
  const label = r.scale === 'fraction' ? 'fraction (0-1: 0.025 means 2.5%)' : 'percent (0-100: 2.5 means 2.5%)';
  const lines = [
    `GA4 key-event rate scale ${r.dryRun ? 'NOT recorded (dry run)' : 'confirmed'}: ${label} for property ${r.propertyId} (${r.basis === 'owner_assertion' ? 'owner assertion' : 'integer consistency'})${r.confirmationId ? `; confirmation ${r.confirmationId} (audit event google.ga4.rate_scale_confirmed)` : ''}.`,
    `${r.dryRun ? 'Would re-mark' : 'Re-marked'} ${r.remarked.landingRows} daily landing-page rate row(s) and ${r.remarked.periodRows} period rate row(s) that were stored with an undetermined scale${r.scale === 'percent' ? ' (values divided by 100)' : ' (values unchanged)'}; earlier revisions are kept.`,
    r.dryRun ? 'Later syncs would store rates on this scale.' : 'Later GA4 syncs store rates on this scale; a value above 1 still proves 0-100 and wins over a 0-1 confirmation.',
  ];
  for (const n of r.notes) lines.push(`  - ${n}`);
  return lines.join('\n');
}

/**
 * The human who confirms a GA4 rate scale: `--as <name>` is required (no
 * default identity) and validated like an approver name, so obvious
 * automation and account names (cli, system, scheduler, model, agent,
 * claude, owner, root, ...) are refused. The name is recorded as asserted,
 * not authenticated.
 */
export function confirmerName(asFlag: string | undefined): string {
  if (!asFlag?.trim()) {
    throw new AppError('VALIDATION_FAILED', '--confirm-rate-scale needs --as "<your name>": the confirmation is recorded as a named human\'s assertion and changes how every stored rate is read.', {
      hint: 'Example: npm run cli -- sync ga4 --confirm-rate-scale fraction --evidence "<what you compared>" --as "<your name>"',
    });
  }
  return validateApproverName(asFlag);
}

function parsePositiveInt(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new ValidationError(`${label} must be a positive integer`);
  return n;
}

/** Retired = no longer reported by a complete request (not current, not zero); stale = kept because the response was incomplete. */
function retiredText(d: { rowsRetired?: number; rowsStaleRetained?: number }): string {
  const parts: string[] = [];
  if (d.rowsRetired) parts.push(`retired ${d.rowsRetired} (no longer reported)`);
  if (d.rowsStaleRetained) parts.push(`kept ${d.rowsStaleRetained} unconfirmed (incomplete response)`);
  return parts.length ? `, ${parts.join(', ')}` : '';
}

export function renderGscResult(r: SyncGscResult): string {
  const lines = [`Search Console sync: ${r.status.toUpperCase()}${r.synthetic ? ' [SYNTHETIC FIXTURES - not live data]' : ''}`, `Property: ${r.property ?? '(not configured)'}; dates in ${r.timeZone} (Search Console reporting time zone)`];
  for (const x of r.ranges) {
    lines.push(`  ${x.searchType}: ${x.start}..${x.end} (${x.mode})`);
    for (const d of x.datasets ?? []) if (d.backfillFrom) lines.push(`    backfill ${d.dataset} from ${d.backfillFrom} (${d.gapDates} date(s) never collected or interrupted)`);
  }
  for (const g of r.gaps ?? []) lines.push(`  GAP ${g.dataset} ${g.searchType}: ${g.dates} date(s) not collected from ${g.firstDate} (missing, not zero; the next sync backfills them)`);
  if (r.plan) {
    lines.push(`Planned datasets: ${r.plan.datasets.join(', ')}; at least ${r.plan.estimatedMinRequests} free read requests.`);
    for (const n of r.plan.notes) lines.push(`  - ${n}`);
  }
  for (const a of r.availability) lines.push(`Availability ${a.searchType}: first incomplete date ${a.firstIncompleteDate ?? 'none'} (${a.firstIncompleteSource}); latest final date ${a.latestFinalDate ?? 'none'}`);
  if (r.datasets.length) lines.push('Datasets (separate; never summed together):');
  for (const d of r.datasets) {
    lines.push(`  ${d.dataset} ${d.searchType}${d.segmentKey ? ` [${d.segmentKey}]` : ''}: ${d.status}; rows ${d.rowsReceived}, new revisions ${d.rowsNewRevision} (revised ${d.rowsRevised}), unchanged ${d.rowsUnchanged}${retiredText(d)}; API pages ${d.apiPages}${d.truncated ? '; TRUNCATED' : ''}`);
  }
  if (r.inspection) lines.push(renderInspection(r.inspection));
  if (r.warnings.length) {
    lines.push('Warnings:');
    for (const w of r.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}

export function renderGa4Result(r: SyncGa4Result): string {
  const lines = [`GA4 sync: ${r.status.toUpperCase()}${r.synthetic ? ' [SYNTHETIC FIXTURES - not live data]' : ''}`, `Property: ${r.propertyId ?? '(not configured)'}; time zone ${r.timeZone ?? 'unknown'}; currency ${r.currencyCode ?? 'unknown'}`];
  if (r.range) lines.push(`Range: ${r.range.start}..${r.range.end} (${r.range.mode}); dates from ${r.range.incompleteFrom} are marked incomplete`);
  for (const sl of r.range?.slices ?? []) if (sl.backfillFrom) lines.push(`  backfill ${sl.key} from ${sl.backfillFrom} (${sl.gapDates} date(s) never collected or interrupted)`);
  for (const g of r.gaps ?? []) lines.push(`  GAP ${g.slice}: ${g.dates} date(s) not collected from ${g.firstDate} (missing, not zero; the next sync backfills them)`);
  if (r.plan) {
    for (const n of r.plan.notes) lines.push(`  - ${n}`);
    lines.push('Planned reports:');
    for (const p of r.plan.reports) lines.push(`  - ${p}`);
  }
  if (r.metricPlan) {
    const p = r.metricPlan;
    lines.push(`Primary event: ${p.primaryEvent ?? '(none configured)'}; session key-event rate metric: ${p.primaryRateMetric ?? 'UNAVAILABLE'}; key-event count: ${p.primaryKeyEventsMetric ?? p.primaryKeyEventsAlternative ?? 'UNAVAILABLE'}; revenue: ${p.revenueMetric ?? 'UNAVAILABLE'}`);
  }
  if (r.limitations.length) {
    lines.push('Limitations (DATA UNAVAILABLE, no substitutes computed):');
    for (const l of r.limitations) lines.push(`  - ${l}`);
  }
  if (r.rateScale && r.metricPlan?.primaryRateMetric) {
    const s = r.rateScale;
    const how = s.source === 'stored' ? 'stored finding' : s.source === 'this_sync' ? 'observed in this sync' : s.source === 'proven' ? 'proven from stored daily rows by integer consistency' : s.source === 'confirmed' ? `recorded ${s.confirmation?.basis === 'integer_consistency' ? 'integer-consistency proof' : 'owner confirmation'}${s.confirmation ? ` ${s.confirmation.id}` : ''}` : 'not established';
    const text =
      s.detected === 'percent_0_100'
        ? `0-100 reported by GA4, stored as fractions (${how})`
        : s.detected === 'fraction_0_1'
          ? `0-1 reported by GA4, stored as reported (${how})`
          : 'UNDETERMINED - rates stored exactly as reported; do not treat them as verified fractions. Compare one stored value with the GA4 interface, then run `npm run cli -- sync ga4 --confirm-rate-scale fraction|percent --evidence "<what you compared>" --as "<your name>"`';
    lines.push(`Key-event rate scale: ${text}`);
    if (s.remarked && (s.remarked.landingRows || s.remarked.periodRows)) lines.push(`  re-marked ${s.remarked.landingRows} daily and ${s.remarked.periodRows} period rate row(s) stored earlier with an undetermined scale (new revisions)`);
  }
  for (const d of r.datasets) lines.push(`  ${d.dataset} ${d.view} ${d.variant}: ${d.status}; rows ${d.rowsReceived}, new revisions ${d.rowsNewRevision} (revised ${d.rowsRevised}), unchanged ${d.rowsUnchanged}${retiredText(d)}; API pages ${d.apiPages}${d.truncated ? '; TRUNCATED' : ''}`);
  if (r.warnings.length) {
    lines.push('Warnings:');
    for (const w of r.warnings) lines.push(`  - ${w}`);
  }
  if (r.checklist) lines.push('', r.checklist);
  return lines.join('\n');
}

export function renderInspection(r: InspectUrlsResult): string {
  const lines = [`URL Inspection: ${r.status}${r.synthetic ? ' [SYNTHETIC]' : ''}; inspected ${r.inspected}, skipped ${r.skipped}, failed ${r.failed} (cap ${r.cap})`, `  ${r.note}`];
  if (r.status === 'nothing_inspected') lines.push('  NOTICE: nothing was inspected, so this run observed no indexed state. Check the skip reasons below (property, per-run cap, daily quota, dry run).');
  for (const o of r.outcomes) {
    lines.push(o.status === 'inspected' ? `  ${o.url}: ${describeInspection(o)}${o.googleCanonical && o.googleCanonical !== o.url ? ` Google canonical: ${o.googleCanonical}` : ''}` : `  ${o.url}: ${o.status} (${o.reason ?? ''})`);
  }
  return lines.join('\n');
}

export function register(program: Command, cli: CliRuntime, deps: SyncCommandDeps = {}): void {
  const ctxFor = (g: GlobalOptions) => (deps.context ? deps.context(g) : cli.context(g));
  const providerFor = (ctx: AppContext) => (deps.provider ? deps.provider(ctx) : createGoogleAuthProvider(ctx));
  const sync = program.command('sync').description('Ingest Google data (read-only): Search Console, GA4, URL Inspection');

  sync
    .command('gsc')
    .description('Sync Search Console property totals, page totals, and top-page query detail (versioned; re-runs never double count)')
    .option('--days <n>', 'history window ending yesterday (Pacific time); default: 90 days initially, then incremental refresh')
    .option('--search-types <list>', `comma-separated search types (${SEARCH_TYPES.join(', ')}); default from site config`)
    .option('--segments <list>', `optional segment dimensions, only when needed (${SEGMENTS.join(', ')})`)
    .option('--top-pages <n>', 'pages that receive page/query detail (default google.gsc.pageQueryTopPages)')
    .option('--no-page-query', 'skip the targeted page/query detail')
    .option('--inspect <n>', 'afterwards, URL-inspect up to n priority URLs (bounded by google.gsc.urlInspectionMaxPerRun)')
    .action(
      cli.action(async (opts: { days?: string; searchTypes?: string; segments?: string; topPages?: string; pageQuery: boolean; inspect?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = ctxFor(g);
        try {
          const days = parsePositiveInt(opts.days, '--days');
          const topPages = parsePositiveInt(opts.topPages, '--top-pages');
          const inspect = parsePositiveInt(opts.inspect, '--inspect');
          const searchTypes = parseList(opts.searchTypes, SEARCH_TYPES, 'search type');
          const segments = parseList(opts.segments, SEGMENTS, 'segment');
          const result = await syncGsc(ctx, {
            provider: providerFor(ctx),
            dryRun: !!g.dryRun,
            includePageQuery: opts.pageQuery,
            ...(days !== undefined ? { days } : {}),
            ...(topPages !== undefined ? { topPages } : {}),
            ...(inspect !== undefined ? { inspect } : {}),
            ...(searchTypes ? { searchTypes } : {}),
            ...(segments ? { segments } : {}),
          });
          cli.print(g, result, renderGscResult);
          if (result.status === 'partial') process.exitCode = 2;
        } finally {
          ctx.db.close();
        }
      }),
    );

  sync
    .command('ga4')
    .description('Sync GA4 landing-page views (google_organic, all_organic), event counts, and period-grain users/rates')
    .option('--days <n>', 'history window ending yesterday (property time zone); default: 90 days initially, then incremental refresh')
    .option('--periods <list>', 'comma-separated period windows in days for non-additive metrics (default 7,28)')
    .option('--checklist', 'print the manual conversion-verification checklist and exit (no GA4 request)')
    .option('--confirm-rate-scale <scale>', `record the scale GA4 uses for key-event rates (${RATE_SCALES.join(' = 0-1, ')} = 0-100) after comparing a stored value with the GA4 interface, re-mark stored rates, and exit (no GA4 request; audited)`)
    .option('--evidence <text>', 'with --confirm-rate-scale: what you compared (kept in the audit log), e.g. "GA4 UI shows 2.5% for /pricing on 2026-09-15; stored 0.025"')
    .option('--as <name>', 'with --confirm-rate-scale (required): your name; recorded as asserted, not authenticated (obvious automation or account names such as system, claude, agent007, owner, or root are refused)')
    .action(
      cli.action(async (opts: { days?: string; periods?: string; checklist?: boolean; confirmRateScale?: string; evidence?: string; as?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        if (opts.evidence !== undefined && opts.confirmRateScale === undefined) throw new ValidationError('--evidence is only used with --confirm-rate-scale.');
        if (opts.as !== undefined && opts.confirmRateScale === undefined) throw new ValidationError('--as is only used with --confirm-rate-scale.');
        const scale = opts.confirmRateScale === undefined ? undefined : parseRateScale(opts.confirmRateScale);
        // The confirmation changes how every stored rate is read (older days included): a named human asserts it.
        const confirmer = scale ? confirmerName(opts.as) : '';
        const ctx = ctxFor(g);
        try {
          if (opts.checklist) {
            const text = ga4ConversionChecklist(ctx.config);
            cli.print(g, { checklist: text }, (r) => r.checklist);
            return;
          }
          if (scale) {
            const propertyId = ctx.config.google.ga4PropertyId;
            if (!propertyId) throw new ValidationError('No GA4 property is configured (google.ga4PropertyId); there is no rate scale to confirm.');
            const result = confirmRateScale(ctx, propertyId, { scale, evidence: opts.evidence ?? '', actor: ownerActor(confirmer), dryRun: !!g.dryRun || ctx.dryRun, synthetic: ctx.synthetic, traceId: ctx.runId });
            cli.print(g, result, renderRateScaleConfirmation);
            return;
          }
          const days = parsePositiveInt(opts.days, '--days');
          const periodWindows = opts.periods ? opts.periods.split(',').map((p) => parsePositiveInt(p.trim(), '--periods')!) : undefined;
          const result = await syncGa4(ctx, { provider: providerFor(ctx), dryRun: !!g.dryRun, ...(days !== undefined ? { days } : {}), ...(periodWindows ? { periodWindows } : {}) });
          cli.print(g, result, renderGa4Result);
          if (result.status === 'partial') process.exitCode = 2;
        } finally {
          ctx.db.close();
        }
      }),
    );

  sync
    .command('inspect')
    .description("URL-inspect priority URLs (or the given URLs): Google's indexed state, not a live test")
    .argument('[urls...]', 'fully qualified URLs under the configured Search Console property')
    .option('--top <n>', 'number of priority URLs when none are given (bounded by google.gsc.urlInspectionMaxPerRun)')
    .action(
      cli.action(async (urls: string[], opts: { top?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = ctxFor(g);
        try {
          const top = parsePositiveInt(opts.top, '--top') ?? ctx.config.google.gsc.urlInspectionMaxPerRun;
          const targets = urls.length ? urls : selectPriorityUrls(ctx, top);
          const result = await inspectUrls(ctx, providerFor(ctx), targets, { max: top });
          cli.print(g, result, renderInspection);
          // Exit 2 (degraded) also when nothing was inspected: that is not a successful inspection run.
          if (result.status === 'partial' || result.status === 'failed' || result.status === 'nothing_inspected') process.exitCode = 2;
        } finally {
          ctx.db.close();
        }
      }),
    );
}
