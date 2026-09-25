import type { AppContext } from '../app/context.js';
import { hashObject } from '../core/hash.js';
import { addDays } from '../core/time.js';
import { parseJson } from '../database/db.js';
import type { MemoryRetriever } from '../memory/types.js';
import { ensureSource, listSignals, upsertSignal } from './store.js';
import { detectInstructionLikeText, isQuestion, lexicalSimilarity, sentences, truncate } from './text.js';
import { DEFAULT_LIMITATIONS, type CollectionWindow, type ContentSignal, type DiscoverOutput, type SignalInput, type SignalOrigin } from './types.js';

/**
 * DISCOVER: combine first-party Search Console queries, approved (non-sandbox)
 * DataForSEO research, Apify customer questions, competitor gaps, business
 * knowledge, and manually imported questions into content_signals.
 *
 * Each signal records its origin, collection window, limitations, and
 * supporting examples/metrics. Reddit engagement is stored as engagement,
 * never as search volume. Sandbox research is excluded and counted.
 */

export interface DiscoverOptions {
  /** GSC lookback window in days ending at the latest available date (default 28). */
  gscDays?: number;
  /** Maximum GSC queries collected, by impressions (default 200). */
  maxGscQueries?: number;
  /** Include is_synthetic=1 signals (default: only when the context is synthetic/demo). */
  includeSynthetic?: boolean;
  /** Memory retrieval queries (default: offer + seed topics). */
  memoryQueries?: string[];
  /** Do not persist anything (preview). */
  preview?: boolean;
}

interface SourceStatus {
  origin: string;
  status: 'collected' | 'empty' | 'unavailable' | 'disabled' | 'skipped';
  detail: string;
}

interface Collected {
  inputs: SignalInput[];
  status: SourceStatus;
  window?: CollectionWindow | null;
}

const EXCLUDED_APIFY_STATUSES = new Set(['quarantined', 'FAILED', 'ABORTED', 'TIMED-OUT', 'TIMING-OUT', 'ABORTING', 'ambiguous', 'submitting', 'READY', 'RUNNING']);

export async function discoverSignals(ctx: AppContext, memory: MemoryRetriever | null, opts: DiscoverOptions = {}): Promise<DiscoverOutput & { signals: ContentSignal[] }> {
  const now = ctx.clock.now().toISOString();
  const includeSynthetic = opts.includeSynthetic ?? ctx.synthetic;
  const statuses: SourceStatus[] = [];

  const gsc = collectGsc(ctx, opts, !!opts.preview);
  const dfs = collectDataForSeo(ctx);
  const comp = collectCompetitorGaps(ctx);
  const biz = await collectBusinessKnowledge(ctx, memory, opts);
  statuses.push(gsc.status, dfs.status, comp.status, biz.status);

  const collected = [...gsc.inputs, ...dfs.inputs, ...comp.inputs, ...biz.inputs];
  let newOrUpdated = 0;
  if (!opts.preview) {
    ctx.db.transaction(() => {
      for (const input of collected) {
        upsertSignal(ctx.db, ctx.siteId, input, now);
        newOrUpdated++;
      }
    });
  }

  // Read every persisted signal (includes Apify/manual/fixture signals written elsewhere).
  const all = opts.preview ? [] : listSignals(ctx.db, ctx.siteId);
  const quarantined = quarantinedApifySignalIds(ctx);
  let quarantinedCount = 0;
  let syntheticCount = 0;
  const eligible: ContentSignal[] = [];
  for (const s of all) {
    if (s.origin === 'apify_reddit' && quarantined.has(s.id)) {
      quarantinedCount++;
      continue;
    }
    if (s.isSynthetic && !includeSynthetic) {
      syntheticCount++;
      continue;
    }
    eligible.push(s);
  }

  const counts: Record<string, number> = {};
  for (const s of opts.preview ? collected.map((c) => ({ origin: c.origin })) : eligible) counts[s.origin] = (counts[s.origin] ?? 0) + 1;
  for (const origin of ['apify_reddit', 'manual'] as const) {
    const n = counts[origin] ?? 0;
    // Distinguish "collected, nothing eligible" from "never collected": a missing source is not an observed zero.
    const collectedBefore =
      origin === 'apify_reddit'
        ? Number(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM apify_runs WHERE site_id = ? AND status = 'SUCCEEDED'`, [ctx.siteId])?.n ?? 0) > 0
        : Number(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sources WHERE site_id = ? AND source_type = 'manual_import'`, [ctx.siteId])?.n ?? 0) > 0;
    statuses.push({
      origin,
      status: opts.preview ? 'skipped' : n > 0 ? 'collected' : collectedBefore ? 'empty' : 'unavailable',
      detail: opts.preview
        ? 'preview: previously stored signals are not read'
        : n > 0
          ? `${n} stored signal(s) read from content_signals`
          : collectedBefore
            ? origin === 'apify_reddit'
              ? 'Apify runs succeeded but no eligible Reddit signals remain (quarantined/synthetic excluded or none classified).'
              : 'Manual questions were imported but none are eligible (synthetic excluded).'
            : origin === 'apify_reddit'
              ? 'Not collected: no successful Apify Reddit run stored (run the Apify adapter with an approved, budgeted run).'
              : 'Not collected: no manual questions imported (use `content import <file>`).',
    });
  }

  return {
    signals: eligible,
    signalIds: eligible.map((s) => s.id),
    unassignedSignalIds: eligible.filter((s) => !s.contentItemId).map((s) => s.id),
    countsByOrigin: counts,
    newOrUpdated,
    excluded: {
      sandboxKeywordMetrics: dfs.sandboxMetrics,
      sandboxSerpSnapshots: comp.sandboxSnapshots,
      quarantinedApifySignals: quarantinedCount,
      syntheticSignals: syntheticCount,
    },
    sourceStatus: statuses,
    window: gsc.window ?? null,
  };
}

