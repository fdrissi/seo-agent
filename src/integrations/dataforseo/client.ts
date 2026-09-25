import type { AppContext } from '../../app/context.js';
import { sleep as realSleep } from '../../core/concurrency.js';
import { AppError, CredentialsMissingError, IntegrationDisabledError } from '../../core/errors.js';
import { redact } from '../../security/redact.js';
import { registerSecret } from '../../security/redact.js';
import type { FetchLike } from '../types.js';
import { requireEndpoint, type EndpointSpec } from './endpoints.js';
import { DFS_STATUS, DataForSeoApiError, mapStatusCode, type DfsEnvelope } from './envelope.js';
import { DataForSeoTransport, type TransportOutcome } from './transport.js';

/**
 * DataForSEO client: HTTP Basic auth from DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD
 * (DF1), production vs sandbox host (DF2, DF14), endpoint allowlist, and free
 * GET helpers with bounded retries. Paid POSTs go through tasks.ts, which
 * reserves budget and persists task state BEFORE sending.
 */

export type DataForSeoMode = 'live' | 'sandbox' | 'fixture';

/** Verified hosts (DF2, DF14). Paths are identical on both. */
export const DATAFORSEO_HOSTS = {
  live: 'https://api.dataforseo.com/v3',
  sandbox: 'https://sandbox.dataforseo.com/v3',
} as const;

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** Live tasks time out server-side after 120 s (50401, DF13); allow a margin. */
export const DEFAULT_LIVE_REQUEST_TIMEOUT_MS = 135_000;

export interface DataForSeoClientOptions {
  /**
   * Per-invocation mode. 'sandbox' (e.g. CLI --sandbox) and 'fixture'
   * (demo/tests; requires `fetch`) may always be selected. 'live' is only
   * possible when the site config says research.dataforseo.mode = live.
   */
  mode?: DataForSeoMode;
  /** Override the context fetch (fixture/demo transport). */
  fetch?: FetchLike;
  /** Override the host (tests with a local server). */
  baseUrl?: string;
  requestTimeoutMs?: number;
  liveRequestTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Create a client only to poll existing tasks (free GETs) even if config mode is now 'disabled'. */
  forPolling?: boolean;
}

export interface DataForSeoSetup {
  featureFlag: boolean;
  configMode: 'disabled' | 'sandbox' | 'live';
  /** Effective mode for this invocation, or null when DataForSEO cannot be used. */
  mode: DataForSeoMode | null;
  isSandbox: boolean;
  queue: 'standard' | 'live';
  credentials: 'present' | 'missing' | 'not_required';
  missing: string[];
  offline: boolean;
  /**
   * Human-readable blockers; empty when a client can be created. `offline`
   * marks the per-invocation network switch (--offline / demo), which is not
   * a configuration problem.
   */
  blockers: Array<{ code: 'INTEGRATION_DISABLED' | 'CREDENTIALS_MISSING' | 'INTEGRATION_UNAVAILABLE' | 'POLICY_DENIED'; message: string; hint?: string; offline?: true }>;
}

