/**
 * SYNTHETIC tests: measurement scoping for published content and the
 * low-data bootstrap (one Search Console property, one search type, final
 * dates only, page_id/established-alias joins), and conversion history
 * computed from stored GA4 rows. Fictional site on example.test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { conversionHistory, NO_CONVERSION_HISTORY_STATEMENT } from '../../../src/content/conversion-history.js';
import { detectLowData, readinessChecks, runLowDataBootstrap } from '../../../src/content/bootstrap.js';
import { measurePublishedContent } from '../../../src/content/publication.js';
import { getItem, insertBrief, insertDraft, insertItem, latestBrief } from '../../../src/content/store.js';
import type { ContentBrief, DraftPackage } from '../../../src/content/types.js';
import { newId } from '../../../src/core/ids.js';
import { createTestContext, type TestContext } from '../../helpers/context.js';
import { contentConfig, seedGa4Events, seedGscPageRows, seedPages, seedPropertyTotals, SITE_URL } from '../../fixtures/content/seed.js';

let ctx: TestContext;
afterEach(() => ctx?.cleanup());

const DOMAIN = 'sc-domain:example.test';
const PREFIX = 'https://www.example.test/';

/** A published draft for `url` (minimal records; SYNTHETIC). */
function publishedDraft(c: TestContext, url: string, implementedAt: string): { itemId: string; draftId: string } {
  const now = c.clock.now().toISOString();
  const itemId = insertItem(c.db, { siteId: c.siteId, title: 'Synthetic published item', primaryQuestion: null, stage: 'exported', intent: 'informational', clusterId: null, isSynthetic: true, now });
  const brief = { schemaVersion: 1, contentItemId: itemId, siteId: c.siteId } as unknown as ContentBrief;
  const b = insertBrief(c.db, { siteId: c.siteId, itemId, brief, contentHash: 'h', gate: { passed: true, issues: [], checkedAt: now, gateVersion: 'test' }, status: 'approved', promptVersion: null, modelId: null, now });
  const pkg = { schemaVersion: 1, body: 'x', authorization: { kind: 'item', approvalId: 'a', briefId: b.id, briefHash: 'h' } } as unknown as DraftPackage;
  const d = insertDraft(c.db, { siteId: c.siteId, itemId, briefId: b.id, briefVersion: 1, briefHash: 'h', pkg, bodyHash: 'bh', unresolvedFacts: 0, revisionRound: 0, promptVersion: null, modelId: null, now });
  c.db.run(`INSERT INTO publications (id, site_id, subject_type, subject_id, url, method, implemented_at, recorded_by, created_at) VALUES (?, ?, 'draft', ?, ?, 'manual_export', ?, 'owner:test', ?)`, [newId('pub'), c.siteId, d.id, url, implementedAt, now]);
  return { itemId, draftId: d.id };
}

