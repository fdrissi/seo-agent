import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { importDataset } from '../../../src/data/import.js';
import { OWNER_IMPORT_INCOMPLETE } from '../../../src/reports/sections-common.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';
import { buildWeeklyReport } from '../../../src/reports/build.js';
import { allClaims, validateReport, SYNTHETIC_WATERMARK, type Claim, type Report } from '../../../src/reports/model.js';
import type { IntegrationStatus } from '../../../src/integrations/types.js';
import {
  GA4_PROPERTY,
  PREV_WEEK,
  WEEK,
  eachDate,
  reportsTestConfig,
  seedApproval,
  seedContent,
  seedExperiment,
  seedGa4Landing,
  seedGa4Period,
  seedGscProperty,
  seedRecommendation,
  seedRecommendationEvidence,
  seedBatch,
  seedWeeklyScenario,
} from '../../fixtures/reports/seed.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

function find(report: Report, id: string): Claim {
  const c = allClaims(report).find((x) => x.id === id);
  if (!c) throw new Error(`claim ${id} not found; have: ${allClaims(report).map((x) => x.id).join(', ')}`);
  return c;
}

function sectionText(md: string, heading: string): string {
  const start = md.indexOf(`## ${heading}`);
  if (start < 0) throw new Error(`section ${heading} not found`);
  const next = md.indexOf('\n## ', start + 3);
  return md.slice(start, next < 0 ? undefined : next);
}

const readyStatuses = (at = '2026-09-24T08:00:00.000Z'): IntegrationStatus[] => [
  { id: 'google_gsc', state: 'ready', detail: 'synthetic ok', sendsExternally: ['OAuth token to Google'], checkedAt: at, networkChecked: false, chargeable: false },
  { id: 'google_ga4', state: 'ready', detail: 'synthetic ok', sendsExternally: ['OAuth token to Google'], checkedAt: at, networkChecked: false, chargeable: false },
];

