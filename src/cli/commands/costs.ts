import type { Command } from 'commander';
import { validateApproverName } from '../../approvals/approver.js';
import { forTerminal } from '../../approvals/display.js';
import { assertAllowed } from '../../approvals/policy.js';
import { AppError } from '../../core/errors.js';
import { formatUsd, toMicros } from '../../core/money.js';
import { SYNTHETIC_DEMO_COSTS, type BudgetService } from '../../budgets/budget-service.js';
import { COMPUTED_COST_NOTE, type SpendReport } from '../../budgets/types.js';
import type { CliRuntime } from '../runtime.js';

type OpenReservation = ReturnType<BudgetService['listUnresolved']>[number];

/** "$1.00", or "at most $1.00 (unverified)" while charges without an upper bound are outstanding. */
function remaining(micros: number, verified: boolean): string {
  return verified ? formatUsd(micros) : `at most ${formatUsd(micros)} (unverified)`;
}

/** Legend for the reported / computed columns (spec 25: never present an app-computed figure as a provider charge). */
export const SPEND_COLUMNS_LEGEND = `Actual spend = reported + computed. reported: the charge reported by the provider or gateway (or entered by a named human from the provider's billing history). computed: ${COMPUTED_COST_NOTE} (the provider reported no charge); it still counts toward the limits.`;

/**
 * True when the spend belongs to a demo workspace or demo site: every amount
 * is SYNTHETIC DEMO DATA and nothing was charged.
 */
export function isSyntheticSpend(r: Pick<SpendReport, 'synthetic'>, demoContext = false): boolean {
  return r.synthetic === true || demoContext;
}

export function renderSpend(r: SpendReport, opts: { synthetic?: boolean } = {}): string {
  const synthetic = isSyntheticSpend(r, opts.synthetic === true);
  const lines: string[] = [];
  if (synthetic) lines.push(`${SYNTHETIC_DEMO_COSTS} (demo workspace: every amount below comes from synthetic fixtures; nothing was sent to a provider or charged).`, '');
  lines.push(`Spend for ${r.siteId}: month ${r.periodMonth}, week ${r.periodWeek} (${r.timeZone})${synthetic ? ' [SYNTHETIC]' : ''}`, '');
  lines.push('provider      reported   computed   reserved   est.only   unknown  committed  limit      remaining');
  for (const p of r.providers) {
    const basis = r.costBasis?.find((b) => b.provider === p.provider);
    // Older report objects without a cost basis: the whole actual amount is shown as reported.
    const computed = basis?.computedMicros ?? 0;
    const reported = basis ? basis.reportedMicros : p.actualMicros;
    lines.push(
      [
        p.provider.padEnd(13),
        formatUsd(reported).padEnd(10),
        formatUsd(computed).padEnd(10),
        formatUsd(p.reservedMicros).padEnd(10),
        formatUsd(p.estimatedMicros).padEnd(10),
        String(p.unknownCount).padEnd(8),
        formatUsd(p.committedMicros).padEnd(10),
        formatUsd(p.limitMicros).padEnd(10),
        remaining(p.remainingMicros, p.remainingVerified),
      ].join(' ') + (synthetic && p.committedMicros > 0 ? ' [SYNTHETIC]' : ''),
    );
    if (computed > 0) lines.push(`  computed: ${formatUsd(computed)} over ${basis!.computedCount} request(s), ${COMPUTED_COST_NOTE}`);
    if (!synthetic && basis && basis.syntheticCount > 0) lines.push(`  [SYNTHETIC] ${formatUsd(basis.syntheticMicros)} of the committed amount is from ${basis.syntheticCount} fixture/sandbox/demo reservation(s): no real charge`);
    if (p.unboundedUnknownCount > 0) lines.push(`  ${p.unboundedUnknownCount} approved charge(s) with NO upper bound: amount unknown, not included above`);
    if (p.weekly) lines.push(`  weekly: committed ${formatUsd(p.weekly.committedMicros)} of ${formatUsd(p.weekly.limitMicros)}`);
  }
  lines.push('', `Combined: ${formatUsd(r.combined.committedMicros)} of ${formatUsd(r.combined.limitMicros)} (remaining ${remaining(r.combined.remainingMicros, r.combined.remainingVerified)})${synthetic ? ' [SYNTHETIC]' : ''}`);
  lines.push('', SPEND_COLUMNS_LEGEND);
  lines.push('', ...r.notes.map((n) => `Note: ${n}`));
  return lines.join('\n');
}

/** The commands that settle one open reservation after checking the provider's billing/usage history. */
export function reconcileCommands(id: string): string[] {
  return [
    `npm run cli -- costs reconcile ${id} --actual-usd <amount from provider history> --evidence "<what the provider history shows>" --by "<your name>"`,
    `npm run cli -- costs reconcile ${id} --not-charged --evidence "<provider history shows no charge for this request>" --by "<your name>"`,
  ];
}

