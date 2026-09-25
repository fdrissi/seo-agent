import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import type { Clock } from '../core/clock.js';
import { ulid } from '../core/ids.js';
import { recordAudit } from '../database/audit.js';
import type { Db } from '../database/db.js';
import { DEFAULT_LOCK_NAME, acquireSiteLock, getSiteLock, releaseSiteLock, renewSiteLock, type LockInfo } from './locks.js';

/**
 * Per-site leases for MANUAL commands (spec 27: non-overlapping per-site
 * runs). A manual command that changes data or spends money (`sync gsc`,
 * `crawl`, `research keyword`, ...) holds the same `site_locks` lease a job
 * holds, through the same lock API: it is acquired atomically before the
 * command does anything, renewed by heartbeats while the command runs, and
 * released when it ends. So a scheduled job can never start in the middle of
 * a long manual crawl, and a manual command never starts while a job runs.
 *
 * A manual lease has no job id; its owner names the command and the process:
 * `manual(<command>)@<hostname>:<pid>:<nonce>;start=<ms>`, where `start` is
 * the holder process's start time (owners written before it was recorded
 * have no `;start=` part and still parse). When the process crashes the lease
 * simply expires. An EXPIRED lease is not taken over while its holder process
 * is still alive on this host (a laptop that just woke up has not renewed its
 * lease yet); see `leaseHolderAliveReason`. "Alive" means the pid exists AND,
 * when the start time was recorded, the process with that pid started at that
 * time: a pid reused by another process after a crash or reboot does not keep
 * the site locked. A live holder that still does not renew is treated as hung
 * once a contender has seen its lease expired and unrenewed for a few
 * heartbeats (`MANUAL_LOCAL_STALE_AFTER_MS`, measured from that sighting, not
 * from the last heartbeat, whose age also grows while a laptop sleeps).
 * `jobs locks --release <lock> --as <name>` removes a lease whose holder is
 * verified dead (audited).
 */

export const MANUAL_LEASE_MS = 90_000;
export const MANUAL_HEARTBEAT_MS = 15_000;
/**
 * A manual lease whose holder process is verified alive on this host is
 * treated as hung (and may be taken over) once a contender has SEEN it
 * expired and unrenewed this long ago: a few heartbeats of time in which the
 * machine was awake. The heartbeat's own age is no measure for this: it also
 * grows while a laptop sleeps, and an awake holder renews within one
 * heartbeat. Sightings are audited (`lock.unrenewed_seen`).
 */
export const MANUAL_LOCAL_STALE_AFTER_MS = 4 * MANUAL_HEARTBEAT_MS;
/**
 * Upper bound on the heartbeat age of a live local holder (job or manual): an
 * expired lease whose heartbeat is older than this may be taken over even
 * without a sighting. Same value as the job runner's default.
 */
export const LOCAL_HEARTBEAT_AGE_LIMIT_MS = 6 * 3_600_000;
/** Recorded and observed start times of the same process may differ by this much (clock resolution and adjustments). */
export const PROCESS_START_TOLERANCE_MS = 60_000;
/** Audit event recorded (once per lease owner and heartbeat) when a contender sees an expired manual lease whose holder is alive. */
export const UNRENEWED_LEASE_EVENT = 'lock.unrenewed_seen';

export interface ManualLeaseOwner {
  command: string;
  hostname: string;
  pid: number;
  nonce: string;
  /** Start time of the holder process (ms since the epoch); absent in owner strings written before it was recorded. */
  startedAt?: number;
}

const OWNER_RE = /^manual\((.+)\)@(.+):(\d+):([A-Za-z0-9]+)(?:;start=(\d+))?$/;

