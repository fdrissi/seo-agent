import type { Command } from 'commander';
import { AppError } from '../../core/errors.js';
import { checkPerformance, selectPriorityPages, type PerformanceCheckResult, type PerfDevice, type PerfReason } from '../../integrations/pagespeed/check.js';
import { performanceStatuses } from '../../integrations/pagespeed/status.js';
import type { IntegrationStatus } from '../../integrations/types.js';
import type { CliRuntime } from '../runtime.js';

function fmtMs(v: number | null | undefined): string {
  return v === null || v === undefined ? 'n/a' : `${Math.round(v)} ms`;
}

export function renderPerf(r: PerformanceCheckResult): string {
  const lines = [`Performance check ${r.url} (${r.device}, reason: ${r.reason}): ${r.status.toUpperCase()} [cache day ${r.cacheDay} UTC]`, `Justification: ${r.justification.detail}`];
  if (r.isSynthetic) lines.push('SYNTHETIC: fixture data.');
  if (r.plan) {
    lines.push(`Would request: ${r.plan.psiRequest ?? '(PSI not requested)'}`, `               ${r.plan.cruxRequest ?? '(CrUX not requested)'}`, `API key configured: ${r.plan.keyConfigured ? 'yes' : 'no'}`);
  }
  const lab = r.lab.data;
  if (lab) {
    lines.push(
      `LAB (Lighthouse ${lab.lighthouseVersion ?? '?'}, ${lab.formFactor ?? r.device}) [${r.lab.status}]: performance score ${lab.performanceScore ?? 'n/a'}; FCP ${fmtMs(lab.metrics.firstContentfulPaintMs)}, LCP ${fmtMs(lab.metrics.largestContentfulPaintMs)}, TBT ${fmtMs(lab.metrics.totalBlockingTimeMs)} (lab proxy), CLS ${lab.metrics.cumulativeLayoutShift ?? 'n/a'}`,
      `  INP: not measured in the lab (field metric).`,
    );
  } else if (r.lab.status !== 'not_requested') lines.push(`LAB: ${r.lab.status}${r.lab.error ? ` - ${r.lab.error}` : ''}`);
  if (r.crux.status !== 'not_requested') {
    const rec = r.crux.data && 'record' in r.crux.data ? r.crux.data.record : null;
    const m = (rec?.metrics ?? {}) as Record<string, { p75: number | null; rating: string | null }>;
    lines.push(`FIELD (CrUX API) [${r.crux.status}] scope: ${r.crux.scope ?? 'unavailable'}${r.crux.error ? ` - ${r.crux.error}` : ''}`);
    if (rec) {
      lines.push(
        `  p75 LCP ${m.largest_contentful_paint?.p75 ?? 'n/a'} (${m.largest_contentful_paint?.rating ?? 'n/a'}), INP ${m.interaction_to_next_paint?.p75 ?? 'n/a'} (${m.interaction_to_next_paint?.rating ?? 'n/a'}), CLS ${m.cumulative_layout_shift?.p75 ?? 'n/a'} (${m.cumulative_layout_shift?.rating ?? 'n/a'}); CWV: ${rec.cwvAssessment}; period ${rec.collectionPeriod.firstDate} .. ${rec.collectionPeriod.lastDate}`,
      );
    }
  }
  if (r.psiField.status !== 'not_requested') lines.push(`FIELD (via PSI, legacy) [${r.psiField.status}] scope: ${r.psiField.scope ?? 'unavailable'}`);
  for (const n of r.notes) lines.push(`Note: ${n}`);
  if (r.nextStep) lines.push(`Next step: ${r.nextStep}`);
  return lines.join('\n');
}

export function register(program: Command, cli: CliRuntime): void {
  const perf = program.command('perf').description('Performance checks (PageSpeed Insights lab + CrUX field data) for priority pages; explicit and cached');

  perf
    .command('check <url>')
    .description('Run an explicit, cached performance check for one own-site priority page or materially changed page (free Google APIs; no budget spend)')
    .option('--device <device>', 'mobile or desktop', 'mobile')
    .option('--reason <reason>', 'priority_page (must be listed by `perf priority`) | material_change (needs a crawl-detected change) | manual (needs --justification)', 'priority_page')
    .option('--justification <text>', 'why this check is needed (required with --reason manual; recorded for every reason)')
    .option('--force', "ignore today's cached result")
    .option('--no-psi', 'skip PageSpeed Insights (lab)')
    .option('--no-crux', 'skip the CrUX API (field)')
    .action(
      cli.action(async (url: string, opts: { device: string; reason: string; justification?: string; force?: boolean; psi?: boolean; crux?: boolean }, cmd: Command) => {
        if (opts.device !== 'mobile' && opts.device !== 'desktop') throw new AppError('VALIDATION_FAILED', '--device must be mobile or desktop');
        if (!['priority_page', 'material_change', 'manual'].includes(opts.reason)) throw new AppError('VALIDATION_FAILED', '--reason must be priority_page, material_change, or manual');
        if (opts.reason === 'manual' && !opts.justification?.trim()) throw new AppError('VALIDATION_FAILED', '--reason manual is an explicit exception and needs --justification "<why>"');
        const sources = [...(opts.psi !== false ? (['psi'] as const) : []), ...(opts.crux !== false ? (['crux'] as const) : [])];
        if (!sources.length) throw new AppError('VALIDATION_FAILED', 'Nothing to do: both --no-psi and --no-crux were given');
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const r = await checkPerformance(ctx, url, {
            device: opts.device as PerfDevice,
            reason: opts.reason as PerfReason,
            ...(opts.justification ? { justification: opts.justification } : {}),
            force: !!opts.force,
            sources,
          });
          cli.print(g, r, renderPerf);
          if (r.status === 'failed') process.exitCode = 1;
        } finally {
          ctx.db.close();
        }
      }),
    );

  perf
    .command('priority')
    .description('List the priority pages eligible for `perf check --reason priority_page` (no network)')
    .option('--limit <n>', 'maximum pages', (v) => Number(v), 10)
    .action(
      cli.action(async (opts: { limit: number }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const pages = selectPriorityPages(ctx, Number.isInteger(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, 50) : 10);
          cli.print(g, { pages }, (r: { pages: Array<{ url: string; why: string }> }) => r.pages.map((p) => `${p.url}  (${p.why})`).join('\n') || '(none)');
        } finally {
          ctx.db.close();
        }
      }),
    );

  perf
    .command('status')
    .description('PageSpeed Insights / CrUX status (use --network for one free CrUX origin query)')
    .option('--network', 'verify the key with one CrUX origin query')
    .action(
      cli.action(async (opts: { network?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const statuses = await performanceStatuses(ctx, { network: !!opts.network });
          cli.print(g, statuses, (r: IntegrationStatus[]) => r.map((s) => `${s.id}: ${s.state} - ${s.detail}${s.nextStep ? `\n  next: ${s.nextStep}` : ''}`).join('\n'));
        } finally {
          ctx.db.close();
        }
      }),
    );
}
