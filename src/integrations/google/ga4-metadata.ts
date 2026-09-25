import type { AppContext } from '../../app/context.js';
import { validateApproverName } from '../../approvals/approver.js';
import { AppError, ValidationError } from '../../core/errors.js';
import { hashObject } from '../../core/hash.js';
import { newId } from '../../core/ids.js';
import { recordAudit } from '../../database/audit.js';
import { parseJson } from '../../database/db.js';
import type { Ga4Metadata } from './ga4-client.js';
import { VERSIONED_KEYS, type SqlValue } from './versioned.js';

/**
 * GA4 metadata cache and metric-availability planning.
 *
 * Per-event metrics are discovered at runtime from getMetadata:
 *  - `sessionKeyEventRate:<event>` is documented and listed only for key events.
 *  - `keyEvents:<event>` is NOT documented as an API name (unverified); it is
 *    used only when getMetadata lists it.
 * When the primary-event rate is unavailable the limitation is reported. No
 * substitute rate is computed: event counts are never divided by sessions,
 * and the "any key event" rate is never silently used in its place.
 */

export interface CompactMetadata {
  dimensions: string[];
  metrics: { apiName: string; type: string | null; blockedReasons: string[] }[];
}

export function compactMetadata(m: Ga4Metadata): CompactMetadata {
  return {
    dimensions: (m.dimensions ?? []).map((d) => d.apiName).filter((n): n is string => typeof n === 'string').sort(),
    metrics: (m.metrics ?? [])
      .filter((x) => typeof x?.apiName === 'string')
      .map((x) => ({ apiName: x.apiName, type: x.type ?? null, blockedReasons: (x.blockedReasons ?? []).filter((r) => r && r !== 'BLOCKED_REASON_UNSPECIFIED') }))
      .sort((a, b) => a.apiName.localeCompare(b.apiName)),
  };
}

export function cacheGa4Metadata(ctx: AppContext, propertyId: string, compact: CompactMetadata, info: { timeZone: string | null; currencyCode: string | null }): void {
  ctx.db.run(
    `INSERT INTO ga4_property_metadata (site_id, property_id, time_zone, currency_code, metadata_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (site_id, property_id) DO UPDATE SET time_zone = COALESCE(excluded.time_zone, ga4_property_metadata.time_zone),
       currency_code = COALESCE(excluded.currency_code, ga4_property_metadata.currency_code), metadata_json = excluded.metadata_json, fetched_at = excluded.fetched_at`,
    [ctx.siteId, propertyId, info.timeZone, info.currencyCode, JSON.stringify(compact), ctx.clock.now().toISOString()],
  );
}

export function loadCachedGa4Metadata(ctx: AppContext, propertyId: string): { timeZone: string | null; currencyCode: string | null; metadata: CompactMetadata | null; fetchedAt: string } | null {
  const row = ctx.db.get<{ time_zone: string | null; currency_code: string | null; metadata_json: string | null; fetched_at: string }>(
    'SELECT time_zone, currency_code, metadata_json, fetched_at FROM ga4_property_metadata WHERE site_id = ? AND property_id = ?',
    [ctx.siteId, propertyId],
  );
  if (!row) return null;
  return { timeZone: row.time_zone, currencyCode: row.currency_code, metadata: parseJson<CompactMetadata | null>(row.metadata_json, null), fetchedAt: row.fetched_at };
}

export interface MetricLimitation {
  metric: string;
  status: 'unavailable';
  reason: string;
}

export interface Ga4MetricPlan {
  primaryEvent: string | null;
  /** `keyEvents:<primary>` when getMetadata lists it (API name undocumented). */
  primaryKeyEventsMetric: string | null;
  /** Explicitly labelled alternative: `keyEvents` with an eventName filter for the primary event. */
  primaryKeyEventsAlternative: string | null;
  /** `sessionKeyEventRate:<primary>` when listed (only key events are listed). */
  primaryRateMetric: string | null;
  /** `userKeyEventRate:<primary>`: share of users who triggered the primary key event (period grain only; non-additive). */
  primaryUserRateMetric: string | null;
  revenueMetric: 'totalRevenue' | 'purchaseRevenue' | null;
  coreMetrics: string[];
  /** Per configured event: whether getMetadata lists it as a key event. */
  keyEventListed: Record<string, boolean>;
  limitations: MetricLimitation[];
}

