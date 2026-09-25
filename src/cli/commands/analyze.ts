import type { Command } from 'commander';
import type { AppContext } from '../../app/context.js';
import { AppError } from '../../core/errors.js';
import { formatMeasured, type Measured } from '../../core/measured.js';
import { assertIsoDate } from '../../core/time.js';
import { effectiveFeatures } from '../../config/profiles.js';
import type { RouteDecision } from '../../router/types.js';
import { buildComparisonInputs, type ComparisonInputs } from '../../seo/competitive.js';
import { resolveGscProperty } from '../../seo/period.js';
import { findPotentialOrphans, suggestInternalLinks, type DestinationSpec } from '../../seo/internal-links.js';
import { analyzePage, measurementDisplayStatus, persistPageAnalysis, prepareSiteAnalysis, routeAllPages, type AnalysisDeps, type PageAnalysis, type SiteAnalysis } from '../../seo/page-analysis.js';
import { UrlReconciler, type ReconcileReport } from '../../seo/reconcile.js';
import { assembleRecommendation, candidateFromAnalysis, loadPriorContext, persistRecommendationSet, type RecommendationDraft, type RecommendationSet } from '../../seo/recommend.js';
import { shortlist } from '../../seo/scoring.js';
import { normalizeUrl } from '../../seo/url.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';

/**
 * `analyze` commands (ANALYZE mode, local only, no network):
 *   analyze page <url>    metrics, joins, route, technical issues, recommendation preview
 *   analyze reconcile     URL reconciliation report (aliases, evidence, unresolved rows)
 *   analyze route         route + score every page; optional --save persists decisions and a recommendation
 *   analyze links         internal-link suggestions and potential orphans (relative to crawl coverage)
 *   analyze compare <url> --query <q>   deterministic competitor comparison inputs for ONE query
 *                         (localized SERP: configured location, language, device)
 * --dry-run never writes (reconciliation runs inside a rolled-back transaction).
 */

interface PeriodOpts {
  days?: string;
  end?: string;
  searchType?: string;
}

const SYNTHETIC_BANNER = 'SYNTHETIC DATA - fixture/demo rows, not real measurements (no figure below is OBSERVED)';

function deps(ctx: AppContext): AnalysisDeps {
  return { db: ctx.db, siteId: ctx.siteId, config: ctx.config, clock: ctx.clock, synthetic: ctx.synthetic };
}

function parsePeriod(o: PeriodOpts): { days: number; end: string | null; searchType?: string } {
  const days = o.days ? Number(o.days) : 28;
  if (!Number.isInteger(days) || days < 1 || days > 480) throw new AppError('VALIDATION_FAILED', `--days must be an integer between 1 and 480 (got ${o.days})`);
  if (o.end) {
    try {
      assertIsoDate(o.end);
    } catch {
      throw new AppError('VALIDATION_FAILED', `--end must be YYYY-MM-DD (got ${o.end})`);
    }
  }
  return { days, end: o.end ?? null, ...(o.searchType ? { searchType: o.searchType } : {}) };
}

/** Run reconciliation; in dry-run mode the writes are rolled back and only the report is kept. */
export function runReconcile(ctx: AppContext, dryRun: boolean): ReconcileReport {
  return new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock).run({ dryRun });
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const fm = (m: Measured<number> | null | undefined, f: (v: number) => string = String) => (m ? formatMeasured(m, f) : 'n/a');

function renderDecision(d: RouteDecision): string[] {
  const lines = [`Route: ${d.route} (rules ${d.rulesVersion}, decided by ${d.decidedBy})`];
  for (const r of d.reasons) lines.push(`  - ${r.code}: ${r.detail}`);
  for (const n of d.notes) lines.push(`  note ${n.code}: ${n.detail}`);
  lines.push(`  Next step: ${d.nextStep}`);
  return lines;
}

function renderRecommendation(r: RecommendationDraft, heading: string): string[] {
  const lines = [`${heading} [${r.kind}] ${r.title}`];
  if (r.diagnosis) lines.push(`  Diagnosis (INFERRED): ${r.diagnosis}`);
  if (r.proposedChange) lines.push(`  RECOMMENDATION: ${r.proposedChange}`);
  if (r.hypothesis) lines.push(`  HYPOTHESIS: ${r.hypothesis}`);
  if (r.successCriteria) lines.push(`  Success criteria: ${r.successCriteria}`);
  if (r.risks) lines.push(`  Risks: ${r.risks}`);
  if (r.reviewDate) lines.push(`  Review date: ${r.reviewDate}`);
  for (const c of r.claims.filter((c) => c.label === 'OBSERVED' || c.label === 'DATA_UNAVAILABLE')) lines.push(`  ${c.synthetic ? 'SYNTHETIC' : c.label === 'DATA_UNAVAILABLE' ? 'DATA UNAVAILABLE' : c.label}: ${c.text}`);
  return lines;
}

