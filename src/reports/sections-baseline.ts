import { formatUsd } from '../core/money.js';
import type { CostEstimate } from '../budgets/types.js';
import { findModel, loadCachedCatalog, type ModelCapabilities, type ModelCatalog } from '../integrations/llm/models.js';
import { estimateChatCost, estimateEmbeddingCost, resolvePrices } from '../integrations/llm/pricing.js';
import type { BuildEnv } from './env.js';
import { addDq, configLink, markSynthetic, reportSectionLink } from './env.js';
import { claim, dbQueryLink, inferred, observed, recommendation, recordLink, section, unavailable, type Claim, type ReportSection, type ReportTable } from './model.js';
import { fmtInt, fmtPct, share } from './metrics.js';
import { datasetWindowStats, ga4PropertyMetadata, latestCrawl } from './queries.js';
import { rateScaleAssertionCaveat } from './sections-common.js';

/**
 * Baseline-only sections: what was collected (available history), crawl
 * summary, URL reconciliation, measurement check (primary event
 * availability), memory index status, blockers, and a proposed cost plan for
 * optional LLM/embedding work. The baseline starts no experiments, performs
 * no paid research, and publishes nothing.
 */

const DATASETS: Array<[string, string]> = [
  ['gsc_property_daily', 'Search Console property totals'],
  ['gsc_page_daily', 'Search Console page totals'],
  ['gsc_page_query_daily', 'Search Console page/query detail'],
  ['ga4_landing_daily', 'GA4 landing pages'],
  ['ga4_event_daily', 'GA4 events'],
];

