import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '../../../src/core/hash.js';
import { CRAWL_EXTRACTOR_VERSION, RAW_RESPONSE_BODY_MAX_BYTES, createCrawl, insertResult } from '../../../src/crawler/store.js';
import type { SafeFetchResult } from '../../../src/crawler/types.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';

/** SYNTHETIC responses for example.test URLs only. */
let ctx: TestContext;
afterEach(() => ctx?.cleanup());

function response(url: string, body: string, extra: Partial<SafeFetchResult> = {}): SafeFetchResult {
  const bytes = new TextEncoder().encode(body);
  return {
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    firstStatus: 200,
    redirectChain: [],
    contentType: 'text/html; charset=utf-8',
    headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'index' },
    body: bytes,
    text: body,
    bytes: bytes.length,
    blockedReason: null,
    errorCode: null,
    error: null,
    retryAfterMs: null,
    durationMs: 5,
    pinned: false,
    fixture: true,
    attempts: 1,
    note: null,
    ...extra,
  };
}

const base = { pageId: null, renderMode: 'fixture' as const, robotsAllowed: true, extraction: null, textRef: null, blockedReason: null, error: null, depth: 0, discoveredVia: ['seed'], inSitemap: null };

describe('crawl_results provenance (migration 0201)', () => {
  it('records the extractor version and a bounded, redacted raw response with the body hash', () => {
    ctx = createTestContext();
    const crawlId = createCrawl(ctx, { kind: 'own_site', config: {}, isSynthetic: true });
    const html = `<html><head><title>Synthetic</title></head><body>${'x'.repeat(RAW_RESPONSE_BODY_MAX_BYTES + 100)}</body></html>`;
    const f = response('https://www.example.test/big', html);
    const id = insertResult(ctx, { ...base, crawlId, requestedUrl: f.requestedUrl, fetch: f });
    const row = ctx.db.get<{ transformation_version: string; raw_ref: string }>('SELECT transformation_version, raw_ref FROM crawl_results WHERE id = ?', [id])!;
    expect(row.transformation_version).toBe(CRAWL_EXTRACTOR_VERSION);
    const raw = ctx.raw.load<Record<string, unknown>>(row.raw_ref)!;
    expect(raw).toMatchObject({ untrusted: true, extractorVersion: CRAWL_EXTRACTOR_VERSION, status: 200, headers: { 'x-robots-tag': 'index' }, bodySha256: sha256(new TextEncoder().encode(html)), bodyStored: 'truncated' });
    expect(String(raw.body).length).toBe(RAW_RESPONSE_BODY_MAX_BYTES);
    expect(String(raw.body)).toMatch(/^<html><head><title>Synthetic<\/title>/);

    // The same fetch producing a second row (redirect target) is saved once.
    const again = insertResult(ctx, { ...base, crawlId, requestedUrl: 'https://www.example.test/big-target', fetch: f, finalUrlOverride: f.finalUrl });
    expect(ctx.db.get<{ raw_ref: string }>('SELECT raw_ref FROM crawl_results WHERE id = ?', [again])!.raw_ref).toBe(row.raw_ref);
  });

  it('keeps small text bodies whole, stores only a hash for binary bodies, and no reference when nothing was received', () => {
    ctx = createTestContext();
    const crawlId = createCrawl(ctx, { kind: 'own_site', config: {}, isSynthetic: true });
    const small = insertResult(ctx, { ...base, crawlId, requestedUrl: 'https://www.example.test/small', fetch: response('https://www.example.test/small', '<p>ok</p>') });
    const img = response('https://www.example.test/logo.png', 'PNGDATA', { contentType: 'image/png' });
    const binary = insertResult(ctx, { ...base, crawlId, requestedUrl: img.requestedUrl, fetch: img });
    const blocked = insertResult(ctx, { ...base, crawlId, requestedUrl: 'https://www.example.test/private', fetch: null, robotsAllowed: false, blockedReason: 'robots' });
    const ref = (id: string) => ctx.db.get<{ raw_ref: string | null; transformation_version: string }>('SELECT raw_ref, transformation_version FROM crawl_results WHERE id = ?', [id])!;
    expect(ctx.raw.load<Record<string, unknown>>(ref(small).raw_ref!)).toMatchObject({ body: '<p>ok</p>', bodyStored: 'full' });
    expect(ctx.raw.load<Record<string, unknown>>(ref(binary).raw_ref!)).toMatchObject({ body: null, bodyStored: 'hash_only', bodySha256: sha256(new TextEncoder().encode('PNGDATA')) });
    expect(ref(blocked)).toEqual({ raw_ref: null, transformation_version: CRAWL_EXTRACTOR_VERSION });
  });
});
