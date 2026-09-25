import { parseJson } from '../database/db.js';
import { dateInZone } from '../core/time.js';
import type { Measured } from '../core/measured.js';
import type { BuildEnv } from './env.js';
import { batchSourceIds, docLink, markSynthetic, pipelineStage } from './env.js';
import { claim, dbQueryLink, inferred, observed, recordLink, section, unavailable, type Claim, type Ga4ChannelTotals, type ReportSection, type ReportTable } from './model.js';
import { ctr, fmtInt, fmtPct, fmtSignedPct, pctChange, weightedPositionFromSums } from './metrics.js';
import { concludedExperiments, ga4ChannelAggregate, gscPageMetrics, looseIsoBounds } from './queries.js';
import { aiCitationSummary, listAiCitationChecks } from '../aeo/summary.js';
import { rateScaleAssertionCaveat } from './sections-common.js';

/**
 * Monthly-only sections: organic + conversion review, concluded experiments,
 * published-content cohorts, competitor changes, optional AI visibility, API
 * usage, proposed learnings, and attribution assumptions kept separate from
 * observed results.
 */

function inPeriod(env: BuildEnv, iso: string): boolean {
  const d = dateInZone(new Date(iso), env.period.timeZone);
  return d >= env.period.start && d <= env.period.end;
}

function observedValue<T>(m: Measured<T> | null | undefined): T | null {
  return m && m.status === 'observed' ? m.value : null;
}

export function organicConversionReviewSection(env: BuildEnv): ReportSection {
  const claims: Claim[] = [];
  const cmp = env.period.comparison;
  const rows: ReportTable['rows'] = [];
  const views: Array<['google_organic' | 'all_organic', Measured<Ga4ChannelTotals> | undefined, Measured<Ga4ChannelTotals> | null | undefined]> = [
    ['google_organic', env.data.googleOrganic, env.data.googleOrganicPrevious],
    ['all_organic', env.data.allOrganic, env.data.allOrganicPrevious],
  ];
  for (const [view, curM, prevM] of views) {
    const c = observedValue(curM);
    const p = observedValue(prevM ?? null);
    const name = view === 'google_organic' ? 'Google organic' : 'All organic';
    if (!c) {
      claims.push(unavailable(`review.${view}`, `${name} month-over-month review is unavailable.`, curM && curM.status !== 'observed' ? curM.reason : 'no complete GA4 data for the month', { metricIds: [`ga4.sessions.${view}`] }));
      continue;
    }
    const cRate = c.primarySessionRate.status === 'observed' ? c.primarySessionRate.value : null;
    const pRate = p && p.primarySessionRate.status === 'observed' ? p.primarySessionRate.value : null;
    const cOcc = c.primaryEventOccurrences.status === 'observed' ? c.primaryEventOccurrences.value : null;
    const pOcc = p && p.primaryEventOccurrences.status === 'observed' ? p.primaryEventOccurrences.value : null;
    // An unverified rate scale is never shown as a percentage (see ga4TotalsFor).
    const rateCell = (t: Ga4ChannelTotals, r: number | null) => (r !== null ? fmtPct(r) : t.primarySessionRateUnverified ? `raw ${t.primarySessionRateUnverified.raw} (scale unverified)` : 'unavailable');
    rows.push([name, `${c.start} to ${c.end}`, c.sessions, cOcc, rateCell(c, cRate)]);
    if (p) rows.push([name, `${p.start} to ${p.end}`, p.sessions, pOcc, rateCell(p, pRate)]);
    const link = dbQueryLink('ga4_landing_daily_current', { site_id: env.ctx.siteId, property_id: c.propertyId, channel_view: view, segment_key: "''", date: `${c.start}..${c.end}` });
    if (!p || !cmp) {
      claims.push(observed(`review.${view}.sessions`, `${name}: ${fmtInt(c.sessions)} sessions this month; no complete comparison month is available.`, { sourceIds: batchSourceIds(c.batchIds), retrievedAt: c.collectedAt, metricIds: [`ga4.sessions.${view}`], evidence: [link] }));
      continue;
    }
    const plink = dbQueryLink('ga4_landing_daily_current', { site_id: env.ctx.siteId, property_id: p.propertyId, channel_view: view, segment_key: "''", date: `${p.start}..${p.end}` });
    const parts = [`sessions ${fmtInt(c.sessions)} vs ${fmtInt(p.sessions)} (${fmtSignedPct(pctChange(c.sessions, p.sessions))})`];
    if (cOcc !== null && pOcc !== null) parts.push(`primary event occurrences ${fmtInt(cOcc)} vs ${fmtInt(pOcc)}`);
    const rates = cRate !== null && pRate !== null;
    if (rates) parts.push(`primary-event session rate ${fmtPct(cRate)} vs ${fmtPct(pRate)}`);
    else parts.push('primary-event session rate not comparable (unavailable in at least one month)');
    // Rates read on a scale that rests on an owner assertion say so (D3-03).
    const assertion = rates ? (c.rateScaleAssertion ?? null) : null;
    claims.push(
      observed(`review.${view}.change`, `${name}, ${env.period.label} vs ${cmp.label}: ${parts.join('; ')}.${rateScaleAssertionCaveat(assertion)}`, {
        sourceIds: [...batchSourceIds(c.batchIds), ...batchSourceIds(p.batchIds), ...(assertion ? [`ga4_rate_scale_confirmations:${assertion.confirmationId}`] : [])],
        retrievedAt: [...c.collectedAt, ...p.collectedAt],
        metricIds: [`ga4.sessions.${view}`, 'ga4.primary_event.occurrences', 'ga4.primary_event.session_rate'],
        evidence: [link, plink, ...(assertion ? [recordLink('ga4_rate_scale_confirmations', assertion.confirmationId, `rate scale owner assertion ${assertion.confirmationId}`, false)] : [])],
      }),
    );
  }
  const g = env.data.gsc;
  const gc = observedValue(g?.current);
  const gp = observedValue(g?.previous ?? null);
  if (gc && gp) {
    claims.push(
      observed('review.gsc.change', `Search Console clicks ${fmtInt(gc.clicks)} vs ${fmtInt(gp.clicks)} (${fmtSignedPct(pctChange(gc.clicks, gp.clicks))}); impressions ${fmtInt(gc.impressions)} vs ${fmtInt(gp.impressions)} (${fmtSignedPct(pctChange(gc.impressions, gp.impressions))}).`, {
        sourceIds: [...batchSourceIds(gc.batchIds), ...batchSourceIds(gp.batchIds)],
        retrievedAt: [...gc.collectedAt, ...gp.collectedAt],
        metricIds: ['gsc.clicks', 'gsc.impressions'],
        evidence: [dbQueryLink('gsc_property_daily_current', { site_id: env.ctx.siteId, property: gc.property, date: `${gc.start}..${gc.end}` }), dbQueryLink('gsc_property_daily_current', { site_id: env.ctx.siteId, property: gp.property, date: `${gp.start}..${gp.end}` })],
      }),
    );
  }
  return section('organic_conversion_review', 'Organic and conversion performance review (observed)', {
    claims,
    notes: ['Observed results only. Attribution assumptions are listed separately below.'],
    tables: rows.length ? [{ id: 'review.ga4', title: 'Monthly organic and conversion summary', columns: ['View', 'Period', 'Sessions', 'Primary event occurrences', 'Primary-event session rate'], rows }] : [],
  });
}

