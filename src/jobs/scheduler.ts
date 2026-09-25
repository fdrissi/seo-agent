import { Cron } from 'croner';
import type { AppContext } from '../app/context.js';
import { sleep as defaultSleep } from '../core/concurrency.js';
import { AppError, ValidationError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { formatUsd, toMicros } from '../core/money.js';
import type { RuntimeMode } from '../core/modes.js';
import { isValidTimeZone } from '../core/time.js';
import { recordAudit } from '../database/audit.js';
import type { Db } from '../database/db.js';
import { toErrorInfo } from '../workflows/errors.js';
import { dstNotesForCron, type DstNote } from './dst.js';
import type { JobRegistry } from './registry.js';
import { DEFAULT_AUTO_RESUME, autoResumeDecision, type AutoResumePolicy, type JobRunner, type NeedsAttention, type RecoveredJob, type RunJobResult } from './runner.js';
import { enqueue, getJob } from './store.js';

/**
 * Opt-in scheduling (spec section 27).
 *
 * - Schedules live in the `schedules` table; nothing is enabled or installed
 *   automatically. `schedule enable weekly|monthly` is the explicit opt-in.
 * - Due times are computed by croner in the schedule's IANA time zone
 *   (default: site config `scheduler.timezone`, itself defaulting to
 *   Europe/Tallinn), so daylight-saving changes are handled by the time zone
 *   database. No UTC offsets are hardcoded anywhere.
 * - A tick enqueues each due schedule once (compare-and-set on next_run_at,
 *   safe with several tick processes), then drains the site's queue with the
 *   non-overlapping job runner. Only jobs the scheduler enqueued run
 *   unattended: a queued job a human started in the foreground is reported
 *   in `needsAttention`, never run, and never makes a slot be skipped. After a sleeping/offline period, missed slots
 *   are collapsed into ONE catch-up run (catch_up = 'once') or dropped
 *   (catch_up = 'skip'). A machine that is asleep or off cannot run jobs.
 * - A scheduled job that was interrupted (shutdown, crash, lock loss) is
 *   resumed by the next tick from its checkpoints, up to
 *   DEFAULT_MAX_AUTO_RESUMES consecutive interruptions. Past that cap, or for
 *   a job a human started, the tick reports it in `needsAttention` and later
 *   slots of that type are skipped until someone runs `jobs resume` or
 *   `jobs cancel`. Paid stages that were in flight are never rerun
 *   automatically (the job stops with AMBIGUOUS_SUBMISSION).
 * - Scheduled jobs run only in ANALYZE or RESEARCH mode; they never draft or
 *   publish.
 */

export const SCHEDULABLE_JOB_TYPES = ['weekly', 'monthly'] as const;
export type SchedulableJobType = (typeof SCHEDULABLE_JOB_TYPES)[number];
export const SCHEDULE_MODES = ['ANALYZE', 'RESEARCH'] as const satisfies readonly RuntimeMode[];
export type ScheduleMode = (typeof SCHEDULE_MODES)[number];
export type CatchUpPolicy = 'once' | 'skip';

/** With catch_up = 'skip', a slot later than this is dropped instead of run. */
export const SKIP_GRACE_MS = 60 * 60_000;

export function isSchedulableJobType(t: string): t is SchedulableJobType {
  return (SCHEDULABLE_JOB_TYPES as readonly string[]).includes(t);
}

/** Validate a standard 5-field cron expression in an IANA zone; returns the parsed croner instance. */
export function parseCron(expr: string, timeZone: string): Cron {
  if (!isValidTimeZone(timeZone) || /^(UTC|GMT)?[+-]\d/i.test(timeZone)) {
    throw new ValidationError(`"${timeZone}" is not an IANA time zone name (use e.g. "Europe/Tallinn"; fixed UTC offsets are not accepted)`);
  }
  try {
    return new Cron(expr.trim(), { timezone: timeZone, paused: true, mode: '5-part' });
  } catch (err) {
    throw new ValidationError(`Invalid cron expression "${expr}": ${(err as Error).message}`, {
      errors: ['Use 5 fields: minute hour day-of-month month day-of-week, e.g. "0 7 * * 1" (Mondays 07:00).'],
    });
  }
}

/** Next scheduled instant strictly after `after`, computed in the IANA zone (DST-correct). */
export function nextRunAfter(expr: string, timeZone: string, after: Date): Date | null {
  return parseCron(expr, timeZone).nextRun(after);
}

export function nextRuns(expr: string, timeZone: string, after: Date, count: number): Date[] {
  return parseCron(expr, timeZone).nextRuns(count, after);
}

/** Human rendering of an instant in a zone, e.g. "2026-10-26 07:00 GMT+2 (Europe/Tallinn)". */
export function formatInZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
    timeZoneName: 'shortOffset',
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')} ${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} ${get('timeZoneName')} (${timeZone})`;
}

