import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BudgetService } from '../../../src/budgets/budget-service.js';
import { ProviderRequestLog } from '../../../src/budgets/provider-requests.js';
import type { BudgetProvider, CostEstimate } from '../../../src/budgets/types.js';
import type { BudgetSettings } from '../../../src/config/load.js';
import { parseSiteConfig } from '../../../src/config/site-schema.js';
import { ensureSite } from '../../../src/database/sites.js';
import { REDACTED } from '../../../src/security/redact.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

const LIMITS: BudgetSettings = {
  llmGateway: { monthly: 5_000_000, perRun: 500_000 },
  dataforseo: { weekly: 1_000_000, monthly: 10_000_000, perRun: 500_000 },
  apify: { monthly: 10_000_000, perRun: 1_000_000 },
  pagespeed: { monthly: 0, perRun: 0 },
  combinedMonthly: 25_000_000,
  accountMonthly: {},
};

const est = (micros: number | null, source: CostEstimate['basis']['source'] = 'verified_config'): CostEstimate => ({
  upperBoundMicros: micros,
  basis: { source, detail: 'synthetic test price' },
});

let ctx: TestContext;
let svc: BudgetService;
const make = (limits: Partial<BudgetSettings> = {}, timeZone = 'Europe/Tallinn') => new BudgetService(ctx.db, { limits: { ...LIMITS, ...limits }, timeZone, clock: ctx.clock });
const reserve = (provider: BudgetProvider, micros: number | null, runId = 'run_a', s = svc, extra: { approval?: string; siteId?: string } = {}) =>
  s.reserve({
    siteId: extra.siteId ?? ctx.siteId,
    provider,
    runId,
    purpose: `test ${provider}`,
    estimate: est(micros),
    ...(extra.approval ? { unknownPriceApprovalId: extra.approval } : {}),
  });
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
};
const scopeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as { details?: { scope?: string } }).details?.scope;
  }
  return undefined;
};
const audits = (type: string) => ctx.db.all<{ details_json: string }>('SELECT details_json FROM audit_events WHERE event_type = ? ORDER BY id', [type]);

beforeEach(() => {
  ctx = createTestContext({ now: '2026-09-24T09:00:00.000Z' });
  svc = make();
});
afterEach(() => ctx.cleanup());

