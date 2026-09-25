import type { AppContext } from '../app/context.js';
import { listSignals, updateItem } from './store.js';
import { truncate } from './text.js';
import { DEFAULT_LIMITATIONS, type CollectionWindow, type ContentItem, type ContentSignal, type DemandEvidence, type ItemDemand, type MeasuredNumber, type SignalOrigin } from './types.js';

/**
 * VALIDATE DEMAND: aggregate each item's signals into labeled demand
 * evidence. First-party Search Console measurements, third-party volume
 * ESTIMATES, community engagement, manual questions, competitor gaps, and
 * business knowledge are kept separate and never summed together. Missing is
 * never 0. Reddit engagement is never treated as search volume.
 */

const observedN = (value: number): MeasuredNumber => ({ status: 'observed', value });
const missingN = (reason: string): MeasuredNumber => ({ status: 'missing', reason });

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export type SourceStatusList = Array<{ origin: string; status: 'collected' | 'empty' | 'unavailable' | 'disabled' | 'skipped'; detail: string }>;

export function computeDemand(signals: ContentSignal[], opts: { minIndependentSignals?: number; sourceStatus?: SourceStatusList } = {}): DemandEvidence {
  const origins: Record<string, number> = {};
  for (const s of signals) origins[s.origin] = (origins[s.origin] ?? 0) + 1;

  // Search Console (first-party, observed). Visible query rows only.
  const gscSignals = signals.filter((s) => s.origin === 'gsc_query');
  let impressions: number | null = null;
  let clicks: number | null = null;
  let posWeighted = 0;
  let posImpr = 0;
  let gscWindow: CollectionWindow | null = null;
  for (const s of gscSignals) {
    const e = s.engagement ?? {};
    const imp = num(e.impressions);
    const clk = num(e.clicks);
    const pos = num(e.weightedPosition);
    if (imp !== null) impressions = (impressions ?? 0) + imp;
    if (clk !== null) clicks = (clicks ?? 0) + clk;
    if (pos !== null && imp !== null && imp > 0) {
      posWeighted += pos * imp;
      posImpr += imp;
    }
    gscWindow ??= s.collectionWindow;
  }
  const gscMissing = gscSignals.length ? 'Search Console rows lacked metrics' : 'No Search Console query rows matched this item';

  // DataForSEO estimates (non-sandbox by construction of discovery).
  const volumeKeywords = signals
    .filter((s) => s.origin === 'dataforseo')
    .map((s) => {
      const e = s.engagement ?? {};
      return {
        keyword: s.text,
        volume: num(e.searchVolume),
        provider: String(e.provider ?? 'dataforseo'),
        locationCode: num(e.locationCode),
        languageCode: typeof e.languageCode === 'string' ? e.languageCode : null,
        collectedAt: String(e.collectedAt ?? s.collectedAt),
      };
    });
  const volumes = volumeKeywords.map((k) => k.volume).filter((v): v is number => v !== null);

  // Community (Reddit): engagement, not volume.
  const reddit = signals.filter((s) => s.origin === 'apify_reddit');
  let upvotes: number | null = null;
  let comments: number | null = null;
  for (const s of reddit) {
    const e = s.engagement ?? {};
    const up = num(e.upVotes ?? e.upvotes ?? e.score);
    const cm = num(e.commentsCount ?? e.comments);
    if (up !== null) upvotes = (upvotes ?? 0) + up;
    if (cm !== null) comments = (comments ?? 0) + cm;
  }
  const threads = new Set(reddit.map((s) => s.url ?? s.id)).size;

  const manualQuestions = signals.filter((s) => s.origin === 'manual').length;
  const competitorGaps = signals.filter((s) => s.origin === 'competitor_gap').length;
  const businessKnowledge = signals.filter((s) => s.origin === 'business_knowledge').length;
  const fixture = signals.filter((s) => s.origin === 'fixture').length;

  const independentOrigins = Object.keys(origins).filter((o) => o !== 'business_knowledge').length;
  const minIndependent = opts.minIndependentSignals ?? 2;
  let status: DemandEvidence['status'];
  let statusReason: string;
  if (impressions !== null && impressions > 0) {
    status = 'validated';
    statusReason = `Observed first-party demand: ${impressions} Search Console impressions on visible query rows.`;
  } else if (volumes.some((v) => v > 0)) {
    status = 'validated';
    statusReason = `Third-party search-volume estimate available (max ${Math.max(...volumes)}/month, estimate).`;
  } else if (independentOrigins >= 2 || signals.filter((s) => s.origin !== 'business_knowledge').length >= minIndependent) {
    status = 'weak';
    statusReason = 'Recurring customer questions/discussions without a search-demand measurement. Engagement and question counts are not search volume.';
  } else if (independentOrigins === 1) {
    status = 'weak';
    statusReason = 'A single external signal; demand not established.';
  } else {
    status = 'unvalidated';
    statusReason = 'Only business knowledge supports this topic; no external demand evidence.';
  }

  const limitations = [...new Set(signals.map((s) => s.limitations || DEFAULT_LIMITATIONS[s.origin as SignalOrigin] || ''))].filter(Boolean);
  if (fixture) limitations.push(DEFAULT_LIMITATIONS.fixture);

  const examples = [...signals]
    .sort((a, b) => a.origin.localeCompare(b.origin) || a.collectedAt.localeCompare(b.collectedAt))
    .slice(0, 8)
    .map((s) => ({ signalId: s.id, origin: s.origin, text: truncate(s.text, 200), url: s.url }));

  return {
    status,
    statusReason,
    window: gscWindow,
    gsc: {
      impressions: impressions === null ? missingN(gscMissing) : observedN(impressions),
      clicks: clicks === null ? missingN(gscMissing) : observedN(clicks),
      weightedPosition: posImpr > 0 ? observedN(Math.round((posWeighted / posImpr) * 100) / 100) : missingN(gscMissing),
      queries: gscSignals.length,
      label: 'OBSERVED first-party (Search Console visible query rows; byPage rows summed per query)',
    },
    searchVolumeEstimate: {
      max: volumes.length ? observedN(Math.max(...volumes)) : missingN(volumeKeywords.length ? 'Provider returned no volume for these keywords' : 'No approved DataForSEO research for this item'),
      keywords: volumeKeywords,
      label: 'ESTIMATE (third-party; not exact demand; never summed across keywords)',
    },
    community: {
      threads,
      totalUpvotes: upvotes === null ? missingN(threads ? 'Engagement not reported' : 'No community discussions') : observedN(upvotes),
      totalComments: comments === null ? missingN(threads ? 'Comment counts not reported' : 'No community discussions') : observedN(comments),
      label: 'ENGAGEMENT (user-reported discussions; not search volume; not a representative survey)',
    },
    manualQuestions,
    competitorGaps,
    businessKnowledge,
    origins,
    signalCount: signals.length,
    examples,
    limitations,
    sandboxExcluded: 0,
    ...(opts.sourceStatus?.length ? { sourceCollection: Object.fromEntries(opts.sourceStatus.map((x) => [x.origin, { status: x.status, detail: x.detail }])) } : {}),
  };
}

