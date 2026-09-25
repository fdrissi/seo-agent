import type { AppContext } from '../app/context.js';
import { AppError } from '../core/errors.js';
import { valueOf } from '../core/measured.js';
import { ManualSiteLease, describeLeaseHolder } from '../jobs/manual-lease.js';
import { gscPropertyMetrics } from '../seo/metrics.js';
import { LOW_DATA_WINDOW_DAYS } from '../seo/page-analysis.js';
import { latestFinalGscDate, resolveGscProperty, windowEnding } from '../seo/period.js';
import { createBrief, type BriefResult } from './brief.js';
import { observationHint, observationHold } from './freeze.js';
import { conversionHistory, NO_CONVERSION_HISTORY_STATEMENT } from './conversion-history.js';
import type { ContentDeps } from './deps.js';
import { computeDemand } from './demand.js';
import { computeOverlap, loadSitePages } from './existing.js';
import { compareForPriority, scoreItem } from './prioritize.js';
import { audit, getItem, insertItem, listItems, updateItem } from './store.js';
import { truncate } from './text.js';
import { OPEN_RESEARCH_STAGES, type ContentItem, type ContentStage } from './types.js';

/**
 * LOW-DATA BOOTSTRAP (router route LOW_DATA): for a new or small site,
 * produce (1) an offer-page brief, (2) ONE genuinely useful supporting-page
 * brief, and (3) measurement and technical-readiness checks. Historical
 * conversion evidence is never assumed: its absence is stated explicitly,
 * and stored conversion rows are stated with their count (never attributed
 * to the proposed pages).
 *
 * Low-data detection uses the SAME Search Console scope as page analysis:
 * one property (configured, or the only one with data) and the configured
 * search type, property totals only, final dates only. Totals of different
 * properties are never added together.
 *
 * A bootstrap run that writes (not a dry run, and a low-data site or --force)
 * holds the site's separate "content" lock for as long as it runs, like the
 * content jobs (content queue / produce / brief / draft / review / batch), so
 * it never creates items and briefs alongside a content job of the same site.
 * While a content job holds that lock it refuses with LOCKED and does nothing.
 * (The `content bootstrap` CLI command additionally holds the per-site "site"
 * lease: see MUTATING_COMMANDS in src/cli/runtime.ts.)
 */

export { NO_CONVERSION_HISTORY_STATEMENT };

/** The lock the content jobs hold (content/jobs.ts, CONTENT_QUEUE_LOCK in workflows/pipelines/content-queue.ts). */
export const CONTENT_LOCK_NAME = 'content';

/** Hold the "content" lock for a bootstrap run, or refuse with LOCKED while a content job (or another bootstrap) holds it. */
function holdContentLock(ctx: AppContext): ManualSiteLease {
  const r = ManualSiteLease.acquire(ctx.db, { siteId: ctx.siteId, command: 'content bootstrap', lockName: CONTENT_LOCK_NAME, clock: ctx.clock });
  if (r.acquired) {
    if (r.takenOverFrom) ctx.logger.warn(`Took over the expired ${CONTENT_LOCK_NAME} lease of ${describeLeaseHolder(r.takenOverFrom)} (held by ${r.takenOverFrom.owner}, expired ${r.takenOverFrom.expiresAt})`, { command: 'content bootstrap' });
    return r.lease;
  }
  const held = r.heldBy;
  const alive = r.aliveReason ? ` Its lease expired, but ${r.aliveReason}.` : '';
  throw new AppError(
    'LOCKED',
    `The ${CONTENT_LOCK_NAME} lock of site ${ctx.siteId} is held by ${r.holder} (held by ${held.owner}, lease until ${held.expiresAt}).${alive} The low-data bootstrap creates content items and briefs, so it never runs alongside a content job of the same site. Nothing was done.`,
    {
      hint: held.jobId
        ? `Wait for job ${held.jobId} to finish (\`npm run cli -- jobs show ${held.jobId}\`), or cancel it with \`jobs cancel ${held.jobId}\`, then retry. --dry-run still shows the readiness checks meanwhile.`
        : `Wait for ${r.holder} to finish (a crashed holder's lease expires on its own), then retry. --dry-run still shows the readiness checks meanwhile.`,
      details: { siteId: ctx.siteId, lockName: held.lockName, jobId: held.jobId, owner: held.owner, expiresAt: held.expiresAt },
    },
  );
}

