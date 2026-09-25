import { gunzipSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import type { SafeFetcher, FetchSafelyOptions } from './fetch.js';
import type { RobotsPolicy } from './robots.js';

/**
 * Bounded sitemap discovery: robots.txt `Sitemap:` lines plus the
 * conventional /sitemap.xml, following sitemap index files breadth-first.
 * Limits: max files, max URLs, max nesting depth, byte cap per file.
 * gzip (.xml.gz) is decompressed only with a hard output cap; anything
 * else unusual is skipped with a recorded reason. XML is parsed without
 * entity expansion (DOCTYPE removed, only the five predefined entities and
 * numeric references are decoded in <loc> values).
 */

export interface SitemapLimits {
  maxFiles: number;
  maxUrls: number;
  maxBytes: number;
  maxDepth?: number;
}

export type SitemapSource = 'robots' | 'default' | 'index';

export interface SitemapFileRecord {
  url: string;
  source: SitemapSource;
  kind: 'urlset' | 'sitemapindex' | 'unknown' | null;
  status: 'parsed' | 'skipped' | 'failed';
  httpStatus: number | null;
  gzip: boolean;
  urlsFound: number;
  childSitemaps: number;
  reason: string | null;
}

export interface SitemapUrl {
  loc: string;
  lastmod: string | null;
  sitemap: string;
}

export interface SitemapDiscovery {
  files: SitemapFileRecord[];
  urls: SitemapUrl[];
  truncated: boolean;
  skippedOffHost: number;
  notes: string[];
}

const XML = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  processEntities: false,
  htmlEntities: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === 'url' || name === 'sitemap',
});

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g, (m, e: string) => {
    switch (e) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const cp = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
      }
    }
  });
}

function textOf(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object' && '#text' in (v as Record<string, unknown>)) return textOf((v as Record<string, unknown>)['#text']);
  return null;
}

/** Parse sitemap XML (urlset or sitemapindex). Pure. */
export function parseSitemapXml(xml: string): { kind: 'urlset' | 'sitemapindex' | 'unknown'; entries: Array<{ loc: string; lastmod: string | null }> } {
  const cleaned = xml.replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/gi, '');
  let doc: Record<string, unknown>;
  try {
    doc = XML.parse(cleaned) as Record<string, unknown>;
  } catch {
    return { kind: 'unknown', entries: [] };
  }
  const read = (items: unknown): Array<{ loc: string; lastmod: string | null }> => {
    if (!Array.isArray(items)) return [];
    const out: Array<{ loc: string; lastmod: string | null }> = [];
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const loc = textOf((it as Record<string, unknown>).loc);
      if (!loc) continue;
      const lastmod = textOf((it as Record<string, unknown>).lastmod);
      out.push({ loc: decodeXmlEntities(loc.trim()), lastmod: lastmod ? lastmod.trim() : null });
    }
    return out;
  };
  const urlset = doc.urlset as Record<string, unknown> | undefined;
  if (urlset && typeof urlset === 'object') return { kind: 'urlset', entries: read(urlset.url) };
  const index = doc.sitemapindex as Record<string, unknown> | undefined;
  if (index && typeof index === 'object') return { kind: 'sitemapindex', entries: read(index.sitemap) };
  if (doc.urlset === '' || doc.sitemapindex === '') return { kind: doc.urlset === '' ? 'urlset' : 'sitemapindex', entries: [] };
  return { kind: 'unknown', entries: [] };
}

export interface DiscoverSitemapsOptions {
  origin: string;
  robots: RobotsPolicy;
  allowedHostnames: readonly string[];
  limits: SitemapLimits;
  signal?: AbortSignal;
  beforeHop?: FetchSafelyOptions['beforeHop'];
  /** Extra sitemap URLs to try (e.g. configured). */
  extra?: readonly string[];
}