/**
 * Configured primary events after the first one. Only the first primary event
 * carries the session key-event rate, converting sessions, routing, the
 * conversion benchmark, and experiment conversion metrics; the others are
 * stored as event counts (ga4_event_daily) only. Reported as a limitation.
 */
export function unusedPrimaryEvents(primary: readonly string[]): string[] {
  const [first, ...rest] = [...new Set(primary)];
  return first === undefined ? [] : rest;
}

export function unusedPrimaryEventsReason(used: string, unused: readonly string[]): string {
  return `primary event(s) ${unused.map((e) => `"${e}"`).join(', ')} are not used for conversion rates: only the first configured primary event "${used}" gets a session key-event rate, converting sessions, routing, the conversion benchmark, and experiment conversion metrics. The other primary events are stored as event counts (ga4_event_daily) only, never as conversions. List the event that should drive conversion decisions first in conversions.primaryEvents.`;
}

export function planGa4Metrics(meta: CompactMetadata, events: { primary: string[]; secondary: string[] }, incompatible: ReadonlySet<string> = new Set()): Ga4MetricPlan {
  const byName = new Map(meta.metrics.map((m) => [m.apiName, m]));
  const dims = new Set(meta.dimensions);
  const usable = (name: string) => byName.has(name) && !incompatible.has(name);
  const limitations: MetricLimitation[] = [];
  const primaryEvent = events.primary[0] ?? null;
  const keyEventListed: Record<string, boolean> = {};
  for (const e of [...events.primary, ...events.secondary]) keyEventListed[e] = byName.has(`sessionKeyEventRate:${e}`) || byName.has(`keyEvents:${e}`);

  const coreMetrics = ['sessions', 'engagedSessions', 'keyEvents'].filter((m) => {
    if (usable(m)) return true;
    limitations.push({ metric: m, status: 'unavailable', reason: byName.has(m) ? 'Incompatible with the session-scoped landing-page dimensions (checkCompatibility).' : 'Not listed by getMetadata for this property.' });
    return false;
  });

  let primaryRateMetric: string | null = null;
  let primaryUserRateMetric: string | null = null;
  let primaryKeyEventsMetric: string | null = null;
  let primaryKeyEventsAlternative: string | null = null;
  const unused = unusedPrimaryEvents(events.primary);
  if (primaryEvent && unused.length) {
    limitations.push({ metric: unused.map((e) => `sessionKeyEventRate:${e}`).join(', '), status: 'unavailable', reason: unusedPrimaryEventsReason(primaryEvent, unused) });
  }
  if (!primaryEvent) {
    limitations.push({ metric: 'sessionKeyEventRate:<primary event>', status: 'unavailable', reason: 'No primary event is configured (conversions.primaryEvents); no conversion rate is reported.' });
  } else {
    const rate = `sessionKeyEventRate:${primaryEvent}`;
    if (usable(rate)) primaryRateMetric = rate;
    else {
      limitations.push({
        metric: rate,
        status: 'unavailable',
        reason: byName.has(rate)
          ? 'Listed by getMetadata but incompatible with the report dimensions (checkCompatibility).'
          : `getMetadata does not list ${rate}. The event "${primaryEvent}" is probably not marked as a key event in GA4 (or has no data yet). No substitute rate is reported: the "any key event" rate (sessionKeyEventRate) is NOT used in its place and event counts are NOT divided by sessions.`,
      });
    }
    const userRate = `userKeyEventRate:${primaryEvent}`;
    if (usable(userRate)) primaryUserRateMetric = userRate;
    else limitations.push({ metric: userRate, status: 'unavailable', reason: `getMetadata does not list ${userRate}; the share of users who triggered "${primaryEvent}" is not reported (users are never derived from event counts).` });
    const count = `keyEvents:${primaryEvent}`;
    if (usable(count)) primaryKeyEventsMetric = count;
    else if (keyEventListed[primaryEvent] && usable('keyEvents') && dims.has('eventName') && !incompatible.has('eventName')) {
      primaryKeyEventsAlternative = `keyEvents filtered by eventName = "${primaryEvent}"`;
    } else {
      limitations.push({
        metric: count,
        status: 'unavailable',
        reason: `Per-event key-event count for "${primaryEvent}" is unavailable (not listed by getMetadata and the event is not listed as a key event). Event occurrences are still recorded in ga4_event_daily as event counts, not conversions.`,
      });
    }
  }

  let revenueMetric: Ga4MetricPlan['revenueMetric'] = null;
  const revenueReasons: string[] = [];
  for (const name of ['totalRevenue', 'purchaseRevenue'] as const) {
    const m = byName.get(name);
    if (!m) {
      revenueReasons.push(`${name} not listed by getMetadata`);
      continue;
    }
    if (m.blockedReasons.includes('NO_REVENUE_METRICS')) {
      revenueReasons.push(`${name} is blocked for this identity (NO_REVENUE_METRICS); GA4 would return zeros, so it is not requested`);
      continue;
    }
    if (incompatible.has(name)) {
      revenueReasons.push(`${name} is incompatible with the report dimensions`);
      continue;
    }
    revenueMetric = name;
    break;
  }
  if (!revenueMetric) limitations.push({ metric: 'totalRevenue', status: 'unavailable', reason: `Revenue unavailable: ${revenueReasons.join('; ')}.` });

  return { primaryEvent, primaryKeyEventsMetric, primaryKeyEventsAlternative, primaryRateMetric, primaryUserRateMetric, revenueMetric, coreMetrics, keyEventListed, limitations };
}