export function attributionSection(env: BuildEnv): ReportSection {
  const { ctx, period } = env;
  const b = looseIsoBounds(period.start, period.end);
  const ann = ctx.db
    .all<{ id: string; kind: string; scope: string; occurred_at: string; description: string }>(
      `SELECT id, kind, scope, occurred_at, description FROM change_annotations WHERE site_id = ? AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at`,
      [ctx.siteId, b.from, b.to],
    )
    .filter((a) => inPeriod(env, a.occurred_at));
  const doc = docLink('docs/integration-contracts.md#3-google-analytics-4-data-api-v1beta-read-only', 'GA4 attribution scopes (verified contract)');
  const claims: Claim[] = [
    inferred('attr.session_scope', 'Organic sessions use session-scoped source/medium and channel group (paid-and-organic last click); the property attribution-model setting does not change them. Event-scoped attribution is not mixed with session acquisition dimensions.', {
      sourceIds: ['docs:integration-contracts#ga4'],
      evidence: [doc],
    }),
    claim('HYPOTHESIS', 'attr.keyword', 'Query-level business impact is a hypothesis: conversions are observed per landing page, and joining a page with its queries does not show that a specific keyword produced a conversion.', { sourceIds: ['docs:spec#13'] }),
    claim('HYPOTHESIS', 'attr.causality', 'Month-over-month changes are observational. Seasonality, demand shifts, algorithm updates, tracking changes, and site changes can all contribute; these numbers do not show that any single change caused them.', { sourceIds: ['docs:spec#23'] }),
    unavailable('attr.assisted', 'Assisted conversions are not reported.', 'the available GA4 views do not measure assisted journeys; none are inferred'),
    observed('attr.annotations', ann.length ? `${ann.length} change annotation(s) recorded this month (${ann.slice(0, 5).map((a) => `${a.occurred_at.slice(0, 10)} ${a.kind}`).join(', ')}); they may confound comparisons.` : 'No change annotations were recorded this month.', {
      sourceIds: ann.length ? ann.map((a) => `change_annotations:${a.id}`) : ['change_annotations:none'],
      retrievedAt: [env.generatedAt],
      evidence: [dbQueryLink('change_annotations', { site_id: ctx.siteId, occurred_at: `${period.start}..${period.end}` })],
    }),
  ];
  return section('attribution_assumptions', 'Attribution assumptions (kept separate from observed results)', { claims });
}