export function validateDemand(
  ctx: AppContext,
  items: ContentItem[],
  opts: { sandboxExcluded?: number; classificationByItem?: Map<string, { intents: string[]; sources: string[]; rationale: string[]; formatHints: string[] }>; sourceStatus?: SourceStatusList } = {},
): { validated: number; weak: number; unvalidated: number } {
  const now = ctx.clock.now().toISOString();
  let validated = 0;
  let weak = 0;
  let unvalidated = 0;
  ctx.db.transaction(() => {
    for (const item of items) {
      const signals = listSignals(ctx.db, ctx.siteId, { itemId: item.id });
      const demand = computeDemand(signals, opts.sourceStatus ? { sourceStatus: opts.sourceStatus } : {});
      demand.sandboxExcluded = opts.sandboxExcluded ?? 0;
      const prev: Partial<ItemDemand> = item.demand ?? {};
      const cls = opts.classificationByItem?.get(item.id);
      const next: ItemDemand = {
        ...prev,
        ...demand,
        ...(cls ? { classification: { intents: cls.intents, sources: cls.sources, rationale: cls.rationale }, formatHints: cls.formatHints } : {}),
      };
      const stage = ['clustered', 'demand_validated'].includes(item.stage) ? 'demand_validated' : item.stage;
      updateItem(ctx.db, ctx.siteId, item.id, { demand: next, stage, isSynthetic: item.isSynthetic || signals.some((s) => s.isSynthetic) }, now);
      if (demand.status === 'validated') validated++;
      else if (demand.status === 'weak') weak++;
      else unvalidated++;
    }
  });
  return { validated, weak, unvalidated };
}

