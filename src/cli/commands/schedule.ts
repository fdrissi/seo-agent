import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import type { AppContext } from '../../app/context.js';
import { AppError, ValidationError } from '../../core/errors.js';
import { forTerminal } from '../../core/terminal.js';
import { appRoot } from '../../config/paths.js';
import { listSiteIds } from '../../config/load.js';
import { createDefaultRegistry } from '../../jobs/handlers.js';
import {
  SCHEDULE_PLATFORMS,
  buildSchedulingInstructions,
  renderInstructions,
  resolveCliInvocation,
  type SchedulePlatform,
  type SchedulingInstructions,
} from '../../jobs/instructions.js';
import { JobRunner } from '../../jobs/runner.js';
import { listJobs } from '../../jobs/store.js';
import type { JobRecord } from '../../jobs/types.js';
import { CheckpointStore } from '../../workflows/checkpoints.js';
import {
  describeSchedules,
  disableSchedule,
  enableSchedule,
  formatInZone,
  listSchedules,
  planSchedule,
  runSchedulerDaemon,
  schedulerTick,
  type ScheduleOverview,
  type SchedulePlan,
  type TickResult,
} from '../../jobs/scheduler.js';
import { safeResolve } from '../../security/paths.js';
import { buildRepairSteps, runningBuildFreshness, scheduledRunBuildProblem, type BuildFreshness } from '../../setup/build-info.js';
import { redact, redactString } from '../../security/redact.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';
import { describeRun, signalController } from './jobs.js';

/**
 * `schedule show | instructions | enable <weekly|monthly> | disable <weekly|monthly> | run`.
 * Scheduling is opt-in: enabling writes a `schedules` row; installing an OS
 * timer or daemon is always a manual step (see `schedule instructions`).
 */

export function renderOverview(o: ScheduleOverview): string {
  const lines = [`Schedules for ${o.siteId} (site config scheduler time zone: ${o.configTimezone})`, ''];
  for (const s of o.schedules) {
    if (s.enabled && s.schedule) {
      lines.push(`${s.jobType}: ENABLED  cron "${s.schedule.cron}" in ${s.schedule.timezone}, mode ${s.schedule.mode}, catch-up ${s.schedule.catchUp}`);
      lines.push(`  next run:  ${s.nextRunLocal ?? 'not computed yet'}${s.schedule.nextRunAt ? ` = ${s.schedule.nextRunAt}` : ''}`);
      if (s.upcoming.length) lines.push(`  upcoming:  ${s.upcoming.join(' | ')}`);
      lines.push(`  last slot: ${s.schedule.lastNote ?? 'none yet'}`);
    } else {
      lines.push(`${s.jobType}: disabled (config preference: ${s.configPreference.enabled ? 'enabled' : 'disabled'}, cron "${s.configPreference.cron}")`);
    }
    lines.push(`  handler:   ${s.handlerRegistered ? 'registered' : 'NOT registered in this build (a due slot is skipped with an explanation)'}`);
    if (s.blockedBy) lines.push(s.blockedBy.detail.startsWith('BLOCKED') ? `  ${s.blockedBy.detail}` : `  pending:   ${s.blockedBy.detail}`);
    for (const n of s.dstNotes) lines.push(`  DST: ${n.message}`);
    for (const d of s.drift) lines.push(`  NOTE: ${d}`);
    lines.push('');
  }
  for (const n of o.notes) lines.push(`- ${n}`);
  return lines.join('\n');
}

function renderPlan(p: SchedulePlan & { dryRun?: boolean }): string {
  return [
    `${p.dryRun ? 'Dry run: would enable' : 'Enabled'} ${p.jobType} schedule for ${p.siteId}: cron "${p.cron}" in ${p.timezone} (cron from ${p.sources.cron}, zone from ${p.sources.timezone}), mode ${p.mode}, catch-up ${p.catchUp}.`,
    `Next run: ${p.nextRunLocal} = ${p.nextRunAt}`,
    `Upcoming: ${p.upcoming.join(' | ')}`,
    ...p.dstNotes.map((n) => `DST: ${n.message}`),
    'Spending caps that bound each scheduled run (configured ceilings, not price quotes):',
    ...p.spendingCaps.map((c) => `  - ${c}`),
    '',
    'Nothing was installed. Something must run the scheduler: `schedule run` (foreground) or a periodic `schedule run --once` (see `schedule instructions`).',
    'A sleeping, powered-off, or offline machine cannot run jobs.',
  ].join('\n');
}

