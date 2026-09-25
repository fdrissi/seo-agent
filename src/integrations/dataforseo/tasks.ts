import type { AppContext } from '../../app/context.js';
import type { ApprovalGate } from '../../approvals/types.js';
import { AppError, PolicyDeniedError, errorMessage, isAppError } from '../../core/errors.js';
import { newId } from '../../core/ids.js';
import { modeAtLeast } from '../../core/modes.js';
import { formatUsd, type Micros } from '../../core/money.js';
import { recordAudit } from '../../database/audit.js';
import { redact } from '../../security/redact.js';
import { createDataForSeoClient, transportOf, type DataForSeoClient, type DataForSeoClientOptions, type DataForSeoMode } from './client.js';
import { STANDARD_COMPANIONS } from './endpoints.js';
import { envelopeCost, isDefinitiveTaskFailure, mapStatusCode, taskOutcome, type DfsEnvelope, type DfsTask } from './envelope.js';
import { sandboxCostEstimate, type DfsCostEstimate } from './pricing.js';
import { storeSerpObservation, storeVolumeObservations, taskParams } from './store.js';
import { OPEN_TASK_STATUSES, type TaskMeta, type TaskRow, type TaskStatus } from './types.js';

/**
 * Paid task lifecycle (docs/ARCHITECTURE.md "Paid provider calls"):
 *
 *   cache (caller) -> estimate -> budgets.reserve -> requests.prepare
 *   -> approvals.consume (one-time, BEFORE sending; gated/unknown-price calls)
 *   -> dataforseo_tasks rows (status 'submitting') -> POST
 *   -> persist remote task ids IMMEDIATELY -> budgets.reconcile(task-level cost)
 *   -> tasks_ready / task_get polling (free) -> store results
 *
 * A paid POST is NEVER retried. A timeout or network error after sending
 * marks the tasks 'ambiguous' (reservation kept as 'unresolved'); they are
 * reconciled later by matching our tag (the local task id) in tasks_ready.
 * A local wait timeout while polling never resubmits: tasks stay 'queued'
 * and `pollPendingTasks` resumes them on the next run.
 *
 * Sandbox and fixture requests take the SAME path with a verified-zero
 * estimate (basis 'fixed_zero'): a $0 reservation (purpose labeled
 * [SYNTHETIC ...]) is made before sending and reconciled at an actual $0
 * afterwards (ledger usage flagged `synthetic: true`; the provider request is
 * is_synthetic = 1, is_paid = 0). A sandbox never charges, so even an
 * ambiguous sandbox submission is reconciled at $0; a request that was not
 * sent or was rejected releases its reservation.
 */

export interface SubmitTaskInput {
  payload: Record<string, unknown>;
  meta: TaskMeta;
  parameterHash: string;
}

export interface SubmitInput {
  endpointKey: string;
  tasks: SubmitTaskInput[];
  /**
   * Upper bound for the whole POST. When the price is unknown
   * (`upperBoundMicros: null`), `provisionalMicros` is the conservative amount
   * held for an approved request; without it the request is refused.
   */
  estimate: DfsCostEstimate;
  purpose: string;
  /** Explicit authorization for non-sandbox (chargeable) submissions. */
  allowPaid: boolean;
  /** Approval authorizing a request whose price is unknown (passed to budgets.reserve). */
  unknownPriceApprovalId?: string;
  /**
   * Approval consumed (one-time, atomically) BEFORE the request is sent
   * (defaults to unknownPriceApprovalId). If it cannot be consumed, nothing is sent.
   */
  approvalId?: string;
  approvals?: ApprovalGate;
  timeoutMs?: number;
}

export interface SubmittedTask {
  localId: string;
  remoteId: string | null;
  status: TaskStatus;
  apiStatusCode: number | null;
  apiStatusMessage: string | null;
  costMicros: Micros | null;
}

export interface SubmitOutcome {
  state: 'accepted' | 'rejected' | 'not_sent' | 'ambiguous';
  providerRequestId: string;
  reservationId: string | null;
  tasks: SubmittedTask[];
  estimatedMicros: Micros | null;
  /** Amount held in the budget reservation (the estimate, or the provisional hold of an approved unknown price); 0 for sandbox/fixture (verified-zero reservation). */
  reservedMicros: Micros | null;
  actualMicros: Micros | null;
  responseLevelMicros: Micros | null;
  rawRef: string | null;
  error?: { code: string; message: string; hint?: string };
}

export function getTask(ctx: AppContext, id: string): TaskRow | undefined {
  return ctx.db.get<TaskRow>('SELECT * FROM dataforseo_tasks WHERE id = ? AND site_id = ?', [id, ctx.siteId]);
}

/** An open (not terminal) task for the same parameters, so a paid task is never duplicated. */
export function findOpenTask(ctx: AppContext, parameterHash: string, isSandbox: boolean): TaskRow | undefined {
  return ctx.db.get<TaskRow>(
    `SELECT * FROM dataforseo_tasks WHERE site_id = ? AND parameter_hash = ? AND is_sandbox = ? AND status IN ('submitting', 'queued', 'ready', 'ambiguous')
     ORDER BY created_at DESC LIMIT 1`,
    [ctx.siteId, parameterHash, isSandbox ? 1 : 0],
  );
}