/** Owner string of a manual command's lease. `startedAt` (the holder process's start, ms since the epoch) is recorded when given. */
export function manualLeaseOwner(command: string, host: { hostname: string; pid: number; startedAt?: number | null }, nonce: string = ulid().slice(-8)): string {
  const start = typeof host.startedAt === 'number' && Number.isFinite(host.startedAt) && host.startedAt > 0 ? `;start=${Math.round(host.startedAt)}` : '';
  return `manual(${command})@${host.hostname}:${host.pid}:${nonce}${start}`;
}

/** The command and process behind a manual lease owner string (with or without a recorded start time), or null for any other owner (e.g. a job runner). */
export function parseManualLeaseOwner(owner: string): ManualLeaseOwner | null {
  const m = OWNER_RE.exec(owner);
  if (!m) return null;
  return { command: m[1]!, hostname: m[2]!, pid: Number(m[3]), nonce: m[4]!, ...(m[5] !== undefined ? { startedAt: Number(m[5]) } : {}) };
}

export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Start time of this process (ms since the epoch). */
export function currentProcessStartedAt(): number {
  return Math.round(performance.timeOrigin);
}

/** Seconds of a `ps -o etime` value (`[[dd-]hh:]mm:ss`), or null when it does not parse. */
export function parseElapsedTime(value: string): number | null {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3_600 + Number(m[3]) * 60 + Number(m[4]);
}

/**
 * Start time (ms since the epoch) of the process that has `pid` on this host,
 * or null when it cannot be read (no such process, no `ps`, Windows). Reads
 * the elapsed time with `ps -o etime=` (POSIX; one-second resolution).
 */
export function defaultProcessStartedAt(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (pid === process.pid) return currentProcessStartedAt();
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } });
    const seconds = parseElapsedTime(out);
    return seconds === null ? null : Date.now() - seconds * 1_000;
  } catch {
    return null;
  }
}

export interface LeaseHolderCheck {
  hostname: string;
  isPidAlive: (pid: number) => boolean;
  now: Date;
  /** A live local holder is treated as hung (its expired lease may be taken over) once its heartbeat is older than this. */
  localStaleAfterMs: number;
  /**
   * Start time (ms since the epoch) of the process that now has this pid on
   * this host, or null when it cannot be read. When given, the process of a
   * manual lease that recorded its start time is alive only while the pid
   * belongs to a process started at that time (a reused pid is not the
   * holder). Omitted: only the pid is checked.
   */
  processStartedAt?: (pid: number) => number | null;
  /** A live local MANUAL holder is treated as hung once a contender saw its expired lease unrenewed this long ago. Default MANUAL_LOCAL_STALE_AFTER_MS. */
  unrenewedAfterMs?: number;
}

/** What can be said, from this host, about the process holding a lease. */
export interface LeaseHolderLiveness {
  /** alive: its process runs on this host; dead: verified gone (no such pid, or the pid now belongs to another process); unverifiable: another host or an unknown owner. */
  state: 'alive' | 'dead' | 'unverifiable';
  pid: number | null;
  hostname: string | null;
  detail: string;
}

type HostCheck = Pick<LeaseHolderCheck, 'hostname' | 'isPidAlive' | 'processStartedAt'>;

const iso = (ms: number) => new Date(ms).toISOString();

/** Liveness of one process on this host, optionally with its recorded start time. */
function processLiveness(pid: number, hostname: string, startedAt: number | undefined, check: HostCheck): LeaseHolderLiveness {
  const base = { pid, hostname };
  if (hostname !== check.hostname) return { ...base, state: 'unverifiable', detail: `process ${pid} runs on another host (${hostname}); it cannot be checked from ${check.hostname}` };
  if (!check.isPidAlive(pid)) return { ...base, state: 'dead', detail: `process ${pid} on ${hostname} is no longer running` };
  if (startedAt !== undefined && check.processStartedAt) {
    const observed = check.processStartedAt(pid);
    if (observed !== null && Math.abs(observed - startedAt) > PROCESS_START_TOLERANCE_MS) {
      return { ...base, state: 'dead', detail: `process ${pid} on ${hostname} is gone: that pid now belongs to another process (started ${iso(observed)}; the lease holder started ${iso(startedAt)})` };
    }
    if (observed !== null) return { ...base, state: 'alive', detail: `process ${pid} on ${hostname} (started ${iso(startedAt)}) is alive` };
  }
  const how = startedAt === undefined ? 'checked by pid only: the lease did not record its start time' : 'checked by pid only: its start time could not be read';
  return { ...base, state: 'alive', detail: `process ${pid} on ${hostname} is alive (${how})` };
}