export function experimentsReviewSection(env: BuildEnv): ReportSection {
  const b = looseIsoBounds(env.period.start, env.period.end);
  const rows = concludedExperiments(env.ctx.db, env.ctx.siteId, b.from, b.to).filter((e) => inPeriod(env, e.concluded_at));
  const claims: Claim[] = [
    observed('experiments_review.count', rows.length ? `${rows.length} experiment(s) concluded this month: ${rows.map((r) => `${r.id} ${r.status}`).join(', ')}.` : 'No experiments concluded this month.', {
      sourceIds: rows.length ? rows.map((r) => `experiments:${r.id}`) : ['experiment_status_history:none'],
      retrievedAt: [env.generatedAt],
      evidence: [dbQueryLink('experiment_status_history', { site_id: env.ctx.siteId, to_status: 'positive|negative|inconclusive|cancelled', at: `${env.period.start}..${env.period.end}` })],
    }),
  ];
  for (const r of rows) {
    const outcome = parseJson<Record<string, unknown>>(r.outcome_json, {});
    const summary = typeof outcome.summary === 'string' ? outcome.summary : null;
    const kind = r.outcome_kind === 'both' ? 'SEO visibility and conversion' : r.outcome_kind === 'conversion' ? 'conversion' : 'SEO visibility';
    claims.push(
      observed(`experiments_review.${r.id}`, `Experiment ${r.id} (${r.type}, ${r.page_url ?? 'no page'}) concluded ${r.status} on ${r.concluded_at.slice(0, 10)} for ${kind} outcomes${summary ? `: ${summary}` : ''}. Observational before/after evidence, not proof of causality.`, {
        sourceIds: [`experiments:${r.id}`],
        retrievedAt: [r.concluded_at],
        metricIds: ['experiments.enough_evidence'],
        evidence: [recordLink('experiments', r.id), dbQueryLink('experiment_measurements', { experiment_id: r.id })],
        links: [{ kind: 'experiment', id: r.id, label: `Experiment ${r.id}` }],
      }),
    );
  }
  return section('experiments_review', 'Experiments concluded this month', { claims, notes: ['Inconclusive results are recorded as inconclusive; experiments are not re-run until a favorable result appears.'] });
}

