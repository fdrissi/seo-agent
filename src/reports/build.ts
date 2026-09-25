import type { AppContext } from '../app/context.js';
import { newId } from '../core/ids.js';
import { redact } from '../security/redact.js';
import type { GeneratedNote } from '../obsidian/types.js';
import { metricDefinitions } from './definitions.js';
import { addDq, addPipelineNotes, createEnv, reportSectionLink, type BuildEnv, type ReportBuildInput } from './env.js';
import { llmExecutiveSummary } from './llm-summary.js';
import {
  REPORT_GENERATOR_VERSION,
  REPORT_SCHEMA_VERSION,
  SYNTHETIC_WATERMARK,
  allClaims,
  countClaims,
  observed,
  section,
  validateReport,
  type Claim,
  type LlmSummaryInfo,
  type Report,
  type ReportIssue,
  type ReportKind,
  type ReportSection,
  type SectionKey,
} from './model.js';
import { resolvePeriod } from './period.js';
import { renderJson, renderMarkdown } from './render.js';
import {
  confidenceSection,
  contentSection,
  dataQualitySection,
  experimentsSection,
  finalizeDataQuality,
  freshnessSection,
  ga4Section,
  gscSection,
  nextActionSection,
  primaryActionSection,
  spendSection,
} from './sections-common.js';
import {
  aiVisibilitySection,
  apiUsageSection,
  attributionSection,
  competitorChangesSection,
  contentCohortsSection,
  experimentsReviewSection,
  learningsSection,
  organicConversionReviewSection,
} from './sections-monthly.js';
import { aeoSection, internalLinksSection } from './sections-site.js';
import { blockersSection, collectionSection, costPlanSection, crawlSummarySection, measurementCheckSection, memoryIndexSection, urlReconciliationSection } from './sections-baseline.js';
import { ga4PropertyTimeZone } from './queries.js';
import { persistReport, toVaultNote, type StoredReport } from './storage.js';

export type { ReportBuildInput, PipelineRunInfo, PipelineStageNote, InternalLinksReportInput } from './env.js';

export interface BuiltReport {
  report: Report;
  markdown: string;
  json: string;
  /** Vault note for the integration phase to write via VaultWriter. */
  note: GeneratedNote;
  /** Null in dry-run or when `persist: false`. */
  stored: StoredReport | null;
  /** Contract violations found by validateReport (expected to be empty). */
  issues: ReportIssue[];
}

const ORDER: Record<ReportKind, SectionKey[]> = {
  weekly: ['executive_summary', 'dates', 'freshness', 'evidence_confidence', 'google_organic', 'all_organic', 'gsc_performance', 'data_quality', 'experiments', 'primary_action', 'content', 'internal_links', 'aeo', 'spend', 'next_action', 'metric_definitions'],
  monthly: [
    'executive_summary',
    'dates',
    'freshness',
    'evidence_confidence',
    'organic_conversion_review',
    'attribution_assumptions',
    'google_organic',
    'all_organic',
    'gsc_performance',
    'data_quality',
    'experiments',
    'experiments_review',
    'primary_action',
    'content',
    'content_cohorts',
    'competitor_changes',
    'ai_visibility',
    'aeo',
    'api_usage',
    'learnings',
    'spend',
    'next_action',
    'metric_definitions',
  ],
  baseline: [
    'executive_summary',
    'dates',
    'blockers',
    'collection',
    'freshness',
    'evidence_confidence',
    'measurement_check',
    'google_organic',
    'all_organic',
    'gsc_performance',
    'crawl_summary',
    'url_reconciliation',
    'memory_index',
    'data_quality',
    'experiments',
    'primary_action',
    'content',
    'cost_plan',
    'spend',
    'next_action',
    'metric_definitions',
  ],
};