/** JobRunner's default owner `<hostname>:<pid>:<nonce>`. */
const RUNNER_OWNER_RE = /^(.+):(\d+):([A-Za-z0-9]+)$/;

/**
 * Liveness of whoever holds a lease, as far as this host can tell: the
 * command's process for a manual lease (pid and, when recorded, start time),
 * the running job's recorded process for a job lease, or the runner process
 * (from its owner string) for a job lease kept after its run ended.
 */
export function leaseHolderLiveness(db: Db, siteId: string, lock: LockInfo, check: HostCheck): LeaseHolderLiveness {
  if (!lock.jobId) {
    const manual = parseManualLeaseOwner(lock.owner);
    if (!manual) return { state: 'unverifiable', pid: null, hostname: null, detail: `unknown lease owner ${lock.owner}` };
    return processLiveness(manual.pid, manual.hostname, manual.startedAt, check);
  }
  const job = db.get<{ status: string }>('SELECT status FROM jobs WHERE id = ? AND site_id = ?', [lock.jobId, siteId]);
  if (job?.status === 'running') {
    const run = db.get<{ pid: number | null; hostname: string | null }>(
      "SELECT pid, hostname FROM job_runs WHERE site_id = ? AND job_id = ? AND status = 'running' ORDER BY attempt DESC LIMIT 1",
      [siteId, lock.jobId],
    );
    if (run && run.pid !== null && run.hostname !== null) return processLiveness(run.pid, run.hostname, undefined, check);
    return { state: 'unverifiable', pid: null, hostname: null, detail: `job ${lock.jobId} is running, but no process is recorded for its run` };
  }
  const runner = RUNNER_OWNER_RE.exec(lock.owner);
  if (!runner) return { state: 'unverifiable', pid: null, hostname: null, detail: `job ${lock.jobId} is ${job?.status ?? 'missing'}; the lease owner ${lock.owner} names no process` };
  const r = processLiveness(Number(runner[2]), runner[1]!, undefined, check);
  return { ...r, detail: `job ${lock.jobId} is ${job?.status ?? 'missing'}; runner ${r.detail}` };
}

/** When a contender first saw this exact lease (same owner and heartbeat) expired while its holder process was alive (ms since the epoch), or null. */
export function unrenewedLeaseSeenAt(db: Db, siteId: string, lock: LockInfo): number | null {
  const r = db.get<{ at: string | null }>(
    `SELECT MIN(at) AS at FROM audit_events
     WHERE site_id = ? AND event_type = ? AND subject_type = 'site_lock' AND subject_id = ?
       AND json_extract(details_json, '$.owner') = ? AND json_extract(details_json, '$.heartbeatAt') = ?`,
    [siteId, UNRENEWED_LEASE_EVENT, lock.lockName, lock.owner, lock.heartbeatAt],
  );
  return r?.at ? Date.parse(r.at) : null;
}

/**
 * Record (audited, once per lease owner and heartbeat) that a contender found
 * a MANUAL lease expired while its holder process is alive on this host. The
 * `MANUAL_LOCAL_STALE_AFTER_MS` window of `leaseHolderAliveReason` starts at
 * the first sighting. Returns true when a sighting was recorded now.
 */