export function collectionSection(env: BuildEnv): ReportSection {
  const { ctx, period } = env;
  const claims: Claim[] = [];
  const rows: ReportTable['rows'] = [];
  for (const [ds, label] of DATASETS) {
    const s = datasetWindowStats(ctx.db, ctx.siteId, ds, period.start, period.end);
    markSynthetic(env, ds, s.synthetic);
    rows.push([label, ds, s.earliest ?? 'none', s.latest ?? 'none', `${s.days} of ${period.days}`, s.rows]);
    const view = `${ds}_current`;
    if (s.rows === 0) {
      claims.push(unavailable(`collection.${ds}`, `${label}: no history collected for ${period.start} to ${period.end}.`, 'no rows ingested for this window'));
    } else {
      claims.push(
        observed(`collection.${ds}`, `${label}: ${s.days} of ${period.days} days available (${s.earliest} to ${s.latest}), ${fmtInt(s.rows)} current rows.`, {
          sourceIds: [`${view}:${period.start}..${period.end}`],
          retrievedAt: s.collectedAt ? [s.collectedAt] : [env.generatedAt],
          evidence: [dbQueryLink(view, { site_id: ctx.siteId, date: `${period.start}..${period.end}` })],
        }),
      );
    }
  }
  const pm = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ga4_period_metrics_current WHERE site_id = ? AND period_start >= ? AND period_end <= ?`, [ctx.siteId, period.start, period.end]);
  rows.push(['GA4 period-level metrics (users, rates)', 'ga4_period_metrics', '', '', '', Number(pm?.n ?? 0)]);
  return section('collection', 'What was collected', {
    claims,
    notes: [`Requested history: up to ${ctx.config.google.gsc.initialHistoryDays} days for Search Console and ${ctx.config.google.ga4.initialHistoryDays} days for GA4. Days without rows may be days without data or days not collected; see freshness and data quality.`],
    tables: [{ id: 'collection', title: 'Available history in the baseline window', columns: ['Dataset', 'Table', 'Earliest', 'Latest', 'Days with rows', 'Rows'], rows }],
  });
}

export function crawlSummarySection(env: BuildEnv): ReportSection {
  const { ctx } = env;
  const c = latestCrawl(ctx.db, ctx.siteId);
  if (!c) {
    addDq(env, { severity: 'warning', code: 'no_crawl', message: 'No own-site crawl is recorded.', source: 'crawl', nextStep: 'Run `crawl`.' });
    return section('crawl_summary', 'Crawl summary', { claims: [unavailable('crawl.latest', 'No own-site crawl is recorded.', 'the bounded own-site crawl has not run (or crawling is disabled)')] });
  }
  markSynthetic(env, 'crawls', c.is_synthetic);
  const buckets = ctx.db.all<{ bucket: string; n: number }>(
    `SELECT CASE WHEN blocked_reason IS NOT NULL THEN 'blocked: ' || blocked_reason
                 WHEN status_code IS NULL THEN 'no response'
                 WHEN status_code < 300 THEN '2xx' WHEN status_code < 400 THEN '3xx' WHEN status_code < 500 THEN '4xx' ELSE '5xx' END AS bucket,
            COUNT(*) AS n
     FROM crawl_results WHERE site_id = ? AND crawl_id = ? GROUP BY bucket ORDER BY n DESC`,
    [ctx.siteId, c.id],
  );
  const issues = ctx.db.all<{ issue_type: string; severity: string; confirmed: number; is_heuristic: number; n: number }>(
    `SELECT issue_type, severity, confirmed, is_heuristic, COUNT(*) AS n FROM technical_issues WHERE site_id = ? AND status = 'open'
     GROUP BY issue_type, severity, confirmed, is_heuristic
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, n DESC LIMIT ?`,
    [ctx.siteId, env.topN],
  );
  const claims: Claim[] = [
    observed('crawl.latest', `Latest own-site crawl ${c.id}: ${c.status}; ${c.pages_fetched} fetched, ${c.pages_blocked} blocked, ${c.pages_failed} failed of ${c.pages_attempted} attempted${c.stop_reason ? ` (stop reason: ${c.stop_reason})` : ''}; started ${c.started_at}.`, {
      sourceIds: [`crawls:${c.id}`],
      retrievedAt: [c.finished_at ?? c.started_at],
      evidence: [recordLink('crawls', c.id), dbQueryLink('crawl_results', { site_id: ctx.siteId, crawl_id: c.id })],
    }),
  ];
  const critical = issues.filter((i) => i.confirmed === 1 && (i.severity === 'critical' || i.severity === 'high'));
  claims.push(
    observed('crawl.issues', issues.length ? `Open technical issues (top ${issues.length} groups): ${issues.map((i) => `${i.issue_type} ${i.severity}${i.confirmed ? ' confirmed' : ' suspected'}${i.is_heuristic ? ' (heuristic)' : ''} x${i.n}`).join('; ')}.` : 'No open technical issues are recorded.', {
      sourceIds: ['technical_issues:open'],
      retrievedAt: [env.generatedAt], // open-issue state as read at report generation
      evidence: [dbQueryLink('technical_issues', { site_id: ctx.siteId, status: 'open' })],
    }),
  );
  if (critical.length) addDq(env, { severity: 'critical', code: 'confirmed_technical_blockers', message: `${critical.reduce((a, i) => a + i.n, 0)} confirmed critical/high technical issue(s) are open.`, source: 'crawl', nextStep: 'Investigate technical blockers before optimization work.' });
  if (c.status === 'failed' || c.status === 'partial') addDq(env, { severity: 'warning', code: 'crawl_incomplete', message: `The latest crawl is ${c.status}.`, source: 'crawl', nextStep: 'Re-run `crawl` and review blocked URLs.' });
  return section('crawl_summary', 'Crawl summary', {
    claims,
    notes: ['Editorial heuristics are not ranking rules; suspected issues need confirmation.'],
    tables: [
      { id: 'crawl.status', title: 'Crawl results by outcome', columns: ['Outcome', 'URLs'], rows: buckets.map((b) => [b.bucket, Number(b.n)]) },
      ...(issues.length ? [{ id: 'crawl.issues', title: 'Open technical issues', columns: ['Issue', 'Severity', 'Confirmed', 'Heuristic', 'Count'], rows: issues.map((i) => [i.issue_type, i.severity, i.confirmed ? 'yes' : 'no', i.is_heuristic ? 'yes' : 'no', Number(i.n)]) }] : []),
    ],
  });
}

export function urlReconciliationSection(env: BuildEnv): ReportSection {
  const { ctx, period } = env;
  const bySource = ctx.db.all<{ first_source: string; n: number }>('SELECT first_source, COUNT(*) AS n FROM pages WHERE site_id = ? GROUP BY first_source ORDER BY n DESC', [ctx.siteId]);
  const aliases = ctx.db.all<{ relation: string; confidence: string; n: number }>('SELECT relation, confidence, COUNT(*) AS n FROM url_aliases WHERE site_id = ? GROUP BY relation, confidence ORDER BY n DESC', [ctx.siteId]);
  const gscUnmatched = ctx.db.get<{ n: number; total: number }>(
    `SELECT COUNT(DISTINCT CASE WHEN page_id IS NULL THEN page END) AS n, COUNT(DISTINCT page) AS total FROM gsc_page_daily_current WHERE site_id = ? AND date BETWEEN ? AND ?`,
    [ctx.siteId, period.start, period.end],
  );
  const ga4Unmatched = ctx.db.get<{ n: number; total: number }>(
    `SELECT COUNT(DISTINCT CASE WHEN page_id IS NULL AND landing_page <> '(not set)' THEN host_name || landing_page END) AS n, COUNT(DISTINCT host_name || landing_page) AS total
     FROM ga4_landing_daily_current WHERE site_id = ? AND date BETWEEN ? AND ?`,
    [ctx.siteId, period.start, period.end],
  );
  const pagesTotal = bySource.reduce((a, r) => a + Number(r.n), 0);
  const aliasTotal = aliases.reduce((a, r) => a + Number(r.n), 0);
  const unverified = aliases.filter((a) => a.confidence === 'unverified').reduce((a, r) => a + Number(r.n), 0);
  const claims: Claim[] = [
    observed('urls.pages', pagesTotal ? `${pagesTotal} page identities (${bySource.map((r) => `${r.first_source} ${r.n}`).join(', ')}); ${aliasTotal} recorded alias(es), ${unverified} unverified.` : 'No page identities are recorded yet.', {
      sourceIds: ['pages:*', 'url_aliases:*'],
      retrievedAt: [env.generatedAt],
      evidence: [dbQueryLink('pages', { site_id: ctx.siteId }), dbQueryLink('url_aliases', { site_id: ctx.siteId })],
    }),
  ];
  if (Number(gscUnmatched?.total ?? 0) > 0) {
    claims.push(
      observed('urls.gsc_unmatched', `${gscUnmatched!.n} of ${gscUnmatched!.total} Search Console page URLs (${fmtPct(share(Number(gscUnmatched!.n), Number(gscUnmatched!.total)), 1)}) are not yet reconciled to a page identity.`, {
        sourceIds: ['gsc_page_daily_current:page_id_null'],
        retrievedAt: [env.generatedAt],
        evidence: [dbQueryLink('gsc_page_daily_current', { site_id: ctx.siteId, page_id: 'NULL', date: `${period.start}..${period.end}` })],
      }),
    );
  }
  if (Number(ga4Unmatched?.total ?? 0) > 0) {
    claims.push(
      observed('urls.ga4_unmatched', `${ga4Unmatched!.n} of ${ga4Unmatched!.total} GA4 landing pages (excluding "(not set)") are not yet reconciled to a page identity.`, {
        sourceIds: ['ga4_landing_daily_current:page_id_null'],
        retrievedAt: [env.generatedAt],
        evidence: [dbQueryLink('ga4_landing_daily_current', { site_id: ctx.siteId, page_id: 'NULL', date: `${period.start}..${period.end}` })],
      }),
    );
  }
  return section('url_reconciliation', 'URL reconciliation', {
    claims,
    notes: ['www/non-www, http/https, trailing slashes, case, and meaningful query parameters are never merged without recorded evidence (redirects, canonicals, configuration). Joins happen at page/period grain, never through keyword many-to-many joins.'],
    tables: aliases.length ? [{ id: 'urls.aliases', title: 'URL aliases by relation and confidence', columns: ['Relation', 'Confidence', 'Count'], rows: aliases.map((a) => [a.relation, a.confidence, Number(a.n)]) }] : [],
  });
}

function metadataListsMetric(meta: unknown, apiName: string): boolean | null {
  if (meta === null || meta === undefined) return null;
  let found = false;
  const visit = (x: unknown, depth: number): void => {
    if (found || depth > 5 || x === null || x === undefined) return;
    if (typeof x === 'string') {
      if (x === apiName) found = true;
      return;
    }
    if (Array.isArray(x)) {
      for (const i of x) visit(i, depth + 1);
      return;
    }
    if (typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if (o.apiName === apiName) {
        found = true;
        return;
      }
      for (const v of Object.values(o)) visit(v, depth + 1);
    }
  };
  visit(meta, 0);
  return found;
}

export function measurementCheckSection(env: BuildEnv): ReportSection {
  const { ctx, period } = env;
  const events = ctx.config.conversions.primaryEvents;
  const claims: Claim[] = [];
  if (events.length === 0) {
    claims.push(unavailable('measurement.primary', 'Primary conversion measurement cannot be checked.', 'no primary conversion event is configured (conversions.primaryEvents)', { evidence: [configLink('conversions.primaryEvents', ctx.siteId)] }));
  }
  const pid = env.ga4.propertyId;
  const metaRow = pid ? ga4PropertyMetadata(ctx.db, ctx.siteId, pid) : null;
  const meta = metaRow?.metadata ?? null;
  const metaAt = metaRow?.fetchedAt ? [metaRow.fetchedAt] : [];
  const VIEW_LABEL: Record<string, string> = { all_traffic: 'all traffic', google_organic: 'Google organic', all_organic: 'all organic' };
  const VIEW_ORDER = ['all_traffic', 'google_organic', 'all_organic'];
  for (const ev of events) {
    if (!pid) {
      claims.push(unavailable(`measurement.${ev.name}.events`, `Event "${ev.name}": occurrences cannot be checked.`, 'no GA4 property is configured (google.ga4PropertyId) and no GA4 data has been ingested', { metricIds: ['ga4.primary_event.occurrences'] }));
    } else {
      // The sync writes nested channel views of the same events (all_traffic >= all_organic >= google_organic);
      // they are read per view and never summed.
      const byView = ctx.db
        .all<{ channel_view: string; n: number | null; days: number; syn: number | null; c: string | null }>(
          `SELECT channel_view, SUM(event_count) AS n, COUNT(DISTINCT date) AS days, MAX(is_synthetic) AS syn, MAX(collected_at) AS c
           FROM ga4_event_daily_current
           WHERE site_id = ? AND property_id = ? AND event_name = ? AND date BETWEEN ? AND ? AND is_complete = 1 AND landing_page = ''
           GROUP BY channel_view`,
          [ctx.siteId, pid, ev.name, period.start, period.end],
        )
        .filter((r) => r.n !== null)
        .sort((a, b) => VIEW_ORDER.indexOf(a.channel_view) - VIEW_ORDER.indexOf(b.channel_view));
      for (const r of byView) markSynthetic(env, 'ga4_event_daily', r.syn);
      const evLink = dbQueryLink('ga4_event_daily_current', { site_id: ctx.siteId, property_id: pid, event_name: ev.name, landing_page: "''", date: `${period.start}..${period.end}`, is_complete: 1 });
      if (byView.length) {
        const parts = byView.map((r) => `${VIEW_LABEL[r.channel_view] ?? r.channel_view} ${fmtInt(Number(r.n))} on ${r.days} day(s)`);
        const noAll = byView.some((r) => r.channel_view === 'all_traffic') ? '' : ' The all-traffic view was not ingested, so site-wide occurrences are not shown.';
        claims.push(
          observed(`measurement.${ev.name}.events`, `Event "${ev.name}" (${ev.meaning}) occurrences in the baseline window, per GA4 channel view (nested views, never summed): ${parts.join('; ')}. Occurrences, not conversions per session.${noAll}`, {
            sourceIds: byView.map((r) => `ga4_event_daily_current:${pid}:${r.channel_view}:${ev.name}`),
            retrievedAt: byView.map((r) => r.c).filter((x): x is string => !!x),
            metricIds: ['ga4.primary_event.occurrences'],
            evidence: [evLink],
            synthetic: byView.some((r) => Number(r.syn ?? 0) === 1),
          }),
        );
      } else {
        claims.push(unavailable(`measurement.${ev.name}.events`, `Event "${ev.name}": no occurrences observed in the baseline window.`, 'no ga4_event_daily rows for this event and property (not ingested, never triggered, or misnamed)', { metricIds: ['ga4.primary_event.occurrences'] }));
      }
    }
    const listed = metadataListsMetric(meta, `sessionKeyEventRate:${ev.name}`);
    if (listed === true) {
      claims.push(observed(`measurement.${ev.name}.metadata`, `GA4 metadata lists sessionKeyEventRate:${ev.name}, so the event-specific session key-event rate is available.`, { sourceIds: [`ga4_property_metadata:${pid}`], retrievedAt: metaAt, metricIds: ['ga4.primary_event.session_rate'], evidence: [recordLink('ga4_property_metadata', String(pid))] }));
    } else if (listed === false) {
      claims.push(inferred(`measurement.${ev.name}.metadata`, `GA4 metadata does not list sessionKeyEventRate:${ev.name}; the event is probably not marked as a key event, so its session conversion rate is unavailable.`, { sourceIds: [`ga4_property_metadata:${pid}`], retrievedAt: metaAt, metricIds: ['ga4.primary_event.session_rate'], evidence: [recordLink('ga4_property_metadata', String(pid))] }));
      addDq(env, { severity: 'critical', code: `primary_event_not_key_event_${ev.name}`, message: `GA4 metadata does not list sessionKeyEventRate:${ev.name}.`, source: 'ga4', nextStep: `Mark "${ev.name}" as a key event in GA4 (a human action), then re-sync.` });
    } else {
      claims.push(unavailable(`measurement.${ev.name}.metadata`, `Key-event availability for "${ev.name}" was not checked.`, 'GA4 property metadata (getMetadata) has not been fetched', { metricIds: ['ga4.primary_event.session_rate'] }));
    }
  }
  const go = env.data.googleOrganic;
  if (go && go.status === 'observed') {
    const r = go.value.primarySessionRate;
    const raw = go.value.primarySessionRateUnverified;
    const opts = { sourceIds: go.value.batchIds.map((b) => `ingestion_batches:${b}`), retrievedAt: go.value.collectedAt, metricIds: ['ga4.primary_event.session_rate'], evidence: [reportSectionLink('google_organic', 'Google organic section')], synthetic: go.value.synthetic };
    claims.push(
      r.status === 'observed'
        ? observed('measurement.rate', `The primary-event session key-event rate is available for Google organic sessions (${fmtPct(r.value)} over the baseline window).${rateScaleAssertionCaveat(go.value.rateScaleAssertion)}`, {
            ...opts,
            ...(go.value.rateScaleAssertion ? { sourceIds: [...opts.sourceIds, `ga4_rate_scale_confirmations:${go.value.rateScaleAssertion.confirmationId}`] } : {}),
          })
        : raw
          ? inferred('measurement.rate', `The primary-event session key-event rate is reported by GA4 (raw value ${raw.raw}), but its scale is unverified (0-1 vs 0-100), so it is not used as a measured percentage.`, { ...opts, reason: r.reason })
          : unavailable('measurement.rate', 'The primary-event session key-event rate is unavailable.', r.reason, { metricIds: ['ga4.primary_event.session_rate'] }),
    );
  }
  const unverified = ctx.config.conversions.primaryEvents.filter((e) => !(e as { verifiedAt?: string | null }).verifiedAt).map((e) => `"${e.name}"`);
  claims.push(
    recommendation('measurement.manual_check', `Verify the primary conversion with the manual test checklist (\`npm run cli -- sync ga4 --checklist\`): trigger it once through a safe test path agreed with the business, confirm it appears in GA4 (Realtime or DebugView) under the exact configured event name, and record the result with \`npm run cli -- setup --update --only conversions\` (conversions.primaryEvents[].verifiedAt and verificationNote).${unverified.length ? ` Not yet verified by the owner: ${unverified.join(', ')}.` : ''} Never create fake production leads or purchases; creating or changing GA4 events remains a human action.`, {
      sourceIds: ['docs:spec#12'],
      evidence: [configLink('conversions.primaryEvents', ctx.siteId)],
    }),
  );
  return section('measurement_check', 'Measurement check', { claims });
}