/** Inspect configuration without creating a client or touching the network. */
export function inspectDataForSeoSetup(ctx: AppContext, opts: DataForSeoClientOptions = {}): DataForSeoSetup {
  const cfg = ctx.config.research.dataforseo;
  const featureFlag = !!ctx.settings.features.dataforseo;
  const blockers: DataForSeoSetup['blockers'] = [];
  let mode: DataForSeoMode | null;
  if (opts.mode === 'fixture') mode = 'fixture';
  else if (opts.mode === 'sandbox') mode = 'sandbox';
  // Polling existing live tasks is free and retrieves already-paid results.
  else if (opts.mode === 'live') mode = cfg.mode === 'live' || opts.forPolling ? 'live' : null;
  else mode = cfg.mode === 'disabled' ? null : cfg.mode;

  if (!featureFlag) blockers.push({ code: 'INTEGRATION_DISABLED', message: 'features.dataforseo is off for this site/profile', hint: 'Set features.dataforseo: true in the site config (the full profile enables it by default).' });
  if (opts.mode === 'live' && mode === null) {
    blockers.push({ code: 'POLICY_DENIED', message: `live mode requested but research.dataforseo.mode is "${cfg.mode}"`, hint: 'Live (paid) mode is only enabled from the site config: research.dataforseo.mode: live.' });
  } else if (mode === null) {
    blockers.push({ code: 'INTEGRATION_DISABLED', message: 'research.dataforseo.mode is "disabled"', hint: 'Set research.dataforseo.mode: sandbox to try the free sandbox, or use --sandbox for one invocation.' });
  }
  if (mode === 'fixture' && !opts.fetch) blockers.push({ code: 'INTEGRATION_UNAVAILABLE', message: 'fixture mode needs an injected fixture transport' });

  const needsCreds = mode !== 'fixture';
  const missing: string[] = [];
  if (needsCreds) {
    if (!ctx.secrets.get('DATAFORSEO_LOGIN')) missing.push('DATAFORSEO_LOGIN');
    if (!ctx.secrets.get('DATAFORSEO_PASSWORD')) missing.push('DATAFORSEO_PASSWORD');
    if (missing.length) {
      blockers.push({
        code: 'CREDENTIALS_MISSING',
        message: `missing ${missing.join(', ')}`,
        hint: 'Create dedicated API credentials at https://app.dataforseo.com/api-access and put them in <workspace>/secrets/secrets.env (never in chat, the vault, or site config).',
      });
    }
  }
  // Offline/demo contexts never reach the network; only the synthetic fixture transport is allowed.
  const offlineBlocked = ctx.offline && mode !== 'fixture';
  if (offlineBlocked) blockers.push({ code: 'INTEGRATION_UNAVAILABLE', message: 'offline/demo mode: network requests are disabled', hint: 'Run without --offline, or use the synthetic fixture transport in the demo.', offline: true });

  return {
    featureFlag,
    configMode: cfg.mode,
    mode,
    isSandbox: mode === 'sandbox' || mode === 'fixture',
    queue: cfg.queue,
    credentials: needsCreds ? (missing.length ? 'missing' : 'present') : 'not_required',
    missing,
    offline: ctx.offline,
    blockers,
  };
}

export function throwForBlocker(setup: DataForSeoSetup): void {
  const b = setup.blockers[0];
  if (!b) return;
  if (b.code === 'INTEGRATION_DISABLED') throw new IntegrationDisabledError('dataforseo', b.message);
  if (b.code === 'CREDENTIALS_MISSING') throw new CredentialsMissingError('dataforseo', setup.missing, b.hint);
  throw new AppError(b.code, `dataforseo: ${b.message}`, b.hint ? { hint: b.hint } : {});
}

export interface FreeGetResult<R> {
  envelope: DfsEnvelope<R>;
  httpStatus: number;
  providerRequestId: string;
}

const transports = new WeakMap<DataForSeoClient, DataForSeoTransport>();

/** INTERNAL: the budget-free transport. Only tasks.ts/gated.ts may use it, after reserving budget. */
export function transportOf(client: DataForSeoClient): DataForSeoTransport {
  const t = transports.get(client);
  if (!t) throw new AppError('INTERNAL', 'DataForSEO client has no transport');
  return t;
}

export class DataForSeoClient {
  readonly isSandbox: boolean;
  readonly queue: 'standard' | 'live';

  constructor(
    readonly ctx: AppContext,
    readonly mode: DataForSeoMode,
    transport: DataForSeoTransport,
    readonly sleep: (ms: number) => Promise<void>,
  ) {
    this.isSandbox = mode !== 'live';
    this.queue = ctx.config.research.dataforseo.queue;
    transports.set(this, transport);
  }

  get baseUrl(): string {
    return transportOf(this).baseUrl;
  }

  endpoint(key: string): EndpointSpec {
    return requireEndpoint(key, this.ctx.settings.features);
  }