// ---------------------------------------------------------------------------
// Search Console
// ---------------------------------------------------------------------------

export function brandMatcher(ctx: AppContext): (text: string) => boolean {
  const aliases = ctx.config.brand.aliases.map((a) => a.toLowerCase().trim()).filter((a) => a.length >= 2);
  return (text: string) => {
    const t = text.toLowerCase();
    return aliases.some((a) => t.includes(a));
  };
}

function collectGsc(ctx: AppContext, opts: DiscoverOptions, preview: boolean): Collected & { window: CollectionWindow | null } {
  const days = opts.gscDays ?? 28;
  const max = opts.maxGscQueries ?? 200;
  const property = ctx.config.google.searchConsoleProperty;
  const propFilter = property ? ' AND property = ?' : '';
  const baseParams: unknown[] = property ? [ctx.siteId, property] : [ctx.siteId];
  const latest = ctx.db.get<{ d: string | null; tz: string | null }>(
    `SELECT MAX(date) AS d, MAX(date_tz) AS tz FROM gsc_page_query_daily_current WHERE site_id = ?${propFilter} AND search_type = 'web' AND segment_key = ''`,
    baseParams,
  );
  if (!latest?.d) {
    return {
      inputs: [],
      window: null,
      status: { origin: 'gsc_query', status: 'empty', detail: 'No Search Console page/query rows stored for this site (run `sync gsc` once Google access is configured).' },
    };
  }
  const end = latest.d;
  const start = addDays(end, -(days - 1));
  const window: CollectionWindow = { start, end, timeZone: latest.tz, description: `Search Console web search, ${days} days ending at the latest stored date (dates in ${latest.tz ?? 'the Search Console reporting zone'}).` };
  const rows = ctx.db.all<{ query: string; clicks: number; impressions: number; wpos: number | null; pages: number; synthetic: number }>(
    `SELECT query, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
            SUM(CASE WHEN position IS NOT NULL THEN position * impressions END) / NULLIF(SUM(CASE WHEN position IS NOT NULL THEN impressions END), 0) AS wpos,
            COUNT(DISTINCT page) AS pages, MAX(is_synthetic) AS synthetic
     FROM gsc_page_query_daily_current
     WHERE site_id = ?${propFilter} AND search_type = 'web' AND segment_key = '' AND date BETWEEN ? AND ?
     GROUP BY query ORDER BY impressions DESC, query LIMIT ?`,
    [...baseParams, start, end, max],
  );
  if (!rows.length) {
    return { inputs: [], window, status: { origin: 'gsc_query', status: 'empty', detail: `No query rows in ${start}..${end}.` } };
  }
  const selected = new Set(rows.map((r) => r.query));
  const pageRows = ctx.db.all<{ query: string; page: string; page_id: string | null; clicks: number; impressions: number; wpos: number | null }>(
    `SELECT query, page, MAX(page_id) AS page_id, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
            SUM(CASE WHEN position IS NOT NULL THEN position * impressions END) / NULLIF(SUM(CASE WHEN position IS NOT NULL THEN impressions END), 0) AS wpos
     FROM gsc_page_query_daily_current
     WHERE site_id = ?${propFilter} AND search_type = 'web' AND segment_key = '' AND date BETWEEN ? AND ?
     GROUP BY query, page`,
    [...baseParams, start, end],
  );
  const pagesByQuery = new Map<string, Array<{ page: string; pageId: string | null; clicks: number; impressions: number; position: number | null }>>();
  for (const p of pageRows) {
    if (!selected.has(p.query)) continue;
    const list = pagesByQuery.get(p.query) ?? [];
    list.push({ page: p.page, pageId: p.page_id, clicks: p.clicks, impressions: p.impressions, position: p.wpos === null ? null : round(p.wpos, 2) });
    pagesByQuery.set(p.query, list);
  }
  const isBranded = brandMatcher(ctx);
  const sourceId = preview ? null : ensureSource(ctx.db, {
    siteId: ctx.siteId,
    sourceType: 'gsc',
    trustClass: 'first_party_measurement',
    url: `gsc://${property ?? 'stored-properties'}/page-query/${start}..${end}`,
    title: `Search Console page/query rows ${start}..${end}`,
    contentHash: hashObject(rows),
    retrievedAt: ctx.clock.now().toISOString(),
    metadata: { aggregation: 'byPage rows summed per query', segmentKey: '', searchType: 'web', window },
  });
  const inputs: SignalInput[] = rows.map((r) => ({
    origin: 'gsc_query',
    signalType: isQuestion(r.query) ? 'question' : 'query',
    text: r.query,
    url: null,
    collectionWindow: window,
    engagement: {
      kind: 'gsc_metrics',
      impressions: r.impressions,
      clicks: r.clicks,
      weightedPosition: r.wpos === null ? null : round(r.wpos, 2),
      pagesWithImpressions: r.pages,
      pages: (pagesByQuery.get(r.query) ?? []).sort((a, b) => b.impressions - a.impressions).slice(0, 5),
      branded: isBranded(r.query),
      property: property ?? null,
      searchType: 'web',
    },
    limitations: DEFAULT_LIMITATIONS.gsc_query,
    sourceId,
    isSynthetic: r.synthetic === 1,
  }));
  return { inputs, window, status: { origin: 'gsc_query', status: 'collected', detail: `${inputs.length} visible queries (${start}..${end}).` } };
}