export function noteUnrenewedLease(db: Db, siteId: string, lock: LockInfo, check: Omit<LeaseHolderCheck, 'localStaleAfterMs'>, observer: string): boolean {
  if (lock.jobId || Date.parse(lock.expiresAt) > check.now.getTime()) return false;
  const manual = parseManualLeaseOwner(lock.owner);
  if (!manual || processLiveness(manual.pid, manual.hostname, manual.startedAt, check).state !== 'alive') return false;
  return db.transaction(() => {
    const cur = getSiteLock(db, siteId, lock.lockName);
    if (!cur || cur.owner !== lock.owner || cur.jobId !== null || cur.heartbeatAt !== lock.heartbeatAt) return false;
    if (unrenewedLeaseSeenAt(db, siteId, lock) !== null) return false;
    recordAudit(db, {
      siteId,
      actor: 'system',
      eventType: UNRENEWED_LEASE_EVENT,
      subjectType: 'site_lock',
      subjectId: lock.lockName,
      details: { owner: lock.owner, heartbeatAt: lock.heartbeatAt, expiresAt: lock.expiresAt, command: manual.command, pid: manual.pid, observer },
      at: check.now,
    });
    return true;
  });
}

/**
 * Why an EXPIRED lease must NOT be taken over, or null when it may be.
 * Refused while the holder is alive on this host and heartbeated within
 * `localStaleAfterMs`:
 * - a job lease: the job is still `running` in a live local process;
 * - a manual lease: the command's process is alive on this host (the pid
 *   exists and, when the owner recorded it, the process start time matches),
 *   and no contender saw the lease expired and unrenewed more than
 *   `unrenewedAfterMs` (a few heartbeats) ago (see `noteUnrenewedLease`).
 * Holders on another host, dead processes, reused pids, and leaked job leases
 * (the job is no longer running) may be taken over once the lease expired.
 */
export function leaseHolderAliveReason(db: Db, siteId: string, lock: LockInfo, check: LeaseHolderCheck): string | null {
  const age = check.now.getTime() - Date.parse(lock.heartbeatAt);
  if (!lock.jobId) {
    const manual = parseManualLeaseOwner(lock.owner);
    if (!manual || processLiveness(manual.pid, manual.hostname, manual.startedAt, check).state !== 'alive') return null;
    if (age > check.localStaleAfterMs) return null;
    const window = check.unrenewedAfterMs ?? MANUAL_LOCAL_STALE_AFTER_MS;
    const seen = unrenewedLeaseSeenAt(db, siteId, lock);
    if (seen !== null && check.now.getTime() - seen >= window) return null;
    const since = seen !== null ? `; seen unrenewed since ${iso(seen)}, treated as hung ${Math.round(window / 1000)}s after that` : '';
    return `manual command "${manual.command}" (process ${manual.pid} on ${manual.hostname}) is alive (lease expired ${lock.expiresAt}; it renews on its next heartbeat${since})`;
  }
  const job = db.get<{ status: string }>('SELECT status FROM jobs WHERE id = ? AND site_id = ?', [lock.jobId, siteId]);
  if (job?.status !== 'running') return null;
  const run = db.get<{ pid: number | null; hostname: string | null }>(
    "SELECT pid, hostname FROM job_runs WHERE site_id = ? AND job_id = ? AND status = 'running' ORDER BY attempt DESC LIMIT 1",
    [siteId, lock.jobId],
  );
  if (!run || run.hostname !== check.hostname || run.pid === null || !check.isPidAlive(run.pid)) return null;
  if (age > check.localStaleAfterMs) return null;
  return `holder process ${run.pid} on ${run.hostname} is alive (lease expired ${lock.expiresAt}; it renews on its next heartbeat)`;
}

/** Audit event of a lease removed by a named human because its holder process is verified dead. */
export const RELEASED_DEAD_HOLDER_EVENT = 'lock.released_dead_holder';

