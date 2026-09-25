/**
 * SYNTHETIC end-to-end experiment scenario for tests (example.test domains,
 * fabricated metrics, is_synthetic = 1). Timeline:
 *   2026-04-01 .. 2026-09-21  final GSC + complete GA4 data
 *   2026-06-27T10:00Z         experiment proposed (bound to source revision site@synthetic-1)
 *   2026-06-28T09:00Z         approved by a human
 *   2026-06-30T08:00Z         exported in EXECUTE mode (target recheck: unchanged)
 *   2026-07-01T12:00Z         actually implemented (recorded on 2026-07-02)
 *   2026-09-24T09:00Z         evaluation
 */
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { ApprovalService } from '../../../src/approvals/service.js';
import { applyDecisionEffects } from '../../../src/approvals/effects.js';
import { exportSubject, type ExportOutcome } from '../../../src/approvals/export.js';
import { markImplemented } from '../../../src/approvals/implementation.js';
import type { PageFetcher } from '../../../src/approvals/page-fetch.js';
import type { TargetChecker } from '../../../src/approvals/target-check.js';
import { proposeFromRecommendation, type ProposeInput } from '../../../src/experiments/propose.js';
import { experimentsSiteConfig, seedGa4Landing, seedGscPage, seedGscProperty, seedPage, seedRecommendation, type RecommendationSeed } from './seed.js';

export const T = {
  dataStart: '2026-04-01',
  dataEnd: '2026-09-21',
  proposeAt: '2026-06-27T10:00:00.000Z',
  approveAt: '2026-06-28T09:00:00.000Z',
  exportAt: '2026-06-30T08:00:00.000Z',
  implementedAt: '2026-07-01T12:00:00.000Z',
  recordAt: '2026-07-02T08:00:00.000Z',
  evaluateAt: '2026-09-24T09:00:00.000Z',
  changeDateGsc: '2026-07-01',
};

/** Synthetic source revision every scenario approval is bound to. */
export const REVISION = 'site@synthetic-1';

/** Target checker that always sees the same (synthetic) page state: the recheck is "unchanged". */
export const stableChecker: TargetChecker = {
  async fingerprint() {
    return { ok: true, fingerprint: 'synthetic-fingerprint-0001', checkedAt: '2026-06-01T00:00:00.000Z', detail: 'synthetic stable page' };
  },
};

/** Export a subject the way a human would: EXECUTE mode for this one command, stable target, bound revision. */
export async function exportInExecuteMode(
  ctx: TestContext,
  gate: ApprovalService,
  subjectType: string,
  subjectId: string,
  opts: { criticalFixReason?: string; sourceRevision?: string | null } = {},
): Promise<ExportOutcome> {
  const prev = ctx.mode;
  ctx.mode = 'EXECUTE';
  try {
    return await exportSubject(
      ctx,
      gate,
      { subjectType, subjectId, actor: 'owner:Alice', sourceRevision: opts.sourceRevision === undefined ? REVISION : opts.sourceRevision, ...(opts.criticalFixReason ? { criticalFixReason: opts.criticalFixReason } : {}) },
      { targetChecker: stableChecker },
    );
  } finally {
    ctx.mode = prev;
  }
}

export interface ScenarioOptions {
  config?: Parameters<typeof experimentsSiteConfig>[0];
  treated?: { before: { clicks: number; impressions: number }; after: { clicks: number; impressions: number } };
  control?: { clicks: number; impressions: number } | null;
  ga4?: { sessionsBefore: number; sessionsAfter: number; rateBefore: number | null; rateAfter: number | null } | null;
  recommendation?: Partial<RecommendationSeed>;
  propose?: Partial<ProposeInput>;
}

export interface Scenario {
  ctx: TestContext;
  gate: ApprovalService;
  page: { id: string; url: string };
  comparison: Array<{ id: string; url: string }>;
  recommendationId: string;
  experimentId: string;
  approvalId: string;
}

