import type { Command } from 'commander';
import { createServices } from '../../app/services.js';
import { assertAllowed } from '../../approvals/policy.js';
import { AppError, ValidationError } from '../../core/errors.js';
import { formatUsd, toMicros } from '../../core/money.js';
import type { IntegrationStatus } from '../../integrations/types.js';
import { HEURISTIC_METHOD, llmSignalClassifier, type LlmClassifierOutcome, type SignalClassifier } from '../../integrations/apify/normalize.js';
import { importActorSchema, inspectActor, type ImportResult, type InspectResult } from '../../integrations/apify/schema.js';
import {
  TIME_RANGE_ORDER,
  confirmNotAccepted,
  listApifyRuns,
  planContentResearchBatch,
  resumeApifyRuns,
  runContentResearch,
  runContentResearchBatch,
  type ApifyRunListing,
  type ConfirmNotAcceptedResult,
  type ContentResearchResult,
  type ResearchBatchOptions,
  type ResearchBatchResult,
  type ResumeReport,
} from '../../integrations/apify/runs.js';
import type { RedditTimeRange } from '../../integrations/apify/reddit-adapter.js';
import { apifyStatus } from '../../integrations/apify/status.js';
import type { CliRuntime } from '../runtime.js';

/**
 * `apify` commands for the Reddit Scraper actor (9sHOY9RzPYGjmTHo8):
 *   apify status [--network]            honest integration status (free reads only)
 *   apify inspect [--build <n>]         identity, pricing, builds, schema, drift (free reads)
 *   apify import-schema <file>          import an exported input schema (unverified unless attested)
 *   apify test --confirm-spend --max-usd <cap> [--term <text>]
 *                                        one minimal paid test run, cap shown before starting (needs --mode RESEARCH)
 *   apify research [--term <t>...] [--community <name>...] --confirm-spend --max-usd <usd> [--classify-with-llm --llm-max-usd <usd>]
 *                                        paid content research with the configured limits; one bounded run per
 *                                        community (research.subreddits); plan shown and bound before starting
 *                                        (needs --mode RESEARCH)
 *   apify runs [--resume]               list local runs; resume/reconcile pending ones
 *   apify runs --confirm-not-accepted <id>
 *                                        owner confirmation that an ambiguous submission never started ($0, source manual)
 */

const EXIT_BY_STATUS: Partial<Record<ContentResearchResult['status'], number>> = {
  confirmation_required: 2,
  policy_denied: 1,
  missing_credentials: 3,
  disabled: 3,
  budget_exceeded: 3,
  budget_unknown_price: 3,
  misconfigured: 1,
  rejected: 1,
  submission_rejected: 1,
  quarantined: 1,
  ambiguous: 1,
  offline: 1,
  abandoned: 1,
};

function usdArg(v: string, flag: string): number {
  if (!/^\d+(\.\d{1,6})?$/.test(v)) throw new ValidationError(`${flag} must be a decimal USD amount such as 0.10`);
  const m = toMicros(v);
  if (m <= 0) throw new ValidationError(`${flag} must be greater than 0`);
  return m;
}