export async function discoverSitemaps(fetcher: SafeFetcher, opts: DiscoverSitemapsOptions): Promise<SitemapDiscovery> {
  const allowedHosts = new Set(opts.allowedHostnames.map((h) => h.toLowerCase()));
  const maxDepth = opts.limits.maxDepth ?? 3;
  const out: SitemapDiscovery = { files: [], urls: [], truncated: false, skippedOffHost: 0, notes: [] };
  const queue: Array<{ url: string; source: SitemapSource; depth: number }> = [];
  const queued = new Set<string>();
  const enqueue = (url: string, source: SitemapSource, depth: number) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      out.files.push({ url, source, kind: null, status: 'skipped', httpStatus: null, gzip: false, urlsFound: 0, childSitemaps: 0, reason: 'invalid sitemap URL' });
      return;
    }
    u.hash = '';
    const key = u.toString();
    if (queued.has(key)) return;
    queued.add(key);
    queue.push({ url: key, source, depth });
  };
  for (const s of opts.robots.info.sitemaps) enqueue(s, 'robots', 0);
  for (const s of opts.extra ?? []) enqueue(s, 'default', 0);
  enqueue(`${opts.origin}/sitemap.xml`, 'default', 0);
  if (!opts.robots.info.sitemaps.length) out.notes.push('robots.txt lists no Sitemap: lines; tried the conventional /sitemap.xml.');

  const seenLocs = new Set<string>();
  let processed = 0;
  while (queue.length) {
    const item = queue.shift()!;
    const rec: SitemapFileRecord = { url: item.url, source: item.source, kind: null, status: 'skipped', httpStatus: null, gzip: false, urlsFound: 0, childSitemaps: 0, reason: null };
    out.files.push(rec);
    const u = new URL(item.url);
    if (!allowedHosts.has(u.hostname.toLowerCase())) {
      rec.reason = 'sitemap is on a host outside allowedHostnames';
      continue;
    }
    if (processed >= opts.limits.maxFiles) {
      rec.reason = `max sitemap files (${opts.limits.maxFiles}) reached`;
      out.truncated = true;
      continue;
    }
    if (out.urls.length >= opts.limits.maxUrls) {
      rec.reason = `max sitemap URLs (${opts.limits.maxUrls}) reached`;
      out.truncated = true;
      continue;
    }
    const robotsDecision = opts.robots.isAllowed(u);
    if (!robotsDecision.allowed) {
      rec.reason = `sitemap fetch not allowed: ${robotsDecision.reason}`;
      continue;
    }
    processed++;
    const r = await fetcher.fetch(item.url, { accept: ['xml'], ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.beforeHop ? { beforeHop: opts.beforeHop } : {}) });
    rec.httpStatus = r.status;
    if (r.blockedReason || r.errorCode || r.status === null || r.status < 200 || r.status >= 300 || !r.body) {
      rec.status = r.status !== null && r.status >= 400 && r.status < 500 && item.source === 'default' ? 'skipped' : 'failed';
      rec.reason = r.blockedReason ? `${r.blockedReason}${r.note ? `: ${r.note}` : ''}` : (r.error ?? (r.status !== null ? `HTTP ${r.status}` : 'no response'));
      continue;
    }
    let xml: string;
    if (r.body[0] === 0x1f && r.body[1] === 0x8b) {
      rec.gzip = true;
      try {
        xml = new TextDecoder('utf-8').decode(gunzipSync(r.body, { maxOutputLength: opts.limits.maxBytes }));
      } catch (err) {
        rec.status = 'skipped';
        rec.reason = `gzip sitemap skipped: ${(err as Error).message.includes('maxOutputLength') || (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'decompressed size exceeds the byte limit' : 'decompression failed'}`;
        continue;
      }
    } else {
      xml = r.text ?? new TextDecoder('utf-8').decode(r.body);
    }
    const parsed = parseSitemapXml(xml);
    rec.kind = parsed.kind;
    if (parsed.kind === 'unknown') {
      rec.status = 'skipped';
      rec.reason = 'not a sitemap urlset/sitemapindex document';
      continue;
    }
    rec.status = 'parsed';
    if (parsed.kind === 'sitemapindex') {
      rec.childSitemaps = parsed.entries.length;
      if (item.depth + 1 > maxDepth) {
        rec.reason = `nested sitemap index deeper than ${maxDepth} levels; children not followed`;
        out.truncated = true;
        continue;
      }
      for (const e of parsed.entries) enqueue(e.loc, 'index', item.depth + 1);
      continue;
    }
    for (const e of parsed.entries) {
      let loc: URL;
      try {
        loc = new URL(e.loc);
      } catch {
        continue;
      }
      if (loc.protocol !== 'http:' && loc.protocol !== 'https:') continue;
      if (!allowedHosts.has(loc.hostname.toLowerCase())) {
        out.skippedOffHost++;
        continue;
      }
      loc.hash = '';
      const key = loc.toString();
      if (seenLocs.has(key)) continue;
      if (out.urls.length >= opts.limits.maxUrls) {
        out.truncated = true;
        rec.reason = `max sitemap URLs (${opts.limits.maxUrls}) reached`;
        break;
      }
      seenLocs.add(key);
      out.urls.push({ loc: key, lastmod: e.lastmod, sitemap: item.url });
      rec.urlsFound++;
    }
  }
  if (out.skippedOffHost) out.notes.push(`${out.skippedOffHost} sitemap URL(s) on hosts outside allowedHostnames were ignored.`);
  if (out.truncated) out.notes.push('Sitemap discovery was truncated by configured limits; coverage is partial.');
  return out;
}