describe('published-content measurement scope (A2-01)', () => {
  it('uses one property, page_id + established aliases, final dates only; incomplete windows report a partial value', () => {
    ctx = createTestContext({ config: contentConfig({ google: { searchConsoleProperty: DOMAIN } } as never) });
    const ids = seedPages(ctx, [{ path: '/new-page/', title: 'New page' }]);
    const pageId = ids['/new-page/']!;
    const url = `${SITE_URL}new-page/`;
    const now = ctx.clock.now().toISOString();
    ctx.db.run(`INSERT INTO url_aliases (id, site_id, page_id, alias_url, relation, confidence, source, created_at, updated_at) VALUES (?, ?, ?, 'http://www.example.test/new-page/', 'redirect', 'established', 'test', ?, ?)`, [newId('al'), ctx.siteId, pageId, now, now]);
    ctx.db.run(`INSERT INTO url_aliases (id, site_id, page_id, alias_url, relation, confidence, source, created_at, updated_at) VALUES (?, ?, ?, 'https://www.example.test/new-page/?ref=x', 'canonical', 'probable', 'test', ?, ?)`, [newId('al'), ctx.siteId, pageId, now, now]);
    const { itemId } = publishedDraft(ctx, url, '2026-09-10T08:00:00Z');

    const days = ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15'];
    seedGscPageRows(ctx, DOMAIN, { start: '2026-09-05', end: '2026-09-17' }, [
      { date: '2026-09-05', page: url, pageId, impressions: 999, clicks: 99 }, // before implementation: excluded
      ...days.map((date) => ({ date, page: url, pageId, impressions: 10, clicks: 1 })),
      { date: '2026-09-12', page: 'http://www.example.test/new-page/', pageId: null, impressions: 5, clicks: 0 }, // established alias, not yet reconciled
      { date: '2026-09-12', page: 'https://www.example.test/new-page/?ref=x', pageId: null, impressions: 1000, clicks: 50 }, // probable alias: excluded
      { date: '2026-09-16', page: url, pageId, impressions: 7, clicks: 1, isFinal: false },
      { date: '2026-09-17', page: url, pageId, impressions: 7, clicks: 1, isFinal: false },
    ]);
    // The old URL-prefix property still has current rows for the same page: never added.
    seedGscPageRows(ctx, PREFIX, { start: '2026-09-10', end: '2026-09-15' }, days.map((date) => ({ date, page: url, pageId, impressions: 100, clicks: 10 })));

    const [m] = measurePublishedContent(ctx);
    expect(m!.scope).toMatchObject({ property: DOMAIN, searchType: 'web', pageId, join: 'page_id' });
    expect(m!.impressions).toMatchObject({ status: 'incomplete', partialValue: 65 });
    expect(m!.clicks).toMatchObject({ status: 'incomplete', partialValue: 6 });
    expect(m!.impressions.status === 'incomplete' && m!.impressions.reason).toMatch(/non-final/);
    expect(getItem(ctx.db, ctx.siteId, itemId)!.stage).toBe('measuring');

    // Once the recent dates are final, the value is observed (still one property, no double counting).
    ctx.db.run(`UPDATE gsc_page_daily SET is_final = 1 WHERE site_id = ? AND date IN ('2026-09-16', '2026-09-17')`, [ctx.siteId]);
    const [m2] = measurePublishedContent(ctx);
    expect(m2!.impressions).toEqual({ status: 'observed', value: 79 });
    expect(m2!.clicks).toEqual({ status: 'observed', value: 8 });
    expect(m2!.window).toEqual({ start: '2026-09-10', end: '2026-09-17' });
  });

  it('is DATA_UNAVAILABLE when several properties have data and none is configured (never a sum)', () => {
    ctx = createTestContext({ config: contentConfig() });
    const ids = seedPages(ctx, [{ path: '/new-page/', title: 'New page' }]);
    const url = `${SITE_URL}new-page/`;
    publishedDraft(ctx, url, '2026-09-10T08:00:00Z');
    seedGscPageRows(ctx, DOMAIN, { start: '2026-09-10', end: '2026-09-11' }, [{ date: '2026-09-10', page: url, pageId: ids['/new-page/']!, impressions: 10 }]);
    seedGscPageRows(ctx, PREFIX, { start: '2026-09-10', end: '2026-09-11' }, [{ date: '2026-09-10', page: url, pageId: ids['/new-page/']!, impressions: 100 }]);
    const [m] = measurePublishedContent(ctx);
    expect(m!.impressions.status).toBe('unavailable');
    expect(m!.impressions.status === 'unavailable' && m!.impressions.reason).toMatch(/several Search Console properties/);
    expect(m!.note).toMatch(/DATA_UNAVAILABLE/);
  });
});

