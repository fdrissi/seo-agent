/**
 * Cost provenance and synthetic labeling (B2-03, B1-03), SYNTHETIC amounts only:
 * - an amount computed from usage at list price (reconcile source
 *   computed_from_usage) is never shown as a provider-reported charge in
 *   `costs` (text and JSON), the dashboard, `data export costs`, or the
 *   report's Spend notes; it still counts toward the limits;
 * - in a demo workspace `costs` prints "SYNTHETIC DEMO DATA: no real charges"
 *   and `synthetic: true` in JSON.
 */
import { Command, CommanderError } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import type { BudgetService } from '../../../src/budgets/budget-service.js';
import { ProviderRequestLog } from '../../../src/budgets/provider-requests.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { register as registerCosts, renderSpend } from '../../../src/cli/commands/costs.js';
import { exportDataset, formatExport } from '../../../src/data/export.js';
import { buildDashboard } from '../../../src/reports/dashboard.js';
import { buildWeeklyReport } from '../../../src/reports/build.js';
import { allClaims } from '../../../src/reports/model.js';
import { createTestContext, testSiteConfig, type TestContext } from '../../helpers/context.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const NOW = '2026-09-24T09:00:00.000Z';
const COMPUTED = 'computed from usage at list price, not provider-reported';

async function runCli(root: string, args: string[]): Promise<{ out: string; err: string; json: any; failed: boolean }> {
  let out = '';
  let err = '';
  const cli = new CliRuntime({ out: (t) => (out += `${t}\n`), err: (t) => (err += `${t}\n`) }, { ...process.env, SEO_AGENT_WORKSPACE: root });
  const program = new Command();
  program.exitOverride().option('-w, --workspace <dir>').option('-s, --site <id>').option('--dry-run').option('--json').option('--mode <mode>').option('--offline').configureOutput({ writeErr: (x) => (err += x), writeOut: (x) => (out += x) });
  registerCosts(program, cli);
  let failed = false;
  const prevExit = process.exitCode;
  try {
    await program.parseAsync(['node', 'seo-agent', '--workspace', root, '--offline', ...args]);
  } catch (e) {
    if (!(e instanceof CliExit) && !(e instanceof CommanderError)) throw e;
    failed = true;
  } finally {
    if (process.exitCode) failed = true;
    process.exitCode = prevExit;
  }
  let json: any = null;
  try {
    json = JSON.parse(out);
  } catch {
    json = null;
  }
  return { out, err, json, failed };
}

/** A live (core) site with one gateway-reported and one usage-computed LLM charge. */
function liveWithComputedCharge(t: TestContext): { computedId: string; reportedId: string } {
  const budgets = t.budgets as BudgetService;
  const est = { upperBoundMicros: 300_000, basis: { source: 'verified_config' as const, detail: 'synthetic test price' } };
  const computed = budgets.reserve({ siteId: t.siteId, provider: 'llm_gateway', runId: 'run_c', purpose: 'SYNTHETIC chat call (no gateway cost reported)', estimate: est });
  budgets.reconcile(computed.id, { actualMicros: 210, source: 'computed_from_usage', usage: { prompt_tokens: 1000, completion_tokens: 100 } });
  const reported = budgets.reserve({ siteId: t.siteId, provider: 'llm_gateway', runId: 'run_r', purpose: 'SYNTHETIC chat call (gateway cost reported)', estimate: est });
  budgets.reconcile(reported.id, { actualMicros: 150_000, source: 'gateway_reported' });
  return { computedId: computed.id, reportedId: reported.id };
}

