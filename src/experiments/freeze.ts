import type { Db } from '../database/db.js';
import { normalizeUrl } from '../seo/url.js';
import { findPageByRef, toExperiment, type ExperimentRow } from './repository.js';
import type { ExperimentRecord, ExperimentStatus } from './types.js';

/**
 * One meaningful change per target page at a time (spec 23).
 *
 * A page is "held" by every experiment on it that is not terminal:
 * - `observing`: the change is live and being measured. Any other production
 *   change to the page contaminates the measurement, so it is refused unless
 *   a human records a critical-fix override (critical broken functionality).
 * - `proposed`, `approved`, `awaiting_implementation`: another change is
 *   queued for the page. A second proposal is refused (same override rule);
 *   exports and implementation records of other subjects warn.
 *
 * Experiments are matched by page id or by normalized target URL (which also
 * covers experiments without a page id, e.g. a new page). A target URL is
 * resolved to a page by id, exact URL, or established alias.
 */

export const OPEN_EXPERIMENT_STATUSES: readonly ExperimentStatus[] = ['proposed', 'approved', 'awaiting_implementation', 'observing'];

export interface PageFreeze {
  pageId: string | null;
  /** Experiments whose change is live and being observed on this page. */
  observing: ExperimentRecord[];
  /** Experiments queued for this page (proposed, approved, awaiting implementation). */
  pending: ExperimentRecord[];
}

function sameUrl(a: string, b: string): boolean {
  return (normalizeUrl(a)?.url ?? a) === (normalizeUrl(b)?.url ?? b);
}

export function pageFreeze(db: Db, siteId: string, target: { pageId: string | null; url: string }, opts: { excludeExperimentId?: string | null } = {}): PageFreeze {
  const pageId = target.pageId ?? findPageByRef(db, siteId, target.url)?.id ?? null;
  const rows = db.all<ExperimentRow & { target_url: string | null }>(
    `SELECT e.*, c.target_url AS target_url FROM experiments e LEFT JOIN experiment_changes c ON c.experiment_id = e.id AND c.site_id = e.site_id
     WHERE e.site_id = ? AND e.status IN (${OPEN_EXPERIMENT_STATUSES.map(() => '?').join(', ')}) AND e.id != ?
     ORDER BY e.created_at`,
    [siteId, ...OPEN_EXPERIMENT_STATUSES, opts.excludeExperimentId ?? ''],
  );
  const matching = rows.filter((r) => (pageId !== null && r.page_id === pageId) || (!!r.target_url && sameUrl(r.target_url, target.url)));
  const exps = matching.map((r) => toExperiment(r));
  return { pageId, observing: exps.filter((e) => e.status === 'observing'), pending: exps.filter((e) => e.status !== 'observing') };
}

export function describeHolders(exps: ExperimentRecord[]): string {
  return exps.map((e) => `${e.id} (${e.status})`).join(', ');
}