describe('low-data detection scope (A2-02)', () => {
  it('uses only the configured property: two properties are never summed', async () => {
    ctx = createTestContext({ config: contentConfig({ google: { searchConsoleProperty: DOMAIN } } as never) });
    seedPropertyTotals(ctx, DOMAIN, 10); // 280 impressions / 28 days: below the default 500
    seedPropertyTotals(ctx, PREFIX, 100); // an old property with more data: must not flip the decision
    const low = detectLowData(ctx);
    expect(low).toMatchObject({ isLowData: true, status: 'low', impressions28d: 280, property: DOMAIN, searchType: 'web' });
    expect(low.reason).toMatch(/280 Search Console impressions/);
    expect(readinessChecks(ctx).find((c) => c.id === 'gsc_data')!.detail).toMatch(new RegExp(`28 daily property row\\(s\\) stored for ${DOMAIN}`));
  });

  it('reports unknown (and skips the bootstrap unless forced) when several properties exist and none is configured', async () => {
    ctx = createTestContext({ config: contentConfig() });
    seedPropertyTotals(ctx, DOMAIN, 10);
    seedPropertyTotals(ctx, PREFIX, 100);
    const low = detectLowData(ctx);
    expect(low).toMatchObject({ isLowData: false, status: 'unknown', impressions28d: null, property: null });
    expect(low.reason).toMatch(/never summed/);
    const r = await runLowDataBootstrap(ctx, { llm: null, memory: null, approvals: null, vault: null }, { useModel: false });
    expect(r.offerPage).toBeNull();
    expect(r.skipped).toMatch(/unknown/);
  });

  it('falls back to the only property with data (same scope as page analysis)', () => {
    ctx = createTestContext({ config: contentConfig() });
    seedPropertyTotals(ctx, PREFIX, 100);
    expect(detectLowData(ctx)).toMatchObject({ isLowData: false, status: 'not_low', impressions28d: 2800, property: PREFIX });
  });
});

describe('conversion history and readiness hints (A6-11, A6-03)', () => {
  it('states stored primary-event rows (count, dates, not attributed to the new pages) everywhere the bootstrap mentions conversion history', async () => {
    ctx = createTestContext({ config: contentConfig() });
    seedPages(ctx, [{ path: '/', pageType: 'offer', title: 'Crumb Planner: production and shift planning for bakeries', headings: ['Plan production'], text: 'Crumb Planner helps small bakeries plan production.' }]);
    seedGa4Events(ctx, 'start_trial', ['2026-09-01', '2026-09-02', '2026-09-03']);
    const conv = conversionHistory(ctx);
    expect(conv).toMatchObject({ rows: 3, label: 'OBSERVED', firstDate: '2026-09-01', lastDate: '2026-09-03' });
    expect(conv.statement).toMatch(/3 stored GA4 row\(s\) for the primary event\(s\) start_trial/);
    expect(conv.statement).toMatch(/NOT attributed to the pages proposed here/);

    const r = await runLowDataBootstrap(ctx, { llm: null, memory: null, approvals: null, vault: null }, { useModel: false, force: true });
    expect(r.conversionHistory).toBe(conv.statement);
    expect(r.conversionHistory).not.toBe(NO_CONVERSION_HISTORY_STATEMENT);
    const readiness = Object.fromEntries(r.readiness.map((c) => [c.id, c]));
    expect(readiness.conversion_data).toMatchObject({ status: 'pass', detail: conv.statement });
    const offer = getItem(ctx.db, ctx.siteId, r.offerPage!.itemId)!;
    expect(offer.whyExists).toContain(conv.statement);
    expect(offer.whyExists).not.toMatch(/No historical conversion evidence/);
    const brief = latestBrief(ctx.db, ctx.siteId, offer.id)!.brief;
    const finding = brief.researchFindings.find((f) => f.evidenceIds.includes('metric:ga4_primary_events'))!;
    expect(finding).toMatchObject({ label: 'OBSERVED', finding: conv.statement });
    expect(brief.researchFindings.some((f) => /No historical conversion evidence/.test(f.finding))).toBe(false);
  });

  it('without stored rows it still says no conversion history exists (never assumed)', () => {
    ctx = createTestContext({ config: contentConfig() });
    expect(conversionHistory(ctx)).toMatchObject({ rows: 0, label: 'DATA_UNAVAILABLE', statement: NO_CONVERSION_HISTORY_STATEMENT });
  });

  it('points the missing-offer-page hint at `pages set-type <url> offer` or site.pageTypes', () => {
    ctx = createTestContext({ config: contentConfig() });
    const offer = readinessChecks(ctx).find((c) => c.id === 'offer_page')!;
    expect(offer.status).toBe('unknown');
    expect(offer.nextStep).toMatch(/pages set-type <url> offer/);
    expect(offer.nextStep).toMatch(/site\.pageTypes/);
  });
});