describe('reserve', () => {
  it('reserves within limits and records the reservation and an audit event', () => {
    const r = reserve('llm_gateway', 120_000);
    expect(r).toMatchObject({ siteId: ctx.siteId, provider: 'llm_gateway', runId: 'run_a', estimatedMicros: 120_000, status: 'reserved', periodMonth: '2026-09', periodWeek: '2026-W39' });
    const row = ctx.db.get<Record<string, unknown>>('SELECT * FROM budget_reservations WHERE id = ?', [r.id])!;
    expect(row).toMatchObject({ status: 'reserved', cost_status: 'estimated', estimated_usd_micros: 120_000, actual_usd_micros: null });
    expect(audits('budget.reserved')).toHaveLength(1);
  });

  it('enforces the per-run cap per run id', () => {
    reserve('llm_gateway', 300_000, 'run_a');
    expect(scopeOf(() => reserve('llm_gateway', 300_000, 'run_a'))).toBe('run');
    expect(() => reserve('llm_gateway', 200_000, 'run_a')).not.toThrow(); // exactly at the cap
    expect(() => reserve('llm_gateway', 300_000, 'run_b')).not.toThrow();
  });

  it('enforces the monthly service cap', () => {
    for (let i = 0; i < 10; i++) reserve('apify', 1_000_000, `run_${i}`);
    expect(scopeOf(() => reserve('apify', 1, 'run_x'))).toBe('site_service_month');
  });

  it('enforces the weekly DataForSEO cap and resets it the next ISO week', () => {
    reserve('dataforseo', 500_000, 'run_1');
    reserve('dataforseo', 500_000, 'run_2');
    expect(scopeOf(() => reserve('dataforseo', 1, 'run_3'))).toBe('site_service_week');
    ctx.clock.set('2026-09-28T09:00:00.000Z'); // Monday of 2026-W40
    expect(reserve('dataforseo', 500_000, 'run_4').periodWeek).toBe('2026-W40');
    expect(svc.report(ctx.siteId).providers.find((p) => p.provider === 'dataforseo')!.committedMicros).toBe(1_500_000); // month still counts all
  });

  it('enforces the combined monthly ceiling across providers', () => {
    const s = make({ llmGateway: { monthly: 5_000_000, perRun: 5_000_000 }, apify: { monthly: 5_000_000, perRun: 5_000_000 }, combinedMonthly: 1_500_000 });
    reserve('llm_gateway', 1_000_000, 'r1', s);
    expect(scopeOf(() => reserve('apify', 600_000, 'r2', s))).toBe('site_combined_month');
    expect(() => reserve('apify', 500_000, 'r2', s)).not.toThrow();
  });

  it('enforces shared account caps across sites', () => {
    ensureSite(ctx.db, parseSiteConfig({ site: { id: 'second-site', businessName: 'Second (synthetic)', url: 'https://second.example.test/', allowedHostnames: ['second.example.test'] } }));
    const s = make({ accountMonthly: { apify: 1_500_000 } });
    reserve('apify', 1_000_000, 'r1', s);
    expect(scopeOf(() => reserve('apify', 1_000_000, 'r2', s, { siteId: 'second-site' }))).toBe('account_service_month');
    expect(() => reserve('apify', 500_000, 'r2', s, { siteId: 'second-site' })).not.toThrow();
    // Site-level limits remain isolated per site.
    expect(s.report('second-site').providers.find((p) => p.provider === 'apify')!.committedMicros).toBe(500_000);
  });

  it('account caps are workspace-wide: a site whose own config declares none is still bound (separate services per site)', () => {
    const siteConfig = (id: string, account: Record<string, string>) =>
      parseSiteConfig({ site: { id, businessName: `${id} (synthetic)`, url: `https://${id}.example.test/`, allowedHostnames: [`${id}.example.test`] }, budgets: { accountMonthlyUsd: account } });
    // site-a declares the shared Apify account cap; site-b declares a larger one; test-site declares none.
    ensureSite(ctx.db, siteConfig('site-a', { apify: '1.50' }));
    ensureSite(ctx.db, siteConfig('site-b', { apify: '9.00' }));
    const forSite = (siteId: string, account: Record<string, number>) => new BudgetService(ctx.db, { limits: { ...LIMITS, accountMonthly: account }, timeZone: 'Europe/Tallinn', clock: ctx.clock, siteId });
    const a = forSite('site-a', { apify: 1_500_000 });
    const b = forSite('site-b', { apify: 9_000_000 });
    const own = forSite(ctx.siteId, {});
    expect(own.accountCap('apify')).toEqual({ limitMicros: 1_500_000, declaredBy: ['site-a'] });
    expect(own.accountCap('dataforseo')).toBeUndefined();
    reserve('apify', 1_000_000, 'r1', a, { siteId: 'site-a' });
    // test-site's own config has no account cap, yet the shared account is protected.
    const denied = (() => {
      try {
        reserve('apify', 600_000, 'r2', own);
      } catch (err) {
        return err as { code: string; details: { scope: string; limitMicros: number; declaredBy: string[] } };
      }
      return null;
    })();
    expect(denied).toMatchObject({ code: 'BUDGET_EXCEEDED', details: { scope: 'account_service_month', limitMicros: 1_500_000, declaredBy: ['site-a'] } });
    // site-b's larger declaration does not relax the smallest cap either.
    expect(scopeOf(() => reserve('apify', 600_000, 'r3', b, { siteId: 'site-b' }))).toBe('account_service_month');
    expect(() => reserve('apify', 500_000, 'r4', own)).not.toThrow();
    expect(own.checkLimits({ siteId: ctx.siteId, provider: 'apify', runId: 'r5', amountMicros: 1 }).find((c) => c.scope === 'account_service_month')).toMatchObject({ committedMicros: 1_500_000, limitMicros: 1_500_000 });
  });

  it('account caps count only real reservations: synthetic (demo, fixture, sandbox) reservations never use up the shared cap (C2-02)', () => {
    // A demo site whose synthetic reservations share the database (e.g. after a demo backup was restored into a live workspace).
    const demo = parseSiteConfig({ profile: 'demo', site: { id: 'demo-site', businessName: 'Demo Co (synthetic)', url: 'https://www.example.com/', allowedHostnames: ['www.example.com'] } });
    ensureSite(ctx.db, demo, { now: ctx.clock.now() });
    const s = make({ accountMonthly: { apify: 1_500_000 }, apify: { monthly: 10_000_000, perRun: 5_000_000 } });
    const demoRes = reserve('apify', 1_400_000, 'r_demo', s, { siteId: 'demo-site' });
    s.reconcile(demoRes.id, { actualMicros: 1_400_000, source: 'computed_from_usage', usage: { synthetic: true } });
    // An explicitly synthetic (fixture/sandbox) reservation of the live site itself is not counted against the account either.
    const fixture = s.reserve({ siteId: ctx.siteId, provider: 'apify', runId: 'r_fix', purpose: 'SYNTHETIC fixture run', estimate: est(1_000_000), synthetic: true });
    const account = () => s.checkLimits({ siteId: ctx.siteId, provider: 'apify', runId: 'r_live', amountMicros: 1 }).find((c) => c.scope === 'account_service_month')!;
    expect(account().committedMicros).toBe(0);
    // Without the exclusion 1.4 + 1.0 synthetic would exhaust the $1.50 cap; real spend still has the whole cap.
    expect(() => reserve('apify', 1_500_000, 'r_live', s)).not.toThrow();
    expect(scopeOf(() => reserve('apify', 1, 'r_live2', s))).toBe('account_service_month');
    // Per-site limits stay conservative: the synthetic amounts still count toward their own site's limits.
    expect(s.checkLimits({ siteId: ctx.siteId, provider: 'apify', runId: 'r_fix', amountMicros: 1 }).find((c) => c.scope === 'run')!.committedMicros).toBe(1_000_000);
    expect(s.report('demo-site').providers.find((p) => p.provider === 'apify')!.committedMicros).toBe(1_400_000);
    expect(fixture.estimatedMicros).toBe(1_000_000);
  });

  it('a zero budget allows only zero-cost reservations (free APIs)', () => {
    expect(() => reserve('pagespeed', 0)).not.toThrow();
    expect(scopeOf(() => reserve('pagespeed', 1))).toBe('run');
  });

  it('denials throw BUDGET_EXCEEDED, write nothing, and are kept in the audit log', () => {
    reserve('llm_gateway', 500_000, 'run_a');
    let err: unknown;
    try {
      reserve('llm_gateway', 1, 'run_a');
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'BUDGET_EXCEEDED', details: { scope: 'run', provider: 'llm_gateway', limitMicros: 500_000, committedMicros: 500_000, requestedMicros: 1 } });
    expect((err as { hint: string }).hint).toMatch(/No automatic budget increases/);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM budget_reservations')!.n).toBe(1);
    const denied = audits('budget.denied');
    expect(denied).toHaveLength(1);
    expect(JSON.parse(denied[0]!.details_json)).toMatchObject({ runId: 'run_a', violated: { scope: 'run' } });
  });

  it('refuses unknown prices without an approval id, and records approved ones as unknown (never $0)', () => {
    expect(code(() => reserve('apify', null))).toBe('BUDGET_UNKNOWN_PRICE');
    expect(code(() => svc.reserve({ siteId: ctx.siteId, provider: 'apify', runId: 'r', purpose: 'p', estimate: est(100, 'unknown') }))).toBe('BUDGET_UNKNOWN_PRICE');
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM budget_reservations')!.n).toBe(0);
    // Both unknown-price refusals are audited like every other denial.
    const denied = audits('budget.denied').map((d) => JSON.parse(d.details_json));
    expect(denied).toHaveLength(2);
    expect(denied[0]).toMatchObject({ reason: 'unknown_price', unknownPrice: true, unbounded: true, runId: 'run_a', purpose: 'test apify' });
    expect(denied[1]).toMatchObject({ reason: 'unknown_price', unknownPrice: true, unbounded: false, basis: { source: 'unknown' } });
    const r = reserve('apify', null, 'r', svc, { approval: 'appr_synthetic_1' });
    const row = ctx.db.get<{ cost_status: string; note: string; estimated_usd_micros: number; price_basis_json: string }>('SELECT cost_status, note, estimated_usd_micros, price_basis_json FROM budget_reservations WHERE id = ?', [r.id])!;
    expect(row.cost_status).toBe('unknown');
    expect(row.note).toMatch(/^unknown price approved by appr_synthetic_1; no upper bound/);
    expect(JSON.parse(row.price_basis_json)).toMatchObject({ source: 'verified_config', noUpperBound: true });
    const p = svc.report(ctx.siteId).providers.find((x) => x.provider === 'apify')!;
    // Not a $0 charge: counted as unknown, and the remaining budget is marked unverified.
    expect(p).toMatchObject({ unknownCount: 1, unboundedUnknownCount: 1, reservedMicros: 0, remainingVerified: false });
    const rep = svc.report(ctx.siteId);
    expect(rep.combined).toMatchObject({ unboundedUnknownCount: 1, remainingVerified: false });
    expect(rep.notes.join(' ')).toMatch(/NO upper bound/);
    expect(JSON.parse(audits('budget.reserved')[0]!.details_json)).toMatchObject({ estimatedMicros: null, unknownPrice: true, unbounded: true, approvalId: 'appr_synthetic_1' });
  });

  it('an approved unknown price with a numeric hold is recorded as unknown (not estimated) and held against every limit', () => {
    // The path real callers use: the approved maximum charge (or a provisional hold) with basis.source 'unknown'.
    const hold = svc.reserve({ siteId: ctx.siteId, provider: 'llm_gateway', runId: 'run_a', purpose: 'approved unknown', estimate: est(200_000, 'unknown'), unknownPriceApprovalId: 'appr_x' });
    const row = ctx.db.get<{ cost_status: string; estimated_usd_micros: number; note: string }>('SELECT cost_status, estimated_usd_micros, note FROM budget_reservations WHERE id = ?', [hold.id])!;
    expect(row).toMatchObject({ cost_status: 'unknown', estimated_usd_micros: 200_000 });
    expect(row.note).toMatch(/^unknown price approved by appr_x; holding the approved maximum/);
    const p = svc.report(ctx.siteId).providers.find((x) => x.provider === 'llm_gateway')!;
    expect(p).toMatchObject({ unknownCount: 1, unboundedUnknownCount: 0, reservedMicros: 200_000, committedMicros: 200_000, remainingMicros: 4_800_000, remainingVerified: true });
    // The hold counts against the per-run cap ($0.50).
    expect(scopeOf(() => reserve('llm_gateway', 300_001, 'run_a'))).toBe('run');
    expect(svc.listUnresolved(ctx.siteId)).toEqual([expect.objectContaining({ id: hold.id, cost_status: 'unknown', unbounded: false, estimated_usd_micros: 200_000 })]);
    // Reconciled with the provider-reported amount: no longer unknown.
    svc.reconcile(hold.id, { actualMicros: 150_000, source: 'gateway_reported' });
    expect(svc.report(ctx.siteId).providers.find((x) => x.provider === 'llm_gateway')).toMatchObject({ unknownCount: 0, actualMicros: 150_000, reservedMicros: 0 });
  });

  it('approved charges without an upper bound never pass a spent cap, one at a time per scope, and block unapproved requests until reconciled', () => {
    const s = make({ apify: { monthly: 1_000_000, perRun: 1_000_000 } });
    const approved = (runId: string, n: number) => () => reserve('apify', null, runId, s, { approval: `appr_${n}` });
    // The reviewer's scenario: ten approved unbounded requests against a $1.00 limit.
    const outcomes = Array.from({ length: 10 }, (_, i) => code(approved(`run_${i}`, i)) ?? 'ok');
    expect(outcomes[0]).toBe('ok');
    expect(outcomes.slice(1).every((c) => c === 'BUDGET_UNKNOWN_PRICE')).toBe(true);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM budget_reservations WHERE provider = 'apify'")!.n).toBe(1);
    // While it is outstanding the cap cannot be verified: an unapproved known-price request is refused ...
    let err: unknown;
    try {
      reserve('apify', 100_000, 'run_x', s);
    } catch (e) {
      err = e;
    }
    // (a different run id, so the first unverifiable scope is the site's monthly Apify limit)
    expect(err).toMatchObject({ code: 'BUDGET_UNKNOWN_PRICE', details: { scope: 'site_service_month', unboundedUnknownCount: 1 } });
    expect((err as { hint: string }).hint).toMatch(/costs --unresolved/);
    // ... the combined ceiling is unverifiable too, so other providers of the same site also need approval ...
    expect(code(() => reserve('llm_gateway', 10_000, 'run_y', s))).toBe('BUDGET_UNKNOWN_PRICE');
    // ... while an explicitly approved known-price request is still checked against the numeric limits.
    expect(() => s.reserve({ siteId: ctx.siteId, provider: 'apify', runId: 'run_z', purpose: 'approved', estimate: est(100_000), unknownPriceApprovalId: 'appr_known' })).not.toThrow();
    expect(scopeOf(() => s.reserve({ siteId: ctx.siteId, provider: 'apify', runId: 'run_w', purpose: 'approved too big', estimate: est(950_000), unknownPriceApprovalId: 'appr_big' }))).toBe('site_service_month');
    expect(audits('budget.denied').length).toBeGreaterThanOrEqual(11);
    // Reconciling the unbounded charge records its real amount (no fake overshoot) and reopens normal checks.
    const open = s.listUnresolved(ctx.siteId).find((o) => o.unbounded)!;
    expect(s.reconcile(open.id, { actualMicros: 300_000, source: 'provider_reported' })).toEqual({ status: 'reconciled', overshootMicros: 0 });
    expect(s.report(ctx.siteId).providers.find((p) => p.provider === 'apify')).toMatchObject({ actualMicros: 300_000, reservedMicros: 100_000, unboundedUnknownCount: 0, remainingMicros: 600_000, remainingVerified: true });
    expect(() => reserve('llm_gateway', 10_000, 'run_y', s)).not.toThrow();
  });

  it('an approved charge without an upper bound is refused when a limit has no room left (including zero budgets)', () => {
    const s = make({ apify: { monthly: 1_000_000, perRun: 1_000_000 } });
    reserve('apify', 1_000_000, 'r1', s);
    expect(scopeOf(() => reserve('apify', null, 'r2', s, { approval: 'appr_full' }))).toBe('site_service_month');
    expect(scopeOf(() => reserve('pagespeed', null, 'r3', s, { approval: 'appr_zero' }))).toBe('run');
    // An unresolved unbounded charge keeps its scopes unverifiable until a real amount is reported.
    const u = reserve('llm_gateway', null, 'r4', s, { approval: 'appr_llm' });
    expect(s.reconcile(u.id, { actualMicros: null, source: 'gateway_reported' })).toEqual({ status: 'unresolved', overshootMicros: 0 });
    expect(s.report(ctx.siteId).providers.find((p) => p.provider === 'llm_gateway')).toMatchObject({ unknownCount: 1, unboundedUnknownCount: 1, remainingVerified: false });
    expect(code(() => reserve('llm_gateway', 1_000, 'r5', s))).toBe('BUDGET_UNKNOWN_PRICE');
  });

  it('rejects invalid estimates', () => {
    expect(() => reserve('apify', -1)).toThrow(RangeError);
    expect(() => reserve('apify', 1.5)).toThrow(RangeError);
  });
});

