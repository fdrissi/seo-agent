import { parseJson } from '../database/db.js';
import { formatMoney, formatUsd } from '../core/money.js';
import { incomplete, missing, observed as measuredObserved, unavailable as measuredUnavailable, type Measured } from '../core/measured.js';
import { addDays, dateInZone, daysBetweenInclusive } from '../core/time.js';
import type { BuildEnv } from './env.js';
import { PROBLEM_STATES, addDq, batchLinks, batchSourceIds, configLink, markSynthetic, pipelineStage, reportSectionLink } from './env.js';
import {
  claim,
  dbQueryLink,
  inferred,
  observed,
  recommendation,
  recordLink,
  section,
  unavailable,
  type AccessIssue,
  type Claim,
  type ConfidenceAssessment,
  type EvidenceLink,
  type ExperimentSummary,
  type FreshnessEntry,
  type Ga4ChannelTotals,
  type GscTotals,
  type NextActionSummary,
  type PrimaryActionSummary,
  type PrimaryEventUsers,
  type RateScaleAssertion,
  type ReportSection,
  type ReportTable,
} from './model.js';
import { aggregateByDimension, ctr, fmtInt, fmtPct, fmtPos, fmtSignedPct, isBrandedQuery, pctChange, round, share, weightedPosition, weightedPositionFromSums } from './metrics.js';
import {
  activeExperiments,
  batchCoverage,
  claimEvidenceFor,
  contentQueue,
  countAnnotations,
  draftsAwaitingOwner,
  datasetDateRange,
  extractWarnings,
  ga4ChannelAggregate,
  ga4MetadataFlags,
  ga4PeriodMetrics,
  ga4PeriodsWithMetric,
  ga4PropertyTimeZone,
  gscAvailability,
  gscPageMetrics,
  gscPropertyRows,
  gscSegmentRows,
  gscTopPages,
  gscUnattributed,
  gscVisibleQueries,
  isLiveRecommendation,
  jobPrimaryRecommendation,
  latestCrawl,
  latestPrimaryRecommendation,
  latestTimestamp,
  pageImpressionsSince,
  pageSessionsSince,
  pendingApprovals,
  recentBatches,
  secondaryRecommendations,
  unknownCostCounts,
  type ClaimEvidenceRow,
  type ExperimentRow,
  type PeriodMetricRow,
  type RecommendationRow,
} from './queries.js';
import { rateScaleUnverifiedReason, rateToFraction } from '../seo/metrics.js';
import { ga4BatchRowLoss, describeRowLoss } from '../seo/coverage.js';
import { effectiveRateScale, unusedPrimaryEvents, unusedPrimaryEventsReason } from '../integrations/google/ga4-metadata.js';
/** The `sync ga4 --confirm-rate-scale ... --as "<your name>"` command, spelled out for next steps (one definition). */
import { CONFIRM_RATE_SCALE_COMMAND } from '../integrations/google/rate-scale-command.js';
import type { LinkTarget } from './links.js';
import type { ClaimLabel } from '../core/modes.js';

const GSC_DOC_TZ = 'America/Los_Angeles';

// ---------------------------------------------------------------------------
// Search Console
// ---------------------------------------------------------------------------

export function gscTotalsFor(env: BuildEnv, property: string, searchType: string, start: string, end: string): Measured<GscTotals> {
  const { db, siteId } = env.ctx;
  const rows = gscPropertyRows(db, siteId, property, searchType, start, end);
  const cov = batchCoverage(db, siteId, 'gsc_property_daily', start, end, { property, gscSearchType: searchType });
  const final = rows.filter((r) => r.is_final === 1);
  const excluded = rows.length - final.length;
  for (const r of rows) markSynthetic(env, 'gsc_property_daily', r.is_synthetic);
  for (const b of cov.batches) markSynthetic(env, 'ingestion_batches', b.is_synthetic);
  const batchIds = [...new Set([...final.map((r) => r.batch_id), ...cov.batches.map((b) => b.id)])];
  const clicks = final.reduce((a, r) => a + r.clicks, 0);
  const impressions = final.reduce((a, r) => a + r.impressions, 0);
  const totals: GscTotals = {
    property,
    searchType,
    dateTz: final[0]?.date_tz ?? rows[0]?.date_tz ?? null,
    start,
    end,
    daysWithData: new Set(final.map((r) => r.date)).size,
    expectedDays: daysBetweenInclusive(start, end),
    clicks,
    impressions,
    ctr: round(ctr(clicks, impressions)),
    position: round(weightedPosition(final.map((r) => ({ position: r.position, impressions: r.impressions }))), 3),
    excludedIncompleteRows: excluded,
    batchIds,
    collectedAt: [...new Set([...final.map((r) => r.collected_at), ...cov.batches.map((b) => b.finished_at ?? b.started_at)])],
    synthetic: rows.some((r) => r.is_synthetic === 1),
    uncoveredDates: cov.uncovered,
  };
  for (const id of batchIds) env.sourceBatchIds.add(id);
  if (final.length === 0) {
    if (excluded > 0) return incomplete(`only incomplete (non-final) Search Console days exist for ${start} to ${end}; they are excluded from comparisons`);
    if (cov.batches.length === 0) return missing(`no Search Console property totals were ingested for search type ${searchType}, ${start} to ${end}`);
    if (cov.uncovered.length > 0) return incomplete(`${cov.uncovered.length} of ${totals.expectedDays} days were not covered by a successful sync`, totals);
    return measuredObserved(totals); // covered by successful syncs of THIS search type, no rows: Search Console reported no data (a real zero)
  }
  if (cov.uncovered.length > 0) return incomplete(`${cov.uncovered.length} of ${totals.expectedDays} days were not covered by a successful sync`, totals);
  if (excluded > 0) return incomplete(`${excluded} non-final (incomplete) day(s) were excluded from totals`, totals);
  return measuredObserved(totals);
}

function gscEvidence(env: BuildEnv, t: { property: string; searchType: string; start: string; end: string }): EvidenceLink {
  return dbQueryLink('gsc_property_daily_current', { site_id: env.ctx.siteId, property: t.property, search_type: t.searchType, date: `${t.start}..${t.end}`, is_final: 1 });
}

function totalsOf<T>(m: Measured<T>): T | null {
  if (m.status === 'observed') return m.value;
  if (m.status === 'incomplete' && m.partialValue !== undefined) return m.partialValue;
  return null;
}

export function gscSection(env: BuildEnv): ReportSection {
  const { period } = env;
  const { property, searchType, others } = env.gsc;
  const claims: Claim[] = [];
  const tables: ReportTable[] = [];
  const notes: string[] = [
    'Property totals (byProperty), page totals (byPage), and visible query rows are separate datasets and are never summed together.',
    'CTR is computed as clicks / impressions; average position is impression-weighted and is not a live ranking.',
  ];
  if (!property) {
    const reason = env.ctx.config.google.searchConsoleProperty
      ? 'no Search Console data has been ingested'
      : 'no Search Console property is configured (google.searchConsoleProperty) and no Search Console data has been ingested';
    claims.push(unavailable('gsc.totals.current', 'Search Console performance for the period is unavailable.', reason));
    env.data.gsc = { property: null, searchType, current: missing(reason), previous: null, otherProperties: [] };
    return section('gsc_performance', 'Search Console performance', { claims, notes });
  }
  const cur = gscTotalsFor(env, property, searchType, period.start, period.end);
  const prev = period.comparison ? gscTotalsFor(env, property, searchType, period.comparison.start, period.comparison.end) : null;
  env.data.gsc = { property, searchType, current: cur, previous: prev, otherProperties: others };
  const ct = totalsOf(cur);
  if (ct) {
    const partial = cur.status !== 'observed' ? ` (partial: ${cur.status === 'incomplete' ? cur.reason : ''})` : '';
    const base = { sourceIds: batchSourceIds(ct.batchIds), retrievedAt: ct.collectedAt, evidence: [gscEvidence(env, ct), ...batchLinks(ct.batchIds)], synthetic: ct.synthetic };
    const scope = `${property}, search type ${searchType}, ${ct.daysWithData} of ${ct.expectedDays} days with final data`;
    claims.push(observed('gsc.clicks.current', `Clicks: ${fmtInt(ct.clicks)} (${scope})${partial}.`, { ...base, metricIds: ['gsc.clicks'] }));
    claims.push(observed('gsc.impressions.current', `Impressions: ${fmtInt(ct.impressions)}${partial}.`, { ...base, metricIds: ['gsc.impressions'] }));
    claims.push(
      ct.ctr === null
        ? unavailable('gsc.ctr.current', 'CTR is undefined for the period.', 'no impressions were recorded', { metricIds: ['gsc.ctr'] })
        : observed('gsc.ctr.current', `CTR: ${fmtPct(ct.ctr)} (clicks / impressions from summed counts)${partial}.`, { ...base, metricIds: ['gsc.ctr'] }),
    );
    claims.push(
      ct.position === null
        ? unavailable('gsc.position.current', 'Average position is unavailable for the period.', 'no impressions with a reported position', { metricIds: ['gsc.position'] })
        : observed('gsc.position.current', `Average position: ${fmtPos(ct.position)} (impression-weighted aggregate, not a live ranking)${partial}.`, { ...base, metricIds: ['gsc.position'] }),
    );
    if (ct.excludedIncompleteRows > 0) {
      addDq(env, { severity: 'info', code: 'gsc_incomplete_excluded', message: `${ct.excludedIncompleteRows} non-final Search Console day(s) in the period were excluded from totals.`, source: 'gsc' });
    }
    if (cur.status === 'incomplete') {
      addDq(env, { severity: 'warning', code: 'gsc_partial_period', message: `Search Console property totals are partial: ${cur.reason}.`, source: 'gsc', nextStep: 'Run `sync gsc` for the missing dates.' });
    }
  } else {
    claims.push(unavailable('gsc.totals.current', 'Search Console property totals for the period are unavailable.', cur.status === 'observed' ? 'unknown' : cur.reason, { metricIds: ['gsc.clicks', 'gsc.impressions'] }));
    addDq(env, { severity: 'warning', code: 'gsc_totals_missing', message: `Search Console property totals unavailable: ${cur.status === 'observed' ? '' : cur.reason}.`, source: 'gsc', nextStep: 'Run `sync gsc`; do not use page or query rows as a substitute for property totals.' });
  }
  // Comparison (only complete vs complete)
  if (period.comparison && prev) {
    const pt = prev.status === 'observed' ? prev.value : null;
    if (cur.status === 'observed' && pt) {
      const cv = cur.value;
      const src = [...batchSourceIds(cv.batchIds), ...batchSourceIds(pt.batchIds)];
      claims.push(
        observed(
          'gsc.clicks.change',
          `Clicks vs ${period.comparison.label.toLowerCase()} (${period.comparison.start} to ${period.comparison.end}): ${fmtInt(cv.clicks)} vs ${fmtInt(pt.clicks)} (${fmtSignedPct(pctChange(cv.clicks, pt.clicks))}); impressions ${fmtInt(cv.impressions)} vs ${fmtInt(pt.impressions)} (${fmtSignedPct(pctChange(cv.impressions, pt.impressions))}); CTR ${fmtPct(cv.ctr)} vs ${fmtPct(pt.ctr)}; position ${fmtPos(cv.position)} vs ${fmtPos(pt.position)}.`,
          { sourceIds: src, retrievedAt: [...cv.collectedAt, ...pt.collectedAt], metricIds: ['gsc.clicks', 'gsc.impressions', 'gsc.ctr', 'gsc.position'], evidence: [gscEvidence(env, cv), gscEvidence(env, pt)], synthetic: cv.synthetic || pt.synthetic },
        ),
      );
    } else {
      claims.push(
        unavailable('gsc.clicks.change', 'Period-over-period Search Console comparison is not shown.', `both periods must be complete; current: ${cur.status}${cur.status !== 'observed' ? ` (${cur.reason})` : ''}; previous: ${prev.status}${prev.status !== 'observed' ? ` (${prev.reason})` : ''}`, { metricIds: ['gsc.clicks'] }),
      );
    }
  }
  if (others.length) {
    notes.push(`Data also exists for other Search Console properties (${others.join(', ')}); they are not combined with ${property}.`);
    addDq(env, { severity: 'info', code: 'gsc_other_properties', message: `Search Console data exists for other properties (${others.join(', ')}); only ${property} is reported.`, source: 'gsc' });
  }

  // Top pages (byPage)
  const pages = gscTopPages(env.ctx.db, env.ctx.siteId, property, searchType, period.start, period.end, env.topN);
  markSynthetic(env, 'gsc_page_daily', pages.synthetic);
  if (pages.rows.length) {
    tables.push({
      id: 'gsc.top_pages',
      title: `Top ${pages.rows.length} of ${pages.totalPages} pages by clicks (byPage; not additive with property totals)`,
      columns: ['Page', 'Clicks', 'Impressions', 'CTR', 'Avg position', 'Days'],
      rows: pages.rows.map((r) => [r.page, Number(r.clicks), Number(r.impressions), fmtPct(ctr(Number(r.clicks), Number(r.impressions))), fmtPos(weightedPositionFromSums(r.pos_weighted, r.pos_impressions)), Number(r.days)]),
      totalRows: pages.totalPages,
    });
    const top = pages.rows[0]!;
    claims.push(
      observed('gsc.pages.top', `${pages.totalPages} page(s) had Search Console page data; top page by clicks: ${top.page} (${fmtInt(Number(top.clicks))} clicks, ${fmtInt(Number(top.impressions))} impressions).`, {
        sourceIds: batchSourceIds(pages.batchIds),
        retrievedAt: pages.collectedAt,
        metricIds: ['gsc.page'],
        evidence: [dbQueryLink('gsc_page_daily_current', { site_id: env.ctx.siteId, property, search_type: searchType, segment_key: "''", date: `${period.start}..${period.end}`, is_final: 1 })],
        synthetic: pages.synthetic,
        links: [{ kind: 'page', id: top.page_id ?? top.page, label: top.page, url: top.page }],
      }),
    );
  } else {
    claims.push(unavailable('gsc.pages.top', 'No Search Console page-level rows for the period.', 'page totals (gsc_page_daily) were not ingested for this period', { metricIds: ['gsc.page'] }));
  }

  // Brand / non-brand (visible query rows only)
  const q = gscVisibleQueries(env.ctx.db, env.ctx.siteId, property, searchType, period.start, period.end);
  const aliases = env.ctx.config.brand.aliases;
  if (q.rows.length === 0) {
    claims.push(unavailable('gsc.brand', 'Brand / non-brand split is unavailable.', 'no page/query detail was ingested for the period (query detail is fetched only for targeted pages)', { metricIds: ['gsc.query.visible'] }));
  } else {
    for (const r of q.rows) markSynthetic(env, 'gsc_page_query_daily', r.syn);
    const qEvidence = dbQueryLink('gsc_page_query_daily_current', { site_id: env.ctx.siteId, property, search_type: searchType, segment_key: "''", date: `${period.start}..${period.end}`, is_final: 1 });
    // Any contributing synthetic row marks the claim synthetic (per-claim flag, not only the report banner).
    const qBase = { sourceIds: batchSourceIds(q.batchIds), retrievedAt: q.collectedAt, evidence: [qEvidence], metricIds: ['gsc.query.visible'], synthetic: q.synthetic };
    if (aliases.length === 0) {
      claims.push(unavailable('gsc.brand', 'Brand / non-brand split is unavailable.', 'no brand aliases are configured (brand.aliases)', { metricIds: ['gsc.query.visible'] }));
      addDq(env, { severity: 'info', code: 'brand_aliases_missing', message: 'No brand aliases configured; branded and non-branded queries cannot be separated.', source: 'config', configField: 'brand.aliases', nextStep: 'Add brand.aliases to the site config.' });
    } else {
      const agg = { brand: { c: 0, i: 0, pw: 0, pi: 0, n: 0 }, non: { c: 0, i: 0, pw: 0, pi: 0, n: 0 } };
      for (const r of q.rows) {
        const b = isBrandedQuery(r.query, aliases) ? agg.brand : agg.non;
        b.c += Number(r.clicks);
        b.i += Number(r.impressions);
        b.n++;
        if (r.pos_weighted !== null && r.pos_impressions !== null) {
          b.pw += Number(r.pos_weighted);
          b.pi += Number(r.pos_impressions);
        }
      }
      const line = (label: string, a: typeof agg.brand) => `${label}: ${a.n} queries, ${fmtInt(a.c)} clicks, ${fmtInt(a.i)} impressions, CTR ${fmtPct(ctr(a.c, a.i))}, position ${fmtPos(weightedPositionFromSums(a.pw, a.pi))}`;
      claims.push(observed('gsc.brand', `Visible query rows only (anonymized queries omitted; not site totals). ${line('Branded', agg.brand)}. ${line('Non-branded', agg.non)}.`, qBase));
    }
    const top = q.rows.slice(0, env.topN);
    tables.push({
      id: 'gsc.top_queries',
      title: `Top ${top.length} of ${q.rows.length} visible queries (page/query detail; anonymized queries omitted)`,
      columns: ['Query', 'Branded', 'Clicks', 'Impressions', 'CTR', 'Avg position'],
      rows: top.map((r) => {
        const b = isBrandedQuery(r.query, aliases);
        return [r.query, b === null ? 'unknown' : b ? 'yes' : 'no', Number(r.clicks), Number(r.impressions), fmtPct(ctr(Number(r.clicks), Number(r.impressions))), fmtPos(weightedPositionFromSums(r.pos_weighted, r.pos_impressions))];
      }),
      totalRows: q.rows.length,
    });
    const un = gscUnattributed(env.ctx.db, env.ctx.siteId, property, searchType, period.start, period.end);
    if (un) {
      markSynthetic(env, 'gsc_page_daily', un.synthetic);
      const gap = un.pageClicks - un.queryClicks;
      claims.push(
        inferred(
          'gsc.query.unattributed',
          `Estimate: for ${un.pages} page(s) with query detail, visible query rows account for ${fmtInt(un.queryClicks)} of ${fmtInt(un.pageClicks)} page clicks; about ${fmtInt(Math.max(0, gap))} clicks (${fmtPct(share(Math.max(0, gap), un.pageClicks), 1)}) are unattributed (anonymized queries and row limits).`,
          { ...qBase, metricIds: ['gsc.query.unattributed'], evidence: [qEvidence, dbQueryLink('gsc_page_daily_current', { site_id: env.ctx.siteId, property, search_type: searchType, segment_key: "''", date: `${period.start}..${period.end}` })], synthetic: q.synthetic || un.synthetic },
        ),
      );
    }
  }

  // Country / device context
  const segRows = gscSegmentRows(env.ctx.db, env.ctx.siteId, property, searchType, period.start, period.end);
  const segCollected = [...new Set(segRows.map((r) => r.collected_at).filter((x): x is string => !!x))];
  const segSynthetic = segRows.some((r) => Number(r.syn ?? 0) === 1);
  markSynthetic(env, 'gsc_page_daily', segSynthetic);
  const seg = segRows.map((r) => ({
    segmentKey: r.segment_key,
    clicks: Number(r.clicks),
    impressions: Number(r.impressions),
    positionWeighted: r.pos_weighted,
    positionImpressions: r.pos_impressions,
  }));
  const segLink = dbQueryLink('gsc_page_daily_current', { site_id: env.ctx.siteId, property, search_type: searchType, segment_key: '<non-empty>', date: `${period.start}..${period.end}`, is_final: 1 });
  let anySeg = false;
  for (const dim of ['device', 'country'] as const) {
    const a = aggregateByDimension(seg, dim);
    if (!a.shape || a.values.length === 0) continue;
    anySeg = true;
    const top = a.values.slice(0, env.topN);
    tables.push({
      id: `gsc.${dim}`,
      title: `${dim === 'device' ? 'Device' : 'Country'} context (byPage rows with segment shape "${a.shape}"; not property totals)`,
      columns: [dim === 'device' ? 'Device' : 'Country', 'Clicks', 'Impressions', 'CTR', 'Avg position'],
      rows: top.map((v) => [v.value || '(blank)', v.clicks, v.impressions, fmtPct(v.ctr), fmtPos(v.position)]),
      totalRows: a.values.length,
    });
    const lead = a.values[0]!;
    claims.push(
      observed(`gsc.${dim}.context`, `${dim === 'device' ? 'Device' : 'Country'} context: ${lead.value || '(blank)'} leads with ${fmtInt(lead.clicks)} clicks (CTR ${fmtPct(lead.ctr)}) across ${a.values.length} value(s); byPage aggregation, context only.`, {
        sourceIds: [`gsc_page_daily_current:segments:${a.shape}`],
        retrievedAt: segCollected,
        metricIds: ['gsc.segment'],
        evidence: [segLink],
        synthetic: segSynthetic,
      }),
    );
  }
  if (!anySeg) {
    claims.push(unavailable('gsc.segments', 'Country/device context is unavailable.', 'no country/device segment rows were ingested for the period (optional dimensions are fetched only when an analysis needs them)', { metricIds: ['gsc.segment'] }));
  }
  return section('gsc_performance', 'Search Console performance', { claims, tables, notes });
}

