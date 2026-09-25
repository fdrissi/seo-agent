/**
 * SYNTHETIC seed data for content-slice tests. Fictional business
 * ("Crumb Planner (synthetic)") on the reserved example.test domain.
 * All rows are clearly synthetic test data.
 */
import { newId } from '../../../src/core/ids.js';
import { normalizedTextHash } from '../../../src/content/text.js';
import type { AppContext } from '../../../src/app/context.js';
import type { SiteConfig, SiteConfigInput } from '../../../src/config/site-schema.js';
import type { StructuredRequest } from '../../../src/integrations/llm/types.js';
import { testSiteConfig } from '../../helpers/context.js';

export const SITE_URL = 'https://www.example.test/';

export function contentConfig(overrides: Partial<SiteConfigInput> = {}): SiteConfig {
  return testSiteConfig({
    profile: 'demo',
    business: {
      offer: 'Planner software that helps small bakeries schedule production and staff shifts',
      targetCustomer: 'Owners of small bakeries',
      differentiators: ['Shift templates built for early-morning bakery production'],
      productFacts: [
        { id: 'pf-export', statement: 'The planner exports production schedules to CSV.', source: 'owner', verifiedAt: '2026-09-01' },
        { id: 'pf-templates', statement: 'The planner includes reusable shift templates.', source: 'owner', verifiedAt: '2026-09-01' },
      ],
      approvedClaims: ['Plan the weekly production schedule in one place.'],
      prohibitedClaims: ['guaranteed profit'],
    },
    market: { languages: ['en'] },
    research: { seedTopics: ['bakery production schedule'] },
    brand: { aliases: ['crumb planner'] },
    conversions: { primaryEvents: [{ name: 'start_trial', meaning: 'Free trial started', kind: 'signup' }] },
    ...overrides,
    site: { businessName: 'Crumb Planner (synthetic)', url: SITE_URL, allowedHostnames: ['www.example.test'], ...(overrides.site ?? {}) },
  } as Partial<SiteConfigInput> & { site?: Partial<SiteConfigInput['site']> });
}

export interface SeedPage {
  path: string;
  pageType?: string;
  title?: string;
  headings?: string[];
  text?: string;
  status?: number;
}

export function seedPages(ctx: AppContext, pages: SeedPage[], opts: { synthetic?: boolean } = {}): Record<string, string> {
  const syn = opts.synthetic === false ? 0 : 1;
  const now = ctx.clock.now().toISOString();
  const crawlId = newId('crawl');
  ctx.db.run(`INSERT INTO crawls (id, site_id, kind, status, is_synthetic, started_at, finished_at) VALUES (?, ?, 'own_site', 'completed', ?, ?, ?)`, [crawlId, ctx.siteId, syn, now, now]);
  const ids: Record<string, string> = {};
  for (const p of pages) {
    const url = new URL(p.path, SITE_URL).toString();
    const pageId = newId('page');
    ids[p.path] = pageId;
    ctx.db.run(`INSERT INTO pages (id, site_id, url, host, path, first_source, page_type, lifecycle, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'www.example.test', ?, 'fixture', ?, 'active', ?, ?)`, [pageId, ctx.siteId, url, p.path, p.pageType ?? 'article', now, now]);
    const textRef = p.text ? ctx.raw.save({ siteId: ctx.siteId, provider: 'crawl', kind: 'text', payload: { text: p.text } }) : null;
    ctx.db.run(
      `INSERT INTO crawl_results (id, crawl_id, site_id, page_id, requested_url, final_url, status_code, fetched_at, render_mode, robots_allowed, title, headings_json, text_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fixture', 1, ?, ?, ?)`,
      [newId('cr'), crawlId, ctx.siteId, pageId, url, url, p.status ?? 200, now, p.title ?? null, JSON.stringify((p.headings ?? []).map((t) => ({ level: 2, text: t }))), textRef],
    );
  }
  return ids;
}