describe('weekly report (synthetic DB)', () => {
  it('resolves the period to the latest complete week and labels every claim', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const s = seedWeeklyScenario(ctx.db, ctx.siteId);
    const rec = seedRecommendation(ctx.db, ctx.siteId, { pageId: s.pricingPageId });
    seedRecommendationEvidence(ctx.db, ctx.siteId, rec);
    const b = await buildWeeklyReport(ctx, { statuses: readyStatuses() });
    expect(b.report.period.start).toBe(WEEK.start);
    expect(b.report.period.end).toBe(WEEK.end);
    expect(b.report.period.comparison).toMatchObject({ start: PREV_WEEK.start, end: PREV_WEEK.end });
    expect(b.issues).toEqual([]);
    expect(validateReport(b.report)).toEqual([]);
    const labels = new Set(allClaims(b.report).map((c) => c.label));
    for (const l of ['OBSERVED', 'INFERRED', 'HYPOTHESIS', 'RECOMMENDATION', 'DATA_UNAVAILABLE'] as const) expect(labels.has(l)).toBe(true);
    for (const l of ['**OBSERVED**', '**INFERRED**', '**HYPOTHESIS**', '**RECOMMENDATION**', '**DATA UNAVAILABLE**']) expect(b.markdown).toContain(l);
    // Every OBSERVED claim carries source ids and supporting evidence (or is explicitly flagged).
    for (const c of allClaims(b.report).filter((x) => x.label === 'OBSERVED')) {
      expect(c.sourceIds.length).toBeGreaterThan(0);
      if (c.evidenceStatus === 'supported') expect(c.evidence.some((e) => e.supportsClaim)).toBe(true);
    }
    // Metric definitions and retrieval dates are present.
    expect(b.markdown).toContain('## Metric definitions');
    expect(find(b.report, 'gsc.clicks.current').retrievedAt.length).toBeGreaterThan(0);
    expect(b.report.isSynthetic).toBe(false);
    expect(b.markdown).not.toContain(SYNTHETIC_WATERMARK);
  });

  it('never sums property totals with page rows, and computes CTR and weighted position in code', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const b = await buildWeeklyReport(ctx, { statuses: readyStatuses() });
    const clicks = find(b.report, 'gsc.clicks.current');
    expect(clicks.label).toBe('OBSERVED');
    expect(clicks.text).toContain('Clicks: 70 ');
    expect(b.markdown).not.toMatch(/\b133\b/); // 70 property clicks + 63 page clicks
    expect(find(b.report, 'gsc.ctr.current').text).toContain('5.00%'); // 70 / 1400
    expect(find(b.report, 'gsc.position.current').text).toContain('8.0');
    expect(find(b.report, 'gsc.clicks.change').text).toContain('70 vs 56');
    const gsc = b.report.data.gsc!;
    expect(gsc.current.status).toBe('observed');
    // Top pages are shown separately (byPage) with their own totals.
    expect(b.markdown).toContain('not additive with property totals');
    // Visible queries: brand split and an unattributed estimate (42 page clicks vs 35 query clicks).
    expect(find(b.report, 'gsc.brand').text).toContain('Branded: 1 queries, 14 clicks');
    const un = find(b.report, 'gsc.query.unattributed');
    expect(un.label).toBe('INFERRED');
    expect(un.text).toContain('35 of 42 page clicks');
  });

  it('reports property totals as DATA UNAVAILABLE instead of substituting summed page rows', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId, { skipProperty: true });
    const b = await buildWeeklyReport(ctx, { statuses: readyStatuses(), period: WEEK });
    const t = find(b.report, 'gsc.totals.current');
    expect(t.label).toBe('DATA_UNAVAILABLE');
    expect(t.reason).toContain('no Search Console property totals were ingested');
    expect(sectionText(b.markdown, 'Search Console performance')).not.toMatch(/Clicks: 63\b/);
    expect(b.report.data.gsc?.current.status).toBe('missing');
  });

  it('keeps Google organic and all-organic results distinct', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const b = await buildWeeklyReport(ctx, { statuses: readyStatuses() });
    const google = sectionText(b.markdown, 'Google organic (GA4');
    const all = sectionText(b.markdown, 'All organic search (GA4');
    expect(google).toContain('Sessions: 49');
    expect(all).toContain('Sessions: 91');
    expect(google).not.toContain('Sessions: 91');
    expect(all).not.toContain('Sessions: 49');
    expect(b.markdown).not.toMatch(/Sessions: 140\b/); // 49 + 91 is never reported
    expect(google + all).not.toMatch(/\b140\b/);
    const go = b.report.data.googleOrganic!;
    const ao = b.report.data.allOrganic!;
    expect(go.status === 'observed' && go.value.channelView).toBe('google_organic');
    expect(ao.status === 'observed' && ao.value.channelView).toBe('all_organic');
    // Primary-event rate aggregated from compatible counts: 7 converting of 49 sessions.
    const rate = find(b.report, 'ga4.google_organic.primary_rate');
    expect(rate.label).toBe('OBSERVED');
    expect(rate.text).toContain('14.29%');
    expect(find(b.report, 'ga4.google_organic.primary_occurrences').text).toContain('7');
    // Clicks vs sessions explanation is INFERRED and does not assert a cause.
    const vs = find(b.report, 'ga4.google_organic.vs_gsc');
    expect(vs.label).toBe('INFERRED');
    expect(vs.text).toContain('does not establish which cause dominates');
  });

  it('never sums users across days: DATA UNAVAILABLE without a period-level value, observed with one', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId); // 7 daily totalUsers rows of 6 each
    const first = await buildWeeklyReport(ctx, { statuses: readyStatuses(), persist: false });
    const users = find(first.report, 'ga4.google_organic.users');
    expect(users.label).toBe('DATA_UNAVAILABLE');
    expect(users.reason).toContain('not additive across days');
    expect(first.markdown).not.toMatch(/Users[^\n]*\b42\b/);
    seedGa4Period(ctx.db, ctx.siteId, { start: WEEK.start, end: WEEK.end, channel: 'google_organic', metric: 'totalUsers', value: 31 });
    const second = await buildWeeklyReport(ctx, { statuses: readyStatuses(), persist: false });
    const u2 = find(second.report, 'ga4.google_organic.users');
    expect(u2.label).toBe('OBSERVED');
    expect(u2.text).toContain('Users (totalUsers; period-level, not summed across days): 31');
  });

  it('labels the primary-event rate DATA UNAVAILABLE and shows any-key-event only as an explicit alternative', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId, { gaRateStatus: 'unavailable' });
    seedGa4Period(ctx.db, ctx.siteId, { start: WEEK.start, end: WEEK.end, channel: 'google_organic', metric: 'sessionKeyEventRate', value: 0.3 });
    const b = await buildWeeklyReport(ctx, { statuses: readyStatuses() });
    const rate = find(b.report, 'ga4.google_organic.primary_rate');
    expect(rate.label).toBe('DATA_UNAVAILABLE');
    expect(rate.text).toContain('No substitute is used');
    const alt = find(b.report, 'ga4.google_organic.any_key_event_rate');
    expect(alt.text).toContain('ALTERNATIVE, NOT the primary event');
    expect(alt.metricIds).toEqual(['ga4.session_rate.any']);
    expect(b.report.data.dataQuality?.some((d) => d.code === 'primary_event_rate_unavailable' && d.severity === 'critical')).toBe(true);
    expect(b.report.data.nextAction?.code).toBe('repair_measurement');
    expect(b.report.data.confidence?.level).not.toBe('high');
  });

  it('reports DATA UNAVAILABLE when no primary event is configured', async () => {
    ctx = createTestContext({ config: reportsTestConfig({ conversions: { primaryEvents: [] } }) });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const b = await buildWeeklyReport(ctx, { statuses: readyStatuses() });
    const rate = find(b.report, 'ga4.google_organic.primary_rate');
    expect(rate.label).toBe('DATA_UNAVAILABLE');
    expect(rate.reason).toContain('no primary conversion event is configured');
    expect(b.report.data.nextAction?.code).toBe('configure_primary_event');
    expect(validateReport(b.report)).toEqual([]);
  });

  it('shows one prioritized action with measurements, evidence, and flagged URL-only claims', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const s = seedWeeklyScenario(ctx.db, ctx.siteId);
    const rec = seedRecommendation(ctx.db, ctx.siteId, { pageId: s.pricingPageId });
    seedRecommendation(ctx.db, ctx.siteId, { pageId: s.guidePageId, kind: 'secondary', title: 'Guide links to pricing (synthetic)', createdAt: '2026-09-23T08:05:00.000Z' });
    seedRecommendationEvidence(ctx.db, ctx.siteId, rec);
    const b = await buildWeeklyReport(ctx, { statuses: readyStatuses() });
    const primary = find(b.report, 'action.primary');
    expect(primary.label).toBe('RECOMMENDATION');
    expect(primary.sourceIds).toEqual([`recommendations:${rec}`]);
    expect(allClaims(b.report).filter((c) => c.id === 'action.primary')).toHaveLength(1);
    expect(find(b.report, 'action.measure.page').text).toContain('42 clicks'); // /pricing 6/day
    expect(find(b.report, 'action.measure.query').text).toContain('21 clicks');
    expect(find(b.report, 'action.diagnosis').label).toBe('INFERRED');
    expect(find(b.report, 'action.hypothesis').label).toBe('HYPOTHESIS');
    expect(find(b.report, 'action.query_attribution').label).toBe('HYPOTHESIS');
    expect(find(b.report, 'action.secondary.1').text).toContain('Guide links to pricing');
    const evs = allClaims(b.report).filter((c) => c.id.startsWith('action.evidence.'));
    expect(evs.find((c) => c.text.startsWith('The query has a CTR gap'))?.evidenceStatus).toBe('supported');
    const urlOnly = evs.find((c) => c.text.startsWith('Competitors mention'))!;
    expect(urlOnly.evidenceStatus).toBe('context_only');
    expect(urlOnly.text).toContain('evidence not verifiable');
    expect(b.markdown).toContain('location only; does not by itself support the claim');
    const details = sectionText(b.markdown, 'Prioritized action');
    for (const f of ['Proposed change', 'Hypothesis', 'Success criteria', 'Risks', 'Review date', '2026-10-22']) expect(details).toContain(f);
  });

  it('recommends waiting explicitly when no recommendation exists', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const b = await buildWeeklyReport(ctx, { statuses: readyStatuses() });
    const p = find(b.report, 'action.primary');
    expect(p.label).toBe('RECOMMENDATION');
    expect(p.text).toMatch(/^Wait: no production change is recommended/);
    expect(b.report.data.primaryAction?.kind).toBe('wait');
  });

  it('summarizes experiments, content, approvals and access issues', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const s = seedWeeklyScenario(ctx.db, ctx.siteId);
    seedExperiment(ctx.db, ctx.siteId, { pageId: s.guidePageId, status: 'observing', implementedAt: '2026-09-10T10:00:00.000Z' });
    seedExperiment(ctx.db, ctx.siteId, { pageId: s.pricingPageId, status: 'awaiting_implementation' });
    seedContent(ctx.db, ctx.siteId);
    seedApproval(ctx.db, ctx.siteId);
    const statuses: IntegrationStatus[] = [
      ...readyStatuses(),
      { id: 'dataforseo', state: 'missing_credentials', detail: 'DATAFORSEO_LOGIN not set', nextStep: 'Add DataForSEO credentials to the workspace secrets file.', sendsExternally: ['keywords'], checkedAt: '2026-09-24T08:00:00.000Z', networkChecked: false, chargeable: false },
    ];
    const b = await buildWeeklyReport(ctx, { statuses });
    const exps = b.report.data.experiments!;
    const observing = exps.find((e) => e.status === 'observing')!;
    expect(observing.observationStart).toBe('2026-09-10');
    expect(observing.daysObserved).toBe(11); // 2026-09-10 .. 2026-09-20
    expect(observing.enoughEvidence).toBe(false);
    expect(observing.impressionsSinceStart).toBe(150 * 11);
    expect(observing.evidenceNote).toContain('11 of 28 minimum days');
    const waiting = exps.find((e) => e.status === 'awaiting_implementation')!;
    expect(waiting.evidenceNote).toContain('approval or draft creation does not start it');
    expect(find(b.report, 'experiments.active').text).toContain('1 observing, 1 awaiting implementation');
    expect(find(b.report, 'content.queue').text).toContain('1 content item');
    expect(find(b.report, 'content.unresolved_facts').text).toContain('publication stays blocked');
    expect(b.report.data.pendingApprovals).toBe(1);
    expect(b.report.data.nextAction?.code).toBe('review_approvals');
    const access = allClaims(b.report).find((c) => c.id.startsWith('access.1.dataforseo'))!;
    expect(access.text).toContain('missing_credentials');
    expect(access.text).toContain('workspace secrets file');
    expect(b.markdown).toContain('| dataforseo | missing\\_credentials |');
  });

  it('says access was not checked when statuses are not supplied', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const b = await buildWeeklyReport(ctx, { statuses: null });
    expect(find(b.report, 'access.unchecked').label).toBe('DATA_UNAVAILABLE');
    expect(find(b.report, 'summary.issues').text).toContain('integration access was not checked');
    expect(b.report.data.confidence?.level).toBe('medium');
  });

  it('shows unknown charges separately and never as $0', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const r = ctx.budgets.reserve({ siteId: ctx.siteId, provider: 'llm_gateway', runId: ctx.runId, purpose: 'synthetic test call', estimate: { upperBoundMicros: 120_000, basis: { source: 'verified_config', detail: 'synthetic' } } });
    ctx.budgets.markUnresolved(r.id, 'synthetic timeout after submission');
    const b = await buildWeeklyReport(ctx, { statuses: readyStatuses() });
    const llm = find(b.report, 'spend.llm_gateway');
    expect(llm.text).toContain('1 charge(s) of UNKNOWN amount');
    expect(llm.text).toContain('never counted as $0');
    expect(llm.text).toContain('reserved $0.12');
    const spend = sectionText(b.markdown, 'Spend and remaining budgets');
    // Provider | Provider-reported | Computed | Reserved | Estimated-only | Unknown charges | Synthetic | ...
    expect(spend).toMatch(/\| llm\\_gateway \| \$0\.00 \| \$0\.00 \| \$0\.12 \| \$0\.00 \| 1 \(amount unknown\) \| none \|/);
    const provider = b.report.data.spend!.providers.find((p) => p.provider === 'llm_gateway')!;
    expect(provider.unknownCount).toBe(1);
    expect(b.report.data.nextAction?.code).toBe('reconcile_costs');
  });

  it('keeps provider-reported and computed-from-usage spend apart, and labels synthetic amounts (C5-03)', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const seed = { upperBoundMicros: 200_000, basis: { source: 'verified_config' as const, detail: 'synthetic test seed' } };
    // A provider-reported LLM charge and one computed from usage at list price (SYNTHETIC test amounts, not synthetic-flagged rows).
    const reported = ctx.budgets.reserve({ siteId: ctx.siteId, provider: 'llm_gateway', runId: 'run_reported', purpose: 'synthetic reported call', estimate: seed });
    ctx.budgets.reconcile(reported.id, { actualMicros: 150_000, source: 'gateway_reported' });
    const computed = ctx.budgets.reserve({ siteId: ctx.siteId, provider: 'llm_gateway', runId: 'run_computed', purpose: 'synthetic computed call', estimate: seed });
    ctx.budgets.reconcile(computed.id, { actualMicros: 210, source: 'computed_from_usage' });
    // A sandbox/fixture DataForSEO reservation flagged synthetic (no real charge).
    const sandbox = ctx.budgets.reserve({ siteId: ctx.siteId, provider: 'dataforseo', runId: 'run_sandbox', purpose: '[SYNTHETIC sandbox] task', estimate: { upperBoundMicros: 2_000, basis: { source: 'verified_config', detail: 'synthetic' } }, synthetic: true });
    ctx.budgets.reconcile(sandbox.id, { actualMicros: 1_500, source: 'computed_from_usage' });

    const b = await buildWeeklyReport(ctx, { statuses: readyStatuses() });
    expect(validateReport(b.report)).toEqual([]);
    const llm = find(b.report, 'spend.llm_gateway');
    expect(llm.label).toBe('OBSERVED');
    expect(llm.text).toContain('actual $0.15021 (provider-reported $0.15 + computed from usage $0.00021 (1 request(s) at list price, not provider-reported))');
    expect(llm.metricIds).toContain('spend.computed');
    expect(llm.synthetic).toBeUndefined();
    expect(llm.text).not.toContain('SYNTHETIC');

    const dfs = find(b.report, 'spend.dataforseo');
    expect(dfs.synthetic).toBe(true);
    expect(dfs.text).toContain('provider-reported $0.00 + computed from usage $0.0015');
    expect(dfs.text).toMatch(/\[SYNTHETIC: \$0\.0015 of the committed amount from 1 fixture\/sandbox\/demo reservation\(s\); no real charges\]/);
    expect(find(b.report, 'spend.combined').synthetic).toBe(true);

    const spend = sectionText(b.markdown, 'Spend and remaining budgets');
    expect(spend).toContain('| Provider | Provider-reported | Computed (usage x list price) | Reserved | Estimated-only | Unknown charges | Synthetic | Committed | Monthly limit | Remaining | Weekly |');
    expect(spend).toMatch(/\| llm\\_gateway \| \$0\.15 \| \$0\.00021 \| \$0\.00 \| \$0\.00 \| none \| none \|/);
    expect(spend).toMatch(/\| dataforseo \| \$0\.00 \| \$0\.0015 \| \$0\.00 \| \$0\.00 \| none \| SYNTHETIC \$0\.0015 \(1 reservation\(s\); no real charge\) \|/);
    expect(spend).toContain('Actual spend = provider-reported + computed.');
    // The per-claim SYNTHETIC marker is rendered next to the label; a live report is not turned into a demo report by it.
    expect(spend).toMatch(/\*\*OBSERVED\*\* \S*SYNTHETIC\S* dataforseo:/);
    expect(b.report.data.dataQuality?.some((d) => d.code === 'synthetic_in_live')).toBe(false);
  });

  it('watermarks reports that contain synthetic rows and flags them in a live site', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    seedGa4Landing(ctx.db, ctx.siteId, { dates: eachDate(WEEK.start, WEEK.end), rows: [{ channel: 'google_organic', landingPage: '/demo', sessions: 1 }], synthetic: 1 });
    const b = await buildWeeklyReport(ctx, { statuses: readyStatuses() });
    expect(b.report.isSynthetic).toBe(true);
    expect(b.report.watermark).toBe(SYNTHETIC_WATERMARK);
    const lines = b.markdown.split('\n');
    expect(lines.slice(0, 4).join('\n')).toContain(SYNTHETIC_WATERMARK);
    expect(b.markdown.trimEnd().split('\n').slice(-5).join('\n')).toContain(SYNTHETIC_WATERMARK);
    expect(JSON.parse(b.json).watermark).toBe(SYNTHETIC_WATERMARK);
    expect(b.note.frontmatter.is_synthetic).toBe(true);
    expect(b.report.data.dataQuality?.some((d) => d.code === 'synthetic_in_live' && d.severity === 'critical')).toBe(true);
    expect(b.report.data.confidence?.level).toBe('none');
    const row = ctx.db.get<{ is_synthetic: number }>('SELECT is_synthetic FROM reports WHERE id = ?', [b.report.id]);
    expect(row?.is_synthetic).toBe(1);
    expect(validateReport(b.report)).toEqual([]);
  });

  it('surfaces GA4 thresholding/sampling metadata and truncated or failed syncs as data-quality warnings', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    seedBatch(ctx.db, ctx.siteId, { source: 'ga4', dataset: 'ga4_landing_daily', property: GA4_PROPERTY, start: WEEK.start, end: WEEK.end, metadata: { metadata: { subjectToThresholding: true, samplingMetadatas: [{ samplesReadCount: '10', samplingSpaceSize: '100' }], dataLossFromOtherRow: true } } });
    seedBatch(ctx.db, ctx.siteId, { source: 'gsc', dataset: 'gsc_page_query_daily', property: 'sc-domain:example.test', start: WEEK.start, end: WEEK.end, truncated: 1, coverage: [{ code: 'ROW_LIMIT', message: 'hit 50,000 rows/day (synthetic)' }] });
    seedBatch(ctx.db, ctx.siteId, { source: 'gsc', dataset: 'gsc_page_daily', property: 'sc-domain:example.test', start: WEEK.start, end: WEEK.end, status: 'failed' });
    const b = await buildWeeklyReport(ctx, { statuses: readyStatuses() });
    const codes = b.report.data.dataQuality!.map((d) => d.code);
    expect(codes).toContain('ga4_metadata');
    expect(codes).toContain('batch_truncated_gsc_page_query_daily');
    expect(codes).toContain('batch_failed_gsc_page_daily');
    const msgs = b.report.data.dataQuality!.map((d) => d.message).join('\n');
    expect(msgs).toContain('subjectToThresholding');
    expect(msgs).toContain('sampled');
    expect(msgs).toContain('"(other)"');
    expect(msgs).toContain('ROW_LIMIT: hit 50,000 rows/day (synthetic)');
    expect(b.report.data.confidence?.level).toBe('medium');
    const dqClaim = allClaims(b.report).find((c) => c.id.includes('batch_truncated'))!;
    expect(dqClaim.evidence[0]?.ref).toMatch(/^ingestion_batches:batch_/);
    expect(validateReport(b.report)).toEqual([]);
  });

  it('watermarks demo-profile reports without flagging them as synthetic data in a live site', async () => {
    ctx = createTestContext({ config: testSiteConfig({ profile: 'demo' }) });
    const b = await buildWeeklyReport(ctx, { statuses: null });
    expect(b.report.isSynthetic).toBe(true);
    expect(b.markdown).toContain(SYNTHETIC_WATERMARK);
    expect(b.report.data.dataQuality?.some((d) => d.code === 'synthetic_in_live')).toBe(false);
    expect(b.report.data.confidence?.level).toBe('none');
  });

  it('never writes registered secrets into the Markdown, JSON, summary, or vault note', async () => {
    const secret = 'sk-live-SyntheticSecretValue0123456789';
    ctx = createTestContext({ config: reportsTestConfig(), secrets: { LLM_GATEWAY_API_KEY: secret } });
    const s = seedWeeklyScenario(ctx.db, ctx.siteId);
    seedRecommendation(ctx.db, ctx.siteId, { pageId: s.pricingPageId, title: `Title that leaked ${secret} (synthetic)` });
    const statuses: IntegrationStatus[] = [{ id: 'llm_gateway', state: 'misconfigured', detail: `key ${secret} rejected`, nextStep: 'Rotate the key.', sendsExternally: [], checkedAt: '2026-09-24T08:00:00.000Z', networkChecked: false, chargeable: false }];
    const b = await buildWeeklyReport(ctx, { statuses });
    expect(b.stored).not.toBeNull();
    const md = readFileSync(b.stored!.markdownPath, 'utf8');
    const json = readFileSync(b.stored!.jsonPath, 'utf8');
    for (const text of [md, json, b.note.body, JSON.stringify(ctx.db.all('SELECT summary_json FROM reports'))]) {
      expect(text).not.toContain(secret);
    }
    expect(md).toContain('\\[REDACTED\\]');
    // Aggregates + top-N only: no raw row dumps.
    expect(json).not.toContain('row_hash');
  });

  it('builds an honest report for an empty site (no data, no crash)', async () => {
    ctx = createTestContext();
    const b = await buildWeeklyReport(ctx, { statuses: null });
    expect(b.issues).toEqual([]);
    expect(find(b.report, 'gsc.totals.current').label).toBe('DATA_UNAVAILABLE');
    expect(find(b.report, 'ga4.google_organic.sessions').label).toBe('DATA_UNAVAILABLE');
    expect(b.report.data.confidence?.level).toBe('none');
    expect(b.report.period.latestCompleteDate).toBeNull();
    expect(b.report.period.latestCompleteBasis).toContain('assumption');
    expect(find(b.report, 'action.primary').text).toMatch(/^Wait/);
    expect(b.report.data.nextAction?.code).toBe('configure_primary_event');
    expect(b.markdown).toContain('never synced');
  });

  it('excludes non-final days from totals and flags a partial period', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    // Add two fresh (non-final) days after the complete week.
    seedGscProperty(ctx.db, ctx.siteId, { dates: ['2026-09-21', '2026-09-22'], clicks: 50, impressions: 500, position: 3, isFinal: 0 });
    const b = await buildWeeklyReport(ctx, { statuses: readyStatuses(), period: { start: '2026-09-16', end: '2026-09-22' } });
    const clicks = find(b.report, 'gsc.clicks.current');
    expect(clicks.text).toContain('Clicks: 50 '); // 5 final days x 10; the 100 fresh clicks are excluded
    expect(b.report.data.dataQuality?.some((d) => d.code === 'gsc_incomplete_excluded')).toBe(true);
    expect(b.report.data.dataQuality?.some((d) => d.code === 'period_includes_incomplete')).toBe(true);
    expect(find(b.report, 'gsc.clicks.change').label).toBe('DATA_UNAVAILABLE');
  });

  it('uses the GA4 property from config and ignores other properties', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    expect(GA4_PROPERTY).toBe('123456');
    const b = await buildWeeklyReport(ctx, { statuses: readyStatuses(), persist: false });
    expect(b.report.data.googleOrganic?.status).toBe('observed');
    expect(b.stored).toBeNull();
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reports')?.n).toBe(0);
  });
});