function setTask(ctx: AppContext, id: string, fields: Partial<Omit<TaskRow, 'id' | 'site_id'>>): void {
  const keys = Object.keys(fields) as Array<keyof typeof fields>;
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  ctx.db.run(`UPDATE dataforseo_tasks SET ${sets}, updated_at = ? WHERE id = ? AND site_id = ?`, [...keys.map((k) => fields[k] ?? null), ctx.clock.now().toISOString(), id, ctx.siteId]);
}

function errorInfo(err: unknown): { code: string; message: string; hint?: string } {
  if (isAppError(err)) return { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) };
  return { code: 'INTERNAL', message: errorMessage(err) };
}

/**
 * Submit paid tasks (standard task_post or live). Throws before anything is
 * sent when policy, budget, pricing, or the approval forbid it (POLICY_DENIED,
 * BUDGET_EXCEEDED, BUDGET_UNKNOWN_PRICE, APPROVAL_INVALID). After sending,
 * never throws for the provider outcome: the returned `state` says what
 * happened. An approval is consumed before the POST, so two concurrent calls
 * holding the same approval can never both send.
 */
export async function submitPaidTasks(ctx: AppContext, client: DataForSeoClient, input: SubmitInput): Promise<SubmitOutcome> {
  const spec = client.endpoint(input.endpointKey);
  if (spec.method !== 'POST' || !spec.paid) throw new AppError('POLICY_DENIED', `${input.endpointKey} is not a paid POST endpoint`);
  if (!input.tasks.length) throw new AppError('VALIDATION_FAILED', 'No tasks to submit');
  if (ctx.dryRun) throw new PolicyDeniedError('Dry run: no DataForSEO task is submitted.', { endpoint: input.endpointKey });
  const sandbox = client.isSandbox;
  if (!sandbox) {
    if (!input.allowPaid) {
      throw new PolicyDeniedError('Paid DataForSEO requests need explicit authorization (CLI: --allow-spend).', { endpoint: input.endpointKey });
    }
    if (!modeAtLeast(ctx.mode, 'RESEARCH')) {
      throw new PolicyDeniedError(`Runtime mode ${ctx.mode} does not allow paid research requests; use --mode RESEARCH.`, { endpoint: input.endpointKey, mode: ctx.mode });
    }
  }
  const isLive = spec.queue === 'live';
  if (isLive && input.tasks.length !== 1) throw new AppError('VALIDATION_FAILED', `${input.endpointKey}: live endpoints take exactly one task per call`);
  const approvalId = input.approvalId ?? input.unknownPriceApprovalId;
  if (approvalId && !input.approvals) throw new PolicyDeniedError(`Approval ${approvalId} cannot be consumed without an approval gate; nothing is sent.`, { endpoint: input.endpointKey });

  const deny = (err: unknown, heldMicros: Micros | null): never => {
    // Recorded outside the budget transaction so the denial survives its rollback.
    recordAudit(ctx.db, {
      siteId: ctx.siteId,
      actor: 'system',
      eventType: 'dataforseo.request_denied',
      subjectType: 'endpoint',
      subjectId: input.endpointKey,
      details: {
        purpose: input.purpose,
        code: isAppError(err) ? err.code : 'INTERNAL',
        message: errorMessage(err),
        estimateMicros: input.estimate.upperBoundMicros,
        holdMicros: heldMicros,
        details: isAppError(err) ? (err.details ?? null) : null,
      },
      at: ctx.clock.now(),
    });
    throw err;
  };

  // 1. Reserve BEFORE anything is persisted or sent. Sandbox/fixture requests reserve a verified-zero
  //    estimate (basis 'fixed_zero'; free per DF14 / answered in-process) through the same path.
  //    An approved unknown price still holds a conservative provisional bound, never $0.
  let reservation: ReturnType<AppContext['budgets']['reserve']> | null = null;
  let reserveEstimate: DfsCostEstimate = sandbox ? sandboxCostEstimate(client.mode === 'fixture' ? 'fixture' : 'sandbox') : input.estimate;
  const reservePurpose = sandbox ? `[SYNTHETIC ${client.mode}] ${input.purpose}` : input.purpose;
  if (!sandbox && input.estimate.upperBoundMicros === null && input.unknownPriceApprovalId) {
    const hold = input.estimate.provisionalMicros;
    if (hold === null || hold === undefined || !Number.isSafeInteger(hold) || hold < 0) {
      deny(
        new AppError('BUDGET_UNKNOWN_PRICE', `${input.endpointKey}: the price is unknown and no conservative bound can be formed, so even an approved request is not sent (${input.purpose}).`, {
          details: { basis: input.estimate.basis },
          hint: 'Verify the current price at https://dataforseo.com/pricing and set research.dataforseo.pricingOverrides for this price key.',
        }),
        null,
      );
    }
    reserveEstimate = { upperBoundMicros: hold!, basis: { ...input.estimate.basis, source: 'unknown', detail: `${input.estimate.basis.detail} [provisional hold ${formatUsd(hold!)}]` } };
  }
  try {
    reservation = ctx.budgets.reserve({
      siteId: ctx.siteId,
      provider: 'dataforseo',
      runId: ctx.runId,
      purpose: reservePurpose,
      estimate: reserveEstimate,
      ...(!sandbox && input.unknownPriceApprovalId ? { unknownPriceApprovalId: input.unknownPriceApprovalId } : {}),
    });
  } catch (err) {
    deny(err, reserveEstimate.upperBoundMicros);
  }
  /**
   * Sandbox/fixture: the verified-zero reservation is reconciled at an actual $0, flagged synthetic.
   * The reconcile source is 'computed_from_usage' only because the cost_basis CHECK (migration 0310)
   * has no separate value; `priceBasis: 'fixed_zero'` in the usage (and the reservation's fixed_zero
   * estimate basis) marks it as a FIXED ZERO, which the spend report (isFixedZeroAmount) and
   * `data export costs` (amount_basis 'fixed_zero') never count or label as computed at list price.
   */
  const reconcileSyntheticZero = (providerRequestId: string, outcome: string, extra: Record<string, unknown> = {}) => {
    if (!reservation) return;
    ctx.budgets.reconcile(reservation.id, {
      actualMicros: 0,
      source: 'computed_from_usage',
      usage: { synthetic: true, mode: client.mode, priceBasis: 'fixed_zero', detail: reserveEstimate.basis.detail, outcome, ...extra },
      providerRequestId,
    });
  };

  // 2. Local ids double as provider tags so ambiguous submissions can be found in tasks_ready.
  const now = ctx.clock.now().toISOString();
  const locals = input.tasks.map((t) => {
    const localId = newId('dfst');
    // Live endpoints do not document `tag`; unknown fields cause 40506, so it is only sent to task_post.
    const payload = isLive ? { ...t.payload } : { ...t.payload, tag: localId };
    return { localId, payload, meta: { ...t.meta, queue: isLive ? ('live' as const) : ('standard' as const) }, parameterHash: t.parameterHash };
  });
  const preq = ctx.requests.prepare({
    siteId: ctx.siteId,
    provider: 'dataforseo',
    endpoint: input.endpointKey,
    method: 'POST',
    isPaid: !sandbox,
    params: locals.map((l) => l.payload),
    reservationId: reservation?.id ?? null,
    idempotencyKey: locals[0]!.localId,
    isSynthetic: sandbox,
  });
  if (reservation) ctx.budgets.attachRequest(reservation.id, preq.id);

  // 2b. Consume the approval (one-time, atomic) BEFORE sending, so one approval can
  //     never authorize two executions. If it cannot be consumed, nothing is sent.
  if (approvalId && input.approvals) {
    try {
      input.approvals.consume(approvalId, { providerRequestId: preq.id, endpoint: input.endpointKey, actor: 'system' });
    } catch (err) {
      const reason = `approval ${approvalId} could not be consumed: ${errorMessage(err)}`;
      ctx.requests.complete(preq.id, { status: 'failed', error: { code: 'APPROVAL_INVALID', message: `not sent: ${reason}` } });
      if (reservation) ctx.budgets.release(reservation.id, `not sent: ${reason}`);
      recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType: 'dataforseo.approval_consume_failed', subjectType: 'provider_request', subjectId: preq.id, details: { endpoint: input.endpointKey, approvalId, reason: errorMessage(err) }, at: ctx.clock.now() });
      throw new AppError('APPROVAL_INVALID', `${input.endpointKey}: ${reason}; nothing was sent.`, {
        details: { endpoint: input.endpointKey, approvalId },
        hint: 'The approval was already used (or is no longer valid). Re-run to create a new approval request for this exact request.',
      });
    }
  }
  const approvalNotUsed = (why: string) => {
    if (!approvalId) return;
    // The approval is spent although no charge happened: record it so the owner knows a new approval is needed.
    recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType: 'dataforseo.approval_consumed_without_execution', subjectType: 'provider_request', subjectId: preq.id, details: { endpoint: input.endpointKey, approvalId, reason: why }, at: ctx.clock.now() });
  };
  const approvalHint = approvalId ? ` Approval ${approvalId} was consumed for this attempt; re-running creates a new approval request.` : '';

  ctx.db.transaction(() => {
    for (const l of locals) {
      ctx.db.run(
        `INSERT INTO dataforseo_tasks (id, site_id, provider_request_id, endpoint, remote_task_id, tag, parameter_hash, params_json, status, is_sandbox, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'submitting', ?, ?, ?)`,
        [l.localId, ctx.siteId, preq.id, input.endpointKey, isLive ? null : l.localId, l.parameterHash, JSON.stringify({ task: l.payload, meta: l.meta }), sandbox ? 1 : 0, now, now],
      );
    }
  });

  // 3. Send exactly once.
  ctx.requests.markSubmitted(preq.id);
  const submittedAt = ctx.clock.now().toISOString();
  for (const l of locals) setTask(ctx, l.localId, { submitted_at: submittedAt });
  const outcome = await transportOf(client).request(spec, { body: locals.map((l) => l.payload), ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) });

  const base = { providerRequestId: preq.id, reservationId: reservation?.id ?? null, estimatedMicros: input.estimate.upperBoundMicros, reservedMicros: reservation ? reservation.estimatedMicros : null };
  const withApprovalHint = (e: { code: string; message: string; hint?: string }) => (approvalHint ? { ...e, hint: `${e.hint ? `${e.hint} ` : ''}${approvalHint.trim()}` } : e);

  if (outcome.kind === 'not_sent') {
    ctx.db.transaction(() => {
      for (const l of locals) setTask(ctx, l.localId, { status: 'failed', api_status_message: `not sent: ${outcome.error.message}` });
    });
    ctx.requests.complete(preq.id, { status: 'failed', error: outcome.error.toJSON() });
    if (reservation) ctx.budgets.release(reservation.id, 'request was not sent');
    approvalNotUsed(`request not sent: ${outcome.error.message}`);
    return {
      ...base,
      state: 'not_sent',
      tasks: locals.map((l) => ({ localId: l.localId, remoteId: null, status: 'failed', apiStatusCode: null, apiStatusMessage: outcome.error.message, costMicros: null })),
      actualMicros: null,
      responseLevelMicros: null,
      rawRef: null,
      error: withApprovalHint(errorInfo(outcome.error)),
    };
  }

  if (outcome.kind === 'ambiguous') {
    const rawRef = outcome.envelope ? ctx.raw.save({ siteId: ctx.siteId, provider: 'dataforseo', kind: 'task-post-ambiguous', payload: outcome.envelope, at: ctx.clock.now() }) : null;
    ctx.db.transaction(() => {
      for (const l of locals) setTask(ctx, l.localId, { status: 'ambiguous', api_status_message: `outcome unknown: ${outcome.error.message}; never resubmitted automatically`, raw_ref: rawRef });
    });
    ctx.requests.complete(preq.id, { status: 'ambiguous', httpStatus: outcome.httpStatus, error: outcome.error.toJSON(), rawRef });
    // A sandbox/fixture request never charges, so its $0 is known even when the task outcome is not.
    if (sandbox) reconcileSyntheticZero(preq.id, 'ambiguous', { reason: outcome.error.message });
    else if (reservation) ctx.budgets.markUnresolved(reservation.id, `ambiguous DataForSEO submission: ${outcome.error.message}`);
    recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType: 'dataforseo.submission_ambiguous', subjectType: 'provider_request', subjectId: preq.id, details: { endpoint: input.endpointKey, tasks: locals.map((l) => l.localId), reason: outcome.error.message } });
    return { ...base, state: 'ambiguous', tasks: locals.map((l) => ({ localId: l.localId, remoteId: null, status: 'ambiguous', apiStatusCode: null, apiStatusMessage: outcome.error.message, costMicros: null })), actualMicros: sandbox ? 0 : null, responseLevelMicros: null, rawRef, error: errorInfo(outcome.error) };
  }

  if (outcome.kind === 'rejected') {
    const cost = outcome.envelope ? envelopeCost(outcome.envelope) : null;
    const rawRef = outcome.envelope ? ctx.raw.save({ siteId: ctx.siteId, provider: 'dataforseo', kind: 'task-post-rejected', payload: outcome.envelope, at: ctx.clock.now() }) : null;
    ctx.db.transaction(() => {
      for (const l of locals) setTask(ctx, l.localId, { status: 'failed', api_status_code: outcome.error.dfsStatusCode, api_status_message: outcome.error.message, raw_ref: rawRef });
    });
    ctx.requests.complete(preq.id, { status: 'failed', httpStatus: outcome.httpStatus, error: outcome.error.toJSON(), rawRef });
    if (reservation) {
      if (sandbox) ctx.budgets.release(reservation.id, `synthetic ${client.mode} request rejected (${outcome.error.dfsStatusCode ?? `HTTP ${outcome.httpStatus}`}); nothing charged`);
      else if (cost && cost.actualMicros !== null) ctx.budgets.reconcile(reservation.id, { actualMicros: cost.actualMicros, source: 'provider_reported', usage: { basis: cost.basis, rejected: true }, providerRequestId: preq.id });
      else ctx.budgets.release(reservation.id, `request rejected by provider (${outcome.error.dfsStatusCode ?? `HTTP ${outcome.httpStatus}`})`);
    }
    if (!cost || !cost.actualMicros) approvalNotUsed(`request rejected by the provider without a charge (${outcome.error.dfsStatusCode ?? `HTTP ${outcome.httpStatus}`})`);
    return {
      ...base,
      state: 'rejected',
      tasks: locals.map((l) => ({ localId: l.localId, remoteId: null, status: 'failed', apiStatusCode: outcome.error.dfsStatusCode, apiStatusMessage: outcome.error.message, costMicros: null })),
      actualMicros: cost?.actualMicros ?? null,
      responseLevelMicros: cost?.responseLevelMicros ?? null,
      rawRef,
      error: withApprovalHint(errorInfo(outcome.error)),
    };
  }

  // Accepted (HTTP 200, response-level 20000). Persist remote ids FIRST.
  const env = outcome.envelope;
  const cost = envelopeCost(env);
  const matched = locals.map((l, i) => {
    const byTag = env.tasks.find((t) => t.data && t.data.tag === l.localId);
    const t = byTag ?? (env.tasks.length === locals.length ? env.tasks[i] : undefined);
    return { l, t, costMicros: t ? (cost.perTaskMicros[env.tasks.indexOf(t)] ?? null) : null };
  });
  const results: SubmittedTask[] = [];
  const at = ctx.clock.now().toISOString();
  ctx.db.transaction(() => {
    for (const { l, t, costMicros } of matched) {
      if (!t) {
        setTask(ctx, l.localId, { status: 'ambiguous', api_status_message: 'task missing from the provider response; never resubmitted automatically' });
        results.push({ localId: l.localId, remoteId: null, status: 'ambiguous', apiStatusCode: null, apiStatusMessage: 'missing from response', costMicros: null });
        continue;
      }
      const o = taskOutcome(t.status_code);
      let status: TaskStatus;
      if (o === 'created' || o === 'pending') status = 'queued';
      else if (isLive && (o === 'ok' || o === 'no_results' || o === 'partial')) status = 'ready';
      else if (o === 'ok') status = 'queued';
      else status = 'failed';
      setTask(ctx, l.localId, {
        status,
        remote_task_id: t.id || null,
        api_status_code: t.status_code,
        api_status_message: t.status_message,
        cost_usd_micros: costMicros,
        ...(status === 'ready' ? { ready_at: at } : {}),
      });
      results.push({ localId: l.localId, remoteId: t.id || null, status, apiStatusCode: t.status_code, apiStatusMessage: t.status_message, costMicros });
    }
  });
  const rawRef = ctx.raw.save({ siteId: ctx.siteId, provider: 'dataforseo', kind: isLive ? 'live' : 'task-post', payload: env, at: ctx.clock.now() });
  const anyMissing = matched.some((m) => !m.t);
  // Task-level costs only; the response-level total is recorded for audit, never added.
  // Sandbox/fixture: $0 actual (whatever sample cost the synthetic response shows is kept for audit only).
  const actualMicros = sandbox ? 0 : anyMissing ? null : cost.actualMicros;
  if (sandbox) {
    reconcileSyntheticZero(preq.id, anyMissing ? 'accepted_incomplete_response' : 'accepted', { reportedTaskCostsMicros: cost.perTaskMicros, reportedResponseLevelMicros: cost.responseLevelMicros, tasks: results.length });
  } else if (reservation) {
    ctx.budgets.reconcile(reservation.id, {
      actualMicros,
      source: 'provider_reported',
      usage: { basis: anyMissing ? 'incomplete_response' : cost.basis, taskCostsMicros: cost.perTaskMicros, responseLevelMicros: cost.responseLevelMicros, tasks: results.length },
      providerRequestId: preq.id,
    });
  }
  ctx.requests.complete(preq.id, { status: 'succeeded', httpStatus: outcome.httpStatus, rawRef, externalId: results.find((r) => r.remoteId)?.remoteId ?? null });

  // Live results arrive in the POST response: store them now (they cannot be re-fetched, DF38).
  if (isLive) {
    for (const { l, t } of matched) {
      const row = getTask(ctx, l.localId);
      if (t && row && row.status === 'ready') {
        setTask(ctx, l.localId, { raw_ref: rawRef });
        processFetchedTask(ctx, { ...row, raw_ref: rawRef }, t, rawRef);
        const r = results.find((x) => x.localId === l.localId);
        if (r) r.status = 'fetched';
      }
    }
  }
  return { ...base, state: 'accepted', tasks: results, actualMicros, responseLevelMicros: cost.responseLevelMicros, rawRef };
}

