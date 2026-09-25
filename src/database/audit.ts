import { redact } from '../security/redact.js';
import type { Db } from './db.js';

export interface AuditEvent {
  siteId: string | null;
  actor: string;
  eventType: string;
  subjectType?: string;
  subjectId?: string;
  traceId?: string;
  details?: Record<string, unknown>;
  at?: Date;
}

/** Append an event to the append-only audit log (details are redacted). */
export function recordAudit(db: Db, e: AuditEvent): void {
  db.run(
    `INSERT INTO audit_events (site_id, at, actor, event_type, subject_type, subject_id, trace_id, details_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      e.siteId,
      (e.at ?? new Date()).toISOString(),
      e.actor,
      e.eventType,
      e.subjectType ?? null,
      e.subjectId ?? null,
      e.traceId ?? null,
      e.details ? JSON.stringify(redact(e.details)) : null,
    ],
  );
}

export function listAudit(db: Db, siteId: string, limit = 100): Array<Record<string, unknown>> {
  return db.all('SELECT * FROM audit_events WHERE site_id = ? ORDER BY id DESC LIMIT ?', [siteId, limit]);
}
