import type { Command } from 'commander';
import type { AppContext } from '../../app/context.js';
import { AppError } from '../../core/errors.js';
import { modeAtLeast } from '../../core/modes.js';
import { formatUsd } from '../../core/money.js';
import type { FetchLike } from '../../integrations/types.js';
import { createDataForSeoClient, type DataForSeoClientOptions } from '../../integrations/dataforseo/client.js';
import { listLocations, type LookupKind } from '../../integrations/dataforseo/locations.js';
import { assertResearchRan, researchShortlist, type ResearchCostPlan, type ShortlistResearchResult } from '../../integrations/dataforseo/research.js';
import { dataforseoStatus, type DataForSeoStatus } from '../../integrations/dataforseo/status.js';
import { abandonAmbiguousTask, listTasks, pollPendingTasks, type PollSummary, type TaskListing } from '../../integrations/dataforseo/tasks.js';
import type { CostPlan } from '../../integrations/dataforseo/types.js';
import { researchKeywordVolumes, type VolumeResearchResult } from '../../integrations/dataforseo/volume.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';

/**
 * `research` commands (DataForSEO):
 *   research keyword <query...>   targeted SERP research (+ optional --volume); --dry-run shows the cost plan, caps, and cache hits
 *   research tasks                pending/ambiguous tasks; --poll resumes them (free GETs, never resubmits)
 *   research locations [search]   free location lookup to configure market.searchLocations without guessing codes
 *   research status               honest integration status; --network uses the free user_data endpoint
 *
 * Paid requests need --mode RESEARCH (the default runtime mode ANALYZE is never
 * raised implicitly), --allow-spend, AND budget; the plan with caps is always shown.
 * Sandbox runs are free and need neither flag.
 */

export interface ResearchCommandDeps {
  /** Test hook: transport used instead of the global fetch. */
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Test hook: build the context (defaults to cli.context). */
  context?: (g: GlobalOptions) => AppContext;
}

/** Parse a whole-number option; rejects NaN, decimals, and out-of-range values instead of passing them on. */
export function intOption(name: string, value: string | undefined, range: { min: number; max?: number }): number | undefined {
  if (value === undefined) return undefined;
  const t = String(value).trim();
  const n = /^\d+$/.test(t) ? Number(t) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < range.min || (range.max !== undefined && n > range.max)) {
    throw new AppError('VALIDATION_FAILED', `${name} must be a whole number${range.max !== undefined ? ` from ${range.min} to ${range.max}` : ` >= ${range.min}`} (got "${value}")`);
  }
  return n;
}

function renderPlan(plan: (CostPlan & Partial<Pick<ResearchCostPlan, 'queueRequested' | 'liveQueueJustification'>>) | null): string[] {
  if (!plan) return [];
  const lines: string[] = [];
  const total = plan.isSandbox ? '$0 (sandbox/fixture: free)' : plan.totalEstimateMicros === null ? 'UNKNOWN (price not verified)' : `${formatUsd(plan.totalEstimateMicros)} upper bound`;
  const queueNote =
    plan.queue === 'live' && plan.liveQueueJustification
      ? ` (live queue justification: "${plan.liveQueueJustification}")`
      : plan.queueRequested === 'live' && plan.queue !== 'live'
        ? ' (live requested without research.dataforseo.liveQueueJustification: standard queue used)'
        : '';
  lines.push(`Cost plan: ${plan.cacheHits} cache hit(s), ${plan.openTasks} existing task(s) reused, ${plan.submissions} new paid submission(s); estimate ${total}; queue ${plan.queue}${queueNote}`);
  for (const i of plan.items.filter((x) => x.action === 'submit')) lines.push(`  - ${i.label}: ${i.estimateMicros === null ? 'unknown' : formatUsd(i.estimateMicros)} (${i.basis?.source ?? 'unknown'}: ${i.basis?.detail ?? ''})`);
  const c = plan.caps;
  lines.push(
    `Caps (dataforseo): per run ${formatUsd(c.perRun.limitMicros)} (remaining ${formatUsd(c.perRun.remainingMicros)})` +
      (c.weekly ? `, week ${formatUsd(c.weekly.limitMicros)} (remaining ${formatUsd(c.weekly.remainingMicros)})` : '') +
      `, month ${formatUsd(c.monthly.limitMicros)} (remaining ${formatUsd(c.monthly.remainingMicros)}), combined month remaining ${formatUsd(c.combinedMonthly.remainingMicros)}`,
  );
  if (!plan.isSandbox && plan.submissions > 0) {
    if (plan.violated) lines.push(`Budget check: WOULD EXCEED "${plan.violated.scope}" (committed ${formatUsd(plan.violated.committedMicros)} + ${formatUsd(plan.violated.requestedMicros)} > ${formatUsd(plan.violated.limitMicros)}); nothing will be sent.`);
    else if (plan.unknownPrice) lines.push('Budget check: price unknown; the request is skipped unless explicitly approved.');
    else lines.push('Budget check: within all caps.');
  }
  return lines;
}

