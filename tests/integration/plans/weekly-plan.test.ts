import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { registerJobSettledListener } from '../../../src/jobs/settled.js';
import type { JobRecord } from '../../../src/jobs/types.js';
import { PLANS_GITIGNORE } from '../../../src/plans/folder.js';
import { followUpsOf, publishWeeklyOutcome, telegramText } from '../../../src/plans/publish.js';
import type { Report } from '../../../src/reports/model.js';
import { readReportFile, type ReportRow } from '../../../src/reports/storage.js';
import { runPipeline } from '../../../src/workflows/pipelines/handlers.js';
import type { TestContext } from '../../helpers/context.js';
import { fakeFetch, jsonResponse, match, type RecordedRequest } from '../../helpers/fake-fetch.js';
import { pipelineConfig, pipelineContext, testEnv } from '../pipelines/helpers.js';

// Weekly action plans and Telegram notifications after a weekly job settles
// (src/plans/publish.ts via the settled-job listener). Synthetic fixtures, offline;
// Telegram is a fake fetch. The token is SYNTHETIC.

const PIPELINE_TEST_TIMEOUT_MS = 60_000;
const TOKEN = '123456789:SYNTHETIC_fake_token_for_tests_only_000';
const WEEK = '2026-W39'; // NOW = 2026-09-24 in Europe/Tallinn

let ctx: TestContext | undefined;
afterEach(() => {
  registerJobSettledListener(null);
  ctx?.cleanup();
  ctx = undefined;
});

function telegramFake(status = 200) {
  return fakeFetch([
    match('POST', `https://api.telegram.org/bot${TOKEN}/sendMessage`, () =>
      status === 200 ? jsonResponse({ ok: true, result: { message_id: 7 } }) : jsonResponse({ ok: false, error_code: status, description: 'Unauthorized' }, status),
    ),
  ]);
}

function listen(fetch?: ReturnType<typeof fakeFetch>): void {
  registerJobSettledListener((c, r) => publishWeeklyOutcome(c, r, fetch ? { fetch } : {}));
}

function planFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : [];
}

function frontMatter(file: string): Record<string, unknown> {
  return parse(/^---\n([\s\S]*?)\n---/.exec(readFileSync(file, 'utf8'))![1]!) as Record<string, unknown>;
}

function reportOf(c: TestContext, jobId: string): Report {
  const row = c.db.get<ReportRow>(`SELECT * FROM reports WHERE site_id = ? AND job_id = ? AND kind = 'weekly'`, [c.siteId, jobId])!;
  return JSON.parse(readReportFile(c, row, 'json')) as Report;
}

function job(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job_synthetic_failed',
    siteId: 'demo-site',
    type: 'weekly',
    status: 'failed',
    mode: 'ANALYZE',
    params: {},
    dryRun: false,
    attempt: 1,
    maxAttempts: 2,
    nextAttemptAt: null,
    cancelRequested: false,
    parentJobId: null,
    traceId: null,
    error: { code: 'CREDENTIALS_MISSING', message: 'Google access is not configured (synthetic).', hint: 'Run `npm run cli -- auth google`.' },
    result: { failure: { stage: 'check_access', code: 'CREDENTIALS_MISSING', message: 'x' } },
    createdAt: '2026-09-24T08:00:00.000Z',
    startedAt: '2026-09-24T08:00:00.000Z',
    finishedAt: '2026-09-24T08:01:00.000Z',
    heartbeatAt: null,
    lockOwner: null,
    ...over,
  };
}