// ---------------------------------------------------------------------------
// GA4
// ---------------------------------------------------------------------------

export function ga4TotalsFor(env: BuildEnv, channelView: 'google_organic' | 'all_organic', start: string, end: string): Measured<Ga4ChannelTotals> {
  const pid = env.ga4.propertyId;
  if (!pid) return missing('no GA4 property is configured (google.ga4PropertyId) and no GA4 data has been ingested');
  const { db, siteId } = env.ctx;
  const r = ga4ChannelAggregate(db, siteId, pid, channelView, start, end);
  const cov = batchCoverage(db, siteId, 'ga4_landing_daily', start, end, { property: pid, ga4View: channelView });
  for (const b of cov.batches) markSynthetic(env, 'ingestion_batches', b.is_synthetic);
  const period = ga4PeriodMetrics(db, siteId, pid, channelView, start, end);
  for (const m of period.values()) markSynthetic(env, 'ga4_period_metrics', m.is_synthetic);
  const ev = env.primaryEvent;
  const a = r.agg;
  if (a) markSynthetic(env, 'ga4_landing_daily', a.syn);
  for (const id of [...r.batchIds, ...[...period.values()].map((m) => m.batch_id)]) env.sourceBatchIds.add(id);

  if (!a) {
    if (r.incompleteRows > 0) return incomplete(`only incomplete GA4 days exist for ${start} to ${end}; they are excluded`);
    // Only a successful batch for THIS channel view proves that zero rows mean zero sessions.
    if (cov.batches.length === 0) return missing(`no successful GA4 ${channelView} sync covers ${start} to ${end}`);
    // ...and only when GA4 did not report that rows may be left out ("(other)" bucketing, thresholding, sampling).
    const loss = cov.batches.every((b) => ga4BatchRowLoss(b.metadata_json).length > 0) ? [...new Set(cov.batches.flatMap((b) => ga4BatchRowLoss(b.metadata_json)))] : [];
    if (loss.length) return incomplete(`no GA4 ${channelView} rows for ${start} to ${end}, and the covering sync(s) reported ${describeRowLoss(loss)}; absent rows are unknown, not zero sessions`);
  }
  const rows = Number(a?.rows ?? 0);
  const sessions = Number(a?.sessions ?? 0);

  const eventNames = (a?.event_names ?? '').split(',').filter(Boolean);
  const mismatch = !!ev && eventNames.length > 0 && !eventNames.includes(ev);
  const noEvent = 'no primary conversion event is configured (conversions.primaryEvents)';

  let primaryEventOccurrences: Measured<number>;
  if (!ev) primaryEventOccurrences = measuredUnavailable(noEvent);
  else if (mismatch) primaryEventOccurrences = measuredUnavailable(`rows were ingested for event(s) ${eventNames.join(', ')}, not the configured primary event ${ev}`);
  else if (rows === 0) primaryEventOccurrences = measuredObserved(0);
  else if (Number(a?.pke_not_observed ?? 0) === 0) primaryEventOccurrences = measuredObserved(Number(a?.pke ?? 0));
  else if (a?.pke !== null && a?.pke !== undefined) primaryEventOccurrences = incomplete(`${a.pke_not_observed} of ${rows} rows lack an observed primary event count (status: ${a.pke_statuses ?? 'missing'})`, Number(a.pke));
  else primaryEventOccurrences = measuredUnavailable(`primary event count status: ${a?.pke_statuses ?? 'missing'}`);

  let primarySessionRate: Measured<number>;
  let basis: Ga4ChannelTotals['primarySessionRateBasis'] = null;
  let rateUnverified: Ga4ChannelTotals['primarySessionRateUnverified'] = null;
  let sessionsWithPrimaryEvent: Measured<number>;
  const rateMetric = ev ? period.get(`sessionKeyEventRate:${ev}`) : undefined;
  const dailyRateOk = !mismatch && rows > 0 && Number(a?.rate_not_observed ?? 1) === 0 && Number(a?.rate_sessions ?? 0) > 0;
  // Rates stored with scale 'undetermined' are never used as fractions (seo/metrics.rateScaleClass).
  const dailyUnverified = Number(a?.rate_unverified ?? 0);
  const dailyMixedScale = dailyUnverified > 0 && dailyUnverified < rows - Number(a?.rate_not_observed ?? 0);
  const dailyUnverifiedReason = rateScaleUnverifiedReason(`sessionKeyEventRate:${ev ?? '<primary event>'}`, `${dailyUnverified} of ${rows} daily rows${dailyMixedScale ? ', mixed with rows on a verified scale' : ''}; converting sessions are not derived from it`);
  const dailyConverting = (): Measured<number> =>
    !dailyRateOk ? measuredUnavailable('daily session key-event rates are not all observed') : dailyUnverified > 0 ? measuredUnavailable(dailyUnverifiedReason) : measuredObserved(round(Number(a!.conv_sessions), 3)!);
  const periodRate = ev && rateMetric && rateMetric.value_status === 'observed' && rateMetric.value !== null && rateMetric.is_complete === 1 ? rateMetric : null;
  const periodFraction = periodRate ? rateToFraction(periodRate.value!, periodRate.rate_scale) : null;
  if (!ev) {
    primarySessionRate = measuredUnavailable(noEvent);
    sessionsWithPrimaryEvent = measuredUnavailable(noEvent);
  } else if (periodRate && periodFraction !== null) {
    env.sourceBatchIds.add(periodRate.batch_id);
    primarySessionRate = measuredObserved(periodFraction);
    basis = 'period_metric';
    sessionsWithPrimaryEvent = dailyConverting();
  } else if (mismatch) {
    primarySessionRate = measuredUnavailable(`rows were ingested for event(s) ${eventNames.join(', ')}, not the configured primary event ${ev}`);
    sessionsWithPrimaryEvent = primarySessionRate;
  } else if (dailyRateOk && dailyUnverified === 0) {
    // The period-level value (if any) has an unverified scale; the daily rates are on a verified scale.
    primarySessionRate = measuredObserved(round(Number(a!.conv_sessions) / Number(a!.rate_sessions))!);
    basis = 'session_weighted_daily';
    sessionsWithPrimaryEvent = measuredObserved(round(Number(a!.conv_sessions), 3)!);
  } else if (periodRate) {
    env.sourceBatchIds.add(periodRate.batch_id);
    primarySessionRate = measuredUnavailable(rateScaleUnverifiedReason(`sessionKeyEventRate:${ev}`, 'period-level value'));
    rateUnverified = { raw: periodRate.value!, basis: 'period_metric' };
    sessionsWithPrimaryEvent = dailyConverting();
  } else if (dailyRateOk) {
    primarySessionRate = measuredUnavailable(dailyUnverifiedReason);
    // A raw session-weighted value is shown (as unverified) only when every row shares the undetermined scale.
    if (!dailyMixedScale) rateUnverified = { raw: round(Number(a!.raw_rate_weighted) / Number(a!.rate_sessions))!, basis: 'session_weighted_daily' };
    sessionsWithPrimaryEvent = measuredUnavailable(dailyUnverifiedReason);
  } else {
    const why = rows === 0 ? 'no GA4 rows in the period' : `sessionKeyEventRate:${ev} was not observed for ${a?.rate_not_observed ?? rows} of ${rows} rows (status: ${a?.rate_statuses ?? 'missing'}) and no period-level value was fetched`;
    primarySessionRate = measuredUnavailable(why);
    sessionsWithPrimaryEvent = measuredUnavailable(why);
  }

  const primaryEventUsers = primaryEventUsersFor(env, period, ev, start, end);
  const rateScaleAssertion = ownerRateScaleAssertion(env, pid);
  const usersRow = period.get('totalUsers') ?? period.get('activeUsers');
  const users: Measured<number> =
    usersRow && usersRow.value_status === 'observed' && usersRow.value !== null
      ? usersRow.is_complete === 1
        ? measuredObserved(usersRow.value)
        : incomplete('the period-level user count is marked incomplete', usersRow.value)
      : measuredUnavailable(usersUnavailableReason(db, siteId, pid, channelView, start, end));
  if (usersRow) env.sourceBatchIds.add(usersRow.batch_id);

  const engaged: Measured<number> =
    rows === 0 ? measuredObserved(0) : Number(a?.engaged_null ?? 0) === 0 ? measuredObserved(Number(a?.engaged ?? 0)) : a?.engaged !== null && a?.engaged !== undefined ? incomplete(`${a.engaged_null} of ${rows} rows lack engaged sessions`, Number(a.engaged)) : measuredUnavailable('engaged sessions were not reported');
  const keyEvents: Measured<number> =
    rows === 0 ? measuredObserved(0) : Number(a?.key_events_null ?? 0) === 0 ? measuredObserved(Number(a?.key_events ?? 0)) : a?.key_events !== null && a?.key_events !== undefined ? incomplete(`${a.key_events_null} of ${rows} rows lack key events`, Number(a.key_events)) : measuredUnavailable('key events were not reported');
  const revenueStatus: Measured<number>['status'] = rows === 0 ? 'missing' : Number(a?.revenue_not_observed ?? rows) === 0 ? 'observed' : r.revenue.length ? 'incomplete' : 'unavailable';

  const totals: Ga4ChannelTotals = {
    channelView,
    propertyId: pid,
    dateTz: a?.date_tz ?? ga4PropertyTimeZone(db, siteId, pid),
    start,
    end,
    daysWithData: Number(a?.days ?? 0),
    sessions,
    engagedSessions: engaged,
    keyEvents,
    primaryEventName: ev,
    primaryEventOccurrences,
    primarySessionRate,
    primarySessionRateBasis: basis,
    primarySessionRateUnverified: rateUnverified,
    rateScaleAssertion,
    sessionsWithPrimaryEvent,
    ...(primaryEventUsers ? { primaryEventUsers } : {}),
    users,
    usersMetric: usersRow?.metric ?? null,
    revenue: r.revenue,
    revenueStatus,
    notSetSessions: Number(a?.not_set_sessions ?? 0),
    unmatchedSessions: Number(a?.unmatched_sessions ?? 0),
    excludedIncompleteRows: r.incompleteRows,
    batchIds: [...new Set([...r.batchIds, ...cov.batches.map((b) => b.id)])],
    collectedAt: [...new Set([...r.collectedAt, ...cov.batches.map((b) => b.finished_at ?? b.started_at)])],
    synthetic: Number(a?.syn ?? 0) === 1,
  };
  if (cov.uncovered.length > 0) return incomplete(`${cov.uncovered.length} of ${daysBetweenInclusive(start, end)} days were not covered by a successful GA4 sync`, totals);
  if (r.incompleteRows > 0) return incomplete(`${r.incompleteRows} incomplete GA4 row(s) were excluded from totals`, totals);
  return measuredObserved(totals);
}

