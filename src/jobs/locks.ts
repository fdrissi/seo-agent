import { recordAudit } from '../database/audit.js';
import type { Db } from '../database/db.js';

/**
 * Per-site, non-overlapping run locks (table `site_locks`). A lock is a lease:
 * the holder renews it with heartbeats; a lock whose lease expired (holder
 * crashed, laptop went to sleep, process killed) may be taken over by another
 * runner. Acquisition and takeover are atomic (BEGIN IMMEDIATE), so two
 * processes sharing the workspace database can never both hold the lock.
 *
 * The holder is the pair (owner, job_id): one runner (one owner string) that
 * runs two jobs at once gets the lock for the first job only; the second is
 * refused like any other contender. Renewal and release match both, so a run
 * can never extend or delete a lock that now belongs to another job.
 */

export const DEFAULT_LOCK_NAME = 'site';

export interface LockInfo {
  siteId: string;
  lockName: string;
  owner: string;
  jobId: string | null;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export type AcquireResult = { acquired: true; lock: LockInfo; takenOverFrom?: LockInfo } | { acquired: false; heldBy: LockInfo };

interface LockRow {
  site_id: string;
  lock_name: string;
  owner: string;
  job_id: string | null;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
}

const toInfo = (r: LockRow): LockInfo => ({
  siteId: r.site_id,
  lockName: r.lock_name,
  owner: r.owner,
  jobId: r.job_id,
  acquiredAt: r.acquired_at,
  heartbeatAt: r.heartbeat_at,
  expiresAt: r.expires_at,
});

export interface AcquireLockInput {
  siteId: string;
  lockName?: string;
  owner: string;
  jobId?: string | null;
  leaseMs: number;
  now: Date;
  /**
   * Called (inside the acquisition transaction) before an EXPIRED lease of
   * another holder is taken over. Return false to refuse the takeover, e.g.
   * when the holder's process is known to be alive on this host (a laptop that
   * just woke up has not renewed its lease yet).
   */
  mayTakeOver?: (current: LockInfo) => boolean;
}

export function acquireSiteLock(db: Db, input: AcquireLockInput): AcquireResult {
  const lockName = input.lockName ?? DEFAULT_LOCK_NAME;
  const nowIso = input.now.toISOString();
  const expires = new Date(input.now.getTime() + input.leaseMs).toISOString();
  return db.transaction((): AcquireResult => {
    const cur = db.get<LockRow>('SELECT * FROM site_locks WHERE site_id = ? AND lock_name = ?', [input.siteId, lockName]);
    if (!cur) {
      db.run('INSERT INTO site_locks (site_id, lock_name, owner, job_id, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        input.siteId,
        lockName,
        input.owner,
        input.jobId ?? null,
        nowIso,
        nowIso,
        expires,
      ]);
      return { acquired: true, lock: getSiteLock(db, input.siteId, lockName)! };
    }
    if (cur.owner === input.owner && (cur.job_id ?? null) === (input.jobId ?? null)) {
      // Re-entry by the same holder (same owner AND same job) only extends the lease.
      db.run('UPDATE site_locks SET heartbeat_at = ?, expires_at = ? WHERE site_id = ? AND lock_name = ? AND owner = ? AND job_id IS ?', [
        nowIso,
        expires,
        input.siteId,
        lockName,
        input.owner,
        cur.job_id,
      ]);
      return { acquired: true, lock: getSiteLock(db, input.siteId, lockName)! };
    }
    if (Date.parse(cur.expires_at) <= input.now.getTime() && (!input.mayTakeOver || input.mayTakeOver(toInfo(cur)))) {
      db.run(
        'UPDATE site_locks SET owner = ?, job_id = ?, acquired_at = ?, heartbeat_at = ?, expires_at = ? WHERE site_id = ? AND lock_name = ? AND owner = ? AND job_id IS ?',
        [input.owner, input.jobId ?? null, nowIso, nowIso, expires, input.siteId, lockName, cur.owner, cur.job_id],
      );
      recordAudit(db, {
        siteId: input.siteId,
        actor: 'system',
        eventType: 'lock.takeover',
        subjectType: 'site_lock',
        subjectId: lockName,
        details: { previousOwner: cur.owner, previousJobId: cur.job_id, expiredAt: cur.expires_at, newOwner: input.owner, jobId: input.jobId ?? null },
        at: input.now,
      });
      return { acquired: true, lock: getSiteLock(db, input.siteId, lockName)!, takenOverFrom: toInfo(cur) };
    }
    return { acquired: false, heldBy: toInfo(cur) };
  });
}

/**
 * Extend the lease. Returns false when this holder no longer holds the lock
 * (it was taken over). When `jobId` is given (runners always pass it) the lock
 * must also still be held for that job.
 */
export function renewSiteLock(db: Db, input: { siteId: string; lockName?: string; owner: string; jobId?: string | null; leaseMs: number; now: Date }): boolean {
  const params: unknown[] = [input.now.toISOString(), new Date(input.now.getTime() + input.leaseMs).toISOString(), input.siteId, input.lockName ?? DEFAULT_LOCK_NAME, input.owner];
  let sql = 'UPDATE site_locks SET heartbeat_at = ?, expires_at = ? WHERE site_id = ? AND lock_name = ? AND owner = ?';
  if (input.jobId !== undefined) {
    sql += ' AND job_id IS ?';
    params.push(input.jobId);
  }
  return db.run(sql, params).changes > 0;
}

/** Release the lock if (and only if) this holder (owner, and job when given) still holds it. */
export function releaseSiteLock(db: Db, input: { siteId: string; lockName?: string; owner: string; jobId?: string | null }): boolean {
  const params: unknown[] = [input.siteId, input.lockName ?? DEFAULT_LOCK_NAME, input.owner];
  let sql = 'DELETE FROM site_locks WHERE site_id = ? AND lock_name = ? AND owner = ?';
  if (input.jobId !== undefined) {
    sql += ' AND job_id IS ?';
    params.push(input.jobId);
  }
  return db.run(sql, params).changes > 0;
}

export function getSiteLock(db: Db, siteId: string, lockName = DEFAULT_LOCK_NAME): LockInfo | undefined {
  const r = db.get<LockRow>('SELECT * FROM site_locks WHERE site_id = ? AND lock_name = ?', [siteId, lockName]);
  return r ? toInfo(r) : undefined;
}

export function listSiteLocks(db: Db, siteId: string): LockInfo[] {
  return db.all<LockRow>('SELECT * FROM site_locks WHERE site_id = ? ORDER BY lock_name', [siteId]).map(toInfo);
}
