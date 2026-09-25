import { z } from 'zod';
import type { AppContext } from '../../app/context.js';
import { NO_RETRY } from '../../core/retry.js';
import { aiCitationStatus } from '../../aeo/status.js';
import { aiCitationSummary } from '../../aeo/summary.js';
import { measurePublishedContent } from '../../content/publication.js';
import { crawlCompetitorPages } from '../../crawler/competitor.js';
import { defineStage, type EngineStage } from '../stage.js';
import {
  acquireLockStage,
  checkAccessStage,
  indexMemoryStage,
  measurementStage,
  note,
  noteSchema,
  planPeriodStage,
  reconcileCostsStage,
  reportStage,
  resumePendingStage,
  reviewExperimentsStage,
  syncGa4Stage,
  syncGscStage,
  type PipelineEnv,
} from './common.js';

/**
 * MONTHLY (spec section 27): organic and conversion performance, experiments,
 * published-content cohorts, competitor changes, optional AI visibility
 * (observations recorded with `ai-citations import`; there is no API collector), API
 * usage, data quality, and proposed learnings. The monthly report keeps
 * observed results separate from attribution assumptions (a dedicated
 * section), and every missing optional provider degrades only its stage.
 * index_memory ingests the month's new records (and deletions) into the
 * full-text memory index before the report, without any paid call.
 */

export const MONTHLY_WORKFLOW = 'monthly';

export const MONTHLY_STAGE_ORDER = [
  'acquire_lock',
  'check_access',
  'resume_pending',
  'sync_gsc',
  'plan_period',
  'sync_ga4',
  'validate_joins',
  'review_experiments',
  'content_cohorts',
  'competitor_changes',
  'ai_visibility',
  'index_memory',
  'report',
  'reconcile_costs',
] as const;

function contentCohortsStage(): EngineStage {
  return defineStage({
    name: 'content_cohorts',
    version: 'content_cohorts@1',
    description: 'Published-content cohorts: move published items to measuring and collect observational Search Console metrics since the recorded implementation date.',
    input: z.object({}),
    output: z.object({ measured: z.number(), items: z.array(z.object({ contentItemId: z.string(), url: z.string(), verifiedLive: z.boolean(), note: z.string() })), note: noteSchema }),
    prerequisites: ['plan_period'],
    evidence: { requirement: 'Publication records with an actual implementation time (mark-implemented); approval or draft creation never starts measurement.' },
    timeoutMs: 120_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    optional: true,
    stoppingConditions: ['Never stops; no publications means an empty cohort.'],
    next: ['competitor_changes'],
    buildInput: () => ({}),
    run: async (_input, sctx) => {
      const app = sctx.app;
      if (app.dryRun) return { measured: 0, items: [], note: note('skipped', 'Dry run: published-content measurement not recorded.', 'DRY_RUN', null) };
      const rows = measurePublishedContent(app);
      return {
        measured: rows.length,
        items: rows.slice(0, 50).map((r) => ({ contentItemId: r.itemId, url: r.url, verifiedLive: r.verifiedLive, note: r.note })),
        note: null,
      };
    },
  });
}

/** Re-check known competitor pages (GET only, robots respected) so the report can show changes. */
function competitorChangesStage(env: PipelineEnv): EngineStage {
  return defineStage({
    name: 'competitor_changes',
    version: 'competitor_changes@1',
    description: 'Re-check tracked competitor pages (bounded, robots.txt respected, SSRF-safe; login/access barriers recorded, never bypassed) and record content changes.',
    input: z.object({ urls: z.array(z.string()) }),
    output: z.object({ checked: z.number(), changed: z.number(), blocked: z.number(), status: z.string(), pages: z.array(z.object({ url: z.string(), status: z.string(), blockedReason: z.string().nullable(), changes: z.number() })), note: noteSchema }),
    prerequisites: ['plan_period'],
    evidence: {
      requirement: 'Competitor pages discovered by earlier research or configured competitors.',
      check: (input) => (input.urls.length ? [] : ['no tracked competitor pages yet (run weekly research first)']),
    },
    timeoutMs: 20 * 60_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    requiredMode: 'RESEARCH',
    optional: true,
    providers: ['crawler'],
    stoppingConditions: ['Runtime mode below RESEARCH: skipped. Blocked pages are recorded honestly.'],
    next: ['ai_visibility'],
    buildInput: (sctx) => ({
      urls: sctx.app.db
        .all<{ url: string }>('SELECT url FROM competitor_pages WHERE site_id = ? ORDER BY COALESCE(last_checked_at, first_seen_at) ASC, url LIMIT ?', [sctx.app.siteId, Math.max(1, sctx.app.config.crawl.competitorPagesPerQueryMax * 2)])
        .map((r) => r.url),
    }),
    run: async (input, sctx) => {
      const app = sctx.app;
      const svc = env.services(app);
      const r = await crawlCompetitorPages(app, input.urls.map((url) => ({ url })), { ...svc.competitorCrawler, jobId: sctx.jobId, signal: sctx.signal, origin: 'manual' });
      const blocked = r.pages.filter((p) => p.status === 'blocked');
      const changed = r.pages.filter((p) => p.changes.length > 0);
      return {
        checked: r.pages.length,
        changed: changed.length,
        blocked: blocked.length,
        status: r.status,
        pages: r.pages.slice(0, 30).map((p) => ({ url: p.url, status: p.status, blockedReason: p.blockedReason, changes: p.changes.length })),
        note: blocked.length || r.status !== 'completed' ? note('degraded', `Competitor re-check ${r.status}; ${blocked.length} page(s) blocked (${[...new Set(blocked.map((b) => b.blockedReason ?? 'blocked'))].join(', ') || 'none'}), never bypassed.`, blocked.length ? 'COMPETITOR_BLOCKED' : `CRAWL_${r.status.toUpperCase()}`, null) : null,
      };
    },
  });
}