export function seedGscQueries(ctx: AppContext, rows: Array<{ query: string; path: string; impressions: number; clicks?: number; position?: number; date?: string }>, opts: { synthetic?: boolean } = {}): void {
  const syn = opts.synthetic === false ? 0 : 1;
  const now = ctx.clock.now().toISOString();
  const batch = newId('batch');
  ctx.db.run(
    `INSERT INTO ingestion_batches (id, site_id, source, dataset, property, date_start, date_end, request_json, status, transformation_version, is_synthetic, started_at)
     VALUES (?, ?, 'gsc', 'gsc_page_query_daily', 'sc-domain:example.test', '2026-09-01', '2026-09-20', '{}', 'succeeded', 'test@1', ?, ?)`,
    [batch, ctx.siteId, syn, now],
  );
  for (const r of rows) {
    const page = new URL(r.path, SITE_URL).toString();
    const pageId = ctx.db.get<{ id: string }>('SELECT id FROM pages WHERE site_id = ? AND url = ?', [ctx.siteId, page])?.id ?? null;
    ctx.db.run(
      `INSERT INTO gsc_page_query_daily (site_id, property, search_type, date, date_tz, page, page_id, query, segment_key, clicks, impressions, ctr, position, aggregation_type, is_final, revision, is_current, row_hash, batch_id, collected_at, transformation_version, is_synthetic)
       VALUES (?, 'sc-domain:example.test', 'web', ?, 'America/Los_Angeles', ?, ?, ?, '', ?, ?, NULL, ?, 'byPage', 1, 1, 1, ?, ?, ?, 'test@1', ?)`,
      [ctx.siteId, r.date ?? '2026-09-20', page, pageId, r.query, r.clicks ?? 0, r.impressions, r.position ?? 8, newId('h'), batch, now, syn],
    );
  }
}

export function seedPropertyImpressions(ctx: AppContext, impressionsPerDay: number, days = 28, end = '2026-09-20'): void {
  const now = ctx.clock.now().toISOString();
  const batch = newId('batch');
  ctx.db.run(
    `INSERT INTO ingestion_batches (id, site_id, source, dataset, property, date_start, date_end, request_json, status, transformation_version, is_synthetic, started_at)
     VALUES (?, ?, 'gsc', 'gsc_property_daily', 'sc-domain:example.test', '2026-08-24', ?, '{}', 'succeeded', 'test@1', 1, ?)`,
    [batch, ctx.siteId, end, now],
  );
  const endDate = new Date(`${end}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    const d = new Date(endDate.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    ctx.db.run(
      `INSERT INTO gsc_property_daily (site_id, property, search_type, date, date_tz, clicks, impressions, aggregation_type, is_final, revision, is_current, row_hash, batch_id, collected_at, transformation_version, is_synthetic)
       VALUES (?, 'sc-domain:example.test', 'web', ?, 'America/Los_Angeles', 0, ?, 'byProperty', 1, 1, 1, ?, ?, ?, 'test@1', 1)`,
      [ctx.siteId, d, impressionsPerDay, newId('h'), batch, now],
    );
  }
}

export function seedKeywordMetric(ctx: AppContext, keyword: string, volume: number | null, sandbox: boolean): void {
  const now = ctx.clock.now().toISOString();
  const kwId = newId('kw');
  ctx.db.run(`INSERT INTO keywords (id, site_id, keyword, normalized, language, first_seen_at) VALUES (?, ?, ?, ?, 'en', ?)`, [kwId, ctx.siteId, keyword, keyword.toLowerCase(), now]);
  ctx.db.run(
    `INSERT INTO keyword_metrics (id, site_id, keyword_id, provider, location_code, language_code, search_volume, is_sandbox, collected_at, expires_at) VALUES (?, ?, ?, 'dataforseo', 2233, 'en', ?, ?, ?, ?)`,
    [newId('km'), ctx.siteId, kwId, volume, sandbox ? 1 : 0, now, '2026-10-24T00:00:00.000Z'],
  );
}

/**
 * A Reddit signal in the SAME shape the Apify adapter writes
 * (src/integrations/apify/normalize.ts): the signal text is the post title,
 * engagement is {score, upVotes, commentsCount, upvoteRatio, note}, the post
 * body lives only in the raw dataset referenced by the source row
 * (`sources.raw_ref` + `metadata_json.itemKey`), plus an evidence row and an
 * occurrence row. SYNTHETIC by default.
 */
export function seedRedditSignal(
  ctx: AppContext,
  s: { text: string; url: string; upVotes?: number; commentsCount?: number; runStatus?: string; body?: string; window?: Record<string, unknown>; synthetic?: boolean },
): string {
  const now = ctx.clock.now().toISOString();
  const syn = s.synthetic === false ? 0 : 1;
  const runId = newId('arun');
  ctx.db.run(
    `INSERT INTO apify_runs (id, site_id, actor_id, status, input_json, input_hash, is_synthetic, created_at, updated_at) VALUES (?, ?, '9sHOY9RzPYGjmTHo8', ?, '{}', 'h', ?, ?, ?)`,
    [runId, ctx.siteId, s.runStatus ?? 'SUCCEEDED', syn, now, now],
  );
  const itemKey = `post:${newId('t3')}`;
  const engagement = { score: s.upVotes ?? 10, upVotes: s.upVotes ?? 10, commentsCount: s.commentsCount ?? 3, upvoteRatio: 0.9 };
  const rawRef = ctx.raw.save({
    siteId: ctx.siteId,
    provider: 'apify',
    kind: 'dataset-items',
    payload: { remoteRunId: 'run_synthetic', datasetId: 'ds_synthetic', total: 1, complete: true, items: [{ key: itemKey, dataType: 'post', itemId: itemKey.slice(5), text: s.text, context: [s.text, s.body ?? ''].filter(Boolean).join('\n'), title: s.text, url: s.url, postedAt: '2026-09-10T00:00:00Z', community: 'r/Baking', searchTerm: 'bakery schedule', engagement }] },
  });
  const sourceId = newId('src');
  ctx.db.run(
    `INSERT INTO sources (id, site_id, source_type, trust_class, url, title, retrieved_at, published_at, raw_ref, content_hash, metadata_json) VALUES (?, ?, 'reddit', ?, ?, ?, ?, '2026-09-10T00:00:00Z', ?, ?, ?)`,
    [sourceId, ctx.siteId, syn ? 'synthetic' : 'user_reported', s.url, s.text, now, rawRef, normalizedTextHash(s.text), JSON.stringify({ dataType: 'post', itemKey, community: 'r/Baking', searchTerm: 'bakery schedule', apifyRunId: runId })],
  );
  const evidenceId = newId('ev');
  ctx.db.run(
    `INSERT INTO evidence (id, site_id, source_id, kind, summary, excerpt, locator_json, value_json, date_range_start, date_range_end, collected_at, transformation_version)
     VALUES (?, ?, ?, 'excerpt', 'Reddit post (question); user-reported', ?, ?, ?, '2026-09-10', '2026-09-10', ?, 'test@1')`,
    [evidenceId, ctx.siteId, sourceId, s.text, JSON.stringify({ itemKey, apifyRunId: runId }), JSON.stringify({ engagement }), now],
  );
  const id = newId('sig');
  ctx.db.run(
    `INSERT INTO content_signals (id, site_id, origin, signal_type, text, normalized_hash, url, posted_at, collected_at, collection_window_json, engagement_json, limitations, source_id, apify_run_id, is_synthetic)
     VALUES (?, ?, 'apify_reddit', 'question', ?, ?, ?, '2026-09-10T00:00:00Z', ?, ?, ?, 'Reddit posts are user-reported; engagement is not search volume.', ?, ?, ?)`,
    [
      id,
      ctx.siteId,
      s.text,
      normalizedTextHash(s.text),
      s.url,
      now,
      JSON.stringify(s.window ?? { start: '2026-08-24', end: '2026-09-23', timeZone: null, description: 'Apify run, time range month' }),
      JSON.stringify({ ...engagement, note: 'Engagement is not search volume.' }),
      sourceId,
      runId,
      syn,
    ],
  );
  ctx.db.run(
    `INSERT INTO apify_signal_occurrences (id, site_id, signal_id, apify_run_id, item_key, source_id, evidence_id, url, posted_at, collected_at, is_synthetic) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-09-10T00:00:00Z', ?, ?)`,
    [newId('occ'), ctx.siteId, id, runId, itemKey, sourceId, evidenceId, s.url, now, syn],
  );
  return id;
}