export interface ReleaseDeadLeaseResult {
  /**
   * released / would_release (dry run): the holder is verified dead.
   * Refused, nothing changed: not_found; holder_alive; unverifiable (another
   * host or an unknown owner); job_running (the lease's job is still recorded
   * as running: `jobs cancel` or `jobs resume` handle the job and its lease).
   */
  outcome: 'released' | 'would_release' | 'not_found' | 'holder_alive' | 'unverifiable' | 'job_running';
  lockName: string;
  lock: LockInfo | null;
  liveness: LeaseHolderLiveness | null;
  detail: string;
}

/**
 * Remove a lease whose holder process is verified dead on this host (no such
 * pid, or the pid now belongs to a process started at another time), audited
 * as `lock.released_dead_holder` by `actor` (a validated human). Everything
 * else is refused and nothing changes. Atomic: the lease is removed only while
 * it is still the one that was checked.
 */
export function releaseDeadLease(
  db: Db,
  siteId: string,
  lockName: string,
  check: HostCheck & { now: Date },
  actor: string,
  opts: { dryRun?: boolean } = {},
): ReleaseDeadLeaseResult {
  return db.transaction((): ReleaseDeadLeaseResult => {
    const lock = getSiteLock(db, siteId, lockName) ?? null;
    if (!lock) return { outcome: 'not_found', lockName, lock: null, liveness: null, detail: `No "${lockName}" lease is held for site ${siteId}.` };
    const liveness = leaseHolderLiveness(db, siteId, lock, check);
    if (lock.jobId) {
      const job = db.get<{ status: string }>('SELECT status FROM jobs WHERE id = ? AND site_id = ?', [lock.jobId, siteId]);
      if (job?.status === 'running') {
        return { outcome: 'job_running', lockName, lock, liveness, detail: `The lease belongs to job ${lock.jobId}, which is recorded as running (${liveness.detail}).` };
      }
    }
    if (liveness.state === 'alive') return { outcome: 'holder_alive', lockName, lock, liveness, detail: `${describeLeaseHolder(lock)} still holds it: ${liveness.detail}.` };
    if (liveness.state === 'unverifiable') return { outcome: 'unverifiable', lockName, lock, liveness, detail: `The holder cannot be verified dead from this host: ${liveness.detail}.` };
    if (opts.dryRun) return { outcome: 'would_release', lockName, lock, liveness, detail: liveness.detail };
    if (!releaseSiteLock(db, { siteId, lockName, owner: lock.owner, jobId: lock.jobId })) {
      return { outcome: 'not_found', lockName, lock: null, liveness: null, detail: `The "${lockName}" lease of site ${siteId} changed while it was checked; nothing was released.` };
    }
    recordAudit(db, {
      siteId,
      actor,
      eventType: RELEASED_DEAD_HOLDER_EVENT,
      subjectType: 'site_lock',
      subjectId: lockName,
      details: { owner: lock.owner, jobId: lock.jobId, heartbeatAt: lock.heartbeatAt, expiresAt: lock.expiresAt, holder: liveness.detail },
      at: check.now,
    });
    return { outcome: 'released', lockName, lock, liveness, detail: liveness.detail };
  });
}

/** Human description of whoever holds a lease (a job, a manual command, or another owner). */
export function describeLeaseHolder(lock: LockInfo): string {
  if (lock.jobId) return `job ${lock.jobId}`;
  const manual = parseManualLeaseOwner(lock.owner);
  return manual ? `manual command "${manual.command}"` : `${lock.owner}`;
}