export function memoryIndexSection(env: BuildEnv): ReportSection {
  const { ctx } = env;
  const docs = ctx.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM memory_documents WHERE site_id = ? GROUP BY status', [ctx.siteId]);
  const chunks = ctx.db.get<{ n: number; tokens: number | null }>('SELECT COUNT(*) AS n, SUM(token_estimate) AS tokens FROM memory_chunks WHERE site_id = ? AND superseded = 0', [ctx.siteId]);
  const idx = ctx.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM chunk_index_status WHERE site_id = ? GROUP BY status', [ctx.siteId]);
  const degraded = ctx.db.all<{ embedding_version_id: string; degraded_reason: string | null }>('SELECT embedding_version_id, degraded_reason FROM memory_index_state WHERE site_id = ? AND degraded = 1', [ctx.siteId]);
  const features = ctx.settings.features;
  const docTotal = docs.reduce((a, d) => a + Number(d.n), 0);
  const claims: Claim[] = [];
  if (docTotal === 0) {
    claims.push(unavailable('memory.documents', 'Memory is not indexed yet.', 'no memory documents are recorded (run `memory sync` after the vault is generated)'));
  } else {
    claims.push(
      observed('memory.documents', `${docTotal} memory document(s) (${docs.map((d) => `${d.status} ${d.n}`).join(', ')}); ${fmtInt(Number(chunks?.n ?? 0))} active chunk(s); vector index status: ${idx.length ? idx.map((i) => `${i.status} ${i.n}`).join(', ') : 'no vectors indexed'}.`, {
        sourceIds: ['memory_documents:*', 'chunk_index_status:*'],
        retrievedAt: [env.generatedAt],
        evidence: [dbQueryLink('memory_documents', { site_id: ctx.siteId }), dbQueryLink('chunk_index_status', { site_id: ctx.siteId })],
      }),
    );
  }
  if (degraded.length) {
    claims.push(observed('memory.degraded', `Vector retrieval is degraded (${degraded.map((d) => d.degraded_reason ?? 'unknown reason').join('; ')}); full-text retrieval is used.`, { sourceIds: degraded.map((d) => `memory_index_state:${d.embedding_version_id}`), retrievedAt: [env.generatedAt], evidence: [dbQueryLink('memory_index_state', { site_id: ctx.siteId, degraded: 1 })] }));
  }
  const notes = [features.qdrant && features.embeddings ? 'Qdrant is a rebuildable index; SQLite remains authoritative.' : 'Vector search (Qdrant/embeddings) is disabled for this profile; retrieval uses SQLite full-text search only.'];
  return section('memory_index', 'Memory index status', { claims, notes });
}

