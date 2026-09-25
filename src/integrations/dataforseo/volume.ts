import type { AppContext } from '../../app/context.js';
import { hashObject } from '../../core/hash.js';
import type { Measured } from '../../core/measured.js';
import { formatUsd } from '../../core/money.js';
import { errorMessage, isAppError } from '../../core/errors.js';
import { getCached, parseDbRef, researchCacheKey } from './cache.js';
import { createDataForSeoClient, inspectDataForSeoSetup, type DataForSeoClient, type DataForSeoMode } from './client.js';
import { resolveSearchSettings, type ResolvedSearchSettings } from './locations.js';
import { buildCostPlan } from './plan.js';
import { estimateVolumeTask, pricingOverrideWarnings } from './pricing.js';
import { auditResearchSubmission, resolveResearchQueue, unknownPriceApproval, withProviderFailureHint, type ResearchCostPlan, type ResearchRunStatus, type SerpResearchOptions } from './research.js';
import { VOLUME_CACHE_ENDPOINT, normalizeQuery, volumeParameterHash } from './store.js';
import { getTask, pollPendingTasks, submitPaidTasks, waitForTasks, type SubmitOutcome } from './tasks.js';
import type { Blocker, PlanItem, TaskMeta, TaskRow } from './types.js';
import { modeAtLeast } from '../../core/modes.js';

/**
 * Google Ads search-volume ESTIMATES via DataForSEO (DF16-DF20, DF31).
 * No Google Ads account is needed (DF36). Volumes are estimates, not exact
 * demand; missing volume stays missing (never 0). One task holds up to 1000
 * keywords and is priced per task.
 */

export const VOLUME_TASK_POST = 'keywords_data/google_ads/search_volume/task_post';
export const VOLUME_LIVE = 'keywords_data/google_ads/search_volume/live';
export const VOLUME_LABEL = 'estimate (Google Ads data via DataForSEO; not exact demand)';

export interface VolumeOptions extends Omit<SerpResearchOptions, 'device' | 'competitorPagesPerQuery'> {}

export interface KeywordVolumeOutcome {
  keyword: string;
  status: 'cached' | 'fetched' | 'pending' | 'ambiguous' | 'failed' | 'skipped' | 'planned' | 'no_data' | 'invalid';
  volume: Measured<number>;
  label: string;
  metricId: string | null;
  taskId: string | null;
  isSandbox: boolean;
  usableForRecommendations: boolean;
  error?: Blocker;
}

export interface VolumeResearchResult {
  /** 'failed': no keyword was fetched, cached or pending and at least one task failed (see ResearchRunStatus). */
  status: ResearchRunStatus;
  mode: DataForSeoMode | null;
  isSandbox: boolean;
  dryRun: boolean;
  settings: ResolvedSearchSettings | null;
  keywords: KeywordVolumeOutcome[];
  plan: ResearchCostPlan | null;
  submissions: Array<Pick<SubmitOutcome, 'state' | 'providerRequestId' | 'reservationId' | 'estimatedMicros' | 'reservedMicros' | 'actualMicros'> & { error?: Blocker }>;
  blockers: Blocker[];
  warnings: string[];
}

function blockerOf(err: unknown): Blocker {
  if (isAppError(err)) return { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) };
  return { code: 'INTERNAL', message: errorMessage(err) };
}

/** DF17: each keyword at most 80 characters and 10 words; keywords are lowercased by the provider. */
export function validateVolumeKeyword(k: string): string | null {
  const n = normalizeQuery(k);
  if (!n) return 'empty';
  if (n.length > 80) return 'longer than 80 characters (DF17)';
  if (n.split(' ').length > 10) return 'more than 10 words (DF17)';
  return null;
}

function openVolumeTasks(ctx: AppContext, isSandbox: boolean): TaskRow[] {
  return ctx.db.all<TaskRow>(
    `SELECT * FROM dataforseo_tasks WHERE site_id = ? AND is_sandbox = ? AND status IN ('submitting', 'queued', 'ready', 'ambiguous') AND endpoint IN (?, ?) ORDER BY created_at DESC`,
    [ctx.siteId, isSandbox ? 1 : 0, VOLUME_TASK_POST, VOLUME_LIVE],
  );
}

