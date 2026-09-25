import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { buildDashboard, DASHBOARD_REL_PATH } from '../../../src/reports/dashboard.js';
import { buildWeeklyReport } from '../../../src/reports/build.js';
import { latestCompleteDate, resolvePeriod } from '../../../src/reports/period.js';
import { wikiLinkResolver } from '../../../src/reports/links.js';
import { allClaims, SYNTHETIC_WATERMARK } from '../../../src/reports/model.js';
import type { LlmClient, TextRequest } from '../../../src/integrations/llm/types.js';
import type { IntegrationStatus } from '../../../src/integrations/types.js';
import {
  GSC_PROPERTY,
  eachDate,
  insertRow,
  reportsTestConfig,
  seedApproval,
  seedContent,
  seedExperiment,
  seedGa4Landing,
  seedRecommendation,
  seedWeeklyScenario,
  sid,
} from '../../fixtures/reports/seed.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const statuses: IntegrationStatus[] = [
  { id: 'google_gsc', state: 'ready', detail: 'synthetic ok', sendsExternally: [], checkedAt: '2026-09-24T08:00:00.000Z', networkChecked: false, chargeable: false },
  { id: 'apify', state: 'disabled', detail: 'feature flag off', sendsExternally: [], checkedAt: '2026-09-24T08:00:00.000Z', networkChecked: false, chargeable: false },
];

describe('dashboard', () => {
  it('builds a static Dashboard.md note with every required section', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const s = seedWeeklyScenario(ctx.db, ctx.siteId);
    seedRecommendation(ctx.db, ctx.siteId, { pageId: s.pricingPageId });
    seedExperiment(ctx.db, ctx.siteId, { pageId: s.guidePageId, status: 'observing', implementedAt: '2026-09-10T10:00:00.000Z' });
    seedContent(ctx.db, ctx.siteId);
    seedApproval(ctx.db, ctx.siteId);
    await buildWeeklyReport(ctx, { statuses });
    const note = buildDashboard(ctx, { statuses });
    expect(note.relPath).toBe(DASHBOARD_REL_PATH);
    expect(note.relPath).toBe('00 Dashboard/Dashboard.md');
    expect(note.kind).toBe('dashboard');
    expect(note.frontmatter).toMatchObject({ type: 'dashboard', site: ctx.siteId, is_synthetic: false });
    for (const h of ['## Current performance', '## Data freshness', '## Best opportunity', '## Active experiments', '## Pending approvals', '## Content queue', '## Integration status', '## Spend', '## Latest reports', '## Optional: Dataview']) {
      expect(note.body).toContain(h);
    }
    // 28 complete days ending 2026-09-20: only 14 days of GSC data exist, so totals are partial.
    expect(note.body).toContain('2026-08-24 to 2026-09-20');
    expect(note.body).toContain('| GA4 all organic sessions (separate view) |');
    expect(note.body).toContain('Rewrite the pricing page title');
    expect(note.body).toContain('Change pricing title (synthetic)');
    expect(note.body).toContain('Guide to pricing tiers (synthetic)');
    expect(note.body).toContain('| apify | disabled | feature flag off |');
    expect(note.body).toContain('| llm_gateway | $0.00 |');
    expect(note.body).toMatch(/weekly 2026-09-14 to 2026-09-20/);
    expect(note.body).toContain('```dataview');
    expect(note.body).toContain('Everything above works without it.');
  });

  it('works without data or statuses and says so honestly', () => {
    ctx = createTestContext();
    const note = buildDashboard(ctx, { statuses: null });
    expect(note.body).toContain('DATA UNAVAILABLE');
    expect(note.body).toContain('Live integration status was not collected during this render');
    expect(note.body).toContain('No reports generated yet.');
    expect(note.body).toContain('Wait: no evidence-backed opportunity or recommendation is recorded yet.');
  });

  it('watermarks the dashboard when synthetic rows are present and supports wikilinks', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    seedGa4Landing(ctx.db, ctx.siteId, { dates: eachDate('2026-09-14', '2026-09-20'), rows: [{ channel: 'google_organic', landingPage: '/demo', sessions: 1 }], synthetic: 1 });
    await buildWeeklyReport(ctx, { statuses: null });
    const wiki = wikiLinkResolver({ link: (p, a) => `[[${p.replace(/\.md$/, '')}${a ? `|${a}` : ''}]]`, notePath: () => null });
    const note = buildDashboard(ctx, { statuses: null, linkResolver: wiki });
    expect(note.body).toContain(SYNTHETIC_WATERMARK);
    expect(note.frontmatter.is_synthetic).toBe(true);
    expect(note.body).toMatch(/\[\[07 Reports\/Weekly\/2026-09-20 Weekly report rpt_[A-Z0-9]+\|weekly 2026-09-14 to 2026-09-20\]\]/);
  });
});