export interface ReadinessCheck {
  id: string;
  area: 'measurement' | 'technical' | 'business';
  status: 'pass' | 'fail' | 'unknown';
  detail: string;
  nextStep: string | null;
}

export type BootstrapBrief = Pick<BriefResult, 'gate' | 'modelStatus' | 'contentHash' | 'reused'> & { briefId: string | null; approvalRequestId: string | null };

/**
 * A bootstrap page: briefed now, already in production (left untouched), or
 * held because an experiment is observing its target page (no brief, no
 * draft approval request; see freeze.ts).
 */
export type BootstrapPage =
  | { itemId: string; status: 'briefed'; stage: ContentStage; brief: BootstrapBrief }
  | { itemId: string; status: 'already_in_progress'; stage: ContentStage; reason: string; brief: null }
  | { itemId: string; status: 'held_by_experiment'; stage: ContentStage; reason: string; brief: null };

export interface BootstrapResult {
  lowData: {
    isLowData: boolean;
    reason: string;
    impressions28d: number | null;
    threshold: number;
    /** low: below the threshold or no data stored; not_low: at or above; unknown: cannot be decided (never summed across properties). */
    status?: 'low' | 'not_low' | 'unknown';
    /** The single Search Console property the decision used (null when unresolved). */
    property?: string | null;
    searchType?: string;
  };
  readiness: ReadinessCheck[];
  offerPage: BootstrapPage | null;
  supportingPage: BootstrapPage | { itemId: null; reason: string };
  conversionHistory: string;
  skipped: string | null;
}

/** Whether any Search Console page or property rows are stored for the site (any property). */
function anyGscData(ctx: AppContext): boolean {
  return !!ctx.db.get<{ one: number }>('SELECT 1 AS one FROM gsc_property_daily WHERE site_id = ? UNION ALL SELECT 1 FROM gsc_page_daily WHERE site_id = ? LIMIT 1', [ctx.siteId, ctx.siteId]);
}

export function detectLowData(ctx: AppContext): BootstrapResult['lowData'] {
  const threshold = ctx.config.router.lowDataSiteMaxImpressions;
  const searchType = ctx.config.google.gsc.searchTypes[0] ?? 'web';
  const resolved = resolveGscProperty(ctx.db, ctx.siteId, ctx.config.google.searchConsoleProperty);
  if (!resolved.property) {
    const reason = 'reason' in resolved ? resolved.reason : 'unresolved';
    if (!anyGscData(ctx)) {
      return { isLowData: true, status: 'low', reason: 'No Search Console property data stored (new site or access not configured).', impressions28d: null, threshold, property: null, searchType };
    }
    // Several properties and none configured: their totals are never added together, so the status is unknown.
    return { isLowData: false, status: 'unknown', reason: `Low-data status unknown: ${reason}. Property totals are never summed across properties (pass --force to bootstrap anyway).`, impressions28d: null, threshold, property: null, searchType };
  }
  const property = resolved.property;
  const basis = resolved.basis === 'data' ? ' (the only property with data; not configured)' : '';
  const end = latestFinalGscDate(ctx.db, ctx.siteId, property, searchType);
  if (!end) {
    const any = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM gsc_property_daily_current WHERE site_id = ? AND property = ? AND search_type = ?', [ctx.siteId, property, searchType]);
    if (Number(any?.n ?? 0) > 0) {
      return { isLowData: false, status: 'unknown', reason: `Low-data status unknown: Search Console property ${property}${basis} (${searchType}) has only non-final (incomplete) dates stored.`, impressions28d: null, threshold, property, searchType };
    }
    return { isLowData: true, status: 'low', reason: `No Search Console property data stored for ${property}${basis} (${searchType}): new site or not synced yet.`, impressions28d: null, threshold, property, searchType };
  }
  const win = windowEnding(end, LOW_DATA_WINDOW_DAYS);
  const agg = gscPropertyMetrics(ctx.db, ctx.siteId, { property, searchType, segmentKey: '', start: win.start, end: win.end, incompletePolicy: 'exclude' });
  const imp = valueOf(agg.impressions);
  const scope = `Search Console property ${property}${basis}, ${searchType}, ${win.start}..${win.end} (final dates only)`;
  if (imp !== undefined) {
    return imp < threshold
      ? { isLowData: true, status: 'low', reason: `${imp} Search Console impressions in the ${LOW_DATA_WINDOW_DAYS} days ending ${win.end} (${scope}; below router.lowDataSiteMaxImpressions=${threshold}).`, impressions28d: imp, threshold, property, searchType }
      : { isLowData: false, status: 'not_low', reason: `${imp} impressions in the ${LOW_DATA_WINDOW_DAYS} days ending ${win.end} (${scope}; at or above ${threshold}); use the normal pipeline.`, impressions28d: imp, threshold, property, searchType };
  }
  const partial = agg.impressions.status === 'incomplete' ? agg.impressions.partialValue : undefined;
  if (partial !== undefined && partial >= threshold) {
    return { isLowData: false, status: 'not_low', reason: `At least ${partial} impressions in the ${LOW_DATA_WINDOW_DAYS} days ending ${win.end} (${scope}; incomplete window, a lower bound at or above ${threshold}); use the normal pipeline.`, impressions28d: partial, threshold, property, searchType };
  }
  const why = agg.impressions.status === 'observed' ? '' : agg.impressions.reason;
  return { isLowData: false, status: 'unknown', reason: `Low-data status unknown for ${scope}: ${why}${partial !== undefined ? ` (partial value ${partial} is only a lower bound)` : ''}. Pass --force to bootstrap anyway.`, impressions28d: null, threshold, property, searchType };
}

