import type { AppContext } from '../../app/context.js';
import type { PriceBasis } from '../../budgets/types.js';
import { sleep as coreSleep } from '../../core/concurrency.js';
import { AppError, BudgetExceededError, isAppError } from '../../core/errors.js';
import { hashObject } from '../../core/hash.js';
import { newId } from '../../core/ids.js';
import { modeAtLeast } from '../../core/modes.js';
import { formatUsd, toMicros, type Micros } from '../../core/money.js';
import { recordAudit } from '../../database/audit.js';
import { redactString } from '../../security/redact.js';
import { ApifyApiError, ApifyTransportError, createApifyClient, type ApifyClient } from './client.js';
import { inputSchemaHash, parseInputSchema } from './input-schema.js';
import {
  DATASET_FIELDS,
  heuristicClassify,
  normalizeDatasetItems,
  persistSignals,
  type NormalizedRedditItem,
  type PersistSignalsResult,
  type SignalClassifier,
} from './normalize.js';
import {
  chargeFromEventCounts,
  chargeRangeFromEventCounts,
  estimateRunCost,
  eventCountsInconsistency,
  microsToUsdParam,
  reportedUsageInconsistency,
  usdToMicros,
  type EstimateLine,
  type EstimateTerms,
  type ObservedActivity,
  type PricingRecord,
} from './pricing.js';
import {
  buildRedditInput,
  collectSensitiveValues,
  scanInputForSecrets,
  REDDIT_SCRAPER_ACTOR_ID,
  type ForcedField,
  type RedditSort,
  type RedditTimeRange,
} from './reddit-adapter.js';
import {
  latestPricingSnapshot,
  loggedRead,
  pricingFromSnapshot,
  pricingSnapshotFromActor,
  resolveRunnableSchema,
  type StoredActorSchema,
  type StoredPricingSnapshot,
} from './schema.js';
import { isTerminalStatus, type ApifyRun } from './types.js';

/**
 * Paid Apify runs for content research (spec sections 15, 20, 25).
 *
 * Paid-call sequence: reuse a completed identical run or resume an in-flight
 * one -> verify the pinned build (free read) -> refresh pricing (free read)
 * -> conservative estimate -> atomic budget reservation + provider-request
 * row + apify_runs row BEFORE the POST -> POST with provider-side caps ->
 * persist the run id immediately -> poll with backoff -> fetch the dataset
 * with pagination -> normalize or quarantine -> reconcile provider-reported
 * usage (unknown stays unresolved, never $0).
 *
 * The run POST is never retried. A timeout/network error/5xx after sending is
 * an AMBIGUOUS submission: the reservation stays held and the submission is
 * reconciled against the provider's run history.
 */

export const START_ENDPOINT = 'apify.actor.runs.start';

export interface ApifyRuntimeOptions {
  sleep?: (ms: number) => Promise<void>;
  /** waitForFinish seconds per poll (0..60). */
  pollWaitSecs?: number;
  /** Local grace beyond the run timeout before a poll session returns "running". */
  pollGraceSecs?: number;
  /** Hard cap on polls in one session. */
  maxPolls?: number;
  /** Delay before re-reading a finished run for stable usage figures (contract: ~10 s). */
  stableUsageDelayMs?: number;
  /** How long an ambiguous submission may stay unmatched before provider history is trusted. */
  reconcileGraceMs?: number;
  /** A 'submitting' row older than this belongs to a stopped process. */
  staleSubmittingMs?: number;
  datasetPageSize?: number;
  /** Stored pricing older than this is not used when the live read fails. */
  maxPricingAgeHours?: number;
}

const RT_DEFAULTS: Required<Omit<ApifyRuntimeOptions, 'sleep' | 'maxPolls'>> = {
  pollWaitSecs: 60,
  pollGraceSecs: 180,
  stableUsageDelayMs: 10_000,
  reconcileGraceMs: 30 * 60_000,
  staleSubmittingMs: 2 * 60_000,
  datasetPageSize: 1000,
  maxPricingAgeHours: 168,
};

type Rt = Required<Omit<ApifyRuntimeOptions, 'maxPolls'>> & { maxPolls?: number };
function rtOf(o: ApifyRuntimeOptions | undefined): Rt {
  return { ...RT_DEFAULTS, sleep: (ms) => coreSleep(ms), ...(o ?? {}) } as Rt;
}

export interface ContentResearchOptions {
  /** Defaults to research.seedTopics from site config. Never hardcoded. */
  searchTerms?: string[];
  withinCommunity?: string | null;
  sort?: RedditSort;
  timeRange?: RedditTimeRange;
  postedAfter?: string | null;
  postedBefore?: string | null;
  /** Lower-only overrides of research.apify.* limits. */
  maxItems?: number;
  maxCommentsPerPost?: number;
  maxRunSeconds?: number;
  maxTotalChargeUsdMicros?: Micros;
  extraInput?: Record<string, unknown>;
  purpose?: string;
  /**
   * Explicit owner confirmation for this paid run (CLI --confirm-spend). It is
   * recorded, but it is a SECOND requirement, never a substitute: paid runs
   * always need runtime mode RESEARCH (policy `external_research`).
   */
  explicitSpendConfirmation?: boolean;
  /** Poll until finished (default true). False returns after the run id is persisted. */
  waitForCompletion?: boolean;
  /** Reuse an identical completed run within this many hours (default 168; 0 disables). */
  reuseCompletedWithinHours?: number;
  /** Re-verify the pinned build's schema hash with a free read before paying (default true). */
  verifyBuildOnline?: boolean;
  classifier?: SignalClassifier;
  client?: ApifyClient;
  runtime?: ApifyRuntimeOptions;
  /**
   * What to do when the conservative estimate exceeds the charge cap:
   * - 'fit' (default): lower the comment/post bounds until the estimate fits
   *   under the cap (reported as a warning), so the cap cannot truncate the run;
   * - 'refuse': reject the run;
   * - 'accept_truncation': keep the bounds; a run stopped by the cap is
   *   quarantined as partial (never complete research).
   */
  capPolicy?: CapPolicy;
  /**
   * Bind the paid submission to a plan the owner already saw: the provider cap
   * may not exceed `capMicros` and the input must hash to `inputHash`;
   * otherwise nothing is sent and `confirmation_required` is returned.
   */
  expectedPlan?: { capMicros: Micros; inputHash: string };
}

export type CapPolicy = 'fit' | 'refuse' | 'accept_truncation';

/** Reddit time ranges from narrowest to broadest. */
export const TIME_RANGE_ORDER: readonly RedditTimeRange[] = ['hour', 'day', 'week', 'month', 'year', 'all'];

/** Earliest UTC date (YYYY-MM-DD) inside `range` ending at `now`; null for 'all' (unbounded). */
export function earliestDateFor(range: RedditTimeRange, now: Date): string | null {
  const d = new Date(now.getTime());
  switch (range) {
    case 'all':
      return null;
    case 'hour':
      d.setUTCHours(d.getUTCHours() - 1);
      break;
    case 'day':
      d.setUTCDate(d.getUTCDate() - 1);
      break;
    case 'week':
      d.setUTCDate(d.getUTCDate() - 7);
      break;
    case 'month':
      d.setUTCMonth(d.getUTCMonth() - 1);
      break;
    case 'year':
      d.setUTCFullYear(d.getUTCFullYear() - 1);
      break;
  }
  return d.toISOString().slice(0, 10);
}

export type ResearchStatus =
  | 'completed'
  | 'quarantined'
  | 'running'
  | 'ambiguous'
  | 'reused'
  | 'dry_run'
  | 'confirmation_required'
  | 'policy_denied'
  | 'disabled'
  | 'offline'
  | 'missing_credentials'
  | 'misconfigured'
  | 'rejected'
  | 'budget_exceeded'
  | 'budget_unknown_price'
  | 'submission_rejected'
  | 'abandoned';

export interface RunPlan {
  actorId: string;
  build: string;
  schemaId: string;
  schemaHash: string;
  input: Record<string, unknown>;
  inputHash: string;
  runOptions: { build: string; timeoutSecs: number; memoryMbytes: number; maxItems: number; maxTotalChargeUsd: string };
  bounds: { posts: number; comments: number; results: number };
  estimate: { upperBoundMicros: Micros | null; basis: PriceBasis; lines: EstimateLine[]; warnings: string[]; terms: EstimateTerms | null };
  /** Provider-side cap (maxTotalChargeUsd) and the amount reserved (same value when the price is known). */
  capMicros: Micros;
  reserveMicros: Micros | null;
  pricingSource: 'live' | 'stored' | 'none';
  pricingRetrievedAt: string | null;
  forcedOff: ForcedField[];
  keptAbsent: Array<{ field: string; reason: string }>;
  unmappedFields: string[];
  disabledEvents: string[];
  /** Time window enforced for this run (the configured range is a ceiling). */
  timeWindow: { timeRange: RedditTimeRange; earliestDate: string | null };
  capPolicy: CapPolicy;
  /** True when the provider cap is below the conservative estimate (the cap could stop the run early). */
  truncationPossible: boolean;
  /** Bounds lowered by the 'fit' cap policy (null when unchanged). */
  boundsLowered: { from: { posts: number; comments: number }; to: { posts: number; comments: number } } | null;
  warnings: string[];
}

/** Plan facts stored with the run (apify_runs.plan_json) for completion checks after a restart. */
interface StoredPlanFacts {
  estimateUpperBoundMicros: Micros | null;
  terms: EstimateTerms | null;
  capMicros: Micros;
  truncationPossible: boolean;
  capPolicy: CapPolicy;
  bounds: { posts: number; comments: number; results: number };
  timeWindow: { timeRange: RedditTimeRange; earliestDate: string | null };
}

function planFacts(plan: RunPlan): StoredPlanFacts {
  return {
    estimateUpperBoundMicros: plan.estimate.upperBoundMicros,
    terms: plan.estimate.terms,
    capMicros: plan.capMicros,
    truncationPossible: plan.truncationPossible,
    capPolicy: plan.capPolicy,
    bounds: plan.bounds,
    timeWindow: plan.timeWindow,
  };
}

function parsePlanFacts(json: string | null): StoredPlanFacts | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as StoredPlanFacts;
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

export interface ContentResearchResult {
  status: ResearchStatus;
  detail: string;
  nextStep?: string;
  plan?: RunPlan;
  apifyRunId?: string;
  remoteRunId?: string | null;
  remoteStatus?: string | null;
  resumedExisting?: boolean;
  items?: { fetched: number; datasetTotal: number | null; normalized: number; duplicates: number; skipped: Record<string, number> };
  signals?: PersistSignalsResult;
  cost?: { reservationId: string | null; reservedMicros: Micros | null; capMicros: Micros | null; actualMicros: Micros | null; costStatus: 'actual' | 'computed' | 'unknown' | 'reserved' | 'released' | 'none' };
  quarantineReason?: string;
  errors?: string[];
  warnings: string[];
}

export interface ApifyRunRow {
  id: string;
  site_id: string;
  provider_request_id: string | null;
  actor_id: string;
  build: string | null;
  remote_run_id: string | null;
  status: string;
  input_json: string;
  input_hash: string;
  dataset_id: string | null;
  items_fetched: number;
  max_items: number | null;
  max_total_charge_usd_micros: number | null;
  usage_total_usd_micros: number | null;
  charged_events_json: string | null;
  quarantine_reason: string | null;
  is_synthetic: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  processing_status: 'pending' | 'complete' | 'quarantined' | 'abandoned';
  remote_status: string | null;
  status_message: string | null;
  reservation_id: string | null;
  schema_id: string | null;
  run_options_json: string | null;
  purpose: string | null;
  submitted_at: string | null;
  raw_ref: string | null;
  signals_created: number | null;
  plan_json: string | null;
  observed_result_items: number | null;
  /** Items that passed normalization (migration 0250); null before normalization. */
  items_normalized?: number | null;
}

function loadRow(ctx: AppContext, id: string): ApifyRunRow {
  const r = ctx.db.get<ApifyRunRow>('SELECT * FROM apify_runs WHERE id = ? AND site_id = ?', [id, ctx.siteId]);
  if (!r) throw new AppError('NOT_FOUND', `Apify run ${id} not found for site ${ctx.siteId}`);
  return r;
}

function tokenStatus(ctx: AppContext): ContentResearchResult | null {
  if (ctx.secrets.has('APIFY_TOKEN')) return null;
  return {
    status: 'missing_credentials',
    detail: 'APIFY_TOKEN is not configured; no Apify run was started.',
    nextStep: `Add APIFY_TOKEN=<token> to ${ctx.paths.secretsEnvFile} (mode 0600) or inject it as an environment variable. Never paste it into chat.`,
    warnings: [],
  };
}

