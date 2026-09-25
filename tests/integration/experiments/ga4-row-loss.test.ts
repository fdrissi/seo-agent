/**
 * NF-03: experiment evaluation never counts a GA4 landing row that may have
 * been left out ("(other)" bucketing, thresholding, sampling) as zero.
 * D1-R02: nor does it use values from sampled or "(other)"-bucketed reports
 * as exact numbers when the page has a row every day.
 * SYNTHETIC data only (tests/fixtures/experiments/scenario.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildScenario, type Scenario } from '../../fixtures/experiments/scenario.js';
import { evaluateExperiment } from '../../../src/experiments/evaluate.js';
import { EVALUATION_METHOD_VERSION } from '../../../src/experiments/method.js';

/** SYNTHETIC: every GA4 landing report says rows may be withheld, and the given pages have no row on the given days. */
function thresholdAndDrop(s: Scenario, pageIds: string[], start: string, end: string): void {
  s.ctx.db.run(`UPDATE ingestion_batches SET metadata_json = ? WHERE site_id = ? AND dataset = 'ga4_landing_daily'`, [JSON.stringify({ subjectToThresholding: true }), s.ctx.siteId]);
  for (const id of pageIds) {
    s.ctx.db.run(`UPDATE ga4_landing_daily SET is_current = 0 WHERE site_id = ? AND page_id = ? AND date BETWEEN ? AND ?`, [s.ctx.siteId, id, start, end]);
  }
}