/**
 * Store a completed task's result and mark it fetched, in ONE transaction: a
 * crash can no longer leave a stored observation on a task that is still
 * 'ready' (which a later poll would store again). Does NOT touch budgets
 * (retrieval is free).
 */
export function processFetchedTask(ctx: AppContext, row: TaskRow, task: DfsTask, rawRef: string): { snapshotId?: string; metricIds?: string[] } {
  const { meta } = taskParams(row);
  const o = taskOutcome(task.status_code);
  return ctx.db.transaction(() => {
    let out: { snapshotId?: string; metricIds?: string[] } = {};
    if (meta.kind === 'serp') {
      const s = storeSerpObservation(ctx, { taskRow: row, meta, task, rawRef, partial: o === 'partial', noResults: o === 'no_results' });
      out = { snapshotId: s.snapshotId };
    } else if (meta.kind === 'volume') {
      const v = storeVolumeObservations(ctx, { taskRow: row, meta, task, rawRef });
      out = { metricIds: v.map((x) => x.metricId) };
    }
    // Keep the POST-time task cost; record the retrieval status (e.g. 20000 / 40102 / 40106).
    setTask(ctx, row.id, {
      status: 'fetched',
      fetched_at: ctx.clock.now().toISOString(),
      raw_ref: rawRef,
      api_status_code: task.status_code,
      api_status_message: task.status_message,
      ...(row.status !== 'ready' ? { ready_at: ctx.clock.now().toISOString() } : {}),
    });
    return out;
  });
}