export interface PageCommandResult {
  site: {
    siteId: string;
    period: SiteAnalysis['period'];
    /** displayStatus: 'partial' instead of 'complete' when dates are truncated (row limit or owner import without --complete); truncatedDates counts them. */
    gsc: Omit<SiteAnalysis['gsc'], 'coverage' | 'scope'> & { displayStatus?: string; truncatedDates?: number };
    ga4: Omit<SiteAnalysis['ga4'], 'coverage' | 'scope'> & { displayStatus?: string; truncatedDates?: number };
    siteDecision: RouteDecision | null;
    warnings: string[];
    synthetic: boolean;
  };
  /** Figures rest on synthetic (fixture/demo) data: never observations. */
  synthetic: boolean;
  page: PageAnalysis['page'];
  resolution: unknown;
  metrics: { gsc: unknown; gscPrevious: unknown; ga4: unknown; users: Measured<number> };
  join: unknown;
  queries: Array<Record<string, unknown>>;
  intentClassifier: PageAnalysis['bundle']['intents']['hook'];
  queryHypotheses: PageAnalysis['queryHypotheses'];
  technical: { openIssues: Array<Record<string, unknown>>; inspection: unknown };
  decision: RouteDecision;
  score: PageAnalysis['score'];
  recommendationPreview: RecommendationSet;
  saved: { routeDecisionId: string; opportunityId: string | null } | null;
  reconcile: { ran: boolean; dryRun: boolean; pagesCreated: number; aliasesWritten: number; unresolved: number } | null;
}

