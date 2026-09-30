import path from 'node:path';
import { budgetTimeZone, type AppContext } from '../app/context.js';
import { AppError, errorMessage } from '../core/errors.js';
import { isoWeekKey } from '../core/time.js';
import { recordAudit } from '../database/audit.js';
import { sendTelegramMessage, type TelegramOptions } from '../integrations/telegram/client.js';
import type { FetchLike } from '../integrations/types.js';
import type { JobRecord } from '../jobs/types.js';
import { atomicWriteFile } from '../obsidian/fs-safe.js';
import type { Report } from '../reports/model.js';
import { readReportFile, resolveReportFile, type ReportRow } from '../reports/storage.js';
import { redactString } from '../security/redact.js';
import { errorCodeOf } from '../workflows/errors.js';
import { preparePlansDir, resolvePlansDir } from './folder.js';
import { renderWeeklyPlan, type PlanFailure, type PlanStatus, type PriorTest, type WeeklyPlanInput } from './render.js';

/**
 * After a weekly job settles: write the action plan, then send the Telegram
 * notification. Both are follow-ups, never part of the job: whatever happens
 * here, the job's recorded outcome stays as it is. Each step records an audit
 * event on the job (`action_plan.*`, `notification.*`), which is also where
 * `npm run weekly` reads what happened (followUpsOf).
 */

export const WEEKLY_JOB_TYPE = 'weekly';

export type FollowUpKind = 'action_plan' | 'telegram';
export interface FollowUp {
  kind: FollowUpKind;
  /** action_plan: written | skipped | failed. telegram: sent | skipped | failed. */
  status: string;
  detail: string;
  /** action_plan only: absolute path of the plan file. */
  path?: string;
  /** action_plan only: action | n/a | blocked. */
  planStatus?: PlanStatus;
}

/** The part of a settled job run a follow-up needs (RunJobResult fits). */
export interface SettledJob {
  outcome: string;
  job: JobRecord;
  error?: { code: string; message: string; hint?: string };
  reason?: string;
}

export interface PublishDeps {
  fetch?: FetchLike;
  telegram?: TelegramOptions;
}

interface JobResultShape {
  failure?: { stage?: string; code?: string; message?: string } | null;
  stoppedBy?: { stage?: string } | null;
  degradedStages?: Array<{ stage: string; status: string; reason: string }>;
}

/** ISO week of a job's plan: the week the job finished (now for a job still settling), in the budget time zone. */
export function planWeek(ctx: Pick<AppContext, 'clock' | 'config'>, job: Pick<JobRecord, 'finishedAt'>): string {
  const at = job.finishedAt ? new Date(job.finishedAt) : ctx.clock.now();
  return isoWeekKey(Number.isNaN(at.getTime()) ? ctx.clock.now() : at, budgetTimeZone(ctx.config));
}

function audit(ctx: AppContext, jobId: string, eventType: string, details: Record<string, unknown>): void {
  try {
    recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType, subjectType: 'job', subjectId: jobId, details, at: ctx.clock.now() });
  } catch (err) {
    ctx.logger.warn(`Could not record ${eventType} for job ${jobId}: ${errorMessage(err)}`);
  }
}

/** Concluded experiments of the site, newest first (what the plan lists as already tested). */
export function priorTests(ctx: Pick<AppContext, 'db' | 'siteId'>, limit = 15): PriorTest[] {
  return ctx.db
    .all<{ id: string; type: string; status: string; url: string | null; updated_at: string }>(
      `SELECT e.id, e.type, e.status, p.url, e.updated_at FROM experiments e LEFT JOIN pages p ON p.id = e.page_id AND p.site_id = e.site_id
       WHERE e.site_id = ? AND e.status IN ('positive', 'negative', 'inconclusive', 'cancelled')
       ORDER BY e.updated_at DESC, e.id DESC LIMIT ?`,
      [ctx.siteId, limit],
    )
    .map((r) => ({ id: r.id, type: r.type, status: r.status, pageUrl: r.url, decidedAt: r.updated_at }));
}

function weeklyReportOf(ctx: AppContext, jobId: string): { row: ReportRow; report: Report } | null {
  const row = ctx.db.get<ReportRow>(`SELECT * FROM reports WHERE site_id = ? AND job_id = ? AND kind = 'weekly' ORDER BY generated_at DESC, id DESC LIMIT 1`, [ctx.siteId, jobId]);
  if (!row) return null;
  return { row, report: JSON.parse(readReportFile(ctx, row, 'json')) as Report };
}

/** Absolute path of the report's Markdown file (plans may live far from the workspace), or null. */
function reportMarkdownPath(ctx: AppContext, row: ReportRow): string | null {
  try {
    return resolveReportFile(ctx, row, 'md');
  } catch {
    return null;
  }
}