export function contentCohortsSection(env: BuildEnv): ReportSection {
  const { ctx, period } = env;
  const pubs = ctx.db.all<{ id: string; url: string; page_id: string | null; implemented_at: string }>(
    `SELECT id, url, page_id, implemented_at FROM publications WHERE site_id = ? AND subject_type = 'draft' AND implemented_at <= ? ORDER BY implemented_at LIMIT 500`,
    [ctx.siteId, `${period.end}T23:59:59.999Z`],
  );
  const cohorts = new Map<string, typeof pubs>();
  for (const p of pubs) {
    const m = dateInZone(new Date(p.implemented_at), period.timeZone).slice(0, 7);
    const arr = cohorts.get(m) ?? [];
    arr.push(p);
    cohorts.set(m, arr);
  }
  const claims: Claim[] = [];
  const rows: ReportTable['rows'] = [];
  const g = env.gsc;
  const keys = [...cohorts.keys()].sort().slice(-12);
  for (const month of keys) {
    const list = cohorts.get(month)!;
    const pages = [...new Map(list.map((p) => [p.page_id ?? p.url, p])).values()];
    let clicks = 0;
    let impressions = 0;
    let pw = 0;
    let pi = 0;
    let sessions = 0;
    let withGsc = 0;
    let withGa4 = 0;
    const batches = new Set<string>();
    const collected = new Set<string>();
    for (const p of pages) {
      if (g.property) {
        const m = gscPageMetrics(ctx.db, ctx.siteId, { pageId: p.page_id, pageUrl: p.url, property: g.property, searchType: g.searchType, start: period.start, end: period.end });
        if (m) {
          withGsc++;
          clicks += m.clicks;
          impressions += m.impressions;
          pw += m.pos_weighted ?? 0;
          pi += m.pos_impressions ?? 0;
          m.batchIds.forEach((x) => batches.add(x));
          m.collectedAt.forEach((x) => collected.add(x));
          markSynthetic(env, 'gsc_page_daily', m.syn);
        }
      }
      if (env.ga4.propertyId && p.page_id) {
        const r = ga4ChannelAggregate(ctx.db, ctx.siteId, env.ga4.propertyId, 'google_organic', period.start, period.end, p.page_id);
        if (r.agg) {
          withGa4++;
          sessions += Number(r.agg.sessions ?? 0);
          r.batchIds.forEach((x) => batches.add(x));
          r.collectedAt.forEach((x) => collected.add(x));
          markSynthetic(env, 'ga4_landing_daily', r.agg.syn);
        }
      }
    }
    rows.push([month, pages.length, withGsc ? clicks : null, withGsc ? impressions : null, withGsc ? fmtPct(ctr(clicks, impressions)) : 'n/a', withGsc ? (weightedPositionFromSums(pw, pi)?.toFixed(1) ?? 'n/a') : 'n/a', withGa4 ? sessions : null]);
    claims.push(
      withGsc || withGa4
        ? observed(`cohort.${month}`, `Pages published in ${month} (${pages.length}): ${withGsc ? `${fmtInt(clicks)} clicks and ${fmtInt(impressions)} impressions (byPage) for ${withGsc} page(s)` : 'no Search Console page data'}; ${withGa4 ? `${fmtInt(sessions)} Google organic sessions for ${withGa4} page(s)` : 'no GA4 landing data'} in ${period.label}.`, {
            sourceIds: [...pages.map((p) => `publications:${p.id}`), ...batchSourceIds([...batches])],
            retrievedAt: [...collected],
            metricIds: ['content.cohort'],
            evidence: [dbQueryLink('publications', { site_id: ctx.siteId, implemented_month: month }), dbQueryLink('gsc_page_daily_current', { site_id: ctx.siteId, date: `${period.start}..${period.end}` })],
          })
        : unavailable(`cohort.${month}`, `Pages published in ${month} (${pages.length}): no performance data in ${period.label}.`, 'no Search Console page rows or GA4 landing rows matched these pages yet', { metricIds: ['content.cohort'] }),
    );
  }
  if (keys.length === 0) {
    claims.push(observed('cohort.none', 'No published content is recorded yet, so there are no content cohorts.', { sourceIds: ['publications:none'], retrievedAt: [env.generatedAt], evidence: [dbQueryLink('publications', { site_id: ctx.siteId, subject_type: 'draft' })] }));
  }
  return section('content_cohorts', 'Published-content cohorts', {
    claims,
    notes: ['Cohorts use the actual recorded implementation date. Recently published pages have short exposure; compare cohorts with care.'],
    tables: rows.length ? [{ id: 'cohorts', title: 'Cohort performance in the report period', columns: ['Published month', 'Pages', 'Clicks', 'Impressions', 'CTR', 'Avg position', 'Google organic sessions'], rows }] : [],
  });
}

/**
 * Competitor changes. "No changes" is an OBSERVED claim only when a competitor
 * check actually ran: a competitor crawl in the period, a tracked competitor
 * page re-checked in the period, or this report's own competitor_changes
 * stage succeeding. When the stage was skipped (ANALYZE mode), failed, or no
 * check ran, the absence of change rows is missing data, never "none".
 */