/** Pricing: live free read when possible, else a recent stored snapshot, else unknown. */
async function currentPricing(
  ctx: AppContext,
  client: ApifyClient,
  schemaRow: StoredActorSchema,
  rt: Rt,
  live: boolean,
): Promise<{ record: PricingRecord | null; source: 'live' | 'stored' | 'none'; retrievedAt: string | null; warnings: string[] }> {
  const warnings: string[] = [];
  const now = ctx.clock.now();
  if (live) {
    try {
      const actor = await loggedRead(ctx, 'apify.actor.get', { actorId: schemaRow.actorId }, () => client.getActor(schemaRow.actorId), (a) => a.id);
      const snap = pricingSnapshotFromActor(actor, now);
      ctx.db.run('UPDATE apify_actor_schemas SET pricing_json = ? WHERE id = ?', [JSON.stringify(snap), schemaRow.id]);
      return { record: pricingFromSnapshot(snap, now), source: 'live', retrievedAt: snap.retrievedAt, warnings };
    } catch (err) {
      warnings.push(`Live pricing read failed (${(err as Error).message}); falling back to stored pricing if recent.`);
    }
  }
  const snap: StoredPricingSnapshot | null = schemaRow.pricing ?? latestPricingSnapshot(ctx.db, schemaRow.actorId);
  if (!snap) return { record: null, source: 'none', retrievedAt: null, warnings };
  const ageH = (now.getTime() - Date.parse(snap.retrievedAt)) / 3_600_000;
  if (live && ageH > rt.maxPricingAgeHours) {
    warnings.push(`Stored pricing is ${Math.round(ageH)}h old (limit ${rt.maxPricingAgeHours}h); treated as unknown.`);
    return { record: null, source: 'none', retrievedAt: snap.retrievedAt, warnings };
  }
  return { record: pricingFromSnapshot(snap, now), source: 'stored', retrievedAt: snap.retrievedAt, warnings };
}

interface PreparedPlan {
  plan: RunPlan;
  body: string;
}

function planRun(
  ctx: AppContext,
  schemaRow: StoredActorSchema,
  build: string,
  opts: ContentResearchOptions,
  pricing: { record: PricingRecord | null; source: 'live' | 'stored' | 'none'; retrievedAt: string | null; warnings: string[] },
): { ok: true; prepared: PreparedPlan } | { ok: false; result: ContentResearchResult } {
  const cfg = ctx.config.research.apify;
  const errors: string[] = [];
  const lower = (name: string, requested: number | undefined, max: number): number => {
    if (requested === undefined) return max;
    if (!Number.isInteger(requested) || requested < 0) errors.push(`${name} must be a non-negative integer.`);
    else if (requested > max) errors.push(`${name} ${requested} exceeds the configured limit ${max} (research.apify); limits can only be lowered per run.`);
    return Math.min(requested, max);
  };
  const maxItems = lower('maxItems', opts.maxItems, cfg.maxItems);
  const maxCommentsPerPost = lower('maxCommentsPerPost', opts.maxCommentsPerPost, cfg.maxCommentsPerPost);
  const maxRunSeconds = lower('maxRunSeconds', opts.maxRunSeconds, cfg.maxRunSeconds);
  const cfgCap = toMicros(cfg.maxTotalChargeUsd);
  const capMicros = lower('maxTotalChargeUsd', opts.maxTotalChargeUsdMicros, cfgCap);
  if (capMicros <= 0) errors.push('The run charge cap is $0; no paid run can be started.');
  const memory = cfg.memoryMbytes;
  if (!Number.isInteger(Math.log2(memory))) errors.push(`research.apify.memoryMbytes ${memory} must be a power of 2 (Apify run option).`);
  const terms = opts.searchTerms ?? ctx.config.research.seedTopics;
  if (!terms.length) errors.push('No search terms: pass them explicitly or configure research.seedTopics.');
  // The configured time range is a ceiling: a run may only narrow it.
  const cfgRange = cfg.timeRange as RedditTimeRange;
  const timeRange = opts.timeRange ?? cfgRange;
  if (!TIME_RANGE_ORDER.includes(timeRange)) errors.push(`timeRange must be one of ${TIME_RANGE_ORDER.join(', ')}.`);
  else if (TIME_RANGE_ORDER.indexOf(timeRange) > TIME_RANGE_ORDER.indexOf(cfgRange)) {
    errors.push(`timeRange "${timeRange}" is broader than the configured research.apify.timeRange "${cfgRange}"; the time range can only be narrowed per run.`);
  }
  const capPolicy: CapPolicy = opts.capPolicy ?? 'fit';
  if (!['fit', 'refuse', 'accept_truncation'].includes(capPolicy)) errors.push(`capPolicy must be fit, refuse, or accept_truncation.`);
  if (errors.length) return { ok: false, result: { status: 'rejected', detail: 'Run options violate configured limits.', errors, warnings: [] } };
  const now = ctx.clock.now();
  const timeWindow = { timeRange, earliestDate: earliestDateFor(timeRange, now) };

  const buildAndEstimate = (items: number, commentsPerPost: number) => {
    const built = buildRedditInput(schemaRow.schema, {
      searchTerms: terms,
      timeRange,
      maxItems: items,
      maxCommentsPerPost: commentsPerPost,
      earliestDate: timeWindow.earliestDate,
      today: now.toISOString().slice(0, 10),
      ...(opts.withinCommunity !== undefined ? { withinCommunity: opts.withinCommunity } : {}),
      ...(opts.sort ? { sort: opts.sort } : {}),
      ...(opts.postedAfter !== undefined ? { postedAfter: opts.postedAfter } : {}),
      ...(opts.postedBefore !== undefined ? { postedBefore: opts.postedBefore } : {}),
      ...(opts.extraInput ? { extraInput: opts.extraInput } : {}),
    });
    if (!built.ok) return { built, estimate: null } as const;
    const estimate = estimateRunCost(pricing.record, {
      maxResults: built.built.maxResults,
      memoryMbytes: memory,
      disabledEvents: new Set(built.built.disabledEvents),
      ...(pricing.retrievedAt ? { verifiedAt: pricing.retrievedAt } : {}),
    });
    return { built, estimate } as const;
  };

  const first = buildAndEstimate(maxItems, maxCommentsPerPost);
  if (!first.built.ok) {
    return {
      ok: false,
      result: { status: 'rejected', detail: 'The actor input could not be built from the verified schema.', errors: first.built.errors, warnings: first.built.warnings, nextStep: 'Fix the listed problems; unknown fields are never sent.' },
    };
  }
  let built = first.built.built;
  let estimate = first.estimate!;
  const fitWarnings: string[] = [];
  let boundsLowered: RunPlan['boundsLowered'] = null;
  if (estimate.upperBoundMicros !== null && estimate.upperBoundMicros > capMicros) {
    const over = `The conservative estimate ${formatUsd(estimate.upperBoundMicros)} exceeds the charge cap ${formatUsd(capMicros)}`;
    if (capPolicy === 'refuse') {
      return {
        ok: false,
        result: {
          status: 'rejected',
          detail: `${over}; the provider-side cap could stop the run early (partial results), so it is refused (capPolicy "refuse").`,
          nextStep: 'Lower maxItems/maxCommentsPerPost, raise research.apify.maxTotalChargeUsd, or use capPolicy "fit".',
          warnings: [],
        },
      };
    }
    if (capPolicy === 'fit') {
      const t = estimate.terms;
      const allowed = t && t.perResultMaxMicros > 0 ? Math.floor((capMicros - t.fixedMicros) / t.perResultMaxMicros) : -1;
      const posts = built.postsBound;
      const refit =
        allowed <= 0
          ? null
          : allowed >= posts
            ? buildAndEstimate(maxItems, Math.min(maxCommentsPerPost, Math.floor((allowed - posts) / Math.max(1, posts))))
            : buildAndEstimate(allowed, 0);
      if (!refit || !refit.built.ok || refit.estimate?.upperBoundMicros === null || refit.estimate!.upperBoundMicros! > capMicros) {
        return {
          ok: false,
          result: {
            status: 'rejected',
            detail: `${over}, and no smaller bound (at least one post per search term) fits under it.`,
            ...(refit && !refit.built.ok ? { errors: refit.built.errors } : {}),
            nextStep: 'Use fewer search terms, raise research.apify.maxTotalChargeUsd (and the Apify budget), or pass a higher --max-usd within the configured cap.',
            warnings: [],
          },
        };
      }
      boundsLowered = { from: { posts: built.postsBound, comments: built.commentsBound }, to: { posts: refit.built.built.postsBound, comments: refit.built.built.commentsBound } };
      built = refit.built.built;
      estimate = refit.estimate!;
      fitWarnings.push(
        `${over}: bounds lowered from ${boundsLowered.from.posts} posts + ${boundsLowered.from.comments} comments to ${boundsLowered.to.posts} posts + ${boundsLowered.to.comments} comments so the cap cannot truncate the run (capPolicy "fit"; use "accept_truncation" to keep the bounds).`,
      );
    }
  }
  const findings = scanInputForSecrets(built.input, collectSensitiveValues(ctx));
  if (findings.length) {
    return {
      ok: false,
      result: {
        status: 'rejected',
        detail: 'The actor input contains credential-like or private values; nothing was sent.',
        errors: findings,
        warnings: [],
        nextStep: 'Remove credentials/private paths from search terms and extra input. Google, Gateway, CMS, and database credentials are never sent to Apify.',
      },
    };
  }
  const warnings = [...built.warnings, ...pricing.warnings, ...estimate.warnings, ...fitWarnings];
  const reserveMicros = estimate.upperBoundMicros === null ? null : Math.min(estimate.upperBoundMicros, capMicros);
  const providerCap = reserveMicros ?? capMicros;
  const truncationPossible = estimate.upperBoundMicros === null || estimate.upperBoundMicros > providerCap;
  if (estimate.upperBoundMicros !== null && estimate.upperBoundMicros > capMicros) {
    warnings.push(
      `Estimated upper bound ${formatUsd(estimate.upperBoundMicros)} exceeds the cap ${formatUsd(capMicros)} (capPolicy "accept_truncation"): if the provider-side cap stops the run early, its results are quarantined as partial.`,
    );
  }
  if (pricing.record?.minimalMaxTotalChargeUsdMicros && pricing.record.minimalMaxTotalChargeUsdMicros > providerCap) {
    warnings.push(`The actor declares a minimal maxTotalChargeUsd of ${formatUsd(pricing.record.minimalMaxTotalChargeUsdMicros)}, above this run's cap; Apify may reject it.`);
  }
  const plan: RunPlan = {
    actorId: schemaRow.actorId,
    build,
    schemaId: schemaRow.id,
    schemaHash: schemaRow.schemaHash,
    input: built.input,
    inputHash: hashObject({ actorId: schemaRow.actorId, build, input: built.input }),
    runOptions: { build, timeoutSecs: maxRunSeconds, memoryMbytes: memory, maxItems: built.maxResults, maxTotalChargeUsd: microsToUsdParam(providerCap) },
    bounds: { posts: built.postsBound, comments: built.commentsBound, results: built.maxResults },
    estimate: { upperBoundMicros: estimate.upperBoundMicros, basis: estimate.basis, lines: estimate.lines, warnings: estimate.warnings, terms: estimate.terms },
    capMicros: providerCap,
    reserveMicros,
    pricingSource: pricing.source,
    pricingRetrievedAt: pricing.retrievedAt,
    forcedOff: built.forcedOff,
    keptAbsent: built.keptAbsent,
    unmappedFields: built.unmappedFields,
    disabledEvents: built.disabledEvents,
    timeWindow,
    capPolicy,
    truncationPossible,
    boundsLowered,
    warnings,
  };
  return { ok: true, prepared: { plan, body: built.body } };
}

/**
 * Start (or resume) one content-research run of the Reddit Scraper actor and,
 * by default, drive it to completion. Every precondition failure returns an
 * honest status instead of throwing.
 */