describe('report periods', () => {
  it('uses Search Console data availability when recorded', () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    insertRow(ctx.db, 'gsc_data_availability', { id: sid('av'), site_id: ctx.siteId, property: GSC_PROPERTY, search_type: 'web', first_incomplete_date: '2026-09-22', latest_final_date: null, checked_at: '2026-09-23T00:00:00.000Z' });
    const l = latestCompleteDate(ctx);
    expect(l.date).toBe('2026-09-21');
    expect(l.basis).toContain('first incomplete date');
    const w = resolvePeriod(ctx, 'weekly');
    expect([w.start, w.end]).toEqual(['2026-09-15', '2026-09-21']);
    // 2026-09-21 is not a month end, so the monthly report covers August.
    const m = resolvePeriod(ctx, 'monthly');
    expect([m.start, m.end]).toEqual(['2026-08-01', '2026-08-31']);
    expect(m.comparison).toMatchObject({ start: '2026-07-01', end: '2026-07-31' });
  });

  it('never ends a period on or after business-today, and validates explicit periods', () => {
    ctx = createTestContext({ config: reportsTestConfig(), now: '2026-09-24T21:30:00.000Z' }); // already 2026-09-25 in Tallinn
    insertRow(ctx.db, 'gsc_data_availability', { id: sid('av'), site_id: ctx.siteId, property: GSC_PROPERTY, search_type: 'web', first_incomplete_date: null, latest_final_date: '2026-09-30', checked_at: '2026-09-24T00:00:00.000Z' });
    expect(latestCompleteDate(ctx).date).toBe('2026-09-24');
    expect(() => resolvePeriod(ctx!, 'weekly', { start: '2026-09-10' })).toThrow(/both a period start and end/);
    expect(() => resolvePeriod(ctx!, 'weekly', { start: '2026-09-10', end: '2026-09-01' })).toThrow(/after end/);
    const p = resolvePeriod(ctx, 'monthly', { start: '2026-08-01', end: '2026-08-31' });
    expect(p.comparison).toMatchObject({ start: '2026-07-01', end: '2026-07-31' });
    expect(p.explicit).toBe(true);
  });
});

function fakeLlm(opts: { configured: boolean; text?: string; fail?: boolean }): LlmClient & { calls: TextRequest[] } {
  const calls: TextRequest[] = [];
  return {
    synthetic: true,
    calls,
    isConfigured: () => opts.configured,
    structured: async () => ({ ok: false, status: 'unsupported', reason: 'not used' }),
    embed: async () => ({ ok: false, status: 'unsupported', reason: 'not used' }),
    text: async (req) => {
      calls.push(req);
      if (opts.fail) return { ok: false, status: 'budget_exceeded', reason: 'per-run cap reached (synthetic)' };
      return { ok: true, text: opts.text ?? 'Traffic rose; review the pricing recommendation.', callId: 'llm_test_1', model: 'fixture-model', promptVersion: 'reports.executive-summary@1+abcdef12', usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: null }, costMicros: null, truncation: [] };
    },
  };
}

function sectionAfter(md: string, marker: string): string {
  const i = md.indexOf(marker);
  return i < 0 ? '' : md.slice(i, i + 1500);
}

describe('optional LLM executive summary hook', () => {
  it('adds a labeled, model-generated INFERRED summary from computed claims only', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const llm = fakeLlm({ configured: true });
    const b = await buildWeeklyReport(ctx, { statuses: null, llmSummary: { client: llm } });
    const c = allClaims(b.report).find((x) => x.id === 'summary.llm')!;
    expect(c.label).toBe('INFERRED');
    expect(c.text).toContain('Model-generated summary (fixture-model');
    expect(c.text).toContain('computed claims in this report are authoritative');
    // Nothing verifies the model's sentences against the claims: context only, never 'supported'.
    expect(c.evidenceStatus).toBe('context_only');
    expect(c.evidence.every((e) => !e.supportsClaim)).toBe(true);
    expect(c.retrievedAt.length).toBe(1);
    expect(b.issues).toEqual([]);
    expect(sectionAfter(b.markdown, 'Model-generated summary')).toContain('Evidence status: context only');
    expect(b.report.generator.llmSummary.status).toBe('generated');
    expect(b.report.generator.llmSummary.costMicros).toBeNull();
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.promptId).toBe('reports.executive-summary');
    // Evidence given to the model is the report's own claims (no raw rows).
    expect(llm.calls[0]!.evidence.every((e) => typeof e.text === 'string' && !e.text.includes('row_hash'))).toBe(true);
  });

  it('keeps the deterministic report when the model is unconfigured, fails, or in dry-run', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const off = await buildWeeklyReport(ctx, { statuses: null, llmSummary: { client: fakeLlm({ configured: false }) }, persist: false });
    expect(off.report.generator.llmSummary.status).toBe('skipped');
    expect(allClaims(off.report).some((c) => c.id === 'summary.llm')).toBe(false);
    const failing = await buildWeeklyReport(ctx, { statuses: null, llmSummary: { client: fakeLlm({ configured: true, fail: true }) }, persist: false });
    expect(failing.report.generator.llmSummary.status).toBe('failed');
    expect(failing.markdown).toContain('Optional model-generated summary not included');
    ctx.cleanup();
    ctx = createTestContext({ config: reportsTestConfig(), dryRun: true });
    const llm = fakeLlm({ configured: true });
    const dry = await buildWeeklyReport(ctx, { statuses: null, llmSummary: { client: llm } });
    expect(dry.report.generator.llmSummary.status).toBe('skipped');
    expect(llm.calls).toHaveLength(0);
  });
});