export function blockersSection(env: BuildEnv): ReportSection {
  const items = env.dq.filter((d) => d.severity === 'critical' || d.code.startsWith('access_'));
  const claims: Claim[] = items.map((d, i) =>
    observed(`blockers.${i + 1}.${d.code}`, `${d.message}${d.nextStep ? ` Next step: ${d.nextStep}` : ''}`, {
      sourceIds: [`data_quality:${d.code}`],
      retrievedAt: [env.generatedAt],
      evidence: [d.configField ? configLink(d.configField, env.ctx.siteId) : reportSectionLink('data_quality', 'data-quality section')],
    }),
  );
  if (claims.length === 0) claims.push(observed('blockers.none', 'No blockers were detected by the deterministic checks.', { sourceIds: ['data_quality:checks'], retrievedAt: [env.generatedAt], evidence: [reportSectionLink('data_quality', 'data-quality section')] }));
  return section('blockers', 'Blockers', { claims, notes: ['The baseline reports blockers; it does not start experiments or publish anything.'] });
}

interface PlanPrice {
  estimate: CostEstimate;
  /** Human label of where the price came from. */
  sourceLabel: string;
  caps: ModelCapabilities | null;
}

/**
 * Price a configured model exactly as the LLM Gateway client will when it
 * reserves budget: gateway catalog prices (cached `/v1/models`, no network)
 * and `llm.pricingOverrides`, the higher of the two when both exist. Unknown
 * stays unknown (null), never $0.
 */
