import type { AppContext } from '../app/context.js';

/**
 * Honest status of optional AI-citation monitoring (spec 17).
 *
 * What exists: an explicit manual-import adapter (`ai-citations import`).
 * What does not: any API-based engine collector. No verified, accessible
 * AI-answer API is configured for this application, so none is implemented
 * and no endpoint is invented because a dashboard exists. Bing and other
 * visibility tools are supported only by exporting their data and importing
 * it through the same explicit manual-import adapter.
 */

export interface AiCitationCollectorStatus {
  id: 'manual_import' | 'api';
  state: 'available' | 'disabled' | 'not_implemented';
  detail: string;
}

export interface AiCitationStatus {
  feature: 'aiCitations';
  enabled: boolean;
  state: 'disabled' | 'enabled';
  detail: string;
  collectors: AiCitationCollectorStatus[];
  /** Manual import makes no provider request and spends nothing; there is no paid collector to budget. */
  spending: { chargeable: false; detail: string };
  stored: { total: number; grounded: number; ungrounded: number; synthetic: number; latestCheckedAt: string | null };
  nextStep: string;
}

export const AI_CITATION_API_NOT_IMPLEMENTED =
  'No API-based AI-answer engine is implemented: no verified, accessible API is configured for this application, and no endpoint is invented because a dashboard exists. Bing and other visibility tools are supported only through an explicit export and `ai-citations import`.';

/** Current status: works whether the feature is on or off (read-only, no network). */
export function aiCitationStatus(ctx: Pick<AppContext, 'db' | 'siteId' | 'settings'>): AiCitationStatus {
  const enabled = ctx.settings.features.aiCitations;
  const s = ctx.db.get<{ total: number; grounded: number | null; synthetic: number | null; latest: string | null }>(
    `SELECT COUNT(*) AS total, SUM(is_grounded) AS grounded, SUM(is_synthetic) AS synthetic, MAX(checked_at) AS latest FROM ai_citation_checks WHERE site_id = ?`,
    [ctx.siteId],
  );
  const total = s?.total ?? 0;
  const grounded = s?.grounded ?? 0;
  return {
    feature: 'aiCitations',
    enabled,
    state: enabled ? 'enabled' : 'disabled',
    detail: enabled
      ? 'Optional AI-citation monitoring is enabled. Observations are recorded only through `ai-citations import`; nothing is collected automatically.'
      : 'Optional AI-citation monitoring is disabled (features.aiCitations is false; off by default in every profile). AI visibility is not measured, which is DATA_UNAVAILABLE, not zero.',
    collectors: [
      {
        id: 'manual_import',
        state: enabled ? 'available' : 'disabled',
        detail: 'Owner-supplied CSV/JSON observations (query or prompt, engine, date, location, grounded yes/no, response text, cited URLs). Brand mention and own-site citation are computed in code.',
      },
      { id: 'api', state: 'not_implemented', detail: AI_CITATION_API_NOT_IMPLEMENTED },
    ],
    spending: { chargeable: false, detail: 'Manual import makes no provider request and spends nothing. No paid AI-citation collector exists, so no AI-citation budget is used.' },
    stored: { total, grounded, ungrounded: total - grounded, synthetic: s?.synthetic ?? 0, latestCheckedAt: s?.latest ?? null },
    nextStep: enabled
      ? 'Record observations with `npm run cli -- ai-citations import <file.csv|file.json>` (see docs/modules/ai-citations.md for the columns), then review them with `ai-citations list`.'
      : 'To record manually observed AI answers, set features.aiCitations: true in the site config, then use `ai-citations import`.',
  };
}