function datesSection(env: BuildEnv): ReportSection {
  const p = env.period;
  const gt = env.data.gsc?.current;
  const gscTz = (gt && (gt.status === 'observed' ? gt.value.dateTz : gt.status === 'incomplete' ? gt.partialValue?.dateTz : null)) ?? 'America/Los_Angeles (per Google documentation)';
  const go = env.data.googleOrganic;
  const ga4Tz = (go && go.status === 'observed' ? go.value.dateTz : null) ?? (env.ga4.propertyId ? ga4PropertyTimeZone(env.ctx.db, env.ctx.siteId, env.ga4.propertyId) : null) ?? 'unknown (GA4 property metadata not fetched)';
  const notes = ['Search Console and GA4 use different day boundaries; aggregated daily data cannot be shifted into an identical time-zone window.'];
  // The scheduler zone (default Europe/Tallinn) is a fact about the owner's machine, never presented as the business zone.
  const tzFallback = p.timeZoneSource === 'scheduler_fallback';
  const businessTz = tzFallback ? `unknown (period boundaries use the scheduler zone ${p.timeZone})` : p.timeZone;
  if (tzFallback) {
    notes.push(`The business time zone is not configured, so report periods, experiment weekday matching, and budget months use the scheduler zone ${p.timeZone}. It is not the business's time zone and says nothing about the target market.`);
    addDq(env, {
      severity: 'warning',
      code: 'business_timezone_unknown',
      message: `The business time zone is unknown (reporting.businessTimezone is not set); period boundaries use the scheduler zone ${p.timeZone}.`,
      source: 'config',
      configField: 'reporting.businessTimezone',
      nextStep: `Set it with \`npm run cli -- setup --update --only reporting.businessTimezone\` (IANA name, e.g. the zone the business reports in).`,
    });
  }
  if (p.explicit) notes.push('An explicit period was supplied for this report.');
  if (p.explicit && p.latestCompleteDate && p.end > p.latestCompleteDate) {
    notes.push(`The period extends past the latest complete date (${p.latestCompleteDate}); later dates may be incomplete and are excluded from totals.`);
    env.dq.push({ severity: 'warning', code: 'period_includes_incomplete', message: `The report period ends ${p.end}, after the latest complete date ${p.latestCompleteDate}.`, nextStep: 'Prefer the default period, which ends at the latest complete date.' });
  }
  return section('dates', 'Dates and time zones', {
    tables: [
      {
        id: 'dates',
        title: 'Report dates',
        columns: ['Field', 'Value'],
        rows: [
          ['Report kind', env.kind],
          ['Period', `${p.start} to ${p.end} (${p.days} days)`],
          ['Comparison period', p.comparison ? `${p.comparison.start} to ${p.comparison.end} (${p.comparison.label})` : 'none'],
          ['Business time zone', businessTz],
          ['Search Console reporting time zone', gscTz],
          ['GA4 property time zone', ga4Tz],
          ['Latest complete date', `${p.latestCompleteDate ?? 'unknown'} (${p.latestCompleteBasis})`],
          ['Generated at (UTC)', env.generatedAt],
        ],
      },
    ],
    notes,
  });
}

function metricDefinitionsSection(defs: Report['metricDefinitions']): ReportSection {
  return section('metric_definitions', 'Metric definitions', {
    tables: [{ id: 'metric_definitions', title: 'Metric definitions', columns: ['ID', 'Metric', 'Definition', 'Formula', 'Additivity'], rows: defs.map((d) => [d.id, d.name, d.definition, d.formula ?? '', d.additivity]) }],
  });
}

function echo(sections: ReportSection[], fromIds: string[], newId: string, prefix: string): Claim | null {
  const all = sections.flatMap((s) => s.claims);
  for (const id of fromIds) {
    const c = all.find((x) => x.id === id);
    if (c) return { ...c, id: newId, text: `${prefix}${c.text}` };
  }
  return null;
}

