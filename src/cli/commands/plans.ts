import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { parse } from 'yaml';
import { AppError } from '../../core/errors.js';
import { recordAudit } from '../../database/audit.js';
import { getJob } from '../../jobs/store.js';
import type { JobRecord } from '../../jobs/types.js';
import { inspectPlansDir, resolvePlansDir } from '../../plans/folder.js';
import { notifyWeekly, planWeek, telegramText, weeklyPlanInput, writeWeeklyPlan, WEEKLY_JOB_TYPE, type SettledJob } from '../../plans/publish.js';
import { renderWeeklyPlan } from '../../plans/render.js';
import type { CliRuntime } from '../runtime.js';

/**
 * `plans list | write`
 *
 * Weekly action plans (src/plans): one Markdown file per weekly run in the
 * plans folder (`actionPlans.dir`, default <workspace>/plans/<site-id>),
 * whose contents are git-ignored. Weekly runs write them automatically;
 * `plans write` writes one again for a finished weekly job, for example after
 * fixing the plans folder.
 */

interface PlanFileInfo {
  file: string;
  path: string;
  week: string | null;
  status: string | null;
  generatedAt: string | null;
  job: string | null;
}

function readFrontMatter(file: string): Record<string, unknown> | null {
  const text = readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return null;
  try {
    const v = parse(m[1]!) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function listPlanFiles(dir: string): PlanFileInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-W\d{2}(-\d+)?\.md$/.test(f))
    .sort((a, b) => {
      const [wa, na] = [a.slice(0, 8), Number(/-(\d+)\.md$/.exec(a.slice(8))?.[1] ?? 1)];
      const [wb, nb] = [b.slice(0, 8), Number(/-(\d+)\.md$/.exec(b.slice(8))?.[1] ?? 1)];
      return wa === wb ? nb - na : wb.localeCompare(wa);
    })
    .map((f) => {
      const p = path.join(dir, f);
      const fm = readFrontMatter(p);
      const str = (k: string) => (typeof fm?.[k] === 'string' ? (fm[k] as string) : null);
      return { file: f, path: p, week: str('week'), status: str('status'), generatedAt: str('generated_at'), job: str('job') };
    });
}

/** A finished weekly job as the follow-ups see it. */
export function settledJobOf(job: JobRecord): SettledJob {
  if (job.type !== WEEKLY_JOB_TYPE) throw new AppError('VALIDATION_FAILED', `Job ${job.id} is a ${job.type} job; action plans are written for weekly jobs only.`);
  if (job.status !== 'succeeded' && job.status !== 'failed' && job.status !== 'waiting') {
    throw new AppError('VALIDATION_FAILED', `Job ${job.id} is ${job.status}; a plan is written once a weekly job has succeeded, failed, or stopped for a review.`, { hint: 'Check it with `npm run cli -- jobs show <id>`.' });
  }
  if (job.dryRun) throw new AppError('VALIDATION_FAILED', `Job ${job.id} was a dry run; it has no plan.`);
  const waiting = (job.result as { waitingReason?: unknown } | null)?.waitingReason;
  return {
    outcome: job.status,
    job,
    ...(job.error ? { error: { code: job.error.code, message: job.error.message, ...(job.error.hint ? { hint: job.error.hint } : {}) } } : {}),
    ...(typeof waiting === 'string' ? { reason: waiting } : {}),
  };
}