export async function runContentResearch(ctx: AppContext, opts: ContentResearchOptions = {}): Promise<ContentResearchResult> {
  const rt = rtOf(opts.runtime);
  if (!ctx.settings.features.apify) {
    return { status: 'disabled', detail: 'The apify feature is disabled for this site (profile/features).', nextStep: 'Set features.apify: true in the site config (Full profile enables it).', warnings: [] };
  }
  const schema = resolveRunnableSchema(ctx);
  if (!schema.ok) return { status: 'misconfigured', detail: schema.detail, nextStep: schema.nextStep, warnings: [] };

  const client = opts.client ?? createApifyClient(ctx, { sleep: rt.sleep });
  const canUseNetwork = !ctx.offline && !ctx.dryRun && ctx.secrets.has('APIFY_TOKEN');

  // Plan with stored pricing first (dry-run / offline), then refresh before paying.
  let pricing = await currentPricing(ctx, client, schema.row, rt, false);
  let planned = planRun(ctx, schema.row, schema.build, opts, pricing);
  if (!planned.ok) return planned.result;
  if (ctx.dryRun) {
    return {
      status: 'dry_run',
      detail: 'Dry run: no network request, reservation, or write was made.',
      plan: planned.prepared.plan,
      warnings: [...planned.prepared.plan.warnings],
    };
  }
  if (ctx.offline) return { status: 'offline', detail: 'Offline/demo mode: no Apify request was made.', plan: planned.prepared.plan, warnings: [] };
  const missing = tokenStatus(ctx);
  if (missing) return { ...missing, plan: planned.prepared.plan };
  // Policy `external_research` (src/approvals/policy.ts): paid Apify runs need RESEARCH mode.
  // An explicit spend confirmation is a second requirement (CLI), never a bypass.
  if (!modeAtLeast(ctx.mode, 'RESEARCH')) {
    return {
      status: 'policy_denied',
      detail: `Paid Apify runs need runtime mode RESEARCH (current mode ${ctx.mode}); an explicit spend confirmation does not replace it. Nothing was sent. Cap for this run: ${formatUsd(planned.prepared.plan.capMicros)}.`,
      nextStep: 'Re-run with --mode RESEARCH (the CLI also needs --confirm-spend --max-usd <cap>).',
      plan: planned.prepared.plan,
      warnings: [...planned.prepared.plan.warnings],
    };
  }

  // Resume a known in-flight run with the same input instead of paying twice.
  const inflight = ctx.db.get<{ id: string }>(
    `SELECT id FROM apify_runs WHERE site_id = ? AND actor_id = ? AND input_hash = ? AND processing_status = 'pending' ORDER BY created_at LIMIT 1`,
    [ctx.siteId, schema.actorId, planned.prepared.plan.inputHash],
  );
  if (inflight) {
    const r = await advanceRun(ctx, client, inflight.id, rt, { classifier: opts.classifier, waitForCompletion: opts.waitForCompletion ?? true });
    return { ...r, resumedExisting: true, detail: `Resumed existing run with identical input (no new paid run). ${r.detail}` };
  }
  const reuseHours = opts.reuseCompletedWithinHours ?? 168;
  if (reuseHours > 0) {
    const cutoff = new Date(ctx.clock.now().getTime() - reuseHours * 3_600_000).toISOString();
    const done = ctx.db.get<{ id: string; updated_at: string }>(
      // Only complete runs whose items were actually normalized are research; a run whose output the
      // normalizer could not read (0 normalized items) or a quarantined run never blocks fresh research.
      `SELECT id, updated_at FROM apify_runs WHERE site_id = ? AND actor_id = ? AND input_hash = ? AND processing_status = 'complete'
         AND COALESCE(items_normalized, observed_result_items, 0) > 0 AND updated_at >= ? ORDER BY updated_at DESC LIMIT 1`,
      [ctx.siteId, schema.actorId, planned.prepared.plan.inputHash, cutoff],
    );
    if (done) {
      return { ...summarizeRun(ctx, done.id), status: 'reused', detail: `An identical run completed at ${done.updated_at}; its signals are reused (no spend).`, plan: planned.prepared.plan };
    }
  }

  // Free reads before paying: confirm the pinned build's schema and current pricing.
  const warnings: string[] = [];
  if (opts.verifyBuildOnline !== false && schema.row.buildId) {
    try {
      const b = await loggedRead(ctx, 'apify.build.get', { buildId: schema.row.buildId }, () => client.getBuild(schema.row.buildId!), (x) => x.id);
      if (b.inputSchema !== null && b.inputSchema !== undefined) {
        const liveHash = inputSchemaHash(parseInputSchema(b.inputSchema, 'pinned build inputSchema'));
        if (liveHash !== schema.row.schemaHash) {
          recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType: 'apify.schema_drift', subjectType: 'apify_actor', subjectId: schema.actorId, details: { build: schema.build, stored: schema.row.schemaHash, live: liveHash } });
          return { status: 'misconfigured', detail: `Schema drift: the live input schema of pinned build ${schema.build} no longer matches the verified schema. Nothing was sent.`, nextStep: 'Run `apify inspect` and review the drift before running.', warnings };
        }
      }
      if (b.status && b.status !== 'SUCCEEDED') return { status: 'misconfigured', detail: `Pinned build ${schema.build} has status ${b.status}.`, nextStep: 'Pin a SUCCEEDED build (see `apify inspect`).', warnings };
    } catch (err) {
      warnings.push(`Could not re-verify the pinned build online (${(err as Error).message}); using the stored verified schema (builds are immutable).`);
    }
  }
  pricing = await currentPricing(ctx, client, schema.row, rt, true);
  planned = planRun(ctx, schema.row, schema.build, opts, pricing);
  if (!planned.ok) return planned.result;
  const { plan, body } = planned.prepared;
  warnings.push(...plan.warnings);
  if (opts.expectedPlan) {
    const changes: string[] = [];
    if (plan.capMicros > opts.expectedPlan.capMicros) changes.push(`the provider cap would be ${formatUsd(plan.capMicros)}, above the ${formatUsd(opts.expectedPlan.capMicros)} shown`);
    if (plan.inputHash !== opts.expectedPlan.inputHash) changes.push('the actor input differs from the one shown (for example, bounds re-fitted to live pricing)');
    if (changes.length) {
      return {
        status: 'confirmation_required',
        detail: `Live pricing changed the plan after it was shown: ${changes.join('; ')}. Nothing was sent.`,
        nextStep: 'Review the new plan (cap and input below) and confirm again.',
        plan,
        warnings,
      };
    }
  }

  // Atomic: duplicate re-check, reservation, provider request, and run row BEFORE the POST.
  let rowId: string;
  let prId: string;
  let reservationId: string;
  try {
    type Created = { kind: 'dup'; dup: string } | { kind: 'new'; id: string; prId: string; reservationId: string };
    const created = ctx.db.transaction((): Created => {
      const dup = ctx.db.get<{ id: string }>(`SELECT id FROM apify_runs WHERE site_id = ? AND actor_id = ? AND input_hash = ? AND processing_status = 'pending' LIMIT 1`, [
        ctx.siteId,
        plan.actorId,
        plan.inputHash,
      ]);
      if (dup) return { kind: 'dup', dup: dup.id };
      const reservation = ctx.budgets.reserve({
        siteId: ctx.siteId,
        provider: 'apify',
        runId: ctx.runId,
        purpose: opts.purpose ?? `Apify Reddit research (${plan.bounds.results} results max)`,
        estimate: {
          upperBoundMicros: plan.reserveMicros,
          basis: plan.reserveMicros === null ? plan.estimate.basis : { ...plan.estimate.basis, detail: `${plan.estimate.basis.detail}; provider-side cap maxTotalChargeUsd=${plan.runOptions.maxTotalChargeUsd}` },
        },
      });
      const pr = ctx.requests.prepare({
        siteId: ctx.siteId,
        provider: 'apify',
        endpoint: START_ENDPOINT,
        method: 'POST',
        isPaid: true,
        params: { actorId: plan.actorId, runOptions: plan.runOptions, input: plan.input },
        reservationId: reservation.id,
        idempotencyKey: plan.inputHash,
      });
      ctx.budgets.attachRequest(reservation.id, pr.id);
      const id = newId('arun');
      const now = ctx.clock.now().toISOString();
      ctx.db.run(
        `INSERT INTO apify_runs (id, site_id, provider_request_id, actor_id, build, remote_run_id, status, input_json, input_hash, dataset_id, items_fetched, max_items,
           max_total_charge_usd_micros, usage_total_usd_micros, charged_events_json, quarantine_reason, is_synthetic, created_at, updated_at,
           processing_status, reservation_id, schema_id, run_options_json, purpose, plan_json)
         VALUES (?, ?, ?, ?, ?, NULL, 'submitting', ?, ?, NULL, 0, ?, ?, NULL, NULL, NULL, 0, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        [
          id,
          ctx.siteId,
          pr.id,
          plan.actorId,
          plan.build,
          body,
          plan.inputHash,
          plan.bounds.results,
          plan.capMicros,
          now,
          now,
          reservation.id,
          plan.schemaId,
          JSON.stringify(plan.runOptions),
          opts.purpose ?? null,
          JSON.stringify(planFacts(plan)),
        ],
      );
      return { kind: 'new', id, prId: pr.id, reservationId: reservation.id };
    });
    if (created.kind === 'dup') {
      const r = await advanceRun(ctx, client, created.dup, rt, { classifier: opts.classifier, waitForCompletion: opts.waitForCompletion ?? true });
      return { ...r, resumedExisting: true };
    }
    ({ id: rowId, prId, reservationId } = created);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      // The budget service's own denial audit is inside its rolled-back transaction; record ours here.
      recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType: 'apify.budget_denied', subjectType: 'apify_actor', subjectId: plan.actorId, details: { ...(err.details ?? {}), capMicros: plan.capMicros } });
      return { status: 'budget_exceeded', detail: err.message, nextStep: err.hint ?? 'No automatic budget increase is performed.', plan, warnings };
    }
    if (isAppError(err) && err.code === 'BUDGET_UNKNOWN_PRICE') {
      return { status: 'budget_unknown_price', detail: err.message, nextStep: 'Run `apify inspect` to retrieve verified pricing; unknown prices are never treated as $0.', plan, warnings };
    }
    throw err;
  }

  // Submit. Never retried.
  const submittedAt = ctx.clock.now().toISOString();
  ctx.requests.markSubmitted(prId);
  ctx.db.run('UPDATE apify_runs SET submitted_at = ?, updated_at = ? WHERE id = ?', [submittedAt, submittedAt, rowId]);
  let run: ApifyRun;
  try {
    ({ run } = await client.startRun(plan.actorId, body, { ...plan.runOptions, waitForFinish: 0 }));
  } catch (err) {
    return { ...handleStartFailure(ctx, rowId, prId, reservationId, err), plan, warnings };
  }
  persistRemoteRun(ctx, rowId, prId, run);
  recordAudit(ctx.db, {
    siteId: ctx.siteId,
    actor: 'system',
    eventType: 'apify.run_started',
    subjectType: 'apify_run',
    subjectId: rowId,
    details: { remoteRunId: run.id, build: plan.build, capMicros: plan.capMicros, reservedMicros: plan.reserveMicros },
  });

  if (opts.waitForCompletion === false) {
    return { ...summarizeRun(ctx, rowId), status: 'running', detail: `Run ${run.id} started; resume with \`apify runs --resume\`.`, plan, warnings };
  }
  const r = await advanceRun(ctx, client, rowId, rt, { classifier: opts.classifier, waitForCompletion: true });
  return { ...r, plan, warnings: [...warnings, ...r.warnings] };
}

function handleStartFailure(ctx: AppContext, rowId: string, prId: string, reservationId: string, err: unknown): ContentResearchResult {
  const now = ctx.clock.now().toISOString();
  const definitelyRejected = err instanceof ApifyApiError && err.httpStatus >= 400 && err.httpStatus < 500 && err.httpStatus !== 408;
  const neverSent = err instanceof ApifyTransportError && !err.sent;
  if (definitelyRejected || neverSent) {
    const reason = neverSent ? 'request was never sent (offline)' : `submission rejected by Apify: ${redactString((err as Error).message)}`;
    ctx.db.transaction(() => {
      ctx.requests.complete(prId, { status: 'failed', httpStatus: err instanceof ApifyApiError ? err.httpStatus : null, error: err });
      ctx.budgets.release(reservationId, reason);
      ctx.db.run(
        `UPDATE apify_runs SET status = 'quarantined', processing_status = ?, quarantine_reason = ?, updated_at = ? WHERE id = ?`,
        [neverSent ? 'abandoned' : 'quarantined', reason, now, rowId],
      );
    });
    return {
      status: neverSent ? 'offline' : 'submission_rejected',
      detail: reason,
      nextStep: (err as AppError).hint ?? 'Nothing was charged for a rejected submission; fix the cause before retrying.',
      apifyRunId: rowId,
      cost: { reservationId, reservedMicros: null, capMicros: null, actualMicros: null, costStatus: 'released' },
      warnings: [],
    };
  }
  // Timeout, network error after sending, 5xx, or an unreadable 2xx: the provider may have accepted the run.
  const reason = `ambiguous submission: ${redactString((err as Error)?.message ?? String(err))}`;
  ctx.db.transaction(() => {
    ctx.requests.complete(prId, { status: 'ambiguous', httpStatus: err instanceof ApifyApiError ? err.httpStatus : null, error: err });
    ctx.budgets.markUnresolved(reservationId, reason);
    ctx.db.run(`UPDATE apify_runs SET status = 'ambiguous', status_message = ?, updated_at = ? WHERE id = ?`, [reason.slice(0, 500), now, rowId]);
  });
  recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType: 'apify.run_ambiguous', subjectType: 'apify_run', subjectId: rowId, details: { reason } });
  return {
    status: 'ambiguous',
    detail: `${reason}. The reservation stays held; the submission is never retried blindly.`,
    nextStep: 'Run `apify runs --resume` to reconcile against Apify run history (a run started by this submission will be adopted, not duplicated).',
    apifyRunId: rowId,
    warnings: [],
  };
}

