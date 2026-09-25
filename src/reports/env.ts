import type { AppContext } from '../app/context.js';
import type { AeoSiteAssessment } from '../crawler/aeo.js';
import type { IntegrationStatus } from '../integrations/types.js';
import type { OrphanReport, SuggestResult } from '../seo/internal-links.js';
import type { SiteStructureSummary } from '../seo/site-structure.js';
import type { LlmClient, ModelTier } from '../integrations/llm/types.js';
import type { DataQualityItem, EvidenceLink, ReportData, ReportKind, ReportPeriod, SectionKey } from './model.js';
import type { LinkResolver } from './links.js';
import { resolveGa4Property, resolveGscProperty } from './queries.js';

/** Input shared by the baseline, weekly, and monthly builders. */
export interface ReportBuildInput {
  /**
   * Integration statuses gathered by the caller (doctor/status reporters).
   * Pass `null` when statuses were not checked (e.g. a from-db rebuild): the
   * report then says so instead of implying there are no access issues.
   */
  statuses: IntegrationStatus[] | null;
  /** Explicit period (YYYY-MM-DD, business time zone). Defaults per report kind. */
  period?: { start: string; end: string };
  /** Job that produced the report (recorded when it exists). */
  jobId?: string | null;
  /** Top-N limit for tables (reports never include full raw datasets). Default 10. */
  topN?: number;
  /** Optional wikilink resolver; standard Markdown links otherwise. */
  linkResolver?: LinkResolver;
  /** Persist files + reports row (default true; forced false in dry-run). */
  persist?: boolean;
  /** Optional, labeled LLM executive summary. Never required; numbers stay computed in code. */
  llmSummary?: { client: LlmClient; tier?: ModelTier; maxOutputTokens?: number } | null;
  /**
   * Outcomes of the pipeline run that produced this report (baseline/weekly/
   * monthly workflow stages). Stages that did not succeed are recorded as
   * data-quality items, so a degraded or skipped stage (missing optional
   * provider, budget exhausted, blocked competitor crawl, runtime mode) is
   * stated in the report instead of silently missing.
   */
  pipeline?: PipelineRunInfo | null;
  /**
   * Weekly report: internal-link suggestions and potential orphans. Omitted:
   * computed from the latest own-site crawl in the database (a few priority
   * destination pages). `null`: not collected for this report (reported as
   * DATA UNAVAILABLE, never as "none").
   */
  internalLinks?: InternalLinksReportInput | null;
  /**
   * Monthly report: page-level AEO assessment. Omitted: assessed from the
   * latest own-site crawl in the database. `null`: not collected (DATA UNAVAILABLE).
   */
  aeo?: AeoSiteAssessment | null;
  /**
   * The weekly pipeline's `site_structure` stage summary (src/seo/site-structure.ts):
   * internal-link suggestions, potential orphans, and page-level AEO checks
   * collected by this run. Used for the internal-links section (and an AEO
   * section in the weekly report) unless `internalLinks` / `aeo` are given.
   * Absent or null: the data is read from the database.
   */
  siteStructure?: SiteStructureSummary | null;
}

/** Internal-link data collected by the caller (for example `analyze links`). */
export interface InternalLinksReportInput {
  suggestions: SuggestResult;
  orphans: OrphanReport;
  /** Number of destination pages suggestions were computed for (default: distinct destinations in the suggestions). */
  destinationCount?: number;
  /** How the destination pages were chosen, shown in the report text. */
  destinationsBasis?: string;
}

export interface PipelineStageNote {
  stage: string;
  status: 'succeeded' | 'degraded' | 'skipped' | 'failed' | 'not_run';
  code?: string | null;
  detail: string;
  nextStep?: string | null;
  severity?: 'critical' | 'warning' | 'info';
}

export interface PipelineRunInfo {
  workflow: string;
  jobId: string | null;
  stages: PipelineStageNote[];
}

/** Record every non-succeeded pipeline stage as a data-quality item. */
export function addPipelineNotes(env: BuildEnv, pipeline: PipelineRunInfo | null | undefined): void {
  if (!pipeline) return;
  for (const n of pipeline.stages) {
    if (n.status === 'succeeded') continue;
    const code = `pipeline_${n.stage}_${String(n.code ?? n.status).toLowerCase()}`.replace(/[^a-z0-9_]+/g, '_');
    addDq(env, {
      severity: n.severity ?? (n.status === 'failed' ? 'warning' : 'info'),
      code,
      message: `${pipeline.workflow} stage "${n.stage}" ${n.status}${n.code ? ` (${n.code})` : ''}: ${n.detail}`,
      source: 'pipeline',
      ...(pipeline.jobId ? { recordRef: `jobs:${pipeline.jobId}` } : {}),
      ...(n.nextStep ? { nextStep: n.nextStep } : {}),
    });
  }
}