export interface ScheduleRecord {
  id: string;
  siteId: string;
  jobType: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  mode: ScheduleMode;
  catchUp: CatchUpPolicy;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastJobId: string | null;
  lastNote: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ScheduleRow {
  id: string;
  site_id: string;
  job_type: string;
  cron: string;
  timezone: string;
  enabled: number;
  mode: ScheduleMode;
  catch_up: CatchUpPolicy;
  last_run_at: string | null;
  next_run_at: string | null;
  last_job_id: string | null;
  last_note: string | null;
  created_at: string;
  updated_at: string;
}

const toRecord = (r: ScheduleRow): ScheduleRecord => ({
  id: r.id,
  siteId: r.site_id,
  jobType: r.job_type,
  cron: r.cron,
  timezone: r.timezone,
  enabled: r.enabled === 1,
  mode: r.mode,
  catchUp: r.catch_up,
  lastRunAt: r.last_run_at,
  nextRunAt: r.next_run_at,
  lastJobId: r.last_job_id,
  lastNote: r.last_note,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function getSchedule(db: Db, siteId: string, jobType: string): ScheduleRecord | undefined {
  const r = db.get<ScheduleRow>('SELECT * FROM schedules WHERE site_id = ? AND job_type = ?', [siteId, jobType]);
  return r ? toRecord(r) : undefined;
}

export function listSchedules(db: Db, siteId: string): ScheduleRecord[] {
  return db.all<ScheduleRow>('SELECT * FROM schedules WHERE site_id = ? ORDER BY job_type', [siteId]).map(toRecord);
}

export interface EnableScheduleOptions {
  cron?: string;
  timezone?: string;
  mode?: string;
  catchUp?: string;
  actor?: string;
}

export interface SchedulePlan {
  siteId: string;
  jobType: SchedulableJobType;
  cron: string;
  timezone: string;
  mode: ScheduleMode;
  catchUp: CatchUpPolicy;
  nextRunAt: string;
  nextRunLocal: string;
  upcoming: string[];
  dstNotes: DstNote[];
  sources: { cron: 'flag' | 'site-config'; timezone: 'flag' | 'site-config' };
  /** Configured caps that bound what unattended runs of this schedule may spend (ceilings, not price quotes). */
  spendingCaps: string[];
}

function spendingCaps(config: AppContext['config'], mode: ScheduleMode): string[] {
  const b = config.budgets;
  const usd = (v: string) => formatUsd(toMicros(v));
  const caps = [`llm_gateway: up to ${usd(b.llmGateway.perRunUsd)} per run, ${usd(b.llmGateway.monthlyUsd)} per month (only when a model connection is configured)`];
  if (mode === 'RESEARCH') {
    caps.push(
      `dataforseo: up to ${usd(b.dataforseo.perRunUsd)} per run, ${usd(b.dataforseo.weeklyUsd)} per week, ${usd(b.dataforseo.monthlyUsd)} per month (only when enabled)`,
      `apify: up to ${usd(b.apify.perRunUsd)} per run, ${usd(b.apify.monthlyUsd)} per month (only when enabled)`,
    );
  } else {
    caps.push('ANALYZE mode: no paid external research (DataForSEO/Apify) is started by scheduled runs.');
  }
  caps.push(`combined variable ceiling for the site: ${usd(b.combinedMonthlyUsd)} per month`);
  return caps;
}

/** Compute what `schedule enable` would write (no side effects; used for --dry-run). */
export function planSchedule(ctx: Pick<AppContext, 'siteId' | 'config' | 'clock'>, jobType: string, opts: EnableScheduleOptions = {}): SchedulePlan {
  if (!isSchedulableJobType(jobType)) throw new ValidationError(`Only ${SCHEDULABLE_JOB_TYPES.join(' and ')} jobs can be scheduled (got "${jobType}")`);
  const cron = (opts.cron ?? ctx.config.scheduler[jobType].cron).trim();
  const timezone = opts.timezone ?? ctx.config.scheduler.timezone;
  const mode = (opts.mode ?? 'ANALYZE').toUpperCase();
  if (!(SCHEDULE_MODES as readonly string[]).includes(mode)) {
    throw new ValidationError(`Scheduled jobs may only run in ${SCHEDULE_MODES.join(' or ')} mode (got ${mode}); drafting and publishing always need an explicit human run.`);
  }
  const catchUp = opts.catchUp ?? 'once';
  if (catchUp !== 'once' && catchUp !== 'skip') throw new ValidationError('catch-up must be "once" or "skip"');
  const now = ctx.clock.now();
  const cronJob = parseCron(cron, timezone);
  const upcoming = cronJob.nextRuns(3, now);
  const next = upcoming[0];
  if (!next) throw new ValidationError(`Cron "${cron}" never fires`);
  return {
    siteId: ctx.siteId,
    jobType,
    cron,
    timezone,
    mode: mode as ScheduleMode,
    catchUp,
    nextRunAt: next.toISOString(),
    nextRunLocal: formatInZone(next, timezone),
    upcoming: upcoming.map((d) => formatInZone(d, timezone)),
    dstNotes: dstNotesForCron(cron, timezone, now),
    sources: { cron: opts.cron ? 'flag' : 'site-config', timezone: opts.timezone ? 'flag' : 'site-config' },
    spendingCaps: spendingCaps(ctx.config, mode as ScheduleMode),
  };
}

/** Explicit opt-in: create or update the schedule row and compute its next run. */
export function enableSchedule(ctx: Pick<AppContext, 'db' | 'siteId' | 'config' | 'clock'>, jobType: string, opts: EnableScheduleOptions = {}): { schedule: ScheduleRecord; plan: SchedulePlan } {
  const plan = planSchedule(ctx, jobType, opts);
  const now = ctx.clock.now().toISOString();
  ctx.db.transaction(() => {
    ctx.db.run(
      `INSERT INTO schedules (id, site_id, job_type, cron, timezone, enabled, mode, catch_up, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT (site_id, job_type) DO UPDATE SET cron = excluded.cron, timezone = excluded.timezone, enabled = 1, mode = excluded.mode,
         catch_up = excluded.catch_up, next_run_at = excluded.next_run_at, updated_at = excluded.updated_at`,
      [newId('sched'), ctx.siteId, plan.jobType, plan.cron, plan.timezone, plan.mode, plan.catchUp, plan.nextRunAt, now, now],
    );
    recordAudit(ctx.db, {
      siteId: ctx.siteId,
      actor: opts.actor ?? 'cli',
      eventType: 'schedule.enabled',
      subjectType: 'schedule',
      subjectId: plan.jobType,
      details: { cron: plan.cron, timezone: plan.timezone, mode: plan.mode, catchUp: plan.catchUp, nextRunAt: plan.nextRunAt },
      at: ctx.clock.now(),
    });
  });
  return { schedule: getSchedule(ctx.db, ctx.siteId, plan.jobType)!, plan };
}

export function disableSchedule(ctx: Pick<AppContext, 'db' | 'siteId' | 'clock'>, jobType: string, actor = 'cli'): { changed: boolean; schedule: ScheduleRecord | null } {
  if (!isSchedulableJobType(jobType)) throw new ValidationError(`Only ${SCHEDULABLE_JOB_TYPES.join(' and ')} schedules exist (got "${jobType}")`);
  const now = ctx.clock.now();
  const changed = ctx.db.transaction(() => {
    const r = ctx.db.run('UPDATE schedules SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE site_id = ? AND job_type = ? AND enabled = 1', [now.toISOString(), ctx.siteId, jobType]);
    if (r.changes) recordAudit(ctx.db, { siteId: ctx.siteId, actor, eventType: 'schedule.disabled', subjectType: 'schedule', subjectId: jobType, at: now });
    return r.changes > 0;
  });
  return { changed, schedule: getSchedule(ctx.db, ctx.siteId, jobType) ?? null };
}

export interface ScheduleView {
  jobType: SchedulableJobType;
  enabled: boolean;
  configPreference: { enabled: boolean; cron: string };
  schedule: ScheduleRecord | null;
  handlerRegistered: boolean;
  nextRunLocal: string | null;
  upcoming: string[];
  dstNotes: DstNote[];
  drift: string[];
  /**
   * An earlier job of this type that makes due slots be skipped (queued,
   * running, or interrupted), and whether the scheduler resumes it by itself.
   */
  blockedBy: { jobId: string; status: string; autoResume: boolean; detail: string } | null;
}

export interface ScheduleOverview {
  siteId: string;
  configTimezone: string;
  schedules: ScheduleView[];
  notes: string[];
}

/**
 * The most recent unfinished job of a type that blocks new scheduled slots,
 * with an honest explanation: a running or interrupted job of the type, or a
 * job the scheduler itself queued (`params.trigger = 'schedule'`). A queued
 * job a human started in the foreground is ignored: the tick never runs it,
 * so it must not make a real slot be skipped either.
 */
export function blockingJob(
  db: Db,
  siteId: string,
  jobType: string,
  policy: AutoResumePolicy | null = DEFAULT_AUTO_RESUME,
): { jobId: string; status: string; autoResume: boolean; detail: string } | null {
  const active = db.get<{ id: string; status: string }>(
    `SELECT id, status FROM jobs WHERE site_id = ? AND type = ?
       AND (status IN ('running', 'interrupted') OR (status = 'queued' AND json_extract(params_json, '$.trigger') = 'schedule'))
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [siteId, jobType],
  );
  if (!active) return null;
  if (active.status !== 'interrupted') {
    return { jobId: active.id, status: active.status, autoResume: false, detail: `previous ${jobType} job ${active.id} is still ${active.status}; runs never overlap` };
  }
  const job = getJob(db, siteId, active.id)!;
  const d = policy ? autoResumeDecision(db, job, policy) : { eligible: false as const, reason: 'automatic resume is disabled for this scheduler', interruptions: 0 };
  if (d.eligible) {
    return { jobId: job.id, status: job.status, autoResume: true, detail: `previous ${jobType} job ${job.id} was interrupted; the scheduler resumes it from its checkpoints on this or the next tick; runs never overlap` };
  }
  return {
    jobId: job.id,
    status: job.status,
    autoResume: false,
    detail: `BLOCKED: previous ${jobType} job ${job.id} is interrupted and is not resumed automatically (${d.reason}); new ${jobType} slots are skipped until it is resumed or cancelled`,
  };
}

/** Read-only overview for `schedule show`. */
export function describeSchedules(ctx: Pick<AppContext, 'db' | 'siteId' | 'config' | 'clock'>, registry: JobRegistry, opts: { upcoming?: number } = {}): ScheduleOverview {
  const now = ctx.clock.now();
  const views: ScheduleView[] = SCHEDULABLE_JOB_TYPES.map((jobType) => {
    const pref = ctx.config.scheduler[jobType];
    const row = getSchedule(ctx.db, ctx.siteId, jobType) ?? null;
    const drift: string[] = [];
    let upcoming: string[] = [];
    let dstNotes: DstNote[] = [];
    let nextRunLocal: string | null = null;
    if (row) {
      if (row.cron !== pref.cron) drift.push(`site config cron is "${pref.cron}" but the enabled schedule uses "${row.cron}"; re-run \`schedule enable ${jobType}\` to apply the config value.`);
      if (row.timezone !== ctx.config.scheduler.timezone) drift.push(`site config timezone is ${ctx.config.scheduler.timezone} but the schedule uses ${row.timezone}.`);
      if (row.enabled) {
        try {
          const tz = row.timezone;
          const from = row.nextRunAt ? new Date(Math.max(Date.parse(row.nextRunAt) - 1000, 0)) : now;
          upcoming = nextRuns(row.cron, tz, from, opts.upcoming ?? 3).map((d) => formatInZone(d, tz));
          nextRunLocal = row.nextRunAt ? formatInZone(new Date(row.nextRunAt), tz) : null;
          dstNotes = dstNotesForCron(row.cron, tz, now);
        } catch (err) {
          drift.push(`schedule cannot be evaluated: ${toErrorInfo(err).message}`);
        }
      }
    }
    if (pref.enabled && !row?.enabled) drift.push(`site config prefers ${jobType} scheduling, but it is not enabled; run \`schedule enable ${jobType}\` to opt in.`);
    const blockedBy = row?.enabled ? blockingJob(ctx.db, ctx.siteId, jobType) : null;
    return {
      jobType,
      enabled: !!row?.enabled,
      configPreference: { enabled: pref.enabled, cron: pref.cron },
      schedule: row,
      handlerRegistered: registry.has(jobType),
      nextRunLocal,
      upcoming,
      dstNotes,
      drift,
      blockedBy,
    };
  });
  return {
    siteId: ctx.siteId,
    configTimezone: ctx.config.scheduler.timezone,
    schedules: views,
    notes: [
      'Scheduling is opt-in. Enabling a schedule only records it in the database; something must run `schedule run` (foreground daemon) or a periodic `schedule run --once`. See `schedule instructions`.',
      'A sleeping, powered-off, or offline machine cannot run jobs. Missed slots run once at the next tick (catch-up "once") or are skipped (catch-up "skip").',
      `An interrupted scheduled job is resumed from its checkpoints by the next tick (up to ${DEFAULT_AUTO_RESUME.maxConsecutiveInterruptions} interruptions in a row); otherwise it needs \`jobs resume <id>\` or \`jobs cancel <id>\`, and new slots of its type are skipped until then.`,
      'Scheduled jobs run in ANALYZE or RESEARCH mode only and never draft or publish.',
    ],
  };
}