/** The owner command that marks a page as the offer page (page_type_source "owner"). */
export const MARK_OFFER_PAGE = 'npm run cli -- pages set-type <url> offer';

export function readinessChecks(ctx: AppContext): ReadinessCheck[] {
  const cfg = ctx.config;
  // Exact commands: each missing business/measurement field names the setup step (or group) that asks it.
  const setupOnly = (steps: string) => `npm run cli -- setup --update --site ${ctx.siteId} --only ${steps}`;
  const one = (sql: string, params: unknown[]) => Number(ctx.db.get<{ n: number }>(sql, params)?.n ?? 0);
  const checks: ReadinessCheck[] = [];
  const add = (c: ReadinessCheck) => checks.push(c);
  add(cfg.google.searchConsoleProperty ? { id: 'gsc_property', area: 'measurement', status: 'pass', detail: `Search Console property ${cfg.google.searchConsoleProperty}.`, nextStep: null } : { id: 'gsc_property', area: 'measurement', status: 'fail', detail: 'No Search Console property configured.', nextStep: `Authorize Google read-only access (\`npm run cli -- auth google\`), list the accessible properties (\`npm run cli -- auth status\`), then set it: \`${setupOnly('google.searchConsoleProperty')}\`.` });
  const gscProp = resolveGscProperty(ctx.db, ctx.siteId, cfg.google.searchConsoleProperty);
  const gscRows = gscProp.property ? one('SELECT COUNT(*) AS n FROM gsc_property_daily_current WHERE site_id = ? AND property = ?', [ctx.siteId, gscProp.property]) : 0;
  add(
    gscRows
      ? { id: 'gsc_data', area: 'measurement', status: 'pass', detail: `${gscRows} daily property row(s) stored for ${gscProp.property}.`, nextStep: null }
      : gscProp.property || !anyGscData(ctx)
        ? { id: 'gsc_data', area: 'measurement', status: 'fail', detail: 'No Search Console data stored.', nextStep: 'Run `npm run cli -- sync gsc` after Google access is configured.' }
        : { id: 'gsc_data', area: 'measurement', status: 'unknown', detail: `Search Console property unresolved: ${'reason' in gscProp ? gscProp.reason : ''}.`, nextStep: `Set google.searchConsoleProperty to the property you use: \`${setupOnly('google.searchConsoleProperty')}\`.` },
  );
  add(cfg.google.ga4PropertyId ? { id: 'ga4_property', area: 'measurement', status: 'pass', detail: `GA4 property ${cfg.google.ga4PropertyId}.`, nextStep: null } : { id: 'ga4_property', area: 'measurement', status: 'fail', detail: 'No GA4 property configured.', nextStep: `Set the numeric GA4 property id (\`${setupOnly('google.ga4PropertyId')}\`) and grant the Google identity read access.` });
  const primary = cfg.conversions.primaryEvents;
  add(primary.length ? { id: 'primary_conversion', area: 'measurement', status: 'pass', detail: `Primary conversion(s): ${primary.map((e) => `${e.name} (${e.meaning})`).join(', ')}.`, nextStep: null } : { id: 'primary_conversion', area: 'measurement', status: 'fail', detail: 'No primary conversion event configured; outcomes cannot be measured.', nextStep: `Define the primary conversion events with their exact GA4 event names: \`${setupOnly('conversions')}\`.` });
  const conv = conversionHistory(ctx);
  add(conv.rows ? { id: 'conversion_data', area: 'measurement', status: 'pass', detail: conv.statement, nextStep: null } : { id: 'conversion_data', area: 'measurement', status: 'unknown', detail: conv.statement, nextStep: `Verify the primary event fires with the manual checklist (\`npm run cli -- sync ga4 --checklist\`; e.g. a safe test submission seen in GA4 DebugView), record it (\`${setupOnly('conversions')}\`), then run \`npm run cli -- sync ga4\`.` });
  const crawls = one(`SELECT COUNT(*) AS n FROM crawls WHERE site_id = ? AND kind = 'own_site' AND status IN ('completed', 'partial')`, [ctx.siteId]);
  add(crawls ? { id: 'crawl', area: 'technical', status: 'pass', detail: `${crawls} own-site crawl(s) recorded.`, nextStep: null } : { id: 'crawl', area: 'technical', status: 'fail', detail: 'No own-site crawl recorded: existing pages and technical health are unknown.', nextStep: 'Run `npm run cli -- crawl` (free, bounded, respects robots.txt).' });
  const { pages } = loadSitePages(ctx);
  const offer = pages.find((p) => p.pageType === 'offer') ?? pages.find((p) => p.path === '/' || p.url === cfg.site.url);
  add(
    offer
      ? { id: 'offer_page', area: 'technical', status: 'pass', detail: `Offer page candidate: ${offer.url}${offer.pageType === 'offer' ? '' : ' (site root; no page typed as offer)'}.`, nextStep: offer.pageType === 'offer' ? null : `If the offer lives on another page, mark it: \`${MARK_OFFER_PAGE}\`.` }
      : { id: 'offer_page', area: 'technical', status: 'unknown', detail: 'No offer page identified in the page registry.', nextStep: `Crawl the site (\`npm run cli -- crawl\`), then mark the offer page: \`${MARK_OFFER_PAGE}\` (or list it under site.pageTypes in the site config).` },
  );
  if (offer) {
    const cr = ctx.db.get<{ meta_robots: string | null; x_robots_tag: string | null; status_code: number | null; robots_allowed: number | null }>(
      `SELECT cr.meta_robots, cr.x_robots_tag, cr.status_code, cr.robots_allowed FROM crawl_results cr JOIN crawls c ON c.id = cr.crawl_id WHERE cr.site_id = ? AND cr.page_id = ? AND c.kind IN ('own_site', 'single_page') ORDER BY cr.fetched_at DESC LIMIT 1`,
      [ctx.siteId, offer.pageId],
    );
    if (!cr) add({ id: 'offer_indexability', area: 'technical', status: 'unknown', detail: 'Offer page not crawled yet.', nextStep: 'Run `npm run cli -- crawl`.' });
    else {
      const noindex = /noindex/i.test(`${cr.meta_robots ?? ''} ${cr.x_robots_tag ?? ''}`);
      const ok = !noindex && cr.status_code !== null && cr.status_code >= 200 && cr.status_code < 300 && cr.robots_allowed !== 0;
      add({ id: 'offer_indexability', area: 'technical', status: ok ? 'pass' : 'fail', detail: ok ? 'Offer page returns 2xx, is crawlable, and has no noindex (HTTP 200 does not prove indexing).' : `Offer page issue: status ${cr.status_code ?? 'unknown'}${noindex ? ', noindex' : ''}${cr.robots_allowed === 0 ? ', blocked by robots.txt' : ''}.`, nextStep: ok ? `Optionally confirm indexing via URL Inspection: \`npm run cli -- sync inspect ${offer.url}\`.` : 'Fix indexability before creating content (`npm run cli -- crawl issues` lists the open issues).' });
    }
  }
  const critical = one(`SELECT COUNT(*) AS n FROM technical_issues WHERE site_id = ? AND status = 'open' AND severity IN ('critical', 'high') AND confirmed = 1`, [ctx.siteId]);
  add(critical ? { id: 'technical_blockers', area: 'technical', status: 'fail', detail: `${critical} confirmed critical/high technical issue(s) open.`, nextStep: 'Resolve technical blockers first (`npm run cli -- crawl issues` lists them; router: TECHNICAL_BLOCKER).' } : { id: 'technical_blockers', area: 'technical', status: crawls ? 'pass' : 'unknown', detail: crawls ? 'No confirmed critical technical issues.' : 'Unknown until a crawl runs.', nextStep: crawls ? null : 'Run `npm run cli -- crawl`.' });
  const b = cfg.business;
  add(b.offer ? { id: 'offer_defined', area: 'business', status: 'pass', detail: 'Offer described in site config.', nextStep: null } : { id: 'offer_defined', area: 'business', status: 'fail', detail: 'business.offer is empty.', nextStep: `Describe the offer: \`${setupOnly('business.offer')}\`.` });
  add(b.targetCustomer ? { id: 'target_customer', area: 'business', status: 'pass', detail: `Target customer: ${b.targetCustomer}.`, nextStep: null } : { id: 'target_customer', area: 'business', status: 'fail', detail: 'business.targetCustomer is empty.', nextStep: `Describe the target customer: \`${setupOnly('business.targetCustomer')}\`.` });
  add(b.productFacts.length ? { id: 'product_facts', area: 'business', status: 'pass', detail: `${b.productFacts.length} verified product fact(s).`, nextStep: null } : { id: 'product_facts', area: 'business', status: 'fail', detail: 'No product facts supplied: drafts cannot describe the product.', nextStep: `Add verified product facts with their sources: \`${setupOnly('business.productFacts')}\`.` });
  return checks;
}