export interface BuildEnv {
  ctx: AppContext;
  kind: ReportKind;
  period: ReportPeriod;
  generatedAt: string;
  topN: number;
  statuses: IntegrationStatus[];
  statusesChecked: boolean;
  primaryEvent: string | null;
  gsc: { property: string | null; others: string[]; searchType: string };
  ga4: { propertyId: string | null; others: string[] };
  /** Datasets/tables where synthetic rows were read. */
  synthetic: Set<string>;
  dq: DataQualityItem[];
  data: ReportData;
  /** All ingestion batch IDs used as sources (for summary claims). */
  sourceBatchIds: Set<string>;
  jobId: string | null;
  /** Stage outcomes of the pipeline run that produced this report (null for a from-db rebuild). */
  pipeline: PipelineRunInfo | null;
}

/** Outcome of one stage of the pipeline run that produced this report, or null when unknown. */
export function pipelineStage(env: BuildEnv, stage: string): PipelineStageNote | null {
  return env.pipeline?.stages.find((s) => s.stage === stage) ?? null;
}

export function markSynthetic(env: BuildEnv, what: string, flag: boolean | number | null | undefined): void {
  if (flag === true || flag === 1) env.synthetic.add(what);
}

export function addDq(env: BuildEnv, item: DataQualityItem): void {
  if (!env.dq.some((d) => d.code === item.code && d.message === item.message)) env.dq.push(item);
}

export function batchSourceIds(batchIds: readonly string[]): string[] {
  return batchIds.map((b) => `ingestion_batches:${b}`);
}

export function batchLinks(batchIds: readonly string[], max = 3): EvidenceLink[] {
  return batchIds.slice(0, max).map((b) => ({ kind: 'db_record' as const, label: `ingestion batch ${b}`, ref: `ingestion_batches:${b}`, supportsClaim: true }));
}

/** Link to another section of the same report (rendered as "section <key>"). */
export function reportSectionLink(key: SectionKey, label: string): EvidenceLink {
  return { kind: 'report', label, ref: `section:${key}`, supportsClaim: true };
}

export function configLink(field: string, siteId: string): EvidenceLink {
  return { kind: 'config', label: `site config ${field}`, ref: `config/sites/${siteId}.yaml#${field}`, supportsClaim: true };
}

export function docLink(ref: string, label: string): EvidenceLink {
  return { kind: 'doc', label, ref, supportsClaim: true };
}

export const PROBLEM_STATES = new Set(['missing_credentials', 'misconfigured', 'unreachable', 'permission_denied', 'degraded']);

/** Create the shared build environment for a report kind and resolved period. */
export function createEnv(ctx: AppContext, kind: ReportKind, period: ReportPeriod, input: Pick<ReportBuildInput, 'statuses' | 'topN' | 'jobId'> & Pick<Partial<ReportBuildInput>, 'pipeline'>): BuildEnv {
  const gsc = resolveGscProperty(ctx);
  const ga4 = resolveGa4Property(ctx);
  const topN = Math.max(1, Math.min(100, Math.floor(input.topN ?? 10)));
  const env: BuildEnv = {
    ctx,
    kind,
    period,
    generatedAt: ctx.clock.now().toISOString(),
    topN,
    statuses: input.statuses ?? [],
    statusesChecked: input.statuses !== null && input.statuses !== undefined,
    primaryEvent: ctx.config.conversions.primaryEvents[0]?.name ?? null,
    gsc,
    ga4,
    synthetic: new Set(),
    dq: [],
    data: {},
    sourceBatchIds: new Set(),
    jobId: input.jobId ?? null,
    pipeline: input.pipeline ?? null,
  };
  if (ctx.synthetic) env.synthetic.add('demo_context');
  const site = ctx.db.get<{ is_demo: number }>('SELECT is_demo FROM sites WHERE id = ?', [ctx.siteId]);
  if (site?.is_demo === 1) env.synthetic.add('demo_site');
  return env;
}