function persistRemoteRun(ctx: AppContext, rowId: string, prId: string | null, run: ApifyRun): void {
  const now = ctx.clock.now().toISOString();
  ctx.db.transaction(() => {
    ctx.db.run(
      `UPDATE apify_runs SET remote_run_id = ?, status = ?, remote_status = ?, dataset_id = COALESCE(?, dataset_id), started_at = COALESCE(?, started_at),
         status_message = ?, updated_at = ? WHERE id = ?`,
      [run.id, run.status, run.status, run.defaultDatasetId ?? null, run.startedAt ?? null, run.statusMessage ? redactString(run.statusMessage).slice(0, 500) : null, now, rowId],
    );
    if (prId) ctx.requests.setExternalId(prId, run.id);
  });
}

function updateFromRun(ctx: AppContext, rowId: string, run: ApifyRun): void {
  const usage = usdToMicros(run.usageTotalUsd);
  ctx.db.run(
    `UPDATE apify_runs SET status = CASE WHEN status = 'quarantined' THEN status ELSE ? END, remote_status = ?, dataset_id = COALESCE(?, dataset_id),
       started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at), status_message = ?,
       usage_total_usd_micros = COALESCE(?, usage_total_usd_micros), charged_events_json = COALESCE(?, charged_events_json), updated_at = ? WHERE id = ?`,
    [
      run.status,
      run.status,
      run.defaultDatasetId ?? null,
      run.startedAt ?? null,
      run.finishedAt ?? null,
      run.statusMessage ? redactString(run.statusMessage).slice(0, 500) : null,
      usage,
      run.chargedEventCounts ? JSON.stringify(run.chargedEventCounts) : null,
      ctx.clock.now().toISOString(),
      rowId,
    ],
  );
}

function quarantine(ctx: AppContext, rowId: string, reason: string, o: { completeRequest?: boolean } = {}): void {
  const row = loadRow(ctx, rowId);
  ctx.db.transaction(() => {
    ctx.db.run(`UPDATE apify_runs SET status = 'quarantined', processing_status = 'quarantined', quarantine_reason = ?, updated_at = ? WHERE id = ?`, [
      reason.slice(0, 1000),
      ctx.clock.now().toISOString(),
      rowId,
    ]);
    if (row.provider_request_id && o.completeRequest !== false) ctx.requests.complete(row.provider_request_id, { status: 'failed', error: { reason } });
  });
  recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType: 'apify.run_quarantined', subjectType: 'apify_run', subjectId: rowId, details: { reason, remoteRunId: row.remote_run_id } });
}

function pricingForRow(ctx: AppContext, row: ApifyRunRow): PricingRecord | null {
  const snapRow = row.schema_id ? ctx.db.get<{ pricing_json: string | null }>('SELECT pricing_json FROM apify_actor_schemas WHERE id = ?', [row.schema_id]) : undefined;
  const snap = snapRow?.pricing_json ? (JSON.parse(snapRow.pricing_json) as StoredPricingSnapshot) : latestPricingSnapshot(ctx.db, row.actor_id);
  const at = row.started_at ? new Date(row.started_at) : new Date(row.created_at);
  return pricingFromSnapshot(snap, at);
}

/** Terminal statuses whose runs actually ran (their one-time start event is charged). */
function runRan(run: ApifyRun, resultItems: number | null | undefined): boolean {
  return ['SUCCEEDED', 'FAILED', 'TIMED-OUT'].includes(run.status) || (run.stats?.runTimeSecs ?? 0) > 0 || (resultItems ?? 0) > 0;
}

/** Posts/comments among fetched dataset items (each is a primary `result` event). */
function countResultItems(items: readonly unknown[]): number {
  let n = 0;
  for (const it of items) {
    const t = it && typeof it === 'object' ? (it as { dataType?: unknown }).dataType : undefined;
    if (t === 'post' || t === 'comment') n++;
  }
  return n;
}

/**
 * Reconcile provider-reported usage to the reservation. Unknown usage stays
 * unresolved (never $0). Figures that contradict the observed activity (e.g.
 * $0 or empty event counts for a run that ran and saved results) are treated
 * as preliminary: the reservation stays unresolved and is re-checked on resume.
 */
function reconcileUsage(
  ctx: AppContext,
  row: ApifyRunRow,
  run: ApifyRun,
  observed: ObservedActivity,
): { status: 'reconciled' | 'unresolved' | 'skipped'; actualMicros: Micros | null; source: string; overshootMicros: Micros; notes: string[] } {
  const notes: string[] = [];
  if (!row.reservation_id) return { status: 'skipped', actualMicros: null, source: 'none', overshootMicros: 0, notes };
  const res = ctx.db.get<{ status: string }>('SELECT status FROM budget_reservations WHERE id = ?', [row.reservation_id]);
  if (!res || res.status === 'reconciled' || res.status === 'released') return { status: 'skipped', actualMicros: null, source: 'none', overshootMicros: 0, notes };
  const pricing = pricingForRow(ctx, row);
  const reported = usdToMicros(run.usageTotalUsd);
  let actual: Micros | null = null;
  let source: 'provider_reported' | 'computed_from_usage' = 'provider_reported';
  if (reported !== null) {
    const why = reportedUsageInconsistency(pricing, reported, observed);
    if (why) notes.push(`Reported usage treated as preliminary (${why}).`);
    else actual = reported;
  } else if (run.chargedEventCounts) {
    const why = eventCountsInconsistency(pricing, run.chargedEventCounts, observed);
    if (why) notes.push(`Charged event counts treated as preliminary (${why}).`);
    const computed = chargeFromEventCounts(pricing, run.chargedEventCounts, observed);
    if (computed !== null) {
      actual = computed;
      source = 'computed_from_usage';
    }
  }
  const r = ctx.budgets.reconcile(row.reservation_id, {
    actualMicros: actual,
    source,
    usage: {
      remoteRunId: run.id,
      usageTotalUsd: run.usageTotalUsd ?? null,
      chargedEventCounts: run.chargedEventCounts ?? null,
      remoteStatus: run.status,
      observed,
      ...(notes.length ? { notes } : {}),
    },
    ...(row.provider_request_id ? { providerRequestId: row.provider_request_id } : {}),
  });
  return { status: r.status, actualMicros: actual, source: actual === null ? 'unknown' : source, overshootMicros: r.overshootMicros, notes };
}

/** Heuristic (unverified wording): a status message saying the charge limit stopped the run. */
const CHARGE_LIMIT_MESSAGE_RE = /(max(imum)?\s+(total\s+)?(charge|cost|spend(ing)?)|charge\s+limit|spending\s+limit|cost\s+limit|budget\s+(limit|reached|exceeded)|maxTotalChargeUsd)/i;

/**
 * Decide whether a SUCCEEDED run may have been cut short by the provider-side
 * charge cap. A run is treated as cap-stopped when its charge is within one
 * result price of the cap while fewer results than the planned bound were
 * charged. When the charge cannot be established and the plan allowed
 * truncation, the outcome is uncertain (quarantined as unverifiable).
 */
function assessChargeCap(ctx: AppContext, row: ApifyRunRow, run: ApifyRun, resultItems: number): { partial: boolean; reason?: string; warning?: string } {
  if (run.statusMessage && CHARGE_LIMIT_MESSAGE_RE.test(run.statusMessage)) {
    return { partial: true, reason: `partial: the provider charge cap was reached (status message: ${redactString(run.statusMessage).slice(0, 200)})` };
  }
  const facts = parsePlanFacts(row.plan_json);
  const cap = row.max_total_charge_usd_micros;
  const pricing = pricingForRow(ctx, row);
  const terms = facts?.terms ?? null;
  const bound = facts?.bounds.results ?? row.max_items ?? null;
  const truncationPossible = facts?.truncationPossible ?? true;
  if (cap === null || !terms || terms.perResultMaxMicros <= 0 || bound === null) {
    return truncationPossible
      ? { partial: true, reason: 'partial (unverifiable): the plan allowed the charge cap to stop the run and its cost terms are unknown' }
      : { partial: false, warning: 'Charge-cap check skipped: plan cost terms unknown.' };
  }
  const primary = pricing?.events?.find((e) => e.isPrimary)?.key;
  const counted = primary && run.chargedEventCounts && typeof run.chargedEventCounts[primary] === 'number' ? run.chargedEventCounts[primary]! : null;
  const results = Math.max(counted ?? 0, resultItems);
  if (results >= bound) return { partial: false };
  const threshold = cap - terms.perResultMaxMicros;
  const reported = usdToMicros(run.usageTotalUsd);
  const range = reported !== null ? { lowMicros: reported, highMicros: reported } : chargeRangeFromEventCounts(pricing, run.chargedEventCounts ?? null);
  if (range === null) {
    return truncationPossible
      ? { partial: true, reason: `partial (unverifiable): the conservative estimate exceeded the ${formatUsd(cap)} charge cap and no usage was reported to show the cap was not reached` }
      : { partial: false, warning: 'Charge-cap check: no usage reported yet; the plan fits under the cap at the conservative price.' };
  }
  if (range.lowMicros > threshold) {
    return { partial: true, reason: `partial: charge ${formatUsd(range.lowMicros)} reached the ${formatUsd(cap)} cap (within one result price) with ${results} of ${bound} results; the cap stopped the run early` };
  }
  if (range.highMicros > threshold) {
    return { partial: true, reason: `partial (unverifiable): charge between ${formatUsd(range.lowMicros)} and ${formatUsd(range.highMicros)} (tier unknown) may have reached the ${formatUsd(cap)} cap with ${results} of ${bound} results` };
  }
  return { partial: false };
}

interface AdvanceOptions {
  classifier?: SignalClassifier | undefined;
  waitForCompletion: boolean;
  abortOverdue?: boolean;
}