describe('reconcile input validation', () => {
  it('rejects fractional, negative, and unsafe actual amounts without writing anything (integer micros only)', () => {
    const r = reserve('apify', 400_000);
    for (const bad of [1.5, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => svc.reconcile(r.id, { actualMicros: bad, source: 'manual' })).toThrow(RangeError);
    }
    expect(ctx.db.get('SELECT status, actual_usd_micros FROM budget_reservations WHERE id = ?', [r.id])).toEqual({ status: 'reserved', actual_usd_micros: null });
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_ledger')!.n).toBe(0);
    expect(svc.reconcile(r.id, { actualMicros: 0, source: 'provider_reported' }).status).toBe('reconciled');
    expect(ctx.db.get<{ t: string }>('SELECT typeof(actual_usd_micros) AS t FROM budget_reservations WHERE id = ?', [r.id])!.t).toBe('integer');
  });
});

describe('reconcile / release / markUnresolved', () => {
  it('reconciles actual cost below the estimate: committed spend drops to the actual', () => {
    const r = reserve('llm_gateway', 400_000);
    expect(svc.reconcile(r.id, { actualMicros: 150_000, source: 'gateway_reported', usage: { prompt_tokens: 10 } })).toEqual({ status: 'reconciled', overshootMicros: 0 });
    const p = svc.report(ctx.siteId).providers.find((x) => x.provider === 'llm_gateway')!;
    expect(p).toMatchObject({ actualMicros: 150_000, reservedMicros: 0, committedMicros: 150_000 });
    const ledger = ctx.db.all('SELECT amount_usd_micros, amount_status, source FROM cost_ledger');
    expect(ledger).toEqual([{ amount_usd_micros: 150_000, amount_status: 'actual', source: 'gateway_reported' }]);
    expect(() => reserve('llm_gateway', 350_000)).not.toThrow(); // run cap freed by the lower actual
  });

  it('records overshoot truthfully when the actual exceeds the estimate (price change)', () => {
    const r = reserve('apify', 400_000);
    expect(svc.reconcile(r.id, { actualMicros: 700_000, source: 'provider_reported' })).toEqual({ status: 'reconciled', overshootMicros: 300_000 });
    const usage = JSON.parse(ctx.db.get<{ usage_json: string }>('SELECT usage_json FROM cost_ledger')!.usage_json);
    expect(usage).toMatchObject({ overshootMicros: 300_000, estimatedMicros: 400_000 });
    expect(JSON.parse(audits('budget.reconciled')[0]!.details_json)).toMatchObject({ overshootMicros: 300_000 });
    // Later reservations see the higher actual, not the stale estimate.
    const check = svc.checkLimits({ siteId: ctx.siteId, provider: 'apify', runId: 'run_a', amountMicros: 400_000 });
    expect(check.find((c) => c.scope === 'run')).toMatchObject({ committedMicros: 700_000 });
    expect(scopeOf(() => reserve('apify', 400_000))).toBe('run');
  });

  it('unknown actual cost stays reserved at its estimate (unresolved), never $0', () => {
    const r = reserve('dataforseo', 300_000);
    expect(svc.reconcile(r.id, { actualMicros: null, source: 'provider_reported' })).toEqual({ status: 'unresolved', overshootMicros: 0 });
    expect(ctx.db.get('SELECT status, cost_status, actual_usd_micros FROM budget_reservations WHERE id = ?', [r.id])).toEqual({ status: 'unresolved', cost_status: 'unknown', actual_usd_micros: null });
    expect(ctx.db.all('SELECT amount_usd_micros, amount_status FROM cost_ledger')).toEqual([{ amount_usd_micros: null, amount_status: 'unknown' }]);
    const p = svc.report(ctx.siteId).providers.find((x) => x.provider === 'dataforseo')!;
    expect(p).toMatchObject({ actualMicros: 0, reservedMicros: 300_000, unknownCount: 1, committedMicros: 300_000 });
    expect(svc.listUnresolved(ctx.siteId).map((u) => u.id)).toEqual([r.id]);
    // Later provider-reported usage resolves it.
    svc.reconcile(r.id, { actualMicros: 250_000, source: 'provider_reported' });
    expect(svc.report(ctx.siteId).providers.find((x) => x.provider === 'dataforseo')).toMatchObject({ actualMicros: 250_000, unknownCount: 0 });
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_ledger')!.n).toBe(1);
  });

  it('release frees only reservations that were never submitted', () => {
    const r = reserve('apify', 900_000);
    svc.release(r.id, 'cache hit');
    expect(ctx.db.get('SELECT status, note FROM budget_reservations WHERE id = ?', [r.id])).toEqual({ status: 'released', note: 'cache hit' });
    expect(svc.report(ctx.siteId).providers.find((x) => x.provider === 'apify')!.committedMicros).toBe(0);
    expect(code(() => svc.release(r.id, 'again'))).toBe('CONFLICT');
    expect(code(() => svc.reconcile(r.id, { actualMicros: 1, source: 'manual' }))).toBe('CONFLICT');
    const done = reserve('apify', 100_000);
    svc.reconcile(done.id, { actualMicros: 100_000, source: 'manual' });
    expect(code(() => svc.release(done.id, 'x'))).toBe('CONFLICT');
    const amb = reserve('apify', 100_000);
    svc.markUnresolved(amb.id, 'timeout after POST');
    expect(code(() => svc.release(amb.id, 'x'))).toBe('CONFLICT');
    expect(code(() => svc.release('res_missing', 'x'))).toBe('NOT_FOUND');
    expect(code(() => svc.reconcile('res_missing', { actualMicros: 1, source: 'manual' }))).toBe('NOT_FOUND');
    expect(audits('budget.released')).toHaveLength(1);
  });

  it('markUnresolved keeps the full estimate counted and is a no-op once the outcome is known', () => {
    const r = reserve('apify', 600_000);
    svc.markUnresolved(r.id, 'timeout after submit');
    expect(ctx.db.get('SELECT status, cost_status, note FROM budget_reservations WHERE id = ?', [r.id])).toEqual({ status: 'unresolved', cost_status: 'unknown', note: 'timeout after submit' });
    expect(svc.report(ctx.siteId).providers.find((x) => x.provider === 'apify')).toMatchObject({ reservedMicros: 600_000, unknownCount: 1 });
    expect(audits('budget.unresolved')).toHaveLength(1);
    const ok = reserve('apify', 100_000, 'run_b');
    svc.reconcile(ok.id, { actualMicros: 90_000, source: 'manual' });
    svc.markUnresolved(ok.id, 'late timeout');
    expect(ctx.db.get<{ status: string }>('SELECT status FROM budget_reservations WHERE id = ?', [ok.id])!.status).toBe('reconciled');
    expect(() => svc.markUnresolved('res_missing', 'x')).not.toThrow();
  });

  it('never double counts a provider request in the cost ledger', () => {
    const requests = new ProviderRequestLog(ctx.db);
    const preq = requests.prepare({ siteId: ctx.siteId, provider: 'apify', endpoint: 'actor-runs', method: 'POST', isPaid: true, params: { maxItems: 5 } });
    const r = reserve('apify', 500_000);
    svc.attachRequest(r.id, preq.id);
    svc.reconcile(r.id, { actualMicros: 200_000, source: 'provider_reported' });
    svc.reconcile(r.id, { actualMicros: 210_000, source: 'provider_reported', providerRequestId: preq.id });
    expect(ctx.db.all('SELECT provider_request_id, amount_usd_micros FROM cost_ledger')).toEqual([{ provider_request_id: preq.id, amount_usd_micros: 210_000 }]);
    // Without any provider request id, re-reconciling one reservation also updates its single entry.
    const r2 = reserve('apify', 100_000, 'run_b');
    svc.reconcile(r2.id, { actualMicros: null, source: 'manual' });
    svc.reconcile(r2.id, { actualMicros: 80_000, source: 'manual' });
    expect(ctx.db.all('SELECT amount_usd_micros, amount_status FROM cost_ledger WHERE reservation_id = ?', [r2.id])).toEqual([{ amount_usd_micros: 80_000, amount_status: 'actual' }]);
    expect(svc.report(ctx.siteId).providers.find((x) => x.provider === 'apify')!.actualMicros).toBe(290_000);
  });
});

