import type { AppContext } from '../../app/context.js';
import type { ApprovalGate } from '../../approvals/types.js';
import { AppError, errorMessage, isAppError } from '../../core/errors.js';
import { hashObject } from '../../core/hash.js';
import { modeAtLeast } from '../../core/modes.js';
import { formatUsd } from '../../core/money.js';
import { recordAudit } from '../../database/audit.js';
import { getCached, parseDbRef, researchCacheKey } from './cache.js';
import { createDataForSeoClient, inspectDataForSeoSetup, type DataForSeoClient, type DataForSeoClientOptions, type DataForSeoMode } from './client.js';
import { resolveSearchSettings, type ResolvedSearchSettings } from './locations.js';
import { buildCostPlan } from './plan.js';
import { estimateSerpTask, hasSearchOperators, pricingOverrideWarnings } from './pricing.js';
import {
  SERP_CACHE_ENDPOINT,
  competitorUrlsForSnapshot,
  isBrandedQuery,
  normalizeQuery,
  ownRankForSnapshot,
  serpParameterHash,
  snapshotForTask,
} from './store.js';
import { findOpenTask, getTask, pollPendingTasks, submitPaidTasks, waitForTasks, type SubmitOutcome } from './tasks.js';
import type { Blocker, CompetitorUrl, CostPlan, PlanItem, TaskMeta } from './types.js';

/**
 * Targeted SERP research and the default research process (spec section 14):
 *
 *   GSC shortlist -> local filtering -> at most `research.seriousQueriesPerRun`
 *   serious queries -> targeted SERP research -> relevant competitor pages
 *
 * Valid cache entries and existing open tasks are always reused before any
 * paid request. Sandbox/fixture results are flagged and never usable for real
 * recommendations.
 */

export const SERP_TASK_POST = 'serp/google/organic/task_post';
export const SERP_LIVE = 'serp/google/organic/live/advanced';

export interface SerpResearchOptions extends DataForSeoClientOptions {
  dryRun?: boolean;
  /** Explicit authorization for chargeable (non-sandbox) submissions. Default false. */
  allowPaid?: boolean;
  device?: 'desktop' | 'mobile';
  /** Pick a configured market.searchLocations entry by code (default: the first). */
  locationCode?: number;
  /** Competitor pages returned per query (default crawl.competitorPagesPerQuery, max crawl.competitorPagesPerQueryMax). */
  competitorPagesPerQuery?: number;
  /** Poll standard-queue tasks for up to this long (free GETs; never resubmits). Default 0. */
  waitMs?: number;
  pollIntervalMs?: number;
  /** Approval gate for requests whose price is unknown. */
  approvals?: ApprovalGate;
  /** Pre-built client (tests/demo). */
  client?: DataForSeoClient;
  origin?: string;
}

export type QueryStatus = 'cached' | 'fetched' | 'pending' | 'ambiguous' | 'failed' | 'skipped' | 'planned';

/** Spec section 14: "three to five serious queries" per run. */
export const RECOMMENDED_MAX_SERIOUS_QUERIES = 5;

/** The cost plan plus the queue decision (live requests need a recorded justification). */
export interface ResearchCostPlan extends CostPlan {
  /** research.dataforseo.queue as configured. */
  queueRequested: 'standard' | 'live';
  /** research.dataforseo.liveQueueJustification when the live queue is used; null otherwise. */
  liveQueueJustification: string | null;
}

export interface QueueDecision {
  queue: 'standard' | 'live';
  requested: 'standard' | 'live';
  justification: string | null;
  warning: string | null;
}

/**
 * Live requests only when justified (spec section 14): paid requests use the
 * live queue only with a non-empty research.dataforseo.liveQueueJustification;
 * without one the standard queue is used and a warning explains why. Sandbox
 * and fixture requests are free, so the configured queue is used as is.
 */