export function renderTick(r: TickResult): string {
  const lines = [`[${r.at}] ${r.siteId}:`];
  for (const rec of r.recovered) lines.push(`  recovered ${rec.jobId} (${rec.type}) as interrupted: ${rec.reason}`);
  if (!r.items.length) lines.push('  no schedule due');
  for (const i of r.items) {
    const extra = i.missedSlots ? ` (+${i.missedSlots} missed slot(s) collapsed into one run)` : '';
    if (i.action === 'enqueued') lines.push(`  enqueued ${i.jobType} job ${i.jobId} for slot ${i.scheduledFor}${extra}`);
    else if (i.action === 'would_enqueue') lines.push(`  would enqueue ${i.jobType} for slot ${i.scheduledFor}${extra}`);
    else lines.push(`  skipped ${i.jobType} slot ${i.scheduledFor}: ${i.reason}`);
    if (i.nextRunAt) lines.push(`    next ${i.jobType} slot: ${i.nextRunAt}`);
  }
  for (const h of r.handledElsewhere ?? []) lines.push(`  ${h.jobType} slot ${h.scheduledFor} was claimed by another scheduler process; nothing done here`);
  for (const x of r.ran) lines.push(`  ran ${describeRun(x)}`);
  for (const a of r.needsAttention ?? []) lines.push(`  ATTENTION: ${a.reason}`);
  return lines.join('\n');
}

/**
 * One tick as the foreground scheduler prints it: daemon output bypasses
 * cli.print, so it is redacted and made terminal-safe here (job notes, reasons,
 * and error text are stored text; control, bidi, and invisible characters
 * become visible [U+XXXX] markers).
 */
export function renderDaemonTick(r: TickResult): string {
  return forTerminal(redactString(renderTick(r)));
}

/** Stages whose degradation means a run had no usable Google data. */
const CORE_DATA_STAGES = ['sync_gsc', 'sync_ga4'] as const;

export interface ScheduleReadiness {
  /** True when a weekly or baseline run succeeded with Search Console and GA4 data. */
  ready: boolean;
  lastSuccessful: { jobId: string; type: string; finishedAt: string | null } | null;
  /** Core data stages that were skipped, failed, or degraded in the last successful run (e.g. "sync_gsc (CREDENTIALS_MISSING)"). */
  degradedStages: string[];
  /** Why scheduling should wait, or null when ready. */
  warning: string | null;
}

/**
 * Spec 30 step 8: enable scheduling only after a successful manual run. Looks
 * at the most recent successful (non-dry-run) weekly or baseline job of the
 * site. Not ready when there is none, or when that run's Search Console or GA4
 * sync was skipped, failed, or degraded (for example a no-credential run).
 * A stage skipped because the owner disabled the integration is not a problem.
 */
export function scheduleReadiness(ctx: AppContext): ScheduleReadiness {
  const jobs = [...listJobs(ctx.db, ctx.siteId, { type: 'weekly', limit: 200 }), ...listJobs(ctx.db, ctx.siteId, { type: 'baseline', limit: 200 })]
    .filter((j) => !j.dryRun)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const last: JobRecord | undefined = jobs.find((j) => j.status === 'succeeded');
  if (!last) {
    return {
      ready: false,
      lastSuccessful: null,
      degradedStages: [],
      warning: `No successful weekly or baseline run is recorded for site ${ctx.siteId}. Run \`npm run cli -- baseline\` or \`npm run cli -- weekly\` manually first and review its report, then enable the schedule.`,
    };
  }
  const degraded = new Map<string, string>();
  const result = (last.result ?? null) as { degraded?: Array<{ stage?: string; code?: string }> } | null;
  for (const d of result?.degraded ?? []) {
    if (d.stage && (CORE_DATA_STAGES as readonly string[]).includes(d.stage) && d.code !== 'INTEGRATION_DISABLED') degraded.set(d.stage, d.code ?? 'degraded');
  }
  const store = new CheckpointStore(ctx.db, ctx.clock);
  for (const stage of CORE_DATA_STAGES) {
    if (degraded.has(stage)) continue;
    const n = (store.latestWithOutput(ctx.siteId, last.id, stage)?.output as { note?: { status?: string; code?: string | null } | null } | undefined)?.note;
    if (n && (n.status === 'degraded' || n.status === 'skipped') && n.code !== 'INTEGRATION_DISABLED') degraded.set(stage, n.code ?? n.status);
  }
  const degradedStages = [...degraded].map(([stage, code]) => `${stage} (${code})`);
  const lastSuccessful = { jobId: last.id, type: last.type, finishedAt: last.finishedAt };
  if (!degradedStages.length) return { ready: true, lastSuccessful, degradedStages, warning: null };
  return {
    ready: false,
    lastSuccessful,
    degradedStages,
    warning: `The last successful ${last.type} run (${last.id}${last.finishedAt ? `, ${last.finishedAt}` : ''}) had no complete Google data: ${degradedStages.join(', ')}. Fix access (\`npm run cli -- auth diagnose\`), run it again manually, and review the report before scheduling.`,
  };
}