describe('report', () => {
  it('keeps actual, reserved, estimated, and unknown amounts separate', () => {
    const a = reserve('dataforseo', 200_000, 'r1');
    svc.reconcile(a.id, { actualMicros: 150_000, source: 'provider_reported' });
    reserve('dataforseo', 300_000, 'r2');
    const c = reserve('dataforseo', 100_000, 'r3');
    svc.markUnresolved(c.id, 'ambiguous');
    const d = reserve('dataforseo', 50_000, 'r4');
    svc.release(d.id, 'validation failed before submit');
    const rep = svc.report(ctx.siteId);
    expect(rep).toMatchObject({ siteId: ctx.siteId, periodMonth: '2026-09', periodWeek: '2026-W39', timeZone: 'Europe/Tallinn' });
    const p = rep.providers.find((x) => x.provider === 'dataforseo')!;
    expect(p).toEqual({
      provider: 'dataforseo',
      actualMicros: 150_000,
      reservedMicros: 400_000,
      estimatedMicros: 0,
      unknownCount: 1,
      unboundedUnknownCount: 0,
      committedMicros: 550_000,
      limitMicros: 10_000_000,
      remainingMicros: 9_450_000,
      remainingVerified: true,
      weekly: { committedMicros: 550_000, limitMicros: 1_000_000, remainingMicros: 450_000 },
    });
    expect(rep.providers.map((x) => x.provider)).toEqual(['llm_gateway', 'dataforseo', 'apify', 'pagespeed']);
    expect(rep.combined).toEqual({ committedMicros: 550_000, limitMicros: 25_000_000, remainingMicros: 24_450_000, unboundedUnknownCount: 0, remainingVerified: true });
    // Provenance: the reconciled amount was provider-reported; nothing is computed or synthetic.
    expect(rep.costBasis.find((b) => b.provider === 'dataforseo')).toEqual({ provider: 'dataforseo', reportedMicros: 150_000, computedMicros: 0, computedCount: 0, fixedZeroCount: 0, syntheticMicros: 0, syntheticCount: 0 });
    expect(rep.costBasis.map((b) => b.provider)).toEqual(['llm_gateway', 'dataforseo', 'apify', 'pagespeed']);
    expect(rep).toMatchObject({ synthetic: false, containsSynthetic: false });
    expect(rep.notes).toHaveLength(3);
    expect(rep.notes.join(' ')).toMatch(/not price quotes/);
    expect(rep.notes.join(' ')).toMatch(/cannot guarantee zero overshoot/);
  });

  it('never reports negative remaining budget after an overshoot', () => {
    const r = reserve('apify', 1_000_000);
    svc.reconcile(r.id, { actualMicros: 12_000_000, source: 'provider_reported' });
    expect(svc.report(ctx.siteId).providers.find((x) => x.provider === 'apify')).toMatchObject({ committedMicros: 12_000_000, remainingMicros: 0 });
  });
});