export function renderResearch(r: ContentResearchResult): string {
  const lines: string[] = [`Status: ${r.status}`, `  ${r.detail}`];
  if (r.nextStep) lines.push(`Next step: ${r.nextStep}`);
  if (r.errors?.length) lines.push('Problems:', ...r.errors.map((e) => `  - ${e}`));
  const p = r.plan;
  if (p) {
    lines.push(
      '',
      `Plan: actor ${p.actorId}, pinned build ${p.build} (schema ${p.schemaHash.slice(0, 12)})`,
      `  input: ${JSON.stringify(p.input)}`,
      `  bounds: posts <= ${p.bounds.posts}, comments <= ${p.bounds.comments}, results <= ${p.bounds.results}; timeout ${p.runOptions.timeoutSecs}s; memory ${p.runOptions.memoryMbytes} MB`,
      `  provider-side cap (maxTotalChargeUsd): ${formatUsd(p.capMicros)}; estimated upper bound: ${formatUsd(p.estimate.upperBoundMicros)}; reservation: ${formatUsd(p.reserveMicros)}`,
      `  pricing: ${p.pricingSource}${p.pricingRetrievedAt ? ` (retrieved ${p.pricingRetrievedAt})` : ''}; ${p.estimate.basis.detail}`,
      `  time window: ${p.timeWindow.timeRange}${p.timeWindow.earliestDate ? ` (date filters no earlier than ${p.timeWindow.earliestDate})` : ''}; cap policy ${p.capPolicy}${p.truncationPossible ? ' (the cap could stop the run early: a cap-stopped run is quarantined as partial)' : ''}`,
      `  forced off: ${p.forcedOff.map((f) => `${f.field}=${JSON.stringify(f.value)}`).join(', ') || '(none in schema)'}`,
      `  kept absent: ${p.keptAbsent.map((f) => f.field).join(', ') || '(none)'}`,
    );
    if (p.boundsLowered) lines.push(`  bounds lowered to fit the cap: ${p.boundsLowered.from.posts}+${p.boundsLowered.from.comments} -> ${p.boundsLowered.to.posts}+${p.boundsLowered.to.comments} (posts+comments)`);
    if (p.unmappedFields.length) lines.push(`  unmapped fields (actor defaults): ${p.unmappedFields.join(', ')}`);
  }
  if (r.apifyRunId) lines.push('', `Run: ${r.apifyRunId}${r.remoteRunId ? ` (Apify ${r.remoteRunId}, ${r.remoteStatus ?? 'unknown'})` : ''}${r.resumedExisting ? ' [resumed existing run]' : ''}`);
  if (r.quarantineReason) lines.push(`  quarantined: ${r.quarantineReason}`);
  if (r.items) lines.push(`  items: fetched ${r.items.fetched} (dataset total ${r.items.datasetTotal ?? 'unknown'}), normalized ${r.items.normalized}, duplicates ${r.items.duplicates}`);
  if (r.signals) lines.push(`  signals: ${r.signals.created} new, ${r.signals.duplicates} duplicate, ${r.signals.unclassified} unclassified ${JSON.stringify(r.signals.byType)}`);
  if (r.cost) lines.push(`  cost: ${r.cost.costStatus}; reserved ${formatUsd(r.cost.reservedMicros)}, cap ${formatUsd(r.cost.capMicros)}, actual ${formatUsd(r.cost.actualMicros)}`);
  if (r.warnings.length) lines.push('', 'Warnings:', ...r.warnings.map((w) => `  - ${w}`));
  return lines.join('\n');
}

export interface ClassificationReport {
  requested: 'llm' | 'heuristic';
  /** What classified the items: the LLM (with heuristic fallback for skipped items) or the heuristics only. */
  note: string;
  outcomes: LlmClassifierOutcome[];
  llmCapMicros: number | null;
}

export function renderResearchBatch(r: ResearchBatchResult & { classification?: ClassificationReport; confirmed?: boolean }): string {
  const lines: string[] = [`Apify content research: ${r.status}`, `  ${r.detail}`];
  lines.push(
    `Batch cap: ${formatUsd(r.totalCapMicros)} total; per run ${formatUsd(r.perRunCapMicros)}; planned provider caps ${formatUsd(r.plannedCapMicros)}`,
    `Plan hash: ${r.planHash ?? '(unavailable: not every run could be planned)'}`,
  );
  for (const e of r.errors) lines.push(`Problem: ${e}`);
  for (const w of r.warnings) lines.push(`Note: ${w}`);
  if (r.classification) lines.push(`Classification: ${r.classification.note}`);
  for (const run of r.runs) {
    lines.push('', `=== Community: ${run.community ?? '(all of Reddit: no community restriction)'} ===`, renderResearch(run.result));
  }
  return lines.join('\n');
}