function renderSerp(r: ShortlistResearchResult): string {
  const lines: string[] = [];
  const modeLabel = r.mode === null ? 'unavailable' : r.isSandbox ? `${r.mode.toUpperCase()} (synthetic data, never used in real recommendations)` : 'live';
  lines.push(`DataForSEO SERP research: ${r.status}${r.dryRun ? ' (dry run: nothing sent)' : ''}; mode ${modeLabel}`);
  if (r.settings) lines.push(`Locale: location ${r.settings.locationCode}${r.settings.locationName ? ` (${r.settings.locationName})` : ''}, language ${r.settings.languageCode}, device ${r.settings.device} [${r.settings.verification}]`);
  lines.push(...renderPlan(r.plan));
  lines.push(`Serious queries this run: ${r.selected.length} of limit ${r.seriousLimit}`);
  for (const q of r.queries) {
    const rank = q.ownRank === undefined ? '' : q.ownRank === null ? ', own site not in results' : `, own rank ${q.ownRank}`;
    lines.push(`  - "${q.query}": ${q.status}${q.taskId ? ` (task ${q.taskId})` : ''}${rank}${q.error ? ` - ${q.error.code}: ${q.error.message}` : ''}`);
    for (const c of q.competitorUrls) lines.push(`      ${c.rankAbsolute ?? '?'}. ${c.url}${c.usableForRecommendations ? '' : '  [SYNTHETIC - not for recommendations]'}`);
  }
  if (r.filtered.length) lines.push(`Filtered: ${r.filtered.map((f) => `"${f.query}" (${f.reason})`).join(', ')}`);
  for (const b of r.blockers) lines.push(`Blocker [${b.code}]: ${b.message}${b.hint ? `\n  Next step: ${b.hint}` : ''}`);
  for (const w of r.warnings) lines.push(`Note: ${w}`);
  if (r.queries.some((q) => q.status === 'pending')) lines.push('Pending standard-queue tasks are resumed with `research tasks --poll` (free) or on the next run; they are never resubmitted.');
  if (r.queries.some((q) => q.status === 'ambiguous')) {
    lines.push('Ambiguous submissions (network error or timeout after sending) may have been charged and are never resubmitted: `npm run cli -- research tasks --poll` reconciles them (free); check connectivity with `npm run cli -- research status --network`.');
  }
  if (r.status === 'failed') lines.push('Research failed: no query was fetched, served from the cache, or queued.');
  else if (r.status === 'partial') lines.push('Partial result: some queries were not researched (see the errors above).');
  lines.push(...queryNextSteps(r.queries));
  return lines.join('\n');
}

/**
 * One "Next step" line per distinct hint of a failed or skipped query (provider
 * and network failures point to the free `research status --network` check).
 * Missing --allow-spend / --mode RESEARCH is explained by the footer instead.
 */
function queryNextSteps(items: Array<{ status: string; error?: { code: string; hint?: string } }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of items) {
    const e = q.error;
    if (!e?.hint || e.code === 'POLICY_DENIED' || (q.status !== 'failed' && q.status !== 'skipped')) continue;
    if (seen.has(e.hint)) continue;
    seen.add(e.hint);
    out.push(`Next step [${e.code}]: ${e.hint}`);
  }
  return out;
}

/**
 * Exit code of `research keyword` (docs/CLI.md): 1 when the SERP research
 * failed (no query fetched, cached, or queued); 3 when a precondition refused
 * it (missing --allow-spend / --mode RESEARCH, budget exceeded, unknown
 * price); 2 for a partial result, an ambiguous submission (outcome unknown),
 * or when nothing was researched (every query skipped, e.g. DATA_UNAVAILABLE
 * for an unverified location, or filtered); otherwise 0 (completed, pending
 * standard-queue tasks, or a dry-run plan).
 */