export function competitorChangesSection(env: BuildEnv): ReportSection {
  const { ctx, period } = env;
  const stage = pipelineStage(env, 'competitor_changes');
  const stageRan = stage !== null && (stage.status === 'succeeded' || stage.status === 'degraded');
  const b = looseIsoBounds(period.start, period.end);
  // Changes detected by this report's own re-check run after the period end; they belong to this review.
  const until = stageRan ? env.generatedAt : null;
  const rows = ctx.db
    .all<{ id: string; change_type: string; summary: string | null; detected_at: string; url: string; domain: string }>(
      `SELECT cc.id, cc.change_type, cc.summary, cc.detected_at, cp.url, c.domain
       FROM competitor_changes cc
       JOIN competitor_pages cp ON cp.id = cc.competitor_page_id AND cp.site_id = cc.site_id
       JOIN competitors c ON c.id = cp.competitor_id AND c.site_id = cc.site_id
       WHERE cc.site_id = ? AND cc.detected_at >= ? AND cc.detected_at < ?
       ORDER BY cc.detected_at DESC`,
      [ctx.siteId, b.from, until && until > b.to ? until : b.to],
    )
    .filter((r) => inPeriod(env, r.detected_at) || (until !== null && dateInZone(new Date(r.detected_at), period.timeZone) > period.end && r.detected_at <= until));
  const checks = competitorChecksInPeriod(env);
  for (const c of checks.crawls) markSynthetic(env, 'crawls', c.is_synthetic);
  const byType = new Map<string, number>();
  for (const r of rows) byType.set(r.change_type, (byType.get(r.change_type) ?? 0) + 1);
  const top = rows.slice(0, env.topN);
  const notes = ['Summaries derive from crawled competitor pages (untrusted data, shown as text only). A competitor change does not by itself explain our ranking changes.'];
  const evidence = [dbQueryLink('competitor_changes', { site_id: ctx.siteId, detected_at: `${period.start}..${until ? until.slice(0, 10) : period.end}` })];
  const crawlSources = checks.crawls.map((c) => `crawls:${c.id}`);
  const crawlEvidence = checks.crawls.slice(0, 3).map((c) => recordLink('crawls', c.id, `competitor crawl ${c.id} (${c.status})`));
  const stageLabel = stage ? `the competitor_changes stage ${stage.status}${stage.code ? ` (${stage.code})` : ''}: ${stage.detail}` : null;
  let claimOut: Claim;
  if (rows.length) {
    claimOut = observed('competitors.changes', `${rows.length} competitor page change(s) detected this month${until ? ' or by this report\'s re-check' : ''} (${[...byType.entries()].map(([t, n]) => `${t} ${n}`).join(', ')}).`, {
      sourceIds: top.map((r) => `competitor_changes:${r.id}`),
      retrievedAt: [rows[0]!.detected_at],
      evidence,
    });
    if (stage && !stageRan) notes.push(`This report's competitor re-check did not run (${stageLabel}); only changes recorded by earlier checks in the period are shown, so the list may be incomplete.`);
  } else if (stage && !stageRan && checks.total === 0) {
    claimOut = unavailable('competitors.changes', 'Competitor changes this month: DATA UNAVAILABLE (competitor pages were not re-checked).', `${stageLabel}; no competitor crawl or competitor page check ran in ${period.start} to ${period.end}, so an absence of change records is not evidence of no change`);
  } else if (!stageRan && checks.total === 0) {
    const tracked = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM competitor_pages WHERE site_id = ?', [ctx.siteId])?.n ?? 0;
    claimOut = unavailable(
      'competitors.changes',
      'Competitor changes this month: DATA UNAVAILABLE (no competitor check ran in the period).',
      tracked === 0
        ? 'no competitor pages are tracked yet, and no competitor crawl ran in the period'
        : `none of the ${tracked} tracked competitor page(s) was re-checked in ${period.start} to ${period.end} and no competitor crawl ran, so an absence of change records is not evidence of no change`,
    );
  } else {
    const what = [checks.crawls.length ? `${checks.crawls.length} competitor crawl(s)` : '', checks.pagesChecked ? `${checks.pagesChecked} competitor page re-check(s)` : '', stageRan ? "this report's competitor re-check" : ''].filter(Boolean).join(', ');
    claimOut = observed('competitors.changes', `No competitor page changes were detected this month (${what}).`, {
      sourceIds: ['competitor_changes:none', ...crawlSources, ...(stageRan && env.pipeline?.jobId ? [`jobs:${env.pipeline.jobId}`] : [])],
      retrievedAt: [checks.latestAt ?? env.generatedAt],
      evidence: [...evidence, ...crawlEvidence, dbQueryLink('competitor_pages', { site_id: ctx.siteId, last_checked_at: `${period.start}..${period.end}` })],
    });
    if (stage && !stageRan) notes.push(`This report's competitor re-check did not run (${stageLabel}); the statement rests on the earlier competitor checks in the period listed as sources.`);
  }
  return section('competitor_changes', 'Competitor changes', {
    claims: [claimOut],
    notes,
    tables: top.length
      ? [{ id: 'competitor_changes', title: `Latest ${top.length} of ${rows.length} changes`, columns: ['Domain', 'URL', 'Change', 'Detected', 'Summary'], rows: top.map((r) => [r.domain, r.url, r.change_type, r.detected_at.slice(0, 10), (r.summary ?? '').slice(0, 200)]), totalRows: rows.length }]
      : [],
  });
}

/** Competitor checks that ran in the report period: competitor crawls and competitor pages re-checked (period time zone). */
function competitorChecksInPeriod(env: BuildEnv): { crawls: Array<{ id: string; status: string; started_at: string; is_synthetic: number }>; pagesChecked: number; total: number; latestAt: string | null } {
  const { ctx, period } = env;
  const b = looseIsoBounds(period.start, period.end);
  const crawls = ctx.db
    .all<{ id: string; status: string; started_at: string; is_synthetic: number }>(
      `SELECT id, status, started_at, is_synthetic FROM crawls WHERE site_id = ? AND kind = 'competitor' AND status IN ('completed', 'partial') AND started_at >= ? AND started_at < ? ORDER BY started_at DESC`,
      [ctx.siteId, b.from, b.to],
    )
    .filter((c) => inPeriod(env, c.started_at));
  const pages = ctx.db
    .all<{ last_checked_at: string }>(`SELECT last_checked_at FROM competitor_pages WHERE site_id = ? AND last_checked_at >= ? AND last_checked_at < ?`, [ctx.siteId, b.from, b.to])
    .filter((p) => inPeriod(env, p.last_checked_at));
  const latest = [...crawls.map((c) => c.started_at), ...pages.map((p) => p.last_checked_at)].sort().pop() ?? null;
  return { crawls, pagesChecked: pages.length, total: crawls.length + pages.length, latestAt: latest };
}