function renderInspect(r: InspectResult): string {
  const lines = [
    `Actor ${r.identity.id}: ${r.identity.username ?? '?'}/${r.identity.name ?? '?'} "${r.identity.title ?? ''}"`,
    `  public ${r.identity.isPublic ?? 'unknown'}, deprecated ${r.identity.isDeprecated ?? 'unknown'}, notice ${r.identity.notice ?? 'none'}, modified ${r.identity.modifiedAt ?? 'unknown'}`,
    ...r.identityWarnings.map((w) => `  WARNING: ${w}`),
    '',
    r.pricing ? `Pricing: ${r.pricing.model} since ${r.pricing.startedAt ?? 'unknown'}` : 'Pricing: unknown',
    ...(r.pricing?.events ?? []).map((e) => `  ${e.key}${e.title ? ` (${e.title})` : ''}: ${e.price}${e.oneTime ? ' [one-time]' : ''}${e.primary ? ' [primary]' : ''}`),
    `  note: ${r.pricingNote}`,
    '',
  ];
  const b = (label: string, x: InspectResult['latestBuild']) => {
    if (!x) return [`${label}: none`];
    return [
      `${label}: ${x.buildNumber ?? '?'} (id ${x.buildId}, status ${x.status ?? '?'}) schema via ${x.schemaSource}${x.schemaHash ? ` hash ${x.schemaHash.slice(0, 12)}` : ''}; verified ${x.verified}; stored ${x.created ? 'new' : 'existing'}`,
      `  output schema: ${x.outputSchema ? `${x.outputSchema.fieldCount} dataset fields; missing used fields: ${x.outputSchema.missingUsedFields.join(', ') || 'none'}` : 'not published'}`,
      ...(x.compatibility ? [`  adapter: ${x.compatibility.ok ? 'compatible' : 'BLOCKED'}; forced off ${x.compatibility.forcedOff.map((f) => f.field).join(', ') || 'none'}`, ...x.compatibility.errors.map((e) => `  blocker: ${e}`)] : []),
      `  README: ${x.readme ? `sha256 ${x.readme.sha256.slice(0, 12)} (${x.readme.length} chars, retrieved ${x.readme.retrievedAt}); load-bearing passages found: ${Object.entries(x.readme.passages).filter(([, h]) => h).map(([k]) => k).join(', ') || 'none'}` : 'not retrieved'}`,
      ...(x.blockers ?? []).map((b) => `  BLOCKER: ${b}`),
      ...x.problems.map((p) => `  problem: ${p}`),
    ];
  };
  lines.push(...b('Latest build', r.latestBuild));
  lines.push(`Pinned build: ${r.pinnedBuild.configured ?? '(none)'} [${r.pinnedBuild.source}] ${r.pinnedBuild.note}`);
  for (const d of r.drift) {
    lines.push(`Schema drift ${d.fromBuild ?? '?'} -> ${d.toBuild ?? '?'}: +[${d.diff.added.join(', ')}] -[${d.diff.removed.join(', ')}] ~[${d.diff.changed.join(', ')}]`, `  ${d.note}`);
    for (const e of d.compatibility.errors) lines.push(`  blocker in newer build: ${e}`);
  }
  if (r.readmeDrift) {
    const d = r.readmeDrift;
    lines.push(`README drift ${d.fromBuild ?? '?'} -> ${d.toBuild ?? '?'}: ${d.changed ? 'CHANGED' : 'unchanged'}${d.passagesChanged.length ? `; load-bearing passages changed: ${d.passagesChanged.map((p) => p.label).join('; ')}` : ''}`, `  ${d.note}`);
  }
  if (r.unresolved.length) lines.push('', 'Unresolved:', ...r.unresolved.map((u) => `  - ${u}`));
  if (r.nextSteps.length) lines.push('', 'Next steps:', ...r.nextSteps.map((s) => `  - ${s}`));
  return lines.join('\n');
}

function renderImport(r: ImportResult): string {
  return [
    `Imported ${r.kind} for actor ${r.actorId}: ${r.propertyCount} properties, hash ${r.schemaHash.slice(0, 12)}, build ${r.buildNumber ?? '(unknown)'}`,
    `Status: ${r.status} - ${r.detail}`,
    `Adapter: ${r.compatibility.ok ? 'compatible' : 'BLOCKED'}; would force off: ${r.compatibility.forcedOff.map((f) => f.field).join(', ') || 'none'}`,
    ...r.compatibility.errors.map((e) => `  blocker: ${e}`),
    ...r.nextSteps.map((s) => `Next step: ${s}`),
  ].join('\n');
}