// ---------------------------------------------------------------------------
// Fixture model handlers
// ---------------------------------------------------------------------------

type Req = StructuredRequest<unknown>;

export const classifyAllInformational = (req: Req) => ({
  items: req.evidence.map((e) => ({ id: e.id, intent: 'informational', confidence: 'medium', rationale: 'Question about how to do something.' })),
});

export function briefSynthesis(req: Req) {
  const ids = req.evidence.map((e) => e.id);
  const sig = ids.find((i) => i.startsWith('sig_')) ?? ids[0]!;
  const fact = ids.find((i) => i.startsWith('fact:')) ?? sig;
  return {
    audience: 'Owners of small bakeries who plan production before dawn.',
    primaryQuestion: 'How do I schedule bakery production for early mornings?',
    businessPurpose: 'Help bakery owners plan production; relates to the planner offer.',
    researchFindings: [{ finding: 'Owners ask how to plan early production runs.', evidenceIds: [sig], label: 'OBSERVED' }],
    uniqueContribution: 'Show how reusable shift templates and CSV schedule exports support early production planning.',
    outline: [
      { heading: 'How to schedule bakery production for early mornings', purpose: 'Direct answer', answers: ['Plan the dough schedule backwards from opening time.'], evidenceIds: [sig] },
      { heading: 'Using shift templates', purpose: 'Connect to product facts', answers: ['The planner includes reusable shift templates.'], evidenceIds: [fact] },
    ],
    usefulExamples: [{ description: 'A worked weekly schedule for a small bakery using a reusable shift template.', evidenceIds: [fact], needsOwnerInput: false }],
    ctaText: 'Start a free trial to plan your next production week.',
    unresolvedQuestions: [],
  };
}