/**
 * Per-property memory of the key-event rate scale (migration 0100). The API
 * docs call sessionKeyEventRate / userKeyEventRate "percentages" without
 * saying 0-1 or 0-100 (unverified). A value above 1 proves 0-100; that finding
 * is sticky so later syncs (where every value may be <= 1) store rates on the
 * same scale. The maximum of the values alone never proves 0-1, so this
 * record stays 'undetermined' until a value above 1 appears; the other ways
 * the scale is established (owner confirmation, integer consistency of small
 * daily rows) are recorded in ga4_rate_scale_confirmations (migration 0320,
 * see `loadRateScaleConfirmation`).
 */
export interface StoredRateScale {
  scale: 'percent_0_100' | 'undetermined';
  /** Highest raw rate value ever observed for this property (before normalization). */
  maxObserved: number | null;
  detectedAt: string | null;
}

export function loadRateScale(ctx: AppContext, propertyId: string): StoredRateScale | null {
  const row = ctx.db.get<{ key_event_rate_scale: string | null; key_event_rate_scale_json: string | null }>(
    'SELECT key_event_rate_scale, key_event_rate_scale_json FROM ga4_property_metadata WHERE site_id = ? AND property_id = ?',
    [ctx.siteId, propertyId],
  );
  if (!row?.key_event_rate_scale) return null;
  const evidence = parseJson<{ maxObserved?: unknown; detectedAt?: unknown } | null>(row.key_event_rate_scale_json, null);
  return {
    scale: row.key_event_rate_scale === 'percent_0_100' ? 'percent_0_100' : 'undetermined',
    maxObserved: typeof evidence?.maxObserved === 'number' ? evidence.maxObserved : null,
    detectedAt: typeof evidence?.detectedAt === 'string' ? evidence.detectedAt : null,
  };
}

export function saveRateScale(ctx: AppContext, propertyId: string, scale: StoredRateScale): void {
  ctx.db.run(
    'UPDATE ga4_property_metadata SET key_event_rate_scale = ?, key_event_rate_scale_json = ? WHERE site_id = ? AND property_id = ?',
    [scale.scale, JSON.stringify({ maxObserved: scale.maxObserved, detectedAt: scale.detectedAt }), ctx.siteId, propertyId],
  );
}

// ---------------------------------------------------------------------------
// Establishing the key-event rate scale (migration 0320)
// ---------------------------------------------------------------------------

/** Scale of a property's key-event rates once established: 'fraction' = 0-1, 'percent' = 0-100. */
export type ConfirmedRateScale = 'fraction' | 'percent';
export type RateScaleBasis = 'owner_assertion' | 'integer_consistency';

export interface RateScaleConfirmation {
  id: string;
  propertyId: string;
  scale: ConfirmedRateScale;
  basis: RateScaleBasis;
  evidence: string;
  evidenceDetail: unknown;
  actor: string;
  confirmedAt: string;
  remarked: RemarkResult | null;
  synthetic: boolean;
}

