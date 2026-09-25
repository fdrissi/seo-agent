import type { AppContext } from '../../app/context.js';
import type { IntegrationStatus, StatusCheckOptions } from '../types.js';
import { authStatus } from '../../auth/status.js';
import type { GoogleAuthProvider } from './types.js';

/**
 * Honest IntegrationStatus rows for google_auth, google_gsc, google_ga4 and
 * google_url_inspection. With `network: true` only free, read-only calls are
 * made (sites.list, GA4 getMetadata); nothing chargeable.
 */
export async function googleStatus(ctx: AppContext, opts: StatusCheckOptions & { provider?: GoogleAuthProvider }): Promise<IntegrationStatus[]> {
  const report = await authStatus(ctx, opts);
  return report.statuses;
}
