import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { AppError } from '../../core/errors.js';
import { ownerActor, resolveApprover, validateApproverName } from '../../approvals/approver.js';
import { forTerminal, isDemoSite, SYNTHETIC_DEMO_BANNER } from '../../approvals/display.js';
import { defaultTargetChecker } from '../../approvals/export.js';
import { listPublications, markImplemented } from '../../approvals/implementation.js';
import { ApprovalService } from '../../approvals/service.js';
import { ANNOTATION_KINDS, ANNOTATION_SCOPES, recordAnnotation, type AnnotationKind, type AnnotationScope } from '../../experiments/annotations.js';
import { reviewExperiments, type EvaluationOutcome } from '../../experiments/evaluate.js';
import { checkStatementAgainstEffect, learningEvidenceFromExperiment, listLearnings, proposeLearning } from '../../experiments/learnings.js';
import { proposeFromRecommendation } from '../../experiments/propose.js';
import { specifyRecommendationChange, structuredChangeFromInput } from '../../experiments/specify-change.js';
import { findPageByRef, getExperiment, getExperimentChange, listEvaluations, listExperiments, statusHistory } from '../../experiments/repository.js';
import { transitionExperiment } from '../../experiments/status.js';
import { EXPERIMENT_STATUSES, TERMINAL_STATUSES, type ExperimentRecord, type ExperimentStatus, type OutcomeKind } from '../../experiments/types.js';
import { assertAllowed } from '../../approvals/policy.js';
import type { CliRuntime } from '../runtime.js';

function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? 'n/a' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
}

function renderExperimentRow(e: ExperimentRecord): string {
  return forTerminal(`${e.id}  ${e.status.padEnd(23)} ${e.type.padEnd(15)} ${e.primaryMetric.padEnd(18)} ${e.pageId ?? '(no page)'}  review ${e.reviewDate ?? 'n/a'}`);
}

export function renderEvaluation(o: EvaluationOutcome): string {
  const lines = [
    `${o.experimentId}: ${o.result.toUpperCase()}${o.concluded ? ` (concluded; status ${o.statusBefore} -> ${o.statusAfter})` : o.afterConclusion ? ' (informational re-evaluation; recorded outcome unchanged)' : ' (still observing)'}${o.isSynthetic ? ' [SYNTHETIC]' : ''}${o.dryRun ? ' [dry run: not recorded]' : ''}`,
    `  complete data days: ${o.windows.completeDays} (min ${o.windows.minObservationDays}, max ${o.windows.maxObservationDays}); calendar days since implementation: ${o.windows.elapsedDays}`,
  ];
  for (const a of [o.seo, o.conversion]) {
    if (!a) continue;
    const p = a.primary;
    lines.push(
      `  ${a.kind} [${p.label}] ${p.metric}: treated ${p.treated.baseline ?? 'n/a'} -> ${p.treated.observation ?? 'n/a'} (${pct(p.treated.improvement)})` +
        `${p.control ? `, comparison (${p.control.pages} pages) ${pct(p.control.improvement)}` : ', no comparison pages'}, effect ${pct(p.effect)} vs threshold ${pct(p.threshold)} -> ${p.verdict}`,
    );
  }
  for (const gr of o.guardrails) lines.push(`  guardrail ${gr.metric} (max decline ${pct(-gr.maxRelativeDecline)}): ${gr.status}`);
  for (const i of o.interference.items) lines.push(`  interference ${i.blocking ? '[blocking]' : '[flag]'} ${i.kind} ${i.at}: ${i.description}`);
  for (const r of o.reasons) lines.push(`  - ${r}`);
  lines.push(`  ${o.significance.statement}`);
  if (o.learning) lines.push(`  Proposed learning ${o.learning.learningId} (pending approval ${o.learning.approvalId}); it is not a rule until a human approves it.`);
  return lines.map((l) => forTerminal(l)).join('\n');
}