/** Stored rate rows re-marked (as new revisions) when the scale was established. */
export interface RemarkResult {
  landingRows: number;
  periodRows: number;
}

type SiteDb = Pick<AppContext, 'db' | 'siteId'>;

/** The latest confirmation recorded for the property (the latest one counts), or null. */
export function loadRateScaleConfirmation(ctx: SiteDb, propertyId: string): RateScaleConfirmation | null {
  const row = ctx.db.get<{ id: string; property_id: string; scale: string; basis: string; evidence: string; evidence_json: string | null; actor: string; confirmed_at: string; remarked_json: string | null; is_synthetic: number }>(
    'SELECT id, property_id, scale, basis, evidence, evidence_json, actor, confirmed_at, remarked_json, is_synthetic FROM ga4_rate_scale_confirmations WHERE site_id = ? AND property_id = ? ORDER BY confirmed_at DESC, rowid DESC LIMIT 1',
    [ctx.siteId, propertyId],
  );
  if (!row) return null;
  return {
    id: row.id,
    propertyId: row.property_id,
    scale: row.scale === 'percent' ? 'percent' : 'fraction',
    basis: row.basis === 'integer_consistency' ? 'integer_consistency' : 'owner_assertion',
    evidence: row.evidence,
    evidenceDetail: parseJson<unknown>(row.evidence_json, null),
    actor: row.actor,
    confirmedAt: row.confirmed_at,
    remarked: parseJson<RemarkResult | null>(row.remarked_json, null),
    synthetic: row.is_synthetic === 1,
  };
}

/**
 * The property's effective key-event rate scale: a value above 1 ever
 * observed (0-100 proven by data) wins; otherwise the latest confirmation
 * (owner assertion or integer consistency); otherwise 'undetermined'.
 * `contradiction` is set when a fraction confirmation is contradicted by an
 * observed value above 1.
 */
export interface EffectiveRateScale {
  scale: ConfirmedRateScale | 'undetermined';
  source: 'observed_above_1' | RateScaleBasis | 'none';
  maxObserved: number | null;
  confirmation: RateScaleConfirmation | null;
  contradiction: string | null;
}

export function effectiveRateScale(ctx: SiteDb, propertyId: string): EffectiveRateScale {
  const row = ctx.db.get<{ key_event_rate_scale: string | null; key_event_rate_scale_json: string | null }>(
    'SELECT key_event_rate_scale, key_event_rate_scale_json FROM ga4_property_metadata WHERE site_id = ? AND property_id = ?',
    [ctx.siteId, propertyId],
  );
  const evidence = parseJson<{ maxObserved?: unknown } | null>(row?.key_event_rate_scale_json ?? null, null);
  const maxObserved = typeof evidence?.maxObserved === 'number' ? evidence.maxObserved : null;
  const confirmation = loadRateScaleConfirmation(ctx, propertyId);
  if (row?.key_event_rate_scale === 'percent_0_100' || (maxObserved !== null && maxObserved > 1)) {
    const contradiction = confirmation?.scale === 'fraction' ? `the ${confirmation.basis === 'owner_assertion' ? 'owner' : 'integer-consistency'} confirmation of a 0-1 scale (${confirmation.confirmedAt}) is contradicted: GA4 reported a key-event rate above 1${maxObserved !== null ? ` (max ${maxObserved})` : ''}, which proves 0-100` : null;
    return { scale: 'percent', source: 'observed_above_1', maxObserved, confirmation, contradiction };
  }
  if (confirmation) return { scale: confirmation.scale, source: confirmation.basis, maxObserved, confirmation, contradiction: null };
  return { scale: 'undetermined', source: 'none', maxObserved, confirmation: null, contradiction: null };
}