describe('experiment evaluation with GA4 row loss (synthetic)', () => {
  let s: Scenario | undefined;
  afterEach(() => s?.ctx.cleanup());

  it('a treated page missing on thresholded days: the conversion guardrail is unavailable (not ok, not breached) and the verdict carries the caveat', async () => {
    s = await buildScenario();
    const clean = evaluateExperiment(s.ctx, s.experimentId, { dryRun: true });
    expect(clean.result).toBe('positive');
    expect(clean.guardrails.map((g) => `${g.metric}:${g.status}`)).toEqual(['primarySessionRate:ok']);

    // Three observation-window days: the treated page has no GA4 row, the comparison pages still do (the days are collected).
    thresholdAndDrop(s, [s.page.id], '2026-07-10', '2026-07-12');
    const ev = evaluateExperiment(s.ctx, s.experimentId, { dryRun: true });
    const g = ev.guardrails[0]!;
    expect(g).toMatchObject({ metric: 'primarySessionRate', status: 'unavailable' });
    expect(g.comparison.label).toBe('DATA_UNAVAILABLE');
    expect(g.comparison.treated.observation).toBeNull();
    expect(g.comparison.verdict).toBe('insufficient_data');
    expect(g.comparison.reasons.join(' ')).toMatch(/GA4 reported thresholding .*treated observation: 3 row-loss day\(s\).*unknown, not zero/);
    // The search-visibility result stands, but it says the conversion guardrail was not verified and why.
    expect(ev.seo?.primary.verdict).toBe('positive');
    const why = ev.reasons.join(' ');
    expect(why).toMatch(/GA4 data caveat \(GA4 guardrail\(s\) primarySessionRate incomplete, not zero\)/);
    expect(why).toMatch(/guardrail\(s\) unverified for lack of data: primarySessionRate/);
  });

  it('comparison pages missing on thresholded days: a conversion outcome is not judged (insufficient data, never a biased effect)', async () => {
    s = await buildScenario({
      recommendation: { actionType: 'improve_cta_conversion' },
      propose: { primaryMetric: 'primarySessionRate' },
      ga4: { sessionsBefore: 100, sessionsAfter: 100, rateBefore: 0.02, rateAfter: 0.04 },
      config: { minSessions: 50 },
    });
    const clean = evaluateExperiment(s.ctx, s.experimentId, { dryRun: true });
    expect(clean.conversion?.primary.verdict).toBe('positive');

    // Only the comparison group lost rows (the treated page is complete): its pooled change would be biased.
    thresholdAndDrop(s, [s.comparison[0]!.id], '2026-06-10', '2026-06-12');
    const ev = evaluateExperiment(s.ctx, s.experimentId, { dryRun: true });
    const primary = ev.conversion!.primary;
    expect(primary.verdict).toBe('insufficient_data');
    expect(primary.control?.baseline).toBeNull(); // the comparison window is not used as an observed total
    expect(primary.reasons.join(' ')).toMatch(/comparison baseline: 3 row-loss day\(s\)/);
    expect(ev.result).not.toBe('positive');
    expect(ev.result).not.toBe('negative');
    expect(ev.reasons.join(' ')).toMatch(/GA4 data caveat \(the conversion outcome and GA4 guardrail|GA4 data caveat \(the conversion outcome incomplete/);
    expect((ev.conversion!.sample as { absentRowsUnknown?: string }).absentRowsUnknown).toMatch(/thresholding/);
  });
});

/** SYNTHETIC: mark GA4 landing reports as sampled / "(other)"-bucketed; every page keeps its rows on every day. */
function markGa4Reports(s: Scenario, metadata: Record<string, unknown>, onlyPageId?: string): void {
  if (!onlyPageId) {
    s.ctx.db.run(`UPDATE ingestion_batches SET metadata_json = ? WHERE site_id = ? AND dataset = 'ga4_landing_daily'`, [JSON.stringify(metadata), s.ctx.siteId]);
    return;
  }
  const batch = s.ctx.db.get<{ batch_id: string }>(`SELECT batch_id FROM ga4_landing_daily WHERE site_id = ? AND page_id = ? LIMIT 1`, [s.ctx.siteId, onlyPageId])!.batch_id;
  s.ctx.db.run(`UPDATE ingestion_batches SET metadata_json = ? WHERE site_id = ? AND id = ?`, [JSON.stringify(metadata), s.ctx.siteId, batch]);
}

describe('experiment evaluation with sampled or "(other)"-bucketed GA4 reports, page rows present (synthetic, D1-R02)', () => {
  let s: Scenario | undefined;
  afterEach(() => s?.ctx.cleanup());

  it('sampled reports: the conversion guardrail gets no verdict (unavailable) and the evaluation carries a GA4 data caveat naming sampling', async () => {
    s = await buildScenario();
    expect(evaluateExperiment(s.ctx, s.experimentId, { dryRun: true }).guardrails.map((g) => `${g.metric}:${g.status}`)).toEqual(['primarySessionRate:ok']);

    markGa4Reports(s, { samplingMetadatas: [{ samplesReadCount: '5000', samplingSpaceSize: '50000' }] });
    const ev = evaluateExperiment(s.ctx, s.experimentId, { dryRun: true });
    const g = ev.guardrails[0]!;
    expect(g).toMatchObject({ metric: 'primarySessionRate', status: 'unavailable' });
    expect(g.comparison.label).toBe('DATA_UNAVAILABLE');
    expect(g.comparison.treated.baseline).toBeNull();
    expect(g.comparison.treated.observation).toBeNull();
    expect(g.comparison.effect).toBeNull();
    expect(g.comparison.verdict).toBe('insufficient_data');
    expect(g.comparison.reasons.join(' ')).toMatch(/GA4 landing values are estimates on collected days where GA4 reported sampling \(sampled values are estimates\).*treated baseline: \d+ estimate day\(s\).*treated observation: \d+ estimate day\(s\)/);
    // Nothing is missing here (every page has a row every day): no "not zero" caveat.
    expect(g.comparison.reasons.join(' ')).not.toMatch(/may be missing/);
    // Converting sessions are unknown (the rate is an estimate), never reported as "max 0.0".
    expect(g.comparison.reasons.join(' ')).toMatch(/GA4 baseline primary session key-event rate is incomplete/);
    expect(g.comparison.reasons.join(' ')).not.toMatch(/too few converting sessions/);
    expect(ev.seo?.primary.verdict).toBe('positive');
    const why = ev.reasons.join(' ');
    expect(why).toMatch(/GA4 data caveat \(GA4 guardrail\(s\) primarySessionRate estimated, not exact\): GA4 landing values are estimates .*sampling/);
    expect(why).toMatch(/guardrail\(s\) unverified for lack of data: primarySessionRate/);
  });

  it('"(other)" bucketing on a conversion outcome: no observed comparison, never a positive or negative verdict', async () => {
    s = await buildScenario({
      recommendation: { actionType: 'improve_cta_conversion' },
      propose: { primaryMetric: 'primarySessionRate' },
      ga4: { sessionsBefore: 100, sessionsAfter: 100, rateBefore: 0.02, rateAfter: 0.04 },
      config: { minSessions: 50 },
    });
    expect(evaluateExperiment(s.ctx, s.experimentId, { dryRun: true }).conversion?.primary.verdict).toBe('positive');

    markGa4Reports(s, { dataLossFromOtherRow: true });
    const ev = evaluateExperiment(s.ctx, s.experimentId, { dryRun: true });
    const primary = ev.conversion!.primary;
    expect(primary.label).toBe('DATA_UNAVAILABLE');
    expect(primary.verdict).toBe('insufficient_data');
    expect(primary.treated.baseline).toBeNull();
    expect(primary.treated.observation).toBeNull();
    for (const sup of ev.conversion!.supporting) expect(sup.label).toBe('DATA_UNAVAILABLE');
    expect(ev.result).not.toBe('positive');
    expect(ev.result).not.toBe('negative');
    const sample = ev.conversion!.sample as { estimatedValues?: string; absentRowsUnknown?: string };
    expect(sample.estimatedValues).toMatch(/rows bucketed into "\(other\)" \(dataLossFromOtherRow\).*may be counted in the "\(other\)" row/);
    expect(sample.absentRowsUnknown).toBeUndefined();
    expect(ev.reasons.join(' ')).toMatch(/GA4 data caveat \(the conversion outcome and GA4 guardrail|GA4 data caveat \(the conversion outcome estimated, not exact\)/);
    expect(ev.reasons.join(' ')).toMatch(/"\(other\)"/);
  });

  it('only one comparison page came from a sampled report: the conversion outcome is not judged (no biased pooled effect)', async () => {
    s = await buildScenario({
      recommendation: { actionType: 'improve_cta_conversion' },
      propose: { primaryMetric: 'primarySessionRate' },
      ga4: { sessionsBefore: 100, sessionsAfter: 100, rateBefore: 0.02, rateAfter: 0.04 },
      config: { minSessions: 50 },
    });
    markGa4Reports(s, { samplingMetadatas: [{ samplesReadCount: '10', samplingSpaceSize: '100' }] }, s.comparison[0]!.id);
    const ev = evaluateExperiment(s.ctx, s.experimentId, { dryRun: true });
    const primary = ev.conversion!.primary;
    expect(primary.verdict).toBe('insufficient_data');
    expect(primary.control?.baseline).toBeNull(); // the comparison window is not used as an exact total
    expect(primary.reasons.join(' ')).toMatch(/comparison baseline: \d+ estimate day\(s\), comparison observation: \d+ estimate day\(s\)/);
    expect(primary.reasons.join(' ')).not.toMatch(/treated (baseline|observation): \d+ estimate/);
    expect(ev.result).not.toBe('positive');
  });

  it('a recorded (non-dry-run) evaluation stores the caveat and the current method version', async () => {
    s = await buildScenario();
    markGa4Reports(s, { samplingMetadatas: [{ samplesReadCount: '5000', samplingSpaceSize: '50000' }] });
    const ev = evaluateExperiment(s.ctx, s.experimentId, {});
    const row = s.ctx.db.get<{ reasons_json: string; guardrails_json: string; method_version: string }>(`SELECT reasons_json, guardrails_json, method_version FROM experiment_evaluations WHERE id = ?`, [ev.evaluationId]);
    expect(row?.method_version).toBe(EVALUATION_METHOD_VERSION);
    expect(row?.reasons_json).toMatch(/GA4 data caveat/);
    expect(row?.reasons_json).toMatch(/sampling/);
    expect(JSON.parse(row!.guardrails_json)[0]).toMatchObject({ metric: 'primarySessionRate', status: 'unavailable' });
  });
});