  /**
   * Free, allowlisted GET (lookups, tasks_ready, task_get, user_data). Logged
   * in provider_requests (is_paid = 0). Rate-limit and server errors are
   * retried with backoff (GETs are idempotent and free), at the response
   * level AND at the task level (DF13: errors arrive inside HTTP 200 in both
   * places).
   *
   * `taskStatus`:
   *  - 'ok_required' (default; lookups, tasks_ready, user_data): the response
   *    must contain at least one task and every task must be 20000. Anything
   *    else is raised as DataForSeoApiError (level 'task'), so an error is
   *    never mistaken for an empty result or a successful check.
   *  - 'caller' (task_get): task-level codes are the caller's to interpret
   *    (pending, no results, expired, ...). Transient ones are still retried;
   *    after the last attempt the envelope is returned as-is.
   */
  async getFree<R = unknown>(
    key: string,
    pathParams: Record<string, string> = {},
    opts: { externalId?: string; maxAttempts?: number; taskStatus?: 'ok_required' | 'caller' } = {},
  ): Promise<FreeGetResult<R>> {
    const spec = this.endpoint(key);
    if (spec.method !== 'GET' || spec.paid) throw new AppError('POLICY_DENIED', `${key} is not a free GET endpoint`);
    const ctx = this.ctx;
    const taskStatus = opts.taskStatus ?? 'ok_required';
    const preq = ctx.requests.prepare({ siteId: ctx.siteId, provider: 'dataforseo', endpoint: key, method: 'GET', isPaid: false, params: pathParams, isSynthetic: this.isSandbox });
    if (opts.externalId) ctx.requests.setExternalId(preq.id, opts.externalId);
    ctx.requests.markSubmitted(preq.id);
    const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    let error: AppError | null = null;
    let httpStatus: number | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const out: TransportOutcome<R> = await transportOf(this).request<R>(spec, { pathParams });
      const last = attempt === maxAttempts;
      if (out.kind === 'ok') {
        httpStatus = out.httpStatus;
        const tasks = out.envelope.tasks;
        if (taskStatus === 'caller') {
          const transient = tasks.find((t) => mapStatusCode(t.status_code).retryableGet);
          if (!transient || last) {
            ctx.requests.complete(preq.id, { status: 'succeeded', httpStatus: out.httpStatus });
            return { envelope: out.envelope, httpStatus: out.httpStatus, providerRequestId: preq.id };
          }
        } else {
          if (tasks.length === 0) {
            error = new AppError('PROVIDER_ERROR', `DataForSEO ${key}: the response contained no task (status ${out.envelope.status_code}); treated as a failure, not as empty data`, {
              details: { endpoint: key, level: 'task' },
            });
            break;
          }
          const bad = tasks.find((t) => t.status_code !== DFS_STATUS.OK);
          if (!bad) {
            ctx.requests.complete(preq.id, { status: 'succeeded', httpStatus: out.httpStatus });
            return { envelope: out.envelope, httpStatus: out.httpStatus, providerRequestId: preq.id };
          }
          const taskErr = new DataForSeoApiError({ endpoint: key, level: 'task', statusCode: bad.status_code, statusMessage: bad.status_message, httpStatus: out.httpStatus, ...(bad.id ? { taskId: bad.id } : {}) });
          error = taskErr;
          if (!taskErr.retryableGet || last) break;
        }
      } else {
        error = out.error;
        httpStatus = 'httpStatus' in out ? out.httpStatus : null;
        const retryable = out.kind === 'ambiguous' || (out.kind === 'rejected' && out.error.retryableGet);
        if (!retryable || last) break;
      }
      await this.sleep(Math.min(30_000, 1_000 * 2 ** (attempt - 1)));
    }
    const final = error ?? new AppError('PROVIDER_ERROR', `DataForSEO ${key} failed`);
    ctx.requests.complete(preq.id, { status: 'failed', httpStatus, error: redact(final.toJSON()) });
    throw final;
  }
}

/**
 * Create a client for this site. Throws INTEGRATION_DISABLED (feature flag
 * off or mode disabled), CREDENTIALS_MISSING, or INTEGRATION_UNAVAILABLE
 * (offline/demo without a fixture transport). Credentials are registered for
 * redaction and never logged.
 */
export function createDataForSeoClient(ctx: AppContext, opts: DataForSeoClientOptions = {}): DataForSeoClient {
  const setup = inspectDataForSeoSetup(ctx, opts);
  throwForBlocker(setup);
  const mode = setup.mode!;
  let authHeader: string | null = null;
  if (mode !== 'fixture') {
    const login = ctx.secrets.get('DATAFORSEO_LOGIN')!;
    const password = ctx.secrets.get('DATAFORSEO_PASSWORD')!;
    registerSecret(login);
    registerSecret(password);
    const token = Buffer.from(`${login}:${password}`, 'utf8').toString('base64');
    registerSecret(token);
    authHeader = `Basic ${token}`;
  }
  const sleep = opts.sleep ?? ((ms: number) => realSleep(ms));
  const transport = new DataForSeoTransport({
    baseUrl: opts.baseUrl ?? (mode === 'live' ? DATAFORSEO_HOSTS.live : DATAFORSEO_HOSTS.sandbox),
    authHeader,
    fetch: opts.fetch ?? ctx.fetch,
    timeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    liveTimeoutMs: opts.liveRequestTimeoutMs ?? DEFAULT_LIVE_REQUEST_TIMEOUT_MS,
    logger: ctx.logger.child({ integration: 'dataforseo', mode }),
    now: () => ctx.clock.now().getTime(),
    sleep,
  });
  return new DataForSeoClient(ctx, mode, transport, sleep);
}

export function isDataForSeoApiError(err: unknown): err is DataForSeoApiError {
  return err instanceof DataForSeoApiError;
}