/** A clean draft that uses only supplied facts and links to the verified offer page. */
export function goodDraft(extraBody = '') {
  return {
    titleOptions: ['How to schedule bakery production for early mornings'],
    metaDescription: 'A practical way to schedule bakery production for early mornings, with reusable shift templates and a weekly plan.',
    slugSuggestion: 'schedule-bakery-production-early-mornings',
    bodyMarkdown: [
      '# How to schedule bakery production for early mornings',
      '',
      'To schedule bakery production for early mornings, work backwards from opening time: list each product, its proofing and baking steps, and assign each step to a shift.',
      '',
      '## Using shift templates',
      '',
      'The planner includes reusable shift templates, so the same early production run can be reused every week. The planner exports production schedules to CSV for sharing with staff.',
      '',
      '## A worked weekly schedule',
      '',
      'Start with the busiest day, place dough preparation on the evening shift, and keep baking on the early shift.',
      '',
      '## Next step',
      '',
      `Start a free trial to plan your next production week on the [planner](${SITE_URL}).`,
      extraBody,
    ].join('\n'),
    internalLinkSuggestions: [{ targetUrl: SITE_URL, anchor: 'planner', placement: 'Next step' }],
    structuredDataProposal: null,
    sourceLedger: [{ claim: 'The planner includes reusable shift templates.', evidenceIds: [], factIds: ['pf-templates'] }],
    factCheckNotes: [],
  };
}

export const passingReview = () => ({ verdict: 'pass', issues: [], coverageGaps: [], summary: 'No issues found in the supplied evidence.' });

// ---------------------------------------------------------------------------
// Scenario: a small synthetic bakery-planner site with scheduling demand.
// ---------------------------------------------------------------------------

export function seedSchedulingScenario(ctx: AppContext, opts: { synthetic?: boolean } = {}): void {
  seedPages(ctx, [
    { path: '/', pageType: 'offer', title: 'Crumb Planner: production and shift planning for bakeries', headings: ['Plan production', 'Schedule shifts'], text: 'Crumb Planner helps small bakeries plan production and staff shifts in one place.' },
    { path: '/blog/sourdough-starter-care/', pageType: 'article', title: 'Caring for a sourdough starter', headings: ['Feeding schedule'], text: 'How to feed and store a sourdough starter between bakes.' },
    { path: '/pricing/', pageType: 'other', title: 'Pricing', headings: ['Plans'], text: 'Plans for bakeries.' },
  ], opts);
  seedGscQueries(ctx, [
    { query: 'how to schedule bakery production', path: '/', impressions: 40, clicks: 2, position: 14 },
    { query: 'bakery production schedule', path: '/', impressions: 25, clicks: 1, position: 18 },
    { query: 'bakery production planning tips', path: '/', impressions: 12, clicks: 0, position: 22 },
  ], opts);
  seedKeywordMetric(ctx, 'bakery production schedule', 210, false);
  seedKeywordMetric(ctx, 'bakery schedule app', 9999, true);
}

/** Run the research pipeline and return the scheduling item id. */
export async function researchedSchedulingItem(ctx: AppContext, deps: import('../../../src/content/deps.js').ContentDeps, opts: { synthetic?: boolean } = {}): Promise<string> {
  const { runContentResearch } = await import('../../../src/content/pipeline.js');
  const { listItems, listSignals } = await import('../../../src/content/store.js');
  seedSchedulingScenario(ctx, opts);
  await runContentResearch(ctx, deps, {});
  const item = listItems(ctx.db, ctx.siteId).find((i) => listSignals(ctx.db, ctx.siteId, { itemId: i.id }).some((s) => s.text === 'how to schedule bakery production'));
  if (!item) throw new Error('scenario item not found');
  return item.id;
}

// ---------------------------------------------------------------------------
// SYNTHETIC measurement rows for scoping tests (several properties, non-final
// dates, aliases). Rows are marked is_synthetic = 0 only when a test needs
// values that the metrics module would otherwise refuse to present as
// observed; they are still fictional test data on the reserved example.test
// domain and never leave the temporary test workspace.
// ---------------------------------------------------------------------------

