/**
 * Manual reconciliation of unresolved or unknown charges (SYNTHETIC amounts):
 * `costs reconcile <id> --actual-usd <amount> | --not-charged --evidence <note> --by <name>`.
 * Audited, needs a named human and evidence, and never turns unknown into $0
 * without an explicit statement. `costs --unresolved` prints the command for
 * each open reservation, so the "reconcile it (costs --unresolved)" hints lead
 * to a working path.
 */
import { Command, CommanderError } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { BudgetService } from '../../../src/budgets/budget-service.js';
import { ProviderRequestLog } from '../../../src/budgets/provider-requests.js';
import { CliExit, CliRuntime } from '../../../src/cli/runtime.js';
import { register as registerCosts } from '../../../src/cli/commands/costs.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

let ctx: TestContext | undefined;
afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
});

const NOW = '2026-09-24T09:00:00.000Z';

function setup() {
  ctx = createTestContext({ now: NOW });
  const budgets = ctx.budgets as BudgetService;
  const requests = new ProviderRequestLog(ctx.db, ctx.clock);
  /** An LLM Gateway call that timed out after submission: unresolved, still reserved. */
  const ambiguous = () => {
    const r = budgets.reserve({ siteId: ctx!.siteId, provider: 'llm_gateway', runId: 'run_llm', purpose: 'SYNTHETIC chat call (timed out)', estimate: { upperBoundMicros: 40_000, basis: { source: 'verified_config', detail: 'synthetic test price' } } });
    const p = requests.prepare({ siteId: ctx!.siteId, provider: 'llm_gateway', endpoint: 'chat.completions', method: 'POST', isPaid: true, params: { synthetic: true }, reservationId: r.id, isSynthetic: true });
    budgets.attachRequest(r.id, p.id);
    requests.markSubmitted(p.id);
    requests.complete(p.id, { status: 'ambiguous' });
    budgets.markUnresolved(r.id, 'timeout after submission');
    return { reservationId: r.id, requestId: p.id };
  };
  /** An approved charge with no upper bound: amount unknown. */
  const unknownPrice = () =>
    budgets.reserve({ siteId: ctx!.siteId, provider: 'llm_gateway', runId: 'run_u', purpose: 'SYNTHETIC unknown-price call', estimate: { upperBoundMicros: null, basis: { source: 'unknown', detail: 'no verified price' } }, unknownPriceApprovalId: 'apr_synthetic' }).id;
  return { ctx, budgets, requests, ambiguous, unknownPrice };
}

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

const row = (id: string) =>
  ctx!.db.get<{ status: string; cost_status: string; actual_usd_micros: number | null; note: string | null }>('SELECT status, cost_status, actual_usd_micros, note FROM budget_reservations WHERE id = ?', [id])!;