export function researchKeywordExitCode(serp: Pick<ShortlistResearchResult, 'status' | 'queries'>, volume?: Pick<VolumeResearchResult, 'status' | 'keywords'>): number {
  const items = [...serp.queries, ...(volume ? volume.keywords : [])];
  if (serp.status === 'failed') return 1;
  if (items.some((q) => q.error?.code === 'POLICY_DENIED' || q.error?.code === 'BUDGET_EXCEEDED' || q.error?.code === 'BUDGET_UNKNOWN_PRICE')) return 3;
  const incomplete = (s: string) => s === 'partial' || s === 'skipped' || s === 'failed';
  if (incomplete(serp.status) || (volume && incomplete(volume.status)) || items.some((q) => q.status === 'ambiguous')) return 2;
  return 0;
}

function renderVolume(v: VolumeResearchResult): string {
  const lines = [`Search-volume estimates: ${v.status}${v.dryRun ? ' (dry run)' : ''} [${v.isSandbox ? 'SYNTHETIC' : 'estimate, not exact demand'}]`];
  lines.push(...renderPlan(v.plan));
  for (const k of v.keywords) {
    const vol = k.volume.status === 'observed' ? String(k.volume.value) : `${k.volume.status} (${'reason' in k.volume ? k.volume.reason : ''})`;
    lines.push(`  - "${k.keyword}": ${k.status}, volume ${vol}${k.error ? ` - ${k.error.code}: ${k.error.message}` : ''}`);
  }
  for (const b of v.blockers) lines.push(`Blocker [${b.code}]: ${b.message}`);
  for (const w of v.warnings) lines.push(`Note: ${w}`);
  if (v.status === 'failed') lines.push('Search-volume research failed: no keyword was fetched, served from the cache, or queued.');
  lines.push(...queryNextSteps(v.keywords));
  return lines.join('\n');
}

function renderTasks(r: { tasks: TaskListing[]; poll?: PollSummary }): string {
  const lines: string[] = [];
  if (r.poll) {
    lines.push(
      `Polled ${r.poll.checked} task(s): fetched ${r.poll.fetched.length}, still pending ${r.poll.pending.length}, reconciled ${r.poll.reconciled.length}, ambiguous ${r.poll.ambiguous.length}, expired ${r.poll.expired.length}, failed ${r.poll.failed.length}`,
    );
    for (const s of r.poll.skipped) lines.push(`  skipped ${s.taskId}: ${s.reason}`);
    for (const e of r.poll.errors) lines.push(`  error: ${e}`);
  }
  if (!r.tasks.length) lines.push('No DataForSEO tasks in the selected states.');
  for (const t of r.tasks) {
    lines.push(
      `${t.id}  ${t.status.padEnd(10)} ${t.kind.padEnd(6)} ${t.mode}${t.isSandbox ? ' [SYNTHETIC]' : ''}  "${t.label}"  age ${t.ageHours}h  cost ${formatUsd(t.costMicros)}${t.remoteTaskId ? `  remote ${t.remoteTaskId}` : ''}${t.apiStatusMessage ? `\n    ${t.apiStatusMessage}` : ''}`,
    );
  }
  if (r.tasks.some((t) => t.status === 'ambiguous')) {
    lines.push('Ambiguous tasks may have been charged. They are never resubmitted automatically; `--poll` reconciles them via tasks_ready. If one cannot be found, check the DataForSEO dashboard and use `--abandon <id>` (its charge stays reserved).');
  }
  return lines.join('\n');
}

function renderStatus(s: DataForSeoStatus): string {
  const lines = [`dataforseo: ${s.state} - ${s.detail}`, `mode ${s.mode ?? 'none'} (config ${s.configMode}), queue ${s.queue}, pending tasks ${s.pendingTasks}, ambiguous ${s.ambiguousTasks}`];
  if (s.accountBalanceUsd !== null) lines.push(`Account balance (provider-reported): $${s.accountBalanceUsd}`);
  if (s.nextStep) lines.push(`Next step: ${s.nextStep}`);
  lines.push('Pricing basis:');
  for (const p of s.pricing) lines.push(`  ${p.key}: ${p.status} - ${p.detail}`);
  for (const w of s.pricingWarnings) lines.push(`Pricing warning: ${w}`);
  lines.push('Sends externally:', ...s.sendsExternally.map((x) => `  - ${x}`));
  for (const n of s.notes) lines.push(`Note: ${n}`);
  return lines.join('\n');
}