/** Highest stored raw rate value (current rows) still marked 'undetermined' or 'fraction' for the property. */
function maxStoredUnnormalizedRate(ctx: SiteDb, propertyId: string): number | null {
  const a = ctx.db.get<{ m: number | null }>(
    "SELECT MAX(primary_session_rate) AS m FROM ga4_landing_daily WHERE site_id = ? AND property_id = ? AND is_current = 1 AND primary_session_rate IS NOT NULL AND primary_session_rate_scale IN ('undetermined', 'fraction')",
    [ctx.siteId, propertyId],
  )?.m ?? null;
  const b = ctx.db.get<{ m: number | null }>(
    "SELECT MAX(value) AS m FROM ga4_period_metrics WHERE site_id = ? AND property_id = ? AND is_current = 1 AND value IS NOT NULL AND rate_scale IN ('undetermined', 'fraction')",
    [ctx.siteId, propertyId],
  )?.m ?? null;
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** Non-key columns the GA4 sync writes per table (the row hash covers key + these values). */
const HASHED_VALUES: Record<'ga4_landing_daily' | 'ga4_period_metrics', readonly string[]> = {
  ga4_landing_daily: [
    'date_tz',
    'sessions',
    'engaged_sessions',
    'key_events',
    'primary_event_name',
    'primary_key_events',
    'primary_key_events_status',
    'primary_session_rate',
    'primary_session_rate_status',
    'primary_session_rate_scale',
    'revenue_micros',
    'revenue_currency',
    'revenue_status',
    'metric_names_json',
    'is_complete',
  ],
  ga4_period_metrics: ['date_tz', 'value', 'value_status', 'rate_scale', 'is_complete'],
};

const tableColumnCache = new WeakMap<object, Map<string, string[]>>();

function tableColumns(db: AppContext['db'], table: string): string[] {
  let byTable = tableColumnCache.get(db);
  if (!byTable) {
    byTable = new Map();
    tableColumnCache.set(db, byTable);
  }
  let cols = byTable.get(table);
  if (!cols) {
    cols = db.all<{ name: string }>('SELECT name FROM pragma_table_info(?)', [table]).map((c) => c.name);
    byTable.set(table, cols);
  }
  return cols;
}

type Row = Record<string, SqlValue> & { id: number };

/**
 * Write `row` again as a new current revision with `overrides`, keeping its
 * batch, collection time, page mapping, and every other column; the replaced
 * revision stays in the table (is_current = 0). No new collection happened,
 * so superseded_by_batch_id is the row's own batch and the transformation
 * version records why the revision exists.
 */
function reviseInPlace(db: AppContext['db'], table: 'ga4_landing_daily' | 'ga4_period_metrics', siteId: string, row: Row, overrides: Record<string, SqlValue>, transformationSuffix: string): void {
  const keyCols = VERSIONED_KEYS[table];
  const next: Record<string, SqlValue> = { ...row, ...overrides };
  const key = Object.fromEntries(keyCols.map((c) => [c, next[c] ?? null]));
  const values = Object.fromEntries(HASHED_VALUES[table].map((c) => [c, next[c] ?? null]));
  const maxRevision = db.get<{ r: number | null }>(`SELECT MAX(revision) AS r FROM ${table} WHERE site_id = ? AND ${keyCols.map((c) => `${c} = ?`).join(' AND ')}`, [siteId, ...keyCols.map((c) => row[c] ?? null)])?.r ?? 0;
  next.revision = maxRevision + 1;
  next.is_current = 1;
  next.row_hash = hashObject({ key, values });
  next.superseded_by_batch_id = null;
  next.transformation_version = `${String(row.transformation_version ?? '')}${transformationSuffix}`;
  db.run(`UPDATE ${table} SET is_current = 0, superseded_by_batch_id = ? WHERE id = ? AND site_id = ?`, [row.batch_id ?? null, row.id, siteId]);
  const cols = tableColumns(db, table).filter((c) => c !== 'id');
  db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => next[c] ?? null));
}

function remarkedMetricNames(json: SqlValue, marker: string): SqlValue {
  if (typeof json !== 'string') return json;
  const o = parseJson<Record<string, unknown> | null>(json, null);
  if (!o || typeof o !== 'object' || !('primarySessionRateScale' in o) || o.primarySessionRateScale === null) return json;
  return JSON.stringify({ ...o, primarySessionRateScale: marker });
}

/**
 * Re-mark stored key-event rates of a property once its scale is
 * established. Current rows whose marker is in `from` are written again as
 * new revisions (the earlier revision is kept):
 *  - to 'fraction': 'undetermined' values unchanged; 'percent_normalized'
 *    values x 100 (only reachable after an owner's earlier percent
 *    confirmation, because a fraction scale is refused once a value above 1
 *    was observed);
 *  - to 'percent': 'undetermined' / 'fraction' values / 100, marked
 *    'percent_normalized'.
 * With `dryRun` nothing is written and the counts are what would change.
 * Must run inside a transaction when combined with other writes.
 */