describe('cost provenance (B2-03) and synthetic flags (B1-03)', () => {
  const reservationRow = (id: string) => ctx.db.get<{ status: string; cost_status: string; cost_basis: string | null; is_synthetic: number }>('SELECT status, cost_status, cost_basis, is_synthetic FROM budget_reservations WHERE id = ?', [id])!;
  const ledgerRow = (id: string) => ctx.db.get<{ amount_status: string; source: string; is_synthetic: number }>('SELECT amount_status, source, is_synthetic FROM cost_ledger WHERE reservation_id = ?', [id])!;

  it('an amount computed from usage at list price is recorded with its basis and reported apart from provider-reported spend, yet counts toward the limits', () => {
    const computed = reserve('llm_gateway', 300_000, 'run_c');
    svc.reconcile(computed.id, { actualMicros: 210, source: 'computed_from_usage', usage: { prompt_tokens: 1000, completion_tokens: 100 } });
    const reported = reserve('llm_gateway', 300_000, 'run_r');
    svc.reconcile(reported.id, { actualMicros: 150_000, source: 'gateway_reported' });
    expect(reservationRow(computed.id)).toMatchObject({ status: 'reconciled', cost_status: 'actual', cost_basis: 'computed_from_usage' });
    expect(reservationRow(reported.id)).toMatchObject({ cost_basis: 'gateway_reported' });
    expect(ledgerRow(computed.id)).toMatchObject({ amount_status: 'actual', source: 'computed_from_usage' });

    const rep = svc.report(ctx.siteId);
    // Backward compatible: actualMicros still holds every reconciled amount ...
    expect(rep.providers.find((p) => p.provider === 'llm_gateway')).toMatchObject({ actualMicros: 150_210, committedMicros: 150_210 });
    // ... and the cost basis splits it: the computed part is never presented as provider-reported.
    expect(rep.costBasis.find((b) => b.provider === 'llm_gateway')).toMatchObject({ reportedMicros: 150_000, computedMicros: 210, computedCount: 1 });
    const note = rep.notes.find((n) => n.startsWith('Computed, not provider-reported'));
    expect(note).toContain('llm_gateway $0.00021 (1 request(s))');
    expect(note).toContain('computed from usage at list price, not provider-reported');
    expect(note).toContain('count toward the limits');
    // Still counted toward the limits.
    expect(svc.checkLimits({ siteId: ctx.siteId, provider: 'llm_gateway', runId: 'run_c', amountMicros: 1 }).find((c) => c.scope === 'run')).toMatchObject({ committedMicros: 210 });

    // A later provider report replaces the computed basis (one ledger entry, no double count).
    svc.reconcile(computed.id, { actualMicros: 250, source: 'gateway_reported' });
    expect(reservationRow(computed.id).cost_basis).toBe('gateway_reported');
    expect(svc.report(ctx.siteId).costBasis.find((b) => b.provider === 'llm_gateway')).toMatchObject({ reportedMicros: 150_250, computedMicros: 0, computedCount: 0 });
    expect(svc.report(ctx.siteId).notes.some((n) => n.startsWith('Computed'))).toBe(false);
    // An unknown amount has no basis: it stays unresolved and reserved, never $0.
    const unknown = reserve('llm_gateway', 40_000, 'run_u');
    svc.reconcile(unknown.id, { actualMicros: null, source: 'computed_from_usage' });
    expect(reservationRow(unknown.id)).toMatchObject({ status: 'unresolved', cost_status: 'unknown', cost_basis: null });
  });

  it('a free sandbox/fixture request settled at a verified $0 is a fixed zero, never counted as computed from usage at list price (C5-07)', () => {
    const fixedZero = { upperBoundMicros: 0, basis: { source: 'fixed_zero' as const, detail: 'DataForSEO sandbox/fixture: free, synthetic data (synthetic test)' } };
    // Two sandbox/fixture requests (the reconcile source is computed_from_usage, as the DataForSEO sandbox path records it) ...
    for (const runId of ['run_s1', 'run_s2']) {
      const r = svc.reserve({ siteId: ctx.siteId, provider: 'dataforseo', runId, purpose: '[SYNTHETIC sandbox] SERP research', estimate: fixedZero, synthetic: true });
      svc.reconcile(r.id, { actualMicros: 0, source: 'computed_from_usage', usage: { synthetic: true, mode: 'sandbox', priceBasis: 'fixed_zero' } });
    }
    // ... and one amount really computed from usage at list price.
    const computed = reserve('dataforseo', 20_000, 'run_c');
    svc.reconcile(computed.id, { actualMicros: 600, source: 'computed_from_usage', usage: { tasks: 1 } });
    // A real (non-synthetic, not fixed-zero) request computed at $0 is still a computed amount.
    const zeroComputed = reserve('dataforseo', 20_000, 'run_z');
    svc.reconcile(zeroComputed.id, { actualMicros: 0, source: 'computed_from_usage', usage: { tasks: 1 } });

    const rep = svc.report(ctx.siteId);
    expect(rep.costBasis.find((b) => b.provider === 'dataforseo')).toEqual({ provider: 'dataforseo', reportedMicros: 0, computedMicros: 600, computedCount: 2, fixedZeroCount: 2, syntheticMicros: 0, syntheticCount: 2 });
    const computedNote = rep.notes.find((n) => n.startsWith('Computed, not provider-reported'))!;
    expect(computedNote).toContain('dataforseo $0.0006 (2 request(s))');
    expect(rep.notes.find((n) => n.startsWith('Fixed zero, not computed'))).toBe(
      'Fixed zero, not computed: dataforseo 2 request(s) were free sandbox or fixture requests settled at a verified $0 (price basis fixed_zero). They were not computed from usage at list price and were not charged.',
    );
    // Only fixed zeros: no "computed" note at all, and the amounts are unchanged ($0 actual).
    ctx.db.run('DELETE FROM budget_reservations WHERE id IN (?, ?)', [computed.id, zeroComputed.id]);
    const only = svc.report(ctx.siteId);
    expect(only.notes.some((n) => n.startsWith('Computed'))).toBe(false);
    expect(only.costBasis.find((b) => b.provider === 'dataforseo')).toMatchObject({ computedCount: 0, computedMicros: 0, fixedZeroCount: 2 });
    expect(only.providers.find((p) => p.provider === 'dataforseo')).toMatchObject({ actualMicros: 0, committedMicros: 0 });
  });

  it('manual reconciliation records the manual basis (entered from the provider history), not computed', () => {
    const r = reserve('apify', 100_000);
    svc.markUnresolved(r.id, 'timeout after submit');
    svc.reconcileManual(r.id, { actualMicros: 80_000, evidence: 'provider billing page shows $0.08 (synthetic test)', by: 'Alice' });
    expect(reservationRow(r.id)).toMatchObject({ cost_basis: 'manual', cost_status: 'actual' });
    expect(svc.report(ctx.siteId).costBasis.find((b) => b.provider === 'apify')).toMatchObject({ reportedMicros: 80_000, computedMicros: 0 });
  });

  it('synthetic reservations (explicit flag or a synthetic provider request) are flagged with their ledger entries, labeled, and still counted', () => {
    const flagged = svc.reserve({ siteId: ctx.siteId, provider: 'dataforseo', runId: 'run_s', purpose: 'SYNTHETIC fixture task', estimate: est(20_000), synthetic: true });
    expect(reservationRow(flagged.id).is_synthetic).toBe(1);
    svc.reconcile(flagged.id, { actualMicros: 15_000, source: 'computed_from_usage' });
    expect(ledgerRow(flagged.id).is_synthetic).toBe(1);

    // A sandbox/fixture provider request flags the reservation it is attached to (as the DataForSEO sandbox path does).
    const requests = new ProviderRequestLog(ctx.db, ctx.clock);
    const preq = requests.prepare({ siteId: ctx.siteId, provider: 'dataforseo', endpoint: 'serp/task_post', method: 'POST', isPaid: false, params: { synthetic: true }, isSynthetic: true });
    const viaRequest = reserve('dataforseo', 10_000, 'run_t');
    expect(reservationRow(viaRequest.id).is_synthetic).toBe(0);
    svc.attachRequest(viaRequest.id, preq.id);
    expect(reservationRow(viaRequest.id).is_synthetic).toBe(1);
    svc.reconcile(viaRequest.id, { actualMicros: 0, source: 'computed_from_usage', providerRequestId: preq.id });
    expect(ledgerRow(viaRequest.id).is_synthetic).toBe(1);

    // A real (non-synthetic) reservation stays unflagged.
    const live = reserve('dataforseo', 30_000, 'run_l');
    svc.reconcile(live.id, { actualMicros: 25_000, source: 'provider_reported' });
    expect(reservationRow(live.id).is_synthetic).toBe(0);
    expect(ledgerRow(live.id).is_synthetic).toBe(0);

    const rep = svc.report(ctx.siteId);
    expect(rep).toMatchObject({ synthetic: false, containsSynthetic: true });
    expect(rep.costBasis.find((b) => b.provider === 'dataforseo')).toMatchObject({ syntheticMicros: 15_000, syntheticCount: 2, reportedMicros: 25_000, computedMicros: 15_000 });
    // Synthetic amounts are labeled [SYNTHETIC] (never shown as DATA_UNAVAILABLE) and still counted toward the limits.
    expect(rep.notes.find((n) => n.startsWith('[SYNTHETIC]'))).toMatch(/dataforseo \$0\.015 \(2 reservation\(s\)\).*no real charge/);
    expect(rep.providers.find((p) => p.provider === 'dataforseo')).toMatchObject({ actualMicros: 40_000, committedMicros: 40_000 });
  });

  it('a demo site reports every amount as SYNTHETIC DEMO DATA with no real charges', () => {
    const demo = parseSiteConfig({ profile: 'demo', site: { id: 'demo-site', businessName: 'Demo Co (synthetic)', url: 'https://www.example.com/', allowedHostnames: ['www.example.com'] } });
    ensureSite(ctx.db, demo, { now: ctx.clock.now() });
    const r = reserve('dataforseo', 2_000, 'run_demo', svc, { siteId: 'demo-site' });
    expect(reservationRow(r.id).is_synthetic).toBe(1);
    svc.reconcile(r.id, { actualMicros: 1_500, source: 'computed_from_usage' });
    expect(ledgerRow(r.id).is_synthetic).toBe(1);
    const rep = svc.report('demo-site');
    expect(rep).toMatchObject({ synthetic: true, containsSynthetic: true });
    expect(rep.notes[0]).toMatch(/^SYNTHETIC DEMO DATA: no real charges\./);
    expect(rep.notes.some((n) => n.startsWith('[SYNTHETIC]'))).toBe(false); // the demo banner already covers every amount
    // The live test site is unaffected.
    expect(svc.report(ctx.siteId)).toMatchObject({ synthetic: false, containsSynthetic: false });
  });
});