function executiveSummary(env: BuildEnv, sections: ReportSection[]): ReportSection {
  const claims: Claim[] = [];
  const push = (c: Claim | null) => {
    if (c) claims.push(c);
  };
  push(echo(sections, ['gsc.clicks.change', 'gsc.clicks.current', 'gsc.totals.current'], 'summary.gsc', 'Search Console: '));
  push(echo(sections, ['ga4.google_organic.sessions'], 'summary.google_organic', 'Google organic (GA4): '));
  push(echo(sections, ['ga4.all_organic.sessions'], 'summary.all_organic', 'All organic (GA4, separate view): '));
  push(echo(sections, ['ga4.google_organic.primary_rate'], 'summary.conversion', 'Conversion (Google organic): '));
  push(echo(sections, ['action.primary'], 'summary.action', ''));
  push(echo(sections, ['confidence.level'], 'summary.confidence', ''));
  const crit = env.dq.filter((d) => d.severity === 'critical').length;
  const warn = env.dq.filter((d) => d.severity === 'warning').length;
  const access = env.data.accessIssues?.length ?? 0;
  claims.push(
    observed('summary.issues', `${crit} critical and ${warn} warning data-quality item(s); ${env.statusesChecked ? `${access} unresolved access issue(s)` : 'integration access was not checked for this report'}.`, {
      sourceIds: ['data_quality:checks'],
      retrievedAt: [env.generatedAt],
      evidence: [reportSectionLink('data_quality', 'data-quality section')],
    }),
  );
  push(echo(sections, ['next.action'], 'summary.next', ''));
  return section('executive_summary', 'Executive summary', { claims, notes: env.kind === 'baseline' ? ['The baseline collects and checks data; it performs no paid research, starts no experiments, and publishes nothing.'] : [] });
}

/**
 * Per-claim synthetic flag from provenance: an OBSERVED or INFERRED claim that
 * cites any synthetic ingestion batch (fixture/demo rows) is marked synthetic,
 * so it renders with the [SYNTHETIC] marker even when the section builder did
 * not set the flag itself. Sections still set the flag directly for
 * non-batch sources.
 */
function flagSyntheticBatchClaims(env: BuildEnv, sections: ReportSection[]): void {
  const claims = sections.flatMap((s) => s.claims).filter((c) => c.label === 'OBSERVED' || c.label === 'INFERRED');
  const ids = [...new Set(claims.flatMap((c) => c.sourceIds).filter((id) => id.startsWith('ingestion_batches:')).map((id) => id.slice('ingestion_batches:'.length)))];
  const synthetic = new Set<string>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    for (const r of env.ctx.db.all<{ id: string }>(`SELECT id FROM ingestion_batches WHERE site_id = ? AND is_synthetic = 1 AND id IN (${chunk.map(() => '?').join(', ')})`, [env.ctx.siteId, ...chunk])) synthetic.add(`ingestion_batches:${r.id}`);
  }
  if (!synthetic.size) return;
  for (const c of claims) if (!c.synthetic && c.sourceIds.some((id) => synthetic.has(id))) c.synthetic = true;
}