// ---------------------------------------------------------------------------
// DataForSEO (approved research only; sandbox excluded)
// ---------------------------------------------------------------------------

function collectDataForSeo(ctx: AppContext): Collected & { sandboxMetrics: number } {
  const sandbox = Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM keyword_metrics WHERE site_id = ? AND is_sandbox = 1', [ctx.siteId])?.n ?? 0);
  const rows = ctx.db.all<{
    keyword_id: string;
    keyword: string;
    language: string | null;
    intent: string | null;
    search_volume: number | null;
    competition: number | null;
    provider: string;
    location_code: number | null;
    language_code: string | null;
    collected_at: string;
    expires_at: string;
  }>(
    `SELECT k.id AS keyword_id, k.keyword, k.language, k.intent, km.search_volume, km.competition, km.provider, km.location_code, km.language_code, km.collected_at, km.expires_at
     FROM keywords k JOIN keyword_metrics km ON km.keyword_id = k.id AND km.site_id = k.site_id
     WHERE k.site_id = ? AND km.is_sandbox = 0
       AND km.collected_at = (SELECT MAX(km2.collected_at) FROM keyword_metrics km2 WHERE km2.keyword_id = k.id AND km2.site_id = k.site_id AND km2.is_sandbox = 0)
     ORDER BY k.keyword`,
    [ctx.siteId],
  );
  if (!rows.length) {
    return {
      inputs: [],
      sandboxMetrics: sandbox,
      status: {
        origin: 'dataforseo',
        status: 'empty',
        detail: sandbox > 0 ? `No live research stored; ${sandbox} sandbox metric row(s) excluded (sandbox numbers are never used in recommendations).` : 'No approved DataForSEO research stored.',
      },
    };
  }
  const inputs: SignalInput[] = rows.map((r) => ({
    origin: 'dataforseo',
    signalType: isQuestion(r.keyword) ? 'question' : 'query',
    text: r.keyword,
    collectionWindow: { start: null, end: r.collected_at.slice(0, 10), timeZone: null, description: `Provider estimate collected ${r.collected_at} (location ${r.location_code ?? 'unknown'}, language ${r.language_code ?? 'unknown'}).` },
    engagement: {
      kind: 'search_volume_estimate',
      estimate: true,
      searchVolume: r.search_volume,
      competition: r.competition,
      provider: r.provider,
      locationCode: r.location_code,
      languageCode: r.language_code,
      collectedAt: r.collected_at,
      expiresAt: r.expires_at,
      keywordId: r.keyword_id,
      providerIntent: r.intent,
    },
    limitations: DEFAULT_LIMITATIONS.dataforseo + (r.search_volume === null ? ' Volume not provided for this keyword (missing, not zero).' : ''),
  }));
  return {
    inputs,
    sandboxMetrics: sandbox,
    status: { origin: 'dataforseo', status: 'collected', detail: `${inputs.length} keyword estimate(s)${sandbox ? `; ${sandbox} sandbox row(s) excluded` : ''}.` },
  };
}