describe('weekly action plan after a weekly run', () => {
  it(
    'writes one git-ignored plan per run in the default folder, matching the report decision; a second run the same week gets -2',
    async () => {
      ctx = pipelineContext();
      listen();
      const r = await runPipeline(ctx, 'weekly', {}, { env: testEnv() });
      expect(r.outcome).toBe('succeeded');
      const dir = path.join(ctx.paths.root, 'plans', ctx.siteId);
      expect(readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(PLANS_GITIGNORE);
      expect(planFiles(dir)).toEqual([`${WEEK}.md`]);

      const fm = frontMatter(path.join(dir, `${WEEK}.md`));
      const primary = reportOf(ctx, r.jobId).data.primaryAction!;
      expect(fm).toMatchObject({ site: ctx.siteId, week: WEEK, job: r.jobId, synthetic: true, recommendation: primary.recommendationId });
      expect(fm.status).toBe(primary.kind === 'primary' || primary.kind === 'repair_measurement' ? 'action' : 'n/a');
      expect(readFileSync(path.join(dir, `${WEEK}.md`), 'utf8')).toContain('SYNTHETIC');

      // The run summary (npm run weekly, --json) reports the follow-up; Telegram is disabled by default and stays silent.
      expect(r.followUps).toEqual([expect.objectContaining({ kind: 'action_plan', status: 'written', path: path.join(dir, `${WEEK}.md`), planStatus: fm.status })]);

      const again = await runPipeline(ctx, 'weekly', {}, { env: testEnv() });
      expect(again.outcome).toBe('succeeded');
      expect(planFiles(dir)).toEqual([`${WEEK}-2.md`, `${WEEK}.md`]);
      expect(frontMatter(path.join(dir, `${WEEK}-2.md`)).job).toBe(again.jobId);
    },
    PIPELINE_TEST_TIMEOUT_MS,
  );

  it(
    'a dry run writes no plan',
    async () => {
      ctx = pipelineContext({ dryRun: true });
      listen();
      const r = await runPipeline(ctx, 'weekly', {}, { env: testEnv() });
      expect(r.dryRun).toBe(true);
      expect(existsSync(path.join(ctx.paths.root, 'plans'))).toBe(false);
    },
    PIPELINE_TEST_TIMEOUT_MS,
  );

  it(
    'a folder that is not dedicated is refused: nothing is written there, the notification says so, and the job still succeeds',
    async () => {
      ctx = pipelineContext();
      const dir = path.join(ctx.paths.root, 'site-repo', 'docs');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'README.md'), 'site docs (synthetic)');
      ctx.config.actionPlans.dir = dir;
      listen();
      const r = await runPipeline(ctx, 'weekly', {}, { env: testEnv() });
      expect(r.outcome).toBe('succeeded');
      expect(readdirSync(dir)).toEqual(['README.md']);
      expect(r.followUps).toEqual([expect.objectContaining({ kind: 'action_plan', status: 'failed', detail: expect.stringMatching(/not created by seo-agent/) })]);
      // The notification names only the error code, never the local folder.
      expect(telegramText(ctx, WEEK, r.followUps![0]!)).toBe(`seo-agent: ${ctx.siteId}, week ${WEEK}\nPlan: NOT WRITTEN\nThe plan file could not be written (VALIDATION_FAILED). Run: npm run cli -- doctor\n(SYNTHETIC demo data)`);
    },
    PIPELINE_TEST_TIMEOUT_MS,
  );

  it(
    'a listener that throws never changes the job outcome',
    async () => {
      ctx = pipelineContext();
      registerJobSettledListener(async () => {
        throw new Error('synthetic follow-up failure');
      });
      const r = await runPipeline(ctx, 'weekly', {}, { env: testEnv() });
      expect(r.outcome).toBe('succeeded');
      expect(r.jobStatus).toBe('succeeded');
    },
    PIPELINE_TEST_TIMEOUT_MS,
  );
});