export interface ManualSiteLeaseOptions {
  siteId: string;
  /** The command path, e.g. "sync gsc"; recorded in the owner string. */
  command: string;
  clock: Clock;
  lockName?: string;
  /** Default `manual(<command>)@<hostname>:<pid>:<nonce>;start=<ms>`. */
  owner?: string;
  hostname?: string;
  pid?: number;
  /** Start time of the holder process recorded in the owner. Default: this process's start when `pid` is this process, else not recorded. */
  startedAt?: number | null;
  isPidAlive?: (pid: number) => boolean;
  /**
   * Start time of the process that has a pid on this host (see
   * LeaseHolderCheck.processStartedAt). Default: read with `ps`, unless
   * `isPidAlive` is injected (tests), in which case only the pid is checked.
   */
  processStartedAt?: (pid: number) => number | null;
  /** Lease length. Default 90 s. */
  leaseMs?: number;
  /** Heartbeat (lease renewal) interval; must be shorter than leaseMs. Default 15 s. 0 disables the timer (tests renew by hand). */
  heartbeatMs?: number;
  /** Heartbeat-age limit for a live local holder (LeaseHolderCheck.localStaleAfterMs). Default LOCAL_HEARTBEAT_AGE_LIMIT_MS (6 h). */
  localStaleAfterMs?: number;
  /** A live local manual holder is treated as hung this long after a contender first saw its lease expired. Default MANUAL_LOCAL_STALE_AFTER_MS (4 heartbeats). */
  unrenewedAfterMs?: number;
  /** Called once when a heartbeat finds the lease was taken over (it expired while this process was suspended). */
  onLost?: (message: string) => void;
}

export type ManualLeaseResult =
  | { acquired: true; lease: ManualSiteLease; takenOverFrom?: LockInfo }
  | {
      acquired: false;
      heldBy: LockInfo;
      holder: string;
      /** Why an EXPIRED lease was not taken over (its holder is alive on this host), else null. */
      aliveReason: string | null;
      /** What this host can tell about the holder's process (for the next step shown to the owner). */
      holderLiveness: LeaseHolderLiveness;
    };

/**
 * A held manual lease. One lease may be shared by several database
 * connections of the same invocation (`join`/`leave`); it is released when
 * the last one leaves, before that connection closes.
 */
