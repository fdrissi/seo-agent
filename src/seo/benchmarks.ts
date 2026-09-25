import { observed, unavailable, type Measured } from '../core/measured.js';
import type { Db } from '../database/db.js';
import { rateScaleUnverifiedReason, type Ga4Scope } from './metrics.js';

/**
 * Comparable-segment benchmarks built from THIS site's own data. No external
 * "industry CTR curve" is assumed. When there is not enough comparable data,
 * the benchmark is unavailable and the caller must not infer weakness.
 */

export interface PositionBucket {
  label: string;
  /** inclusive lower bound */
  min: number;
  /** exclusive upper bound */
  max: number;
}

export const POSITION_BUCKETS: readonly PositionBucket[] = [
  { label: '1', min: 0, max: 1.5 },
  { label: '2', min: 1.5, max: 2.5 },
  { label: '3', min: 2.5, max: 3.5 },
  { label: '4-5', min: 3.5, max: 5.5 },
  { label: '6-10', min: 5.5, max: 10.5 },
  { label: '11-20', min: 10.5, max: 20.5 },
  { label: '21+', min: 20.5, max: Number.POSITIVE_INFINITY },
];

export function bucketOf(position: number): PositionBucket {
  return POSITION_BUCKETS.find((b) => position >= b.min && position < b.max) ?? POSITION_BUCKETS[POSITION_BUCKETS.length - 1]!;
}

export interface CtrUnit {
  pageId: string | null;
  clicks: number;
  impressions: number;
  position: number | null;
  branded: boolean;
}

interface Acc {
  clicks: number;
  impressions: number;
  units: number;
}

const key = (bucket: string, branded: boolean) => `${branded ? 'b' : 'n'}|${bucket}`;

/**
 * CTR benchmark per position bucket, separately for branded and
 * non-branded units, with the evaluated page's own units excluded.
 */
export class CtrBenchmarks {
  private readonly totals = new Map<string, Acc>();
  private readonly byPage = new Map<string, Map<string, Acc>>();

  constructor(
    units: readonly CtrUnit[],
    private readonly minImpressions: number,
    private readonly minOtherUnits = 2,
  ) {
    for (const u of units) {
      if (u.position === null || u.impressions <= 0) continue;
      const k = key(bucketOf(u.position).label, u.branded);
      const t = this.totals.get(k) ?? { clicks: 0, impressions: 0, units: 0 };
      t.clicks += u.clicks;
      t.impressions += u.impressions;
      t.units += 1;
      this.totals.set(k, t);
      if (u.pageId) {
        const pm = this.byPage.get(u.pageId) ?? new Map<string, Acc>();
        const p = pm.get(k) ?? { clicks: 0, impressions: 0, units: 0 };
        p.clicks += u.clicks;
        p.impressions += u.impressions;
        p.units += 1;
        pm.set(k, p);
        this.byPage.set(u.pageId, pm);
      }
    }
  }

  expected(position: number | undefined, branded: boolean, excludePageId: string | null): Measured<number> {
    if (position === undefined) return unavailable('position unavailable');
    const b = bucketOf(position);
    const k = key(b.label, branded);
    const t = this.totals.get(k);
    const own = excludePageId ? this.byPage.get(excludePageId)?.get(k) : undefined;
    const clicks = (t?.clicks ?? 0) - (own?.clicks ?? 0);
    const impressions = (t?.impressions ?? 0) - (own?.impressions ?? 0);
    const units = (t?.units ?? 0) - (own?.units ?? 0);
    const label = `${branded ? 'branded' : 'non-branded'} position ${b.label}`;
    if (units < this.minOtherUnits) return unavailable(`fewer than ${this.minOtherUnits} comparable ${label} units on other pages`);
    if (impressions < this.minImpressions) return unavailable(`only ${impressions} comparable ${label} impressions on other pages (< ${this.minImpressions})`);
    return observed(Math.round((clicks / impressions) * 1e6) / 1e6);
  }
}

/**
 * Site google_organic primary-event session conversion rate, excluding one
 * page. Available only when every contributing row reports the rate and all
 * rows use one configured primary event (same rule as metrics.aggregateGa4).
 * Rates stored with scale 'undetermined' are never used as fractions (see
 * metrics.rateScaleClass): such rows make the benchmark unavailable and do not
 * count as converting sessions.
 */