function planPrice(env: BuildEnv, catalog: ModelCatalog | null, model: string | null, estimate: (prices: ReturnType<typeof resolvePrices>, caps: ModelCapabilities | null) => CostEstimate): PlanPrice | null {
  if (!model) return null;
  const found = catalog ? findModel(catalog, model, env.ctx.clock.now()) : null;
  const caps = found && found.ok ? found.caps : null;
  const prices = resolvePrices(caps, env.ctx.config, model, catalog?.retrievedAt);
  const e = estimate(prices, caps);
  const sourceLabel =
    e.upperBoundMicros === null
      ? `no verified price (${catalog ? (caps ? 'the gateway catalog lists no price for this model' : `model not found in the cached gateway catalog retrieved ${catalog.retrievedAt}`) : 'no cached gateway model catalog; run `models list`'}; no llm.pricingOverrides entry)`
      : e.basis.source === 'provider_api'
        ? `gateway catalog price (retrieved ${catalog?.retrievedAt ?? 'unknown'}${catalog?.stale ? ', STALE' : ''})${env.ctx.config.llm.pricingOverrides[model] ? ' or llm.pricingOverrides, whichever is higher' : ''}`
        : 'llm.pricingOverrides (verified config)';
  return { estimate: e, sourceLabel, caps };
}

