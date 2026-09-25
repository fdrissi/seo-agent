import { parseJson, type Db } from '../database/db.js';

/**
 * Lenient readers for crawl_results JSON columns and extracted text. The
 * crawler owns the exact shapes; these readers accept the documented and
 * common variants and never throw on unexpected input.
 */

export interface TextStore {
  load<T = unknown>(ref: string): T | null;
}

export interface Heading {
  level: number;
  text: string;
}

export interface CrawlResultRow {
  id: string;
  crawl_id: string;
  page_id: string | null;
  requested_url: string;
  final_url: string | null;
  status_code: number | null;
  fetched_at: string;
  title: string | null;
  meta_description: string | null;
  headings_json: string | null;
  word_count: number | null;
  language: string | null;
  text_ref: string | null;
  structured_data_json: string | null;
  images_json: string | null;
  links_internal: number | null;
  links_external: number | null;
  blocked_reason: string | null;
  canonical_url: string | null;
  meta_robots: string | null;
  error: string | null;
}

export const CRAWL_RESULT_COLS =
  'cr.id, cr.crawl_id, cr.page_id, cr.requested_url, cr.final_url, cr.status_code, cr.fetched_at, cr.title, cr.meta_description, cr.headings_json, cr.word_count, cr.language, cr.text_ref, cr.structured_data_json, cr.images_json, cr.links_internal, cr.links_external, cr.blocked_reason, cr.canonical_url, cr.meta_robots, cr.error';

export function parseHeadings(json: string | null): Heading[] {
  const raw = parseJson<unknown>(json, null);
  const out: Heading[] = [];
  const push = (level: unknown, text: unknown) => {
    const l = typeof level === 'number' ? level : typeof level === 'string' ? Number(level.replace(/^h/i, '')) : NaN;
    if (typeof text === 'string' && text.trim() && l >= 1 && l <= 6) out.push({ level: l, text: text.trim() });
  };
  if (Array.isArray(raw)) {
    for (const h of raw) {
      if (h && typeof h === 'object') {
        const o = h as Record<string, unknown>;
        push(o.level ?? o.tag ?? o.depth, o.text ?? o.content);
      }
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (/^h[1-6]$/i.test(k) && Array.isArray(v)) for (const t of v) push(k, t);
    }
  }
  return out;
}