function renderStatus(s: IntegrationStatus): string {
  return [`apify: ${s.state}${s.networkChecked ? ' (network checked)' : ''}`, `  ${s.detail}`, ...(s.nextStep ? [`Next step: ${s.nextStep}`] : []), 'Sends externally:', ...s.sendsExternally.map((x) => `  - ${x}`)].join('\n');
}

function renderRuns(r: { runs: ApifyRunListing[]; resume?: ResumeReport }): string {
  const lines: string[] = [];
  if (r.resume) {
    lines.push(`Resume: ${r.resume.status} - ${r.resume.detail}`);
    if (r.resume.nextStep) lines.push(`Next step: ${r.resume.nextStep}`);
    for (const x of r.resume.runs) lines.push(`  ${x.apifyRunId ?? '?'}: ${x.status} - ${x.detail}`);
    for (const x of r.resume.runs) if (x.nextStep) lines.push(`    next step: ${x.nextStep}`);
    for (const u of r.resume.usageReconciled) lines.push(`  usage ${u.apifyRunId}: ${u.status} ${formatUsd(u.actualMicros)}${u.notes?.length ? ` (${u.notes.join(' ')})` : ''}`);
    lines.push('');
  }
  if (!r.runs.length) return [...lines, 'No Apify runs recorded for this site.'].join('\n');
  lines.push('id                              processing   status        remote run          items signals cap      usage    reservation');
  for (const x of r.runs) {
    lines.push(
      [
        x.id.padEnd(31),
        x.processingStatus.padEnd(12),
        (x.remoteStatus && x.status === 'quarantined' ? `Q(${x.remoteStatus})` : x.status).padEnd(13),
        (x.remoteRunId ?? '-').padEnd(19),
        String(x.itemsFetched).padEnd(5),
        String(x.signalsCreated ?? '-').padEnd(7),
        formatUsd(x.capMicros).padEnd(8),
        formatUsd(x.usageMicros).padEnd(8),
        `${x.reservationStatus ?? '-'}${x.isSynthetic ? ' [SYNTHETIC]' : ''}`,
      ].join(' '),
    );
    if (x.quarantineReason) lines.push(`  quarantined: ${x.quarantineReason}`);
  }
  return lines.join('\n');
}