function renderPage(r: PageCommandResult): string {
  const g = r.metrics.gsc as { clicks: Measured<number>; impressions: Measured<number>; ctr: Measured<number>; position: Measured<number>; completeness: string; timeZone: string | null } | null;
  const a = r.metrics.ga4 as { sessions: Measured<number>; primaryConversionRate: Measured<number>; primaryConvertingSessions: Measured<number>; primaryEventOccurrences: Measured<number>; keyEventOccurrences: Measured<number>; primaryEventName: string | null; completeness: string; timeZone: string | null } | null;
  const j = r.join as { clicksVsSessions: { ratio: Measured<number>; direction: string; possibleReasons: Array<{ code: string; status: string; detail: string }>; note: string }; dateBoundaries: { note: string } } | null;
  const lines: string[] = [];
  if (r.synthetic) lines.push(SYNTHETIC_BANNER, '');
  lines.push(`Page: ${r.page.url} (${r.page.id}; type ${r.page.pageType ?? 'unknown'}; protected ${r.page.isProtected ? 'yes' : 'no'}; lifecycle ${r.page.lifecycle})`);
  lines.push(`Period: ${r.site.period.period.start}..${r.site.period.period.end} (previous ${r.site.period.previous.start}..${r.site.period.previous.end}); basis: ${r.site.period.basis}`);
  // A source with truncated dates (row limit, or an owner import without --complete) is shown 'partial', never 'complete'.
  lines.push(`Measurement: GSC ${r.site.gsc.displayStatus ?? r.site.gsc.status} (${r.site.gsc.detail}); GA4 ${r.site.ga4.displayStatus ?? r.site.ga4.status} (${r.site.ga4.detail})`);
  if (r.reconcile) lines.push(`Reconciliation: ${r.reconcile.dryRun ? 'dry run (rolled back)' : 'applied'}; ${r.reconcile.pagesCreated} page(s) created, ${r.reconcile.aliasesWritten} alias write(s), ${r.reconcile.unresolved} unresolved raw URL(s)`);
  if (r.site.siteDecision) lines.push(`Site-level route: ${r.site.siteDecision.route}: ${r.site.siteDecision.reasons.map((x) => x.detail).join('; ')}`);
  lines.push('');
  // Only a complete aggregate is labeled OBSERVED; an incomplete one (row limits, GA4 row loss, uncollected dates) says so and keeps its reasons.
  const label = (completeness: string) => (r.synthetic ? 'SYNTHETIC' : completeness === 'complete' ? 'OBSERVED ' : 'INCOMPLETE');
  if (g) lines.push(`${label(g.completeness)} Search Console page totals (final dates, ${g.timeZone ?? 'America/Los_Angeles'} days): clicks ${fm(g.clicks)}, impressions ${fm(g.impressions)}, CTR ${fm(g.ctr, pct)}, avg position ${fm(g.position, (v) => v.toFixed(1))} (impression-weighted aggregate, not a live ranking)`);
  else lines.push('DATA UNAVAILABLE  Search Console: property not resolved');
  if (a) {
    lines.push(`${label(a.completeness)} GA4 google_organic (${a.timeZone ?? 'property time zone unknown'} days): sessions ${fm(a.sessions)}, primary event ${a.primaryEventName ?? '(none)'} session conversion rate ${fm(a.primaryConversionRate, pct)}, sessions with primary event ~${fm(a.primaryConvertingSessions)}`);
    lines.push(`          event occurrences (repeatable, not a rate): primary ${fm(a.primaryEventOccurrences)}, all key events ${fm(a.keyEventOccurrences)}; users ${fm(r.metrics.users)}`);
  } else lines.push('DATA UNAVAILABLE  GA4: not configured or not resolved');
  if (j) {
    lines.push(`INFERRED  Clicks vs sessions: ratio ${fm(j.clicksVsSessions.ratio)} (${j.clicksVsSessions.direction}). ${j.dateBoundaries.note}`);
    for (const p of j.clicksVsSessions.possibleReasons) lines.push(`          ${p.status === 'observed_condition' ? 'observed condition' : 'possible'}: ${p.code} - ${p.detail}`);
    lines.push(`          ${j.clicksVsSessions.note}`);
  }
  lines.push('', `Top queries (visible rows only; anonymized queries are omitted by Search Console; intent classifier: ${r.intentClassifier.status}):`);
  if (!r.queries.length) lines.push('  (no query rows for this page and period)');
  for (const q of r.queries.slice(0, 10)) {
    lines.push(`  "${q.query}" pos ${fm(q.position as Measured<number>, (v) => v.toFixed(1))}, impr ${fm(q.impressions as Measured<number>)}, clicks ${fm(q.clicks as Measured<number>)}, CTR ${fm(q.ctr as Measured<number>, pct)} (comparable ${fm(q.expectedCtr as Measured<number>, pct)}), intent ${q.intent} (${q.decidedBy}), ${q.branded ? 'branded' : 'non-branded'}`);
  }
  lines.push('', ...renderDecision(r.decision));
  lines.push('', `Technical issues (open): ${r.technical.openIssues.length ? '' : 'none recorded'}`);
  for (const t of r.technical.openIssues) lines.push(`  - ${t.issue_type} [${t.severity}${t.confirmed ? ', confirmed' : ', unconfirmed'}${t.is_heuristic ? ', editorial heuristic' : ''}]`);
  const insp = r.technical.inspection as { verdict: string | null; coverageState: string | null; inspectedAt: string } | null;
  lines.push(`URL Inspection (indexed version, not a live test): ${insp ? `${insp.verdict ?? 'no verdict'} / ${insp.coverageState ?? 'n/a'} at ${insp.inspectedAt}` : 'no record'}`);
  if (r.score) lines.push('', `Score: ${r.score.score} (${r.score.segment}; ${r.score.version}); not measured: ${r.score.notMeasured.join(', ')}`);
  lines.push('', ...renderRecommendation(r.recommendationPreview.primary, 'Recommendation preview:'));
  for (const s of r.recommendationPreview.secondary) lines.push(...renderRecommendation(s, 'Secondary observation:'));
  for (const x of r.recommendationPreview.excluded) lines.push(`Excluded: ${x.route} (${x.reason})`);
  if (r.queryHypotheses.length) {
    lines.push('', 'Query-level business impact (HYPOTHESIS, based on page-level evidence):');
    for (const h of r.queryHypotheses.slice(0, 5)) lines.push(`  - ${h.statement}`);
  }
  if (r.site.warnings.length) lines.push('', ...r.site.warnings.map((w) => `Warning: ${w}`));
  lines.push('', r.saved ? `Saved route decision ${r.saved.routeDecisionId}${r.saved.opportunityId ? ` and opportunity ${r.saved.opportunityId}` : ''}.` : 'Preview only (use --save to record the route decision and opportunity).');
  return lines.join('\n');
}