function failureOf(s: SettledJob): PlanFailure | null {
  const res = (s.job.result ?? null) as JobResultShape | null;
  const stage = res?.failure?.stage ?? res?.stoppedBy?.stage ?? null;
  if (s.outcome === 'waiting') return { code: 'NEEDS_REVIEW', message: s.reason ?? 'A stage needs a human review.', hint: null, stage };
  if (s.outcome !== 'failed') return null;
  const e = s.error ?? s.job.error ?? { code: 'INTERNAL', message: 'The weekly job failed.' };
  return { code: e.code, message: e.message, hint: e.hint ?? null, stage };
}

/** Build the plan input for a settled weekly job, or null (with a reason) when no plan applies. */
export function weeklyPlanInput(ctx: AppContext, s: SettledJob): { input: WeeklyPlanInput } | { skip: string } {
  let failure = failureOf(s);
  let found: { row: ReportRow; report: Report } | null = null;
  try {
    found = weeklyReportOf(ctx, s.job.id);
  } catch (err) {
    // A report that cannot be read is a blocked plan, never an invented one.
    if (!failure) failure = { code: errorCodeOf(err) || 'REPORT_UNREADABLE', message: `The weekly report of job ${s.job.id} could not be read: ${errorMessage(err)}`, hint: null, stage: 'report' };
  }
  if (!found && !failure) failure = { code: 'REPORT_MISSING', message: `Job ${s.job.id} ${s.outcome} but recorded no weekly report.`, hint: null, stage: 'report' };
  const report = found?.report ?? null;
  const primary = report?.data.primaryAction ?? null;
  if (primary?.kind === 'review_only') return { skip: 'a historical period run (--from/--to) is a review of the past, not this week\'s plan' };
  const res = (s.job.result ?? null) as JobResultShape | null;
  const now = ctx.clock.now();
  return {
    input: {
      siteId: ctx.siteId,
      siteName: ctx.config.site.businessName,
      week: planWeek(ctx, s.job),
      generatedAt: now.toISOString(),
      jobId: s.job.id,
      synthetic: ctx.synthetic || (report?.isSynthetic ?? false),
      report: found && report ? { id: report.id, path: reportMarkdownPath(ctx, found.row), period: report.period, confidence: report.summary.confidence ?? null } : null,
      primary: failure ? null : primary,
      experiments: report?.data.experiments ?? [],
      nextAction: report?.data.nextAction ?? null,
      pendingApprovals: report?.data.pendingApprovals ?? null,
      degradedStages: Array.isArray(res?.degradedStages) ? res.degradedStages.map((d) => ({ stage: d.stage, status: d.status, reason: d.reason })) : [],
      priorTests: priorTests(ctx),
      failure,
    },
  };
}

/** Write the plan file for a settled weekly job (never overwrites). */
export function writeWeeklyPlan(ctx: AppContext, s: SettledJob): FollowUp & { headline?: string } {
  if (!ctx.config.actionPlans.enabled) return { kind: 'action_plan', status: 'skipped', detail: 'actionPlans.enabled is false.' };
  const built = weeklyPlanInput(ctx, s);
  if ('skip' in built) return { kind: 'action_plan', status: 'skipped', detail: `No plan: ${built.skip}.` };
  const rendered = renderWeeklyPlan(built.input);
  const { dir } = resolvePlansDir(ctx);
  preparePlansDir(ctx, dir);
  for (let n = 1; n < 1000; n++) {
    const file = path.join(dir, n === 1 ? `${built.input.week}.md` : `${built.input.week}-${n}.md`);
    try {
      atomicWriteFile(file, rendered.markdown, { noOverwrite: true, mode: 0o600 });
    } catch (err) {
      if (errorCodeOf(err) === 'CONFLICT') continue;
      throw err;
    }
    return { kind: 'action_plan', status: 'written', detail: rendered.headline, path: file, planStatus: rendered.status, headline: rendered.headline };
  }
  throw new AppError('CONFLICT', `Too many plans for ${built.input.week} in ${dir}.`);
}

/** Plain-text notification for one weekly run. Minimal by default (see TELEGRAM_SENDS). */
export function telegramText(ctx: AppContext, week: string, plan: FollowUp & { headline?: string }): string {
  const status = plan.planStatus ? (plan.planStatus === 'n/a' ? 'N/A (nothing to change)' : plan.planStatus.toUpperCase()) : plan.status === 'failed' ? 'NOT WRITTEN' : 'NONE';
  const lines = [`seo-agent: ${ctx.siteId}, week ${week}`, `Plan: ${status}`];
  if (plan.planStatus && ctx.config.notifications.telegram.includeActionTitle && plan.headline) lines.push(plan.headline.replace(/^(ACTION|N\/A|BLOCKED): /, ''));
  if (plan.path) lines.push(`File: ${path.basename(plan.path)}`);
  // Only the error code: the detail can name local folders, which are not part of what Telegram receives.
  else if (plan.status === 'failed') lines.push(`The plan file could not be written (${/^([A-Z_]+):/.exec(plan.detail)?.[1] ?? 'INTERNAL'}). Run: npm run cli -- doctor`);
  else if (plan.status === 'skipped') lines.push(plan.detail);
  if (ctx.synthetic) lines.push('(SYNTHETIC demo data)');
  return redactString(lines.join('\n'));
}