/** Drive one local run forward as far as possible (idempotent; safe after a crash). */
export async function advanceRun(ctx: AppContext, client: ApifyClient, rowId: string, rt: Rt, o: AdvanceOptions): Promise<ContentResearchResult> {
  let row = loadRow(ctx, rowId);
  const warnings: string[] = [];
  if (row.processing_status !== 'pending') return summarizeRun(ctx, rowId);

  if (row.status === 'submitting') {
    const pr = row.provider_request_id ? ctx.requests.get(row.provider_request_id) : undefined;
    const age = ctx.clock.now().getTime() - Date.parse(row.submitted_at ?? row.created_at);
    if (age < rt.staleSubmittingMs) {
      return { ...summarizeRun(ctx, rowId), status: 'running', detail: 'Another process is submitting this identical run; not starting a duplicate.' };
    }
    if (pr?.status === 'prepared') {
      // The POST was provably never sent (the process stopped before markSubmitted).
      ctx.db.transaction(() => {
        ctx.requests.complete(pr.id, { status: 'skipped', error: { reason: 'process stopped before sending' } });
        if (row.reservation_id) ctx.budgets.release(row.reservation_id, 'apify run never submitted (process stopped before sending)');
        ctx.db.run(`UPDATE apify_runs SET status = 'quarantined', processing_status = 'abandoned', quarantine_reason = ?, updated_at = ? WHERE id = ?`, [
          'never submitted: the process stopped before sending',
          ctx.clock.now().toISOString(),
          rowId,
        ]);
      });
      return { ...summarizeRun(ctx, rowId), status: 'abandoned', detail: 'The run was never submitted; its reservation was released.' };
    }
    // Sent (or unknown) with no recorded response: ambiguous.
    ctx.db.transaction(() => {
      if (pr) ctx.requests.complete(pr.id, { status: 'ambiguous', error: { reason: 'process stopped after sending' } });
      if (row.reservation_id) ctx.budgets.markUnresolved(row.reservation_id, 'ambiguous submission (process stopped after sending)');
      ctx.db.run(`UPDATE apify_runs SET status = 'ambiguous', updated_at = ? WHERE id = ?`, [ctx.clock.now().toISOString(), rowId]);
    });
    row = loadRow(ctx, rowId);
  }

  if (row.status === 'ambiguous') {
    const rec = await reconcileAmbiguousStart(ctx, client, row, rt);
    if (rec.outcome !== 'adopted') {
      const s = summarizeRun(ctx, rowId);
      return { ...s, status: rec.outcome === 'not_accepted' ? 'quarantined' : 'ambiguous', detail: rec.detail, ...(rec.nextStep ? { nextStep: rec.nextStep } : {}) };
    }
    row = loadRow(ctx, rowId);
  }

  if (!row.remote_run_id) return { ...summarizeRun(ctx, rowId), status: 'ambiguous', detail: 'No remote run id is known for this run.' };

  // Poll.
  let run: ApifyRun | null = null;
  if (!isTerminalStatus(row.remote_status ?? row.status) || !row.finished_at) {
    if (!o.waitForCompletion) {
      try {
        run = await client.getRun(row.remote_run_id);
        updateFromRun(ctx, rowId, run);
      } catch (err) {
        warnings.push(`Status check failed: ${(err as Error).message}`);
      }
      if (!run || !isTerminalStatus(run.status)) return { ...summarizeRun(ctx, rowId), status: 'running', detail: `Run ${row.remote_run_id} is ${run?.status ?? row.status}.`, warnings };
    } else {
      const polled = await pollUntilTerminal(ctx, client, row, rt, warnings);
      run = polled;
      if (!run || !isTerminalStatus(run.status)) {
        if (o.abortOverdue) await maybeAbortOverdue(ctx, client, loadRow(ctx, rowId), warnings);
        const cur = loadRow(ctx, rowId);
        return { ...summarizeRun(ctx, rowId), status: 'running', detail: `Run ${row.remote_run_id} is still ${cur.remote_status ?? cur.status}; resume later with \`apify runs --resume\`.`, warnings };
      }
    }
  }
  // Stable usage figures: re-read shortly after completion (contract: ~10 s).
  if (rt.stableUsageDelayMs > 0) await rt.sleep(rt.stableUsageDelayMs);
  try {
    run = await client.getRun(row.remote_run_id);
  } catch (err) {
    warnings.push(`Final run read failed (${(err as Error).message}); usage may be preliminary.`);
    if (!run) return { ...summarizeRun(ctx, rowId), status: 'running', detail: 'Could not read the finished run; resume later.', warnings };
  }
  updateFromRun(ctx, rowId, run);
  row = loadRow(ctx, rowId);

  // Fetch the dataset first: the observed results are checked against the reported usage.
  const fetched = row.dataset_id ? await fetchItems(ctx, client, row, rt) : null;
  const resultItems = fetched ? countResultItems(fetched.items) : 0;
  if (fetched) {
    ctx.db.run('UPDATE apify_runs SET raw_ref = ?, items_fetched = ?, observed_result_items = ?, updated_at = ? WHERE id = ?', [
      fetched.rawRef,
      fetched.items.length,
      resultItems,
      ctx.clock.now().toISOString(),
      rowId,
    ]);
  }
  const usage = reconcileUsage(ctx, row, run, { started: runRan(run, resultItems), resultItems });
  warnings.push(...usage.notes);
  if (usage.status === 'unresolved') warnings.push('Apify did not report final usage for this run: the reservation stays held as unresolved (unknown cost is never $0); `apify runs --resume` re-checks it.');
  if (usage.overshootMicros > 0) warnings.push(`Actual charge exceeded the reservation by ${formatUsd(usage.overshootMicros)} (recorded truthfully).`);

  const quarantined = (reason: string, detail: string): ContentResearchResult => {
    quarantine(ctx, rowId, reason);
    return { ...summarizeRun(ctx, rowId), status: 'quarantined', detail, warnings };
  };
  if (run.status !== 'SUCCEEDED') {
    return quarantined(
      `run ended ${run.status}${run.statusMessage ? `: ${redactString(run.statusMessage).slice(0, 300)}` : ''}; partial results are kept for inspection only`,
      `Run ${run.id} ended ${run.status}; results quarantined (never treated as complete research).`,
    );
  }
  if (!fetched) return quarantined('run SUCCEEDED but reported no default dataset', 'No dataset id was reported; quarantined.');
  if (!fetched.complete) return quarantined(`partial dataset: ${fetched.reason ?? 'fetch incomplete'}`, `Dataset fetch incomplete (${fetched.reason ?? 'unknown'}); quarantined.`);
  const summary = await readRunSummary(client, run, warnings);
  if (summary && typeof summary.itemsTotal === 'number' && fetched.datasetTotal !== null && summary.itemsTotal > fetched.datasetTotal) {
    return quarantined(`run summary reports ${summary.itemsTotal} items but the dataset holds ${fetched.datasetTotal}`, 'Run summary and dataset disagree; quarantined.');
  }
  const failedRequests = (summary?.requests as { failed?: unknown } | undefined)?.failed;
  if (typeof failedRequests === 'number' && failedRequests > 0) {
    return quarantined(
      `partial: RUN-SUMMARY reports ${failedRequests} failed request(s); coverage is incomplete`,
      `Run ${run.id} reported ${failedRequests} failed request(s); results quarantined as partial (never treated as complete research).`,
    );
  }
  const cap = assessChargeCap(ctx, row, run, resultItems);
  if (cap.warning) warnings.push(cap.warning);
  if (cap.partial) return quarantined(cap.reason!, `Run ${run.id} may have been stopped by its charge cap; results quarantined as partial (${cap.reason}).`);

  const normalized = normalizeDatasetItems(fetched.items);
  ctx.db.run('UPDATE apify_runs SET items_normalized = ?, updated_at = ? WHERE id = ?', [normalized.items.length, ctx.clock.now().toISOString(), rowId]);
  const drift = outputSchemaDrift(fetched.items);
  if (drift) {
    recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType: 'apify.output_schema_drift', subjectType: 'apify_run', subjectId: rowId, details: { remoteRunId: run.id, ...drift.counts } });
    return quarantined(
      `output schema drift: ${drift.detail}`,
      `Run ${run.id}: ${drift.detail}. Results quarantined (never treated as complete research, never reused); run \`apify inspect\` to review the actor's output schema.`,
    );
  }
  const classification = (o.classifier ? await safeClassify(o.classifier, normalized.items, warnings) : null) ?? heuristicClassify(normalized.items);
  const input = safeJson(row.input_json);
  const facts = parsePlanFacts(row.plan_json);
  const signals = persistSignals(ctx.db, {
    siteId: ctx.siteId,
    apifyRunId: rowId,
    items: normalized.items,
    classification,
    collectedAt: run.finishedAt ?? ctx.clock.now().toISOString(),
    collectionWindow: {
      actorId: row.actor_id,
      build: row.build,
      remoteRunId: run.id,
      runStartedAt: run.startedAt ?? null,
      runFinishedAt: run.finishedAt ?? null,
      searchTime: input.searchTime ?? null,
      postedAfter: input.postedAfter ?? null,
      postedBefore: input.postedBefore ?? null,
      withinCommunity: input.withinCommunity ?? null,
      earliestAllowedDate: facts?.timeWindow.earliestDate ?? null,
    },
    rawRef: fetched.rawRef,
    isSynthetic: row.is_synthetic === 1,
  });
  const now = ctx.clock.now().toISOString();
  ctx.db.transaction(() => {
    ctx.db.run(`UPDATE apify_runs SET processing_status = 'complete', signals_created = ?, updated_at = ? WHERE id = ?`, [signals.created, now, rowId]);
    if (row.provider_request_id) ctx.requests.complete(row.provider_request_id, { status: 'succeeded', rawRef: fetched.rawRef, externalId: run.id });
  });
  recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType: 'apify.run_completed', subjectType: 'apify_run', subjectId: rowId, details: { remoteRunId: run.id, items: fetched.items.length, signals: signals.created } });
  if (summary?.emptyReason) warnings.push(`Run summary emptyReason: ${String(summary.emptyReason).slice(0, 200)}`);
  return {
    ...summarizeRun(ctx, rowId),
    status: 'completed',
    detail: `Run ${run.id} completed: ${fetched.items.length} item(s) fetched, ${signals.created} new signal(s), ${signals.occurrences} repeat occurrence(s) (${classification.method}).`,
    items: { fetched: fetched.items.length, datasetTotal: fetched.datasetTotal, normalized: normalized.items.length, duplicates: normalized.duplicates + signals.duplicates, skipped: normalized.skipped },
    signals,
    warnings,
  };
}

/** Documented dataset item discriminators (docs/integration-contracts.md section 7). */
export const KNOWN_DATA_TYPES: ReadonlySet<string> = new Set(['post', 'comment', 'community', 'user_profile']);

/**
 * Structural output drift: most (> 50%) or all fetched items lack a documented
 * `dataType` or an `id` (e.g. the field was renamed). Such a run is
 * quarantined instead of completing with 0 signals and being reused.
 */