// ---------------------------------------------------------------------------
// Apify run quarantine
// ---------------------------------------------------------------------------

function quarantinedApifySignalIds(ctx: AppContext): Set<string> {
  const rows = ctx.db.all<{ id: string; status: string | null; quarantine_reason: string | null }>(
    `SELECT s.id, r.status, r.quarantine_reason FROM content_signals s LEFT JOIN apify_runs r ON r.id = s.apify_run_id
     WHERE s.site_id = ? AND s.origin = 'apify_reddit' AND s.apify_run_id IS NOT NULL`,
    [ctx.siteId],
  );
  return new Set(rows.filter((r) => r.status === null || EXCLUDED_APIFY_STATUSES.has(r.status) || r.quarantine_reason).map((r) => r.id));
}

// ---------------------------------------------------------------------------
// Competitor gaps
// ---------------------------------------------------------------------------

export function parseHeadings(raw: string | null): Array<{ level: number | null; text: string }> {
  const parsed = parseJson<unknown>(raw, null);
  const out: Array<{ level: number | null; text: string }> = [];
  const visit = (v: unknown, level: number | null) => {
    if (typeof v === 'string') out.push({ level, text: v });
    else if (Array.isArray(v)) for (const x of v) visit(x, level);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const text = typeof o.text === 'string' ? o.text : null;
      const lvlRaw = o.level ?? o.tag;
      const lvl = typeof lvlRaw === 'number' ? lvlRaw : typeof lvlRaw === 'string' && /^h?\d$/i.test(lvlRaw) ? Number(lvlRaw.replace(/h/i, '')) : level;
      if (text) out.push({ level: lvl, text });
      else for (const [k, val] of Object.entries(o)) visit(val, /^h\d$/i.test(k) ? Number(k.slice(1)) : level);
    }
  };
  visit(parsed, null);
  return out;
}