export function registerResearch(program: Command, cli: CliRuntime, deps: ResearchCommandDeps = {}): void {
  const makeContext = (g: GlobalOptions): AppContext => (deps.context ? deps.context(g) : cli.context(g));
  const clientOpts = (sandbox?: boolean): DataForSeoClientOptions => ({
    ...(sandbox ? { mode: 'sandbox' as const } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  const research = program.command('research').description('Selective, budgeted DataForSEO research (SERPs, keyword volume estimates)');

  research
    .command('keyword')
    .description('Research SERPs for explicit queries (cache first, budgeted, standard queue); --dry-run shows the cost plan and caps')
    .argument('<query...>', 'one or more search queries (quote multi-word queries)')
    .option('--sandbox', 'use the free DataForSEO sandbox (synthetic data, never used in recommendations)')
    .option('--allow-spend', 'permit paid DataForSEO requests within the configured caps')
    .option('--volume', 'also request Google Ads search-volume estimates (one paid task for all queries)')
    .option('--device <device>', 'desktop or mobile (default: first supported device in market.devices)')
    .option('--location <code>', 'use the configured market.searchLocations entry with this location code')
    .option('--competitors <n>', 'competitor pages to return per query (up to crawl.competitorPagesPerQueryMax)')
    .option('--wait <seconds>', 'poll standard-queue tasks for up to N seconds (free; never resubmits)', '0')
    .action(
      cli.action(async (queries: string[], opts: { sandbox?: boolean; allowSpend?: boolean; volume?: boolean; device?: string; location?: string; competitors?: string; wait?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        // The runtime mode is whatever the owner chose (default ANALYZE); it is never raised implicitly.
        const ctx = makeContext(g);
        try {
          const waitMs = (intOption('--wait', opts.wait ?? '0', { min: 0, max: 86_400 }) ?? 0) * 1000;
          const locationCode = intOption('--location', opts.location, { min: 1 });
          const competitors = intOption('--competitors', opts.competitors, { min: 0 });
          if (opts.device && opts.device !== 'desktop' && opts.device !== 'mobile') throw new AppError('VALIDATION_FAILED', '--device must be desktop or mobile');
          const common = {
            ...clientOpts(opts.sandbox),
            dryRun: !!g.dryRun,
            allowPaid: !!opts.allowSpend,
            ...(locationCode !== undefined ? { locationCode } : {}),
            waitMs,
          };
          const serp = await researchShortlist(
            ctx,
            queries.map((q) => ({ query: q, origin: 'owner' as const })),
            { ...common, allowOwnerQueries: true, ...(opts.device ? { device: opts.device as 'desktop' | 'mobile' } : {}), ...(competitors !== undefined ? { competitorPagesPerQuery: competitors } : {}) },
          );
          assertResearchRan(serp);
          let volume: VolumeResearchResult | undefined;
          if (opts.volume && serp.selected.length) volume = await researchKeywordVolumes(ctx, serp.selected.map((s) => s.query), common);
          const needsFlag = [...serp.queries, ...(volume ? volume.keywords : [])].some((q) => q.error?.code === 'POLICY_DENIED');
          const missing = [...(modeAtLeast(ctx.mode, 'RESEARCH') ? [] : ['--mode RESEARCH']), ...(opts.allowSpend ? [] : ['--allow-spend'])];
          const paidPlanned = !!serp.plan && !serp.plan.isSandbox && serp.plan.submissions > 0;
          const footer = needsFlag
            ? `Nothing paid was sent. Paid DataForSEO research needs ${missing.join(' and ') || 'explicit authorization'} (the runtime mode is ${ctx.mode}; it is never raised implicitly). Review the plan and caps above, then re-run with ${missing.join(' ') || '--allow-spend'} to submit.`
            : serp.dryRun && paidPlanned && missing.length
              ? `To submit for real, re-run without --dry-run and with ${missing.join(' ')}.`
              : '';
          cli.print(g, { serp, ...(volume ? { volume } : {}) }, (r: { serp: ShortlistResearchResult; volume?: VolumeResearchResult }) =>
            [renderSerp(r.serp), r.volume ? renderVolume(r.volume) : '', footer].filter(Boolean).join('\n\n'),
          );
          // Never exit 0 for a run in which nothing (or not everything) was researched.
          const exitCode = researchKeywordExitCode(serp, volume);
          if (exitCode !== 0) process.exitCode = exitCode;
        } finally {
          ctx.db.close();
        }
      }),
    );

  research
    .command('tasks')
    .description('List pending and ambiguous DataForSEO tasks; --poll resumes them with free GETs (never resubmits)')
    .option('--poll', 'poll tasks_ready / task_get now and store finished results')
    .option('--all', 'include fetched, failed, and expired tasks')
    .option('--abandon <taskId>', 'give up on an AMBIGUOUS task after checking the DataForSEO dashboard (its charge stays reserved)')
    .action(
      cli.action(async (opts: { poll?: boolean; all?: boolean; abandon?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = makeContext(g);
        try {
          if (opts.abandon) {
            if (g.dryRun) throw new AppError('POLICY_DENIED', '--abandon changes task state; not available with --dry-run');
            abandonAmbiguousTask(ctx, opts.abandon, 'cli');
          }
          let poll: PollSummary | undefined;
          if (opts.poll && !g.dryRun) poll = await pollPendingTasks(ctx, clientOpts());
          const tasks = listTasks(ctx, opts.all ? { statuses: ['submitting', 'queued', 'ready', 'ambiguous', 'fetched', 'failed', 'expired'] } : {});
          cli.print(g, { tasks, ...(poll ? { poll } : {}) }, renderTasks);
        } finally {
          ctx.db.close();
        }
      }),
    );

  research
    .command('locations')
    .description('Look up supported DataForSEO locations (free) to configure market.searchLocations without guessing codes')
    .argument('[search]', 'case-insensitive substring of the location name')
    .option('--search <name>', 'same as the [search] argument')
    .option('--country <iso2>', 'two-letter country code to narrow the list (recommended; the full list is large)')
    .option('--kind <kind>', 'serp or keywords', 'serp')
    .option('--sandbox', 'use the sandbox host (synthetic lookup data)')
    .option('--limit <n>', 'maximum rows to print', '50')
    .action(
      cli.action(async (searchArg: string | undefined, opts: { search?: string; country?: string; kind?: string; sandbox?: boolean; limit?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = makeContext(g);
        try {
          if (searchArg && opts.search && searchArg !== opts.search) throw new AppError('VALIDATION_FAILED', 'Give the location name either as the [search] argument or with --search, not both.');
          const search = searchArg ?? opts.search;
          const limit = intOption('--limit', opts.limit ?? '50', { min: 1 })!;
          if (opts.kind && opts.kind !== 'serp' && opts.kind !== 'keywords') throw new AppError('VALIDATION_FAILED', '--kind must be serp or keywords');
          const kind = (opts.kind === 'keywords' ? 'keywords' : 'serp') as LookupKind;
          const client = g.dryRun ? null : createDataForSeoClient(ctx, clientOpts(opts.sandbox));
          const res = await listLocations(ctx, client, { kind, country: opts.country ?? null, mode: client?.mode ?? (opts.sandbox ? 'sandbox' : 'live'), allowNetwork: !g.dryRun });
          if (!res) throw new AppError('DATA_UNAVAILABLE', 'Location list not cached and not fetched (dry run).', { hint: 'Run without --dry-run; the lookup is free.' });
          const needle = (search ?? '').toLowerCase();
          const rows = res.items.filter((l) => !needle || l.location_name.toLowerCase().includes(needle)).slice(0, limit);
          cli.print(g, { source: res.source, sandbox: !!client?.isSandbox, count: rows.length, locations: rows }, (r: { source: string; locations: typeof rows }) =>
            [`${r.locations.length} location(s) (${r.source}${client?.isSandbox ? ', SANDBOX synthetic data' : ''}):`, ...r.locations.map((l) => `  ${l.location_code}  ${l.location_name}  [${l.location_type ?? '?'}${l.country_iso_code ? `, ${l.country_iso_code}` : ''}]`)].join('\n'),
          );
        } finally {
          ctx.db.close();
        }
      }),
    );

  research
    .command('status')
    .description('DataForSEO integration status (never chargeable; --network calls the free user_data endpoint)')
    .option('--network', 'verify credentials with the free user_data endpoint')
    .option('--sandbox', 'check against the sandbox host')
    .action(
      cli.action(async (opts: { network?: boolean; sandbox?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = makeContext(g);
        try {
          const s = await dataforseoStatus(ctx, { network: !!opts.network && !g.dryRun, ...clientOpts(opts.sandbox) });
          cli.print(g, s, renderStatus);
        } finally {
          ctx.db.close();
        }
      }),
    );
}

export function register(program: Command, cli: CliRuntime): void {
  registerResearch(program, cli);
}
