/**
 * Child-process worker for the parallel budget reservation test (not a test
 * file itself). It opens its OWN connection to the shared SQLite file, waits
 * for a start signal so all workers contend at the same moment, then tries to
 * reserve repeatedly and prints a JSON summary on stdout.
 *
 * argv: <dbFile> <siteId> <runId> <amountMicros> <attempts> <goFile> <limitsJson>
 */
import { existsSync } from 'node:fs';
import { BudgetService } from '../../../src/budgets/budget-service.js';
import type { BudgetSettings } from '../../../src/config/load.js';
import { openDatabase } from '../../../src/database/db.js';

const [dbFile, siteId, runId, amountArg, attemptsArg, goFile, limitsJson] = process.argv.slice(2);
if (!dbFile || !siteId || !runId || !amountArg || !attemptsArg || !goFile || !limitsJson) {
  process.stderr.write('usage: reserve-worker <dbFile> <siteId> <runId> <amountMicros> <attempts> <goFile> <limitsJson>\n');
  process.exit(2);
}

const db = openDatabase(dbFile);
db.exec('PRAGMA busy_timeout = 15000');
const service = new BudgetService(db, { limits: JSON.parse(limitsJson) as BudgetSettings, timeZone: 'Europe/Tallinn', actor: `worker:${runId}` });

const pause = new Int32Array(new SharedArrayBuffer(4));
process.stdout.write('ready\n');
const deadline = Date.now() + 15_000;
while (!existsSync(goFile)) {
  if (Date.now() > deadline) {
    process.stderr.write('timed out waiting for start signal\n');
    process.exit(3);
  }
  Atomics.wait(pause, 0, 0, 2);
}

const result = { runId, reserved: 0, denied: 0, errors: [] as string[] };
for (let i = 0; i < Number(attemptsArg); i++) {
  try {
    service.reserve({
      siteId,
      provider: 'apify',
      runId,
      purpose: `parallel attempt ${i}`,
      estimate: { upperBoundMicros: Number(amountArg), basis: { source: 'verified_config', detail: 'synthetic parallel test price' } },
    });
    result.reserved++;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'BUDGET_EXCEEDED') result.denied++;
    else result.errors.push(`${code ?? 'ERR'}: ${(err as Error).message}`);
  }
}
db.close();
process.stdout.write(`${JSON.stringify(result)}\n`);
