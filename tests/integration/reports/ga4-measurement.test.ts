/**
 * GA4 measurement truth in reports (B3-01, B3-04, B2-04, R3-NF-G7, D3-03).
 * All data is SYNTHETIC (reserved example.test domains, invented numbers).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { buildWeeklyReport } from '../../../src/reports/build.js';
import { confirmRateScale } from '../../../src/integrations/google/ga4-metadata.js';
import { CONFIRM_RATE_SCALE_COMMAND } from '../../../src/integrations/google/rate-scale-command.js';
import { CONFIRM_RATE_SCALE_COMMAND as FROM_GA4_SYNC } from '../../../src/integrations/google/ga4-sync.js';
import { CONFIRM_RATE_SCALE_HINT, rateScaleUnverifiedReason } from '../../../src/seo/metrics.js';
import { allClaims, type Claim } from '../../../src/reports/model.js';
import { GA4_PROPERTY, PRIMARY_EVENT, WEEK, reportsTestConfig, seedBatch, seedGa4Period, seedWeeklyScenario } from '../../fixtures/reports/seed.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

describe('an unverified rate scale names the confirm option (B3-01)', () => {
  it('the data-quality item and the next action point to `sync ga4 --confirm-rate-scale`, never to "repair measurement"', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId, { rateScale: 'undetermined' });
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    const dq = b.report.data.dataQuality!.find((d) => d.code === 'ga4_rate_scale_unverified')!;
    // The printed command includes the required --as (R3-NF-G7): without it the CLI refuses with VALIDATION_FAILED.
    const command = 'npm run cli -- sync ga4 --confirm-rate-scale fraction|percent --evidence "<what you compared>" --as "<your name>"';
    expect(dq.nextStep).toContain(`\`${command}\``);
    expect(dq.nextStep).not.toMatch(/records the scale once it is established/);
    expect(b.report.data.nextAction).toMatchObject({ code: 'confirm_rate_scale', command });
    expect(b.report.data.nextAction!.text).not.toMatch(/Repair measurement/);
    // The "rate scale unverified" reason of an unavailable rate names the same command.
    const go = b.report.data.googleOrganic!;
    expect(go.status === 'observed' && go.value.primarySessionRate.status !== 'observed' && go.value.primarySessionRate.reason).toContain(`\`${command}\``);
    // Every rate-scale command anywhere in the report (next action, data quality, reasons) carries --as.
    const json = JSON.stringify(b.report);
    const printed = json.split('--evidence \\"<what you compared>\\"').length - 1;
    expect(printed).toBeGreaterThanOrEqual(3);
    expect(json.split('--evidence \\"<what you compared>\\" --as \\"<your name>\\"').length - 1).toBe(printed);
  });

  it('one definition of the command: the GA4 sync, the reports, and the metrics reason print the same text with --as', () => {
    expect(CONFIRM_RATE_SCALE_COMMAND).toBe('npm run cli -- sync ga4 --confirm-rate-scale fraction|percent --evidence "<what you compared>" --as "<your name>"');
    expect(FROM_GA4_SYNC).toBe(CONFIRM_RATE_SCALE_COMMAND);
    expect(CONFIRM_RATE_SCALE_HINT).toContain(`\`${CONFIRM_RATE_SCALE_COMMAND}\``);
    expect(rateScaleUnverifiedReason('sessionKeyEventRate:generate_lead')).toContain(`\`${CONFIRM_RATE_SCALE_COMMAND}\``);
  });

  it('after the owner confirms the scale, the same stored days become a measured rate', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId, { rateScale: 'undetermined' });
    confirmRateScale(ctx, GA4_PROPERTY, { scale: 'fraction', evidence: 'GA4 UI shows 20.00% for /pricing on 2026-09-14; stored 0.2', actor: 'Alice' });
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    const go = b.report.data.googleOrganic!;
    expect(go.status).toBe('observed');
    if (go.status !== 'observed') throw new Error('unreachable');
    expect(go.value.primarySessionRate).toEqual({ status: 'observed', value: expect.closeTo(7 / 49, 6) });
    expect(go.value.sessionsWithPrimaryEvent).toEqual({ status: 'observed', value: 7 });
    expect(b.report.data.dataQuality!.some((d) => d.code === 'ga4_rate_scale_unverified')).toBe(false);
    expect(b.report.data.nextAction?.code).not.toBe('confirm_rate_scale');
  });
});

describe('several primary events (B3-04)', () => {
  it('reports the primary events that carry no conversion rate as a data-quality limitation', async () => {
    ctx = createTestContext({
      config: reportsTestConfig({ conversions: { primaryEvents: [{ name: PRIMARY_EVENT, meaning: 'Demo form submitted (synthetic)', kind: 'lead' }, { name: 'purchase', meaning: 'Purchase (synthetic)', kind: 'purchase' }] } }),
    });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    const dq = b.report.data.dataQuality!.find((d) => d.code === 'config_primary_events_not_rated')!;
    expect(dq).toMatchObject({ severity: 'warning', source: 'config', configField: 'conversions.primaryEvents' });
    expect(dq.message).toMatch(/primary event\(s\) "purchase" are not used for conversion rates: only the first configured primary event "generate_lead"/);
  });
});

describe('GA4 channel totals under row loss (B2-04)', () => {
  it('a channel view without rows is not "0 sessions" when the covering sync reported "(other)" bucketing', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId);
    // Remove all_organic rows of the week and keep only a covering batch that reported row loss.
    ctx.db.run("DELETE FROM ga4_landing_daily WHERE site_id = ? AND channel_view = 'all_organic' AND date BETWEEN ? AND ?", [ctx.siteId, WEEK.start, WEEK.end]);
    ctx.db.run("UPDATE ingestion_batches SET status = 'failed' WHERE site_id = ? AND source = 'ga4' AND dataset = 'ga4_landing_daily' AND json_extract(request_json, '$.view') = 'all_organic'", [ctx.siteId]);
    seedBatch(ctx.db, ctx.siteId, { source: 'ga4', dataset: 'ga4_landing_daily', property: GA4_PROPERTY, start: WEEK.start, end: WEEK.end, view: 'all_organic', metadata: { dataLossFromOtherRow: true } });
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    const all = b.report.data.allOrganic!;
    expect(all.status).toBe('incomplete');
    expect(all.status !== 'observed' && all.reason).toMatch(/"\(other\)" \(dataLossFromOtherRow\); absent rows are unknown, not zero sessions/);
  });
});

const claimOf = (claims: Claim[], id: string): Claim => {
  const c = claims.find((x) => x.id === id);
  if (!c) throw new Error(`claim ${id} missing: ${claims.map((x) => x.id).join(', ')}`);
  return c;
};

describe('a rate scale that rests on an owner assertion says so (D3-03)', () => {
  it('OBSERVED rates, converting sessions, and users who converted name the assertion (id, author, date) and cite the confirmation row; data quality lists it', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId, { rateScale: 'undetermined' });
    seedGa4Period(ctx.db, ctx.siteId, { ...WEEK, channel: 'google_organic', metric: `userKeyEventRate:${PRIMARY_EVENT}`, value: 0.25, rateScale: 'undetermined' });
    seedGa4Period(ctx.db, ctx.siteId, { ...WEEK, channel: 'google_organic', metric: 'totalUsers', value: 40 });
    const evidence = 'GA4 UI shows 20.00% for /pricing on 2026-09-14; stored 0.2';
    const c = confirmRateScale(ctx, GA4_PROPERTY, { scale: 'fraction', evidence, actor: 'owner:Alice' });
    const id = c.confirmationId!;
    expect(id).toMatch(/^ga4rs_/);
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    expect(b.issues).toEqual([]);
    const claims = allClaims(b.report);
    const caveat = `Caveat: rate scale 0-1 (stored values used as reported) per owner assertion ${id} by Alice on 2026-09-24; GA4 does not document the scale and no GA4 value established it.`;
    const source = `ga4_rate_scale_confirmations:${id}`;

    const rate = claimOf(claims, 'ga4.google_organic.primary_rate');
    expect(rate).toMatchObject({ label: 'OBSERVED', evidenceStatus: 'supported' });
    expect(rate.text).toMatch(/^Session key-event rate for "generate_lead": 14\.29%/);
    const sessions = claimOf(claims, 'ga4.google_organic.primary_sessions');
    expect(sessions.label).toBe('OBSERVED');
    const users = claimOf(claims, 'ga4.google_organic.primary_users');
    expect(users.label).toBe('INFERRED');
    expect(users.text).toMatch(/about 10 of 40 users \(25\.00%\)/);
    for (const x of [rate, sessions, users, claimOf(claims, 'ga4.all_organic.primary_rate')]) {
      expect(x.text, x.id).toContain(caveat);
      expect(x.sourceIds, x.id).toContain(source);
    }
    // The confirmation row is linked as what the scale rests on, never as the measurement itself.
    for (const x of [rate, users]) expect(x.evidence.find((e) => e.ref === source)).toMatchObject({ kind: 'db_record', supportsClaim: false });
    // Measurements that do not depend on the scale carry no caveat.
    expect(claimOf(claims, 'ga4.google_organic.sessions').text).not.toContain('owner assertion');
    expect(claimOf(claims, 'ga4.google_organic.primary_occurrences').text).not.toContain('owner assertion');

    const dq = b.report.data.dataQuality!.filter((d) => d.code === 'ga4_rate_scale_owner_assertion');
    expect(dq).toHaveLength(1); // listed once, although both channel views use it
    expect(dq[0]).toMatchObject({ severity: 'info', source: 'ga4', recordRef: source });
    expect(dq[0]!.message).toContain(`per owner assertion ${id} by Alice on 2026-09-24 (evidence recorded: "${evidence}")`);
    expect(dq[0]!.nextStep).toContain(`\`${CONFIRM_RATE_SCALE_COMMAND}\``);
    const dqClaim = claims.find((x) => x.id.endsWith('.ga4_rate_scale_owner_assertion'))!;
    expect(dqClaim.evidence).toEqual([expect.objectContaining({ ref: source, supportsClaim: true })]);
    // Markdown escapes the underscore of the id.
    expect(b.markdown).toContain(`per owner assertion ${id.replace(/_/g, '\\_')} by Alice on 2026-09-24`);
  });

  it('a percent assertion says 0-100; a scale proven from the data (integer consistency) or never confirmed carries no owner caveat', async () => {
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId, { rateScale: 'undetermined' });
    const pct = confirmRateScale(ctx, GA4_PROPERTY, { scale: 'percent', evidence: 'GA4 UI shows 0.20% for /pricing on 2026-09-14; stored 0.2', actor: 'Alice' });
    const b = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    expect(b.issues).toEqual([]);
    expect(claimOf(allClaims(b.report), 'ga4.google_organic.primary_rate').text).toContain(`Caveat: rate scale 0-100 (stored values divided by 100) per owner assertion ${pct.confirmationId} by Alice on 2026-09-24`);

    // The latest confirmation counts: an integer-consistency proof recorded by the sync is not an owner assertion.
    ctx.clock.advanceMs(1000);
    confirmRateScale(ctx, GA4_PROPERTY, { scale: 'fraction', basis: 'integer_consistency', evidence: 'Proven by the GA4 sync from stored daily rows (synthetic).', actor: 'system' });
    const proven = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    const provenClaims = allClaims(proven.report);
    expect(claimOf(provenClaims, 'ga4.google_organic.primary_rate').label).toBe('OBSERVED');
    expect(provenClaims.some((x) => x.text.includes('owner assertion') || x.sourceIds.some((s) => s.startsWith('ga4_rate_scale_confirmations:')))).toBe(false);
    expect(proven.report.data.dataQuality!.some((d) => d.code === 'ga4_rate_scale_owner_assertion')).toBe(false);

    ctx.cleanup();
    ctx = createTestContext({ config: reportsTestConfig() });
    seedWeeklyScenario(ctx.db, ctx.siteId, { rateScale: 'fraction' });
    const none = await buildWeeklyReport(ctx, { statuses: null, period: WEEK, persist: false });
    expect(claimOf(allClaims(none.report), 'ga4.google_organic.primary_rate').text).not.toContain('owner assertion');
    expect(none.report.data.dataQuality!.some((d) => d.code === 'ga4_rate_scale_owner_assertion')).toBe(false);
  });
});
