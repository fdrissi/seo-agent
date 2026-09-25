import type { Command } from 'commander';
import { ownerActor, resolveApprover } from '../../approvals/approver.js';
import { forTerminal } from '../../approvals/display.js';
import { exportSubject } from '../../approvals/export.js';
import { ApprovalService } from '../../approvals/service.js';
import { PROPOSAL_SUBJECT_TYPES } from '../../approvals/subjects.js';
import type { CliRuntime } from '../runtime.js';

/**
 * `export <subject-type> <id>`: write a reviewable manual export package to
 * <workspace>/exports/<site>/<date>-<subject>/. Production-bound exports
 * require --mode EXECUTE and a valid human approval for the exact artifact;
 * the approval is consumed (one-time). Nothing is published anywhere: a human
 * deploys the package and records it with `experiments mark-implemented`.
 * A page under observation by another experiment is refused unless
 * --critical-fix gives a reason (recorded). --dry-run writes nothing (the
 * approval is only looked at). A --revision that differs from the approval's
 * bound revision is refused without touching the approval; only
 * --invalidate-stale (the owner stating the site changed) invalidates it.
 */
export function register(program: Command, cli: CliRuntime): void {
  program
    .command('export <subject-type> <id>')
    .description(`Write a manual export package for a ${PROPOSAL_SUBJECT_TYPES.join(', ')} (production-bound exports need --mode EXECUTE and an approval)`)
    .option('--revision <rev>', 'current source revision (required when the approval is bound to one); a mismatch is refused, never silently invalidates the approval')
    .option('--invalidate-stale', 'with --revision: state that this is the site\'s CURRENT revision, so an approval bound to a different revision is stale and is invalidated (recorded)')
    .option('--allow-unverified-target', 'proceed when the target cannot be rechecked (offline); recorded in the approval and package')
    .option('--critical-fix <reason>', 'critical broken functionality only: export although another experiment is observing the page (recorded; flags it)')
    .option('--as <name>', 'who executes the export (default: OS user)')
    .action(
      cli.action(async (subjectType: string, id: string, opts: { revision?: string; invalidateStale?: boolean; allowUnverifiedTarget?: boolean; criticalFix?: string; as?: string }, c: Command) => {
        const g = cli.globals(c);
        const ctx = cli.context(g);
        try {
          const who = resolveApprover(opts.as);
          const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
          const r = await exportSubject(ctx, gate, {
            subjectType,
            subjectId: id,
            actor: ownerActor(who),
            sourceRevision: opts.revision ?? null,
            allowUnverifiedTarget: !!opts.allowUnverifiedTarget,
            criticalFixReason: opts.criticalFix ?? null,
            dryRun: !!g.dryRun,
            invalidateStale: !!opts.invalidateStale,
          });
          cli.print(g, r, (x) =>
            [
              x.status === 'dry_run'
                ? `Dry run: would write ${x.plannedDir} for ${x.subjectType} ${x.subjectId}${x.productionBound ? ` using approval ${x.approval?.ok ? x.approval.approval.id : '?'}` : ''}. Nothing was written or consumed.`
                : `Exported ${x.subjectType} ${x.subjectId} to ${x.result.exportDir}`,
              x.productionBound ? `Production-bound ${x.actionType} for ${x.targetUrl}; artifact ${x.artifactHash}.` : 'No production change (record export).',
              x.recheck ? `Target recheck: ${x.recheck.status} (${x.recheck.detail})` : '',
              x.isSynthetic ? 'SYNTHETIC demo data.' : '',
              x.criticalFixReason ? `Observation freeze overridden (critical fix: ${x.criticalFixReason}); recorded.` : '',
              ...x.warnings.map((w: string) => `- ${w}`),
              x.status === 'exported' && x.productionBound
                ? `Nothing was published. Deploy the package yourself, then run: npm run cli -- experiments mark-implemented ${x.subjectId} --subject-type ${x.subjectType} --at <ISO time it went live> --revision <revision>`
                : '',
            ]
              .filter(Boolean)
              .map((l: string) => forTerminal(l))
              .join('\n'),
          );
        } finally {
          ctx.db.close();
        }
      }),
    );
}