/**
 * A count from a source is OBSERVED when the count is positive, or when the
 * source was collected and simply had nothing for this item. When the source
 * was never collected (no Apify run, no import, no competitor data), the
 * count is DATA_UNAVAILABLE, never an observed zero.
 */
function sourceCount(d: DemandEvidence, origin: string, n: number, what: string): { value: string; label: string } {
  if (n > 0) return { value: String(n), label: 'OBSERVED' };
  const s = d.sourceCollection?.[origin];
  if (s && (s.status === 'collected' || s.status === 'empty')) return { value: `0 (${what} collected; none matched this item)`, label: 'OBSERVED' };
  return { value: `DATA UNAVAILABLE (${s ? `${s.status}: ${s.detail}` : `collection status of ${what} not recorded`})`, label: 'DATA_UNAVAILABLE' };
}

/**
 * Human-readable demand lines with claim labels (used in notes and briefs).
 * Search Console lines are OBSERVED first-party measurements; the search-volume
 * line is INFERRED (a third-party estimate) and never counts as observed
 * number support in the brief gate.
 */
export function demandSummaryLines(d: DemandEvidence): Array<{ metric: string; value: string; label: string }> {
  const fmt = (m: MeasuredNumber) => (m.status === 'observed' ? String(m.value) : `DATA UNAVAILABLE (${m.reason})`);
  const win = d.window?.start && d.window?.end ? ` (${d.window.start}..${d.window.end})` : '';
  return [
    { metric: `Search Console impressions${win}`, value: fmt(d.gsc.impressions), label: d.gsc.impressions.status === 'observed' ? 'OBSERVED' : 'DATA_UNAVAILABLE' },
    { metric: `Search Console clicks${win}`, value: fmt(d.gsc.clicks), label: d.gsc.clicks.status === 'observed' ? 'OBSERVED' : 'DATA_UNAVAILABLE' },
    { metric: 'Search Console impression-weighted position', value: fmt(d.gsc.weightedPosition), label: d.gsc.weightedPosition.status === 'observed' ? 'OBSERVED' : 'DATA_UNAVAILABLE' },
    // A provider search-volume figure is a third-party ESTIMATE, never an observed demand measurement.
    {
      metric: 'Max monthly search-volume ESTIMATE (third-party estimate, not exact demand)',
      value: d.searchVolumeEstimate.max.status === 'observed' ? `${d.searchVolumeEstimate.max.value} (third-party estimate)` : fmt(d.searchVolumeEstimate.max),
      label: d.searchVolumeEstimate.max.status === 'observed' ? 'INFERRED' : 'DATA_UNAVAILABLE',
    },
    { metric: 'Community threads (engagement, not volume)', ...sourceCount(d, 'apify_reddit', d.community.threads, 'community discussions') },
    { metric: 'Manual customer questions', ...sourceCount(d, 'manual', d.manualQuestions, 'manual questions') },
    { metric: 'Competitor gap signals', ...sourceCount(d, 'competitor_gap', d.competitorGaps, 'competitor data') },
  ];
}