async function pageCommand(ctx: AppContext, url: string, o: PeriodOpts & { save?: boolean }, dryRun: boolean): Promise<PageCommandResult> {
  if (!normalizeUrl(url)) throw new AppError('VALIDATION_FAILED', `Not an absolute http(s) URL: ${url}`);
  const features = effectiveFeatures(ctx.config);
  let reconcile: PageCommandResult['reconcile'] = null;
  if (features.gsc || features.ga4 || features.crawl) {
    const rep = runReconcile(ctx, dryRun);
    reconcile = { ran: true, dryRun, pagesCreated: rep.pagesCreated, aliasesWritten: rep.aliasesWritten, unresolved: rep.unresolved.length };
  }
  const rec = new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock);
  const res = rec.resolve(url);
  if (res.status !== 'resolved') {
    throw new AppError('NOT_FOUND', `No page identity for ${url} (${res.reason}: ${res.detail})`, {
      hint: dryRun ? 'Dry runs do not record new pages; run without --dry-run after syncing Search Console/GA4 or crawling.' : 'Sync Search Console/GA4 or crawl the site first, and check site.allowedHostnames.',
      details: { resolution: res },
    });
  }
  const page = rec.pageById(res.pageId)!;
  const d = deps(ctx);
  const site = prepareSiteAnalysis(d, parsePeriod(o));
  const a = await analyzePage(d, site, page);
  const prior = await loadPriorContext(ctx.db, ctx.siteId, { today: site.today });
  const candidate = candidateFromAnalysis(a);
  const preview = assembleRecommendation(ctx.siteId, {
    candidates: a.score ? [candidate] : [],
    siteDecision: site.siteDecision,
    pageRoute: { route: a.decision.route, reasons: a.decision.reasons, pageId: a.page.id, url: a.page.url },
    today: site.today,
    reviewDays: ctx.config.experiments.defaultMinObservationDays,
    lowTrafficReviewDays: ctx.config.experiments.lowTrafficMinObservationDays,
    prior,
    synthetic: a.bundle.synthetic,
  });
  let saved: PageCommandResult['saved'] = null;
  if (o.save && !dryRun) saved = persistPageAnalysis(ctx.db, a, { now: ctx.clock.now() });
  const b = a.bundle;
  return {
    site: {
      siteId: ctx.siteId,
      period: site.period,
      gsc: { property: site.gsc.property, status: site.gsc.status, displayStatus: measurementDisplayStatus(site.gsc.status, site.gsc.coverage), truncatedDates: site.gsc.coverage?.truncated.length ?? 0, detail: site.gsc.detail },
      ga4: { propertyId: site.ga4.propertyId, status: site.ga4.status, displayStatus: measurementDisplayStatus(site.ga4.status, site.ga4.coverage), truncatedDates: site.ga4.coverage?.truncated.length ?? 0, detail: site.ga4.detail, timeZone: site.ga4.timeZone },
      siteDecision: site.siteDecision,
      warnings: site.warnings,
      synthetic: site.synthetic,
    },
    synthetic: a.bundle.synthetic,
    page: a.page,
    resolution: res,
    metrics: { gsc: b.gsc, gscPrevious: b.gscPrevious, ga4: b.ga4, users: b.users },
    join: b.join,
    queries: b.input.queries.map((q) => ({ query: q.query, clicks: q.clicks, impressions: q.impressions, ctr: q.ctr, position: q.position, expectedCtr: q.expectedCtr, intent: q.intent.intent, branded: q.intent.branded, decidedBy: q.intent.decidedBy, signals: q.intent.signals })),
    intentClassifier: b.intents.hook,
    queryHypotheses: a.queryHypotheses,
    technical: { openIssues: b.technicalIssues.map((t) => ({ ...t })), inspection: b.input.technical.inspection },
    decision: a.decision,
    score: a.score,
    recommendationPreview: preview,
    saved,
    reconcile,
  };
}