function metricRow(ctx: AppContext, id: string): { id: string; search_volume: number | null; is_sandbox: number } | undefined {
  return ctx.db.get('SELECT id, search_volume, is_sandbox FROM keyword_metrics WHERE id = ? AND site_id = ?', [id, ctx.siteId]);
}

function latestMetricFor(ctx: AppContext, keyword: string, settings: ResolvedSearchSettings, isSandbox: boolean, sinceIso: string): { id: string; search_volume: number | null; is_sandbox: number } | undefined {
  return ctx.db.get(
    `SELECT m.id, m.search_volume, m.is_sandbox FROM keyword_metrics m JOIN keywords k ON k.id = m.keyword_id
     WHERE m.site_id = ? AND k.normalized = ? AND m.location_code = ? AND lower(m.language_code) = lower(?) AND m.is_sandbox = ? AND m.collected_at >= ?
     ORDER BY m.collected_at DESC LIMIT 1`,
    [ctx.siteId, normalizeQuery(keyword), settings.locationCode, settings.languageCode, isSandbox ? 1 : 0, sinceIso],
  );
}

function measuredVolume(v: number | null | undefined, reason: string): Measured<number> {
  return v === null || v === undefined ? { status: 'missing', reason } : { status: 'observed', value: v };
}

/** Search-volume estimates for keywords (cache -> open task -> budgeted task). */
export async function researchKeywordVolumes(ctx: AppContext, keywords: string[], opts: VolumeOptions = {}): Promise<VolumeResearchResult> {
  const dryRun = ctx.dryRun || !!opts.dryRun;
  const setup = inspectDataForSeoSetup(ctx, opts);
  const blockers: Blocker[] = setup.blockers.map((b) => ({ ...b }));
  const warnings: string[] = [...pricingOverrideWarnings(ctx.config)];
  const cfg = ctx.config.research.dataforseo;
  const isSandbox = setup.isSandbox;

  const outcomes = new Map<string, KeywordVolumeOutcome>();
  const valid: string[] = [];
  for (const k of keywords) {
    const n = normalizeQuery(k);
    if (outcomes.has(n)) continue;
    const bad = validateVolumeKeyword(k);
    if (bad) {
      outcomes.set(n || k, { keyword: n || k, status: 'invalid', volume: { status: 'unavailable', reason: bad }, label: VOLUME_LABEL, metricId: null, taskId: null, isSandbox, usableForRecommendations: false, error: { code: 'VALIDATION_FAILED', message: bad } });
      continue;
    }
    valid.push(n);
    outcomes.set(n, { keyword: n, status: 'skipped', volume: { status: 'unavailable', reason: 'not researched' }, label: VOLUME_LABEL, metricId: null, taskId: null, isSandbox, usableForRecommendations: false });
  }
  const finish = (status: VolumeResearchResult['status'], settings: ResolvedSearchSettings | null, plan: ResearchCostPlan | null, submissions: VolumeResearchResult['submissions']): VolumeResearchResult => ({
    status,
    mode: setup.mode,
    isSandbox,
    dryRun,
    settings,
    keywords: [...outcomes.values()],
    plan,
    submissions,
    blockers,
    warnings,
  });
  const skipAll = (b?: Blocker) => {
    for (const o of outcomes.values()) if (o.status === 'skipped' && b) o.error = b;
    return finish('skipped', null, null, []);
  };
  if (!valid.length) {
    warnings.push('No valid keywords to research.');
    return skipAll();
  }
  if (setup.mode === null || (!dryRun && blockers.length)) return skipAll(blockers[0]);
  const mode = setup.mode;
  let client: DataForSeoClient | null = opts.client ?? null;
  if (!client && blockers.length === 0) client = createDataForSeoClient(ctx, opts);

  let settings: ResolvedSearchSettings;
  try {
    settings = await resolveSearchSettings(ctx, client, { kind: 'keywords', mode, allowNetwork: !dryRun && !!client, locationCode: opts.locationCode ?? null, device: null });
  } catch (err) {
    blockers.push(blockerOf(err));
    return skipAll(blockerOf(err));
  }
  warnings.push(...settings.warnings.filter((w) => !w.includes('tablet')));

  // 1. Cache, 2. open tasks already covering the keyword, 3. new tasks.
  const need: string[] = [];
  const items: PlanItem[] = [];
  const open = openVolumeTasks(ctx, isSandbox);
  const openTaskIds = new Set<string>();
  for (const k of valid) {
    const o = outcomes.get(k)!;
    const key = researchCacheKey({ siteId: ctx.siteId, endpoint: VOLUME_CACHE_ENDPOINT, locationCode: settings.locationCode, languageCode: settings.languageCode, device: null, parameterHash: volumeParameterHash(k, settings.locationCode, settings.languageCode), mode });
    const cached = getCached(ctx, key);
    const ref = cached ? parseDbRef(cached.payloadRef) : null;
    const m = ref && ref.table === 'keyword_metrics' ? metricRow(ctx, ref.id) : undefined;
    if (m) {
      Object.assign(o, { status: 'cached', metricId: m.id, volume: measuredVolume(m.search_volume, 'provider returned no volume'), isSandbox: m.is_sandbox === 1, usableForRecommendations: m.is_sandbox === 0 || ctx.synthetic });
      items.push({ label: k, kind: 'volume', action: 'cache_hit', estimateMicros: 0, basis: null });
      continue;
    }
    const t = open.find((r) => {
      const meta = JSON.parse(r.params_json).meta as TaskMeta;
      return meta.locationCode === settings.locationCode && meta.languageCode?.toLowerCase() === settings.languageCode.toLowerCase() && (meta.keywords ?? []).includes(k);
    });
    if (t) {
      o.taskId = t.id;
      openTaskIds.add(t.id);
      items.push({ label: k, kind: 'volume', action: 'reuse_open_task', estimateMicros: 0, basis: null, taskId: t.id });
      continue;
    }
    need.push(k);
  }
  const queueDecision = resolveResearchQueue(ctx, 'keyword volume', { isSandbox });
  if (queueDecision.warning) warnings.push(queueDecision.warning);
  const queue = queueDecision.queue;
  const batches: string[][] = [];
  for (let i = 0; i < need.length; i += 1000) batches.push(need.slice(i, i + 1000));
  const now = ctx.clock.now();
  const batchEstimates = batches.map(() => estimateVolumeTask(ctx.config, { queue, sandbox: isSandbox, tasks: 1 }, now));
  batches.forEach((b, i) => items.push({ label: `${b.length} keyword(s) in one task`, kind: 'volume', action: 'submit', estimateMicros: batchEstimates[i]!.upperBoundMicros, basis: batchEstimates[i]!.basis }));
  const plan: ResearchCostPlan = { ...buildCostPlan(ctx, { mode, isSandbox, queue, items }), queueRequested: queueDecision.requested, liveQueueJustification: queueDecision.justification };

  if (dryRun) {
    for (const k of need) outcomes.get(k)!.status = 'planned';
    for (const id of openTaskIds) for (const o of outcomes.values()) if (o.taskId === id) o.status = 'planned';
    return finish('planned', settings, plan, []);
  }

  if (openTaskIds.size && client) {
    const s = await pollPendingTasks(ctx, { ...opts, taskIds: [...openTaskIds], clients: { [mode]: client } });
    warnings.push(...s.errors);
  }

  const submissions: VolumeResearchResult['submissions'] = [];
  const endpoint = queue === 'live' ? VOLUME_LIVE : VOLUME_TASK_POST;
  if (batches.length && client) {
    let gate: Blocker | null = null;
    if (!isSandbox && !opts.allowPaid) gate = { code: 'POLICY_DENIED', message: 'Paid DataForSEO requests need explicit authorization.', hint: 'CLI: add --allow-spend.' };
    else if (!isSandbox && !modeAtLeast(ctx.mode, 'RESEARCH')) gate = { code: 'POLICY_DENIED', message: `Runtime mode ${ctx.mode} does not allow paid research requests.`, hint: 'Run with --mode RESEARCH.' };
    else if (!isSandbox && settings.verification !== 'verified') gate = { code: 'DATA_UNAVAILABLE', message: 'Location/language could not be verified; paid research is skipped rather than guessing.' };
    if (gate) {
      for (const k of need) outcomes.get(k)!.error = gate;
    } else {
      const groups = queue === 'live' ? batches.map((b, i) => [{ b, i }]) : [batches.map((b, i) => ({ b, i }))];
      auditResearchSubmission(ctx, { kind: 'volume', decision: queueDecision, endpoint, items: need.length, purpose: `Keyword volume: ${need.length} keyword(s) in ${batches.length} task(s)${queueDecision.justification ? `; live queue justified: ${queueDecision.justification}` : ''}` });
      for (const group of groups) {
        const purpose = `Keyword volume: ${group.reduce((s, g) => s + g.b.length, 0)} keyword(s) (${settings.locationCode}/${settings.languageCode})`;
        const payloads = group.map((g) => ({ keywords: g.b, location_code: settings.locationCode, language_code: settings.languageCode }));
        const unknown = group.some((g) => batchEstimates[g.i]!.upperBoundMicros === null);
        // Conservative hold for an approved unknown price (null when any batch has no bound).
        let hold: number | null = unknown ? 0 : null;
        if (unknown) {
          for (const g of group) {
            const e = batchEstimates[g.i]!;
            const v = e.upperBoundMicros ?? e.provisionalMicros ?? null;
            hold = v === null || hold === null ? null : hold + v;
          }
        }
        let unknownPriceApprovalId: string | undefined;
        if (unknown && !isSandbox) {
          const a = unknownPriceApproval(ctx, opts.approvals, { endpoint, payloads, purpose, holdMicros: hold, reason: `Price unknown: ${batchEstimates[group[0]!.i]!.basis.detail}.` });
          if (!('approvalId' in a)) {
            const b: Blocker = { code: 'BUDGET_UNKNOWN_PRICE', message: a.message, hint: 'Verify the price and set research.dataforseo.pricingOverrides, or approve this exact request.' };
            for (const g of group) for (const k of g.b) outcomes.get(k)!.error = b;
            submissions.push({ state: 'not_sent', providerRequestId: '', reservationId: null, estimatedMicros: null, reservedMicros: null, actualMicros: null, error: b });
            continue;
          }
          unknownPriceApprovalId = a.approvalId;
        }
        const total = unknown ? null : group.reduce((s, g) => s + (batchEstimates[g.i]!.upperBoundMicros ?? 0), 0);
        const basis = batchEstimates[group[0]!.i]!.basis;
        try {
          const out = await submitPaidTasks(ctx, client, {
            endpointKey: endpoint,
            tasks: group.map((g, j) => ({
              payload: payloads[j]!,
              meta: { kind: 'volume', mode, queue, purpose, runId: ctx.runId, keywords: g.b, locationCode: settings.locationCode, languageCode: settings.languageCode, device: null },
              parameterHash: hashObject({ family: 'google_ads_search_volume_task', keywords: [...g.b].sort(), location_code: settings.locationCode, language_code: settings.languageCode.toLowerCase() }),
            })),
            estimate: {
              upperBoundMicros: total,
              basis: total !== null && group.length > 1 ? { ...basis, detail: `${group.length} tasks, total ${formatUsd(total)}; ${basis.detail}` } : basis,
              ...(unknown ? { provisionalMicros: hold } : {}),
            },
            purpose,
            allowPaid: !!opts.allowPaid,
            ...(unknownPriceApprovalId ? { unknownPriceApprovalId } : {}),
            ...(opts.approvals ? { approvals: opts.approvals } : {}),
          });
          group.forEach((g, j) => {
            for (const k of g.b) outcomes.get(k)!.taskId = out.tasks[j]?.localId ?? null;
          });
          submissions.push({
            state: out.state,
            providerRequestId: out.providerRequestId,
            reservationId: out.reservationId,
            estimatedMicros: out.estimatedMicros,
            reservedMicros: out.reservedMicros,
            actualMicros: out.actualMicros,
            ...(out.error ? { error: out.error } : {}),
          });
          if (out.error) for (const g of group) for (const k of g.b) if (!outcomes.get(k)!.taskId) outcomes.get(k)!.error = out.error;
          // A request that was not sent or was rejected: keep its error (code and next step) on each keyword.
          if (out.error && (out.state === 'not_sent' || out.state === 'rejected')) for (const g of group) for (const k of g.b) outcomes.get(k)!.error = withProviderFailureHint(out.error);
        } catch (err) {
          const b = blockerOf(err);
          for (const g of group) for (const k of g.b) outcomes.get(k)!.error = b;
          submissions.push({ state: 'not_sent', providerRequestId: '', reservationId: null, estimatedMicros: total, reservedMicros: null, actualMicros: null, error: b });
        }
      }
    }
  }

  const taskIds = [...new Set([...outcomes.values()].map((o) => o.taskId).filter((x): x is string => !!x))];
  const waitIds = taskIds.filter((id) => ['queued', 'ready'].includes(getTask(ctx, id)?.status ?? ''));
  if (opts.waitMs && opts.waitMs > 0 && waitIds.length && client) {
    const w = await waitForTasks(ctx, waitIds, { ...opts, waitMs: opts.waitMs, clients: { [mode]: client }, ...(opts.pollIntervalMs ? { pollIntervalMs: opts.pollIntervalMs } : {}) });
    if (w.timedOut) warnings.push('Local wait ended with keyword-volume tasks still queued (Google Ads standard queue takes 1-3 h, DF31); they are NOT resubmitted.');
  }

  // Assemble per keyword from task state.
  for (const o of outcomes.values()) {
    if (o.status !== 'skipped' || !o.taskId) continue;
    const row = getTask(ctx, o.taskId);
    if (!row) continue;
    if (row.status === 'fetched') {
      const m = latestMetricFor(ctx, o.keyword, settings, row.is_sandbox === 1, row.created_at);
      if (m) Object.assign(o, { status: 'fetched', metricId: m.id, volume: measuredVolume(m.search_volume, 'provider returned no volume'), isSandbox: m.is_sandbox === 1, usableForRecommendations: m.is_sandbox === 0 || ctx.synthetic });
      else Object.assign(o, { status: 'no_data', volume: { status: 'missing', reason: 'keyword absent from the provider result' } });
    } else if (row.status === 'ambiguous') Object.assign(o, { status: 'ambiguous', volume: { status: 'unavailable', reason: 'submission outcome unknown' } });
    else if (row.status === 'failed' || row.status === 'expired') Object.assign(o, { status: 'failed', volume: { status: 'unavailable', reason: `task ${row.status}` }, error: withProviderFailureHint(o.error ?? { code: 'PROVIDER_ERROR', message: `task ${row.status} ${row.api_status_code ?? ''} ${row.api_status_message ?? ''}`.trim() }) });
    else Object.assign(o, { status: 'pending', volume: { status: 'unavailable', reason: 'task still queued' } });
  }
  if (isSandbox && !ctx.synthetic) warnings.push(`${mode.toUpperCase()} mode: volumes are synthetic, flagged is_sandbox = 1, and never used in real recommendations.`);

  const list = [...outcomes.values()].filter((o) => o.status !== 'invalid');
  let status: VolumeResearchResult['status'];
  if (list.every((o) => o.status === 'cached' || o.status === 'fetched' || o.status === 'no_data')) status = 'completed';
  else if (list.every((o) => o.status === 'skipped')) status = 'skipped';
  else if (list.every((o) => ['cached', 'fetched', 'no_data', 'pending', 'ambiguous'].includes(o.status))) status = 'pending';
  // Nothing fetched, cached or pending and at least one task failed: the run failed (never 'partial').
  else if (list.every((o) => o.status === 'failed' || o.status === 'skipped')) status = 'failed';
  else status = 'partial';
  return finish(status, settings, plan, submissions);
}