export class ConversionBenchmark {
  private readonly byPage = new Map<string, { sessions: number; converting: number; bad: number; unverified: number }>();
  private total = { sessions: 0, converting: 0, bad: 0, unverified: 0 };
  private events = new Set<string>();

  constructor(db: Db, siteId: string, scope: Ga4Scope) {
    // Stored value as a fraction: 'percent' (defensive) is divided by 100; 'fraction', 'percent_normalized', and NULL (legacy 0..1 contract) are used as stored.
    const frac = `(CASE WHEN primary_session_rate_scale = 'percent' THEN primary_session_rate / 100.0 ELSE primary_session_rate END)`;
    const verified = `primary_session_rate_scale IS NOT 'undetermined'`;
    const rows = db.all<{ page_id: string | null; sessions: number; converting: number | null; bad: number; unverified: number; events: string | null }>(
      `SELECT page_id, SUM(sessions) AS sessions,
              SUM(CASE WHEN primary_session_rate_status = 'observed' AND ${verified} AND ${frac} BETWEEN 0 AND 1 THEN ${frac} * sessions END) AS converting,
              SUM(CASE WHEN sessions > 0 AND (primary_session_rate_status != 'observed' OR primary_session_rate IS NULL OR (${verified} AND (${frac} < 0 OR ${frac} > 1))) THEN 1 ELSE 0 END) AS bad,
              SUM(CASE WHEN sessions > 0 AND primary_session_rate_status = 'observed' AND primary_session_rate IS NOT NULL AND primary_session_rate_scale = 'undetermined' THEN 1 ELSE 0 END) AS unverified,
              GROUP_CONCAT(DISTINCT primary_event_name) AS events
         FROM ga4_landing_daily
        WHERE site_id = ? AND is_current = 1 AND is_complete = 1 AND property_id = ? AND channel_view = ? AND segment_key = ? AND date BETWEEN ? AND ?
        GROUP BY page_id`,
      [siteId, scope.propertyId, scope.channelView, scope.segmentKey ?? '', scope.start, scope.end],
    );
    for (const r of rows) {
      const v = { sessions: r.sessions, converting: r.converting ?? 0, bad: r.bad, unverified: r.unverified };
      if (r.page_id) this.byPage.set(r.page_id, v);
      this.total.sessions += v.sessions;
      this.total.converting += v.converting;
      this.total.bad += v.bad;
      this.total.unverified += v.unverified;
      for (const e of (r.events ?? '').split(',').filter(Boolean)) this.events.add(e);
    }
    this.configured = scope.configuredPrimaryEvents;
  }

  private readonly configured: readonly string[];

  /** Largest per-page converting-session total (reference for log scaling in scoring). */
  maxPageConverting(): number {
    let m = 0;
    for (const v of this.byPage.values()) if (v.converting > m) m = v.converting;
    return m;
  }

  rate(excludePageId: string | null): Measured<number> {
    if (this.configured.length === 0) return unavailable('no primary conversion event configured');
    if (this.events.size > 1) return unavailable(`rows report different primary events (${[...this.events].join(', ')})`);
    const [ev] = [...this.events];
    if (ev && !this.configured.includes(ev)) return unavailable(`rows report event "${ev}", which is not a configured primary event`);
    const own = excludePageId ? this.byPage.get(excludePageId) : undefined;
    const sessions = this.total.sessions - (own?.sessions ?? 0);
    const converting = this.total.converting - (own?.converting ?? 0);
    const bad = this.total.bad - (own?.bad ?? 0);
    const unverified = this.total.unverified - (own?.unverified ?? 0);
    if (unverified > 0) return unavailable(rateScaleUnverifiedReason('sessionKeyEventRate:<event>', `${unverified} site row(s); benchmark not computed`));
    if (bad > 0) return unavailable(`primary-event session rate not observed for ${bad} site row(s); benchmark not computed`);
    if (sessions <= 0) return unavailable('no other google_organic sessions to benchmark against');
    return observed(Math.round((converting / sessions) * 1e6) / 1e6);
  }
}