export function costPlanSection(env: BuildEnv): ReportSection {
  const { ctx } = env;
  const s = ctx.settings;
  const cfg = ctx.config;
  const catalog = loadCachedCatalog(ctx);
  if (catalog?.isSynthetic) markSynthetic(env, 'llm_model_catalog_snapshots', 1);
  const pending = ctx.db.get<{ n: number; tokens: number | null }>(
    `SELECT COUNT(*) AS n, SUM(c.token_estimate) AS tokens FROM memory_chunks c
     WHERE c.site_id = ? AND c.superseded = 0
       AND NOT EXISTS (SELECT 1 FROM chunk_index_status s WHERE s.chunk_id = c.id AND s.status = 'indexed')`,
    [ctx.siteId],
  );
  const pendingChunks = Number(pending?.n ?? 0);
  const pendingTokens = Number(pending?.tokens ?? 0);
  const claims: Claim[] = [];
  const priceEvidence = (model: string | null) => [
    ...(catalog && model ? [dbQueryLink('llm_model_capabilities', { site_id: ctx.siteId, snapshot_id: catalog.snapshotId, model_id: model })] : []),
    configLink('llm.pricingOverrides', ctx.siteId),
  ];
  const emb = planPrice(env, catalog, s.models.embedding, (prices) => estimateEmbeddingCost(prices, pendingTokens));
  const embCost = emb?.estimate.upperBoundMicros ?? null;
  const embEnabled = s.features.embeddings && s.features.llm;
  claims.push(
    recommendation(
      'cost.embeddings',
      pendingChunks === 0
        ? 'Embeddings: nothing is pending, so no embedding spend is proposed.'
        : `Proposed (not started): embed ${fmtInt(pendingChunks)} pending chunk(s), about ${fmtInt(pendingTokens)} tokens, with ${s.models.embedding ?? 'an embedding model that is not configured yet'}. Estimated upper bound: ${embCost === null ? 'UNKNOWN (no verified price; the budget system will skip or require approval)' : formatUsd(embCost)}${emb ? `; price source: ${emb.sourceLabel}` : ''}. LLM Gateway budget: ${formatUsd(s.budgets.llmGateway.monthly)}/month, ${formatUsd(s.budgets.llmGateway.perRun)}/run. ${embEnabled ? '' : 'Embeddings are disabled for this profile.'}`.trim(),
      { sourceIds: ['memory_chunks:pending', ...(catalog ? [`llm_model_catalog_snapshots:${catalog.snapshotId}`] : [])], retrievedAt: catalog ? [catalog.retrievedAt] : [], evidence: [dbQueryLink('memory_chunks', { site_id: ctx.siteId, superseded: 0, indexed: 'no' }), ...priceEvidence(s.models.embedding)] },
    ),
  );
  // Same upper bound the gateway reserves: max input + max output, plus a
  // reasoning allowance equal to max output when the model can (or may) reason.
  const reasoningPlan = planPrice(env, catalog, s.models.reasoning, (prices, caps) =>
    estimateChatCost(prices, { inputTokens: cfg.llm.maxInputTokens, maxOutputTokens: cfg.llm.maxOutputTokensReasoning, reasoningTokens: caps === null || caps.reasoningPossible ? cfg.llm.maxOutputTokensReasoning : 0 }),
  );
  const perCall = reasoningPlan?.estimate.upperBoundMicros ?? null;
  const reasoningAllowance = reasoningPlan && (reasoningPlan.caps === null || reasoningPlan.caps.reasoningPossible) ? ` + ${fmtInt(cfg.llm.maxOutputTokensReasoning)} reasoning-token allowance` : '';
  claims.push(
    recommendation(
      'cost.llm',
      `Proposed (not started): optional weekly reasoning analysis with ${s.models.reasoning ?? 'a reasoning model that is not configured yet'}; upper bound per call (max ${fmtInt(cfg.llm.maxInputTokens)} input + ${fmtInt(cfg.llm.maxOutputTokensReasoning)} output tokens${reasoningAllowance}): ${perCall === null ? 'UNKNOWN (no verified price)' : formatUsd(perCall)}${reasoningPlan ? `; price source: ${reasoningPlan.sourceLabel}` : ''}. Each run is capped at ${formatUsd(s.budgets.llmGateway.perRun)}; reports stay deterministic without it.`,
      { sourceIds: ['config:llm', ...(catalog ? [`llm_model_catalog_snapshots:${catalog.snapshotId}`] : [])], retrievedAt: catalog ? [catalog.retrievedAt] : [], evidence: [configLink('llm', ctx.siteId), configLink('budgets.llmGateway', ctx.siteId), ...priceEvidence(s.models.reasoning)] },
    ),
  );
  claims.push(
    claim('RECOMMENDATION', 'cost.paid_research', `The baseline makes no paid DataForSEO or Apify requests. Enable them only after reviewing this plan (budgets: DataForSEO ${formatUsd(s.budgets.dataforseo.weekly)}/week and ${formatUsd(s.budgets.dataforseo.monthly)}/month; Apify ${formatUsd(s.budgets.apify.monthly)}/month; combined ceiling ${formatUsd(s.budgets.combinedMonthly)}/month). These are spending ceilings, not price quotes.`, {
      sourceIds: ['config:budgets'],
      evidence: [configLink('budgets', ctx.siteId)],
    }),
  );
  return section('cost_plan', 'Proposed cost plan (optional LLM and embedding work)', {
    claims,
    notes: ['Nothing in this plan runs automatically. Unknown prices stay unknown and are never estimated as $0; subscriptions, infrastructure, taxes, and one-time costs are not included.'],
    tables: [
      {
        id: 'cost.budgets',
        title: 'Configured budget ceilings',
        columns: ['Service', 'Monthly', 'Weekly', 'Per run'],
        rows: [
          ['LLM Gateway (incl. embeddings)', formatUsd(s.budgets.llmGateway.monthly), '', formatUsd(s.budgets.llmGateway.perRun)],
          ['DataForSEO', formatUsd(s.budgets.dataforseo.monthly), formatUsd(s.budgets.dataforseo.weekly), formatUsd(s.budgets.dataforseo.perRun)],
          ['Apify', formatUsd(s.budgets.apify.monthly), '', formatUsd(s.budgets.apify.perRun)],
          ['Combined variable API ceiling', formatUsd(s.budgets.combinedMonthly), '', ''],
        ],
      },
    ],
  });
}