export function resolveResearchQueue(ctx: Pick<AppContext, 'config'>, kind: 'SERP' | 'keyword volume' = 'SERP', opts: { isSandbox?: boolean } = {}): QueueDecision {
  const cfg = ctx.config.research.dataforseo as typeof ctx.config.research.dataforseo & { liveQueueJustification?: string | null };
  const requested = cfg.queue;
  if (requested !== 'live') return { queue: 'standard', requested, justification: null, warning: null };
  const justification = typeof cfg.liveQueueJustification === 'string' ? cfg.liveQueueJustification.trim() : '';
  if (!justification && opts.isSandbox) return { queue: 'live', requested, justification: null, warning: null };
  if (!justification) {
    return {
      queue: 'standard',
      requested,
      justification: null,
      warning: `research.dataforseo.queue is "live" but research.dataforseo.liveQueueJustification is empty: ${kind} requests use the standard queue (live requests cost more, about 3.3x for SERPs; they need a recorded justification).`,
    };
  }
  return { queue: 'live', requested, justification: justification.slice(0, 500), warning: null };
}

/** Record the queue decision of a research submission in the audit log (live queue: with its justification). */
export function auditResearchSubmission(ctx: AppContext, input: { kind: 'serp' | 'volume'; decision: QueueDecision; endpoint: string; items: number; purpose: string }): void {
  recordAudit(ctx.db, {
    siteId: ctx.siteId,
    actor: 'system',
    eventType: 'dataforseo.research_submitted',
    subjectType: 'dataforseo_research',
    subjectId: input.kind,
    details: {
      endpoint: input.endpoint,
      queue: input.decision.queue,
      queueRequested: input.decision.requested,
      liveQueueJustification: input.decision.justification,
      items: input.items,
      purpose: input.purpose,
      runId: ctx.runId,
    },
    at: ctx.clock.now(),
  });
}

export interface QueryOutcome {
  query: string;
  status: QueryStatus;
  action: PlanItem['action'];
  taskId: string | null;
  snapshotId: string | null;
  /** Point-in-time organic rank of the own site: number, null (not found within depth), undefined (unknown). */
  ownRank: number | null | undefined;
  competitorUrls: CompetitorUrl[];
  isSandbox: boolean;
  usableForRecommendations: boolean;
  estimateMicros: number | null;
  error?: Blocker;
}

/**
 * Overall research status: 'completed' (every query cached or fetched),
 * 'pending' (the rest still queued or ambiguous), 'partial' (some usable or
 * pending results and some failures/skips), 'failed' (no query was fetched,
 * cached or pending and at least one failed), 'skipped' (nothing was
 * attempted), 'planned' (dry run).
 */
export type ResearchRunStatus = 'completed' | 'partial' | 'pending' | 'skipped' | 'planned' | 'failed';

export interface SerpResearchResult {
  status: ResearchRunStatus;
  mode: DataForSeoMode | null;
  isSandbox: boolean;
  dryRun: boolean;
  settings: ResolvedSearchSettings | null;
  queries: QueryOutcome[];
  competitorUrls: CompetitorUrl[];
  plan: ResearchCostPlan | null;
  submissions: Array<Pick<SubmitOutcome, 'state' | 'providerRequestId' | 'reservationId' | 'estimatedMicros' | 'reservedMicros' | 'actualMicros'> & { error?: Blocker }>;
  blockers: Blocker[];
  warnings: string[];
}

function blockerOf(err: unknown): Blocker {
  if (isAppError(err)) return { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) };
  return { code: 'INTERNAL', message: errorMessage(err) };
}

/** DF4: send "%" as "%25" and "+" as "%2B" in the keyword field. */
export function encodeSerpKeyword(q: string): string {
  return q.replace(/%/g, '%25').replace(/\+/g, '%2B');
}