export class ManualSiteLease {
  private readonly conns: Db[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: 'held' | 'released' | 'lost' = 'held';

  private constructor(
    readonly siteId: string,
    readonly lockName: string,
    readonly owner: string,
    readonly command: string,
    private readonly leaseMs: number,
    private readonly clock: Clock,
    private readonly onLost: ((message: string) => void) | undefined,
  ) {}

  /** Acquire the site lease for a manual command (atomic; see acquireSiteLock). */
  static acquire(db: Db, opts: ManualSiteLeaseOptions): ManualLeaseResult {
    const lockName = opts.lockName ?? DEFAULT_LOCK_NAME;
    const hostname = opts.hostname ?? os.hostname();
    const pid = opts.pid ?? process.pid;
    const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
    const leaseMs = opts.leaseMs ?? MANUAL_LEASE_MS;
    const heartbeatMs = opts.heartbeatMs ?? MANUAL_HEARTBEAT_MS;
    if (heartbeatMs > 0 && heartbeatMs >= leaseMs) throw new RangeError('heartbeatMs must be shorter than leaseMs');
    const localStaleAfterMs = opts.localStaleAfterMs ?? LOCAL_HEARTBEAT_AGE_LIMIT_MS;
    const processStartedAt = opts.processStartedAt ?? (opts.isPidAlive ? undefined : defaultProcessStartedAt);
    const startedAt = opts.startedAt !== undefined ? opts.startedAt : pid === process.pid ? currentProcessStartedAt() : null;
    const owner = opts.owner ?? manualLeaseOwner(opts.command, { hostname, pid, startedAt });
    const now = opts.clock.now();
    const check: LeaseHolderCheck = {
      hostname,
      isPidAlive,
      now,
      localStaleAfterMs,
      ...(processStartedAt ? { processStartedAt } : {}),
      ...(opts.unrenewedAfterMs !== undefined ? { unrenewedAfterMs: opts.unrenewedAfterMs } : {}),
    };
    const r = acquireSiteLock(db, {
      siteId: opts.siteId,
      lockName,
      owner,
      jobId: null,
      leaseMs,
      now,
      mayTakeOver: (cur) => leaseHolderAliveReason(db, opts.siteId, cur, check) === null,
    });
    if (!r.acquired) {
      const expired = Date.parse(r.heldBy.expiresAt) <= now.getTime();
      if (expired) {
        try {
          // Starts the few-heartbeats window after which a live holder that never renews counts as hung.
          noteUnrenewedLease(db, opts.siteId, r.heldBy, check, owner);
        } catch {
          /* database busy: the next contender records the sighting */
        }
      }
      return {
        acquired: false,
        heldBy: r.heldBy,
        holder: describeLeaseHolder(r.heldBy),
        aliveReason: expired ? leaseHolderAliveReason(db, opts.siteId, r.heldBy, check) : null,
        holderLiveness: leaseHolderLiveness(db, opts.siteId, r.heldBy, check),
      };
    }
    const lease = new ManualSiteLease(opts.siteId, lockName, owner, opts.command, leaseMs, opts.clock, opts.onLost);
    lease.conns.push(db);
    if (heartbeatMs > 0) {
      lease.timer = setInterval(() => {
        try {
          lease.renew();
        } catch {
          /* database busy or closed: the lease simply runs out */
        }
      }, heartbeatMs);
      lease.timer.unref?.();
    }
    return { acquired: true, lease, ...(r.takenOverFrom ? { takenOverFrom: r.takenOverFrom } : {}) };
  }

  get held(): boolean {
    return this.state === 'held';
  }

  get lost(): boolean {
    return this.state === 'lost';
  }

  /** Connections currently sharing this lease. */
  get connections(): number {
    return this.conns.length;
  }

  /**
   * Another connection of the same invocation (a second context for the same
   * site) shares the lease; re-entry by the same owner extends it. Returns
   * false when the lease is no longer held.
   */
  join(db: Db): boolean {
    if (this.state !== 'held') return false;
    const r = acquireSiteLock(db, { siteId: this.siteId, lockName: this.lockName, owner: this.owner, jobId: null, leaseMs: this.leaseMs, now: this.clock.now(), mayTakeOver: () => false });
    if (!r.acquired || r.lock.owner !== this.owner) {
      this.markLost();
      return false;
    }
    if (!this.conns.includes(db)) this.conns.push(db);
    return true;
  }

  /** A connection is about to close: the lease is released when it is the last one. */
  leave(db: Db): void {
    const i = this.conns.indexOf(db);
    if (i < 0) return;
    if (this.conns.length === 1) this.release(); // while `db` is still open
    this.conns.splice(i, 1);
  }

  /** Extend the lease. Returns false (and reports the loss once) when another holder took it over. */
  renew(): boolean {
    if (this.state !== 'held') return false;
    const db = this.openConnection();
    if (!db) return false;
    const ok = renewSiteLock(db, { siteId: this.siteId, lockName: this.lockName, owner: this.owner, jobId: null, leaseMs: this.leaseMs, now: this.clock.now() });
    if (!ok) this.markLost();
    return ok;
  }

  /** Release the lease if this command still holds it; stops the heartbeat. Idempotent. */
  release(): boolean {
    this.stop();
    if (this.state !== 'held') return false;
    this.state = 'released';
    const db = this.openConnection();
    if (!db) return false; // every connection is closed: the lease runs out on its own
    try {
      return releaseSiteLock(db, { siteId: this.siteId, lockName: this.lockName, owner: this.owner, jobId: null });
    } catch {
      return false;
    }
  }

  private markLost(): void {
    this.stop();
    if (this.state !== 'held') return;
    this.state = 'lost';
    this.onLost?.(
      `The ${this.lockName} lease of site ${this.siteId} held by manual command "${this.command}" was lost (it expired, e.g. while this process was suspended, and another runner took it over). A job of this site may now run alongside this command.`,
    );
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private openConnection(): Db | undefined {
    return this.conns.find((c) => c.raw.isOpen);
  }
}
