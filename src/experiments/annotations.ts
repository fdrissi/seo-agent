import type { Clock } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { recordAudit } from '../database/audit.js';
import type { Db } from '../database/db.js';
import { listExperiments } from './repository.js';

/**
 * External-change annotations (template/site changes, critical fixes,
 * algorithm updates, tracking changes, outages, campaigns, seasonality).
 * They are recorded by a human (or by the system when it performs a
 * recorded override) and flag every experiment whose measurement they can
 * interfere with.
 */

export const ANNOTATION_SCOPES = ['page', 'template', 'site', 'external'] as const;
export type AnnotationScope = (typeof ANNOTATION_SCOPES)[number];
export const ANNOTATION_KINDS = ['site_change', 'template_change', 'critical_fix', 'algorithm_update', 'tracking_change', 'seasonality', 'outage', 'campaign', 'other'] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

export interface AnnotationRecord {
  id: string;
  siteId: string;
  pageId: string | null;
  scope: AnnotationScope;
  kind: AnnotationKind;
  occurredAt: string;
  description: string;
  source: string | null;
  overridesFreeze: boolean;
  recordedBy: string;
  createdAt: string;
}

interface AnnotationRow {
  id: string;
  site_id: string;
  page_id: string | null;
  scope: AnnotationScope;
  kind: AnnotationKind;
  occurred_at: string;
  description: string;
  source: string | null;
  overrides_freeze: number;
  recorded_by: string;
  created_at: string;
}

const toRecord = (r: AnnotationRow): AnnotationRecord => ({
  id: r.id,
  siteId: r.site_id,
  pageId: r.page_id,
  scope: r.scope,
  kind: r.kind,
  occurredAt: r.occurred_at,
  description: r.description,
  source: r.source,
  overridesFreeze: r.overrides_freeze === 1,
  recordedBy: r.recorded_by,
  createdAt: r.created_at,
});

export const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Parse an ISO-8601 instant that carries an explicit zone (Z or +hh:mm). Returns normalized UTC ISO. */
export function parseInstant(value: string, label: string): string {
  const v = (value ?? '').trim();
  if (!ISO_INSTANT_RE.test(v)) throw new AppError('VALIDATION_FAILED', `${label} must be an ISO-8601 timestamp with an explicit zone, e.g. 2026-09-20T14:30:00Z or 2026-09-20T17:30:00+03:00 (got "${value}").`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new AppError('VALIDATION_FAILED', `${label} is not a valid timestamp: ${value}`);
  return d.toISOString();
}

export interface AnnotationInput {
  siteId: string;
  scope: AnnotationScope;
  kind: AnnotationKind;
  occurredAt: string;
  description: string;
  pageId?: string | null;
  source?: string | null;
  overridesFreeze?: boolean;
  recordedBy: string;
}

export function recordAnnotation(db: Db, clock: Clock, input: AnnotationInput): { annotation: AnnotationRecord; affectedExperiments: Array<{ id: string; status: string; pageId: string | null }> } {
  if (!(ANNOTATION_SCOPES as readonly string[]).includes(input.scope)) throw new AppError('VALIDATION_FAILED', `Unknown annotation scope "${input.scope}". Use one of ${ANNOTATION_SCOPES.join(', ')}.`);
  if (!(ANNOTATION_KINDS as readonly string[]).includes(input.kind)) throw new AppError('VALIDATION_FAILED', `Unknown annotation kind "${input.kind}". Use one of ${ANNOTATION_KINDS.join(', ')}.`);
  if (!input.description?.trim()) throw new AppError('VALIDATION_FAILED', 'An annotation needs a description.');
  if (input.scope === 'page' && !input.pageId) throw new AppError('VALIDATION_FAILED', 'A page-scoped annotation needs a page (--page <url-or-page-id>).');
  const occurredAt = parseInstant(input.occurredAt, 'occurredAt');
  if (new Date(occurredAt).getTime() > clock.now().getTime()) throw new AppError('VALIDATION_FAILED', 'An annotation records a change that already happened; the time cannot be in the future.');
  const id = newId('ann');
  const createdAt = clock.now().toISOString();
  return db.transaction(() => {
    db.run(
      `INSERT INTO change_annotations (id, site_id, page_id, scope, kind, occurred_at, description, source, overrides_freeze, recorded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.siteId, input.pageId ?? null, input.scope, input.kind, occurredAt, input.description.trim(), input.source ?? null, input.overridesFreeze ? 1 : 0, input.recordedBy, createdAt],
    );
    const affected = affectedExperiments(db, input.siteId, { scope: input.scope, pageId: input.pageId ?? null });
    recordAudit(db, {
      siteId: input.siteId,
      actor: input.recordedBy,
      eventType: 'experiment.annotation_recorded',
      subjectType: 'change_annotation',
      subjectId: id,
      details: { scope: input.scope, kind: input.kind, occurredAt, pageId: input.pageId ?? null, overridesFreeze: !!input.overridesFreeze, affectedExperiments: affected.map((a) => a.id) },
      at: clock.now(),
    });
    const row = db.get<AnnotationRow>('SELECT * FROM change_annotations WHERE id = ?', [id])!;
    return { annotation: toRecord(row), affectedExperiments: affected };
  });
}

/** Experiments whose measurement a change with this scope can interfere with (currently observing or about to). */
export function affectedExperiments(db: Db, siteId: string, a: { scope: AnnotationScope; pageId: string | null }): Array<{ id: string; status: string; pageId: string | null }> {
  const exps = listExperiments(db, siteId, { statuses: ['awaiting_implementation', 'observing'] });
  return exps
    .filter((e) => a.scope !== 'page' || e.pageId === a.pageId || e.comparisonPages.some((c) => c.pageId === a.pageId))
    .map((e) => ({ id: e.id, status: e.status, pageId: e.pageId }));
}

export function annotationsBetween(db: Db, siteId: string, fromIso: string, toIso: string): AnnotationRecord[] {
  return db.all<AnnotationRow>('SELECT * FROM change_annotations WHERE site_id = ? AND occurred_at >= ? AND occurred_at <= ? ORDER BY occurred_at', [siteId, fromIso, toIso]).map(toRecord);
}

export function listAnnotations(db: Db, siteId: string, limit = 100): AnnotationRecord[] {
  return db.all<AnnotationRow>('SELECT * FROM change_annotations WHERE site_id = ? ORDER BY occurred_at DESC LIMIT ?', [siteId, limit]).map(toRecord);
}