export interface TickItem {
  jobType: string;
  scheduleId: string;
  scheduledFor: string;
  action: 'enqueued' | 'skipped' | 'would_enqueue';
  jobId?: string;
  reason?: string;
  /** Additional slots that passed while the scheduler was not running (collapsed into this one). */
  missedSlots: number;
  nextRunAt: string | null;
}

export interface TickResult {
  siteId: string;
  at: string;
  items: TickItem[];
  recovered: RecoveredJob[];
  ran: RunJobResult[];
  /** Jobs that block scheduling and need a human (e.g. interrupted too often to resume automatically). */
  needsAttention: NeedsAttention[];
  /** Due slots that another tick process claimed first (compare-and-set lost); nothing was done for them here. */
  handledElsewhere: Array<{ jobType: string; scheduledFor: string }>;
}

export interface TickOptions {
  registry: JobRegistry;
  runner?: JobRunner;
  /** Drain the queue after enqueueing (default true when a runner is given). */
  runJobs?: boolean;
  /** Report what would happen without writing or running anything. */
  dryRun?: boolean;
  signal?: AbortSignal;
  actor?: string;
  /**
   * Resume interrupted scheduled jobs while draining (default: on, with
   * DEFAULT_AUTO_RESUME). `false` leaves every interrupted job for a human.
   */
  autoResume?: Partial<AutoResumePolicy> | false;
  /**
   * Testing seam: awaited after the due slots were read and before any is
   * committed, to exercise concurrent tick processes deterministically.
   */
  afterPlan?: () => Promise<void> | void;
}