export function register(program: Command, cli: CliRuntime): void {
  const apify = program.command('apify').description('Apify Reddit Scraper actor 9sHOY9RzPYGjmTHo8: status, inspect, schema import, test run, content research, runs');

  apify
    .command('status')
    .description('Honest integration status (no request unless --network; network checks are free reads)')
    .option('--network', 'perform free read-only network checks (token, actor, pinned build)')
    .action(
      cli.action(async (opts: { network?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const s = await apifyStatus(ctx, { network: !!opts.network && !g.dryRun });
          cli.print(g, s, renderStatus);
          if (s.state !== 'ready' && s.state !== 'configured_unverified' && s.state !== 'fixture') process.exitCode = s.state === 'missing_credentials' || s.state === 'disabled' ? 3 : 1;
        } finally {
          ctx.db.close();
        }
      }),
    );

  apify
    .command('inspect')
    .description('Free reads: live identity, pricing, builds, input schema (stored with hash), and schema drift')
    .option('--build <build>', 'also inspect this build number (default: the pinned build)')
    .action(
      cli.action(async (opts: { build?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          if (g.dryRun) {
            cli.print(g, { dryRun: true, wouldRequest: ['GET /v2/actors/{actorId}', 'GET /v2/actor-builds/{buildId}', 'GET /v2/actor-builds/{buildId}/openapi.json (fallback)'], chargeable: false }, () =>
              'Dry run: would perform free reads of the actor, its latest and pinned builds, and (if needed) the build OpenAPI definition. No charge.',
            );
            return;
          }
          const r = await inspectActor(ctx, opts.build ? { build: opts.build } : {});
          cli.print(g, r, renderInspect);
        } finally {
          ctx.db.close();
        }
      }),
    );

  apify
    .command('import-schema <file>')
    .description("Import the actor's exported input schema (raw schema, build JSON, or build openapi.json). Stored unverified unless --attest")
    .option('--build <number>', 'build number the schema was exported from, e.g. 0.0.513')
    .option('--attest', 'owner attestation that the file is exactly the input schema of --build (recorded in the audit log)')
    .action(
      cli.action(async (file: string, opts: { build?: string; attest?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          if (g.dryRun) {
            cli.print(g, { dryRun: true, file }, () => `Dry run: would validate and store the schema in ${file}.`);
            return;
          }
          const r = importActorSchema(ctx, file, { ...(opts.build ? { build: opts.build } : {}), ...(opts.attest ? { attest: true } : {}) });
          cli.print(g, r, renderImport);
          if (r.status === 'unresolved') process.exitCode = 1;
        } finally {
          ctx.db.close();
        }
      }),
    );

  apify
    .command('test')
    .description('One minimal PAID test run (5 posts, no comments). Requires --mode RESEARCH, --confirm-spend and --max-usd; the cap is shown before starting')
    .option('--confirm-spend', 'explicitly allow this paid run')
    .option('--max-usd <usd>', 'provider-side charge cap for this run (must not exceed research.apify.maxTotalChargeUsd)')
    .option('--term <text>', 'search term (default: first research.seedTopics entry)')
    .option('--no-reuse', 'do not reuse an identical completed run')
    .action(
      cli.action(async (opts: { confirmSpend?: boolean; maxUsd?: string; term?: string; reuse?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const term = opts.term ?? ctx.config.research.seedTopics[0];
          if (!term) throw new AppError('CONFIG_MISSING', 'No search term for the test run.', { hint: 'Pass --term "<topic>" or configure research.seedTopics in the site config.' });
          const cap = opts.maxUsd !== undefined ? usdArg(opts.maxUsd, '--max-usd') : undefined;
          if (opts.confirmSpend && cap === undefined) throw new ValidationError('--confirm-spend requires --max-usd <cap> so the spending cap is explicit.');
          // Policy external_research: a paid Apify run needs --mode RESEARCH (the confirmation is a second requirement).
          if (opts.confirmSpend && !g.dryRun) assertAllowed(ctx.mode, 'external_research');
          const base = {
            searchTerms: [term],
            maxItems: Math.min(5, ctx.config.research.apify.maxItems),
            maxCommentsPerPost: 0,
            purpose: 'apify test run (minimal)',
            reuseCompletedWithinHours: opts.reuse === false ? 0 : 168,
            ...(cap !== undefined ? { maxTotalChargeUsdMicros: cap } : {}),
          };
          const preview = await runContentResearch({ ...ctx, dryRun: true }, base);
          if (!opts.confirmSpend || g.dryRun || preview.status !== 'dry_run') {
            const out: ContentResearchResult =
              preview.status === 'dry_run' && !g.dryRun
                ? { ...preview, status: 'confirmation_required', detail: `Nothing was run. This paid test would be capped at ${formatUsd(preview.plan?.capMicros)}.`, nextStep: 'Re-run with --mode RESEARCH --confirm-spend --max-usd <cap> to start it.' }
                : preview;
            cli.print(g, out, renderResearch);
            const code = EXIT_BY_STATUS[out.status];
            if (code) process.exitCode = code;
            return;
          }
          const shown = preview.plan!;
          cli.io.err(
            `Paid Apify test run: provider-side cap maxTotalChargeUsd=${formatUsd(shown.capMicros)}; estimated upper bound ${formatUsd(shown.estimate.upperBoundMicros)}; ` +
              `per-run budget ${formatUsd(ctx.settings.budgets.apify.perRun)}; monthly Apify budget ${formatUsd(ctx.settings.budgets.apify.monthly)}. Starting.`,
          );
          // Bind the submission to what was shown: the cap can only be lower and the input must be identical
          // (live pricing is re-read before paying; any change returns confirmation_required and sends nothing).
          const r = await runContentResearch(ctx, {
            ...base,
            maxTotalChargeUsdMicros: shown.capMicros,
            expectedPlan: { capMicros: shown.capMicros, inputHash: shown.inputHash },
            explicitSpendConfirmation: true,
          });
          cli.print(g, r, renderResearch);
          const code = EXIT_BY_STATUS[r.status];
          if (code) process.exitCode = code;
        } finally {
          ctx.db.close();
        }
      }),
    );

  const collect = (v: string, prev: string[]) => [...prev, v];
  apify
    .command('research')
    .description(
      'PAID content research with the configured limits (research.apify maxItems/maxCommentsPerPost/timeRange; terms from research.seedTopics). ' +
        'One bounded run per community (research.subreddits). Shows the plan first; needs --mode RESEARCH, --confirm-spend and --max-usd (total cap across all runs)',
    )
    .option('--term <text>', 'search term (repeatable; default: research.seedTopics)', collect, [] as string[])
    .option('--community <name>', 'subreddit name, "name" or "r/name" (repeatable; default: research.subreddits); one run per community', collect, [] as string[])
    .option('--all-reddit', 'ignore research.subreddits: one run across all of Reddit')
    .option('--confirm-spend', 'explicitly allow the paid runs shown in the plan')
    .option('--max-usd <usd>', 'TOTAL provider-side charge cap across all runs of this batch (split per run; each run also within research.apify.maxTotalChargeUsd)')
    .option('--plan <hash>', 'only start if the batch plan hash equals this one (as shown by a previous preview)')
    .option('--max-items <n>', 'lower research.apify.maxItems for these runs')
    .option('--max-comments-per-post <n>', 'lower research.apify.maxCommentsPerPost for these runs')
    .option('--time-range <range>', `narrow research.apify.timeRange (${TIME_RANGE_ORDER.join(', ')})`)
    .option('--classify-with-llm', 'classify signals with the LLM classifier (prompt research.reddit-signals) instead of the English heuristics; needs --llm-max-usd')
    .option('--llm-max-usd <usd>', 'per-request LLM cost cap for --classify-with-llm (reserved through the LLM Gateway budget; unknown prices are refused)')
    .option('--no-reuse', 'do not reuse identical completed runs')
    .action(
      cli.action(
        async (
          opts: {
            term: string[];
            community: string[];
            allReddit?: boolean;
            confirmSpend?: boolean;
            maxUsd?: string;
            plan?: string;
            maxItems?: string;
            maxCommentsPerPost?: string;
            timeRange?: string;
            classifyWithLlm?: boolean;
            llmMaxUsd?: string;
            reuse?: boolean;
          },
          cmd: Command,
        ) => {
          const g = cli.globals(cmd);
          const ctx = cli.context(g);
          try {
            const cfg = ctx.config.research;
            const terms = (opts.term.length ? opts.term : cfg.seedTopics).map((t) => t.trim()).filter(Boolean);
            if (!terms.length) throw new AppError('CONFIG_MISSING', 'No search terms for content research.', { hint: 'Pass --term "<topic>" (repeatable) or configure research.seedTopics in the site config.' });
            const communities = opts.allReddit ? [] : opts.community.length ? opts.community : cfg.subreddits;
            const total = opts.maxUsd !== undefined ? usdArg(opts.maxUsd, '--max-usd') : undefined;
            if (opts.confirmSpend && total === undefined) throw new ValidationError('--confirm-spend requires --max-usd <total cap> so the spending cap is explicit.');
            const intArg = (v: string | undefined, flag: string): number | undefined => {
              if (v === undefined) return undefined;
              if (!/^\d+$/.test(v.trim())) throw new ValidationError(`${flag} must be a whole number`);
              return Number(v.trim());
            };
            const maxItems = intArg(opts.maxItems, '--max-items');
            const maxComments = intArg(opts.maxCommentsPerPost, '--max-comments-per-post');
            if (opts.timeRange !== undefined && !(TIME_RANGE_ORDER as readonly string[]).includes(opts.timeRange)) throw new ValidationError(`--time-range must be one of ${TIME_RANGE_ORDER.join(', ')}`);
            const llmCap = opts.llmMaxUsd !== undefined ? usdArg(opts.llmMaxUsd, '--llm-max-usd') : undefined;
            if (opts.llmMaxUsd !== undefined && !opts.classifyWithLlm) throw new ValidationError('--llm-max-usd is only used with --classify-with-llm.');
            const paying = !!opts.confirmSpend && !g.dryRun;
            if (paying && opts.classifyWithLlm && llmCap === undefined) {
              throw new ValidationError('--classify-with-llm requires --llm-max-usd <cap>: every classifier call is reserved against the LLM Gateway budget under this explicit per-request cap.');
            }
            // Policy external_research: paid research needs --mode RESEARCH; --confirm-spend is a second requirement.
            if (paying) assertAllowed(ctx.mode, 'external_research');

            // Classifier: heuristics unless explicitly asked for the LLM classifier with a cost cap.
            const outcomes: LlmClassifierOutcome[] = [];
            let classifier: SignalClassifier | undefined;
            let classification: ClassificationReport;
            if (opts.classifyWithLlm) {
              const svc = createServices(ctx, { ...(llmCap !== undefined ? { gateway: { maxCostPerRequestMicros: llmCap } } : {}) });
              if (paying && (svc.llmKind === 'disabled' || !svc.llm.isConfigured('cheap'))) {
                throw new AppError('CONFIG_MISSING', '--classify-with-llm needs a configured cheap model on the LLM Gateway; nothing was sent to Apify.', {
                  hint: 'Configure LLM_GATEWAY_API_KEY and CHEAP_MODEL (docs/ACCESS_SETUP.md), or run without --classify-with-llm to use the heuristic classifier.',
                });
              }
              classifier = llmSignalClassifier(svc.llm, { siteId: ctx.siteId, runId: ctx.runId, promptId: 'research.reddit-signals', onResult: (o) => outcomes.push(o) });
              classification = {
                requested: 'llm',
                note: `LLM classifier (prompt research.reddit-signals, cheap tier${svc.llm.synthetic ? ', SYNTHETIC fixture client' : ''}), each call capped at ${formatUsd(llmCap ?? null)} and reserved through the LLM Gateway budget; unknown prices are refused and those items fall back to the heuristics (${HEURISTIC_METHOD}).`,
                outcomes,
                llmCapMicros: llmCap ?? null,
              };
            } else {
              classification = {
                requested: 'heuristic',
                note: `heuristic classifier only (${HEURISTIC_METHOD}: deterministic English patterns, approximate); pass --classify-with-llm --llm-max-usd <cap> to use the LLM classifier.`,
                outcomes,
                llmCapMicros: null,
              };
            }

            const perRunDefault = toMicros(cfg.apify.maxTotalChargeUsd);
            const batchOpts: ResearchBatchOptions = {
              searchTerms: terms,
              communities,
              totalCapMicros: total ?? perRunDefault * Math.max(1, communities.length),
              ...(maxItems !== undefined ? { maxItems } : {}),
              ...(maxComments !== undefined ? { maxCommentsPerPost: maxComments } : {}),
              ...(opts.timeRange ? { timeRange: opts.timeRange as RedditTimeRange } : {}),
              purpose: 'apify content research (CLI)',
              reuseCompletedWithinHours: opts.reuse === false ? 0 : 168,
              ...(classifier ? { classifier } : {}),
            };
            const preview = await planContentResearchBatch(ctx, batchOpts);
            if (!opts.confirmSpend || g.dryRun || preview.status !== 'dry_run') {
              const out = { ...preview, classification, confirmed: false };
              if (preview.status === 'dry_run' && !g.dryRun) {
                out.detail = `Nothing was run. ${preview.detail} To start exactly these runs: --mode RESEARCH --confirm-spend --max-usd <total>${preview.planHash ? ` --plan ${preview.planHash}` : ''}.`;
              }
              cli.print(g, out, renderResearchBatch);
              const firstBad = preview.runs.find((x) => x.result.status !== 'dry_run');
              process.exitCode = preview.status === 'dry_run' ? (g.dryRun ? 0 : 2) : (firstBad ? (EXIT_BY_STATUS[firstBad.result.status] ?? 1) : 1);
              return;
            }
            if (opts.plan && opts.plan !== preview.planHash) {
              const out = { ...preview, classification, confirmed: false, detail: `The plan changed since it was shown (plan hash ${preview.planHash} != --plan ${opts.plan}). Nothing was sent; review the plan below and confirm again.` };
              cli.print(g, out, renderResearchBatch);
              process.exitCode = 2;
              return;
            }
            cli.io.err(
              `Paid Apify content research: ${preview.runs.length} run(s); provider-side caps total ${formatUsd(preview.plannedCapMicros)} (limit ${formatUsd(preview.totalCapMicros)}); ` +
                `per-run budget ${formatUsd(ctx.settings.budgets.apify.perRun)}; monthly Apify budget ${formatUsd(ctx.settings.budgets.apify.monthly)}; plan ${preview.planHash}. Starting.`,
            );
            // Each run is bound to what was shown: its cap can only be lower and its input must be identical
            // (live pricing is re-read before paying; any change returns confirmation_required and sends nothing).
            const r = await runContentResearchBatch(ctx, { ...batchOpts, explicitSpendConfirmation: true }, preview);
            if (opts.classifyWithLlm) {
              const failed = outcomes.filter((o) => !o.ok);
              if (failed.length) classification.note += ` ${failed.length} classification call(s) did not use the LLM (${failed.map((o) => (o.ok ? '' : `${o.status}: ${o.reason}`)).join('; ')}); heuristics were used for those runs.`;
              const ok = outcomes.filter((o) => o.ok).length;
              if (ok) classification.note += ` ${ok} run(s) classified by the LLM.`;
            }
            cli.print(g, { ...r, classification, confirmed: true }, renderResearchBatch);
            const firstBad = r.runs.find((x) => x.result.status !== 'completed' && x.result.status !== 'reused');
            if (firstBad) process.exitCode = EXIT_BY_STATUS[firstBad.result.status] ?? 1;
          } finally {
            ctx.db.close();
          }
        },
      ),
    );

  apify
    .command('runs')
    .description('List Apify runs for this site; --resume reconciles ambiguous submissions and finishes pending runs (never starts a new paid run)')
    .option('--resume', 'poll/fetch/normalize pending runs and re-check unresolved charges')
    .option('--wait', 'with --resume: wait for running runs to finish (polls with backoff)')
    .option('--abort-overdue', 'with --resume: request abort of runs far past their timeout (abort endpoint unverified)')
    .option('--confirm-not-accepted <id>', 'owner confirmation (after checking the Apify console) that a quarantined ambiguous submission never started: records $0 as a manual confirmation')
    .option('--limit <n>', 'rows to list', '50')
    .action(
      cli.action(async (opts: { resume?: boolean; wait?: boolean; abortOverdue?: boolean; confirmNotAccepted?: string; limit: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const limit = Math.max(1, Math.min(500, Number.parseInt(opts.limit, 10) || 50));
          let confirmation: ConfirmNotAcceptedResult | undefined;
          if (opts.confirmNotAccepted) {
            confirmation = await confirmNotAccepted(ctx, opts.confirmNotAccepted);
            if (confirmation.status === 'refused' || confirmation.status === 'not_found') process.exitCode = 1;
          }
          let resume: ResumeReport | undefined;
          if (opts.resume && !g.dryRun) resume = await resumeApifyRuns(ctx, { waitForCompletion: !!opts.wait, abortOverdue: !!opts.abortOverdue });
          const out = { runs: listApifyRuns(ctx, limit), ...(resume ? { resume } : {}), ...(confirmation ? { confirmation } : {}) };
          cli.print(g, out, (o) => [...(o.confirmation ? [`Confirm not accepted: ${o.confirmation.status} - ${o.confirmation.detail}${o.confirmation.nextStep ? `\nNext step: ${o.confirmation.nextStep}` : ''}`, ''] : []), renderRuns(o)].join('\n'));
          if (resume && resume.status !== 'ok') process.exitCode = resume.status === 'missing_credentials' ? 3 : 1;
        } finally {
          ctx.db.close();
        }
      }),
    );
}
