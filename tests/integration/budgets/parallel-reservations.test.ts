import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BudgetService } from '../../../src/budgets/budget-service.js';
import type { BudgetSettings } from '../../../src/config/load.js';
import { appRoot } from '../../../src/config/paths.js';
import { openDatabase, type Db } from '../../../src/database/db.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

/**
 * Section 31: "Parallel budget reservations". Reservations from separate
 * connections and separate OS processes must never overspend: the limit check
 * and the insert run inside one BEGIN IMMEDIATE transaction.
 */

const LIMIT = 1_000_000; // $1.00 monthly Apify budget
const AMOUNT = 100_000; // $0.10 per reservation => exactly 10 may succeed
const LIMITS: BudgetSettings = {
  llmGateway: { monthly: 5_000_000, perRun: 500_000 },
  dataforseo: { weekly: 1_000_000, monthly: 10_000_000, perRun: 500_000 },
  apify: { monthly: LIMIT, perRun: LIMIT },
  pagespeed: { monthly: 0, perRun: 0 },
  combinedMonthly: 25_000_000,
  accountMonthly: {},
};

let ctx: TestContext;
const extra: Db[] = [];
beforeEach(() => {
  ctx = createTestContext({ now: '2026-09-24T09:00:00.000Z' });
});
afterEach(() => {
  for (const d of extra.splice(0)) d.close();
  ctx.cleanup();
});

const committed = (db: Db) =>
  db.get<{ n: number; total: number | null }>("SELECT COUNT(*) AS n, SUM(estimated_usd_micros) AS total FROM budget_reservations WHERE provider = 'apify' AND status = 'reserved'")!;

interface WorkerResult {
  runId: string;
  reserved: number;
  denied: number;
  errors: string[];
}

function startWorker(args: string[]): { ready: Promise<void>; done: Promise<WorkerResult> } {
  const worker = path.join(appRoot(), 'tests', 'integration', 'budgets', 'reserve-worker.ts');
  const child = spawn(process.execPath, ['--import', 'tsx', worker, ...args], { cwd: appRoot(), env: { ...process.env, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  child.stdout.on('data', (d: Buffer) => {
    out += d.toString();
    if (out.includes('ready\n')) markReady();
  });
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const done = new Promise<WorkerResult>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('{'));
      if (code !== 0 || !line) reject(new Error(`worker exited ${code}: ${err || out}`));
      else resolve(JSON.parse(line) as WorkerResult);
    });
  });
  return { ready, done };
}

describe('parallel budget reservations cannot overspend', () => {
  it('separate OS processes contending for the same budget reserve at most the limit', async () => {
    const goFile = path.join(ctx.paths.root, 'go.signal');
    const workers = Array.from({ length: 4 }, (_, i) =>
      startWorker([ctx.db.file, ctx.siteId, `run_proc_${i}`, String(AMOUNT), '6', goFile, JSON.stringify(LIMITS)]),
    );
    await Promise.all(workers.map((w) => w.ready));
    writeFileSync(goFile, 'go');
    const results = await Promise.all(workers.map((w) => w.done));

    const reserved = results.reduce((s, r) => s + r.reserved, 0);
    const denied = results.reduce((s, r) => s + r.denied, 0);
    expect(results.flatMap((r) => r.errors)).toEqual([]);
    expect(reserved).toBe(LIMIT / AMOUNT); // exactly 10 of 24 attempts
    expect(denied).toBe(24 - LIMIT / AMOUNT);
    const c = committed(ctx.db);
    expect(c.n).toBe(10);
    expect(c.total).toBe(LIMIT); // never above the limit
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'budget.denied'")!.n).toBe(denied);
  }, 60_000);

  it('interleaved reservations from two connections see each other immediately', () => {
    const dbB = openDatabase(ctx.db.file);
    extra.push(dbB);
    const a = new BudgetService(ctx.db, { limits: LIMITS, timeZone: 'Europe/Tallinn', clock: ctx.clock });
    const b = new BudgetService(dbB, { limits: LIMITS, timeZone: 'Europe/Tallinn', clock: ctx.clock });
    let ok = 0;
    let deniedCount = 0;
    for (let i = 0; i < 16; i++) {
      const svc = i % 2 === 0 ? a : b;
      try {
        svc.reserve({ siteId: ctx.siteId, provider: 'apify', runId: `run_${i % 3}`, purpose: 'interleaved', estimate: { upperBoundMicros: 150_000, basis: { source: 'verified_config', detail: 'synthetic' } } });
        ok++;
      } catch (err) {
        expect((err as { code?: string }).code).toBe('BUDGET_EXCEEDED');
        deniedCount++;
      }
    }
    expect(ok).toBe(6); // 6 x 0.15 = 0.90; a 7th would exceed 1.00
    expect(deniedCount).toBe(10);
    expect(committed(dbB).total).toBe(900_000);
  });

  it('BEGIN IMMEDIATE holds the write lock across check-and-insert, so a concurrent reservation waits or fails, never interleaves', () => {
    const dbB = openDatabase(ctx.db.file);
    extra.push(dbB);
    dbB.exec('PRAGMA busy_timeout = 50');
    const a = new BudgetService(ctx.db, { limits: LIMITS, timeZone: 'Europe/Tallinn', clock: ctx.clock });
    const b = new BudgetService(dbB, { limits: LIMITS, timeZone: 'Europe/Tallinn', clock: ctx.clock });
    const req = (runId: string, micros: number) => ({ siteId: ctx.siteId, provider: 'apify' as const, runId, purpose: 'lock test', estimate: { upperBoundMicros: micros, basis: { source: 'verified_config' as const, detail: 'synthetic' } } });

    ctx.db.transaction(() => {
      // Connection A has read the committed total (0) and reserved 0.80 inside its open transaction.
      a.reserve(req('run_a', 800_000));
      // Connection B cannot even start its check while A holds the lock (it would have seen a stale 0).
      expect(() => b.reserve(req('run_b', 800_000))).toThrow(/locked|busy/i);
    });
    // After A commits, B's check sees A's reservation and is denied instead of overspending.
    expect(() => b.reserve(req('run_b', 800_000))).toThrow(expect.objectContaining({ code: 'BUDGET_EXCEEDED' }));
    expect(() => b.reserve(req('run_b', 200_000))).not.toThrow();
    expect(committed(ctx.db).total).toBe(LIMIT);
    expect(dbB.inTransaction).toBe(false);
  });
});
