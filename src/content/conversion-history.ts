import type { AppContext } from '../app/context.js';

/**
 * Conversion history for the low-data bootstrap, computed from the SAME
 * query as the bootstrap's `conversion_data` readiness check (stored GA4
 * event rows for the configured primary events). Stored rows are stated
 * with their count and date range; they belong to the existing site and are
 * never attributed to pages the bootstrap proposes. Absence is stated, never
 * assumed away.
 */

export const NO_CONVERSION_HISTORY_STATEMENT = 'No historical conversion evidence exists for this site in the stored data; none is assumed. Measure after publication.';

export interface ConversionHistory {
  /** Stored GA4 event rows for the primary events (0 when none, or when no primary event is configured). */
  rows: number;
  events: string[];
  firstDate: string | null;
  lastDate: string | null;
  /** Human-readable statement used in readiness checks, the offer item, and briefs. */
  statement: string;
  label: 'OBSERVED' | 'DATA_UNAVAILABLE';
}

export function conversionHistory(ctx: Pick<AppContext, 'db' | 'siteId' | 'config'>): ConversionHistory {
  const events = ctx.config.conversions.primaryEvents.map((e) => e.name);
  if (!events.length) {
    return { rows: 0, events, firstDate: null, lastDate: null, statement: `${NO_CONVERSION_HISTORY_STATEMENT} No primary conversion event is configured (conversions.primaryEvents).`, label: 'DATA_UNAVAILABLE' };
  }
  const r = ctx.db.get<{ n: number; first: string | null; last: string | null }>(
    `SELECT COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM ga4_event_daily_current WHERE site_id = ? AND event_name IN (${events.map(() => '?').join(', ')})`,
    [ctx.siteId, ...events],
  );
  const rows = Number(r?.n ?? 0);
  if (!rows) return { rows: 0, events, firstDate: null, lastDate: null, statement: NO_CONVERSION_HISTORY_STATEMENT, label: 'DATA_UNAVAILABLE' };
  const firstDate = r?.first ?? null;
  const lastDate = r?.last ?? null;
  return {
    rows,
    events,
    firstDate,
    lastDate,
    statement:
      `${rows} stored GA4 row(s) for the primary event(s) ${events.join(', ')}${firstDate && lastDate ? ` dated ${firstDate} to ${lastDate}` : ''}` +
      ' (rows span channel views and landing pages; they are not summed here). This is conversion history of the existing site: it is NOT attributed to the pages proposed here. Measure the new pages after publication.',
    label: 'OBSERVED',
  };
}