export function outputSchemaDrift(items: readonly unknown[]): { detail: string; counts: { fetched: number; structural: number; missingDataType: number; unknownDataType: number; missingId: number } } | null {
  if (!items.length) return null;
  let missingDataType = 0;
  let unknownDataType = 0;
  let missingId = 0;
  let structural = 0;
  const unknownValues = new Set<string>();
  for (const it of items) {
    const o = it && typeof it === 'object' && !Array.isArray(it) ? (it as Record<string, unknown>) : null;
    const dt = o?.dataType;
    let bad = false;
    if (typeof dt !== 'string' || !dt) {
      missingDataType++;
      bad = true;
    } else if (!KNOWN_DATA_TYPES.has(dt)) {
      unknownDataType++;
      if (unknownValues.size < 5) unknownValues.add(dt.slice(0, 40));
      bad = true;
    }
    if (typeof o?.id !== 'string' || !o.id) {
      missingId++;
      bad = true;
    }
    if (bad) structural++;
  }
  if (structural * 2 <= items.length) return null;
  const parts = [
    missingDataType ? `${missingDataType} without dataType` : null,
    unknownDataType ? `${unknownDataType} with an undocumented dataType (${[...unknownValues].map((v) => JSON.stringify(v)).join(', ')})` : null,
    missingId ? `${missingId} without id` : null,
  ].filter(Boolean);
  return {
    detail: `${structural} of ${items.length} dataset item(s) could not be read by the normalizer (${parts.join('; ')})`,
    counts: { fetched: items.length, structural, missingDataType, unknownDataType, missingId },
  };
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function safeClassify(classifier: SignalClassifier, items: NormalizedRedditItem[], warnings: string[]) {
  try {
    return await classifier(items);
  } catch (err) {
    warnings.push(`Injected classifier failed (${(err as Error).message}); heuristics used.`);
    return null;
  }
}

async function readRunSummary(client: ApifyClient, run: ApifyRun, warnings: string[]): Promise<Record<string, unknown> | null> {
  if (!run.defaultKeyValueStoreId) return null;
  try {
    const s = await client.getKeyValueRecord(run.defaultKeyValueStoreId, 'RUN-SUMMARY');
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    const summary = s as Record<string, unknown>;
    if (Array.isArray(summary.skipped) && summary.skipped.length) warnings.push(`Run summary reports skipped targets: ${JSON.stringify(summary.skipped).slice(0, 300)}`);
    return summary;
  } catch (err) {
    warnings.push(`RUN-SUMMARY unavailable (${(err as Error).message}).`);
    return null;
  }
}

async function fetchItems(
  ctx: AppContext,
  client: ApifyClient,
  row: ApifyRunRow,
  rt: Rt,
): Promise<{ items: unknown[]; datasetTotal: number | null; complete: boolean; reason?: string; rawRef: string | null }> {
  const bound = (row.max_items ?? 1000) + 100;
  const r = await client.fetchAllDatasetItems(row.dataset_id!, { pageSize: rt.datasetPageSize, maxItems: bound, fields: [...DATASET_FIELDS] });
  // Store only the allowlisted, non-personal fields (the server-side `fields` selection is defence in depth).
  const minimized = normalizeDatasetItems(r.items).items;
  const rawRef = ctx.raw.save({
    siteId: ctx.siteId,
    provider: 'apify',
    kind: r.complete ? 'dataset-items' : 'dataset-items-partial',
    payload: { remoteRunId: row.remote_run_id, datasetId: row.dataset_id, total: r.total, complete: r.complete, items: minimized },
    at: ctx.clock.now(),
  });
  return { items: r.items, datasetTotal: r.total, complete: r.complete, ...(r.reason ? { reason: r.reason } : {}), rawRef };
}

async function pollUntilTerminal(ctx: AppContext, client: ApifyClient, row: ApifyRunRow, rt: Rt, warnings: string[]): Promise<ApifyRun | null> {
  const opts = row.run_options_json ? (JSON.parse(row.run_options_json) as { timeoutSecs?: number }) : {};
  const timeoutSecs = opts.timeoutSecs ?? ctx.config.research.apify.maxRunSeconds;
  const start = Date.parse(row.started_at ?? row.submitted_at ?? row.created_at);
  const deadline = start + (timeoutSecs + rt.pollGraceSecs) * 1000;
  const maxPolls = rt.maxPolls ?? Math.ceil((timeoutSecs + rt.pollGraceSecs) / Math.max(1, rt.pollWaitSecs)) + 3;
  let delay = 1000;
  let last: ApifyRun | null = null;
  for (let i = 0; i < maxPolls; i++) {
    try {
      last = await client.getRun(row.remote_run_id!, { waitForFinish: rt.pollWaitSecs });
    } catch (err) {
      warnings.push(`Polling failed (${(err as Error).message}); the run continues remotely.`);
      return last;
    }
    updateFromRun(ctx, row.id, last);
    if (isTerminalStatus(last.status)) return last;
    if (ctx.clock.now().getTime() > deadline) return last;
    await rt.sleep(delay);
    delay = Math.min(delay * 2, 15_000);
  }
  return last;
}

async function maybeAbortOverdue(ctx: AppContext, client: ApifyClient, row: ApifyRunRow, warnings: string[]): Promise<void> {
  const opts = row.run_options_json ? (JSON.parse(row.run_options_json) as { timeoutSecs?: number }) : {};
  const timeoutSecs = opts.timeoutSecs ?? ctx.config.research.apify.maxRunSeconds;
  const start = Date.parse(row.started_at ?? row.submitted_at ?? row.created_at);
  if (ctx.clock.now().getTime() < start + (timeoutSecs + 15 * 60) * 1000) return;
  try {
    const run = await client.abortRun(row.remote_run_id!);
    updateFromRun(ctx, row.id, run);
    warnings.push(`Run ${row.remote_run_id} was overdue (past its ${timeoutSecs}s timeout + 15 min) and an abort was requested.`);
    recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType: 'apify.run_abort_requested', subjectType: 'apify_run', subjectId: row.id, details: { remoteRunId: row.remote_run_id } });
  } catch (err) {
    warnings.push(`Abort request failed (${(err as Error).message}); abort endpoint is unverified in integration-contracts.`);
  }
}

/**
 * Provider run ids already claimed by ANY site in this workspace. The Apify
 * account/token is shared by every site, so ownership of a remote run must be
 * checked workspace-wide (only provider run ids are read; no business data).
 */
function linkedRemoteRunIds(ctx: AppContext): Set<string> {
  const rows = ctx.db.all<{ id: string }>(
    `SELECT remote_run_id AS id FROM apify_runs WHERE remote_run_id IS NOT NULL
     UNION SELECT external_id AS id FROM provider_requests WHERE provider = 'apify' AND endpoint = ? AND external_id IS NOT NULL`,
    [START_ENDPOINT],
  );
  return new Set(rows.map((r) => r.id));
}

type ListedRun = { id: string; startedAt?: string | null; buildNumber?: string | null; meta?: { origin?: string | null } | null };

/** Unlinked API-origin runs of the pinned build that started in the submission window. */
function windowCandidates<T extends ListedRun>(items: readonly T[], row: ApifyRunRow, linked: ReadonlySet<string>, graceMs: number): T[] {
  const submittedAt = Date.parse(row.submitted_at ?? row.created_at);
  return items.filter((r) => {
    if (linked.has(r.id)) return false;
    if (row.build && r.buildNumber && r.buildNumber !== row.build) return false;
    if (r.meta?.origin && r.meta.origin !== 'API') return false;
    const t = r.startedAt ? Date.parse(r.startedAt) : NaN;
    return Number.isNaN(t) || (t >= submittedAt - 5 * 60_000 && t <= submittedAt + graceMs);
  });
}

function storedSchemaDefaults(ctx: AppContext, schemaId: string | null): Record<string, unknown> {
  if (!schemaId) return {};
  const r = ctx.db.get<{ input_schema_json: string | null }>('SELECT input_schema_json FROM apify_actor_schemas WHERE id = ?', [schemaId]);
  if (!r?.input_schema_json) return {};
  try {
    const schema = parseInputSchema(r.input_schema_json, 'stored schema');
    const out: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(schema.properties)) if (p.default !== undefined) out[k] = p.default;
    return out;
  } catch {
    return {};
  }
}

/**
 * Compare a provider run's INPUT record (the POST body is stored as `INPUT` in
 * the run's default key-value store, per the Run Actor docs) with the body this
 * submission sent. Every sent field must be present with an equal value; an
 * extra field is tolerated only when it equals the verified schema default
 * (whether the platform fills defaults into INPUT is unverified).
 */
async function verifyRunInput(ctx: AppContext, client: ApifyClient, run: ApifyRun, row: ApifyRunRow): Promise<{ verdict: 'match' | 'mismatch' | 'unverifiable'; detail: string }> {
  if (!run.defaultKeyValueStoreId) return { verdict: 'unverifiable', detail: 'the run reports no default key-value store' };
  let record: unknown;
  try {
    record = await loggedRead(ctx, 'apify.kv.record.get', { storeId: run.defaultKeyValueStoreId, key: 'INPUT' }, () => client.getKeyValueRecord(run.defaultKeyValueStoreId!, 'INPUT'));
  } catch (err) {
    return { verdict: 'unverifiable', detail: `INPUT record unreadable (${redactString((err as Error).message)})` };
  }
  if (record === null || record === undefined) return { verdict: 'unverifiable', detail: 'INPUT record not found' };
  if (typeof record !== 'object' || Array.isArray(record)) return { verdict: 'mismatch', detail: 'INPUT record is not a JSON object' };
  const sent = safeJson(row.input_json);
  const rec = record as Record<string, unknown>;
  for (const [k, v] of Object.entries(sent)) {
    if (!(k in rec) || hashObject(rec[k]) !== hashObject(v)) return { verdict: 'mismatch', detail: `INPUT field "${k}" differs from the submitted input` };
  }
  const defaults = storedSchemaDefaults(ctx, row.schema_id);
  for (const [k, v] of Object.entries(rec)) {
    if (k in sent) continue;
    if (!(k in defaults) || hashObject(defaults[k]) !== hashObject(v)) return { verdict: 'mismatch', detail: `INPUT has field "${k}" that was not submitted` };
  }
  return { verdict: 'match', detail: 'INPUT record equals the submitted input' };
}

/**
 * Reconcile an ambiguous submission against provider run history. A
 * candidate must have started in the window after submission, not be linked
 * to any local run of any site, match the pinned build and the run options
 * (charge cap, timeout, memory, input body length), and its INPUT record must
 * equal the submitted input. Exactly one verified match with no competing
 * local claimant is adopted. A candidate whose input cannot be verified is
 * never adopted. With no candidate after the grace window, the submission is
 * probably not accepted: the run is quarantined but the reservation stays
 * unresolved until the owner confirms (absence from list-runs is an inference).
 */
export async function reconcileAmbiguousStart(
  ctx: AppContext,
  client: ApifyClient,
  row: ApifyRunRow,
  rt: Rt,
): Promise<{ outcome: 'adopted' | 'pending' | 'not_accepted' | 'multiple' | 'unmatched' | 'unverifiable' | 'error'; detail: string; nextStep?: string; candidates?: string[] }> {
  const submittedAtIso = row.submitted_at ?? row.created_at;
  const submittedAt = Date.parse(submittedAtIso);
  const now = ctx.clock.now().getTime();
  const windowStart = new Date(submittedAt - 5 * 60_000).toISOString();
  let list: { items: ListedRun[]; complete: boolean };
  try {
    list = await loggedRead(ctx, 'apify.actor.runs.list', { actorId: row.actor_id, startedAfter: windowStart }, () => client.listRunsAll(row.actor_id, { startedAfter: windowStart, pageSize: 100, maxPages: 5 }));
  } catch (err) {
    return { outcome: 'error', detail: `Could not list Apify runs to reconcile (${(err as Error).message}); the reservation stays held.`, nextStep: 'Retry `apify runs --resume` later.' };
  }
  const candidates = windowCandidates(list.items, row, linkedRemoteRunIds(ctx), rt.reconcileGraceMs);
  const opts = row.run_options_json ? (JSON.parse(row.run_options_json) as { timeoutSecs?: number; memoryMbytes?: number }) : {};
  const bodyLen = Buffer.byteLength(row.input_json, 'utf8');
  const matches: ApifyRun[] = [];
  const unverifiable: Array<{ id: string; detail: string }> = [];
  for (const c of candidates.slice(0, 20)) {
    let full: ApifyRun;
    try {
      full = await client.getRun(c.id);
    } catch {
      unverifiable.push({ id: c.id, detail: 'run details unreadable' });
      continue;
    }
    // Cheap pre-filters; the INPUT comparison below is what proves ownership.
    if (typeof full.stats?.inputBodyLen === 'number' && full.stats.inputBodyLen !== bodyLen) continue;
    const cap = usdToMicros(full.options?.maxTotalChargeUsd);
    if (cap !== null && row.max_total_charge_usd_micros !== null && cap !== row.max_total_charge_usd_micros) continue;
    if (typeof full.options?.timeoutSecs === 'number' && opts.timeoutSecs !== undefined && full.options.timeoutSecs !== opts.timeoutSecs) continue;
    if (typeof full.options?.memoryMbytes === 'number' && opts.memoryMbytes !== undefined && full.options.memoryMbytes !== opts.memoryMbytes) continue;
    const v = await verifyRunInput(ctx, client, full, row);
    if (v.verdict === 'match') matches.push(full);
    else if (v.verdict === 'unverifiable') unverifiable.push({ id: full.id, detail: v.detail });
  }
  const held = 'the reservation stays held (unresolved)';
  if (matches.length === 1 && unverifiable.length === 0) {
    const run = matches[0]!;
    // Another pending ambiguous submission (any site) with the identical input could own this run: never guess.
    const claimants = ctx.db.all<{ id: string; site_id: string }>(
      `SELECT id, site_id FROM apify_runs WHERE id != ? AND actor_id = ? AND input_hash = ? AND status = 'ambiguous' AND remote_run_id IS NULL AND processing_status = 'pending'`,
      [row.id, row.actor_id, row.input_hash],
    );
    if (claimants.length > 0) {
      return {
        outcome: 'multiple',
        detail: `Provider run ${run.id} matches this submission, but ${claimants.length} other pending ambiguous submission(s) with the identical input could own it; not adopting automatically; ${held}.`,
        nextStep: `Check run ${run.id} in the Apify console (compare start times) before resolving.`,
        candidates: [run.id],
      };
    }
    persistRemoteRun(ctx, row.id, row.provider_request_id, run);
    if (row.provider_request_id) ctx.requests.complete(row.provider_request_id, { status: 'reconciled', externalId: run.id });
    recordAudit(ctx.db, { siteId: ctx.siteId, actor: 'system', eventType: 'apify.ambiguous_adopted', subjectType: 'apify_run', subjectId: row.id, details: { remoteRunId: run.id, verifiedBy: 'INPUT record' } });
    return { outcome: 'adopted', detail: `Ambiguous submission matched provider run ${run.id} (INPUT record verified); adopted (no duplicate run started).` };
  }
  if (matches.length + unverifiable.length > 1 || (matches.length === 1 && unverifiable.length > 0)) {
    const ids = [...matches.map((m) => m.id), ...unverifiable.map((u) => u.id)];
    return {
      outcome: 'multiple',
      detail: `Ambiguous submission could match ${ids.length} provider runs (${matches.length} verified by INPUT, ${unverifiable.length} unverifiable); not adopting any automatically; ${held}.`,
      nextStep: `Inspect runs ${ids.join(', ')} in the Apify console.`,
      candidates: ids,
    };
  }
  if (unverifiable.length === 1) {
    const u = unverifiable[0]!;
    return {
      outcome: 'unverifiable',
      detail: `Provider run ${u.id} fits the submission window and options, but its input could not be verified (${u.detail}); it is never adopted without verification; ${held}.`,
      nextStep: `Inspect run ${u.id} in the Apify console, then retry \`apify runs --resume\`.`,
      candidates: [u.id],
    };
  }
  if (candidates.length > 0) {
    return {
      outcome: 'unmatched',
      detail: `${candidates.length} unlinked provider run(s) started in the submission window but none matched the fingerprint and INPUT; ${held}.`,
      nextStep: `Check runs ${candidates.slice(0, 5).map((c) => c.id).join(', ')} in the Apify console.`,
      candidates: candidates.map((c) => c.id),
    };
  }
  if (list.complete && now - submittedAt > rt.reconcileGraceMs) {
    const reason =
      'ambiguous submission not found in provider run history after the grace window (probably not accepted); ' +
      'the reservation stays unresolved until the owner confirms with `apify runs --confirm-not-accepted <id>`';
    ctx.db.transaction(() => {
      if (row.reservation_id) ctx.budgets.markUnresolved(row.reservation_id, 'ambiguous submission not found in provider run history; awaiting owner confirmation');
      quarantine(ctx, row.id, reason, { completeRequest: false });
    });
    recordAudit(ctx.db, {
      siteId: ctx.siteId,
      actor: 'system',
      eventType: 'apify.ambiguous_not_found',
      subjectType: 'apify_run',
      subjectId: row.id,
      details: { windowStart, checkedAt: new Date(now).toISOString(), listedRuns: list.items.length },
    });
    return {
      outcome: 'not_accepted',
      detail: 'No provider run matches this submission after the grace window: it was probably not accepted. Nothing to fetch; the reservation stays unresolved (an absence in list-runs is an inference, not a provider-reported $0).',
      nextStep: `Confirm in the Apify console that no run exists, then run \`apify runs --confirm-not-accepted ${row.id}\` to record $0 as an owner confirmation.`,
    };
  }
  return { outcome: 'pending', detail: 'No matching provider run yet; the reservation stays held.', nextStep: 'Run `apify runs --resume` again later.' };
}