describe('costs: computed-from-usage amounts are shown apart from provider-reported spend', () => {
  it('text: separate reported and computed columns, a computed line, the legend, and the report note; JSON: costBasis and synthetic false', async () => {
    ctx = createTestContext({ now: NOW });
    liveWithComputedCharge(ctx);
    const text = await runCli(ctx.paths.root, ['costs']);
    expect(text.failed).toBe(false);
    expect(text.out).toContain('provider      reported   computed   reserved');
    const llmLine = text.out.split('\n').find((l) => l.startsWith('llm_gateway'))!;
    // reported $0.15, computed $0.00021 (never folded into the reported column)
    expect(llmLine).toMatch(/^llm_gateway\s+\$0\.15\s+\$0\.00021\s+\$0\.00\s/);
    expect(text.out).toContain(`  computed: $0.00021 over 1 request(s), ${COMPUTED}`);
    expect(text.out).toContain('Actual spend = reported + computed.');
    expect(text.out).toMatch(/Note: Computed, not provider-reported: llm_gateway \$0\.00021 \(1 request\(s\)\)/);
    expect(text.out).not.toContain('SYNTHETIC DEMO DATA');

    const json = (await runCli(ctx.paths.root, ['--json', 'costs'])).json;
    expect(json).toMatchObject({ synthetic: false, containsSynthetic: false });
    // actualMicros keeps its meaning (all reconciled amounts); costBasis splits it.
    expect(json.providers.find((p: { provider: string }) => p.provider === 'llm_gateway')).toMatchObject({ actualMicros: 150_210, committedMicros: 150_210 });
    expect(json.costBasis.find((b: { provider: string }) => b.provider === 'llm_gateway')).toEqual({ provider: 'llm_gateway', reportedMicros: 150_000, computedMicros: 210, computedCount: 1, fixedZeroCount: 0, syntheticMicros: 0, syntheticCount: 0 });
    expect(json.notes.some((n: string) => n.includes(COMPUTED))).toBe(true);
  });

  it('data export costs: amount_basis "computed" and the is_synthetic column', () => {
    ctx = createTestContext({ now: NOW });
    const { computedId, reportedId } = liveWithComputedCharge(ctx);
    const requests = new ProviderRequestLog(ctx.db, ctx.clock);
    const preq = requests.prepare({ siteId: ctx.siteId, provider: 'dataforseo', endpoint: 'serp/task_post', method: 'POST', isPaid: false, params: { synthetic: true }, isSynthetic: true });
    const sandbox = ctx.budgets.reserve({ siteId: ctx.siteId, provider: 'dataforseo', runId: 'run_s', purpose: '[SYNTHETIC sandbox] task', estimate: { upperBoundMicros: 0, basis: { source: 'fixed_zero', detail: 'sandbox' } } });
    ctx.budgets.attachRequest(sandbox.id, preq.id);
    ctx.budgets.reconcile(sandbox.id, { actualMicros: 0, source: 'computed_from_usage', providerRequestId: preq.id });
    const unresolved = ctx.budgets.reserve({ siteId: ctx.siteId, provider: 'apify', runId: 'run_u', purpose: 'SYNTHETIC run (timed out)', estimate: { upperBoundMicros: 100_000, basis: { source: 'verified_config', detail: 'synthetic' } } });
    ctx.budgets.reconcile(unresolved.id, { actualMicros: null, source: 'provider_reported' });

    const r = exportDataset(ctx, 'costs');
    expect(r.columns).toEqual(['id', 'provider', 'reservation_id', 'provider_request_id', 'amount_usd_micros', 'amount_status', 'amount_basis', 'source', 'usage_json', 'period_month', 'period_week', 'recorded_at', 'is_synthetic']);
    const byReservation = new Map(r.rows.map((x) => [x.reservation_id, x]));
    expect(byReservation.get(computedId)).toMatchObject({ amount_usd_micros: 210, amount_status: 'actual', amount_basis: 'computed', source: 'computed_from_usage', is_synthetic: 0 });
    expect(byReservation.get(reportedId)).toMatchObject({ amount_status: 'actual', amount_basis: 'actual', source: 'gateway_reported', is_synthetic: 0 });
    // C5-07: a free sandbox request settled at a verified $0 is a fixed zero, never "computed from usage at list price".
    expect(byReservation.get(sandbox.id)).toMatchObject({ amount_usd_micros: 0, amount_status: 'actual', amount_basis: 'fixed_zero', is_synthetic: 1 });
    // Unknown stays unknown (empty, never $0).
    expect(byReservation.get(unresolved.id)).toMatchObject({ amount_usd_micros: null, amount_status: 'unknown', amount_basis: 'unknown' });
    expect(r.containsSynthetic).toBe(true);
    expect(r.notes.join(' ')).toContain(`amount_basis "computed": the amount was ${COMPUTED}`);
    expect(r.notes.join(' ')).toContain('is_synthetic 1');
    expect(r.notes.join(' ')).toContain('amount_basis "fixed_zero": a free sandbox or fixture request settled at a verified $0');
    const csv = formatExport(r, 'csv').split(/\r?\n/);
    expect(csv[0]).toBe('id,provider,reservation_id,provider_request_id,amount_usd_micros,amount_status,amount_basis,source,usage_json,period_month,period_week,recorded_at,is_synthetic');
  });

  it('free sandbox/fixture requests settled at a verified $0 are never counted as "computed from usage at list price" (C5-07)', async () => {
    ctx = createTestContext({ now: NOW });
    liveWithComputedCharge(ctx);
    const requests = new ProviderRequestLog(ctx.db, ctx.clock);
    for (const runId of ['run_s1', 'run_s2', 'run_s3']) {
      const preq = requests.prepare({ siteId: ctx.siteId, provider: 'llm_gateway', endpoint: 'chat/completions', method: 'POST', isPaid: false, params: { synthetic: true, runId }, isSynthetic: true });
      const r = ctx.budgets.reserve({ siteId: ctx.siteId, provider: 'llm_gateway', runId, purpose: '[SYNTHETIC fixture] chat call', estimate: { upperBoundMicros: 0, basis: { source: 'fixed_zero', detail: 'fixture: free (synthetic)' } } });
      ctx.budgets.attachRequest(r.id, preq.id);
      ctx.budgets.reconcile(r.id, { actualMicros: 0, source: 'computed_from_usage', usage: { synthetic: true, mode: 'fixture', priceBasis: 'fixed_zero' }, providerRequestId: preq.id });
    }
    const text = await runCli(ctx.paths.root, ['costs']);
    expect(text.failed).toBe(false);
    // The computed line and the report note count only the one request that was really computed.
    expect(text.out).toContain(`  computed: $0.00021 over 1 request(s), ${COMPUTED}`);
    expect(text.out).toMatch(/Note: Computed, not provider-reported: llm_gateway \$0\.00021 \(1 request\(s\)\)/);
    expect(text.out).toContain('Note: Fixed zero, not computed: llm_gateway 3 request(s) were free sandbox or fixture requests settled at a verified $0');
    const json = (await runCli(ctx.paths.root, ['--json', 'costs'])).json;
    expect(json.costBasis.find((b: { provider: string }) => b.provider === 'llm_gateway')).toEqual({ provider: 'llm_gateway', reportedMicros: 150_000, computedMicros: 210, computedCount: 1, fixedZeroCount: 3, syntheticMicros: 0, syntheticCount: 3 });
    // The dashboard note says the same.
    const spend = buildDashboard(ctx, { statuses: null }).body;
    expect(spend).toContain('llm_gateway \\$0.00021 (1 request(s))'); // Markdown-escaped dollar sign
    expect(spend).toContain('Fixed zero, not computed: llm_gateway 3 request(s)');
    // data export costs: amount_basis fixed_zero for the three, computed only for the real one.
    const bases = exportDataset(ctx, 'costs').rows.map((x) => x.amount_basis).sort();
    expect(bases).toEqual(['actual', 'computed', 'fixed_zero', 'fixed_zero', 'fixed_zero']);
  });

  it('dashboard: provider-reported and computed columns; the report Spend notes name the computed amount', async () => {
    ctx = createTestContext({ now: NOW });
    liveWithComputedCharge(ctx);
    const note = buildDashboard(ctx, { statuses: null });
    const spend = note.body.slice(note.body.indexOf('## Spend'), note.body.indexOf('## Latest reports'));
    expect(spend).toContain('| Provider | Provider-reported | Computed (usage x list price) | Reserved | Estimated-only | Unknown charges | Limit | Remaining | Synthetic |');
    expect(spend).toContain('| llm_gateway | $0.15 | $0.00021 |');
    expect(spend).toContain(COMPUTED);
    expect(spend).not.toContain('SYNTHETIC DEMO DATA');

    const weekly = await buildWeeklyReport(ctx, { statuses: null });
    const spendSection = weekly.report.sections.find((s) => s.key === 'spend')!;
    expect(spendSection.notes.some((n) => n.includes(`llm_gateway $0.00021 (1 request(s)) of the actual amount(s) above was ${COMPUTED}`))).toBe(true);
    // The existing Spend claims keep their meaning: actual includes the computed part (explained by the note).
    expect(allClaims(weekly.report).find((c) => c.id === 'spend.llm_gateway')!.text).toContain('actual $0.15021');
  });
});