function parsePlatforms(v: string): SchedulePlatform[] {
  if (v === 'all') return [...SCHEDULE_PLATFORMS];
  const out = v.split(',').map((s) => s.trim());
  for (const p of out) if (!(SCHEDULE_PLATFORMS as readonly string[]).includes(p)) throw new ValidationError(`Unknown platform "${p}" (use ${SCHEDULE_PLATFORMS.join(', ')}, or all)`);
  return out as SchedulePlatform[];
}

function fileNameFor(platform: SchedulePlatform, suggested: string): string {
  if (platform === 'cron') return 'crontab.txt';
  return path.basename(suggested);
}

function buildInstructionsFor(ctx: AppContext, opts: { platform: string; interval: string }): SchedulingInstructions {
  const interval = Number(opts.interval);
  const schedules = listSchedules(ctx.db, ctx.siteId).map((s) => ({
    jobType: s.jobType,
    cron: s.cron,
    timezone: s.timezone,
    enabled: s.enabled,
    nextRunLocal: s.enabled && s.nextRunAt ? formatInZone(new Date(s.nextRunAt), s.timezone) : null,
  }));
  return buildSchedulingInstructions({
    siteId: ctx.siteId,
    workspaceRoot: ctx.paths.root,
    logsDir: ctx.paths.logsDir,
    invocation: resolveCliInvocation(appRoot()),
    timezone: ctx.config.scheduler.timezone,
    schedules,
    intervalMinutes: interval,
    platforms: parsePlatforms(opts.platform),
    serviceUser: os.userInfo().username,
  });
}

/**
 * `schedule run` refuses to start from a compiled build (dist/) that has no
 * build stamp or whose stamp does not match the migrations on disk: after an
 * upgrade without `npm run build`, the scheduler would otherwise run old code
 * against the new checkout's migrations and database. Running from the
 * TypeScript sources (freshness null) is always allowed. The hint is
 * buildRepairSteps: rebuild a checkout, reinstall or upgrade a packaged install.
 */
export function assertScheduledRunBuild(freshness: BuildFreshness | null): void {
  const problem = scheduledRunBuildProblem(freshness);
  if (!problem) return;
  throw new AppError('CONFLICT', `schedule run refused to start: ${problem}. Nothing was enqueued or run.`, {
    // A checkout is rebuilt (`npm run build`); a packaged install or container image without src/ is reinstalled or upgraded.
    hint: buildRepairSteps(freshness),
    details: { distDir: freshness?.distDir ?? null, state: freshness?.state ?? null, reasons: freshness?.reasons ?? [] },
  });
}

function contextsFor(cli: CliRuntime, g: GlobalOptions, allSites: boolean): AppContext[] {
  if (!allSites) return [cli.context(g)];
  const paths = cli.requireWorkspace(g);
  const ids = listSiteIds(paths);
  if (!ids.length) throw new ValidationError('No site configured in this workspace.');
  return ids.map((site) => cli.context({ ...g, site, mode: 'ANALYZE' }));
}