export function register(program: Command, cli: CliRuntime): void {
  const analyze = program.command('analyze').description('Analyze pages locally: URL reconciliation, metrics, GSC/GA4 joins, routing, scoring, recommendations (no network)');

  analyze
    .command('page <url>')
    .description('Metrics, joins, route, technical issues, and a recommendation preview for one page')
    .option('--days <n>', 'analysis window length in days (default 28)')
    .option('--end <date>', 'window end date YYYY-MM-DD (default: latest date final in Search Console and complete in GA4)')
    .option('--search-type <type>', 'Search Console search type (default: first configured, usually web)')
    .option('--save', 'record the route decision and opportunity (ignored with --dry-run)')
    .action(
      cli.action(async (url: string, opts: PeriodOpts & { save?: boolean }, cmd: Command) => {
        const g: GlobalOptions = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const result = await pageCommand(ctx, url, opts, !!g.dryRun);
          cli.print(g, result, renderPage);
        } finally {
          ctx.db.close();
        }
      }),
    );

  analyze
    .command('reconcile')
    .description('Reconcile raw GSC/GA4/crawl URLs to page identities with recorded alias evidence')
    .action(
      cli.action(async (_opts: unknown, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const report = runReconcile(ctx, !!g.dryRun);
          cli.print(g, { dryRun: !!g.dryRun, ...report }, (r: ReconcileReport & { dryRun: boolean }) => {
            const lines = [
              `URL reconciliation (${r.version}) for ${r.siteId}${r.dryRun ? ' [dry run: nothing written]' : ''}`,
              `Pages created: ${r.pagesCreated}; alias writes: ${r.aliasesWritten}`,
              `Configured aliases applied: ${r.configured.applied} (wildcard rules ${r.configured.wildcardRules}; skipped ${r.configured.skipped.length})`,
              `Redirect evidence: established ${r.redirects.established}, probable ${r.redirects.probable}, unverified ${r.redirects.unverified}, stale ${r.redirects.stale}`,
              `Canonical evidence: established ${r.canonicals.established}, probable ${r.canonicals.probable}, unverified ${r.canonicals.unverified}, stale ${r.canonicals.stale}`,
              `GSC page rows: ${r.metricRows.gscPage.resolved}/${r.metricRows.gscPage.distinctRaw} raw URLs resolved; GSC page/query: ${r.metricRows.gscPageQuery.resolved}/${r.metricRows.gscPageQuery.distinctRaw}; GA4 landing: ${r.metricRows.ga4Landing.resolved}/${r.metricRows.ga4Landing.distinctRaw}`,
            ];
            if (r.pageTypes) lines.push(`Page types (site.pageTypes, ${r.pageTypes.rules} rule(s)): ${r.pageTypes.applied} applied, ${r.pageTypes.cleared} cleared, ${r.pageTypes.ownerKept} owner type(s) kept over config; ${r.pageTypes.commercialPages} commercial page(s) (router.commercialPageTypes). Owner types: \`pages set-type\`.`);
            if (r.unresolved.length) lines.push('', 'Unresolved (kept explicit, not guessed):', ...r.unresolved.slice(0, 20).map((u) => `  ${u.dataset}: ${u.raw} (${u.rows} rows) - ${u.reason}: ${u.detail}`));
            if (r.distinctVariants.length) lines.push('', 'Similar URLs kept distinct (no equivalence evidence):', ...r.distinctVariants.slice(0, 20).map((v) => `  ${v.urls.join('  |  ')} [${v.differences.join(', ')}]`));
            if (r.conflicts.length) lines.push('', 'Evidence conflicts:', ...r.conflicts.slice(0, 20).map((c) => `  ${c.aliasUrl}: kept ${c.kept.relation}/${c.kept.confidence}, rejected ${c.rejected.relation}/${c.rejected.confidence} (${c.reason})`));
            return lines.join('\n');
          });
        } finally {
          ctx.db.close();
        }
      }),
    );

  analyze
    .command('route')
    .description('Route and score every page; prints branded and non-branded shortlists and one recommendation')
    .option('--days <n>', 'analysis window length in days (default 28)')
    .option('--end <date>', 'window end date YYYY-MM-DD')
    .option('--search-type <type>', 'Search Console search type')
    .option('--limit <n>', 'shortlist size per segment (default 5)')
    .option('--save', 'persist route decisions, opportunities, and the recommendation (ignored with --dry-run)')
    .action(
      cli.action(async (opts: PeriodOpts & { save?: boolean; limit?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const dryRun = !!g.dryRun;
          const rep = runReconcile(ctx, dryRun);
          const d = deps(ctx);
          const site = prepareSiteAnalysis(d, parsePeriod(opts));
          const persist = !!opts.save && !dryRun;
          const run = await routeAllPages(d, site, { persist });
          const prior = await loadPriorContext(ctx.db, ctx.siteId, { today: site.today });
          const oppIds = new Map(run.persisted.map((p) => [p.pageId, p.opportunityId]));
          const candidates = run.analyses.filter((a) => a.score).map((a) => candidateFromAnalysis(a, oppIds.get(a.page.id) ?? null));
          const recommendation = assembleRecommendation(ctx.siteId, {
            candidates,
            siteDecision: site.siteDecision,
            routeCounts: run.counts,
            today: site.today,
            reviewDays: ctx.config.experiments.defaultMinObservationDays,
            lowTrafficReviewDays: ctx.config.experiments.lowTrafficMinObservationDays,
            prior,
            synthetic: site.synthetic,
          });
          const savedRec = persist ? persistRecommendationSet(ctx.db, ctx.siteId, recommendation, { now: ctx.clock.now() }) : null;
          const limit = opts.limit ? Math.max(1, Number(opts.limit) || 5) : 5;
          const scored = run.analyses.filter((a) => a.score).map((a) => ({ url: a.page.url, route: a.decision.route, query: a.focusQuery, result: a.score! }));
          const lists = shortlist(scored, limit);
          const result = {
            dryRun,
            saved: persist,
            synthetic: site.synthetic || recommendation.synthetic,
            period: site.period,
            siteDecision: site.siteDecision,
            reconcile: { pagesCreated: rep.pagesCreated, unresolved: rep.unresolved.length },
            routeCounts: run.counts,
            mergedPages: run.merged.map((m) => ({ url: m.url, mergedInto: m.mergedInto.url, evidence: m.relations })),
            archivedStaleOpportunities: run.archivedStale,
            pages: run.analyses.map((a) => ({ url: a.page.url, route: a.decision.route, reasons: a.decision.reasons.map((r) => r.code), score: a.score?.score ?? null, segment: a.score?.segment ?? null })),
            shortlist: { nonBranded: lists.nonBranded.map((x) => ({ url: x.url, route: x.route, query: x.query, score: x.result.score })), branded: lists.branded.map((x) => ({ url: x.url, route: x.route, query: x.query, score: x.result.score })), unknownSegment: lists.unknown.map((x) => ({ url: x.url, route: x.route, score: x.result.score })) },
            recommendation,
            savedRecommendation: savedRec,
            warnings: site.warnings,
          };
          cli.print(g, result, (r: typeof result) => {
            const lines = r.synthetic ? [SYNTHETIC_BANNER] : [];
            lines.push(`Routing ${r.pages.length} page(s) for ${r.period.period.start}..${r.period.period.end}${r.dryRun ? ' [dry run]' : r.saved ? ' [saved]' : ' [preview]'}`);
            if (r.siteDecision) lines.push(`Site-level route: ${r.siteDecision.route}: ${r.siteDecision.reasons.map((x) => x.detail).join('; ')}`);
            lines.push(`Route counts: ${Object.entries(r.routeCounts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
            if (r.mergedPages.length) lines.push(`Not routed (merged into another page by established evidence): ${r.mergedPages.length} (e.g. ${r.mergedPages[0]!.url} -> ${r.mergedPages[0]!.mergedInto})`);
            lines.push('', 'Non-branded shortlist:', ...(r.shortlist.nonBranded.map((x) => `  ${x.score.toFixed(1)}  ${x.route}  ${x.url}${x.query ? ` ("${x.query}")` : ''}`) || []));
            if (!r.shortlist.nonBranded.length) lines.push('  (none)');
            lines.push('Branded shortlist (kept separate):', ...r.shortlist.branded.map((x) => `  ${x.score.toFixed(1)}  ${x.route}  ${x.url}${x.query ? ` ("${x.query}")` : ''}`));
            if (!r.shortlist.branded.length) lines.push('  (none)');
            lines.push('', ...renderRecommendation(r.recommendation.primary, 'Primary:'));
            for (const s of r.recommendation.secondary) lines.push(...renderRecommendation(s, 'Secondary observation:'));
            for (const x of r.recommendation.excluded) lines.push(`Excluded: ${x.route} (${x.reason})`);
            for (const w of r.warnings) lines.push(`Warning: ${w}`);
            return lines.join('\n');
          });
        } finally {
          ctx.db.close();
        }
      }),
    );

  analyze
    .command('links')
    .description('Internal-link suggestions (source, destination, passage, anchor, reason) and potential orphans relative to crawl coverage')
    .option('--url <url...>', 'destination page URL(s) (default: pages with open opportunities, else top pages by impressions)')
    .option('--max <n>', 'maximum suggestions per destination (default 5)')
    .action(
      cli.action(async (opts: { url?: string[]; max?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const ctx = cli.context(g);
        try {
          const rec = new UrlReconciler(ctx.db, ctx.siteId, ctx.config, ctx.clock);
          let destinations: DestinationSpec[];
          if (opts.url?.length) {
            destinations = opts.url.map((u) => {
              const r = rec.resolve(u);
              if (r.status !== 'resolved') throw new AppError('NOT_FOUND', `No page identity for ${u} (${r.reason})`, { hint: 'Run `analyze reconcile` after syncing or crawling.' });
              return { pageId: r.pageId, url: r.pageUrl };
            });
          } else {
            destinations = ctx.db.all<{ pageId: string; url: string }>(
              `SELECT DISTINCT p.id AS pageId, p.url FROM opportunities o JOIN pages p ON p.id = o.page_id WHERE o.site_id = ? AND o.status IN ('candidate', 'shortlisted', 'recommended') LIMIT 10`,
              [ctx.siteId],
            );
            if (!destinations.length) {
              // Top pages by impressions: site totals only (segment_key ''), one property and search type (never summed across them).
              const prop = resolveGscProperty(ctx.db, ctx.siteId, ctx.config.google.searchConsoleProperty);
              const searchType = ctx.config.google.gsc.searchTypes[0] ?? 'web';
              destinations = prop.property
                ? ctx.db.all<{ pageId: string; url: string }>(
                    "SELECT p.id AS pageId, p.url FROM gsc_page_daily g JOIN pages p ON p.id = g.page_id WHERE g.site_id = ? AND g.is_current = 1 AND g.segment_key = '' AND g.property = ? AND g.search_type = ? GROUP BY p.id ORDER BY SUM(g.impressions) DESC LIMIT 10",
                    [ctx.siteId, prop.property, searchType],
                  )
                : [];
            }
          }
          const suggestions = suggestInternalLinks(ctx.db, ctx.raw, ctx.siteId, { destinations, maxPerDestination: opts.max ? Number(opts.max) : 5 });
          const orphans = findPotentialOrphans(ctx.db, ctx.siteId);
          // Synthetic crawl (fixture/demo transport) or a synthetic context: never presented as observed.
          const crawlIds = [...new Set([orphans.crawl?.id, ...suggestions.suggestions.map((x) => x.crawlId)].filter((x): x is string => !!x))];
          const syntheticCrawl = crawlIds.length ? (ctx.db.get<{ s: number | null }>(`SELECT MAX(is_synthetic) AS s FROM crawls WHERE site_id = ? AND id IN (${crawlIds.map(() => '?').join(', ')})`, [ctx.siteId, ...crawlIds])?.s ?? 0) === 1 : false;
          const result = { synthetic: ctx.synthetic || syntheticCrawl, destinations, ...suggestions, orphans };
          cli.print(g, result, (r: typeof result) => {
            const lines = r.synthetic ? [SYNTHETIC_BANNER, `SYNTHETIC crawl: the links and orphans below come from fixture/demo pages, not an observation of a real site.`, ''] : [];
            lines.push(r.note, '');
            if (!r.suggestions.length) lines.push('No internal-link suggestions.');
            for (const s of r.suggestions) lines.push(`${s.sourcePage.url} -> ${s.destination.url}`, `  anchor: "${s.proposedAnchor}"`, `  passage: ${s.passage}`, `  reason: ${s.reason}`);
            lines.push('', `${r.synthetic ? 'SYNTHETIC potential orphans' : 'Potential orphans'}: ${r.orphans.coverageNote}`);
            for (const o of r.orphans.potentialOrphans.slice(0, 30)) lines.push(`  ${o.url}: ${o.note}`);
            if (!r.orphans.potentialOrphans.length) lines.push('  (none relative to this crawl)');
            if (r.orphans.notAssessable.length) lines.push(`Not assessable (outside the partial crawl's coverage): ${r.orphans.notAssessable.length} page(s), e.g. ${r.orphans.notAssessable.slice(0, 3).map((x) => x.url).join(', ')}`);
            lines.push(r.orphans.metricNote);
            return lines.join('\n');
          });
        } finally {
          ctx.db.close();
        }
      }),
    );

  analyze
    .command('compare <url>')
    .description('Deterministic competitor comparison inputs for one of our pages and ONE query (intent, page type, topics, examples, tools, original data, evidence, freshness, buyer concerns)')
    .option('--query <q>', 'search query whose latest SERP snapshot (configured location, language, device) selects the competitor pages; required unless --competitor is given')
    .option('--competitor <url...>', 'explicit competitor page URLs (must already be crawled)')
    .option('--max <n>', 'maximum competitor pages (default 10)')
    .action(
      cli.action(async (url: string, opts: { query?: string; competitor?: string[]; max?: string }, cmd: Command) => {
        const g = cli.globals(cmd);
        const query = opts.query?.trim() || null;
        if (!query && !opts.competitor?.length) {
          throw new AppError('VALIDATION_FAILED', 'analyze compare needs --query <q> (or explicit --competitor URLs): competitors are compared for one search query at a time and never mixed across queries.', {
            hint: 'Pass the query the page should be compared for, e.g. `analyze compare <url> --query "<search query>"` (queries researched by the weekly job are in research/serp_snapshots).',
          });
        }
        const ctx = cli.context(g);
        try {
          const loc = ctx.config.market.searchLocations[0] ?? null;
          const serp = query ? { locationCode: loc?.locationCode ?? null, languageCode: loc?.languageCode ?? null, device: ctx.config.market.devices.find((d) => d === 'desktop' || d === 'mobile') ?? null } : null;
          const inputs = buildComparisonInputs(ctx.db, ctx.raw, ctx.siteId, {
            ourUrl: url,
            query,
            ...(opts.competitor?.length ? { competitorUrls: opts.competitor } : {}),
            maxCompetitors: opts.max ? Number(opts.max) : 10,
            serp,
            allowSandbox: ctx.synthetic,
            synthetic: ctx.synthetic,
          });
          const result = {
            ...inputs,
            synthetic: inputs.synthetic === true,
            synthesis: {
              status: 'not_run',
              reason: 'This command shows the deterministic inputs only. The weekly pipeline\'s `compare` stage runs the optional synthesis (prompt analysis.serp-synthesis, reasoning tier) for the top researched candidates when a reasoning model is configured and its small LLM allowance permits; results are stored in competitive_comparisons.',
            },
          };
          cli.print(g, result, (r: ComparisonInputs & { synthetic: boolean; synthesis: { status: string; reason: string } }) => {
            const label = r.synthetic ? 'SYNTHETIC' : 'OBSERVED';
            const lines = r.synthetic ? [SYNTHETIC_BANNER] : [];
            lines.push(`Comparison inputs for ${url}${r.query ? ` (query "${r.query}")` : ''}: ${r.competitors.length} accessible competitor page(s)`);
            const snap = r.selection?.serpSnapshot;
            if (snap) lines.push(`SERP snapshot ${snap.id} of ${snap.collectedAt.slice(0, 10)}: location ${snap.locationCode ?? 'unknown'}, language ${snap.languageCode ?? 'unknown'}, device ${snap.device}${snap.isSandbox ? ' (sandbox/fixture data)' : ''}`);
            if (!r.ourPage) lines.push('Our page has not been crawled: only competitor features are shown.');
            lines.push(`Intent/page type: ours ${r.intentAlignment.ours ?? 'unknown'}, most competitors ${r.intentAlignment.dominantCompetitor ?? 'unknown'}`);
            lines.push('Signals (ours vs competitors with signal; keyword heuristics):');
            for (const s of r.signalComparison) lines.push(`  ${s.signal}: ours ${s.ours === null ? 'unknown' : s.ours ? 'yes' : 'no'}; ${s.competitorsWith}/${s.competitorsTotal}`);
            lines.push(`What our page does better (${label} differences):`, ...(r.ourAdvantages.length ? r.ourAdvantages.map((x) => `  - ${x}`) : ['  (none detected)']));
            lines.push(`Gaps (${label} differences, not ranking causes):`, ...(r.gaps.length ? r.gaps.map((x) => `  - ${x}`) : ['  (none detected)']));
            for (const x of r.inaccessibleCompetitors) lines.push(`Not compared: ${x.url} (${x.reason})`);
            lines.push(...r.caveats.map((c) => `Caveat: ${c}`), `Synthesis: ${r.synthesis.status} (${r.synthesis.reason})`);
            return lines.join('\n');
          });
        } finally {
          ctx.db.close();
        }
      }),
    );
}