/**
 * Users are period-grain. The GA4 sync currently fetches them only for
 * trailing windows ending at GA4's latest complete day, which rarely equal a
 * report period; say which windows exist instead of approximating.
 */
function usersUnavailableReason(db: BuildEnv['ctx']['db'], siteId: string, pid: string, channelView: string, start: string, end: string): string {
  const base = `users are not additive across days, and no period-level user count was fetched for exactly ${start} to ${end}`;
  const other = ga4PeriodsWithMetric(db, siteId, pid, channelView, ['totalUsers', 'activeUsers']);
  const multi = other.filter((p) => p.start !== p.end);
  if (multi.length === 0) return base;
  return `${base} (period-level users exist only for ${multi.map((p) => `${p.start} to ${p.end}`).join(', ')}; a different window is never substituted; the period fetch must request this exact report period)`;
}

/**
 * The owner assertion the property's key-event rate scale rests on, or null
 * when the scale is established by GA4 data (a value above 1), by the
 * integer-consistency proof, or not at all. A verified rate read on an
 * asserted scale stays OBSERVED, but says whose assertion it rests on (D3-03).
 */
export function ownerRateScaleAssertion(env: BuildEnv, propertyId: string): RateScaleAssertion | null {
  const eff = effectiveRateScale(env.ctx, propertyId);
  const c = eff.confirmation;
  if (eff.source !== 'owner_assertion' || !c) return null;
  return { confirmationId: c.id, scale: c.scale, actor: c.actor.replace(/^owner:/, ''), confirmedAt: c.confirmedAt, evidence: c.evidence, synthetic: c.synthetic };
}

/** " Caveat: rate scale 0-1 per owner assertion ga4rs_... by <name> on <date>; ..." (empty when no assertion applies). */
export function rateScaleAssertionCaveat(a: RateScaleAssertion | null | undefined): string {
  if (!a) return '';
  const scale = a.scale === 'fraction' ? '0-1 (stored values used as reported)' : '0-100 (stored values divided by 100)';
  return ` Caveat: rate scale ${scale} per owner assertion ${a.confirmationId} by ${a.actor} on ${a.confirmedAt.slice(0, 10)}; GA4 does not document the scale and no GA4 value established it.`;
}

function rateScaleAssertionSources(a: RateScaleAssertion | null | undefined): string[] {
  return a ? [`ga4_rate_scale_confirmations:${a.confirmationId}`] : [];
}

/** The confirmation row as context: it is what the scale rests on, not a measurement of the rate. */
function rateScaleAssertionLinks(a: RateScaleAssertion | null | undefined): EvidenceLink[] {
  return a ? [recordLink('ga4_rate_scale_confirmations', a.confirmationId, `rate scale owner assertion ${a.confirmationId} (${a.actor}, ${a.confirmedAt.slice(0, 10)})`, false)] : [];
}

/**
 * Users who triggered the primary event at PERIOD grain: userKeyEventRate:<event>
 * and totalUsers fetched for exactly this period and view (ga4_period_metrics).
 * Never summed from daily rows. The count is derived (share x totalUsers) only
 * when the rate scale is verified; an 'undetermined' rate is kept as a raw,
 * explicitly unverified value.
 */
function primaryEventUsersFor(env: BuildEnv, period: Map<string, PeriodMetricRow>, ev: string | null, start: string, end: string): PrimaryEventUsers | undefined {
  if (!ev) return undefined;
  const metric = `userKeyEventRate:${ev}`;
  const rateRow = period.get(metric);
  const usersRow = period.get('totalUsers');
  const used = [rateRow, usersRow].filter((r): r is PeriodMetricRow => !!r);
  for (const r of used) env.sourceBatchIds.add(r.batch_id);
  let share: Measured<number>;
  let rawUnverified: number | null = null;
  if (!rateRow) share = missing(`${metric} was not fetched for exactly ${start} to ${end} (period grain; never summed from daily rows)`);
  else if (rateRow.value_status !== 'observed' || rateRow.value === null) {
    share = measuredUnavailable(`${metric} is ${rateRow.value_status} for ${start} to ${end}${rateRow.value_status === 'unavailable' ? ' (GA4 metadata does not list it: the event may not be a key event)' : ''}`);
  } else {
    const f = rateToFraction(rateRow.value, rateRow.rate_scale);
    if (f === null) {
      rawUnverified = rateRow.value;
      share = measuredUnavailable(rateScaleUnverifiedReason(metric, 'no user count is derived from it'));
    } else share = rateRow.is_complete === 1 ? measuredObserved(f) : incomplete('the period-level value is marked incomplete', f);
  }
  const totalUsers = usersRow && usersRow.value_status === 'observed' && usersRow.value !== null ? usersRow.value : null;
  let users: Measured<number>;
  const shareValue = share.status === 'observed' ? share.value : share.status === 'incomplete' ? (share.partialValue ?? null) : null;
  if (shareValue === null) users = measuredUnavailable(share.status === 'observed' ? 'unknown' : share.reason);
  else if (totalUsers === null) users = measuredUnavailable(`totalUsers was not fetched for exactly ${start} to ${end}`);
  else if (share.status === 'observed' && usersRow!.is_complete === 1) users = measuredObserved(round(shareValue * totalUsers, 1)!);
  else users = incomplete('the period-level share or user count is marked incomplete', round(shareValue * totalUsers, 1)!);
  return {
    share,
    users,
    totalUsers,
    rawUnverified,
    batchIds: [...new Set(used.map((r) => r.batch_id))],
    collectedAt: [...new Set(used.map((r) => r.collected_at))],
    synthetic: used.some((r) => r.is_synthetic === 1),
  };
}

/** Appended to primary-event claims until the owner records verification (conversions.primaryEvents[].verifiedAt). */
export const TRACKING_UNVERIFIED_CAVEAT = 'Caveat: tracking not yet verified by the owner.';

/** Primary events (by name) without a recorded owner verification (conversions.primaryEvents[].verifiedAt). */
export function unverifiedPrimaryEvents(env: BuildEnv): string[] {
  return env.ctx.config.conversions.primaryEvents.filter((e) => !(e as { verifiedAt?: string | null }).verifiedAt).map((e) => e.name);
}

/** True when the report's primary event has no recorded owner verification. */
export function primaryEventTrackingUnverified(env: BuildEnv): boolean {
  return !!env.primaryEvent && unverifiedPrimaryEvents(env).includes(env.primaryEvent);
}

/** "Users who triggered <event>" claim (period level; distinct from occurrences, converting sessions, and the session rate). */
function primaryUsersClaim(env: BuildEnv, t: Ga4ChannelTotals, idp: string, ev: string, caveat: string): Claim {
  const id = `${idp}.primary_users`;
  const metricIds = ['ga4.primary_event.users'];
  const label = `Users who triggered "${ev}" (period level, not summed across days)`;
  const pu = t.primaryEventUsers;
  if (!pu) return unavailable(id, `${label}: DATA UNAVAILABLE.`, 'no primary conversion event is configured (conversions.primaryEvents)', { metricIds });
  const periodLink = dbQueryLink('ga4_period_metrics_current', { site_id: env.ctx.siteId, property_id: t.propertyId, channel_view: t.channelView, period: `${t.start}..${t.end}`, landing_page: "''", metric: `userKeyEventRate:${ev}|totalUsers` });
  const opts = {
    sourceIds: [...batchSourceIds(pu.batchIds), `ga4_period_metrics:${t.propertyId}:${t.channelView}:${t.start}..${t.end}`],
    retrievedAt: pu.collectedAt,
    metricIds,
    evidence: [periodLink],
    synthetic: pu.synthetic,
  };
  // A share read on a verified scale that rests on an owner assertion says so (the raw, unverified value below never does: it has no scale).
  const asserted = { ...opts, sourceIds: [...opts.sourceIds, ...rateScaleAssertionSources(t.rateScaleAssertion)], evidence: [periodLink, ...rateScaleAssertionLinks(t.rateScaleAssertion)] };
  const scaleCaveat = rateScaleAssertionCaveat(t.rateScaleAssertion);
  const distinct = 'Not event occurrences, not sessions that triggered it, and not the session rate.';
  const u = pu.users;
  const uv = u.status === 'observed' ? u.value : u.status === 'incomplete' ? (u.partialValue ?? null) : null;
  const sv = pu.share.status === 'observed' ? pu.share.value : pu.share.status === 'incomplete' ? (pu.share.partialValue ?? null) : null;
  if (uv !== null && sv !== null && pu.totalUsers !== null) {
    const partial = u.status === 'incomplete' ? ` (incomplete: ${u.reason})` : '';
    return inferred(id, `${label}: about ${fmtInt(uv)} of ${fmtInt(pu.totalUsers)} users (${fmtPct(sv)}), derived as userKeyEventRate:${ev} x totalUsers for exactly ${t.start} to ${t.end}${partial}. ${distinct}${caveat}${scaleCaveat}`, asserted);
  }
  if (sv !== null) {
    const partial = pu.share.status === 'incomplete' ? ` (incomplete: ${pu.share.reason})` : '';
    return observed(id, `${label}: ${fmtPct(sv)} of users (GA4 userKeyEventRate:${ev}, period level)${partial}; the user count is unavailable (${u.status === 'observed' ? 'unknown' : u.reason}). ${distinct}${caveat}${scaleCaveat}`, asserted);
  }
  if (pu.rawUnverified !== null) {
    return inferred(
      id,
      `${label}: RATE SCALE UNVERIFIED. GA4 reported userKeyEventRate:${ev} = ${pu.rawUnverified} for ${t.start} to ${t.end}, stored exactly as reported; that is ${fmtPct(pu.rawUnverified)} of users on a 0-1 scale or ${fmtPct(pu.rawUnverified / 100)} on a 0-100 scale, so no user count is derived. ${distinct}${caveat}`,
      { ...opts, reason: pu.share.status === 'observed' ? 'unknown' : pu.share.reason },
    );
  }
  return unavailable(id, `${label}: DATA UNAVAILABLE.`, pu.share.status === 'observed' ? 'unknown' : pu.share.reason, { metricIds });
}

function measuredText(m: Measured<number>, fmt: (n: number) => string): string {
  if (m.status === 'observed') return fmt(m.value);
  if (m.status === 'incomplete') return m.partialValue !== undefined ? `${fmt(m.partialValue)} (incomplete: ${m.reason})` : `incomplete (${m.reason})`;
  return `unavailable (${m.reason})`;
}