export interface PollOptions extends DataForSeoClientOptions {
  /** Restrict polling to these local task ids. */
  taskIds?: string[];
  /** Pre-built clients per mode (tests/demo). */
  clients?: Partial<Record<DataForSeoMode, DataForSeoClient>>;
  /** Call task_get directly for queued tasks not yet listed in tasks_ready after this age (live host). */
  directGetAfterMs?: number;
  /** 'submitting' rows older than this are treated as ambiguous (a crash may have happened mid-POST). */
  staleSubmittingMs?: number;
}

export interface PollSummary {
  checked: number;
  fetched: string[];
  pending: string[];
  ambiguous: string[];
  reconciled: string[];
  expired: string[];
  failed: string[];
  skipped: Array<{ taskId: string; reason: string }>;
  errors: string[];
}

const THREE_DAYS_MS = 3 * 86_400_000;
/** Standard-queue results can be fetched for 30 days (DF6, DF7, DF38). */
const RETRIEVAL_WINDOW_DAYS = 30;
const RETRIEVAL_WINDOW_MS = RETRIEVAL_WINDOW_DAYS * 86_400_000;

function ageMs(ctx: AppContext, iso: string | null): number {
  return iso ? ctx.clock.now().getTime() - Date.parse(iso) : Number.POSITIVE_INFINITY;
}