function displayQuery(q: string): string {
  return q.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Competitor pages per query: the requested count (or crawl.competitorPagesPerQuery
 * when absent or not a finite number), floored to an integer and clamped to
 * [0, crawl.competitorPagesPerQueryMax].
 */
export function competitorLimit(ctx: AppContext, requested?: number): number {
  const max = ctx.config.crawl.competitorPagesPerQueryMax;
  const n = requested !== undefined && Number.isFinite(requested) ? Math.floor(requested) : ctx.config.crawl.competitorPagesPerQuery;
  return Math.max(0, Math.min(n, max));
}

/**
 * Check or request an approval for a request whose price is unknown. Returns
 * the approval id when a valid approval exists for exactly this request and
 * this provisional budget hold. When no conservative hold can be formed
 * (`holdMicros: null`), no approval is requested: the request cannot run.
 */
export function unknownPriceApproval(
  ctx: AppContext,
  approvals: ApprovalGate | undefined,
  input: { endpoint: string; payloads: unknown[]; purpose: string; reason: string; holdMicros: number | null },
): { approvalId: string } | { pendingApprovalId: string | null; message: string } {
  if (input.holdMicros === null) {
    return { pendingApprovalId: null, message: `${input.reason} No conservative bound can be formed, so the request is skipped even with an approval.` };
  }
  if (!approvals) return { pendingApprovalId: null, message: `${input.reason} No approval gate is available, so the request is skipped.` };
  const artifactHash = hashObject({ endpoint: input.endpoint, payloads: input.payloads, holdMicros: input.holdMicros });
  const check = approvals.check({ siteId: ctx.siteId, actionType: 'paid_request', subjectType: 'dataforseo_request', subjectId: input.endpoint, artifactHash });
  if (check.ok) return { approvalId: check.approval.id };
  const rec = approvals.request({
    siteId: ctx.siteId,
    actionType: 'paid_request',
    target: `dataforseo:${input.endpoint}`,
    subjectType: 'dataforseo_request',
    subjectId: input.endpoint,
    artifactHash,
    summary: `DataForSEO ${input.endpoint} with UNKNOWN price (budget hold ${formatUsd(input.holdMicros)} until reconciled): ${input.purpose}`,
    payload: { payloads: input.payloads, reason: input.reason, holdMicros: input.holdMicros },
    requestedBy: 'system',
  });
  return { pendingApprovalId: rec.id, message: `${input.reason} Approval ${rec.id} is required before this exact request can run.` };
}

/** Sum of provisional holds for a group; null when any member has no bound. */
function provisionalTotal(items: Array<{ estimateMicros: number | null; provisionalMicros: number | null }>): number | null {
  let total = 0;
  for (const i of items) {
    const v = i.estimateMicros ?? i.provisionalMicros;
    if (v === null) return null;
    total += v;
  }
  return total;
}

interface Planned {
  query: string;
  action: PlanItem['action'];
  taskId: string | null;
  snapshotId: string | null;
  payload?: Record<string, unknown>;
  parameterHash?: string;
  estimateMicros: number | null;
  /** Conservative budget hold when the price is unknown (null when none can be formed). */
  provisionalMicros: number | null;
  item: PlanItem;
  error?: Blocker;
}

/**
 * Overall status from per-query statuses. 'failed' when nothing was fetched,
 * cached, pending or ambiguous and at least one query failed (every other
 * one was skipped): no request produced a result, so it is never 'partial'.
 */
export function overallResearchStatus(statuses: ReadonlyArray<QueryStatus | 'no_data' | 'invalid'>): ResearchRunStatus {
  if (!statuses.length) return 'skipped';
  const usable = (s: string) => s === 'cached' || s === 'fetched' || s === 'no_data';
  if (statuses.every(usable)) return 'completed';
  if (statuses.every((s) => s === 'skipped')) return 'skipped';
  if (statuses.every((s) => usable(s) || s === 'pending' || s === 'ambiguous')) return 'pending';
  if (statuses.every((s) => s === 'failed' || s === 'skipped')) return 'failed';
  return 'partial';
}

function overallStatus(outcomes: QueryOutcome[]): ResearchRunStatus {
  return overallResearchStatus(outcomes.map((o) => o.status));
}

/**
 * Next step for a provider or network failure (PROVIDER_ERROR, TIMEOUT,
 * INTEGRATION_UNAVAILABLE, ...): the free status check first. Failed tasks
 * are never resubmitted automatically.
 */
export const PROVIDER_FAILURE_HINT =
  'Check credentials and connectivity with `npm run cli -- research status --network` (free, never charged); `npm run cli -- research tasks --all` shows the provider message. Failed tasks are never resubmitted automatically; re-running the command sends a new, budgeted request.';

const PROVIDER_FAILURE_CODES = new Set(['PROVIDER_ERROR', 'TIMEOUT', 'INTEGRATION_UNAVAILABLE', 'RATE_LIMITED']);

/** Add the provider-failure next step to a blocker that has none (a hint already present, e.g. insufficient funds, is kept). */
export function withProviderFailureHint<T extends Blocker>(b: T): T {
  if (b.hint || !PROVIDER_FAILURE_CODES.has(b.code)) return b;
  return { ...b, hint: PROVIDER_FAILURE_HINT };
}

/** Targeted Google organic SERP research for explicit queries (cache -> open task -> budgeted submission). */
export async function researchSerps(ctx: AppContext, queries: string[], opts: SerpResearchOptions = {}): Promise<SerpResearchResult> {
  const dryRun = ctx.dryRun || !!opts.dryRun;
  const setup = inspectDataForSeoSetup(ctx, opts);
  const blockers: Blocker[] = setup.blockers.map((b) => ({ ...b }));
  const warnings: string[] = [...pricingOverrideWarnings(ctx.config)];
  const cfg = ctx.config.research.dataforseo;
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    const n = normalizeQuery(q);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    unique.push(displayQuery(q));
  }
  const skippedAll = (status: ResearchRunStatus, err?: Blocker): SerpResearchResult => ({
    status,
    mode: setup.mode,
    isSandbox: setup.isSandbox,
    dryRun,
    settings: null,
    queries: unique.map((q) => ({ query: q, status: 'skipped', action: 'skip', taskId: null, snapshotId: null, ownRank: undefined, competitorUrls: [], isSandbox: setup.isSandbox, usableForRecommendations: false, estimateMicros: null, ...(err ? { error: err } : {}) })),
    competitorUrls: [],
    plan: null,
    submissions: [],
    blockers,
    warnings,
  });
  if (!unique.length) {
    warnings.push('No queries to research.');
    return skippedAll('skipped');
  }
  if (setup.mode === null || (!dryRun && blockers.length)) return skippedAll('skipped', blockers[0]);

  let client: DataForSeoClient | null = opts.client ?? null;
  if (!client && blockers.length === 0) client = createDataForSeoClient(ctx, opts);
  const mode = setup.mode;
  const isSandbox = setup.isSandbox;

  let settings: ResolvedSearchSettings;
  try {
    settings = await resolveSearchSettings(ctx, client, { kind: 'serp', mode, allowNetwork: !dryRun && !!client, locationCode: opts.locationCode ?? null, device: opts.device ?? null });
  } catch (err) {
    blockers.push(blockerOf(err));
    return skippedAll('skipped', blockerOf(err));
  }
  warnings.push(...settings.warnings);

  const depth = cfg.serpDepth;
  const queueDecision = resolveResearchQueue(ctx, 'SERP', { isSandbox });
  if (queueDecision.warning) warnings.push(queueDecision.warning);
  const queue = queueDecision.queue;
  const now = ctx.clock.now();
  const planned: Planned[] = unique.map((q) => {
    const parameterHash = serpParameterHash({ keyword: q, locationCode: settings.locationCode, languageCode: settings.languageCode, device: settings.device, depth });
    const cacheKey = researchCacheKey({ siteId: ctx.siteId, endpoint: SERP_CACHE_ENDPOINT, locationCode: settings.locationCode, languageCode: settings.languageCode, device: settings.device, parameterHash, mode });
    const cached = getCached(ctx, cacheKey);
    const ref = cached ? parseDbRef(cached.payloadRef) : null;
    if (ref && ref.table === 'serp_snapshots') {
      const snap = ctx.db.get<{ id: string }>('SELECT id FROM serp_snapshots WHERE id = ? AND site_id = ?', [ref.id, ctx.siteId]);
      if (snap) return { query: q, action: 'cache_hit', taskId: null, snapshotId: snap.id, estimateMicros: 0, provisionalMicros: null, item: { label: q, kind: 'serp', action: 'cache_hit', estimateMicros: 0, basis: null } };
    }
    const open = findOpenTask(ctx, parameterHash, isSandbox);
    if (open) {
      return { query: q, action: 'reuse_open_task', taskId: open.id, snapshotId: null, estimateMicros: 0, provisionalMicros: null, item: { label: q, kind: 'serp', action: 'reuse_open_task', estimateMicros: 0, basis: null, taskId: open.id, reason: `existing ${open.status} task` } };
    }
    const est = estimateSerpTask(ctx.config, { keyword: q, depth, queue, sandbox: isSandbox }, now);
    const payload: Record<string, unknown> = { keyword: encodeSerpKeyword(q), location_code: settings.locationCode, language_code: settings.languageCode, device: settings.device, depth };
    return {
      query: q,
      action: 'submit',
      taskId: null,
      snapshotId: null,
      payload,
      parameterHash,
      estimateMicros: est.upperBoundMicros,
      provisionalMicros: est.provisionalMicros ?? null,
      item: { label: q, kind: 'serp', action: 'submit', estimateMicros: est.upperBoundMicros, basis: est.basis },
    };
  });
  const plan: ResearchCostPlan = { ...buildCostPlan(ctx, { mode, isSandbox, queue, items: planned.map((p) => p.item) }), queueRequested: queueDecision.requested, liveQueueJustification: queueDecision.justification };
  const limit = competitorLimit(ctx, opts.competitorPagesPerQuery);

  if (dryRun) {
    // Dry run: read-only (competitor pages are not registered).
    const outcomes: QueryOutcome[] = planned.map((p) => outcomeFor(ctx, p, isSandbox, limit, 'planned'));
    return { status: 'planned', mode, isSandbox, dryRun, settings, queries: outcomes, competitorUrls: outcomes.flatMap((o) => o.competitorUrls), plan, submissions: [], blockers, warnings };
  }

  // Resume existing tasks first (free GETs; reconciles ambiguous ones by tag).
  const openIds = planned.filter((p) => p.action === 'reuse_open_task').map((p) => p.taskId!);
  if (openIds.length && client) {
    const s = await pollPendingTasks(ctx, { ...opts, taskIds: openIds, clients: { [mode]: client } });
    warnings.push(...s.errors);
  }

  const submissions: SerpResearchResult['submissions'] = [];
  const toSubmit = planned.filter((p) => p.action === 'submit');
  if (toSubmit.length && client) {
    const gate = gateSubmission(ctx, { isSandbox, allowPaid: !!opts.allowPaid, verification: settings.verification });
    if (gate) {
      for (const p of toSubmit) p.error = gate;
    } else {
      const purpose = `SERP research: ${toSubmit.length} quer${toSubmit.length === 1 ? 'y' : 'ies'} (${settings.locationCode}/${settings.languageCode}/${settings.device})${queueDecision.justification ? `; live queue justified: ${queueDecision.justification}` : ''}`;
      const endpoint = queue === 'live' ? SERP_LIVE : SERP_TASK_POST;
      auditResearchSubmission(ctx, { kind: 'serp', decision: queueDecision, endpoint, items: toSubmit.length, purpose });
      const groups: Planned[][] = queue === 'live' ? toSubmit.map((p) => [p]) : chunk(toSubmit, 100);
      for (const group of groups) {
        const payloads = group.map((p) => p.payload!);
        const unknown = group.some((p) => p.estimateMicros === null);
        const hold = unknown ? provisionalTotal(group) : null;
        let unknownPriceApprovalId: string | undefined;
        if (unknown && !isSandbox) {
          const a = unknownPriceApproval(ctx, opts.approvals, { endpoint, payloads, purpose, holdMicros: hold, reason: `Price unknown: ${group.find((p) => p.estimateMicros === null)!.item.basis?.detail ?? 'no verified price'}.` });
          if (!('approvalId' in a)) {
            const b: Blocker = { code: 'BUDGET_UNKNOWN_PRICE', message: a.message, hint: 'Verify the price and set research.dataforseo.pricingOverrides, or approve this exact request.' };
            for (const p of group) p.error = b;
            submissions.push({ state: 'not_sent', providerRequestId: '', reservationId: null, estimatedMicros: null, reservedMicros: null, actualMicros: null, error: b });
            continue;
          }
          unknownPriceApprovalId = a.approvalId;
        }
        const total = unknown ? null : group.reduce((s, p) => s + (p.estimateMicros ?? 0), 0);
        const basis = group[0]!.item.basis ?? { source: 'unknown' as const, detail: 'no basis' };
        const meta = (p: Planned): TaskMeta => ({
          kind: 'serp',
          mode,
          queue,
          purpose,
          runId: ctx.runId,
          query: p.query,
          locationCode: settings.locationCode,
          languageCode: settings.languageCode,
          device: settings.device,
          depth,
          ...(opts.origin ? { origin: opts.origin } : {}),
        });
        try {
          const out = await submitPaidTasks(ctx, client, {
            endpointKey: endpoint,
            tasks: group.map((p) => ({ payload: p.payload!, meta: meta(p), parameterHash: p.parameterHash! })),
            estimate: {
              upperBoundMicros: total,
              basis: group.length > 1 && total !== null ? { ...basis, detail: `${group.length} tasks, total ${formatUsd(total)}; ${basis.detail}` } : basis,
              ...(unknown ? { provisionalMicros: hold } : {}),
            },
            purpose,
            allowPaid: !!opts.allowPaid,
            ...(unknownPriceApprovalId ? { unknownPriceApprovalId } : {}),
            ...(opts.approvals ? { approvals: opts.approvals } : {}),
          });
          group.forEach((p, i) => (p.taskId = out.tasks[i]?.localId ?? null));
          submissions.push({
            state: out.state,
            providerRequestId: out.providerRequestId,
            reservationId: out.reservationId,
            estimatedMicros: out.estimatedMicros,
            reservedMicros: out.reservedMicros,
            actualMicros: out.actualMicros,
            ...(out.error ? { error: out.error } : {}),
          });
          if (out.error) for (const p of group) if (!p.taskId) p.error = withProviderFailureHint(out.error);
          // A request that was not sent or was rejected: keep its error (code and next step) on each failed query.
          if (out.error && (out.state === 'not_sent' || out.state === 'rejected')) for (const p of group) p.error = withProviderFailureHint(out.error);
        } catch (err) {
          const b = withProviderFailureHint(blockerOf(err));
          for (const p of group) p.error = b;
          submissions.push({ state: 'not_sent', providerRequestId: '', reservationId: null, estimatedMicros: total, reservedMicros: null, actualMicros: null, error: b });
        }
      }
    }
  }

  // Optionally wait for standard-queue tasks (never resubmits on timeout).
  const waitIds = planned.map((p) => p.taskId).filter((id): id is string => !!id && ['queued', 'ready'].includes(getTask(ctx, id)?.status ?? ''));
  if (opts.waitMs && opts.waitMs > 0 && waitIds.length && client) {
    const w = await waitForTasks(ctx, waitIds, { ...opts, waitMs: opts.waitMs, clients: { [mode]: client }, ...(opts.pollIntervalMs ? { pollIntervalMs: opts.pollIntervalMs } : {}) });
    if (w.timedOut) warnings.push(`Local wait of ${Math.round(opts.waitMs / 1000)}s ended with tasks still queued; they are NOT resubmitted. Run \`research tasks --poll\` later.`);
  }

  const outcomes = planned.map((p) => outcomeFor(ctx, p, isSandbox, limit));
  if (isSandbox && !ctx.synthetic) warnings.push(`${mode.toUpperCase()} mode: results are synthetic, flagged is_sandbox = 1, and never used in real recommendations.`);
  return { status: overallStatus(outcomes), mode, isSandbox, dryRun, settings, queries: outcomes, competitorUrls: outcomes.flatMap((o) => o.competitorUrls), plan, submissions, blockers, warnings };
}