export interface ConfirmNotAcceptedResult {
  status: 'confirmed' | 'refused' | 'dry_run' | 'not_found';
  detail: string;
  nextStep?: string;
  apifyRunId: string;
  liveCheck: 'absent' | 'candidates_found' | 'skipped' | 'error';
}

/**
 * Owner confirmation that a quarantined ambiguous submission was never
 * accepted by Apify (checked in the Apify console). Records the reservation
 * as $0 with source `manual` and the evidence in usage_json. When the network
 * is available, list-runs is re-checked first (free read) and the
 * confirmation is refused if an unlinked candidate run appeared.
 */
export async function confirmNotAccepted(
  ctx: AppContext,
  apifyRunId: string,
  opts: { client?: ApifyClient; runtime?: ApifyRuntimeOptions; /** Audit actor ('cli' or 'owner:<name>'). */ actor?: string } = {},
): Promise<ConfirmNotAcceptedResult> {
  const rt = rtOf(opts.runtime);
  const row = ctx.db.get<ApifyRunRow>('SELECT * FROM apify_runs WHERE id = ? AND site_id = ?', [apifyRunId, ctx.siteId]);
  if (!row) return { status: 'not_found', detail: `Apify run ${apifyRunId} not found for site ${ctx.siteId}.`, apifyRunId, liveCheck: 'skipped' };
  const res = row.reservation_id ? ctx.db.get<{ status: string }>('SELECT status FROM budget_reservations WHERE id = ?', [row.reservation_id]) : undefined;
  if (row.remote_run_id || row.processing_status !== 'quarantined' || !row.quarantine_reason?.startsWith('ambiguous submission not found') || res?.status !== 'unresolved') {
    return {
      status: 'refused',
      detail: 'Only a quarantined ambiguous submission that was not found in provider run history, with an unresolved reservation, can be confirmed as not accepted.',
      apifyRunId,
      liveCheck: 'skipped',
    };
  }
  if (ctx.dryRun) return { status: 'dry_run', detail: `Dry run: would record $0 (owner confirmation) for reservation ${row.reservation_id}.`, apifyRunId, liveCheck: 'skipped' };
  let liveCheck: ConfirmNotAcceptedResult['liveCheck'] = 'skipped';
  if (!ctx.offline && ctx.secrets.has('APIFY_TOKEN')) {
    const client = opts.client ?? createApifyClient(ctx, { sleep: rt.sleep });
    try {
      const windowStart = new Date(Date.parse(row.submitted_at ?? row.created_at) - 5 * 60_000).toISOString();
      const list = await loggedRead(ctx, 'apify.actor.runs.list', { actorId: row.actor_id, startedAfter: windowStart }, () => client.listRunsAll(row.actor_id, { startedAfter: windowStart, pageSize: 100, maxPages: 5 }));
      const unlinked = windowCandidates(list.items, row, linkedRemoteRunIds(ctx), rt.reconcileGraceMs);
      if (unlinked.length) {
        return {
          status: 'refused',
          detail: `Unlinked provider run(s) ${unlinked.slice(0, 5).map((r) => r.id).join(', ')} started after this submission; not confirming. The reservation stays unresolved.`,
          nextStep: 'Inspect those runs in the Apify console before resolving this charge.',
          apifyRunId,
          liveCheck: 'candidates_found',
        };
      }
      liveCheck = 'absent';
    } catch {
      liveCheck = 'error';
    }
  }
  const at = ctx.clock.now().toISOString();
  ctx.budgets.reconcile(row.reservation_id!, {
    actualMicros: 0,
    source: 'manual',
    usage: {
      confirmation: 'owner confirmed the ambiguous submission was not accepted by Apify (no run in the Apify console)',
      inference: 'no matching run appeared in provider run history after the grace window',
      liveListRunsRecheck: liveCheck,
      confirmedAt: at,
    },
    ...(row.provider_request_id ? { providerRequestId: row.provider_request_id } : {}),
  });
  if (row.provider_request_id) ctx.requests.complete(row.provider_request_id, { status: 'failed', error: { reason: 'owner confirmed not accepted' } });
  recordAudit(ctx.db, { siteId: ctx.siteId, actor: opts.actor ?? 'cli', eventType: 'apify.not_accepted_confirmed', subjectType: 'apify_run', subjectId: row.id, details: { reservationId: row.reservation_id, liveCheck } });
  return { status: 'confirmed', detail: `Recorded $0 for run ${row.id} as an owner confirmation (source manual; live list-runs re-check: ${liveCheck}).`, apifyRunId, liveCheck };
}

/** Build a result summary from the stored row (no network). */
export function summarizeRun(ctx: AppContext, rowId: string): ContentResearchResult {
  const row = loadRow(ctx, rowId);
  const res = row.reservation_id
    ? ctx.db.get<{ status: string; estimated_usd_micros: number; actual_usd_micros: number | null; cost_status: string }>(
        'SELECT status, estimated_usd_micros, actual_usd_micros, cost_status FROM budget_reservations WHERE id = ?',
        [row.reservation_id],
      )
    : undefined;
  const ledger = row.provider_request_id ? ctx.db.get<{ source: string }>('SELECT source FROM cost_ledger WHERE provider_request_id = ?', [row.provider_request_id]) : undefined;
  let costStatus: NonNullable<ContentResearchResult['cost']>['costStatus'] = 'none';
  if (res) {
    if (res.status === 'released') costStatus = 'released';
    else if (res.status === 'reserved') costStatus = 'reserved';
    else if (res.status === 'unresolved') costStatus = 'unknown';
    else costStatus = ledger?.source === 'computed_from_usage' ? 'computed' : 'actual';
  }
  const status: ResearchStatus =
    row.processing_status === 'complete'
      ? 'completed'
      : row.processing_status === 'quarantined'
        ? 'quarantined'
        : row.processing_status === 'abandoned'
          ? 'abandoned'
          : row.status === 'ambiguous'
            ? 'ambiguous'
            : 'running';
  return {
    status,
    detail: row.quarantine_reason ?? `status ${row.status}`,
    apifyRunId: row.id,
    remoteRunId: row.remote_run_id,
    remoteStatus: row.remote_status,
    ...(row.quarantine_reason ? { quarantineReason: row.quarantine_reason } : {}),
    cost: {
      reservationId: row.reservation_id,
      reservedMicros: res ? res.estimated_usd_micros : null,
      capMicros: row.max_total_charge_usd_micros,
      actualMicros: res?.status === 'reconciled' ? res.actual_usd_micros : null,
      costStatus,
    },
    warnings: [],
  };
}

export interface ResumeReport {
  status: 'ok' | 'offline' | 'missing_credentials' | 'disabled' | 'dry_run';
  detail: string;
  nextStep?: string;
  runs: ContentResearchResult[];
  usageReconciled: Array<{ apifyRunId: string; status: string; actualMicros: Micros | null; notes?: string[] }>;
}

/** Runs of this site with an outstanding submission, poll, fetch, or normalization (what a resume advances). */
function pendingRunIds(ctx: AppContext): Array<{ id: string }> {
  return ctx.db.all<{ id: string }>(
    `SELECT id FROM apify_runs WHERE site_id = ? AND processing_status = 'pending' AND provider_request_id IS NOT NULL ORDER BY created_at`,
    [ctx.siteId],
  );
}

/** Finished runs of this site whose charge is still unresolved (a resume re-checks their usage). */
function unresolvedChargeRuns(ctx: AppContext): ApifyRunRow[] {
  return ctx.db.all<ApifyRunRow>(
    `SELECT a.* FROM apify_runs a JOIN budget_reservations b ON b.id = a.reservation_id
     WHERE a.site_id = ? AND a.processing_status IN ('complete', 'quarantined') AND a.remote_run_id IS NOT NULL AND b.status = 'unresolved'`,
    [ctx.siteId],
  );
}

/**
 * Resume every pending run for this site: reconcile ambiguous submissions,
 * poll known runs, fetch and normalize finished runs, and retry usage
 * reconciliation for runs whose charge is still unresolved.
 *
 * With nothing to resume (no pending run and no unresolved charge, read from
 * the database first) the status is `ok` ("No pending Apify runs.") in every
 * mode: nothing needed Apify, so a dry run, offline mode, or a missing token
 * is not reported as skipped work. With work outstanding they return
 * `dry_run`, `offline`, or `missing_credentials` and contact nothing.
 */
export async function resumeApifyRuns(
  ctx: AppContext,
  opts: { client?: ApifyClient; runtime?: ApifyRuntimeOptions; classifier?: SignalClassifier; waitForCompletion?: boolean; abortOverdue?: boolean } = {},
): Promise<ResumeReport> {
  const rt = rtOf(opts.runtime);
  const pending = pendingRunIds(ctx);
  if (!pending.length && !unresolvedChargeRuns(ctx).length) return { status: 'ok', detail: 'No pending Apify runs.', runs: [], usageReconciled: [] };
  if (ctx.dryRun) return { status: 'dry_run', detail: 'Dry run: pending Apify runs were not contacted.', runs: [], usageReconciled: [] };
  if (ctx.offline) return { status: 'offline', detail: 'Offline/demo mode: pending Apify runs were not contacted.', runs: [], usageReconciled: [] };
  const missing = tokenStatus(ctx);
  if (missing) return { status: 'missing_credentials', detail: missing.detail, ...(missing.nextStep ? { nextStep: missing.nextStep } : {}), runs: [], usageReconciled: [] };
  const client = opts.client ?? createApifyClient(ctx, { sleep: rt.sleep });
  const runs: ContentResearchResult[] = [];
  for (const p of pending) {
    try {
      runs.push(await advanceRun(ctx, client, p.id, rt, { classifier: opts.classifier, waitForCompletion: opts.waitForCompletion ?? false, abortOverdue: !!opts.abortOverdue }));
    } catch (err) {
      runs.push({ ...summarizeRun(ctx, p.id), detail: `Resume failed: ${redactString((err as Error).message)}`, warnings: [] });
    }
  }
  const usageReconciled: ResumeReport['usageReconciled'] = [];
  // Read again after the pending runs were advanced: a run finished above may have left its charge unresolved.
  const unresolved = unresolvedChargeRuns(ctx);
  for (const row of unresolved) {
    try {
      const run = await client.getRun(row.remote_run_id!);
      updateFromRun(ctx, row.id, run);
      const items = row.observed_result_items ?? undefined;
      const r = reconcileUsage(ctx, loadRow(ctx, row.id), run, { started: runRan(run, items), ...(items !== undefined ? { resultItems: items } : {}) });
      usageReconciled.push({ apifyRunId: row.id, status: r.status, actualMicros: r.actualMicros, ...(r.notes.length ? { notes: r.notes } : {}) });
    } catch (err) {
      usageReconciled.push({ apifyRunId: row.id, status: `error: ${redactString((err as Error).message)}`, actualMicros: null });
    }
  }
  return { status: 'ok', detail: `${pending.length} pending run(s) processed; ${unresolved.length} unresolved charge(s) re-checked.`, runs, usageReconciled };
}

