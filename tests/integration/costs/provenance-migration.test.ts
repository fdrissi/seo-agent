/**
 * Migration 0310_cost_provenance on a database that already holds cost rows
 * written before it (SYNTHETIC rows, reserved example domains): the basis of
 * each reconciled reservation is back-filled from its ledger source, and rows
 * of synthetic provider requests or demo sites are flagged synthetic. Nothing
 * is guessed: an unreconciled reservation keeps a NULL basis.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appDirs } from '../../../src/config/paths.js';
import { openDatabase, type Db } from '../../../src/database/db.js';
import { migrate } from '../../../src/database/migrate.js';

const T = '2026-09-24T09:00:00.000Z';
let dir: string;
let partial: string;
let db: Db;

function copyMigrations(filter: (f: string) => boolean): void {
  for (const f of readdirSync(appDirs.migrations()).filter((x) => /^\d{4}_[a-z0-9_]+\.sql$/.test(x) && filter(x))) copyFileSync(path.join(appDirs.migrations(), f), path.join(partial, f));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'seo-agent-mig0310-'));
  partial = path.join(dir, 'migrations');
  mkdirSync(partial);
  db = openDatabase(path.join(dir, 'db.sqlite'));
  copyMigrations((f) => f < '0310');
  migrate(db, { dir: partial });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function site(id: string, isDemo: 0 | 1): void {
  db.run('INSERT INTO sites (id, name, base_url, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, 'Synthetic Co', `https://${id}.example.test/`, isDemo, T, T]);
}
function request(id: string, siteId: string, synthetic: 0 | 1): void {
  db.run(`INSERT INTO provider_requests (id, site_id, provider, endpoint, method, is_paid, request_hash, status, is_synthetic, created_at) VALUES (?, ?, 'llm_gateway', 'chat', 'POST', 1, 'h', 'succeeded', ?, ?)`, [id, siteId, synthetic, T]);
}
function reservation(id: string, siteId: string, status: string, actual: number | null, requestId: string | null): void {
  db.run(
    `INSERT INTO budget_reservations (id, site_id, provider, run_id, purpose, estimated_usd_micros, actual_usd_micros, status, cost_status, period_month, period_week, provider_request_id, created_at, updated_at)
     VALUES (?, ?, 'llm_gateway', 'run', 'SYNTHETIC', 1000, ?, ?, ?, '2026-09', '2026-W39', ?, ?, ?)`,
    [id, siteId, actual, status, actual === null ? (status === 'reserved' ? 'estimated' : 'unknown') : 'actual', requestId, T, T],
  );
}
function ledger(id: string, siteId: string, reservationId: string, requestId: string | null, amount: number | null, source: string): void {
  db.run(
    `INSERT INTO cost_ledger (id, site_id, provider, reservation_id, provider_request_id, amount_usd_micros, amount_status, source, period_month, period_week, recorded_at)
     VALUES (?, ?, 'llm_gateway', ?, ?, ?, ?, ?, '2026-09', '2026-W39', ?)`,
    [id, siteId, reservationId, requestId, amount, amount === null ? 'unknown' : 'actual', source, T],
  );
}

describe('0310_cost_provenance on existing rows', () => {
  it('back-fills the cost basis from the ledger and flags synthetic and demo rows', () => {
    site('live', 0);
    site('demo', 1);
    request('preq_live', 'live', 0);
    request('preq_fixture', 'live', 1);
    request('preq_demo', 'demo', 0);
    reservation('res_computed', 'live', 'reconciled', 210, 'preq_live');
    ledger('cost_computed', 'live', 'res_computed', 'preq_live', 210, 'computed_from_usage');
    reservation('res_reported', 'live', 'reconciled', 500, null);
    ledger('cost_reported', 'live', 'res_reported', null, 500, 'gateway_reported');
    reservation('res_fixture', 'live', 'reconciled', 0, 'preq_fixture');
    ledger('cost_fixture', 'live', 'res_fixture', 'preq_fixture', 0, 'computed_from_usage');
    reservation('res_unresolved', 'live', 'unresolved', null, null);
    ledger('cost_unknown', 'live', 'res_unresolved', null, null, 'provider_reported');
    reservation('res_open', 'live', 'reserved', null, null);
    reservation('res_demo', 'demo', 'reconciled', 1500, 'preq_demo');
    ledger('cost_demo', 'demo', 'res_demo', 'preq_demo', 1500, 'computed_from_usage');

    copyMigrations((f) => f === '0310_cost_provenance.sql');
    const r = migrate(db, { dir: partial });
    expect(r.applied).toEqual(['0310_cost_provenance']);

    const res = Object.fromEntries(db.all<{ id: string; cost_basis: string | null; is_synthetic: number }>('SELECT id, cost_basis, is_synthetic FROM budget_reservations ORDER BY id').map((x) => [x.id, { basis: x.cost_basis, synthetic: x.is_synthetic }]));
    expect(res).toEqual({
      res_computed: { basis: 'computed_from_usage', synthetic: 0 },
      res_demo: { basis: 'computed_from_usage', synthetic: 1 },
      res_fixture: { basis: 'computed_from_usage', synthetic: 1 },
      res_open: { basis: null, synthetic: 0 },
      res_reported: { basis: 'gateway_reported', synthetic: 0 },
      res_unresolved: { basis: null, synthetic: 0 },
    });
    const led = Object.fromEntries(db.all<{ id: string; is_synthetic: number }>('SELECT id, is_synthetic FROM cost_ledger ORDER BY id').map((x) => [x.id, x.is_synthetic]));
    expect(led).toEqual({ cost_computed: 0, cost_demo: 1, cost_fixture: 1, cost_reported: 0, cost_unknown: 0 });
    // Existing amounts and statuses are untouched.
    expect(db.get('SELECT status, cost_status, actual_usd_micros FROM budget_reservations WHERE id = ?', ['res_computed'])).toEqual({ status: 'reconciled', cost_status: 'actual', actual_usd_micros: 210 });
    expect(() => db.run("UPDATE budget_reservations SET cost_basis = 'guessed' WHERE id = 'res_open'")).toThrow(/CHECK/);
  });
});