function collectCompetitorGaps(ctx: AppContext): Collected & { sandboxSnapshots: number } {
  const sandboxSnapshots = Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM serp_snapshots WHERE site_id = ? AND is_sandbox = 1', [ctx.siteId])?.n ?? 0);
  const competitorDomains = new Set(ctx.db.all<{ domain: string }>('SELECT domain FROM competitors WHERE site_id = ?', [ctx.siteId]).map((r) => r.domain.toLowerCase()));
  for (const c of ctx.config.research.competitors) competitorDomains.add(c.domain.toLowerCase());
  const inputs: SignalInput[] = [];

  // 1) SERP gaps: our site absent while known competitors rank (non-sandbox snapshots only).
  const snaps = ctx.db.all<{ id: string; query: string; collected_at: string; location_code: number | null; language_code: string | null; device: string }>(
    `SELECT id, query, collected_at, location_code, language_code, device FROM serp_snapshots WHERE site_id = ? AND is_sandbox = 0 ORDER BY collected_at DESC`,
    [ctx.siteId],
  );
  const seenQuery = new Set<string>();
  for (const s of snaps) {
    if (seenQuery.has(s.query)) continue;
    seenQuery.add(s.query);
    const results = ctx.db.all<{ domain: string | null; is_own_site: number; rank_absolute: number | null }>(
      `SELECT domain, is_own_site, rank_absolute FROM serp_results WHERE site_id = ? AND snapshot_id = ? AND result_type = 'organic'`,
      [ctx.siteId, s.id],
    );
    if (!results.length) continue;
    const own = results.some((r) => r.is_own_site === 1);
    const comps = [...new Set(results.map((r) => (r.domain ?? '').toLowerCase()).filter((d) => d && [...competitorDomains].some((c) => d === c || d.endsWith(`.${c}`))))];
    if (own || comps.length === 0) continue;
    inputs.push({
      origin: 'competitor_gap',
      signalType: isQuestion(s.query) ? 'question' : 'query',
      text: s.query,
      collectionWindow: { start: null, end: s.collected_at.slice(0, 10), timeZone: null, description: `SERP snapshot ${s.id} collected ${s.collected_at} (${s.device}, location ${s.location_code ?? 'unknown'}).` },
      engagement: { kind: 'serp_gap', snapshotId: s.id, competitorDomains: comps, ownSitePresent: false, resultsChecked: results.length },
      limitations: DEFAULT_LIMITATIONS.competitor_gap,
    });
  }

  // 2) Competitor question headings not covered by our own titles/headings.
  const compPages = ctx.db.all<{ id: string; url: string; headings_json: string | null; fetched_at: string; is_synthetic: number }>(
    `SELECT cr.id, COALESCE(cr.final_url, cr.requested_url) AS url, cr.headings_json, cr.fetched_at, c.is_synthetic
     FROM crawl_results cr JOIN crawls c ON c.id = cr.crawl_id
     WHERE cr.site_id = ? AND c.kind = 'competitor' AND cr.headings_json IS NOT NULL AND cr.status_code BETWEEN 200 AND 299
     ORDER BY cr.fetched_at DESC LIMIT 200`,
    [ctx.siteId],
  );
  if (compPages.length) {
    const own = ownSiteHeadings(ctx);
    let added = 0;
    for (const p of compPages) {
      let perPage = 0;
      for (const h of parseHeadings(p.headings_json)) {
        if (added >= 100 || perPage >= 10) break;
        const text = h.text.replace(/\s+/g, ' ').trim();
        if (text.length < 10 || text.length > 160 || !text.endsWith('?')) continue;
        if (h.level !== null && (h.level < 2 || h.level > 3)) continue;
        if (own.some((o) => lexicalSimilarity(o, text) >= 0.5)) continue;
        const injected = detectInstructionLikeText(text);
        inputs.push({
          origin: 'competitor_gap',
          signalType: 'question',
          text,
          url: p.url,
          collectionWindow: { start: null, end: p.fetched_at.slice(0, 10), timeZone: null, description: `Competitor page crawled ${p.fetched_at}.` },
          engagement: { kind: 'competitor_heading', crawlResultId: p.id, headingLevel: h.level, ...(injected.length ? { instructionLikeText: injected } : {}) },
          limitations: DEFAULT_LIMITATIONS.competitor_gap + ' Only the heading topic is used; competitor text must not be copied.',
          isSynthetic: p.is_synthetic === 1,
        });
        perPage++;
        added++;
      }
    }
  }
  return {
    inputs,
    sandboxSnapshots,
    status: {
      origin: 'competitor_gap',
      status: inputs.length ? 'collected' : snaps.length || compPages.length ? 'empty' : 'unavailable',
      detail: inputs.length
        ? `${inputs.length} competitor gap signal(s)${sandboxSnapshots ? `; ${sandboxSnapshots} sandbox SERP snapshot(s) excluded` : ''}.`
        : snaps.length || compPages.length
          ? 'Competitive data present but no uncovered gaps found.'
          : `No competitive comparison data stored (SERP research or competitor crawl)${sandboxSnapshots ? `; ${sandboxSnapshots} sandbox snapshot(s) excluded` : ''}.`,
    },
  };
}