function findBootstrapItem(ctx: AppContext, kind: 'offer_page' | 'supporting_page'): ContentItem | null {
  const r = ctx.db.get<{ id: string }>(`SELECT id FROM content_items WHERE site_id = ? AND json_extract(demand_json, '$.bootstrap') = ? ORDER BY created_at DESC LIMIT 1`, [ctx.siteId, kind]);
  return r ? getItem(ctx.db, ctx.siteId, r.id) : null;
}

/** Stages past briefing: a bootstrap re-run must never move such an item back. */
const IN_PROGRESS_STAGES: readonly ContentStage[] = ['drafted', 'quality_checked', 'in_review', 'approved', 'exported', 'published', 'measuring', 'rejected'];

function inProgress(item: ContentItem): string | null {
  return IN_PROGRESS_STAGES.includes(item.stage) ? `Item ${item.id} is already "${item.stage}"; the bootstrap leaves it unchanged (no new brief, no stage change).` : null;
}

function ensureOfferItem(ctx: AppContext): { item: ContentItem; inProgress: string | null } {
  const cfg = ctx.config;
  const now = ctx.clock.now().toISOString();
  const site = loadSitePages(ctx);
  const offer = site.pages.find((p) => p.pageType === 'offer') ?? site.pages.find((p) => p.path === '/' || p.url === cfg.site.url);
  const name = cfg.site.businessName.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  let item = findBootstrapItem(ctx, 'offer_page');
  if (item) {
    const busy = inProgress(item);
    if (busy) return { item, inProgress: busy };
    // Briefed items keep their decision/rationale; only open research stages are refreshed.
    if (!OPEN_RESEARCH_STAGES.includes(item.stage)) return { item, inProgress: null };
  }
  if (!item) {
    const id = insertItem(ctx.db, { siteId: ctx.siteId, title: `Offer page: ${truncate(cfg.business.offer ?? name, 90)}`, primaryQuestion: `What does ${name} offer, who is it for, and what should a visitor do next?`, stage: 'existing_checked', intent: 'transactional', clusterId: null, isSynthetic: ctx.synthetic, now });
    item = getItem(ctx.db, ctx.siteId, id)!;
  }
  const demand = { ...computeDemand([]), bootstrap: 'offer_page' as const, statusReason: 'Low-data bootstrap: the offer page is foundational; no demand measurement exists yet.', relationStrength: 'strong' as const, originalValueAvailable: cfg.business.productFacts.length > 0 || cfg.business.differentiators.length > 0 };
  const overlap = computeOverlap(item, [], site);
  const primary = cfg.conversions.primaryEvents[0];
  const valueParts = [cfg.business.productFacts.length ? `verified product facts (${cfg.business.productFacts.map((f) => f.id).join(', ')})` : '', cfg.business.differentiators.length ? `differentiators ("${truncate(cfg.business.differentiators[0]!, 80)}")` : ''].filter(Boolean);
  updateItem(
    ctx.db,
    ctx.siteId,
    item.id,
    {
      decision: offer ? 'improve_existing' : 'create_page',
      decisionReason: `[bootstrap] ${offer ? `Improve the existing offer page ${offer.url}` : 'No offer page found: create one'}; low-data site.`,
      targetPageId: offer?.pageId ?? null,
      intent: 'transactional',
      whyExists: `Low-data site: the offer page must explain the offer clearly and support the primary conversion. ${conversionHistory(ctx).statement}`,
      whoBenefits: cfg.business.targetCustomer ? `${cfg.business.targetCustomer} evaluating the offer.` : 'Prospective customers evaluating the offer (target customer not configured; confirm).',
      businessRelation: 'This is the offer itself.',
      originalValue: valueParts.length ? `Available: ${valueParts.join('; ')}.` : 'None identified yet: no product facts or differentiators supplied. Needs owner input.',
      readerNextStep: primary ? `Complete the primary conversion: ${primary.meaning}.` : 'Primary conversion not configured (conversions.primaryEvents).',
      demand,
      overlap,
      stage: 'existing_checked',
    },
    now,
  );
  return { item: getItem(ctx.db, ctx.siteId, item.id)!, inProgress: null };
}

