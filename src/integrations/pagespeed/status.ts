import type { AppContext } from '../../app/context.js';
import type { FetchLike, IntegrationStatus, StatusCheckOptions } from '../types.js';
import { publicOrigin, queryCruxRecord } from './crux.js';

/**
 * Honest status for PageSpeed Insights (lab) and the CrUX API (field).
 * Status checks never run a Lighthouse test (slow); with `network: true` and a
 * key, a single free CrUX origin query verifies the key.
 */

const PSI_SENDS = ['The page URL you ask about (Google fetches and runs Lighthouse on it)', 'Your PAGESPEED_API_KEY (to Google only)'];
const CRUX_SENDS = ['Page URL or origin, form factor, and requested metric names', 'Your PAGESPEED_API_KEY (to Google only)'];
const KEY_STEP = 'Create a Google Cloud API key restricted to the PageSpeed Insights API and Chrome UX Report API, then put PAGESPEED_API_KEY in <workspace>/secrets/secrets.env (never in chat or the vault).';

export function pagespeedStatus(ctx: AppContext, _opts: StatusCheckOptions): Promise<IntegrationStatus> {
  const at = ctx.clock.now().toISOString();
  const base = { id: 'pagespeed' as const, sendsExternally: PSI_SENDS, checkedAt: at, networkChecked: false, chargeable: false };
  if (!ctx.settings.features.pagespeed) return Promise.resolve({ ...base, state: 'disabled', detail: 'features.pagespeed is off.', nextStep: 'Set features.pagespeed: true to allow explicit, cached checks of priority pages.' });
  if (ctx.synthetic) return Promise.resolve({ ...base, state: 'fixture', detail: 'Demo mode: performance data comes from synthetic fixtures only.' });
  if (!ctx.secrets.has('PAGESPEED_API_KEY')) {
    return Promise.resolve({
      ...base,
      state: 'missing_credentials',
      detail: 'No PAGESPEED_API_KEY. PSI documents keyless use, but keyless calls were observed failing with HTTP 429 (quota 0) on 2026-09-24.',
      nextStep: KEY_STEP,
    });
  }
  return Promise.resolve({
    ...base,
    state: 'configured_unverified',
    detail: `Key configured${ctx.offline ? ' (offline mode)' : ''}. PSI is not exercised by status checks because a Lighthouse run takes 10-60 s; run \`perf check <url>\` explicitly.`,
  });
}

export async function cruxStatus(ctx: AppContext, opts: StatusCheckOptions & { fetch?: FetchLike; endpoint?: string }): Promise<IntegrationStatus> {
  const at = ctx.clock.now().toISOString();
  const base = { id: 'crux' as const, sendsExternally: CRUX_SENDS, checkedAt: at, networkChecked: false, chargeable: false };
  if (!ctx.settings.features.pagespeed) return { ...base, state: 'disabled', detail: 'features.pagespeed is off (CrUX field data is part of performance checks).' };
  if (ctx.synthetic) return { ...base, state: 'fixture', detail: 'Demo mode: field data comes from synthetic fixtures only.' };
  const key = ctx.secrets.get('PAGESPEED_API_KEY');
  if (!key) return { ...base, state: 'missing_credentials', detail: 'The CrUX API requires an API key.', nextStep: KEY_STEP };
  if (!opts.network || ctx.offline) return { ...base, state: 'configured_unverified', detail: `Key configured; no network check performed${ctx.offline ? ' (offline mode)' : ''}.` };
  const r = await queryCruxRecord(opts.fetch ?? ctx.fetch, key, { origin: publicOrigin(ctx.config.site.url), metrics: ['largest_contentful_paint'] }, opts.endpoint ? { endpoint: opts.endpoint } : {});
  if (r.status === 'ok') return { ...base, networkChecked: true, state: 'ready', detail: 'CrUX API reachable; origin-level data exists for the site.' };
  if (r.status === 'not_found') return { ...base, networkChecked: true, state: 'ready', detail: 'CrUX API reachable and the key works; the origin has insufficient real-user data (404 = data unavailable, not an error).' };
  if (r.httpStatus === 400 || r.httpStatus === 403) {
    return { ...base, networkChecked: true, state: 'permission_denied', detail: `CrUX API rejected the request: ${r.message}`, nextStep: 'Enable the Chrome UX Report API for the key\'s project and check key restrictions.' };
  }
  return { ...base, networkChecked: true, state: 'unreachable', detail: `CrUX API check failed: ${r.message}` };
}

export async function performanceStatuses(ctx: AppContext, opts: StatusCheckOptions & { fetch?: FetchLike }): Promise<IntegrationStatus[]> {
  return [await pagespeedStatus(ctx, opts), await cruxStatus(ctx, opts)];
}