function ownSiteHeadings(ctx: AppContext): string[] {
  const rows = ctx.db.all<{ title: string | null; headings_json: string | null }>(
    `SELECT cr.title, cr.headings_json FROM crawl_results cr JOIN crawls c ON c.id = cr.crawl_id
     WHERE cr.site_id = ? AND c.kind IN ('own_site', 'single_page')`,
    [ctx.siteId],
  );
  const out: string[] = [];
  for (const r of rows) {
    if (r.title) out.push(r.title);
    for (const h of parseHeadings(r.headings_json)) out.push(h.text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Business knowledge (config + owner-approved memory)
// ---------------------------------------------------------------------------

async function collectBusinessKnowledge(ctx: AppContext, memory: MemoryRetriever | null, opts: DiscoverOptions): Promise<Collected> {
  const inputs: SignalInput[] = [];
  const now = ctx.clock.now().toISOString();
  const cfgWindow: CollectionWindow = { start: null, end: now.slice(0, 10), timeZone: null, description: 'Site configuration (owner-maintained).' };
  for (const topic of ctx.config.research.seedTopics) {
    if (!topic.trim()) continue;
    inputs.push({
      origin: 'business_knowledge',
      signalType: isQuestion(topic) ? 'question' : 'query',
      text: topic.trim(),
      collectionWindow: cfgWindow,
      engagement: { kind: 'config', field: 'research.seedTopics' },
      limitations: DEFAULT_LIMITATIONS.business_knowledge,
      // A demo-profile config is itself a synthetic fixture: flag what is derived from it.
      ...(ctx.synthetic ? { isSynthetic: true } : {}),
    });
  }
  let detail = `${inputs.length} seed topic(s) from site config`;
  if (!memory) {
    return { inputs, status: { origin: 'business_knowledge', status: inputs.length ? 'collected' : 'unavailable', detail: `${detail}; memory retriever not wired, business notes not searched.` } };
  }
  const queries = (opts.memoryQueries ?? [ctx.config.business.offer ?? '', ...ctx.config.research.seedTopics]).map((q) => q.trim()).filter(Boolean).slice(0, 5);
  let degraded: string | null = null;
  let found = 0;
  for (const q of queries) {
    const res = await memory.search({
      siteId: ctx.siteId,
      text: q,
      sourceTypes: ['business_note', 'decision', 'approved_learning'],
      trustClasses: ['owner_approved'],
      limit: 10,
    });
    if (res.degraded) degraded = res.degradedReason ?? 'degraded retrieval';
    for (const chunk of res.chunks) {
      // Defense in depth: website filter and trust are enforced here too.
      if (chunk.trustClass !== 'owner_approved' || chunk.documentStatus !== 'active' || chunk.recordStatus === 'rejected') continue;
      for (const sentence of sentences(chunk.text)) {
        const text = sentence.trim();
        if (!text.endsWith('?') || text.length < 10 || text.length > 200) continue;
        inputs.push({
          origin: 'business_knowledge',
          signalType: 'question',
          text,
          url: chunk.sourceUrl,
          collectionWindow: { start: null, end: chunk.sourceDate, timeZone: null, description: `Owner-approved note "${truncate(chunk.title, 80)}" (${chunk.sourceRef}).` },
          engagement: { kind: 'memory', chunkId: chunk.chunkId, documentId: chunk.documentId, sourceRef: chunk.sourceRef, sourceType: chunk.sourceType },
          limitations: DEFAULT_LIMITATIONS.business_knowledge,
          ...(ctx.synthetic ? { isSynthetic: true } : {}),
        });
        found++;
      }
    }
  }
  detail += `; ${found} question(s) from owner-approved notes${degraded ? ` (retrieval degraded: ${degraded})` : ''}`;
  return { inputs, status: { origin: 'business_knowledge', status: inputs.length ? 'collected' : 'empty', detail } };
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Map an origin to a human label used in notes and briefs. */
export function originLabel(origin: SignalOrigin | string): string {
  switch (origin) {
    case 'gsc_query':
      return 'Search Console query';
    case 'dataforseo':
      return 'DataForSEO estimate';
    case 'apify_reddit':
      return 'Reddit discussion (Apify)';
    case 'competitor_gap':
      return 'Competitor gap';
    case 'business_knowledge':
      return 'Business knowledge';
    case 'manual':
      return 'Manual customer question';
    case 'fixture':
      return 'Synthetic fixture';
    default:
      return origin;
  }
}