// C1-09: an owner import without --complete (stored truncated) never "hit a documented (API) row limit".
// SYNTHETIC CSV written by the test (reserved example.test domain, invented numbers), imported as the owner's
// live import (a live workspace refuses --synthetic, D1-R01).
describe('truncated owner imports in the report (C1-09)', () => {
  it('freshness and data quality describe the import, not a row limit', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const file = path.join(ctx.paths.root, 'pages.csv');
    writeFileSync(file, ['Date,Page,Clicks,Impressions,CTR,Position', ...eachDate(WEEK.start, WEEK.end).map((d) => `${d},https://www.example.test/imported-page,1,10,10%,8.0`)].join('\n'));
    const imp = importDataset(ctx, 'gsc-pages', file);
    expect(imp.status).toBe('succeeded');
    const b = await buildWeeklyReport(ctx, { statuses: readyStatuses(), persist: false });
    const dq = b.report.data.dataQuality!;
    const batch = dq.find((d) => d.code === 'batch_truncated_gsc_page_daily' && d.source === 'import')!;
    expect(batch.message).toBe(`Batch ${imp.batchId} (gsc_page_daily, ${WEEK.start} to ${WEEK.end}) is an owner import without --complete: rows absent from the file are unknown, not zero.`);
    expect(batch.nextStep).toMatch(/data import <dataset> <file> --complete/);
    const latest = dq.find((d) => d.code === 'truncated_gsc_page_daily' && d.source === 'import')!;
    expect(latest.message).toMatch(/owner import without --complete: rows absent from the file are unknown, not zero/);
    for (const d of dq.filter((x) => x.source === 'import')) expect(d.message).not.toMatch(/row limit/);
    const fresh = sectionText(b.markdown, 'Data freshness');
    expect(fresh).toMatch(/import gsc\\_page\\_daily: .*last batch incomplete \(owner import without --complete: rows absent from the file are unknown, not zero\)/);
    expect(OWNER_IMPORT_INCOMPLETE).toBe('owner import without --complete: rows absent from the file are unknown, not zero');
    // A Search Console sync batch that hit the row limit is still described as one.
    seedBatch(ctx.db, ctx.siteId, { source: 'gsc', dataset: 'gsc_page_query_daily', property: 'sc-domain:example.test', start: WEEK.start, end: WEEK.end, truncated: 1, coverage: [{ code: 'ROW_LIMIT', message: 'hit 50,000 rows/day (synthetic)' }] });
    const b2 = await buildWeeklyReport(ctx, { statuses: readyStatuses(), persist: false });
    expect(b2.report.data.dataQuality!.find((d) => d.code === 'batch_truncated_gsc_page_query_daily')!.message).toMatch(/hit a documented row limit/);
    expect(b.report.data.confidence?.reasons.join(' ')).toMatch(/incomplete owner imports/);
  });
});