function countMissed(cron: Cron, from: Date, to: Date): number {
  let n = 0;
  let cursor: Date | null = from;
  while (n < 1000) {
    cursor = cron.nextRun(cursor);
    if (!cursor || cursor.getTime() > to.getTime()) break;
    n++;
  }
  return n;
}

/**
 * One scheduler tick for one site: enqueue each due schedule once, then
 * (optionally) run due jobs with the non-overlapping runner.
 */
export async function schedulerTick(ctx: AppContext, opts: TickOptions): Promise<TickResult> {
  const now = ctx.clock.now();
  const nowIso = now.toISOString();
  const items: TickItem[] = [];
  const db = ctx.db;

  // Enabled rows without a next run (e.g. enabled by an older version) get one computed.
  if (!opts.dryRun) {
    for (const r of db.all<ScheduleRow>('SELECT * FROM schedules WHERE site_id = ? AND enabled = 1 AND next_run_at IS NULL', [ctx.siteId])) {
      try {
        const next = nextRunAfter(r.cron, r.timezone, now);
        db.run('UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ? AND next_run_at IS NULL', [next?.toISOString() ?? null, nowIso, r.id]);
      } catch (err) {
        db.run('UPDATE schedules SET last_note = ?, updated_at = ? WHERE id = ?', [`invalid schedule: ${toErrorInfo(err).message}`, nowIso, r.id]);
      }
    }
  }

  const autoResume: AutoResumePolicy | null = opts.autoResume === false ? null : { ...DEFAULT_AUTO_RESUME, ...(opts.autoResume ?? {}) };
  const handledElsewhere: TickResult['handledElsewhere'] = [];
  const due = db.all<ScheduleRow>('SELECT * FROM schedules WHERE site_id = ? AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at', [ctx.siteId, nowIso]);
  if (opts.afterPlan) await opts.afterPlan();
  for (const row of due) {
    const scheduledFor = row.next_run_at!;
    let cron: Cron;
    try {
      cron = parseCron(row.cron, row.timezone);
    } catch (err) {
      items.push({ jobType: row.job_type, scheduleId: row.id, scheduledFor, action: 'skipped', reason: `invalid schedule: ${toErrorInfo(err).message}`, missedSlots: 0, nextRunAt: null });
      continue;
    }
    const missedSlots = countMissed(cron, new Date(scheduledFor), now);
    const next = cron.nextRun(now);
    const nextIso = next ? next.toISOString() : null;
    const lateMs = now.getTime() - Date.parse(scheduledFor);

    let skipReason: string | undefined;
    if (row.catch_up === 'skip' && lateMs > SKIP_GRACE_MS) skipReason = `missed slot ${scheduledFor} (catch-up policy "skip")`;
    else if (!opts.registry.has(row.job_type)) skipReason = `no job handler is registered for "${row.job_type}" in this build; nothing was enqueued`;
    else {
      // Interrupted jobs are resumed by the drain below only when this tick runs jobs (a dry run previews that decision).
      const blocked = blockingJob(db, ctx.siteId, row.job_type, (opts.runner || opts.dryRun) && opts.runJobs !== false ? autoResume : null);
      if (blocked) skipReason = blocked.detail;
    }

    if (opts.dryRun) {
      items.push({ jobType: row.job_type, scheduleId: row.id, scheduledFor, action: skipReason ? 'skipped' : 'would_enqueue', ...(skipReason ? { reason: skipReason } : {}), missedSlots, nextRunAt: nextIso });
      continue;
    }

    const item = db.transaction((): TickItem | null => {
      const note = skipReason ? `skipped ${scheduledFor}: ${skipReason}` : `enqueued for ${scheduledFor}${missedSlots ? ` (+${missedSlots} missed slot(s) collapsed)` : ''}`;
      const cas = db.run('UPDATE schedules SET next_run_at = ?, last_note = ?, updated_at = ? WHERE id = ? AND enabled = 1 AND next_run_at = ?', [nextIso, note, nowIso, row.id, scheduledFor]);
      if (cas.changes === 0) return null; // another tick process claimed this slot first
      if (skipReason) {
        recordAudit(db, { siteId: ctx.siteId, actor: opts.actor ?? 'scheduler', eventType: 'schedule.skipped', subjectType: 'schedule', subjectId: row.job_type, details: { scheduledFor, reason: skipReason }, at: now });
        return { jobType: row.job_type, scheduleId: row.id, scheduledFor, action: 'skipped', reason: skipReason, missedSlots, nextRunAt: nextIso };
      }
      try {
        const job = enqueue({ db, siteId: ctx.siteId, clock: ctx.clock, mode: row.mode, dryRun: false }, row.job_type, { trigger: 'schedule', scheduleId: row.id, scheduledFor, timezone: row.timezone }, {
          registry: opts.registry,
          mode: row.mode,
          dryRun: false,
          actor: opts.actor ?? 'scheduler',
        });
        db.run('UPDATE schedules SET last_run_at = ?, last_job_id = ? WHERE id = ?', [nowIso, job.id, row.id]);
        return { jobType: row.job_type, scheduleId: row.id, scheduledFor, action: 'enqueued', jobId: job.id, missedSlots, nextRunAt: nextIso };
      } catch (err) {
        // The slot is consumed (next_run_at already advanced) so a broken handler cannot cause an enqueue loop.
        const reason = `enqueue failed: ${toErrorInfo(err).message}`;
        db.run('UPDATE schedules SET last_note = ? WHERE id = ?', [`skipped ${scheduledFor}: ${reason}`, row.id]);
        return { jobType: row.job_type, scheduleId: row.id, scheduledFor, action: 'skipped', reason, missedSlots, nextRunAt: nextIso };
      }
    });
    if (item) items.push(item);
    else handledElsewhere.push({ jobType: row.job_type, scheduledFor });
  }

  let recovered: RecoveredJob[] = [];
  let ran: RunJobResult[] = [];
  let needsAttention: NeedsAttention[] = [];
  if (!opts.dryRun && opts.runner && opts.runJobs !== false) {
    // Only jobs the scheduler enqueued run unattended (a foreground job a human started never does).
    const r = await opts.runner.drain(ctx, { autoResume: autoResume ?? false, scheduledOnly: true, ...(opts.signal ? { signal: opts.signal } : {}) });
    recovered = r.recovered;
    ran = r.results;
    needsAttention = r.needsAttention;
  }
  return { siteId: ctx.siteId, at: nowIso, items, recovered, ran, needsAttention, handledElsewhere };
}