/**
 * Resume pending tasks (free GETs only; nothing is ever resubmitted):
 * stale 'submitting' rows become 'ambiguous'; ambiguous standard tasks are
 * reconciled by matching their tag in tasks_ready; queued tasks listed in
 * tasks_ready (or old enough) are fetched with task_get and stored.
 */
export async function pollPendingTasks(ctx: AppContext, opts: PollOptions = {}): Promise<PollSummary> {
  const summary: PollSummary = { checked: 0, fetched: [], pending: [], ambiguous: [], reconciled: [], expired: [], failed: [], skipped: [], errors: [] };
  const staleMs = opts.staleSubmittingMs ?? 15 * 60_000;
  const filter = opts.taskIds ? new Set(opts.taskIds) : null;

  // Crash recovery: a row still 'submitting' long after creation may have been sent.
  for (const row of ctx.db.all<TaskRow>(`SELECT * FROM dataforseo_tasks WHERE site_id = ? AND status = 'submitting'`, [ctx.siteId])) {
    if (filter && !filter.has(row.id)) continue;
    if (ageMs(ctx, row.created_at) < staleMs) continue;
    setTask(ctx, row.id, { status: 'ambiguous', api_status_message: 'interrupted during submission; outcome unknown; never resubmitted automatically' });
    if (row.provider_request_id) {
      const pr = ctx.requests.get(row.provider_request_id);
      if (pr && (pr.status === 'prepared' || pr.status === 'submitted')) ctx.requests.complete(pr.id, { status: 'ambiguous', error: { message: 'interrupted during submission' } });
      if (pr?.reservation_id) ctx.budgets.markUnresolved(pr.reservation_id, 'interrupted DataForSEO submission (ambiguous)');
    }
  }

  const rows = ctx.db
    .all<TaskRow>(`SELECT * FROM dataforseo_tasks WHERE site_id = ? AND status IN ('queued', 'ready', 'ambiguous') ORDER BY created_at`, [ctx.siteId])
    .filter((r) => !filter || filter.has(r.id));
  summary.checked = rows.length;
  if (!rows.length) return summary;

  const byMode = new Map<DataForSeoMode, TaskRow[]>();
  for (const r of rows) {
    const mode = taskParams(r).meta.mode;
    byMode.set(mode, [...(byMode.get(mode) ?? []), r]);
  }

  for (const [mode, modeRows] of byMode) {
    let client = opts.clients?.[mode];
    if (!client) {
      try {
        client = createDataForSeoClient(ctx, { ...opts, mode, forPolling: true });
      } catch (err) {
        for (const r of modeRows) summary.skipped.push({ taskId: r.id, reason: `${mode} client unavailable: ${errorMessage(err)}` });
        continue;
      }
    }
    const directAfter = opts.directGetAfterMs ?? (client.isSandbox ? 0 : 10 * 60_000);

    // Live tasks: results were in the POST response. 'ready' without 'fetched' means a crash
    // between saving and storing: re-process from the saved raw response.
    for (const r of modeRows.filter((x) => !STANDARD_COMPANIONS[x.endpoint])) {
      if (r.status === 'ready' && r.raw_ref) {
        const env = ctx.raw.load<DfsEnvelope>(r.raw_ref);
        const t = env?.tasks?.find((x) => x.id === r.remote_task_id) ?? env?.tasks?.[0];
        if (t) {
          processFetchedTask(ctx, r, t, r.raw_ref);
          summary.fetched.push(r.id);
          continue;
        }
      }
      if (r.status === 'ambiguous') summary.ambiguous.push(r.id);
      else summary.skipped.push({ taskId: r.id, reason: 'live task without a stored response' });
    }

    const byEndpoint = new Map<string, TaskRow[]>();
    for (const r of modeRows.filter((x) => STANDARD_COMPANIONS[x.endpoint])) byEndpoint.set(r.endpoint, [...(byEndpoint.get(r.endpoint) ?? []), r]);

    for (const [endpoint, eRows] of byEndpoint) {
      const companions = STANDARD_COMPANIONS[endpoint]!;
      let readyIds: Set<string> | null = null;
      let readyByTag = new Map<string, string>();
      try {
        const { envelope } = await client.getFree<{ id?: unknown; tag?: unknown }>(companions.tasksReady);
        readyIds = new Set();
        for (const t of envelope.tasks) {
          for (const item of t.result ?? []) {
            if (item && typeof item.id === 'string') {
              readyIds.add(item.id);
              if (typeof item.tag === 'string' && item.tag) readyByTag.set(item.tag, item.id);
            }
          }
        }
      } catch (err) {
        summary.errors.push(`tasks_ready (${endpoint}): ${errorMessage(err)}`);
        readyByTag = new Map();
      }

      for (const r of eRows) {
        let row = r;
        if (row.status === 'ambiguous') {
          const remote = readyByTag.get(row.id);
          if (!remote) {
            if (ageMs(ctx, row.submitted_at ?? row.created_at) > THREE_DAYS_MS + 86_400_000 && !(row.api_status_message ?? '').includes('not found in tasks_ready')) {
              setTask(ctx, row.id, { api_status_message: `${row.api_status_message ?? ''} | not found in tasks_ready within its 3-day window: probably not accepted, but a charge cannot be ruled out (check the DataForSEO dashboard)`.trim() });
            }
            summary.ambiguous.push(row.id);
            continue;
          }
          setTask(ctx, row.id, { status: 'ready', remote_task_id: remote, ready_at: ctx.clock.now().toISOString(), api_status_message: 'reconciled: found in tasks_ready by tag (charge not reported; reservation stays unresolved)' });
          reconcileRequestIfComplete(ctx, row.provider_request_id);
          recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType: 'dataforseo.ambiguous_reconciled', subjectType: 'dataforseo_task', subjectId: row.id, details: { remoteTaskId: remote } });
          summary.reconciled.push(row.id);
          row = getTask(ctx, row.id)!;
        } else if (row.status === 'queued' && row.remote_task_id && readyIds?.has(row.remote_task_id)) {
          setTask(ctx, row.id, { status: 'ready', ready_at: ctx.clock.now().toISOString() });
          row = getTask(ctx, row.id)!;
        }

        const shouldGet = row.remote_task_id && (row.status === 'ready' || (row.status === 'queued' && (readyIds === null || ageMs(ctx, row.submitted_at) >= directAfter)));
        if (!shouldGet) {
          summary.pending.push(row.id);
          continue;
        }
        try {
          const { envelope } = await client.getFree<unknown>(companions.taskGet, { id: row.remote_task_id! }, { externalId: row.remote_task_id!, taskStatus: 'caller' });
          const t = envelope.tasks.find((x) => x.id === row.remote_task_id) ?? envelope.tasks[0];
          if (!t) {
            summary.pending.push(row.id);
            continue;
          }
          const o = taskOutcome(t.status_code);
          if (o === 'ok' || o === 'no_results' || o === 'partial') {
            const rawRef = ctx.raw.save({ siteId: ctx.siteId, provider: 'dataforseo', kind: 'task-get', payload: envelope, at: ctx.clock.now() });
            processFetchedTask(ctx, row, t, rawRef);
            summary.fetched.push(row.id);
          } else if (o === 'pending' || (o === 'not_found' && ageMs(ctx, row.submitted_at) < THREE_DAYS_MS)) {
            summary.pending.push(row.id);
          } else if (o === 'expired') {
            setTask(ctx, row.id, { status: 'expired', api_status_code: t.status_code, api_status_message: t.status_message });
            summary.expired.push(row.id);
          } else if (!isDefinitiveTaskFailure(t.status_code) && ageMs(ctx, row.submitted_at ?? row.created_at) < RETRIEVAL_WINDOW_MS) {
            // Transient (5xxxx, rate limit, account-level, undocumented) error on an already-paid
            // task: keep it open so it is fetched (free) on a later poll and never paid for twice.
            const kind = mapStatusCode(t.status_code).kind;
            summary.pending.push(row.id);
            summary.errors.push(`task_get ${row.id}: task-level ${t.status_code} ${t.status_message} (${kind}); the task stays ${row.status} and is retried on the next poll, never resubmitted`);
          } else {
            const why = isDefinitiveTaskFailure(t.status_code) ? t.status_message : `${t.status_message} (still failing after the ${RETRIEVAL_WINDOW_DAYS}-day retrieval window)`;
            setTask(ctx, row.id, { status: 'failed', api_status_code: t.status_code, api_status_message: why });
            summary.failed.push(row.id);
          }
        } catch (err) {
          summary.errors.push(`task_get ${row.id}: ${errorMessage(err)}`);
          summary.pending.push(row.id);
        }
      }
    }
  }
  return summary;
}