/**
 * Optional AI visibility, built from the same summary as `ai-citations
 * summary` (src/aeo/summary.ts) so both say the same thing:
 *
 * - numbers come from grounded observations only; ungrounded model responses
 *   are counted as excluded;
 * - a grounded row without recorded cited URLs has an UNKNOWN own-site
 *   citation: it is shown as "citation unknown in N" and the claim is marked
 *   INCOMPLETE, never folded into "not cited";
 * - "mentioned but not cited" is counted only over rows that record both the
 *   response text and the cited URLs;
 * - clicks and conversions are always DATA_UNAVAILABLE (a citation is not a
 *   click, a click is not a conversion).
 */
export function aiVisibilitySection(env: BuildEnv): ReportSection {
  const { ctx, period } = env;
  const semantics = 'A brand mention is not a citation, a citation is not a click, and a click is not a conversion.';
  const p = { start: period.start, end: period.end, timeZone: period.timeZone };
  const s = aiCitationSummary(ctx, p);
  if (s.status !== 'observed') {
    return section('ai_visibility', 'AI visibility (optional)', {
      claims: [
        unavailable('ai.visibility', 'AI visibility is not reported this month.', s.status === 'disabled' ? 'optional AI-citation monitoring is disabled (features.aiCitations)' : 'no AI-citation checks were recorded this month', { metricIds: ['ai.citations'] }),
      ],
      notes: [semantics, ...s.notes],
    });
  }
  markSynthetic(env, 'ai_citation_checks', s.containsSynthetic);
  const grounded = listAiCitationChecks(ctx, p, { groundedOnly: true }).checks;
  const link = dbQueryLink('ai_citation_checks', { site_id: ctx.siteId, checked_at: `${period.start}..${period.end}`, is_grounded: 1 });
  const sourceIds = grounded.slice(0, 20).map((r) => `ai_citation_checks:${r.id}`);
  const retrievedAt = [...new Set(grounded.map((r) => r.checkedAt))].sort().slice(-3);
  const claims: Claim[] = [];
  const mentions = s.brandMentions.status === 'observed' ? s.brandMentions.value : s.brandMentions.status === 'incomplete' ? s.brandMentions.partialValue : undefined;
  const citations = s.ownSiteCitations.status === 'observed' ? s.ownSiteCitations.value : s.ownSiteCitations.status === 'incomplete' ? s.ownSiteCitations.partialValue : undefined;
  if (s.checks.grounded > 0 && mentions && citations) {
    const engines = s.byEngine.filter((e) => e.grounded > 0).map((e) => e.engine);
    const parts = [`brand mentioned in ${mentions.mentioned}`, `own site cited in ${citations.cited}`, `not cited in ${citations.notCited}`];
    if (mentions.unknown) parts.push(`mention unknown in ${mentions.unknown}`);
    if (citations.unknown) parts.push(`citation unknown in ${citations.unknown}`);
    const gaps: string[] = [];
    if (citations.unknown) gaps.push(`${citations.unknown} grounded check(s) have no recorded cited URLs, so whether they cited the site is unknown (not "not cited")`);
    if (mentions.unknown) gaps.push(`${mentions.unknown} grounded check(s) have no response text, so the brand mention is unknown (not "no")`);
    const incompleteText = gaps.length ? ` INCOMPLETE: ${gaps.join('; ')}. The cited and mentioned counts are lower bounds.` : '';
    claims.push(
      observed('ai.citations', `${s.checks.grounded} grounded AI-search check(s) across ${engines.join(', ')}: ${parts.join(', ')}.${incompleteText}`, {
        sourceIds,
        retrievedAt,
        metricIds: ['ai.citations'],
        evidence: [link],
        ...(gaps.length ? { reason: `incomplete: ${gaps.join('; ')}` } : {}),
        ...(s.containsSynthetic ? { synthetic: true } : {}),
      }),
    );
    // Mentioned-but-not-cited only from rows that record BOTH the response text and the cited URLs.
    const mnc = s.mentionedNotCited.status === 'observed' ? s.mentionedNotCited.value : s.mentionedNotCited.status === 'incomplete' ? s.mentionedNotCited.partialValue : undefined;
    const cnm = s.citedNotMentioned.status === 'observed' ? s.citedNotMentioned.value : s.citedNotMentioned.status === 'incomplete' ? s.citedNotMentioned.partialValue : undefined;
    const excluded = s.checks.grounded - s.mentionCitationKnown;
    if (s.mentionCitationKnown > 0 && mnc !== undefined) {
      claims.push(
        observed(
          'ai.mentioned_not_cited',
          `Mentioned but not cited: ${mnc} of the ${s.mentionCitationKnown} grounded check(s) that record both the response text and the cited URLs${cnm !== undefined ? `; cited but not mentioned: ${cnm}` : ''}.${excluded > 0 ? ` ${excluded} grounded check(s) without response text or cited URLs are left out (unknown, never counted as "not cited").` : ''}`,
          { sourceIds, retrievedAt, metricIds: ['ai.citations'], evidence: [link], ...(s.containsSynthetic ? { synthetic: true } : {}) },
        ),
      );
    } else {
      claims.push(
        unavailable('ai.mentioned_not_cited', '"Mentioned but not cited" is not reported this month.', 'no grounded check records both the response text and the cited URLs, so a mention without a citation cannot be told apart from an unrecorded citation', {
          metricIds: ['ai.citations'],
        }),
      );
    }
  } else {
    claims.push(unavailable('ai.citations', 'No grounded AI-search checks this month.', 'only ungrounded responses were recorded; they are not live search measurements', { metricIds: ['ai.citations'] }));
  }
  if (s.checks.ungroundedExcluded > 0) {
    claims.push(
      observed('ai.ungrounded', `${s.checks.ungroundedExcluded} ungrounded model response(s) were excluded: an ungrounded model response is not a live search measurement.`, {
        sourceIds: ['ai_citation_checks:ungrounded'],
        retrievedAt: [env.generatedAt],
        evidence: [dbQueryLink('ai_citation_checks', { site_id: ctx.siteId, is_grounded: 0 })],
      }),
    );
  }
  claims.push(unavailable('ai.clicks', 'Clicks and conversions from AI answers are not reported.', 'no available data source measures clicks or conversions from AI answers', { metricIds: ['ai.citations'] }));
  const tables: ReportTable[] = s.byEngine.length
    ? [
        {
          id: 'ai_visibility.engines',
          title: 'AI-citation checks by engine (grounded rows only; unknown is not "no")',
          columns: ['Engine', 'Grounded checks', 'Brand mentioned', 'Mention unknown', 'Own site cited', 'Citation unknown', 'Ungrounded (excluded)'],
          rows: s.byEngine.map((e) => [e.engine, e.grounded, e.brandMentioned, e.brandMentionUnknown, e.ownSiteCited, e.ownSiteCitationUnknown, e.ungroundedExcluded]),
        },
      ]
    : [];
  return section('ai_visibility', 'AI visibility (optional)', { claims, tables, notes: [semantics, ...s.notes] });
}

