import type { AppContext } from '../app/context.js';
import { AppError } from '../core/errors.js';
import { pageFreeze } from '../experiments/freeze.js';
import type { ContentItem } from './types.js';

/**
 * One meaningful change per target page (spec 18 EXPERIMENT_ACTIVE, spec 23),
 * applied in the content pipeline. An item that would change an existing page
 * (improve_existing, add_section: it has a target page) is held while an
 * experiment on that page is `observing`: another change would contaminate
 * the measurement. The same freeze helper as `export` is used
 * (src/experiments/freeze.ts `pageFreeze`: page id or normalized target URL).
 *
 * - CHECK EXISTING / PRIORITIZE defer such an item ("target page under
 *   observation until <review date>"), so it cannot be selected; the next
 *   discovery after the experiment concludes re-evaluates it.
 * - `content brief` and `content draft` refuse with CONFLICT before a draft
 *   approval is requested or a model draft is paid for.
 *
 * There is no override here: a critical fix to a page under observation goes
 * through `export --critical-fix`, which records the reason and flags the
 * running experiment.
 */

export interface ObservationHold {
  pageId: string;
  pageUrl: string | null;
  /** The observing experiments on the page, with the date each is due for review (null when none is recorded). */
  experiments: Array<{ id: string; type: string; reviewDate: string | null }>;
  /** The latest review date among them, or null when an experiment records none. */
  until: string | null;
  /** "target page under observation until <review date>" with the experiment(s) and the page. */
  reason: string;
}

/** The observation hold on an item's target page, or null when it has no target page or no observing experiment. */
export function observationHold(ctx: AppContext, item: Pick<ContentItem, 'targetPageId'>): ObservationHold | null {
  if (!item.targetPageId) return null;
  const page = ctx.db.get<{ url: string }>('SELECT url FROM pages WHERE site_id = ? AND id = ?', [ctx.siteId, item.targetPageId]);
  const freeze = pageFreeze(ctx.db, ctx.siteId, { pageId: item.targetPageId, url: page?.url ?? '' });
  if (!freeze.observing.length) return null;
  const experiments = freeze.observing.map((e) => ({ id: e.id, type: e.type, reviewDate: e.reviewDate ?? e.observationEnd ?? null }));
  const dates = experiments.map((e) => e.reviewDate).filter((d): d is string => !!d);
  const until = dates.length === experiments.length ? [...dates].sort().at(-1)! : null;
  const names = experiments.map((e) => `${e.id} (${e.type}${e.reviewDate ? `, review ${e.reviewDate}` : ', no review date recorded'})`).join(', ');
  const reason = `Target page under observation until ${until ?? 'its review date (not recorded)'}: experiment ${names} is observing ${page?.url ?? item.targetPageId}. One meaningful change per page at a time: do not stack unrelated changes on this page while it is measured.`;
  return { pageId: item.targetPageId, pageUrl: page?.url ?? null, experiments, until, reason };
}

/** The hint of a refusal: which experiment, its review date, and what to do. */
export function observationHint(hold: ObservationHold): string {
  const first = hold.experiments[0]!;
  return `Experiment ${hold.experiments.map((e) => `${e.id} (review date ${e.reviewDate ?? 'not recorded'})`).join(', ')} is observing ${hold.pageUrl ?? hold.pageId}. Wait until it is reviewed and concluded (\`npm run cli -- experiments show ${first.id}\`), then run \`content discover\` again so the item is re-evaluated. A critical fix to broken functionality goes through \`export --critical-fix\`, not the content pipeline.`;
}

/**
 * Refuse (CONFLICT) to brief or draft an item whose target page is under
 * observation, before any draft approval is requested or any model draft is
 * paid for.
 */
export function assertNotUnderObservation(ctx: AppContext, item: Pick<ContentItem, 'id' | 'targetPageId'>, action: 'brief' | 'draft'): void {
  const hold = observationHold(ctx, item);
  if (!hold) return;
  const what = action === 'brief' ? 'build a brief for (and request a draft approval for)' : 'draft';
  throw new AppError('CONFLICT', `Refusing to ${what} content item ${item.id}: ${hold.reason}`, {
    hint: observationHint(hold),
    details: { itemId: item.id, targetPageId: hold.pageId, targetUrl: hold.pageUrl, observing: hold.experiments, until: hold.until },
  });
}