/** Collect schema.org @type values from JSON-LD (handles arrays and @graph). */
export function structuredDataTypes(json: string | null): { types: string[]; dateModified: string | null; datePublished: string | null } {
  const raw = parseJson<unknown>(json, null);
  const types = new Set<string>();
  let dateModified: string | null = null;
  let datePublished: string | null = null;
  const visit = (v: unknown, depth: number) => {
    if (depth > 6 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    const t = o['@type'];
    if (typeof t === 'string') types.add(t);
    else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') types.add(x);
    if (typeof o.dateModified === 'string' && !dateModified) dateModified = o.dateModified;
    if (typeof o.datePublished === 'string' && !datePublished) datePublished = o.datePublished;
    for (const [k, x] of Object.entries(o)) if (k === '@graph' || k === 'items' || k === 'mainEntity' || typeof x === 'object') visit(x, depth + 1);
  };
  visit(raw, 0);
  return { types: [...types], dateModified, datePublished };
}

/** Load extracted visible text from the raw store (string, {text}, or {content}). */
export function loadCrawlText(store: TextStore | null, ref: string | null): string | null {
  if (!store || !ref) return null;
  try {
    const p = store.load<unknown>(ref);
    if (typeof p === 'string') return p;
    if (p && typeof p === 'object') {
      const o = p as Record<string, unknown>;
      for (const k of ['text', 'content', 'visibleText', 'body']) if (typeof o[k] === 'string') return o[k] as string;
    }
    return null;
  } catch {
    return null;
  }
}

export function crawlResultById(db: Db, siteId: string, id: string): CrawlResultRow | undefined {
  return db.get<CrawlResultRow>(`SELECT ${CRAWL_RESULT_COLS} FROM crawl_results cr WHERE cr.site_id = ? AND cr.id = ?`, [siteId, id]);
}

/** Latest crawl observation for a URL within crawls of the given kinds. */
export function latestCrawlResultForUrl(db: Db, siteId: string, url: string, kinds: readonly string[]): CrawlResultRow | undefined {
  const placeholders = kinds.map(() => '?').join(', ');
  return db.get<CrawlResultRow>(
    `SELECT ${CRAWL_RESULT_COLS} FROM crawl_results cr JOIN crawls c ON c.id = cr.crawl_id
      WHERE cr.site_id = ? AND c.kind IN (${placeholders}) AND (cr.final_url = ? OR cr.requested_url = ?)
      ORDER BY cr.fetched_at DESC LIMIT 1`,
    [siteId, ...kinds, url, url],
  );
}

/** Headings recorded with empty text (parseHeadings drops them; they matter for AEO heading checks). */
export function countEmptyHeadings(json: string | null): number {
  const raw = parseJson<unknown>(json, null);
  if (!Array.isArray(raw)) return 0;
  let n = 0;
  for (const h of raw) {
    if (!h || typeof h !== 'object') continue;
    const t = (h as Record<string, unknown>).text ?? (h as Record<string, unknown>).content;
    if (typeof t !== 'string' || !t.trim()) n++;
  }
  return n;
}

/** Extraction details stored with a crawl result (crawl_results.extraction_json), leniently parsed. */
export interface CrawlExtractionDetails {
  externalLinks: Array<{ href: string; anchor: string | null }>;
  language: string | null;
}

export function crawlResultExtraction(db: Db, siteId: string, id: string): CrawlExtractionDetails | null {
  const row = db.get<{ extraction_json: string | null; language: string | null }>('SELECT extraction_json, language FROM crawl_results WHERE site_id = ? AND id = ?', [siteId, id]);
  if (!row) return null;
  const x = parseJson<Record<string, unknown>>(row.extraction_json, {});
  const links: CrawlExtractionDetails['externalLinks'] = [];
  if (Array.isArray(x.externalLinks)) {
    for (const l of x.externalLinks) {
      if (!l || typeof l !== 'object') continue;
      const o = l as Record<string, unknown>;
      if (typeof o.href === 'string') links.push({ href: o.href, anchor: typeof o.anchor === 'string' ? o.anchor : null });
    }
  }
  return { externalLinks: links, language: row.language };
}

/** Crawl results of one crawl (fetched pages first, newest crawl order preserved). */
export function crawlResultsForCrawl(db: Db, siteId: string, crawlId: string): CrawlResultRow[] {
  return db.all<CrawlResultRow>(`SELECT ${CRAWL_RESULT_COLS} FROM crawl_results cr WHERE cr.site_id = ? AND cr.crawl_id = ? ORDER BY cr.fetched_at, cr.rowid`, [siteId, crawlId]);
}

/** Latest completed/partial own-site crawl (or single-page crawl when `includeSinglePage`). */
export function latestOwnCrawlId(db: Db, siteId: string): string | null {
  return (
    db.get<{ id: string }>(`SELECT id FROM crawls WHERE site_id = ? AND kind = 'own_site' AND status IN ('completed', 'partial') ORDER BY started_at DESC, rowid DESC LIMIT 1`, [siteId])?.id ?? null
  );
}

export interface PageQueryRow {
  query: string;
  clicks: number;
  impressions: number;
}

/**
 * Top Search Console queries for a page (visible query rows only: anonymized
 * queries are omitted, so these are never page totals). Uses the latest
 * `windowDays` of available data for the page, the configured property when
 * given (otherwise the property with the most rows for the page), and the
 * unsegmented rows. Returns null when there is no query data for the page.
 */
export function topGscQueriesForPage(
  db: Db,
  siteId: string,
  page: { pageId: string | null; url: string },
  opts: { property?: string | null; searchType?: string; windowDays?: number; limit?: number; includeSynthetic?: boolean } = {},
): { rows: PageQueryRow[]; property: string; start: string; end: string } | null {
  const searchType = opts.searchType ?? 'web';
  const synth = opts.includeSynthetic ? 1 : 0;
  const match = page.pageId ? '(page_id = ? OR page = ?)' : 'page = ?';
  const pageParams = page.pageId ? [page.pageId, page.url] : [page.url];
  const property =
    opts.property ??
    db.get<{ property: string }>(
      `SELECT property, COUNT(*) AS n FROM gsc_page_query_daily_current WHERE site_id = ? AND search_type = ? AND segment_key = '' AND ${match} AND (is_synthetic = 0 OR ? = 1)
        GROUP BY property ORDER BY n DESC, property LIMIT 1`,
      [siteId, searchType, ...pageParams, synth],
    )?.property;
  if (!property) return null;
  const latest = db.get<{ d: string | null }>(
    `SELECT MAX(date) AS d FROM gsc_page_query_daily_current WHERE site_id = ? AND property = ? AND search_type = ? AND segment_key = '' AND ${match} AND (is_synthetic = 0 OR ? = 1)`,
    [siteId, property, searchType, ...pageParams, synth],
  )?.d;
  if (!latest) return null;
  const days = Math.max(1, opts.windowDays ?? 28);
  const start = new Date(Date.parse(`${latest}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = db.all<PageQueryRow>(
    `SELECT query, SUM(clicks) AS clicks, SUM(impressions) AS impressions FROM gsc_page_query_daily_current
      WHERE site_id = ? AND property = ? AND search_type = ? AND segment_key = '' AND ${match} AND date BETWEEN ? AND ? AND (is_synthetic = 0 OR ? = 1)
      GROUP BY query ORDER BY impressions DESC, clicks DESC, query LIMIT ?`,
    [siteId, property, searchType, ...pageParams, start, latest, synth, Math.max(1, opts.limit ?? 5)],
  );
  return rows.length ? { rows, property, start, end: latest } : null;
}