export function ga4Section(env: BuildEnv, channelView: 'google_organic' | 'all_organic'): ReportSection {
  const { period } = env;
  const key = channelView;
  const title = channelView === 'google_organic' ? 'Google organic (GA4: session source google / medium organic)' : 'All organic search (GA4: session default channel group Organic Search)';
  const cur = ga4TotalsFor(env, channelView, period.start, period.end);
  const prev = period.comparison ? ga4TotalsFor(env, channelView, period.comparison.start, period.comparison.end) : null;
  if (channelView === 'google_organic') {
    env.data.googleOrganic = cur;
    env.data.googleOrganicPrevious = prev;
  } else {
    env.data.allOrganic = cur;
    env.data.allOrganicPrevious = prev;
  }
  const notes =
    channelView === 'google_organic'
      ? ['Session-scoped acquisition (sessionSource = google, sessionMedium = organic). Comparable with Search Console clicks, but not identical. Kept separate from all-organic results and never added to them.']
      : ['All search engines (sessionDefaultChannelGroup = Organic Search). Broader business view; not comparable with Search Console clicks and never added to the Google organic view.'];
  const claims: Claim[] = [];
  const idp = `ga4.${channelView}`;
  const sessionMetric = `ga4.sessions.${channelView}`;
  const t = totalsOf(cur);
  if (!t) {
    claims.push(unavailable(`${idp}.sessions`, `${channelView === 'google_organic' ? 'Google organic' : 'All organic'} GA4 results are unavailable.`, cur.status === 'observed' ? 'unknown' : cur.reason, { metricIds: [sessionMetric] }));
    addDq(env, { severity: 'warning', code: `ga4_${channelView}_missing`, message: `GA4 ${channelView} data unavailable: ${cur.status === 'observed' ? '' : cur.reason}.`, source: 'ga4', nextStep: 'Run `sync ga4` after configuring google.ga4PropertyId and access.' });
    return section(key, title, { claims, notes });
  }
  const view = dbQueryLink('ga4_landing_daily_current', { site_id: env.ctx.siteId, property_id: t.propertyId, channel_view: channelView, segment_key: "''", date: `${t.start}..${t.end}`, is_complete: 1 });
  const base = { sourceIds: batchSourceIds(t.batchIds), retrievedAt: t.collectedAt, evidence: [view, ...batchLinks(t.batchIds)], synthetic: t.synthetic };
  const partial = cur.status === 'incomplete' ? ` (partial: ${cur.reason})` : '';
  const pt = prev && prev.status === 'observed' ? prev.value : null;
  const change = (c: number, p: number | null | undefined) => (pt && cur.status === 'observed' && p !== null && p !== undefined ? ` vs ${fmtInt(p)} in the comparison period (${fmtSignedPct(pctChange(c, p))})` : '');
  claims.push(observed(`${idp}.sessions`, `Sessions: ${fmtInt(t.sessions)}${change(t.sessions, pt?.sessions)}${partial}.`, { ...base, metricIds: [sessionMetric] }));
  const measuredClaim = (id: string, label: string, m: Measured<number>, metric: string, fmt: (n: number) => string, extraSources: string[] = [], suffix = '') => {
    if (m.status === 'observed' || (m.status === 'incomplete' && m.partialValue !== undefined)) {
      claims.push(observed(id, `${label}: ${measuredText(m, fmt)}.${suffix}`, { ...base, sourceIds: [...base.sourceIds, ...extraSources], metricIds: [metric] }));
    } else {
      claims.push(unavailable(id, `${label}: DATA UNAVAILABLE.`, m.reason, { metricIds: [metric] }));
    }
  };
  measuredClaim(`${idp}.engaged`, 'Engaged sessions', t.engagedSessions, 'ga4.engaged_sessions', fmtInt);
  measuredClaim(`${idp}.key_events`, 'Key events (any key event, occurrences)', t.keyEvents, 'ga4.key_events', fmtInt);
  const ev = t.primaryEventName ?? '<not configured>';
  // Primary-event metrics carry the owner-verification caveat until conversions.primaryEvents[].verifiedAt is recorded.
  const unverifiedTracking = primaryEventTrackingUnverified(env);
  const caveat = unverifiedTracking ? ` ${TRACKING_UNVERIFIED_CAVEAT}` : '';
  measuredClaim(`${idp}.primary_occurrences`, `Primary event "${ev}" occurrences (repeatable; not sessions)`, t.primaryEventOccurrences, 'ga4.primary_event.occurrences', fmtInt, [], caveat);
  const pid = t.propertyId;
  const periodSource = [`ga4_period_metrics:${pid}:${channelView}:${t.start}..${t.end}`];
  const rateLink = dbQueryLink('ga4_period_metrics_current', { site_id: env.ctx.siteId, property_id: pid, channel_view: channelView, period: `${t.start}..${t.end}`, metric: `sessionKeyEventRate:${ev}` });
  const rawRate = t.primarySessionRateUnverified;
  // Verified rates read on a scale that rests on an owner assertion carry its id, author, and date (D3-03).
  const scaleAssertion = t.rateScaleAssertion ?? null;
  const scaleCaveat = rateScaleAssertionCaveat(scaleAssertion);
  const scaleSources = rateScaleAssertionSources(scaleAssertion);
  const scaleLinks = rateScaleAssertionLinks(scaleAssertion);
  let scaleAssertionUsed = false;
  if (t.primarySessionRate.status === 'observed') {
    const how = t.primarySessionRateBasis === 'period_metric' ? 'period-level API value' : 'session-weighted aggregate of complete daily values';
    scaleAssertionUsed = !!scaleAssertion;
    claims.push(
      observed(`${idp}.primary_rate`, `Session key-event rate for "${ev}": ${fmtPct(t.primarySessionRate.value)} (${how}).${caveat}${scaleCaveat}`, {
        ...base,
        sourceIds: [...base.sourceIds, ...(t.primarySessionRateBasis === 'period_metric' ? periodSource : []), ...scaleSources],
        metricIds: ['ga4.primary_event.session_rate'],
        evidence: [...(t.primarySessionRateBasis === 'period_metric' ? [rateLink, ...base.evidence] : base.evidence), ...scaleLinks],
      }),
    );
  } else if (rawRate) {
    // Scale not established: the raw value is shown as INFERRED with an explicit caveat, never as an OBSERVED percentage.
    const how = rawRate.basis === 'period_metric' ? 'period-level API value' : 'session-weighted over complete daily values';
    claims.push(
      inferred(
        `${idp}.primary_rate`,
        `Session key-event rate for "${ev}": RATE SCALE UNVERIFIED. GA4 reported ${rawRate.raw} (${how}), stored exactly as reported; GA4 does not document whether this is 0-1 or 0-100, so it means ${fmtPct(rawRate.raw)} on a 0-1 scale or ${fmtPct(rawRate.raw / 100)} on a 0-100 scale. It is not treated as a measured percentage, and sessions that triggered the event are not derived from it.${caveat}`,
        {
          ...base,
          sourceIds: [...base.sourceIds, ...(rawRate.basis === 'period_metric' ? periodSource : [])],
          metricIds: ['ga4.primary_event.session_rate'],
          evidence: rawRate.basis === 'period_metric' ? [rateLink, ...base.evidence] : base.evidence,
          reason: t.primarySessionRate.reason,
        },
      ),
    );
    if (channelView === 'google_organic') {
      addDq(env, {
        severity: 'warning',
        code: 'ga4_rate_scale_unverified',
        message: `GA4 key-event rates for property ${pid} are stored with scale "undetermined" (0-1 vs 0-100 not established), so conversion rates are shown as unverified raw values and converting sessions are not derived.`,
        source: 'ga4',
        nextStep: `Compare one stored sessionKeyEventRate:${ev} value (for example the daily value of a page in \`analyze page <url>\` or \`data export\`) with the same page, date, and channel in the GA4 interface, then confirm the scale: \`${CONFIRM_RATE_SCALE_COMMAND}\` (fraction when GA4 shows 2.5% for a stored 0.025, percent when the stored value is 2.5). The confirmation is audited, re-marks the stored rates (older days included), and later syncs store rates on that scale.`,
      });
    }
  } else {
    claims.push(unavailable(`${idp}.primary_rate`, `Session key-event rate for the primary event "${ev}": DATA UNAVAILABLE. No substitute is used.`, t.primarySessionRate.reason, { metricIds: ['ga4.primary_event.session_rate'] }));
    const alt = ga4PeriodMetrics(env.ctx.db, env.ctx.siteId, pid, channelView, t.start, t.end).get('sessionKeyEventRate');
    if (alt && alt.value_status === 'observed' && alt.value !== null) {
      const altF = rateToFraction(alt.value, alt.rate_scale);
      const altOpts = {
        sourceIds: [`ingestion_batches:${alt.batch_id}`],
        retrievedAt: [alt.collected_at],
        metricIds: ['ga4.session_rate.any'],
        evidence: [dbQueryLink('ga4_period_metrics_current', { site_id: env.ctx.siteId, property_id: pid, channel_view: channelView, period: `${t.start}..${t.end}`, metric: 'sessionKeyEventRate' })],
        synthetic: alt.is_synthetic === 1,
      };
      if (altF !== null && scaleAssertion) scaleAssertionUsed = true;
      claims.push(
        altF === null
          ? inferred(`${idp}.any_key_event_rate`, `ALTERNATIVE, NOT the primary event: GA4 reported a session key-event rate for ANY key event of ${alt.value}; RATE SCALE UNVERIFIED (0-1 would mean ${fmtPct(alt.value)}, 0-100 would mean ${fmtPct(alt.value / 100)}). It includes every key event and must not be read as the primary conversion rate.`, altOpts)
          : observed(`${idp}.any_key_event_rate`, `ALTERNATIVE, NOT the primary event: session key-event rate for ANY key event = ${fmtPct(altF)}. It includes every key event and must not be read as the primary conversion rate.${scaleCaveat}`, { ...altOpts, sourceIds: [...altOpts.sourceIds, ...scaleSources], evidence: [...altOpts.evidence, ...scaleLinks] }),
      );
    }
    if (channelView === 'google_organic') {
      addDq(env, { severity: 'critical', code: 'primary_event_rate_unavailable', message: `Primary-event session conversion rate unavailable: ${t.primarySessionRate.reason}.`, source: 'ga4', nextStep: 'Confirm the primary event is marked as a key event in GA4 and configured in conversions.primaryEvents, then re-sync GA4.' });
    }
  }
  const derivedSessions = t.sessionsWithPrimaryEvent.status === 'observed' || (t.sessionsWithPrimaryEvent.status === 'incomplete' && t.sessionsWithPrimaryEvent.partialValue !== undefined);
  if (derivedSessions && scaleAssertion) scaleAssertionUsed = true;
  measuredClaim(`${idp}.primary_sessions`, `Sessions that triggered "${ev}" (derived from daily rates x sessions)`, t.sessionsWithPrimaryEvent, 'ga4.primary_event.sessions', (n) => fmtInt(n), derivedSessions ? scaleSources : [], `${caveat}${derivedSessions ? scaleCaveat : ''}`);
  const usersClaim = primaryUsersClaim(env, t, idp, ev, caveat);
  if (scaleAssertion && usersClaim.sourceIds.some((x) => scaleSources.includes(x))) scaleAssertionUsed = true;
  claims.push(usersClaim);
  if (scaleAssertionUsed && scaleAssertion) {
    // A synthetic (demo) confirmation marks the report synthetic only when a rate above rests on it.
    markSynthetic(env, 'ga4_rate_scale_confirmations', scaleAssertion.synthetic);
    // The confirmation the rates above rest on, listed once per report (same code and message for both channel views).
    addDq(env, {
      severity: 'info',
      code: 'ga4_rate_scale_owner_assertion',
      message: `GA4 key-event rates of property ${pid} are read on a ${scaleAssertion.scale === 'fraction' ? '0-1 scale (used as reported)' : '0-100 scale (divided by 100)'} per owner assertion ${scaleAssertion.confirmationId} by ${scaleAssertion.actor} on ${scaleAssertion.confirmedAt.slice(0, 10)} (evidence recorded: "${scaleAssertion.evidence.length > 200 ? `${scaleAssertion.evidence.slice(0, 200)}...` : scaleAssertion.evidence}"). GA4 does not document the scale and no GA4 value (above 1) or integer-consistency proof established it: conversion rates, converting sessions, and users who converted rest on this assertion.`,
      source: 'ga4',
      recordRef: `ga4_rate_scale_confirmations:${scaleAssertion.confirmationId}`,
      nextStep: `If a stored value does not match the GA4 interface for the same page, date, and channel, record the correct scale: \`${CONFIRM_RATE_SCALE_COMMAND}\` (the latest confirmation counts; it is audited and re-marks stored rates).`,
    });
  }
  if (t.users.status === 'observed' || t.users.status === 'incomplete') {
    measuredClaim(`${idp}.users`, `Users (${t.usersMetric ?? 'period level'}; period-level, not summed across days)`, t.users, 'ga4.users', fmtInt, periodSource);
  } else {
    claims.push(unavailable(`${idp}.users`, 'Users: DATA UNAVAILABLE (never summed from daily rows).', t.users.reason, { metricIds: ['ga4.users'] }));
  }
  if (t.revenue.length && (t.revenueStatus === 'observed' || t.revenueStatus === 'incomplete')) {
    const txt = t.revenue.map((r) => formatMoney(r.micros, r.currency)).join('; ');
    claims.push(observed(`${idp}.revenue`, `Revenue (source currency, not summed across currencies): ${txt}${t.revenueStatus === 'incomplete' ? ' (incomplete: some rows lack revenue)' : ''}.`, { ...base, metricIds: ['ga4.revenue'] }));
  } else {
    claims.push(unavailable(`${idp}.revenue`, 'Revenue: DATA UNAVAILABLE.', t.revenueStatus === 'missing' ? 'no GA4 rows in the period' : 'revenue was not reported for this property or view', { metricIds: ['ga4.revenue'] }));
  }
  if (t.notSetSessions > 0) {
    claims.push(observed(`${idp}.not_set`, `"(not set)" landing page: ${fmtInt(t.notSetSessions)} sessions (${fmtPct(share(t.notSetSessions, t.sessions), 1)}); kept as an explicit bucket.`, { ...base, metricIds: ['ga4.not_set'] }));
  }
  if (t.excludedIncompleteRows > 0) addDq(env, { severity: 'info', code: `ga4_${channelView}_incomplete_excluded`, message: `${t.excludedIncompleteRows} incomplete GA4 ${channelView} row(s) were excluded.`, source: 'ga4' });
  if (cur.status === 'incomplete') addDq(env, { severity: 'warning', code: `ga4_${channelView}_partial`, message: `GA4 ${channelView} data is partial: ${cur.reason}.`, source: 'ga4', nextStep: 'Run `sync ga4` for the missing dates.' });
  if (t.unmatchedSessions > 0 && channelView === 'google_organic') {
    addDq(env, { severity: 'info', code: 'ga4_unmatched_landing_pages', message: `${fmtInt(t.unmatchedSessions)} Google organic sessions (${fmtPct(share(t.unmatchedSessions, t.sessions), 1)}) landed on pages not yet reconciled to a known page identity.`, source: 'ga4', nextStep: 'Review URL reconciliation (aliases need evidence before merging).' });
  }
  // Clicks vs sessions explanation (never asserts a cause the data does not establish)
  if (channelView === 'google_organic') {
    const g = env.data.gsc?.current;
    const gt = g ? totalsOf(g) : null;
    if (gt) {
      claims.push(
        inferred(
          `${idp}.vs_gsc`,
          `Search Console clicks (${fmtInt(gt.clicks)}) and GA4 Google organic sessions (${fmtInt(t.sessions)}) differ by ${fmtInt(Math.abs(gt.clicks - t.sessions))}. Differences are expected: Search Console days follow ${gt.dateTz ?? GSC_DOC_TZ} while GA4 days follow ${t.dateTz ?? 'the property time zone'}; consent or blocked tracking, sessions without a page view, and several clicks within one session also contribute. This data does not establish which cause dominates.`,
          { sourceIds: [...batchSourceIds(gt.batchIds), ...base.sourceIds], retrievedAt: [...gt.collectedAt, ...t.collectedAt], metricIds: ['gsc.clicks', sessionMetric], evidence: [gscEvidence(env, gt), view], synthetic: gt.synthetic || t.synthetic },
        ),
      );
    }
  }
  const tables: ReportTable[] = [];
  if (pt || t) {
    const short = (m: Measured<number>, fmt: (n: number) => string) => (m.status === 'observed' ? fmt(m.value) : m.status === 'incomplete' && m.partialValue !== undefined ? `${fmt(m.partialValue)} (incomplete)` : m.status === 'incomplete' ? 'incomplete' : 'unavailable');
    const rateCell = (a: Ga4ChannelTotals) => (a.primarySessionRate.status !== 'observed' && a.primarySessionRateUnverified ? `raw ${a.primarySessionRateUnverified.raw} (scale unverified)` : short(a.primarySessionRate, (n) => fmtPct(n)));
    const row = (label: string, a: Ga4ChannelTotals | null) =>
      a
        ? [label, a.sessions, short(a.engagedSessions, fmtInt), short(a.keyEvents, fmtInt), short(a.primaryEventOccurrences, fmtInt), rateCell(a), short(a.users, fmtInt)]
        : [label, null, null, null, null, null, null];
    tables.push({
      id: `${idp}.summary`,
      title: `${channelView === 'google_organic' ? 'Google organic' : 'All organic'} summary`,
      columns: ['Period', 'Sessions', 'Engaged sessions', 'Key events', `"${ev}" occurrences`, `"${ev}" session rate`, 'Users'],
      rows: [row(`${t.start} to ${t.end}`, t), ...(period.comparison ? [row(`${period.comparison.start} to ${period.comparison.end}`, pt)] : [])],
    });
  }
  return section(key, title, { claims, tables, notes });
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

export function freshnessSection(env: BuildEnv): ReportSection {
  const { db, siteId } = env.ctx;
  const batches = recentBatches(db, siteId);
  const groups = new Map<string, typeof batches>();
  for (const b of batches) {
    const k = `${b.source}|${b.dataset}`;
    const arr = groups.get(k) ?? [];
    arr.push(b);
    groups.set(k, arr);
  }
  const features = env.ctx.settings.features;
  const expected: Array<[string, string]> = [];
  if (features.gsc) expected.push(['gsc', 'gsc_property_daily'], ['gsc', 'gsc_page_daily']);
  if (features.ga4) expected.push(['ga4', 'ga4_landing_daily']);
  // An expected dataset without any batch is listed as "never synced". A dataset that only
  // another source filled (an owner import, `data import`) is described by that source's
  // entry instead: the import is the alternative to the integration (spec 2.14), not a gap.
  const datasetsWithBatches = new Set([...groups.keys()].map((k) => k.split('|')[1]));
  for (const [s, d] of expected) if (!groups.has(`${s}|${d}`) && !datasetsWithBatches.has(d)) groups.set(`${s}|${d}`, []);

  const entries: FreshnessEntry[] = [];
  const claims: Claim[] = [];
  for (const [k, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [source, dataset] = k.split('|') as [string, string];
    const latest = list[0];
    const success = list.find((b) => b.status === 'succeeded');
    const range = datasetDateRange(db, siteId, dataset);
    let firstIncomplete = range.firstIncomplete;
    if (source === 'gsc') {
      const av = gscAvailability(db, siteId, env.gsc.property);
      if (av?.first_incomplete_date) firstIncomplete = av.first_incomplete_date;
    }
    const warnings = latest ? extractWarnings(latest.coverage_json) : [];
    const e: FreshnessEntry = {
      source,
      dataset,
      lastSuccessfulSyncAt: success?.finished_at ?? null,
      lastAttemptAt: latest?.started_at ?? null,
      lastStatus: latest?.status ?? null,
      latestDataDate: range.latest,
      firstIncompleteDate: firstIncomplete,
      coverageWarnings: warnings,
      truncated: latest?.truncated === 1,
    };
    entries.push(e);
    // One entry per source and dataset: the claim id names both (an import and a sync of the same dataset are separate entries).
    const claimId = `freshness.${source}.${dataset}`;
    if (!latest) {
      claims.push(unavailable(claimId, `${source} ${dataset}: never synced.`, 'no ingestion batch recorded for this dataset'));
      addDq(env, { severity: 'warning', code: `never_synced_${dataset}`, message: `${dataset} has never been synced.`, source, nextStep: `Run \`sync ${source}\`.` });
      continue;
    }
    const parts = [
      `last successful sync ${e.lastSuccessfulSyncAt ?? 'never'}`,
      `last attempt ${e.lastAttemptAt} (${e.lastStatus})`,
      `latest data date ${e.latestDataDate ?? 'none'}`,
      `first incomplete date ${e.firstIncompleteDate ?? 'none reported'}`,
    ];
    if (e.truncated) parts.push(source === 'import' ? `last batch incomplete (${OWNER_IMPORT_INCOMPLETE})` : 'last batch hit a documented row limit (truncated)');
    if (warnings.length) parts.push(`coverage warnings: ${warnings.slice(0, 3).join('; ')}`);
    const ids = [success?.id, latest.id].filter((x): x is string => !!x);
    claims.push(
      observed(claimId, `${source} ${dataset}: ${parts.join('; ')}.`, {
        sourceIds: batchSourceIds([...new Set(ids)]),
        retrievedAt: [success?.finished_at ?? latest.started_at],
        evidence: [...new Set(ids)].map((id) => recordLink('ingestion_batches', id)),
      }),
    );
    if (latest.status === 'failed' || latest.status === 'partial') {
      addDq(env, { severity: 'warning', code: `last_sync_${latest.status}_${dataset}`, message: `The latest ${dataset} sync ${latest.status === 'failed' ? 'failed' : 'was partial'} (batch ${latest.id}).`, source, nextStep: `Re-run \`sync ${source}\` and check \`doctor\`.`, recordRef: `ingestion_batches:${latest.id}` });
    }
    if (e.truncated) {
      addDq(env, {
        severity: 'warning',
        code: `truncated_${dataset}`,
        message: source === 'import' ? `The latest ${dataset} batch is an ${OWNER_IMPORT_INCOMPLETE}.` : `The latest ${dataset} batch hit a documented API row limit; lower-traffic rows may be missing.`,
        source,
        recordRef: `ingestion_batches:${latest.id}`,
        ...(source === 'import' ? { nextStep: OWNER_IMPORT_NEXT_STEP } : {}),
      });
    }
    if (e.latestDataDate && e.latestDataDate < env.period.end && (dataset === 'gsc_property_daily' || dataset === 'ga4_landing_daily')) {
      addDq(env, { severity: 'warning', code: `stale_${dataset}`, message: `${dataset} has data only up to ${e.latestDataDate}, before the period end ${env.period.end}.`, source, nextStep: `Run \`sync ${source}\`.` });
    }
  }
  // Non-batch sources
  const crawl = latestCrawl(db, siteId);
  const other: Array<{ source: string; dataset: string; at: string | null; status: string | null }> = [
    { source: 'crawl', dataset: 'crawls (own site)', at: crawl?.finished_at ?? crawl?.started_at ?? null, status: crawl?.status ?? null },
    { source: 'url_inspection', dataset: 'url_inspections', at: latestTimestamp(db, siteId, 'url_inspections'), status: null },
    { source: 'pagespeed', dataset: 'performance_checks', at: latestTimestamp(db, siteId, 'performance_checks'), status: null },
    { source: 'research', dataset: 'serp_snapshots (non-sandbox)', at: latestTimestamp(db, siteId, 'serp_snapshots'), status: null },
    { source: 'memory', dataset: 'memory_index_state', at: latestTimestamp(db, siteId, 'memory_index_state'), status: null },
  ];
  for (const o of other) {
    entries.push({ source: o.source, dataset: o.dataset, lastSuccessfulSyncAt: o.status && o.status !== 'completed' ? null : o.at, lastAttemptAt: o.at, lastStatus: o.status, latestDataDate: null, firstIncompleteDate: null, coverageWarnings: [], truncated: false });
  }
  if (crawl) markSynthetic(env, 'crawls', crawl.is_synthetic);
  env.data.freshness = entries;
  const table: ReportTable = {
    id: 'freshness',
    title: 'Data freshness per source',
    columns: ['Source', 'Dataset', 'Last successful sync', 'Last status', 'Latest data date', 'First incomplete date', 'Coverage warnings'],
    rows: entries.map((e) => [e.source, e.dataset, e.lastSuccessfulSyncAt ?? 'never', e.lastStatus ?? 'n/a', e.latestDataDate ?? 'n/a', e.firstIncompleteDate ?? 'n/a', e.coverageWarnings.length ? e.coverageWarnings.slice(0, 2).join('; ') + (e.truncated ? '; truncated' : '') : e.truncated ? 'truncated' : '']),
  };
  return section('freshness', 'Data freshness', {
    claims,
    tables: [table],
    notes: [`Search Console dates follow its reporting days (${GSC_DOC_TZ}); GA4 dates follow the property time zone. Incomplete dates are excluded from totals and comparisons.`],
  });
}

// ---------------------------------------------------------------------------
// Data quality and access issues
// ---------------------------------------------------------------------------

/**
 * How a truncated owner import (`data import` without --complete, stored with
 * truncated = 1) is described: the owner did not declare the file complete, so
 * a page or query absent from it is unknown on those dates, never zero. It
 * never hit an API row limit.
 */
export const OWNER_IMPORT_INCOMPLETE = 'owner import without --complete: rows absent from the file are unknown, not zero';
const OWNER_IMPORT_NEXT_STEP = 'If the export holds every row for its dates, import it again with `data import <dataset> <file> --complete`; otherwise pages absent from it stay unknown (never zero).';

export function dataQualitySection(env: BuildEnv): ReportSection {
  const { ctx, period } = env;
  const cfg = ctx.config;
  const features = ctx.settings.features;
  const access: AccessIssue[] = [];
  for (const s of env.statuses) {
    if (PROBLEM_STATES.has(s.state)) {
      access.push({ integration: s.id, state: s.state, detail: s.detail, nextStep: s.nextStep ?? null });
      addDq(env, {
        severity: s.id === 'google_gsc' || s.id === 'google_ga4' || s.id === 'google_auth' ? 'critical' : 'warning',
        code: `access_${s.id}_${s.state}`,
        message: `${s.id}: ${s.state} (${s.detail})`,
        source: s.id,
        recordRef: `integration_status:${s.id}`,
        ...(s.nextStep ? { nextStep: s.nextStep } : {}),
      });
    } else if (s.state === 'fixture') {
      addDq(env, { severity: 'info', code: `fixture_${s.id}`, message: `${s.id} uses synthetic fixtures (demo/test), not live data.`, source: s.id });
      env.synthetic.add(`integration:${s.id}`);
    }
  }
  env.data.accessIssues = access;
  env.data.statusesChecked = env.statusesChecked;
  if (!env.statusesChecked) {
    addDq(env, { severity: 'info', code: 'statuses_not_checked', message: 'Integration statuses were not checked for this report (built from the database only); unresolved access issues may not be listed.', nextStep: 'Run `doctor` to check integration access.', recordRef: 'integration_status:not_supplied' });
  }
  if (features.gsc && !cfg.google.searchConsoleProperty) addDq(env, { severity: 'warning', code: 'config_gsc_property_missing', message: 'No Search Console property is configured.', source: 'config', configField: 'google.searchConsoleProperty', nextStep: 'Discover it with `auth status` and set google.searchConsoleProperty.' });
  if (features.ga4 && !cfg.google.ga4PropertyId) addDq(env, { severity: 'warning', code: 'config_ga4_property_missing', message: 'No GA4 property ID is configured.', source: 'config', configField: 'google.ga4PropertyId', nextStep: 'Set google.ga4PropertyId (numeric).' });
  if (cfg.conversions.primaryEvents.length === 0) addDq(env, { severity: 'critical', code: 'config_primary_event_missing', message: 'No primary conversion event is configured; conversion rates cannot be reported.', source: 'config', configField: 'conversions.primaryEvents', nextStep: 'Add conversions.primaryEvents (exact GA4 key event name) and verify it with the manual test checklist.' });
  // Only the first primary event carries the session rate, converting sessions, routing, benchmarks, and experiment conversion metrics.
  const unusedPrimary = unusedPrimaryEvents(cfg.conversions.primaryEvents.map((e) => e.name));
  if (unusedPrimary.length) {
    addDq(env, {
      severity: 'warning',
      code: 'config_primary_events_not_rated',
      message: `Limitation: ${unusedPrimaryEventsReason(cfg.conversions.primaryEvents[0]!.name, unusedPrimary)}`,
      source: 'config',
      configField: 'conversions.primaryEvents',
      nextStep: 'Keep the event that should drive conversion decisions first in conversions.primaryEvents; move the others to conversions.secondaryEvents if they are not business outcomes that count.',
    });
  }
  // Conversion verification is a human activity (spec 12): until the owner records it, primary-event metrics carry a caveat.
  for (const name of unverifiedPrimaryEvents(env)) {
    addDq(env, {
      severity: 'warning',
      code: 'primary_event_unverified',
      message: `Primary event "${name}": tracking not yet verified by the owner (conversions.primaryEvents[].verifiedAt is not recorded), so its occurrences, rates, converting sessions, and users are reported with a caveat.`,
      source: 'config',
      configField: 'conversions.primaryEvents',
      nextStep: `Work through the checklist (\`npm run cli -- sync ga4 --checklist\`), then record the outcome with \`npm run cli -- setup --update --only conversions\` or set conversions.primaryEvents[].verifiedAt (YYYY-MM-DD) and verificationNote in the site config.`,
    });
  }

  // Batches overlapping the period: failures, truncation, coverage, GA4 metadata flags.
  const inPeriod = recentBatches(ctx.db, ctx.siteId).filter((b) => b.date_start <= period.end && b.date_end >= period.start);
  for (const b of inPeriod) {
    markSynthetic(env, 'ingestion_batches', b.is_synthetic);
    const recordRef = `ingestion_batches:${b.id}`;
    if (b.status === 'failed') addDq(env, { severity: 'warning', code: `batch_failed_${b.dataset}`, message: `Batch ${b.id} (${b.dataset}, ${b.date_start} to ${b.date_end}) failed.`, source: b.source, recordRef });
    if (b.truncated === 1) {
      addDq(env, {
        severity: 'warning',
        code: `batch_truncated_${b.dataset}`,
        message: b.source === 'import' ? `Batch ${b.id} (${b.dataset}, ${b.date_start} to ${b.date_end}) is an ${OWNER_IMPORT_INCOMPLETE}.` : `Batch ${b.id} (${b.dataset}) hit a documented row limit; rows beyond the limit are missing.`,
        source: b.source,
        recordRef,
        ...(b.source === 'import' ? { nextStep: OWNER_IMPORT_NEXT_STEP } : {}),
      });
    }
    for (const w of extractWarnings(b.coverage_json, 5)) addDq(env, { severity: 'info', code: `coverage_${b.dataset}`, message: `${b.dataset}: ${w}`, source: b.source, recordRef });
    if (b.source === 'ga4') for (const f of ga4MetadataFlags(b.metadata_json)) addDq(env, { severity: 'warning', code: 'ga4_metadata', message: f, source: 'ga4', recordRef });
  }
  const claims: Claim[] = [];
  // Access issues
  if (access.length) {
    access.forEach((a, i) =>
      claims.push(
        observed(`access.${i + 1}.${a.integration}`, `Unresolved access issue: ${a.integration} is ${a.state}: ${a.detail}.${a.nextStep ? ` Next step: ${a.nextStep}` : ''}`, {
          sourceIds: [`integration_status:${a.integration}`],
          retrievedAt: env.statuses.filter((s) => s.id === a.integration).map((s) => s.checkedAt),
          evidence: [{ kind: 'integration_status', label: `${a.integration} status`, ref: `integration_status:${a.integration}`, supportsClaim: true }],
        }),
      ),
    );
  } else if (env.statusesChecked) {
    claims.push(
      observed('access.none', `No unresolved access issues among ${env.statuses.length} checked integration(s).`, {
        sourceIds: env.statuses.map((s) => `integration_status:${s.id}`),
        retrievedAt: env.statuses.map((s) => s.checkedAt),
        evidence: [{ kind: 'integration_status', label: 'integration statuses supplied to this report', ref: 'integration_status:*', supportsClaim: true }],
      }),
    );
  } else {
    claims.push(unavailable('access.unchecked', 'Unresolved access issues: not checked for this report.', 'integration statuses were not supplied (database-only rebuild); run `doctor`'));
  }
  const tables: ReportTable[] = [];
  if (env.statuses.length) {
    tables.push({
      id: 'integration_status',
      title: 'Integration status',
      columns: ['Integration', 'State', 'Detail', 'Next step', 'Sends externally'],
      rows: env.statuses.map((s) => [s.id, s.state, s.detail, s.nextStep ?? '', s.sendsExternally.join('; ')]),
    });
  }
  return section('data_quality', 'Data quality and access issues', { claims, tables });
}

/** Called after every other section so all collected data-quality items are included. */
export function finalizeDataQuality(env: BuildEnv, dq: ReportSection): void {
  if (env.synthetic.size > 0 && !isDemoReport(env)) {
    addDq(env, { severity: 'critical', code: 'synthetic_in_live', message: `Synthetic rows were found in this non-demo site's data (${[...env.synthetic].join(', ')}). Measurements are not real.`, nextStep: 'Use an isolated demo workspace for synthetic data; never mix it into live reporting.' });
  }
  env.data.dataQuality = env.dq;
  const order = { critical: 0, warning: 1, info: 2 } as const;
  const sorted = [...env.dq].sort((a, b) => order[a.severity] - order[b.severity] || a.code.localeCompare(b.code));
  sorted.forEach((d, i) => {
    const ev: EvidenceLink[] = d.configField
      ? [configLink(d.configField, env.ctx.siteId)]
      : d.recordRef?.startsWith('integration_status:')
        ? [{ kind: 'integration_status', label: 'integration status supplied to this report', ref: d.recordRef, supportsClaim: true }]
        : d.recordRef
          ? [{ kind: 'db_record', label: d.recordRef, ref: d.recordRef, supportsClaim: true }]
          : [reportSectionLink(d.source === 'gsc' ? 'gsc_performance' : d.source === 'ga4' ? 'google_organic' : d.source === 'crawl' ? 'crawl_summary' : 'freshness', 'report section with the underlying measurements')];
    dq.claims.push(
      observed(`dq.${i + 1}.${d.code}`, `${d.severity.toUpperCase()}: ${d.message}${d.nextStep ? ` Next step: ${d.nextStep}` : ''}`, {
        sourceIds: [d.recordRef ?? `data_quality:${d.code}`],
        retrievedAt: [env.generatedAt], // deterministic check evaluated at report generation
        evidence: ev,
      }),
    );
  });
  if (sorted.length === 0) {
    dq.claims.push(observed('dq.none', 'No data-quality warnings were detected by the deterministic checks.', { sourceIds: ['data_quality:checks'], retrievedAt: [env.generatedAt], evidence: [reportSectionLink('freshness', 'freshness checks')] }));
  }
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

export function assessConfidence(env: BuildEnv): ConfidenceAssessment {
  const reasons: string[] = [];
  const rank = { high: 3, medium: 2, low: 1, none: 0 } as const;
  let level: keyof typeof rank = 'high';
  const cap = (l: keyof typeof rank, why: string) => {
    reasons.push(why);
    if (rank[l] < rank[level]) level = l;
  };
  const g = env.data.gsc?.current;
  const go = env.data.googleOrganic;
  if (env.synthetic.size > 0) cap('none', 'synthetic data: these are not real measurements');
  if (!g || g.status === 'missing' || g.status === 'unavailable') cap(go && go.status !== 'missing' && go.status !== 'unavailable' ? 'low' : 'none', 'Search Console property totals are unavailable');
  else if (g.status === 'incomplete') cap('medium', 'Search Console totals cover only part of the period');
  if (!go || go.status === 'missing' || go.status === 'unavailable') cap('low', 'GA4 Google organic data is unavailable');
  else if (go.status === 'incomplete') cap('medium', 'GA4 data covers only part of the period');
  else if (go.value.primarySessionRate.status !== 'observed') cap('medium', go.value.primarySessionRateUnverified ? 'the primary-event conversion rate scale is unverified (shown as a raw value only)' : 'the primary-event conversion rate is unavailable');
  if ((env.data.accessIssues ?? []).some((a) => a.integration.startsWith('google'))) cap('low', 'unresolved Google access issues');
  if (!env.statusesChecked) cap('medium', 'integration statuses were not checked');
  if (env.dq.some((d) => d.code.startsWith('batch_truncated') || d.code.startsWith('batch_failed') || d.code.startsWith('last_sync_'))) cap('medium', env.dq.some((d) => d.code.startsWith('batch_truncated') && d.source === 'import') ? 'failed, partial, or truncated syncs, or incomplete owner imports, affect the period' : 'failed, partial, or truncated syncs affect the period');
  if (env.dq.some((d) => d.code === 'ga4_metadata')) cap('medium', 'GA4 reported thresholding, sampling, truncation, or restrictions');
  if (reasons.length === 0) reasons.push('complete Search Console and GA4 data for the period, no access issues, no truncation');
  return { level, reasons };
}

export function confidenceSection(env: BuildEnv): ReportSection {
  const c = assessConfidence(env);
  env.data.confidence = c;
  return section('evidence_confidence', 'Evidence confidence', {
    claims: [
      inferred('confidence.level', `Evidence confidence: ${c.level.toUpperCase()}. ${c.reasons.join('; ')}.`, {
        sourceIds: [...batchSourceIds([...env.sourceBatchIds].slice(0, 20)), 'data_quality:checks'],
        metricIds: ['confidence.level'],
        evidence: [reportSectionLink('data_quality', 'data-quality section'), reportSectionLink('freshness', 'freshness section')],
      }),
    ],
    notes: ['A deterministic assessment of data coverage and quality, not a statistical confidence interval.'],
  });
}

// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------

function sampleReq(json: string, keys: string[]): number | null {
  const o = parseJson<Record<string, unknown>>(json, {});
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

export function summarizeExperiment(env: BuildEnv, e: ExperimentRow): ExperimentSummary {
  const tz = env.period.timeZone;
  const cfg = env.ctx.config.experiments;
  const today = dateInZone(env.ctx.clock.now(), tz);
  const until = env.period.latestCompleteDate && env.period.latestCompleteDate < today ? env.period.latestCompleteDate : addDays(today, -1);
  const start = e.observation_start ?? (e.implemented_at ? dateInZone(new Date(e.implemented_at), tz) : null);
  const wantsSeo = e.outcome_kind === 'seo_visibility' || e.outcome_kind === 'both';
  const wantsConv = e.outcome_kind === 'conversion' || e.outcome_kind === 'both';
  const reqImp = sampleReq(e.sample_requirements_json, ['minImpressions', 'min_impressions', 'impressions']) ?? (wantsSeo ? cfg.minImpressionsForEvaluation : null);
  const reqSes = sampleReq(e.sample_requirements_json, ['minSessions', 'min_sessions', 'sessions']) ?? (wantsConv ? cfg.minSessionsForConversionEvaluation : null);
  let days: number | null = null;
  let imp: number | null = null;
  let ses: number | null = null;
  let enough = false;
  let note: string;
  let interfering = 0;
  if (e.status !== 'observing' || !start) {
    note =
      e.status === 'observing'
        ? 'Observing, but no observation start or implementation time is recorded; evidence cannot be assessed.'
        : 'Measurement window has not started: approval or draft creation does not start it. Record the real deployment with `experiments mark-implemented`.';
  } else {
    days = start <= until ? daysBetweenInclusive(start, until) : 0;
    if (e.page_id) {
      if (env.gsc.property) imp = pageImpressionsSince(env.ctx.db, env.ctx.siteId, { pageId: e.page_id, property: env.gsc.property, searchType: env.gsc.searchType, since: start, until });
      if (env.ga4.propertyId) ses = pageSessionsSince(env.ctx.db, env.ctx.siteId, { pageId: e.page_id, propertyId: env.ga4.propertyId, since: start, until });
    }
    interfering = countAnnotations(env.ctx.db, env.ctx.siteId, e.page_id, e.implemented_at ?? `${start}T00:00:00.000Z`);
    const missingParts: string[] = [];
    if (days < e.min_observation_days) missingParts.push(`${days} of ${e.min_observation_days} minimum days`);
    if (reqImp !== null && (imp ?? 0) < reqImp) missingParts.push(`${imp === null ? 'no' : fmtInt(imp)} of ${fmtInt(reqImp)} required impressions`);
    if (reqSes !== null && (ses ?? 0) < reqSes) missingParts.push(`${ses === null ? 'no' : fmtInt(ses)} of ${fmtInt(reqSes)} required sessions`);
    enough = missingParts.length === 0;
    note = enough
      ? `Enough evidence to evaluate (${days} days, minimum ${e.min_observation_days}). Any before/after comparison is observational, not proof of causality.`
      : `Not enough evidence yet: ${missingParts.join('; ')}. Keep observing; do not stack unrelated changes on this page.`;
    if (interfering > 0) note += ` ${interfering} change annotation(s) since implementation may interfere with measurement.`;
  }
  return {
    id: e.id,
    status: e.status,
    type: e.type,
    pageUrl: e.page_url,
    hypothesis: e.hypothesis,
    primaryMetric: e.primary_metric,
    observationStart: start,
    daysObserved: days,
    minObservationDays: e.min_observation_days,
    impressionsSinceStart: imp,
    sessionsSinceStart: ses,
    requiredImpressions: reqImp,
    requiredSessions: reqSes,
    enoughEvidence: enough,
    evidenceNote: note,
    reviewDate: e.review_date,
    interferingChanges: interfering,
  };
}

export function experimentsSection(env: BuildEnv, opts: { baseline?: boolean } = {}): ReportSection {
  const rows = activeExperiments(env.ctx.db, env.ctx.siteId);
  const sums = rows.map((e) => summarizeExperiment(env, e));
  env.data.experiments = sums;
  const link = dbQueryLink('experiments', { site_id: env.ctx.siteId, status: 'approved|awaiting_implementation|observing' });
  const by = (s: string) => sums.filter((x) => x.status === s).length;
  const claims: Claim[] = [
    observed('experiments.active', sums.length ? `${sums.length} active experiment(s): ${by('observing')} observing, ${by('awaiting_implementation')} awaiting implementation, ${by('approved')} approved.` : 'No active experiments.', {
      sourceIds: sums.length ? sums.map((s) => `experiments:${s.id}`) : ['experiments:none'],
      retrievedAt: [env.generatedAt], // experiment state as read at report generation
      metricIds: [],
      evidence: [link],
    }),
  ];
  for (const s of sums) {
    const target: LinkTarget = { kind: 'experiment', id: s.id, label: `Experiment ${s.id}` };
    claims.push(
      inferred(`experiments.${s.id}.evidence`, `${s.type} experiment on ${s.pageUrl ?? 'an unknown page'} (${s.status}): ${s.evidenceNote}${s.reviewDate ? ` Review date: ${s.reviewDate}.` : ''}`, {
        sourceIds: [`experiments:${s.id}`],
        metricIds: ['experiments.observation_days', 'experiments.enough_evidence'],
        evidence: [recordLink('experiments', s.id), ...(s.pageUrl ? [dbQueryLink('gsc_page_daily_current', { site_id: env.ctx.siteId, page: s.pageUrl, date: `${s.observationStart ?? '?'}..` })] : [])],
        links: [target],
      }),
    );
  }
  const notes = opts.baseline ? ['The baseline does not start experiments or publish anything.'] : ['A weekly schedule does not imply weekly conclusive experiments; low-traffic pages need long observation windows.'];
  return section('experiments', 'Active experiments', {
    claims,
    notes,
    tables: sums.length
      ? [
          {
            id: 'experiments.active',
            title: 'Active experiments',
            columns: ['ID', 'Page', 'Status', 'Start', 'Days (min)', 'Impressions (required)', 'Sessions (required)', 'Enough evidence', 'Review date'],
            rows: sums.map((s) => [s.id, s.pageUrl ?? '', s.status, s.observationStart ?? 'not started', s.daysObserved === null ? 'n/a' : `${s.daysObserved} (${s.minObservationDays})`, `${s.impressionsSinceStart === null ? 'n/a' : fmtInt(s.impressionsSinceStart)} (${s.requiredImpressions === null ? '-' : fmtInt(s.requiredImpressions)})`, `${s.sessionsSinceStart === null ? 'n/a' : fmtInt(s.sessionsSinceStart)} (${s.requiredSessions === null ? '-' : fmtInt(s.requiredSessions)})`, s.enoughEvidence ? 'yes' : 'no', s.reviewDate ?? '']),
          },
        ]
      : [],
  });
}

// ---------------------------------------------------------------------------
// Primary action (one action or an explicit wait)
// ---------------------------------------------------------------------------

/** Demo profile/site or demo context: synthetic data is expected there (still watermarked). */
export function isDemoReport(env: BuildEnv): boolean {
  return env.ctx.config.profile === 'demo' || env.synthetic.has('demo_site') || env.synthetic.has('demo_context');
}

function isSyntheticEvidence(r: ClaimEvidenceRow): boolean {
  return r.trust_class === 'synthetic';
}

/**
 * Claim from a stored claim_evidence row. Evidence whose source is synthetic
 * (fixtures, DataForSEO sandbox) marks the report synthetic (watermark +
 * critical data-quality item in a live site) and, outside a demo report, never
 * counts as support: the claim is shown as context only.
 */
function claimFromEvidenceRow(env: BuildEnv, r: ClaimEvidenceRow, id: string): Claim {
  const syntheticEv = isSyntheticEvidence(r);
  if (syntheticEv) markSynthetic(env, 'sources', 1);
  const excluded = syntheticEv && !isDemoReport(env);
  const evidence: EvidenceLink[] = [];
  const supports = r.support === 'supports' && !!r.evidence_id && !!(r.ev_summary || r.ev_excerpt) && !excluded;
  const excludedNote = excluded ? 'synthetic/sandbox source: not a real measurement and not used as support in a live report' : null;
  if (r.evidence_id) evidence.push({ kind: 'evidence', label: r.ev_summary ?? `evidence ${r.evidence_id}`, ref: `evidence:${r.evidence_id}`, supportsClaim: supports, note: excludedNote ?? (r.ev_excerpt ? r.ev_excerpt.slice(0, 280) : r.support) });
  if (r.source_url) evidence.push({ kind: 'url', label: r.source_title ?? r.source_url, ref: r.source_url, supportsClaim: false, note: 'source location only; the evidence item above is what supports (or not) the claim' });
  if (r.raw_ref) evidence.push({ kind: 'raw_ref', label: 'raw response (private workspace)', ref: r.raw_ref, supportsClaim: false });
  const label = r.claim_label as ClaimLabel;
  const status = label === 'DATA_UNAVAILABLE' ? 'not_applicable' : supports ? 'supported' : evidence.length ? 'context_only' : 'missing';
  const suffix =
    (label === 'OBSERVED' || label === 'INFERRED') && status !== 'supported'
      ? excluded
        ? ' [evidence not verifiable from this report: the only evidence is synthetic/sandbox data]'
        : ' [evidence not verifiable from this report: no supporting evidence item recorded]'
      : '';
  return claim(label, id, `${r.claim_text}${suffix}`, {
    sourceIds: [r.source_id ? `sources:${r.source_id}` : null, r.evidence_id ? `evidence:${r.evidence_id}` : null, `claim_evidence:${r.id}`].filter((x): x is string => !!x),
    retrievedAt: [r.retrieved_at, r.ev_collected].filter((x): x is string => !!x),
    evidence,
    evidenceStatus: status,
    ...(label === 'DATA_UNAVAILABLE' ? { reason: r.claim_text } : {}),
    ...(syntheticEv ? { synthetic: true } : {}),
  });
}

/**
 * Days after an explicit period's end during which a recommendation still
 * belongs to that period (the analysis runs after the period's data is
 * complete). A documented default, not an owner-specific value.
 */
export const RECOMMENDATION_GRACE_DAYS = 7;

/** Latest instant a recommendation may have been recorded at to belong to this report. */
export function recommendationCutoff(env: BuildEnv): string {
  if (!env.period.explicit) return env.generatedAt;
  const bound = `${addDays(env.period.end, RECOMMENDATION_GRACE_DAYS)}T23:59:59.999Z`;
  return bound < env.generatedAt ? bound : env.generatedAt;
}

/**
 * The recommend stage of the pipeline run that produced this report noted
 * HISTORICAL_PERIOD (weekly --from/--to ending before the latest complete
 * date): what it assembled for review only, or null.
 */
function historicalReviewOnly(env: BuildEnv): { assembled: string; detail: string } | null {
  const n = pipelineStage(env, 'recommend');
  if (!n || n.code !== 'HISTORICAL_PERIOD') return null;
  const m = /assembled for this review only: (.+?)\.?$/s.exec(n.detail);
  return { assembled: (m?.[1] ?? 'the recommendation of this run').trim(), detail: n.detail };
}

export function primaryActionSection(env: BuildEnv): ReportSection {
  const { ctx, period } = env;
  const notAfter = recommendationCutoff(env);
  const jobRec = env.jobId ? jobPrimaryRecommendation(ctx.db, ctx.siteId, env.jobId) : undefined;
  const jobRecNotLive = jobRec && !isLiveRecommendation(jobRec.status) ? jobRec : undefined;
  const rec = jobRecNotLive ? undefined : latestPrimaryRecommendation(ctx.db, ctx.siteId, { jobId: env.jobId, notAfter });
  const claims: Claim[] = [];
  const tables: ReportTable[] = [];
  const notes: string[] = [];
  const historical = historicalReviewOnly(env);
  if (!rec && historical && !jobRecNotLive) {
    // An explicit historical period: the run assembled a recommendation for review only (never saved, nothing superseded).
    // Stated as such, never as a generic "wait" that would contradict the run summary.
    env.data.primaryAction = { kind: 'review_only', recommendationId: null, title: `Review only (explicit historical period; not saved): ${historical.assembled}`, actionType: null, pageUrl: null, query: null, diagnosis: null, proposedChange: null, hypothesis: null, successCriteria: null, risks: null, reviewDate: null, status: null, createdAt: null, secondary: [] };
    claims.push(
      recommendation(
        'action.primary',
        `Review only: for the explicit historical period ${period.start} to ${period.end}, this run assembled the recommendation "${historical.assembled}" for review only. It was not saved, supersedes no earlier proposal, and is not a current recommendation, so no production change follows from this report. For a current recommendation, run weekly without --from/--to.`,
        {
          reason: historical.detail,
          sourceIds: [env.jobId ? `jobs:${env.jobId}` : 'jobs:this_run', 'recommendations:not_saved'],
          evidence: [...(env.jobId ? [recordLink('jobs', env.jobId, `job ${env.jobId} (recommend stage, HISTORICAL_PERIOD)`)] : []), reportSectionLink('data_quality', 'pipeline stage statuses')],
        },
      ),
    );
    return section('primary_action', 'Prioritized action', {
      claims,
      notes: [`HISTORICAL_PERIOD: ${historical.detail}`, `Only recommendations recorded no later than ${notAfter} (period end plus ${RECOMMENDATION_GRACE_DAYS} days) belong to this explicit period; none is recorded, and this run saved none.`],
    });
  }
  if (rec && historical) notes.push(`This run covered an explicit historical period and assembled "${historical.assembled}" for review only (not saved, nothing superseded); the prioritized action below is the recommendation recorded for this period at the time.`);
  if (!rec) {
    env.data.primaryAction = { kind: 'wait', recommendationId: null, title: 'Wait: no production change recommended', actionType: null, pageUrl: null, query: null, diagnosis: null, proposedChange: null, hypothesis: null, successCriteria: null, risks: null, reviewDate: null, status: null, createdAt: null, secondary: [] };
    const recsLink = dbQueryLink('recommendations', { site_id: ctx.siteId, kind: 'primary|no_action|repair_measurement|collect_more_evidence', status: 'proposed|approved', created_at: `<=${notAfter}` });
    claims.push(
      jobRecNotLive
        ? recommendation('action.primary', `Wait: no production change is recommended in this report. The recommendation recorded by this job ("${jobRecNotLive.title}") is ${jobRecNotLive.status}, so it is not shown as the prioritized action and no other recommendation replaces it.`, {
            reason: `the job's recommendation ${jobRecNotLive.id} has status ${jobRecNotLive.status}`,
            sourceIds: [`recommendations:${jobRecNotLive.id}`],
            retrievedAt: [jobRecNotLive.created_at],
            evidence: [recordLink('recommendations', jobRecNotLive.id, `recommendation ${jobRecNotLive.id} (${jobRecNotLive.status})`)],
          })
        : recommendation('action.primary', 'Wait: no production change is recommended in this report. No live (proposed or approved) evidence-backed recommendation has been recorded for this period, so leave pages unchanged until the analysis produces one.', {
            reason: 'no live primary, no-action, repair-measurement, or collect-more-evidence recommendation is recorded for this period',
            sourceIds: ['recommendations:none'],
            evidence: [recsLink],
          }),
    );
    const waitNotes = ['An appropriate decision can be to leave pages unchanged, repair measurement first, or collect more evidence.'];
    if (period.explicit) waitNotes.push(`Only recommendations recorded no later than ${notAfter} (period end plus ${RECOMMENDATION_GRACE_DAYS} days) belong to this explicit period.`);
    return section('primary_action', 'Prioritized action', { claims, notes: waitNotes });
  }
  const secondary = secondaryRecommendations(ctx.db, ctx.siteId, rec);
  const kind = rec.kind as PrimaryActionSummary['kind'];
  env.data.primaryAction = {
    kind,
    recommendationId: rec.id,
    title: rec.title,
    actionType: rec.action_type,
    pageUrl: rec.page_url,
    query: rec.query,
    diagnosis: rec.diagnosis,
    proposedChange: rec.proposed_change,
    hypothesis: rec.hypothesis,
    successCriteria: rec.success_criteria,
    risks: rec.risks,
    reviewDate: rec.review_date,
    status: rec.status,
    createdAt: rec.created_at,
    secondary: secondary.map((s) => ({ id: s.id, title: s.title, kind: s.kind })),
  };
  const recLink = recordLink('recommendations', rec.id, `recommendation ${rec.id}`);
  const targets: LinkTarget[] = [{ kind: 'recommendation', id: rec.id, label: rec.title }];
  if (rec.page_url) targets.push({ kind: 'page', id: rec.page_id ?? rec.page_url, label: rec.page_url, url: rec.page_url });
  const prefix =
    kind === 'no_action' ? 'Leave unchanged' : kind === 'repair_measurement' ? 'Repair measurement first' : kind === 'collect_more_evidence' ? 'Collect more evidence before changing anything' : 'Primary action';
  const what = rec.proposed_change ? `${rec.title}. Proposed change: ${rec.proposed_change}` : rec.title;
  claims.push(
    recommendation('action.primary', `${prefix}: ${what}`, {
      sourceIds: [`recommendations:${rec.id}`],
      retrievedAt: [rec.created_at],
      evidence: [recLink],
      links: targets,
    }),
  );
  // Supporting measurements computed here from current-revision views.
  const measureLinks: EvidenceLink[] = [];
  const g = env.gsc;
  if (g.property && (rec.page_id || rec.page_url)) {
    const pm = gscPageMetrics(ctx.db, ctx.siteId, { pageId: rec.page_id, pageUrl: rec.page_url, property: g.property, searchType: g.searchType, start: period.start, end: period.end });
    if (pm) {
      markSynthetic(env, 'gsc_page_daily', pm.syn);
      const l = dbQueryLink('gsc_page_daily_current', { site_id: ctx.siteId, property: g.property, search_type: g.searchType, [rec.page_id ? 'page_id' : 'page']: rec.page_id ?? rec.page_url, segment_key: "''", date: `${period.start}..${period.end}`, is_final: 1 });
      measureLinks.push(l);
      claims.push(
        observed('action.measure.page', `Page ${rec.page_url ?? rec.page_id}: ${fmtInt(pm.clicks)} clicks, ${fmtInt(pm.impressions)} impressions, CTR ${fmtPct(ctr(pm.clicks, pm.impressions))}, position ${fmtPos(weightedPositionFromSums(pm.pos_weighted, pm.pos_impressions))} (${period.start} to ${period.end}, byPage).`, {
          sourceIds: batchSourceIds(pm.batchIds),
          retrievedAt: pm.collectedAt,
          metricIds: ['gsc.page', 'gsc.ctr', 'gsc.position'],
          evidence: [l],
          synthetic: pm.syn,
        }),
      );
    }
    if (rec.query) {
      const qm = gscPageMetrics(ctx.db, ctx.siteId, { pageId: rec.page_id, pageUrl: rec.page_url, property: g.property, searchType: g.searchType, start: period.start, end: period.end, query: rec.query });
      if (qm) {
        const l = dbQueryLink('gsc_page_query_daily_current', { site_id: ctx.siteId, property: g.property, search_type: g.searchType, [rec.page_id ? 'page_id' : 'page']: rec.page_id ?? rec.page_url, query: rec.query, date: `${period.start}..${period.end}`, is_final: 1 });
        measureLinks.push(l);
        claims.push(
          observed('action.measure.query', `Query "${rec.query}" on this page: ${fmtInt(qm.clicks)} clicks, ${fmtInt(qm.impressions)} impressions, CTR ${fmtPct(ctr(qm.clicks, qm.impressions))}, position ${fmtPos(weightedPositionFromSums(qm.pos_weighted, qm.pos_impressions))} (visible query rows).`, {
            sourceIds: batchSourceIds(qm.batchIds),
            retrievedAt: qm.collectedAt,
            metricIds: ['gsc.query.visible', 'gsc.ctr', 'gsc.position'],
            evidence: [l],
            synthetic: qm.syn,
          }),
        );
      } else {
        claims.push(unavailable('action.measure.query', `Query "${rec.query}" metrics for this page are unavailable for the period.`, 'no visible page/query rows (anonymized or not fetched)', { metricIds: ['gsc.query.visible'] }));
      }
    }
  }
  if (env.ga4.propertyId && rec.page_id) {
    const r = ga4ChannelAggregate(ctx.db, ctx.siteId, env.ga4.propertyId, 'google_organic', period.start, period.end, rec.page_id);
    if (r.agg) {
      const l = dbQueryLink('ga4_landing_daily_current', { site_id: ctx.siteId, property_id: env.ga4.propertyId, channel_view: 'google_organic', page_id: rec.page_id, date: `${period.start}..${period.end}`, is_complete: 1 });
      measureLinks.push(l);
      claims.push(
        observed('action.measure.ga4', `GA4 Google organic sessions landing on this page: ${fmtInt(Number(r.agg.sessions ?? 0))}.`, {
          sourceIds: batchSourceIds(r.batchIds),
          retrievedAt: r.collectedAt,
          metricIds: ['ga4.sessions.google_organic'],
          evidence: [l],
          synthetic: Number(r.agg.syn ?? 0) === 1,
        }),
      );
    }
  }
  const linked = claimEvidenceFor(ctx.db, ctx.siteId, 'recommendation', rec.id);
  linked.forEach((r, i) => claims.push(claimFromEvidenceRow(env, r, `action.evidence.${i + 1}`)));
  if (rec.diagnosis) {
    const liveOnly = !isDemoReport(env);
    const ev = [...measureLinks, ...linked.filter((l) => l.support === 'supports' && l.evidence_id && !(liveOnly && isSyntheticEvidence(l))).map((l) => ({ kind: 'evidence' as const, label: l.ev_summary ?? `evidence ${l.evidence_id}`, ref: `evidence:${l.evidence_id}`, supportsClaim: true }))];
    claims.push(
      inferred('action.diagnosis', `Diagnosis: ${rec.diagnosis}${ev.length ? '' : ' [no linked measurements or evidence items were recorded for this diagnosis]'}`, {
        sourceIds: [`recommendations:${rec.id}`],
        retrievedAt: [rec.created_at],
        evidence: ev.length ? ev : [{ ...recLink, supportsClaim: false }],
        evidenceStatus: ev.length ? 'supported' : 'missing',
      }),
    );
  }
  if (rec.hypothesis) claims.push(claim('HYPOTHESIS', 'action.hypothesis', `Hypothesis: ${rec.hypothesis}`, { sourceIds: [`recommendations:${rec.id}`], evidence: [recLink] }));
  if (rec.query && rec.page_url) {
    claims.push(claim('HYPOTHESIS', 'action.query_attribution', 'Query-level business impact is a hypothesis based on page-level evidence; a landing-page conversion is not attributed to a specific keyword.', { sourceIds: [`recommendations:${rec.id}`], evidence: [recLink] }));
  }
  secondary.forEach((s, i) =>
    claims.push(recommendation(`action.secondary.${i + 1}`, `Secondary observation: ${s.title}${s.page_url ? ` (${s.page_url})` : ''}.`, { sourceIds: [`recommendations:${s.id}`], evidence: [recordLink('recommendations', s.id)], links: [{ kind: 'recommendation', id: s.id, label: s.title }] })),
  );
  tables.push({
    id: 'action.details',
    title: 'Proposal details',
    columns: ['Field', 'Value'],
    rows: [
      ['Kind', rec.kind],
      ['Action type', rec.action_type],
      ['Status', rec.status],
      ['Page', rec.page_url ?? ''],
      ['Query', rec.query ?? ''],
      ['Proposed change', rec.proposed_change ?? ''],
      ['Hypothesis', rec.hypothesis ?? ''],
      ['Success criteria', rec.success_criteria ?? ''],
      ['Risks', rec.risks ?? ''],
      ['Review date', rec.review_date ?? ''],
      ['Recorded', rec.created_at],
      ['Model / prompt', [rec.model_id, rec.prompt_version].filter(Boolean).join(' / ') || 'deterministic or not recorded'],
    ],
  });
  if (rec.created_at.slice(0, 10) < addDays(period.start, -14)) notes.push(`This recommendation was recorded on ${rec.created_at.slice(0, 10)}, before this period; re-check it against current data.`);
  notes.push('Production changes require a human approval bound to this exact proposal (`approvals list`).');
  return section('primary_action', 'Prioritized action', { claims, tables, notes });
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export function contentSection(env: BuildEnv): ReportSection {
  const { ctx, period } = env;
  const q = contentQueue(ctx.db, ctx.siteId, env.topN);
  env.data.contentStages = q.stages;
  env.data.contentQueue = q.items.map((i) => ({
    id: i.id,
    title: i.title,
    stage: i.stage,
    decision: i.decision,
    priorityScore: i.priority_score,
    draftStatus: i.draft_status,
    unresolvedFacts: i.unresolved_facts,
    reviewVerdict: i.review_verdict,
    publishedAt: i.published_at,
    synthetic: i.is_synthetic === 1,
  }));
  for (const i of q.items) markSynthetic(env, 'content_items', i.is_synthetic);
  const link = dbQueryLink('content_items', { site_id: ctx.siteId });
  const stages = Object.entries(q.stages).map(([s, n]) => `${s} ${n}`).join(', ');
  const claims: Claim[] = [
    observed('content.queue', q.total ? `${q.total} content item(s) in the pipeline (${stages}).` : 'No content items are in the pipeline.', { sourceIds: ['content_items:*'], retrievedAt: [env.generatedAt], evidence: [link] }),
  ];
  const published = ctx.db.all<{ id: string; url: string; implemented_at: string }>(
    `SELECT id, url, implemented_at FROM publications WHERE site_id = ? AND subject_type = 'draft' AND substr(implemented_at, 1, 10) BETWEEN ? AND ? ORDER BY implemented_at`,
    [ctx.siteId, period.start, period.end],
  );
  claims.push(
    observed('content.published', published.length ? `${published.length} content publication(s) recorded in the period: ${published.slice(0, 5).map((p) => `${p.url} (${p.implemented_at.slice(0, 10)})`).join(', ')}.` : 'No content publications were recorded in the period.', {
      sourceIds: published.length ? published.map((p) => `publications:${p.id}`) : ['publications:none'],
      retrievedAt: [env.generatedAt],
      evidence: [dbQueryLink('publications', { site_id: ctx.siteId, subject_type: 'draft', implemented_at: `${period.start}..${period.end}` })],
    }),
  );
  const blocked = q.items.filter((i) => (i.unresolved_facts ?? 0) > 0);
  if (blocked.length) {
    claims.push(observed('content.unresolved_facts', `${blocked.length} draft(s) have unresolved facts; publication stays blocked until they are resolved.`, { sourceIds: blocked.map((b) => `content_drafts:${b.draft_id}`), retrievedAt: [env.generatedAt], evidence: blocked.map((b) => recordLink('content_drafts', b.draft_id ?? '')) }));
  }
  const notes = ctx.settings.features.contentDiscovery ? [] : ['Content discovery is disabled for this site (features.contentDiscovery).'];
  notes.push('Discovered topics are never drafted or published automatically; drafts need the configured approval and human review.');
  return section('content', 'Content opportunities and pipeline', {
    claims,
    notes,
    tables: q.items.length
      ? [
          {
            id: 'content.queue',
            title: `Content queue (top ${q.items.length} of ${q.total})`,
            columns: ['Title', 'Stage', 'Decision', 'Draft status', 'Unresolved facts', 'Review verdict', 'Published'],
            rows: q.items.map((i) => [i.title, i.stage, i.decision ?? '', i.draft_status ?? '', i.unresolved_facts ?? '', i.review_verdict ?? '', i.published_at ? i.published_at.slice(0, 10) : '']),
            totalRows: q.total,
          },
        ]
      : [],
  });
}

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------

/** An instant that falls on local date `date` in `timeZone` (IANA). */
export function instantOnLocalDate(date: string, timeZone: string): Date {
  const noon = Date.parse(`${date}T12:00:00.000Z`);
  for (const h of [0, -3, 3, -6, 6, -9, 9, -12, 12, -14, 14]) {
    const t = new Date(noon + h * 3_600_000);
    if (dateInZone(t, timeZone) === date) return t;
  }
  return new Date(noon);
}

type SpendReportT = NonNullable<BuildEnv['data']['spend']>;

/**
 * Cost basis of one provider: the provider-reported and computed-from-usage
 * parts of its actual amount, and its synthetic (fixture, sandbox, demo)
 * share. A report without a basis entry (older spend reports) counts the
 * whole actual amount as provider-reported, as it did before the split.
 */
function spendBasisOf(r: SpendReportT, p: SpendReportT['providers'][number]): { reportedMicros: number; computedMicros: number; computedCount: number; syntheticMicros: number; syntheticCount: number } {
  const b = (r.costBasis ?? []).find((x) => x.provider === p.provider);
  return b ?? { reportedMicros: p.actualMicros, computedMicros: 0, computedCount: 0, syntheticMicros: 0, syntheticCount: 0 };
}

function spendClaims(env: BuildEnv, r: SpendReportT, idPrefix: string, scope: string, retrievedAt: string[]): Claim[] {
  const { ctx } = env;
  const claims: Claim[] = [];
  const demo = r.synthetic === true;
  for (const p of r.providers) {
    const unknownTxt = p.unknownCount > 0 ? `; ${p.unknownCount} charge(s) of UNKNOWN amount (kept reserved at their estimate, never counted as $0)` : '; unknown charges: none';
    const weekly = p.weekly ? `; weekly ${formatUsd(p.weekly.committedMicros)} of ${formatUsd(p.weekly.limitMicros)}` : '';
    const b = spendBasisOf(r, p);
    // Spec 25: an amount computed from usage at list price is never presented as a provider charge.
    const split = `provider-reported ${formatUsd(b.reportedMicros)} + computed from usage ${formatUsd(b.computedMicros)}${b.computedCount ? ` (${b.computedCount} request(s) at list price, not provider-reported)` : ''}`;
    const syn = b.syntheticCount > 0 ? ` [SYNTHETIC: ${demo ? 'demo site, ' : ''}${formatUsd(b.syntheticMicros)} of the committed amount from ${b.syntheticCount} fixture/sandbox/demo reservation(s); no real charges]` : '';
    claims.push(
      observed(`${idPrefix}${p.provider}`, `${p.provider}: actual ${formatUsd(p.actualMicros)} (${split}), reserved ${formatUsd(p.reservedMicros)}, estimated-only ${formatUsd(p.estimatedMicros)}${unknownTxt}; remaining ${formatUsd(p.remainingMicros)} of ${formatUsd(p.limitMicros)} ${scope}${weekly}.${syn}`, {
        sourceIds: [`budget_reservations:${p.provider}:${r.periodMonth}`],
        retrievedAt,
        metricIds: ['spend.actual', 'spend.computed', 'spend.reserved', 'spend.estimated', 'spend.unknown', 'spend.remaining'],
        evidence: [dbQueryLink('budget_reservations', { site_id: ctx.siteId, provider: p.provider, period_month: r.periodMonth })],
        ...(b.syntheticCount > 0 ? { synthetic: true } : {}),
      }),
    );
  }
  const anySynthetic = r.providers.some((p) => spendBasisOf(r, p).syntheticCount > 0);
  claims.push(
    observed(
      `${idPrefix}combined`,
      `Combined variable API spend committed: ${formatUsd(r.combined.committedMicros)} of ${formatUsd(r.combined.limitMicros)} (remaining ${formatUsd(r.combined.remainingMicros)}), month ${r.periodMonth} (${r.timeZone}).${anySynthetic ? ` [SYNTHETIC: ${demo ? 'demo site: every amount is synthetic' : 'includes fixture/sandbox reservations'}; no real charges for those amounts]` : ''}`,
      {
        sourceIds: [`budget_reservations:*:${r.periodMonth}`],
        retrievedAt,
        metricIds: ['spend.remaining'],
        evidence: [dbQueryLink('budget_reservations', { site_id: ctx.siteId, period_month: r.periodMonth })],
        ...(anySynthetic ? { synthetic: true } : {}),
      },
    ),
  );
  return claims;
}

function spendTable(id: string, r: SpendReportT, title: string): ReportTable {
  return {
    id,
    title,
    columns: ['Provider', 'Provider-reported', 'Computed (usage x list price)', 'Reserved', 'Estimated-only', 'Unknown charges', 'Synthetic', 'Committed', 'Monthly limit', 'Remaining', 'Weekly'],
    rows: r.providers.map((p) => {
      const b = spendBasisOf(r, p);
      return [
        p.provider,
        formatUsd(b.reportedMicros),
        formatUsd(b.computedMicros),
        formatUsd(p.reservedMicros),
        formatUsd(p.estimatedMicros),
        p.unknownCount > 0 ? `${p.unknownCount} (amount unknown)` : 'none',
        b.syntheticCount > 0 ? `SYNTHETIC ${formatUsd(b.syntheticMicros)} (${b.syntheticCount} reservation(s); no real charge)` : 'none',
        formatUsd(p.committedMicros),
        formatUsd(p.limitMicros),
        formatUsd(p.remainingMicros),
        p.weekly ? `${formatUsd(p.weekly.committedMicros)} of ${formatUsd(p.weekly.limitMicros)}` : '',
      ];
    }),
    note: 'Actual spend = provider-reported + computed. Computed amounts are computed from usage at list price because the provider reported no charge; they count toward the limits, and the provider\'s bill may differ.',
  };
}

/**
 * Spend. Weekly and baseline reports show the budget month in progress at
 * generation time (month to date). A monthly report shows the REVIEWED month
 * (the budget month containing the period end, in the budget time zone), and
 * the current month's remaining budget as a separate, labeled line.
 */
export function spendSection(env: BuildEnv): ReportSection {
  const { ctx } = env;
  const asOf = [env.generatedAt];
  const current = ctx.budgets.report(ctx.siteId, new Date(env.generatedAt));
  const reviewed = env.kind === 'monthly' ? ctx.budgets.report(ctx.siteId, instantOnLocalDate(env.period.end, current.timeZone)) : current;
  const separateCurrent = reviewed.periodMonth !== current.periodMonth;
  env.data.spend = reviewed;
  if (separateCurrent) env.data.spendCurrentMonth = current;
  const unk = unknownCostCounts(ctx.db, ctx.siteId, reviewed.periodMonth);
  const unkCurrent = separateCurrent ? unknownCostCounts(ctx.db, ctx.siteId, current.periodMonth) : null;
  env.data.unknownCostEntries = unk.ledgerUnknown + unk.llmUnknown + (unkCurrent ? unkCurrent.ledgerUnknown + unkCurrent.llmUnknown : 0);
  const scope = env.kind === 'monthly' ? `for ${reviewed.periodMonth} (the reviewed month)` : `this month (${reviewed.periodMonth}, month to date)`;
  const claims: Claim[] = spendClaims(env, reviewed, 'spend.', scope, asOf);
  if (separateCurrent) {
    claims.push(
      observed('spend.current_month', `Current budget month ${current.periodMonth} (${current.timeZone}), month to date at generation, NOT the reviewed month: committed ${formatUsd(current.combined.committedMicros)} of ${formatUsd(current.combined.limitMicros)}; remaining ${formatUsd(current.combined.remainingMicros)}. Per provider remaining: ${current.providers.map((p) => `${p.provider} ${formatUsd(p.remainingMicros)} of ${formatUsd(p.limitMicros)}${p.unknownCount ? ` (${p.unknownCount} unknown)` : ''}`).join('; ')}.`, {
        sourceIds: [`budget_reservations:*:${current.periodMonth}`],
        retrievedAt: asOf,
        metricIds: ['spend.remaining'],
        evidence: [dbQueryLink('budget_reservations', { site_id: ctx.siteId, period_month: current.periodMonth })],
      }),
    );
  }
  const ledgerUnknown = unk.ledgerUnknown + (unkCurrent?.ledgerUnknown ?? 0);
  const llmUnknown = unk.llmUnknown + (unkCurrent?.llmUnknown ?? 0);
  const months = separateCurrent ? `${reviewed.periodMonth} and ${current.periodMonth}` : reviewed.periodMonth;
  const unknownTotal = ledgerUnknown + llmUnknown + unk.ambiguousRequests;
  claims.push(
    unknownTotal > 0
      ? observed('spend.unknown', `Unknown costs: ${ledgerUnknown} ledger entr(ies) and ${llmUnknown} LLM call(s) with unknown cost (${months}; synthetic fixture calls excluded); ${unk.ambiguousRequests} ambiguous provider request(s) awaiting reconciliation. Unknown is not $0.`, {
          sourceIds: ['cost_ledger:unknown', 'llm_calls:unknown', 'provider_requests:ambiguous'],
          retrievedAt: asOf,
          metricIds: ['spend.unknown'],
          evidence: [dbQueryLink('cost_ledger', { site_id: ctx.siteId, period_month: months, amount_status: 'unknown' }), dbQueryLink('provider_requests', { site_id: ctx.siteId, status: 'ambiguous', is_synthetic: 0 })],
        })
      : observed('spend.unknown', `No charges of unknown amount and no ambiguous provider requests are recorded (${months}).`, {
          sourceIds: ['cost_ledger:unknown', 'provider_requests:ambiguous'],
          retrievedAt: asOf,
          metricIds: ['spend.unknown'],
          evidence: [dbQueryLink('cost_ledger', { site_id: ctx.siteId, period_month: months, amount_status: 'unknown' })],
        }),
  );
  const tables = [spendTable('spend', reviewed, env.kind === 'monthly' ? `Spend, reviewed month ${reviewed.periodMonth} (${reviewed.timeZone})` : `Spend, month ${reviewed.periodMonth} (${reviewed.timeZone}), month to date`)];
  if (separateCurrent) tables.push(spendTable('spend.current_month', current, `Current budget month ${current.periodMonth} (${current.timeZone}), month to date (not the reviewed month)`));
  const notes = [...reviewed.notes];
  if (env.kind === 'monthly' && env.period.timeZone !== reviewed.timeZone) notes.push(`Budget months follow ${reviewed.timeZone}; the report period follows ${env.period.timeZone}, so month boundaries can differ by a few hours.`);
  return section('spend', 'Spend and remaining budgets', { claims, tables, notes });
}

// ---------------------------------------------------------------------------
// Next action for the owner
// ---------------------------------------------------------------------------

export function nextActionSection(env: BuildEnv): ReportSection {
  const { ctx } = env;
  const pend = pendingApprovals(ctx.db, ctx.siteId, env.generatedAt, 5);
  env.data.pendingApprovals = pend.total;
  const access = env.data.accessIssues ?? [];
  const google = access.find((a) => a.integration.startsWith('google'));
  const pa = env.data.primaryAction;
  const spend = env.data.spend;
  const spendCurrent = env.data.spendCurrentMonth;
  const unknown = (spend?.providers.reduce((a, p) => a + p.unknownCount, 0) ?? 0) + (spendCurrent?.providers.reduce((a, p) => a + p.unknownCount, 0) ?? 0) + (env.data.unknownCostEntries ?? 0);
  let next: NextActionSummary;
  const noPrimaryEvent = ctx.config.conversions.primaryEvents.length === 0;
  const go = env.data.googleOrganic;
  // An unverified rate SCALE is not a broken key event: it is reported as a data-quality warning, not "repair measurement".
  const rateUnavailable = go?.status === 'observed' && go.value.primarySessionRate.status !== 'observed' && !go.value.primarySessionRateUnverified;
  const rateScaleUnverified = !!go && (go.status === 'observed' || go.status === 'incomplete') && !!(go.status === 'observed' ? go.value : go.partialValue)?.primarySessionRateUnverified;
  const drafts = draftsAwaitingOwner(ctx.db, ctx.siteId);
  if (google) next = { code: 'fix_access', text: `Fix Google access first: ${google.integration} is ${google.state}. ${google.nextStep ?? 'Run `auth status` and `doctor`.'}`, command: 'npm run cli -- doctor' };
  else if (noPrimaryEvent) next = { code: 'configure_primary_event', text: 'Configure the primary conversion event (conversions.primaryEvents) and verify it with the manual test checklist before optimizing.', command: 'npm run cli -- setup' };
  else if (rateUnavailable) next = { code: 'repair_measurement', text: 'Repair measurement: the primary-event session conversion rate is unavailable. Confirm the event is a GA4 key event, then re-sync GA4.', command: 'npm run cli -- sync ga4' };
  else if (rateScaleUnverified) {
    next = {
      code: 'confirm_rate_scale',
      text: 'Confirm the GA4 key-event rate scale: GA4 reports the primary-event session rate, but whether it is 0-1 or 0-100 is not established, so conversions are not assessed. Compare one stored value with the GA4 interface, then record the scale (fraction or percent) with your evidence; stored rates, older days included, become usable.',
      command: CONFIRM_RATE_SCALE_COMMAND,
    };
  }
  else if (pend.total > 0) next = { code: 'review_approvals', text: `Review ${pend.total} pending approval(s).`, command: 'npm run cli -- approvals list' };
  else if (pa && pa.kind === 'primary' && pa.status === 'proposed') next = { code: 'review_recommendation', text: `Review the proposed action "${pa.title}" and approve or reject it.`, command: 'npm run cli -- approvals list' };
  else if (pa && pa.kind === 'repair_measurement' && /rate scale unverified/i.test(`${pa.title} ${pa.diagnosis ?? ''}`)) {
    // A recommendation written before the scale could be confirmed: the fix is the confirmation, not a measurement repair.
    next = { code: 'confirm_rate_scale', text: `Confirm the GA4 key-event rate scale (${pa.title}): compare one stored value with the GA4 interface, then record fraction or percent with your evidence.`, command: CONFIRM_RATE_SCALE_COMMAND };
  } else if (pa && pa.kind === 'repair_measurement') next = { code: 'repair_measurement', text: `Repair measurement: ${pa.title}.`, command: null };
  else if (unknown > 0) next = { code: 'reconcile_costs', text: `Reconcile ${unknown} charge(s) of unknown amount.`, command: 'npm run cli -- costs --unresolved' };
  else if (drafts.total > 0) {
    const first = drafts.rows[0]!;
    const parts = [drafts.needsReview ? `${drafts.needsReview} awaiting human review` : '', drafts.unresolvedFacts ? `${drafts.unresolvedFacts} with unresolved facts` : ''].filter(Boolean).join(', ');
    next = {
      code: 'review_drafts',
      text: `Review ${drafts.total} content draft(s) waiting on the owner (${parts}), starting with "${first.title}" (draft ${first.id}). Resolve the open facts, re-run the checks with \`content review ${first.id}\`, then accept the exact body with \`content mark-reviewed ${first.id} --as <name> --confirm <body-hash-prefix>\`. Publication still needs an approval.`,
      command: `npm run cli -- content review ${first.id}`,
    };
  } else if (env.kind === 'baseline') next = { code: 'review_baseline', text: 'Review this baseline and its cost plan, then run the first weekly analysis manually before enabling scheduling.', command: 'npm run cli -- weekly' };
  else next = { code: 'wait', text: 'No owner action is required now. Keep observing; the next scheduled report will re-check the data.', command: null };
  env.data.nextAction = next;
  const sources = [
    google ? `integration_status:${google.integration}` : null,
    pa?.recommendationId ? `recommendations:${pa.recommendationId}` : null,
    pend.total ? 'approvals:pending' : null,
    ...(next.code === 'review_drafts' ? drafts.rows.map((d) => `content_drafts:${d.id}`) : []),
  ].filter((x): x is string => !!x);
  return section('next_action', 'Next action for the owner', {
    claims: [
      recommendation('next.action', `${next.text}${next.command ? ` Command: \`${next.command}\`` : ''}`, {
        sourceIds: sources.length ? sources : ['report:derived'],
        evidence: [reportSectionLink('data_quality', 'access and data-quality checks'), reportSectionLink('primary_action', 'prioritized action'), ...(next.code === 'review_drafts' ? [reportSectionLink('content', 'content pipeline and draft review status')] : [])],
      }),
    ],
    tables: pend.rows.length
      ? [{ id: 'approvals.pending', title: 'Pending approvals', columns: ['ID', 'Action', 'Target', 'Summary', 'Expires'], rows: pend.rows.map((a) => [a.id, a.action_type, a.target, a.summary, a.expires_at]), totalRows: pend.total }]
      : [],
  });
}