function pickSupportingItem(ctx: AppContext, offerItemId: string): { item: ContentItem | null; reason: string } {
  const existing = findBootstrapItem(ctx, 'supporting_page');
  if (existing && existing.decision && !['defer', 'reject'].includes(existing.decision)) return { item: existing, reason: 'Previously selected supporting page.' };
  const candidates = listItems(ctx.db, ctx.siteId).filter((i) => i.id !== offerItemId && i.demand?.bootstrap !== 'offer_page' && i.intent !== 'navigational' && i.intent !== 'unsure');
  const selectable = candidates.filter((i) => i.decision && !['defer', 'reject'].includes(i.decision) && ['existing_checked', 'prioritized', 'briefed'].includes(i.stage));
  if (selectable.length) {
    // Non-branded items first (branded clusters are a separate, lower-priority segment), then score.
    const best = [...selectable].sort(compareForPriority)[0]!;
    return { item: best, reason: `Highest-scoring selectable item (score ${scoreItem(best).score}${best.demand?.branded ? '; branded segment: no non-branded candidate' : ''}).` };
  }
  // Deferred only for lack of measurable demand, but relevant and with original value.
  const demandDeferred = candidates.filter(
    (i) => i.stage === 'deferred' && /demand|single weak signal/i.test(i.decisionReason ?? '') && (i.demand?.relationStrength === 'strong' || i.demand?.relationStrength === 'weak') && i.demand?.originalValueAvailable,
  );
  if (demandDeferred.length) {
    const best = [...demandDeferred].sort(compareForPriority)[0]!;
    return { item: best, reason: 'Low-data bootstrap: relevant item with original value that was deferred only because demand cannot be measured yet.' };
  }
  return { item: null, reason: 'No candidate with business relation and original value. Import real customer questions (`content import <file>`) or add research.seedTopics plus product facts, then run `content discover`.' };
}