export function seedScenarioData(ctx: TestContext, o: ScenarioOptions = {}): { page: { id: string; url: string }; comparison: Array<{ id: string; url: string }> } {
  const page = seedPage(ctx.db, ctx.siteId, { path: '/widgets', pageType: 'article' });
  const treated = o.treated ?? { before: { clicks: 20, impressions: 1000 }, after: { clicks: 30, impressions: 1000 } };
  seedGscProperty(ctx.db, ctx.siteId, T.dataStart, T.dataEnd);
  seedGscPage(ctx.db, ctx.siteId, {
    pageUrl: page.url,
    pageId: page.id,
    start: T.dataStart,
    end: T.dataEnd,
    clicks: (d) => (d > T.changeDateGsc ? treated.after.clicks : treated.before.clicks),
    impressions: (d) => (d > T.changeDateGsc ? treated.after.impressions : treated.before.impressions),
  });
  const comparison: Array<{ id: string; url: string }> = [];
  if (o.control !== null) {
    const c = o.control ?? { clicks: 50, impressions: 2000 };
    for (const path of ['/guides/a', '/guides/b', '/guides/c']) {
      const p = seedPage(ctx.db, ctx.siteId, { path, pageType: 'article' });
      comparison.push(p);
      seedGscPage(ctx.db, ctx.siteId, { pageUrl: p.url, pageId: p.id, start: T.dataStart, end: T.dataEnd, clicks: () => c.clicks, impressions: () => c.impressions });
    }
  }
  if (o.ga4 !== null) {
    const g = o.ga4 ?? { sessionsBefore: 25, sessionsAfter: 25, rateBefore: 0.04, rateAfter: 0.04 };
    seedGa4Landing(ctx.db, ctx.siteId, {
      landingPage: '/widgets',
      pageId: page.id,
      start: T.dataStart,
      end: T.dataEnd,
      sessions: (d) => (d > T.changeDateGsc ? g.sessionsAfter : g.sessionsBefore),
      rate: (d) => (d > T.changeDateGsc ? g.rateAfter : g.rateBefore),
    });
    for (const p of comparison) {
      seedGa4Landing(ctx.db, ctx.siteId, { landingPage: new URL(p.url).pathname, pageId: p.id, start: T.dataStart, end: T.dataEnd, sessions: () => 40, rate: () => 0.03 });
    }
  }
  return { page, comparison };
}

/** Propose + approve (+ optionally record implementation) an experiment. */
export async function buildScenario(o: ScenarioOptions & { implement?: boolean; fetcher?: PageFetcher } = {}): Promise<Scenario> {
  const ctx = createTestContext({ config: experimentsSiteConfig(o.config), now: T.proposeAt });
  const gate = new ApprovalService(ctx.db, { clock: ctx.clock });
  const { page, comparison } = seedScenarioData(ctx, o);
  const recommendationId = seedRecommendation(ctx.db, ctx.siteId, { pageId: page.id, ...o.recommendation });
  const r = await proposeFromRecommendation(ctx, gate, { recommendationId, requestedBy: 'owner:Alice', sourceRevision: REVISION, ...o.propose }, { targetChecker: stableChecker });
  ctx.clock.set(T.approveAt);
  const approved = gate.approve(ctx.siteId, r.approval.id, { approver: 'Alice', confirmHashPrefix: r.approval.artifactHash.slice(0, 12) });
  applyDecisionEffects(ctx.db, ctx.clock, approved, 'owner:Alice');
  if (o.implement !== false) {
    ctx.clock.set(T.exportAt);
    await exportInExecuteMode(ctx, gate, 'experiment', r.experiment.id);
    ctx.clock.set(T.recordAt);
    await markImplemented(
      ctx,
      gate,
      { subjectType: 'experiment', subjectId: r.experiment.id, implementedAt: T.implementedAt, revision: 'deploy-42', recordedBy: 'Alice' },
      o.fetcher ? { fetcher: o.fetcher } : {},
    );
    ctx.clock.set(T.evaluateAt);
  }
  return { ctx, gate, page, comparison, recommendationId, experimentId: r.experiment.id, approvalId: r.approval.id };
}