export function remarkStoredRates(ctx: SiteDb, propertyId: string, target: ConfirmedRateScale, sourceId: string, opts: { dryRun?: boolean; onlyUndetermined?: boolean } = {}): RemarkResult {
  const from = opts.onlyUndetermined ? ['undetermined'] : target === 'fraction' ? ['undetermined', 'percent_normalized'] : ['undetermined', 'fraction'];
  const marker = target === 'fraction' ? 'fraction' : 'percent_normalized';
  const convert = (value: number, scale: SqlValue): number => {
    if (target === 'percent') return value / 100;
    return scale === 'percent_normalized' ? value * 100 : value;
  };
  const suffix = `+rate-scale:${target}@${sourceId}`;
  const ph = from.map(() => '?').join(', ');
  const landing = ctx.db.all<Row>(
    `SELECT * FROM ga4_landing_daily WHERE site_id = ? AND property_id = ? AND is_current = 1 AND primary_session_rate IS NOT NULL AND primary_session_rate_scale IN (${ph}) ORDER BY id`,
    [ctx.siteId, propertyId, ...from],
  );
  const period = ctx.db.all<Row>(
    `SELECT * FROM ga4_period_metrics WHERE site_id = ? AND property_id = ? AND is_current = 1 AND value IS NOT NULL AND rate_scale IN (${ph}) ORDER BY id`,
    [ctx.siteId, propertyId, ...from],
  );
  if (!opts.dryRun) {
    ctx.db.transaction(() => {
      for (const r of landing) {
        reviseInPlace(
          ctx.db,
          'ga4_landing_daily',
          ctx.siteId,
          r,
          { primary_session_rate: convert(Number(r.primary_session_rate), r.primary_session_rate_scale ?? null), primary_session_rate_scale: marker, metric_names_json: remarkedMetricNames(r.metric_names_json ?? null, marker) },
          suffix,
        );
      }
      for (const r of period) reviseInPlace(ctx.db, 'ga4_period_metrics', ctx.siteId, r, { value: convert(Number(r.value), r.rate_scale ?? null), rate_scale: marker }, suffix);
    });
  }
  return { landingRows: landing.length, periodRows: period.length };
}

/**
 * Integer-consistency proof of a 0-1 scale from stored daily rows. A session
 * key-event rate is (sessions in which the event occurred) / sessions, so
 * rate x sessions must be a whole number of converting sessions. On a row with
 * 1-99 sessions and a rate in (0, 1]:
 *  - on a 0-100 scale the converting sessions would be rate x sessions / 100,
 *    strictly between 0 and 1: impossible (one converting session on 99
 *    sessions is already a rate above 1 on that scale);
 *  - on a 0-1 scale rate x sessions is a whole number >= 1.
 * 0-1 is proven only when at least `minRows` such rows are consistent with it
 * and NONE is inconsistent (a single inconsistent row means the stored values
 * do not follow that definition, so nothing is decided). Values above 1 are
 * handled by the "above 1 proves 0-100" rule and stop this check. Rates of 0
 * say nothing about the scale and are ignored. Never a guess: when the rows do
 * not decide, the scale stays undetermined.
 */
export interface IntegerConsistencyResult {
  decided: 'fraction' | null;
  consistentRows: number;
  inconsistentRows: number;
  examples: Array<{ date: string | null; landingPage: string | null; sessions: number; rate: number; convertingSessions: number }>;
  reason: string;
}

export const INTEGER_CONSISTENCY = { maxSessions: 99, minRows: 5, tolerance: 0.02 } as const;