describe('budget periods use the budget time zone', () => {
  it('the same instant belongs to different months in different zones', () => {
    ctx.clock.set('2026-10-01T05:00:00.000Z'); // Sep 30 22:00 in Los Angeles, Oct 1 08:00 in Tallinn
    const la = make({}, 'America/Los_Angeles');
    const tallinn = make({}, 'Europe/Tallinn');
    expect(la.periods()).toEqual({ month: '2026-09', week: '2026-W40' });
    expect(tallinn.periods()).toEqual({ month: '2026-10', week: '2026-W40' });
    const r = reserve('apify', 1_000_000, 'r1', la);
    expect(r.periodMonth).toBe('2026-09');
  });

  it('a monthly cap resets at local midnight of the budget zone, not UTC', () => {
    const la = make({ apify: { monthly: 1_000_000, perRun: 1_000_000 } }, 'America/Los_Angeles');
    ctx.clock.set('2026-10-01T06:59:00.000Z'); // Sep 30 23:59 PDT
    reserve('apify', 1_000_000, 'r1', la);
    expect(scopeOf(() => reserve('apify', 1, 'r2', la))).toBe('site_service_month');
    ctx.clock.set('2026-10-01T07:00:00.000Z'); // Oct 1 00:00 PDT
    expect(reserve('apify', 1_000_000, 'r3', la).periodMonth).toBe('2026-10');
  });
});