export interface ApifyRunListing {
  id: string;
  remoteRunId: string | null;
  status: string;
  processingStatus: string;
  remoteStatus: string | null;
  build: string | null;
  createdAt: string;
  itemsFetched: number;
  signalsCreated: number | null;
  capMicros: number | null;
  usageMicros: number | null;
  reservationStatus: string | null;
  quarantineReason: string | null;
  isSynthetic: boolean;
  purpose: string | null;
}

export function listApifyRuns(ctx: AppContext, limit = 50): ApifyRunListing[] {
  return ctx.db
    .all<ApifyRunRow & { reservation_status: string | null }>(
      `SELECT a.*, b.status AS reservation_status FROM apify_runs a LEFT JOIN budget_reservations b ON b.id = a.reservation_id
       WHERE a.site_id = ? ORDER BY a.created_at DESC LIMIT ?`,
      [ctx.siteId, limit],
    )
    .map((r) => ({
      id: r.id,
      remoteRunId: r.remote_run_id,
      status: r.status,
      processingStatus: r.processing_status,
      remoteStatus: r.remote_status,
      build: r.build,
      createdAt: r.created_at,
      itemsFetched: r.items_fetched,
      signalsCreated: r.signals_created,
      capMicros: r.max_total_charge_usd_micros,
      usageMicros: r.usage_total_usd_micros,
      reservationStatus: r.reservation_status,
      quarantineReason: r.quarantine_reason,
      isSynthetic: r.is_synthetic === 1,
      purpose: r.purpose,
    }));
}

// ---------------------------------------------------------------------------
// Content research batch (CLI `apify research`): one bounded run per community
// ---------------------------------------------------------------------------

/** Reddit community names accepted for `withinCommunity` ("name" or "r/name"; URLs are refused). */
export const COMMUNITY_NAME_RE = /^(?:r\/)?[A-Za-z0-9][A-Za-z0-9_]{1,20}$/;

export interface ResearchBatchOptions extends Omit<ContentResearchOptions, 'withinCommunity' | 'expectedPlan' | 'maxTotalChargeUsdMicros' | 'waitForCompletion'> {
  /**
   * Communities to research. Each gets its own bounded run restricted with
   * `withinCommunity`; empty/absent = one run without a community restriction.
   * Defaults are the caller's choice (the CLI uses research.subreddits).
   */
  communities?: readonly string[];
  /** Total provider-side cap across ALL runs of the batch; split evenly (and each run stays within research.apify.maxTotalChargeUsd). */
  totalCapMicros: Micros;
}

export interface ResearchBatchRun {
  community: string | null;
  result: ContentResearchResult;
}

export interface ResearchBatchResult {
  status: 'dry_run' | 'completed' | 'partial' | 'stopped' | 'rejected';
  detail: string;
  runs: ResearchBatchRun[];
  totalCapMicros: Micros;
  perRunCapMicros: Micros;
  /** Sum of the provider caps of the planned (or started) runs; never above totalCapMicros. */
  plannedCapMicros: Micros | null;
  /** Hash binding a confirmation to exactly the runs shown (community, input hash, cap per run). Null when a run could not be planned. */
  planHash: string | null;
  errors: string[];
  warnings: string[];
}

function batchPlanHash(runs: readonly ResearchBatchRun[]): string | null {
  if (!runs.length || runs.some((r) => !r.result.plan)) return null;
  return hashObject(runs.map((r) => ({ community: r.community, inputHash: r.result.plan!.inputHash, capMicros: r.result.plan!.capMicros })));
}

function batchCommunities(opts: ResearchBatchOptions): { list: Array<string | null>; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  const list: Array<string | null> = [];
  for (const raw of opts.communities ?? []) {
    const c = raw.trim();
    if (!c) continue;
    if (!COMMUNITY_NAME_RE.test(c)) {
      errors.push(`Community "${c.slice(0, 80)}" is not a subreddit name ("name" or "r/name"); URLs and other inputs are not sent.`);
      continue;
    }
    const key = c.replace(/^r\//i, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(c);
  }
  if (!list.length && !errors.length) list.push(null);
  return { list, errors };
}

function perRunCap(ctx: AppContext, total: Micros, runs: number): Micros {
  return Math.min(toMicros(ctx.config.research.apify.maxTotalChargeUsd), Math.floor(total / Math.max(1, runs)));
}

/**
 * Plan a research batch WITHOUT spending: one dry-run plan per community with
 * the total cap split evenly. The owner sees every run's input, bounds, and cap
 * and the batch plan hash before anything is sent.
 */
export async function planContentResearchBatch(ctx: AppContext, opts: ResearchBatchOptions): Promise<ResearchBatchResult> {
  const { list, errors } = batchCommunities(opts);
  const total = opts.totalCapMicros;
  const base = { totalCapMicros: total, runs: [] as ResearchBatchRun[], warnings: [] as string[] };
  if (!Number.isSafeInteger(total) || total <= 0) errors.push('The total charge cap must be greater than $0.');
  if (errors.length) return { ...base, status: 'rejected', detail: 'The research batch could not be planned.', perRunCapMicros: 0, plannedCapMicros: null, planHash: null, errors };
  const cap = perRunCap(ctx, total, list.length);
  const { communities: _c, totalCapMicros: _t, ...runOpts } = opts;
  void _c;
  void _t;
  const runs: ResearchBatchRun[] = [];
  for (const community of list) {
    const result = await runContentResearch({ ...ctx, dryRun: true }, { ...runOpts, maxTotalChargeUsdMicros: cap, ...(community ? { withinCommunity: community } : {}) });
    runs.push({ community, result });
  }
  const warnings: string[] = [];
  if (list.length > 1) warnings.push(`${list.length} runs (one per community), each capped at ${formatUsd(cap)} so the batch total stays within ${formatUsd(total)}.`);
  if (cap < Math.floor(total / list.length)) warnings.push(`Each run is also limited by research.apify.maxTotalChargeUsd (${formatUsd(cap)} per run).`);
  const planned = runs.every((r) => r.result.plan) ? runs.reduce((s, r) => s + r.result.plan!.capMicros, 0) : null;
  const allPlanned = runs.every((r) => r.result.status === 'dry_run');
  return {
    ...base,
    status: allPlanned ? 'dry_run' : 'rejected',
    detail: allPlanned
      ? `Planned ${runs.length} run(s); provider caps total ${formatUsd(planned)} of the ${formatUsd(total)} allowed. Nothing was sent.`
      : `${runs.filter((r) => r.result.status !== 'dry_run').length} of ${runs.length} run(s) could not be planned; nothing was sent.`,
    runs,
    perRunCapMicros: cap,
    plannedCapMicros: planned,
    planHash: allPlanned ? batchPlanHash(runs) : null,
    errors: [],
    warnings,
  };
}

/** Statuses after which the rest of a batch is not started (spend safety or configuration). */
const BATCH_STOP: ReadonlySet<ResearchStatus> = new Set(['budget_exceeded', 'budget_unknown_price', 'confirmation_required', 'policy_denied', 'misconfigured', 'missing_credentials', 'disabled', 'offline', 'ambiguous', 'submission_rejected']);

/**
 * Run a batch that was planned (and shown) with `planContentResearchBatch`.
 * Each run is bound to the plan shown (its cap may only be lower and its
 * input must be identical, otherwise nothing is sent for it), runs are
 * sequential, and the cumulative provider cap is checked before each start.
 */
export async function runContentResearchBatch(ctx: AppContext, opts: ResearchBatchOptions, shown: ResearchBatchResult): Promise<ResearchBatchResult> {
  const out: ResearchBatchRun[] = [];
  const warnings = [...shown.warnings];
  if (shown.status !== 'dry_run' || !shown.planHash) {
    return { ...shown, status: 'rejected', detail: 'Only a fully planned batch can be started; nothing was sent.' };
  }
  const { communities: _c, totalCapMicros: _t, ...runOpts } = opts;
  void _c;
  void _t;
  let committed = 0;
  let stopped: string | null = null;
  for (const planned of shown.runs) {
    const plan = planned.result.plan!;
    if (stopped) {
      out.push({ community: planned.community, result: { status: 'rejected', detail: `Not started: ${stopped}`, plan, warnings: [] } });
      continue;
    }
    if (committed + plan.capMicros > shown.totalCapMicros) {
      stopped = `the cumulative provider cap would exceed ${formatUsd(shown.totalCapMicros)}`;
      out.push({ community: planned.community, result: { status: 'rejected', detail: `Not started: ${stopped}.`, plan, warnings: [] } });
      continue;
    }
    const result = await runContentResearch(ctx, {
      ...runOpts,
      ...(planned.community ? { withinCommunity: planned.community } : {}),
      maxTotalChargeUsdMicros: plan.capMicros,
      expectedPlan: { capMicros: plan.capMicros, inputHash: plan.inputHash },
      waitForCompletion: true,
    });
    // A started (or possibly started) run counts against the batch cap at its full provider cap.
    if (result.apifyRunId && result.status !== 'reused') committed += result.cost?.capMicros ?? plan.capMicros;
    out.push({ community: planned.community, result });
    if (BATCH_STOP.has(result.status)) stopped = `run for ${planned.community ?? 'all communities'} ended ${result.status}`;
  }
  const good = out.filter((r) => r.result.status === 'completed' || r.result.status === 'reused').length;
  const status: ResearchBatchResult['status'] = stopped ? 'stopped' : good === out.length ? 'completed' : 'partial';
  return {
    ...shown,
    status,
    detail: `${good} of ${out.length} run(s) completed or reused; provider caps committed ${formatUsd(committed)} of ${formatUsd(shown.totalCapMicros)}.${stopped ? ` Stopped: ${stopped}.` : ''}`,
    runs: out,
    warnings,
  };
}

/**
 * Store a SYNTHETIC dataset (demo/tests) through the same normalization path.
 * Rows are flagged is_synthetic = 1 and limitations say so; no network, no
 * budget, and no provider request are involved.
 */
export function ingestSyntheticDataset(ctx: AppContext, items: readonly unknown[], meta: { label: string; timeRange?: string; searchTerms?: string[] }): { apifyRunId: string; signals: PersistSignalsResult; normalized: number } {
  const id = newId('arun');
  const now = ctx.clock.now().toISOString();
  const input = { _synthetic: true, label: meta.label, searchTerms: meta.searchTerms ?? [], searchTime: meta.timeRange ?? null };
  ctx.db.run(
    `INSERT INTO apify_runs (id, site_id, provider_request_id, actor_id, build, remote_run_id, status, input_json, input_hash, items_fetched, is_synthetic, created_at, updated_at,
       processing_status, remote_status, purpose, started_at, finished_at)
     VALUES (?, ?, NULL, ?, NULL, NULL, 'SUCCEEDED', ?, ?, ?, 1, ?, ?, 'complete', 'SUCCEEDED', ?, ?, ?)`,
    [id, ctx.siteId, REDDIT_SCRAPER_ACTOR_ID, JSON.stringify(input), hashObject(input), items.length, now, now, `synthetic: ${meta.label}`, now, now],
  );
  const normalized = normalizeDatasetItems(items);
  const signals = persistSignals(ctx.db, {
    siteId: ctx.siteId,
    apifyRunId: id,
    items: normalized.items,
    classification: heuristicClassify(normalized.items),
    collectedAt: now,
    collectionWindow: { synthetic: true, label: meta.label, searchTime: meta.timeRange ?? null },
    rawRef: null,
    isSynthetic: true,
  });
  ctx.db.run('UPDATE apify_runs SET signals_created = ?, items_normalized = ? WHERE id = ?', [signals.created, normalized.items.length, id]);
  return { apifyRunId: id, signals, normalized: normalized.items.length };
}