function gscBatch(ctx: AppContext, dataset: 'gsc_page_daily' | 'gsc_property_daily', property: string, start: string, end: string, synthetic: boolean): string {
  const batch = newId('batch');
  ctx.db.run(
    `INSERT INTO ingestion_batches (id, site_id, source, dataset, property, date_start, date_end, request_json, status, transformation_version, is_synthetic, started_at)
     VALUES (?, ?, 'gsc', ?, ?, ?, ?, '{}', 'succeeded', 'test@1', ?, ?)`,
    [batch, ctx.siteId, dataset, property, start, end, synthetic ? 1 : 0, ctx.clock.now().toISOString()],
  );
  return batch;
}

/** Search Console page rows for one property (one batch covering start..end). */
export function seedGscPageRows(
  ctx: AppContext,
  property: string,
  window: { start: string; end: string },
  rows: Array<{ date: string; page: string; pageId?: string | null; clicks?: number; impressions: number; isFinal?: boolean }>,
  opts: { synthetic?: boolean } = {},
): void {
  const syn = opts.synthetic ?? false;
  const batch = gscBatch(ctx, 'gsc_page_daily', property, window.start, window.end, syn);
  const now = ctx.clock.now().toISOString();
  for (const r of rows) {
    ctx.db.run(
      `INSERT INTO gsc_page_daily (site_id, property, search_type, date, date_tz, page, page_id, segment_key, clicks, impressions, ctr, position, aggregation_type, is_final, revision, is_current, row_hash, batch_id, collected_at, transformation_version, is_synthetic)
       VALUES (?, ?, 'web', ?, 'America/Los_Angeles', ?, ?, '', ?, ?, NULL, 5, 'byPage', ?, 1, 1, ?, ?, ?, 'test@1', ?)`,
      [ctx.siteId, property, r.date, r.page, r.pageId ?? null, r.clicks ?? 0, r.impressions, r.isFinal === false ? 0 : 1, newId('h'), batch, now, syn ? 1 : 0],
    );
  }
}

/** Search Console property totals for one property: `days` days ending `end`. */
export function seedPropertyTotals(ctx: AppContext, property: string, impressionsPerDay: number, opts: { days?: number; end?: string; synthetic?: boolean } = {}): void {
  const days = opts.days ?? 28;
  const end = opts.end ?? '2026-09-20';
  const endDate = new Date(`${end}T00:00:00Z`);
  const start = new Date(endDate.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const syn = opts.synthetic ?? false;
  const batch = gscBatch(ctx, 'gsc_property_daily', property, start, end, syn);
  const now = ctx.clock.now().toISOString();
  for (let i = 0; i < days; i++) {
    const d = new Date(endDate.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    ctx.db.run(
      `INSERT INTO gsc_property_daily (site_id, property, search_type, date, date_tz, clicks, impressions, aggregation_type, is_final, revision, is_current, row_hash, batch_id, collected_at, transformation_version, is_synthetic)
       VALUES (?, ?, 'web', ?, 'America/Los_Angeles', 0, ?, 'byProperty', 1, 1, 1, ?, ?, ?, 'test@1', ?)`,
      [ctx.siteId, property, d, impressionsPerDay, newId('h'), batch, now, syn ? 1 : 0],
    );
  }
}

/** Stored GA4 event rows for a (primary) event, one per date. SYNTHETIC. */
export function seedGa4Events(ctx: AppContext, eventName: string, dates: string[], opts: { propertyId?: string } = {}): void {
  const propertyId = opts.propertyId ?? '123456789';
  const now = ctx.clock.now().toISOString();
  const batch = newId('batch');
  ctx.db.run(
    `INSERT INTO ingestion_batches (id, site_id, source, dataset, property, date_start, date_end, request_json, status, transformation_version, is_synthetic, started_at)
     VALUES (?, ?, 'ga4', 'ga4_event_daily', ?, ?, ?, '{}', 'succeeded', 'test@1', 1, ?)`,
    [batch, ctx.siteId, propertyId, dates[0] ?? '2026-09-01', dates[dates.length - 1] ?? '2026-09-01', now],
  );
  for (const d of dates) {
    ctx.db.run(
      `INSERT INTO ga4_event_daily (site_id, property_id, date, date_tz, channel_view, event_name, landing_page, event_count, key_event_count, is_complete, revision, is_current, row_hash, batch_id, collected_at, transformation_version, is_synthetic)
       VALUES (?, ?, ?, 'Europe/Tallinn', 'all_traffic', ?, '', 2, 2, 1, 1, 1, ?, ?, ?, 'test@1', 1)`,
      [ctx.siteId, propertyId, d, eventName, newId('h'), batch, now],
    );
  }
}