describe('costs in a demo workspace (B1-03)', () => {
  it('prints the SYNTHETIC DEMO DATA banner, labels every amount, and sets synthetic: true in JSON', async () => {
    ctx = createTestContext({ now: NOW, config: testSiteConfig({ profile: 'demo', site: { id: 'demo-costs' } }) });
    const budgets = ctx.budgets as BudgetService;
    const r = budgets.reserve({ siteId: ctx.siteId, provider: 'dataforseo', runId: 'demo-run', purpose: 'SYNTHETIC demo priced fixture task', estimate: { upperBoundMicros: 2_000, basis: { source: 'documented', detail: 'SYNTHETIC fixture price' } } });
    budgets.reconcile(r.id, { actualMicros: 1_500, source: 'computed_from_usage', usage: { synthetic: true } });
    const open = budgets.reserve({ siteId: ctx.siteId, provider: 'apify', runId: 'demo-run', purpose: 'SYNTHETIC demo run', estimate: { upperBoundMicros: 5_000, basis: { source: 'documented', detail: 'SYNTHETIC fixture price' } } });
    // Every cost row of a demo site is flagged synthetic.
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM budget_reservations WHERE site_id = ? AND is_synthetic = 0', [ctx.siteId])!.n).toBe(0);
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_ledger WHERE site_id = ? AND is_synthetic = 0', [ctx.siteId])!.n).toBe(0);

    const text = await runCli(ctx.paths.root, ['costs']);
    expect(text.failed).toBe(false);
    expect(text.out.split('\n')[0]).toMatch(/^SYNTHETIC DEMO DATA: no real charges/);
    expect(text.out).toContain('Spend for demo-costs');
    expect(text.out).toMatch(/^dataforseo .*\[SYNTHETIC\]$/m);
    expect(text.out).toMatch(/^Combined: .*\[SYNTHETIC\]$/m);
    expect(text.out).toContain('Note: SYNTHETIC DEMO DATA: no real charges.');
    expect(text.out).not.toMatch(/DATA.UNAVAILABLE/);

    const json = (await runCli(ctx.paths.root, ['--json', 'costs'])).json;
    expect(json).toMatchObject({ synthetic: true, containsSynthetic: true, siteId: 'demo-costs' });
    expect(json.costBasis.find((b: { provider: string }) => b.provider === 'dataforseo')).toMatchObject({ computedMicros: 1_500, syntheticMicros: 1_500, syntheticCount: 1 });

    const unresolved = await runCli(ctx.paths.root, ['--json', 'costs', '--unresolved']);
    expect(unresolved.json).toMatchObject({ synthetic: true, report: { synthetic: true } });
    expect(unresolved.json.open[0]).toMatchObject({ id: open.id, synthetic: true });
    const unresolvedText = await runCli(ctx.paths.root, ['costs', '--unresolved']);
    expect(unresolvedText.out).toContain(`${open.id} apify reserved $0.005 SYNTHETIC demo run [SYNTHETIC: no real charge]`);

    // The dashboard of a demo site says so too.
    const dash = buildDashboard(ctx, { statuses: null }).body;
    expect(dash).toContain('**SYNTHETIC DEMO DATA: no real charges.**');
    expect(dash).toMatch(/\| dataforseo \| \$0\.00 \| \$0\.0015 \|.*SYNTHETIC \(demo; no real charge\) \|/);
  });

  it('renderSpend labels a live report that contains synthetic sandbox reservations without calling it demo data', () => {
    ctx = createTestContext({ now: NOW });
    const synthetic = ctx.budgets.reserve({ siteId: ctx.siteId, provider: 'dataforseo', runId: 'run_s', purpose: '[SYNTHETIC sandbox] task', estimate: { upperBoundMicros: 3_000, basis: { source: 'documented', detail: 'synthetic' } }, synthetic: true });
    ctx.budgets.reconcile(synthetic.id, { actualMicros: 3_000, source: 'computed_from_usage' });
    const text = renderSpend(ctx.budgets.report(ctx.siteId));
    expect(text).not.toContain('SYNTHETIC DEMO DATA');
    expect(text).toContain('  [SYNTHETIC] $0.003 of the committed amount is from 1 fixture/sandbox/demo reservation(s): no real charge');
    expect(text).toMatch(/Note: \[SYNTHETIC\] dataforseo \$0\.003 \(1 reservation\(s\)\)/);
  });
});