export function integerConsistencyScale(rows: ReadonlyArray<{ sessions: number; rate: number; date?: string | null; landingPage?: string | null }>, opts: Partial<typeof INTEGER_CONSISTENCY> = {}): IntegerConsistencyResult {
  const maxSessions = opts.maxSessions ?? INTEGER_CONSISTENCY.maxSessions;
  const minRows = opts.minRows ?? INTEGER_CONSISTENCY.minRows;
  const tolerance = opts.tolerance ?? INTEGER_CONSISTENCY.tolerance;
  if (rows.some((r) => Number.isFinite(r.rate) && r.rate > 1)) {
    return { decided: null, consistentRows: 0, inconsistentRows: 0, examples: [], reason: 'a stored rate above 1 proves 0-100 (not decided by this check)' };
  }
  let consistent = 0;
  let inconsistent = 0;
  const examples: IntegerConsistencyResult['examples'] = [];
  for (const r of rows) {
    if (!Number.isInteger(r.sessions) || r.sessions < 1 || r.sessions > maxSessions) continue;
    if (!Number.isFinite(r.rate) || r.rate <= 0) continue;
    const product = r.rate * r.sessions;
    const k = Math.round(product);
    if (k >= 1 && k <= r.sessions && Math.abs(product - k) <= tolerance) {
      consistent++;
      if (examples.length < 5) examples.push({ date: r.date ?? null, landingPage: r.landingPage ?? null, sessions: r.sessions, rate: r.rate, convertingSessions: k });
    } else inconsistent++;
  }
  if (inconsistent > 0) return { decided: null, consistentRows: consistent, inconsistentRows: inconsistent, examples, reason: `${inconsistent} small row(s) have rate x sessions that is not a whole number of converting sessions, so the stored rates do not decide the scale` };
  if (consistent < minRows) return { decided: null, consistentRows: consistent, inconsistentRows: 0, examples, reason: `only ${consistent} small row(s) (1-${maxSessions} sessions, rate between 0 and 1) to check; at least ${minRows} are required` };
  return {
    decided: 'fraction',
    consistentRows: consistent,
    inconsistentRows: 0,
    examples,
    reason: `on ${consistent} daily row(s) with 1-${maxSessions} sessions, rate x sessions is a whole number of converting sessions (0-1 scale); on a 0-100 scale each would be a fraction of one session, which is impossible`,
  };
}

/** Run the integer-consistency check over the property's current daily landing rows still marked 'undetermined'. */
export function integerConsistencyFromStoredRows(ctx: SiteDb, propertyId: string): IntegerConsistencyResult {
  const rows = ctx.db.all<{ date: string; landing_page: string; sessions: number; rate: number }>(
    `SELECT date, landing_page, sessions, primary_session_rate AS rate FROM ga4_landing_daily
      WHERE site_id = ? AND property_id = ? AND is_current = 1 AND primary_session_rate_status = 'observed' AND primary_session_rate IS NOT NULL
        AND primary_session_rate_scale = 'undetermined' AND segment_key = ''`,
    [ctx.siteId, propertyId],
  );
  return integerConsistencyScale(rows.map((r) => ({ sessions: r.sessions, rate: r.rate, date: r.date, landingPage: r.landing_page })));
}

export interface ConfirmRateScaleInput {
  scale: ConfirmedRateScale;
  /** What the owner compared (for example the GA4 interface value for a named page and date). Required. */
  evidence: string;
  /**
   * Who asserts it. For an owner assertion (the default basis): a named human,
   * `owner:<name>` or `<name>`, validated like an approver name (automation
   * identities such as cli, system, scheduler, model, agent, claude, and
   * generic account names such as owner, "owner:owner", admin, or root are
   * refused). An integer-consistency proof is recorded by the sync ('system').
   */
  actor: string;
  basis?: RateScaleBasis;
  evidenceDetail?: unknown;
  dryRun?: boolean;
  synthetic?: boolean;
  /** Trace id for the audit log (ctx.runId). */
  traceId?: string;
}

export interface ConfirmRateScaleResult {
  propertyId: string;
  scale: ConfirmedRateScale;
  basis: RateScaleBasis;
  dryRun: boolean;
  confirmationId: string | null;
  previous: RateScaleConfirmation | null;
  remarked: RemarkResult;
  notes: string[];
}

export const MIN_RATE_SCALE_EVIDENCE_LENGTH = 10;

/**
 * Record how the key-event rate scale of a property was established (append-
 * only row + audit event) and re-mark the stored rates that were waiting for
 * it. Refuses a 0-1 (fraction) confirmation once any value above 1 was
 * observed or is stored on an unnormalized scale: that proves 0-100.
 */