function aiVisibilityStage(): EngineStage {
  return defineStage({
    name: 'ai_visibility',
    version: 'ai_visibility@2',
    description: 'Optional AI-visibility review: only stored, grounded AI-answer observations (recorded with `ai-citations import`: query, engine, date, location, cited URLs) are reported; nothing is estimated or inferred from ungrounded model answers.',
    input: z.object({}),
    // checksInPeriod: observations recorded in the reviewed period; null when not measured (monitoring disabled or the period unknown), never 0.
    output: z.object({ enabled: z.boolean(), checksInPeriod: z.number().nullable(), groundedInPeriod: z.number().optional(), note: noteSchema }),
    prerequisites: ['plan_period'],
    evidence: { requirement: 'features.aiCitations and observations recorded by the explicit manual import (`ai-citations import`); no API collector exists and nothing is spent.' },
    timeoutMs: 30_000,
    retry: NO_RETRY,
    costAllowance: 'none',
    optional: true,
    stoppingConditions: ['Disabled by default: reported as not measured (DATA_UNAVAILABLE, never zero).'],
    next: ['index_memory'],
    buildInput: () => ({}),
    run: async (_input, sctx) => {
      const app = sctx.app;
      const status = aiCitationStatus(app);
      // What exists: the explicit manual import. What does not: an API collector (none is invented).
      const how = `${status.nextStep} ${status.spending.detail}`;
      if (!status.enabled) return { enabled: false, checksInPeriod: null, note: note('skipped', status.detail, 'INTEGRATION_DISABLED', how) };
      const plan = sctx.prior.plan_period as { period?: { start: string; end: string; timeZone?: string } } | undefined;
      if (!plan?.period) return { enabled: true, checksInPeriod: null, note: note('skipped', 'The report period is unknown, so AI-citation observations were not counted (DATA_UNAVAILABLE, not zero).', 'NO_DATA', how) };
      const s = aiCitationSummary(app, { start: plan.period.start, end: plan.period.end, ...(plan.period.timeZone ? { timeZone: plan.period.timeZone } : {}) });
      const { total, grounded } = s.checks;
      return {
        enabled: true,
        checksInPeriod: total,
        groundedInPeriod: grounded,
        note: !total
          ? note('skipped', 'No AI-citation observations were recorded in this period (DATA_UNAVAILABLE, not zero).', 'NO_DATA', how)
          : !grounded
            ? note('skipped', `${total} AI-citation observation(s) were recorded in this period, but none is grounded; ungrounded model responses are never live search measurements and are excluded.`, 'NO_GROUNDED_DATA', how)
            : null,
      };
    },
  });
}

export function createMonthlyStages(env: PipelineEnv, _app: AppContext): EngineStage[] {
  return [
    acquireLockStage('check_access'),
    checkAccessStage(env, 'resume_pending', ['acquire_lock']),
    resumePendingStage(env, 'sync_gsc', ['check_access']),
    syncGscStage(env, { next: 'plan_period', prerequisites: ['check_access'], days: () => null, reportSegments: 'monthly' }),
    planPeriodStage('monthly', 'sync_ga4', ['check_access'], ['sync_gsc']),
    syncGa4Stage(env, { next: 'validate_joins', prerequisites: ['plan_period'], days: () => null }),
    measurementStage('validate_joins', 'review_experiments', ['plan_period'], ['sync_gsc', 'sync_ga4']),
    reviewExperimentsStage(env, 'content_cohorts', ['validate_joins']),
    contentCohortsStage(),
    competitorChangesStage(env),
    aiVisibilityStage(),
    indexMemoryStage(env, 'report', ['check_access'], { optional: true }),
    reportStage(env, { kind: 'monthly', earlierStages: MONTHLY_STAGE_ORDER.filter((s) => s !== 'report' && s !== 'reconcile_costs'), prerequisites: ['check_access', 'plan_period', 'review_experiments'], next: 'reconcile_costs' }),
    reconcileCostsStage(env, ['report']),
  ];
}