describe('BudgetService.reconcileManual', () => {
  it('settles an unresolved charge with the amount from the provider history (audited, ledger and request updated)', () => {
    const s = setup();
    const { reservationId, requestId } = s.ambiguous();
    expect(s.budgets.report(s.ctx.siteId).providers.find((p) => p.provider === 'llm_gateway')).toMatchObject({ reservedMicros: 40_000, unknownCount: 1 });
    const r = s.budgets.reconcileManual(reservationId, { actualMicros: 12_300, evidence: 'Gateway usage page 2026-09-24: request charged $0.0123', by: 'Alice' });
    expect(r).toMatchObject({ status: 'reconciled', previousStatus: 'unresolved', actualMicros: 12_300, notCharged: false, provider: 'llm_gateway' });
    expect(row(reservationId)).toMatchObject({ status: 'reconciled', cost_status: 'actual', actual_usd_micros: 12_300 });
    const ledger = s.ctx.db.get<{ amount_usd_micros: number; amount_status: string; source: string; usage_json: string }>('SELECT amount_usd_micros, amount_status, source, usage_json FROM cost_ledger WHERE reservation_id = ?', [reservationId])!;
    expect(ledger).toMatchObject({ amount_usd_micros: 12_300, amount_status: 'actual', source: 'manual' });
    expect(JSON.parse(ledger.usage_json)).toMatchObject({ manual: true, reconciledBy: 'owner:Alice', evidence: 'Gateway usage page 2026-09-24: request charged $0.0123', previousStatus: 'unresolved' });
    expect(s.ctx.db.get<{ status: string }>('SELECT status FROM provider_requests WHERE id = ?', [requestId])!.status).toBe('reconciled');
    const audit = s.ctx.db.get<{ actor: string; details_json: string }>(`SELECT actor, details_json FROM audit_events WHERE event_type = 'budget.manually_reconciled'`)!;
    expect(audit.actor).toBe('owner:Alice');
    expect(JSON.parse(audit.details_json)).toMatchObject({ previousStatus: 'unresolved', actualMicros: 12_300, notCharged: false, evidence: expect.stringMatching(/charged \$0\.0123/) });
    expect(s.budgets.report(s.ctx.siteId).providers.find((p) => p.provider === 'llm_gateway')).toMatchObject({ actualMicros: 12_300, reservedMicros: 0, unknownCount: 0 });
    expect(s.budgets.listUnresolved(s.ctx.siteId)).toEqual([]);
  });

  it('"not charged" is $0 only with an explicit statement and provider-history evidence; unbounded charges unblock the scope', () => {
    const s = setup();
    const id = s.unknownPrice();
    expect(s.budgets.report(s.ctx.siteId).providers.find((p) => p.provider === 'llm_gateway')!.remainingVerified).toBe(false);
    s.budgets.reconcileManual(id, { notCharged: true, evidence: 'Gateway billing shows no charge for this request id', by: 'Alice' });
    expect(row(id)).toMatchObject({ status: 'reconciled', cost_status: 'actual', actual_usd_micros: 0 });
    expect(row(id).note).toMatch(/^not charged by owner:Alice: Gateway billing shows no charge/);
    const p = s.budgets.report(s.ctx.siteId).providers.find((x) => x.provider === 'llm_gateway')!;
    expect(p).toMatchObject({ unboundedUnknownCount: 0, remainingVerified: true, unknownCount: 0 });
  });

  it('refuses without a named human, evidence, or exactly one of amount / not-charged; unknown never becomes $0 silently', () => {
    const s = setup();
    const { reservationId } = s.ambiguous();
    const attempt = (input: Parameters<BudgetService['reconcileManual']>[1]) => () => s.budgets.reconcileManual(reservationId, input);
    expect(attempt({ actualMicros: 1, evidence: 'x', by: 'system' })).toThrow(/reserved for automation/);
    expect(attempt({ actualMicros: 1, evidence: 'x', by: '' })).toThrow(/explicit human approver name/);
    expect(attempt({ actualMicros: 1, evidence: '  ', by: 'Alice' })).toThrow(/evidence note is required/);
    expect(attempt({ evidence: 'x', by: 'Alice' })).toThrow(/exactly one of an explicit actual amount/);
    expect(attempt({ actualMicros: null, evidence: 'x', by: 'Alice' })).toThrow(/exactly one of an explicit actual amount/);
    expect(attempt({ actualMicros: 5, notCharged: true, evidence: 'x', by: 'Alice' })).toThrow(/exactly one/);
    expect(attempt({ actualMicros: -5, evidence: 'x', by: 'Alice' })).toThrow(RangeError);
    expect(row(reservationId)).toMatchObject({ status: 'unresolved', cost_status: 'unknown', actual_usd_micros: null });
    expect(s.ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'budget.manually_reconciled'`)!.n).toBe(0);
    // Closed reservations cannot be re-settled manually.
    s.budgets.reconcileManual(reservationId, { actualMicros: 100, evidence: 'provider history', by: 'Alice' });
    expect(attempt({ actualMicros: 200, evidence: 'again', by: 'Alice' })).toThrow(/is reconciled; only open/);
    expect(() => s.budgets.reconcileManual('res_missing', { actualMicros: 1, evidence: 'x', by: 'Alice' })).toThrow(/not found/);
  });

  it('records an amount above the reserved estimate truthfully (overshoot)', () => {
    const s = setup();
    const { reservationId } = s.ambiguous();
    expect(s.budgets.reconcileManual(reservationId, { actualMicros: 55_000, evidence: 'provider invoice line', by: 'Alice' }).overshootMicros).toBe(15_000);
  });
});

describe('CLI: costs --unresolved and costs reconcile', () => {
  it('lists the reconcile command for each open reservation, then settles it', async () => {
    const s = setup();
    const { reservationId } = s.ambiguous();
    const root = s.ctx.paths.root;
    const list = await runCli(root, ['costs', '--unresolved']);
    expect(list.failed).toBe(false);
    expect(list.out).toContain(`npm run cli -- costs reconcile ${reservationId} --actual-usd <amount from provider history> --evidence "<what the provider history shows>" --by "<your name>"`);
    expect(list.out).toContain(`npm run cli -- costs reconcile ${reservationId} --not-charged --evidence`);
    const listJson = await runCli(root, ['--json', 'costs', '--unresolved']);
    expect(listJson.json.open[0].reconcileCommands).toHaveLength(2);

    expect((await runCli(root, ['costs', 'reconcile', reservationId, '--actual-usd', '0.01', '--evidence', 'x'])).err).toMatch(/--by/);
    const both = await runCli(root, ['costs', 'reconcile', reservationId, '--actual-usd', '0.01', '--not-charged', '--evidence', 'x', '--by', 'Alice']);
    expect(both.failed).toBe(true);
    expect(both.err).toMatch(/exactly one of --actual-usd <amount> or --not-charged/);
    const neither = await runCli(root, ['costs', 'reconcile', reservationId, '--evidence', 'x', '--by', 'Alice']);
    expect(neither.failed).toBe(true);
    expect((await runCli(root, ['costs', 'reconcile', reservationId, '--actual-usd', 'ten', '--evidence', 'x', '--by', 'Alice'])).err).toMatch(/not a decimal USD amount/);
    expect((await runCli(root, ['costs', 'reconcile', reservationId, '--actual-usd', '0.01', '--evidence', 'x', '--by', 'cron'])).err).toMatch(/reserved for automation/);
    const dry = await runCli(root, ['--dry-run', 'costs', 'reconcile', reservationId, '--actual-usd', '0.0123', '--evidence', 'usage page', '--by', 'Alice']);
    expect(dry.out).toMatch(/Dry run: Alice would reconcile .* as \$0\.0123\. Nothing was written\./);
    expect(row(reservationId).status).toBe('unresolved');

    const ok = await runCli(root, ['costs', 'reconcile', reservationId, '--actual-usd', '0.0123', '--evidence', 'Gateway usage page: charged $0.0123', '--by', 'Alice']);
    expect(ok.failed).toBe(false);
    expect(ok.out).toMatch(new RegExp(`Reconciled ${reservationId} \\(llm_gateway; was unresolved\\): \\$0\\.0123 actual; recorded by Alice`));
    expect(row(reservationId)).toMatchObject({ status: 'reconciled', actual_usd_micros: 12_300 });
    expect((await runCli(root, ['costs', '--unresolved'])).out).toMatch(/Open reservations:\n {2}\(none\)/);
  });

  it('--not-charged via the CLI', async () => {
    const s = setup();
    const id = s.unknownPrice();
    const r = await runCli(s.ctx.paths.root, ['--json', 'costs', 'reconcile', id, '--not-charged', '--evidence', 'billing: no charge', '--by', 'Alice']);
    expect(r.failed).toBe(false);
    expect(r.json).toMatchObject({ reservationId: id, status: 'reconciled', notCharged: true, actualMicros: 0 });
  });
});