/** When every task of an ambiguous request has been found, mark the request reconciled (the charge stays unresolved). */
function reconcileRequestIfComplete(ctx: AppContext, providerRequestId: string | null): void {
  if (!providerRequestId) return;
  const open = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM dataforseo_tasks WHERE site_id = ? AND provider_request_id = ? AND status = 'ambiguous'`, [ctx.siteId, providerRequestId]);
  if ((open?.n ?? 0) > 0) return;
  const first = ctx.db.get<{ remote_task_id: string | null }>('SELECT remote_task_id FROM dataforseo_tasks WHERE site_id = ? AND provider_request_id = ? AND remote_task_id IS NOT NULL LIMIT 1', [ctx.siteId, providerRequestId]);
  ctx.requests.complete(providerRequestId, { status: 'reconciled', externalId: first?.remote_task_id ?? null });
}

/**
 * Wait for tasks by polling (free GETs) until they are terminal or `waitMs`
 * elapses. A local wait timeout NEVER resubmits: unfinished tasks stay queued
 * for the next run.
 */
export async function waitForTasks(
  ctx: AppContext,
  taskIds: string[],
  opts: PollOptions & { waitMs: number; pollIntervalMs?: number },
): Promise<{ polls: number; timedOut: boolean; last: PollSummary | null }> {
  if (!taskIds.length || opts.waitMs <= 0) return { polls: 0, timedOut: false, last: null };
  const deadline = ctx.clock.now().getTime() + opts.waitMs;
  const interval = Math.max(3_000, opts.pollIntervalMs ?? 30_000);
  const sleepFn = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let polls = 0;
  let last: PollSummary | null = null;
  while (true) {
    last = await pollPendingTasks(ctx, { ...opts, taskIds });
    polls++;
    const open = taskIds.filter((id) => {
      const s = getTask(ctx, id)?.status;
      return s === 'queued' || s === 'ready' || s === 'submitting';
    });
    if (!open.length) return { polls, timedOut: false, last };
    if (ctx.clock.now().getTime() + interval > deadline) return { polls, timedOut: true, last };
    await sleepFn(interval);
  }
}

export interface TaskListing {
  id: string;
  kind: string;
  mode: string;
  queue: string;
  label: string;
  status: TaskStatus;
  remoteTaskId: string | null;
  endpoint: string;
  apiStatusCode: number | null;
  apiStatusMessage: string | null;
  costMicros: Micros | null;
  isSandbox: boolean;
  createdAt: string;
  submittedAt: string | null;
  ageHours: number;
}

export function listTasks(ctx: AppContext, opts: { statuses?: readonly TaskStatus[]; limit?: number } = {}): TaskListing[] {
  const statuses = opts.statuses ?? OPEN_TASK_STATUSES;
  const placeholders = statuses.map(() => '?').join(', ');
  const rows = ctx.db.all<TaskRow>(`SELECT * FROM dataforseo_tasks WHERE site_id = ? AND status IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`, [ctx.siteId, ...statuses, opts.limit ?? 100]);
  return rows.map((r) => {
    const { meta } = taskParams(r);
    return {
      id: r.id,
      kind: meta.kind,
      mode: meta.mode,
      queue: meta.queue,
      label: meta.query ?? (meta.keywords ? `${meta.keywords.length} keyword(s): ${meta.keywords.slice(0, 3).join(', ')}${meta.keywords.length > 3 ? ', ...' : ''}` : meta.purpose),
      status: r.status,
      remoteTaskId: r.remote_task_id,
      endpoint: r.endpoint,
      apiStatusCode: r.api_status_code,
      apiStatusMessage: r.api_status_message,
      costMicros: r.cost_usd_micros,
      isSandbox: r.is_sandbox === 1,
      createdAt: r.created_at,
      submittedAt: r.submitted_at,
      ageHours: Math.round((ageMs(ctx, r.created_at) / 3_600_000) * 10) / 10,
    };
  });
}

/**
 * Owner action for an ambiguous task that could not be reconciled: mark it
 * failed so the same parameters may be researched again. The budget
 * reservation stays UNRESOLVED (a charge may have happened); it is never
 * released or set to $0 here.
 */
export function abandonAmbiguousTask(ctx: AppContext, taskId: string, actor = 'cli'): TaskRow {
  const row = getTask(ctx, taskId);
  if (!row) throw new AppError('NOT_FOUND', `DataForSEO task ${taskId} not found for site ${ctx.siteId}`);
  if (row.status !== 'ambiguous') throw new AppError('CONFLICT', `Only ambiguous tasks can be abandoned (task ${taskId} is ${row.status}).`);
  setTask(ctx, taskId, { status: 'failed', api_status_message: `${row.api_status_message ?? ''} | abandoned by owner; any charge stays reserved as unresolved`.trim() });
  recordAudit(ctx.db, { siteId: ctx.siteId, actor, eventType: 'dataforseo.ambiguous_abandoned', subjectType: 'dataforseo_task', subjectId: taskId, details: redact({ endpoint: row.endpoint }) });
  return getTask(ctx, taskId)!;
}