export interface DaemonOptions {
  /** Site contexts to serve (built once; restart the daemon after config changes). */
  contexts: AppContext[];
  registry: JobRegistry;
  runner: JobRunner;
  /** Interval between ticks. Default 60 s. */
  tickMs?: number;
  signal?: AbortSignal;
  /** Stop after this many ticks (tests, `--once`). */
  maxTicks?: number;
  onTick?: (results: TickResult[]) => void;
  onError?: (siteId: string, error: unknown) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Passed to every tick (default: resume interrupted scheduled jobs). */
  autoResume?: Partial<AutoResumePolicy> | false;
}

/**
 * Foreground scheduler loop (`schedule run`). Runs until the signal aborts
 * (SIGINT/SIGTERM in the CLI). A job running at shutdown is aborted and left
 * `interrupted`; the first tick after the next start resumes it from its
 * checkpoints (scheduled jobs only, up to DEFAULT_MAX_AUTO_RESUMES
 * interruptions in a row; beyond that, or for a job a human started, it is
 * reported in `needsAttention` and needs `jobs resume <id>`). Paid stages that
 * were in flight are never rerun automatically.
 */
export async function runSchedulerDaemon(opts: DaemonOptions): Promise<{ ticks: number }> {
  const tickMs = opts.tickMs ?? 60_000;
  if (!Number.isInteger(tickMs) || tickMs < 1) throw new RangeError('tickMs must be a positive integer');
  if (!opts.contexts.length) throw new AppError('CONFIG_MISSING', 'No site to schedule');
  const sleep = opts.sleep ?? defaultSleep;
  let ticks = 0;
  while (!opts.signal?.aborted) {
    const results: TickResult[] = [];
    for (const ctx of opts.contexts) {
      if (opts.signal?.aborted) break;
      try {
        results.push(
          await schedulerTick(ctx, {
            registry: opts.registry,
            runner: opts.runner,
            ...(opts.autoResume !== undefined ? { autoResume: opts.autoResume } : {}),
            ...(opts.signal ? { signal: opts.signal } : {}),
          }),
        );
      } catch (err) {
        opts.onError?.(ctx.siteId, err);
      }
    }
    ticks++;
    opts.onTick?.(results);
    if (opts.maxTicks !== undefined && ticks >= opts.maxTicks) break;
    try {
      await sleep(tickMs, opts.signal);
    } catch {
      break;
    }
  }
  return { ticks };
}
