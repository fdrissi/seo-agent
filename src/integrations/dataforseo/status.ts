import type { AppContext } from '../../app/context.js';
import { errorMessage, isAppError } from '../../core/errors.js';
import type { IntegrationStatus } from '../types.js';
import { createDataForSeoClient, inspectDataForSeoSetup, type DataForSeoClientOptions, type DataForSeoMode } from './client.js';
import { DataForSeoApiError } from './envelope.js';
import { pricingOverrideWarnings, pricingSummary } from './pricing.js';

/**
 * Honest DataForSEO status. The optional network check uses only
 * `GET appendix/user_data`, which is documented as free (DF15). It is never
 * chargeable. The account login returned by that endpoint is never printed.
 */

export const DATAFORSEO_SENDS_EXTERNALLY = [
  'API login/password via HTTP Basic auth (to api.dataforseo.com or sandbox.dataforseo.com only)',
  'search queries selected for SERP research (keyword, location code, language code, device, depth)',
  'keyword lists for Google Ads search-volume estimates (with location and language codes)',
  'task tags: random local task ids (no site or personal data)',
];

export interface DataForSeoStatus extends IntegrationStatus {
  mode: DataForSeoMode | null;
  configMode: 'disabled' | 'sandbox' | 'live';
  queue: 'standard' | 'live';
  isSandbox: boolean;
  pendingTasks: number;
  ambiguousTasks: number;
  /** Account balance reported by the free user_data endpoint (USD string), when checked. */
  accountBalanceUsd: string | null;
  pricing: ReturnType<typeof pricingSummary>;
  /** Problems with research.dataforseo.pricingOverrides (e.g. unrecognized keys that are silently unused otherwise). */
  pricingWarnings: string[];
  notes: string[];
}

function money(v: unknown): string | null {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) : null;
}

export async function dataforseoStatus(ctx: AppContext, opts: { network: boolean } & DataForSeoClientOptions): Promise<DataForSeoStatus> {
  const setup = inspectDataForSeoSetup(ctx, opts);
  const counts = ctx.db.get<{ pending: number; ambiguous: number }>(
    `SELECT SUM(CASE WHEN status IN ('submitting', 'queued', 'ready') THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'ambiguous' THEN 1 ELSE 0 END) AS ambiguous
     FROM dataforseo_tasks WHERE site_id = ?`,
    [ctx.siteId],
  );
  const now = ctx.clock.now();
  const notes = [
    'No Google Ads account is needed for search-volume data (DF36).',
    'Paid tasks are reserved against budgets before submission and never retried blindly.',
    'Backlinks, Labs exports, and AI-visibility endpoints are disabled unless their feature flag is on AND the exact request is approved.',
  ];
  if (setup.isSandbox) notes.push('Sandbox/fixture results are synthetic (is_sandbox = 1) and never used in real recommendations.');
  const pricingWarnings = pricingOverrideWarnings(ctx.config);
  const base = {
    id: 'dataforseo' as const,
    sendsExternally: DATAFORSEO_SENDS_EXTERNALLY,
    checkedAt: now.toISOString(),
    chargeable: false,
    mode: setup.mode,
    configMode: setup.configMode,
    queue: setup.queue,
    isSandbox: setup.isSandbox,
    pendingTasks: Number(counts?.pending ?? 0),
    ambiguousTasks: Number(counts?.ambiguous ?? 0),
    accountBalanceUsd: null as string | null,
    pricing: pricingSummary(ctx.config, now),
    pricingWarnings,
    notes,
  };
  const blocker = setup.blockers[0];
  if (blocker?.offline && !ctx.synthetic) {
    // --offline is a per-invocation switch, not a configuration problem: the configuration is not judged at all.
    return {
      ...base,
      state: 'disabled',
      detail: `DataForSEO not used in this run: network access disabled (--offline). Nothing was sent; the configuration (${setup.configMode} mode, credentials ${setup.credentials}) was not checked against the provider.`,
      nextStep: 'Run without --offline to use DataForSEO (a status check with network enabled verifies the credentials with the free user_data call).',
      networkChecked: false,
    };
  }
  if (blocker) {
    const state =
      blocker.code === 'INTEGRATION_DISABLED' || blocker.code === 'POLICY_DENIED' ? 'disabled' : blocker.code === 'CREDENTIALS_MISSING' ? 'missing_credentials' : ctx.synthetic ? 'fixture' : 'misconfigured';
    return { ...base, state, detail: blocker.message, ...(blocker.hint ? { nextStep: blocker.hint } : {}), networkChecked: false };
  }
  if (setup.mode === 'fixture') {
    return { ...base, state: 'fixture', detail: 'Synthetic fixture transport: no network, no credentials, data flagged is_sandbox = 1.', networkChecked: false };
  }
  if (!opts.network) {
    return {
      ...base,
      state: 'configured_unverified',
      detail: `Credentials present; ${setup.mode} mode (${setup.mode === 'live' ? 'api.dataforseo.com' : 'sandbox.dataforseo.com'}); no network check performed.`,
      nextStep: 'Run the status check with network enabled (free user_data call) to verify the credentials.',
      networkChecked: false,
    };
  }
  try {
    const client = createDataForSeoClient(ctx, opts);
    // getFree requires the task-level status to be 20000 too, so an account
    // error inside HTTP 200 (e.g. 40104 verification required) is never 'ready'.
    const { envelope } = await client.getFree<{ money?: { balance?: unknown } }>('appendix/user_data');
    const balance = money(envelope.tasks[0]?.result?.[0]?.money?.balance);
    return {
      ...base,
      state: 'ready',
      detail: `Credentials accepted by the ${setup.mode} host (free user_data check).${setup.isSandbox ? ' Sandbox data is synthetic.' : ''}`,
      accountBalanceUsd: setup.isSandbox ? null : balance,
      networkChecked: true,
    };
  } catch (err) {
    return { ...base, state: statusStateFor(err), detail: `user_data check failed: ${errorMessage(err)}`, nextStep: nextStepFor(err), networkChecked: true };
  }
}

/** Map a failed user_data check to an honest state (never 'ready'). */
function statusStateFor(err: unknown): DataForSeoStatus['state'] {
  if (err instanceof DataForSeoApiError) {
    if (err.code === 'PERMISSION_DENIED') return 'permission_denied';
    // Credentials work but the account cannot run paid tasks (funds, provider-side cost limit).
    if (err.kind === 'funds' || err.kind === 'provider_cost_limit') return 'degraded';
    if (err.kind === 'server' || err.kind === 'rate_limit' || err.kind === 'concurrency') return 'unreachable';
    return 'misconfigured';
  }
  if (isAppError(err) && err.code === 'PERMISSION_DENIED') return 'permission_denied';
  return 'unreachable';
}

function nextStepFor(err: unknown): string {
  if (isAppError(err) && err.hint) return err.hint;
  if (err instanceof DataForSeoApiError && err.kind === 'server') return 'DataForSEO reported a server-side error; retry the free check later.';
  return 'Check network access and https://docs.dataforseo.com/v3/auth/.';
}
