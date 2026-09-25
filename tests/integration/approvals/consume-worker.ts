/**
 * Child-process worker for the concurrent one-time-execution test.
 * argv: <db file> <approval id> <start-at epoch ms> <clock ISO>
 * Prints "won" or "lost:<message>".
 */
import { ApprovalService } from '../../../src/approvals/service.js';
import { fixedClock } from '../../../src/core/clock.js';
import { openDatabase } from '../../../src/database/db.js';

const [dbFile, id, startAt, clockIso] = process.argv.slice(2);
const db = openDatabase(dbFile!);
const gate = new ApprovalService(db, { clock: fixedClock(clockIso!) });
while (Date.now() < Number(startAt)) {
  /* spin until the common start time so the workers race */
}
try {
  gate.consume(id!, { kind: 'race', pid: process.pid });
  process.stdout.write('won');
} catch (err) {
  process.stdout.write(`lost:${(err as Error).message}`);
} finally {
  db.close();
}