export function register(program: Command, cli: CliRuntime): void {
  const schedule = program.command('schedule').description('Opt-in scheduling of weekly/monthly jobs (IANA time zones, DST-aware); installation is always manual');

  schedule
    .command('show')
    .description('Show schedules, next runs in the schedule time zone, DST notes, and configuration drift')
    .option('--upcoming <n>', 'number of upcoming runs to list', '3')
    .action(
      cli.action(async (opts: { upcoming: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const n = Number(opts.upcoming);
          if (!Number.isInteger(n) || n < 1 || n > 50) throw new ValidationError('--upcoming must be an integer between 1 and 50');
          cli.print(g, describeSchedules(ctx, createDefaultRegistry(), { upcoming: n }), renderOverview);
        } finally {
          ctx.db.close();
        }
      }),
    );

  schedule
    .command('instructions')
    .description('Print exact launchd / systemd / cron / server-daemon snippets (nothing is installed)')
    .option('--platform <platforms>', `comma-separated: ${SCHEDULE_PLATFORMS.join(', ')}, or all`, 'all')
    .option('--interval <minutes>', 'how often the OS timer runs the scheduler tick (5, 10, 15, 20, 30, 60)', '15')
    .option('--write', 'also write the snippets to <workspace>/exports/scheduling/ for review (still not installed)')
    .action(
      cli.action(async (opts: { platform: string; interval: string; write?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const si = buildInstructionsFor(ctx, opts);
          const written: string[] = [];
          if (opts.write && !ctx.dryRun) {
            const dir = safeResolve(ctx.paths.exportsDir, path.join('scheduling', ctx.siteId));
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            for (const b of si.bundles) {
              for (const f of b.files) {
                const file = safeResolve(dir, `${b.platform}-${fileNameFor(b.platform, f.suggestedPath)}`);
                writeFileSync(file, f.content, { mode: 0o600 });
                written.push(file);
              }
            }
            const readme = safeResolve(dir, 'README.txt');
            writeFileSync(readme, `${renderInstructions(si)}\n`, { mode: 0o600 });
            written.push(readme);
          }
          cli.print(g, { ...si, written }, (r: SchedulingInstructions & { written: string[] }) =>
            [renderInstructions(r), ...(r.written.length ? ['', 'Snippets written for review (NOT installed):', ...r.written.map((w) => `  ${w}`)] : [])].join('\n'),
          );
        } finally {
          ctx.db.close();
        }
      }),
    );

  schedule
    .command('enable <jobType>')
    .description('Opt in: record a weekly or monthly schedule (cron and IANA zone from site config unless overridden). Jobs run in the --mode given (ANALYZE default, or RESEARCH). Requires a successful manual weekly or baseline run with Search Console and GA4 data first (or --force).')
    .option('--cron <expr>', '5-field cron expression evaluated in the schedule time zone')
    .option('--timezone <iana>', 'IANA time zone (default: site config scheduler.timezone)')
    .option('--catch-up <policy>', 'after missed slots (sleep/offline): "once" runs one catch-up, "skip" waits for the next slot', 'once')
    .option('--force', 'enable even though no successful manual weekly/baseline run with Search Console and GA4 data is recorded (not recommended)')
    .action(
      cli.action(async (jobType: string, opts: { cron?: string; timezone?: string; catchUp: string; force?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const o = { ...(opts.cron ? { cron: opts.cron } : {}), ...(opts.timezone ? { timezone: opts.timezone } : {}), mode: g.mode ?? 'ANALYZE', catchUp: opts.catchUp, actor: 'cli' };
          // Spec 30 step 8: scheduling follows a successful manual run.
          const readiness = scheduleReadiness(ctx);
          const readinessWarning = readiness.warning ? `WARNING: ${readiness.warning}${opts.force ? ' Enabled anyway because --force was given.' : ''}` : null;
          if (ctx.dryRun) {
            const plan = { ...planSchedule(ctx, jobType, o), dryRun: true, readiness, ...(readiness.warning && !opts.force ? { wouldRequireForce: true } : {}) };
            cli.print(g, plan, (p: typeof plan) => `${renderPlan(p)}${p.readiness.warning ? `\nWARNING: ${p.readiness.warning}${opts.force ? '' : ' A real run would refuse without --force.'}` : ''}`);
            return;
          }
          if (readiness.warning && !opts.force) {
            if (!g.json) cli.io.err(`WARNING: ${readiness.warning}`);
            throw new AppError('POLICY_DENIED', `Not enabling the ${jobType} schedule: scheduling starts only after a successful manual run with Search Console and GA4 data. Nothing was changed.`, {
              hint: 'Run `npm run cli -- weekly` (or `baseline`) manually and review its report, then retry. To enable anyway, pass --force.',
              details: { readiness },
            });
          }
          const { plan } = enableSchedule(ctx, jobType, o);
          const registered = createDefaultRegistry().has(plan.jobType);
          cli.print(g, { ...plan, handlerRegistered: registered, readiness, ...(readiness.warning ? { forced: true } : {}) }, (p: SchedulePlan & { handlerRegistered: boolean }) =>
            `${renderPlan(p)}${p.handlerRegistered ? '' : `\nWARNING: no "${p.jobType}" job handler is registered in this build yet; due slots will be skipped with an explanation until it is.`}${readinessWarning ? `\n${readinessWarning}` : ''}`,
          );
        } finally {
          ctx.db.close();
        }
      }),
    );

  schedule
    .command('disable <jobType>')
    .description('Disable a weekly or monthly schedule (does not uninstall any OS timer you installed)')
    .action(
      cli.action(async (jobType: string, _opts: unknown, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          if (ctx.dryRun) {
            cli.print(g, { dryRun: true, jobType, would: 'disable' }, () => `Dry run: would disable the ${jobType} schedule.`);
            return;
          }
          const r = disableSchedule(ctx, jobType, 'cli');
          cli.print(g, r, (x: typeof r) =>
            x.changed
              ? `Disabled the ${jobType} schedule. Any OS timer you installed keeps running the tick, which now does nothing for ${jobType}; uninstall it with the steps from \`schedule instructions\` if no longer needed.`
              : `The ${jobType} schedule was not enabled; nothing changed.`,
          );
        } finally {
          ctx.db.close();
        }
      }),
    );

  schedule
    .command('run')
    .description('Foreground scheduler: enqueue due jobs and run them (non-overlapping per site). Use --once for a single tick from launchd/systemd/cron.')
    .option('--once', 'run a single tick and exit')
    .option('--tick-seconds <n>', 'seconds between ticks in daemon mode', '60')
    .option('--all-sites', 'serve every site configured in the workspace')
    .option('--max-ticks <n>', 'stop after n ticks (testing)')
    .action(
      cli.action(async (opts: { once?: boolean; tickSeconds: string; allSites?: boolean; maxTicks?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const tickSeconds = Number(opts.tickSeconds);
        if (!Number.isInteger(tickSeconds) || tickSeconds < 1) throw new ValidationError('--tick-seconds must be a positive integer');
        const maxTicks = opts.once ? 1 : opts.maxTicks !== undefined ? Number(opts.maxTicks) : undefined;
        if (maxTicks !== undefined && (!Number.isInteger(maxTicks) || maxTicks < 1)) throw new ValidationError('--max-ticks must be a positive integer');
        // Before any context is built (building one applies pending migrations).
        assertScheduledRunBuild(runningBuildFreshness());
        const contexts = contextsFor(cli, g, !!opts.allSites);
        const registry = createDefaultRegistry();
        try {
          if (contexts.some((c) => c.dryRun)) {
            const results: TickResult[] = [];
            for (const ctx of contexts) results.push(await schedulerTick(ctx, { registry, dryRun: true }));
            cli.print(g, { dryRun: true, ticks: results }, (r: { ticks: TickResult[] }) => ['Dry run (nothing enqueued or run):', ...r.ticks.map(renderTick)].join('\n'));
            return;
          }
          // Unattended runs never exceed RESEARCH mode (no drafting or publishing).
          const runner = new JobRunner({ registry, maxMode: 'RESEARCH' });
          const sig = signalController();
          const all: TickResult[] = [];
          try {
            if (!opts.once && !g.json) {
              cli.io.err(
                `Scheduler running in the foreground (tick every ${tickSeconds}s). Press Ctrl+C to stop; a running job is left "interrupted" and the first tick after the next start resumes it from its checkpoints (paid stages that were in flight need \`jobs resume <id> --rerun-paid-stages\` after reconciliation).`,
              );
            }
            await runSchedulerDaemon({
              contexts,
              registry,
              runner,
              tickMs: tickSeconds * 1000,
              signal: sig.signal,
              ...(maxTicks !== undefined ? { maxTicks } : {}),
              // Daemon output bypasses cli.print, so it is redacted here (job records carry params and results).
              onTick: (results) => {
                if (opts.once) all.push(...results);
                else if (g.json) cli.io.out(JSON.stringify(redact(results)));
                else for (const r of results) cli.io.out(renderDaemonTick(r));
              },
              onError: (siteId, err) => cli.io.err(redactString(`Scheduler tick failed for ${siteId}: ${err instanceof Error ? err.message : String(err)}`)),
            });
            if (runner.pendingLockHolds) {
              cli.io.err('A stage ignored its abort signal and is still running; keeping the site lock until it settles.');
              await runner.settled();
            }
          } finally {
            sig.dispose();
          }
          if (opts.once) cli.print(g, { ticks: all }, (r: { ticks: TickResult[] }) => r.ticks.map(renderTick).join('\n'));
        } finally {
          for (const c of contexts) c.db.close();
        }
      }),
    );
}