export function confirmRateScale(ctx: AppContext, propertyId: string, input: ConfirmRateScaleInput): ConfirmRateScaleResult {
  const evidence = input.evidence.replace(/\s+/g, ' ').trim();
  const basis = input.basis ?? 'owner_assertion';
  if (input.scale !== 'fraction' && input.scale !== 'percent') throw new ValidationError(`Unknown rate scale "${String(input.scale)}". Use fraction (GA4 reports 0-1) or percent (GA4 reports 0-100).`);
  // An owner assertion is a named human's statement: no automation identity can record one (C1-13), and
  // neither can the anonymous actor "owner" / "owner:owner" or a generic account name (D3-01).
  if (basis === 'owner_assertion') validateApproverName(input.actor.replace(/^owner:/, ''));
  if (evidence.length < MIN_RATE_SCALE_EVIDENCE_LENGTH) {
    throw new AppError('VALIDATION_FAILED', 'Confirming the GA4 key-event rate scale needs --evidence: say what you compared (at least 10 characters).', {
      hint: 'Example: --evidence "GA4 UI shows 2.5% session key event rate for /pricing on 2026-09-15; stored value 0.025". The text is kept in the audit log.',
    });
  }
  const stored = loadRateScale(ctx, propertyId);
  const maxStored = maxStoredUnnormalizedRate(ctx, propertyId);
  const maxSeen = Math.max(stored?.maxObserved ?? Number.NEGATIVE_INFINITY, maxStored ?? Number.NEGATIVE_INFINITY);
  if (input.scale === 'fraction' && (stored?.scale === 'percent_0_100' || maxSeen > 1)) {
    throw new AppError('VALIDATION_FAILED', `GA4 key-event rates of property ${propertyId} cannot be on a 0-1 scale: a value above 1 (max ${Number.isFinite(maxSeen) ? maxSeen : 'recorded'}) was observed, which proves 0-100. Nothing was recorded.`, {
      hint: 'If the GA4 interface shows the same number as a percentage, confirm `--confirm-rate-scale percent` instead.',
      details: { propertyId, storedScale: stored?.scale ?? null, maxObserved: Number.isFinite(maxSeen) ? maxSeen : null },
    });
  }
  const previous = loadRateScaleConfirmation(ctx, propertyId);
  const notes: string[] = [];
  if (previous && previous.scale !== input.scale) notes.push(`This replaces the earlier ${previous.basis === 'owner_assertion' ? 'owner' : 'integer-consistency'} confirmation (${previous.scale}, ${previous.confirmedAt}); rates it re-marked are re-marked again.`);
  if (input.scale === 'percent' && stored?.scale === 'percent_0_100') notes.push('A value above 1 had already proven 0-100 for this property; the confirmation is recorded for the audit trail.');
  if (input.dryRun) {
    const remarked = remarkStoredRates(ctx, propertyId, input.scale, 'dry-run', { dryRun: true });
    notes.push('Dry run: nothing was recorded or re-marked.');
    return { propertyId, scale: input.scale, basis, dryRun: true, confirmationId: null, previous, remarked, notes };
  }
  const id = newId('ga4rs');
  const at = ctx.clock.now().toISOString();
  let remarked: RemarkResult = { landingRows: 0, periodRows: 0 };
  ctx.db.transaction(() => {
    remarked = remarkStoredRates(ctx, propertyId, input.scale, id);
    ctx.db.run(
      `INSERT INTO ga4_rate_scale_confirmations (id, site_id, property_id, scale, basis, evidence, evidence_json, actor, remarked_json, is_synthetic, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ctx.siteId, propertyId, input.scale, basis, evidence, input.evidenceDetail === undefined ? null : JSON.stringify(input.evidenceDetail), input.actor, JSON.stringify(remarked), input.synthetic ? 1 : 0, at],
    );
    recordAudit(ctx.db, {
      siteId: ctx.siteId,
      actor: input.actor,
      eventType: 'google.ga4.rate_scale_confirmed',
      subjectType: 'ga4_property',
      subjectId: propertyId,
      ...(input.traceId ? { traceId: input.traceId } : {}),
      details: { confirmationId: id, scale: input.scale, basis, evidence, evidenceDetail: input.evidenceDetail ?? null, remarked, previous: previous ? { id: previous.id, scale: previous.scale, basis: previous.basis, confirmedAt: previous.confirmedAt } : null },
      at: ctx.clock.now(),
    });
  });
  return { propertyId, scale: input.scale, basis, dryRun: false, confirmationId: id, previous, remarked, notes };
}