export function register(program: Command, cli: CliRuntime): void {
  const plans = program.command('plans').description('Weekly action plans: one Markdown file per weekly run (what to change, n/a, or blocked), git-ignored');

  plans
    .command('list')
    .description('List the plan files of the site, newest first, and where the plans folder is')
    .action(
      cli.action(async (_opts: Record<string, never>, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        const { dir, source } = resolvePlansDir(ctx);
        const folder = inspectPlansDir(dir);
        const result = { dir, source, enabled: ctx.config.actionPlans.enabled, folder: folder.state, ...(folder.state === 'refused' ? { problem: folder.reason } : {}), plans: folder.state === 'managed' ? listPlanFiles(dir) : [] };
        cli.print(g, result, (r: typeof result) => {
          const lines = [`Plans folder (${r.source === 'config' ? 'actionPlans.dir' : 'default'}): ${r.dir}`];
          if (!r.enabled) lines.push('actionPlans.enabled is false: weekly runs write no plan.');
          if (r.folder === 'missing' || r.folder === 'empty') lines.push('No plan yet. The next weekly run creates the folder and its .gitignore.');
          if (r.folder === 'refused') lines.push(`The folder cannot be used: ${(r as { problem?: string }).problem}. Point actionPlans.dir at a new or empty folder.`);
          for (const p of r.plans) lines.push(`  ${p.file.padEnd(14)} ${(p.status ?? '?').padEnd(8)} ${p.generatedAt ?? ''}${p.job ? `  job ${p.job}` : ''}`);
          return lines.join('\n');
        });
      }),
    );

  plans
    .command('write')
    .description('Write the action plan of a finished weekly job again (default: the latest weekly job). Never overwrites: a second plan in the same week gets a -2 suffix. With --notify, also sends the Telegram notification.')
    .option('--job <id>', 'weekly job to write the plan for')
    .option('--notify', 'also send the Telegram notification (notifications.telegram)')
    .action(
      cli.action(async (opts: { job?: string; notify?: boolean }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        let job: JobRecord | undefined;
        if (opts.job) {
          job = getJob(ctx.db, ctx.siteId, opts.job);
          if (!job) throw new AppError('NOT_FOUND', `No job ${opts.job} for site ${ctx.siteId}.`, { hint: 'List jobs with `npm run cli -- jobs list`.' });
        } else {
          const row = ctx.db.get<{ id: string }>(
            `SELECT id FROM jobs WHERE site_id = ? AND type = ? AND status IN ('succeeded', 'failed', 'waiting') AND dry_run = 0 ORDER BY COALESCE(finished_at, created_at) DESC, id DESC LIMIT 1`,
            [ctx.siteId, WEEKLY_JOB_TYPE],
          );
          job = row ? getJob(ctx.db, ctx.siteId, row.id) : undefined;
          if (!job) throw new AppError('NOT_FOUND', `Site ${ctx.siteId} has no finished weekly job yet.`, { hint: 'Run `npm run weekly` first.' });
        }
        const settled = settledJobOf(job);
        if (g.dryRun) {
          const built = weeklyPlanInput(ctx, settled);
          if ('skip' in built) throw new AppError('VALIDATION_FAILED', `No plan for job ${job.id}: ${built.skip}.`);
          const rendered = renderWeeklyPlan(built.input);
          const result = { dryRun: true, written: false, jobId: job.id, dir: resolvePlansDir(ctx).dir, status: rendered.status, headline: rendered.headline, markdown: rendered.markdown };
          cli.print(g, result, (r: typeof result) => `${r.markdown}\n\nDry run: nothing was written (plans folder: ${r.dir}).`);
          return;
        }
        const plan = writeWeeklyPlan(ctx, settled);
        const week = planWeek(ctx, job);
        if (plan.status === 'written') {
          recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'cli', eventType: 'action_plan.written', subjectType: 'job', subjectId: job.id, details: { path: plan.path, planStatus: plan.planStatus, week, manual: true }, at: ctx.clock.now() });
        }
        const telegram = opts.notify ? await notifyWeekly(ctx, job.id, telegramText(ctx, week, plan)) : null;
        const { headline: _h, ...planOut } = plan;
        void _h;
        const result = { jobId: job.id, week, plan: planOut, telegram };
        cli.print(g, result, (r: typeof result) =>
          [
            r.plan.status === 'written' ? `Action plan written (${r.plan.planStatus}): ${r.plan.path}` : `No plan written: ${r.plan.detail}`,
            ...(r.plan.status === 'written' ? [`  ${r.plan.detail}`] : []),
            ...(r.telegram ? [`Telegram ${r.telegram.status}${r.telegram.status === 'sent' ? '' : `: ${r.telegram.detail}`}`] : []),
          ].join('\n'),
        );
      }),
    );
}