export function apiUsageSection(env: BuildEnv): ReportSection {
  const { ctx, period } = env;
  const asOf = [env.generatedAt];
  const b = looseIsoBounds(period.start, period.end);
  const reqs = ctx.db
    .all<{ id: string; provider: string; status: string; is_paid: number; is_synthetic: number; created_at: string }>(
      `SELECT id, provider, status, is_paid, is_synthetic, created_at FROM provider_requests WHERE site_id = ? AND created_at >= ? AND created_at < ?`,
      [ctx.siteId, b.from, b.to],
    )
    .filter((r) => inPeriod(env, r.created_at));
  const live = reqs.filter((r) => r.is_synthetic === 0);
  const synthetic = reqs.length - live.length;
  const groups = new Map<string, { total: number; paid: number; byStatus: Map<string, number> }>();
  for (const r of live) {
    const g = groups.get(r.provider) ?? { total: 0, paid: 0, byStatus: new Map() };
    g.total++;
    if (r.is_paid === 1) g.paid++;
    g.byStatus.set(r.status, (g.byStatus.get(r.status) ?? 0) + 1);
    groups.set(r.provider, g);
  }
  const llmAll = ctx.db
    .all<{ tier: string; created_at: string; input_tokens: number | null; output_tokens: number | null; cost_status: string; is_synthetic: number }>(
      `SELECT tier, created_at, input_tokens, output_tokens, cost_status, is_synthetic FROM llm_calls WHERE site_id = ? AND created_at >= ? AND created_at < ?`,
      [ctx.siteId, b.from, b.to],
    )
    .filter((r) => inPeriod(env, r.created_at));
  const llm = llmAll.filter((r) => r.is_synthetic === 0);
  const syntheticLlm = llmAll.length - llm.length;
  const sandbox = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM dataforseo_tasks WHERE site_id = ? AND is_sandbox = 1 AND created_at >= ? AND created_at < ?`, [ctx.siteId, b.from, b.to]);
  const claims: Claim[] = [
    observed('api.requests', live.length ? `${live.length} provider request(s) this month (${[...groups.entries()].map(([p, g]) => `${p} ${g.total}${g.paid ? `, ${g.paid} paid` : ''}`).join('; ')}).` : 'No provider requests were recorded this month.', {
      sourceIds: ['provider_requests:period'],
      retrievedAt: asOf,
      evidence: [dbQueryLink('provider_requests', { site_id: ctx.siteId, created_at: `${period.start}..${period.end}`, is_synthetic: 0 })],
    }),
  ];
  if (llm.length) {
    const known = llm.filter((r) => r.input_tokens !== null && r.output_tokens !== null);
    const inTok = known.reduce((a, r) => a + (r.input_tokens ?? 0), 0);
    const outTok = known.reduce((a, r) => a + (r.output_tokens ?? 0), 0);
    const unknownCost = llm.filter((r) => r.cost_status === 'unknown').length;
    claims.push(
      observed('api.llm', `${llm.length} LLM call(s): ${fmtInt(inTok)} input and ${fmtInt(outTok)} output tokens where reported (${llm.length - known.length} call(s) without reported usage); ${unknownCost} call(s) with unknown cost.`, {
        sourceIds: ['llm_calls:period'],
        retrievedAt: asOf,
        evidence: [dbQueryLink('llm_calls', { site_id: ctx.siteId, created_at: `${period.start}..${period.end}`, is_synthetic: 0 })],
      }),
    );
  }
  if (synthetic > 0 || syntheticLlm > 0 || Number(sandbox?.n ?? 0) > 0) {
    claims.push(
      observed('api.excluded', `Excluded from usage: ${synthetic} synthetic/fixture provider request(s), ${syntheticLlm} synthetic/fixture LLM call(s), and ${Number(sandbox?.n ?? 0)} DataForSEO sandbox task(s) (sandbox data is never used in recommendations).`, {
        sourceIds: ['provider_requests:synthetic', 'llm_calls:synthetic', 'dataforseo_tasks:sandbox'],
        retrievedAt: asOf,
        evidence: [dbQueryLink('provider_requests', { site_id: ctx.siteId, is_synthetic: 1 }), dbQueryLink('llm_calls', { site_id: ctx.siteId, is_synthetic: 1 }), dbQueryLink('dataforseo_tasks', { site_id: ctx.siteId, is_sandbox: 1 })],
      }),
    );
  }
  return section('api_usage', 'API usage', {
    claims,
    tables: groups.size
      ? [{ id: 'api.requests', title: 'Provider requests by status', columns: ['Provider', 'Requests', 'Paid', 'Statuses'], rows: [...groups.entries()].map(([p, g]) => [p, g.total, g.paid, [...g.byStatus.entries()].map(([s, n]) => `${s} ${n}`).join(', ')]) }]
      : [],
  });
}

export function learningsSection(env: BuildEnv): ReportSection {
  const { ctx, period } = env;
  const rows = ctx.db.all<{ id: string; statement: string; scope: string; status: string; experiment_id: string | null; created_at: string; approved_at: string | null }>(
    `SELECT id, statement, scope, status, experiment_id, created_at, approved_at FROM learnings
     WHERE site_id = ? AND (status = 'proposed' OR (status = 'approved' AND approved_at >= ?)) ORDER BY created_at DESC LIMIT ?`,
    [ctx.siteId, `${period.start}T00:00:00.000Z`, env.topN],
  );
  const claims: Claim[] = rows.map((r) =>
    r.status === 'proposed'
      ? claim('HYPOTHESIS', `learning.${r.id}`, `Proposed learning (scope: ${r.scope}): ${r.statement} Needs owner review; it is not a universal SEO rule.`, { sourceIds: [`learnings:${r.id}`], evidence: [recordLink('learnings', r.id)] })
      : inferred(`learning.${r.id}`, `Approved learning (scope: ${r.scope}): ${r.statement}`, { sourceIds: [`learnings:${r.id}`, ...(r.experiment_id ? [`experiments:${r.experiment_id}`] : [])], retrievedAt: r.approved_at ? [r.approved_at] : [], evidence: [recordLink('learnings', r.id)] }),
  );
  if (claims.length === 0) claims.push(observed('learning.none', 'No proposed or newly approved learnings.', { sourceIds: ['learnings:none'], retrievedAt: [env.generatedAt], evidence: [dbQueryLink('learnings', { site_id: ctx.siteId, status: 'proposed' })] }));
  return section('learnings', 'Proposed learnings', { claims, notes: ['Learnings require evidence and a scope, and never become universal rules automatically.'] });
}