function renderOpen(o: OpenReservation): string {
  const amount = o.unbounded ? 'amount unknown (no upper bound)' : o.cost_status === 'unknown' ? `holding ${formatUsd(o.estimated_usd_micros)} (actual unknown)` : formatUsd(o.estimated_usd_micros);
  const [withAmount, notCharged] = reconcileCommands(o.id);
  return [
    `  ${o.id} ${o.provider} ${o.status} ${amount} ${o.purpose}${o.provider_request_id ? ` (request ${o.provider_request_id})` : ''}${o.synthetic ? ' [SYNTHETIC: no real charge]' : ''}`,
    ...(o.status === 'unresolved' || o.cost_status === 'unknown'
      ? [`    check the provider's billing/usage history for this request, then settle it:`, `    ${withAmount}`, `    ${notCharged}`]
      : [`    still reserved (in flight or awaiting the provider's report); if it is stuck, check the provider history and settle it: ${withAmount}`]),
  ].join('\n');
}

export function register(program: Command, cli: CliRuntime): void {
  const costs = program
    .command('costs')
    .description('Show actual, estimated, reserved, and unknown spend against configured budgets; reconcile unresolved charges')
    .option('--unresolved', 'list reservations that are still reserved or unresolved, with the command that reconciles each')
    .action(
      cli.action(async (opts: { unresolved?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          // A demo workspace (demo profile) or demo site: every amount is synthetic, and the output says so in text and JSON.
          const base = ctx.budgets.report(ctx.siteId);
          const synthetic = isSyntheticSpend(base, ctx.synthetic || ctx.config.profile === 'demo');
          const report: SpendReport = { ...base, synthetic };
          if (opts.unresolved) {
            const open = ctx.budgets.listUnresolved(ctx.siteId);
            cli.print(g, { synthetic, report, open: open.map((o) => ({ ...o, reconcileCommands: reconcileCommands(o.id) })) }, (r: { report: SpendReport; open: OpenReservation[] }) =>
              forTerminal(`${renderSpend(r.report)}\n\nOpen reservations:\n${r.open.map(renderOpen).join('\n') || '  (none)'}`),
            );
          } else cli.print(g, report, (r: SpendReport) => forTerminal(renderSpend(r)));
        } finally {
          ctx.db.close();
        }
      }),
    );

  costs
    .command('reconcile <reservation-id>')
    .description('Settle an unresolved or unknown charge from the provider billing/usage history (audited; needs a named human and evidence)')
    .option('--actual-usd <amount>', 'the charged amount shown in the provider history, decimal USD (e.g. "0.0132")')
    .option('--not-charged', 'the provider history shows NO charge for this request (recorded as $0 only with this explicit statement)')
    .requiredOption('--evidence <note>', 'what the provider history shows (e.g. "billing page, 2026-09-21 14:02 UTC: task 0921-xxxx charged $0.0012")')
    .requiredOption('--by <name>', 'the human reconciling (automation names are refused)')
    .action(
      cli.action(async (id: string, opts: { actualUsd?: string; notCharged?: boolean; evidence: string; by: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          assertAllowed(ctx.mode, 'write_local_report');
          const by = validateApproverName(opts.by);
          if ((opts.actualUsd !== undefined) === !!opts.notCharged) {
            throw new AppError('VALIDATION_FAILED', 'Give exactly one of --actual-usd <amount> or --not-charged.', {
              hint: 'An unknown charge is never turned into $0 silently: state the amount from the provider history, or state explicitly that it was not charged.',
            });
          }
          let actualMicros: number | null = null;
          if (opts.actualUsd !== undefined) {
            try {
              actualMicros = toMicros(opts.actualUsd);
            } catch {
              throw new AppError('VALIDATION_FAILED', `--actual-usd "${opts.actualUsd}" is not a decimal USD amount (e.g. "0.0132").`);
            }
            if (actualMicros < 0) throw new AppError('VALIDATION_FAILED', '--actual-usd cannot be negative.');
          }
          const open = ctx.budgets.listUnresolved(ctx.siteId).find((o) => o.id === id);
          if (g.dryRun) {
            if (!open) throw new AppError('NOT_FOUND', `No open (reserved or unresolved) reservation ${id} for site ${ctx.siteId}.`);
            cli.print(g, { dryRun: true, reservation: open, actualMicros, notCharged: !!opts.notCharged }, () =>
              forTerminal(`Dry run: ${by} would reconcile ${id} (${open.provider}, ${open.status}) as ${opts.notCharged ? 'NOT CHARGED ($0, per provider history)' : formatUsd(actualMicros!)}. Nothing was written.`),
            );
            return;
          }
          const r = ctx.budgets.reconcileManual(id, { actualMicros, notCharged: !!opts.notCharged, evidence: opts.evidence, by });
          cli.print(g, { reservationId: id, ...r }, (x) =>
            forTerminal(
              [
                `Reconciled ${id} (${x.provider}; was ${x.previousStatus}): ${x.notCharged ? 'not charged ($0 per the provider history you cited)' : `${formatUsd(x.actualMicros)} actual`}; recorded by ${by} with your evidence note (audited).`,
                x.overshootMicros ? `The actual amount is ${formatUsd(x.overshootMicros)} above the reserved estimate; check the price configuration.` : '',
              ]
                .filter(Boolean)
                .join('\n'),
            ),
          );
        } finally {
          ctx.db.close();
        }
      }),
    );
}