function gateSubmission(ctx: AppContext, input: { isSandbox: boolean; allowPaid: boolean; verification: ResolvedSearchSettings['verification'] }): Blocker | null {
  if (input.isSandbox) return null;
  if (!input.allowPaid) return { code: 'POLICY_DENIED', message: 'Paid DataForSEO requests need explicit authorization.', hint: 'CLI: add --allow-spend (the plan above shows the cost and caps).' };
  if (!modeAtLeast(ctx.mode, 'RESEARCH')) return { code: 'POLICY_DENIED', message: `Runtime mode ${ctx.mode} does not allow paid research requests.`, hint: 'Run with --mode RESEARCH.' };
  if (input.verification !== 'verified') return { code: 'DATA_UNAVAILABLE', message: 'Location/language could not be verified with the free lookup endpoints; paid research is skipped rather than guessing.', hint: 'Retry with network access, or check market.searchLocations.' };
  return null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function outcomeFor(ctx: AppContext, p: Planned, isSandbox: boolean, limit: number, forced?: 'planned'): QueryOutcome {
  const base = { query: p.query, action: p.action, taskId: p.taskId, estimateMicros: p.estimateMicros };
  let snapshotId = p.snapshotId;
  let status: QueryStatus;
  let error = p.error;
  let snapIsSandbox = isSandbox;
  if (snapshotId) status = 'cached';
  else if (p.taskId) {
    const row = getTask(ctx, p.taskId);
    const snap = row?.status === 'fetched' ? snapshotForTask(ctx, p.taskId) : undefined;
    if (snap) {
      snapshotId = snap.id;
      snapIsSandbox = snap.is_sandbox === 1;
      status = 'fetched';
    } else if (!row) status = 'failed';
    else if (row.status === 'ambiguous') status = 'ambiguous';
    else if (row.status === 'failed' || row.status === 'expired' || row.status === 'fetched') {
      status = 'failed';
      const detail = row.api_status_code ? ` (${row.api_status_code} ${row.api_status_message ?? ''})` : row.api_status_message ? `: ${row.api_status_message}` : '';
      error = withProviderFailureHint(error ?? { code: 'PROVIDER_ERROR', message: `task ${row.status}${detail}`.trim() });
    } else status = 'pending';
  } else status = error ? 'skipped' : (forced ?? 'skipped');
  if (forced && status !== 'cached') status = forced;
  const competitorUrls = snapshotId ? competitorUrlsForSnapshot(ctx, snapshotId, limit, { register: forced !== 'planned' }) : [];
  const ownRank = snapshotId ? ownRankForSnapshot(ctx, snapshotId) : undefined;
  return {
    ...base,
    status,
    snapshotId,
    ownRank,
    competitorUrls,
    isSandbox: snapIsSandbox,
    usableForRecommendations: !!snapshotId && (!snapIsSandbox || ctx.synthetic),
    ...(error ? { error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Default process: GSC shortlist -> local filtering -> serious queries -> SERP
// ---------------------------------------------------------------------------

export interface ShortlistCandidate {
  query: string;
  /** 'gsc' candidates must exist in this site's Search Console query data; 'owner' = explicitly provided by the owner. */
  origin?: 'gsc' | 'owner';
  /** Priority from the scoring module (higher first). */
  score?: number | null;
  impressions?: number | null;
  page?: string | null;
  opportunityId?: string | null;
}

export type FilterReason = 'empty' | 'too_long' | 'duplicate' | 'search_operators' | 'branded' | 'not_in_gsc' | 'owner_query_not_allowed' | 'over_limit';

export interface ShortlistOptions extends SerpResearchOptions {
  /** Lower the per-run limit (never raises research.seriousQueriesPerRun). */
  maxQueries?: number;
  includeBranded?: boolean;
  /** Allow owner-provided queries that are not in GSC data (CLI `research keyword`). */
  allowOwnerQueries?: boolean;
  /** Search operators multiply the charge by 5 (DF4); off by default. */
  allowSearchOperators?: boolean;
}

export interface ShortlistResearchResult extends SerpResearchResult {
  seriousLimit: number;
  selected: ShortlistCandidate[];
  filtered: Array<{ query: string; reason: FilterReason; detail?: string }>;
}

function inGsc(ctx: AppContext, query: string): boolean {
  const raw = displayQuery(query);
  const norm = normalizeQuery(query);
  const row = ctx.db.get<{ ok: number }>(
    `SELECT 1 AS ok FROM gsc_page_query_daily WHERE site_id = ? AND is_current = 1 AND query IN (?, ?) AND (is_synthetic = 0 OR ? = 1) LIMIT 1`,
    [ctx.siteId, raw, norm, ctx.synthetic ? 1 : 0],
  );
  return !!row;
}

/**
 * The default DataForSEO research process. Candidates come from the GSC
 * shortlist (router/scoring); they are filtered locally, capped at
 * research.seriousQueriesPerRun, researched with targeted SERP requests, and
 * the top competitor pages (crawl.competitorPagesPerQuery) are returned for
 * crawling.
 */
export async function researchShortlist(ctx: AppContext, candidates: Array<ShortlistCandidate | string>, opts: ShortlistOptions = {}): Promise<ShortlistResearchResult> {
  const filtered: ShortlistResearchResult['filtered'] = [];
  const kept: Array<{ c: ShortlistCandidate; index: number }> = [];
  const seen = new Set<string>();
  candidates.forEach((raw, index) => {
    const c: ShortlistCandidate = typeof raw === 'string' ? { query: raw, origin: 'gsc' } : { origin: 'gsc', ...raw };
    const q = normalizeQuery(c.query ?? '');
    if (!q) return filtered.push({ query: c.query ?? '', reason: 'empty' });
    if (q.length > 700) return filtered.push({ query: c.query, reason: 'too_long', detail: 'DataForSEO keywords are limited to 700 characters (DF4)' });
    if (seen.has(q)) return filtered.push({ query: c.query, reason: 'duplicate' });
    seen.add(q);
    if (hasSearchOperators(q) && !opts.allowSearchOperators) return filtered.push({ query: c.query, reason: 'search_operators', detail: 'search operators cost 5x (DF4)' });
    if (isBrandedQuery(ctx, q) === 1 && !opts.includeBranded) return filtered.push({ query: c.query, reason: 'branded' });
    if (c.origin === 'owner' && !opts.allowOwnerQueries) return filtered.push({ query: c.query, reason: 'owner_query_not_allowed' });
    if (c.origin !== 'owner' && !inGsc(ctx, c.query)) return filtered.push({ query: c.query, reason: 'not_in_gsc', detail: 'not found in current Search Console query data for this site' });
    kept.push({ c, index });
    return undefined;
  });
  kept.sort((a, b) => {
    const sa = a.c.score ?? Number.NEGATIVE_INFINITY;
    const sb = b.c.score ?? Number.NEGATIVE_INFINITY;
    if (sa !== sb) return sb - sa;
    const ia = a.c.impressions ?? Number.NEGATIVE_INFINITY;
    const ib = b.c.impressions ?? Number.NEGATIVE_INFINITY;
    if (ia !== ib) return ib - ia;
    return a.index - b.index;
  });
  const configured = ctx.config.research.seriousQueriesPerRun;
  const seriousLimit = Math.max(0, Math.min(configured, opts.maxQueries ?? configured));
  const limitWarning =
    configured > RECOMMENDED_MAX_SERIOUS_QUERIES
      ? `research.seriousQueriesPerRun is ${configured}: the research process recommends three to five serious queries per run; above ${RECOMMENDED_MAX_SERIOUS_QUERIES} the paid SERP research is no longer "selective" (lower it, or use --max-queries).`
      : null;
  const selected = kept.slice(0, seriousLimit).map((k) => k.c);
  for (const k of kept.slice(seriousLimit)) filtered.push({ query: k.c.query, reason: 'over_limit', detail: `research.seriousQueriesPerRun = ${seriousLimit}` });

  const result = await researchSerps(
    ctx,
    selected.map((s) => s.query),
    { ...opts, origin: opts.origin ?? (selected.every((s) => s.origin === 'owner') ? 'owner' : 'gsc_shortlist') },
  );
  if (limitWarning) result.warnings.unshift(limitWarning);
  if (!selected.length) result.warnings.push(seriousLimit === 0 ? 'research.seriousQueriesPerRun is 0: no SERP research is performed.' : 'No candidate passed local filtering.');
  return { ...result, seriousLimit, selected, filtered };
}

/**
 * Throw an honest error when research could not run at all because of a
 * setup-level blocker (disabled, missing credentials, offline, config).
 * Per-query outcomes (policy, budget, unknown price) are reported in the result.
 */
export function assertResearchRan(result: SerpResearchResult): void {
  if (result.status === 'skipped' && result.blockers[0]) {
    const b = result.blockers[0];
    throw new AppError(b.code as ConstructorParameters<typeof AppError>[0], b.message, b.hint ? { hint: b.hint } : {});
  }
}