describe('Telegram notification after a weekly run', () => {
  it(
    'demo data is never sent, even when Telegram is enabled',
    async () => {
      ctx = pipelineContext({ config: pipelineConfig({ notifications: { telegram: { enabled: true, chatId: '123456789' } } }), secrets: { TELEGRAM_BOT_TOKEN: TOKEN } });
      const tg = telegramFake();
      listen(tg);
      const r = await runPipeline(ctx, 'weekly', {}, { env: testEnv() });
      expect(r.outcome).toBe('succeeded');
      expect(tg.calls).toHaveLength(0);
      expect(r.followUps).toContainEqual(expect.objectContaining({ kind: 'telegram', status: 'skipped', detail: expect.stringMatching(/synthetic/) }));
    },
    PIPELINE_TEST_TIMEOUT_MS,
  );

  it(
    'a live site sends one minimal message: site, week, plan status, file name, and no page URL or query by default',
    async () => {
      ctx = pipelineContext({
        config: pipelineConfig({ profile: 'core', notifications: { telegram: { enabled: true, chatId: '-1001234567890' } } }),
        secrets: { TELEGRAM_BOT_TOKEN: TOKEN },
        online: true,
      });
      expect(ctx.synthetic).toBe(false);
      const tg = telegramFake();
      listen(tg);
      const r = await runPipeline(ctx, 'weekly', {}, { env: testEnv() });
      expect(r.followUps?.map((f) => `${f.kind}:${f.status}`)).toEqual(['action_plan:written', 'telegram:sent']);
      expect(tg.calls).toHaveLength(1);
      const body = JSON.parse(tg.calls[0]!.body!) as { chat_id: number; text: string };
      expect(body.chat_id).toBe(-1001234567890);
      const plan = r.followUps!.find((f) => f.kind === 'action_plan')!;
      expect(body.text).toContain(`seo-agent: ${ctx.siteId}, week ${WEEK}`);
      expect(body.text).toContain(`File: ${WEEK}.md`);
      expect(body.text).toMatch(/^Plan: (ACTION|N\/A \(nothing to change\)|BLOCKED)$/m);
      expect(body.text).not.toMatch(/https?:\/\//);
      const primary = reportOf(ctx, r.jobId).data.primaryAction;
      if (primary?.query) expect(body.text).not.toContain(primary.query);
      expect(plan.status).toBe('written');
    },
    PIPELINE_TEST_TIMEOUT_MS,
  );

  it('a failed run writes a blocked plan; a rejected token is recorded, never thrown', async () => {
    ctx = pipelineContext({ config: pipelineConfig({ profile: 'core', notifications: { telegram: { enabled: true, chatId: '123456789' } } }), secrets: { TELEGRAM_BOT_TOKEN: TOKEN }, online: true });
    const tg = telegramFake(401);
    const settled = { outcome: 'failed', job: job({ siteId: ctx.siteId }), error: job().error! };
    const out = await publishWeeklyOutcome(ctx, settled, { fetch: tg });
    expect(out.map((f) => `${f.kind}:${f.status}`)).toEqual(['action_plan:written', 'telegram:failed']);
    const plan = out[0]!;
    expect(plan.planStatus).toBe('blocked');
    const text = readFileSync(plan.path!, 'utf8');
    expect(text).toContain('`CREDENTIALS_MISSING`');
    expect(text).toContain('`check_access`');
    expect(JSON.parse(tg.calls[0]!.body!).text).toContain('Plan: BLOCKED');
    expect(out[1]!.detail).toMatch(/TELEGRAM_UNAUTHORIZED/);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    // Both follow-ups are in the audit log of the job.
    expect(followUpsOf(ctx, settled.job.id).map((f) => `${f.kind}:${f.status}`)).toEqual(['action_plan:written', 'telegram:failed']);
  });

  it('other job types, unsettled outcomes, and dry-run jobs get no follow-up', async () => {
    ctx = pipelineContext();
    const tg = telegramFake();
    expect(await publishWeeklyOutcome(ctx, { outcome: 'succeeded', job: job({ type: 'monthly', status: 'succeeded' }) }, { fetch: tg })).toEqual([]);
    expect(await publishWeeklyOutcome(ctx, { outcome: 'retry_scheduled', job: job({ status: 'queued' }) }, { fetch: tg })).toEqual([]);
    expect(await publishWeeklyOutcome(ctx, { outcome: 'interrupted', job: job({ status: 'interrupted' }) }, { fetch: tg })).toEqual([]);
    expect(await publishWeeklyOutcome(ctx, { outcome: 'failed', job: job({ dryRun: true }) }, { fetch: tg })).toEqual([]);
    expect(tg.calls as RecordedRequest[]).toHaveLength(0);
    expect(existsSync(path.join(ctx.paths.root, 'plans'))).toBe(false);
  });
});
