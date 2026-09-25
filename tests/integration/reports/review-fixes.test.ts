/**
 * Regression tests for review findings on the reports slice. All data is
 * SYNTHETIC (reserved example.test / *.invalid domains, invented numbers).
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { buildBaselineReport, buildMonthlyReport, buildWeeklyReport } from '../../../src/reports/build.js';
import { buildDashboard } from '../../../src/reports/dashboard.js';
import { wikiLinkResolver } from '../../../src/reports/links.js';
import { allClaims, validateReport, SYNTHETIC_WATERMARK, type Claim, type Report } from '../../../src/reports/model.js';
import { SYNTHETIC_CLAIM_MARKER } from '../../../src/reports/render.js';
import type { IntegrationStatus } from '../../../src/integrations/types.js';
import { parseModelsResponse } from '../../../src/integrations/llm/models.js';
import { normalizeBaseUrl } from '../../../src/integrations/llm/http.js';
import { costPerMillionCeil, formatUsd } from '../../../src/core/money.js';
import {
  GA4_PROPERTY,
  GSC_PROPERTY,
  PREV_WEEK,
  PRIMARY_EVENT,
  SITE_URL,
  WEEK,
  eachDate,
  insertRow,
  reportsTestConfig,
  seedBatch,
  seedContent,
  seedExperiment,
  seedGa4Landing,
  seedGa4Period,
  seedGscPages,
  seedGscProperty,
  seedPage,
  seedRecommendation,
  seedWeeklyScenario,
  sid,
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

/** What escapeMd would have produced from the raw text (the pre-fix leak shape). */
const mdEscaped = (t: string) => t.replace(/([\\`*_[\]<>|#~])/g, '\\$1');

const COLLECTED = '2026-09-22T06:00:00.000Z';

describe('secret redaction happens before Markdown escaping', () => {
  it('never leaks a secret containing _ * | into the md file, vault note, dashboard, JSON, or summary', async () => {
    const secret = 'my_Secret*Pass|word_42';
    const apifyShaped = `apify_api_${'Q'.repeat(24)}`;
    ctx = createTestContext({ config: reportsTestConfig(), secrets: { LLM_GATEWAY_API_KEY: secret } });
    const s = seedWeeklyScenario(ctx.db, ctx.siteId);
    seedRecommendation(ctx.db, ctx.siteId, { pageId: s.pricingPageId, title: `Rotate ${secret} now (synthetic)` });
    const item = seedContent(ctx.db, ctx.siteId);
    ctx.db.run('UPDATE content_items SET title = ? WHERE id = ?', [`Draft about ${secret} (synthetic)`, item]);
    const statuses: IntegrationStatus[] = [
      { id: 'llm_gateway', state: 'misconfigured', detail: `key ${secret} rejected; old token ${apifyShaped}`, nextStep: `Replace ${secret}.`, sendsExternally: [], checkedAt: '2026-09-24T08:00:00.000Z', networkChecked: false, chargeable: false },
    ];
    const wiki = wikiLinkResolver({ link: (p, a) => `[[${p.replace(/\.md$/, '')}${a ? `|${a}` : ''}]]`, notePath: (t) => (t.kind === 'recommendation' ? `05 Recommendations/${t.id}.md` : null) });
    const b = await buildWeeklyReport(ctx, { statuses, linkResolver: wiki });
    const dash = buildDashboard(ctx, { statuses, linkResolver: wiki });
    const md = readFileSync(b.stored!.markdownPath, 'utf8');
    const json = readFileSync(b.stored!.jsonPath, 'utf8');
    const summary = JSON.stringify(ctx.db.all('SELECT summary_json FROM reports'));
    const aliasForm = secret.replace(/[|[\]#^]/g, ' '); // what the wikilink alias sanitizer would produce
    for (const [name, text] of Object.entries({ md, json, note: b.note.body, dashboard: dash.body, summary, returned: JSON.stringify(b.report) })) {
      expect(text, name).not.toContain(secret);
      expect(text, name).not.toContain(mdEscaped(secret));
      expect(text, name).not.toContain(aliasForm);
      expect(text, name).not.toContain('Q'.repeat(24));
      expect(text, name).not.toContain(mdEscaped(apifyShaped));
    }
    expect(md).toContain('\\[REDACTED\\]');
    expect(dash.body).toContain('REDACTED');
    expect(b.issues).toEqual([]);
  });
});

describe('coverage is scoped to the exact GA4 view and Search Console search type', () => {
  it('reports a failed or never-synced GA4 view as DATA UNAVAILABLE, not as zero sessions', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const dates = eachDate(WEEK.start, WEEK.end);
    seedGa4Landing(ctx.db, ctx.siteId, { dates, rows: [{ channel: 'google_organic', landingPage: '/pricing', sessions: 5, primary: 1, rate: 0.2 }] });
    seedBatch(ctx.db, ctx.siteId, { source: 'ga4', dataset: 'ga4_landing_daily', property: GA4_PROPERTY, start: WEEK.start, end: WEEK.end, status: 'failed', view: 'all_organic' });
    // A batch that records no view at all never proves coverage of any view.
    seedBatch(ctx.db, ctx.siteId, { source: 'ga4', dataset: 'ga4_landing_daily', property: GA4_PROPERTY, start: WEEK.start, end: WEEK.end });
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    expect(b.report.data.googleOrganic?.status).toBe('observed');
    expect(b.report.data.allOrganic?.status).toBe('missing');
    const all = find(b.report, 'ga4.all_organic.sessions');
    expect(all.label).toBe('DATA_UNAVAILABLE');
    expect(all.reason).toContain('no successful GA4 all_organic sync');
    expect(sectionText(b.markdown, 'All organic search (GA4')).not.toMatch(/Sessions: 0\b/);
    expect(b.report.data.dataQuality?.some((d) => d.code === 'ga4_all_organic_missing')).toBe(true);

    // A successful all_organic sync that returned no rows IS a measured zero.
    seedBatch(ctx.db, ctx.siteId, { source: 'ga4', dataset: 'ga4_landing_daily', property: GA4_PROPERTY, start: WEEK.start, end: WEEK.end, view: 'all_organic' });
    const b2 = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    const ao = b2.report.data.allOrganic!;
    expect(ao.status).toBe('observed');
    expect(ao.status === 'observed' && ao.value.sessions).toBe(0);
  });

  it('never treats another search type as coverage for Search Console totals', async () => {
    ctx = createTestContext({ config: reportsTestConfig({ google: { searchConsoleProperty: GSC_PROPERTY, ga4PropertyId: GA4_PROPERTY, gsc: { searchTypes: ['web', 'image'] } } }) });
    const dates = eachDate(WEEK.start, WEEK.end);
    seedBatch(ctx.db, ctx.siteId, { source: 'gsc', dataset: 'gsc_property_daily', property: GSC_PROPERTY, start: WEEK.start, end: WEEK.end, status: 'failed', searchType: 'web' });
    seedGscProperty(ctx.db, ctx.siteId, { dates, clicks: 4, impressions: 90, position: 12, searchType: 'image' });
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    expect(b.report.data.gsc?.searchType).toBe('web');
    expect(b.report.data.gsc?.current.status).toBe('missing');
    const t = find(b.report, 'gsc.totals.current');
    expect(t.label).toBe('DATA_UNAVAILABLE');
    expect(t.reason).toContain('search type web');
    expect(allClaims(b.report).some((c) => c.id === 'gsc.clicks.current')).toBe(false);
    expect(sectionText(b.markdown, 'Search Console performance')).not.toMatch(/Clicks: (0|28)\b/);

    // A web batch recorded with the deprecated `searchType` alias counts; zero rows then mean zero.
    seedBatch(ctx.db, ctx.siteId, { source: 'gsc', dataset: 'gsc_property_daily', property: GSC_PROPERTY, start: WEEK.start, end: WEEK.end, request: { searchType: 'WEB' } });
    const b2 = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    expect(b2.report.data.gsc?.current.status).toBe('observed');
    expect(find(b2.report, 'gsc.clicks.current').text).toContain('Clicks: 0 ');
  });
});

describe('baseline measurement check', () => {
  it('reads nested GA4 event views separately and filters by property (never sums views)', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const dates = eachDate(WEEK.start, WEEK.end);
    const counts: Array<[string, string, number]> = [
      [GA4_PROPERTY, 'google_organic', 2],
      [GA4_PROPERTY, 'all_organic', 3],
      [GA4_PROPERTY, 'all_traffic', 10],
      ['999999', 'all_traffic', 100], // another property: excluded
    ];
    for (const [pid, view, n] of counts) {
      const batch = seedBatch(ctx.db, ctx.siteId, { source: 'ga4', dataset: 'ga4_event_daily', property: pid, start: WEEK.start, end: WEEK.end, view });
      for (const date of dates) {
        insertRow(ctx.db, 'ga4_event_daily', {
          site_id: ctx.siteId, property_id: pid, date, date_tz: 'Europe/Tallinn', channel_view: view, event_name: PRIMARY_EVENT, landing_page: '', event_count: n, key_event_count: n,
          is_complete: 1, revision: 1, is_current: 1, row_hash: sid('h'), batch_id: batch, collected_at: COLLECTED, transformation_version: 'test@1', is_synthetic: 0,
        });
      }
    }
    const b = await buildBaselineReport(ctx, { statuses: null, persist: false });
    const c = find(b.report, `measurement.${PRIMARY_EVENT}.events`);
    expect(c.label).toBe('OBSERVED');
    expect(c.text).toContain('all traffic 70 on 7 day(s)');
    expect(c.text).toContain('Google organic 14 on 7 day(s)');
    expect(c.text).toContain('all organic 21 on 7 day(s)');
    expect(c.text).toContain('never summed');
    expect(c.text).not.toMatch(/\b105\b|\b770\b|\b805\b/);
    expect(c.retrievedAt).toEqual([COLLECTED]);
    expect(b.issues).toEqual([]);
  });
});

describe('synthetic or sandbox evidence', () => {
  it('watermarks the report, marks the claim, and never counts it as support in a live report', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const s = seedWeeklyScenario(ctx.db, ctx.siteId);
    const rec = seedRecommendation(ctx.db, ctx.siteId, { pageId: s.pricingPageId });
    const src = sid('src');
    insertRow(ctx.db, 'sources', { id: src, site_id: ctx.siteId, source_type: 'dataforseo', trust_class: 'synthetic', url: 'https://serp.example.invalid/search?q=x', title: '[SANDBOX - SYNTHETIC] SERP', retrieved_at: COLLECTED, content_hash: sid('c') });
    const ev = sid('ev');
    insertRow(ctx.db, 'evidence', { id: ev, site_id: ctx.siteId, source_id: src, kind: 'observation', summary: 'Top results show plan tables (sandbox)', collected_at: COLLECTED });
    insertRow(ctx.db, 'claim_evidence', { id: sid('ce'), site_id: ctx.siteId, subject_type: 'recommendation', subject_id: rec, claim_key: 'serp', claim_text: 'Top results all show plan comparison tables.', claim_label: 'OBSERVED', evidence_id: ev, support: 'supports', created_at: COLLECTED });
    const b = await buildWeeklyReport(ctx, { statuses: null, persist: false });
    const c = allClaims(b.report).find((x) => x.text.startsWith('Top results'))!;
    expect(c.synthetic).toBe(true);
    expect(c.evidenceStatus).toBe('context_only');
    expect(c.evidence.every((e) => !e.supportsClaim)).toBe(true);
    expect(c.text).toContain('synthetic/sandbox');
    expect(b.report.isSynthetic).toBe(true);
    expect(b.markdown).toContain(SYNTHETIC_WATERMARK);
    expect(b.markdown.split('\n').find((l) => l.includes('Top results'))).toContain(`**OBSERVED** ${SYNTHETIC_CLAIM_MARKER}`);
    expect(b.report.data.dataQuality?.some((d) => d.code === 'synthetic_in_live' && d.severity === 'critical')).toBe(true);
    const diag = find(b.report, 'action.diagnosis');
    expect(diag.evidence.some((e) => e.ref === `evidence:${ev}`)).toBe(false);
    expect(b.issues).toEqual([]);
  });
});

describe('experiment evidence is scoped to one property and search type', () => {
  it('does not double-count impressions across search types or properties', async () => {
    ctx = createTestContext({ config: reportsTestConfig({ google: { searchConsoleProperty: GSC_PROPERTY, ga4PropertyId: GA4_PROPERTY, gsc: { searchTypes: ['web', 'image'] } } }) });
    const page = seedPage(ctx.db, ctx.siteId, '/pricing');
    const dates = eachDate('2026-09-01', WEEK.end);
    const pages = [{ url: `${SITE_URL}/pricing`, pageId: page, clicks: 1, impressions: 20, position: 7 }];
    seedGscPages(ctx.db, ctx.siteId, { dates, pages, searchType: 'web' });
    seedGscPages(ctx.db, ctx.siteId, { dates, pages, searchType: 'image' });
    seedGscPages(ctx.db, ctx.siteId, { dates, pages, property: `${SITE_URL}/` });
    seedGscProperty(ctx.db, ctx.siteId, { dates, clicks: 1, impressions: 20, position: 7 });
    seedExperiment(ctx.db, ctx.siteId, { pageId: page, status: 'observing', implementedAt: '2026-09-01T00:00:00.000Z', minDays: 7, minImpressions: 500 });
    const b = await buildWeeklyReport(ctx, { statuses: null, persist: false });
    const e = b.report.data.experiments![0]!;
    expect(e.impressionsSinceStart).toBe(20 * dates.length); // web + configured property only (400)
    expect(e.enoughEvidence).toBe(false);
    expect(e.evidenceNote).toContain('400 of 500 required impressions');
  });
});

describe('monthly spend covers the reviewed month', () => {
  function reservation(t: TestContext, r: { provider: string; status: string; cost: string; est: number; actual: number | null; month: string; week: string; at: string }): void {
    insertRow(t.db, 'budget_reservations', { id: sid('res'), site_id: t.siteId, provider: r.provider, run_id: 'run_test', purpose: 'synthetic', estimated_usd_micros: r.est, actual_usd_micros: r.actual, status: r.status, cost_status: r.cost, period_month: r.month, period_week: r.week, created_at: r.at, updated_at: r.at });
  }

  it('shows the reviewed month and labels the current month separately', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    reservation(ctx, { provider: 'dataforseo', status: 'reconciled', cost: 'actual', est: 300_000, actual: 250_000, month: '2026-08', week: '2026-W33', at: '2026-08-12T10:00:00.000Z' });
    reservation(ctx, { provider: 'llm_gateway', status: 'reserved', cost: 'estimated', est: 120_000, actual: null, month: '2026-09', week: '2026-W39', at: '2026-09-23T10:00:00.000Z' });
    const m = await buildMonthlyReport(ctx, { statuses: null, persist: false });
    expect(m.report.period).toMatchObject({ start: '2026-08-01', end: '2026-08-31' });
    expect(m.report.data.spend?.periodMonth).toBe('2026-08');
    const d = find(m.report, 'spend.dataforseo');
    expect(d.text).toContain('actual $0.25');
    expect(d.text).toContain('for 2026-08 (the reviewed month)');
    expect(find(m.report, 'spend.llm_gateway').text).toContain('reserved $0.00');
    const cur = find(m.report, 'spend.current_month');
    expect(cur.text).toContain('Current budget month 2026-09');
    expect(cur.text).toContain('NOT the reviewed month');
    expect(cur.text).toContain('committed $0.12');
    expect(m.markdown).toContain('Spend, reviewed month 2026-08');
    expect(m.issues).toEqual([]);

    const w = await buildWeeklyReport(ctx, { statuses: null, persist: false });
    expect(w.report.data.spend?.periodMonth).toBe('2026-09');
    expect(allClaims(w.report).some((c) => c.id === 'spend.current_month')).toBe(false);
    expect(find(w.report, 'spend.llm_gateway').text).toContain('month to date');
  });

  it('excludes synthetic fixture LLM calls from API usage and unknown-cost counts', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const call = (synthetic: number) => ({ id: sid('llm'), site_id: ctx!.siteId, trace_id: 't', role: 'analyst', tier: 'reasoning', prompt_id: 'p', prompt_version: 'p@1', model_requested: 'model-under-test', max_output_tokens: 100, input_tokens: 1000, output_tokens: 200, cost_status: 'unknown', validation_status: 'valid', is_synthetic: synthetic, created_at: '2026-08-07T10:00:00.000Z' });
    insertRow(ctx.db, 'llm_calls', call(0));
    insertRow(ctx.db, 'llm_calls', call(1));
    insertRow(ctx.db, 'llm_calls', call(1));
    const m = await buildMonthlyReport(ctx, { statuses: null, persist: false });
    expect(find(m.report, 'api.llm').text).toMatch(/^1 LLM call\(s\)/);
    expect(find(m.report, 'api.excluded').text).toContain('2 synthetic/fixture LLM call(s)');
    expect(find(m.report, 'spend.unknown').text).toContain('1 LLM call(s) with unknown cost');
    expect(m.report.data.unknownCostEntries).toBe(1);
  });
});

describe('prioritized action uses only live recommendations of the reported period', () => {
  function job(t: TestContext): string {
    const id = sid('job');
    insertRow(t.db, 'jobs', { id, site_id: t.siteId, type: 'weekly', status: 'succeeded', created_at: '2026-09-23T07:00:00.000Z' });
    return id;
  }

  it('waits when the job recommendation was rejected, and never substitutes another one', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const s = seedWeeklyScenario(ctx.db, ctx.siteId);
    const j = job(ctx);
    seedRecommendation(ctx.db, ctx.siteId, { pageId: s.guidePageId, title: 'Older live recommendation (synthetic)', createdAt: '2026-09-22T08:00:00.000Z' });
    const rejected = seedRecommendation(ctx.db, ctx.siteId, { pageId: s.pricingPageId, jobId: j, status: 'rejected' });
    const b = await buildWeeklyReport(ctx, { statuses: null, jobId: j, persist: false });
    const p = find(b.report, 'action.primary');
    expect(p.text).toMatch(/^Wait:/);
    expect(p.text).toContain('is rejected');
    expect(p.sourceIds).toEqual([`recommendations:${rejected}`]);
    expect(b.report.data.primaryAction?.kind).toBe('wait');
    expect(b.markdown).not.toContain('Primary action: Rewrite');
    expect(b.markdown).not.toContain('Older live recommendation');

    ctx.db.run("UPDATE recommendations SET status = 'approved' WHERE id = ?", [rejected]);
    const b2 = await buildWeeklyReport(ctx, { statuses: null, jobId: j, persist: false });
    expect(find(b2.report, 'action.primary').sourceIds).toEqual([`recommendations:${rejected}`]);
  });

  it('bounds an explicit past period by its end plus the grace window', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const s = seedWeeklyScenario(ctx.db, ctx.siteId);
    seedRecommendation(ctx.db, ctx.siteId, { pageId: s.pricingPageId, title: 'Recorded after the past period (synthetic)', createdAt: '2026-09-23T08:00:00.000Z' });
    const past = await buildWeeklyReport(ctx, { statuses: null, period: PREV_WEEK, persist: false });
    expect(find(past.report, 'action.primary').text).toMatch(/^Wait:/);
    expect(past.markdown).not.toContain('Recorded after the past period');
    const inPeriod = seedRecommendation(ctx.db, ctx.siteId, { pageId: s.guidePageId, title: 'Recorded for the past period (synthetic)', createdAt: '2026-09-15T08:00:00.000Z' });
    const past2 = await buildWeeklyReport(ctx, { statuses: null, period: PREV_WEEK, persist: false });
    expect(find(past2.report, 'action.primary').sourceIds).toEqual([`recommendations:${inPeriod}`]);
    // The default (latest) period still sees the newest live recommendation.
    const latest = await buildWeeklyReport(ctx, { statuses: null, persist: false });
    expect(find(latest.report, 'action.primary').text).toContain('Recorded after the past period');
  });
});

describe('users stay period-grain', () => {
  it('names the period-level windows that exist instead of substituting one', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    seedGa4Period(ctx.db, ctx.siteId, { start: '2026-08-25', end: '2026-09-21', channel: 'google_organic', metric: 'totalUsers', value: 120 });
    const b = await buildWeeklyReport(ctx, { statuses: null, persist: false });
    const u = find(b.report, 'ga4.google_organic.users');
    expect(u.label).toBe('DATA_UNAVAILABLE');
    expect(u.reason).toContain('exist only for 2026-08-25 to 2026-09-21');
    expect(u.reason).toContain('never substituted');
    expect(b.markdown).not.toMatch(/Users[^\n]*: 120\b/);
  });
});

describe('retrieval dates', () => {
  it('gives every supported OBSERVED claim at least one retrieval date', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    const s = seedWeeklyScenario(ctx.db, ctx.siteId);
    seedGscPages(ctx.db, ctx.siteId, { dates: eachDate(WEEK.start, WEEK.end), pages: [{ url: `${SITE_URL}/pricing`, pageId: s.pricingPageId, clicks: 1, impressions: 10, position: 4, segmentKey: 'device=MOBILE', device: 'MOBILE' }] });
    seedContent(ctx.db, ctx.siteId);
    for (const build of [buildWeeklyReport, buildMonthlyReport, buildBaselineReport]) {
      const b = await build(ctx, { statuses: null, persist: false });
      expect(b.issues).toEqual([]);
      for (const c of allClaims(b.report).filter((x) => x.label === 'OBSERVED' && x.evidenceStatus === 'supported')) {
        expect(c.retrievedAt.length, c.id).toBeGreaterThan(0);
      }
    }
    const w = await buildWeeklyReport(ctx, { statuses: null, persist: false });
    expect(find(w.report, 'gsc.device.context').retrievedAt).toEqual([COLLECTED]);
    expect(find(w.report, 'content.queue').retrievedAt).toEqual([w.report.generatedAt]);
    expect(validateReport(w.report)).toEqual([]);
  });
});

describe('baseline cost plan', () => {
  it('prices models from the cached gateway catalog like the LLM client, and labels the source', async () => {
    ctx = createTestContext({ config: reportsTestConfig({ models: { embedding: 'synthetic-embed-small', reasoning: 'synthetic-reasoner' }, llm: { pricingOverrides: {} } }) });
    const parsed = parseModelsResponse(JSON.parse(readFileSync(new URL('../../fixtures/llm/models.synthetic.json', import.meta.url), 'utf8')));
    const snap = sid('llmcat');
    const retrievedAt = '2026-09-24T01:00:00.000Z'; // within the catalog freshness window (clock 2026-09-24T09:00Z)
    insertRow(ctx.db, 'llm_model_catalog_snapshots', { id: snap, site_id: ctx.siteId, base_url: normalizeBaseUrl(ctx.settings.llmBaseUrl), authenticated: 1, model_count: parsed.models.length, skipped_count: 0, is_synthetic: 0, retrieved_at: retrievedAt });
    for (const m of parsed.models) {
      insertRow(ctx.db, 'llm_model_capabilities', { snapshot_id: snap, site_id: ctx.siteId, model_id: m.id, is_embedding: m.isEmbedding ? 1 : 0, prompt_price: m.pricing.prompt, completion_price: m.pricing.completion, capabilities_json: JSON.stringify(m), retrieved_at: retrievedAt });
    }
    const doc = sid('doc');
    insertRow(ctx.db, 'memory_documents', { id: doc, site_id: ctx.siteId, source_type: 'business_note', source_ref: '01 Business/Offer.md', title: 'Offer', trust_class: 'owner_approved', status: 'active', content_hash: 'h', created_at: '2026-09-20T00:00:00.000Z', updated_at: '2026-09-20T00:00:00.000Z' });
    insertRow(ctx.db, 'memory_chunks', { id: sid('ch'), document_id: doc, site_id: ctx.siteId, chunk_index: 0, text: 'synthetic chunk', token_estimate: 500_000, content_hash: 'c1', chunker_version: 'v1', document_version: 1, created_at: '2026-09-20T00:00:00.000Z' });
    const b = await buildBaselineReport(ctx, { statuses: null, persist: false });
    const emb = find(b.report, 'cost.embeddings');
    expect(emb.text).toContain('Estimated upper bound: $0.01'); // 0.5M tokens x $0.02/1M (catalog "0.02e-6" per token)
    expect(emb.text).toContain(`gateway catalog price (retrieved ${retrievedAt})`);
    const cfg = ctx.config.llm;
    // Same bound the gateway reserves: input + max output + reasoning allowance (= max output) for a reasoning model.
    const expected = costPerMillionCeil(2_000_000, cfg.maxInputTokens) + costPerMillionCeil(8_000_000, cfg.maxOutputTokensReasoning) + costPerMillionCeil(8_000_000, cfg.maxOutputTokensReasoning);
    const llm = find(b.report, 'cost.llm');
    expect(llm.text).toContain(`: ${formatUsd(expected)}`);
    expect(llm.text).toContain('reasoning-token allowance');
    expect(llm.text).toContain('gateway catalog price');
    expect(b.issues).toEqual([]);
  });
});
