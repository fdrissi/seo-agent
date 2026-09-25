import type { Command } from 'commander';
import { AppError } from '../../core/errors.js';
import { formatUsd, toMicros } from '../../core/money.js';
import { renderDoctorReport, runDoctor } from '../../setup/doctor.js';
import type { CliRuntime } from '../runtime.js';

/**
 * `doctor`: runtime, workspace, permissions, configuration, migrations,
 * every integration's status, Qdrant, Playwright, vault, jobs/schedules, and
 * exact next steps.
 *
 *   doctor                                  no network requests at all
 *   doctor --network                        free, read-only checks only
 *   doctor --allow-spend --max-usd <cap>    additionally ONE minimal LLM request, capped (displayed first)
 *   doctor --server                         server checklist: private workspace/database modes FAIL instead of WARN
 */

interface DoctorOpts {
  network?: boolean;
  allowSpend?: boolean;
  maxUsd?: string;
  server?: boolean;
}

export function register(program: Command, cli: CliRuntime): void {
  program
    .command('doctor')
    .description('Check runtime, workspace, config, migrations, and every integration; no network by default and never spends money without --allow-spend --max-usd')
    .option('--network', 'also run free, read-only network checks (never chargeable)')
    .option('--allow-spend', 'allow ONE chargeable check (a minimal LLM Gateway request); requires --max-usd')
    .option('--max-usd <cap>', 'cost cap for the chargeable check, e.g. 0.01')
    .option('--server', 'apply the server checklist (docs/DEPLOYMENT.md): a workspace, data/ directory, or database readable by other users is a failure, not a warning')
    .action(
      cli.action(async (opts: DoctorOpts, cmd: Command) => {
        const g = cli.globals(cmd);
        let spend: { capMicros: number } | null = null;
        if (opts.allowSpend || opts.maxUsd !== undefined) {
          if (!opts.allowSpend) throw new AppError('POLICY_DENIED', '--max-usd only applies together with --allow-spend; nothing was checked.');
          if (!opts.maxUsd || !/^\d+(\.\d{1,6})?$/.test(opts.maxUsd.trim())) {
            throw new AppError('POLICY_DENIED', '--allow-spend needs an explicit cap: --max-usd <amount>, for example 0.01. Nothing was checked.', { hint: 'Run `npm run cli -- models check` (free) first to see verified prices.' });
          }
          const capMicros = toMicros(opts.maxUsd.trim());
          if (capMicros <= 0) throw new AppError('POLICY_DENIED', '--max-usd must be greater than 0.');
          spend = { capMicros };
          cli.io.err(`Chargeable checks allowed: at most ONE minimal LLM Gateway request, cost upper bound capped at ${formatUsd(capMicros)}${g.dryRun ? ' (dry run: nothing is sent)' : ''}.`);
        }
        const paths = cli.workspace(g);
        const report = await runDoctor({
          paths,
          env: cli.env,
          siteId: g.site,
          network: !!opts.network,
          offline: !!g.offline,
          spend,
          dryRun: !!g.dryRun,
          mode: cli.mode(g),
          server: !!opts.server,
        });
        cli.print(g, report, renderDoctorReport);
        if (!report.ok) process.exitCode = 1;
      }),
    );
}