/** Send the weekly notification, when enabled. Never throws. */
export async function notifyWeekly(ctx: AppContext, jobId: string, text: string, deps: PublishDeps = {}): Promise<FollowUp> {
  const cfg = ctx.config.notifications.telegram;
  if (!cfg.enabled) return { kind: 'telegram', status: 'skipped', detail: 'notifications.telegram.enabled is false.' };
  const skip = (detail: string): FollowUp => {
    audit(ctx, jobId, 'notification.skipped', { channel: 'telegram', reason: detail });
    return { kind: 'telegram', status: 'skipped', detail };
  };
  if (ctx.synthetic) return skip('synthetic (demo or test) data is never sent.');
  if (ctx.offline) return skip('offline mode: nothing is sent.');
  const token = ctx.secrets.get('TELEGRAM_BOT_TOKEN');
  if (!token) return skip('TELEGRAM_BOT_TOKEN is not set in the secret store.');
  if (!cfg.chatId) return skip('notifications.telegram.chatId is not set.');
  const r = await sendTelegramMessage(deps.fetch ?? ctx.fetch, token, cfg.chatId, text, deps.telegram);
  if (r.ok) {
    audit(ctx, jobId, 'notification.sent', { channel: 'telegram', messageId: r.value.messageId });
    return { kind: 'telegram', status: 'sent', detail: 'Telegram message sent.' };
  }
  audit(ctx, jobId, 'notification.failed', { channel: 'telegram', code: r.code, httpStatus: r.httpStatus, message: r.message });
  return { kind: 'telegram', status: 'failed', detail: `${r.code}: ${r.message}${r.nextStep ? ` ${r.nextStep}` : ''}` };
}

/** Outcomes that end a weekly run for good (a retry, an interruption, or a lock wait settles later). */
export const SETTLED_OUTCOMES: ReadonlySet<string> = new Set(['succeeded', 'waiting', 'failed']);

/**
 * The follow-ups of a settled weekly job: write the plan, then notify. Skips
 * other job types, unsettled outcomes, and dry runs. Never throws: a failure
 * is recorded as an audit event and returned.
 */
export async function publishWeeklyOutcome(ctx: AppContext, s: SettledJob, deps: PublishDeps = {}): Promise<FollowUp[]> {
  if (s.job.type !== WEEKLY_JOB_TYPE || !SETTLED_OUTCOMES.has(s.outcome) || ctx.dryRun || s.job.dryRun) return [];
  const week = planWeek(ctx, s.job);
  let plan: FollowUp & { headline?: string };
  try {
    plan = writeWeeklyPlan(ctx, s);
    if (plan.status === 'written') audit(ctx, s.job.id, 'action_plan.written', { path: plan.path, planStatus: plan.planStatus, week });
  } catch (err) {
    const detail = `${errorCodeOf(err) || 'INTERNAL'}: ${errorMessage(err)}`;
    plan = { kind: 'action_plan', status: 'failed', detail };
    audit(ctx, s.job.id, 'action_plan.failed', { error: detail, week });
    ctx.logger.warn(`Action plan for job ${s.job.id} was not written: ${detail}`);
  }
  let telegram: FollowUp;
  try {
    telegram = await notifyWeekly(ctx, s.job.id, telegramText(ctx, week, plan), deps);
  } catch (err) {
    telegram = { kind: 'telegram', status: 'failed', detail: `INTERNAL: ${errorMessage(err)}` };
    audit(ctx, s.job.id, 'notification.failed', { channel: 'telegram', code: 'INTERNAL', message: errorMessage(err) });
  }
  const { headline: _h, ...planOut } = plan;
  void _h;
  return [planOut, telegram];
}

/** What the follow-ups of a job did, read back from the audit log (for `npm run weekly` output). */
export function followUpsOf(ctx: Pick<AppContext, 'db' | 'siteId'>, jobId: string): FollowUp[] {
  const rows = ctx.db.all<{ event_type: string; details_json: string | null }>(
    `SELECT event_type, details_json FROM audit_events WHERE site_id = ? AND subject_type = 'job' AND subject_id = ? AND (event_type LIKE 'action_plan.%' OR event_type LIKE 'notification.%') ORDER BY id`,
    [ctx.siteId, jobId],
  );
  return rows.map((r) => {
    const d = (r.details_json ? JSON.parse(r.details_json) : {}) as Record<string, unknown>;
    const [family, status] = r.event_type.split('.') as [string, string];
    if (family === 'action_plan') {
      return { kind: 'action_plan' as const, status, detail: String(status === 'written' ? `plan ${String(d.planStatus)}` : (d.error ?? '')), ...(typeof d.path === 'string' ? { path: d.path } : {}), ...(typeof d.planStatus === 'string' ? { planStatus: d.planStatus as PlanStatus } : {}) };
    }
    return { kind: 'telegram' as const, status, detail: String(status === 'sent' ? 'Telegram message sent.' : status === 'skipped' ? (d.reason ?? '') : `${String(d.code ?? '')}: ${String(d.message ?? '')}`) };
  });
}
