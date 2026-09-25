import { systemClock, type Clock } from '../core/clock.js';
import { newId } from '../core/ids.js';
import { hashObject } from '../core/hash.js';
import { redact } from '../security/redact.js';
import type { Db } from '../database/db.js';

export type ProviderRequestStatus = 'prepared' | 'submitted' | 'succeeded' | 'failed' | 'ambiguous' | 'reconciled' | 'skipped';

export interface ProviderRequestRow {
  id: string;
  site_id: string;
  provider: string;
  endpoint: string;
  method: string;
  is_paid: number;
  request_hash: string;
  status: ProviderRequestStatus;
  external_id: string | null;
  reservation_id: string | null;
  created_at: string;
}

/**
 * Log of outbound provider requests. Paid submissions follow:
 *   prepared -> submitted -> succeeded | failed | ambiguous
 * A request whose outcome is unknown (timeout/network error after sending)
 * is 'ambiguous' and must be reconciled against provider history before any
 * resubmission. External ids (task/run ids) are persisted immediately.
 */
export class ProviderRequestLog {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock = systemClock,
  ) {}

  prepare(input: {
    siteId: string;
    provider: string;
    endpoint: string;
    method: string;
    isPaid: boolean;
    params: unknown;
    reservationId?: string | null;
    jobId?: string | null;
    traceId?: string | null;
    idempotencyKey?: string | null;
    isSynthetic?: boolean;
  }): { id: string; requestHash: string } {
    const id = newId('preq');
    const requestHash = hashObject(redact(input.params));
    this.db.run(
      `INSERT INTO provider_requests (id, site_id, provider, endpoint, method, is_paid, request_hash, idempotency_key, status, reservation_id, job_id, trace_id, is_synthetic, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?)`,
      [
        id,
        input.siteId,
        input.provider,
        input.endpoint,
        input.method,
        input.isPaid ? 1 : 0,
        requestHash,
        input.idempotencyKey ?? null,
        input.reservationId ?? null,
        input.jobId ?? null,
        input.traceId ?? null,
        input.isSynthetic ? 1 : 0,
        this.clock.now().toISOString(),
      ],
    );
    return { id, requestHash };
  }

  markSubmitted(id: string): void {
    this.db.run(`UPDATE provider_requests SET status = 'submitted', submitted_at = ? WHERE id = ?`, [this.clock.now().toISOString(), id]);
  }

  /** Persist the provider's task/run id as soon as it is known. */
  setExternalId(id: string, externalId: string): void {
    this.db.run('UPDATE provider_requests SET external_id = ? WHERE id = ?', [externalId, id]);
  }

  complete(id: string, input: { status: 'succeeded' | 'failed' | 'ambiguous' | 'reconciled' | 'skipped'; httpStatus?: number | null; error?: unknown; rawRef?: string | null; externalId?: string | null }): void {
    this.db.run(
      `UPDATE provider_requests SET status = ?, http_status = COALESCE(?, http_status), error_json = ?, raw_ref = COALESCE(?, raw_ref),
         external_id = COALESCE(?, external_id), completed_at = ? WHERE id = ?`,
      [
        input.status,
        input.httpStatus ?? null,
        input.error === undefined ? null : JSON.stringify(redact(input.error instanceof Error ? { name: input.error.name, message: input.error.message } : input.error)),
        input.rawRef ?? null,
        input.externalId ?? null,
        this.clock.now().toISOString(),
        id,
      ],
    );
  }

  /** Paid requests with the same parameters that may still be in flight or ambiguous. */
  findOpenDuplicates(siteId: string, provider: string, endpoint: string, requestHash: string): ProviderRequestRow[] {
    return this.db.all<ProviderRequestRow>(
      `SELECT * FROM provider_requests WHERE site_id = ? AND provider = ? AND endpoint = ? AND request_hash = ? AND status IN ('prepared', 'submitted', 'ambiguous') ORDER BY created_at`,
      [siteId, provider, endpoint, requestHash],
    );
  }

  listAmbiguous(siteId: string): ProviderRequestRow[] {
    return this.db.all<ProviderRequestRow>(`SELECT * FROM provider_requests WHERE site_id = ? AND status = 'ambiguous' ORDER BY created_at`, [siteId]);
  }

  get(id: string): ProviderRequestRow | undefined {
    return this.db.get<ProviderRequestRow>('SELECT * FROM provider_requests WHERE id = ?', [id]);
  }
}