describe('ProviderRequestLog', () => {
  it('tracks the paid submission lifecycle and finds open duplicates and ambiguous submissions', () => {
    const log = new ProviderRequestLog(ctx.db);
    const params = { keyword: 'synthetic', api_key: 'should-not-affect-hash' };
    const a = log.prepare({ siteId: ctx.siteId, provider: 'dataforseo', endpoint: 'serp/task_post', method: 'POST', isPaid: true, params, idempotencyKey: 'k1', isSynthetic: true });
    const b = log.prepare({ siteId: ctx.siteId, provider: 'dataforseo', endpoint: 'serp/task_post', method: 'POST', isPaid: true, params: { ...params, api_key: 'different' } });
    expect(a.requestHash).toBe(b.requestHash); // hashes are over redacted params
    log.markSubmitted(a.id);
    log.setExternalId(a.id, 'task-123');
    expect(log.findOpenDuplicates(ctx.siteId, 'dataforseo', 'serp/task_post', a.requestHash).map((r) => r.id)).toEqual([a.id, b.id]);
    log.complete(a.id, { status: 'ambiguous', error: new Error('socket hang up with Bearer abcdefghijklmnop') });
    const row = log.get(a.id)!;
    expect(row).toMatchObject({ status: 'ambiguous', external_id: 'task-123', is_paid: 1 });
    expect(JSON.parse((row as unknown as { error_json: string }).error_json)).toEqual({ name: 'Error', message: `socket hang up with Bearer ${REDACTED}` });
    expect(log.listAmbiguous(ctx.siteId).map((r) => r.id)).toEqual([a.id]);
    log.complete(b.id, { status: 'succeeded', httpStatus: 200, externalId: 'task-456' });
    expect(log.get(b.id)).toMatchObject({ status: 'succeeded', external_id: 'task-456' });
    expect(log.findOpenDuplicates(ctx.siteId, 'dataforseo', 'serp/task_post', a.requestHash).map((r) => r.id)).toEqual([a.id]);
  });
});