export function register(program: Command, cli: CliRuntime): void {
  const cmd = program.command('experiments').description('Experiment lifecycle: propose, approve (via approvals), implement, observe, evaluate');

  cmd
    .command('list')
    .description('List experiments')
    .option('--status <status...>', `filter by status (${EXPERIMENT_STATUSES.join(', ')})`)
    .action(
      cli.action(async (opts: { status?: string[] }, c: Command) => {
        const g = cli.globals(c);
        const ctx = cli.context(g);
        try {
          for (const s of opts.status ?? []) if (!EXPERIMENT_STATUSES.includes(s as ExperimentStatus)) throw new AppError('VALIDATION_FAILED', `Unknown status "${s}".`);
          const list = listExperiments(ctx.db, ctx.siteId, opts.status ? { statuses: opts.status as ExperimentStatus[] } : {});
          const demo = isDemoSite(ctx);
          cli.print(g, { siteId: ctx.siteId, synthetic: demo, ...(demo ? { banner: SYNTHETIC_DEMO_BANNER } : {}), experiments: list }, (r) =>
            [demo ? SYNTHETIC_DEMO_BANNER : null, r.experiments.length ? r.experiments.map(renderExperimentRow).join('\n') : 'No experiments.'].filter((l): l is string => l !== null).join('\n'),
          );
        } finally {
          ctx.db.close();
        }
      }),
    );

  cmd
    .command('show <id>')
    .description('Show an experiment with its exact change, status history, evaluations, and publications')
    .action(
      cli.action(async (id: string, _o: unknown, c: Command) => {
        const g = cli.globals(c);
        const ctx = cli.context(g);
        try {
          const exp = getExperiment(ctx.db, ctx.siteId, id);
          const result = {
            experiment: exp,
            change: getExperimentChange(ctx.db, ctx.siteId, id),
            history: statusHistory(ctx.db, ctx.siteId, id),
            evaluations: listEvaluations(ctx.db, ctx.siteId, id),
            publications: listPublications(ctx, { subjectType: 'experiment', subjectId: id }),
          };
          cli.print(g, result, (r) =>
            forTerminal([
              `${r.experiment.id} [${r.experiment.status}] ${r.experiment.type}`,
              `  target: ${r.change?.targetUrl ?? '(unknown)'}  action: ${r.change?.actionType ?? '?'}  change hash: ${r.experiment.changeHash}`,
              `  hypothesis: ${r.experiment.hypothesis}`,
              `  change: ${r.experiment.proposedChange}`,
              `  primary metric: ${r.experiment.primaryMetric} (${r.experiment.outcomeKind}); guardrails: ${r.experiment.guardrails.map((x: { metric: string }) => x.metric).join(', ') || 'none'}`,
              `  min observation: ${r.experiment.minObservationDays} days; review date: ${r.experiment.reviewDate ?? 'n/a'}`,
              `  measured scope: ${r.experiment.sampleRequirements.measuredScope ? `page-level totals; Search Console ${r.experiment.sampleRequirements.searchType}${r.experiment.sampleRequirements.segmentKey ? ` segment ${r.experiment.sampleRequirements.segmentKey}` : ' (unsegmented)'}; GA4 ${r.experiment.sampleRequirements.channelView}` : 'not recorded (proposed before scope recording; page-level totals)'}`,
              `  risks: ${r.experiment.risks}`,
              `  rollback: ${r.experiment.rollbackPlan}`,
              `  implemented: ${r.experiment.implementedAt ?? 'not yet'}${r.experiment.sourceRevision ? ` (revision ${r.experiment.sourceRevision})` : ''}; observation start: ${r.experiment.observationStart ?? 'n/a'}`,
              `  comparison pages: ${r.experiment.comparisonPages.length}`,
              '',
              'History:',
              ...r.history.map((h: { at: string; from: string | null; to: string; actor: string; reason: string | null }) => `  ${h.at} ${h.from ?? '-'} -> ${h.to} by ${h.actor}${h.reason ? ` (${h.reason})` : ''}`),
              '',
              `Evaluations: ${r.evaluations.length}`,
              ...r.evaluations.map((e: Record<string, unknown>) => `  #${e.sequence} ${e.evaluatedAt} ${e.result}${e.concluded ? ' (concluded)' : ''}${e.afterConclusion ? ' (after conclusion)' : ''}`),
              `Publications: ${r.publications.length}`,
            ].join('\n')),
          );
        } finally {
          ctx.db.close();
        }
      }),
    );

  cmd
    .command('propose')
    .description('Propose an experiment from a recommendation and request approval for its exact change')
    .requiredOption('--recommendation <id>', 'recommendation id')
    .option('--primary-metric <metric>', 'clicks | impressions | ctr | position | primarySessionRate | primaryKeyEvents | sessions | engagedSessionRate | revenue')
    .option('--outcome-kind <kind>', 'seo_visibility | conversion | both')
    .option('--min-days <n>', 'minimum observation days (default from site config; longer for low-traffic pages)', (v) => Number(v))
    .option('--comparison-pages <n>', 'number of unchanged comparison pages (default 5)', (v) => Number(v))
    .option('--min-effect <fraction>', 'smallest meaningful relative effect, e.g. 0.1 for 10%', (v) => Number(v))
    .option('--revision <rev>', 'current source revision of the site (bound into the approval)')
    .option('--risks <text>', 'risks (required when the recommendation does not state them)')
    .option('--rollback-plan <text>', 'rollback plan (default derived from the change type)')
    .option('--retest-reason <text>', 'documented reason to re-test a change that was already concluded')
    .option('--critical-fix <reason>', 'override the one-change-per-page freeze for critical broken functionality (recorded)')
    .option('--ttl-hours <n>', 'approval expiry in hours', (v) => Number(v))
    .option('--segment <segment-key>', 'Search Console segment_key to measure in both windows (default: unsegmented page totals)')
    .option('--as <name>', 'who proposes (default: OS user)')
    .action(
      cli.action(
        async (
          opts: {
            recommendation: string;
            primaryMetric?: string;
            outcomeKind?: string;
            minDays?: number;
            comparisonPages?: number;
            minEffect?: number;
            revision?: string;
            risks?: string;
            rollbackPlan?: string;
            retestReason?: string;
            criticalFix?: string;
            ttlHours?: number;
            segment?: string;
            as?: string;
          },
          c: Command,
        ) => {
          const g = cli.globals(c);
          const ctx = cli.context(g);
          try {
            if (opts.outcomeKind && !['seo_visibility', 'conversion', 'both'].includes(opts.outcomeKind)) throw new AppError('VALIDATION_FAILED', `Unknown outcome kind "${opts.outcomeKind}".`);
            const who = resolveApprover(opts.as);
            if (g.dryRun) {
              cli.print(g, { dryRun: true, recommendationId: opts.recommendation }, () => `Dry run: would propose an experiment from recommendation ${opts.recommendation} and request approval. Nothing was written.`);
              return;
            }
            const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
            const r = await proposeFromRecommendation(
              ctx,
              gate,
              {
                recommendationId: opts.recommendation,
                requestedBy: ownerActor(who),
                ...(opts.primaryMetric ? { primaryMetric: opts.primaryMetric } : {}),
                ...(opts.outcomeKind ? { outcomeKind: opts.outcomeKind as OutcomeKind } : {}),
                ...(opts.minDays !== undefined ? { minObservationDays: opts.minDays } : {}),
                ...(opts.comparisonPages !== undefined ? { comparisonPages: opts.comparisonPages } : {}),
                ...(opts.minEffect !== undefined ? { minRelativeEffect: opts.minEffect } : {}),
                ...(opts.revision ? { sourceRevision: opts.revision } : {}),
                ...(opts.risks ? { risks: opts.risks } : {}),
                ...(opts.rollbackPlan ? { rollbackPlan: opts.rollbackPlan } : {}),
                ...(opts.retestReason ? { retestReason: opts.retestReason } : {}),
                ...(opts.criticalFix ? { criticalFixReason: opts.criticalFix } : {}),
                ...(opts.ttlHours ? { approvalTtlHours: opts.ttlHours } : {}),
                ...(opts.segment ? { segmentKey: opts.segment } : {}),
              },
              { targetChecker: defaultTargetChecker(ctx) },
            );
            cli.print(g, r, (x) =>
              forTerminal(
                [
                  `Proposed ${x.experiment.id} (${x.experiment.type}, ${x.experiment.primaryMetric}/${x.experiment.outcomeKind}, min ${x.experiment.minObservationDays} days).`,
                  `Measures: ${String((x.experiment.evidence as { successCriteria?: unknown }).successCriteria ?? 'page-level totals')}`,
                  `Approval ${x.approval.id} is ${x.approval.status}. Review the exact change: npm run cli -- approvals show ${x.approval.id}`,
                  ...x.warnings.map((w: string) => `- ${w}`),
                ].join('\n'),
              ),
            );
          } finally {
            ctx.db.close();
          }
        },
      ),
    );

  cmd
    .command('specify-change <recommendation-id>')
    .description('Record ONE concrete change for a recommendation (e.g. after an audit) as a new recommendation revision; nothing is approved or deployed')
    .requiredOption('--by <name>', 'the human recording the change (automation names are refused)')
    .option('--title <text>', 'new page title (may be combined with --meta as one title/meta change)')
    .option('--meta <text>', 'new meta description')
    .option('--section-file <file>', 'Markdown file with ONE content section to publish on the page')
    .option('--redirect-to <url>', 'redirect the page to this absolute URL')
    .option('--note <text>', 'why this is the change (recorded)')
    .option('--hypothesis <text>', 'the hypothesis to test (required for an experiment when the recommendation states none)')
    .action(
      cli.action(async (recommendationId: string, opts: { by: string; title?: string; meta?: string; sectionFile?: string; redirectTo?: string; note?: string; hypothesis?: string }, c: Command) => {
        const g = cli.globals(c);
        const ctx = cli.context(g);
        try {
          let sectionMarkdown: string | null = null;
          if (opts.sectionFile) {
            const file = path.resolve(opts.sectionFile);
            let size: number;
            try {
              const st = statSync(file);
              if (!st.isFile()) throw new Error('not a file');
              size = st.size;
            } catch {
              throw new AppError('VALIDATION_FAILED', `Section file ${file} is not a readable file.`);
            }
            if (size > 400_000) throw new AppError('VALIDATION_FAILED', `Section file ${file} is ${size} bytes; at most 400000 are allowed.`);
            sectionMarkdown = readFileSync(file, 'utf8');
          }
          const input = { recommendationId, by: opts.by, title: opts.title ?? null, metaDescription: opts.meta ?? null, sectionMarkdown, redirectTo: opts.redirectTo ?? null, note: opts.note ?? null, hypothesis: opts.hypothesis ?? null };
          if (g.dryRun) {
            validateApproverName(opts.by);
            const change = structuredChangeFromInput(input);
            cli.print(g, { dryRun: true, recommendationId, change }, () => forTerminal(`Dry run: would record a ${change.kind} change for recommendation ${recommendationId} as a new revision. Nothing was written.`));
            return;
          }
          const r = specifyRecommendationChange(ctx, input);
          cli.print(g, r, (x) =>
            forTerminal(
              [
                `Recorded recommendation ${x.recommendation.id} (${x.change.kind} change on ${x.targetUrl}); ${x.supersededId} is now superseded${x.invalidatedApprovals ? ` and ${x.invalidatedApprovals} of its live approval(s) were invalidated` : ''}.`,
                `Exact change: ${x.recommendation.proposed_change}`,
                `Action type ${x.actionType}; change hash ${x.changeHash}.`,
                ...x.warnings.map((w: string) => `- ${w}`),
                `Next: npm run cli -- experiments propose --recommendation ${x.recommendation.id}   (or: approvals request recommendation ${x.recommendation.id})`,
              ].join('\n'),
            ),
          );
        } finally {
          ctx.db.close();
        }
      }),
    );

  cmd
    .command('review')
    .description('Evaluate due observing experiments (observational before/after with comparison pages); every evaluation is recorded')
    .option('--id <id...>', 'only these experiments (evaluated even if not yet due)')
    .option('--all', 'also evaluate observing experiments that are not yet due (records a "collecting" evaluation)')
    .option('--conclude', 'conclude experiments past their minimum period even with insufficient evidence (-> inconclusive)')
    .option('--as <name>', 'who concludes (with --conclude; default: OS user)')
    .action(
      cli.action(async (opts: { id?: string[]; all?: boolean; conclude?: boolean; as?: string }, c: Command) => {
        const g = cli.globals(c);
        const ctx = cli.context(g);
        try {
          const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
          const actor = opts.conclude ? ownerActor(resolveApprover(opts.as)) : 'system:experiments-review';
          const r = reviewExperiments(ctx, { ...(opts.id ? { experimentIds: opts.id } : {}), includeNotDue: !!opts.all, conclude: !!opts.conclude, dryRun: !!g.dryRun, actor, gate });
          cli.print(g, r, (x) =>
            [
              x.evaluated.length ? x.evaluated.map(renderEvaluation).join('\n\n') : x.notDue.length ? 'No observing experiment is due for evaluation yet.' : 'No experiments are being observed.',
              x.notDue.length ? `Not yet due: ${x.notDue.map((n: { id: string; dueDate: string }) => `${n.id} (due ${n.dueDate})`).join(', ')}` : '',
              x.awaitingImplementation.length ? `\nAwaiting implementation: ${x.awaitingImplementation.map((a: { id: string }) => a.id).join(', ')} (record with experiments mark-implemented once live)` : '',
              ...x.errors.map((e: { experimentId: string; error: string }) => `Error evaluating ${e.experimentId}: ${e.error}`),
            ]
              .filter(Boolean)
              .join('\n'),
          );
        } finally {
          ctx.db.close();
        }
      }),
    );

  cmd
    .command('mark-implemented <id>')
    .description('Record that a human deployed an approved change; starts the observation window at the actual implementation time')
    .requiredOption('--at <iso>', 'when the change actually went live, ISO-8601 with zone (e.g. 2026-09-20T14:30:00Z)')
    .requiredOption('--revision <rev>', 'deployment/source revision (commit, CMS revision)')
    .option('--url <url>', 'live URL (must equal the approved target)')
    .option('--subject-type <type>', 'experiment (default), draft, or recommendation', 'experiment')
    .option('--critical-fix <reason>', 'record a critical fix on a page with an experiment under observation (flags that experiment; defaults to the reason given at export/proposal)')
    .option('--deployed-without-export <reason>', 'the change went live without the EXECUTE-mode export (no pre-execution recheck ran); needs --mode EXECUTE, recorded')
    .option('--as <name>', 'who records it (default: OS user)')
    .action(
      cli.action(async (id: string, opts: { at: string; revision: string; url?: string; subjectType: string; criticalFix?: string; deployedWithoutExport?: string; as?: string }, c: Command) => {
        const g = cli.globals(c);
        const ctx = cli.context(g);
        try {
          const who = resolveApprover(opts.as);
          if (g.dryRun) {
            cli.print(g, { dryRun: true }, () => `Dry run: would record ${opts.subjectType} ${id} as implemented at ${opts.at} (revision ${opts.revision}). Nothing was written.`);
            return;
          }
          const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
          const r = await markImplemented(ctx, gate, {
            subjectType: opts.subjectType,
            subjectId: id,
            implementedAt: opts.at,
            revision: opts.revision,
            url: opts.url ?? null,
            recordedBy: who,
            criticalFixReason: opts.criticalFix ?? null,
            deployedWithoutExport: opts.deployedWithoutExport ?? null,
          });
          cli.print(g, r, (x) =>
            [
              `Recorded publication ${x.publicationId} for ${x.subjectType} ${x.subjectId} at ${x.implementedAt} (revision ${x.sourceRevision}).`,
              x.approvalConsumedNow
                ? `Approval ${x.approvalId} consumed now (one-time), WITHOUT an export: the pre-execution target recheck was skipped (${x.preExecution.deployedWithoutExport}).`
                : `Approval ${x.approvalId} was executed by the export (${x.preExecution.exportDir ?? 'package'}; target recheck: ${x.preExecution.recheck ?? 'unknown'}).`,
              `Live verification: ${x.verification.status}${x.verification.reason ? ` (${x.verification.reason})` : ''}.`,
              x.verification.coverage ? `Body coverage: ${x.verification.coverage.summary}.` : '',
              `Before snapshot: ${x.beforeSnapshotRef ?? 'none'}; after snapshot: ${x.afterSnapshotRef ?? 'none (not fetched)'}.`,
              x.experiment ? `Experiment ${x.experiment.id} is ${x.experiment.status}; observation started ${x.experiment.observationStart}; review ${x.experiment.reviewDate}.` : '',
              ...x.warnings.map((w: string) => `- ${w}`),
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

  cmd
    .command('annotate')
    .description('Record an external or site change that can interfere with experiments')
    .requiredOption('--scope <scope>', ANNOTATION_SCOPES.join(' | '))
    .requiredOption('--kind <kind>', ANNOTATION_KINDS.join(' | '))
    .requiredOption('--at <iso>', 'when it happened, ISO-8601 with zone')
    .requiredOption('--description <text>', 'what changed')
    .option('--page <url-or-id>', 'page (required for --scope page)')
    .option('--source <text>', 'reference, e.g. a deploy id or announcement URL')
    .option('--overrides-freeze', 'this change overrode an observation freeze (critical fix)')
    .option('--as <name>', 'who records it (default: OS user)')
    .action(
      cli.action(async (opts: { scope: string; kind: string; at: string; description: string; page?: string; source?: string; overridesFreeze?: boolean; as?: string }, c: Command) => {
        const g = cli.globals(c);
        const ctx = cli.context(g);
        try {
          assertAllowed(ctx.mode, 'record_annotation');
          const who = resolveApprover(opts.as);
          let pageId: string | null = null;
          if (opts.page) {
            const page = findPageByRef(ctx.db, ctx.siteId, opts.page);
            if (!page) throw new AppError('NOT_FOUND', `Page ${opts.page} is not known for site ${ctx.siteId}.`);
            pageId = page.id;
          }
          if (g.dryRun) {
            cli.print(g, { dryRun: true }, () => `Dry run: would record a ${opts.scope} ${opts.kind} annotation at ${opts.at}.`);
            return;
          }
          const r = recordAnnotation(ctx.db, ctx.clock, {
            siteId: ctx.siteId,
            scope: opts.scope as AnnotationScope,
            kind: opts.kind as AnnotationKind,
            occurredAt: opts.at,
            description: opts.description,
            pageId,
            source: opts.source ?? null,
            overridesFreeze: !!opts.overridesFreeze,
            recordedBy: ownerActor(who),
          });
          cli.print(g, r, (x) =>
            [`Recorded annotation ${x.annotation.id} (${x.annotation.scope}/${x.annotation.kind} at ${x.annotation.occurredAt}).`, x.affectedExperiments.length ? `Flags experiments: ${x.affectedExperiments.map((a: { id: string }) => a.id).join(', ')}` : 'No active experiment is affected.'].join('\n'),
          );
        } finally {
          ctx.db.close();
        }
      }),
    );

  cmd
    .command('cancel <id>')
    .description('Cancel an experiment that has not concluded (recorded with a reason)')
    .requiredOption('--reason <text>', 'why')
    .option('--as <name>', 'who cancels (default: OS user)')
    .action(
      cli.action(async (id: string, opts: { reason: string; as?: string }, c: Command) => {
        const g = cli.globals(c);
        const ctx = cli.context(g);
        try {
          const who = resolveApprover(opts.as);
          const exp = getExperiment(ctx.db, ctx.siteId, id);
          if (TERMINAL_STATUSES.includes(exp.status)) throw new AppError('CONFLICT', `Experiment ${id} already concluded as ${exp.status}; its outcome is not rewritten.`);
          if (g.dryRun) {
            cli.print(g, { dryRun: true }, () => `Dry run: would cancel ${id} (${exp.status}).`);
            return;
          }
          const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
          const updated = transitionExperiment(ctx.db, ctx.clock, { siteId: ctx.siteId, experimentId: id, to: 'cancelled', actor: ownerActor(who), reason: opts.reason });
          const invalidated = gate.invalidateSubject(ctx.siteId, 'experiment', id, `experiment cancelled: ${opts.reason}`, { actor: ownerActor(who) });
          cli.print(g, { experiment: updated, invalidatedApprovals: invalidated }, (r) =>
            `Cancelled ${r.experiment.id}.${r.invalidatedApprovals ? ` Invalidated ${r.invalidatedApprovals} live approval(s).` : ''}${exp.status === 'observing' ? ' The change is live: roll it back if needed (production action) and record it with experiments annotate.' : ''}`,
          );
        } finally {
          ctx.db.close();
        }
      }),
    );

  cmd
    .command('learnings')
    .description('List proposed/approved learnings (scoped; never universal rules)')
    .option('--status <status>', 'proposed | approved | rejected | superseded')
    .action(
      cli.action(async (opts: { status?: string }, c: Command) => {
        const g = cli.globals(c);
        const ctx = cli.context(g);
        try {
          const list = listLearnings(ctx.db, ctx.siteId, opts.status as 'proposed' | undefined);
          cli.print(g, { learnings: list }, (r) => (r.learnings.length ? r.learnings.map((l: { id: string; status: string; scope: string; statement: string }) => `${l.id} [${l.status}] (${l.scope}) ${l.statement}`).join('\n') : 'No learnings.'));
        } finally {
          ctx.db.close();
        }
      }),
    );

  cmd
    .command('propose-learning <experiment-id>')
    .description('Propose a scoped learning backed by an experiment evaluation (needs approval to be promoted)')
    .requiredOption('--statement <text>', 'what was observed')
    .requiredOption('--scope <text>', 'where it applies, e.g. "site:<id>; page type: article; change: title rewrite"')
    .option('--as <name>', 'who proposes (default: OS user)')
    .action(
      cli.action(async (experimentId: string, opts: { statement: string; scope: string; as?: string }, c: Command) => {
        const g = cli.globals(c);
        const ctx = cli.context(g);
        try {
          assertAllowed(ctx.mode, 'write_local_report');
          const who = resolveApprover(opts.as);
          getExperiment(ctx.db, ctx.siteId, experimentId);
          // Evidence rules: a concluded evaluation with a measured primary result (never "collecting" or insufficient data).
          const { evidence, summary } = learningEvidenceFromExperiment(ctx.db, ctx.siteId, experimentId);
          const flags = checkStatementAgainstEffect(opts.statement, summary);
          if (g.dryRun) {
            cli.print(g, { dryRun: true, evidenceSummary: summary, statementFlags: flags }, () =>
              forTerminal(['Dry run: would propose the learning and request a learning_promotion approval.', ...flags.map((f) => `- Flag: ${f}`)].join('\n')),
            );
            return;
          }
          const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
          const r = proposeLearning(ctx.db, ctx.clock, gate, { siteId: ctx.siteId, statement: opts.statement, scope: opts.scope, evidence, experimentId, requestedBy: ownerActor(who) });
          cli.print(g, { ...r, evidenceSummary: summary, statementFlags: flags }, (x) =>
            forTerminal(
              [
                `Proposed learning ${x.learning.id}; approval ${x.approval.id} is pending (approvals show ${x.approval.id}).`,
                `Evidence: evaluation ${summary.evaluationId} ${summary.result}; ${summary.metric} ${summary.verdict}, effect ${pct(summary.effect)}${summary.windows ? `; windows ${summary.windows.baseline} vs ${summary.windows.observation}` : ''}.`,
                ...x.statementFlags.map((f: string) => `- Flag: ${f}`),
              ].join('\n'),
            ),
          );
        } finally {
          ctx.db.close();
        }
      }),
    );
}