export async function runLowDataBootstrap(ctx: AppContext, deps: ContentDeps, opts: { force?: boolean; useModel?: boolean; requestApproval?: boolean } = {}): Promise<BootstrapResult> {
  const lowData = detectLowData(ctx);
  const readiness = readinessChecks(ctx);
  const base = { lowData, readiness, conversionHistory: conversionHistory(ctx).statement };
  if (!lowData.isLowData && !opts.force) return { ...base, offerPage: null, supportingPage: { itemId: null, reason: 'Not a low-data site.' }, skipped: lowData.reason };
  if (ctx.dryRun) return { ...base, offerPage: null, supportingPage: { itemId: null, reason: 'dry run: no items or briefs created' }, skipped: 'dry run: readiness checks only' };
  const lease = holdContentLock(ctx);
  try {
    return await bootstrapItems(ctx, deps, opts, base);
  } finally {
    lease.release();
  }
}

async function bootstrapItems(
  ctx: AppContext,
  deps: ContentDeps,
  opts: { useModel?: boolean; requestApproval?: boolean },
  base: Pick<BootstrapResult, 'lowData' | 'readiness' | 'conversionHistory'>,
): Promise<BootstrapResult> {
  const { lowData, readiness } = base;
  const briefOpts = { ...(opts.useModel !== undefined ? { useModel: opts.useModel } : {}), ...(opts.requestApproval !== undefined ? { requestApproval: opts.requestApproval } : {}) };

  const offer = ctx.db.transaction(() => ensureOfferItem(ctx));
  const offerItem = offer.item;
  let offerPage: BootstrapPage;
  const offerHold = offer.inProgress ? null : observationHold(ctx, offerItem);
  if (offer.inProgress) offerPage = { itemId: offerItem.id, status: 'already_in_progress', stage: offerItem.stage, reason: offer.inProgress, brief: null };
  else if (offerHold) offerPage = { itemId: offerItem.id, status: 'held_by_experiment', stage: offerItem.stage, reason: `${offerHold.reason} ${observationHint(offerHold)}`, brief: null };
  else {
    const b = await createBrief(ctx, deps, offerItem.id, { ...briefOpts, bootstrap: 'offer_page' });
    offerPage = { itemId: offerItem.id, status: 'briefed', stage: getItem(ctx.db, ctx.siteId, offerItem.id)!.stage, brief: briefSummary(b) };
  }

  const pick = pickSupportingItem(ctx, offerItem.id);
  let supportingPage: BootstrapResult['supportingPage'] = { itemId: null, reason: pick.reason };
  if (pick.item) {
    const now = ctx.clock.now().toISOString();
    const it = pick.item;
    const busy = inProgress(it);
    const hold = busy ? null : observationHold(ctx, it);
    if (busy) supportingPage = { itemId: it.id, status: 'already_in_progress', stage: it.stage, reason: busy, brief: null };
    else if (hold) supportingPage = { itemId: it.id, status: 'held_by_experiment', stage: it.stage, reason: `${hold.reason} ${observationHint(hold)}`, brief: null };
    else {
      if (it.stage === 'deferred' || it.decision === 'defer') {
        updateItem(ctx.db, ctx.siteId, it.id, { decision: 'create_page', decisionReason: `[bootstrap] ${pick.reason} Previous: ${it.decisionReason ?? 'n/a'}`, stage: 'existing_checked' }, now);
        audit(ctx.db, ctx.siteId, 'content.decision', 'content_item', it.id, { previous: it.decision, decision: 'create_page', reason: pick.reason, bootstrap: true }, ctx.clock.now());
      }
      const fresh = getItem(ctx.db, ctx.siteId, it.id)!;
      if (fresh.demand && fresh.demand.bootstrap !== 'supporting_page') updateItem(ctx.db, ctx.siteId, it.id, { demand: { ...fresh.demand, bootstrap: 'supporting_page' } }, now);
      const b = await createBrief(ctx, deps, it.id, { ...briefOpts, bootstrap: 'supporting_page' });
      supportingPage = { itemId: it.id, status: 'briefed', stage: getItem(ctx.db, ctx.siteId, it.id)!.stage, brief: briefSummary(b) };
    }
  }
  audit(ctx.db, ctx.siteId, 'content.bootstrap', 'site', ctx.siteId, { lowData, offerItemId: offerItem.id, supportingItemId: supportingPage.itemId, readinessFailures: readiness.filter((r) => r.status === 'fail').map((r) => r.id) }, ctx.clock.now());
  return { ...base, offerPage, supportingPage, skipped: null };
}

function briefSummary(b: BriefResult): BootstrapBrief {
  return { gate: b.gate, modelStatus: b.modelStatus, contentHash: b.contentHash, reused: b.reused, briefId: b.record?.id ?? null, approvalRequestId: b.approvalRequest?.id ?? null };
}