async function buildReport(ctx: AppContext, kind: ReportKind, input: ReportBuildInput): Promise<BuiltReport> {
  const period = resolvePeriod(ctx, kind, input.period ?? {});
  const env = createEnv(ctx, kind, period, input);
  addPipelineNotes(env, input.pipeline);
  const built: ReportSection[] = [];
  const add = (s: ReportSection) => built.push(s);

  add(freshnessSection(env));
  add(gscSection(env));
  add(ga4Section(env, 'google_organic'));
  add(ga4Section(env, 'all_organic'));
  add(experimentsSection(env, { baseline: kind === 'baseline' }));
  add(primaryActionSection(env));
  add(contentSection(env));
  add(spendSection(env));
  if (kind === 'weekly') {
    add(internalLinksSection(env, input.internalLinks, input.siteStructure));
    // The weekly run's site_structure stage also assessed AEO: shown when supplied (the monthly report always has it).
    if (input.aeo !== undefined || input.siteStructure) add(aeoSection(env, input.aeo, input.siteStructure));
  }
  if (kind === 'monthly') {
    add(organicConversionReviewSection(env));
    add(attributionSection(env));
    add(experimentsReviewSection(env));
    add(contentCohortsSection(env));
    add(competitorChangesSection(env));
    add(aiVisibilitySection(env));
    add(aeoSection(env, input.aeo, input.siteStructure));
    add(apiUsageSection(env));
    add(learningsSection(env));
  }
  if (kind === 'baseline') {
    add(collectionSection(env));
    add(crawlSummarySection(env));
    add(urlReconciliationSection(env));
    add(measurementCheckSection(env));
    add(memoryIndexSection(env));
    add(costPlanSection(env));
  }
  add(datesSection(env));
  const dq = dataQualitySection(env);
  finalizeDataQuality(env, dq);
  add(dq);
  if (kind === 'baseline') add(blockersSection(env));
  add(confidenceSection(env));
  add(nextActionSection(env));
  const summary = executiveSummary(env, built);
  add(summary);

  let llmInfo: LlmSummaryInfo = { status: 'not_requested', detail: '' };
  const isSynthetic = env.synthetic.size > 0;
  if (input.llmSummary) {
    const r = await llmExecutiveSummary(ctx, input.llmSummary, { kind, period, claims: allClaims({ sections: built }), synthetic: isSynthetic });
    llmInfo = r.info;
    if (r.claim) summary.claims.push(r.claim);
    else summary.notes.push(`Optional model-generated summary not included: ${r.info.detail}.`);
  }
  const defs = metricDefinitions(env.primaryEvent);
  add(metricDefinitionsSection(defs));
  flagSyntheticBatchClaims(env, built);

  const byKey = new Map(built.map((s) => [s.key, s]));
  const sections = ORDER[kind].map((k) => byKey.get(k)).filter((s): s is ReportSection => !!s);

  const raw: Report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    id: newId('rpt'),
    kind,
    siteId: ctx.siteId,
    siteName: ctx.config.site.businessName,
    generatedAt: env.generatedAt,
    generator: { version: REPORT_GENERATOR_VERSION, deterministic: true, llmSummary: llmInfo },
    period,
    isSynthetic,
    watermark: isSynthetic ? SYNTHETIC_WATERMARK : null,
    jobId: env.jobId,
    sections,
    metricDefinitions: defs,
    data: { ...env.data, syntheticSources: [...env.synthetic] },
    summary: {
      kind,
      period: { start: period.start, end: period.end },
      confidence: env.data.confidence?.level ?? 'none',
      isSynthetic,
      primaryAction: env.data.primaryAction ? { kind: env.data.primaryAction.kind, title: env.data.primaryAction.title, recommendationId: env.data.primaryAction.recommendationId } : null,
      nextAction: env.data.nextAction?.text ?? null,
      warnings: env.dq.filter((d) => d.severity !== 'info').length,
      accessIssues: env.data.accessIssues?.length ?? 0,
      claimCounts: countClaims({ sections }),
    },
  };
  // Redact secrets in the RAW strings once, before anything is rendered or
  // stored (Markdown escaping would otherwise hide secrets from the matchers).
  // The returned, persisted, and rendered report is this redacted copy.
  const report = redact(raw);
  const issues = validateReport(report);
  if (issues.length) ctx.logger.warn(`Report ${report.id} has ${issues.length} contract issue(s)`, { issues: issues.slice(0, 10) });
  const renderOpts = input.linkResolver ? { linkResolver: input.linkResolver } : {};
  const markdown = renderMarkdown(report, renderOpts);
  const json = renderJson(report);
  const note = toVaultNote(report, markdown);
  const persist = input.persist !== false && !ctx.dryRun;
  const stored = persist ? persistReport(ctx, report, { markdown, json }) : null;
  return { report, markdown, json, note, stored, issues };
}

/**
 * Baseline report: what was collected (available history), crawl summary,
 * URL reconciliation, measurement check, memory index status, blockers, and a
 * proposed cost plan. No experiments are started and nothing is published.
 */
export function buildBaselineReport(ctx: AppContext, input: ReportBuildInput): Promise<BuiltReport> {
  return buildReport(ctx, 'baseline', input);
}

/** Weekly report: the standard sections with one prioritized action or an explicit wait, plus internal-link suggestions and potential orphans. */
export function buildWeeklyReport(ctx: AppContext, input: ReportBuildInput): Promise<BuiltReport> {
  return buildReport(ctx, 'weekly', input);
}

/** Monthly report: weekly sections plus the monthly review, cohorts, competitors, AI visibility, page-level AEO checks, API usage, learnings. */
export function buildMonthlyReport(ctx: AppContext, input: ReportBuildInput): Promise<BuiltReport> {
  return buildReport(ctx, 'monthly', input);
}

export function buildReportOfKind(ctx: AppContext, kind: ReportKind, input: ReportBuildInput): Promise<BuiltReport> {
  return buildReport(ctx, kind, input);
}
